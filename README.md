<div align="center">

<img src="docs/brand/dshm-icon.png" alt="DSHM" width="112" />

# DSHM

**在 HarmonyOS 上自足运行 DeepSeek Harness 的应用**

</div>

DSHM 把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的**运行本体**装进一个鸿蒙应用：HAP 内自带 Node 运行时与 dsh 核心树，核心在本机 `127.0.0.1` 上起 Host，应用内的原生 ArkUI 页面就是这个本地 Host 的客户端。

**它不是 PC 上 dsh 的遥控器**，也不需要在电脑上常驻任何服务：装上即用，数据只在本机应用沙箱内。

支持 HarmonyOS 手机 / 折叠屏 / 平板 / 2in1。

> **这是一次平台移植**：把官方面向桌面（Electron）的运行时，搬到 OpenHarmony arm64 上自足运行。
> 移植过程中与鸿蒙平台语义的每一处冲突、根因与修法，都汇总在
> **[`docs/70-鸿蒙移植踩坑与修复总览.md`](docs/70-鸿蒙移植踩坑与修复总览.md)**（按技术主题组织）。
> **两条根本约束**决定了后面几乎所有设计：`jitless ⇒ WebAssembly === undefined`，
> 以及 **execve 受签名域管辖 ⇒ 所有端侧原生二进制必须构建期自签名**。

---

## 能力

| 领域 | 说明 |
|---|---|
| **本地核心** | 内置 Node 运行时（自建、`jitless`）与 dsh 核心树；Host 仅监听 `127.0.0.1`，随应用生命周期起停 |
| **对话与轨迹** | 对话视图（问答，思考过程折叠在回答上方）与轨迹视图（工具调用、子代理、目标/任务、交付物、错误）分开呈现 |
| **工作区** | 工作区为组、会话挂在组下；可在设备上选择文件夹作为工作区（系统文件夹选择器），并在其中浏览文件 |
| **模型与密钥** | 按提供方管理：API 密钥（只写）、`baseURL` 与模型目录；默认模型与推理强度可选 |
| **插件** | 查看随包插件清单与运行阶段；按行启用/禁用，并可恢复部署默认 |
| **核心版本** | 同时安装多个核心版本，一键**切换 / 回滚**（停旧起新，逐版本校验后激活） |
| **多语言** | 界面文案跟随系统语言，默认中文 |
| **上架友好** | 不申请 JIT 等特殊权限，全部按 `jitless` 运行；权限为 10 项**普通权限**（含网络、麦克风、文件读写、自定义沙箱等），**不申请任何 ACL 类特殊权限**（无 JIT、无 `ALLOW_WRITABLE_CODE_MEMORY`） |

## 架构

```text
┌─ DSHM（一个 HAP）──────────────────────────────────────────────┐
│  ArkUI 原生页面（客户端）                                       │
│        │  HTTP /api/*        WebSocket /api/remote.mux          │
│        ▼                                                        │
│  端侧 dsh Host（Node 运行时运行在**本应用进程内**）              │
│        │  DSH_HOME = <应用沙箱>/dsh/home（跨版本共享的唯一数据）  │
│        ▼                                                        │
│  核心版本仓库（多个版本可并存，切换 = 停旧 + 起新 + 校验）        │
└─────────────────────────────────────────────────────────────────┘
```

同进程带来的是**安全语义的简化**：客户端与 Host 走回环，不需要把服务暴露到局域网，也不需要跨设备转发。

### 端侧运行时的硬约束：`jitless` ⇒ 没有 WASM

不申请 JIT 权限意味着 Host 全程以 `--jitless` 运行，而 V8 的 `--jitless` 与 `--expose_wasm` **互斥**
（启动即打印 `disabling flag --expose_wasm`），因此端侧 `typeof WebAssembly === 'undefined'`——这是恒定的，
不是配置问题。由此推出一条对上游代码的判据：

> **凡是上游直接 `import('undici')` 的功能，在端侧都会失败**，因为 undici 的 HTTP 解析器是 WASM
> （`lib/llhttp/llhttp-wasm.js`）。

已实测证实的一个实例：`dsh-web-fetch-http` 不用全局 `fetch`，而是 `await import('undici')` 自建 `Agent`
再传 `dispatcher`，于是 `web_fetch` 打不开任何网页和 IP，而走本仓纯 JS `node:http` 垫片的 `web_search` 照常工作。
同一核心树、同一个本地 HTTP 服务下，只有 `--jitless` 一个变量就能复现两组结果（有 WASM → 200；
无 WASM → `fetch failed / WebAssembly is not defined`）。细节与在飞修复见 `docs/parity-matrix.md` §3.2。

因此新增/升级核心版本时，除了跑既有门禁，还要**搜一遍核心树里对 `undici` 的直接依赖**，并把垫片覆盖率当作一项验收项。

对付它需要**两层**，缺一层就会出现"Host 起来了、模型也能回话，但某个工具静默坏掉"：

| 层 | 做什么 | 不做的后果 |
|---|---|---|
| 全局 fetch 垫片（`fetch-shim.js`） | 用 `node:http/https`（原生 llhttp）重写 `fetch/Request/Response/Headers/FormData` | 调模型就走不通（dsh 调模型就是用 fetch） |
| `undici` **模块名**解析钩子（`undici-shim.mjs` + `undici-loader.mjs`） | 让上游的 `await import("undici")` 拿到同一个垫片，并把 `dispatcher` 翻译成 `lookup` | **`web_fetch` 打不开任何网页**（`web_search` 却正常，因为后者走第一层） |

第二层由 `main.js` 的 `installUndiciNameHook()` 在 `WebAssembly` 不可用时注册；**不改上游源码、不改核心树**。
这条路径由 `tools/check-web-fetch-jitless.mjs` 守着——它自带对照实验：不注册钩子时必须失败（并给出
WASM 因果证据），注册后必须全过，且**跨源跳转仍须被拒**。

## 构建

前置：DevEco Command Line Tools（含 hvigor / ohpm / codelinter / SDK）、JDK 17、Node.js
（仅用于仓库内的构建与检查脚本）、**Python 3**（`tools/sign-tar-elf.py` 用它的 `tarfile`
改写工具链归档——Windows 上只有它能在保住归档内 symlink 的前提下改字节；缺失时
`place-toolchain` 会告警跳过签名，归档仍可用，只是端侧 `git`/`python3.12` 真身继续被执行策略拒绝）。

