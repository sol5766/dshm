# AGENTS

本文件是本仓库统一的代理工作规范，目标是让 Codex、OpenCode、Claude Code 、Trae 等支持 `AGENTS.md` 的代理都能读取同一份规则，并且始终从 **NGF 框架工程** 的视角理解仓库，而不是把它误判成某个单一业务 App。

## 1. 适用范围与优先级

- 用户明确指令优先于本文件。
- 本文件优先于分散在 `.trae`、`.windsurf`、`.kiro`、`.cursor` 中的同类规则文件。
- 当前仓库已确认存在根目录 `AGENTS.md`；如后续子目录新增同名文件，则按更深层 `AGENTS.md` 优先。
- 每次进行文件读取、写入、修改时，必须显式使用 UTF-8 编码；禁止依赖系统默认编码。支持编码选项的写回操作统一使用 UTF-8（建议无 BOM）。
- 涉及 HarmonyOS Next 导入、引用、编译、运行、API 能力、废弃接口迁移时，必须优先参考最新官方文档与官方最佳实践。
- 需要解决报错或解释报错时，必须先查官方文档和相关声明定义，再结合源文件分析原因，最后给出修复方案。
- 修复方案必须保持原功能等价，避免引入新的问题。
- 对侵入性较强或高风险的修改，优先先做同目录 `*.bak` 备份再执行改动。
- 修复问题时默认不自动执行编译、打包、hvigor 构建或预览器运行；修改完成后也不需要因为“收尾”而手动再执行一次自动编译。只有在用户明确要求，或当前任务本身就是编译、构建、运行问题排查时，才进行相关操作。
- 修复完成后，必须再次检查是否符合 ArkTS 规则、当前仓库实际结构与本文件规范。
- 每次修复后都应回顾本次问题是否值得沉淀为长期规则；只有真正跨项目、跨模块复用的规则才能补充到本文件或 `.rules/`，且仍须由开发者明确触发 `skill-rules-update.md` 流程。当前工作区或未来 App 专属规则、Harness 和长期偏好按 `1.3` 与 `skill-project-rule-governance.md` 分层沉淀，不要为一次性问题临时加规则。
- 忽略本仓库中的 `--allowArbitraryExtensions` 相关问题，除非用户明确要求处理。

### 1.1 技能规则库（.rules/）

本仓库在根目录下设有 `.rules/` 技能规则库，是对本文件的**具体技能补充**，优先级低于本文件，但高于自由发挥。

所有 Agent 在开始任务前，必须把 `.rules/README.md` 当作规则索引入口，并按下表自动判断命中的技能文件。命中后应**先完整阅读对应文件，再动手读取或修改目标源码**；不要等待开发者再次提示。

### 1.1.1 自动触发与阅读记忆流程

1. **触发扫描**：先读取本文件、`.rules/README.md`，再按用户目标、目标文件路径、报错类型、涉及 API/组件/资源判断命中的技能文件。
2. **完整阅读**：命中的技能文件必须从头到尾阅读；如任务同时命中多个技能，按“环境/语法基础 -> 任务领域 -> 诊断/发布/规则维护”的顺序阅读。
3. **会话记忆**：阅读后在本次会话内形成一份简短“任务规则记忆”，至少记住适用范围、硬性禁止项、标准实现模式、关键文件路径和交付前检查点；后续修改、复核、交付都必须回看这份记忆。
4. **恢复重扫**：如果发生上下文压缩、长时间中断、切换目标文件或新增报错，必须重新执行触发扫描，必要时重读已命中的技能文件。
5. **规则沉淀边界**：共享 `AGENTS.md` 与 `.rules/` 的更新必须由开发者明确触发 `skill-rules-update.md` 流程；但项目或 App 专属的规则、Harness 和非敏感长期偏好，可按 `skill-project-rule-governance.md` 的证据标准由 Agent 自动收集、更新和执行。
6. **本地事实边界**：陌生环境中新探测到的本机路径、设备 target、命令验证结果，应写入 `.local-rules/*.local.md`，不要直接回写到 `.rules/` 或本文件；只有跨机器通用规则变化才进入共享规则更新流程。

