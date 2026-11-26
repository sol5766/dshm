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
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

// 用户插件行守卫（D27 死锁修复，2026-09-23）：预检 + 启动失败自愈。见 dshm-user-rows.js 头注释。
const userRows = require('./dshm-user-rows.js');
// 用户安装 bundle 的延迟挂载清单（2026-11-26，启动提速）：把非首屏 bundle 移出
// profile boot 的同步装载，交给 dshm-boot-extras 在壳就绪后挂载。见模块头注释。
const deferredBundles = require('./dshm-deferred-bundles.js');
// 内置技能同步（P0-1 修复，2026-09-28）：内容 sha256 判等，避免等长改动推不下去。
// 单列文件是为了让 tools/check-skill-sync.cjs 能直接 require（main.js 不可 require）。
const skillsSync = require('./dshm-skills.js');
// 兼容性豁免通道（P1-3 修复，2026-09-28）：把上游 app-boot 的
// `setProfileVersionExemption` 接到端侧可达的入口（队列 + dsh 假壳 + 设置页）。
// 同样单列文件，理由同上（main.js 不可 require）。
const compatModule = require('./dshm-compat.js');
// 纯 JS tar / tar.gz 解包（**单份实现**，与插件安装器共用同一份 walker）。
// 工具链解包保留纯 JS 路径：PC 原生 exec 正常时走进程内 tar，失败时也能在
// 不依赖外部解包器的前提下给出确定结果。
const tarGz = require('./tar-gz.cjs');
// 市场挂载契约补丁的**重放**入口（2026-10-14 回归修复）：皮肤市场常常是**启动之后**才装
// 进来的，boot 那一刻的补丁贴不到它 ⇒ 装完这一跳必须再贴一次。单列文件是为了让
// tools/check-market-bridge.mjs 能直接 require（main.js 不可 require）。见该文件头注。
const marketPatch = require('./dshm-market-patch.cjs');
// dsh-pet 桌面宿主伴生层：静态路由 + DSH_PET_IN_PROCESS（见 dshm-pet-host.cjs 头注）。
const petHost = require('./dshm-pet-host.cjs');
// 主线程侧的**异步 Python 桥**（2026-10-19，LOOP-GAP 根因二）：Python 的**执行**搬到
// ./python-worker.cjs 的 worker 线程里，主线程只负责排队与调度 —— 内测日志里
// `pip install` 那几处 800711ms / 522814ms / 33277ms 的停顿就是"端点里同步跑 Python"造成的。
// 单列文件同样是为了让门禁能直接 require（main.js 不可 require，理由同上）。
const pythonBridgeAsync = require('./python-bridge-async.cjs');
// 需要独立 Node CLI 的插件（如 dsh-bili-whale）由启动期准备受控副本。
// 只登记已确认会 spawn node 的插件，避免所有用户无端复制 100+ MB 运行时。
const nodeRuntimeProvision = require('./node-runtime-provision.cjs');
const ffmpegRuntimeProvision = require('./ffmpeg-runtime-provision.cjs');
const startupWork = require('./startup-work.cjs').create({
  onError: (error) => diag(`startup diagnostic failed: ${String(error)}`),
  companionFor: startupDiagnosticCompanion,
});

/*
 * 运行期诊断总闸（2026-10-25）。
 *
 * 这些埋点是在 LOOP-GAP 排查期逐项加上的；其中 V8 CPU profiler 会常驻一个
 * `v8:ProfEvntProc` 线程并按 1000µs 连续采样，同步 fs 环还会包住每一个高频 fs 调用。
 * 正式包把总闸关掉，只有显式 `DSHM_RUNTIME_DIAG=1` 才启用整组取证；
 * 单项兼容开关 `DSHM_CPU_PROFILE=1` / `DSHM_HB=1` / `DSHM_IN_LOG=1` / `DSHM_TS_LOG=1`
 * 仍可用于现场只开某一项。业务路径不受这个开关影响。
 */
const RUNTIME_DIAG_ENABLED = process.env.DSHM_RUNTIME_DIAG === '1';
let NODE_CLI_STATUS = {
  requested: false,
  ready: false,
  file: '',
  source: '',
  version: '',
  action: 'none',
  error: '',
};

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
pruneStaleHostReady();
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
// 常驻逐行前缀也会增加每个 console 调用的分配；只在显式诊断时启用。
if (RUNTIME_DIAG_ENABLED || process.env.DSHM_TS_LOG === '1') {
        return tsOrig.apply(console, [`[${new Date().toISOString()}]`, ...args]);
      }
      return tsOrig.apply(console, args);
    };
    tsFn.__dshmTsWrapped = true;
    console[tsName] = tsFn;
    tsWrapped++;
  }
diag(`插件日志时间戳前缀已就绪（${tsWrapped} 个 console 方法；仅 DSHM_RUNTIME_DIAG=1 或 DSHM_TS_LOG=1 时逐行生效）`);
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
 * fs 探测缓存的句柄（LOOP-GAP 治理；实现见 ./fs-probe-cache.cjs）。
 *
 * 【为什么先在这里声明成 `let`】真正的安装点在下面（`installNativeRedirect()` 之后、
 * 核心树 require 之前）。若进程在那之前就退出（依赖缺失 / 早退 / 平台杀），exit 回调里
 * 直接读一个还没初始化的 `const` 绑定会踩 TDZ 抛 ReferenceError —— 那会把"进程最后几行
 * 日志"变成一条异常。声明成 `let` + `null` 初值，退出时按"没装上就不打 stats"处理。
 */
let fsProbeCacheHandle = null;
/*
 * 持久解析缓存的句柄（冷启动治理，实现见 ./resolve-cache.cjs）。
 * 与上面 fsProbeCacheHandle 同样的 TDZ 规避：安装点在 CORE_DIR/HOME_DIR 之后、
 * 核心树 import 之前；exit 回调里按"没装上就不打 stats、不落盘"处理。
 */
let resolveCacheHandle = null;

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
  /*
   * fs 探测缓存的自我核对读数（LOOP-GAP 治理，见 docs/199）。
   *
   * 只在退出时打一次：命中 / 未命中 / 直通 / 入缓存条数 / **估计节省的毫秒数**。
   * 用 diagSync 而不是 diag：这一行常常落在进程最后几行里，缓冲写会丢（同上 E88 的理由）。
   * 命中率高但 LOOP-GAP 不变 ⇒ 说明大头不在探测面上，别把这条读数当"已修"的证据。
   */
  try {
    if (fsProbeCacheHandle === null) {
      diagSync('[dshm-host] fs 探测缓存 stats：未安装（安装点未执行）');
    } else {
      const fsProbeStats = fsProbeCacheHandle.stats();
      diagSync('[dshm-host] fs 探测缓存 stats：enabled=' + fsProbeStats.enabled
        + ' TTL=' + fsProbeStats.ttlMs + 'ms'
        + ' 命中=' + fsProbeStats.hits
        + ' 未命中=' + fsProbeStats.misses
        + ' 直通=' + fsProbeStats.passthrough
        + ' 入缓存=' + fsProbeStats.cachedNegatives
        + ' 估计省=' + fsProbeStats.savedMs + 'ms'
        + ' 条目=' + fsProbeStats.entries);
    }
  } catch (e) {
    diagSync('[dshm-host] fs 探测缓存 stats 读取失败：' + (e && e.message));
  }
  /*
   * 持久解析缓存的落盘兜底 + 自我核对读数（冷启动治理，见 ./resolve-cache.cjs）。
   * ready 检查点已落过盘；这里兜底"ready 之后又采集了新条目"的情况。
   * 命中数是下次冷启动收益的直接读数：命中 ≈ 14800 ⇒ 整套解析推导被查表替换。
   */
  try {
    if (resolveCacheHandle === null) {
      diagSync('[dshm-host] 解析缓存 stats：未安装（安装点未执行）');
    } else {
      resolveCacheHandle.flush('exit');
      const rcStats = resolveCacheHandle.stats;
      diagSync('[dshm-host] 解析缓存 stats：enabled=' + rcStats.enabled
        + ' 命中=' + rcStats.hits
        + ' 未命中=' + rcStats.misses
        + ' 直通=' + rcStats.passthrough
        + ' 已采集=' + rcStats.harvested
        + ' 条目=' + rcStats.entries
        + ' 落盘=' + rcStats.flushed
        + (rcStats.flushError.length > 0 ? ' 落盘失败：' + rcStats.flushError : ''));
    }
  } catch (e) {
    diagSync('[dshm-host] 解析缓存 stats 读取失败：' + (e && e.message));
  }
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
            if (String(req.url || '').includes('remote.mux')) startupWork.activity();
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
  if (req.headers && req.headers['user-agent']) {
    res.once('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 400) startupWork.activity();
    });
  }
/* 入站逐请求日志只用于取证；正式运行默认关闭，避免每个 API/WebSocket 请求都分配并落盘。 */
if (!RUNTIME_DIAG_ENABLED && process.env.DSHM_IN_LOG !== '1') return;
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
  diag('入站请求诊断已安装（IN-UPGRADE / IN-REQ；仅 DSHM_RUNTIME_DIAG=1 或 DSHM_IN_LOG=1 时逐请求记录）');
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
 * 采样间隔 1000µs；看门狗发现 >=3s 停顿后（loop 恢复时）stop 落盘，再重新开始；
 * 最多 3 份**且跨启动只保留最近 3 份**（上限见下面 pruneProfiles 的注释）。
 * 全程 try/catch：拿不到 inspector 只记一行 PROF-UNAVAILABLE，绝不影响启动。
 */
let dshmDumpProfile = null;
if (!RUNTIME_DIAG_ENABLED && process.env.DSHM_CPU_PROFILE !== '1') {
  diag('PROF-DISABLED（常驻 V8 采样默认关闭；DSHM_CPU_PROFILE=1 或 DSHM_RUNTIME_DIAG=1 开启）');
} else try {
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
  /*
   * 【为什么还要一条**跨启动**的上限】`profDumps >= 3` 只管**本进程**：每次启动最多落 3 份。
   * 但文件是**跨启动累积**的 —— 2026-10-08 真机清出 46 份 / 156 MiB（≈16 次启动 × 3 份 × ~3.4 MB），
   * 而这类 LOOP-GAP 已被判为平台 appfreeze（`docs/106` §3：心跳线程同期中断 38~59s、停顿期间 0 条
   * `IN-REQ`、同步调用增量仅 ~250ms）⇒ 采样值得留，但只值得留最近几次。
   * 写新文件前把老的削到 `KEEP_PROFILES - 1` 份，磁盘占用因此恒定在 ~3 份。
   */
  const KEEP_PROFILES = 3;
  const pruneProfiles = () => {
    try {
      const names = fsProf.readdirSync(PROF_DIR)
        .filter((n) => n.startsWith('dshm-profile-') && n.endsWith('.cpuprofile'));
      if (names.length < KEEP_PROFILES) { return; }
      const aged = names.map((n) => {
        const full = path.join(PROF_DIR, n);
        let t = 0;
        try { t = fsProf.statSync(full).mtimeMs; } catch (e) { t = 0; }
        return { full, t };
      }).sort((a, b) => a.t - b.t);
      for (const item of aged.slice(0, aged.length - (KEEP_PROFILES - 1))) {
        try { fsProf.unlinkSync(item.full); } catch (e) { /* 删不掉就留着，绝不影响采样 */ }
      }
    } catch (e) { /* 目录读不到：下一次采样照样写，不影响主流程 */ }
  };
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
        pruneProfiles();
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
 * 默认关闭；`DSHM_HB=1` 或 `DSHM_RUNTIME_DIAG=1` 开启。worker 用 unref()
 * 挂起，不参与主进程存活判定（排空后照样能自然退出）。
 */
try {
  if (!RUNTIME_DIAG_ENABLED && process.env.DSHM_HB !== '1') {
    diag('心跳线程默认关闭（DSHM_HB=1 或 DSHM_RUNTIME_DIAG=1 开启）');
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
    diag(`心跳线程已启动（pid=${process.pid}；每 1s 写 ${dshmHbFile}；仅显式诊断时启用）`);
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
 * 【LOOP-GAP 除根】收窄 Node 全局模块搜索路径（2026-10-19，见 docs/199 §8）。
 *
 * 【为什么缓存还不够（缓存治第 2 次、这里治第 1 次）】下面那层 fs 探测负结果缓存只把
 * "同一路径 30s 内**第二次**探测"变快；**第一次**照样要付。分诊报告 P0-2 / S-07 给的就是第一次：
 *   SYNC-SLOW 192220ms existsSync
 *     /storage/Users/currentUser/.node_modules/@cocofhu/skillhub/package.json
 * （另两笔同型 15843ms / 36839ms）。自变量不是我们的代码，而是 **Node 启动时按 HOME 拼出来的
 * 全局路径表**：本机 `HOME=/storage/Users/currentUser`（公共存储挂载）⇒ 任何一次 `require('包')`
 * 在正常 `node_modules` 链上没命中，都会回退去探 `$HOME/.node_modules`、`$HOME/.node_libraries`
 * 这些慢目录，一次 miss 就是 3.7s ~ 192s。
 *
 * 【做法】把指向前缀 `/storage/Users/currentUser` 的全局项摘掉（**应用沙箱内路径一律保留**）：
 *   · `NODE_PATH` 里的同类项直接从 env 过滤（worker 继承 env ⇒ 这一半连带修好）；
 *   · "活路径表"只能靠 Node 自己的 `Module._initPaths()` 用收窄后的输入重算 ——
 *     ⚠️ `Module.globalPaths` 只是内部 `modulePaths` 的**浅拷贝**，splice / 赋值它**对解析无效**
 *     （实测 Node v24.19.0；依据与实验见 module-path-guard.cjs 头注 §二）；
 *   · 重算期间 `HOME`/`USERPROFILE` 被临时清空，**同一同步窗口内 `finally` 逐字还原**，
 *     不存在"异步期间 HOME 是空"的窗口。
 *
 * 【为什么必须在这个位置】与下面缓存层同理：必须早于核心树 require；而且要**早于**缓存层 ——
 * 先摘掉慢路径，再缓存剩下的负结果。顺序反了会把"第一次 192s 的那条负结果"缓存起来，
 * 收益仍然只有第二次。`DSHM_GLOBAL_PATHS=keep` 可整条关掉（排障时复现旧行为）。
 *
 * 打出来的诊断行（供事后检索与门禁断言，tools/check-module-path-guard.mjs 会钉这段字面量）：
 *   [dshm-host] 全局模块路径已收窄（移除 N 项 /storage/Users/currentUser，NODE_PATH 移除 M 项，保留 K 项）
 * keep 模式下是 `全局模块路径保持原样（DSHM_GLOBAL_PATHS=keep）`；
 * 失败时是 `全局模块路径收窄失败（不阻塞）：…`（绝不抛、绝不改解析语义）。
 */
try {
  const modulePathGuard = require('./module-path-guard.cjs');
  modulePathGuard.installModulePathGuard({ log: diag });
} catch (e) {
  diag('全局模块路径收窄安装失败（不阻塞启动，退回 Node 默认全局路径）：' + (e && e.message));
}

/*
 * 【LOOP-GAP 根因治理】同步 fs「探测型」调用的**负结果**缓存（2026-10-19）。
 *
 * 【问题读数】内测日志里事件循环停顿与同步调用账本指向同一件事（见 docs/199）：
 *   LOOP-GAP 33277ms（第 9413 拍）/ 最长一次 800711ms（13 分钟）；
 *   SYNC-SLOW-LOG 36839ms existsSync
 *     /storage/Users/currentUser/.node_modules/@linxin666/dsh-web-all/package.json；
 *   SYNC-COUNT existsSync×332830=64485ms | readFileSync×122216=42862ms。
 * 这些 existsSync 绝大多数是 Node / 打包器**逐级向上找 node_modules** 产生的**负结果**
 * ——同一个"不存在"的答案被重复问上万次，每次都要穿透到慢存储。
 *
 * 【为什么必须装在**这里**（三个顺序都是承重的，不是随手挑的位置）】
 *   ① 必须早于**核心树 require**（下面 `require(path.join(CORE_DIR, 'node_modules', …))`
 *      那一段，以及 runProfile 挂载的整棵模块图）——缓存只对"装上之后的调用"生效，
 *      晚一步就等于这一轮 LOOP-GAP 白修；
 *   ② 必须晚于 `installNativeRedirect()`（上一行）：那条把 `existsSync` 改写成了
 *      "沙箱里找不到就去 HAP libs/ 找平铺 .node"。缓存层套在它**外面**，于是 `.node`
 *      探测的"真答案"仍由重定向给出；而 `libs/…` 不在白名单里 ⇒ 直通，不缓存；
 *   ③ 必须早于下面的**同步调用环**（SYNC-RING / SYNC-COUNT）：那一层包的是"有效代价"，
 *      装在它前面，命中缓存就立刻表现为快调用 —— 真机上正是靠 SYNC-COUNT 的下降
 *      验证收益，顺序反了读数会骗人。
 *
 * 规则（每一条都是"宁可少省，也不许改语义"，实现与边界见 ./fs-probe-cache.cjs 头注）：
 *   · 只缓存**负结果**，默认 TTL 30s；正结果一律不缓存（装完插件/升完核心必须立刻可见）；
 *   · 只对 `node_modules` / `/package.json` / `/profiles/` / `/install-queue` 形态生效，
 *     其余路径直通；
 *   · `DSHM_FS_PROBE_CACHE=off` 全关，`DSHM_FS_PROBE_CACHE_TTL_MS` 可调；
 *   · 任何异常都直通（缓存层绝不把异常改写成 false / 不存在）。
 * 退出时（exit 钩子）打一行 stats（命中/未命中/节省 ms），供事后核对。
 */
try {
  const fsProbeCache = require('./fs-probe-cache.cjs');
  fsProbeCacheHandle = fsProbeCache;
  const fsProbeState = fsProbeCache.installFsProbeCache({ log: diag });
  if (fsProbeState.enabled) {
    // 这行的字面量（含白名单清单）由 tools/check-fs-probe-cache.mjs 钉住：
    // 它必须与 fs-probe-cache.cjs 的 WHITELIST_LABEL 逐字一致，否则检索/统计会漏。
    diag('[dshm-host] fs 探测缓存已安装（TTL=' + fsProbeState.ttlMs + 'ms，白名单=node_modules/package.json/profiles/install-queue）');
  } else {
    diag('[dshm-host] fs 探测缓存未启用（' + (fsProbeState.reason || '已关闭')
      + '；DSHM_FS_PROBE_CACHE=off 关、DSHM_FS_PROBE_CACHE_TTL_MS 调）');
  }
} catch (e) {
  diag('fs 探测缓存安装失败（不阻塞启动，退回无缓存直通）：' + (e && e.message));
}

/*
 * ── 内存看门狗与诊断（2026-10-19 MatePad Edge 现场）────────────────────
 *
 * 【现场】内测设备（24 GB RAM + 50 GB swap）上，应用启动约 78 秒后系统首次 PSI，
 * 随后 97 条 LowMemoryKill / OomKiller / SwapFull，最终设备重启。启动期快照：
 * ArkWeb 多渲染进程 + Node Host 叠加。
 *
 * 【本块做什么】
 *   ① 10 秒采样 `/proc/self/status` 的 VmRSS 与 `/proc/meminfo` 的 MemAvailable，
 *      追加到 `files/diag-mem`（与 ArkTS 侧 `onMemoryLevel` 同一份文件，按行区分来源）；
 *   ② 越过阈值（RSS > 1600 MiB 或 MemAvailable < 384 MiB）时打 `cdiag` 并在
 *      `files/diag-mem-critical` 落持久标记（≤1 次/分钟，避免写爆）；
 *   ③ 标记只用于诊断；PC 工程没有 guest VM，不再用它切换任何预热门。
 *
 * 关掉：`DSHM_MEM_WATCH=off`。阈值可调：`DSHM_MEM_RSS_LIMIT_MIB` / `DSHM_MEM_AVAIL_FLOOR_MIB`。
 */
try {
  const memEnabled = String(process.env.DSHM_MEM_WATCH || '').trim().toLowerCase() !== 'off';
  const homeEnv = String(process.env.DSHM_HOME || '').trim();
  /* DSHM_HOME = <filesDir>/dsh/home ⇒ 上两级就是 ArkTS 侧的 filesDir */
  const filesDir = homeEnv.length > 0 ? path.dirname(path.dirname(homeEnv)) : '';
  const memDiagPath = filesDir.length > 0 ? path.join(filesDir, 'diag-mem') : '';
  const memCriticalPath = filesDir.length > 0 ? path.join(filesDir, 'diag-mem-critical') : '';
  const readMiB = (file, re) => {
    try {
      const m = fs.readFileSync(file, 'utf8').match(re);
      return m === null ? null : Number(m[1]) / 1024;
    } catch (e) {
      return null;
    }
  };
  const rssMiB = () => readMiB('/proc/self/status', /^VmRSS:\s+(\d+)\s+kB/m);
  const availMiB = () => readMiB('/proc/meminfo', /^MemAvailable:\s+(\d+)\s+kB/m);
  const rssLimit = Number(process.env.DSHM_MEM_RSS_LIMIT_MIB || '1600');
  const availFloor = Number(process.env.DSHM_MEM_AVAIL_FLOOR_MIB || '384');

  /*
   * 读「还有没有等触发的定时任务」（2026-11-08，熄屏任务被冻结）。
   *
   * 调度器的持久域是 `$DSH_HOME/storages/schedule.json`（domain=schedule / version=2 /
   * table=tasks，写入方是 `@deepseek-ai/dsh-schedule`）。任务在 `status === 'active'` 时
   * `record.scheduledAt` 就是下一次应当触发的 UTC 时刻。
   *
   * 【为什么必须进 workload】熄屏时没有运行中的 turn、也没有安装队列 ⇒ 原来的 refs=0，
   * ArkTS 判定"无保活诉求" ⇒ 不申请长时任务 ⇒ 系统冻结进程 ⇒ 到点的定时任务要等亮屏
   * 才补跑（真机实测 19:30:30 的任务 19:33:19 才送达）。把"有活跃调度"算成一份在途事实，
   * 才能让熄屏前就有保活诉求。
   *
   * 读不到 / 结构不认识一律当 0：不能因为调度文件异常而把应用变成"永远忙"。
   */
  const readScheduledWork = () => {
    const out = { count: 0, nextScheduledAt: null };
    try {
      const p = path.join(HOME_DIR, 'storages', 'schedule.json');
      if (!fs.existsSync(p)) return out;
      const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
      const tasks = (doc && doc.tables && doc.tables.tasks) || (doc && doc.tasks) || {};
      let next = null;
      for (const key of Object.keys(tasks)) {
        const item = tasks[key];
        if (!item || item.status !== 'active') continue;
        const record = item.record || item;
        const at = record && record.scheduledAt;
        if (typeof at !== 'string') continue;
        const ms = Date.parse(at);
        if (!Number.isFinite(ms)) continue;
        out.count += 1;
        if (next === null || ms < next) next = ms;
      }
      if (next !== null) out.nextScheduledAt = new Date(next).toISOString();
    } catch (e) { /* 调度域缺失 / 损坏 ⇒ 按无调度处理 */ }
    return out;
  };

  if (memEnabled) {
    const appendMem = (line) => {
      if (memDiagPath.length === 0) return;
      try {
        fs.appendFileSync(memDiagPath,
          new Date().toISOString() + ' host ' + line + '\n');
      } catch (e) { /* 诊断写失败不影响主流程 */ }
    };
    let lastCriticalAt = 0;
    let lastMemWarnAt = 0;
    const timer = setInterval(() => {
      const rss = rssMiB();
      const avail = availMiB();
      if (rss === null && avail === null) return;
      appendMem('rss=' + (rss === null ? '?' : rss.toFixed(1)) + 'MiB avail='
        + (avail === null ? '?' : avail.toFixed(0)) + 'MiB');
      /*
       * ── 工作负载快照（2026-11-03，平板后台任务修复）────────────────────────
       *
       * 【为什么要这个文件】ArkTS 侧要决定"现在到底有没有活要干"，才能申请长时任务
       * （`backgroundTaskManager.startBackgroundRunning`）。但"活"的定义在 Host 里：
       * 会话在跑、有后台 job、有在途安装。熄屏那一刻如果按"没有用户交互"来判，就会被
       * 判成"无诉求"⇒ 系统挂起进程 ⇒ 用户的 agent turn 被打断（真机反馈）。
       *
       * 这里把判据**落盘**给 ArkTS 读（跨语言唯一稳定的共享面是文件系统）：
       *   refs  = (会话在跑 ? 1 : 0) + 在途安装数 + 在途后台 job 数
       * ArkTS 侧 refs>0 就 acquire、归零就 release（见 platform/notify/KeepAlive.ets）。
       * 判据全部取**已有事实**：install-queue 的文件数、card-state 的 running 标记，
       * 不新造状态机。
       */
      try {
        const queueDir = path.join(HOME_DIR, 'install-queue');
        let pending = 0;
        try {
          pending = fs.readdirSync(queueDir).filter((n) => n.endsWith('.req')).length;
        } catch (e) { /* 队列不存在 = 0 */ }
        let turnRunning = 0;
        try {
          const card = JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'card-state.json'), 'utf8'));
          /*
           * 【2026-11-05 修：判据必须认 card-state 的**真实字段**】
           *
           * `registerCardState()` 写出去的形状是：
           *   { updatedAt, session: { sessionId, title, state, turn, step }, balance, usage }
           * 其中 `state` ∈ `idle | running | done | error`（见本文件 5514/5862/5885/5903）。
           *
           * 而这里原来只认**顶层** `running` / `turnActive` 两个键 —— 它们从来没被任何写入方
           * 产生过 ⇒ `turnRunning` 恒为 0 ⇒ `refs` 只剩安装队列 ⇒ 熄屏那一刻若没有安装任务，
           * ArkTS 侧 `maybeAcquireHandheldKeepAlive()` 算出的 `workloadRefs=0`，长时任务不申请，
           * 手持档（含平板）进程被系统冻结（客户反馈「熄屏/锁屏后任务停摆」「平板无法后台任务」
           * 的**宿主侧一半原因**；另一半是 `KeepAlive.noteScreenState()` 的 refs 判据）。
           *
           * 现在同时认新字段与历史键，任一命中即算"有 turn 在跑"。
           * `turn > 0` 单独不足以判"在跑"：done/error 之后 turn 仍保持上一轮的值。
           */
          const sess = card && card.session ? card.session : null;
          const running = (card && (card.running === true || card.turnActive === true))
            || (sess && sess.state === 'running');
          turnRunning = running ? 1 : 0;
        } catch (e) { /* 卡片状态读不到 = 0 */ }
        const scheduled = readScheduledWork();
        const refs = turnRunning + pending + (scheduled.count > 0 ? 1 : 0);
        const workload = {
          refs: refs,
          turnRunning: turnRunning,
          pendingInstalls: pending,
          scheduledTasks: scheduled.count,
          nextScheduleAt: scheduled.nextScheduledAt,
          at: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(HOME_DIR, 'workload.json'),
          JSON.stringify(workload, null, 2) + '\n', 'utf8');
      } catch (e) { /* 快照写失败不影响主流程；ArkTS 侧读不到就当 refs=0 */ }
      const over = (rss !== null && rss > rssLimit) || (avail !== null && avail < availFloor);
      if (!over) return;
      const now = Date.now();
      if (now - lastMemWarnAt > 30000) {
        lastMemWarnAt = now;
        diag('[dshm-host] 内存告警：rss=' + (rss === null ? '?' : rss.toFixed(1))
          + 'MiB avail=' + (avail === null ? '?' : avail.toFixed(0))
          + 'MiB（阈值 rss>' + rssLimit + ' / avail<' + availFloor + '）');
      }
      if (memCriticalPath.length > 0 && now - lastCriticalAt > 60000) {
        lastCriticalAt = now;
        try {
          fs.writeFileSync(memCriticalPath, new Date().toISOString()
            + ' host rss=' + (rss === null ? '?' : rss.toFixed(1))
            + ' avail=' + (avail === null ? '?' : avail.toFixed(0)) + '\n');
        } catch (e) { /* 标记写失败：下次再试 */ }
      }
    }, 10000);
    if (timer !== undefined && typeof timer.unref === 'function') timer.unref();
    diag('[dshm-host] 内存看门狗已安装（10s 采样；rss>' + rssLimit + 'MiB 或 avail<'
      + availFloor + 'MiB 记危急；diag-mem=' + (memDiagPath || '(无 DSHM_HOME)') + '）');
  }
} catch (e) {
  diag('内存看门狗安装失败（不阻塞启动）：' + (e && e.message));
}

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
/*
 * ── 启动期同步环（docs/339）──────────────────────────────────────────────
 *
 * 【解决什么问题】真机冷启动的 LOOP-GAP 一直是空的（`LOOP-GAP-2050ms SYNC-RING` 后面没内容），
 * 因为同步环**默认关闭**（要 `DSHM_RUNTIME_DIAG=1`），于是"那 3.7 秒被谁挡住"无从归因。
 * 而 `DSHM_RUNTIME_DIAG=1` 会顺带打开逐请求日志等一堆重型埋点，不适合用来测启动。
 *
 * 【做法】默认**只在启动期**装环：从进程开始记到 host-ready 落盘，然后 `dshmRingStop()`
 * **还原全部原函数**并打一份 `SYNC-COUNT` 按耗时 Top12 的榜。
 * 稳态零开销——这正是它可以从"诊断开关"升级为"默认行为"的前提。
 *
 * 【为什么敢默认开】包装器是透传的（只 Date.now() 记账 + try/finally 补时长），
 * 不改任何业务语义；任何一步失败都已被 try/catch 吞掉并只在 diag 留一行。
 * 想打开：`DSHM_BOOT_RING=1`。
 *
 * 【2026-10-31 发布前复核：默认改为**关闭**（opt-in）】原先是默认开启。改的原因不是它不安全，
 * 而是**它在真机上一条数据都没产出**（多份日志里 `SYNC-COUNT` 均未出现），
 * 说明这条路径至少在当前环境里没有按预期走通。发布包不携带"没被验证过会执行"的启动期包装：
 * 一旦装了环却走不到 `dshmRingStop()`，`fs` 会在**整个进程生命周期**里保持被包装 ——
 * 那是稳态开销，正是我们要避免的东西。
 * ⇒ 保留代码（将来排查启动时用 `DSHM_BOOT_RING=1` 打开），默认不参与生产路径。
 */
/*
 * 【2026-11-26 改口径：默认开启】
 * 原先是 opt-in（`DSHM_BOOT_RING=1` 才装），理由写在下面那段长注释里：
 * "发布包不携带没被验证过会执行的东西"。但由此产生的结果是**默认构建测不出停顿归因**，
 * 而这正是当前最缺的数据（实测 p50 9.27s，其中 LOOP-GAP 占 75%–96%）。
 * 改为默认开启（`DSHM_BOOT_RING=0` 可关），并补两道保险：
 *   ① `dshmRingStop()` 在 runProfile 返回、端口绑定后调用（原有）；
 *   ② 30s 兜底定时器：万一上面的收尾走不到，也强制还原全部包装，避免稳态开销。
 */
const DSHM_BOOT_RING_ON = process.env.DSHM_BOOT_RING !== '0';
const dshmRingRestore = [];
/** 兜底卸载定时器：只在启动期存活，停环时清掉（见 DSHM_BOOT_RING_ON 注释）。 */
let dshmRingGuard = null;
let dshmRingActive = false;
/*
 * 【启动期 require 账本】按"被 require 的模块名"累计次数与耗时。
 *
 * 为什么需要它：profile 装载的大头是**模块图加载**（`docs/146` 记过"建树模块加载 1037ms"），
 * 但那只是猜测——环只能抓到同步 fs/cp 调用，抓不到 `require` 本身。
 * 包装 `Module._load` 就能把"哪个包装载贵"直接量出来，且与插件行 id 一一对得上
 * （`@deepseek-ai/dsh-xxx` → 插件行的 name）。这决定了分阶段时该先延后谁。
 *
 * 只记 >=5ms 的调用（一次 require 通常 <1ms，记全部会把内存撑起来且没有信息量）。
 */
const dshmRequireStat = new Map();
const DSHM_REQUIRE_MIN_MS = 5;
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

/**
 * 卸载启动期同步环并打出**启动期同步调用耗时榜**（docs/339）。
 *
 * 【为什么卸载】包装每个高频 fs 调用都有成本（两次 Date.now()）。启动期值得，
 * 稳态不值得 ⇒ 就绪后立刻还原，回到"零开销"的原来行为。
 *
 * 【为什么必须打榜】环只留最后 24 条、SYNC-SLOW 只留 >=1s 的；
 * 而真机上更常见的是"一长串 200–900ms 的中等同步调用"把时间一点点吃掉。
 * `dshmSyncStat` 按名字累计次数与总耗时，正好能看见这种形状。
 * 这张榜就是"那 3.7 秒到底花在哪"的直接答案。
 */
