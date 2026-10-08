# 109 · 沙箱复测（第二轮）的两个 P1 缺口 · `move`/`publish` 的裸 EPERM 与 `read`/`remove`/`edit` 的权限判据

> 2026-10-06（开发端；输入是用户提供的**仓库外**复测报告 `dshm-sandbox-retest.md`（120 行）。
> 报告侧的复测环境：HarmonyOS PC · 宿主 pid 33102 · 核心 `0.2.1-alpha.1+dshm.8` · app 21:21 部署）。
> 用户原话：**「真机端复测返回报告，先搞定这个，向下兼容API的暂时不管」**。
> **追加输入（同日到达，用户原话「真机端测试的结果，结合着一起看」）**：R3 复测报告
> `dshm-sandbox-retest-r3.md` —— 同一台 PC、**同一份 `+dshm.9` 构建**的真机复测，
> 结论 **「本轮复测通过」**（逐条读数见 §5.2）。它只留了一条"建议单测"的待办
> （`read`/`edit` 的拒绝分支设备侧不可达）—— 那条**本轮已由 §4.4 的新门禁落实**。
> 一句话结论：报告里 **3 项 ✅ 保留**、**2 项 ❌ 已修**（`move`/`publish` 的裸 EPERM；
> `read`/`remove`/`edit` 在 `stat` 被拒时的「无权限 vs 不存在」），**P1 第 3 条（方案 A 产品闭环）核实为已在位**，
> **P2 两项只登记不改**。报告 §2.1 的**前提**（「`stat` 允许、只有 `readdir`/`open` 被拒」）在代码层面**不成立**（§1），
> 但这不改变缺陷本身成立 —— 它只改变缺陷的**触发条件**从"已复现"变成"更严的设备上必然复现"。
> **R3 真机复测（同一份 `+dshm.9`）已判「本轮复测通过」**（§5.2）。
> **追加输入（同日 22:1x 到达，用户原话「真机端测试报告」）**：R4 复测报告
> `dshm-sandbox-retest-r4.md` —— 结论是 **「设备上未检测到本轮的新部署」**。
> 该结论**属实且正确**，但根因**不是推包失败**，而是**本轮没有产品代码改动、也没有新构建**
> （§5.3 有时间戳核对）；R4 §2 与 R3 逐项一致正是**预期结果**（同一份构建、同一个宿主进程）。
> 它真正暴露的是**"缺一条机械判据"** ⇒ 本轮补了 `tools/device-code-fingerprint.ps1`（§5.3）。

---

## 0 输入与裁定

| 报告条目 | 复测读数 | 判定 | 本轮处置 | 落点 |
|---|---|---|---|---|
| `glob` / `grep` 静默伪装成"没有内容" | 已出「读不到搜索目录」人话 | ✅ 已修（`docs/108`） | 不动，回归见 §4 | `assert-fs-search-fallback` |
| `write` 落盘裸 errno | 已出「平台策略拒绝」人话 | ✅ 已修（`docs/108`） | **文案逐字不动**，把它抽成共享模块（§2.1） | `denial-hints.js` |
| `ohos-workspace` 技能两张清单 | 21:21 已更新 | ✅ 已修（`docs/108`） | 不动 | `resfile/ohos-skills/` |
| **`move` 裸 EPERM** | `EPERM … rename '…/harness/…' -> '…/Documents/…'` | ❌ 仍缺 → **R3 ✅ 通过** | **修**（§2） | `dshm-tool-fs-remove:541` |
| **`publish` 裸 EPERM** | `EPERM … open '…/Documents/.dshm-probe.md.<pid>.<uuid>.partial'` | ❌ 仍缺 → **R3 ✅ 通过** | **修**（§2） | `dshm-tool-fs-remove:324` |
| `read` / `remove` / `edit` 的 `not found` | 报 `not found` | ⚠️ 待验证 → **R3：设备侧不可达** | **修**：`stat` 被拒（非 ENOENT）改报「无权限」（§1、§3） | `pack-core.mjs` 的 `patchFsLocalPermissionHint()` |
| **R3 唯一待办**：`read`/`edit` 拒绝分支设备侧不可达 → "建议单测" | 4 条 `stat` 读数（受限目录里也报 ENOENT） | **落实** | 新增**真行为 + 注入式负控制**门禁（§4.4） | `tools/check-fs-local-permission.mjs` |
| P1 第 3 条：方案 A 的产品闭环（选受限目录当场提示并回退） | — | ✅ **已在位** | **核实并记录**（§6），不改 | `FilePicker.ets:198-227` + `Index.ets:2666-2688` |
| P2：方案 B（三条目录权限） | — | 登记 | 用户上轮已裁定**走 A**，本轮不动（`docs/108` §2） | — |
| P2：会话写锁清理（21 个且持续增长） | `写锁巡检：发现 21 个` | 登记 | **本轮不做**（§7.2） | — |
| 报告 §5：探针在 `HO_DATA_EXT_MISC` 留下 4 个删不掉的残留 | 用户设备上的既成事实 | 如实记录 | **不洗白、也不再去写它**（§7.3） | — |

> **「向下兼容 API 的暂时不管」**：`docs/108` 的 API 23 结论与 `tools/build-profile.template.json5` 的
> `compatibleSdkVersion: 6.1.0(23)` **本轮一律不动**，本文件与它无关。

---

## 1 先把报告 §2.1 的前提拆开：`stat` 与 `read` 是**两条路径**

