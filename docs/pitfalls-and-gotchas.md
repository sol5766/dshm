# BrewDSH 踩坑点总表（HarmonyOS 上跑 dsh 的实测清单）

> 本文是**踩坑点索引**：每条都来自本工程真机实测（设备 MNTXM-24B，HarmonyOS 6 / API 26，2in1）。
> 逐条按「现象 → 根因 → 对策」写，方便直接对照排查。
> 详细过程见 `.agent-rules/bug-log.md`（按时间倒序）与 `docs/device-runtime-fixes.md`。
>
> 一句话总结这个项目的技术底色：**鸿蒙应用沙箱对「执行」和「映射」的限制，决定了 dsh 只能用
> 「dlopen libnode + node::Start + jitless」这一条路跑起来**，其余所有坑几乎都是这条主线的衍生。

---

## 1. 沙箱 / native 加载

### 1.1 只有 el1 bundle 库目录能 dlopen，el2 用户数据区不行
- **现象**：把 `.so`/`.node` 解压到 `<filesDir>`（el2）再 `dlopen` → `ERR_DLOPEN_FAILED: ... Permission denied` /
  `No error information`；`require('*.node')` 同样失败。
- **根因**：沙箱只允许从 **el1 bundle 库目录**（`/data/storage/el1/bundle/libs/arm64`）映射可执行段。
- **对策**：原生库必须随 HAP 打进 `libs/arm64/`（CMake 产出的 `lib*.so` 会被 hvigor 自动打包；
  也可放 `entry/libs/arm64-v8a/`）。运行期用**绝对路径**加载，路径由 native 侧导出（见 1.2）。

### 1.2 宿主模式拿不到 el1 库目录 → pty addon 加载失败
- **现象**：宿主模式终端永远 `pipe`（无 Tab 补全、无行编辑）；内嵌模式正常。
- **根因**：`dshm-terminal` 靠 `/proc/self/maps` 里的 **libnode 映射**推导 el1 库目录；宿主模式跑的是 brew node，
  进程里没有 libnode → 推不出来 → 回退 el2 里的 `vendor/pty_host.node` → 被 1.1 拒绝。
- **对策**：`dsh_host.cpp` 在**父进程**（`InjectBusyboxEnv`）从 maps 解析并导出 `DSHM_LIB_DIR`，
  插件优先用它（`scripts/patch-terminal-pty-host.mjs`）。

### 1.3 链接了 libnode 的 addon 无法被 brew node 加载
- **现象**：宿主模式 `Error loading shared library libnode.so.137 (needed by libpty_host.so)`。
- **根因**：工具链默认 `-Wl,--no-undefined`，N-API 的未定义符号必须先满足，于是 CMake 显式链接了
  `libnode.so.137` → 写进 DT_NEEDED。内嵌模式进程里正好有这份 libnode 所以能加载；brew node 进程里没有。
  往 brew node 里塞内嵌 libnode 更不可取（两份 V8）。
- **对策**：**同一份源码编两个变体**——`pty_host`（链接 libnode，内嵌用）与 `pty_host_napi`
  （不链接 libnode，N-API 符号交给加载它的 node 解析，宿主用）。lld 只有 `--no-undefined` 没有放行开关，
  需从本目录链接参数里把该标志摘掉。插件按候选顺序依次尝试，失败自动下一个，无需判断模式。

### 1.4 不能 execv 用户数据区的可执行文件
- **现象**：`node_shim`（PIE ELF，解压在 el2）`execv` → `EACCES`；`/system/bin/nativespawn` 也不可访问。
- **根因**：沙箱禁止从 el2 用户文件区执行 ELF。
- **对策**：不要把"可执行 node"当方案。内嵌运行时只能「dlopen `libnode.so.137` + 调 `node::Start`」。
  这也是 pnpm 必须走同进程 worker 的根本原因（见 §5）。

### 1.5 fork 之后必须在新进程里首次初始化 V8
- **现象**：主进程先做 JIT 探针（fork 子进程 dlopen libnode + `node::Start`），主进程再直接调一次 → `SIGTRAP`
  / `Check failed: 12 == errno`。
- **根因**：V8 的 `thread_local` / errno TLS 在 fork 后继承，第二次初始化读到错误初值。
- **对策**：探针在 fork 的子进程里做；最终启动也 `fork`，子进程内首次 `dlopen`+`node::Start`，父进程 `waitpid`。