| 规则文件 | 自动触发条件（命中任意一条即应阅读） |
|---------|-----------------------------------|
| [`.rules/skill-llm-onboarding.md`](.rules/skill-llm-onboarding.md) | Agent 新会话初始化、首次接触本项目、中等及以上复杂任务启动；遇到 SDK/Hvigor/DevEco 路径异常；需要构建、预览、运行前尚未确认命令环境 |
| [`.rules/skill-local-rules.md`](.rules/skill-local-rules.md) | 首次接触新机器、新工作区、新模拟器/真机；探测到 SDK/IDE/Hvigor/HDC/HDB/设备 target 与共享基线不同；需要记录本机事实或本机命令验证结果 |
| [`.rules/skill-component-reuse.md`](.rules/skill-component-reuse.md) | 任何页面或 `entry` 层新增功能前；准备新增 Dialog、Logger、网络、哈希、标题栏、工具箱、窗口辅助等通用能力；准备在业务层手写可由 `ngf_framework` 提供的基础能力 |
| [`.rules/skill-scaffold-page.md`](.rules/skill-scaffold-page.md) | 收到“生成页面”“新建页面”“新建路由”“脚手架页面”等指令；从零创建完整 HDS 标准页面 |
| [`.rules/skill-hds-page-design.md`](.rules/skill-hds-page-design.md) | 新建页面到 `pages/ngf/`；涉及 `HdsNavDestination`/`HdsNavigation` 布局；涉及顶栏配置、沉浸式底板、安全区；涉及 `NGFHdsTitleBarOptionsFactory`、`NGFImmersiveTopChromeUnderlay`；涉及路由常量注册或 `buildNavDestination` 分发 |
| [`.rules/skill-hds-tab.md`](.rules/skill-hds-tab.md) | 涉及 `HdsTabs`/`Tabs` 组件修改；涉及底部标签栏遮挡、贴边显示或安全区避让时；涉及 `barFloatingStyle` 浮动样式配置时 |
| [`.rules/skill-manager-apis.md`](.rules/skill-manager-apis.md) | 涉及主题切换/深色模式/`ngf_is_dark_mode`；涉及语言切换/`ngfI18nManagerFacade`；涉及视效档位/`ngfVisualEffectsFacade`/`hdsMaterial.MaterialLevel`；涉及握持感知/`ngfHoldingAwarenessFacade`；需要在 `aboutToAppear`/`aboutToDisappear` 中订阅或取消管理器回调 |
| [`.rules/skill-system-tasks.md`](.rules/skill-system-tasks.md) | 涉及后台下载、文件上传、数据同步、常驻通知、进度条通知、任务派发或系统事件订阅监听时 |
| [`.rules/skill-window-management.md`](.rules/skill-window-management.md) | 涉及多窗口、多实例任务卡片、应用内悬浮窗、子窗口、`windowStage.createSubWindow` 或使用 `MultitonEntryAbility` 动态拉起独立页面时 |
| [`.rules/skill-arkts-standards.md`](.rules/skill-arkts-standards.md) | 编写或修改任意 `.ets` 文件；涉及 ArkTS 语法规则、限制、TypeScript 到 ArkTS 差异、语法合规审查 |
| [`.rules/skill-arkts-types.md`](.rules/skill-arkts-types.md) | 涉及 ArkUI 组件中 Map 或 Array 的遍历（如 ForEach/LazyForEach）；异常捕获（catch）；需要显式类型推断以解决 any/unknown 编译报错 |
| [`.rules/skill-arkui-knowledge.md`](.rules/skill-arkui-knowledge.md) | 涉及 ArkUI 组件、布局、状态装饰器、渲染控制、导航、对话框、交互、组件 API、声明式 UI |
| [`.rules/skill-arkts-error-fixes.md`](.rules/skill-arkts-error-fixes.md) | 编译失败、ArkTS 类型错误、构建报错时；涉及 Notification/Window/AppStorage/IDataSource 等常见类型不匹配 |
| [`.rules/skill-arkts-runtime-fix.md`](.rules/skill-arkts-runtime-fix.md) | 运行时崩溃、闪退、白屏、jscrash 日志、未捕获异常、faultlog/hilog 诊断时 |
| [`.rules/skill-arkts-debug.md`](.rules/skill-arkts-debug.md) | ArkTS 项目运行时问题调试；涉及日志插桩、假设验证、运行时行为确认时 |
| [`.rules/skill-device-hdc-debug.md`](.rules/skill-device-hdc-debug.md) | 涉及 `hdb`/`hdc`、模拟器/真机连接、HAP 安装、命令行启动/停止应用、设备运行状态、HiLog、bugreport、`aa appdebug` 时 |
| [`.rules/skill-app-release.md`](.rules/skill-app-release.md) | 涉及修改应用包名、应用图标、版本号、打包发布、申请证书、生成 p12/csr 文件或上架 AGC 时 |
| [`.rules/skill-ui-symbols.md`](.rules/skill-ui-symbols.md) | 涉及在 UI 中添加图标、状态提示、字符串带图；发现或准备新增 Emoji 作为 UI 标识 |
| [`.rules/skill-i18n.md`](.rules/skill-i18n.md) | 涉及新建 UI 界面、修改页面文案、输出面向用户的 Toast/Dialog、配置 HdsNavigation/HdsNavDestination 标题时 |
| [`.rules/skill-project-rule-governance.md`](.rules/skill-project-rule-governance.md) | 涉及项目规则、Agent Harness、持续性用户偏好、项目级架构/产品决策；Agent 发现已验证的重复项目模式；需要创建、更新或读取 `.agent-rules/` 时 |
| [`.rules/skill-ngf-app-harness.md`](.rules/skill-ngf-app-harness.md) | 用户要求使用 NGF 新建、迁移、拆分或长期维护独立 App/应用模块；需要为 App 建立专属 Agent 规则和 Harness 时 |
| [`.rules/skill-rules-update.md`](.rules/skill-rules-update.md) | 开发者明确要求新增、修改、合并、删除、自动触发化或沉淀 `.rules/`/`AGENTS.md` 规则时 |

> **规则库使用原则**：规则文件各自在开头明确列出了触发条件，LLM 每次分析任务时应主动对照检查，无需等开发者提示。规则库内容以 `.rules/README.md` 为索引入口；技能文件内容与本表不一致时，先以本文件为准，并在规则维护任务中同步修正漂移。

### 1.2 本地规则库（.local-rules/）

`.local-rules/` 是当前机器的本地事实库，用于保存 SDK 路径、DevEco Studio 路径、Hvigor/HDC/HDB 路径、设备 target、构建/安装/启动/日志命令实测结果等**本机信息**。

- Agent 在陌生环境或检测到环境漂移时，必须先读取 `.local-rules/README.md` 与 `.local-rules/base-local-rules.md`（如存在），再读取相关 `*.local.md`。
- `.local-rules/*.local.md` 中的本机事实可以覆盖本文件中的历史“当前机器基线”，但不能覆盖项目架构、ArkTS、UI、资源、规则维护等共享规范。
- 新探测到的本机事实应写入 `.local-rules/*.local.md`，不要直接修改 `.rules/` 或本文件。
- `.local-rules/*.local.md` 默认不提交到 Git；共享索引和基础规则可以提交，以便不同 Agent 都知道读取方式。
- 如果本机事实揭示了跨机器通用规则变化，先在交付中说明，再由开发者明确触发 `skill-rules-update.md` 更新共享规则。

### 1.3 项目专属规则、Harness 与个人偏好（.agent-rules/）

`.agent-rules/` 用于承接当前 NGF 工作区或未来独立 App 的稳定规则，避免把产品决策、执行 Harness、个人偏好、机器事实和共享框架契约混写。

- 当 `.agent-rules/README.md` 存在时，Agent 在读取或修改目标源码前必须读取该索引、`project-rules.md` 的全部 `active` 条目，以及存在时的 `preferences.local.md`；这些有效规则在实现、复核、交付和恢复时都必须遵守，除非用户提出相反要求或更高优先级规则冲突。
- `project-rules.md` 只记录当前项目或 App 的已验证架构、产品边界、质量门槛和交付规则；`candidate` 条目仅供调查，不能强制实施。
- **`bug-log.md` 是项目 Bug 档案库**：每个已发现、已定位、已修复的 Bug 必须记录于此（含现象/根因/修复/验证/日期），防止复发。涉及 UI 布局、抽屉、断点、ArkWeb 的 Bug，必须同步在 `scripts/ui-test-phone.sh` 增加对应回归断言；Agent 修改布局/抽屉/ArkWeb/工具链路相关代码前应先查阅该文件。
- `preferences.local.md` 只记录用户明确表达的、非敏感且长期适用的工作区偏好，默认不提交；它不能覆盖用户当前指令、官方要求、NGF 共享规则或 `active` 项目规则。
- Agent 可以按 `skill-project-rule-governance.md` 自动新增、合并、升级、降级或废弃项目专属条目，但必须记录来源、证据、范围和验证方式，并在交付中说明；不得自动修改共享 `AGENTS.md` 或 `.rules/` 来承载这些专属信息。
- 本机 SDK、设备、命令事实仍归 `.local-rules/`；跨会话任务状态仍归 `.agent-state/`，两者都不能直接成为项目强制规则。

