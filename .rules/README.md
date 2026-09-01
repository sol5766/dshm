# .rules 技能规则库

本目录是对根 [AGENTS.md](../AGENTS.md) 的具体技能补充，优先级低于 `AGENTS.md`、高于自由发挥。
所有 Agent 开始任务前，先读本文件，按下表命中对应技能文件；命中后**先完整阅读该文件，再读取或修改目标源码**。

## 命中规则（满足任意一条即阅读）

| 规则文件 | 自动触发条件 |
|---|---|
| [skill-arkts-standards.md](skill-arkts-standards.md) | 编写或修改任意 `.ets`；涉及 ArkTS 语法/限制/TS→ArkTS 差异 |
| [skill-arkui-knowledge.md](skill-arkui-knowledge.md) | 涉及 ArkUI 组件、布局、状态装饰器、渲染控制、导航、对话框、声明式 UI |
| [skill-napi-launcher.md](skill-napi-launcher.md) | 涉及 NAPI 主进程 `fork+exec`、子进程网络命名空间、工具链 cwd、用户目录视图 |
| [skill-hvigor-build.md](skill-hvigor-build.md) | 涉及构建、hvigor、`modelVersion`、SDK/toolchain、出包、同步失败 |
| [skill-device-hdc-debug.md](skill-device-hdc-debug.md) | 涉及 `hdc`/`hdb`、模拟器/真机连接、HAP 安装、设备运行、HiLog、bugreport |
| [skill-signing-release.md](skill-signing-release.md) | 涉及签名、证书、`.p12`/`.csr`/`.p7b`、ACL 权限、AGC 上架 |
| [skill-error-runtime-fix.md](skill-error-runtime-fix.md) | 运行时崩溃、白屏、探活挂死、NAPI 调用异常、faultlog/hilog 诊断 |
| [skill-project-rule-governance.md](skill-project-rule-governance.md) | 涉及项目规则、Agent Harness、持续性用户偏好、`.agent-rules/` 读写 |
| [skill-rules-update.md](skill-rules-update.md) | 开发者要求新增/修改/合并/沉淀 `.rules/` 或 `AGENTS.md` |
| [skill-local-rules.md](skill-local-rules.md) | 首次接触新机器/新工作区；需要记录本机路径或命令验证结果 |

> 规则文件各自开头列出触发条件；内容与本表不一致时先以本表为准，并在规则维护任务中同步修正。
