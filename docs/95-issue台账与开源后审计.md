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
| 2 | **5 条必跑门禁 + 4 项资产未进 git**（3 个 `.cjs` + PTC 插件 + 5 条门禁）；`main.js:125` 无条件 require `jitless-env.cjs` ⇒ 不提交则新克隆宿主起不来、AGENTS 门禁成幽灵 | ✅ **已提交（本地）**：`b4bdcb5`（host/ptc/pack-core 三主线 + 3 个 `.cjs` + PTC 插件 + 5 条门禁）、`7ff6f7f`（文档与台账）、`71c8cba`（工作区选择器反馈）。**未推送**（按用户决定；HEAD 的 `main.js` 不引用这些文件，故公开 HEAD 在此之前是自洽的） |
| 3 | parity 变更记录**缺 10/01–10/03**（v1.44 直接跳 v1.45，而 `570cc2a` 是最大一次改动） | ✅ **已补** v1.44.1 |
| 4 | issue #3 的 R3 只做一半（reason 被丢弃） | ✅ **已修**（`Index.ets` 的成功带提示分支） |
| 5 | `device-validation.md:4333-4361` 判词与 issue #3 真机 EPERM 正面冲突 | ⏳ 待办（加"对未授权公共目录成立"限定） |
| 6 | `docs/90` 里 16 处 `AGENTS.md:N` 引用因 AGENTS 增行而全部失效，且 `check-doc-refs.mjs` **明文排除** `AGENTS.md`/`README.md`/`tools/*.mjs:N` | ✅ 部分：本轮已把该节改为**不钉行号**（"以 AGENTS 为准"）；⏳ 待办：把 `AGENTS.md` 纳入 `check-doc-refs` 判定 |
| 7 | `docs/90` 转抄的门禁清单缺 3 条 PTC、且"7 条"残留 5 处 | ✅ **已修**（补 3 条 + 全部改为"以 AGENTS 为准"） |
| 8 | `docs/90` §2.3 的"本次实测读数"多处过期（35→38、39→58、10→13 件、138/138→140/140…） | ✅ **已修**：加**时效声明 + 当前复核值**（历史快照故意不改，避免篡改取证） |
| 9 | 两份"权威门禁清单"分叉（`AGENTS.md` 15 项 vs `CONTRIBUTING.md` 8 项） | ✅ **已修**（CONTRIBUTING 改为"以 AGENTS 为准"的人类最小集） |
| 10 | 4 个自带插件 + PTC 运行时**没进 parity 台账**（§4.6 仍"端侧独有 11 行"，且 `check-parity` 只按官方 39 个 id 判定 ⇒ 新端侧能力永远无人要求登记） | ⏳ 待办（需给 parity 增"端侧独有"登记规则） |
| 11 | `fetch-shim.js:687-708` 孤儿 JSDoc（`installFetchShim` 的旧文档块现在"属于" `defineGlobalShim`） | ✅ **已修**（第三轮：文档块移回它描述的函数上方 + `@returns {boolean}` 写准，见 §8.3） |
| 12 | `ts-strip.cjs:414-417` 写"真机尚未验证"，与 changelog"真机验收通过"矛盾 | ✅ **已修**（端侧已验收，注释改为事实 + 残留边界） |
| 13 | `parity-matrix.md:334` 写插件 `index.js` 37,227 B，实际 38,518 B | ✅ **已修** |
| 14 | `dist/_*` 清理口径与事实不符（自述"只留 32 个被引用"，实测 37 个里 6 个零引用） | ✅ **已修**（删 6 个，现 32 个） |
| 15 | 零散：AGENTS"编号连续 `00-`…`80-`"而 `docs/90` 存在；`pack-core.mjs` 拼写 `pristinMeta`；原生库路径两份实现（`main.js:613-625` vs `jitless-env.cjs:90-100`）；`main.js:243`/`:251` 同一噪声两种措辞 | ✅ **已全部修**（编号范围→`95-`、拼写→`pristineMeta`、原生库路径合并为 `jitlessEnv.resolveNativeLibsDir()`、噪声文案抽成 `diagKnownJitlessUndiciNoise()`；另修 `pack-core.mjs:2149` 的"4 处"→"6 处"）。见 §8.3/§8.1 |