报告 §2.1 的结论是「平台策略的粒度是：路径解析（`stat`）允许，目录 `readdir`/`open` 禁止」，
并据此说 `read`/`remove`/`edit` 的 `not found` 是**正确**的、只是"缺一个样本来验证 deny 分支"。
代码层面这两句要分开看 —— **结论对，理由是错的**。

### 1.1 上游代码事实（`dsh-fs-local/lib/index.js`，树内行号）

| 位置 | 上游行为 |
|---|---|
| `statRegularFile()` `:359-378` | `try { info = await stat(target.targetKey) }`；catch 里**只认 ENOENT**：`if (!isENOENT(error)) throw error;` ⇒ **其余 errno 裸着上抛** |
| `readFileAbortable()` `:140-153` | `try { return await readFile(…) }`；catch 里**只认 abort**：`if (!isAbortError(error)) throw error;` |
| `readWholeText()` | 先 `statRegularFile()`、再 `readFileAbortable()`（`:388` 那个调用点） |
| `readForEdit()` | 同上（`:667` 那个调用点） |
| `readBytes()` / `readByteRange()` | **不走 `stat`**：直接 `createReadStream`（⇒ 只有 `open` 那一步会拒） |
| `listingIoError()` `:273-280` | `listDir` 早就把权限错翻成 `FS_PERMISSION_DENIED`（`:279`），**文案形态** `cannot list "<path>": permission denied` |

⇒ 三点推论：

1. **`read`/`edit` 走的文本路径，第一道门就是 `stat`** —— 不是报告说的"`stat` 允许、`open` 才拒"。
2. 报告观察到的 `stat …/Documents → OK` 只说明该设备对 **Documents 目录本体**的 `stat` 放行；
   **文件级**的 `stat` 是否放行，报告没有覆盖（它用的是"不存在的文件"，本来就是 ENOENT）。
3. ⇒ 报告看到的 `not found` 是**真的不存在**（`ENOENT`），那句报错**在当时是对的**；
   但**只要换一台连 `stat` 都拒的设备，同一句 `not found` 就是假的** —— 缺陷成立。

### 1.2 可复现的样本（本机 Windows，PC 档 = 宿主走 `node:fs` 直打真文件系统）

要在**不换设备**的前提下拿到 `stat` 被拒的样本，用 Windows 自己的受保护文件（实测矩阵）：

| 样本 | `stat` | `read`（`readFile`） | 说明 |
|---|---|---|---|
| `C:\Windows\System32\config\SAM` | **EPERM** | **EPERM** | **完美样本**：`stat` 与 `read` 都拒 |
| `C:\Windows\System32\config\BBI` | **EPERM** | **EPERM** | 同上 |
| `C:\Windows\System32\config\SYSTEM` | **EPERM** | **EPERM** | 同上 |
| `C:\pagefile.sys` | **EPERM** | EBUSY | 只覆盖 `stat` 分支 |
| `C:\System Volume Information` | OK | **EPERM** | 只覆盖 `read` 分支（`docs/108` 的 PB 级已覆盖） |
| `C:\$Recycle.Bin` | OK | EISDIR | 反向对照（非权限错，必须原样） |

⇒ §3 的注入在真机上的期望读数：`read` 这些路径应报
`cannot read "C:\Windows\System32\config\SAM": permission denied`（`FS_PERMISSION_DENIED`），
而**不再是** `EPERM: operation not permitted, stat '…'`。

R3 报告 §4 从**设备侧**独立复现了 §1.1 的代码事实，而且读得更细 ——
**受限目录里的路径 `stat` 也返回 `ENOENT`**：

```
stat  …/Documents/some-file.txt      → FileNotFoundError errno=2   （真的不存在）
stat  …/Documents                    → OK                          （能 stat）
stat  /storage/nope.txt              → FileNotFoundError errno=2   （父目录受限也不报 EACCES）
stat  /storage/Users/nope.txt        → FileNotFoundError errno=2
```

⇒ 在那台设备上**构造不出**「文件存在、`stat` 被拒」的样本（受保护目录里根本写不进文件），
这条分支**设备侧不可达**。所以它的判据不能靠复测，只能靠**跑真代码的门禁**钉住（§4.4）。

---

## 2 缺口 1：`move` / `publish` 的裸 EPERM ⇒ 共享 `denial-hints.js`

`write` 在 `docs/108` 里已把裸 errno 翻成人话，但那段译码器当时**只落在 `write` 自己那一步**。
本轮把它抽成一个模块，并把**另外三个**会写盘的步骤接上。

### 2.1 为什么是「共享模块 + 两份**逐字节**副本」

用它的两个包是**各自独立分发**的自带插件（`tools/pack-core.mjs` 的 `embedDshmToolPackages()`
逐个目录拷进核心树，两者之间没有可共享的包）：

| 文件 | 归属 | 谁在用 |
|---|---|---|
| `hostcore/plugins/dshm-fs-write-nonchmod/lib/denial-hints.js` | `write` / `edit` 的**落盘**那一步 | `fsio-nochmod.js:394` |
| `hostcore/plugins/dshm-tool-fs-remove/lib/denial-hints.js` | `publish` 的**落盘**、`move` 的**改名**、`remove` 的**删除**、三个工具解析路径时的 `lstat` | `lib/index.js` 的 7 处 |