## 2. 项目定位

- 这是一个 HarmonyOS Next 项目，主要使用 ArkTS 开发。
- 当前仓库的主定位是 **DSHM**：在鸿蒙设备上对 dsh 进行全新实现的产品工程。
  - ⚠️ **2026-09-11 现状校正**：上游框架模块 `ngf_framework/` **已从本仓库移除**（同时 `pages/ngf/` 演示页亦已删除）。因此本文件中所有以 `ngf_framework/src/main/ets/**`、`import { logger } from 'ngf_framework'`、`NGFHdsTitleBarOptionsFactory` 等为前提的条款，**当前均无对应代码**，只保留为历史背景；本仓库现在只有 `entry` 一层（`entry/src/main/ets/dshm/**` 为 DSHM 自有实现，日志用 `entry/src/main/ets/dshm/utils/Logger.ets` 的 `DshmLogger`）。
  - `entry` 是 DSHM 的应用层，承载 dsh 的业务实现（harness 内核、插件系统、会话、工具、模型接入、交互界面）。
- 品牌命名：仓库内统一 `dshm`/`DSHM`（历史名 `hdsh`/`HDSH` 已废弃；仅 `DshBootstrap.LEGACY_CONFIG_EDITOR_BUNDLE` 这类**迁移常量**保留旧名）。
- 产品目标（待确认项见 `.agent-rules/project-rules.md` 的 Open Decisions）：将 dsh 的能力迁移到鸿蒙设备上进行全新实现，让鸿蒙用户获得原生、插件化、可持续运行的 agent 运行环境。
- 所有对 `ngf_framework` 的修改遵循"可复用、低耦合、可扩展、可替换"的框架设计，避免写死 DSHM 专属业务；DSHM 产品逻辑留在 `entry` 层。
- 仓库内历史遗留的 NGF 演示页面、示例与导航入口，优先视为框架验证与参考实现，不作为 DSHM 业务本身；DSHM 业务页面与 `pages/ngf/` 演示区保持边界。
- 优先使用官方最新 API，尽量不引入新的第三方依赖。

### 2.1 框架优先原则

- 当“框架抽象”与“某个旧业务特例”发生冲突时，默认优先保留框架抽象与通用能力，除非用户明确要求兼容该业务特例。
- 新增能力时，优先沉淀为通用模块、通用服务、通用页面模式、通用日志、通用导航接入方式或通用平台桥接能力。
- 新增页面如属于演示、测试或验证页，应明确体现其框架验证属性，例如围绕核心能力、官方组件、路由壳层、日志链路、平台能力接入等展开。
- 共享规则文件中不再沉淀任何面向单一业务的专属适配规则或产品流程规则；只有在用户明确要求处理某个历史模块时，才允许在当次任务范围内局部考虑。

## 3. 当前仓库事实基线

以下内容基于当前仓库实测结果整理；如后续文件内容发生变化，应始终以 **实际文件** 为准，而不是死记本节文字。

- 仓库根目录关键配置文件包括：
  - `build-profile.json5`
  - `oh-package.json5`
  - `hvigorfile.ts`
  - `hvigor/hvigor-config.json5`
  - `AppScope/app.json5`
  - `entry/oh-package.json5`
  - `entry/src/main/module.json5`
  - `entry/src/main/resources/base/profile/main_pages.json`
- 当前 `build-profile.json5` 的产品配置为：
  - `targetSdkVersion: 26.0.0`
  - `compatibleSdkVersion: 26.0.0`
- 当前根目录 `oh-package.json5` 的 `modelVersion` 为 `26.0.0`。
- 当前 `AppScope/app.json5` 的 `bundleName` 为 `com.dshm.agentic`（**不要随意改**：本机签名证书/p7b 是按该包名签发的，改了会导致 `SignHap` 失败；且会变成一个新应用、丢失现有数据）。
- 当前 `entry/src/main/module.json5` 的主能力为 `EntryAbility`，页面入口通过 `$profile:main_pages` 声明。
- 当前 `entry/src/main/resources/base/profile/main_pages.json` 中注册的入口页面为 `pages/ngf/MainMenuPage`。
- 当前页面目录以 `entry/src/main/ets/pages/` 为主，业务页面通常放在该目录下。
- 当前框架主目录为 `ngf_framework/src/main/ets/`，这是个独立的 HAR 包，已确认存在以下一级目录：
  - `core`：核心契约、生命周期、日志抽象、事件抽象、服务容器、启动内核、DependencyContainer。
  - `platformOhos`：HarmonyOS 平台桥接、上下文桥接(UIContextManager)、窗口策略、平台控制能力。
  - `data`：缓存、设置(SettingsManager)、存储(SandboxManager)、迁移与数据门面。
  - `contentWorkflow`：通用工作流、动作执行、重试、限流等流程编排能力。
  - `contentSource`：通用内容源注册、加载、仓储与接入门面。
  - `deviceAwareness`：视效能力、握持感知、设备状态等感知能力门面与契约。
  - `hardware`：硬件能力接入与演示支撑。
  - `i18n`：国际化、语言管理、资源字符串解析、相对时间等能力。
  - `interconnect`：跨端互联与连接能力。
  - `media`：媒体能力接入与演示支撑。
  - `network`：网络请求、连接状态、网络能力封装。
  - `platformOhos`：HarmonyOS 平台桥接、上下文桥接(UIContextManager)、窗口策略、平台控制能力。
  - `push`：推送与系统消息接入能力。
  - `resources`：框架资源、系统符号目录与资源辅助能力。
  - `security`：加解密、哈希、安全工具与安全能力演示支撑。
  - `systemTasks`：后台任务、系统通知、任务进度与系统事件能力。
  - `uiShell`：导航壳层、页面策略宿主、UI 外壳能力，以及可复用 UI 组件(`components/` 下含 HdsNavigationSupport、NGFImmersiveTopChrome)。
  - `uiTheme`：主题、深色模式、视觉主题状态与管理门面。
  - `utils`：日志、时间、日志收集等基础工具。
  - `webBridge`：WebView/JSBridge 与 Web 能力桥接。
