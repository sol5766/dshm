# 本机基线（示例，按实际填）

以下为本机探测到的环境事实，仅供当前工作区参考：

- node：`/storage/Users/currentUser/.harmonybrew/opt/node@24/bin/node`（brew 安装）
- hvigor：`6.23.15-next`，`modelVersion` 仅支持 `6.1.0`
- `DEVECO_SDK_HOME`：指向 brew 的 OHOS SDK 镜像（IDE 沙箱 `EACCES` 时使用）
- `hdc` target：由脚本/环境显式传入，不写死
- 已验证：`better-sqlite3`、`lightningcss` 等原生模块在 `openharmony-arm64` 上需自构建（参考 `docs/build-notes.md`）
