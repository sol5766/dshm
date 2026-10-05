#!/usr/bin/env node
/**
 * 门禁：jitless 下**插件自建 worker 线程**必须和主线程一样拿到 jitless 补齐。
 *
 * ---------------------------------------------------------------------------
 * 为什么要有这个门禁
 * ---------------------------------------------------------------------------
 * 2026-10-04 真机缺陷：开发者工具里启用 `@deepseek-ai/dsh-experimental-inspector`
 * 报 `启用失败: dsh: warning: 1 entry did not activate`，栈是
 * `lazyllhttp … ReferenceError: WebAssembly is not defined`。
 *
 * 根因不在插件，而在**我们只在主线程装了补齐**：worker 是新线程、新 globalThis、
 * 新 module registry，`Module._load` hook / `globalThis.fetch` 覆盖 / undici 解析钩子
 * 一个都不过去。那个插件的 worker 第一行就要
 * `import "@deepseek-ai/dsh-app-boot/worker/profile-resolution-bootstrap"`
 * （内部 `createRequire(...)("node-addon-require-builtin")`），而它起 worker 时还
 * **显式**写死 `execArgv: []` —— 连 `--expose-internals` 都不继承。
 *
 * 关键教训：**"主线程全绿"完全覆盖不了这条路径**。所以本门禁真的起一个 worker，
 * 在 worker 里做两件真事：拿 internal 模块（经 `node-addon-require-builtin` 通道）
 * 与发一次真 fetch。
 *
 * ---------------------------------------------------------------------------
 * 它为什么可信：两臂对照
 * ---------------------------------------------------------------------------
 * 同一份 fixture、同一台本地 HTTP 服务、同一套端侧 flag（`--jitless`），只切换：
 *
 *   A 臂：**不**注入 ⇒ worker 里 must 失败（WASM 因果证据必须出现）。主线程那一侧
 *        在本臂里是**通的**（同一进程里不装任何东西也能 createServer），这正好模拟
 *        修复前的形态：主线程好好的，只有 worker 坏。
 *   B 臂：注入（`jitless-env.cjs` 的 `wrapWorkerThreads` + `worker-bootstrap.cjs`）
 *        ⇒ worker 里 must 全通。
 *
 * 两臂分别跑在独立子进程里——worker 注入是**进程级**的，注册后无法撤销。
 *
 * 用法：
 *   node tools/check-worker-jitless.mjs
 *   node tools/check-worker-jitless.mjs --self-test
 *
 * 退出码：0 通过 / 1 失败 / 3 环境不具备（缺 hostcore/app 的补齐文件，跳过）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'hostcore', 'app');
const SCRATCH = join(ROOT, 'dist', 'localtest', 'worker-jitless');
const args = process.argv.slice(2);

/* ───────────────────────── 分类（可自测） ───────────────────────── */

/** A 臂判定：必须失败，且原因是 WASM（否则说明这条路径已不再依赖 WASM，门禁失去意义）。 */
export function classifyNoInjectArm(stdout, stderr) {
  const all = `${stdout}\n${stderr}`;
  const wasmCause = /WebAssembly is not defined/.test(all);
  const reported = /\[probe\]\s*(\{.*\})/.exec(all);
  const ok = reported !== null && /"fetch":"200/.test(reported[1]);
  if (ok) return { ok: false, why: 'A 臂竟然全过 —— 说明 worker 里已经不需要补齐，本门禁失去意义，请重新审视' };
  if (!wasmCause) return { ok: false, why: 'A 臂失败了，但没有 WASM 因果证据 —— 无法认定是我们要防的那个原因' };
  return { ok: true, why: 'A 臂按预期失败，且带 WASM 因果证据' };
}

/** B 臂判定：三件事都必须成立（require-builtin 通道、internal 模块、真 fetch 200）。 */
export function classifyInjectedArm(stdout, stderr) {
  const all = `${stdout}\n${stderr}`;
  const m = /\[probe\]\s*(\{.*\})/.exec(all);
  if (m === null) return { ok: false, why: 'B 臂没有产出 probe 结果（worker 可能根本没起来）' };
  let report;
  try {
    report = JSON.parse(m[1]);
  } catch (e) {
    return { ok: false, why: `B 臂 probe 结果不是合法 JSON：${m[1].slice(0, 120)}` };
  }
  const problems = [];
  if (report.requireBuiltin !== 'function') problems.push(`require-builtin 通道不可用（${report.requireBuiltin}）`);
  if (report.internalModule !== 'ok') problems.push(`internal 模块不可达（${report.internalModule}）`);
  if (report.fetch !== '200 ok') problems.push(`worker 里 fetch 不通（${report.fetch}）`);
  if (problems.length > 0) return { ok: false, why: `B 臂失败：${problems.join('；')}` };
  return { ok: true, why: 'B 臂全通（require-builtin / internal 模块 / fetch 200）' };
}