- 当前日志实现文件为 `ngf_framework/src/main/ets/utils/Logger.ets`。
- 当前 `local.properties` 未记录 SDK 路径，因此 **不能** 把它作为判断 SDK 绑定状态的唯一依据。

### 3.1 本机 SDK 与 IDE 路径事实

- 本机 HarmonyOS SDK、DevEco Studio、OpenHarmony SDK、HMS SDK、toolchains、previewer、Hvigor、HDC/HDB 路径都属于本地事实，应优先从 `.local-rules/current-machine.local.md`、`.local-rules/build-commands.local.md`、`.local-rules/device-hdc.local.md` 读取。
- 如果 `.local-rules/*.local.md` 不存在、过期或与现场结果冲突，应先执行非破坏性探测命令，再把新事实写入对应本地文件；不要把单台机器路径追加到本文件或共享 `.rules/`。
- 当前仓库实际 `targetSdkVersion` / `compatibleSdkVersion` 仍以 `build-profile.json5` 为准；本机是否安装了对应 SDK 版本，应通过本地规则库或现场探测确认。
- 涉及 SDK 路径、toolchains、previewer、hvigor、构建环境或 IDE 绑定目录排查时，必须同时对照 `build-profile.json5`、本机实测路径、DevEco Studio 默认 SDK 目录以及用户实际报错，不能只看单一文件下结论。

### 3.2 本机已验证的常用构建命令

- 本机可用 Hvigor 入口、`DEVECO_SDK_HOME`、构建产物路径和失败命令原因都应记录到 `.local-rules/build-commands.local.md`。
- 在 PowerShell 中执行 HarmonyOS 构建命令前，优先采用“显式环境变量 + 绝对 Hvigor 路径”的形式：
  - `$env:DEVECO_SDK_HOME='<包含 default/openharmony 的 DevEco SDK 根目录>'; & '<本机 hvigorw.bat 绝对路径>' assembleHap --no-daemon --stacktrace`
- 执行任何 `hvigorw.bat` 命令前，必须先确认当前工作目录就是仓库根目录；不要在无关目录直接执行，否则 Hvigor 会解析异常。
- 不要先后反复尝试 `hvigor`、`hvigorw`、`ohpm`、猜测 SDK 路径等无根据写法；如果本地规则库已有已验证命令，优先使用该命令。
- 遇到 `generator : Ninja does not match the generator used previously: Visual Studio 17 2022` 缓存冲突时，应优先判断为本地 `.cxx` / `CMakeCache.txt` 缓存冲突，只有在任务本身就是构建排障且允许处理缓存时，才清理报错指向的二进制目录（如 `entry\.cxx\default\default\debug\arm64-v8a`），禁止无差别清空整个 `entry`。

## 4. 框架目录与修改原则

- 修改代码前，先判断目标文件属于哪一层，再沿用该层既有模式，不要强行套用单一架构。
- 当前 `ngf_framework/src/main/ets/` 目录的职责可按以下方式理解：
  - `core`：核心契约、生命周期、日志抽象、事件抽象、服务容器、启动内核、DependencyContainer。
  - `platformOhos`：HarmonyOS 平台桥接、上下文桥接(UIContextManager)、窗口策略、平台控制能力。
  - `data`：缓存、设置(SettingsManager)、存储(SandboxManager)、迁移与数据门面。
  - `contentWorkflow`：通用工作流、动作执行、重试、限流等流程编排能力。
  - `contentSource`：通用内容源注册、加载、仓储与接入门面，按“通用适配层”理解，不要写成单一来源特例层。
  - `deviceAwareness`：视效能力、握持感知、设备状态等感知能力门面与契约。
  - `hardware`：硬件能力接入与演示支撑。
  - `i18n`：国际化、语言管理、资源字符串解析、相对时间等能力。
  - `interconnect`：跨端互联与连接能力。
  - `media`：媒体能力接入与演示支撑。
  - `network`：网络请求、连接状态、网络能力封装。
  - `push`：推送与系统消息接入能力。
  - `resources`：框架资源、系统符号目录与资源辅助能力。
  - `security`：加解密、哈希、安全工具与安全能力演示支撑。
  - `systemTasks`：后台任务、系统通知、任务进度与系统事件能力。
  - `uiShell`：导航壳层、页面策略宿主、UI 外壳能力，以及可复用 UI 组件(`components/` 下含 HdsNavigationSupport、NGFImmersiveTopChrome)。
  - `uiTheme`：主题、深色模式、视觉主题状态与管理门面。
  - `utils`：日志、时间、日志收集等基础工具。
  - `webBridge`：WebView/JSBridge 与 Web 能力桥接。
- 如果目标修改只影响某一层，则优先在该层内完成闭环，不要把局部问题扩散到无关模块。
- 同名或近名文件较多时，必须先确认正确路径和职责范围再修改，避免误改展示层与框架层、页面层与门面层。
- 处理现有页面时，应优先保持目标目录现有组织方式；例如演示页继续保持“展示 / 验证”定位，不要无意间改造成业务首页。
- 当现有模块已经采用 facade、contract、starter、page shell 等模式时，应优先复用，不要旁路新增一套平行实现。

## 5. LLM 自动环境核查规范

本节用于让代理在开始任何中等及以上复杂任务前，先自动确认“当前环境是什么、当前流程该怎么走”，避免在错误前提上修改仓库。

### 5.1 启动任务前必须自动执行的核查

- 先确认当前工作目录是否仍为仓库根目录，并确认目标文件确实属于本仓库。
- 先读取根目录 `AGENTS.md`；如任务进入更深子目录，继续搜索该目录链上是否存在新的 `AGENTS.md`。
- 先读取 `.rules/README.md`；如果存在 `.local-rules/README.md`，继续读取本地规则库索引与相关 `*.local.md`。
- 如果存在 `.agent-rules/README.md`，先读取其索引、`project-rules.md` 的全部 `active` 条目和存在时的 `preferences.local.md`；形成有效规则记忆后再读取或修改目标源码。
- 先读取以下配置文件，再开始推断环境：
  - `build-profile.json5`
  - `oh-package.json5`
  - `entry/oh-package.json5`
  - `AppScope/app.json5`
  - `entry/src/main/module.json5`
  - `entry/src/main/resources/base/profile/main_pages.json`
  - `hvigor/hvigor-config.json5`
