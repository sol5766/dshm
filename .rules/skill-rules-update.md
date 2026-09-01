# skill: 规则更新

适用：开发者明确要求新增/修改/合并/删除/自动触发化 `.rules/` 或 `AGENTS.md`。

## 流程

1. 读 `README.md`（索引）与受影响技能文件，确认现有约定。
2. 判断该规则属共享（`AGENTS.md`/`.rules/`）还是项目/本机（`.agent-rules/`/`.local-rules/`）。
3. 修改后同时更新 `.rules/README.md` 的命中表，防止漂移。
4. 变更记入 `docs/CHANGELOG.md`。

## 注意

- 不为一处问题临时加规则；只留跨模块、跨机器复用的规则。
