# 功能对等矩阵（Parity Matrix）· P0

| 项 | 内容 |
|---|---|
| 文档编号 | `docs/parity-matrix.md` |
| 版本 | v1.0 |
| 日期 | 2026-09-14 |
| 状态 | 生效（P0 交付物） |
| 上位文档 | `docs/00-开发任务书.md`（D1）、`docs/20-产品需求与体验规范.md`（D3）、`docs/50-端侧核心运行架构.md`（D6）；本文是《HarmonyOS 多端开发实施计划》P0 的落地台账 |
| 定位 | **逐功能对等台账**：官方 Web 的每一项能力，在 DSHM 里的状态层/界面/协议/四形态落点与状态。**它是"还差什么"的唯一清单**，不是宣传材料 |
| 门禁 | `node tools/check-parity.mjs`（含注入式自检 `--self-test`）。**本文格式坏了或状态注水，门禁会失败** |

---

## 0. 这份文档是什么、不是什么

**是**：

- 官方 Web 能力面的**全量覆盖表**（行集 = 官方 `@deepseek-ai/dsh-client-ui-*` 的全部 38 个包 + `dsh-client-locale` + 端侧独有能力），每一行给出落地文件与四形态状态；
- 缺口登记处：**任何非 DONE 的行必须在 §6 登记**，含原因与下一步。门禁强制这条。

**不是**：

- 不是"最终验收通过"的声明。**本矩阵的 DONE 只表示"实现侧完成"**；真机验收是另一根轴（§1.3），今天整体是 `PENDING`；
- 不是设计文档。设计口径在 D3；协议事实在 D2/D2b；本文只登记**对等状态**。

---

## 1. 状态口径

### 1.1 四个状态 token（只允许这四个）

| token | 含义 | 判据 |
|---|---|---|
| `DONE` | 实现侧完成，该形态下无已知缺口 | §1.2 的八项判据齐备 |
| `PARTIAL` | 部分可用：有真实实现，但缺项 | 必须在 §6 登记缺什么 |
| `BOUNDARY` | **能力边界**：平台/架构不允许，不是缺陷 | 必须在 §6 写明为什么不可做 |
| `TODO` | 未实现 | 必须在 §6 登记下一步 |

### 1.2 `DONE` 的八项判据（计划 §5）

`Protocol` · `State` · `Functional` · `Interaction` · `Responsive` · `Accessibility` · `Validation`

> 第 7 项 `Validation` 在本环境的含义**限定为"可静态验证"**（门禁、门禁自检、单测、协议往返）——**不包括真机验收**。真机验收见 §1.3。

### 1.3 两根轴：实现侧 vs 设备验证

计划 §5（DONE 要八项齐备）与 §20（无真机时允许开发完成、不允许宣称设备验收完成）并不矛盾，前提是把它们**分成两根轴**：

| 轴 | 取值 | 今天的状态 |
|---|---|---|
| **实现侧** | 本矩阵的 `Status` / 四形态列 | 见 §5 统计 |
| **设备验证** | `PENDING` / `PASS` | **`PENDING`**（本环境无模拟器、无真机；**工具链已于 2026-09-14 就位**，HAR 模块可真编译，见 §3） |

**硬规则**：任何 `DONE` 行都不得被读作"已在设备上验收通过"；报告里必须同时给出设备验证轴的取值。

### 1.4 门禁强制的五条不变式

| # | 不变式 | 防止的注水 |
|---|---|---|
| A | 行集恰好覆盖官方能力面（38 个 `dsh-client-ui-*` + `client-locale` = 39 个 id 各一行），另有 `dshm-` 前缀的端侧独有行 | 漏项、重复项、覆盖越界 |
| B | 状态 token 合法（只允许 §1.1 的四个）；**任一形态列不是 `DONE` 时，整体 `Status` 不得是 `DONE`** | 用整体 DONE 盖住某个形态的缺口 |
| C | 任何非 `DONE` 的行必须在 §6 缺口登记里有对应行；§6 也不得登记矩阵里不存在的 id | 悄悄降级、只留结论不留原因、幽灵登记 |
| D | §5 统计表必须与矩阵**实算**逐项相等（含合计） | 口径不明导致数字对不上（本项目真实发生过） |
| E | `DONE` 的行不得留在 §6 缺口登记里 | 陈旧登记：台账同时说"已完成"和"缺什么" |

> 五条都有**注入式负测试**（`--self-test`；`check-parity` 为 13 个正/负样例）证明会真的失败。
> 另对**真实矩阵**做过一次端到端注入：把 `workflow-run` 从 `TODO` 谎报成 `DONE` 并顺手改对统计数字——
> 门禁仍以「陈旧登记」点名并退出 1（不变式 E 存在的理由：只靠 D 会被"顺手改统计"掩盖）。

---

## 2. 形态口径（四列的定义）

**这里对计划书的四形态做一处更正**，理由是 HarmonyOS 的实际事实：

> HarmonyOS 的 `deviceType` 只有 `phone` / `tablet` / `2in1`（另有 tv/wearable/car），**没有独立的 `PC`**。
> 计划书里的「PC」与「2-in-1」在系统看来是**同一个 `deviceType = 2in1`**，差别在**窗口模式与输入模态**。

因此四列的定义是「设备族 × 窗口/输入形态」，而不是四个设备类型：

| 列 | 判定 | 典型场景 |
|---|---|---|
| **Phone** | `deviceType=phone`，单栏 | 直板机；折叠屏折叠态 |
| **Tablet** | `deviceType=tablet` | 平板竖屏（双栏）/ 横屏（三栏） |
| **PC** | `deviceType=2in1` + 全屏/最大化窗口、键鼠为主 | 电脑模式、台式二合一接显示器 |
| **2-in-1** | `deviceType=2in1` + 自由窗口/悬停态、触摸为主 | 二合一笔记本、折叠屏悬停 |

**两条落地规则**（与 D3 §2.2 一致，本项目不做例外）：

1. **布局决策只看「窗口宽度 + 输入模态」**，不看 `deviceType`：`layoutModeOf(widthVp)` 是唯一入口。一个 2in1 被拖窄到 500vp，必须与手机同构（单栏）；这是"窗口变化时自动切换布局"的实现方式。
2. **`deviceType` 只用于门控系统能力**（系统文件夹选择器、快捷键提示、拖拽投喂等），且**只允许出现在 Layout/Platform 层**。

---

## 3. 本环境的验证手段口径（可做 / 不可做）

| 手段 | 本环境 | 说明 |
|---|---|---|
| Node 静态门禁（`tools/*.mjs`） | ✅ 可跑 | 已实测：架构门禁、接线回归、上架红线、对等门禁全绿；见 §3.1 |
| **ArkTS 编译（HAR 模块）** | ✅ 可跑 | `devecocli build --modules appstate connection dshcompat hostruntime platform` → **BUILD SUCCESSFUL**（apiVersion 26 SDK，145 任务）。这是**真编译器**，不是解析器 |
| **ArkTS 编译（entry 应用模块）** | ✅ **可跑（Windows 本机已解锁：2026-09-28）** | 两条路：① **只编 UI 层**：`node tools/check-arkts-entry.mjs`（**不需要任何环境变量**，脚本自己解析 DevEco 布局）；或直接 `<CLT>/hvigor/bin/hvigorw.js default@CompileArkTS --mode module -p module=entry@default -p product=default -p buildMode=debug --no-daemon`（Linux 布局需 `DEVECO_CLI_CLT_PATH` + `DEVECO_SDK_HOME=<CLT>/sdk` + `JAVA_HOME`）；② `devecocli build` 全量。**`Index.ets` 与全部 Pane 获得真编译验证**——P1~P3 改 UI 不再是盲改。⚠️ 2026-09-28 之前本行只有在 Linux 机器上成立：`tools/check-arkts-entry.mjs` 写死了四处 Linux 布局，在 Windows 上恒 exit 3（详见 `docs/90-…md` §2.4）|
| **完整打包（HAP）** | ✅ 可跑，**只差签名** | `devecocli build` → `CompileArkTS` ✅ `PackageHap` ✅ `PackingCheck` ✅，最后 `SignHap` 失败：`build-profile.json5` 的 `signingConfigs` 指向 Windows 路径（`C:\Users\hnzy1\.ohos\config\*.p12`）。产出 **`entry/build/default/outputs/default/entry-default-unsigned.hap`（138MB）**，内含 `libs/{arm64-v8a,x86_64}/libdshhost.so`（原生模块真的编出来了）+ 两个核心 zip + 入口脚本。⇒ **签名是纯环境问题**（需要那台机器的证书），与代码无关 |
| **ArkTS 语法错误的守护边界** | ⚠️ 只有真编译器能抓 | **实测**：codelinter **检不出语法错误**（往 `appstate` 注入 `return a +;` 后它一条都不报，而真编译器立刻 BUILD FAILED）⇒ 任何对 `.ets` 的改动都必须过 `default@CompileArkTS`/`devecocli build`，**不能用 lint 代替** |
| **设计令牌棘轮（`check-design-tokens.mjs`）** | ✅ 可跑且**失败已注入验证** | 计划 §6 点名禁止的裸 `fontSize`/`lineHeight`/`borderRadius`/`borderWidth`/颜色字面量：基线 **21 处 / 8 文件**（2026-09-28 重测；旧记"58 处 / 11 文件"是 2026-09-15 的读数），**只许变少**。为什么是棘轮而非一刀切：存量里**图标尺寸的收敛会改变视觉、必须真机验收**，一刀切会立刻几百处红——**永远红的门禁等于没有门禁**。豁免须写明理由（`// token-exempt: …`）；判定器自检 **13 个样例** |
| **纯逻辑执行测试（layout fixtures）** | ✅ 可跑 | `tools/check-layout-fixtures.mjs`：把 `appstate/ui` 的三个**纯逻辑** `.ets` 按 `.ts` 编译后**在本机直接执行**（被测的是同一源文件，不是复制品），断言四形态 + 断点边界 + 让步链三分支，**共 768 条断言**（7 组 fixture；2026-09-28 实测，**2026-09-30 起不再需要外部 junction**——`findTsc()` 已按同族脚本的候选列表补上 Windows 回退，见 §3.2。旧记"共 28 条"是被测断言的早期规模） |
| **ArkTS 静态检查（codelinter）** | ✅ 可跑且**覆盖面已证明** | 直接调用 CLT 的 `codelinter/bin/codelinter -c code-linter.json5 <模块目录>`：**16 条 warning / 0 error**（7 个文件）。覆盖用**注入测试**证明：往一个「无问题」文件注入已知违规，能被检出（见 §3.2） |
| API 兼容扫描（`devecocli check compat`） | ❌ 平台不支持 | CLI 明文：`Unsupported platform: linux. compat only supports macOS and Windows.`——**与 CLT 是否安装无关**，Linux 上永远不可用 |
| 模型/协议往返（`check-model-roundtrip.mjs`） | ✅ **可跑且通过** | `--no-prompt --wait-ms 180000`（Node 22）：真起 Host → 铸 cookie → 读模型目录 → 建会话 → 开 mux → `session/page` → 收到 `follow` 的 snapshot 帧（含 projections） |
| 起真实 Host 的门禁（`check-origin-fence` / `check-plugin-toggle`） | ✅ **可跑且通过**（需 Node < 22，慢机器还要放宽就绪等待） | ① 这三个门禁用 `process.execPath` 起 Host 并传 `--no-experimental-fetch`，该 flag 在 **Node 22+ 已被移除**（fetch 转正）⇒ Node 24 下 Host 直接启动失败（`--no-experimental-fetch is an invalid negation`）。本机备了 **Node v22.23.2**（与端侧同版本）：`/home/node/node22/bin/node`。② **本机 Host 冷启动实测 62,951 ms**（`BOOT_60_HTTP_BIND …(+62951ms)`；Orange Pi 5B + 工作区在 NFS）⇒ `check-origin-fence` 原来的 60 秒就绪等待刚好不够（`check-plugin-toggle` 用 90 秒，所以它一直能过）。已把它改成可放宽（**默认值不变**）：`DSHM_CHECK_READY_MS=180000`。③ 结论：`check-origin-fence` **PASS**（clean/absent/duplicated → 101；foreign → 403；no-cookie → 401）；`check-plugin-toggle` **PASS**（186 条目 → 写用户行 → `ui-deliverables enabled=false`） |
| 在设备上真跑（装机） | ✅ 已达成（本节的状态已过时） | 旧记"只差签名材料"——签名材料已备齐，**真机装机早已跑通**（见 §3.3 与 `docs/device-validation.md` §批次三十六/三十七）。运行期产物 `entry/libs/arm64-v8a/` 含 `libnode.so.137`（**实物是 `.137`，本节旧文字写的 `.127` 是 rc 之前的名字**） |
| **完整 arm64 HAP（未签名）** | ✅ 已产出 | `entry/build/default/outputs/default/entry-default-unsigned.hap` = **312,150,304 B / 297.69 MiB**（110 条目；旧记"138 MB"是阶段一的读数），内含 **`libnode.so.137`(126,809,264 B) + `libkoffi.so`(1,600,112 B) + `libsystem.so`(10,464 B, flock) + `libdshhost.so` + 全套原生库**；三个原生附加件（koffi / flock / dshhost）都在这一台机器上**真的编出来了** |
| 布局/形态真机验收 | ❌ 不可跑 | 无模拟器、无真机 |
| 视觉像素、手势、键盘、触控笔、系统权限、文件选择器 | ❌ 不可跑 | 统一进 `docs/device-validation.md`（P4） |

### 3.1 已实测的基线（2026-09-30 重测）

```
node tools/arch-check.mjs            ✅ 无违规（上游字面量只在 dshcompat，扫描 131 文件）
node tools/check-feature-wiring.mjs  ✅ 18 个功能接线全在（扫描 133 文件，1 条反面规则）
node tools/check-builder-recursion.mjs ✅ 99 文件 / 102 个 @Builder 无自递归（E343）
node tools/check-dead-code.mjs        ✅ 99 文件 / 判定声明 2237 处 / 门面字段 256 个 / 0 死代码（E350）
node tools/check-store-readiness.mjs ✅ PASS
node tools/check-parity.mjs          ✅ 通过（50 行：官方 39 + 端侧 11；DONE 14 · PARTIAL 31 · BOUNDARY 3 · TODO 2；§6 登记 36 个 id）
node tools/check-parity.mjs --self-test ✅ 13 个正负样例全符合预期（门禁自身可信）
node tools/check-dead-handlers.mjs   ✅ 未发现空实现（2026-09-28 重测；旧记"78 处"是**声明**口径，非死按钮）
node tools/check-native-closure.mjs  ✅ PASS（libpty.so / libsharp 两条 SONAME 告警按路径 dlopen 属可接受）
node tools/check-origin-fence.mjs    ✅ PASS（clean/absent/duplicated ⇒ 101；foreign ⇒ 403；no-cookie ⇒ 401）
                                     ⚠️ 2026-10-04 修掉一处**就绪竞态**：`waitReady` 原把任何 `status > 0` 当就绪、`mintCookie` 随即一次性读 `host-ready.json`；`0.2.1-alpha.1` 上上游改成「先 404 应答、后落盘」⇒ 该门禁 3/3 误报失败。修法 = `waitReady` 后再等文件落盘（`DSHM_CHECK_READY_FILE_MS`，默认 20000）；修后两版核心各 3/3 PASS，另补两条负测试（见 `docs/10-协议兼容事实基线.md` §8.7.25）
node tools/check-plugin-toggle.mjs   ✅ PASS（target=ui-deliverables enabled=false）
node tools/compat-drift.mjs          ✅ 无漂移（核心 0.2.1-alpha.1；基线采集 2026-10-04T13:40:12.375Z；期望 140 / 基线 140）

node tools/check-skill-sync.cjs        ✅ RESULT: 32 passed, 0 failed（A–H 八组；C/D 专测**等长改动**）
node tools/check-compat-exemption.cjs  ✅ RESULT: 48 passed, 0 failed（臂 A 透传 + 臂 B 用**上游自己的** evaluatePluginCompatibility 验挂载决策翻转）
node tools/check-dshm-installer.cjs    ✅ RESULT: 43 passed, 0 failed（含 5a 真幂等 / 5b 版本漂移必重装 / 5c 收敛；另有 GitHub 回退与 monorepo 子包判定 19 例 —— 2026-09-29 由 24 增至 43）
                                       ⚠️ 2026-10-04 本机重跑会**无超时挂住**（该门禁真的走网络：`resolveSpec('ms@^2.0.0', DEFAULT_REGISTRY)`、`installSpec('https://github.com/dsh-market/dsh-market')`）⇒ 与核心升级无关，属本机出网能力问题
node tools/check-doc-refs.mjs          ✅ 通过（21 个文档 / 247 条带行号引用 / 0 处问题；引用数随文档增改漂移）

devecocli build --modules appstate connection dshcompat hostruntime platform   ✅ BUILD SUCCESSFUL（52s）
codelinter -c code-linter.json5 <6 个模块目录>                                  ✅ 16 warn / 0 error
node tools/check-layout-fixtures.mjs                                            ✅ 768 条断言通过（四形态 + 边界 + 让步链 + 模型/呈现/设置域）
node tools/check-layout-fixtures.mjs --self-test                                ✅ 注入的失败被如实报出

hvigorw default@CompileArkTS -p module=entry@default …                          ✅ BUILD SUCCESSFUL（0 error / 32 warn）
devecocli build（全量）                                                           ✅ CompileArkTS/PackageHap/PackingCheck 全过
                                                                                 ❌ SignHap（签名证书在 Windows 那台机器上）
                                                                                 ⇒ 产出 entry-default-unsigned.hap = 138 MB
```

**本机全量实跑退出码分布（2026-10-04 重测，35 条：`32×0 / 2×环境·平台 / 1×门禁自身缺陷〔已修〕`）**
（2026-09-30 的 `22×0 / 1×1` 已过期。2026-10-04 复跑的三条非零：`check-dshm-installer.cjs` 挂在本机出网、
`check-model-roundtrip.mjs` exit 1 是本机缺 koffi（平台差异，见下）、`check-origin-fence.mjs` exit 2 是门禁自身的
就绪竞态——**已修，修后该门禁在新旧两版核心上各 3/3 PASS**。
`check-model-roundtrip.mjs` 带 prompt 时为 exit 1 是**本机缺 koffi**（HAP 专属），加 `--no-prompt` 后 exit 0。
旧记的 `23×0 / 2×3 / 7×1` 更早，`check-arkts-entry.mjs`、`check-web-fetch-jitless.mjs`、`check-fetch-shim.cjs`、`check-dshm-installer.cjs` 均已修至 0。）

```text
# 三条"守护本身可信吗"的注入测试（门禁通过 ≠ 覆盖到了）
注入 `return a +;` 到 appstate → 真编译器 ✅ BUILD FAILED；codelinter ❌ 一条不报（故 codelinter 不能当解析守卫）
把 MAIN_MIN_VP 280→320 → check-layout-fixtures ✅ 立刻红（正好命中"840vp 详情栏被收窄"这条行为回归）
把 workflow-run 谎报成 DONE（并同步改统计）→ check-parity ✅ 以"陈旧登记"点名并退出 1
```

**门禁"通过"不等于"覆盖到了"**（docs/README 纪律 9）：在本环境跑不动的门禁，其覆盖面**是盲区**，不是通过。

