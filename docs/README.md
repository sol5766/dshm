# 文档索引

本目录是 **DSHM**（DeepSeek Harness 鸿蒙客户端）项目的文档基线。开发任务书（D1）是范围、架构与验收的唯一权威；其余文档是其展开或配套。

> **本项目的性质是「移植」**：把官方面向桌面的 dsh 运行时搬到 OpenHarmony arm64 上自足运行。
> 因此除了下表的契约/规范类文档，还有一份**按技术主题**整理的踩坑总览
> ——[`70-鸿蒙移植踩坑与修复总览.md`](70-鸿蒙移植踩坑与修复总览.md)（**D8**）。
- `80-真机更新与数据保全.md` —— 真机更新流程与**数据保全**：覆盖安装为何不丢 el2 数据、数据指纹判据、以及签名物料（`~/.ohos`）误删后的取回/重拼（`AGENTS.md` 签名章节引用）。
> **新接手的人先读 D9 + D6**（D9 = 端到端实现全流程；D8 = 按主题的坑库，查具体坑时用）。

## 基线文档

| # | 文档 | 作用 | 何时必读 |
|---|---|---|---|
| D1 | [`00-开发任务书.md`](00-开发任务书.md) | **开发任务书**：背景与对标、目标与原则、架构（含设备接入与安全分级）、功能需求、POC 门、里程碑、验收体系、风险与待决事项。**注意：其"远程客户端"定位已于 2026-09-12 更正，冲突处以 D6 为准** | 开工前；每次范围/架构/验收变更时 |
| **D6** | [`50-端侧核心运行架构.md`](50-端侧核心运行架构.md) | **端侧核心运行架构（目标与架构的权威更正）**：为什么改、目标架构、可行性证据、Node 运行时获取路线与回退、JIT 决策（不申请特殊权限）、端侧 profile 策略、核心版本激活事务与插件管理、新指标与新里程碑 | **先读这篇**；动手前、评审目标时、运行时路线变更时 |
| D7 | [`60-界面重塑-端侧核心.md`](60-界面重塑-端侧核心.md) | **界面重塑规范（部分已被取代）**：新一级导航（新增「核心」）、核心页四分区规格、首次启动流程、「去掉无用功能」清单与去向、落点与进度、界面纪律。**⚠️ 导航部分已过时**：目标随后演进为"删掉待决和会话、合并到工作区"「核心并入设置」，现行结构以 **D6 的 E108/E110/E114** 为准 | 做任何界面改动前；评审 UI 时 |
| D2 | [`10-协议兼容事实基线.md`](10-协议兼容事实基线.md) | **协议事实**：载体与端点、认证与信任栅栏、连接生命周期、备选 SDK 协议、探测工具要求；**§8 附录含实测矩阵**（§8.7 = 0.1.5-rc.1 实测与本仓库缺陷修正） | 写任何协议相关代码前；Host 版本变化时 |
| D2b | [`11-请求载荷契约.md`](11-请求载荷契约.md) | **载荷契约**：84 个端点的请求内层字段与回复结构、6 条事件流逐项结构、审批/提问应答编码、未确认清单（每行带上游源码出处） | 构造任何 RPC 调用前；接线状态层时 |
| D3 | [`20-产品需求与体验规范.md`](20-产品需求与体验规范.md) | **体验规范**：信息架构、三形态导航与让步链、界面规格、状态文案、快捷键手势、通知规范、无障碍、视觉主题、性能体感 | 做任何 UI 前 |
| D3b | [`12-设置页契约.md`](12-设置页契约.md) | **设置页契约**：`settings/describe` 实测回复结构、**schemastery 序列化 schema 的扁平表格式**、三层取值（默认/基线/用户层）、`revision` 并发令牌、14 个命名空间的字段摘要、落地计划 | 接线设置页或凭据写路径前 |
| D4 | [`30-技术验证清单.md`](30-技术验证清单.md) | **POC 清单**：POC-1~11 的目标/步骤/判定/失败处置/产出/回写；**界面完成度对照表**与「仍待真机」清单 | 每个 POC 开始前；POC 结论落地时；验收前 |
| D5 | [`40-上游升级手册.md`](40-上游升级手册.md) | **上游升级流程**：分层前提与评审检查表、五步升级、漂移门禁、降级策略、版本矩阵、**已执行的升级记录（§4.1）**、门禁自我验证纪律 | 每次升级 DSH 上游前；评审架构时 |
| **P0** | [`parity-matrix.md`](parity-matrix.md) | **功能对等矩阵**：官方 39 个能力面 id + 11 个端侧独有行的逐行台账（状态层 / 界面 / 协议 / 四形态 / 状态）、**五条防注水不变式**、缺口登记、`Index.ets` 拆分基线（附 A）。由 `tools/check-parity.mjs` 强制 | 做任何多端/界面工作前；判断"还差什么"时；每次改动后 |
| H1 | [`../hostkit/README.md`](../hostkit/README.md) | **hostkit（PC 侧搭桥服务，可选路径）**：用途与快速开始、隧道线协议表、L1/L2 威胁模型（保护什么 / 不保护什么）、与任务书的逐条偏差与未验证项。**⚠️ 它不是本项目的必要组成部分**：端侧自足运行后，连 PC 侧 Host 只是"可选远端"，客户端仍支持（`ConnectPane`） | 使用、评审或修改 `hostkit/` 前 |
| **D8** | [`70-鸿蒙移植踩坑与修复总览.md`](70-鸿蒙移植踩坑与修复总览.md) | **鸿蒙移植踩坑与修复总览（按主题横向组织）**：把 D6 的 E1–E380 与 `device-validation.md` 十四个批次里的**每一个坑**，按**技术主题**重新归类（平台与进程模型 / hmfs 文件系统 / 打包与资源 / dsh 上游集成 / 工具链 / 构建期工具链与 Windows / ArkTS 与 UI / **工程方法与流程**）。开篇先讲两条根本约束（`jitless ⇒ 无 WASM`、**execve 受签名域管辖**），后面所有坑都是它们的推论。**新接手者先读这篇** | 接手移植工作前；遇到"端侧行为异常"时先在这里搜；写新平台适配前 |
| **H2** | [`HANDOFF.md`](HANDOFF.md) | **交接说明**：一句话现状、**Windows 端 dsh desktop 重装步骤（含必须保住的数据与为什么不能直接覆盖安装）**、鸿蒙侧工程结构与门禁、**未完成事项（连接抖动机制与修法、启动 40s 自杀嫌疑链、GitCode 推送、待拍板项）**、已完成清单、十条教训。**新接手者先读这篇** | 接手任何工作时；装机/重装前；问"还剩什么"时 |
| **R1** | [`review-report-2026-09-29.md`](review-report-2026-09-29.md) | **最终审核报告（对齐官方 dsh `0.2.0-rc.2`）**：7 路对抗性审查。**两个数字都对，含义不同** —— 原始 7 路汇总 **85 条**（阻断 2 / 高 25 / 中 38 / 低 20，§0 第一列），**逐条可核落盘 63 条**（阻断 0 / 高 19 / 中 31 / 低 13，§0 第二列）；差额全部落在首次并行跑时**被工具截断丢失的路5/路6/路7 条目**上，那 2 条阻断在重跑与人工复核下**均未复现 ⇒ 已撤回**（§1、§8 第 1 条）。逐条带 `文件:行号`+证据+建议；含**通路事实**（生产入口走 WebView ⇒ 原生 UI 层问题当前休眠）、方法学备注、未验证项。**只审不改**，优先级待定。**另有 §10 = 第二轮审核（2026-09-30）**：换切法（按「官方对照面」而非工作分层），落 **33 条**（高 9 / 中 24），与第一轮**条目集合不同、不是重跑**；两轮数字**各自成口径**，不合并 | 需要知道"还差什么、哪里有坑"时；决定修复优先级前。七路提示词见 [`review-prompts.md`](review-prompts.md) |
| **D9** | [`90-DSH鸿蒙原生实现全流程.md`](90-DSH鸿蒙原生实现全流程.md) | **端到端实现全流程（本文档的最新一份）**：六章串联"总览与两个根本约束 → 构建流水线 → 端侧运行时 → 界面与语音 → 验收运维与踩坑总表 → 门禁与工程纪律"。与 D8 的分工：**D8 是"按主题的坑库"，D9 是"按流程的实操手册"**（D9 第五章给四段式速查并指向 D8 深挖）。**新接手者：D9 + D6 先读** | 接手任何工作前；需要"端到端怎么做"时 |

