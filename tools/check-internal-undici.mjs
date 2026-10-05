#!/usr/bin/env node
/**
 * 门禁：**Node 内部 require 的内建 undici 必须被纯 JS 垫片接管**
 *
 * 【为什么需要这条门禁】端侧 Node v24.2.0 的内建 undici 在模块初始化阶段就实例化
 * WASM 版 llhttp ⇒ `--jitless`（无 WASM）下一加载就抛 `WebAssembly is not defined`。
 * 而 Node **内部**会按完整路径 require 它：
 *   · `lib/internal/worker/io.js` 的 `onMessageEvent()`：**每条 MessagePort 消息投递**
 *     都 `require('internal/deps/undici/undici').createFastMessageEvent`
 *     ⇒ 用 `new MessageChannel()` 的插件（inspector 的 Host 半身）第一条消息就炸；
 *   · `globalThis` 上 `Headers/Request/Response/FormData/MessageEvent/CloseEvent/
 *     WebSocket/EventSource` 的惰性 getter 也 require 它。
 *
 * 【踩过的坑（2026-10-05 v1→v2）】第一版把钩子挂在 `Module._load` 上——
 * **Node 内部模块不走 `Module._load`**（走 `requireBuiltin` →
 * `BuiltinModule.prototype.compileForInternalLoader()`），于是"日志打了、故障照旧"。
 * 本门禁因此**必须断言运行时行为**（谁构造了端口事件），而不是只断言"装了钩子"：
 * 只检查 `__dshmInternalUndiciShim === true` 正是上一版漏掉的那种假阳性。
 *
 * 【本机为什么测不出崩溃】本机 Node 24.19 的该模块能加载（全局 Agent 已改懒），
 * 所以这里不测"是否抛错"（版本相关），而测**拦截契约**（版本无关）：
 *   ① `require('internal/deps/undici/undici')` 必须就是本仓垫片（身份同一）；
 *   ② `BuiltinModule.map.get(id).exports` 必须是垫片（安装期自检同款断言）；
 *   ③ **决定性**：MessagePort 的 `onmessage` 事件必须是**垫片的 MessageEvent 实例**
 *      —— 这条直接证明 `internal/worker/io.js` 的 `lazyMessageEvent` 走了垫片；
 *   ④ 端口正常收发不受影响（回归）；`createFastMessageEvent` 的返回值必须能被
 *      `EventTarget.dispatchEvent()` 接受（Node 对非 Event 抛 ERR_INVALID_ARG_TYPE）。
 * 对照臂（`DSHM_NO_INTERNAL_UNDICI_SHIM=1`）必须证明"没拦住"：事件不是垫片类。
 * 没有对照臂，"通过"可能只是碰巧。
 *
 * 用法：node tools/check-internal-undici.mjs [--self-test]
 * 退出码：0 通过 / 1 失败 / 3 环境不满足（自检失败）
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'hostcore', 'app');
const SCRATCH = join(ROOT, 'dist', 'localtest', 'internal-undici');

/* ───────────────────────── 判定器（可自检） ───────────────────────── */

/** 从一臂的 stdout 判定结果。固定字段见 FIXTURE 的 out({...})。 */
function classify(output, arm) {
  const has = (re) => re.test(output);
  if (!has(/"stage":"done"/)) return { ok: false, why: '臂未跑完（缺 done 标记）' };
  const installed = has(/"installReturned":true/);
  const internalIsShim = has(/"internalIsShim":true/);
  const fmeOk = has(/"fastMessageEvent":"ok"/);
  const portFromShim = has(/"portEvent":"shim"/);
  const portOk = has(/"port":"ok"/);
  if (arm === 'fixed') {
    /* 断言安装函数自己认为装成功：否则"返回 false 但端口事件恰好来自垫片"这种组合会被漏掉 */
    if (!installed) return { ok: false, why: 'installInternalUndiciShim() 返回的不是 true' };
    if (!internalIsShim) return { ok: false, why: '内建 undici 不是本仓垫片（内部 require 未被接管）' };
    if (!fmeOk) return { ok: false, why: 'createFastMessageEvent 返回值不是可派发的真 Event' };
    if (!portFromShim) return { ok: false, why: 'MessagePort 事件不是垫片的 MessageEvent —— 内部路径没走垫片' };
    if (!portOk) return { ok: false, why: 'MessagePort 正常收发被破坏（回归）' };
    return { ok: true, why: '内部 require 已被接管，端口事件由垫片构造，收发无回归' };
  }
  // control 臂：必须**没有**被接管
  if (internalIsShim) return { ok: false, why: '对照臂也被接管了 —— 判定器无法区分两臂' };
  if (portFromShim) return { ok: false, why: '对照臂的端口事件竟来自垫片 —— 判定器无法区分两臂' };
  return { ok: true, why: '对照臂确认：未安装时内部 require 不被接管（事件非垫片类）' };
}