function dshmRingStop(reason) {
  if (!dshmRingActive) { return; }
  if (dshmRingGuard !== null) {
    try { clearTimeout(dshmRingGuard); } catch (e) { /* ignore */ }
    dshmRingGuard = null;
  }
  /*
   * 【`DSHM_RUNTIME_DIAG=1` 时**只打榜、不卸载**】
   * 那个开关的语义是"诊断常驻"，环必须留到进程结束。若在这里也卸掉，
   * 等于偷偷改了诊断模式的行为 —— 而本函数的使命只是给"启动期"收尾。
   */
  if (RUNTIME_DIAG_ENABLED) {
    try { dshmRingDump(`BOOT-RING-SUMMARY(${reason})`); } catch (e) { /* ignore */ }
    diag('启动期同步环汇总已打（DSHM_RUNTIME_DIAG=1：环按诊断语义继续常驻，不卸载）');
    return;
  }
  dshmRingActive = false;
  try { dshmRingDump(`BOOT-RING-STOP(${reason})`); } catch (e) { /* ignore */ }
  for (const restore of dshmRingRestore) { try { restore(); } catch (e) { /* ignore */ } }
  const n = dshmRingRestore.length;
  dshmRingRestore.length = 0;
  diag(`启动期同步环已卸载（还原 ${n} 个入口；之后零包装开销）`);
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
    /*
     * 【require 耗时榜】启动期按"被 require 的模块名"累计。
     * 这张榜回答的是"profile 装载时哪个包最贵"，直接对应插件行的 name，
     * 是分阶段加载时"先延后谁"的依据。只打 Top15，避免日志被刷爆。
     */
    if (dshmRequireStat.size > 0) {
      const rowsReq = [...dshmRequireStat.entries()].sort((a, b) => b[1].ms - a[1].ms);
      const totalReq = rowsReq.reduce((sum, [, v]) => sum + v.ms, 0);
      const topReq = rowsReq.slice(0, 15)
        .map(([n, v]) => `${n}×${v.n}=${v.ms}ms`).join(" ⏐ ");
      diag(`${tag} REQUIRE-COUNT 被计时的 require 总耗时 ${totalReq}ms（${rowsReq.length} 个不同模块），Top15：${topReq}`);
    }
  } catch (e) { /* 记账失败不影响主流程 */ }
}
if (RUNTIME_DIAG_ENABLED || DSHM_BOOT_RING_ON) {
try {
  dshmRingActive = true;
  /*
   * 兜底卸载：装环之后**必须有**一条"一定会走到"的还原路径。
   * 否则一旦 runProfile 抛错/提前 return，fs 会被包装到进程结束（稳态开销）。
   * 30s 足够覆盖当前 p90 15s 的冷启动，且不会与正常收尾冲突（正常收尾会 clear）。
   */
  dshmRingGuard = setTimeout(() => {
    if (dshmRingActive) {
      try { dshmRingStop('watchdog-30s'); } catch (e) { /* ignore */ }
    }
  }, 30000);
  if (dshmRingGuard && typeof dshmRingGuard.unref === 'function') { dshmRingGuard.unref(); }
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
    try {
      fs[name] = dshmTrack(name, orig);
      dshmRingRestore.push(() => { try { fs[name] = orig; } catch (e) { /* ignore */ } });
    } catch (e) { /* 只读属性就跳过 */ }
  }
  const dshmSyncCp = require("node:child_process");
  for (const name of ["spawnSync", "execFileSync", "execSync"]) {
    const orig = dshmSyncCp[name];
    if (typeof orig !== "function") { continue; }
    try {
      Object.defineProperty(dshmSyncCp, name, { configurable: true, enumerable: true, writable: true, value: dshmTrack(name, orig) });
      dshmRingRestore.push(() => {
        try {
          Object.defineProperty(dshmSyncCp, name, { configurable: true, enumerable: true, writable: true, value: orig });
        } catch (e) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
  }
  try {
    const dshmWait = Atomics.wait;
    dshmRingRestore.push(() => { try { Atomics.wait = dshmWait; } catch (e) { /* ignore */ } });
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
  /*
   * require 计时（与同步环同生命周期）。放在环之后：先保证环本身可用，
   * 再加这一层——它失败也只丢"按包耗时"这一个读数，不影响同步环。
   */
  try {
    const dshmModule = require("node:module");
    const dshmOrigLoad = dshmModule._load;
    dshmModule._load = function (request, parent, isMain) {
      const t0 = Date.now();
      try {
        return dshmOrigLoad.apply(this, arguments);
      } finally {
        const ms = Date.now() - t0;
        if (ms >= DSHM_REQUIRE_MIN_MS) {
          try {
            const e = dshmRequireStat.get(request) || { n: 0, ms: 0 };
            e.n += 1; e.ms += ms;
            dshmRequireStat.set(request, e);
          } catch (err) { /* 记账失败不影响装载 */ }
        }
      }
    };
    dshmRingRestore.push(() => { try { dshmModule._load = dshmOrigLoad; } catch (e) { /* ignore */ } });
    diag(`启动期 require 计时已安装（只记 >=${DSHM_REQUIRE_MIN_MS}ms 的调用）`);
  } catch (e) {
    diag(`启动期 require 计时安装失败（不阻塞）：${e && e.message}`);
  }
  diag("同步调用环已安装（启动期自动开启；DSHM_BOOT_RING=0 可关；>=200ms 记 SYNC-WARN、>=1s 记 SYNC-SLOW）");
} catch (e) {
  diag(`同步调用环安装失败（不阻塞）：${e && e.message}`);
}
} else {
  diag('同步调用环默认关闭（避免包装每个高频 fs / child_process 调用；DSHM_RUNTIME_DIAG=1 开启）');
}

/*
 * 【无条件的版本标识（docs/339 §9.6）】不管环装没装上、装完卸没卸，这一行**一定**打。
 *
 * 起因：真机反馈"装了最新包但搜不到 SYNC-COUNT"。要区分到底是
 *   ① 装的是旧包（没有这段代码），还是
 *   ② 日志窗口没覆盖到启动（像 22:56 那份在 launch 后 1 秒就断了），
 * 只靠"有没有 SYNC-COUNT"是分不开的——两者都不出现。
 *
 * 加这一行之后：只要日志里**有** BOOT_00，就必然有它；看见了它却看不见 SYNC-COUNT，
 * 那就是环没装/没走到收尾，而不是窗口问题。armed 直接给出环的最终状态。
 */
diag(`DSHM-BOOTRING version=v2 armed=${dshmRingActive ? '1' : '0'}`
  + ` env=${process.env.DSHM_BOOT_RING === '0' ? 'off' : 'default'}`
  + ` diag=${RUNTIME_DIAG_ENABLED ? 'on' : 'off'}`
  + ' ／ 有此行即说明本包含启动期同步环；若看不到 SYNC-COUNT 请检查启动窗口是否完整');

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

/**
 * 把"本次实际在跑的核心目录名"发布到 `$DSH_BASE/cores/.current`（2026-11-12，docs/410）。
 *
 * 【为什么需要】`bin/dsh` 壳只能靠 glob 猜最新核心，而 glob 展开是**字符序**：
 * `0.2.2-rc.1+dshm.10` 会排在 `+dshm.9` 前面 ⇒ 到 dshm.10 时静默回退旧核心。
 * 宿主本来就知道当前核心（`state.json` 的 `current` / `DSHM_CORE_DIR`），直接发布一份
 * 权威答案即可，壳不必再猜。写失败不阻塞启动：壳会退回原有 glob 行为。
 */
function publishCurrentCore() {
  if (DSH_BASE.length === 0 || CORE_DIR.length === 0) {
    return;
  }
  const name = path.basename(CORE_DIR);
  if (typeof name !== 'string' || name.length === 0) {
    return;
  }
  const dir = path.join(DSH_BASE, 'cores');
  const file = path.join(dir, '.current');
  try {
    if (!fs.existsSync(dir)) {
      return;
    }
    const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
    if (prev === name) {
      return;
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, name + '\n', 'utf8');
    fs.renameSync(tmp, file);
    diag(`bin/dsh：当前核心已发布到 cores/.current（${name}）`);
  } catch (e) {
    diag(`bin/dsh：写 cores/.current 失败（壳退回 glob 字典序）：${String(e).slice(0, 120)}`);
  }
}

const CORE_DIR = process.env.DSHM_CORE_DIR || currentCoreDir();
const HOME_DIR = process.env.DSHM_HOME || (DSH_BASE.length > 0 ? path.join(DSH_BASE, 'home') : '');
const SANDBOX_HOME = process.env.DSHM_SANDBOX_HOME || USER_DATA || HOME_DIR;
const PORT = process.env.DSHM_PORT || '3120';
const PROFILE = process.env.DSHM_PROFILE || 'ondevice';

/*
 * ── 冷启动种子（2026-11-16，首启提速）──────────────────────────────────────
 *
 * 全新安装后的第一次启动：解析缓存是空表（A2 首启装 0 条），编译缓存在端侧
 * 从未落盘（宿主进程被杀、AtExit 不执行，见下方 markReady 处的编译缓存落盘
 * 注释）——首启必然全冷。本层把随包预置的两份种子（解析表 JSON + V8 code
 * cache blob）在插件图装载**之前**拷进可写目录，让"装完第一次点开"≈温启动。
 * 边界与安全论证全量见 ./boot-seed.cjs 头注；DSHM_BOOT_SEED=off 全关。
 *
 * 【安装点约束】必须先于下方 installResolveCache（解析种子要先落到 HOME_DIR
 * 才会被它读到），也必须先于核心树装载（编译种子要先就位、装载期编译才命中）。
 */
try {
  const bootSeed = require('./boot-seed.cjs');
  const bs = bootSeed.installBootSeed({ homeDir: HOME_DIR, log: diag });
  if (bs.enabled) {
    diag('[dshm-host] 冷启动种子已装载（种子目录=' + bs.seedDir
      + ' 解析新拷=' + bs.resolveCopied
      + ' 编译新拷=' + bs.compileCopied + '/' + bs.nsCount + ' ns）');
  } else if (bs.reason.length > 0) {
    diag('[dshm-host] 冷启动种子未装载（' + bs.reason + '）');
  }
} catch (e) {
  diag('冷启动种子装载异常（不阻塞启动）：' + (e && e.message));
}

/*
 * ── 持久解析缓存（冷启动治理，2026-11-15）──────────────────────────────────
 *
 * 温编译缓存（NODE_COMPILE_CACHE，ArkTS 侧注入，ESM 亦覆盖）之后，BOOT_40→50 的
 * 剩余大头是核心树 ESM 解析机器：~14800 次 resolve、每次 ~155µs 的推导
 * （候选 stat 风暴 + package.json 逐级 walk + 归一化），温态本地读数 ~2.5s/7.0s。
 * 答案跨启动不变 ⇒ 持久化到 HOME_DIR，下次冷启动用一次 Map.get 换掉整套推导。
 *
 * 边界（每条"宁可少省，也不许改语义"，全量见 ./resolve-cache.cjs 头注）：
 *   · 只缓存核心树内 parent → 核心树内 target 的 ESM 解析；用户插件 / node: 不碰；
 *   · 命名空间 = coreVersion+builtAt（dshm-core.json）+ Node 版本 + ABI + 格式版本，
 *     核心升级 / 同版本重打 / Node 换版 ⇒ 自动整体失效重新采集；
 *   · DSHM_RESOLVE_CACHE=off 全关；任何异常直通 nextResolve。
 * 安装点必须在 CORE_DIR/HOME_DIR 就绪之后、下方 `await import(entry)` 核心树装载之前
 * —— 晚一步等于这一轮白装。
 */
try {
  const resolveCache = require('./resolve-cache.cjs');
  resolveCacheHandle = resolveCache.installResolveCache({
    coreDir: CORE_DIR,
    homeDir: HOME_DIR,
    log: diag,
  });
  const rcStats = resolveCacheHandle.stats;
  if (rcStats.enabled) {
    diag('[dshm-host] 持久解析缓存已安装（装载条目=' + rcStats.entries
      + ' 命名空间=' + rcStats.ns + '）');
  } else {
    diag('[dshm-host] 持久解析缓存未启用（' + (rcStats.reason || '已关闭')
      + '；DSHM_RESOLVE_CACHE=off 关）');
  }
} catch (e) {
  diag('持久解析缓存安装失败（不阻塞启动，退回常规解析）：' + (e && e.message));
}

/*
 * 清掉**别的 profile 留下的陈旧 `host-ready.<profile>.json`**（2026-11-05 复测 P1）。
 *
 * 现场：`host-ready.superagent.json` 还写着 pid=18911、port=3082，但该进程早已不在，
 * 3082 也连接拒绝。任何按这个文件判断"superagent 在跑"的逻辑都会误判。
 * 判据只能是 pid 存活（`kill(pid,0)`），文件名不能说明任何事。
 * 只清**非主 profile** 的那几份；主 `host-ready.json` 由本进程马上重写。
 */
function pruneStaleHostReady() {
  try {
    const names = fs.readdirSync(HOME_DIR).filter((n) => /^host-ready\..+\.json$/.test(n));
    for (const name of names) {
      const file = path.join(HOME_DIR, name);
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const pid = Number(parsed && parsed.pid);
        let alive = false;
        if (Number.isFinite(pid) && pid > 0) {
          try { process.kill(pid, 0); alive = true; } catch (e) { alive = false; }
        }
        if (!alive) {
          fs.unlinkSync(file);
          diag(`host-ready：清理陈旧 ${name}（pid=${Number.isFinite(pid) ? pid : '?'} 已不在）`);
        }
      } catch (e) { /* 坏 JSON：留着给人看，别替人删证据 */ }
    }
  } catch (e) { /* 读不到目录不影响启动 */ }
}

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
  /*
   * 【端侧不走 Electron（2026-11-03，r9 §八 反馈项）】
   *
   * 这条监听的来历是早期 Electron 宿主：它把"永不建窗"的 Node 宿主当成
   * "所有窗口都已关闭" ⇒ 启动即 quit（真机 `APPSPAWN: Unexpected call: exit(1)`），
   * 于是补一个空监听压掉默认行为。
   *
   * 但**鸿蒙端侧根本没有 Electron**：`require('electron')` 必然抛，catch 里那句
   * "非 Electron 环境？"每天都会打一遍，既噪声又误导（让人以为保活靠它）。
   * 端侧的存活语义由 ArkTS 侧负责 —— 前台由 UIAbility 生命周期持有，
   * 后台由 `backgroundTaskManager` 长时任务持有（`platform/notify/KeepAlive.ets`，
   * refs 由 Host 写的 `workload.json` 驱动）。所以这里在鸿蒙环境**明确跳过**，
   * 只在真正的 Electron 宿主（桌面历史形态）上才注册。
   */
  if (process.platform === 'openharmony' || typeof process.versions.ohos !== 'undefined'
    || String(process.env.DSHM_PLATFORM || '') === 'ohos') {
    log('保活：鸿蒙端侧不注册 Electron 的 window-all-closed（存活由 ArkTS 长时任务负责）');
    return;
  }
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.on === 'function') {
      electron.app.on('window-all-closed', () => {
        log('window-all-closed：按无窗口宿主语义保持存活（不退出）');
      });
      log('已注册 window-all-closed 保活监听');
    }
  } catch (e) {
    log('注册保活监听失败（非 Electron 环境，端侧属预期）：' + e.message);
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
 *   BOOT_40_PROFILE_BOOT 宿主启动预检
 *   BOOT_41_LOCKS_READY  鉴权监听及旧锁恢复完成
 *   BOOT_42_NATIVE_READY 启动所需的原生预检完成
 *   BOOT_45_PROFILE_START 配置就位，进入 runProfile
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

/*
 * ── 编译缓存可见性探针（2026-11-25，B1）────────────────────────────────────
 *
 * `NODE_COMPILE_CACHE` 由 ArkTS 侧（`NodeRuntime` → `buildHostEnv`）传入，但
 * **"环境变量被设置"不等于"libnode 真的启用了缓存"**：若这一版 libnode 没编译
 * `src/compile_cache.cc`，Node 会静默忽略它 —— 于是"我们以为开了、其实没开"，
 * 而启动耗时又没有任何变化，很难区分"缓存没命中"与"缓存根本没生效"。
 *
 * 这里用官方 API（`module.getCompileCacheDir()`）读回**实际状态**，把两种情况分开：
 *   · 返回非空 ⇒ 已启用（打出目录，便于下一次对比条目数）
 *   · 返回空 + env 有值 ⇒ 该 libnode 不支持（结论落盘，不再猜）
 *
 * 【为什么不做目录遍历计数、不主动 enableCompileCache()】
 *   · `readdirSync` 是同步 IO，这条函数在 BOOT_00 之后、任何启动工作之前，
 *     缓存目录可能有上千条目 —— 用几十毫秒换一行日志，在启动路径上是净亏；
 *   · `enableCompileCache()` 与 `NODE_COMPILE_CACHE` 走同一套内部实现，
 *     libnode 若没编译该特性，它同样无效；主动调用只会多一条"看起来做了事"的日志。
 * 所以本函数只读一次状态、零 IO、零副作用；任何异常都吞掉。
 */
function reportCompileCache() {
  const envDir = process.env.NODE_COMPILE_CACHE || '';
  let activeDir = '';
  try {
    const mod = require('node:module');
    if (mod && typeof mod.getCompileCacheDir === 'function') {
      activeDir = mod.getCompileCacheDir() || '';
    }
  } catch (e) {
    activeDir = '';
  }
  if (activeDir.length > 0) {
    diag(`compile-cache: 已启用 dir=${activeDir}`);
    return;
  }
  if (envDir.length > 0) {
    diag(`compile-cache: 未生效 env=${envDir}（当前 libnode 可能未编译 compile_cache）`);
    return;
  }
  diag('compile-cache: 未配置（NODE_COMPILE_CACHE 为空）');
}
reportCompileCache();

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
let RUNTIME_FACTS_COMPLETE = false;
/**
 * exec / 终端探针读数的**内存暂存**（键 = `runtime.<key>`，值 = 该段的对象）。
 *
 * 【为什么要暂存，而不是探完直接补写】`ensureExecutables()` 在 boot 早期就 `setImmediate`
 * 起跑，而 host-ready.json 要等 dsh 把 authenticatedUrl 打到 stdout 才首次落盘 —— 两个
 * 时刻谁先谁后**不确定**。跑在前面的探针若直接补写，遇到的是"文件还不存在"或"文件属于
 * 上一次进程"（pid 守卫）⇒ 读数就丢了。故一律先暂存，`writeHostReady()` 首次落盘时并进去。
 */
const PENDING_RUNTIME_PROBES = {};
/**
 * `pty.node` dlopen 探针结论的缓存（docs/322）。
 *
 * 【缓存什么】只缓存**稳定的坏结论**（"仍被系统拦，权限未生效"）与成功结论；
 * E44 模式（闭包缺）不缓存 —— 那种情况会随依赖闭包装配而变，值得每次重探。
 * 【存在哪】`<HOME_DIR>/runtime-facts.json`（沙箱内，随应用数据走，不涉隐私）。
 * 【核心换树即失效（2026-11-25，r51 R8）】缓存记录带 `corePath`（= CORE_DIR）；
 * 应用内升级核心后 CORE_DIR 变了，旧记录（含没有 corePath 的老格式）一律判失效，
 * 本 boot 重探一次并回写 —— note 恒指**当前**核心树，不再拿 0.2.2 时代的结论
 * 指认 0.2.3 的 pty.node。
 * 【失败态】读写异常一律静默：这是一条**纯降噪**的旁路，不能因为它挡住启动。
 */
const PTY_DLOPEN_CACHE_FILE = 'runtime-facts.json';

function ptyDlopenCachePath() {
  return path.join(HOME_DIR, PTY_DLOPEN_CACHE_FILE);
}

/** 读缓存；`'on'` 表示环境变量要求强制重探。corePath 与当前核心不符即失效。返回探针记录或 null。 */
function readPtyDlopenCache() {
  try {
    if (String(process.env.DSHM_PTY_DLOPEN_PROBE || '') === 'on') {
      return 'on';
    }
    const raw = JSON.parse(fs.readFileSync(ptyDlopenCachePath(), 'utf8'));
    const rec = raw && raw['sandbox-dlopen'];
    if (rec && typeof rec.name === 'string' && typeof rec.note === 'string'
        && typeof rec.ok === 'boolean') {
      if (rec.corePath !== CORE_DIR) {
        return null;
      }
      return { name: rec.name, ok: rec.ok, note: `${rec.note}（缓存）` };
    }
    return null;
  } catch (e) {
    return null;
  }
}

/** 写缓存（只写这一项，保留文件里其它字段；corePath 供换核心后判失效）。 */
function writePtyDlopenCache(record) {
  try {
    let next = {};
    try {
      next = JSON.parse(fs.readFileSync(ptyDlopenCachePath(), 'utf8')) || {};
    } catch (e) {
      next = {};
    }
    next['sandbox-dlopen'] = { name: record.name, ok: record.ok, note: record.note, corePath: CORE_DIR };
    next.updatedAt = new Date().toISOString();
    fs.writeFileSync(ptyDlopenCachePath(), JSON.stringify(next, null, 2));
  } catch (e) {
    /* 写不进去就下次再探：不影响功能 */
  }
}

function deferNativeRuntimeFacts() {
  return process.env.DSHM_PLATFORM === 'ohos'
    && PROFILE === 'ondevice'
    && process.env.DSHM_DEFER_NATIVE_RUNTIME_FACTS === '1'
    && process.env.DSHM_PTY_DLOPEN_PROBE !== 'on';
}

function basicRuntimeFacts() {
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
  return facts;
}

function runtimeFacts(complete = !deferNativeRuntimeFacts()) {
  const previous = RUNTIME_FACTS_CACHE;
  if (previous !== null && (!complete || RUNTIME_FACTS_COMPLETE)) {
    return previous;
  }
  const facts = previous === null
    ? basicRuntimeFacts()
    : { ...previous, natives: [...previous.natives] };
  /*
   * koffi 是宿主使用的运行时依赖。图片和 PTY 能力探测仍返回原实测结果，
   * 端侧可在工作区加载后完成这两个诊断，避免提前触发未使用的原生库。
   */
  const probes = previous === null ? ['koffi'] : [];
  if (complete) {
    probes.push('sharp', 'node-pty');
  }
  for (const mod of probes) {
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
      facts.natives.push({ name: mod, ok: ok, note: note });
    } catch (e) {
      facts.natives.push({
        name: mod,
        ok: false,
        note: (e && e.message ? String(e.message) : String(e)).slice(0, 200),
      });
    }
  }
  /*
   * office wasm 资产探针（R3 回归防护，2026-11-26）：0.2.3 核心曾漏带
   * `@deepseek-ai/libreoffice-kit-wasm`，office_render/convert 直到用户打开文档
   * 才硬报 `Cannot find module .../package.json`（见 docs/PITFALLS.md §2.14）。
   * boot 时解析一次：缺包只记诊断、不阻断其余能力，但排查第一眼可见。
   */
  if (previous === null) {
    try {
      require.resolve(path.join(CORE_DIR, 'node_modules', '@deepseek-ai',
        'libreoffice-kit-wasm', 'package.json'));
      facts.natives.push({ name: 'office-kit-wasm', ok: true, note: 'libreoffice-kit-wasm 随核心在包' });
    } catch (e) {
      facts.natives.push({
        name: 'office-kit-wasm',
        ok: false,
        note: '缺 @deepseek-ai/libreoffice-kit-wasm：office_render/convert 不可用（核心打包回归）',
      });
    }
  }
  if (!complete) {
    RUNTIME_FACTS_CACHE = facts;
    return facts;
  }
  // ── ACL 权限专项探针（ohos.permission.ALLOW_EXTERNAL_NATIVE_CODE 生效性实测）──
  // E39 之前的结论是"沙箱解包出来的 .node，dlopen 被系统拦"——整个 HAP libs
  // 重定向体系都是为绕它而生。若 ACL 权限真的生效，这里应该出现以下之一：
  //   ① dlopen 成功（闭包都齐了）→ 沙箱 .node 直接可用，重定向变冗余兜底；
  //   ② 报 napi 符号找不到（E44 模式）→ noexec 拦截已解除，只差 NEEDED 闭包；
  //   ③ 报 not accessible / operation not permitted → 权限没生效（E39 原样）。
  // 直连 process.dlopen，绕开本文件的 require hook，测的就是"系统层"。
  /*
   * 【2026-10-31 性能/日志收口（docs/322）】这段探针**每次冷启动**都做一次注定失败的
   * `process.dlopen(pty.node)`：真机日志里每次启动固定刷 3 组 `MUSL-LDSO: load ...
   * pty.node failed, namespace=moduleNs_default/ndk, errno=22`。
   * 这些告警来自 **musl 动态加载器**（框架层打印，应用无法关闭），而结论早在 E39 就定了：
   * "沙箱 `.node` 的 dlopen 被系统拦"。⇒ 结论稳定后就不必每次再撞一次：
   *   · `DSHM_PTY_DLOPEN_PROBE=on`  强制重探（排障用）；
   *   · 默认只在**首次**启动时探测一次，结果写进 `<HOME>/runtime-facts.json` 缓存，
   *     之后直接读缓存（日志噪音与一次必然失败的 dlopen 都省掉）。
   */
  const ptyProbeCached = readPtyDlopenCache();
  /*
   * 写法说明：`else try { … } catch (e) { … }` 在语法上合法，但可读性差、
   * 后续裁剪时容易被误当成"if 里还有别的语句"而改坏。这里改成显式的
   * `if (cached) { … } else { probe + catch }`，控制流一眼可见。
   */
  if (ptyProbeCached !== null && ptyProbeCached !== 'on') {
    facts.natives.push(ptyProbeCached);
  } else {
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
    const record = {
      name: 'sandbox-dlopen',
      ok: false,
      note: (noexecLifted
        ? `noexec 已解除但闭包缺（E44 模式，符合预期）：${message.slice(0, 140)}`
        : `仍被系统拦（E39 原样，权限未生效）：${message.slice(0, 140)}`),
    };
    facts.natives.push(record);
    /* 只缓存"仍被系统拦"这一稳定结论（E44 可能因闭包修复而变 ⇒ 下次重探） */
    if (!noexecLifted) {
      writePtyDlopenCache(record);
    }
  }
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
  RUNTIME_FACTS_COMPLETE = true;
  return facts;
}

function scheduleNativeRuntimeFacts(work) {
  if (deferNativeRuntimeFacts()) {
    work.request('native-facts', () => recordRuntimeProbe('natives', runtimeFacts(true).natives));
  }
}
/**
 * 把 authenticatedUrl 拆成 baseUrl + token，写 `<HOME_DIR>/host-ready.json`。
 *
 * 【多 profile 隔离（2026-11-03，docs/349 §6.1）】两个宿主（ondevice@3121 / superagent@3082）
 * 以前写**同一个** `host-ready.json` ⇒ 后起的把前面的覆盖，主界面拿到 3082 的 token
 * 再去访问 3121，实测 **401**。
 * 现在：`ondevice` 写 `host-ready.json`（保持既有读取面不变）；其他 profile 写
 * `host-ready.<profile>.json`，互不覆盖。
 */

function hostReadyPath() {
  return PROFILE === 'ondevice'
    ? path.join(HOME_DIR, 'host-ready.json')
    : path.join(HOME_DIR, `host-ready.${PROFILE}.json`);
}

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
        natives: RUNTIME_FACTS_COMPLETE ? facts.natives : [],
        nodeCli: NODE_CLI_STATUS,
      },
    };
    // 【探针读数先于本次落盘】见 PENDING_RUNTIME_PROBES：exec / 终端两批探针若已经跑完，
    // 此刻文件里还没有它们的读数，这里补上（之后的探针由 recordRuntimeProbe 增量补写）。
    const probeKeys = Object.keys(PENDING_RUNTIME_PROBES);
    for (const probeKey of probeKeys) {
      payload.runtime[probeKey] = PENDING_RUNTIME_PROBES[probeKey];
    }
    /*
     * 【日志侧的可读副本（2026-10-06 加，手机档逼出来的）】手机 / 平板上 el2 的 `home` 是 0700
     * ⇒ `hdc shell` 读不到 host-ready.json；而手机档的 Python 桥也可能不可用（stdlib 归档要 spawn
     * busybox 解包，那一步在手机档 `EACCES`，见 docs/106 §1.2/§7.4）⇒ 这个文件事实上**只有应用
     * 自己读得到**，外部核查（含下一轮自检报告）拿不到读数。故这里把同一批读数压成**一行**写进
     * dshm-host.log：字段与 JSON 一一对应，任何档位都能一条 grep 拿到结论，不必依赖桥。
     */
    if (probeKeys.length > 0) {
      const parts = [];
      const rt = payload.runtime;
      if (rt.exec !== undefined && rt.exec !== null) {
        parts.push(`exec=${rt.exec.summary}`);
      }
      if (rt.terminal !== undefined && rt.terminal !== null) {
        parts.push(`realShell=${rt.terminal.realShell}，shStat=${rt.terminal.shStat}`
          + `，relaySh=${rt.terminal.relaySh}，relayAsh=${rt.terminal.relayAsh}`
          + `，libsExec=${rt.terminal.libsExec}，hostDomain=${rt.terminal.hostDomain}`);
      }
      if (rt.python !== undefined && rt.python !== null) {
        parts.push(`python=${rt.python.selftest}(bridge=${rt.python.bridge}，stdlib=${rt.python.stdlib})`);
      }
      diag(`探针读数（日志副本）：runtime={${probeKeys.join(',')}} ${parts.join(' | ')}`);
    }
    fs.writeFileSync(hostReadyPath(), JSON.stringify(payload, null, 2) + '\n', 'utf8');
    /*
     * 【可核查副本（2026-10-09）】`dsh/home` 是 0700 ⇒ 外部核查（`hdc shell` 是另一个 uid）读不到
     * host-ready.json；而 token 是 Python 桥端点唯一的凭据源 ⇒ 核查脚本会陷进「有 token 才读得到
     * home、home 读不到才想要 token」的死结。此前唯一可读的 token 来源是日志里**客户端**留下的
     * `GET /?token=…` 行 —— 但那行只在「webview **首次**导航」时出现，**重启后 webview 复用 cookie
     * 就再也不出现**（2026-10-09 PC 实测：同一台设备，冷启动那次日志里有 token 行，下一次就没有，
     * 于是当时的代码指纹核对脚本只能报「未验证」）。
     * 故按本仓既有手法（探针读数镜像一行进 dshm-host.log，见上面 runtime 那段）把权威 token 显式
     * 镜像一行：相对「UI 自己的请求行里本来就明文带着 token」这没有新增暴露面，只是把**偶发**变成**必有**。
     */
    if (token.length > 0) {
      log(`host-ready token=${token} port=${payload.port} pid=${process.pid}`);
    }
    stage('BOOT_65_AUTH_URL', `port=${payload.port} tokenLen=${token.length} → host-ready.json`
      + ` node=${facts.nodeVersion} zstd=${facts.zstd} jitless=${facts.jitless}`);

  } catch (e) {
    console.error('[dshm-host] 写 host-ready.json 失败：' + (e && e.message));
  }
  /*
   * 【启动期停顿收口】host-ready.json 已落盘 ⇒ 启动路径不再需要等完整巡检。
   * 启动时只做了 4000 项快扫；这里在 3s 后补到 20000（幂等：已清掉的不重复处理，
   * 活跃锁按 pid 判据保留）。只调度一次，unref 保证不阻止进程退出。
   */
  if (!dshmLockSweepScheduled) {
    dshmLockSweepScheduled = true;
    const sweep = setTimeout(() => {
      try { recoverOrphanLocks(HOME_DIR, 20000); } catch (err) { /* ignore */ }
    }, 3000);
    if (sweep && typeof sweep.unref === 'function') { sweep.unref(); }
  }
}

/**
 * 把一条**探针读数**补进 `host-ready.json` 的 `runtime` 段（原子替换，只补本次进程）。
 *
 * 【为什么需要 —— docs/106 §2】exec 探测与终端能力两组探针要等 spawnSync 出结果（秒级）
 * 才拿得到读数，而 `runtimeFacts()` 在 boot 早期就把 host-ready.json 写完了 ⇒ 此前它们
 * **只进 dshm-host.log**。2026-10-06 两份端侧自检报告（PC r4 / 手机 dshmarket）都因此只能
 * 从日志文本反推"本档到底能不能 exec / python3 能不能跑"。这里在探针跑完后把读数补写回去：
 * 只读 host-ready.json 的 agent / 门禁也能直接回答，不必再翻日志。
 *
 * 【为什么 tmp + rename】ArkTS 侧随时可能读 host-ready.json 取 token；就地截断写会让并发
 * 读者读到半个 JSON（历史上那条"核心已重启，但没读到启动链接"就是这么来的）。同目录
 * rename 是原子替换：读者只会看到旧全文或新全文。
 *
 * 【为什么 pid 守卫】文件可能是**上一次进程**留下的（长驻窗口里进程重启）；补写别人的
 * 读数会张冠李戴 ⇒ pid 不是自己就一个字节都不动（读数已暂存，落盘时由 writeHostReady 带上）。
 *
 * 【与暂存的关系】本函数先把读数写进 PENDING_RUNTIME_PROBES，再尝试补写文件：探针跑在
 * 首次落盘之前时补写必然落空，但读数不会丢 —— `writeHostReady()` 会把它一并落盘。
 */
function recordRuntimeProbe(key, value) {
  PENDING_RUNTIME_PROBES[key] = value;
  const file = path.join(HOME_DIR, `host-ready.json`);
  try {
    const payload = JSON.parse(fs.readFileSync(file, `utf8`));
    if (payload === null || typeof payload !== `object` || payload.pid !== process.pid) {
      // 【这行 diag 不能省】本分支是"读数照旧会落盘，但**不是**由本函数补写的"那条路径
      // （读数由 PENDING_RUNTIME_PROBES 兜住、随 writeHostReady 落盘）。没有它，日志里看
      // 起来像 recordRuntimeProbe 从没跑过 —— 2026-10-06 本轮真机自验时正被这一点绕了一次。
      const filePid = (payload !== null && typeof payload === `object`) ? payload.pid : `n/a`;
      diag(`探针读数已暂存（host-ready.json 仍属于上一次进程 pid=${filePid}，本进程是 ${process.pid}）：runtime.${key}`);
      return;
    }
    if (payload.runtime === null || typeof payload.runtime !== `object`) {
      payload.runtime = {};
    }
    payload.runtime[key] = value;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', `utf8`);
    fs.renameSync(tmp, file);
    diag(`探针读数已补进 host-ready.json：runtime.${key}`);
  } catch (e) {
    // 【"文件还不存在"是预期路径】首次落盘尚未发生（或刚被上一次进程的残留挡住），
    // 这时读数已经在暂存表里，降级成一行说明即可；其它错误仍按失败记录。
    if (e !== null && e !== undefined && (e.code === `ENOENT` || e instanceof SyntaxError)) {
      diag(`探针读数已暂存（host-ready.json 尚未落盘或不是本次进程的）：runtime.${key}`);
    } else {
      diag(`探针读数补写 host-ready.json 失败（不阻塞）：${String(e).slice(0, 140)}`);
    }
  }
}