> **2026-09-28 复核：这条纪律的"反向"同样成立——"跑不动"必须先查原因，不要直接记成盲区。**
> 原先记入盲区/环境的 5 个门禁里，有 2 个的真实原因是**脚本自己写死了 Linux 布局或传了裸盘符路径**，另有 2 个是**脚本自身的硬缺陷**，还有 1 个（`check-layout-fixtures.mjs`）是**工具链没暴露**（找不到 `tsc`，当时需先 junction 出 Windows 的 `typescript`；**2026-09-30 已把回退写进脚本**）——**五条里没有一条是设备能力不足**：
>
> | 门禁 | 原记录 | 复核结论（2026-09-28） |
> |---|---|---|
> | `check-arkts-entry.mjs` | 盲区（entry 层零编译验证） | **已修 ⇒ exit 0**，日志含 `CompileArkTS` + `BUILD SUCCESSFUL`（四处路径写死：`tool/node/bin/node` 缺 `.exe`、`JAVA_HOME` 默认值、`DEVECO_SDK_HOME`、`PATH` 分隔符用 `:`）|
> | `check-layout-fixtures.mjs` | 盲区（找不到 tsc） | **已修 ⇒ exit 0 / 768 条断言**（2026-09-30：`findTsc()` 补上 Windows IDE 自带 `typescript` 的候选路径，与 `check-arkts-entry.mjs` 同写法 ⇒ **不再需要外部 junction**）|
> | `check-web-fetch-jitless.mjs` | 环境（需特定 flag） | **已修 ⇒ exit 0**（两处硬缺陷：flag 写死的否定形态在 Node 24 无效致**两臂哑火**；loader 传裸盘符路径致 **B 臂从未跑成**）|
> | `check-fetch-shim.cjs` | 环境（需特定 flag） | **已修 ⇒ exit 0**（三处缺陷：前提建在 `--no-experimental-fetch` 的语义上、探针打在**规范禁用端口** `127.0.0.1:9`、取证引用取在装垫片**之后**）。**这条的代价最重——"环境"标签掩盖了一个产品真 bug**：Node 24 自带原生 `FormData` 而 `encodeRequestBody` 只认 `instanceof` ⇒ 请求体被编成字面量 `"[object FormData]"`，直接砸 dsh 附件上传（见 `docs/90-…md` §3.6 末段）|
> | `compat-drift.mjs` | 盲区（缺契约文件） | **可跑**：指向仓库内自带核心树即可（见 §3.1 下方命令）。初始 135/135 无漂移；2026-09-28 升到 `0.2.0-rc.1` 后为 **138/138 无漂移**；2026-09-29 升到 `0.2.0-rc.2` 后为 **140/140 无漂移**（+2：`userQuestions/{answer,attachWait}`，纯新增，见 `docs/40-上游升级手册.md` §4.4）；2026-10-04 升到 `0.2.1-alpha.1` 后仍为 **140/140 无漂移**（**零变化**，连新增都没有；唯一实变在依赖闭包，见 §4.5） |
>
> ⇒ 这五条里没有一条是"本机能力不足"。**把"某台机器的限制"读成"项目盲区"，代价是那一层从此没有自动验证。**

### 3.3 不入库产物清单（新机器上要能编译/装机，需要哪些东西）

> **为什么单列这一节**：2026-09-14 在这儿栽过一次——`entry` 编不过，先被误判成"缺构建产物"，
> 真因却是**一个源码文件从未入库**（见 §3.2 的事故）。源码与产物必须分开讲，否则会朝错的方向找一天。

**① 源码（唯一权威副本在版本库；缺了就是仓库缺陷，不是环境问题）**

| 路径 | 状态 |
|---|---|
| `entry/src/main/ets/runtime/NodeRuntime.ets` | ✅ **已于 2026-09-14 补回版本库**（commit `b906e13`；此前被 `.gitignore` 的裸 `runtime/` 规则吞掉，见 §3.2） |

**② 不入库的产物（字节不进库、方法进库；都要能在本机生成，或从开发机拷贝）**

