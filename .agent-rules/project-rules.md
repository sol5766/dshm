# 项目规则（DSHM）

## 产品定位

- DeepSeek Harness 鸿蒙 PC 客户端：外置 `dsh web`（brew 用户域）+ ArkWeb 全屏加载官方 Web UI。
- 保持架构简单：不做自研原生 harness / LLM 内核；DSH 功能全部来自官方 WebUI。

## 交付即偏好

- 冷启动必须「探活 → 拉起 → 指纹 → 接入」，缺 dsh 时引导一键安装。
- 安装 / 检测结果以 fork 子进程上下文为准；不采信主进程 `access()`。
- 诊断可观测（物理机日志镜像）是硬要求，新增流程必须带日志。
- 权限只增不减的需有签名 ACL 依据；不引入 `RUNNING_LOCK`。

## 不做的事

- 不把大型二进制、签名材料、本机路径提交仓库。
- 不引入整套 DI / 大型框架；只按需摘轻量组件（如 `ErrorUtils`、`EventBus`）。