### 3.3 口径一致性修复（本轮已落地，12 处）

1. `cordis.patch.yml` ⑦/⑩：删掉"不用 `rename`（未证实）/ 就地写**非原子**"——实现是 `.partial` + `rename`（**原子**）。
2. `main.js:1690`/`:1729-1741` + profile `:156-158`："本机（手机档）`ash=denied`"是**档位指代漂移** ⇒ 改为档位相关（手机档不可用 / PC·2in1 档实测可用）。
3. `README.md`/`:68`/`:202`：权限声明由"10 项普通、不申请任何 ACL"改为事实——**11 项 = 6 普通 + 5 ACL**（`module.json5` 实测）。
4. `parity-matrix.md:53`：设备验证轴由 `PENDING`（"本环境无真机"）改为 `PASS` + 逐条口径说明。
5. `parity-matrix.md:197`/`:199`/`:200`：核心包由 `0.2.0-rc.2`/78,081,448 B/29351 条目 → **`0.2.1-alpha.1`/84,696,776 B/30,462 条目**；"29006 个文件" → **27,041 个文件**；协议契约示例版本同步。
6. `docs/90`：见 §3.2 的 6/7/8。
7. `CONTRIBUTING.md`：见 §3.2 的 9。
8. `dist/sideload/README.md` + `GITCODE-RELEASE-NOTES.md`：**补上三条随包却从未记录的端侧补丁** + 两条已知边界（`docx`/`pptx` 依赖系统预览窗；终端 activity 恒 `unknown`）。
9. `docs/70`：新增 **§14**，把上述三条登进坑库（含"无独立门禁"的缺口与方案）。

---

## 4. 门禁与真机读数（2026-10-05 11:37 收尾版）

**本机门禁：19/19 全绿**（`AGENTS.md` 清单 16 项 = 15 条 node + `device-acceptance.ps1`，再加
`check-native-closure` / `check-plugin-toggle` / `check-doc-refs` / `check-dead-code`；其中
`check-core-openharmony-patches.mjs` 是 2026-10-05 下午新增的第 15 条 node 门禁）。
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
| 1 | **推送 10/05 的修复**（本地已提交 `b4bdcb5`/`7ff6f7f`/`71c8cba`；未推送 ⇒ GitHub/GitCode 的新克隆仍拿不到 inspector/PTC/glob 这些修复） | `git push`（两个远端都是公开仓库；也可先发 release/侧载包再推） | 推送是**对外动作** ⇒ 已按用户决定"只提交到本地"，待另行择时 |
| 2 | 三条端侧补丁的**独立门禁** | 新增 `tools/check-core-openharmony-patches.mjs`（照 `check-sidebar-tab-id-guard.mjs`：版本取自 `core-recipe.json`、缺树 exit 3、带 `--self-test`），断言 `DSHM_RESOURCE_ARMOR_PROTOCOL/PATH/SUBAGENT`、`DSHM_MAP_COMPAT`、`DSHM_OPENHARMONY_SUBPROCESS` 在树内且 PDF 两处各一次 | 低；纯只读断言 |
| 3 | **phone 档工具链解包**（GitHub #2 §3） | 见 §1.2 的最小改法（进程内回退 + 分片让出） | 中高：4530 文件同步解卡事件循环；且"解包成功 ≠ 可 execve"。**建议先开 issue 记录，不在本轮改代码** |
| 4 | `ohos-workspace.md` 补"手动选目录"一节 | 讲清：用户选公共目录 ⇒ 探写失败会**改用应用目录**，node 侧只认 `DSHM_PUBLIC_DOWNLOAD` | 低 |
| 5 | `device-validation.md:4333-4361` 判词加限定 | 改为"对**未授权**公共目录成立"，交叉引用 issue #3 + `diag-picker-*` 标记 | 低 |
| 6 | `WebApp.ets` 换路径原因上报壳层 | 经 `emitter`（`HostEvents.ets` 已定义事件 id 契约）发事件、壳层用现有提示状态位显示 | 低-中（需 ArkTS 编译 + 真机 UI 验证） |
| 7 | parity 增"端侧独有"登记规则 | 让 `check-parity.mjs` 也要求 5 个 `dshm-*` 能力面在台账里有行 | 中（改门禁判定面） |
| 8 | `fetch-shim.js:687-708` 孤儿 JSDoc / 原生库路径两份实现 / `main.js` 噪声措辞统一 | ✅ **第三轮已全部落实**（见 §8.3） | 低 |
| 9 | CI 与社区文件 | 新增 `.github/workflows`（在 ubuntu 上跑**不依赖设备与 SDK** 的那批门禁：`check-parity`/`check-doc-refs`/`check-ptc-*`/`assert-resfile-sync` 等）+ `CODE_OF_CONDUCT.md` | 低；但 CI 首次运行可能暴露平台相关的门禁不可移植 |
| 10 | 真机 UI 验收（issue #3 关单前） | 让端侧会话跑：选 `Documents` 看 `diag-picker-public-fallback`、`diag-picker-public-path`；并在工作区选择流程里确认新的提示浮层可见 | 需设备交互 |
| 11 | 仍未复核的门禁（约 19 条） | ✅ **第三轮已全量普查**：仓库 **43 个**门禁脚本逐个实跑 ⇒ **42 exit 0 / 1 exit 1**；唯一红的是 `check-model-roundtrip.mjs`（默认带 prompt 需 koffi，HAP 专属 ⇒ **环境依赖**；`--no-prompt` exit 0）。见 §8.2 | 无（已定性） |

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