/** 读回 `host-ready.json` 里的 authenticatedUrl（没抓到就是空串，不抛）。 */
function readHostReadyUrl() {
  try {
    /*
     * 【必须读**本 profile 自己**的那份（2026-11-03，docs/354 §9.5）】
     * 旧实现写死 `HOME_DIR/host-ready.json` —— 那是主宿主（ondevice/3121）的文件。
     * 第二宿主（superagent/3082）启动时因此把**主宿主的 authUrl** 当成自己的打进
     * `DSHM_READY`，日志里就出现"3082 的 profile 配 3121 的 token"这种串台。
     * `hostReadyPath()` 已按 profile 分文件，这里复用即可。
     */
    const p = hostReadyPath();
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
 * 【为什么不用别的手段探测】HAP 内的 node 报 `process.platform === 'linux'`，与桌面 Linux
 * 无法区分；但鸿蒙 PC 档的宿主 node 报 `openharmony`（2026-11-07 实测），两条判据都要认。
 * 【2026-11-07 修正】原实现只认 `/data/storage` 前缀。PC 档 `app.getPath('userData')`
 * 落在 `/storage/Users/<user>`，前缀不匹配 ⇒ 本变量未设 ⇒ 凭据插件按 660 拒绝启动
 * （`.dshm-boot-failed` 的 BOOT_40_PROFILE_BOOT）。而 hmfs 下 `chmod 600` 是空操作
 * （实测仍为 660），所以这条豁免是唯一可行路径，不能靠运维 chmod 绕过。
 */
const DEVICE_SANDBOX_PREFIXES = ['/data/storage', '/storage/Users'];
if (process.platform === 'openharmony'
  || DEVICE_SANDBOX_PREFIXES.some((p) => SANDBOX_HOME.startsWith(p) || HOME_DIR.startsWith(p))) {
  process.env.DSHM_PLATFORM = 'ohos';
  if (PROFILE === 'ondevice') {
    process.env.DSHM_CREDENTIALS_BOUNDED_READ = '1';
    process.env.DSHM_SCHEDULE_OUTPUT_PRECOMPILED = '1';
    process.env.DSHM_WORKBENCH_STARTUP = '1';
    process.env.DSHM_DEFER_NATIVE_RUNTIME_FACTS = '1';
    process.env.DSHM_HMR_OBSERVE_FAST = '1';
    process.env.DSHM_HMR_RECONCILE_FAST = '1';
    process.env.DSHM_INSTALLATION_MANIFEST_PATH_FAST = '1';
    process.env.DSHM_PYTHON_IDLE_OVERLAP = '1';
  }
  diag('平台标识：DSHM_PLATFORM=ohos（鸿蒙端侧：平台名或沙箱路径）');
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
 * 解 Alpine 包里的 symlink 条目会留下"残缺链接占位"（hdc ls 显示 l????????），
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
  /*
   * 当前 profile 目录（生成时写死，同 QDIR 的理由：子进程 env 白名单里读不到 DSH_HOME）。
   * 用途只有一处：`list` 在"pwd 不是包目录"时回落查这里（docs/293 §5.1）。
   */
  `PROFILE_DIR="${HOME_DIR}/profiles/${PROFILE}"`,
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
  /*
   * 【2026-10-29 修 docs/293 §5.2：`npm config` 静默空返回 rc=0】
   *
   * 原文只处理 `config get <key>`：裸 `pnpm config`（不带 get）会一路落到"收集 mykey →
   * 没有 registry ⇒ 打印空串 → exit 0"，用户看到的是**什么都没有、退出码还成功**，
   * 无法区分"没配置"与"不支持"。同一个 `config` 入口的两种形态给出两种语义，本身就是缺陷。
   *
   * 现在：
   *   · `config get <key>` 保持原语义（registry 给真值，其余键回空串 + rc 0 ——
   *     上游 plugin-manager 靠它判 registry，回非零会把安装源判成不可信）；
   *   · 裸 `config` / `config list` / `config --json` 走**明确的只读列表**：
   *     打印端侧真实生效的 registry 一行到 stdout，并把"其余键在端侧无配置链"写进 stderr；
   *   · 写类（`config set` / `config delete`）明确拒绝并 rc 1 —— 端侧没有可写配置链，
   *     假装成功会让用户以为改掉了。
   */
  'if [ "$cmd" = "config" ]; then',
  '  sub="$2"',
  '  if [ "$sub" = "set" ] || [ "$sub" = "delete" ] || [ "$sub" = "rm" ]; then',
  '    echo "pnpm(shim): 端侧不支持修改配置（config $sub）：registry 由 Host 统一管理" >&2',
  '    echo "  需要换源请在「设置 → 插件」里改用 Host 的 registry 配置" >&2',
  '    exit 1',
  '  fi',
  '  if [ -z "$sub" ] || [ "$sub" = "list" ] || [ "$sub" = "ls" ] || [ "$sub" = "--json" ]; then',
  '    echo "registry=https://registry.npmmirror.com/"',
  '    echo "pnpm(shim): 端侧只有 registry 一项配置；其余配置键在端侧不存在（无 pnpm 配置链）" >&2',
  '    exit 0',
  '  fi',
  '  if [ "$sub" = "get" ]; then',
  '    if [ -z "$3" ]; then',
  '      echo "pnpm(shim): 用法 pnpm config get <key>" >&2',
  '      exit 1',
  '    fi',
  '    if [ "$3" = "registry" ]; then',
  '      echo "https://registry.npmmirror.com/"',
  '      exit 0',
  '    fi',
  '    echo ""',
  '    exit 0',
  '  fi',
  '  echo "pnpm(shim): 未知的 config 子命令：$sub（端侧支持 config get <key> 与 config 列表）" >&2',
  '  exit 1',
  'fi',
  /*
   * 兼容旧形态：`get <key>` 直接调用（上游确有这条）。与 `config get` 同语义。
   */
  'if [ "$cmd" = "get" ]; then',
  '  if [ -z "$2" ]; then',
  '    echo "pnpm(shim): 用法 pnpm get <key>" >&2',
  '    exit 1',
  '  fi',
  '  if [ "$2" = "registry" ]; then',
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
  /*
   * ── list：目录解析要"先认 pwd，再回落到当前 profile"（2026-10-29，docs/293 §5.1）──
   *
   * 【原文的三重缺陷】（真机实测 docs/293 §5.1）
   *   · `dir=$(pwd)` 被无条件当成 profile 目录 ⇒ 在 `/tmp` 或家目录下跑 `npm list`
   *     得到 404，却被文案说成"端点到不可达"（把排障方向带歪）；
   *   · 失败分支先 `echo "[]"` 再把退出码覆盖成 0（`echo` 的成功）⇒ 脚本无法据 rc 判断；
   *   · 只有 cd 到 profile 目录才查得出来，而用户未必知道 package.json 在哪。
   *
   * 【现在的口径】
   *   ① pwd 下有 `package.json` ⇒ 就用它（保留"在市场以 profileDir 为 cwd 起 spawn"
   *      这条主路径的原有语义，`pnpm list --json --depth=0` 在任意 JS 项目目录下也成立）；
   *   ② pwd 下没有 ⇒ 回落到**当前 profile 目录**（生成时写死，同 install-queue 的做法），
   *      并在 stderr 说明"这是回落结果"，不让读数来源变得不可追溯；
   *   ③ 两种都失败 ⇒ 文案区分 **404（不是包目录）** 与 **连不上（Host 未就绪）**，
   *      并且 **exit 1** —— 先 `echo "[]"` 让 stdout 仍是合法 JSON，**再** `exit 1`。
   *
   * 【为什么回落到 profile 而不是报错】`npm list` 的用户意图几乎总是"我装了哪些插件"，
   * 而端侧的答案永远在 profile 里；报错只会让用户去找 package.json 的位置。
   * 任何"回落到别处"的结果都在 stderr 里点明，不伪造读数。
   */
  '  if [ "$cmd" = "list" ] || [ "$cmd" = "ls" ] || [ "$cmd" = "ll" ]; then',
  '  TOKEN="${DSHM_PYTHON_TOKEN:-}"',
  '  if [ -z "$TOKEN" ]; then',
  `    TOKEN=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "${HOME_DIR}/host-ready.json" 2>/dev/null)`,
  '  fi',
  '  if [ -z "$TOKEN" ]; then',
  '    echo "pnpm(shim): list 失败：Host token 未就绪（Host 未启动或仍在启动，稍后重试）" >&2',
  '    echo "[]"',
  '    exit 1',
  '  fi',
  /*
   * 【为什么要临时文件】busybox wget 在 404 与"连不上"两种情况下**都是 rc=1 + stdout 空**，
   * 只能靠 stderr 文案区分。把 stdout 收进文件、stderr 收进变量，两条通道就不会互相污染。
   * 目录先建：list 分支可能跑在 `mkdir -p "$QDIR"` 之前（该 mkdir 在 add/rm 分支里）。
   */
  '  mkdir -p "$QDIR" 2>/dev/null',
  '  LISTDIR="$(pwd)"',
  `  if [ ! -f "$LISTDIR/package.json" ]; then`,
  '    LISTDIR="$PROFILE_DIR"',
  '    echo "pnpm(shim): 当前目录不是包目录（无 package.json）⇒ 改查当前 profile：$LISTDIR" >&2',
  '  fi',
  "  LISTENC=$(printf \"%s\" \"$LISTDIR\" | sed -e 's/%/%25/g' -e 's/@/%40/g' -e 's|/|%2F|g' -e 's/ /%20/g' -e 's/&/%26/g' -e 's/+/%2B/g' -e 's/?/%3F/g' -e 's/=/%3D/g' -e 's/#/%23/g')",
  /*
   * 【为什么把 stderr 留下来判、而不是只看 `$?`（2026-10-29 实测）】
   * 随包 busybox 的 wget 在**连不上**与**404**两种情况下都返回 rc=1、stdout 都为空
   * （实测：200 ⇒ rc=0 带正文；404 ⇒ rc=1 空；Connection refused ⇒ rc=1 空）。
   * 原写法只用 `$?` 判，等于把这两种结局压成同一行"端点到不可达"——正是 docs/293 §5.1
   * 指出的"排障方向被带歪"。所以这里把 stderr 收进变量，用其中的 `connect`/`refused`
   * 字样区分"Host 没起来"与"Host 说这个目录不是包目录"。
   */
  /*
   * 【用命令替换一次拿全（stdout+stderr 合并进 ERR，正文另存 OUT）】
   * 为什么不用 `2>&1 >file`：POSIX 下重定向顺序敏感，且 `$QDIR/.list.out` 在
   * 某些 ash 变体里于 mkdir 之前就绪会失败 —— 本轮实测踩过（表现为所有 list 用例都
   * 走"不是包目录"分支，连成功路径也进不去）。改成"先合并 stderr、正文随后分离"。
   */
  `  RAW=$(wget -O - "http://127.0.0.1:${PORT}/dshm-packages/list?token=$TOKEN&dir=$LISTENC" 2>&1)`,
  '  RC=$?',
  /*
   * busybox wget 失败时 stdout 为空、stderr 有文案；成功时 stdout 是 JSON、stderr 可能
   * 有进度行。判据用"正文是否以 [ 或 { 开头"而不是"stderr 是否为空"—— 后者会把带
   * 进度输出的成功也判成失败。
   */
  '  OUT=""',
  '  case "$RAW" in',
  '    \[*|\{*) OUT="$RAW" ;;',
  '    *) OUT="" ;;',
  '  esac',
  '  if [ $RC -eq 0 ] && [ -n "$OUT" ]; then',
  '    printf "%s\\n" "$OUT"',
  '    exit 0',
  '  fi',
  /*
   * 两类失败分开报：连不上（stderr 有 connect/refused/无应答）vs 端点回了非 2xx。
   * 两者的排障动作完全不同 —— "端点到不可达"把 404 也吞进这句，是原缺陷的核心。
   */
  '  case "$RAW" in',
  '    *connect*|*Connect*|*refused*|*timed*|*unreachable*)',
  '      echo "pnpm(shim): list 失败：连不上 Host（127.0.0.1:${PORT}，Host 未启动或仍在启动）" >&2',
  '      ;;',
  '    *)',
  '      echo "pnpm(shim): list 失败：$LISTDIR 不是可枚举的包目录（Host 未返回依赖树：缺 package.json 或未授权）" >&2',
  '      ;;',
  '  esac',
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
  /*
   * 【`--version` 要报真身版本（2026-11-02 移动端复测 P3）】
   * 旧实现硬编码 `0.1.7-rc.1 (dshm install-queue shim)`，排障时会把它当成"真 dsh 没在跑"。
   * 真身能起就 `exec` 它拿真版本；起不来才回落到带 "shim" 字样的兜底串 —— 兜底串保留是
   * 为了"没有核心树"的环境仍能回答，但不会再冒充真版本。
   */
  /*
   * 【非 plugin 子命令转发真 dsh（2026-11-02，docs/344 §3）】
   *
   * superagent 的 SETUP.md 第 4 步就是 `dsh superagent --from-default-profile web
   * --dump-config`；旧壳对它一律回一句"未支持"，命令直接不可用。真身一直在
   * （`${CORE_DIR}/node_modules/@deepseek-ai/dsh/lib/bin.js`，`--version` 报 0.2.1-rc.5），
   * 只是 PATH 上被安装队列壳挡住了。
   *
   * 判据故意简单：**只拦 `plugin`**（那是安装队列通道），其余原样 exec 真身。
   * 不猜子命令名单 —— 上游加子命令时这里不用改。
   *
   * ⚠️ 转发不等于"能启动"：真 dsh 起 profile 仍会被原生 `.node` 挡住（docs/344 §4），
   * 但 `--dump-config`、`--version`、`plugin ... --help` 这类**只组合不启动**的用法可用，
   * 且报错会来自真身（真实原因）而不是壳（"未支持"）。
   */
  /*
   * 【本地路径标识放行（2026-11-02 docs/346 §3）】
   * `dsh plugin --profile X add "link:<dir>"` 是 superagent SETUP 的官方步骤，而队列协议
   * 只认 npm 包名 / GitHub 地址 ⇒ 旧壳直接判"无法识别"。本地 link 不涉及下载与审核，
   * 投递队列没有意义 ⇒ 这类 spec 直接透传真 dsh（真 dsh 会走 pnpm link）。
   */
  /*
   * 【核心路径运行时解析 —— 只用 shell 内建（2026-11-03 第二次修）】
   * 上一版写成「ls -1d 各核心目录再 sort」的命令替换，而端侧 busybox **没有**
   * `ls`/`sort`/`awk`/`sed` 这些 applet（实测 bin/ 下都没有）⇒ 命令替换为空
   * ⇒ 循环一次没跑 ⇒ `_dshbin` 空 ⇒ `dsh --version` 落到"核心 CLI 未就位"。
   * 改用**纯 glob + 内建 test**：不依赖任何外部命令。
   *
   * 【glob 只作兜底（2026-11-12，docs/410）】glob 展开按**字符序**，
   * `+dshm.10` 会排在 `+dshm.9` 之前 ⇒ 升到 dshm.10 时"取最后一个"会静默选回旧核心。
   * 现在首选 `cores/.current`（宿主每次启动发布实际在跑的核心目录名），
   * 读不到才退回 glob；两者都只用 shell 内建。
   */
  /*
   * 【核心目录从**脚本自身位置**推导（2026-11-03 第三次修）】
   * 前两版分别用了写死的 `${CORE_DIR}` 和 `${SANDBOX_HOME:-$HOME}/dsh/cores`：
   *   · 写死 ⇒ 升核心就断（.106→.107→.109 连断三次，docs/349/351）；
   *   · env 推导 ⇒ 真机上算出了 `.107` 的路径，而当时 cores 里**只有 .109**
   *     （v21 体检 [5] 实测），说明该 shell 的 SANDBOX_HOME/HOME 与宿主不一致。
   * 本版：`bin/dsh` 必然在 `<sandbox>/bin/` 下 ⇒ 去掉两级就得到 `<sandbox>`，
   * 再拼 `dsh/cores`。**语义上不可能错**，且只用参数展开、不调任何外部命令
   * （端侧 busybox 没有 ls/sort/awk/sed，这点已踩过两次）。
   */
  '_b="$0"',
  'case "$_b" in',
  '  */*) ;;',
  '  *)',
  '    _rest="$PATH"',
  '    while [ -n "$_rest" ]; do',
  '      _p="${_rest%%:*}"',
  '      case "$_rest" in *:*) _rest="${_rest#*:}" ;; *) _rest="" ;; esac',
  '      [ -n "$_p" ] || continue',
  '      if [ -f "$_p/dsh" ]; then _b="$_p/dsh"; break; fi',
  '    done',
  '    ;;',
  'esac',
  '_bin="${_b%/*}"',
  '_sb="${_bin%/*}"',
  '_cores="$_sb/dsh/cores"',
  /*
   * 【兜底路径按档位推导（2026-11-12，docs/410）】
   * 旧版无条件写死 `haps/entry/...`：phone 档 `bin/` 与 `cores/` 都在
   * `haps/phone/files/` 下，一旦 `$_sb/dsh/cores` 不存在就指到 entry 档的目录，
   * 结果是"核心 CLI 未就位"或选到另一个档的核心。改为先看自己这一档，再试另一档。
   */
  'if [ ! -d "$_cores" ]; then',
  '  case "$_sb" in',
  '    *haps/phone*) _alt="/data/storage/el2/base/haps/entry/files/dsh/cores" ;;',
  '    *) _alt="/data/storage/el2/base/haps/phone/files/dsh/cores" ;;',
  '  esac',
  '  [ -d "$_alt" ] && _cores="$_alt"',
  'fi',
  '_dshbin=""',
  /*
   * 【权威来源 = cores/.current（2026-11-12，docs/410）】
   * 旧实现只靠 glob 取"最后一个"，而 glob 展开按**字符序**：
   * `0.2.2-rc.1+dshm.10` 排在 `+dshm.9` 之前 ⇒ 到 dshm.10 时会静默回退到旧核心。
   * 宿主每次启动把"实际在跑的核心目录名"写进 `cores/.current`，壳优先读它；
   * 读不到（首装、旧版宿主没写过）才退回 glob，行为与旧版一致。
   * `read` 是 shell 内建，不依赖端侧 busybox 缺失的 ls/sort/awk。
   */
  'if [ -f "$_cores/.current" ]; then',
  '  _cur=""',
  '  read _cur < "$_cores/.current" || _cur=""',
  '  if [ -n "$_cur" ] && [ -f "$_cores/$_cur/node_modules/@deepseek-ai/dsh/lib/bin.js" ]; then',
  '    _dshbin="$_cores/$_cur/node_modules/@deepseek-ai/dsh/lib/bin.js"',
  '  fi',
  'fi',
  'if [ -z "$_dshbin" ] && [ -d "$_cores" ]; then',
  '  for _d in "$_cores"/*/; do',
  '    [ -d "$_d" ] || continue',
  '    if [ -f "${_d}node_modules/@deepseek-ai/dsh/lib/bin.js" ]; then',
  '      _dshbin="${_d}node_modules/@deepseek-ai/dsh/lib/bin.js"',
  '    fi',
  '  done',
  'fi',
  /*
   * 【--version 必须放在 _dshbin 解析**之后**（2026-11-03，docs/354 §4.2）】
   * 旧顺序里 `_dshbin` 恒为空 ⇒ 永远打印兜底串 ⇒ v21 体检 [1] 误判 FAIL。
   */
  'if [ "$1" = "--version" ] || [ "$1" = "-v" ]; then',
  '  if [ -n "$_dshbin" ]; then',
  '    exec node "$_dshbin" --version',
  '  fi',
  '  echo "dsh (dshm shim; 核心 CLI 未就位)"',
  '  exit 0',
  'fi',
  'if [ "${1:-}" = "plugin" ]; then',
  '  for _a in "$@"; do',
  '    case "$_a" in',
  '      link:*|file:*|./*|/*)',
  '        if [ -n "$_dshbin" ]; then exec node "$_dshbin" "$@"; fi',
  '        ;;',
  '    esac',
  '  done',
  'fi',
  /*
   * 【核心路径必须**运行时**解析，不能写死（2026-11-03，docs/349 §3）】
   * 旧实现把 `${CORE_DIR}`（写壳时的当前核心）烧进脚本；核心升到 +dshm.107 后
   * 脚本仍指向 +dshm.106 ⇒ `dsh --help` 报 "核心 CLI 未就位（…dshm.106…）" rc=127，
   * 升级一次就回归一次。
   * 现在扫 `cores/<版本>/node_modules/@deepseek-ai/dsh/lib/bin.js`，取**版本最大的那个**
   * （`ls -d` 按名排序，版本串本身有序；取最后一个可用的）。
   */
  'if [ "${1:-}" != "plugin" ]; then',
  '  if [ -n "$_dshbin" ]; then',
  '    exec node "$_dshbin" "$@"',
  '  fi',
  '  echo "dsh：核心 CLI 未就位（在 $_cores 下未找到 lib/bin.js）" >&2',
  '  exit 127',
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
 * pnpm/npm 假壳脚本正文（**生成规则只有这一处**）。
 *
 * 【为什么单独成函数】`docs/293 §5.1/§5.2` 的两条缺陷（list 目录解析与退出码、
 * config 静默空返回）都只在**真跑起来**才现形 —— 静态读字符串看不出"失败分支的
 * 退出码被 echo 覆盖"这类语义错误。抽出来后门禁
 * `tools/check-cli-shim-semantics.mjs` 提取本函数的源码、在假 HOME 下真跑
 * `list` / `config` 分支，对判据（目录回落、rc、stdout/stderr 分流）逐条断言。
 *
 * @param env 生成期常量覆盖（测试注入假 HOME_DIR / PROFILE / PORT）
 */
function cliShimScript(env = {}) {
  const home = typeof env.HOME_DIR === 'string' ? env.HOME_DIR : HOME_DIR;
  const port = env.PORT !== undefined ? env.PORT : PORT;
  const lines = CLI_SHIM_LINES.map((l) => String(l)
    .replaceAll('${HOME_DIR}', home)
    .replaceAll('${PORT}', String(port)));
  return lines.join('\n') + '\n';
}

/**
 * 布置 pnpm/npm/npx 假壳到 busybox bin（PATH 最前 ⇒ 遮蔽系统不存在的真身）。
 * 幂等：每次启动重写（HOME_DIR 若变化随重写生效）；chmod+X_OK 与 busybox 同
 * 策略，但失败只记日志不阻塞——假壳缺失时退化为原始 127 行为，不伤已验证链路。
 */
/**
 * `ps` 垫片（2026-11-02，docs/344 §6 第 4 项）。
 *
 * 【为什么需要】superagent 的控制脚本（`scripts/dsh-superagent start|status`）用
 * `ps -ww -o pid=,ucomm=,args=` 与 `ps -ax` 判断进程在不在。而端侧 toybox/busybox
 * 的 ps **都不支持 `-o`**（实测：只支持 `-A -o` 的部分字段，且没有 `ucomm`），
 * 于是"服务起没起"这一步永远判假。
 *
 * 【做法】直接读 /proc：`comm` 给短名、`cmdline` 给完整 argv（NUL 分隔转空格）。
 * 只实现控制脚本真正用到的两件事：`-o` 列表（支持 pid/ppid/ucomm/comm/args/command，
 * 字段名后带 `=` 表示不要表头）与 `-a/-e/-ax`（本实现恒列全部进程，`-a` 只是兼容）。
 *
 * 【为什么不伪装成 toybox ps】它会漏字段、静默出错；一个诚实的实现比一个残缺的兼容层好。
 */
const PS_SHIM_LINES = [
  '#!/system/bin/sh',
  '# DSHM ps shim：/proc 直读，支持 -o pid=,ucomm=,args= 与 -ax（docs/344）',
  'fmt=""',
  'while [ $# -gt 0 ]; do',
  '  case "$1" in',
  '    -o) fmt="$2"; shift 2 ;;',
  '    -o*) fmt="${1#-o}"; shift ;;',
  '    --format) fmt="$2"; shift 2 ;;',
  '    *) shift ;;',
  '  esac',
  'done',
  'if [ -z "$fmt" ]; then',
  '  fmt="pid=,ucomm=,args="',
  'fi',
  'for d in /proc/[0-9]*; do',
  '  [ -d "$d" ] || continue',
  '  pid=${d#/proc/}',
  '  comm=$(cat "$d/comm" 2>/dev/null) || continue',
  '  args=$(tr "\\000" " " < "$d/cmdline" 2>/dev/null)',
  '  [ -n "$args" ] || args="[$comm]"',
  '  out=""',
  '  IFS=","',
  '  for f in $fmt; do',
  '    name=${f%%=*}',
  '    case "$name" in',
  '      pid) v="$pid" ;;',
  '      ppid) v=$(awk "/^PPid:/{print \\$2}" "$d/status" 2>/dev/null) ;;',
  '      ucomm|comm|comm=) v="$comm" ;;',
  '      args|command|cmd) v="$args" ;;',
  '      *) v="" ;;',
  '    esac',
  '    if [ -n "$out" ]; then out="$out $v"; else out="$v"; fi',
  '  done',
  '  unset IFS',
  '  echo "$out"',
  'done',
  '',
];

/**
 * CLI 假壳的首行解释器（2026-11-07）。
 *
 * 端侧 `/system/bin/sh` 对三方应用 execve 被拒（docs/110 的真机结论），而 busybox 的
 * `ash` 副本在平板/PC 档可执行（与 bash 垫片同一份）⇒ 假壳首行改指它，`pnpm view`
 * 这类**直接 spawn** 才有机会跑起来。`ash` 不可用的档位（手机）保持原样，
 * 那条路本来由 ELF 启动器与进程内桥负责。
 */
function shimShebang(binDir) {
  try {
    const ash = path.join(binDir, BASH_SHIM_INTERPRETER);
    fs.accessSync(ash, fs.constants.X_OK);
    return '#!' + ash;
  } catch (e) {
    return '#!/system/bin/sh';
  }
}

/** 把脚本首行的 `#!/system/bin/sh` 换成可用的解释器（无可用解释器时原样返回）。 */
function withShimShebang(script, binDir) {
  const sh = shimShebang(binDir);
  if (sh === '#!/system/bin/sh') {
    return script;
  }
  return script.replace(/^#!\/system\/bin\/sh/, sh);
}

function ensureCliShims(binDir) {
  if (!binDir || binDir.length === 0) {
    return; // busybox 未布置（PATH 未注入）：假壳无处生效
  }
  if (HOME_DIR.length === 0) {
    return; // HOME_DIR 未解析（写死路径会成空串）：不布置，退化为 127 行为
  }
  /*
   * 【目录必须先建（2026-11-03，手机端 `dsh not found` 的根因）】
   * 手持档 busybox 常常布置失败（execve 被拒），`<SANDBOX>/bin` 于是**不存在**；
   * 旧实现第一件写 `pnpm` 就抛 ENOENT，随后 `return` —— 后面的 npm/npx/dsh/ps
   * **一个都没写**，用户看到的就是 `dsh: command not found`。
   * 这里先 mkdir，且把"单个失败就 return"改成"继续写其余的并记日志"。
   */
  try {
    ensureDir(binDir);
  } catch (e) {
    diag(`CLI 假壳：创建 ${binDir} 失败（继续尝试写文件）：${String(e)}`);
  }
  const installScript = withShimShebang(cliShimScript(), binDir);
  /* 发布权威核心名：`bin/dsh` 优先读它（先于写 shim，壳首次执行即可用）。 */
  publishCurrentCore();
  const npxScript = withShimShebang(NPX_SHIM_LINES.join('\n') + '\n', binDir);
  const dshScript = withShimShebang(DSH_SHIM_LINES.join('\n') + '\n', binDir);
  const psScript = withShimShebang(PS_SHIM_LINES.join('\n'), binDir);
  /*
   * 真身优先（2026-11-02）：随包 npm/pnpm 解包完成后，bin/ 下应当是真 wrapper，
   * 而不是安装队列假壳。判据只看"包里的入口文件在不在"，不看版本。
   */
  const realReady = (n) => {
    const root = n === 'pnpm' ? PNPM_ROOT : NPM_ROOT;
    const entry = n === 'pnpm' ? 'bin/pnpm.cjs' : 'bin/npm-cli.js';
    return n !== 'npx' && statSize(path.join(root, entry)) > 0;
  };
  for (const [name, script] of [['pnpm', installScript], ['npm', installScript], ['npx', npxScript], ['dsh', dshScript], ['ps', psScript]]) {
    if (realReady(name)) {
      continue; // 真身已就绪：留给工具链 wrapper 布置，别用假壳盖掉
    }
    if (!rewriteExecutable(path.join(binDir, name), (d) => fs.writeFileSync(d, script), `CLI 假壳：${name}`)) {
      diag(`CLI 假壳：${name} 写入失败（继续布置其余）`);
    }
    /*
     * 【额外写一份 `<name>-queue`（2026-11-03，r9 §10-1）】
     *
     * `ensureToolchainWrappers()` 在**本函数之后**运行，会把 `bin/pnpm`/`bin/npm`/`bin/npx`
     * 覆盖成"指向 `toolchain/<x>root` 的真身 wrapper"。而手持档那四个 root 是**空的**
     * （解包 spawn busybox EACCES）⇒ wrapper 一路 `exit 127` ⇒ 用户看到的
     * `pnpm：尚未就位（首次启动解包中）` / `command not found` —— 等于把原本可用的
     * **安装队列通道**拆掉了（r9 的头号坑）。
     * 所以这里把队列假壳另外留一份到 `<name>-queue`，由真身 wrapper 在"真身缺失"时
     * `exec` 它：**有真身用真身，没真身回队列**，两条路都不再 127。
     */
    if (name === 'pnpm' || name === 'npm' || name === 'npx') {
      if (!rewriteExecutable(path.join(binDir, name + '-queue'), (d) => fs.writeFileSync(d, script),
        `CLI 队列兜底：${name}-queue`)) {
        diag(`CLI 队列兜底：${name}-queue 写入失败（真身缺失时将退化为 127）`);
      }
    }
  }
  diag('CLI 假壳：pnpm/npm/npx/dsh/ps 已布置（pnpm 走安装队列，ps 直读 /proc）（pnpm add / dsh plugin install 即投递队列，view 转发 Host registry 端点）');
  log('CLI 假壳：pnpm/npm/npx/dsh 已布置为安装队列通道');
}

/**
 * 端侧工具链：CPython 3.12 + git（resfile 携带归档 → 沙箱后台解包自举）。
 *
 * 【为什么自带】沙箱里只有 busybox + node，模型跑 `git …` / `python3 …` 直接 127。
 * resfile/toolchain/ 放 python-build-standalone musl 归档 + Alpine git 包组
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
/**
 * 清掉上次换代遗留的**空** `<name>.previous-<ts>` 备份目录（2026-11-15，rc.3 复测 P1）。
 *
 * 【为什么会堆积】`publishExtras` 与 python 收尾都是"旧树改名成 `.previous-<ts>` → 新树就位"；
 * 成功后旧树不再需要，但改名留下的空壳没人删 —— 复测现场 `toolchain/` 下有 6 个。
 * 【为什么只删空的】非空说明上一轮换代中途失败，里面还有可回退的旧树，必须原样保留；
 * 这条规则保证清理永远不会吃掉回退材料。任何异常都吞掉（清理属于收尾，不影响功能）。
 */
const pruneEmptyPreviousSiblings = (anchor) => {
  const parent = path.dirname(anchor);
  const prefix = path.basename(anchor) + '.previous-';
  try {
    for (const name of fs.readdirSync(parent)) {
      if (!name.startsWith(prefix)) continue;
      const target = path.join(parent, name);
      try {
        if (!fs.statSync(target).isDirectory()) continue;
        if (fs.readdirSync(target).length > 0) continue;
        fs.rmdirSync(target);
      } catch (e) { /* 单个目录清理失败：留到下次，不影响任何功能 */ }
    }
  } catch (e) { /* 父目录读不到：跳过 */ }
};
/*
 * tmux / gh（2026-11-02，docs/342）。形状与 gitroot 完全一致：归档在
 * `resfile/toolchain/<name>/*.tar.gz`，解到 `toolchain/<name>root/`。
 * 两者都由 `tools/place-toolchain.mjs` 在构建期自签名（原生 binary-sign-tool）。
 */
const TMUX_ROOT = path.join(TOOLCHAIN_DIR, 'tmuxroot');
const GH_ROOT = path.join(TOOLCHAIN_DIR, 'ghroot');
/** bash 真身（2026-11-03）：替代 busybox hush 文本垫片。 */
const BASH_ROOT = path.join(TOOLCHAIN_DIR, 'bashroot');
/** 表驱动：一个条目 = 一个 root（判据只看"真身在不在"，不猜版本）。 */
const NPM_ROOT = path.join(TOOLCHAIN_DIR, 'npmroot');
const PNPM_ROOT = path.join(TOOLCHAIN_DIR, 'pnpmroot');
const EXTRA_TOOLCHAINS = [
  { name: 'tmux', root: TMUX_ROOT, probe: ['usr', 'bin', 'tmux'] },
  { name: 'gh', root: GH_ROOT, probe: ['usr', 'bin', 'gh'] },
  { name: 'bash', root: BASH_ROOT, probe: ['bin', 'bash'] },
  /*
   * npm / pnpm（2026-11-02）：纯 JS 包，靠 `node` 执行 —— 不需要 ACL、不需要预编译二进制。
   * 探针指向各自 CLI 入口（不是 bin/ 下的同名壳），因为包里没有可执行位。
   */
  { name: 'npm', root: NPM_ROOT, probe: ['bin', 'npm-cli.js'] },
  { name: 'pnpm', root: PNPM_ROOT, probe: ['bin', 'pnpm.cjs'] },
];
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
 * 名单就是"下次升级静默失效"。这里直接**从包的归档里读 symlink 表**（包是 tar.gz，
 * 读 512 字节头即可，不需要解包），按需复制真身——名字永远与这一版 git 一致。
 * 读不到（归档缺失/格式变化）时退回原来的硬编码一条，保证不退化。
 */
const GIT_SYMLINK_REPLICA_FALLBACK = [['git-remote-https', 'git-remote-http']];

/**
 * 从 git 的归档里读出 `usr/libexec/git-core/` 下的 symlink 表。
 * 纯 JS 遍历 tar（512 字节头 + 512 对齐的数据块）：包 = tar.gz，先 gunzip 再扫。
 * @param pkgPath git-*.tar.gz 路径（内容仍是 Alpine v2 包；目录名与扩展名都不含 `.apk`，
 *   为过应用市场审核里"包内路径带 apk 相关字样就拒装"那道闸，见 docs/148 / docs/156）
 * @returns `[[名, 真身], …]`；读不到返回 null（调用方退回 fallback）
 */
async function readGitCoreSymlinks(pkgPath) {
  try {
    const maxInput = 32 * 1024 * 1024;
    const maxOutputLength = 128 * 1024 * 1024;
    const size = (await fs.promises.stat(pkgPath)).size;
    if (size <= 0 || size > maxInput) {
      return null;
    }
    const compressed = await fs.promises.readFile(pkgPath);
    if (compressed.length > maxInput) return null;
    const raw = await new Promise((resolve, reject) => {
      zlib.gunzip(compressed, { maxOutputLength }, (error, result) => error ? reject(error) : resolve(result));
    });
    const out = [];
    let seen = 0;
    for (const entry of tarGz.walkTar(raw)) {
      const prefix = 'usr/libexec/git-core/';
      if (entry.type === '2' && entry.name.startsWith(prefix) && entry.link.length > 0) {
        const base = entry.name.slice(prefix.length);
        if (base.length > 0 && base.indexOf('/') < 0) {
          out.push([base, entry.link]);
        }
      }
      if (++seen % 64 === 0) await new Promise((resolve) => setImmediate(resolve));
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
  /*
   * tmux / gh wrapper（2026-11-02，docs/342）。
   *
   * 与 git 同构：自举 LD_LIBRARY_PATH 指向本 root 的 usr/lib（Alpine 包把 so 放在那），
   * 再 exec 真身。三处端侧特有的差异：
   *   · tmux 必须显式给 TMUX_TMPDIR：默认走 /tmp，应用沙箱里不可写，
   *     否则 `tmux new` 直接报 "server exited unexpectedly"（socket 建不出来）；
   *   · tmux 的 terminfo 随包带（ncurses-terminfo-base 解到同一 root），
   *     显式 TERMINFO 免得只认系统那份、报 "missing or unsuitable terminal"；
   *   · gh 复用 gitroot 的 CA（本机无系统信任库），并给它独立的 GH_CONFIG_DIR，
   *     避免和用户的 git 配置互相污染。
   */
  /*
   * npm / npx / pnpm（2026-11-02）：**真身**，不再投递安装队列。
   *
   * 判据是"包在不在"—— `main.js` 的 ensureCliShims 只在真身缺失时才写假壳，
   * 所以两套不会互相覆盖（见 ensureCliShims 的 realReady 分支）。
   * 三者都靠 `node` 跑纯 JS 入口；`node` 自身是随包 wrapper（libnode 24.2，实测 v24.2.0 可用）。
   */
  /*
   * 【bash 真身（2026-11-03，把垫片换成环境组件的第 1 项）】
   *
   * 旧形态：`bin/bash` 是 463 B 文本垫片 → busybox hush（busybox 未编 bash applet）。
   * 现在：Alpine bash 5.2.37 真 ELF + 依赖库（readline / libncursesw / terminfo / utmps / skalibs）
   * 解到独立 root `bashroot`，wrapper 自举 LD_LIBRARY_PATH 后 exec 真身。
   *
   * **回落策略**：真身尚未解包（首启几十秒）时**不报错退出**，而是退回 busybox hush ——
   * 与旧行为等价，保证 `bash -c` 在任何时刻都可用；只有 execve 被系统拒绝时才提示。
   */
  if (name === 'bash') {
    /*
     * 【2026-11-03 修正：探测不能拿用户命令试跑】
     *
     * 上一版写错了两处，真机暴露得很彻底：
     *   ① 探测 `_e=$( ( exec "$B" "$@" ) 2>&1 >/dev/null )` **执行的是用户要跑的那条命令**，
     *      stdout 被丢进 /dev/null；命令成功且 stderr 为空 ⇒ `_e` 空 ⇒ 直接 `exit 0`，
     *      于是 `bash --version` 输出为空、`bash -c '…'` 全部"无输出"；
     *   ② 用户命令的 stderr 里若恰好含 "No such file"（例如 `ls 不存在`），会被误判成
     *      "真身不可用"而回落 hush；回落分支 `sh -c "$*"` 还会把带空格的参数拼坏。
     *
     * 正确做法：**只用一次空探测**（`"$B" -c ':'`）判断真身能否加载（so 是否齐），
     * 探测与用户命令完全解耦；通过就 `exec "$B" "$@"`，参数逐字传递。
     */
    const root = BASH_ROOT;
    return [
      '#!/system/bin/sh',
      '# DSHM bash wrapper：Alpine bash 真身（自举 so/terminfo）；空探测通过就 exec，否则回落系统 sh',
      `R=${root}`,
      'B="$R/bin/bash"',
      'if [ -x "$B" ]; then',
      '  _libs="$R/usr/lib"',
      '  [ -d "$R/lib" ] && _libs="$R/lib:$_libs"',
      '  LD_LIBRARY_PATH="$_libs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"',
      /*
       * 【2026-11-11 2in1 终端修复】Alpine 的 ncurses-terminfo-base 装到 `etc/terminfo`，
       * 不是 `usr/share/terminfo`。旧写法把 TERMINFO 指到一个不存在的目录 ⇒ 库查不到条目，
       * xterm-256color 下交互式 bash 6 次里 5 次以 SIGSYS 静默消失（诊断日志 2026-11-11）。
       * 两个位置都探测，优先真实存在的那个；目录全缺或当前 TERM 无条目时退到 xterm。
       */
      '  _ti=""',
      '  if [ -d "$R/etc/terminfo" ]; then _ti="$R/etc/terminfo"; elif [ -d "$R/usr/share/terminfo" ]; then _ti="$R/usr/share/terminfo"; fi',
      '  if [ -n "$_ti" ]; then TERMINFO="$_ti"; export TERMINFO; fi',
      '  if [ -n "$TERM" ]; then _fc=${TERM%${TERM#?}}; if [ -z "$_ti" ] || [ ! -e "$_ti/$_fc/$TERM" ]; then TERM=xterm; export TERM; fi; fi',
      '  export LD_LIBRARY_PATH',
      "  if \"$B\" -c ':' >/dev/null 2>&1; then",
      '    exec "$B" "$@"',
      '  fi',
      'fi',
      'exec /system/bin/sh "$@"',
    ];
  }
  if (name === 'npm' || name === 'npx' || name === 'pnpm') {
    const root = name === 'pnpm' ? PNPM_ROOT : NPM_ROOT;
    const entry = name === 'pnpm' ? 'bin/pnpm.cjs' : (name === 'npx' ? 'bin/npx-cli.js' : 'bin/npm-cli.js');
    return [
      '#!/system/bin/sh',
      `# DSHM ${name} wrapper：随包纯 JS 真身；**真身缺失时回落安装队列**（r9 §10-1）`,
      `R=${root}`,
      `E="\$R/${entry}"`,
      'if [ ! -f "$E" ]; then',
      '  # 手持档的 toolchain root 常年为空（解包 spawn busybox EACCES）⇒ 不能在这里 127：',
      '  # 队列假壳（<name>-queue）会把 add/install 改写成安装队列投递并同步等结果。',
      '  Q="$(dirname "$0")/' + name + '-queue"',
      '  if [ -x "$Q" ]; then exec "$Q" "$@"; fi',
      `  echo "${name}：尚未就位（首次启动解包中），稍后重试" >&2`,
      '  exit 127',
      'fi',
      'exec node "$E" "$@"',
      '',
    ];
  }
  if (name === 'tmux') {
    return [
      '#!/system/bin/sh',
      '# DSHM tmux wrapper：Alpine tmux + 自带 so/terminfo（LD_LIBRARY_PATH 自举）',
      `T=${TMUX_ROOT}`,
      'export LD_LIBRARY_PATH="$T/usr/lib"',
      /* 同 bash wrapper：terminfo 在 etc/terminfo；库缺失时 tmux 会报 "terminal not found" */
      '_ti=""',
      'if [ -d "$T/etc/terminfo" ]; then _ti="$T/etc/terminfo"; elif [ -d "$T/usr/share/terminfo" ]; then _ti="$T/usr/share/terminfo"; fi',
      'if [ -n "$_ti" ]; then export TERMINFO="$_ti"; fi',
      'if [ -n "$TERM" ]; then _fc=${TERM%${TERM#?}}; if [ -z "$_ti" ] || [ ! -e "$_ti/$_fc/$TERM" ]; then TERM=xterm; export TERM; fi; fi',
      /* socket 目录必须落在可写的沙箱 cache 里（/tmp 在端侧不可写） */
      'export TMUX_TMPDIR="${TMUX_TMPDIR:-${TMPDIR:-/data/storage/el2/base/cache}}"',
      'if [ ! -x "$T/usr/bin/tmux" ]; then',
      '  echo "tmux：尚未就位（首次启动解包中），稍后重试" >&2',
      '  exit 127',
      'fi',
      /*
       * 【必须透传真 stderr（2026-11-02，docs/344 §2.4）】旧写法 `( exec … ) >/dev/null 2>&1`
       * 把失败原因全吞了，于是**缺动态库**（`Error loading shared library libevent_core-2.1.so.7`）
       * 也被显示成"该设备系统策略禁止运行第三方原生二进制（execve 被拒）"——
       * 两份独立报告都被这句带偏过。现在把探测段的 stderr 抓下来原样透传，
       * 只在**确实一句错误都没有**时才用那句通用文案。
       */
      '_e=$( ( exec "$T/usr/bin/tmux" -V ) 2>&1 >/dev/null )',
      'if [ -z "$_e" ]; then',
      '  exec "$T/usr/bin/tmux" "$@"',
      'fi',
      'echo "tmux：真身无法执行 —— $_e" >&2',
      'exit 126',
      '',
    ];
  }
  if (name === 'gh') {
    return [
      '#!/system/bin/sh',
      '# DSHM gh wrapper：Alpine github-cli + 自带 so + 复用 gitroot 的 CA',
      `G=${GH_ROOT}`,
      `GITCA=${GIT_ROOT}/etc/ssl/certs/ca-certificates.crt`,
      'export LD_LIBRARY_PATH="$G/usr/lib"',
      /* 端侧没有系统信任库（/etc/ssl/... 实测全无）⇒ 必须显式指一份 */
      'if [ -f "$GITCA" ]; then',
      '  export SSL_CERT_FILE="$GITCA"',
      '  export CURL_CA_BUNDLE="$GITCA"',
      'fi',
      'if [ ! -x "$G/usr/bin/gh" ]; then',
      '  echo "gh：尚未就位（首次启动解包中），稍后重试" >&2',
      '  exit 127',
      'fi',
      /* 同 tmux：透传真 stderr，不再把"缺库"误报成"execve 被拒" */
      '_e=$( ( exec "$G/usr/bin/gh" --version ) 2>&1 >/dev/null )',
      'if [ -z "$_e" ]; then',
      '  exec "$G/usr/bin/gh" "$@"',
      'fi',
      'echo "gh：真身无法执行 —— $_e" >&2',
      'exit 126',
      '',
    ];
  }
  if (name === 'python' || name === 'python3') {
    return [
      '#!/system/bin/sh',
      '# DSHM python wrapper：能 exec 真身就 exec（行为不变），否则桥模式（进程内 CPython）',
      `P=${PYTHON_PREFIX}`,
      'export PYTHONHOME="$P"',
      /*
       * 【2026-11-24】随包 python 是 musl 构建，直接 exec 时需要同目录 libpython；
       * 不设 LD_LIBRARY_PATH 会在部分设备上退化成 "No such file or directory"。
       */
      'export LD_LIBRARY_PATH="$P/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"',
      /*
       * pip 装的包统一落到沙盒 py-site（可写、持久），PYTHONPATH 必须带上；
       * 否则 `pip3 install` 成功但 `python3 -c "import x"` 找不到。
       */
      'PY_SITE="${DSHM_SANDBOX_HOME:-$HOME}/py-site"',
      'export PYTHONPATH="$PY_SITE${PYTHONPATH:+:$PYTHONPATH}"',
      /*
       * wheel 自带的 `*.libs/`（Pillow 的 pillow.libs、numpy 的 numpy.libs 等）必须在
       * 进程启动前进 LD_LIBRARY_PATH；musl 不会替我们按需搜索这些目录。
       */
      'for d in "$PY_SITE"/*.libs "$PY_SITE"/*/*.libs; do',
      '  [ -d "$d" ] && export LD_LIBRARY_PATH="$d${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"',
      'done',
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
      'export LD_LIBRARY_PATH="$P/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"',
      'PY_SITE="${DSHM_SANDBOX_HOME:-$HOME}/py-site"',
      'mkdir -p "$PY_SITE"',
      'export PYTHONPATH="$PY_SITE${PYTHONPATH:+:$PYTHONPATH}"',
      'for d in "$PY_SITE"/*.libs "$PY_SITE"/*/*.libs; do',
      '  [ -d "$d" ] && export LD_LIBRARY_PATH="$d${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"',
      'done',
      /*
       * 【端侧 pip 口径，2026-11-24】
       * ① 随包 CPython 的 platform tag 是 `harmonyos_hongmeng_kernel_..._aarch64`，
       *    与 PyPI 的 `musllinux_1_2_aarch64` 对不上 ⇒ 默认只会去编 sdist（必然失败）。
       *    所以 install 时显式给 platform/abi，并 `--only-binary` + `--target`。
       * ② 默认源用阿里云镜像（端侧直连 pypi.org 实测超时）；可用 PIP_INDEX_URL 覆盖。
       * ③ 装完必须给 .so/.node 补 .codesign，否则 dlopen 被拒（沙盒/用户目录都一样）。
       */
      'export PIP_INDEX_URL="${PIP_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple/}"',
      'export PIP_TRUSTED_HOST="${PIP_TRUSTED_HOST:-mirrors.aliyun.com}"',
      'export PIP_DISABLE_PIP_VERSION_CHECK=1',
      'if [ ! -x "$P/bin/python3.12" ]; then',
      '  echo "pip3：解释器尚未就位（首次启动解包中），稍后重试" >&2',
      '  exit 127',
      'fi',
      'if ( exec "$P/bin/python3.12" --version ) >/dev/null 2>&1; then',
      '  if [ "$1" = "install" ]; then',
      '    shift',
      '    CONST=""',
      '    [ -f "$P/constraints.txt" ] && CONST="--constraint $P/constraints.txt"',
      '    "$P/bin/python3.12" -m pip install --platform musllinux_1_2_aarch64 --python-version 3.12 --implementation cp --abi cp312 --only-binary=:all: --target "$PY_SITE" $CONST "$@"',
      '    rc=$?',
      '    if [ -f "$P/selfsign.js" ]; then',
      '      NB=$(command -v node 2>/dev/null)',
      '      if [ -n "$NB" ]; then',
      '        find "$PY_SITE" -type f \( -name "*.so" -o -name "*.so.*" -o -name "*.node" \) -print | while IFS= read -r f; do "$NB" "$P/selfsign.js" "$f" --force >/dev/null 2>&1; done',
      '      else',
      '        echo "pip3：未找到 node，跳过 .so 签名；带 C 扩展的包可能 import 失败" >&2',
      '      fi',
      '    fi',
      '    exit $rc',
      '  fi',
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
    // templates 目录不存在（git 包里没带），显式指向包内路径，找不到也不报错。
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
  /* tmux / gh：归档在就布置 wrapper（缺归档的旧包不该凭空多出两个坏命令） */
  for (const spec of EXTRA_TOOLCHAINS) {
    try {
      if (fs.existsSync(path.join(resRoot, 'toolchain', spec.name))) {
        names.push(spec.name);
      }
    } catch (e) { /* 读不到就当没有 */ }
  }
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

/** 额外工具链（tmux / gh）是否已解包到位。表驱动，新增一个只需改 EXTRA_TOOLCHAINS。 */
function extraReady(spec) {
  return statSize(path.join(spec.root, ...spec.probe)) > 0;
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
let pyBridgeSelftestActive = false;
let pyBridge = null;           // addon exports（**只在 DSHM_PY_INLINE=1 的降级分支里**才非 null）
let pyBridgeLoadTried = false; // addon 加载只试一次（dlopen 失败属硬错误，不重试）
let pyBridgeMainThreadRefuseLogged = false; // "主线程拒绝加载"只记一行，避免刷屏
let pyWorkerBridge = null;     // python-bridge-async.cjs 的实例（默认执行通道；懒建）

/**
 * 降级开关：`DSHM_PY_INLINE=1` 时退回旧的**同步**桥（Python 在主线程执行）。
 *
 * 【为什么留这个开关】异步桥要真机验收；一旦端侧出现"worker 起不来 / 消息通道不通"
 * 这类环境性故障，一条 env 就能回到已验证的旧行为，不必重编 HAP 去排障。
 * **默认异步**（不读 env 就是 worker 线程执行 Python）。
 *
 * 【为什么逐次读 env】`process.env` 是活对象；而且日志 / 探针要如实反映"这一次走的是哪条路"，
 * 做进程级缓存会让"运行期改 env 排查"这件事失效。
 */
function pyBridgeInlineEnabled() {
  return String(process.env.DSHM_PY_INLINE || '').trim() === '1';
}

function startupDiagnosticCompanion(key) {
  if (key === 'exec' && process.env.DSHM_PLATFORM === 'ohos' && PROFILE === 'ondevice' &&
      process.env.DSHM_PYTHON_IDLE_OVERLAP === '1' && !pyBridgeInlineEnabled()) return 'python';
  return undefined;
}

/*
 * 【启动读数（一行）】真机验收就 grep 这一行：默认必须是 `执行线程=worker`。
 * 有它才能一眼区分"这版到底跑在 worker 里、还是被某个 env 降级回主线程了"。
 */
try {
  diag(pyBridgeInlineEnabled()
    ? 'python 桥：执行线程=主线程（DSHM_PY_INLINE=1 降级：长任务会挡事件循环）'
    : 'python 桥：执行线程=worker（DSHM_PY_INLINE=1 可回退）');
} catch (e) {
  // 日志失败不影响启动
}

/**
 * 解析 addon 与 libpython 的**位置**（只探测、不加载）。返回 null 表示这套 libs 不可用
 * （PC 侧离线跑属正常；端侧则是 place-toolchain / CMake 没出件）。
 *
 * 【为什么要单独一层】异步桥要把这两个路径作为 workerData 传给 worker，主线程的降级分支
 * 也要用同一套判据拼环境变量。两处各拼一次路径 = "垫片按 A 找库、桥按 B 拼路径"那种隐性
 * 漂移（见 NATIVE_LIBS 的注释），所以只在这里拼。
 */
function pyBridgeArtifacts() {
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
  return { libPy, addon };
}

/**
 * 取异步桥实例（懒建、进程级单例）。
 *
 * worker 脚本与会话同目录（端侧 = resfile/resources/app/python-worker.cjs，见
 * tools/place-host-app.mjs 的 FILES 清单）。**漏了那个清单项不会在启动时报错** ——
 * 它是首个请求才走到，只会表现为"python 工具/垫片调用失败"，所以清单必须两处一起改
 * （place-host-app.mjs 与 assert-resfile-sync.mjs 各一份，后者有同源断言）。
 */
function getPyWorkerBridge() {
  if (pyWorkerBridge === null) {
    const artifacts = pyBridgeArtifacts();
    /*
     * 【必须在主线程、创建 worker 之前设】worker_threads 的 `process.env` 是 JS 层
     * 环境副本；worker 内再写 `process.env` 不能可靠地把值同步进进程的 native
     * `environ`，而 `libpython_runner.so` 的 `EnsurePythonInit()` 正是用 `getenv()`
     * 读这两个键。真机读数：worker 已 bridge=true，但自检报
     * `DSHM_PYTHON_LIB 未设置`。主线程先写一次才能让 dlopen 后的 C 层可见。
     */
    if (artifacts !== null) {
      process.env.DSHM_PYTHON_LIB = artifacts.libPy;
      process.env.DSHM_PYTHON_HOME = PYTHON_PREFIX;
    }
    pyWorkerBridge = pythonBridgeAsync.create({
      workerScript: path.join(__dirname, 'python-worker.cjs'),
      workerData: {
        addonPath: artifacts === null ? '' : artifacts.addon,
        libPath: artifacts === null ? '' : artifacts.libPy,
        homePath: PYTHON_PREFIX,
      },
      diag: diag,
    });
  }
  return pyWorkerBridge;
}

/**
 * 加载 python_runner addon（dlopen libpython + dlsym embedding API 的 JS 侧入口）。
 * 成功后缓存到 pyBridge；失败永久放弃（DSHM 硬错误缓存模式）。env 必须在
 * dlopen 前设好：addon 的 EnsurePythonInit 读 DSHM_PYTHON_LIB/HOME。
 *
 * 【只在降级分支里被调用】默认（异步桥）下 addon 的唯一加载点是 ./python-worker.cjs。
 * 主线程这里**主动拒绝**：一个误调用就会把 Python 拽回主线程执行，正是内测日志里
 * 33s / 522s / 800s 那几处 LOOP-GAP 的成因。
 */
function getPyBridge() {
  if (pyBridge) {
    return pyBridge;
  }
  if (!pyBridgeInlineEnabled()) {
    if (!pyBridgeMainThreadRefuseLogged) {
      pyBridgeMainThreadRefuseLogged = true;
      diag('python 桥：主线程拒绝加载 addon（执行线程=worker；只有 DSHM_PY_INLINE=1 才允许内联）');
    }
    return null;
  }
  if (pyBridgeLoadTried) {
    return null;
  }
  pyBridgeLoadTried = true;
  const artifacts = pyBridgeArtifacts();
  if (artifacts === null) {
    return null;
  }
  const libPy = artifacts.libPy;
  const addon = artifacts.addon;
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

/**
 * 自检入口（两个挂载点都调它）。
 *
 * 【为什么是同步函数 + 内部派发】两个挂载点都是「try 里直接调 `ensurePythonBridge()`、紧跟
 * catch」的同步形态（boot 顶层块 + 解包收尾），改成 async 会引入"没人 await 的 Promise"，而
 * Node 24 对未处理的 rejection 默认是**致命**的。所以：同步做前置判据，真正执行自检的部分在
 * 异步桥内部（失败自己在里面落 diag / probe，绝不外抛）。
 */
function ensurePythonBridge() {
  if (pyBridgeSelftestDone) {
    return;
  }
  if (!pyBridgeSelftestPreconditions()) {
    return;
  }
  pyBridgeSelftestDone = true;
  if (!pyBridgeInlineEnabled()) {
    // 【默认】worker 线程执行自检；同步返回，结果异步落 diag / runtime probe
    pyBridgeSelftestActive = true;
    return pyBridgeSelftestAsync().finally(() => { pyBridgeSelftestActive = false; });
  }
  ensurePythonBridgeInline();
}

/**
 * 自检的**共享前置判据**（两种执行线程共用）。返回 false = 本轮不做，且**不标 done**
 * （stdlib 未解包就位时要让第二个挂载点补跑）。
 *
 * 判据顺序与原文一致：先 libs 缺件（硬错误，标 done），再 stdlib 未解包（软等待，不标 done）。
 * 顺序不能反：`Py_Initialize` 在 stdlib 半成品上会直接 fatal 整个进程（CPython 行为）。
 */
function pyBridgeSelftestPreconditions() {
  if (pyBridgeArtifacts() === null) {
    // 加载失败细节 pyBridgeArtifacts 已 diag；标 done 不再重试
    pyBridgeSelftestDone = true;
    // 【机器可读读数】直接回答端侧自检报告里"python3 到底能不能跑"（docs/106 §2）：
    // 本档 Python 不是靠 execve（手机 / 平板档的 execve 被系统拒绝），而是靠进程内桥。
    recordRuntimeProbe(`python`, {
      bridge: false,
      stdlib: false,
      selftest: `unavailable`,
      note: `addon 未加载（el1 libs 缺件或被 dlopen 策略拒绝）⇒ 本档 python3 命令不可用`,
      measuredAt: new Date().toISOString(),
    });
    return false;
  }
  if (!pythonReady()) {
    // 不标 done：首次解包收尾后由第二个挂载点补跑
    diag('python 桥：stdlib 尚未解包就位，本轮跳过（解包收尾后自检）');
    recordRuntimeProbe(`python`, {
      bridge: true,
      stdlib: false,
      selftest: `pending`,
      note: `桥已加载但 stdlib 未解包 ⇒ 本次启动暂不可执行（解包收尾后会补跑自检）`,
      measuredAt: new Date().toISOString(),
    });
    return false;
  }
  return true;
}

/**
 * 降级分支（`DSHM_PY_INLINE=1`）：旧的**同步**自检 —— 主线程 dlopen + `captureRun`。
 * 这一段与搬出主线程之前的实现逐字一致，保留它是为了"一条 env 回退到已验证行为"。
 * 门禁 `tools/check-python-async-worker.mjs` 的 C 段就按这个形状断言：主线程的
 * `bridge.captureRun(` 必须落在这个函数与 `pyBridgeRun` 的 inline 分支里（都被 DSHM_PY_INLINE 判定包住）。
 */
function ensurePythonBridgeInline() {
  /*
   * 【二次判定（护栏）】本函数只允许在降级分支里被调用；这里再判一次是**给未来的人**的护栏 ——
   * 万一有人把它接到默认路径上（比如为了"多复跑一次自检"），Python 就又回到主线程执行，
   * 而这正是内测日志里 800711ms / 522814ms / 33277ms 那几处 LOOP-GAP 的成因。
   * 门禁 `tools/check-python-async-worker.mjs` 的 B2 就按"函数体里必须有这个判定"断言。
   */
  if (!pyBridgeInlineEnabled()) {
    return;
  }
  const bridge = getPyBridge();
  if (bridge === null) {
    // 加载失败细节 getPyBridge 已 diag（这里只剩"降级分支里 dlopen 真的失败"这一种可能）
    pyBridgeSelftestDone = true;
    // 【机器可读读数】直接回答端侧自检报告里"python3 到底能不能跑"（docs/106 §2）：
    // 本档 Python 不是靠 execve（手机 / 平板档的 execve 被系统拒绝），而是靠进程内桥。
    recordRuntimeProbe(`python`, {
      bridge: false,
      stdlib: false,
      selftest: `unavailable`,
      note: `addon 未加载（el1 libs 缺件或被 dlopen 策略拒绝）⇒ 本档 python3 命令不可用`,
      measuredAt: new Date().toISOString(),
    });
    return;
  }
  try {
    const ready = bridge.isReady();
    diag(`python 桥：addon 已加载 ready=${ready.ready} initialized=${ready.initialized}`);
    const t0 = Date.now();
    const r = bridge.captureRun('print(1+1)');
    const out = String(r.stdout || '').trim();
    const selftestOk = r.ok === true && out === '2';
    if (selftestOk) {
      log(`python 桥自检通过：print(1+1)=2（${Date.now() - t0}ms），内嵌 CPython 可用`);
    } else {
      diag(`python 桥自检失败：ok=${r.ok} stdout=${JSON.stringify(out)} rc=${r.rc}`
        + ` error=${r.error || ''} stderr=${String(r.errStderr || '').slice(0, 200).replace(/\s+/g, ' ')}`);
    }
    recordRuntimeProbe(`python`, {
      bridge: true,
      stdlib: true,
      ready: ready.ready === true,
      initialized: ready.initialized === true,
      selftest: selftestOk ? `ok` : `fail`,
      stdout: out,
      rc: r.rc === undefined || r.rc === null ? null : String(r.rc),
      elapsedMs: Date.now() - t0,
      note: selftestOk
        ? `内嵌 CPython 在宿主进程内可用（不 execve）⇒ 手机 / 平板档同样能跑 python3`
        : `桥已加载但自检未通过，细节见 dshm-host.log 的"python 桥自检失败"行`,
      measuredAt: new Date().toISOString(),
    });
  } catch (e) {
    diag(`python 桥自检异常（调用失败）：${String(e).slice(0, 200).replace(/\s+/g, ' ')}`);
    recordRuntimeProbe(`python`, {
      bridge: true,
      stdlib: true,
      selftest: `error`,
      error: String(e).slice(0, 140),
      note: `桥自检抛出异常（宿主进程内调用失败）`,
      measuredAt: new Date().toISOString(),
    });
  }
}

/**
 * 【默认】worker 线程里的自检。
 *
 * 与降级分支同一套判据、同一套 probe 字段与日志文案（`python 桥自检通过` /
 * `python 桥自检失败`）—— 端侧验收脚本与文档都按这两行 grep，换执行线程不该换文案。
 * 唯一差别：`print(1+1)` 不带 prelude（自检不需要 SIGALRM 超时），且真正执行发生在
 * worker 线程（主线程只 await 结果）。
 */
async function pyBridgeSelftestAsync() {
  const t0 = Date.now();
  try {
    const bridge = getPyWorkerBridge();
    const ready = await bridge.status();
    if (startupWork.stopped || !pyBridgeSelftestActive) return;
    diag(`python 桥：worker 已加载 bridge=${ready.bridge === true} ready=${ready.ready} initialized=${ready.initialized}`
      + (ready.error ? ` error=${String(ready.error).slice(0, 200)}` : ''));
    const r = await bridge.run({ code: 'print(1+1)', timeoutMs: 60000, label: 'selftest' });
    if (startupWork.stopped || !pyBridgeSelftestActive || r.cancelled) return;
    const out = String(r.stdout || '').trim();
    const selftestOk = r.ok === true && out === '2';
    if (selftestOk) {
      log(`python 桥自检通过：print(1+1)=2（${Date.now() - t0}ms），内嵌 CPython 可用（执行线程=worker）`);
    } else {
      diag(`python 桥自检失败：ok=${r.ok} stdout=${JSON.stringify(out)} rc=${r.rc}`
        + ` error=${r.error || ''} stderr=${String(r.errStderr || '').slice(0, 200).replace(/\s+/g, ' ')}`);
    }
    recordRuntimeProbe(`python`, {
      bridge: true,
      stdlib: true,
      ready: ready.ready === true,
      initialized: ready.initialized === true,
      selftest: selftestOk ? `ok` : `fail`,
      stdout: out,
      rc: r.rc === undefined || r.rc === null ? null : String(r.rc),
      elapsedMs: Date.now() - t0,
      note: selftestOk
        ? `内嵌 CPython 在宿主进程内可用（不 execve，执行线程=worker）⇒ 手机 / 平板档同样能跑 python3`
        : `桥已加载但自检未通过，细节见 dshm-host.log 的"python 桥自检失败"行`,
      measuredAt: new Date().toISOString(),
    });
  } catch (e) {
    if (startupWork.stopped || !pyBridgeSelftestActive) return;
    diag(`python 桥自检异常（调用失败）：${String(e).slice(0, 200).replace(/\s+/g, ' ')}`);
    recordRuntimeProbe(`python`, {
      bridge: true,
      stdlib: true,
      selftest: `error`,
      error: String(e).slice(0, 140),
      note: `桥自检抛出异常（worker 线程调用失败）`,
      measuredAt: new Date().toISOString(),
    });
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

/** /proc/self/status 里的 VmHWM（峰值 RSS，kB）；读不到返回 -1（不抛）。 */
function processVmHwmKb() {
  try {
    const text = fs.readFileSync('/proc/self/status', 'utf8');
    const match = /VmHWM:\s+(\d+)\s+kB/.exec(text);
    return match ? Number(match[1]) : -1;
  } catch (e) {
    return -1;
  }
}

/**
 * 请求的**执行体**：执行守卫 + 结构化错误（任何失败都不许抛到 HTTP 层之外）。
 *
 * 【执行线程】默认走 `./python-bridge-async.cjs`（Python 跑在 worker 线程里，主线程只 await）；
 * `DSHM_PY_INLINE=1` 时退回旧的**同步** `bridge.captureRun(...)`（会挡事件循环，仅排障用）。
 * 两条路的返回体字段与 rc/超时口径**逐字一致**（`ok` / `stdout` / `errStderr` / `rc` / `error`）。
 *
 * 【为什么是 async 函数】端点 handler 本来就是 async；把 await 放在这里，主线程在 Python
 * 跑 pip 的几分钟里照常处理 Web 请求、心跳、会话 —— 那正是内测日志里 800711ms LOOP-GAP 的修法。
 */
async function pyBridgeRun(code, timeoutSec) {
  startupWork.discard('python');
  if (pyBridgeSelftestActive) {
    pyBridgeSelftestActive = false;
    if (pyWorkerBridge !== null) pyWorkerBridge.cancel('user-python-priority');
  }
  if (!pythonReady()) {
    return { ok: false, error: 'stdlib not ready (extraction in progress?)', stdlibReady: false };
  }
  const inlineMode = pyBridgeInlineEnabled();
  let bridge = null;
  if (inlineMode) {
    /* 【降级分支 DSHM_PY_INLINE=1】旧行为：主线程 dlopen + 同步 captureRun（整段在 inline 判定内） */
    bridge = getPyBridge();
    if (bridge === null) {
      return { ok: false, error: 'python bridge addon unavailable' };
    }
  } else if (pyBridgeArtifacts() === null) {
    // 默认通道：只探测 libs 是否齐备（**不在主线程 dlopen**），真正加载发生在 worker 里
    return { ok: false, error: 'python bridge addon unavailable' };
  }
  /*
   * 【2026-10-18 内测闪退报告的诊断落点】python 工具与 Host 同进程：一段用户级
   * ctypes 代码（例如手写 libzstd 流式解压）在 native 层出事后会把整个进程带走，
   * 而崩溃前「到底执行了什么」此前一个字都没留下。这里补三样**只记不改**的读数：
   *   ① 本次 code 长度、耗时、返回体大小、峰值 RSS（VmHWM）——事后能对上内存假设；
   *   ② code 是否出现 `ctypes`（只记布尔，不落源码）；
   *   ③ Python 侧 audit hook：首次出现 `ctypes.dlopen/dlsym` 时打印到 stdout
   *      （node-output.log 现在会跨启动轮转保留，见 dshhost.cc 的 RotateNodeOutput）。
   * 全部失败都静默——诊断绝不能影响执行通道本身。
   */
  const runT0 = Date.now();
  const codeLen = code.length;
  const ctypesHint = /ctypes/.test(code);
  const prelude = pyBridgePrelude(timeoutSec);
  let r;
  if (inlineMode) {
    // 【降级分支】同步执行：Linux/PC 上排障用，端侧长任务会挡事件循环（已知代价）
    try {
      r = bridge.captureRun(prelude + code);
    } catch (e) {
      r = { ok: false, error: String(e && e.message ? e.message : e) };
    }
  } else {
    /*
     * 【默认】交给 worker：主线程在这里 await，事件循环继续转。
     * prelude（SIGALRM 超时 + ctypes audit）随 code 一起进去 —— 它必须在**执行的那个
     * 解释器线程**里生效，而不是在主线程拼字符串时。
     * timeoutMs 与 query 的 timeout（秒）同值：Python 侧 alarm 先到，主线程看门狗再多等
     * 一个余量（见 python-bridge-async.cjs 的 WATCHDOG_MARGIN_MS 注释）。
     */
    try {
      r = await getPyWorkerBridge().run({ code: prelude + code, timeoutMs: timeoutSec * 1000, label: 'run' });
    } catch (e) {
      r = { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }
  try {
    const outBytes = JSON.stringify(r).length;
    /* `thread=` 是给真机验收看的：确认这一跑到底在 worker 还是被降级回主线程 */
    diag(`PY-RUN ok=${r && r.ok === true ? 'true' : 'false'} codeLen=${codeLen}`
      + ` ms=${Date.now() - runT0} outBytes=${outBytes} VmHWMkB=${processVmHwmKb()}`
      + ` ctypes=${ctypesHint ? 'yes' : 'no'} thread=${inlineMode ? 'main' : 'worker'}`
      + (r && r.timedOut === true ? ' timedOut=yes' : ''));
  } catch (e3) {
    // 诊断失败不影响返回
  }
  /*
   * 统一清 itimer：正常路径代码尾部不拼取消（异常路径跑不到），改由这里
   * 幂等清零。不清的后果是真机实测过的坑——pending alarm 会在下一个请求
   * 的字节码检查点立即引爆 SystemExit(124)，误杀无辜请求。
   * 同 prelude 防御式：signal 不可用时静默跳过（上一请求已自带降级语义）。
   *
   * 【2026-10-19 迁移】默认通道里这段**不再需要**：itimer 与它守护的执行在同一个
   * worker 线程里，清理由 python-worker.cjs 的 epilogue 做；而"取消"也不再是
   * 跑一段 Python（清定时器停不掉正在跑的任务），改成 `worker.terminate()` + 重建
   * （见 python-bridge-async.cjs 的 cancel() / 超时分支）。降级分支仍走这段旧逻辑。
   */
  if (inlineMode) {
    try {
      bridge.runString('try:\n    import signal\n    signal.setitimer(signal.ITIMER_REAL, 0)\nexcept BaseException:\n    pass');
    } catch (e2) {
      // 忽略：清理失败不影响本次结果（下个请求 prelude 会重置 timer）
    }
  }
  return r;
}

/**
 * 拼 Python 侧的 prelude：SIGALRM 超时注入 + ctypes audit 钩子。
 *
 * SIGALRM：超时 handler 抛 `SystemExit(124)`，`captureRun` 的 `except SystemExit`
 * 分支捕获后以 `rc="124"` 返回（不逃逸成进程退出）。
 * 【防御式 try + 全限定（2026-09-23 真机教训）】`import signal as _dshm_sig`
 * 在真机嵌入 CPython（dlopen libpython3.12 + exec 注入）里 NameError——
 * as 绑定不落 globals，后续引用即炸；import 失败时降级为无超时（桥仍可用，
 * 长任务靠调用方 timeout query 自律 + worker 看门狗兜底），绝不让 prelude 挡死执行通道。
 * 【在 worker 线程里】`signal.signal` 可能报 "signal only works in main thread of the
 * main interpreter"（取决于 CPython 如何认定主线程）—— 那条路正是上面这个 except 分支
 * 兜住的：退化为无 Python 侧超时，超时由主线程看门狗 terminate 收口（rc 仍是 "124"）。
 */
function pyBridgePrelude(timeoutSec) {
  const prelude = 'try:\n'
    + '    import signal\n'
    + '    def _dshm_alarm(*_a):\n'
    + '        raise SystemExit(124)\n'
    + '    signal.signal(signal.SIGALRM, _dshm_alarm)\n'
    + `    signal.setitimer(signal.ITIMER_REAL, ${timeoutSec})\n`
    + 'except BaseException as _e:\n'
    + '    print("[dshm] prelude: signal timeout unavailable:", _e)\n'
    // ctypes audit 钩子：只观察 dlopen/dlsym（不挂 call_function，避免逐调用刷屏），
    // 每次进程最多打 20 行；失败静默。
    + 'try:\n'
    + '    import sys, builtins\n'
    + '    if not getattr(builtins, "_dshm_ctypes_audit", False):\n'
    + '        _dshm_seen = [0]\n'
    + '        def _dshm_audit(_ev, _args):\n'
    + '            try:\n'
    + '                if _ev in ("ctypes.dlopen", "ctypes.dlsym") and _dshm_seen[0] < 20:\n'
    + '                    _dshm_seen[0] += 1\n'
    + '                    print("[dshm] ctypes", _ev, _args)\n'
    + '            except BaseException:\n'
    + '                pass\n'
    + '        sys.addaudithook(_dshm_audit)\n'
    + '        builtins._dshm_ctypes_audit = True\n'
    + 'except BaseException as _e:\n'
    + '    print("[dshm] ctypes audit unavailable:", _e)\n';
  return prelude;
}

function pyBridgeAllowedRoots() {
  /*
   * 第四个根是用户的真实 HOME。只放 SANDBOX_HOME / HOME_DIR / process.cwd()
   * 时，默认工作区在 Download/<bundle> 可以跑，但用户随后切到
   * `/storage/Users/currentUser/harness` 这类工作区后，`.py` 文件会被
   * `script path outside allowed roots` 拒绝。该范围与 DSHM 文件闸门一致：
   * 应用沙箱 + 用户目录；不放宽到系统区。
   */
  const roots = [SANDBOX_HOME, HOME_DIR, process.cwd(), ORIGINAL_HOME]
    .filter((root) => typeof root === 'string' && root.length > 0)
    .map((root) => path.resolve(root));
  return [...new Set(roots)].filter((root) => root !== path.parse(root).root);
}

function pyBridgePathInsideSandbox(abs) {
  return pyBridgeAllowedRoots().some((root) => abs === root || abs.startsWith(root + path.sep));
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
      auth: 'anonymous',
      handler: async (request, response) => {
        try {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' });
            response.end();
            return;
          }
          /*
           * 【默认】worker 线程：`status()` 只探测 addon 是否可加载 / isReady（**不初始化 Python**），
           * 与旧的 `getPyBridge().isReady()` 语义对齐 —— 字段名与取值口径逐字不变
           * （bridge / ready / initialized），只是探测发生在 worker 里。
           * 【降级分支】DSHM_PY_INLINE=1 时仍走主线程那份 addon（旧行为）。
           */
          if (pyBridgeInlineEnabled()) {
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
            return;
          }
          const info = pyBridgeArtifacts() === null
            ? { bridge: false, ready: false, initialized: false }
            : await getPyWorkerBridge().status();
          pyBridgeSendJson(response, 200, {
            ok: true,
            bridge: info.bridge === true,
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
      auth: 'anonymous',
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
        pyBridgeSendJson(response, 200, await pyBridgeRun(code, pyBridgeTimeoutSec(url)));
      },
    });
    ctx.webServer.register({
      kind: 'exact',
      path: '/dshm-python/exec',
      auth: 'anonymous',
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
            pyBridgeSendJson(response, 400, {
              ok: false,
              error: 'script path outside allowed roots',
              got: abs,
              allowedRoots: pyBridgeAllowedRoots(),
            });
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
        pyBridgeSendJson(response, 200, await pyBridgeRun(setArgv + code, pyBridgeTimeoutSec(url)));
      },
    });
    stage('BOOT_62_PY_BRIDGE_HTTP', '/dshm-python/status|run-get|exec 已注册');
  } catch (e) {
    diag('python 桥端点注册异常（桥退化为不可用）：' + String(e && e.message ? e.message : e));
  }
}

/**
 * 浏览器桥（2026-10-16；docs/173 调研 + docs/174 PoC 的正式化落地）。
 *
 * 【是什么】把设备本机浏览器里的「DSHM Browser Bridge」扩展接进宿主进程：扩展主动连本进程的
 * WebSocket（`ws://127.0.0.1:<port>/browser-bridge?token=<固定>`），宿主把 Agent 侧
 * `browser_*` 工具调用转发过去；浏览器自动化的一切（CDP 导航 / 脚本注入 / 点击 / 读树）
 * 由扩展侧完成（PoC 实测：`chrome.debugger` + `chrome.scripting`；海泰两条硬限制——禁建/控
 * 标签页、debugger 独占——见 docs/174 §3）。
 *
 * 【为什么手写最小 WS 服务端】宿主入口在核心树之外、jitless 环境，只处理一种帧（掩码文本帧）；
 * 手写握手 + 帧编解码零依赖、行为可读（与 tar-gz.cjs 的"纯 JS 替代 spawn"同一取舍）。
 *
 * 【鉴权】WS 侧：固定 token（beta 口径，扩展与宿主同值，可经 env 覆盖）；
 *        HTTP 侧：与 /dshm-python/* 同一份 host token（插件从 host-ready.json 现读）。
 * 【保活】15s JSON ping：MV3 service worker 靠消息续命（docs/174 §4.1 实测）。
 * 【分档】全档生效；无扩展连接时工具如实报「未连接」。
 */
function browserAutomationEnabled(env = process.env) {
  const mode = String(env.DSHM_BROWSER_TOOLS || '').trim().toLowerCase();
  if (mode === 'off') return false;
  if (mode === 'force') return true;
  return String(env.DSHM_DEVICE_FORM || '').trim().toLowerCase() === 'desktop';
}

function registerBrowserBridge(ctx) {
  try {
    if (!browserAutomationEnabled()) {
      stage('BOOT_62B_BROWSER_BRIDGE_SKIP', `deviceForm=${String(process.env.DSHM_DEVICE_FORM || 'unknown')}（仅 PC / 2in1）`);
      return null;
    }
    const BRIDGE_PORT = Number(process.env.DSHM_BROWSER_PORT || 19390);
    const BRIDGE_TOKEN = String(process.env.DSHM_BROWSER_TOKEN || 'dshm-browser-beta');
    const clients = new Map();
    const pending = new Map();
    let nextRpcId = 1;
    let connSeq = 0;
    const logB = (m) => diag('browser-bridge: ' + m);

    // ── 最小 WebSocket 帧编解码（服务端；客户端→服务端必带掩码）──
    const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    function wsEncode(opcode, payload) {
      const len = payload.length;
      let header;
      if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = len;
      } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }
      header[0] = 0x80 | opcode;
      return Buffer.concat([header, payload]);
    }
    const wsText = (s) => wsEncode(0x1, Buffer.from(String(s), 'utf8'));
    const wsClose = () => wsEncode(0x8, Buffer.alloc(0));

    const server = require('node:http').createServer((req, res) => {
      res.writeHead(404);
      res.end();
    });
    server.on('upgrade', (req, socket) => {
      try {
        const u = new URL(req.url, 'http://localhost');
        if (u.pathname !== '/browser-bridge' || u.searchParams.get('token') !== BRIDGE_TOKEN) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        const key = String(req.headers['sec-websocket-key'] || '');
        const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\n'
          + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
          + 'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        const id = 'ws_' + (++connSeq);
        const client = { id, socket, info: null, lastSeen: Date.now(), closed: false, buf: Buffer.alloc(0) };
        clients.set(id, client);
        logB('extension connected id=' + id);
        socket.on('data', (chunk) => {
          client.buf = Buffer.concat([client.buf, chunk]);
          let off = 0;
          while (client.buf.length - off >= 2) {
            const b0 = client.buf[off];
            const b1 = client.buf[off + 1];
            const opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0;
            let len = b1 & 0x7f;
            let head = 2;
            if (len === 126) {
              if (client.buf.length - off < 4) break;
              len = client.buf.readUInt16BE(off + 2);
              head = 4;
            } else if (len === 127) {
              if (client.buf.length - off < 10) break;
              len = Number(client.buf.readBigUInt64BE(off + 2));
              head = 10;
            }
            const maskLen = masked ? 4 : 0;
            if (client.buf.length - off < head + maskLen + len) break;
            let payload = client.buf.subarray(off + head + maskLen, off + head + maskLen + len);
            if (masked) {
              const mask = client.buf.subarray(off + head, off + head + 4);
              const copy = Buffer.alloc(len);
              for (let i = 0; i < len; i += 1) copy[i] = payload[i] ^ mask[i % 4];
              payload = copy;
            }
            off += head + maskLen + len;
            client.lastSeen = Date.now();
            if (opcode === 0x8) { try { socket.end(wsClose()); } catch { /* 忽略 */ } break; }
            if (opcode === 0x9) { try { socket.write(wsEncode(0xa, payload)); } catch { /* 忽略 */ } continue; }
            if (opcode !== 0x1) continue;
            let msg = null;
            try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
            handleClientMessage(client, msg);
          }
          client.buf = client.buf.subarray(off);
        });
        const drop = (why) => {
          if (client.closed) return;
          client.closed = true;
          clients.delete(id);
          for (const [rid, p] of pending) {
            if (p.clientId === id) {
              pending.delete(rid);
              clearTimeout(p.timer);
              p.reject(new Error('extension disconnected'));
            }
          }
          logB('extension disconnected id=' + id + ' (' + why + ')');
        };
        socket.on('close', () => drop('close'));
        socket.on('error', () => drop('error'));
      } catch (e) {
        logB('upgrade 处理异常：' + String(e && e.message ? e.message : e));
        try { socket.destroy(); } catch { /* 忽略 */ }
      }
    });

    function handleClientMessage(client, msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.method === 'extensionInfo') {
        client.info = msg.params || null;
        logB('extensionInfo id=' + client.id + ' ' + JSON.stringify(client.info).slice(0, 220));
        return;
      }
      if (msg.method === 'log') {
        logB('[ext] ' + String((msg.params || {}).m || '').slice(0, 300));
        return;
      }
      if (msg.method === 'pong') return;
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error('[' + (msg.error.code || 'ERR') + '] ' + (msg.error.message || '')));
        else p.resolve(msg.result);
      }
    }

    function pickClient(clientId) {
      if (clientId) {
        const c = clients.get(clientId);
        return c && !c.closed ? c : null;
      }
      for (const c of clients.values()) if (!c.closed) return c;
      return null;
    }

    function invokeOnClient(clientId, tool, args, timeoutMs) {
      return new Promise((resolve, reject) => {
        const client = pickClient(clientId);
        if (!client) {
          reject(new Error('没有已连接的浏览器扩展（请在目标浏览器中加载并启用 DSHM Browser Bridge 扩展）'));
          return;
        }
        const id = nextRpcId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('browser tool timeout: ' + tool));
        }, timeoutMs);
        pending.set(id, { clientId: client.id, resolve, reject, timer });
        try {
          client.socket.write(wsText(JSON.stringify({ id, method: 'tools/invoke', params: { tool, arguments: args } })));
        } catch (e) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new Error('发送失败：' + String(e && e.message ? e.message : e)));
        }
      });
    }

    const keepalive = setInterval(() => {
      for (const c of clients.values()) {
        if (c.closed) continue;
        try { c.socket.write(wsText(JSON.stringify({ method: 'ping' }))); } catch { /* drop 会兜 */ }
      }
    }, 5000);
    // 【为什么 5s 而不是 15s（2026-10-17）】浏览器进程被杀后，连接可能先进入"半开"状态
    // （对端已死、本地 socket 还没收到 FIN/RST）—— 此窗口里 `/dshm-browser/status` 仍把它列为
    // 客户端，而 invoke 已经选不中它。真机实测该窗口约 10s（杀进程 → drop 出现在 00:14:08）。
    // 保活写得更勤，drop 来得更早，status 与真实可用性之间的偏差随之收窄。
    if (keepalive.unref) keepalive.unref();

    // ── 任务结束自动关闭「本次随需拉起」的浏览器（2026-10-17）─────────────────────
    //
    // 【用户口径】"主动拉起浏览器执行完任务后浏览器就一直在前台，可以在任务结束后自动关闭，
    // 包括预约的定时任务也是一样"。
    // 【什么时候武装】只在 `/dshm-open-link` **成功拉起**之后（即"这个浏览器是 DSHM 为了
    // 本次任务开的"）；用户自己已经开着的浏览器永远不会走到这一步 ⇒ 不会被关。
    // 【什么时候关】全局监听 `session/event` 的 **`turn/end`** —— 一轮任务结束（定时任务触发的
    // 回合同样会落这个事件）。只调用扩展的 `close`（只关 sessionTabId 那一个标签页；窗口里
    // 还有别的标签页时绝不整窗关闭）。
    // 【退路】两小时还没等到 turn/end（异常/长任务）就只**解除武装**，不强行关浏览器。
    // 【开关】宿主环境变量 `DSHM_BROWSER_AUTOCLOSE=off` 可整体关闭。
    const AUTOCLOSE_DEADLINE_MS = 2 * 60 * 60 * 1000;
    const autoClose = { armed: false, armedAt: 0, url: '', timer: null };
    const disarmAutoClose = (why) => {
      if (!autoClose.armed) return;
      autoClose.armed = false;
      if (autoClose.timer !== null) {
        clearTimeout(autoClose.timer);
        autoClose.timer = null;
      }
      diag('browser-autoclose: disarm (' + why + ')');
    };
    const closeLaunchedBrowser = async (reason) => {
      if (!autoClose.armed) return;
      disarmAutoClose(reason);
      const client = pickClient(null);
      if (!client) {
        diag('browser-autoclose: no client, skip');
        return;
      }
      try {
        const closed = await invokeOnClient(null, 'close', { reason }, 8000);
        diag('browser-autoclose: close result ' + JSON.stringify(closed).slice(0, 200));
      } catch (e) {
        diag('browser-autoclose: close failed ' + String(e && e.message ? e.message : e));
      }
    };
    const armAutoClose = (info) => {
      if (String(process.env.DSHM_BROWSER_AUTOCLOSE || 'on').toLowerCase() === 'off') {
        diag('browser-autoclose: disabled by env');
        return;
      }
      autoClose.armed = true;
      autoClose.armedAt = Date.now();
      autoClose.url = String((info && info.url) || '').slice(0, 200);
      if (autoClose.timer !== null) clearTimeout(autoClose.timer);
      autoClose.timer = setTimeout(() => {
        disarmAutoClose('deadline（2h 未等到 turn/end，不强行关闭）');
      }, AUTOCLOSE_DEADLINE_MS);
      if (autoClose.timer.unref) autoClose.timer.unref();
      diag('browser-autoclose: armed url=' + autoClose.url);
    };
    if (typeof ctx.on === 'function') {
      try {
        ctx.on('session/event', (session, event) => {
          if (!autoClose.armed) return;
          if (!event || event.type !== 'turn/end') return;
          const turn = event.data && event.data.turn !== undefined ? event.data.turn : '?';
          void closeLaunchedBrowser('turn-end turn=' + turn);
        }, { global: true });
        stage('BOOT_62D_BROWSER_AUTOCLOSE', 'session/event(turn/end) → 关闭随需拉起的浏览器');
      } catch (e) {
        diag('browser-autoclose: 订阅 session/event 失败：' + String(e && e.message ? e.message : e));
      }
    } else {
      diag('browser-autoclose: ctx.on 不可用，自动关闭退化为 deadline-only');
    }

    ctx.webServer.register({
      kind: 'exact',
      path: '/dshm-browser/start',
      auth: 'anonymous',
      handler: async (request, response) => {
        const html = '<!doctype html><html><head><meta charset="utf-8">'
          + '<meta name="viewport" content="width=device-width,initial-scale=1">'
          + '<title>DSHM Browser Bridge</title></head>'
          + '<body><main><h1>DSHM Browser Bridge</h1>'
          + '<p>The browser is connected. Return to DSHM and continue the task.</p>'
          + '<button id="ready">Browser ready</button>'
          + '<input id="probe" aria-label="DSHM browser probe" placeholder="DSHM browser probe">'
          + '</main></body></html>';
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(html);
      },
    });
    ctx.webServer.register({
      kind: 'exact',
      path: '/dshm-browser/status',
      auth: 'anonymous',
      handler: async (request, response) => {
        const list = [];
        for (const c of clients.values()) list.push({ id: c.id, info: c.info, lastSeen: c.lastSeen });
        pyBridgeSendJson(response, 200, { ok: true, port: BRIDGE_PORT, clients: list });
      },
    });
    ctx.webServer.register({
      kind: 'exact',
      path: '/dshm-browser/invoke',
      auth: 'anonymous',
      handler: async (request, response) => {
        try {
          const url = new URL(request.url, 'http://localhost');
          if (!pyBridgeTokenOk(url)) {
            pyBridgeSendJson(response, 401, { ok: false, error: 'token required' });
            return;
          }
          const tool = url.searchParams.get('tool') || '';
          if (tool.length === 0) {
            pyBridgeSendJson(response, 400, { ok: false, error: 'tool required' });
            return;
          }
          const clientId = url.searchParams.get('clientId') || '';
          const timeoutSecRaw = Number(url.searchParams.get('timeout') || 30);
          const timeoutSec = Number.isFinite(timeoutSecRaw) ? Math.min(120, Math.max(5, Math.trunc(timeoutSecRaw))) : 30;
          let args = {};
          const rawArgs = url.searchParams.get('args') || '';
          if (rawArgs.length > 0) {
            try { args = JSON.parse(rawArgs); } catch (e) {
              pyBridgeSendJson(response, 400, { ok: false, error: 'args 不是 JSON' });
              return;
            }
          }
          const result = await invokeOnClient(clientId, tool, args, timeoutSec * 1000);
          pyBridgeSendJson(response, 200, { ok: true, result });
        } catch (e) {
          pyBridgeSendJson(response, 200, { ok: false, error: String(e && e.message ? e.message : e) });
        }
      },
    });

    server.listen(BRIDGE_PORT, '127.0.0.1', () => {
      logB('listening ws://127.0.0.1:' + BRIDGE_PORT + '/browser-bridge');
    });
    server.on('error', (e) => logB('server error: ' + String(e && e.message ? e.message : e)));
    stage('BOOT_62B_BROWSER_BRIDGE', 'ws://127.0.0.1:' + BRIDGE_PORT + '/browser-bridge + /dshm-browser/*');
    // 给外开桥端点用：只有"本次真的拉起过浏览器"才在 turn/end 时自动关闭（理由见上面的块注释）。
    return { armAutoClose };
  } catch (e) {
    diag('browser bridge 注册异常（退化为不可用）：' + String(e && e.message ? e.message : e));
  }
  return null;
}

/**
 * 外开桥端点（/dshm-open-link）：把"打开外部链接 / 拉起浏览器"的请求交给 ArkTS 壳层。
 *
 * 【为什么必须过壳层】`openLink` 是 ArkTS 的 `UIAbilityContext` API（Host 里的 Node 进程
 * 调不到；见 `platform/src/main/ets/system/OpenLink.ets` 与登录"外开授权页"同一条路）。
 * 通道沿用项目既成的**文件队列**范式（`host-stop-request` / `host-exit-mode` / 语音桥）：
 * `$DSH_HOME/open-link/` 下 Host 写 `<id>.req`、壳层（`entry/.../system/OpenLinkBridge.ets`）
 * 轮询处理并写 `<id>.done` / `<id>.fail`。两侧同 UID、同文件系统视图。
 *
 * 【用法（插件 dshm-tool-browser 调它）】
 *   GET /dshm-open-link?token=…&url=https%3A%2F%2Fwww.baidu.com[&bundle=com.haitai.htbrowser][&timeout=8]
 *   → { ok:true, detail:"launched", id } | { ok:false, error:"…", id? }
 *
 * 【为什么要 bundle（2026-10-17 真机实测）】`openLink` 走**系统默认浏览器** —— 本机默认是
 * `com.huawei.hmos.browser`，而 DSHM 扩展装在 `com.haitai.htbrowser` ⇒ 只靠 openLink 会拉起
 * "另一个浏览器"，扩展永远不回连。故请求里带目标 bundle，壳层优先 `startAbility` 显式拉起它
 * （海泰 `EntryAbility` 声明了 `ohos.want.action.viewData` + `entity.system.browsable`），
 * 失败才回退 openLink（默认浏览器 / 系统兜底）。
 *
 * 【为什么要等回执再返回】拉起浏览器是**异步且可能失败**的（没有可用浏览器 / 壳层桥没跑）。
 * 立刻回 ok 会把失败藏到下一步（模型只看到"扩展没回连"），所以这里等到 `.done/.fail`
 * 或超时，把真实结果如实带回去。
 */
function registerOpenLinkEndpoint(ctx, onLaunched) {
  try {
    if (!browserAutomationEnabled()) {
      diag('外开桥端点：当前非 PC 形态，不注册浏览器拉起端点');
      return;
    }
    if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
      diag('外开桥端点：ctx.webServer 不可用，跳过注册');
      return;
    }
    const QUEUE_DIR_NAME = 'open-link';
    ctx.webServer.register({
      kind: 'exact',
      path: '/dshm-open-link',
      auth: 'anonymous',
      handler: async (request, response) => {
        try {
          const url = new URL(request.url, 'http://localhost');
          if (!pyBridgeTokenOk(url)) {
            pyBridgeSendJson(response, 401, { ok: false, error: 'token required' });
            return;
          }
          const target = String(url.searchParams.get('url') || '').trim();
          if (!/^https?:\/\//i.test(target)) {
            pyBridgeSendJson(response, 400, { ok: false, error: 'url 必须是 http(s) 绝对地址' });
            return;
          }
          // 目标浏览器 bundle（可选）：壳层优先用它做显式 startAbility（见函数头注的实测理由），
          // 只做形态校验（点分标识符），不判断存在性 —— 不存在时壳层会回退 openLink。
          const bundle = String(url.searchParams.get('bundle') || '').trim();
          if (bundle.length > 0 && !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(bundle)) {
            pyBridgeSendJson(response, 400, { ok: false, error: 'bundle 形态不合法' });
            return;
          }
          const timeoutSecRaw = Number(url.searchParams.get('timeout') || 8);
          const timeoutMs = Number.isFinite(timeoutSecRaw)
            ? Math.min(20000, Math.max(1000, Math.trunc(timeoutSecRaw * 1000)))
            : 8000;
          const id = `ol-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
          const dir = path.join(HOME_DIR, QUEUE_DIR_NAME);
          fs.mkdirSync(dir, { recursive: true });
          const reqPath = path.join(dir, `${id}.req`);
          const tmpPath = path.join(dir, `${id}.wreq`);
          fs.writeFileSync(tmpPath, JSON.stringify({
            url: target,
            ...bundle.length > 0 ? { bundle } : {},
            requestedAt: Date.now(),
          }), 'utf8');
          fs.renameSync(tmpPath, reqPath);   // 原子落位：壳层只会看到完整的 .req
          const deadline = Date.now() + timeoutMs;
          let result = null;
          while (Date.now() < deadline) {
            const donePath = path.join(dir, `${id}.done`);
            const failPath = path.join(dir, `${id}.fail`);
            if (fs.existsSync(donePath)) {
              result = { ok: true, detail: 'launched' };
              break;
            }
            if (fs.existsSync(failPath)) {
              let why = 'openLink 未被系统受理';
              try {
                const parsed = JSON.parse(fs.readFileSync(failPath, 'utf8'));
                if (parsed && typeof parsed.error === 'string' && parsed.error.length > 0) why = parsed.error;
              } catch { /* 读不到就用手头的默认文案 */ }
              result = { ok: false, error: why };
              break;
            }
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
          for (const suffix of ['.req', '.done', '.fail', '.wreq']) {
            try {
              fs.unlinkSync(path.join(dir, `${id}${suffix}`));
            } catch { /* 不存在即已清理 */ }
          }
          if (result === null) {
            pyBridgeSendJson(response, 200, {
              ok: false,
              id,
              error: `壳层在 ${timeoutMs} ms 内没有回执（外开桥未运行？见 files/open-link-bridge-heartbeat）`,
            });
            return;
          }
          // 成功拉起 ⇒ 武装"任务结束自动关闭"（只对这次拉起生效；用户自己的浏览器不经过这里）。
          if (result.ok === true && typeof onLaunched === 'function') {
            try {
              onLaunched({ url: target, id });
            } catch (e) {
              diag('open-link: onLaunched 回调失败：' + String(e && e.message ? e.message : e));
            }
          }
          pyBridgeSendJson(response, 200, { ...result, id });
        } catch (e) {
          pyBridgeSendJson(response, 200, { ok: false, error: String(e && e.message ? e.message : e) });
        }
      },
    });
    stage('BOOT_62C_OPEN_LINK', '/dshm-open-link 已注册（文件队列 → OpenLinkBridge）');
  } catch (e) {
    diag('外开桥端点注册异常（退化为不可用）：' + String(e && e.message ? e.message : e));
  }
}

/**
 * 桌面服务卡片的状态聚合（2026-10-17，docs/178）。
 *
 * 【卡住的地方与产物】Form Kit 的卡片进程（FormExtensionAbility）与主应用共享 bundle 沙箱，
 * 但**没有**从宿主 Node 进程拿数据的通道 ⇒ 沿用文件落点：本函数把
 *   ① 当前会话进度（session/event 的 turn/start · step/start|end · turn/end + session/title）；
 *   ② 模型账户余额（ctx.deepseekAccount.getBalance —— 有就显示）；
 *   ③ token 用量（assistant/message 的 usage，按 今天/近5h/近7d/近30d 聚合；
 *      **余额取不到时**卡片改显示这组数字）。
 * 原子写到 `$DSH_HOME/card-state.json`；FormExtensionAbility 出首帧时读它，
 * 主应用 `CardStateWatcher` 轮询它并 `formProvider.updateForm` 推给已添加的卡片。
 *
 * 【用量账本】`$DSH_HOME/card-usage.jsonl` 逐条追加 `{t,in,out}`（最多 2 万条 / 35 天）；
 * 首次没有账本时**异步回填**现有会话日志里的 assistant/message usage（只回填一次，
 * 这样"今天/近7天/近30天"从第一天起就是全的，而不是从装上卡片那一刻起算）。
 *
 * 【余额 client 身份】账户平台的 `getBalance(client)` 要 `{version, locale, timezoneOffsetSeconds}`；
 * 版本取 `DSHM_APP_VERSION`（缺省 1.1.6），时区在本机按东八区取正偏移。
 */
function registerCardState(ctx) {
  try {
    const stateFile = path.join(HOME_DIR, 'card-state.json');
    const usageFile = path.join(HOME_DIR, 'card-usage.jsonl');
    const MAX_RECORDS = 20000;
    const DAY_MS = 24 * 60 * 60 * 1000;
    let records = [];
    const titles = new class extends Map {
      set(key, value) {
        this.delete(key);
        super.set(key, value);
        if (this.size > 1024) this.delete(this.keys().next().value);
        return this;
      }
    }();
    let current = { sessionId: '', title: '', state: 'idle', turn: 0, step: 0 };
    let balance = { available: false, display: '' };
    let writeTimer = null;
    let lastBalanceAt = 0;

    /**
     * 取会话标题：优先用本次进程收到过的 `session/title` 事件；没有就**回看会话内存日志**
     * （`session.log`）里最后一条 session/title —— 老会话的标题是在上一次进程里生成的，
     * 新启动的宿主不会重放那个事件，只看实时事件会得到空标题（真机实测：卡片只显示"执行中"）。
     */
    const titleOf = (session, sid) => {
      if (sid && titles.has(sid)) return titles.get(sid);
      try {
        const log = session && Array.isArray(session.log) ? session.log : [];
        for (let i = log.length - 1; i >= 0; i -= 1) {
          const e = log[i];
          if (e && e.type === 'session/title' && e.data && typeof e.data.title === 'string' && e.data.title.length > 0) {
            if (sid) titles.set(sid, e.data.title);
            return e.data.title;
          }
        }
      } catch { /* 读不到就留空 */ }
      return '';
    };

    const usageSummary = () => {
      const now = Date.now();
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const windows = {
        today: todayStart.getTime(),
        last5h: now - 5 * 60 * 60 * 1000,
        last7d: now - 7 * DAY_MS,
        last30d: now - 30 * DAY_MS,
      };
      const out = { today: 0, last5h: 0, last7d: 0, last30d: 0 };
      for (const r of records) {
        const n = (r.in || 0) + (r.out || 0);
        if (r.t >= windows.today) out.today += n;
        if (r.t >= windows.last5h) out.last5h += n;
        if (r.t >= windows.last7d) out.last7d += n;
        if (r.t >= windows.last30d) out.last30d += n;
      }
      return out;
    };

    const writeState = () => {
      writeTimer = null;
      try {
        const payload = { updatedAt: Date.now(), session: current, balance, usage: usageSummary() };
        const tmp = stateFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
        fs.renameSync(tmp, stateFile);
      } catch (e) {
        diag('card-state: 写状态失败：' + String(e && e.message ? e.message : e));
      }
    };
    const scheduleWrite = () => {
      if (writeTimer !== null) return;
      writeTimer = setTimeout(writeState, 500);
      if (writeTimer.unref) writeTimer.unref();
    };

    const refreshBalance = async (why) => {
      const now = Date.now();
      if (now - lastBalanceAt < 60000) return;
      lastBalanceAt = now;
      try {
        const account = ctx.deepseekAccount;
        if (!account || typeof account.getBalance !== 'function') throw new Error('deepseekAccount 服务不可用');
        const client = {
          version: String(process.env.DSHM_APP_VERSION || '1.1.6'),
          locale: 'zh-CN',
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        };
        const result = await account.getBalance(client);
        if (result && result.status === 'ready' && Array.isArray(result.value) && result.value.length > 0) {
          const parts = result.value.map((w) => {
            const value = Number(w.balance);
            const shown = Number.isFinite(value) ? value.toFixed(2) : String(w.balance);
            return (w.currency === 'CNY' ? '¥' : '$') + shown;
          });
          balance = { available: true, display: parts.join(' / ') };
        } else {
          balance = { available: false, display: '' };
        }
      } catch (e) {
        balance = { available: false, display: '' };
        diag('card-state: 余额查询失败（卡片改显示 token 用量）：' + String(e && e.message ? e.message : e));
      }
      scheduleWrite();
      diag('card-state: 余额刷新（' + why + '）' + (balance.available ? balance.display : '不可用'));
    };

    let usageReadable = true;
    let usageAppends = 0;
    let usageLastCompactAt = Date.now();
    const compactUsage = () => {
      if (!usageReadable || !fs.existsSync(usageFile)) return;
      try {
        const cutoff = Date.now() - 35 * DAY_MS;
        const kept = records.filter((r) => r && typeof r.t === 'number' && r.t >= cutoff
          && Number.isFinite(r.in) && Number.isFinite(r.out)).slice(-MAX_RECORDS);
        fs.writeFileSync(usageFile + '.tmp', kept.map((r) => JSON.stringify(r)).join('\n')
          + (kept.length ? '\n' : ''), 'utf8');
        fs.renameSync(usageFile + '.tmp', usageFile);
        records = kept;
        usageAppends = 0;
        usageLastCompactAt = Date.now();
      } catch (e) {
        diag('card-state: usage compaction failed: ' + String(e && e.message ? e.message : e));
      }
    };

    // 历史用量账本
    try {
      if (fs.existsSync(usageFile)) {
        const cutoff = Date.now() - 35 * DAY_MS;
        const fd = fs.openSync(usageFile, 'r');
        try {
          let position = fs.fstatSync(fd).size;
          const chunk = Buffer.alloc(65536);
          let parts = [];
          let lineBytes = 0;
          const acceptLine = () => {
            if (lineBytes > 0 && lineBytes <= 65536) {
              try {
                const r = JSON.parse(Buffer.concat(parts.reverse()).toString('utf8'));
                if (r && typeof r.t === 'number' && r.t >= cutoff
                  && Number.isFinite(r.in) && Number.isFinite(r.out)) {
                  records.push({ t: r.t, in: r.in, out: r.out });
                }
              } catch {}
            }
            parts = [];
            lineBytes = 0;
          };
          while (position > 0 && records.length < MAX_RECORDS) {
            const length = Math.min(chunk.length, position);
            position -= length;
            let read = 0;
            while (read < length) {
              const n = fs.readSync(fd, chunk, read, length - read, position + read);
              if (n === 0) throw new Error('usage ledger short read');
              read += n;
            }
            let end = length;
            for (let i = length - 1; i >= -1; i -= 1) {
              if (i !== -1 && chunk[i] !== 10) continue;
              const segment = chunk.subarray(i + 1, end);
              lineBytes += segment.length;
              if (lineBytes <= 65536) parts.push(Buffer.from(segment));
              else {
                parts = [];
                if (usageReadable) diag('card-state: usage ledger read incomplete: line exceeds 65536 bytes; compaction disabled');
                usageReadable = false;
              }
              if (i >= 0) acceptLine();
              end = i;
              if (records.length >= MAX_RECORDS) break;
            }
          }
          if (position === 0 && records.length < MAX_RECORDS) acceptLine();
          records.reverse();
        } finally {
          fs.closeSync(fd);
        }
        compactUsage();
      }
    } catch (e) {
      usageReadable = false;
      diag('card-state: 读用量历史失败：' + String(e && e.message ? e.message : e));
    }

    /**
     * 首次（没有账本）异步回填现有会话日志：结构扫描 zstd 帧 → 逐帧解压 → 抽
     * assistant/message 的 usage。只回填一次；失败只记日志（卡片随后从新事件累计）。
     */
    const backfillUsage = () => {
      if (fs.existsSync(usageFile)) return;
      try {
        const root = path.join(HOME_DIR, 'sessions');
        if (!fs.existsSync(root)) return;
        const zstdDecompressSync = require('node:zlib').zstdDecompressSync;
        const ZSTD_MAGIC = 0xfd2fb528;
        const scanFrames = (buffer) => {
          const frames = [];
          let offset = 0;
          while (offset < buffer.length) {
            const start = offset;
            if (buffer.length - offset < 4) break;
            if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
            offset += 4;
            if (offset === buffer.length) break;
            const descriptor = buffer.readUInt8(offset);
            offset += 1;
            if ((descriptor & 24) !== 0) break;
            const contentSizeFlag = descriptor >>> 6;
            const singleSegment = (descriptor & 32) !== 0;
            const checksum = (descriptor & 4) !== 0;
            const dictionaryFlag = descriptor & 3;
            const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
            const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
            offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
            for (;;) {
              if (buffer.length - offset < 3) return frames;
              const blockHeader = buffer.readUIntLE(offset, 3);
              offset += 3;
              const lastBlock = (blockHeader & 1) !== 0;
              const blockType = (blockHeader >>> 1) & 3;
              const blockSize = blockHeader >>> 3;
              if (blockType === 3) return frames;
              const payloadBytes = blockType === 1 ? 1 : blockSize;
              if (buffer.length - offset < payloadBytes) return frames;
              offset += payloadBytes;
              if (lastBlock) break;
            }
            if (checksum) {
              if (buffer.length - offset < 4) return frames;
              offset += 4;
            }
            frames.push({ start, end: offset });
          }
          return frames;
        };
        const cutoff = Date.now() - 35 * DAY_MS;
        const files = [];
        const walk = (dir) => {
          for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, ent.name);
            if (ent.isDirectory()) walk(p);
            else if (ent.name === 'session.v4.jsonl.zstd') {
              try {
                if (fs.statSync(p).mtimeMs >= cutoff) files.push(p);
              } catch { /* 忽略 */ }
            }
          }
        };
        walk(root);
        const seen = new Set();
        const found = [];
        for (const file of files) {
          try {
            const raw = fs.readFileSync(file);
            const sid = path.basename(path.dirname(file));
            for (const frame of scanFrames(raw)) {
              let text = '';
              try {
                text = zstdDecompressSync(raw.subarray(frame.start, frame.end)).toString('utf8');
              } catch { continue; }
              for (const line of text.split('\n')) {
                if (!line.includes('"assistant/message"') && !line.includes('"session/title"')) continue;
                let ev = null;
                try { ev = JSON.parse(line); } catch { continue; }
                if (ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string') titles.set(sid, ev.data.title);
                if (ev.type !== 'assistant/message' || !ev.data || !ev.data.usage) continue;
                const t = typeof ev.time === 'number' ? ev.time : 0;
                if (t < cutoff) continue;
                const key = sid + ':' + ev.data.turn + ':' + ev.data.step;
                if (seen.has(key)) continue;
                seen.add(key);
                const inT = Number(ev.data.usage.inputTokens) || 0;
                const outT = Number(ev.data.usage.outputTokens) || 0;
                if (inT + outT > 0) found.push({ t, in: inT, out: outT });
              }
            }
          } catch { /* 单文件失败不影响回填 */ }
        }
        found.sort((a, b) => a.t - b.t);
        records = found.slice(-MAX_RECORDS);
        fs.writeFileSync(usageFile, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), 'utf8');
        diag('card-state: 回填用量 ' + records.length + ' 条（来自 ' + files.length + ' 个会话日志）');
        scheduleWrite();
      } catch (e) {
        diag('card-state: 回填用量失败：' + String(e && e.message ? e.message : e));
      }
    };
    setTimeout(backfillUsage, 8000);

    if (typeof ctx.on === 'function') {
      /*
       * ── 任务状态文件（2026-11-04，任务完成通知/提示音的触发源）─────────────────
       *
       * 【为什么要由 Host 来写】用户需求是「**不论 App 在前台还是后台**，任务完成就要出通知 +
       * 声音」。而通知链路原先挂在 WebView 的 turn 事件上 —— App 被压到后台（或 WebView 被节流）
       * 时那条链路根本不会执行，于是"完全没有通知"（真机复测：`diag-notify` 连文件都没生成）。
       *
       * Host 侧本来就在**全局**监听 `session/event`（下面的 card-state 用的就是这个），
       * 它对前后台无感、不会被节流 ⇒ 把 turn 生命周期落到这个文件，ArkTS 侧轮询它：
       *   · `active=true`  ⇒ 任务开始 → 发"任务进行中"进度通知 + 申请长时任务
       *   · `active=false` ⇒ 任务结束 → 停长时任务、撤进度、发"任务完成"通知（新 ID，带声音）
       * `seq` 每次结束 +1：ArkTS 靠"seq 变新"判断这是一次**新的完成**，即使期间被挂起过，
       * 恢复后也能补发一次通知（不丢事件）。
       */
      const taskStateFile = path.join(HOME_DIR, 'task-state.json');
      let taskSeq = 0;
      let taskActive = false;
      const tasks = new Map();
      const activeTasks = new Map();
      const closedTasks = new Set();
      const CLOSED_TASK_LIMIT = 1024;
      /*
       * 兼容副本目录是否可写：只测一次并缓存。
       * 2in1 真机（2026-11-11）上 `files/` 根目录对宿主进程只读 ⇒ 每个 turn 写兼容副本都
       * EACCES，dshm-host.log 被刷屏。不可写就整体跳过；主链路 `dsh/home/task-state.json`
       * 不受影响（ArkTS 侧读的就是它）。
       */
      let compatWritableCache = null;
      const compatWritable = () => {
        if (compatWritableCache !== null) { return compatWritableCache; }
        try {
          fs.accessSync(SANDBOX_HOME, fs.constants.W_OK);
          compatWritableCache = true;
        } catch (e) {
          compatWritableCache = false;
          diag('task-state: 兼容副本跳过（目录不可写，只有主链路）：' + String(e && e.message ? e.message : e));
        }
        return compatWritableCache;
      };
      const writeTaskState = (state) => {
        try {
          const payload = {
            v: 1,
            active: state.active === true,
            anyActive: taskActive,
            taskId: state.taskId || '',
            sessionId: state.sessionId || '',
            title: state.title || '',
            turn: state.turn || 0,
            state: state.state || (state.active === true ? 'running' : 'idle'),
            seq: taskSeq,
            startedAt: state.startedAt !== undefined ? state.startedAt : '',
            durationMs: state.durationMs !== undefined ? state.durationMs : 0,
            at: new Date().toISOString(),
            updatedAt: Date.now(),
          };
          /*
           * 【直接覆写，不再 tmp+rename（2026-11-04 复测）】上一版用 `writeFileSync(tmp)` +
           * `renameSync(tmp, final)`：在 HFM 上 rename 偶发失败（且失败被 catch 吞掉），
           * 于是 `task-state.json` 根本没出现、ArkTS 侧永远读到"文件不存在"。
           * 这个文件只被我们自己读，不需要原子换名 —— 直接覆写最稳。
           */
          fs.writeFileSync(taskStateFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
          /*
           * 【兼容副本（2026-11-05 复测 P1）】老安装上 `files/task-state.json` 曾是
           * 手工 symlink 到 `dsh/home/task-state.json`；重装/清数据后那条链接会消失。
           * 现在两条路径都写：新版读 `dsh/home`（主），任何旧客户端/排查脚本读 files 根
           * 也能拿到同一份事实 —— 不再依赖设备上的 symlink。
           *
           * 【2026-11-11 2in1 修复】部分机型上 files 根目录对本进程只读，兼容副本每次
           * 都 EACCES 并在 dshm-host.log 里按 turn 刷一条（真机日志 22:21/22:22 各一条）。
           * 目录不可写就整轮跳过（只记一次），不再每拍重试。
           */
          if (compatWritable()) {
            try {
              const compat = path.join(SANDBOX_HOME, 'task-state.json');
              /*
               * 【旧 symlink 就地换成真文件（2026-11-05 PC 复测 P1 收尾）】
               * 老安装上 `files/task-state.json` 是指向 `dsh/home/task-state.json` 的符号链接；
               * 重装/清数据后链接目标可能消失。这里先判「是不是链接」，是就只删链接本身
               * （unlink 不会碰目标），再写真实文件 —— 从此不再依赖任何 symlink。
               */
              try {
                if (fs.lstatSync(compat).isSymbolicLink()) {
                  fs.unlinkSync(compat);
                  diag('task-state: 兼容路径原为 symlink，已替换为真实文件');
                }
              } catch (eLink) { /* 不存在：直接写 */ }
              fs.writeFileSync(compat, JSON.stringify(payload, null, 2) + '\n', 'utf8');
            } catch (e2) {
              if (e2 && ['EACCES', 'EPERM', 'EROFS'].includes(e2.code)) compatWritableCache = false;
              diag('task-state: 兼容副本写失败（不影响主链路）：' + String(e2 && e2.message ? e2.message : e2));
            }
          }
        } catch (e) {
          diag('task-state: 写失败：' + String(e && e.message ? e.message : e));
        }
      };

      /*
       * 启动基线（2026-11-12，遵循官方 turnBoundary）：新进程启动时不可能有 open turn。
       *
       * 官方 dsh-agent 的 `turnBoundary` 投影对 `turn/end` **不区分 reason**，一律把
       * `openTurnStartSeq` 置 null；`accountsForClaim` 把 completed / blocked / aborted /
       * interrupted / error 都列为正常结束种类。崩溃恢复时 `interruptedTurnClosers`
       * 会把 `turn/end interrupted` **补写进会话日志**（dsh-agent-loop 冷读时 append），
       * 但补写不发实时 `session/event` ⇒ Host 的 `ctx.on('session/event')` 收不到它，
       * 上一进程的 `task-state.json` 会停在 `active=true / state=running / seq=0`。
       * 端侧 taskWatch 重启后把这条残留 primed 成基线，界面就一直显示「深度求索中」，
       * 且停止按钮没有可取消的 turn。真机证据：turn 9 01:02:27 已被 interrupted 收尾，
       * 但 01:13:00–01:18:55 新进程仍每 5 秒 primed `#9 running`，直到 turn 10 才覆盖。
       *
       * 因此启动时按官方语义收敛：残留 running 一律写回 done（不 +1 seq，避免误发
       * 一次「任务完成」通知），并从文件恢复 seq，保证后续轮次的 doneKey 连续。
       */
      try {
        let prev = null;
        try {
          prev = JSON.parse(fs.readFileSync(taskStateFile, 'utf8'));
        } catch { /* 文件不存在 / 内容损坏：按首次启动处理 */ }
        if (prev !== null && typeof prev.seq === 'number' && prev.seq >= 0) {
          taskSeq = prev.seq;
        }
        if (prev === null) {
          writeTaskState({ active: false, taskId: '', state: 'idle' });
        } else if (prev.active === true || prev.state === 'running' || prev.anyActive === true) {
          writeTaskState({ active: false, taskId: prev.taskId || '',
            sessionId: prev.sessionId || '', title: prev.title || '',
            turn: prev.turn || 0, state: 'done', startedAt: prev.startedAt || '' });
          diag('task-state: 启动收敛残留 running（官方 turnBoundary 已无 open turn；turn=' +
            String(prev.turn || 0) + ' seq=' + String(prev.seq || 0) + '）');
        }
      } catch (e) {
        diag('task-state: 启动基线写失败：' + String(e && e.message ? e.message : e));
      }

      ctx.on('session/event', (session, event) => {
        try {
          const sid = (session && session.header && session.header.id) || (session && session.id) || '';
          if (!event || typeof event.type !== 'string') return;
          if (event.type === 'session/title') {
            const t = event.data && typeof event.data.title === 'string' ? event.data.title : '';
            if (sid && t.length > 0) {
              titles.set(sid, t);
              if (current.sessionId === sid) {
                current.title = t;
                scheduleWrite();
              }
            }
            return;
          }
          if (event.type === 'turn/start') {
            const turn = event.data && typeof event.data.turn === 'number' ? event.data.turn : 0;
            const key = JSON.stringify([sid, turn]);
            const task = tasks.get(key);
            if (task || closedTasks.has(key)) return;
            const previous = activeTasks.get(sid);
            if (previous) previous.active = false;
            current = {
              sessionId: sid,
              title: titleOf(session, sid) || '',
              state: 'running',
              turn,
              step: 0,
            };
            /* 任务开始：落 task-state（ArkTS 据此发"任务进行中"进度通知 + 申请长时任务）。 */
            taskActive = true;
            const started = { id: sid + '#' + String(turn), sessionId: sid, turn,
              title: current.title, startedAt: new Date().toISOString(), active: true };
            tasks.set(key, started);
            activeTasks.set(sid, started);
            writeTaskState({ active: true, taskId: started.id, sessionId: sid, title: started.title,
              turn, state: 'running', startedAt: started.startedAt });
            scheduleWrite();
            return;
          }
          if (event.type === 'step/start' || event.type === 'step/end') {
            const turn = event.data && typeof event.data.turn === 'number' ? event.data.turn : 0;
            const key = JSON.stringify([sid, turn]);
            const task = tasks.get(key);
            if (closedTasks.has(key) || (task && !task.active)) return;
            if (current.sessionId !== sid) current.sessionId = sid;
            current.turn = turn;
            /*
             * 【兜底：没有 turn/start 也要能识别"在跑"（2026-11-04 复测）】
             * 真机 1+1 这种极短任务，实测只看到 step 事件也说不准；这里把 step 也当"任务进行中"
             * 的判据，任务 id 用 sid + 已记录的 turn（无 turn 则用 0），保证 ArkTS 侧能发进度通知。
             */
            if (!task) {
              const previous = activeTasks.get(sid);
              if (previous) previous.active = false;
              taskActive = true;
              const started = { id: sid + '#' + String(turn), sessionId: sid, turn,
                title: titleOf(session, sid) || '', startedAt: new Date().toISOString(), active: true };
              tasks.set(key, started);
              activeTasks.set(sid, started);
              writeTaskState({ active: true, taskId: started.id, sessionId: sid, title: started.title,
                turn, state: 'running', startedAt: started.startedAt });
            }
            current.state = 'running';
            current.step = event.data && typeof event.data.step === 'number' ? event.data.step : current.step;
            scheduleWrite();
            return;
          }
          if (event.type === 'assistant/message') {
            const usage = event.data && event.data.usage;
            if (usage && typeof usage === 'object') {
              const inT = Number(usage.inputTokens) || 0;
              const outT = Number(usage.outputTokens) || 0;
              if (inT + outT > 0) {
                const record = { t: typeof event.time === 'number' ? event.time : Date.now(), in: inT, out: outT };
                records.push(record);
                if (records.length > MAX_RECORDS) records = records.slice(-MAX_RECORDS);
                try {
                  fs.appendFileSync(usageFile, '\n' + JSON.stringify(record) + '\n', 'utf8');
                  usageAppends += 1;
                  if (usageAppends >= 256) compactUsage();
                } catch { /* 统计落盘失败不影响会话 */ }
                scheduleWrite();
              }
            }
            return;
          }
          if (event.type === 'turn/end') {
            const turn = event.data && typeof event.data.turn === 'number' ? event.data.turn : 0;
            const key = JSON.stringify([sid, turn]);
            let task = tasks.get(key);
            if (closedTasks.has(key)) return;
            if (!task) {
              task = { id: sid + '#' + String(turn), sessionId: sid, turn,
                title: titleOf(session, sid) || '', startedAt: '', active: true };
            }
            if (current.sessionId === sid && current.turn === turn) current.state = 'done';
            /*
             * 任务结束：`seq` +1 并落盘。ArkTS 轮询看到"seq 变新"就发完成通知 + 播提示音，
             * 前后台都一样（宿主侧不受 WebView 可见性影响）。
             *
             * 【2026-11-12 遵循官方 turnBoundary】`turn/end` 是官方「一轮已关闭」的
             * 唯一权威信号，**不区分 reason**：completed / blocked / aborted /
             * interrupted / error / max-tokens 一律关 turn（见 dsh-agent 的
             * turnBoundaryProjectionDefinition.apply 与 accountsForClaim）。
             * 因此这里对**任何** reason 都写 `active=false / state=done`；只有
             * `kind === 'error'` 时把 state 记成 'error' 供通知文案区分完成/失败，
             * 绝不因为 interrupted 就跳过收尾 —— 那正是「回复完了还一直深度求索中」的根因。
             */
            const reason = event.data && event.data.reason;
            const reasonKind = (reason && typeof reason === 'object' && typeof reason.kind === 'string')
              ? reason.kind : '';
            const failed = reasonKind === 'error';
            diag('task-state: turn/end reason=' + (reasonKind || '(none)') +
              ' turn=' + String(event.data && event.data.turn !== undefined ? event.data.turn : current.turn));
            task.active = false;
            tasks.delete(key);
            if (activeTasks.get(sid) === task) activeTasks.delete(sid);
            closedTasks.add(key);
            if (closedTasks.size > CLOSED_TASK_LIMIT) closedTasks.delete(closedTasks.values().next().value);
            taskActive = activeTasks.size > 0;
            taskSeq += 1;
            /* 耗时：开始时刻到现在的毫秒数（开始时刻没记上就给 0，通知里就不显示耗时）。 */
            let durationMs = 0;
            try {
              if (task.startedAt.length > 0) {
                durationMs = Math.max(0, Date.now() - new Date(task.startedAt).getTime());
              }
            } catch { durationMs = 0; }
            writeTaskState({ active: false, taskId: task.id, sessionId: sid, title: task.title,
              turn, state: failed ? 'error' : 'done',
              startedAt: task.startedAt, durationMs: durationMs });
            scheduleWrite();
            void refreshBalance('turn-end');
          }
        } catch (e) {
          diag('card-state: 事件处理异常：' + String(e && e.message ? e.message : e));
        }
      }, { global: true });
      stage('BOOT_62E_CARD_STATE', '$DSH_HOME/card-state.json（会话进度 + 余额/用量）');
    } else {
      diag('card-state: ctx.on 不可用');
    }

    scheduleWrite();
    setTimeout(() => { void refreshBalance('boot'); }, 5000);
    const balanceTimer = setInterval(() => {
      void refreshBalance('interval');
      if (Date.now() - usageLastCompactAt >= 10 * 60 * 1000) compactUsage();
    }, 10 * 60 * 1000);
    if (balanceTimer.unref) balanceTimer.unref();
    return { stateFile, usageFile };
  } catch (e) {
    diag('card-state 注册异常：' + String(e && e.message ? e.message : e));
    return null;
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
      auth: 'anonymous',
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
          const requestedFields = String(url.searchParams.get('fields') || '').split(',').map(s => s.trim()).filter(Boolean);
          const isVersionList = requestedFields.includes('versions');
          if (isVersionList && parsed.range.length === 0 && manifest && typeof manifest === 'object') {
            const view = {};
            if (Array.isArray(manifest.versions)) {
              view.versions = manifest.versions;
            } else if (manifest.versions && typeof manifest.versions === 'object') {
              view.versions = Object.keys(manifest.versions);
            }
            if (manifest.time && typeof manifest.time === 'object') {
              view.time = manifest.time;
            }
            if (manifest['dist-tags'] && typeof manifest['dist-tags'] === 'object') {
              view['dist-tags'] = manifest['dist-tags'];
            }
            if (!Array.isArray(view.versions) || view.versions.length === 0) {
              sendJson(404, { ok: false, error: 'no matching version for: ' + parsed.name });
              return;
            }
            sendJson(200, view);
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
      auth: 'anonymous',
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

/** 预览图代理允许的图床主机（与 dshmarket 客户端 `safeScreenshot()` 的白名单逐条同源）。 */
const SHOT_HOSTS = new Set([
  'raw.githubusercontent.com',
  'user-images.githubusercontent.com',
  'camo.githubusercontent.com',
  'github.com',
]);
/** 单张图上限：10MB（超过就不读、不缓存）。 */
const SHOT_MAX_BYTES = 10 * 1024 * 1024;
/** 进程内图片缓存上限：64 张 / 32MB（同一张图在卡片、灯箱、滚动之间复用）。 */
const SHOT_CACHE_MAX_ITEMS = 64;
const SHOT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const shotCache = new Map();
let shotCacheBytes = 0;

/** 入缓存并按插入序淘汰（Map 的迭代序就是插入序）。 */
function shotCachePut(key, entry) {
  shotCache.set(key, entry);
  shotCacheBytes += entry.body.length;
  while ((shotCache.size > SHOT_CACHE_MAX_ITEMS || shotCacheBytes > SHOT_CACHE_MAX_BYTES)
    && shotCache.size > 1) {
    const oldestKey = shotCache.keys().next().value;
    const victim = shotCache.get(oldestKey);
    shotCache.delete(oldestKey);
    shotCacheBytes -= victim.body.length;
  }
}

/**
 * 预览图代理（`/dshm-shot?url=…[&h=…]`）—— 插件市场（dshmarket）的卡片缩略图与灯箱原图。
 *
 * 【为什么必须由宿主代取】市场的原实现是让**浏览器**去取图：缩略图走
 * `https://images.weserv.nl/?url=…`（服务端缩放），灯箱直连 GitHub 图床。端侧 WebView 里
 * 这两类主机**都连不上**（真机实测 TLS 失败）⇒ 卡片一直是空白。而**宿主进程里**同一批 URL
 * 经 fetch 垫片的出网镜像 1.15–3s 就能拿到（`raw.githubusercontent.com` 本来就在镜像表里；
 * codeload 见 2026-10-14 那笔）⇒ 把出网搬到宿主这一侧、WebView 只跟本地 http 服务打交道，
 * 镜像、超时、嘴碎日志全都留在宿主（客户端那边改一行 `thumbUrl()` 就够，见
 * `dshm-market-bridge` 的 `patchDshmarketThumbs()`）。
 *
 * 【为什么不做缩放】上游那层 `images.weserv.nl` 是**服务端缩放**（卡片实际只要 <150px，而
 * 原图可能几百 KB 到几 MB）。端侧宿主没有图像库（无 sharp），硬做缩放等于新拉一个原生依赖；
 * 市场挑出来的截图实测 27–144 KB ⇒ 原字节直出，代价可以忽略。`h` 参数只是**照抄客户端
 * 的调用形态**（缓存键里带上它，免得将来真要缩放时两处缓存混用），当前**不使用**。
 *
 * 【安全面（三条都得有）】
 *   ① 只允许上表 4 个 GitHub 图床主机、且只允许 https —— 与市场客户端
 *      `safeScreenshot()` 的白名单逐条同源，避免这个端点变成通往任意主机的代理（SSRF）；
 *   ② 体积上限 10MB：有 `content-length` 就先拒，没有就读完再判（GitHub 图床总会给长度，
 *      后一条是兜底）；
 *   ③ **不要 token**：`<img src>` 带不了桥 token（token 只在 JS 里加），而 web 服务只绑
 *      127.0.0.1 ⇒ 能打进来的只有本机进程。也**故意**不接受 `lookup` 之类的扩展参数。
 */
function registerShotProxyEndpoint(ctx) {
  try {
    if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
      diag('shot 端点：ctx.webServer 不可用，跳过注册');
      return;
    }
    // eslint-disable-next-line global-require
    const { dshmFetch } = require('./fetch-shim.js');
    ctx.webServer.register({
      kind: 'exact',
      path: '/dshm-shot',
      auth: 'anonymous',
      handler: async (request, response) => {
        const sendText = (status, text) => {
          response.writeHead(status, {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
          });
          response.end(text);
        };
        try {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' }); response.end(); return;
          }
          const url = new URL(request.url, 'http://localhost');
          const raw = String(url.searchParams.get('url') || '');
          let target = null;
          try {
            target = new URL(raw);
          } catch (e) {
            target = null;
          }
          if (target === null || target.protocol !== 'https:'
            || !SHOT_HOSTS.has(target.hostname.toLowerCase())) {
            sendText(403, 'forbidden image host'); return;
          }
          const key = target.href;
          const hit = shotCache.get(key);
          if (hit !== undefined) {
            response.writeHead(200, {
              'content-type': hit.type,
              'content-length': hit.body.length,
              'cache-control': 'public, max-age=86400',
            });
            response.end(hit.body);
            return;
          }
          const res = await dshmFetch(key, { headers: { accept: 'image/*' } }, { timeoutMs: 20000 });
          if (!res.ok) {
            // 上游 404 就照实回 404（前端 `<img>` 的 onerror 因此不会被伪装成"成功"）
            sendText(res.status === 404 ? 404 : 502, 'upstream ' + res.status);
            return;
          }
          const declared = Number(res.headers.get('content-length') || '');
          if (Number.isFinite(declared) && declared > SHOT_MAX_BYTES) {
            sendText(502, 'image too large'); return;
          }
          const body = Buffer.from(await res.arrayBuffer());
          if (body.length === 0) {
            sendText(502, 'empty image body'); return;
          }
          if (body.length > SHOT_MAX_BYTES) {
            sendText(502, 'image too large'); return;
          }
          const upstreamType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
          const type = /^image\/[a-z0-9.+-]+$/.test(upstreamType) ? upstreamType : 'image/png';
          shotCachePut(key, { type, body });
          response.writeHead(200, {
            'content-type': type,
            'content-length': body.length,
            'cache-control': 'public, max-age=86400',
          });
          response.end(body);
        } catch (e) {
          sendText(502, String(e && e.message ? e.message : e));
        }
      },
    });
    stage('BOOT_64_SHOT_PROXY', '/dshm-shot 已注册');
  } catch (e) {
    diag('shot 端点注册异常（跳过）：' + String(e && e.message ? e.message : e));
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
/**
 * 工具链**自检报告**：把 tmux / gh 的真实可用性写到用户可见的下载目录（2026-11-02）。
 *
 * 【为什么要有它】端侧没有 hdc（沙箱里也没有），而"tmux/gh 到底能不能跑"这个问题
 * 只能靠设备自己回答。与其让人在 UI 里敲命令再看日志，不如让 App 启动后自己跑一遍
 * 并把结果落到 `<公共下载目录>/toolchain-selftest.txt` —— 这个路径宿主能直接读，
 * 于是"第一手证据"不再依赖截图或日志导出。
 *
 * 【判据是 exec 的真结果】`command -v` 只能证明 wrapper 在，**不能证明真身能 exec**
 * （端侧 execve 受签名域管辖，失败形态是一句 Permission denied）。所以三条都跑：
 * 是否存在 / 是否可执行（真跑 `-V`/`--version`）/ 失败时的原样 stderr。
 *
 * 【代价】每次启动一次 `ash -c`，约几十毫秒；失败静默（它只是诊断，不能影响启动）。
 * 写完用原子改名，避免读到半份文件。
 */
function writeToolchainSelfTest() {
  try {
    /*
     * 【公共下载目录不可用就退回沙箱（2026-11-02 r3 P1）】
     * 复测发现日志说"已启动（结果写 <公共目录>/toolchain-selftest.txt）"，
     * 而该目录里两个文件**都不存在** —— 手持档 `claimPublicDownload()` 拿不到归属时
     * `DSHM_PUBLIC_DOWNLOAD` 为空，旧实现直接 return，连一行"没写"都没有。
     * 现在：为空就写沙箱根，并把**实际落点**打进日志，避免"日志说写了、事实上没写"。
     */
    let pub = (process.env.DSHM_PUBLIC_DOWNLOAD || '').trim();
    let fellBack = false;
    if (pub.length === 0) {
      pub = SANDBOX_HOME;
      fellBack = true;
    }
    const out = path.join(pub, 'toolchain-selftest.txt');
    const body = `${out}.body`;
    /*
     * 【为什么要分项取证，而不是只看 wrapper 的判断】
     * 2026-11-02 首测（beta）：`gh` 真跑得出 `gh version 2.72.0`，而 `tmux` 只输出
     * 「该设备系统策略禁止运行第三方原生二进制（execve 被拒）」—— 但 wrapper 的探测是
     * `( exec … ) >/dev/null 2>&1`，**把真正的 errno/错误文本全吞了**。
     * 而这句话有两个完全不同的成因，修法天差地别：
     *   ① ELF 真被签名域拒（签名没写进去）→ 查 .codesign 段；
     *   ② 动态库缺失（`Error loading shared library libevent_core-2.1.so.7`）
     *      → 查 usr/lib 解包与 LD_LIBRARY_PATH。
     * 所以这里绕过 wrapper：直接 exec 真身并**保留 stderr**，再把签名读数、库目录清单
     * 一并写进报告 —— 一次抓取就能定性，不用反复装包。
     */
    const binDir = path.join(SANDBOX_HOME, 'bin');
    const tmuxRoot = path.join(SANDBOX_HOME, 'toolchain', 'tmuxroot');
    const ghRoot = path.join(SANDBOX_HOME, 'toolchain', 'ghroot');
    const signTool = '/data/service/hnp/hmos-clt.org/hmos-clt_1.0.0/sdk/default/openharmony/toolchains/lib/binary-sign-tool';
    const script = [
      `echo "time=$(date)"`,
      `echo "sandbox=${SANDBOX_HOME}"`,
      `echo "public=${pub}"`,
      `echo "=== toolchain 根目录 ==="`,
      `ls -la "${path.join(SANDBOX_HOME, 'toolchain')}" 2>&1 | head -12`,
      `echo "=== tmuxroot/usr/bin ==="`,
      `ls -la "${path.join(tmuxRoot, 'usr', 'bin')}" 2>&1 | head -8`,
      `echo "=== tmuxroot/usr/lib ==="`,
      `ls -la "${path.join(tmuxRoot, 'usr', 'lib')}" 2>&1 | head -20`,
      `echo "=== tmux 直连 exec（保留 stderr）==="`,
      `LD_LIBRARY_PATH="${path.join(tmuxRoot, 'usr', 'lib')}" TERMINFO="${path.join(tmuxRoot, 'usr', 'share', 'terminfo')}" "${path.join(tmuxRoot, 'usr', 'bin', 'tmux')}" -V 2>&1 | head -5`,
      `echo "rc=$?"`,
      `echo "=== tmux 签名读数 ==="`,
      `"${signTool}" display-sign -inFile "${path.join(tmuxRoot, 'usr', 'bin', 'tmux')}" 2>&1 | tail -3`,
      `echo "=== gh 直连 exec（对照臂）==="`,
      `LD_LIBRARY_PATH="${path.join(ghRoot, 'usr', 'lib')}" "${path.join(ghRoot, 'usr', 'bin', 'gh')}" --version 2>&1 | head -3`,
      `echo "=== gh 签名读数（对照臂）==="`,
      `"${signTool}" display-sign -inFile "${path.join(ghRoot, 'usr', 'bin', 'gh')}" 2>&1 | tail -3`,
      `echo "=== wrapper 侧 ==="`,
      `ls -la "${path.join(binDir, 'tmux')}" "${path.join(binDir, 'gh')}" 2>&1`,
    ].join('\n');
    const { spawn } = require('child_process');
    /* 先写 .body，再原子改名到正式名（首版漏了最后这一步，结果只留下 .tmp） */
    const full = `{ ${script}; } > "${body}" 2>&1; mv -f "${body}" "${out}" 2>/dev/null || true`;
    const child = spawn('/system/bin/sh', ['-c', full], {
      cwd: binDir,
      stdio: 'ignore',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH || ''}` },
    });
    child.on('error', () => { /* 诊断失败不影响启动 */ });
    diag(`工具链自检：已启动（结果写 ${out}${fellBack ? '（公共目录不可用，已退到沙箱）' : ''}）`);
  } catch (e) {
    diag(`工具链自检：启动失败（不影响启动）${String(e)}`);
  }
}

/**
 * **宿主上下文**的运行时探针（2026-11-02，第一批第 0 步）。
 *
 * 【要回答的问题】`bin/node`（node-cli）在 Agent 的 shell 里报
 * `Error loading shared library libc++_shared.so`，即使把 libc++/libnode 复制到 el2
 * 并指定 LD_LIBRARY_PATH 也一样；可同一时期 `tmux` 靠 LD_LIBRARY_PATH 能加载
 * libevent/ncurses。⇒ 必须区分"库找不到"与"这个执行上下文拿不到库"。
 *
 * 本探针由 **Host 自己 spawn**（与 toolchain 自检同一条路：`/system/bin/sh -c`），
 * 而 tmux/gh 正是在这个上下文里跑通的。因此：
 *   · 如果这里 `node -v` 能出 v24.x ⇒ 之前失败只是 **Agent shell 的上下文差异**，
 *     随包 npm/corepack 方案（分支 A，+12MB）可行；
 *   · 如果这里也失败 ⇒ 必须换**完整 Node 二进制**（分支 B，+90~130MB）。
 *
 * 顺带测 WebAssembly：`--jitless` 下不可用，而子进程设计上带 JIT，
 * 这决定 esbuild-wasm 能不能在子进程里跑（决定"构建"这条路）。
 */
function writeEnvProbe() {
  try {
    /*
     * 【公共下载目录不可用就退回沙箱（2026-11-02 r3 P1）】
     * 复测发现日志说"已启动（结果写 <公共目录>/toolchain-selftest.txt）"，
     * 而该目录里两个文件**都不存在** —— 手持档 `claimPublicDownload()` 拿不到归属时
     * `DSHM_PUBLIC_DOWNLOAD` 为空，旧实现直接 return，连一行"没写"都没有。
     * 现在：为空就写沙箱根，并把**实际落点**打进日志，避免"日志说写了、事实上没写"。
     */
    let pub = (process.env.DSHM_PUBLIC_DOWNLOAD || '').trim();
    let fellBack = false;
    if (pub.length === 0) {
      pub = SANDBOX_HOME;
      fellBack = true;
    }
    const out = path.join(pub, 'env-probe.txt');
    const body = `${out}.body`;
    const binDir = path.join(SANDBOX_HOME, 'bin');
    const libs = '/data/storage/el1/bundle/libs/arm64';
    const script = [
      `echo "time=$(date)"`,
      `echo "PATH=${binDir}"`,
      `echo "=== node（wrapper → node-cli）==="`,
      `"${path.join(binDir, 'node')}" -v 2>&1 | head -3`,
      `echo "rc=$?"`,
      `echo "=== node-cli 直连（带 el1 libs）==="`,
      `LD_LIBRARY_PATH="${libs}" DSHM_NODE_LIBNODE="${libs}/libnode.so.147" "${path.join(binDir, 'node-cli')}" -v 2>&1 | head -3`,
      `echo "rc=$?"`,
      `echo "=== WebAssembly（子进程带 JIT 才可用）==="`,
      `"${path.join(binDir, 'node')}" -e "console.log(typeof WebAssembly, typeof WebAssembly.Module)" 2>&1 | head -3`,
      `echo "=== npm / corepack 是否已在 PATH ==="`,
      `command -v npm corepack pnpm 2>&1`,
      `echo "=== git / python / tmux（对照臂）==="`,
      `"${path.join(binDir, 'git')}" --version 2>&1 | head -1`,
      `"${path.join(binDir, 'python3')}" --version 2>&1 | head -1`,
      `"${path.join(binDir, 'tmux')}" -V 2>&1 | head -1`,
    ].join('\n');
    const { spawn } = require('child_process');
    const full = `{ ${script}; } > "${body}" 2>&1; mv -f "${body}" "${out}" 2>/dev/null || true`;
    const child = spawn('/system/bin/sh', ['-c', full], {
      cwd: binDir,
      stdio: 'ignore',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH || ''}` },
    });
    child.on('error', () => { /* 探针失败不影响启动 */ });
    diag(`运行时探针：已启动（结果写 ${out}${fellBack ? '（公共目录不可用，已退到沙箱）' : ''}）`);
  } catch (e) {
    diag(`运行时探针：启动失败（不影响启动）${String(e)}`);
  }
}

async function finalizeToolchain() {
  startupWork.request('toolchain-selftest', writeToolchainSelfTest);
  startupWork.request('runtime-probe', writeEnvProbe);
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
     * 名字从**本版 git 的 tar.gz 归档**里现读（readGitCoreSymlinks），保证与版本一致；
     * 读不到时退回原来硬编码的那一条（不退化，只是覆盖面小）。
     * 真身相对链接是 `../../bin/git` / `git-remote-http`，都相对 git-core 目录解析。
     */
    const gitPkgDir = path.join(RES_ROOT, 'toolchain', 'git');
    let replica = null;
    try {
      const gitPkgs = fs.readdirSync(gitPkgDir).filter((n) => /^git-\d/.test(n) && n.endsWith('.tar.gz'));
      for (const a of gitPkgs) {
        replica = await readGitCoreSymlinks(path.join(gitPkgDir, a));
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
/**
 * 安装 **ELF 启动器**：把随包 `nodecli` 复制成 `bin/{node,npm,npx,pnpm,dsh}`。
 *
 * 【为什么必须这样做（2026-11-04，手机端"无解释器"死路）】
 * 手机档没有可 exec 的 shell：`/system/bin/sh` 被拒、`toybox` 也没有 sh applet。
 * 于是所有 **shell 脚本形态**的启动器在手机上一行都跑不了（内核 execve 阶段就失败），
 * 用户看到的就是 `libc++_shared.so not found` / `command not found`。
 *
 * 做法：这五个入口改成**同一份已签名 ELF**的副本，由 `nodecli.c` 按"自己叫什么名字"
 * 决定跑什么（node→直通；pnpm/npm/npx→插入 toolchain 里的 JS 入口；dsh→扫 cores 找 bin.js）。
 * 它们**不需要解释器、不需要环境变量**，PC 与手机同一套。
 *
 * 【为什么放在最后调用】`ensureCliShims` / `ensureToolchainWrappers` 会先写各自的服务脚本；
 * 这一段必须**最后**执行，才能在支持 ELF 的档位上把脚本覆盖成 ELF（脚本版本作为对照臂保留在
 * `*-queue` 与源码里，便于回退）。
 */
/**
 * 前 4 字节是否是 ELF 魔数。只读 4 字节，不做完整解析。
 * @param {string} p 文件路径
 */
function looksLikeElf(p) {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const b = Buffer.alloc(4);
      const n = fs.readSync(fd, b, 0, 4, 0);
      return n === 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return false;
  }
}

/**
 * 原子落位一个 ELF 启动器（2026-11-07 真机回归）。
 *
 * 【为什么不能直接覆盖】hmfs 上"曾布置过"的文件可能进入封存态：覆盖写与 chmod 都被拒，
 * `rewriteExecutable` 的"删除重铺"也救不回来（docs/110 的真机证据）⇒ 盘上留下的仍是
 * `#!/system/bin/sh` 假壳 ⇒ 插件页 `pnpm view` 在 execve 阶段直接 EACCES。
 *
 * 做法：写**同目录临时文件**（新 inode）→ chmod 755 → 校验 X_OK + ELF 魔数 →
 * `rename` 覆盖目标（同一目录内的原子替换，不碰旧 inode）。任一失败才退回删除重铺。
 *
 * @returns {'ok'|'fallback'|'fail'}
 */
function installElfFile(dst, bytes, label) {
  const tmp = dst + '.new';
  try {
    try { fs.rmSync(tmp, { force: true }); } catch (e) { /* 残留无所谓 */ }
    fs.writeFileSync(tmp, bytes);
    fs.chmodSync(tmp, 0o755);
    fs.accessSync(tmp, fs.constants.X_OK);
    if (!looksLikeElf(tmp)) {
      throw new Error('写入的不是 ELF');
    }
    fs.renameSync(tmp, dst);
    fs.chmodSync(dst, 0o755);
    fs.accessSync(dst, fs.constants.X_OK);
    if (!looksLikeElf(dst)) {
      throw new Error('落位后不是 ELF');
    }
    return 'ok';
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* 忽略 */ }
    diag(`${label}：原子落位失败（${String(e && e.message ? e.message : e).slice(0, 140)}）⇒ 回退删除重铺`);
    try {
      return rewriteExecutable(dst, (d) => fs.writeFileSync(d, bytes), label) ? 'fallback' : 'fail';
    } catch (e3) {
      diag(`${label}：删除重铺也失败：${String(e3 && e3.message ? e3.message : e3).slice(0, 140)}`);
      return 'fail';
    }
  }
}

function installElfLaunchers(binDir, resRoot) {
  if (!binDir || binDir.length === 0) {
    return;
  }
  /*
   * 【**所有档位**都换成 ELF（2026-11-05，根因实证后回到无条件形态）】
   *
   * 上一版在 PC/2in1 上"保留脚本"，理由是当时实测独立 ELF **dlopen 不了随包 libnode**
   * （即便 `DSHM_NODE_LIBNODE` 指到绝对路径也失败）。2026-11-05 用已签名的最小
   * dlopen 探针把这条翻案了：
   *   · el1 里的 `libnode.so.137` **没有 .codesign** ⇒ exec 域加载返回 Permission denied；
   *   · 同一份文件自签名后 `dlopen` 返回 OK；系统 `libc++_shared.so` 始终可加载。
   * ⇒ 失败根因是**库未签名**，不是路径、也不是"ELF 不能用于 PC"。
   * 随包库现在由 `tools/sign-bundled-libs.mjs` 在构建期签名，`nodecli` 也用绝对路径
   * 找库（并去掉了指向 el1 的 RUNPATH），于是五个入口可以统一成 ELF：
   * PC、平板、手机同一套，不再出现"同一功能三端形态不同"。
   */
  let hasShell = false;
  try {
    fs.accessSync('/system/bin/sh');
    hasShell = true;
  } catch (e) {
    hasShell = false;
  }
  diag(`ELF 启动器：本档有 /system/bin/sh=${hasShell}（仍统一用 ELF；脚本仅作为回退对照保留在源码）`);
  const src = path.join(resRoot, 'toolchain', 'node', 'nodecli');
  let bytes = null;
  try {
    bytes = fs.readFileSync(src);
  } catch (e) {
    diag(`ELF 启动器：读不到 ${src}（${String(e && e.message ? e.message : e)}）⇒ 保持脚本形态`);
    return;
  }
  if (bytes === null || bytes.length === 0) {
    diag(`ELF 启动器：${src} 为空 ⇒ 保持脚本形态`);
    return;
  }
  const names = ['node', 'npm', 'npx', 'pnpm', 'dsh'];
  const done = [];
  const detail = [];
  for (const name of names) {
    const dst = path.join(binDir, name);
    let r = 'fail';
    try {
      r = installElfFile(dst, bytes, `ELF 启动器：${name}`);
    } catch (e) {
      diag(`ELF 启动器：${name} 写入失败（继续）：${String(e && e.message ? e.message : e)}`);
    }
    detail.push(`${name}=${r}`);
    if (r !== 'fail') {
      done.push(name);
    }
  }
  diag(`ELF 启动器：${done.join('/') || '（无）'} 已就位（同一份 nodecli，按文件名分派）；明细 ${detail.join(' ')}`);
  /*
   * 【可观测性（2026-11-07）】再扫一遍最终形态：`ELF-ok` / `ELF-noexec` / `script-stale`。
   * 这行是"插件页能不能 spawn pnpm"的唯一直接证据 —— 以后再出 EACCES，先看它。
   */
  const report = names.map((name) => {
    const p = path.join(binDir, name);
    let x = false;
    try { fs.accessSync(p, fs.constants.X_OK); x = true; } catch (e) { x = false; }
    const elf = looksLikeElf(p);
    return `${name}=${elf ? (x ? 'ELF-ok' : 'ELF-noexec') : 'script-stale'}`;
  });
  diag(`CLI launcher: ${report.join(' ')}`);
}

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
    { label: 'bash',
      p: process.env.DSHM_BASH_EXECUTABLE
        || (process.env.PATH ? (process.env.PATH.split(':')[0] + '/bash') : '/system/bin/sh'),
      args: ['-c', 'echo DSHM-EXEC-OK'], env: process.env,
       },
    /*
     * 【2026-10-06 手机档能力读数：系统 shell 与 toybox】（真机 Mate 80 / OH 7.0.0.105）
     *
     * 这两条探针回答的是"手机 / 平板上还有没有真 shell 可用"。读数（`node-output.log`）：
     *   · system-sh=缺 —— "缺"来自本函数的前置判据 `statSize(t.p) <= 0`：**app 连 `stat`
     *     都拿不到 `/system/bin/sh`**，而同目录的 toybox 拿得到。该文件在 `hdc shell`
     *     （shell 域）下是 `-rwxr-xr-x root:shell 349184` ⇒ 拒绝发生在 MAC 对
     *     `sh_exec` 标签的 `getattr`/`exec` 上，与执行位、与"文件在不在"都无关；
     *   · toybox=ok —— `/system/bin/toybox` **能 execve**（真跑起来了）。同一份二进制的
     *     applet 清单里**没有 sh / bash / ash**，但有 ls/cat/grep/sed/find/cp/mv/rm/
     *     mkdir/chmod/tar/gzip/… 约 110 个（清单与取证见 docs/104）。
     *   ⇒ 手机 / 平板：**没有真 shell 进程**（随包自签名 ELF 一律 EACCES、系统 sh 被 MAC 拒、
     *     toybox 不带 sh applet），但**有真 userland 命令**可以 execve。
     *
     * 【为什么留这两条、不按"一次性探针"删】与上面 `ash` 那条同理：它是"本档还能执行什么"
     * 的机器可读判据，每次启动都留证；OS 升级后 sh 是否放行、toybox 是否带 sh 都能被它发现。
     * （本次追查用的 `toybox sh` 与 applet 清单两条一次性探针已删，读数记进 docs/104。）
     */
    { label: 'system-sh', p: '/system/bin/sh', args: ['-c', 'echo DSHM-SYSTEM-SH-OK'], env: process.env },
    { label: 'toybox', p: '/system/bin/toybox', args: ['true'], env: process.env },
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
 * 终端能力判据（手机 / 平板档"还有没有真 shell"）：每次启动留一份机器可读读数。
 *
 * 【为什么要单开一个函数，而不并进 execProbeTargets()】
 *   probeExec() 的判据是"进程有没有被 execve 起来"——任何正常退出都记 `ok`，
 *   连 `toybox sh` 那种 `Unknown command sh` 也记 `ok`（真机读数里那条
 *   `toybox-sh=ok` 就是这么来的，只看数字会误判成"有 sh"）。要量"这一档能不能
 *   拿到真 shell"必须同时留下 **rc / 信号 / stdout / stderr**，故这里改用
 *   spawnSync 直接留证。
 *
 * 【判据要回答的两条待判路径】（MAC 标签对照表与全部原始读数见 docs/104）
 *   (1) toybox 能不能当**启动器**去 exec 真实 ELF（`toybox env <elf>`）：若 execve
 *       时发生 MAC 域转换，`/system/bin/sh`（类型 sh_exec，宿主自己连 stat 都被拒）
 *       就能被接力起来；
 *   (2) HAP `libs/arm64/` 里的 ELF 能不能被直接 execve：若可以，就能把 shell 装成
 *       `libX.so` 随包发（该目录的 `dlopen` 已证可用，见 jitless-env.cjs 的 E18）。
 *   两条都为否 = 手机 / 平板的"真 shell 进程"无解（只能走纯 JS 命令翻译层）；
 *   任一条为是 = 侧边栏终端可以做真 shell。故此函数是**产品判据**，
 *   与一次性排障脚本不同：OS 升级后 sh 是否放行、libs 是否可以 exec 都由它发现。
 */
function probeShellCapability() {
  const { spawnSync } = require('node:child_process');
  const shimDir = process.env.PATH ? process.env.PATH.split(':')[0] : '';
  const statusOf = (r) => (r.error ? `err(${r.error.code || 'unknown'})`
    : `rc${r.status}${r.signal ? `/sig${r.signal}` : ''}`);
  /*
   * 【必须先去 NUL（2026-10-06 真机踩到）】`/proc/self/attr/current` 读出来尾部带一个
   * `\0`，而 JS 的 `\s` **不匹配** `\u0000` ⇒ 它会原样留在读数里、再进 diag 行。后果不是
   * "多了个字符"，而是**下游读日志的人被误导**：设备侧 grep 把含 NUL 的行当成到了行尾，
   * `终端能力汇总：…` 那一行于是只显示到 `宿主域=…:s0`（r4 报告里那行"看起来只有宿主域"
   * 就是这么来的，见 docs/106 §7）。故这里与下面的 hostDomain 都先剔 NUL。
   */
  const tidy = (s) => String(s === undefined || s === null ? '' : s).split('\u0000').join('').trim().replace(/\s+/g, ' ').slice(0, 120);
  // 【同一批读数，两个去向】diag 那几行是给人看的（口径、行数都不变），readings 是给
  // `host-ready.json` 的 runtime.terminal 用的结构化副本（docs/106 §2：端侧自检不必再
  // 靠日志文本猜"本档有没有真 shell / python3 能不能跑"）。
  const readings = [];
  const run = (label, file, args, opts) => {
    if (!file || file.length === 0 || statSize(file) <= 0) {
      diag(`终端能力 ${label}：缺（${file || 'path 为空'}）`);
      readings.push({ label, status: '缺', stdout: '', stderr: '' });
      return `${label}=缺`;
    }
    let r = null;
    try {
      r = spawnSync(file, args, Object.assign({ encoding: 'utf8', timeout: 10000 }, opts || {}));
    } catch (e) {
      diag(`终端能力 ${label}：抛错 ${String(e).slice(0, 100)}`);
      readings.push({ label, status: '抛错', stdout: '', stderr: '' });
      return `${label}=抛错`;
    }
    const status = statusOf(r);
    const out = tidy(r.stdout);
    diag(`终端能力 ${label}：${status} out=[${out}] err=[${tidy(r.stderr)}]`);
    readings.push({ label, status, stdout: out, stderr: tidy(r.stderr) });
    return `${label}=${status}`;
  };
  const tb = '/system/bin/toybox';
  const lines = [];
  let hostDomain = '';
  // (a) 宿主进程自己的 MAC 域：下面每一条读数的对照基准
  try {
    hostDomain = fs.readFileSync('/proc/self/attr/current', 'utf8').split('\u0000').join('').trim();
    lines.push(`宿主域=${hostDomain}`);
  } catch (e) {
    lines.push(`宿主域=读失败(${e && e.code})`);
  }
  // (b) toybox 进程自己的域：与宿主域相同即 = exec 不做域转换 = 下面 (d)(e) 必然同判
  lines.push(run('toybox域', tb, ['cat', '/proc/self/attr/current']));
  // (c) toybox 能不能 stat 到 /system/bin/sh（宿主自己 stat 的读数是"缺"）
  lines.push(run('toybox-stat-sh', tb, ['ls', '-l', '/system/bin/sh']));
  // (d) 路径 (1)：toybox 当启动器 exec 系统 sh
  lines.push(run('toybox-exec-sh', tb, ['env', '/system/bin/sh', '-c', 'echo DSHM-RELAY-SH-OK']));
  // (e) 路径 (1) 的另一半：toybox 当启动器 exec 随包 ELF
  lines.push(run('toybox-exec-ash', tb, ['env', path.join(shimDir, 'ash'), '-c', 'echo DSHM-RELAY-ASH-OK']));
  // (f) 路径 (2)：libs/arm64 里的 ELF 直执（取存在的第一个候选；cwd 挪到 tmp 避免
  //     exec 成功而崩在应用自己的工作目录里留 core）
  let libPath = '';
  for (const name of ['libgmodule-2.0.so', 'libffi.so', 'libpty.so', 'libkoffi.so']) {
    const p = path.join(NATIVE_LIBS, name);
    if (NATIVE_LIBS.length > 0 && statSize(p) > 0) {
      libPath = p;
      break;
    }
  }
  lines.push(run('libs-exec', libPath, [], { cwd: require('node:os').tmpdir() }));
  // 汇总一行：这是"本档终端能力"唯一的机器可读结论，缺它即视为没跑
  diag(`终端能力汇总：${lines.join('，')}`);
  // 【机器可读副本】判据看 **回显的 marker**，不看 rc：docs/104 实测 `toybox sh` 会被记成
  // `ok`（真相在 stderr 的 Unknown command）—— 只看数字会把"没有 sh"读成"有 sh"。
  const byLabel = {};
  for (const r of readings) {
    byLabel[r.label] = r;
  }
  const relayed = (label, marker) => {
    const r = byLabel[label];
    return r !== undefined && r.status === 'rc0' && r.stdout.indexOf(marker) >= 0;
  };
  const shOk = relayed('toybox-exec-sh', 'DSHM-RELAY-SH-OK');
  const ashOk = relayed('toybox-exec-ash', 'DSHM-RELAY-ASH-OK');
  recordRuntimeProbe('terminal', {
    hostDomain: hostDomain.length > 0 ? hostDomain : 'read-failed',
    toyboxDomain: byLabel['toybox域'] === undefined ? '' : byLabel['toybox域'].stdout,
    shStat: byLabel['toybox-stat-sh'] === undefined ? 'n/a' : byLabel['toybox-stat-sh'].status,
    relaySh: byLabel['toybox-exec-sh'] === undefined ? 'n/a' : byLabel['toybox-exec-sh'].status,
    relayAsh: byLabel['toybox-exec-ash'] === undefined ? 'n/a' : byLabel['toybox-exec-ash'].status,
    libsExec: byLabel['libs-exec'] === undefined ? 'n/a' : byLabel['libs-exec'].status,
    realShell: shOk || ashOk ? 'yes' : 'no',
    note: shOk || ashOk
      ? 'toybox 当启动器已能起真 shell（本档终端可做真 shell）'
      : '两条路径都被拒（toybox 中继 / 随包 ELF 都起不来）⇒ 本档没有真 shell，见 docs/104',
    measuredAt: new Date().toISOString(),
  });
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
  const execResults = {};
  for (const t of execProbeTargets()) {
    if (startupWork.stopped) return;
    if (!t.p || t.p.length === 0 || statSize(t.p) <= 0) {
      // 【"缺"是读数，不是跳过】(2026-10-03) 未解包/半成品时它照样进汇总 ⇒ 端侧能看到
      // "这一项本次没有可执行文件"这一事实，而不是一行都没有（旧行为见本函数头注）。
      summary.push(`${t.label}=缺`);
      execResults[t.label] = `缺`;
      continue;
    }
    const r = await probeExec(t.p, t.args, t.env);
    summary.push(`${t.label}=${r}`);
    execResults[t.label] = r;
  }
  if (startupWork.stopped) return;
  // 【无条件执行】这一行是"探针真的跑过"的唯一机器可读信号（没有它 ⇒ 本门禁不算通过）。
  // （这行的字面形态被 `tools/assert-exec-fix.mjs` 断言 24 锁定：改动它等于改动那条守卫的判据，
  //   所以这里保持原样，结构化副本另算一份 —— 不要为了省一次 join 去改它的写法。）
  diag(`exec 探测：${summary.join('，')}`);
  // 【机器可读副本】同一批评数的结构化版本（docs/106 §2）：`runtime.exec.results`
  // 让 agent / 门禁直接读结论，不必解析上面的日志文本。
  recordRuntimeProbe(`exec`, {
    results: execResults,
    summary: summary.join('，'),
    measuredAt: new Date().toISOString(),
  });
  // 【终端能力判据】紧跟 exec 探测之后跑：探针量"能不能 execve"，
  // probeShellCapability() 量"这一档还有没有真 shell"，两者结论配套看（docs/104）。
  try {
    probeShellCapability();
  } catch (e) {
    diag(`终端能力探测异常：${String(e).slice(0, 140)}`);
  }
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

function scheduleToolchainExtraction(resRoot, binDir, skipExtras = false) {
  if (!binDir || binDir.length === 0) {
    return;
  }
  healToolchainStage();
  const tarball = path.join(resRoot, PYTHON_TARBALL_REL);
  const gitPkgDir = path.join(resRoot, 'toolchain', 'git');
  /*
   * 【归档换代即重解（报告 4 ③）】`pythonReady()`/`gitReady()` 是"存在即跳过"，
   * 光靠它们，构建期加了自签名的新归档永远不会被解开（用户继续用旧的无签名文件）。
   * 这里把构建期写的 `dshm-signed.txt` 标记纳入判据：标记不一致 ⇒ 强制重解。
   * 判据单独成一个函数（needsReextractForSign），因为它同时要处理"归档没标记"的旧包。
   */
  const pySignStale = needsReextractForSign(path.join(resRoot, 'toolchain', 'python'), PYTHON_PREFIX);
  const gitSignStale = needsReextractForSign(gitPkgDir, GIT_ROOT);
  if (pySignStale) {
    diag('工具链：python 归档已换代（dshm-signed.txt 变化），强制重解以取到已签名的 ELF');
  }
  if (gitSignStale) {
    diag('工具链：git 归档已换代（dshm-signed.txt 变化），强制重解以取到已签名的 ELF');
  }
  const needPy = (!pythonReady() || pySignStale) && statSize(tarball) > 0;
  let gitPkgs = [];
  try {
    gitPkgs = fs.existsSync(gitPkgDir)
      ? fs.readdirSync(gitPkgDir).filter((n) => n.endsWith('.tar.gz')).sort()
      : [];
  } catch (e) {
    diag(`工具链：读取 ${gitPkgDir} 失败：${String(e)}`);
  }
  const needGit = (!gitReady() || gitSignStale) && gitPkgs.length > 0;
  /*
   * tmux / gh：判据与 git 同构（"真身不在"或"归档换代"就解），但**按目录独立判断** ——
   * 一个 root 换代不该拖着另一个重解（与 dshm-signed.txt 按目录写标记同一口径）。
   */
  const extraState = [];
  for (const spec of EXTRA_TOOLCHAINS) {
    const pkgDir = path.join(resRoot, 'toolchain', spec.name);
    let list = [];
    try {
      list = fs.existsSync(pkgDir) ? fs.readdirSync(pkgDir).filter((n) => n.endsWith('.tar.gz')).sort() : [];
    } catch (e) {
      diag(`工具链：读取 ${pkgDir} 失败：${String(e)}`);
    }
    const stale = needsReextractForSign(pkgDir, spec.root);
    const need = (!extraReady(spec) || stale) && list.length > 0;
    if (stale) {
      diag(`工具链：${spec.name} 归档已换代（dshm-signed.txt 变化），强制重解以取到已签名的 ELF`);
    }
    extraState.push({ spec, pkgDir, list, need });
  }
  const needExtra = extraState.filter((x) => x.need);
  /*
   * 【P0-2（2026-11-11）：额外归档延后出启动窗口】诊断报告实测：extras 五个 root
   * 共 15 个归档、25 MB 压缩 / 93 MB 落盘，与 python 解包、插件装载挤在同一个
   * 15 秒窗口里，还把事件循环钉住 5.5~8.0 秒。但它们**不参与 web 监听**：
   * bash/gh/npm/pnpm/tmux 只服务后续工具调用。所以本轮启动只解 python/git，
   * extras 等本轮解包子进程成功退出后再单独排一次（见 exit 回调）。
   * 注意：不能在这里直接 setTimeout 递归 —— python 还在解的时候重入会 rm 掉 py-stage。
   */
  const deferredExtras = skipExtras ? needExtra.splice(0, needExtra.length) : [];
  if (deferredExtras.length > 0) {
    diag(`工具链：额外归档 ${deferredExtras.length} 个延后到本轮解包结束后再解（不与启动抢 IO）`);
  }
  if (!needPy && !needGit && needExtra.length === 0) {
    // 稳态 boot 也必须跑补齐：git-remote-https 的"残缺 symlink 占位"修复
    // 不依赖解包（isElf 判定幂等轻量），只挂在解包/归位路径上会被跳过
    // （真机踩过：连续两轮 boot 补齐 diag 缺失、占位未替换）。
    finalizeToolchain();
    /*
     * python 预设（py-site）投放不能只挂在"本轮刚解过 python"的收尾里（R4，2026-11-26）：
     * 升级用户的 python 工具链早已就绪 ⇒ didPy=false，预设永远不会解，`$HOME/py-site`
     * 恒空（真机诊断实测 pptx/lxml 等默认不可导入）。稳态 boot 也补一次——该函数幂等：
     * 仅当 py-site 不存在或为空、且预设包随包时才解，用户已有包则不动。
     */
    ensurePythonSitePreset();
    diag(`工具链：无需解包（python=${pythonReady()}，git=${gitReady()}`
      + EXTRA_TOOLCHAINS.map((sp) => `，${sp.name}=${extraReady(sp)}`).join('') + '）');
    /* 启动期没有 python/git 要解，但 extras 被延后了 ⇒ 单独排一次（3 s 后，等 boot 环先走完）。 */
    if (deferredExtras.length > 0) {
      setTimeout(() => {
        scheduleToolchainExtraction(resRoot, binDir, false);
      }, 3000);
    }
    return;
  }
  const pyStage = path.join(TOOLCHAIN_DIR, 'py-stage');
  const handheld = ['phone', 'tablet', 'foldable'].includes(String(process.env.DSHM_DEVICE_FORM || '').toLowerCase());
  if (handheld) {
    setTimeout(() => {
      inProcessToolchainFallback(tarball, needPy, needGit, 'handheld', resRoot);
    }, 5000);
    return;
  }
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
    /*
     * 【额外 root 的清空**不在这里做**（2026-11-10）】extras 的旧树合计约 93 MB / 数万条目，
     * `fs.rmSync(recursive)` 在主线程上同步删要 5~8 s（真机实测），而且正好压在最敏感的
     * 启动窗口里 —— 端口还没起监听、ArkTS 侧的 15 s 预算已经在倒数。
     * 现在改由下面的 busybox 子进程 `rm -rf` 完成（见 cmds 里那段），主线程不再停摆。
     * 进程内回退分支会在自己的解包前清空（见 clearExtraToolchainRoots），两边都成立。
     */
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
  for (const a of gitPkgs) {
    cmds.push(`tar xmzf "${path.join(gitPkgDir, a)}" -C "${GIT_ROOT}"`);
  }
  for (const x of needExtra) {
    /*
     * 【清空也交给子进程（2026-11-10）】见上方 `needGit` 之后那段注释：主线程同步
     * `rmSync` 一个 93 MB 的树要 5~8 s，会把启动窗口吃掉。顺序不能变：先删、再建、再解。
     */
    cmds.push(`rm -rf "${x.spec.root}"`);
    cmds.push(`mkdir -p "${x.spec.root}"`);
    for (const a of x.list) {
      cmds.push(`tar xmzf "${path.join(x.pkgDir, a)}" -C "${x.spec.root}"`);
    }
    /* 只补可执行位：hmfs 会丢权限位；失败不阻塞（finish 阶段还会补） */
    cmds.push(`chmod 755 "${path.join(x.spec.root, ...x.spec.probe)}" || true`);
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
  diag(`工具链：后台解包启动（python=${needPy}，git 包 ${gitPkgs.length} 个`
    + needExtra.map((x) => `，${x.spec.name} 包 ${x.list.length} 个`).join('') + '），输出见 .extract.log');
  /*
   * 【进程内回退只允许进一次（2026-10-07）】spawn 的失败有两种形态：
   *   ① 同步抛错（uv_spawn 在 fork / open 阶段就失败）；② 异步 `'error'` 事件
   *   （execve 阶段被拒 —— 手机 / 平板档的实测形态，见 docs/104）。
   * 同一个 child 上两条异常路径**可能都触发**，而进程内解包是往同一个 `py-stage` 里写：
   * 跑第二遍不只是白干 —— 它的 `finishToolchainExtraction` 会去 rename 一个已经被第一遍
   * rename 走的 `py-stage`，再往日志里多丢一条无用失败行。故用一次性门闩；
   * 判据与上游一致：重试发生在**下一次启动**，不是同一次启动里。
   */
  let inProcFallbackDone = false;
  const inProcFallback = (why) => {
    if (inProcFallbackDone) {
      diag(`工具链：进程内回退已在进行（忽略重复触发：${why}）`);
      return;
    }
    inProcFallbackDone = true;
    inProcessToolchainFallback(tarball, needPy, needGit, why, resRoot);
  };
  let child;
  try {
    child = spawn(path.join(binDir, 'busybox'), ['ash', '-c', cmds.join('\n')], {
      stdio: ['ignore', logFd, logFd],
    });
  } catch (e) {
    try { fs.closeSync(logFd); } catch (e2) { /* 已关 */ }
    diag(`工具链：解包子进程 spawn 失败：${String(e)}`);
    inProcFallback('spawn 同步抛错');
    return;
  }
  child.on('exit', (code, signal) => {
    try { fs.closeSync(logFd); } catch (e) { /* 已关 */ }
    // 先记再干活：上一轮真机该回调疑似未触发（收尾行缺失、py-stage 未归位），
    // 把 exit 本身做成可观测事实，再丢就有证据。
    diag(`工具链：解包子进程退出（code=${code}，signal=${signal}）`);
    /* P0-1 注意 2：非 0 退出时不归位、不写签名标记（半成品不能被当成"已换代完成"）。 */
    finishToolchainExtraction(needPy, needGit, false, code === 0);
    /* P0-2：extras 延后到本轮解包成功之后再排（5 s，避开 BOOT_65/70 的收尾）。 */
    if (code === 0 && deferredExtras.length > 0) {
      setTimeout(() => {
        scheduleToolchainExtraction(resRoot, binDir, false);
      }, 5000);
    }
  });
  child.on('error', (e) => {
    try { fs.closeSync(logFd); } catch (e2) { /* 已关 */ }
    diag(`工具链：解包子进程异常：${String(e)}`);
    inProcFallback('子进程无法启动');
  });
}

/**
 * 工具链解包的**进程内回退**（2026-10-07，手机 / 平板档）。
 *
 * 【什么时候会走到这里】正常路径是 `spawn <busybox> ash -c "tar xmzf …"`：
 * PC/2in1 档可用；**手机 / 平板档必失败**——本档 SELinux 域下应用自带可执行文件
 * 一律 `EACCES`（`docs/104` §2/§3，含"用能执行的程序当启动器"同判的实测）。
 * 真机形态：每次启动先 `rmSync(PYTHON_PREFIX)`、spawn 报错、`.extract.log` 落 0 字节，
 * 于是 `toolchain/python/bin/*` 永远为空、`runtime.python` 永远 `stdlib=false`
 * ⇒ **应用自身的 Python 桥在本档永久不可用**（手机端体检报告 P0-2）。
 *
 * 【为什么回退能成立】解包**不需要**新进程：`tar.gz = gzip(ustar)`，
 * `node:zlib.gunzipSync` + 512 字节头解析是零依赖的确定性路径
 * （`hostcore/app/tar-gz.cjs`，与插件安装器共用同一份 walker）。该模块按批
 * `await setImmediate` 让出事件循环，避免 80MB / 4530 个条目的同步写把主线程钉死
 * （本项目在 `LOOP-GAP` 上已经踩过一次）。
 *
 * 【为什么 git 不在回退范围内】git 真身是随包 ELF，本档 `execve` 一律被拒
 * ⇒ 解出来也永远起不来，只是白占 ~100MB 用户空间。故只解 python —— 它走
 * dlopen + 进程内 CPython，是本档**唯一**真正能用的工具链。
 *
 * 【"没解" ≠ "失败"（2026-10-19 分诊 S-15）】上面这条理由说明手持档**本来就不该**解 git，
 * 所以收尾必须把它记成 `git=SKIPPED`（结构性不适用），而不是 `git=FAIL`。旧实现混为一谈，
 * 导致分诊里 11/11 个 boot 全 `python=OK，git=FAIL`，还顺带挡掉了 python 的 exec 兜底。
 */
/**
 * 收集本次要在**进程内**解包的额外工具链归档（bash / npm / pnpm / tmux / gh）。
 *
 * 【为什么抽成函数（2026-11-05）】原先这段只写在 `!needPy` 分支里，导致
 * "python 也要解"时额外 root 被整段跳过（手机端六个目录全空）。抽出来后
 * 两条分支共用同一份收集逻辑，不会再漂。
 */
function toolchainExtraJobs(resRoot = RES_ROOT) {
  const jobs = [];
  for (const spec of EXTRA_TOOLCHAINS) {
    if (extraReady(spec) && !needsReextractForSign(path.join(resRoot, 'toolchain', spec.name), spec.root)) continue;
    let list = [];
    try {
      const dir = path.join(resRoot, 'toolchain', spec.name);
      list = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.tar.gz')).sort() : [];
    } catch (e) {
      list = [];
    }
    for (const name of list) {
      jobs.push({ archive: path.join(resRoot, 'toolchain', spec.name, name), root: spec.root, name: spec.name });
    }
    if (list.length === 0) {
      diag(`工具链：${spec.name} 无归档可解（resfile 里没有 .tar.gz）`);
    }
  }
  return jobs;
}

async function inProcessToolchainFallback(tarball, needPy, needGit, why, resRoot = RES_ROOT) {
  if (inProcessToolchainFallback.running) return;
  inProcessToolchainFallback.running = true;
  const report = (message) => {
    diag(message);
    try {
      ensureDir(TOOLCHAIN_DIR);
      fs.appendFileSync(path.join(TOOLCHAIN_DIR, '.extract.log'), message + '\n', 'utf8');
    } catch (error) {
      diag('toolchain extract log: ' + String(error));
    }
  };
  const stages = new Map();
  const extractExtra = async (job) => {
    if (!stages.has(job.root)) stages.set(job.root, job.root + '.stage-' + Date.now());
    await tarGz.extractTarGzFile(job.archive, stages.get(job.root), { yieldEvery: 16, maxOutputLength: 256 * 1024 * 1024 });
  };
  const publishExtras = () => {
    for (const [root, staged] of stages) {
      const spec = EXTRA_TOOLCHAINS.find((item) => item.root === root);
      if (!spec || fs.statSync(path.join(staged, ...spec.probe)).size <= 0) throw new Error('Missing staged toolchain probe: ' + root);
    }
    for (const [root, staged] of stages) {
      const backup = root + '.previous-' + Date.now();
      const exists = fs.existsSync(root);
      if (exists) fs.renameSync(root, backup);
      try {
        fs.renameSync(staged, root);
      } catch (error) {
        if (exists) fs.renameSync(backup, root);
        throw error;
      }
    }
    /* 换代成功后清掉上一轮留下的空备份壳（非空的一律保留作回退材料）。 */
    for (const [root] of stages) pruneEmptyPreviousSiblings(root);
  };
  try {
  if (!needPy) {
    /*
     * 【只有 git 待解：**结构性不适用**，不是失败（2026-10-19 分诊 S-15）】
     * 手持档 spawn 必 EPERM ⇒ 走进程内回退；而回退**故意**不解 git（真身 execve 被拒，
     * 解出来也永远起不来，只是白占 ~100MB）。旧实现在这里打"无事可做"并调
     * `finishToolchainExtraction(false, false)` ⇒ 收尾行 `git=FAIL`、`ensureExecutables()`
     * 又被 `pyOk && gitOk` 挡住。分诊里 11/11 个 boot 全 `git=FAIL` 就是这么来的：
     * 把"本档不支持"读成了"解包坏了"。现在改成显式的 `gitSkipped` 三态。
     */
    if (needGit) {
      diag('工具链：git 归档在手持档不做进程内解包（execve 被拒）；git=SKIPPED');
    }
    /*
     * 【额外 root 必须显式交代（2026-11-02 移动端复测 P1）】
     * 手持档 spawn 被拒 ⇒ 走进程内回退；而回退只解 python。tmux/gh/npm/pnpm 四个 root
     * 因此**留空**，旧实现连一行日志都没有 —— 复测报告把这读成"解包器坏了"
     * （`ghroot/tmuxroot/npmroot/pnpmroot` 全空、`.extract.log` 0 字节）。
     * 真相是"本档不能创建进程，工具解出来也 exec 不了"，但**沉默就是缺陷**。
     * 这里逐 root 说明状态，让日志自己把结论讲清楚。
     */
    /*
     * ── 进程内解包 EXTRA_TOOLCHAINS（2026-11-04，手机端工具链落地）───────────────
     *
     * 【旧口径为什么错了】旧实现认为"本档不能创建进程 ⇒ 解出来也无法 exec ⇒ 干脆不解"。
     * 这条对 **tmux/gh** 成立（它们是真 ELF，手机档 execve 被拒），
     * 但对 **npm/pnpm** 完全不成立：它们是**纯 JS**（`bin/pnpm.cjs` / `bin/npm-cli.js`），
     * 只要能起一个 node 就能跑。而 node 我们已经有了（随包 libnode + ELF 启动器，
     * 见 installElfLaunchers）⇒ 只要把 tar.gz **在进程内解出来**，`pnpm add` 就能用。
     *
     * 所以这里改成：把这些归档在本次回退里**逐个进程内解包**（纯 JS 的 tarGz 抽取器，
     * 不创建任何子进程），解完再走收尾。tmux/gh 解出来照样跑不了（execve 拒），
     * 但代价只是磁盘；留着也有价值：PC 换机/迁移同样的树可直接用，且行为一致，
     * 不再出现"同一棵树在 PC 上有、手机上没有"的三端差异。
     */
    const jobs = toolchainExtraJobs(resRoot);
    if (jobs.length === 0) {
      diag(`工具链：进程内回退无事可做（python 无需解包，且没有额外归档；原因=${why}）`);
      finishToolchainExtraction(false, false, needGit);
      return;
    }
    diag(`工具链：进程内回退开始解 ${jobs.length} 个额外归档（${why}）`);
    return await (async () => {
      let okCount = 0;
      for (const job of jobs) {
        try {
          await extractExtra(job);
          okCount += 1;
          diag(`工具链：进程内解包 ${job.name}/${path.basename(job.archive)} → ${job.root} 完成`);
        } catch (e) {
          diag(`工具链：进程内解包失败 ${job.name}/${path.basename(job.archive)}：`
            + String(e && e.message ? e.message : e));
        }
      }
      report(`工具链：进程内回退收尾（成功 ${okCount}/${jobs.length}）`);
      if (okCount === jobs.length) publishExtras();
      finishToolchainExtraction(false, false, needGit, okCount === jobs.length);
    })();
  }
  /*
   * 【python 要解时，额外 root **同样要解**（2026-11-05 手机端复测 P0）】
   * 旧实现把"解 python"和"解 EXTRA_TOOLCHAINS"写成了互斥的两条分支：
   * 命中 python 分支就直接 return，于是真机上 `python` 有 3560 个条目、
   * 而 `bashroot/ghroot/npmroot/pnpmroot/tmuxroot` **全空**、`.extract.log` 0 字节。
   * 现在两条都走：先解额外归档，再解 python，最后一次收尾。
   */
  const jobs = toolchainExtraJobs(resRoot);
  const extractExtras = async () => {
    let okCount = 0;
    for (const job of jobs) {
      try {
        await extractExtra(job);
        okCount += 1;
        diag(`工具链：进程内解包 ${job.name}/${path.basename(job.archive)} → ${job.root} 完成`);
      } catch (e) {
        diag(`工具链：进程内解包失败 ${job.name}/${path.basename(job.archive)}：`
          + String(e && e.message ? e.message : e));
      }
    }
    if (jobs.length > 0) {
      report(`工具链：额外归档解包收尾（成功 ${okCount}/${jobs.length}）`);
    }
    if (okCount === jobs.length) {
      try { publishExtras(); } catch (error) {
        report('toolchain extras publish failed: ' + String(error));
        return false;
      }
    }
    return okCount === jobs.length;
  };
  const pyStage = path.join(TOOLCHAIN_DIR, 'py-stage');
  diag(`工具链：改用进程内解包（${why} ⇒ 本档不能创建进程；额外归档 ${jobs.length} 个）`);
  let extrasOk = false;
  return await extractExtras().then((ok) => {
    extrasOk = ok;
    return tarGz.extractTarGzFile(tarball, pyStage, {
    yieldEvery: 16,
    maxOutputLength: 256 * 1024 * 1024,
    onProgress: (n) => {
      if (n % 512 === 0) {
        diag(`工具链：进程内解包进行中（已落 ${n} 个条目）`);
      }
    },
  }); }).then((st) => {
    diag(`工具链：进程内解包完成（写 ${st.written} 个文件，跳过 ${st.skipped.length} 个链接/特殊条目）`);
    if (needGit) {
      diag('工具链：git 归档在手持档不做进程内解包（execve 被拒）；git=SKIPPED');
    }
    /*
     * 第三个参数 = "git 是**跳过**而不是失败"：python 解完了（didPy=true）、git 没解（didGit=false），
     * 而 needGit 说明**本该解** ⇒ 交给收尾按 SKIPPED 记账（不是 FAIL）。
     */
    finishToolchainExtraction(true, false, needGit, true, extrasOk);
  }).catch((e) => {
    report(`工具链：进程内解包失败（下次启动重试）：${String(e).slice(0, 300)}`);
  });
  } catch (error) {
    report('toolchain fallback failed: ' + String(error));
  } finally {
    inProcessToolchainFallback.running = false;
  }
}

/**
 * 解包收尾（子进程 exit 回调，同步轻量）：rename 归位、symlink 复制补齐、
 * chmod+X_OK、锚点复验。失败不重试——幂等设计下次 Host 启动自动重试。
 *
 * @param {boolean} didPy 本轮是否解了 python
 * @param {boolean} didGit 本轮是否解了 git
 * @param {boolean} [gitSkipped=false] git 是**跳过**（手持档结构性不适用）而不是失败 ⇒ 收尾记 SKIPPED
 */
/**
 * 手机端 Python 预设包（2026-11-24）：把 pptx/lxml/Pillow/yaml/openpyxl 等预装包
 * 解到 `$DSHM_SANDBOX_HOME/py-site`，让不能 exec / 不想等 pip 的设备开箱可用。
 *
 * 规则：
 *  - 只在 py-site **不存在或为空** 时解，避免覆盖用户 pip 装的版本；
 *  - 解包失败只记日志，不影响 Python 本体（用户仍可 pip 安装）；
 *  - 预设内的 .so 在构建时已自签名（端侧 dlopen 要求）。
 */
function ensurePythonSitePreset() {
  const home = process.env.DSHM_SANDBOX_HOME || process.env.HOME || '';
  if (!home) {
    return;
  }
  const site = path.join(home, 'py-site');
  const marker = path.join(site, '.dshm-preset.json');
  const preset = path.join(RES_ROOT, 'toolchain', 'python', 'dshm-pysite.tar.gz');
  if (!fs.existsSync(preset)) {
    return;
  }
  let existing = [];
  try {
    existing = fs.existsSync(site) ? fs.readdirSync(site).filter((n) => n !== '.dshm-preset.json') : [];
  } catch (e) {
    existing = [];
  }
  if (existing.length > 0) {
    return;
  }
  const stage = site + '.preset-' + Date.now();
  try {
    fs.mkdirSync(stage, { recursive: true });
  } catch (e) {
    diag(`python 预设：创建暂存目录失败：${String(e)}`);
    return;
  }
  tarGz.extractTarGzFile(preset, stage, {
    stripPrefixes: ['site'],
    yieldEvery: 16,
    maxOutputLength: 512 * 1024 * 1024,
  }).then(() => {
    try {
      if (fs.existsSync(site)) {
        fs.rmdirSync(site);
      }
      fs.renameSync(stage, site);
      fs.writeFileSync(marker, JSON.stringify({ preset: 'dshm-pysite', at: new Date().toISOString() }));
      diag('python 预设：已解包到 py-site');
    } catch (e) {
      diag(`python 预设：归位失败：${String(e)}`);
    }
  }).catch((e) => {
    diag(`python 预设：解包失败：${String(e).slice(0, 200)}`);
    try {
      fs.rmSync(stage, { recursive: true, force: true });
    } catch (_e) { /* 清理失败忽略 */ }
  });
}

function finishToolchainExtraction(didPy, didGit, gitSkipped = false, childOk = true, extrasOk = childOk) {
  /*
   * 【P0-1 注意 2（2026-11-11）：非 0 退出不做收尾】tar 半途失败时目录"非空"但内容
   * 残缺。若照样 rename + 写签名标记，下一轮 `needsReextractForSign` 会判"已换代完成"，
   * 于是**永远不再重试** —— 那比每次重解更糟。这里直接放弃本轮收尾，留给下次启动。
   */
  if (!childOk) {
    diag('工具链：解包子进程非 0 退出 ⇒ 本轮不归位、不写签名标记（下次启动重试）');
    return;
  }
  if (didPy) {
    const backup = PYTHON_PREFIX + '.previous-' + Date.now();
    let backedUp = false;
    try {
      if (fs.existsSync(PYTHON_PREFIX)) {
        fs.renameSync(PYTHON_PREFIX, backup);
        backedUp = true;
      }
      fs.renameSync(path.join(TOOLCHAIN_DIR, 'py-stage', 'python'), PYTHON_PREFIX);
      fs.rmSync(path.join(TOOLCHAIN_DIR, 'py-stage'), { recursive: true, force: true });
      /*
       * pip 装进来的 .so 在端侧 dlopen 需要 .codesign（用户目录/沙盒都不放行未签名 ELF）。
       * 把自签名工具随 python 前缀投放，pip wrapper 安装完就地签名。失败只记日志：
       * 签名缺失只会让带 C 扩展的包 import 失败，不影响纯 Python 包。
       */
      try {
        fs.copyFileSync(path.join(RES_ROOT, 'toolchain', 'python', 'selfsign.js'),
          path.join(PYTHON_PREFIX, 'selfsign.js'));
      } catch (e) {
        diag(`工具链：selfsign.js 投放失败：${String(e)}`);
      }
    } catch (e) {
      if (backedUp && !fs.existsSync(PYTHON_PREFIX)) fs.renameSync(backup, PYTHON_PREFIX);
      diag(`工具链：python 收尾失败：${String(e)}`);
      return;
    }
    /* 与 publishExtras 同口径：只清空的 .previous-<ts> 空壳。 */
    pruneEmptyPreviousSiblings(PYTHON_PREFIX);
    ensurePythonSitePreset();
    /*
     * 解包延后到 READY 之后，`startupWork` 里那次 `python` 任务可能因 pythonReady=false
     * 被跳过；解包完成后在这里补挂一次（幂等，失败只记日志）。
     */
    try {
      ensurePythonBridge();
    } catch (e) {
      diag(`工具链：解包后补挂 Python 桥失败：${String(e)}`);
    }
    try {
      startupWork.activity();
    } catch (e) { /* 调度器未就绪不影响解包结果 */ }
  }
  /*
   * 【把签名版本标记落到解包目录（报告 4 ③）】needsReextractForSign 比对的是
   * "归档标记 vs 解包目录标记"，所以解包成功后**必须把归档那份标记也写过去**；
   * 否则下一轮启动会再次判定"换代了" → 每启动一次重解一遍 27MB/4530 文件。
   * 该标记文件不参与任何功能判据，纯粹是版本号。
   *
   * 【2026-11-10：必须覆盖 EXTRA_TOOLCHAINS】原来的清单只有 python / git 两组，
   * 而 `needsReextractForSign()` 在 extras 上也会被调用（见 scheduleToolchainExtraction）。
   * 两边不对称 ⇒ extras 的标记永远写不出去 ⇒ 每次冷启动都判"归档已换代" ⇒
   * `rm -rf` 后重解 5 个 root 共 15 个归档（约 25 MB 压缩 / 93 MB 落盘，真机实测
   * 5.9~8.0 s/次），日志里每次都是「tmux/gh/bash/npm/pnpm 归档已换代」。
   * 这不是 1.1.8 引入的回归（1.1.7 的宿主同一段代码也一样），而是两个版本共有的缺陷。
   * 现在 extras 与 python/git 走同一张表。
   *
   * 【为什么 extras 用 extraReady 判据、而不是"目录非空"】半成品目录（tar 中途失败）
   * 也是"非空"。若此时就写标记，下一轮 `needsReextractForSign` 会判"已换代完成"，
   * 于是**永远不再重试**——那是比每次重解更糟的静默坏态。所以只有**探针真身真的在**
   * 才写标记；没解成就留空，下次启动继续重试（与 python/git 的锚点判据同一口径）。
   */
  try {
    const resRootForMarker = RES_ROOT;
    const pairs = [
      ...(didPy ? [[path.join(resRootForMarker, 'toolchain', 'python'), PYTHON_PREFIX]] : []),
      ...(didGit ? [[path.join(resRootForMarker, 'toolchain', 'git'), GIT_ROOT]] : []),
    ];
    for (const spec of EXTRA_TOOLCHAINS) {
      if (!extrasOk || !extraReady(spec)) {
        continue;
      }
      pairs.push([path.join(resRootForMarker, 'toolchain', spec.name), spec.root]);
    }
    for (const [archiveDir, extractedDir] of pairs) {
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
  /*
   * 【git 三态：OK / SKIPPED / FAIL（2026-10-19 分诊 S-15）】
   *   · OK      = 真解出来了（PC/2in1 的 spawn 路径，或上一轮已经就位）；
   *   · SKIPPED = **本档结构性不适用**：handheld 的 execve 被拒 ⇒ git 本来就不该解；
   *   · FAIL    = 本该解而没解开（真正的失败）。
   * 旧实现只有二态 ⇒ 手持档每次 boot 都写 `git=FAIL`（分诊 11/11 boot），把"设计如此"
   * 读成了"解包坏了"，还顺手把 `ensureExecutables()` 挡掉（见下方 pyOk 条件）。
   */
  const gitState = (didGit || gitOk) ? 'OK' : (gitSkipped ? 'SKIPPED' : 'FAIL');
  diag(`工具链：解包收尾 python=${pyOk ? 'OK' : 'FAIL'}，git=${gitState}`
    + `${gitState === 'SKIPPED' ? '（手持档 execve 被拒；git 仅 PC 档可用）' : ''}（详见 .extract.log）`);
  log(`工具链：python=${pyOk ? '就绪' : '未就绪'}，git=${gitState === 'OK' ? '就绪' : (gitState === 'SKIPPED' ? '本档跳过' : '未就绪')}`);
  // 刚解包完的文件全部由 tar 子进程创建（执行许可被拒的场景，见 probeExec 注释）：
  // 宿主 Node 立刻做一轮真探测+重写，别等下一次 boot。
  /*
   * 【条件从 `pyOk && gitOk` 收成 `pyOk`】git 缺失（手持档 SKIPPED / PC 档真失败）都不该
   * 挡住 **python** 的 chmod / 探测兜底：这两件事本来就互不相干，旧条件让手持档连 python
   * 的兜底都不跑（分诊 S-15 的第二半）。
   */
  if (pyOk) {
    startupWork.request('exec', ensureExecutables);
  }
  // stdlib 刚就位：补跑 python 桥自检（只依赖 python，git 解包失败不影响桥）
  if (pyOk) {
    startupWork.request('python', ensurePythonBridge, pythonReady);
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
  /* 最后一步：把 node/npm/npx/pnpm/dsh 覆盖成 ELF 启动器（手机档唯一能跑的形态）。 */
  installElfLaunchers(binDir, resRoot);
  /*
   * 【P0-2（docs/267）】PATH 上的 `node` 必须真能跑。
   * 完整 Node 由 ArkTS 侧认领到 `Download/<包名>/node-brew`（env DSHM_PUBLIC_DOWNLOAD
   * 就是那个目录）；空串时保持旧行为，包装器仍走随包 nodecli。
   */
  const FULL_NODE_PATH = (() => {
    const root = (process.env.DSHM_PUBLIC_DOWNLOAD || '').trim();
    return root.length > 0 ? path.join(root, 'node-brew') : '';
  })();
  const bundledNodeCli = nodeRuntimeProvision.ensureBundledNodeCli({
    binDir,
    resRoot,
    nativeLibs: NATIVE_LIBS,
    fullNode: FULL_NODE_PATH,
    log,
    diag,
  });
  NODE_CLI_STATUS = bundledNodeCli;
  if (bundledNodeCli.ready) {
    process.env.DSH_NODE = bundledNodeCli.file;
    process.env.DSH_DESKTOP_NODE_EXECUTABLE = bundledNodeCli.file;
  }
  /*
   * 【node 也必须留在 ELF 形态（2026-11-05 PC 复测 P0）】
   * `ensureBundledNodeCli()` 会在 `bin/node` 写一个**脚本包装器**，而它跑在上面那次
   * `installElfLaunchers()` **之后** ⇒ 每次启动都把刚换好的 ELF `node` 又覆盖回 1132 B
   * 脚本，v10 的五件套永远差这一件（真机读数：npm/npx/pnpm/dsh 都 52120 ELF，只 node 是脚本）。
   * 这里在包装器落盘后**再装一次**启动器，把 node 也换成 ELF；`DSH_NODE` 仍指向
   * `bin/node`（路径不变，只是内容从脚本变 ELF），子进程 Node 走随包 libnode（JIT 可用）。
   */
  installElfLaunchers(binDir, resRoot);
  /*
   * Codex 子智能体 CODEX_HOME 启动期自愈（P0-2，docs/267）
   *
   * 【为什么需要第二次兜底】安装器打补丁时已补 mkdir（对**新装**生效）；但设备上
   * **已经装好**的 subagent-codex 不会自动重装 ⇒ 补丁不刷新、`$HOME/.codex` 仍缺，
   * Codex 每次启动都报 "CODEX_HOME ... does not exist"，登录态/CA/历史全落空。
   * 这里每启动检查一次：插件在 ⇒ 建目录（recursive + 幂等，已存在则跳过）。
   */
  try {
    const codexProfileDir = path.join(HOME_DIR, 'profiles', PROFILE);
    const codexPluginManifest = path.join(codexProfileDir, 'node_modules',
      '@deepseek-ai', 'dsh-subagent-codex', 'package.json');
    if (fs.existsSync(codexPluginManifest)) {
      const codexHome = path.join(SANDBOX_HOME, '.codex');
      if (!fs.existsSync(codexHome)) {
        fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
        log(`Codex CODEX_HOME 已自愈：${codexHome}`);
      }
    }
  } catch (e) {
    diag(`Codex CODEX_HOME 自愈失败：${e && e.message ? e.message : e}`);
  }
  const bundledFfmpeg = ffmpegRuntimeProvision.ensureBundledFfmpeg({
    resRoot: process.env.DSHM_PC_RESFILE_DIR || '',
    sandboxHome: SANDBOX_HOME,
    binDir,
    nativeLibs: NATIVE_LIBS,
    deviceForm: process.env.DSHM_DEVICE_FORM || '',
    log,
    diag,
  });
  if (bundledFfmpeg.ready) {
    process.env.FFMPEG = bundledFfmpeg.ffmpeg;
    process.env.FFPROBE = bundledFfmpeg.ffprobe;
    diag(`ffmpeg 环境：FFMPEG=${bundledFfmpeg.ffmpeg} FFPROBE=${bundledFfmpeg.ffprobe}`);
  } else if (bundledFfmpeg.warning.length > 0) {
    diag(`ffmpeg 环境：${bundledFfmpeg.warning}`);
  }
  ensureRipgrepWrapper(binDir);
  // 【报告 3 ③】core 树解包不保留权限位 ⇒ rg/sharp 的 .node 需要补 x 位
  ensureCoreExecBits();
  /*
   * 【启动提速 2026-11-25：借 WorkBuddy 的顺序】它先 await whenReady + 建窗口，
   * 重活（bootstrap/migration）放到窗口之后；我们对应地**不再在 BOOT_10 之前**
   * 启动 26MB Python 归档 + 25MB extras 的解包（会与核心树装载抢 IO）。
   * 改为挂到 startupWork：READY 之后静默 3s 再跑。稳态 boot 无解包，行为不变；
   * 首启期间 python3/bash 可能短暂报「稍后重试」，解包完成后自动补挂桥。
   */
  startupWork.request('toolchain', () => scheduleToolchainExtraction(resRoot, binDir, true));
  ensureBundledSkills(resRoot);
  // hmfs"执行许可绑创建者"（见 probeExec 注释）：锚点齐备后异步真探测+修复
  startupWork.request('exec', ensureExecutables);
  // 内嵌 Python 桥自检（stdlib 未就位时内部跳过，解包收尾后由第二挂载点补跑）
  startupWork.request('python', ensurePythonBridge, pythonReady);
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
/**
 * 清理孤儿写锁（`<file>.lock`）。
 *
 * 【2026-11-26 改成"启动快扫 + 就绪后补齐"】原实现在 runProfile **之前**同步走完，
 * 上限 2 万次 `readdirSync`（跳过 node_modules、深度 3）。慢存储上这段是纯同步阻塞，
 * 属于"启动期无意义停顿"之一。
 * 现在：启动路径只给 `budget` 较小的快扫（覆盖绝大多数孤儿锁），
 * 完整巡检推迟到 host-ready 之后执行（幂等：已清理的不会重复删，活跃锁仍按 pid 判据保留）。
 *
 * @param homeDir 扫描根
 * @param budget 本次最多访问的目录项数（默认 20000）
 */
function recoverOrphanLocks(homeDir, budget = 20000) {
  if (homeDir.length === 0) {
    return;
  }
  const locks = [];
  let visited = 0;
  const walk = (dir, depth) => {
    if (depth > 3 || locks.length >= 200 || visited >= budget) {
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
  /*
   * 【保留原因要可读（2026-10-07）】PC 报告里那条读数「发现 21 个，清理孤儿 0」只能看出
   * 「没删」，看不出**为什么没删** —— 而这恰恰是下一步定策略的唯一信息。三种成因的含义
   * 完全不同：
   *   · `存活`：确实还有活着的持有者（正常，本就不该删）；
   *   · `EPERM(异uid)`：pid 存在但**不属于本应用** —— 鸿蒙的 pid 回收很快，这通常意味着
   *     「记录的 pid 已被无关进程占用」，即原持有者早已消失（形态上就是孤儿）；
   *   · `非pid` / `不可读`：文件不是上游那种 `<pid>\n` 记录（不该动）。
   * 故本轮**只加读数、不改策略**：判据仍是「少删」，先把事实取回来再决定要不要收。
   * 按类计数而不是逐条打，是因为真实条数可达 walk 上限 200，逐条会淹掉日志。
   */
  const keptWhy = new Map();
  const keptSample = [];
  const noteKept = (why, lock, owner) => {
    kept++;
    keptWhy.set(why, (keptWhy.get(why) || 0) + 1);
    if (keptSample.length < 6) {
      let age = '?';
      try {
        age = `${Math.round((Date.now() - fs.statSync(lock).mtimeMs) / 1000)}s`;
      } catch (e) { /* 读不到年龄就留 ? */ }
      keptSample.push(`${path.basename(lock)}(pid=${owner || '未知'}，${why}，age=${age})`);
    }
  };
  for (const lock of locks) {
    let ownerText = '';
    try {
      ownerText = fs.readFileSync(lock, 'utf8');
    } catch (e) {
      noteKept('不可读', lock, 0);
      continue;
    }
    const owner = Number.parseInt(ownerText.trim(), 10);
    if (!Number.isInteger(owner) || owner <= 0) {
      noteKept('非pid', lock, 0);
      continue;
    }
    if (owner === process.pid) {
      noteKept('本进程', lock, owner);
      continue;
    }
    let alive = true;
    let eperm = false;
    try {
      process.kill(owner, 0);
    } catch (e) {
      // ESRCH = 没有这个进程；EPERM = 进程存在但不属于我们（仍算存活）
      eperm = !!(e && e.code === 'EPERM');
      alive = eperm;
    }
    if (alive) {
      noteKept(eperm ? 'EPERM(异uid)' : '存活', lock, owner);
      continue;
    }
    try {
      fs.rmSync(lock, { force: true });
      removed++;
      diag(`孤儿写锁已清理：${lock}（持有者 pid=${owner} 已不存在）`);
    } catch (e) {
      noteKept('删除失败', lock, owner);
    }
  }
  diag(`写锁巡检：发现 ${locks.length} 个，清理孤儿 ${removed} 个，保留 ${kept} 个`);
  /*
   * 【明细必须在这行之后】真机取证按「写锁巡检」这一行当「本次启动」的起点
   * （取最后一次出现之后的所有行）⇒ 把明细放在它前面会被切掉。
   */
  if (kept > 0) {
    const byWhy = Array.from(keptWhy.entries()).map(([why, n]) => `${why}=${n}`).join('，');
    diag(`写锁保留明细：${byWhy}；样例 ${keptSample.join(' | ')}`);
  }
}

/** 完整孤儿锁巡检是否已排过后台补齐（只排一次，见 recoverOrphanLocks 注释）。 */
let dshmLockSweepScheduled = false;

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
  /*
   * 【缺种子时回落到 ondevice（2026-11-02，docs/348 §0 根因）】
   * 核心树只随包 `profiles/ondevice`；而 superagent 这类**独立 profile** 是由
   * `dsh <name> --from-default-profile` 建在 `$DSH_HOME/profiles/<name>` 的。
   * 旧实现直接 `fail('核心树里没有 profiles/<name>')` ⇒ 第二进程一启动就在
   * BOOT_20_CORE_FOUND fatal，界面表现为"一个卡住的空窗口"。
   *
   * 现在：核心树缺该 profile 的种子时，用 `ondevice` 的种子兜底，并把
   * package.json 里的 `name` 改成本 profile —— 组合逻辑与 ondevice 完全一致，
   * 用户/插件行仍各自独立（它们在 `$DSH_HOME/profiles/<name>` 下）。
   */
  let src = path.join(CORE_DIR, 'profiles', PROFILE);
  let seedFromOnDevice = false;
  if (!fs.existsSync(src)) {
    const fallback = path.join(CORE_DIR, 'profiles', 'ondevice');
    if (fs.existsSync(fallback)) {
      diag(`profile 种子：核心树无 profiles/${PROFILE}，回落用 ondevice 作种子`
        + '（docs/348：superagent 由 --from-default-profile 建在 DSH_HOME，不在核心树里）');
      src = fallback;
      seedFromOnDevice = true;
    } else {
      fail('核心树里既没有 profiles/' + PROFILE + '，也没有 profiles/ondevice');
    }
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
    if (seedFromOnDevice) {
      /* 种子来自 ondevice ⇒ 把 name 改成本 profile，避免 dsh 把它当成 ondevice */
      try {
        const pkg = JSON.parse(fs.readFileSync(destPkg, 'utf8'));
        pkg.name = PROFILE;
        fs.writeFileSync(destPkg, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      } catch (e) {
        diag(`profile 种子：改写 name 失败（不影响启动）：${String(e)}`);
      }
    }
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
  // seedBundles 供 start() 在 profile boot 前生成"用户 bundle 延迟清单"用
  // （判断哪些 bundle 是用户装的、哪些是核心自带的）。
  return { dir: dest, seedBundles };
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

/*
 * ── 启动种子导出（2026-11-16，出包流程用）───────────────────────────────────
 *
 * 【这是什么】把本进程两份已落盘的启动缓存导出到用户可见的 Download 目录，
 * 供出包流程采集成随包 `boot-seed/`（装载器见 ./boot-seed.cjs；导出与装载
 * 合起来闭环：导出采集 → 随包预置 → 下次全新安装首启命中）。
 *
 * 【为什么必须由应用自己导】编译缓存 blob 的文件名是源码绝对路径的哈希
 * （compile_cache.cc GetOrInsert），只有应用域里跑出来的 blob 才能在下一次
 * 应用启动时命中；而应用数据目录对外不可读（el2 blob 0600 / home 0700，
 * 2026-11-16 实测 shell/ide 两个域都读不了）⇒ 唯一出口是应用自己往
 * `DSHM_PUBLIC_DOWNLOAD`（用户可见目录，ArkTS 侧认领、模式 0755）拷贝。
 *
 * 【触发】`$DSHM_PUBLIC_DOWNLOAD/.dshm-seed-export-request` 存在（开发流程
 * 手工放置的空文件）。普通用户永远不会有这个文件 ⇒ 零感知。导出成功后
 * 自删该文件（幂等：要再导再放）；失败保留、下次启动重试。
 *
 * 【导出内容】（对应 boot-seed.cjs 期望的种子目录形态）
 *   · resolve-cache-*.json                    —— HOME 里全部解析缓存表
 *     （键值为核心树相对路径，跨设备可移植；含用户运行后累积的插件条目）
 *   · v8-compile-cache/<ns>/<8位hex>          —— 编译缓存 blob 原样拷贝
 *     （ns 目录名带导出进程 uid；装载器按目标 uid 重算，照抄即可）
 *   · manifest.json                           —— ns/计数/版本，供采集脚本核对
 *
 * 【边界】只在 markReady 之后被 setTimeout 延迟调用（不占启动临界路径）；
 * 任何失败只记 diag、绝不抛出；目录先清后建（重放安全，删除范围限定在
 * `$DSHM_PUBLIC_DOWNLOAD/boot-seed-export` 这一个应用自建目录内）。
 */
function maybeExportBootSeed(opts) {
  const o = opts || {};
  const homeDir = String(o.homeDir || '');
  const log = typeof o.log === 'function' ? o.log : null;
  const pub = String(process.env.DSHM_PUBLIC_DOWNLOAD || '').trim();
  if (pub.length === 0) {
    return;
  }
  const reqFile = path.join(pub, '.dshm-seed-export-request');
  try {
    fs.statSync(reqFile);
  } catch (e) {
    return; /* 无请求文件：常态，直接回 */
  }
  try {
    const outRoot = path.join(pub, 'boot-seed-export');
    fs.rmSync(outRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(outRoot, 'v8-compile-cache'), { recursive: true });
    let resolveFiles = 0;
    let blobs = 0;
    let nsDirs = 0;
    /* ① 解析缓存表（HOME 里所有 resolve-cache-*.json） */
    if (homeDir.length > 0) {
      try {
        for (const name of fs.readdirSync(homeDir)) {
          if (!/^resolve-cache-.+\.json$/.test(name)) {
            continue;
          }
          fs.copyFileSync(path.join(homeDir, name), path.join(outRoot, name));
          resolveFiles += 1;
        }
      } catch (e) { /* HOME 读失败：留空，其余照导 */ }
    }
    /* ② 编译缓存 blob（getCompileCacheDir 返回**带 tag 的 ns 目录**本身——
       fork compile_cache.cc:550 compile_cache_dir_ = base + '/' + cache_tag；
       ns 目录名形如 v24.9.0-arm64-<hash>-<本进程uid>，blob 名 = 8 位小写 hex） */
    let cacheNsDir = '';
    try {
      const nodeModule = require('node:module');
      if (typeof nodeModule.getCompileCacheDir === 'function') {
        cacheNsDir = String(nodeModule.getCompileCacheDir() || '');
      }
    } catch (e) {
      cacheNsDir = '';
    }
    if (cacheNsDir.length > 0) {
      try {
        const nsName = path.basename(cacheNsDir);
        let blobsInNs = 0;
        for (const blob of fs.readdirSync(cacheNsDir)) {
          if (!/^[0-9a-f]{8}$/.test(blob)) {
            continue; /* 标记文件等非 blob 跳过 */
          }
          blobsInNs += 1;
        }
        if (blobsInNs > 0) {
          const dstDir = path.join(outRoot, 'v8-compile-cache', nsName);
          fs.mkdirSync(dstDir, { recursive: true });
          nsDirs += 1;
          for (const blob of fs.readdirSync(cacheNsDir)) {
            if (!/^[0-9a-f]{8}$/.test(blob)) {
              continue;
            }
            fs.copyFileSync(path.join(cacheNsDir, blob), path.join(dstDir, blob));
            blobs += 1;
          }
        } else if (log) {
          log('种子导出：当前 ns 目录无 blob（' + nsName + '），跳过编译缓存段');
        }
      } catch (e) {
        if (log) {
          log('种子导出：编译缓存读取失败（继续导出其余部分）：'
            + String((e && e.message) || e).slice(0, 120));
        }
      }
    }
    /* ③ manifest（采集脚本核对用；ns 空串 = 解析缓存未启用） */
    const manifest = {
      createdAt: new Date().toISOString(),
      ns: resolveCacheHandle !== null ? resolveCacheHandle.stats.ns : '',
      resolveFiles: resolveFiles,
      nsDirs: nsDirs,
      blobs: blobs,
      nodeVersion: String(process.versions.node || ''),
      abi: String(process.versions.modules || ''),
    };
    fs.writeFileSync(path.join(outRoot, 'manifest.json'),
      JSON.stringify(manifest, null, 2), 'utf8');
    /* ④ 自删请求文件（只有导出完成才算消费掉这次请求） */
    fs.rmSync(reqFile, { force: true });
    if (log) {
      log('种子导出完成 → ' + path.join(pub, 'boot-seed-export')
        + '（resolve 表 ' + resolveFiles + ' 份 / ns 目录 ' + nsDirs
        + ' 个 / blob ' + blobs + ' 个）');
    }
  } catch (e) {
    if (log) {
      log('种子导出失败（不影响启动，请求文件保留、下次启动重试）：'
        + String((e && e.message) || e).slice(0, 160));
    }
  }
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
  const profileInfo = ensureProfile();
  stage('BOOT_30_PROFILE_READY', `home=${HOME_DIR} profile=${PROFILE}`);

  /*
   * dsh-bili-whale 等插件执行的是独立 `node`，不是 DSHM Host 的内嵌 libnode。
   * 在 profile boot 之前准备并注入 DSH_NODE，插件首次启动自检就能直接通过；
   * 失败只如实记录，不能阻断不依赖 Node CLI 的宿主和插件。
   */
  NODE_CLI_STATUS = nodeRuntimeProvision.ensureForProfile({
    env: process.env,
    homeDir: HOME_DIR,
    profile: PROFILE,
    publicDownload: process.env.DSHM_PUBLIC_DOWNLOAD || '',
  });
  if (NODE_CLI_STATUS.ready) {
    process.env.DSH_NODE = NODE_CLI_STATUS.file;
    process.env.DSH_DESKTOP_NODE_EXECUTABLE = NODE_CLI_STATUS.file;
    diag(`Node CLI（插件）：${NODE_CLI_STATUS.action} ${NODE_CLI_STATUS.file}`
      + ` version=${NODE_CLI_STATUS.version || '?'} source=${NODE_CLI_STATUS.source || '?'}`);
    log(`插件 Node CLI 已就绪：${NODE_CLI_STATUS.file}`);
  } else if (NODE_CLI_STATUS.requested) {
    diag(`Node CLI（插件）：未就绪：${NODE_CLI_STATUS.error}`);
    log(`插件 Node CLI 未就绪：${NODE_CLI_STATUS.error}`);
  } else {
    diag('Node CLI（插件）：当前 profile 无已知 CLI 依赖，跳过准备');
  }

  log('导入 ' + entry);
  const profileBoot = await import(pathToFileURL(entry).href);
  const appBootMod = await import(pathToFileURL(appBoot).href);

  /*
   * 【用户 bundle 延迟挂载（2026-11-26）】必须在 runProfile **之前**执行：
   * 它把用户从插件市场装的 bundle（当前是 dshmarket）移出 `dsh.profile.bundles`，
   * 并生成 `.dshm-deferred-bundles.json`；随后 `dshm-boot-extras` 在壳就绪后按
   * 清单用 `ctx.loader.create()` 挂载。这样 profile boot 只同步加载首屏必需的核心
   * bundle，手机端实测那段（BOOT_45 → SERVER-LISTENING）才是启动的绝对大头。
   *
   * 只用上游 dsh-app-boot 自己的解析器（resolveBundleDir / readProfileManifest /
   * bundlePatchPaths / loadOverlayPatches），不自己猜 YAML；解析失败/非 pure-insert
   * 的 bundle 一律保持原样（宁可少延迟，不能改语义）。失败不阻断启动。
   */
  try {
    deferredBundles.deferUserBundles(profileInfo.dir, {
      appBoot: appBootMod,
      // resolveBundleDir 的 installAnchor = dsh 应用包里的 package.json 路径
      installAnchor: path.join(CORE_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      seedBundles: profileInfo.seedBundles,
      log,
      diag,
    });
  } catch (e) {
    diag('用户插件延迟挂载：生成清单失败（不影响启动，保持同步加载）：'
      + String((e && e.message) || e));
  }

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
  /*
   * 启动路径只做快扫（4000 项）：孤儿锁绝大多数就在 $DSHM_HOME 浅层。
   * 完整巡检由 host-ready 之后的后台任务补齐（见 recoverOrphanLocks 注释）。
   */
  recoverOrphanLocks(HOME_DIR, 4000);
  stage('BOOT_41_LOCKS_READY');
  // 在认证 URL 落盘前准备事实缓存。端侧可以保留 koffi 预热，将仅用于
  // 诊断的图片和 PTY 探测交给工作区加载之后的空闲队列。
  runtimeFacts();
  stage('BOOT_42_NATIVE_READY');
  globalThis.__dshmUpdateTransaction = require('./dshm-update-transaction.cjs').withUpdateTransaction;
  globalThis.__dshmProfileWriter = require('./dshm-profile-writer.cjs').withProfileWriter;
  globalThis.__dshmProfileWriterToken = require('./dshm-profile-writer.cjs').currentToken;
  // dsh-pet 桌面宿主：必须在 runProfile（插件 apply）之前生效，否则插件会去 spawn Electron。
  process.env.DSH_PET_IN_PROCESS = '1';
  process.env.DSH_PET_OPEN_TARGET = process.env.DSH_PET_OPEN_TARGET || 'web';
  const environment = appBootMod.loadLayeredEnv('dsh');
  const refreshSettingsRevisionsOnly = process.env.DSHM_PLATFORM === 'ohos'
    && PROFILE === 'ondevice' && process.env.DSHM_WORKBENCH_STARTUP === '1'
    && process.env.DSHM_DEVICE_FORM === 'desktop';
  if (refreshSettingsRevisionsOnly) {
    globalThis.__dshmStartupSettingsRevisions = true;
  }
  stage('BOOT_45_PROFILE_START');
  const result = await profileBoot.runProfile({
    environment,
    profile: PROFILE,
    patchFiles: [],
    args: args,
  }).finally(() => {
    if (refreshSettingsRevisionsOnly) {
      delete globalThis.__dshmStartupSettingsRevisions;
    }
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
  const browserBridge = browserAutomationEnabled() ? registerBrowserBridge(ctx) : null;
  // 外开桥端点（/dshm-open-link）：browser 工具在"浏览器还没起来"时经它请求 ArkTS 壳层
  // 用 openLink 拉起浏览器（文件队列 → entry/.../system/OpenLinkBridge.ets）。
  // 拉起成功后把 armAutoClose 交给它 —— turn/end 时自动关闭这个"为本次任务开的"浏览器。
  if (browserAutomationEnabled()) {
    registerOpenLinkEndpoint(ctx, browserBridge && browserBridge.armAutoClose);
  }
  // dsh-pet 渲染页同源静态路由（插件未安装时静默跳过）；
  // PetAbility 启动前会预检 /dsh-pet-native，故保留在关键路径。
  petHost.registerPetHost(ctx, HOME_DIR, diag);
  /*
   * 【启动提速 2026-11-21】以下四项不属于首屏关键路径，统一延后到 DSHM_READY 之后的下一 tick：
   *   · card-state 注册时会**同步读**最多 2 万条 card-usage.jsonl（还可能 compact 写回）；
   *   · registry / packages / shot 各自 require 子模块后注册路由，供插件市场 / 桌面卡片使用。
   * 端口绑定与 READY 先发，ArkTS 先加载 Web；页面真正用到这些端点之前（毫秒级）已注册。
   * 失败只 diag，不影响已验证的 web 服务链路。
   */
  const deferRegister = (label, fn) => {
    const run = () => {
      try {
        fn();
      } catch (e) {
        diag('[defer] ' + label + ' 注册失败：' + String(e && e.message ? e.message : e));
      }
    };
    try {
      setTimeout(run, 0);
    } catch (e) {
      run();
    }
  };
  deferRegister('card-state', () => registerCardState(ctx));
  deferRegister('registry-view', () => registerRegistryViewEndpoint(ctx));
  deferRegister('packages-list', () => registerPackageListViewEndpoint(ctx));
  deferRegister('shot-proxy', () => registerShotProxyEndpoint(ctx));
  // 这行是给 ArkTS 侧的机器可读信号：ArkTS 会等到端口可连为止。
  // authUrl 是**冗余通道**：主通道是 host-ready.json（ArkTS 侧按文件读，见 adoptLocalHost）。
  /*
   * 【启动期同步环到此收尾（docs/339）】
   *
   * 【为什么必须放在这里，而不是 writeHostReady 里】`writeHostReady()` 在 `runProfile()`
   * **之前**就会被调用一次（`watchdogAuthUrl` → 早写），日志里能看到那次的
   * 「探针读数已暂存（host-ready.json 仍属于上一次进程 pid=…）」。
   * 若把收尾挂在那里，环会在**插件还没开始装载**时就被卸掉 —— 等于什么都没测到。
   * （这个错我在本轮自查时抓到并改掉了。）
   *
   * 这里是 `runProfile` 已返回、`BOOT_60/62/63/64` 都打完、端口已绑的时刻：
   * 插件图装载完毕，`BOOT_70` 只是自探（自带最长 5s 的等待），不该算进启动。
   */
  try { dshmRingStop('after-profile'); } catch (e) { /* 卸载失败不影响启动 */ }
  console.log('DSHM_READY ' + JSON.stringify({
    port: ctx.webServer.port,
    home: HOME_DIR,
    profile: PROFILE,
    authUrl: readHostReadyUrl(),
  }));
  log('Host 已就绪，端口 ' + ctx.webServer.port);
  scheduleNativeRuntimeFacts(startupWork);
  startupWork.markReady();
  /*
   * 持久解析缓存落盘检查点：到这里模块图已装载完毕（BOOT_50 之后、核心树全部
   * import 已发生），本轮采集的解析结果已完整 —— 现在落一次盘，之后即使进程被
   * 强杀，下次冷启动也有完整表可用。exit 钩子里还有一次兜底落盘。
   */
  try {
    if (resolveCacheHandle !== null) {
      resolveCacheHandle.flush('ready');
    }
  } catch (e) { /* 落盘失败不影响启动；exit 兜底还会再试 */ }
  /*
   * 【模块编译缓存落盘检查点（2026-11-16）】编译缓存的原生落盘点只有
   * AtExit 钩子（compile_cache.cc 的 Enable 注册 AtExit(FlushCompileCache)）与
   * 本 API：fork（libnode.so.137 / node v24.9.0）在 node_modules.cc:648 暴露了
   * 同步的 flushCompileCache（→ env->FlushCompileCache → Persist）。
   *
   * 【为什么必须在 ready 显式 flush】端侧宿主进程是被**杀掉**的（ArkTS 侧无法
   * 请求 Node 干净退出）⇒ AtExit 从不执行 ⇒ 编译缓存从不落盘 —— 设备实测
   * （2026-11-15 夜）：连续三次启动后 v8-compile-cache 的 ns 目录仍是 0 blob，
   * 每次启动都是冷编译（温态 7.4s = 冷编译 + 温解析）。本地此前"温缓存有效"
   * 是 run-boot.sh 走协作式干净退出的假象。
   *
   * 【代价】Persist 只写"本轮编译未命中"的表目（命中不入 pending 表）：
   * 温启动这里是 no-op；首次冷启动会写 ~万级小文件（一次性；且已在 ready
   * 临界路径之外 —— 上方 markReady/DSHM_READY 与端口监听均已完成）。
   * AtExit 钩子保留作干净退出的兜底（双保险；Persist 写完清 pending 表，
   * 两次 flush 不冲突）。老 Node（无该 API）typeof 跳过，行为退回旧状。
   */
  try {
    const nodeModule = require('node:module');
    if (typeof nodeModule.flushCompileCache === 'function') {
      nodeModule.flushCompileCache();
    }
  } catch (e) { /* flush 失败不影响启动；AtExit 兜底 */ }
  /*
   * 种子导出（出包流程）：依赖上方 flush 已把 blob 落盘；setTimeout 延迟 =
   * 不占 ready 临界路径（拷贝万级小文件可能秒级）。触发/边界见函数头注释。
   */
  setTimeout(maybeExportBootSeed, 250, { homeDir: HOME_DIR, log: diag });
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
    startupWork.stop();
    log(`收到停止请求（${reason}），关闭 Host`);
    /*
     * 【取消在飞的 Python 任务（2026-10-19）】旧的"取消"是在 Python 里跑一段
     * `signal.setitimer(ITIMER_REAL, 0)` —— 那只清得掉**还没触发**的定时器，停不掉
     * 正在跑的任务；而且解释器的捕获重定向 / pending alarm / sys.argv 会留给下一个请求。
     * 现在取消 = `worker.terminate()`：整个执行线程连同解释器一起消失，正在跑的 pip
     * 装包随即中止（下一个请求会重建解释器，慢但状态干净）。
     * 这里不 await：停止链不能被它拖住（1.5s 后本来就要 process.exit）。
     */
    try {
      if (pyWorkerBridge !== null) {
        const cancelled = pyWorkerBridge.shutdown(`host-stop：${reason}`);
        if (cancelled > 0) {
          diag(`python worker：停止时取消了 ${cancelled} 个在飞/排队任务（terminate）`);
        }
      }
    } catch (e) {
      diag(`python worker：停止时 terminate 失败（不影响关闭链）：${String(e).slice(0, 160)}`);
    }
    // 【P0-1 / docs/388】关 Host **之前**先让 guest VM 走 QMP `quit` 优雅关机。
    // QEMU 是同进程 worker 线程，直接 `process.exit(0)` 会在 guest 刷盘完成前把它杀掉，
    // 留下半写的 rootfs.qcow2（stage() 只在镜像不存在时重拷 ⇒ 坏镜像跨启动持久化）。
    // 宿主（CommonJS）与插件（ESM）之间没有 import 关系，用进程级 Set 当唯一接线点：
    // 插件在 apply() 里注册 `shutdown()`，宿主在这里取出并**等它 settle**。
    const HOST_STOP_HOOK_TIMEOUT_MS = 10000;
    // 先取钩子（进程级注册表）、再定义收尾函数：源码顺序即执行顺序。
    let hookList = [];
    try {
      const hooks = globalThis.__DSHM_HOST_SHUTDOWN_HOOKS__;
      if (hooks && typeof hooks[Symbol.iterator] === 'function') {
        hookList = Array.from(hooks);
      }
    } catch (e) {
      diag(`关机钩子读取失败（不影响关闭链）：${String(e).slice(0, 160)}`);
    }
    const finishHostStop = () => {
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
    if (hookList.length === 0) {
      log('关机钩子：无注册项（VM 未启用），直接关闭 Host');
      finishHostStop();
      return;
    }
    const jobs = hookList.map((hook) => {
      try {
        return Promise.resolve(hook()).catch((e) => {
          diag(`关机钩子失败（不影响关闭链）：${String(e).slice(0, 160)}`);
        });
      } catch (e) {
        diag(`关机钩子抛错（不影响关闭链）：${String(e).slice(0, 160)}`);
        return Promise.resolve();
      }
    });
    // 双保险：钩子既不 resolve 也不 reject 时，最多等 HOST_STOP_HOOK_TIMEOUT_MS，
    // 然后照常关 Host —— 不允许"停止核心"变成永久挂起。
    let settled = false;
    let guard = null;
    const done = () => {
      if (settled) return;
      settled = true;
      if (guard !== null) clearTimeout(guard);
      finishHostStop();
    };
    guard = setTimeout(done, HOST_STOP_HOOK_TIMEOUT_MS);
    Promise.allSettled(jobs).then(done, done);
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
  // $DSH_HOME/install-queue/<id>.req 写入一行 spec，或官方安装命令
  // （`dsh plugin ... add` / `pnpm add` / `npm install`），
  // Host 轮询到后调 dshm-installer.installSpec（纯 JS 下载+解包+落位+用户行），
  // 结果写回同目录 <id>.done / <id>.fail（JSON）。req 取走即删；结果文件留给
  // 写入方读取后自行清理。重启应用后 composeUserRows 把用户行拼进
  // cordis.patch.yml，插件随 profile 挂载生效。
  const pluginInstaller = require('./dshm-installer.js');
  const { parseInstallCommand } = require('./dshm-install-command.js');
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
        let installSpec = spec;
        let commandProfileDir = '';
        let commandRegistry = '';
        let commandSaveExact = false;
        if (!isRemove) {
          const parsedCommand = parseInstallCommand(spec);
          if (!parsedCommand.ok) {
            fs.writeFileSync(path.join(installQueueDir, base + '.fail'),
              JSON.stringify(parsedCommand, null, 2));
            log(`插件安装命令无效：${parsedCommand.error}（原文：${spec.slice(0, 160)}）`);
            return;
          }
          installSpec = parsedCommand.spec;
          commandRegistry = parsedCommand.registry;
          commandSaveExact = parsedCommand.saveExact;
          if (parsedCommand.dir.length > 0) {
            const profilesRoot = path.resolve(HOME_DIR, 'profiles');
            const relative = path.relative(profilesRoot, parsedCommand.dir);
            if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
              const error = `--dir 必须指向 $DSH_HOME/profiles 下的一个 profile：${parsedCommand.dir}`;
              fs.writeFileSync(path.join(installQueueDir, base + '.fail'),
                JSON.stringify({ ok: false, error }, null, 2));
              log(`插件安装命令无效：${error}`);
              return;
            }
            commandProfileDir = parsedCommand.dir;
          } else if (parsedCommand.profile.length > 0) {
            commandProfileDir = path.join(HOME_DIR, 'profiles', parsedCommand.profile);
          }
          if (reqProfileDir.length > 0 && commandProfileDir.length > 0
            && path.resolve(reqProfileDir) !== path.resolve(commandProfileDir)) {
            const error = `请求目录冲突：队列 .dir=${reqProfileDir}，命令目标=${commandProfileDir}`;
            fs.writeFileSync(path.join(installQueueDir, base + '.fail'),
              JSON.stringify({ ok: false, error }, null, 2));
            log(`插件安装命令无效：${error}`);
            return;
          }
          if (commandProfileDir.length > 0) {
            reqProfileDir = commandProfileDir;
          }
        }
        installBusy = true;
        let result;
        const instOpts = {
          homeDir: HOME_DIR,
          profile: PROFILE,
          log: (m) => log(`  [installer] ${m}`),
        };
        try {
          instOpts.writerToken = fs.readFileSync(path.join(installQueueDir, base + '.writer'), 'utf8').trim();
          fs.unlinkSync(path.join(installQueueDir, base + '.writer'));
        } catch (_) { /* ordinary requests have no transaction ownership */ }
        if (reqProfileDir.length > 0) {
          instOpts.profileDir = reqProfileDir;
        }
        if (commandRegistry.length > 0) {
          instOpts.registry = commandRegistry;
        }
        if (commandSaveExact) {
          instOpts.saveExact = true;
        }
        if (isRemove) {
          log(`插件卸载开始：${spec}（来自 ${reqFile}${reqProfileDir.length > 0 ? ' → ' + reqProfileDir : ''}）`);
          result = await pluginInstaller.removeSpec(spec, instOpts);
        } else {
          log(`插件安装开始：${installSpec}（请求：${spec}；来自 ${reqFile}${reqProfileDir.length > 0 ? ' → ' + reqProfileDir : ''}）`);
          result = await pluginInstaller.installSpec(installSpec, instOpts);
        }
        //  两个市场就地改写的**重放**（2026-10-14 回归修复，见 dshm-market-patch.cjs 头注）：
        //  补丁由核心树 boot 回调在**启动那一刻**贴一次，而市场几乎总是启动之后才装进来的
        //  ⇒ 那次贴了个 ENOENT（真机原话见该文件头注），落盘的市场文件永远是上游原形：
        //  皮肤市场 ⇒ 302 条皮肤里只有 41 条能一键装，其余全部「需手动安装」；
        //  插件市场 ⇒ 卡片缩略图与灯箱都还指着浏览器连不上的图床（空白）。
        //  位置：installSpec 成功之后、`.done` 写出**之前** —— 写入方拿到 `.done` 就可能立刻
        //  挂载，那一刻读到的必须已经是改写过的文件。两个市场都不在这个 profile ⇒ 返回 null，静默。
        if (!isRemove && result.ok) {
          const marketProfileDir = typeof instOpts.profileDir === 'string' && instOpts.profileDir.length > 0
            ? instOpts.profileDir
            : path.join(HOME_DIR, 'profiles', PROFILE);
          const replayed = await marketPatch.replayMarketContractPatch(marketProfileDir, { coreDir: CORE_DIR });
          if (replayed !== null) {
            log(`市场就地改写（装完重放）：${replayed.reason}`);
          }
        }
        fs.writeFileSync(path.join(installQueueDir, base + (result.ok ? '.done' : '.fail')),
          JSON.stringify(result, null, 2));
        if (isRemove) {
          log(`插件卸载${result.ok ? '完成' : '失败'}：${spec}${!result.ok ? `：${result.error}` : (result.note ? `（${result.note}）` : '')}`);
        } else {
          log(`插件安装${result.ok ? '完成' : '失败'}：${installSpec}${result.ok ? `（${result.installed.length} 个包，${result.note}）` : `：${result.error}`}`);
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
  startupWork.stop();
  fail('启动失败：' + (e && e.stack ? e.stack : String(e)));
});
