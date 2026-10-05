# 95 · 收尾审计台账：开源后改动 × 上游 issue × 历次修复要求

> **这份文档是"收尾审计"的可复核结论**（2026-10-05）。它回答三个问题：
> ① 2026-09-30 首次开源之后新增的改动，有没有半成品/口径不一致；
> ② GitHub / GitCode 上提的 5 条 issue，逐条要求的真实落实状态与"能不能关"；
> ③ 历次提出的修复要求，是否都落了地。
>
> **复核方式**：每条都给了 `文件:行` 或命令；本机的门禁清单以 `AGENTS.md` 为准，
> 真机读数以 `docs/device-validation.md` 与本文件 §4 为准。**审计是只读的**（三路独立审计
> 未修改任何文件、未跑构建、未碰设备），落实动作在同一轮完成并已真机验收。
>
> 基线：`HEAD = 431813e`（master，2026-10-04 22:32），工作区含 10/05 未提交改动。

---

## 1. 上游 issue 台账（5 条）

### 1.1 GitHub #1 —— 零售机 `startNativeChildProcess` 返回 801

**裁定：技术上可关，但"关"的措辞必须是"平台限制 ⇒ 另择方案"，不能写"已修复 801"。**

| # | issue 的要求/断言 | 现状 | 证据 |
|---|---|---|---|
| R1 | 子进程路线在零售机上不可用（801） | **该路线已从代码里整条删除** | 全仓 `startNativeChildProcess`/`childProcessManager`/**0 命中**（只剩 5 处文档引用）；`DshBootstrap`/`launchDsh`/`scripts/` 均 0 命中 |
| R2 | 给出可用的替代路线 | **已改用同进程 `libnode.so` + NAPI 引导 + jitless** | `hostruntime/src/main/cpp/dshhost.cc:461-531`（`dladdr` 取自身路径 → `dlopen("libnode.so.137", RTLD_GLOBAL)` → `dlsym("_ZN4node5StartEiPPc")`）；`:1-23` 写明"为什么同进程"；`entry/libs/arm64-v8a/libnode.so.137` 在位 |
| R3 | 标注实测设备范围 | **只做了一半** | README 已收敛为 phone/tablet/2in1 且 `deviceTypes` 有门禁（`check-store-readiness.mjs` PASS），但**"实测范围仅 2in1（MNTXM-24B）"没有成文** |
| R4 | 公开 libnode 来源 / 澄清 HNP 说法 | **未做** | `git ls-files entry/libs` → 0；`git check-ignore -v entry/libs/arm64-v8a/libnode.so.137` → `.gitignore:52:/entry/libs/`（实物在磁盘、不入库）；全仓 `hnpPackages` 无声明，`docs/device-validation.md:3845-3853` 明写"项目/HAP/设备三处都没有实体" |

**为什么这不是"修好了 801"**：本仓**没有 801 的第一手读数**（issue 引的 `main @ 4989ce5d` 不在本仓，
共 51 提交、起点 `e7b5ed7` 2026-09-27）；实测机是 **2in1**（`docs/device-validation.md:4363-4365`、`:5134`），
早期 phone（Mate 70 Pro+）只跑过阶段一/前段。比官方条文更硬的旁证：`hostcore/app/main.js:1269-1276`
——koffi 直调 `fork()` 直接 native crash，appspawn 打 `SetForkDenied success, cgroup's owner:<pid>`。

### 1.2 GitHub #2 —— phone 档适配（用户可见目录 + 工具链解包）

**裁定：§2 可关（已全部落实并合入 main）；§3 必须另开一条跟踪（未落实、原样未动）。**

| # | 要求 | 现状 | 证据 |
|---|---|---|---|
| §2.1 | ArkTS 认领用户可见目录 | ✅ 落实 | `platform/src/main/ets/system/FilePicker.ets:277-334`（先直拼探写、未命中才 `DOWNLOAD` 模式 `save()`）、`:366-389`（进程内幂等 + 每次启动重认） |
| §2.2 | 宿主只读校验 + 探写 + 回退，绝不返回 `/` | ✅ 落实 | `hostcore/app/main.js:1470-1493`、`:1520-1560`（唯一来源 `DSHM_PUBLIC_DOWNLOAD`；空 ⇒ 回退 `<SANDBOX_HOME>/workspace`）；通道 `hostruntime/.../RuntimePort.ets:193-213` + `entry/.../NodeRuntime.ets:102-114,182-185` |
| §2.3 | 该目录登记进工作区（"新建会话"默认落这里） | ✅ 落实 | `hostcore/plugins/dshm-workspace-claim/lib/index.js:44,55-93`；接线 `cordis.patch.yml:488-490`、`pack-core.mjs:845-849`；限制成文 `:477-487` |
| §2.4 | 去 chmod 的原子写入 | ✅ 落实 | `dshm-fs-write-nonchmod/lib/fsio-nochmod.js:336-383`（`.partial` → `rename` **原子发布**）；只重写 `writeText`/`editText`；接线 `cordis.patch.yml:537-541` |
| §2.5 | `remove`/`move`/`publish` 三个工具 | ✅ 落实 | `dshm-tool-fs-remove/lib/index.js:425-465`（remove）、`:481-521`（move）、`:325-336`+`:185-194`（publish，目标根只认 env） |
| §3 | **phone 档工具链解包 + 沙箱 ELF 不可 execve** | ❌ **未落实（原样未动）** | `main.js:4057-4079` 仍 `spawn(<bin>/busybox, ['ash','-c', tar…])`；`:1729-1741` 自陈"手机档 `ash=denied` ⇒ bash 通道不可用"。**最小改法**：在 `child.on('error')`（`:4076-4079`）加**进程内回退**，复用 `hostcore/app/dshm-installer.js:157 extractTar()`（纯 JS ustar，含 tar-slip 防护 / symlink 跳过）+ `main.js:2665-2697 readGitCoreSymlinks()` + `zlib.gunzipSync`；**风险**：4530 文件同步解会卡事件循环（现方案正是为避开它才 spawn）⇒ 必须让出/分片；且**解包成功 ≠ 工具链可用**（phone 档 ELF 依旧不可 `execve`），这条边界必须写进 issue |

### 1.3 GitHub #3 —— 目录选择器授权在 node 侧不可达（EPERM）

**裁定：不能按原样关。** 根因成立，但仓库的处置是"不搬运、改在 ArkTS 侧换路径"，且该替代方案的
真机有效性**仓库内无取证**（关单前需要真机两问，见文末）。

| # | 要求/断言 | 现状 | 证据 |
|---|---|---|---|
| R1 | ArkTS 侧递归复制授权目录进 workspace | **未落实（被替代）** | 全仓无递归复制实现（`copyFileSync` 只用于 busybox/skills 安装：`main.js:1827,3719,4386,4463`、`dshm-skills.js:116`、`dshm-user-rows.js:1073`）；替代做法＝探写失败就**换路径**到应用自建目录：`FilePicker.ets:180-196`、`WebApp.ets:985-996` |
| R2 | cwd 按工作区隔离 | **部分 / 已登记为局限** | 客户端侧"选中的路径成为该会话工作区"早已存在（`Index.ets` 的 `ensureWorkspace`+`createSession`）；host 侧 `WORKSPACE_DIR` 仍是单例常量（`main.js:1468`），官方 `recentWorkspace` 覆盖问题已在 `cordis.patch.yml:477-487` 如实登记 |
| R3 | 给出失败反馈 | **半成品 → 本轮补上** | ArkTS 造出了原因（`FilePicker.ets:188-189`），但 `Index.ets` 的 **PICKED + 非空 reason** 分支直接 `return` ⇒ 用户看不到"已改用应用目录"。**本轮修**：`Index.ets` 的 `openFolderPicker` 把该 reason 交给已有选择器浮层提示（壳里无 toast 通道，见 `platform/notify`） |
| R4 | 修正 `ohos-workspace` 文档"启动自动同步" | **已落实，且早于 issue** | `git show 07f97c5^:…` 逐字有该句；`HEAD` 已无（`570cc2a`，10-03；issue 建于 10-04T19:01Z）⇒ 报告人读的是设备上的旧副本 |
| C1 | node 不继承 picker URI 授权 | **成立（机制；真机无法复核）** | `FilePicker.ets:274-275` 自述"未核实 Node/koffi 侧是否与 fileIo 同权"；但 `:200-215` 又写"探写才是 Host 侧同口径证据"——探针跑在 **ArkTS** `fs` 里 ⇒ **注释与实现口径矛盾**（未修，登记在此） |
| C2 | 工作区根与授权目录无关 | **部分过期** | 原 `main.js:970` 行号失效；工作区根**已接入一条**授权路径 `DSHM_PUBLIC_DOWNLOAD`（`RuntimePort.ets:193-214` → `main.js:1520-1545`）；"用户预先存在的公共目录"仍不进链路 |
| C3 | 不存在复制/同步实现 | **仍成立** | 同 R1 |
| C4 | `sandbox-policy` 可配 `workspaceRoot` | **引用正确** | `dsh-sandbox-policy/lib/index.js:113` 逐字命中；端侧 profile 未设该项（`cordis.patch.yml:81-83` 只设 `mode`） |
| C5 | `WORKSPACE_DIR` 单例 ⇒ 多工作区互相覆盖 | **部分过期** | 单例只在 `host-ready.json` 作"默认工作区提示"（`main.js:1296-1297`）；会话落点由客户端按 `workspaceId` 决定 |
| C6 | 选择器"白做"（UI 已授权、产出为零、无提示） | **已缓解但反馈缺失** | 同 R3；上游机制引用逐条对得上（`dsh-api-workspace-files/lib/index.js:411`、`:580`、`:385` 的 `maxFileBytes` 32 MiB） |

**文档口径冲突（明确）**：`docs/device-validation.md:4333-4361`（批次三十二）判词是"问题一（工作区目录
无法真正生效）——**不是 DSHM 原生缺陷**"，依据是"日志里 EPERM/EACCES = 0"；这与 issue #3 的真机逐条
ACL 对照（Documents/Download/Desktop 全 EPERM）**正面冲突**，且该 doc 自己也登记"本机
`/storage/Users/currentUser` 不存在"，与 issue #3 的 `ls` 成功（31 项）矛盾。**待办**：给该判词加
"对**未授权**公共目录成立"的限定并交叉引用 issue #3。
**技能缺口**：`ohos-workspace.md` 只讲"启动期认领 `Download/<包名>/`"，**完全没讲用户手动选目录这条
路径**（也不提可能被静默换路径）——待办。
**关单前的真机两问**：① 选 `Documents` 时有无 `diag-picker-public-fallback`；② `diag-picker-public-path`
指向哪里。

### 1.4 GitCode #1 —— 侧栏资源预览报「文件资源服务不可用」

**裁定：已落实，可关。** 正文 R1–R3 全部落地且落点在打包层；评论里的两个独立问题也已解决。

| 环节 | 证据 |
|---|---|
| 根因 | ArkWeb 把 `dsh-resource://…` 解析成 **opaque URL** ⇒ `URL.hostname` 恒空 |
| 装甲 | `dsh-client-resources/lib/client.js:23-31`：`hostname === ""` 时用正则从原串重取协议/主机/路径 |
| 三处落地 | 侧栏 `dsh-client-ui-sidebar-right/lib/client.js:8647-8650`；subagent `dsh-client-ui-subagent/lib/client.js:722-731`（host/path/query 三件都取回） |
| PDF 双 realm | `dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js:980`（chunk 工厂）与 `:24740`（内联 worker Blob）；实测 `DSHM_MAP_COMPAT` 2 次、`install(Map.prototype` 4 次 |
| Office docx/pptx | 走 `hostcore/plugins/dshm-office-system-preview/lib/client.js:65`（EXTENSIONS）、`:281-291`（`priority:"extension"`、`loading:"bytes-complete"`）；接线 `cordis.patch.yml:657-659` + `pack-core.mjs` 清单 |
| 注入点 | `tools/pack-core.mjs:2427-2535`（资源地址）、`:2599-2632`（PDF）、调用点 `:3003-3004` |

### 1.5 GitCode #2 —— 端侧终端打不开（已 closed）

**裁定：已落实，closed 站得住。** 三处 diff 逐条命中 + 真机端到端证据。

- 平台白名单：`dsh-subprocess-local/lib/runner-launch-B2zsQ1Dz.js:670`（`linux || openharmony` ⇒ `LinuxProcessInspector`）；
  `lib/index.js:1164`（`shellActivity` 对 openharmony 短路）、`:856`（inspectActivity idle 分支放行）；
  调用点 `:1419-1422` 与 issue 引文逐字一致；注入点 `pack-core.mjs:2634-2682`、调用点 `:3005`。
- 真机端到端：`docs/HANDOFF.md:631`（`ps` 见 `/usr/bin/zsh -i`、PPID=Host、fd→`/dev/pts/0`；PTY 回显 `ZSH=5.9`）。
- **前提已被后续改动绕过**：`cordis.patch.yml:143-146` 现在是系统 `/usr/bin/zsh`（N5，2026-10-03，
  比本补丁晚 91 秒）⇒ `--rcfile` 冲突不再可达。

---

## 2. 历次修复要求台账

| 要求（出处） | 现状 | 证据 |
|---|---|---|
| 修 `experimental-inspector` 启用报错（"1 entry did not activate"） | ✅ 已修复并真机验收 | 根因＝Node 内部 require 的内建 undici 在 jitless 下必炸；v1.46 在 `BuiltinModule` 层接管；门禁 `check-internal-undici.mjs`；真机 `/bootstrap` 200、`did not activate` 0 |
| 重出侧载包并装机测试 | ✅ 多轮（v3→v6） | `dist/sideload/`：每次重出均有新哈希 + `SHA256SUMS.txt` 保留被取代的同名行（注释掉，避免 `sha256sum -c` 自相矛盾） |
| 恢复被误删的签名物料 | ✅ 已恢复 + 建立仓库外备份 + 写进 AGENTS.md 禁令 | `~/.ohos/config` 与 `D:\DSHM-signing-backup\config` **15 个文件逐字节一致**（2026-10-05 复核），`material/` 目录两侧都在；`docs/80` §7 记录重拼方法 |
| 清理环境（不动签名/数据） | ✅ | 只删构建产物与一次性日志；本轮又删 6 个零引用 `dist/_*`（现 32 个） |
| 卷影副本找回坏掉的会话记录 | ✅ 已抢救并暂存，**待用户执行** `D:\DSHM-signing-backup\restore-dsh-sessions.cmd`（需先完全退出 DSH） | 暂存 `C:\Users\Sol\.dsh-restored\sessions`：**6 个工作区会话树 / 212 MB**（其中 `D-desktop-temp-desktop.ohos.arm64` 187 MB），当前活跃库只有 2 个 |
| 重申"永远不要删签名文件" | ✅ 写进 `AGENTS.md`（含事故经过与正确做法） | `AGENTS.md` 的"绝对禁止：删除签名物料"一节 |
| 两路独立审核 + 修掉发现项 | ✅ v1.47 已落地（代码 6 项 + 文档 7 项） | `docs/parity-matrix.md` §3.2 的 v1.47 块 |
| 修 PTC 模式 `run_code` 报 `WebAssembly is not defined` | ✅ 已修复并真机验收（v1.48） | 换同进程纯 JS 运行时 `dshm-ptc-runtime-inproc`；真机：32 个 binding 暴露、30 个实测可用、6000 ms 精确超时；3 条门禁 |
| 修 `glob` 目录锚定失效（P1） | ✅ 已修复并真机验收（v1.49） | 降级参数转换重写（最长字面目录前缀 + `-maxdepth`）；真机 toybox 语义复核 `_tool_probe/*` 新 2 / 旧 6；门禁 42→58 |
| 本文档要求的"收尾审计 + 台账" | ✅ 本文件 | —— |

---

## 3. 开源后（2026-09-30 起）改动审计

### 3.1 改动清单（36 提交 + 10/05 未提交）

| 主题 | 提交/内容 |
|---|---|
| 开源收尾与治理（9/30，4 提交） | `07f97c5` 整理公开仓库（README 面向新读者、去机器专有路径、清构建中间物、`.gitignore` 补到 90 行）、`4995f3a`、`9905fdc`、`3c64244`（CODEOWNERS / issue 模板 / PR 模板 / CONTRIBUTING / SECURITY） |
| ArkTS 壳与 Web 桥取证（10/03–10/04，5） | `c7b6798` web console 落盘、`433a943` 逐跳 `IN-DONE`、`4f03ddd` accept 轨迹 + 事件循环看门狗、`e71015e` 退出原因可拉取、`cadb811` office 预览改系统预览窗 |
| 启动停顿专项（10/04，11） | `2e0bf6f` V8 CPU 采样、`065d210` JS 线程 tid、`fd1e10f` SYNC-RING、`86d9ecd` 心跳线程、`6c8c8fe` SYNC-WARN/COUNT、`8854369` 诊断默认开、`39d87f6` 回退心跳覆盖、4 篇交接读数 |
| 宿主文件能力（10/03，1 大提交） | `570cc2a`（25 文件 / +3014）：三个自带插件 + `DSHM_PUBLIC_DOWNLOAD` + 四处上游构建期补丁 + `check-sidebar-tab-id-guard.mjs` |
| 宿主缺陷修复（10/03，2） | `5bbfe6b`（D1/D2/D3 + N1 出网镜像 + N5 终端改 zsh）、`f6c6684`（U1 undici 具名导出 + N6 用户行去重 + `check-undici-shim-exports.mjs`） |
| 核心与打包（10/04，3） | `000e8d3` 核心升 `0.2.1-alpha.1`（契约第 4 次零漂移）+ 修门禁就绪竞态、`5f27b18` 修 `getReport()` 冷启动 62 s（E388）、`431813e` docs(90) as-built |
| 10/05 未提交（本会话） | jitless 补齐下沉到 worker（`jitless-env.cjs`/`worker-bootstrap.cjs`/`internal-undici-shim.cjs`+2 清单+3 门禁）；PTC 换同进程运行时（插件 + profile + 3 门禁）；`fs-search` 降级修目录锚定 + **可重入重打**（pristine + 哈希校验 + 注入后 `node --check`）；工具链/装机/签名（`update-device.ps1` 的 EAP 修复、`docs/80` §7、AGENTS 禁令）；本文件的各项口径修复 |

### 3.2 发现与落实状态（15 项）

| # | 发现（证据） | 状态 |
|---|---|---|
| 1 | **`assert-resfile-sync` 一度是红的**：改 `main.js` 未 `place-host-app` ⇒ 差额 849 B/15 行，下次构建会把旧 `main.js` 静默打进 HAP（该门禁存在的理由） | ✅ **已修**（跑 `place-host-app`，13 件同步；并已在 18/18 复跑中确认） |
| 2 | **5 条必跑门禁 + 4 项资产未进 git**（3 个 `.cjs` + PTC 插件 + 5 条门禁）；`main.js:125` 无条件 require `jitless-env.cjs` ⇒ 不提交则新克隆宿主起不来、AGENTS 门禁成幽灵 | ⏳ **待提交**（HEAD 的 `main.js` 不引用这些文件，故公开 HEAD 自洽；但 10/05 的修复必须 commit 才能发布）——**待用户决定提交/推送** |
| 3 | parity 变更记录**缺 10/01–10/03**（v1.44 直接跳 v1.45，而 `570cc2a` 是最大一次改动） | ✅ **已补** v1.44.1 |
| 4 | issue #3 的 R3 只做一半（reason 被丢弃） | ✅ **已修**（`Index.ets` 的成功带提示分支） |
| 5 | `device-validation.md:4333-4361` 判词与 issue #3 真机 EPERM 正面冲突 | ⏳ 待办（加"对未授权公共目录成立"限定） |
| 6 | `docs/90` 里 16 处 `AGENTS.md:N` 引用因 AGENTS 增行而全部失效，且 `check-doc-refs.mjs` **明文排除** `AGENTS.md`/`README.md`/`tools/*.mjs:N` | ✅ 部分：本轮已把该节改为**不钉行号**（"以 AGENTS 为准"）；⏳ 待办：把 `AGENTS.md` 纳入 `check-doc-refs` 判定 |
| 7 | `docs/90` 转抄的门禁清单缺 3 条 PTC、且"7 条"残留 5 处 | ✅ **已修**（补 3 条 + 全部改为"以 AGENTS 为准"） |
| 8 | `docs/90` §2.3 的"本次实测读数"多处过期（35→38、39→58、10→13 件、138/138→140/140…） | ✅ **已修**：加**时效声明 + 当前复核值**（历史快照故意不改，避免篡改取证） |
| 9 | 两份"权威门禁清单"分叉（`AGENTS.md` 15 项 vs `CONTRIBUTING.md` 8 项） | ✅ **已修**（CONTRIBUTING 改为"以 AGENTS 为准"的人类最小集） |
| 10 | 4 个自带插件 + PTC 运行时**没进 parity 台账**（§4.6 仍"端侧独有 11 行"，且 `check-parity` 只按官方 39 个 id 判定 ⇒ 新端侧能力永远无人要求登记） | ⏳ 待办（需给 parity 增"端侧独有"登记规则） |
| 11 | `fetch-shim.js:687-708` 孤儿 JSDoc（`installFetchShim` 的旧文档块现在"属于" `defineGlobalShim`） | ⏳ 待办（小） |
| 12 | `ts-strip.cjs:414-417` 写"真机尚未验证"，与 changelog"真机验收通过"矛盾 | ✅ **已修**（端侧已验收，注释改为事实 + 残留边界） |
| 13 | `parity-matrix.md:334` 写插件 `index.js` 37,227 B，实际 38,518 B | ✅ **已修** |
| 14 | `dist/_*` 清理口径与事实不符（自述"只留 32 个被引用"，实测 37 个里 6 个零引用） | ✅ **已修**（删 6 个，现 32 个） |
| 15 | 零散：AGENTS"编号连续 `00-`…`80-`"而 `docs/90` 存在；`pack-core.mjs` 拼写 `pristinMeta`；原生库路径两份实现（`main.js:613-625` vs `jitless-env.cjs:90-100`）；`main.js:243`/`:251` 同一噪声两种措辞 | ✅ 部分（编号范围与拼写已修）；⏳ 待办（原生库路径合并、噪声措辞统一） |

### 3.3 口径一致性修复（本轮已落地，12 处）

1. `cordis.patch.yml` ⑦/⑩：删掉"不用 `rename`（未证实）/ 就地写**非原子**"——实现是 `.partial` + `rename`（**原子**）。
2. `main.js:1690`/`:1729-1741` + profile `:156-158`："本机（手机档）`ash=denied`"是**档位指代漂移** ⇒ 改为档位相关（手机档不可用 / PC·2in1 档实测可用）。
3. `README.md:47`/`:68`/`:202`：权限声明由"10 项普通、不申请任何 ACL"改为事实——**11 项 = 6 普通 + 5 ACL**（`module.json5` 实测）。
4. `parity-matrix.md:53`：设备验证轴由 `PENDING`（"本环境无真机"）改为 `PASS` + 逐条口径说明。
5. `parity-matrix.md:197`/`:199`/`:200`：核心包由 `0.2.0-rc.2`/78,081,448 B/29351 条目 → **`0.2.1-alpha.1`/84,696,776 B/30,462 条目**；"29006 个文件" → **27,041 个文件**；协议契约示例版本同步。
6. `docs/90`：见 §3.2 的 6/7/8。
7. `CONTRIBUTING.md`：见 §3.2 的 9。
8. `dist/sideload/README.md` + `GITCODE-RELEASE-NOTES.md`：**补上三条随包却从未记录的端侧补丁** + 两条已知边界（`docx`/`pptx` 依赖系统预览窗；终端 activity 恒 `unknown`）。
9. `docs/70`：新增 **§14**，把上述三条登进坑库（含"无独立门禁"的缺口与方案）。

---

## 4. 门禁与真机读数（2026-10-05 11:37 收尾版）

**本机门禁：18/18 全绿**（`AGENTS.md` 清单 15 项 + `check-native-closure` / `check-plugin-toggle` / `check-dead-code`）。
关键条数：`assert-cli-shim` 40、`assert-exec-fix` 38、`assert-python-bridge` 69、`assert-fs-search-fallback` **58**、
`check-skill-sync` 32、`check-ptc-ts-strip` **81**（wasm 陷阱 0 触发）、`check-ptc-runtime-inproc` **166**、
`check-ptc-wiring` **10 项一致**、`compat-drift` **140/140**、`assert-resfile-sync` **13 件同步**、
`check-parity`（DONE 14 / PARTIAL 31 / BOUNDARY 3 / TODO 2，缺口登记 36 个 id）。

**真机（`-r` 覆盖安装 + 冷启动）**：`did not activate` **0**、`WebAssembly is not defined` **0**、
`SEARCH_FAILED` **0**；PTC 运行时自证行在（含内容哈希：`index.js:142a320c8d1f6266`、
`vm-run.js:c651d7b343620023`、`ts-strip.cjs:f2600ed680a9fc4b`、`vendor:254d0fe4bd4a17bc`，哈希耗时 16.2 ms）；
`dsh/home` 的 `links=13`/`size=3440` 安装前后一致；`exec 探测 8/8` 全通。

**启动预算**：到 HTTP ready **5.28 s**（`BOOT_40` 488 ms → `BOOT_65` 5042 ms 为 profile/插件装载）。
**登记的"1.6–2.0 s 事件循环停顿"当前未复现**：看门狗（≥1.5 s 记 `LOOP-GAP`）与同步环（≥200 ms 记 `SYNC-WARN`）
本次启动**零事件**（日志里的 2 处 `LOOP-GAP` 只是埋点说明文字）。

**侧载包**：`DSHM-1.0.0-core0.2.1-alpha.1-arm64-signed.hap`，320,932,668 B / 306.07 MiB，
sha256 `d7d4797cb2137e155c76f21a83efdb5c86cc21413062f1261b0149d51bb13e61`（v6 修订，2026-10-05 11:37）。

---

## 5. 未落实 / 待办（含方案与风险）

| # | 事项 | 方案 | 风险 |
|---|---|---|---|
| 1 | **提交并推送 10/05 的修复**（否则公开仓库拿不到 inspector/PTC/glob 这些修复；且 `main.js` 硬依赖未跟踪的 `jitless-env.cjs`） | `git add` 那 9 项未跟踪资产 + 本轮改动，按仓库既有提交风格（中文、`fix(...)`/`docs(...)` 前缀）分主题提交 | 推送是**对外动作**，需用户确认（是否同时推 GitHub 与 GitCode、是否先发 release） |
| 2 | 三条端侧补丁的**独立门禁** | 新增 `tools/check-core-openharmony-patches.mjs`（照 `check-sidebar-tab-id-guard.mjs`：版本取自 `core-recipe.json`、缺树 exit 3、带 `--self-test`），断言 `DSHM_RESOURCE_ARMOR_PROTOCOL/PATH/SUBAGENT`、`DSHM_MAP_COMPAT`、`DSHM_OPENHARMONY_SUBPROCESS` 在树内且 PDF 两处各一次 | 低；纯只读断言 |
| 3 | **phone 档工具链解包**（GitHub #2 §3） | 见 §1.2 的最小改法（进程内回退 + 分片让出） | 中高：4530 文件同步解卡事件循环；且"解包成功 ≠ 可 execve"。**建议先开 issue 记录，不在本轮改代码** |
| 4 | `ohos-workspace.md` 补"手动选目录"一节 | 讲清：用户选公共目录 ⇒ 探写失败会**改用应用目录**，node 侧只认 `DSHM_PUBLIC_DOWNLOAD` | 低 |
| 5 | `device-validation.md:4333-4361` 判词加限定 | 改为"对**未授权**公共目录成立"，交叉引用 issue #3 + `diag-picker-*` 标记 | 低 |
| 6 | `WebApp.ets` 换路径原因上报壳层 | 经 `emitter`（`HostEvents.ets` 已定义事件 id 契约）发事件、壳层用现有提示状态位显示 | 低-中（需 ArkTS 编译 + 真机 UI 验证） |
| 7 | parity 增"端侧独有"登记规则 | 让 `check-parity.mjs` 也要求 5 个 `dshm-*` 能力面在台账里有行 | 中（改门禁判定面） |
| 8 | `fetch-shim.js:687-708` 孤儿 JSDoc / 原生库路径两份实现 / `main.js` 噪声措辞统一 | 搬迁注释、抽单一来源 | 低 |
| 9 | CI 与社区文件 | 新增 `.github/workflows`（在 ubuntu 上跑**不依赖设备与 SDK** 的那批门禁：`check-parity`/`check-doc-refs`/`check-ptc-*`/`assert-resfile-sync` 等）+ `CODE_OF_CONDUCT.md` | 低；但 CI 首次运行可能暴露平台相关的门禁不可移植 |
| 10 | 真机 UI 验收（issue #3 关单前） | 让端侧会话跑：选 `Documents` 看 `diag-picker-public-fallback`、`diag-picker-public-path`；并在工作区选择流程里确认新的提示浮层可见 | 需设备交互 |
| 11 | 仍未复核的门禁（约 19 条） | `check-origin-fence` / `check-model-roundtrip` / `check-arkts-entry` / `check-layout-fixtures` / `check-design-tokens` / `check-feature-wiring` / `check-builder-recursion` / `check-dshm-installer` / `check-fetch-shim` / `check-custom-api-*` 等 | 低（按改动面选跑） |

---

## 6. 复核方法

```powershell
# 本机门禁（以 AGENTS.md 清单为准）
node tools/check-parity.mjs ; node tools/check-doc-refs.mjs
node tools/assert-resfile-sync.mjs        # 必须 13 件同步
node tools/assert-fs-search-fallback.mjs  # 必须 58 通过 / 0 失败
node tools/check-ptc-ts-strip.mjs         # 81 条 + wasm 陷阱 0 触发
node tools/check-ptc-runtime-inproc.mjs   # 166 条（整体在 --jitless 下）
node tools/check-ptc-wiring.mjs           # 10 项一致（含"树里那份=源码那份"）

# 真机（唯一受认可的装机入口）
.\tools\update-device.ps1 -SkipRebuild    # 或省略 -SkipRebuild 重编
hdc shell "grep -a -c 'did not activate' <files>/node-output.log"   # 期望 0
hdc shell "grep -a -o '自证 sha256(前16)=[^*]*）' <files>/node-output.log | tail -1"
hdc shell "stat -c 'links=%h size=%s' <files>/dsh/home"             # 期望 links=13 size=3440

# 侧载包
(Get-FileHash dist\sideload\DSHM-1.0.0-core0.2.1-alpha.1-arm64-signed.hap).Hash  # 见 §4 的 sha256
```
