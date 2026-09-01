# DSHM 变更日志

所有重要变更记录在此。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

## [1.1.0] - 2026-09-02

### 新增

- **桌面式自绘标题栏**：窗口顶部集成 `HARNESS` / `EDIT` / `VIEW` / `WINDOWS` 四个下拉菜单、连接状态点，右上角为自绘的「最小化 / 最大化(还原) / 关闭」窗口控制按钮，与系统三键同一水平线；同时用 `setWindowDecorVisible(false)` 隐藏系统窗口装饰条，标题栏可按住空白处拖动（PanGesture，最大化状态下保持不还原）。
- **窗口管理**：标题栏三键与 `WINDOWS` 菜单均支持最小化 / 最大化 / 还原 / 关闭；最大化/还原状态在按钮图标间同步切换。
- **工程基建**：新增 `AGENTS.md` 与 `.rules/` / `.agent-rules/` / `.local-rules/` 规则库，统一 Codex / Claude / OpenCode 等 Agent 协作规范（参考 HDSH）。
- **统一错误处理**：新增 `ErrorUtils`（错误分类 / 转字符串 / 用户可读文案）。
- **事件总线**：新增 `EventBus`（对齐 DSH/Cordis 事件语义的 ArkTS 最小子集）。
- **文档体系**：新增 `docs/CHANGELOG.md`、`docs/build-notes.md`、`docs/migration-plan.md`。
- **真机回归**：新增 `scripts/ui-test-phone.sh`（冷启动链路白屏 / 窗口比例 / 截图留档）。

### 调整

- **菜单归属重组**：`刷新` 移入 `EDIT`；`设置` 与 `主页`（原「3080」，`onGoDefaultUrl`）移入 `HARNESS`；右侧按钮区仅保留连接状态与窗口控制键。
- **视图菜单精简**：删除无实际效果的「切换左栏 / 切换右栏」，仅保留 主题切换 / 放大 / 缩小 / 重置缩放。
- **窗口菜单精简**：删除「新建窗口」（单实例下无效），保留 最小化 / 最大化 / 还原 / 关闭窗口。
- **标题栏视觉**：整体缩小（高度 38→30、字号/控件尺寸同步调小），统一浅色标题栏 + 深色文字，避免默认按钮配色造成的杂乱。

### 修复

- **「重启客户端」只关闭未重开**：将 EntryAbility `launchType` 改为 `multiton`，重启时序改为「先停自启服务（避免旧实例 `onDestroy` 误停新实例服务）→ `startAbility` 新建实例 → 成功后 `terminateSelf` 关旧实例」；失败时弹出提示且不关闭当前窗口。
- **`WINDOWS` 菜单最小化 / 最大化 / 还原不生效**：窗口操作统一移到 `Index` 取 `UIAbilityContext`（菜单弹层中组件内 `getUIContext` 不可靠），并对菜单触发的窗口操作做短延迟执行（等待菜单关闭、主窗口回前台）。
- **点击菜单导致最大化被还原**：标题栏拖动由「触摸按下即 `startMoving()`」改为「`PanGesture` 超过阈值才触发」，且最大化/全屏时保持最大化不还原。
- **`新建会话` 不响应**：增强注入脚本的匹配范围（覆盖 `button/a/[role=button]/[aria-label]/data-command/data-testid` 的文案与属性前缀）。

## [Unreleased]

（预留：升级 API 26、内置 node 方案、弃用 API 清理、键盘快捷键与多窗口等，见 `docs/migration-plan.md`。）

## [2026-08-25]

### 已完成（基于 git 历史）

- 冷启动自动拉起修复 + 一键安装闭环 + 未安装引导 + 文档整理。
- 外部 dsh 架构梳理（探活 → NAPI fork+exec → 指纹校验 → ArkWeb 接入）。
- 应用内安装 Harmonybrew / DeepSeek Harness。
- 设置页：安装状态 / 服务管理 / 后端地址 / 工作区授权。
- 退出自动清理自启动 dsh 进程。

## [2026-08-22]

### 起始

- 升级至 HarmonyOS 7 API 26 与初始提交；项目定位为 DeepSeek Harness 鸿蒙 PC 客户端。
