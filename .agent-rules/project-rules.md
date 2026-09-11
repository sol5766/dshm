# DSHM 项目专属规则登记册

本登记册只记录无法自然归入根 `AGENTS.md`、`.rules/` 或 `.local-rules/` 的 DSHM 工作区规则。所有 `active` 条目都必须在任务执行中遵守；`candidate` 条目仅用于后续验证，不能约束实现。

## Active Rules

### PR-001 项目专属规则的自动治理与执行

**状态**：active
**范围**：DSHM 工作区，以及后续在本仓库内创建或长期维护的应用模块。
**指令**：当用户表达持续适用的非敏感偏好，或任务产生有充分证据支持的项目/App 稳定模式、Harness 改进时，Agent 必须按 `.rules/skill-project-rule-governance.md` 提炼并写入正确层级；执行源码任务前必须读取并遵守所有 `active` 项目规则和不冲突的本地偏好。一次性判断保持为 `candidate` 或任务状态，除非用户提出相反要求。
**来源**：用户关于"DSHM 项目初始化时，Agent 应精心收集、提炼并遵守项目专属规则、Harness 和个人偏好"的明确长期指令。
**证据**：根 `AGENTS.md` 的 `1.3`、`5.4`、`5.6.3` 与 `.rules/skill-project-rule-governance.md` 已建立相应读取、提炼、冲突处理和验证流程。
**验证**：每次中等及以上任务在评估、实现、复核和交付前检查有效规则；交付时说明本次新增、修订、保留为候选或未沉淀的结论。
**更新时间**：2026-08-16

### PR-002 DSHM 应用层与框架层边界

**状态**：active
**范围**：`entry/`（DSHM 应用层）与 `ngf_framework/`（框架层）的全部源码。
**指令**：
1. DSHM 产品专属逻辑（harness 内核、插件系统、会话状态、模型适配、产品文案、业务流程）只能放在 `entry/` 层；禁止写入 `ngf_framework/`。
2. `entry/` 新增能力前优先复用 `ngf_framework` 已公开导出（`import { ... } from 'ngf_framework'`）；需要扩展框架时，先判断该能力是否服务多个 App，仅服务 DSHM 的能力应留在 `entry/` 层。
3. `ngf_framework/` 的修改必须遵循框架优先原则（见根 `AGENTS.md` 第 2.1 节），不得把 DSHM 业务规则反写为框架默认行为。
4. NGF 遗留的 `pages/ngf/` 演示页面是框架验证样本，DSHM 业务页面使用独立目录（如 `entry/src/main/ets/pages/dshm/`），两者保持边界。
**来源**：用户初始化 DSHM 时的项目目标（基于 NGF 全新实现 dsh）+ NGF `skill-ngf-app-harness.md` 第 4 节协作边界。
**证据**：根 `AGENTS.md` 第 2 节项目定位、`.rules/skill-ngf-app-harness.md`。
**验证**：代码评审时检查 import 来源与文件落位；DSHM 专属逻辑未进入 `ngf_framework`。
**更新时间**：2026-08-16

### PR-003 构建与验证默认策略

**状态**：active
**范围**：本仓库所有源码变更。
**指令**：默认不自动执行 hvigor 构建、打包或设备运行；只有用户明确要求，或任务本身就是编译、构建、运行问题排查时才执行。修改完成后不得因"收尾"而手动触发构建。完成标准以用户确认的验收条件为准，不以命令成功退出为准。
**来源**：NGF 根 `AGENTS.md` 既有规范（默认不自动构建）。
**证据**：根 `AGENTS.md` 第 1 节与 `.rules/skill-ngf-app-harness.md` 第 5 节。
**验证**：交付时说明本次是否执行了构建及理由。
**更新时间**：2026-08-16

### PR-004 DSHM 产品定位：DSH 鸿蒙全设备迁移

**状态**：active
**范围**：DSHM 产品目标、技术路线与交付边界。
**指令**：
1. DSHM 的目标是**在鸿蒙所有设备（phone/tablet/2in1/car/tv/wearable）上运行 DSH 能力**的鸿蒙原生全新实现；上游参照 DeepSeek Harness（`deepseek-ai/deepseek-harness`，v0.1.0-rc.5，MIT）。
2. 技术路线：ArkTS 重写 DSH 核心语义（事件溯源会话 + turn/step 循环 + 插件效果模型 + LLM/工具/MCP 契约），复用 NGF（ngf_framework）作为 UI/存储/网络/多窗口基础设施；详见 `docs/migration-plan.md`。
3. 里程碑顺序：M1 最小可用 harness → M2 上下文/设置 → M3 工具/MCP → M4 全设备适配。
4. 上游 dsh 处于开发者预览，DSHM 只锁定语义契约，不锁定源码；上游破坏性变更时按里程碑评审对齐。
**来源**：用户明确指令"基于NGF实现DSH的迁移工作，使得DSH能在鸿蒙所有设备上运行"（2026-08-16）。
**证据**：`docs/migration-plan.md`。
**验证**：每个里程碑交付对照 `docs/migration-plan.md` 第 6 节验收标准。
**更新时间**：2026-08-16

## Open Decisions

以下事项在用户确认前不得视为已定案的产品事实，不得写入框架规则：

- **bundleName**：当前值为 `com.dshm.agentic`（`AppScope/app.json5`）。用户 2026-09-10 提出「彻底去掉 agentic、以 dshm 为核心」，但鸿蒙规定 bundleName 必须 ≥3 段、以点分隔、7–128 字节（字面 `dshm` 非法），候选 `com.dshm.app` / `com.dshm.desktop` / `com.dshm.dshm` / `cn.dshm.app`，**最终值待用户确认**。改名后必须重新签名（证书绑定 bundleName；重签 p7b 同时会刷新 `acls.allowed-acls`，可顺带解除受限权限的安装拒绝）。
- **模型接入方式**：默认云端 API（DeepSeek 优先）；本地模型（MindSpore Lite）是否集成待产品决策。
- **首个可交付设备**：默认以 phone 为 M1 主目标设备，多设备适配在 M4 统一落地。

## Candidate Rules

当前没有待验证的候选规则。

## 条目格式

### PR-001 规则名称

**状态**：active / candidate / deprecated
**范围**：模块、页面、功能或交付场景
**指令**：满足什么条件时必须做什么，以及不适用的边界。
**来源**：用户长期指令 / 配置 / 已验证源码 / 官方文档。
**证据**：精确文件、命令输出或重复验证模式。
**验证**：交付时如何检查遵守情况。
**更新时间**：YYYY-MM-DD
