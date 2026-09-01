# skill: 签名 / 发布

适用：签名配置、证书、ACL 权限、上架。

## 要点

- 用 DevEco 自动签名（Project Structure → Signing Configs）；26.0.0 以下非企业受限权限支持自动签名授权。
- 第三方自签（`hap-sign-tool`）无法授权 ACL 权限 → 带受限权限的 HAP 装不上。
- `RUNNING_LOCK`（`availableType=SYSTEM`）第三方声明必装不上，**不要**加。
- `CUSTOM_SANDBOX` 等 `system_basic` 为 `system_grant`，安装时由签名 ACL 授予；运行时只需 `checkAccessTokenSync` 记录状态。
- 签名材料与证书**不提交仓库**，仅本机（`.gitignore` 已忽略）。