/* ───────────────────────── 自检 ───────────────────────── */

const SELF_TESTS = [
  ['fixed 全绿 → ok', '{"installReturned":true,"internalIsShim":true,"fastMessageEvent":"ok","portEvent":"shim","port":"ok","stage":"done"}', 'fixed', true],
  ['fixed 安装返回 false → fail', '{"installReturned":false,"internalIsShim":true,"fastMessageEvent":"ok","portEvent":"shim","port":"ok","stage":"done"}', 'fixed', false],
  ['fixed 未接管 → fail', '{"installReturned":true,"internalIsShim":false,"fastMessageEvent":"ok","portEvent":"shim","port":"ok","stage":"done"}', 'fixed', false],
  ['fixed 端口事件非垫片 → fail', '{"installReturned":true,"internalIsShim":true,"fastMessageEvent":"ok","portEvent":"node","port":"ok","stage":"done"}', 'fixed', false],
  ['fixed 事件不可派发 → fail', '{"installReturned":true,"internalIsShim":true,"fastMessageEvent":"throw:x","portEvent":"shim","port":"ok","stage":"done"}', 'fixed', false],
  ['fixed 端口回归 → fail', '{"installReturned":true,"internalIsShim":true,"fastMessageEvent":"ok","portEvent":"shim","port":"throw:x","stage":"done"}', 'fixed', false],
  ['fixed 未跑完 → fail', '{"installReturned":true,"internalIsShim":true,"portEvent":"shim"}', 'fixed', false],
  ['control 未接管 → ok', '{"installReturned":false,"internalIsShim":false,"fastMessageEvent":"skip","portEvent":"node","port":"ok","stage":"done"}', 'control', true],
  ['control 抛错也算未接管 → ok', '{"installReturned":false,"internalIsShim":false,"fastMessageEvent":"skip","portEvent":"throw","port":"throw:x","stage":"done"}', 'control', true],
  ['control 被接管 → fail', '{"installReturned":true,"internalIsShim":true,"portEvent":"shim","port":"ok","stage":"done"}', 'control', false],
  ['空输出 → fail', '', 'control', false],
];