## 最新一轮的收尾档（2026-10-05 起，编号 95–116）

上表是按角色组织的**契约/规范**索引；下面几篇是同一轮排障与审计留下的**台账/调研/根因**档，
不含契约，但排查同类问题时判据最全：

| # | 文档 | 作用 |
|---|---|---|
| D10 | [`95-issue台账与开源后审计.md`](95-issue台账与开源后审计.md) | **开源后改动审计与 issue 台账**：上游 issue 逐条状态、历次修复要求、门禁普查读数、侧边栏预览事故的根因与遗留、`DSHM_DOC_LOAD_DEDUP` 撤除登记（§11）、行号漂移重算登记（§11.4）与 `coreVersion` 命名口径（§11.5） |
| D11 | [`96-侧边栏预览竞品调研与落地方案.md`](96-侧边栏预览竞品调研与落地方案.md) | **侧边栏预览的鸿蒙竞品调研**（WorkBuddy / 千问办公 / Qoder 同源 Electron 壳）与 R1–R6 借鉴矩阵、落地方案 A/B/C |
| D12 | [`97-readBytes空响应根因与修复.md`](97-readBytes空响应根因与修复.md) | **`workspaceFiles/readBytes` 空响应根因与修复**：宿主 undici 垫片 `DshmResponse` 不认 `new Response(FormData)`（决定性证据 = ArkWeb `ERR_EMPTY_RESPONSE(-324)` 而非 `ERR_ABORTED`）、修复、真机闭环与 4 条教训 |
- `98-收尾审核与修复（托盘回归·垫片字节·自检扩围）.md` —— 独立审核查出的 5 个真问题（托盘 `install()` 幂等回归 / 恒无效兜底 / 死代码与反注释 / `fetch-shim` 响应方向字节对称并改大声失败 / 撤除守卫自检 M10）、7 条后续待办与 2 条已定裁决。
- `99-右上角三键不可见：顶栏底色与三键配色的接线漏了一处.md` —— 用户报"右上角三键消失、只剩关闭"的真根因（顶栏底色两条通道、三键配色只挂在兜底那条）、最小修法、像素级修复前后判据，以及新增的接线门禁。
- `100-v1.1.0发布说明（2026-09-30 至 10-05）.md` —— v1.1.0 的发布正文：9/30→10/5 共 71 个提交按主题归类（侧栏预览系统性修复 / 托盘三条需求与幂等回归 / 右上角三键不可见 / 核心树与端侧补丁门禁 / 宿主可诊断性 / 门禁与 CI / 文档治理），逐条附提交号。
- `101-托盘退出残留与插件市场重启横幅的根因与修复.md` —— 用户两个报障的根因与修复：① 市场横幅「1 项变更需重启」= home 层 skin 互斥块把 bundle 层同一 id 覆盖成 `disabled: true`，而市场 `verifyActivation()` 只看 `loaderLive || inBundles`、从不读 home 层 ⇒ 永远判 `restart`（修法：该行改回 `disabled: false`）；② 托盘图标退出后残留 = 三条叠加（`markUnavailable` 早退 / `remove` 排在停核心之后 / 系统退出不走 `exitApp`）+ 第四处隐病（残留 `host-stop-request` 让下一次启动自杀）。含 `onPrepareToTerminate` 的 SDK 判据、真机读数与「怎么复现托盘菜单」。