在本仓的结构里让两者 `import` 同一个 npm 包做不到，所以做法是**同一份文件逐字节复制两份**，
并由 `tools/check-denial-hints.mjs` 钉住三件事：**两份必须逐字节一致**、**三档命中与放行的行为正确**、
**三个工具的调用点真的接上了**（§4）。

两份当前均为 **3994 B**，sha256 `DE3B64CD881F02A3F24088849B23DD32A5F8DEE206B74968651D4C63F9EC8EAD`。

### 2.2 模块契约（三条硬约定）

1. **只改写 `error.message`**，`code` / `errno` / `stack` **原样留下** —— 调用方（以及 UI）是按 `error.code`
   分派的，换成新错误 / 新 code 会改变分派行为，属于超出本缺陷范围的改动。原始报错附在文案末尾备查。
2. **按字符串 `code` 判，不按数字 `errno`**：node 在 Linux / 鸿蒙上把 errno 记成**负数**
   （EPERM → `-1`、EACCES → `-13`、EROFS → `-30`），按数字判会随平台 / 版本漂移；
   报告里写的 `EPERM(1)` 是**正**的 C errno，与 node 暴露的字段同名不同号（`docs/108` 已记过这条误读）。
3. **非 Error、非三档命中一律原样返回**（语义不变）—— 放行的反向臂见 §4 B 组。

### 2.3 三档文案与 `label` 口径

| `code` | 前缀 |
|---|---|
| EPERM | `目录受系统保护、当前没有读写授权（EPERM）` |
| EACCES | `当前身份无权访问该目录（EACCES）` |
| EROFS | `该位置是只读文件系统（EROFS）` |

完整文案（`label` 默认 `"目标文件"` 时与 `write` 的既有文案**逐字一致**）：

```
<前缀>：<dirname(abs)>（<label> <basename(abs)>）。这是平台策略拒绝，重试无效；请改写到有权限的位置
（如本应用认领的 Download/<包名>/ 或沙箱），并如实告诉用户。原始报错：<原 message>
```

`label` 的两种取值不是随手定的：**`move` 的报错点就是"目的地那个文件"**（`rename` 的目标），
所以沿用 `write` 的 `"目标文件"`；而 `remove` / `publish` 的 `lstat` 报的是**操作数路径**，用 `"路径"`。

### 2.4 接线点（共 8 处，`hostcore/plugins/dshm-tool-fs-remove/lib/index.js`）

| 行 | 位置 | 说明 |
|---|---|---|
| `:109` | `import { describeWriteFailure } from "./denial-hints.js";` | 模块引入 |
| `:151-158` | `resolveTarget()` 的 `ctx.fs.lstat` | **策略更严的设备会连 `stat` 都不放行** ⇒ `remove` / `move` / `publish` 共用的解析步骤先出人话（`"路径"`） |
| `:386` | publish 的**源** `stat` 非 ENOENT | 源被拒（`"路径"`） |
| `:399` | publish 的**目标** `stat` 非 ENOENT | 目标被拒（`"路径"`） |
| `:406-411` | publish 的 `readFile`（源读不出来） | PB 级（`"路径"`） |
| `:324` | publish **落盘** catch | 报告里那条 `.partial` 裸 EPERM 的落点（默认 `"目标文件"`） |
| `:484` | remove 的 `rm` | 删除被拒（`"路径"`） |
| `:541` | move 的 `rename` | 报告里那条 `rename … -> …` 裸 EPERM 的落点（默认 `"目标文件"`） |

两个 `package.json` 的 `files` 都已加 `lib/denial-hints.js`（否则打包时那份副本不会跟着走）。

### 2.5 `write` 的文案逐字不变（回归守卫）

`fsio-nochmod.js` 由"本地副本"改为 `import` 该模块，`:394` 那一行**逐字未变**
（`describeWriteFailure(error, absolutePath)` 走默认 `label`）。这一点由门禁的 C 组用**同一对象**
比对三家文案（`write` / `move` / `publish`）钉住 —— 抽模块不许顺手改文案。

---

## 3 缺口 2：`read` / `remove` / `edit` 在 `stat` 被拒时 ⇒ 核心树补丁

`dsh-fs-local` 是**上游核心树**里的包，改动落在 `tools/pack-core.mjs` 的
`patchFsLocalPermissionHint()`（`:2433` 起，调用点 `:3267`，紧邻既有的 `patchFsLocalLink()`）。

### 3.1 四处注入

| # | 站点 | 注入后 |
|---|---|---|
| 1 | `statRegularFile()` 的 catch | `if (isPermissionError(error)) throw new FsError(\`cannot ${verb} "${target.displayPath}": permission denied\`, "FS_PERMISSION_DENIED", { cause: error });` 加在 `if (!isENOENT(error))` **之前** |
| 2 | `readFileAbortable()` | 函数多收第 4 参 `displayPath`；catch 里**权限优先于 abort**：`if (isPermissionError(error)) throw …FS_PERMISSION_DENIED…` |
| 3 | `readWholeText()` 的调用点 | 补 `target.displayPath` |
| 4 | `readForEdit()` 的调用点 | 补 `displayPath` |

**等价改写**（这是本补丁唯一需要论证的地方）：它用的是上游**已有**的 `FS_PERMISSION_DENIED`
与 `isPermissionError()`（`:123`，判 EACCES / EPERM），文案与同一棵树里 `listingIoError()`（`:279`）
的 `cannot list "…": permission denied` **同一口径**；ENOENT（`FS_NOT_FOUND`）与 abort（`FS_ABORTED`）
两条分支**逐字不动**。