---

## 7. 第二轮（2026-10-05 下午）落实记录

用户从 §5 的 11 项待办里选定 6 项，本轮逐项落实（②因本机缺工具只能交付草稿）。

| 项 | 状态 | 证据 |
|---|---|---|
| ① 新增"三条端侧补丁"的独立门禁 | ✅ | 新增 `tools/check-core-openharmony-patches.mjs`（348 行 / **13 条断言**）：正常 exit 0、`--self-test` 5 个变异用例全红（M5 专门证明**反向断言单独**能红）、缺树 exit 3（实测：树改名 → exit 3，改回 → 复绿）。已加进 `AGENTS.md` 必跑清单 ⇒ 现 **16 项 = 15 条 node + `device-acceptance.ps1`**（`CONTRIBUTING.md` 与 `docs/90` 的条数口径同步改齐）。**核实到的真实标记**：资源装甲三处各 ×1；PDF `DSHM_MAP_COMPAT` **恰好 2 次**（主线程 chunk 工厂 / 内联 worker 的 Blob 字面量，两处形态可区分）；终端标记 **3 处**（`runner-launch-*.js:670`、`index.js:1164`、`index.js:856`）。⚠ 踩坑：反向断言**不能**写成"文件里不许再有 `platform === \"linux\"`"——树里还有 2 处**无关**上游判定（`runner-launch-B2zsQ1Dz.js:811`、`index.js:1387`），那样会恒红；门禁改为逐字否掉被替换的 3 条上游语句 |
| ② phone 档工具链解包（GitHub #2 §3） | ⏳ **草稿就绪，待你发** | 本机**没有 `gh` CLI、没有任何 GitHub token**（已实测）⇒ 无法代开。可直接粘贴的正文在 `dist/_issues/DRAFT-github-2-sec3-phone-toolchain.md`：现象、`文件:行` 证据、最小改法（复用 `dshm-installer.js:157 extractTar()` + 分片让出）、风险（4530 文件同步解卡事件循环、hmfs 的 `utimensat`/`symlink` 语义）、以及**必须写死的边界**"解包成功 ≠ 工具链可用" |
| ③ WebApp 换路径原因上报壳层 | ✅（待真机点一次） | `platform/src/main/ets/system/HostEvents.ets` 新增 `EVENT_PICKER_SUBSTITUTED`（`0xD5A2`）+ 两个载荷键（沿用"id 与键只在 platform 定义一处"的既有契约）；`WebApp.ets` 在"探写失败 ⇒ 改用应用公共目录"处分发事件（此前**只落 diag 标记** ⇒ 用户看不到）；`Index.ets` 在 `aboutToAppear` 订阅、`aboutToDisappear` 退订，收到后打开已有目录浮层、把原因与实际路径写在顶部。**仍未做**：真机跑一次这条交互（需要 Web 端目录选择器） |
| ④ CI + `CODE_OF_CONDUCT.md` | ✅ | 见 §7.3 |
| ⑤ parity 增"端侧独有"登记规则 | ✅ | `tools/check-parity.mjs` 新增 `REQUIRED_LOCAL_SURFACE`（16 个 id）+ **不变式 A2**：列出的端侧能力面**必须各有行**，否则红。矩阵 §4.6 补登 **5 行**（`dshm-tool-fs-remove` / `dshm-fs-write-nonchmod` / `dshm-workspace-claim` / `dshm-office-system-preview` / `dshm-ptc-runtime-inproc`）；统计 50 → **55 行**（DONE 18 · PARTIAL 32 · BOUNDARY 3 · TODO 2），§6 补 `dshm-office-system-preview` 的缺口登记。**负测试**：改掉某行 id ⇒ 门禁红并点名该 id；还原后复绿且文件**逐字节一致**（无残留） |
| ⑥ UI 提示与技能文档收口 | ✅ | ① 技能 `entry/src/main/resources/resfile/ohos-skills/ohos-workspace.md` 新增「用户手动选目录」一节：写明"选中的路径会成为工作区，**但目录选择器的授权不跨进程** ⇒ node 侧可能 `EPERM`；外壳会改用应用认领的 `Download/<包名>/` 并显示原因；**模型不得假定用户选的路径可写**，判断工作区只认会话 cwd / 启动日志的 `默认工作区：…`"。② `docs/device-validation.md` 的「批次三十二」判词加**范围限定 + 交叉引用 issue #3**：那条"不是 DSHM 原生缺陷"只对"ArkTS 侧拿到的是不是用户真路径"成立，**不能**推出"node 侧可读用户选中的公共目录"；`EPERM/EACCES = 0` 只说明当时没走到被拒分支。门禁复核：`check-skill-sync` **32/32**、`check-doc-refs` **254 条引用全过**、`check-dead-code` 无死代码、`check-parity` 通过 |

