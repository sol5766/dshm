# DSHM — DeepSeek Harness 鸿蒙 PC 客户端

鸿蒙 PC（HarmonyOS / API 26）上的 DeepSeek Harness 桌面客户端：ArkUI 原生壳 + ArkWeb 全屏加载官方 Web UI。**采用外部 dsh 模式**：客户端启动时自动拉起本机 brew 安装的 `dsh web`（NAPI 主进程 fork，继承主进程网络空间），ArkWeb 接入 `127.0.0.1:3080`。

## 架构

```
┌───────────────────────────────────────────────┐
│ DSHM (HarmonyOS App)                         │
│  ArkUI 壳                                     │
│   ├─ 服务发现 (ServerDiscovery)               │  探活 3080/8080 + __DSH_BOOT__ 指纹
│   ├─ 自动拉起 (libdsh_launcher NAPI)          │  主进程 fork+exec `dsh web --port 3080`
│   ├─ 一键安装 (InstallManager + NAPI)         │  安装 Harmonybrew / DeepSeek Harness
│   ├─ 设置页 (安装/服务/地址/自动启动/工作区)  │
│   └─ ArkWeb 全屏 Web 组件                     │  http://127.0.0.1:3080
└───────┬───────────────────────────────────────┘
        │ 同源（HTTP + WebSocket）
        ▼
  外部 dsh web（brew 安装，用户域运行）
  http://127.0.0.1:3080
```

**冷启动流程（简化 4 态）：**

```
探活（discovering）→ 未运行则拉起（starting）→ 接入（web）
                        ↓ 超时
                    引导页（guide）：未安装可一键安装（带进度条），已安装提示手动启动
```

## 功能

- **自动拉起**：打开客户端即探活 `127.0.0.1:3080`，无服务时自动 `dsh web --port 3080`（NAPI 主进程 fork，与 ArkWeb 同网络空间，可直接接入）
- **一键安装**：设置页/引导页提供「安装 Harmonybrew」「安装 DeepSeek Harness」按钮（NAPI 主进程执行，进度实时滚动）
- **服务管理**：设置页启动/停止 dsh web
- **后端地址**：可配置，默认自动探测 3080
- **工作区授权**：DocumentPicker 授权外部目录（tool-fs/bash 使用）
- **Web 右上角**：连接状态指示器 + 「设置」入口

## 前置条件

1. 安装外部后端（可在应用内一键安装，或终端执行）：
   ```sh
   brew install deepseek-harness
   ```
2. 启动：客户端会自动拉起；或手动 `dsh web`（默认 3080）

## 构建与安装

1. DevEco Studio 打开项目，等待同步完成。
2. 确认 `hvigor/hvigor-config.json5` 与根 `oh-package.json5` 的 `modelVersion` 为 **`6.1.0`**（本机 hvigor 6.23.15-next 仅支持 6.1.0）。
3. 出包：Build → Build Hap(s)；或命令行：
   ```sh
   /data/app/node.org/node_22.7.0/bin/node /data/app/hvigor.org/hvigor_1.0.0/bin/hvigorw.js --mode module -p product=default -p buildMode=debug assembleHap --no-daemon
   ```
   > 受限环境（IDE 沙箱 EACCES）改用 brew node + `DEVECO_SDK_HOME` 指向 brew 的 OHOS SDK 镜像；`nativeCompiler` 为 `Original`。
4. 签名：**DevEco 自动签名**（Project Structure → Signing Configs → 勾选自动签名；26.0.0 以下非企业受限权限支持自动签名授权）。第三方自签（hap-sign-tool）无法授权 ACL 权限。
5. 安装：`hdc shell bm install -p <签名后的 hap>`

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
`childProcessManager.startNativeChildProcess`（appspawn）拉起的 native 子进程在**独立网络命名空间**——它监听的 `127.0.0.1:3080` 主进程（ArkWeb）**连不上**（表现为"服务显示在运行但连不上"；用户手动在终端起的 dsh 在用户空间，客户端能连）。
**解决**：用 **NAPI 在应用主进程内 `fork+exec` dsh**——子进程继承主进程网络空间，与 ArkWeb 同空间，可直接接入。`startChildProcess(SELF_FORK)` 仅支持 ArkTS 源文件入口，不适用于 native。

### 2. ACL 权限与第三方签名
- `RUNNING_LOCK`：`availableType=SYSTEM`，仅系统应用可用 → 第三方应用声明必装不上
- `CUSTOM_SANDBOX` 等 `system_basic`：`system_grant`（安装时由签名 profile 的 acls 授予），**不能**通过 `openPermissionOnSetting` 申请（该 API 只对 user_grant 权限有效）——运行时只需 `checkAccessTokenSync` 记录状态
- 第三方自签（hap-sign-tool）profile 无 ACL 授权能力 → 带受限权限的 HAP 装不上；**DevEco 自动签名**（华为开发者账号）可授权 26.0.0 以下非企业受限权限

