'use strict';
/*
 * ── 进程内 CPython 的**执行线程**（worker_threads）────────────────────────────
 *
 * 【为什么要它 —— 内测日志里的 LOOP-GAP 根因之一】
 * 2026-10-19 内测日志（`dist/triage/2026-10-19/logs1019/DSH日志-20261019/node-output.log`）：
 *
 *   [06:13:03.450Z] IN-REQ GET /dshm-python/run-get?...&code=from pip._internal.cli.main import main%0Aprint(main(['install',…
 *   [06:13:03.458Z] LOOP-GAP 33277ms（事件循环停顿；第 9413 拍）
 *   [06:13:03.459Z] LOOP-GAP-33277ms SYNC-SLOW-LOG 36839ms existsSync /storage/Users/currentUser/.node_modules/...
 *
 * 另有 `LOOP-GAP 522814ms` / `LOOP-GAP 800711ms` 两处（8~13 分钟），**都**伴随
 * `/dshm-python/run-get` 与 `pip install`。那条链原本是：HTTP 端点在**主线程**里直接
 * 调 `bridge.captureRun(code)`（同步 NAPI）⇒ Python 跑多久，Host 的事件循环就停多久
 * （心跳、Web 请求、会话、终止全部停摆；看门狗自己也在主线程，只能事后记一笔）。
 *
 * 【本文件的位置】**唯一**加载 `libpython_runner.so` 并执行 Python 代码的地方
 * （主线程侧只在 `DSHM_PY_INLINE=1` 的降级分支里才会 dlopen，见 main.js 的同名注释）。
 * Python 跑在本 worker 的线程里 ⇒ 主线程事件循环不再被挡；CPU 仍占一个核（这是
 * CPython 的固有成本），但**不再牺牲整个 Host 的响应性**。
 *
 * ── 协议（与 python-bridge-async.cjs 逐字约定，改一边必须改另一边）────────────
 *   主线程 → worker:
 *     { type:'run',    id, code, timeoutMs }   // code = prelude + 用户代码（prelude 由 main.js 拼，
 *                                              //   见 main.js pyBridgePrelude 的注释：SIGALRM 超时 + ctypes audit）
 *     { type:'status', id }                    // 只读探测：不初始化 Python（isReady 不触发 Py_Initialize）
 *   worker → 主线程:
 *     { type:'result', id, ok, stdout, stderr, rc, error? }   // stderr 是 addon 的 errStderr 字段，
 *                                                            //   主线程侧映射回 HTTP 的 errStderr 字段名
 *     { type:'error',  id, message }                          // 执行/加载失败：**必须**让主线程拿到明确错误
 *     { type:'ready',  bridge, ready, initialized }            // 加载完成（或失败）后的首帧，供 status()
 *     { type:'status', id, bridge, ready, initialized }        // status 请求的应答
 *
 * 【取消语义】**不走消息**：主线程直接 `worker.terminate()`（见 python-bridge-async.cjs 的
 * `cancel()` / 超时分支）。理由：CPython 侧只有 SIGALRM 一个协作式中断点（且本 worker
 * 线程里 `signal.signal` 是否可用取决于 CPython 对"主线程"的判定），C 层长阻塞根本收不到；
 * terminate 是唯一可靠的停法。代价是解释器随线程一起重建（慢、但安全）——这也是
 * `DSHM_PY_INLINE=1` 之外**不再**在 Python 里跑"取消代码"的原因（旧实现跑一段
 * `signal.setitimer(ITIMER_REAL, 0)`，那只是清定时器，并不能真停掉正在跑的任务）。
 *
 * 【失败面】任何失败都要回成 `{type:'error'}` 或 `{ok:false}`，**绝不允许**静默回空成功：
 * 上层（python 工具 / python3 垫片）把 `ok:true` + 空 stdout 当成"命令跑完了、没输出"。
 */

/**
 * 协议版本。主线程侧（python-bridge-async.cjs）有同一个常量，门禁会断言两边一致 ——
 * 两份协议文档写在同一处、版本号一起改，是防止"一边改了字段另一边没跟着改"的唯一低成本办法。
 */
