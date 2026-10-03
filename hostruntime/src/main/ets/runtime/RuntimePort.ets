/**
 * 运行时载体接口（RuntimePort）—— 端侧核心"跑在什么上面"的抽象（D6 §4）。
 *
 * 为什么要有这一层：D6 把运行时分成两阶段——
 *   阶段一（开发期验证通道）：复用 Electron-on-鸿蒙 运行时，只当 Node 用
 *   阶段二（上架形态）：自建 `libnode.so` + NAPI 引导，可 jitless
 * 上层（DshHost / 核心页）**只认本文件**，换载体不动上层。这也是 D6 §4.0 的硬要求：
 * "阶段一的产物不能泄漏到状态层与 UI 层"。
 *
 * 纪律：
 *  1. `probe()` 必须如实报告"没探测到"，不允许用默认值伪装成已探测（`unknownFact` 同源纪律）；
 *  2. `available === false` 时**必须**给出 `note` 说明原因与下一步；
 *  3. 本层不依赖 appstate / UI（分层规则 D1 §10.1；D6 §2）。
 */

/** 运行时载体种类。 */
export enum RuntimeKind {
  /** 还没接任何载体 */
  NONE = 'none',
  /** 阶段一：Electron-on-鸿蒙 运行时（只当 Node 用） */
  ELECTRON_OHOS = 'electron-ohos',
  /** 阶段二：自建 libnode.so + NAPI 引导（上架形态，可 jitless） */
  LIBNODE = 'libnode',
}

/** 一个原生模块的加载事实。 */
export interface NativeFact {
  name: string;
  loaded: boolean;
  note: string;
}

/** 运行时探测结果。字段为空串/undefined 一律表示"未探测"，不要填猜测值。 */
export interface RuntimeProbe {
  kind: RuntimeKind;
  /** 载体是否**已被接线并可尝试启动** */
  available: boolean;
  /** 未接线时的原因与下一步 */
  note: string;
  /** Node 版本（要求 >= 22.17.0）；空串 = 未探测 */
  nodeVersion: string;
  /** process.platform（鸿蒙上应为 openharmony）；空串 = 未探测 */
  platform: string;
  /** node:zlib 的 zstd 能力（会话持久化依赖）；null = 未探测 */
  zstd: boolean | null;
  /** 是否以 jitless 运行（本项目各端统一 jitless，不申请特殊权限）；null = 未探测 */
  jitless: boolean | null;
  /** 三个硬原生依赖的加载事实 */
  natives: NativeFact[];
  /** 实际监听地址（应只有 127.0.0.1）；空串 = 未启动 */
  listenAddress: string;
}

/** 起核心后拿到的句柄。 */
export interface HostHandle {
  port: number;
  /** 客户端可直接用的基址（含 token 时也在这里，交给调用方决定怎么用） */
  url: string;
}

/** 运行时载体接口。 */
export interface RuntimePort {
  kind(): RuntimeKind;

  /** 人类可读的载体名（用于诊断页与核心页） */
  label(): string;

  /** 探测（不启动）。允许开销小；未接线的实现应立刻返回 available=false。 */
  probe(): Promise<RuntimeProbe>;

  /** 启动 Host。coreDir 是某一版核心的根（内含 node_modules 与 profiles/）。 */
  start(coreDir: string, homeDir: string, profile: string): Promise<HostHandle>;

  /** 停止 Host。未启动时应是幂等的 no-op。 */
  stop(): Promise<void>;

  /**
   * Host 是否**正在这个进程里跑**（进程级事实，不是调用方实例的记忆）。
   *
   * 【为什么必须是接口的一部分】端侧只有一个 Node 进程，Host 一起就是全局事实；
   * 但 `DshHost` 是**可多次构造**的（页面每次刷新都 new 一个，见 Index 的 coreHost）。
   * 如果"在跑"这件事只记在实例字段里，那么新构造的实例会报"未启动"，
   * 而真实情况是端口已经在监听——用户看到的就是"端口通了，页面却说没有启动核心"。
   * 载体实现应当问**引导层**（`libdshhost.isHostRunning()`），而不是记自己的账。
   * 未接线的载体如实返回 false。
   */
  isRunning(): boolean;
}

/** 未接线载体的探测结果：**如实**说明"还没接"，并给出下一步。 */
export function notWiredProbe(note: string): RuntimeProbe {
  return {
    kind: RuntimeKind.NONE,
    available: false,
    note: note,
    nodeVersion: '',
    platform: '',
    zstd: null,
    jitless: null,
    natives: [],
    listenAddress: '',
  };
}

