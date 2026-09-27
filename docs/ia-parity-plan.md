# 阶段重定义：官方信息架构对齐（Web Information Architecture Parity）

> 本文是**当前阶段的正式工作令**，取代"缺一个功能 → 加一个组件"的做法。
> 它由项目所有者于 2026-09-14 提出并作为下一步的开发阶段。

## 0. 为什么改变阶段

现在的状态是**功能不少、页面还是不像官方**。原因不是"少了几个按钮"，而是**信息架构没落地**：

```
功能 = 很多      栏目 = 很少      框架 = 不完整      层级 = 混在一起
```

用户实际看到的是"一个很大的页面，里面塞了很多按钮、卡片、面板"；而官方是
`AppFrame → 导航层 → 工作区层 → 会话层 → 内容层 → 上下文面板层`。
**视觉好不好，很大程度上是信息架构决定的**：框架错，间距再漂亮也错；栏目错，颜色再漂亮也错；
内容层错，Markdown 再漂亮也错。所以**精修排在最后**。

## 1. 目标架构

```text
AppFrame
├── Sidebar ── Brand / New Session / WorkspaceBrowser / Panel Entries / Settings（固定在底部）
├── Main ───── ConversationShell（ConversationHeader / Content / ProcessGroup / Answer / Composer）
└── Rightbar ─ PanelRegistry（Files / Preview / Trajectory / Tool Details / Subagent / Deliverables）
```

四形态**共享同一套信息架构**，只有 `geometry / input / panel presentation` 不同：

| 形态 | Sidebar | Main | Rightbar |
|---|---|---|---|
| 手机 | Drawer / Sheet | 全屏 | Sheet / 全屏 |
| 平板竖屏 | Rail | 主区 | Sheet / 浅层面板 |
| 平板横屏 | 面板 | 主区 | 真右栏 |
| PC / 2-in-1 | 面板 | 主区 | 真右栏 |

## 2. 当前事实（已核对仓库，不是印象）

| 项 | 现状 |
|---|---|
| 一级导航 | `NavTab` = `WORKSPACES(工作区)` / `CORE(核心)` / `SETTINGS(设置)`；`SESSIONS` 是 `WORKSPACES` 的**别名**，`PENDING` 保留常量但**不占页签**（`Breakpoints.ets`） |
| 页面装配 | `Index.ets`（约 5000 行）同时负责：页面判断 / 导航判断 / 布局判断 / Pane 装配 / Overlay / Sheet / Back / 会话内容 |
| 工作区 | 树（`workspaceHub` + `workspaceGroup`）已抽成 `view/WorkspaceBrowser.ets`（P1-1），但**仍挂在主区的「工作区」页签上**；侧栏还没有它（窄版行未做）。原写的"`WorkspacePane` + `SessionListPane` 两个并列 Pane"是**过期描述**——后者早已没有渲染点，P1-1 已删除 |
| 右栏 | `LayoutController` 已有可用空间/夹取/拖拽/宽度记忆；但仍是"主页面旁边放一个详情组件"，没有 `PanelRegistry → selectedPanel → PanelOwner` |
| 设置 | 单一 `SettingsPane.ets`，没有 General / Models / Plugins / Plugin Inventory 的域划分 |
| 面板体系 | **没有** `PanelId` / `PanelDescriptor` / `PanelOwner` |

## 3. 分步计划（每步 <500 LOC，门禁全绿，如实区分实现完成与真机待验收）

### P0 页面框架（AppFrame）

**进度（2026-09-15）**：**P0 已完成**（纯逻辑层 + 三形态轨道 + 三条轨道 chrome 各有其主 + 主区内容全部搬出）。
下一步 P1（Sidebar 重建），见文末「下一步」。

