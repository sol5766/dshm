'use strict';
/*
 * worker 线程的 jitless 补齐入口（preload）。
 *
 * ---------------------------------------------------------------------------
 * 它怎么被装上
 * ---------------------------------------------------------------------------
 * `jitless-env.cjs` 的 `wrapWorkerThreads()` 包装了 `node:worker_threads` 的 `Worker`，
 * 于是**任何** worker（含插件自己 `new Worker(...)`，即使像
 * `@deepseek-ai/dsh-experimental-inspector` 那样显式写 `execArgv: []`）都会被塞进
 *   `--expose-internals --require <本文件>`
 * `--require` 在 worker 入口模块**之前**执行，所以补齐一定早于
 * `import "@deepseek-ai/dsh-app-boot/worker/profile-resolution-bootstrap"` 这类
 * 第一行就要内建模块的依赖。
 *
 * 本文件只做一件事：调 `jitless-env.cjs` 的单份实现。真正的理由与细节都在那边。
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

/**
 * 日志落点与主线程 `main.js` 的 DIAG_LOG 同规则：优先 `DSHM_SANDBOX_HOME`
 * （真机由 buildHostEnv 传入，能直接用 `hdc shell ls` 看到并取回），
 * 其次是 `DSHM_HOME`，最后退回 tmpdir。**默认只记一行**，避免把宿主日志冲掉；
 * `DSHM_WORKER_SHIM_LOG=1` 时同时回显到 stderr（PC 侧离线排查用）。
 */
function workerLog(line) {
  const text = `[${new Date().toISOString()}] [worker-shim] ${line}\n`;
  try {
    const dir = process.env.DSHM_SANDBOX_HOME && process.env.DSHM_SANDBOX_HOME.length > 0
      ? process.env.DSHM_SANDBOX_HOME
      : (process.env.DSHM_HOME && process.env.DSHM_HOME.length > 0 ? process.env.DSHM_HOME : os.tmpdir());
    fs.appendFileSync(path.join(dir, 'dshm-host.log'), text);
  } catch (e) {
    /* 写不进去也不能让补齐把 worker 搞崩 */
  }
  if (process.env.DSHM_WORKER_SHIM_LOG === '1') {
    try { process.stderr.write(text); } catch (e) { /* ignore */ }
  }
}

/*
 * ── 必须区分"用户 worker"与"Node 内部的 module-hook loader 线程" ──────────────
 *
 * 【为什么】`module.register()`（本补齐用它注册 undici 解析钩子）会在**另一个线程**
 * 里跑钩子，而那个线程是 Node 内部 `new Worker(...)` 起的，**继承本线程的
 * `process.execArgv`** —— 也就继承了我们的 `--require <本文件>`。于是：
 *   用户 worker → 本文件 → register() → hook 线程 → 本文件 → register() → …
 * 无限递归起线程，宿主表现为**静默挂死**（worker 既不回消息也不退出，实测）。
 *
 * 【怎么分辨（Node 24 实测读数）】hook 线程：`isMainThread=false`、**`parentPort === null`**、
 * `process.argv.length === 1`（没有入口脚本）。而任何 `new Worker(...)` 出来的用户
 * worker，`parentPort` 一定非 null。所以判据是"非主线程 **且** 有 parentPort"。
 * 内部线程里既不需要这些补齐（它只做模块解析），也绝不能再次 register()。
 */
let wt = null;
try {
  wt = require('node:worker_threads');
} catch (e) {
  wt = null;
}

const isUserWorker = wt !== null && wt.isMainThread === false && wt.parentPort !== null;

if (!isUserWorker) {
  workerLog(`跳过补齐：本线程不是用户 worker（isMainThread=${wt === null ? '?' : wt.isMainThread}`
    + `，parentPort=${wt !== null && wt.parentPort !== null ? '有' : 'null'}）`
    + '——Node 的 module-hook loader 线程就是这样；在它里面再 register() 会递归起线程');
} else {
  /*
   * 【读数怎么写才不误导】worker 的 `process.execArgv` **不能**用来判断 jitless：
   * 上游常显式传 `execArgv: []`（experimental-inspector 就是），我们只往里追加
   * `--expose-internals --require …`，所以 argv 里看不到 `--jitless`——但 `--jitless`
   * 是 V8 的**进程级** flag，worker 实际同样是 jitless（实测：`typeof WebAssembly`
   * 仍是 `undefined`）。因此这里同时打出 WASM 的实际读数。
   */
  workerLog(`已注入 worker 线程（threadId=${wt.threadId}；WASM=${typeof WebAssembly}；execArgv=${JSON.stringify(process.execArgv)}）`);
  try {
    require('./jitless-env.cjs').installWorkerEnvironment(workerLog);
  } catch (e) {
    workerLog(`补齐安装失败：${e && e.stack ? e.stack : String(e)}`);
  }
}
