# 最终审核报告（对齐官方 dsh 0.2.0-rc.2）

> 日期：2026-09-29　基线：HAP 内嵌核心 `0.2.0-rc.2`（真机 `BOOT_10_ENV_READY` 确证）
> 提示词：`docs/review-prompts.md`（7 路对抗性）
> 执行方式：7 路独立审查并行跑（`workflow`），每路只读取证、禁改文件
> 本轮定位：**只审不改** —— 用户要求「审核完就更新文档」，未要求修复

## 0. 总量与分布

| 严重度 | 原始 7 路汇总 | 本报告逐条落盘 |
|---|---|---|
| 阻断 | 2 | 0 |
| 高 | 25 | 19 |
| 中 | 38 | 31 |
| 低 | 20 | 13 |
| **合计** | **85** | **63** |

> **两列为什么不同（必读）**：首次 7 路并行跑的返回值被工具截断（见 §8 第 1 条），
> 路5 / 路6 / 路7 的**逐条清单**没有落进任何文件。路6 在重跑中改为「写文件」后取得（§6，16 条，逐条完整）；
> 路5 / 路7 的重跑长期无产出、落盘文件始终未生成，最终由**人工读源码复核重写**（§5、§7）。
> **人工复核未能复现原汇总记在路5/路6/路7 上的 2 条阻断** ⇒ 本报告如实把阻断记为 **0**，
> 不保留无法指认的条目（撤回记在 §1）。
> 原始汇总的 85 仍是本轮 7 路的头条数字，外部文档（`docs/README.md`、`docs/parity-matrix.md` v1.43、`.local-rules/build-status.local.md`）
> 引用的是它；**逐条可核的清单以「本报告逐条落盘」列为准**。
>
> 「逐条落盘」列的 63 条 = 各节标题行实数，可复核：
> 路1 `9`（4H/4M/1L）· 路2 `15`（5H/7M/3L）· 路3 `13`（7H/4M/2L）· 路4 `3`（2H/1M）·
> 路5 `5`（3M/2L）· 路6 `16`（1H/11M/4L）· 路7 `2`（1M/1L）。
> 与原始汇总的差额（阻断 −2 / 高 −6 / 中 −7 / 低 −7）全部落在**被截断丢失的路5/路6/路7 条目**上，
> 其中路6 靠重跑找回 16 条，路5/路7 靠人工复核找回 7 条 —— 剩下的不再追认。

七路结论一句话：

| 路 | 主题 | 一句话结论 |
|---|---|---|
| 1 | 协议契约 | 契约表本身（`Endpoints.ets` ↔ `contracts.json` 140 条）**逐条零偏差**，问题全在契约表**之上**的接线层 |
| 2 | Host 偏离 | 15 条偏离，多数有理由注释；但 `process.exit` 拦截与 `isRestartHelper` 两处**改变了上游语义**且注释与实现不符 |
| 3 | 插件生命周期 | 安装侧正常 npm 路径满足全部契约；**卸载对称性在 5 类路径上全不成立**，且多为「返回 ok:true 却没清干净」的静默假成功 |
| 4 | 连接层 | 抖动成因定案 = **未被覆盖的 Host 心跳**；自研 `connection` 层在生产入口**不可达** |
| 5 | 端侧桥与 env | 5.1 / 5.2 / 5.4 **通过**；5.3 有保留（停止请求文件两侧不对称，与路2 同一条根因，不重复计数）；剩 3 条是注释/兜底与实物不符 |
| 6 | 工程纪律与残留 | 见 §6（16 条：1 高 / 11 中 / 4 低）|
| 7 | UI 遮挡 | **壳本身干净** —— 注入层零 DOM 隐藏/删除、App 内无自检菜单、「退出应用」已归位托盘（与官方 `tray.js` 同构）；问题在**矩阵声明**：14 个 `DONE` 行里 5 行的「界面」列指向当前构建形态**不可达**的原生树 |

> **通路事实（影响全篇判读）**：`entry/src/main/ets/entryability/EntryAbility.ets:671`
> `windowStage.loadContent('pages/WebApp', …)` ⇒ 生产构建走的是 **WebView 壳**，
> `pages/Index.ets` 那条**原生 UI 路径不可达**。因此第 1 路与第 7 路里
> 大量「原生 UI 调用失败」类问题当前**不构成用户可见缺陷**，
> 但它们是**休眠的**：一旦切到原生 UI 就会同时爆发若干条。已在各条标注。

---

## 1. 路1：协议契约对齐

### 阻断

**（撤回）** —— 原汇总把 2 条「阻断」记在本路与路7，但首次 7 路并行跑的返回值被工具截断
（§8 第 1 条），那 2 条的**原文没有落进任何文件**；重跑（路6 写文件）与人工复核（路5/路7 读源码）
都**未能复现**任何阻断级问题。⇒ 本报告如实记为 **0 条阻断**，不保留无法指认的条目。

> 需要时唯一可能的线索：`%TEMP%\dsh-spill-*\…-workflow.txt` 两份共 72 KB / 50 KB 的落盘，
> 都已核对为**在路4 中途断掉**，不含路5/路7 的条目。

### 高

**1-H1 三个幽灵端点常量导致 UI 功能永久失败**
- 位置：`dshcompat/src/main/ets/Aliases.ets:185,187,219`
- 问题：`AGENT_PRESETS_COPY_ENDPOINT='agentPresets/copy'`、`AGENT_PRESETS_DELETE_ENDPOINT='agentPresets/deletePreset'`、`WORKSPACE_FILES_READ_ALL_ENDPOINT='workspaceFiles/readAll'` 这 3 个名字**不在任何一版契约快照中**，也不在上游 `node_modules` 里。端点表内查不到 ⇒ `argsFor/buildArgs` 恒返回 `undefined` ⇒ 消费路径恒走 `contract.missing`。
- 证据：3 个名字在全部 5 份快照（`.research/protocol/contracts.json`、`contracts-0.2.0-rc.2.json`、`contracts-0.2.0-rc.1.json`、`contracts-rc2.json`、`contracts-rc1.json`）中 grep 命中数均为 **0**；上游 `dsh-agent-preset-registry` 仅有 `agentPresets/{list,read,select}`（`lib/typert.remote-client.js:34/50/76`）。传导链：`CompatIndex.ets:202-206 buildArgs()` 在 `endpointOf(key)===undefined` 时返回 undefined，`Aliases.ets:388-389 argsFor=buildArgs`；`appstate/src/main/ets/model/Wire.ets:1877-1885 workspaceReadAllPayload()`；`SessionHub.ets:3743-3747` payload===undefined ⇒ `{ok:false, reason:'该 Host 不提供整文件读取端点（兼容面上表里没有它）。'}`。UI 入口真实存在：`pages/Index.ets:1869-1876 attachWorkspaceFileToComposer` → `view/TabContentView.ets:209/:4233`；`SessionHub.ets:3012-3014 copyAgentPreset` / `:3045-3047 deleteAgentPreset`，入口在 `view/SettingsPresets.ets:184-189` 与 `:201-212`。
- rc.2 的合法替代：`workspaceFiles/readBytes`（`@deepseek-ai/dsh-api-workspace-files/lib/typert.remote-client.d.ts:19`，params `workspaceFileScopeId,path,options`）。
- 建议：`readAll` → 改用 `workspaceFiles/readBytes` 并按 rc.2 的 `options` 形态装参；`agentPresets/copy`、`deletePreset` 上游**确无对应端点**，应删常量并摘除 `SettingsPresets.ets` 的对应按钮与 `SessionHub` 的两个方法。至少要在常量处标注「上游不存在、调用必失败」并让 UI 置灰，而不是保留注释声称其真实存在。

**1-H2 同一仓三处注释互相矛盾（对同一端点说反话）**
- 位置：`dshcompat/src/main/ets/CompatIndex.ets:61-63` ↔ `dshcompat/src/main/ets/Aliases.ets:174-181,211-218`
- 问题：`CompatIndex.ets` 明确写 `agentPresets/{copy,deletePreset}`、`workspaceFiles/{readAll,readRelated}` 已被上游移除；`Aliases.ets` 却写「宿主侧有 `typert.host.js` ⇒ 这四个端点是真实存在的表面」「两者不可互相替代」。保留在 `Aliases` 的那一侧是**错的**。
- 证据：`tools/gen-compat-endpoints.mjs:86-88,106-113` 第三处也承认「rc.2 起 `workspaceFiles/readAll` 与 `readRelated` 已从上游移除…替代路径 `readBytes`（rc.2 起参数由 `range` 改为 `options`）」。
- 建议：以 `CompatIndex.ets:61-63` 与生成器为准，删除/改写 `Aliases.ets:174-219` 的错误注释；三处对同一事实只保留**一处权威陈述**。

**1-H3 能力表不覆盖官方插件 UI 真正调用的端点（36 条 UI 在用端点无能力引用）**
- 位置：`dshcompat/src/main/ets/Endpoints.ets:679-690`
- 问题：`plugins` 能力只认 `pluginInventory/list` 一条，而官方 `dsh-client-ui-plugin-manager` 实际调 `pluginManager/{listPlugins,listBundles,registries,inspect,installBundle,cancelInstall,removeBundle,setBundleEnabled,setPluginEnabled,waitForInstall}` + `pluginRegistryProbe/fastest` 共 **13 条**，全部 `capability:''` ⇒ 「plugins 能力可用」这个判据**无法反映插件管理界面真正需要什么**。
- 证据：`dsh-client-ui-plugin-manager/lib/client.js:1130`；按 dsh-web-app 依赖统计共 **36 条** UI 在用端点未被任何能力引用：`account/*` 9、`dynamicCordisRunner/*` 3、`fileReferences/list`、`officeToPdf/*` 2、`permissionPresets/catalog`、`pluginManager/*` 11、`pluginRegistryProbe/fastest`、`productAnalytics/*` 2、`schedule/*` 5、`session/initializeDefaultModel`、`session/{openWorkspacePath,workspacePathApplications}`、`sessionReferenceResolver/candidates`、`settings/openSettingsDocument`、`userQuestions/{answer,attachWait}`。**反向**：UI 调用但不在 140 表内的端点 = **0**（说明我们没漏接，只是没归类）。
- 建议：把 `pluginManager/*` + `pluginRegistryProbe/fastest` 归入 `plugins` 能力；其余按语义归入既有能力或新增能力。**注意**：改动 `CAPABILITIES` 必须改 `tools/gen-compat-endpoints.mjs:71-190` 这个唯一手改点，然后重跑生成器。

**1-H4 生产入口走 WebView ⇒ 原生 UI 契约接线层不可达**
- 位置：`entry/src/main/ets/entryability/EntryAbility.ets:671`
- 问题：`windowStage.loadContent('pages/WebApp', …)` ⇒ 所有消费 dshcompat 的原生 UI（`pages/Index.ets`）**不可达**；`dshLaunchRouteJson` 唯一读者是 `pages/Index.ets:740`，`WebApp.ets` 中命中 0。
- 后果：`docs/00-开发任务书.md:332` 的「通知点击直达待决 P0」**当前无法达成**。同时这意味着 §1 的 H1/H2 是否构成用户可见缺陷，取决于「是否切回原生 UI」这个产品决策。
- 建议：要么明确「WebView 壳是正式形态」并在 `parity-matrix.md` 里把原生 UI 行标为"未启用/休眠"，要么补齐 `WebApp` 侧的启动路由消费。

### 中

**1-M1 注释声称的置灰机制不存在**
- 位置：`dshcompat/src/main/ets/CompatIndex.ets:5`
- 注释称「入口置灰依据 `evaluateCapability()`」，但该函数在全部运行时目录命中 **0**（只存在于生成器）⇒ 能力层是**纯装饰**。
- 建议：删掉这句注释，或真的实现置灰判据。

**1-M2 契约逃逸门禁命名空间白名单缺 11 项**
- 位置：`tools/arch-check.mjs:42-54`
- NAMESPACE 白名单 42 项缺：`account`、`job`、`officeToPdf`、`permissionPresets`、`pluginManager`、`pluginRegistryProbe`、`productAnalytics`、`schedule`、`speech`、`terminal`、`userQuestions`。⇒ 门禁有盲区（当前工作树无泄漏，是**覆盖不全**）。
- 证据：文件头 `:38-40` 自述历史上曾漏 `user`/`message` 等 5 个前缀 ⇒ 同类失效已发生过一次。
- 建议：白名单改为**从 `Endpoints.ets` 反推**，而不是手写枚举。

**1-M3 漂移门禁版本判定优先读 env/快照，掩盖「快照 ≠ 实际安装核心」**
- 位置：`tools/compat-drift.mjs:128-145 coreVersion()`
- 顺序 `DSH_VERSION` → 快照 meta → 才回落实际包 ⇒ 实测设 `DSH_CONTRACTS=contracts-0.2.0-rc.1.json` 时报告成 `0.2.0-rc.1` 且 **exit 0**。
- 建议：当 `DSH_NODE_MODULES` 与实际包同时可得时，把「快照自报版本」与「实际包版本」**分别打印并在不一致时非零退出**。

**1-M4 生成基线不可追溯 + `Aliases.ets` 无门禁**
- 位置：`.gitignore:66` 忽略 `.research/`，但生成物 `dshcompat/src/main/ets/Endpoints.ets` **受 git 跟踪**；`tools/compat-drift.mjs:175-184` 只比对 `Endpoints.ets`，**无门禁校验 `Aliases.ets` 的端点常量是否属于 140 表**。
- ⇒ 这正是幽灵常量（1-H1）的存活原因。
- 建议：给 `Aliases.ets` 加同款门禁（把它的端点常量抽出来逐一在 140 表里查）。

### 低

**1-L1 契约逃逸门禁不扫 ohosTest**
- 位置：`tools/arch-check.mjs:25-30` SCAN_ROOTS 不含 `entry/src/ohosTest`
- 证据：`entry/src/ohosTest/ets/test/Connection.test.ets` 有 17 处裸端点字面量：L130/133/150/151/152/166/167/168/172/173/194/200/206/215/225/233/270。
- 建议：把 ohosTest 加进 SCAN_ROOTS，或把这些字面量改成从 `Endpoints.ets` 取常量。

---

## 2. 路2：Host 侧与官方语义偏离（15 条：5 高 / 7 中 / 3 低）

### 高

**2-H1 `process.exit` 被整体拦截 ⇒ 吞掉上游 fail-loud 通道**
- 位置：`hostcore/app/main.js:108-128`
- 问题：非 `ALLOW_EXIT` 时只打两行 diag 然后 `return undefined`。上游 `dsh-app-boot/lib/index.js:3797 installFailLoud(binName, proc=process, release)` 的**唯一结束动作**是 `proc.exit(1)`（`:3806-3807`、`:3818`；传入的 proc 即全局 `process`，见 `@deepseek-ai/dsh/lib/profile-boot-BZ2ZjNWi.js:255-257`）。且 `exiting` 标记已置真 ⇒ **第二次致命错误连 diag 都没有**。
- `ALLOW_EXIT` 唯一置真点：`:3982`。
- 建议：把拦截改成**只拦「非 fail-loud 来源」**，或至少在拦截时打印完整调用栈并保留「同一次启动内只打一次」的语义；`exiting` 置真失败时不要永久沉默。

**2-H2 Host 启动期不清理残留 `host-stop-request`（★ 40s 自杀强嫌疑）**
- 位置：`hostcore/app/main.js:3988-4003`
- 问题：只在轮询体内「取走即删」（`fs.rmSync(stopFile,…)` 仅 `:3993` 一处），**启动期不清理**。对照写请求侧 `hostruntime/src/main/ets/runtime/DshHost.ets:630-660` 明确在失败时 `unlinkSync` 并写下理由「留着会让下一次启动的宿主刚起来就自杀」。
- 关联：`docs/HANDOFF.md:184-197` 记的「启动约 40 秒后自杀」链路 = `requestStop → ALLOW_EXIT → process.exit(0)`。
- 建议：把「启动时先删 `host-stop-request`」放到 Host 引导早期（与 `mkdirSync(installQueueDir)` 同层），并且删不掉时要**记 diag**。

