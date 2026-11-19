/**
 * libdshhost.so 的 ArkTS 类型声明（NAPI 引导模块）。
 *
 * 实现：`hostruntime/src/main/cpp/dshhost.cc`
 * 构建：`bash tools/node-runtime/build-dshhost.sh`（先用 `--compile-only` 验证 C++）
 *
 * ── 为什么这个文件先于 .so 存在 ──────────────────────────────────────────────
 * 它**不被任何代码引用时是惰性的**：hvigor 只编译 `src/main/ets` 下的源码，
 * 这个 `.d.ts` 躺在 `src/main/cpp/types/` 下不参与编译。所以在 `libdshhost.so`
 * 链接出来之前先放它，是安全的——它让下一步变成机械操作。
 *
 * ── 还差哪两步（**必须等 .so 真的存在**，不要提前做）─────────────────────────
 * 1) 本目录加 `oh-package.json5`：
 *      { "name": "libdshhost.so", "types": "./index.d.ts", "version": "1.0.0" }
 * 2) `entry/oh-package.json5` 的 dependencies 里声明：
 *      "libdshhost.so": "file:./src/main/cpp/types/libdshhost"
 * 提前声明一个**加载不起来**的原生库，会让 ArkTS 侧引用到一个不存在的模块——
 * 那不是编译期错误，而是启动/调用期崩溃，会把当前可用的页面一起弄坏。
 *
 * ── 与 C++ 侧的对应关系（改一边必须改另一边）────────────────────────────────
 * 函数名与返回字段名都是字符串键，**写错不会报错**，只会读到 undefined。
 * 返回对象一律是"当场能给出的结果"，不抛异常：起不来的原因由 `note` 说明。
 */

/** `startHost()` 的结果。 */
export interface StartHostResult {
  /** Node 线程是否已启动。**同一个进程只允许起一次**：第二次为 false 并说明原因 */
  started: boolean;
  /**
   * 可读结论。失败时是真实原因（例如"已经启动过"）；
   * 启动成功但环境变量有条目格式不合法时也会在这里说明。
   */
  note: string;
  /**
   * 实际生效的环境变量条数（`KEY=VALUE` 中键非空的那些）。
   * 格式不合法的条目被**跳过并计数**，不允许静默忽略——被忽略的 `DSHM_HOME`
   * 会让 Host 悄悄用上默认目录：表面上起来了，实际写错了地方。
   */
  envApplied: number;
}

/** `stopHost()` 的结果。 */
export interface StopHostResult {
  ok: boolean;
  note: string;
}

/**
 * 编译进 libnode.so 的 Node 版本。
 * **只要它返回非空，就证明"模块加载成功且与 libnode 链接在一起了"**——
 * 这是"运行时可用"的第一条可观测证据（第二条是 Host 真的起来并监听回环端口）。
 */
export const runtimeVersion: () => string;

/**
 * 在独立线程里跑 `node::Start`（阻塞）。
 *
 * - `argv`：**不含 argv[0]**，引导层会补一个 `"node"`。
 *   用 `hostruntime` 的 `buildHostArgv()` 生成（`--jitless` 必须排在脚本路径之前）。
 * - `envPairs`：每项 `KEY=VALUE`。端侧 Host 的配置通道**是环境变量而不是 argv**
 *   （`hostcore/app/main.js` 读 `DSHM_CORE_DIR`/`DSHM_HOME`/`DSHM_SANDBOX_HOME`/
 *   `DSHM_PORT`/`DSHM_PROFILE`），而 ArkTS **无法设置原生进程的环境变量**，
 *   只能由引导层 `setenv()`。用 `buildHostEnv()` 生成。
 */
export const startHost: (argv: string[], envPairs: string[]) => StartHostResult;

/** Node 线程是否还活着。 */
export const isHostRunning: () => boolean;

/**
 * 停止 Host。
 *
 * **当前如实返回 `ok:false`**：进程内 Node 无法从外部线程安全停止
 * （`node::Start` 阻塞，唯一正路是在 Node 线程内持 `uv_async` 并调用 `node::Stop(env)`）。
 * 假装成功会让上层以为核心停了，而它还在监听回环端口——那比报错更糟。
 */
export const stopHost: () => StopHostResult;
