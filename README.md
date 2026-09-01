# DSHM — DeepSeek Harness 鸿蒙 PC 客户端

> HarmonyOS PC（OpenHarmony / API 23+）上的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 桌面客户端：**ArkUI 原生壳 + ArkWeb 全屏加载官方 Web UI**。打开即用：自动探活、自动拉起本机 `dsh web`、未安装时引导一键安装，也支持手动指定后端地址。

<p>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
<a href="#构建与安装"><img src="https://img.shields.io/badge/platform-HarmonyOS%20PC-blueviolet.svg" alt="HarmonyOS PC"></a>
<a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/dsh-0.1.1--rc.2-brightgreen.svg" alt="dsh"></a>
<a href="https://github.com/sol5766/dshm/releases"><img src="https://img.shields.io/github/v/release/sol5766/dshm" alt="Releases"></a>
</p>

## 这是什么

DSHM 是 DeepSeek Harness 在鸿蒙 PC 上的原生客户端，定位是**外部 dsh 的接入壳**：

- 客户端启动即探活本机 `dsh web`（默认 `127.0.0.1:3080`），没运行就自动拉起，ArkWeb 全屏加载官方 Web UI
- 未安装 deepseek-harness 时，冷启动检测到缺装会进入引导页，一键安装（应用内 fork 子进程执行 `brew install`，进度实时可见）
- 同时保留「后端地址可配置」：手动在终端起 `dsh web`（任意端口），客户端也能接入

> 它**不是** dsh 的 npm 插件（dsh 插件市场是 npm 包体系，`dsh plugin add <package>` 安装）；DSHM 是独立安装的鸿蒙 App，负责把 dsh 服务「带起来 + 接进去」。安装包从 Releases 下载。

## 功能特性

- **冷启动自动拉起**：探活 `127.0.0.1:3080`/`8080`（TCP 探测 + `__DSH_BOOT__` 指纹校验），无服务则 NAPI 主进程 fork+exec `dsh web --port 3080`，与 ArkWeb 同网络空间，直接接入
- **一键安装**：引导页/设置页提供「安装 Harmonybrew」「安装 DeepSeek Harness」（NAPI 执行，进度滚动 + 真实产物校验，杜绝"假成功"）
- **未安装引导**：冷启动检测到缺装 → 引导页一键安装或复制终端命令
- **服务管理**：设置页启动/停止 dsh web，退出应用自动清理自启动进程
- **工作区授权**：DocumentPicker 选择目录 + 持久授权（重启自动恢复）
- **桌面式标题栏**：窗口顶部自绘标题栏，集成 HARNESS / EDIT / VIEW / WINDOWS 下拉菜单、连接状态点与自绘的最小化/最大化/关闭，与系统三键同一水平线（隐藏系统窗口装饰条，标题栏可拖动）
- **连接状态指示**：Web 右上角状态点 + 设置入口

## 架构

```
┌───────────────────────────────────────────────┐
│ DSHM (HarmonyOS App)                         │
│  ArkUI 壳                                     │
│   ├─ 服务发现 (ServerDiscovery)               │  探活 3080/8080 + __DSH_BOOT__ 指纹
│   ├─ 自动拉起 (libdsh_launcher NAPI)          │  主进程 fork+exec `dsh web --port 3080`
│   ├─ 一键安装 (InstallManager + NAPI)         │  安装 Harmonybrew / DeepSeek Harness
│   ├─ 设置页 (安装/服务/地址/工作区)          │
│   └─ ArkWeb 全屏 Web 组件                     │  http://127.0.0.1:3080
└───────┬───────────────────────────────────────┘
        │ 同源（HTTP + WebSocket）
        ▼
  外部 dsh web（brew 安装，用户域运行）
  http://127.0.0.1:3080
```

**冷启动流程：**

```
探活 + 检测安装
  ├─ 已有服务        → 直接接入（web）
  ├─ 未安装          → 引导页：一键安装 / 复制安装命令
  └─ 已安装未运行    → 自动拉起 → 指纹校验 → 接入（web）
                        └─ 超时 → 引导页：手动启动提示 + 重试
```

## 安装

### 方式一：直接安装（推荐）

