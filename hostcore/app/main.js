'use strict';
/**
 * DSHM 端侧 Host 启动脚本（Node 侧，跑在嵌入式 Node 运行时里）。
 *
 * 职责（对应 D6 §4.1 R5/R6 与 §6.1）：
 *   1. 把 HOME / DSH_HOME 指向应用沙箱（鸿蒙的 `os.homedir()` 返回沙箱外目录，会 EPERM）
 *   2. 把核心树里的端侧 profile 装到 $DSH_HOME/profiles/<name>（dsh 只认 $DSH_HOME 下那份）
 *   3. 以**进程内**方式 runProfile 起 Host，只监听 127.0.0.1，不打开浏览器、不开窗口
 *   4. 把实际监听端口打到 stdout（ArkTS 侧据此做健康检查与接线）
 *
 * 为什么不用 child_process 再起一个 node：鸿蒙对创建进程有平台级限制（D6 E15），
 * 而 in-process runProfile 是社区已验证可行的路径。
 *
 * 环境变量（由 ArkTS 侧设置）：
 *   DSHM_CORE_DIR      核心树根目录（内含 node_modules/ 与 profiles/）
 *   DSHM_HOME          $DSH_HOME（跨版本共享的用户数据目录）
 *   DSHM_SANDBOX_HOME  HOME（可写沙箱目录）
 *   DSHM_PORT          监听端口（默认 3120）
 *   DSHM_PROFILE       profile 名（默认 ondevice）
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
// 用户插件行守卫（D27 死锁修复，2026-09-23）：预检 + 启动失败自愈。见 dshm-user-rows.js 头注释。
const userRows = require('./dshm-user-rows.js');
// 内置技能同步（P0-1 修复，2026-09-28）：内容 sha256 判等，避免等长改动推不下去。
// 单列文件是为了让 tools/check-skill-sync.cjs 能直接 require（main.js 不可 require）。
const skillsSync = require('./dshm-skills.js');
// 兼容性豁免通道（P1-3 修复，2026-09-28）：把上游 app-boot 的
// `setProfileVersionExemption` 接到端侧可达的入口（队列 + dsh 假壳 + 设置页）。
// 同样单列文件，理由同上（main.js 不可 require）。
const compatModule = require('./dshm-compat.js');

/**
 * 路径从哪来（**这一环不能靠环境变量**）
 *
 * 我们跑在 Electron 主进程里：`runBrowser()` 是 native 侧直接启动的，
 * ArkTS **没有**给这个进程设环境变量的通道。所以路径必须由 Node 侧自己定位。
 * Electron 的 `app.getPath('userData')` 就是应用沙箱内的可写目录（社区已验证可用），
 * 于是约定：`<userData>/dsh/` 下放 cores/ 与 home/。
 * 环境变量仍然优先生效——那是给"宿主侧离线验证 / 调试"用的。
 */
function electronUserData() {
  try {
    // 只有真的在 Electron 主进程里才有这个模块；离线跑 Node 时会抛错，走 env 回退
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      return electron.app.getPath('userData');
    }
  } catch (e) {
    // 忽略：不是 Electron 环境
  }
  return '';
}

const USER_DATA = electronUserData();
const DSH_BASE = USER_DATA.length > 0 ? path.join(USER_DATA, 'dsh') : '';

/*
 * ── 诊断引导（必须在一切之前）──────────────────────────────────────────────
 *
 * 【为什么需要它】真机崩溃日志（D6 E23）显示：应用起来后 2 秒内以
 *   Reason:Signal:SIGABRT   LastFatalMessage:[appspawn_server.c:69]Unexpected call: exit(1)
 * 结束，调用栈是 node::LoadEnvironment → node::StartExecution → JS → 某个 native → exit()。
 * 也就是说**是 JS 调用了 process.exit(1)**，而不是原生引导崩溃。
 * 但排查被卡住的原因很具体：**Node 的 console.log 走 stdout，在应用进程里不进 hilog**，
 * 所以"看不到日志"被误读成"代码没跑"（这个误判浪费了很久）。
 *
 * 因此这里做两件事：
 *   1. 把 stdout/stderr 与关键里程碑**落进文件**，事后用 `hdc file recv` 取回；
 *   2. 拦截 `process.exit`：先把**调用栈**写进日志，然后**不真的退出**。
 *      理由：OHOS 用 libappspawn_helper 拦截应用进程里的 exit()，真调用它只会换来
 *      SIGABRT（拿不到任何解释）；而"不退出"能让进程活着，把更多信息留下来。
 *      这是**诊断期**的行为，正式形态要不要保留见 D6 的 fail-loud 讨论。
 *
 * 【为什么写在最前面】后面的任何一行都可能抛错或退出；先装好这些，才拿得到原因。
 */
const DIAG_LOG = path.join(
  // 优先落在**调用方传进来的沙箱目录**（阶段二由 buildHostEnv 传 DSHM_SANDBOX_HOME）：
  // 那个目录我们能直接用 `hdc shell ls` 看到并取回，而 os.tmpdir() 落在哪里不好找。
  process.env.DSHM_SANDBOX_HOME && process.env.DSHM_SANDBOX_HOME.length > 0
    ? process.env.DSHM_SANDBOX_HOME
    : (USER_DATA.length > 0 ? USER_DATA : require('node:os').tmpdir()),
  'dshm-host.log');
let diagStream = null;
function diag(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  try {
    if (diagStream === null) {
      diagStream = fs.createWriteStream(DIAG_LOG, { flags: 'a' });
      diagStream.on('error', () => { diagStream = null; });
    }
    diagStream.write(text);
  } catch (e) {
    // 写不进去也不能让诊断本身把启动搞崩
  }
  // 同时也往 stdout 打：PC 侧离线跑时能直接看见
  try { process.stdout.write(text); } catch (e) { /* ignore */ }
}

/*
 * 【诊断（E88）】`diagSync`：**同步**落盘，专给「进程即将结束」这一类读数用。
 *
 * `diag()` 走 `fs.createWriteStream`（缓冲）+ stdout：进程结束时（`process.exit` 之后的
 * `exit` 事件、loop 排空瞬间）排队中的写很可能整批丢掉。而「宿主为什么自己退出」恰恰只
 * 发生在最后一瞬，必须保证落地。只用低频、退出相关的事件，不碰请求路径。
 */
function diagSync(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  try { fs.appendFileSync(DIAG_LOG, text); } catch (e) { /* ignore */ }
  try { process.stdout.write(text); } catch (e) { /* ignore */ }
}

/*
 * jitless 运行期补齐层（单份实现）。
 *
 * 【为什么抽出去】这些补齐原先内联在本文件里，只在**主线程**生效；而 worker 线程是
 * 新线程、新 globalThis、新 module registry，一个 hook 都不过去。开发者工具里的
 * `@deepseek-ai/dsh-experimental-inspector` 恰恰要起 worker（且显式写 `execArgv: []`），
 * 于是在 worker 里 `WebAssembly is not defined` / 原生 fetch / 真 addon 全部复现，
 * 插件激活失败。现在主线程与 worker 共用 ./jitless-env.cjs 一份实现，worker 由
 * `wrapWorkerThreads()` 用 `--require` 注入 ./worker-bootstrap.cjs 来装。
 * 下面每个调用点保留原有的"为什么"注释与调用时机，实现细节见该文件。
 */
const jitlessEnv = require('./jitless-env.cjs');

/** 句柄/请求的类型统计：用来解释「loop 为什么排空」。 */
function dshmTallyHandles() {
  try {
    const hs = typeof process._getActiveHandles === 'function' ? process._getActiveHandles() : [];
    const rs = typeof process._getActiveRequests === 'function' ? process._getActiveRequests() : [];
    const tally = (list) => {
      const m = new Map();
      for (const h of list) {
        const n = h && h.constructor && h.constructor.name ? h.constructor.name : typeof h;
        m.set(n, (m.get(n) || 0) + 1);
      }
      return [...m.entries()].map(([k, v]) => `${k}x${v}`).join(',');
    };
    return `handles=${hs.length}[${tally(hs)}] requests=${rs.length}[${tally(rs)}]`;
  } catch (e) {
    return `handles=err(${String(e)})`;
  }
}

diag(`--- boot pid=${process.pid} execPath=${process.execPath} argv=${JSON.stringify(process.argv)}`);
diag(`userData=${USER_DATA} DSH_BASE=${DSH_BASE}`);
// koffi 按 `${root}/build/koffi/${process.platform}_${process.arch}/koffi.node` 找原生模块
// （见 node_modules/koffi/index.js:468-499）。我们随包放的是 `openharmony_arm64`，
// 所以要如实打印这两个值，才能判断它到底在找哪个目录名。
diag(`platform=${process.platform} arch=${process.arch} versions=${JSON.stringify(process.versions)}`);

/*
 * 【诊断（E82）】给上层日志补时间戳（opt-in：`DSHM_TS_LOG=1`）。
 *
 * 【为什么需要】`diag()` 自己有 `[ISO]` 前缀并落进 `dshm-host.log`，但**插件/上层**
 * 打的 `console.*` 没有：`[deepseek-account] request/response` 这种恰好夹住网络往返的
 * 行因此只能靠"行序"猜时间，端侧那两个 boot 的"点击→浏览器"窗口就是这么失去刻度的。
 *
 * 【为什么逐行读环境变量】`process.env` 是活对象，运行期置 `DSHM_TS_LOG=1` 立刻生效，
 * 不必为一次取证重编 HAP，也不必让正式形态默认多一段前缀。
 */
try {
  const tsMethods = ['log', 'info', 'warn', 'error', 'debug'];
  let tsWrapped = 0;
  for (const tsName of tsMethods) {
    const tsOrig = console[tsName];
    if (typeof tsOrig !== 'function' || tsOrig.__dshmTsWrapped === true) continue;
const tsFn = function (...args) {
// 【诊断版（E86）】默认挂时间戳（`DSHM_TS_LOG=0` 关闭）：取证不该依赖运行期 setenv。
if (process.env.DSHM_TS_LOG !== '0') {
        return tsOrig.apply(console, [`[${new Date().toISOString()}]`, ...args]);
      }
      return tsOrig.apply(console, args);
    };
    tsFn.__dshmTsWrapped = true;
    console[tsName] = tsFn;
    tsWrapped++;
  }
diag(`插件日志时间戳前缀已就绪（${tsWrapped} 个 console 方法；诊断版默认逐行生效，DSHM_TS_LOG=0 关闭）`);
} catch (e) {
  diag(`插件日志时间戳前缀安装失败：${String(e)}`);
}

const realExit = process.exit.bind(process);
/**
 * 是否允许真正退出（E90）。
 *
 * 【为什么需要这个开关】诊断期我们**故意**让 `process.exit` 空转：真退出在 OHOS 上会
 * 变成 SIGABRT 之类"什么都不留下"的结束，而引导阶段的失败信息是当时唯一的线索。
 * 但"停止核心"必须能真的停下来（核心切换/回滚的前置条件），所以给协作式停止留一个
 * **显式**的放行开关：只有停止路径会把它置真，其它任何 `process.exit` 仍被拦住并记录。
 */
let ALLOW_EXIT = false;
process.exit = (code) => {
  if (ALLOW_EXIT) {
    diagSync(`!! process.exit(${code})：停止路径放行，真正退出`);
    return realExit(code);
  }
  const stack = new Error('process.exit intercepted').stack || '(no stack)';
  diagSync(`!! process.exit(${code}) called -- intercepted, NOT exiting`);
  diagSync(`!! stack: ${String(stack).split('\n').join(' | ')}`);
  // 诊断期不退出：真退出在 OHOS 上会变成 SIGABRT，什么解释都留不下
  return undefined;
};

/*
 * ── 未处理异常/拒绝：单一入口 + 已知噪声降级（2026-09-26 报告 3 ②）──────────
 *
 * 【为什么要合并】原先这里注册了一个 `unhandledRejection`（diag），文件末尾又注册
 * 了第二个（console.error）——Node 会把**同一个事件派发给两个监听器**，于是每条
 * 未处理拒绝都被打两遍（diag + node-output），真故障的上下文被自己的回显淹没。
 * 现在统一在本处处理（`uncaughtException` 同样只留一处）。
 *
 * 【为什么要降级这条已知噪声】`--jitless ⇒ WebAssembly === undefined`，而 Node 24
 * 的全局 fetch 引导会 require `node:internal/deps/undici/undici`，其 WASM 版 llhttp
 * 一初始化就抛 `WebAssembly is not defined`（栈含 `lazyllhttp` → `lib/global.js`）。
 *
 * 【2026-10-05 更新：这条噪声已从根上消除】`installInternalUndiciShim()` 现在在
 * **BuiltinModule 层**接管该模块（见下面调用点的注释）。真机实测：启动期不再新增此噪声、
 * 插件激活不再失败（`did not activate` 0 次、`/bootstrap` 200）。
 * 这里的识别/降级分支**保留**，只用于兜其它来源的同类 WASM 噪声——但**不要**再据此
 * 认为"这条根因修不了"（第一版就是这么误判的）。
 */
function isKnownJitlessUndiciNoise(stackText) {
  return /WebAssembly is not defined/.test(stackText)
    && /lazyllhttp|internal\/deps\/undici/i.test(stackText);
}

/*
 * 【栈深】Node 默认 `Error.stackTraceLimit = 10`：2026-10-04/05 两轮真机排障都被"栈只剩 10 帧"
 * 卡住（真正有用的帧在下面，报告里只能看到表层）。抬到 50 只影响诊断文本长度，不改行为，
 * 进程启动期设一次即可。
 */
Error.stackTraceLimit = 50;

/**
 * 已知 jitless 噪声的统一诊断文案（两个进程级入口共用）。
 *
 * 【为什么抽出来（2026-10-05 收尾审计）】`uncaughtException` 与 `unhandledRejection` 两个入口
 * 各自硬编码了一句几乎相同但**措辞不同**的文案（"已由垫片接管" vs "已由 fetch 垫片接管"），
 * 同一件事在日志里出现两种写法 ⇒ 检索/统计时会漏。判据（`isKnownJitlessUndiciNoise`）本来
 * 就是共用的，文案也应共用。
 */
function diagKnownJitlessUndiciNoise() {
  diag('已知噪声：Node 内建 undici 在 --jitless 下初始化失败（无 WASM），已由 jitless 垫片接管；忽略');
}

process.on('uncaughtException', (err) => {
  const stack = err && err.stack ? err.stack : String(err);
  // 【2026-10-05 补齐（登记在 parity §3.2 收尾表遗留 ③）】此前只有 `unhandledRejection` 走噪声
  // 识别，而同一个 undici 初始化失败也可能以 `uncaughtException` 形态出现 ⇒ 那条会被当成真故障
  // 打满日志。两个入口现在共用同一条判据（与同一句文案）。
  if (isKnownJitlessUndiciNoise(stack)) {
    diagKnownJitlessUndiciNoise();
    return;
  }
  diag(`!! uncaughtException: ${stack}`);
});
process.on('unhandledRejection', (reason) => {
  const stack = reason && reason.stack ? reason.stack : String(reason);
  if (isKnownJitlessUndiciNoise(stack)) {
    diagKnownJitlessUndiciNoise();
    return;
  }
  diag(`!! unhandledRejection: ${stack}`);
});
/*
 * 【诊断（E88）】「宿主自己干净退出（code=0）」的成因取证。
 *
 * 三次现场都只留下 `!! process 'exit' event, code=0`：没有 `收到停止请求` / `收到应用重启请求`
 * （它们走 `log()`，此前只进 stdout，见本文件 `log()` 的 E88 说明），也没有被拦下的
 * `process.exit`。这套读数把可能性一次分完：
 *   - `beforeExit`：loop 自己排空（= 某个句柄被关掉/取消引用），并打出当时的句柄快照；
 *   - `SERVER-CLOSE/UNREF`（挂在 createServer 包装里）：谁关掉了监听句柄，带调用者栈；
 *   - `signal`：平台发来的信号（SIGTERM 等）；
 *   - `disconnect`：父进程通道断开（应用侧结束）。
 * `process.exitCode` 是 `configurable:false` 的访问器，改不了，所以这里只记录它的值。
 */