### 3.2 幂等与防呆

逐站点判断：**上游片段还在就替换**；**片段不在而注入形态在 = 已打过（跳过）**；
**两者都不在 = `die()`**。末尾再核对标记 `DSHM_FS_LOCAL_PERMISSION_HINT` 总数必须**恰好 4 处** ——
上游改结构必须当场暴露在**打包期**，而不是静默失效成"真机又是裸 EPERM"（那种回归只能靠用户复现）。
注入文本一律用**单引号串拼**（不用模板串）：里面既有反向引号又有 `${…}`，模板串会在 `pack-core` 里被就地求值。

---

## 4 门禁

### 4.1 新增 `tools/check-denial-hints.mjs`（**45 断言**，离线，已进 CI）

| 组 | 管什么 |
|---|---|
| A | 两份 `denial-hints.js` **逐字节一致**（sha256 相同） |
| B | 三档命中：**同一对象**（不是新错误）、**逐字文案**、`code`/`errno` 未被改写、原始报错附尾；**反向**：ENOENT / EXDEV 原样、非 Error 原样；自定义 `label` |
| C | **真行为**：在临时舞台里只桩 `@deepseek-ai/dsh-tools` 与 `dsh-fs`，**真 import** 插件、用假 ctx 注册三个工具，让 `ctx.fs.lstat` 抛各档错误 ⇒ 断言 `remove`/`move`/`publish` 的解析步骤真的翻成人话（正向）+ ENOENT / 非 Error 原样（反向） |
| D | 源码级接线：publish 落盘 catch / move 的 `rename` / remove 的 `rm` / 解析的 `lstat` / `import`；**反向**断言旧的裸 `: error;`、裸 `await rename(…)`、裸 `await rm(…)` **必须消失** |
| D2 | `pack-core.mjs` 里 `patchFsLocalPermissionHint` 的**定义 / 调用 / 标记 / 待替换片段 / 权限判据**五条 |

### 4.2 核心树门禁扩容：19 处 → **21 处** 注入

`tools/check-core-openharmony-patches.mjs` 新增 ⑩b「fs-local 权限文案」组（插在 ⑩ 之后）：
标记 ×4 的正判据、4 条正向、**4 条逐字反向**（`stat` 的旧 v8 注 / 三参函数头 / 两个三参调用点）。
头部标题与末尾 `RESULT:` 行同步改 `21 处`。读数：**160 passed / 0 failed**；`--self-test` **152 用例全过**。

### 4.3 全套（本轮读数）

**25/25 绿**（含需要核心树的 `check-fs-local-permission`，见 §4.4）：`assert-cli-shim`(40) · `assert-resfile-sync` · `check-parity` · `compat-drift` ·
`assert-exec-fix`(38) · `assert-python-bridge`(69) · `assert-fs-search-fallback`(73) ·
`check-web-fetch-jitless` · `check-worker-jitless` · `check-internal-undici` · `check-skill-sync.cjs`(32) ·
`check-ptc-ts-strip`(81) · `check-ptc-runtime-inproc` · `check-ptc-wiring` · `check-core-openharmony-patches`(160) ·
`check-decor-button-mode` · `check-market-bridge`(44) · `check-denial-hints`(45) · `check-plugin-toggle` ·
`check-native-closure` · `check-origin-fence` · `check-sidebar-tab-id-guard`(9) · `check-dead-code` · `check-doc-refs` ·
`check-fs-local-permission`（正跑 PASS + `--self-test` 5/5）。

### 4.4 新增 `tools/check-fs-local-permission.mjs`（**真行为 + 注入式负控制**，需要核心树）

§4.2 那条只证明"**文本还在**"，§1.2/§5.2 又证明这条分支**设备侧不可达** ⇒ 必须有一条**真跑代码**的门禁：

| 组 | 管什么 |
|---|---|
| 静态 5 条 | 标记恰好 4 处；**权限分支在 ENOENT 分支之前**（顺序即行为 —— 写反了 `not found` 会被吞成权限）；`readFileAbortable` 收下第 4 参；两个调用点都带 `displayPath`；复用上游已有的 `isPermissionError()` / `FS_PERMISSION_DENIED` |
| 固定臂（真跑） | 用 `module.registerHooks()` **只把 `node:fs/promises` 换成垫片**（标记路径按表抛 `EPERM`/`EACCES`/`EBUSY`，其余一律转真实现），import 的仍是**树里那份真代码**（同一文件、同一条依赖解析路径，不复制、不改写）⇒ 8 组行为断言（含 4 条对照臂） |
| 负控制臂（**每次运行都跑**） | 用 `load` 钩子把两处 `if (isPermissionError(error)) throw …` **就地删掉**（URL 不变、只改内存）⇒ 同样的调用必须退回**裸 EPERM**；若仍报 `FS_PERMISSION_DENIED`，说明门禁没有判别力 |

固定臂真实读数（核心树 `+dshm.9`，路径已归一化成 `<DIR>`）：

