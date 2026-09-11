# DSHM 项目专属 Agent 规则登记册

本目录承接仅适用于 DSHM 工作区的架构补充、稳定项目决策和用户长期偏好，避免把它们误写为跨项目框架规则（NGF 共享规则）。

执行任务时，先读取根 `AGENTS.md`、`.rules/README.md` 和命中技能，再读取 `project-rules.md` 中所有 `active` 条目；存在 `preferences.local.md` 时也必须读取。候选条目不构成强制约束。

| 文件 | 用途 | 提交策略 |
|------|------|----------|
| `project-rules.md` | 已验证的 DSHM 项目专属规则、开放决策与候选规则 | 提交 |
| `preferences.local.md` | 当前用户的非敏感、长期工作区偏好 | 不提交 |
| `preferences.local.example.md` | 本地偏好格式示例 | 提交 |

创建、修订、升级或废弃条目前，必须遵循 `.rules/skill-project-rule-governance.md`。机器路径和设备事实仍归 `.local-rules/`；跨会话任务状态仍归 `.agent-state/`。