| 子项 | 状态 |
|---|---|
| `appstate/model/PanelRegistry.ets` | ✅ 已落地（`PanelId`/`PanelLocation`/`PanelDescriptor` + `register`/`unregister`/`descriptors`/`find`/`select`/`canSelect`/`firstAvailable`） |
| `appstate/model/NavigationState.ets` | ✅ 已落地（**页面 ≠ 选中的面板**：`selectedMainPanel` / `selectedRightPanel` / `settingsSection` / `sidebarExpanded` / `mobileDrawer` / `activeOverlay`；转移全部经注册表校验） |
| `appstate/ui/ShellTracks.ets` | ✅ 已落地（四形态下三条轨道**怎么呈现**；只变几何，不变信息架构） |
| 与既有导航的迁移桥 | ✅ 已落地（`mainPanelOfLegacyTab` / `legacyTabOfMainPanel`，含往返断言）——**迁移期间行为不变** |
| fixture | ✅ 46 条（注册表 12 / 导航状态 16 / 迁移桥含往返 10 / 四形态轨道 8） |
| `view/shell/SidebarShell.ets` | ✅ 已落地：**侧栏内容归它所有**（品牌行 / 面板清单 / 待决徽标 / 二级入口 / Settings 固定底部），三种呈现（PANEL / RAIL / 底部标签）都在它内部 |
| `Index` 的三段侧栏 builder | ✅ 已改为委托（只保留"这条轨道的 surface"：宽度与底色） |
| `view/shell/RightbarShell.ets` | ✅ 已落地：右栏**面板本体**归它所有（标题行 / 关闭入口 / sections / 宽度与底色），三种呈现（真右栏 / 侧边浅层面板 / Sheet）都在它内部 |
| `@Provide/@Consume` 机制 | ✅ **已小范围验证并在真实用途上用起来**：`Index` `@Provide('panelRegistry')`、`SidebarShell` `@Consume` 并按注册表可用性过滤入口（编译通过）。⚠️ 运行时行为**必须真机确认**（`@BuilderParam` 编译通过但真机崩过，D4）⇒ 见 `docs/device-validation.md` **D9** |
| `NavigationState` 成为视图唯一真值 | ✅ **已落地**：`Index` 的 `@State tab: NavTab` 已删除，页面选择改由 `nav.selectedMainPanel` 决定；`NavTab` 退化为**迁移期别名**（经 `legacyTabOfMainPanel` / `mainPanelOfLegacyTab` 双向桥，往返有断言）。切页签同样**经注册表校验**（不可用的面板切不过去） |
| 主区"此刻显示哪个面板" | ✅ **已收进纯模型**（`activeMainPanelOf`：下钻页 > 会话页（须有会话）> 选中的面板），视图只按一个值分派 |
| `view/shell/MainHeaderShell.ets` | ✅ 已落地：主轨道的**页头**归它所有（返回 / 标题 / 详情入口），只认三个 props + 两个回调——导航与几何事实留在宿主 |
| 命令面板拆解 | ✅ 已完成：`GoalBar`（零 props）→ `SessionModelPicker`（3 props + 1 回调）→ `CommandList`（2 props + 1 回调）。呈现归组件、判定与副作用归宿主 |
| 连接横幅 | ✅ `view/HubBanner.ets`（6 props；保留"重连仅在 DEGRADED 出现"与协议旁路日志尾部两条语义） |
| **主区搬迁的真实规模** | 已勘清：`tabContent` 182 + `workspaceHub` 158 + `workspaceGroup` 119 + 其余分支 ≈ 230 ⇒ **约 690 行 + 40 余个门面成员**；且确认体内**只有 1 个 `@Builder` 调用**（`tabContent`），故门面方案成立 |
| 面板组件清单 | `view/GoalBar.ets`、`view/SessionModelPicker.ets`、`view/CommandList.ets`、`view/shell/{SidebarShell,MainHeaderShell,RightbarShell,TrackResizer}.ets` |
| `view/shell/TrackResizer.ets` | ✅ 已落地：**轨间把手**（不属于任何一条轨道）；命中区域按输入模态放宽、拖动策略仍在纯模型里。⇒ AppFrame 的 chrome 四位各有其主 |
| **主区第一束** | ✅ **已搬出**（`view/TabContentView.ets`，459 行 / 86 门面成员 / 29 处 setter 改写；Index 5040 → 4665 行）。关键：`does not meet UI component syntax` 其实是**导入路径错**的伪装 |
| **主区第二束** | ✅ **已搬出**（`view/shell/MainShell.ets`，409 行 / 77 门面成员 / 33 处 setter 改写）。**`Index.ets` 5040 → 4518 行** |
| **P0 验收：`Index` 不再负责页面级 Pane 选择** | ✅ **达成**：`Index.mainContent(compact)` 现在只是一句 `MainShell({ f: this.buildMainFacade(), compact: compact })`；四个 E分支（诊断/连接/会话/标签页内容）都由 `MainShell` 选择与渲染 |
| **`view/shell/AppShell.ets`（三形态轨道 + 轨道 chrome）** | ✅ **已落地**（316 行 / 25 门面成员 / 3 处 setter 改写）：`buildSingle` / `buildDouble` / `buildTriple` 的轨道拼装、`header` / `headerTitle`、`navPanel` / `navRail` / `bottomTabs`、`detailColumn` / `detailResizer` / `sidebarPresentation` 全部归它；`Index` 的对应 builder 已删除。⇒ **`Index.ets` 4518 → 4290 行** |
| **`AppShell` 的边界：门户留在页面根** | ✅ **有意为之**：`bindSheet` 是**组件属性**（同一节点只能绑一个），而六类浮层的内容 builder 仍在 `Index`（它们属 P4「Settings / 浮层域」，且 `@BuilderParam` 注入在真机崩过 = E118）⇒ 门户挂在**页面根** `Index.build()`，`AppShell` 只画轨道。这不是妥协而是语义正确的分层：官方 Web 的 portal 也在 `App` 根，不在任何 pane 里 |
| **P0 收尾时发现并修掉的真实缺陷** | 🔴→🟢 门户原先挂在 `buildSingle` 的根 `Column` 上 ⇒ **双栏/三栏下列表里那些浮层根本打不开**（模型选择 `choosing`、凭据 `credentialRef`、目录 `folderOpen`、文本/整值设置 `textSettingKey`/`structSettingKey` —— 它们的触发点都在**主区内容**里，而主区在三种形态下都可见）。**不是没做，是够不着**。修法：门户提到页面根，与形态无关 |

**AppShell 不能用"注入 Builder"那条路（有真机实证）**

`docs/50` 的 **E118** 记录了本仓一次真机崩溃：`@BuilderParam coreSlot`（把父组件的 `@Builder`
注入子组件再调用）⇒ 真机点按即 `JsError` 杀进程；修复办法是**显式传 6 个属性**。
所以"`AppShell` 接收三条轨道的内容"这条路**在本仓真机不可用**——`@BuilderParam` 编译能过，
真机不认。可行的两条路：

1. **显式 props**（E118 已验证的形态）：`MainShell` 接收主区所需的数据与回调。P0 剩下的量在于
   主区六个面板的 props 面（约 100 项），机械但可观。
2. **`@Provide/@Consume`**（本轮已在侧栏验证编译通过；**运行时待真机确认**，见 D9）：
   可以显著缩小 props 面——但按 D9 的闸门，**D9 通过前不用于主区**。

**主区内容搬迁：量化结论（2026-09-15，脚本实测）**

| 项 | 数字 |
|---|---|
| 需搬的 builder | `mainContent` 276 行 + `tabContent` 182 + `workspaceHub` 158 + `workspaceGroup` 119 = **735 行** |
| 门面成员 | **108 个**外部引用（值 + 方法），其中 4 个（`attachWorkspaceFileToComposer`/`pickAndAttach`/`runDiagnostics`/`writeSetting`）的声明形式不是单行，需单独处理 |
| 阻碍脚本化的点 | 108 个方法包装需要精确签名（部分多行）；且**体内有 1 个 `@Builder` 调用**（`tabContent`）⇒ 那一段必须作为组件自己的 builder 一起搬 |

⇒ **不靠一次性脚本**。执行顺序（每步跑全门禁）：① 先搬 `tabContent` + `workspaceHub` + `workspaceGroup`（459 行，它们互相调用、自成一束）② 再搬 `mainContent` 的四个分支 ③ 最后搬分派骨架。
**门面按"搬一束、生成一束"增量长出来**，而不是一次生成 108 个成员——这样每步的编译修复面都可控。

**⚠️ 第一束实操后的关键发现（2026-09-15，本轮实测）：门面必须带 setter**

本轮真去搬了第一束（`tabContent` + `workspaceHub` + `workspaceGroup`，459 行），一路修到只剩 4 类错误时，
发现一个**比编译错误严重得多**的问题：

> 被搬走的代码**会写宿主状态**——`this.treeEmptyTitle = '…'`、`this.pendingWorkspacePick = true`、
> `this.treeEmptyHint = '…'` 等等。门面的成员若是**普通属性**，这些赋值只会写进**门面副本**，
> 宿主永远收不到 ⇒ 不是编译错误，而是**静默行为错误**（界面看着正常，状态没变）。

**因此门面的每一类成员都要按语义分型**：

| 成员 | 门面里应是 |
|---|---|
| 只读值 | `x: T`（快照） |
| 只读方法 | `x(...): R`（闭包） |
| **被写的值** | **必须 `setX(v: T): void`**，并把搬走代码里的 `this.f.x = v` 改写成 `this.f.setX(v)` |
| 被调用的组件/其它 builder | 它们**已经是组件**（如 `hubBanner` → `HubBanner`）⇒ 直接渲染组件，不走门面 |