- 先确认目标文件位于哪一层：`pages`、`entryability`、`Framework/NGF/core`、`platformOhos`、`data`、`contentWorkflow`、`contentSource`、`uiShell` 或 `utils`。
- 如果任务与 API、导入、编译、运行、弃用接口、窗口行为有关，必须先查官方文档，再结合源文件与声明定义分析。
- 如果任务与构建环境有关，必须先核对本机 SDK 目录和 DevEco Studio 默认 SDK 目录是否存在，且不能依赖空白的 `local.properties` 做推断。
- 如果核对结果与本文件或 `.rules/` 中的历史机器基线不一致，应把新事实记录到 `.local-rules/*.local.md`，当前任务按实测结果执行，不要直接回写共享规则。
- 如果任务不要求构建、运行、预览或排查构建失败，则默认只做静态分析与代码修改，不自动执行 hvigor 构建。
- 对于普通代码修改、文档修改、规则文件修改或静态重构任务，完成修改后默认直接进入静态复核与交付，不需要额外手动触发自动编译。

### 5.2 推荐的自动核查命令

以下命令仅作为推荐模板；执行时仍应显式使用 UTF-8：

- `Get-ChildItem -Name`
- `rg --files -g "**/AGENTS.md"`
- `Get-Content -Encoding utf8 AGENTS.md`
- `Get-Content -Encoding utf8 build-profile.json5`
- `Get-Content -Encoding utf8 oh-package.json5`
- `Get-Content -Encoding utf8 entry/oh-package.json5`
- `Get-Content -Encoding utf8 AppScope/app.json5`
- `Get-Content -Encoding utf8 entry/src/main/module.json5`
- `Get-Content -Encoding utf8 entry/src/main/resources/base/profile/main_pages.json`
- `Get-Content -Encoding utf8 .agent-rules/README.md`
- `Get-Content -Encoding utf8 .agent-rules/project-rules.md`
- `Get-ChildItem -Path ngf_framework/src/main/ets -Directory`
- `Test-Path "<可能的 HarmonyOS SDK 根目录>"`
- `Test-Path "<可能的 DevEco Studio SDK>\default\openharmony"`

### 5.3 启动任务时应向自己确认的环境摘要

代理在正式修改前，应先形成一份简短环境摘要，至少包含：

- 当前任务作用的模块或文件范围。
- 当前仓库实际 `targetSdkVersion` / `compatibleSdkVersion`。
- 当前主入口页面或相关页面注册位置。
- 当前目标修改属于哪一层架构。
- 本任务适用的 `active` 项目规则、用户长期偏好和仍未确认的开放决策。
- 是否需要先查官方文档。
- 是否需要先做 `*.bak` 备份。
- 是否真的需要执行构建、运行、预览命令。

如果以上任一项不清楚，应继续读配置和源码，不要直接下手修改。

### 5.4 标准开发流程

- 第一步：理解用户目标，判断这是框架层、页面层、平台层还是构建层问题。
- 第二步：读取有效项目规则、相关配置、目标文件和相邻契约或门面，确认当前模式。
- 第三步：如果涉及官方 API、导入、弃用或报错原因，先查官方文档和声明定义。
- 第四步：在尽量小的改动范围内实现修复或增强，优先修根因，不做表面补丁。
- 第五步：完成后做静态自检，确认类型、安全区、导航、资源、日志、导出关系与本文件规则一致。
- 第六步：仅在用户明确要求，或任务本身就是构建、运行、测试排查时，才执行 hvigor、预览器、安装或运行相关命令。
- 第七步：向用户交付时明确说明改了哪些文件、是否做过验证、未执行构建的原因以及仍需用户确认的部分；不要把“修改完成后手动再编译一次”当作默认流程。
- 第八步：回顾本次是否发现已满足证据标准的项目或 App 专属规则、Harness 改进或长期偏好；按 `skill-project-rule-governance.md` 更新正确的落点，并说明新增、修订、保留为候选或拒绝沉淀的结论。

### 5.5 修改后的自动复核要点

- 是否仍保持 NGF 框架视角，而不是把共享规则或共享模块改成某个单一 App 的特化实现。
- 是否沿用了目标目录既有模式，而不是在旁边再造一套重复架构。
- 是否补齐了必要的页面注册、导出、依赖声明或资源引用。
- 是否避免了 `any`、`unknown`、未类型化对象字面量、危险空值访问和动态索引访问。
- 是否正确使用 UTF-8、日志系统、资源路径与现有导航方式。
- 是否在需要时说明“未执行构建 / 未执行运行”的原因。
- 是否已应用本任务适用的 `active` 项目规则和不冲突的本地偏好，且没有把 `candidate` 当作强制规则。

### 5.6 Agent 任务闭环与防空转（轻量 Harness）

本节定义跨 Agent App 都适用的执行闭环。它约束 Agent 的行为，不依赖 Claude、Codex、DevEco Studio 或任何特定 App 的命令、队列格式、Hook 或 Slash Command；支持原生任务状态、计划或恢复能力的 App 可以使用其原生能力，但必须满足本节的检查点、验证和终止条件。

#### 5.6.1 适用范围与启动边界

- 以下任务必须启用本闭环：跨多个文件或模块的修改、构建/运行/故障排查、批量任务、用户要求“持续处理/自主完成”、发生上下文压缩或需要交接恢复的任务。
- 单个明确的只读问答或极小范围修改可采用简化流程，但仍必须完成“目标确认 -> 最小验证 -> 明确交付”。
- 不得因为仓库中遗留了待办、队列文件或旧 Agent 状态，就自动开始未由当前用户授权的任务。批量执行只能在用户明确授权并给出任务范围后进行。

#### 5.6.2 启动、检查点与恢复

1. **启动**：先明确任务目标、作用范围、可验收条件、预期验证方式、适用的项目规则和个人偏好，以及是否允许构建/运行。无法安全推断且会实质改变实现方向时，先向用户澄清；否则记录所作的最小合理假设并继续。
2. **评估检查点**：完成规则扫描、环境核查和源码定位后，记录将修改的文件、采取的方法、尚未确认的风险和下一步动作；此时不得把“已分析”表述为“已完成”。
3. **执行检查点**：每次完成一组相互关联的实质修改后，记录实际修改文件、已满足与未满足的验收条件、验证结果和下一步动作。
4. **验证检查点**：执行静态检查、测试、构建、设备验证或人工可复现检查后，记录所用命令或方法、结果、失败摘要和结论。验证强度必须与风险相称，且仍遵守“非构建类任务默认不自动构建”的规则。
5. **恢复**：发生上下文压缩、中断、接手或长时间停顿后，先重新读取本文件、命中的规则和更深层 `AGENTS.md`，再检查现有工作区差异及最近检查点；不得只凭旧摘要盲目继续，也不得重复已经有明确证据完成的步骤。

