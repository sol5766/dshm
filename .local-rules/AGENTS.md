# .local-rules Agent 规则

本目录只保存当前机器的本地事实和验证结果。

- 可以读取和更新 `*.local.md`，用于记录 SDK/IDE/Hvigor/HDC 路径、设备 target、命令实测结果和本机特有问题。
- 不要把共享 `.rules/` 的大段规范复制到本目录。
- 不要写入密钥、证书密码、token、账号、私有服务地址等敏感信息。
- 如果发现的是跨机器通用规则变化，应回到根目录规则体系，按 `.rules/skill-rules-update.md` 流程处理。
- `*.local.md` 默认不提交到 Git；提交时只应包含本目录的索引、基础规则和本文件。
