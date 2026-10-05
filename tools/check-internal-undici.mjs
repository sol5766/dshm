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
 *   ⑤ **响应体形态**：`new Response(FormData)` 必须编成 multipart 字节流（`body` 是
 *      可 `for await` 的字节流 + 带 boundary 的 content-type）。见下面「为什么⑤是承重的」。
 * 对照臂（`DSHM_NO_INTERNAL_UNDICI_SHIM=1`）必须证明"没拦住"：事件不是垫片类。
 * 没有对照臂，"通过"可能只是碰巧。
 *
 * 【为什么⑤是承重的（2026-10-05 真机事故）】接管内建 undici 把 `globalThis.Response`
 * 从原生实现换成了本仓垫片；而垫片原先只认 string/Buffer/Blob/ReadableStream 四种体。
 * 上游 `dsh-client-connection/lib/index.js:747-761` 的 `fullResponse()` 在 RPC 结果含
 * `Uint8Array`（= attachments，`dsh-api-gateway/lib/types/index.js:695-705` 对**任何**
 * `Uint8Array` 都这么做，无大小阈值）时给的是 **`new Response(FormData)`** ⇒ 落到垫片的
 * `else` 分支 ⇒ `bridge()` 的 `for await (const chunk of response.body)` 拿到 `["bytes-0", Blob]`
 * 数组 ⇒ `res.write()` 抛 `ERR_INVALID_ARG_TYPE` ⇒ `dsh-host-webserver` 的 catch-all
 * `res.destroy()`（此时 headersSent 已真）⇒ 客户端 `net::ERR_EMPTY_RESPONSE(-324)`。
 * 症状是"侧边栏里图片/PDF/HTML 全打不开，而 read/stat/list 全 200"——第 35 行那种
 * 「装了钩子 ≠ 语义还在」的同一族坑，所以必须**断言响应体形态**，而不是只断言身份。
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
  const bodyOk = has(/"responseBody":"ok"/);
  if (arm === 'fixed') {
    /* 断言安装函数自己认为装成功：否则"返回 false 但端口事件恰好来自垫片"这种组合会被漏掉 */
    if (!installed) return { ok: false, why: 'installInternalUndiciShim() 返回的不是 true' };
    if (!internalIsShim) return { ok: false, why: '内建 undici 不是本仓垫片（内部 require 未被接管）' };
    if (!fmeOk) return { ok: false, why: 'createFastMessageEvent 返回值不是可派发的真 Event' };
    if (!portFromShim) return { ok: false, why: 'MessagePort 事件不是垫片的 MessageEvent —— 内部路径没走垫片' };
    if (!portOk) return { ok: false, why: 'MessagePort 正常收发被破坏（回归）' };
    if (!bodyOk) return { ok: false, why: 'new Response(FormData) 不是可写的 multipart 字节流（附件型 RPC 会 ERR_EMPTY_RESPONSE）' };
    return { ok: true, why: '内部 require 已被接管，端口事件由垫片构造，收发无回归，响应体形态正确' };
  }
  // control 臂：必须**没有**被接管
  if (internalIsShim) return { ok: false, why: '对照臂也被接管了 —— 判定器无法区分两臂' };
  if (portFromShim) return { ok: false, why: '对照臂的端口事件竟来自垫片 —— 判定器无法区分两臂' };
  return { ok: true, why: '对照臂确认：未安装时内部 require 不被接管（事件非垫片类）' };
}

/* ───────────────────────── 自检 ───────────────────────── */

