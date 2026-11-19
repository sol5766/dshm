'use strict';
/*
 * ── 主线程侧的**异步 Python 桥**（把内嵌 CPython 的执行搬出主线程）────────────
 *
 * 【要解决什么】内测日志 2026-10-19（`node-output.log`）里三处超长 LOOP-GAP：
 *   `LOOP-GAP 800711ms` / `LOOP-GAP 522814ms` / `LOOP-GAP 33277ms`，
 * 每一处前面都紧跟一条 `IN-REQ GET /dshm-python/run-get?...pip._internal.cli.main…`。
 * 旧实现是 HTTP 端点在**主线程**同步调 `bridge.captureRun(code)`：pip 装一个包要几十秒到
 * 十几分钟，这段时间里 Host 的事件循环、心跳、Web 请求、会话全部停摆。
 *
 * 【本文件的位置】主线程**只**负责排队与调度；真正执行 Python 的是
 * `./python-worker.cjs` 那个 worker 线程。协议与取消语义的完整说明在那份文件头注里
 * （两份文件的 `PROTOCOL_VERSION` 必须一起改，门禁会断言一致）。
 *
 * 【四件事，逐条写清为什么这么做】
 *
 * ① **懒启动**：第一个任务到达（或 status 探测）才建 worker。理由：Python 桥是增量能力，
 *    绝大多数启动根本用不到它；提前建线程/加载 addon 只是给启动路径加刺。
 *
 * ② **单飞队列**：同一时刻只允许 1 个任务在 Python 里跑，其余排队。理由不是性能，
 *    而是**正确性**：内嵌 CPython 是**一个**解释器 + 一把 GIL，两个任务"并发"只会
 *    互相串 stdout 捕获、串 itimer、串 `sys.argv`（旧实现里这些全是进程级全局状态）。
 *    单飞还让"超时 → 整个解释器重建"这个粗暴但可靠的语义可控。
 *
 * ③ **超时 = terminate + 下次重建**：Python 侧的 SIGALRM（prelude 里设的）只能打断
 *    字节码执行，卡在 C 层长阻塞（无超时 DNS / 大文件 IO）时收不到；那种情况下主线程
 *    必须有第二道闸。看门狗比请求的 timeout **多等 `watchdogMarginMs`（默认 3s）**，
 *    让 Python 侧的 SIGALRM 先有机会以 `rc="124"` 正常返回（那是旧行为，垫片与 python
 *    工具都按它分类）—— 只有它彻底没回来，才 terminate。terminate 之后解释器随线程
 *    一起消失，下个任务重新建 worker（慢，但**不会**带着残留状态）。
 *
 * ④ **失败必须明确**：worker 崩了 / 消息通道断了 / 超时了，都回 `{ ok:false, error }`
 *    或 `{ ok:false, rc:'124' }`。**绝不**回 `{ ok:true, stdout:'' }` —— 上层会把空成功
 *    当成"命令跑完了、没输出"（python 工具 / python3 垫片都按 `ok` 分流）。
 *
 * 【为什么不用 `Promise` 池 / `piscina` 之类】jitless 环境 + 端侧零依赖，这个文件只用
 * Node 内建模块；而且行为要能被门禁逐条断言（假 worker 注入），第三方池的语义面太大。
 */

/**
 * 协议版本：与 `./python-worker.cjs` 的 `PROTOCOL_VERSION` 必须一致（门禁会断言）。
 * 改字段名/加消息类型时两边一起加，否则"一边改了另一边没跟着改"只会表现为运行时静默丢帧。
 */
const PROTOCOL_VERSION = 1;

/** 请求默认超时（与 HTTP 端点的 `timeout` 默认值 120s 同口径）。 */
const DEFAULT_TIMEOUT_MS = 120000;
/** 下限 1s：`/dshm-python/*` 的 `timeout` query 被 clamp 到 1..300 秒，这里与它对齐。 */
const MIN_TIMEOUT_MS = 1000;
/** 上限 300s：同上（端点 `pyBridgeTimeoutSec()` 的上界）。 */
const MAX_TIMEOUT_MS = 300000;
/**
 * 看门狗在请求超时之后再等的余量。
 * 【为什么不是 0】Python 侧 SIGALRM 到点后会走 `SystemExit(124)` → `captureRun` 捕获 →
 * 正常返回 `rc:"124"`。那才是旧实现的"超时口径"。主线程若同一刻就 terminate，
 * 这条正常路径会被"粗暴路径"覆盖，**返回体从 `rc:"124"`+部分 stdout 变成空 stdout**，
 * 垫片读到的 stdout 就没了。余量是为了让正常路径先赢。
 */