- `102-手持形态朝向跟随屏幕旋转.md` —— 手机/平板朝向定案：竖屏 427 vp 放不下官方 Web 界面的两栏「设置」（真机 dump：对话框右缘顶到 1280 px 屏边），横屏 ≈944 vp 才进双栏 ⇒ 用 `window.Orientation.AUTO_ROTATION_RESTRICTED`（四向传感器跟随 + **受**系统旋转锁定管辖：锁定不转、解锁才转）**跟随屏幕旋转**，而不是钉死横屏；含 5 / 7 / 8 / 12 / 2 五个候选的 SDK 原文对照、分层落点（platform 机制 + entry 装配，2in1 不动）、真机横屏读数与四页签截图，以及顺带归档的手机档 exec 边界读数（`ash=denied` / busybox `EACCES` ⇒ 终端与 rg/git/python 在手机档不可用）。
- `103-手持档工作区路径采纳判据.md` —— 手机/平板上「添加工作区」选中了宿主读不到的目录：同一条路径上 ArkTS 侧探写（`fileIo` create+write+unlink）**通过**，宿主侧 `workspaceFiles/list` 却 `cannot list … permission denied`（`fileIo` 对沙箱外路径走 `file_access_service` 代理、认 picker 的 URI 授权；宿主是 `node:fs` 裸 syscall、不认）⇒ 旧判据把两件事当成一件，坏路径被采纳并持久化成会话默认工作区，文件页在每个新会话里必失败。改法（**⚠️ 2026-10-06 更正**：真正缺的是「跨启动把已持久化的授权启用回来」，见 `105`；本条判据会在同一进程内把好路径也改掉，属误伤）：手持档（phone / tablet）只接受落在「宿主自己验过的目录」（启动期 `claimPublicDownloadFolder()` 跑过 create+write+unlink 的那一个）之内的路径；2in1 / PC 那一支**逐字不动**（`handheld === false` 时不新增任何动作，形态读不到也退回旧行为）。含两条对立的真机原始读数、`diag-resolve-dispatched` 与 `dshm-host.log` 取证，以及未做项（既有坏登记属用户数据，不删）。
- `104-手机档终端与bash能力判据.md` —— 手机/平板「bash 是不是无解」的判决与取证：新增 `probeShellCapability()` 六条读数（宿主域 `o:r:debug_hap`；`toybox` 自己跑起来**仍是 app 域** ⇒ execve 不做域转换；`toybox stat/exec /system/bin/sh` = `Permission denied`；`toybox env <随包 ash>` = `Permission denied`；HAP `libs/arm64` 里的 ELF 直执 = `EACCES`），配 MAC 标签表（`sh_exec` / `toybox_exec` / `debug_hap_data_file`）与 149 个 toybox applet 清单（**无 sh/bash/ash**，无 awk/tr/diff/curl）⇒ 结论：真 shell **无解**、真命令**有解**（两条独立 boot 读数逐字相同）；并记录 `probeExec` 把 `toybox sh` 记成 `ok` 的读数陷阱（真相在 stderr），以及顺带修掉的 `update-device.ps1` 第 8 步「假绿」（跨 boot 追加的日志 + `tail -1` / `grep -c … -gt 0` 恒真 ⇒ 改成计数器增量基线与轮询启动；附 `grep -c '--- …'` 需带 `-e` 的坑）。
- `105-手持档工作区目录授权的持久化与跨启动恢复.md` —— 手机/平板上系统 picker 给的目录授权**只活一个进程**：选完当场宿主读得到、进程一重启就 `cannot list … permission denied`（同一条路径、两个时刻的对立读数：12:50 同进程内建了 3 个文件，15:36 冷启动后同一条调用被拒）⇒ 根因是只做了 `persistPermission()`（把授权记下来）而没做 `activatePermission()`（重启后启用回来）。修法三件：① `platform/src/main/ets/system/FolderGrants.ets` 登记 + `checkPersistentPermission()` 查证；② 启动期 `restoreFolderGrants()` 逐个启用；③ 手持档采纳判据改为「按包名归属的公共目录内 **或** 持久授权已确认生效」⇒ **采纳用户选的路径**（不再回落应用目录）。含与 `103` 的对照更正表、真机闭环读数（重启后 `restore 1/1 已启用` → 宿主列出 4 项 → 文件页与预览正常）与未做项。

- `106-两份端侧自检报告的分诊与探针读数机器可读化.md` —— PC 端 r4 与手机端 dshmarket 两份**仓库外**自检报告的分诊台账：逐条裁定里**绝大多数不是缺陷**
  （`GET /api/changes.summary` 404 是上游**设计** —— 核心树原文「404 once the Host no longer serves it」+ `dsh-workspace-changes` README 的「a card whose content the Host can no longer open is not shown」；
  超长 LOOP-GAP 是平台 appfreeze（报告方自己在 §3.2 纠正了上一轮的"statSync 风暴"定性）；`read_image` 是模型 `deepseek-v4.1-flash` 未声明图像输入）。
  本端落实三件：① 探针读数（exec / 终端 / python 桥）从"只在 `dshm-host.log`"变成 `host-ready.json` 的 `runtime.*` 机器可读字段（含 pid 守卫、`tmp`+`rename` 原子替换、先暂存后补写三条理由）；
  ② 三份内置技能改"档位口径"（`ohos-pc` 补适用范围、`ohos-shell` 展开三档并点明"手机档没有真 shell 进程但有真 userland 命令"、`ohos-python` 按档位）；
  ③ Python「命令 ≠ 运行时」的裁定（手机 / 平板档 `python3`/`pip3` 命令起不来 —— 垫片解释器 `/system/bin/sh` 被拒；但内嵌 CPython 运行时与档位无关）。
  另记明本轮**不升 `coreVersion`** 的理由（改的是 HAP 的 resfile，不在核心树里）与四项未做项（上游 `provisionHint` / `packageManager` 契约 / `bin/pnpm` 能力声明 / 核心树性能）。
- `107-手机档插件市场的进程内包管理通道（desktopProfiles-desktopPnpm宿主桥）.md` —— 用户报「pnpm 自动配置依旧是失败的」的根因与修复：市场把「探针 pnpm / 装 pnpm / 跑插件安装」**全实现成 spawn**（`dsh-cli.js:705` 探针、`:742-783` provision、`:980` 默认运行时），而手机档沙箱**拒绝一切随包可执行文件的 execve**（`docs/104`）⇒ 那条链的每一步都不可能成功，横幅只是最先暴露的一格（`POST /dsh-market/setup-pnpm` 是 **200**，失败写在响应体里，看状态码会误判成没事）。修法不动 spawn（无解），而是接**上游明文契约**：宿主发布 `desktopProfiles` + `desktopPnpm` 后，市场改用 `createDesktopPluginRuntime()`（其中 `probePnpm`/`provisionPnpm` 是常量真 ⇒ 「自动配置」这一步根本不发生）。本端落地四件：① 新增自带插件 `hostcore/plugins/dshm-market-bridge/`（纯 JS、不 spawn，把 `add`/`remove` 映射到既有的 `$DSH_HOME/install-queue` 通道，其余命令如实 127）；② `pack-core` 新增 `patchMarketDesktopRuntime()`，把两个 `provide` 注入 `profile-boot-*.js` 的 boot 回调（**与 `provide(profileContext)` 同一时机**，满足"Loader 条目挂载之前"）；③ `coreVersion` `+dshm.6` → **`+dshm.7`**；④ 新增离线门禁 `tools/check-market-bridge.mjs`（44 断言）并把核心树门禁扩到 **20 处注入**（含 M11 变异）。含两个实现坑（轮询定时器不能 `unref`、主体必须 `setImmediate` 延后）与三项未做项。