// ── Host 启动契约：argv 与 env ──────────────────────────────────────────────
//
// 【为什么要在这里、以纯函数的形式定下来】端侧 Host 的配置通道**是环境变量而不是 argv**：
// `hostcore/app/main.js` 读 DSHM_CORE_DIR / DSHM_HOME / DSHM_SANDBOX_HOME / DSHM_PORT /
// DSHM_PROFILE，而 ArkTS 侧**没有任何办法设置原生进程的环境变量**——只能由引导层
// （`hostruntime/src/main/cpp/dshhost.cc` 的 startHost）在 node::Start 之前 setenv()。
// 于是"该传哪些键、argv 该带什么"就成了两端之间最容易写错、且写错了**不会报错**的接口：
// 键名拼错 → Host 用上默认目录，表面上起来了、实际指向错的 $DSH_HOME。
// 所以这两条契约必须是可单测的纯函数，而不是散在实现里的字符串拼接。

/** 端侧 Host 的回环端口。与 main.js 的 DSHM_PORT 默认值一致，但**显式传**，不依赖默认值。 */
export const HOST_DEFAULT_PORT: number = 3120;

/**
 * `startHost()` 的 argv（**不含 argv[0]**；引导层会补一个 "node"）。
 *
 * `entryScript` 是 Host 入口脚本（main.js）的绝对路径。它**不属于任何一版核心树**：
 * 核心树是可切换/回滚的，而入口脚本随应用发版，两者生命周期不同，混在一起会导致
 * "回滚核心版本把入口脚本也换掉了"。
 */
export function buildHostArgv(entryScript: string): string[] {
  return [
    // **必须**：这是"不申请 ALLOW_WRITABLE_CODE_MEMORY"能成立的前提。
    // 少了它，V8 会在初始化时申请可写可执行内存而被系统拦（D6 §4.4）。
    // 它必须排在脚本路径**之前**：Node 把第一个非选项参数当脚本。
    //
    // 【它是真实选项，不是碰运气透传】D6 E19：Node 自己在
    // `src/node_options.cc` 注册了 `--jitless`（一等 CLI 选项）；V8 侧
    // `flag-definitions.h` 用 `DEFINE_NEG_IMPLICATION(jitless, …)` 关掉
    // turbofan / sparkplug / always_sparkplug / maglev —— 整条 JIT 链。
    //
    // 【代价要写清，别当成免费】同处还隐含 `--no-expose-wasm`：**WebAssembly 会是
    // `undefined`**。因此任何依赖 WASM 的 npm 依赖（纯 JS 包里并不罕见）在端侧会直接
    // 不可用，而且报错形式往往是"某个东西是 undefined"而不是"缺了 WASM"。
    // 这是 jitless 路线已知且接受的代价（换的是不申请特殊权限、可正常上架）。
    '--jitless',
    // 【为什么没有 --no-experimental-fetch】端侧 libnode 已升级到 v24.2.0（libnode.so.137），
    // fetch 在 Node 24 已转正：`--experimental-fetch` 不再是 boolean 选项，`--no-` 否定形态
    // 会让进程死在 CLI 解析（真机实测：`invalid negation because it is not a boolean option`，
    // Host 因此从未启动，见 files/node-output.log）。原 flag 的目的——不装原生 fetch、
    // 避开 undici 的 WASM llhttp——改由运行期垫片兜底：fetch-shim.js 的 installFetchShim()
    // 在 WASM 不可用（jitless 必然如此）时无条件用 node:http/https 垫片覆盖
    // globalThis.fetch。原生 fetch 在 jitless 下反正不可用，覆盖是无损的。
    // 【为什么加它】`session-query-sqlite` 用 `node:sqlite`；Node 22 里该模块需要这个开关
    // 才会被暴露（我们的构建**确实带 SQLite**：版本串里有 `"sqlite":"3.51.3"`）。
    // 不加它，那一行会在 import 期抛 ERR_UNKNOWN_BUILTIN_MODULE —— 与其因此禁掉一个
    // 鸿蒙上**本来能做**的能力，不如把开关打开。
    '--experimental-sqlite',
    // 【为什么加它】0.1.6-alpha.2 的 host preparation（dsh-app-boot 的 internalModules，
    // 经 `node-addon-require-builtin`）要访问 internal 模块做 profile 的 link 解析。
    // 端侧没有该 addon 的 openharmony 平台包，main.js 的 installRequireBuiltinShim()
    // 用纯 JS shim 顶替，shim 的前提就是 `require("internal/…")` 可用——即本开关。
    // 官方桌面端同样开它（apps/desktop/src/host-process.ts 的 spawn 参数第 1 位）。
    // Node 在 node_options.cc 一等注册，无 CLI 解析风险（对照 E68 的教训仍成立）。
    '--expose-internals',
    /*
     * 【绝对不要把 dsh 的应用级选项放进来】这里返回的是交给 `node::Start` 的 **Node 自身 argv**：
     * 任何 Node 不认识的开关都会让进程直接死在 CLI 解析上。实测（E68）：
     *   把 `--trusted-host` 加在这里 ⇒ dsh 侧只有一行 `node: bad option: --trusted-host`，
     *   随后 `启动 Host：ok=false … 3120 端口未应答（Node 线程已经退出）`，
     *   而**上一版是能起来的**。dsh 的 `--port/--host/--no-open/--trusted-host` 一律走
     *   入口脚本里的 `runProfile({ args })`（→ `ctx.cmdlineArgs`），见 hostcore/app/main.js。
     */
    entryScript,
  ];
}