> **SDK 版本口径**：`compatibleSdkVersion` / `targetSdkVersion` 固定为 **`6.1.1(24)`**（决策，2026-09-14）。
> 代价是**不能用 API 26 的「沉浸光感」材质**（官方要求 `targetAPIVersion ≥ 26`）——
> 界面层次当前由系统阴影表达；升级路径与要改的几处列在 `appstate/ui/HarmonyTheme.ets` 的 `HarmonyMaterial`。

**不入库的产物（新克隆必须先备齐，否则编不过）**：

| 产物 | 路径 | 说明 |
|---|---|---|
| Node 头文件 | `entry/src/main/cpp/node-headers/` | 编 `libdshhost` 只需要它（`libnode` **不参与链接**） |
| 原生库 | `entry/libs/<abi>/` | 运行期需要（含 `libnode.so.137`）；也是"编不编 koffi/flock"的门 |
| git 兼容垫片 | `entry/libs/arm64-v8a/libdshm-gitcompat.so` | 由 CMake 从 `entry/src/main/cpp/gitcompat.c`（**源码在库里**）编出；git 子进程类命令的 `LD_PRELOAD` 垫片（见 `docs/device-validation.md` 批次备注十三 三） |
| 核心包 | `entry/src/main/resources/resfile/*.zip` | 首启解包出端侧核心树 |
| 工具链归档 | `entry/src/main/resources/resfile/toolchain/{python,git}/` | 由 `node tools/place-toolchain.mjs` 从 `third_party/` 放置并**自签名**（端侧 execve 只放行带 `.codesign` 的 ELF） |
| 入口脚本 | `entry/src/main/resources/resfile/resources/app/` | 由 `node tools/place-host-app.mjs` 从 `hostcore/app/` 生成 |
| 鲸鱼 SVG | `entry/src/main/resources/base/media/fish_logo.svg` | 由 `node tools/gen-fish-logo.mjs` 从核心树的官方 `dsh-client-ui-primitives` **逐字节**复制路径生成（`Image.fillColor` 按主题着色） |

```bash
# 1) 打完整体（HAP + 原生库 + 内置核心资源）
devecocli build

# 2) 需要重新打包核心树时（素材来自 dist/core/，产物落到应用资源目录）
node tools/pack-core.mjs --skip-install --place-in-app
node tools/place-host-app.mjs

# 2b) 需要重建工具链归档时（放置 + 自签名；会就地改写 resfile/toolchain/ 下的归档）
node tools/place-toolchain.mjs

# 2c) 重建顶栏鲸鱼 SVG 资源（从核心树的官方 primitives 包逐字节复制路径；内含
#     "真实包围盒 == 官方 viewBox" 与"落盘后仍与官方一致"两条自检，失败即退出）
node tools/gen-fish-logo.mjs

# 2d) 重建 **APP 图标**（官方鲸鱼 + HM/OS 角标）。需要 Python 3 + Pillow。
#     ⚠ 它**只写 APP 图标**：AppScope 与 entry 的 {foreground,background}.png、
#       docs/brand/dshm-icon.png、dshm-mark.png。**不写** startIcon.png / logo_dark.png
#       —— 那两个是**启动画面**资源，必须保持原版（正本归档在 third_party/brand-original/）。
#     全部自检通过才写盘；失败则一个文件都不动（含"归档比对"与"mark 不得带角标"两项）。
python tools/make-icon.py

# 3) 安装到已连接设备（注意：产物是 **unsigned**；签名材料不在库内）
hdc install -r entry/build/default/outputs/default/entry-default-signed.hap
```

## 设计体系（P1.5：Web 语义 + HarmonyOS 原生表达）

**产品语义对齐官方 Web，视觉与交互用 HarmonyOS 原生表达**——不是把 Web 的 CSS 机械翻译成 ArkUI：

| 层 | 落点 | 作用 |
|---|---|---|
| 尺度原语 | `appstate/ui/Tokens.ets` | `Sp` / `Radius` / `Border` / `Fs` / `Sz` / `Dur`（"有哪些档位"） |
| 语义令牌 | `appstate/ui/HarmonyTheme.ets` | 角色 → 系统语义资源（`sys.color.*`）+ 排版成套角色 + 层级/动效/触控；**`WEB_TOKEN_MAP`** 逐条映射官方 `--dsw-*` |
| 原生原语 | `entry/src/main/ets/view/NativePrimitives.ets` | `NativeChip` / `NativeCard` / `NativeButton` / `NativeActionBar` / `NativeSectionTitle` + Sheet 参数助手 |

**四条已经定下来的规则**（都是踩过或查证后写的，不是偏好）：

1. **浮层用系统形态**：半模态一律 `bindSheet`（`NativePrimitives.harmonySheetOptions` 统一参数），
   不再手写"整屏 Column + 自制遮罩"。原因：原生 Sheet 自带"非全屏、底层父视图可见"、拖拽关闭、
   遮罩与键盘避让——手写那套要逐个补回来，且必然补不全。
   > 注意 `bindSheet` 是**组件属性**，同一节点只能绑一个。本项目因此用**单一浮层宿主**：
   > 全应用只在根节点挂一次 `bindSheet`，由 `sheetKind()`（**从既有状态派生**，不另立字段）
   > 决定显示哪个浮层、`closeSheet()` 一处复位。这样结构上**不可能同时开出两个浮层**，
   > 复位逻辑也只写一次。
2. **遮罩交给系统**：不再手写 `rgba(...)` 遮罩（35% 黑在深色主题下观感就是错的），全部由原生 Sheet 提供。
3. **图标用系统符号**：`SymbolGlyph` 只支持系统预置资源，**不引入 Web SVG**（这条是 API 约束，不是偏好）。
4. **裸值只许变少**：`tools/check-design-tokens.mjs` 是棘轮门禁，管的是
   `fontSize`/圆角/描边/颜色字面量（含 `rgb()/rgba()/hsl()`——首版漏检过，已补）。

## 仓库结构

