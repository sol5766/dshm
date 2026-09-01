# skill: 本地事实规则

适用：首次接触新机器/新工作区；探测到的本机路径、设备 target、命令验证结果。

## 用法

- 写入 `.local-rules/` 下的 `*.local.md`（如 `base-local-rules.md` 或新增 `device-xxx.local.md`）。
- 记录：本机 SDK/hvigor/node 路径、`hdc` target、`DEVECO_SDK_HOME`、已验证命令及输出、brew node 路径。
- 不回写 `.rules/` 或 `AGENTS.md`（那是跨机器通用规则）。
- 涉及签名、路径、token 的敏感信息保持本机，不提交仓库。
