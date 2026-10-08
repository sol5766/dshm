# 108 · PC 端沙箱自检的落实 · API 23 向下兼容实证

> **⚠️ 后续更新（2026-10-06 同日，见 docs/110）**：本文件 §6-2 的"23 还是 24"**已拍板取 6.1.1(24)**。
> 因此下面出现的一切 **60100023 / compatibleSdkVersion: 6.1.0(23) 都是那一轮的实验读数**（用来证明"能更低"），
> **不是**当前口径；当前产物是 minAPIVersion=60101024（	argetSdkVersion 与 compatibleSdkVersion 同为 24）。
> 本文件其余结论（沙箱 EPERM 的根因是签名 profile 的 ACL、glob 静默失败、落盘 errno 可读化）**不受影响**。

> 2026-10-06（开发端；PC 端自检报告取用户提供的**仓库外**文件 `dshm-sandbox-fix-plan.md`，
> 复现环境：HarmonyOS PC · 宿主 pid 13459 · 核心 `0.2.1-alpha.1+dshm.6` · app 构建 17:43）。
> 用户原话：**「PC端关于沙箱的自检文档，顺便探索一下，鸿蒙6.1 api版本23，当前项目是鸿蒙7 api版本26，
> 能不能向下兼容，6.1的设备暂时安装不上，以上内容从开发端落实。」**
> 一句话结论：**三件事各有各的答案** —— ① 报告里的 P1/P2 是**真缺陷**，已在本端修掉（两处代码 + 一处技能）；
> ② 三个标准个人目录的 `EPERM` 是**平台目录策略**，本仓的签名 `profile` 决定了"能不能申请"，
> 本轮**不改签名面**（方案 A）；③ **API 23 向下兼容在编译期成立**，代码侧只差 **6 处 `fill`**，已改成等价的
> `Row + backgroundColor`，产物里 `minAPIVersion` 已是 `60100023`。

---

## 0 输入与拆解

| 输入 | 性质 | 本轮处置 |
|---|---|---|
| 报告 §1.5 / P1-1 | `glob(Documents,"*")` → `No files found`、`grep(Documents,".")` → `No matches found`（**静默伪装成"目录为空"**） | **修**（§3.1，已进门禁） |
| 报告 P1-2 | 落盘失败抛裸 errno，含内部临时件名（`EPERM … open '….partial'`） | **修**（§3.2） |
| 报告 P0-2 | 选择器"探写校验"要前移到选择动作 | **已在位**，本轮核实并记录（§3.4） |
| 报告 P2 | `ohos-workspace` 技能要补完整受限集合与正例 | **修**（§3.3） |
| 报告 P0-1 | 方案 A（零权限 + 回落提示）vs 方案 B（申请三条目录权限） | **裁定走 A**，B 的前置条件写清（§2） |
| 报告 §1.6 ① | `module.json5` 是否声明了目录权限 | **答**：没有声明（§2.1） |
| 报告 §1.6 ② | release 域需复测 | **答**：本机签名 profile 是 **debug 且设备绑定**，release 需另发 profile（§2.2） |
| 用户新问题 | 6.1（API 23）设备装不上，能否向下兼容 | **编译期已证**（§1）；**装不上的原因需用户给原始报错**（§2.2 / §6） |

---

## 1 API 23 向下兼容：编译期成立，代码侧只差 6 处 `fill`

### 1.1 决定性实验

只改一行（`build-profile.json5`；该文件**不入库**，模板是 `tools/build-profile.template.json5`）：

```
compatibleSdkVersion: "6.1.1(24)"  →  "6.1.0(23)"     （targetSdkVersion 保持 6.1.1(24)）
```

`hvigorw assembleHap` ⇒ **0 ERROR / BUILD SUCCESSFUL**；110 条 WARN 里只有 **6 条**是"API 级别过高"，
逐字形态为：

```
The 'fill' API is supported since SDK version 26.0.0. However, the current compatible SDK version is 6.1.0(23).
```

其余 WARN 属两类，**都不是版本级障碍**：`The system capacity of this api 'X' is not supported on all devices`
（能力级，24 上同样存在）与 ArkTS 风格提示。

### 1.2 这 6 处 `fill` 是什么：一次**重载遮蔽**，不是"用了新 API"