**2-H3 `stubChild` 破坏同步 API 契约**
- 位置：`hostcore/app/main.js:504-520`
- 问题：`stubChild` 被 `spawnSync`/`execFileSync` 直接返回。实测：`spawnSync → status=undefined, stdout=null`；`execFileSync → typeof object, isBuffer=false`；`spawn` 的 stub 无 `error/exit/close` 事件 ⇒ **插件静默挂死**。
- 建议：同步形态要返回**形状完整**的 `{status, stdout, stderr, signal, pid, output}`；异步形态要 `process.nextTick` 发 `error` 事件并置 `exitCode`。

**2-H4 `isRestartHelper` 判据过宽 ⇒ 任意 `execPath -e <script>` 被当成重启意图**
- 位置：`hostcore/app/main.js:498-502`
- 实现：`args.length>=2 && args[0]==='-e' && typeof args[1]==='string' && args[1].length>0`。⇒ **任意** `spawn(process.execPath, ['-e', <脚本>])` 都会写出 `host-exit-mode=app-restart`、触发**整机冷启动**、返回 `pid:-1` 假子进程。
- 注释 `:461` 仍写「args[0] === '-e' 且脚本里含 waitForParent」，**与实现不符**。`:492` 的「核心树 execPath+`-e` 出现 0 次」也排不掉插件（重启助手来自**仓库外**的 `dshmarket/lib/restart.js`）。
- 建议：判据必须包含「脚本内容含 `waitForParent` 特征串」（注释承诺的行为），否则改成显式握手（如环境变量/专用 argv 标记）。

**2-H5 `terminal-bash` / `terminal-pwsh` 覆盖打不到 provider ⇒ 内置终端仍打不开**
- 位置：`hostcore/profile/ondevice/cordis.patch.yml:84-111`（`- id: terminal-bash` `:95`、`- id: terminal-pwsh` `:101`）
- 问题：这两个 id 在 bundle 层只声明于 `@deepseek-ai/dsh-sdk-minimal/cordis.patch.yml:53` 与 `@deepseek-ai/dsh-web-app/presets/minimal.patch.yml:25,43`；而端侧生效 preset 是 `agent-preset-registry` 的 **`default: standard`**（`dsh-web-app/cordis.patch.yml:561-565`；`standard.patch.yml` 中 `pty|terminal|persistent` 计数 = **0**）。`dsh-app-boot/lib/index.js:96-98` 查不到 id 只 `warn` 后 `continue`。
- 后果：`docs/device-validation.md:1324` 记录的「内置终端打不开」在**默认配置下仍未修**。`tool-pwsh`（`:110`）是有效的（命中 `dsh-web-app/cordis.patch.yml:453`）。
- 同一文件 `:179-182` 已自证「preset 内部的行 profile patch 够不着」。
- 建议：要么把这两行移到 preset 层（`agent-preset-registry` 的 standard 条目），要么在文档里把该问题标注为「需切 minimal preset 才生效」。

### 中

**2-M1 `node:http/https` 无条件封禁，与有条件垫片不一致**
- 位置：`hostcore/app/main.js:168-190`（无条件封） vs `:395-432`（有条件钩子）
- 后果：WASM 可用时真 undici 仍在用而其 `maxHeaderSize` 路径被破坏。实测 `undici.request` → `InvalidArgumentError: http module not available or http.maxHeaderSize invalid`（`undici/lib/dispatcher/client.js:64-69` 要求 `Number.isInteger`）。
- 建议：封禁与垫片使用**同一个条件**。

**2-M2 注释自称「覆盖所有插件」，实际只包 4 个函数**
- 位置：`hostcore/app/main.js:443`（注释） vs `:555-557`（实现 `['spawn','execFile','execFileSync','spawnSync']`）
- 后果：`cp.exec(string)` 与 `cp.fork(module)` **完全绕过**（实测 fork 未被拦）。
- 建议：要么补齐 `exec`/`fork`，要么把注释改成「覆盖 4 个常用入口；`exec`/`fork` 未覆盖」。

**2-M3 代理策略静默降级为「装了个空壳」**
- 位置：`hostcore/app/undici-shim.mjs:50-68`
- 问题：不导出 `Pool`/`ProxyAgent`，且 `Agent` 忽略 `factory`（实测二者 `undefined`）。上游 `@deepseek-ai/dsh-http-proxy/lib/index.js:389-398,415-448,519-523` 靠 `new Agent({factory}) → new ProxyAgent(...)/new Pool(...)` 真正路由 ⇒ **代理不生效**，但 `installProxyFromEnvironment` 正常返回、**零日志**。
- 建议：至少在 shim 里判断 `factory` 被传入时打一条 warn，明确「本平台代理不生效」。

**2-M4 `web-runtime` 整块替换丢掉 `trustedHosts`**
- 位置：`hostcore/profile/ondevice/cordis.patch.yml:43-47` vs 上游 `dsh-web-app/cordis.patch.yml:189-196`
- 后果：`main.js:3892-3897` 声明的 `--trusted-host 127.0.0.1:<PORT>` 失效（影响有限，因 bind 恒 `127.0.0.1`）。
- 建议：补回该字段，或在注释里明确「有意去掉，理由：bind 恒回环」。

**2-M5 语音四行的提供者不在 profile bundles 里**
- 位置：`hostcore/profile/ondevice/cordis.patch.yml:252,268,269,270`
- 问题：唯一提供者 `@deepseek-ai/dsh-experimental-voice-input-bundle` **不在** `hostcore/profile/ondevice/package.json:8-13` 的 `dsh.profile.bundles`（= `[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app]`，`removeBundles: []`）⇒ 是否生效取决于**设备侧残留状态**，违反该文件头 `:10-11`「只放有证据支持的覆盖」。
- 建议：要么把 bundle 加进 `package.json`，要么把四行移到「依赖设备残留」的明确章节里并标注未验证。

**2-M6 两处小缺口**
- `main.js:4182-4184` catch 注释写「只剩日志」但该块本身**不打日志**（真日志在外层 `:4185`）。
- `main.js:579-581 currentCoreDir` 解析 `state.json` 失败 `return ''` 且**无 diag** ⇒ 丢失「state.json 坏了」这一原因。

**2-M7 ★ 心跳仍是官方默认（连接抖动的根因，见路4）**
- 位置：`hostcore/profile/ondevice/cordis.patch.yml` 对 `typert-gateway|websocketHeartbeat|streamInboxBytes` **命中 0**
- 证据：`@deepseek-ai/dsh-api-gateway/lib/index.js:551 DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS = 2e3`、`:597` schema 默认取该值、`:552 DEFAULT_STREAM_INBOX_BYTES = 262144`、`:172 MAX_MISSED_HEARTBEATS = 2`；`dsh-base/cordis.patch.yml:52-53` 的 `- id: typert-gateway` 也**无 `config` 块**。
- 状态：属「**已知未修**」（修法已在代码注释里写明，未落盘）。

### 低

**2-L1 `globalThis.__dshmHostError` 无读取者**
- 位置：`hostcore/app/main.js:895` 与 `:3846` 写，全仓**无读取者** ⇒ 注释承诺的诊断回路不存在。
- 建议：要么加读取者（诊断页/日志），要么删掉这两处写入与承诺。

**2-L2 `hostcore/README.md:12` 与事实不符**
- 说端侧 `cordis.patch.yml`「故意为空」，实际该文件 **22,578 B / 314 行 / 20 条覆盖**。

**2-L3 `core-recipe.json` 的 koffi 声明与实际不一致**
- `core-recipe.json:9-13` 声明 `koffi → npm:@ohos-ports/koffi@2.16.2-beta.0`，实际树内 `koffi/package.json version = 3.2.1`（由 `tools/pack-core.mjs:1342 replaceKoffiJs()` 整体替换），`requiredNative` 里的 `koffi.node` 是 **92 字节占位文本**；`:328` 只做**存在性**检查。
- 性质：不是功能缺陷，是**维护陷阱**（改 recipe 的人会以为版本由它决定）。
- 建议：在 `overrides.koffi` 旁注明「实际版本由 `pack-core.mjs` 的 `replaceKoffiJs` 覆盖」，并考虑对 `requiredNative` 加「ELF 魔数」检查。

---

## 3. 路3：插件安装/卸载生命周期

安装侧在**正常 npm 路径**上满足契约（恰 1 个新 key、目录名==key、只登记 `dsh.bundle`、不写用户行，均有实测）。**卸载对称性在 5 类路径上全不成立**。

### 高

**3-H1 pnpm 假壳 remove 分支不写 `.dir` ⇒ 装在 web、卸在 ondevice**
- 位置：`hostcore/app/main.js:1545-1595`（pnpm 假壳 remove 分支）；对照 `:1437`（add 分支）与 `:1818-1822`（dsh 假壳 remove 分支）
- 问题：remove 分支只写 `$QDIR/$base.rem`，**不写 `$base.dir`**；而队列侧 `main.js:4104-4113` 读不到 `.dir` 时 `reqProfileDir` 为空，`:4151-4154` 回落默认 profile `ondevice`。而市场插件装在 **`web`** profile（`main.js:4100-4102` 注释自陈）⇒ 找不到任何东西，`note` 回落「该插件本不存在（幂等）」、exit 0，web 侧包/依赖/bundles **三处纹丝不动**。
- 证据：`Select-String -Path hostcore\app\main.js -Pattern '\$base\.dir'` 仅命中 `1437/1662/1777/1822/1886` 五行，1545-1595 段内**无任何 `.dir` 写入**。
- 建议：remove 分支补 `printf "%s" "$DIR_OPT" > "$QDIR/$base.dir"`（该分支顶部已由 `shimDirResolveLines()` 算好 `DIR_OPT`）。这是三份假壳的**统一化遗漏**，不是平台适配差异。

**3-H2 依赖反查判据过宽 ⇒ 连带删除同仓库兄弟子包**
- 位置：`hostcore/app/dshm-installer.js:1346-1355 + 1407-1415`
- 判据：`sameSpec = depSpec === specTrim || depSpec.split('#')[0] === specTrim.split('#')[0]` ⇒ 同仓库 monorepo 兄弟子包（仅 `&path:` 末段不同）被一并列入候选并**整套删掉**。
- 实测：卸载 `…skin-maid-atelier` 时**同时删了** `…skin-orca-link`。

**3-H3 同一仓库两种合法写法 ⇒ 假成功 / 删错目录**
- 位置：`dshm-installer.js:1345-1355,1400-1404,1521-1526`
- `github:o/r#v1&path:/ui` 与 `https://github.com/o/r#v1&path:/ui` 字符串与主干均不等 ⇒ 候选落空但返回 `ok:true` + `note="该插件本不存在（幂等）"`（`removed=[]` 的**固定文案**）⇒ 假成功；另一形态还会删错目录。
- 建议：候选比对前先**归一化** spec（剥 `github:`/URL 前缀、统一 `#`/`&` 分隔符）。

**3-H4 卸载路径无路径校验 ⇒ `removeSpec('..')` 可删掉整个 profile 目录**
- 位置：`dshm-installer.js:1279-1294 barePackageName` + `:1409-1411`
- 问题：直接 `path.join(profileDir,'node_modules',name)` 后 `fs.rmSync(…,{recursive:true,force:true})`，**无白名单/前缀校验**。实测 `removeSpec('..')` ⇒ `profileDirExists=false profilePackageJsonExists=false`；`'../../../../victim'` 同样逃逸。
- 安装侧 `:991-999 finalName` 同样未校验 ⇒ tarball 内 `name='../../../ESCAPED_PKG'` 可写到 home 顶层并写进 `dependencies` key。
- 建议：`normalize` 后强制 `startsWith(nodeModulesDir + sep)`，否则拒绝；`finalName` 同样校验（npm 名规则 `^(@[^/]+/)?[^/\\]+$`）。

**3-H5 GitHub 回退守卫可被非 GitHub 域绕过**
- 位置：`dshm-installer.js:543 repositoryMatchesRequest`
- 正则 `/github\.com[/:]…$/i` **无域名边界** ⇒ `https://notgithub.com/…`、`https://evilgithub.com/…` 均判**同源**，绕过回退守卫（与注释 `:1023-1025`「否则就是装了个无关的包，比失败更糟」相悖）；反方向 `{url:'github:o/r'}` 被误判 false 而误拒回退。
- 建议：改成 `/(?:^|\/\/|@)github\.com[/:]/i` 并补 `github:` 简写分支。

**3-H6 `mergeDependencies` 在解析失败时用空对象覆写整份 package.json**
- 位置：`dshm-installer.js:654-662`
- `readJsonSafe(pkgPath) || {}` ⇒ profile/`package.json` 解析失败时，`name`、`dsh.profile` 其它字段、原 `bundles` **全丢**。同文件 `appendProfileBundle`（`:593`）对同一情形是 `return false` 不动文件 —— **两处处理相反**。
- 建议：统一为「解析不出一律不动文件 + 报错」，绝不用空对象覆写。

**3-H7 用户行后缀删除边界过窄 ⇒ 误删其它包的行**
- 位置：`dshm-installer.js:1246-1276 removeRowBlockByIdSuffix`
- 后缀边界只要求前一字符是 `-`/`/`/`@` ⇒ `&path:` 末段这类短词（`link`、`ui`、`runtime`…）会命中**属于其它包**的 `- id:` 行并连同续行整块删除。实测删掉 `@x/orca-link` 的行与 config。
- 影响面：`.dshm-plugin-rows.yml` 是**端侧插件页的用户数据**（`main.js:3667`、`PluginRows.ets:15`）。
- 建议：删除前用「完整 id 相等」而非后缀匹配；或先备份再改。

### 中

**3-M1 对 `<profile>/cordis.patch.yml` 的改写会被下次启动覆盖 ⇒ 改的是种子行**
- 位置：`dshm-installer.js:1484-1519`；该文件每次启动被核心种子整文件覆盖（`main.js:3766-3771`）
- 实测：删掉 `- id: web-runtime`，其 config 续行挂到上一条目；315 → 314 行。
- 建议：卸载时**不要**改写 `<profile>/cordis.patch.yml`（它是种子，改了也白改，还会破坏 YAML 结构）。

**3-M2 `extractTar` 抛错路径无 try/finally ⇒ tmp 残留**
- 位置：`dshm-installer.js:907`
- 实测：tar 越界拒解后 `.installer-tmp/<name>-<ts>` 目录与其中已解出的 `package.json` 仍在；全仓无回收逻辑（`installer-tmp` 仅命中本文件 `:836`/`:932`）。
- 建议：解包整段包 try/finally，失败即删 tmp；启动时顺带清一次 `.installer-tmp`。

**3-M3 `topPackageDisposition` 把 `dsh.bundles`（复数）也算 bundle**
- 位置：`dshm-installer.js:729-736`
- 问题：`dsh.bundles` 上游**无人读**，且不校验 patch 文件存在 ⇒ 装完 `registeredAfterInstall=true`，启动期 `dshm-user-rows.js:688-746 sanitizeDependencies` **立刻剔除**（实测 `strippedAtBoot=true`）；上游 `dsh-plugin-manager/lib/index.js:1786` 对无 `dsh.bundle` 的包直接抛 `not-bundle`。
- 建议：只认 `dsh.bundle`（单数）。

**3-M4 返回值语义过宽 ⇒「名字对不上什么也没删」与「本来没装」不可区分**
- 位置：`dshm-installer.js:1521-1526`
- 只要不抛错就 `ok:true`，`removed=[]` 时 note 固定「该插件本不存在（幂等）」。队列 `main.js:4162` 据此写 `.done`，假壳 `1572-1576` `cat` 后 exit 0。
- 建议：区分三种结果（删了 / 找不到候选 / 候选存在但删除失败），并在 note 里带上候选列表。

### 低

**3-L1 GitHub 形态无条件把 `owner--repo` 占位名加入候选**
- 位置：`dshm-installer.js:1391-1398`；正常链路落位时已被 `finalName = pkgMeta.name` 修正（`:991`）⇒ 只会制造噪声/极端情况误删。

**3-L2 不认 `{url:'github:o/r'}` 简写**
- 位置：`dshm-installer.js:543-548`；与同文件 `parseGitHub` 已支持 `github:` 前缀不一致。方向是**误拒、不越权**。

---

## 4. 路4：连接层与官方 gateway 语义

### 高

