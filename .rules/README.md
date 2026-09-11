# NGF 规则库 (.rules/)

本目录是 NGF 框架的**技能规则库**，面向所有 AI 编程助手（Agent/LLM）和 Vibe Coding 场景。

每份规则文件描述一种可复用的开发技能，包含：背景知识、使用前置条件、标准实现模式、关键代码片段和注意事项。

规则库采用**自动触发**机制：Agent 开始任务时必须先读取根目录 `AGENTS.md` 与本索引，再根据用户目标、目标文件、报错类型、涉及 API/组件/资源自动判断命中的技能文件，并在动手前完整阅读。

---

## 自动触发流程

1. **入口读取**：先读 `AGENTS.md`，再读 `.rules/README.md`。
2. **触发匹配**：根据任务目标、文件路径、源码类型、报错信息、UI/资源/API 关键词匹配下表技能。
3. **完整阅读**：命中的技能文件必须从头到尾阅读，不只看标题或触发条件。
4. **项目规则读取**：存在 `.agent-rules/README.md` 时，读取其索引、`project-rules.md` 的全部 `active` 条目和存在时的 `preferences.local.md`；只将有效规则纳入当前任务。
5. **形成记忆**：阅读后在本次会话内形成“任务规则记忆”，至少覆盖硬性禁止项、标准模式、关键路径、验证方式和适用的项目规则/个人偏好。
6. **持续回看**：修改、复核、交付前都要回看本次任务命中的规则；上下文压缩、中断恢复、目标切换或新增报错后重新扫描并重读有效项目规则。
7. **沉淀边界**：共享 `AGENTS.md` 与 `.rules/` 只有开发者明确要求时才更新；已验证的当前项目/App 专属规则和非敏感长期偏好可按 `skill-project-rule-governance.md` 自动写入 `.agent-rules/`，但不能越级写入共享规则。
8. **本地事实**：陌生环境中新探测到的机器路径、设备 target、命令验证结果写入 `.local-rules/*.local.md`；不要把本机事实直接写进共享 `.rules/`。

---

## 规则文件列表