process.on('beforeExit', (code) => {
  diagSync(`!! beforeExit code=${code} exitCode=${process.exitCode}（loop 已排空） ${dshmTallyHandles()}`);
});
process.on('disconnect', () => {
  diagSync(`!! process 'disconnect'（父进程通道断了） ${dshmTallyHandles()}`);
});
for (const dshmSignal of ['SIGHUP', 'SIGINT', 'SIGTERM', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2']) {
  try {
    process.on(dshmSignal, () => {
      diagSync(`!! signal ${dshmSignal}（只记录；默认处置已被其它监听器取代） ${dshmTallyHandles()}`);
    });
  } catch (e) { /* 平台不支持该信号 */ }
}
process.on('exit', (code) => {
  diag(`!! process 'exit' event, code=${code} exitCode=${process.exitCode}`);
  diagSync(`!! EXIT-SNAPSHOT code=${code} exitCode=${process.exitCode} ${dshmTallyHandles()}`);
});

/*
 * 【必须保留】阻断 `node:http` 的惰性 undici。
 * 关键栈帧（D6 E38）：`at lazyUndici (node:http:123:21)`。Node 22 用 undici 实现
 * `http.Agent`/`globalAgent` 等；只要在任何人访问之前把**所有惰性 getter** 定义掉，
 * 那条路径就不会被触发，也就不需要 WebAssembly（jitless 下它是 undefined）。
 * 不能先读原值（读一下就触发初始化）——只能用 getOwnPropertyDescriptor 看描述符。
 * 【WASM 可用时不封】封了会反噬原生 undici（`http.maxHeaderSize` 变 `{}` ⇒
 * `fetch failed / cause: http module not available or http.maxHeaderSize invalid`），
 * 所以该函数自带这个条件，详见 jitless-env.cjs。
 */
jitlessEnv.sealHttpLazyUndici(diag);

/*
 * 【诊断（E81）】入站请求观测：把 WS 升级与普通请求的**原始事实**打出来。
 *
 * 【为什么分两档】`upgrade` 事件**罕见且决定性**（一次握手一行），所以永远打；
 * 普通请求每个 RPC 都来一行，长期开着会把 hilog 冲掉——实测它曾经把真正要看的
 * 模型报错挤出窗口。于是普通请求那档用 `DSHM_IN_LOG=1` 显式打开。
 *
 * 为什么要在 `node:http` 这一层做：`dsh-host-webserver` 的升级路由在**未匹配**时
 * 只 `socket.destroy()`（日志里什么都没有），匹配到普通路由时也不打印任何东西。
 * 于是端侧只看到「客户端报 ws 升级响应不是 101、状态码 200」这个**二手的结论**，
 * 无法区分三种完全不同的原因：
 *   (a) 客户端根本没发升级头（服务端按普通 GET 处理，落到 SPA 回退 → 200）；
 *   (b) 升级头发了、路径不对（未匹配路由 → destroy，客户端看到"连接被断"）；
 *   (c) 升级头与路径都对、只是 cookie 没带上（fence 回 401）。
 * 只有服务端侧的原始读数能把它们分开，所以在 `createServer` 上挂自己的监听器
 * ——不改 dsh 一行代码，也不影响任何既有行为。
 */
try {
  for (const modName of ['node:http', 'node:https']) {
    const mod = require(modName);
    const origCreate = mod.createServer;
    if (typeof origCreate === 'function' && origCreate.__dshmWrapped !== true) {
      const wrapped = function (...args) {
        const server = origCreate.apply(this, args);
        try {
          server.on('upgrade', (req) => {
            const h = req.headers || {};
            diag(`IN-UPGRADE ${req.method} ${req.url} conn=${h.connection} upgrade=${h.upgrade}` +
              ` key=${h['sec-websocket-key'] === undefined ? 'no' : 'yes'}` +
              ` ver=${h['sec-websocket-version']} cookie=${h.cookie === undefined ? '(none)' : h.cookie.length + 'B'}` +
              ` origin=${h.origin}`);
          });
          /*
           * 【诊断（E83）】accept 轨迹。
           *
           * 真机读数（sampler7）：停滞期 TCP 三次握手 1ms 内完成，但 recv 一直超时，
           * 且 /proc/net/tcp 的 LISTEN rx_queue 单调增长 ⇒ 连接进了 accept 队列却没人收。
           * 但同一时刻我们看到的线程状态是 `epoll_wait`、监听 fd 也确实注册在某个 epoll 集合里
           * ——两者逻辑上不能同时成立。这行读数直接回答"accept 有没有被调用"，不再靠推断。
           * 前 500 条全记，之后每 25 条记一次（正常一次冷启动的连接数在几十到几百量级）。
           */
          try {
            let dshmAccepts = 0;
            server.on('connection', (socket) => {
              dshmAccepts += 1;
              if (dshmAccepts <= 500 || dshmAccepts % 25 === 0) {
                let remote = '?';
                try { remote = `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? '?'}`; } catch (e) { /* 取不到就算了 */ }
                diag(`ACCEPT #${dshmAccepts} ${remote}`);
              }
            });
} catch (e) { /* 挂载失败不影响 accept */ }
/*
 * 【诊断（E88）】监听句柄的生命周期。
 *
 * 一个正在 listen 的 HTTP server 是唯一能撑住事件循环的句柄：它一旦被 `close()` 或
 * `unref()`，loop 就会排空、进程以 `process.exitCode`（默认 0）**自然退出**——
 * 这正是三次「点登录后宿主自己干净退出」的形态。这里记下**调用者栈**，把成因钉死。
 * 纯被动：包住实例方法，不改任何行为。
 */
try {
  let dshmAddr = '(pending)';
  const dshmReadAddr = () => {
    try {
      const a = server.address();
      dshmAddr = a && typeof a === 'object' ? `${a.address}:${a.port}` : '(closed)';
    } catch (e) { dshmAddr = '(err)'; }
    return dshmAddr;
  };
  const dshmWhoCalled = (what) => {
    try {
      return String((new Error(what)).stack || '').split('\n').slice(1, 7).map((s) => s.trim()).join(' | ');
    } catch (e) { return '(no stack)'; }
  };
  for (const dshmMeth of ['close', 'unref', 'ref']) {
    const dshmOrig = server[dshmMeth];
    if (typeof dshmOrig !== 'function' || dshmOrig.__dshmLifeWrapped === true) continue;
    const dshmFn = function (...a) {
      diagSync(`SERVER-${String(dshmMeth).toUpperCase()} call ${dshmReadAddr()} :: ${dshmWhoCalled('srv.' + dshmMeth)}`);
      return dshmOrig.apply(this, a);
    };
    dshmFn.__dshmLifeWrapped = true;
    server[dshmMeth] = dshmFn;
  }
  server.on('listening', () => diag(`SERVER-LISTENING ${dshmReadAddr()}`));
  server.on('close', () => { dshmReadAddr(); diagSync(`SERVER-CLOSE event ${dshmAddr}`); });
} catch (e) { diag(`SERVER-LIFE 挂载失败：${String(e)}`); }
server.on('request', (req, res) => {
/*
 * 【诊断版（E86）】默认开启入站日志（`DSHM_IN_LOG=0` 显式关闭）。
 *
 * 原来是 `!== '1' 就 return`，于是每次取证都要先用 python 桥在宿主进程里 setenv，
 * 而那个桥是在本进程里跑 CPython 的 —— 它本身就是「谁挡住了事件循环」的嫌疑人。
 * 诊断期间默认开启，让测量与被测对象解耦（正式形态要恢复门控或摘掉埋点）。
 */
if (process.env.DSHM_IN_LOG === '0') return;
            const h = req.headers || {};
            diag(`IN-REQ ${req.method} ${req.url} conn=${h.connection} upgrade=${h.upgrade}` +
              ` cookie=${h.cookie === undefined ? '(none)' : h.cookie.length + 'B'}` +
              ` origin=${h.origin} ua=${h['user-agent']}`);
            /*
             * 【诊断（E82）】补上**耗时**：IN-REQ 只回答"请求到没到"，回答不了"这一跳
             * 花了多久"。启动后慢的投诉里，"客户端 RPC 占多少、宿主 handler 占多少"
             * 一直是空的——插件自己的 stdout（如 `[deepseek-account]`）没有时间戳，
             * 端侧 ArkWeb 的日志也没有，只有这一层能给出绝对刻度。
             * 挂在 `res` 上是纯被动监听，不参与响应，也不改任何既有行为。
             */
            const t0 = Date.now();
            try {
              res.on('finish', () => {
                diag(`IN-DONE ${req.method} ${req.url} ${Date.now() - t0}ms status=${res.statusCode}`);
              });
              res.on('close', () => {
                if (!res.writableFinished) {
                  diag(`IN-ABORT ${req.method} ${req.url} ${Date.now() - t0}ms`);
                }
              });
            } catch (e) { /* 挂载失败不影响请求处理 */ }
          });
        } catch (e) {
          diag(`IN-LOG 挂载失败：${String(e)}`);
        }
        return server;
      };
      wrapped.__dshmWrapped = true;
      mod.createServer = wrapped;
    }
  }
  diag('入站请求诊断已安装（IN-UPGRADE / IN-REQ）');
} catch (e) {
  diag(`入站请求诊断安装失败：${String(e)}`);
}

/*
 * 【诊断（E85）】启动即开 V8 CPU 采样（真机阻塞期的调用栈）。
 *
 * LOOP-GAP 只能判决「loop 停摆(H1)」还是「loop 在转(H2)」；若判成 H1，还得知道是谁挡的。
 * loop 被同步调用挡住时任何 JS 定时器都跑不了，只能靠独立线程的采样器——V8 CPU profiler
 * 就在独立线程打点，能采到「发起这次同步调用的 JS 帧」。本机已验证：忙等 400ms 时
 * 398 个样本里 343 个精确落在忙等那一行（dist/_proftest.cjs）。
 * 采样间隔 1000µs；看门狗发现 >=3s 停顿后（loop 恢复时）stop 落盘，再重新开始，最多 3 份。
 * 全程 try/catch：拿不到 inspector 只记一行 PROF-UNAVAILABLE，绝不影响启动。
 */
let dshmDumpProfile = null;
try {
  const fsProf = require('node:fs');
  const PROF_DIR = path.join(path.dirname(DIAG_LOG), 'dshm-diag');
  const inspector = require('node:inspector');
  const profSession = new inspector.Session();
  profSession.connect();
  let profRunning = false;
  let profDumps = 0;
  const profPost = (method, params) => new Promise((resolve, reject) => {
    profSession.post(method, params || {}, (err, result) => (err ? reject(err) : resolve(result)));
  });
  const startProf = () => {
    if (profRunning || profDumps >= 3) { return Promise.resolve(); }
    return profPost('Profiler.start').then(() => {
      profRunning = true;
      diag('PROF-STARTED（采样间隔 1000us）');
    }).catch((e) => { diag(`PROF-START-FAIL ${String(e)}`); });
  };
  dshmDumpProfile = (tag) => {
    if (!profRunning || profDumps >= 3) { return; }
    profRunning = false;
    profDumps += 1;
    profPost('Profiler.stop').then((r) => {
      try {
        fsProf.mkdirSync(PROF_DIR, { recursive: true });
        const file = path.join(PROF_DIR, `dshm-profile-${tag}-${Date.now()}.cpuprofile`);
        fsProf.writeFileSync(file, JSON.stringify(r.profile));
        diag(`PROF-DUMPED ${file} nodes=${r.profile.nodes.length} samples=${r.profile.samples.length}`);
      } catch (e) {
        diag(`PROF-DUMP-FAIL ${String(e)}`);
      }
      return startProf();
    }).catch((e) => { diag(`PROF-STOP-FAIL ${String(e)}`); });
  };
  profPost('Profiler.enable')
    .then(() => profPost('Profiler.setSamplingInterval', { interval: 1000 }))
    .then(() => startProf())
    .catch((e) => { diag(`PROF-UNAVAILABLE ${String(e)}`); dshmDumpProfile = null; });
} catch (e) {
  diag(`PROF-UNAVAILABLE（本机 Node 无 inspector 或不可用）：${String(e)}`);
  dshmDumpProfile = null;
}

/*
 * 【诊断（E84）】事件循环看门狗。
 *
 * 为什么需要：真机冷启动后 ~8s 起约 60s 内，宿主日志一个字节都不长（`host=` 恒定），
 * 所有线程停在 FUTEX/EVENTPOLL、进程 CPU 只涨 ~1.4% 单核。两种解释完全相反：
 *   (H1) JS 事件循环被某个同步操作挡住 —— loop 根本没转；
 *   (H2) loop 在转，只是没轮到 accept/响应（那问题就在别处，比如 WebView 侧）。
 * 每 1s 打一拍（只读 Date.now()，不碰任何业务路径）：
 *   相邻两拍间隔 >=1.5s → 记 `LOOP-GAP <ms>`（= 被挡住的时长）；
 *   每 20 拍 → 记 `LOOP-ALIVE 第 n 拍`（证明 loop 活着）。
 * 于是「停滞期有没有 LOOP-ALIVE」就是 H1/H2 的判决，无需再猜。
 */
/*
 * 【诊断（E91）】把「哪个 tid 是 Node 的 JS 线程」变成 shell 可直接读的事实。
 *
 * 真机停滞期我们只能看到一个十几到七十多个 tid 的线程表（`MainThread`/`.dshm.dshclient`
 * 都重复出现），无法确定哪个是 JS 主线程 ⇒ 「JS 线程此刻在 futex_wait（H1：被同步调用
 * 挡住）还是在 epoll_wait（H2：loop 在转）」这种判读做不了（真机上 /proc/<tid>/syscall 不可读）。
 *
 * `/proc/thread-self/stat` 的第 1 字段就是**当前线程**的 tid。启动时读一次：写进日志、并写
 * 到 DIAG_LOG 同目录的 `dsh-js-tid`。之后 shell 侧无需任何注入：
 *   tid=$(cat <files>/dsh-js-tid)
 *   cat /proc/<pid>/task/$tid/wchan ; cat /proc/<pid>/task/$tid/stat
 */
let dshmJsTid = '';
try {
  dshmJsTid = String(fs.readFileSync('/proc/thread-self/stat', 'utf8')).trim().split(' ')[0];
  if (/^\d+$/.test(dshmJsTid)) {
    const dshmTidFile = path.join(path.dirname(DIAG_LOG), 'dsh-js-tid');
    try { fs.writeFileSync(dshmTidFile, dshmJsTid + '\n'); } catch (e) { /* 写不进去不影响启动 */ }
    diag(`JS 线程 tid=${dshmJsTid}（已写 ${dshmTidFile}；停滞期读 /proc/${process.pid}/task/${dshmJsTid}/stat|wchan 判 H1/H2）`);
  } else {
    dshmJsTid = '';
    diag("JS 线程 tid 读取结果异常（非数字），已忽略");
  }
} catch (e) {
  dshmJsTid = '';
  diag(`JS 线程 tid 读取失败：${String(e)}`);
}

/*
 * 【诊断（E93）】心跳线程：用第二个 loop 把「JS 主线程被挡住」和「整个进程被冻住」分开。
 *
 * 停滞期我们观察到 0 accept、0 日志、进程 CPU 只涨 ~1.4% 单核。这既可能是
 *   (H1) 主线程被同步等待挡住（第二个 loop 照样在跑），
 * 也可能是 (B) 整个进程被平台冻结/节流（连第二个 loop 一起停）。
 * 两者都"没动静"，只有独立线程的心跳能区分。
 *
 * 做法：worker_threads 里每 1s 往 DIAG_LOG 同目录的 `dshm-hb.log` 追一行
 *   `HB <n> <epochMs> <iso> cpu=<进程 utime+stime ticks>`
 * 心跳线程自己的 appendFileSync 与主 loop 状态无关地落盘，于是拉一次日志就能看出：
 *   · 心跳连续、主线程静默 ⇒ H1（结合 SYNC-RING / js-tid 的 wchan 找那个同步调用）；
 *   · 心跳也断在同一段 ⇒ (B) 进程级冻结（不再是"谁挡住了 loop"的问题）。
 * `DSHM_HB=0` 关闭。worker 用 unref() 挂起，不参与主进程存活判定（排空后照样能自然退出）。
 */
try {
  if (process.env.DSHM_HB === '0') {
    diag('心跳线程已按 DSHM_HB=0 关闭');
  } else {
    const dshmHbFile = path.join(path.dirname(DIAG_LOG), 'dshm-hb.log');
    const dshmHbSrc = [
      "const fs = require('node:fs');",
      "const file = require('node:worker_threads').workerData.file;",
      "function cpuTicks() {",
      "  try {",
      "    const s = fs.readFileSync('/proc/self/stat', 'utf8');",
      "    const r = s.slice(s.lastIndexOf(')') + 2).split(' ');",
      "    return Number(r[11]) + Number(r[12]);",
      "  } catch (e) { return -1; }",
      "}",
      "let n = 0;",
      "try { fs.appendFileSync(file, '# 心跳线程启动 pid=' + process.pid + ' ' + new Date().toISOString() + ' cpu=' + cpuTicks() + '\\n'); } catch (e) {}",
      "setInterval(() => {",
      "  n += 1;",
      "  try { fs.appendFileSync(file, 'HB ' + n + ' ' + Date.now() + ' ' + new Date().toISOString() + ' cpu=' + cpuTicks() + '\\n'); } catch (e) {}",
      "}, 1000);",
    ].join('\n');
    const { Worker } = require('node:worker_threads');
    const dshmHbWorker = new Worker(dshmHbSrc, { eval: true, workerData: { file: dshmHbFile } });
    dshmHbWorker.on('error', (e) => { try { diag(`心跳线程错误：${String(e)}`); } catch (e2) { /* ignore */ } });
    dshmHbWorker.unref();
    diag(`心跳线程已启动（pid=${process.pid}；每 1s 写 ${dshmHbFile}；DSHM_HB=0 关闭）`);
  }
} catch (e) {
  diag(`心跳线程启动失败：${String(e)}`);
}

try {
  let dshmLastTick = Date.now();
  let dshmTickNo = 0;
  const dshmWatchdog = setInterval(() => {
    const now = Date.now();
    const gap = now - dshmLastTick;
    dshmLastTick = now;
    dshmTickNo += 1;
    if (gap >= 1500) {
      diag(`LOOP-GAP ${gap}ms（事件循环停顿；第 ${dshmTickNo} 拍；js-tid=${dshmJsTid || '?'}）`);
      dshmRingDump(`LOOP-GAP-${gap}ms`);
      if (gap >= 3000 && typeof dshmDumpProfile === 'function') {
        try { dshmDumpProfile('loop-gap'); } catch (e) { /* 采样落盘失败不影响主流程 */ }
      }
    } else if (dshmTickNo % 20 === 0) {
      diag(`LOOP-ALIVE 第 ${dshmTickNo} 拍`);
    }
  }, 1000);
  if (typeof dshmWatchdog.unref === 'function') { dshmWatchdog.unref(); }
  diag('事件循环看门狗已安装（1s 一拍；停顿 >=1.5s 记 LOOP-GAP，每 20 拍记 LOOP-ALIVE）');
} catch (e) {
  diag(`事件循环看门狗安装失败：${String(e)}`);
}

/*
 * 【关键】把"沙箱里的 .node"重定向到 HAP 的 libs/ 下加载。
 *
 * 问题（D6 E39，真机实测）：运行时解包到**沙箱**里的原生库，`dlopen` 会被系统拦：
 *   Error loading shared library …/cores/0.1.5-rc.2/node_modules/koffi/build/koffi/linux_arm64/koffi.node
 *   : No error information
 * 而放在 HAP `libs/` 里的库可以正常加载（E18 已证，即使没有 `.codesign`）。hvigor 又**只打包
 * 扁平的 `libs/<abi>/*.so`**（实测：嵌套的 `.node` 不会被复制进产物），所以没法按 loader 的
 * 候选路径原样摆放。
 *
 * 办法（不碰任何第三方包，也不改 dsh）：原生包的 loader 在 `require` 之前都会先
 * `fs.existsSync(候选路径)`，而真正加载 `.node` 一定经过 `Module._extensions['.node']`。
 * 于是同时接管这两处：
 *   - `existsSync` 对那些"沙箱里不存在、但 libs/ 里有同名平铺文件"的 .node 路径返回 true；
 *   - `.node` 扩展加载器把实际路径改写成 libs/ 下的平铺文件。
 * 这样 koffi / node-pty / sharp 的**原样查找逻辑**就能走到 HAP 里的合法位置。
 */
/*
 * 【2026-10-05 收尾审计：单一来源】本常量的**实现**原先与 `./jitless-env.cjs` 的
 * `resolveNativeLibsDir()` 各写一份（同样的 env 覆盖 + 同样的 `<bundle>/libs/arm64` 推导），
 * 两处一旦漂移就会出现"垫片按 A 找库、python 桥按 B 拼路径"这种隐性不一致（而它只在
 * 真机 `dlopen` 失败时才暴露）。现改为调用**同一份实现**。
 * `NATIVE_LIBS` 这个名字保留：下面 python 桥 / gitcompat / sharp 等 5 处仍用它拼 libs/ 路径。
 */
const NATIVE_LIBS = jitlessEnv.resolveNativeLibsDir(__dirname);

/*
 * 实现已抽到 ./jitless-env.cjs 的 `installNativeRedirect()`（同一份也装进 worker 线程：
 * 插件自建 worker 里 `require('…/pty.node')` 这类加载原先在 worker 里必然失败）。
 * 上面 NATIVE_LIBS 仍留在本文件——python 桥 / gitcompat / sharp 等别处要用它拼 libs/ 路径。
 */
jitlessEnv.installNativeRedirect({ libsDir: NATIVE_LIBS, log: diag });

/*
 * `node-addon-require-builtin` → 端侧 JS shim（配合 RuntimePort 的 --expose-internals）。
 *
 * 【为什么必须拦】0.1.6-alpha.2 起 host preparation 必经 internalModules()：
 *   dsh-app-boot/lib/index.js（installProfileResolution）、dsh-app-boot/lib/worker/
 *   profile-resolution-bootstrap.js、cordis-plugin-loader/lib/index.js 都
 *   `require("node-addon-require-builtin")`（Node-API addon，平台包只有
 *   darwin/linux-gnu/win32）。真机没有对应平台包，报
 *   `No usable native binding found for node-addon-require-builtin-openharmony-arm64 (auto)`，
 *   Host 起不来。实现见 ./require-builtin-shim.cjs（纯 JS，--expose-internals 下等价）。
 *
 * 【为什么拦 _load 而不是 _resolveFilename】app-boot 的 installProfileResolution
 * 会**替换** `Module._resolveFilename`（profile 路由，enforce/restore），拦同一函数
 * 容易被它卷进去；`_load` 不在其 patch 清单里，且 CJS require（含 createRequire）
 * 必经。树内该包的全部调用点都是 CJS require（已核对，无 ESM import）。
 */
jitlessEnv.installRequireBuiltinShim(diag);

/*
 * 内建 undici 拦截：Node **内部**直接 require 的那条路径（2026-10-05 端侧报告定位）。
 *
 * 【现象】开发者工具启用 `@deepseek-ai/dsh-experimental-inspector` 仍报
 * `1 entry did not activate` + `lazyllhttp … WebAssembly is not defined` —— 即使在
 * worker 注入已经生效之后。栈底是 undici 的 `lib/global.js`（**模块初始化**帧），
 * 说明触发者是"加载内建 undici"，而不是某次 fetch 调用。
 *
 * 【为什么】端侧 Node v24.2.0 的 `lib/internal/worker/io.js` 在**每条 MessagePort 消息
 * 投递**时都 `require('internal/deps/undici/undici').createFastMessageEvent`；该模块初始化
 * 即实例化 WASM 版 llhttp。inspector 的 Host 半身恰恰用 `new MessageChannel()`
 * 做 Host↔Worker 通信（lib/index.js:1805）⇒ 第一条消息就抛。
 * 同一模块还被 `globalThis` 上 `Headers/Request/Response/FormData/MessageEvent/
 * CloseEvent/WebSocket/EventSource` 的惰性 getter 引用。
 *
 * 【为什么前四个入口拦不到】它们都在 `globalThis` / 裸说明符 / `node:http` 模块对象
 * 这一层；而这里是 Node 内部**按完整路径**的 require。
 *
 * 【⚠️ 落点必须是 `BuiltinModule`，不是 `Module._load`】Node 内部模块走
 * `requireBuiltin()` → `BuiltinModule.prototype.compileForInternalLoader()`，
 * **完全不经过 `Module._load`**。2026-10-05 第一版就栽在这里：钩子挂在 `_load` 上，
 * 日志说"已安装"、故障一模一样。`installInternalUndiciShim()` 因此改成预置
 * `BuiltinModule.map.get(ID)` 的 `exports` 与 `loaded`；`Module._load` 那一路只作
 * userland 直接 require 的兜底。
 *
 * 【顺序是承重的：本调用必须早于下面的 installJitlessFetch()】后者要判断
 * `globalThis.Headers` 等惰性属性在不在，而**读属性描述符/读值这一步就会物化惰性
 * getter**（本机实测：读之前内建 undici 未加载、读之后已加载）。顺序颠倒时，
 * 一旦拦截没生效，物化抛错会被 fetch 垫片的 try/catch 吞掉 ⇒ `globalThis.fetch`
 * 完全不装 ⇒ 宿主连模型都调不了。
 */
jitlessEnv.installInternalUndiciShim(diag);

/*
 * jitless 下的 fetch 垫片（D6 E52）。
 *
 * 【为什么必须有】`--jitless` 隐含关掉 WASM，而 Node 自带 undici 用 WASM 版 llhttp
 * ⇒ 原生 fetch 在端侧不可用。我们既封了 `node:http` 的惰性 getter（E39），
 * 又在 WASM 不可用时由垫片**覆盖** globalThis.fetch（Node 24 起 fetch 转正、
 * `--no-experimental-fetch` 已不可用——传了会死在 CLI 解析，见 RuntimePort.ets 注释）。
 * 但 dsh **调模型就是用 fetch**（`dsh-llm-deepseek/lib/index.js:1770`）——
 * 不垫它，"Host 起来了"也只是个不能干活的空壳。
 * 垫片基于 `node:http`/`node:https`（原生 llhttp，与 WASM 无关），见 fetch-shim.js 的文件头。
 *
 * 只在原生 fetch 不可用（缺失，或 WASM 不可用即 jitless）时覆盖：
 * 本机调试（有 WASM）时用的仍是原生实现。
 */
jitlessEnv.installJitlessFetch(diag);

/*
 * jitless 下的 `undici` **模块名**解析钩子（与上面的 fetch 垫片是同一件事的另一半）。
 *
 * 【为什么光有垫片还不够】上面的垫片解决的是"全局 fetch 不可用"，但上游
 * `dsh-web-fetch-http` **不用全局 fetch**：它 `await import("undici")` 自建 Agent，
 * 再把 `dispatcher` 传进 fetch（lib/index.js:154 与 :193）。而 undici 的 HTTP 解析器
 * 是 WASM 版 llhttp（lib/llhttp/llhttp-wasm.js）⇒ jitless 下 `new Agent()` 一连接就抛
 * `fetch failed / cause: WebAssembly is not defined`。
 * 这正是"web_search 正常、web_fetch 打不开任何网页和 ip"的根因：前者走上面的垫片，
 * 后者走 undici。已用对照实验确认（同一核心树、同一个本地 HTTP 服务、只切换 --jitless）。
 *
 * 【怎么修】**运行期组合**，而不是改上游源码或改核心树：注册一个解析钩子，让
 * `import("undici")` 解析到本仓的 undici-shim.mjs。核心树一个字节都不动。
 * 钩子同时翻译 `dispatcher` → 我们垫片认识的 `lookup`，从而**保住上游的 DNS 钉住/
 * SSRF 防护**（它先解析出公开地址再钉住连接，见 fetch-shim.js 里 lookup 的注释）。
 *
 * 【注册条件】只在 WASM 不可用（jitless）时注册。原生 undici 可用时不该被替换——
 * 它的连接池与协议实现比垫片完整得多。
 *
 * 【已知未验项】`register()` 的钩子跑在 Node 的**独立线程**里；端侧嵌入式运行时是否
 * 允许起线程，属真机待验收项（docs/parity-matrix.md §3.2）。故失败时只降级、不阻断
 * 启动——web_fetch 坏掉不该拖垮整个 Host。
 */
jitlessEnv.installUndiciNameHook(diag);

/*
 * ── 把 jitless 补齐**注入每个 worker 线程**（插件自建 worker 的救命绳）──────
 *
 * 【真机证据（2026-10-04）】开发者工具里启用 `@deepseek-ai/dsh-experimental-inspector`
 * 报 `启用失败: dsh: warning: 1 entry did not activate`，栈是
 * `lazyllhttp … ReferenceError: WebAssembly is not defined`。
 *
 * 【根因】worker 是**新线程**：全新的 globalThis、全新的 module registry。上面这些
 * hook（以及 installJitlessFetch 对 `globalThis.fetch` 的覆盖）**一个都不过去**；
 * 而这个插件的 worker（lib/worker.js）第一行就是
 *   `import "@deepseek-ai/dsh-app-boot/worker/profile-resolution-bootstrap"`
 * （那个模块 `createRequire(...)("node-addon-require-builtin")`，在 worker 里就是真
 * addon），它自己又完全可能碰到原生 fetch / `node:http` 的惰性 undici getter。
 * 更糟的是上游起 worker 时**显式**写了 `execArgv: []`（lib/index.js:1904）——连
 * `--expose-internals` 都不会继承，所以 plug-in 侧的 worker 必然踩坑。
 *
 * 【为什么这里拦 Worker】worker 的创建点全在插件里（`new Worker(...)`），我们不碰
 * 核心树 ⇒ 只能在 `node:worker_threads` 这一层统一注入
 * `--expose-internals --require worker-bootstrap.cjs`（`--require` 保证早于 worker
 * 的任何 import）。包装同时做 `syncBuiltinESMExports()`：本插件用的是
 * **ESM** 具名导入 `import { Worker } from "node:worker_threads"`，只改 `require()`
 * 上的属性它看不见（已用对照实验确认）。
 */
jitlessEnv.wrapWorkerThreads({ preloadPath: path.join(__dirname, 'worker-bootstrap.cjs'), log: diag });

/*
 * ── `process.execPath` 兜底（2026-09-26 报告 3 ④）─────────────────────────
 *
 * 【现象】`@liustack/modlens` 等插件用 `spawn(process.execPath, …)` / `run(process.execPath, …)`
 * 想"重新拉起一个 node"，而端侧 `process.execPath` 就是 **`/system/bin/appspawn`**
 * （`/proc/<pid>/exe` 实证）⇒ 必然 `EACCES`（appspawn 不接受这种方式被拉起来）。
 * 这类失败信息对插件作者极不友好（一个裸 EACCES），对用户则是"功能静默不工作"。
 *
 * 【为什么在 child_process 层兜底】（报告建议 a+b，这里落 a）
 *   ① 覆盖**所有**插件，不必逐个改源码；
 *   ② 它拦截的是"本平台结构上不可能成立"的调用（端侧没有可复用的 node 可执行文件），
 *      拦下来给出**明确原因**比让插件拿到 appspawn 的 EACCES 有用得多。
 *
 * 【为什么只拦 `file === process.execPath`（精确匹配）】
 *   核心树里 `process.execPath` 多数用法是**读值**（拼 sidecar 路径、当 argv[0] 传），
 *   或在 `"pkg" in process` 分支里（端侧不成立）。真正会踩坑的只有"把它当可执行文件
 *   去 spawn"这一种。精确匹配保证：busybox/python 桥/PTY 等**已验证链路**一律不受影响
 *   （它们的 file 是各自真实路径，永远不等于 execPath）。
 *
 * 【失败形态】同步抛带 code='EPERM' 的错误（与 spawn 的同步抛错路径一致，调用方
 * try/catch 或 error 事件都能接住），message 里写明"嵌入式运行时禁止以 process.execPath
 * 启动子进程"，便于插件作者定位。可用 DSHM_ALLOW_EXECPATH_SPAWN=1 放行（调试用）。
 *
 * 【重启例外（2026-09-26 报告 4 ②）】dsh 的"重启"能力（`ctx.appExit`，市场里那个
 * 重启按钮）实现方式是 `spawn(process.execPath, ['-e', RELAUNCH_HELPER, …])`——
 * 用一个"等父进程退出再拉起新实例"的小助手。端侧这必然走不通（execPath=appspawn），
 * 但它**语义上是合法的"重启"意图**，不是插件乱拉 node。
 * 于是这里识别 relaunch 形态（`args[0] === '-e'` 且脚本里含 `waitForParent`），
 * 改走**本应用的整机冷启动通道**：写 host-restart-request → requestStop()，
 * 返回一个 stub child（提供 on/once/unref/kill/pid 这几个调用方会碰的成员），
 * 让上游以为"助手已起来"从而流程走完。其余 self-exe 调用照旧拒绝。
 */
let requestAppRestart = null; // 由 start() 内注册（那时才知道 HOME_DIR/requestStop）
(function installExecPathSpawnGuard() {
  if (process.env.DSHM_ALLOW_EXECPATH_SPAWN === '1') {
    diag('execPath spawn 兜底：已被 DSHM_ALLOW_EXECPATH_SPAWN=1 显式关闭（调试模式）');
    return;
  }
  try {
    const cp = require('node:child_process');
    const selfExe = process.execPath;
    /** 命中判据：file 就是 process.execPath（字符串相等）。 */
    const isSelf = (file) => typeof file === 'string' && file.length > 0 && file === selfExe;
    /**
     * 是否是"重启"意图：`spawn(process.execPath, ['-e', <脚本>, …])`。
     *
     * 【为什么判据从"脚本含 waitForParent"放宽到"只要 args[0] === '-e'"】
     * 原先只认 dsh 自己的 RELAUNCH_HELPER（脚本里含 `waitForParent`），于是**插件市场
     * 那个"重启"按钮被漏掉**：`dshmarket/lib/restart.js` 用的是另一个助手脚本
     * （`spawn(nodeExecutable(), ['-e', restartHelperSource(...)])`），文本里没有
     * `waitForParent` ⇒ 被判成"插件乱拉 node" → 拒绝 → **重启根本没发生**。
     * 真机后果（2026-09-25 报告）：装完 bundle 型插件（billion-context）后点重启，
     * 重启被拒 ⇒ 运行中的宿主里始终没有该 bundle，用户看到"插件装了但不生效"。
     *
     * 【为什么放宽是安全的】"以 `process.execPath` + `-e <内联脚本>` 启动子进程"在
     * **端侧没有任何合法用途**——`process.execPath` 是 `/system/bin/appspawn`，
     * 不是可复用的 node；上游真要用 node 解释器也是走 `--eval` / `--input-type=module`
     * 这类显式长选项（如 `dsh-web-app` 的浏览器打开器），而不是 `-e`。
     * 我已对整棵核心树核过一遍：**`execPath + '-e'` 的出现次数为 0**，
     * 而 `execPath + '--input-type=module'` 有（那些继续走拒绝）。
     * ⇒ 收到 `-e` 就当作"重启意图"既覆盖了两种助手，又不会误伤别的调用。
     *
     * `args[1]` 只要求是非空字符串（内联脚本文本）。不再看内容。
     */
    const isRestartHelper = (args) => Array.isArray(args)
      && args.length >= 2
      && args[0] === '-e'
      && typeof args[1] === 'string'
      && args[1].length > 0;
    /** 伪造的 ChildProcess：只实现上游会碰的成员，避免 TypeError。 */
    const stubChild = () => {
      const noop = () => stub;
      const stub = {
        pid: -1,
        on: noop,
        once: noop,
        off: noop,
        unref: noop,
        ref: noop,
        kill: () => true,
        removeListener: noop,
        stdout: null,
        stderr: null,
        stdio: [null, null, null],
      };
      return stub;
    };
    const refuse = () => {
      const err = new Error(
        '嵌入式运行时禁止以 process.execPath 启动子进程'
        + '（端侧 process.execPath 是 /system/bin/appspawn，不是可复用的 node）。'
        + '插件请改用 dsh 的 subprocess/shell 服务，或在进程内完成工作。',
      );
      err.code = 'EPERM';
      err.errno = -1;
      err.syscall = 'spawn';
      return err;
    };
    const wrap = (name) => {
      const orig = cp[name];
      if (typeof orig !== 'function') {
        return;
      }
      cp[name] = function guarded(file, args) {
        if (isSelf(file)) {
          // 【重启例外】先把意图交给整机冷启动通道；无通道（未注册）时退回拒绝。
          if (isRestartHelper(args) && typeof requestAppRestart === 'function') {
            diag(`execPath spawn 兜底：识别为重启助手（${name}），转入整机冷启动通道`);
            try {
              requestAppRestart('重启请求（execPath -e 助手）');
            } catch (e) {
              diag(`重启通道调用失败：${e && e.message}`);
            }
            return stubChild();
          }
          diag(`execPath spawn 兜底：已拦截 ${name}(process.execPath)（见 main.js 注释）`);
          throw refuse();
        }
        return orig.apply(this, arguments);
      };
    };
    for (const name of ['spawn', 'execFile', 'execFileSync', 'spawnSync']) {
      wrap(name);
    }
    diag('execPath spawn 兜底已安装：命中 process.execPath 时拒绝；-e 助手形态转入冷启动通道');
  } catch (e) {
    diag(`execPath spawn 兜底安装失败（不阻塞）：${e && e.message}`);
  }
})();

/*
 * 【诊断（E92）】同步调用环（SYNC-RING）：停滞期"哪个同步调用挡住了 loop"的直接读数。
 *
 * 现象（真机冷启动，~60s）：宿主一个字节日志都不写、TCP 只握手不 accept、CPU 只涨 ~1.4%
 * 单核、线程停在 FUTEX/EVENTPOLL。这最像 JS loop 被**同步**操作挡住，但一直拿不到"是哪一个"：
 * 真机 `/proc/<tid>/syscall` 不可读，`LOOP-GAP`（E84）只说停了多久、不说停在哪。
 *
 * 做法：内存环 + 零 I/O。包装同步 fs / child_process / Atomics 入口，进入时 push 一条
 * `{n,a,t0,ms:-1}`（环上限 24 条），返回时补 `ms`；单次 >=1s 立即 `diagSync` 一条
 * `SYNC-SLOW`（同步落盘，进程被杀也不丢）。挡住 loop 的那个调用 = 最后一条 `未返回`，
 * 或那条 `SYNC-SLOW` 行。包装是透传的，只记账，不改任何业务语义。
 */
const dshmSyncRing = [];
const dshmSyncSlowLog = [];
/* 【诊断（E94/E95）】单次 >=200ms 的同步调用另存一份 + 按名字累计次数/总耗时。
 * 环（dshmSyncRing）只留最后 24 条：一次巨型调用能被它和 SYNC-SLOW 抓住，但"一长串中等
 * 调用"会被便宜的尾巴挤出环外、且单次都不足 1s ⇒ 必须另开这两个账本记形状。 */
const dshmSyncWarnLog = [];
const dshmSyncStat = new Map();
let dshmSyncWarnLines = 0;
const DSHM_SYNC_WARN_MS = 200;
const DSHM_SYNC_WARN_LINES = 600;
function dshmSyncNote(name, ms, a) {
  try {
    const s = dshmSyncStat.get(name) || { n: 0, ms: 0 };
    s.n += 1;
    s.ms += ms;
    dshmSyncStat.set(name, s);
    if (ms >= DSHM_SYNC_WARN_MS) {
      dshmSyncWarnLog.push({ n: name, a: a, ms: ms });
      if (dshmSyncWarnLog.length > 24) { dshmSyncWarnLog.shift(); }
      if (dshmSyncWarnLines < DSHM_SYNC_WARN_LINES) {
        dshmSyncWarnLines += 1;
        try { diagSync(`SYNC-WARN ${ms}ms ${name} ${a}`); } catch (e) { /* ignore */ }
      }
    }
  } catch (e) { /* 记账失败不影响主流程 */ }
}
function dshmRingPush(entry) {
  dshmSyncRing.push(entry);
  if (dshmSyncRing.length > 24) { dshmSyncRing.shift(); }
}
function dshmRingDump(tag) {
  try {
    const now = Date.now();
    const tail = dshmSyncRing.slice(-12).map((e) =>
      `${e.ms < 0 ? "未返回" : e.ms + "ms"}（${now - e.t0}ms 前进入）${e.n} ${e.a}`).join(" ⏐ ");
    diag(`${tag} SYNC-RING ${tail}`);
    /* 单次 >=1s 的调用另存一份，不会被便宜调用挤出环外 —— 它就是"挡住 loop 的那一个"。 */
    if (dshmSyncSlowLog.length > 0) {
      const slows = dshmSyncSlowLog.map((e) => `${e.ms}ms ${e.n} ${e.a}`).join(" ⏐ ");
    diag(`${tag} SYNC-SLOW-LOG ${slows}`);
    }
    if (dshmSyncWarnLog.length > 0) {
      const warns = dshmSyncWarnLog.map((e) => `${e.ms}ms ${e.n} ${e.a}`).join(" ⏐ ");
      diag(`${tag} SYNC-WARN-LOG ≥${DSHM_SYNC_WARN_MS}ms 共 ${dshmSyncWarnLines} 次，环里最近 ${dshmSyncWarnLog.length} 条：${warns}`);
    }
    if (dshmSyncStat.size > 0) {
      let grand = 0;
      for (const s of dshmSyncStat.values()) { grand += s.ms; }
      const top = [...dshmSyncStat.entries()].sort((x, y) => y[1].ms - x[1].ms).slice(0, 12)
        .map(([n, s]) => `${n}×${s.n}=${s.ms}ms`).join(" ⏐ ");
      diag(`${tag} SYNC-COUNT 同步调用总耗时 ${grand}ms，按耗时 Top12：${top}`);
    }
  } catch (e) { /* 记账失败不影响主流程 */ }
}
try {
  const dshmRingShort = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
  const dshmTrack = (name, fn) => function (...args) {
    const t0 = Date.now();
    let arg = "";
    try {
      const p = args[0];
      arg = typeof p === "string" ? p : (p && p.path ? String(p.path) : (p == null ? "" : String(p)));
    } catch (e) { /* ignore */ }
    const entry = { n: name, a: dshmRingShort(arg, 96), t0, ms: -1 };
    dshmRingPush(entry);
    try {
      return fn.apply(this, args);
    } finally {
      entry.ms = Date.now() - t0;
      dshmSyncNote(name, entry.ms, entry.a);
      if (entry.ms >= 1000) {
        try { diagSync(`SYNC-SLOW ${entry.ms}ms ${name} ${entry.a}`); } catch (e) { /* ignore */ }
        dshmSyncSlowLog.push({ n: name, a: entry.a, ms: entry.ms });
        if (dshmSyncSlowLog.length > 8) { dshmSyncSlowLog.shift(); }
      }
    }
  };
  const dshmSyncFs = ["existsSync", "statSync", "lstatSync", "readdirSync", "readFileSync",
    "realpathSync", "readlinkSync", "accessSync", "openSync", "readSync", "writeSync",
    "mkdirSync", "rmSync", "renameSync", "unlinkSync", "copyFileSync"];
  for (const name of dshmSyncFs) {
    const orig = fs[name];
    if (typeof orig !== "function") { continue; }
    try { fs[name] = dshmTrack(name, orig); } catch (e) { /* 只读属性就跳过 */ }
  }
  const dshmSyncCp = require("node:child_process");
  for (const name of ["spawnSync", "execFileSync", "execSync"]) {
    const orig = dshmSyncCp[name];
    if (typeof orig !== "function") { continue; }
    try {
      Object.defineProperty(dshmSyncCp, name, { configurable: true, enumerable: true, writable: true, value: dshmTrack(name, orig) });
    } catch (e) { /* ignore */ }
  }
  try {
    const dshmWait = Atomics.wait;
    Atomics.wait = function (...args) {
      const t0 = Date.now();
      const entry = { n: "Atomics.wait", a: String(args[3] == null ? "" : args[3]), t0, ms: -1 };
      dshmRingPush(entry);
      try { return dshmWait.apply(Atomics, args); } finally {
        entry.ms = Date.now() - t0;
        dshmSyncNote("Atomics.wait", entry.ms, entry.a);
        if (entry.ms >= 1000) {
          try { diagSync(`SYNC-SLOW ${entry.ms}ms Atomics.wait ${entry.a}`); } catch (e) { /* ignore */ }
          dshmSyncSlowLog.push({ n: "Atomics.wait", a: entry.a, ms: entry.ms });
          if (dshmSyncSlowLog.length > 8) { dshmSyncSlowLog.shift(); }
        }
      }
    };
  } catch (e) { /* ignore */ }
diag("同步调用环已安装（进入即记账；单次 >=200ms 记 SYNC-WARN、>=1s 记 SYNC-SLOW；停顿后随 LOOP-GAP 打 SYNC-RING/SYNC-WARN-LOG/SYNC-COUNT）");
} catch (e) {
  diag(`同步调用环安装失败（不阻塞）：${e && e.message}`);
}

/** 读我们自己的 state.json，得到"当前版本"，据此拼出核心树目录。 */
function currentCoreDir() {
  if (DSH_BASE.length === 0) {
    return '';
  }
  try {
    const statePath = path.join(DSH_BASE, 'state.json');
    if (!fs.existsSync(statePath)) {
      return '';
    }
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (typeof state.current !== 'string' || state.current.length === 0) {
      return '';
    }
    return path.join(DSH_BASE, 'cores', state.current);
  } catch (e) {
    return '';
  }
}

const CORE_DIR = process.env.DSHM_CORE_DIR || currentCoreDir();
const HOME_DIR = process.env.DSHM_HOME || (DSH_BASE.length > 0 ? path.join(DSH_BASE, 'home') : '');
const SANDBOX_HOME = process.env.DSHM_SANDBOX_HOME || USER_DATA || HOME_DIR;
const PORT = process.env.DSHM_PORT || '3120';
const PROFILE = process.env.DSHM_PROFILE || 'ondevice';

function log(msg) {
  // 统一前缀，便于 ArkTS / 诊断页从日志里认出我们的行
  console.log('[dshm-host] ' + msg);
  /*
   * 【诊断（E88）】镜像一份进 `dshm-host.log`。
   *
   * 原来 `log()` 只走 stdout ⇒ 只有 `node-output.log` 有，而它**每次冷启动被截断**；
   * 于是「停止请求/应用重启请求」这种恰好在进程结束前一瞬的行，事后拉回的文件里永远看不到
   * （三次「干净退出」的成因就是这样失去读数的）。用 `diagSync` 而不是 `diag`：
   * 这几行常常就是进程的最后输出，缓冲写会丢。
   */
  try { diagSync('[dshm-host] ' + msg); } catch (e) { /* ignore */ }
}

/**
 * 阻止 Electron 的"无窗口即退出"默认行为。
 *
 * 【为什么必须有这一段】Electron 的语义是：若**没有订阅** `window-all-closed`，
 * 且所有窗口都关闭，则默认 **quit**。我们是一个**永不建窗**的 Node 宿主
 * （D6 §4.1.2：只跑 Node，不 new BrowserWindow），所以在它眼里"所有窗口都已关闭"，
 * 于是启动后立刻退出。真机实测到的正是这个：
 *   `APPSPAWN: Unexpected call: exit(1)`  —— 应用进程被自己的运行时结束掉。
 * 订阅一个空监听即可跳过默认行为（Electron 文档明示：订阅了就不执行默认动作）。
 */
function keepAliveWithoutWindows() {
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.on === 'function') {
      electron.app.on('window-all-closed', () => {
        log('window-all-closed：按无窗口宿主语义保持存活（不退出）');
      });
      log('已注册 window-all-closed 保活监听');
    }
  } catch (e) {
    log('注册保活监听失败（非 Electron 环境？）：' + e.message);
  }
}

keepAliveWithoutWindows();

/*
 * ── 启动阶段标记（BOOT_xx）────────────────────────────────────────────────
 *
 * 【为什么需要】端侧只有 hilog 可看（应用进程的 stdout 在设备上不可见，D6 E23；
 * 我们把 stdout 重定向到文件再 tail 到 hilog，见 dshhost.cc），而"Host 没起来"
 * 这类问题最贵的成本就是**猜停在哪一步**。所以把启动过程切成显式阶段：
 * 成功的最后一段 + 失败的第一段，本身就是结论。
 *
 * 阶段序列（顺序即因果）：
 *   BOOT_00_NODE_START   入口脚本开始执行（能读到它就说明 libnode + node::Start 成立）
 *   BOOT_10_ENV_READY    环境/路径已解析（打出实际取值，便于核对是否指向错目录）
 *   BOOT_20_CORE_FOUND   核心树与 dsh CLI 入口都在
 *   BOOT_30_PROFILE_READY 端侧 profile 已就位（bundle 列表 + patch 层）
 *   BOOT_40_PROFILE_BOOT 即将 runProfile（插件树从这里开始挂载）
 *   BOOT_50_DSH_INIT     runProfile 返回且拿到 ctx
 *   BOOT_60_HTTP_BIND    ctx.webServer 存在（dsh 已绑定端口）
 *   BOOT_70_HTTP_READY   我们自探一次 HTTP，确认端口**真的应答**（不是"应该应答"）
 *   BOOT_ERR             失败：带上最后一个成功阶段 + 原因
 */
const BOOT_T0 = Date.now();
let bootStage = 'BOOT_00_NODE_START';
function stage(name, extra) {
  bootStage = name;
  const suffix = extra === undefined || extra === '' ? '' : ' ' + extra;
  console.log(`[dshm-host] ${name}${suffix} (+${Date.now() - BOOT_T0}ms)`);
}
stage('BOOT_00_NODE_START',
  `pid=${process.pid} node=${process.version} platform=${process.platform}/${process.arch} jitless=${process.execArgv.includes('--jitless')}`);

/**
 * 捕获 dsh 打印的 **authenticatedUrl**，并落盘成 `host-ready.json` 供 ArkTS 侧接入。
 *
 * 【为什么必须抓它】dsh 的"认证"不是可以关掉的开关，而是 `/api` 的 **browser-trust fence**：
 * 入口脚本探 `GET /` 得到 401 是**正确**响应，但那意味着**客户端拿不到 token 就只能一直 401**，
 * 会话 UI 根本驱动不起来。token 只出现在 dsh 打印的这一行里（真机读数，D6 E54）：
 *     dsh web: http://127.0.0.1:3120/?token=QMHMWOSL…
 * 而 `libdshhost` 没有"读走 Node 输出"的 API（只有 runtimeVersion/startHost/isHostRunning/stopHost）
 * ⇒ 通道只能是**文件**：这里写，ArkTS 侧读（EntryAbility.adoptLocalHost）。
 *
 * 【为什么在 stdout 上做拦截而不是改 dsh】对上游零 patch 是本项目的纪律；
 * 而且 dsh 的这一行本来就是为"把 URL 交给用户"设计的（`if (config.printUrl) console.log(...)`）。
 * 拦截只做一次匹配、立刻恢复原来的 write，不改变任何输出内容。
 */
function watchdogAuthUrl() {
  const original = process.stdout.write.bind(process.stdout);
  let buffer = '';
  let done = false;
  process.stdout.write = function patchedWrite(chunk, encoding, callback) {
    try {
      if (!done) {
        buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        // 只留尾部：dsh 启动期输出量不小，别让 buffer 无限涨
        if (buffer.length > 65536) {
          buffer = buffer.slice(-32768);
        }
        const matched = buffer.match(/dsh web:\s*(https?:\/\/\S+)/);
        if (matched !== null) {
          done = true;
          writeHostReady(matched[1]);
        }
      }
    } catch (e) {
      // 抓不到也不能影响 Host 本身：这一段的失败只是一条诊断信息缺失
    }
    return original(chunk, encoding, callback);
  };
  return function restore() {
    process.stdout.write = original;
  };
}

/**
 * 运行时的**真实事实**（E88）：把核心页上那几项"未探测"变成实测值。
 *
 * 【为什么由入口脚本提供，而不是 ArkTS 侧自己猜】
 * 这些都是**只有宿主进程内部才知道**的事实：Node 版本、`process.platform/arch`、
 * 是否真的跑在 jitless 下、`node:zlib` 有没有 zstd、以及三个硬原生依赖到底能不能加载。
 * ArkTS 侧（`libdshhost`）只有 `runtimeVersion/startHost/isHostRunning/stopHost` 四个 API，
 * 拿不到这些；而"猜"正是本项目一直在拆的坑（`未探测` 比一个可能错的数字诚实）。
 * 入口脚本本来就要写 `host-ready.json`（token 的主通道），顺手把这几个事实一起落盘。
 *
 * 【zstd 为什么要单独探】会话持久化（`session.v3.jsonl.zstd`）依赖它；实测 Node 22.22
 * 默认就有 `zlib.zstdCompressSync`（`--experimental-zstd` 在这个版本上反而是**非法选项**），
 * 所以这一项在本项目里预期恒为 true——但**探一次**比假定它成立强：换 libnode 版本时
 * 这一行会立刻给出结论。
 */