| 产物 | 路径 | 干什么用 | 产生方式 | 本机状态 |
|---|---|---|---|---|
| Node 头文件 | `entry/src/main/cpp/node-headers/` | CMake 编 `libdshhost`（**只需要它**） | `tools/node-runtime/sync-node-headers.sh`（从 Node v22.23.2 源码树取 `src/*.h` + `deps/v8/include` + `deps/uv/include`） | ✅ 已生成（3.8 MB） |
| koffi 源码 | `third_party/koffi/` | 编 `libkoffi.so`（`subprocess`/`sandbox` 两行插件依赖它） | `node tools/fetch-koffi.mjs` | ✅ 已就位（4.6 MB，随其余产物上传） |
| Host 入口脚本 | `entry/src/main/resources/resfile/resources/app/` | 装机后由原生层跑起 dsh | `node tools/place-host-app.mjs`（源 `hostcore/app/` **在库里**） | ✅ 已就位 |
| 核心包 | `entry/src/main/resources/resfile/*.zip` | 首启解包出端侧核心树 | `node tools/pack-core.mjs --skip-install --place-in-app`；版本在 `hostcore/core-recipe.json` 的 `coreVersion` | ✅ 已就位（`0.2.0-rc.2`，78,081,448 B / 29351 条目；**resfile 内只留当前版本这一份**，去旧留新） |
| **libnode** | `entry/libs/{arm64-v8a,x86_64}/libnode.so.137` | **运行期**：自建 Node（OHOS）载体；同时是"编不编 koffi"的门 | `tools/node-runtime/build-node-ohos.sh`（本机亦可：容器与真机同为 arm64） | ✅ `arm64-v8a` 已就位（`libnode.so.137` = 126,809,264 B，随其余产物上传）⇒ **koffi 从此会被真正编进 HAP**；**不参与链接**（`CMakeLists.txt` 故意不写进 `DT_NEEDED`，见其注释）。⚠️ 实物是 **`.137`**，本文多处历史行仍写 `.127`（见 D6 开篇「版本口径提示」） |
| 核心树 | `dist/core/work/dsh-core-*` | `pack-core` 的输入；`check-origin-fence` / `check-plugin-toggle` / `check-model-roundtrip` 门禁的前提 | **不需要上传**：`entry/src/main/resources/resfile/dsh-core-*.zip` 本身就是完整树（29006 个文件），`unzip` 到 `dist/core/work/` 即物化 |
| 协议契约 | `.research/protocol/contracts.json`（或仓库内自带核心树） | `compat-drift` 门禁的输入 | `node tools/protocol-contract.mjs` + 上游 checkout；**或** `$env:DSH_NODE_MODULES="$PWD\dist\core\work\dsh-core-0.2.0-rc.2\node_modules"` 直接用仓库内核心树（`dist/core/work/` 已 gitignore，需先由 resfile 里的 zip 解出） | ✅ **可跑**（2026-09-29 实测 **140/140 无漂移**，对应 `0.2.0-rc.2`）⇒ **不再是盲区**。**注意默认快照 `.research/protocol/contracts.json` 必须与新上表同版本**，否则新增端点会被读成"上游移除"（方向反，见 `docs/40-上游升级手册.md` §4.3/§4.4） |
| 签名材料 | `.p12` / `.cer` / `.p7b` | `SignHap` 出可安装的 HAP | DevEco 自动签名（那个 Windows 机器上的 `C:\Users\hnzy1\.ohos\config\`） | ❌ 缺（路径写在 `build-profile.json5`，Linux 上无效） |
| 工具链归档 | `entry/src/main/resources/resfile/toolchain/{python,git}/` | 首启解包出端侧 python3.12 与 git（真身 exec 需签名，见批次备注十二 ③） | `node tools/place-toolchain.mjs`（取 `third_party/python` 与 `third_party/git/apks`） | ✅ 已就位（python 26.4 MB + git 8.1 MB，**已自签名**） |
| **宿主 python3（构建期新增依赖）** | PATH 上的 `python3` / `python` / `py` | `tools/sign-tar-elf.py` 用它改写归档：**只有 Python `tarfile` 能在 Windows 上保住归档内的 symlink**（`bsdtar` 会丢条目、`7z` 会物化） | 官方安装版或 Store 版均可 | ⚠️ 缺则 `place-toolchain` **告警跳过签名**（归档仍可用，只是 git/python 真身继续被 execve 拒） |
| `binary-sign-tool.jar` + JDK | DevEco SDK `.../toolchains/lib/binary-sign-tool.jar` | ELF **自签名**（`-selfSign 1`，走 SelfSignSignProvider，**不需要 keystore 密码**） | 随 DevEco 安装 | ✅ 已就位（`pack-core` 签 core 树的 rg；`place-toolchain` 签工具链归档） |
| `libdshm-gitcompat.so` | `entry/libs/arm64-v8a/` | git 子进程类命令的 **LD_PRELOAD 垫片**（把平台判失败的 `pthread_setcancelstate`/`_sigmask` 改判成功，见批次备注十三 三） | CMake 自建（源码 `entry/src/main/cpp/gitcompat.c` 在库里） | ✅ 随 HAP 分发（5472B，`DT_NEEDED` 仅 libc） |

**工作区在 NFS 上——批量文件操作必须换到本地盘（本轮最大的效率教训）**

| 事实 | 读数 |
|---|---|
| 工作区文件系统 | **NFS**：宿主是 Orange Pi 5B，`/mnt/Develop` 来自 NAS `192.168.3.27:/volume1/Develop`；容器（内层 Docker）以 `/workspace` 挂载它 |
| 逐文件操作代价 | 把核心树（29k 个小文件）解到工作区：**跑了 25 分钟才 6.5k 个文件**（≈4 个/秒，照这速度要数小时） |
| 换到本地盘 | 容器本地 overlay（`/home/node`）实测 **2000 个小文件 0.12 秒**；同一份核心树解到 `/home/node/dshm-cores/` 只用 **4 秒** |
| 做法 | 大批小文件的东西解到**容器本地**，再用软链挂进项目：`ln -sfn /home/node/dshm-cores/dsh-core-0.1.5-rc.2 dist/core/work/dsh-core-0.1.5-rc.2`（`dist/` 已 gitignore，不污染仓库；`existsSync` 会跟随软链，门禁无需改动） |

**从别处拷贝产物时的两个实测坑（2026-09-14 各踩一次）**

| 坑 | 现象 | 核对办法 |
|---|---|---|
| **"上传了目录" ≠ "文件到了"** | `dist/core/work/dsh-core-*` 看起来存在，但 `find … -type f | wc -l` = **0**：只有目录骨架，没有文件 ⇒ Host 报 `找不到 profile-boot 入口（核心树可能不完整）` | 收到目录后用 **`find <dir> -type f | wc -l`** 核对文件数，不只看 `ls` |
| **文件带 +x 位** | 拷进来的 `.ets` / `.cpp` / `.d.ts` 变成 `100755`，与库里的 `100644` 产生**纯模式 diff**（内容逐字节相同） | `git diff --summary` 看 `mode change`；归一化用 `git update-index --chmod=-x <path>`（必要时重写文件以取得属主再 `chmod 644`） |

**结论**：**编译验证不需要任何外部产物**（HAR 模块 + entry 的 ArkTS + 原生 + 打包在这一台机器上全通）；
**装机运行**才需要 `libnode`（+ 签名）。这一点值得写下来，因为"编译过了"与"能装机"经常被混为一谈。

### 3.2 编译器与 codelinter 已实测发现的问题（新能力的第一批产出）

| 发现 | 性质 | 处置 |
|---|---|---|
| `platform/system/Clipboard.ets:33` 读剪贴板需要 `ohos.permission.READ_PASTEBOARD`（since 12），**应用未声明该权限**（声明的是 INTERNET / GET_NETWORK_INFO / KEEP_BACKGROUND_RUNNING） | **真实缺口**：`readText()` 在未声明权限时拿不到数据（源码自己 catch 成空串，表现为"粘贴没反应"） | 见 §4.6 `dshm-clipboard` 行已由 `DONE` 降为 `PARTIAL`；登记在 §6。**这是编译器的功劳——此前矩阵把它记成 DONE** |
| `platform/notify/KeepAlive.ets:76` 同样报权限警告，但 `KEEP_BACKGROUND_RUNNING` **已声明** | 假警报：HAR 编译期看不到宿主 `entry` 的权限声明 | 不改；登记以免下次被当成缺陷 |
| `platform/system/SecretStore.ets:63` `'encode' has been deprecated` | 技术债（可继续用，未来版本会移除） | 进 §6 登记，P2 处理 |
| `platform/window/WindowRegistry.ets:151` `'getContext' has been deprecated` | 同上 | 进 §6 登记，P2 处理 |
| `hostruntime/src/main/ets/Index.ets` 7 条 `export *` 性能规则告警 | 性能建议（`@performance/hp-arkts-no-use-any-export-*`） | 不阻断；P2 视情收敛 |
| **`Circle().fill(...)` 六处**（`view/ConnectPane.ets:273`、`view/SessionListPane.ets:198`、`view/SettingsPane.ets:1144/1678/1754/1819`）：编译器标注 **`The 'fill' API is supported since SDK version 26.0.0`**，而项目 `build-profile.json5` 声明的是 **`compatibleSdkVersion: 6.1.1(24)`** | **真实兼容性缺陷（本轮最有价值的编译器产出）**：在 API 24 设备上 `fill` 不存在 ⇒ 三个状态点/色点（Host 授权状态、会话运行中脉冲、提供方色点）行为未定义。而这正是 `devecocli check compat` 该抓的东西——它**在 Linux 上不可用**（macOS/Windows only）⇒ **编译器警告是当前唯一的信号源** | 三选一（**需要决策，且要真机看视觉**）：① 改用 API 24 就有的写法（如 `Circle().backgroundColor(...)`，视觉是否等价需真机确认）；② `apiAvailable` 守卫 + 回退；③ 把 `compatibleSdkVersion` 提到 26。**决策前不得当作没问题** |
| `pages/Index.ets` 多处 `'getContext' has been deprecated`（约 12 处）、`'px2vp' has been deprecated`（3 处）、`'pushUrl' has been deprecated`（1 处）；`hostruntime/core/CoreStore.ets:424/430/438` `Function may throw exceptions. Special handling is required.` | 技术债 / 健壮性提示（可继续用，未来版本会移除） | 进 §6 无需登记（非行缺口）；P2 统一收敛 |

**一处端侧运行时缺陷（2026-09-14 实测确证 → 已修复并门禁固化）：`web_fetch` 在 jitless 下永远失败**

| 环节 | 事实（都有对照实验，不是推断） |
|---|---|
| 症状 | `web_search` 正常，`web_fetch` **打不开任何网页、任何 IP** |
| 机制 | 上游 `dsh-web-fetch-http` **不用全局 fetch**：它 `await import("undici")`（`lib/index.js:154`）、自建 `Agent` 并把 `dispatcher` 传进 fetch；而 **undici 的 HTTP 解析器是 WASM**（`lib/llhttp/llhttp-wasm.js`）。`web_search` 走本仓的 http/https 垫片（纯 JS），所以照常工作 —— 这就是"只有一个功能坏"的原因 |
| 为什么 `--jitless` 下没有 WASM | V8 的 `--jitless` 与 `--expose_wasm` 互斥（启动即打印 `disabling flag --expose_wasm`），`typeof WebAssembly === 'undefined'` |
| **对照实验**（同一份真实上游代码、同一个本地 HTTP 服务、同一套端侧 flag） | **A 臂（不注册钩子）**：真 undici 探针报 **`WebAssembly is not defined`**，真实上游 `HttpFetchProvider.fetch()` **4/4 断言全败**（`fetch failed` / `WEB_PROVIDER_ERROR`）—— 即用户报的症状。**B 臂（注册钩子）**：**8/8 全过** |
| 修复（**已接线、已端到端验证**） | `hostcore/app/undici-shim.mjs`（把 `undici` 模块名接到已有 http 垫片，并翻译 `dispatcher → lookup` 以**保住上游的 DNS 钉住/SSRF 防护**）+ `hostcore/app/undici-loader.mjs`（`module.register` 解析钩子）+ `main.js` 里的 `installUndiciNameHook()`（**仅在 `WebAssembly` 不可用时注册**：原生 undici 能用时不该被替换）。**不改上游源码、不改核心树**，只做运行期组合 |
| B 臂验证到的两条**安全语义**（本修复最有价值的部分） | ① 同源跳转仍被上游自己跟到最终 200（依赖 `redirect:'manual'` 语义原样透传）；② **跨源跳转仍被拒为 `WEB_REDIRECT_BLOCKED`**。若当初为了"让它能通"而放开 redirect 或忽略 lookup，这两条会立刻炸 |
| 真实 Host 侧证据 | Host 日志出现 `undici 解析钩子已注册（web_fetch 走本仓垫片，绕开 WASM）`，且 Host 照常启动、目录可读、会话可建（`tools/check-model-roundtrip.mjs --no-prompt`） |
| **固化门禁** | `tools/check-web-fetch-jitless.mjs`：**自带对照实验**——A 臂必须失败且必须给出 WASM 因果证据（否则判"说不出原因的失败"= 门禁报错），B 臂必须 8/8 通过。含 13 条判定器自检 |
| **跑它的 Node 版本** | 必须在 **Node 22**（`/home/node/node22/bin/node`）下跑：它用 `process.execPath` 起带 `--jitless --no-experimental-fetch` 的子进程，而 `--no-experimental-fetch` 在 **Node 22+ 已被移除**（fetch 转正）⇒ 默认的 Node 24 下两臂都失败，输出像"门禁红了"而其实是**环境不对**。2026-09-15 实测：Node 24 ❌（两臂都没有断言产出）/ Node v22.23.2 ✅ PASS（B 臂 8/8） |
| 顺带修掉的两处垫片缺陷（已生效、Host 复验正常） | ① `dshmFetch` 此前**硬编码自动跟 5 跳、忽略 `init.redirect`** ⇒ 上游用 `redirect:'manual'` 实现的"仅同源跟跳 + 跨源拒绝"安全策略会被静默绕过；现按 manual/error/follow 处理。② `lookup` 透传通道（上游的 pinned lookup 与 node 的 lookup 契约本就同构，直接可用） |
| **真机待验收** | `register()` 的钩子跑在 Node 的**独立线程**里；端侧嵌入式运行时是否允许起线程，本环境无法证明。故 `installUndiciNameHook()` 失败时**只降级、不阻断启动** —— 正因如此**必须靠日志主动确认**，不能因为"Host 起来了"就以为生效了。真机两项已登记为 `docs/device-validation.md` 的 **D1（钩子在线程里能否注册）** 与 **D2（真机抓一次网页）** |

**一个把两次验证带偏的环境陷阱（记录下来，避免重犯）：ESM `import 'node:http'` 在 `--jitless` 下会炸**

排查期间我写的两个 harness 都在第一行 `import http from 'node:http'`，于是**测试自己**把进程搞崩，真正的结果被完全遮住，还一度让我得出错误结论。实测：

| 写法（均在 `--jitless --no-experimental-fetch` 下） | 结果 |
|---|---|
| `require('node:http')`（CJS） | ✅ 干净 |
| `import http from 'node:http'`（ESM，静态或动态） | 💥 进程在收尾时抛 internal undici 的 `WebAssembly is not defined`，**退出码 1** |
| `import('node:https')` / `import('node:net')` | ✅ 干净 |
| 同上但不带 `--jitless` | ✅ 干净 |

这是 Node 自身对 `node:http` 的 ESM facade 行为，与我们的代码无关；`dsh-host-webserver` 也是 `type: module` 且 `import { createServer } from "node:http"`，而 Host 是长活进程、被 kill 而非自然退出，故实践上不受影响。**对我们的要求很简单：端侧/jitless 相关的 harness 一律用 CJS `require` 取 `node:http`**（本仓 `main.js` 本来就是这样）。

**一次被编译器揭穿的"仓库不完整"事故（2026-09-14，已修）**

| 环节 | 事实 |
|---|---|
| 症状 | 新克隆的仓库编不过 `entry`：`COMPILE RESULT:FAIL {ERROR:8 WARN:33}` |
| 误判风险 | 第一反应是"缺构建产物"（原生头文件/预编译库）——**方向错了**，会白找很久 |
| 真因 | `entry/src/main/ets/runtime/NodeRuntime.ets` **从未进过版本库**（`git log --diff-filter=A -- '*NodeRuntime*'` 为空），而 3 个已跟踪文件 import 它：`EntryAbility.ets:40`、`Index.ets:134`、`Poc1.ets:21` |
| 根因 | `.gitignore` 第 35 行是裸的 `runtime/`（本意是根目录 172 MB 的 Electron 载荷）。**gitignore 的裸目录名在任意层级都匹配** ⇒ 连 `entry/src/main/ets/runtime/`、`hostruntime/src/main/ets/runtime/` 这类**模块源码目录**也被忽略。文件在开发机上"看得见"，在任何新克隆里"不存在"，**且不报任何错** |
| 8 个错误的构成 | 3× `Cannot find module '../runtime/NodeRuntime'` + 1× Rollup `Could not resolve` + 4× `arkts-no-any-unknown`（无法解析导入后的连带）⇒ **全部可归因到这一个文件**，没有一个是真的代码缺陷 |
| 修法 | ① `.gitignore` 规则锚定为 `/runtime/`（commit `ff6cbc9`）；② 把源码补回版本库（commit `b906e13`）。修后 `default@CompileArkTS` → **BUILD SUCCESSFUL（0 error / 32 warn）** |
| 教训 | ① `.gitignore` 的目录规则要**锚定**，或在路径里带上足够的上层目录；② **"本地能跑" ≠ "仓库完整"**——被忽略的文件只会在别人机器上消失，本地永远无感；③ 遇到"新克隆编不过"时，先问"**源码**齐不齐"，再问"**产物**齐不齐" |

> **工具链的环境坑（实测，必须记住）**：在 Linux 上跑 `devecocli build` 会让 ohpm 重写 **5 个受版本控制的 `oh-package-lock.json5`**（191 行全变），
> 原因是构建机把行尾写成 LF 而仓库在 Windows（`core.autocrlf=true`）下是 CRLF——`git diff --ignore-cr-at-eol` 为空即可确认是纯行尾差异。
> **每次构建后必须 `git checkout --` 回退这些文件**，否则提交里会混进 191 行噪声（本项目对"噪声 diff"有明确纪律）。

---

## 4. 矩阵

列的含义：**Web 行为**取自官方包自述（来源见 §7）；**Harmony 状态层/界面**给落地文件（可核对）；**协议/端点**给命名空间（完整契约在 D2b）；四形态列与整体 `Status` 按 §1 口径。

### 4.1 外壳与架构

| Feature | Web 行为（官方实现） | Harmony 状态层 | Harmony 界面 | 协议/端点 | Phone | Tablet | PC | 2-in-1 | Status |
|---|---|---|---|---|---|---|---|---|---|
| `layout` 外壳与三栏布局 | 三栏 AppFrame + 拖拽手柄；`ctx.layout` 查看态服务（导航 + 面板） | `appstate/ui/Breakpoints.ets`（`layoutModeOf` / `detailPanelAvailable` / `navPresentation`）、**`ui/LayoutController.ets`（P1：形态/几何决策的唯一落点，含让步链 `concedeDetail`）**、`ui/Tokens.ets`（`Sz.NAV_RAIL` / `NAV_PANEL` / `DETAIL_PANEL` / `DETAIL_MIN`） | **`pages/Index.ets` 已改为消费决策**：`applySize` 取 `decideLayout()`，navRail/detailColumn 的宽度取 `navWidthVp()`/`detailWidthVp()`（commit `fad954a`）——本文件不再有第二份断点/几何实现 | 无（纯前端） | DONE | DONE | PARTIAL | PARTIAL | PARTIAL |
| `slots` 槽位注册 | SlotMap 声明合并 + 单次 register 组合 API + 四方共享 props | 无（ArkUI 声明式，无插件槽位系统） | 无 | 无 | BOUNDARY | BOUNDARY | BOUNDARY | BOUNDARY | BOUNDARY |
| `primitives` 基础组件原子 | 纯 React 原子：控件 / 图标 / Markdown / JSON 检查器 | **P1.5 已建层**：`appstate/ui/HarmonyTheme.ets`（Web 语义 → HarmonyOS 视觉的映射：HarmonyColor/Type/Spacing/Radius/Border/Elevation/Motion/Touch + `WEB_TOKEN_MAP`） | `entry/.../view/NativePrimitives.ets`：`NativeChip` / `NativeSectionTitle` / **`NativeCard`** / **`NativeButton`** / **`NativeActionBar`**（+ `harmonySheetOptions` 参数助手）；真实消费者：**消息操作条、Composer 工具行与发送键、待决卡提交、工具卡 / 子代理卡 / 目标任务卡 / 交付物动作行** | 无（纯前端） | — | — | — | — | PARTIAL |
| `renderer` 渲染器与应用根 | React 槽位绑定 + `ctx.uiRenderer` + 组装后的应用根 | ArkUI 声明式 UI 由 `@Entry` 组件承载（无等价服务） | `pages/Index.ets` | 无 | BOUNDARY | BOUNDARY | BOUNDARY | BOUNDARY | BOUNDARY |
| `session` 会话控制器适配 | React 适配 + **会话作用域槽位** | `appstate/store/SessionHub.ets`（模块级单例 + `HubSnapshot` 投影 + subscribe/snapshot） | 各 Pane 订阅 `HubSnapshot` | 复用全部会话端点 | DONE | DONE | DONE | DONE | PARTIAL |
| `brand-official` 品牌槽位 | 侧栏 + 对话 Hero 槽位的官方品牌 | `docs/brand/`（icon/mark）、`AppScope` 图标 | Index 品牌头、连接页 | 无 | DONE | DONE | DONE | DONE | DONE |

### 4.2 会话与轨迹

| Feature | Web 行为（官方实现） | Harmony 状态层 | Harmony 界面 | 协议/端点 | Phone | Tablet | PC | 2-in-1 | Status |
|---|---|---|---|---|---|---|---|---|---|
| `conversation` 会话装配/外壳/输入区/队列 | 目标中立的 Conversation 装配、shell、composer、队列、视图导航 | **回合模型已落地**（`appstate/model/Turns.ets`：`groupTurns` / `hasProcessGroup` / `chatVisibleItems` / `processSummary` / `defaultExpanded`，纯函数 + 15 条断言）；**对话视图已改按回合渲染**：用户消息 → **过程分组（默认折叠、进行中展开）** → 回答（含 ActionStrip）→ 通知；轨迹视图保持全量条目台账。可见集合与折叠默认态都由模型回答（视图不再自写过滤规则） `SessionHub`：`sendPrompt` / `cancelTurn` / `removeQueuedItem` / `steerQueuedItem` / `editQueuedItem` / `selectSession` / `refreshTrajectoryByPage` | `view/ConversationPane.ets` + `view/Composer.ets` | `session/*`、`session/follow`（$events） | DONE | DONE | PARTIAL | PARTIAL | PARTIAL |
| `chat` 对话目标与详情面 | Chat Conversation 目标、节点定义、渲染器、详情面 | `SessionHub.projectWireRecord`（D2 §8.7.7 的 32 种事件）、`model/Detail.ets` | `ConversationPane` + `view/DetailPane.ets` | 事件流 + `session/page` | DONE | DONE | DONE | DONE | DONE |
| `trajectory` 轨迹台账与时间轴 | 轨迹事件台账 + **交互式时间总览**（timing overview） | `model/Trajectory.ets`（8 种 `TrajectoryKind`）、`model/Present.ets` | `ConversationPane` 轨迹区 | 事件流投影 | DONE | DONE | PARTIAL | PARTIAL | PARTIAL |
| `tool` 工具调用树与每工具呈现 | 工具调用树渲染器 + 按工具键的呈现槽位 | `ConversationPane.toolItem` 的 `callId` 合卡、`ToolState` 五态、`Present.previewOutput` 截断 | `ConversationPane` 工具卡 | `tool/call`、`tool/result` | DONE | DONE | PARTIAL | PARTIAL | PARTIAL |
| `subagent` 子代理目录与续跑 | 子代理会话目录、续跑路由 UI、`@` 引用源 | `TrajectoryKind.SUBAGENT`、`subagentCatalog` 投影、`model/Detail.ets` | `ConversationPane` 子代理卡 + `DetailPane` | `subagents/*` | DONE | DONE | PARTIAL | PARTIAL | PARTIAL |
| `deliverables` 交付物 | 产出文件回合尾 + **可点的终答文件引用** | `TrajectoryKind.DELIVERABLE`、`deliverables/presented`、`model/Workspace.ets` 的 `deliverable` 标记 | `ConversationPane.deliverableItem`、`WorkspacePane` 品牌色标记 | `deliverables/*` | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL |
| `goal` 长期目标栏 | GoalBar 停靠在输入区上方，读 goal 会话投影 | `SessionHub.refreshGoal`（E243） | `Index.ets` 目标栏 | `goals/*` | DONE | DONE | DONE | DONE | DONE |
| `jobs` 后台任务清单 | 会话头部的后台任务列表（镜像 `session/jobs` 帧） | `model/Wire.ets` 的 `JOBS` 投影（`SessionJob`） | `ConversationPane` 的 `GOAL`/`JOB` 折叠块 | `session/jobs` 帧 | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL |
| `workflow-run` 工作流运行节点 | 持久 workflow-run 会话节点 + 嵌套成员展开 | 无 | 无 | 无（`dshcompat/Endpoints.ets` 内无 workflow 端点） | TODO | TODO | TODO | TODO | TODO |
| `cordis` 动态插件定义卡 | `cordis_define` 工具行 + run/stop 开关 | 仅有宿主侧端点常量（`dynamicCordisRunner/inventory`、`getClientCode`），**未接 UI** | 无工具行 | 端点已登记、无调用点 | TODO | TODO | TODO | TODO | TODO |
| `skill` 技能引用与技能工具行 | Web 技能引用 + 专用 skill 工具行 | `SessionHub.refreshSkills`（`skills/list`，E135 触发点已修） | 设置页技能清单 | `skills/*` | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL |
| `message-feedback` 消息反馈 | 每消息反馈控件（**类别 → 可选备注 → 提交 → 存储态 → 撤回**） | `SessionHub.putFeedback`（含 `category`）/ `clearFeedback`（撤回，`ifVersion` 做 CAS）/ `refreshFeedback` / `feedbackOf`；类别取值域与请求类型**按上游源码核对**（`dsh-message-feedback/lib/types/types.d.ts`） | 消息操作条：复制 + 有帮助/没帮助 + **类别/备注面板 + 提交 + 撤回评价**；**动作清单只有一份**（`messageActionsOf`），行内操作条与**上下文菜单**共用（长按 ≡ 右键，由 `model/InputPolicy` 决定手势集合）；原先那条**不可点的**"复制/引用/重发"标签行已删除——三个动作现在都真的能用 | `messageFeedback/put`（`ifVersion: string\|null`）、`messageFeedback/delete`（`ifVersion: string`，**幂等**） | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL |

### 4.3 输入区与控制器

| Feature | Web 行为（官方实现） | Harmony 状态层 | Harmony 界面 | 协议/端点 | Phone | Tablet | PC | 2-in-1 | Status |
|---|---|---|---|---|---|---|---|---|---|
| `input-trigger` 输入触发管线 | `/` 与 `@` 检测、候选菜单、选路到已注册源 | `SessionHub.refreshCommands` / `refreshReferences` | `Composer` 的 `@`/`/` 弹层 | `commands/*`、`fileReferences/*` | DONE | DONE | DONE | DONE | DONE |
| `commands` 客户端命令面 | 全局目录缓存、`/` 源、**三种命令 UI 类型**、popupSelect 注册表 | `SessionHub.refreshCommands` / `executeCommand` | `Index.ets` 命令面板 | `commands/*` | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL |
| `reference` 引用源 | 统一 Web `@file` 与 `@session` 引用源 | `SessionHub.refreshReferences` + `Wire.fileReferencesPayload` | `Composer` 引用弹层 | `fileReferences/list` | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL |
| `attachment` 附件呈现 | 动态附件呈现：输入区、消息图、轨迹图三类槽位 | `SessionHub.attachLocalFile` / `attachWorkspaceFile` / `removeAttachment` / `clearAttachments` | `Composer` 附件条 | `fileUploads/*` | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL |
| `model-selection` 模型选择 | 共享模型目录 + 会话投影 + `session.selectModel` | `SessionHub.selectSessionModel` / `setDefaultModel` / `refreshProviderCatalog` | `Composer` 模型与强度 chip + 设置页模型页 | `llm/*`、`settings/*` | DONE | DONE | DONE | DONE | DONE |
| `plan` 计划模式控件 | 输入区内的 plan 控件（`conversation.input.plan` 座位）+ `/plan` 通道 | `HubSnapshot.planActive` / `planPending`（判据按官方 chip 语义：`pending ? !active : active`） | `Index.ets` 面板内的计划开关（**不在 Composer 内**） | 计划投影 + 命令通道 | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL |
| `permission-presets` 权限面 | General 里的新会话默认 + 会话内 `/permission` 弹层 | **只读**：`SessionHub.permissionsCurrent` / `permissionsOptions`（源码注明"切换需要 dsh-permission-presets"） | `Index.ets` 如实显示当前模式 | 读 `permissions` 投影；**无切换端点调用点** | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL |
| `approval` 审批 | 审批**接管输入区**，作用于有作用域的 Remote Event 瀑布流 | `SessionHub.handleWaterfall` → `PendingItem`、`Present.sortPending`（危险 > 审批 > 提问） | `view/PendingPane.ets` 审批卡（三选 / 危险动作权重反转 / 原始载荷可展开） | `approval/*`（到达与答复链路已实测） | DONE | DONE | DONE | DONE | PARTIAL |
| `user-questions` 提问 | `ask_user_question` 的输入区接管 + 计划复核呈现 | `SessionHub.answerQuestion`（单选 / 多选 / 自由文本）、`PendingItem` | `PendingPane` 提问卡 | `user-questions/*` | DONE | DONE | DONE | DONE | PARTIAL |
| `agent-preset` 代理预设 | 三种面：后续会话的默认、**本会话座位**、**组合编辑器** | `SessionHub.refreshAgentPresets` / `copyAgentPreset` / `deleteAgentPreset` / `readAgentPreset`（`agentPresets/*`） | `SettingsPane` 预设区 | `agentPresets/*` | DONE | DONE | DONE | DONE | PARTIAL |

### 4.4 侧栏 / 工作区 / 设置

| Feature | Web 行为（官方实现） | Harmony 状态层 | Harmony 界面 | 协议/端点 | Phone | Tablet | PC | 2-in-1 | Status |
|---|---|---|---|---|---|---|---|---|---|
| `sidebar` 会话树 | 会话多级树、**搜索**、分组、状态点 | `model/SessionList.ets`（`pickTitle`、相对时间）、工作区为组 | `view/SessionListPane.ets`（标题/副信息/状态徽标/未读点/选中态） | `session/list` | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL |
| `workspace` 工作区选择器 | 一个 WorkspacePicker 注册进侧栏与空态槽位 | `SessionHub.ensureWorkspace` / `openWorkspace` / `deleteWorkspace` | `view/WorkspacePane.ets` | `workspace/*` | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL |
| `directory-picker-native` 原生目录选择器 | 无渲染的目录流占据者，驱动宿主 OS 选择器 | `platform/system/FilePicker.ets`（`pickFolder`，`DocumentSelectMode` 仅 2in1） | 由工作区流程触发 | `directoryPicker/*` | BOUNDARY | DONE | DONE | DONE | BOUNDARY |
| `directory-picker-browse` 应用内目录浏览 | 应用内目录浏览面：渲染宿主列目录与新建原语 | `SessionHub.toggleDirectory` / `openFile` / `closeFilePreview` | `WorkspacePane` 文件树 + 预览 | `workspaceFiles/*` | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL |
| `settings` 设置域基础 | 设置命名空间作用域服务 + 权威设置槽位契约 | `SessionHub.refreshSettings` / `writeSetting` / `unsetSetting`（五种形态可写） | `view/SettingsPane.ets` | `settings/*` | DONE | DONE | DONE | DONE | DONE |
| `settings-general` 通用段 | 通用段 + 外壳触发/头部内容 + 设置词典 + 版本化欢迎通知 | 设置词典按官方译名覆盖（含 `locale.preference`） | `SettingsPane` 通用页 | `settings/*` | DONE | DONE | DONE | DONE | PARTIAL |
| `settings-models` 模型设置 | 模型设置 + 凭据联接 + 共享 onboarding 弹窗 | `SessionHub.setCredential` / `unsetCredential` / `refreshCredentials` | `SettingsPane` 模型页 + 凭据浮层 | `credentials/*` | DONE | DONE | DONE | DONE | DONE |
| `settings-plugins` 插件设置 | 插件段：功能自有页签 + 可配置宿主插件卡 | 用户行叠加（E91：种子 + 用户行，重启生效） | `SettingsPane` 插件页（启停 + 恢复默认） | profile 文件 + 插件清单 | DONE | DONE | DONE | DONE | DONE |
| `settings-plugin-inventory` 插件清单页签 | 只读 Cordis Loader 清单页签 | `model/Core.ets`（`classifyPlugin`）+ `tools/scan-core-plugins.mjs` | `SettingsPane` 插件清单 | 核心树扫描 | DONE | DONE | DONE | DONE | DONE |

### 4.5 主题与本地化

| Feature | Web 行为（官方实现） | Harmony 状态层 | Harmony 界面 | 协议/端点 | Phone | Tablet | PC | 2-in-1 | Status |
|---|---|---|---|---|---|---|---|---|---|
| `theme` 主题 | 插件前调色板 bootstrap + 无 DOM 的 ThemeRuntime（light/dark/system）+ `--dsw-*` 令牌样式 + 外观设置行 | `ui/Tokens.ets`（`Sp`/`Radius`(+`XS`)/`Fs`(+`CAPTION_XS`)/`Lh`/`Dur`/`Sz`/`Border`/`Breakpoint`/`SemanticColor`；`HarmonyColor.MASK` 统一模态遮罩）、`themeModeOf` / `applyThemeMode`；**`tools/check-design-tokens.mjs` 强制「裸值只许变少」**；`HarmonyMaterial.IMMERSIVE_ENABLED = false`（API 固定 6.1.1(24) 的决策已入档） | 各 Pane 直接用 token；设置页外观行 | `settings/*`（外观键） | DONE | DONE | DONE | DONE | PARTIAL |
| `client-locale` 语言 | 宿主偏好 + 可扩展语言目录 + 内置词典 | 跟随系统语言（E117）+ `platform/system/Strings.ets`、`localizedOr` | 设置页「语言」（`locale.preference`） | `settings/*` | DONE | DONE | DONE | DONE | PARTIAL |

### 4.6 端侧独有（无 Web 对应；`dshm-` 前缀）

| Feature | Web 行为（官方实现） | Harmony 状态层 | Harmony 界面 | 协议/端点 | Phone | Tablet | PC | 2-in-1 | Status |
|---|---|---|---|---|---|---|---|---|---|
| `dshm-core` 核心版本管理 | 无（端侧独有） | `hostruntime/CoreStore` + `decideActivation` / `decideRollback` / `evictionCandidates` | `view/CorePane.ets`、`SessionHub.switchTo` / `rollbackTo` | 核心归档 + 事务 | DONE | DONE | DONE | DONE | DONE |
| `dshm-host` 端侧 Host 生命周期 | 无（Web 是浏览器客户端，Host 由 `dsh web` 提供） | `hostruntime/DshHost` + `runtime/NodeRuntime`（E90 协作式停止：本机实测退出码 0） | `CorePane` 起停 | 入口脚本 + `$DSH_HOME` | DONE | DONE | DONE | DONE | DONE |
| `dshm-diag` 运行时与连接诊断 | 无 | `SessionHub.diagnose()` + `connection` 的五项判定 | `view/DiagnosticsPane.ets` | `$events` `ready` 帧 | DONE | DONE | DONE | DONE | PARTIAL |
| `dshm-notify` 系统通知 | 无（Web 用浏览器通知） | `model/Notify.ets`（六类策略/去重撤回键） | `platform/notify/NotificationCenter` | 无 | DONE | DONE | DONE | DONE | PARTIAL |
| `dshm-hosttrust` 记住 Host 与凭据 | 无 | `platform/system/HostStore` + `SecretStore` | `view/ConnectPane.ets` | 认证面 | DONE | DONE | DONE | DONE | DONE |
| `dshm-multiwindow` 多窗口共享单一连接 | 无（一个标签页一个连接） | `SessionHub` 单例 + `platform/runtime/RuntimeSingleton` | 窗口账本（`registerWindow`） | 1 条 mux + 1 条 `$events` | DONE | DONE | DONE | DONE | PARTIAL |
| `dshm-share` 系统分享 | 无 | `platform/system/ShareBoard.ets` | 消息/文件操作 | 无 | DONE | DONE | DONE | DONE | DONE |
| `dshm-clipboard` 剪贴板 | 无 | `platform/system/Clipboard.ets`：**写**（`copyText` / `clearClipboard`）已接；**读**（`readText`）已实现但**未接线**，且需 `ohos.permission.READ_PASTEBOARD`（未声明） | 消息复制（多处 `copyText`） | 无 | DONE | DONE | DONE | DONE | PARTIAL |
| `dshm-window` 窗口记忆 | 无 | `platform/window/WindowMemory.ets` | 由 `EntryAbility` 驱动 | 无 | DONE | DONE | DONE | DONE | DONE |
| `dshm-shortcuts` 快捷键 | 无（Web 用浏览器快捷键） | `ui/Shortcuts.ets`（13 个规格，含不可绑定项标记） | `view/ShortcutKeys.ets` + `Index` 分派 | 无 | BOUNDARY | DONE | DONE | DONE | PARTIAL |
| `dshm-a11y` 无障碍 | 无（Web 走 ARIA） | `accessibilityText` + `Sz.TOUCH_MIN` | 各 Pane | 无 | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL |

---

## 5. 统计（本轮）

| 状态 | 行数 |
|---|---|
| `DONE` | 14 |
| `PARTIAL` | 31 |
| `BOUNDARY` | 3 |
| `TODO` | 2 |
| **合计** | **50** |

> 统计口径：**矩阵 §4 各行 `Status` 列的计数**（50 行 = 39 个官方能力面 id + 11 个 `dshm-` 端侧独有行）。
> **纪律（docs/README 第 8 条）：统计前先定口径，并把口径写出来。** 本节数字由 `node tools/check-parity.mjs` 实算核对——
> 首版手写的统计（18/22/4/2）与实算不符，正是这条纪律要防的错误；门禁现在会直接报出差额。

---

## 5.1 当前阶段：官方信息架构对齐（2026-09-14 重定义）

项目所有者于 2026-09-14 重定义本阶段：**停止「缺一个功能 → 加一个组件」，改为先把页面框架搭正确。**
工作令与分步计划见 `docs/ia-parity-plan.md`（P0 AppFrame → P1 Sidebar → P2 Main → P3 Rightbar → P4 Settings 域 → P5 视觉精修）。

判断依据是「**功能不少、页面还是不像官方**」——根因是信息架构没落地，而不是缺按钮：

| 层级 | 现状 |
|---|---|
| Host / 协议 / 会话状态 / 多形态几何 / 输入模态事实 | 🟢 |
| Prompt 泄漏（P0-1） | 🟢 已关闭（结构字段 + 单一判据 + 搜索作用域，388 条 fixture 全过） |
| Conversation 数据模型（回合 / 跟随 / 可见性） | 🟢 |
| **AppFrame / Sidebar 信息架构 / PanelRegistry / Settings 域** | 🟡 **AppFrame 已完成**（`ShellTracks` + `AppShell` 三形态轨道 + `SidebarShell` / `MainHeaderShell` / `RightbarShell` / `TrackResizer` 各有其主 + 浮层门户提到页面根；`Index` 5040 → 4290 行）；🔴 **剩余**：Sidebar 重建（P1）、Conversation（P2）、Settings 域（P4） |
| Markdown | 🟢 **P2-1 已落地**：`appstate/model/Markdown`（纯模型，31 条断言）+ `entry/view/MarkdownRenderer.ets`（`Text > Span` 行内富文本）；正文/思考/过程三处已从 `Text(item.body)` **原文照显**换成渲染。**刻意不做**：HTML、表格、嵌套列表（前者是安全问题，后两者 ArkUI 的 `Text/Span` 表达不了）——缺的部分原文照显，不假装支持 |
| 视觉精修 | 🔴 排最后（框架错则间距 / 颜色 / 动效全白做） |

---

## 6. 缺口登记（任何非 DONE 的行必须在此）

格式：`id` → 缺什么 → 下一步。门禁强制"矩阵里非 DONE 的 id 必须出现在本表"。

| id | 缺什么（对等差距） | 下一步（归属） |
|---|---|---|
| `layout` | ⓪ **右栏面板体系已落地（P3-1）**：`selectedRightPanel` 此前在模型里躺了好几轮没有消费者（右栏无条件渲染 `DetailPane`）——现在 `RightbarShell` 按**面板 id** 分派、标题取 descriptor 的 `label`，选择经注册表校验。**同时如实登记了缺口的真实位置**：官方那六个候选（文件/轨迹/工具/子代理/交付物/预览）**席位在、内容视图没做**，按 E110 的口径一律 `available: () => false`（不能填的入口不进选择集，避免"点进去是空面板"）；**右栏面板体系已收口（P3-2…P3-6）**：官方六个候选**全部接上**——**「文件」**（`FileTreePane`，与工作区页签共用）、**「轨迹」（P3-6）**（`TimelineOverview`，与主区轨迹视图共用；右栏只放总览，见模型注释）、**「工具」**（`ToolCard`，与过程流共用）、**「子代理」**（`SubagentCard`）、**「交付物」**（`DeliverableCard`）与 **「预览」**（`FilePreviewPane`）；另有本仓特有的 **「详情」**（`right.detail` = 已投影的 sections 清单，属官方 `conversation.detail` 那一类，**不冒充**「文件」）⇒ 共七个可用面板。可用面板 ≥2 ⇒ 标题行出现**切换器**（只有一个可用面板时不画）。**仍缺**：侧边面板滑入动画、面板自身拖拽调宽、单栏 Sheet 里的切换器。⇒ 后续把某个候选的内容视图做出来，只需把它的 `available` 改成 true，面板体系不用动① **拖拽调宽手柄已落地**（P3）：此前 `decideLayoutWithDetail` 那条"用户想要的宽度"路径在模型里做好、也有 fixture，**却没有 UI 去产生这个宽度**（`decideLayout()` 直接用常量）。现在三栏下栏间把手可拖，宽度存进 `detailWidthDesired`；拖拽策略（可用空间 `detailRoomOf`、夹取不跳变、**左拖变宽**的方向规则、记忆值收窄）全在纯模型里，25 条断言覆盖 ② **宽度记忆已落地**：`platform/LocalPrefs` 只存/取一个数字（平台层**不许**依赖 appstate，判定规则留在模型 `detailWidthOf`），启动读回、拖拽结束落盘；落盘失败给一句轻提示而不是静默失效 ③ **平板侧边浅层面板已落地**（P3 §12）：此前双栏与手机一样弹半模态 Sheet，把列表整个盖住，"边看列表边看详情"这件事就没了。现在详情呈现由模型的三值枚举决定并**真的被视图消费**——`DetailPresentation`：三栏=真右栏 / 双栏=侧边浅层面板 / 单栏=整页（顺带**删掉了此前那个`detailOverlay: boolean`：它算了却没有任何消费点，视图用自己的 `sheetKind()` 判断）。**仍缺**：侧边面板的**滑入动画**（transition 必须挂在面板自身的根上，而它与三栏右栏共用同一个builder，值得专门做而不是顺手加）、侧边面板**自身的拖拽调宽**（目前只沿用记住的宽度）、把手的**键盘调整**（聚焦后用方向键） ④ **待决（需真机）**：D3 §2 只按宽度判定 ⇒ **手机横屏（800vp 宽）会落成双栏**；要不要加高度/方向子句，看真机效果后定。另有一条**已实测的边界事实**：详情栏只在 TRIPLE（≥840vp）并排，而该档可用空间最小 320vp > `DETAIL_MIN`(260vp) ⇒ 让步链的 `DETAIL_CLOSED` 分支**当前不可达**（防御性保留，已钉成断言，将来调阈值时会**有意识地**让这条分支复活） | P3 已做：输入模态真实接入 + 拖拽把手 + 宽度记忆。下一步：平板侧边浅层面板；把手键盘调整；手机横屏档位子句（需真机） |
| `primitives` | ① 原语已落 `NativeChip` / `NativeSectionTitle` / `NativeCard` / `NativeButton` / `NativeActionBar`（+Sheet 参数助手）；**弹层/Dialog/导航**仍未原语化 ② **浮层已全部改原生、且宿主已提到页面根**：六类浮层（详情 / 枚举选择 / 目录 / 凭据 / 文本设置 / 整值设置）统一由**单一浮层宿主**承载——全应用只在**页面根**挂一次 `bindSheet`，`sheetKind()` 从既有状态**派生**当前该显示哪个（不另立字段，避免两个真值来源），`closeSheet()` 一处复位；手写遮罩与"整屏居中卡片"全部删除（遮罩由原生 Sheet 提供）。**修法说明（P0 收尾时发现）**：门户原先挂在**单栏布局的根节点**上，而四类浮层的触发点都在主区内容里（主区三形态都可见）⇒ **双栏/三栏下这些浮层根本打不开**（"不是没做，是够不着"）。提到页面根后与形态无关——这正是官方 Web「portal 挂在 `App` 根、不属于任何 pane」的语义（E292）③ `deliverableItem` 的保存/分享是**禁用+写明原因**（平台无文件保存能力） ④ `WEB_TOKEN_MAP` 目前是**文档化数据 + fixture 可校验**，但还没有"视图必须经映射取色"的强制门禁（现有棘轮只管裸 fontSize/圆角/描边/颜色字面量） | P1.5 已做：HarmonyTheme 语义层 + 前两个原语 + 两处接入（消息操作条、Composer 工具行）。下一步按 P1.5 清单推进（Surface/Button/Card/Popup/Sheet/Dialog/ActionBar/Navigation），每个原语都**当时就接一个真实消费者**，不落没人用的空构件 |
| `slots` / `renderer` | ① 官方是 React + 槽位插件化渲染；ArkUI 无槽位系统，第三方不能贡献 UI ② 但**「页面级 panel 选择」这层必须自建**（官方 `ui-layout` 正是用 panel selection 做统一框架）：`PanelRegistry` 属 `docs/ia-parity-plan.md` 的 P0/P3，与「第三方贡献 UI」是两件事，不要混为一谈 | 架构边界：**不追平**，能力由"构建期装配 + 设置页开关"替代；本条登记以免被当作缺陷反复讨论 |
| `session` | 无"会话作用域槽位"；控制器能力（`SessionHub`）已具备 | 不追平（同上）；控制器本身已 DONE |
| `conversation` | ① 回合渲染已落地（对话视图按回合 + 过程分组折叠/展开），但**轨迹视图仍是条目级台账**——§8 的"统一模型"目前只在对话视图生效 ② PC/2-in-1 列随 `layout` 的缺口 | P1 已做：回合模型（15 条断言）+ 对话视图按回合渲染 + 行数单位收敛 + **sticky-follow 独立成模型**（`model/Follow`，9 条断言；顺带修掉两个真实缺陷——切会话与发消息都不恢复跟随）。下一步：轨迹视图也按回合组织（或明确"它就是全量台账"并在文档里定死）。**更正一条此前的错误判据**：上一轮把"回答本身可折叠"写成缺口是错的——官方折叠的是**过程**，回答是回合的目的、收起它会把这一轮的意义藏起来；故**不做**，此项从缺口移除 | | P1：Conversation 重构（先做模型，再改视图） |
| `trajectory` | ① **交互式时间总览已落地**（`model/Timeline`，47 条断言）：轨迹视图上方给「总计 + 每格比例条 + **水平拖动可聚焦事件**」（官方 `timeline.overviewAria` 原文语义）+ 聚焦格详情（种类 / 第 n 格 / 开始于 / 耗时）。种类与文案**逐字取官方** `dsh-client-ui-trajectory`（`system/user/context/compacted/message/tool/subtool` 七个中文标签、`timeline.total/started/noTimingData` 文案）；比例用**累计起点**摆放（不是浮动相加，避免四舍五入出缝隙），拖动越界夹到首尾。顺带把**投影出来却一直没人显示**的 `sessionStats` 时间四项接上界面（模型用时 / 工具调用用时 / TTFT / TPS）；轮次与步数**不在这里重复**（会话头部那行已有，E125/E129） ② 我方条目→格子的映射有**四类刻意不产生格子**（交付物 / 目标 / 任务 / 错误；官方把错误记在格子上的 `isError`，不是一种 kind），且 `SUBAGENT` 一律算 `TOOL`（官方的 `tool`/`subtool` 之分需要父子调用关系，我方 `TrajectoryItem` 没有该字段） ③ **仍缺**：**逐步计时**（官方的「首 token / 解码」来自官方客户端自己的 metrics，`timingRecorded` 只存在于其 bundle 内，我方投影没有 ⇒ 没有消费者的函数不留，故本模型不提供；要按步显示得先让投影带上这些字段）；**双向联动已做**：条 → 列表（拖动松手/点选后滚到那一格对应的条目，用 `ScrollAlign.START` 对齐，这样"列表首行"与"聚焦格"一致、不会自己抖自己）+ 列表 → 条（滚动时首行对应的格子自动聚焦，拖动条期间关掉这一路以免互相覆盖）；聚焦条目在列表里用**左侧色条**标出（与搜索命中的 brand 色区分，用 `font_emphasize`）。**仍缺**：inspect 意义上的"点格子打开该条详情/参数"（当前只滚过去 + 显示一行摘要）；`SYSTEM`/`CONTEXT`/`COMPACTED`/`SUBTOOL` 四种种类**保留但暂不可达**（我方投影没有对应事件类型，保留是为了标签表与官方一致） | P2 已做：映射规则 + 比例条 + 拖动聚焦 + 统计四项。下一步：投影接逐步 metrics；点格子打开该条详情（真正意义的 inspector） |
| `tool` | ⓪ **`web_fetch` 在端侧 jitless 下曾完全不可用**（根因、修复与对照实验见 §3.2；已由 `tools/check-web-fetch-jitless.mjs` 固化；真机起线程一项仍待验收）① **`ToolPresenter` 已落地**（`model/ToolPresentation`：终端/读取/写入/编辑/搜索/网络/图像/提问 + 通用，17 条断言；图标、语气、展开默认态、无障碍文案都由模型判定，视图只映射）② **路径摘要已落地**（`toolSummaryOf`，12 条断言：终端的命令 / 读取的路径 / 搜索的"模式 · 范围" / 网络的 url；提炼不到才退回清理后的原文——此前这里写着"直接显示参数原文"，是过期描述，已更正）③ **改动对照已落地**（`model/ToolDiff`，45 条断言）：`write`/`edit`/`str_replace_editor` 出加/减行对照并逐行着色，规则逐条对齐官方 `intendedDiff`/`validEscalationFields`（含提权闸门、空 `old_string` 归一成 null、`replace_all` 类型校验、路径 trim 判空），失败/被拒**不出**对照卡（对齐官方 `isError → null`）④ 仍缺：**applied 对照**（官方结束后优先用工具结果 `meta.diffs` 显示"实际落盘"的改动；本仓投影只解析 `TOOL_NAME`/`TOOL_ARGS`/`TOOL_OUTPUT`/`CALL_ID` 四个槽位、**未携带 `meta`** ⇒ 只能显示"意图"）；**嵌套调用不区分**（官方对 `parentCallId !== undefined` 不出对照卡，而 `TrajectoryItem` 无父子关系字段）；结果预览的类别化（图像类应出缩略而非等宽文本）；对照的逐行着色**折叠阈值**是呈现层取舍（官方阈值无证据，未假装对齐） | P2 已做：类别判定 + 每类一个系统符号 + 失败默认展开 + 按类别提炼摘要 + 改动对照卡。下一步：确认事件里 `meta` 的槽位名并接进投影（applied 对照）；图像类结果缩略 |
| `subagent` | 无续跑路由 UI；子代理不作为 `@` 引用源 | P2 |
| `deliverables` | ① **右栏「交付物」面板已落地（P3-4）**：`DeliverableCard` 与过程流共用同一份卡；筛选是纯模型（`itemsOfKind` / `deliverablesOf`：保序 + 同 id 去重）；空态如实说明「本次会话还没有交付物」② 剩余：终答正文内的可点文件引用未接（只有独立交付物条目 + 工作区标记）；「保存 / 分享」因平台没有文件保存能力而**可见但禁用**（原因写在无障碍文案里）| P3-4 已做面板；正文内文件引用待 P2 收尾 |
| `jobs` | ① **会话头的后台任务条已落地（P2-2）**：模型 `appstate/model/Jobs`（40 条断言：live 判定 / 状态点语义 / 五种文案 / 时长三档与小时封顶 / 排序 / 计数 / 定时器按需）此前**一个视图消费者都没有**——中枢一直在维护 `jobs` 字段，界面只在轨迹里显示 `JOB` 行。现在：中枢投影 → `Index` → `MainShell` → 会话头上的任务条（有任务才出现；`Flex(wrap)` 任务块：状态点语义色 + 名称 + 状态文案 + 耗时，live 任务每秒走字，`jobTickerNeeded` 决定要不要开定时器；无障碍整段取自 `jobListA11y`）② 已用 `tools/check-feature-wiring.mjs` 把这条接线**钉成回归**（模型判定 + 中枢投影 + 会话头传参三段）③ 剩余：轨迹里的 `JOB` 行与任务条仍是两处呈现（官方只有一处）；任务详情（参数/输出）未接 | P2-2 已做：任务条。下一步：轨迹 `JOB` 行与任务条收敛为同一处语义；任务详情下钻 |
| `workflow-run` | 完全未实现；**协议侧也无 workflow 端点**（`dshcompat/Endpoints.ets` 内无匹配） | 先确认上游是否暴露 workflow 端点；无端点则本行长期 `TODO`（**不造无协议支持的假后端**） |
| `cordis` | 无 `cordis_define` 工具行与 run/stop 开关；端点已登记但无调用点 | P2/P3：需要 keyed tool row 能力（与 `tool` 同一批） |
| `skill` | 无对话内技能引用；无专用 skill 工具行 | P2 |
| `message-feedback` | ⓪ **面板已拆成独立组件（P2-3）**：`view/MessageFeedback.ets`（表单态归它，每敲一个字不再重绘整个会话列表）；宿主保留"哪条开着 + 回执 + 提交策略"。① **Edit / More 未接**（Retry 已接：用户消息的"重发"走 `session/prompt`，有真实协议面；助手消息的"重跑那一轮"无端点 ⇒ 不给）（§10 列出的其余操作）：它们需要「重跑某一轮 / 改完再发」的协议面，本仓**没有对应端点** ⇒ 不放点了没反应的按钮（假入口），缺口显式留在这里 ② 面板与 chip 的**观感、触摸目标、四形态**均待真机验收 | P1 已做：类别（契约 7 个取值）→ 可选备注 → 提交 → 存储态回显 → **撤回**（`messageFeedback/delete` + CAS）；P2：Retry/Edit 需先确认协议面是否存在 |
| `commands` | 三种命令 UI 类型未细分；`popupSelect` 注册表语义未对齐 | P2 |
| `reference` | `@session` 引用源未确认（`@file` 已通） | P2：与子代理目录同一批 |
| `attachment` | 消息内图片、轨迹图片两类槽位未接（输入区附件已通） | P2 |
| `plan` | **更正一条过期描述**：本行原先写「控件不在 Composer 内／`/plan` 通道未对齐」——实际两件都已就位：`Composer.toolRow()` 里有「计划」chip（官方 `conversation.input.plan` 座位，判据 `pending ? !active : active` 与官方一致），宿主 `togglePlan()` 走的就是 `/plan` 命令（`executeCommand`）。剩余：chip 的观感与触控目标待真机验收 | 已就位（真机验收见 `docs/device-validation.md`） |
| `permission-presets` | **只能显示不能切换**；无 General 里的新会话默认项 | P1：需要 `dsh-permission-presets` 对应端点的调用点；先确认协议（D2b）再接线 |
| `approval` | 交互位置对等差距：官方是**输入区接管**（在对话上下文里答复），DSHM 是独立的「待决」聚合页；`Present.sortPending` 的排序已是官方语义 | P1：`PanelController` + Composer 接管式界面（与提问卡同一批） |
| `user-questions` | 同上：官方是 `ask_user_question` 的输入区接管 + 计划复核呈现，DSHM 落在待决页 | P1：同上（与 `approval` 同一批） |
| `agent-preset` | 缺**组合编辑器**（composition editor）与「后续会话默认」的显式面；复制/删除/查看已有 | P2 |
| `sidebar` | ① **官方 Sidebar 不是「页签栏」**：它承担 Brand / New Session / **Workspace→Session 树** / Panel 列表 / Settings（固定底部）/ 折叠 rail。我方当前页签只有 工作区 / 核心 / 设置（`SESSIONS` 是 `WORKSPACES` 别名、`PENDING` 不占页签），本质仍是**传统 Tab 架构** ② **更正一条过期描述**：本行原先写"我方是 `WorkspacePane` + `SessionListPane` 两个并列 Pane"——`SessionListPane`（221 行）**早就没有任何渲染点**（E108 把「会话」页签并进工作区视图之后，会话列表改由 `workspaceGroup` 渲染；它只剩 Index 里的一条死导入）。P1-1 已**删除该死文件**，并把主区里那棵真实的树（`workspaceHub` + `workspaceGroup`，285 行）抽成 `view/WorkspaceBrowser.ets`（30 门面成员，**一行都不用改名**——它本来就只经显式门面访问宿主）③ **树已挂进侧栏**（P1-3）：`SidebarShell` 的 PANEL 呈现里，树在品牌行与面板入口之间（官方顺序）；窄版行（P1-2）为 240vp 宽改行不改树。三栏下主区的「工作区」页签**不再重复一份**，只说明"列表在左侧"（判据取自 `ShellTracks`，与 AppShell 选轨道同源）。单栏 / 双栏仍由主区承载（底部标签栏 / 图标条放不下树）④ **一级导航已改由注册表驱动**（P1-4）：入口的存在/顺序归 `sidebarEntries` / `sidebarPinnedEntries`（沉底是清单属性 `SIDEBAR_PINNED_ORDER`）、图标与文案归按面板 id 的编译期映射、高亮归宿主；`SidebarShell` 里再无 `NavTab`。`NewSession` 已成为品牌行下方的一级入口；Settings 沉底；核心席位按 E110 标记为不可用（语义写进模型，不再靠视图"恰好没遍历它"）⑤ **单栏已是抽屉**（P1-5）：手机侧栏按官方语义"盖在页面上"（页头根页有导航入口、点外部收起、返回键第一优先级收抽屉、选入口/会话自动收起）；底部标签栏**暂时保留**（过渡，见 `docs/50` E306）。剩余：无会话搜索；无「分组」显式交互（现为工作区为组）；RAIL 上无 NewSession | P1-1…P1-5 已做（树抽出 → 窄版行 → 挂进侧栏 + 主区去重 → 注册表驱动入口 + NewSession + Settings 沉底 → 单栏抽屉）。**下一步（P1-6）**：会话搜索、"分组"、RAIL 上的 NewSession；真机确认后决定手机是否撤掉底部标签栏。真机项见 `docs/device-validation.md` **D11/D12** |
| `workspace` / `directory-picker-browse` | 真实文件树受 `workspaceFileScopeId` 阻塞（D4 已登记的未决来源） | 先确认该 id 的来源（协议事实）再接线 |
| `directory-picker-native` | 手机不支持系统文件夹选择器（`DocumentSelectMode` 仅 2in1） | 能力边界：手机走 `pickDocument` 回退路径；**不删功能、不假装可用** |
| `settings-general` | ① **P4-1：设置分区已进注册表**（`PanelLocation.SETTINGS` + `settingsSections()`；官方四段在前、本仓特有四项标 `owner: 'dshm'` 在后）；分区状态回归 `NavigationState.settingsSection`（视图里的 `@State tab` 已删除）② 版本化欢迎通知未确认 | P2 剩余：欢迎通知；P4-2：设置页按域拆组件 |
| `theme` | ⓪ **沉浸光感（API 26 空间化材质）暂不可用**：决策为 `targetSdkVersion` 保持 `6.1.1(24)`（2026-09-14），代价是材质只能用系统阴影表达；升级路径与「升级后只用在常驻外壳、不要全页滥用」的功耗提醒写在 `HarmonyMaterial` 注释里。① 无 `--dsw-*` 等价的**可声明令牌层**——现在是「token 常量 + 棘轮门禁」，不是可被主题切换的声明式变量；无 visual swatch ② **存量裸值 21 处 / 8 个文件**（2026-09-28 重测）已被棘轮冻结——旧记的"58 处 / 11 文件"及其分解（图标字号 46 / 圆角 5-9 / 颜色 14 处）是 2026-09-15 的读数，`tools/design-token-baseline.json` 的 `generatedAt` 仍为 `2026-09-15`、`total: 21`；剩下这些仍需一次设计收敛——**收敛会改变视觉，必须真机验收**，故不塞进机械替换 | P1 已做：token 补齐（`Border.HAIRLINE` / `Radius.XS` / `Fs.CAPTION_XS`）+ **机械替换 36 处**（数值不变 ⇒ 视觉无变化）+ 棘轮门禁。P2：图标档位与圆角的视觉收敛（真机）+ 声明式令牌层 |
| `client-locale` | 语言目录可扩展性未确认（官方支持扩展目录） | P2 |
| `dshm-diag` | 诊断页 `home=` 仍显示桩值 `D:/work`（D4 待收口第 2 项） | 核实 `runDiagnostics()` 与 `getHostHome()` 空值路径 |
| `dshm-notify` | 逐条通知的渠道路由被 SDK 标称枚举不一致阻塞（D4「仍待真机」第 5 项） | 真机阶段验证 |
| `dshm-multiwindow` | "1 条 mux + 1 条 `$events`"的抓包核对待设备 | 真机阶段验证 |
| `dshm-shortcuts` | 表与分类完成；**绑定与实机响应待验收**；Phone 不适用（无实体键盘） | 真机阶段验证 |
| `dshm-a11y` | 朗读文本与触摸目标已实现，**待真机朗读验收** | 真机阶段验证 |
| `dshm-clipboard` | **读**剪贴板不可用：`readText()` 需要 `ohos.permission.READ_PASTEBOARD`（API 12 起），应用未声明该权限；且 `readText` 全仓只有「定义 + 桶导出」2 处 ⇒ 按 E257 判据属**登记了没接**（粘贴入口本就没做）。写（复制）正常 | 决策点：① 若要支持「粘贴到输入区」，需评估声明 READ_PASTEBOARD 对上架/权限最小化策略的影响；② 若不支持，则把 `readText` 从桶导出里摘掉或明确标注为未接。**不允许挂着不动** |

> 与"行"无关的实测发现（构建/静态检查的技术债、以及 `entry` 无编译验证这一环境事实）不放进本表——
> 它们是**工程事实**，写在 §3 / §3.2；本表的每条必须对应 §4 的一个行 id（门禁会拒绝幽灵登记）。

---

## 7. 覆盖与来源

### 7.1 行集来源（可复现）

官方能力面 = 本机安装的 `@deepseek-ai/dsh` 依赖树里**全部 38 个** `dsh-client-ui-*` 包 + `dsh-client-locale`：

```
agent-preset approval attachment brand-official chat commands conversation cordis
deliverables directory-picker-browse directory-picker-native goal input-trigger jobs
layout message-feedback model-selection permission-presets plan primitives reference
renderer session settings settings-general settings-models settings-plugin-inventory
settings-plugins sidebar skill slots subagent theme tool trajectory user-questions
workflow-run workspace            （38 个）
+ client-locale                   （= 39 个官方能力面 id）
```

复现命令（在装着官方 dsh 的机器上）：

```bash
ls -d /opt/dsh/node_modules/@deepseek-ai/dsh-client-ui-* | sed 's#.*/dsh-client-ui-##' | sort
```

### 7.2 来源与版本标注（纪律：每条事实标注出处）

| 事实 | 来源 | 版本 |
|---|---|---|
| 官方能力面清单与各包行为自述 | 本机安装的官方客户端包 `package.json`（`name` / `description` / `dsh.client`） | ⚠️ **0.1.2-alpha.1（落后于当前基线；2026-09-30 已复核，缺口见下方同一性提示）** |
| 各 `Web 行为` 列文案 | 由上述 `description` 意译（不新增未经查证的断言） | 同上 |
| Harmony 落点 | 本仓库源码（行级可核对，见各单元格文件路径） | HEAD `33662bd`（2026-09-30 核对；此前标注的 `af00b0b` 已不在本仓历史中） |

> ⚠️ **同一性提示**：本项目的协议基线是 **0.2.1-alpha.1**（D2 §0 / D5 §4.1），而 §7.1 的能力面清单来自 **0.1.2-alpha.1**。
> 因此 §7.1 的能力面清单**需要用当前基线复核一遍**。**本轮复核已做（rc.2 时），结论是清单确实落后**：核心树
> `dist/core/work/dsh-core-0.2.1-alpha.1/node_modules/@deepseek-ai/` 下有 **53 个** `dsh-client-ui-*`，
> 比清单多 15 个（`open-in-app`、`plugin-manager`、`schedule`、`settings-account`、`settings-agent-loop`、
> `settings-session-log`、`settings-shell`、`settings-subagent`、`settings-web-search`、`shortcuts`、
> `sidebar-browser`、`sidebar-documentpreview`、`sidebar-files`、`sidebar-right`、`sidebar-terminal`）；
> 更稳的基准是 `dsh-web-app/package.json` 的依赖表（`0.2.1-alpha.1` 下 **135 条依赖**，`0.2.0-rc.2` 是 131 条，
> +4 全部来自闭包变化；与清单的差集仍是上面 15 个）。⚠️ 顺带一个**升级中性**的读数：两版核心树的
> `dsh-client-ui-*` **同为 53 个且集合逐条相同** ⇒ 依赖闭包变化没有动 UI 能力面。
> 这 15 个是否各自建行、还是按既有惯例粗化进 `sidebar` / `settings` 行，
> **尚未裁定**（详见 `review-report-2026-09-29.md` 的 6-M7）。
> 复核方法：`node tools/check-parity.mjs` 会在清单与实际行集不等时报出差集。

### 7.3 门禁

```bash
node tools/check-parity.mjs              # 校验本矩阵（覆盖 / token / 不变式 / 缺口登记）
node tools/check-parity.mjs --self-test  # 注入式自检：证明它会失败（未被负测试验证的门禁等于没有门禁）
node tools/check-parity.mjs --list       # 打印解析出的行与状态