```
readStatEperm    FsError  FS_PERMISSION_DENIED  cannot read "<DIR>/denied.txt": permission denied   cause=EPERM
readStatEacces   FsError  FS_PERMISSION_DENIED  cannot read "<DIR>/denied-eacces.txt": permission denied  cause=EACCES
editReadDenied   FsError  FS_PERMISSION_DENIED  cannot edit "<DIR>/edit-denied.txt": permission denied   cause=EPERM
readMissing      FsError  FS_NOT_FOUND          cannot read "<DIR>/missing.txt": not found     ← 回归：不许吞成权限
readStatOther    Error    EBUSY                 stat EBUSY: <DIR>/denied-busy.txt             ← 非权限错原样上抛
readAborted      FsError  FS_ABORTED            read aborted                                   ← 权限分支不许吞 abort
readHealthy      resolved hello-dshm             ← 对照臂：垫片对正常路径透明
editHealthy      与权限无关（宿主机 x64 加载不了树里 arm64 的 koffi 原生绑定）                  ← 差分对照
```

负控制臂：`{"case":"neuter","removedLines":2}` 后 `readStatEperm` / `editReadDenied` 双双变回
`Error EPERM`（裸错），而 `readMissing` 仍是 `FS_NOT_FOUND` —— **只动了权限分支**这一点也被钉住。

`--self-test` **5/5**（含"删了分支却仍报 FS_PERMISSION_DENIED ⇒ 判无判别力"那条）。

> **分工**：`check-denial-hints.mjs` 钉**插件侧**（`write`/`move`/`publish`/`remove`，离线、进 CI）；
> `check-fs-local-permission.mjs` 钉**核心树侧**（`read`/`edit` 的 `stat`/`open` 被拒；干净克隆里没有树 ⇒ 它属于"需要核心树"那一档，**不进 CI**，与 `compat-drift` 等同类）。
> 覆盖边界：`readBytes` / `readByteRange` **不走 `stat`**（直接 `createReadStream`），本补丁**不覆盖**它们 —— 门禁头注释里写明了这一条，别把它当绿。

---

## 5 出包与装机

- **`coreVersion` `+dshm.8` → `+dshm.9`**（`hostcore/core-recipe.json`）：核心树内容变了就必须递增
  （`AGENTS.md` 第 2 条坑），否则端侧不换树。
- `node tools/pack-core.mjs --place-in-app`：树 `dist/core/work/dsh-core-0.2.1-alpha.1+dshm.9` **全新物化**
  （没有复用旧树 ⇒ 复用会静默跳过补丁的坑不适用）；日志确认
  `fs-local 权限文案补丁：stat/open 的裸 errno ⇒ FS_PERMISSION_DENIED（4 处）`。
  容器 `dist/core/dsh-core-0.2.1-alpha.1+dshm.9-openharmony-arm64.zip` **85,143,510 B（81.2 MiB）**，
  sha256 `623ee9e9d6514ac4c22a087d8e1c83625d91b41ae8ad0acd973df4b300d55313`
  （与 `entry/src/main/resources/resfile/` 里那份**逐字节一致**，`check-resfile-core-zip.mjs` ✅）。
- `tools/update-device.ps1`（PC `86E0226429000417`）：构建成功 → HAP **321,421,373 B（306.5 MiB）** →
  `hdc install -r` 覆盖安装成功 → 冷启动第 10 秒起来 →
  **home 指纹 `links=13 size=3440 → links=13 size=3440`（用户数据完好）** →
  设备核心树 `0.2.1-alpha.1+dshm.9` 在 → exec 探测 **10/10**（`python3.12`/`git`/`rg`/`ash`/`bash`/`system-sh`/`toybox` …）。

### 5.1 设备侧三方逐字节一致（本轮新增的取证）

harness 的 `home` 是 0700（shell 读不到），所以用**应用自身的 Python 桥**取回读数
（token 从可读的 `$filesDir/dshm-host.log` 取，`hdc fport tcp:3120 tcp:3120` 转发）：

| 文件 | 源码（仓库） | 本地核心树 | **设备核心树** |
|---|---|---|---|
| `dshm-fs-write-nonchmod/lib/denial-hints.js` | 3994 B / `de3b64cd…` | 同 | **同** |
| `dshm-tool-fs-remove/lib/denial-hints.js` | 3994 B / `de3b64cd…` | 同 | **同** |
| `dshm-tool-fs-remove/lib/index.js` | 33324 B / `6025d081…` | 同 | **同** |
| `dshm-fs-write-nonchmod/lib/fsio-nochmod.js` | 19542 B / `afeb48a8…` | 同 | **同** |
| `dsh-fs-local/lib/index.js`（被注入的那份） | — | 43852 B / `292d6824…` | **同** |

设备树 `…/dsh/cores/0.2.1-alpha.1+dshm.9/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js` 里
`DSHM_FS_LOCAL_PERMISSION_HINT` **恰好 4 处**、`FS_PERMISSION_DENIED` **4 处**、`isPermissionError` **4 处**
（同树另有两个上游文件各带 1 处 `FS_PERMISSION_DENIED`，那是上游原文）。

> **验证方式的边界（如实写清）**：本轮**没有**做端到端"模型会话里真的调一次 `read`"的复测 ——
> 那需要跑一次真实模型会话（耗用户额度、且结果不确定）。因此"用户看到的文案逐字正确"这条证据链是：
> **门禁 C 组用真 import 跑真行为** + **设备侧文件与本地逐字节一致**（上表）+ **核心树标记计数在设备上核对**。
> 端到端那一格留给用户复测；若复测仍出现裸 EPERM，第一件事是核对设备树里那份文件的 sha256 是否等于上表。

