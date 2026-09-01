# DSHM 迁移方案

目标：在保持「外置 dsh + ArkWeb 壳」架构不变的前提下，逐步消除过期 API、升级目标版本、补齐可用性短板。

## 待办总览

1. **API 26 升级**：`compatibleSdkVersion` → `7.0.0(26)`，逐项核对废弃/变更 API。
2. **内置 node 方案**（可选）：node 24 libnode，解决 undici WASM 后可用；`scripts/build-libnode.sh` 已就绪。
3. **弃用 API 修复**：清理 DevEco 警告与 `@deprecated` 调用。
4. **键盘快捷键与交互**：补齐桌面形态快捷键、窗口管理。

## 分阶段

### 阶段一：API 版本与编译基线

- 在 DevEco 同步通过后，提升 `compatibleSdkVersion` / `compileSdkVersion` 到目标版本。
- 编译报错逐条按官方迁移指南处理（`.ets` 中被替换为 `@kit.ArkUI` 等 new kit 导入）。
- 更新 `docs/CHANGELOG.md` 与 `README` 的版本基线描述。

### 阶段二：运行时与原生边界（视需要）

- 确认 `CUSTOM_SANDBOX` / `ACCESS_USER_FULL_DISK` 等在目标版本下的授予与行为。
- 若走内置 node：验证 node 24 `--jitless` 下 `WebAssembly` 正常；不再需要 `--jitless` 时移除相关限制。

### 阶段三：体验增强

- 键盘快捷键、多窗口（`MultitonEntryAbility` 思路可从 HDSH 借鉴）、桌面卡片。
- 引用 `EventBus` 打通 ArkWeb ↔ 设置 ↔ 服务生命周期的事件流。
- 用 `ErrorUtils` 统一错误分类与用户文案。

## 回归约束

- 每次改动后运行 `scripts/ui-test-phone.sh`（冷启动链路白屏 / 窗口比例 / 截图留档）。
- 不破坏「探活 → 拉起 → 指纹校验 → ArkWeb 接入」主链路。
- 不提交签名材料与任何本机路径。
