# DSHM

DSHM 是面向 HarmonyOS Next 的 DSH（DeepSeek Harness）运行环境实现。应用在系统沙箱中加载 DSH 运行时、busybox 与 pnpm 环境，启动本地 DSH Web 服务后，通过 ArkWeb 加载 `http://127.0.0.1:3080`。

## 当前状态

- `EntryAbility` 加载 `pages/dshm/DshmWebPage`，完成 DSH 环境解压 → busybox 就绪 → native 子进程启动 DSH web server → ArkWeb 加载 WebUI 的端到端闭环
- **两种运行模式**（Harness → 运行模式，写在 `<filesDir>/runtime-mode.txt`）：
  - `auto`（默认）：设备上存在 Harmonybrew 版 dsh 时**优先用宿主 dsh**（系统 node，启动约 **9s**）
  - `host`：强制宿主 dsh（`~/.harmonybrew/bin/dsh`）
  - `embedded`：用 HAP 内置 `libnode` + `rawfile/dsh` 环境，`--jitless`（启动约 **11.4s**）
  - ⚠️ 两种模式的 `$DSH_HOME` 不同（host = `/storage/Users/currentUser`、embedded = `<filesDir>/home`），**会话库互不可见** —— 排查"会话没了"先看 `runtime-mode-active.txt`
- 内置 busybox 兜底 applet：ash/bash/hush、bzip2/xz、hexdump、less、nc、unzip、vi（其余由系统 toybox 补齐）
- 内置 pnpm，插件安装通过同进程 Worker 桥接执行
- 工作区目录授权 + 持久授权，可同步到应用沙盒 workspace
- **App 内无在线升级**：菜单只有本地功能（主页 / 关于版本 / 运行模式 / 检查 App 更新 / 重置运行环境 / 重启服务，编辑菜单含刷新与 zsh 终端）；升级 dsh 版本 = 重建环境 + 装新 HAP，见 [docs/dsh-version-upgrade.md](docs/dsh-version-upgrade.md)
- **环境已瘦身**：`rawfile/dsh` 由 253.5MB / 26,762 文件降到 **110.7MB / 12,485 文件**，HAP 由 385MB 降到 **238MB**、安装耗时 60s → **9.8s**；由 `scripts/prune-dsh-env.mjs` 完成并带**包入口自检**
- 支持设备形态：phone、tablet、2in1、car、tv、wearable

## 运行时约束（真机实测）

- **`--jitless` 必须**（仅 `embedded` 模式）：沙箱 W^X 禁止创建可执行内存，内置 node 以 `--jitless --expose-internals` 启动，由 `_fetch-shim.cjs` 提供 Web 全局与 WebAssembly 垫片
- **ArkTS http 探测 loopback 不可靠**：UI 就绪判定改为读 node 日志标记（`dsh web:`），不依赖 ArkTS http 探测 3080
- **libnode 需 native 加固**：`DT_NEEDED` 链接固定加载顺序 + io_uring `bl syscall` 打补丁回退 epoll，由准备脚本完成后进入 `entry/libs/arm64-v8a/`
- **HAP 不压缩存储**：`rawfile` 每减 1MB，HAP 就少 1MB —— 体积优化主要靠裁剪环境文件（判据必须是"平台构建产物"形状，不能按路径里出现 `win32` 就删，详见升级手册 §4.1）

## 目录

```text
DSHM/
├── entry/                 # 主应用层、EntryAbility、ArkWeb 页面与运行时桥接
├── tools/                 # 图标生成等开发工具
└── AGENTS.md              # 工作区协作规范
```

`entry/src/main/resources/rawfile/dsh/`、`busybox/` 与 native 运行时文件随 HAP 分发，设备端由引导流程解压。

## 开发环境

1. 使用 DevEco Studio 打开仓库根。
2. 在 DevEco Studio 签名设置中配置开发签名（调试机登录后自动签名）。
3. 使用 Hvigor 构建 `entry` 模块并安装到设备。

## 许可证

MIT，见 [LICENSE](LICENSE)。