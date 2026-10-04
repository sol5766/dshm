# 项目复审报告（2026-10-04）

> 触发：用户要求「重新 review 一下项目，审核需要落实的功能以及修复的问题，没问题后更新最新 dsh 版本」。
> 方法：三路**只读**审核（docs 待办清单 / 代码层债 / 上游差距）+ 本报告作者对每条**逐条复核**（审核给出的行号一律重新读过，**有三处结论被复核推翻或降级**，见 §5）。
> 本文档不含行号引用以外的断言；所有 `文件:行号` 都是实测位置。

---

## 0. 三句话结论

1. **本轮唯一已定案并修复的缺陷是 E388**（冷启动后约 60 s 宿主全静默）——真机复验通过（`LOOP-GAP` 0 条、`session/modelCatalog` 首次 66,503 ms → 4,535 ms），已本地提交 `5f27b18`，最终 HAP 已装机复验。
2. **「更新最新 dsh 版本」在当前标签下没有可做的事**：`latest` = `next` = `0.2.0-rc.2`（正是本仓 `hostcore/core-recipe.json` 钉的版本）；唯一更新的是 `alpha` = `0.2.1-alpha.1`（2026-10-03 发布，带 `cordis 4.0.5-alpha.1` 框架层跳版）。**这一步需要用户拍板**，见 §4。
3. **推给用户之前必须先处理一条 P0**：三轮诊断留下的**埋点目前是出厂默认全开的**，且 `process.exit` 拦截 + 6 个信号监听器仍在（§2 的 P0-1）。E388 修复本身与埋点无关，但**带着满身埋点发布**是这一轮最该先清掉的债。

---

## 1. 本轮已修（E388，真机复验通过）

| 项 | 内容 |
|---|---|
| 现象 | 冷启动后约 60 s（实测 52/59/62/63/82 s）：`127.0.0.1:3120` TCP 三次握手成功但**一个请求都不 accept**，宿主日志零 `IN-REQ`；登录转圈、模型选择卡「加载中」、插件市场与预览一起等 |
| 取证 | ① 心跳线程连续（进程没被冻）⇒ 是 JS 主线程被**同步**调用挡住；② `LOOP-GAP 62915ms` 而 `SYNC-COUNT` 只记到 425 ms ⇒ 大头在包装面之外的 native；③ `.cpuprofile` 61,621 样本里 **55,829 个（90.6%）**落在 `getReport → loadBinding → errno → tryLockExclusive` 一条链上 |
| 根因 | 上游 `@deepseek-ai/node-addon-system/lib/flock.js` 用 `process.report.getReport()` 判 libc —— 它是「全进程诊断报告」，端侧实测 55.8 s，且同步、恰在会话写租约热路径上。上游在 openharmony 上本应直接抛 `ERR_FLOCK_UNSUPPORTED_PLATFORM`（快失败），是我方 `tools/pack-core.mjs` 的 E103 平台门把它放行了 |
| 修法 | `pack-core` 重写 `flock.js` 的模板改读 `/proc/self/maps` 判 glibc/musl（判不出按 musl）；两个 libc 变体本就映射到同一份 `libs/arm64/libsystem.so`，判哪个目录不影响加载 |
| 验证 | 修复后 `LOOP-GAP` 0 / `.cpuprofile` 转储 0 / `session/modelCatalog` 首次 4,535 ms（随后 58–222 ms）/ 无 ≥10 s 请求；两次独立冷启动（含预热后）结果一致 |
| 产物 | `entry-default-signed.hap` 314,329,793 B（sha256 `CCDBAA17…B9658E0`）；核心 zip 78,136,685 B；备份 `dist/fallback/DSHM-E388-314329793.hap`；提交 `5f27b18`（本地，**未推送**） |

---

## 2. 待修问题（按优先级；每条都注明「谁验证的」）

### P0-1 埋点/调试代码的出厂状态（**发布前必办**）

