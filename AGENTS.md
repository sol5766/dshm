# AGENTS

本文件是 DSHM 仓库的统一代理工作规范，供 Codex、Claude Code、OpenCode 等支持 `AGENTS.md` 的代理读取。
目标：让 Agent 始终以「外置 `dsh` + ArkWeb 壳」的架构视角理解本仓库，而不是把它当成一个普通单页应用。

## 1. 适用范围与优先级

- 用户明确指令优先于本文件。
- 本文件优先于 `.trae` / `.windsurf` / `.cursor` 等分散规则。
- 读写文件统一使用 UTF-8（无 BOM）；禁止依赖系统默认编码。
- 涉及 HarmonyOS API / 废弃接口 / ArkTS 限制时，先查官方文档与声明定义，再结合源码分析。
- 修复须保持功能等价；侵入性修改先备份（`.bak`）。
- 默认不自动编译 / hvigor 构建 / 预览器运行；仅在用户要求或任务本身是构建/运行排查时才执行。
- 本仓库存在用户未提交改动（`Index.ets`、`build-profile.json5` 等）。不覆盖用户改动；改动前先 `git status`，只改本任务目标文件。

## 2. 架构基线（不可破坏）

- DSHM = DeepSeek Harness 鸿蒙 PC 客户端：**ArkUI 壳 + ArkWeb 全屏加载官方 Web UI**。
- 后端为**外置 `dsh web`**（brew 用户域），不是内置运行时；`DshBootstrap` 为「保留未启用」。
- 冷启动主链路：TCP 探活（3080/8080）→ `NAPI fork+exec dsh web` → `__DSH_BOOT__` 指纹校验 → ArkWeb 接入。
- **关键约束**：`childProcessManager.startNativeChildProcess` 拉起的 native 子进程在独立 netns，ArkWeb 连不上；
  必须用 **NAPI 在应用主进程内 `fork+exec`**，子进程才与 ArkWeb 同网络空间。
- `/storage/Users` 是 `hmmac=use_task` 按任务隔离视图；安装/检测/拉起必须统一在 **fork 子进程（自定义沙箱）上下文**做，主进程 `access()` 用户目录不可靠。
- 工具链子进程先 `cd "$HOME"` 再执行（brew 拒绝不可读 cwd）。
- 权限收敛在 6 个（见 README），**不要**声明 `ohos.permission.RUNNING_LOCK`（`availableType=SYSTEM`，装不上）。

## 3. 任务规则库（`.rules/`）

开始任务前先读 `.rules/README.md`，按触发条件命中技能文件，命中后**先从第一个读到最后一个再动手改源码**。
规则文件是「技能补充」，优先级低于本文件、高于自由发挥。

## 4. 本地事实边界

- 新探测到的本机路径 / 设备 target / 命令验证结果写入 `.local-rules/*.local.md`，不要直接回写 `.rules/` 或本文件。
- 只有跨机器通用规则变化才进入共享规则更新流程（需开发者触发 `skill-rules-update.md`）。

## 5. 关键文件索引

- 冷启动 / 探活：`entry/src/main/ets/common/ServerDiscovery.ets`、`entry/src/main/ets/hdsh/service/DshServiceManager.ets`
- NAPI 拉起：`entry/src/main/cpp/dsh_launcher.cpp`、`entry/src/main/cpp/common/child_process_utils.h`
- 安装 / 检测：`entry/src/main/cpp/brew_installer.cpp`、`entry/src/main/cpp/brew_check.cpp`、`entry/src/main/ets/hdsh/install/InstallManager.ets`、`entry/src/main/ets/hdsh/brew/BrewChecker.ets`
- 设置 / 工作区：`entry/src/main/ets/pages/Settings.ets`、`entry/src/main/ets/hdsh/access/WorkspaceAccess.ets`
- 诊断日志：`entry/src/main/ets/hdsh/utils/Logger.ets`、`entry/src/main/cpp/dsh_launcher.cpp`（`PhysLog`）