let RUNTIME_FACTS_CACHE = null;
function runtimeFacts() {
  if (RUNTIME_FACTS_CACHE !== null) {
    return RUNTIME_FACTS_CACHE;
  }
  const facts = {
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    jitless: process.execArgv.includes('--jitless'),
    zstd: false,
    listenAddress: `127.0.0.1:${PORT}`,
    natives: [],
  };
  try {
    const zlib = require('node:zlib');
    facts.zstd = typeof zlib.zstdCompressSync === 'function';
  } catch (e) {
    facts.zstd = false;
  }
  /*
   * 三个硬原生依赖：**当场 require 一次**并把结论（含失败原因）带上。
   * 这比在 UI 上写"未探测"有用得多：装错平台 / DT_NEEDED 不对 / 少拷了 .so，
   * 都会在这里留下人话，而不用等到某个功能被使用时才炸。
   */
  const probes = [
    ['koffi', 'koffi'],
    ['sharp', 'sharp'],
    ['node-pty', 'node-pty'],
  ];
  for (const [label, mod] of probes) {
    try {
      const loaded = require(path.join(CORE_DIR, 'node_modules', mod));
      let note = '';
      let ok = loaded !== undefined;
      if (mod === 'sharp') {
        /*
         * sharp 有两层，"require 成功"根本不能证明它可用：
         *   ① 我们放的是**调度器**（E93）：它 require 成功只说明调度器在；
         *   ② 真件 `sharp.impl` 的原生绑定是**惰性加载**的——实测在 Windows 上
         *      `require('sharp.impl')` 同样成功，直到真正处理图片才会炸。
         * 所以要探就探**原生绑定本身**：那一次 dlopen 才是"这台设备上能不能用"的事实。
         * 路径正是 sharp 会去找的那个（我们的原生重定向会把它映射到 HAP libs 里）。
         */
        try {
          require(path.join(CORE_DIR, 'node_modules', '@ohos-ports',
            'img-sharp-openharmony-arm64', 'lib', 'sharp-openharmony-arm64.node'));
          ok = true;
          note = '真件原生绑定可加载（libvips 全套随包，图片附件可用）';
        } catch (e) {
          ok = false;
          const message = e && e.message ? String(e.message) : String(e);
          note = `真件原生绑定加载失败，图片附件已降级：${message.slice(0, 160)}`;
        }
      }
      facts.natives.push({ name: label, ok: ok, note: note });
    } catch (e) {
      facts.natives.push({
        name: label,
        ok: false,
        note: (e && e.message ? String(e.message) : String(e)).slice(0, 200),
      });
    }
  }
  // ── ACL 权限专项探针（ohos.permission.ALLOW_EXTERNAL_NATIVE_CODE 生效性实测）──
  // E39 之前的结论是"沙箱解包出来的 .node，dlopen 被系统拦"——整个 HAP libs
  // 重定向体系都是为绕它而生。若 ACL 权限真的生效，这里应该出现以下之一：
  //   ① dlopen 成功（闭包都齐了）→ 沙箱 .node 直接可用，重定向变冗余兜底；
  //   ② 报 napi 符号找不到（E44 模式）→ noexec 拦截已解除，只差 NEEDED 闭包；
  //   ③ 报 not accessible / operation not permitted → 权限没生效（E39 原样）。
  // 直连 process.dlopen，绕开本文件的 require hook，测的就是"系统层"。
  try {
    const probeMod = { exports: {} };
    process.dlopen(probeMod, path.join(CORE_DIR, 'node_modules', 'node-pty',
      'prebuilds', 'openharmony-arm64', 'pty.node'));
    facts.natives.push({
      name: 'sandbox-dlopen',
      ok: true,
      note: '沙箱 .node 可直接 dlopen（E39 拦截已解除；HAP libs 重定向成冗余兜底）',
    });
  } catch (e) {
    const message = e && e.message ? String(e.message) : String(e);
    const noexecLifted = /symbol|relocat/i.test(message);
    facts.natives.push({
      name: 'sandbox-dlopen',
      ok: false,
      note: (noexecLifted
        ? `noexec 已解除但闭包缺（E44 模式，符合预期）：${message.slice(0, 140)}`
        : `仍被系统拦（E39 原样，权限未生效）：${message.slice(0, 140)}`),
    });
  }
  // E15 之前的结论是"平台级进程创建限制"。ALLOW_EXTERNAL_NATIVE_CODE 声称
  // 允许"运行外部 Native 二进制代码（含 bin）"——node-pty 的完整链正是试金石：
  // pty.spawn = fork + execve(spawn-helper) + 子进程 exec(/system/bin/sh)。
  // 只测"调用是否同步抛错"（fork/exec 被拦会当场 throw），不等输出——
  // runtimeFacts 在引导关键路径上，不能阻塞。
  try {
    const pty = require(path.join(CORE_DIR, 'node_modules', 'node-pty'));
    const term = pty.spawn('/system/bin/sh', ['-c', 'echo DSHM_PTY_OK'],
      { name: 'xterm-256color', cols: 80, rows: 24, cwd: HOME_DIR, env: {} });
    const note = `fork+exec 全链通过（pid=${term.pid}）——E15 进程创建解锁，终端链可用`;
    try { term.kill(); } catch { /* 子进程可能已自行退出 */ }
    facts.natives.push({ name: 'pty-spawn', ok: true, note: note });
  } catch (e) {
    facts.natives.push({
      name: 'pty-spawn',
      ok: false,
      note: `进程创建仍被拦（E15 原样）：${(e && e.message ? String(e.message) : String(e)).slice(0, 140)}`,
    });
  }
  // ── fork-errno / child-proc 探针：已移除（2026-09-21 真机结论）──
  // 这两个探针在真机上把 Host 进程直接打崩（AnalyticsKit 两次 cppcrash 记录：
  // 23:22 与 00:03，均为 koffi 直调 libc fork() 后进程死亡）。appspawn 侧日志可见
  // `SetForkDenied success, cgroup's owner:<pid>`——鸿蒙对应用进程的 fork 有
  // cgroup 级管控：fork() 不只是返回 -1（EPERM/ENOSYS），而是触发 native crash。
  // 结论已足够：E15 的"进程创建被拦"比预想更硬，fork 层没有任何可用出路，
  // node:child_process 依赖同一 fork 路径，也一并不再探测。探针保留 = 每次启动必崩，
  // 会掩盖一切其他验证（权限、目录桥、插件回归），故整体移除。
  // 缓存：这三个 require 是**一次性的重活**，而 `runtimeFacts()` 会在
  // "拦截 stdout 写"的路径上被调用——那条路径上绝不能每次都重新加载原生件。
  RUNTIME_FACTS_CACHE = facts;
  return facts;
}
/** 把 authenticatedUrl 拆成 baseUrl + token，写 `<HOME_DIR>/host-ready.json`。 */
function writeHostReady(authUrl) {
  try {
    const parsed = new URL(authUrl);
    const token = parsed.searchParams.get('token') || '';
    const facts = runtimeFacts();
    const payload = {
      url: authUrl,
      baseUrl: `${parsed.protocol}//${parsed.host}`,
      token: token,
      port: Number(parsed.port),
      profile: PROFILE,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      // E98：客户端建会话时要显式带上它（默认工作区不能是 `/`）
      workspace: WORKSPACE_DIR,
      // E88：给核心页的"运行时事实"提供数据源（全部实测，没有一个默认值）
      runtime: {
        nodeVersion: facts.nodeVersion,
        platform: facts.platform,
        jitless: facts.jitless,
        zstd: facts.zstd,
        listenAddress: facts.listenAddress,
        natives: facts.natives,
      },
    };
    fs.writeFileSync(path.join(HOME_DIR, 'host-ready.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8');
    stage('BOOT_65_AUTH_URL', `port=${payload.port} tokenLen=${token.length} → host-ready.json`
      + ` node=${facts.nodeVersion} zstd=${facts.zstd} jitless=${facts.jitless}`);
  } catch (e) {
    console.error('[dshm-host] 写 host-ready.json 失败：' + (e && e.message));
  }
}

/** 读回 `host-ready.json` 里的 authenticatedUrl（没抓到就是空串，不抛）。 */
function readHostReadyUrl() {
  try {
    const p = path.join(HOME_DIR, 'host-ready.json');
    if (!fs.existsSync(p)) {
      return '';
    }
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return typeof parsed.url === 'string' ? parsed.url : '';
  } catch (e) {
    return '';
  }
}

/** 读回 `host-ready.json` 里的 token（python 桥端点鉴权源；没写到就是空串）。 */
function readHostToken() {
  try {
    const p = path.join(HOME_DIR, 'host-ready.json');
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return typeof parsed.token === 'string' ? parsed.token : '';
  } catch (e) {
    return '';
  }
}

function fail(msg) {
  // 【绝不能调 process.exit()】libelectron.so 是**同进程**跑的：
  // 这里的 exit 会连同宿主 ArkUI 应用一起杀掉。
  // 真机实测症状：启动后窗口被销毁、进程消失、hilog 里既没有 JS 异常也没有崩溃记录——
  // 看起来像"莫名其妙退出"，实际是我们自己把进程结束了。
  // 正确做法：把原因打出来、把失败状态留在全局，让进程活着（上层/诊断页据此如实展示）。
  console.error(`[dshm-host] BOOT_ERR after=${bootStage} reason=${msg}`);
  globalThis.__dshmHostError = `${msg}（停在 ${bootStage}）`;
  // 【启动失败标记（D27 死锁自愈）】下次启动在拼用户插件行之前发现此标记，
  // 会把 .dshm-plugin-rows.yml 隔离改名（保数据不删）——兜住"文件都在但
  // import 崩"这类预检拦不住的死锁。事故背景见 dshm-user-rows.js 头注释。
  userRows.writeBootFailMarker(HOME_DIR, bootStage, msg);
  throw new Error('DSHM host fatal: ' + msg);
}

// 【为什么这里不校验、也不 throw】顶层抛异常同样会掀掉整个宿主应用
// （这些行在 process.on('uncaughtException') 注册之前执行）。
// 校验一律放进被 .catch() 包住的 start() 里。
function reportConfigError() {
  const missing = [];
  if (CORE_DIR.length === 0) {
    missing.push('DSHM_CORE_DIR（当前版本的核心树目录）');
  }
  if (HOME_DIR.length === 0) {
    missing.push('DSHM_HOME（$DSH_HOME，跨版本共享的用户数据目录）');
  }
  return missing;
}

// ── 1. 沙箱 HOME ────────────────────────────────────────────────────────
// dsh 的目录选择器以 os.homedir() 为起点；鸿蒙下它指向沙箱外目录（EPERM）。
// 必须在任何 dsh 代码调用 homedir() 之前设置。
/*
 * 【必须在覆盖 HOME 之前把"原始 HOME"留一份】
 *
 * 真机探针读数：应用进程**原始** HOME = `/storage/Users/currentUser`（用户可见
 * 公共目录的根），而下面这一行必须把它改成**沙箱** HOME（dsh 的 os.homedir() 要它）。
 * 默认工作区最终要落在用户可见的 `Download/<包名>/`，这个值只用于 diag 一行
 * （排查时"原始 HOME 是什么"决定了路径该长什么样）；错过了这一行，后面读到的 HOME
 * 永远是沙箱，`$HOME/Download/...` 会解析成 `<sandbox>/Download/...` 这种
 * **看起来对、实际错**的路径，而 diag 里再也看不出来。
 * （本机复现：不抄这一份时 `host-ready.json` 的 workspace 是
 *  `…/probe-remove-sandbox/Download/com.dshm.dshclient`。）
 */
const ORIGINAL_HOME = (process.env.HOME || '').trim();
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;
process.env.DSH_HOME = HOME_DIR;
// 端侧不需要的开关：HMR 的文件监听在沙箱里不可靠，显式禁用（它依赖的
// --expose-internals 本身已开——现在是为 profile resolution 服务，见
// RuntimePort.buildHostArgv 与上面的 installRequireBuiltinShim）；遥测默认关。
process.env.DSH_DISABLE_HMR = '1';
process.env.DSH_TELEMETRY_DISABLED = '1';

/*
 * ── 临时目录与代理例外（E84）─────────────────────────────────────────────
 *
 * 【临时目录为什么必须钉死在沙箱内】鸿蒙下 `os.homedir()` 会指向沙箱外目录（EPERM），
 * `os.tmpdir()` 是**同一类**探测。而 dsh 里真的有人用它：
 *   - `dsh-spill-local`（大工具输出落盘）
 *   - `dsh-workflow-worker-thread` / `dsh-code-runtime-worker-thread`
 * 一旦它解析到沙箱外，这些路径的失败会以"随机某个功能不好用"的形态出现，
 * 而不是一条清晰的启动错误。dsh 自己在 Node 侧看这三个变量，所以设在这里就够。
 *
 * 【NO_PROXY 为什么也要设】回环上的所有流量（HTTP RPC + WS mux）都不该经过任何代理；
 * 开发机或设备若配了系统代理，`127.0.0.1` 被代理走会表现成"端口通了但连不上"。
 * 这是**防御性**设置：没有代理时它没有任何作用。
 */
if (SANDBOX_HOME.length > 0) {
  const tmpDir = path.join(SANDBOX_HOME, 'tmp');
  ensureDir(tmpDir);
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
    if (!process.env[key] || process.env[key].length === 0) {
      process.env[key] = tmpDir;
    }
  }
}

/**
 * 沙箱工作区（E98）：**默认工作区必须是一个可写目录**。
 *
 * 【真机证据】设备上建出来的会话，`session/list` 里 `"cwd":"/"` —— 因为宿主进程的工作目录
 * 继承自应用进程（`/`）。后果不是"路径难看"，而是**功能性故障**：
 *   · `session/follow` 在折叠工作区相关投影时抛
 *     `gateway/internal Cannot read properties of undefined (reading 'kind')`
 *     （用户看到的就是「轨迹流失败」横幅）；
 *   · `workspaceFiles/list` 在 `/` 上必然失败（`cannot list`）。
 * 开发机上一直没暴露，是因为我们本地跑时 cwd 恰好是仓库根（一个可读可写目录）——
 * 这正是"开发机跑通、设备上才炸"的典型形态。
 *
 * 【为什么不 `process.chdir()`】Node 里 `process.chdir` 走的是 POSIX `chdir`，
 * 在我们这种"Node 跑在应用进程的一个线程里"的形态下它会改**整个进程**的 cwd，
 * 影响 ArkUI/其它线程。所以不碰 cwd，改为**把这个可写目录作为默认工作区传下去**，
 * 由客户端在建会话时显式指定（`session/create` 的 `cwd`）。
 *
 * ── 默认工作区 = "用户可见的 Download/<包名>/" ──────────────────────────────
 * 目标是让 agent 的产物落在**用户能在文件管理器里看见**的地方，而不是应用沙箱内部。
 * 端侧事实（真机探针读数）：
 *   · 应用进程**原始** HOME = `/storage/Users/currentUser`（注意：不是 `process.env.HOME`
 *     在**本文件执行到这一行时**的值——它早在上面那段就被改成了沙箱 HOME，
 *     所以 diag 里用的是那里抄下来的 `ORIGINAL_HOME`）；
 *   · `Download/<包名>/` = `/storage/Users/currentUser/Download/com.dshm.dshclient`，
 *     该目录**写/读/删全通且不需要任何 ACL**（`DocumentPickerMode.DOWNLOAD` 的
 *     `save()` 建立的是**按包名归属的路径级授权**，卸载重装后同包名仍可直接访问）；
 *   · 但这条授权**只能由 ArkTS 侧经 picker 取得**：应用进程自己直拼路径 `mkdir`
 *     公共目录**必 EPERM**（真机 hilog 原文见 `resolveWorkspaceDir()` 的头注）。
 *
 * 【通道：env，只有一条】认领结果由 ArkTS 在 **spawn 之前**写进 env
 * （`DSHM_PUBLIC_DOWNLOAD`，见 `hostruntime` 的 `buildHostEnv()` 与 `NodeRuntime` 的
 * `claimPublicDownload()`）。env 是 spawn 时定死的 ⇒ 天然无竞态；选它而不是"启动后读
 * 一个状态文件"，是因为 Host 在**启动最早期**就要算出默认工作区，读文件会引入
 * "文件还没写/还是上一轮的"这类时间窗，而这类错误的表现是**静默指向错的目录**。
 * 【为什么不另传包名】曾经并传 `DSHM_BUNDLE`，让本文件自己拼 `$ORIGINAL_HOME/Download/<包名>`
 * 再 mkdir —— 端侧实测必 EPERM（应用进程直拼公共路径建目录不被放行），已整条删除。
 * 包名作为**路径来源**只会指向一个不存在、也建不出来的目录；现在它只出现在 ArkTS 的
 * 一行诊断日志里，本文件需要包名时从 `DSHM_PUBLIC_DOWNLOAD` 的末段反推。
 *
 * 【安全回退（必须有）】认领失败、或认领到的路径 `lstat` 不是目录/探写不过时，
 * 一律回退 `<SANDBOX_HOME>/workspace`。绝不允许出现 cwd = `/` 或不可写目录
 * （E98 教训：cwd=`/` 会让 `session/follow` 抛 `…reading 'kind'`、
 * `workspaceFiles/list` 报 cannot list）。
 * 每个分支的**最终路径 + 理由 + 原始 HOME**都写进 diag，端侧可复核。
 *
 * 【为什么"实测探写"而不是查权限】hmfs 的 stat/access 会撒谎（docs/70 §2.1
 * 「对占位全部返回成功且 mode=0777」）；`probePathWritable()` 的注释（FilePicker.ets）
 * 已经记录了同一结论。故这里做一次 lstat + create+write+unlink。
 */
const WORKSPACE_DIR = resolveWorkspaceDir();

/** 探写判据：create+write+unlink 全部成功才算"这个目录真能当工作区"。 */
function workspaceProbeWritable(dir) {
  if (dir.length === 0) {
    return false;
  }
  const probe = path.join(dir, '.dshm-workspace-probe');
  let fd = null;
  try {
    fd = fs.openSync(probe, 'w');
    fs.writeSync(fd, 'ok');
    fs.closeSync(fd);
    fd = null;
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    diag(`工作区探写失败（按不可写处理）：${dir} : ${e && e.message}`);
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (e) { /* 关闭失败不影响判据 */ }
    }
    try { fs.unlinkSync(probe); } catch (e) { /* 可能已删掉 */ }
  }
}

/**
 * 解析默认工作区：**消费 + 验证** ArkTS 认领到的公共目录，否则回退 `<SANDBOX_HOME>/workspace`。
 *
 * ── 本函数**不建立**任何公共目录，只验证 ──────────────────────────────────────
 * 应用进程按 `$ORIGINAL_HOME/Download/<包名>` 直拼路径并 `fs.mkdirSync(..., {recursive:true})`
 * 在端侧**必 EPERM**（真机 hilog 原文）：
 *     `默认工作区：mkdir /storage/Users/currentUser/Download/com.dshm.dshclient 失败（EPERM…）`
 *     `默认工作区：所有 Download 候选都不可用 ⇒ 回退 …/files/workspace`
 * 已定性：应用进程**直拼路径建公共目录**不被放行；该目录只能经
 * `DocumentPickerMode.DOWNLOAD` 的 `save()`（ArkTS 侧、无 UI）建立归属。
 * ⇒ "建立"整件事在 ArkTS（`platform` 的 `claimPublicDownloadFolder()`），
 *   Host 只做两件**只读 + 探写**的事：① `lstat` 判它是目录；② `create+write+unlink`
 *   实测可写。两条都过才采用。
 *
 * ── 顺序（唯一一条）──────────────────────────────────────────────────────────
 *   ① `DSHM_PUBLIC_DOWNLOAD` 非空 ⇒ lstat 是目录 **且** 探写通过 ⇒ 采用它；
 *   ② 否则**直接**回退 `<SANDBOX_HOME>/workspace`（在那里 mkdir：那是沙箱，本来就该建）。
 * 任何情况下都**绝不**返回 `/`、相对路径或"看起来像路径的空串"；`SANDBOX_HOME` 也为空
 * （异常装配）时返回 `''`（宿主用自己的 cwd），并把这一事实记进 diag。
 *
 * ── diag ────────────────────────────────────────────────────────────────────
 * 每个分支都打出**最终选定的路径 + 选择理由 + 原始 HOME**，端侧一条 grep 即可复核。
 *
 * @returns 可用工作区的绝对路径；只有 `SANDBOX_HOME` 也为空时才返回 `''`。
 */
function resolveWorkspaceDir() {
  const fallback = SANDBOX_HOME.length > 0 ? path.join(SANDBOX_HOME, 'workspace') : '';
  const claimed = (process.env.DSHM_PUBLIC_DOWNLOAD || '').trim();
  const reasons = [];
  if (claimed.length === 0) {
    reasons.push('DSHM_PUBLIC_DOWNLOAD 为空（ArkTS 侧 claimPublicDownloadFolder() 本次没认领到）');
  } else {
    // ① 必须是**目录**：lstat（不跟随末段链接），避免一个指向别处的链接冒充目录。
    let isDir = false;
    let why = '';
    try {
      isDir = fs.lstatSync(claimed).isDirectory();
      if (!isDir) {
        why = 'lstat 显示它不是目录';
      }
    } catch (e) {
      why = `lstat 失败：${e && e.message}`;
    }
    if (isDir && workspaceProbeWritable(claimed)) {
      diag(`默认工作区：${claimed}（来源=DSHM_PUBLIC_DOWNLOAD，即 ArkTS 经 DOWNLOAD 模式认领的`
        + ` Download/<包名>/，用户可见；原始 HOME=${ORIGINAL_HOME || '(空)'}；`
        + '选择理由=lstat 判为目录且 create+write+unlink 全部通过）');
      return claimed;
    }
    reasons.push(`DSHM_PUBLIC_DOWNLOAD=${claimed} 不可用（${isDir ? '探写未通过' : why}）`);
  }
  // ② 回退：只在这里 mkdir（沙箱内可写，不是公共目录）。
  if (fallback.length === 0) {
    diag(`默认工作区：回退不可用（理由：${reasons.join('；')}）且 SANDBOX_HOME 为空 `
      + `⇒ 返回空串（不 mkdir、不猜 '/'，宿主将用它自己的 cwd）`);
    return '';
  }
  try {
    fs.mkdirSync(fallback, { recursive: true });
  } catch (e) {
    diag(`默认工作区：回退目录 mkdir ${fallback} 失败（${e && e.message}）——仍返回它，`
      + '由宿主在创建会话时如实报错，而不是在这里静默换一个猜的路径');
  }
  diag(`默认工作区：回退 ${fallback}（理由：${reasons.join('；')}；原始 HOME=${ORIGINAL_HOME || '(空)'}）`);
  return fallback;
}

/*
 * 「这是鸿蒙端侧」的**单一事实来源**（E127）。
 *
 * 【为什么需要它】上游有一处平台相关的安全检查在鸿蒙上**永远不可能通过**：
 * `dsh-credentials-local` 的 `assertOwnerOnly()` 要求凭据文件"不能被属主以外读到"，
 * 而 hmfs 把文件权限强制成 **660**（属组可读）⇒ 检查必然抛错，
 * 表现就是"用户明明填了密钥、模型却说没有密钥"。
 * 【为什么不用别的手段探测】端侧 `process.platform` 是 `linux`，与桌面 Linux 无法区分；
 * 这里用**我们自己确知的事实**：应用沙箱路径一定以 `/data/storage` 开头。
 * 显式、可审计，且只在端侧成立——pack-core 的补丁只认这个变量。
 */
if (SANDBOX_HOME.startsWith('/data/storage') || HOME_DIR.startsWith('/data/storage')) {
  process.env.DSHM_PLATFORM = 'ohos';
  diag('平台标识：DSHM_PLATFORM=ohos（鸿蒙应用沙箱路径）');
}
for (const key of ['NO_PROXY', 'no_proxy']) {
  if (!process.env[key] || process.env[key].length === 0) {
    process.env[key] = '127.0.0.1,localhost,::1';
  }
}

/*
 * ── busybox applet 布置与内置 skills（E161）─────────────────────────────
 *
 * 【为什么需要】端侧 PATH 里只有 /bin/sh 与 toybox：没有 bash、unzip、xz、less。
 * dsh 的插件安装依赖 unzip，模型生成的常见命令（bash -c / less / hexdump）也会
 * 直接撞 "command not found"。DSHM 的 M2 真机实测结论：/system/bin 405 项里
 * toybox 已覆盖绝大多数，busybox 只需兜底**系统缺失**的项（见 BUSYBOX_APPLETS）。
 * 【2026-09-26 修正】原写"10 项"且含 bash/hush；真机 `busybox --list` 证明该 busybox
 * 未编入 bash/hush，按 applet 复制会让 `bash -c` 报 applet not found。bash/hush 已
 * 移出清单、改走文本垫片（`ensureBashShim`）。
 *
 * 【为什么在 Node 侧做而不是 ArkTS】三个硬约束都只在这一层好解：
 *   1. resfile 根可由 __dirname 推导（entryScript = <res>/resources/app/main.js）；
 *   2. ArkTS fileIo 没有 chmod API，而 busybox 副本必须带执行位（spawn 按执行位拒绝）；
 *      DSHM 为此在 C++ 层补 chmod，我们直接用 node:fs 的 chmodSync；
 *   3. PATH 注入必须发生在**任何 spawn 之前**——改 process.env.PATH 之后，
 *      dsh 的 bash/subprocess 工具才继承得到。
 *
 * 【为什么复制本体而不是软链】鸿蒙沙箱全局禁止 symlink/hardlink（真机探针
 * 13900012，同上面 ESM proxy 段的证据）；busybox 按 argv[0] 分发 applet，
 * 复制本体到每个名字是唯一可行做法（DSHM 同款）。
 *
 * 【失败策略】布置或 chmod 任一失败 ⇒ **不注入 PATH**（diag 记录原因）。
 * 不注入时已验证链路（/bin/sh + toybox）完全不受影响——宁可少十个命令，
 * 也不能让"bash 解析到无执行位的副本 → EACCES"把现有工具链弄坏。
 */
function statSize(p) {
  try {
    return fs.statSync(p).size;
  } catch (e) {
    return -1;
  }
}

/** X_OK 可执行探测（布尔，不抛）。 */
function execOk(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 读文件头 4 字节验 ELF magic（布尔，不抛）。
 * 【为什么需要它——hmfs 元数据全体不可信】真机实测：busybox tar 在 hmfs 上
 * 解 apk 里的 symlink 条目会留下"残缺链接占位"（hdc ls 显示 l????????），
 * 而 Node 的 statSync / lstatSync / accessSync 对这种条目**全部返回成功**且
 * mode=0777（symlink 固有 x 位）——按元数据判"已就绪/可执行"会被骗过。
 * open+read 走的是真实数据面：残缺链接跟随即 ENOENT，骗不了。
 */
function isElf(p) {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(4);
      const n = fs.readSync(fd, buf, 0, 4, 0);
      return n === 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return false;
  }
}

/**
 * 布置一个可执行文件，带 hmfs"封存文件"自愈。
 *
 * 【真机证据 2026-09-21，dshm-host.log 时间线】03:04 首次布置 11 个 busybox
 * 副本成功（全新文件 chmod 755 通过）；06:10 幂等补 chmod 仍通过；07:57 起
 * **每次启动**对同一路径 chmod 都 EACCES（hdc shell 同时表现为 5 个文件
 * stat `?????`）。也就是说：hmfs 上"曾布置过"的文件可能进入 chmod 与覆盖写
 * 都被拒绝的状态，幂等"只补 chmod"救不回来。
 * 【自愈手段】失败时先删除再全新写入——全新 inode 的 chmod 是被实证允许的
 * （03:04 全新布置即通过）。删除也失败（EACCES）时由调用方走 fallback。
 */
function rewriteExecutable(dst, write, label) {
  try {
    write(dst);
    fs.chmodSync(dst, 0o755);
    fs.accessSync(dst, fs.constants.X_OK);
    return true;
  } catch (first) {
    try {
      fs.rmSync(dst, { force: true });
      write(dst);
      fs.chmodSync(dst, 0o755);
      fs.accessSync(dst, fs.constants.X_OK);
      diag(`${label}：直接写入失败，已删除重铺（${String(first).slice(0, 120)}）`);
      return true;
    } catch (second) {
      diag(`${label}：布置失败（删除重铺也失败）：${String(second)}`);
      return false;
    }
  }
}

/** 需要兜底的 busybox applet（DSHM M2 实测清单）。
 *  刻意**不含 sh**：/bin/sh 是已验证链路（bash-sandbox）的组成部分，不能遮蔽。
 *  【2026-09-26 修正（真机回归）】原清单里的 `bash`/`hush` 是**错的**：
 *  端侧 busybox **没有编入 bash/hush applet**（真机 `busybox --list` 只有 ash/sh），
 *  而这里把 `bash` 写成了 busybox 的副本 ⇒ 运行 `bash -c …` 按 argv[0] 分发时
 *  报 `bash: applet not found`（exit 127），bash 工具通道整体回归。
 *  bash/hush 改由下面的 `ensureBashShim()` 写成**文本垫片**；
 *  不再参与 busybox 多合一复制。
 *  【注】垫片在**手机档内不生效**（该档真机 `ash=denied`；PC/2in1 档实测 `ash=ok`、
 *  垫片可用）——保留理由见 `bashShimLines()`
 *  的"手机档内不生效"一节：无害 + 为 tablet/2in1 档预留 + 提供 `ash` exec 探针。 */
const BUSYBOX_APPLETS = ['ash', 'bzip2', 'xz', 'hexdump', 'less', 'nc', 'unzip', 'vi'];

/**
 * bash / hush 垫片：bash 工具通道的落点。
 *
 * 【为什么是垫片而不是 busybox 副本】见 BUSYBOX_APPLETS 注释：该 busybox 无 bash
 * applet（本机对包内 busybox 的 applet 名表逐项核对：393 个名字含 `ash`/`sh`，
 * **不含 `bash`/`hush`**）。真 bash 也不存在（沙箱里只有 toybox/busybox）。
 *
 * 【2026-10-03 P0 回归修复：首行解释器改为随包 ash 副本】
 * 旧垫片首行是 `#!/system/bin/sh`，而真机探针证明端侧 **对三方应用 execve
 * `/system/bin/sh`（含 `/bin/sh`，同一文件）被 SELinux 拒绝**：
 *     V0-native-sysInfo = {…,"sh":"x-no:13","rm":"x-ok","toybox":"x-ok",…}
 *     ls -lZ /system/bin/sh ⇒ -rwxr-xr-x root shell u:object_r:sh_exec:s0
 * 即：模式 755 却 exec 失败 = **MAC 拒绝**（不是权限位问题）。而脚本的"首行解释器"
 * 是**内核在 execve 时**打开的 —— 系统 shell 被拒 ⇒ 内核返回 EACCES ⇒ 整个垫片
 * 从第一行就死，垫片内部的 `for cand` 探测链**一行都执行不到**。这正是真机 bash
 * 工具报 `spawn bash EACCES`（errno 13，不是 ENOENT ⇒ `bash` 这个名字已被
 * dsh-subprocess-local 按 PATH 成功解析到本垫片）的直接原因。
 * 修复：解释器指向**随包自签名** busybox 的 `ash` 副本（`<binDir>/ash`：同目录、
 * 同创建者、X_OK；探针 x-ok 且实测能真删文件；设备上 `/lib/ld-musl-aarch64.so.1`
 * 存在 ⇒ musl 动态链接可载入）。
 *
 * 【硬约束：首行解释器必须是"绝对路径 + 该路径存在 + 可执行"】内核不接受 PATH
 * 查找、不接受 `#!/usr/bin/env xxx` 这种二跳（那需要先能 exec env）。因此形态只能
 * **在生成期选定**（见 bashShimLines）：ash 副本可用 ⇒ 形态 ①；不可用 ⇒ 形态 ②
 * 退回旧探测链。运行时在脚本内"再探测一次解释器"是做不到的 —— 脚本要能跑起来
 * 才谈得上探测，而它跑不起来的失败点恰恰是第一行。
 *
 * 【为什么把参数原样透传】bash 工具传的是 `bash -c "<script>"`，脚本里可能含管道、
 * `&&`、重定向、`[[ ]]` 等；必须用 `exec` 把参数整体交给确定的解释器执行，不能在
 * 垫片里解析脚本内容（那会破坏引用/转义语义）。
 * 【为什么 `-lc` 与登录 shell】部分工具以 `bash -lc` 起登录 shell 取 PATH；垫片对
 * 未知选项不做处理，直接透传，由下层解释器自行处理（ash 认 `-c`）。
 * 【为什么不是 ELF 而是脚本】脚本由**内核 + 构造期自签名的 ash**执行；本体仍是
 * 宿主进程写出的普通文件（hmfs 上可执行），不引入原生代码/CMake/新权限。
 *
 * 【⚠ 可用性**取决于设备档位**（2026-10-05 更正措辞）】
 *   · **手机档**：早前探针（Mate 70 Pro+ / API 26）读数是 `ash=denied` —— 随包 `ash` 副本
 *     同样被签名域/MAC 策略拒绝 execve（与 `rg`/`git`/python 真身同一类拒绝）
 *     ⇒ `bash` 工具通道**在该档不可用**；
 *   · **PC / 2in1 档（本机当前档位）**：`ash=ok`（真机 `exec 探测 8/8`，含 `ash`）⇒ 垫片**可用**。
 * 本节原先只写"本机（手机档）…两个形态在这台设备上都起不来"——**把两台设备的读数混成了一台**
 * （"本机"指代漂移；正确口径见 `dist/sideload/README.md` 的"已知边界"与
 * `docs/device-validation.md` 的 2in1 更正）。
 * 两种档位都保留它的理由：
 *   · **无害**：它只写两个文本文件到我们自己的 bin 目录（`bash`/`hush` 两个名字），
 *     不改任何系统文件、不新增权限、不影响其它工具；
 *   · **为 tablet / 2in1 档保留可能性**：那两个档位的签名域/MAC 策略与手机档不同，
 *     "随包自签名 ELF 能否 execve"没有先验答案，垫片把这条路留着就不必再改代码；
 *   · **诊断价值**：`execProbeTargets()` 里的 `ash` 探针是判断"随包自签名 ELF
 *     能不能 exec"的**唯一**机器可读读数 —— 它给出 `ash=denied` 本身就是结论
 *     （失败点在解释器可执行性，而不是 argv[0] 派发或沙箱）。
 * 换句话说：它的价值是**探针 + 档位适配**（2in1 档实测可用），不是"手机档能跑 bash"。
 */