### 第二束（`mainContent`）的实操结果（2026-09-15，本轮）

生成器改造成 `dist/scratch/mig2.py` 后**已能产出 MainShell**（397 行、77 个门面成员、33 处 setter 改写），
`Index` 在临时状态下到 **4391 行**，但未通过编译——**只差最后一类接缝**：

> **`Index` 的模块级辅助函数/常量进不了门面**（方法才行）。被搬走的代码用到它们（**裸引用**，不是 `this.X`）：
> `storageBaseUrl`(2) / `composeHostUrl`(3) / `extractToken`(2) / `prettyJson`(3) / `reportConnectedHost`(3) / `TAG`(41)。
> appstate 里**都没有**这些名字。

**下一轮的最小修法**（二选一，推荐 A）：

**A. 让生成器支持模块级名字**（改 `mig2.py` 即可，约 20 行）：
1. 扫描 `Index` 的 `^function name(` 与 `^const NAME:`，得到"模块级名字 → 签名/类型"；
2. 若搬走的代码引用了它们，就当作门面成员生成：函数 → `name: (a, b) => R` + 包装 `name: (a, b) => name(a, b)`；
   常量 → `NAME: T` + 包装 `NAME: NAME`；
3. **额外一道改写**：把搬走代码里的**裸标识符**（`TAG`、`composeHostUrl(`…）改写成 `this.f.X`
   —— 现有的改名只处理了 `this.X`，这是它们漏掉的原因。

**B. 先把这些纯辅助函数搬进 appstate**（它们的归属本来就该在模型层），再走原流程——更干净但改动面更大。

**修法 A 已实施（本轮）**：生成器现在会扫描 `Index` 的 `^function` / `^const`，把被搬走代码引用的
模块级名字也收进门面（函数 → 方法 + 包装；常量 → 值），并对**裸标识符**加一道改写
（`\bTAG\b` → `this.f.TAG`）。生成器输出的"未归类的大写名"清单仍是**待办清单**——本轮又验证了一次
（`GoalBar`/`CommandList`/… 六个组件导入就是照它补的）。

**仍剩的三处接缝（下一轮按此收尾，都是机械操作）**：
1. **模块级函数的逐个门面条目**：`storageBaseUrl`、`composeHostUrl`、`reportConnectedHost`、`prettyJson`
   要各自在接口 + 包装里出现一次（我本轮手工补了 `storageBaseUrl`，`reportConnectedHost` 就报下一个
   ⇒ 说明**要一次性全补**，别一个一个来）；
2. **重复方法**：生成器的"插入委托"与手工插入各留了一份 ⇒ 收尾时先 `grep -c "<方法名>("` 确认只有一份；
3. **`connection` 包专名**：`extractToken` / `parseJson` 来自 `'connection'`（不是 appstate）。

**结论**：`mainContent` 这一束**不是路线问题，是"少处理了一类名字"**。两束合起来已证明生成器路子在 `tabContent` 束上完全跑通。

**生成脚本已留档**：`dist/scratch/mig.py`（已含两次实操修掉的全部坑：括号配平、装饰器同搬、导入差集、
深度扫赋值、setter 生成、委托保参、`build()`、子组件与纯函数导入）。**下一轮直接改它**，不要重写。
（放在 `dist/` 下——它已被 gitignore，属工具而非产物；`/tmp` 会被别的进程干扰。）

**⚠️ 第二次实操的收敛结果（2026-09-15）：只剩 4 个"UI 组件语法"错误**

按修正后的顺序（写点分析 → setter → 生成）**真的把第一束搬完了**，编译从 100+ 错误收敛到 **4 个**，
且它们同型：

```
'HubBanner({ … })'    does not meet UI component syntax   ← 在 @Builder workspaceHub 里
'PendingPane({ … })'  does not meet UI component syntax   ← 在 @Builder workspaceHub 里
'WorkspacePane({ … })' does not meet UI component syntax  ← 在 @Builder tabContent 里
'SettingsPane({ … })' does not meet UI component syntax   ← 在 @Builder tabContent 里
```

也就是说：**"在被搬进组件的 `@Builder` 里实例化别的 `@Component`"这条写法没通过 ArkUI 检查**。
已排除的猜想：导入路径（已从 `'../X'` 改成 `'./X'`，错误不变）、缺 `build()`（已加）、
`@Prop` 门面类型（编译器没有就此报错）。

**下一轮先从这 4 个错误入手**，候选排查方向（按可能性排序）：
1. `@Builder` **带参数**时（`tabContent(compact: boolean)` / `workspaceHub(compact: boolean)`）
   其内部是否允许实例化自定义组件 —— 试着把这些子组件挪到一个**无参 `@Builder`** 或直接放进 `build()`；
2. 自定义组件调用是否必须**独占一行**或以 `})` 结束语句（当前是 `})` 后无分号，样式与 Index 一致）；
3. 把 `HubBanner`/`PendingPane`/`WorkspacePane`/`SettingsPane` 从"组件"改成**通过门面渲染**的形态
   （即它们也走 `@Builder`？—— 但那条路已被 E118 否掉）⇒ 更可能是 1。

**本轮同样回退**（保住绿灯）。但两次实操把可变因素收敛到"一处 ArkUI 约束"，不是"整条路线不成立"。

**下一轮的执行顺序**（已按本轮踩到的坑修正）：
1. 用脚本先做**写点分析**（列出 `this.X = …` 的目标），据此把成员分成"读 / 写 / 方法"三类；
2. 生成门面时：写成员生成 `setX`，搬走的代码里把赋值改写成 setter 调用；
3. 再走本轮已验证通过的其余步骤（装饰器连同方法一起搬、括号配平切段、值导入与类型导入分别取差集、
   组件依赖（`WorkspacePane`/`SettingsPane`/`PendingPane`/`HubBanner`）与纯函数（`formatClock`/`relativeTime`/`sessionEmptyCopy`）
   一并导入）。

本轮**已回退**（保住绿灯）：证明这条路可行但需要 setter 那一层，不在预算中途留破损。

**主区内容搬迁的可行方案（已勘明，下一轮按此机械执行）**

`mainContent()` 345 行、依赖宿主约 100 个 `@State`。逐 `this.x` → `props.x` 重写既慢又易错，
故采用**门面（facade）**方案：

1. 定义 `MainShellFacade`（`view/shell/` 内的接口）：成员名与宿主字段/方法**同名**
   （`stackPage`、`selectedSessionId`、`hubConnected`、`showsConversation()`…）。
2. `Index` 提供 `private buildShellFacade(): MainShellFacade`——**每次渲染重建**
   （值型成员是快照、方法型成员是 `() => this.xxx()` 闭包）。⚠️ 必须每次重建：
   门面若被缓存，"中枢变了但界面不更新"就回来了。