**4-H1 ★ 抖动成因定案：三份会被装载的 profile 补丁都没有心跳覆盖**
- 位置：`hostcore/profile/ondevice/cordis.patch.yml`、`dist/core/work/dsh-core-0.2.0-rc.2/profiles/ondevice/cordis.patch.yml`（均 315 行）、`dsh-base/cordis.patch.yml:48-53`
- 机制证据：`dsh-api-gateway/lib/index.js:172 MAX_MISSED_HEARTBEATS = 2`、`:236-252 startHeartbeat()` 内 `if (missed >= MAX_MISSED_HEARTBEATS)` → `setImmediate` 复查后 `socket.terminate()`；官方 `README.zh.md:89`「`websocketHeartbeatIntervalMs` 同时是 Ping 周期和 Pong 截止时间…如果部署的事件循环或网络可能停顿超过该间隔，**必须调大**」。
- 端侧实测记录（既有）：`connection/src/main/ets/protocol/RemoteMux.ets:294-305`「客户端回 Pong → 15s 保持；不回 Pong → 服务端 **5.4s** 关闭」；`Connection.ets:431-435`「设备侧 ArkTS 的 WebSocket 不回 Pong ⇒ 长连接必然周期性断开」。
- **修法（已在代码注释里写明却未落盘）**：`typert-gateway` 行下补 `config:`（整块替换语义，**两键都要写**）：
  ```yaml
  - id: typert-gateway
    config:
      websocketHeartbeatIntervalMs: 30000
      streamInboxBytes: 262144
  ```
  鸿蒙侧改完**必须** `node tools/pack-core.mjs` 重打包再重建 HAP（已在 `tools/pack-core.mjs` 的端侧补丁链里）。
- ⚠️ 注意：`C:\Users\Sol\.dsh\profiles\desktop\cordis.patch.yml`（121 行）同样**无** `typert-gateway` 覆盖 ⇒ Windows 端同源问题。

**4-H2 `ReconnectController.stopped` 是单向闩 ⇒ 一次「忘记 Host」后永不重连**
- 位置：`connection/src/main/ets/protocol/Backoff.ets:40,60-63,81-83`
- 唯一写点 `stop()` 置 true；`reset()`（`:48-51`）只清 `attempt` 与定时器、**不复活**；`schedule()` 首行 `if (this.stopped) { return; }`（**静默 return**）。
- `Connection.stop()`（`Connection.ets:474`）会调用它，而 `Connection` 实例由 `SessionHub` 构造时创建**一次**（`appstate/src/main/ets/store/SessionHub.ets:680`），`SessionHub` 是**模块级单例**（`:467-474 private static instance` / `static shared()`，**无 reset 出口**）⇒ 走过一次「忘记 Host」（`entry/src/main/ets/pages/Index.ets:3688`）后**再也不会自动重连**，且无日志无文案。全仓 `stopped = false` **0 命中**。
- 建议：`reset()` 必须清 `stopped`；且 `schedule()` 的静默 return 要记 diag。

### 中

**4-M1 事件流无就绪超时 ⇒「已连接」但 generation 从未生效**
- 位置：`connection/src/main/ets/protocol/EventStream.ets:61-86` + `Connection.ets:335-341` + `SessionHub.ets:753-766`
- 问题：`EventStream.open()` 只保证「开流帧已发出」，`Connection.start()` 也仅以该返回值判成功 ⇒ **Host 若接受了 mux 但永不发首项 `ready`**，`SessionHub` 仍会把 `phase = LIVE; unaryReady = true;`，界面上就是「已连接」，而事件流 generation **从未生效**。
- 证据：`EventStream.ets` 全文 145 行**无任何 `setTimeout`/`setInterval`**；官方同类实现有 **3s 慢响应告警** + **15s 就绪超时并中止**。
- 建议：加就绪超时（照官方 15s），超时即 `fail()` 并让 `Connection` 报错。

---

## 5. 路5：端侧桥与环境注入

> ⚠️ **取证方式如实说明**：首次 workflow 返回值被截断（§8 第 1 条），重跑长期无产出、
> `dist/review/p5-bridge-env.md` 从未生成。本节由**人工读源码复核**重写（`workflow-1` 已 kill）。
> 判据照 `docs/review-prompts.md:96-101` 的 5.1–5.4。

### 结论：**5.1 / 5.2 / 5.4 通过；5.3 有保留；另有 3 条注释与实物不符**

注入链**没有静默失效**：5 项 `DSHM_*` 全覆盖且**显式传值**，端口与 `main.js` 默认值不冲突，
全仓 `filesDir` 拼接都落在 `dsh/` 下或 filesDir 根的 diag 标记。唯一的保留是 5.3 ——
停止请求文件的**写入方**与**消费方**对它的生命周期理解不一致（与路2 的 2-H2 同一条根因，
不重复计数）。

### 中

**5-M1 停止请求文件两侧不对称：写入方失败时清理，消费方启动期不清理（与 2-H2 同一条根因）**
- 位置：`hostruntime/src/main/ets/runtime/DshHost.ets:633-668` ↔ `hostcore/app/main.js:3988-4003`
- 问题：`DshHost.stop()` 在 `port.stop()` 抛错时**会** `unlinkSync(requestPath)` 把请求文件清掉
  （`:656-665`，注释原话「留着请求文件会让**下一次启动**的宿主刚起来就自杀」）；
  而 Host 侧只在轮询体内 `fs.rmSync(stopFile, {force:true})` 消费它（`:3992-3994`），
  **启动期不做任何清理**。⇒ 写入方已经意识到这个危险并做了防御，消费方没有；
  两边对同一个文件的生命周期理解不一致。触发窗口：写请求成功 → 进程在 `port.stop()` 返回前
  被杀（崩溃/被系统回收）⇒ 请求文件留在盘上 ⇒ 下次冷启动约 1.5–4.5 s 内自杀。
- 证据：`DshHost.ets:630-631` 的注释与 `main.js:3988-4003` 的实现直接对照；
  `docs/50-端侧核心运行架构.md:201`（E90）记载该设计时只写了"①入口脚本巡检 / ②DshHost 写并清 / ③NodeRuntime 等"，
  **没有第四条"启动期先清残留"**。
- 建议：把清理挪到两侧都做 —— Host 引导早期（与 `mkdirSync(installQueueDir)` 同层，`main.js:4047-4050`）
  先 `rmSync(stopFile, {force:true})` 并记 diag；`DshHost.stop()` 的清理保留。
- 注：本条与 §2 的 **2-H2** 是同一根因的两个侧面（2-H2 从 Host 语义出发、本条从两侧不对称出发）。
  **只在 2-H2 计一条**，此处不重复计入总数。

**5-M2 `libnode.so.127` 的注释在 3 处仍留在代码里，实物是 `libnode.so.137`**
- 位置：`entry/src/main/ets/runtime/NodeRuntime.ets:72`、`entry/src/main/ets/entryability/EntryAbility.ets:271`、`entry/src/main/ets/pages/Index.ets:331`
- 问题：三处都写「它 `NEEDED` 的 `libnode.so.127`」/「`libdshhost.so` → `libnode.so.127`」，
  而 `entry/libs/arm64-v8a/` 下实物只有 **`libnode.so.137`**（126,809,264 B，无 `.127`）。
  这些注释描述的是**探测判据**（"libnode 加载成功"的观测方式），判据本身没错，
  但写死的 soname 会让人按 `.127` 去查设备而查不到。
- 证据：`Get-ChildItem entry\libs\arm64-v8a` 实测无 `.127`；`hostruntime/src/main/cpp/dshhost.cc:487-490`
  的 `kLibnodeCandidates[]` 已写成候选顺序（`.137` → `.127` → `.so`），
  `entry/src/main/cpp/CMakeLists.txt:108/189/216` 三处 `foreach` 同样带候选 ——
  **代码早就是候选查找，只有注释写死**。`docs/50-端侧核心运行架构.md:3-5` 有正式「版本口径提示」说明这是历史记录。
- 建议：三处注释改为「`libnode.so.137`（候选顺序查找，见 `dshhost.cc` 的 `kLibnodeCandidates`）」。

**5-M3 `RuntimePort.ets:141` 的 libnode 版本口径与 `docs/90` 已定的结论互斥**
- 位置：`entry/oh_modules/hostruntime/src/main/ets/runtime/RuntimePort.ets:141`（源在 `hostruntime/src/main/ets/runtime/RuntimePort.ets`）
- 问题：注释写「端侧 libnode 已升级到 **v24.2.0**」，理由是「fetch 已转正 ⇒ 不能带 `--no-experimental-fetch`」。
  但同一份注释引用的 soname 是 `.137`，而 `entry/src/main/cpp/CMakeLists.txt:104` 的注释写
  「26.x=.137、24.x=.127」、`:6` 提到「换到 26.7.0 的头文件」⇒ **同一个 soname 在三处对应三个版本口径**。
- 证据：`docs/90-DSH鸿蒙原生实现全流程.md:625-648`（§6.1）已把矛盾定案：二进制自述
  `v24.2.0-openharmony-arm64`、真机 `process.version=v24.2.0`，而 `runtimeVersion()` 返回的是
  **编译期头文件版本**（26.7.0）；`:748-776` 有两版对照表。
- 建议：`RuntimePort.ets:141` 后半句（"已升级到 v24.2.0"）改为「运行期 `process.version` 是 24.2.0，
  `runtimeVersion()` 是编译期头文件口径，两者不一致是已知事实（`docs/90` §6.1）」。
  注意：**结论（不能带 `--no-experimental-fetch`）仍然成立**，只是理由里的版本号要改口径。

### 低

**5-L1 `isWellFormedEnvPair` 只有单元测试消费者，生产路径不校验**
- 位置：`hostruntime/src/main/ets/runtime/RuntimePort.ets:203`（定义）；唯一生产调用点 `entry/src/main/ets/runtime/NodeRuntime.ets:121`
- 问题：`buildHostEnv` 产出的 6 条直接交给原生层 `dshhost.startHost(argv, env)`（`:124`），
  中间不过 `isWellFormedEnvPair`。校验实际发生在两处：① ArkTS 单测
  `entry/src/ohosTest/ets/test/CoreDecision.test.ets:216,220-223`；② 原生层
  `hostruntime/src/main/cpp/dshhost.cc:201-222`（`envBad` 计数 + `:334` 回传 `envApplied`）。
  ⇒ **不会静默失效**（原生层会数出来，`index.d.ts:34-39` 明确写了这条纪律），
  但 ArkTS 侧这个导出函数在生产路径上确实无人调用。
- 证据：全仓 grep `isWellFormedEnvPair` 命中 6 处，除定义外全在测试文件；
  `NodeRuntime.ets:125-126` 把 `res.envApplied` 写进了 hilog。
- 建议：要么把 `envApplied !== env.length` 变成 `NodeRuntime.start()` 的显式告警（现在只打日志），
  要么在注释里写明"这个函数是给单测钉边界的，生产路径由原生层计数兜底"，避免下一个人以为漏接了。

**5-L2 `NotWiredRuntime` 已是死代码，仅剩注释引用**
- 位置：`hostruntime/src/main/ets/runtime/RuntimePort.ets:91`（`notWiredProbe`）、`:214`（`class NotWiredRuntime`）、`:230`
- 问题：阶段一的"如实报告未接线"占位类，现在运行时只有 `NodeRuntime` 一条路径，
  该类的引用面**只剩两句注释**（`entry/src/main/ets/pages/Index.ets:3341`、`NodeRuntime.ets:4`）。
- 证据：全仓 grep `NotWiredRuntime|notWiredProbe` 命中 5 处：定义 3 处 + 注释 2 处，**零生产引用**。
  注意 `tools/check-dead-code.mjs` **扫不到它** —— 该门禁的 `SCAN_ROOTS` 是
  `['entry/src/main/ets', 'appstate/src/main/ets']`（`tools/check-dead-code.mjs:48`），
  **不含 `hostruntime`**；门禁实跑 `✅ 无死代码`（扫描 101 个文件）与这个事实不矛盾。
- 建议：删掉该类，或保留但把注释改为"阶段一占位，已由 NodeRuntime 取代，保留供对照"。
  顺带记：**门禁扫描范围不含 `hostruntime`/`platform`/`dshcompat`/`connection`**，
  所以"门禁绿"不等于"这四个模块无死代码"。

### 通过项（5.1 / 5.2 / 5.4，逐条给证据）

| # | 项 | 结论 | 证据 |
|---|---|---|---|
| 5.1 | env 注入 5 项全覆盖 | **通过** | `RuntimePort.ets:178-202 buildHostEnv()` 产 **6** 条 `KEY=VALUE`（5 项 `DSHM_*` @`:181-185` + `UV_USE_IO_URING=0`）；唯一生产调用点 `NodeRuntime.ets:119-121`；单测逐项钉住 `CoreDecision.test.ets:208-214`；原生层 `dshhost.cc:203-222` 逐条 `setenv()` 并计数（`:334 envApplied`）。**显式传，不依赖默认值**（`RuntimePort.ets:115` 注释明写） |
| 5.2 | 端口/目录不硬编码两次 | **通过** | `RuntimePort.ets:116 HOST_DEFAULT_PORT = 3120` 与 `main.js:587` 的 `'3120'` 同值同源；`NodeRuntime.ets:119` 取该常量传给 `buildHostEnv`；`main.js` 侧是 `process.env.DSHM_PORT \|\| '3120'` 的默认值兜底，不会冲突。其余 `3120` 命中（`Poc1.ets:56-57,101,345`）是诊断页输入框默认值，非运行时路径 |
| 5.4 | 不写预期外的路径 | **通过** | 全仓 `filesDir` 拼接 **61 处**逐条核对，全部落在 `dsh/` 子目录或 filesDir 根的 diag 标记/心跳文件：`runtime/`（NodeRuntime 5 处）、`entryability/EntryAbility.ets`（12 处，含 `dsh/home/host-exit-mode` @`:358`）、`pages/WebApp.ets`（11 处，含 `dsh/cores` @`:2029`）、`pages/Index.ets`（13 处）、`speech/`（HmsSpeechBridge 7 处 + SenseVoiceRecognizer 2 处）、`view/SettingsPlugins.ets`（2 处，`dsh/home/install-queue`）。**未见预期外路径** |

### 路5 的「无法验证」

- Host 进程实际拿到的 `envApplied` 是否恒等于 6（需真机 hilog —— `NodeRuntime.ets:125-126` 会打这一行，本次未连机）。
- `UV_USE_IO_URING=0` 在真机上是否确实必要（注释记的是 arm64 seccomp 直接杀进程的实测，本次未复现）。
- 5.3 的触发窗口是否真的可达（需要"写请求成功但在 `port.stop()` 返回前进程被杀"这一时序，本次未连机）。

---

## 6. 路6：工程纪律与残留（16 条：1 高 / 11 中 / 4 低）

### 结论：**红线成立**

**没有任何脚本执行删除 el2 用户数据的命令。** 全仓唯一触到 el2 路径的删除是
`tools/dshtest.py` 的 diag 探针 helper，调用面被限在 4 个自建标记文件。

6.1/6.2 干净：无 `repro_*`/`probe_*`/`close_*` 残留、无 `.bak`/`_old`、无 `TODO REMOVE`。
主要问题集中在 6.3/6.6：包名 `micverify` 的一整组文档与注释已被代码和**已构建产物**推翻；
`tools/` 工具清单与 `check-parity` 能力面清单两处「登记表」落后于磁盘/核心树；
另有 4 个脚本硬编码了他人机器的用户名路径（实测静默降级为 `unknown` 仍 exit 0）。

### 高