const SELF_TESTS = [
  ['fixed 全绿 → ok', '{"installReturned":true,"internalIsShim":true,"fastMessageEvent":"ok","portEvent":"shim","port":"ok","responseBody":"ok","stage":"done"}', 'fixed', true],
  ['fixed 安装返回 false → fail', '{"installReturned":false,"internalIsShim":true,"fastMessageEvent":"ok","portEvent":"shim","port":"ok","responseBody":"ok","stage":"done"}', 'fixed', false],
  ['fixed 未接管 → fail', '{"installReturned":true,"internalIsShim":false,"fastMessageEvent":"ok","portEvent":"shim","port":"ok","responseBody":"ok","stage":"done"}', 'fixed', false],
  ['fixed 端口事件非垫片 → fail', '{"installReturned":true,"internalIsShim":true,"fastMessageEvent":"ok","portEvent":"node","port":"ok","responseBody":"ok","stage":"done"}', 'fixed', false],
  ['fixed 事件不可派发 → fail', '{"installReturned":true,"internalIsShim":true,"fastMessageEvent":"throw:x","portEvent":"shim","port":"ok","responseBody":"ok","stage":"done"}', 'fixed', false],
  ['fixed 端口回归 → fail', '{"installReturned":true,"internalIsShim":true,"fastMessageEvent":"ok","portEvent":"shim","port":"throw:x","responseBody":"ok","stage":"done"}', 'fixed', false],
  /* ⑤ 的判别力：响应体形态坏掉必须是 fail（否则这条恒真的话，本门禁就等于没加） */
  ['fixed 响应体形态坏 → fail', '{"installReturned":true,"internalIsShim":true,"fastMessageEvent":"ok","portEvent":"shim","port":"ok","responseBody":"throw:chunk 不是字节","stage":"done"}', 'fixed', false],
  ['fixed 响应体形态 bad → fail', '{"installReturned":true,"internalIsShim":true,"fastMessageEvent":"ok","portEvent":"shim","port":"ok","responseBody":"bad","stage":"done"}', 'fixed', false],
  ['fixed 缺响应体读数 → fail', '{"installReturned":true,"internalIsShim":true,"fastMessageEvent":"ok","portEvent":"shim","port":"ok","stage":"done"}', 'fixed', false],
  ['fixed 未跑完 → fail', '{"installReturned":true,"internalIsShim":true,"portEvent":"shim","responseBody":"ok"}', 'fixed', false],
  ['control 未接管 → ok', '{"installReturned":false,"internalIsShim":false,"fastMessageEvent":"skip","portEvent":"node","port":"ok","responseBody":"ok","stage":"done"}', 'control', true],
  ['control 抛错也算未接管 → ok', '{"installReturned":false,"internalIsShim":false,"fastMessageEvent":"skip","portEvent":"throw","port":"throw:x","responseBody":"throw","stage":"done"}', 'control', true],
  ['control 被接管 → fail', '{"installReturned":true,"internalIsShim":true,"portEvent":"shim","port":"ok","responseBody":"ok","stage":"done"}', 'control', false],
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
  /*
   * 当"客户端解析器"用的原生 Response **必须绕开 globalThis**：
   * globalThis.Response 是 exposeLazyInterfaces 装的惰性 getter，**读一次就物化**成原生实现，
   * 之后 installInternalUndiciShim() 再也换不掉它（本夹具第一版正是这样把自己测瞎的：
   * lazy.Response 显示 "function"、⑤ 判成 throw）。走内建模块路径取则不碰那个属性。
   */
  let NativeResponse = null;
  try { NativeResponse = require('internal/deps/undici/undici').Response; } catch (e) { NativeResponse = null; }
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

  // ⑤ 响应体形态：**照抄**上游 fullResponse() 的附件分支 + 桥层的消费方式。
  //    globalThis.{FormData,Blob,Response} = 端侧安装后的那一套（与真机同路径）。
  let responseBody = 'skip';
  try {
    const WANT = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const parts = new FormData();
    parts.set('bytes-0', new Blob([new Uint8Array(WANT)]));
    parts.set('metadata', JSON.stringify({
      type: 'server-response', rpcId: 'r',
      result: { ok: true, value: { data: null } },
      attachments: [{ path: ['data'], codec: 'bytes', part: 'bytes-0' }],
    }));
    const resp = new Response(parts);
    const ct = String(resp.headers.get('content-type'));
    // bridge() 唯一的用法：for await 取块再 res.write —— 块必须是字节，不能是数组
    const chunks = [];
    for await (const chunk of resp.body) {
      if (!(chunk instanceof Uint8Array)) throw new TypeError('chunk 不是字节：' + Object.prototype.toString.call(chunk));
      chunks.push(Buffer.from(chunk));
    }
    // 再用原生解析器当"客户端"解一遍（等价于客户端 parseBinaryResponse → response.formData()）
    if (NativeResponse === null) throw new Error('取不到内建 undici 的 Response，无法做严格解析校验');
    const back = await new NativeResponse(Buffer.concat(chunks), { headers: { 'content-type': ct } }).formData();
    const meta = JSON.parse(back.get('metadata'));
    const got = Buffer.from(await back.get('bytes-0').arrayBuffer());
    responseBody = (ct.startsWith('multipart/form-data; boundary=')
      && meta.attachments[0].part === 'bytes-0' && got.equals(WANT)) ? 'ok' : 'bad';
  } catch (e) { responseBody = 'throw:' + (e && e.message); }

  // ④ 惰性接口现状（信息性：版本相关，不做判定）
  let lazy = {};
  for (const k of ['MessageEvent','CloseEvent','WebSocket','EventSource','Headers','Request','Response','FormData']) {
    try { lazy[k] = (globalThis[k] === shim[k]) ? 'shim' : typeof globalThis[k]; }
    catch (e) { lazy[k] = 'throw'; }
  }

  out({ installReturned: installed, internalIsShim, fastMessageEvent, portEvent, port, responseBody, lazy, stage: 'done' });
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
const bodyLine = (s) => {
  const m = s.match(/"responseBody":"[^"]*"/);
  return m ? m[0] : '(无)';
};

console.log('════════ 内建 undici 拦截门禁 ════════');
console.log(`[fixed]   ${rFixed.ok ? 'ok  ' : 'FAIL'}  ${rFixed.why}`);
console.log(`          惰性接口现状：${lazyLine(fixed.stdout)}`);
console.log(`          响应体形态：${bodyLine(fixed.stdout)}`);
if (!rFixed.ok) console.log(`          stdout: ${fixed.stdout.trim().slice(0, 400)}\n          stderr: ${fixed.stderr.trim().slice(0, 400)}`);
console.log(`[control] ${rControl.ok ? 'ok  ' : 'FAIL'}  ${rControl.why}`);
if (!rControl.ok) console.log(`          stdout: ${control.stdout.trim().slice(0, 400)}\n          stderr: ${control.stderr.trim().slice(0, 400)}`);

const pass = rFixed.ok && rControl.ok;
if (pass) {
  rmSync(SCRATCH, { recursive: true, force: true });
  console.log('\n════════ 结论 ════════');
  console.log('PASS：对照实验成立 —— 不拦时内部 require 不被接管；拦后由纯 JS 垫片接管，'
    + 'MessagePort 事件确由垫片构造、端口收发无回归，且 `new Response(FormData)`'
    + '（附件型 RPC 唯一的响应形态）产出的是可 for-await 的 multipart 字节流。');
  process.exit(0);
} else {
  console.log('\n════════ 结论 ════════');
  console.log('FAIL：见上面两臂读数。');
  process.exit(1);
}