3. 把整段内容**原样搬进** `MainShell`，只做一次机械替换：块内 `this.` → `this.f.`。
4. `Index` 侧变成 `MainShell({ f: this.buildShellFacade() })`。

**为什么可行**：它不碰 E118 那条禁令（没有 builder 注入），也不用等 D9（不依赖 `@Provide`），
只是把"父组件读自己的状态"换成"子组件读传来的门面"。
**风险与纪律**：一次只搬一个面板分支（诊断 → 连接 → 会话 → 其余），每搬一块跑全门禁；
`mainContent()` 的**分派骨架留在最后**搬，否则中间态会出现两处分派。

**因此下一步的次序是**：先做 `AppShell` 的**不含内容注入**部分（根容器、overlay/sheet 宿主、
返回处理、快捷键与输入证据采集挂在同一处），再按上面两条路之一逐步把主区搬出去。
每搬一块跑一次全门禁。

**下一步的做法（写下来避免走偏）**

1. **先抽 `SidebarShell`**（最小、最自足：`navPanel` 56 行 + `navRail` 28 行 + 底部标签），
   用显式 props（导航状态 + 面板清单 + 回调）——**这一步不需要新机制**，也是 shell 模式的真实证明。
   抽完后 `Index` 不再自己写侧栏的两个 builder。
2. `AppShell`/`MainShell`/`RightbarShell` 的瓶颈是**状态归属**：主区内容（Conversation/Workspace/Core/
   Settings/Diagnostics/Connect 六个面板）现在直接读 `Index` 的 ~100 个 `@State`。把这 5000 行状态
   搬进 shell 组件、或改成 `@Provide/@Consume`（本仓**尚无先例**），是一个**要单独决策**的步骤——
   先在一个最小范围内验证该机制能编译、能在真机跑（`@BuilderParam` 曾导致真机 JS 崩溃，D4），
   再全量迁移。**不要一次性重写 Index。**
3. 每搬一块职责跑一次全门禁；`Index.ets` 的验收标准是"不再直接负责页面级 Pane 选择"。

新增：`view/shell/AppShell.ets`、`SidebarShell.ets`、`MainShell.ets`、`RightbarShell.ets`；
`appstate/model/PanelRegistry.ets`、`appstate/model/NavigationState.ets`。
**验收**：`Index.ets` 只做装配与状态订阅；三栏骨架由 shell 组件承担；纯逻辑（面板注册表、导航状态）有 fixture。
**这一阶段的实质是"把 Index 的职责拆出来"，不是加功能。**

### P1 Sidebar
`Brand` / `NewSession` / `WorkspaceTree`（`WorkspaceRow` + `SessionRow`）/ `GlobalPanelList` / `SettingsEntry`（固定底部）。
**验收**：`WorkspacePane` 与 `SessionListPane` 合并为 `WorkspaceBrowser`；一级导航不再是"三个页签"。

**进度（2026-09-15，P1-1 已落地）**

| 子项 | 状态 |
|---|---|
| `view/WorkspaceBrowser.ets`（工作区→会话树，搬迁 285 行；门面成员 30 → 收敛后 27 个全部有用） | ✅ **已抽出**（`TabContentView` 595 → **341 行**；文件 `view/WorkspaceBrowser.ets` 434 行）。**本轮的关键事实：一行都不用改名**——这段代码本来就只经 `this.f.<成员>` 访问宿主，新门面就是那些成员的**子集**（名字与形状逐条从 `TabContentFacade` 抄），包装行也从 `buildTabFacade()` 的同类行筛出 ⇒ 与前三束（批量改名 + 造 setter）不同。**门面做到位之后，搬迁成本一路下降** |
| 死代码清理 | ✅ `view/SessionListPane.ets`（221 行）**删除**：E108 把「会话」页签并进工作区视图后，会话列表改由 `workspaceGroup` 渲染，它只剩 `Index` 里一条死导入。⇒ 顺带把设计令牌棘轮**调紧**（53 → 40 处；`Index` 从 14 → 2 处裸值，AppShell 搬迁的副产物） |
| 窄版行（P1-2） | ✅ **已落地**：`narrowGroup` = 第 1 行「图标 + 名字（拿满宽度）+ 会话数」、第 2 行三个动作（各 44vp 触控高度）；会话行与宽版**共用** `sessionRow`；删掉副标题里的路径（240vp 下会被截成无意义片段，路径在"浏览文件"里完整可见）。**改行不改树**——树本身两种宽度完全一样 |
| 动作**没有**收进 `⋯` 菜单（有意） | 官方侧栏是"悬停才显出图标按钮"，但那需要一个**能验证**的悬停/菜单态；本仓当前做不了真机验收（D3 签名阻塞）。而「新建会话 / 浏览文件 / 删除登记」在窄版里只有这一个入口——菜单一旦在真机上打不开就是**功能不可达**。先用两行摆在明处，等能真机测再谈（不预留空壳）。第一版曾按 `bindMenu` 写好并编译通过，**又删掉了**，理由如上 |
| 挂进侧栏（P1-3） | ✅ **已落地**：`SidebarShell` 的 PANEL 呈现里，树摆在**品牌行下面、面板入口上面**（官方顺序 Brand → 树 → Panel 列表 → Settings）；门面由 `Index.buildBrowserFacade()` 造、经 `AppShell.browser` 传给三条 SidebarShell（只有 PANEL 那处会渲染它） |
| 主区不再重复一份（P1-3） | ✅ 三栏（`shellTracksOf(mode).sidebar === PANEL`）时，主区的「工作区」页签显示一句**说明**（"会话列表在左侧"），而不是第二份树——判据取自 `ShellTracks`，与 `AppShell` 选 `navPanel`/`navRail` 用的是同一处事实，两边不可能不一致。单栏 / 双栏仍由主区承载（底部标签栏与图标条放不下树） |
| 顺带的职责收敛 | `archiveSession` / `toggleDeleteConfirm` 提到宿主：宽版与窄版两处共用同一份副作用与提示文案；`WorkspaceBrowserFacade` 因此**裁到 27 个成员，全部有用**（原先机器生成的 32 个里有 5 个随逻辑上移成为死成员） |
| 一级导航（P1-4） | ✅ **已落地**：入口的**存在与顺序**归注册表（`sidebarEntries` / `sidebarPinnedEntries`，`SIDEBAR_PINNED_ORDER` 把"沉底"写成清单属性）；**长什么样**归 `sidebarPanelSymbol` / `sidebarPanelLabelRes`（按面板 id 的编译期映射）；**哪一项高亮**归宿主（`selectedPanelId` ← `sidebarPanelOfMainPanel(选中的主区面板)`）。`SidebarShell` 里**再无 `NavTab`**——一级导航不再是"三个页签"。顺带：`NewSession` 成为品牌行下方的一级入口（与 Ctrl+N 同一条路）|
| 核心席位（P1-4 附带） | ✅ 把 **E110 的产品语义写进模型**：`sidebar.core` 席位仍登记，但 `available: () => false`（核心内容在设置页的第一个分区里）。此前这条语义只靠"视图恰好没遍历它"成立；顺手补上 `tab_core` 资源——`navTabLabelRes` 原先**没有**这一项、会回落成"设置"（不可达路径上的潜在缺陷，映射现已完整）|
| 单栏手机抽屉（P1-5） | ✅ **已落地**：`mobileDrawer` 这条模型状态此前**没有任何消费点**——模型早就写了"进会话要收起抽屉"（`enterSession`），但视图没人管它。现在：页头根页给导航入口 → `Stack` 把抽屉叠在整页之上（透明点击层承担"点外部收起"，与双栏侧边面板同款）→ 返回键第一优先级收抽屉（`BackAction.CLOSE_DRAWER`）→ 从抽屉里选任何入口/会话都收起（`navigateToMain` / `enterSession`）。**底部标签栏暂时保留**（见 `docs/50` E306 的取舍）|
| 下一步（P1-6） | ① 会话搜索、"分组"显式交互 ② `NewSession` 在 RAIL（收窄条）上的呈现（当前只在完整面板里）③ 真机确认后：手机是否撤掉底部标签栏（抽屉单独承担导航）|
| 待真机确认 | **D11**：侧栏内窄版树的观感/滚动/触控目标；三栏下主区那句说明是否足够清楚；单栏/双栏主区仍是宽版行（本轮**没有**改动它们的观感） |