SDK 原文（`openharmony/ets/api/@ohos.arkui.shape.d.ts` 一族的 `circle.d.ts`）：

```
CircleAttribute.fill(value: ResourceColor | ColorMetrics): CircleAttribute;   // @since 26.0.0
```

它**遮蔽**了基类 `CommonShapeMethod<T>.fill(value: ResourceColor)`（`common.d.ts`，`@since 11`）。
也就是说"给 `Circle` 调 `.fill()`"这个写法在 API 23 上不存在；而**同样的调用**若落在别的形状/组件上则不报，
所以这条极容易被当成"平台怪癖"而不是版本依赖。

**修法（视觉等价，全 token 化）**：`Circle({8,8}).fill(c)` → `Row().width(Sp.S).height(Sp.S).backgroundColor(c).borderRadius(Radius.S)`。
`Sp.S = 8`、`Radius.S = 8`（`appstate/src/main/ets/ui/Tokens.ets`）⇒ 8×8 的盒子 + 8px 圆角 = 正圆，与原来逐像素等价。
同时删掉这 6 处行尾的 `// token-exempt: 状态点几何`（不再有裸值，豁免注释该走）。

| 文件 | 行 |
|---|---|
| `entry/src/main/ets/view/ConnectPane.ets` | 272 |
| `entry/src/main/ets/view/SettingsDevice.ets` | 55 |
| `entry/src/main/ets/view/SettingsInventory.ets` | 55 |
| `entry/src/main/ets/view/SettingsModels.ets` | 375 / 529 |
| `entry/src/main/ets/view/SettingsPlugins.ets` | 115 |

### 1.3 产物实读（改完 6 处后重编译）

| 读数 | 值 | 出处 |
|---|---|---|
| `app.minAPIVersion` | **`60100023`** | HAP 内 `module.json`（`ExtractToDirectory` 后逐字读） |
| `app.targetAPIVersion` | `60101024` | 同上 |
| `app.compileSdkVersion` | `26.0.0.32` | 同上 |
| `pack.info` → `modules[0].apiVersion` | `{compatible: 23, releaseType: Beta2, target: 24}` | 同上 |
| 编译诊断 | **0 ERROR**，`fill … since SDK version 26` 警告 **0 条** | `dist/_compat23_build2.log` |

⇒ **"能不能向下兼容"在编译层面是"能"**，代价只有这 6 处（已付）。运行期兼容性**未验**（§6）。

---

## 2 三条目录权限：事实、硬边界与裁定

### 2.1 逐字段证据（SDK `openharmony/toolchains/lib/PermissionDefinitions.json` 实读）

| 权限 | grantMode | availableLevel | since | 本仓 `module.json5` |
|---|---|---|---|---|
| `ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY` | **user_grant** | normal | 11 | **未声明** |
| `ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY` | **user_grant** | normal | 11 | **未声明** |
| `ohos.permission.READ_WRITE_DESKTOP_DIRECTORY` | **user_grant** | **system_basic** | 11 | **未声明** |
| `ohos.permission.FILE_ACCESS_PERSIST` | system_grant | **normal** | 11 | 已声明 |
| `ohos.permission.READ_WRITE_USER_FILE` | system_grant | system_basic | 13 | 已声明 |
| `ohos.permission.ACCESS_USER_FULL_DISK` | manual_settings | system_basic | 22 | 已声明 |

⇒ 报告 §1.6 ① 的答复：**`module.json5` 确实没有声明这三条**（全表恰 11 项，见 §2.2），
所以 `Documents` / `Desktop` / `Download` 的 `EPERM` 与"声明了但没申请"无关，是**根本没走这条路**。

> **一处自纠**：`FILE_ACCESS_PERSIST` 早前被记成 `system_basic`，实读是 **normal**（`@ohos.fileshare` 的
> `persistPermission` / `activatePermission` 也均 `@since 11`）。docs/105 的 persist+activate 方案不依赖 ACL，
> 与此一致。

### 2.2 真正的硬边界是**签名 profile**，不是权限表

本机在用的调试签名 profile（`~/.ohos/config/default_desktop.ohos.arm64_*.p7b`，内嵌 JSON 实读）：