/* ───────────────────────── 自测 ───────────────────────── */

function selfTest() {
  let pass = 0;
  let fail = 0;
  const t = (name, cond) => {
    if (cond) {
      pass += 1;
      console.log(`  ok   ${name}`);
    } else {
      fail += 1;
      console.log(`  FAIL ${name}`);
    }
  };
  const wasmStderr = 'Error: fetch failed\n cause: ReferenceError: WebAssembly is not defined';
  const okReport = '[probe] {"wasm":"undefined","requireBuiltin":"function","internalModule":"ok","fetch":"200 ok"}';
  const badReport = '[probe] {"wasm":"undefined","requireBuiltin":"FAIL: x","internalModule":"ok","fetch":"FAIL: y"}';

  t('A 臂：WASM 失败 → 成立', classifyNoInjectArm('', wasmStderr).ok);
  t('A 臂：全过 → 不成立', !classifyNoInjectArm('', okReport).ok);
  t('A 臂：失败但无 WASM 因果 → 不成立', !classifyNoInjectArm('', 'Error: ECONNREFUSED').ok);
  t('B 臂：三件事全通 → 成立', classifyInjectedArm(okReport, '').ok);
  t('B 臂：缺 internal 模块 → 不成立', !classifyInjectedArm(okReport.replace('"internalModule":"ok"', '"internalModule":"FAIL"'), '').ok);
  t('B 臂：无 probe 输出 → 不成立', !classifyInjectedArm('nothing', '').ok);
  t('B 臂：坏 JSON → 不成立', !classifyInjectedArm('[probe] {oops}', '').ok);
  t('B 臂：坏报告 → 不成立', !classifyInjectedArm(badReport, '').ok);

  console.log(`\n自测：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

if (args.includes('--self-test')) selfTest();

/* ───────────────────────── fixture ───────────────────────── */

const WORKER_SRC = `
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const report = { wasm: typeof WebAssembly };
console.log('[worker] body start; wasm=' + report.wasm + '; fetchIsNative=' + /native code/.test(String(fetch)));
try {
  const addon = require_('node-addon-require-builtin');
  report.requireBuiltin = typeof addon.requireBuiltin;
  console.log('[worker] require-builtin=' + report.requireBuiltin);
  try {
    const esm = addon.requireBuiltin('internal/modules/esm/loader');
    report.internalModule = esm === undefined || esm === null ? 'FAIL: 空' : 'ok';
  } catch (e) {
    report.internalModule = 'FAIL: ' + String(e && e.message).split('\\n')[0];
  }
  console.log('[worker] internalModule=' + report.internalModule);
} catch (e) {
  report.requireBuiltin = 'FAIL: ' + String(e && e.message).split('\\n')[0];
  report.internalModule = 'n/a';
  console.log('[worker] require-builtin FAIL: ' + report.requireBuiltin);
}
try {
  console.log('[worker] fetching ' + workerData.url);
  const res = await fetch(workerData.url);
  report.fetch = res.status + ' ' + (await res.text());
} catch (e) {
  report.fetch = 'FAIL: ' + String(e && e.message) + ' | cause=' + (e && e.cause ? e.cause.message : '-');
}
console.log('[worker] fetch=' + report.fetch);
parentPort.postMessage(report);
console.log('[worker] posted');
`;

// 臂进程：mode=inject 时先装 worker 注入，**之后再链接**起 worker 的模块；
// mode=none 时不装任何东西。
//
// 【为什么 worker 的创建要放在另一个模块里】真实插件（experimental-inspector）是在
// main.js 装好注入**之后**才被加载的，它用的是**静态** `import { Worker } from
// "node:worker_threads"`；那时 ESM facade 才建立，看到的是被包装过的 Worker。
// 如果本 fixture 自己静态 import Worker，那它在注入之前就绑定了原类 —— 测的就不是
// 真实时序（第一版门禁就是栽在这里：B 臂永远起不出带补齐的 worker）。
const SPAWNER_SRC = `
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
export function spawn(workerPath, url) {
  const worker = new Worker(pathToFileURL(workerPath), { execArgv: [], workerData: { url }, stdout: true, stderr: true });
  worker.stdout.on('data', (d) => process.stdout.write('[worker-out] ' + d.toString()));
  worker.stderr.on('data', (d) => process.stdout.write('[worker-err] ' + d.toString()));
  worker.once('message', (report) => { console.log('[probe] ' + JSON.stringify(report)); worker.terminate(); });
  worker.once('error', (error) => { console.log('[arm] worker error: ' + error.message.split('\\n')[0]); process.exitCode = 1; });
  worker.once('exit', (code) => console.log('[arm] worker exit=' + code));
  setTimeout(() => { console.log('[arm] watchdog 30s：worker 既没回消息也没退出'); process.exit(2); }, 30000);
  return worker;
}
`;

const ARM_SRC = `
import { pathToFileURL } from 'node:url';
const [spawnerPath, workerPath, url, mode] = process.argv.slice(2);
if (mode === 'inject') {
  const env = await import(pathToFileURL(${JSON.stringify(join(APP, 'jitless-env.cjs'))}).href);
  env.default.wrapWorkerThreads({
    preloadPath: ${JSON.stringify(join(APP, 'worker-bootstrap.cjs'))},
    log: (line) => console.log('[arm] ' + line),
  });
}
const spawner = await import(pathToFileURL(spawnerPath).href);
spawner.spawn(workerPath, url);
`;

/* ───────────────────────── 主流程 ───────────────────────── */

for (const need of ['jitless-env.cjs', 'worker-bootstrap.cjs', 'require-builtin-shim.cjs', 'internal-undici-shim.cjs', 'fetch-shim.js', 'undici-loader.mjs', 'undici-shim.mjs']) {
  if (!existsSync(join(APP, need))) {
    console.log(`\nSKIP：hostcore/app/${need} 不存在，环境不具备`);
    process.exit(3);
  }
}

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const workerPath = join(SCRATCH, 'probe-worker.mjs');
const spawnerPath = join(SCRATCH, 'probe-spawner.mjs');
const armPath = join(SCRATCH, 'probe-arm.mjs');
writeFileSync(workerPath, WORKER_SRC);
writeFileSync(spawnerPath, SPAWNER_SRC);
writeFileSync(armPath, ARM_SRC);

const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

/*
 * 【为什么必须用异步 spawn，不能用 spawnSync】本地 HTTP 服务跑在**本进程**里。
 * spawnSync 会把本进程的事件循环**整个阻塞**到子进程结束 —— 于是 worker 的 fetch
 * 连得上、却永远等不到响应（OS 层 accept 队列收下，没人应答），表现为"worker 挂住"。
 * A 臂看不出这个坑：它在连接之前就因 WASM 抛错了。
 */
const runArm = (mode) => new Promise((resolveArm) => {
  const child = spawn(process.execPath, ['--jitless', armPath, spawnerPath, workerPath, url, mode], {
    env: { ...process.env, DSHM_SANDBOX_HOME: SCRATCH, DSHM_WORKER_SHIM_LOG: '0' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const guard = setTimeout(() => { try { child.kill(); } catch (e) { /* ignore */ } }, 90000);
  child.on('close', (status) => { clearTimeout(guard); resolveArm({ stdout, stderr, status }); });
  child.on('error', (e) => { clearTimeout(guard); resolveArm({ stdout, stderr: `${stderr}\nspawn error: ${e.message}`, status: -1 }); });
});

console.log('A 臂：不注入（对照）...');
const armA = await runArm('none');
const verdictA = classifyNoInjectArm(armA.stdout ?? '', armA.stderr ?? '');
console.log(`  → ${verdictA.ok ? '成立' : '不成立'}：${verdictA.why}`);

console.log('B 臂：注入 wrapWorkerThreads + worker-bootstrap ...');
const armB = await runArm('inject');
const verdictB = classifyInjectedArm(armB.stdout ?? '', armB.stderr ?? '');
console.log(`  → ${verdictB.ok ? '通过' : '失败'}：${verdictB.why}`);
if (!verdictB.ok) {
  console.log('--- B 臂 stdout ---\n' + (armB.stdout ?? '').slice(-1500));
  console.log('--- B 臂 stderr ---\n' + (armB.stderr ?? '').slice(-1500));
}

server.close();

console.log('\n════════ 结论 ════════');
if (verdictA.ok && verdictB.ok) {
  console.log('PASS：对照实验成立 —— 同一份 worker，无注入必失败、有注入全通过。');
  process.exit(0);
}
console.log('FAIL：worker 线程的 jitless 补齐不成立（见上面两臂读数）。');
process.exit(1);