- `108-PC沙箱自检落实与API23向下兼容实证（glob静默失败·errno可读化·fill遮蔽·调试profile设备绑定）.md` —— PC 端沙箱自检报告（**仓库外** `dshm-sandbox-fix-plan.md`，197 行）的逐条落实 + API 23 向下兼容实证。① 三个标准个人目录（`Documents`/`Desktop`/`Download` 本体）在 node 侧 `EPERM`，**真正的门是签名 profile 的 `allowed-acls`**（实读 `apl=normal`、`app-feature=hos_normal_app`、ACL **恰好 5 条**、`debug-info.device-ids` **4 个 UDID 的设备绑定**）而不是"`system_basic` 申请不了"——本包正是靠 ACL 白名单用上了 `READ_WRITE_USER_FILE`/`CUSTOM_SANDBOX`/`ACCESS_USER_FULL_DISK`；② 三条 `*_DIRECTORY` 权限的逐字段证据（`DOWNLOAD`/`DOCUMENTS` 是 `user_grant`+normal、`DESKTOP` 是 `user_grant`+**system_basic**）与本仓 `module.json5` **未声明**它们（`requestPermissions` 恰 11 项，与作者成品包逐项一致）；③ **P1-1 静默失败**的根因是「**exit 1 同时代表『真的没有』和『没读进去』**」——权限拒绝是**遍历期**错误，rg/find 打到 stderr 后仍以 exit 1 收场 ⇒ 落进 `noMatches` ⇒ `No files found` / `No matches found`；修法新增 `accessibilityDenial()`，只在「**空结果** ∧ stderr 命中访问类关键词」时升级为 `SEARCH_FAILED`（只看 stderr 会把已经拿到的 315 条一起丢掉）；④ **P1-2** 落盘裸 errno（`EPERM: operation not permitted, open '….partial'`）按 `error.code` 归三档且**只改写 message**（code/errno/stack 原样留 ⇒ 调用方分派不变；按数字 `errno` 判会漂移——node 在 Linux/鸿蒙上记的是**负数**，报告里的 `EPERM(1)` 是正的 C errno）；⑤ **P2** `ohos-workspace` 技能补完整受限集合（含 `.Trash`/`.Recent`/`appdata`）与可写正例清单；⑥ **API 23 向下兼容在编译期成立**：`compatibleSdkVersion 6.1.1(24) → 6.1.0(23)` 后 **0 ERROR**，代码侧只差 **6 处 `fill`**（`CircleAttribute.fill(value: ResourceColor|ColorMetrics)` 是 `@since 26` 的**重载遮蔽**，它盖掉了基类 `@since 11` 的那个）⇒ 改成视觉等价的 `Row().width(Sp.S).height(Sp.S).backgroundColor(c).borderRadius(Radius.S)`（`Sp.S=Radius.S=8` ⇒ 正圆），产物实读 `minAPIVersion=60100023` / `targetAPIVersion=60101024` / `compileSdkVersion=26.0.0.32`。`coreVersion` `+dshm.7` → **`+dshm.8`**（走既有 pristine 可重入重打，未删树）；门禁 `assert-fs-search-fallback` **73 断言**、全套 **21/21 绿**。另记：P0-2「选择器探写前移」核实为**PC 档已在位**（报告读数基于已装版本）、两条已知覆盖缺口（P1-2/P2 无专测），以及「6.1 设备装不上」的三个候选原因（`minAPIVersion` 已消 / **profile 设备绑定** / 其它措辞）——第二个**改编译参数不可能修好**，必须回到 DevEco/AGC 重签。

- `109-沙箱复测两个P1缺口的落实（move-publish裸EPERM·read-remove-edit权限判据）.md` —— 用户提供的**仓库外**复测报告（R1 `dshm-sandbox-retest.md` + R3 `dshm-sandbox-retest-r3.md`）的落实与真机读数。① R1 的两个 P1 缺口**都已修**：`move`/`publish` 的裸 EPERM 与 `write` 共用同一套译码器（`denial-hints.js` 在**两个自带插件里各一份、逐字节相同**，只改写 `message`、按字符串 `code` 判、三档 EPERM/EACCES/EROFS），`read`/`remove`/`edit` 在 **`stat` 被拒（非 ENOENT）** 时改报「无权限」（`dsh-fs-local` 的 4 处核心树注入，复用上游已有的 `FS_PERMISSION_DENIED`）；② 报告 §2.1 的**前提被代码推翻** —— 上游 `statRegularFile()`/`readFileAbortable()` 对非 ENOENT/非 abort 的错误**一律裸上抛**，`read` 的文本路径**第一道门就是 `stat`**（只有 `readBytes` 不走），报告看到的 `not found` 是**真的不存在**，缺陷只在"更严的设备"上必然复现；③ 新增门禁 `check-denial-hints.mjs`（45 断言，离线，进 CI）与 `check-fs-local-permission.mjs`（**真跑**树里那份被注入的 `dsh-fs-local` + 注入式负控制臂：把补丁就地删掉必须退回裸 EPERM）；④ `coreVersion` `+dshm.8` → **`+dshm.9`**，已覆盖安装到 PC 真机，**设备侧三方逐字节一致**（源码 ↔ 本地树 ↔ 设备树，含 sha256）；⑤ **R3 真机复测结论「本轮复测通过」**（`write`/`move`/`publish`/`remove` 四工具的 EPERM/EACCES 映射现场读到，成功路径无回归）；未做项：方案 B、会话写锁 21 个、`HO_DATA_EXT_MISC` 的 4 个平台拒绝删除的残留（如实记录，不洗白）。