const WATCHDOG_MARGIN_MS = 3000;
/** worker 启动 + 首帧（加载 addon、isReady）的等待上限。 */
const STARTUP_TIMEOUT_MS = 10000;

/**
 * 把任意输入规整成合法超时（毫秒）：非数/非正 ⇒ 默认 120s；其余 clamp 到 1s..300s。
 * 抽成纯函数是为了门禁能在不需要 worker 的情况下直接断言口径。
 */
function clampTimeoutMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(n)));
}

/** 默认的 worker 工厂：只在这里 require `worker_threads`（测试可注入假 worker）。 */
function defaultSpawnWorker(script, workerOptions) {
  const { Worker } = require('node:worker_threads');
  return new Worker(script, workerOptions);
}

/**
 * 建一个异步桥实例。
 *
 * @param {object} options
 * @param {string} options.workerScript worker 入口脚本（端侧 = `__dirname/python-worker.cjs`）
 * @param {object} [options.workerData] 传给 worker 的 {addonPath, libPath, homePath}
 * @param {(line: string) => void} [options.diag] 诊断落点（main.js 传自己的 diag）
 * @param {(script: string, opts: object) => object} [options.spawnWorker] 假 worker 注入点（门禁用）
 * @param {number} [options.watchdogMarginMs] 覆盖 WATCHDOG_MARGIN_MS
 * @param {number} [options.startupTimeoutMs] 覆盖 STARTUP_TIMEOUT_MS
 * @returns {{run: Function, status: Function, cancel: Function, shutdown: Function, snapshot: Function, mode: string, PROTOCOL_VERSION: number}}
 */