const BASH_SHIM_INTERPRETER = 'ash';

/** 垫片降级链末端的系统 shell（与旧实现同值，仅在第 2 形态里使用）。 */
const BASH_SHIM_SYSTEM_SHELL = '/system/bin/sh';

/**
 * 生成垫片脚本（两形态，见上）。**形态选择在生成期做**，运行时只 `exec` 一条路。
 *
 * 形态 ①（正常）：binDir/ash 已在 busybox 布置阶段落位 ⇒ 解释器直接指向它。
 * 形态 ②（保守）：该副本不在/不可执行 ⇒ **退回旧探测链**（真 bash → busybox ash →
 *   `/system/bin/sh`）。形态 ② 在本机（`u:object_r:sh_exec:s0` 对三方应用 execve 返回
 *   EACCES）下的首行解释器就已经失败，所以它只是"不比以前更脆"的兜底，不是可用路径；
 *   形态 ① 才是本设备上的可用解（ash 副本是随包自签名 ELF，探针 x-ok 且实测能真删文件）。
 *
 * 【为什么用数组返回】保持与旧 `BASH_SHIM_LINES` 相同的消费方式（`join('\n') + '\n'`），
 * 改动面收敛在一处。
 * @param {string} binDir 运行时真实 bin 目录（**生成期写死绝对路径**，与注入 PATH 的目录同源）
 */
function bashShimLines(binDir) {
  const ashi = path.join(binDir, BASH_SHIM_INTERPRETER);
  if (execOk(ashi)) {
    return [
      `#!${ashi}`,
      '# DSHM bash 垫片：端侧 /system/bin/sh 对三方应用 execve 被 SELinux 拒绝（EACCES），',
      '# 故解释器改为随包自签名 busybox 的 ash 副本（同目录、同创建者、x-ok）。',
      `# 参数原样转发：bash 工具传的是 bash -c "<script>"，垫片不解析脚本内容。`,
      '# 见 hostcore/app/main.js 的 ensureBashShim() 注释。',
      `exec ${JSON.stringify(ashi)} "$@"`,
    ];
  }
  return [
    `#!${BASH_SHIM_SYSTEM_SHELL}`,
    '# DSHM bash 垫片（降级形态）：同目录 ash 副本未就位 ⇒ 保留旧探测链（见 main.js 注释）。',
    'for cand in /system/bin/bash /bin/bash /usr/bin/bash; do',
    '  if [ -x "$cand" ] && [ "$cand" != "$0" ]; then',
    '    exec "$cand" "$@"',
    '  fi',
    'done',
    'for cand in "${DSH_BUSYBOX:-}" /system/bin/busybox; do',
    '  if [ -n "$cand" ] && [ -x "$cand" ]; then',
    '    exec "$cand" ash "$@"',
    '  fi',
    'done',
    `exec ${BASH_SHIM_SYSTEM_SHELL} "$@"`,
  ];
}

/**
 * 布置 bash/hush 文本垫片到 bin 目录。
 *
 * 【与 busybox 布置的关系】bash/hush **不再**出现在 BUSYBOX_APPLETS 里（那是导致
 * `applet not found` 的根因），改由此函数写文本垫片。幂等：内容一致且 X_OK 则跳过
 * （避免 hmfs 上多余的 chmod——`rewriteExecutable` 的注释记着"对健康文件做多余
 * chmod 可能触发 EACCES"）。
 * 【hush 用同一份垫片】hush 是 busybox 的另一款 POSIX shell，端侧同样未编入；
 * 语义上与 bash 垫片同为"转发到可用 POSIX 解释器"，直接复用，不做第二份。
 * 【落点只有 bash/hush 两个名字】不影响同目录的 pnpm/npm/npx/dsh 假壳、python/
 * python3/pip3/git/rg wrapper、busybox 本体及 ash 等 applet 副本。
 * 【调用时机】必须在 `ensureBusybox()` **之后**（ash 副本由它先落位），顶层调用块
 * 已是这个顺序 —— 否则形态探测会误判成"ash 未就位"而降级。
 * 【本档不生效】见 `bashShimLines()` 的"手机档内不生效"一节：布置**会成功**（写文件
 * 不需要 exec 许可），但垫片跑不起来（`ash=denied`）。布置与否都不影响其它能力。
 * @returns 是否全部布置成功
 */
function ensureBashShim(binDir) {
  if (!binDir || binDir.length === 0) {
    return false;
  }
  const lines = bashShimLines(binDir);
  const script = lines.join('\n') + '\n';
  for (const name of ['bash', 'hush']) {
    const dst = path.join(binDir, name);
    // 幂等：已是同一份垫片且可执行就跳过（不重复写、不重复 chmod）。
    let same = false;
    try {
      same = fs.readFileSync(dst, 'utf8') === script;
    } catch (e) {
      same = false;
    }
    if (same && execOk(dst)) {
      continue;
    }
    if (!rewriteExecutable(dst, (d) => fs.writeFileSync(d, script), `bash 垫片：${name}`)) {
      return false;
    }
  }
  diag(`bash 垫片：bash/hush 已布置（解释器 ${lines[0].slice(2)}；busybox 无 bash applet）`);
  return true;
}

/**
 * 向指定目录布置 busybox + applet 副本；全部成功返回 true。
 * 走 rewriteExecutable：单文件 chmod 失败自动"删除重铺"，封存文件自愈。
 */
function placeBusyboxDir(resRoot, dir) {
  const src = path.join(resRoot, 'busybox', 'busybox');
  ensureDir(dir);
  const names = ['busybox', ...BUSYBOX_APPLETS];
  for (const name of names) {
    if (!rewriteExecutable(path.join(dir, name), (d) => fs.copyFileSync(src, d), `busybox：${name}`)) {
      return false;
    }
  }
  return true;
}

/** 清理历史 fallback 目录（bin-<pid>）：本进程不用的都尽量删掉，删不动就留着。 */
function cleanupStaleBinDirs(activeDir) {
  try {
    for (const name of fs.readdirSync(SANDBOX_HOME)) {
      if (!name.startsWith('bin-')) {
        continue;
      }
      const full = path.join(SANDBOX_HOME, name);
      if (full === activeDir) {
        continue;
      }
      try {
        fs.rmSync(full, { recursive: true, force: true });
        diag(`busybox：已清理历史 fallback 目录 ${full}`);
      } catch (e) {
        diag(`busybox：历史目录 ${full} 清理失败（残留无害）：${String(e).slice(0, 80)}`);
      }
    }
  } catch (e) {
    // readdirSync 失败：不影响主流程
  }
}

/**
 * 布置 busybox applet 到 <SANDBOX_HOME>/bin；成功返回 bin 目录路径，失败返回空串。
 * 幂等：全部副本"大小一致且 X_OK"才跳过写入（大小一致但 chmod 失效的封存
 * 残留会被识别并删除重铺，见 rewriteExecutable 的真机证据）。
 * 主 bin 目录整体不可写时，退到 bin-<pid>（本进程全新目录）布置。
 */
function ensureBusybox(resRoot) {
  const src = path.join(resRoot, 'busybox', 'busybox');
  const srcSize = statSize(src);
  if (srcSize <= 0) {
    diag(`busybox：resfile 缺少 ${src}，跳过布置（PC 侧离线跑属正常）`);
    return '';
  }
  const binDir = path.join(SANDBOX_HOME, 'bin');
  try {
    const names = ['busybox', ...BUSYBOX_APPLETS];
    // 快路径：大小指纹 + X_OK 双条件全过才认为"已是健康布置"，零写操作返回
    let healthy = true;
    for (const name of names) {
      const dst = path.join(binDir, name);
      if (statSize(dst) !== srcSize || !execOk(dst)) {
        healthy = false;
        break;
      }
    }
    if (healthy) {
      cleanupStaleBinDirs(binDir);
      return binDir;
    }
    if (placeBusyboxDir(resRoot, binDir)) {
      diag(`busybox：已布置 ${names.length} 个副本到 ${binDir}`);
      cleanupStaleBinDirs(binDir);
      return binDir;
    }
    // fallback：主 bin 里的旧文件既改不了也删不掉（疑似跨进程持有/封存），
    // 换本进程专属目录全新布置——新目录里的文件全部由当前进程创建。
    const fallback = path.join(SANDBOX_HOME, `bin-${process.pid}`);
    if (placeBusyboxDir(resRoot, fallback)) {
      diag(`busybox：主 bin 不可恢复，已改用本进程目录 ${fallback}`);
      cleanupStaleBinDirs(fallback);
      return fallback;
    }
    diag('busybox：布置失败（主 bin 与 fallback 目录均失败）');
    return '';
  } catch (e) {
    diag(`busybox：布置失败：${String(e)}`);
    return '';
  }
}

/**
 * 内置 skills：resfile/ohos-skills/*.md → $DSH_HOME/skills/。
 * dsh-skill-filesystem 的 user-dsh root 就是 join($DSH_HOME, 'skills')，
 * 平铺 Markdown 会被当作 flat skill 收录（端侧 Shell/Python/PC/工作区知识）。
 *
 * 【P0-1 修复 2026-09-28】判等从"字节数"改为"内容 sha256"，判定与复制都在
 * dshm-skills.js（可单测）里。旧的 `statSize(dst) === statSize(src)` 会让任何
 * **等长改动**永远推不下去：真机上 skill 已含 dshm-* 端点，而设备侧副本仍是
 * 等长的 hdsh-* 旧端点，日志"本次复制 0 个"，模型照文档手调全 404。
 */
function ensureBundledSkills(resRoot) {
  const srcDir = path.join(resRoot, 'ohos-skills');
  if (!fs.existsSync(srcDir)) {
    diag(`skills：resfile 缺少 ${srcDir}，跳过（PC 侧离线跑属正常）`);
    return;
  }
  const dstDir = path.join(HOME_DIR, 'skills');
  const r = skillsSync.syncSkills(srcDir, dstDir);
  for (const f of r.failed) {
    diag(`skills：${f.name || '(目录)'} 同步失败（不阻塞启动）：${f.error}`);
  }
  diag(`skills：内置技能已同步（本次复制 ${r.copied.length} 个`
    + `${r.copied.length > 0 ? '：' + r.copied.join('、') : ''}；`
    + `内容未变 ${r.unchanged.length} 个）到 ${dstDir}`);
}

/**
 * pnpm/npm CLI 假壳脚本（POSIX sh，/system/bin/sh 解释）。
 * 【为什么必须做成假壳 —— 真机证据 2026-09-21】用户让模型装插件（给包名与
 * GitHub 地址各一次），模型二话不说直接 bash `pnpm add <spec>` → busybox
 * "command not found" 退出码 127，ohos-plugin-install skill 通道根本没被看。
 * 与其赌模型每次都先读 skill，不如把 pnpm/npm 本身做进 PATH（busybox bin 在
 * 最前）：假壳把 add/install 改写为安装队列投递并**同步等结果**——模型视角
 * `pnpm add X` 直接成功返回，队列协议零学习成本。
 * 【shell 语法约束】刻意不用 `${...}` 参数展开（会被 JS 模板串吃掉，且部分
 * toybox sh 对复杂展开支持不稳）；`$(...)`、`$((...))`、`$@` 均为 POSIX 基本功。
 * 【队列路径必须写死 —— 真机证据 2026-09-23】假壳最初运行时读 $DSH_HOME 定位
 * 队列目录，但 bash 工具子进程环境由 dsh-bash-local spawnSpec 白名单构造
 * （ENV_OVERRIDES+spec.env+spec.dshEnv，不 spread Host process.env），DSH_HOME
 * 恒空 → 真机 `pnpm add` 报"缺少 DSH_HOME"（PATH 经 spec.dshEnv 到位，故假壳
 * 本身找得到）。改为生成时把 HOME_DIR/install-queue 写死进脚本字面量，与
 * python 垫片写死 HOME_DIR/PORT 同模式；Host 轮询目录同源（HOME_DIR 常量）。
 */
/**
 * 三个假壳**共用**的「落位目录归一化」shell 片段（报告 7 §1a/§1b/§1c，2026-09-25）。
 *
 * 【为什么必须统一】报告 7 指出三处假壳各写各的 dir 逻辑，于是各有各的漏：
 *   · `pnpm`：`--dir <path>`（**空格形式**）只被"跳过"、从未被**取值** ⇒ DIR_OPT 恒空
 *     ⇒ 掉到 `$PWD` 分支；而市场 `prefetch()` 正是用空格形式发 `--dir <临时目录>`
 *     ⇒ **隔离预取失效**：包落进 profile、临时目录空 ⇒ 市场读不到 manifest ⇒
 *     "installed package manifest missing"，且包/行/依赖全部泄漏到 profile。
 *   · `npx`/`dsh`：**根本没有** `--dir` 解析，`.dir` 直接写 `$PWD`。而 dsh 起子进程时
 *     cwd 常为 `/`（真机已证）⇒ 宿主安装器按 `.dir=/` 落位 ⇒
 *     `EACCES: mkdir '/node_modules'`（报告 7 §1a 复测仍有）。
 *
 * 【优先级（报告指定）】`--dir`（两种写法）> **有效** `$PWD`（非空且非 `/`）
 * > `--profile`（两种写法）> host-ready.json 的 profile > 常量 ondevice。
 *
 * 【为什么用 want_dir 两段式而不是 `skip_next`】`--dir <path>` 的**值本身也是一个
 * 参数**，必须把它"消费掉"（既不当包名、也不当别的选项）。用一个"下轮取值"的标志
 * 同时完成"取值"与"消费"两件事，比"先跳过再回头找"少一个状态。
 * 【HOME_DIR 必须走模板串】本文件里这些行是 JS 字符串：**单引号串里的 `${HOME_DIR}`
 * 不会插值**，会原样进脚本（报告 7 §1b 的真 bug——脚本里 `${HOME_DIR}` 被 shell 当
 * 未定义变量展开成空，于是归一化路径变成 `/profiles/<name>`）。凡出现 `${HOME_DIR}`
 * 的行一律用反引号模板串。
 */
function shimDirResolveLines() {
  return [
    'DIR_OPT=""',
    'PROF_OPT=""',
    'want_dir=0',
    'want_prof=0',
    'for a in "$@"; do',
    '  if [ $want_dir -eq 1 ]; then DIR_OPT="$a"; want_dir=0; continue; fi',
    '  if [ $want_prof -eq 1 ]; then PROF_OPT="$a"; want_prof=0; continue; fi',
    '  case "$a" in',
    '    --dir=*) DIR_OPT="${a#--dir=}" ;;',
    '    --dir) want_dir=1 ;;',
    '    --profile=*) PROF_OPT="${a#--profile=}" ;;',
    '    --profile) want_prof=1 ;;',
    '  esac',
    'done',
    '# 归一化：--dir > 有效 $PWD > --profile > host-ready.json > ondevice',
    'if [ -z "$DIR_OPT" ] || [ "$DIR_OPT" = "/" ]; then',
    '  if [ -n "$PWD" ] && [ "$PWD" != "/" ]; then',
    /*
     * 【D3（2026-10-03）$PWD 档必须确认"这确实是一个 profile 目录"】
     *
     * 旧写法无条件采纳 `$PWD`，于是 `cd ~`（= 应用沙箱根 `<files>/`）之后安装插件，
     * `$PWD` 命中本档 ⇒ 目标被当成 profile ⇒ 包落到 `<files>/node_modules/`、
     * 并在 `<files>/package.json` 写一份裸 manifest。真机现象：`pnpm add <pkg>`
     * 返回 `ok:true`，但插件在 profile 里根本不存在，重启后也不出现 —— 报成功却不可见。
     *
     * 判据只认**形状**：`${HOME_DIR}/profiles/<name>`。写成 shell 的 case 模式
     * （`"${HOME_DIR}/profiles/"*`）而不是前缀比较，是为了让 `<name>` 必须非空且
     * 不含多余的 `/`（`profiles/a/b` 不匹配 `profiles/*`，`profiles/` 也不匹配）。
     * 不匹配时**不采纳**，让控制流落到下面的 `--profile` / host-ready.json / ondevice
     * 三档 —— 那才是"没给 --dir 时该去哪儿"的正解。
     */
    `    case "$PWD" in "${HOME_DIR}/profiles/"*) DIR_OPT="$PWD" ;; esac`,
    '  fi',
    '  if [ -z "$DIR_OPT" ]; then',
    '    PN="$PROF_OPT"',
    '    if [ -z "$PN" ]; then',
    `      PN=$(sed -n 's/.*"profile"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "${HOME_DIR}/host-ready.json" 2>/dev/null)`,
    '    fi',
    '    if [ -z "$PN" ]; then PN=ondevice; fi',
    `    DIR_OPT="${HOME_DIR}/profiles/$PN"`,
    '  fi',
    'fi',
  ];
}

/**
 * 供 pnpm/npm 的第二趟（真正投递 spec）使用的「跳过选项与其值」片段。
 * 必须与 shimDirResolveLines 的消费口径一致，否则 `--dir <tmp>` 的 `<tmp>` 会被
 * 当成**第二个包名**投递（多装一个不存在的包）。
 */
function shimSkipOptValuesLines() {
  return [
    'skip_next=0',
    'want_dir=0',
    'want_prof=0',
    'for a in "$@"; do',
    '  if [ $skip_next -eq 1 ]; then skip_next=0; continue; fi',
    '  if [ $want_dir -eq 1 ]; then want_dir=0; continue; fi',
    '  if [ $want_prof -eq 1 ]; then want_prof=0; continue; fi',
    '  case "$a" in',
    '    --dir=*) continue ;;',
    '    --dir) want_dir=1; continue ;;',
    '    --profile=*) continue ;;',
    '    --profile) want_prof=1; continue ;;',
    '    -*) continue ;;',
    '  esac',
  ];
}

const CLI_SHIM_LINES = [
  '#!/system/bin/sh',
  '# DSHM pnpm/npm shim：端侧无 node 包管理器（E86），add/install 走安装队列',
  '#（Host 进程内安装器接单，见 dshm-installer.js；协议：*.req → *.done/*.fail）',
  '# 队列路径生成时写死：bash 子进程 env 是白名单构造（不含 Host process.env），',
  '# 运行时读 $DSH_HOME 恒空（2026-09-23 真机实测）；PATH 经白名单到位故假壳可执行',
  'cmd="$1"',
  'if [ "$cmd" = "-v" ] || [ "$cmd" = "--version" ] || [ "$cmd" = "version" ]; then',
  '  echo "10.0.0 (dshm install-queue shim)"',
  '  exit 0',
  'fi',
  `QDIR="${HOME_DIR}/install-queue"`,
  'mkdir -p "$QDIR" 2>/dev/null',
  'if [ "$cmd" = "add" ] || [ "$cmd" = "install" ] || [ "$cmd" = "i" ]; then',
  '  shift',
  //  ── --dir 优先（报告 1 P0 → 报告 7 §1a/1b/1c 统一）──────────────────────
  //  逻辑抽到 shimDirResolveLines()（三个假壳共用，避免各写各的又各漏一处）。
  //  要点：`--dir <path>`（空格形式）**必须取值**（市场 prefetch 用的就是这种）；
  //  归一化路径里的 ${HOME_DIR} 必须走模板串，否则脚本里是空串。
  ...shimDirResolveLines(),
  /*
   * 第一趟：数"有几个真包名"。**必须与第二趟（shimSkipOptValuesLines）同款消费口径**——
   * 否则 `--dir /tmp/x` 的 `/tmp/x` 会被当成第二个包名（count=2）。
   * 踩过：最初这里只写 `--dir) want_dir=1` 而**没在循环首部消费**，于是 `/tmp/x`
   * 落进 `*) count=$((count+1))` ⇒ count 虚高；若用户只给 `--dir` 不给包名，
   * 就会误判"有包"而投递一个空/错 spec。
   */
  '  count=0',
  '  want_dir=0',
  '  want_prof=0',
  '  for a in "$@"; do',
  '    if [ $want_dir -eq 1 ]; then want_dir=0; continue; fi',
  '    if [ $want_prof -eq 1 ]; then want_prof=0; continue; fi',
  '    case "$a" in',
  '      --dir=*) continue ;;',
  '      --dir) want_dir=1; continue ;;',
  '      --profile=*) continue ;;',
  '      --profile) want_prof=1; continue ;;',
  '      -*) ;;',
  '      *) count=$((count+1)) ;;',
  '    esac',
  '  done',
  '  if [ $count -eq 0 ]; then',
  '    echo "pnpm(shim): 请给出包名或 GitHub 地址（端侧不支持无参 install）" >&2',
  '    exit 1',
  '  fi',
  '  fail_any=0',
  ...shimSkipOptValuesLines(),
  // 上面 shimSkipOptValuesLines 的 for 循环体从下一行开始：投递每个非选项参数
  '    base="cli-$(date +%s)-$$"',
  '    while [ -f "$QDIR/$base.req" ] || [ -f "$QDIR/$base.done" ] || [ -f "$QDIR/$base.fail" ]; do',
  '      sleep 1',
  '      base="cli-$(date +%s)-$$"',
  '    done',
  '    echo "$a" > "$QDIR/$base.req" || { echo "pnpm(shim): 队列写入失败：$a" >&2; fail_any=1; continue; }',
  "    printf \"%s\" \"$DIR_OPT\" > \"$QDIR/$base.dir\" 2>/dev/null",
  '    echo "pnpm(shim): 已投递安装请求：$a（等待 Host 安装结果…）"',
  '    got=0',
  '    i=0',
  '    max_loop="$SHIM_WAIT_MAX"',
  '    if [ -z "$max_loop" ]; then',
  '      max_loop=600',
  '    fi',
  '    while [ $i -lt $max_loop ]; do',
  '      if [ -f "$QDIR/$base.done" ]; then',
  '        cat "$QDIR/$base.done"',
  '        rm -f "$QDIR/$base.done" 2>/dev/null',
  '        echo "pnpm(shim): 安装成功：$a（插件行已写入，重启应用后随 profile 挂载生效）"',
  '        got=1',
  '        break',
  '      fi',
  '      if [ -f "$QDIR/$base.fail" ]; then',
  '        echo "pnpm(shim): 安装失败：$a" >&2',
  '        cat "$QDIR/$base.fail" >&2',
  '        rm -f "$QDIR/$base.fail" 2>/dev/null',
  '        got=1',
  '        fail_any=1',
  '        break',
  '      fi',
  '      sleep 0.5',
  '      i=$((i+1))',
  '      if [ $((i % 60)) -eq 0 ]; then',
  '        echo "pnpm(shim): 仍在等待 Host 安装 $a（已等 $((i / 2))s，下载大包较慢属正常）…"',
  '      fi',
  '    done',
  '    if [ $got -eq 0 ]; then',
  '      echo "pnpm(shim): $a 仍在后台安装中（本次等待已达上限，安装不会中断）"',
  '      echo "pnpm(shim): 完成后插件行自动写入，重启应用后随 profile 生效；如需确认结果可稍后重跑本命令（安装幂等）"',
  '    fi',
  '  done',
  '  exit $fail_any',
  'fi',
  'if [ "$cmd" = "view" ] || [ "$cmd" = "info" ] || [ "$cmd" = "show" ]; then',
  //  【为什么补 view —— 真机证据 2026-09-24】插件设置页"按名安装"先经
  //  pluginManager/inspect RPC → viewProfilePackage（dsh-plugin-manager lib/index.js:664）
  //  spawn `pnpm view <spec> name version description dsh --json`——此前假壳只有
  //  add/install 分支，view 落到末尾拒绝行 → inspect 归类 unknown → UI 报
  //  "无法获取插件信息"。端侧无真 pnpm，改为转发 Host 进程内 registry 查询端点
  //  /dshm-registry/view（dshmFetch 查 npmmirror，与安装器同 registry），stdout
  //  输出 pnpm view --json 同形 JSON，exit code 透传——上层解析零改动。
  '  shift',
  '  spec=""',
  '  for a in "$@"; do',
  '    case "$a" in',
  '      -*) ;;',
  '      *) if [ -z "$spec" ]; then spec="$a"; fi ;;',
  '    esac',
  '  done',
  '  if [ -z "$spec" ]; then',
  '    echo "pnpm(shim): view 需要包名（端侧：转发 Host registry 查询）" >&2',
  '    exit 1',
  '  fi',
  //  token 双源同 python 垫片桥模式（env 快路径 → host-ready.json 主通道）；
  //  enc：query 参数编码（@ / 必须编码，spec 形如 @scope/name@^1.2.3）
  '  enc() {',
  "    printf \"%s\" \"$1\" | sed -e 's/%/%25/g' -e 's/@/%40/g' -e 's|/|%2F|g' -e 's/ /%20/g' -e 's/&/%26/g' -e 's/+/%2B/g' -e 's/?/%3F/g' -e 's/=/%3D/g' -e 's/#/%23/g'",
  '  }',
  '  TOKEN="${DSHM_PYTHON_TOKEN:-}"',
  '  if [ -z "$TOKEN" ]; then',
  `    TOKEN=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "${HOME_DIR}/host-ready.json" 2>/dev/null)`,
  '  fi',
  '  if [ -z "$TOKEN" ]; then',
  '    echo "pnpm(shim): view 失败：Host token 未就绪（host 启动中？稍后重试）" >&2',
  '    exit 1',
  '  fi',
  `  OUT=$(wget -O - "http://127.0.0.1:${PORT}/dshm-registry/view?token=$TOKEN&spec=$(enc "$spec")" 2>/dev/null)`,
  '  if [ $? -eq 0 ] && [ -n "$OUT" ]; then',
  '    printf "%s\n" "$OUT"',
  '    exit 0',
  '  fi',
  '  echo "pnpm(shim): view 查询失败：$spec（Host registry 端点不可达、包不存在或网络异常）" >&2',
  '  exit 1',
  'fi',
  //  【补 config —— 端侧 0.1.7-rc.1 真机证据：plugin-manager 在 registry 未显式
  //   配置时会 call `pnpm config get registry`（operations.js readProfileRegistry）
  //   定安装源。此前假壳无 config 分支 → 落到末尾拒绝行 → 上层把 registry 判成
  //   不可信 → Web 插件页的 registry 探测/安装失败。这里返回与安装器 / view 端点
  //   同源（DEFAULT_REGISTRY=npmmirror）的 registry，让上层拿到的就是实际安装源。
  'if [ "$cmd" = "config" ] || [ "$cmd" = "get" ]; then',
  '  if [ "$cmd" = "get" ] && [ -z "$2" ]; then',
  '    echo "pnpm(shim): 用法 pnpm config get <key>" >&2',
  '    exit 1',
  '  fi',
  '  # 只喂 registry：其余 config 键一律回空 / 兜底（端侧无真实 pnpm 配置链）。',
  '  mykey=""',
  '  for a in "$@"; do',
  '    [ "$a" = "config" ] && continue',
  '    [ "$a" = "get" ] && continue',
  '    [ -n "$mykey" ] && continue',
  '    mykey="$a"',
  '  done',
  '  if [ "$mykey" = "registry" ]; then',
  '    echo "https://registry.npmmirror.com/"',
  '    exit 0',
  '  fi',
  '  echo ""',
  '  exit 0',
  'fi',
  //  【补卸载 —— 2026-09-24 真机证据】web 插件页「卸载」经 plugin-manager
  //  removeBundle → execa(`pnpm rm <spec>`) → 假壳若直接拒绝会让每次卸载都失败。
  //  这里改为投递 .rem 卸载请求（与 .req 装同为进 Host 进程内队列），Host 侧
  //  removeSpec 删 node_modules + package.json 依赖 + 用户插件行，结果回 .done/.fail，
  //  卸载就真能卸掉了（web UI 看到一个 exit 0 的 pnpm rm）。
  'if [ "$cmd" = "remove" ] || [ "$cmd" = "rm" ] || [ "$cmd" = "uninstall" ]; then',
  '  shift',
  '  spec=""',
  '  for a in "$@"; do',
  '    case "$a" in',
  '      -*) ;;',
  '      *) if [ -z "$spec" ]; then spec="$a"; fi ;;',
  '    esac',
  '  done',
  '  if [ -z "$spec" ]; then',
  '    echo "pnpm(shim): 卸载需要包名（端侧：投递卸载队列）" >&2',
  '    exit 1',
  '  fi',
  '  base="rem-$(date +%s)-$$"',
  '  while [ -f "$QDIR/$base.req" ] || [ -f "$QDIR/$base.rem" ] || [ -f "$QDIR/$base.done" ] || [ -f "$QDIR/$base.fail" ]; do',
  '    sleep 1',
  '    base="rem-$(date +%s)-$$"',
  '  done',
  '  echo "$spec" > "$QDIR/$base.rem" || { echo "pnpm(shim): 卸载请求写入失败：$spec" >&2; exit 1; }',
  '  echo "pnpm(shim): 已投递卸载请求：$spec（等待 Host 卸载结果…）"',
  '  got=0',
  '  i=0',
  '  max_loop="$SHIM_WAIT_MAX"',
  '  if [ -z "$max_loop" ]; then',
  '    max_loop=600',
  '  fi',
  '  while [ $i -lt $max_loop ]; do',
  '    if [ -f "$QDIR/$base.done" ]; then',
  '      cat "$QDIR/$base.done"',
  '      rm -f "$QDIR/$base.done" 2>/dev/null',
  '      got=1',
  '      break',
  '    fi',
  '    if [ -f "$QDIR/$base.fail" ]; then',
  '      echo "pnpm(shim): 卸载失败：$spec" >&2',
  '      cat "$QDIR/$base.fail" >&2',
  '      rm -f "$QDIR/$base.fail" 2>/dev/null',
  '      got=1',
  '      exit 1',
  '    fi',
  '    sleep 0.5',
  '    i=$((i+1))',
  '    if [ $((i % 60)) -eq 0 ]; then',
  '      echo "pnpm(shim): 仍在等待 Host 卸载 $spec（已等 $((i / 2))s）…"',
  '    fi',
  '  done',
  '  if [ $got -eq 0 ]; then',
  '    echo "pnpm(shim): $spec 卸载请求仍在后台处理中"',
  '  fi',
  '  exit 0',
  'fi',
  //  【补 pnpm list —— 2026-09-24 真机证据】skin-market 在 pnpm add 成功后会跑
  //  `pnpm list --json --depth=0`（inventory）拿已装包**真实路径**（packageDir），再读
  //  入口/应用 bundle patch。此前假壳无 list 分支 → 落到末尾拒绝行 exit 1 →
  //  inventory 空 → 市场报 "installed package manifest missing / did not materialize"。
  //  这里转发 Host /dshm-packages/list，返回 pnpm list --json 同形 JSON（dir=PWD，
  //  市场以 profileDir 为 cwd 起 spawn）。无法取出就回 [] + 0，靠 deps diff 兜底。
  'if [ "$cmd" = "list" ] || [ "$cmd" = "ls" ] || [ "$cmd" = "ll" ]; then',
  '  TOKEN="${DSHM_PYTHON_TOKEN:-}"',
  '  if [ -z "$TOKEN" ]; then',
  `    TOKEN=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "${HOME_DIR}/host-ready.json" 2>/dev/null)`,
  '  fi',
  '  if [ -z "$TOKEN" ]; then',
  '    echo "pnpm(shim): list 失败：Host token 未就绪" >&2',
  '    echo "[]"',
  '    exit 1',
  '  fi',
  "  LISTENC=$(printf \"%s\" \"$(pwd)\" | sed -e 's/%/%25/g' -e 's/@/%40/g' -e 's|/|%2F|g' -e 's/ /%20/g' -e 's/&/%26/g' -e 's/+/%2B/g' -e 's/?/%3F/g' -e 's/=/%3D/g' -e 's/#/%23/g')",
  `  OUT=$(wget -O - "http://127.0.0.1:${PORT}/dshm-packages/list?token=$TOKEN&dir=$LISTENC" 2>/dev/null)`,
  '  if [ $? -eq 0 ] && [ -n "$OUT" ]; then',
  '    printf "%s\n" "$OUT"',
  '    exit 0',
  '  fi',
  '  echo "pnpm(shim): list 查询失败（端点到不可达）" >&2',
  '  echo "[]"',
  '  exit 1',
  'fi',
  'echo "pnpm(shim): 端侧只收 add/install <包名|GitHub地址> 或 rm <包名>（收到：$cmd）" >&2',
  'exit 1',
];

/**
 * npx 假壳（POSIX sh）：与 pnpm/npm 假壳同一真机动因（模型肌肉记忆直接跑
 * `npx <pkg>`），但 npx 的语义是"装并立即执行"。端侧把【装】接住——投递安装
 * 队列（与 pnpm add 同通道）；【立即执行】不做：沙箱无 .bin symlink（13900012），
 * 完成后引导改用 node 调用包内入口。`-y/--yes` 等标志跳过后取首个非选项参数。
 * 队列路径同 CLI 假壳：生成时写死（bash 子进程 env 白名单，$DSH_HOME 不可见）。
 */
