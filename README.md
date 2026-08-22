# DSHM — DeepSeek Harness 鸿蒙 PC 客户端

鸿蒙 PC（HarmonyOS 7.0 / API 26）上的 DeepSeek Harness 桌面客户端：ArkUI 原生壳 + ArkWeb 全屏加载官方 Web UI，支持 dsh 的全部功能（会话、工作区、模型与插件设置、技能/斜杠命令、计划模式、权限审批、附件上传、会话导出下载等）。内置安装检测与服务管理：检测本机是否安装 deepseek-harness，未安装时一键安装，安装后自动启动 dsh web 服务并连接。

## 架构（混合模式 + 安装/服务管理）

```
┌─────────────────────────────────────────────────┐
│ DSHM (HarmonyOS App)                           │
│  ArkUI 壳                                       │
│   ├─ 安装检测 (BrewChecker)                     │  brew list / which dsh
│   ├─ 一键安装 (BrewInstaller)                   │  childProcess → brew install
│   ├─ 服务管理 (DshServiceManager)               │  dsh web 启停 + 生命周期
│   ├─ 服务发现 (net.http 探活)                   │  GET / 指纹校验 __DSH_BOOT__
│   ├─ 内嵌运行时引导 (DshBootstrap)              │  rawfile 解压 + 启动 native 子进程
│   ├─ ArkWeb 全屏 Web 组件                       │  校验 HTML 含 "__DSH_BOOT__" 指纹
│   ├─ 状态引导页 / 安装向导 / 设置页             │
│   └─ 文件选择 / 下载桥接                        │
└───────┬──────────────────┬──────────────────────┘
        │                  │ loopback 同源（HTTP + WebSocket）
        │ 优先             ▼
        │          外部 dsh web（brew 安装）
        │          http://127.0.0.1:3080/8080
        │                  │
        │ 未安装时          │ 已安装但未运行
        │                  ▼
        │          DshServiceManager 启动
        │          childProcess → dsh web --port N
        │
        │ 以上均不可用
        ▼
  内嵌 dsh (libdsh_host.so → libnode.so → dsh web :3080)
```