> **追加输入 R4（`dshm-sandbox-retest-r4.md`）**：结论「设备上未检测到本轮的新部署」**属实且正确**，
> 但根因是**本轮无产品代码改动、也无新构建**（HAP 21:50:35 晚于所有源码改动 21:47:40）⇒ 与 R3 逐项一致是**预期**。
> 它暴露的真问题是"缺一条机械判据"⇒ 新增 `tools/device-code-fingerprint.ps1`：设备核心树 5 个关键文件 ↔ 本机树
> 逐字节 sha256，三档 **一致 / 不一致 / 未验证 = rc 0/1/2**（**三档都实测过**；只读、需要设备、不进 CI）。
> 另把"平台把无权限报成 `ENOENT` ⇒ `read`/`edit` 仍说 `not found`"登记为 §7.4 遗留：
> 要改必须加独立探测 + 正反两臂门禁，**不许**看到 `ENOENT` 就改口说无权限。

- `110-手持档插件安装卸载的进程内包通道与API24兼容面拍板.md` —— 用户提供的**两份仓库外**诊断报告（`DSHM插件卸载报错诊断报告-2026-10-06.md` 413 行 + `DSHM-环境自检-工具调用-插件卸载-诊断报告.md` 633 行）的落实。**① 插件安装/卸载**：手持档「设置 → 插件」100% 失败（`spawn pnpm EACCES`）的根因是 `runProfilePnpm()` 最后一跳 `execa('pnpm', …)` 落在本档**没有任何可 `execve` 的 shell**（`system-sh=缺`/`ash=denied`/`bash=denied`/`realShell=no`）上 ⇒ 假壳 `bin/pnpm` 一行都没执行，它里面唯一干活的实现（写 `install-queue/*.rem`）**结构上不可达**；上游 `packageManager` 钩子只能换"spawn 哪个可执行文件"⇒ **纯配置解决不了**。修法是**方案 A**：把市场桥那套队列客户端做成自带插件 `@deepseek-ai/dshm-profile-pnpm`，由 pack-core 的 `patchProfilePnpmBridge()` 注入 `dsh-plugin-manager/lib/types/operations.js` 的**兼容性预检之后、`execa` 之前**（返回形状与 execa 路径逐字段相同 ⇒ 上游 `throw new Error(output)` 链路一个字不改）；判据与市场桥同源（`bin/pnpm --version` 能跑 ⇒ **完全惰性** ⇒ PC/2in1 档行为零变化，鸿蒙 PC 实测 0 条本桥日志 + `home` 指纹与 `exec` 探测 10/10 全通）。新增离线门禁 `tools/check-profile-pnpm-bridge.mjs`（42 断言 + `--self-test` 4 个变异体）与核心树门禁 **⑬**（+M12 变异用例，注入处数 21 → 22）；`coreVersion` 升 **`+dshm.10`**。**② API 24 兼容面拍板**：把 `docs/108` §6-2 的"23 还是 24"结掉 —— 取 **`compatibleSdkVersion: 6.1.1(24)`**（与 `targetSdkVersion` 一致；23 只是"能更低"的验证，本仓没有 API 23 的验证设备 ⇒ 不把未验收的兼容面当产品口径），产物实读 `minAPIVersion=60101024` / `targetAPIVersion=60101024` / `compileSdkVersion=26.0.0.32`。另记：报告 §4.7-1 的"Host 是否实现 `.rem`"**答复为已实现**（`main.js:5093-5103/5183` + `dshm-installer.js:1181/1296`）、**方案 B（统一 5 个假壳 shebang）不做**的触发条件（等到出现"`ash=ok` 且 `/system/bin/sh` 不可用"的档位再改）与 6 项遗留。
- `111-对话框文件上传失败的根因（宿主fetch垫片丢弃流式请求体）与cause可诊断化.md` —— 用户提供的**仓库外**报告（`dshm-upload-failure-report.md`，2026-10-06 22:33–22:45 CST，鸿蒙 PC 档，核心 `+dshm.10`）的落实。报告的**证据链全对、结论方向错了**：它把嫌疑钉在 2026-09-26 的 `DSHM_ATTACHMENT_SANDBOX` 端侧补丁（`link` → `copyFile`）上，并建议"扩 `syncDirectory()` 白名单 / 改 `copyFile`/`chmod` 的 errno 处理"。**① 真因在我们自己的宿主 fetch 垫片**：`hostcore/app/fetch-shim.js` 的 `DshmRequest` 把**流式请求体一律吞掉**且**不设 `body` 属性**（原注释"dsh 的 /api 走 buffered 模式，用不到"正是那句错话），而全核心树**唯一**的 `requestBody: "streaming"` 路由恰恰是对话框上传（`/api/session/uploadFileBinary`）⇒ 处理器 `requestBodyChunks(request.body)` 拿到 `undefined`、在 `undefined.getReader()` 抛 TypeError ⇒ 被 `stageImmutableObject()` 的 catch 清掉 tmp 后包成 `ATTACHMENT_WRITE_FAILED`，**cause 被丢弃** ⇒ 症状与"沙箱禁止落盘"逐字相同。修法：`DshmRequest` 用鸭子类型（`typeof raw.getReader === "function"`）把流式体保进 `_stream` 并赋给 `this.body`（无体/非流式取 `null`，与原生 Fetch 同义，正是 `requestBodyChunks` 的早退判据），诊断行加 `stream=` 一栏；影响面 = **全平台**（垫片在 `--jitless` 下**必然**接管 `Request`），与是否鸿蒙无关。**② 加固 ⑪b**：`tools/pack-core.mjs` 新注入 `patchAttachmentLocalCause()`（独立标记 `DSHM_ATTACHMENT_CAUSE`）把 `dsh-attachment-local` 的**三处** `ATTACHMENT_WRITE_FAILED` 抛出点改走助手 `attachmentPersistFailure(error)`（`console.error` 落宿主日志 + cause 进 `error.message`），**不改** `code`/`details` 形状。**③ 开发端自查**：`~/dsh/home` 是 `0700` ⇒ 全走应用自身 Python 桥；受控实验证明失败在**暂存阶段**（一次上传只有 `tmp` 的 mtime 变、`file-objects/` 始终 MISSING）；同进程 Python 桥把 `mkdir`/`chmod`/`open(O_CREAT|O_EXCL,0600)`/`write`/`fsync`/`copyFile`/`chmod 0400`/`unlink`/`fsync(parent)` **逐项跑绿** ⇒ 既不是 errno 也不是沙箱。**④ 真机验收**（鸿蒙 PC `86E0226429000417`，`MNTXM-24B`）：`install -r` 后 home 指纹 `links=13 size=3440` 不变、核心树 `+dshm.11` 在、exec 10/10；四条上传（`probe-111.txt` 31 B、`big.bin` 2 MiB、中文名 `王志豪.pdf`、复验 `verify2.bin` 777 B）`ok:true` 且 attachmentId **等于**本地 sha256、回读逐字节一致、`tmp/` 无残留；日志 `stream=true` 8 次 / `stream=false` 49 次（buffered 形状零回归）/ `[attachment-local] 落盘失败` **0** 条。门禁：`check-fetch-shim.cjs` 新增 **⑧′**（流式体可读且字节一致）+ **⑧″ 对照臂**（吞体的旧实现必须判红），`check-core-openharmony-patches.mjs` ⑪ 组 +`DSHM_ATTACHMENT_CAUSE`（注入处数 22 → **23**）；`coreVersion` 升 **`+dshm.11`**。
- `113-工作区列表里那条用户没建过的记录（默认工作区登记收窄）.md` —— 用户报「工作区列表里多出一个 `com.dshm.dshclient`，不是我手动创建的，三端都有」的落实。**不是测试产物**：写它的是自带插件 `dshm-workspace-claim`（2026-10-03 随 `570cc2a` 引入），原实现**每次启动**都 `workspaceRegistry.create(认领目录)`；真机判据 = 注册表里那条的 `createdAt` 与该次 `boot pid=` 相差 **4.03 秒**（UI 选择器需要界面，且 WebView 5 秒后才连上）⇒ 排除人工选择。收窄成 4 条纪律（注册表非空一条都不加 / 只撤「自己那条 + 0 会话」/ 撤完必须仍非空 / `list()` 读不到就 fail-closed），登记标题不再退化成包名；新增离线门禁 `tools/check-workspace-claim.mjs`（10 个行为用例 + 「旧实现必须判红」对照臂）；`coreVersion` 升 `+dshm.13`。
- `112-三端代码审核与正式侧载包.md` —— 三端（PC / 手机 / 平板）代码审核 + GitHub 待推审核 + 正式侧载包 + 轻量化裁定：11 处分档点逐条核过、端到端未发现功能缺陷；发现并删掉本文件索引尾部的两行孤儿残句；轻量化 7 项候选（可省 ~21 MB / 6.6%）全部登记为“待机 / 不做”并写明理由。
- `114-WorkBuddy手机端的执行外移与DSHM的对照.md` —— 用户问「手机端 WorkBuddy 是怎么处理 bash 不能调用的」的**只读侦查**（未改一行代码）。**结论：它没解，它把"在手机上执行"取消了**——手机端是 ArkUI 壳挂 **Flutter** 画布（`XComponent`），执行落云端（积分计量）或用户自己的 PC：顶栏「云端 工作模式」点开是**「选择设备」**，只有 `☁️ 云端` 与 `🖥️ Sol的MateBook 14（离线）`，**手机自身不在列表里**；连定时任务的卡片头部都标着执行主机 `Sol的MateBook 14`，正文里的"本地"指的是**执行主机的本地**（`~/.workbuddy/skills/`）。三条独立证据链：`reqPermissions` 14 条**零条与 shell/进程相关**（它从不试 `execve`）、执行位置是用户可见的开关、任务绑定主机。**对 DSHM 的意义**：① **"PC 当执行主机"这条架构仓库里已经有了** —— `hostkit/`（PC 侧配对 + 二维码 + 端到端隧道，出口回 `127.0.0.1`，满足 `docs/10` §136 红线）+ 手机侧 `ConnectPane` 的「远程 Host（可选）」，这是手机档要**真 bash** 的唯一门（`docs/104` 已判决本机无解）；现状 `node --test hostkit/test/index.mjs` = **146 项 145 通过 / 1 红**，红的是用例夹具自身（token 里多了一个空格，`parseAnnounce` 的 `\S+?` 必然不匹配），不影响真实链路但门禁不能叫全绿。② 把手持档能力做成**用户可见的事实**（照抄它把执行位置放顶栏）——我们已有 `host-ready.json` 的 `runtime.*` 读数。③ `docs/104` 修法一/二仍是本机最优解，**WorkBuddy 不构成反证**（它压根没在本机试过）。④ 入口应换成任务型（`docs/104` 修法三）。**不抄**：Flutter 客户端架构、云端 agent、把设备列表做成首屏开关。**旁证**：它以 `compileSdkVersion 6.1.0.105`、`deviceTypes: ["phone","tablet","2in1"]` 在 AppGallery 正式分发且跑在 API 26 设备上（支持 `docs/110` 的 `6.1.1(24)` 拍板）。未做：未反编译（release 签名 + el1 0700）、未拿到它自己的日志（它不写 hilog）、未复测 hostkit 隧道端到端（桌面档本轮 Offline）、"离线主机是否可选中"三次点按均未生效 ⇒ 未定论。