| 目录 | 作用 |
|---|---|
| `entry/` | 鸿蒙应用入口：ArkUI 页面与视图（含**原生原语** `view/NativePrimitives.ets`）、原生桥（`libdshhost`）、随包资源（核心包与原生库） |
| `hostcore/` | 端侧 Host 的入口脚本与 profile（`cordis.patch.yml`）、`fetch` 垫片，以及为绕开"端侧无 WASM"而做的 `undici` 模块名解析钩子（后者已接线并端到端验证，见矩阵 §3.2） |
| `hostruntime/` | 核心版本仓库、激活事务、运行时载体（`RuntimePort` → `NodeRuntime`） |
| `appstate/` | 客户端状态中枢与投影（会话、轨迹、工作区、设置、凭据、插件、核心视图）；**设计令牌与布局/导航决策**（`ui/Tokens`、`ui/HarmonyTheme`、`ui/Breakpoints`、`ui/LayoutController`、`ui/NavigationController`；**回合模型** `model/Turns`、**贴底跟随模型** `model/Follow`、**输入模态策略** `model/InputPolicy`（长按/右键/悬停的差异收敛成策略）、**输入模态事实** `model/InputFacts`（设备枚举 / 事件证据 / 形态猜测三者的优先级）、**轨迹时间线** `model/Timeline`（官方七种类标签 / 累计比例 / 拖动聚焦 / 会话统计四项）——纯逻辑，可在本机直接测，
**工具呈现** `model/ToolPresentation`（按工具类别判定图标/语气/展开态）、**改动对照** `model/ToolDiff`（编辑类工具出"改了什么"，规则逐条对齐官方渲染器）、`tools/check-layout-fixtures.mjs` 对它们共 440 条断言） |
| `platform/` | 系统能力封装（文件选择、剪贴板、通知、窗口记忆等） |
| `dshcompat/` | 与上游协议有关的**全部**事实：端点、参数形状、事件类型与投影键 |
| `tools/` | 构建与检查脚本（核心打包、依赖闭包、上架红线、协议往返、死按钮扫描等） |
| `docs/` | 文档基线，索引见 [`docs/README.md`](docs/README.md) |

## 当前阶段：官方信息架构对齐

本阶段（2026-09-14 重定义）**不再"缺一个功能就加一个组件"**，而是先把页面框架搭正确：
`AppFrame → Sidebar → Main → Rightbar → Settings 域`，四形态共享同一套信息架构（只有几何/输入/面板呈现不同）。
分步计划与验收见 `docs/ia-parity-plan.md`；判断依据与现状对照见 `docs/parity-matrix.md` §5.1。