### P2 Main 会话框架
`ConversationShell`（`ConversationHeader` / `Content` / `ProcessGroup` / `Answer` / `Composer`）。
在这一阶段处理：**Markdown**、**Prompt 隐藏的收尾**、Message Action、Tool Card。
`ConversationHeader` 的官方字段：Session title / Agent preset / Goal / Jobs / Schedule / Open in App / Workspace context / Rightbar access。
Composer 的官方字段：Model / Reasoning effort / Permission / Plan / @ Reference / Skill / Attachment / Command / Send。

### P3 Rightbar
`PanelId` / `PanelDescriptor` / `PanelOwner` + `selectedPanel`；
面板：Files / Preview / Trajectory / Tool Details / Subagent / Deliverables。
**验收**：右栏内容由注册表驱动（不是 `DetailPane` 里的一串 `if`）；宽度/让步链沿用既有 `LayoutController`。

**进度（2026-09-15，P3-1 已落地）**

| 子项 | 状态 |
|---|---|
| `selectedRightPanel` 真正被消费 | ✅ **P3-1**：`RightbarShell` 新增 `panelId` / `panelLabel`，**按面板 id 分派**、标题取 descriptor 的 `label`；两条呈现（真右栏 / Sheet）都走同一套。此前它无条件渲染 `DetailPane`，于是 `selectedRightPanel` 在模型里躺了好几轮**没有消费者**（同 `mobileDrawer` / `enterSession` / `jobs` 的"通道有、没接"） |
| 缺口的**真实位置**：内容视图，不是面板体系 | ✅ 如实登记：官方六个候选（文件/轨迹/工具/子代理/交付物/预览）的**席位在，内容视图没做** ⇒ 一律 `available: () => false`（E110 口径：不能填的入口不进选择集，避免"点进去是空面板"）。本仓唯一有内容的右栏面板是**新增的**「详情」（`right.detail` = 已投影的 sections），并在模型注释里写明它对应官方哪一类（`conversation.detail`），**不冒充"文件"** |
| 初值与回落一起收口 | ✅ `initialNavigationState().selectedRightPanel` 与 `defaultRightPanel()` 的兜底都指到「详情」——否则宿主不调 `defaultRightPanel` 时右栏会落到一个不可用的 id 上（**面板分派之后**这等于空栏） |
| 「预览」面板 + 面板切换器（P3-2） | ✅ **已落地**：预览呈现从 `WorkspacePane` 的第三列抽成 **`view/FilePreviewPane.ets`**（含空态 / 头部「投喂」/ 代码等宽正文 / 过大与二进制两档空态）——右栏的「预览」面板与工作区页签**共用同一份**（抄一份必然走样）。注册表里 `right.preview` 从此 `available: true`。右栏新增**切换器**（`NativeChip` 行，**只在可用面板 ≥2 时出现**：只有一个面板时它是噪声）|
| 「文件」面板（P3-3） | ✅ **已落地**：文件树（展开 / 选中 / 交付物标记）从 `WorkspacePane` 抽成 **`view/FileTreePane.ets`**（133 行，带 `FileTreeFacade` 门面），右栏「文件」面板与工作区页签**共用同一份**；`right.files` 从此 `available: true`。空态文案仍由宿主按三种事实分档给（"没选工作区 / 目录下没会话 / 列目录失败"）。`WorkspacePane` **464 → 274 行**（预览 + 文件树两轮搬出）|
| 「交付物」面板（P3-4） | ✅ **已落地**：交付物卡（图标 / 文件名 / 大小 / 动作行）从 `ConversationPane` 抽成 **`view/DeliverableCard.ets`**（86 行），右栏「交付物」面板与会话过程流里那张卡**共用同一份**；`right.deliverables` 从此可用。筛选是**纯模型**（新增 `itemsOfKind` / `deliverablesOf`：保序 + **同 id 只留最后一条**——过程流里同一条会被流式 merge 多次，「有几件事」不能等于「更新了几次」；4 条断言）|
| 「工具」+「子代理」面板（P3-5） | ✅ **已落地**：工具卡抽成 **`view/ToolCard.ets`**（163 行，含 `diffOf` / `diffTextLines` / `diffKindLines` / `toolBadge` / `toolIcon` ——**判定与呈现同处一组件**，宿主只给"数据 + 展开态 + 回调"）、子代理卡抽成 **`view/SubagentCard.ets`**（40 行）。两个面板与过程流**共用同一份卡**；`right.tool` / `right.subagent` 从此可用。工具卡展开态是**入参**（主区"展开全部/收起全部"要能一次控制所有卡），右栏面板持自己那一条列表的展开集合 |
| 「轨迹」面板（P3-6） | ✅ **已落地**：时间总览（总计 + 每格比例条 + 拖动聚焦 + 聚焦详情行 + 统计四项）从 `ConversationPane` 抽成 **`view/TimelineOverview.ets`**（194 行），主区「轨迹视图」与右栏「轨迹」面板**共用同一份**。**两处的差别写进了模型注释**：主区是"全量台账 + 总览"，右栏**只放总览**——官方右栏的 trajectory 是"当前回合的过程"，而本仓 `TrajectoryItem` 没有回合字段、没有"回合作用域的过程列表"这个概念 ⇒ **宁可少放一份列表，也不把主区台账在 320vp 里照抄一遍**。右栏聚焦**只高亮不跳转**（主区此刻可能不在轨迹视图，跳过去会把用户从正在读的内容上拽走）|
| **P3 收口** | ✅ 官方右栏**六个候选全部接上**（文件 / 预览 / 交付物 / 子代理 / 工具 / 轨迹）+ 本仓特有的「详情」= 七个可用面板；`selectedRightPanel` 有消费者、切换器按可用面板数出现、每个面板的呈现都与"另一个挂载点"**共用同一份组件**。`ConversationPane` 1714 → **1414 行**（本轮又搬出 121 行）。**仍缺**（登记在案）：侧边面板滑入动画、面板自身拖拽调宽、单栏 Sheet 里的切换器 |
| P4 收口判据 | ① 设置页的域划分 ✅（P4-1：八个分区，官方四段在前）② 每个域有自己的组件（P4-2 起）③ 设置项写入的统一事务与失败回执按域收口（未做）④ 四形态观感（真机，见 `docs/device-validation.md` D17）|