**6-H1 文档断言「当前处置 = 保持 bundleName 为 `com.dshm.micverify`」，代码与已构建 HAP 都已是 `com.dshm.dshclient`**
- 位置：`docs/device-validation.md:3170`、`:3513`、`:3523`；`docs/70-鸿蒙移植踩坑与修复总览.md:1174`、`:1184`
- 证据：`docs/device-validation.md:3170` 把「临时 `bundleName: com.dshm.micverify`」列为"出厂前**必须**改回"的待办、`:3513`「**仍是 `com.dshm.micverify`**」、`:3523`「保持」；`docs/70:1184`「**当前处置**：保持 `com.dshm.micverify`（构建绿、可装机验证）」（`docs/70:1174` 还写「`~/.ohos/config` 下**只有这一份** .p7b」）。
  实测代码：`AppScope/app.json5:3` 与 `build-profile.json5:39` 均为 `"bundleName": "com.dshm.dshclient"`。
  实测**已构建产物**（读 HAP 内 `module.json`，非读源码）：`entry-default-signed.hap`（314,166,762 B，2026-09-29 22:48）内 `module.json` 的 `app.bundleName = com.dshm.dshclient`，`pack.info` 同值 ⇒ **以 dshclient 成功通过并产出签名包**。
  ⇒ `docs/70` §11.10 的因果链（"改回必然 SignHap 失败、只能保持 micverify"）在 2026-09-27 之后已不成立。`~/.ohos/config` 现有 **4 套**签名材料（2026-09-27/28），与「只有这一份 .p7b」矛盾。
- 建议：`docs/70` §11.10 的"当前处置"改为"已于 2026-09-29 改回 `com.dshm.dshclient` 并成功构建（证据：HAP `module.json`/`pack.info`）"；`docs/device-validation.md:3170` 的待办标记完成并移入历史段。

### 中

**6-M1 `build-profile.json5` 注释的结论与紧邻的代码行相反**
- 位置：`build-profile.json5:25-38`（副本 `build-profile.local.json5:25-38`）
- `:31-38` 注释写「【2026-09-27 为什么改不回去】…⇒ 这是交付步骤；**在那之前保持 micverify**」，紧接 `:39 "bundleName": "com.dshm.dshclient"`。`:25-29` 仍写「【麦克风验证专用，临时】换成独立 bundle 名 ⇒ 安装时不会碰 `com.dshm.dshclient` 那份真机数据」。
- 建议：删掉两段失效临时态说明，或改写为"历史：2026-09-27 曾计划保持 micverify；2026-09-29 已改回并验证构建通过"。

**6-M2 `tools/update-device.ps1` 的「红线自检」（Step 0）漏判常见等价写法**
- 位置：`tools/update-device.ps1:50-74`（规则在 `:58`、`:63`、`:65`、`:67`）
- 规则：`:58 $UNST = 'unin'+'stall'`；`:63` 形态一 `$t -match '[&$]\s*hdc\b' -and $t -match $UNST`；`:65` 形态二 `\bbm\b` + `$UNST`；`:67` 形态三 `'rm'+'\s+'+'-rf'`。
- 实测（同一正则逐行套用）：**裸 `hdc uninstall`（AGENTS.md 的第一条禁止示例）不命中**（不以 `&`/`$` 开头）；`& $hdc uninstall` 命中；但 `hdc shell bm uninstall -n …`、`rm -fr`、`rm -r -f`、`Remove-Item -Recurse -Force`、`pm clear`、`bm clean -n … -d` **全部 MISSED**。
- 影响面：当前**无实际后果** —— 该脚本全文无任何卸载/删除调用（唯一装机动作 `:128 & $hdc install -r $Hap`，失败时 `:133-135` 提示"先问用户，不要自行卸载"）。但它自称"让删数据这件事在流程里不存在"，这道自检**守不住改写**。
- 建议：改为"命令词集合 + 等价形态"：任何含 `uninstall` 的行都拦（不限前缀）、`rm` 允许 `-rf|-fr|-r -f|--recursive.*--force`，并补 `Remove-Item\s+.*-Recurse`、`pm\s+clear`、`bm\s+clean`、`el2` 路径字面量四条；另加白名单例外须行尾写 `# allow: 理由`。

**6-M3 `.local-rules/build-status.local.md:52` 直接教人删除 el2 路径下的 `dsh/cores/<ver>`**
- 位置：`.local-rules/build-status.local.md:52`
```
52: $hdc shell "rm -rf .../files/dsh/cores/0.1.6-alpha.2"    # 仅当 zip 内容变（版本号不变也要！）
```
- `.../files/` 即 `docs/90-DSH鸿蒙原生实现全流程.md:2528` 实测的 `/data/app/el2/.../haps/entry/files/`（el2 用户数据域），同文档 `:2530` 明写「`el2` = **用户数据（不可删）**」，`hostcore/app/main.js:3731-3741` 亦以"旧 cores 目录不删可回退"为设计前提。全仓扫描（`rm -rf|uninstall|el2|bm clean|pm clear`，排除 node_modules/oh_modules/.git/.hvigor/build/dist/third_party/.research）在本目录**只有这一条**命中 ⇒ 工作区内唯一"教人删 el2 路径"的文本。
- 加重因素：`.local-rules/` 被 `.gitignore:19` 忽略、未被 git 跟踪，但 `docs/90:4120`/`:4121` 把同目录的 `current-machine.local.md` 当作可引用的事实来源 ⇒ 后来者会把该目录当"本机事实"读。
- 建议：该行删除，或改为「先 `mv` 旧 `cores/<ver>` 为 `<ver>.stale-<ts>.tmp`（`CoreStore` 会忽略 `.tmp`，见 `hostruntime/src/main/ets/core/BundledCore.ets:115-135`），确认新树起来后再清」——与 App 内既有工艺一致，不做原地 `rm -rf`。

**6-M4 `tools/neg-test-piai.mjs` 把「门禁根本没跑成」判为 PASS（静默失败路径）**
- 位置：`tools/neg-test-piai.mjs:26-28`、`:70-81`
- `:26-28` 用 `out.split('\n').filter(l => l.includes('✗'))` 计数；`:70-81` 还原后段同样只看 `fails.length === 0`，**不看退出码**。
- 实测被它驱动的门禁在环境缺失时的输出：`node tools/check-layout-fixtures.mjs` → **exit 3**「环境受阻：找不到 tsc…⚠️ 这是"没跑成"，不是"通过"」，既无 `✗` 也无 `断言 ` 摘要 ⇒ 该脚本打印 `PASS — (none)`，与本机实际 exit 3 **相反**。这正是 `docs/70` §8.14 自己定为"比负测试失败更危险"的形态（**检测手段自己静默失效**）。四处锚点校验只保证篡改真发生，不保证门禁真跑。
- 附带风险：全文无 `try/finally` —— `:16 writeFileSync(MOD, mutatedMod)` 变异后，`:69` 的还原只在正常流程执行 ⇒ 异常跳转时 `appstate/src/main/ets/model/PiAiProviders.ets` 会**留在变异态**（违反 AGENTS.md 的"临时实验必须在同一次改动内还原"）。
- 建议：`run()` 把 `code === 3` 判为"未跑成"并计入失败；`:69` 的还原移进 `try/finally`，在 `finally` 里再跑一次门禁并断言源文件 sha256 与初始一致。

**6-M5 4 个脚本硬编码他人机器的用户名路径，实测静默降级为 `unknown` 且仍 exit 0**
- 位置：`tools/compat-drift.mjs:34-35`；`tools/gen-compat-endpoints.mjs:27-28`；`tools/protocol-enum2.mjs:17-18`；`tools/dev-host.mjs:73-77`
- 三处同一字面量：`process.env.DSH_NODE_MODULES ?? 'C:\\Users\\aotian\\AppData\\Roaming\\io.github.hairyf.deepseek-harness-desktop\\dependencies\\dsh\\node_modules'`。本机实测 `Test-Path` → **False**（`$env:USERPROFILE = C:\Users\Sol`，`DSH_NODE_MODULES` 未设置）。
- 静默路径实测：把快照复制到无 `.meta.json` 的临时目录、`DSH_CONTRACTS` 指过去 ⇒ 打印「当前环境核心包 : **@deepseek-ai/dsh unknown**」、**✅ 无漂移**、**exit=0**（`compat-drift.mjs:164-169 catch { return 'unknown'; }`）。
- 生成器同类：`gen-compat-endpoints.mjs:49-54` 同样 `catch → 'unknown'`，而 `:271` 会把它写进生成物的 `corePackage` / 注释头（当前已提交文件为 `0.2.0-rc.2`，未被破坏；**风险在下一次重生成**）。
- 同仓已有反例与结论：`tools/protocol-contract.mjs:35-38` 自述「原先兜底成了一个**硬编码的用户名**…换机器必然找不到上游，`compat-drift` 于是**静默失效**——门禁失效比门禁报错更糟」，`:40-54` 改为 `homedir()` 推导 + 找不到即 `exit(1)`。⇒ 另外三个文件**未跟进**这一决定。
- 建议：三个文件照抄 `protocol-contract.mjs:40-54`；`gen-compat-endpoints.mjs` 在三处都拿不到版本时改为失败退出，**不要把 `'unknown'` 写进生成物**。

**6-M6 `docs/50` §15「tools/ 工具清单」只登记 26 个脚本，磁盘上有 58 个（29 个未登记）**
- 位置：`docs/50-端侧核心运行架构.md:1324-1368`（§15.1/15.2/15.3 三表）；`docs/70:597`
- 三张表内反引号脚本名去重计数 = **26**；`Get-ChildItem tools -File` 顶层 60 项，其中脚本 = **58**。未进三表的 **29** 个里包含 AGENTS.md 点名的必跑门禁：`assert-cli-shim.mjs`、`assert-exec-fix.mjs`、`assert-fs-search-fallback.mjs`、`assert-python-bridge.mjs`、`assert-resfile-sync.mjs`、`check-dshm-installer.cjs`、`check-doc-refs.mjs`、`update-device.ps1`。
- 该节自述目的正是解决这个问题（`docs/50:1326-1327`「核对发现 `tools/` 下 **10 个脚本在文档里 0 次出现**——不是它们没用，而是**没人写下来**」），而 `docs/70:597-598` 已以完成态引用它。反向核对：表中**无**"已删但仍在列"的条目 ⇒ 方向是欠登记，不是失效引用。
- 建议：至少把 8 条必跑门禁 + `update-device.ps1`/`place-toolchain.mjs`/`dshtest.py`/`func_test_final.py`/`publish-gitcode.sh`/`switch-signing.sh` 补进 §15；或把 §15 改为"由 `tools/` 目录 + 每个脚本头部注释自述"并给出批量核对命令，避免清单再次腐烂。

**6-M7 `check-parity.mjs` 的官方能力面清单来源版本仍是 0.1.2-alpha.1，其自设的「必须复核」未执行**
- 位置：`tools/check-parity.mjs:34-55`（`OFFICIAL_SURFACE` 在 `:46-55`）
- `:37` 写「本机安装的官方客户端包 `@deepseek-ai/dsh`（**0.1.2-alpha.1**）依赖树里全部 `dsh-client-ui-*`（38 个）…」；`:42-44` 自设「【必须复核】…**上游新增了能力面而本表没跟上，就是"门禁通过但没覆盖到"**」。
- 当前实际：`hostcore/core-recipe.json:3 "coreVersion": "0.2.0-rc.2"`（`compat-drift.mjs` 实测打印 `0.2.0-rc.2`）⇒ **来源版本与在跑核心差 5 个版本**，而 `OFFICIAL_SURFACE` 字面量计数仍 = 39（与门禁输出一致）⇒ 清单**自 0.1.2-alpha.1 起未变**，复核未做。
- 对照当前核心树：`dist/core/work/dsh-core-0.2.0-rc.2/node_modules/@deepseek-ai/` 下实有 **53 个** `dsh-client-ui-*`（+ `dsh-client-locale`，合计 54）。不能说 15 个差额都该独立成行（本仓对 `sidebar-*`/`settings-*` 有"粗化成一个 id"的惯例），**可断言的是复核没做**。
- **差额已逐条枚出**（2026-09-30 复核，可复现）：门禁清单 38 个 ui 名 + 1 个 `client-locale`；rc.2 树里多出的 15 个是
  `open-in-app`、`plugin-manager`、`schedule`、`settings-account`、`settings-agent-loop`、`settings-session-log`、
  `settings-shell`、`settings-subagent`、`settings-web-search`、`shortcuts`、`sidebar-browser`、`sidebar-documentpreview`、
  `sidebar-files`、`sidebar-right`、`sidebar-terminal`。**同一个 15 个的差集在 `0.1.7-rc.2` 上就已经有 14 个**
  （只差 `settings-session-log`）⇒ 这不是 rc.2 引入的，是清单从 `0.1.2-alpha.1` 起就没再对过。
- **第三份独立清单可作复核基准**：`dsh-web-app/package.json` 的 `dependencies` 共 127 条，其中 `dsh-client-ui-*` / `dsh-client-locale` **51 条**，与门禁清单的差集**恰好是上面 15 个**（`locale` 即 `client-locale`）。
  ⇒ "官方能力面"在打包形态下**由 `dsh-web-app` 的依赖表给出**，比"数目录"更稳（目录里可能有未启用的包）。
- **端侧对它们的实际处置不均**（这是"该不该建行"的判据）：`hostcore/profile/ondevice/cordis.patch.yml` 只显式碰了 3 个 ——
  `open-in-app`（`:121-125`，注释说明端侧无对应物，`disabled: true`）、`sidebar-browser`（`:313`）、`sidebar-terminal`（`:85` 注释）。
  其余 12 个**端侧一个字都没提**，即走 `dsh-web-app` 的默认启用面 ⇒ 它们**是端侧真实装载的能力面**，只是矩阵与门禁都没登记。
- 建议：跑 `:39` 给的复现命令对着 `dist/core/work/dsh-core-0.2.0-rc.2/node_modules`，**改用 `dsh-web-app/package.json` 的依赖表**作为基准；把 39 个 id 的**粗化判据**写进 `docs/parity-matrix.md`（哪些包并入哪个 id、哪些刻意不建行 —— 至少 `open-in-app` 属"端侧明确禁用"，与"未登记"性质不同），并更新 `:37` 的来源版本为 `0.2.0-rc.2`。

**6-M8 `docs/README.md:38` 断言「本仓不是 git 仓库（无 `.git/`）」，与实测相反**
- 实测：`Test-Path .git` → **True**；`git rev-parse --is-inside-work-tree` → **true**；`git rev-list --count HEAD` → **3**（均 2026-09-27）。
- 影响：`docs/README.md` 是"判据以谁为准"的落地页，一句"没有 `.git/`"会让人按"未入库"行事（把 `git add -A` 当成安全、不去检查忽略规则）⇒ 与 `docs/70` §8.11 定为"比单个 bug 更危险"的"文档说了、配置没做"同族，只是方向相反。
- 建议：删掉该半句，或改为"本仓是 git 仓库（3 个提交）；`.gitignore` 边界见根 `README.md` 的「不入库的产物」表"。

**6-M9 门禁读数陈旧：`docs/50` 的「52 库」与「64 个文件」**
- 位置：`docs/50-端侧核心运行架构.md:950`、`:2429`
- `:950` 注释写「原生依赖闭包（**52 库**）」；实测 `node tools/check-native-closure.mjs` → exit 0「**59 个库**；系统库白名单 25 项」（清单含 `libnode.so.137`、`libdshhost.so`、`libkoffi.so`、`libpty.so`、`libsharp-openharmony-arm64.so`、`libvips.so`/`libvips-cpp.so`、`libsherpa*`；2 条 warning 为 SONAME 与文件名不一致）。
- `:2429` 写「架构门禁 `arch-check.mjs`：✅ 无违规 —— 扫描 **64 个文件**」；实测「扫描文件 **133 个**」。
- 建议：两处改为实测值或去掉数字（"库数随原生件增减，读数以当场实跑为准"）；`:2429` 位于"§15.5 本轮实跑发现"，建议显式标注"历史读数"。