```
type            = debug
bundle-name     = com.dshm.dshclient
apl             = normal
app-feature     = hos_normal_app
allowed-acls    = [ ACCESS_USER_FULL_DISK, CUSTOM_SANDBOX, ALLOW_EXTERNAL_NATIVE_CODE,
                    FILE_ACCESS_PERSIST, READ_WRITE_USER_FILE ]        ← 恰好 5 条
debug-info      = { device-id-type: udid, device-ids: [ …4 个 UDID… ] }  ← 设备绑定
validity        = 2026-09-27 → 2027-09-27
```

三条推论，都必须在文档里说清（否则下一轮会照错的前提做决定）：

1. **"`system_basic` 不可申请"是错的说法**。本包 `apl = normal`，却声明并实际用上了
   `READ_WRITE_USER_FILE` / `CUSTOM_SANDBOX` / `ACCESS_USER_FULL_DISK` —— 因为
   **`allowed-acls` 里逐条列了它们**。真正的规则是：*超出 apl 的权限必须在签名 profile 的 ACL 白名单里*。
2. 因此**方案 B 的代价落在签名面**：`READ_WRITE_DOWNLOAD_DIRECTORY` / `…_DOCUMENTS_…` 是
   `user_grant` + **normal**（理论上升 apl 到 normal 就够、无需 ACL 条目），但 `…_DESKTOP_…` 是
   **system_basic** ⇒ 进白名单才能申请 ⇒ 要**重发 profile**。而这份 profile 由 AGC/DevEco 签发，
   本仓**没有第二份私钥**（见 `AGENTS.md` 的签名物料纪律）。
3. **profile 是设备绑定的**（`debug-info.device-ids` = 4 个 UDID）。这决定了 **"6.1 的设备装不上"** 至少有两个
   彼此独立的候选原因：① `minAPIVersion` 高于设备 API（本轮已消掉）；② **该设备的 UDID 不在这个列表里**
   ⇒ 与 API 级别无关，怎么改 `compatibleSdkVersion` 都装不上。**取证需要用户给出原始报错**（§6）。

### 2.3 裁定：本轮走方案 A，B 只登记前置条件

理由（按权重）：

- 方案 B 要动**签名面**（第 2 条），而签名物料只此一份、不可回退 —— 与用户反复强调的
  「别到时候把 PC 端又给改坏了」「保证两种设备下各自已经正常使用的功能正常运行」直接冲突；
- 方案 B 还会给**已经在正常工作的 PC 档**新增一次运行期授权弹窗（`user_grant` 必然弹）；
- 而方案 A 的缺口恰恰就是本轮修掉的那三处（静默失败 / 错误不可读 / 文档没写清）——
  **"被拒"变可读之后，"回落到 `Download/<包名>/`"就是一条如实且可解释的路径**。

⇒ 本轮**不新增任何权限、不动 `module.json5`**（`requestPermissions` 仍是 11 项）。

---

## 3 本端落实的四处改动

### 3.1 P1-1：`glob` / `grep` 不再把"读不到"伪装成"没有内容"

**根因**（不是"没权限所以返回空"，而是**上游把 exit 1 一律读成"没有匹配"**）。`dsh-tool-fs-search`
`lib/index.js` 的 `runRipgrep` 尾段逐字是：

```js
if (outcome.exitCode !== 0 && outcome.exitCode !== 1) throw classifyRunFailure(…);
return { …, noMatches: outcome.exitCode === 1, … };
```

而**权限拒绝是遍历期错误**：rg / find 把它打到 stderr 后**继续**，最终没有命中就以 `exit 1` 收场
⇒ 落进 `noMatches` ⇒ `formatGlobPaths` 的 `paths.length === 0` 返回 `No files found`、
`formatRetainedGrep` 的 `seen === 0` 返回 `No matches found`。**"1"这个数字同时代表"真的没有"和"没读进去"**。

**修法**（落在既有的 `pack-core` `patchFsSearchFallback()` 里，第 4 段注入）：新增纯函数
`accessibilityDenial(toolName, stderrText)`，判据是**"空结果 + stderr 命中访问类关键词"**：

```
if (outcome.exitCode === 1 && stdout.text.length === 0) {
	const denial = accessibilityDenial(toolName, stderr.text);
	if (denial !== null) throw denial;      // ⇒ SEARCH_FAILED，报文点名"读不到 ≠ 没有内容"
}
```