**进度**：纯逻辑层（`PanelRegistry` / `NavigationState` / `ShellTracks`，46 条断言）、**侧栏外壳**
（`view/shell/SidebarShell.ets`：品牌行 / 面板清单 / 徽标 / 三种呈现）、**右栏外壳**
（`view/shell/RightbarShell.ets`：面板本体 / 三种呈现）、**主区页头**（`view/shell/MainHeaderShell.ets`）与**轨间把手**（`view/shell/TrackResizer.ets`）已完成
—— AppFrame 的 chrome 已各有其主；命令面板已拆成 `GoalBar` / `SessionModelPicker` / `CommandList` 三块，连接横幅拆出 `HubBanner`
（呈现归组件、副作用归宿主）；
`@Provide/@Consume` 机制已在侧栏上真实验证（侧栏按面板注册表过滤入口）；
**主区内容已搬出**：`view/TabContentView.ets`（459 行）+ `view/shell/MainShell.ets`（409 行），
且 **`Index` 不再负责页面级 Pane 选择**（P0 验收达成）；
**AppFrame 三形态轨道已搬出**（`view/shell/AppShell.ets`：单栏/双栏/三栏的轨道拼装 + 页头 + 三种侧栏 surface + 右栏 surface + 把手，
25 个门面成员）⇒ **`Index.ets` 5040 → 4290 行**，页面根只剩「浮层门户 + 全局输入证据 + 快捷键」；
顺带修掉一个真实缺陷：浮层门户原先挂在单栏布局的根节点上 ⇒ **双栏/三栏下模型选择、凭据、目录、整值编辑浮层够不着**，
现在门户挂在页面根、与形态无关（官方 Web 的 portal 语义）；
**页面选择已收成唯一真值**（`NavigationState.selectedMainPanel`，`NavTab` 退化为迁移期别名），
"此刻显示哪个面板"的组合逻辑也已收进纯模型（`activeMainPanelOf`）；
**P0 到此完成**，**P1（Sidebar）已推进三步**：① 工作区→会话那棵树抽成 `view/WorkspaceBrowser.ets`
（可挂主区、也可挂侧栏；`TabContentView` 595 → 341 行），并删掉一个**长期没人渲染的死 Pane**
（`SessionListPane`，221 行）——顺带把设计令牌棘轮调紧（53 → 40 处）；② 为 240vp 侧栏做**窄版行**
（名字一行、动作一行；动作**不收进菜单**——菜单在真机打不开就等于功能不可达，见 `docs/50` E301）；
③ 树挂进侧栏 PANEL 轨道（品牌行下方，官方顺序），**三栏下主区不再重复一份**（判据取自 `ShellTracks`，
与轨道选择同源）。
④ 侧栏入口改由**面板注册表**驱动（P1-4）：入口的存在/顺序归 `sidebarEntries` / `sidebarPinnedEntries`
（"沉底"是清单属性）、图标与文案归按面板 id 的编译期映射、高亮归宿主 —— `SidebarShell` 里**再无 `NavTab`**，
一级导航不再是"三个页签"；`NewSession` 成为品牌行下方的一级入口，Settings 沉底，核心席位按 E110 标为不可用。
⑤ 单栏（手机）侧栏改成**抽屉**（P1-5）：页头根页给导航入口、抽屉叠在整页之上（点外部收起）、
返回键**第一优先级**收抽屉（`BackAction.CLOSE_DRAWER`）、从抽屉里选入口或会话都自动收起
（`navigateToMain` / `enterSession`）——顺带接上两条此前"有通道没消费点"的模型状态。
底部标签栏**暂时保留**（过渡，见 `docs/50` E306）。
**P2（Main / 会话）已开工**：会话正文的 **Markdown** 已落地（P2-1）——
解析是纯模型 `appstate/model/Markdown`（**31 条 fixture 断言**：围栏含未闭合、未配对标记原样保留），
渲染是 `entry/view/MarkdownRenderer.ets`（`Text > Span` 行内富文本），
正文/思考/过程三处已从 `Text(item.body)` 原文照显换成渲染；链接走真实系统能力 `openLink`
（`platform/system/OpenLink.ets`，只放行 http/https），无障碍文案改为去标记文本。
**P2-2 已落地**：会话头的**后台任务条** —— `Jobs` 模型 40 条断言与中枢 `jobs` 字段一直都在，
但视图零消费者（又一次"通道有、没接"）；现已接成 中枢 → `Index` → `MainShell` → 会话头任务条
（live 任务每秒走字、无障碍整段取自模型），并把这条接线登记进功能接线门禁（第 16 条）。
**P0 回归修复（E343）**：真机（Mate 70 Pro+）冷启后点一下界面即被系统杀进程——
`RangeError: Stack overflow!`，栈里成对出现 `MainShell.ets:405` 与 `:404`。根因是主区分派的**兜底分支写成了自递归**
（`else { this.mainContent(this.compact) }`）：`MainShell` 只分派「诊断 / 连接 / 会话」，剩下工作区 / 核心 / 设置
三类面板本应由**主区第二束** `TabContentView` 渲染，搬迁时这一束忘了接上；而 `MainShellFacade.tabFacade`
一直由宿主造着却**零消费者**（第 7 例"通道有、没消费者"）——正是它掩盖了这个空洞。
修复 = 兜底渲染 `TabContentView({ f: this.f.tabFacade, compact: this.compact })`。**并补一道门禁**
`tools/check-builder-recursion.mjs`：`@Builder` 体内不许出现自己的名字（剥注释后判定，5 条注入式自检，
且**对修前的提交归真命中**——门禁必须先在已知坏版本上红过一次才算证明）；功能接线门禁同步新增「主区兜底」项（16 → 17）。
⚠️ 该项**真机复验仍待做**：无真机时不得宣称设备验收完成。
**顺带清掉搬迁的尾巴（E345）**：查这件事时又查出 `Index.ets` 里**三个零调用的 `@Builder`**
（`hubBanner` / `coreTabContent` / `tabContent`——内容都已在 AppShell 与两束组件里，只剩宿主这份壳；
`@Entry` 组件不会渲染它们）与**全仓 22 个零使用 import**（`Index` 12 个、`MainShell` 9 个、其余 6 文件各 1 个）。
`Index.ets` 4460 → **4384 行**，全仓零使用 import 归零。
**P5-4 已落地（门面字段的"读点"变成第 4 条死代码规则）**：`export interface *Facade` 是本仓约定俗成的**写回通道**（子组件 → 宿主：值快照 + setter + 回调闭包），它的**声明与读者在子组件、实现在宿主** ⇒ 只数"本文件出现几次"的前三条死代码规则**既数不到读者、也数不到写者**。新规则改成**整仓数 `.字段`**：搜不到就是**没有任何调用点**。规则写完先在**还没修的当前工作树**上跑，**恰好命中 2 处**：`TabContentFacade.setConfirmingDeletePath` 与 `.setSelection` —— 声明在 `TabContentView`、实现在 `Index` 的 `buildTabFacade`、全仓零调用；两者的真值都另有写者（两步确认在宿主的 `toggleDeleteConfirm`、模型选择走 `SessionHub.selectSessionModel`）⇒ **残留的重复通道**（不是 E361 那种缺失的控制点），删掉。另配 4 条注入式自检（真死通道 / 读者在别的文件不误报 / 只写不读仍算死 / `dead-exempt:` 有意保留）。只盯 `*Facade` 不盯所有接口：数据型接口常被整体传参、逐字段判会变噪音。`Index.ets` 4059 → **4053 行**。
**P5-3 已落地（双栏的「展开侧栏」是个死按钮）**：上一轮把"呈现"与"几何"接上之后，这一轮去数"**呈现判定到底被几个调用点问了**"——答案是一半：`buildTriple` 问了，`buildDouble` 没问。`buildDouble` 调的是 `navRail()`，那份 surface 把呈现**写死**成 `TrackPresentation.RAIL`，于是双栏下点「展开侧栏」：偏好变了、纯函数判定也变了、轨道宽度也跟着变 —— **可唯一那个绘制侧栏的调用点根本没问判定**，rail 照画不误；D19 第 2 条在真机上必然失败。而 `navRail()` 与 `sidePanelSurface(...)` **逐字段相同、只差 `presentation` 与宽度来源**（它就是后者的手抄版，走样只是时间问题）⇒ 删掉 `navRail()`（−31 行），双栏改调 `navPanel()`。这类缺陷**正面计数拦不住**（该在的特征全都在，多的是一个不该有的常量），故 `check-feature-wiring` 新增**反面规则**：`AppShell.ets` 里不许出现 `TrackPresentation.RAIL`（它在本仓永远是判定的结果；`PANEL`/`OVERLAY` 是结构上固定的表面，写常量是对的），门禁先剥注释再匹配，并**对修前的 `HEAD` 归真命中 `AppShell.ets:228`**。`AppShell` 420 → **397 行**。
**P5-2 已落地（侧栏"收起"终于真的腾出宽度）**：上一轮把侧栏收起接通了，这一轮去查"收起之后到底发生了什么" —— **只有呈现变了、几何没变**：`AppShell.navPanel()` 传的是 `Sz.NAV_PANEL` 常量，而 `SidebarShell` 的 rail 宽度取的是**布局决策**里按形态算的 `navWidthVp` ⇒ 三栏收起侧栏后轨道照样占 240vp（"腾出宽度"一次都没发生），双栏收起后是 240vp 的框里放一条 56vp 的 rail、右边空出 184vp 底色。新增零依赖纯函数 `sidebarTrackWidthOf(mode, stored)`（panel 240 / rail 56 / 浮层 0）；`SidebarShell` 的 rail 宽度改用 `Sz.NAV_RAIL`，`navWidthVp` 这个 prop 与门面字段一起删掉（**组件自己的几何不该由外部按形态猜**）；`sidebarExpandedOf(stored)` 换成 **`sidebarExpandedForMode(mode, stored)`** —— "没存过"必须按形态给默认，否则双栏首启被读成"展开"，与 `shellTracksOf(DOUBLE).sidebar = RAIL` 和四形态 fixture 直接矛盾；偏好因此搬出 `NavigationState`（删 `sidebarExpanded` / `setSidebarExpanded`，真值只剩页面里那份原始 `boolean | undefined`，生效值每次渲染派生）；删 `sidebarOccupiesLayout`（与"宽度 > 0"同一个问题，且只有 fixture 在用）。fixture **595 → 601 条**；真机判据补进 D19 第 6 条。
**P5-1 已落地（核心页投影搬进 `appstate`）**：`Index.ets` 里 `pluginInventoryFact` 与 `corePluginRows` 是两个**纯投影**（宿主报告 → 核心页的事实与行），一行 UI 都不碰，却住在最大的那个页面文件里。搬到 `appstate/model/CoreProjection.ets` 时第一版编译就**红了** —— ArkTS **禁止结构化类型**（`arkts-no-structural-typing`）："字段一样"的接口**不能**互赋，只能 `extends`。出路两条：让 `appstate` 反向依赖 `hostruntime`（**方向是反的**，它连 `oh-package.json5` 的 `dependencies` 都是空的），或者让调用点把用到的字段**逐个取出来** —— 选了后者，签名改成 `pluginInventoryFact(note, version, totals, nativePackageCount)` / `pluginRowOf(...)` / `rankPluginRows(rows)`，接口降级为"参数分组"（避免 7 个位置参数写错顺序）。`rankPluginRows` 只排序不隐藏、且**返回新数组**（调用点那份仍保持清单原顺序）。fixture **+18 → 595 条**；`Index.ets` 4061 → **4031 行**；裸值随之下减少，令牌棘轮从 23 处 / 9 文件拧到 **21 处 / 8 文件**。**规律**：最值得继续搬的是"页面里长出来的纯投影"，判据是**它有没有 import ArkUI**，而不是它有多长。
**P2-17 已落地（侧栏收起状态落盘）**：照抄详情栏宽度记忆那一套（`LocalPrefs` + 启动读回 + 变更落盘），但多了一个**三态**问题 —— 侧栏默认是展开，而"偏好里没有记录"若直接读成 `false`，就会把"从没设置过"变成"收起"（用户第一次启动只看到一条 rail）。故 `KEY_SIDEBAR_EXPANDED` 存 `'true'`/`'false'` **字符串**、用 `has()` 判存在、缺失即 `undefined`；"没存过时用什么"这一步放零依赖纯函数 `sidebarExpandedOf`（fixture **+3 → 577 条**）。落盘失败**不弹提示** —— 与宽度记忆**有意不同**：它下次只是回到默认展开，没有信息损失。
**P2-16 已落地（新建会话入口补全）**：让侧栏能收起之后顺手查出**收起之后的直接后果** —— `＋ 新建会话` 这个一级入口**只画在 `panelBody`**（PANEL 呈现）里，于是：三栏收起侧栏（rail）时没有它，**单栏手机走底部标签栏时也没有它**，用户只能靠空态里那个按钮或 Ctrl+N（还要设备有键盘）。而官方侧栏**不论宽窄**都把 New Session 当一级入口 ⇒ 这是"信息架构在窄形态下缺项"。补法：rail 里排在「展开侧栏」下面（两者都是"轨道级"动作，读起来是一组），底部标签**排第一位**；`onNewSession()` 调用点 **1 → 3 处**（三种呈现各一），并修正组件头部那句"只在品牌行下方"的过期口径。
**P2-15 已落地（侧栏终于能收起）**：上一轮删 `activeOverlay` 时留下的同模式候选 `NavigationState.sidebarExpanded`，这一轮查清了性质 —— 它**不是冗余字段，而是一个缺失的功能**：侧栏呈现完全由形态决定（`shellTracksOf`：单栏浮层 / 双栏 rail / 三栏 panel）⇒ **官方 AppFrame 那个"收起侧栏腾出宽度"的动作在本仓做不到**。新增零依赖纯函数 `sidebarPresentationOf(mode, expanded)`（**单栏一律浮层**：那个档位没有"展开的侧栏"，按钮也不给；双栏默认 rail、可展开；三栏默认 panel、可收起），品牌行加「收起」、rail 顶部加「展开」—— **少了后者"收起"就是一道单向门**。fixture **+7 → 574 条**，并钉进功能接线门禁（第 18 项：纯函数判定 + 门面开关 + 视图控制点）。**规律**：见到"字段 + setter + 无人读"，先问"它描述的东西别处有没有真值" —— 有就删（`activeOverlay`），没有就是缺控制点（`sidebarExpanded`）。
**P2-14 已落地（删掉"只有 fixture 在用"的浮层状态机）**：从"导出了但 UI 从未引用"清单入手，查到 `NavigationState.activeOverlay` / `Overlay` / `openOverlay` / `closeOverlay` 在 `entry` 侧 **0 引用** —— 真实的浮层优先级由 `Index.overlayState()` 从六个布尔**派生**，于是这套字段**永远停在 `Overlay.NONE`**。它之所以"看起来还活着"，是因为 fixture 里有 3 条断言**只测它自己**（自证循环）。已删除，fixture **570 → 567**（**少的是自证断言，不是回归**）。**宁可少三条断言，也不要一套与真实界面平行的状态机**。同一份清单里 `sidebarExpanded` 是下一个同类候选（字段 + setter + 无人读）—— 它要"侧栏收成 rail"的产品语义，故登记待定，不在本轮顺手删。
**P2-13 已落地（单栏 Sheet 的右栏切换器）**：右栏的面板切换器此前只画在真右栏 / 侧边面板那一份里，而**单栏的详情 Sheet 没有它** ⇒ 手机用户打开详情后**根本切不到文件 / 预览 / 工具 / 子代理 / 交付物 / 轨迹**（P3 登记的第三个缺口，属"功能不可达"级别）。修法：切换器抽成共用的 `@Builder panelSwitcher()`，两处都调；顺手换掉 Sheet 里那句固定的「工具 / 子代理 / 交付物 / 目标 / 任务」提示 —— 它对文件 / 预览 / 详情三个面板是**错的措辞**。P3 另两个缺口（**滑入动画**与**拖拽调宽**）都属观感且**必须真机验收**，按本仓纪律继续留在登记里等设备通道。
**P2-12 第二步（门面接线完成）**：`RightbarShell` 的 **12 个内容 props 收成一个 `f: RightbarFacade`**（组件内 39 处用法改 `this.f.X`），`AppShellFacade` 里透传的 **11 个 `right*` 成员全部删除**；两处挂载点（三栏真右栏、详情浮层）现在都调同一个 `Index.buildRightbarFacade()` —— 浮层那一份此前是**内联重算**（`deliverablesOf` / `itemsOfKind` / `buildRightFilesFacade` 各写一遍），正是"新加一个面板很容易只给一处"的来源。顺便删掉浮层里重复的"`text.length > 0` 才复制"判断。**行数的诚实账**：`Index.ets` 4019 → **4026（+7）** —— 这一轮的收益是"两处只有一个真值"，不是变小；只看行数会误判它白做。
**P2-12 第一步（右侧内容门面定义）**：准备拆「详情浮层」时发现它只是一个 `RightbarShell({...})` —— 真问题不是那 36 行，而是 **`RightbarShell` 有两个挂载点、各自把 16 个 props 拼一遍**（真右栏经 `AppShellFacade` 的十来个 `right*` 成员；详情浮层在页面根**内联重算**）。只要有一处漏改，同一个面板在两种呈现下就会不一样。本轮先定义 `export interface RightbarFacade`（12 个两处共有的成员，并写明"每个挂载点只提供它自己那份"）；**接线留到下一轮**，那样改动面一眼可数。本轮**行数不变**（4019）—— 产出是契约，不是搬家。
**P2-11 已落地（`Index.ets` 第三、四刀）**：一次搬两个浮层 —— `view/CredentialSheet.ets`（127 行，保留三条真机实测语义：输入框**显式 44vp 高**（E95）、明文**只在这一个请求里存在**、**成功时才关面板**）与 `view/ChoiceSheet.ets`（99 行，单选即提交、**没有多余的"确定"按钮**，并保留"原生 Sheet 自己就是表面"这条修正）。抽完这两个，`sheetContent` 的六个分支现在**各是一句组件调用**——"谁在显示就渲染谁"只要看六行。`Index.ets` **4133 → 4019 行**（P2-9…P2-11 四刀合计 **4480 → 4019**）。
**P2-10 已落地（`Index.ets` 第二刀）**：两个设置编辑浮层各自成组件 —— `view/SettingTextSheet.ets`（131 行，文本/数字项）与 `view/SettingStructSheet.ets`（142 行，JSON 整值编辑，含"恢复为当前值"与"恢复默认"两个安全网）。它们的**输入提示**（类型 / 范围 / 步长 / 正则 / 必填 / 当前值占位）搬进零依赖的 `appstate/model/SettingEditors.ets` （**+12 条 fixture → 570 条**），并顺手消掉"当前：X / 当前未设置"两处各写一遍的隐患。两个组件接受**可空 item** 并早返回 —— 而不是让宿主造一个 **20 个字段**的占位设置项（那正是"形状靠猜"的坑）。`Index.ets` **4297 → 4133 行**（P2-9/P2-10 合计 4480 → 4133）。
**P2-9 已落地（`Index.ets` 第一刀）**：`Index.ets`（4480 行）是现在最大的单点，本轮拆出其中**最自足的一个浮层** —— `view/FolderPicker.ets`（297 行）带走沙箱目录选择器的**全部**（当前路径 / 子目录 / 提示 / 开合 + 读目录、进目录、上一级、新建、选定五个动作）。打开它的**两个**入口（设置里"选择文件夹"与系统选择器失败后的降级）用**控制器对象**（与 `TurnViewController` 同源）；控制器上必须有 `close()` —— **原生 Sheet 的关闭路径（下拉/遮罩/按钮）不经过组件**，少了它浮层会再也打不开（与 `bindContextMenu.onDisappear` 同一个坑）。沙箱根留在宿主（`getContext` 是平台能力），拿不到就不打开并说明原因。`Index.ets` **4480 → 4297 行**。
**P2-8 已落地（浮层结果出口按归属）**：本轮动手拆 `Index.ets` 的六个浮层（≈960 行）之前先读了一遍，结果查出更要紧的东西 —— **凭据 / 文本设置 / 结构设置三个浮层共用同一对字段**（`credentialNote` 与 `credentialBusy`）。两条实测后果：① **串浮层**——凭据写入失败 → 关掉 → 打开「编辑文本设置」，**那条凭据的失败文案会出现在文本编辑浮层里**；② **跨浮层置忙**——凭据在写时文本/结构浮层的按钮也会变灰。这与设置页那条"回执没有归属域"（E347）**是同一个缺陷类**。修法：回执带归属（`sheetNoteOwner`，打开时认领、关闭与返回键路径交还归属；判定在零依赖的 `appstate/model/Sheets.ets`）+ 每个浮层拿自己的 busy。fixture **+11 → 558 条**。**拆那 960 行的计划留到下一轮** —— 修完缺陷后它们是零风险搬家。
**P2-7 已落地（会话头上下文行）**：补官方 `conversation.header` 的 **Workspace context / Model / 最近活动** 三项 —— 此前用户得回工作区列表才知道这场会话在哪个目录里跑。规则做成零依赖纯函数 `appstate/model/SessionContext.ets`（工作区名取**末两段**：同名目录会撞；三段拼装**每段拿不到就不出现**、全空则整行不画），fixture **+14 → 547 条**。"现在"由调用点在渲染时给，**不引入第二个定时器**。`Agent preset` / `Schedule` / `Open in App` 三项**如实不做**（缺"当前会话的预设名"与协议面），留在缺口台账。
**P2-6 已落地（第二刀：一个回合的渲染整块搬出）**：`view/TurnView.ets`（492 行）带走回合骨架、过程分组、条目分派、思考/目标/错误三块、展开集合与消息动作与反馈辅助共 20 个成员。**展开集合留在子组件、按钮在父组件** ⇒引入**控制器对象**（父组件持空壳、子组件 `aboutToAppear` 注册实现；与 ArkUI `Scroller` 同源）。思考块抽成 `view/ReasoningRow.ets`（83 行）供**轨迹视图**与**过程分组**共用；轨迹视图另留条目级 `flatItem` 分派 —— **共享卡片，不共享分派**（两者上下文不同）。`ConversationPane` 1087 → **984 行**（P2-4…P2-6 合计 1414 → 984）。上一轮新增的死代码门禁当轮就抓出 2 处搬迁残留（`TurnView.reasoningItem` 已被取代；`hitIds`/`fbRating` 两个 prop 没有读者）。
**P2-6 已落地（第一刀：把「搬迁留下死代码」变成门禁）**：前两轮反复出现同一类无感缺陷 —— 编译通过、界面正常、八门禁全绿，而宿主体内躺着一批**零使用**的壳（E345 三个零调用 `@Builder`、E346 拆走两段后宿主那段唯一的读者还活着、E346b `settingsStates` 一条没人读的死链），三次都是我手工扫出来的。现固化成第 **9** 道门禁 `tools/check-dead-code.mjs`：零使用 **import / `@Builder` / 组件成员**三条判定，含 **9 条注入式自检**，并**对修前的 `SettingsPane` 归真命中 5 处**真实死代码。门禁在当轮就查出并删掉 3 处真死代码：`MessageFeedback.itemId`、`MessageRow.menuHint`、`SettingsPane.settingRow`（P4-3 的薄包装，P4-5 之后一个调用点都没有）——删 `menuHint` 的绑定还连带暴露 `ConversationPane.inputModality()` 成了死方法。
**P2-5 已落地（会话正文第二刀）**：把会话头那四块**不在列表里的** chrome 抽成
`view/ConversationHeader.ets`（284 行）—— 视图切换 + 轨迹工具栏（展开全部 / 收起全部 / 事件计数）、
后台任务条（官方 `conversation.header.jobs`，live 任务每秒走字）、时间总览、会话内搜索条。
**分工口径**：跨行状态（搜索的命中判定、任务条定时器）留在父组件，块内状态留在子组件；
`stats` 改成**必需 prop** —— 不造"全 0 的默认统计"，那会让"没接到数据"看起来像"这场会话什么也没花"。
`ConversationPane` 1234 → **1093 行**（P2-4/P2-5 两刀合计 1414 → 1093）。
**P2-4 已落地（会话正文第一刀）**：把"**一条消息**"整块抽成 `view/MessageRow.ets`（221 行）——
它带走了此前散在正文组件里的**五份行级状态**（悬停、上下文菜单开关与归属、反馈面板归属与回执）、
两个 `@Builder`（行内操作条、上下文菜单）与三条输入策略判定包装（悬停 / 右键 / 手势提示）。
**边界如实划定**：跨行的「展开全部」态、要读中枢反馈记录的动作清单、以及反馈的持久化，
都**留在父组件**（与 `ToolCard` 的 `expanded` 同一条规矩）。顺带删掉一处重复实现：
视图私有的 `clockOf` 与模型的 `formatClock` 逐字等价，保留带 fixture 的那个。
`ConversationPane` 1414 → **1234 行**。
**P4-6 已落地**：① 最后一段内联内容拆成 `view/SettingsCore.ets`（78 行，包住 `CorePane` + 两块提示；
它是 E118「`@BuilderParam` 注入在真机崩溃」的修复形态，不是多余转发层）。
② **修掉一个真缺陷（E347）**：设置写入回执是一个全局字符串、只有**一个**读取点（设置页顶部那条回显），
于是一方面切分区会把上一段的回执带过来（看起来像本页刚写出来的结果），另一方面——
更糟——**7 个工作区/会话函数、19 处回执写在设置通道里**，用户在会话里点「归档」等操作
**根本看不到任何回执**（"点了没反应"）。现在：设置回执带**归属域**（`settingsWriteDomain`，
只在"域 == 当前分区"时显示），工作区/会话回执改走会话输入区那条通道（`attachNotice`）。
域判定搬进**零依赖**的 `appstate/model/SettingsDomains.ets`（原文件再导出，所有导入点一字未改），
于是它能被 fixture 直接执行 —— **+19 条断言**（五类命名空间 + 三类"不猜"边界 + key→域三条边界）。
`SettingsPane` 497 → **500 行**（P4-1…P4-6 合计 **1890 → 500**），设置域九个组件：
`SettingRow` / `SettingsGeneral` / `SettingsModels` / `SettingsPlugins` / `SettingsInventory` /
`SettingsSkills` / `SettingsPresets` / `SettingsCore` / `SettingsDevice`。
**P4-5 已落地**：设置页最后两段大内容拆成域组件 —— `view/SettingsSkills.ets`（95 行：技能清单 + 读取结论，
只吃两个 prop、无写入动作）与 `view/SettingsPresets.ets`（271 行：官方这一页的两半——预设名单卡片
（复制 / 查看 / 两步确认删除）与 `agent-*` 分区编辑器，含三个组件内临时态与「查看」的中枢直读）。
**同时清掉 16 个零消费者成员**：搬走那段唯一的读者（6 个 prop/回调）、已住进域组件的三个临时态、
只服务于预设段的 `agentGroups()`，以及 `settingsStates` 这条**从头到尾没人读的死链**（中枢快照 →
`Index.@State` → 主区门面 → 假门面成员 → `SettingsPane.states`）与 `onPickEffort`。
`SettingsPane` 758 → **497 行**（P4-1…P4-5 合计 **1890 → 497**）。
设置域的八个组件：`SettingRow` / `SettingsGeneral` / `SettingsModels` / `SettingsPlugins` /
`SettingsInventory` / `SettingsSkills` / `SettingsPresets` / `SettingsDevice`。
**P4-4 已落地**：设置页又拆出两个域组件 —— `view/SettingsGeneral.ets`（通用段 + 只读权限事实 + 本地调试入口）
与 `view/SettingsDevice.ets`（已记住的 Host + 关于本机）。**设置页 1890 → 760 行**（P4-1…P4-4 五轮合计），
拆分出的域组件：`SettingRow` / `SettingsModels` / `SettingsPlugins` / `SettingsInventory` / `SettingsGeneral` / `SettingsDevice`。