三轮排障往 `hostcore/app/main.js` 里加了大量默认开启的埋点，**目前没有总开关**（文件内 `process.env` 共 31 处，不存在 `DSHM_SYNC_*` / `DSHM_PROF_*` 之类的统一开关）：

| 埋点 | 开关 | 现状 | 建议 |
|---|---|---|---|
| `console` 时间戳前缀 | `DSHM_TS_LOG` | **默认开**（`'0'` 才关） | 恢复 `=1` opt-in |
| `IN-REQ` / `IN-DONE` / `IN-ABORT` | `DSHM_IN_LOG` | **默认开**（`'0'` 才关） | 恢复 `!=='1' return` |
| JS 线程 tid 文件 `dsh-js-tid` | 无 | 恒开 | **删除** |
| 心跳 worker → `dshm-hb.log`（每秒 appendFileSync） | `DSHM_HB` | 默认开 | **删除**（或至少默认关） |
| 同步调用环 `SYNC-RING`/`SYNC-WARN`/`SYNC-SLOW`/`SYNC-COUNT`（包装 16 个 fs + 3 个 child_process + `Atomics.wait`） | 无 | 恒开 | 加总开关，默认关 |
| `IN-UPGRADE` / `ACCEPT` / `SERVER-COUNTS` | 无 | 恒开 | 删除或并入门控 |
| `process.exit` 拦截（默认不退出，只记栈） | 内部 `ALLOW_EXIT` | 恒开 | **删除（风险最高）** |
| `beforeExit` / `disconnect` / 6 个信号 / `exit` 快照 | 无 | 恒开 | 降级为门控 |
| 主日志 `dshm-host.log` | 无 | 恒开 | **保留** + 加体积上限/轮转 |
| 事件循环看门狗 `LOOP-GAP`/`LOOP-ALIVE` | 无 | 恒开（unref） | 保留（低成本、高价值） |
| V8 profiler 快照（gap ≥ 3000 ms 触发） | 无 | 条件触发 | 保留 |
| `DSHM_ALLOW_EXECPATH_SPAWN` | env | 默认关 | **保留**（安全守卫） |

两条必须点明的风险：
- **`process.exit` 被架空 + 6 个信号监听器取代默认处置**（`SIGTERM` 不再终止进程）。`--jitless` 下这条是全场风险最高的一处：任何"该退出没退出"的现象都可能由它造成或掩盖。
- 落点是 `<DSHM_SANDBOX_HOME|USER_DATA|os.tmpdir()>/`，**随包发布即写用户沙箱**。

> 与既有约定的关系：`dist/_patch5.cjs` 的注释里当时就写了「正式推之前要么恢复 env 门控，要么连埋点一起摘掉」。这一条一直没做。

### P0-2 托盘/应用启动约 40 s 后自杀（未判因）

- 依据：`docs/HANDOFF.md` §4②。机制已定案为「E90 停止通道」（`process.exit` 被放行 + `!! process.exit(0)` 记录），但**是哪条 ArkTS 路径按的停止键仍未查明**。
- 本轮新证据：`!! process 'exit' event, code=0` 的 4 次记录（`2026-10-03T09:32:11.536Z`、`2026-10-04T10:12:43.876Z`、`10:26:46.246Z`、`10:49:41.728Z`）**全部落在 E388 修复之前的 boot**；修复后两次冷启动（`13:22:18.136Z`、`13:24:58.851Z`）与最终装机那次都只有「停止通道已就绪」，**没有任何 exit 事件**。
- 倾向：**可能是 E388 的下游**（请求长时间无响应 → 应用侧放弃/重启），但样本只有 3 段 boot，**不足以定案**。
- 定案条件：请用户在设备上点一次登录，观察是否仍然自杀（这是最便宜的一次判定）。

### P0-3 Windows 端 dsh desktop 重连（用户当前最要紧的事，只有用户能做）