**6-M10 `0xD5A1` 在同一目录树内被 13 处各自独立声明，且同时承载 hilog domain 与 event id 两种语义**
- 位置：`platform/src/main/ets/system/HostEvents.ets:2`、`:14-17`、`:24`、`:26`
- `HostEvents.ets:2` 自称「本文件是**唯一**定义处」，`:14-17` 讲「改了一边、另一边不报错，只是**永远收不到通知**」，`:24` 写「DSH 的固定前缀 `0xD5A1`」。
- 实测 `0xD5A1` 命中 **13 处数值声明 + 1 处注释**：`notify/KeepAlive.ets:25`、`notify/NotificationCenter.ets:23`、`system/Clipboard.ets:12`、`system/DeviceFacts.ets:18`、`system/FilePicker.ets:32`、`system/HostStore.ets:31`、`system/LocalPrefs.ets:27`、`system/OpenLink.ets:20`、`system/SecretStore.ets:33`、`system/ShareBoard.ets:17`、`window/WindowMemory.ets:21`、`window/WindowRegistry.ets:22`（这 12 处是 **hilog domain**）+ `HostEvents.ets:26`（**event id**）。
- 事件契约本身**确实是单一来源**（`entry/src/main/ets/pages/Index.ets:34-37,246-248` emit、`EntryAbility.ets:51-53,1122-1127` on，都 import `platform` 的常量，无第二份数字字面量）⇒ 该注释的**主张成立**；成问题的是同一个数字被赋予**两种语义**、12 份声明无一处集中，而 `:24` 只把它称作"固定前缀"、未说明与那 12 处 domain 的关系。全仓 `docs/` 检索 `0xD5A1` **0 命中** ⇒ 这个跨层数字没有任何文档登记。
- 建议：在 `platform` 下增设 `export const HILOG_DOMAIN: number = 0xD5A1`，12 个文件改为 import；事件 id 建议改用与自己 domain 无关的独立值，避免"同数字两语义"。

**6-M11 `tools/node-runtime/sync-node-headers.sh` 硬编码另一台机器的绝对路径并对其 `rm -rf`**
- 位置：`tools/node-runtime/sync-node-headers.sh:22`、`:35`
```
21: SRC="${1:-$HOME/ohos/node-v22.23.2}"
22: DEST="/mnt/d/Develop/deepseek-harness-desktop-HarmonyOS/entry/src/main/cpp/node-headers"
35: rm -rf "$DEST"
```
- `SRC` 可传参而 `DEST` 不可；`/mnt/d/Develop/…` 既非本仓库路径（本仓库为 `D:\desktop\temp\desktop.ohos.arm64`），也不在 WSL 侧按 `$(dirname $0)` 推导 —— 是**本机另一份**检出的名字。删除目标在仓库内（属 README 列入"不入库的产物"的目录），**不涉及 el2 用户数据**，但若那台机器上该路径存在，脚本会清掉那份检出的同目录。
- 建议：`DEST="$(cd "$(dirname "$0")/../.." && pwd)/entry/src/main/cpp/node-headers"`，或同样做成第二参数；`rm -rf` 前加 `case "$DEST" in */entry/src/main/cpp/node-headers) ;; *) echo "refusing: $DEST" >&2; exit 1;; esac` 护栏。

### 低

**6-L1 `tools/device-acceptance.ps1` 头部注释与实现不符**
- 位置：`tools/device-acceptance.ps1:13-15`（实现 `:148-182`）
- `:13-15` 写「它不做什么：· **不做通过/失败判断**」，而 `:148-182` 有 `Add-Verdict` 六项自动判定（设备在线 / 核心已启动 / 客户端已接入 / 平台标识 = ohos / 文件变更流已开 / 无崩溃记录）并写 PASS/FAIL 表；`docs/50:1364` 也记「**自动判定 6 项**…报告分"自动判定"与"需人眼看"两栏」⇒ 头部是旧残留，方向是"注释弱于实现"，非功能缺陷。
- 建议：`:13-15` 改为「自动判定 6 项可脚本化的读数；行为与呈现类项留作人眼勾选」。
- **2026-09-30 已修**（本轮改动，非审核动作）：脚本重写为 307 行，头部注释如实写明判据与坑（`tools/device-acceptance.ps1:13-25`），自动判定由 6 项改为 **5 项**（`tools/device-acceptance.ps1:240-244`）——`DSHM-AUTH connect` 与 `files changes opened` 两条因产出点结构性不可达/无稳定信号而**撤销或降级为人工项**；`docs/50` 对应表行同步（§15.3）。本报告其余条目仍按"只审不改"保留。

**6-L2 功能接线计数的三处互斥数字（`docs/50` 17、README 16→17，实测 18）**
- 位置：`docs/50-端侧核心运行架构.md:1338`；`README.md`、`:216`、`:228`
- 实测 `node tools/check-feature-wiring.mjs` → exit 0，`# 功能接线回归（扫描 135 个文件，18 个功能，1 条反面规则）`；而 `docs/50:1338` 写「对 **17 个**已实现功能检查」，`README.md` 写「16 → 17」、`:208` 写「第 16 条」、`:228` 又写「**第 18 项**」⇒ README **内部自相矛盾**，两文档都停在 17。
- 建议：三处改为"以 `check-feature-wiring.mjs` 输出为准（当前 18）"，或把计数从文档里去掉，只留命令。

**6-L3 `tools/dshtest.py` 的 `clear()` 是全仓唯一会删 el2 路径下文件的 helper（无护栏）**
- 位置：`tools/dshtest.py:56-57`、`:175-176`；调用方 `tools/func_test_final.py:117-119`
```
56: APP = 'com.dshm.dshclient'
57: FILES = f'/data/app/el2/100/base/{APP}/haps/entry/files'
175: def clear(name):
176:     sh(f'rm -f {FILES}/{name}')
```
- 调用方只有一处，`name` ∈ 4 个 ArkTS 侧自建 diag 标记（`diag-pick-called`/`diag-select-returned`/`diag-resolve-dispatched`/`diag-persist-done`）。同文件 `:77` 与 `device-acceptance.ps1:50` 的删除都在 `/data/local/tmp`，非 el2。除本 helper 外，**全仓没有任何脚本**删除 el2 路径下的东西。
- 风险面（据实限定）：`rm -f` 对目录无效，且 `name` 是单段 ⇒ 当前可删范围只是 `files/` 直属文件；但 API **无任何前缀/白名单约束**，未来 `T.clear('dshm-host.log')` 或 `T.clear('host-ready.json')` 都会静默生效。
- 建议：`clear()` 加护栏 `if not name.startswith('diag-'): raise ValueError(...)`。

**6-L4 `tools/check-store-readiness.mjs` 硬编码 bundleName，与 `AppScope`/`build-profile` 共三份**
- 位置：`tools/check-store-readiness.mjs:36-38`（`const BUNDLE_NAME = 'com.dshm.dshclient';`）
- 注释解释了历史上换过名，但实现是字面量，**不读** `AppScope/app.json5:3`。同值另见于 `build-profile.json5:39`、`build-profile.local.json5:39`、`tools/build-profile.template.json5:29`、`entry/src/main/ets/system/StatusBarTray.ets:51`、`tools/dev-host.mjs:62`、`tools/device-acceptance.ps1:111,115`、`tools/dshtest.py:56`、`tools/update-device.ps1:36`，共 **11 处**。
- 影响：改包名时这道"上架红线"不会跟着变（当前值与代码同值，故无实际后果）。
- 建议：从 `AppScope/app.json5` 读 `app.bundleName` 作为期望值（与 `check-parity`/`scan-core-plugins` 读 `core-recipe.json` 的做法一致）。

### 路6 的「无法验证」

- `docs/50:1342`「布局 fixture 共 **768 条**」：本机 `check-layout-fixtures.mjs` exit 3（找不到 tsc），条数无法复核；静态计数不可用（该文件用的不是 `check(` 命名）。
- 需真实上游/核心树才跑得动的门禁，其"当前形态"论断未核：`check-web-fetch-jitless.mjs`、`check-origin-fence.mjs`、`check-plugin-toggle.mjs`、`check-model-roundtrip.mjs`、`check-arkts-entry.mjs`、`check-user-rows-preflight.cjs`、`check-dshm-installer.cjs`、`check-layout-fixtures.mjs`。（本轮实跑通过并记录读数的是：arch-check、check-parity、compat-drift、check-native-closure、check-feature-wiring、check-dead-handlers、check-store-readiness、check-design-tokens、check-icon-assets、check-toolchain-sign、check-doc-refs、check-skill-sync、assert-cli-shim、assert-resfile-sync、assert-exec-fix、assert-python-bridge、assert-fs-search-fallback、assert-report9-fixes、assert-speech-syntax。）
- 真机相关论断无设备可复现。其中 `docs/50:977` 已被静态证据推翻一半：`hostcore/profile/ondevice/package.json:13 "removeBundles": []` 为空清单，而 `hostcore/app/main.js:3738 if (removedNow.length > 0)` 才打印该行 ⇒ 该预期读数**现在不可能出现**；但"该行是否算不一致"取决于 `docs/50` §12.9 是"验收记录模板"还是"当前预期"，这一节性质未在文档内找到明确声明，故不计为问题。
- `tools/` 顶层仅 3 个文件未被任何文档提到：`build-profile.template.json5`、`publish-gitcode.sh`、`switch-signing.sh`。经阅读判定为长期发布/签名工具而非临时脚本，故不计为 6.1 违规；"是否该登记进 §15"属判断，未定论。
- `.local-rules/` 是否仍在被维护、`docs/90:4120-4121` 引用它的强度如何，无法从仓库证据判定。
- 6.5 全仓扫描口径与结果：按 `uninstall|bm uninstall|rm -rf|rm -fr|rm -r -f|Remove-Item -Recurse|pm clear|clearCache|bm clean|data/app/el2|el2` 扫描（范围 `tools/`、`hostcore/`、`hostruntime/`、`entry/src/`、`platform/`、`connection/`、`appstate/`、`dshcompat/`、`.local-rules/`；排除 node_modules/oh_modules/.git/.hvigor/build/.cache/.research/third_party/dist），**实际执行删除的仅**：`tools/device-acceptance.ps1:50`（`/data/local/tmp`）、`tools/dshtest.py:77`（同）、`tools/dshtest.py:176`（el2 下 diag 标记，见 6-L3）、`tools/node-runtime/*.sh`（`/tmp`、`out/Release/obj.target/*`、仓库 `node-headers`）、`tools/electron-runtime/*.ps1`（vendored 目录）。其余命中全部是注释、`Write-Host` 文案、自检规则文本，或 App 侧对临时文件的删除。

---

## 7. 路7：端侧 UI 对官方能力的遮挡

> ⚠️ **取证方式同上**：首次 workflow 返回值被截断，重跑未产出 `dist/review/p7-ui-occlusion.md`，
> 本节由人工读源码复核重写。判据照 `docs/review-prompts.md:120-131` 的 7.1–7.4。

### 结论：**7.1 / 7.2 / 7.4 通过，7.3 不通过 —— 壳干净，问题在矩阵声明**

四条判据里三条真通过（不是"没查出问题"，是有正向证据），
唯一不通过的是 **7.3**：`docs/parity-matrix.md` 声明的 `DONE` 里有若干行的「Harmony 界面」列
指向的 `view/**` 原生树**在当前构建形态下不可达**。这不是"实现没做"，而是"台账把实现侧完成
说成了另一种意思"——恰好是 §1.2 那条硬规则（"任何 DONE 行都不得被读作已在设备上验收通过"）
要防的东西。

### 中

**7-M1 矩阵里 5 个 `DONE` 行的「界面」列指向不可达的原生 UI**
- 位置：`docs/parity-matrix.md:300`（`chat`）、`:305`（`goal`）、`:335`（`settings`）、`:352`（`dshm-core`）、`:356`（`dshm-hosttrust`）
- 问题：这 5 行的 `Status` 列是 `DONE`，而「Harmony 界面」列给的是 `ConversationPane`/`DetailPane`、
  `Index.ets` 目标栏、`SettingsPane`、`CorePane`、`ConnectPane` —— 全在 `entry/src/main/ets/view/**`
  与 `pages/Index.ets` 里。而生产入口是 `EntryAbility.ets:671 windowStage.loadContent('pages/WebApp')`，
  且全仓 grep `pages/Index` 在 `.ets/.json/.json5` 里**零命中**（无 `router.pushUrl` 指向它），
  `pages/WebApp.ets` 从 `../view/` import 了 **0** 个文件 ⇒ 这 5 行的界面部分**当前用户碰不到**。
- 证据：`docs/parity-matrix.md:370-374` 的统计表（`DONE` 14 行，`node tools/check-parity.mjs` 实算一致，exit 0）；
  14 个 `DONE` 行里，界面列指向 `Index.ets`/`view/` 的是 **5 个**（另 9 个指向 `Composer`/`EntryAbility` 或标 `view/` 之外的消费者）。
  矩阵总计 50 行、104 个 `|`-分隔行、**17 行**的界面列提到 `Index.ets`/`view/`（含 12 个非 `DONE` 行）。
  原生树体量：`view/` **50 个文件 / 13,281 行**；`pages/Index.ets` **4,406 行**。
- 判断：**不建议改状态**。`DONE` 的口径本来就是"实现侧完成"（`docs/parity-matrix.md:24` 明写），
  实现确实完成了。建议在 §1.2 的硬规则旁**补一行**：`DONE` 行的界面若只落在 `view/**`/`pages/Index.ets`，
  必须在「界面」列或 §6 注明"当前构建形态经 WebView 承载，该界面不可达"。
  根因是**通路事实变了而台账没跟着记**（`loadContent('pages/WebApp')` 是后来的决定）。
- 注：本条与 §0 的「通路事实」是同一件事的**台账侧**表现；§1 的问题（1-H4、1-H1/1-H2/1-H3）是**代码侧**表现。

### 低

**7-L1 顶栏「应用」菜单缺官方 win32 的「检查更新」**
- 位置：`entry/src/main/ets/pages/WebApp.ets:2091-2163 appMenu()` = 仅 `主页 / 刷新 / 关于版本` 三项
- 问题：官方 win32 的 `applicationItems()`（`apps/desktop/lib/main.js:11268-11308`）是
  `关于 + 分隔 + 检查更新 + (dev-only 重新加载页面/重启应用宿主) + 分隔 + 退出应用`。
  端侧少了「检查更新」。这是**合理裁剪**（端侧没有自动更新通道：核心版本由 HAP 内嵌的 zip 决定，
  升级路径是重新装机），但矩阵与文档都没有把这个裁剪**记下来**。
- 证据：官方菜单逐项见 `D:\LLM\deepseek-harness\apps\desktop\lib\main.js:11268-11308`；
  端侧只有三项（`WebApp.ets:2092-2101`）。另：官方的「退出应用」是 `role:'quit'`，
  端侧**移到了托盘右键**（`StatusBarTray.ets:20-28` 注释 + `:169-173` 的 `MENU_CODE_OPEN='dshm.tray.open'`），
  与官方 `apps/desktop/lib/types/tray.js` 的 `[openApplication, 分隔, quitApplication]` **完全同构** ⇒ 7.2 成立。
- 建议：在 `docs/parity-matrix.md` 的 §6 或对应行登记"顶栏 '检查更新' 因端侧无自动更新通道而裁剪"，
  避免下一个人当成漏做。

### 通过项（7.1 / 7.2 / 7.4，逐条给证据）

**7.1 注入层不做任何隐瞒 —— 通过。**
`pickerShimScripts`（`WebApp.ets:1351-1356`）= `PICKER_SHIM_JS`(`:273`) + `DESKTOP_CARRIER_JS`(`:223`) +
`THEME_SHIM_JS`(`:352`) + `OPEN_LINK_SHIM_JS`(`:454`)，四段全部 `scriptRules:['*']`，
逐段读过：`DESKTOP_CARRIER_JS` 只补 `globalThis.dshDesktop = { protocolVersion: 1 }`；
其余三段是幂等守卫（`__DSHM_THEME_SHIM__` / `__DSHM_OPEN_LINK_SHIM__`）+ 桥调用。
全文件 grep `style.display|style.visibility|remove()|removeChild|outerHTML|display:none|hidden=true`
⇒ **零命中**。**垫片只做加法，不隐藏、不删除任何官方 DOM**。这是 7.1 最直接的正面证据。

**7.2 原生新增项必要且未放进官方菜单误导 —— 通过。**
顶栏只有「应用」「编辑」两个菜单（`WebApp.ets:2310-2311`），与官方 win32 的两个 popup 一一对应；
「编辑」菜单（`:2166-2191`）逐项 = `撤销/重做/剪切/复制/粘贴/删除/全选`，与官方
`apps/desktop/lib/main.js:11370-11380` 的 `edit` 逐项一致（含顺序与快捷键分工）。
`appMenu()` 里**刻意不提供「退出应用」**，注释（`:2102-2112`）写明理由：
顶栏「关闭」已是切后台（`onPrepareToTerminate` 返回 `true` + `hideAbility()`），
把"真退出"放同一视觉区域会点错；托盘右键是系统级常驻位置，与微信同款语义。
`StatusBarTray.ets:20-28` 补充说明**系统托盘自带的右键菜单里已经有「退出」且真机实测真的会退出**
⇒ 再挂一个只会得到两个退出项，所以端侧只补系统没有的「打开应用」。
**7.2 的两个子句都满足**（原生新增项必要：托盘保活 + 冷启动通道 + 语音桥；
不放进官方菜单：「退出应用」已被移到托盘）。

