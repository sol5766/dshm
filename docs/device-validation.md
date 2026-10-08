# 端侧真机验收清单（P4）

> **本文是什么**：**每一次上机的真机读数**，按批次记录（批次一~十四）。每条都尽量给
> "原样粘贴"的证据串。
>
> **按「主题」（而不是按批次）查踩过的坑 → [`70-鸿蒙移植踩坑与修复总览.md`](70-鸿蒙移植踩坑与修复总览.md)（D8）**
> ——同一个坑可能横跨好几个批次，D8 把它们按技术主题重新归类（平台与进程模型 / hmfs /
> 打包与资源 / dsh 上游集成 / 工具链 / 构建期与 Windows / ArkTS 与 UI / **工程方法**）。
>
> **架构决策与 E 编号索引 → [`50-端侧核心运行架构.md`](50-端侧核心运行架构.md)**。

本文是**真机验收的唯一台账**。它回答一个问题：**哪些事只能在真机上看、怎么做、看什么算通过。**

> **本项目的基本原则（不可协商）**：没有真机时**允许把功能开发完成**，但**不允许宣称设备验收完成**。
> 因此 `docs/parity-matrix.md` 的状态有**两条轴**——`实现侧`（本机可证）与 `设备验证`（真机才可证，
> 未验时一律 `PENDING`）。任何"设备上已好"的表述都必须以本文的实测读数为依据，而不是推断。

## 0. 本文当前的完整度（如实标注）

⚠️ **这是 P4 骨架，不是完成态。** 今天（2026-09-14）这里只有**已知且具体**的待验收项；
`parity-matrix.md` 里 39 个能力面的 `设备验证` 列**尚未**逐面展开成步骤。
补全方式：从矩阵的 `设备验证` 列逐行派生，每面给出「操作步骤 / 期望现象 / 实测读数 / 结论」四栏。
**在此之前，不要因为某项不在此文里就认为它已被验证。**

### 0.1 矩阵 §3.3 点名要进本文的六类（**均待展开**）

`parity-matrix.md` §3.3 写着这六类"统一进 `docs/device-validation.md`"。它们目前**只有归类、
没有步骤**——标为待展开，是因为逐面步骤必须从矩阵的 `设备验证` 列派生，不是可以凭空写的：

| 类别 | 状态 |
|---|---|
| 视觉像素（设计令牌在真机上的实际观感、暗色/亮色） | 待展开 |
| 手势（长按菜单、滑动、`bindSheet` 拖拽） | 待展开 |
| 键盘（快捷键、`hasKeyboard` 真值、焦点顺序） | 待展开 |
| 触控笔 | 待展开 |
| 系统权限（网络三项的授权弹窗与拒绝路径） | 待展开 |
| 文件选择器（工作区/附件的真实 picker 回传） | 待展开 |

## 1. 已知待验收项（**今天就已经具体到可执行**的）

### D1. `undici` 解析钩子在端侧**独立线程**里能否注册

- 背景：`web_fetch` 的修复依赖 `main.js` 的 `installUndiciNameHook()`，它用 `module.register()`
  注册解析钩子，而该钩子运行在 Node 的**独立线程**中。
- 本机已证：PC（aarch64，与设备同架构）上可以。
- 真机要看的：Host 日志里出现 `undici 解析钩子已注册（web_fetch 走本仓垫片，绕开 WASM）`；
  若出现的是 `undici 解析钩子注册失败（web_fetch 将不可用）：…`，说明端侧运行时不支持该机制，
  需要改走 `--experimental-loader` 或换实现。
- 失败时的行为：**只降级、不阻断启动**（web_fetch 坏掉不该拖垮整个 Host），所以**必须靠日志主动确认**，
  不能因为"Host 起来了"就认为它生效了。

### D2. 真机抓一次网页（`web_fetch` 端到端）

- 为什么不能只靠 D1：D1 只证明钩子注册了，不证明抓取成功。
- 步骤：真机上让模型调用一次 `web_fetch` 抓一个**公网**页面（上游只允许公开地址，loopback 会被策略拒绝，这是设计）。
- 期望：返回网页正文（`statusCode 200` + 文本内容），而不是 `WEB_PROVIDER_ERROR`。
- 本机对照基线：`node tools/check-web-fetch-jitless.mjs` 在 B 臂 8/8 通过（真实上游 provider + 真实垫片）。
  该门禁**不能**替代本项——它证的是 PC 上的宿主，不是设备上的运行时。
- 关联：矩阵 §3.2、`docs/50-端侧核心运行架构.md` 的 E263/E264。

### D3. 安装与签名（当前**所有**设备验证的前置阻塞）

- 现状：未签名 HAP（约 138 MB）可完整构建（`CompileArkTS` + `PackageHap` 通过），
  `SignHap` 因缺签名材料而失败。
- 缺什么：`.p12` / `.cer` / `.p7b`（在用户的 Windows 机器上），以及对应的 profile。
- 影响：**没有这一步，上面所有真机项都无法开工。** 这是当前唯一的全局阻塞。

### D4. API 24 与 `Circle().fill(...)` 的兼容性（已知悬案）

> **✅ 已结（2026-10-06）**：6 处已改成视觉等价的 `Row + backgroundColor`（`docs/108` §1.2），
> `compatibleSdkVersion` 拍板固定 **`6.1.1(24)`**（`docs/110` §5），产物 `minAPIVersion=60101024`；
> 真机上这 6 处状态点/色点的渲染仍属"装机后目视复核"项（`docs/110` §7）。

- 现象：6 处 `Circle().fill(...)` 被编译器标注 `since SDK 26.0.0`，而我们的
  `compatibleSdkVersion` 固定在 `6.1.1(24)`（用户决定：**暂保持 24**，沉浸光感因此不可用，
  升级路径记在 `HarmonyTheme` 的 `HarmonyMaterial`）。
- 要看的：真机上这 6 处渲染是否正常（是真有风险，还是仅告警）。
- 结论未定前**不要**为了消警而升级 SDK——API 24 是有意决策。

### D5. 输入模态事实链（P3）

四件事都**只能**在真机上确认（本机既无设备也无意指）：

1. **`inputDevice.getDeviceList()` 在设备上可用吗**：SDK 声明里没有 `@permission`（已核 d.ts），
   但真机上是否返回完整列表、是否需要额外系统能力声明，必须实测。
   判据：日志里出现有效枚举结果（而非 `输入设备枚举不可用：<code>`）。
2. **根容器的 `.onHover` 能收到悬停吗**：它挂在页面根 `Stack` 上，而悬停事件是否从子组件冒泡到祖先
   是**平台行为**，不能靠推断。判据：接上鼠标后 `hover` 反馈与右键菜单出现（手机形态下也应有）。
3. **根容器的 `.onKeyEvent` 能收到物理按键吗**：按键走焦点链，根节点能否收到取决于焦点在谁身上。
   判据：外接键盘按任意键后，快捷键提示类交互启用（日志里可见"观察到物理按键"）。
4. **热插拔与降级**：运行中插上鼠标 → hover/右键应**立刻**生效；拔掉后重新枚举应回到"没有指针"
   （枚举是可降级的，与"事件证据只增不减"性质不同——两者都在 `model/InputFacts` 里）。
5. 诊断页应能显示 `modalityNote`（合成理由）；报"设备枚举不可用"时按 1 排查。

### D6. 详情栏拖拽把手与宽度记忆（P3）

三件事只能在真机上判断：

1. **细把手点得中吗**：视觉宽度只有 12vp（它在两栏之间，视觉上应只是一条线），命中区域用
   `responseRegion` 按输入模态放宽到 44vp（触控）/ 24vp（指针）。真机上要确认触控能稳定拖到，
   且**不会误触发**（贴着主内容边缘操作时不应把栏宽拖走）。
2. **拖拽与页面滚动/其他手势冲突**：`PanGesture({direction: Horizontal})` 挂在把手这一列上，
   但它与消息列表的纵向滚动、消息长按菜单在同一片区域。判据：横拖只改栏宽，纵滑仍能滚列表，
   长按仍出菜单。
3. **宽度记忆跨重启/跨形态**：拖宽 → 关应用 → 重开，栏宽应保持；换到窄窗口时栏应被让步链
   自动收窄（而不是撑破布局）。记忆**全局一份**（不按形态分记），这一点若在真机上手感不对，
   再改成按形态分记。落盘失败时应出现一句轻提示（"详情栏宽度这次没能记住"）。

### D7. 平板侧边浅层面板的观感与手势（P3 §12）

双栏（平板竖屏 / 手机横屏 / 2in1 拖窄）下详情改为**压在内容右缘的侧边面板**，判断标准只能靠真机：

1. **层级是否看得清**：本仓不手写遮罩（遮罩由原生 Sheet 提供），故侧边面板**没有蒙层**，
   靠"面板覆盖在内容右缘 + 点面板外关闭"表达层级。真机上要确认用户能一眼看出这是浮层、
   而不是布局变成了三栏。
2. **点面板外关闭是否顺手**：实现是一层**透明**点击层承担"点外面关闭"。判据：点空白处关闭、
   点面板内**不**关闭；且透明层不该让用户觉得"内容点不动了"（它会挡住列表交互——若手感不对，
   需改成非阻断式并重新考虑层级表达）。
3. **面板宽度**：沿用用户记住的"想要的宽度"并夹在可用空间内（`clampDetailDesired`）。
   判据：800vp 平板竖屏上列表仍露出足够宽度（不该出现面板吃掉大半屏）。
4. **档位切换的连续性**：窗口从双栏拖到三栏时，浮层应自动关闭并由右栏承担（已有逻辑）；
   从三栏拖回双栏时，详情不应突然消失（当前是保留右栏的开启意图、由浮层接管——需实测确认）。

### D8. 轨迹时间总览的观感与手势（P2 §11）

轨迹视图上方新增「总计 + 每格比例条 + 拖动聚焦 + 统计四项」，判断标准只能靠真机：

1. **比例条在手机上看得清吗**：格子多、耗时分布悬殊时（例如一次 8 秒的助手回合 + 十几个
   几十毫秒的工具格），最窄的格可能只有一两个像素。判据：是否还能看出"大概有这么多格"，
   以及是否需要给最窄格一个最小宽度。**这是本项最可能需要返工的地方。**
2. **拖动聚焦与列表滚动冲突**：比例条上的 `PanGesture({direction: Horizontal})` 与下方列表的
   纵向滚动、以及条本身的点击（`onClick` 用组件相对坐标换算）要能共存。判据：横拖只换聚焦格、
   纵滑仍滚列表、轻点能聚焦。
3. **聚焦详情是否够用**：目前给「种类 · 第 n/共 m 格 · 开始于 hh:mm · 耗时」。
   判据：不看列表能否凭这一行知道"这是哪一步"；若不够，需要加强联动（见下）。
4. **双向联动的手感**（本轮补上，故需实测）：
   · 条 → 列表：拖动松手或点选后，列表滚到那一格对应的条目并高亮。判据：跳转位置对不对
     （用 `ScrollAlign.START` 对齐首行）、动画是否突兀。
   · 列表 → 条：滚动列表时条上的聚焦跟着**首行**走。判据：是否让人误以为"条在自己动"；
     若观感不好，可改成只在**用户主动滚动后**更新，或干脆去掉这一路（保留条→列表即可）。
   · **最需要盯的是抖动**：两路互相触发时不应来回跳。当前靠"拖条期间关掉列表那一路" +
     "滚到条目的行首使两侧一致"来避免，属**推断**，必须实机确认。另：条→列表当前用
     **立即跳转**（不是平滑滚动）——因为平滑滚动会在动画途中反复触发滚动回调、让聚焦扫过
     中间每一格。真机上若"跳得太硬"，再补"程序化滚动期间挂起列表→条"后换回平滑。

### D9. `@Provide/@Consume` 在真机上的运行时行为（P0 机制）

**为什么必须实测**：本仓有过先例——`@BuilderParam` **编译通过、真机运行时 JS 崩溃**（D4）。
编译器只能证明语法与类型，证明不了"祖先提供、后代消费"在设备运行时真的连得上。

本轮已在**最窄的一条轨道（侧栏）**上用起来：`Index` `@Provide('panelRegistry')`，
`SidebarShell` `@Consume('panelRegistry')` 并按注册表可用性过滤入口。

判据：
1. 侧栏**正常显示三个入口**（说明 `@Consume` 拿到了注册表，而不是拿到 `undefined`）。
2. 把某个侧栏面板的 `available()` 改成 `false`（临时验证）⇒ 该入口**从侧栏消失**，
   其余入口与主区不受影响。若 `@Consume` 没连上，这里会抛错或静默显示全部。
3. 四形态切换、以及"切会话 → 进设置 → 回会话"之后仍正常（消费链不因重建而断）。

**在这一条通过之前，不要把主区的 100 个 `@State` 迁到 `@Provide/@Consume`**——那是全量迁移的前提。

### D10. 浮层门户提到页面根之后：三形态下浮层是否都可达（P0 收尾）

**为什么必须实测**：这是本轮**改了结构、无法在本地跑起来验证**的一处行为变更。
原先 `bindSheet` 只挂在 `buildSingle` 的根 `Column` 上 ⇒ 双栏/三栏下四类浮层（模型选择 / 凭据 / 目录 /
文本与整值设置）**点了没反应**（触发点都在主区内容里，主区三形态都可见）。修法是把门户提到页面根
（`Index.build()` 的根 `Stack`）。编译器只能证明语法，证明不了"提到根上之后 `isShow` 仍被正确驱动"。

判据（**三形态各测一遍**）：
1. **单栏**：会话页 → 模型选择浮层正常弹出、能选中、下拉关闭后**还能再打开**（`closeSheet()` 复位的意义）。
2. **双栏（600–839vp，如平板竖屏/手机横屏）**：主区设置页点「凭据」类条目 ⇒ **浮层弹出**（修好之前这里毫无反应）；
   再回会话页点模型选择 ⇒ 同样弹出。**注意**：双栏下详情走的是侧边浅层面板，不该出现 Sheet。
3. **三栏（≥840vp）**：`Ctrl+J` 翻右栏（不是浮层）；再从主区点凭据/目录 ⇒ 浮层**盖在上方**、关闭后三栏布局不变。
4. 浮层打开时按 `Esc` ⇒ 关闭浮层而**不**停轮次（`escapePressed()` 的顺序语义，见 D3 §5.1 那一节）。
5. 观感：浮层出现的位置/遮罩是否正常（挂在根节点而不是某个轨道节点上，理论上更"居中于窗口"）。

**未过此条之前**：不得宣称"浮层在三形态下都可达"。

### D11. 侧栏里的工作区树（窄版行）与三栏主区那句说明（P1）

**为什么必须实测**：本轮把「工作区→会话」树挂进了侧栏 PANEL 轨道（240vp），并为这个宽度做了窄版行
（第 1 行名字、第 2 行三个动作）；三栏下主区的「工作区」页签改成一句说明。**这些全是布局改动，
本地无法渲染**（无模拟器/设备，且签名材料缺失 = D3）。

判据：
1. 三栏档位：侧栏自上而下应是 品牌 → **工作区树** → 面板入口（工作区/核心/设置）→ 底部二级入口；
   树的滚动条不遮挡文字，长工作区名与长会话名**以省略号收尾而不是换行**。
2. 窄版行第 2 行的三个动作（`+ 会话` / `文件` / `删除`）在触屏上**都点得到**（高度 44vp）；
   「删除」仍是两步（先变「确认删除」并染告警色，再按才删）；只有注册过的工作区才出现该入口。
3. 会话行（宽窄共用）在 240vp 下：名字 1 行省略、`运行中` 徽标与「归档」不重叠。
4. 三栏下主区点「工作区」页签：显示那句说明而不是第二份列表；在侧栏点某工作区的「浏览文件」，
   主区应切到文件浏览（下钻）——**这条是本轮唯一的功能性新增，必须走通**。
5. 单栏 / 双栏的观感应**与本轮之前一致**（本轮没有改动它们的行样式：主区仍是宽版行）。
6. **New Session**（品牌行下方的 `＋ 新建会话`）在触屏上点得到，且与 `Ctrl+N` 行为一致（都走 `createSession()`）。
7. **入口清单与沉底**：侧栏看不到「核心」入口（E110：核心内容在设置页的第一个分区里），
   而「设置」**贴在侧栏底部**（不随清单浮动）；点「工作区」与「设置」各切到对应主区页面并正确高亮。
   进会话后（会话没有侧栏席位）应当**没有任何入口高亮**——若仍高亮"工作区"，说明 `selectedPanelId` 没接到位。

**未过此条之前**：不得宣称"侧栏信息架构已对齐官方"。

### D12. 单栏（手机）侧栏抽屉（P1-5）

**为什么必须实测**：抽屉是本轮**新增的一整层导航面**，本地无法渲染（无模拟器/设备，签名材料缺失 = D3）。
它同时改了返回键阶梯的**第一优先级**——一旦"收不起抽屉"，手机就会卡在一个盖住全屏的面后面。

判据（手机档位，单栏）：
1. 根页（列表页）页头左侧有导航入口（`☰`），点开 ⇒ 抽屉从左滑出/出现，宽度约 240vp，右侧露出底层页面。
2. **四条收起路径都要通**：点抽屉右侧的空白区域、按返回键、在抽屉里选一个面板入口、在抽屉里点一个会话
   （第 3、4 条分别验 `navigateToMain` 与 `enterSession` 的自动收起）。
3. **返回键不得穿透**：抽屉打开时按返回**只**收抽屉（不得同时退栈/退页）；抽屉关着时返回仍是原阶梯。
4. 抽屉里的内容与平板/桌面侧栏**同一份**（品牌 / ＋新建会话 / 工作区树 / 面板入口 / 设置沉底），
   且窄版行的三个动作（`+ 会话` / `文件` / `删除`）在抽屉宽度下都点得到。
5. **已知的过渡状态**：底部标签栏**还在**（本轮刻意不夺走入口）⇒ 手机上会同时存在两块导航面。
   若观感上互相打架，记录现象即可——是否撤掉标签栏等这一条通过后再定。

**未过此条之前**：不得宣称"手机侧栏已与官方对齐"。

### D13. 会话正文的 Markdown 渲染与链接打开（P2-1）

**为什么必须实测**：解析规则已由 fixture 断言（本机可跑），但**画出来是什么样**只能在设备上看：
`Text > Span` 的行内强调要跟着文字流换行、代码块底色与等宽字体、引用条、列表缩进，都属渲染层。
另外链接打开走的是 `openLink`（系统能力），本地无法验证。

判据（发一条含各类标记的消息，或在会话里让助手回一段 Markdown）：
1. **行内**：`**粗**`、`*斜*`、`` `码` ``、`~~删~~` 各就各位；**长粗体在窄栏里正常折行**（不是断成一列碎块）。
2. **块级**：标题比正文大；无序/有序列表缩进对齐、标记在左；引用左侧有品牌色竖条；分隔线是一条细线。
3. **代码块**：等宽字体、有底色与细边框；语言标注（如 `ts`）显示在左上；长行**横向不溢出**（若溢出，记录为观感问题）。
4. **流式**：助手正在生成时，半截围栏应显示为"代码块 + 尾部光标"，且**闭合那一刻画面不跳**。
5. **链接**：点 `[文字](链接)` 能拉起浏览器/应用（`openLink`）；`javascript:`、`file:` 这类非 http/https 应被拒绝。
6. **无障碍**：朗读该消息时**不应**念出 `**`、反引号与链接目标（读数走 `plainTextOf`）。
7. **复制**：长按可复制原文（Markdown 源文，不是渲染后的纯文本——官方也是复制源文）。

**未过此条之前**：不得宣称"正文渲染已与官方对齐"。

### D14. 会话头后台任务条（P2-2）

**为什么必须实测**：任务条的**判定**全部来自 `Jobs` 模型（40 条断言已在本机跑），但"任务来/去时它出没出现、
耗时是否每秒走字、任务块在窄栏里换行是否正常"只能在设备上看；`JOBS` 控制帧**只在有真实后台任务时才会来**，
本地核心是占位（`system.node` 73 字节）⇒ 本机根本收不到该帧。

判据（需要真的跑出一个后台任务：让助手执行一个长命令，或触发一次子代理）：
1. 任务开始后，会话头（视图切换行下方）**出现**任务条；任务全部结束且列表不可见时应**消失**（`jobListVisible`）。
2. 任务块内容：状态点颜色随状态变（进行中=品牌色 / 请求停止·被杀=警告 / 完成=确认 / 失败=告警），
   名称 + 状态文案 + 耗时三者都显示；耗时在选择器里**每秒跳一次**（不是停住不动）。
3. 多个任务时按模型顺序排列；窄栏下任务块**换行而不是横向溢出**。
4. 会话切走再切回：任务条内容与会话一致（不串会话）。
5. 无障碍：整段朗读应是一句通顺的任务概览（`jobListA11y`），而不是逐个碎块。

**未过此条之前**：不得宣称"会话头任务条已与官方对齐"。

### D15. 消息反馈面板拆出后的行为（P2-3）

**为什么必须实测**：本轮把反馈表单的状态**换了归属**（`ConversationPane` → `MessageFeedback`）——
渲染结果应当一模一样，但"状态归谁"这类改动最容易出的问题是**预填与回执的时机**，本地无法跑界面。

判据：
1. 点某条助手消息的「有帮助」⇒ 面板出现，**类别与说明按该条已存内容预填**（若该条之前评过）。
2. 面板里切换类别（含"再点一次取消选择 ⇒ 未分类"）、在说明框里连续打字：**输入不丢字、光标不跳**
   （这是"每次变化都回灌初值"会表现出的症状——本轮刻意不回灌）。
3. 「提交」成功 ⇒ 面板关闭且操作条上的评价态变高亮；失败 ⇒ **面板不关**且贴着面板显示失败原因。
4. 「取消」⇒ 面板关闭；**再次打开**应显示该条已存内容（预填来自中枢的实时读取，不是上一次编辑的残留）。
5. 会话很长时（几十条以上）在说明框里打字：**列表不应出现整屏重绘/滚动跳动**（本轮拆组件的目的）。

**未过此条之前**：不得宣称"消息操作与官方对齐"。

### D16. 右栏按面板分派（P3-1）

**为什么必须实测**：本轮把右栏从"无条件显示详情"改成**按面板 id 分派**，并把初值与兜底都指到「详情」。
若某条路径仍给出不可用的面板 id，表现就是**右栏一片空白**——这类"只在某条路径下出现"的空面板，
本地（无设备）看不出来。

判据：
1. 三栏（≥840vp）打开右栏：**内容正常显示**（sections 清单），标题行是「详情」；关闭按钮的无障碍文案为「关闭详情面板」。
2. 单栏（手机）从会话头点「详情」：半模态 Sheet 里同样是「详情」区块标题 + 内容（不是空白）。
3. 双栏（600–839vp）的侧边浅层面板：同样有内容。
4. 切会话、进设置再回会话、杀进程重开：右栏**始终有内容**（初值/兜底都指向可用面板）。
5. 若出现空白右栏：记录当时的形态与路径（本项即为定位线索——说明某个产生 `selectedRightPanel` 的地方仍写死不可用 id）。
6. **切换器（P3-2）**：标题行应出现「详情 / 预览」两个 chip（可用面板 ≥2 才画）；点「预览」右栏切到预览面板，
   点「详情」切回；切换后**标题行文案随之改变**（描述符的 label）。
7. **预览面板（P3-2）**：未选文件时是空态（"选择文件以预览"）；在工作区页签点开一个文件后切到右栏「预览」，
   应显示**同一份**预览（代码等宽 / Markdown / 过大与二进制各有对应呈现），且「投喂」可把该文件加进输入区。
8. **文件面板（P3-3）**：切到「文件」应显示**同一份文件树**（与工作区页签一致）；点目录展开/收起、
   点文件在右栏切到「预览」并高亮该行；没有可用会话时显示分档空态（"没选工作区 / 该目录下还没会话 / 目录确实为空"
   三种措辞不同——若都显示成同一句，说明空态文案没按事实分档）。
9. **交付物面板（P3-4）**：让助手产出一个文件 ⇒ 面板列出**一张**卡（不是多张重复：同一条会被流式 merge 多次，
   去重规则在模型里）；「保存 / 分享」应显示为**禁用**（不是点了没反应）；没有交付物时显示"本次会话还没有交付物"。
10. **工具 / 子代理面板（P3-5）**：让助手调用一次工具（例如读一个文件）⇒「工具」面板出现该卡片，
    默认展开与否与主区**一致**；点卡片可展开/收起（与主区互不影响——两处是两个列表）；
    有改动对照的编辑类工具应显示 +/− 行；派生子代理后「子代理」面板出现对应卡。
11. **轨迹面板（P3-6）**：切到「轨迹」应看到**时间总览**（总计 + 比例条 + 统计四项），
    拖动比例条能聚焦到某格并显示详情行；**右栏聚焦不应滚动主区列表**（这是与主区的有意差别）；
    会话没有过程数据时显示"本次会话还没有过程数据"。

**未过此条之前**：不得宣称"右栏面板体系已对齐官方"（内容视图本身也还没做，见 `docs/ia-parity-plan.md` 的 P3）。

### D17. 设置域的分区与切换器（P4-1）

**为什么必须实测**：本轮把设置分区从"视图里的 `@State`"改成 `NavigationState.settingsSection`，
并把「插件清单」从插件段的子页签升为独立分区。渲染结果应当基本一致，但**切换器的可见性/滚动**、
以及"从别处进设置落在哪一段"是本地看不到的。

判据：
1. 打开设置：切换器应有**八项**，官方四段（通用 / 模型 / 插件 / 插件清单）在前，本仓四项（核心 / 预设 / 技能 / 设备）在后；
   窄栏下切换器可横向滚动且不换行。
2. 点「插件清单」：显示**只读清单 + 关键词过滤**（不再有"配置 / 列表"两个子页签）；点「插件」：
   只显示可配置的插件卡（没有清单混在里面）。
3. 从侧栏「设置」进入 ⇒ 落在**通用**；切到「技能」再返回主区、重新进设置 ⇒ 仍是**技能**（状态在导航里）；
4. 杀进程重开：回到**通用**（初始值）。
5. 分区名跟随系统语言（英文系统下应显示 String/翻译，而不是中文硬编码）。

**未过此条之前**：不得宣称"设置域信息架构已对齐官方"。

### D18. 主区兜底修复：冷启后点一下界面不再被系统杀进程（E343）

**为什么必须实测**：2026-09-15 真机报障——冷启后**点一下界面**就被杀进程，`RangeError: Stack overflow!`
（栈里成对出现 `MainShell.ets:405` / `:404`，即"兜底又把自己叫了一遍"）。修复 = 兜底渲染
`TabContentView({ f: this.f.tabFacade })`，把工作区 / 核心 / 设置三类面板接回**主区的第二束**。
**这一条的修复在本地无法验收**：静态门禁只能证明"自递归没了"，证明不了"剩下的面板真的画出来了"。

判据：
1. 冷启（或杀进程重开）后：**不点任何东西**，主区应显示「会话」页（未选会话时的空态），**不得**被杀进程；
2. 先切到侧栏「工作区」（或底部页签工作区）⇒ 主区显示**工作区列表 / 文件树**（不是空白、不是会话页）；
3. 再切「核心」与「设置」⇒ 分别显示核心面板与设置面板；三者在**单栏手机（抽屉）**形态下同样成立；
4. 会话视图 → 设置 → 返回会话：来回切 5 次不崩、不白屏；
5. 日志里不得再出现 `Stack overflow!` / `about to exit due to RuntimeError`。

**未过此条之前**：E343 只能算"已修复待验"，**不得**宣称真机崩溃问题已解决。

### D19. 侧栏可收起 / 展开，并记住选择（P2-15 / P2-17，E361 / E363）

**为什么必须实测**：这两轮把"侧栏展开状态"从一个**没有控制点的字段**接成了真功能
（此前侧栏呈现完全由形态决定 ⇒ 官方 AppFrame 那个"收起侧栏腾出宽度"在本仓做不到）。
本地只能证明：纯函数判定正确（7 条 fixture）、落盘与读回的**三态**正确（3 条 fixture）、
接线还在（功能接线门禁第 18 项）。**证明不了**：按钮画得对不对、图标语义是否自洽、
收起/展开的手感与动画、以及"下次启动真的还记得"。

判据：
1. **三栏（宽窗）**：品牌行右侧出现「收起侧栏」（`chevron_left`）⇒ 点击后侧栏收成 rail（只剩图标），
   主区**明显变宽**；rail 顶部出现「展开侧栏」（`chevron_right`）⇒ 点击后恢复完整面板；
2. **双栏**：默认是 rail；点「展开侧栏」⇒ 变成完整面板且**能放得下**（不出现文字被压扁/溢出）；
   再收起 ⇒ 回到 rail。（**这一条本地查出过真问题**：P5-3 之前双栏的侧栏呈现被硬编码成 rail，
   按钮点了完全没反应 —— 见 E366。真机复核时请确认"按钮真的改变了侧栏形状"，而不只是"按钮在那儿"）
3. **单栏（手机）**：**不应出现**这两个按钮（那个档位是抽屉，没有"展开的侧栏"）；
4. **记忆**：三栏收起侧栏 → 杀进程重开 → **仍是收起**；展开 → 再杀 → **仍是展开**；
   **首次安装（从没设置过）** → 默认展开（不是 rail）；
5. 收起状态下 `＋ 新建会话` 入口仍在（见 D20），且侧栏收成 rail 后**点击区域仍 ≥44vp**；
6. **轨道宽度跟着呈现变（P5-2，本地只能证明纯函数）**：三栏收起侧栏 ⇒ 侧栏轨道**真的变窄到约 56vp**
   （不是"240vp 的框里画一条细 rail"），主区**同步变宽**；双栏**首次启动**（从没设置过）⇒ 侧栏是
   **rail**（不是 240vp 的完整面板）；双栏手动展开 ⇒ 侧栏是完整面板且**轨道也变宽到 240vp**；
   单栏 ⇒ 抽屉在 240vp 面板里**内容不被压成一条**（抽屉宽度与内容宽度同源）。

**未过此条之前**：不得宣称"侧栏信息架构与官方 AppFrame 对齐"。

### D20. 「新建会话」在三种呈现下都可达（P2-16，E362）

**为什么必须实测**：这个一级入口此前**只画在一种呈现里**（PANEL，品牌行下方）⇒
三栏收起侧栏、或**单栏手机底部标签栏**下都没有它，用户只能靠空态里那个按钮或 Ctrl+N。
本地只能证明"三处调用点都在"（`onNewSession()` 1 → 3 处），证明不了**画出来是否看得见、点得中**。

判据：
1. **展开的侧栏**：品牌行下方有 `＋ 新建会话`；
2. **收起后的 rail**：`＋` 图标在「展开侧栏」下面，点击后**新建一个会话**（不是切面板）；
3. **单栏底部标签栏**：第一项是 `＋ 新建会话`（图标 + 文案，与官方"导航面首项"一致），
   点击后进入新会话的空态；底部工具栏**不换行、不挤压**其它两项；
4. 三处入口与 Ctrl+N 走的是**同一条路**（新建后的会话在列表里出现、标题为"新会话"）。

**未过此条之前**：不得宣称"窄形态下的导航信息架构完整"。


## 2. 已有的真机读数（历史，不必重测）

`docs/50-端侧核心运行架构.md` 里 E33/E34/E35/E54 等条目保留了真机逐阶段读数
（`BOOT_00` → `BOOT_70_HTTP_READY`、`/proc/net/tcp` 的 LISTEN 与 ESTABLISHED、ArkTS 侧
`DSHM-NodeRuntime: Host 已就绪`）。回归怀疑时再按那里的方法重取；否则不必重复。

---

## 3. 2026-09-21 两批修复的待验收清单（设备断连前完成代码与构建，全部**未真机复验**）

> 本节由 2026-09-21 深夜自主批次产生。醒后按 D21–D24 逐条验收；**D25 是本批次遗留的
> 已知问题，优先级最高**（它卡住 D21 的最终判定）。

### D21. fs 工具链修复（批次 1：已部署、已过启动、协议链路全通；turn 级仍被 D25 挡住）

**根因（静态证据充分）**：官方 host 组合（apps/cli 的 base/web.cordis.yml）不在 npm 包里 ⇒
端侧核心树的 dsh-base 里 `fs` 能力缝**没有可用 provider**（openharmony 上 fs-sandbox 不可用）⇒
整个 tool-fs 套件（read/write/edit/glob/list/search）永远停在 waiting for fs。

**修复内容**（`dsh-base/cordis.patch.yml`，对照参考 DSHM 但按本仓移植树裁剪）：
1. subprocess 行后注册 `- id: fs` → `@deepseek-ai/dsh-fs-local`（`cwd: process.cwd()`）；
2. `fs-sandbox` 行改 `disabled: !!js process.platform === 'openharmony'`（fs 缝单 provider；
   两边同时启用会 boot 失败 `service "fs" has been registered at <LocalFileSystem>`，已实测撞过）；
3. `dsh-bash-local` 补 openharmony 的 spawn cd 前缀注入（getcwd EACCES 防御；/bin/sh 链不变）；
4. profile（ondevice）的 bash-sandbox 保持 `disabled: false`（本仓已验证链，不照抄 DSHM 的
   bash-local 直连方案）。

**已验证**：重打包→部署→`DSHM_READY` 干净启动、token 获取、session/create、session/prompt 均通。
**2026-09-21 上午复验补充**：本轮协议探针把一元调用信封格式敲实——`POST /api/<ns>/<method>`，
body = `{"type":"client-request","rpcId":"<自铸>","method":"<端点>","payload":{"args":{…}}}`
（裸 args 报 `invalid client-request message`；payload 缺 `args` 报 `Remote payload must
contain exactly one plain-object args field`）。session/prompt 必填 `requestId`（客户端自铸
幂等 id）+ `mode`；session/page 用 `address:{kind:'session',sessionId}` + `throughSeq:-1`。
**待验证**：turn 级别（fs 工具是否真的活了）——被 D25 挡住。

### D22. busybox applet + 内置 skills（批次 2：已部署；判据 1 ✅，判据 2–4 待 turn 恢复）

**改动**：
- 资产入包：`resfile/busybox/busybox`（1018KB arm64）+ `resfile/ohos-skills/*.md`（4 个）；
- `hostcore/app/main.js` 新增布置段：resfile busybox → `<HOME>/bin/` 复制本体 + 10 个 applet
  副本（ash/bash/hush/bzip2/xz/hexdump/less/nc/unzip/vi，**刻意不含 sh**——/bin/sh 是已验证链），
  每个副本 `chmod 0o755` + `X_OK` 读回验证；全部通过才把 `<HOME>/bin` 前插 `PATH`，
  任一失败**不注入**（保已验证链零影响）。幂等：本体大小指纹一致则跳过复制只补 chmod。
- skills：`resfile/ohos-skills/*.md` → `$DSH_HOME/skills/`（skill-filesystem 的 user-dsh root
  就是 `join($DSH_HOME, 'skills')`），逐文件**内容 sha256** 幂等同步。
  （2026-09-28 P0-1 修正：原判据是**字节数**，而 `hdsh-*` → `dshm-*` 是**等长替换** ——
  两份 `ohos-python.md` 都是 6262 B ⇒ 判"已是同一份" ⇒ 设备端 skill 永远停在旧端点，
  模型照文档手调必然 404。判据换成内容 sha256 后任何等长改动都会被复制，见 §「技能同步」条目。）

**验收判据**：
1. `<HOME>/dshm-host.log` 出现 `PATH 已注入 busybox bin：/…/files/bin:/usr/local/bin:…`；
2. bash 工具里 `command -v bash unzip less` 均命中 `<HOME>/bin`；`command -v sh` 仍是系统路径；
3. skill 工具 list 出现 ohos-pc / ohos-python / ohos-shell / ohos-workspace；
4. `busybox | head -1` 正常输出（可执行位 OK）。

**2026-09-21 上午验收**：
- 判据 1 ✅：dshm-host.log 三条证据齐——`busybox：已布置 11 个副本到 …/files/bin`、
  `PATH 已注入 busybox bin：…`、`skills：内置技能已同步（本次复制 4 个）`；
  沙箱 `bin/` 实测 11 个副本（含 busybox 本体）。
- 判据 2–4 ⏸：bash 工具与 skill list 都要跑 turn，被 D25 挡住。

### D23. TopBar + 品牌启动动画（批次 2：已部署；静态判据 ✅）

`WebApp.ets`：DSHM 同款自绘顶栏（38vp 白底 `#ffffff`、底描边 `#e4e7ec`、logo_dark 16 +
「DeepSeek」+ Harness 菜单〔主页/刷新/关于版本〕；DSHM 的编辑/窗口两组 PC 语义菜单不搬）；
BOOTING 页改品牌动效（`#F3F7FB` 底、logo 92 呼吸 1→1.09 + 淡入、线性进度条 200×6 循环、无文案）。

**验收判据**：顶栏三动作可用（BOOTING 期点击安全忽略）；启动页呼吸动画与进度条可见；
ERROR 重试路径不回归；暗色模式下顶栏仍为白底（刻意，系统按钮深色图标的对比度教训）。

**2026-09-21 上午验收**（Web 组件不展开 DOM，无法读图 ⇒ 用 `uitest dumpLayout` UI 树 +
hilog DOM 探针替代视觉验收）：
- UI 树 ✅：`dist/acceptance/webapp-layout.json`——顶栏品牌文本（DeepSeek）与 Web 组件节点
  在位，无 ERROR 覆盖层文本（「无法连接本地核心/重试」零命中）；
- DOM 探针 ✅：hilog `DshWebApp` 回报
  `{"t":"… — DeepSeek Harness","s":"complete","n":6761,"p":"object","c":"object","r":"function","i":1,"d":0}`
  ——官方 web 前端完整渲染；**三段式目录选择桥（p/c/r）全部就位**；1 个
  `input[type=file]`、`webkitdirectory` 语义零降级泄漏（`d:0`）；
- 截图存档：`dist/acceptance/webapp-check.jpeg`（2880×1920，供人工复核动画与暗色细节）。

### D24. 部署链提醒

设备回来后：`node tools/pack-core.mjs --skip-install` → **手动**拷 zip 到
`entry/src/main/resources/resfile/`（pack 只写 dist/core）→ `build_project` → `hdc install -r`
→ 清两日志 → `aa start` → 等 ~28s → `grep -a 'token=' node-output.log`。
本轮已把批次 2 构建进 HAP（`entry-default-signed.hap` 217MB，已验证内含 busybox/skills/logo）。

**2026-09-21 上午已走通**：核对 resfile 资产时间线（核心 zip 4:21 / main.js 4:59 / busybox /
4 skills 均为本批次产物）⇒ 无需重打包；WebApp.ets 令牌化小改后 `build_project` 全量
（含 SignHap/SignApp）✅ → `hdc install -r` ✅ → `aa start` ✅ → 进程存活（pid 35768）→
Host 就绪 ~1.9s（`GET / → HTTP 401` 信任栅栏正常，token 43 字符，port 3120）。

### D25. 【已知问题 · 最高优先】turn 不启动（批次 1 遗留）

**现象**：新构建上 session/prompt 被受理（agent/inbox/spliced 落账），但 85s+ 无 turn/start。
同会话的 title 子代理正常跑（llmMs=1581）⇒ LLM 链路与 agent 工厂是好的，卡在主 turn 准入。

**静态排查已穷尽**：tool 注入全部可解析（fs/shell/subprocess/jobs/goals/subagents/skills）、
fs-local 类服务形态合法（extends FileSystem、Config schema 可过）、koffi 惰性路径 win32-only。

**下一步实验（需设备，按序）**：
1. hilog 与 `dshm-host.log` 抓 `fs-local|LocalFileSystem|service` 关键词；
2. **回滚实验**：dsh-base 的 `- id: fs` 行临时禁用 → 重打包部署 → 同样探针 prompt →
   turn 若起来，证明 fs-local 注册本身挡了 standard preset 的 agent 组装
   （候选机制：tool-fs 对 fs 服务的工具枚举在端侧路径上抛错）；
3. 若回滚后 turn 也不起来 ⇒ 与 fs 无关，转向 turn 驱动器（admission/concurrency 配置）
   与 preset 差异排查。

**2026-09-21 上午复现与第 1 步结果**：
- **复现** ✅（问题仍在）：协议探针——铸 cookie → `session/create`（agentPreset:
  standard）→ `session/prompt` 受理（`accepted:true`，requestId 自铸）→ **15 分钟后
  `session/page` 返回 `records: []`**（无 user/message 落账、无 turn/start）；
- 第 1 步 ⛔ 无直接线索：`fs-local|LocalFileSystem` 在 hilog 与 node-output.log 均零命中
  （fs-local 是 cordis 服务，注册不打 hilog；其 console 日志若存在也被 ArkWeb/CEF 噪音
  淹没——本轮发现 node-output.log 尾部被 chromium 渲染层日志刷屏，业务日志需 grep 精确
  pattern 提取，下轮排查建议直接读 `dshm-host.log` + `session/page`，绕开噪音）；
- 结论：按原计划进入第 2 步回滚实验（与下一次重打包合并执行，见 D26 后的批次备注）。

### D26. web 前端「插件安装」入口在端侧必然失败（根因已锁定，接受现状）

**现象**（2026-09-21 用户报告）：在 WebApp 的 web 设置页安装插件，给 npm 包名或
git 仓库地址都无法安装。

**根因链**（证据全部来自设备上的核心树 0.1.6-alpha.2）：
1. web 前端插件页 `@deepseek-ai/dsh-client-ui-settings-plugins` 的 Host 半边是空壳
   （13 行，`apply(){}`），浏览器半边把安装动作直连 Host 的 `@deepseek-ai/dsh-plugin-manager`；
2. `dsh-plugin-manager` 的**所有安装路径**都走 `execa("pnpm", …)`（`runProfilePnpm`），
   spec 三形态 = npm 包名 / git URL / hosted repo URL——即用户输的「包名或仓库地址」；
   连「问 registry 这个包存不存在」都是 `pnpm view`；
3. 源码自带失败分类：`facts.cause?.code === "ENOENT" → "pnpm-missing"`
   （`lib/types/install-failure.js`）——端侧 `bin/` 只有 11 个 busybox applet，
   **没有 pnpm / npm / git** ⇒ 无论输哪种 spec，第一步 spawn pnpm 就 ENOENT；
4. 会话内命令通道也无此命令：`commands/list` 实测只注册 compact/export/feedback/
   goal/plan——上游 `dsh plugin add` 是 CLI 子命令，不进会话命令表。

**与既有记录的关系**：这就是 D6 E15/E86 硬边界（上游 `dsh plugin add` =
`spawnSync("pnpm")`，端侧无法满足）在**官方 web UI** 上的表现。ArkUI 插件页
（`SettingsPlugins.ets`）因此刻意不做安装入口并写明原因；web 前端不知道端侧边界，
入口在但必然失败。

**处置**（2026-09-21 与用户确认）：接受现状，不做运行时安装。
- 端侧正路 = **插件随核心包发版**：PC 侧把插件装进核心树（pack-core），或在 profile
  种子里加插件行；重打包部署后即可用；
- 端侧 `.dshm-plugin-rows.yml` 用户行（E91）只管**已随包发版插件**的启停；
- web 前端的安装入口失败属预期行为，不改 web 前端（官方 UI 不由本仓维护）。

**处置更新（2026-09-21 下午轮，用户指令升级为"解决 pnpm 问题"）**：上午的
"接受现状"被**进程内安装通道**取代（不是修复 pnpm，是换通道——端侧没有
pnpm/npm/git，也没有独立 node 可执行文件能跑它们，垫 shim 或 patch 上游
execa 都无意义）。通道四件套（本轮已落地并装机 <设备序列号>）：
1. `hostcore/app/dshm-installer.js`（新，发版随 main.js 进 resfile）：
   spec 解析（npm 包名/@range / GitHub 三形态，对齐上游 install-spec）→
   node:https 拉 tarball（registry 默认 npmmirror，`<HOME>/installer.json` 可配）→
   **纯 JS gunzip（node:zlib）+ ustar 解析**（不 spawn，tar-slip 逐段校验拒 `..`，
   symlink/hardlink 条目如实跳过报告）→ `node_modules` 落位 → 递归 dependencies
   （深度 ≤3，同名已装跳过，简化 semver）→ profile `package.json` merge →
   `.dshm-plugin-rows.yml` 追加用户行（E91 复用，幂等，重启随 composeUserRows 生效）；
2. `main.js` start() 尾部安装队列：轮询 `$DSH_HOME/install-queue/*.req`（2s，
   unref，单飞行守卫），结果写 `<base>.done`/`<base>.fail`（JSON），req 取走即删；
3. `SettingsPlugins.ets` 安装区块（ArkUI 入口，`ui-<ts>.req`）：spec 输入 → 提交 →
   轮询结果回显 → 重启生效提示；页面头部文案同步改写（旧"硬边界"说明作废）；
4. skill `ohos-plugin-install.md`（模型入口，`model-<ts>.req`）：教模型弃 pnpm 走队列。

**验证**：PC 侧全链路单测 **24 passed / 0 failed**（tools/check-dshm-installer.cjs：tar-slip 拒绝、
symlink 跳过、GitHub 三形态、debug@4.3.4 真实下载+递归 ms、merge、**不再写用户行**、
幂等、**版本漂移必重装**、不存在包干净失败、semver 范围）；全量编译 BUILD SUCCESSFUL；
`hdc install -r` 成功，待用户手动启动测试。

> **2026-09-28 更新**：该门禁原先一直是红的（两处陈旧断言，见 §五）；
> 重写后补了 P1-2 的**双向极端用例**——5a 同版本真幂等（`installed.length === 0` 且文件不动）、
> 5b **版本漂移必重装**（`beforeVersion`/`afterVersion` + 磁盘版本确实翻转）、
> 5c 追平后回到幂等（不无限重下）。原先的"16/16"是**重写前**的读数，且当时它其实并未全过。

**如实登记的语义边界**（不随通道落地而消失）：含原生模块（.node）的插件依旧
装不了（沙箱禁 link，13900012）；`dsh.bundle` 声明的子插件组只装主包、不自动
逐行注册（reconcile/bundle 激活语义未跟进，用户按其 README 手动追加用户行）；
web 前端官方安装入口依旧必败（不改官方 UI）；安装的插件**重启后才挂载**。

### D28. 「设置 → 登录」拉起系统浏览器（m00001，**2026-09-28 真机复核通过**）

**现象（用户报告 m00001）**：鸿蒙端点「设置 → 登录」，**什么都不发生**——不弹浏览器、
不弹框、无报错、界面无任何变化。（"本地默认调用华为浏览器"是当时的设备描述；
目标是拉起**系统默认浏览器**，不指定哪一款。）

**两层根因（缺一层都修不好）**：

1. **引擎层**：ArkWeb 的 `multiWindowAccess` 默认为 `false`（`ets/component/web.d.ts:6816-6826`）
   ⇒ `window.open` 与 `target="_blank"` 一律**静默丢弃**。本仓全树 grep
   `onWindowNew|multiWindowAccess|allowWindowOpenMethod|onLoadIntercept|onOverrideUrlLoading`
   **零命中** ⇒ 没有任何地方接过这个语义。
2. **前端层**：登录路径上**根本没有可点的外链**。唯一带授权页锚点的是
   `dsh-client-ui-settings-account/lib/client.js:2435-2451` 的 AccountSection
   `<a target="_blank" href={authorizeUrl}>`，但它只在 `snapshot.view?.status === "credential-stored"`
   时才注册（`:4397-4419`）⇒ **未登录时它不存在**；未登录能点的 SignInDialog（`:989-1107`）
   没有任何 href、也没有 `window.open`，只有一个「复制链接」。
   ⇒ **光接住 `target="_blank"` 是不够的**。

**修法**：`WebApp.ets` 新增文档开始垫片 `OPEN_LINK_SHIM_JS`（与目录选择、外观跟随同范式）
+ 同步桥 `__DSHM_BRIDGES__.openExternal(url, mode)` → `platform` 的 `openExternalUrl`
（`context.openLink`）。三条路径：① tap `account/watch` 的 WebSocket 帧，
`attempt.phase === 'waiting-browser'` 且带 `authorizeUrl` ⇒ **自动外开**（无确认，壳职责）；
② tap 含 `account/` 的一元 `fetch` 响应（`response.clone()`）作兜底；③ 捕获阶段拦
`a[target="_blank"]` / `window.open` 的 http(s) 目标 ⇒ **二次确认后**外开。
机制与取舍详见 `docs/70-鸿蒙移植踩坑与修复总览.md` §7.9。

**本机已证**：`assembleHap` → `BUILD SUCCESSFUL`（exit 0），产物
`entry/build/default/outputs/default/entry-default-signed.hap`。
**这不能替代本项**——它只证代码编得过，不证桥在真机上被调到，更不证系统浏览器被拉起。

**真机要看的（按序四步）**：

1. 点「设置 → 登录」⇒ **系统默认浏览器自动打开**授权页，**无需再点任何东西**。
   这是本 bug 的核心判据；若仍是"点了没反应"，本项直接判失败。
2. 在浏览器里完成授权。
3. 回到应用 ⇒ 账号状态变为 `credential-stored`（左侧账号菜单出现已登录态、
   设置面板出现「账号」section）。**回调落在浏览器的空白页属预期**
   （`loginSource="desktop"` ⇒ 回调收尾是 HTTP 204，只有 `login_source=web` 才返回关页 HTML），
   不是失败。
4. 顺带验非授权外链（登录后设置里的「用量」「充值」等）⇒ 应**先弹确认框**，
   点「打开」才进浏览器（区分于第 1 步的自动外开）。

**诊断读数**（用来定位"哪一段没通"）：

- `hdc shell "cat /data/app/el2/100/base/com.dshm.dshclient/haps/entry/files/diag-openlink"`
  —— 每次外开请求追加一行：`auto <url>`（授权页自动外开）/ `confirm <url>`（外链确认）/
  `failed <url>`（`openLink` 未受理）/ `error <msg>`（异常）。
- `hdc shell hilog` 里筛 `DshWebApp` —— 有 `外开请求 mode=… url=…`；
  被白名单拒时是 `外开被拒（非 http/https）`。
- **三种失败各自的样子**：没有 `diag-openlink` 行 ⇒ 桥没被调到（垫片未注入，
  或垫片没截到帧）；有 `auto` 行但浏览器没起 ⇒ 桥通了，问题在 `openLink` 这一层
  （配合看 `failed` / `error` 行）；有 `auto` 行且 `failed` ⇒ 设备上没有能受理
  https 的浏览器应用。

**失败时的行为（已实现，不是"应该会"）**：

- 桥未就位时（`javaScriptProxy` 注册与文档开始垫片的先后在真机上反复过），
  自动外开**入队有界重试**：250ms 轮询、窗口 15s、URL 去重、**投递成功才记账**
  ⇒ 授权页只在 `waiting-browser` 那一刻推一次也不会丢。
- 外链点击在桥未就位时**不** `preventDefault`（放行给 WebView 默认行为，仍是丢弃
  = 与改动前一致），**不制造新的"点了没反应"**。
- `openLink` 失败会**弹「无法打开外部浏览器」**并写 `diag-openlink failed`——
  静默失败就是本次 bug 的翻版。

**真机复核（2026-09-28，设备 `86E0226429000417`）**：四步全部有直接读数，**m00001 判为已修复**。

| 步 | 判据 | 读数 | 结论 |
|---|---|---|---|
| 1 | 点「设置 → 登录」⇒ 无确认框、直接外开授权页 | `diag-openlink` 有 `auto https://platform.deepseek.com/dsh/authorize?authorize_id=KiqzHpwPMVYRtmp6MbUMD0ZKce41_YR_2UmHXiKSlfg` | ✅ `auto` 分支成立（区别于第 4 步的 `confirm`） |
| 2 | 浏览器里完成授权 | 设备上为既有登录态（`Sol` / `130******58`），本轮只核「拉起」这一段 | — |
| 3 | 回跳后状态 `credential-stored` | 设置面板出现完整「账号与余额」区（`region 账号与余额 [1111,374][2099,878]` + `充值余额 ¥4.49` + `查询用量`/`充值` 两个 link）——该 section **只在 `status === "credential-stored"` 时注册**（`dsh-client-ui-settings-account/lib/client.js:4397-4419`） | ✅ 间接证据成立 |
| 4 | 非授权外链 ⇒ 先弹确认框，点「打开」才进浏览器 | 点 `查询用量` ⇒ `AlertDialog`「打开外部浏览器？」+ `https://platform.deepseek.com/usage` + `取消`/`打开`；点「打开」⇒ `ps` 出现 `ei.hmos.browser` 且其页面在前台（地址栏 `platform.deepseek.com/usage`、正文 `用量信息` / `累计消费金额 ¥555.53 CNY`） | ✅ |

**第 4 步另做了阴/阳对照（同一 HAP、同一控件，排除误击与设备侧自启）**：

| 动作 | `diag-openlink` | `OnInvokeMethod: … openExternal` | 浏览器进程 |
|---|---|---|---|
| 起点 | 408 B | 3 | 无（`aa force-stop` 后三轮询均无 ⇒ **无自启/预热**） |
| 点 `查询用量` | 408→**477 B**（追加 `2026-09-28T13:33:38.913Z confirm …/usage`） | 3→**4** | **仍无** |
| 点 **`取消`** | **仍 477 B** | **仍 4** | **仍无** ⇒ 取消不触发外开 |
| 再点 `查询用量` + 点 `打开` | 477→**546 B** | 4→**5** | **`23803 ei.hmos.browser`**，前台即用量页 |

⇒ 因果链确证：点外链 ⇒ 弹确认框 + 写 `confirm` 行 + 桥被调用（**不开**浏览器）；取消 ⇒ 无任何动作；打开 ⇒ 浏览器拉起并加载目标页。

**桥层旁证**（`files/node-output.log`）：`grep -c 'OnInvokeMethod: method name: openExternal'` = 5，紧邻有
`CheckIsInJsPermission …, method_name: openExternal, object_id: 1` 与两次 `ParseBaseValueTOCefValueHelper: STRING`
（即 `url` 与 `mode` 两个字符串参数）。同帧另有 `native proxy object not found, name:__DSHM_BRIDGES__`
（`:4388` 紧接 `:4380`）——属既有的 javaScriptProxy 注册时序现象（见下方"入队有界重试"），**未阻断外开**。

**累计数值线**：`diag-openlink` 6 行 = 1×`auto` + 5×`confirm`；**无任何 `failed` / `error` 行**。

**取证方法的两个坑（本项踩到，已复用）**：

- **设置对话框有 tab 记忆**：上一轮停在 `内置插件` tab 时，点账号区坐标会落在插件明细上（`layoutB` 117 节点全是内置插件条目）⇒ 点账号控件前必须**先点 `账号与余额`**。
- **hilog 在本项上不可用**：`hilog -x -T DshWebApp` 与
  `grep -E '外开|openlink|openExternal|__DSHM_BRIDGES__'` **均为空**（缓冲只留了
  `com.dshm.dshclient:gpu/chromium` 的 `vulkan switch config` / `NotifyFirstRealSwapBuffer` / `DVsyncController` 噪声）
  ⇒ 凡涉及外开的真机取证**只能靠 `diag-openlink` 文件**，UI 变化用 `uitest dumpLayout` 前后 diff 判定。
  这与 `WebApp.ets:680-683` 已登记的"hilog 有丢日志前科"一致。

**一次污染读数（留档，非缺陷）**：第一轮点 `取消` 后曾观察到浏览器在前台（`21724 ei.hmos.browser`），
与代码不符（取消按钮 action 是空实现）。干净复位（`aa force-stop` + 前置应用 + 复读 diag/bridge/browser）
后复跑，阴性对照三轮读数均不动 ⇒ 判为**污染**（上一轮的浏览器实例或设备侧干扰），非本仓缺陷。

**未取到的读数（如实登记）**：`hdc shell "cat …/dsh/home"` 与 `…/dsh/home/profiles` 均 `Permission denied`
（应用私有子目录，既有现象）；授权页 `auto` 分支的**本轮实测**未复跑（`diag-openlink` 里那条 `auto` 是
`12:54:16Z`，早于 `21:09` 那次装机，属上一版 HAP 运行——但仍证桥与 `openLink` 通）。要补"新版 HAP 上
`auto` 分支也成立"的直接证据，需退出登录后重走「设置 → 登录」。

关联：`docs/70-…md` §7.9、`WebApp.ets` 的 `OPEN_LINK_SHIM_JS`。

---

**批次备注（2026-09-21 上午轮）**：本轮完成 D22 判据 1、D23 静态判据、D24 部署链、
D25 复现与第 1 步（无线索）、D26 根因锁定。**遗留**：D25 第 2 步回滚实验（禁用
dsh-base `- id: fs` 行 → pack-core 重打包 → 部署 → 协议探针，判据 = `session/page`
records 非空）；D22 判据 2–4 与 D21 turn 级验证都等 D25 解锁。

**批次备注（2026-09-21 下午轮）**：DSHM 品牌改版（WebApp.ets 全文重写：自绘
BrandMark + 双菜单 DSHM/编辑 + 七动作编辑菜单 + 启动画面换自绘标识，期间修复
PowerShell GBK 事故造成的 FFFD 损坏）；D26 处置升级为运行时安装通道并落地
（四件套 + PC 单测 16/16 + 编译装机，见 D26 处置更新）〔2026-09-28 补注：这个
"16/16" 当时**并未全过**——该门禁自首次提交起就一直是红的，两条断言与实现方向相反；
重写后为 **24 passed**，详见 D26 处置更新里的「2026-09-28 更新」与 §五〕。**门禁甄别**：8 门禁
PASS；arkts-entry / plugin-toggle / origin-fence / web-fetch-jitless 为既有环境性
失败（Linux 路径 / 旧 core 0.1.5-rc.2 / 本机原生 fetch），dead-handlers 为审计器
既有报告（173 处回调默认值模式，无本轮新增）。**本轮新教训**：arkts_check 不查
类型导出，`pasteboard.Pasteboard`（应为 `SystemPasteboard`）这类错只有 hvigor
全量编译才暴露——改 .ets 后只跑 arkts_check 不算编译通过。

**批次备注（2026-09-21 品牌对齐轮，用户验收反馈驱动）**：上轮自绘品牌被用户
否决，改为**对齐官方**：① 应用名 DSHM → **DSHM**（dsh + HarmonyOS，app_name/
EntryAbility_label/APP_NAME 全套）；② 顶栏标识 → 官方鲸鱼（FISH_LOGO_PATH
逐字节取自核心树 `@deepseek-ai/dsh-client-ui-primitives`，viewBox 23.16×17.04，
ArkUI `Shape().viewPort()` 渲染，白底黑鲸形态）+ 菜单名 DSHM（删独立品牌名文字，
macOS 式图标+应用菜单）；③ 启动画面恢复官方 `logo_dark` 资产（用户指定项目内
官方素材，动画机制不变）；④ app icon/startIcon 从 DevEco 模板图换官方白底黑鲸
（PC 侧 resvg 光栅化 1024×1024 前景/纯白背景/144×144 启动图，像素验证鲸鱼居中，
资产生成脚本 `%TEMP%\deveco\icon-gen\gen-icons.cjs`）；
⑤ 关于版本显示当前 dsh 核心版本（`<filesDir>/dsh/cores/` 目录名）。**编译教训
两笔**：ArkUI Shape 的视口属性拼写是 `viewPort`（非 SVG 的 viewBox）；@Builder
调用返回 void 不能链属性修饰（margin 要放外层容器）。**装机未完成**：<设备序列号>
编译成功后掉线（hdc list targets 空），待设备重连后 `hdc install -r` 补装。

**批次备注（2026-09-21 验收反馈第二轮，4 问题定位与修复）**：用户实测反馈 4 项，
定位与处置：① **桌面图标未变**——根因实锤：应用级图标（桌面/系统窗口标题栏读的
那份）在 `AppScope/resources/base/media/`（app.json5 `icon: $media:layered_image`
在**应用级上下文**解析），上一轮只换了 entry 模块那套（module.json5 引用）。
像素验证 AppScope background.png 为蓝紫→蓝青渐变（(62,64,153)→(55,130,164)，
即用户说的"绿 H"模板图）→ 已同步为白底黑鲸两件套。② **窗口左上角"绿 H + DSHM"**
——UI dump（uitest dumpLayout）实锤为 **ContainerModalTitleRow（平板自由窗口
系统容器模态标题栏）**，显示的是系统读的应用图标+应用名，位于我们自绘 TopBar
（"下一层"）之上。③ **顶栏要合并到窗口最边一行**——官方方案（窗口沉浸式文档·
自由窗口标题栏沉浸案例）：`window.setWindowDecorVisible(false)` 隐藏系统标题栏
（图标+应用名），**保留右上三键**（全屏/最小化/关闭），页面扩展至原标题栏区域，
且透明标题栏区保留**默认拖动移动窗口/双击最大化**能力（华为浏览器 Tab 同款）；
实现：EntryAbility 主窗分支调用 + WebApp TopBar 动态避让三键
（`getTitleButtonRect()`，SDK d.ts 实证 **TitleButtonRect 单位 vp** + 
`on('windowTitleButtonRectChange')` 监听，`@State decorPadRight`）。④ **插件安装
"退出码127"**——127 = bash command not found：模型收到安装请求后直接跑
`pnpm add <spec>`（skill 通道根本没被看），busybox 报 not found。**修复策略
（不赌模型自觉）**：main.js `ensureCliShims()` 把 **pnpm/npm 假壳**（POSIX sh，
76 行）布置进 busybox bin（PATH 最前）：`pnpm add X` 被改写为安装队列投递
（`cli-<ts>-<pid>.req`）并**同步轮询等结果**（.done/.fail，默认 90s，`SHIM_WAIT_MAX`
可调），模型视角 pnpm 直接成功；remove/无参 install/其他子命令如实报错引导。
**真机回路实测**（hdc shell + mock Host 接单）：`pnpm -v` ✓、`pnpm add ms` 投递
req（内容恰为一行 spec）✓、超时路径 ✓、完整回路（投递→mock 接单→done 回读→
exit 0）✓。skill `ohos-plugin-install.md` 同步改写：首选姿势 = 直接 pnpm add
（假壳接住），手动队列降为后备。**本轮教训**：诊断日志量大时 hilog 快照缓冲
（`-z`）会被 chromium 噪音冲掉，BOOT_ 启动段日志拉取要靠"清缓冲→force-stop→
启动→立即拉"的窗口期；hdc shell 里 PowerShell 双引号串的 `$?` 会被 PS 抢先插值
成 True/False，跨 shell 变量一律用单引号串。

**批次备注（2026-09-21 真机自测第三轮，装机后 dumpLayout 行为验证）**：覆盖安装
（保留用户数据）后 force-stop → aa start 冷启动自测。① **启动链路**：DOM 探针
19:43:56 即 complete（页面标题回读正常）= Web + Host 全链路活着。② **标题栏沉浸
验证（uitest dumpLayout）**：ContainerModalTitleRow 出现 **0 次**（系统"绿 H +
DSHM"标题栏已隐藏）；窗口 bounds [473,314]，DSHM 菜单文字 bounds y=333 —— 
**TopBar 已成为窗口第一行**（38vp×1.75=66.5px 与文字垂直居中 333–360 完全对齐）；
右上三键保留（[2249,322][2298,371]/[2319,322][2368,371] 两按钮区在窗口顶右侧）。
③ **装机产物核对**：HAP 内 resfile main.js 为新版（含 CLI_SHIM_LINES/
ensureCliShims/SHIM_WAIT_MAX，75830 字节）；打包图标像素验证 background 512×512
均匀 (254,254,254) 纯白 + foreground 全黑前景 = **新图已进包**（打包器把 1024
源图规范为 512 标准尺寸并轻微重编码，非旧图）。④ **日志通道限制实锤**：
DSHM-NODELIVE 的 tail 线程为"从文件当前末尾追"语义（tail -f），Host 启动早期
stdout（BOOT_/假壳布置/队列就绪）在 tail 线程启动前已写入文件 → **永不进
hilog**；hilog 里 NODELIVE 全为 ArkWeb/cef 噪音（533 行无一例外）。**诊断结论：
启动期问题不能依赖 hilog NODELIVE 通道，应依赖 diag 落盘文件 + 行为验证**
（dumpLayout / DOM 探针）。假壳布置的最终确认走用户实测（聊天里让模型装插件）。
⑤ **遗留预案**：桌面 launcher 图标若仍显示旧图 = launcher 缓存，需卸载重装
（代价：重新解包核心 30–60s + 重填 API key，须用户同意）。

**批次备注（2026-09-21 真机自测第四轮，端侧工具链四件套：rg / npx / git / Python）**：
用户对照千问办公环境分析后指示"1 2 3 顺着来，我还需要Python的环境"。① **rg（修
fs-search 断裂）**：dsh-tool-fs-search spawn 打包 ripgrep，optionalDependencies 只装
了 win32 平台包 ⇒ 设备上 SEARCH_FAILED 是必然。npm pack `@vscode/ripgrep-linux-
arm64@1.18.0`（bin/rg 4.77MB **静态 ELF 无 PT_INTERP**，e_machine=0xB7）→ 
pack-core.mjs 新增 `ensureRipgrepPlatformPackage()`（缓存缺失自动 npm pack + ELF 
aarch64 校验）注入 core 树 node_modules；同轮 **推翻 E15 遗产**：`addOnDevicePreset`
不再禁用 tool-bash/tool-pwsh/tool-fs-search（E15"鸿蒙不支持进程创建"与 D26 真机
127 实测矛盾），preset 回归 standard 原始条件（linux：bash 启用/pwsh 禁用）。
重打包 zip 66.1MB/sha256 2abe22da…，验证包内 rg 在位 + fs-search 禁用行消失。
② **npx 假壳**：NPX_SHIM_LINES（60 行 POSIX sh）——npx 语义"装并立即执行"，端侧
把【装】接进安装队列（cli-<ts>-<pid>.req → .done/.fail，SHIM_WAIT_MAX 180×0.5s）、
【跑】引导 node 直调包内脚本；ensureCliShims 改写 pnpm/npm/npx 三壳。
③ **Python**：python-build-standalone release 20260901 的 `cpython-3.12.14+
20260901-aarch64-unknown-linux-musl-install_only_stripped.tar.gz`（27.3MB）。
**musl 变体特性实证**：bin/python3.12 23MB 且无 NEEDED libpython（静态嵌入），
lib-dynload 仅 3 个可选 .so——用 `\0_ssl\0` 等内建模块名搜 libpython3.12.so.1.0
字节流，_ssl/_socket/_hashlib/zlib/_json/_sqlite3/unicodedata 全部 STATIC-BUILTIN
存在 ⇒ 核心扩展静态内建，运行只依赖系统 musl loader（busybox 同 loader 已实测）。
④ **git**：Alpine v3.21 main aarch64 APKINDEX 递归解析 so: 闭包 = git-2.47.3-r0 +
14 依赖包（libcurl/openssl/pcre2/zlib/brotli/c-ares/libidn2/libpsl/libunistring/
nghttp2/zstd）+ ca-certificates-bundle，共 8.1MB apk。**apk 原样进 resfile**（Windows
解包会把 git-core 180+ symlink 变 1.3GB 拷贝，绝对不行），端侧 busybox tar 解；
Alpine 3.21 git-core 在 `usr/libexec/git-core/`。⑤ **main.js 工具链自举架构**
（+221 行）：`ensureToolchainWrappers` 同步布置 python/python3/pip3/git wrapper
（PATH 最前、幂等重写、指 toolchain 静态路径）；`scheduleToolchainExtraction` 判
锚点（python=bin/python3.12+lib/python3.12/os.py 双锚，git=usr/bin/git+git-core/
git+libcurl.so.4 三锚）→ 清残局 → **spawn busybox ash -c 后台解包**（28.6MB/
4530 文件同步解会卡死 Host 事件循环、拖垮 boot 探针）→ stdout/stderr 落 
.extract.log 不进 hilog 噪音；`finishToolchainExtraction` exit 回调收尾：rename
归位 + **hmfs symlink 告警跳过的补偿**（git-remote-https 复制 git-remote-http
本体，git 按 argv[0] 分发拷贝等价）+ chmod 755/X_OK + 锚点复验 + diag/log 摘要。
新资产放置脚本 tools/place-toolchain.mjs（third_party → resfile/toolchain/）。
⑥ **装机自测**：HAP 254.8MB（+35.4MB 归档），tar -tf 核对 16 归档 + main.js 在位、
resfile main.js 与 hostcore SHA256 一致、U+FFFD=0；装机冷启动 DOM 探针 22:07:38
complete（**boot 未被解包拖垮**，异步设计生效）；ps 无 busybox/tar 残留进程（解包
已退出）。⑦ **既有门禁失败登记（与本轮无关）**：check-model-roundtrip:46 / 
check-plugin-toggle:34 写死 `dsh-core-0.1.5-rc.2`（实际 0.1.6-alpha.2）路径漂移；
check-dead-handlers 172 处空实现为提示性扫描（exit 1 是设计行为）。
⑧ **待用户验收**：聊天里让模型跑 `python3 --version` / `git --version` / 
`npx -v` / 文件搜索（fs-search 走 rg）——hdc shell 读不到 home/ 沙箱（700），
hilog NODELIVE 看不到启动期 stdout，行为验证只能走聊天通道。启动期诊断仍以
diag 落盘 + DOM 探针/ps 为准。

## 批次备注五（2026-09-22 凌晨：四命令 127 全灭根因修复 + hmfs 五大实证）

① **故障**：用户聊天实测 python3/git/npx/rg 四条全部 127（`/bin/sh: xxx:
inaccessible or not found`），连早已实现的 npx 假壳都找不到——布置层整体失效。

② **验证通道升级（推翻第四轮⑧的部分结论）**：`sandboxHome=filesDir` 对
hdc shell **可读**（NodeRuntime.ets 实注"hdc shell 对 files 目录可读"），
`hdc file recv .../files/dshm-host.log` 直接取回 37KB 诊断日志——**不再依赖
聊天通道**，本轮全部证据来自 hdc 直读（diag 日志 + ls/od 交叉验证），
未占用 verify_ui 配额。

③ **根因（dshm-host.log 时间线，EACCES 封存态）**：03:04 首次布置 busybox
11 副本成功（全新文件 chmod 755 通过）；06:10 幂等补 chmod 仍通过；**07:57
起每次 boot 对同路径 chmod 全部 EACCES**——ensureBusybox 按设计整体放弃返回
''→ PATH 未注入 → 假壳/wrapper/解包**全链跳过** → 四命令 127。同时 bin/ 里
ash/bash/busybox/nc/unzip 5 文件 stat `?????`（hdc 视角元数据不可读）、
其余 7 个完好：hmfs 上"曾布置过"的文件可能进入 chmod 与覆盖写都被拒的
"封存态"（15:30 新进程直写即成功，封存与跨进程持有/旧进程残留相关）。

④ **修复一（自愈）**：`rewriteExecutable`（直写→失败→**删除重铺全新
inode**→chmod→X_OK；删除重铺实证可救）；ensureBusybox 健康快路径改双条件
（statSize 一致 **且** execOk）+ `bin-<pid>` fallback 目录 + cleanupStaleBinDirs；
CLI 假壳与工具链 wrapper 布置同走 rewriteExecutable。15:30 装机实测：
PATH 注入 ✓ 假壳 ✓ wrapper ✓ 解包启动 ✓。

⑤ **发现二（tar/hmfs 交互）**：解包 4530 文件全部 `tar: settime: Permission
denied`（hmfs 的 utimensat EACCES）——**内容与权限恢复不受影响**（python3.12
23MB rwxr-xr-x 实证，mode 755 由 tar 正常恢复），`tar -m` 消掉噪音与
"tar: had errors"。

⑥ **发现三（exit 回调丢失）**：15:30 解包完成后收尾行缺失、py-stage 未
rename（exit 回调未触发的直接证据）。修复：`healToolchainStage` 残局自愈
（每次 boot 检查 py-stage/python 完整但未归位 → rename+chmod，**免重解 4530
文件**）+ exit 回调加 code/signal diag（可观测）。15:45 实测："检测到未归位
的 py-stage 残局，已补跑收尾" + "无需解包（python=true，git=true）"。

⑦ **发现四（hmfs 元数据全体不可信）**：apk 内 git-remote-https 本是
symlink→git-remote-http，tar 在 hmfs 留"残缺链接占位"（l????????）；
Node 的 statSync/lstatSync/accessSync 对占位**全部返回成功且 mode=0777**
（symlink 固有 x 位）——按元数据判"可执行"永远被骗、补齐逻辑被跳过
（15:52/15:58 两轮 diag 缺失的另一半原因）。最终判据 `isElf()`：
open+read 前 4 字节验 ELF magic——真实数据面，骗不了。

⑧ **发现五（symlink 结论修正）**：hdc（shell uid）对占位 stat/open 全拒，
但 **app（属主 uid）open+read 占位成功且读到真身 ELF**（16:06 boot 的
finalize 亲测）——hmfs 的 symlink 是"透明跟随"实现，属主 execve 跟随到
755 真身 → **git-remote-https 实际可执行、无需补齐**（isElf 防御保留兜底）。
hdc 的 Permission denied 只是跨 uid 观测限制。D6 §4.1.3"沙箱禁 symlink"的
结论限定于其探针场景（mkdir/创建期 EPERM），files 区 tar 场景对属主是
"跟随可用、元数据撒谎"。

⑨ **流程修正**：finalizeToolchain 原只挂"解包 exit / 残局归位"两条路径，
稳态 boot（无需解包）不跑——补齐逻辑两轮没机会执行。稳态路径也补挂
（isElf 判定幂等轻量）。

⑩ **最终地面状态（16:06 boot，全部 hdc 实证）**：PATH 注入 ✓；
bin/ 18 命令全家福（busybox+10 applet、pnpm/npm/npx 假壳、python/python3/
pip3/git wrapper，均 755）✓；toolchain/python 归位（py-stage 已清）✓；
python3.12 23193136B rwxr-xr-x ✓；git 3083800B + git-remote-http 734704B
真身 755 ✓（od 读出 7f 45 4c 46 ELF magic）✓；pythonReady 双锚/gitReady
三锚全真 ✓；DOM 探针与 IN-UPGRADE WebSocket 正常 ✓。

⑪ **门禁**：本轮 node --check + 21 项断言 + dead-code/builder-recursion/
feature-wiring/parity 全绿；main.js 1860→1950 行（helpers/heal/finalize/
fallback 及证据注释），resfile 同步 SHA256 一致。

⑫ **待用户验收（判据不变）**：聊天里让模型跑 `python3 --version` /
`git --version` / `npx -v` / 文件搜索（fs-search 走 rg）。四命令 127 的
布置层根因已消除；命令行为层的最终确认仍需这次实测。


## 批次备注六（2026-09-22 晚：内嵌 Python 桥 Phase 1+2+2.5 真机验收通过）

**装机批次**：entry-default-signed.hap（342.9MB，含 libpython3.12.so.1.0 el1
20.4MB + libpython_runner.so 94KB），真机 <设备序列号>。

① **Phase 1 自检闭环（PASS）**：node-output.log「python 桥自检通过：
print(1+1)=2（37ms），内嵌 CPython 可用」——addon dlopen（DT_NEEDED
libnode.so.137 口径）+ libpython el1 dlopen + Py_Initialize + captureRun
stdout 捕获全链路真机走通。桥日志通道澄清：log()/stage()/DSHM_READY 走
stdout（node-output.log），diag() 走 stderr（dshm-host.log），两文件都要拉。

② **Phase 2 端点（PASS）**：BOOT_62_PY_BRIDGE_HTTP 三端点已注册。
- GET /dshm-python/status → {bridge:true,stdlib:true,ready:true,initialized:true}
- run-get print(1+1) → stdout "2\n" rc="None"；错 token → 401
- exec -c → sys.argv=['python3','-c']（DSHM 口径）；exec -m site → runpy
  完整输出；exec this.py 脚本文件 → Zen of Python；exec -m pip --version
  → pip 26.2.1
- host-ready.json token 落盘（HOME_DIR=files/dsh/home，每次 boot 重写）

③ **真机踩坑（已修，Phase 2.5）**：exec -m pip 冷路径出现过一次卡死——
captureRun 是同步 NAPI 调用，Python 卡多久 node 事件循环就卡多久（status/
dsh web 全挂 4 分钟+，CPU 停滞，只能 force-stop）。复现 3 次（热 import /
冷 import / 冷 runpy pip）均未复现，判定偶发（疑 el2 冷缓存叠加）。**修复**：
每个执行请求注入 SIGALRM（默认 120s，&timeout=1..300 可调），超时 handler
抛 SystemExit(124) 由 captureRun 捕获；请求后统一清 itimer（防 pending
alarm 在下个请求字节码检查点误杀）。真机验证：sleep(999)&timeout=3 →
3.04s 返回 rc="124"，后续请求正常。**这就是 DSHM 不开 -m/pip 的原因**，
我们以 alarm 兜底后开出了该能力。残余风险：单次超长 C 层阻塞调用（无超时
DNS 等）alarm 打不断，已在 ohos-python.md 边界标注。

④ **垫片（代码就位，待用户在 web terminal 验收）**：python3/pip3 wrapper
桥模式回退（token 双源 env→host-ready.json 现读、argv %1f 编码、wget GET、
rc 透传、$(pwd) resolve 修 DSHM cwd 缺陷、pip3 固定 -m pip 前缀）。hdc
shell 无应用沙箱权限（host-ready.json 读不到），全链路只能在应用内 shell
会话验证。用户实测命令：python3 --version / python3 -c "print(1+1)" /
python3 -m json.tool / pip3 --version。

⑤ **门禁**：node --check + assert-python-bridge 65 项 + assert-exec-fix
36 项 + place-host-app 同步 + build SUCCESSFUL；HAP 内 main.js/
ohos-python.md/libpython/libpython_runner 均验证在位。

## 批次备注七（2026-09-22 深夜：Phase 4 fs-search 降级 patch 装机验收）

**动机**：agent 四命令链（read/edit/bash 已通）最后一个实质缺口——rg execve
被拒（exec 探测矩阵 rg=denied，D6/E19 同源）导致 glob/grep 恒 SEARCH_FAILED。
移植 DSHM apply-dsh-ohos-adapt.sh 的 fs-search patch 并做本项目特有增强。

① **实现（pack-core.mjs 新增 patchFsSearchFallback，打包期注入 core 树）**：
三段锚点 patch（tail anchor `\treturn rgPathPromise;\n}` 唯一性 rg -c 验证）：
helpers 五函数（rgExecutable/probeSystemTool/expandBraces/buildFallbackArgv/
grepTextToNdjson）+ spawn 段替换 + 输出段替换（保 {text,lossy} 形状只换 text）。
**本项目特有增强**：rg 平台包已注入（resolveRgPath 成功）但 execve 被拒，DSHM
只覆盖"包缺失"场景——补 `rgExecutable()` 探测（spawn [rg,--version] 一次，
进程内 memoize；abort 竞态不记忆；未来正式签名放开 exec 后自动回 rg 全功能）。
**依赖边界**：目标文件只 import 了 existsSync/parse——DSHM 底本的 statSync/
basename 直接移植会 ReferenceError，已改写为 existsSync / parse(x).base。

② **PC 踩坑两枚（assert 行为测试抓住，未流出到设备）**：
- .mjs 模板字符串转义多一层：`"\\\\n"` 产出源码 `"\\n"`（字面反斜杠+n），
  expandBraces 正则与 NDJSON 换行全废——修正为 `"\\n"`/`\\{`；
- negation 实际形态实证：fs-search 发 `--glob=!**/name`（**DSHM 的 `--glob!`
  分支永不命中**，底本无害 bug），实现改为值级 `!` 前缀过滤（negation 降级忽略，
  且不影响后续首个正 pattern 生效）。
- work 树恢复：patch 污染后（幂等会跳过）从 resfile 旧 zip（2abe22da）用纯
  node zip 解包脚本恢复 fs-search 原文，重跑 patch。

③ **传播链（复用既有机制，无需升版本号）**：同版本重打包 zip（sha256
2abe22da→da6e23a3，66.1MB）→ 拷 resfile → build → hdc install -r → 首启
BundledCore **大小指纹**（.dshm-bundled-stamp）判定换包 → 挪旧树（.stale-*.tmp
异步删，E47 教训）→ 解包落位 → state.current 不变直接用新树。CoreStore
"current 版本拒绝覆盖"只在手动安装路径生效，BundledCore 首启路径先挪后装，
无句柄冲突（dsh 未启动）。

④ **真机验收（<设备序列号>，fport+dshm-python/exec 探针）**：
- boot 全绿：BOOT_10→70，python 桥自检 40ms，三端点注册，DSHM_READY port 3120；
- **换树硬验证**：python exec 读设备 fs-search/lib/index.js → LEN 61353
  （原 56446），buildFallbackArgv/rgExecutable/grepTextToNdjson 各 ×2
  （定义+调用），`await rgExecutable` ×1 —— 新树已激活，patch 全在位；
- **fallback spawn 目标可 exec**：toybox find（`find skills -type f -name
  "*.md"` → 5/5 命中 rc=0）、toybox grep（`grep -Hrn -E -e python skills`
  → 31 行 `path:line:content` 形态，NDJSON 可解析）；
- pip 26.2.1 回归 ✓（-m pip --version）。
- **已知瑕疵（登记不阻塞）**：toybox grep **单文件** + -H 输出前缀为
  `(standard input):N:content`（非文件路径）→ NDJSON path="(standard
  input)"，后续 read 会失败；目录场景（agent 主路径，fs-search root 默认
  workdir）不受影响。DSHM 加 -H 是为修单文件无前缀，本项目 toybox 版本
  （-H 单文件反而显示 standard input）行为不同，罕见路径接受现状。

⑤ **门禁**：node --check + **assert-fs-search-fallback 39 项**（新增：结构
锚点 18 + vm.SourceTextModule 语法 1 + 提取式行为测试 20——纯函数用 new
Function + stub existsSync/parse 验证 argv 转换/花括号展开/NDJSON/探测记忆）
+ assert-exec-fix 36 + assert-python-bridge 65 回归 + build SUCCESSFUL。

⑥ **遗留**：fs-search 端到端（dsh 工具调用链跑 glob/grep）待 D25 turn 修复
后用户 web UI 实测；届时一并验证四命令链闭环（read/edit/bash + glob/grep）。
python3/pip3 垫片全链路实测命令仍待用户执行（批次备注六 ④）。

## 批次备注八（2026-09-23 凌晨：execDiagnostics 拆除 + 体积回收 -52.4MB + 首轮装机事故复盘）

**动机**：E1-E19 实验矩阵结论已定案（execve 按签名域拒绝，Node 重写拿新
inode 救不回），execDiagnostics 每 boot 复跑 5 目标探测+修复实验纯属白写
（E11 append 22MB + E17b copy 20MB，40MB+ IO + 日志噪音）；其唯一剩余
用途——resfile/toolchain/elf/ 裸 ELF 对照素材——一并回收体积。

① **拆除（hostcore/app/main.js 2895→2650 行，-245）**：删 execDiagnostics()
（E1-E19 矩阵）、rewriteFile、rewriteSoTree、realCopy、execDiagDone、
execProbeTargets 的 soDirs 字段；ensureExecutables 简化为"探测+记录"
（5 目标 spawn 结果 push `label=r` 进 diag，**只探测不再修复**）；probeExec
JSDoc 修订（"修复=Node 重写拿新 inode"改为历史否定口径）；RES_ROOT 注释
同步。**保留**：ensureExecutables 两挂载点（顶层块/解包收尾）、"exec 探测：
python3.12=denied，git=denied，…"汇总行（后续签名放开的回归观测点）、
rg wrapper 垫片、python 桥全家、fs-search patch。
**踩坑**：main.js 全文 CRLF（跨行正则需 `\r?\n`）；soDirs 行尾带 ` },`
（对象闭合挂在字段行上，整行 filter 会破语法）；两度从 HAP 内
resources/resfile/resources/app/main.js（build 时快照）恢复误删。
**门禁**：assert-exec-fix 重写为 35 项拆除语义锁（已拆符号全灭 + 不再修复
+ 依据注释在位 + 探测清单/rg 垫片保留）。

② **体积回收（resfile/toolchain/elf/ 整段删除，HAP 327→274.6MB）**：
- 判定依据：elf/ 五件（python3.12 22.1 + libpython 22.1 + rg 4.6 + git 2.9
  + git-remote-http 0.7 = 52.4MB）在拆除后 main.js **零引用**；libpython
  运行时加载走 el1 libs 通道（entry/libs/arm64-v8a，dlopen 只放行 HAP
  libs/<abi>/，E16/E17b 定案），resfile 副本纯冗余；
- place-toolchain.mjs：elf 段（ELF_DEST/python3.12/git/rg 五件放置+统计）
  整体摘除；**保留** untarMembers（el1 libs 段复用）+ python 归档成员
  提取（仅 libpython 一成员）+ el1 libs 段（136-151 独立数据源 pyMembers，
  与 elf/ 段无耦合）；注释改写为历史口径（指向本备注）；
- 删 entry/src/main/resources/resfile/toolchain/elf/ 目录；三套断言
  （35+65+39）零 elf 引用，无需改；build SUCCESSFUL，HAP 274.6MB
  （-52.4MB 精确命中）。
- **place-toolchain 三参 slice 事故（PC 侧，未流出设备）**：edit 后
  untarMembers 内 size 解析落成三参 `raw.slice(off, off+124, off+136)`
  （end=off+124、第三参被忽略）→ size 恒 0 → off 按 512 盲步进 →
  libpython 提取空、place-toolchain exit 1。**read 工具显示两参（歧义），
  node JSON.stringify 字节级检查才见真身**——修复回两参 `slice(off+124,
  off+136)` 并字节级复验。教训与批次备注七 JSDoc 行首空格同源：**read
  显示不可信，落盘内容以 JSON.stringify 为权威；edit 密集表达式后必须
  字节级核对关键行**。

③ **首轮装机事故（place-host-app 漏跑 → 设备跑了拆除前 main.js）**：
- 现象：装机后用户实测 tail dshm-host.log，**本次 boot 段（15:21:43Z）
  仍有"exec 修复/E17c/E19/诊断矩阵 realCopy busybox"全套旧行**——
  拆除"未生效"；
- 根因：本轮门禁链只跑了 place-toolchain，**漏跑 place-host-app.mjs**——
  resfile 里的 main.js 是上一次 place-host-app 的快照（拆除前），
  build 忠实打包了旧文件。hostcore/app/main.js 的源改 NEVER 自动传播，
  必须经 place-host-app 拷入 resfile；
- 修复：补跑 place-host-app（全家桶 6 件就位）→ resfile 鉴定：
  execDiagnostics/"exec 修复" 零命中、"exec 探测" 6 处、2651 行 ✓ →
  三套断言回归全绿 → rebuild SUCCESSFUL；
- **装机未完成**：build 后真机 <设备序列号> 已离线（用户休息拔线），
  新 HAP 在 entry/build/default/outputs/default/entry-default-signed.hap
  待次日装机。
- **教训（门禁链修订）**：place-host-app 与 place-toolchain 同级必跑步骤，
  顺序在断言后、build 前。**已落地防再犯**：新增 tools/assert-resfile-sync.mjs
  （5 件拷贝文件字节级比对 + package.json 语义锁 main=main.js 且无 type
  字段 ⇒ CommonJS），门禁链修订为：node --check → assert-exec-fix →
  assert-python-bridge → assert-fs-search-fallback → **place-host-app →
  assert-resfile-sync** → place-toolchain → build → 装机。快照失同步是
  **静默**的（build/装机/boot 全不报错），此断言把它变成显式 FAIL。

④ **用户实测验收（23:21 版 HAP=旧 main.js+新瘦身，结果仍有效）**：
- **fs-search 降级端到端 ✅（备注七 ⑥ 遗留项核销）**：glob 工具会话工作区
  列出 277 个 .md、grep 工具 README.md 命中 57 处——**"ripgrep launch
  failed"从此消失**（此前 glob/grep 恒 SEARCH_FAILED）。rg→find/grep
  降级链在 dsh 工具调用真实路径上闭环。agent 交叉验证：
  ~/toolchain 下 find 无 .tar.gz 与 glob 工具结果一致（tar.gz 是宿主侧
  解包源，端侧解包后不保留，空结果是**正确**行为）；
- **python3 垫片链路 ✅（备注六 ④ 遗留项部分核销）**：python3 --version →
  Python 3.12.14 (DSHM embedded CPython, in-process bridge)；-c "print(1+1)"
  → 2；-m json.tool 文件参数模式 exit 0。stdin 管道模式不支持（技能边界，
  预期内）；**pip3 --version exit 0 但输出为 Python banner 行，未见
  "pip 26.x" 字样——输出格式疑点登记**，下次实测补 `pip3 list | head`
  判定；
- **日志文件名勘误**：~/n.log 不存在（dshhost.cc 的 n.log 是死路径），
  **真实 stdout 日志是 ~/node-output.log**（DSHM_READY 在第 80 行）；
  diag 双通道文件名以本条为准：node-output.log（log/stage）+
  dshm-host.log（diag）；
- **B00T_ 拼写陷阱**：给 agent 的验证命令里 BOOT_（字母 O）被执行成
  B00T_（数字 0），全库零匹配造成"boot 序列缺失"假象——BOOT_10→70
  序列**状态未知，非失败**，次日对词重验；
- 回归面（与本轮无关的既有遗留如实登记）：write 工作区 EPERM（tmpdir
  link）、workflow WebAssembly is not defined、read_image EACCES
  （/data/storage/el2）——均属 D25 域待修；npx -v ✓（安装队列垫片）；
  git/rg 命令行 126 预期内（execve 策略），**工具链不受影响**（降级生效）。

⑤ **次日验收清单（按序执行，预计 10 分钟）**：
1. 连接真机 → build 产物已在 → start_app（若锁屏：power-shell wakeup +
   uinput -T -m 300 2800 300 600 300 上滑）；
2. PC 侧：hdc fport tcp:3120 tcp:3120 → curl /dshm-python/status 应
  {"ok":true,...,"initialized":true} → curl / 应 401 文案 → fport rm；
3. web UI 让 agent 执行（注意 BOOT 是字母 O）：
   `tail -30 ~/dshm-host.log`——**本次 boot 段应只有一条
   "exec 探测：python3.12=denied，git=denied，git-core/git=denied，
   git-remote-http=denied，rg=denied"汇总行；"exec 修复/exec 诊断/
   E17c/E19/bb-probe"行应全部消失（旧 boot 段的历史行仍在文件里，
   只看最新段）**；
   `grep -E "BOOT_" ~/node-output.log | tail -12`——应见 BOOT_10→70 完整链；
   `grep DSHM_READY ~/node-output.log | tail -1`——port 3120（token 免贴）；
   `pip3 list 2>&1 | head -3`——判定 pip3 输出疑点；
4. 全过 ⇒ Phase 5（拆除+体积回收）验收关闭，遗留仅 D25 域三项。

⑥ **收尾状态（2026-09-23 凌晨，用户休息电脑 2h 后自动关机）**：
- 新 HAP 就绪待装机：entry/build/default/outputs/default/
  entry-default-signed.hap（274.6MB，含拆除后 main.js 2650 行 +
  fs-search patch core zip da6e23a3 + 无 elf/），build 时间在
  place-host-app 之后，快照一致（assert-resfile-sync 6/6 绿）；
- 断言全家桶当前状态：exec-fix 35 / python-bridge 65 / fs-search-fallback
  39 / resfile-sync 6（新）全绿；
- 真机 <设备序列号> 已离线，fport tcp:3120 转发**未清理**（设备拔出
  后转发自动失效，次日重插需重新 fport）；
- 本轮核销：备注七 ⑥ fs-search 端到端（实测通过）、备注六 ④
  python3 垫片链路（实测通过，pip3 输出格式疑点另登记）。

## 批次备注九（2026-09-23 上午：次日验收清单全过，Phase 5 验收关闭 + pip3 --version 疑点修复）

设备 <设备序列号> 重连，按备注八 ⑤ 清单逐条执行：

① **装机与冷启动 ✅**：274.6MB HAP 覆盖安装（保留用户数据）→ force-stop →
aa start 冷启动。BOOT_00→70 完整链（00_NODE_START/10_ENV_READY/20_CORE_FOUND/
30_PROFILE_READY/40_PROFILE_BOOT/50_DSH_INIT/60_HTTP_BIND/62_PY_BRIDGE_HTTP/
65_AUTH_URL/70_HTTP_READY 全部出现，~2s 内完成，jitless=true node=v24.2.0）；
DSHM_READY port=3120 tokenLen=43；python 桥三端点注册；写锁巡检正常
（发现 14 清孤儿 0）。

② **fport + 三端点 ✅**：`/dshm-python/status` → {"ok":true,"bridge":true,
"stdlib":true,"ready":true,"initialized":true,...}；`GET /` → 401 +
"dsh web authentication required" 信任栅栏文案。验收后 fport 已清理。

③ **exec 拆除生效 ✅（本轮核心判据）**：本次 boot 段（02:29:08Z）的
dshm-host.log **只有一条** "exec 探测：python3.12=denied，git=denied，
git-core/git=denied，git-remote-http=denied，rg=denied" 汇总行；
"exec 修复/exec 诊断/E17c/E19/bb-probe/诊断矩阵 realCopy" 行**全部消失**
（15:21:43Z 的旧行是历史 boot 段留档，符合预期）。PATH 注入/CLI 假壳/
工具链 wrapper/rg wrapper/skills 同步全部就位；"工具链：无需解包
（python=true，git=true）"（双锚校验通过，免重解 4530 文件）。

④ **pip3 --version 疑点：根因锁定并修复（本批次唯一代码改动）**：
- **根因**：`pythonBridgeShimLines` 的 `-V|--version` 快速分支对 pipMode
  同样生效——`pip3 --version` 被拦截直接 echo Python banner（上轮实测
  "exit 0 但无 pip 26.x 字样"即此处）；pip 本体无恙（exec 端点
  `-m pip list` → pip 26.2.1 rc=0）。
- **修复**：pipMode 不再生成 `-V|--version` 分支（转发 `-m pip --version`），
  `-h|--help` usage 提示保留。断言 python-bridge 65→**66**（新增
  `...(pipMode ? [] : [` 结构锁）。门禁链完整走：node --check →
  断言全家（66/35/39）→ place-host-app → resfile-sync 6/6 → build
  SUCCESSFUL（16.6s 含 SignHap/SignApp）→ 装机 → 冷启动。
- **验证链**：设备 bin/pip3 静态确认（case 只剩 -h|--help）+ exec 端点
  `-m pip --version` → `pip 26.2.1 from …/site-packages/pip (python 3.12)`
  rc=None。wrapper 的 sh 执行链路由上轮用户实测证明通（banner 输出正是
  旧分支生效的证据），本次为纯减法；shell 侧最终行为待用户下次实测
  顺带确认（`pip3 --version` 应出 pip 26.2.1）。

⑤ **Phase 5（拆除+体积回收）验收关闭**。遗留仅 D25 域三项（write 工作区
EPERM（tmpdir link）/ workflow WebAssembly is not defined / read_image
EACCES（/data/storage/el2）），另：本次 boot 段启动期有一条
`unhandledRejection: ReferenceError: WebAssembly is not defined`
（undici 惰性 llhttp 初始化触发，与 workflow 同属 jitless⇒无 WASM 边界，
不阻塞启动与三端点，归 D25 域一并处置）。

## 批次备注十（2026-09-23 午间：pnpm 假壳"缺少 DSH_HOME"根因修复——bash 子进程 env 白名单）

用户 web UI 实测让模型装插件仍失败：`pnpm(shim): 缺少 DSH_HOME 环境变量
（Host 未注入 PATH 环境）`。相比更早的 127（command not found），这是**前进
一层**：假壳已被 PATH 找到并执行（PATH 注入没问题），撞到假壳自身的运行时
`$DSH_HOME` 读取。

① **根因（上游证据，非猜测）**：dsh-bash-local `spawnSpec`（lib/index.js:209）
构造 bash 工具子进程环境为白名单合并 `{...ENV_OVERRIDES, ...spec.env,
...spec.dshEnv}`——**不 spread Host process.env**。ENV_OVERRIDES 只有
NO_COLOR/TERM/PAGER/GIT_PAGER 四项；PATH 经 `spec.dshEnv`（dsh-tool-bash 的
`ctx.shellEnv.collect`）到达子进程（所以假壳找得到）；而 main.js:751 设置的
`process.env.DSH_HOME` 两头都不沾——**子进程里恒空**。旧报错文案"Host 未注入
PATH 环境"是误导（PATH 与 DSH_HOME 是两回事）。另一个教训：上轮 `npx -v ✓`
没暴露此洞，因为 `-v` 快速分支排在 DSH_HOME 检查**之前**——版本探测不等于
功能路径探测。

② **修复（与 python 垫片同模式）**：CLI_SHIM_LINES / NPX_SHIM_LINES 不再
运行时读 `$DSH_HOME`，改为**生成时写死** `QDIR="${HOME_DIR}/install-queue"`
（HOME_DIR 模块常量，与 Host 轮询目录 main.js:2592 同源）；ensureCliShims
新增 HOME_DIR 空串守卫（不布置，退化为 127 行为）。JSDoc 记入根因与真机证据。

③ **门禁补缺**：原四套断言（python-bridge/exec-fix/fs-search/resfile-sync）
**均未覆盖 CLI 假壳**——门禁覆盖缺口（"通过≠覆盖到"的又一例）。新建
`tools/assert-cli-shim.mjs` **19 项**：队列路径写死×2、DSH_HOME 运行时读取
禁止、误导文案移除、Host 轮询目录同源锁、.req/.done/.fail 投递协议、
-v 快速分支、remove/未知子命令如实报错、npx 装而不执行语义、双守卫。
**负测试先行**：对修复前 main.js 跑出 `FAIL 1`（写死×0≠2）后才改代码，
修后转绿。

④ **门禁链与装机**：node --check → 断言全家（cli-shim 19 新 + python-bridge
66 + exec-fix 35 + fs-search-fallback 39）→ place-host-app → resfile-sync
6/6 → build SUCCESSFUL（24s）→ 覆盖安装 → 冷启动。BOOT_00→70 完整链
（~1.6s），DSHM_READY port=3120 tokenLen=43，/dshm-python/status 全 true，
fport 验收后已清理。

⑤ **设备验证（三层证据）**：
- **静态**：hdc 读 files/bin/{pnpm,npm,npx}——`DSH_HOME_DIR` 零残留，
  QDIR 写死为 `/data/storage/el2/base/haps/entry/files/dsh/home/install-queue`。
- **半行为**：hdc shell 直跑 `sh .../bin/pnpm add is-number` → **"缺少
  DSH_HOME"消失**，输出变为 `can't create .../install-queue/cli-*.req:
  Permission denied` + `pnpm(shim): 队列写入失败：is-number`——路径解析
  正确、逻辑流走到投递写入，仅因 hdc 是 shell uid 被 700 目录拒（权限边界
  本该如此）；`pnpm -v` → `10.0.0 (dshm install-queue shim)` 快速分支正常。
- **app uid 可写实证**：python 桥 exec 端点（Host 进程内，与 bash 子进程同
  uid）对 install-queue 目录 listdir（空，Host 启动时已建好）→ 写探针 →
  读回 ok → 删除，全程成功。bash 子进程写 .req 必成。

⑥ **遗留（同 pip3 模式）**：agent 真转端到端（模型跑 `pnpm add <pkg>` →
假壳投递 → Host 接单下载 → .done 回读输出）各环节已分别实证，串联待用户
下次 web UI 实测顺带确认；届时假壳应输出"已投递安装请求：…"+ 安装结果。
Host installer 接单链路已由更早批次的 ArkUI 设置页入口（ui-*.req）真机
验证过，本次未改动。

## 批次备注十一（2026-09-23 晚：核心 0.1.6→0.1.7-alpha.2→0.1.7-rc.1 三级跳 + WASM 炸点取证）

### 〇 前四轮补记（D27 死锁四层防线 + 桥 fatal，本批未回写，锚点留存）

- **D27 启动死锁四轮根因链**（main.js:2382-2406 全部落地）：①用户 rows 坏行预检
  →②dependencies 逐条预检（整棵依赖树）→③home 层 `$DSH_HOME/cordis.patch.yml`
  坏引用改名隔离（readProfilePatches 每次启动都读，种子覆盖够不着）→④种子
  bundles 预检（resolveBundleDir 先查核心树再查 profile）。**anchorDirs 误杀修正**
  是④的关键：`sanitizeDependencies` 补 `anchorDirs:[CORE_DIR/node_modules]`
  （main.js:2400），只查 profile 侧会洗掉 OPTIONAL_BUNDLES 两行
  （dsh-experimental-agent-team-*，第四轮装机实证误杀）。门禁 84 断言
  （check-user-rows-preflight）全绿后装机，BOOT 链完整，死锁关闭。
- **桥 fatal 崩溃修复**（python_runner.cpp:347-350）：ErrPrint 必须在 GILRelease
  **之前**——释放后再调 CPython API 直接 fatal（真机实证：清 itimer 的 runString
  遇 NameError → ErrPrint 在已释放 GIL 上执行 → 进程暴毙）。prelude 同步防御式
  重写，桥断言 69 项锁行为。
- **调用链坑（设备侧取证工具链）**：PowerShell `[uri]::EscapeDataString` **不转义
  单引号**——桥 code 里单引号必须手工 `%27`，否则远端 /bin/sh 引号栈错乱。
  busybox（files/bin/busybox）对 hdc shell uid 不可执行（Permission denied，
  权限边界本该如此）——桥调用用系统 `/bin/wget`（toybox）即可。

### 一 升级路径选型：删除式，非 switchTo

核心切换机制全图（hostruntime）：E149 同进程二次 `node::Start` 必 SIGABRT
（libnode 单进程设计）⇒ UI 内切换不可行；E151 switchTo 在宿主运行时只写
state.json+"重启生效"；E152 rollback 同理。而 `files/dsh/state.json` **不存在**
⇒ current 恒空 ⇒ Host 永远 `installed[0]` 起核心 ⇒ **删旧树即切换**，零状态写入。
listInstalled 判据（CoreStore.ets:229-247）：跳 `.staging`/`.tmp` 后缀 +
isSafeVersion + isDirectory。

### 二 0.1.7-alpha.2 首跳（2026-09-23 午后装机）

- **删除工艺（flash 慢删实证）**：python 桥直接 `shutil.rmtree`/`os.system rm -rf`
  25k 文件树 → rc=124（桥 run-get 默认 120s SIGALRM 超时）。解法两步：
  ①`os.rename` 成 `.tmp` 后缀（原子瞬间完成，listInstalled 立即视同不存在）
  ②`os.system('rm -rf ...')` 配 `&timeout=300`（run-get 参数 clamp 1..300）后台慢删。
- 装机后 `aa force-stop` + `aa start` → BOOT_10 core=0.1.7-alpha.2 →
  DSHM_READY → 桥 py-ok 3.12.14。设备 cores/ 仅剩一棵树。

### 三 0.1.7-rc.1 二跳（本批主任务，全链验收）

- **npm 取证**：dist-tags = alpha:0.1.7-alpha.2 / latest:0.1.5-rc.3 /
  **next:0.1.7-rc.1**（版本号 `rc.1` 带点）；依赖全 pinned 同版本。
  `@deepseek-ai/dsh-desktop` 不存在（404）——"desktop"即本仓 desktop.ohos.arm64
  变体；npm search 命中的 harness-desktop 是第三方桌面客户端，无关。
- **PC 流水线**：core-recipe.json coreVersion→0.1.7-rc.1 → pack-core 508 包 /
  282 插件行（纯 JS 267 / 原生 5 / 待确认 10 / 默认禁用 17）/ zip 69.1MB
  sha256 e82a0479…/ 签名 47 过 1 未检出（koffi.node，HAP 自编 libkoffi.so 兜底，
  与 alpha.2 同）。resfile **去旧留新**（删 alpha.2 zip 放 rc.1 zip）。
  parseArchiveName（Naming.ets:51-57）前后缀剥离+isSafeVersion 对 `rc.1` 通过。
  断言链 271 项全绿（cli-shim 19 / python-bridge 69 / exec-fix 35 /
  fs-search-fallback 39 / dshm-installer 17 / user-rows-preflight 84 /
  resfile-sync 8）。build SUCCESSFUL（24s）。
- **设备验收**：覆盖安装 → BundledCore 解包 rc.1（大小指纹 stamp 判据，换包必
  生效，E47 教训）→ BOOT_10 core=0.1.7-rc.1（+7ms）→ BOOT_70 全链 → DSHM_READY
  tokenLen=43。桥删 alpha.2 树（rename .tmp + rm -rf timeout=300，RM_RC 0）→
  force-stop 重启 → 唯一树 rc.1 再启 BOOT_10 → DSHM_READY → 桥 py-ok 3.12.14。
  cores/ 终态：`['0.1.7-rc.1']`。

### 四 WASM 炸点取证（未修，良性，rc.1 复现）

- **现象**：每次启动一次 `unhandledRejection: ReferenceError: WebAssembly is
  not defined`（同一 rejection 双行打印），alpha.2 与 rc.1 均复现。栈：
  `lazyllhttp(node:internal/deps/undici/undici:6340) ← client-h1:6429 ←
  client:8123 ← pool:8576 ← agent:8677 ← global.js:8791`——内置 undici 7.10
  惰性加载网络栈级联触发，jitless 模式 libnode 无 WebAssembly。
- **时机与影响**：BOOT_30→BOOT_40 之间 profile-boot 装载期、HTTP 就绪前；
  BOOT_40 仅 +225ms 照常，无插件装载失败，Host/桥/Web UI 全功能正常——良性。
- **根因边界**：设备 Node 24.2.0 / undici 7.10.0 无容错；PC 24.14.1 /
  undici 7.24.4 同 jitless 不炸（7.24 对 WASM 缺失有容错）。三垫片（fetch/
  undici/require-builtin）安装日志全正常；E39 已封 node:http 模块 getter
  （maxHeaderSize/globalAgent/WebSocket/CloseEvent/MessageEvent），globalThis
  级未封——疑 globalThis 级惰性 getter 在 0.1.7 装载期被触碰。api-gateway 用
  `ws` 包 WebSocketServer（服务端，不碰全局 WebSocket）。fetch-shim 已补
  Response/Request/Headers/FormData/Blob/File（:587-592）。
- **决策**：暂不修。内置 undici 随 libnode 固定，与 dsh 版本无关；修法预案
  （E39 扩展至 globalThis 级 / 补 WebSocket 全局）留待它实际咬人时再动。

### 五 门禁改进：fs-search-fallback 路径动态化

assert-fs-search-fallback.mjs:23 曾写死 `dsh-core-0.1.6-alpha.2` 路径——升级后
断言**悄悄测旧树**（绿但无效）。改为读 hostcore/core-recipe.json 的 coreVersion
（唯一事实来源）。教训入库：**"测错对象"比红更危险**——断言绿不等于测对了东西。

### 六 教训：verify_ui 品牌误判（3 次限频用尽，目标作废）

UI 自动化切核心 3 次全败：①应用不在前台；②判定器把 dshclient 自身的
DeepSeek 品牌界面误判为"别的应用"（本应用就叫 DeepSeek，品牌词命中即误报）；
③进「模型」分区后找不到「核心」分区。替代方案：`uitest dumpLayout` 文本取证
（工作区 14 / 会话 11 / 设置 2 / DeepSeek 9——纯文本可 rg，不依赖截图判定）。
截图保存路径必须在 worktree 内（`.ui-shots/`）。

### 七 遗留

- WASM rejection：观察项，见④。
- check-model-roundtrip / check-plugin-toggle 仍写死 0.1.5-rc.2（已知无关失败，
  未列入必跑链）。
- pnpm 假壳端到端串联（模型实测 `pnpm add` → .done 回读）待用户 web UI 顺带
  验证（批次备注十⑥遗留）。

## 批次备注十二（2026-09-24/25：外部报告 1–4 全量落实 + 顶栏改色 + 真机解锁 git/python）

本批由四份外部真机检测报告驱动，全部**从开发端（打包层/核心树）**落实，不依赖任何
手工补丁。总产出：**`exec 探测` 六项全部 `ok`**（此前 `git`/`python3.12`/`rg` 恒 denied）。

```text
最终真机读数（2026-09-24T16:30:40Z，pid 43363）：
  exec 探测：python3.12=ok，git=ok，git-core/git=ok，git-remote-http=ok，rg=ok，bash=ok
  BOOT_70_HTTP_READY GET / → HTTP 401（192ms）
  HAP 276.9 MB（+libpython 22.1MB 与签名后归档）
```

### 〇 一条贯穿全批的判据：**凡 HAP 启动时生成/修复的文件都不持久**

报告点明、本批反复验证：`files/bin/*` 与 `profiles/*/cordis.patch.yml` 每次启动都被
**重建/覆盖**，只有 **core 树**与 **profile 依赖树**里的文件能跨重置存活。
所以本批所有修复的落点只有两个：`tools/pack-core.mjs`（core 树补丁）与
`tools/place-toolchain.mjs`（工具链归档），外加 `hostcore/app/*`（启动期写入逻辑本身）。

### 一 「无法对话」的两层根因（E368 / E368b，最高优先）

用户报 `resume failed for session "session-fa820b87-…"`，前后**两条不同**错误：

| 层 | 报错原文 | 根因 | 修法 |
|---|---|---|---|
| 1 | `flock is not supported on openharmony-arm64` | `node-addon-system/lib/flock.js` 的 `loadBinding()` 平台门只认 `linux`/`darwin`，而端侧 `process.platform === 'openharmony'`（BOOT_00 实证）⇒ **在尝试加载原生件之前就抛** | 非 win/darwin 一律视作 `linux`，命中已由 CMake 自建的 `libsystem.so` 占位包 |
| 2 | `fslmpl.rename is not a function` → `SessionPersistenceCorruptionError` | 早先的 E104「link→rename」补丁 `dshmPublishExclusive` 有**两个调用点**：`index.js:3164` 传 `{access, rename}`（正常），`index.js:2056` 传 `internals.fs`（= `defaultFileSystem`，**既无 access 也无 rename**）⇒ 会话生成迁移路径抛 TypeError | 缺失时**回退到模块顶层从 `node:fs/promises` 导入的实现**，两个调用点都覆盖 |

**教训**：`dshmPublishExclusive` 这类"只被一两个点调用"的补丁，必须**枚举全部调用点**并
检查形参契约——同一个 helper 的两处调用可以传进形状完全不同的对象。上游改这段时
`pack-core` **报错退出**（`die`），不静默跳过。

### 二 顶栏改色：黑底白字 → **白底黑字**（E369，用户当轮决定）

`entry/src/main/ets/pages/WebApp.ets` + `EntryAbility.ets`：
`topBarBgNow()` `#151517`→`#FFFFFF`、`topBarFgNow()`→`#0F1115`、鲸鱼 `fill`→`#151517`、
三键 `COLOR_MODE_DARK`→`COLOR_MODE_LIGHT`。**启动页不动**（用户明确要求它跟随官方形态）。

像素取证（截图采样）：顶栏带 **99% 纯白**（`255,255,255`），左上鲸鱼 `13,13,13`。
另修鲸鱼「歪/未居中」：`viewPort` 用**真实墨迹包围盒**（`-0.2229/-0.0264/23.3967/17.1921`）
而非官方声明盒——官方 `FishLogo` 是 SVG（裁掉溢出墨迹），ArkUI `Shape` **不裁剪**。
尺寸 22→26vp，并按用户指令右移 70% 身位（`FISH_MARK_NUDGE_X = 18.2`）。

### 三 报告 1（环境修复）落实（E370）

| 项 | 落点 | 要点 |
|---|---|---|
| P0 bash 通道 | `main.js` `ensureBashShim()` | **根因**：`BUSYBOX_APPLETS` 里的 `bash`/`hush` 被当作 busybox 副本写出，而端侧 busybox **未编入**这两个 applet ⇒ `bash: applet not found`（exit 127）。已将二者移出清单，改写成**文本垫片**（真 bash → busybox ash → `/system/bin/sh` 逐级探测，`exec` 原样透传参数） |
| P0 垫片 `--dir` 契约 | `CLI_SHIM_LINES` | 解析 `--dir <path>`/`--dir=<path>` 并**优先作为落位目标**（市场 `prefetch()` 的隔离预取靠它）；cwd 为 `/` 或空时按 `host-ready.json` 的 profile 归一化到 `<HOME>/profiles/<profile>`（此前会装到 `/node_modules` → EACCES） |
| P0 市场 profile | `dshm-user-rows.js` `ensureMarketRows()` | `dsh-skin-market` **存在时**才写 `- id: dsh-skin-market / config.profile: <实际 profile>`，包一没就自动删（防坏引用让 profile 起不来） |
| P1 依赖值写请求 spec | `dshm-installer.js` `dependencyValueFor()` | git/GitHub 形态**原样记录**（市场按此串比对来源）、`name@range` 记 range、纯包名才记 `^version`。此前一律 `^version` ⇒ 市场判 `does not match the reviewed source/version` |
| P1 core 补丁上游化 | `pack-core` `patchFsLocalLink()` / `patchAttachmentLocalLink()` | fs-local：`createIfAbsent` 发布 link→rename 回退；attachment-local：两处 `link`→`copyFile(COPYFILE_EXCL)` + 祖先 `syncDirectory` 容错 + 补 `copyFile` 导入 |

### 四 报告 2 落实（E371）

| 项 | 落点 | 要点 |
|---|---|---|
| **P0-1 安装器误杀合法包** | `dshm-user-rows.js` | ① `entryCandidates()`：`exports` 存在但**无根候选**时返回**空数组**，不再回退 `index.js`（`@codemirror/legacy-modes@6.5.4` 是子路径专用包，`exports` 只有 `"./mode/*"`，无 `"."`/`main`）；② `userRowLoadable()`：`candidates.length === 0` **直接通过**，且"**任一**候选可解析即通过"（对齐 Node require 回退语义）。用 6 个真实形态用例回归：`@codemirror/legacy-modes`/`ms`/目录 main **通过**，真半残包**仍拦下** |
| **P0-2 内置终端打不开** | seed profile | `dsh-terminal-bash` 默认 `shellPath=/bin/bash`（鸿蒙 `/bin→/system/bin` 无 bash ⇒ ENOENT），默认 args `--noprofile --norc -i`（busybox ash 不认）。显式给 `shellPath=<files>/bin/bash` + `shellArgs: ['-i']`；`terminal-pwsh` 显式禁用 |
| **P1-1 workflow 必崩** | `pack-core` `patchAgentPresetWorkflow()` + profile | 已实测确认：`--jitless` 下 `stripTypeScriptTypes` 抛 `WebAssembly is not supported … required for TypeScript`（本机 v24.14.1 逐字复现）。**两处都治**：profile 的 id 覆盖（host 面）+ 打包层直接给 `dsh-web-app/presets/*.patch.yml` 加 `disabled: true`（**preset 里那两份副本在 `isolate` 作用域内，profile patch 够不着**——这是本批最反直觉的一条） |
| **P1-2 清理过时覆盖** | seed profile | 删 `tool-bash`（bash 已 `ok`，回归官方默认启用）、`attachment-local`/`file-upload`/`session-controller`/`ui-deliverables`（bring-up 期临时行）。保留 `tool-pwsh`/`pwsh-sandbox`/`open-in-app`/`sandbox-policy`/`web-runtime`/`directory-picker`/`ui-sidebar-browser` |

**顺带查出两个死代码/死配置（报告未提）**：

- profile 里的 `- id: agent-presets / config.default: ondevice` 是**无效行**：Loader 树里没有
  这个 id（提供该服务的行真名是 `agent-preset-registry`，由 `dsh-web-app` 声明、
  `default: standard`），`applyEntryPatches` 对查不到的 id **只 warn 后静默跳过** ⇒
  该行从未生效，实际生效的一直是 `standard`。已删除并注明。
- `pack-core` 的 `addOnDevicePreset()` 找的是**已不存在的旧布局**
  （`dsh-agent-presets/presets/standard/`，现为 `dsh-web-app/presets/*.patch.yml` 平铺）
  ⇒ 一直走"未找到、跳过"分支。已改为如实报告"用官方 shipping preset 集"。

### 五 报告 3 落实（E372）

| 项 | 落点 | 要点 |
|---|---|---|
| **P0-① 用户行加 bundle 门控** | `dshm-installer.js` | 两处 `appendUserRow` 都改为**仅当顶层包声明 `dsh.bundle`/`dsh.bundles`** 才写行（主路径复用原有判断；幂等分支从已落位 manifest 现读）。此前装 `semver` 这类纯库也会写 `- id: semver`（cordis 无对应条目，纯污染）。样本核对：核心树 277 包中**仅 8 个**声明 `dsh.bundle`，判据可靠 |
| **P0-② 异常 handler 过滤 + 合并** | `main.js` | ① 新增 `isKnownJitlessUndiciNoise()` 识别 `WebAssembly is not defined` + `lazyllhttp|internal/deps/undici`，降级为**一行**说明；② **删掉文件末尾重复的 `uncaughtException`/`unhandledRejection` 监听器**（原先各注册两次，同一事件打两遍） |
| P1-③ 解包执行位 | `main.js` `ensureCoreExecBits()` | 补 `rg` 与 `sharp-openharmony-arm64.node` 的 x 位（`@ohos.zlib.decompressFile` 不保留权限位）。沿用工具链那套「**缺了才补**」纪律 |
| P2-④ `process.execPath` 兜底 | `main.js` `installExecPathSpawnGuard()` | 拦截 `spawn`/`execFile`/`spawnSync`/`execFileSync` 在 **`file === process.execPath`** 时同步抛 `EPERM` + 明确文案；`DSHM_ALLOW_EXECPATH_SPAWN=1` 可放行。**精确匹配**是刻意的：核心树 8 处 `execPath` 用法多是读值，且 `dsh-subagent-spawn-in-process` 完全不碰 `child_process`（这正是 subagent 在端侧正常工作的原因）。本机实测三态：拦 execPath=PASS、放行其它路径=PASS、放行裸名=PASS |
| 附带 PATH 卫生 | `main.js` | 注入时去重 + 剔除**确认不存在**的目录。设备实测从 `<bin>:/data/app/bin:/data/service/hnp/bin:/data/app/bin:/data/service/hnp/bin:…`（`/data/app/bin` 来自系统预置且不存在、且重复两次）变为 `<bin>:/data/service/hnp/bin:/bin:/usr/bin:/system/bin` |

### 六 报告 4 落实（E373，三项；③ 是主战役）

**① stack 只读保护（P0）** —— `pack-core` `patchAppBootReadonlyStack()`，给 **4 处**赋值包
try/catch（`dsh-app-boot/lib/index.js` ×2、`lib/worker/profile-resolution-bootstrap.js` ×2）。
根因：Node 24 解析器错误的 `message`/`stack` 可能是**只读访问器**，裸赋值抛 TypeError 会
**顶替掉带 `code` 的原错误** ⇒ 下游 `missingResource()` 靠 code 匹配失败 ⇒ UI 报"包元信息错误"。
包一层只为**保住原错误对象**。设备验证：两个文件各 4 处标记到位。

**② 重启 → 整机冷启动（P1，三段）** ——

- Host 侧：`installExecPathSpawnGuard` 增加 **relaunch 形态识别**
  （`args[0] === '-e'` 且脚本含 `waitForParent`）→ 转 `requestAppRestart()`，返回 stub child；
  其余 self-exe 照旧拒绝。
- 文件通道：`requestAppRestart` **先写** `$DSH_HOME/host-exit-mode = app-restart` **再**调用
  `requestStop()`（顺序关键：ArkTS 靠该文件区分"重启"与"仅停服务"）。
- ArkTS 侧：`EntryAbility.startRestartWatcher()` 轮询该文件 → 清标记 → `appRecovery.restartApp()`
  （官方冷启动 API，SDK `@ohos.app.ability.appRecovery.d.ts` since 9）。模块级标志防多窗重复挂；
  注意平台**限流**"两次重启须间隔 > 1 分钟"，1 分钟内重复调用只退出不重启（如实记日志，不假装成功）。

**③ 工具链签名补全（P1，本批最大工程）** —— 目标：解锁 `git`/`python3.12` 真身。

先做了**决定性实验推翻旧假设**：把 `rg` 字节由宿主进程物化到 `bin/rg-real`
（与可用的 busybox 同目录、**同创建者**），期望复现"本进程创建即可执行"——

```text
exec 探测：… rg=denied，rg-real=denied，bash=ok
```

**两处都 denied**，否定了文档 §3 时代"执行许可绑创建者"的说法。真正的分界是
**ELF 与脚本**：`bash` 垫片能跑是因为它是 `#!/system/bin/sh` 脚本（内核 exec 的是**系统**
二进制 `/system/bin/sh`，脚本只作参数传入）；而第三方 ELF 的 execve 由**签名域策略**拒绝
（与创建者/inode/权限位无关）。物化路径已撤销，结论写进 `ensureRipgrepWrapper` 注释。

**签名解法**：`binary-sign-tool sign -mode localSign -selfSign 1` 走 SelfSignSignProvider，
只加 `.codesign` 段并用描述符摘要当签名，**跳过 .profile/.permission 与证书链写入** ⇒
**不需要 keystore 密码**（本机实测 exit 0、`.codesign` 段 4096B、`display-sign` 回读
`code signature is self-sign`）。

**三个踩坑（都写进代码注释）**：

1. **签名步骤的位置**：最初放在 `replaceKoffiJs()` 之后，被后续 `ensureRipgrepPlatformPackage()`
   （会重写 rg）**覆盖**——磁盘上的 rg 又变回未签名。签名对象是"最终进 zip 的字节"，必须
   放在 `embedProfile()` 之后、`pack()` 之前。
2. **HAP 打包丢弃所有 dotfile**：标记最初用 `.dshm-signed`，实测打包产物中"以点开头的条目数
   为 **0**" ⇒ 端侧读不到标记 ⇒ 换代判定永不触发 ⇒ 新签名归档**永远不被解包**。改名
   `dshm-signed.txt`。
3. **Windows 上改写 tar 归档的正确姿势**：python 归档与 git apk 里都有 **symlink 条目**
   （`python/bin/python` → `python3.12`、git-core 里 180+ 个指向 git 本体）。
   `bsdtar` 无符号链接特权时每条报 `Can't create … Invalid argument` **且条目丢失**
   （会把归档永久改坏）；`7z` 会把 symlink **物化**成副本（git-core 从 8MB → 1.3GB）。
   **正解**：新增 `tools/sign-tar-elf.py`，用 Python `tarfile` 逐条目搬运——symlink 仍是
   symlink 条目（不落盘、不需特权），只对 ELF **普通文件**落盘签名后写回。

**另加"归档换代即重解"**：设备侧解包判据是"存在即跳过"（`gitReady()`/`pythonReady()` 只看
文件在不在），不改造它则新签名归档永远不解开——这正是报告里"git mtime 仍是 09-22"的成因。
现在构建期写 `dshm-signed.txt`，端侧比对"归档标记 vs 解包目录标记"，不一致则强制重解。

**成果**：签名 **35 个 ELF**（python 10 + git 25），体积几乎不变（python 27.3→26.4MB）。
设备实测（含冷重启复核）：

```text
16:25:36  工具链：python/git 归档已换代（dshm-signed.txt 变化），强制重解以取到已签名的 ELF
16:25:39  工具链：解包收尾 python=OK，git=OK
16:25:41  exec 探测：python3.12=ok，git=ok，git-core/git=ok，git-remote-http=ok，rg=ok，bash=ok
16:27:49  工具链：无需解包（python=true，git=true）   ← 冷重启后不再重解（标记生效）
16:27:50  exec 探测：python3.12=ok，git=ok，git-core/git=ok，git-remote-http=ok，rg=ok，bash=ok
```

### 七 本批的教训（可复用）

| 教训 | 说明 |
|---|---|
| **同一个 helper 的不同调用点可以传进形状完全不同的实参** | `dshmPublishExclusive`：一处传 `{access,rename}`，一处传只有 6 个方法的 `defaultFileSystem`。补丁要枚举全部调用点核对形参契约 |
| **"写在文档里的结论"要能被真机实验推翻** | 「执行许可绑创建者」是 §3 时代的记录，本轮设计对照实验（物化到同目录同创建者）直接否定它。**结论要带实验条件，条件变了要重验** |
| **"存在即跳过"的缓存判据必须配版本标记** | 否则任何只在构建期改变的产物（签名、补丁）在设备上**永远不会生效**，而现象是"什么都没发生"（极难查） |
| **工具的静默跳过比报错危险** | `addOnDevicePreset` 找不到目录→跳过；`agent-presets` id 不存在→warn 后跳过。两者都导致"写了却没人读"。本批把 preset 补丁改成"一个文件都没改到就 `die`" |
| **平台层的"拒绝"要先用对照实验定性** | execve 拒绝：补执行位（×）、换创建者（×）、签名（√）。三次实验才定位，前两次都基于当时的合理假设 |
| **Windows 上处理带 symlink 的 tar 归档** | 只有 Python `tarfile` 可靠；`bsdtar` 会丢条目、`7z` 会物化。这是工具链签名的关键前置知识 |

### 八 遗留（交下轮）

1. **② 端到端**：冷启动通道需在 UI 里点市场的"重启"按钮触发一次（Host 侧守卫与 ArkTS
   侧代码均已就位并通过编译，缺一次端到端留痕）。
2. **① 验收**：语音输入页"包元信息错误"红字是否消失，需 UI 复核（报告口径）。
3. **语音本地识别（SenseVoice）**：UI 红字由 ① 解决，但功能仍缺 `sherpa-onnx-node` 的
   openharmony-arm64 原生件（需自建 + 签名）+ 把 openharmony-arm64 加入 `resolveRuntime()`
   白名单。报告建议**端侧先默认禁用该实验 bundle**——尚未执行。
4. **`git clone` 端到端**：`git-remote-http` 已 `ok`，但完整 clone（含 TLS、重定向、
   凭据）未在真机跑过一次。
5. **报告 §4 ACL 清单**（公共目录直读写、后台常驻/自启）：需改 `module.json5` 的
   `requestPermissions`，属独立决策，未动。
6. 本批新增宿主依赖：**构建期需要宿主 `python3`**（`tools/sign-tar-elf.py`），
   `place-toolchain` 检测不到时会告警跳过签名（归档仍可用，只是真身继续被拒）。
7. DevEco 环境提醒：`D:\.gitignore` 未覆盖 `dist/toolchain-pristine/`（本批新增的
   原始归档备份，35.4MB），若不需要可清理。
8. modlens：**已按用户指示不再跟踪**（用户已自行卸载该插件；本批曾按其要求写了默认禁用
   注入，发现注入时机在预检之后、卸载后会反向生成"指向不存在包的坏行"的真 bug，
   已完整撤除且未构建进任何 HAP）。

## 批次备注十三（2026-09-25：报告 5 三项落实 —— &path: 子目录皮肤 / 状态栏跟随外观 / git 子进程解锁）

本批对应外部报告 5。三项全部从**开发端**落实并装机验证。**上一批的六项 exec 全 `ok`
零回归**（见下表基线）。

```text
最终真机读数（2026-09-25T00:02:09Z，pid 9516）：
  exec 探测：python3.12=ok，git=ok，git-core/git=ok，git-remote-http=ok，rg=ok，bash=ok
             git-ls-remote=ok                    ← 本批新增的判决性探针
  BOOT_70_HTTP_READY
  无 git-upload-pack: inaccessible（上一版有此报错，本版消失）
```

### 〇 一条贯穿判断：**"能跑"与"跑通"是两件事**

报告 5 §2.3 的验收目标是"git clone/fetch/pull/push 可用或给出明确不可用提示"。
本批在这条线上**连续修了两层**，且第二层是第一层修好后**才浮现**的：

| 层 | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | `rc=134`（SIGABRT），`BUG: run-command.c:525: disabling cancellation: Operation not permitted` | git `atfork_prepare()` 用 `CHECK_BUG(pthread_setcancelstate(...))`——"不该失败"的自检；鸿蒙 musl 判其失败 ⇒ `BUG()` → abort | `libdshm-gitcompat.so`（LD_PRELOAD）把该调用改判成功 |
| 2 | 垫片生效后：`git-upload-pack: inaccessible or not found` | `git-core/` 下 **141 个 symlink**（138 个指向 `../../bin/git`）在 hmfs 上**解不出来** ⇒ 子命令辅助程序一个都不存在 | 从 apk 读 symlink 表 → 用**真身拷贝**补齐 |

**教训**：只按报错改一层，会在下一层再撞一次。凡"某功能整条链不可用"，先把链上
**每一步**都列出来（起进程 → 找辅助程序 → 连远端 → 认证），逐层验，别指望一改到底。

### 一 §2.1【P0】皮肤 `&path:`（monorepo 子目录）—— 已闭环

**规模**：报告称 catalog 302 个皮肤中 36 个用 `&path:` 子目录目标。

**根因**（报告诊断准确）：`parseGitHub()` **先按 `#` 切分**，把 `&path:/maid-atelier`
并进 ref ⇒ codeload URL 变成 `…/tar.gz/<commit>&path:/maid-atelier` ⇒ HTTP 404（真机原文）；
且解包后没有"进子目录取包"的逻辑。

**修法**（`hostcore/app/dshm-installer.js` 两处）：
1. **解析**：不按位置切，而是各自用正则**从整串摘出**——`[&?]path[:=]([^#&?\s]*)` 与
   `#<ref>`（取到下一个分隔符为止）。**两种先后顺序都兼容**（市场数据里都出现过）。
   返回 `{kind, owner, repo, ref, subpath}`。
2. **解包取包根**：`Resolved.subpath` 非空时，以 `soleDir + subpath` 为包根，再读该目录的
   `package.json`（包名/版本/`dsh.bundle` 全部取自子目录）。

**踩到一个真实坑（记下来）**：最初用 `realRoot` 作基准拼 subpath，而 codeload 的 tarball
恒有一层 `<repo>-<ref>/` **外壳目录**，且该外壳**没有 `package.json`** ⇒ 上面那段
"唯一顶层目录且含 package.json"的判断不会把 `realRoot` 推进去 ⇒ 拼出
`tmp/maid-atelier`（不存在），报 "试过 …\Small-tailqwq--dsh-deep-whale-…\maid-atelier"。
改为以 **soleDir**（唯一顶层目录，不要求含 package.json）为基准后通过。

**验证**：
- 解析：8 个用例全过（市场原文形态 `#ref&path:/x`、`&path:/x#ref`、无 subpath、多级子目录、
  npm 名不误判为 GitHub）；
- 真实数据：下载 `Small-tailqwq/dsh-deep-whale` tarball（32MB / 283 文件），确认**根目录
  无 package.json**（monorepo），`maid-atelier/`、`orca-link/` 各有包（`dsh.bundle=true`）；
- 端到端：两个皮肤安装均 `ok=true`，包名正确（`@smalltailqwq/dsh-client-ui-skin-maid-atelier`
  / `-orca-link`），用户行与 `dependencies` 都正确记录带 `&path:` 的 spec；
- **回归**：普通 GitHub 皮肤（denia，无 subpath）安装仍 `ok=true`。

### 二 §2.2【P1】状态栏跟随「设置→外观」—— 已实现

**做法**（报告推荐的 ArkTS 方案，主通道 + 兜底）：
- **web 侧** `THEME_SHIM_JS`（`javaScriptOnDocumentStart` 注入）：读官方锚点
  `getComputedStyle(documentElement).colorScheme`——比 body 背景色更权威（**皮肤会改 body
  底色，但 color-scheme 是浏览器级语义**）；`matchMedia('(prefers-color-scheme: dark)')`
  覆盖"系统里切深浅"，`MutationObserver(documentElement)` 覆盖"应用内切外观"；两处
  初始 `setTimeout`（60ms/1200ms）+ `DOMContentLoaded` 兜首次。
- **ArkTS 侧** `DshThemeBridge`（`javaScriptProxy` 同步回传，methodList `onThemeMode`）
  → `applySystemBarTheme(mode)`：`setWindowSystemBarProperties({statusBarColor,
  statusBarContentColor, isStatusBarLightIcon})`，并**同色** `setWindowBackgroundColor`
  **消除切换闪白**（报告明确要求）；自绘顶栏/鲸鱼色/三键 colorMode 一并跟随，保证不会
  "一半白一半黑"。
- **兜底**：10s 的 DOM 探针也调同一个 `applySystemBarTheme`（桥万一没装上也能收敛）；
  两者共用幂等闸门 `systemBarApplied`，不会来回抖动。

**踩到两个坑**：
1. **模板串里的 markdown 反引号会截断 ArkTS 模板字面量** —— 我在 JS 注释里写了
   `` `last` ``，ArkTS 把那个反引号当成模板串结束符 ⇒ 编译报
   `';' expected. At WebApp.ets:276:9`。**注入脚本的注释里不能出现反引号**。
2. **`(void)force;` 在注入脚本里是语法错误**（`void` 缺操作数）—— 我最初写了个
   `force` 参数想让"首次必定上报"，改了三次才收敛成"只按 last 判"（首个定时器若
   `color-scheme` 未写入返回 `''` 被拦下，`last` 仍是空，第二个定时器自然补报——
   **不需要 force**）。

**验证**：shim 语法 + 行为单测通过（`light → dark → light` 各报一次；重复触发无新增）。

### 三 §2.3【P1】git 子进程类操作 —— 已解锁（第一层用垫片，未重编 git）

**先定位了精确失败点**，发现报告建议的重编并非唯一路径：
`run-command.c` 的 `atfork_prepare()` 里

```c
CHECK_BUG(pthread_sigmask(SIG_SETMASK, &all, &as->old), "blocking all signals");
CHECK_BUG(pthread_setcancelstate(PTHREAD_CANCEL_DISABLE, &as->cs), "disabling cancellation");
```

`CHECK_BUG` = "这个调用不该失败"，失败即 `BUG()`（abort）。**不是 git 用法错，是平台
libc 缺这一块能力**。而 git 是**动态链接的 PIE**（`DT_NEEDED libc.musl-aarch64.so.1`，
用系统 musl、我们没随包带 libc）⇒ 重编要配整套 Alpine musl 交叉工具链。

**做法**：新增 `entry/src/main/cpp/gitcompat.c` → `libdshm-gitcompat.so`（已编进 HAP）。
- 口径是**透明优先**：先调 libc 真身，**真身成功就原样成功**；只在真身缺失或返回非 0 时
  改判成功（真 Linux 上完全透明，不掩盖真实错误）。
- 同时接管 `pthread_sigmask`（同一个 CHECK_BUG 块的另一半）——**一起兜**才不会"修好
  前者又炸在后者"。
- `DT_NEEDED` 仅 `libc.so`（实测），不带 libnode（LD_PRELOAD 的库若拉几十 MB 依赖会污染
  git 进程）。
- wrapper 对子进程类子命令（clone/fetch/pull/push/ls-remote/remote/submodule/worktree/
  archive/gc/repack/prune/fsck）`LD_PRELOAD` 该库；**同时补了报告 §2.3 末尾提到的
  `GIT_TEMPLATE_DIR`**；垫片不存在时给**明确不可用提示**，不再让用户吃 rc=134 core dump。

**第二层（本批附带发现）**：垫片生效后 stderr 变成
`git-upload-pack: inaccessible or not found` —— 说明 abort 那关过了，但**辅助程序缺失**。
查证：`usr/libexec/git-core/` 下 **141 个 symlink**（138 → `../../bin/git`，3 → `git-remote-http`），
hmfs 解不出 symlink ⇒ 一个都不存在。原先的 `GIT_SYMLINK_REPLICA` **只硬编码了一条**
（`git-remote-https`），覆盖不到。
改为 `readGitCoreSymlinks()`：**从本版 git 的 apk 归档直接读 symlink 表**（纯 JS 扫 tar 头，
不解包），按需以真身拷贝补齐——名字永远与这一版 git 一致，不会因升级静默失效；读不到时
退回原来那一条。

**判决性验收锚点**：`execProbeTargets()` 新增 `git-ls-remote` 探测——`git ls-remote
file://<本地裸仓库>`。它会走 `start_command()`（即那两处 CHECK_BUG），但**不需要网络**，
是最小、可重复、不受外部服务波动影响的判据。每次启动自动产出机器可读结论。

**验证**（三层证据）：
1. `libdshm-gitcompat.so` 编进 HAP（2472B→5472B 实测、导出 `pthread_setcancelstate`/
   `pthread_sigmask`、`DT_NEEDED` 仅 libc）；
2. **`git-ls-remote=ok`**（真机）；
3. **`git-upload-pack: inaccessible` 报错消失**（上一版有、本版无）——symlink 补齐的直接表现。

### 四 本批的教训（可复用）

| 教训 | 说明 |
|---|---|
| **"某功能整条链不可用"要逐层验，别指望一改到底** | git 子进程：先 abort（垫片）、后缺辅助程序（symlink）。第二层是第一层修好后**才浮现**的 |
| **注入到 web 的脚本，注释里不能出现反引号** | ArkTS 模板字面量用 `` ` `` 定界，注释里的反引号会截断它 ⇒ 编译期报错、且位置误导（指向注释行） |
| **"不按位置切分"比"规定顺序"稳** | `&path:` 与 `#ref` 两种顺序都出现过；用正则各自摘出，比"先切 A 再切 B"少一半失败模式 |
| **硬编码的清单会在升级时静默失效** | `GIT_SYMLINK_REPLICA` 只有 1 条而实际 141 条；改为从归档现读 |
| **平台 libc 的"缺能力"可以用 LD_PRELOAD 兜，不必重编** | 前提是目标程序**动态链接**（git 是 PIE）；静态链接就只能重编 |
| **透明优先的垫片口径** | 先调真身、成功就透传——这让垫片在正常平台上是 no-op，不会掩盖真实错误 |

### 五 遗留（交下轮）

1. **§2.2 验收**：外观切浅色/深色/跟随系统 → 状态栏即时跟随，需 UI 确认。
2. **§2.3 真远端**：`git-ls-remote`（本地 file://）已 ok；**真网络 clone（HTTPS + TLS +
   重定向 + 凭据）未跑过**。建议在会话里让模型 `git clone` 一个小公开仓库。
3. **报告 §2.4**（`host-restart-request` 文件通道）与 **§2.5**（语音本地识别）标注为
   **可选**，本批未做。
4. **报告 §5 ACL 清单**（公共目录直读写、后台常驻/自启）：需改 `module.json5` 的
   `requestPermissions`，属独立决策，未动。
5. 报告 §4/§6 无需处理（隔离残留已有 7 天回收；内存与 App 无关）。
6. 上一批遗留仍在：② 重启冷启动端到端、① 语音页红字 UI 复核。

## 批次备注十四（2026-09-25：报告 8 两项待修 —— &path: 卸载残留行 / 语音 bundle 移除）

报告 8 确认批次十三的**假壳三件套、插件市场安装、&path: 安装、git 全链路（含真 clone）、
状态栏跟随**均已通过；只剩两项待修。本批把这两项修透，并回答了报告 §3 悬而未决的
"那只鲸鱼到底在哪"。

### 一 一条贯穿教训：**修了症状 ≠ 修了根因，要有"验证到根"的动作**

报告 7 §2 与报告 8 §1 是**同一个 bug**，我上一批"修过"，报告作者复测仍复现。
原因是我只修了**一半**：

| 层 | 问题 | 我上批做了吗 |
|---|---|---|
| ① 名字来源 | 卸载用 spec 名，实际行名是子目录 manifest 的 name | ✅ 做了（候选名集合） |
| ② **引号** | `composeUserRows` 回写成 `- id: 'name'`，比较用裸名 ⇒ **永不等** | ❌ **漏了** |

**只有 ② 才是真正让行删不掉的那道门**：即便候选名对了，`m[1] === name` 里 `m[1]` 带引号，
比较永远为假。这解释了报告观测到的精确现象——包与依赖都删了（那两处用裸名集合，不受
引号影响），**唯独行留着**。

> **可复用通则**：当"修过但仍复现"时，不要重做同一个修法，而要**问"这条链上还有几个
> 判据"**。写盘-读盘经过一次序列化（YAML/JSON）时，序列化会**改变字面量**（引号、
> 转义、换行）——凡"写进去的和读出来的不是同一串"的地方都要单独验。

### 二 §1【P1】`&path:` 卸载残留用户行 —— 已修透（五场景验证）

三处改动（`hostcore/app/dshm-installer.js`）：

1. **`removeRowBlockById` 剥引号比较**（治本，见上表 ②）；
2. **新增 `removeRowBlockByIdSuffix`**：`&path:` 皮肤的真实包名带 scope 前缀
   （`@dsh-external/dsh-client-ui-skin-maid-atelier`），而 scope 只存在于仓库 manifest 里——
   `node_modules` 已删、依赖已清时**永远推不出完整名**。用**后缀匹配**（前一个字符必须是
   `-`/`/`/`@` 之一，避免 `link` 误删 `orca-link`）兜住"包与依赖都不在了"的残局；
3. **`cordis.patch.yml` 清理**改正则 + 同一套引号/后缀口径（此前只处理了两种引号写法）。

**五场景验证**（用真实 `removeSpec`，非手抄逻辑）：

| 场景 | 结果 |
|---|---|
| A 依赖在 + 行带引号 | 行清空 ✓ |
| B **报告实测残局**（依赖 0、包已删、行带引号还在） | 行清空 ✓ ← 上一批漏的正是这个 |
| C 不误伤（`dsh-better-sidebar`、`@x/orca-link` 必须留下） | ✓ |
| D **反向不串味**（装 `orca-link` 不误删 `maid-atelier`） | ✓ |
| E npm 包回归（`is-number@7.0.0`） | 行清空 + 包删除 ✓ |

### 三 §2【P1】语音输入 —— 从 **profile bundles 移除**（治本，非补洞）

**上一批我修错了位置**：只在种子 `cordis.patch.yml` 里禁了 4 个插件的行。报告 8 指出
`package.json` 的 `bundles` 里**仍然**有 `…dsh-experimental-voice-input-bundle`
——禁行只是"在半条链上补洞"，bundle 本身还在。

**真根因在 `main.js` 的 profile 合并**：

```js
const merged = new Set((cur.dsh.profile.bundles || []).concat(seed.dsh.profile.bundles || []));
```

**只做并集、从不移除** ⇒ 任何进入过设备 profile 的 bundle **再也去不掉**（种子删了也被加回来）。
这正是报告观测到的现象。

**修法**：引入**显式移除清单** `dsh.profile.removeBundles`（写在种子 package.json），
合并口径改为 **「种子顺序并集 − 移除清单」**：
- 尊重用户自加 bundle（插件页启停是产品能力，不能"完全以种子为准"）；
- 又能表达"这一版我们确定不要它"，且上游加回来/用户曾启用过都能清掉。

**五场景验证**：报告实测态（设备有 voice）→ 移除 ✓；用户自加 bundle 保留 ✓；种子顺序稳定 ✓；
空设备侧 ✓；重复项去重 ✓。**真机读数**：
`[dshm-host] profile bundles 已移除（按种子 removeBundles 清单）：@deepseek-ai/dsh-experimental-voice-input-bundle`

**两层都保留**：bundle 移除（治本）+ 4 行 disable（防"core 里被别的路径拉起"）。
四个插件包仍在 core（可用，只是不挂载），符合报告"搞不定就不管、也不用隐藏"的口径。

### 四 §3【P1】鲸鱼"不随主题" —— 报告悬置的问题已确答：**在 ArkTS 自绘顶栏**

报告 §3/§4 两次说"需要开发端确认这只鲸鱼的确切位置"。**现已确答**：
ArkTS 侧**只有一个**自绘品牌标识 —— `WebApp.ets` 的 `@Builder FishMark`（顶栏左上角）。
（`entry/src/main/ets` 全量搜索结果：`FISH_LOGO_PATH` 仅此一处渲染；启动画面的
`app.media.logo_dark` 是**位图**、在启动页，与顶栏无关——且用户明确要求不改启动画面。）

**真根因（上一批已修）**：`systemBarApplied` 是**普通 private 字段**，而 `fishMarkColor()`
读它 ⇒ **改它不触发重渲染**。顶栏底色 `topBarBg` 是 `@State` 所以跟着变，唯独鲸鱼纹丝不动
——**这正是"状态栏变了、鲸鱼没变"的典型症状**。已改为 `@State themeMode`。

**规格对齐状态**：

| 维度 | 报告规格 | 当前 | 说明 |
|---|---|---|---|
| 主题跟随 | 浅色→深鲸 / 深色→白鲸 | ✅ 同状态栏信号 | 已修 |
| `translateY(1px)` 光学微调 | 1px | ✅ `FISH_MARK_OPTICAL_Y` | 已做 |
| 非等比拉伸 | 禁止 | ✅ viewPort 用墨迹包围盒，比例恒定 | 已满足 |
| 几何来源 | 官方 `FISH_LOGO_PATH` | ✅ 逐字节取自 primitives | 已满足 |
| 宽度 | 24vp | **26vp** | ⚠ 与用户先前指令冲突（见下） |
| 与文字间距 | 8vp | right:10 | ⚠ 同上 |
| 水平位置 | 居中 | 右移 18.2vp | ⚠ 同上 |

**未决点（等用户裁决）**：报告规格（24vp / 居中 / 间距 8vp）与**用户先前明确指令**
（"往右挪 70% 小鲸鱼的身位" = 26vp 基准下右移 18.2vp）冲突。已向用户提出 A/B/C 三选，
**未擅自覆盖用户指令**。

### 五 本批新增的可复用通则

| 通则 | 说明 |
|---|---|
| **"修过仍复现"要问"链上还有几个判据"，别重做同一个修法** | 报告 7→8 同一 bug 复现，因为我只修了名字来源、漏了引号 |
| **序列化会改字面量**：凡"写进去的和读出来的不是同一串"的地方都要单独验 | YAML 自动加引号 ⇒ `m[1] === name` 永假；这是"包删了行还在"的真凶 |
| **只做并集的合并逻辑会变成"永久沉积累"** | `bundles` 的 `cur ∪ seed` 让任何 bundle 一旦进入就再也去不掉 |
| **修"半条链"（禁行）不等于修根因（移除 bundle）** | 要问"这个东西还能从哪里被挂起来" |

### 六 遗留（交下轮）

1. **§3 鲸鱼尺寸/位置**：等用户在 A（保持 26vp+右移）/ B（按报告 24vp+居中）/ C（折中）中裁决。
2. **报告 §4**（`host-restart-request` 文件通道）标注为可选，未做。
3. 报告 §5 ACL 清单需改 `module.json5`，属独立决策，未动。
4. 多版本共存的 `removeBundles`：本批只在"当前 profile"生效；若将来做核心回滚，
   旧版本 core 的种子 profile 无该键 ⇒ 回滚后 voice bundle 会回来（**已知边界，未处理**）。

## 批次备注十五（2026-09-25：插件"重启生效"不可用的两个根因 —— 重启助手判据 + 登记落点）

**触发场景**（用户实测）：装 `billion-context@0.1.147`（bundle 型插件）成功，
`dependencies` 与 `dsh.profile.bundles` 都有它，但**重启后插件不生效**
（boot 图里 `billion-context` / `bili-native` 计数为 0），市场 toggle 还报
`no loader entry matched`。

**诊断结论（关键）**：**插件没装坏——是那次"重启"根本没发生。**
时间线（用户提供的本地时间）：

| 时刻 | 事件 |
|---|---|
| 09:04:24 | 安装成功（`hot=false`，提示需重启） |
| 09:04:28 | 市场尝试重启 → **被 execPath 兜底拒绝** |
| 09:04:37 | 有一次启动（pid 22702）——**但此时 bundle 还没登记** |
| 09:06:27 | 市场启用流程把 billion-context 补进 `dsh.profile.bundles` |
| 09:06:31 | 市场再次尝试重启 → **又被拒绝** |
| 之后 | 再无启动（`host-ready.json` 停在 09:04:37） |

⇒ bundle 是在**最后一次启动之后**才登记的，而那次"重启"被拦掉 ⇒ 运行中的宿主里自然没有它。
我在设备日志里找到了那两次拒绝的**直接证据**：
```
[2026-09-25T01:04:28.455Z] execPath spawn 兜底：已拦截 spawn(process.execPath)
[2026-09-25T01:06:31.275Z] execPath spawn 兜底：已拦截 spawn(process.execPath)
```
（与用户时间线逐秒吻合。）

### 一 根因一：重启助手判据太窄（只认 dsh 自己的助手）

- **现象**：市场的"重启"按钮在端侧**无效**。
- **根因**：`dshmarket/lib/restart.js` 用
  `spawn(nodeExecutable(), ['-e', restartHelperSource(...)])`；端侧
  `nodeExecutable()` 落到 `process.execPath`（`/system/bin/appspawn`）。
  而 `installExecPathSpawnGuard()` 原先**只认脚本文本里含 `waitForParent`**
  （dsh 自己的 RELAUNCH_HELPER 特征）⇒ **认不出市场的助手** ⇒ 一律拒绝。
- **修法**：把 `process.execPath + ['-e', <script>]` 这一形态**统一视为"重启意图"**
  → 调 `requestAppRestart()` 并返回 stub child；其余 self-exe 用法**继续拒绝**。
- **安全性论证（我核过整棵树）**：
  - "以 `process.execPath` + `-e <内联脚本>` 启动子进程"在端侧**没有任何合法用途**
    （execPath 是 appspawn，不是可复用的 node）；
  - 上游真要用 node 解释器走的是**显式长选项** `--eval` / `--input-type=module`
    （如 `dsh-web-app` 的浏览器打开器），**不是 `-e`**；
  - 全树扫描：`execPath + '-e'` 出现 **0 次**；`execPath + '--input-type=module'` 有
    （那些继续走拒绝）。
  ⇒ 放宽到 `-e` 既覆盖两种助手形态，又不会误伤。
- **副作用（好的）**：这条修好之后，**插件市场与皮肤市场的"重启生效"都会真正冷启动 App**
  —— 报告 §4 提到的 `host-restart-request` 文件通道因此**不必再补**。

### 二 根因二：安装器把 bundle 型包写成了**孤儿用户行**

- **现象**：`billion-context` 有 `dsh.bundle`，却被写了
  `- id: billion-context` 进 `.dshm-plugin-rows.yml`；市场 toggle 报
  `no loader entry matched`（用户已手工清掉该行）。
- **根因（方向反了）**：旧门控把 `dsh.bundle` 当成"真插件 ⇒ 值得写用户行"的**正**判据，
  而用户行的语义是 **`- id: <X>` 指向一个**已存在**的条目**（cordis 的 patch 语义是
  "按 id 更新已有条目"，id 不存在时只告警跳过）。⇒ 写 `- id: <包名>` **必然匹配不到**。
- **证据链（三条，互相独立）**：
  1. `billion-context` 的 `dsh.bundle.patch`（`./dsh.bundle.patch.yml`）里 insert 的
     entry id 是 **`bili-native`**，不是包名；
  2. 官方皮肤 `dsh-client-ui-skin-denia` 的 patch insert 的 id 是 **`ui-skin-denia`**；
  3. **全树检验**：核心树里 8 个声明 `dsh.bundle` 的包，patch 插入的 entry id
     **恰好等于自己包名的，一个都没有**。
- **上游的权威口径**：`dsh-plugin-manager` 的 `reconcile()`（`lib/index.js:241-250`）
  对每个新装的 dependency 只有两种处置：**声明 `dsh.bundle` ⇒ push 进
  `dsh.profile.bundles`**（并加载其 patch）；否则 warn
  `"installed as a plain dependency, not a profile layer"` 后跳过。
  **上游根本没有"用户行"这个概念** —— 那是本项目的自有机制（因为我们的
  `cordis.patch.yml` 每次启动被种子覆盖，需要一个旁路文件承载用户自己的 patch 行）。
- **修法**：新增 `topPackageDisposition(pkg)` 二分类 + `appendProfileBundle()`：
  - `bundle`（声明 `dsh.bundle`/`dsh.bundles`）⇒ **登记进 `dsh.profile.bundles`**，
    **不写用户行**；
  - `plain`（其余，含纯库）⇒ **什么都不登记**（与上游 reconcile 一致）。
- **为什么不是"普通插件写用户行"**（报告建议里提到的那支）：我在真实生态里
  **找不到这样的实例** —— 官方与社区插件（dshmarket / modlens / dsh-better-sidebar /
  各皮肤 / billion-context）**全部**声明 `dsh.bundle`。而"非 bundle 包"要能被
  `- id: <包名>` 挂载，前提是**别处**已有同名 entry —— 那是无法从包自身推出的外部条件。
  故不实现该支：**宁可少写，不可写孤儿行**。（若将来真出现此类插件，判据应是
  "该 id 在现有条目里真的存在"，而不是"它有 dsh 字段"。）
- **顺带删除**：`appendUserRow` 与 `yamlRowValue` 随之变死，一并删掉，并把上面这套
  取证过程写成注释留在原处（免得下一个人重新发明"给包写行"）。

**`.dshm-plugin-rows.yml` 仍然有用**：它由**端侧「插件」页**维护
（`CorePane.ets` / `Index.ets` 写 `- id` + `disabled`），语义是"**用户对已有条目**的启停
覆盖"——其 id 来自 `status.plugins`（**活的 loader 条目**），不是安装器凭空写的包名。
已核实插件页的 id 来源（`Index.ets:3042` `pluginRowOf(r.id, …)`，`r` 来自 loader 状态）
⇒ **删掉安装器的写行能力不影响该功能**，只是去掉了孤儿行的来源。

### 三 验证

**本地（用真实包端到端，非手抄逻辑）**：

| 用例 | 结果 |
|---|---|
| `billion-context@0.1.147`（bundle 型） | `dsh.profile.bundles = ["billion-context"]`；**.dshm-plugin-rows.yml 不存在** ✓ |
| `is-number@7.0.0`（纯库） | bundles 与 rows **都不登记** ✓ |
| 重复装同一 bundle 型包（幂等） | bundles 里只出现 **1 次** ✓ |

**守卫形态（从真实 main.js 取守卫源码求值）**：

| 用例 | 期望 | 结果 |
|---|---|---|
| ① `['-e','…restartHelper…']`（**市场助手**，无 waitForParent） | 转冷启动通道 | STUB ✓ |
| ② `['-e','…waitForParent…']`（dsh 自己的助手） | 转冷启动通道（不回归） | STUB ✓ |
| ③ `['--input-type=module','--eval',…]`（上游非重启用法） | 继续拒绝 | `EPERM` ✓ |
| ④ 非 execPath 的普通二进制 | 放行 | 真实 spawn ✓ |

**门禁**：`assert-cli-shim` **40 项**（新增 7 项锁本次两处修复；见下"门禁自身的修"）。

**真机**（pid 41505）：`BOOT_70_HTTP_READY` ✓；`exec 探测` 七项全 `ok`（含
`git-ls-remote`）✓；守卫新日志 `execPath spawn 兜底已安装：命中 process.execPath 时拒绝；
-e 助手形态转入冷启动通道` ✓（旧版是"relaunch 助手形态"）。

**用户端到端确认（插件真挂上了）**：冷启动后 `node-output.log` 出现**插件自己的**输出：
```
bili-native-dsh: proxy bootstrap failed — model traffic goes direct (uncompressed):
bili: cannot find a Node runtime to spawn the proxy (this process is not Node) — set BILLION_CONTEXT_NODE
```
⇒ `bili-native` 条目**已挂载并执行**。它报的是**自身的软降级**（想要一个 Node 运行时做
代理，沙箱里找不到 ⇒ 自动降级为"model traffic goes direct"），**不是挂载失败**
——这与 §批次十三·三 的 execPath 约束同源（第三方插件也撞上了"不能自起 Node"），
且它**优雅降级**，不影响插件本体。

> **备注（市场显示局限，非缺陷）**：bundle 挂载后的实际条目名是 `bili-native`（不是包名
> `billion-context`），所以市场里 toggle 这类包时可能仍显示"未匹配到条目"——那是市场
> **按包名找条目**的显示局限，**插件本身是生效的**。已记入 D8 §8.2「静默失效」家族。

### 四 门禁自身的修（顺带发现的**五条陈旧断言**）

跑 `assert-cli-shim` 时发现它**本来就在红**，且与本次改动无关——是历史遗留：

| # | 陈旧断言 | 为什么过期 | 修法 |
|---|---|---|---|
| 1 | `QDIR 写死次数 === 2` | 加了第三个假壳（`dsh`）后实际是 3 | 改为**逐假壳各断言一次**（新加假壳漏写会立刻红） |
| 2 | `仍在等待 Host 安装 === 2` | 同上 | 同上 |
| 3 | `端侧暂不支持卸载` | 后来补了卸载通道（`.rem` 队列），该文案已消失 | 改为锁**当前契约**：`$QDIR/$base.rem` |
| 4 | `端侧只支持 add/install <…>` | 同上（未知子命令文案改了） | 改为锁现行文案 |
| 5 | `[['pnpm',…],['npm',…],['npx',…]]` 整行字面量 | 名字表加了 `dsh` | 改为**逐个断言四个名字** |

> **教训（写进 D8 §8.3）**：「写死总数」的断言会让**每加一个同类实体都要改断言**，
> 而"改断言让它变绿"这个动作本身就会让人放松警惕。判据应锁**"每个都满足"**，
> 而不是"总数恰好是 N"。
> 这五条红了却没人发现，也说明**这些断言没进必跑链**（没接进门禁的断言等于没有）。

### 五 负测试（证明新断言能抓到缺陷）

按项目纪律（E344），新门禁必须在**已知坏版本**上红过一次。做法：把两处修复临时还原成
修复前的形态（在临时副本上，不动工作树），跑断言：
- 篡改 ①「重启判据退回只看 `waitForParent`」→ `FAIL 35: 重启判据不再只看 waitForParent` ✓
- 篡改 ②「`appendUserRow` 加回来」→ `FAIL 39: 安装器**不再**写用户行` ✓

> **过程中踩了一个自己的坑**：第一版负测试按 `\n` 拼锚点，而文件是 **CRLF** ⇒ 替换没生效，
> 脚本却只打印"锚点没对上"就**继续跑**，于是得到"负测试通过"的**假象**。
> 修正版要求**每次篡改都断言替换真的发生**，没发生即报错退出。⇒
> **"负测试没生效"比"负测试失败"更危险**（它会给出虚假的安全感）。

### 六 遗留

- 报告 §4 的 `host-restart-request` 文件通道：**不必再补**（重启已能真正冷启动 App）。
- 市场按包名 toggle bundle 条目的显示局限：属**上游市场**行为，未动。
- `billion-context` 的代理功能在端侧不可用（它需要自起 Node 运行时，受 execPath 约束）；
  它已优雅降级，**不影响插件本体**。若将来要支持，需要给它一个可用的 Node 运行时
  —— 那是另一个课题（等价于 §批次十三·三 的同类问题）。

### 七 追加：鲸鱼"歪"的真因（用户裁决 B 后复现，改用官方 SVG 素材解决）

报告 8 §3 之后用户连续反馈"还是歪的"，最后选定**改用官方素材**。这一轮的关键是
**终于用对了测量工具**，以及**推翻了此前自己写下的一个错误结论**。

#### 7.1 三个层次的错误（按发现顺序）

| # | 我原先的判断 | 实测结论 | 怎么发现的 |
|---|---|---|---|
| ① | 测量：鲸鱼墨迹 33×34px、宽高比 0.97，"不是等比" | **测错对象**：我在整屏 x∈[0,140] 找暗像素，量的其实是**窗口外**的桌面图标 | `uitest dumpLayout` 给出权威坐标：窗口从 x=357 起、`Shape` 盒在 x[374..416] |
| ② | 结论：路径墨迹**溢出**官方 viewBox（x=-0.2229 w=23.3967），故 viewPort 要用"墨迹盒" | **结论是错的**：那个盒是**贝塞尔控制点**包围盒，而控制点会落在曲线**外面**。把每段 C 曲线离散成 400 点采样后，真实紧包围盒 = `x 0.0000 w 23.1600 h 17.0434`，**恰好等于官方 viewBox**（零溢出） | 写脚本解析 path + 采样求极值 |
| ③ | 数据：路径"逐字节取自官方" | **抄错 1 位**：`12.6435` 应为 `12.643`（3449 字符里错一个控制点，轮廓就会变形）。字符串比对显示 378 处差异，**语义级比对**（拆成命令+数值序列）后真正的差异只有这 1 处 | 逐字节 + 数值双重比对 |

#### 7.2 真因：`Shape.viewPort` 没有把路径缩放进组件盒

`uitest dumpLayout` 给出的权威数据：

```text
Shape 组件盒 : x[374..416] w=42px  y[390..421] h=31px   （比例 1.355 ≈ 官方 1.359 ✓ 盒子本身是对的）
盒内墨迹     : x[374..398] w=25px  y[391..408] h=18px
左留白 0px / 右留白 18px   ⇒ 鲸鱼贴在盒子左上角，只占 ~60%
```

即鲸鱼是以"1 用户单位 ≈ 1 物理像素"的自然尺寸画在左上角，**没有被缩放到组件盒**——
这才是用户看到的"歪"。此前几轮我一直在调 viewBox/尺寸/位置（都是布局层），
**没验证过"viewPort 到底有没有做缩放"这个更基本的前提**。

#### 7.3 解法：官方 SVG 素材 + `Image.fillColor`

按用户选定的方案：把官方 `FISH_LOGO_PATH` 生成为 `.svg` 资源，用
`Image($r('app.media.fish_logo')).fillColor(主题色)` 渲染。等比缩放交给图片组件
（`objectFit`），**不再依赖 `Shape.viewPort` 的缩放语义** ⇒ 问题消失。

- `fillColor` 对单色 SVG 是**整体重着色**（把非透明像素统一替换），
  等价官方 Web 层的 `fill: currentColor` ⇒ 主题跟随继续有效；
- 新增 `tools/gen-fish-logo.mjs`（**生成式**，带两条自检）：
  ① 断言"真实紧包围盒 == 官方 viewBox"（上游换几何时会停下要人确认）；
  ② 断言"落盘后路径仍与官方逐字节一致"。
  生成式取代内联字面量，正是为了消灭 7.1 ③ 那类手抄错误。

#### 7.4 尺寸定稿

`24vp`（官方规格）→ 用户看效果后"有点大，小 15%" ⇒ **`20.4vp`**（24 × 0.85），
高度按 23.16:17.04 等比推出（≈15.0vp，`objectFit: Contain` 双保险）。
至此用户确认「OK了，好很多了」。

#### 7.5 本批新增的可复用通则

| 通则 | 说明 |
|---|---|
| **测量前先问"这个坐标系对吗"** | 我从整屏像素猜位置，量到的是窗口外的桌面图标。`uitest dumpLayout` 才是 ArkUI 层级的权威坐标源 |
| **控制点包围盒 ≠ 可见墨迹包围盒** | 贝塞尔控制点可落在曲线外；要"看得见的边界"必须**离散采样** |
| **"逐字节取自官方"要能复核，否则等于没验证** | 手抄 3449 字符必然出错。生成式 + 落盘后自检把"抄对了吗"变成可执行断言 |
| **字符串比对会被格式噪声淹没；语义比对才看得出真差异** | 378 处字符串差异里，真正的数值差异只 1 处 |
| **用户报"还是不对"时，别重做同一个修法，先换测量工具** | 前几轮都在布局层打转；一拿到 UI 树坐标就立刻定位到 viewPort 未缩放 |

## 批次十六（2026-09-25：核心 0.1.7-rc.1 → 0.1.7-rc.2 同步 + 一个潜伏很久的升级失效根因）

**任务**：官方发布 `0.1.7-rc.2`（npm `dist-tags.next`，2026-09-24 发布），按
`docs/40-上游升级手册.md` 同步。

**结果**：升级成功，但过程中**撞出一个比升级本身重要得多的缺陷**——
「装了新核心却仍跑旧核心」，而它的根因是**目录枚举顺序被当成了确定性依据**。

### 一 漂移报告：70 处，但**混着两跳账**

提交基线停在 `0.1.5-rc.2`（84 端点），而端侧早已跑 `0.1.7-rc.1`（125 端点）
⇒ 说明**上一轮升 rc.1 时漏跑了升级手册的第 3 步（重生成上表）**。

| 差异 | 属哪一跳 |
|---|---|
| `+58 / −7` 端点、`agentPresets/*` 声明包从 `dsh-agent-presets` 迁到 `dsh-agent-preset-registry` | 0.1.5-rc.2 → 0.1.7-rc.1（**补记**） |
| `+10 / −0` 端点、5 处参数形状变化 | 0.1.7-rc.1 → 0.1.7-rc.2（本轮） |

> **怎么把两跳拆开的（这步很关键）**：我怀疑"7 个被移除的端点"不一定是 rc.2 删的，
> 于是**直接对比 rc.1 与 rc.2 两份契约**——结果那 7 个**在 rc.1 里就已经不存在**，
> 纯属基线没更新造成的"旧欠账"。
> **如果没有这一步**，就会误以为 rc.2 删了 7 个端点，进而去做无谓的降级处置
> （甚至可能"修复"一个不存在的问题）。
> ⇒ **教训：升级手册的第 3 步不能省。** 省掉的代价不是红灯，而是
> **下一次升级无法区分"新漂移"与"旧欠账"**。

### 二 影响面：用检索判定，不靠印象

对每个"被移除"与"契约变化"的端点，在 `connection/src`、`appstate/src`、`entry/src`、
`dshcompat/src`、`hostcore` 里检索字面量（脚本化，159 个文件）：

| 端点 | 我方调用情况 | 处置 |
|---|---|---|
| `agentPresets/{copy,deletePreset}` | **`SessionHub` 有调用** | 已核实走**既有优雅降级**：`argsFor()` 返回 undefined → 如实返回 `contract.missing`（不崩、不静默）⇒ **不改调用代码** |
| `subagents/list`、`workspaceFiles/{readAll,readRelated}`、`settings/{canOpen,open}AgentPresetDirectory` | 仅出现在**生成的上表**（及 ohosTest 一处断言） | 重生成上表即消失 |
| `workspaceFiles/changes`（增 `path`） | **`SessionHub` 订阅变更流** | 参数由上表决定（不在调用点写兼容分支） |
| `workspaceFiles/readBytes`（`range`→`options`） | 经上表调用 | 同上 |
| `account/*`、`workspace/initializeDefault` 的形状变化 | **未调用** | 无 |

**能力表也一并修对了**：`workspaceFiles` / `agentPresets` / `subagents` 三个能力原先把
**已移除的端点**列在 `optional` 里 ⇒ 该能力在**任何** rc.1/rc.2 Host 上都会恒报 missing
（**假降级**）。摘掉后 `gen-compat-endpoints.mjs` 不再有 WARN。

### 三 ★ 撞出的真根因：`installed[0]` 是**未定义的目录枚举顺序**

**现象**：rc.2 树**解包成功**（`cores/0.1.7-rc.2/.dshm-bundled-stamp` 时间戳是新的），
但 `BOOT_10_ENV_READY` 显示跑的还是 **rc.1**。

**定位**（`DshHost.start()`，hostruntime）：

```ts
const installed = this.store.listInstalled();       // ← fs.listFileSync()，顺序未定义
let target = state.current.length > 0 && installed.includes(state.current)
  ? state.current
  : installed[0];                                    // ← 没写 current 时"碰运气"
```

- `state.json` **不存在**（本轮之前的文档已记：`files/dsh/state.json` 缺失 ⇒ `current` 恒空）
  ⇒ 每次都走 `installed[0]`；
- 而 `listInstalled()` 返回的是**目录枚举顺序**，不是版本序；
- 真机上恰好把 rc.1 排在前面 ⇒ **每次都启动旧树**。

**这解释了此前的"升级后必须手工删掉旧树"**——文档（批次十一·一）把它记成
「⇒ current 恒空 ⇒ Host 永远 `installed[0]` 起核心 ⇒ **删旧树即切换**，零状态写入」。
**那不是设计，是掩盖了未定义行为**：能工作只是因为"只剩一棵树"。

**修法**（新增纯函数 + 接线）：

| 落点 | 内容 |
|---|---|
| `hostruntime/.../core/Naming.ets` | 新增 **`compareVersions(a, b)`**（确定性版本比较）与 **`newestVersion(installed)`**（挑最新） |
| `hostruntime/.../runtime/DshHost.ets` | `start()` 与 `plugins()` 两处 `installed[0]` → `newestVersion(installed)`；旧 current 失效时打 warn |

**`compareVersions` 的规则与两个被单测抓出的坑**：
- 主版本**按数值**比（`0.1.10 > 0.1.7`；纯字典序会搞反）；
- 预发布序号也**按数值**比（`rc.10 > rc.2`；字典序反）；
- 阶段顺序 `alpha < beta < rc < release`；
- **同号正式版 > 预发布版**（semver：`0.1.7 > 0.1.7-rc.1`）。

> **两个坑都是单测当场抓到的**（这就是"判据必须可单测"的价值）：
> ① 第一版按"有后续段落的更新"处理段数不等的情况 ⇒ 得到 `0.1.7-rc.1 > 0.1.7`（**错**，
> 违反 semver）；② 第一版把 `alpha` 与 `beta` 合成一档 ⇒ `beta.1 < alpha.9`（**错**）。
> 现在钉成 **15 条比较 + 8 条选择**用例，落在 `CoreDecision.test.ets`。

**真机验证（决定性）**：

```text
BOOT_10_ENV_READY core=…/dsh/cores/0.1.7-rc.2 …          ← 跑的是新版本 ✓
设备 cores/ 目录：0.1.7-rc.1 与 0.1.7-rc.2 **并存**      ← 没删旧树 ✓
```

⇒ **"不删旧树也能升级"这条现在成立了**（此前是"必须先删"）。

### 四 其它真机读数（rc.2，pid 54993）

| 项 | 读数 |
|---|---|
| 启动健康 | `BOOT_70_HTTP_READY GET / → HTTP 401（187ms）(+4439ms)` |
| exec 探测 | `python3.12=ok，git=ok，git-core/git=ok，git-remote-http=ok，rg=ok，bash=ok，git-ls-remote=ok`（**七项，零回归**） |
| 未激活条目 | 无（`did not activate` / `pending (waiting` 均无） |
| 插件挂载 | `billion-context` 的 `bili-native-dsh:` 输出仍在（bundle 层在新树里照常挂载） |
| 树内元数据 | `"coreVersion": "0.1.7-rc.2"`、`platform: openharmony/arm64`、`producer: tools/pack-core.mjs` |
| 核心 zip | 74.5 MB / 29198 条目，sha256 `34d340c8…`，签名 47 通过 / 3 未检出 |

**关于"3 未检出"（此前 rc.1 记的是 1）**：逐个查明后确认**都不是"该签没签"**——
- `koffi.node`：由 HAP 自编的 `libkoffi.so` 兜底（既有已知项）；
- `glibc/system.node` 与 `musl/system.node`：**是占位文本**（内容为
  `DSHM placeholder: real binary is loaded from HAP libs/<abi>/libsystem.so`），
  由 `pack-core` 的 `addSystemAddonPackage` **故意写入**，由原生库重定向映射到我们自建的
  `libsystem.so`。它们**不是 ELF**，本来就不需要签名。
> 计数从 1 变 3 是因为它们出现在"必查集合"里 —— **判据（是否带 `.codesign`）本身没问题，
> 只是把两类"不需要签"的东西也列进了清单**。已知并已核明，不改判据。

### 五 顺带清理

- `dist/core/work/dsh-core-0.1.7-rc.1/` 与 resfile 里的 rc.1 zip（69.1MB）删除；
- `entry/.cxx` 的 CMake 缓存**必须清**：它记着旧核心树的绝对路径，
  删了 rc.1 树后构建会报 `flock.c … missing and no known rule to make it`
  （CMakeLists 用 **glob** 找核心树，清缓存后自动指向 rc.2）。

### 六 本批的可复用通则

| 通则 | 说明 |
|---|---|
| **"能工作"不等于"定义正确"** | `installed[0]` 在"只剩一棵树"时行为正确，于是潜伏了很久；一旦并存两棵就暴露 |
| **未定义的顺序不能当确定性依据** | 目录枚举顺序、`Object.keys` 顺序、`Set` 迭代顺序都属于此类 |
| **升级手册的每一步都有它挡的东西** | 漏跑"重生成上表"的代价不是红灯，而是**下轮无法区分新漂移与旧欠账** |
| **判据函数必须可单测，且单测要覆盖"会出错的地方"** | `compareVersions` 的两个错（正式版/预发布序、alpha/beta 档）都是单测抓的，不是评审抓的 |
| **"计数变了"先问"是新问题还是口径变了"** | 签名"1 未检出 → 3 未检出"查明后是两类原本就不需要签的东西进了清单 |
| **删了源码树之后要清构建器缓存** | `.cxx` 记着绝对路径；不清会报"文件缺失"而非"配置过期" |

---

## 批次备注十七（2026-09-25：外部报告 9 的四项 + 用户反馈"自定义 API 保存不了"的真因）

**任务**：落实外部报告 9（端侧 fetch 垫片 + 安装校验四项缺陷），并查清用户随后反馈的
「**自定义 API 依旧无法保存**」。

**结果**：报告 9 的四项**早已落地**（本轮逐条回代码 + 跑门禁复核确认）；
而用户那条反馈的真因**不在后端，在界面层** —— 原生设置页**根本没有"添加自定义 API"的入口**。

### 一 报告 9 四项：复核结论是"已修"，不是"待修"

报告 9 的措辞会让人以为还在待办，实际四项都在 `hostcore/app/` 里、且注释标了出处：

| 缺陷 | 落点 | 复核 |
|---|---|---|
| 1 原生 `Headers` 被当普通对象（请求头全丢 → 401） | `fetch-shim.js:59-79`（能力判据分支）+ `:457-478`（Request 展开） | ✅ 已修 |
| 2 已知长度 body 不设 `Content-Length`（→ chunked → 412） | `fetch-shim.js:485-508` | ✅ 已修 |
| 3 `entryCandidates` 误杀纯类型包（`@types/*` → 整单回滚） | `dshm-user-rows.js:132-149` | ✅ 已修 |
| 4 profile `cordis.patch.yml` 被种子重建（设置重启即丢） | `dshm-user-rows.js:380-421` + `main.js:3686-3701` | ✅ 已修 |

**前提都在本机复现过**（不是只读注释）：`--jitless` 下 `Object.keys(new Headers(...))` 返回 `[]`
而数据只在 `entries()` 上；`req.write(data)+end()` → 服务端见 `transfer-encoding: chunked`、
`end(data)` → 见 `content-length`；registry 上 `@types/trusted-types@2.0.7` 正是
`main:""` + `types:index.d.ts`（`dist.size` 恰 2997，与日志的 `tgz=2997B` 吻合）；
`SettingsForms.documentPath` → `config-editor` 的 `profileContext.patchPath`（即 profile patch）。
⇒ 新增 `tools/assert-report9-fixes.mjs`（§5 四条用例 + 补强，29 项）。

### 二 顺带修掉的门禁红：`check-user-rows-preflight` 本来就是红的

改动前实测 `79 通过 / 5 失败`。为判断是否由报告 9 引入，**用 `entry/build/` 里报告 9 之前的
旧快照对着同一个测试跑——失败集合完全相同**，确认是历史遗留。5 项里：

| # | 性质 | 处置 |
|---|---|---|
| 1 | **真代码 bug**：`entryCandidates` 的 `exports` **字符串**分支 `push` 后漏 `return`，落到下面 `main`/`index.js` 分支 ⇒ `{exports:'./b.js'}` 返回 `["b.js","index.js"]`（凭空多一个候选） | 已修 + 注释 |
| 2 | **判据不一致**：`sanitizeDependencies` 的 bundle 预检要求"**所有**候选存在"，而 `userRowLoadable` 是"**任一**可解析即通过"——`dshm-installer.js:39-41` 的注释恰好写着"两边判据不一致就是'装完即被拒拼/隔离'的配方" | 已统一为"任一 + `entryFileResolves` + 判在权威目录 `resolvedDir`" |
| 3-5 | **fixture 陈旧**：`good-bundle` / anchorDirs 的 fixture 只写 `dsh.bundle.patch`、**没有 main 也没有 JS 入口**——那是"补入口判据"（09-24）之前的写法 | 补成真实形态（`main: lib/index.js` + 入口在位），并**新增 3 条断言钉住契约** |

结果 `86/0`。**红的是 fixture 不是判据**：实测核心树里**全部 9 个**声明 `dsh.bundle.patch`
的包都是 `main: lib/index.js`。

> **可复用通则**：改断言让它变绿之前，先证明"红的是判据还是 fixture"——
> 用**旧快照对着同一个测试跑**是最省事的判据（失败集合相同 = 历史遗留）。

### 三 ★ 用户反馈"自定义 API 依旧无法保存"：真因在**界面层**

**先排除，再定位**。在**真实 Host**（与端侧同一入口脚本 / 同一 argv / 同一 profile）上实测，
报告 9 关心的那几层**全部成立**：

| 被怀疑的层 | 实测 |
|---|---|
| 写入落盘 / 重启存活 | ✅ 重启后 Host 仍认得该路由，模型目录里也有它 |
| 端点探测（「获取模型」） | ✅ 走垫片发真实 HTTP，带 `Bearer`、无 chunked |
| 逐字段深路径写 | ✅ `providers.<route>.{baseURL,api,displayName,apiKeyEnv}` **四条全通** |
| 数组写入 | ⚠️ 只能**整值**写：`models.0.name` 把字符串段当对象键；**数字下标被网关拒**（`gateway/input-invalid`） |
| `unset` 删字段 / 删整条路由 | ✅ 都通 |

⇒ **后端一切正常**。

> **这条还修正了本项目的一处既有假设**：原注释把"数组下标不可达"与"标量深路径也不可靠"
> 混为一谈，会让后来者**不敢做官方那种逐字段编辑器**。实测结论是：
> **标量深路径可行，只有数组元素不可按下标寻址**（数组一律"读出来→本地改→整值写回"）。

**真因**：官方 Models 页创建**目录外路由**的唯一入口是「添加模型提供商 → **自定义模型 API**」
（`CustomProviderCard`，写 `llm-pi-ai` 的 `providers.<route>`）。而我们的原生模型页当时：

- 「可添加的提供方」只来自 `llm/listProviders ∪ llm/listConfigurableProviders`
  —— 那是 **pi-ai 自带目录**；
- 用户自己的中转站 / 自部署路由（如 `wb2api`）**两个目录里都没有** ⇒ **界面上无处可加**；
- 已存在的路由又只能把**整块 `providers` 当 JSON** 编辑（`llm-pi-ai` 的 schema 根是
  `{providers: dict}` ⇒ 投影出的唯一一项是 object）。

⇒ 用户看到的"保存不了"，本质是**没有可用的保存路径**，而非"保存这个动作失败"。
这也解释了为什么后端怎么查都是好的。

**修法：原生模型页对齐官方 Models 页**。新增

- `appstate/src/main/ets/model/PiAiProviders.ets` —— **纯逻辑零依赖**（投影 / 校验 / 路径 / 载荷）；
- `entry/src/main/ets/view/PiAiProviderSheet.ets` —— 编辑 / 新建表单。

几处**与官方逐字对齐**、且容易做错的细节（都有断言）：

| 细节 | 为什么 |
|---|---|
| id 正则 `/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/` | 数字开头的 id 能过本页检查，却在**凭据那一层**以用户看不懂的正则失败（凭据引用不能数字开头） |
| `deriveKeyRef`（大写 + 非字母数字折 `_` + `_API_KEY`） | 两端不一致 ⇒ "密钥存了但路由读另一个引用" ⇒ 表现为 `MISSING_CREDENTIAL` |
| 「占用」检查放**客户端** | Host 允许覆盖已有路由（那只是一次 `set`），**不替你拦** |
| 空密钥框**不是失败** | "只写不读"的必然结果：页面读不回明文，空 = 保留原密钥；只有**纯空白**才是失败 |
| 端点占位随协议变 | Anthropic 的 SDK 自己追加 `/v1/messages`，故不写 `/v1` |
| 协议候选**读自 schema** | 这样"页面给的选项"不可能与"适配器接受的选项"漂移 |

写入策略：标量**只写变了的**；模型目录**整值写**；提交顺序 = 官方 `createOnce`
（**先 profile 后密钥**，密钥失败只重试密钥，不重复写 profile）。

### 四 本批新增门禁

| 门禁 | 覆盖 |
|---|---|
| `tools/check-custom-api-save.mjs` | **真 Host** 全链路：新建 → 存密钥 → 逐字段改端点 → 整值改模型目录 → 重启存活 → 删除 → 再重启确认删除生效（31 项） |
| `tools/check-custom-api-discovery.mjs` | 「获取模型」端点探测：假网关**校验 Bearer + 拒 chunked**（补上报告 9 §5 第 5 条**一直没做**的用例） |
| `check-layout-fixtures.mjs`（扩充） | `PiAiProviders` 投影 / 校验 / 路径 / 载荷，**60 余条断言** |
| `tools/neg-test-piai.mjs` | 负测试：篡改 `deriveKeyRef` / `isHttpUrl` / `checkModels` / `piAiModelsPath`，确认断言**真的会红** |

全量回归：**14 个门禁 exit=0**。

### 五 ★ 设备侧验收：如实分开记录（**这条最该看**）

用户回报"**搞定了**：能保存，且重启后仍在"。但**走通的是「官方设置的入口」**
（应用内嵌的 dsh Web UI，`WebApp.ets` → `Web` 加载 `launchUrl`）——
官方 `dsh-client-ui-settings-models` 自带完整表单，它由**核心树**提供，
**与本次 ArkTS 改动无关**，在旧包上本来就通。

**本次原生页改动没有上过设备**，客观读数如下（附录，供下次核对）：

| 事实 | 读数 |
|---|---|
| 设备上应用 `updateTime` | 2026-09-25 **17:38:47** |
| 本次改动文件 mtime | 2026-09-25 **20:14–20:24** |
| 本机产出的 hap | 仅 20:08 的 `entry-default-unsigned.hap`（**未签名**） |
| `dist/sideload/…-signed.hap` | **17:46**（早于改动） |
| 签名材料 `default_dshm_*.p12` | **不存在** ⇒ 本机 `PackageHap` 失败，签不出新包 |

⇒ 设备上的包比改动**早约 2.5 小时**，本次 ArkTS 改动**不可能**是验收通过的原因。
（`CompileArkTS` 是**通过**的——它才是类型/语法门禁；失败的只有 `PackageHap` 的签名步骤。）

**结论三句**：

1. **用户的问题已解决** —— 走官方入口即可，不依赖本次原生页改动；
2. 本次原生页修复仍有价值（原生页此前**连入口都没有**），但属**待复核**：
   装上含该改动的签名包后，需在设备上点一次
   「设置 → 模型 → 添加自定义模型 API」确认；
3. 本次改动的**不依赖设备的部分已验到位**（ArkTS 编译 + 60 余条断言 + 负测试 +
   真 Host 全链路 31 项），这些全过。

### 六 本批的可复用通则

| 通则 | 说明 |
|---|---|
| **"后端都对"不等于"用户能用"** | 传输/持久化/写入原语全绿，用户仍报"保存不了"——差的是**入口**。排查顺序应为"先问有没有入口，再问入口通不通" |
| **"通过了"必须绑定到"哪一份代码"** | 验收走的可能是**另一条**路径（官方 Web UI 而非原生页）。不绑定版本/时间，结论就会记到没上过设备的代码名下 |
| **验收前先核对"包比改动新"** | 比 `updateTime` 与源码 mtime、构建产物时间即可；本批正是靠这一步发现"验的不是新包" |
| **改断言让它变绿前，先分清"判据错"还是"fixture 陈"** | 用**改动前的旧快照**跑同一个测试，失败集合相同即历史遗留 |
| **"注释里写着不能做"要先实测** | 原注释把"数组下标不可达"推广成"深路径都不可靠"，实测后标量深路径是通的——**过头的保守结论也会挡住正确设计** |
## 批次备注十八（2026-09-26：语音输入可行性调查 + 麦克风授权最小验证 + 真机数据保全实证）

## 一 这一批在回答什么

用户问：「最新版本里的语音输入模型，有没有可能移植，或者第三方替换？」

先做**只读**可行性调查，得到否定结论与两条替代路线；随后按用户选择落最小验证。
结论分三层：**本地 SenseVoice 移植不可行**（四条硬阻塞）、**HMS 系统识别可用**（设备已实证）、
**`SpeechProvider` 是干净的可替换点**（可接云端 ASR）。

## 二 语音链的构成（先弄清"要移植什么"）

语音不是单个插件，是 4 个包的组合（`dsh-experimental-voice-input-bundle`）：

| 包 | 作用 |
|---|---|
| `dsh-experimental-speech-to-text` | 服务（`ctx.speechToText`）+ provider 注册表 |
| `dsh-experimental-speech-to-text-sensevoice` | **本地识别**（SenseVoiceSmall ONNX + Silero VAD） |
| `dsh-experimental-api-speech-to-text` | 浏览器 ↔ Host 的 Remote 传输层 |
| `dsh-experimental-client-ui-voice-input` | 麦克风按钮 UI（跑在 WebView 里） |

## 三 为什么本地移植不可行（四条，均逐字回代码核实）

| # | 阻塞 | 证据 |
|---|---|---|
| 1 | 平台白名单**没有 openharmony** | `…sensevoice/lib/index.js:201-207` 只认 `darwin-arm64/x64`、`linux-arm64/x64`、`win32-x64` ⇒ 抛 `Local speech is unavailable for openharmony-arm64` |
| 2 | `sherpa-onnx-node@1.13.8` 是**纯 JS 加载器**，原生二进制在 6 个平台子包里，**无 ohos** | 树内 sherpa/onnx 的 `.node`/`.so` 数量为 **0** |
| 3 | 模型体积 | int8 **239 MB** / fp32 **938 MB**（另有 VAD 1.8 MB、tokens 316 KB） |
| 4 | 录音在 **WebView** 里，且应用**没有麦克风权限** | UI 用 `navigator.mediaDevices` + `MediaRecorder`（`client.js:4674-4701`）；`module.json5` 原 9 个权限**不含** MICROPHONE，`WebApp.ets` 也**没有** `onPermissionRequest` |

第 4 条是本次新发现的：即便 1–3 全解决，**麦克风本身拿不到**。

## 四 两条可行替代（给用户选）

### 路线 A：HMS 系统语音识别（`@hms.ai.speechRecognizer`）— 设备已实证可用

本机设备实测（`<设备序列号>`，HUAWEI MNTXM-24B / API 26 / OpenHarmony-7.0.0.105）：

```
/system/etc/syscap.json 里含 SystemCapability.AI.SpeechRecognizer
进程在跑：intell_voice_service、intell_voice_host
```

能力面（`@kit.CoreSpeechKit`，`@since 4.1.0(11)`，`@stagemodelonly`）：支持**离线**
（`online: 1` 是当前唯一模式）、中文 zh-CN、短句/长句模式、热词；API 为
`createEngine` → `startListening` → `writeAudio(sessionId, Uint8Array)` → `onResult`。
**天然绕开 jitless**：识别在 ArkTS/系统侧，不经 Host Node 进程，与 WASM/签名无关。
代价：它是**原生 ArkTS API**，而语音 UI 在 WebView 里 ⇒ 需要做桥（中等工作量）。

### 路线 B：写一个 `SpeechProvider` 插件接云端 ASR — 架构上最正

接口是明确的可替换点（`…speech-to-text/lib/types/types.d.ts`）：

```ts
interface SpeechProvider {
  info: SpeechProviderInfo;          // id / name / location / languages
  preparation?: SpeechPreparation;   // 云端 provider 不需要
  transcribe(input: SpeechInput, signal: AbortSignal): Promise<Transcript>;
}
```

`register(provider)` 注册，`location` 直接支持 `"cloud"` ⇒ 转接到任意云 ASR 即可，
不碰 sherpa-onnx、不需要 ONNX 运行时。前提：Host 能出网（已有 INTERNET）+ 麦克风通路。

## 五 最小验证：为什么**不能**靠点界面上的麦克风按钮

这是本批最重要的一条发现。读官方 UI 源码（`…client-ui-voice-input/lib/client.js`）：

```js
// :4928  usable 要求 provider 已就绪
const usable = readiness.connected && (provider?.preparation.phase === "ready"
  || provider?.preparation.phase === "standby" || provider?.preparation.phase === "waking");
// :5036  start() 首行就挡住
if (!catalog || !usable || locked || current.current) return;
// :5090  onClick 分支——不可用时只弹配置对话框，**不调 getUserMedia**
onClick: () => { if (usable) start(); else setSetupOpen(true); }
```

而 SenseVoice 在 openharmony 上**永远进不了** ready/standby（白名单直接抛）
⇒ **启用语音 UI 也点不出录音**，`getUserMedia` 根本不会被调用。
所以"WebView 能否拿到麦克风"必须用**独立探针**直接问浏览器。

## 六 本批的代码改动（4 处）

| 文件 | 改动 | 为什么 |
|---|---|---|
| `entry/src/main/module.json5` | 声明 `ohos.permission.MICROPHONE` | 实测为 `user_grant` / `NORMAL`（**非** system 权限），普通应用走运行时弹窗即可 |
| `entry/src/main/resources/base/element/string.json` | 加 `perm_microphone_reason` | 与既有 9 条 `perm_*` 同格式 |
| `entry/src/main/ets/pages/WebApp.ets` | ① `onPermissionRequest` 只对**回环来源**放行 `AUDIO_CAPTURE`（落 `diag-web-permission`）；② 新增 `MIC_PROBE_JS` 麦克风自检探针 + 「应用 → 麦克风自检」菜单；③ 探针加 `mp` 字段回传结果 | ① ArkWeb 不挂回调 = 一律拒绝，页面只会拿到 `NotAllowedError`；② 见 §五，按钮点不出录音，必须独立探针；③ `getUserMedia` 是 Promise，`runJavaScript` 回执是同步的，只能"异步写全局 + 下轮同步读走" |
| `hostcore/profile/ondevice/{cordis.patch.yml,package.json}` | 语音四行撤掉 `disabled: true`；`removeBundles` 清空 | 见 §七 的启用安全性论证 |

### 麦克风自检探针验证三层

① `navigator.mediaDevices` / `MediaRecorder` 是否存在（ArkWeb 是否暴露录音 API）；
② `getUserMedia({audio:true})` 是否被允许（≈ 授权闸门：模块权限 + 回调放行）；
③ 真拿到音轨、读采样率、正常释放（≈ 设备真可用，而非"API 在但没设备"）。
任一步失败的 `error.name`（`NotAllowedError` / `NotFoundError` / `NotSupportedError`）即根因分类。

## 七 启用语音**不会**毁启动（逐条回代码核实）

启用前必须排除"开机就崩"，判据如下：

| 检查 | 结论 | 证据 |
|---|---|---|
| `sensevoice.apply()` 是否调 `resolveRuntime`？ | **不调** | `:920-954` 只做路径校验 + 注册 provider 元信息 + `worker.inspect()` |
| `resolveRuntime` 何时调？ | 仅在异步的 `inspectRuntime` / `prepareRuntime` | `:246`、`:336` 两处调用点 |
| `inspect()` 抛错会冒泡吗？ | **不冒泡** | `:632-663` 把异常吞进 `env`，最终 publish 成 `phase: "failed"` |
| `ui-voice-input` 依赖 core 服务吗？ | **不依赖** | `inject = ["remote","slots","locale","pluginNavigation"]`，**不含** `speechToText` |

⇒ 启用后：开机正常、UI 正常渲染，只是语音组件显示"需安装依赖"（预期行为，非新 bug）。

## 八 零风险的装机路线（本批的关键决策）

### 为什么**不**走"换签名 + `uninstall -k`"

原计划是换签名后用 `uninstall -k` 保留数据卸载。但实测把"有备份可回退"这个前提**证伪**了：

| 备份通道 | 实测结果 |
|---|---|
| `hdc shell ls home` | `Permission denied`（`drwx------`，属主=应用 uid 20020292） |
| `hdc smode`（提权） | `[Fail]Cannot set root run mode in undebuggable version` |
| `run-as` | 设备上**不存在** |
| `hdc file recv` | 拉 `home/sessions` 报 `permission denied` |
| 宿主 HTTP API | 认证**能**过（`?token=` → 303 + Set-Cookie），但**没有导出文件的方法** |
| 回收站 / 卷影副本 / 还原点 / 文件历史 / 压缩包内容 / DevEco material 库 | 均无原签名材料 |

⇒ 真机 el2 用户数据**没有任何可用备份通道**。而 AGENTS.md 明确要求
「不可假定 `-k` 生效」——在没有备份的真机上赌一次单向操作，正是 2026-09-25 事故的形态。

### 改走改 bundle 名（完全不碰真机数据）

在 `build-profile.json5` 的 `products[0]` 加 `"bundleName": "com.dshm.micverify"`。
该字段在 hvigor schema 里受支持（`ohos-project-build-profile-schema.json`），
实测**确实覆盖** `AppScope/app.json5`（产物 `module.json` 的 `app.bundleName` = `com.dshm.micverify`）。
新 bundle 名没有旧签名要匹配 ⇒ 签名随便换，现有 `com.dshm.dshclient` 的会话/插件/工作区**零风险**。

> ⚠ **验证完成后务必把这一行删掉**（或改回 `com.dshm.dshclient`），否则会产出改名的正式包。

## 九 覆盖安装通路与数据保留的**实证**

用户选择先做数据安全的冒烟：用现有那个**与设备同签名**的包跑 `hdc install -r`。

```
hdc install -r dist/sideload/DSHM-1.0.0-arm64-signed.hap
  → [Info]install bundle successfully.  (12 s)
```

| 检查项 | 安装前 | 安装后 |
|---|---|---|
| `home` 目录 | `drwx------` link=**8** | `drwx------` link=**8**（未重建） |
| sessionId | 2 个 | **2 个，全在** |
| `已应用用户插件行` | — | 存在 |
| `BOOT_30_PROFILE_READY` | — | 存在 |
| exec 探测 | — | **7/7 全通** |
| remote.mux 接入 | — | 16 次 |

内容级证据（不只元数据）：安装后应用启动并**加载了已存在的会话**
（`/sidebar/ws/agent-opens?sessionId=session-21db9734-…`）。

### 顺带纠正：`files/dsh/home` 读不到 ≠ 没有数据

`update-device.ps1` 用 `ls home | wc -l` 做装前/装后比对。在权限受限的真机上，
这个命令**恒返回 0** ⇒ 比对是 0→0，脚本会打印 `SKIP home 基线为 0`（它自己有这条分支，
但那等于**没验证**）。本批改用两个**世界可读**的旁证通道：

- `dshm-host.log`（`-rw-rw-rw-`）：含 sessionId 与启动阶段；
- `node-output.log`（`-rw-rw-rw-`）：含 `应用用户插件行`、`BOOT_30_PROFILE_READY`、会话加载请求。

两者都能 `cat`，所以"数据还在"这件事有**内容级**硬证据，不靠猜。

## 十 签名材料的现状（一个必须记录的事实）

`build-profile.json5` 引用的三个材料**全部缺失**，`%USERPROFILE%\.ohos` **整个目录不存在**：

| 文件 | 状态 |
|---|---|
| `default_dshm_*.p12` / `.cer` / `.p7b` | **缺失** |
| `~/.ohos/config/` | **不存在** |

**按魔数**（PKCS#12 的 `30 82 … 02 01 03`）全盘扫描 259103 个文件后：
全机**只有 2 个 PKCS#12**，且都不是本项目的：

- `<另一份检出>\.codeh-local\signing\codeh.p12`（**不同签名**：它的叶子证书是 `4727…`，本项目是 `8E08…`）
- `<个人签名文件>.p12`（口令未知，无法读取）

> 为什么必须按魔数扫：PKCS#12 是 DER 二进制，**开发者 ID 不以明文存在**，
> 且文件名可被改。先按扩展名、再按开发者 ID 文本搜都**会漏**。

时间线可对齐：`dist/sideload/DSHM-1.0.0-arm64-signed.hap`（17:46）是本机构建产物
⇒ 那时材料还在；`~/.ohos` 此后被删。**项目脚本里没有任何删 `.ohos` 的动作**，
所以不是构建流程干的。

设备上那个包的指纹是 `8E0813ED1D592E9934B06974FE559128BFC265940154F99533FE2787765B0EC3`，
与 sideload 包的**叶子证书完全一致** ⇒ 那个包本身是**可覆盖安装**的，只是不含本次改动。

## 十一 产物核验（11/11）

不能只看"构建成功"——`CompileArkTS` 可能报 `UP-TO-DATE` 而没重编，
`products[].bundleName` 也可能"schema 允许但实际不生效"。逐项打开产物验：

| # | 检查 | 结果 |
|---|---|---|
| ① | `module.json` 的 `app.bundleName` = `com.dshm.micverify` | ✓ |
| ② | 权限数 = 10，含 `ohos.permission.MICROPHONE` | ✓ |
| ③ | `ets/modules.abc` 含 `diag-mic-probe` / `__DSHM_MIC_PROBE__` / `diag-web-permission` / `getUserMedia` / `麦克风自检` | ✓ |
| ④ | 包内 `resfile/dsh-core-*.zip` 的 `profiles/ondevice/cordis.patch.yml` 语音四行 `disabled=0` | ✓ |
| ⑤ | 同 zip 的 `package.json` 的 `removeBundles = []` | ✓ |

### 一个必须记住的打包链（本次踩到）

`hostcore/profile/ondevice/` 的改动**不会**自动生效，它要经过：

```
hostcore/profile/ondevice/
  → pack-core.mjs --place-in-app   （烤进 dist/core/*.zip 并复制到 entry/.../resfile/）
  → hvigor assembleHap             （zip 作为 resfile 资源进包）
  → 端侧 ensureProfile()           （每次启动用核心树种子覆盖 home/profiles/<name>/）
```

只跑 `place-host-app.mjs`（它只管 `hostcore/app/**` 那 8 个脚本）**不够**。
本次实测：第一次构建后 resfile 里的 zip 仍是 09-25 的旧版（sha256 不同）⇒ 已重跑补齐。

### 为什么改种子能生效（不会被用户层盖掉）

`hostcore/app/main.js:3609-3700` 的 `ensureProfile()` **每次启动**都做：

- `cordis.patch.yml` 用**核心种子整文件覆盖**（把原文先读走交给 `composeUserRows` 保用户行）；
- `package.json` 的 `bundles` = 「种子为准的顺序并集 **减去** `seed.removeBundles`」；
- 其余文件逐个 `copyFileSync` 从种子覆盖。

所以 `removeBundles` 清空后，之前被移除的 voice bundle 会**重新挂载**；
patch 里的四行也会随种子换成启用版。

## 十二 回归门禁（全绿）

```
check-layout-fixtures      684 断言 / 0 失败
check-user-rows-preflight  86/0
assert-report9-fixes       29/0
assert-resfile-sync        8 件快照全部同步
assert-cli-shim            40/0
check-parity               pass
compat-drift               无漂移
assert-exec-fix            35/0
assert-python-bridge       69/0
assert-fs-search-fallback  39/0
check-plugin-toggle        PASS
check-origin-fence         PASS
check-custom-api-save      31 断言
check-custom-api-discovery pass
```

## 十三 待复核（未上设备的部分）

1. **麦克风自检探针**：需装上含本改动的**已签名**包（`com.dshm.micverify`），
   点「应用 → 麦克风自检」，然后读 `files/diag-mic-probe`。判据：
   - 出现 `"result":"OK"` 且 `audioTrackCount>0` ⇒ WebView 麦克风通路成立，路线 A/B 都走得通；
   - 出现 `"result":"FAIL"` ⇒ 看 `errorName`：`NotAllowedError` = 授权闸门没通（查模块权限/回调）；
     `NotFoundError` = 设备无可用输入；`NotSupportedError` = ArkWeb 未暴露录音 API；
   - **没有该文件** ⇒ 自检没被触发，先查菜单与 `runJavaScript` 是否报错。
2. **语音组件启用后的界面表现**：插件面板会多出语音组件，点麦克风应弹"需安装依赖"引导。

## 十四 本批可复用通则

| 通则 | 说明 |
|---|---|
| **"能点"要先问"按钮有没有被前置条件挡住"** | 官方麦克风按钮的 `usable` 要求 provider 就绪，而本地 provider 在鸿蒙永不可用 ⇒ 点它**永远到不了** `getUserMedia`。查交互链路时，先读**门控表达式**，再谈操作步骤 |
| **二进制机密不按文本搜** | PKCS#12 里开发者 ID 无明文、文件名可改；按扩展名/按文本都会漏。要按**魔数**（`30 82 … 02 01 03`）扫 |
| **"读不到" ≠ "不存在"** | `home` 是 `drwx------`、`hdc smode` 被拒 ⇒ `ls | wc -l` 恒为 0，比对变成 0→0 的**假通过**。要另找**世界可读**的旁证（这里用两个 log） |
| **改种子要想清楚打包链与覆盖时机** | `hostcore/profile/**` 要经 `pack-core --place-in-app` 才进包；端侧 `ensureProfile()` 每次启动覆盖 ⇒ 判定"改了会不会生效"必须同时看这两处 |
| **无备份的不可逆操作要先证伪"有备份"** | 原计划 `uninstall -k` 依赖"数据能备份"，实测五条通道全断 ⇒ 结论必须回头改，而不是照原计划赌 |
| **`products[].bundleName` 是零风险的隔离手段** | 新 bundle 名没有旧签名要匹配，可在**同一台真机**上验证而不碰既有应用数据 |

---
## 批次备注十九（2026-09-26：debug 自签测试 —— 结论是"本机不可行"，附完整证据链）

### 一 任务与结论

用户要求「先走 debug 的签名测试」。做完的结论是：

> **在华为商用设备上自签不可行。** 唯一可行路径是 DevEco Studio 的自动签名
> （联华为 AGC 服务器签发，落到 `app_gallery` 信任锚）。

这不是"试了一下没成功"，而是**三种自签方式全部被同一错误拒绝**，
且用华为自家工具证明"profile 本身是好的"⇒ 原因是**信任锚不匹配**，
不是我的材料构造错误。

### 二 走通了什么（这部分是可复用的资产）

完整跑通了 OpenHarmony 自签流程，并把每一步的产物留在 `dist/`：

| 步骤 | 命令 | 产物 |
|---|---|---|
| 1 | `generate-keypair` ×2 | `app.jks` / `profile.jks` |
| 2 | `keytool -exportcert` 导出 Root CA 与 Application CA | `root.cer` / `sub.cer` |
| 3 | `generate-app-cert` | `app-chain.cer`（leaf ← CA ← Root，三级） |
| 4 | `generate-profile-cert` | `profile-chain.cer` |
| 5 | `keytool -importcert` 把链**导入回** jks | （见 §三 的坑） |
| 6 | `sign-profile` | `profile.p7b` |
| 7 | `sign-app` | 已签名的 hap |

设备 UDID 获取：`hdc shell bm get -u`，返回 `20DB409A…`，
与现有可用 profile 的 `device-ids` 中一条**逐字相同** ⇒ `device-id-type` 为 `udid`、
且 **不做任何哈希变换**（不是 sha256，别猜错）。

### 三 两个踩过的坑（都很隐蔽，值得记住）

#### 坑 1：`generate-app-cert` 不会把新证书写回 keystore

现象：`sign-app` 报 `Illegal base64 character 20`（0x20 = 空格）——**完全误导**。

真因：`generate-app-cert -outFile` 只输出证书链文件，**keystore 里仍是自签证书**。
于是链 leaf（`DBF52DC4…`）与 keystore 里证书（`A0169233…`）不是同一张，
私钥与链对不上。

修法：用 `keytool -importcert -alias <已有私钥的别名>` 把链**导入回去**
（对已有私钥条目做 import = "导入证书回复"，会替换该别名的证书链）。
导入后 `Certificate chain length` 从 1 变成 3。

#### 坑 2：`development-certificate` 必须**以换行结尾**

这是上面那个 base64 报错的**第二个、也是最终**的触发点。
用同一条 profile、同一个链、同一个 hap，只改这一个字符：

| 变体 | 结果 |
|---|---|
| `cert.trim()`（去掉结尾换行） | ✗ `Illegal base64 character 20` |
| `cert + "\n"` | ✓ 成功 |
| PEM 转 CRLF | ✗ 同样报错 |
| 去掉 PEM 头尾、只留裸 base64 | ✗ 同样报错 |

原始可用 profile 的该字段是 **18 行、末行为空串**（即结尾带换行）；
我因为对链做了 `.trim()` 把结尾换行一并去掉 ⇒ 触发报错。

**教训**：`Illegal base64 character 20` 这个报错信息与真实原因**无关**，
不要顺着"找空格"的思路查（我为此白花了几轮：查 p12 格式、JSON 美化、
subject 里的空格、keystore 类型）。定位靠的是**逐字段二分**：
以原始可用 profile 为基底，每次只改一个字段，看错误何时出现。

### 四 被拒的证据（三条独立路径，同一错误）

| # | 方式 | 结果 |
|---|---|---|
| a | 自造 CA 链 + 自造 profile，签 286MB 真包 | `code:9568257 fail to verify pkcs7 file` |
| b | 同上但 `-profileSigned 0`（profile 不签名） | 同一错误 |
| c | SDK 自带 `OpenHarmonyProfileDebug.pem` 官方链 | 同一错误 |

补充：用 **1KB 的 zip 小包**（只含 `module.json`）也能复现同一错误 ⇒
该校验**先于**包内容校验，与包大小/内容无关。
（造小包时注意：必须是**真 zip**；用 `tar` 造会得到
`read zip failed: can not find eocd`，那是工件问题不是签名问题。）

### 五 为什么被拒：权威工具给出的反证

华为自家工具 `Provisionsigntool.jar`（在 `sdk/default/hms/toolchains/lib/`）
的 `verify` 子命令，描述是 *"Check whether the provided Provision is expected to
verify on Harmony"* —— 用它预检三份 profile：

```
原始可用 profile（设备接受的那个）  → verifiedPassed: true, message: "OK"
我自签的 profile                     → verifiedPassed: true, message: "OK"
SDK 官方链签的 profile               → verifiedPassed: true, message: "OK"
```

**三份都"OK"，但设备只接受第一份** ⇒ 说明问题不在 profile 的自洽性/签名有效性，
而在**信任锚**。对比两条链的根：

| | 链根部 |
|---|---|
| 设备接受的包 | `CN=Huawei CBG Root CA G2, OU=Huawei CBG` + `Huawei CBG Developer Relations CA G2` |
| 我自签的包 | `CN=OpenHarmony Application Root CA, OU=OpenHarmony Team` |

⇒ 设备（HUAWEI MNTXM-24B / OpenHarmony-7.0.0.105）的信任锚是**华为 CBG**，
不含 OpenHarmony 测试根。

### 六 设备侧佐证（为什么它只认华为签发）

```
const.ohos.fullname        = OpenHarmony-7.0.0.105
const.product.model        = MNTXM-24B   (brand=HUAWEI)
hdc smode                  = [Fail]Cannot set root run mode in undebuggable version
现有可用 profile 的 issuer  = app_gallery
现有可用 profile 的 developer-id = 260086000057314119
```

设备是**非可调试版本**（`smode` 被拒），因此没有"开发者模式放宽校验"这条路。

### 七 本批**没有**做什么（数据安全）

全程只用 `hdc install`（且是装到**独立 bundle 名** `com.dshm.micverify`），
**没有执行任何卸载**。所有安装尝试都失败 ⇒ 设备上无 `micverify` 残留，
既有 `com.dshm.dshclient` 与用户数据未受任何影响（已核验）：

```
com.dshm.dshclient updateTime = 1790389391040（与冒烟安装那次的记录一致，未被改动）
权限数 = 9（仍是原包，未被本批影响）
宿主日志仍在正常处理 remote.mux / agent-opens 会话请求
com.dshm.micverify 存在？ NO（无残留）
```

### 八 下一步（交给用户执行，命令行无法代替）

1. 打开 DevEco Studio，**登录华为开发者账号**（要用设备上那个包的同账号，
   即 developer-id `260086000057314119`）；
2. `File → Project Structure → Signing Configs` → 勾选 **Automatically generate signature**；
3. 它会在 `~/.ohos/config/` 生成 `default_dshm_*.p12/.cer/.p7b`（**这四个文件就是本机
   此前丢失、导致签不出包的东西**）；
4. 之后用 `tools/update-device.ps1` 或直接用产物即可，
   且 `hdc install -r` 能覆盖安装、不动用户数据。

### 九 本批可复用通则

| 通则 | 说明 |
|---|---|
| **报错信息可能完全误导，靠二分定位** | `Illegal base64 character 20` 的真因是 PEM 少了结尾换行。顺着字面去找"空格"会白花数轮；正确做法是**逐字段二分**（以已知可用样本为基底，每次只改一个字段） |
| **"工具说 OK" ≠ "设备接受"** | 华为 `provisionsigner verify` 对三份 profile 都给 `OK`，设备只认其中一份 ⇒ 校验分两层：**自洽性**与**信任锚**，后者才是门槛 |
| **同名工具不止一个，别用错** | `openharmony/toolchains/lib/hap-sign-tool.jar` 是 OpenHarmony 测试链工具；`hms/toolchains/lib/Provisionsigntool.jar` 才是华为侧、能回答"设备会不会接受" |
| **自签在商用设备上不成立** | 设备信任锚 = 华为 CBG；OpenHarmony 测试根不在其内。非可调试版本也没有放宽口子 |
| **迭代用最小工件** | 签名校验先于内容校验 ⇒ 拿 1KB 的 zip 小包（只含 `module.json`）就能快速复现，不必每次搬 280MB。注意必须真 zip，不能是 tar |

---
## 批次二十（2026-09-26：麦克风最小验证**通过** —— WebView 拿到了真实音频轨，附一个真机 bug 的修复）

### 一 结论

用户完成自动签名后装机验证，**麦克风通路成立且已用真实音频轨证明**：

```
diag-web-permission: origin=http://127.0.0.1:3120/ requested=TYPE_AUDIO_CAPTURE
                     audio=true loopback=true => GRANT (user-granted)

diag-mic-probe: step=got-stream  audioTrackCount=1
                trackLabels=["(default)麦克风"]  sampleRate=48000
                channelCount=1  trackState=live  result=OK
```

`audioTrackCount=1` + `sampleRate=48000` + `trackState=live` ⇒ 不是"API 在但没设备"，
而是**真的拿到了麦克风音轨**（并已正常释放）。
⇒ 路线 A（HMS 原生识别）与路线 B（云端 provider 插件）**都走得通**，
两条都不必再为"麦克风拿不到"担心。

### 二 真机发现并修掉一个 bug（本批最重要的产出）

**我加的 `onPermissionRequest` 起初把自己的请求也拒了。** 首次自检结果：

```
diag-web-permission: origin=http://127.0.0.1:3120/ requested=TYPE_AUDIO_CAPTURE
                     audio=true loopback=false => DENY (not-mic-or-not-loopback)
diag-mic-probe: errorName=NotAllowedError  errorMessage="Permission denied"  result=FAIL
```

**根因**：ArkWeb 的 `PermissionRequest.getOrigin()` 返回 **`http://127.0.0.1:3120/`
（带结尾斜杠）**，而我的正则写成 `…(:\d+)?$`（端口后必须立刻结束）⇒
`127.0.0.1:3120/` 不匹配 ⇒ 判成"非回环" ⇒ 拒绝自己。

**修法**：容忍结尾斜杠，即 `…(:\d+)?\/?$`。

#### 为什么这个 bug 值得记下来

它**只可能**在真机上暴露：`getOrigin()` 按 URL 规范应返回 `scheme://host:port`
（无路径），但 ArkWeb 实际带了 `/`。写代码时按规范推演会得出错误结论，
而单元测试若也按"规范"造数据，会**一起错**、测不出来。
这也是为什么本批坚持"最小验证必须上真机"——它一次就抓到了两个层面：
① 权限闸门确实生效（它真的拦了东西）；② 拦错了对象。

### 三 修复的工程化处理（防回归）

原判定逻辑内联在 `@Component` 里，**没有任何门禁覆盖**（`check-layout-fixtures.mjs`
只编译纯 `.ets`，`@Component` 进不去）。所以做了两步：

1. **抽出纯函数** `appstate/src/main/ets/model/WebPermission.ets`：
   `isLoopbackOrigin(origin)` 与 `shouldGrantWebPermission(origin, requested)`，零依赖、可单测；
2. **加入门禁**：注册进 `check-layout-fixtures.mjs` 并新增 **21 条断言**，
   其中**把真机那条 origin 字符串（带斜杠）原样钉住**，另含"前缀伪装"
   （`http://127.0.0.1.evil.com/` 必须拒）、"只要麦克风才放行"等安全边界。

门禁从 **684 → 705 条断言，0 失败**。

#### 负测试（E344，证明断言真的会红）

把 `WebPermission.ets` 分别改回退化形态，跑门禁：

| 变异 | 结果 |
|---|---|
| ① 去掉结尾斜杠容忍（还原真机 bug） | 失败 **6** 条 ✓ 变红 |
| ② 放宽成"含回环即可"（安全性倒退） | 失败 **3** 条 ✓ 变红 |
| ③ 不再要求"只要麦克风" | 失败 **1** 条 ✓ 变红 |
| 还原后 | 705 条 0 失败 ✓ 回绿 |

### 四 装机过程中的一个环境事实（以后会再遇到）

**两个 bundle 的 Host 都硬编码 `127.0.0.1:3120`，因此互斥、不能同时运行。**
首次启动失败即因此：

```
BOOT_40_PROFILE_BOOT → Error: dsh: startup failed: 2 required plugins did not activate
  webserver (required)  Error: listen EADDRINUSE: address already in use 127.0.0.1:3120
```
实证：`/proc/net/tcp` 里的 `0C30`(3120) LISTEN socket 属 uid `20020292`（= 旧应用）。

解法：`aa force-stop` 旧应用（**只停进程、不删数据**）后再启新应用。
验证时也确实观察到核心自带的**启动自愈**生效：
`【启动自愈】上次启动失败（stage=BOOT_40_PROFILE_BOOT …）` 后本次正常起来。

### 五 数据安全复核

全程只用 `install -r`，**零卸载**。装前/装后比对既有应用：

```
com.dshm.dshclient home 元数据  装前 drwx------ 8 20020292 … 11:33
                                装后 完全相同 ✓
会话 ID                          2 个，仍在 ✓（session-21db9734… / session-b847e438…）
```

### 六 我改的 profile 种子在设备上生效（实测）

设备上 `dsh/home/profiles/ondevice/cordis.patch.yml` 的语音四行：

```
speech-to-text:            启用
speech-to-text-sensevoice: 启用
api-speech-to-text:        启用
ui-voice-input:            启用
```

⇒ `hostcore/profile` 的改动经 `pack-core --place-in-app` 烤入核心树 zip、
并由端侧 `ensureProfile()` 每启动覆盖，**确实生效**（批次十八·十一的打包链结论得到验证）。

插件面板同时显示「共 4 个 · 4 运行中」，且 SenseVoice 显示「**准备失败**」——
与批次十八·七的预判一致（本地 ASR 在鸿蒙不可用，但**不影响麦克风通路**）。

### 七 本批可复用通则

| 通则 | 说明 |
|---|---|
| **按"规范"写的判据要在真机上验** | `getOrigin()` 规范上不含路径，ArkWeb 实际返回带 `/`。只按规范推演（连单测数据也按规范造）会**一起错** |
| **权限闸门"拦了东西"要看清拦的是谁** | 一次真机自检同时暴露两件事：闸门生效了、且拦错了对象。只看"报错"会以为功能没做对 |
| **内联在 @Component 的逻辑等于没门禁** | 判定抽成纯函数后才能被 fixture 门禁覆盖；修复必须**同时**补断言，否则同一个 bug 会再来 |
| **修复要配负测试** | 三种退化变异全部变红，才证明断言真的盯住了行为（E344） |
| **多 bundle 验证需注意端口互斥** | 两个应用都硬编码 3120 ⇒ 不能同时跑；`aa force-stop` 只停进程不删数据，是安全操作 |

---
## 批次二十一（2026-09-26：路线 A 自检 —— HMS 系统语音识别**引擎可用**，端到端待真人语音）

### 一 结论（已确定的部分）

**`@hms.ai.speechRecognizer` 在本机可用，第三方应用能创建引擎并跑完整条链路。**
这是路线 A 最大的未知风险，现已排除。真机记录（`files/diag-hms-speech`）：

```
start at=2026-09-26T03:52:22.438Z
createEngine=OK                      ← 最关键：没有 1002200001
listLanguages=["zh-CN"]              ← 与文档一致（离线仅中文）
startListening=called
pcmBytes=19200 chunks=30 chunkBytes=640
onStart msg=startListening success
writeAudio=done
finish=called
onResult isFinal=true isLast=true text=""
onComplete msg=recognize complete
RESULT engine=created transcript=""
shutdown=done（自检结束）
```

`text=""` 是**预期**：那次喂的是 440 Hz 合成正弦音（不是语音），
该项自检只验"能否驱动引擎"，不验识别率。

### 二 为什么要先做"引擎自检"而不是直接集成

设备虽已确认能力面存在（`/system/etc/syscap.json` 含
`SystemCapability.AI.SpeechRecognizer`、`intell_voice_service` 在跑），
但**"能力声明存在" ≠ "第三方应用能创建引擎"**：
`createEngine` 可能因签名/商用限制抛 `1002200001 / 1002200006`。
若先写完录音+重采样+上屏再发现创建失败，代价过大。

所以新增两个**独立自检**入口（「应用」菜单），互不依赖：

| 菜单项 | 验什么 | 状态 |
|---|---|---|
| 麦克风自检 | WebView 能否拿到麦克风（`getUserMedia`） | ✅ 已通过（批次二十） |
| HMS 语音识别自检 | ArkTS 能否驱动 HMS 引擎（喂合成音，不需麦克风） | ✅ 已通过（本批） |
| HMS 端到端自检（说话） | 真麦克风 → HMS → 真实文本 | ⏳ 待用户配合（需 4 秒说话窗口） |

### 三 关键技术事实（回 SDK 逐条核实）

#### 3.1 HMS 侧硬约束（`@hms.ai.speechRecognizer.d.ts`）

| 约束 | 出处 | 影响 |
|---|---|---|
| `sampleRate` **只支持 16000** | :397-403 | 48k 音频必须重采样 |
| `writeAudio` 只收 **640 或 1280 字节** | :120-123 | 必须定长切块 |
| `audioType` 只支持 `pcm`；`soundChannel` 只支持 1；`sampleBit` 只支持 16 | :385-423 | 参数写错报 401 |
| 单次识别上限 **60000 ms** | :114-115 | 需设上限 |
| 离线模式（`online: 1`）是当前唯一模式；语言仅 `zh-CN` | :264-281 | 不做多语种 |

#### 3.2 采集侧（`@ohos.multimedia.audio.d.ts`）

| 事实 | 出处 |
|---|---|
| `AudioSamplingRate.SAMPLE_RATE_16000 = 16000` **系统直接支持** | :1074 |
| `SOURCE_TYPE_VOICE_RECOGNITION = 1`（专为语音识别设计的输入源） | :6935 |
| `read()` 自 API 11 **已废弃**，改用事件 `on('readData', cb)` | :7312-7326 / :7722 |

⇒ **可以按 16000 Hz 直接采集**，链路比"录 48k 再重采样"更短。

#### 3.3 为什么仍保留重采样工具

`appstate/src/main/ets/model/SpeechPcm.ets` 提供 `resamplePcm16` 等纯函数。
ArkTS 侧 16k 直采不需要它，但**WebView 的 `getUserMedia` 实测给 48000 Hz**
（见 `diag-mic-probe` 的 `sampleRate:48000`）——
若将来复用那条音频（例如让 Web 侧录音、Host 侧识别），就必须转换。
保留它是为了不把那条路堵死，而不是当前链路需要。

### 四 一个实现要点：`readData` 的块大小与 `writeAudio` 不匹配

`readData` 每次给的字节数**由系统决定、不保证是 640/1280**，
而 `writeAudio` 只收这两种长度。若直接把每次回调的数据丢给 `writeAudio`，
长度不符就会被拒（表现为识别无结果，且不报明确原因）。

正确做法是**累积 + 切片**：把回调数据先攒进 `carry`，凑够 640 就送一块，
余数留到下次。**不能丢弃余数**——丢余数会丢字（对中文尤其明显）。
实现见 `WebApp.ets` 的 `hmsE2eRecognize` 里 `onData` 的注释。

### 五 新增的门禁覆盖（防"换算写错只能靠真机听结果"）

`SpeechPcm.ets` 已注册进 `check-layout-fixtures.mjs`，新增 **40 条断言**：

- 常量与文档一致（16000 / 640 / 1280 / 60000 / 2 字节）；
- 块大小校验：**639、1281、960 都必须判非法**（960 看着合理但文档不支持）；
- 分块：整除、有余数（余数丢弃）、不足一块、非法块大小；
- 重采样：48k→16k 恰好 3:1；空输入/非法采样率/半样本都不炸；44.1k→16k 也工作；
- **★ 符号位保真**：构造 ±1000 交替方波，重采样后必须有负值
  （写成无符号会让负半周削顶失真——这类错误在真机上只是"识别变差"，很难归因）；
- 常数信号重采样后仍为同一常数（无漂移）；
- 测试音生成与时长换算。

门禁 **705 → 740 条断言，0 失败**。

> 顺带记一次门禁的**正向作用**：我最初把"100ms@16k 的测试音按 640 切"写成期望 2 块，
> 门禁报实际 5 块（3200÷640=5）——**是我的期望值算错，代码是对的**。
> 已改为 5，并补了"按 1280 切 ⇒ 2 块余 640 丢"这条对照。

### 六 数据安全

全程只用 `install -r`，**零卸载**；既有应用数据未变：

```
com.dshm.dshclient home  drwx------ 8 20020292 … 11:33（与之前一致）
会话数                    2（未变）
```

### 七 本批可复用通则

| 通则 | 说明 |
|---|---|
| **"能力声明存在" ≠ "能用"** | syscap 有 `AI.SpeechRecognizer` 只说明能力面在；能否 `createEngine` 是另一回事。集成前先用**最小自检**问一次 |
| **先验最贵的不确定性** | 若先写完整链路再发现引擎创建失败，返工成本远大于先跑 12 行自检 |
| **自检要与真实输入解耦** | 合成音自检证明"引擎链路通"，且不做录音、可重复；真实语音自检另做一项。分开后失败能定位到阶段 |
| **两边的事件块大小不一致时要累积** | `readData` 长度不定、`writeAudio` 只收定长 ⇒ 必须累积切片，且**不能丢余数**（会丢字） |

---
## 批次二十二（2026-09-26：路线 A 端到端**通过** —— HMS 识别真实语音出文本，附三个真机坑）

### 一 结论

**用户指令「直接把 HMS 的语音识别接入」的可行性已验证成立。** 真机两轮实测：

| 轮次 | 用户所说 | HMS 识别结果 | 录音峰值 |
|---|---|---|---|
| 1 | 一二三四五 | `12345。` | `peak=20 rms=8`（音量很小仍识别对） |
| 2 | 一二三四五六七 | `1234567。` | `peak=265 rms=97` |

第二轮完整日志（`files/diag-hms-e2e`，两个修复后的干净结果）：

```
capturer=created rate=16000 ch=1 s16le src=VOICE_RECOGNITION
createEngine=OK
onStart msg=startListening success
onStart 已到，开始采音
capturer.start=OK 录音 5000ms —— 请现在说话
onEvent code=1 msg=speech started
onResult isFinal=false raw="一"        merged="一"
onResult isFinal=false raw="一二"      merged="一二"
onResult isFinal=false raw="一二三"    merged="一二三"
onResult isFinal=false raw="一二三四"  merged="一二三四"
onResult isFinal=false raw="一二三四五" merged="一二三四五"
onResult isFinal=false raw="一二三四五六" merged="一二三四五六"
onResult isFinal=false raw="一二三四五六七" merged="一二三四五六七"
capturer.stop=OK 收到159360字节 送出249块 peak=265 rms=97
onResult isFinal=true  isLast=true raw="1234567。" merged="1234567。"
onComplete msg=recognize complete transcript="1234567。"
RESULT transcript="1234567。" bytes=159360 chunks=249
released（自检结束）
```

⇒ `createEngine`（最大未知风险）+ `AudioCapturer` 16k 采音 + 流式识别 + 定稿，**全通**。

### 二 三个真机才暴露的坑（都不是 HMS 的问题）

#### 坑 1：`startListening` 是**异步**的，必须先等 `onStart` 再 `writeAudio`

现象：紧接 `startListening` 就 `writeAudio`，报

```
asr.onError code=1002200010 msg=Write audio failed because the start listening is failed.
```
而且 `onStart` 是在**报错之后**才到的 ⇒ 确认 `startListening` 异步完成。

**为什么容易漏**：接口签名是 `startListening(params: StartParams): void`，
从类型上完全看不出"要等回调"。不等就送音频，整段被丢弃、识别返回空，
现象只是"识别不出文本"，而错误码与 onStart 交叉出现、不易归因。

修法：等 `onStart`（实测 ~200ms 内到）再开始采音/送音频。

#### 坑 2：`onResult` 给的是**累计文本**，不是增量片段

真机序列（原文逐条）：`"一"` → `"一二"` → `"一二三"` → … → `"12345。"`。

天真写法 `acc += result.result` 会把累计文本再叠一遍：

```
首次实现的错误结果： "一一二一二三一二三四一二三四五12345。"
正确：               "12345。"
```

修法：抽成纯函数 `SpeechPcm.mergeTranscript(previous, incoming, isFinal, isLast)`
——**信 `isFinal`/`isLast` 定稿**；非定稿时取更长的（累计），
但若 incoming **短于** previous（引擎在某分句后重置累计）则**追加**而非丢弃，
否则后一句会被前一句吃掉。

#### 坑 3：识别结束后仍在送音频

`onComplete` 之后还出现 `1002200010`：因为 5 秒录音窗口比识别结束晚
（识别在录音窗口中途就 complete 了）。不是致命错误，但真实集成时会白耗 CPU。
修法：`onComplete`/`onError` 置 `finished` 标志，`onData` 里据此停止送音频。
修复后该错误码出现次数 **1 → 0**。

### 三 一个被**纠正的误判**（值得记）

我曾用「TTS 朗读 → 麦克风录 → 识别」做自动往返自检，两次都得到空文本，
一度倾向"HMS 可能不可用"。实测澄清：

| 观察 | 解释 |
|---|---|
| `tts.onComplete` 在 **74ms** 就返回 | 6 个字不可能这么快 ⇒ 并未真正合成/播放 |
| `tts.onData` **一次都不触发**（chunks=0） | `speak` 的文档原文是 *"Synthesizes text to be **played**"*，它是**播放**接口；`onData` 是可选回调，本机未触发 |
| 麦克风 `peak=0 rms=0` | 录到的是**静音** ⇒ ASR 返回空是**正确行为** |

⇒ 那两次空文本**不能**用来说明 ASR 不可用。为此加了 `SpeechPcm.isNearSilence(peak)`，
在日志里显式标注"录到静音 ⇒ 空结果属预期，不能判定 ASR 不可用"——
**避免把"没声音"归因成"引擎坏了"**，那会让人去改本来没坏的东西。

### 四 负测试发现的断言漏洞（E344 的价值再现）

给 `mergeTranscript` 写了断言后跑负测试，结果：

| 变异 | 首次结果 | 补断言后 |
|---|---|---|
| ① 还原成 `+=` 累加（真机 bug） | ✓ 4 红 | ✓ 6 红 |
| ② **丢掉 `isFinal` 定稿分支** | **★ 仍全绿** | ✓ 2 红 |
| ③ 分句重置时不追加 | ✓ 1 红 | ✓ 2 红 |

变异 ② 没被抓住的原因：我原先的断言**只验"结果对不对"，没验"依据是什么"**。
真机那条序列里每条恰好都比上一条长，所以"只比长度"的退化实现也能得出同样答案。

补上能区分的用例——**定稿比中间态更短**（中文数字转阿拉伯数字正是如此）：

```
mergeTranscript("一百二十三", "123", isFinal=true, isLast=false)
  正确（信 isFinal）  ⇒ "123"
  退化成只比长度      ⇒ "一百二十三123"
```

⇒ 门禁 **740 → 758 断言，0 失败**（新增：merge 语义 12 条 + 静音判别 6 条等）。

### 五 关键技术事实（回 SDK 逐条核实）

| 事实 | 出处 |
|---|---|
| HMS 识别只收 **16000 Hz** / `pcm` / 单声道 / 16 位 | `@hms.ai.speechRecognizer.d.ts:385-423` |
| `writeAudio` 只收 **640 或 1280 字节** | :120-123 |
| `AudioSamplingRate.SAMPLE_RATE_16000` 系统直接支持 | `@ohos.multimedia.audio.d.ts:1074` |
| `SOURCE_TYPE_VOICE_RECOGNITION = 1` 专为 ASR；`read()` 自 API 11 废弃 | :6935 / :7312-7326 |
| TTS 采样率在 `onStart` 的 `StartResponse`，**不在** `onData` 的 `SynthesisResponse` | `@hms.ai.textToSpeech.d.ts:178-186` vs `:653-676` |

### 六 `readData` 与 `writeAudio` 的块大小不匹配（实现要点）

`readData` 每次给的字节数由系统决定、**不保证 640/1280**，而 `writeAudio` 只收这两种。
必须**累积 + 切片**：攒进 carry，凑够 640 送一块，余数留到下次。
**不能丢余数** —— 会丢字（对中文尤其明显）。

### 七 数据安全

全程只用 `install -r`，**零卸载**；既有应用数据未变（会话 2 个、home 元数据一致）。
两 bundle 的 Host 都硬编码 `127.0.0.1:3120` ⇒ 互斥，切换时用 `aa force-stop`（只停进程）。

### 八 本批可复用通则

| 通则 | 说明 |
|---|---|
| **`void` 签名的接口也可能是异步的** | `startListening` 返回 `void`，但必须等 `onStart` 才能 `writeAudio`。类型签名不能证明调用时机 |
| **流式回调要确认"累计还是增量"** | HMS 的 `onResult` 给累计文本。写 `+=` 之前先看两条连续回调是否包含彼此 |
| **"空结果"要先排除"没输入"** | 空文本常被归因成引擎坏了，实际可能是没声音。加一个幅度判别就能分开 |
| **负测试要挑"能区分判据"的用例** | 只验结果会漏掉"判据被换掉但巧合结果相同"的情况（本批变异 ②）。找出两条判据**分道扬镳**的输入才有鉴别力 |
| **自动自检的替代品若行为不明，不要据此下结论** | TTS 那条路两次给空文本，差点被当成"ASR 不可用"。先查清"它到底有没有工作"再采信结果 |

---
## 批次二十三（2026-09-26：官方语音按钮接 HMOS 系统识别 —— 架构路线 + 代码审核）

### 一 目标与结果

用户指令：**把 dsh 插件里的语音识别换成 HMS，让官方那个麦克风按钮直接可用**。

真机已验证（本轮实测读数）：

| 检查项 | 之前 | 现在 |
|---|---|---|
| 麦克风按钮标签 | `打开语音输入引导`（usable=false） | **`开始录音`**（idle 且可用） |
| 点击后 | 弹"需安装依赖" | **`正在录音…` / `停止并识别`**（进入录音态） |
| 识别完成 | — | **文字进入输入框草稿**（`textField`，非已发送消息） |
| `failed to import` | 1 次 | **0 次** |

识别文字落在草稿而非消息区，判据（真机 UI dump）：

```
[genericContainer] y=1217..1439        ← 输入框容器
  [textField] y=1231..1294  text="（HMS 占位）语音识别链路已验证 #1"   ← 草稿
  [button]    y=1323..1373  text="开始录音"    ← 语音按钮已复位
  [button]    y=1315..1375  text="发送消息"    ← 草稿非空才出现
消息区（y<1150）里没有任何该文本节点 ⇒ 未被发送
```

### 二 架构：为什么必须"改现有包"而不是"新增插件包"

**【用户的第二个建议（做成符合 dsh 要求的独立插件）被 dsh 自身限制堵住】**

实测：新建一个独立 provider 包、用 profile 的 `insert` 挂上，结果

```
dsh: warning: 1 entry did not activate
speech-to-text-stub (@deepseek-ai/dsh-speech-to-text-stub): failed to import
```

原因（读 loader 源码确认，非猜测）：`dsh-app-boot` 的 `HostResolvedRootInclude.import()`
（`lib/index.js:3706-3716`）对**裸包名**走 `internal.import(specifier, bareModuleBaseUrl, {})`，
而可解析的包必须**属于某 bundle 的 dependencies 闭包**：

| 包 | 是否在某 bundle 闭包内 | 能否解析 |
|---|---|---|
| `dsh-host-directory-picker-browse` | ⊂ `dsh-web-app`.dependencies | ✅ 能 |
| `dsh-speech-to-text-stub`（新增） | ⊄ 任何 bundle | ❌ `failed to import` |

且 `profile-boot` 调 `boot(...)` 时**没传** `bareModuleBaseUrl`（`main.js:3838-3843` 只有 4 个实参），
所以也没有"额外搜索路径"可借。**新增包必须自带一个 bundle** —— 那是另一个量级的改动。

**【采用的路线】改 `dsh-experimental-speech-to-text-sensevoice` 的 `apply`**

它已在 `dsh-experimental-voice-input-bundle` 的 dependencies 内、profile 也已有它的行
⇒ **零新增接线**。注入手法（由 `pack-core` 的 `patchSensevoiceForHms()` 在打包期完成）：

```js
// ① 把 hostcore/speech-provider/index.js 拷成该包的 lib/hms-provider.js
// ② 在 lib/index.js 顶部加一行**相对 import**
import { hmsApply, hmsProviderInject } from "./hms-provider.js";
// ③ 把末尾导出换成 HMS 版
export { Config, hmsApply as apply, hmsProviderInject as inject, name };
```

相对说明符由 Node **按文件位置**解析，不经 bare 包表 ⇒ 必然可用。
注入后形如 `lib/index.js` 的 `apply` 是 HMS 实现，`inject` 变成 `["speechToText"]`
（去掉 `subprocess` —— HMS 不起子进程）。

### 三 数据流（端到端）

```
官方麦克风按钮（WebView）
  → MediaRecorder 录音 + OfflineAudioContext 重采样到 16k
  → encodeWave()：44 字节 canonical WAV 头
  → base64 → RPC speech/transcribe
    → api-speech-to-text：Buffer.from(base64) + validateWave()
      → hms-provider.transcribe()            ← 跑在 Host(Node) 进程
        → 写 $DSH_HOME/speech-to-text/hms-bridge/<id>.req
          → ArkTS 侧 HmsSpeechBridge.ets 轮询取走
            → speechRecognizer（HMOS 系统识别）
          ← 写 <id>.done / <id>.fail
        ← 读回识别文本
      ← 返回 { text, language }
    → 官方 UI 把 text 插进输入框草稿（内部 actions.insertText）
```

**为什么要桥**：`speechRecognizer` 是 **ArkTS API**，Node 进程调不到；
而原生层（`dshhost.cc`）只暴露 `startHost`/`isHostRunning`/`stopHost`，没有消息通道。
所以用**文件队列** —— 与项目既成先例同手法（`host-stop-request`、`host-exit-mode`、
`install-queue`；两侧同 UID、同文件系统视图）。

队列目录的推导**不新增配置项**：provider 的 `dataRoot` 由 bundle 设成
`dshHomePath('speech-to-text','sensevoice')` ⇒ `dataRoot = $DSH_HOME/speech-to-text/sensevoice`
⇒ `dirname(dataRoot)/hms-bridge`。ArkTS 侧用 `filesDir + "/dsh/home/speech-to-text/hms-bridge"`。
真机验证：全盘**只有一个** `hms-bridge` 目录，两侧指向同一处。

### 四 三个关键 bug（都经真机/离线复现确认）

#### bug 1 `Speech provider does not support language: auto`

服务端 `selectedProvider()`（`dsh-experimental-speech-to-text/lib/index.js:135`）校验
`provider.info.languages.includes(language)`，而服务 config 的 `language` **默认是 `"auto"`**（`:10`）。
HMS 的真实能力只有 `zh-CN`（真机 `listLanguages()` 只返回 `["zh-CN"]`）。

修法**必须两处同时改**：provider 只声明 `zh-CN` + profile 里钉 `language: zh-CN`。
只改 provider ⇒ 报不支持 auto；只改 profile ⇒ 谎报能力。

**连带发现**：profile 的覆盖是**整块替换** config（文件开头第 8 行纪律 + 实现
`applyEntryPatches` 的 `target[key] = value`）⇒ 只写 `language` 会把 bundle 设的
`defaultProvider` 抹掉。所以两个键都必须写出来。

#### bug 2 队列可能被永久堵死（审核时发现）

`takeNextRequest` 每轮取 `reqs.sort()[0]`；若该 `.req` 内容不完整（不以 `}` 结尾），
它**每轮都返回 `undefined`**，而原 `reapStale` 只清 `.wip/.done/.fail`、**不清 `.req`**
⇒ 该文件永远是 `reqs[0]`，**整个队列被永久堵死**直到应用重启。
用户表现是"语音按钮再也不动"。已把 `.req` 纳入陈旧回收（阈值 10 分钟）。

#### bug 3 超时与长录音错配（审核时发现，**必然发生**）

ArkTS 侧**按实时节奏送音频**（每 640B 睡 20ms ⇒ 送完耗时 ≈ 音频时长本身），
而 API 允许录音最长 120 秒（`maxDurationSeconds` 默认 120）。
原 Host 超时是固定 25 秒 ⇒ **录 25 秒以上必然 Host 先超时**，而 ArkTS 还在正常处理。
已改成 `max(25s, 音频时长 + 15s)`，让超时只用于兜住真的卡死；
并把实际预算与音频时长写进错误消息，便于下次诊断。

### 五 被**纠正的两处不实注释**（代码与注释不一致）

| 位置 | 原注释 | 实际行为 |
|---|---|---|
| `SpeechPcm.slicePcmChunks` | "无法整除的尾巴丢弃（宁可丢也不要报错）" | 行为正确，但桥的注释又说"**不能丢余数**（会丢字）"—— 自相矛盾 |
| `HmsSpeechBridge` 头部约束 3 | "必须切片，且不能丢余数" | `slicePcmChunks` 就是会丢尾巴。实测量化：16k 单声道 ⇒ 32000 B/s，640 B = 20ms；**整数秒录音余数为 0**（1/3/5/10/60 秒实测），只有非整数秒才丢，最多 639 B ≈ 20ms |

已统一为如实描述，并把"整数秒录音余数为 0"做成门禁断言。

### 六 新增门禁断言（758 → 768 条，0 失败）

两侧（Host 的 `hms-provider.js` 与 ArkTS 的 `SpeechPcm`）各自定义了一份 WAV 头常量
（语言不同、无法共享模块）⇒ 把"两处写的是同一个值"变成断言，避免"一边对一边错"：

```
WAV 头长度 = 44 / WAV 每秒字节数 = 32000 / 每秒字节数 = 采样率 × 2
★Host 侧也写着 44（读 hostcore/speech-provider/index.js 核对）
★Host 侧也写着 32000（同上）
整数秒录音 1/3/5/10/60s 的字节数能被 640 整除
```

负测试（把 Host 侧改成 40 / 16000）：两条**都变红**，还原后回绿 ✓

### 七 本轮清理

- 删除失败方案的残留 `hostcore/speech-stub/`（2 文件）与 `pack-core` 里的 `injectSpeechStub`
- 删除未使用的 `BridgeResultPayload` 接口声明
- 新增 `WAV_HEADER_BYTES` / `WAV_BYTES_PER_SECOND` 常量（appstate 定义，两侧引用）

### 八 遗留待办（明确记录，便于后续接手）

| 项 | 说明 | 建议时机 |
|---|---|---|
| **`build-profile.json5` 的临时 `bundleName: com.dshm.micverify`** | 验证专用，出厂/发布前**必须**改回 `com.dshm.dshclient` 或删除该行 | 验证结束后立刻 |
| `sensevoice` 包内的 SenseVoice 死代码 | `apply` 已被顶掉，但 `index.js` 顶部 11 行 import（zod / dsh-timeout / sherpa-onnx 相关）**仍会在加载期求值**；`Config` 的 19 个字段只有 `dataRoot`/`providerId` 被用到 | 桥跑通且有回归保护后 |
| `speech-to-text-sensevoice` 这一行**名不副实** | 跑的是 HMS，却叫 sensevoice；唯一原因是"它已在 bundle 依赖闭包内，改它零新增接线"。正确终局是造自己的 bundle（真独立插件） | 另一个量级，单独立项 |
| 探针污染过用户的会话标题 | 早期探针改了 `document.title` ⇒ dsh 据此建了一个名叫 `__DSHM_VOICE_TEST__` 的会话（真机 UI 列表可见）。探针代码已改为"先清空再插入、草稿非空则跳过"，但**那个会话仍在**，需用户手动删除 | 用户自行处理 |

### 九 数据安全

- 全程只用 `install -r`，**零卸载**；`com.dshm.dshclient` 数据未变（会话 2 个）
- 两 bundle 的 Host 都硬编码 `127.0.0.1:3120` ⇒ 互斥，切换时用 `aa force-stop`（只停进程）
- `hdc file send` 与 `hdc shell` 重定向**都被 SELinux 拒绝**
  （shell 是 `u:r:sh:s0`，应用是 `20020293`）⇒ 无法从 PC 直接往队列投喂测试请求，
  桥的 ArkTS 半必须靠真实语音验证。这一点已如实记录，不假装可用脚本验证。

### 十 本批可复用通则

| 通则 | 说明 |
|---|---|
| **dsh 的裸包名解析绑定 bundle 依赖闭包** | 想加插件包，必须让它进入某 bundle 的 dependencies；否则 `failed to import`。改现有包是零接线替代 |
| **ESM 的 import 在加载期求值，改 `apply` 不能省掉它** | 顶掉 `apply` 只隔离了行为，不隔离依赖加载 |
| **profile 的 config 覆盖是整块替换** | 只写一个键会抹掉其余的；改前必须先看现有 config 有哪些键 |
| **"文件队列"这类桥要设计自愈** | 只要有一个残留文件能永久占据队首，整个通道就死了。陈旧回收必须覆盖**所有**后缀 |
| **超时必须随工作量伸缩** | 固定超时 + 按实时节奏处理 = 长输入必然超时。这类错配是"必然发生"，不是概率问题 |
| **两侧各写一份常量时，用门禁断言钉住一致性** | 否则一侧改动后症状是"结果莫名变差"，极难归因 |

---

## 批次二十五（2026-09-26：官方语音按钮接入完成 —— 根因是 `recognizerMode` 关掉了 VAD，附一条方法论教训）

**结论：官方麦克风按钮 → HMOS 系统识别 → 文本填入输入框，全链路通过。**
真机读数（说「12342234」）：

```
12:33:21.399  开始识别 pcm=149760B（4.68s）
12:33:22.801  onEvent code=1 msg=speech started    ← VAD 检测到语音
              onResult "一" → "一二" → "一二三" → "一二三四" → …"一二三四二二三四"
12:33:23.645  onEvent code=3 msg=speech stopped    ← VAD 检测到语音结束
12:33:23.652  onResult "12342234。" isFinal=true isLast=true
12:33:23.667  结束 finished=true len=9
输入框值: "12342234。。"                            ← 已填入（句号是先前失败尝试的残留）
```

### 一 根因：`recognizerMode: 'long'` 让引擎的 VAD 失效

时间线（同一份采集与识别代码，唯一变化的就是这一个参数）：

| 时间 | `recognizerMode` | `onEvent`（VAD 事件） | 结果 |
|---|---|---|---|
| 11:09 | 未设（默认） | — | `234。` ✓ |
| 11:15 | 未设（默认） | — | `子234。` ✓ |
| 11:20 | **★ 改成 `long`** | **★ 一条都没有** | — |
| 11:21 ~ 12:22 | `long` | **★ 一条都没有** | 连续 5 次空 ✗ |
| 12:33 | **★ 移除回默认** | **★ `speech started` / `stopped`** | `12342234。` ✓ |

**机制**：`onEvent` 是 HMS 上报 VAD（语音活动检测）事件的回调。设 `long` 期间该回调
**一条都不出现** ⇒ 引擎的 VAD 没有工作 ⇒ 无法判断"哪里有语音" ⇒ 整段被判无语音
（输出空，或只输出一个「。」）。移除后 `code=1 speech started` / `code=3 speech stopped`
立刻出现，识别随即完全正确。

文档（`@hms.ai.speechRecognizer.d.ts:288-291`）只列了 `short`/`long` 可选，
**未说明 `long` 的语义** —— 这是它容易误导的原因。

### 二 被实测排除的方向（都有硬证据，供后来者省时间）

| 方向 | 排除依据 |
|---|---|
| 音频内容 | 成功与失败的音频声学指标几乎相同（语音占比 64% vs 57%，峰值 rms 14033 vs 13048） |
| 传输链 | 采集侧 `native-btn-audio.wav` 与桥收到的 `last-audio.wav` **sha256 完全一致** |
| 音频格式 | 16 kHz / 单声道 / 16 bit，WAV 头逐字段正确 |
| 采样率 | 基频 143~148 Hz（正常男声），频谱重心与曾成功样本同级 |
| 音频长度 | 多变体自检：原样（4.68 s）与截前 3 s **结果相同**（都正确） |
| 音量 | 归一化到 80% 满量程后识别**反而变差**（`第二三次到二分组。`） |
| 调用路径 | A/B 对照：自检路径与桥路径对同一份音频输出**完全相同** |
| 采集时序 | 移除预热采集后仍失败，说明不是"识别期间占用麦克风" |
| `onEvent` 缺失 | 恢复该回调后事件仍不出现 —— 因为真正的原因是 VAD 已被参数关掉 |

### 三 多变体自检（一次点击回答多个假设）

同一份音频的 5 个变体，绕开了"每次只测一个假设、每次都要用户说话"的低效循环：

| 变体 | 结果 | 说明 |
|---|---|---|
| A 原样 | `12342234。` ✓ | 音频**完全正确** |
| B 前 3 秒 | `12342234。` ✓ | 与长度无关 |
| C 降 3 倍 | `` | 排除"实际 48k 被当 16k" |
| D 升 2 倍 | `` | 排除"实际 8k 被当 16k" |
| E 归一化 | `第二三次到二分组。` | 归一化后变差 ⇒ 音量本已合适 |

### 四 期间走过的弯路（如实记录）

1. **预热采集**（页面就绪即常驻启动采集）：本意是消除 ~600 ms 启动延迟，
   实际引入了"识别期间占用麦克风"，造成回归。**已移除**。
2. **裁静音 / 采集闸门**：在错误的根因假设下添加，均无效果。**已移除**。
3. **AEC 补丁**：一度认为"`echoCancellation` 会改变麦克风通路"，
   补丁确认生效但识别仍失败 ⇒ 不是根因。补丁本身保留（无害）。
4. **清理时误删 `onEvent`**：批量删代码时把 SDK 定义的 5 个回调之一当诊断代码删掉，
   再次造成回归。**已恢复，并改用"三道检查"的删除流程**（见下）。

### 五 本批可复用通则

| 通则 | 说明 |
|---|---|
| **改动能回退时，先回退再继续排查** | 本次的根因是 11:20 加的一个"看起来无害"的参数。此后我在它之上又加了 3 项改动，方向全错。把"改动时刻 vs 结果"排成时间线一行就能看出分界点 |
| **必须验证"设备是否真的跑上了新代码"** | 核心树按 **zip 字节数**判断是否重解包；只改 ArkTS 侧（进 HAP）不影响 zip，但改 `hostcore/**` 后若 zip 大小未变，设备**不会更新**。装机后固定删 `.dshm-bundled-stamp` 可消除这个不确定性 |
| **批量删代码必须带"保留清单"校验** | 本次两次批量清理各搞坏一次文件：一次删掉了相邻的正常常量，一次误删 `onEvent`。可靠流程：干跑算区间 → 检查①保留项定义不在删除区 ②大括号配平不变 ③删除后保留项仍在 → 才写文件 |
| **诊断代码也算代码，清理后要重验功能** | "能构建"不等于"链路完整"。清理后应当复测一次端到端，而不是假定无影响 |
| **`onEvent` 是 SDK 要求的 5 个回调之一** | `RecognitionListener` = `onStart` / `onEvent` / `onResult` / `onComplete` / `onError`（`@hms.ai.speechRecognizer.d.ts:188-255`）。它是**功能必需**，不是可选的诊断钩子 |
| **"有语音"与"引擎认为有语音"是两件事** | 用 PC 侧频谱/包络只能证明音频里有语音；引擎是否判定为语音取决于 VAD，而 VAD 可能被参数或回调注册情况左右。`onEvent` 是否出现是**引擎侧**最直接的证据 |

### 六 数据安全

- 全程只用 `install -r`，**零卸载**；`dsh/home` 下用户数据未被触碰
- 装机后删的 `.dshm-bundled-stamp` 是**安装元数据**（几十字节），只影响"下次启动是否重解包核心代码"
- 清理的诊断文件位于 `haps/entry/files/`（应用私有目录），与 `dsh/home` 下的会话/凭据点分属不同路径

---


---

## 批次二十六：语音识别换为 SenseVoice 端侧离线模型（**真机端到端验证通过**）

> 2026-09-27。**已完成真机验证**：模型加载成功、识别行走 SenseVoice 路径、
> 端到端出字、零失败。以下是真机读数与构建侧硬证据的完整记录。

### 零 真机读数（2026-09-27 01:03，决定性）

```
# provider 侧 requests.log（投递 + 结果 + 耗时）
2026-09-27T01:03:19.037Z transcribe #1 whole audioMs=4640 bytes=148524
2026-09-27T01:03:19.847Z transcribe #1 done 812ms -> "一二三四二二三四"
2026-09-27T01:03:41.900Z transcribe #2 whole audioMs=4340 bytes=138924
2026-09-27T01:03:42.302Z transcribe #2 done 403ms -> "三二三四四二三四"

# 桥侧 ASR 日志（证明走的是 SenseVoice，不是回退 HMS）
2026-09-27T01:03:19.546Z 开始识别 pcm=148480B src=bridge
2026-09-27T01:03:19.546Z 改用 SenseVoice pcm=148480B      ← ★
2026-09-27T01:03:42.062Z 开始识别 pcm=138880B src=bridge
2026-09-27T01:03:42.062Z 改用 SenseVoice pcm=138880B      ← ★

# 桥心跳（预热 + 结果）
2026-09-27T00:44:45.151Z started dir=.../hms-bridge
2026-09-27T00:44:47.459Z 预热成功 模型已就绪=true          ← ★ 230MB 模型加载成功，约 2.3s
2026-09-27T01:03:19.768Z done id=...-1 text=一二三四二二三四
2026-09-27T01:03:42.213Z done id=...-2 text=三二三四四二三四
```

**四条结论**

1. **230MB 模型在真机加载成功**（`预热成功 模型已就绪=true`，约 **2.3 秒**）。
   这排在先前"最大未知"之首（230MB 经 `OH_ResourceManager_OpenRawFile`+`GetRawFileSize` 读取），
   **现已排除**。2.3s 远低于 provider 的 25s 预算 ⇒ `warmUp()` 是保险而非必需。
2. **识别行走 SenseVoice**（`改用 SenseVoice`），**未回退 HMS**。
3. **端到端出字**：两句都正确返回，用户确认"识别率很高，基本都是对的"。
4. **零失败**，且**识别耗时 812ms / 403ms** —— 明显快于 HMS 时代的 4~5 秒
   （HMS 那 4~5 秒其实是被迫等待端点检测收尾）。

**与 HMS 时代的关键对比**

| 项 | HMS（批次二十~二十五） | SenseVoice（本批次） |
|---|---|---|
| 单会话音频上限 | **4~5 秒**（VAD 提前收尾，无法配置绕过）| 无（批处理，PC 侧已证 16.78s / 111.8s 完整）|
| 识别耗时 | 4~5 秒（等端点）| 812ms / 403ms |
| 参数可调性 | 无可用参数（七轮实测穷尽）| 模型/语言/VAD 全可配 |
| 长音频 | **只出开头** | 完整 |

> 说明：本轮真机两段音频是 4.64s / 4.34s（用户口述的数字串），
> **未覆盖 >5s 的真机长音频**。长音频的完整性由 PC 侧同通路严格验证
> （16.78s 三段全出、111.8s 二十段全出），真机长句仍建议再口述一次确认。

### 一 为什么换（前情：批次二十~二十五）

### 一 为什么换（前情：批次二十~二十五）

HMS `speechRecognizer` 是流式听写引擎，**单会话只处理开头 4~5 秒**，
七轮实测确认这不是配置问题（详见 `70-鸿蒙移植踩坑与修复总览.md` §10）。
故换用 dsh 官方那条路的模型 SenseVoice（离线批处理，无端点截断）。

### 二 构建侧硬证据（本轮已核，全部为可复现读数）

| 项 | 读数 | 核验方式 |
|---|---|---|
| sherpa-onnx 官方鸿蒙 HAR | `sherpa_onnx@1.13.3`，OHPM 58 个版本 | `ohpm info sherpa_onnx` |
| 四个库架构 | 全部 `ELF64 / AArch64` | `llvm-readelf -h` |
| 依赖闭包 | 仅系统库 + 包内互依（**零 glibc**） | `llvm-readelf -d` |
| 模型三件套 | 与官方 `assets.json` 的 **sha256 逐字节一致** | 从 HAP 抽出后重算 |
| 代码在字节码里 | `SenseVoiceRecognizer`/`senseVoice`/`OfflineRecognizer` 均可搜到 | 读 `ets/modules.abc` |
| provider 已换 | `name='SenseVoice 离线识别'`、`location='host-local'` | 从 HAP → core zip → 解包读 `hms-provider.js` |
| 回归门禁 | 8 项全过 | 见下 |

**一处必须记住的版本落差（避免误判）**

| 侧 | 版本 | 来源 |
|---|---|---|
| 端侧（进 HAP） | **sherpa_onnx 1.13.3** | OHPM HAR |
| PC 侧验证 | **sherpa-onnx-node 1.13.8** | npm |

OHPM 上 `sherpa_onnx` 的 `dist-tags.latest = 1.13.3`（58 个版本里最高就是它），
**没有 1.13.8**；而 `sherpa-onnx-node` 官方 1.13.8 只在 npm 分平台包里。
⇒ PC 侧的识别结果是 **1.13.8 的行为**，与端侧的 1.13.3 存在 5 个补丁版本的差。
本次涉及的 API（`OfflineRecognizer`+`senseVoice`+`Vad`）在这两个版本间**未见变更**，
但**严格来说 PC 侧结论是旁证，不是等价替代**。若端侧出现"配置对但结果异常"，
版本落差应列入排查项。

**模型与配置的 PC 侧独立复现（本轮新增，把"模型/配置"与"端侧集成"解耦）**

思路：**onnx 模型是平台无关的**，而 npm 上有 Windows 版 `sherpa-onnx-node`。
用**同一份模型 + 逐字段相同的配置**在 PC 上跑，即可独立证明"模型可用"与"配置正确"，
不必等真机。若端侧之后失败，原因必在 OHOS 集成层（NAPI / rawfile / 上下文）。

```
$ npm i sherpa-onnx-node@1.13.8          # 装到临时目录，不进仓库
# 用 entry/src/main/resources/rawfile/sensevoice/ 下的同一份模型
# 配置与 SenseVoiceRecognizer.ets 逐字段一致

模型加载完成
  zh.wav   5.59s   200ms  lang=<|zh|>  "开饭时间早上九点至下午五点"
  en.wav   7.15s   253ms  lang=<|en|>  "the tribal chieftain called for the boy and presented him with fifty pieces of code"
  ja.wav   7.20s   255ms  lang=<|ja|>  "うちの中学は弁当制で持っていきない場合は50円の学校販売のパンを買う"
  silence-3s.wav 3.00s 120ms lang=<|ko|> "그"    ← 静音非语音，乱码属正常
```

**三条硬结论**

1. **模型可用**（目标②）：239233841 B 的 int8 模型能被 onnxruntime 正常加载，
   加载耗时 **1258 ms** —— 远低于 provider 的 25 s 预算。
   ⇒ `warmUp()` 是稳妥保险，**不是救命措施**（原先担心的"加载 20 秒"没有发生）。
2. **长音频完整识别**：`5.59s / 7.15s / 7.20s` 的音频**全部完整出文本**，
   而 HMS 的上限只有 4~5 秒 ⇒ **核心收益被独立证实**（不依赖端侧）。
3. **VAD 切分路径正确**：用与 ArkTS **相同**的 VAD 参数
   （`SileroVadConfig(model,0.5,0.25,0.5,512,20)` + `TenVadConfig('',…,256,20)`
   + `VadConfig(…,16000,false,1)`）构造成功，切分与拼接均正确：
   ```
   VAD 构造成功  windowSize=512
   zh.wav  5.59s  VAD段数=1  205ms  "开饭时间早上九点至下午五点"
   en.wav  7.15s  VAD段数=1  232ms  "the tribal chieftain called for the boy..."
   ```

**配置一致性核对**：`FeatureConfig` 的默认值就是 `sampleRate=16000, featureDim=80`
（HAR 源码 `NonStreamingAsr.ets:37-38`），与 PC 测试里显式写的值**相同**
⇒ 测试**代表** ArkTS 路径（那边没设 `featConfig`，走默认）。

**长音频完整识别（严格验证，核心收益）**

把中文样本 `zh.wav` 首尾拼接成 5.59 / 11.18 / 16.78 秒，
用与 ArkTS **完全相同**的通路（剥 44 字节头 → `toFloat32`(÷32768, LE) → VAD 512 窗 → decode）：

```
  5.59s  VAD段=1  尾部子串命中=1/1   207ms  ✓ 完整
 11.18s  VAD段=2  尾部子串命中=2/2   384ms  ✓ 完整
 16.78s  VAD段=3  尾部子串命中=3/3   581ms  ✓ 完整
```

**16.78 秒的音频三段内容全部识别**（每段末句都出现），而 HMS 在同样长度
只会返回开头 4~5 秒 ⇒ **"长音频不再截断"这条核心收益成立**。

**判据教训**：首次跑时我要求"完整字符串精确出现 3 次"，得到 1/3 就判"未完整复现"——
其实三段都出来了，只是段首字有边界误识（`开`→`派`/`菜`）。
**改用尾部子串计数**（避开受边界影响的首字）才是正确判据。
⇒ 测长音频时，检验点是"**末尾内容是否也出现**"（HMS 的行为特征正是"只出开头"），
不是"整句是否逐字一致"。

**顺带证伪的一个假设**：原以为 `useItn=true` 会把阿拉伯数字转成汉字
（曾在 `ja.wav` 上见到 `50円` vs `五十円` 的差异）。做**干净 A/B**（不跑 VAD、
其余参数完全相同）后确认：**`useItn` 对输出无影响**，
那个差异来自 **VAD 切分**（分段后每段独立 decode，边界处理不同）。
⇒ 没有据此改代码。**"看到差异"不等于"找到了原因"。**

**VAD 缓冲边界（111.8s 音频，覆盖"最长 120s 录音"这个 API 能力）**

`api-speech-to-text` 的 `maxDurationSeconds` 默认 120，而我 ArkTS 里写的是
`new Vad(vadConfig, 60, mgr)`（缓冲 60 秒）⇒ 需确认超缓冲时会不会丢内容。

```
音频: 111.8s （VAD 缓冲 60s）
  buffer=60s   VAD段=20  尾部命中=20/20   3681ms  ✓
  buffer=120s  VAD段=20  尾部命中=20/20   3659ms  ✓
```

⇒ **60 秒缓冲不会因音频更长而丢内容**（20 段全部出来），
**无需把缓冲调大**；"最长 120 秒录音"这个能力有据可用。

**原「仍未证明」项现已全部由真机验证**（见本批次 §零）：
OHOS NAPI 加载 ✓、rawfile 读 230MB ✓（2.3s）、麦克风→桥→识别→插字端到端 ✓。

**仍建议补的真机项**：>5 秒的真机长口述（本轮两段为 4.64s / 4.34s；
长音频完整性目前由 PC 侧同通路验证）。

**NAPI 模块解析链（本轮新增核验，`pkgContextInfo.json`）**

```
sherpa_onnx        → {isSO:false, entryPath:"Index.ets", version:"1.13.3"}
libsherpa_onnx.so  → {isSO:true,  entryPath:"Index"}      ← 本次的 NAPI 映射
libkoffi.so        → {isSO:true,  entryPath:""}           ← 对照：已知可用
libdshhost.so      → {isSO:true,  entryPath:"index"}      ← 对照：已知可用
```

`libsherpa_onnx.so` 的映射形态与**已知能绑上的** `libkoffi` / `libdshhost` 同类
⇒ `import { OfflineRecognizer, ... } from 'sherpa_onnx'` 的解析链完整
（ArkTS → `Index.ets` → `libsherpa_onnx.so` → NAPI → `libsherpa-onnx-c-api.so`）。
**这排除了"模块绑不上"这一类失败**，剩余未知纯属运行期（模型加载、识别）。

**官方示例对齐（防止走错模型分支）**：官方 `NonStreamingAsrModels.ets` 的
SenseVoice 分支（`case 15`）**只设** `c.senseVoice.model` + `c.tokens`，
**不设** `modelType`（对比 `case 14` paraformer / `case 13` transducer 都设了）。
本实现与之**完全一致**（也不设 `modelType`）。

**模型 sha256（从 HAP 内抽出后重算，与上游声明一致）**

```
model.int8.onnx   239233841 B  c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51
tokens.txt           315894 B  f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc
silero_vad.onnx     1807522 B  a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28
```

**门禁**

```
assert-speech-syntax.mjs         exit=0
assert-cli-shim.mjs              exit=0（40 项）
assert-exec-fix.mjs              exit=0（35 项）
check-parity.mjs                 exit=0
compat-drift.mjs                 exit=0
assert-resfile-sync.mjs          exit=0（8 件快照）
assert-python-bridge.mjs         exit=0（69 项）
assert-fs-search-fallback.mjs    exit=0（39 通过 / 0 失败）
```

### 三 待验证清单（设备回来后的顺序）

| # | 验证项 | 判据 | 已知风险 |
|---|---|---|---|
| 1 | 四个 .so 在设备上就位 | `find /data/app -name 'libsherpa*.so'` 有 4 个 | 低（hvigor 已打进 HAP `libs/arm64-v8a/`）|
| 2 | **230MB 模型可被读取** | 点麦克风不报"模型未就位" | **中** —— native 侧走 `OH_ResourceManager_OpenRawFile`+`GetRawFileSize`（已从 .so 字符串确认存在），但**这个尺寸没实测过** |
| 3 | 首次识别耗时 | 可接受（模型加载 + VAD 初始化） | 中 —— 230MB 加载可能要数秒~数十秒 |
| 4 | 端到端出字 | 说中文回中文 | 低（API 已逐项对齐官方示例）|
| 5 | **长音频不再截断** | ≥8s 音频能出**完整**内容（而非只出开头）| 低 —— 这是 SenseVoice 相对 HMS 的核心收益 |
| 6 | 麦克风按钮可用 | 不弹"需安装依赖" | 低（`preparation` 缺省 ⇒ `phase='ready'`，已读上游代码确认）|

### 四 已知代价与遗留

- **HAP 550.3 MB**（原 ~320 MB）：230MB 模型随包内置。
  项目自身体积门（`docs/50` G2″）是 **≤400 MB** ⇒ **超门 150 MB**。
  这是"离线开箱即用"的代价；若要压回门内，只能改成"首启下载模型"（牺牲离线可用性）。
- **bundleName 仍是 `com.dshm.micverify`**：改回 `com.dshm.dshclient` 会因
  签名 profile 绑定而 `SignHap` 失败（见 §10.11 / E-SV9）。换正式包需在 DevEco GUI
  对 `com.dshm.dshclient` 重新自动签名。**这是交付步骤，不是代码问题。**
- **未回收**：HAR 带进来的 `libs/x86_64/*.so`（20.3 MB）。试过
  `buildOption.nativeLib.filter.select[].excludePattern` 三种写法均未生效
  （疑似 stage 模式不走该分支），已放弃 —— 收益 3.6%，不值得继续。

### 五 数据安全

本轮**未执行任何设备写操作**（设备离线，连 `install` 都没跑）。
`build-profile.json5` 的 `bundleName` 保持 `com.dshm.micverify`，
装机时**不会**触碰 `com.dshm.dshclient` 的 el2 数据。


---

## 批次二十七：语音模型改为在线下载 + 频谱（**真机端到端验证通过**）

> 目标：DSHM 不再内置 228MB 模型，改为启动后从 GitCode 的 ohosSenseVoice 仓库下载。

### 一 必须先确认的前提（阻塞点）

「不内置模型」意味着模型落在**应用沙箱路径**（filesDir），而非 HAP 内的 rawfile。
而 sherpa-onnx 的鸿蒙实现里明确有 `OH_ResourceManager_OpenRawFile` /
`GetRawFileSize` / `ReadRawFile` 符号，说明 **rawfile 是其主读取路径**。

**它能否从沙箱绝对路径加载模型，静态分析无法判定**：
- HAR 声明为 `createOfflineRecognizer(config, mgr?)` —— `mgr` 可选（暗示或许能不给）
- 但 .so 符号已被 strip，看不到"文件路径直读"那条实现链

⇒ 只能真机实测。已加入探针 `probeLoadPath`（`SenseVoiceRecognizer.ets` 内），
把 rawfile 模型复制到沙箱，再用三种组合尝试加载：

| 变体 | 模型路径 | 传 `mgr` |
|---|---|---|
| A | 沙箱绝对路径 | 否 |
| B | 沙箱绝对路径 | 是 |
| C | rawfile 相对路径 | 是（现状基线，应成功）|

每个变体同时测 **识别器** 与 **VAD** 两个独立实例。
结果写入 `files/diag-loadpath`（`hdc shell cat` 可读）。

**判读**：A 或 B 成功 ⇒ 在线下载方案直接可行；
仅 C 成功 ⇒ 需变通（下载后写入应用自身 rawfile 区、或经 FFI 自行加载）。

### 二 UI 进度呈现的契约（已完成调研）

上游 provider 通过 `preparation` 对象向 UI 暴露状态，契约如下（取自
`dsh-experimental-client-ui-voice-input` 的 schema）：

```
phase 的合法值：ready | unprepared | standby | failed | downloading | checking | waking | cancelled | cancelling

downloading：{ phase, resource: string, completedBytes: number, totalBytes?: number,
               step?: 'check'|'model'|'vad'|'verify'|'load',
               steps?: [{ kind, status }] }
failed     ：{ phase, message: string,
               download: { resource, source, reason: 'network'|'storage'|'unknown'|'dns'|
                           'timeout'|'certificate'|'http'|'integrity'|… } }
checking   ：{ phase, step: 'check'|'model'|'vad'|'verify'|'load' }
```

UI 端行为（已核实 client.js）：
- `phase === 'downloading' && totalBytes !== undefined` ⇒ 渲染进度条
  （`max=totalBytes`、`value=completedBytes`），文案形如
  `下载：{completed} / {total} MB，{percent}%`
- `failed` ⇒ 渲染失败提示
- `phase === 'unprepared' && location === 'host-local'` ⇒ 触发"需安装/准备"引导

⇒ **本端侧实现若要进度可见，就必须提供同形的 `preparation`**，
并在下载过程中持续 `publish({ phase: 'downloading', completedBytes, totalBytes })`。

**当前 provider 的处置**：不提供 `preparation` ⇒ 服务端补 `{ phase: 'ready' }`
⇒ 按钮直接可用（不显示进度）。改为在线下载后，**必须**提供 `preparation`，
否则首次使用会表现为"点了没反应"，直到下载完成。

### 三 端侧可用的实现手段（已核实）

| 能力 | 现状 |
|---|---|
| HTTP 请求（`@kit.NetworkKit`）| ✓ 项目已在用（`runtime/NodeRuntime.ets`）|
| 文件写（`fileIo`）| ✓ 多处在用 |
| base64（`util.Base64Helper`）| ✓ 在用 |
| sha256（`cryptoFramework`）| ✗ **尚未使用**，需引入 |
| host 侧（Node）网络能力 | ✓ `undici` 垫片、`fetch-shim.js` 等已在用 |

⇒ 两条实现路线：
1. **ArkTS 侧下载**（NetworkKit + fileIo + cryptoFramework）：直接，但需引入 sha256；
2. **host 侧下载**（Node 已有 undici/fetch 与 createHash）：能力更全，
   但要把文件写到 ArkTS 能读到的路径（同一沙箱，可行），并解决"通知 ArkTS 重新加载"。

**实际选择：host 侧（Node）下载。** 理由：Node 已有可用 HTTP 通道与
`node:crypto` 的 `createHash`，下载 + sha256 校验开箱即用；ArkTS 侧还需引入
`cryptoFramework` 且大文件写入要自行分块。落盘位置同属应用沙箱，
ArkTS 侧用绝对路径即可读。

### 四 关键结论：模型可以从**沙箱文件路径**加载（源码 + 真机双重确认）

这是整个方案的技术前提，**不必靠真机试错**，sherpa-onnx 源码直接给出答案：

```cpp
// harmony-os/SherpaOnnxHar/sherpa_onnx/src/main/cpp/non-streaming-asr.cc:546-573
bool use_resource_manager =
    info.Length() == 2 && !info[1].IsUndefined() && !info[1].IsNull();

if (use_resource_manager) {
  recognizer = SherpaOnnxCreateOfflineRecognizerOHOS(&c, mgr.get());  // 从 rawfile 读
} else {
  recognizer = SherpaOnnxCreateOfflineRecognizer(&c);                 // 从文件系统读
}
```

两条底层实现分别是 `OfflineRecognizer(mgr, config)` 与 `OfflineRecognizer(config)`
（`c-api.cc:692/3504`）。**不传 `resourceManager` ⇒ 走文件路径**，
与 Linux/Windows/macOS 同一条路径。另注 OHOS 版在 `mgr === nullptr` 时
也会回退到通用路径，是双保险。

⇒ **ArkTS 侧改为不传 `mgr`**（`SenseVoiceRecognizer.ensureReady`）。

### 五 实现落点

| 组件 | 位置 | 作用 |
|---|---|---|
| 下载器 | `hostcore/speech-models/index.js` | 下载 + sha256 校验 + 原子改名 |
| provider | `hostcore/speech-provider/index.js` | `preparation` 报状态；`transcribe` 前确保模型 |
| 打包 | `tools/pack-core.mjs` | 把下载器拷进核心树（缺了**直接失败**）|
| ArkTS | `speech/SenseVoiceRecognizer.ets` | 从沙箱路径加载（**不传 mgr**）|

### 六 本轮修掉的三个真实缺陷

#### E-SV11 下载保存失败：把 228MB 全读进内存

**现象**：界面报「无法保存 …：磁盘空间不足或没有写入权限」，但磁盘有 174GB 空闲。

**根因**：原实现把响应用 `chunks.push` 累积后再 `Buffer.concat`，
峰值内存约 **2×228MB**。端侧 Node 跑在嵌入式运行时上，这种分配会失败，
而失败信息被分类逻辑误判成 `storage`（UI 因此显示"磁盘空间不足"）。

**修法**：改为**边读边写盘**（`openSync` + `writeSync`），内存占用恒定。
PC 实测峰值 heapUsed 从 228MB+ 降到 **9.9MB**。

#### E-SV12 新模块未被打包

`pack-core` 只把 `hostcore/speech-provider/index.js` 拷成 `lib/hms-provider.js`，
而 provider 以 `../speech-models/index.js` 引用下载器 ⇒ 解析到
`<pkg>/speech-models/index.js`。不显式拷贝则运行时 `Cannot find module`。
已在 pack-core 里拷贝，且**缺失即报错**（不静默跳过）。

#### E-SV13 全新安装首次录音必失败（权限从未申请）

**现象**：正式包首次点听写按钮即报「录音中断，请重试」，没到录音环节。

**根因（架构性）**：官方流程是「Web 侧 `getUserMedia` → 触发
`onPermissionRequest` → 我们调 `requestPermissionsFromUser`」。
但**原生采集覆盖绕过了 `getUserMedia`**（直接调 `createAudioCapturer`），
那条申请路径永远不会被走到 ⇒ 全新安装时权限从未授予 ⇒ 采集失败。

测试包 `micverify` 之所以一直正常，是因为它早前已授权；
正式包换了签名属于全新安装，必然首次失败。

**修法**：`startNativeCapture` 先 `ensureMicPermission()` 再开采集；
并把 JS 侧的等待窗口从 3 秒放宽到 **15 秒**（首次会弹系统授权框，
用户读完再点是人的时间尺度；旧窗口会在用户还在看弹框时就超时）。

**真机证据**：
```
2026-09-27T03:35:52.341Z ensureMicPermission granted=true results=[0]
2026-09-27T03:35:52.381Z ★ 官方按钮 → 原生采集已启动
2026-09-27T03:35:56.021Z ★ 取走 115840 字节（3620ms，peak=28376）
2026-09-27T03:35:57.343Z 改用 SenseVoice pcm=115840B
```

### 七 频谱（波形）的实现

**现象**：说话时波形是静止的最小值。

**根因**：官方 `Waveform` 组件每 50ms 调 `recording.amplitude()`，
而它读的是 `this.analyser`（`AudioContext.createAnalyser()`）。
原生采集覆盖了 `start()` ⇒ **创建 analyser 的那段被跳过** ⇒
`amplitude()` 恒返回 0。

**修法**：覆盖 `Recording.prototype.amplitude`，改读 ArkTS 侧
`nativeCaptureState()` 的 `rms` 字段。

**为什么用 RMS 而不是峰值**（用真机数据反推，不靠猜系数）：
官方映射为 `height = 1 + min(1, level * 5) * 17`（18 = 满格），
且官方 `amplitude()` 返回的就是 RMS。实测：

| 场景 | 峰值/4 | 真 RMS | 官方口径 |
|---|---|---|---|
| 平静说话（peak=21020）| 14.6 | 9.1 | 9.1 |
| 较大声（peak=28311）| 18.0（顶格）| 11.9 | 11.9 |

⇒ 用峰值即使除以 4 也几乎顶格，看不出起伏；**RMS 与官方同口径**。

**性能纪律**：平方和在**已有**的采样循环里顺带累加（每 8 样本一次乘加），
**不新增遍历** —— 此前在实时回调里额外加逐样本计算导致丢块、VAD 失效、
识别全灭，是必须避免的坑。

### 八 补丁注入的幂等陷阱（E-SV14）

**现象**：改了注入代码、`pack-core` 也报「✓ 完成」，但设备行为毫无变化。

**根因**：pack-core 的注入守卫是「文件里含标记就整段跳过」。
核心树里已有**旧版**注入（只有 `start`/`stop`），于是新增的
`amplitude` 覆盖**从未被注入过**。

**修法**：改为**版本标记**判断（`DSHM_NATIVE_CAPTURE@v3-…`）：
版本一致才跳过；版本不同则**先删掉旧注入段再注入新版**
（不删会出现两份 `start`/`stop` 覆盖，后者包住前者，行为难预测）。

### 九 白屏：安装流程导致的启动竞态（非代码缺陷）

**现象**：装机后首次打开白屏。

**根因**：为强制重解包核心树（25,914 个文件），每次装机都删了
`.dshm-bundled-stamp` ⇒ 宿主该次启动耗时 `+6648ms`。
而 WebView 早于它发起加载 ⇒ 拿到 **HTTP 404** ⇒ `fail()` ⇒
`phase = ERROR` ⇒ 白屏。

**决定性证据**（node-output.log 行号）：
```
行 418: LoadUrl
行 640: OnPageEnd httpStatusCode:404
行 652: BOOT_65_AUTH_URL (+6648ms)     ← 宿主 6.6 秒后才就绪
行 655: BOOT_60_HTTP_BIND port=3120
```

**重启即恢复**（实测重启后 `http_status_code=200`）。

**诊断教训**：`BOOT_*` / `DSHM_READY` 打在 **node-output.log**，
不在 `dshm-host.log`。只看后者会得出"宿主从未就绪"的**错误**结论
（本轮曾据此误判为"真实启动失败"）。

**已知健壮性缺口**：`this.fail()` 后不重试 ⇒ 页面停在错误态。
正常启动（不删戳）是秒级，不会触发；但值得后续补自动重试。

### 十 验证结果（真机）

| 项 | 证据 |
|---|---|
| HAP 移除内置模型 | **550.3 MB → 320.1 MB**（-230MB）|
| 在线下载 + sha256 | 三文件字节数精确匹配：239233841 / 315894 / 1807522 |
| sha256 校验生效 | 只有校验通过才 `renameSync`（文件存在即证明哈希正确）|
| 沙箱路径加载 | 心跳 `预热成功 模型已就绪=true` |
| 首次权限申请 | `ensureMicPermission granted=true results=[0]` |
| 采集 | `取走 115840 字节（3620ms，peak=28376）` |
| 识别 | `改用 SenseVoice pcm=115840B`；用户确认识别正确 |
| 频谱 | 用户确认正常 |
| 回归门禁 | **7/7 全过** |
| 正式包合入 | `bundleName = com.dshm.dshclient`，覆盖安装未触碰用户数据 |

### 十一 开源仓库（GitCode）

模型源为 `https://gitcode.com/u010189254/ohosSenseVoice`（Apache-2.0）。
注意该站点的两个实测约束：

- `gitcode.com/<o>/<r>/raw/<ref>/<path>` 返回 **HTML 页面**；
  `raw.gitcode.com` 对多数文件返回 19 字节"暂不支持预览"（**HTTP 200，静默失败**）。
  ⇒ 必须用 `gitcode.com/api/v5/repos/<owner>/<repo>/raw/<path>?ref=<ref>`。
- Release 附件**不支持 HEAD**（`HEAD → 401`，`GET → 200`）。
  若配多个 `modelOrigins`，HEAD 探测会把顺序重排到 HF；
  **单一来源时不探测**，故应配 `modelOrigins: ["https://gitcode.com"]`。


---

## 批次二十八：白屏彻查 + 环境清理（**真机验证通过**）

> 用户报告："白屏进都进不去"，且**其他人也遇到**。要求彻查根因，并清理环境中不需要的部分。

### 一 白屏根因（**不是崩溃，是"一次竞态后再无自愈"**）

#### 时序（node-output.log 行号 + 时间戳双证据）

```
行 418: LoadUrl url:http://127***                    ← WebView 开始加载
行 640: OnPageEnd httpStatusCode:404                  ← 拿回 404
        is_error_page=1, net_error=-379
行 652: BOOT_65_AUTH_URL (+6610ms)                    ← 宿主 6.6s 后才写就绪文件
行 655: BOOT_60_HTTP_BIND port=3120 (+6639ms)         ← 端口此刻才绑
行 659: DSHM_READY
```

**机制**：
1. WebView 的 `src` 直接绑定 `launchUrl`（`Web({ src: this.launchUrl })`）；
2. 而宿主**首启解包后要 6～7 秒**才可用（实测 `+6384 / +6610 / +6645 / +6885ms`，**几乎每次都在 6 秒以上**）；
3. 页面在这个窗口里发起请求 ⇒ 宿主尚未绑端口 ⇒ **HTTP 404**；
4. `onHttpErrorReceive` 收到 404 ⇒ `fail()` ⇒ `phase = ERROR` ⇒ 错误覆盖层；
5. **原实现到这一步就停住**，只有手动点"重试"才恢复。

⇒ 这就是"打开就是白屏"：**竞态几乎必然发生**（宿主固定要 6+ 秒），而**失败后无自愈**。
不是偶发，所以其他人同样遇到。

#### 一个被掩盖的次生缺陷：onPageEnd 抹掉失败态

原 `onPageEnd` **无条件**置 `phase = READY`。真机日志显示它与 fail 只差 10ms：

```
47.144 web UI 加载失败：Host 返回 HTTP 404     ← fail() 置 ERROR
47.154 web UI 页面渲染完成（phase=READY）      ← 立刻被覆盖成 READY
```

页面加载的是 **ArkWeb 自己的错误页**，所以 onPageEnd 照样触发。
结果是 ERROR 被瞬间抹掉：用户既看不到原因，**连"重试"按钮都没有** ⇒ 纯白屏。

### 二 修法：让页面会自己重试（不试图消除竞态）

竞态无法消除（宿主启动耗时可长可短），所以修在**自愈**上：

| 改动 | 说明 |
|---|---|
| 新增 `loadFailed` 标志 | 失败后 `onPageEnd` **不得**改写阶段（否则又变白屏） |
| 新增 `scheduleAutoRetry()` | 指数退避 0.6s → 1.2s → 2.4s → …，最多 6 次 |
| `retry()` 负责清标志 + `refresh()` | launchUrl 为空时退回 BOOTING 并继续排重试 |
| 成功时复位计数 | 下次失败重新有完整重试预算 |

#### 真机取证（文件标记，不依赖 hilog）

本机 hilog 有丢日志前科，故用 `diag-web-load` 追加文件取证：

```
2026-09-27T04:02:17.017Z 失败：Host 返回 HTTP 404（已排第 1 次自动重试）
2026-09-27T04:02:17.017Z 第 1 次自动重试，延迟 600ms
2026-09-27T04:02:18.592Z 成功：页面已就绪（200）
```

**1.6 秒后自愈，零用户干预。** 且 `LoadUrl` 计数 1 / `OnPageEnd` 计数 2
⇒ 第二次是 `refresh()` 而非新导航，正是本实现路径。

### 三 环境清理

#### 3.1 hnp：**三处都没有实体**

| 检查处 | 结果 |
|---|---|
| 项目（全文件类型搜索） | 无 hnp 目录/文件/har |
| HAP（打包产物） | 含 hnp 的条目 **0** |
| 设备（`/data/service/hnp`、`/system`、`/vendor`） | **不存在** |
| `module.json5` `hnpPackages` | **未声明** |
| 核心树 `hnpPackages`/`executableBinaryPaths` | 无 |

⇒ 代码里仅剩**两处 PATH 探测候选**（`hostcore/app/main.js` 的目录去重、
`tools/pack-core.mjs` 的 `probeSystemTool`），都用 `existsSync` 判定、
不存在即跳过。**无实物可清**；删掉探测会削弱"设备若真有 hnp 时能利用"的降级能力，
故**保留**。

误以为是 hnp 的其实是 **resfile/toolchain**（git/python 的 apk 与 tar.gz），
那是 `place-toolchain.mjs` 投放的、**功能依赖**（终端、`web_fetch` 等），不能删。

#### 3.2 清理项（合计释放约 **877 MB**）

| 项 | 体积 | 理由 |
|---|---|---|
| `dist/micverify` | 563.4MB | 语音验证期隔离包产物（包已卸载） |
| `dist/micsign` | 282.6MB | 签名试验产物 |
| `dist/_ev9` / `_func_test` / `toolchain-sign` | 3.9MB | 一次性实验 + 空目录 |
| `dist/*.log` | 6.8MB | 本轮排查的构建日志（132 个） |
| HAR 内 `libs/x86_64` | 20.4MB | 见下 |

**明确保留**：`dist/core`（pack-core 工作树）、**`dist/sideload`（交付物）**、
`dist/acceptance`、`third_party`（git/python/koffi/ripgrep 源码）。

#### 3.3 HAP 体积三连降

| 阶段 | 体积 | 说明 |
|---|---|---|
| 初始（内置 228MB 模型） | 550.3 MB | |
| 模型改在线下载后 | 320.1 MB | -230.2MB |
| 去掉 x86_64 库后 | **299.5 MB** | -20.6MB |

**x86_64 移除方式**：`build-profile.json5` 的 `abiFilters` 早已是 `["arm64-v8a"]`，
但**不影响 HAR 自带的多 ABI 库** ⇒ 先前用 `nativeLib.filter.excludePattern` 的尝试无效。
这次改在**源头**：HAR 是 tar.gz，解包后删 `package/libs/x86_64`，重新打包
（原 HAR 备份为 `.har.bak`）。arm64 字节**未动**（已用 `llvm-readelf` 对比 DT_NEEDED 确认一致）。

⚠️ 还需清 `oh_modules/.ohpm` 里 sherpa 的**解包缓存**并 `ohpm install` ——
ohpm 按 lock 判定、不会因 har 文件变化而重新解包，否则旧缓存里的 x86_64 会再次进 HAP。

### 四 顺带修掉的既有门禁缺陷（E-SV17）

`tools/check-native-closure.mjs` 的 `SYSTEM_LIBS` 白名单**漏了 `librawfile.z.so`**，
导致它自 SenseVoice 引入起**一直 FAIL**（报"1 个依赖无法解析"）。

**证据**：`docs/70` 的依赖表已把 `librawfile.z` 与 `libace_napi.z`/`libhilog_ndk.z`
**并列**为"OHOS 标准系统库"，但白名单只登记了后两个。
且该库在项目与 HAP 内**都不存在**，而设备上能加载（识别真机通过）⇒ 确为系统提供。

**证明与本轮改动无关**：用**备份的原始 HAR** 解出的 `.so` 跑同一判定，
同样报 `librawfile.z.so` 无法解析（我只删了 x86_64 目录，arm64 字节未动）。

已补入白名单（附证据引用）⇒ 门禁由 FAIL 转 **PASS**。

### 五 验证结果

| 项 | 证据 |
|---|---|
| 白屏自愈 | `失败：HTTP 404 → 第 1 次自动重试，延迟 600ms → 成功：200`（1.6s） |
| 正常启动 | `成功：页面已就绪（200）` |
| 端侧核心 | 4 进程、端口 3120 LISTEN、89 次入站请求 |
| 语音链路 | 三次 `预热成功 模型已就绪=true`（含本次安装后 04:05:23） |
| 麦克风权限 | `ensureMicPermission granted=true results=[0]` |
| HAP 体积 | 550.3 → **299.5 MB** |
| 无内置模型 | HAP 内 `rawfile/sensevoice` 条目 0 |
| python/git 工具链 | 均在 HAP 内（功能完整） |
| **回归门禁** | **9/9 全过**（含新增的 assert-speech-syntax 与 check-native-closure） |
| 用户数据 | 覆盖安装，未触碰 el2 |

### 六 诊断教训（值得记住）

1. `BOOT_*` / `DSHM_READY` 打在 **node-output.log**，不在 `dshm-host.log`。
   只看后者会得出"宿主从未就绪"的**错误**结论（本轮曾据此误判为"真实启动失败"）。
2. 本机 **hilog 会丢日志** ⇒ 时序类排查必须用**文件标记**取证。
3. 判断"某缺陷是否我引入"要用 **A/B**：还原备份输入跑同一门禁，别靠推理。


---

## 批次二十九：项目改名 HDSH → DSHM（**全量替换 + 真机验证**）

> 用户要求：把项目里所有 HDSH 改为 DSHM，含 README、全部文档、代码。

### 一 规模（远超"文案替换"）

首次普查结果：**213 种标识符 / 1244 处 / 115 个文件 + 9 个待改名文件**。
其中既有可见文案，也有**跨层接口**——所以不能一把梭。

### 二 大小写映射（显式表，避免漏混写）

| 旧 | 新 |
|---|---|
| `HDSH` | `DSHM` |
| `Hdsh` | `Dshm` |
| `HDSh` | `DSHM` |
| `hdsh` | `dshm` |

覆盖：环境变量（`HDSH_HOME`→`DSHM_HOME`）、日志哨兵（`HDSH_READY`→`DSHM_READY`）、
HTTP 端点（`/hdsh-python/`→`/dshm-python/`）、文件名（`hdsh-installer.js`→`dshm-installer.js`）、
C 函数名（`hdshFetch`→`dshmFetch`）、CMake 变量（`HDSH_LIBNODE_ABI`→`DSHM_LIBNODE_ABI`）、
包名（`hdsh-core-bundle`→`dshm-core-bundle`）、原生库（`libhdsh-gitcompat.so`→`libdshm-gitcompat.so`）等。

### 三 明确**不改**的三类（附理由）

| 保留项 | 理由 |
|---|---|
| `dshhost` / `libdshhost.so` | 是 **dsh+host**（dsh 宿主），不是 HDSH；且字母序不同，`hdsh→dshm` 替换天然不会误伤（已用源码校验确认） |
| `com.hnmrxz.hdsh` | **历史 bundleName** 字符串（E89 时代），出现在讲述历史演进的文档/注释里；现网正式包是 `com.dshm.dshclient`。改它会让历史记录失真 |
| `hdsh_port_ppt169_20260925` | **外部** PPT 工程名（`dist/video-build` 生成的 manifest 引用） |

替换实现用"**占位符保护**"：先把这三类替换成临时占位，替换完成后再还原。

### 四 改完之后暴露的两个真实缺陷（E-SV21 / E-SV22）

#### E-SV21 门禁里有一条**自相矛盾**的断言

`tools/assert-python-bridge.mjs` 原文：

```js
ok(skillDoc.includes('/dshm-python/'), '...');     // 要求必须有 /dshm-python/
ok(!skillDoc.includes('dshm-python'), '...清除'); // 要求不得有 dshm-python
```

**两条不可能同时成立。** 它之所以长期通过，是因为当时文档里是 `hdsh-python`——
恰好一条命中、另一条不命中。**命名演进的化石**：文档注释里还留着
"（DSHM 版曾标注不支持）"，说明这是 **DSHM → HDSH → DSHM** 的第二轮往返，
那条断言是更早一轮（DSHM→HDSH）留下的"清除 DSHM 残留"守卫。

**修法**：翻转方向到旧名（`!includes('hdsh-python')`），守卫意图不变，并写明来龙去脉。

#### E-SV22 pack-core 的**幂等标记**在改名后会重复打补丁 ⇒ 打包中断

**现象**：`pack-core` 连续 `die` 三次，逐个暴露：
`Origin 栅栏补丁：未找到待替换片段` → `agent preset 补丁：没有任何 preset 文件被改到` → `HMS provider 替换：未找到导出语句`。

**根因（同一类的 7 处）**：`pack-core` 用**字面标记**判断"是否已打过补丁"：

```js
if (text.includes('DSHM_ORIGIN_LIST')) { 跳过; }
```

而核心树里由**上一版 pack-core** 打进去的是**旧标记** `HDSH_ORIGIN_LIST`。
改名后只认新名 ⇒ 判成"没打过" ⇒ 重复执行替换，但待替换片段早已被换掉 ⇒
锚点找不到 ⇒ `die`（拒绝静默跳过——这个严格性是对的，正是它把问题暴露出来）。

涉及的 7 处：`ORIGIN_LIST`、`LINK_SANDBOX`、`CREDENTIALS_MODE_EXEMPT`、
`READONLY_STACK_GUARD`、`FS_LOCAL_SANDBOX`、`ATTACHMENT_SANDBOX`、`WORKFLOW_DISABLED`
（另有 `NATIVE_CAPTURE` 用版本标记，天然带旧段清理）。

**两步修法**：

1. **短期兼容**：判定改为 `includes(新名) || includes(旧名)`，让老树能增量重打包；
2. **彻底清理**：删除 `dist/core/work/<ver>` 后由 pack-core 重新 `npm install` 物化
   ⇒ 旧标记随上游重新解包全部消失。验证：**旧标记残留 0，全部为新名**。

另修 `entry/src/main/cpp/gitcompat.c` 头注释里的旧库名（`.c` 文件不在首次扫描的扩展名内）。

#### 附带发现：构建产物里的旧名残留

HAP 里同时存在 `libhdsh-gitcompat.so`（03:56）与 `libdshm-gitcompat.so`（04:41）——
前者是**旧构建的残留**。清 `entry/build/**/intermediates/{libs,stripped_native_libs}` 后重建，
HAP 内 **hdsh 条目归 0**。

### 五 验证结果

| 项 | 证据 |
|---|---|
| 源码残留 | 仅 5 处，全是受保护的 `com.hnmrxz.hdsh`（分布在 docs/50 的历史记录里） |
| HAP 内 hdsh 条目 | **0**（含 dshm 条目 5 个） |
| 核心树补丁标记 | 旧标记残留 **0**，全部 `DSHM_*` |
| **回归门禁** | **7/7（AGENTS.md 规定）+ 5/5（改名相关）全过** |
| 端到端 | 4 进程、端口 3120 LISTEN、91 次入站请求 |
| 白屏自愈 | `404 → 排第 1 次重试(600ms) → 2s 后 200`（改名未破坏自愈） |
| 语音链路 | `预热成功 模型已就绪=true` |
| 运行期日志名 | 新 `dshm-host.log`（HDSH 计数 **0**）已在写；旧 `hdsh-host.log` 停止写入 |
| 用户数据 | 历史会话 `session-21db9734`/`session-b847e342` 仍在使用 ⇒ el2 完好 |

### 六 方法学备注

**等价性证明**：把新旧文件都归一化（`hdsh`/`dshm` → 同一记号）后**逐字节比较**，
证明"只改了名字、没动逻辑"。据此可断定其余门禁失败与我无关
（复核确认：失败项全是环境依赖——找不到 DevEco CLT / 需特定 Node flag——
或既有设计失配、以及 PIAI/View 占位类死代码，**无一与命名相关**）。

**改名类改动的两个必查项**（本次都查了）：
1. **成对关系**：文件名与 require、签名标记的写入方与校验方必须同步；
2. **幂等标记**：凡"改标记名"，必须同时认旧名，否则老产物无法增量重建。


---

## 批次三十：启动体验三修（**真机验证通过**）

> 用户反馈三件事：① 启动偏慢；② 启动画面读条不准确；③ 启动画面过后有约 2 秒白屏。

### 一 真机实测的启动分段（日常冷启动，实测值）

| 阶段 | 耗时 | 说明 |
|---|---|---|
| `aa start` → Node 起来 | ~2.1 s | 原生宿主 + `libnode` 初始化（含 libuv io_uring 关闭等）|
| Node → `BOOT_40_PROFILE_BOOT` | 0.3 s | 环境/核心树定位 |
| **`BOOT_40` → `BOOT_50_DSH_INIT`** | **7.4 s** | ★ **`runProfile` 内部**（dsh 加载插件树）|
| → `BOOT_70_HTTP_READY` | 0.2 s | 自探 HTTP |
| WebView 加载 → 200 | 1.7 s | 含一次 600ms 自动重试 |
| **合计** | **~10.1 s** | |

**结论：7.4 秒的主体是 dsh 上游的 `runProfile`**，不属于本项目可改范围
（项目纪律是对上游零 patch）。要真正缩短只能**减少启动插件数**——设备上有
**19 个非种子插件行**，但那会改变功能，属产品决策，未擅自处理。

> 量化方法：给 `hostcore/app/main.js` 的 `runProfile` 前后临时插计时桩，
> 读到 `enter-runProfile +0ms` / `runProfile-returned +7261ms`。
> **插桩已完全撤除**（项目纪律：临时实验必须在同一次改动内还原），
> 并核验 `hostcore/app/main.js` 与 resfile 副本都不含 `SP_TIMING`/`spMark`。

### 二 白屏根因（E-SP1）

**现象**：启动页过后有约 2 秒白屏，然后才进主界面。

**根因**：启动页只挂在 `BOOTING` 上，而阶段流转是

```
BOOTING（显示启动页）→ launchUrl 就绪 → enterLoading() → LOADING → 200 就绪
```

`LOADING` **没有任何覆盖层** ⇒ 直接露出底层 Web 组件：此时页面要么还没渲染完
（空白），要么正显示上面那次 **404 的错误页**。这就是那 2 秒白屏。

**修法**：启动页条件从 `phase === BOOTING` 改为

```ts
phase === BOOTING || (phase === LOADING && !this.everReady)
```

**为什么必须带 `!everReady`（自查发现的自身回归）**：
`onPageBegin` 在**整页导航**（点链接、303 落地）时也会把 `READY` 打回 `LOADING`。
若只看 phase，**应用内每次整页跳转都会闪一下启动页**。
`everReady` 在首次 `onPageEnd` 时置 true，此后不再把启动页盖在 LOADING 上。

### 三 进度条两处缺陷（E-SP2）

原实现：

```ts
this.loadTicker = setInterval(() => {
  if (this.phase !== WebPhase.BOOTING) { this.stopLoadTicker(); return; }  // ② 进 LOADING 就冻结
  this.progressValue = this.progressValue >= 100 ? 0 : this.progressValue + 3;
}, 220);                                                                    // ① 每 220ms 只 +3
```

| 缺陷 | 后果 |
|---|---|
| ① 每 220ms 只 +3 ⇒ 走满需 **7.3 秒** | 与真实耗时接近纯属**巧合**；首启（30–60s）时早就循环回去了 ⇒ 用户看到"跑满一圈又重来" |
| ② `phase !== BOOTING` 就停表 | 进入 LOADING 后进度条**冻结**，但那时其实还在加载 |

**修法**：改为**按经过时间渐进**，并让曲线**渐近逼近 90%**（100% 只由"真的就绪"宣告）：

```ts
const elapsed = Date.now() - this.loadStartedAt;
const tau = 3200;   // 【已被 E-SP5 取代】指数方案；现为匀速直线
this.progressValue = Math.floor(90 * (1 - Math.exp(-elapsed / tau)));
```

覆盖 `BOOTING` 与 `LOADING` 全程（`READY`/`ERROR` 才停表）；就绪时置 100%。

**曲线校准依据**（不是拍一个 τ）：实测 8 秒启动下

| t | 1s | 2s | 4s | 6s | 8s | 上限 |
|---|---|---|---|---|---|---|
| 进度 | 24% | 42% | 64% | 76% | 83% | 90% |

⇒ 开头有明确的"在动"，末段放缓，就绪瞬间跳 100%（完成可见），
且**不会走满一圈再重来**。原 τ=6s 在 7 秒时才 62%，末段明显变慢，用户会觉得"停住了"。

### 四 验证结果

| 项 | 证据 |
|---|---|
| 白屏修复 | `diag-web-load`：`失败：HTTP 404` → **`↳ 保持启动页（未向用户展示错误页），重试预算剩 6 次`** → `成功：页面已就绪（200）` |
| 启动分段 | `BOOT_40 (+317ms)` → `BOOT_50 (+7765ms)` → `BOOT_70 (+7971ms)` |
| 端到端 | 进程 4、端口 3120 LISTEN |
| **回归门禁** | **7/7（AGENTS.md）+ 3/3（专项）全过** |
| 插桩清除 | `hostcore/app/main.js` 与 resfile 副本均无 `SP_TIMING`/`spMark` |
| 用户数据 | 覆盖安装，未触碰 el2 |

### 五 进度条"突然冲一下"（E-SP5，用户复报）

**现象**：启动页进度条跑到某处**停住**，然后就绪时**猛地跳到 100%**。

**根因（两个叠加，且第一个是我上一轮修复引入的）**：

1. **表被提前杀掉**（E-SP1 修复的副作用）。`enterLoading()` 里有
   `stopLoadTicker()`，原意是"离开 BOOTING 就别再走条"。但 E-SP1 把启动页
   也挂到了 `LOADING` 上 ⇒ 两处矛盾：
   ```
   enterLoading() → stopLoadTicker() ⇒ 进度条冻住
   就绪 onPageEnd → progressValue = 100 ⇒ 一次性猛跳
   ```
   修法：**`enterLoading()` 不再停表**。进度表由 `startBrandAnimation` 启动，
   **只由"真的就绪/失败"停止**（判据在 ticker 内部）。

2. **取整 + 指数衰减 ⇒ 后期卡顿**。`Math.floor(90*(1−e^(−t/τ)))`：
   衰减到后期每拍推进不到 1%，取整后整数位**连续多拍不变**（看着像卡住），
   攒够再跳一格。`Progress` 的 `value` 接受浮点 ⇒ **去掉取整**。
   同时节拍从 120ms 收紧到 **40ms**（8fps → 25fps），消除"一格一格"的观感。

**收尾也改成平滑**：就绪时进度约在 80%，直接 `= 100` 仍是"冲一下"。
新增 `finishProgress()`：用 **380ms ease-out cubic** 从当前值补到 100% 再停表。

| 项 | 改前 | 改后 |
|---|---|---|
| 进入 LOADING | 停表（冻住）| **不停表**，继续按时间推进 |
| 数值 | `Math.floor(...)` 整数跳变 | **浮点**，逐帧平滑 |
| 节拍 | 120ms（~8fps）| **40ms（25fps）** |
| 就绪收尾 | `= 100` 猛跳 | **380ms ease-out 补完** |

### 六 顺带说明：设备锁屏会挡住验证

本轮排查中一度误判为"应用崩溃"（进程数 0、无 diag），实际原因是

```
aa start: error: failed to start ability.
Error Code:10106102  The device screen is locked during the application launch
```

**教训**：`aa start` 失败要读 `Error Code`，别急着怀疑自己的改动
（那是"设备状态"而非"代码"问题）。

---

## 批次三十一：独立审查与处置（三路对抗性审查）

> 方法：写三份**对抗性提示词**（见 docs/review-prompts.md），派三路互相独立的审查，
> 各自攻一个方向（正确性 / 一致性 / 工程纪律），**任务是证伪而非复述**。
> 结论不直接采信 —— 每条都自行复核后才处置。

### 一 审查找出的**真实缺陷**（已修）

#### E-RV1 dshm-mark.png 实际带着角标（文档说"纯标记不带"）

**根因**：`whale.alpha_composite(blk_r, ...)` 是**就地**修改（PIL 该方法无返回值），
之后 `mark = whale.resize(...)` 就继承了 HM/OS。
**证据**：mark 与 foreground 缩到同尺寸后逐像素 alpha 差异 **0**，右下角墨点 386。
**修法**：合成角标**之前**先 `whale_base = whale.copy()`，mark 从 whale_base 出图。
**并加自检**（见 E-RV4），防止再犯。

#### E-RV2 pack-core 仍有"只认新名"的标记 ⇒ 重复打补丁而 die

`patchSensevoiceForHms` 判 `text.includes('DSHM_HMS_PROVIDER')` 无旧名分支。
核心树里若是上一版打的 `HDSH_HMS_PROVIDER` ⇒ 判成"没打过" ⇒ 继续替换导出语句，
而它早已被换成 hmsApply 形态 ⇒ `die('未找到 sensevoice 的导出语句')`（本轮实测复现）。
**修法**：加 `|| includes('HDSH_HMS_PROVIDER')`。
（另注：`DSHM_NATIVE_CAPTURE` 那处**本来就兼容** —— 它靠"发现旧段→删除→重注入"，
不是"只认新名"；审查这一条判断有偏差，已核对澄清。）

#### E-RV3 missingAssets 每次识别都整读 228MB 模型

`isAssetReady` 恒 `readFileSync` 整文件算 sha256，而 `missingAssets()` 被
`transcribe`/`inspect`/`snapshot` 反复调用 ⇒ 每次识别都付一遍 228MB 读+哈希。
**且与下载路径刻意"流式写盘避免峰值"自相矛盾**。
**修法**：改**两级校验** —— 默认只 `stat`（存在 + 字节数，微秒级）；
只在**下载收尾**与显式 `{verify:true}` 时才读全文件算 sha256。
理由：文件经我们 sha256 校验后才会被 rename 到正式名，此后被改写的概率极低，
而每次读 228MB 是**确定**的代价。

#### E-RV4 我的自检是"装饰性护栏"（拦不住任何东西）

审查**构造反例**证明：
- "内腔透明采样点 > 0" —— 采样窗里本就有落在鲸鱼**轮廓外**的点，恒透明 ⇒ 永远 >0。
  实测：注入"逐子路径 fill 把内腔填黑"的 bug，脚本仍 exit 0。
- "旋转后墨迹触边" —— `rotate(expand=True)` 会扩画布，墨迹几乎不贴边 ⇒ 几乎不触发。
  实测：注入"块高漏算行距"（作者自述的历史 bug），脚本仍 exit 0。
- "确认启动画面未被改动" —— 只是 `print`，**不做校验**：把 startIcon 加进 outs
  被覆盖后，照样打印"（未改动）"。

**修法**（三条全部做成真断言）：

| 自检 | 新判据 | 为什么能拦住 |
|---|---|---|
| 内腔未被填黑 | 前景**不透明像素占比**须在 16%~20% | 实测正常 18.1%、填黑 23.5% ⇒ 带宽窄于两者之差才有鉴别力（曾用 15%~25%，坏图落在带内 ⇒ 拦不住） |
| mark 不带角标 | 在**角标框内**比较 mark 与 fg 的墨点数（mark 应明显少于 fg） | 直接针对"鳍 vs 鳍+角标"的差异；试过"看右下角有没有墨"（尾鳍本就有墨，无效）与"放大后端逐像素比"（重采样路径不同，遍地差异，无效） |
| 启动画面未动 | 与 `third_party/brand-original/` **逐字节比对**，不符即 exit 1 | 真断言，能拦住覆盖 |
| 写盘顺序 | **全部自检通过后才写** | 旧版先落盘再自检 ⇒ 失败时坏图已污染资源目录 |

**对抗性验证**（把 bug 注入脚本副本，确认自检真的 exit 1）：

```
✓ 拦住  mark 带角标（从 whale 出图而非 whale_base）
✓ 拦住  内腔被填黑（even-odd 换成逐子路径 fill）
✓ 拦住  启动画面被本脚本覆盖（把 startIcon 加进 outs）
```

#### E-RV5 改名后**端侧状态文件**无迁移（升级用户可能丢设置）

改名把 `.hdsh-plugin-rows.yml` → `.dshm-plugin-rows.yml` 等状态文件换了名，
但这些文件在**用户数据目录**里，新代码只读新名 ⇒ 升级老用户读不到自己的插件启停设置。
**本机实测未发生**（该设备改名前后一直在用，宿主首读不到新名时新建了），
但"改名后升级"这条路径**未经验证** ⇒ 做防御性迁移。
**修法**：`migrateLegacyRowsName()` —— 新名不存在且旧名存在时 `renameSync`。
静默容错（失败不阻断启动，退回既有"视为没有用户行"行为）。
单测三种情形：只有旧名→迁移；新名已存在→不动；都没有→false。

### 二 审查找出但**判断有偏差**的（已核实澄清，不改）

| 审查结论 | 核实结果 |
|---|---|
| "宿主真失败时用户永远看不到错误页（BOOTING 期 fail() 不可达）" | **部分成立但影响被高估**：`fail()` 确实只挂在 Web 回调上；但 `retry()` 在 launchUrl 为空时会排重试，且 EntryAbility 的 `adoptLocalHost` 成功后会经 `@Watch` 触发加载。真正的缺口是"宿主**彻底起不来**时无超时兜底"—— 这是既有设计（依赖宿主自行报错），**未改**，已记为已知限制 |
| "DSHM_NATIVE_CAPTURE 只认新名" | **不成立**：该处靠"发现旧 MARK → 删旧段 → 重注入"，旧名同样被识别并替换 |
| "mark 的角标区域是 140..256" | **判据本身有误**：那片区域鲸鱼尾鳍本就有墨，"有没有墨"无法区分鳍与角标。改用"与 fg 在角标框内的墨点比较"后才成立 |

### 三 审查确认**通过**的项（抽查证据）

- HAP 内**无**内置语音模型（rawfile/sensevoice 条目 0）；语音库与下载器在包内
- HAP 内 `startIcon.png`/`logo_dark.png` sha256 = 原版
- 进度条为**线性匀速**（无 `Math.exp`）；`enterLoading` 不停表；启动页含 `!everReady`
- `dshhost`/`libdshhost.so` **未被误改**（346 处命中）
- 改名残留仅剩受保护的两类（`com.hnmrxz.hdsh` 历史名、外部 PPT 工程名）
- 设备纪律：未发现任何破坏性命令（`update-device.ps1` 只做 `install -r`）

### 四 新增门禁与文档

| 项 | 说明 |
|---|---|
| `tools/check-icon-assets.mjs`（新） | 图标资源门禁：AppScope↔entry 逐字节一致、启动资源与原版一致、APP 图标体积在预期带。**对抗验证过**（篡改 startIcon 即 FAIL）|
| `docs/review-prompts.md`（新） | 三路对抗性审查提示词（可复跑）|
| `docs/brand/README.md` | 角标描述改为实际（HM/OS 2×2、10.5%、旋转 45°、mark 不含角标）；补记 `whale_base` 与"写盘前自检" |
| `README.md` | 权限描述由"仅网络三项"改为事实口径（10 项普通权限，无 ACL） |
| `docs/70` E-SP2 | 标注指数曲线方案**已被 E-SP5 取代**（避免文档把旧实现记为当前） |
| `docs/50` | 启动命令里的历史包名 `com.hnmrxz.hdsh` 改为当前 `com.dshm.dshclient` |
| `.gitignore` | 补 `__pycache__/` 与 `*.pyc` |

### 五 验证结果

| 项 | 证据 |
|---|---|
| **回归门禁** | **12/12 通过**（含新增 check-icon-assets）|
| make-icon.py | 全部自检通过；对抗测试三个 bug 全被拦住 |
| 端到端 | 4 进程、端口 3120 LISTEN、`预热成功 模型已就绪=true 第1次` |
| 用户数据 | 覆盖安装；设备上无 `.hdsh*` 残留，25 个非种子插件行正常读取 |

### 六 未处理项（如实登记）

| 项 | 原因 |
|---|---|
| `dist/sideload/` 交付包仍是改名前的旧构建 | 需重新出包 + 重算 SHA256SUMS；本轮未做（改动量大，且不影响功能验证）|
| 宿主彻底起不来时无启动超时兜底 | 既有设计依赖宿主自行报错；加超时兜底会改变既有语义，未擅自改 |
| `third_party/sherpa_onnx-1.13.3.har` 的 x86_64 裁剪步骤只在散文里 | 应在 README 登记为必补构建输入；本轮未做 |
| ~~`tools/check-layout-fixtures.mjs.bak`（09-25，非本轮产物）~~ | ~~来源存疑、无引用；是否删由项目方定~~ ⇒ **2026-09-28 已删**（项目方以"全清"拍板；零代码引用，现役 `check-layout-fixtures.mjs` 在位可跑） |
| `tools/check-dead-code.mjs` 当前为红（3 处 PIAI/View 零使用声明）| 与本轮无关，既有状态 |

---

## 批次三十二：外部问题报告（v2）处置 + 测试探针清理

> 来源：Boki 的《DSHM 问题报告 v2》（2026-09-26，设备 HUAWEI MateBook Pro S / 2in1）。
> 处置原则：**已解决的不管**，只处理仍成立的；每条先自行复核再动手。

### 一 问题二（冷启动概率性白屏）—— **已解决，本轮无需再改**

报告的核心诉求是"失败后缺少自动恢复，唯有用户手动刷新"。
这一点已在 **E-SP1/E-SV16**（批次二十八）修掉：

| 报告描述 | 现状 |
|---|---|
| 首载早于宿主就绪 ⇒ 404 | 保留（宿主启动 ~7.6s，无法消除）|
| **失败后无自动重载**（样本 B 观察 45 秒无恢复）| **已修**：`scheduleAutoRetry()` 指数退避，最多 6 次 |
| 需要手动刷新才能恢复 | **已修**：自愈实测 404 → 600ms 后 200，无需用户操作 |
| "加载中/失败"无显式状态 | **已修**：启动页覆盖 `BOOTING`+`LOADING`（`!everReady`），不再露白 |

真机取证（本轮复测，见批次二十八/三十一）：
```
失败：Host 返回 HTTP 404（已排第 1 次自动重试）
  ↳ 保持启动页（未向用户展示错误页），重试预算剩 6 次
第 1 次自动重试，延迟 600ms
成功：页面已就绪（200）
```

> 报告"附带观察"里的 `NetworkTransactionTimeout`（固定 29475 字节）未复核 ——
> 那是 ArkWeb 网络层日志，指向某个长连接/流式响应未正常结束；
> 本轮未定位到具体端点，**记为待查**。

### 二 问题一（工作区目录无法真正生效）—— **不是 DSHM 原生缺陷**

报告现象：选的 `Documents/dsh_worksapce` 只在 `title` 里，实际 `path` 恒为沙箱。

**核查结论：报告人遇到的沙箱路径是**他们自己的补丁**造成的**（报告附录 B 自述装了
`hdsh-workspace-align`「把会话 cwd / 工作区注册对齐到沙箱镜像」）。

**DSHM 原生形态的证据（三条，互相独立）**：

1. **ArkTS 侧确实拿到并使用了真实路径**。
   `platform/src/main/ets/system/FilePicker.ets` 的 `PickedFolder.path` 由
   `fileUri.FileUri(uri).path` 换来；`Index.ets` 的 `folderUsePath(path)`
   把它 `setDefaultWorkspace` + `ensureWorkspace`，随后 `createSession()`。
   即：原生路径是**用户选的那个**，不是沙箱。

2. **项目代码注释里已有直测结论**（`WebApp.ets` 的目录持久化段）：
   > Host（node）访问用户目录实际依赖 CUSTOM_SANDBOX/READ_WRITE_USER_FILE（已授权，
   > `directoryPicker/list` 与 `workspace/create` **直测均 200**），并不依赖持久化授权。

3. **本机设备日志无任何 EPERM/EACCES**（`grep -icE "EPERM|EACCES" node-output.log` → **0**）。
   若宿主读不到用户目录，这条链上必然出现权限错误。

**已声明的权限**（`module.json5`，与"能直读用户目录"一致）：
`CUSTOM_SANDBOX`、`ACCESS_USER_FULL_DISK`、`READ_WRITE_USER_FILE`、`FILE_ACCESS_PERSIST`。

**未处置的理由**：报告建议的"应用侧授权文件服务（loopback HTTP 端点 + 路径路由）"
是为**它们的补丁形态**设计的绕道。在 DSHM 原生形态下，宿主持有上述权限、可直接以路径读写，
引入文件服务会**多一层间接**且改变上游（项目纪律是对上游零 patch），
因此**不做**。若后续实测发现某形态（如纯手机）确不可读，再按报告方案实现。

> **【2026-10-05 限定与交叉引用（收尾审计补）】本节结论的适用范围必须收紧。**
> 它证明的是：**在已声明的那 5 条 ACL 权限、且设备是 2in1 的前提下**，ArkTS 侧拿到的是
> **用户真实路径**（上面三条证据）。它**不能**推出"**node（Host）侧**能读用户选中的任意公共目录"——
> GitHub issue #3 的真机逐条对照显示 `Documents` / `Download` / `Desktop` 三条路径在 node 侧
> **全部 `EPERM`**：picker 的 URI 授权**不跨进程**继承给 node 子进程（Host）。
> 上面第 3 条"日志里 `EPERM|EACCES` = 0"只说明**当时那条链路没走到被拒的分支**
> （当时选中的是应用自己认领的公共目录，不是 `Documents`），**不是**"node 侧读用户目录不会失败"的证据。
>
> 两件事并行成立、不矛盾：① 路径**是**用户选的真路径（本节结论）；
> ② 该路径在 **node 侧不一定可写**（issue #3 的根因）。
> 现行处置：外壳侧**探写失败就改用应用认领的 `Download/<包名>/`**（`FilePicker.ets` 的公共目录兜底
> + `WebApp.ets:985-996`），并在拿到"PICKED + reason"时由壳层给出提示（`Index.ets` 的
> `openFolderPicker`，2026-10-05 修）；宿主侧的唯一合法来源是 `DSHM_PUBLIC_DOWNLOAD`。
> **复核方式**（issue #3 关单前需要）：选 `Documents` 时看有没有 `diag-picker-public-fallback`，
> 以及 `diag-picker-public-path` 指向哪里。

> **未验证项（如实登记）**：**2026-09-29 更正设备形态** —— 本机是 **2in1**
> （`const.product.devicetype = 2in1`、`model = MNTXM-24B`、`name = HUAWEI MateBook 14`、
> `OpenHarmony-7.0.0.105`），**此前误记为"手机形态"**。
> 但**结论不变**：本机的 `/storage/Users/currentUser` **确实不存在**——
> 实测 `ls -ld /storage/Users` 报 `No such file or directory`，
> 用户可见目录在 `/storage/media/100/local/files/{Docs,Download,Images,…}`。
> 也就是说，缺的是**该发行版的目录布局**，与"手机还是 PC"无关。
> 故"报告的 `currentUser` 路径形态"在本机仍**无法复现**，该未验证项**维持**。

### 三 附加发现（级联拖挂）—— 属上游行为，未改

报告的两个级联案例（`workspace domain is inconsistent` / `corrupt session log`）
都是**数据不一致**触发上游 `dsh-workspace` 的 fail-loud 校验，进而拖挂
`session-controller` / `workspace-controller` / `ui-deliverables`。

**成因是外部工具造成的状态不一致**（报告自述："只改头、不移动文件"的第三方对齐工具）。
DSHM 原生形态下不会产生这类不一致（路径与 cwd 由同一处写入）。

报告建议的"容错/降级 + 自愈入口"需要改 `dsh-workspace` 的校验语义，
那**属于上游**（项目纪律：对上游零 patch，且这类改动要上游评审）。
**未处置**，如实登记为"上游能力诉求"。

### 四 测试探针清理（用户明确要求）

**删除**应用菜单栏里的 4 个测试探针项及其全部实现：

| 菜单项 | 方法 |
|---|---|
| 原生听写（录音→识别→填入）| `runDictateNative` |
| recognizerMode A/B 自检 | `runRecognizerModeAb` |
| 分段起点实验(P1) | `runSegmentStartAb` |
| 复现率探针(Q1/Q2) | `runRepeatabilityProbe` |

**一并删除 10 个探针专用 helper**（否则留下只被已删代码引用的死方法）：
`peakAmplitude` / `rmsAmplitude` / `dictateRecognize` / `insertIntoComposer` /
`recognizeWithMode` / `joinPcm` / `silencePcm` 等。

**保留 `sleepMs`** —— 探针外还有 6 处生产调用。
**保留"原生听写"这个能力的全部实现**（`startNativeCapture` / `takeNativeCapture` /
`ensureMicPermission` / 权限自检）—— 它是**官方麦克风按钮**走的路径，不是探针；
删掉会让语音输入失效。仅删掉"菜单里那个手动触发入口"。

清理量：**559 行**（`WebApp.ets` 2697 → 2210 行）。

验证：探针方法/菜单残留 **0**；保留项（`sleepMs`/`ensureMicPermission`/`startNativeCapture`/
`finishProgress`/`scheduleAutoRetry` 等）全在；括号配平；构建通过；装机后语音正常。

### 五 顺带修复：交付包陈旧（审查发现）

`dist/sideload/` 里是 **2026-09-25 的旧包**，且 `README.md` 的 sha256 与实际文件**不符**
（声明 `cf58b4e1…`，实际 `bbb222f4…`）。按 AGENTS.md 它是交付物，照它装机等于装旧版。
**已刷新为当前构建**并重算校验值：

```
300.3MB  sha256 = a00df5a17688d223229ad35210483d7bfda32f3db542a337b6389817c411db83
README / SHA256SUMS / 实际文件 三者一致（已复核）
```

### 六 本轮验证

| 项 | 证据 |
|---|---|
| **回归门禁** | 13/13 通过 |
| 探针清理 | 4 菜单项 + 11 方法全删（559 行），保留项完好，构建通过 |
| 装机 | 4 进程、端口 3120 LISTEN、页面就绪 200 |
| 语音 | `预热成功 模型已就绪=true 第1次`（官方按钮路径未受影响）|
| 交付包 | README/SHA256SUMS/文件 三者 sha 一致 |

---

## 批次三十三：侧载 debug 版发布前审核（三路独立审查 + 工具链签名修复）

> 目标形态：**侧载 debug 版**（不是上架）。审核重点只三件事：
> ① 能否装上并跑起来；② 功能是否真的对；③ 交付物是否完整可信。
> 方法同批次三十一：写对抗性提示词，三路独立审查，结论**逐条自行复核**。

### 一 ★ 审查发现的最严重问题：工具链自签名被**静默跳过**（E-TS1）

**症状（设备侧）**：
```
exec 探测：python3.12=denied，git=denied，git-core/git=denied，
          git-remote-http=denied，rg=ok，bash=ok，git-ls-remote=denied   ← 2/7
```
只有 `rg`/`bash` 通（它们在核心树里，已被签），**git 与 python 真身全部被 execve 拒**。

**根因（三层，缺一不可）**：
1. 本机 PATH 里**没有** `python3`/`python`/`py`（只有 DevEco 的 jbr 与 node）；
2. `place-toolchain.mjs` 的 `findHostPython()` **只找 PATH** ⇒ 返回 null；
3. 找不到宿主 python 时，自签名**只打一行 ⚠ 就跳过**，脚本仍 **exit=0**，
   **构建全绿、装机后才暴露** —— 而 AGENTS.md 的硬要求是"所有沙箱内 ELF 必须构建期自签名"。

**这一条最危险的地方**：没有任何门禁会红。构建端一切正常，症状只在设备上显现。

**修法（三处）**：

| # | 改动 | 说明 |
|---|---|---|
| 1 | `findHostPython()` 追加候选 | 先试 `DSHM_HOST_PYTHON` 环境变量，再试**项目自带**的 python（`.dsh/dsh-runtimes/.../dependencies/python/python.exe`，实测带 tarfile），最后才试 PATH。**不依赖调用者 PATH** |
| 2 | 签名未执行 ⇒ **exit 1** | 附可直接照做的修法。保留 `DSHM_ALLOW_UNSIGNED_TOOLCHAIN=1` 逃生阀（供只改 ArkTS 的快速迭代），但它会高声提示 |
| 3 | 新增 `tools/check-toolchain-sign.mjs` | 门禁：标记存在 + 是"前缀+摘要"形态 + 摘要与归档实际大小自洽 |

**真机验证（决定性）**：
```
修前 09:05 前：python3.12=denied，git=denied，git-core/git=denied，git-remote-http=denied，
                rg=ok，bash=ok，git-ls-remote=denied                              ← 2/7
修后 09:05:05：python3.12=ok，git=ok，git-core/git=ok，git-remote-http=ok，
                rg=ok，bash=ok，git-ls-remote=ok                                  ← 7/7
```
且换代判定正确触发：
```
工具链：python 归档已换代（dshm-signed.txt 变化），强制重解以取到已签名的 ELF
工具链：git 归档已换代（dshm-signed.txt 变化），强制重解以取到已签名的 ELF
工具链：解包收尾 python=OK，git=OK
```

### 二 审查发现的第二处：标记是**固定常量** ⇒ 换代测不出来（E-TS2）

**问题**：`SIGN_MARKER = 'dshm-signed-v1'` 是**固定字符串**。端侧判据是
`解包目录标记 !== 归档目录标记 ⇒ 重解`。若 09-22 那版（**未签名**）也写同一个常量，
今天这版（**已签名**）标记不变 ⇒ 端侧判成"没换代" ⇒ **不重解** ⇒ 新签名永远到不了设备，
**白签一场**（与历史上"白签一场"同类，只换了触发点）。

**修法**：标记改为 `前缀 + 内容摘要` —— 每个归档目录**各算各的**文件大小之和
（python 与 git 分开，因为端侧是分别比较两个目录的）。归档一变标记就变，换代必然触发。
端侧只做字符串比较，**无需任何改动**。

**实证**：设备上两个目录的标记已变为带摘要形态，且换代判定确实触发（见上）。
```
files/toolchain/gitroot/dshm-signed.txt:    dshm-signed-v1+8501127
files/toolchain/python/dshm-signed.txt:     dshm-signed-v1+27720007
```

> **实现过程中自己踩的坑（留档）**：摘要最初在**签名之前**计算，而签名会改变文件大小
> ⇒ 标记记的是签名前的值，与落盘文件对不上。**新建的门禁立刻报出不一致**（它替我们
> 抓住了这个顺序错误）。改为"签名后、写标记前"计算。这就是加门禁的价值。

### 三 审查发现的第三处：交付包陈旧（E-DL1，**我的操作顺序错误**）

**问题**：`dist/sideload/` 里的 HAP 比 `entry/build/` 的**旧一个版本**
（299.5 vs 300.3MB 差异期；差 1172B，逐条比对**仅** `ets/modules.abc` 与 `sourceMaps.map` 不同）。
反汇编显示 dist 版仍含 `concat`/`sleepMs` —— 那是我**已经删掉的死代码**。

**根因（我的顺序错）**：先刷新了交付包，之后 `check-dead-code` 抓出死代码 → 我删掉 → 重新构建。
**交付包漏掉了最后一次改动。**

**修法**：① 立即刷新，并在刷新**前**断言"没有比构建更新的源文件"、刷新**后**断言
"dist sha256 == build sha256"；② README 的 sha256、字节数、MiB/MB 全部按实际重算
（原 README 的 MiB 与 MB 两个单位换算**都错**）。

### 四 顺带修掉 README 的 4 处与实物不符

| README 原文 | 实际 | 已改为 |
|---|---|---|
| `54 个原生库` | `libs/arm64-v8a` 共 **59** 条目（57 个 `.so` + `libnode.so.137` + `libpython3.12.so.1.0`）| `59 个` |
| `libhdsh-gitcompat.so` | 改名后是 `libdshm-gitcompat.so` | 已更正 |
| `libnode.so` | 实际 `libnode.so.137` | 已更正 |
| `__HDSH_BRIDGES__` | 改名后是 `__DSHM_BRIDGES__`（HAP 内 `__HDSH` 命中 0）| 已更正 |

> README 里 `exec 探测 7/7 全通` 一行原本**与实测不符**（实测 2/7）。
> 修好 E-TS1 后，该行**现在是真的**（实测 7/7）—— 保留而非删改。

### 五 审查确认通过的关键项（抽查证据）

| 项 | 结论 |
|---|---|
| **包名三处自洽** | `build-profile.json5` = `AppScope/app.json5` = p7b 内嵌 `bundle-name` = `com.dshm.dshclient`；HAP 内嵌 profile 与 `~/.ohos/config/*.p7b` **sha256 全等** |
| **调试证书设备绑定** | p7b `device-ids` 与 `hdc shell "bm get -u"` 输出**完全一致**；有效期至 2027-09-27，未过期 |
| **HAP 签名有效** | `hap-sign-tool verify-app`：`verify codesign success`、`Digest verify result: true`、`Verify success` |
| **仅 arm64** | 两包 `libs/` 前缀集合均 `['arm64-v8a']`，x86 命中 0 |
| **语音链路** | HAP 内**无**内置模型（rawfile/sensevoice 条目 0）；语音库在包内；设备心跳 `预热成功 模型已就绪=true` |
| **图标** | APP 图标为新版（含 HM/OS 角标）；`startIcon`/`logo_dark` 与原版**逐字节一致** |
| **探针已清** | 菜单 4 项 + 方法 11 个残留 0；生产用的 `startNativeCapture`/`ensureMicPermission` 完好 |
| **改名残留** | 仅剩受保护两类（`com.hnmrxz.hdsh` 历史名、外部 PPT 工程名）|

### 六 本轮验证

| 项 | 证据 |
|---|---|
| **回归门禁** | **14/14 通过**（含新增 `check-toolchain-sign`）|
| **工具链 exec 探测** | **2/7 → 7/7**（真机实测，决定性）|
| 装机 | `install -r` 成功；4 进程、端口 3120 LISTEN、页面 200 |
| 语音 | `预热成功 模型已就绪=true 第1次` |
| 交付包 | dist **逐字节等于** build；README/SHA256SUMS/实际文件**三方一致** |
| README | 4 处与实物不符已更正；体积三单位（MiB/MB/字节）实测重算 |
| 用户数据 | 覆盖安装，未触碰 el2 |

### 七 未处置项（如实登记）

| 项 | 原因 |
|---|---|
| `check-dead-code.mjs` 仍有 3 处零使用声明（PIAI/View）| **既有状态**，非本轮引入（Index.ets 的 `protocolLabel`、SettingsModels.ets 的 `piAiProtocols`）；属"搬迁未收尾"，需单独处理 |
| `check-dead-handlers.mjs` 报 WorkspacePane/InputDevices 空箭头默认值 | 既有状态：那是 ArkTS `@Prop`/回调的**默认空实现**，属该门禁的已知误报模式 |
| `check-dshm-installer.cjs` 失败 | ~~**既有设计不匹配**（断言 installer 写 `.dshm-plugin-rows.yml`，而 `appendUserRow` 已于 2026-09-25 有意删除）~~ ⇒ **2026-09-28 已重写两处陈旧断言并补 P1-2 双向用例，exit 0 / 24 passed**（**2026-09-29 随 GitHub 安装修复增至 43 passed**，详见 §五）|
| `check-fetch-shim.cjs` / `check-web-fetch-jitless.mjs` | 原记"需特定 node flag（`--no-experimental-fetch`），没跑成而非代码坏"。**2026-09-28 复核：两处都不是环境，是脚本自身缺陷**（flag 的否定形态在 Node 24 无效 / loader 传裸盘符路径 / 前提建在错误 flag 语义上 / 探针打在规范禁用端口 `127.0.0.1:9` / 取证引用取在装垫片之后），**两条均已修 ⇒ exit 0**。其中 `check-fetch-shim.cjs` 长期的红**还掩盖了一个产品真 bug**：原生 `FormData` 被编成字面量 `"[object FormData]"`（砸 dsh 附件上传）。详见 `docs/90-…md` §3.6、`docs/parity-matrix.md` §3.2 |
| `check-arkts-entry.mjs` / `check-layout-fixtures.mjs` | 原记 exit 3：缺 DevEco CLT（tsc），**环境不足**。**2026-09-28 复核：`check-arkts-entry.mjs` 的 exit 3 是真实的脚本缺陷**（四处 Linux 布局写死：`tool/node/bin/node` 缺 `.exe`、`JAVA_HOME` 默认值、`DEVECO_SDK_HOME=join(clt,'sdk')`、`PATH` 用 `:` 而非 `delimiter`）⇒ **已修至 exit 0**（真编译：`CompileArkTS` + `BUILD SUCCESSFUL`）。`check-layout-fixtures.mjs` **同属一类脚本缺陷**（`findTsc()` 只认 Linux 布局）：当时须先用 junction 暴露 `tsc`（建好后 768 条断言 / 0 失败）；**2026-09-30 已把 Windows 候选路径写进 `findTsc()` 本身 ⇒ 不需任何 shim 即 exit 0**，级联的 `neg-test-piai.mjs` 随之转绿 |
| `check-model-roundtrip.mjs` | 本机 PC 侧跑，端侧 `--expose-internals` 垫片是设备专属 ⇒ PC 测不了 |
| ~~`tools/check-layout-fixtures.mjs.bak`（09-25）~~ | ~~来源存疑、无引用；删除与否由项目方定~~ ⇒ **2026-09-28 已删**（项目方"全清"拍板） |
| 2in1 上宿主直读用户目录 | **2026-09-29 更正**：本机**就是 2in1**（此前误记为手机形态）。但 `/storage/Users/currentUser` 在本机上同样不存在（用户目录在 `/storage/media/100/local/files/`）⇒ 缺的是**该发行版的目录布局**，不是设备形态；报告的 `currentUser` 形态仍无法复现，未验证项维持 |

---

## 批次三十四：死代码与死按钮清理（两个门禁从红转绿）

> 起因：上轮登记"check-dead-code 3 处零使用、check-dead-handlers 若干空实现"为既有状态。
> 用户要求清理。清理过程中发现这两条**不只是噪声** —— 里面藏着一个真 bug 和一个门禁缺陷。

### 一 check-dead-code：3 处零使用 → **0**（E-DC1）

| 点位 | 判定 | 处置 |
|---|---|---|
| Index.ets 的 protocolLabel import | **真死** —— 该文件从未调用它（SettingsModels / PiAiProviderSheet 各自 import 并使用）| 删 import |
| SettingsModels 的 @Prop piAiProtocols | **真死** —— 本组件读的是 p.api（经 piAiProtocolText），该 prop 从未被读 | 删 |
| 同上，链路末三跳 | SettingsPane.states → TabContentView.facade → Index 的 facade 对象都在**忠实转发一个没人读的字段** | 一并删（与 E346b 同型）|

**关键判断（差点删错）**：Index.ets 的 @State piAiProtocols **不能删** ——
它在 Index.ets:2177 传给了 PiAiProviderSheet.protocols，而浮层**确实在读**它
（PiAiProviderSheet.ets:239/246 用它渲染协议下拉）。所以只删**末三跳**（转发链），保留源头与真实读者。

> 删完构建报错（piAiProtocols does not exist in type TabContentFacade）⇒ 说明还有一处 facade
> 对象字面量没删干净。这正是"编译器会兜住转发链断裂"的体现：删对了就不会漏。

### 二 check-dead-code 自身的**假阳性**（E-DC2）

清理后仍报一条：

```
entry/src/main/ets/pages/Index.ets:47  零使用 import：// pi-ai 路由（自定义模型 API）：…（有 fixture 断言）
```

指向的是**一句注释**，不是符号。根因：importedNames() 把 `import {…}` 块按逗号切分，
而块内**可以写 `//` 注释**；该注释被当成一个待检查的"名字"。

**修法**：切片后先按 `//` 截断，再要求匹配合法标识符（含 `A as B`），否则视为解析噪声跳过。
并留档说明"假阳性比漏报更糟 —— 它让人不再相信这份报告"。

### 三 ★ check-dead-handlers：**180 处误报里有 2 个真 bug**（E-DH1）

**清理前它报 180 处**，全部是"空箭头函数体（跨行）"。逐条分拣后：**177 处是误报**，
**2 处是真·死按钮**。

**误报的根因**：旧判据报"所有跨行空箭头"，而其中绝大多数是**回调 prop 的必需默认值**：

```ts
onPickFolder: () => void = () => {      // ← 声明处默认值
};
```

ArkTS 组件若回调 prop 无默认值，**父组件不传就编译失败**。所以这是规定动作，与"点了没反应"无关。
180 处的报告量会让门禁**彻底失去信号**（正如该文件自己的历史教训："假阳性比漏报更糟"）。

**收紧后的判据**（区分"声明默认值"与"调用处内联空实现"）：

| 形态 | 示例 | 是否报 |
|---|---|---|
| 声明默认值 + 本文件别处用到 | `onX: (a: T) => void = () => {…}` 且 `this.onX(…)` 存在 | **不报**（正常兜底）|
| 声明默认值 + 本文件从未用到 | 同上但无 `this.onX` | 报（可疑死声明）|
| **调用处内联空实现** | `onX: () => { },`（组件构造参数里）| **报**（子组件一调就无反应）|

**两个真 bug（都是"父组件把子组件回调接成空"）**：

| 位置 | 症状 | 处置 |
|---|---|---|
| MainShell.ets:290 `onStartDiscovery: () => {}` | ConnectPane.ets:210 的「开始发现」按钮调它 ⇒ **点了没反应** | **经核实是有意的**：同处 `discoveryAvailable: false` ⇒ 按钮渲染为「发现不可用」且 `.enabled(false)`（点不到）。已补注释说明"为什么空"+将来接线要做什么 |
| RightbarShell.ets:314 `onCommit: () => {}` | TimelineOverview.ets:103/109 在松手/点击落定时调它 ⇒ 主区会滚列表、右栏**不滚**（看似不一致）| **经核实是有意的**：本组件既有的 timelineFocused 注释已写明"右栏**不滚动主列表**，故只高亮不跳转"。已补注释 |

> 两处都是"**有意的空实现**"，但**原先没有任何文字说明** —— 所以门禁报得对：
> 裸 `() => {}` 无法让人区分"有意不接线"与"忘了接线"。处置是**补注释**，
> 而不是为了门禁变绿去改能跑的代码。

**收紧过程中还修了两个自身缺陷**（记下来避免重犯）：

1. **跨行声明形态漏判**：MessageRow.ets 的 onSubmitFeedback 写成
   `onX: (…) => void =` 换行 `(…) => {` ⇒ 判据只看单行会把它误判成"调用处空实现"。
   改为**同时看本行与上一行**。
2. **只看"声明行之后"导致 6 处误报**：ArkTS 组件里 build() 常写在成员声明**之前**，
   于是 `this.onCoreAction(id)` 在 202 行、声明在 322 行 ⇒ 判成"无人使用"。
   改为**扫全文件、只排除声明那一行**。

**最终：180 → 2 → 0**（两处均以注释说明其有意性）。

### 四 本轮验证

| 项 | 证据 |
|---|---|
| **回归门禁** | **22/22 通过**（含首次转绿的 check-dead-code、check-dead-handlers）|
| check-dead-code | `扫描 99 文件 · 声明 2237 处 · 门面字段 256 个` → **无死代码** |
| check-dead-handlers | 180 → **0** |
| 构建 | 通过（删转发链时编译器报错一次，已修净）|
| 装机 | `install -r` 成功；4 进程、3120 LISTEN、页面 200 |
| 用户数据 | 插件行 33 个仍在；工具链标记与 exec 探测 7/7 均正常 |
| 交付包 | dist **逐字节等于** build；README/SHA256SUMS/文件三方一致（当时的读数 299.5 MiB / 314.1 MB —— **2026-09-30 已刷新到 299.61 MiB / 314,166,762 B**，见 §五 `check-layout-fixtures.mjs` 行之后的续记与 `docs/HANDOFF.md` §4③）|

### 五 保留未处理

| 项 | 原因 |
|---|---|
| check-dshm-installer.cjs | ~~既有设计不匹配（断言 installer 写 `.dshm-plugin-rows.yml`，而 appendUserRow 已于 2026-09-25 有意删除）—— 需**重新定义该门禁要守护什么**，属独立议题~~ ⇒ **2026-09-28 已处置**：两处陈旧断言重写（`^4.3.4`→`4.3.4`；删用户行断言改为锁**不再写用户行**），并补 P1-2 双向极端用例 5a/5b/5c ⇒ exit 0 / `RESULT: 24 passed, 0 failed`（**2026-09-29 增至 43 passed**：GitHub→npm 同名回退、monorepo 子包判定等 19 例） |
| check-arkts-entry.mjs / check-layout-fixtures.mjs | ~~exit 3：缺 DevEco CLT（tsc），**环境不足**~~ ⇒ `check-arkts-entry.mjs` 的 exit 3 是**脚本缺陷**（四处 Linux 布局写死），**2026-09-28 已修至 exit 0**；`check-layout-fixtures.mjs` 同属一类（`findTsc()` 只认 Linux 布局），**2026-09-30 已把 Windows 回退写进脚本 ⇒ 不需 junction 即 exit 0**（exit 3 现为 0 条） |
| check-fetch-shim.cjs / check-web-fetch-jitless.mjs | 原记"需特定 node flag / PC 上无法复现设备专属垫片"。**2026-09-28 已查明并修掉（exit 0）**——两条都不是环境问题，是脚本缺陷；`check-fetch-shim.cjs` 更由此挖出产品真 bug（原生 `FormData` 被编成 `"[object FormData]"`）。详见 `docs/90-…md` §3.6 |
| ~~tools/check-layout-fixtures.mjs.bak~~ | 来源存疑（早于本轮）、无引用 ⇒ **2026-09-28 已删**（项目方"全清"拍板；见 `docs/90` §5.3/§6.3） |

---

## 本轮收尾（2026-09-27）：环境清理 + 全流程文档成稿

**环境清理**（AGENTS.md「一次性排查脚本用完即删」）：

| 项 | 动作 |
|---|---|
| `tmp/` 下 32 个一次性排查脚本（`scan-*.cjs` / `check-paths*.cjs` 等，改名核对那批）| 已删；目录已空 |
| `tmp/r6`、`tmp/r7`（git 签名实验产物 `git_in.elf` / `git_out.elf`，6 MB）| 已删 |
| 根 `workspace/`（空目录）| 已删 |
| `tools/__pycache__`、根 `dshm-host.log`、`*.keep` | 已删 |
| `.gitignore` | 补 `__pycache__/` 与 `*.pyc` |

**未处置（需项目方决策）**：`.codegenie/`（449 MB，IDE 生成物，已 gitignore，
但含**嵌套 `.git`** ⇒ 会干扰 git 状态）。

**全流程文档成稿**：新增 `docs/90-DSH鸿蒙原生实现全流程.md`（**D9**，约 5,200 行 / 413 KB），
六章串联：总览与两个根本约束 → 构建流水线 → 端侧运行时 → 界面与语音 → 验收运维与踩坑总表 →
门禁与工程纪律。同时更新 `docs/README.md` 索引与阅读顺序、`docs/70` 新增 §12（交付/审查/门禁自身的坑）。

**成稿过程中发现并修正的文档错误**（三路对抗性事实核查，抽查 251 条断言）：

| 位置 | 错 | 实际 |
|---|---|---|
| 根 `README.md` | `libnode.so.127` | **`.137`**（实物） |
| 根 `README.md` | 构建步骤缺 `make-icon.py` | 已补为步骤 2d |
| `dist/sideload/README.md` | 核心树"74.5 MB"（单位混用） | 74.5 **MiB** = 78.1 MB |
| D9 §1.2 | 核心树"518 包" | **519** |
| D9 §3.4 | `dshhost.cc` tail 是"从末尾追" | 实为"从**文件头**按 offset 续读全量"（`fseek SEEK_SET`，`SEEK_END` 命中 0） |
| D9 §4.1 | `"sqlite":"3.51.3"` | 实测 **3.53.3** |
| D9 §语音 | fixture 断言 12 条 | **21** 条 |
| D9 §语音 | `STALE_MS` 5 分钟 | **10** 分钟（600000ms） |
| D9 §依赖 | `arch-check --self-test` 8 样例 | **10** 个（2026-09-28 已把脚本收尾文案从写死的 "8 个" 改为按 `cases.length` 计算 ⇒ **不再陈旧**；`docs/10-…md:788` 记的 10 个一直是对的） |
| D9 §日志 | `diag()` 走 stderr | 写 `dshm-host.log` + **镜像到 stdout** |
| D9 多处 | `hostcore/dshm-*.js` | **`hostcore/app/`** |

---

## 批次三十五（2026-09-28：核心 `0.1.7-rc.2` → `0.2.0-rc.1` 同步 —— 三处新增端点、零契约变化，附一个把漂移读反的坑）

**任务**：官方 2026-09-28 发布 `dsh-v0.2.0-rc.1`（GitHub Releases，`prerelease: true`；
npm `dist-tags.next`；`latest` 仍是 `0.1.7-rc.2`），按 `docs/40-上游升级手册.md` 同步。

**结果**：升级成功，**改动面只有 4 处、且不改任何调用代码**（漂移全是新增端点，
落在与我方无关的新命名空间）。过程中撞出一个**能把漂移方向读反**的坑，比升级本身更值得记。

### 一 版本取证：以 GitHub 为准

| 来源 | 读数 |
|---|---|
| GitHub Releases API | 最新 = **`dsh-v0.2.0-rc.1`**，`published_at 2026-09-28T12:36:21Z`，`prerelease: true`，`assets: []`（仅源码归档） |
| npm `dist-tags` | `{alpha: 0.1.7-alpha.2, latest: 0.1.7-rc.2, next: 0.2.0-rc.1}` ⇒ 新版在 `next` 通道 |
| 本仓当前 | `hostcore/core-recipe.json` 的 `coreVersion` = `0.1.7-rc.2` |

> **为什么用 `next` 而不是 `latest`**：本仓上一版取的也是**当时最新的 rc**（`0.1.7-rc.2`），
> 路径一贯是跟 rc 通道走；`latest` 停在上一个正式候选是上游的发布节奏，不代表"没有新版"。

**上游要点（自 `0.1.7-rc.2` 起）**：修复「工具调度异常后对话无法继续」（已执行但结果未知的操作会提示先核实副作用）、
会话图片失效后自动重传、「部分 Linux 环境在缺少可选原生预构建包时的 npm 安装失败」；
调整「自动化任务改由**可选插件包**提供」（原内置）、「工作过程展示在不同初始化路径的默认值」；
以及插件管理引导、「用 DeepSeek 账号模型的会话无需额外 API Key 即可网页搜索」等体验项。
`changelog: https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.1.7-rc.2...dsh-v0.2.0-rc.1`

### 二 升级动作：只有 4 处（脚本化普查，不靠印象）

全仓检索字面量 `0.1.7-rc.2` 得 **43 处**，逐条判定"必须随升级改"还是"文档叙述历史读数"：

| # | 位置 | 为什么必须改 |
|---|---|---|
| ① | `hostcore/core-recipe.json` 的 `coreVersion` | 配方是**唯一事实来源**，所有工具脚本都从它读版本，不写死 |
| ② | `dshcompat/src/main/ets/CompatIndex.ets` 的 `SUPPORTED_VERSIONS` | 受支持矩阵的**唯一声明处**（置 `0.2.0-rc.1` 为首，保留旧版）；同步补版本记录注释 |
| ③ | `dshcompat/src/main/ets/Endpoints.ets` | **生成物，不手改**，由 `gen-compat-endpoints.mjs` 重写 |
| ④ | `tools/update-device.ps1` 的版本判据 | 原为 `if ($afterCores -notmatch '0\.1\.7-rc\.2')` ⇒ 升级后**必然误报 FAIL** 并把结论置"未完全通过"、`exit 1`。**已改为读 recipe**（只要求新版在，不要求旧版不在——旧树并存是预期，见 `docs/50:45`） |

> **本轮遗留 → 2026-09-28 已修**（原记"留档未改"，属独立缺陷、非升级必需；本轮收尾清理一并处理）：
>
> | 原缺陷 | 处置 |
> |---|---|
> | `tools/func_test_final.py` T0.3 写死 `'0.1.7-rc.2'`（跑功能验收会误判） | **已改为读 recipe**（新增 `want_core()`，读 `hostcore/core-recipe.json` 的 `coreVersion`）；同时 T0.2 的 `detail.count('=ok') >= 7` 改为逐项判定（写死总数会在新增探测目标后失效） |
> | `tools/repro_report9.py:41` 写死 `DSHM_CORE_DIR=…/cores/0.1.7-rc.2` | **已删脚本**（一次性复现脚本，零引用；见 `docs/90` §5.3） |
> | `tools/scan-core-plugins.mjs` 默认 `coreDir` 停在 `0.1.5-rc.2` | **已改为读 recipe**：`join(ROOT,'dist','core','work', \`dsh-core-${RECIPE.coreVersion}\`)` |
> | `tools/update-device.ps1` 的 hdc 路径含 `<版本>` 占位符（`Test-Path` 抛异常 ⇒ 脚本在本机无法运行） | **仍未改**：占位符形态属"本机没有 DevEco Sdk 时的模板"，改成自动解析会牵动该脚本的定位（它是给项目方机器用的）。⇒ **本机装机仍只手敲 `hdc install -r`**；`tools/dshtest.py` 的同类占位符**已改为** `DSHM_HDC` → PATH → DevEco 工具链目录依次解析（hdc 自动解析生效，实测得到 DevEco 自带那个）。|

### 三 物化与打包：镜像未同步 + 一次假失败

| 现象 | 根因 | 处置 |
|---|---|---|
| `npm error code ETARGET / No matching version found for @deepseek-ai/dsh-cordis-client-runner@0.2.0-rc.1` | 本机 `~/.npmrc` 写死 `registry=https://registry.npmmirror.com`，而**镜像未同步 0.2.0-rc.1**（`versions` 止于 `0.1.7-rc.2`；`…sensevoice@0.2.0-rc.1` 同样 404） | `$env:npm_config_registry='https://registry.npmjs.org'`（**env 优先级高于 `~/.npmrc`**）；清掉失败留下的半成品 stage 再跑 |
| `pack-core` 报 `$LASTEXITCODE=1` | pwsh 里 `2>&1 \| Tee-Object` 会把 stderr 的 NativeCommandError 混进管道 ⇒ **假失败** | 用 `1> out 2> err` 重定向；实测 **exit=0** |

**读数**：`added 540 packages`（rc.1 当时；升级到 rc.2 时为 519 条，解包后权威计数为 **518 个包 / 26,066 文件 / 252,069,490 B**，见 `docs/parity-matrix.md` §3.3）；
prune 删 24 项 / 85.5 MB，node_modules 330.0 → 244.5 MB；
requiredNative 三项齐；`.codesign` 47 通过、3 未检出（`koffi.node` 属既有现象，另两个是
`pack-core` 自己写的**占位文本**非真 ELF，见批次十六备注）；
产物 `dsh-core-0.2.0-rc.1-openharmony-arm64.zip` **78,705,318 B / 29602 条目**
（**rc.2 实测：78,081,448 B / 29,351 条目**——本行早期写的 `78,104,023 B / 29201` 是错的，2026-09-30 以 `dist/core/dsh-core-0.2.0-rc.2.manifest.json` 与 Python zipfile 复测纠正）；
插件统计 `pluginRows 287→288`、`disabled 23→20`。

> **两个非缺陷但要知道的现象**：① 树内 `dshm-core.json` 带 `builtAt` ⇒ 包**不是可复现构建**，
> 逐次 sha256 不同（三次跑 `9279c4d5…`/`b8b48252…`/`67b85c26…`，条目数与体积恒定）；
> ② `selfSignNatives()` **非幂等**——二次跑会重签 rg（`ensureRipgrepPlatformPackage()` 把未签版拷回）。

### 四 ★ 把漂移方向读反：默认契约快照必须与新上表同步

`tools/compat-drift.mjs` 的默认基线是 `.research/protocol/contracts.json`。上表升到 0.2.0-rc.1 后，
若**只更新上表、不刷新这份快照**，门禁会把本轮**新增**的端点报成：

```
上游移除端点（3）—— 这些调用会返回 HTTP 404
```

——**方向完全相反**，且版本行因读的是旧 `.meta.json` 而显示 `0.1.7-rc.2`。

```sh
cp .research/protocol/contracts-0.2.0-rc.1.json .research/protocol/contracts.json
cp .research/protocol/contracts-0.2.0-rc.1.json.meta.json .research/protocol/contracts.json.meta.json
node tools/compat-drift.mjs; echo "exit=$?"   # 期望 0，版本行显示 0.2.0-rc.1
```

> **判别法**：报告里的"上游移除端点"若恰好等于你**刚在漂移报告里看到的新增端点**，
> 就是快照没刷，不是真的删除。**看到"删除"先怀疑基线，再怀疑上游。**
> 已写进 `docs/40-上游升级手册.md` §4.3（含上游契约自带版本号的机制说明）。

### 五 漂移与上表重生成

| 项 | 读数 |
|---|---|
| 契约采集 | `protocol-contract.mjs` ⇒ `contracts-0.2.0-rc.1.json` + `.meta.json`：`endpointCount 138`、`corePackage 0.2.0-rc.1` |
| 漂移 | **+3 / −0 / 零契约变化**：`productAnalytics/{enabled,report,watchPolicy}`（前两个非流、第三个流且可取消） |
| 我方调用 | 全仓检索 `productAnalytics` 在 `connection/src`、`appstate/src`、`entry/src`、`dshcompat/src`、`hostcore` 下**零命中** ⇒ **不改调用代码** |
| 上表重生成 | 端点 138 / 流式 12 / 能力 15 / 未被能力引用 84；无 `WARN 能力 X 引用了不存在的端点` |

> `.research/` 已被 `.gitignore` 排除 ⇒ 契约是我方**本地取证物**，不入库；
> 新基线同步进本机 `.research/protocol/`，他人复现需按上面命令重采。

### 六 装机与真机验证

AGENTS.md 硬约束「只用 `hdc install -r`，绝不卸载」全程遵守。

| 项 | 证据 |
|---|---|
| 装前基线 | `files/dsh/cores/` 只有 `0.1.7-rc.2`；`files/` 21 项（含 `diag-*` 家族）；应用未运行 |
| 覆盖安装 | `hdc install -r entry-default-signed.hap` ⇒ `install bundle successfully` / `AppMod finish` / **exit=0** |
| **数据保全** | 装后 `files/` 清单**逐项一致**（`dsh/`、`node_modules/`、`toolchain/`、`workspace/`、日志、`diag-*` 全在）⇒ el2 用户数据零损伤 |
| **★ 跑的是新核心** | `files/node-output.log`：`BOOT_10_ENV_READY core=…/dsh/cores/0.2.0-rc.1 home=…/dsh/home port=3120 profile=ondevice` |
| 新旧并存 | `files/dsh/cores/` = **`0.1.7-rc.2` 与 `0.2.0-rc.1` 并存**（升级不删旧树，符合 `docs/50:45`） |
| 树内元数据 | `dshm-core.json`：`coreVersion 0.2.0-rc.1 / platform openharmony/arm64 / profile ondevice / nodeFloor 22.17.0`，三个 `overrides` 与 recipe 一致 |
| 启动序列 | `BOOT_00_NODE_START pid=14922 node=v24.2.0 jitless=true` → `BOOT_20_CORE_FOUND entry=profile-boot.js` → `BOOT_30_PROFILE_READY` → `BOOT_40_PROFILE_BOOT` → `BOOT_65_AUTH_URL tokenLen=43` → `BOOT_60_HTTP_BIND port=3120` → `BOOT_70_HTTP_READY GET / → HTTP 401`（末项耗时 +3629ms） |
| exec 探测七项 | `python3.12 / git / git-core/git / git-remote-http / rg / bash / git-ls-remote` **全 ok**，零回归 |
| 插件挂载 | `grep 'did not activate\|pending (waiting'` **无命中** |

> **日志落点这条要记住**：`BOOT_*` 行在 **`files/node-output.log`**，不在 `dshm-host.log`
> （后者只有 exec 探测与 `IN-UPGRADE`）。本轮一开始就在错的日志里找，白费一轮。

### 七 门禁与构建

| 项 | 结果 |
|---|---|
| 必跑门禁 15 条 | **全部 exit=0**（含本轮修好的 `check-arkts-entry` / `check-web-fetch-jitless` / `check-fetch-shim`）；`compat-drift` **首跑 exit=1 即上面那个读反的假红**，刷新默认快照后 exit=0 |
| `assembleHap --no-daemon` | **BUILD SUCCESSFUL**；`entry-default-signed.hap` 314,673,276 B（**本批次当时的读数**；当前产物为核心 `0.2.0-rc.2` 的 314,166,762 B） |
| HAP 内容核对 | `tar -tf` 确认含 `resources/resfile/dsh-core-0.2.0-rc.1-openharmony-arm64.zip`，**旧 rc.2 zip 已不在包内**（resfile 去旧留新，只留当前版本一份）（**本批次当时的读数**；当前包内是 `dsh-core-0.2.0-rc.2-openharmony-arm64.zip`） |

> 判据纪律照旧：`& node tools/<gate> *> $null` 后读 `$LASTEXITCODE`，**不要用 pwsh 管道判**——
> `exit=2 :: System.Management.Automation.RemoteException` 是假红。

### 八 本轮遗留

| 项 | 状态 |
|---|---|
| **登录拉起系统浏览器（D28 四步）** | 本次 HAP **同时带上了 `WebApp.ets` 的登录修复**，**四步已于同日 21:18–21:34 跑完并全部通过**（详见 D28 的「真机复核」两表）：① 授权页 `auto` 外开；③ 回跳后设置面板出现「账号与余额」section ⇒ `credential-stored`；④ 点「查询用量」⇒ 弹确认框 ⇒ 点「打开」后 `ei.hmos.browser` 真被拉起并加载用量页，且做了阴/阳对照（取消 ⇒ diag/桥/浏览器三者都不动）。`diag-openlink` 累计 6 行（1×`auto` + 5×`confirm`），无 `failed`/`error` |
| 脚本硬编码版本 | ✅ **已处理（2026-09-28 收尾清理）**：`tools/func_test_final.py`（T0.3 改为读 recipe 的 `want_core()`；T0.2 的 `>= 7` 改为逐项判定）、`tools/scan-core-plugins.mjs`（默认 `coreDir` 改为读 recipe）、`tools/repro_report9.py`（属一次性脚本，随清理 `git rm`）。另 `tools/update-device.ps1` 的 exec 探测判据 `$okCount -ge 7` 也改为逐项判定（结论段同步改用 `$execOk`）|
| `tools/update-device.ps1` hdc 占位符 | **仍未改**（脚本在本机仍不可跑，手敲 `hdc install -r` 替代）；但 `tools/dshtest.py` 的同类占位符**已改为**按 `DSHM_HDC` → PATH → DevEco 工具链目录依次解析 |

### 九 收尾清理（2026-09-28，批次三十六）

用户指示「升级完成检测无误后就更新文档，清理环境」，就粒度提问后选定**全清**。四处产物：

| 类别 | 动作 | 结果 |
|---|---|---|
| 一次性排查脚本 7 个 | `git rm` | 计数口径（`git ls-tree -r --name-only HEAD tools` 实测）：顶层 **64 → 57**、递归（含 `lib/`、`electron-runtime/`、`node-runtime/`）**92 → 85** 个文件。删的是：`repro_all.py`、`repro_local.py`、`repro_report9.py`、`close_picker2.py`、`verify_t1_clean.py`、`protocol-enum.mjs`、`check-layout-fixtures.mjs.bak`（124824 B，原"由项目方定"，本轮以"全清"拍板）；逐个 `Test-Path` 复核全部不存在 |
| `dist/` 本轮临时重定向产物 6 个 | 删除 | `_drift.{out,err}`、`_drift2.{out,err}`、`_build020.{out,err}`（2026-09-28 21:08–21:09 本轮升级产生）；`dist/sideload/` 交付物保留 |
| 保留脚本的硬编码 | 改 | `scan-core-plugins.mjs` 默认 coreDir、`func_test_final.py` T0.3 + T0.2、`update-device.ps1` exec 判据、`dshtest.py` 的 hdc 路径 —— 判据统一从 `hostcore/core-recipe.json` 读 |
| 文档悬引用 | 改 | 8 个文档：`10`、`50`、`70`、`90`（§5.3/§5.6/§5.7/§6.3/§8.1）、`device-validation`、`functional-test-report`、`parity-matrix` |

**保留**（有活引用/属门禁体系）：`tools/func_test_final.py`、`tools/dshtest.py`（验收资产）、`tools/dump-piai-schema-full.mjs`、`tools/neg-test-piai.mjs`（负测试）、`tools/protocol-enum2.mjs`。

**验证**：`tools/func_test_final.py` 与 `tools/dshtest.py` 过 `py_compile`（exit 0）；`dshtest.py` 的 hdc 自动解析实测得到 `C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe`。

---

## 批次三十六：关闭行为改造 + 连接状态误报（0.2.0-rc.1）

> 用户实测反馈两条（2026-09-28）。
> 装机时设备锁屏，`aa start` 返回 `Error Code:10106102`（"设备已锁屏"），非崩溃。
>
> **⚠️ 本节已被** [`批次三十七`](#批次三十七托盘定为最终形态--启动40-秒自杀未判因--连接抖动定因0.2.0-rc.1)
> **部分取代**（2026-09-29 真机验证后回填）：
> 1. 「问题 1」的**改法本身仍然有效**，但其**退出路径**（顶栏「DSHM」菜单 → 退出应用）已被
>    用户否决并**删除**，改为**托盘图标右键菜单**；托盘还必须经 `StatusBarTray.hold()` 第二进程贴住
>    才真正常驻。判据以此处保留 + 批次三十七为准。
> 2. 「问题 2」的**根因判定（ArkTS `RemoteMux.ets` 探活过激）已被推翻** ——
>    用户看到的是 **WebView 里的 host web UI**，ArkTS 自绘 UI（`pages/Index.ets`）根本不可达，
>    该改动对用户可见现象**无效**。真因见批次三十七。
>    （`RemoteMux.ets` 的那组改动保留：它本身是"高负载下探活容错"的合理加固，**但不是**本现象的因。）

### 问题 1：加上任务栏图标；关闭 → 切后台；点图标回前台（E-CB1）

**改前**：点右上角关闭 = 直接终止应用（正在跑的任务与 Host 长连接一起断）。

**改法（5 处）**：

| # | 文件 | 改动 |
|---|---|---|
| 1 | `entry/src/main/module.json5` | 声明 `ohos.permission.PREPARE_APP_TERMINATE`。SDK 权限表：`availableLevel: normal` + `grantMode: system_grant` ⇒ 普通应用可声明、安装即授予、无运行时弹窗 |
| 2 | `entry/src/main/ets/entryability/EntryAbility.ets` | 新增 `onPrepareToTerminate()`：主窗返回 `true`（**取消**终止）并 `win.minimize()` 切后台；会话窗、以及"显式退出"标记存在时返回 `false`（放行） |
| 3 | 同上 | **接上 `KeepAlive`（长时任务）** —— 见 E-CB3 |
| 4 | `entry/src/main/ets/pages/WebApp.ets` | 顶栏「DSHM」菜单新增**退出应用**（`terminateSelf`）。因为关闭按钮已不再退出，**必须**另给一条真退出路径，否则用户被关在里面 |
| 5 | `entry/src/main/module.json5` | **声明 `backgroundModes: ['dataTransfer']`** —— 实测发现：光有 `KEEP_BACKGROUND_RUNNING` 权限**不够**，不声明本字段时 `startBackgroundRunning` 直接失败（见 E-CB3）|

**四条必须写下来的判据**：

1. **为什么不用 `windowStageClose`**：SDK 明确「若应用（或三方框架）注册了
   `windowStageClose` 监听，`onPrepareToTerminate` **不会被执行**」⇒ 两条路只能选一条。
   本工程选后者，**刻意不注册**前者。
2. **只在 2in1 与平板生效**：SDK 原文 "This API executes the callback normally only on
   2-in-1 devices and tablets. It does not execute the callback on other devices."
   ⇒ 手机全屏下点关闭仍按系统默认（回桌面），这是**平台行为**，不是实现缺陷。
3. **返回值语义别记反**：`true` = **取消**终止；`false` = 继续终止。顺序也不能反 ——
   必须先返回、再最小化；先最小化再返回的话系统仍会走完终止流程。
4. **任务栏图标本来就具备**：`AppScope/app.json5` 早已声明
   `icon: $media:layered_image` + `label: $string:app_name`（= "DSHM"）；
   `removeMissionAfterTerminate` **未声明**（默认 false ⇒ 关闭后任务条目保留），
   这正是"点任务栏图标能回来"所需。**无需新增资源**。

### 问题 2：跑任务时反复显示"正在连接"（**Windows 端同样出现**）（E-CB2）

**根因**：探活判死**过激**。

`connection/src/main/ets/protocol/RemoteMux.ets` 的探活实现中，**探活超时计时器与收帧回调
跑在同一个 JS 线程上**。跑任务时线程与网络都被占住、回帧处理被推迟，而原实现
**单次超时（8s）即 `onSocketClosed`（判死）** ⇒ 触发重连 ⇒ 界面闪"正在连接"。

**为什么"Windows 端也有"是定位的关键**：这条判据由**负载**触发，不是平台差异。
若只在鸿蒙上出现，才该怀疑平台；**两端都出现就该怀疑策略本身**。
这直接把排查从"鸿蒙适配问题"拉回"客户端探活策略对高负载没有容错"。

**改法**：

| 项 | 改前 | 改后 |
|---|---|---|
| 单次超时 | 立即判死 | 只记一次失败（`noteProbeFailure`） |
| 判死条件 | 单次 | **连续 3 次**无回帧（`PROBE_FAIL_THRESHOLD`） |
| 超时阈值 | 8000ms | **20000ms**（服务端 2s 一个 Ping ⇒ 10 个周期） |
| 失败计数清零 | — | 收到**任何**帧即清零（`settleProbe`）；连接建立/停止时也清零 |

**为什么这不是"把断线检测改弱"**：

- **真断线不靠这条路径发现**：socket 真死由 `close` 事件**立即**上报
  （WebSocket 层的权威信号）。探活只兜「`close` 不来」的**静默失效**场景
  （D2 §8.7.13 记录过这种失效）。
- 该场景下最坏约 1 分钟才判死（3 × 20s 起）。这是**可接受**的代价 ——
  远优于把所有健康连接在负载下反复误杀（后者会让"跑任务"变成"一直重连"）。

**顺带修掉一处自相矛盾的注释**：`startLivenessProbe` 上方写着
"为什么带唯一 `cursor`：让应答可辨认"，而**正下方代码**明确写了
"cursor 已移除，否则会把健康连接判死"（`gateway/arguments-invalid` 那次的教训）。
文档与代码相反 ⇒ 一并改正。这类"文档撒谎"会让后来者按错的注释去改代码。

### 顺带修掉的既有缺口：`KeepAlive` 写好了但**从未被调用**（E-CB3）

`platform/src/main/ets/notify/KeepAlive.ets` 有完整的长时任务实现
（`attach` / `acquire` / `release` / `forceRelease`），但**全仓无人调用** ——
只有 `platform/Index.ets` 的 re-export（全仓搜 `KeepAlive` 仅 5 处，全在定义与导出）。

**后果**：应用退到后台会被系统挂起 ⇒ 与 Host 的长连接断、正在执行的任务停。

**这条缺口让问题 1 的修法本来会是空的**：没有保活，
`onPrepareToTerminate` 的最小化只是"把窗口收起来"，任务照样丢 —— **与用户诉求相反**。

**改法**：主窗窗口就绪后 `keepAlive.attach(this.context)` + `acquire()`；
`onDestroy` 里 `forceRelease()`（用 force 而非 release：销毁是终局，
计数若因异常路径偏高，`release` 会留下一个永不释放的任务）。
申请失败**只降级**（日志警告），不阻断任何功能。

### 本轮验证

| 项 | 结果 |
|---|---|
| 构建 | `assembleHap` **BUILD SUCCESSFUL** |
| 回归门禁 | **23/23** 通过（含 `check-dead-code` / `check-dead-handlers`）|
| 装机 | `hdc install -r` 成功（不动 el2 用户数据）|
| 产物 | `entry-default-signed.hap` 300.2 MB，sha256 `f7ccd1ae93c3daab…` |
| 真机行为 | **✅ 已逐项验证**（见下节「真机验证证据」）|

**当时列的三件事，回填结论见批次三十七**：

1. **2in1 点右上角关闭 → 切后台**：✅ 验证通过（判据：窗口消失但 `ps` 里进程仍在，
   `BackGroundAbility` 子进程在，托盘图标在）。
2. **顶栏「DSHM」菜单 → 退出应用**：❌ **该路径已按用户要求删除**，改为托盘右键菜单。
3. **跑长任务不再闪"正在连接"**：❌ **未通过**（根因判定被推翻，见本节抬头与批次三十七）。

---

## 批次三十七：托盘定为最终形态 + 启动 40 秒自杀（未判因）+ 连接抖动定因（0.2.0-rc.1）

> 2026-09-29，设备 `86E0226429000417`（HUAWEI MateBook 14 / `MNTXM-24B` / `devicetype=2in1`，
> OpenHarmony-7.0.0.105 / API 26）。本批次含**三条**用户反馈的实测结论。

### 一 托盘：从「能挂上」到「最终形态」

**背景**：批次三十六挂上了图标，但真机上**点关闭后托盘图标不存在**，用户复现了两遍。
根因是**少了官方三步里的第二步**：`addToStatusBar` 只是"申请一个位置"，
必须再 `startAbility` 一个 `processMode = NEW_PROCESS_ATTACH_TO_STATUS_BAR_ITEM` +
`startupVisibility = STARTUP_HIDE` 的 UIAbility，**把进程贴到图标上**，图标才常驻。

新增两个文件：

| 文件 | 作用 |
|---|---|
| `entry/src/main/ets/system/StatusBarTray.ets` | 封装 `statusBarManager`：`install()`（挂图标，含菜单）/ `hold()`（第二进程贴住）/ `remove()` / `onIconClick()` / `onRightMenuClick()` / `isReady()` / `publishExitRequest()` / `subscribeExitRequest()` / `subscribeBgTerminating()` / `delayBeforeTerminate()` |
| `entry/src/main/ets/backgroundability/BackGroundAbility.ets` | 被 `hold()` 拉起的无窗口 Ability；`onWindowStageCreate` 里 `hideAbility()`；`onPrepareToTerminate()` → `notifyBgTerminating()` → 返回 `false` |

**★ 关键事实：托盘 API 来自 HMS，不是 OpenHarmony SDK**。

```ts
// kit: sdk\default\hms\ets\kits\@kit.DeskTopExtensionKit.d.ts（@since 6.0.0(20)）
import { statusBarManager } from '@kit.DeskTopExtensionKit';
```

OpenHarmony 的 `ets/api` 下**没有**这个 kit —— 在仓库里 grep `statusBarManager`
只能命中 `hms/` 目录。声明全量在 `sdk\default\hms\ets\api\@hms.pcService.statusBarManager.d.ts`（794 行）。

**踩过的三个坑**：

1. **`addToStatusBar` 是全有全无**：带 `statusBarGroupMenu` 的形态一旦被拒（菜单项数/`menuCode` 唯一性
   等），整个图标都挂不上。`install()` 因此**退回**到不带菜单的 `bare` 形态再试一次，
   第二次仍失败才抛出。
2. **`QuickOperation.abilityName = ''`** ⇒ 左键点击走 `statusBarIconClick` 事件，由应用自己处理
   （SDK 原文：传空字符串时点击服务可由监听该事件处理）。
3. **`menuAction.notifyOnly = true` + `menuCode`** 才能让右键菜单项回到
   `on('rightMenuClick')` 由应用处理，否则系统会尝试 `startAbility`。

**用户两次修正，都照做**（`User said` 原话）：

| # | 用户说 | 落地 |
|---|---|---|
| 1 | "任务栏上右键两个功能：退出应用，退出，只要一个就好了，单击图标直接打开APP即可" | 去掉重复项 |
| 2 | "系统会自带一个退出，可以把退出应用改成打开应用" | 我们的菜单项改名为**打开应用**；真退出交给系统自带的「退出」 |

**真机实测的最终布局**（`uitest dumpLayout`）：

| 节点 | bounds | 说明 |
|---|---|---|
| 托盘图标 | `[1853,5][1913,68]`（`PluginRootComponent_Single_537591617`） | 顶栏胶囊行 `PcCapsuleComponent_Row_capsule` 内；**id 每次 dump 都会变** |
| 右键菜单体 | `[1853,81][2133,250]`（`Menu`） | |
| ├ 我们的「打开应用」 | `[1860,88][2126,158]` | `PcAccessRightMenu_RightMenuItem` |
| └ 系统「退出」 | `[1860,173][2126,243]` | `PcAccessRightMenu_RightMenuExitItem` |

进程侧佐证（`ps -ef`，两进程都在 ⇒ `hold()` 生效）：
```
20020292 14605 … com.dshm.dshclient
20020292 15949 … com.dshm.dshclient:entry:BackGroundAbility:10
```

**「退出应用」已从顶栏「DSHM」菜单删除**（用户要求"不要放在菜单里，换别的方式退出"）。
理由不只是用户没看到该菜单：**「关闭窗口」已经到了"切后台"**，
把"真退出"放在紧邻窗口右上角三键的同一个视觉区域，**用户极易点错**；
托盘右键是系统级常驻位置（微信等 PC 应用同款），语义上就该是"对整个应用动手"。

**系统自带的「退出」不经过 `EntryAbility.onPrepareToTerminate`** —— 实测真退出且该回调无日志。
所以"拦截关闭"与"托盘退出"这两条路径天然不冲突。

### 二 ★ 应用冷启动约 40 秒后自杀（**未判因，已立项**）

**时间线**（日志为 UTC，本地 = UTC+8）：

| UTC | 本地 | 事件 |
|---|---|---|
| `09:40:03.637Z` | 17:40:03 | `dshm-host.log`：`--- boot pid=14371`（`update-device.ps1` Step6 的 `aa start`） |
| ~`09:40:06Z` | 17:40:06 | 长时任务通知建立（下面那条显示已存在 37.4s） |
| **`09:40:43.510Z`** | **17:40:43** | **`!! process.exit(0)：停止路径放行，真正退出`** ⇒ 冷启动后 **40 秒** |

同刻 hilog 显示整个进程死亡：`AppLifeCycleManager: Ability state changed … state 5` /
`WMSLife: requestDestruction … name: EntryAbility/com.dshm.dshclient/entry/0(persistentId: 159)` /
`requestSceneSessionDestruction … terminateReason: 2` / `AppUsageAbility: process died`；
托盘图标被摘：`MessageAccess: removeAccessPluginInfo slot: 537591617 bundleName: com.dshm.dshclient`
（⇒ **确认 `537591617` 就是我们的托盘图标**）；长时任务通知被撤（`exist duration: 37363 ms`）。

**嫌疑链**（**未证实**）：`host-stop-request` 只可能由 `DshHost.stop()` 写出；
其非用户路径调用点只有 `EntryAbility.exitApp()`（`hostruntime` 的 `switchTo/rollbackTo`
仅在 `!port.isRunning()` 时写，本次宿主在跑 ⇒ 排除）。`exitApp()` 的触发点只有两个：
托盘右键「打开应用」（需人手点击，本次没有）与 **`StatusBarTray.subscribeBgTerminating`**
（源头 = `BackGroundAbility.onPrepareToTerminate()` → `notifyBgTerminating()`）。
⇒ **怀疑系统在启动约 40s 后例行触发该回调，我们把它当成"托盘后台进程已被系统结束"，
进而关掉了整个应用。** 这条链本意是防"主 Ability 已死、图标还挂着"的半死态，
若该回调会被例行调用，它就成了**自杀路径**。

**已排除**：`appfreeze` / `APPFREEZE` / `SIGKILL` / `LowMemory` 在 hilog 里 **0 命中**；
`memmgrservice` 只有 6 条无关行；`/data/log/faultlog/faultlogger|temp` 均 `Permission denied`（查不到崩溃单）。

**下一步**：冷启动后静置 90s 看是否复现；复现即在 `onPrepareToTerminate` 与 `notifyBgTerminating`
两侧加"调用者日志"定位；再决定"只摘图标不退应用"或"整体删掉该链"。

### 三 ★ 「正在连接」抖动定因：**Host 心跳误杀健康连接**（两端同源）

**现象**：左下角设置 banner 反复闪「重新连接中 → 连接成功」（鸿蒙端 m01711，Windows 端 m04277）。

**Windows 端实测**：`Get-NetTCPConnection -OwningProcess <dsh-desktop-host>` 每 2s 计数序列
`16, 6, 5, 6, 6, 5` ⇒ socket 在被**周期性掐断并重建**，与 banner 闪烁同源。

**机制（上游源码，两端共用同一 core）**：

- `@deepseek-ai/dsh-api-gateway/lib/index.js`：`MAX_MISSED_HEARTBEATS = 2`（`:172`）；
  `startHeartbeat()`（`:241-248`）每 `websocketHeartbeatIntervalMs` 给每个 OPEN socket 发 Ping，
  漏 2 次 Pong 即 `socket.terminate()`。默认周期 **2000ms**（schema `:597`）⇒ 约 **3 个周期（4–6s）**判死。
- ★ **误杀机理**：**发 Ping 与收 Pong 跑在 Host 同一个事件循环上**。任务一忙
  （端侧还是 `--jitless`，无 JIT）事件循环被占 ⇒ 计数照涨 ⇒ **健康连接被杀**。
  上游 README 原文：「`websocketHeartbeatIntervalMs` 同时是 Ping 周期和 Pong 截止时间……
  **如果部署的事件循环或网络可能停顿超过该间隔，必须调大此配置**」。
- 「**Windows 端也有**」这条线索是关键：判据由**负载**触发，不是平台差异。
  两端都出现 ⇒ 怀疑策略本身，而不是鸿蒙适配。这直接把排查拉回"客户端探活策略对高负载没有容错"。

**Client 侧**（`@deepseek-ai/dsh-client-connection/lib/client.js`）：断线 → `emitState("disconnected")`
→ `backoffDelay`（`backoffBaseMs 500` / `factor 2` / `backoffMaxMs 1e4`，半抖动）
→ 重试前 `emitState("connecting")`（`:1040`）→ 握手成功 `emitState("connected")`（`:1097`）。
UI 侧 `CONNECTING_MIN_VISIBLE_MS = 800`（`dsh-client-ui-settings-general/lib/client.js:242`）
⇒ banner 闪 = **socket 被掐 + 立刻重连成功**，与心跳误杀高度吻合。

**次要触发源（已实证）**：`node-output.log` 里 WebView 到 `ws://127.0.0.1:…` 报
`ERR_CONNECTION_REFUSED(-102)`；另有 arkweb 自带 30s `NetworkTransactionTimeout` **206 次**
（`net/http/arkweb_http_network_transaction_ext.cc:344`，`receivedBodyBytes:30711` 占 99 次）。
⇒ 宿主进程短时不可达（例如上面「二」的自杀）也会造成同一现象。

**修法（未落盘）**：profile 里给 `typert-gateway` 覆写 config（patch 语义为**整块替换**，两个键都要列）：

```yaml
- id: typert-gateway
  name: "@deepseek-ai/dsh-api-gateway"
  config:
    websocketHeartbeatIntervalMs: 30000
    streamInboxBytes: 262144
```

| 端 | 落地文件 | 生效代价 |
|---|---|---|
| Windows | `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`（当前**没有**该覆盖 ⇒ 仍 2000ms） | 重启 desktop |
| 鸿蒙 | `hostcore/profile/ondevice/cordis.patch.yml` | **`node tools/pack-core.mjs` → 重建 HAP → `hdc install -r`** |

### 四 本批次的一条方法论教训（hilog 取证）

`hdc shell "hilog -w query"` → `… /data/log/hilog/hilog **4.0M** 1000` ⇒ 缓冲区 4 MB。
清空后 **12 秒** dump 得 7943 行，其中 261 行是 arkweb 噪声
（`A00000/com.dshm.dshclient/DSHM-NODELIVE: [../../arkweb/chromium_ext/…]`
—— `DSHM-NODELIVE` 是 **arkweb 转发 web console 的 tag，不是我们的业务日志**）。
我们自己的 `entry/tray`、`entry/background`、`testTag` **0 命中** ⇒ **不是没打日志，
是缓冲只覆盖约 8–10 秒被冲掉**。

**纪律**：`hilog -r` 清空 → **立刻**执行动作 → **数秒内** dump。
另**不要用 `hdc shell 'cmd | grep A|B'`**：`/bin/sh` 会报 `B: inaccessible or not found` 并**挂死**命令（曾需强杀）。

## 批次三十八（2026-09-30：核心 `0.2.0-rc.2` 真机复测**全绿** + 验收脚本两处缺陷根治）

**本批次无功能改动，只有取证与工具修正。** 结论一句话：**上一轮的两条失败断言全转绿（38/38），
而"验收脚本报 4 项 FAIL"是本轮唯一发现的缺陷——全在脚本里，不在应用里。**

### 一 设备与产物现状（实测）

| 项 | 读数 |
|---|---|
| 设备 | `86E0226429000417` HUAWEI MateBook 14 `MNTXM-24B`，`devicetype=2in1`，OpenHarmony-7.0.0.105 / API 26 |
| 已装包 | `bm dump`：`versionName 1.0.0` / `versionCode 1000000` / `updateTime 1790694212888`（= 2026-09-29 23:00:13 CST）⇒ 装的就是 rc.2 那份 HAP |
| 进程 | 主进程 pid **10135 起于 06:59:26**，11:43 观测 ⇒ **连续存活约 4.7 小时**；另有 `:entry:BackGroundAbility` / `:gpu` / 两个 `:render` |
| 运行核心 | `node-output.log`：`BOOT_10_ENV_READY core=/data/storage/el2/base/haps/entry/files/dsh/cores/0.2.0-rc.2 home=… port=3120 profile=ondevice (+13ms)` |
| 核心树 | `…/files/dsh/cores` 下 **0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.0-rc.2 三棵并存**（新旧并存是预期行为，不是残留故障） |
| 端口 | `netstat -tunlp`：`127.0.0.1:3120 LISTEN` + 多条 ESTABLISHED（客户端已接入） |

### 二 `tools/func_test_final.py`：**PASS=38 / FAIL=0 / MANUAL=6**

命令：`C:\Program Files\Huawei\DevEco Studio\plugins\harmony\lib\python\python.exe tools\func_test_final.py`
（`$env:DSHM_HDC` 指向 hdc；输出落 `dist/_func_test_run2.log`，现场落盘 `dist/_func_test`）。

**两条上轮失败项已转绿**：

| 断言 | 上轮 | 本轮 |
|---|---|---|
| `T0.4 Host HTTP 有响应` | `HTTP ERR` | `HTTP 401，[Forward] tcp:13120 tcp:3120`（未带凭据的 401 是正常响应） |
| `T2.4 会话列表渲染历史会话` | 失败 | `5 个会话` |

其余关键读数：`T0.2 exec 探测 7/7`（python3.12 / git / git-core·git / git-remote-http / rg / bash / git-ls-remote 全 `=ok`）、
`T0.3 运行核心 0.2.0-rc.2`、`T1.3` 系统目录选择器 378↔808 节点、`T2.5/T2.6` 前端接口 4 个会话 websocket、
`T3.1–T3.6` 插件页、`T4.*` 工具链与文件系统、`T5.1–T5.8`（jitless fetch 垫片 / undici loader / 原生重定向 /
execPath spawn / `DSHM_PLATFORM=ohos` / CLI 假壳 / bash 垫片 / python 桥）。

6 项 `MANUAL`（脚本判不了，需看界面）：M1 命令面板与皮肤切换、M2 外观深浅、M3 状态栏颜色、
M4 右侧工作台 Tab（文件变动/变更/终端）、M5 皮肤渲染（kimino-theme）、M6 真实 API Key 对话。

### 三 首次验收跑出 4 项假 FAIL —— **全部是 `tools\device-acceptance.ps1` 自身缺陷**

证据目录 `dist\acceptance\20260930-114428\`（`-SkipInstall`）。两个决定性异常：

- **5 份 log 全部 5 字节**（只有一个换行）⇒ 判据全取不到；
- **9 组 `.json` / `.jpeg` 尺寸完全相同**（`*.json` 恒 `261,513 B`、`*.jpeg` 恒 `232,434 B`）⇒ 6 次 `Click-Text` 一次都没点动。

由此 6 项判定出现 4 项 FAIL：`核心已启动` / `客户端已接入` / `平台标识 = ohos` / `文件变更流已开`。

**根因（三件，互不相关）**：

1. **hilog 当判据必然假 FAIL**：hilog 是环形缓冲（`hilog -w query` → 4 MB），实测只覆盖约 8–10 秒；
   而脚本 `hilog -r` 清空后要等 `$BootWaitSeconds`（默认 45 s）才抓 ⇒ 一次性启动事件
   （`BOOT_10_ENV_READY` / `平台标识` / `DSHM-AUTH connect`）即便重现也早被冲掉。
   另 `-SkipInstall` 下**不重启应用**，`aa start` 对已运行进程是 **no-op** ⇒ 启动事件永不重现。
2. **导航路径写错**：主界面**没有「设置」这个文本**；真实路径是先点「账号菜单」（`popUpButton`）→ 弹层里才有
   `设置` / `意见反馈` / `退出登录`。而且脚本点的「通用 / 核心 / 预设 / 技能」**三个根本不存在**
   （设置对话框真实左栏是 **账号与余额 / 通用设置 / 模型 / 内置插件 / Agent 预设 / Our Free Model / 插件市场 / 皮肤市场 / 侧边卡片**）。
   更关键的：**重启后主窗口会位移**（实测 `应用` 从 `[67,90]` 变 `[513,302]`）⇒ 坐标必须每次 dump 现取。
3. **两条判据结构性取不到**：`DSHM-AUTH connect` 的唯一产出点是 `entry/src/main/ets/pages/Index.ets:1365`，
   而入口是 `windowStage.loadContent('pages/WebApp')` ⇒ `pages/Index` **不可达**；
   `files changes opened` 的唯一产出点 `entry/oh_modules/appstate/src/main/ets/store/SessionHub.ets:2500` 走 `console.info` → hilog，
   且 `fs-watch` 在 `dshm-host.log` **全史只出现 1 次**（2026-09-27T09:38:02.666Z）⇒ 不能当每次验收的判据。

**判据 ↔ 新信号源（设备侧持久文件，`shell` 身份可读）**：

| 原判据 | 新信号源 | 依据 |
|---|---|---|
| 核心已启动 | `…/files/node-output.log` 的 `BOOT_10_ENV_READY core=…/dsh/cores/<ver>` | **每次启动轮转**，本轮权威；顺带读出运行核心版本 |
| 客户端已接入 | `…/files/dshm-host.log` 的 `IN-UPGRADE GET /api/remote.mux` | 跨启动累积，配合启动标记切片 |
| 平台标识 = ohos | 同上两个文件的 `平台标识：DSHM_PLATFORM=ohos` | 两边都记 |
| 文件变更流已开 | **无稳定源** ⇒ **降级为人工项** | `fs-watch` 全史 1 次 |

> **设备侧路径的坑（本轮踩到并纠正）**：可读的是
> `/data/app/el2/100/base/com.dshm.dshclient/haps/entry/files`；
> 日志里显示的 `/data/storage/el2/base/haps/entry/files` 是**应用自身沙箱视图**，
> `ls` / `grep` / `file recv` 全部 `Permission denied`（shell 身份 `uid=2000(shell)`）。
> `/data/log/faultlog/faultlogger` 同样取不到。
>
> **读中文日志的方式**：`hdc shell cat` 会经控制台 GBK 解码把中文全解坏 ⇒ 必须 `hdc file recv` 落盘后
> 用 `[System.IO.File]::ReadAllText($p,[Text.Encoding]::UTF8)` 读（`E387`）。

### 四 修法与复跑：**5 项判定全 PASS**

`tools/device-acceptance.ps1` 由 215 行重写为 **307 行**，改了四处：

- **强制冷启动**：`aa force-stop` → (`hdc install -r`) → `hilog -r` → `aa start`，并新增 `-HilogEarlySeconds`（默认 8）
  先抢一份 hilog 早期窗口；
- **判据改读设备侧持久日志**（`E385`），并撤掉两条取不到的判据（自动判定由 6 项改 **5 项**）；
- **导航改两段式 + 现取坐标**：`账号菜单` → `设置` → 九个实测分区，每项记 OK/FAIL 写 `nav.md`；
- **两个环境坑**：`hdc` 不再只认写死的一条路径（`E386`）；`.ps1` 必须带 **UTF-8 BOM**，否则 PowerShell 5.1 按 ANSI 解码 ⇒ 中文标签全乱。

复跑（2026-09-30 12:01，`-SkipInstall`，证据目录 `dist\acceptance\20260930-120131\`）：

```
[PASS] 设备在线
[PASS] 核心已启动（读出运行核心版本）   BOOT_10_ENV_READY core=…/dsh/cores/0.2.0-rc.2 … port=3120 profile=ondevice (+12ms)
[PASS] 客户端已接入（凭据豁免生效）     IN-UPGRADE GET /api/remote.mux … cookie=224B origin=http://127.0.0.1:3120
[PASS] 平台标识 = ohos                  平台标识：DSHM_PLATFORM=ohos（鸿蒙应用沙箱路径）
[PASS] 本次启动后无异常退出 / 无崩溃关键字
nav.md：账号菜单 OK → 设置 OK → 九个分区全部 OK
```

产物尺寸可自证"确实点动了"：九组 json **558–622 KB 各不相同**、jpeg **277–357 KB 各不相同**
（对比修复前：9 组完全同尺寸）。

### 五 长期项状态（本批次未解）

- **40 秒自杀**：rc.2 上**仍未复现**（主进程 4.7 h 稳定）。`dshm-host.log` 全史共 **5 条**
  `!! process.exit(0)：停止路径放行，真正退出`，时点 `2026-09-27T04:46:50.638Z` / `2026-09-29T09:07:27.078Z` /
  **`2026-09-29T09:40:43.510Z`（就是那次 40 s 自杀）** / `2026-09-29T15:10:24.789Z` / `2026-09-30T00:28:27.333Z`。
  强嫌疑仍是启动期未清理 `host-stop-request`（`hostcore/app/main.js:3988-4003`）——（⚠️ **该推断已被推翻**：见 `docs/HANDOFF.md` §4② —— 一定是应用侧某条 `DshHost.stop(reason)` 被调到。
  2026-10-04 又添第三种可能：它可能是 E388 那个「冷启动后 60 s 宿主完全无响应」的**下游**——4 次
  `!! process 'exit' event, code=0` 全部落在 E388 修复之前的 boot，修复后 0 次；样本仅 3 段 boot，未定案。）
  `dsh/home` 是 `drwx------`，**hdc 读不到** ⇒ 这条路径无法用于证伪，需要改由应用侧自证。
- **连接抖动**：真机侧本轮未再抓取（定因见批次三十七「三」）；修法（`typert-gateway`
  覆写 `websocketHeartbeatIntervalMs` / `streamInboxBytes`）**2026-10-03 曾落盘、2026-10-04 已回退** ⇒
  当前两端都走官方默认 2000ms（回收窗口 `3 × 2s ≈ 6s`）。