- 依据：`docs/HANDOFF.md` §2 的七步（先卸载再装，避免 Host 与 `%USERPROFILE%\.dsh\host-ready.json` 版本错配）。CLI 侧无法代劳。

### P1-1 `check-parity` 的官方能力面清单停在 `0.1.2-alpha.1`

- 位置：`tools/check-parity.mjs`（`OFFICIAL_SURFACE` 字面量仍为 39 项；注释自陈来源是 `0.1.2-alpha.1`）。
- 事实：在跑基线是 `0.2.0-rc.2`，其核心树里实有 **53 个 `dsh-client-ui-*`**（+ `dsh-client-locale`），差集 15 个：`open-in-app`、`plugin-manager`、`schedule`、`settings-account`、`settings-agent-loop`、`settings-session-log`、`settings-shell`、`settings-subagent`、`settings-web-search`、`shortcuts`、`sidebar-browser`、`sidebar-documentpreview`、`sidebar-files`、`sidebar-right`、`sidebar-terminal`。
- 更稳的基准是 `dsh-web-app/package.json` 的 `dependencies`（127 条里 51 条是 `dsh-client-ui-*` / `dsh-client-locale`，差集**恰好是同一批 15 个**）。
- 建议：清单改为由该依赖表生成；并把「哪些包并入哪个 id、哪些刻意不建行」的粗化判据写进 `docs/parity-matrix.md`（`open-in-app` 属"端侧明确禁用"，与"未登记"性质不同）。

### P1-2 rc.2「新增工作区」回归未修

- 依据：`docs/rc2-workspace-diagnosis.md`（三项验证含槽位探针，全仓无「已修」反证）。现象：无法新增工作区。

### P1-3 运行时缺陷 4 条（来自 `docs/review-report-2026-09-29.md`，本轮复核仍成立）

1. `probeExec` 不消费子进程退出码。
2. `fetch` 垫片把流式请求体置 `null`。
3. 致命错误没有机器可读的失败信号（用户只看到"发消息没反应"）。
4. 没有 `dsh://` 深链注册。

### P1-4 交付前人工验收清单未勾选

- 依据：`docs/HANDOFF.md` 的最终验收清单（7 项人工判据，文件变更流已降级）。

### P2 一批（择要）

- 矩阵 PARTIAL 缺口：`workflow-run` 无协议面、`permission-presets` 只显示不可切换、`skill`/`commands`/`reference`/`attachment`/`jobs` 未细分。
- `workspaceFileScopeId` 来源未确认（真实文件树置灰）；诊断页 `home=` 是桩值；clipboard 读能力「登记未接」；theme 21 处裸值。
- `D25 turn 不启动`（自标最高优先）/ `D26 插件安装入口必失败` —— 状态不确定（早于后续批次，需逐条核）。
- 设备验证列未逐面展开（"不在此文 ≠ 已验证"）。

### P3 工程卫生（复核后确认成立的）

- **死代码**：`tools/collect-libvips.mjs` 里 `SYSTEM_LIBS` 定义后全文件无引用，其内含失效的 `libnode.so.127` ⇒ 删除。
- **两份发散的系统库白名单**：`tools/collect-libvips.mjs`（15 项）vs `tools/check-native-closure.mjs`（25 项）⇒ 抽公共常量。
- `entry/src/main/cpp/CMakeLists.txt` 三处 soname 候选循环复制三遍 ⇒ 抽一份。
- `tools/assert-cli-shim.mjs` / `tools/assert-python-bridge.mjs` 首行自称「临时断言」，实际已是 `AGENTS.md` 必跑门禁 ⇒ 改标题。
- `libnode.so.127` 是**注释残留**（运行时实物只有 `entry/libs/arm64-v8a/libnode.so.137`，1.26 亿字节；CMakeLists 三处候选循环兜底）⇒ 统一改述为「候选查找」。
- `tools/pack-core.mjs` 退出码 1：**复核不成立** —— 全文件唯一显式 `process.exit(1)` 是 `die()`（必先打 ✗），无 `process.exitCode` 赋值、无信号监听 ⇒ 归为「证据不足/不确定」，不要再据它判断成败（判成败看产物与清单）。
- `ghfast.top`：**复核为部分成立** —— 它是**被改写方（失效主机）**而不是镜像目标，改写逻辑本身正确；真正缺的是**主镜像自身的超时/降级链**（只有 `DSHM_FETCH_MIRROR_PREFIX` 与 `DSHM_FETCH_MIRROR=0` 两个开关）⇒ 建议加主镜像健康探测。
- **resfile 只能有一个 `dsh-core-*.zip`，且构建不按 `core-recipe.json` 挑版本，只拷 resfile 里实际躺着的那份** ⇒ 版本不一致时**静默嵌错版本、零报错**。升级前必须先看这一条（`docs/40-上游升级手册.md` 有记载）。