- `115-手持档工具链解包的进程内回退（纯JS解tar.gz，不创建进程）.md` —— 两份仓库外报告（手持档体检 389 行 / PC 发布门禁 198 行）按「**手机+平板＝同一类**、PC 单算」分开处理。**① 真缺陷（手持档 P0-2）**：手机 / 平板的 Python 运行时**永远** `stdlib=false`，根因是工具链解包走 `spawn <binDir>/busybox ash -c "tar xmzf …"` 而本档**禁止创建进程**（`docs/104`）⇒ 每次启动先 `rmSync(PYTHON_PREFIX)`、spawn 报错、`.extract.log` 落 0 字节，`pythonReady()` 永不成立；修法的依据是**解包不需要新进程**（`tar.gz = gzip(ustar)`，`node:zlib.gunzipSync` + 512 字节头解析）——新增 `hostcore/app/tar-gz.cjs`（单份纯 JS walker：异步按批让出事件循环 / tar-slip 抛错 / link 不建链 / **采纳 PAX `path=`**），`main.js` 的**两条** spawn 失败路径（同步抛错 + 异步 `error`）都经**一次性门闩**接上进程内回退（只解 python —— git 真身在本档起不来，解它只占 ~100 MB），`dshm-installer.js` 删掉私有 ustar 改复用同一份 walker，`place-host-app` / `assert-resfile-sync` 两处清单补 `tar-gz.cjs`（漏了 = `MODULE_NOT_FOUND` 被吞成一行 diag = 与修复前一模一样）。**②「不能调 bash」不是本仓能修的**：`docs/104` 的判决与 `docs/114` 的 WorkBuddy 印证都不变，本轮**没有**把终端做成"看起来能用"。**③ 顺带**：`assert-exec-fix` 第 34 条从「裸短语 `execve 被拒` 计数」收窄成「**完整降级文案**恰好 2 次」（本轮新增的一行诊断措辞把旧判据踩红 ⇒ 脆锚点两面都成立）；PC 档写锁只**加读数不改策略**（按类计数 `存活`/`EPERM(异uid)`/`本进程`/`非pid`/`不可读`/`删除失败` + 样例，挂在「写锁巡检」之后，供下一轮定口径）。门禁：`check-tar-extract` 26 → **33** 条（新增 7 条接线断言 + 4 个注入式负测试全部判红后复绿）、`assert-exec-fix` 38/38、`assert-resfile-sync` 14 件同步、`check-resfile-core-zip` 三者一致；**`coreVersion` 未升**（未碰核心树注入，容器逐字节不变）。**真机验收（2026-10-07）**：PC 档（2in1）五项自动判定全 PASS、`exec 探测` 10/10、回退惰性（全日志 0 处 `进程内解包`）；**手机档（`VYG-AL00`）首次启动即由进程内回退解出 `toolchain/python`（写 3482 个文件、跳过 1048，与宿主彩排逐字一致），`print(1+1)=2` **免重启**通过，第二次启动已不再解包**；两档 `.extract.log` 的旧判据按实测更正（进程内路径不写该文件）。**未做**：插件安装器 `extractTar` 没有 dry-run，未实机装插件验证；手持档真 shell 的三条修法仍待拍板。
- `116-分档代码审核与全项目体检·重建侧载包r3.md` —— 用户「最后审核一次代码，PC 和手机平板分开审核代码，对全项目做一次深度的体检，审核完毕后清理临时文件/无用垃圾/缓存，重新编译侧载包」的落实。**① 分档审核**：PC/2in1 档逐点核过「手持分支对它逐一早退」（`isHandheldForm()` 的全部调用点只有 3 处 + 1 处定义；`WindowRegistry.followScreenRotationOnHandheld()` 对非 PHONE/TABLET 直接 `return`；`dshm-market-bridge` 的 `shimRunnable()` 在 PC 上为真 ⇒ 完全惰性；`FilePicker` 的旧判据与旧文案逐字保留）⇒ **PC 没有被改坏**；手持档本轮未改，上一轮的进程内解包已在真机验过（`docs/115` §6），`bash` 仍 `denied` 且不声称修好。**② 体检**：31 条登记门禁 **30 绿**（唯一那条红是本轮自己踩出来的，见 ③）；另外把 `tools/` 下 67 个脚本全扫了一遍，7 个"红"**全是非门禁工具**（需真机 / `.research` 上游 / 参数 / token / 顶部废弃守卫），逐个登记以免下一轮误判成回归。**③ 两条新坑**：裸跑 `tools/pack-core.mjs` 会重盖树内 `dshm-core.json` 的 `builtAt` ⇒ `dist/core` 容器 sha 从 `eac9393d…` 变 `f0233125…`（**16,487 条里只差这 1 条**）而 resfile 那份没动 ⇒ `check-resfile-core-zip` 立刻判红；裸跑 `tools/place-toolchain.mjs` 会把 resfile 的 15 个 `.apk` + 1 个 `.tar.gz` 重新 gzip（**只有 gzip 头的 MTIME 字节 4–7 变**，gunzip 后逐字节相同）⇒ 与已出的 HAP 失同步。两条都按「从 resfile / 已装 HAP 逐字节还原」复原并复验转绿 —— 记为 `AGENTS.md`「出包三坑」的两个**同族变体**：它们会静默地把「交付物」与「树」拆开。**④ 重出包 r3**：`BUILD SUCCESSFUL in 34 s 99 ms`（`entry/build`、`entry/.cxx` 上轮已清 ⇒ 全新构建），**295,513,598 B** / sha256 `5d6773d35407ef34c6d8603b3673c232bb87e4b307c215601f3b644137560c49`；与 r2 **解压后 115 个条目逐字节相同**，差异只有打包时间戳（zip 的 DOS mtime 解出来正是 14:38:46 vs 13:56:54，与两份文件的 mtime 对得上）与签名块 1 字节 ⇒ **功能等同**，所以 **r2 不再留回退副本**（"同签名可直接 `install -r`"这个回退价值 r3 本身具备，r1 那件宿主层不同故继续留档），`dist/sideload/SHA256SUMS.txt` 与 `README.md` 已同步成 r3。**⑥ 追加轮（§9）**：修 `tools/device-code-fingerprint.ps1` 的 **token 取源缺陷**（原从 `dshm-host.log` 抓 `tail -1 token=`，可能落到**上一个进程**的 token ⇒ 桥回 401、脚本误报「未验证」；改成三级优先 `-Token` > `host-ready.json` > 日志，来源与长度打进输出、401 单独判读），手机档不喂 token 复跑 `一致（5/5）`/RC=0；据此重编 **r4**（295,513,598 B / sha256 `2badeb7b7e3deed8e5c898eb67100a4c3478962532ccd14fb4c2687f479474be`，与 r3 解压后 115/115 条目逐字节相同 ⇒ **功能等同、r3 不留单独副本**），手机 `62T0225B18039433` 覆盖安装后端侧验收 **5/5 PASS**（`dist/acceptance/20261007-152208`）+ 指纹 **5/5 / RC=0**，工作区授权跨启动恢复 `restore 1/1`（6/6 文件可读写）。**⑤ 清理**：`$env:TEMP\dshm*` **2314 项 / 173.9 MiB**（门禁临时舞台 + 历次设备日志抓取）+ 2 个构建日志；`dist/` 里**被文档按名引用的证据**、**人工撰写的正文**（如 `热更新可行性分析.md`）与构建缓存一律保留并在 §6 写明理由。**未做**：装机验证（两次查 `hdc list targets` 都是 `[Empty]`）、手持档真 `bash`、`extractTar` 的实机往返；**未 commit、未 push**。
## 清理与留档纪律（E126）