**P4-3b 已落地**：设置页最大的一块——**模型域**（提供方卡片 + 凭据联接 + 新会话默认 + 全量模型目录，
约 550 行）搬成 `view/SettingsModels.ets`（645 行），行渲染复用 `SettingRow`。
`SettingsPane` **1890 → 932 行**（P4-1…P4-3b 四轮合计）。

**P4-3a 已落地**：设置页最忙的一块——**设置行**（开关/单选/文本/结构编辑/恢复默认 + 值来源提示）
连同它的三个取值助手与**四个模块级函数**（官方中文措辞表）搬成 `view/SettingRow.ets`（300 行）；
通用段、预设段、以及下一步要拆的模型域都用它。`SettingsPane` 1694 → **1458 行**。

**P4-2 已开工**：设置页按域拆组件 —— 拆出 `view/SettingsPlugins.ets`（插件配置域）与
`view/SettingsInventory.ets`（只读清单域），正好对应 P4-1 刚分开的两个分区；
顺带删掉 52 行**零调用**的 `credentialsTab`（凭据早已并入模型段）与一处**重复渲染的摘要行**。
`SettingsPane` 1890 → **1698 行**。下一步拆最大的一块：模型域（≈400 行）。

**P4（设置域）已开工**：设置分区进了注册表（P4-1）——新增 `PanelLocation.SETTINGS` +
`settingsSections()`（8 项：官方四段**通用 / 模型 / 插件 / 插件清单**在前，本仓特有的
核心 / 预设 / 技能 / 设备标 `owner: 'dshm'` 在后），与侧栏、右栏**共用同一套**
「清单 + 排序 + 可用性 + 切换器」机制；视图里的 `@State tab` 删除，唯一真值回到
`NavigationState.settingsSection`。「插件清单」从插件段的子页签**升级为独立分区**（官方口径）。
下一步：设置页按域拆组件（`SettingsPane` 1878 行，仍是最大的视图文件）。