### 7.1 顺带发现并修掉的真缺陷

| 发现 | 影响 | 修法 |
|---|---|---|
| **`tools/update-device.ps1` 的"数据保全"校验是结构性假通过** | 基线用 `ls $filesDir/dsh/home \| wc -l`，而 `dsh/home` 是 **0700**、`hdc shell` 是另一个 uid ⇒ `ls` 被拒、计数**恒 0** ⇒ 每次打"home 为空（可能是全新设备，或数据已被清）"、第 7 步必然 `SKIP 本次无法证明「数据被保留」`。这台设备其实**数据完好**（同一时刻 `stat` 给 `links=13 size=3440`）。**后果**：唯一"证明覆盖安装没删数据"的检查等于不存在，还会误导人以为"数据被清了" | 改用 **stat 指纹**（`links=%h size=%s`）作判据：`links` **减少**才判失败，相等/增加算保留；`ls` 那条降级为"预期不可读"的说明（不再当判据）。已实测新脚本输出 `home 指纹：links=13 size=3440` |
| **`emitter.off` 与 `emitter.on`/`emit` 的 API 不对称** | `on`/`emit` 收 `InnerEvent`（`{ eventId }`），而 `off` 的重载只收**裸 number/string**（`@ohos.events.emitter.d.ts:115/129/147/166`）⇒ 照抄 `on` 的形状写 `off({ eventId })` 编译失败（实测 **9 个级联错误**全出自这一行，`Argument of type '{ eventId: any; }' is not assignable to parameter of type 'string'`） | `Index.ets` 改为 `emitter.off(EVENT_PICKER_SUBSTITUTED, cb)`，并把这条不对称写进代码注释 |

### 7.2 门禁缺口 → **已落实**（第三轮扩容，见 §8.1）

`check-core-openharmony-patches.mjs` 已从"只覆盖 3 处补丁"扩成**"全部注入标记"清单门禁**。
原先列出的 10 处全部纳入，另发现并纳入源码里的 `embedDshmToolPackages()`（原清单**漏了它**，
而真正读 `DSHM_PUBLIC_DOWNLOAD` 的代码在它装的插件里，不在 `embedProfile` 里）。