---

### 5.2 R3 真机复测（2026-10-06 21:52–21:58，**同一份 `+dshm.9` 构建**）

复测方在同一台 PC、同一份构建上重跑，结论 **「本轮复测通过」**。逐条读数（原文引用）：

| 项 | 读数 |
|---|---|
| `glob` / `grep` | `目录被系统拒绝访问（Permission denied）—— 这是『读不到』，不是『没有内容』` ✅ |
| `write` | `目录受系统保护、当前没有读写授权（EPERM）… 原始报错：EPERM: … open '….partial'` ✅ |
| **`move`** | 同款文案，`原始报错：EPERM: … rename '…harness/…' -> '…Documents/…'` ✅ **本轮新增** |
| **`publish`** | 同款文案，`原始报错：EPERM: … open '….partial'` ✅ **本轮新增** |
| **`remove`** | 用 `HO_DATA_EXT_MISC` 的稳定拒绝样本验到 **EACCES 档**：`当前身份无权访问该目录（EACCES）…（路径 .dshm_wtest_tmp）… 原始报错：EACCES: …`；不带 `recursive` 时仍是"需 recursive=true"的原有提示 ✅ **本轮新增** |
| 对照回归 | `Download/com.dshm.dshclient` 与 `harness` 的 **写→读→删** 全通过 ✅ |
| 权限矩阵 | `Documents`/`Desktop`/`Download` 与 `.Trash`/`.Recent`/`appdata` 仍 `EPERM`（**与方案 A 一致，无变化**） |
| 其它 | skills「本次复制 0 个；内容未变 5 个」；`写锁巡检：发现 21 个`（与上轮持平，见 §7.2） |

它同时**独立确认**了我们这边的两条认定：① `read`/`edit` 的拒绝分支设备侧不可达（§1.2）；
② `HO_DATA_EXT_MISC` 的 4 个残留仍在、且**再次尝试删除（`unlink`/`rm`/`busybox rm`/`rmdir`/`remove(recursive)`）全部被平台拒绝**（§7.3）。

### 5.3 R4 真机复测（2026-10-06 22:06–22:09，**同一台 PC、同一份 `+dshm.9`**）—— 「未检测到新部署」该怎么读

R4（`dshm-sandbox-retest-r4.md`）的结论是 **「设备上未检测到本轮的新部署」**，它给了四条硬证据：

| 证据 | R4 读数 |
|---|---|
| HAP 安装时间 | `/data/storage/el1/bundle/entry` mtime **21:50**（父 `el1/bundle` 21:51） |
| 核心树 | `~/dsh/cores/` 最新仍是 **`+dshm.9`**，无 `+dshm.10` |
| 宿主进程 | **pid 50090**、`startedAt 13:51:01Z`；22:06 仍未重启 |
| 文件改动扫描 | `find -newermt` 以 `2026-10-06 21:52` 为界扫 `cores/`、`profiles/…/node_modules`、`skills/`、app 目录 → **0 个文件** |

**结论属实、四条证据也都对 —— 但根因不是"推包失败"，而是"本轮根本没有新的产品代码与构建"。**
开发端时间戳核对：那份 HAP 的 mtime 是 **21:50:35**，而本轮产品源码/门禁里**最后一次写入是 21:47:40**
（`tools/check-core-openharmony-patches.mjs`；核心容器 zip 21:47:12）——
**HAP 比所有源码改动都新**，所以**本就不需要重新编译安装**；R4 之后才写的是文档
（`docs/109`、`docs/README.md`）与门禁（`tools/check-fs-local-permission.mjs`），它们不参与打包。
⇒ R4 §2 的逐项读数与 R3 **逐字一致**，是**预期**（同一份构建、同一个宿主进程、同一次部署）。

**R4 §3 的 P1（`read`/`edit` 的拒绝分支）不留待办**：R4 自己也把它记成
「本机因 `stat` 返回 `ENOENT` 而**不可达**，建议用单元测试钉住」—— 那正是 §4.4 的
`tools/check-fs-local-permission.mjs`（导入树里那份**真代码** + 每次运行都跑的注入式负控制）。
R3 与 R4 在这条上**同源同判**，都指向"用单测钉住"，而它已落实。
（旁注：R4 §2 里 `read`/`edit` 在 `Documents` 内仍报 `not found`，与 §1.2 的读数**同源**，
不是本轮回归、也不是"文案没生效"：平台对受限目录里的路径连 `stat` 都报 `ENOENT`，
与"文件真的不存在"在**系统调用层面不可区分**；补丁管的是**平台真的报权限错**（`EPERM`/`EACCES`）时
不再说 `not found`。这一条已登记为遗留（§7.4）。）

#### 5.3.1 修 R4 §1 暴露的**真问题**：把"设备在跑哪份代码"变成一次机械核对

R4 §1 那四条证据回答的是"**最近有没有装过东西**"，代价是**每轮都要人工重做**，
而且**判不出"设备跑的就是本机这份代码"** —— 改了没装机、装了别的树、装了一半失败，
四条证据照样显示"未检测到新部署"。

⇒ 本轮补 `tools/device-code-fingerprint.ps1`：把设备核心树里
**5 个决定行为的关键文件**（§5.1 表里那 5 个）与本机树**逐字节比 sha256**。三档结论、三个退出码：