**P3 收口**：右栏「**轨迹**」面板落地（P3-6）—— 时间总览抽成 `view/TimelineOverview.ets`，
主区轨迹视图与右栏**共用同一份**；右栏**只放总览不放全量台账**（官方右栏的 trajectory 是"当前回合的过程"，
而本仓 `TrajectoryItem` 没有回合字段 ⇒ 宁可少放一份，也不照抄主区台账）。
**官方右栏六个候选至此全部接上**（文件 / 预览 / 交付物 / 子代理 / 工具 / 轨迹）+ 本仓特有的「详情」= 七个面板；
`ConversationPane` 1714 → **1414 行**；下一个阶段是 **P4「设置」域**。

**P3-5 已落地**：右栏「**工具**」「**子代理**」面板 —— 工具卡抽成 `view/ToolCard.ets`（163 行，
含改动对照的那一整套判定，宿主只给数据 + 展开态 + 回调）、子代理卡抽成 `view/SubagentCard.ets`（40 行），
两者都与会话过程流**共用同一份**卡；`ConversationPane` 1714 → **1534 行**。
右栏可用面板六个（详情 / 文件 / 工具 / 子代理 / 交付物 / 预览），只剩「轨迹」内容未做。

**P3-4 已落地**：右栏「**交付物**」面板 —— 交付物卡从 `ConversationPane` 抽成 `view/DeliverableCard.ets`，
右栏面板与会话过程流**共用同一份**卡；筛选是**纯模型**（`itemsOfKind` / `deliverablesOf`：保序 +
**同 id 只留最后一条**——同一条会被流式 merge 多次，"有几件事"不能等于"更新了几次"）。右栏可用面板：详情 / 文件 / 交付物 / 预览。