### 1.6 io_uring 被 seccomp 拒绝
- **现象**：libnode 启动即 `SIGSYS`。
- **根因**：鸿蒙 seccomp 禁止 `io_uring_setup(425)`，libuv 默认尝试它。
- **对策**：`scripts/patch-libnode-io-uring.sh` 把 `uv__iou_init` 里 `bl syscall@plt` 改成 `mov w0,#-1`（等价失败回退 epoll），
  并设 `UV_USE_IO_URING=0`。

### 1.7 JIT 是双重门（debug 签名过不了第二道）
- **现象**：`--jitless` 必需；不带就崩。JIT 探针 `exit=133 (SIGTRAP)`。
- **根因**：①profile ACL 声明（debug 签名可过）；②运行时 **XPM 代码页签名校验**（`libjit_code_sign.z.so`，debug 签名过不了）。
- **对策**：内嵌模式固定 `--jitless --expose-internals`，用 `_fetch-shim.cjs` 垫 Web 全局与 WebAssembly；
  要 JIT 必须 release/上架签名。宿主模式（brew node）本来就是原生 JIT，不受此限。

### 1.8 ArkTS 没有 chmod API
- **现象**：解压出来的 busybox / 原生文件没有执行位。
- **根因**：`@ohos.file.fs` 不提供 chmod（旧 `@ohos.fileio` 的 `chmodSync` 已不在 API 26）。
- **对策**：在 native 侧（`dsh_host.cpp`）启动 dsh 前统一 `chmod 0755`。

---

## 2. 内置环境树（rawfile → filesDir）

### 2.1 解压"看着成功"其实内容缺失
- **现象**：目录都在、版本文件也写了，node 启动 `MODULE_NOT_FOUND: .../@deepseek-ai/dsh/lib/_fetch-shim.cjs`。
- **根因**：`getRawFileListSync` 对**文件**路径会抛 `Error: Invalid relative path`（正常噪声，不能当异常处理），
  而真正的失败模式是"列得出、读不到"。冷启动偶发提前结束。
- **对策**：解压后做**哨兵校验**（`@deepseek-ai/dsh/lib` 条目数、`dshm-config-editor/package.json` 非空），
  不达标就清空重试一次；仍失败则抛错，绝不放行坏环境。诊断写 `dsh-extract-diag.txt`。

### 2.2 `ENV_VERSION` 必须随 rawfile 内容变化而提升
- **现象**：改了 rawfile（打补丁/换插件）但设备上还是旧副本。
- **根因**：设备侧只比对 `.dshm-version` 与哨兵，**不做内容哈希**。
- **对策**：任何 rawfile 内容改动都要提升 `DshBootstrap.ENV_VERSION`（本项目 2026-09-13 一天内从 116 提到 120）。

### 2.3 **符号链接是可用的** —— 清理代码顺链删除会毁掉整棵环境树
- **现象**：`dsh/node_modules/@deepseek-ai/` 下 242 个包**全被清空只剩空目录**，`profiles/node_modules/@deepseek-ai/*`
  变成悬空链接；node 报 `_fetch-shim.cjs` MODULE_NOT_FOUND，两种模式都起不来。
- **根因**：`dsh-app-boot` 的 `ensureSymlink()` 在 `profiles/node_modules` 下建**符号链接**指向环境树（鸿蒙允许 symlink，
  早期"沙箱禁 symlink"的判断是错的）。而 `removeDirRecursive()` 只对**子项**用 `lstatSync`，**入口自身没判链接**；
  `accessSync/listFileSync/statSync` 都会跟随链接 → 删除的是链接**目标**（真实环境树），只留下空目录 + 悬空链接。
- **对策**：`removeDirRecursive()` 入口先 `lstatSync`，符号链接/非目录一律只 `unlink` 后返回；
  清理 `profiles/node_modules/@deepseek-ai/*` 时跳过符号链接（那是 dsh 托管入口），只清真实目录副本。

### 2.4 清理 profile 缓存必须覆盖两种模式的 DSH_HOME
- **现象**：宿主模式下清了内嵌库的缓存，宿主那边该清的没清。
- **根因**：早期实现硬编码 `home/.dsh/profiles/node_modules`。
- **对策**：统一走 `DshBootstrap.allDshHomes()`（内嵌 `home/.dsh` + 宿主 `home-host/.dsh`）。