### 3. 沙箱 W^X 与 node `--jitless`
应用沙箱禁止可执行内存（W^X），node 需 `--jitless` 运行。**`--jitless` 禁用 WebAssembly**：node 22 内置 undici 的 llhttp（HTTP 解析器）是 WASM 实现，jitless 下 `ReferenceError: WebAssembly is not defined`（`lazyllhttp` 的 catch 二次访问未捕获）。**node 24+ 已修复**（有 WASM 可用性检测）。内置 node 方案需用 node 24 构建 libnode。

### 4. dsh 启动自动改写 profile bundles
在用户目录跑 dsh 测试时，dsh 会自动把 `dshmarket` 加入 `~/.dsh/profiles/web/package.json` 的 bundles——若未安装该插件，后续启动报 `cannot resolve profile bundle "dshmarket"`。测试 dsh 运行时务必使用独立 HOME。

### 5. 网络与构建环境
- npm registry 直连 SSL 不稳定（`ERR_SSL_DECRYPTION_FAILED`/断流）→ 用 `npm_config_registry=https://registry.npmmirror.com`
- GitHub release 下载不稳定 → 用 `https://ghfast.top/https://github.com/...` 镜像（git 可用 `url.<mirror>.insteadOf` 注入，不污染全局配置）
- OHOS SDK clang 15 不编译 OpenSSL `crypto/aarch64cpuid.S`（`cpu_check_features` 未定义）→ 补 stub（返回 0，走基础路径）；zlib `zlib_arm_crc32` 需在 openharmony 目标禁用（clang 15 无 crc32b 内建）

## 目录结构

```
AppScope/            应用级配置与图标
entry/
  src/main/cpp/
    dsh_launcher.cpp     外部服务启动器（NAPI：launchDsh / installBrew / installDsh）
    dsh_host.cpp         内嵌运行时宿主（保留，未启用）
    brew_check.cpp / brew_installer.cpp   安装检测/安装（保留，未启用）
    common/              公共工具（fork+exec / 结果文件）
    types/libdsh_launcher/   NAPI 类型声明
  src/main/ets/
    entryability/EntryAbility.ets   入口（权限状态记录 + onDestroy 清理）
    pages/Index.ets                 主页：探活→拉起→接入 + 引导页（安装/手动）
    pages/Settings.ets              设置页（安装/服务/地址/自动启动/工作区）
    common/ServerDiscovery.ets      探活 + __DSH_BOOT__ 指纹
    common/ServerSettings.ets       地址与开关持久化
    hdsh/service/DshServiceManager.ets  服务生命周期 + NAPI 拉起
    hdsh/install/InstallManager.ets     应用内安装（NAPI + 进度轮询）
    hdsh/bootstrap/DshBootstrap.ets     内嵌运行时引导（保留，未启用）
    hdsh/brew/ / hdsh/access/ / hdsh/utils/
scripts/             环境脚本（install-brew / install-dsh / build-libnode 等）
```

## 开发进度

### 已完成
- ✅ 外部 dsh 自动拉起（NAPI 主进程 fork，ArkWeb 直接接入 3080）
- ✅ 引导页兜底：拉起超时 → 一键安装（进度条 + 日志）+ 手动启动提示
- ✅ 设置页：安装 Harmonybrew / DeepSeek Harness（NAPI + 进度）
- ✅ Web 右上角设置入口
- ✅ 权限收敛（6 个，ACL 可自动签名授权）
- ✅ modelVersion 6.1.0 / nativeCompiler Original / 自动签名配置
- ✅ 构建验证（HAP ~2MB，已签名）

### 待完成
- 内置 node 方案（node 24 libnode，解决 undici WASM 后可用；构建脚本 build-libnode.sh 已就绪）
- API 26 升级（compatibleSdkVersion → 7.0.0(26)）
- 弃用 API 修复、键盘快捷键等

## FAQ

**打开客户端自动拉起失败？** 看 `files/log/dsh-launcher-*.log`：`zsh exec failed`（exec 权限）、`EADDRINUSE`（3080 被占）、`dsh web ready`（实际已起）。确认 `CUSTOM_SANDBOX` 权限已授予（安装时由签名 ACL 授予）。

**设置页安装按钮无效？** 安装走 NAPI 主进程 fork，进度在 `files/log/install-<name>-*.log`，结果在 `files/tmp/install-<name>-result.json`。

**为什么不用内嵌 dsh？** 应用沙箱 W^X 限制 node JIT（需 --jitless 禁 WASM，node 22 的 undici 会崩）；且内置运行时随 HAP 分发体积大（300MB+）。外部 dsh（brew 用户域）最简可用，内置方案待 node 24 就绪后启用。