**7.4 无 App 内测试菜单 —— 通过。**
`appMenu()` 的实际返回只有 3 项（`WebApp.ets:2092-2101`），其后 `:2102-2160` **整块是注释**，
记录了已移除的 **9 个自检/探针入口**（麦克风可行性、HMS 可行性、路线A 端到端、重放、截短重放、
同时同源对照、关 AEC 对照、文本插入探针、TTS 自证）—— 每段注释都写了"为什么当初要它"。
grep `runReplayProbe|runTruncateProbe|runMicProbe|runHmsProbe|runTtsProbe|selfTest` 全仓只在
`WebApp.ets:2135`/`:2140` 的**注释**里出现 ⇒ **无存活的自检入口**。
另核 `WebApp.ets` 的 40 个 `private` 方法清单（`:709`–`:2278`），无一个是自检/探针方法。

> 顺带记两条与 7.x 相关但**不构成本路问题**的事实：
> ① `insertTextIntoComposer` 用的 `INSERT_TEXT_JS`（`WebApp.ets:159`）在文件内**只剩定义、无调用点**
>    （全仓 grep 仅命中 `:159` 一处）—— 门禁 `tools/check-dead-code.mjs` 实跑 `✅ 无死代码`，
>    因为它只扫 `entry/src/main/ets` 与 `appstate/src/main/ets`（`tools/check-dead-code.mjs:48`）里的
>    **import / @Builder / 组件成员 / 门面字段**四类，**顶层 `const` 与私有方法都不在其判定面内**。
>    这是一条**门禁覆盖边界**，与 §5 的 5-L2（`hostruntime` 不在扫描范围）同源，建议一并记进 §6。
> ② `editMenu` 的「粘贴」走 `document.execCommand('insertText', ...)`（`WebApp.ets:2080`）
>    而不是 `INSERT_TEXT_JS` ⇒ 上面那个死常量**不是**粘贴路径的遗留，是另一条探针路径的遗留。

### 路7 的「无法验证」

- 官方 win32 之外平台（darwin/linux）的菜单项差异未比对（本机只有 win32 产物可读）。
- 托盘右键「打开应用」`menuCode`/`notifyOnly` 在真机上的实际可用性已有历史实测记录，但**本轮未连机复测**。
- WebView 承载下官方 UI 是否有任何**端侧特有的**功能缺失（需要真机逐项点检，非静态可判）。

---

## 8. 关于本次审核的方法学备注（值得留档）

1. **7 路并行审核的返回值会被工具截断**。完整格式化结果约 207 KB，落盘文件
   `%TEMP%\dsh-spill-*\…-workflow.txt` 只有 346 行 / 72 KB，**在路4 第 3 条中途断掉**
   （`[truncated: 134732 more characters]`）⇒ 路5/6/7 的条目**不在任何落盘文件里**。
   **教训：workflow 里派出去的 agent 应把长结果写进文件（`dist/review/*.md`），
   返回值只传指针（路径 + 计数）**，这样才不会因工具截断而丢失。
   **本报告的实际取证方式（如实记）**：**路6** 按上述方式重跑并落盘
   `dist/review/p6-discipline.md`（29,232 B）后取得，逐条完整；**路5/路7** 重跑长期无产出
   （`dist/review/p5-*.md` / `p7-*.md` 始终未生成，后台任务最终 kill），改由**人工读源码复核**
   重写。所以：§6 的 16 条来自 workflow，§5 的 3 条与 §7 的 2 条来自人工复核；
   两者都逐条给了 `file:line` 证据，但**性质不同**，判读时值得知道。
   另：原汇总记在路5/路6/路7 上的 2 条「阻断」，在两条取证路径下都**未能复现** ⇒ 已撤回（见 §1）。

2. **本轮 7 路**（原始汇总 85 条；逐条可核落盘的 63 条，见 §0）**里，没有一条是「契约表本身错了」** —— 第 1 路逐条比对 140 条端点
   （含全部 13 条流式）为 **0 差异**。问题全在契约表**之上**（接线层）与**之外**（Host 包装、卸载路径、连接层）。

3. **`windowStage.loadContent('pages/WebApp')` 这条通路事实**决定了多处问题的**严重度**。
   `pages/Index.ets` 不可达 ⇒ 第 1 路的原生 UI 失败当前是**休眠**的。
   **任何「切回原生 UI」的决定都会同时激活若干条**，届时须重估严重度。

4. **没有任何脚本含删 el2 的命令**（第 6 路红线，见 §6）。这条与 `AGENTS.md` 的
   数据保全纪律一致 —— 装机动作只有 `hdc install -r`。

---

## 9. 未验证项（跨路汇总，如实留白）

- 设备侧 `$DSH_HOME/profiles/ondevice/package.json` 的 `bundles` / `removeBundles` 实际取值（无法连机时）⇒ 语音四行（`cordis.patch.yml:252,268,269,270`）与 terminal 行在真机上的最终生效状态未定。
- `module.register`（undici 解析钩子）在端侧嵌入式运行时是否允许起独立线程未验收（`main.js:414-416` 注释自述属待验收项）；失败时 `web_fetch` 静默降级。
- 端侧 Host 进程环境里是否真的没有 `HTTP(S)_PROXY` 一类变量 ⇒ 「代理被静默降级」（2-M3）的实际触发概率未定。
- `got`/`dsh-otel` 经 https 出站的完整链路：本机无 openssl、仓库无 `.pem/.crt/.key`，无法起自签 HTTPS 服务复现；clobber 后 http-over-http2 实测仍是 200，未观察到故障。
- `host-stop-request` 残留是否**确实**是「启动约 40 秒后自杀」的原因（需设备复现 + 两侧日志确认，本次未连机）。
- 哪些真实插件会用 `spawn(process.execPath, ['-e', ...])` 而被误判为重启用例（仓库内 grep 为 0，助手来自仓库外的 `dshmarket/lib/restart.js`，无法静态枚举第三方插件）。
- 把 agent preset 切成 `minimal` 后，ondevice 的 `terminal-bash`/`terminal-pwsh` 两行是否真能命中（本次只做静态比对，未切换实跑）。

---

## 10. 第二轮审核（2026-09-30）：按「官方对照面」重新组织

> 日期：2026-09-30　基线：端侧 core `0.2.0-rc.2`（真机 `BOOT_10_ENV_READY` 确证）
> 执行方式：16 个 agent（6 路取证 + 对抗复核），**只读取证、禁改文件**
> 与第 1~7 路的关系：那一轮按**工作分层**切（协议 / Host / 插件 / 连接 / 桥 / 纪律 / UI），
> 本轮按**官方对照面**切（官方能力面 / 官方桌面壳层 / 核心树补丁面 / Host 适配层 / 持久化 / 门禁）。
> **两轮条目集合不同，不是重跑**：第 1 路逐条比对 140 端点得 0 差异这件事，本轮没有再查一遍。
> **只审不改**：与第一轮同口径，本轮未做任何修复。

### 10.1 总量与分布（含本轮的缺口，如实记）

| 路 | 主题 | 声称条数 | 落盘条数 | 高 | 中 |
|---|---|---|---|---|---|
| A | 官方能力面（逐个 id）对齐 | — | **0** | — | — |
| B | 官方桌面壳层行为对齐 | 9 | 9 | 3 | 6 |
| C | 端侧核心树完整性与补丁面 | 10 | 10 | 1 | 9 |
| D | Host 运行期适配层 | 13 | 13 | 4 | 9 |
| E | 持久化与状态对齐 | — | **0** | — | — |
| F | 门禁与文档可信度 | 12 | **1（被截断）** | 1 | — |
| **合计** | | **44** | **33** | **9** | **24** |

- **低严重度本轮 0 条** —— 不是没有，而是 A/E 两路无产出、F 路只剩首条。
- 落盘位置：`%TEMP%\dsh-spill-*\…-job_output.txt`（72,152 B / 50,135 chars），
  在 F 路首条中途 `[truncated: 73833 more characters]` ⇒ **对抗复核（verdicts）与 A/E 两路结果均不在任何文件里**，
  无法指认的条目**不追认**（同 §1 撤回阻断的做法）。
- A/E/F 三路未补跑：用户已指示收尾（"都审核好几次了"）。
  **A 路的「官方能力面逐个 id」与 E 路的「持久化」是目前唯一没有第二双眼睛看过的两面**，
  F 路的 `check-parity.mjs` 清单过期（见 10.2.9）是已确证的尾巴。
- 本轮的 44/33 **不写成新的头条口径**：`docs/README.md` 的 R1 行仍以第一轮的 85 / 63 为准，
  本节是**增补**，不当替换。

### 10.2 高（9 条）

**10.2.1 官方桌面壳注册并处理 `dsh://` 深链，端侧完全没有任何深链注册**
- 位置：`entry/src/main/module.json5:183-192`（EntryAbility 的 `skills` 只有 `entities:["entity.system.home"]` + `actions:["ohos.want.action.home"]`，无 `uris`/scheme）
- 证据：全仓 grep `dsh://|setAsDefaultProtocolClient` 共 72 命中，**无一处是深链**（命中全是 `color-scheme`（`entry/src/main/ets/pages/WebApp.ets:334-403`）与 URL scheme 解析：`connection/src/main/ets/protocol/HostAddress.ets:59-64`、`platform/src/main/ets/system/OpenLink.ets:23` 只放行 http/https）；端侧核心树 grep `dsh://open` **零命中** ⇒ 代偿路径也不存在；`entry/src/main/ets/pages/WebApp.ets:205-221` 注释自述登录只能在系统浏览器完成、`loginSource=desktop` 时 loopback callback 只回 HTTP 204
- 官方对照：`apps/desktop/src/main.ts:1228` `if (app.isPackaged || DSH_DESKTOP_DEV_APP==='1') app.setAsDefaultProtocolClient('dsh')`、`:1229-1232` `app.on('open-url')` 仅在 `url === 'dsh://open' || 'dsh://open/'` 时 `focusPrimaryWindow()`；官方 README（`README.md` / `README.zh.md:475`）明写完成页的 `dsh://open` 负责把客户端置前
- 为什么算问题：登录闭环少最后一环（回调后把应用置前）。鸿蒙并非无对应 API（`skills.uris` + `want.uri` 即可实现）⇒ **是能力缺口，不是平台边界**
- confidence：confirmed
- 验证方法：`module.json5` 的 `EntryAbility.skills` 加 `uris`（scheme=`dsh`），`onNewWant`/`onCreate` 读 `want.uri === 'dsh://open'` 复用已有 `ensureWindowShown()`/`restoreMainWindow()`；先验鸿蒙 2in1 是否允许注册自定义 scheme、浏览器侧能否唤起

**10.2.2 官方退出前有「活动任务探测 + 退出确认对话框」，端侧既无探测也无确认**
- 位置：`entry/src/main/ets/entryability/EntryAbility.ets:541-547`（注释明确真退出走系统托盘自带项，真机实测**不经过** `onPrepareToTerminate`）
- 证据：`entry/src/main/ets` 全目录 grep `inspectQuit|quit-inspection|活动任务|scheduledTasks|退出确认` **零命中**；`grep showAlertDialog|AlertDialog|showDialog` 仅 3 处（`WebApp.ets:1057` 外链确认、`:1087` 外链失败、`:2009` 关于版本），无退出确认类；端侧核心树 grep `inspectQuit|quitInspection|scheduledTasks` 零命中（核心包清单不含 `dsh-desktop*`/`desktop-host`）
- 官方对照：`apps/desktop/src/quit-confirmation.ts:15-21 resolveDesktopQuitPrompt()`（activeTasks / scheduledTasks / 两者都有 → 三种文案）、`:81-91 dialog.showMessageBox`（`buttons:[quit,cancel]`、`defaultId:0`、`cancelId:1`、`noLink:true`）；`apps/desktop/src/main.ts:996-1007` 构造 `DesktopQuitConfirmation`、`:1259-1280 app.on('before-quit')` → `preventDefault()` + `confirm()`；`apps/desktop/src/host-process.ts:254 inspectQuit()`
- 为什么算问题：任务运行时用户点系统托盘「退出」会直接终止主进程与 BackGroundAbility，Host 与进行中的任务无提示消失。端侧**连拦截点都不存在**（系统项不走 `onPrepareToTerminate`）
- confidence：likely（官方对照确证，端侧"确实无确认"确证；"系统退出项真的会杀 Host"来自历史真机实测，本轮未复测）
- 验证方法：真机确认系统托盘自带「退出」是否触发 `EntryAbility.onDestroy` 或 Host 侧任何回调；若都不触发，改由自建退出项走 `exitApp` 以取得拦截点，或至少在 Host 侧补一次任务态检查

**10.2.3 端侧编辑菜单的撤销/重做走 Chromium 原生 undo 栈，与官方 `sendInputEvent` 不同源**
- 位置：`entry/src/main/ets/pages/WebApp.ets:2056-2065 runEditCommand(cmd)` = `this.controller.runJavaScript(\`document.execCommand('${cmd}')\`)`；`editMenu` 传的就是 `'undo'/'redo'`（`:2166-2191`）；`:2046-2055` 注释自述「与桌面行为一致」
- 证据：端侧核心编辑器（Lexical）的撤销只由真实键盘事件或 `beforeinput` 驱动 —— `dist/core/work/dsh-core-0.2.0-rc.2/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js:5749-5751`（keydown z + 平台修饰键 → `preventDefault` + UNDO）、`:5752-5761`（redo）、`:5566-5569`（`beforeinput` historyUndo/historyRedo）；全文件**无 `execCommand` 路径**
- 官方对照：`apps/desktop/src/main.ts:1018` 注释「Editor-owned history listens to key events rather than Chromium's native undo stack.」、`:1019-1025 editItem()` 的 click → `shortcuts.sendEditingKey(keyCode, modifiers)`；`apps/desktop/src/keyboard.ts:225-241 sendEditingKey` 用 `contents.focus()` + `contents.sendInputEvent({type:'keyDown',keyCode,modifiers})` + keyUp 合成真实按键
- 为什么算问题：`execCommand('undo')` 不产生 keydown/beforeinput，进不了上面两条路径 ⇒ 菜单「撤销」对编辑器里的输入**不生效或与 Ctrl+Z 表现不一致**（同一次编辑，菜单与快捷键各走一套历史）。`:2046-2055` 的自述与官方判据相反
- confidence：likely
- 验证方法：真机在输入框输入文字 → 点顶栏「编辑→撤销」，再按 Ctrl+Z 比较；若菜单无效，改为注入合成 KeyboardEvent 到编辑器而非 `execCommand`

**10.2.4 `permission` 的 config 整块替换抹掉 read-only 档：官方三档 → 端侧两档**
- 位置：`hostcore/profile/ondevice/cordis.patch.yml:161-164`（`- id: permission` / `disabled: false` / `config:` 只给 `defaultPreset: danger-full-access`，**未给 `presets`**）；`:151-160` 自陈默认预设表只有「workspace-write+ask / danger-full-access+never」两档
- 证据：`@deepseek-ai/dsh-app-boot/lib/index.js:104-107` `for (const [key, value] of Object.entries(overrides)) { if (key === 'id') continue; target[key] = value; }` ⇒ **`config` 是整体赋值替换、非深合并**（与 `cordis.patch.yml:8` 自陈一致）；`@deepseek-ai/dsh-permission-presets/lib/index.js:138-159` schema 默认 presets 本就只有两档、`:245-251 catalog()` 只吐 `Object.keys(this.presets)` ⇒ 只有表里有的档才进 options；客户端 `@deepseek-ai/dsh-client-ui-permission-presets/lib/client.js:232-236 PRESET_LABEL_KEYS` 含 `read-only`、`:287 PermissionIconReadOnlyRegular`，但 options 由宿主 catalog 动态提供（`:748-751`）⇒ read-only 的标签/图标成为**永不显示的兜底分支**
- 官方对照：`packages/bundle/base/cordis.patch.yml:245-262` 显式三档 —— `read-only{sandbox: read-only, approval: ask}` / `workspace-write{workspace-write, ask}` / `danger-full-access{danger-full-access, never}`，且不设 `defaultPreset`
- 为什么算问题：官方「仅可查看」是一档真实能力（`@deepseek-ai/dsh-sandbox-policy` 的 `SANDBOX_MODES` 支持）。端侧为绕开「workspace-write 在鸿蒙无 confinement 后端」（`cordis.patch.yml:71-80` 注释）整块替换 config，把 read-only 一并抹掉 ⇒ 用户失去只读档，且客户端为此档准备的标签与图标仍在位，界面与宿主能力不一致
- confidence：confirmed
- 验证方法：对照官方 base bundle patch 的三档与树内 `permission-presets` 的 schema/catalog，确认 `applyEntryPatches` 的 config 非深合并语义后判定（已做）