### 7.3 CI 与行为准则

- 新增 `.github/workflows/gates.yml`（ubuntu-latest + `setup-node`）：只入列**干净克隆可跑**的 **11 条**门禁
  （另加 6 条 `--self-test` 证明检测器真会红），排除 **9 条**并在 YAML 注释里逐条写明依据。
- 新增 `CODE_OF_CONDUCT.md`（Contributor Covenant 2.1 中文结构；联系方式＝GitHub Issue/Discussions 三个链接，**无邮箱**）。
- ⚠ **纠正我先前的错误前提**：`entry/src/main/resources/resfile/*.zip` **不入库**（`.gitignore:42`）⇒
  干净克隆里**没有核心树**，需要它的门禁会 `exit 2/3`（独立作业实测：`assert-fs-search-fallback` exit 1；
  `check-web-fetch-jitless` / `check-ptc-runtime-inproc` / `check-ptc-wiring` / `check-core-openharmony-patches` exit 3；
  `compat-drift` / `check-plugin-toggle` / `check-native-closure` exit 2）⇒ CI **不能**包含它们。
  `AGENTS.md` 已按"哪些门禁需要核心树/设备"补了一段，避免把"CI 绿"读成"全绿"。
- 顺带修掉一个**跨平台假红**（同一独立作业在 `core.autocrlf=true` 的干净克隆里实测到）：
  `check-ptc-ts-strip.mjs` 断言 vendor `babel.min.cjs` 的字节数 = 3,069,546，而 Windows 默认把 LF 检出成
  CRLF ⇒ 3,069,550 ⇒ 门禁**假红**。⇒ 新增 **`.gitattributes`**（`* text=auto eol=lf` + 二进制声明），
  与当前 index（`git ls-files --eol` 全为 `lf`）一致 ⇒ **不产生任何行尾改动**。
- **未验证**：CI 从未真跑过（本机没有 GitHub Actions 环境）；入列的 11 条是在**本地等价克隆**
  （`git -c core.autocrlf=false clone`）里按 YAML 步骤逐条实跑、18/18 exit 0 得出的。

### 7.4 本轮之后剩下的

1. **②的 issue 需要你发**（草稿已就绪）。
2. **③与⑤的真机 UI 验收**：Web 端目录选择器选一个不可写目录（如 `Documents`）⇒ 应看到浮层提示；
   并复核 `diag-picker-public-fallback` / `diag-picker-public-path` 两个标记（这也是 issue #3 关单前的两问）。
3. §7.2 的 10 处补丁门禁扩展 → **已在第三轮完成**（见 §8.1）。
4. §5 剩余的 8/11 项（原生库路径两份实现、`main.js` 噪声措辞统一、约 19 条未复核门禁等）→ **第三轮完成**。
5. **推送**（本地已提交/将提交，远端仍未更新）。

---

## 8. 第三轮（2026-10-05 傍晚）

### 8.1 门禁扩容：13 处注入 / 94 条断言 / 85 个自检用例

`tools/check-core-openharmony-patches.mjs`：382 → **1084 行**（`RESULT: 94 passed, 0 failed`）。
- **覆盖 13 处注入**：资源地址装甲（3 文件）· PDF `Map` · 终端 openharmony · 语音原生采集 ·
  录音约束（AEC/NS）· HMS provider（+2 个 cpSync 产物）· `embedProfile`（整目录逐字节）·
  **`embedDshmToolPackages`（5 个 `dshm-*` 目录逐字节）** · session link · 凭据 660 · preset workflow ·
  app-boot 只读 stack（两份副本）· fs-local link · attachment link
- **94 条 = 正向 61（标记计数 17 + 注入片段 34 + cpSync 产物 2 + 树内副本逐字节 8）+ 反向 20（逐字否上游原文 13 + 结构反向 7）**；
  同一批另有 7 条反向判据只在失败时发声