const NPX_SHIM_LINES = [
  '#!/system/bin/sh',
  '# DSHM npx shim：装包走安装队列（与 pnpm add 同通道），不做即时执行',
  'if [ "$1" = "-v" ] || [ "$1" = "--version" ]; then',
  '  echo "10.9.0 (dshm install-queue shim)"',
  '  exit 0',
  'fi',
  'pkg=""',
  'for a in "$@"; do',
  '  case "$a" in',
  '    -*) ;;',
  '    *) if [ -z "$pkg" ]; then pkg="$a"; fi ;;',
  '  esac',
  'done',
  'if [ -z "$pkg" ]; then',
  '  echo "npx(shim): 用法 npx <包名>（端侧：装包走安装队列，不做即时执行）" >&2',
  '  exit 1',
  'fi',
  `QDIR="${HOME_DIR}/install-queue"`,
  'mkdir -p "$QDIR" 2>/dev/null',
  //  【报告 7 §1a】npx 此前直接写 .dir=$PWD，而 dsh 起子进程 cwd 常为 `/`
  //  ⇒ 落位到 `/node_modules` → EACCES。统一走 shimDirResolveLines()。
  ...shimDirResolveLines(),
  'base="cli-$(date +%s)-$$"',
  'while [ -f "$QDIR/$base.req" ] || [ -f "$QDIR/$base.done" ] || [ -f "$QDIR/$base.fail" ]; do',
  '  sleep 1',
  '  base="cli-$(date +%s)-$$"',
  'done',
  'echo "$pkg" > "$QDIR/$base.req" || { echo "npx(shim): 队列写入失败：$pkg" >&2; exit 1; }',
  "printf \"%s\" \"$DIR_OPT\" > \"$QDIR/$base.dir\" 2>/dev/null",
  'echo "npx(shim): 已投递安装请求：$pkg（等待 Host 安装结果…）"',
  'got=0',
  'i=0',
  'max_loop="$SHIM_WAIT_MAX"',
  'if [ -z "$max_loop" ]; then',
  '  max_loop=600',
  'fi',
  'while [ $i -lt $max_loop ]; do',
  '  if [ -f "$QDIR/$base.done" ]; then',
  '    cat "$QDIR/$base.done"',
  '    rm -f "$QDIR/$base.done" 2>/dev/null',
  '    got=1',
  '    break',
  '  fi',
  '  if [ -f "$QDIR/$base.fail" ]; then',
  '    echo "npx(shim): 安装失败：$pkg" >&2',
  '    cat "$QDIR/$base.fail" >&2',
  '    rm -f "$QDIR/$base.fail" 2>/dev/null',
  '    exit 1',
  '  fi',
  '  sleep 0.5',
  '  i=$((i+1))',
  '  if [ $((i % 60)) -eq 0 ]; then',
  '    echo "npx(shim): 仍在等待 Host 安装 $pkg（已等 $((i / 2))s，下载大包较慢属正常）…"',
  '  fi',
  'done',
  'if [ $got -eq 0 ]; then',
  '  echo "npx(shim): $pkg 仍在后台安装中（本次等待已达上限，安装不会中断）"',
  '  echo "npx(shim): 完成后插件行自动写入，重启应用后随 profile 生效；如需确认结果可稍后重跑本命令（安装幂等）"',
  '  exit 0',
  'fi',
  'echo "npx(shim): $pkg 已安装。端侧 npx 不做即时执行；命令行入口请用 node 直接调用包内脚本（沙箱无 .bin symlink）" >&2',
  'exit 0',
];

/**
 * dsh CLI 假壳（POSIX sh）。
 * 【为什么需要 —— 真机证据 2026-09-24】dshmarket 安装链 spawn 的是 `dsh` CLI：
 * runDshPlugin（dshmarket 1.62.0 lib/dsh-cli.js:938-955）按 dshArgv() 构造
 * `dsh plugin --profile <p> install <spec> …`；dshArgv 在 argv[1] 不匹配
 * bin.js|bin.ts|dsh 时落到裸 spawn 'dsh'（PATH 查找，:424）——端侧 Host 的
 * argv[1] 是 app/main.js，PATH 里又没有 dsh，真机市场安装直接
 * `spawn dsh ENOENT`。假壳把 `dsh plugin --profile p install <spec>` 的 spec
 * 投递安装队列（与 pnpm add 同通道）并同步等结果，exit code 透传——
 * dshmarket 以 exitCode===0 判定安装成功（install.js ok()）。
 * 【等待上限 28 分钟 > dshmarket INSTALL_TIMEOUT_MS 15 分钟】刻意让市场侧
 * timeout 先触发（killTree 杀假壳，队列安装不受影响照常完成）；若假壳先到
 * 上限只能 exit 0"仍在后台"，市场会误判成功后立即做更新校验，拿到未装上
 * 的中间态。等待输出人类可读行（市场 makeProgressFeeder 非 JSON 行入
 * lastLine 兜底展示，不影响判定）。
 * 【install 无 spec（install.js:133 的 lockfile 重建）】端侧无 lockfile 概念，
 * 静默 exit 0：重建只在 pnpm 失败恢复路径出现，正常成功链不触发。
 * 【队列路径写死】同 CLI 假壳（env 白名单子进程读 $DSH_HOME 恒空）。
 */
const DSH_SHIM_LINES = [
  '#!/system/bin/sh',
  '# DSHM dsh shim：dshmarket spawn 的 `dsh plugin install` → 安装队列投递',
  `QDIR="${HOME_DIR}/install-queue"`,
  'mkdir -p "$QDIR" 2>/dev/null',
  //  【报告 7 §1a】dsh 此前直接写 .dir=$PWD（宿主 cwd=/ ⇒ EACCES: mkdir '/node_modules'）。
  //  统一走 shimDirResolveLines()：--dir > 有效 $PWD > --profile > host-ready.json。
  //  【注意】这里必须先于下面的 argv 扫描：扫描会消费 `--profile <p>`，而
  //  shimDirResolveLines 需要看到原始 "$@" 才能取到 --profile 的值。
  ...shimDirResolveLines(),
  'if [ "$1" = "--version" ] || [ "$1" = "-v" ]; then',
  '  echo "dsh 0.1.7-rc.1 (dshm install-queue shim)"',
  '  exit 0',
  'fi',
  //  argv 扫描：跳过 `plugin` 与 `--profile <p>`；install/add 收首个非选项参数
  //  为 spec（preparePluginArgs 注入的 --config.*/--registry=* 等 flag 全被 -*)
  //  分支跳过）；remove 单列（队列只有装通道）。
  'cmd=""',
  'spec=""',
  'prev=""',
  //  【P1-3】allow-version 的两个专属参数。RUNTIME_OPT 留空 ⇒ Host 用当前运行时
  //  （上游 setProfileVersionExemption 会拒绝"批准一个没在跑的版本"，所以留空比瞎填安全）。
  'RUNTIME_OPT=""',
  'want_risk=0',
  'for a in "$@"; do',
  '  case "$a" in',
  '    plugin) prev="plugin"; continue ;;',
  '    --profile) prev="--profile"; continue ;;',
  '    --dsh-version) prev="--dsh-version"; continue ;;',
  '    --dsh-version=*) RUNTIME_OPT="${a#--dsh-version=}"; prev=""; continue ;;',
  '    --accept-risk) want_risk=1; prev=""; continue ;;',
  '    install|add) cmd="$a"; prev=""; continue ;;',
  '    remove|rm|uninstall) cmd="remove"; prev=""; continue ;;',
  //  上游 core 的子命令名逐字（plugin-DkYIj96-.js：allow-version / revoke-version /
  //  version-exemptions）；接受它才是"端侧可达"，否则用户只能看到那句英文引导却无从执行。
  '    allow-version|revoke-version) cmd="$a"; prev=""; continue ;;',
  '    version-exemptions) cmd="exemptions"; prev=""; continue ;;',
  '    -*) prev=""; continue ;;',
  '    *)',
  '      if [ "$prev" = "--profile" ]; then prev=""; continue; fi',
  //  必须消费 --dsh-version 的**值**：不消费的话它会掉进下面的 spec 判定，
  //  变成"包名 = 0.2.0-rc.1"（于是 `allow-version --dsh-version 0.2.0-rc.1` 缺包名时
  //  不报错，反而拿版本号当包名去申请豁免）。
  '      if [ "$prev" = "--dsh-version" ]; then RUNTIME_OPT="$a"; prev=""; continue; fi',
  '      if [ -n "$cmd" ] && [ -z "$spec" ]; then spec="$a"; fi',
  '      prev=""',
  '      ;;',
  '  esac',
  'done',
  'if [ "$cmd" = "install" ] || [ "$cmd" = "add" ]; then',
  '  if [ -z "$spec" ]; then',
  '    echo "dsh(shim): install 未给包名（端侧跳过 lockfile 重建类调用）"',
  '    exit 0',
  '  fi',
  '  base="cli-$(date +%s)-$$"',
  '  while [ -f "$QDIR/$base.req" ] || [ -f "$QDIR/$base.done" ] || [ -f "$QDIR/$base.fail" ]; do',
  '    sleep 1',
  '    base="cli-$(date +%s)-$$"',
  '  done',
  '  echo "$spec" > "$QDIR/$base.req" || { echo "dsh(shim): 队列写入失败：$spec" >&2; exit 1; }',
  "  printf \"%s\" \"$DIR_OPT\" > \"$QDIR/$base.dir\" 2>/dev/null",
  '  echo "dsh(shim): 已投递安装请求：$spec（等待 Host 安装结果…）"',
  '  i=0',
  '  max_loop="$SHIM_WAIT_MAX"',
  '  if [ -z "$max_loop" ]; then',
  '    max_loop=3360',
  '  fi',
  '  while [ $i -lt $max_loop ]; do',
  '    if [ -f "$QDIR/$base.done" ]; then',
  '      cat "$QDIR/$base.done"',
  '      rm -f "$QDIR/$base.done" 2>/dev/null',
  '      echo "dsh(shim): 安装成功：$spec（插件行已写入，重启应用后随 profile 挂载生效）"',
  '      exit 0',
  '    fi',
  '    if [ -f "$QDIR/$base.fail" ]; then',
  '      echo "dsh(shim): 安装失败：$spec" >&2',
  '      cat "$QDIR/$base.fail" >&2',
  '      rm -f "$QDIR/$base.fail" 2>/dev/null',
  '      exit 1',
  '    fi',
  '    sleep 0.5',
  '    i=$((i+1))',
  '    if [ $((i % 120)) -eq 0 ]; then',
  '      echo "dsh(shim): 仍在等待 Host 安装 $spec（已等 $((i / 2))s，下载大包较慢属正常）…"',
  '    fi',
  '  done',
  '  echo "dsh(shim): $spec 仍在后台安装中（本次等待已达上限，安装不会中断）" >&2',
  '  exit 1',
  'fi',
  //  【补卸载】同理（上 comment）：dsh plugin remove <spec> 投递 .rem 卸载队列，
  //  避免市场侧「卸载」每次都是拒绝。QDIR 定义见 shim 顶部。
  'if [ "$cmd" = "remove" ]; then',
  '  if [ -z "$spec" ]; then',
  '    echo "dsh(shim): 卸载需要包名（端侧：投递卸载队列）" >&2',
  '    exit 1',
  '  fi',
  '  base="rem-$(date +%s)-$$"',
  '  while [ -f "$QDIR/$base.req" ] || [ -f "$QDIR/$base.rem" ] || [ -f "$QDIR/$base.done" ] || [ -f "$QDIR/$base.fail" ]; do',
  '    sleep 1',
  '    base="rem-$(date +%s)-$$"',
  '  done',
  '  echo "$spec" > "$QDIR/$base.rem" || { echo "dsh(shim): 卸载请求写入失败：$spec" >&2; exit 1; }',
  //  【报告 7 §1a 的"remove 也要写 .dir"】卸载同样需要知道**目标 profile**：
  //  宿主 removeSpec 按 .dir 定位要删的是哪个 profile 树（否则回退宿主默认 profile，
  //  与安装时的 --dir 不一致时就会"装在 A、卸在 B"）。归一化逻辑复用同一个函数。
  "  printf \"%s\" \"$DIR_OPT\" > \"$QDIR/$base.dir\" 2>/dev/null",
  '  echo "dsh(shim): 已投递卸载请求：$spec（等待 Host 卸载结果…）"',
  '  got=0',
  '  i=0',
  '  max_loop="$SHIM_WAIT_MAX"',
  '  if [ -z "$max_loop" ]; then',
  '    max_loop=600',
  '  fi',
  '  while [ $i -lt $max_loop ]; do',
  '    if [ -f "$QDIR/$base.done" ]; then',
  '      cat "$QDIR/$base.done"',
  '      rm -f "$QDIR/$base.done" 2>/dev/null',
  '      got=1',
  '      break',
  '    fi',
  '    if [ -f "$QDIR/$base.fail" ]; then',
  '      echo "dsh(shim): 卸载失败：$spec" >&2',
  '      cat "$QDIR/$base.fail" >&2',
  '      rm -f "$QDIR/$base.fail" 2>/dev/null',
  '      got=1',
  '      exit 1',
  '    fi',
  '    sleep 0.5',
  '    i=$((i+1))',
  '    if [ $((i % 60)) -eq 0 ]; then',
  '      echo "dsh(shim): 仍在等待 Host 卸载 $spec（已等 $((i / 2))s）…"',
  '    fi',
  '  done',
  '  if [ $got -eq 0 ]; then',
  '    echo "dsh(shim): $spec 卸载请求仍在后台处理中"',
  '  fi',
  '  exit 0',
  'fi',
  //  【P1-3 兼容性豁免】0.2.0-rc.1 对 peer 锁 0.1.x 的插件会拒绝挂载，并提示
  //  「grant the exact-version exemption … with `dsh plugin allow-version`」。
  //  端侧此前没有这个子命令 ⇒ 用户面对"插件被跳过"毫无自助手段（且插件管理器
  //  恰好就是被跳过的那一个，鸡生蛋）。此处把它接到与安装同一条队列通道。
  'if [ "$cmd" = "allow-version" ] || [ "$cmd" = "revoke-version" ] || [ "$cmd" = "exemptions" ]; then',
  '  if [ "$cmd" = "exemptions" ]; then',
  '    payload=\'{"action":"list"}\'',
  '  else',
  '    if [ -z "$spec" ]; then',
  `      echo "dsh(shim): $cmd 需要 <包名>@<精确版本>（如 dshmarket@1.66.2）" >&2`,
  '      exit 1',
  '    fi',
  //  白名单校验：JSON 是把参数拼进文本里的，含引号/反斜杠/空白就会写出非法 JSON，
  //  而 Host 只能回一句"不是合法 JSON"——用户看不出是自己参数里的哪个字符。
  //  包名与精确版本的合法字符集就是这些，其余一律在这里挡掉并说明原因。
  '    case "$spec" in',
  '      *[!A-Za-z0-9._@/+-]*)',
  '        echo "dsh(shim): 包名/版本含非法字符（只允许字母数字与 . _ @ / + -）：$spec" >&2',
  '        exit 1',
  '        ;;',
  '    esac',
  '    if [ "$cmd" = "revoke-version" ]; then enabled=false; else enabled=true; fi',
  '    if [ $want_risk -eq 1 ]; then risk=true; else risk=false; fi',
  `    payload=$(printf '{"action":"set","packageVersion":"%s","runtimeVersion":"%s","enabled":%s,"acceptRisk":%s}' "$spec" "$RUNTIME_OPT" "$enabled" "$risk")`,
  '  fi',
  '  base="cmp-$(date +%s)-$$"',
  '  while [ -f "$QDIR/$base.compat-req" ] || [ -f "$QDIR/$base.done" ] || [ -f "$QDIR/$base.fail" ]; do',
  '    sleep 1',
  '    base="cmp-$(date +%s)-$$"',
  '  done',
  '  echo "$payload" > "$QDIR/$base.compat-req" || { echo "dsh(shim): 队列写入失败：$payload" >&2; exit 1; }',
  '  printf "%s" "$DIR_OPT" > "$QDIR/$base.dir" 2>/dev/null',
  '  echo "dsh(shim): 已投递兼容性豁免请求（等待 Host 结果…）"',
  '  i=0',
  '  max_loop="$SHIM_WAIT_MAX"',
  '  if [ -z "$max_loop" ]; then',
  '    max_loop=240',
  '  fi',
  '  while [ $i -lt $max_loop ]; do',
  '    if [ -f "$QDIR/$base.done" ]; then',
  '      cat "$QDIR/$base.done"',
  '      rm -f "$QDIR/$base.done" 2>/dev/null',
  '      exit 0',
  '    fi',
  '    if [ -f "$QDIR/$base.fail" ]; then',
  '      echo "dsh(shim): 兼容性豁免请求失败" >&2',
  '      cat "$QDIR/$base.fail" >&2',
  '      rm -f "$QDIR/$base.fail" 2>/dev/null',
  '      exit 1',
  '    fi',
  '    sleep 0.5',
  '    i=$((i+1))',
  '  done',
  '  echo "dsh(shim): 兼容性豁免请求仍在处理中（本次等待已达上限）" >&2',
  '  exit 1',
  'fi',
  'echo "dsh(shim): 端侧支持 plugin install <包名|GitHub地址> / plugin remove <包名> / plugin allow-version <包名>@<精确版本> --accept-risk / plugin version-exemptions（收到：$*）" >&2',
  'exit 1',
];

/**
 * 布置 pnpm/npm/npx 假壳到 busybox bin（PATH 最前 ⇒ 遮蔽系统不存在的真身）。
 * 幂等：每次启动重写（HOME_DIR 若变化随重写生效）；chmod+X_OK 与 busybox 同
 * 策略，但失败只记日志不阻塞——假壳缺失时退化为原始 127 行为，不伤已验证链路。
 */
function ensureCliShims(binDir) {
  if (!binDir || binDir.length === 0) {
    return; // busybox 未布置（PATH 未注入）：假壳无处生效
  }
  if (HOME_DIR.length === 0) {
    return; // HOME_DIR 未解析（写死路径会成空串）：不布置，退化为 127 行为
  }
  const installScript = CLI_SHIM_LINES.join('\n') + '\n';
  const npxScript = NPX_SHIM_LINES.join('\n') + '\n';
  const dshScript = DSH_SHIM_LINES.join('\n') + '\n';
  for (const [name, script] of [['pnpm', installScript], ['npm', installScript], ['npx', npxScript], ['dsh', dshScript]]) {
    if (!rewriteExecutable(path.join(binDir, name), (d) => fs.writeFileSync(d, script), `CLI 假壳：${name}`)) {
      return;
    }
  }
  diag('CLI 假壳：pnpm/npm/npx/dsh 已布置为安装队列通道（pnpm add / dsh plugin install 即投递队列，view 转发 Host registry 端点）');
  log('CLI 假壳：pnpm/npm/npx/dsh 已布置为安装队列通道');
}

/**
 * 端侧工具链：CPython 3.12 + git（resfile 携带归档 → 沙箱后台解包自举）。
 *
 * 【为什么自带】沙箱里只有 busybox + node，模型跑 `git …` / `python3 …` 直接 127。
 * resfile/toolchain/ 放 python-build-standalone musl 归档 + Alpine git apk 组
 * （tools/place-toolchain.mjs 放置），首次启动解到 <SANDBOX_HOME>/toolchain/。
 *
 * 【为什么必须后台】python 归档 28.6MB/4530 文件，hmfs 上同步解包会卡住 Host
 * 事件循环（boot 探针等 HTTP 探测会超时）。因此拆两层：wrapper 布置轻量同步
 * （先占住 PATH 名字），归档解包走 spawn 子进程，完成回调里做收尾与验证。
 *
 * 【hmfs 禁 symlink 的后果】busybox tar 对归档里的 symlink 条目（usr/bin/
 * git-receive-pack → git、git-core/git-remote-https → git-remote-http …）会打
 * "Cannot create …" 警告并**继续**（与 D6 §4.1.3 沙箱 symlink 探针结论一致）。
 * 真身 ELF 全部解出；git-remote-https 这类 https 拉取必需的 symlink 用复制本体
 * 补齐（git 子命令按 argv[0] 分发，拷贝等价）。python 的 bin/python3 symlink
 * 不补——wrapper 直接指 python3.12 真身。
 */
const TOOLCHAIN_DIR = path.join(SANDBOX_HOME, 'toolchain');
const PYTHON_PREFIX = path.join(TOOLCHAIN_DIR, 'python');
const GIT_ROOT = path.join(TOOLCHAIN_DIR, 'gitroot');
const PYTHON_TARBALL_REL = path.join('toolchain', 'python', 'cpython-3.12.14-aarch64-musl.tar.gz');
// resfile 根（entryScript = <res>/resources/app/main.js ⇒ __dirname 上两级）。
// 模块级定义：ensureExecutables / 顶层块都要用（顶层块的 resRoot 与它同值）。
const RES_ROOT = path.resolve(__dirname, '..', '..');
/*
 * hmfs 上解不出的 symlink → 用**真身拷贝**补齐：`[名, 相对真身]`。
 *
 * 【历史】这里原先硬编码一条 `['git-remote-https','git-remote-http']`，因为当时只
 * 撞上那一个。报告 5 §2.3 追查 git 子进程时发现**真正的大头没被覆盖**：
 * `usr/libexec/git-core/` 下有 **141 个 symlink**，其中 **138 个都指向 `../../bin/git`**
 * （git 靠 argv[0] 分发子命令，所以每个子命令都是一个指向本体的链接），另外 3 个
 * 指向 `git-remote-http`。端侧 tar 解包这些 symlink 全部失败 → `git-upload-pack`
 * 等**一个都不存在** → `git clone` 即便过了 abort 那一关也走不下去
 * （真机实测 stderr：`git-upload-pack: inaccessible or not found`）。
 *
 * 【为什么改成动态读取】141 个名字会随 git 版本变（上游随时加子命令），硬编码一份
 * 名单就是"下次升级静默失效"。这里直接**从包的归档里读 symlink 表**（apk 是 tar.gz，
 * 读 512 字节头即可，不需要解包），按需复制真身——名字永远与这一版 git 一致。
 * 读不到（归档缺失/格式变化）时退回原来的硬编码一条，保证不退化。
 */
const GIT_SYMLINK_REPLICA_FALLBACK = [['git-remote-https', 'git-remote-http']];

/**
 * 从 git 的 apk 里读出 `usr/libexec/git-core/` 下的 symlink 表。
 * 纯 JS 遍历 tar（512 字节头 + 512 对齐的数据块）：apk = tar.gz，先 gunzip 再扫。
 * @param apkPath git-*.apk 路径
 * @returns `[[名, 真身], …]`；读不到返回 null（调用方退回 fallback）
 */
function readGitCoreSymlinks(apkPath) {
  try {
    if (statSize(apkPath) <= 0) {
      return null;
    }
    const raw = zlib.gunzipSync(fs.readFileSync(apkPath));
    const out = [];
    let off = 0;
    while (off + 512 <= raw.length) {
      const nameField = raw.slice(off, off + 100).toString('utf8').replace(/\0[\s\S]*$/, '');
      if (nameField.length === 0) {
        break; // tar 结束标记
      }
      const sizeField = raw.slice(off + 124, off + 136).toString('ascii').replace(/\0/g, '').trim();
      const size = parseInt(sizeField, 8) || 0;
      const type = String.fromCharCode(raw[off + 156] || 0);
      const linkField = raw.slice(off + 157, off + 257).toString('utf8').replace(/\0[\s\S]*$/, '');
      // type '2' = symlink；只收 git-core 下的
      const prefix = 'usr/libexec/git-core/';
      if (type === '2' && nameField.startsWith(prefix) && linkField.length > 0) {
        const base = nameField.slice(prefix.length);
        // 跳过子目录条目（只补顶层子命令）
        if (base.length > 0 && base.indexOf('/') < 0) {
          out.push([base, linkField]);
        }
      }
      off += 512 + Math.ceil(size / 512) * 512;
    }
    return out.length > 0 ? out : null;
  } catch (e) {
    return null;
  }
}

/**
 * python3/pip3 垫片的"桥模式"回退段（exec 探测失败后追加的行）：
 * - token 双源：env DSHM_PYTHON_TOKEN（快路径）→ host-ready.json（主通道，
 *   垫片每次调用现读，修 DSHM 垫片"token 注入滞后 30-90s"的窗口期缺陷）。
 * - 沙箱 shell 里 toybox wget 只能 GET（DSHM 实证）：argv 逐参 sed 最小
 *   URL 编码后以 %1f 分隔（端点 URL decode 后按 \x1f 切分）。
 * - 响应 JSON 用 sed 提取 stdout/errStderr/rc（rc 是 repr 字符串
 *   "None"/"0"/"N"，DSHM 垫片同款解析），退出码透传。
 * pipMode：pip3 等价 python3 -m pip（argv 固定前缀 -m pip）；否则 argv[0]
 * 现场解析——脚本相对路径 resolve 成 $(pwd)/x 绝对路径（端点按沙箱树做
 * 安全校验，且不受 dsh 进程 cwd 与 shell cwd 不一致的影响，修 DSHM 缺陷）。
 */
function pythonBridgeShimLines(label, usage, pipMode) {
  const lines = [
    '# ── 桥模式：execve 被系统策略拒绝，转发宿主进程内嵌 CPython（/dshm-python/exec）──',
    'TOKEN="${DSHM_PYTHON_TOKEN:-}"',
    'if [ -z "$TOKEN" ]; then',
    `  TOKEN=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "${HOME_DIR}/host-ready.json" 2>/dev/null)`,
    'fi',
    'if [ -z "$TOKEN" ]; then',
    `  echo "${label}：桥 token 未就绪（host 尚在启动？稍后重试，或查看 host-ready.json）" >&2`,
    '  exit 1',
    'fi',
    // pipMode 不拦截 -V/--version：让它走下方 -m pip 前缀转发、输出真实 pip 版本
    // （2026-09-23 修复：此前 pip3 --version 被 Python banner 分支吞掉，真机实测
    //  exit 0 但无 "pip 26.x" 字样；pip 本体无恙，exec -m pip list 实测正常）。
    'case "${1:-}" in',
    ...(pipMode ? [] : [
      '  -V|--version)',
      '    echo "Python 3.12.14 (DSHM embedded CPython, in-process bridge)"',
      '    exit 0',
      '    ;;',
    ]),
    '  -h|--help)',
    `    echo "usage: ${usage}"`,
    '    exit 0',
    '    ;;',
    'esac',
    'if [ $# -eq 0 ]; then',
    `  echo "${label}：交互式模式不支持（桥模式）" >&2`,
    `  echo "usage: ${usage}" >&2`,
    '  exit 2',
    'fi',
    'enc() {',
    "  printf \"%s\" \"$1\" | sed -e 's/%/%25/g' -e 's/ /%20/g' -e 's/&/%26/g' -e 's/+/%2B/g'"
      + " -e 's/?/%3F/g' -e 's/=/%3D/g' -e 's/\"/%22/g' -e 's/</%3C/g' -e 's/>/%3E/g' -e 's/#/%23/g'",
    '}',
  ];
  if (pipMode) {
    lines.push(
      'ARGQ="-m%1f$(enc pip)"',
      'for a in "$@"; do',
      '  ARGQ="$ARGQ%1f$(enc "$a")"',
      'done',
    );
  } else {
    lines.push(
      'FIRST="$1"',
      'shift',
      'case "$FIRST" in',
      `  -) echo "${label}：stdin 模式不支持（桥模式），请传脚本路径" >&2`,
      '    exit 2',
      '    ;;',
      '  -c|-m|/*) ;;',
      '  *)',
      '    if [ -f "$FIRST" ]; then FIRST="$(pwd)/$FIRST"; fi',
      '    ;;',
      'esac',
      'ARGQ=$(enc "$FIRST")',
      'for a in "$@"; do',
      '  ARGQ="$ARGQ%1f$(enc "$a")"',
      'done',
    );
  }
  lines.push(
    `  OUT=$(wget -O - "http://127.0.0.1:${PORT}/dshm-python/exec?token=$TOKEN&argv=$ARGQ" 2>/dev/null)`,
    'if [ -z "$OUT" ]; then',
    `  echo "${label}：桥调用失败（端点不可达或 token 失效；详见 dshm-host.log）" >&2`,
    '  exit 1',
    'fi',
    "  STDOUT=$(printf \"%s\" \"$OUT\" | sed -n 's/.*\"stdout\":\"\\([^\"]*\\)\".*/\\1/p' | sed -e 's/\\\\n/\\n/g' -e 's/\\\\\"/\"/g')",
    "  ERRS=$(printf \"%s\" \"$OUT\" | sed -n 's/.*\"errStderr\":\"\\([^\"]*\\)\".*/\\1/p' | sed -e 's/\\\\n/\\n/g' -e 's/\\\\\"/\"/g')",
    "  RC=$(printf \"%s\" \"$OUT\" | sed -n 's/.*\"rc\":\"\\([^\"]*\\)\".*/\\1/p')",
    '  [ -n "$STDOUT" ] && printf "%s\\n" "$STDOUT"',
    '  [ -n "$ERRS" ] && printf "%s\\n" "$ERRS" >&2',
    '  case "$RC" in',
    '    ""|None|0|"0") exit 0;;',
    '    *[!0-9]*) exit 1;;',
    '    *) exit "$RC";;',
    '  esac',
  );
  return lines;
}

function toolchainWrapperScript(name) {
  // exec 被系统策略拒绝时（真机 E1-E19 实证：execve 白名单只放行系统已知
  // 内容），wrapper 给出明确降级文案替代裸 126 "Permission denied"。探测在
  // 子 shell 内做（exec 失败不杀父脚本）；真身缺失（解包中）与被策略拒绝
  // 分别提示。真身可 exec 的设备行为不变（探测通过即正式 exec）。
  const unavailable = (label) =>
    `echo "${label}：该设备系统策略禁止运行第三方原生二进制（execve 被拒），暂不可用" >&2`;
  if (name === 'python' || name === 'python3') {
    return [
      '#!/system/bin/sh',
      '# DSHM python wrapper：能 exec 真身就 exec（行为不变），否则桥模式（进程内 CPython）',
      `P=${PYTHON_PREFIX}`,
      'export PYTHONHOME="$P"',
      'if [ ! -x "$P/bin/python3.12" ]; then',
      '  echo "python3：解释器尚未就位（首次启动解包中），稍后重试" >&2',
      '  exit 127',
      'fi',
      'if ( exec "$P/bin/python3.12" --version ) >/dev/null 2>&1; then',
      '  exec "$P/bin/python3.12" "$@"',
      'fi',
      ...pythonBridgeShimLines(
        'python3',
        'python3 -c <code> | python3 <script.py> [args...] | python3 -m <module> [args...]',
        false,
      ),
    ];
  }
  if (name === 'pip3') {
    return [
      '#!/system/bin/sh',
      '# DSHM pip wrapper：能 exec 真身就 -m pip（行为不变），否则桥模式（-m pip 走 exec 端点）',
      `P=${PYTHON_PREFIX}`,
      'export PYTHONHOME="$P"',
      'if [ ! -x "$P/bin/python3.12" ]; then',
      '  echo "pip3：解释器尚未就位（首次启动解包中），稍后重试" >&2',
      '  exit 127',
      'fi',
      'if ( exec "$P/bin/python3.12" --version ) >/dev/null 2>&1; then',
      '  exec "$P/bin/python3.12" -m pip "$@"',
      'fi',
      ...pythonBridgeShimLines('pip3', 'pip3 <pip-args...>（桥模式等价 python3 -m pip <args>）', true),
    ];
  }
  /*
   * git 包装：能 exec 真身就 exec；**子进程类子命令另有兜底**（报告 5 §2.3）。
   *
   * 【为什么子命令要分流】真机实测：`init/add/commit/log/status` 正常，而
   * `clone/fetch/pull/push/ls-remote` 这类**要起子进程**的命令一律 rc=134（SIGABRT），
   * 原文：
   *     BUG: run-command.c:525: disabling cancellation: Operation not permitted
   * 定位：`run-command.c` 的 `atfork_prepare()` 用 `CHECK_BUG()` 包了
   * `pthread_setcancelstate(PTHREAD_CANCEL_DISABLE, &as->cs)`；该调用在鸿蒙 musl 上
   * 返回非零（EPERM），`CHECK_BUG` 直接 `BUG()` → abort。**不是 git 的用法错，是
   * 平台 libc 的这个调用不成立**。
   *
   * 【为什么不是重编 git】git 是动态链接的 PIE，`DT_NEEDED libc.musl-aarch64.so.1`
   * ——用的是**系统 musl**（我们没随包带 libc），重编得配整套 Alpine musl 交叉工具链。
   *
   * 【本层做什么】按报告的"最低限度"：这些子命令**直接给出明确不可用提示**，
   * 而不是让用户看到一个 core dump（rc=134 连原因都读不出来）。同时**优先尝试
   * LD_PRELOAD 垫片**（若构建期放进了 libs/ 的 `libdshm-gitcompat.so`）：垫片把
   * `pthread_setcancelstate` 变成成功返回，那就真能跑通——能跑就跑，跑不通再提示。
   * 这样"垫片是否生效"由实测决定，不靠猜。
   */
  const SUBPROC_CMDS = 'clone|fetch|pull|push|ls-remote|remote|submodule|worktree|archive|gc|repack|prune|fsck';
  /*
   * 垫片路径：与 koffi/python_runner 同一个投放口（HAP 的 libs/arm64/，见 NATIVE_LIBS
   * 的注释——只有这里 dlopen/加载才被系统放行）。NATIVE_LIBS 为空（PC 侧离线跑）时
   * 退化成相对名，那条分支只在设备上才有意义。
   */
  const gitCompatLib = NATIVE_LIBS.length > 0
    ? path.join(NATIVE_LIBS, 'libdshm-gitcompat.so')
    : '';
  return [
    '#!/system/bin/sh',
    '# DSHM git wrapper：Alpine git + 自带 so + CA 证书（LD_LIBRARY_PATH 自举）',
    `G=${GIT_ROOT}`,
    'export LD_LIBRARY_PATH="$G/usr/lib"',
    'export GIT_EXEC_PATH="$G/usr/libexec/git-core"',
    'export GIT_SSL_CAINFO="$G/etc/ssl/certs/ca-certificates.crt"',
    // 【顺带（报告 §2.3 末）】git init 的 "templates not found" 警告：随包的
    // templates 目录不存在（apk 里没带），显式指向包内路径，找不到也不报错。
    'if [ -d "$G/usr/share/git-core/templates" ]; then',
    '  export GIT_TEMPLATE_DIR="$G/usr/share/git-core/templates"',
    'fi',
    'if [ ! -x "$G/usr/bin/git" ]; then',
    '  echo "git：尚未就位（首次启动解包中），稍后重试" >&2',
    '  exit 127',
    'fi',
    'if ( exec "$G/usr/bin/git" --version ) >/dev/null 2>&1; then',
    '  :',
    'else',
    `  ${unavailable('git')}`,
    '  exit 126',
    'fi',
    // 子命令分流：先摘出子命令名（跳过 -c key=val / --flags）。
    'sub=""',
    'skipnext=0',
    'for a in "$@"; do',
    '  if [ $skipnext -eq 1 ]; then skipnext=0; continue; fi',
    '  case "$a" in',
    '    -c) skipnext=1 ;;',
    '    -*) ;;',
    '    *) sub="$a"; break ;;',
    '  esac',
    'done',
    'case "$sub" in',
    `  ${SUBPROC_CMDS})`,
    // ① 有垫片就先试垫片：它把平台判失败的 pthread_setcancelstate/sigmask 改判成功
    `    P="${gitCompatLib}"`,
    '    if [ -n "$P" ] && [ -f "$P" ]; then',
    '      LD_PRELOAD="$P" exec "$G/usr/bin/git" "$@"',
    '    fi',
    '    echo "git：该子命令在端侧不可用——它需要 git 起子进程，而平台 libc 不支持" >&2',
    '    echo "     取消点控制（pthread_setcancelstate 返回 EPERM ⇒ git abort，rc=134）" >&2',
    '    echo "     本地命令（init/add/commit/log/status/diff）正常，远端操作请在 PC 侧执行。" >&2',
    '    exit 126 ;;',
    'esac',
    'exec "$G/usr/bin/git" "$@"',
  ];
}

