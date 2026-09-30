# 安全策略

## 报告漏洞

请**不要**用公开 Issue 报告安全问题。

走 GitHub 私有安全公告：**[新建安全公告](https://github.com/sol5766/dshm/security/advisories/new)**

报告请包含：影响范围、复现步骤、受影响版本、你对严重程度的判断。能给最小复现的话，处理会快很多。

## 范围

本应用在鸿蒙端侧沙箱内运行，Host 只监听 `127.0.0.1`。以下属于本仓库的处理范围：

- 应用自身代码：`entry/`、`hostcore/`、`hostruntime/`、`appstate/`、`platform/`、`dshcompat/`
- 随包分发的运行时与原生库的**集成方式**：构建期签名、放置流程、`execve` 策略、`LD_PRELOAD` 垫片
- `tools/` 下的构建与检查脚本，以及它们的判据

以下**不属于**本仓库范围，请报到对应上游：

| 组件 | 上游 |
|---|---|
| DeepSeek Harness 本体与 Web 前端 | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) |
| Node.js | [nodejs/node](https://github.com/nodejs/node) |
| 其余第三方依赖 | 见各包自身的仓库 |

## 支持的版本

只有**最新 Release** 接受安全修复。本项目不分发旧版本的补丁。