### P4 Settings 域

**进度（2026-09-15，P4-1 已落地）**

| 子项 | 状态 |
|---|---|
| 设置分区进注册表 | ✅ **P4-1**：新增 `PanelLocation.SETTINGS` + `settingsSections()`（8 项），`createPanelRegistry` 一并注册 ⇒ 设置页的切换器与侧栏/右栏**共用同一套机制**（`descriptors(location)` / `canSelect` / `firstAvailable`），三处不必各写一套 |
| **官方四段成为真分区** | ✅ 通用 / 模型 / 插件 / **插件清单**（`settings-plugin-inventory`）。清单此前只是插件段里的一个子页签（`config` / `list`）——官方把它作为**独立分区**（只读的 Cordis Loader 清单），两者是"能配置什么"与"装了什么"两件事 ⇒ 拆开 |
| 本仓特有四项标明归属 | ✅ 核心（E110）/ 预设（E129）/ 技能（E135）/ 设备（本机事实）排在官方四段**之后**，`owner: 'dshm'` ⇒ 谁是官方对齐项、谁是端侧补充一眼可分（**不给它们编一个官方分区名**）|
| 分区状态回归导航 | ✅ 视图里的 `@State tab` 已删除：唯一真值是 `NavigationState.settingsSection`，切换走 `openSettings(nav, section, registry)`（经注册表校验）——深链/返回/从别处进设置都看这一处 |
| 顺带清理 | ✅ `pluginsTab` 的子页签（`subChip` + `@State pluginView`）随清单独立而删除；`modelSelectionLabel` 死导入清除 |
| 按域拆组件（P4-2） | ✅ **已开工**：拆出 **`view/SettingsPlugins.ets`**（98 行，插件配置域）与 **`view/SettingsInventory.ets`**（93 行，只读清单域）——正好对应 P4-1 刚分开的两个分区。清单的关键词过滤是组件自己的 `@State`（只影响本页显示，不该让宿主重绘整页）。**顺带修掉**：插件段与组件各画了一行摘要（同一句话出现两次）——**"这段内容归谁"写清楚之后，重复自己就露出来了** |
| 设置行拆组件（P4-3a） | ✅ **已落地**：`settingRow`（127 行）连同它那三个取值助手（`labelOf`/`hintOf`/`valueLabelOf`）与**四个模块级函数**（`choiceLabel` / `officialSettingLabel` / `officialSettingValue` / `officialSettingHint`——官方中文措辞表）搬成 **`view/SettingRow.ets`**（300 行）。通用段、预设段、以及模型域的提供方卡片都用它 ⇒ **下一步拆模型域时必须先有这一块**。宿主留一个薄包装 `@Builder settingRow(item)` 把 5 个回调转过去，调用点一字未改。`SettingsPane` 1694 → **1458 行** |
| 模型域拆组件（P4-3b） | ✅ **已落地**：最大的一块（`modelTab` 206 + `providerCards` 172 + 项联助手 + 4 个模块级函数/接口 ≈ 550 行）搬成 **`view/SettingsModels.ets`**（645 行）。依赖实测只有 4 个数据 prop（`allGroups`/`models`/`selection`/`credentials`）+ 7 个回调 + 2 个本地展示态；行渲染走 `SettingRow`。**一处例外如实记录**：`providerCandidates()` 直接读中枢 `snapshot().providerCatalog`（只读查询、宿主无现成投影）——将来投影到宿主后应改成 prop。`SettingsPane` 1458 → **932 行**（P4-1…P4-3b 合计 1890 → 932）|
| 通用段 / 设备段拆组件（P4-4） | ✅ **已落地**：`view/SettingsGeneral.ets`（183 行：官方 General 段的内容 + 只读权限事实 + 本地调试入口）与 `view/SettingsDevice.ets`（129 行：已记住的 Host + 关于本机）。两者都用 `SettingRow` 渲染设置项。**本轮手术一次通过**——因为严格照 E339–E341 的规范走：一个区间一个动作、装配清单先分行、先修符号级报错。`SettingsPane` 932 → **760 行**（P4-1…P4-4 合计 1890 → 760）|
| **P0 回归修复**：真机冷启即崩（`@Builder` 自递归） | ✅ **已修**（2026-09-15，E343）：真机（Mate 70 Pro+）冷启后点一下界面就被系统杀掉进程——`MainShell.mainContent` 的兜底分支写成 `else { this.mainContent(this.compact) }`（**自递归**，`RangeError: Stack overflow!`）。**为什么会走到那条兜底**：主区还剩工作区/核心/设置三类面板，它们归**主区的第二束** `TabContentView` 渲染，搬迁时这一束忘了接上；而 `MainShellFacade.tabFacade` 一直由宿主造着却**零消费者**（第 7 例「通道有、没消费者」）——正是它掩盖了这个空洞。修复 = 兜底渲染 `TabContentView({ f: this.f.tabFacade, compact: this.compact })`。**并补门禁** `tools/check-builder-recursion.mjs`（剥注释后扫 `this.<自己>(`；5 条注入式自检 + 对**修前提交**归真命中一行）+ `check-feature-wiring` 新增「主区兜底」项（16 → 17 个功能） |
| 技能段 / 预设段拆组件（P4-5） | ✅ **已落地**：`view/SettingsSkills.ets`（95 行：清单 + 读取结论，只吃两个 prop、无写入动作）与 `view/SettingsPresets.ets`（271 行：官方这一页的两半——预设名单卡片 + `agent-*` 分区编辑器，含三个组件内临时态与「查看」的中枢直读）。**同时清掉 16 个零消费者成员**（E346/E346b）：搬走那段唯一的读者（6 个 prop/回调）、已住进域组件的三个临时态、只服务于预设段的 `agentGroups()`，以及 `settingsStates` 这条**从头到尾没人读的死链**（4 处 + 类型导入）与 `onPickEffort`。`SettingsPane` 758 → **497 行**（P4-1…P4-5 合计 **1890 → 497**）|
| 核心段拆组件 + 回执按域归属（P4-6） | ✅ **已落地**：`view/SettingsCore.ets`（78 行）收走最后一段内联内容（包住 `CorePane` + 两块提示；它是 E118「`@BuilderParam` 注入在真机崩溃」的修复形态，不是多余转发层）。**同时修掉一个真缺陷（E347）**：设置写入回执是一个全局字符串、只有一个读取点（设置页顶部），于是① 切分区会把上一段的回执带过来（看起来像本页写的结果）② 更糟的是 **7 个工作区/会话函数、19 处回执写在设置通道里**⇒ 用户在会话里点「归档」等操作**看不到任何回执**。现在：设置回执带归属域（`settingsWriteDomain`，只在域 == 当前分区时显示），工作区/会话回执改走 `attachNotice`（会话输入区那条通道）。域判定搬进零依赖的 `model/SettingsDomains.ets`，**+19 条 fixture**（五类命名空间 + 三类不猜的边界）。`SettingsPane` 497 → **500 行**（P4-1…P4-6 合计 1890 → 500）|
| 消息行整块抽成组件（P2-4） | ✅ **已落地**：`view/MessageRow.ets`（221 行）收走"一条消息"的**五份行级状态**（悬停 / 菜单开关与归属 / 反馈面板归属与回执）＋两个 `@Builder`（行内操作条、上下文菜单）＋三条输入策略判定包装。**边界如实划定**：跨行的展开态、要读中枢反馈记录的动作清单、以及反馈的持久化都**留在父组件**。顺带删掉一处重复实现（视图私有 `clockOf` 与模型 `formatClock` 逐字等价）。`ConversationPane` 1414 → **1234 行** |
| 会话头四块 chrome 抽组件（P2-5） | ✅ **已落地**：`view/ConversationHeader.ets`（284 行）收走「视图切换 + 轨迹工具栏」「后台任务条」「时间总览」「会话内搜索条」四块**不在列表里的**东西。**分工口径**：跨行状态（搜索命中判定、任务条定时器）留父组件、块内状态留子组件；`stats` 改成必需 prop（不造"全 0 默认统计"——那会让"没接到数据"看起来像"这场会话什么也没花"）。`ConversationPane` 1234 → **1093 行** |
| 死代码门禁（P2-6 第一刀） | ✅ **已落地**：第 9 道门禁 `tools/check-dead-code.mjs`（零使用 import / `@Builder` / 组件成员）。当轮即查出并删掉 3 处真死代码（`MessageFeedback.itemId` / `MessageRow.menuHint` / `SettingsPane.settingRow`），并连带清掉级联的 `ConversationPane.inputModality()`。含 9 条注入式自检 + 对修前版本归真命中 5 处 |
| 回合渲染抽组件（P2-6 第二刀） | ✅ **已落地**：`view/TurnView.ets`（492 行）+ `view/ReasoningRow.ets`（83 行，轨迹视图与过程分组**共用**）。展开集合留子组件、按钮在父组件 ⇒ **控制器对象**；轨迹视图的条目级分派用 `flatItem`（共享卡片、不共享分派）。`ConversationPane` 1087 → **984 行**（1414 → 984）。死代码门禁当轮抓出 2 处残留（`reasoningItem` 已被取代、`hitIds`/`fbRating` 无读者）|
| 会话头上下文行（P2-7） | ✅ **已落地**：补官方 `conversation.header` 的 **Workspace context / Model / 最近活动** 三项（数据都已在手）；规则做成零依赖纯函数 `appstate/model/SessionContext.ets`（+14 条 fixture）。**没做的三项各有原因**：Agent preset 缺"当前会话的预设名"，Schedule / Open in App 缺协议面 —— 不猜、不摆假入口。`ConversationHeader` 284 → 318 行 |
| 浮层结果出口按归属（P2-8） | ✅ **已落地**：查出三个浮层（凭据 / 文本设置 / 结构设置）共用 `credentialNote` 与 `credentialBusy` ⇒ **串浮层** + **跨浮层置忙**（与 E347 同一缺陷类）。修法：回执带 `sheetNoteOwner` 归属、每个浮层自己的 busy；判定在零依赖 `appstate/model/Sheets.ets`（+11 条 fixture → 558 条）。**拆那 960 行浮层的计划推到下一轮**——修完缺陷后它们是零风险搬家 |
| `Index.ets` 第一刀（P2-9） | ✅ **已落地**：`view/FolderPicker.ets`（297 行）带走沙箱目录选择器的全部状态与动作（4 状态 + 6 方法 + 1 段 UI）；两个入口经**控制器对象**唤起，控制器带 `close()`（原生 Sheet 关闭不经过组件）。`Index.ets` 4480 → **4297 行** |
| 设置编辑浮层（P2-10） | ✅ **已落地**：`view/SettingTextSheet.ets`（131 行）与 `view/SettingStructSheet.ets`（142 行）成组件；输入提示（类型/范围/步长/正则/必填/当前值）进零依赖 `appstate/model/SettingEditors.ets`（+12 条 fixture → 570 条）。组件接受**可空 item**（不造 20 字段占位项）。`Index.ets` 4297 → **4133 行** |
| 凭据 / 选项浮层（P2-11） | ✅ **已落地**：`view/CredentialSheet.ets`（127 行，保留 E95 显式 44vp 高、"明文只在一个请求里"、"成功才关面板"三条语义）与 `view/ChoiceSheet.ets`（99 行，单选即提交、原生 Sheet 即表面）。`sheetContent` 的六个分支现在各是一句组件调用。`Index.ets` 4133 → **4019 行**（合计 4480 → 4019）|
| 右侧内容门面（P2-12 第一步） | ✅ **定义已落地**：`export interface RightbarFacade`（12 个两处共有成员）写在 `view/shell/RightbarShell.ets`。**动机**：该 shell 两个挂载点（真右栏 / 详情浮层）各自拼 16 个 props，迟早不同步。**接线未做**（要动 `AppShellFacade` 十来个成员与两处调用点）——留到下一轮，改动面一眼可数 |
| 右侧内容门面接线（P2-12 第二步） | ✅ **已落地**：`RightbarShell` 改吃 `f: RightbarFacade`（12 props → 1，39 处用法改 `this.f.X`）；`AppShellFacade` 的 11 个 `right*` 成员全删；两处挂载点都调 `Index.buildRightbarFacade()`（浮层此前内联重算 ⇒ 新加面板很容易只给一处）。**行数 4019 → 4026（+7）**：收益是"两处只有一个真值"，不是变小 |
| 单栏 Sheet 的切换器（P2-13） | ✅ **已落地**：切换器抽成共用 `@Builder panelSwitcher()`，`framedBody`（真右栏 / 侧边面板）与 `sheetBody`（单栏详情 Sheet）都调它 —— 此前单栏用户**根本切不到别的右栏面板**（P3 登记的第三个缺口，属功能不可达级别）。顺带把 Sheet 那行固定的「工具 / 子代理 / 交付物 / 目标 / 任务」提示换掉（它对文件/预览/详情是错措辞）|
| 删掉平行状态机（P2-14） | ✅ **已落地**：`activeOverlay` / `Overlay` / `openOverlay` / `closeOverlay` 真实界面**从不读**（优先级由 `Index.overlayState()` 派生），而 fixture 有 3 条断言只测它自己（自证循环）⇒ 删除，fixture 570 → 567。**同清单下一个候选**：`sidebarExpanded`（字段 + setter + 无人读；"侧栏收成 rail"要么接成真功能、要么同样删——**需先定产品语义**）|
| 侧栏可收起（P2-15） | ✅ **已落地**：`NavigationState.sidebarExpanded` 此前没有任何控制点（侧栏呈现完全由形态决定）⇒ 官方「收起侧栏」在本仓做不到。新增纯函数 `sidebarPresentationOf(mode, expanded)`（单栏一律浮层；双栏默认 rail 可展开；三栏默认 panel 可收起），品牌行给「收起」、rail 顶部给「展开」（**双向门**）；+7 条 fixture（574），并钉进功能接线门禁（第 18 项）|
| 新建会话入口补全（P2-16） | ✅ **已落地**：`＋ 新建会话` 此前只在 `panelBody`（PANEL 呈现）里⇒ 收起侧栏（rail）或单栏底部标签下**都没有入口**。rail 里排在「展开侧栏」下面，底部标签排第一位；`onNewSession()` 调用点 1 → 3 处，并修正组件头部"只在品牌行下方"的过期口径 |
| 侧栏收起状态持久化（P2-17） | ✅ **已落地**：`LocalPrefs` 新增 `load/saveSidebarExpanded`（存 `'true'`/`'false'` 字符串，**缺失即 undefined** —— 否则"从没设置过"会被读成"收起"）；默认值规则在零依赖 `sidebarExpandedOf`（`undefined ⇒ true`，+3 条 fixture → 577）；启动读回、切换落盘（失败**不弹提示**，与宽度记忆有意不同）|
| 下一步（P2-18…） | ① `Index.ets`（4026 行）里宿主处理器按域收口（会话 / 工作区 / 诊断各一处）② 右栏**滑入动画**与**拖拽调宽** —— 观感项且**必须真机验收** ③ 会话头剩余三项需要协议面 ④ 把「侧栏收起 / 新建会话」这两条也写进 `docs/device-validation.md` 的待验清单（D19）⑤ **真机复验 E343 / D18** ——无真机不得宣称设备验收完成 |