| 档 | 含义 | 退出码 |
|---|---|---|
| **一致** | 设备正在跑的核心树 = 本机这份 | 0 |
| **不一致** | 列出哪个文件不同 + 两侧 sha256 ⇒ 先查装机/出包链路，再复测 | 1 |
| **未验证** | 桥不通 / 超时 / 树缺文件 —— **"读不到"不等于"一致"** | 2 |

三个实现上的坑（都实测过）：

- **走应用自身的 Python 桥**：`home` 是 0700，shell 身份读不到 `cores/`；桥跑在应用进程内、与宿主同 UID，
  读得到。token 从 shell 可读的 `$filesDir/dshm-host.log` 里取。
- **端口不许从日志里 grep**：那份日志里混着 `ACCEPT #n 127.0.0.1:<临时端口>`（客户端源端口，`hdc` 转发会保留），
  `tail -1` 会抓到一个**没人监听**的号 —— 2026-10-06 实测抓到 **45700**，于是桥请求直接失败、
  报告被打成"未验证"（真端口是 **3120**）。改为读**仓库常量**
  `entry/src/main/ets/runtime/RuntimePort.ets` 的 `HOST_DEFAULT_PORT`（与运行时同源：`NodeRuntime.ets:175`
  取它传给 `buildHostEnv`），并且**候选端口逐个试、只有真的答出桥的 JSON 才算数**；失败时**撤掉自己建的转发**。
- **失败必须重试**：`hdc` 的转发偶发在**客户端侧立刻**报 `基础连接已经关闭: 接收时发生错误`，而设备侧其实**已经应答**
  （日志里有 `IN-REQ` / `IN-DONE … status=`）—— 2026-10-06 实测同一设备、同一 token，**下一拍就成功**。
  一次失败就下"未验证"，等于把**偶发**说成**事实** ⇒ 每个候选端口内**最多试 3 次**（间隔 500 ms），全失败才换下一个。

**三档都实测过**（PC `86E0226429000417`，本机树 `dist/core/work/dsh-core-0.2.1-alpha.1+dshm.9`）：

| 臂 | 做法 | 读数 |
|---|---|---|
| 一致 | 直接跑 | `ok ×5` · `结论：一致（5/5）` · **rc=0** |
| **不一致（负控制）** | 5 个文件拷到别处、把 `dsh-fs-local/lib/index.js` 改 **1 字节**，`-LocalTree` 指过去 | `FAIL dsh-fs-local/lib/index.js`（设备 `292d6824…` / 本机 `7202fcaa…`）· `结论：不一致（1 个文件不同）` · **rc=1** |
| **未验证** | `-Token wrongtoken` | `端口 3120 不应答 … ⇒ 未验证` · **rc=2** |

> 负控制跑了**两臂**：改 `dsh-fs-local/lib/index.js` 与改 `dshm-tool-fs-remove/lib/denial-hints.js` 各一次，
> 两次都被点名 ⇒ **5 个文件里任意一个被改都判得出**（不是只盯着清单里的第一个）。
> 负控制那一臂顺带**再次印证 §5.1**：它打印的**设备侧** sha256 正是原文件的 `292d6824…`
> （被改的是拷出来的那份），说明设备树上那份**一个字节没动**。
> 工具**只读**（不安装、不卸载、不改设备上任何文件），只做幂等的 `hdc fport`（失败撤掉）。
> 它**需要设备 ⇒ 不进 CI**，与 `device-acceptance.ps1` 同级。

⇒ 至此：**R1 报告的 2 个 P1 缺口已被真机复测判为通过**，剩下的是"设备侧不可达那一条"由 §4.4 的门禁兜住。

---

## 6 P1 第 3 条：方案 A 的产品闭环核实 —— **已在位**

报告说这条"其实已在位"，本轮**核实并留下行号**（不改）：

- `platform/src/main/ets/system/FilePicker.ets:198-227`：手持档接受两类路径（① 本应用按包名归属的
  `Download/<包名>/`；② 用户目录 + **本次授权已确认生效**），两类都不满足才回落；回落时返回
  `PICKED + 非空 reason`，文案写明**为什么被换掉**（`:215-220` 手持档一条、非手持"Host 只能读、不能写入/删除"一条）。
- `entry/src/main/ets/pages/Index.ets:2666-2688`：`picked.reason` 非空时**交给已有的选择器浮层**呈现
  （壳里没有 toast 通道），失败时才回退到沙箱浏览。

⇒ 「用户能看到原因 + 工作区回退」这条**不需要新代码**，本轮只补了它的取证。

---

## 7 未做项与如实记录

### 7.1 P2：方案 B（三条目录权限）
登记不动。用户已裁定走 A（`docs/108` §2）；B 的前置条件（`DOWNLOAD`/`DOCUMENTS` 是 `user_grant`+normal、
`DESKTOP` 是 `user_grant`+**system_basic**，且要过签名 profile 的 `allowed-acls`）一并留档，将来真要做时按那节走。

### 7.2 P2：会话写锁（`写锁巡检：发现 21 个`）
**本轮不做**。它是**历史会话**留下的锁文件随会话数缓慢累积，不是本轮两个 P1 的一部分；
"启动巡检能清掉失效锁"这个判据需要先定义"失效"（进程没了？会话还在但不活跃？），
在没有真机复现路径之前动手，风险是清掉**正在用**的锁。登记在此，等用户决定优先级。