- 需要跨会话或跨 App 持久恢复时，可在仓库根目录 `.agent-state/<task-id>.local.md` 维护 UTF-8 的本地检查点。该文件只保存任务目标、验收条件、当前阶段、已修改文件、验证证据、下一步和阻塞原因；不得保存密钥、账号、证书口令或其他敏感信息。
- 本地检查点是辅助恢复信息，不是代码事实的唯一来源。恢复时始终以当前源码、Git 工作区状态、实际命令输出和用户最新指令为准。

建议的最小检查点格式：

```markdown
# <task-id>

**目标**：...
**验收条件**：...
**当前阶段**：评估 / 实现 / 验证 / 已阻塞 / 已完成
**已修改文件**：...
**验证证据**：...
**下一步**：...
**阻塞原因**：无 / ...
**更新时间**：YYYY-MM-DD HH:mm
```

#### 5.6.3 状态机、完成条件与防空转

推荐按 `评估 -> 实现 -> 验证 -> 完成` 推进；验证失败时只能基于新的错误证据或新的根因假设进入 `修复 -> 再验证`，不能机械重复相同命令或相同修改。

- **完成**：只有在任务的可验收条件已逐项满足，并已完成适当验证或明确说明无法验证的原因后，才能宣称完成。工具命令未报错、文件已保存或分析已结束，都不能单独作为完成依据。
- **阻塞**：缺少用户决策、权限、设备、外部服务、复现条件或关键输入时，记录已验证的事实、尚未完成项和所需输入，再向用户报告。不得用虚构结果、未经验证的猜测或无限重试掩盖阻塞。
- **重复失败上限**：同一验证失败在没有新增证据、代码变化或不同根因假设时，最多尝试 3 次；达到上限后停止空跑，保留失败摘要并切换为阻塞、缩小问题范围或请求用户决策。
- **范围控制**：如果当前路径未产生新的可操作证据，不得为了维持“自主执行”而扩展到无关模块、重构、构建或设备操作。先交付当前发现并说明可选后续路径。
- **批量任务**：按用户明确给出的优先级和验收条件逐项执行；每项独立完成或阻塞后再进入下一项。不得把失败项悄然标记为成功，也不得因为单项失败而遗失其余任务的状态。
- **规则演进**：只要用户明确表达持续适用的非敏感偏好，或当前项目出现有充分证据支持的稳定模式，按 `skill-project-rule-governance.md` 将其写入正确层级；在此之前保持为候选或当前任务假设，不得假装已经成为规则。

## 6. ArkTS 硬性语言与类型规则

### 6.1 类型安全

- 禁止使用 `any`、`unknown`，包括但不限于函数参数、返回值、变量声明、接口属性、泛型约束和双重断言中间态。
- 必须为数据结构提供明确的类、接口或类型别名。
- 所有对象字面量都应对应明确声明的类型，不要依赖未类型化对象字面量。
- 配置文件和资源文件必须定义明确类型接口，并通过类型断言确保类型安全。
- 使用 `error` 时必须确保其类型可控，必要时显式收敛为 `Error` 或其他明确错误类型。
- 重点关注 `null`、可选值和未初始化状态，避免危险访问。

### 6.2 类型断言与泛型

- 类型转换统一使用 `as` 语法。
- ArkTS 调用泛型函数时，必须显式标注泛型参数，不要依赖编译器自动推断。
- `typeof` 只能用于表达式上下文，不能用于类型上下文。

### 6.3 禁止的语言模式

- 禁止把构造函数直接作为函数参数或类型签名使用；优先采用类继承体系、接口或抽象工厂模式。
- 禁止依赖结构类型系统，应尽量按名义化、显式契约思路设计。
- 禁止动态解构变量声明；应使用显式属性访问。
- 禁止函数参数解构声明；应改用显式对象参数和属性提取。
- 禁止使用 `in` 操作符和 `hasOwnProperty`；应使用 `Object.keys(...).includes(...)` 并结合显式类型断言。
- 禁止通过 `Function.apply` 和 `Function.call` 动态修改 `this`。
- 禁止在独立函数中使用 `this`。
- 禁止使用 `globalThis`。
- 禁止使用 `ESObject`。
- 禁止使用索引签名定义对象类型。
- 禁止依赖字符串索引签名进行动态访问。
- 禁止使用对象扩展运算符 `...` 合并普通对象；对象属性应显式赋值。
- 禁止使用 definite assignment assertion。

### 6.4 属性访问与数组规则

- 应进行显式空值检查，避免对可能为 `null` 的对象进行属性访问或调用。
- 避免 `object['key']`、`object[fieldName]` 形式的动态索引访问；优先使用点语法和显式 helper。
- 如果必须处理动态字段，优先先枚举 `Object.keys()`，再通过显式类型断言访问。
- `Object.entries()` 的返回值类型必须显式声明为 `[string, T][]` 等明确形式。
- 避免使用无法推断元素类型的数组字面量。
- 初始化 `Map` 时，优先先声明泛型类型，再通过 `set()` 逐项添加，而不是直接在构造函数中放入复杂数组字面量。
- 扩展运算符只能用于数组或从数组派生的类，不能用于普通对象。

### 6.5 异常与构造一致性

- `throw` 应优先抛出 `Error` 或其他明确类型错误对象。
- 类定义中的构造参数必须与所有实例化调用在类型、数量、顺序上完全一致。
- 内部类访问外部类属性时，必须通过构造参数传递或显式属性声明完成，不得访问不存在的属性。

## 7. 通用实现规范

### 7.1 日志与问题分析

- 日志系统统一优先使用 `ngf_framework/src/main/ets/utils/Logger.ets`，通过 `import { logger } from 'ngf_framework'` 使用。
- 优先使用以下日志方法：
  - `logger.debug`
  - `logger.info`
  - `logger.warn`
  - `logger.error`
  - `logger.lifecycle`
  - `logger.startup`
  - `logger.stateChange`
  - `logger.performance`
- 日志分析时，先定位日志提到的代码，再结合源文件、官方文档和最佳实践解释原因，然后再给出方案。
- 处理导入模块问题时，先检查源文件是否正确导出以及导出名称是否正确；如果是 HarmonyOS 模块，再去官方文档确认模块名与导出名。

### 7.2 资源、配置与文件