- **`--self-test` 85 个用例**：除手写 M1–M8 外，对**每一条**判据做变异扫射（反向原文逐条塞回、
  标记逐条改名/插入、正向片段逐条抠掉**全部**出现、产物逐条删除、mirrors 逐条改动），
  并断言"这次红**只能**来自这条判据" ⇒ 防"恒真/恒假的摆设判据"
- 缺树 **exit 3**（实测：改名 → 门禁与自检都 3；改回 → 复绿）

**两个只有扩展才暴露的坑**（都写进了代码注释）：
1. **看不见的恒真**：`profiles/ondevice/cordis.patch.yml` 是 **CRLF**（实测 667 个 CRLF），
   而 `pack-core` 的替换模板一律 `\n` ⇒ 多行反向判据不做归一化就会**恒绿**（摆设判据）。
   门禁现在读取时把 `\r\n` 折成 `\n`（逐字节判据仍读原始字节）。
2. **注释与实现不符**：`tools/pack-core.mjs:2149` 原写"这 **4** 处"，实际是"两份副本 × 各 3 处 = **6**"；
   门禁按树内实际钉死，注释已就地更正。

**仍未纳入的 6 处**（同为打包期 `die()` 兜底、无独立门禁）：`allowOriginList`（`DSHM_ORIGIN_LIST`）、
`wrapSharp`（`0.0.0-dshm-dispatch`）、`addSystemAddonPackage`（`0.1.2-dshm-shim`）、`addOnDevicePreset`、
`addPlatformAliases`、`embedTreeInfo`。下一轮按同一形状纳入，或明确记为"由行为门禁覆盖"。

### 8.2 全量门禁普查：43 个脚本，42 绿 / 1 红（且已定性为环境）

2026-10-05 把仓库里**所有** `check-*` / `assert-*` / `audit-*` / `neg-test-*` / `arch-check` 脚本逐个跑了一遍
（`dist/_gate-sweep.json` 留了明细）：**42 exit 0 / 1 exit 1**。此前文档里"未复核"的那 19 条
（`check-arkts-entry` / `check-layout-fixtures` / `check-origin-fence` / `check-dshm-installer` /
`check-store-readiness` / `check-toolchain-sign` / `check-user-rows-preflight` / `neg-test-piai` / …）
**全部 exit 0**。

唯一红的 `check-model-roundtrip.mjs`（默认带 prompt）：失败点是 `turn/end` 的 `reason.kind=error`，
原文 `Cannot find the native Koffi module; did you bundle it correctly?` ⇒ **本机缺 koffi**
（HAP 专属、不入库）⇒ **环境依赖，不是产品缺陷**；`--no-prompt` **exit 0**。
`docs/90` 里"待查 / 不是环境缺件"的两处措辞已就地更正（§2.3 的读数表与"红项定性表"）。

### 8.3 三处小收口（§5 的零散项）

| 项 | 状态 |
|---|---|
| `fetch-shim.js` 的**孤儿 JSDoc** | ✅ 已修：`installFetchShim` 的文档块此前紧贴在 `defineGlobalShim` 上方（`@returns` 与实际函数对不上）⇒ 移回它描述的函数上方，并把返回值写成 `{boolean}` |
| `main.js` 同一噪声**两种措辞** | ✅ 已修：抽成 `diagKnownJitlessUndiciNoise()`，两个进程级入口共用（此前"已由垫片接管" vs "已由 fetch 垫片接管"两种写法会让日志检索漏项） |
| 原生库路径**两份实现** | ✅ 已修：`main.js` 的 `NATIVE_LIBS` IIFE 与 `jitless-env.cjs:resolveNativeLibsDir()` 各写一份 ⇒ 改为调用同一份实现（`NATIVE_LIBS` 名字保留，另有 5 处用它拼路径）；漂移的后果本来是"垫片按 A 找库、python 桥按 B 拼路径"，只在真机 `dlopen` 失败时才暴露 |

---

## 9. 第四轮（2026-10-05 夜）

### 9.1 文档引用门禁补判据 F：不许对 `AGENTS.md`/`README.md` 写行号

审计 §3.2 第 6 项的后半（"`check-doc-refs.mjs` 明文排除 `AGENTS.md`/`README.md` ⇒ 那 16 处失效引用
无门禁可挡"）**已堵上根因**：