const PROTOCOL_VERSION = 1;

/**
 * 把 addon 的 `captureRun` 返回体规整成协议里的 `result` 帧。
 *
 * 【为什么单独抽成纯函数】它是**唯一**做字段映射的地方（`errStderr` → `stderr`），
 * 门禁可以在不需要真 Python 的机器上直接测它（离线 CI 就是这么跑的）。
 * @param {{ok?:boolean, stdout?:string, errStderr?:string, rc?:string|number, error?:string}|null} raw
 * @param {number} id
 */
function toResultFrame(raw, id) {
  const r = raw !== null && typeof raw === 'object' ? raw : {};
  const frame = {
    type: 'result',
    id: id,
    ok: r.ok === true,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.errStderr === 'string' ? r.errStderr : '',
    rc: r.rc === undefined || r.rc === null ? 'None' : String(r.rc),
  };
  /*
   * `error` 只在**真有**错误时带上：老 HTTP 响应里 `ok:false` 会带 `error`
   * （`captureRun 执行失败（Python 异常）` 或 addon 的初始化错误），字段名与文案必须原样
   * 透传，否则 python 工具/垫片那边的错误分类会变（契约见 tools/check-tool-python.mjs）。
   */
  if (typeof r.error === 'string' && r.error.length > 0) {
    frame.error = r.error;
  }
  return frame;
}