### 2.5 删目录要连目录本身一起删（否则 Node 仍会解析到它）
- **现象**：内嵌模式启动 `Cannot find package '.../profiles/web/node_modules/dshmarket/index.js'`。
- **根因**：只清了目录**内容**，留下一个空目录；Node 解析 `dshmarket` 时优先命中近层那个空目录 → 解析失败。
- **对策**：`removeDirRecursive()` 之后补 `rmdirSync`；删不掉就用打补丁副本覆盖，保证它至少是完整包。

---

## 3. 双模式（宿主 / 内嵌）与进程生命周期

### 3.1 两种模式**会话库不同**，别把"会话没了"当 bug
- 宿主 `DSH_HOME=<filesDir>/home-host/.dsh`，内嵌 `DSH_HOME=<filesDir>/home/.dsh`（由 `dsh_host.cpp` 的
  `DshHomeForMode` 与 ArkTS 的 `dshHomeForMode` 双端保持一致）。
- 排查任何"数据不见了"的问题，先看 `runtime-mode-active.txt` 里当前生效模式。

### 3.2 宿主守候进程收到重启信号后必须**自身退出**，不能原地重 fork
- **现象**：把 `runtime-mode.txt` 改成 embedded 后点重启，实际还是宿主模式，或者两个实例抢 3080。
- **根因**：守候进程原来收到 `restart-request` 只 kill 子进程然后**再 fork 一个宿主 dsh**，不重新读模式文件。
- **对策**：kill 子进程后写 `host-stopped` 标记并**结束守候进程**；由壳侧统一 `launchDsh()` 起一个读
  `runtime-mode.txt` 的新 native 进程。停机与启动解耦后，切模式不需要任何额外分支。

### 3.3 内嵌停机不能依赖"被停的那个进程"
- **现象**：内嵌模式切模式/重启时 `stopDsh` 30s 超时返回 false，重启直接放弃（界面停在旧模式）。
- **根因**：停机通道是「ArkTS 写 `restart-request` → **dsh 进程内的 dshm-terminal 插件**轮询到就 `process.exit(0)`」，
  等于把停机能力放在要被停掉的对象里；插件没加载/事件循环被占住就永远停不下来。
- **对策**：把停机交给 **native 父进程**——它轮询 `<filesDir>/kill-request`，直接 SIGTERM→(必要时)SIGKILL 子进程，
  并**由父进程兜底写 `node-exited`**（子进程被 SIGKILL 时写不出任何东西）。实测停机从 30s 超时降到 **0.8s**。
  杀掉后要顺手清掉残留的 `restart-request`，否则下一个 node 一启动就会被 JS 插件自杀（启动循环）。

### 3.4 就绪判定只认日志标记，不要 http 探测 loopback
- **现象**：据"端口已释放"判断就绪 → 新旧实例抢端口（EADDRINUSE）、界面随机失败。
- **对策**：统一读 node 日志里的 `dsh web:` 标记（文件读取可靠）；停机用 `host-stopped` / `node-exited` 标记文件判定。

### 3.5 dsh 每次启动都换鉴权 token
- **现象**：外部（Dock/托盘菜单）触发重启后，页面停在 401/白屏。
- **对策**：重启方在成功后发公共事件 `dshm.dsh.restarted`，页面收到后用新 URL 重新 `loadUrl`。

### 3.6 三处入口共用一个重启实现
- 应用内菜单、系统托盘右键、Dock 右键都收敛到 `DshmAppActions.restartDsh()`：
  **停旧（等标记）→ 清日志 → 重做 profile 镜像 → `launchDsh()` → 等 `dsh web:`**。

---

## 4. dsh 的 profile / 插件体系

### 4.1 bundle 接入「两步缺一不可」
1. **模块可达**：插件目录在 `$DSH_HOME/profiles/node_modules/` 下（满足 Node 的 parent-walk）；
2. **显式声明**：插件名列入 `$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles`。
   只放 node_modules 不写 bundles **不会加载**（症状：`/dshm-terminal/start` 返回 405）。

### 4.2 不要重写 profile 的 `package.json`
- **现象**：插件装不上/启动 abort。
- **根因**：早期实现重建整个 JSON，把 `dependencies` 抹掉了。
- **对策**：只改 `dsh.profile.bundles`，其余字段原样保留；写入走 pending 标记 + `tmp`→`rename` 事务。