关键词面：`permission denied` / `operation not permitted` / `os error 1` / `os error 13` / `EACCES` / `EPERM`（不分大小写）。

**为什么只加在"空结果"这一支**（这是本修法的关键取舍）：大树里个别子目录读不到是**常态**
（跨挂载点、系统目录、别人的包名目录）。若只看 stderr 就判失败，会把**已经拿到的 315 条结果**一起丢掉 ——
那比原来的缺陷更坏。所以判据是"**stdout 为空**"∧"**stderr 有访问类词**"。

### 3.2 P1-2：落盘 errno 可读化（`hostcore/plugins/dshm-fs-write-nonchmod`）

缺口逐字形态（报告 §P1-2 与用户端实测一致）：

```
EPERM: operation not permitted, open '/storage/Users/currentUser/Documents/报告.md.41230.<uuid>.partial'
```

三样对用户无意义的东西：本实现的**内部临时件名**、`open` 这个 syscall 名、以及"被拒的是**目录**、
报出来的却是**文件**"的路径错位。

修法：在 `lib/fsio-nochmod.js` 的 `writeFileAtomicNoChmod()` 失败路径上接一个纯函数
`describeWriteFailure(error, absolutePath)`，按 `error.code` 归三档，并**只改写 `message`**
（`code` / `errno` / `stack` 原样留下 ⇒ 调用方按 code 的分派行为不变）：

| code | 人话 |
|---|---|
| `EPERM` | 目录受系统保护、当前没有读写授权（EPERM）：`<目录>`（目标文件 `<basename>`）… |
| `EACCES` | 当前身份无权访问该目录（EACCES）… |
| `EROFS` | 该位置是只读文件系统（EROFS）… |

> **为什么不按数字 `errno` 判**：node 在 Linux / 鸿蒙上把 `errno` 记成**负数**（EPERM → -1、EACCES → -13），
> 按数字判会随平台漂移；报告里写的 `EPERM(1)` / `EACCES(13)` 是**正**的 C errno，与 node 暴露的同名字段
> 不同号 —— 这条正是本注释要挡的误读。字符串 `code` 才是稳定口径。

### 3.3 P2：`ohos-workspace` 技能补齐受限集合与正例

`entry/src/main/resources/resfile/ohos-skills/ohos-workspace.md` 新增小节
「node 侧实测的目录边界（2026-10-06 真机取证）」：**被拒**（`Documents`/`Desktop`/`Download` 本体、
`.Trash`/`.Recent`/`appdata`）、**可写**（`Download/<包名>/`、`harness`/`data`/`WorkBuddy`/`Images`/`Music`/`Videos`
等）、**只读/越界**（`el1/bundle`、`/system/bin`、`/tmp`），并写明"这是目录策略 ⇒ 重试无效，不要试"
与 P1-1 的新报错形态（据此**不得**判定目录为空）。

### 3.4 P0-2：选择器探写前移 —— 核实结论是"已在位"

报告的 P0-2 写「当前只在启动期对 `DSHM_PUBLIC_DOWNLOAD` 做探写；用户手动选目录时缺同一道校验」。
核码结论：**这条对 PC 档已不成立**。`platform/src/main/ets/system/FilePicker.ets` 的 `pickFolder()` 里

```ts
const acceptable: boolean = handheld ? (owned || granted.persisted) : probePathWritable(realPath);
```

非手持档走的**就是** `probePathWritable()`（真跑 `open(CREATE)+write+unlink`，而不是查权限位 —— 因为 hmfs 的
`stat`/`access` 会撒谎，见 docs/70 §2.1）；失败即**不采纳**并回落到 `Download/<包名>/`，同时把原因交给 UI。
手持档的判据换成"授权能否跨启动"是 docs/105 的定案，与本条不冲突。
⇒ 本轮**不改这里**（改=动已经在工作的 PC 路径），只登记"报告读数基于已装版本、与当前树不一致"。

---

## 4 门禁与验证读数

`coreVersion` 由内容变更驱动，升 `0.2.1-alpha.1+dshm.7` → **`+dshm.8`**
（AGENTS.md 的铁律：核心树内容变 ⇒ 必须升，否则端侧不换树、`pack-core` 也不会重新物化）。
本次不升版本号是不行的，但升的方式**没有**靠"删树"，而是走既有的 pristine 可重入重打
（`pack-core` 自检打印 `树里那份=上次打出的结果 ⇒ 回到 pristine 原文重打（可重入）`）。