/**
 * 布置 python/python3/pip3/git wrapper 到 busybox bin。幂等（每次启动重写）；
 * chmod+X_OK 失败只记日志——wrapper 缺失退化为 127 现状，不伤已验证链路。
 */
function ensureToolchainWrappers(binDir, resRoot) {
  if (!binDir || binDir.length === 0) {
    return; // busybox 未布置：wrapper 无处生效
  }
  if (!fs.existsSync(path.join(resRoot, 'toolchain'))) {
    diag('工具链：resfile 无 toolchain/，跳过 wrapper 布置（PC 侧离线跑属正常）');
    return;
  }
  const names = ['python', 'python3', 'pip3', 'git'];
  for (const name of names) {
    const script = toolchainWrapperScript(name).join('\n') + '\n';
    if (!rewriteExecutable(path.join(binDir, name), (d) => fs.writeFileSync(d, script), `工具链：wrapper ${name}`)) {
      return;
    }
  }
  diag('工具链：python/python3/pip3/git wrapper 已布置（归档解包进行中，就位前 exec 会报 not found）');
}

/**
 * 补齐 core 树里**原生可执行件**的执行位（2026-09-26 报告 3 ③ 的一半）。
 *
 * 【为什么要补】core 树是 ArkTS 侧用 `@ohos.zlib.decompressFile` 解包的，该 API
 * **不保留 zip 里的权限位** ⇒ 解包出来的 `rg` 是 0666（无 x 位），即使签名策略放开
 * 也依然 EACCES。真机实测确认：新构建解包后 `rg` 权限确实是 0666。
 *
 * 【与工具链补位的关系】`finalizeToolchain` 已对 python3.12 / git 做同样的事
 * （"缺了才补"），但它的目标是 `TOOLCHAIN_DIR`（python/git 归档解包产物），
 * **不覆盖 core 树**（rg 与 sharp 的 .node 在 CORE_DIR 下）。这里补上那一片。
 *
 * 【为什么"缺了才补"而不是每次都 chmod】hmfs 上对健康文件做多余 chmod 可能触发
 * EACCES（busybox 布置的真机教训）；只在 mode 确实没有 x 位时动它。
 * 【失败只 diag】这是增量能力（exec 是否真能跑还取决于签名域策略），不应影响启动。
 */
function ensureCoreExecBits() {
  if (CORE_DIR.length === 0) {
    return;
  }
  const targets = [];
  // ripgrep 真身（fs-search 的 spawn 目标 + rg wrapper 的转发目标）
  targets.push(path.join(CORE_DIR, 'node_modules', '@vscode', 'ripgrep-linux-arm64', 'bin', 'rg'));
  // sharp 的原生件（可选原生库，存在才补）
  for (const rel of [
    path.join('@ohos-ports', 'img-sharp-openharmony-arm64', 'lib', 'sharp-openharmony-arm64.node'),
  ]) {
    targets.push(path.join(CORE_DIR, 'node_modules', rel));
  }
  let fixed = 0;
  for (const p of targets) {
    try {
      if (statSize(p) <= 0) {
        continue;
      }
      if ((fs.statSync(p).mode & 0o111) === 0) {
        fs.chmodSync(p, 0o755);
        fixed += 1;
        diag(`core 执行位：已补 0755 → ${p}`);
      }
    } catch (e) {
      diag(`core 执行位：${path.basename(p)} 补齐失败（不阻塞）：${String(e).slice(0, 120)}`);
    }
  }
  if (fixed > 0) {
    diag(`core 执行位：本次补了 ${fixed} 个（解包工具不保留权限位）`);
  }
}

/**
 * rg wrapper：把 core 树自带的 ripgrep 挂进 PATH（bash 里 `rg` 可用；fs-search
 * 工具走自己的 rgPath 解析，不经此 wrapper，但 ensureExecutables 会同批探测）。
 * CORE_DIR 未就绪（首装 boot，state.json 尚无 current）时跳过——下次 boot 补。
 */
function ensureRipgrepWrapper(binDir) {
  if (!binDir || binDir.length === 0 || CORE_DIR.length === 0) {
    return;
  }
  const rg = path.join(CORE_DIR, 'node_modules', '@vscode', 'ripgrep-linux-arm64', 'bin', 'rg');
  if (statSize(rg) <= 0) {
    diag('rg wrapper：core 树暂无 rg（首装 boot 正常），下次启动布置');
    return;
  }
  /*
   * 【2026-09-26 实验结论：物化到 bin/ 不能解锁 execve】
   * 曾试过把 rg 字节由本进程复制到 bin/rg-real（与可用的 busybox 同目录、同创建者），
   * 期望复现"本进程创建即可执行"。真机读数否定了这条假设：
   *     exec 探测：… rg=denied，rg-real=denied，bash=ok
   * 真正的分界不是"谁创建"，而是 **ELF 与脚本**，以及**首行解释器可不可 exec**：
   *   · `bash` 垫片当时可跑 —— 它是 `#!/system/bin/sh` 脚本，且**当时的**探针读数是
   *     `/system/bin/sh` 可 exec。后续真机取证**推翻**了这条基线：`sh="x-no:13"`，
   *     `u:object_r:sh_exec:s0` 被 MAC 拒绝 ⇒ 同形态垫片今天必死于第一行。现已改为
   *     `#!<binDir>/ash`，而 `ash` 在本档同样 `denied` ⇒ 垫片在本档不生效
   *     （见 bashShimLines 的"手机档内不生效"一节；保留理由是无害 + 为其它档位预留
   *     + 提供 exec 探针）；
   *   · `rg`/`git`/python 真身是**第三方 ELF**，execve 被**签名域/MAC 策略**拒绝
   *     （与创建者/inode/执行位无关；`rg-real=denied` 与这条一致）。
   * ⇒ 解锁它们的唯一路径是**构建期签名**（binary-sign-tool），见 tools/ 的签名步骤；
   * 物化路径已撤销，只在探测里保留 rg 一行。
   */
  const script = [
    '#!/system/bin/sh',
    '# DSHM rg wrapper：转发 core 树自带 ripgrep（exec 被拒时明确降级）',
    `R="${rg}"`,
    'if ( exec "$R" --version ) >/dev/null 2>&1; then',
    '  exec "$R" "$@"',
    'fi',
    'echo "rg：该设备系统策略禁止运行第三方原生二进制（execve 被拒），暂不可用" >&2',
    'exit 126',
  ].join('\n') + '\n';
  if (rewriteExecutable(path.join(binDir, 'rg'), (d) => fs.writeFileSync(d, script), 'rg wrapper')) {
    diag('rg wrapper：已布置（exec 真身被拒时明确降级；解锁需构建期签名）');
  }
}

/**
 * 工具链归档的**签名版本标记**（报告 4 ③，2026-09-26）。
 *
 * 【为什么需要它】设备侧解包判据是"**存在即跳过**"（`gitReady()`/`pythonReady()` 只看
 * 文件在不在）。构建期给归档里的 ELF 加了自签名后，若不改变这个判据，**新归档永远
 * 不会被解包**——用户看到的仍是旧的无签名文件，`git`/`python3.12` 继续 denied。
 * 这正是报告里"git mtime 仍是 09-22"的成因。
 *
 * 【做法】构建期在 `resfile/toolchain/{git,python}/dshm-signed.txt` 写一个小标记；
 * 端侧把它复制到解包目录并比对：内容不一致 ⇒ 归档换代 ⇒ 强制重解。
 * 标记只承载"归档是哪个签名版本"，不参与任何功能判据。
 */
const TOOLCHAIN_SIGN_MARKER = 'dshm-signed-v1';
/**
 * 标记文件名。**不能以点开头**——HAP 打包会丢掉 resfile 里所有 dotfile 条目
 * （实测：打包产物中"以点开头的条目数"为 0），标记传不到设备，换代判定就永远
 * 不触发，新签名的归档也就永远不被解包。构建端 tools/place-toolchain.mjs 同名。
 */
const TOOLCHAIN_SIGN_MARKER_FILE = 'dshm-signed.txt';

/**
 * 归档目录里的标记内容（读不到返回空串 = 未知/旧包，按"需要重解"处理）。
 * @param dir 归档目录（resfile 下的 git/ 或 python/）
 */
function readArchiveSignMarker(dir) {
  try {
    return fs.readFileSync(path.join(dir, TOOLCHAIN_SIGN_MARKER_FILE), 'utf8').trim();
  } catch (e) {
    return '';
  }
}

/**
 * 解包产物目录里的标记内容（读不到返回空串）。
 * @param dir 解包目标目录（TOOLCHAIN_DIR 下的 gitroot/ 或 python/）
 */
function readExtractedSignMarker(dir) {
  return readArchiveSignMarker(dir);
}

function pythonReady() {
  // 双锚点：解释器真身 + 纯 py 标准库标志文件（防上次中断留下半成品）
  return statSize(path.join(PYTHON_PREFIX, 'bin', 'python3.12')) > 0
    && statSize(path.join(PYTHON_PREFIX, 'lib', 'python3.12', 'os.py')) > 0;
}

function gitReady() {
  return statSize(path.join(GIT_ROOT, 'usr', 'bin', 'git')) > 0
    && statSize(path.join(GIT_ROOT, 'usr', 'libexec', 'git-core', 'git')) > 0
    && statSize(path.join(GIT_ROOT, 'usr', 'lib', 'libcurl.so.4')) > 0;
}

/**
 * 已解包的工具链是否需要**因归档换代而重解**（报告 4 ③）。
 *
 * 判据：解包目录里的标记 ≠ 归档目录里的标记。两者都为空（旧包/未解包）时返回 false
 * （交给 pythonReady/gitReady 的原有判据决定）；归档有新标记而已解包目录没有 ⇒ true。
 * @param archiveDir 归档目录；@param extractedDir 解包目标目录
 */
function needsReextractForSign(archiveDir, extractedDir) {
  const want = readArchiveSignMarker(archiveDir);
  if (want.length === 0) {
    return false; // 归档没有标记：按原有"存在即跳过"逻辑走
  }
  return readExtractedSignMarker(extractedDir) !== want;
}

/*
 * ── 内嵌 Python 桥（execve 白名单的进程内替代通道）──────────────────────
 *
 * 【背景】exec 管控定案（E1-E19 + DSHM/WorkBuddy 交叉验证）：沙箱内第三方
 * ELF 的 execve 一律被签名域策略拒绝（python3.12/git/rg 全部 126），但 dlopen
 * 只放行 HAP 安装的 libs/<abi>/（koffi/sharp 同一通道，E16/E17b 证 resfile 与
 * el2 files/ 都不行）。于是 python 走 DSHM 同设备已实证的形态：libpython 由
 * tools/place-toolchain.mjs 放进 el1 libs，NAPI addon libpython_runner.so
 * （entry/src/main/cpp/python_runner.cpp，hvigor CMake 编译）在本进程内
 * dlopen libpython + dlsym CPython embedding API——bin/python3.12 永远起不
 * 来，但解释器本体已经在我们进程里。
 *
 * 【自检时机】与 ensureExecutables 同款双挂载：稳态 boot 顶层块 + 首次解包
 * 收尾（finishToolchainExtraction）。stdlib 解包齐（pythonReady）才有意义：
 * Py_Initialize 找不到 os.py 会直接 fatal 整个进程（CPython 行为），绝不能
 * 在半成品上试。失败只 diag 不抛——桥是增量能力，任何失败都不许影响
 * 已验证链路。
 */
let pyBridgeSelftestDone = false;
let pyBridge = null;           // addon exports（dlopen 成功即存；HTTP 端点共用）
let pyBridgeLoadTried = false; // addon 加载只试一次（dlopen 失败属硬错误，不重试）

/**
 * 加载 python_runner addon（dlopen libpython + dlsym embedding API 的 JS 侧入口）。
 * 成功后缓存到 pyBridge；失败永久放弃（DSHM 硬错误缓存模式）。env 必须在
 * dlopen 前设好：addon 的 EnsurePythonInit 读 DSHM_PYTHON_LIB/HOME。
 */
function getPyBridge() {
  if (pyBridge) {
    return pyBridge;
  }
  if (pyBridgeLoadTried) {
    return null;
  }
  pyBridgeLoadTried = true;
  if (NATIVE_LIBS.length === 0 || !fs.existsSync(NATIVE_LIBS)) {
    diag('python 桥：NATIVE_LIBS 不可用（PC 侧离线跑属正常），跳过');
    return null;
  }
  const libPy = path.join(NATIVE_LIBS, 'libpython3.12.so.1.0');
  const addon = path.join(NATIVE_LIBS, 'libpython_runner.so');
  if (statSize(libPy) <= 0) {
    diag('python 桥：el1 libs 缺 libpython3.12.so.1.0（place-toolchain 未跑新段？），跳过');
    return null;
  }
  if (statSize(addon) <= 0) {
    diag('python 桥：el1 libs 缺 libpython_runner.so（CMake 未编 python_runner？），跳过');
    return null;
  }
  process.env.DSHM_PYTHON_LIB = libPy;
  process.env.DSHM_PYTHON_HOME = PYTHON_PREFIX;
  try {
    const mod = { exports: {} };
    process.dlopen(mod, addon);
    pyBridge = mod.exports;
    return pyBridge;
  } catch (e) {
    diag(`python 桥：addon 加载异常：${String(e).slice(0, 200).replace(/\s+/g, ' ')}`);
    return null;
  }
}

function ensurePythonBridge() {
  if (pyBridgeSelftestDone) {
    return;
  }
  const bridge = getPyBridge();
  if (bridge === null) {
    // 加载失败细节 getPyBridge 已 diag；标 done 不再重试
    pyBridgeSelftestDone = true;
    return;
  }
  if (!pythonReady()) {
    // 不标 done：首次解包收尾后由第二个挂载点补跑
    diag('python 桥：stdlib 尚未解包就位，本轮跳过（解包收尾后自检）');
    return;
  }
  pyBridgeSelftestDone = true;
  try {
    const ready = bridge.isReady();
    diag(`python 桥：addon 已加载 ready=${ready.ready} initialized=${ready.initialized}`);
    const t0 = Date.now();
    const r = bridge.captureRun('print(1+1)');
    const out = String(r.stdout || '').trim();
    if (r.ok && out === '2') {
      log(`python 桥自检通过：print(1+1)=2（${Date.now() - t0}ms），内嵌 CPython 可用`);
    } else {
      diag(`python 桥自检失败：ok=${r.ok} stdout=${JSON.stringify(out)} rc=${r.rc}`
        + ` error=${r.error || ''} stderr=${String(r.errStderr || '').slice(0, 200).replace(/\s+/g, ' ')}`);
    }
  } catch (e) {
    diag(`python 桥自检异常（调用失败）：${String(e).slice(0, 200).replace(/\s+/g, ' ')}`);
  }
}

/*
 * ── Python HTTP 桥端点（/dshm-python/*，Phase 2）────────────────────────
 *
 * 【动机】execve 白名单设备上，python3/pip3 垫片（toolchainWrapperScript
 * 桥模式分支）需要一个"从 shell 会话调进本进程内嵌解释器"的通道。
 * 沙箱 shell 里 toybox wget 只能 GET（DSHM 实证），执行语义全走 GET：
 *   GET /dshm-python/status                    -> 只读探测（无需 token）
 *   GET /dshm-python/run-get?token&code        -> captureRun(code)，≤64KB
 *   GET /dshm-python/exec?token&argv           -> argv 以 \x1f 分隔，支持
 *      -c <code> | <script.py> [args...] | -m <module> [args...]；
 *      sys.argv 对齐真 python3；脚本路径须在 SANDBOX_HOME/HOME_DIR 树内。
 *   两者均可带 &timeout=<秒>（默认 120，clamp 1..300），超时 rc="124"。
 *
 * 【鉴权】与 DSHM 的差异（修其 30-90s token 窗口期缺陷）：token 主通道是
 * host-ready.json（writeHostReady 落盘的进程 token，垫片每次调用现读，
 * 永不过期失效），env DSHM_PYTHON_TOKEN 只作垫片侧快路径；比对用常数
 * 时间风格（长度不等/逐字符异或，loopback 威胁模型弱但成本为零）。
 *
 * 【守卫】每次执行前 pythonReady() 检查：Py_Initialize 在 stdlib 半成品
 * 上会 fatal 整个进程（CPython 行为），而桥是惰性初始化（captureRun
 * 首调触发 EnsurePythonInit），绝不能在 stdlib 缺失时放行执行端点。
 *
 * 【超时（真机 2026-09-22 教训）】captureRun 是同步 NAPI 调用：Python 跑
 * 多久，node 事件循环就卡多久（期间 dsh web 的 UI/terminal 全部无响应）。
 * 实测曾出现一次 exec -m pip 冷路径卡死整进程（CPU 停滞、status 挂 4 分钟，
 * 只能 force-stop）。因此每个执行请求注入 SIGALRM：超时触发 SystemExit(124)
 * → captureRun 正常捕获返回。默认 120s，query timeout 可调 1..300s。
 * 局限：alarm 只能打断 Python 字节码执行（PEP 475 下被中断的短系统调用
 * 会重试，但检查点频繁，纯 Python 死循环/慢任务可被可靠打断）；若卡在
 * 单次超长 C 层阻塞调用（如无超时的 DNS 解析），alarm handler 要等其
 * 返回才能执行——该残余风险在 ohos-python.md 边界标注。
 */
function pyBridgeSendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

function pyBridgeTokenOk(url) {
  const expected = readHostToken();
  if (expected.length === 0) {
    return false;
  }
  const provided = url.searchParams.get('token') || '';
  if (provided.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; ++i) {
    diff |= (expected.charCodeAt(i) ^ provided.charCodeAt(i));
  }
  return diff === 0;
}

/** query timeout 参数解析：默认 120s，clamp 到 1..300s。 */
function pyBridgeTimeoutSec(url) {
  const raw = Number(url.searchParams.get('timeout') || '');
  if (!Number.isFinite(raw)) {
    return 120;
  }
  return Math.min(300, Math.max(1, Math.floor(raw)));
}

/** 执行守卫 + 惰性取桥 + SIGALRM 超时 + 结构化错误（任何失败都不许抛到 HTTP 层之外）。 */
function pyBridgeRun(code, timeoutSec) {
  if (!pythonReady()) {
    return { ok: false, error: 'stdlib not ready (extraction in progress?)', stdlibReady: false };
  }
  const bridge = getPyBridge();
  if (bridge === null) {
    return { ok: false, error: 'python bridge addon unavailable' };
  }
  // SIGALRM 超时注入：超时 handler 抛 SystemExit(124)，captureRun 的
  // except SystemExit 分支捕获后以 rc="124" 返回（不逃逸成进程退出）。
  // 【防御式 try + 全限定（2026-09-23 真机教训）】`import signal as _dshm_sig`
  // 在真机嵌入 CPython（dlopen libpython3.12 + exec 注入）里 NameError——
  // as 绑定不落 globals，后续引用即炸；import 失败时降级为无超时（桥仍可用，
  // 长任务靠调用方 timeout query 自律），绝不让 prelude 挡死执行通道。
  const prelude = 'try:\n'
    + '    import signal\n'
    + '    def _dshm_alarm(*_a):\n'
    + '        raise SystemExit(124)\n'
    + '    signal.signal(signal.SIGALRM, _dshm_alarm)\n'
    + `    signal.setitimer(signal.ITIMER_REAL, ${timeoutSec})\n`
    + 'except BaseException as _e:\n'
    + '    print("[dshm] prelude: signal timeout unavailable:", _e)\n';
  let r;
  try {
    r = bridge.captureRun(prelude + code);
  } catch (e) {
    r = { ok: false, error: String(e && e.message ? e.message : e) };
  }
  // 统一清 itimer：正常路径代码尾部不拼取消（异常路径跑不到），改由这里
  // 幂等清零。不清的后果是真机实测过的坑——pending alarm 会在下一个请求
  // 的字节码检查点立即引爆 SystemExit(124)，误杀无辜请求。
  // 同 prelude 防御式：signal 不可用时静默跳过（上一请求已自带降级语义）。
  try {
    bridge.runString('try:\n    import signal\n    signal.setitimer(signal.ITIMER_REAL, 0)\nexcept BaseException:\n    pass');
  } catch (e2) {
    // 忽略：清理失败不影响本次结果（下个请求 prelude 会重置 timer）
  }
  return r;
}

function pyBridgePathInsideSandbox(abs) {
  return (abs === SANDBOX_HOME || abs.startsWith(SANDBOX_HOME + path.sep))
    || (abs === HOME_DIR || abs.startsWith(HOME_DIR + path.sep));
}

/** 在 ctx.webServer 上注册三个桥端点；任何异常只 diag（桥是增量能力）。 */
function registerPythonHttpBridge(ctx) {
  try {
    if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
      diag('python 桥端点：ctx.webServer 不可用，跳过注册');
      return;
    }
    ctx.webServer.register({
      kind: 'exact',
      path: '/dshm-python/status',
      handler: async (request, response) => {
        try {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' });
            response.end();
            return;
          }
          const bridge = getPyBridge();
          const info = bridge ? bridge.isReady() : { ready: false, initialized: false };
          pyBridgeSendJson(response, 200, {
            ok: true,
            bridge: bridge !== null,
            stdlib: pythonReady(),
            ready: info.ready === true,
            initialized: info.initialized === true,
            home: PYTHON_PREFIX,
          });
        } catch (e) {
          pyBridgeSendJson(response, 200, { ok: false, error: String(e && e.message ? e.message : e) });
        }
      },
    });
    ctx.webServer.register({
      kind: 'exact',
      path: '/dshm-python/run-get',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' });
          response.end();
          return;
        }
        const url = new URL(request.url, 'http://localhost');
        if (!pyBridgeTokenOk(url)) {
          pyBridgeSendJson(response, 401, { ok: false, error: 'token required' });
          return;
        }
        const code = url.searchParams.get('code') || '';
        if (code.length === 0) {
          pyBridgeSendJson(response, 400, { error: 'code query param required' });
          return;
        }
        if (code.length > 65536) {
          pyBridgeSendJson(response, 413, { error: 'code too long (>64KB); write to a .py file and use exec endpoint' });
          return;
        }
        pyBridgeSendJson(response, 200, pyBridgeRun(code, pyBridgeTimeoutSec(url)));
      },
    });
    ctx.webServer.register({
      kind: 'exact',
      path: '/dshm-python/exec',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' });
          response.end();
          return;
        }
        const url = new URL(request.url, 'http://localhost');
        if (!pyBridgeTokenOk(url)) {
          pyBridgeSendJson(response, 401, { ok: false, error: 'token required' });
          return;
        }
        const argvRaw = url.searchParams.get('argv') || '';
        const argv = argvRaw.length === 0 ? [] : argvRaw.split('\x1f');
        if (argv.length === 0) {
          pyBridgeSendJson(response, 400, { error: 'argv required (\\x1f-separated)' });
          return;
        }
        let code = '';
        let argvHead = [];
        if (argv[0] === '-c') {
          if (argv.length < 2) {
            pyBridgeSendJson(response, 400, { error: '-c requires code argument' });
            return;
          }
          code = argv[1];
          argvHead = ['python3', '-c'].concat(argv.slice(2));
        } else if (argv[0] === '-m') {
          if (argv.length < 2) {
            pyBridgeSendJson(response, 400, { error: '-m requires module name' });
            return;
          }
          // python3 -m MOD ARGS：runpy._run_module_as_main 把 sys.argv[0] 改成
          // 模块入口路径、argv[1:] 原样保留（真 python3 -m 的 sys.argv 语义），
          // 所以 argvHead 不含 MOD 名，否则 pip 会看到多余的 'pip' 参数。
          code = 'import runpy\nrunpy._run_module_as_main(' + JSON.stringify(argv[1]) + ')';
          argvHead = ['python3'].concat(argv.slice(2));
        } else {
          const scriptPath = argv[0];
          const abs = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(process.cwd(), scriptPath);
          if (!pyBridgePathInsideSandbox(abs)) {
            pyBridgeSendJson(response, 400, { ok: false, error: 'script path must be inside sandbox home' });
            return;
          }
          let text = '';
          try {
            text = fs.readFileSync(abs, 'utf8');
          } catch (e) {
            pyBridgeSendJson(response, 404, { ok: false, error: 'read failed: ' + String(e && e.message ? e.message : e) });
            return;
          }
          if (text.length === 0) {
            pyBridgeSendJson(response, 400, { error: 'script is empty' });
            return;
          }
          code = text;
          argvHead = ['python3', abs].concat(argv.slice(1));
        }
        // sys.argv 对齐真 python3：['python3', <-c 或脚本路径>, ...args]
        const setArgv = '__dshm_argv = ' + JSON.stringify(argvHead)
          + '\nimport sys\nsys.argv = __dshm_argv\n';
        pyBridgeSendJson(response, 200, pyBridgeRun(setArgv + code, pyBridgeTimeoutSec(url)));
      },
    });
    stage('BOOT_62_PY_BRIDGE_HTTP', '/dshm-python/status|run-get|exec 已注册');
  } catch (e) {
    diag('python 桥端点注册异常（桥退化为不可用）：' + String(e && e.message ? e.message : e));
  }
}

/**
 * registry 查询端点（/dshm-registry/view）：`pnpm view` 假壳转发的 Host 侧实现。
 *
 * 【为什么需要 —— 真机证据 2026-09-24】插件设置页"按名安装"与 dshmarket 的
 * 安装前信息展示都经 viewProfilePackage（dsh-plugin-manager lib/index.js:664）
 * spawn `pnpm view <spec> … --json`；端侧无真 pnpm（E86），CLI 假壳把 view 转发到
 * 本端点：Host 进程内 dshmFetch 查 npmmirror（与 dshm-installer 安装同 registry，
 * 元数据与实际安装源一致），返回 pnpm view --json 同形 JSON——上层
 * （inspect/兼容性预检）解析零改动。
 *
 * 【token 同 python 桥】view 虽只读公共 registry 元数据，但沿用 pyBridgeTokenOk
 * （假壳侧 token 双源逻辑现成）：不给"某个端点免 token"开先例。
 *
 * 【spec 解析】只接受 registry 形态（name / name@range / @scope/name / @scope/name@range）；
 * path/git/tarball spec 不进本端点（viewProfilePackage 只对 kind==='registry' 调用，
 * dsh-plugin-manager lib/index.js:317）。range 为空查 dist-tags.latest；非空走
 * registry 标准语义 `/<name>/<range>`（返回满足该 range 的最新版 manifest）。
 */
function splitRegistrySpec(raw) {
  const spec = String(raw || '').trim();
  if (spec.length === 0 || spec.length > 512) {
    return null;
  }
  // 排除非 registry 形态（parseInstallSpec 的其他 kind 不会到这，防御式再挡一道）
  if (/^(https?:|git|git\+|file:|\/|\.{0,2}\/)/.test(spec) || spec.endsWith('.tgz') || spec.endsWith('.tar.gz')) {
    return null;
  }
  let name = '';
  let range = '';
  if (spec.startsWith('@')) {
    const at = spec.indexOf('@', 1);
    if (at === -1) {
      name = spec;
    } else {
      name = spec.slice(0, at);
      range = spec.slice(at + 1);
    }
  } else {
    const at = spec.indexOf('@');
    if (at === -1) {
      name = spec;
    } else {
      name = spec.slice(0, at);
      range = spec.slice(at + 1);
    }
  }
  if (!/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(name)) {
    return null;
  }
  return { name, range };
}

/** 在 ctx.webServer 上注册 registry 查询端点；任何异常只 diag（view 是增量能力）。 */
function registerRegistryViewEndpoint(ctx) {
  try {
    // eslint-disable-next-line global-require
    const { dshmFetch } = require('./fetch-shim.js');
    if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
      diag('registry view 端点：ctx.webServer 不可用，跳过注册');
      return;
    }
    ctx.webServer.register({
      kind: 'exact',
      path: '/dshm-registry/view',
      handler: async (request, response) => {
        const sendJson = (status, body) => {
          const payload = JSON.stringify(body);
          response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
          response.end(payload);
        };
        try {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' });
            response.end();
            return;
          }
          const url = new URL(request.url, 'http://localhost');
          if (!pyBridgeTokenOk(url)) {
            sendJson(401, { ok: false, error: 'token required' });
            return;
          }
          let rawSpec = String(url.searchParams.get('spec') || '');
          // 皮肤市场展示名 → 真实安装 spec（@dsh-external/dsh-client-ui-skin-* 常与真实
          // 发布名不一致，先在 registry 查询前改写成真实包名/源，避免 view 404）。
          try {
            const inst = require('./dshm-installer.js');
            rawSpec = inst.dshmSkinAlias(rawSpec);
          } catch (e) { /* 别名读取失败就按原值走 */ }
          const parsed = splitRegistrySpec(rawSpec);
          if (parsed === null) {
            sendJson(400, { ok: false, error: 'invalid registry spec' });
            return;
          }
          // 双 registry 探测：先 npmmirror（大陆镜像，默认），404/失败再试官方 npmjs。
          // 皮肤市场的 `@dsh-external/dsh-*` scoped 包部分只在官网发布，镜像未同步
          // → 若死绑 npmmirror，市场"下载并检查安装包"这步就 exit 1（真机实证 2026-09-24）。
          let manifest = null;
          for (const regBase of ['https://registry.npmmirror.com', 'https://registry.npmjs.org']) {
            const base = regBase + '/' + encodeURIComponent(parsed.name);
            const target = parsed.range.length === 0 ? base : base + '/' + encodeURIComponent(parsed.range);
            try {
              const res = await dshmFetch(target, { headers: { accept: 'application/json' } });
              if (res.status === 404) {
                continue; // 该 registry 无此包 → 换下一个
              }
              if (!res.ok) {
                continue;
              }
              const body = await res.text();
              const parsedJson = JSON.parse(body);
              if (parsedJson && typeof parsedJson === 'object') {
                manifest = parsedJson;
                break;
              }
            } catch (e) {
              // 该 registry 请求失败 → 试下一个
            }
          }
          if (manifest === null) {
            sendJson(404, { ok: false, error: 'not found: ' + parsed.name });
            return;
          }
          // range 为空：/<name> 返回全 manifest（dist-tags + versions），取 latest；
          // 有 range：/<name>/<range> 直接返回单版 manifest。
          let version = manifest;
          if (parsed.range.length === 0 && manifest && typeof manifest === 'object'
            && manifest.versions && typeof manifest.versions === 'object') {
            const latest = manifest['dist-tags'] && manifest['dist-tags'].latest;
            if (typeof latest === 'string' && manifest.versions[latest]) {
              version = manifest.versions[latest];
            } else {
              const keys = Object.keys(manifest.versions);
              version = keys.length > 0 ? manifest.versions[keys[keys.length - 1]] : null;
            }
          }
          if (!version || typeof version !== 'object' || typeof version.version !== 'string') {
            sendJson(404, { ok: false, error: 'no matching version for: ' + parsed.name });
            return;
          }
          // pnpm view <spec> name version description dsh peerDependencies --json 同形：
          // 选择字段的普通对象（上层 inspectionOf/namedSpecManifest 按字段取用，多余无妨）。
          const view = { name: version.name, version: version.version };
          if (typeof version.description === 'string') {
            view.description = version.description;
          }
          if (version.dsh !== undefined) {
            view.dsh = version.dsh;
          }
          if (version.peerDependencies !== undefined) {
            view.peerDependencies = version.peerDependencies;
          }
          sendJson(200, view);
        } catch (e) {
          sendJson(500, { ok: false, error: String(e && e.message ? e.message : e) });
        }
      },
    });
    stage('BOOT_63_REGISTRY_VIEW', '/dshm-registry/view 已注册');
  } catch (e) {
    diag('registry view 端点注册异常（view 退化为不可用）：' + String(e && e.message ? e.message : e));
  }
}

/**
 * registry 包清单 / 直立（/dshm-registry/view 的姊妹端点）。
 *
 * 【为什么需要 —— 真机证据 2026-09-24】dsh-skin-market（以及 dsh 的核心 plugin-manager）
 * 在 `pnpm add` 成功后会跑 `pnpm list --json --depth=0`（installer.ts inventory()），靠
 * 它拿**已装包的真实路径**（packageDir），再去读入口 / 应用 bundle patch。端侧无真
 * pnpm，假壳若对 `pnpm list` 无分支会落到末尾拒绝行 → 返回非 0 → inventory 空 →
 * packageDir 无法确定 → 市场报 "installed package manifest missing / did not materialize
 * the package"（装好了但市场拿不到落位信息）。
 *
 * 本端点在 Host 进程内读 profile/package.json（+node_modules 实际版本）拼出
 * `pnpm list --json --depth=0` 同形 JSON，假壳 `pnpm(ls|list|ll)` 转发 target：
 *   dir = PWD（市场以 profileDir 为 cwd 起 spawn，PWD 即 profile）。
 * 解析零改动（marketing 取 root.dependencies[i].path）。
 */