**P3-3 已落地**：右栏「**文件**」面板 —— 文件树从 `WorkspacePane` 抽成 `view/FileTreePane.ets`，
右栏与工作区页签**共用同一份**（展开/选中/交付物标记/分档空态）；`WorkspacePane` 464 → **274 行**
（预览与文件树两轮搬出后，它退化成"列表 + 两个挂载点"的装配层）。右栏可用面板：详情 / 文件 / 预览。

**P3-2 已落地**：右栏「**预览**」面板 —— 预览呈现从 `WorkspacePane` 抽成 `view/FilePreviewPane.ets`，
右栏与工作区页签**共用同一份**（含空态与两档"看不了"的说明）；注册表里 `right.preview` 从此可用。
可用面板 ≥2 ⇒ 右栏标题行出现**切换器**（只在一个可用面板时不画，避免噪声）。

**P3（右栏）已开工**：右栏**按面板 id 分派**（P3-1）——`RightbarShell` 新增 `panelId`/`panelLabel`，
`selectedRightPanel` 这个在模型里躺了几轮的字段**第一次有了消费者**（此前视图无条件渲染 `DetailPane`，
那条"切右栏面板"的 fixture 断言其实与界面无关）。同时如实登记了缺口的真实位置：
官方六个候选（文件/轨迹/工具/子代理/交付物/预览）**席位在、内容视图没做** ⇒ 一律不可用（E110 口径，
避免"点进去是空面板"）；唯一有内容的是**新增的**「详情」面板（对应官方 `conversation.detail` 那一类，
**不冒充"文件"**）。下一步（P3-2）：「文件」「预览」两个面板——它们的素材与渲染都已在仓内，属搬家 + 接线。