客户端不重实现任何 harness 逻辑：Web UI 与后端同源通信（`/api` RPC + 事件 WebSocket），ArkWeb 行为与浏览器一致，因此 dsh 升级后客户端无需改动。设计参考 macOS 案例 [chentao326/dsh-gui](https://github.com/chentao326/dsh-gui)（系统 WebView 壳 + 指纹校验的服务发现 + 自启动生命周期管理）。

**冷启动完整流程（8 状态）：**

```
checking → installing → starting → discovering → booting → guide → web → error
```

1. **checking** — 检测本机是否已安装 deepseek-harness（`BrewChecker`）
2. **installing** — 未安装时自动通过 `BrewInstaller` 执行 `brew install deepseek-harness`，展示安装进度
3. **starting** — 已安装后自动通过 `DshServiceManager` 启动 `dsh web`，捕获端口
4. **discovering** — 探测本机 8080/3080 端口，`__DSH_BOOT__` 指纹校验
5. **booting** — 探测不到外部服务时，自动解压内置运行时并拉起 dsh（设置可关）
6. **guide** — 以上均失败时展示引导页，含安装/启动命令（一键复制）+「重新连接」
7. **web** — ArkWeb 全屏加载官方 UI，右上角连接状态指示器
8. **error** — 页面加载失败，自动切到引导页

**两种后端来源（打开时先探测外部，探测不到自动内嵌自启）：**

| | 外部 brew dsh | 内嵌 dsh |
|---|---|---|
| 安装 | `BrewInstaller` 应用内一键安装 / `install-dsh.sh` 终端安装 | 随 HAP 分发（rawfile/dsh + libnode.so） |
| 启动 | `DshServiceManager` 应用内启动 / `start-dsh-resident.sh` 终端守护 | 客户端打开时自动拉起（设置可关） |
| 运行环境 | 用户域（全权限） | 应用沙箱（文件访问需授权目录） |
| 升级 | `upgrade.sh` 一条命令 | 重打 HAP（rawfile 版本锁定） |
| 架构 | 任意设备可用 | 仅 arm64-v8a（libnode/busybox 预编译） |
| 生命周期 | 应用退出时仅停 self-started 实例，已运行的不动 | 随应用进程退出 |

内嵌运行时方案移植自 [dsh-OHDSH/HDSH](https://gitcode.com/MakeBlackSheepGreat/dsh-OHDSH)（MIT）：
`childProcessManager.startNativeChildProcess("libdsh_host.so:Main", args)` 拉起 native 子进程，
子进程内 `dlopen(libnode.so)` → `node::Start("--jitless --expose-internals …/lib/bin.js web")`
把 dsh web 跑在 127.0.0.1:3080。

## 前置条件

1. 安装外部后端（可选；不装则走内嵌自动启动）：

   ```sh
   sh scripts/install-dsh.sh
   ```

   单独装 Harmonybrew（鸿蒙版 Homebrew，[官方文档](https://harmonybrew.atomgit.com/)）：

   ```sh
   sh scripts/install-brew.sh
   ```

2. 启动外部后端（默认 `http://127.0.0.1:3080`），前台：

   ```sh
   dsh web
   ```

   或后台常驻（自脱离、崩溃自愈、关终端不影响、TERM 即可停）：

   ```sh
   sh scripts/start-dsh-resident.sh        # 默认 3080
   sh scripts/start-dsh-resident.sh 8080   # 自定义端口
   ```

   **停止：**

   ```sh
   # 仅停守护（dsh 因 setsid 独立于守护，仍会继续服务；客户端不受影响）
   kill $(cat ~/.dsh/dsh-web-<port>.daemon.pid)

   # 守护 + dsh 一起停（彻底清理）
   kill $(cat ~/.dsh/dsh-web-<port>.daemon.pid) $(cat ~/.dsh/dsh-web-<port>.pid)

   # TERM 不响应时退回到 -9
   kill -9 $(cat ~/.dsh/dsh-web-<port>.daemon.pid)
   ```

3. 升级 Harmonybrew 与 dsh：

   ```sh
   sh scripts/upgrade.sh
   ```

   升级脚本只换包，**不会**自动重启在跑的 dsh。如要让守护加载新版本，
   重新跑一次 `scripts/start-dsh-resident.sh` 即可（守护会杀掉旧 dsh 后拉起新版）。

## 构建与安装

内嵌运行时产物（rawfile/dsh、rawfile/busybox、rawfile/pnpm、libnode.so）默认不提交，
构建前需先用脚本生成（arm64 设备）：

```sh
bash scripts/fetch-busybox.sh                 # rawfile/busybox（Harmonybrew/ohos-busybox）
bash scripts/fetch-pnpm.sh                    # rawfile/pnpm（pnpm linuxstatic-arm64 standalone）
bash scripts/prepare-dsh-env.sh               # rawfile/dsh（npm 安装 dsh + 内置插件市场 + OHOS 适配）
bash scripts/build-libnode.sh                 # entry/libs/arm64-v8a/libnode.so（自建，见下）
```

> `build-libnode.sh` 用 harmonybrew 的 OHOS SDK clang（LLVM 15，target
> aarch64-unknown-linux-ohos）从标准 node 22 LTS 源码以 `--shared` 构建 libnode.so
> （dsh 要求 node ^22.19.0 || >=24.0.0）。HDSH 使用的 libnode 预编译包来源不公开，
> 自建可复现；构建约 30~60 分钟，产物只生成一次。

然后构建 HAP：

1. DevEco Studio → File → Open → 选择本目录，等待同步完成。
2. 确认 SDK：`build-profile.json5` 中 `compatibleSdkVersion` 为 `6.1.0(23)`（当前 DevEco Studio 版本），升级 API 26 需 DevEco Studio 26.0.0 Beta1+。
3. 出包：Build → Build Hap(s)/APP(s) → Build Hap(s)；或命令行：

   ```sh
   /data/app/node.org/node_22.7.0/bin/node /data/app/hvigor.org/hvigor_1.0.0/bin/hvigorw.js assembleHap --mode module -p product=default --no-daemon
   ```

4. 签名：工程默认产出**未签名 hap**（`entry/build/default/outputs/default/entry-default-unsigned.hap`），用本地签名工具签名后安装；也可在 DevEco → Project Structure → Signing Configs 勾选自动生成签名后直接 Run。
5. 安装：

   ```sh
   hdc shell bm install -p <签名后的 hap 路径>
   ```

6. 桌面/应用列表出现鲸鱼图标 "DSHM"，点击即用。

体积说明：内嵌 dsh 全量随包分发（dsh node_modules + libnode.so + pnpm standalone），
HAP 预计 200~300MB，属预期内。

## 使用说明

- **首次启动**：自动检测安装状态 → 未安装时一键安装 → 安装后自动启动 dsh web → 探测端口 → 加载 UI。所有地址接入前都做 `__DSH_BOOT__` 指纹校验。
- **设置**：主页右上角「设置」可查看安装状态、管理服务启停、修改后端地址（持久化保存）、开关「打开时自动启动内置后端」、授权工作区目录。
- **附件上传**：Web UI 的文件选择已桥接到系统文件选择器。
- **下载**（如会话导出 ZIP）：保存到应用沙箱 `files/download/`，完成时有提示。
- **断线**：后端停止导致主页面加载失败时自动切到引导页，修复后点「重新连接」。
- **连接状态**：Web 模式右上角显示连接状态指示器（绿=已连接 / 红=已断线），点击可重连。
- **生命周期**：应用退出时仅停止由本应用启动的 dsh 实例，已运行的外部 dsh 不受影响。

## 目录结构

```
AppScope/            应用级配置与图标
entry/
  libs/arm64-v8a/    libnode.so（自建产物，gitignore）
  src/main/cpp/      C++ 原生子进程模块
    dsh_host.cpp       内嵌运行时宿主（dlopen libnode + node::Start 启动 dsh）
    brew_check.cpp     安装检测（brew/dsh 文件探测 → JSON 结果）
    brew_installer.cpp 一键安装（fork+exec brew install → 日志 + 结果）
    dsh_launcher.cpp   外部服务启动器（fork+exec dsh web → 端口捕获）
    common/
      child_process_utils.h  公共工具（fork+exec / 结果文件 / 路径辅助）
  src/main/ets/
    entryability/EntryAbility.ets   入口（onDestroy 清理 self-started dsh）
    pages/Index.ets                 主页：8 状态机 + ArkWeb 壳 + 连接指示器
    pages/Settings.ets              设置页（安装状态 / 服务管理 / 后端地址 / 自动启动 / 工作区）
    common/ServerDiscovery.ets      探活 + __DSH_BOOT__ 指纹校验
    common/ServerSettings.ets       地址与开关持久化（preferences）
    hdsh/bootstrap/DshBootstrap.ets 内嵌运行时引导（解压 rawfile + 启动子进程 + 轮询）
    hdsh/brew/
      BrewChecker.ets             安装检测（childProcess + 文件探测降级）
      BrewInstaller.ets           一键安装（childProcess + 进度监控 + 超时）
    hdsh/service/
      DshServiceManager.ets       服务生命周期管理（启停/重启/状态/PID 记录）
    hdsh/access/
      WorkspaceAccess.ets         工作区授权（DocumentPicker + persistPermission）
      OhosInfoBridge.ets          鸿蒙信息桥（设备信息 JSON）
    hdsh/utils/Logger.ets         日志工具（hilog 封装）
  src/main/resources/rawfile/       dsh/busybox/pnpm（构建产物，gitignore）
reference/           deepseek-harness 上游源码（仅参考，不参与构建）
scripts/             构建与部署脚本（详见各脚本头部说明）
  install-brew.sh     安装 Harmonybrew（缺失时自动补）
  install-dsh.sh      一键装 dsh（自动链 install-brew.sh）
  start-dsh-resident.sh  外部 dsh 后台常驻（自脱离 + 崩溃自愈 + TERM 可停）
  upgrade.sh          升级 Harmonybrew + dsh
  fetch-busybox.sh    下载 busybox（arm64，含 ELF 三重校验）
  fetch-pnpm.sh       下载 pnpm standalone（arm64）
  prepare-dsh-env.sh  生成 rawfile/dsh（npm 安装 + OHOS 适配）
  apply-dsh-ohos-adapt.sh  dsh 运行环境 OHOS 适配（stub 原生模块 + bundle patch）
  build-libnode.sh    自建 libnode.so（OHOS SDK clang + node 22 LTS 源码）
```

## 开发进度

### 已完成

| 阶段 | 内容 | 状态 |
|---|---|---|
| SDK 配置 | `build-profile.json5` compatibleSdkVersion `6.1.0(23)`，oh-package.json5 / hvigor-config modelVersion `6.1.1` | ✅ |
| C++ 模块 | `dsh_host.cpp` (原有) + `brew_check.cpp` / `brew_installer.cpp` / `dsh_launcher.cpp` + `common/child_process_utils.h` | ✅ |
| ArkTS 业务模块 | `BrewChecker.ets` / `BrewInstaller.ets` / `DshServiceManager.ets` | ✅ |
| 主页 UI | 8 状态机 (checking→installing→starting→discovering→booting→guide→web→error) + 连接状态指示器 | ✅ |
| 设置页 | 安装状态展示 / 一键安装 / 服务启停 / 后端地址 / 自动启动 / 工作区授权 | ✅ |
| EntryAbility | onDestroy 清理 self-started dsh 生命周期 | ✅ |
| 权限与资源 | RUNNING_LOCK 权限 / 连接状态颜色资源 / 安装场景字符串 | ✅ |
| 编译验证 | `BUILD SUCCESSFUL` (API 24 SDK，22s) | ✅ |

### 待完成

| 阶段 | 内容 | 依赖 |
|---|---|---|
| API 26 升级 | `compatibleSdkVersion` → `"7.0.0(26)"`，oh-package.json5 modelVersion → `"26.0.0"` | DevEco Studio 26.0.0 Beta1+ (携带 API 26 SDK) |
| 嵌入式运行时构建 | `rawfile/dsh` (prepare-dsh-env.sh) / `libnode.so` (build-libnode.sh) | arm64 真机环境 |
| 真机功能验证 | 安装检测 → brew install → 服务启动 → Web UI 全流程 | 签名配置 + 鸿蒙 PC 真机 |
| 内嵌模式验证 | 卸载外部 dsh → 验证内嵌模式自动降级启用 | libnode.so + rawfile/dsh 就绪 |
| 弃用 API 修复 | `router.back()` / `promptAction.showToast()` / `getContext()` 等 API 24 弃用警告 | 可在 API 26 升级时一并处理 |
| 键盘快捷键 | Ctrl+R 刷新 / Ctrl+, 设置 / Ctrl+Q 退出 | API 26 的 InputMethod Kit |
| 端口动态发现 | `dsh web --port 0` + readiness line 解析 (dsh_launcher.cpp 已实现) | 真机验证 |

### 参考项目

| 项目 | 来源 | 借鉴点 |
|---|---|---|
| [chentao326/dsh-gui](https://github.com/chentao326/dsh-gui) | macOS Swift + WebKit | 服务发现 + `__DSH_BOOT__` 指纹校验 + 自启动生命周期 (self-started 才 kill) + `--port 0` 动态端口 + 键盘快捷键 |
| [MakeBlackSheepGreat/dsh-OHDSH](https://gitcode.com/MakeBlackSheepGreat/dsh-OHDSH) | HarmonyOS 6.1 / API 23 | childProcessManager + libdsh_host.so (dlopen libnode → node::Start) + busybox 环境注入 + 沙箱适配 (W^X / seccomp / TMPDIR) + pnpm standalone |

## FAQ

**白屏/一直转圈？** 确认后端正在运行；浏览器访问 `http://127.0.0.1:8080` 或 `http://127.0.0.1:3080`
应能打开官方界面。端口被非 dsh 程序占用时指纹校验会失败，客户端会落到引导页。

**应用内安装失败？** 安装日志展示在安装进度区域，根因可能是网络问题或沙箱限制。
可点「跳过，手动安装」后在终端执行 `brew install deepseek-harness`。

**内嵌启动失败？** 引导页会展示 node 日志尾部（沙箱 `files/log/node-*.log` 回读）作为根因；
可点「重新连接」重试，或关闭自动启动后在终端手动启动外部后端。

**退出应用后 dsh 还在跑吗？** 取决于谁启动的：由本应用启动的 dsh 会随应用退出而停止；
用户在终端手动启动的 dsh 不受影响。

**为什么不用 Electron / 只靠外部 brew？** dsh 后端需要 Node.js ≥22 与原生模块，鸿蒙应用沙箱
无法内嵌运行 ELF 可执行文件，也无法 exec 应用目录里的二进制；因此采用 HDSH 验证过的方案：
`childProcessManager` 拉起 native 子进程 + `dlopen(libnode.so)` 在进程内跑 node，客户端
打开即自动拉起服务，无需用户操作终端。