function registerPackageListViewEndpoint(ctx) {
  try {
    if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
      diag('packages/list 端点：ctx.webServer 不可用，跳过注册');
      return;
    }
    ctx.webServer.register({
      kind: 'exact',
      path: '/dshm-packages/list',
      handler: async (request, response) => {
        const sendJson = (status, body) => {
          const payload = JSON.stringify(body);
          response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
          response.end(payload);
        };
        try {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' }); response.end(); return;
          }
          const url = new URL(request.url, 'http://localhost');
          if (!pyBridgeTokenOk(url)) {
            sendJson(401, { ok: false, error: 'token required' }); return;
          }
          let dir = url.searchParams.get('dir');
          if (typeof dir !== 'string' || dir.length === 0) {
            dir = path.join(HOME_DIR, 'profiles', PROFILE); // 缺省：宿主当前 profile
          }
          const pkgFile = path.join(dir, 'package.json');
          let manifest = null;
          try {
            manifest = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
          } catch (e) {
            sendJson(404, { ok: false, error: 'profile package.json 不可读：' + pkgFile }); return;
          }
          const deps = (manifest && typeof manifest.dependencies === 'object') ? manifest.dependencies : {};
          const map = {};
          for (const name of Object.keys(deps)) {
            const realDir = path.join(dir, 'node_modules', name);
            let version = String(deps[name]);
            try {
              const met = JSON.parse(fs.readFileSync(path.join(realDir, 'package.json'), 'utf8'));
              if (met && typeof met.version === 'string') {
                version = met.version;
              }
            } catch (e) { /* 只读 dir 不一定在，fallback 用 dep 版本 */ }
            map[name] = { version, path: realDir, from: dir };
          }
          sendJson(200, [{
            name: path.basename(dir) || 'root',
            path: dir,
            private: true,
            dependencies: map,
          }]);
        } catch (e) {
          sendJson(500, { ok: false, error: String(e && e.message ? e.message : e) });
        }
      },
    });
    stage('BOOT_63B_PACKAGE_LIST', '/dshm-packages/list 已注册');
  } catch (e) {
    diag('packages/list 端点注册异常（跳过）：' + String(e && e.message ? e.message : e));
  }
}

/**
 * 后台解包工具链归档（幂等：锚点齐备即跳过；残局先清再解）。
 * busybox ash -c 逐条 tar xmzf（-m：hmfs 的 settime 全部 EACCES，不恢复 mtime），
 * .extract.log（tar 对 symlink 的告警在里面，不进 hilog 噪音）。
 */
/**
 * 工具链"收尾补齐"（幂等，可重复调，不抛）：执行位确保 + git symlink 复制补齐。
 * chmod 只在 execOk 不过时做——hmfs 上对健康文件做多余 chmod 可能触发 EACCES
 * （busybox 布置的真机教训），"缺了才补"比"每次都刷"稳。
 */
function finalizeToolchain() {
  try {
    const exe = path.join(PYTHON_PREFIX, 'bin', 'python3.12');
    if (statSize(exe) > 0 && (fs.statSync(exe).mode & 0o111) === 0) {
      fs.chmodSync(exe, 0o755);
    }
  } catch (e) {
    diag(`工具链：python 执行位补齐失败：${String(e)}`);
  }
  try {
    const core = path.join(GIT_ROOT, 'usr', 'libexec', 'git-core');
    /*
     * 【覆盖全部 symlink，而不是一条】（报告 5 §2.3）
     * 端侧 tar 解不出 symlink（hmfs 无链接能力）⇒ `git-core/` 下 141 个链接全成空壳，
     * 于是 `git clone` 走到 `git-upload-pack` 就 "inaccessible or not found"。
     * 名字从**本版 git 的 apk 归档**里现读（readGitCoreSymlinks），保证与版本一致；
     * 读不到时退回原来硬编码的那一条（不退化，只是覆盖面小）。
     * 真身相对链接是 `../../bin/git` / `git-remote-http`，都相对 git-core 目录解析。
     */
    const apkDir = path.join(RES_ROOT, 'toolchain', 'git');
    let replica = null;
    try {
      const apks = fs.readdirSync(apkDir).filter((n) => /^git-\d/.test(n) && n.endsWith('.apk'));
      for (const a of apks) {
        replica = readGitCoreSymlinks(path.join(apkDir, a));
        if (replica !== null) {
          diag(`工具链：从 ${a} 读到 git-core symlink 表 ${replica.length} 条`);
          break;
        }
      }
    } catch (e) {
      replica = null;
    }
    const list = replica !== null ? replica : GIT_SYMLINK_REPLICA_FALLBACK;
    let fixed = 0;
    for (const [name, link] of list) {
      const dst = path.join(core, name);
      // 链接目标解析：`../../bin/git` 相对 git-core → GIT_ROOT/usr/bin/git；
      // `git-remote-http`（同名文件）相对 git-core。
      const srcPath = path.resolve(core, link);
      // 判据只用真实数据面：真身是 ELF、且 dst 不是可读的 ELF，才补
      //（hmfs 上 stat/lstat/access 元数据会被"残缺链接占位"骗，见 isElf 注释）。
      if (!isElf(srcPath)) {
        continue;
      }
      if (!isElf(dst)) {
        try {
          fs.rmSync(dst, { force: true });
          fs.copyFileSync(srcPath, dst);
          fs.chmodSync(dst, 0o755);
          fixed += 1;
        } catch (e) {
          // 单个失败不阻断整体（下轮启动会重试；缺哪个子命令的报错会如实出现在 stderr）
        }
      }
    }
    if (fixed > 0) {
      diag(`工具链：已用真身补齐 ${fixed} 个 git-core 子命令（symlink 在 hmfs 上解不出）`);
    }
    const exes = [
      'usr/bin/git',
      'usr/libexec/git-core/git',
      'usr/libexec/git-core/git-remote-http',
      'usr/libexec/git-core/git-remote-https',
    ];
    for (const rel of exes) {
      const p = path.join(GIT_ROOT, rel);
      if (statSize(p) > 0 && (fs.statSync(p).mode & 0o111) === 0) {
        fs.chmodSync(p, 0o755);
      }
    }
  } catch (e) {
    diag(`工具链：git 补齐失败：${String(e)}`);
  }
}

/**
 * 真实可执行性探测：spawn 一次，以 exit/error 事件为准（Promise，不抛）。
 *
 * 【为什么需要它——hmfs 元数据撒谎第三例，真机实测 2026-09-22】用户跑
 * `python3 --version` → 126 "转发目标 …/python3.12 Permission denied"、
 * `git --version` 同样 126：wrapper（sh 脚本，spawn 成功）里 `exec` 真身时
 * kernel 拒绝。而这批文件在 hdc ls 下显示 rwxr-xr-x、Node statSync 的 mode
 * 也带 x 位——元数据全体撒谎。同盘对照组：busybox 副本（Node copyFileSync
 * 创建）spawn 实证可跑 ⇒ hmfs 的执行许可与"文件创建者"绑定：宿主进程创建
 * →可执行；tar 子进程创建→被拒（mode 位只是装饰）。（当时假设"Node 重写拿
 * 新 inode"可修复，后经 E1-E19 实验否定：宿主重写后依然 denied——execve 由
 * 签名域策略拒绝，与创建者/inode 无关。修复改为进程内桥，见 python 桥段。）
 *
 * @returns 'ok' execve 成功且无 loader 报错 | 'denied' EACCES | 'so-fail'
 *          execve 成功但 so 加载失败 | 'fail' 其它
 */
function probeExec(p, args, env) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    let c;
    try {
      c = spawn(p, args, { stdio: ['ignore', 'ignore', 'pipe'], env });
    } catch (e) {
      // uv_spawn 同步失败（fork/open 阶段，E14 组实测）：非零追加 busybox 后
      // 不走异步 error 事件而走这里——errno 是区分"open 层拦截 vs execve 层
      // 拦截"的唯一证据。
      resolve(`fail(${e && e.code})`);
      return;
    }
    let errTail = '';
    let settled = false;
    const done = (r) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      // 超时还活着 = 进程已跑起来（execve 必然成功）：kill 后 exit 事件按 ok 收
      try { c.kill('SIGKILL'); } catch (e) { /* 已退出 */ }
    }, 10000);
    if (c.stderr) {
      c.stderr.on('data', (d) => {
        if (errTail.length < 300) {
          errTail += d.toString();
        }
      });
    }
    c.on('error', (e) => {
      done(e && e.code === 'EACCES' ? 'denied' : `fail(${e && e.code})`);
    });
    c.on('exit', () => {
      // musl loader："Error loading shared library …"；glibc："error while loading"
      if (/Error loading shared librar|error while loading shared librar/.test(errTail)) {
        done('so-fail');
        return;
      }
      if (errTail.length > 0) {
        diag(`exec 探测 ${path.basename(p)} stderr：${errTail.slice(0, 200).replace(/\s+/g, ' ')}`);
      }
      done('ok');
    });
  });
}

/** 探测目标清单：模型四件套关键 ELF + rg。env 与 wrapper 运行态严格一致。 */
function execProbeTargets() {
  const gitEnv = { ...process.env, LD_LIBRARY_PATH: path.join(GIT_ROOT, 'usr', 'lib') };
  const pyEnv = { ...process.env, PYTHONHOME: PYTHON_PREFIX };
  return [
    { label: 'python3.12', p: path.join(PYTHON_PREFIX, 'bin', 'python3.12'), args: ['-c', 'pass'], env: pyEnv,
       },
    { label: 'git', p: path.join(GIT_ROOT, 'usr', 'bin', 'git'), args: ['--version'], env: gitEnv,
       },
    { label: 'git-core/git', p: path.join(GIT_ROOT, 'usr', 'libexec', 'git-core', 'git'), args: ['--version'], env: gitEnv,
       },
    { label: 'git-remote-http', p: path.join(GIT_ROOT, 'usr', 'libexec', 'git-core', 'git-remote-http'), args: [], env: gitEnv,
       },
    { label: 'rg', p: CORE_DIR.length > 0 ? path.join(CORE_DIR, 'node_modules', '@vscode', 'ripgrep-linux-arm64', 'bin', 'rg') : '', args: ['--version'], env: process.env,
       },
    // 【P0 回归的验收锚点】bash 垫片是"宿主进程写出的文本脚本"与 busybox 副本同一
    // 创建者类别（hmfs 上可执行）；这里真跑一次 `bash -c 'echo DSHM-EXEC-OK'`，把结果
    // 写进 diag——§6-1 的验收信号因此每次启动都有机器可读的取证，不必手工跑。
    // 【前置判据：垫片的首行解释器】同批先探 `<bin>/ash` —— 垫片能否起来完全取决于
    // 它（内核在 execve 时打开首行解释器）。本机读数 **`ash=denied`**（预期）：随包
    // 自签名 ELF 同样被签名域/MAC 拒绝 ⇒ 垫片在本档不生效，见 `bashShimLines()` 的
    // "手机档内不生效"一节。这条探针的价值正在于此：若某档位给出 `ash=ok` 而
    // `bash=denied`，失败点就不在解释器可执行性（该去查 argv[0] 派发/沙箱），一眼可分。
    // 路径与 PATH 首项同源（= 垫片所在目录）。
    { label: 'ash', p: process.env.PATH ? (process.env.PATH.split(':')[0] + '/ash') : '',
      args: ['-c', 'echo DSHM-ASH-OK'], env: process.env,
       },
    { label: 'bash', p: process.env.PATH ? (process.env.PATH.split(':')[0] + '/bash') : '/system/bin/sh',
      args: ['-c', 'echo DSHM-EXEC-OK'], env: process.env,
       },
    /*
     * 【报告 5 §2.3 的判决性验收】git **子进程类**命令（clone/fetch/pull/push）在
     * 端侧原本一律 rc=134（SIGABRT，`run-command.c:525 disabling cancellation`），
     * 由 `libdshm-gitcompat.so` 以 LD_PRELOAD 接管 `pthread_setcancelstate`/`_sigmask`。
     *
     * 这里用 `git ls-remote` 打一个**本地 file:// 仓库**做探测：它会走
     * `start_command()`（也就是会碰那两处 CHECK_BUG），但**不需要网络**——是最小、
     * 可重复、且不会因外部服务波动而误判的判据。
     *   · 'ok'    ⇒ 垫片生效（不再 abort）——§2.3 的目标达成；
     *   · 'fail(134)' / 'fail(null)' ⇒ 垫片没接上或还有别的 abort 点，需要继续查。
     * 探测用的空仓库由本函数就地造（`git init` 走的是**本地**命令，本来就可用）。
     */
    {
      label: 'git-ls-remote',
      p: path.join(GIT_ROOT, 'usr', 'bin', 'git'),
      args: ['ls-remote', 'file://' + path.join(TOOLCHAIN_DIR, '.probe-repo')],
      env: (() => {
        // 与 wrapper 同款环境 + LD_PRELOAD 垫片；垫片缺失时不加（探测会如实反映"未装"）。
        // 【必须带 GIT_EXEC_PATH】git 靠它找 git-core 下的辅助程序（upload-pack 等）——
        // 少了它，即便垫片让子进程起得来，也会 `git-upload-pack: inaccessible or not found`。
        const compat = NATIVE_LIBS.length > 0
          ? path.join(NATIVE_LIBS, 'libdshm-gitcompat.so') : '';
        const env = {
          ...process.env,
          LD_LIBRARY_PATH: path.join(GIT_ROOT, 'usr', 'lib'),
          GIT_EXEC_PATH: path.join(GIT_ROOT, 'usr', 'libexec', 'git-core'),
        };
        if (compat.length > 0 && statSize(compat) > 0) {
          env.LD_PRELOAD = compat;
        }
        return env;
      })(),
    },
  ];
}

/**
 * 可执行性状态记录（幂等，异步，不抛）：锚点齐备后对关键 ELF 探测一次，结果
 * 只进 diag、不再修复——E1-E19 实验定案：execve 由签名域策略拒绝，重写主 ELF
 * /so 树（全新 inode）都救不回，实验矩阵已随结论拆除（记录见
 * docs/device-validation.md）。挂载点：稳态 boot（顶层块）+ 解包收尾
 * （finishToolchainExtraction）。垫片层（toolchainWrapperScript）有各自的
 * exec 探测回退，不依赖这里的探测结果。
 */
async function ensureExecutables() {
  /*
   * 【探针不隶属"工具链就绪"：恒跑】这里曾经有一道早退守卫
   *   `if (!pythonReady() || !gitReady()) { return; }`
   * 后果（真机实测）：**工具链解包失败时整批 exec 探针一行都不跑**，于是
   * "随包 ELF 能不能 exec"这条验收判据**静默失效**——报告里只能写"未激发"，
   * 而门禁 `tools/assert-exec-fix.mjs` 当时把"早退守卫存在"当正向锚点，
   * 等于替这个缺陷背书（该锚点已一并修掉）。
   *
   * 现口径：**恒跑**。理由与代价都写清楚：
   *   · 每个目标自带"文件不存在 ⇒ 记 `缺`"的分支（下面的循环），所以半成品/未解包
   *     状态下探针照样给出**读数**（"缺"本身就是结论，不是异常）；
   *   · 本函数只探测 + 记录，没有任何修复动作（Phase 5 拆除后的口径未变），
   *     因此提前跑不会改设备上的任何东西；
   *   · 解包收尾那条挂载点（`finishToolchainExtraction`，pyOk && gitOk 时）仍会在
   *     锚点齐备后**再跑一次**，最终的 exec 读数是那一次，不受这里的早读数影响。
   * 判据"未执行 ⇒ 不算通过"由门禁 `tools/assert-exec-fix.mjs` 兜底：它现在断言
   * 本函数**不存在**任何早退守卫，且汇总 diag 无条件执行。
   */
  // 【探测前置】ls-remote 需要一个已存在的仓库（哪怕空的）——用本地命令 git init
  // 就地造一个（init 走的是**本地**路径，本来就可用，不受 §2.3 的子进程问题影响）。
  // 已经存在就跳过（幂等）；造失败也不阻断（探测那一项会如实报 fail）。
  try {
    const probeRepo = path.join(TOOLCHAIN_DIR, '.probe-repo');
    const gitExe = path.join(GIT_ROOT, 'usr', 'bin', 'git');
    if (!fs.existsSync(path.join(probeRepo, 'HEAD')) && statSize(gitExe) > 0) {
      fs.mkdirSync(probeRepo, { recursive: true });
      require('node:child_process').spawnSync(gitExe, ['init', '--bare', probeRepo], {
        env: { ...process.env, LD_LIBRARY_PATH: path.join(GIT_ROOT, 'usr', 'lib') },
        stdio: 'ignore',
        timeout: 20000,
      });
    }
  } catch (e) {
    diag(`git 探测仓库创建失败（不阻塞）：${String(e).slice(0, 140)}`);
  }
  const summary = [];
  for (const t of execProbeTargets()) {
    if (!t.p || t.p.length === 0 || statSize(t.p) <= 0) {
      // 【"缺"是读数，不是跳过】(2026-10-03) 未解包/半成品时它照样进汇总 ⇒ 端侧能看到
      // "这一项本次没有可执行文件"这一事实，而不是一行都没有（旧行为见本函数头注）。
      summary.push(`${t.label}=缺`);
      continue;
    }
    const r = await probeExec(t.p, t.args, t.env);
    summary.push(`${t.label}=${r}`);
  }
  // 【无条件执行】这一行是"探针真的跑过"的唯一机器可读信号（没有它 ⇒ 本门禁不算通过）。
  diag(`exec 探测：${summary.join('，')}`);
}

/**
 * 解包残局自愈（每次启动都查）：上次解包子进程退出后收尾未执行
 * （exit 回调丢失 / Host 进程被杀）时，py-stage/python 已完整但未归位。
 * 归位后 pythonReady() 即真，needPy 判定自然跳过重解（4530 个文件不重拷）。
 */
function healToolchainStage() {
  const staged = path.join(TOOLCHAIN_DIR, 'py-stage', 'python');
  const stagedExe = path.join(staged, 'bin', 'python3.12');
  if (statSize(stagedExe) <= 0 || pythonReady()) {
    return;
  }
  try {
    fs.renameSync(staged, PYTHON_PREFIX);
    fs.rmSync(path.join(TOOLCHAIN_DIR, 'py-stage'), { recursive: true, force: true });
    diag('工具链：检测到未归位的 py-stage 残局，已补跑收尾（免重解 4530 文件）');
  } catch (e) {
    diag(`工具链：py-stage 归位失败（下次启动重试）：${String(e)}`);
    return;
  }
  finalizeToolchain();
}

function scheduleToolchainExtraction(resRoot, binDir) {
  if (!binDir || binDir.length === 0) {
    return;
  }
  healToolchainStage();
  const tarball = path.join(resRoot, PYTHON_TARBALL_REL);
  const apkDir = path.join(resRoot, 'toolchain', 'git');
  /*
   * 【归档换代即重解（报告 4 ③）】`pythonReady()`/`gitReady()` 是"存在即跳过"，
   * 光靠它们，构建期加了自签名的新归档永远不会被解开（用户继续用旧的无签名文件）。
   * 这里把构建期写的 `dshm-signed.txt` 标记纳入判据：标记不一致 ⇒ 强制重解。
   * 判据单独成一个函数（needsReextractForSign），因为它同时要处理"归档没标记"的旧包。
   */
  const pySignStale = needsReextractForSign(path.join(resRoot, 'toolchain', 'python'), PYTHON_PREFIX);
  const gitSignStale = needsReextractForSign(apkDir, GIT_ROOT);
  if (pySignStale) {
    diag('工具链：python 归档已换代（dshm-signed.txt 变化），强制重解以取到已签名的 ELF');
  }
  if (gitSignStale) {
    diag('工具链：git 归档已换代（dshm-signed.txt 变化），强制重解以取到已签名的 ELF');
  }
  const needPy = (!pythonReady() || pySignStale) && statSize(tarball) > 0;
  let apks = [];
  try {
    apks = fs.existsSync(apkDir)
      ? fs.readdirSync(apkDir).filter((n) => n.endsWith('.apk')).sort()
      : [];
  } catch (e) {
    diag(`工具链：读取 ${apkDir} 失败：${String(e)}`);
  }
  const needGit = (!gitReady() || gitSignStale) && apks.length > 0;
  if (!needPy && !needGit) {
    // 稳态 boot 也必须跑补齐：git-remote-https 的"残缺 symlink 占位"修复
    // 不依赖解包（isElf 判定幂等轻量），只挂在解包/归位路径上会被跳过
    // （真机踩过：连续两轮 boot 补齐 diag 缺失、占位未替换）。
    finalizeToolchain();
    diag(`工具链：无需解包（python=${pythonReady()}，git=${gitReady()}）`);
    return;
  }
  const pyStage = path.join(TOOLCHAIN_DIR, 'py-stage');
  try {
    ensureDir(TOOLCHAIN_DIR);
    if (needPy) {
      fs.rmSync(PYTHON_PREFIX, { recursive: true, force: true });
      fs.rmSync(pyStage, { recursive: true, force: true });
      ensureDir(pyStage);
    }
    if (needGit) {
      fs.rmSync(GIT_ROOT, { recursive: true, force: true });
      ensureDir(GIT_ROOT);
    }
  } catch (e) {
    diag(`工具链：解包前清理失败（本轮跳过，下次启动重试）：${String(e)}`);
    return;
  }
  const cmds = [];
  if (needPy) {
    // -m：不恢复 mtime——hmfs 的 utimensat 全部 EACCES（真机 .extract.log 里
    // 4530 文件每个都 "settime: Permission denied"），-m 消掉这层噪音与 "tar: had errors"。
    cmds.push(`tar xmzf "${tarball}" -C "${pyStage}"`);
    // chmod 由解包子进程（文件创建者）自己做：hmfs 上"别的进程 chmod 已存在
    // 文件"可能 EACCES（busybox 布置踩过，见 rewriteExecutable 证据），
    // 创建者进程对自己刚写的文件 chmod 是最稳的一层；失败不阻塞（|| true），
    // Node 侧 finishToolchainExtraction 还有幂等补 chmod 兜底。
    cmds.push(`chmod 755 "${path.join(pyStage, 'python', 'bin', 'python3.12')}" || true`);
  }
  for (const a of apks) {
    cmds.push(`tar xmzf "${path.join(apkDir, a)}" -C "${GIT_ROOT}"`);
  }
  if (needGit) {
    cmds.push(`chmod 755 "${path.join(GIT_ROOT, 'usr', 'bin', 'git')}" || true`);
    cmds.push(`chmod 755 "${path.join(GIT_ROOT, 'usr', 'libexec', 'git-core', 'git')}" || true`);
    cmds.push(`chmod 755 "${path.join(GIT_ROOT, 'usr', 'libexec', 'git-core', 'git-remote-http')}" || true`);
  }
  let logFd = -1;
  try {
    logFd = fs.openSync(path.join(TOOLCHAIN_DIR, '.extract.log'), 'w');
  } catch (e) {
    diag(`工具链：解包日志打开失败：${String(e)}`);
    return;
  }
  const { spawn } = require('child_process');
  diag(`工具链：后台解包启动（python=${needPy}，git apk ${apks.length} 个），输出见 .extract.log`);
  let child;
  try {
    child = spawn(path.join(binDir, 'busybox'), ['ash', '-c', cmds.join('\n')], {
      stdio: ['ignore', logFd, logFd],
    });
  } catch (e) {
    try { fs.closeSync(logFd); } catch (e2) { /* 已关 */ }
    diag(`工具链：解包子进程 spawn 失败：${String(e)}`);
    return;
  }
  child.on('exit', (code, signal) => {
    try { fs.closeSync(logFd); } catch (e) { /* 已关 */ }
    // 先记再干活：上一轮真机该回调疑似未触发（收尾行缺失、py-stage 未归位），
    // 把 exit 本身做成可观测事实，再丢就有证据。
    diag(`工具链：解包子进程退出（code=${code}，signal=${signal}）`);
    finishToolchainExtraction(needPy, needGit);
  });
  child.on('error', (e) => {
    try { fs.closeSync(logFd); } catch (e2) { /* 已关 */ }
    diag(`工具链：解包子进程异常：${String(e)}`);
  });
}

/**
 * 解包收尾（子进程 exit 回调，同步轻量）：rename 归位、symlink 复制补齐、
 * chmod+X_OK、锚点复验。失败不重试——幂等设计下次 Host 启动自动重试。
 */
function finishToolchainExtraction(didPy, didGit) {
  if (didPy) {
    try {
      fs.renameSync(path.join(TOOLCHAIN_DIR, 'py-stage', 'python'), PYTHON_PREFIX);
      fs.rmSync(path.join(TOOLCHAIN_DIR, 'py-stage'), { recursive: true, force: true });
    } catch (e) {
      diag(`工具链：python 收尾失败：${String(e)}`);
    }
  }
  /*
   * 【把签名版本标记落到解包目录（报告 4 ③）】needsReextractForSign 比对的是
   * "归档标记 vs 解包目录标记"，所以解包成功后**必须把归档那份标记也写过去**；
   * 否则下一轮启动会再次判定"换代了" → 每启动一次重解一遍 27MB/4530 文件。
   * 该标记文件不参与任何功能判据，纯粹是版本号。
   */
  try {
    const resRootForMarker = RES_ROOT;
    for (const [archiveDir, extractedDir] of [
      [path.join(resRootForMarker, 'toolchain', 'python'), PYTHON_PREFIX],
      [path.join(resRootForMarker, 'toolchain', 'git'), GIT_ROOT],
    ]) {
      const marker = readArchiveSignMarker(archiveDir);
      if (marker.length === 0 || statSize(extractedDir) <= 0) {
        continue;
      }
      fs.writeFileSync(path.join(extractedDir, TOOLCHAIN_SIGN_MARKER_FILE), `${marker}\n`, 'utf8');
    }
  } catch (e) {
    diag(`工具链：写签名版本标记失败（下次启动会重解一次）：${String(e)}`);
  }
  finalizeToolchain();
  const pyOk = pythonReady();
  const gitOk = gitReady();
  diag(`工具链：解包收尾 python=${pyOk ? 'OK' : 'FAIL'}，git=${gitOk ? 'OK' : 'FAIL'}（详见 .extract.log）`);
  log(`工具链：python=${pyOk ? '就绪' : '未就绪'}，git=${gitOk ? '就绪' : '未就绪'}`);
  // 刚解包完的文件全部由 tar 子进程创建（执行许可被拒的场景，见 probeExec 注释）：
  // 宿主 Node 立刻做一轮真探测+重写，别等下一次 boot。
  if (pyOk && gitOk) {
    setImmediate(() => {
      ensureExecutables().catch((e) => diag(`exec 探测异常：${String(e)}`));
    });
  }
  // stdlib 刚就位：补跑 python 桥自检（只依赖 python，git 解包失败不影响桥）
  if (pyOk) {
    setImmediate(() => {
      try { ensurePythonBridge(); } catch (e) { diag(`python 桥自检异常：${String(e).slice(0, 200)}`); }
    });
  }
}

{
  // entryScript = <resfile>/resources/app/main.js ⇒ __dirname 上两级就是 resfile 根
  const resRoot = path.resolve(__dirname, '..', '..');
  const binDir = ensureBusybox(resRoot);
  if (binDir.length > 0) {
    const base = process.env.PATH && process.env.PATH.length > 0
      ? process.env.PATH
      : '/usr/local/bin:/bin:/usr/bin:/system/bin:/vendor/bin';
    /*
     * 【PATH 卫生（2026-09-26 报告 3 备注）】真机实测注入后的 PATH 是：
     *   <bin>:/data/app/bin:/data/service/hnp/bin:/data/app/bin:/data/service/hnp/bin:/usr/local/bin:…
     * 两个问题：① `/data/app/bin` 在设备上**不存在**；② 系统预置段本身**重复了两次**。
     * 不存在的目录留在 PATH 里没有功能价值，只让人误以为"那里有东西"；重复段纯噪音。
     * 这里做一次去重 + 剔除不存在的绝对目录（保留非绝对项，语义交给内核）。
     * 【为什么不过滤整段 PATH】只删"确认不存在"的目录：hmfs/沙箱上 statSync 可能因
     * 权限失败，那种情况保留原样更安全（宁可留个无用项，也不要误删可用目录）。
     */
    const seen = new Set([binDir]);
    const kept = [binDir];
    for (const entry of base.split(':')) {
      if (entry.length === 0 || seen.has(entry)) {
        continue;
      }
      seen.add(entry);
      if (entry.startsWith('/')) {
        let exists = false;
        try {
          exists = fs.existsSync(entry);
        } catch (e) {
          exists = true; // stat 失败（权限等）：保守保留
        }
        if (!exists) {
          continue;
        }
      }
      kept.push(entry);
    }
    process.env.PATH = kept.join(':');
    diag(`PATH 已注入 busybox bin：${process.env.PATH}`);
  } else {
    diag('PATH 未注入（busybox 布置未成功），已验证链路不受影响');
  }
  ensureCliShims(binDir);
  // 【P0 真机回归修复】bash/hush 文本垫片：busybox 未编入 bash applet，
  // 若仍按 applet 复制会被 `bash -c` 报 applet not found（exit 127）。
  ensureBashShim(binDir);
  ensureToolchainWrappers(binDir, resRoot);
  ensureRipgrepWrapper(binDir);
  // 【报告 3 ③】core 树解包不保留权限位 ⇒ rg/sharp 的 .node 需要补 x 位
  ensureCoreExecBits();
  scheduleToolchainExtraction(resRoot, binDir);
  ensureBundledSkills(resRoot);
  // hmfs"执行许可绑创建者"（见 probeExec 注释）：锚点齐备后异步真探测+修复
  setImmediate(() => {
    ensureExecutables().catch((e) => diag(`exec 探测异常：${String(e)}`));
  });
  // 内嵌 Python 桥自检（stdlib 未就位时内部跳过，解包收尾后由第二挂载点补跑）
  setImmediate(() => {
    try { ensurePythonBridge(); } catch (e) { diag(`python 桥自检异常：${String(e).slice(0, 200)}`); }
  });
}

/**
 * 让 dsh 走"ESM proxy 目录"而不是"符号链接"来建模块回退。
 *
 * 【为什么必须这么做 —— 有真机证据】
 * dsh 启动时会由 `healProfilesModuleFallback` 在 `$DSH_HOME/profiles/node_modules` 下
 * 建立依赖闭包的链接（`dsh-app-boot` 源码 `resolveModuleFallbackEntries`）：
 *
 *     entries: !isPackagedExecutable()
 *       ? [...].map(... { kind: "symlink" })   // 普通 Node：写符号链接
 *       : [...].flatMap(... { kind: "proxy" }) // pkg 打包：写真实目录 + entry-N.js
 *
 * 而鸿蒙沙箱**全局禁止创建符号链接**：本机真机（Mate 70 Pro+ / API 26）探针实测
 * `filesDir` / `cacheDir` / `tempDir` 三个目录全部返回
 * `13900012 Permission denied`。⇒ 走 symlink 分支必然 boot 失败（D6 §4.1.3）。
 *
 * 【为什么这样绕是合法的，而不是 hack】
 * `isPackagedExecutable()` 的实现只有一句 `process.pkg !== void 0`；而 proxy 分支的实现
 * （`ensureModuleProxy`）**完全基于普通文件系统 API**——`mkdirSync` + `writeFileSync`，
 * 写出的每个 `entry-N.js` 就是 `export * from "<file:// URL>"`。
 * pkg 只出现在那段代码的**动机注释**里，运行路径上没有任何 pkg 虚拟文件系统依赖。
 * 也就是说：proxy 形态在普通 Node 下同样成立，我们只是让 dsh 选对了分支。
 *
 * 【风险（要在真机上验证，别当成已解决）】
 * 1. 其它依赖若也探测 `process.pkg` 并据此改变行为，可能被这一行影响；
 * 2. `$DSH_HOME/profiles/node_modules` 会从"一堆链接"变成"一堆小目录"（文件数变多）。
 * 在真机上跑通 boot 之前，这条只算"有依据的候选方案"。
 */
process.pkg = process.pkg || {};

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch (e) {
    if (e && e.code !== 'EEXIST') {
      log('mkdir 失败 ' + p + ' : ' + e.message);
    }
  }
}

/**
 * 清理**孤儿写锁**（`<file>.lock`）——不清理，下一次启动就会直接失败（E84）。
 *
 * 【问题（上游的明确设计，不是 bug）】`dsh-atomic-write` 的 `withFileLock` 用
 * `flag:'wx'` 建一个同级 `<file>.lock`，内容就是持有者 pid，释放写在 `finally` 里。
 * 上游注释把边界说得很清楚：
 *
 *     The contender never removes an existing lock because file age cannot prove
 *     that its owner stopped; orphan recovery is an operator action.
 *
 * 也就是说：**锁的持有者被强杀（SIGKILL / 系统回收应用）时，锁会永久留下**，
 * 之后每个新进程都会在 `waitMs` 之后失败，并且失败信息是
 * `atomic-write: timed out waiting for the writer lock at …`。
 *
 * 【为什么端侧必须自己处理】这条在开发机上只是"手工删一下"，在端侧却是**用户级故障**：
 * 用户划掉应用、或系统因内存压力回收应用，宿主进程被直接杀死 → 下次启动起不来，
 * 而用户没有任何手段去删那个文件。所以这一步不是优化，是把一个必然发生的
 * "起不来"变成"自愈"。
 *
 * 【判据为什么是 pid 而不是文件年龄】年龄无法区分"持有者还在慢慢写"和"持有者已死"；
 * 而 pid 可以直接问操作系统。三条保守规则：
 *   1. 内容读不出 pid → **不动**（可能是别的格式/正在写）；
 *   2. pid 就是本进程 → 不动；
 *   3. pid 仍存活（含 EPERM：进程在但不属于我们）→ 不动。
 * 只有"pid 明确已不存在"才删。误判方向永远是"少删"，代价只是回到上游行为。
 */
function recoverOrphanLocks(homeDir) {
  if (homeDir.length === 0) {
    return;
  }
  const locks = [];
  let visited = 0;
  const walk = (dir, depth) => {
    if (depth > 3 || locks.length >= 200 || visited >= 20000) {
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      visited++;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // node_modules 是唯一确定巨大的子树；其余目录都值得看一眼
        if (entry.name === 'node_modules') {
          continue;
        }
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.lock')) {
        locks.push(full);
      }
    }
  };
  walk(homeDir, 0);
  if (locks.length === 0) {
    return;
  }
  let removed = 0;
  let kept = 0;
  for (const lock of locks) {
    let ownerText = '';
    try {
      ownerText = fs.readFileSync(lock, 'utf8');
    } catch (e) {
      kept++;
      continue;
    }
    const owner = Number.parseInt(ownerText.trim(), 10);
    if (!Number.isInteger(owner) || owner <= 0 || owner === process.pid) {
      kept++;
      continue;
    }
    let alive = true;
    try {
      process.kill(owner, 0);
    } catch (e) {
      // ESRCH = 没有这个进程；EPERM = 进程存在但不属于我们（仍算存活）
      alive = !!(e && e.code === 'EPERM');
    }
    if (alive) {
      kept++;
      continue;
    }
    try {
      fs.rmSync(lock, { force: true });
      removed++;
      diag(`孤儿写锁已清理：${lock}（持有者 pid=${owner} 已不存在）`);
    } catch (e) {
      kept++;
    }
  }
  diag(`写锁巡检：发现 ${locks.length} 个，清理孤儿 ${removed} 个，保留 ${kept} 个`);
}