### 4.3 `cordis.patch.yml` 必须是**顶层 YAML 数组**
- **现象**：宿主模式 `t5.serverReady` 永不出现，日志
  `dsh: overlay .../profiles/web/cordis.patch.yml must be a top-level YAML array of loader patch entries`，
  `host dsh exited: status=256`。
- **根因**：壳侧只写了一行注释，YAML 解析成 `null`。
- **对策**：内容必须是「注释 + `[]`」；写入前用 `profilePatchLooksValid()`（跳过注释/空行后首个字符必须是 `[`）判断，
  不合格就覆盖重写（可自愈设备上的存量坏文件）。

### 4.4 dsh abort 的三大常见原因
- profile 的 `dependencies` 里某个包解析不到（例如装了插件但包体缺失）；
- `dsh.profile.bundles` 列的 bundle 目录不存在或不是合法包；
- `profiles/node_modules` 下同名条目既不是符号链接、也不是 dsh 托管代理包（`dsh.moduleFallback.targets`）——
  dsh 的 `ensureSymlink` 会直接 throw。**因此壳侧不要往那里塞真实目录副本。**

---

## 5. 插件市场（dshmarket）与 pnpm

### 5.1 鸿蒙跑不了 pnpm 子进程 → 必须"同进程 pnpm"
- **现象**：`/dsh-market/status` 的 `pnpm` 恒为 `false`，市场能打开但装不了任何插件。
- **根因**：市场安装链路全是 `node:child_process`（`probePnpm` / `provisionPnpm` / `runDshPlugin`），
  而沙箱 PATH 上没有 pnpm/npm/corepack，且 el2 里的可执行文件 spawn 一律 `EACCES`。
- **对策**：`scripts/patch-market-pnpm-bridge.mjs` 把这三处改走 dsh 自带的**同进程**实现
  （`@deepseek-ai/dsh/lib/plugin-*.js` 的 `runPlugin()`：`worker_threads` 里 require 内置
  `pnpm/dist/pnpm.cjs`，成功后 reconcile bundles），并临时 `chdir(DSHM_FILES_DIR)` 让它命中内置 pnpm。
  实测：`pnpm: true`，真实安装 `dsh-status-rotator@0.17.2` 成功（`Done in 2.4s using pnpm v10.6.3`），卸载也正常。

### 5.2 pnpm 装出来的 dshmarket 会**遮蔽**壳侧打过补丁的副本
- **现象**：补丁明明打上了（env 里 grep 得到），宿主模式 `pnpm` 还是 `false`。
- **根因**：profile 的 `dependencies` 里有 dshmarket，pnpm 会把它从 npm 装成
  `profiles/web/node_modules/dshmarket -> .pnpm/dshmarket@x.y.z.../node_modules/dshmarket`（**未打补丁**）；
  Node 解析优先近层，dsh 加载的是它。
- **对策**：启动时检查"生效副本"是否含桥接标记，不含就解除遮蔽：符号链接只删链接，真实目录**连目录一起删**，
  删不掉则用打补丁副本覆盖（`DshBootstrap.dropShadowMarketCopy`）。
- **注意**：这是**每次安装后都会重新出现**的现象，属设计取舍——当次运行加载的是内存里已打补丁的副本，下次启动清掉即可。

### 5.3 pnpm 的临时目录
- 沙箱没有 `/tmp`；`os.tmpdir()` 忽略 `TMPDIR`。worker 里要显式 `os.tmpdir = () => <profile>/.dshm-pnpm-tmp` 并设
  `TMPDIR/TMP/TEMP`。

---

## 6. 终端（dshm-terminal）与 ArkWeb UI

### 6.1 ArkUI `TextInput` 会吞掉 Tab
- **现象**：终端里按 Tab 毫无反应，没有补全。
- **根因**：ArkUI 把 Tab 当**焦点切换键**在框架层消费，`onChange/onSubmit` 永远收不到 `\t`；输入框本身也产生不了 Tab 字符。
- **对策**：`onKeyEvent` 拦截 Tab/↑/↓/Esc/Ctrl-C → `stopPropagation()` 并把控制序列写进 pty；
  触摸场景补 `Tab` / `↑` / `^C` 按钮。