- **临时过程产物一律只落 `dist/`**：本地调试的 `home*` / `sandbox` / 截图 / 日志 / 探针输出都属于可再生产物，随用随清（本轮已清 73 个文件 + 21 个目录 ≈ 8.1 MB）。
  > **⚠️ 2026-09-25 更正**：这条此前写着"（**已 gitignore**）"，而根 `.gitignore` **当时只有两行**
  > （`.git/`、`*.class`）——**`dist/` 其实从未被忽略**。已把 `.gitignore` 补全到与实际边界一致
  > （构建器输出、`third_party/`、由脚本生成的资源、编译所需的外部产物）。
  > **教训**：这类"文档说了、配置没做"的偏差比单个 bug 更危险——下一个人会按文档行事
  > （以为不会误提交），直到某次 `git add -A` 把 500MB 中间产物带进去。
  > 判据一律以根 `README.md` 的「不入库的产物」表 + `.gitignore` 为准。
  > 另：**2026-09-30 更正**——本条此前写着「本仓不是 git 仓库（无 `.git/`）」，与实测相反：
  > `Test-Path .git` 为 True，`git rev-list --count HEAD` = 3（本仓已是 git 仓库且有历史）。
  > 因此 `.gitignore` 不是"为将来入库准备"，而是**当下就生效**的边界。