/**
 * 找到 dsh CLI 的 profile-boot 薄入口（re-export runProfile）。
 *
 * 官方两种产物形态都要认（0.1.6-alpha.2 起，tsdown 的命名约定反转了）：
 *   · ≤0.1.6-alpha.1：薄入口是 `profile-boot-<hash>.js`（几十字节）；
 *   · ≥0.1.6-alpha.2：薄入口是 `profile-boot.js`（无 hash），`profile-boot-<hash>.js`
 *     变成了 13KB 的**实现文件**（薄入口从它 re-export）。
 * 共同特征（判据不变）：内容含 `runProfile` 且长度 < 400 字节。
 */
function findProfileBootEntry(cliLibDir) {
  const files = fs.readdirSync(cliLibDir);
  for (const f of files) {
    const isCandidate = f === 'profile-boot.js'
      || (f.startsWith('profile-boot-') && f.endsWith('.js'));
    if (!isCandidate) {
      continue;
    }
    const full = path.join(cliLibDir, f);
    const text = fs.readFileSync(full, 'utf8');
    // 那个 re-export runProfile 的薄入口很小（几十到三百字节），据此与实现文件区分
    if (text.includes('runProfile') && text.length < 400) {
      return full;
    }
  }
  return null;
}

/**
 * 把核心树里的端侧 profile 装到 $DSH_HOME/profiles/<name>。
 * 幂等：文件始终用核心树里的最新版覆盖（壳的 patch 层必须随核心版本更新），
 * 但 package.json 若已存在则只补缺失的字段，避免覆盖掉用户装的插件。
 *
 * ── 用户插件行（E91）────────────────────────────────────────────────────
 *
 * dsh 的 profile 分层里，"用户层"就是 `<profile 目录>/cordis.patch.yml`
 * （`dsh-app-boot/lib/index.js:861-862`：`patchPath = join(dir, 'cordis.patch.yml')`，
 * **不是** `$DSH_HOME/cordis.patch.yml`——早先的注释写错了）。
 *
 * 而这一层**每次启动都被我们用核心树里的种子覆盖**（上面的循环），于是"用户在端侧改的
 * 启停"必然丢。所以把两件事分开：
 *   · `cordis.patch.yml`：始终 = **核心种子 + 用户行**（本函数每次重新拼装，核心升级照常流入）；
 *   · `.dshm-plugin-rows.yml`：**只放用户行**（`- id:` + `disabled:`），由端侧「插件」页维护，
 *     我们从不覆盖它 ⇒ 启停在重启后仍然成立。
 * "恢复默认"因此是一次**删除**：删掉用户行文件，下次启动拼出来的就是纯种子。
  */
/** 用户行文件名（值以 dshm-user-rows.js 的导出为准，此处不再重复定义）。 */

/**
 * 把用户行拼进 patch 的实现已移到 dshm-user-rows.js（D27 死锁修复，2026-09-23）：
 * 拼行前逐条预检 node_modules/<id> 的 package.json 与入口文件，坏行不拼、
 * diag 留取证；启动失败时配合 fail() 的标记做"下次启动隔离用户行"的自愈。
 * 本文件只保留调用（见 ensureProfile 尾部）；常量定义以模块导出为准。
 */

function ensureProfile() {
  const src = path.join(CORE_DIR, 'profiles', PROFILE);
  if (!fs.existsSync(src)) {
    fail('核心树里没有 profiles/' + PROFILE + '：' + src);
  }
  const dest = path.join(HOME_DIR, 'profiles', PROFILE);
  ensureDir(dest);
  // 【启动自愈（D27）】上次启动失败过 ⇒ 先隔离用户插件行再拼装（详见 dshm-user-rows.js）。
  // 必须在种子覆盖/composeUserRows 之前：自愈后的本次启动就是纯种子 profile。
  userRows.quarantineAfterBootFailure(dest, HOME_DIR, { log, diag });
  const srcPkg = path.join(src, 'package.json');
  const destPkg = path.join(dest, 'package.json');
  if (!fs.existsSync(destPkg)) {
    fs.copyFileSync(srcPkg, destPkg);
  } else {
    try {
      const seed = JSON.parse(fs.readFileSync(srcPkg, 'utf8'));
      const cur = JSON.parse(fs.readFileSync(destPkg, 'utf8'));
      cur.dsh = cur.dsh || {};
      cur.dsh.profile = cur.dsh.profile || {};
      /*
       * 【bundles 合并 = 种子为准的顺序并集，**再减去被移除的**】（报告 8 §2 根因）
       *
       * 原来只有 `cur ∪ seed`，于是**任何进入过设备 profile 的 bundle 都再也去不掉**：
       * 种子删了它也没用（并集把它加回来）。报告 8 观测到的正是这个后果——
       * `package.json` 的 bundles 里始终留着 `…dsh-experimental-voice-input-bundle`，
       * 我们改种子 patch、禁 4 行都只是"在半条链上补洞"，bundle 本身仍在。
       *
       * 现在引入**显式移除清单**（`dsh.profile.removeBundles`，写在种子 package.json 里）：
       * 合并时先把清单里的名字从两端都剔除，再从设备侧持久删除。这样
       * "上游以后加回来 / 用户曾启用过"都能被清掉。
       *
       * 【为什么不是"完全以种子为准"】那会把用户自己加的 bundle 抹掉——用户行/自定义
       * bundle 是产品能力（插件页启停依赖它）。所以用"并集 − 移除清单"这个口径：
       * 既尊重用户新增，又能表达"这一版我们确定不要它"。
       */
      const removeBundles = Array.isArray(seed.dsh.profile.removeBundles)
        ? seed.dsh.profile.removeBundles : [];
      const seedBundles = Array.isArray(seed.dsh.profile.bundles) ? seed.dsh.profile.bundles : [];
      const curBundles = Array.isArray(cur.dsh.profile.bundles) ? cur.dsh.profile.bundles : [];
      const removeSet = new Set(removeBundles);
      // 先按种子顺序（保证 bundle 拓扑序稳定），再补设备侧独有的（用户新增的）
      const ordered = [];
      const seen = new Set();
      for (const b of seedBundles.concat(curBundles)) {
        if (removeSet.has(b) || seen.has(b)) {
          continue;
        }
        seen.add(b);
        ordered.push(b);
      }
      const removedNow = (seedBundles.concat(curBundles)).filter((b) => removeSet.has(b));
      cur.dsh.profile.bundles = ordered;
      /*
       * 【为什么不把清单也写进设备文件】本来想写一份"跟着设备走"的副本，但那是多余的：
       * 每次启动都会现读**种子** package.json（就是上面那个 seed），清单永远是新的。
       * 反而写进去会在用户文件里留一个 loader 不认识的键（虽无害，但脏）。
       */
      if (removedNow.length > 0) {
        const uniq = Array.from(new Set(removedNow));
        log('profile bundles 已移除（按种子 removeBundles 清单）：' + uniq.join('、'));
      }
      cur.dsh.profile.patchReload = seed.dsh.profile.patchReload || cur.dsh.profile.patchReload;
      fs.writeFileSync(destPkg, JSON.stringify(cur, null, 2) + '\n');
    } catch (e) {
      log('合并 profile package.json 失败，沿用已有文件：' + e.message);
    }
  }
  /*
   * 【缺陷 4 修复的前置】在种子覆盖之前，把 profile 里**现有的** patch 原文读走。
   *
   * 为什么必须在这里读：下面的循环会用核心种子整文件覆盖 cordis.patch.yml，
   * 而 dsh 0.1.7 的设置页把模型/提供方就写在这个文件里 ⇒ 覆盖后那份配置就没了。
   * 把原文交给 composeUserRows，由它挑出"种子没有的顶层条目"保回来。
   *
   * 读失败（首次安装没有该文件）不报错——那时本来也没有东西要保。
   */
  let prevPatchText = '';
  try {
    const p = path.join(dest, 'cordis.patch.yml');
    if (fs.existsSync(p)) {
      prevPatchText = fs.readFileSync(p, 'utf8');
    }
  } catch (e) {
    prevPatchText = '';
  }
  for (const name of fs.readdirSync(src)) {
    if (name === 'package.json') {
      continue;
    }
    fs.copyFileSync(path.join(src, name), path.join(dest, name));
  }
  userRows.composeUserRows(dest, { log, diag, profile: PROFILE, prevPatchText });
  // 【依赖预检（D27 根因第二落点）】profile package.json 的 dependencies 是
  // dsh loader 的 include 源（dsh-app-boot 的 resolveModuleFallbackEntries），
  // 且 package.json 刻意不被种子覆盖 ⇒ 脏行（旧版 mergeDependencies 写入的
  // 整棵依赖树）必须逐条预检移除，否则预检用户行也拦不住 BOOT_ERR。
  // 【bundle 预检（D27 根因第四落点）】dsh.profile.bundles 的坏行同样在此洗：
  // 判据与 loadProfileDirectory 同语义（node_modules 可解析 + dsh.bundle.patch
  // 声明 + patch 文件在）；种子 bundles 走白名单（核心树里的，无条件保留）。
  let seedBundles = [];
  try {
    const seedPkg = JSON.parse(fs.readFileSync(srcPkg, 'utf8'));
    seedBundles = Array.isArray(seedPkg.dsh.profile.bundles) ? seedPkg.dsh.profile.bundles : [];
  } catch (e) {
    log('读种子 package.json 的 bundles 失败（bundle 预检退化为全量判）：' + e.message);
  }
  userRows.sanitizeDependencies(dest, {
    log,
    diag,
    seedBundles,
    // resolveBundleDir 先查核心树再查 profile（dsh-app-boot lib/index.js:899-904）：
    // OPTIONAL_BUNDLES（dsh-experimental-agent-team-*）这类核心树可选 bundle 从这里判，
    // 只查 profile 侧会误杀（真机实证：第四轮装机洗掉了两行 optional bundle）。
    anchorDirs: [path.join(CORE_DIR, 'node_modules')],
  });
  // 【home 层预检（D27 根因第三落点）】$DSH_HOME/cordis.patch.yml 每次 startup 都
  // 被 readProfilePatches（0.1.6 树 dsh-app-boot lib/index.js:1010）读进 loader 的
  // patch 栈，且不在 profile 目录里、种子覆盖够不着——真机实证（第三轮）：rows
  // 与 dependencies 全清后 BOOT_ERR 仍复发。坏引用 → 整体改名隔离（保数据）。
  userRows.sanitizeHomePatch(dest, HOME_DIR, { log, diag });
  // 【半残包隔离（卫生措施）】行清干净后 node_modules 里的残目录只是残留，但任何
  // 未来机制再引用它都会回到同一死锁；目录是"已装坏"的取证现场——改名隔离。
  userRows.quarantineBrokenPackages(dest, { log, diag });
  // 【卫生（2026-09-26 报告 2 §清理清单）】回收超过 7 天的隔离残留
  //（.dshm-broken-* / .quarantine-*）：只删过期的，近期保留供取证。
  userRows.cleanupQuarantineResidue(dest, HOME_DIR, { log, diag });
  log('profile 已就位：' + dest);
}

/**
 * 自探 HTTP：确认端口**真的应答**——"dsh 说它绑了端口"与"端口真的通"是两件事。
 *
 * 用 `node:http` 而不是 fetch：这里要的是最原始的事实，不该掺任何 HTTP 客户端层的东西
 * （端侧的 fetch 还是我们垫的，见 fetch-shim.js）；`node:http` 的 llhttp 是原生的，与 WASM 无关。
 * 失败不抛异常、只返回描述串——它的用途是**读数**，不是门禁（门禁在 ArkTS 侧）。
 */
function probeHttpReady(port, attempts = 10, intervalMs = 500) {
  const http = require('node:http');
  const started = Date.now();
  return new Promise((resolve) => {
    const attempt = (left) => {
      const req = http.request({ host: '127.0.0.1', port: port, path: '/', method: 'GET', timeout: 2000 }, (res) => {
        res.resume();
        resolve(`GET / → HTTP ${res.statusCode}（${Date.now() - started}ms）`);
      });
      req.on('error', (e) => {
        if (left <= 1) {
          resolve(`未应答：${e.code === undefined ? e.message : e.code}（${Date.now() - started}ms，共探测 ${attempts} 次）`);
          return;
        }
        setTimeout(() => attempt(left - 1), intervalMs);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    };
    attempt(attempts);
  });
}

async function start() {
  const missing = reportConfigError();
  if (missing.length > 0) {
    // 不 throw、不 exit：只如实记录。核心还没装好时这就是正常状态，
    // 上层（核心页）据此显示"尚未安装核心"，而不是让应用消失。
    console.error('[dshm-host] 缺少：' + missing.join('；') + '。核心尚未就绪，Host 不启动。');
    globalThis.__dshmHostError = 'missing-config: ' + missing.join(';');
    return;
  }
  stage('BOOT_10_ENV_READY',
    `core=${CORE_DIR} home=${HOME_DIR} sandbox=${SANDBOX_HOME} port=${PORT} profile=${PROFILE}`);
  const cliLibDir = path.join(CORE_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib');
  if (!fs.existsSync(cliLibDir)) {
    fail('核心树里找不到 dsh CLI：' + cliLibDir);
  }
  const entry = findProfileBootEntry(cliLibDir);
  if (entry === null) {
    fail('找不到 profile-boot 入口（核心树可能不完整）');
  }
  const appBoot = path.join(CORE_DIR, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
  if (!fs.existsSync(appBoot)) {
    fail('找不到 dsh-app-boot：' + appBoot);
  }

  stage('BOOT_20_CORE_FOUND', `entry=${path.basename(entry)}`);
  ensureDir(HOME_DIR);
  ensureProfile();
  stage('BOOT_30_PROFILE_READY', `home=${HOME_DIR} profile=${PROFILE}`);

  log('导入 ' + entry);
  const profileBoot = await import(pathToFileURL(entry).href);
  const appBootMod = await import(pathToFileURL(appBoot).href);

  /*
   * 【参数表以 dsh-web-app 的 startup.js 为准】
   *   new Command().name("dsh --profile web")
   *     .option("--host <host>").option("--no-open").option("--port <port>")
   *     .option("--trusted-host <authority...>")
   * —— 合法的就这四个。
   *
   * 【曾经写过一个不存在的 `--skip-auth`】实测真机读数（D6 E33）：
   *     error: unknown option '--skip-auth'   → runProfile 直接拒绝，Host 从未起监听（rc=1）
   * 而 dsh 的"认证"不是可以关掉的开关：它是 `/api` 的 **browser-trust fence**，
   * 且 Host 会把**带 token 的 authenticatedUrl** 打到 stdout（startup/index.js 里
   * `if (config.printUrl) console.log(...)`）——我们把 stdout 抓到 hilog 后即可读到那个 URL。
   * 所以端侧客户端该做的是"从 Host 输出里取 URL"，而不是试图关掉认证。
   */
  // `--trusted-host` 属于 dsh 的应用级选项（dsh-web-app 的 startup.js 定义了这四个：
  // --host / --no-open / --port / --trusted-host <authority...>），必须走这里交给
  // `ctx.cmdlineArgs`。**绝不能**放进 buildHostArgv——那是 Node 自身 argv，
  // 实测把 `--trusted-host` 放那儿会得到 `node: bad option` 且 Host 完全起不来（D6 E68）。
  // 端侧是"本机同源、浏览器等价"的场景，所以显式声明回环 authority 为可信来源。
  const args = [
    '--port', PORT,
    '--host', '127.0.0.1',
    '--no-open',
    '--trusted-host', `127.0.0.1:${PORT}`,
  ];
  log('runProfile profile=' + PROFILE + ' args=' + args.join(' '));
  stage('BOOT_40_PROFILE_BOOT', `entry=${path.basename(entry)}`);

  // 抓 dsh 的 authenticatedUrl（含 token）：客户端唯一的凭据来源，落在 host-ready.json。
  // 只装不卸：匹配成功后它只是把 write 原样透传，开销可以忽略；而"URL 恰好晚一拍打印"
  // 这种情况比"卸载时机"更容易出错。
  watchdogAuthUrl();
  recoverOrphanLocks(HOME_DIR);
  // 预热运行时事实：把三个原生 require 挪到写 host-ready.json **之前**，
  // 这样拦截 stdout 写的那条路径上只读缓存（那里不适合做重活）。
  runtimeFacts();
  const result = await profileBoot.runProfile({
    environment: appBootMod.loadLayeredEnv('dsh'),
    profile: PROFILE,
    patchFiles: [],
    args: args,
  });
  stage('BOOT_50_DSH_INIT', 'runProfile 已返回');

  const ctx = result && result.ctx;
  if (!ctx || !ctx.webServer) {
    fail('runProfile 返回了但没有 webServer');
  }
  stage('BOOT_60_HTTP_BIND', `port=${ctx.webServer.port}`);
  // python 桥 HTTP 端点（/dshm-python/*）：垫片与诊断工具的进程内执行通道。
  // 注册失败只 diag（桥是增量能力，不许影响已验证的 web 服务链路）。
  registerPythonHttpBridge(ctx);
  // registry 查询端点（/dshm-registry/view）：`pnpm view` 假壳的 Host 侧转发目标。
  // 注册失败只 diag（view 是增量能力，不影响已验证的 web 服务链路）。
  registerRegistryViewEndpoint(ctx);
  // 包清单端点（/dshm-packages/list）：skin-market 在 pnpm add 后跑
  // `pnpm list --json --depth=0` 定位已装包真实路径，缺它会报
  // "installed package manifest missing"。转发给该端点即可（同 view 的增量能力）。
  registerPackageListViewEndpoint(ctx);
  // 这行是给 ArkTS 侧的机器可读信号：ArkTS 会等到端口可连为止。
  // authUrl 是**冗余通道**：主通道是 host-ready.json（ArkTS 侧按文件读，见 adoptLocalHost）。
  console.log('DSHM_READY ' + JSON.stringify({
    port: ctx.webServer.port,
    home: HOME_DIR,
    profile: PROFILE,
    authUrl: readHostReadyUrl(),
  }));
  log('Host 已就绪，端口 ' + ctx.webServer.port);
  // 自探一次：确认端口**真的应答**（"dsh 说它绑了"与"端口真的通"是两件事）
  probeHttpReady(ctx.webServer.port).then((note) => {
    stage('BOOT_70_HTTP_READY', note);
  });

  const shutdown = result.shutdown;
  /*
   * ── 协作式停止（E90）─────────────────────────────────────────────────────
   *
   * 【为什么需要它】端侧没有任何办法让这个 Node 线程退出：
   *   · 原生层（`dshhost.cc`）只在 `node::Start` **返回**时才把 `g_running` 置假，
   *     而 `node::Start` 要返回，就得有人让 Node 自己收工；
   *   · ArkTS 侧不能给已经启动的进程发信号、也不能改它的环境变量；
   *   · `dshhost.stopHost()` 因此如实返回"做不到"（这是诚实，但"停止核心"这个
   *     按钮就成了空按钮）。
   * 而**核心切换/回滚必须能停**（`CoreStore.stageFromZip` 明确拒绝覆盖正在使用中的版本），
   * 所以停止通道不是锦上添花，是那条主流程的前置条件。
   *
   * 【为什么用"文件当信号"】已有的事实：ArkTS 能写沙箱目录（`filesDir`），
   * 入口脚本能读它；而两侧之间**没有**其它可用通道（环境变量与 argv 在启动前就固定了，
   * HTTP 侧 dsh 没有 shutdown 端点）。用文件当一个"停止请求"的落点，简单、可观察、
   * 且失败时留下的痕迹（文件还在/日志没有"收到停止请求"）本身就指明断在哪一环。
   */
  let stopRequested = false;
  const requestStop = (reason) => {
    if (stopRequested) {
      return;
    }
    stopRequested = true;
    log(`收到停止请求（${reason}），关闭 Host`);
    try {
      if (shutdown && typeof shutdown.shutdown === 'function') {
        shutdown.shutdown(0);
      }
    } catch (e) {
      log('shutdown 抛错：' + (e && e.message));
    }
    // 兜底：dsh 关掉自己的服务后事件循环通常会自然排空；若 1.5 s 后还活着，
    // 说明仍有句柄（例如我们自己的拦截器/定时器）撑着，那就显式退出——
    // 走到这里已经没有"还没落盘的诊断"需要保护了。
    const t = setTimeout(() => {
      ALLOW_EXIT = true;
      process.exit(0);
    }, 1500);
    t.unref();
  };

  const stopFile = HOME_DIR.length > 0 ? path.join(HOME_DIR, 'host-stop-request') : '';
  if (stopFile.length > 0) {
    const poller = setInterval(() => {
      try {
if (fs.existsSync(stopFile)) {
/*
 * 【诊断（E88）】先读内容再删：ArkTS 侧 `DshHost.stop(reason)` 会写入
 * `${Date.now()} <调用方签名>`，这一行就是「应用里哪条路径按了停止键」的唯一答案。
 * 读失败不影响停止（内容只是诊断信息）。
 */
let dshmStopWhy = '';
try { dshmStopWhy = String(fs.readFileSync(stopFile, 'utf8')).trim().slice(0, 240); } catch (e) { /* ignore */ }
fs.rmSync(stopFile, { force: true });
requestStop(`host-stop-request 文件${dshmStopWhy.length > 0 ? '：' + dshmStopWhy : ''}`);
}
      } catch (e) {
        // 读/删失败下轮再试：这一环不该因为一次 IO 抖动就永久失效
      }
    }, 1500);
    // unref 只表示"它不单独支撑事件循环"，不等于不触发：HTTP 服务还在时它照常轮询。
    poller.unref();
    log(`停止通道已就绪：${stopFile}`);
  }

  /*
   * ── 整机冷启动通道（2026-09-26 报告 4 ②）────────────────────────────────
   *
   * 【要解决什么】dsh 的"重启"（市场重启按钮 / `ctx.appExit`）语义是**整机冷启动**：
   * 完全退出 App 再重新拉起（node 进程也是全新的）。而端侧它原本走的
   * `spawn(process.execPath, ['-e', RELAUNCH_HELPER])` 被 execPath 兜底拒绝 ⇒ 重启
   * 永远失败（真机：`isRelaunchHelper`/`host-restart-request`/`host-exit-mode` 计数全 0）。
   *
   * 【做法：与 host-stop-request 对称的三段式】
   *   ① 这里注册 requestAppRestart：先写 `host-exit-mode = app-restart`（**先写标记
   *      再停**，顺序关键：ArkTS 侧靠这个文件区分"重启"与"仅停服务"，写晚了就成了
   *      普通退出），然后复用 requestStop() 走已验证的关闭链；
   *   ② execPath 兜底识别 relaunch 形态后调用它（见文件头 installExecPathSpawnGuard）；
   *   ③ ArkTS 侧读到 app-restart ⇒ 完全退出并重新拉起（清标记后 startAbility）。
   *
   * 【为什么复用 requestStop 而不是新写关闭逻辑】关闭链（shutdown.shutdown + 1.5s
   * 兜底 process.exit）已在真机反复验证；重启与停止的唯一差别只在**退出后干什么**，
   * 那个决定权交给 ArkTS（它才知道怎么拉 Activity）。Host 只管"把意图与死法写清楚"。
   */
  const exitModeFile = HOME_DIR.length > 0 ? path.join(HOME_DIR, 'host-exit-mode') : '';
  requestAppRestart = (reason) => {
    log(`收到应用重启请求（${reason}）：写入 host-exit-mode=app-restart 后关闭 Host`);
    try {
      if (exitModeFile.length > 0) {
        fs.writeFileSync(exitModeFile, 'app-restart\n', 'utf8');
      }
    } catch (e) {
      log('写 host-exit-mode 失败（重启可能退化为普通退出）：' + (e && e.message));
    }
    requestStop(`app-restart：${reason}`);
  };

  // ── D26 运行时插件安装队列（2026-09-21）────────────────────────────────
  // 端侧没有 pnpm/npm/git（E86），上游 dsh-plugin-manager 的 execa("pnpm")
  // 第一步就 ENOENT，web/CLI 的所有安装路径在端侧都是死路。本通道改为进程内
  // 安装器：任何一侧（ArkUI 设置页 / 模型 skill）往
  // $DSH_HOME/install-queue/<id>.req 写入一行 spec（npm 包名或 GitHub 地址），
  // Host 轮询到后调 dshm-installer.installSpec（纯 JS 下载+解包+落位+用户行），
  // 结果写回同目录 <id>.done / <id>.fail（JSON）。req 取走即删；结果文件留给
  // 写入方读取后自行清理。重启应用后 composeUserRows 把用户行拼进
  // cordis.patch.yml，插件随 profile 挂载生效。
  const pluginInstaller = require('./dshm-installer.js');
  const installQueueDir = HOME_DIR.length > 0 ? path.join(HOME_DIR, 'install-queue') : '';
  let installBusy = false;
  if (installQueueDir.length > 0) {
    fs.mkdirSync(installQueueDir, { recursive: true });
    const installTimer = setInterval(async () => {
      if (installBusy) {
        return; // 一次只装一个：下载/解包互斥，避免并发踩 node_modules
      }
      let reqFile = '';
      //  本次取走的请求的 base 与后缀（含 `.compat-req`）：catch 分支回写 `.fail`
      //  必须沿用，不能按 `.req` 猜（见下方 reqSuffix 赋值处的注释）。
      let reqBase = '';
      let reqSuffix = '';
      try {
        const names = fs.readdirSync(installQueueDir);
        // 陈旧结果清理：写入方（假壳/bash 子进程）退出后 .done/.fail 永远无人读——
        // 2026-09-23 真机实证：pnpm add GitHub 包全程 113s > 假壳旧等待上限 90s，
        // 假壳超时先退，Host 写出的 .done 残留堆积。mtime 超 1h 视为写入方已死。
        const nowMs = Date.now();
        for (const doneName of names) {
          if (!doneName.endsWith('.done') && !doneName.endsWith('.fail')) {
            continue;
          }
          const donePath = path.join(installQueueDir, doneName);
          try {
            if (nowMs - fs.statSync(donePath).mtimeMs > 3600 * 1000) {
              fs.rmSync(donePath, { force: true });
              log(`清理陈旧安装结果文件：${doneName}（写入方已退出）`);
            }
          } catch (eStale) {
            // 单个结果文件 stat 失败不碍事，下轮再看
          }
        }
        //  【P1-3】多一类 `.compat-req`（兼容性豁免）。**必须显式列出**：`.compat-req`
        //  的末四字符是 `-req` 而非 `.req`，旧的 `endsWith('.req')` 匹配不到 ⇒ 面板点
        //  「忽略兼容性警告」后请求会静默滞留到 1h 过期清理，用户以为授权成功、
        //  实际 compatibility.json 从未写入（P1-3 的原症状换了个地方复发）。
        const reqs = names
          .filter((n) => n.endsWith('.req') || n.endsWith('.rem') || n.endsWith('.compat-req'))
          .sort();
        if (reqs.length === 0) {
          return;
        }
        reqFile = reqs[0];
        const isCompat = reqFile.endsWith('.compat-req');
        const isRemove = !isCompat && reqFile.endsWith('.rem');
        const suffix = isCompat ? '.compat-req' : (isRemove ? '.rem' : '.req');
        const base = reqFile.slice(0, -suffix.length);
        const spec = fs.readFileSync(path.join(installQueueDir, reqFile), 'utf8').trim();
        //  供 catch 分支回写 `.fail` 用（见下）：异常时重算后缀会把 `.compat-req`
        //  当成 `.req`，base 就错位成 `xxx.compat` ⇒ 写入方永远看不到失败原因。
        reqBase = base;
        reqSuffix = suffix;
        // 请求方 cwd（市场以目标 profile 目录为 cwd 起 spawn pnpm add）。据此确定该装到
        // 哪个 profile（skin-market 的 profile 是 web，非宿主 ondevice——写错目录市场就
        // 读不到已装 manifest → "installed package manifest missing"）。文件缺失时回退宿主 profile。
        let reqProfileDir = '';
        try {
          const dirFile = path.join(installQueueDir, base + '.dir');
          if (fs.existsSync(dirFile)) {
            const d = fs.readFileSync(dirFile, 'utf8').trim();
            if (d.length > 0) {
              reqProfileDir = d;
            }
            fs.rmSync(dirFile, { force: true });
          }
        } catch (eDir) { /* 读不到不碍事，用默认 profile */ }
        fs.rmSync(path.join(installQueueDir, reqFile), { force: true }); // 取走即删：结果走 .done/.fail，不重入
        //  【P1-3】兼容性豁免请求（`.compat-req`，载荷是 JSON 而非 spec）：先于空 spec
        //  判定处理——这里的"空"只对包名有意义，JSON 空串应报"不是合法 JSON"而不是
        //  "空 spec"（后者会让用户以为该填包名）。
        if (isCompat) {
          installBusy = true;
          const compatOpts = {
            log: (m) => log(`  [compat] ${m}`),
            /*
             * 【D2（2026-10-03）豁免通道必须有 coreDir】
             *
             * `dshm-compat.js` 的 `requireCoreDir(opts)` 在 coreDir 为空时**直接抛错**，
             * 而豁免实现来自上游 `@deepseek-ai/dsh-app-boot`，那份代码只存在于核心树里
             * （`node_modules/@deepseek-ai/dsh-app-boot`）⇒ 没有 coreDir 就无从 `loadAppBoot`。
             * 真机现象：`dsh plugin version-exemptions` 恒返回
             *   `{"ok":false,"error":"缺少 coreDir（或注入 appBoot），无法加载上游 dsh-app-boot 的豁免实现"}`
             * —— 本行此前只设了 profileDir，coreDir 从未设过，整条 `dsh plugin` 辅命令通道
             * 因此坏死（`dsh plugin allow-version` 走的就是这里）。
             *
             * 取值来源：本文件顶层的 `CORE_DIR` 常量（已在作用域内）= 宿主当前**已激活**的
             * 核心版本目录，与 loader 实际解析到的树同源，不会指错版本。
             */
            coreDir: CORE_DIR,
          };
          //  profileDir 决定写进哪个 compatibility.json。缺 `.dir` 时回退宿主 profile
          //  目录（与 ensureProfile 的落点同源）；**不能**静默跳过——那会让"授予成功"
          //  变成空操作。
          compatOpts.profileDir = reqProfileDir.length > 0
            ? reqProfileDir
            : path.join(HOME_DIR, 'profiles', PROFILE);
          let compatReq = null;
          let compatErr = '';
          try {
            compatReq = JSON.parse(spec);
          } catch (eJson) {
            compatErr = `compat 请求不是合法 JSON：${eJson && eJson.message ? eJson.message : eJson}（原文：${spec.slice(0, 120)}）`;
          }
          log(`兼容性豁免请求：${reqFile} → ${compatOpts.profileDir}`);
          const compatResult = compatErr.length > 0
            ? { ok: false, error: compatErr }
            : await compatModule.applyRequest(compatReq, compatOpts);
          fs.writeFileSync(path.join(installQueueDir, base + (compatResult.ok ? '.done' : '.fail')),
            JSON.stringify(compatResult, null, 2));
          log(`兼容性豁免${compatResult.ok ? '完成' : '失败'}：${spec.slice(0, 120)}`
            + `${compatResult.ok ? `（${compatResult.note}）` : `：${compatResult.error}`}`);
          return; // finally 复位 installBusy
        }
        if (spec.length === 0) {
          fs.writeFileSync(path.join(installQueueDir, base + '.fail'),
            JSON.stringify({ ok: false, error: '空 spec' }, null, 2));
          return;
        }
        installBusy = true;
        let result;
        const instOpts = { homeDir: HOME_DIR, profile: PROFILE, log: (m) => log(`  [installer] ${m}`) };
        if (reqProfileDir.length > 0) {
          instOpts.profileDir = reqProfileDir;
        }
        if (isRemove) {
          log(`插件卸载开始：${spec}（来自 ${reqFile}${reqProfileDir.length > 0 ? ' → ' + reqProfileDir : ''}）`);
          result = await pluginInstaller.removeSpec(spec, instOpts);
        } else {
          log(`插件安装开始：${spec}（来自 ${reqFile}${reqProfileDir.length > 0 ? ' → ' + reqProfileDir : ''}）`);
          result = await pluginInstaller.installSpec(spec, instOpts);
        }
        fs.writeFileSync(path.join(installQueueDir, base + (result.ok ? '.done' : '.fail')),
          JSON.stringify(result, null, 2));
        if (isRemove) {
          log(`插件卸载${result.ok ? '完成' : '失败'}：${spec}${!result.ok ? `：${result.error}` : (result.note ? `（${result.note}）` : '')}`);
        } else {
          log(`插件安装${result.ok ? '完成' : '失败'}：${spec}${result.ok ? `（${result.installed.length} 个包，${result.note}）` : `：${result.error}`}`);
        }
      } catch (e) {
        // 队列轮询永不因单次异常断线；req 已删，异常尽力写 .fail 通知写入方
        try {
          if (reqBase.length > 0) {
            //  后缀沿用**本次实际取走**的那个（可能是 `.compat-req`）：按 `.req` 猜会把
            //  base 截错位成 `xxx.compat`，写入方等一个永远不会出现的 `xxx.done`。
            fs.writeFileSync(path.join(installQueueDir, reqBase + '.fail'),
              JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }, null, 2));
          } else if (reqFile.length > 0) {
            const egSuffix = reqFile.endsWith('.rem') ? '.rem' : '.req';
            fs.writeFileSync(path.join(installQueueDir, reqFile.slice(0, -egSuffix.length) + '.fail'),
              JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }, null, 2));
          }
        } catch (e2) {
          // 连 .fail 都写不出（磁盘满/权限）：只剩日志
        }
        log(`插件安装队列异常：${e && e.message ? e.message : e}`);
      } finally {
        installBusy = false;
      }
    }, 2000);
    installTimer.unref();
    log(`安装队列已就绪：${installQueueDir}`);
  }

  process.on('SIGTERM', () => requestStop('SIGTERM'));
}

// 【已合并（2026-09-26 报告 3 ②）】原先这里还有第二份 uncaughtException /
// unhandledRejection 监听器（console.error）。同一个事件会被派发给两个监听器，
// 结果是每条未处理拒绝打两遍。现在统一由文件头部的单一入口处理（含 jitless
// undici 噪声降级），此处不再重复注册。

start().catch((e) => {
  fail('启动失败：' + (e && e.stack ? e.stack : String(e)));
});