/**
 * `startHost()` 的环境变量，每项是 `KEY=VALUE`。
 *
 * 用"KEY=VALUE"字符串而不是两个平行数组：两端都不必维护下标对应关系，
 * 少一类"键值错位"的错法。
 *
 * 【默认工作区的通道只有一条：`DSHM_PUBLIC_DOWNLOAD`】
 * 它由 ArkTS 侧在 **spawn 之前**认领（`platform` 的 `claimPublicDownloadFolder()`，
 * 值形如 `/storage/Users/currentUser/Download/<包名>`），是 Host 默认工作区的**唯一**
 * 路径来源：Host 只做 `lstat` 判目录 + 真探写，**不再自己 mkdir**（真机实测：应用进程
 * 直拼路径 mkdir 公共目录必 EPERM）。
 * **空串时不写这一项**：Host 会明确回退 `<SANDBOX_HOME>/workspace` 并把原因记进 diag，
 * 绝不允许 cwd 变成 `/` 或空串。
 * 【不要再加第二条"包名"通道】曾经同时传过 `DSHM_BUNDLE`（供 Host 自己拼
 * `$HOME/Download/<包名>/`）。那条路已整条删除：直拼公共路径建目录在端侧必 EPERM，
 * 包名作为**路径来源**只会指向一个不存在、也建不出来的目录。包名现在只用于诊断日志
 * （`NodeRuntime` 构造时打一行），**不参与任何路径解析**；Host 侧的"包名"是
 * `DSHM_PUBLIC_DOWNLOAD` 的末段，需要时从它反推。
 *
 * @param publicDownload ArkTS 侧启动前认领到的公共下载目录；空串 ⇒ 不写这一项
 */
export function buildHostEnv(coreDir: string, homeDir: string, sandboxHome: string,
  port: number, profile: string, publicDownload: string = ''): string[] {
  const env: string[] = [
    `DSHM_CORE_DIR=${coreDir}`,
    `DSHM_HOME=${homeDir}`,
    `DSHM_SANDBOX_HOME=${sandboxHome}`,
    `DSHM_PORT=${port}`,
    `DSHM_PROFILE=${profile}`,
    // 【必须】关掉 libuv 的 io_uring。
    // 真机崩溃日志（D6 E42）：`Reason:Signal:SIGSYS(SYS_SECCOMP) syscall number is 425`，
    // 栈为 `uv_loop_init ← node::tracing::Agent::Agent() ← node::V8Platform::Initialize ← node::Start`。
    // arm64 上系统调用号 425 就是 `io_uring_setup` —— libuv 1.52 在 loop 初始化时会尝试它，
    // 而鸿蒙的 seccomp 策略**直接拒绝并杀掉进程**（不是返回错误码，是 SIGSYS）。
    // libuv 支持用该环境变量禁用这条路径；这是端侧能起来的前提之一。
    'UV_USE_IO_URING=0',
  ];
  // 【为什么只在非空时追加】见上方说明：空值绝不写进去（Host 靠"这一项不存在"来判定回退）。
  if (publicDownload.length > 0) {
    env.push(`DSHM_PUBLIC_DOWNLOAD=${publicDownload}`);
  }
  return env;
}

/**
 * 一条 `KEY=VALUE` 是否合法：必须有 `=`，且键非空。
 *
 * 【为什么要有这个判据】引导层据此决定"跳过并计数"。**不允许静默忽略**：
 * 被忽略的 DSHM_HOME 会让 Host 悄悄用上默认目录，看上去一切正常却写错了地方。
 * 规则只有这一份，C++ 侧（dshhost.cc 的 startHost）按同一规则处理并把条数回报给上层。
 */
export function isWellFormedEnvPair(pair: string): boolean {
  const eq: number = pair.indexOf('=');
  return eq > 0;
}

/**
 * 未接线载体的实现。
 *
 * 它存在的意义不是"占位"，而是让**当前真实状态**（运行时还没接上）在类型系统里成立，
 * 从而核心页与诊断页可以照常渲染"未接线 + 原因 + 下一步"，而不是靠 if 判空。
 */
export class NotWiredRuntime implements RuntimePort {
  private readonly note: string;

  constructor(note: string) {
    this.note = note;
  }

  kind(): RuntimeKind {
    return RuntimeKind.NONE;
  }

  label(): string {
    return '未接线';
  }

  async probe(): Promise<RuntimeProbe> {
    return notWiredProbe(this.note);
  }

  async start(coreDir: string, homeDir: string, profile: string): Promise<HostHandle> {
    throw new Error(`运行时载体尚未接线，无法启动核心（${coreDir} / ${profile}）`);
  }

  async stop(): Promise<void> {
    // 未接线载体没有可停的东西：幂等 no-op
  }

  /** 未接线载体上不可能有 Host 在跑——如实返回 false，不假装。 */
  isRunning(): boolean {
    return false;
  }
}