**P2-3 已落地**：消息反馈面板拆成独立组件 `view/MessageFeedback.ets` ——
表单态（类别/说明）归组件，宿主只留"哪条开着 + 回执 + 提交策略"；
原先它与消息列表共用一个组件，**每敲一个字都会重绘整个会话列表**。
下一步：`ConversationShell` 继续拆（Header / Content / ProcessGroup / Answer）+ 消息操作条与长按菜单 + Tool Card
（⚠️ 观感与交互须真机确认：侧栏/抽屉见 D11·D12，**正文渲染与链接见 D13**）。

理由：功能不少、页面还是不像官方，根因是**信息架构没落地**——框架错则间距、颜色、Markdown 全白做。
故 Markdown 与视觉精修**排在框架之后**，而不是先做。

## 设计原则

1. **不 fork、不魔改 dsh**：端侧差异只通过 dsh 自己的组合面（profile / `cordis.patch.yml` / bundle）表达。
2. **不申请特殊权限**：需要 JIT、ACL 之类前提的方案一律不进入选型，以保证可正常上架。
3. **界面不撒谎**：失败必须给出下一步；空态说明"可以做什么"；不可用的动作把原因写在旁边，而不是给一个点了没反应的入口。
4. **上游知识只出现在 `dshcompat`**：字段名、端点形状、事件类型集中一处，升级上游时改一个地方。
5. **产品语义跟 Web，视觉与交互用鸿蒙原生**：信息架构与行为对齐官方 Web（对等矩阵逐行登记），
   但视觉不用 Web CSS 的像素级翻译——用系统语义色、系统符号、原生控件（Sheet/菜单）、触控目标与多窗口语义表达。
   这样官方主题更新时不需要重做整套界面。

## 快速开始

### 只想装上用

到本仓库 **Releases** 下载最新的 `DSHM-1.0.0-arm64-signed.hap`，然后：

```bash
hdc install -r DSHM-1.0.0-arm64-signed.hap
```

首次启动会解包核心树（约 60–90 秒），期间停在启动页，属正常。
下载后请用同目录的 `SHA256SUMS.txt` 校验。

> Release 里附的是 **debug 签名的侧载包**，供尝鲜与验证；
> 正式分发请用 DevEco 生成你自己的发布签名。

### 想从源码构建

见上面的「构建」一节。注意**本仓库不含**原生库、核心包、工具链归档、入口脚本、Node 头文件与签名材料
（判据见「不入库的产物」表）—— 它们是构建产物或机器绑定材料，不入库。

## 真机数据保全（动手前务必读）

**绝对不要**执行 `hdc uninstall` / `bm uninstall`，或任何删除 `el2` 下用户数据的命令。
真机 `el2`（`files/dsh/home`）里的**会话 / 插件 / 工作区没有任何可用备份通道**
（`hdc` 读不到、`smode` 被拒、`run-as` 不存在），删掉不可恢复。

装机一律用**覆盖安装** —— 它只换 `el1`（代码与资源），不动 `el2`（用户数据）：

```bash
hdc install -r <hap>
```

判据：这条命令会不会碰 `el2`？会，就是禁止的。
完整事故复盘与流程见 [`docs/80-真机更新与数据保全.md`](docs/80-真机更新与数据保全.md)。

## 许可

见 [`LICENSE`](LICENSE)。

本项目是**移植**：把官方面向桌面的 dsh 运行时搬到鸿蒙。`dsh` / DeepSeek Harness 的商标与上游代码版权归其各自所有者，
本仓库只包含客户端侧的实现、适配与文档。