- **新判据 F「不可核对」**：出现 `` `AGENTS.md:N` `` / `` `AGENTS.md:N-M` `` / `` `README.md:N` `` 即报错
  —— 这类引用既不是 `docs/` 内互引、也不在被引判定集内 ⇒ 行号无人核对、必然无声腐烂。
- 同时把 `AGENTS.md` / `README.md` 作为**源**纳入扫描（它们引用 `docs/NN-*.md` 从此也要核对）；
  两者仍**不是被引目标**，所以对它们写行号由判据 F 拦下。
- **存量 42 处已清**：`docs/90` **36** 处 · `docs/review-report-2026-09-29.md` 3 处 ·
  `docs/parity-matrix.md` 1 处 · `docs/functional-test-report.md` 1 处 · `docs/95` 1 处。
  清理用 **Node 一次性脚本**（刻意不用 PowerShell 做文本往返：PS 5.1 按 GBK 解码 UTF-8，
  上一轮有过"把一个 .mjs 毁成单行双重编码"的实例）；脚本用完即删。
- 自检加 3 个用例。**附带踩坑**：自检样例数组的**下标 = 行号**，新样例必须加在**末尾**
  —— 插在中间会让后面每个断言整体位移（本次踩过一次，3 个用例转红），这条已写进代码注释。
- 验证：门禁 exit 0（扫描 **25** 个文档 / **254** 条带行号引用）；`--self-test` 16 个样例全过。

### 9.2 全量门禁普查（第二次）：43 个脚本，42 绿 / 1 非零

第四轮改动后复跑（明细 `dist/_gate-sweep2.json`）：**42 exit 0 / 1 exit 1**，与第三轮读数**一致**
⇒ 无回归。唯一非零仍是 `check-model-roundtrip.mjs`（缺 koffi 的环境依赖，`--no-prompt` exit 0）。

### 9.3 门禁再扩：19 处注入 / 140 条断言 / 138 个自检用例（§8.1 的"仍未纳入 6 处"已清零）

`tools/check-core-openharmony-patches.mjs`：1084 → **1535 行**；`RESULT: 140 passed, 0 failed`
（**19 处注入**）；`--self-test` **138 个用例 PASS**；缺树仍 **exit 3**（实测：改名 ⇒ 门禁与自检都 3，
改回 ⇒ exit 0）。

新增 6 个打包步骤，**判据形态按代码实情分别处理**（这是本轮最值得记的一点 —— 不是所有产物都能"逐字节断言"）：

| 步骤（`tools/pack-core.mjs`） | 目标 | 判据形态 |
|---|---|---|
| `allowOriginList()` :1532 | `DSHM_ORIGIN_LIST` | **替换式**，有逐字上游原文 ⇒ 正向标记 + 反向上游原文消失 |
| `wrapSharp()` :1603 | `0.0.0-dshm-dispatch` | 替换式 + `renameSync` ⇒ 另断言"真件 `lib/` **不得存在**"（路径不得存在型） |
| `addSystemAddonPackage()` :1753 | `0.1.2-dshm-shim` | **新造包、没有上游原文** ⇒ 只能断言产物存在 + 完整性（如实说明，不编造反向判据） |
| `addOnDevicePreset()` :1065 | 端侧 preset | **当前布局下它一个字节都不复制**（产物 = 官方 shipping 集）⇒ 按代码为准**不设内容判据**，只记这一事实 |
| `addPlatformAliases()` :1487 | `@ohos-ports` 平台别名 | 整目录复制 ⇒ 反向 = 别名目录与**树内**源目录逐字节一致（源也在树内 ⇒"真副本"型） |
| `embedTreeInfo()` / `verifyTreeInfoContract()` :2689/:2728 | 树根 `dshm-core.json` | **真生成物**（`builtAt` 是打包时刻的 ISO 时间戳）⇒ **只做形状断言**：存在 + JSON 可解析 + 字段名/类型 + 来自配方与代码常量的**确定值**（`coreVersion`/`platform`/`profile`/`overrides`）+ 内部一致 |

⇒ §8.1 结尾列的"仍未纳入的 6 处"**全部清零**：端侧注入补丁门禁现在覆盖**全部**已知注入点。
