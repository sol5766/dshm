# NGF 本地规则库 (.local-rules/)

本目录用于保存**当前机器、当前用户、当前设备、当前工具链**的实测事实。它和共享 `.rules/` 分工不同：

- `.rules/` 保存跨机器通用技能、流程和约束。
- `.local-rules/` 保存本机事实、命令验证结果和本机特有注意事项。

Agent 在开始任务时，应先读取根目录 `AGENTS.md` 与 `.rules/README.md`，再读取本索引和相关本地文件。

---

## 读取顺序

1. 读取 `base-local-rules.md`，确认本地规则库边界。
2. 如果 Agent 支持目录级 `AGENTS.md`，读取本目录的 `AGENTS.md`。
3. 按任务读取相关 `*.local.md` 文件。
4. 如果不存在相关 `*.local.md`，先执行非破坏性探测命令，再写入新的本地事实文件。

---

## 推荐本地文件

| 文件 | 记录内容 |
|------|----------|
| `current-machine.local.md` | SDK、IDE、Hvigor、Node、Python、工作区路径等本机事实 |
| `device-hdc.local.md` | HDC/HDB 路径、设备 target、安装/启动/日志命令实测结果 |
| `build-commands.local.md` | 本机可用构建命令、构建产物路径、失败命令和原因 |
| `known-issues.local.md` | 本机特有问题、临时规避方式、仍需人工确认事项 |

`*.local.md` 默认不提交到 Git。共享规则需要更新时，应另走 `.rules/skill-rules-update.md` 流程。

---

## 写入要求

- 必须写明探测日期、适用范围、验证命令、结果和结论。
- 只记录本机事实，不复制共享规则库的大段内容。
- 不记录密钥、证书密码、token、账号等敏感信息。
- 发现共享规则与本机事实冲突时，当前任务先按本机事实执行；只有确认是跨机器通用变化时，才提示开发者更新共享规则。
