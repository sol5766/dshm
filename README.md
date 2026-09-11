# DSHM

DSHM 是面向 HarmonyOS Next 的 DSH（DeepSeek Harness）运行环境实现。应用在系统沙箱中加载 DSH 运行时、busybox 与 pnpm 环境，启动本地 DSH Web 服务后，通过 ArkWeb 加载 `http://127.0.0.1:3080`。

## 当前状态

- `EntryAbility` 加载 `pages/dshm/DshmWebPage`，完成 DSH 环境解压 → busybox 就绪 → native 子进程（`libdsh_host` 内嵌 node `--jitless`）启动 DSH web server → ArkWeb 加载 WebUI 的端到端闭环
- 内置 busybox 兜底 applet：ash/bash/hush、bzip2/xz、hexdump、less、nc、unzip、vi（其余由系统 toybox 补齐）
- 内置 pnpm，插件安装通过同进程 Worker 桥接执行
- 工作区目录授权 + 持久授权，可同步到应用沙盒 workspace
- 支持设备形态：phone、tablet、2in1、car、tv、wearable

## 运行时约束（真机实测）

- **`--jitless` 必须**：沙箱 W^X 禁止创建可执行内存，embedded node 以 `--jitless --expose-internals` 启动，由 `_fetch-shim.cjs` 提供 Web 全局与 WebAssembly 垫片
- **ArkTS http 探测 loopback 不可靠**：UI 就绪判定改为读 node 日志标记（`dsh web:`），不依赖 ArkTS http 探测 3080
- **libnode 需 native 加固**：`DT_NEEDED` 链接固定加载顺序 + io_uring `bl syscall` 打补丁回退 epoll，由准备脚本完成后进入 `entry/libs/arm64-v8a/`

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