function create(options) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const diag = typeof opts.diag === 'function' ? opts.diag : () => {};
  const spawnWorker = typeof opts.spawnWorker === 'function' ? opts.spawnWorker : defaultSpawnWorker;
  const workerData = opts.workerData !== null && typeof opts.workerData === 'object' ? opts.workerData : {};
  const watchdogMarginMs = Number.isFinite(opts.watchdogMarginMs)
    ? Math.max(0, Math.floor(opts.watchdogMarginMs))
    : WATCHDOG_MARGIN_MS;
  const startupTimeoutMs = Number.isFinite(opts.startupTimeoutMs)
    ? Math.max(1, Math.floor(opts.startupTimeoutMs))
    : STARTUP_TIMEOUT_MS;

  /** 当前 worker（null = 还没起 / 已终止）。 */
  let worker = null;
  /** 正在执行的任务（单飞：同一时刻最多一个）。 */
  let current = null;
  /** 排队任务。 */
  const queue = [];
  /** 握手状态：worker 起来后 `isReady()` 的读数（status() 的缓存兜底）。 */
  let readyState = { seen: false, bridge: false, ready: false, initialized: false };
  /** 等 ready 帧的人（status 的"首帧未到"分支）。 */
  const readyWaiters = new Set();
  /** 等 status 应答的人：id → {resolve, timer}。 */
  const statusWaiters = new Map();
  let nextId = 1;
  let closed = false;
  const stats = {
    runs: 0, completed: 0, timeouts: 0, cancels: 0, restarts: 0, spawns: 0, lastError: '',
    /* 最近一次任务在队列里等了多久（诊断用：区分"执行慢"与"根本没轮到"）。 */
    lastQueueMs: 0,
  };

  /** 清空 status 等待者（worker 死了/被杀了，不能再等）。 */
  function drainStatus(extra) {
    for (const [id, waiter] of statusWaiters) {
      if (waiter.timer !== null) {
        clearTimeout(waiter.timer);
      }
      statusWaiters.delete(id);
      waiter.resolve(Object.assign({ bridge: false, ready: false, initialized: false }, extra));
    }
  }

  /** 清空 ready 等待者（同上）。 */
  function drainReady() {
    for (const waiter of readyWaiters) {
      if (waiter.timer !== null) {
        clearTimeout(waiter.timer);
      }
      waiter.resolve({ bridge: false, ready: false, initialized: false });
    }
    readyWaiters.clear();
  }

  /** 重置"这个 worker 已作废"的全部状态。 */
  function resetWorkerState() {
    worker = null;
    readyState = { seen: false, bridge: false, ready: false, initialized: false };
    drainReady();
    drainStatus({});
  }

  /**
   * 终止当前 worker（不 resolve 任何任务 —— 调用方负责把在飞/排队任务的明确结果回掉）。
   * terminate() 是异步的，这里不 await：宿主退出路径不能被它拖住，而"下个任务重建"
   * 本来就是串行队列，不会有并发解释器。
   */
  function killWorker(reason) {
    const dying = worker;
    resetWorkerState();
    if (dying === null) {
      return;
    }
    diag(`python worker 终止：${reason}`);
    try {
      const p = dying.terminate();
      if (p !== null && typeof p === 'object' && typeof p.catch === 'function') {
        p.catch(() => { /* terminate 迟到失败：worker 已经不可用，无需处理 */ });
      }
    } catch (e) {
      /* worker 已经退出/端口已关：terminate 抛错属正常竞争 */
    }
  }

  /** worker 事件绑定。`onFailure` 里靠"是不是当前 worker"过滤迟到事件。 */
  function attach(w) {
    w.on('message', (msg) => {
      if (w !== worker) {
        return; // 迟到的旧 worker 帧
      }
      onMessage(msg);
    });
    w.on('error', (e) => {
      onWorkerFailure(w, '异常', String(e && e.stack ? e.stack : e).slice(0, 300));
    });
    w.on('exit', (code) => {
      onWorkerFailure(w, '退出', `exit code=${code}`);
    });
    if (typeof w.on === 'function') {
      // messageerror：端口收到了无法反序列化的消息（协议两端不一致时会出现）
      w.on('messageerror', (e) => {
        onWorkerFailure(w, '消息通道错误', String(e && e.message ? e.message : e).slice(0, 200));
      });
    }
  }

  /** 懒启动。启动失败直接抛（由 run/status 转成明确错误）。 */
  function ensureWorker() {
    if (worker !== null) {
      return worker;
    }
    const script = typeof opts.workerScript === 'string' ? opts.workerScript : '';
    if (script.length === 0) {
      throw new Error('python worker 脚本路径为空（python-bridge-async 未拿到 workerScript）');
    }
    let created;
    try {
      created = spawnWorker(script, { workerData });
    } catch (e) {
      stats.lastError = String(e && e.message ? e.message : e);
      throw new Error(`python worker 启动失败：${stats.lastError}`);
    }
    worker = created;
    stats.spawns += 1;
    attach(created);
    /*
     * unref：桥是**按需**能力，一个空闲的 worker 不应该成为"进程为什么退不出去"的答案。
     * 主线程真正在等结果时由 Promise + 定时器撑着（看门狗 timer 也 unref，见下），
     * 所以在 Host 里"没有任务时 loop 可以自然排空"，与心跳线程同一口径。
     */
    if (typeof created.unref === 'function') {
      created.unref();
    }
    return created;
  }

  /** 把当前任务以**明确结果**收尾（不抛、不静默）。 */
  function finishCurrent(result) {
    const task = current;
    if (task === null) {
      return;
    }
    current = null;
    if (task.timer !== null) {
      clearTimeout(task.timer);
      task.timer = null;
    }
    stats.completed += 1;
    task.resolve(result);
  }

  /** 收到 worker 的帧。 */
  function onMessage(msg) {
    if (msg === null || typeof msg !== 'object') {
      return;
    }
    if (msg.type === 'ready') {
      readyState = {
        seen: true,
        bridge: msg.bridge === true,
        ready: msg.ready === true,
        initialized: msg.initialized === true,
      };
      for (const waiter of readyWaiters) {
        if (waiter.timer !== null) {
          clearTimeout(waiter.timer);
        }
        waiter.resolve({ bridge: readyState.bridge, ready: readyState.ready, initialized: readyState.initialized });
      }
      readyWaiters.clear();
      return;
    }
    if (msg.type === 'status') {
      const waiter = statusWaiters.get(msg.id);
      if (waiter === undefined) {
        return;
      }
      statusWaiters.delete(msg.id);
      if (waiter.timer !== null) {
        clearTimeout(waiter.timer);
      }
      if (readyState.seen === false) {
        readyState = {
          seen: true,
          bridge: msg.bridge === true,
          ready: msg.ready === true,
          initialized: msg.initialized === true,
        };
      }
      waiter.resolve({
        bridge: msg.bridge === true,
        ready: msg.ready === true,
        initialized: msg.initialized === true,
        error: typeof msg.error === 'string' ? msg.error : '',
      });
      return;
    }
    const task = current;
    if (task === null || msg.id !== task.id) {
      return; // 迟到帧（例如超时后 terminate 前最后一帧）：丢掉，不许污染下一个任务
    }
    if (msg.type === 'error') {
      const message = typeof msg.message === 'string' && msg.message.length > 0 ? msg.message : '未知错误';
      stats.lastError = message;
      finishCurrent({ ok: false, error: `python worker：${message}` });
      pump();
      return;
    }
    if (msg.type === 'result') {
      const out = {
        ok: msg.ok === true,
        stdout: typeof msg.stdout === 'string' ? msg.stdout : '',
        /* 协议字段叫 stderr，HTTP 响应字段名仍是 errStderr（旧契约，垫片按它解析） */
        errStderr: typeof msg.stderr === 'string' ? msg.stderr : '',
        rc: msg.rc === undefined || msg.rc === null ? 'None' : String(msg.rc),
      };
      if (typeof msg.error === 'string' && msg.error.length > 0) {
        out.error = msg.error;
      }
      finishCurrent(out);
      pump();
    }
  }

  /** worker 异常/退出：把在飞任务收成明确错误，然后重试（下个任务会新建 worker）。 */
  function onWorkerFailure(w, kind, detail) {
    if (w !== worker) {
      return; // 已经主动 terminate / 已经被上一轮处理过
    }
    stats.restarts += 1;
    stats.lastError = `worker ${kind}：${detail}`;
    resetWorkerState();
    diag(`python worker ${kind}：${detail}（下个任务会重建解释器）`);
    if (current !== null) {
      const task = current;
      current = null;
      if (task.timer !== null) {
        clearTimeout(task.timer);
        task.timer = null;
      }
      task.resolve({
        ok: false,
        error: `python worker ${kind}：${detail}（解释器将在下次调用时重建）`,
      });
    }
    pump();
  }

  /** 看门狗：请求的超时 + 余量都没回来 ⇒ terminate + 重建。 */
  function onWatchdog(id) {
    const task = current;
    if (task === null || task.id !== id) {
      return;
    }
    current = null;
    if (task.timer !== null) {
      clearTimeout(task.timer);
      task.timer = null;
    }
    stats.timeouts += 1;
    diag(`python worker：执行超时（>${task.timeoutMs}ms，余量 ${watchdogMarginMs}ms）⇒ terminate 并重建解释器`);
    killWorker(`超时 ${task.timeoutMs}ms`);
    /*
     * 超时口径必须是 `rc="124"`（与 Python 侧 SIGALRM 的正常超时同口径）：
     * python3 垫片与 python 工具都按 `rc` 分类（见 tools/check-tool-python.mjs 的
     * "rc 124 ⇒ exitCode 124"）。stdout 为空是事实——结果永远回不来了。
     */
    task.resolve({
      ok: false,
      rc: '124',
      stdout: '',
      errStderr: `[dshm] python 执行超时（>${task.timeoutMs}ms），worker 已终止；解释器将在下次调用时重建\n`,
      error: `python 执行超时（>${task.timeoutMs}ms），worker 已终止并在下次调用时重建`,
      timedOut: true,
    });
    pump();
  }

  /** 从队列里取下一个任务执行（单飞）。 */
  function pump() {
    if (closed || current !== null) {
      return;
    }
    const task = queue.shift();
    if (task === undefined) {
      return;
    }
    /* 出队即停掉「排队超时」计时：之后算执行时长（见 run / onWatchdog）。 */
    if (task.queueTimer !== null) {
      clearTimeout(task.queueTimer);
      task.queueTimer = null;
    }
    if (task.queuedAt > 0) {
      stats.lastQueueMs = Date.now() - task.queuedAt;
    }
    current = task;
    task.id = nextId;
    nextId += 1;
    let w;
    try {
      w = ensureWorker();
    } catch (e) {
      current = null;
      stats.lastError = String(e && e.message ? e.message : e);
      task.resolve({ ok: false, error: String(e && e.message ? e.message : e) });
      pump();
      return;
    }
    stats.runs += 1;
    task.timer = setTimeout(() => onWatchdog(task.id), task.timeoutMs + watchdogMarginMs);
    if (typeof task.timer.unref === 'function') {
      task.timer.unref();
    }
    try {
      w.postMessage({ type: 'run', id: task.id, code: task.code, timeoutMs: task.timeoutMs });
    } catch (e) {
      // 端口已经断了（worker 正好在退出）：明确失败，不要挂在这里等看门狗
      current = null;
      if (task.timer !== null) {
        clearTimeout(task.timer);
        task.timer = null;
      }
      stats.lastError = String(e && e.message ? e.message : e);
      task.resolve({ ok: false, error: `python worker 消息投递失败：${stats.lastError}` });
      pump();
    }
  }

  /**
   * 提交一个任务。**永远** resolve（绝不 reject）——调用点是 HTTP 端点，
   * 一条未捕获的 rejection 会变成宿主级 unhandledRejection（Node 24 默认致命）。
   * @param {{code?: string, timeoutMs?: number, label?: string}} job
   * @returns {Promise<{ok:boolean, stdout?:string, errStderr?:string, rc?:string, error?:string,
   *   timedOut?:boolean, cancelled?:boolean}>}
   */
  function run(job) {
    const j = job !== null && typeof job === 'object' ? job : {};
    const code = typeof j.code === 'string' ? j.code : '';
    if (code.length === 0) {
      return Promise.resolve({ ok: false, error: 'code 不能为空' });
    }
    if (closed) {
      return Promise.resolve({ ok: false, error: 'python worker 已关闭（宿主正在退出）' });
    }
    const timeoutMs = clampTimeoutMs(j.timeoutMs);
    return new Promise((resolve) => {
      const task = {
        code,
        timeoutMs,
        label: typeof j.label === 'string' ? j.label : '',
        resolve,
        timer: null,
        queueTimer: null,
        queuedAt: Date.now(),
        id: 0,
      };
      /*
       * 【2026-11-10 排队也要有截止】执行看门狗是在**出队之后**才挂的（pump 里的
       * task.timer），因此并发排队时 `timeoutMs` 只约束"轮到它之后"的时长：
       * 前面的任务各自跑满上限，后面的任务可以等上几分钟而没有任何超时信号 ——
       * 调用方看到的就是"任务卡住、计时还在走"。
       * 这里给提交一个独立的排队时限：到点仍未出队就直接按超时失败并移出队列。
       */
      task.queueTimer = setTimeout(() => {
        const index = queue.indexOf(task);
        if (index < 0) {
          return;
        }
        queue.splice(index, 1);
        stats.timeouts += 1;
        diag(`python worker：排队超时（>${timeoutMs}ms 仍未轮到）⇒ 放弃本次提交`);
        resolve({
          ok: false,
          rc: '124',
          stdout: '',
          errStderr: `[dshm] python 排队超时（>${timeoutMs}ms），任务在执行前已放弃\n`,
          error: `python 排队超时（>${timeoutMs}ms），任务在执行前已放弃`,
          timedOut: true,
        });
      }, timeoutMs);
      if (typeof task.queueTimer.unref === 'function') {
        task.queueTimer.unref();
      }
      queue.push(task);
      pump();
    });
  }

  /**
   * 只读探测（`/dshm-python/status` 用）。字段形状与旧的 `bridge.isReady()` 完全对齐
   * （bridge / ready / initialized），另外多一个 `error` 供诊断 —— HTTP 层只取前三个。
   * @returns {Promise<{bridge:boolean, ready:boolean, initialized:boolean, error?:string}>}
   */
  function status() {
    if (closed) {
      return Promise.resolve({ bridge: false, ready: false, initialized: false, error: 'python worker 已关闭' });
    }
    let w;
    try {
      w = ensureWorker();
    } catch (e) {
      return Promise.resolve({
        bridge: false, ready: false, initialized: false, error: String(e && e.message ? e.message : e),
      });
    }
    const id = nextId;
    nextId += 1;
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      statusWaiters.set(id, waiter);
      waiter.timer = setTimeout(() => {
        if (statusWaiters.delete(id)) {
          resolve({
            bridge: false,
            ready: false,
            initialized: false,
            error: `python worker status 超时（${startupTimeoutMs}ms）`,
          });
        }
      }, startupTimeoutMs);
      if (typeof waiter.timer.unref === 'function') {
        waiter.timer.unref();
      }
      try {
        w.postMessage({ type: 'status', id });
      } catch (e) {
        statusWaiters.delete(id);
        if (waiter.timer !== null) {
          clearTimeout(waiter.timer);
        }
        resolve({
          bridge: false, ready: false, initialized: false, error: String(e && e.message ? e.message : e),
        });
      }
    });
  }

  /**
   * 取消：终止当前任务 + 排空队列，全部回**明确错误**（`cancelled:true`）。
   * 【为什么不是"跑一段取消代码"】旧实现在 Python 里跑 `signal.setitimer(ITIMER_REAL, 0)`
   * 清定时器——那只能清**还没触发**的定时器，停不掉正在跑的任务；而且解释器状态（捕获
   * 重定向、pending alarm、sys.argv）会留给下一个请求。terminate 是唯一真停法。
   * @param {string} [reason]
   * @returns {number} 被取消的任务数
   */
  function cancel(reason) {
    const why = typeof reason === 'string' && reason.length > 0 ? reason : 'cancel';
    const dropped = [];
    if (current !== null) {
      const task = current;
      current = null;
      if (task.timer !== null) {
        clearTimeout(task.timer);
        task.timer = null;
      }
      dropped.push(task);
    }
    while (queue.length > 0) {
      dropped.push(queue.shift());
    }
    if (dropped.length > 0 || worker !== null) {
      stats.cancels += 1;
      killWorker(`取消（${why}）`);
    }
    for (const task of dropped) {
      /* 排队计时器必须一起清：否则取消之后它还会再 resolve 一次（幂等但留下悬念）。 */
      if (task.queueTimer !== null) {
        clearTimeout(task.queueTimer);
        task.queueTimer = null;
      }
      task.resolve({
        ok: false,
        cancelled: true,
        error: `python 执行已取消（${why}）：worker 已终止，解释器将在下次调用时重建`,
      });
    }
    return dropped.length;
  }

  /** 宿主退出用：取消在飞/排队任务并放掉 worker。幂等。 */
  function shutdown(reason) {
    if (closed) {
      return 0;
    }
    closed = true;
    return cancel(typeof reason === 'string' && reason.length > 0 ? reason : 'shutdown');
  }

  /** 诊断快照（`diag`/门禁用；不含任何用户代码）。 */
  function snapshot() {
    return {
      mode: 'worker',
      protocol: PROTOCOL_VERSION,
      closed,
      hasWorker: worker !== null,
      running: current !== null,
      queued: queue.length,
      ready: { bridge: readyState.bridge, ready: readyState.ready, initialized: readyState.initialized },
      stats: Object.assign({}, stats),
    };
  }

  return {
    mode: 'worker',
    PROTOCOL_VERSION,
    run,
    status,
    cancel,
    shutdown,
    snapshot,
  };
}

module.exports = {
  PROTOCOL_VERSION,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  WATCHDOG_MARGIN_MS,
  STARTUP_TIMEOUT_MS,
  clampTimeoutMs,
  create,
};