`SettingsShell`（General / Models / Plugins / Plugin Inventory / …）。**不再往 `SettingsPane.ets` 里堆内容。**

### P5 视觉精修
只有在此阶段才做间距/颜色/动效的对齐。

## 4. 已完成的相邻工作（不重复做）

| 项 | 状态 |
|---|---|
| Host / 协议 / 会话状态 | 🟢（`docs/50` 的 E 系列证据链） |
| 多形态几何决策 | 🟢（`LayoutController` + 69 条 fixture；拖拽与宽度记忆已落） |
| 输入模态事实 | 🟢（设备枚举 + 事件证据 + 形态猜测三级链） |
| **Prompt 泄漏（P0-1）** | 🟢 **本轮关闭**：`internal` 结构字段 + `conversationAudienceOf` 单一判据 + 搜索按视图作用域。此前两条路径都通（直接显示 / 被搜到并计数） |
| Conversation 数据模型（回合） | 🟢（`groupTurns` / `Follow` / `chatVisibleItems`） |
| 消息反馈面板拆出（P2-3：Message Action 第一块） | 🟢 **已落地**：`view/MessageFeedback.ets`（121 行）。原先它长在 `ConversationPane` 里（`@Builder feedbackPanel` + **5 个** `@State`：`fbFor/fbRating/fbCategory/fbNote/fbNote2`），表单态与消息列表态共享一个组件 ⇒ **每敲一个字都会把整个会话列表重绘**。拆出后表单态（类别/说明）归组件，宿主只留"哪条开着"（`fbFor`）+ 回执（`fbNote2`）+ 提交策略（成功才关面板）。初值由宿主在**打开那一刻**给，之后编辑不回调灌（避免打字打到一半被覆盖）|
| 后台任务条（官方 `conversation.header.jobs`） | 🟢 **P2-2 已落地**：`Jobs` 模型的 40 条断言早已就位、中枢也一直维护 `jobs`，但**视图零消费者**（同 `mobileDrawer` / `enterSession` 的「通道有、没接」）。现已接成：中枢 → `Index` → `MainShell` → 会话头任务条（`Flex(wrap)` 任务块 + live 每秒走字 + 无障碍整段），并用接线门禁钉住三段 |
| Markdown | 🟢 **P2-1 已落地**（顺序说明：P0/P1 把框架与侧栏做完之后，Markdown 才轮到——"框架错则 Markdown 白做"这条理由已经消解）。模型 `appstate/model/Markdown`（切块 + 行内标记，**流式未闭合围栏不算错误**、未配对标记原样保留），视图 `entry/view/MarkdownRenderer.ets`；三处正文已接入，无障碍文案改为**去标记**文本 |
| Sidebar 信息架构 / AppFrame / Panel Registry / Settings 域 | 🔴 **本阶段要做的** |

## 5. 纪律（沿用既有约定）

- 每步一个可编译、可测、可回滚的小改动；**先做纯逻辑模型与 fixture，再接视图**。
- 严禁为了"看起来像官方"而写死内容或造无协议支持的后端。
- **无真机/模拟器时：不宣称视觉验收完成**；结构、状态与渲染规则必须可自动验证。
- 拆 `Index.ets` 的过程中，**同一时刻只搬一块职责**，每搬一块跑一次全门禁。
