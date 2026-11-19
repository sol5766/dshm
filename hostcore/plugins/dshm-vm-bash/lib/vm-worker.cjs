'use strict';
/*
 * QEMU 宿主线程（worker_threads）。
 *
 * 【为什么必须是独立线程】`qemu_system_entry()` 是**阻塞直到虚拟机退出**的调用
 * （它自己带主循环）。在主线程上调用 = 整个宿主进程再也回不到事件循环
 * （web 服务/UI/工具全停）。worker 线程是 OS 线程，且本仓已有既成事实：
 * jitless-env 的 `wrapWorkerThreads()` 会给**每个** worker 挂钩 jitless 补齐，
 * main.js 自己的心跳也用 `new Worker(...)` ⇒ worker 路线在本端是已验证能力。
 *
 * 【为什么用 koffi 而不是内嵌 CPython 桥】上一轮 PoC 走的是 ctypes（Python），
 * 它证明的是"这个 .so 能在本进程内被 dlopen + 主循环能跑"；koffi 走的是同一条
 * dlopen/dlsym 路径，但把 VM 的生命周期留在**同一个运行时**里：不依赖 Python
 * stdlib 是否已解包、不经过 HTTP 自环（127.0.0.1:PORT 的 token 取用/失效问题）、
 * 不用把"进程内阻塞"叠加到 captureRun 那条同步 NAPI 上。
 *
 * 【旁挂 .so 的解析】libqemu 对 `libslirp.so.0` 有 DT_NEEDED，而它们在同一个目录。
 * 加载器**不会**自动搜那个目录，但它会先按 soname 在"已加载对象"里找 ⇒ 显式先把
 * 同目录的旁挂 .so 各 dlopen 一次（进全局域），libqemu 的 DT_NEEDED 就能按名命中。
 * 这是第一版失败时唯一的补救手段，所以做成"先直接试，失败再预挂旁挂，再试"。
 */
const { parentPort, workerData } = require('node:worker_threads');
const { readdirSync } = require('node:fs');
const path = require('node:path');

/**
 * 逐步诊断：**回主线程去打印**（不用 worker 自己的 stdout）。
 * 为什么不让 worker 直接 console.log：worker 的 stdout 依赖 `stdout: true` 那条管道，
 * 而宿主侧还有 jitless 补齐/ bootstrap 注入两层改写；postMessage 是与启动握手同一条
 * 已证可用的通道，不会出现「主线程有日志、worker 静默」这种最坏情况。
 * 这些 diag 是 2026-10-08 真机首跑 P0 留下的教训：原生 abort 不给 JS 任何收尾机会，
 * 只有事前逐步留痕才能在事后把失败钉在某一跳上（见 docs/121）。
 */
function diag(message) {
  try {
    parentPort.postMessage({ type: 'diag', message: String(message) });
  } catch {
    /* 诊断失败不影响功能 */
  }
}

/** 把失败信息原样回给主线程（worker 里 throw 只会变成一段难读的 uncaught 文本）。 */
function reportError(error) {
  try {
    parentPort.postMessage({ type: 'error', message: String((error && error.message) || error) });
  } catch (e) {
    /* 连 postMessage 都失败就没办法了 */
  }
}

try {
  const koffi = require('koffi');
  const libPath = workerData.libPath;
  const argv = workerData.argv;

  function loadMain() {
    diag(`koffi.load(${path.basename(libPath)})`);
    const loaded = koffi.load(libPath);
    diag(`koffi.load 成功（${path.basename(libPath)}）`);
    return loaded;
  }

  let lib = null;
  let firstFailure = null;
  try {
    lib = loadMain();
  } catch (error) {
    firstFailure = error;
  }
  if (lib === null) {
    const dir = path.dirname(libPath);
    const self = path.basename(libPath);
    const preloaded = [];
    for (const name of readdirSync(dir)) {
      if (name === self || !/\.so(\.\d+)*$/.test(name)) continue;
      try {
        koffi.load(path.join(dir, name));
        preloaded.push(name);
      } catch (error) {
        preloaded.push(`${name}(失败:${(error && error.message) || error})`);
      }
    }
    parentPort.postMessage({ type: 'preloaded', names: preloaded });
    diag(`直接 dlopen 失败（${(firstFailure && firstFailure.message) || firstFailure}）；已预挂旁挂 .so ${preloaded.length} 项，重试`);
    try {
      lib = loadMain();
    } catch (error) {
      reportError(new Error(`dlopen 失败：${(firstFailure && firstFailure.message) || firstFailure}`
        + ` / 预挂[${preloaded.join(',')}]后仍失败：${(error && error.message) || error}`));
      throw error;
    }
  }

  diag('主库已就绪，开始绑定 qemu_system_entry');
  parentPort.postMessage({ type: 'loaded' });
  // 【签名两种写法都试一次】`char **` 是 koffi 文档里"字符串数组"的标准形式，
  // `const char **` 是 C 侧更准确的写法，但 koffi 的解析器对 const 修饰的处理随版本
  // 而异。这里在**真机之外无法预演**，所以两种都留着 —— 只为消掉一个纯语法层面的
  // 失败面（真机上这一条要么过要么不过，没有中间态）。
  // koffi 对这两种都接受 JS 字符串数组（内部转成连续指针数组）。
  const entry = loadEntry(lib);
  const started = Date.now();
  // 【自证一行：把 `-accel` 那项原样回主线程】本机那把应是 TCI 档的
  // `tcg,thread=multi,tb-size=256`（一个 `split-wx` 都不带）。设备上若打出来的是别的
  // 形态（尤其带 `split-wx` 的 JIT 时代口径），就说明跑的不是本机这份代码
  // （装机/覆盖没生效），而不是"改了没用" —— 省掉一轮无谓的反汇编。
  const accelAt = argv.indexOf('-accel');
  diag(`argv 加速器项：${accelAt >= 0 ? argv[accelAt + 1] : '(缺失)'}`);
  // 【这一行必须是「调用前」的最后一句】下一步是 koffi 的同步调用，它一旦在原生侧
  // abort，后面任何一行（含 postMessage）都不会有机会执行。
  diag(`即将调用 qemu_system_entry（argc=${argv.length}）`);
  parentPort.postMessage({ type: 'entered', argc: argv.length });
  const rc = entry(argv.length, argv);
  // 正常路径：QMP quit 之后返回，线程存活（上一轮 PoC 读到 rc=0）。
  parentPort.postMessage({ type: 'returned', rc, ms: Date.now() - started });
} catch (error) {
  reportError(error);
}
/**
 * 取 `qemu_system_entry` 的函数绑定：先试 `char **`，失败再试 `const char **`。
 * @param lib koffi 的库句柄
 */
function loadEntry(lib) {
  const signatures = [
    'int qemu_system_entry(int argc, char **argv)',
    'int qemu_system_entry(int argc, const char **argv)',
  ];
  const failures = [];
  for (const signature of signatures) {
    try {
      const bound = lib.func(signature);
      diag(`qemu_system_entry 绑定成功：${signature}`);
      return bound;
    } catch (error) {
      const reason = `${signature}: ${(error && error.message) || error}`;
      failures.push(reason);
      diag(`绑定失败：${reason}`);
    }
  }
  throw new Error(`qemu_system_entry 绑定失败：${failures.join(' / ')}`);
}