| 规则大类 | 具体技能文件 | 自动触发时机 |
|---------|-------------|-------------|
| **启动/环境** | [skill-llm-onboarding.md](skill-llm-onboarding.md) | Agent 新会话、首次接触项目、中等及以上复杂任务、SDK/Hvigor/DevEco 环境异常、构建/预览/运行前尚未确认命令环境。 |
| **启动/环境** | [skill-local-rules.md](skill-local-rules.md) | 陌生机器、环境漂移、本机 SDK/IDE/Hvigor/HDC/HDB/设备 target 探测结果需要保存到 `.local-rules/`。 |
| **快速开发** | [skill-scaffold-page.md](skill-scaffold-page.md) | “生成页面”“新建页面”“新建路由”“脚手架页面”等从零创建页面任务。 |
| **快速开发** | [skill-component-reuse.md](skill-component-reuse.md) | 页面或 `entry` 层新增功能前；准备新增 Dialog、Logger、网络、哈希、标题栏、工具箱、窗口辅助等通用能力。 |
| **页面设计** | [skill-hds-page-design.md](skill-hds-page-design.md) | 新建 `pages/ngf/` 页面；涉及 HDS 导航、顶栏、安全区、沉浸式底板、路由常量或 `buildNavDestination`。 |
| **页面设计** | [skill-hds-tab.md](skill-hds-tab.md) | 修改 `HdsTabs`/`Tabs`、底部标签栏、浮动样式、毛玻璃材质或底部安全区避让。 |
| **框架能力** | [skill-manager-apis.md](skill-manager-apis.md) | 接入主题、深色模式、语言、相对时间、视效档位、握持感知、管理器订阅和取消订阅。 |
| **框架能力** | [skill-system-tasks.md](skill-system-tasks.md) | 后台下载、文件上传、数据同步、常驻通知、进度通知、任务派发、系统事件订阅。 |
| **框架能力** | [skill-window-management.md](skill-window-management.md) | 多窗口、多实例任务卡片、应用内悬浮窗、子窗口、`MultitonEntryAbility`、`createSubWindow`。 |
| **ArkTS 基础** | [skill-arkts-standards.md](skill-arkts-standards.md) | 编写或修改任意 `.ets` 文件；检查 ArkTS 语法、TS 到 ArkTS 差异、语法合规。 |
| **ArkTS 基础** | [skill-arkts-types.md](skill-arkts-types.md) | Map/Array/ForEach/LazyForEach、catch、显式泛型、any/unknown 类型问题。 |
| **ArkUI 基础** | [skill-arkui-knowledge.md](skill-arkui-knowledge.md) | ArkUI 组件、布局、状态装饰器、渲染控制、导航、对话框、Toast、声明式 UI。 |
| **问题修复** | [skill-arkts-error-fixes.md](skill-arkts-error-fixes.md) | 编译失败、ArkTS 类型错误、构建报错、常见 API 类型不匹配。 |
| **问题修复** | [skill-arkts-runtime-fix.md](skill-arkts-runtime-fix.md) | 运行时崩溃、闪退、白屏、jscrash、faultlog、hilog、未捕获异常。 |
| **问题修复** | [skill-arkts-debug.md](skill-arkts-debug.md) | 运行时调试、日志插桩、假设验证、运行行为确认。 |
| **设备调试** | [skill-device-hdc-debug.md](skill-device-hdc-debug.md) | `hdb`/`hdc`、模拟器/真机连接、HAP 安装、应用启动/停止、HiLog、bugreport、`aa appdebug`。 |
| **UI 规范** | [skill-ui-symbols.md](skill-ui-symbols.md) | UI 图标、状态提示、符号标识、发现或准备新增 Emoji。 |
| **UI 规范** | [skill-i18n.md](skill-i18n.md) | 新建 UI、修改页面文案、Toast/Dialog 文案、HDS 导航标题、面向用户文本。 |
| **项目治理** | [skill-project-rule-governance.md](skill-project-rule-governance.md) | 项目规则、Agent Harness、持续性用户偏好、项目级架构/产品决策；发现已验证重复模式；需要操作 `.agent-rules/`。 |
| **应用启动** | [skill-ngf-app-harness.md](skill-ngf-app-harness.md) | 使用 NGF 新建、迁移、拆分或长期维护独立 App/应用模块；为 App 建立专属规则与 Harness。 |
| **应用发布** | [skill-app-release.md](skill-app-release.md) | 修改应用名、包名、图标、版本号、签名证书、p12/csr、打包发布、AGC 上架。 |
| **规则维护** | [skill-rules-update.md](skill-rules-update.md) | 开发者明确要求新增、修改、合并、删除、自动触发化或沉淀 `.rules/`/`AGENTS.md` 规则。 |

---

## 阅读顺序建议

- **常规代码任务**：`skill-llm-onboarding.md` -> `skill-component-reuse.md` -> 目标领域技能。
- **陌生环境/环境漂移**：`skill-llm-onboarding.md` -> `skill-local-rules.md` -> `.local-rules/README.md`。
- **任意 `.ets` 修改**：`skill-arkts-standards.md` 必读；涉及集合/回调再读 `skill-arkts-types.md`；涉及 UI 再读 `skill-arkui-knowledge.md`。
- **新建 HDS 页面**：`skill-scaffold-page.md` -> `skill-hds-page-design.md` -> `skill-i18n.md` -> `skill-ui-symbols.md`。
- **新建 NGF App/应用模块**：`skill-ngf-app-harness.md` -> `skill-project-rule-governance.md` -> `skill-component-reuse.md` -> 目标领域技能。
- **项目规则/偏好/Harness**：`skill-project-rule-governance.md` -> 目标领域技能；涉及共享框架规则时再等待开发者明确触发 `skill-rules-update.md`。
- **构建或编译报错**：`skill-arkts-error-fixes.md` -> 相关 API/页面技能；运行时问题再读 `skill-arkts-runtime-fix.md` 与 `skill-arkts-debug.md`。
- **设备端调试/启动**：`skill-device-hdc-debug.md` -> `skill-arkts-debug.md` 或 `skill-arkts-runtime-fix.md`。
- **规则库维护**：`skill-rules-update.md` -> 被修改的目标规则文件 -> `AGENTS.md` 与本索引同步复核。

> 主规范文件为根目录 `AGENTS.md`，本规则库是对 `AGENTS.md` 的具体技能补充，两者互为参考，`AGENTS.md` 优先级更高。