### 7.3 报告 §5：`HO_DATA_EXT_MISC` 的 4 个残留 —— 如实记录，不去动它
报告方在复测中对该目录做了写入类探测，而该目录**允许创建、拒绝删除**，因此留下 4 个无法删除的条目
（`.dshm_wtest_tmp` / `.dshm_rt4_tmp` 已截断为 0 字节、`.dshm_dtest_tmp/` / `.dshm_rt4_dir/` 空目录）。
**这是用户设备上的既成事实**：本文件不把它写成"清理干净"，也**不**去尝试再删（删除在平台侧就是被拒的，
再试只会多一次权限拒绝读数）。后续复测不再对 `HO_DATA_EXT_MISC` 做写入类探测。

### 7.4 遗留（R4 可见面）：平台把"没权限"报成 `ENOENT` ⇒ `read`/`edit` 仍说 `not found`
**本轮不改，但登记清楚**。设备上对受保护目录里的路径，`stat` 返回的是 `ENOENT`（R3 §4、R4 §2 都读到），
而 `ENOENT` 与"文件真的不存在"在系统调用层面**不可区分** ⇒ 任何"看到 ENOENT 就改口说无权限"的写法
都会在文件**确实不存在**时说谎（反例就在 §4.4 的 `readMissing` 对照臂）。
将来若要改，正确的做法**不是**猜，而是加一条**独立探测**（例如：文件不在 ⇒ 看它所在目录能否 `readdir`／
能否 `stat` —— 目录也被拒才判"无权限"），并且必须配正反两臂门禁（"目录被拒 + 文件不在" ⇒ 无权限；
"目录可读 + 文件不在" ⇒ 仍然是 `not found`）。在拿到这两个样本之前不动。

---

## 8 一句话结论

报告的两个 P1 缺口本轮**都已修**：`move`/`publish` 与 `write` 共用同一套「被拒 ⇒ 人话」译码器（两份逐字节副本、
45 条门禁），`read`/`remove`/`edit` 的 `stat` 被拒不再报成 `not found`（4 处核心树注入、21 处注入门禁 160 断言）；
`coreVersion` 升 `+dshm.9`、已覆盖安装到 PC 真机、**用户数据完好**、**设备侧三方逐字节一致**；
P1 第 3 条核实为已在位，P2 两项与报告 §5 的残留如实登记。

**R3 真机复测（同一份 `+dshm.9`）结论为「本轮复测通过」**：`write`/`move`/`publish`/`remove` 四个工具的
EPERM/EACCES 映射都被现场读到，外加 `glob`/`grep`，成功路径的三组 写→读→删 无回归；
唯一设备侧不可达的分支（`read`/`edit` 的 `stat` 被拒）已由**跑真代码 + 注入式负控制**的门禁
`check-fs-local-permission` 覆盖（§4.4），不再依赖复测。

**R4 真机复测（同为 `+dshm.9`）的「未检测到新部署」是事实，但不是缺陷**（§5.3）：本轮**没有产品代码改动、
也没有新构建**（HAP 21:50:35 晚于所有源码改动 21:47:40），本就不需要重新编译安装，故 R4 与 R3 逐项一致是**预期**。
它真正暴露的是"缺一条机械判据"（人工四条证据只在回答"最近有没有装过东西"，答不了"设备跑的是不是本机这份"）
⇒ 已补 `tools/device-code-fingerprint.ps1`：三档（一致 / 不一致 / 未验证）、三个退出码（0/1/2），
**三档都实测过**（本机树 5/5 一致 rc=0；负控制改 1 字节 ⇒ 不一致 rc=1；错 token ⇒ 未验证 rc=2）。

### 本轮动的文件

| 文件 | 性质 |
|---|---|
| `hostcore/plugins/dshm-fs-write-nonchmod/lib/denial-hints.js` | **新增**（共享译码器，副本 1） |
| `hostcore/plugins/dshm-tool-fs-remove/lib/denial-hints.js` | **新增**（副本 2，与副本 1 逐字节相同） |
| `hostcore/plugins/dshm-fs-write-nonchmod/lib/fsio-nochmod.js` | 改为 import 该模块（`:394` 文案逐字不变） |
| `hostcore/plugins/dshm-tool-fs-remove/lib/index.js` | 7 处接上译码器（§2.4） |
| 两个 `package.json` | `files` 各加 `lib/denial-hints.js` |
| `tools/pack-core.mjs` | 新增 `patchFsLocalPermissionHint()`（4 处注入，`:2433`/`:3267`） |
| `tools/check-denial-hints.mjs` | **新增**门禁（45 断言，已进 `.github/workflows/gates.yml`） |
| `tools/check-fs-local-permission.mjs` | **新增**门禁（真跑核心树那份 `dsh-fs-local` + 注入式负控制，`--self-test` 5/5；需要核心树，不进 CI） |
| `tools/check-core-openharmony-patches.mjs` | 19 处 → 21 处（+ ⑩b 组，逐字反向 4 条） |
| `hostcore/core-recipe.json` | `coreVersion` `+dshm.8` → `+dshm.9` |
| `tools/device-code-fingerprint.ps1` | **新增**（设备核心树 5 个关键文件 ↔ 本机树 逐字节 sha256；三档 一致/不一致/未验证，rc 0/1/2；走 Python 桥、端口取仓库常量；**只读**、需要设备 ⇒ 不进 CI） |
| `AGENTS.md` / `docs/README.md` | 门禁清单、注入处数、文档编号与本条索引 |