- 颜色、字符串、媒体等资源优先复用现有资源定义与 `$r()` 资源引用，不要在共享层随意散落硬编码。
- JSON 配置文件应放在 `entry/src/main/resources/rawfile/` 下。
- `rawfile` 目录下的资源通过 `$rawfile('relative/path')` 使用。
- 资源、配置、原始数据应保持命名清晰、职责单一，避免把某个具体业务名或产品名写进共享资源层。
- 修改配置和资源前，先确认其实际消费者是谁，不要误把演示配置改成框架全局配置。

### 7.3 页面、导航与窗口

- 所有独立入口页面都必须通过当前实际路由配置管理；当前仓库以 `entry/src/main/resources/base/profile/main_pages.json` 为主入口声明。
- 新增页面或展示页时，应先确认是模块内局部路由，还是需要提升为主入口页面，不要随意污染根入口。
- 页面跳转时，优先沿用目标文件现有导航方式；不要在同一文件中混用多套导航模式。
- 如果目标文件已经使用 `this.getUIContext().getRouter()`，则在该文件内保持一致。
- 涉及沉浸式布局、安全区、系统栏、窗口策略时，应优先复用目标模块现有写法与 `platformOhos` 层能力，不要临时手写一套平行规则。
- `pages/ngf` 下的框架演示页以及后续新增展示页，默认应沿用 `MainMenuPage` 的沉浸式 HDS 顶栏模式：根层使用 `HdsNavigation` 或 `HdsNavDestination`，标题栏通过 `NGFHdsTitleBarOptionsFactory.build(...)` 配置(位于 `ngf_framework/src/main/ets/uiShell/components/HdsNavigationSupport.ets`)，内容层通过 `NGFImmersiveTopChromeUnderlay`(位于 `ngf_framework/src/main/ets/uiShell/components/NGFImmersiveTopChrome.ets`) 提供顶部沉浸底板，并为主内容显式设置默认顶部避让。
- 对于带 `SubHeader`、`Tabs`、筛选条、操作条等多功能顶部区域的页面，这些控件应归属于标题栏下方的内容层，而不是再额外拼装一套自定义标题栏；如页面存在一个或多个实际滚动容器，必须把对应 `Scroller` 绑定到 HDS 导航容器，并按需配置 `ignoreLayoutSafeArea([LayoutSafeAreaType.SYSTEM], [LayoutSafeAreaEdge.TOP, LayoutSafeAreaEdge.BOTTOM])` 以保证顶部玻璃模糊与光感效果可见。
- 对于 `HdsNavDestination` 类页面，如目标是“标题栏本身正确避让系统状态栏、但页面内容底板继续延伸到状态栏区域”，优先采用“标题栏避让 + 内容层扩展”的分离模式：`titleBar` 显式传入 `avoidLayoutSafeArea = true`、`enableComponentSafeArea = false`，页面内容层或顶部底板通过 `expandSafeArea(...)` / 现有沉浸 helper 延伸到顶部安全区，而不要默认把整个 `HdsNavDestination` 根节点都设置为忽略顶部安全区。
- 新增或重构窗口管理能力时，统一优先接入 `ngf_framework/src/main/ets/platformOhos/` 的窗口管理器；`EntryAbility` 负责绑定/释放 `WindowStage`，页面层通过页面策略宿主或统一辅助层激活窗口策略。旧版 `Utils/` 目录已删除，所有窗口管理能力已整合到 `platformOhos` 层。
- `List` 组件必须显式设置 `width` 和 `height`，避免布局告警。

### 7.4 UI、动画与组件

- 页面入场动画、属性动画和统一动画状态管理，优先复用目标模块已有实现。
- 所有动画相关状态变量必须使用 `@State` 管理，并在动画结束后及时清理状态。
- 展示设备方向、窗口尺寸、握持感知、权限、系统配置、运行状态等实时信息时，页面必须将门面、事件总线或系统回调同步到 `@State`、`@Link`、`@Prop` 等 ArkUI 响应式变量；禁止只渲染初始化快照或普通成员变量后期待 UI 自动变化。
- 动态文本不要通过通用 `@Builder` 方法的字符串参数层层传递后再渲染；应在实际 `Text` 节点、接收 `@Prop` 的子组件，或无动态参数的专用 `@Builder` 中直接读取响应式状态，确保 ArkUI 能建立状态依赖并触发重绘。
- 页面通过门面 listener、事件总线或系统回调驱动实时 UI 时，必须在合适生命周期中成对订阅和取消订阅，例如 `aboutToAppear()` 订阅并同步当前快照，`aboutToDisappear()` 取消订阅，避免页面离开后继续触发 UI 状态写入。
- 复杂页面应将 UI 构建逻辑拆分成多个 `@Builder` 方法，提高可读性和维护性。
- `@Builder` 方法参数必须与调用处在类型、数量、顺序上完全匹配。
- 枚举类型必须使用完整枚举成员，不要用字符串字面量代替。
- 长列表渲染优先使用 `LazyForEach`。
- 自定义组件应遵循单一职责原则。
- 组件外部输入优先使用 `@Prop`，内部状态优先使用 `@State`。
- 组件接口应清晰区分必需参数和可选参数。

### 7.4.1 鸿蒙 UI 设计方法（多形态适配规范）

以下规范适用于 DSHM 手机/平板/PC 多形态 UI（含 Web UI 插件化适配），基于 2in1 真机实测沉淀：

**断点规范**
- 断点基准：手机 <700px、平板 700–1024px、PC >1024px（CSS 逻辑像素）。
- `dsh-client-ui-layout` 的 `SIDEBAR_AUTO_COLLAPSE=1024` 已自动折叠侧栏；手机断点（<700px）额外折叠详情栏并启用抽屉。
- 宽度判断必须用 `frame.getBoundingClientRect().width` 或 `document.documentElement.clientWidth`（CSS 逻辑像素）；ArkWeb 高 DPI 下 `window.innerWidth` 可能返回物理像素（如 1308）导致断点误判。

**抽屉（Drawer）设计**
- 手机形态侧栏用抽屉：入口按钮（FishLogo/汉堡）嵌入主列顶部，侧栏浮层从左侧滑入（`translateX(-100%)→0`），主列整体右移（`translateX(280px)`，宽度不变、内容不重排），右缘滑出视口边界——像推开抽屉，禁止用 grid 压缩列宽实现（会产生"堆叠"观感）。
- 抽屉展开/收起由 `MutationObserver` 监听 `data-sidebar-collapsed` 驱动，`.25s ease` 过渡。

**grid 布局陷阱（重要，已踩坑）**
- sidebarCol 若 `display:none` 或 `position:absolute` 脱离 grid 流，grid 自动布局会把主列（centerCol）填入第 1 列（0px 宽）→ 全空白/主页消失。
- 必须显式列定位：主列 `grid-column: 2 !important`，详情列 `grid-column: 3 !important`，侧栏脱离流后仍正确占位。