if (process.argv.includes('--self-test')) {
  let bad = 0;
  for (const [name, out, arm, want] of SELF_TESTS) {
    const got = classify(out, arm).ok;
    const pass = got === want;
    if (!pass) bad++;
    console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}`);
  }
  console.log(bad === 0 ? `\n自检通过：${SELF_TESTS.length}/${SELF_TESTS.length} 判定成立` : `\n自检失败：${bad} 项`);
  process.exit(bad === 0 ? 0 : 3);
}

/* ───────────────────────── 夹具 ───────────────────────── */

const FIXTURE = `
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
(async () => {
  const env = require(${JSON.stringify(join(APP, 'jitless-env.cjs'))});
  const installed = env.installInternalUndiciShim(() => {});
  const shim = require(${JSON.stringify(join(APP, 'internal-undici-shim.cjs'))});
  const ID = 'internal/deps/undici/undici';

  // ① 身份同一：内部 require 拿到的必须就是垫片
  let internalIsShim = false;
  try { internalIsShim = require(ID) === shim; } catch (e) { internalIsShim = false; }

  // ② createFastMessageEvent 的返回值必须能被 dispatchEvent 接受
  let fastMessageEvent = 'skip';
  try {
    const ev = shim.createFastMessageEvent('message', { data: { hello: 1 } });
    const et = new EventTarget();
    let seen = null;
    et.addEventListener('message', (e) => { seen = e; });
    et.dispatchEvent(ev);   // 非 Event 这里抛 ERR_INVALID_ARG_TYPE
    fastMessageEvent = (seen === ev && ev.data && ev.data.hello === 1) ? 'ok' : 'bad';
  } catch (e) { fastMessageEvent = 'throw:' + (e && e.message); }

  // ③ 决定性：走 Node 内部那条路径（MessagePort 的 onmessage）的事件由谁构造
  let portEvent = 'none';
  let port = 'ok';
  try {
    const { MessageChannel } = require('node:worker_threads');
    const c = new MessageChannel();
    const ev = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('300ms 内没收到端口消息')), 300);
      c.port1.onmessage = (e) => { clearTimeout(t); resolve(e); };
      c.port2.postMessage({ ping: 7 });
    });
    portEvent = ev instanceof shim.MessageEvent ? 'shim' : 'node';
    port = (ev && ev.data && ev.data.ping === 7) ? 'ok' : 'bad';
    c.port1.close(); c.port2.close();
  } catch (e) { port = 'throw:' + (e && e.message); portEvent = 'throw'; }

  // ④ 惰性接口现状（信息性：版本相关，不做判定）
  let lazy = {};
  for (const k of ['MessageEvent','CloseEvent','WebSocket','EventSource','Headers','Request','Response','FormData']) {
    try { lazy[k] = (globalThis[k] === shim[k]) ? 'shim' : typeof globalThis[k]; }
    catch (e) { lazy[k] = 'throw'; }
  }

  out({ installReturned: installed, internalIsShim, fastMessageEvent, portEvent, port, lazy, stage: 'done' });
  process.exit(0);
})().catch((e) => { out({ stage: 'fatal', error: String(e && e.message) }); process.exit(1); });
`;

/* ───────────────────────── 跑两臂 ───────────────────────── */

function runArm(arm) {
  const env = { ...process.env };
  if (arm === 'control') env.DSHM_NO_INTERNAL_UNDICI_SHIM = '1';
  else delete env.DSHM_NO_INTERNAL_UNDICI_SHIM;
  return new Promise((resolve) => {
    // --jitless：模拟端侧（WASM 不可用）。--expose-internals：允许 require 内建路径。
    const child = spawn(process.execPath, ['--jitless', '--expose-internals', '-e', FIXTURE], {
      env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ arm, code, stdout, stderr }));
  });
}

mkdirSync(SCRATCH, { recursive: true });
writeFileSync(join(SCRATCH, 'probe-internal-undici.cjs'), FIXTURE, 'utf8');

const fixed = await runArm('fixed');
const control = await runArm('control');
const rFixed = classify(fixed.stdout, 'fixed');
const rControl = classify(control.stdout, 'control');

const lazyLine = (s) => {
  const m = s.match(/"lazy":\{[^}]*\}/);
  return m ? m[0] : '(无)';
};

console.log('════════ 内建 undici 拦截门禁 ════════');
console.log(`[fixed]   ${rFixed.ok ? 'ok  ' : 'FAIL'}  ${rFixed.why}`);
console.log(`          惰性接口现状：${lazyLine(fixed.stdout)}`);
if (!rFixed.ok) console.log(`          stdout: ${fixed.stdout.trim().slice(0, 400)}\n          stderr: ${fixed.stderr.trim().slice(0, 400)}`);
console.log(`[control] ${rControl.ok ? 'ok  ' : 'FAIL'}  ${rControl.why}`);
if (!rControl.ok) console.log(`          stdout: ${control.stdout.trim().slice(0, 400)}\n          stderr: ${control.stderr.trim().slice(0, 400)}`);

const pass = rFixed.ok && rControl.ok;
if (pass) {
  rmSync(SCRATCH, { recursive: true, force: true });
  console.log('\n════════ 结论 ════════');
  console.log('PASS：对照实验成立 —— 不拦时内部 require 不被接管；拦后由纯 JS 垫片接管，'
    + '且 MessagePort 事件确由垫片构造、端口收发无回归。');
  process.exit(0);
} else {
  console.log('\n════════ 结论 ════════');
  console.log('FAIL：见上面两臂读数。');
  process.exit(1);
}