| 项 | 读数 |
|---|---|
| `assert-fs-search-fallback.mjs` | **73 通过 / 0 失败**（新增 2 条结构锚点 + 5 个正例 + 3 个反例） |
| 全套门禁 | **21/21 exit=0**（含 `check-core-openharmony-patches` 151 断言、`check-market-bridge` 44、`check-doc-refs`、`check-dead-code`、`check-resfile-core-zip`） |
| core 容器 | `dsh-core-0.2.1-alpha.1+dshm.8-openharmony-arm64.zip` · 85,138,521 B · `sha256 231102b0bb504330…` · resfile **只有 1 份** |
| HAP | `entry-default-signed.hap` · 321,413,180 B · `sha256 854fd675bb7a957b…` · 包内那份 core 的 sha256 与本地**逐字节一致**（装机用的就是它，见 §4.1） |

### 4.1 真机读数（PC 档 / 2in1，2026-10-06 21:20，设备 `86E0226429000417`）

按 `tools/update-device.ps1`（**唯一允许的装机入口**，全程只有 `hdc install -r`）覆盖安装本次产物：

| 读数 | 值 | 说明 |
|---|---|---|
| 覆盖安装 | **成功** | 包是 `minAPIVersion=60100023` 的兼容包，装在 **API 26** 的 PC 上照样装得上 ⇒ **兼容面变宽不破坏安装** |
| `home` 指纹 | `links 13 → 13`、`size 3440` 不变 | 用户数据（会话 / 插件 / 工作区）**逐项保留** |
| 核心树 | 落地后出现 `0.2.1-alpha.1+dshm.8` | 端侧确实换了树 —— 这正是必须升 `coreVersion` 的理由 |
| exec 探测 | **10/10 全通**（`python3.12` / `git` / `rg` / `ash` / `bash` / `system-sh` / `toybox` …） | PC 档既有能力面**零回归** |
| 端侧就绪 | 第 10 秒出现本轮 exec 探测 | 冷启动正常 |

**两项修复在设备上的结构读数**（直接读设备解包后的核心树）：

| 断言 | 读数 |
|---|---|
| `dsh-tool-fs-search/lib/index.js` 含 `outcome.exitCode === 1 && stdout.text.length === 0` | **命中，第 425 行** |
| `dshm-fs-write-nonchmod/lib/fsio-nochmod.js` 含 `describeWriteFailure` / `WRITE_DENIAL_HINTS` | **命中（2 处 / 第 100 行）** |

**两处必须如实说明的口径**：

1. `entry/.cxx` 里的 ninja 缓存引用了**已删**的 `dist/core/work/dsh-core-…+dshm.7` 路径 ⇒ 清旧树后第一次构建必失败
   （`ninja: error: '…+dshm.7/…/flock.c' … missing and no known rule to make it`）。删掉 `entry/.cxx`（构建缓存，允许清理）
   后一切正常 —— 与 `AGENTS.md`「清理 `dist/core` 的两个教训」第 3 条逐字一致，本次是又一次实证。
2. **P1-1 的「运行期」尚未复跑**：报告用例 3（`glob Documents "*"` 必须报无权限）需要**应用进程域**（uid 20020292）
   的一次工具调用，而 `hdc shell` 是**另一个 uid** —— 它连 `/storage/Users/currentUser` 都看不见
   （实测 `find: '/storage/Users/currentUser/Documents': No such file or directory`），所以**无法**从 shell 侧复现该前提。
   本轮对 P1-1 的证据因此是：**上游代码语义 + 设备侧结构读数 + 73 条行为门禁（5 正例 / 3 反例）**；
   **缺的是端上真跑一次**（在界面上让 agent 对 `Documents` 做一次 `glob`/`grep` 即可，30 秒可判）。
| 编译 | 0 ERROR，`BUILD SUCCESSFUL`（`dist/_sandbox_build.log`） |