### 6.2 终端 write 接口不能无脑补换行
- **现象**：`ec` + Tab 直接把 `echo` 执行了。
- **根因**：`/dshm-terminal/write` 对任何输入都补 `\n`。
- **对策**：加 `raw: true`（不补换行）；控制序列一律走 raw。

### 6.3 管道回退模式没有行编辑
- 只有真 pty 才有补全/历史/^C；`pipe` 模式（pty addon 加载失败）属降级，见 §1.2。

---

## 7. 鸿蒙 PC 系统集成

### 7.1 Dock（快捷栏）右键 ≠ 状态栏（托盘）右键
- **Dock / 快捷栏**（屏幕底部任务栏图标右键）= **`quickBarManager`**（`@kit.DeskTopExtensionKit`，仅 2in1）。
  官方 `shortcuts` 只覆盖"**长按**桌面图标"，`abilities[].skills` 只声明"能被谁拉起"，`fileContextMenu` 是文件管理器里
  右键**文件**的菜单 —— 三者都不适用于 Dock。
- **状态栏 / 系统托盘**（右下角托盘图标右键）= **`statusBarManager`**（本工程 `StatusBarTray` 已在用）。

### 7.2 `quickBarManager` 的"空查询"会抛错
- **现象**：`capabilitySupported=true` 之后立刻失败：`1020210003 Category not found`；创建分组后再遇到 `1020210004 Quick task not found`。
- **根因**：没有任何分组 / 分组内没有任何任务时，`getCustomCategories` / `getTasksFromCategory` **抛错而不是返回空数组**。
- **对策**：两处都 try/catch 并按空集合处理，否则首次安装永远建不出菜单。

### 7.3 Dock 菜单项只能指定 Ability，参数以 WantParams 回传
- 系统必定 `startAbility`，`parameters` 变成 `want.parameters`。因此：
  - 目标选**无窗口的后台 Ability**，避免点"退出/重启"把主窗口闪到前台；
  - 冷启动走 `onCreate`、热启动走 `onNewWant`，两条都要实现；
  - 跨进程动作用公共事件转回主进程执行（dsh 的 native 子进程归属主进程）。

### 7.4 Dock 左键点击不是 startAbility
- 左键由系统"切任务到前台"，只保证触发 `onForeground`。窗口若被**最小化**，`showWindow()` 不一定恢复 →
  用 `Window.restore()` 优先、失败回退 `showWindow()`。`launchType` 保持 `singleton`（也是缺省值）。

### 7.5 退出：`terminateSelf()` 只销毁当前 Ability，也**不保证**清理 native 子进程
- 进程内还有后台 Ability 时，只调一次 `terminateSelf()` 进程不退 → 要广播事件让另一个 Ability 也结束；
- 官方文档没有任何一句保证 `terminateSelf()` 会回收应用自己 spawn 的 native 子进程 → **必须显式先停 dsh**
  （宿主发 `stop-request`、内嵌发 `kill-request`，等标记，超时也继续退，避免"退不掉"）；
- 官方对"Dock 栏退出"是否触发 `onDestroy` 的说法自相矛盾 → 关键落盘/清理不要只放 `onDestroy`。
- 系统自带的 Dock/托盘退出项**只能拦截**（`onPrepareToTerminate`，需要 `ohos.permission.PREPARE_APP_TERMINATE`），
  **不能自定义文案**；要自定义项就得用 `quickBarManager`。

---

## 8. 构建与打包

### 8.1 命令行构建要限制 JVM 堆
- `SignHap` 失败 `os::commit_memory ... 页面文件太小 (DOS error/errno=1455)`：
  设 `JAVA_TOOL_OPTIONS='-Xms16m -Xmx384m -XX:MaxMetaspaceSize=192m -XX:ReservedCodeCacheSize=64m'`，
  并把 `jbr\bin` 放进 `PATH`（只设 `JAVA_HOME` 会 `spawn java ENOENT`）。

### 8.2 HAP 不压缩存储
- `rawfile` 每 1MB 就是 HAP 的 1MB；本项目 HAP ≈ 243MB，其中 `libnode.so.137` 121MB、rawfile 环境 ~110MB。
- 瘦身只能裁环境文件，且判据要是"平台构建产物"形状，不能按路径里出现 `win32` 就删。

### 8.3 `entry/libs/arm64-v8a` 下同名 `.so` 会与 CMake 产物冲突
- `ProcessLibs`：`00306049 Duplicated files found in module entry`。同 inode 硬链接会被静默去重，同名不同内容必炸。