**10.2.5 致命错误在端侧不产生任何机器可读失败信号，Host 以退出码 0 继续存活**
- 位置：`hostcore/app/main.js:153-155`（`process.on('uncaughtException', (err) => { diag(...) })`，不重抛、不设 `process.exitCode`、不写启动失败标记）、`:3842-3848`（缺配置时 `return`，纯返回、不 throw 不 exit）
- 证据：`:899` 是 `.dshm-boot-failed` 的唯一写入点（在 `fail()` 内）⇒ 上面两条早退路径都不落该标记；`:895` 写的 `globalThis.__dshmHostError` 全仓无读取者（已记 2-L1）；`entry/src/main/ets/runtime/NodeRuntime.ets:218-252` 以 `isHostRunning()` 判存活、干净退出码 0 判成功 ⇒ **进程不退 = 视为正常**
- 官方对照：`apps/desktop-host/src/index.ts:107-119` 致命路径 `process.send({type:'fatal', message, diagnostic})` + `process.exitCode = 1` + `process.disconnect()`；`@deepseek-ai/dsh-app-boot/lib/index.js:3799-3820` `report` 先写 stderr 再 `proc.exit(1)`
- 为什么算问题：端侧把"致命"降级为一行文件日志，用户看到的是一个**永不就绪也不报错**的宿主；且与已登记的 2-H1（`process.exit` 被拦截）叠加后，任何 fail-loud 收尾都无法落地
- confidence：confirmed
- 验证方法：真机 Host 内注入 `setTimeout(() => { throw new Error('dshm-probe') }, 3000)` 后启动，检查进程是否仍存活、`dshm-host.log` 是否只有一行 uncaughtException、`.dshm-boot-failed` 是否出现、`isHostRunning()` 返回值

**10.2.6 官方 desktop-host 的四个装置与 IPC 就绪/致命通道在端侧零对应，退出链不做任何活动任务查询**
- 位置：端侧全仓（除核心树）grep `quit-inspection|quitInspection|update-tasks|updateTasks|platform-session|platformSession|hasDesktopActiveTasks|office-engine|officeEngine|collectIndexInjections` ⇒ **No matches**（连 `docs/` 都没写这个缺口）；`hostcore/app/main.js` 内 grep `process.send|process.disconnect|on('message'` ⇒ **No matches**；就绪改由 `:832-855` 写 `<HOME_DIR>/host-ready.json`（**含明文 token**）；退出链 `entry/src/main/ets/entryability/EntryAbility.ets:558-601`（`onPrepareToTerminate` 只判 `dshQuitRequested`/托盘就绪后 minimize）、`:806-850`（`exitApp` → `stopHostThenExit` → `terminateSelf`）内无 `activeTask|runningTask|inbox|quitInspection|updateTasks|session-activity` 任一命中
- 官方对照：`apps/desktop-host/src/index.ts:59-104`（`process.on('message')` 三类 IPC + `process.once('disconnect')` + `control.updateTasks` + `control.quitInspection` + `ctx.plugin(desktopOffice, …)` + `installPlatformSessionPublisher` + `process.send({type:'ready', url, injections})`）；`apps/desktop-host/src/update-tasks.ts:16-21 hasDesktopActiveTasks`、`:28-61` `connection/request` 的 inspect/lock/unlock（locked ⇒ 503）；`apps/desktop/src/main.ts:591-628` 更新前先 inspect 再 lock（失败码 `tasks-unavailable`/`tasks-changed`）；`apps/desktop-host/src/quit-inspection.ts:23-39`（取 agents/jobs + `workspace/session-activity` 水位，缺服务即 `throw new Error('desktop quit: task services are unavailable')`）；`apps/desktop/src/main.ts:453-454` 还把 `injections` 作为就绪必填项校验
- 为什么算问题：端侧不仅缺通道，还用落盘文件（明文 token）代替 IPC 就绪；退出/更新**完全不感知运行中的任务**——官方用 `updateTasks('inspect')` 保证"有任务时不更新"、用 `quitInspection` 保证"有计划任务时不静默退出"，端侧两条语义都不存在（仅剩长时任务保活的降级警告，`EntryAbility.ets:643-660` 失败只 `hilog.warn`）
- confidence：confirmed
- 验证方法：让一个 agent 处于 running（或 `inbox.nextTurn` 非空）时执行 `exitApp`，观察 Host 是否被直接杀死、会话是否留中断痕迹

**10.2.7 `probeExec` 完全不消费子进程退出码 —— 而它是部署门禁的唯一判据**
- 位置：`hostcore/app/main.js:3134-3144` `c.on('exit', () => { if (/Error loading shared librar|error while loading shared librar/.test(errTail)) { done('so-fail'); return; } if (errTail.length > 0) { diag(...) } done('ok'); })` —— **回调不接 `(code, signal)`**，退出码被彻底丢弃；stderr 为空即无附加证据
- 证据：`:3177-3178` 自述 `"fail(134)" / "fail(null)"` 两种形态，但 `fail(...)` 只可能来自 `:3131-3133` 的 `c.on('error')` 或 `:3106` 的 uv_spawn 同步抛错（Node 的 errno 里**不存在 134**）⇒ 该分支永远拿不到 134；`tools/update-device.ps1:193-208`（Step 8）唯一读点是 `grep -E 'exec 探测：' $filesDir/dshm-host.log | tail -1` 再 `-notmatch '=ok$'` 逐项判红 ⇒ probeExec 判 ok 即门禁判全通；`tools/assert-exec-fix.mjs:9-13` 只断言 probeExec 存在、EACCES→denied 映射、so-fail 正则、超时 SIGKILL，**无一条涉及退出码被使用**；`:3120-3123` 注释自认判据是"超时还活着 = execve 必然成功"
- 官方对照：官方无对应探测（端侧自建验收）；其等价事实面是真实执行 `git ls-remote` 并以其退出状态为准
- 为什么算问题：该探测是端侧多条文档与门禁里的 PASS 锚点。忽略退出码后，正是它要证伪的失败模式（rc=134 SIGABRT）会被判为 ok ⇒ 核心页读数、诊断日志、部署门禁**三者同时给出错误的"全通"结论**。这是会让整条 exec 验收链失效的**测量缺陷**，不是文案问题
- confidence：confirmed
- 验证方法：把 `probeExec` 抽出来探一个必定非零退出的目标（如 `sh -c 'kill -ABRT $$'`），观察是否返回 `'ok'`；再在真机把 `libdshm-gitcompat.so` 移走后启动，看 `git-ls-remote` 是否仍报 `=ok`

**10.2.8 fetch 垫片把流式请求体静默置 `null` —— 端侧文件上传路径必然丢体且不报错**
- 位置：`hostcore/app/fetch-shim.js:544-550`（只接受 Buffer/string/ArrayBuffer/ArrayBufferView，`else this._body = null; // 流式 body 不支持：dsh 的 /api 走 buffered 模式，用不到`）、`:457-478`（Request 形态展开读不到体就丢弃）、`:566-574`（`text()/json()/arrayBuffer()` 在 `_body === null` 时**静默返回空，不抛错**）
- 证据（反证该注释）：端侧核心树 grep `duplex:|body: Readable|toWeb\(` 命中 8 处，含 `@deepseek-ai/dsh-client-connection/lib/index.js:75-81` `new Request(url,{...,body:Readable.toWeb(req),signal:abort.signal,duplex:'half'})`、`@deepseek-ai/dsh-client-file-upload/lib/index.js:174 requestBody: 'streaming'`（`FILE_UPLOAD_PATH=/api/session/uploadFileBinary`）、`lib/client.js:138/:205 duplex:'half'`；同链 buffered 分支（`dsh-client-connection/lib/index.js:48-74 body: Buffer.concat(chunks)`）才是垫片支持的形态
- 官方对照：官方跑真实 Node/undici，`Request` 支持 ReadableStream 请求体（`duplex:'half'`），上传路径依赖该能力
- 为什么算问题：注释给的豁免理由（"dsh 的 /api 走 buffered 模式，用不到"）与核心树中的真实调用方**矛盾**；后果是上传类请求体被静默替换为空体，UI 只看到一次"成功"的空上传 ⇒ 属"语义被改成空壳且无充分理由"
- confidence：likely
- 验证方法：端侧触发一次文件上传，日志里看 `DSHM-REQDIAG body kind=object:ReadableStream … bodyNull=true`；本地可先 `node --jitless -e` 复现 `new DshmRequest(url,{body:Readable.toWeb(...),duplex:'half'}).text() === ''`

**10.2.9 `check-parity.mjs` 的官方能力面清单停在 `0.1.2-alpha.1`（落后基线 `0.2.0-rc.2`）**
- 位置：`tools/check-parity.mjs:37`（来源版本 `0.1.2-alpha.1`）
- 问题：官方能力面清单的来源版本落后当前基线两个大版本，**15 个官方已有能力面未被裁定**（本轮 F 路仅此一条落盘，标题后在工具截断处断掉；F 路声称的另 11 条未能落盘）
- 已在别处交叉印证：`docs/parity-matrix.md` §7.2 的来源与版本表已标 ⚠️ 过期，并写入复核结论（核心树 53 个 `dsh-client-ui-*` 比清单多 15 个；`dsh-web-app/package.json` 127 条依赖里 51 条为 ui/locale，差集恰好同样 15 个）
- 为什么算问题：门禁是"还差什么"的唯一机器判据；清单过期 ⇒ 门禁 exit 0 不代表官方能力面已被覆盖（与 `docs/README.md` 纪律 9「门禁通过 ≠ 覆盖到了」同一类）
- confidence：confirmed（清单版本号已亲读；"15 个未裁定"来自 `docs/parity-matrix.md` §7.2 的复核记录）
- 验证方法：`node tools/check-parity.mjs` 读其打印的来源版本；与 `docs/parity-matrix.md` §7.2 表对照

### 10.3 中（24 条）

