# BrewDSH

面向 **HarmonyOS NEXT** 的 [DeepSeek Harness](https://deepseek.com) 客户端。

一句话：**把 dsh 这个"住在终端里的 AI 编程智能体"变成一个鸿蒙原生桌面应用** —— 双击图标就能用，
会话、插件市场、终端、工作区管理全在图形界面里，不需要你先打开命令行。

> 技术路线：**Harmonybrew 桥接（默认）+ 内嵌运行时（兜底）** 双模式。
> 运行时由 [Harmonybrew](https://harmonybrew.atomgit.com/) 提供（`brew install deepseek-harness`，原生 node + JIT），
> App 提供图形外壳、会话管理、插件市场接入与内嵌 jitless 兜底环境。

姊妹项目 `dsh-OHDSH` 走"整环境打进 HAP"的纯内嵌路线（见其仓库 tag `embedded-runtime-complete`）。

---

## 功能

- **双运行模式**（Harness 菜单可切换，各自维护**独立会话库**）
  - **宿主模式（默认推荐）**：自动检测 `~/.harmonybrew/bin/dsh`，用 brew 安装的 dsh + 原生 node
    （JIT 可用，启动更快、插件能力完整）；
  - **内嵌模式**：应用自带 `libnode.so.137`，`--jitless` 运行，不依赖 Harmonybrew；
  - 未检测到 brew 时自动回退内嵌。切换模式会**先干净停掉旧实例再按新模式启动**（等标记文件确认端口释放，不抢 3080）。
- **插件市场**：内置 dshmarket（当前 1.45.1），可直接搜索/安装/卸载第三方插件 ——
  安装走 dsh 自带的**同进程 pnpm**（绕过鸿蒙"无法 spawn 可执行文件"的限制），装完即时热加载。
- **终端**：右侧边栏 pty 终端（zsh/bash），支持 **Tab 补全**、历史、Ctrl-C；
  触摸场景另有 `Tab`/`↑`/`^C` 按钮。
- **运行环境面板**：逐项展示 Harmonybrew / node / deepseek-harness / 全盘访问权限状态，
  一键安装/升级运行时（命令送入 pty 实时可见）。
- **系统集成（PC / 2in1）**：任务栏 **Dock 图标右键「重启」**（`quickBarManager`）、
  系统托盘图标左键唤回 + 右键「重启」（`statusBarManager`）、关闭窗口时隐藏到托盘常驻。
- **沉浸光感 UI**：面板卡片使用 `uiMaterial.ImmersiveMaterial`（API 26 空间化材质），带能力探测与降级。
- **权限引导**：`ACCESS_USER_FULL_DISK` / `CUSTOM_SANDBOX` 等受限权限通过 `openPermissionOnSetting` 引导开启。
- **品牌**：白底黑鲸鱼启动页 + 分层应用图标。

## 快速开始

### 1. 构建（命令行，Windows）

```powershell
$env:JAVA_HOME='C:\Program Files\Huawei\DevEco Studio\jbr'
$env:DEVECO_SDK_HOME='C:\Program Files\Huawei\DevEco Studio\sdk'
$env:PATH='C:\Program Files\Huawei\DevEco Studio\jbr\bin;'+$env:PATH
# 限制签名 JVM 堆，避免 "页面文件太小" 导致 SignHap 失败
$env:JAVA_TOOL_OPTIONS='-Xms16m -Xmx384m -XX:MaxMetaspaceSize=192m -XX:ReservedCodeCacheSize=64m'
$env:NODE_OPTIONS=''

& 'C:\Program Files\Huawei\DevEco Studio\tools\node\node.exe' `
  'C:\Program Files\Huawei\DevEco Studio\tools\hvigor\bin\hvigorw.js' `
  --mode module -p product=default assembleHap --no-daemon
```

产物：`entry/build/default/outputs/default/entry-default-signed.hap`（约 243 MB）。

> 首次在开发机上构建前，需要先准备内置环境树（`entry/src/main/resources/rawfile/dsh/`，约 12,400 个文件）。
> 该目录由 `scripts/prepare-dsh-env.sh` 生成（拉取 dsh + 打鸿蒙适配补丁 + 内置 dshmarket + 瘦身），
> 属于**生成物、不入库**（见 `.gitignore`）。

### 2. 侧载到设备

```powershell
& 'C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe' `
  install -r 'entry\build\default\outputs\default\entry-default-signed.hap'
```

首次启动会解压内置环境（约 12,400 文件 / 十几秒），随后自动拉起 dsh 并加载界面。

## 运行模式与数据位置

| | 宿主模式 | 内嵌模式 |
|---|---|---|
| 运行时 | Harmonybrew 的 dsh（`~/.harmonybrew/bin/dsh`）+ 原生 node | 应用自带 `libnode.so.137`（`--jitless`） |
| 会话库（DSH_HOME） | `<filesDir>/home-host/.dsh` | `<filesDir>/home/.dsh` |
| JIT | 原生 JIT | 无（沙箱 W^X 限制，靠 `_fetch-shim.cjs` 垫 Web 全局） |
| 适用 | 已装 Harmonybrew，追求性能与完整插件能力 | 未装 brew / 想零依赖体验 |

两种模式的会话、设置、凭据**互不可见**（各自独立维护），当前生效模式写在 `<filesDir>/runtime-mode-active.txt`。

## 目录

```text
BrewDSH/
├── entry/
│   ├── src/main/ets/
│   │   ├── entryability/          # EntryAbility：窗口、托盘、Dock 菜单注册
│   │   ├── backgroundability/     # 托盘保活 Ability（独立进程）
│   │   ├── dshm/
│   │   │   ├── bootstrap/         # DshBootstrap：环境解压/自愈、模式、启停
│   │   │   ├── system/            # 托盘、Dock 菜单、应用级动作、状态栏
│   │   │   ├── access/            # 工作区授权
│   │   │   ├── ui/                # 运行环境探测、沉浸材质、品牌
│   │   │   └── utils/             # 日志
│   │   └── pages/dshm/            # 主界面（ArkWeb + 终端侧边栏 + 菜单）
│   ├── src/main/cpp/              # dsh_host（native 宿主）、pty addon、node shim
│   └── src/main/resources/rawfile/dsh/   # 内置运行时环境（生成物，不入库）
├── scripts/                       # 环境准备与鸿蒙适配补丁（可复现）
└── docs/                          # 文档（见下）
```

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/pitfalls-and-gotchas.md`](docs/pitfalls-and-gotchas.md) | **踩坑点总表**（沙箱/native、环境树、双模式进程、profile 插件体系、pnpm、终端、PC 系统集成、构建打包、ArkTS）—— 移植或排障先看这份 |
| [`docs/device-runtime-fixes.md`](docs/device-runtime-fixes.md) | 早期设备运行时三大故障（jitless WASM、libnode 加固、loopback 探测）完整定位过程 |
| [`docs/dsh-version-upgrade.md`](docs/dsh-version-upgrade.md) | 升级 dsh 版本的完整手册（含环境瘦身判据） |
| [`docs/harmonyos-pc-dock-menu-research.md`](docs/harmonyos-pc-dock-menu-research.md) | 鸿蒙 PC Dock 右键菜单 / 左键唤回 / 优雅退出的官方能力调研 |
| [`docs/pc-tray-and-permissions.md`](docs/pc-tray-and-permissions.md) | PC 托盘保活与权限申请 |
| [`docs/runtime-environment-research.md`](docs/runtime-environment-research.md) | 运行时环境方案对比（含 HNP 路线评估） |
| [`docs/dsh-busybox-linux-env.md`](docs/dsh-busybox-linux-env.md) | 内置 busybox / Linux 工具链环境 |
| [`docs/progress.md`](docs/progress.md) | 开发进度记录 |
| [`.agent-rules/bug-log.md`](.agent-rules/bug-log.md) | Bug 档案（现象/根因/修复/验证，按时间倒序） |

## 运行时硬约束（真机实测，摘要）

- **内嵌模式必须 `--jitless`**：沙箱 W^X 禁止创建可执行内存（JIT 是"ACL + XPM 代码页签名"双重门，debug 签名过不了第二道）。
- **只有 el1 bundle 库目录可以 dlopen**：`.so` 必须随 HAP 打进 `libs/arm64/`，el2（filesDir）加载一律 `Permission denied`。
- **不能 execv 用户数据区的 ELF**：内嵌运行时只能「dlopen `libnode.so.137` + `node::Start`」，这也是 pnpm 必须同进程执行的原因。
- **就绪判定读日志标记**（`dsh web:`），不要用 ArkTS http 探测 loopback（不可靠，会让新旧实例抢 3080）。
- **停机用标记文件确认**（宿主 `host-stopped`、内嵌 `node-exited`），且内嵌停机由 native 父进程执行。
- **符号链接在鸿蒙可用**：dsh 的 profile fallback 就是符号链接，任何递归删除都要**入口先 lstat**，否则会顺链删光环境树。

完整清单见 [`docs/pitfalls-and-gotchas.md`](docs/pitfalls-and-gotchas.md)。

## 开发环境

1. DevEco Studio 打开仓库根；在签名设置里配置开发签名（调试机登录后自动签名）。
2. 若 `entry/src/main/resources/rawfile/dsh/` 为空，先在 WSL / Git Bash 里跑 `scripts/prepare-dsh-env.sh` 生成内置环境。
3. 用 Hvigor 构建 `entry` 模块并安装到设备（见上文命令）。

## 许可证

MIT，见 [LICENSE](LICENSE)。