node tools/check-layout-fixtures.mjs              # 四形态 + 断点边界 + 让步链（纯逻辑，无需设备）
node tools/check-layout-fixtures.mjs --self-test  # 证明断言器会失败
                                                  # **2026-09-30 起 Windows 直接可跑，不需要任何 shim**：
                                                  # findTsc() 内置了 IDE 自带 typescript 的候选路径
                                                  # （旧法：junction 暴露 <IDE>\tools\hvigor\hvigor\node_modules\typescript，
                                                  #  2026-09-28 曾靠它拿到 768 条断言 / 0 失败）

node tools/check-arkts-entry.mjs              # 编 entry（UI 层）的 ArkTS：P1~P3 改 Index.ets/Pane 的守护
                                              # Windows 本机可直接跑（2026-09-28 修掉四处 Linux 布局写死）
node tools/check-arkts-entry.mjs --clean      # 强制真正重新编译（增量时 CompileArkTS 会被 UP-TO-DATE 跳过）
node tools/check-arkts-entry.mjs --self-test  # 判定器自检（9 个样例，含"hvigor 失败却退出码 0"的真实形态）
```

---

## 附 A：`Index.ets` 依赖关系与拆分基线（P1 输入）

**现状**：`entry/src/main/ets/pages/Index.ets` = **4613 行**、**22 个 `@Builder`**、约 60 个方法，承担五类职责：

| 职责 | 现状落点（Index.ets 内） | 目标归属（计划 §3/§7） |
|---|---|---|
| 布局决策 | `applyWidth`、`layoutModeOf` 调用点、`Sz.NAV_RAIL` 判断 | `LayoutController` |
| 页面装配 | `mainContent`、`tabContent`、`buildSingle/Double/Triple` | `AppShell` + `MainContent` |
| 一级导航 | `bottomTabs`、`navRail`、`navPanel`、`navPanelAction` | `NavigationController` |
| 会话/输入区 | `header`、`hubBanner`、`workspaceHub`、`workspaceGroup`、`coreTabContent` | `Conversation/Composer/Workspace` 控制器 |
| 设置表单与审批 | `textSettingSheet`、`structSettingSheet`、`credentialSheet`、`folderSheet`、`choiceSheet` | `SettingsController` / `PanelController` |

**已经分出去的部分**（不用重做，避免重复实现已有功能）：

| 层 | 文件 | 被谁用 |
|---|---|---|
| 设计令牌 | `appstate/ui/Tokens.ets` | 各 Pane（`Sp`/`Radius`/`Fs`/`Sz`/`SemanticColor`） |
| 断点与档位 | `appstate/ui/Breakpoints.ets` | `Index`（3 个调用文件） |
| 快捷键表 | `appstate/ui/Shortcuts.ets` | `Index` + `view/ShortcutKeys.ets` |
| 设备事实 | `platform/system/DeviceFacts.ets` | 仅 `EntryAbility`（窗口账本）与 `RuntimeSingleton` |
| 系统能力 | `platform/system/*`（文件选择/剪贴板/通知/分享/窗口记忆） | 各 Pane 经 `platform` 桶导入 |

**本轮发现的三处硬事实**（可直接作为 P1 的起点）：

1. **`navPresentation` / `NavPresentation` 只有 2 处引用**：定义（`Breakpoints.ets`）+ 桶导出（`appstate/Index.ets`），**没有任何界面调用点**。
   按项目既定判据（E257：**1 处该删，2 处该登记**），它属于"登记了没接"：**导航呈现决策没有真的走布局层**，`Index.ets` 里自己按宽度与 `Sz.NAV_RAIL` 判。
   → P1 第一刀：让 `LayoutController` 消费 `navPresentation`，否则删掉这个会撒谎的 API（二选一，不允许挂着不动）。

2. **布局决策确实只由窗口宽度驱动**：全仓 `FormFactor` / `readDeviceFacts` 只出现在 `EntryAbility`（窗口账本登记）与 `RuntimeSingleton`，**没有任何 UI 用它做布局分支**。D3 §2.2 的硬规则在实现上是成立的（不需要先修）。

3. **系统能力调用直接落在 `Index.ets` 上**（P3 落点证据）：
   `Index.ets:839 applyThemeMode`、`:1211/:2818/:3094 copyText`、`:1390 pickDocument`、`:1794 pickFolder`。
   官方对等物是 `platform/*`，而计划 §15 要求"业务代码不得直接散落平台判断"。
   → P1 建 `PlatformAdapter` 边界时，先把这 6 个调用点收进适配层；**`deviceType` 判断本身目前没有散落**（这点是好消息）。

**拆分顺序（计划 §7，每次拆完保持门禁全绿）**：

```
1) layout decision    → LayoutController        ✅ 已做（Index 已消费，行为等价，commit fad954a）
2) navigation         → NavigationController    ✅ 已做：返回键 7 级优先级阶梯 + 页签归一化/清栈/静态事实重读
                                                  全部搬出，54 条 fixture 断言覆盖（含"浮层内部先后"）
3) detail/right panel → PanelController         待做
4) command palette    → PanelController         待做
5) composer           → ComposerController      待做
6) conversation       → ConversationController  待做
```

每一步的验收：`arch-check` / `check-feature-wiring` / `check-store-readiness` / `check-parity` /
`check-arkts-entry` / `check-layout-fixtures` / `check-design-tokens` 全绿 + 本矩阵对应行状态**只升不降**（门禁强制）。

> **第 2 步顺带发现的一个坑（值得记住）**：`NavTab.SESSIONS` 是 `'workspaces'` 的**别名**（E108 会话并入工作区），
> 所以"在会话页签"与"在工作区页签"是同一个状态、**不存在 `'sessions'` 这个取值**。
> fixture 第一版把它当独立值用，立刻红了两条——这正是把导航搬成纯函数想要的效果：
> 这类语义坑以前只存在于 `Index.ets` 的内联判断里，没人能单独测它。

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.45 | 2026-10-04 | **端侧核心升到 `0.2.1-alpha.1`（registry 上唯一更新版本；`latest = next` 仍是已钉的 `0.2.0-rc.2`）**：① **契约层零漂移**（140 → 140，形状/参数名/流式标记/可取消性/声明包逐条一致，`Endpoints.ets` diff 只有版本号与 `capturedAt` 三行）——**连续第四次零意外**，这次连"纯新增"都没有；跨版本比对（`DSH_CONTRACTS=…-0.2.1-alpha.1.json DSH_VERSION=0.2.1-alpha.1 node tools/compat-drift.mjs`）先于刷快照跑，exit 0「✅ 无漂移」，随后刷默认快照（含 `.meta.json`）+ `gen-compat-endpoints.mjs`（140 端点 / 13 流式 / 15 能力 / 86 未被能力引用，无 WARN）+ 复跑 exit 0。② **唯一实变在依赖闭包**：+`dsh-tool-schedule`、+`dsh-experimental-inspector-profile`，−`dsh-experimental-schedule-bundle`、−`dsh-invariants`（后两者全仓零引用）；`@deepseek-ai/cordis` `~4.0.4` → **`~4.0.5-alpha.1`（预发布联动）** ⇒ 自家插件 `dshm-office-system-preview` 的 peer 必须跟版（`~4.0.4` 的范围不匹配预发布版），另三个插件的 peer 跟到 `0.2.1-alpha.1`。③ **两处「写死核心版本路径」的门禁改为读 `hostcore/core-recipe.json`**（`check-sidebar-tab-id-guard.mjs:35`、`check-undici-shim-exports.mjs:40`）——写死会在升级后**静默测旧树**（与 v1.39 的 `update-device.ps1` 同族）。④ **`check-origin-fence.mjs` 修掉一处就绪竞态**：`waitReady` 原把任何 `status > 0` 当就绪、`mintCookie` 随即一次性读 `host-ready.json`，而新核改成「先 404 应答、后落盘」⇒ 该门禁在新核 3/3 误报失败（修前新核 3/3 FAIL / 旧核 3/3 PASS；修后两版核心各 3/3 PASS），并按 `docs/40` §5 补两条负测试。⑤ **产物与装机**：核心 zip `84,003,922 B`（30,451 条目，sha256 `7103724…`）、resfile **去旧留新**（`--place-in-app` 只拷不删，必须显式删旧 zip）、HAP signed `320,195,241 B`（sha256 `60eb817f…`）；真机 `BOOT_10_ENV_READY core=…/dsh/cores/0.2.1-alpha.1`、`LOOP-GAP` **0 条**、`IN-DONE` 53 条（最慢 6341 / 4965 ms）、`BOOT_65_AUTH_URL` 1 条、`GET /` 401 → 200、`POST /api/schedule/{catalog,list}` 200（schedule 能力已由 `dsh-web-app` 自带；设备 live profile 里残留的 `dsh-experimental-schedule-bundle` 被 host 的 bundle 预检静默移除、启动不抛错）。⑥ 另两条非零门禁定级（**都与升级无关**）：`check-model-roundtrip.mjs` = 门禁自述的 Windows 缺 koffi；`check-dshm-installer.cjs` = 本机出网挂起。⑦ 逐条判定见 `docs/40-上游升级手册.md` §4.5 与 `docs/10-协议兼容事实基线.md` §8.7.25。**仍未做**：`check-parity` 内嵌 UI 清单停在 `0.1.2-alpha.1`（P1-1）、`hostcore/app/main.js:2423` 假壳仍报 `0.1.7-rc.1`（D8）——两项有意留作独立提交 |
| v1.44 | 2026-09-30 | **文档回写轮（审核后清账，只改文档不动代码）**：① **§7.2 来源版本改正**：`0.1.2-alpha.1` 标为**已过期、复核未做**；`§7.1` 后的「同一性提示」由"基线是 0.1.5-rc.1"改为**当前基线 `0.2.0-rc.2`**，并把本轮**已做的复核结论**写进去——当前核心树有 **53 个** `dsh-client-ui-*`，比门禁内嵌清单多 **15 个**（`open-in-app`/`plugin-manager`/`schedule`/`settings-account`/`settings-agent-loop`/`settings-session-log`/`settings-shell`/`settings-subagent`/`settings-web-search`/`shortcuts`/`sidebar-browser`/`sidebar-documentpreview`/`sidebar-files`/`sidebar-right`/`sidebar-terminal`）；更稳的基准是 `dsh-web-app/package.json` 的依赖表（127 条依赖里 51 条为 `dsh-client-ui-*` / `dsh-client-locale`，与清单差集**恰好是这 15 个**）。这 15 个是各自建行还是按既有惯例粗化进 `sidebar`/`settings`，**尚未裁定**（详见 `docs/review-report-2026-09-29.md` 的 6-M7）。② **§3.3 libnode 行改正**：实物 `libnode.so.137`（126,809,264 B），原文写 `.127` 且"169 MB 原生库组"两个读数都不对；保留"本文多处历史行仍写 `.127`"的指引（D6 开篇已有版本口径提示）。③ 同轮其它文档：`docs/10-协议兼容事实基线.md`（§8.7.24 正文落笔，v1.2）、`docs/40-上游升级手册.md`（§4.1 表 + §4.4 逐条判定）、`docs/README.md`（R1 索引行区分 85/63 两个口径、更正"本仓不是 git 仓库"、阅读顺序加"决定接下来修什么"）、`.local-rules/{build-status,current-machine}.local.md`（基线重写到 rc.2）。**注**：§7.2 表格与 §4/§6 的既有行号未变动（改的是等长文本），`check-doc-refs` 与 `check-parity` 均 exit 0 |
| v1.43 | 2026-09-29 | **端侧核心升到 `0.2.0-rc.2`（上游最新）＋ 插件入口 GitHub 安装修复 ＋ 首次 7 路对抗性审核**：① **核心升级**：契约漂移 **+2 / −0 / 零契约变化**（新增 `userQuestions/{answer,attachWait}`，全仓零调用 ⇒ 不改调用代码），`SUPPORTED_VERSIONS` 置 `0.2.0-rc.2` 为首、`Endpoints.ets` 重生成（140 端点 / 13 流式 / 15 能力）、`core-recipe.json` 的 `coreVersion` 同步；resfile 换包（去旧留新，**78,081,448 B / 29351 条目**，sha256 `45836D8A…FFF3B3`），重装后 `BOOT_10_ENV_READY core=…/dsh/cores/0.2.0-rc.2` 确证，新旧核心树并存、el2 用户数据零变化；`compat-drift` 由 138/138 变 **140/140 无漂移**（本文 §3.2/§3.3 三处读数已同步）。② **插件入口 GitHub 地址装不上（真机实测已修好）**：真因两层——（a）GitHub **源码树不含构建产物**（`main`/`exports` 指向只存在于 npm tarball 里的产物）；（b）monorepo 仓库**根目录没有 `package.json`**，且 `INSTALL.md` 官方写法用的是 `#path:/<sub>` 而旧 `parseGitHub` 只认 `&path:`（`#path:` 被当成 git ref ⇒ codeload 404）。修法：`parseGitHub` 路径正则放宽到 `[&?#]path[:=]`；新增 `findPackageRoots`（唯一子包自动进入 / 多候选列出 `&path:` 清单不再猜）；新增 `repositoryMatchesRequest` 守卫 + GitHub→npm **同名同源回退**（仅当无 `&path:`、只回退一次、身份守卫通过、版本取 registry latest 而 profile 仍记用户原始 spec）；卸载侧补幂等回收与路径校验。门禁 `tools/check-dshm-installer.cjs` **43 passed / 0 failed**。③ **7 路对抗性审核（只审不改）**：判据统一为「对齐官方 dsh」，出 **85 条**（阻断 2 / 高 25 / 中 38 / 低 20），报告见 `docs/review-report-2026-09-29.md`。**结论：契约表本身零偏差**，问题全在契约表之上（接线层）与之外（Host 包装、卸载路径、连接层）。最值得先看的三条：**心跳仍是官方默认 2000ms**（`typert-gateway` 无 `config` 覆盖 ⇒ 连接抖动根因，修法已写明未落盘，见路4）；**Host 启动期不清残留 `host-stop-request`**（40s 自杀强嫌疑，见路2）；**卸载在 5 类路径上不对称**（多为例「返回 `ok:true` 却没清干净」的静默假成功，见路3）。④ 本文 §3.2/§3.3 的 `compat-drift` 与核心包读数同步到 `0.2.0-rc.2`；`docs/40-上游升级手册.md` §4.1/§4.4、`docs/10-协议兼容事实基线.md` §8.7.24 同步落稿 |
| v1.42 | 2026-09-28 | **端侧三项缺陷修复（P0-1 / P1-2 / P1-3，用户「端侧待修清单」；每项都配"真极端"可复现用例与故障注入验证）**：三项的共同形态都是**静默不一致**——不报错、界面看着正常、结果与意图相反，因此本轮的重点不在"改对"，而在**让它们在被改回去时立刻变红**。① **P0-1｜内置技能同步的判等指纹是「字节数」**（`main.js` `ensureBundledSkills` 原先逐字 `if (statSize(dst) === statSize(src)) continue;`）：`hdsh-*`→`dshm-*` 是**等长替换** ⇒ 两份 `ohos-python.md` 都是 6262 B ⇒ 设备端永远停在旧端点（`/hdsh-python/*` 已在 `0.2.0-rc.1` 下改成 `/dshm-python/*`）⇒ 模型照技能文档手调**必然 404**，而日志一直打印「本次复制 0 个」。修法：抽出 `hostcore/app/dshm-skills.js`（`crypto.createHash('sha256')` 比**内容**，`copyFileSync` 到同目录临时名 + `renameSync` 原子覆盖，单文件失败只记 `failed` 不抛错，另清扫崩溃残留的 `.dshm-skills-tmp-*`）；门禁 `tools/check-skill-sync.cjs`（新，**32 passed**，A–H 八组，C/D 组专测**等长改动**必须被复制、目标被等长篡改必须以源为准恢复，且不依赖网络）。② **P1-2｜安装器幂等分支从不比对版本**（`dshm-installer.js` 原「目录在 + 入口可加载」即 `continue`）：真机现场是 `profile/package.json` 声明 `dshmarket@1.66.2`、磁盘实为 `1.65.1`，而 `0.2.0-rc.1` 的兼容检查**按磁盘版本判定** ⇒ 插件被跳过未挂载；且此后任何 `pnpm add` 都走幂等分支"成功"，**永不收敛**。修法：新增纯函数 `readInstalledVersion(dest)` / `versionDrifted(resolved, have)`（**GitHub 形态的 `resolved.version` 是 ref，与 semver 不同维度，一律不判漂移**，否则必然误报），漂移时连同 `beforeVersions` 记下原版本、`fs.rmSync` 后重装，返回体带 `beforeVersion` → `afterVersion`；门禁 `tools/check-dshm-installer.cjs` 由 **exit 1 修至 24 passed**——它此前**自首次提交（`e7b5ed7`）起就一直是红的**，两处陈旧断言（期望 `^4.3.4` 而实现自 2026-09-26 起优先写**请求 spec**；断言 installer 写 `.dshm-plugin-rows.yml` 而 `appendUserRow` 已于 2026-09-25 有意删除 ⇒ ENOENT），并补 5a 真幂等 / 5b **版本漂移必重装** / 5c 收敛三向用例。③ **P1-3｜兼容性豁免通道在端侧不可达**：`0.2.0-rc.1` 的出路是 `dsh plugin allow-version` 或插件管理器，而端侧假壳只实现 `plugin install` / `plugin remove`（**鸡生蛋**：插件市场自己正是被跳过的那个），豁免机制（上游 `dsh-app-boot` 的 `compatibility.json`，先于任何插件加载读取）**存在但没有写入路径**。修法三层：假壳补 `allow-version` / `revoke-version` / `version-exemptions` 三子命令并把请求投进**既有队列通道**（新增 `*.compat-req`，Host 侧 2000 ms 轮询同一骨架，结果写 `.done` / `.fail`）；Host 侧新增 `hostcore/app/dshm-compat.js` **薄封装而非自实现**（直接 `import()` 上游 `getDshRuntimeVersion` / `readProfileCompatibility` / `setProfileVersionExemption`，继承上游三道闸：不传 `acceptRisk` 必须被拒、运行时版本不符必须被拒、`compatibility.json` 写坏时 `rewritable=false` 拒绝改写——自己写文件若 schema 偏移会被上游**静默不认**，比没有通道更难查），`applyRequest` **绝不抛错**且成功回传 `profileDir`（写错 profile 是整条通道最安静的失败点）；设置→插件页新增「兼容性豁免（风险自负）」开关（默认 `acceptRisk=false`，**绝不替用户确认风险**）；门禁 `tools/check-compat-exemption.cjs`（新，**48 passed**，两臂：臂 A 以假 appBoot 断言透传语义与 7 种坏载荷，臂 B 用**真实上游** `evaluatePluginCompatibility` 对比 `exempted` 是否**真的翻转**——判据不是"文件写了没"，因为四种失败模式在 UI 上都是"点了开关、提示成功、什么都没变"）。**故障注入（用户「落实真极端检测需求」）**：P0-1 做等长改动专项、P1-2 做版本降级专项、P1-3 做 `noop`（删掉上游写入调用，返回体照旧 `ok:true`）与 `wrongdir`（写到 `profileDir + '-elsewhere'`）两种注入 ⇒ 门禁分别以 **28 passed / 20 failed** 与 **40 passed / 8 failed** 干净点名（红项首位即 `B8 exemption flips the mount decision` 的 `exempted:false` 与 `A1 profileDir passed through`），**0 条 FATAL**，还原后逐字节相同（基线 sha256 `29A2D186…56223`）。**注入顺带暴露了门禁自身的缺陷**：`readRaw()` 原被**急切求值**在断言 detail 实参里，而"豁免文件不存在"正是要抓的失败模式 ⇒ 会以 `[FATAL]` 崩栈而不是红项列表，把"豁免没生效"误报成"文件读不到"⇒ 补 `readSoft` / `show` / `readJsonSoft` / `statSoft` 四处软读。④ 两处 `FILES` 清单（`tools/place-host-app.mjs:42` 与 `tools/assert-resfile-sync.mjs`）同步扩到 **9 项**，`assert-resfile-sync` 由「8 件」变 **「10 件快照全部同步」**；`main.js` 现 **208567 B / 4204 行**，源 ↔ resfile 快照 SHA256 逐一 IN-SYNC。⑤ 收尾时把 `tools/check-doc-refs.mjs` 从"188 处几乎全是假阳性"（首版判据把**任何两位数字 + 冒号**当引用目标，命中时间戳 / IP 片段 / 代码行号）收紧到 **exit 0 / 19 个文档 / 188 条引用 / 0 问题**，并清掉 `docs/90` 里三处指向**从未入库**的 `docs/90-staging/`（合并前的分章草稿 A/C/E = 现第一/三/五章，§7 已加历史说明）。⑥ 本机 22 条门禁重测 **`19×0 / 1×3 / 2×1`**（旧记 `23×0 / 2×3 / 7×1` 已过期）；`check-arkts-entry.mjs` exit 0 证明 `SettingsPlugins.ets` 的开关可编译 |
| v1.41 | 2026-09-28 | **收尾清理：一次性脚本 + dist 临时产物 + 保留脚本硬编码（详见 `docs/90-…md` §5.3/§5.6/§5.7/§6.3、`device-validation.md` 批次三十六）**：用户指示「升级完成检测无误后就更新文档，清理环境」，就粒度提问后选定**全清**。① `git rm` **7 个一次性脚本**（`repro_all.py`／`repro_local.py`／`repro_report9.py`／`close_picker2.py`／`verify_t1_clean.py`／`protocol-enum.mjs`／`check-layout-fixtures.mjs.bak`〔124824 B，原登记"是否删由项目方定"，本轮拍板〕）——逐个 `Test-Path` 复核不存在，`tools/` 顶层 **64 → 57**、递归 **92 → 85**（口径见 `docs/90` §5.3）；② 删 `dist/` 本轮 6 个临时重定向产物（`_drift{,_2}.{out,err}`、`_build020.{out,err}`），`dist/sideload/` 交付物保留；③ **保留脚本的硬编码统一改为从 `hostcore/core-recipe.json` 读**（该文件是版本的唯一事实来源）：`scan-core-plugins.mjs` 默认 `coreDir`（原停在 `dsh-core-0.1.5-rc.2`，一跑就 `FATAL: no node_modules under …`）、`func_test_final.py` T0.3 核心版本（新增 `want_core()`）与 T0.2 的 `>= 7`、`update-device.ps1` Step 8 的 exec 探测判据（原 `$okCount -ge 7` ⇒ 改为按 `[，,]` 切分逐项要求 `=ok$`，结论段同步改用 `$execOk`）、`dshtest.py` 的 hdc 路径（原为 `%USERPROFILE%\…\<版本>\…` 占位符 ⇒ 改为 `DSHM_HDC` → PATH → DevEco 工具链目录）；④ 修 `dshtest.py` 的仓库绝对路径写死（`ART` 改为相对 `__file__`）；⑤ **同一个"写死总数/版本"的形态在本轮已清完**（`docs/70` §8.13 的 E381/E382 教训）：它的问题不是"改起来麻烦"，而是**新版失败也不会被发现**；⑥ 8 个文档的悬引用同步（`10`／`50`／`70`／`90`／`device-validation`／`functional-test-report`／本文），其中 `docs/functional-test-report.md` 的"可复用测试资产"表原登记 `show_ui.py`（**文件从来不存在**，属"文档与实物不符"）与两个已删脚本 ⇒ 一并移除；⑦ 仅剩 `tools/update-device.ps1` 的 hdc 占位符**有意保留**（模板形态，本机装机仍手敲 `hdc install -r`）；⑧ 验证：`py_compile` 两个 Python 工具 exit 0、`dshtest.py` 的 hdc 自动解析实测得 DevEco 自带那个、**15 条门禁全部 exit=0** |
| v1.40 | 2026-09-28 | **m00001「设置 → 登录」拉起系统浏览器：真机复核通过（D28 四步全通；详见 `device-validation.md` D28 与 `docs/70-…md` §7.9）**：① 修复本体 = `WebApp.ets` 的文档开始垫片 `OPEN_LINK_SHIM_JS` + 同步桥 `__DSHM_BRIDGES__.openExternal(url, mode)` → `platform.openExternalUrl`（`context.openLink`），三条路径（`account/watch` 的 WS 帧自动外开 / 含 `account/` 的一元 `fetch` 兜底 / 捕获阶段拦 `target="_blank"` 与 `window.open` 二次确认后外开）；② 真机读数（设备 `86E0226429000417`，HAP 314,673,276 B / `updateTime` `2026-09-28 21:09:42 CST`）：`diag-openlink` 有 `auto https://platform.deepseek.com/dsh/authorize?authorize_id=…`（**无确认框**直接外开）；回跳后设置面板出现「账号与余额」section（**只在 `status === "credential-stored"` 时注册**，`dsh-client-ui-settings-account/lib/client.js:4397-4419`）⇒ 第 3 步判据成立；点「查询用量」⇒ `AlertDialog`「打开外部浏览器？」⇒ 点「打开」后 `ei.hmos.browser` 真被拉起并加载 `platform.deepseek.com/usage`；③ 第 4 步做了**阴/阳对照**（排除误击与设备侧自启）：`aa force-stop` 后三轮询均无浏览器 ⇒ 无自启/预热；点外链 ⇒ `diag-openlink` 408→477 B、`OnInvokeMethod: … openExternal` 3→4、**浏览器仍无**；点**取消** ⇒ **三者全不动**；再点「打开」⇒ 477→546 B / 4→5 / `23803 ei.hmos.browser` + 前台即用量页；④ 关键数值线：`diag-openlink` 累计 6 行（1×`auto` + 5×`confirm`），**无任何 `failed`/`error` 行**；`node-output.log` 里 `OnInvokeMethod: method name: openExternal` = 5，紧邻 `CheckIsInJsPermission …, method_name: openExternal, object_id: 1` 与两次 `ParseBaseValueTOCefValueHelper: STRING`（即 `url` 与 `mode` 两个字符串参数）；⑤ 两个**取证方法坑**（已写入 D28）：设置对话框**记住上次的 tab**，点账号区坐标前必须先点「账号与余额」（否则打在插件明细上，本项因此误判过一次）；**本项 hilog 抓不到**（`hilog -x -T DshWebApp` 与按关键字筛均为空，只剩 `:gpu/chromium` 噪声）⇒ 外开取证只能靠 `diag-openlink` 文件 + `uitest dumpLayout` 前后 diff；⑥ 一次**污染读数**留档（非缺陷）：首轮点「取消」后曾观察到浏览器在前台，干净复位后复跑不复现 |
| v1.39 | 2026-09-28 | **端侧核心升到 `0.2.0-rc.1`（上游最新，2026-09-28 发布）**（详见 `docs/40-上游升级手册.md` §4.1/§4.3、`device-validation.md` 批次三十五）：① 漂移 **+3 / −0 / 零契约变化** —— 新增 `productAnalytics/{enabled,report,watchPolicy}`，端点 135 → 138；全仓检索该命名空间**零命中** ⇒ **不改任何调用代码**，只重生成上表 + 更新矩阵；② 改动面 4 处：`hostcore/core-recipe.json` 的 `coreVersion`、`CompatIndex.ets` 的 `SUPPORTED_VERSIONS`（置 `0.2.0-rc.1` 为首）+ 版本记录注释、`Endpoints.ets` 重生成、`tools/update-device.ps1` 的版本判据改为**读 recipe**（原先写死 `0.1.7-rc.2`，升级后会误报 FAIL）；③ 换 resfile 核心包（去旧留新，78,705,318 B / 29602 条目），重装后真机读数 `BOOT_10_ENV_READY core=…/dsh/cores/0.2.0-rc.1`，**新旧核心树并存**（`docs/50:45` 的"升级核心不得动用户数据"成立，el2 清单逐项未变）；④ 记一个与门禁可靠性直接相关的陷阱：**默认契约快照 `.research/protocol/contracts.json` 必须与新上表同步**，否则 `compat-drift.mjs` 把新增端点报成「上游移除端点（会返回 HTTP 404）」——**方向完全相反**（详见 `docs/40` §4.3 的判别法与本节 §3.3 的注记）；⑤ 上述四处改动后 15 条必跑门禁**全部 exit=0**（含修正默认快照后的 `compat-drift.mjs`），`assembleHap` BUILD SUCCESSFUL，`hdc install -r` 覆盖安装后 el2 用户数据零损伤 |
| v1.38 | 2026-09-28 | **门禁"盲区"复核：四条里没有一条是本机能力不足（详见 `docs/90-…md` §2.4/§3.6）**：① `check-arkts-entry.mjs` 修掉**四处 Linux 布局写死**（`tool/node/bin/node` 缺 `.exe`、`JAVA_HOME` 默认值、`DEVECO_SDK_HOME=join(clt,'sdk')`、`PATH` 分隔符写死 `:`——最后两条此前未登记），**exit 3 → 0**，日志含 `CompileArkTS` + `BUILD SUCCESSFUL`；它守的正是 `entry/src/main/ets`（UI 改动的主要落点），长期 exit 3 意味着**这一层近两周没有自动验证**。② `check-web-fetch-jitless.mjs` 修掉两处硬缺陷：flag 写死的否定形态在 Node 24 无效致**两臂哑火**、loader 传裸盘符路径致 **B 臂从未跑成**；**exit 1 → 0**（A 臂 4/4 按预期失败 / B 臂 8/8 全过 / 跨源跳转仍被拒）。③ `compat-drift.mjs` 实测可跑（指向仓库内核心树即可，**当时** 135/135 无漂移；同日升到核心 `0.2.0-rc.1` 后为 138/138，见 §3.1）⇒ **不再是盲区**。④ 本文件 §3「验证手段」与 §3.2 盲区表已同步；`docs/50:1341`、`docs/90` §2.3/§2.4/§3.4/§3.6/§5.6 同步落稿。⑤ 本机 14 条必跑门禁**全部 exit=0**（含上述两条）|
| v1.37 | 2026-09-26 | **官方语音按钮接入 HMOS 系统识别（HMS）**（详见 `device-validation.md` 批次二十三）：① 真机实测按钮从「打开语音输入引导」（usable=false）变为 **「开始录音」**，点击后进「正在录音…／停止并识别」，识别文字**落入输入框草稿**（`textField`，非已发送消息）；② **架构关键**：新增独立插件包会 `failed to import` —— loader 对裸包名走 `internal.import(specifier, bareModuleBaseUrl)`，可解析的包须属于某 bundle 的 dependencies 闭包（对照 `directory-picker-browse` ⊂ `dsh-web-app` 能解析），且 `profile-boot` 未传 `bareModuleBaseUrl`；故改走**替换 `sensevoice` 的 `apply`**（它已在 voice-input-bundle 闭包内 ⇒ 零新增接线），注入用相对 import 绕开包表；③ 数据流：WebView 录音→16k WAV base64→Host provider→**文件队列**（`$DSH_HOME/speech-to-text/hms-bridge`，照 `host-stop-request` 先例）→ArkTS `speechRecognizer`→文本回填；④ 修三个 bug：`does not support language: auto`（须 provider 声明 zh-CN **且** profile 钉 `language: zh-CN`；且 profile 覆盖是**整块替换** config，漏写会抹掉 `defaultProvider`）、队列被不完整 `.req` **永久堵死**（陈旧回收未覆盖 `.req`）、超时固定 25s 与"按实时节奏送音频"错配 ⇒ 长录音**必然**超时（改为按时长伸缩）；⑤ 纠正两处不实注释（"不能丢余数"与 `slicePcmChunks` 实际丢弃尾巴矛盾；实测量化：整数秒录音余数为 0，最多丢 639B≈20ms）；⑥ 门禁 **758→768 断言 0 失败**（新增两侧 WAV 常量一致性断言，负测试两条均变红）；⑦ 清理失败方案残留 `hostcore/speech-stub` 与 `injectSpeechStub`；⑧ 遗留：`build-profile.json5` 临时 `bundleName: com.dshm.micverify` **需还原**；数据安全：零卸载 |
| v1.36 | 2026-09-26 | **路线 A（HMS 系统语音识别）端到端通过（详见 `device-validation.md` 批次二十二）**：① 真机两轮实测识别真实语音出文本（用户说「一二三四五」→ `12345。`；「一二三四五六七」→ `1234567。`），完整链路 `createEngine=OK` → `onStart` → `AudioCapturer` 16k 采音 → 流式 `onResult` → `isFinal` 定稿 → `onComplete` 全通；② 修掉**三个真机才暴露的坑**：**(a)** `startListening` 是**异步**的（签名 `void` 看不出），紧接 `writeAudio` 报 `1002200010` ⇒ 必须等 `onStart`；**(b)** `onResult` 给的是**累计文本**非增量，`+=` 会得到 `"一一二一二三…"` ⇒ 抽成 `mergeTranscript()` 信 `isFinal` 定稿；**(c)** 识别结束后仍送音频 ⇒ 加 `finished` 标志（`1002200010` 出现 1→0）；③ **纠正一个误判**：原想用 TTS 做自动往返自检，实测 `onComplete` 74ms 返回、`onData` 不触发（`speak` 是**播放**接口）⇒ 那两次空文本是**录到静音**（`peak=0`），**不能**据此说 ASR 不可用；为此加 `isNearSilence()` 在日志标注；④ **负测试发现断言漏洞**：变异"删掉 `isFinal` 分支"**仍全绿**（只验结果、未验依据；真机序列每条恰好更长故长度判据巧合相同），补"定稿更短"用例（`"一百二十三"` + `"123"` isFinal ⇒ 应得 `"123"`，退化则得 `"一百二十三123"`）后三种变异全红；⑤ 门禁 **740→758 断言 0 失败**；⑥ 数据安全：零卸载，既有 bundle 数据未变 |
| v1.35 | 2026-09-26 | **路线 A（HMS 系统语音识别）可行性自检：引擎可用（详见 `device-validation.md` 批次二十一）**：① 新增「HMS 语音识别自检」入口，真机记录 `createEngine=OK` / `listLanguages=["zh-CN"]` / `onStart=startListening success` / `writeAudio=done` / `onResult isFinal=true` / `onComplete=recognize complete` / `shutdown=done`（喂合成音故 `text=""` 属预期）⇒ **排除最大未知风险**（`createEngine` 未抛 1002200001）；② 回 SDK 核实硬约束：HMS 只收 **16000 Hz / pcm / 单声道 / 16 位**、`writeAudio` 只收 **640 或 1280 字节**、上限 60000ms、离线仅 `zh-CN`；采集侧 `AudioSamplingRate.SAMPLE_RATE_16000` **系统直接支持**、`SOURCE_TYPE_VOICE_RECOGNITION=1` 专为 ASR、`read()` 自 API 11 废弃改用 `on('readData')`；③ 新增 `appstate/.../model/SpeechPcm.ets`（重采样/分块/时长/测试音纯函数）+ **40 条门禁断言**（含 ★符号位保真：±1000 方波重采样后必须有负值，写无符号会削顶失真），门禁 **705→740 断言 0 失败**；④ 记一个实现要点：`readData` 块大小不定而 `writeAudio` 只收定长 ⇒ 必须**累积切片且不丢余数**（丢余数会丢字）；⑤ 新增第三项入口「HMS 端到端自检（说话）」：真麦克风 → HMS → 真实文本，**待真人语音验证**；⑥ 数据安全：全程零卸载，既有 `com.dshm.dshclient` home/会话未变 |
| v1.34 | 2026-09-26 | **麦克风最小验证通过 + 真机 bug 修复（详见 `device-validation.md` 批次二十）**：① 用户完成自动签名（材料落 `~/.ohos/config/`）后装机，WebView **真的拿到音频轨**——`diag-mic-probe` 记 `audioTrackCount=1 / sampleRate=48000 / trackLabel="(default)麦克风" / trackState=live / result=OK`⇒ 路线 A（HMS 原生识别）与 B（云端 provider 插件）均可继续；② **真机暴露并修掉我自己的 bug**：ArkWeb 的 `getOrigin()` 返回 **`http://127.0.0.1:3120/`（带结尾斜杠）**，而原正则 `(:\d+)?$` 要求端口后立刻结束 ⇒ 判成非回环 ⇒ **把自己的麦克风请求也 DENY**（首轮 `loopback=false => DENY (not-mic-or-not-loopback)`、probe 报 `NotAllowedError`）；修法容忍 `/?$`；③ 防回归：判定抽成纯函数 `appstate/.../model/WebPermission.ets`（原先内联在 @Component、**零门禁覆盖**），注册进 `check-layout-fixtures.mjs` 并加 **21 条断言**（含把真机那条带斜杠 origin 原样钉住、前缀伪装 `127.0.0.1.evil.com` 必须拒），门禁 **684→705 断言 0 失败**；④ **负测试三变异全红**（去掉斜杠容忍 6 红 / 放宽回环 3 红 / 不要求"只要麦克风" 1 红），还原后回绿；⑤ 记录环境事实：两个 bundle 都硬编码 `127.0.0.1:3120` ⇒ 互斥，需 `aa force-stop` 旧应用；⑥ 数据安全：全程零卸载，既有 `com.dshm.dshclient` 的 home 元数据与会话 2 个均未变；⑦ 实测确认 `hostcore/profile` 的语音四行在设备上生效（`dsh/home/profiles/ondevice/cordis.patch.yml` 四行均无 `disabled`）|
| v1.33 | 2026-09-26 | **debug 自签测试：本机不可行（详见 `device-validation.md` 批次备注十九）**：① 完整跑通 OpenHarmony 自签流程（`generate-keypair` → 导出 CA → `generate-app-cert`/`generate-profile-cert` → `keytool -importcert` 回写 → `sign-profile` → `sign-app`），产物留 `dist/`；② 踩并定位两个隐蔽坑：**(a)** `generate-app-cert` 只输出链、**不写回 keystore** ⇒ 链 leaf 与 keystore 证书不符，需 `keytool -importcert` 补；**(b)** profile 的 `development-certificate` **必须以换行结尾**，`.trim()` 掉结尾换行会报**完全误导**的 `Illegal base64 character 20`（同一条 profile 只改这一字符即可从失败转成功）；③ 三条独立路径（自造链真包 286MB / `-profileSigned 0` / SDK 官方 `OpenHarmonyProfileDebug` 链）全被设备拒以 **`code:9568257 fail to verify pkcs7 file`**；1KB 真 zip 小包亦复现 ⇒ 该校验**先于**内容校验；④ 用华为 `hms/toolchains/lib/Provisionsigntool.jar verify` 反证：三份 profile（含原始可用的）**全部 `verifiedPassed: true`** ⇒ 问题在**信任锚**而非自洽性——设备信任 **华为 CBG Root CA G2**，自签落到 **OpenHarmony Application Root CA**（测试根）；设备为非可调试版（`hdc smode` 被拒）故无放宽口子；⑤ 结论：**自签在商用设备上不成立**，须用 DevEco 自动签名（华为服务器签发，产物落 `~/.ohos/config/`，正是本机此前丢失、导致签不出包的那四个文件）；⑥ 数据安全：全程只 `install` 到独立 bundle `com.dshm.micverify`、**零卸载**，安装均失败故无残留，已核验既有 `com.dshm.dshclient` 的 `updateTime`/权限数/宿主日志均未受影响 |
| v1.32 | 2026-09-26 | **语音输入可行性调查 + 麦克风授权最小验证（详见 `device-validation.md` 批次备注十八）**：① **本地 SenseVoice 移植判定不可行**（四条硬阻塞：`resolveRuntime` 白名单无 openharmony、`sherpa-onnx-node` 无 ohos 产物且树内 `.node`/`.so` 为 0、模型 int8 239MB/fp32 938MB、录音在 WebView 且应用原**无麦克风权限**）；② **替代路线两条**：HMS `@hms.ai.speechRecognizer`（设备 syscap **已实证**含 `AI.SpeechRecognizer`）与自写 `SpeechProvider` 插件接云端 ASR（`location` 支持 `"cloud"`）；③ **最小验证不能靠界面按钮**——官方 `usable` 要求 provider 就绪（`client.js:4928`），而 SenseVoice 在鸿蒙永不可用 ⇒ 点按钮只弹配置框、**不调 `getUserMedia`**（`:5036`/`:5090`）；改为 `WebApp.ets` 新增 `MIC_PROBE_JS` 自检探针 + 「应用 → 麦克风自检」菜单；④ 声明 `ohos.permission.MICROPHONE`（实测 `user_grant`/`NORMAL`）+ `onPermissionRequest` 只放行回环来源的 `AUDIO_CAPTURE`；⑤ **零风险装机路线**：真机 el2 数据经五条通道实测**无任何备份**（`home` 为 `drwx------`、`hdc smode` 被拒、`run-as` 不存在、`file recv` 被拒、宿主 API 无导出方法）⇒ 放弃 `uninstall -k`，改在 `products[0]` 加 `bundleName: com.dshm.micverify`（实测覆盖生效）以完全绕开既有数据；⑥ **覆盖安装通路与数据保留已实证**（`install -r` 12s 成功，sessionId 2→2、`home` link=8 未重建、exec 7/7）；⑦ 产物核验 11/11（含语音四行 `disabled=0`、`removeBundles=[]`），14 条回归门禁全绿 |
| v1.31 | 2026-09-25 | **外部报告 9 复核 + 用户反馈「自定义 API 保存不了」真因（详见 `device-validation.md` 批次备注十七）**：① 报告 9 四项**早已落地**于 `hostcore/app/`（逐条回代码复核，前提均在本机复现）⇒ 新增 `tools/assert-report9-fixes.mjs`（29 项）；顺带修掉一处**潜伏真 bug**——`entryCandidates` 的 `exports` 字符串分支漏 `return`，令 `{exports:"./b.js"}` 多出 `index.js` 候选；并统一了 `sanitizeDependencies`（要求**所有**候选）与 `userRowLoadable`（**任一**即可）这组**相反的判据** ⇒ `check-user-rows-preflight` 由 `79/5 红` 转 `86/0`（用**改动前的旧快照**跑同一测试证明那 5 项是历史遗留，非本批引入）。② **用户真因不在后端**：真 Host 实测「写入落盘 / 重启存活 / 端点探测 / 逐字段深路径写 / unset」全部成立，问题在**原生设置页没有「添加自定义模型 API」入口**（可添加列表只来自 pi-ai 自带目录，用户自己的中转站路由两个目录里都没有 ⇒ 无处可加）⇒ 原生模型页**对齐官方 Models 页**（`PiAiProviders.ets` 纯逻辑 + `PiAiProviderSheet.ets` 表单；id 正则 / `deriveKeyRef` / 占用检查放客户端 / 空密钥语义 / 协议候选读 schema 均与官方逐字对齐）。③ 新增 4 个门禁（真 Host 全链路 31 项 / 假网关 Bearer+拒 chunked / 60 余条逻辑断言 / 负测试），**14 个门禁 exit=0**。④ **如实记**：设备上走通的是**官方设置入口**（内嵌 dsh Web UI，与本次 ArkTS 改动无关）；本次原生页改动**未上设备**（设备包 `updateTime` 17:38 vs 改动 mtime 20:14，本机缺 `.p12` 签不出包）⇒ 标为**待复核**。⑤ 修正本项目一处过头结论：**标量深路径写可行**，只有数组元素不可按下标寻址。 |
| v1.30 | 2026-09-25 | **鲸鱼"歪"根治（E380，详见 `device-validation.md` 批次备注十四·七）**：真因是 **`Shape.viewPort` 没把路径缩放进组件盒**（`uitest dumpLayout` 权威数据：盒 42×31px，墨迹只占左上角 25×18px，左留白 0 / 右留白 18px）——前几轮都在调 viewBox/尺寸/位置，**没验证"viewPort 到底有没有缩放"这个更基本的前提**。改用**官方 SVG 素材 + `Image.fillColor`**（等比缩放交给图片组件）。附带纠正两个自查错误：① 此前"墨迹溢出官方 viewBox"是拿**贝塞尔控制点**包围盒当墨迹（控制点可落在曲线外；400 点/段采样后真实紧包围盒 = 官方 viewBox，**零溢出**）；② 内联路径曾手抄错 1 位（`12.6435` 应为 `12.643`）⇒ 新增 **`tools/gen-fish-logo.mjs`**（生成式 + 两条自检：包围盒断言、落盘后逐字节一致）。尺寸定稿 **20.4vp**（官方 24vp × 0.85，用户"小 15%"）；另修 §1 卸载残留行（**引号**是真凶）与 §2 语音 bundle（profile 合并**只做并集**导致永久沉积） |
| v1.29 | 2026-09-25 | **报告 8 两项待修（E377–E379，详见 `device-validation.md` 批次备注十四）**：① **`&path:` 卸载残留用户行**（报告 7 修过、报告 8 仍复现）——真凶是**引号**：`composeUserRows` 把 `@scope/name` 回写成 `- id: '@scope/name'`，而删行用裸名精确比较 ⇒ 永不等（上一批只修了"名字来源"，漏了这层）；另加**后缀匹配**兜"包与依赖都已删"的残局（scope 前缀只存在于已删的 manifest 里）。五场景验证含**反向不串味**（E377）。② **语音 bundle 从 profile bundles 移除**——真根因是 `main.js` 的 profile 合并**只做并集、从不移除**（`cur ∪ seed`），任何进过设备 profile 的 bundle 再也去不掉；引入 `dsh.profile.removeBundles` 显式清单，「种子顺序并集 − 移除清单」（E378）。③ **鲸鱼"不随主题"确答在 ArkTS 自绘顶栏**（全量搜索只有 `@Builder FishMark` 一处），根因是读到**非响应式**字段 ⇒ 改它不触发重渲染（E379） |
| v1.28 | 2026-09-25 | **报告 5 三项落实（E374–E376，详见 `device-validation.md` 批次备注十三）**：① **皮肤 `&path:` monorepo 子目录安装**（36/302 个皮肤；`parseGitHub` 先按 `#` 切分把 `&path:` 并进 ref ⇒ codeload HTTP 404）；改为"正则各自摘出 + 解包进子目录取包根"（E374）。② **状态栏跟随「设置→外观」**：web 侧 `THEME_SHIM_JS` 读 `colorScheme` + `matchMedia`/`MutationObserver` 即时回调，ArkTS 侧 `setWindowSystemBarProperties` + 同色 `setWindowBackgroundColor` 消除闪白（E375）。③ **git 子进程类操作解锁**：`run-command.c:525 CHECK_BUG(pthread_setcancelstate)` 在鸿蒙 musl 被判失败 ⇒ abort（rc=134）；用 `libdshm-gitcompat.so` LD_PRELOAD 垫片兜（**透明优先**：真身成功即透传）；随后浮现第二层"`git-core` 141 个 symlink 解不出 ⇒ `git-upload-pack` 缺失"，改为从 apk 现读 symlink 表以真身补齐（E376）。真机新增锚点 **`git-ls-remote=ok`**。**§3.3 新增**：`libdshm-gitcompat.so`（CMake 自建，随 HAP libs 分发） |
| v1.27 | 2026-09-25 | **端侧运行时四项解锁（E368–E373，详见 `device-validation.md` 批次备注十二）**：① **「无法对话」两层根因**——`flock.js` 平台门只认 linux/darwin 而端侧是 `openharmony`（E368）；`dshmPublishExclusive` 两个调用点形参契约不同、其中一处传进的 `internals.fs` **无 access/rename**（E368b）。② **execve 拒绝的正解是签名**——对照实验（物化到同目录同创建者）**否定了**旧假设「执行许可绑创建者」；真分界是 **ELF vs 脚本**；`binary-sign-tool -selfSign 1` **不需要 keystore 密码**，`pack-core` 签 rg、`place-toolchain` 签工具链归档（E369）。③ **「存在即跳过」必须配版本标记**——否则构建期改动（签名）在设备上永不生效；另发现 **HAP 打包丢弃所有 dotfile**（标记不能以点开头）。④ 安装器**用户行加 bundle 门控**（纯库不再写行）、`--dir` 优先、市场 profile 动态注入、异常 handler 合并去噪。**§3.3 新增两项构建期依赖**：宿主 `python3`（`sign-tar-elf.py`）与 `binary-sign-tool.jar`。真机终态：`exec 探测` 六项（python3.12 / git / git-core/git / git-remote-http / rg / bash）**全部 ok** |
| v1.26 | 2026-09-15 | **P5-4 门面字段"读点"成为第 4 条死代码规则（E367）**：`export interface *Facade` 的声明与读者在子组件、实现在宿主 ⇒ 只数"本文件出现几次"的前三条规则**看不见它**。新规则整仓数 `.字段`，搜不到即"通道有、没消费者"。当场命中 2 条真死通道：`TabContentFacade.setConfirmingDeletePath` / `.setSelection`（真值另有写者：两步确认在宿主、模型选择走 `SessionHub.selectSessionModel`）⇒ 残留的重复通道，已删。规则先对**修前的工作树**归真命中 2 处，另配 4 条注入式自检。`Index.ets` 4059 → **4053 行** |
| v1.25 | 2026-09-15 | **P5-3 双栏的「展开侧栏」是死按钮（E366）**：`buildDouble` 调的是 `navRail()`，那份 surface 把侧栏呈现**硬编码**成 `TrackPresentation.RAIL` ⇒ 双栏下点「展开侧栏」什么都不发生（偏好变了、纯函数判定也变了，只有那个绘制侧栏的调用点没问判定），D19 第 2 条在真机上必然失败。删掉 `navRail()`（与 `sidePanelSurface` 逐字段相同、只差呈现的手抄版），双栏改调 `navPanel()`。`check-feature-wiring` 新增**反面规则**（`AppShell.ets` 不许出现 `TrackPresentation.RAIL`，先剥注释再匹配），并**对修前的 `HEAD` 版本归真命中 `AppShell.ets:228`** —— 正面计数拦不住"多了一个不该有的东西"。`AppShell` 420 → **397 行** |
| v1.24 | 2026-09-15 | **P5-2 侧栏轨道的几何跟随实际呈现（E365）**：P2-15 让侧栏能收起，但只改了*呈现* ——轨道宽度仍按**形态默认**算 ⇒ 三栏收起后照样占 240vp（"腾出宽度"没发生）、双栏收起后是 240vp 轨道里放 56vp rail。新增纯函数 `sidebarTrackWidthOf(mode, stored)`（panel 240 / rail 56 / 浮层 0），`SidebarShell` 的 rail 宽度改用 `Sz.NAV_RAIL`并删掉 `navWidthVp` prop 与门面字段；`sidebarExpandedOf(stored)` → **`sidebarExpandedForMode(mode, stored)`**（"没存过"必须按形态给默认，否则双栏首启被读成展开、与 `shellTracksOf(DOUBLE).sidebar = RAIL` 矛盾）；偏好搬出 `NavigationState`（删 `sidebarExpanded` / `setSidebarExpanded`，真值只剩页面里那份原始 `boolean \| undefined`）；删 `sidebarOccupiesLayout`（与"宽度 > 0"同一个问题、且只有 fixture 在用）。fixture 595 → **601**；真机判据补进 D19 |
| v1.23 | 2026-09-15 | **P5-1 核心页投影搬进 appstate（E364）**：`pluginInventoryFact` / `corePluginRows` 是**纯投影**（宿主报告 → 事实与行），却住在 `Index.ets` 里。搬迁时撞上 ArkTS **禁止结构化类型**（`HostPluginReport` 与同形状接口不可互赋，两处调用点报红）⇒ 接口降级为"参数分组"、调用点逐字段取值（`appstate` 不反向依赖 `hostruntime`）。新增 `CoreProjection.ets`（0 UI 依赖）：`pluginInventoryFact` / `pluginRowOf` / `rankPluginRows`（只排序不隐藏，且返回新数组）。fixture 577 → **595**；设计令牌棘轮 23/9 → **21/8**；`Index.ets` 4061 → **4027 行** |
| v1.22 | 2026-09-15 | **P2-17 侧栏收起状态落盘（E363）**：照抄详情栏宽度记忆那一套（`LocalPrefs` + 启动读回 + 变更落盘），并处理三态 —— `KEY_SIDEBAR_EXPANDED` 存 `'true'`/`'false'` 字符串、缺失即 `undefined`（否则"从没设置过"会被读成"收起"，用户第一次启动只看到一条 rail）；默认值放纯模型 `sidebarExpandedOf`（fixture +3 → **577**）。落盘失败**不弹提示**（与宽度记忆**有意不同**：没有信息损失）|
| v1.21 | 2026-09-15 | **P2-16 「新建会话」补到 rail 与底部标签（E362）**：该一级入口此前只在 `panelBody`（PANEL 呈现）里⇒ 三栏收起侧栏、或单栏走底部标签时**都开不了新会话**（只能靠空态按钮或 Ctrl+N）。rail 里排在「展开侧栏」下面、底部标签排第一位（都用本仓已在用的 `plus_circle`）；`onNewSession()` 调用点 1 → **3 处**，并修正组件头部那句"只在品牌行下方"的口径 |
| v1.20 | 2026-09-15 | **P2-15 侧栏可收起（E361）**：`NavigationState.sidebarExpanded` 长期无控制点 ⇒ 官方「收起侧栏腾出宽度」在本仓**做不到**（功能缺口，非字段冗余）；新增纯函数 `sidebarPresentationOf(mode, expanded)`（单栏一律浮层；双栏默认 rail、可展开；三栏默认 panel、可收起），品牌行加「收起」、rail 顶部加「展开」（**双向门**）。fixture 567 → **574**；功能接线门禁 17 → **18** |
| v1.19 | 2026-09-15 | **P2-14 删掉"只有 fixture 在用"的浮层状态机（E360）**：`NavigationState.activeOverlay` / `Overlay` / `openOverlay` / `closeOverlay` 在 `entry` 侧 **0 引用**（真实浮层优先级由 `Index.overlayState()` 从六个布尔派生），而 fixture 里有 3 条断言**只测它自己**（自证循环）。已删除；fixture 570 → **567**（少的是自证断言，不是回归）。同清单里 `sidebarExpanded` 是下一个同类候选（**需先定产品语义**，登记未动）|
| v1.18 | 2026-09-15 | **P2-13 单栏 Sheet 的右栏切换器（E359）**：切换器此前只画在 `framedBody`，单栏详情 Sheet（`sheetBody`）没有它 ⇒ **手机用户根本切不到别的右栏面板**（功能不可达级别）。抽成共用 `@Builder panelSwitcher()` 两处都调；顺手换掉那句对文件/预览/详情**措辞是错的**固定提示。P3 的另两个缺口（滑入动画 / 拖拽调宽）仍留待真机。`RightbarShell` 444 → 461 行 |
| v1.17 | 2026-09-15 | **P2-12 第二步：门面接线（E358）**：`RightbarShell` 的 12 个内容 props 收成 `f: RightbarFacade`（组件内 39 处用法改 `this.f.X`）；`AppShellFacade` 的 11 个 `right*` 成员全删；两处挂载点都调`Index.buildRightbarFacade()`（浮层此前是内联重算）。`Index.ets` 4019 → 4026（**+7，收益在"只有一个真值"而不在行数**） |
| v1.16 | 2026-09-15 | **P2-12 第一步：右侧内容门面定义（E357）** —— 拆 `detailSheet` 时发现真问题不是那 36 行，而是 `RightbarShell` 的**两个挂载点各自拼 16 个 props**（真右栏经 `AppShellFacade`、详情浮层在页面根内联重算）⇒ 迟早不同步。本轮只做 `export interface RightbarFacade`（12 个共有成员），**接线留到下一轮**。行数不变（4019）；记录 ArkTS `arkts-no-misplaced-imports` 与类型重复导入两个坑 |
| v1.15 | 2026-09-15 | **P2-11 凭据浮层 + 选项浮层（E356）**：`CredentialSheet`（127 行）/ `ChoiceSheet`（99 行）成组件；`sheetContent` 的六个分支现在各是一句组件调用。`Index.ets` **4133 → 4019 行**（P2-9…P2-11 四刀合计 4480 → 4019）。死代码门禁连续抓出搬迁残留的四批导入 |
| v1.14 | 2026-09-15 | **P2-10 两个设置编辑浮层（E355）**：`SettingTextSheet`（131 行）/ `SettingStructSheet`（142 行）成组件，输入提示进零依赖的 `model/SettingEditors.ets`（fixture +12 → **570 条**）；两处重复的"当前值占位"合并为 `placeholderOf`。`Index.ets` **4297 → 4133 行**（P2-9/P2-10 合计 4480 → 4133） |
| v1.13 | 2026-09-15 | **P2-9 `Index.ets` 第一刀（E354）**：沙箱文件夹选择器拆成 `view/FolderPicker.ets`（297 行，4 状态 + 6 方法 + 1 段 UI），`Index.ets` **4480 → 4297 行**；打开它的两个入口用**控制器对象**（与 `TurnViewController` 同源），且控制器上必须有 `close()` —— 原生 Sheet 关闭路径不经过组件 |
| v1.12 | 2026-09-15 | **P2-8 三个浮层共用结果出口（E353）**：凭据 / 文本设置 / 结构设置三个浮层共用 `credentialNote` 与 `credentialBusy` ⇒ **串浮层**（凭据的失败文案出现在文本编辑浮层里）与**跨浮层置忙**。修法：回执带归属（`sheetNoteOwner`，判定在零依赖的 `model/Sheets.ets`）+ 每个浮层自己的 busy；fixture 547 → **558 条**。原计划的"拆 960 行浮层"留到下一轮（修完缺陷后是零风险搬家） |
| v1.11 | 2026-09-15 | **P2-7 会话头上下文行（E352）**：补官方 `conversation.header` 的 **Workspace context / Model / 最近活动** 三项（规则在零依赖的 `model/SessionContext.ets`，fixture +14 → **547 条**）；Agent preset / Schedule / Open in App 三项**如实不做**（缺"当前会话的预设名"与协议面），留在 §6 缺口台账 |
| v1.10 | 2026-09-15 | **P2-6 第二刀：`TurnView`（E351）** —— "一个回合怎么画"整块搬出（492 行），展开集合留在子组件而按钮在父组件 ⇒ 引入**控制器对象**（与 ArkUI `Scroller` 同源）；思考块抽 `ReasoningRow` 供轨迹视图与过程分组**共用**；轨迹视图另留条目级 `flatItem` 分派（**共享卡片、不共享分派**）。`ConversationPane` 1087 → **984 行**（P2-4…P2-6 合计 1414 → 984）。死代码门禁当轮抓出 2 处搬迁残留 |
| v1.9 | 2026-09-15 | **死代码门禁 `check-dead-code.mjs`（E350）**：把"搬迁留下的壳"（零使用 import / `@Builder` / 组件成员）变成第 9 道门禁——前两轮三次手工扫出的同类缺陷（E345/E346/E346b）从此自动拦。门禁本身立刻查出 3 处真死代码（`MessageFeedback.itemId` / `MessageRow.menuHint` / `SettingsPane.settingRow`）并连带清掉级联死代码；含 9 条注入式自检 + 对修前 `SettingsPane` 归真命中 5 处 |
| v1.8 | 2026-09-15 | **P2-5 会话头抽成 `ConversationHeader`（E349）**：视图切换 / 轨迹工具栏 / 后台任务条 / 时间总览 / 会话内搜索条四块 chrome 整块搬出（284 行），`ConversationPane` 1234 → **1093 行**；`stats` 改为必需 prop（不造"全 0 默认统计"）。记录该类脚本化编辑的**第五次事故与三条硬规则**（不混用整块替换与局部再改 / 编辑后先 grep 锚点 / 报错里出现自己的占位符先怀疑文件被改坏） |
| v1.7 | 2026-09-15 | **P2-4 消息行抽成 `MessageRow`（E348）**：会话正文组件里"一行的事"（悬停 / 长按与右键同一个菜单 / 行内动作条 / 反馈表单 / 输入策略三判定）整块搬出（221 行），`ConversationPane` 1414 → **1234 行**；顺带删掉视图层与模型 `formatClock` 重复的 `clockOf`。记录该类脚本化搬迁的**第四次事故与处置**（结束锚用了块内也出现的字符串 ⇒ 多删 4 个成员，按花括号配平从备份取回） |
| v1.6 | 2026-09-15 | **P4-6 设置域收口 + 回执按域归属（E347）**：核心段拆成 `SettingsCore`（78 行）；写入回执带归属域（`settingsWriteDomain`），并修掉「7 个工作区/会话函数把回执写进设置通道 ⇒ 用户看不到」这个真缺陷；域判定搬进零依赖的 `model/SettingsDomains.ets` ⇒ fixture 514 → **533 条**。`SettingsPane` **500 行**（1890 → 500） |
| v1.5 | 2026-09-15 | **P4-5 设置域收口**：技能段 / 预设段拆成 `SettingsSkills`（95 行）/ `SettingsPresets`（271 行），`SettingsPane` 758 → **497 行**（P4-1…P4-5 合计 1890 → 497）；同时清掉 **16 个零消费者成员**（搬迁后宿主那段唯一的读者、已住进域组件的临时态、以及 `settingsStates` 这条从 `HubSnapshot` 到 `SettingsPane.states` 的**死链**）。据此校准 §3.1 基线（feature-wiring 111 文件） |
| v1.4 | 2026-09-15 | **真机崩溃修复（E343）**：Mate 70 Pro+ 冷启后点一下界面即 `RangeError: Stack overflow!` 被杀进程——根因是 `MainShell.mainContent` 的兜底分支 `else { this.mainContent(this.compact) }`（自递归）。修复=兜底改为渲染 `TabContentView({ f: this.f.tabFacade })`（主区剩下的工作区/核心/设置三类面板本来归它）；新增门禁 `tools/check-builder-recursion.mjs`（剥注释扫 `this.<自己>(`，5 条注入式自检 + **对修前提交归真命中**）；`check-feature-wiring` 16 → **17 个功能**（新增「主区兜底」）。据此校准 §3.1 基线（arch-check 75 文件 / feature-wiring 109 文件 & 17 功能） |
| v1.3 | 2026-09-14 | **`entry`（UI 层）获得真编译验证**：定位并修复「仓库缺一个从未入库的源码文件」事故（`.gitignore` 裸 `runtime/` 规则吞掉模块源码目录，commit `ff6cbc9` + `b906e13`）⇒ `default@CompileArkTS` BUILD SUCCESSFUL（0 error / 32 warn），全量 `devecocli build` 打通到 `PackageHap`（产出 138 MB unsigned HAP，含两 ABI 的 `libdshhost.so`），只剩签名（证书在 Windows 那台机器上）。新增 **§3.3 不入库产物清单**（源码 vs 产物分开讲，避免把"缺源码"误判成"缺产物"）；记录两处新能力：UI 层单模块快编命令、`PackageHap` 可跑 |
| v1.2 | 2026-09-14 | **P1 第一刀：`LayoutController` 落地**（`appstate/ui/LayoutController.ets`，形态/几何决策与让步链的唯一落点，被真编译器验证）+ **`tools/check-layout-fixtures.mjs`**（纯逻辑按 TS 编译后本机执行，四形态/边界/让步链 28 条断言，含自检与真实注入验证）。据此更新 `layout` 行与缺口；**新增硬事实**：`entry` 不只是没有编译器——**codelinter 检不出语法错误**（注入实测），故 `entry/src/main/ets/**` 目前**零自动验证**，已写进 §3 |
| v1.1 | 2026-09-14 | **工具链就位后校准 §3**：HAR 模块可真编译（BUILD SUCCESSFUL）、codelinter 全量可跑且**覆盖面经注入测试证明**、`check compat` 确认 Linux 永不支持、`entry` 因原生构建无编译验证。新增 §3.2 编译器首批发现——其中 `READ_PASTEBOARD` 缺失是**真实缺口**，据此把 `dshm-clipboard` 由 `DONE` 降为 `PARTIAL`（编译器纠正了本矩阵）。补记 Linux 构建会重写 5 个 lock 文件行尾的环境坑 |
| v1.0 | 2026-09-14 | 首版：建立四形态口径（更正 PC 与 2-in-1 同为 `deviceType=2in1`）、状态口径与两轴规则、46 行对等矩阵、缺口登记、来源与版本标注、门禁 `check-parity.mjs`、附 A `Index.ets` 拆分基线 |