| # | 位置 | 问题 | 官方对照 |
|---|---|---|---|
| B4 | `entry/src/main/ets/pages/WebApp.ets:2068-2088` | 「粘贴」只读 `getPrimaryText()` 后发 `document.execCommand('insertText', …)`；空剪贴板直接 `return`（静默）。粘贴图片/文件/富文本**静默丢失**，且无提示。另 `docs/parity-matrix.md` 已记剪贴板读权限缺口 | 官方「粘贴」= `CommandOrControl+V` → `keyboard.ts:225-241 sendEditingKey` 合成真实 Ctrl+V，交编辑器 `PASTE_COMMAND`（`client.js:5521-5524`） |
| B5 | `entry/src/main/ets/system/StatusBarTray.ets:166-176` | 托盘右键自建项**只有「打开应用」一项**（`groupMenu()` 单组单项）；`:20-28` 与 `EntryAbility.ets:541-547` 给出理由（系统自带项已有「退出」且真机实测有效，不经过 `onPrepareToTerminate`） | `apps/desktop/lib/types/tray.js:22-26` = `[openApplication, 分隔, quitApplication]` **三项**；`apps/desktop/src/main.ts:984-991` 托盘 `quit: () => app.quit()`。判定：**可接受**（退出能力未缺，挂两个退出项更差），真问题是未登记 |
| B6 | `entry/src/main/ets/entryability/EntryAbility.ets:593-600` | 首次点关闭（切后台）前无任何提示，直接 `win.minimize()` 后 `return true`；全目录 grep `backgroundNotice|隐藏到后台|首次关闭` 只命中实现与注释，无一次性提示与 marker 逻辑 | `apps/desktop/src/background-notice.ts:30-55 close(hide)`（marker 或内存标记，否则弹 `type:'info'` 单按钮通知，确认后写 marker 再 hide）；`apps/desktop/src/main.ts:992-995 markerPath`（**仅 win32**） |
| B7 | `entry/src/main/ets/entryability/EntryAbility.ets:603-616` | `onNewWant` 只 `applyLaunchParams` + `relabelWindow`，**不聚焦、不恢复**；而托盘唤回 `:786-790 restoreMainWindow()` 只 `showAbility()`，`onForeground` 走 `:725-740 ensureWindowShown()`（优先 `restore()`）⇒ **同类语义两条不同源实现**，窗口最小化时复用实例不会把界面带回来（与 `:604` 注释承诺不符） | `apps/desktop/src/single-instance.ts:16-26` + `apps/desktop/src/main.ts:1212-1226 focusPrimaryWindow()`（`isMinimized() && restore()` + `show()` + `focus()`），托盘 open 也复用它（`main.ts:988-989`） |
| B8 | `entry/src/main/ets/pages/WebApp.ets:2091-2101` | 顶栏「应用」= 主页 / 刷新 / 关于版本。缺「检查更新」（可接受：无更新通道）与**「命令行」**（后者连审核报告也没记），多一项「刷新」（官方 reload 仅 development 可见）。三处差异均未进矩阵 §6 | `apps/desktop/src/main.ts:947-971 applicationItems()` = 关于 + sep + 检查更新 + (`darwin‖win32`) 命令行 `commandManager.show()` + (`development`) sep/重新加载页面/重启应用宿主 + sep + quit；`main.ts:1009-1046` win32 经 `DESKTOP_IPC.windowsMenu` 弹同一集合 |
| B9 | 本文 §7 的 `7-L1`（「完全同构」那句）与其后的「通过项」段 | 「与官方 `tray.js` 的 `[openApplication, 分隔, quitApplication]` **完全同构**」—— 引文正确但结论方向错了（把**一项**说成与**三项**同构）；同节稍后又承认「端侧只补系统没有的『打开应用』」⇒ **同一文档两处结论互相矛盾**，且掩盖了 B5 的真实差异。**本节即该条的更正** | `apps/desktop/lib/types/tray.js:22-26` 确为三项（亲自读全文 35 行） |
| C2 | `hostcore/profile/ondevice/cordis.patch.yml:81-83` | `sandbox-policy` 的 `config` 只有 `mode: danger-full-access`，**丢 `workspaceRoot`** ⇒ 构造期 `config.workspaceRoot ?? process.cwd()` 静默回落宿主启动目录。当前 mode 掩盖了它，一旦按同文件 `:71-80` 的回退条件恢复 `workspace-write`，「工作区边界」就变成与产品语义无关的值，而 `renderPolicyContext` 还会把它当工作区语义播报给模型 | 官方 `packages/bundle/base/cordis.patch.yml:229-233` 给 `mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'` + `workspaceRoot: !!js process.cwd()` |
| C3 | `hostcore/profile/ondevice/package.json:14` | `"patchReload": "startup"` 是端侧自造、**全仓无读者的 key**（唯一"实现"是 `hostcore/app/main.js:3742` 把种子值抄进设备侧 profile；核心树 / `tools/` / `hostruntime/` / `resfile/` / 官方全仓 `patchReload` **0 命中**；`@deepseek-ai/dsh-app-boot/lib/index.js:827-838` 的 `readProfileManifest` 不校验未知键）却被三处文档当作**生效机制**：`docs/50-端侧核心运行架构.md:196`「HMR 用 patchReload + DSH_DISABLE_HMR 声明式关掉即可」、`:260`（把它当作"待确认"列成因）、`:916`「重启核心后生效」；`hostcore/README.md:11` 同 | 官方无该键；`packages/boot/app-boot/src/profile.ts:39` 只有一句英文注释（散文，**无键无实现**） |
| C4 | `hostcore/app/main.js:3731`/`:3738` | `removeBundles` 的「已移除」日志**在清单为空时永不打印**（`removedNow` 过滤后 `length > 0` 才打印），而 `hostcore/profile/ondevice/package.json:13` 是 `[]` ⇒ 该行当前**不可能产生**。但三处文档把它当真机读数与验收判据：`docs/50-端侧核心运行架构.md:977`（12.10 的 ☐PASS ☐FAIL 判据）、`docs/70-鸿蒙移植踩坑与修复总览.md:463`/`:467`（逐字「**真机读数**」带 `voice-input-bundle`）、`docs/device-validation.md:1664`；`docs/90-DSH鸿蒙原生实现全流程.md:4133` 还把它列入「已完成修复」并给**错行号**（声称在 `docs/70-鸿蒙移植踩坑与修复总览.md` 的 759-762，实际在 `:463`/`:467`，该区间是 §8.13/§8.14） | 官方全无 `removeBundles`（官方全仓 0 命中）；`packages/boot/app-boot/src/profile.ts:582` 只读 `manifest.dsh?.profile?.bundles` |
| C5 | `hostcore/core-recipe.json:58-62` | `optionalNativeGlobs: ["@ohos-ports/**/*.node","@ohos-ports/**/*.so*"]` 是**零代码引用的死配置**（全仓 3 命中全在 recipe 自身：`hostcore/core-recipe.json:59`、`hostcore/core-recipe-rc3.json:59`、`hostcore/core-recipe-alpha.json:60`）；`tools/pack-core.mjs:324-360` 的 `verify()` 只读 `recipe.requiredNative`（`:328`/`:330`/`:340`）⇒ 维护者会以为 @ohos-ports 的 .so 已被登记校验 | 官方无 `core-recipe.json`（端侧自造清单）；官方对原生依赖的声明面是各包自己的 `optionalDependencies` |
| C6 | `dist/core/dsh-core-0.2.0-rc.2.manifest.json` | 自签名清单**无法按文件定位被签的 rg**（`native.signed` 47 项 / `unsigned` 1 项 `koffi.node`，`ripgrep|rg$` 正则 0 命中）；且注释与文档承诺的 `selfSignSkipped` 字段**实际不存在** —— `tools/pack-core.mjs:245` 注释声称、`docs/90-DSH鸿蒙原生实现全流程.md:1058` 也这么写（并给行号 `:2274`），实际写入的是 `native.selfSign = extra.selfSign ?? null`（`{attempted,signed,skipped}`，`:2268-2275`）；`selfSignNatives()`（`:247-305`）只对 `@vscode/ripgrep-linux-arm64/bin/rg` 一个目标（`:266`）。而 `docs/90-DSH鸿蒙原生实现全流程.md:1046` 自定口径「不看计数、要看清单内容」，rg 恰恰只能看计数 | 官方无 `selfSign` 概念（端侧自造） |
| C7 | `dist/core/work/dsh-core-0.2.0-rc.2/node_modules/.package-lock.json` | `wrapSharp()` 改名后锁文件**未同步**：`node_modules/sharp` 仍记 `@ohos-ports/sharp@0.34.5-beta.12`，而磁盘实际是 `sharp`（`{"name":"sharp","version":"0.0.0-dshm-dispatch","main":"index.js"}`）+ `sharp.impl`（`@ohos-ports/sharp 0.34.5-beta.12`）双层（`tools/pack-core.mjs:1254 wrapSharp()`）。锁文件是"这棵树装了什么"的第一入口，会把排查者引向错误的包身份 | 官方 sharp 为单一包；`sharp`/`sharp.impl` 双层是端侧自造 |
| C8 | `tools/pack-core.mjs:568-579` | 语音降噪/AEC 两个补丁的标记名 `DSHM_ECHO_CANCELLATION_OFF`（`:577`）/ `DSHM_NOISE_SUPPRESSION_OFF`（`:578`）在**全部文档零登记**（`docs/` 仅 1 命中且是中文散文，不含标记名），而其余 9 个标记均 ≥1 处（`DSHM_NATIVE_CAPTURE` 8 / `DSHM_ORIGIN_LIST` 5 / `DSHM_HMS_PROVIDER` 5 / `DSHM_WORKFLOW_DISABLED` 2 …）。违反端侧自建的"每个补丁留可检索标记并登记"约定 | 官方 `packages/experimental/client-ui-voice-input/src/client/audio.ts:63` `getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false})` ⇒ 端侧把 true 改成 false 是**实质行为改动** |
| C9 | `hostcore/profile/ondevice/cordis.patch.yml`（全 20 条覆盖） | **没有任何门禁或验收断言 patch 覆盖的命中率**：`@deepseek-ai/dsh-app-boot/lib/index.js:95-99` 找不到 id 时只 `warn("patch: entry %C not found")` 后 continue；`tools/` 里 `cordis.patch.yml` 仅 7 处读者，无命中率断言；`tools/pack-core.mjs:1666-1667` 注释**自陈已知该静默形态**却未变成断言；同仓实例死行：`hostcore/profile/ondevice/cordis.patch.yml:189-193` 的 `agent-presets / default: ondevice`（`tools/pack-core.mjs:828-855` 注释自陈端侧从无 `ondevice` preset） | 官方无此门禁（官方 profile 由 `PROFILE_TEMPLATES` 生成，`packages/boot/app-boot/src/profile.ts:179-195`，无 ondevice 模板）⇒ 属"端侧本地改法未永久化" |
| C10 | `docs/10-协议兼容事实基线.md:537`、`docs/50-端侧核心运行架构.md:232`/`:1051` | 把权限写成**三档**（`read-only`/`workspace-write`/`danger-full-access`，默认 `workspace-write`）作为端侧契约，与端侧实际**两档**（默认 `danger-full-access`）矛盾；`docs/11-请求载荷契约.md:769` 的 `sandbox/mode` 三值枚举同属官方语义。同一事实在 `hostcore/profile/ondevice/cordis.patch.yml:159-160` 注释里**已写对**（两档），只是没回写文档。验收者会按不存在的档位判 PASS | 官方 `packages/bundle/base/cordis.patch.yml:250-262` 确为三档 —— 文档抄的是官方值，未随端侧裁剪更新 |
| D5 | `hostcore/app/main.js:3213-3216` | `ensureExecutables` 在 `!pythonReady() \|\| !gitReady()` 时**静默 `return`，一行诊断都不留**（`diag('exec 探测：…')` 在 `:3234-3243`，是门禁唯一读点）⇒ 半成品核心下用户与排障者读不到"为什么没有任何 exec 探测"，门禁只报"日志里没有探测行"。而 `tools/assert-exec-fix.mjs:28` 反把该早退**锁成正向锚点** | 官方无此设施 |
| D6 | `hostcore/app/main.js:3163-3168` | bash 探测目标在 PATH 为空时**实际探的是 `/system/bin/sh`**（`p: process.env.PATH ? (PATH.split(':')[0] + '/bash') : '/system/bin/sh'`），却仍以 `bash` 名义进验收汇总（`tools/update-device.ps1:201-204` 按 label 匹配 `=ok$`）。PATH 为空恰是沙箱子进程环境异常时的典型状态 ⇒ 锚点与真身脱钩。真 bash 垫片在 `ensureBashShim`（`main.js:1104-1169`） | 官方无此探测 |
| D7 | `hostcore/app/main.js:3050-3059` | git-core 真身补齐的 `catch` **为空**（无 `diag`、无 `console.error`、无计数），而注释承诺「缺哪个子命令的报错会如实出现在 stderr」—— 本分支**不产生任何 stderr**。hmfs 上 exec 许可与文件创建者绑定是已知硬约束（`main.js:3038` 附近根因注释），这处复制失败正是最需要证据的分支，却被静默吞掉并把失败转移到下游 | 官方运行时为完整解包目录，无此步骤 |
| D8 | `hostcore/app/main.js:1727-1730` | dsh 假壳 `--version` 返回写死的 `dsh 0.1.7-rc.1 (dshm install-queue shim)`，而端侧核心树与 `dshcompat/src/main/ets/CompatIndex.ets:94-102 SUPPORTED_VERSIONS` 首项都是 `0.2.0-rc.2`；`tools/assert-cli-shim.mjs:42-44`/`:75-77` 只锁 pnpm/npx 假壳，**无一条校验 dsh 假壳**；仓库内 `0.1.7-rc.1` 共 43 处（`main.js:1515`/`:1728`、`dshcompat/src/main/ets/CompatIndex.ets:57`/`:98`、`hostruntime/src/main/ets/core/Naming.ets:74`/`:117`/`:120`、`hostcore/app/dshm-installer.js:642`） | 官方 `@deepseek-ai/dsh/lib/bin.js:105 program.name("dsh").version(version, "-V, --version", …)`、`:208 const version = getDshRuntimeVersion()` ⇒ 永远与实装核心一致 |
| D9 | `hostcore/app/fetch-shim.js:551-564` | 对**每个 POST 无条件**打印一行 `DSHM-REQDIAG body kind=… url=${this.url} preview=${…substring(0,120)}`（含完整 URL 与 body 前 120 字符明文），**无 env 开关**（全仓 `DSHM-REQDIAG` 仅此 1 处）。与同项目已确立的"诊断开关默认关"纪律冲突（`main.js:192-197`/`:225` `if (process.env.DSHM_IN_LOG !== '1') return;`，理由是"曾把真正要看的日志挤出窗口"）；该行落入可导出回传的 `node-output.log`（`hostcore/app/dshm-user-rows.js:15`/`:476`）。端侧 URL 带 token 时即凭据泄漏 | 官方 `dsh-client-connection/lib/index.js:34-99` 的 bridge 不打印请求体内容，无此类全量 POST 转储 |
| D10 | `hostcore/app/main.js:923-927` | `process.env.DSH_DISABLE_HMR = '1'` 在**核心树零消费者**（核心树 `DSH_DISABLE_HMR` 0 命中、`@deepseek-ai/dsh-hmr` 内 `process.env` 0 命中；真正的开关是 `@deepseek-ai/dsh-base/cordis.patch.yml:27-32` 的 `- id: hmr` → `disabled: !!js "!ctx.get('profileContext')"` + `config: {root: []}`），但两处文档把它当作**已生效的关闭手段**：`docs/50-端侧核心运行架构.md:196`、`docs/90-DSH鸿蒙原生实现全流程.md:2313`（后者引行号 `:916-920`，与 `main.js:926` 实际位置也不符）⇒ 真实约束（沙箱里 chokidar 监听不可靠）在代码层无人承接 | 官方不设该变量，HMR 由 profile 的 patch 配置控制 |
| D11 | `hostcore/app/main.js:3517` | `process.pkg = process.pkg \|\| {}` 伪装的**第二处副作用未登记**：`@deepseek-ai/dsh-app-boot/lib/index.js:449-451 isPackagedExecutable()`、`:457-459 realModuleDirectory(path)` 在有 `process.pkg` 时改用 `realpathSync(path)`（而非 `realpathSync.native`），调用点 `:635`/`:640`/`:645`/`:682`/`:703`/`:781`/`:804`；而 `docs/50-端侧核心运行架构.md:372-400` 只记"模块 fallback（symlink 路径被拒）"一类风险，**全篇无 `realpathSync`/`realModuleDirectory`**。在 symlink 被全局禁止、路径语义与常规 Linux 不同的 hmfs 上，这正是最需要预先声明的风险 | 官方以真实 pkg 运行，`process.pkg !== void 0` 为真，走 `realpathSync` 是官方既定路径 |
| D12 | `tools/assert-exec-fix.mjs:9-13`/`:28`/`:29` | 断言层把 exec 探测的缺陷**锁成「语义锁」**：只锁 probeExec 存在、EACCES→denied、so-fail 正则、超时 SIGKILL（**不检查退出码被消费**），并把静默早退锁成正向锚点（`:28`）、把"只记录不修复"固定为契约（`:29`）⇒ 任何修复反而让门禁变红。该脚本被 `docs/90-DSH鸿蒙原生实现全流程.md:3636`/`:4264` 称作 exec 探测链的「语义锁」。同类：`tools/assert-cli-shim.mjs:65-73` 注释自承"断言没跟着改 ⇒ 一直在红" | 官方无对应工具链（端侧自建门禁） |
| D13 | `hostcore/app/main.js:86-96` | `diag()` **只写文件**（`fs.createWriteStream(DIAG_LOG,{flags:'a'})`，写失败把 `diagStream` 置 null 的空 catch），全段**无 `process.stdout.write`、无 `process.stderr.write`**；而文档有三种互斥说法：`docs/90-DSH鸿蒙原生实现全流程.md:2916`/`:2161`（走 stderr + 镜像 stdout）、`docs/70-鸿蒙移植踩坑与修复总览.md:549-550`/`docs/90-DSH鸿蒙原生实现全流程.md:3839`（走 stderr）。真实读点是 `tools/update-device.ps1:194`/`:211` 与 `tools/dshtest.py:10`/`:234` 读的 `<filesDir>/dshm-host.log` ⇒ 按文档去 hilog/stderr 找证据会一无所获 | 官方 Host 诊断走 stderr（`apps/desktop-host` 的 `proc.stderr.write`、`dsh-app-boot/lib/index.js:3799-3820`），由父进程收集 |

> 表中 B4~B9 属 B 路（官方桌面壳层），C2~C10 属 C 路（核心树补丁面），D5~D13 属 D 路（Host 适配层）。
> 编号沿各路自己的序号（与 10.2 同一规则）；两路各自的 `A1` 等编号在落盘文件里是重复的，引用时须带路号。

### 10.4 本轮与前一轮的重叠与差异

- **重叠**：C10（权限三档）与第 1 轮的 `1-H3`（36 条 UI 在用端点无能力引用）同属"文档/矩阵声明与实物不符"这一类；D8（假壳版本）与第 6 轮的版本口径条同源。重叠处**不重复计入**本节 44 条。
- **本轮新增的主要对照面**：官方桌面壳层（B 路 9 条**全是新的**，第 1 轮完全没查桌面壳行为对齐）、核心树补丁面（C 路 10 条新的）、Host 适配层（D 路 13 条新的）。⇒ **33 条里绝大多数是第 1 轮没覆盖到的面**，这是一轮不重复的增量。
- **与前一轮相反的一点**：第 7 路结论「壳干净、与官方托盘同构」在本轮被 **B9** 直接推翻（`tray.js` 是三项、端侧一项，"完全同构"是引错结论）。§7 的 `7-L1` 也因 **B8** 扩到三项（缺检查更新 + 缺命令行 + 多刷新）。

### 10.5 关于本轮的方法学备注（补 §8）

5. **workflow 的 `agent(opts.schema)` 只支持 JSON Schema 子集**：**裸 `enum` 必须同时带 `type`**
   （`{type:'string', enum:[…]}`），否则整个 workflow `status: failed`，报错形如
   `unsupported JSON schema: …severity.enum requires type or oneOf`。本轮第一次尝试即因此失败重跑。
6. **workflow 脚本里不能用反引号模板串**（经网关传输会被破坏 ⇒ `SyntaxError: Unexpected identifier`），
   改用 `['…','…'].join('\n')` 单引号数组拼接。
7. **§8 第 1 条的教训本轮仍未落实到位**：脚本要求"写文件 + 只回传指针"，
   但落盘的 `%TEMP%\dsh-spill-*\…-job_output.txt` 仍在 F 路首条被截断 ⇒
   **截断发生在返回值序列化处，而不是在 agent 的产出处**；如果 agent 确实写了文件，
   就应该在返回值里**只放路径与计数**（本轮 D/B/C 三路的返回值形状已经做到了，A/E 两路则没有产出）。
   下一轮若还要跑，应把「A/E 两路为何无产出」本身当成要查的问题。
8. **本轮审核的产出文件目录 `dist/review/` 只有 `p6-discipline.md`**（29,232 B / 01:11:35，
   来自第一轮的路6 重跑）。第二轮三路都没有在 `dist/review/` 留下文件 ⇒
   33 条结论的**唯一**载体是本报告 §10 与那份被截断的 spill 文件。