/** 只在本线程是**用户 worker** 时才启动执行循环（主线程 require 本文件只取纯函数）。 */
function startWorkerLoop() {
  const { parentPort, workerData } = require('node:worker_threads');
  if (parentPort === null || parentPort === undefined) {
    return false;
  }
  const data = workerData !== null && typeof workerData === 'object' ? workerData : {};
  const addonPath = typeof data.addonPath === 'string' ? data.addonPath : '';
  const libPath = typeof data.libPath === 'string' ? data.libPath : '';
  const homePath = typeof data.homePath === 'string' ? data.homePath : '';

  /** addon exports；加载失败后永久缓存失败原因（与主线程 getPyBridge 的硬错误缓存同口径）。 */
  let addon = null;
  let loadError = '';
  let loadTried = false;
  /** 最近一次请求的 id（异常兜底时要知道回给谁）。 */
  let inFlightId = 0;

  /**
   * 加载 addon（dlopen libpython_runner.so + 设 DSHM_PYTHON_LIB/HOME 环境变量）。
   * 只试一次：dlopen 失败属硬错误（libs 缺件 / 被系统策略拒），重试只会重复同一次失败。
   */
  function ensureAddon() {
    if (loadTried) {
      return addon !== null;
    }
    loadTried = true;
    if (addonPath.length === 0 || libPath.length === 0) {
      loadError = 'python worker 未拿到 addon/libpython 路径（DSHM_PY_WORKER 参数缺失）';
      return false;
    }
    /*
     * env 必须在 dlopen 之前设好：addon 的 EnsurePythonInit() 读 DSHM_PYTHON_LIB /
     * DSHM_PYTHON_HOME（与主线程 getPyBridge 完全同一口径 —— 这段代码就是那边搬过来的）。
     * worker 是独立线程但**同一进程** ⇒ process.env 共享，主线程设过也是同一份；这里再设一遍
     * 是为了让"worker 先起来、主线程还没走 getPyBridge"的路径也自洽。
     */
    process.env.DSHM_PYTHON_LIB = libPath;
    process.env.DSHM_PYTHON_HOME = homePath;
    try {
      const mod = { exports: {} };
      process.dlopen(mod, addonPath);
      addon = mod.exports;
      return true;
    } catch (e) {
      loadError = `python worker：addon 加载异常：${String(e && e.message ? e.message : e).slice(0, 200)}`;
      addon = null;
      return false;
    }
  }

  /** isReady() 不触发 Py_Initialize（addon 注释：「探测环境是否就位（不触发初始化）」）⇒ status 安全。 */
  function probe() {
    if (!ensureAddon()) {
      return { bridge: false, ready: false, initialized: false, error: loadError };
    }
    try {
      const info = addon.isReady();
      return {
        bridge: true,
        ready: info !== null && typeof info === 'object' && info.ready === true,
        initialized: info !== null && typeof info === 'object' && info.initialized === true,
      };
    } catch (e) {
      return {
        bridge: true,
        ready: false,
        initialized: false,
        error: `isReady 异常：${String(e && e.message ? e.message : e).slice(0, 200)}`,
      };
    }
  }

  /** 回一帧；postMessage 自己抛错也不许把 worker 带走。 */
  function send(frame) {
    try {
      parentPort.postMessage(frame);
    } catch (e) {
      /* 主线程已经终止了这条端口（terminate 竞争）：此时没人听，丢掉即可 */
    }
  }

  /**
   * 跑一段代码。
   *
   * 【为什么 epilogue 清 itimer 也在 worker 里】itimer / SIGALRM 是**进程级**的，但 handler
   * 绑在"设它的那个解释器线程"的语义上；清理必须与设置发生在同一侧。旧实现在主线程设/清，
   * 搬到 worker 后自然一起搬 —— 否则残留的 pending alarm 会误杀**下一个**任务
   * （2026-09-22 真机踩过：清 itimer 失败 ⇒ 下一请求被 SystemExit(124) 当场打死）。
   * 清理失败**不影响**本次结果（下次 run 的 prelude 会重设），因此只有 try/catch 不上报。
   */
  function runOne(id, code) {
    if (!ensureAddon()) {
      send({ type: 'error', id: id, message: loadError });
      return;
    }
    let raw;
    try {
      raw = addon.captureRun(code);
    } catch (e) {
      send({
        type: 'error',
        id: id,
        message: `captureRun 抛出异常：${String(e && e.message ? e.message : e).slice(0, 300)}`,
      });
      return;
    }
    try {
      addon.runString('try:\n    import signal\n    signal.setitimer(signal.ITIMER_REAL, 0)\nexcept BaseException:\n    pass');
    } catch (e2) {
      // 忽略：清理失败不影响本次结果（下个请求的 prelude 会重置 timer）
    }
    send(toResultFrame(raw, id));
  }

  parentPort.on('message', (msg) => {
    if (msg === null || typeof msg !== 'object') {
      return;
    }
    const id = Number.isFinite(msg.id) ? msg.id : 0;
    if (msg.type === 'status') {
      const st = probe();
      send({
        type: 'status',
        id: id,
        bridge: st.bridge,
        ready: st.ready,
        initialized: st.initialized,
        error: st.error,
      });
      return;
    }
    if (msg.type === 'run') {
      const code = typeof msg.code === 'string' ? msg.code : '';
      if (code.length === 0) {
        send({ type: 'error', id: id, message: 'code 不能为空' });
        return;
      }
      inFlightId = id;
      try {
        runOne(id, code);
      } finally {
        inFlightId = 0;
      }
    }
    // 其余 type 一律忽略：协议演进时"未知消息"不许把 worker 打成异常
  });

  /*
   * 【兜底】未捕获异常不许静默死掉：worker 静默退出时主线程只能看到一个 exit 码，
   * 而"到底哪段代码炸了"就永久丢了。这里回一帧 error（有在飞请求时）并让主线程
   * 决定是否重建 worker —— 明确错误 > 空成功。
   */
  process.on('uncaughtException', (e) => {
    send({
      type: 'error',
      id: inFlightId,
      message: `python worker 未捕获异常：${String(e && e.stack ? e.stack : e).slice(0, 400)}`,
    });
  });

  // 握手帧：status() 在主线程侧等的就是它（加载 addon 但不初始化 Python）。
  const hello = probe();
  send({ type: 'ready', bridge: hello.bridge, ready: hello.ready, initialized: hello.initialized });
  return true;
}

module.exports = {
  PROTOCOL_VERSION,
  toResultFrame,
  startWorkerLoop,
};

/*
 * 【入口判定】worker 线程里 `require` 它就自动启动；主线程 require 只拿纯函数
 * （门禁与诊断脚本需要 toResultFrame，不能因为 require 一下就起一个 worker）。
 */
if (require('node:worker_threads').isMainThread === false) {
  startWorkerLoop();
}