**安全区与沉浸式**
- 禁止用 `body` 全局 padding 做安全区避让（会挤压 grid 布局导致排版诡异）；避让交给 ArkTS 容器 `expandSafeArea` + 前端自身样式，Web 层只做排版微调。
- 底部输入/操作条仅在真实安全区（`env(safe-area-inset-bottom)` 非 0）时避让。

**Web UI 插件化适配方法**
- 选择器禁止硬编码 hash 类名（构建产物，dsh 版本变化即失效）；优先 data 属性、语义标签（`dl/dt/dd/pre`）或 JS 运行时打标记。
- `:has()` 在 ArkWeb 实测不可靠，不要依赖；用 JS 打 `data-*` 标记 + `MutationObserver` 驱动状态。
- 长文本/代码强制换行（`overflow-wrap: anywhere` + `word-break: break-word`）；设置页 `dl>dt+dd` 窄屏纵向堆叠（dt 上 dd 下）；`img/video/table` `max-width:100%`。

### 7.5 `@Watch` 规范

- `@Watch` 只用于监听由状态装饰器管理的变量，如 `@State`、`@Prop`、`@Link`。
- `@Watch` 参数必须是字符串形式的方法名，例如 `@Watch('onCountChange')`。
- 被 `@Watch` 指向的回调方法必须是组件成员函数。
- 被 `@Watch` 指向的方法不能是 `private`。
- 推荐的回调函数签名是 `(changedPropertyName?: string) => void`。
- `@Watch` 在首次初始化时不会触发，只会在后续状态变化后同步触发。
- 不要在 `@Watch` 回调中直接或间接修改同一个被监听状态，避免死循环。
- `@Watch` 回调应尽量保持快速、同步、轻量。

### 7.6 HarmonyOS API 迁移与废弃约束

- `decode()` 已废弃，统一使用 `decodeToString()`。
- 全局 `animateTo()` 已废弃，应使用 `UIContext.animateTo(...)`。
- 在 `@Component` 中，应在 `aboutToAppear()` 中通过 `this.getUIContext()` 获取 `UIContext`，并做好空值检查。
- 触发动画时，优先在回调中修改 `@State` 变量，而不是直接操作组件实例。
- 如需等组件完成渲染后再执行动画，可使用 `setTimeout(..., 0)` 作为过渡。
- `getContext()` 已废弃，应使用 `this.getUIContext()?.getHostContext()`，并在需要时显式断言为 `common.UIAbilityContext`。
- 窗口显示、系统栏控制与页面策略应优先复用 `platformOhos` 层现有能力，而不是继续扩散旧式局部写法。

### 7.7 单例、全局状态与事件

- 不使用 `globalThis` 管理全局状态，优先使用单例模式。
- 单例类应提供私有构造函数、静态 `getInstance()` 方法，以及必要的生命周期管理方法。
- 跨模块通信优先复用目标模块现有事件机制；如果进入 NGF 分层，应优先依赖显式契约，例如 `ngf_framework/src/main/ets/core/contracts/IEventBus.ets` 的抽象思路，而不是引入新的隐式全局对象方案。
- 页面组件必须在合适的生命周期中订阅和取消订阅事件，避免泄漏和重复触发。
- 事件载荷必须保持类型安全，不要传递未类型化数据。

## 8. 历史遗留内容处理原则

- 历史业务模块、历史业务命名、历史页面文案、历史演示数据、历史适配层，只应视为遗留背景或迁移样本。
- 不要把某个历史模块的特殊逻辑升级成全局共享规则，除非用户明确要求。
- 不要再把仓库默认理解为任何单一产品工程。
- 如果历史文档、历史注释与当前仓库实际结构不一致，应优先相信当前代码和配置，并在本次改动范围内顺手修正文档漂移。

## 9. 提交修改前的简明检查清单

- **规则库自动触发检查（任务开始时）**：是否已读取 `.rules/README.md`，对照 `1.1 技能规则库` 扫描本次任务，并在动手前完整阅读了命中的 `.rules/` 规则文件？
- **规则记忆检查（任务进行中）**：是否已形成本次任务的“规则记忆”摘要，并在修改、复核、交付前回看其中的硬性禁止项、标准模式和关键路径？
- **本地事实检查（陌生环境/环境漂移时）**：是否已读取 `.local-rules/`，并把新探测到的本机事实写入 `*.local.md` 而不是直接污染共享规则？
- **项目规则检查（存在 `.agent-rules/` 时）**：是否已读取全部 `active` 项目规则与不冲突的本地偏好，并在实现、复核和交付中实际遵守？
- **规则提炼检查（交付前）**：是否已按证据标准将新增的长期项目规律、Harness 改进或用户偏好写入正确层级，或明确保留为候选/不沉淀？
- **任务闭环检查（中等及以上任务）**：是否已明确目标、验收条件、验证方式和当前阶段，并在关键步骤后留下可恢复的检查点？
- **防空转检查（失败或中断后）**：是否基于新的证据继续，而非重复相同操作；达到重复失败上限时，是否已记录阻塞事实并停止无效循环？
- 是否先核对了最新 HarmonyOS 官方文档与目标模块源码。
- 是否确认本次修改是在建设 NGF 框架能力，而不是无意中把仓库往某个单一 App 方向收窄。
- 是否完成了最小必要的环境核查，并确认当前实际 SDK、入口页、模块层级与工作目录。
- 是否避免了 `any`、`unknown`、未类型化对象字面量、危险空值访问和动态索引访问。
- 是否使用了 `import { logger } from 'ngf_framework'` 和项目既有日志风格。
- 是否沿用了目标文件已有的导航方式、窗口策略与架构模式。
- 是否确认了同名文件或近名文件的正确路径。
- 是否在需要时为高风险修改创建了 `*.bak` 备份。
- 是否避免在共享规则和共享模块中重新引入单一业务视角内容。
- 是否在完成修复后再次检查 ArkTS 兼容性与本文件规则。
- 如果未执行构建、运行、预览或测试，是否已明确说明原因；如果执行了，是否已明确说明命令与结果。
- 是否避免把"修改完成后手动触发自动编译"作为默认动作，除非用户明确要求这样做。
- **共享规则沉淀回顾（交付前）**：本次修复是否发现了跨项目可复用规律？若有，是否已提示开发者明确触发 `.rules/skill-rules-update.md` 流程，而没有擅自改写共享规则？