从 [Releases](https://github.com/sol5766/dshm/releases) 下载签名包 `entry-default-signed.hap`：

```sh
hdc shell bm install -p entry-default-signed.hap
```

### 方式二：源码构建

1. DevEco Studio 打开项目，等待同步完成
2. 确认 `hvigor/hvigor-config.json5` 与根 `oh-package.json5` 的 `modelVersion` 为 **`6.1.0`**（本机 hvigor 6.23.15-next 仅支持 6.1.0）
3. 出包：Build → Build Hap(s)；或命令行：
   ```sh
   /data/app/node.org/node_22.7.0/bin/node /data/app/hvigor.org/hvigor_1.0.0/bin/hvigorw.js --mode module -p product=default -p buildMode=debug assembleHap --no-daemon
   ```
   > 受限环境（IDE 沙箱 EACCES）改用 brew node + `DEVECO_SDK_HOME` 指向 brew 的 OHOS SDK 镜像；`nativeCompiler` 为 `Original`。
4. 签名：**DevEco 自动签名**（Project Structure → Signing Configs → 勾选自动签名；26.0.0 以下非企业受限权限支持自动签名授权）。第三方自签（hap-sign-tool）无法授权 ACL 权限
5. 安装：`hdc shell bm install -p <签名后的 hap>`

### 后端依赖

客户端需要一个可运行的 `dsh web`（应用内可一键安装，或终端执行）：

```sh
brew install deepseek-harness   # 安装
dsh web                         # 启动（默认 3080）
```

## 权限说明

| 权限 | 级别 | 作用 |
|---|---|---|
| `ohos.permission.CUSTOM_SANDBOX` | system_basic（system_grant） | 动态沙箱：子进程可 exec 用户目录 ELF |
| `ohos.permission.ACCESS_USER_FULL_DISK` | system_basic（manual_settings） | 用户公共目录读写 |
| `ohos.permission.READ_WRITE_USER_FILE` | system_basic | 用户目录读写（DSH 插件/工具链） |
| `ohos.permission.FILE_ACCESS_PERSIST` | normal | 目录持久授权 |
| `ohos.permission.KEEP_BACKGROUND_RUNNING` | normal | 后台运行 |
| `ohos.permission.INTERNET` | normal | 网络 |

> **不要声明 `ohos.permission.RUNNING_LOCK`**（`availableType=SYSTEM`，仅系统应用，第三方声明签名/未签名都无法安装）。`ALLOW_EXTERNAL_NATIVE_CODE` 也未声明（demo 同款权限集已验证可装）。

## 技术经验（踩坑记录）

### 1. childProcess 子进程与主进程网络命名空间隔离（关键）
`childProcessManager.startNativeChildProcess`（appspawn）拉起的 native 子进程在**独立网络命名空间**——它监听的 `127.0.0.1:3080` 主进程（ArkWeb）**连不上**。
**解决**：用 **NAPI 在应用主进程内 `fork+exec` dsh**——子进程继承主进程网络空间，与 ArkWeb 同空间，可直接接入。`startChildProcess(SELF_FORK)` 仅支持 ArkTS 源文件入口，不适用于 native。

### 2. 主进程与 fork 子进程的用户目录视图不同
`/storage/Users` 是 `hmmac=use_task` 的按任务隔离视图：**主进程直接 `access()` 用户目录不可靠**（会误报未安装），安装/检测/拉起必须统一在 **fork 子进程（自定义沙箱）上下文**里做——子进程可读写/exec 物理机用户目录，`fork + exec shell` 后一切正常。

### 3. brew 拒绝在不可读 cwd 下运行
应用主进程 cwd 是 `/` 或 `/data`，子进程继承后 `brew` 报 `The current working directory must be readable to 100 to run brew` 并退出。**解决**：所有子进程命令先 `cd "$HOME"` 再执行。

### 4. 冷启动早期 http 探活会挂死主线程
冷启动时网络栈未就绪，`@ohos.net.http` 的探活请求可能永久悬挂（连 `setTimeout` 都不再触发，整个发现流程死等）。**解决**：探活先用 `@ohos.net.socket` TCP 连接探测（异步、不占主线程、硬超时），端口开放后再做 http 指纹校验。

### 5. ACL 权限与第三方签名
- `RUNNING_LOCK`：`availableType=SYSTEM`，仅系统应用可用 → 第三方应用声明必装不上
- `CUSTOM_SANDBOX` 等 `system_basic`：`system_grant`（安装时由签名 profile 的 acls 授予），**不能**通过 `openPermissionOnSetting` 申请（该 API 只对 user_grant 权限有效）——运行时只需 `checkAccessTokenSync` 记录状态
- 第三方自签（hap-sign-tool）profile 无 ACL 授权能力 → 带受限权限的 HAP 装不上；**DevEco 自动签名**（华为开发者账号）可授权 26.0.0 以下非企业受限权限

### 6. 沙箱 W^X 与 node `--jitless`
应用沙箱禁止可执行内存（W^X），node 需 `--jitless` 运行。**`--jitless` 禁用 WebAssembly**：node 22 内置 undici 的 llhttp（HTTP 解析器）是 WASM 实现，jitless 下 `ReferenceError: WebAssembly is not defined`。**node 24+ 已修复**。内置 node 方案需用 node 24 构建 libnode。

### 7. dsh 启动自动改写 profile bundles
在用户目录跑 dsh 测试时，dsh 会自动把 `dshmarket` 加入 `~/.dsh/profiles/web/package.json` 的 bundles——若未安装该插件，后续启动报 `cannot resolve profile bundle "dshmarket"`。测试 dsh 运行时务必使用独立 HOME。

### 8. 网络与构建环境
- npm registry 直连 SSL 不稳定（`ERR_SSL_DECRYPTION_FAILED`/断流）→ 用 `npm_config_registry=https://registry.npmmirror.com`
- GitHub release 下载不稳定 → 用 `https://ghfast.top/https://github.com/...` 镜像（git 可用 `url.<mirror>.insteadOf` 注入，不污染全局配置）
- OHOS SDK clang 15 不编译 OpenSSL `crypto/aarch64cpuid.S`（`cpu_check_features` 未定义）→ 补 stub；zlib `zlib_arm_crc32` 需在 openharmony 目标禁用（clang 15 无 crc32b 内建）

## 目录结构

```
AppScope/            应用级配置与图标
entry/
  src/main/cpp/
    dsh_launcher.cpp     核心 NAPI：launchDsh / installBrew / installDsh / checkInstall / stopDsh / physTrace
    common/              公共工具（fork+exec / GetHomeDir / 结果文件）
    types/libdsh_launcher/  NAPI 类型声明
  src/main/ets/
    entryability/EntryAbility.ets   入口（权限状态记录 + onDestroy 清理自启动服务）
    pages/Index.ets                 主页：探活→检测→拉起/引导安装→接入
    pages/Settings.ets              设置页（安装/服务/地址/工作区）
    common/ServerDiscovery.ets      TCP 探活 + __DSH_BOOT__ 指纹
    common/ServerSettings.ets       地址持久化
    hdsh/service/DshServiceManager.ets  服务生命周期 + NAPI 拉起
    hdsh/install/InstallManager.ets     应用内安装（NAPI + 进度轮询）
    hdsh/brew/BrewChecker.ets           安装状态检测（fork 子进程上下文）
    hdsh/access/WorkspaceAccess.ets     工作区授权（picker + 持久授权）
    hdsh/bootstrap/                  内嵌运行时引导（保留，未启用）
scripts/             环境脚本（install-brew / install-dsh / build-libnode 等）
```

## 开发进度

### 已完成
- ✅ 冷启动自动拉起（TCP 探活 → NAPI fork+exec → 指纹校验 → ArkWeb 接入）
- ✅ 未安装引导：缺装检测 + 引导页一键安装（进度条 + 真实产物校验）
- ✅ 应用内安装 Harmonybrew / DeepSeek Harness（brew cwd 修复、禁自动更新、物理日志）
- ✅ 设置页：安装状态 / 服务管理 / 后端地址 / 工作区授权
- ✅ 退出自动清理自启动 dsh 进程（SIGTERM）
- ✅ 诊断可观测：安装/拉起日志镜像到物理机 `~/dshm-install-*.log` / `~/dshm-launcher.log` / `~/dshm-dsh-web.log`
- ✅ Web 右上角连接状态指示器 + 设置入口
- ✅ 权限收敛（6 个，ACL 可自动签名授权）
- ✅ modelVersion 6.1.0 / nativeCompiler Original / 自动签名配置

### 待完成
- API 26 升级（compatibleSdkVersion → 7.0.0(26)）
- 内置 node 方案（node 24 libnode，解决 undici WASM 后可用；构建脚本 build-libnode.sh 已就绪）
- 弃用 API 修复、键盘快捷键等

## FAQ

**冷启动没自动拉起？** 看物理机日志：`~/dshm-launcher.log`（ArkTS 流程 + NAPI 调用 + readiness 结果）、`~/dshm-dsh-web.log`（dsh 本体 stderr）。`ARKTS: discovering...` 后无下文 = 探活阶段；`launchDsh NAPI invoked` 后无 `dsh web ready` = 子进程拉起阶段。确认 `CUSTOM_SANDBOX` 权限已授予（安装时由签名 ACL 授予）。

**应用内安装失败？** 安装进度区可见 `[diag] HOME=/ cd=/ brew=...` 行；完整日志在 `~/dshm-install-dsh.log`。常见原因：`brew` cwd 报错（已修复，自动 `cd $HOME`）、网络下载 bottle 失败（重试或换镜像）。

**设置页显示「未安装」但终端里有？** 检测走 fork 子进程上下文（与拉起一致），应用内安装的 dsh 与终端 brew 安装的可能在不同视图——以应用内检测结果为准。

**为什么不用内嵌 dsh？** 应用沙箱 W^X 限制 node JIT（需 --jitless 禁 WASM，node 22 的 undici 会崩）；且内置运行时随 HAP 分发体积大（300MB+）。外部 dsh（brew 用户域）最简可用，内置方案待 node 24 就绪后启用。

## License

[MIT](LICENSE)