---

## 3. 审核发现的**文档内部矛盾**与处置

| # | 矛盾 | 实测结论 | 处置 |
|---|---|---|---|
| 1 | 鸿蒙端心跳覆盖状态三处口径不一（「已落盘」/「已回退」/「仍未落盘」） | 真相是 **2026-10-03 落盘 → 2026-10-04 已回退**，`hostcore/profile/ondevice/cordis.patch.yml` 的 ⑪ 段现在只留说明、无 `config` | **已修**：`docs/HANDOFF.md` §1 一句话现状改写；`docs/device-validation.md` 连接抖动条目改为「曾落盘、已回退 ⇒ 两端均走官方默认 2000 ms」 |
| 2 | 心跳回退的**理由**曾是「60 s 慢的唯一自定义改动」 | **已被 E388 推翻**：真因是 `getReport()`，心跳这条路径真机从未观测到缺陷 | **已修**：`docs/HANDOFF.md` §2 的 ⚠️ 段追加判决结果（回退保持，但理由不再是它） |
| 3 | `docs/parity-matrix.md` 称「本轮复核已做，结论是清单确实落后」 vs `docs/review-report-2026-09-29.md` 6-M7 称「自设的『必须复核』未执行」 | 两者是**同一发现的两个时点**：09-29 判定未做，09-30 把 15 个差额逐条枚出并写进矩阵 | 未改正文（不矛盾），按 P1-1 的改法一次收口 |
| 4 | `docs/README.md:38` 断言「本仓不是 git 仓库（无 `.git/`）」 | **复核不成立**：该断言已在 `docs/README.md:39-41` 就地更正（「2026-09-30 更正…与实测相反」）；审核引的行号偏了 | 无需处置 |
| 5 | `docs/30-技术验证清单.md` 的「POC-1 不通过则不启动 M2 之后功能开发」 vs 实际已推进到核心 0.2.0-rc.2 全绿 | 属**历史门槛条款**，项目已按另一种节奏推进 | 建议就地加一行「本门槛已被后续决策取代」 |
| 6 | 40 s 自杀根因：`docs/device-validation.md` 说「强嫌疑是启动期未清理 `host-stop-request` 残留」 vs `docs/HANDOFF.md` §4② 说「该推断不成立，一定是应用侧某个 `DshHost.stop(reason)` 被调到」 | **以 HANDOFF 为准**；本轮又添第三种可能：E388 停滞的下游 | 见 P0-2，待用户点一次登录后一并定案 |

---

## 4. 上游 dsh 升级裁定（需要用户拍板）

### 已核实的事实（2026-10-04 查 registry）

| tag | 版本 | 发布时间 |
|---|---|---|
| `latest` | `0.2.0-rc.2` | 2026-09-29T09:56Z |
| `next` | `0.2.0-rc.2` | 同上 |
| `alpha` | **`0.2.1-alpha.1`** | 2026-10-03T04:53Z |