- **文档只标"历史/已取代"，不删契约**：契约类文档（D1/D2/D2b/D3/D3b/D4/D5）是排除歧义的依据，删除等于丢失判据；过时的是**结论**，因此在上表里就地标注并指向权威更正处（D6 的证据表 E1…）。
- **仓库根部只保留构建与许可文件**：源码、构建配置（含 `build-profile.template.json5`）、`LICENSE`、`README.md`、`AGENTS.md`、`.gitignore`。使用者提供的对照包（如 `v37.2.3-*.zip`）与 `.research/`、`.codegenie/`、`dist/` 一律不入库（见 `.gitignore`）。

## 阅读顺序（按角色）

| 角色 | 顺序 |
|---|---|
| **所有人（先读）** | **D9 全文**（端到端实现全流程）→ **D6 全文**（目标与架构的权威更正） |
| **新接手移植工作的人** | **D9 全文**（全流程；其第一章即"两个根本约束"）→ **D8 全文**（按主题查坑）→ D6 §1/§2（不变式与目标架构）→ `device-validation.md` §0（本文完整度） |
| 项目负责人 / 评审人 | **D6** → D1 全文（注意其远程客户端定位已被更正）→ D1 §12 待决事项 → D4 界面完成度对照表 |
| 端侧运行时 / 打包 | **D6 §4~§6** → D4 POC-11/POC-12 → **D8 §1/§2/§3**（平台、hmfs、打包的坑）→ `.research/ref-harmony/specs/ARCHITECTURE.md`（社区反面对标） |
| 协议层开发 | D1 §6 → D2 全文 → **D2b 全文** → D4 POC-1/2/3/4/10 |
| 设置页 / 凭据接线 | **D3b 全文** → D2 §8.7.2（凭据 ref 编码）→ D2 §8.7.6（void 回复陷阱） |
| UI / 体验开发 | D1 §7 → D3 全文 → D4 POC-5/6 → **D8 §7**（ArkUI 与 Web 的语义差异） |
| 平台与系统集成 | D1 §7.7 → D3 §2/§6/§7 → D4 POC-8/9 |
| `hostkit`（PC 侧） | D1 §6.5 → D2 §2 → D4 POC-2/3 |
| **上游版本升级** | **D5 全文** → D2 §8 附录（尤其 §8.7）→ D1 §11.4 → **D8 §0.1**（升级后必须重搜 undici 直接依赖） |
| **决定"接下来修什么"** | **R1 §0 第二列的 63 条**（逐条可核落盘；§0 第一列的 85 是原始汇总口径）→ **R1 §10 的 33 条**（第二轮，按官方对照面切，**看 §10.2 的 9 条高**）→ R1 §0 的**通路事实**（决定哪些问题当前只是休眠）→ R1 §9 未验证项（不要把未验证当结论） |

## 纪律

1. **D1 冻结后**，范围 / 目标 / 验收的变更必须走 D1 §12.3 的变更流程并升版本号，不允许静默偏离。
2. **D2 的每条事实必须标注来源**（代码 / 官方文档 / 实测 / 待实测）；标注「待实测」的条目在补齐证据前不得据以实现。
3. **D4 的每个 POC 必须有证据**；无证据的「通过」视为未通过；失败结论必须与通过结论同等留档。
4. 实施期与设计的偏差写进 `specs/`（as-built 记录），不改写历史文档。
5. **上游知识只允许出现在 `dshcompat` 模块**（D5 §1）；违反即为架构回归，与功能 bug 同级处理。**由 `tools/arch-check.mjs` 强制**（注释感知 + 内置注入式自检）。
6. **任何门禁（漂移检测、架构回归、静态检查）必须经注入式负测试验证**其真的会失败，否则视为没有门禁（D5 §5）。
7. **跨来源比对必须先确认字段对等**。本项目已因此得到一个「看起来很有说服力的错误结论」，
   并差点据此删掉一处正确的防护（详见 D2 §8.7.6 的「一次被推翻的『推翻』」）。
8. **统计实测数据前必须先定口径**，并在文档里把口径写出来。本项目的事件清单曾因
   「按通用字段名 `type` 遍历」而**虚增 4 种**（把 `assistant/message.data.stream[]` 里的
   流式记录当成了事件类型），差一点据此建出「并不存在的事件族」（详见 D2 §8.7.7）。
   多统计与统计错对象，比少统计更危险——它们会产出听起来很有道理的错误结论。
9. **门禁「通过」不等于「覆盖到了」**。门禁的覆盖面自身必须被审视：本项目两次出现
   「门禁全绿但实际漏检」（命名空间表缺事件前缀、之后又缺 `deliverables/` 等三项）。
   新增任何上游名词（端点、事件、命名空间）时，都要问一句「门禁认识它吗」。

## 调研副本（`.research/`，未纳入版本库）

`.research/` 是本地调研目录，**已被 `.gitignore` 忽略**（开源不需要，但开发时要用）。

| 路径 | 内容 |
|---|---|
| `.research/protocol/contracts-*.json` | 各上游版本的协议契约快照（`rc1` / `0.2.0-rc.1` / `0.2.0-rc.2`，各带 `.meta.json`），由 `tools/gen-compat-endpoints.mjs` 产出，供漂移比对 |
| `.research/protocol/drift-rc1-to-rc2.txt` | rc.1 → rc.2 的端点漂移清单（升级手册 §4.1 的依据） |

其它调研材料（官方桌面端 README、上游协议包文档副本、社区工程浅克隆等）按需放在同一目录即可，不入库。