### 8.4 工具链 `-Wl,--no-undefined`
- 需要保留未定义符号的共享库（如 N-API addon）必须把该标志从链接参数里摘掉；lld 没有 `--allow-undefined`。

### 8.5 `CompileResource` 可能 UP-TO-DATE
- 改了 rawfile 却没进包时，先确认 `CompileResource` 真的重跑过；实在不行清 `entry/build` 全量构建。

### 8.6 HNP **不能**独立侧载
- `hdc install` 只接受 `.hap/.hsp/.app`；`.hnp` 是"原生软件包"载荷，官方唯一路径是
  **HNP → 嵌入 HAP → 签名 HAP → 分发**（`hnpPackages` 只能配在 entry 模块）。
- hvigor **不支持** HNP：要 `hnpcli pack` + `app_packing_tool.jar --hnp-path` 手工重打 + 手工签名。
- ⚠️ 陷阱：`app_packing_tool --hap-path` 不是"在已有 HAP 上追加"，只给它会报 `--json-path is empty`；
  补上 `--json-path` 后**会静默产出只剩 module.json 的几 KB HAP**（原 243MB 内容全丢）。
  正确做法是复刻 hvigor `PackageHap` 的完整参数（`--lib-path/--json-path/--resources-path/--index-path/--pack-info-path`）再追加 `--hnp-path`。
- HNP 的唯一实际收益：包内原生文件**带执行位**（可以 `execv`），而 HAP 的 `libs/*.so` 没有。

### 8.7 在带 fs 安全钩子的沙箱终端里跑 hvigor 会假失败
- 表现：`Failed to delete ... No error`（restool 11204003）、`SAFE_DELETE_BULK_CONFIRM_REQUIRED`。
- 这是沙箱钩子拦截删除，不是项目问题。构建请在普通终端/DevEco 里跑。

---

## 9. ArkTS / 工具链语言坑

| 坑 | 对策 |
|---|---|
| ArkTS 禁止无类型对象字面量 | 空对象用 `JSON.parse('{}') as Record<string, Object>` |
| 禁止 `any` / `unknown` | 错误统一 `e as BusinessError` 再取 `code`/`message` |
| 异步回调里丢失非空收窄 | 取非空别名（`const target: window.Window = mainWin;`）后再进回调，别在回调里写 `?.` |
| `fileIo` 无 `chmod` / 无整目录拷贝 | chmod 交 native；拷贝自己递归（且用 lstat 防跟随链接） |
| `rmdirSync` 不支持递归 | 自己递归；入口先 lstat（见 §2.3） |
| `getRawFileListSync` 对文件路径抛错 | 这是正常噪声；判目录不能靠"是否抛异常"，否则会把文件变成同名空目录 |
| 本机 2in1 上 `hilog -x` 读不到应用日志 | 关键链路写诊断文件（`quickbar-diag.txt` / `restart-diag.txt` / `host-plugin-diag.txt`） |
| 含中文的 `.ps1` 在 Windows PowerShell 5.1 下按 ANSI 解析报语法错 | 脚本存为 **UTF-8 with BOM** |

---

## 10. 快速排查路径（症状 → 先看什么）

| 症状 | 先看 |
|---|---|
| 界面白屏 / 一直"正在启动" | `<filesDir>/log/node-*.log` 尾部；`boot-timing.txt` 停在哪一步（t1..t5） |
| 会话"消失" | `runtime-mode-active.txt`（两种模式会话库不同，见 §3.1） |
| 插件端点 405 | profile 的 `dsh.profile.bundles` 是否列了该 bundle（§4.1） |
| 市场装不了插件 | `/dsh-market/status` 的 `pnpm` 字段（§5.1、§5.2） |
| 终端没有补全 | 终端标题是 `pty` 还是 `pipe`（§1.2、§6.1） |
| 切换模式没反应 | `restart-diag.txt`（stopDsh 是否 stopped=true）（§3.2、§3.3） |
| 重启后页面 401 | 页面是否收到 `dshm.dsh.restarted` 用新 token 重载（§3.5） |
| Dock 菜单没有自定义项 | `quickbar-diag.txt`（能力探测 + 任务列表）（§7.1、§7.2） |
| 退出后还有进程占着 3080 | `exitApp` 是否先停 dsh（§7.5） |