- **本仓已钉的就是 `latest`**（`hostcore/core-recipe.json`）；`0.2.1-alpha.1` 是唯一更新的版本，**无 beta**。
- `0.2.1-alpha.1` 相对 rc.2：+2 依赖（`dsh-tool-schedule`、`dsh-experimental-inspector-profile`）、−1（`dsh-experimental-schedule-bundle`）、78 处版本跳，含 `@deepseek-ai/cordis ~4.0.4 → ~4.0.5-alpha.1`、`schemastery ~3.18.4 → ~3.18.5-alpha.1`、`cordis-plugin-loader ~1.0.5 → ~1.0.6-alpha.1`。
- ⚠️ 子包 `@deepseek-ai/dsh-web-app` 的 npm `latest` 标签**停在 `0.0.1-rc.1`** ⇒ 任何按 `latest` 解析的通道（安装器 GitHub→npm 同名回退）会装到极旧版本，升级后必须复核。
- ⚠️ `tools/pack-core.mjs` 的 21 个文本锚点补丁全是 **die-on-miss**（升级会立刻暴露，不会静默失效），但每个都要按新上游原文重取锚点；另有若干**硬编码版本**会静默失效：`tools/check-sidebar-tab-id-guard.mjs`、`tools/check-undici-shim-exports.mjs`（写死 `dsh-core-0.2.0-rc.2` 路径）、3 个自家插件的 peer 依赖、`hostcore/app/main.js` 里的假壳版本号。

### 建议

**不立刻升 alpha。** 理由：① 唯一更新项是 alpha 且连框架层（cordis 4.0.5-alpha.1）一起跳；② 收益未知，返工面是整个 `pack-core.mjs` 的锚点表 + 契约快照 + 门禁；③ 当前 `latest` 就是我们跑的版本，**不存在"落后于稳定版"的风险**。

零风险预演（**不换核心树、不动设备**，几分钟）可在下一步做：

```powershell
node tools/protocol-contract.mjs --json .research/protocol/contracts-0.2.1-alpha.1.json
$env:DSH_CONTRACTS=".research/protocol/contracts-0.2.1-alpha.1.json"; $env:DSH_VERSION="0.2.1-alpha.1"
node tools/compat-drift.mjs          # 只看端点/契约差集
node tools/gen-compat-endpoints.mjs  # 生成物先别提交
```

它能立刻回答「契约层是纯新增还是有破坏」，从而判定升级是零改动还是要改参数形状。

**若用户要求现在就升 alpha**，则按 `docs/40-上游升级手册.md` §2/§4.4 的十步走，并**先做 P0-1（摘埋点）**——否则升完之后的门禁与真机验收读数会被自己的埋点污染。

---

## 5. 复核推翻/降级的审核结论（如实记）

1. 「设备离线、带埋点 HAP 未安装」——**已过期**：设备在线，E388 版 HAP 已 `install -r` 并复验。
2. 「启动后约 60 s 宿主零 accept 未做」——**本轮已定位并修复**（E388）。
3. 「`docs/README.md:38` 断言本仓不是 git 仓库」——**行号偏了**，该断言已在同文件 `:39-41` 更正。
4. 「`tools/pack-core.mjs` 退出码 1」——**不成立**，见 §2 P3。
5. 「`ghfast.top` 是失效镜像」——**降级为部分成立**：它是失效**主机**，改写逻辑正确，缺的是主镜像降级链。

---

## 6. 未验证/留白（不许当成已通过）

- 40 s 自杀与 E388 的因果关系（样本 3 段 boot）。
- `0.2.1-alpha.1` 的契约差集（预演**尚未执行**）。
- 真机侧 10 个第三方插件源码仍拿不到（`dsh-our-free-model` 在 npmjs / npmmirror 均 404），`dist/_scanplugs.py` 无法离线跑。
- 用户可见验收：点【设置 → 账号 → 登录】是否**立刻**跳浏览器（历史 52–82 s）。