**门禁覆盖面自审**（照 docs/README 纪律 9）：P1-1 的新判据进了行为门禁（正例 + 反例各 3 条以上），
P1-2 与 P2 **没有**专门门禁 —— P1-2 靠 `node --check` 与 `check-core-openharmony-patches` 的"插件在树里"覆盖，
P2 靠 `check-skill-sync.cjs`（它测的是同步机制，不测内容）。**这两条属已知覆盖缺口**。

---

## 5 与报告/旧结论的对照更正

| 报告或旧记 | 更正 |
|---|---|
| P0-2「用户手动选目录缺探写校验」 | PC 档**已有**（§3.4）；该读数基于已装版本 |
| 「`FILE_ACCESS_PERSIST` 是 system_basic」 | 实读 **normal**（§2.1 自纠） |
| 报告的 `EPERM(1)` 被当成 node 的 `errno` | node 记的是**负数**；判据用字符串 `code`（§3.2） |
| 「`system_basic` 权限申请不了」 | 真正的门是**签名 profile 的 `allowed-acls`**（§2.2） |

---

## 6 未做项 / 待用户拍板

1. **6.1 设备装不上的原因要取证**：请提供 `hdc install` 的**原始报错**与设备的
   **API 版本 / 系统版本 / UDID**。三个候选原因需要分开验：① `minAPIVersion`（已消）；
   ② **调试 profile 的设备绑定**（4 个 UDID，§2.2）；③ 设备侧"目标 API 过高"的另一种措辞。
   —— 若是 ②，改编译参数**不可能**修好，需要在 DevEco/AGC 上把该设备加进 profile 并重签。
2. **`compatibleSdkVersion` 最终取 23 还是 24 —— ✅ 已于 2026-10-06 拍板取 `6.1.1(24)`（见 `docs/110` §5）**：
   本轮把本地那份改成 `6.1.0(23)` 只为证明"能更低"（编译 0 ERROR / 门禁全绿），**不是**兼容面结论；
   取 24 的理由按权重：**本仓没有 API 23 的验证设备**（不把未验收的档位当产品口径）、与 `targetSdkVersion`
   一致（`README.md` 的「构建」小节「SDK 版本口径」，2026-09-14 的既有决策）、真需要覆盖 6.1.0 时是**一行**改动（路径即本文件 §1）。
   `tools/build-profile.template.json5` 与本地 `build-profile.json5` 均已同步为 **24**；产物实读
   `minAPIVersion=60101024` / `targetAPIVersion=60101024` / `compileSdkVersion=26.0.0.32`。
3. **运行期**兼容性未验（编译绿 ≠ 跑得起来）：需在真机（PC 档与 6.1 设备）上回归一遍既有功能面。
4. **方案 B** 的前置条件（重发含 3 条目录权限的 profile）与代价（PC 档新增授权弹窗）已写清，**未做**。
5. `report §4` 用例 1/4 的**真机复跑**：PC 档已覆盖安装（见 §4.1），但用例 3（限制目录上的 `glob`/`grep` 报错）与用例 1/4 的**端上**复跑仍待做（需要应用进程域的一次工具调用 / 界面操作）；**6.1 设备本轮无设备可测**。

---

## 7 证据索引

| 内容 | 位置 / 方式 |
|---|---|
| PC 端沙箱自检报告（输入） | 仓库外 `…/2026-10/dshm-sandbox-fix-plan.md`（197 行） |
| 权限逐字段读数 | `sdk/default/openharmony/toolchains/lib/PermissionDefinitions.json` |
| 签名 profile（apl / ACL / 设备绑定） | `~/.ohos/config/default_desktop.ohos.arm64_*.p7b` 内嵌 JSON（PowerShell 花括号配平截取） |
| `fill` 的 `@since` 遮蔽 | SDK `ets/api/@ohos.arkui.shape.d.ts` 一族 `circle.d.ts` 与 `common.d.ts` |
| 兼容性编译日志 | `dist/_compat23_build.log`、`dist/_compat23_build2.log`、`dist/_sandbox_build.log` |
| 核心树注入与容器 | `dist/core/work/dsh-core-0.2.1-alpha.1+dshm.8/`、`dist/_packcore-dshm8.log`、`dist/_packcore-dshm8b.log` |
| 门禁 | `tools/assert-fs-search-fallback.mjs`（73 断言）、`tools/check-core-openharmony-patches.mjs`（151） |
