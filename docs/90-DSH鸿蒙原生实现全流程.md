# DSH 鸿蒙原生实现全流程

> **DSHM**（DeepSeek Harness 鸿蒙客户端）—— 把官方面向桌面的 dsh Node 运行时
> 搬进 HarmonyOS/OpenHarmony arm64 的 HAP 里自足运行。
> 包名 `com.dshm.dshclient`。
>
> **本文档的定位**：一份**端到端的实现全流程**说明 —— 从素材到装机、从启动到语音、
> 从门禁到排障。它不是任务书（那是 D1），也不是架构权威（那是 D6），
> 而是**把"实际是怎么做的、为什么这么做、怎么验证"串成一条线**，
> 让接手的人能独立判断"我能不能改这里、改了会怎样"。
>
> **与既有文档的关系**：本文档**不取代**任何既有文档，而是它们的**串联与实操化**。
> 遇到契约细节仍应查 D2/D2b/D3b，遇到架构权威仍应查 D6，遇到坑的索引仍可查 D8。

## 怎么用这份文档

| 你的处境 | 读哪几章 |
|---|---|
| **刚接手，想快速理解这个项目** | 第一章（总览与两个根本约束）→ 第三章（端侧运行时）|
| 要**构建出可装的包** | 第二章（构建流水线，含每步的输入/输出/失败形态）|
| 要**改运行期行为**（宿主、垫片、工具链）| 第三章 → 第六章（门禁与纪律）|
| 要**改界面或语音** | 第四章 |
| **真机出问题了**，要排障 | 第五章（诊断手段 + 踩坑总表）→ `docs/70`（按主题深挖）|
| 要**加/改门禁** | 第六章 |

## 读之前要知道的一处"文档与实物不一致"（已在本轮修正）

项目里**大量旧文档**写着 `libnode.so.127`，而**当前实物是 `libnode.so.137`**
（Node 24.2.0）：

```bash
ls entry/libs/arm64-v8a/ | grep libnode     # → libnode.so.137  126,809,264 B
```

- 代码侧**早已是候选顺序查找**（`libnode.so.137` → `.127` → `.so`，
  `hostruntime/src/main/cpp/dshhost.cc`），所以运行不受影响；
- 受影响的是**文档可读性**：`docs/50`、`docs/70` 里的 `.127` 是**当时的事实**，
  属历史记录，保留不改；根 `README.md` 的那处已在本轮修正。
- 判断"到底是哪个版本"**只看二进制自述**，别信注释（见第三章 §6.1 的三方口径表）。

## 全篇的两条纲（先记住，后面都是推论）

1. **`--jitless` ⇒ `WebAssembly === undefined`** —— 这是"能正常上架"的代价，
   也是最深的一处"看起来能跑、其实语义不对"的源头。
2. **execve 受签名域管辖** —— 沙箱内第三方 ELF 一律被拒，因此有了
   "构建期自签名 / 纯 JS 降级 / 进程内 dlopen 桥"三条路。

详见第一章 §2。

## 章节

| 章 | 文件里的位置 | 内容 |
|---|---|---|
| 第一章 | §1 起 | 总览、两个根本约束、整体架构、关键技术选型 |
| 第二章 | 第二章标题起 | 构建流水线九步、交付包归置、体积账、常见失败 |
| 第三章 | 第三章标题起 | HAP 布局、首启解包、BOOT 序列、Node 参数、宿主补丁清单、沙箱、网络 |
| 第四章 | 第四章标题起 | 模块划分与依赖方向、Web 加载链、原生麦克风与语音、图标、设计体系 |
| 第五章 | 第五章标题起 | 数据保全纪律、验收流程、诊断手段、踩坑总表 |
| 第六章 | 第六章标题起 | 门禁清单与自我要求、独立审查制度、工程纪律 |

## 配套文档

| 文档 | 什么时候读 |
|---|---|
| [`00-开发任务书.md`](00-开发任务书.md)（D1）| 范围 / 目标 / 验收的权威（注意其"远程客户端"定位已被 D6 更正）|
| [`HANDOFF.md`](HANDOFF.md)（**H2**）| **接手先读**：一句话现状、Windows 端 dsh desktop 重装步骤、**未完成事项**（连接抖动机制与修法、启动 40s 自杀嫌疑链）|
| [`50-端侧核心运行架构.md`](50-端侧核心运行架构.md)（**D6**）| 架构权威；本文档大量引用它 |
| [`70-鸿蒙移植踩坑与修复总览.md`](70-鸿蒙移植踩坑与修复总览.md)（**D8**）| **按技术主题**的坑库；本文档第五章给四段式速查并指向它 |
| [`device-validation.md`](device-validation.md)| 47 个批次的真机验收原始记录 |
| [`80-真机更新与数据保全.md`](80-真机更新与数据保全.md)| 装机与数据保全（事故复盘）|
| [`parity-matrix.md`](parity-matrix.md)| 功能对等矩阵（由门禁强制）|
| [`review-prompts.md`](review-prompts.md)| 三路对抗性审查提示词 |
| [`AGENTS.md`](../AGENTS.md)| 工作约束（**动手前必读**）|



---

# 第一章 总览与两个根本约束

## 1. 这个项目在做什么

### 1.1 一句话

把官方**面向桌面（Electron）**的 dsh（DeepSeek Harness）Node 运行时，搬进一个 HarmonyOS/OpenHarmony
arm64 的 HAP 里**自足运行**：应用内自带 Node 运行时与 dsh 核心树，核心在本机 `127.0.0.1` 上起 Host，
界面是这个本地 Host 的客户端。**装上即用，不需要电脑上常驻任何服务**
（`README.md`；同一句话的任务书表述见 `docs/00-开发任务书.md:53`）。

包名 `com.dshm.dshclient`（`AppScope/app.json5:3`），设备形态 phone / tablet / 2in1
（`entry/src/main/module.json5:7-11`）。

### 1.2 为什么是"移植"，而不是"重写一个原生客户端"

任务书在 2026-09-12 把目标**反转**过一次，这段历史决定了今天所有实现方式，必须知道：

| 备选 | 描述 | 判定 |
|---|---|---|
| B：端侧完整 Host（Node 运行时进 HAP）+ 端侧原生页面 | 应用自带运行时与核心树 | ✅ **v1 主方案** |
| A：原生 Client + PC 侧 Host | 端侧只说协议 | 🔁 降为**可选**接入（不再是验收口径） |
| C：端侧 ArkWeb 复用官方 Web UI + 端侧 Host | 社区路线 | ⚠️ 当时记为"可选第二页面" |

（`docs/00-开发任务书.md:214-219`；反转的论证与证据在 `docs/50-端侧核心运行架构.md:14-30`）

**"移植"这条路线真正的含义**是：**不重写 dsh 的业务逻辑**。项目的硬不变式是
"零上游 patch：端侧差异只走 dsh 自己的组合面（profile / `cordis.patch.yml` / bundle）"
（`docs/50-端侧核心运行架构.md:35`）。于是端侧能改的只有五类落点：

1. `hostcore/app/*`（宿主入口脚本与垫片，运行在 Node 里）；
2. `hostruntime/**`（ArkTS 侧的运行时载体与核心仓库）；
3. `tools/*`（构建期：打包核心树、放置工具链、注入补丁、签名）；
4. `entry/src/main/cpp/*`（原生引导与桥，由 hvigor 的 CMake 编）；
5. `hostcore/profile/ondevice/*`（端侧 profile 的 patch 层）。

> **为什么不做"重写原生界面"**：不是审美问题，是**能力面**问题。dsh 的界面不是一整块，而是
> **41 个客户端插件包**（`@deepseek-ai/dsh-client-ui-*`）拼出来的，逐包的官方文案内嵌在包里
> （`docs/50-端侧核心运行架构.md:1014-1018`）。照协议逐包复刻 = 用一个无限排期的前端工程去追上游；
> 而把官方 Web UI 原样装进 ArkWeb，**上游每加一个面板/按钮，端侧自动获得**。
> 项目自身的对等矩阵已量过这条路的代价：逐包对齐后仍有工作流成员视图、计划模式、拖放排序等
> 一批"差一行"的缺口（同文件 `:1024-1049`），而 Web UI 路线下这些缺口不存在。

**当前实现与早期文档的一处不一致（如实登记）**：`docs/00-开发任务书.md:218` 把"ArkWeb 复用官方
Web UI"写成"可选的第二页面、不作主页面"，而**现实现是把它作为默认主页**：

- `entry/src/main/ets/entryability/EntryAbility.ets:503-505`
  —— `// 主界面 = Web 壳页：官方 apps/desktop 的鸿蒙等价物` 之后 `windowStage.loadContent('pages/WebApp')`；
- `entry/src/main/resources/base/profile/main_pages.json:2-5` —— 三个页面里 **`pages/WebApp` 排第一**，
  `pages/Index`（ArkTS 原生壳，`entry/src/main/ets/pages/Index.ets:335`）与 `pages/Poc1` 保留为
  诊断/回退页（`EntryAbility.ets:504`）；
- 全仓搜索**没有**任何指向 `pages/Index` 的应用内导航调用点（`router.pushUrl` 仅命中
  `entry/src/main/ets/pages/Index.ets:1859` 一处，目标是 `pages/Poc1`）。

⇒ 读 `docs/00` 时要知道：那一条已被实现推翻，**权威以代码为准**。

**怎么验证**

```bash
# 默认主页是谁
grep -n "loadContent" entry/src/main/ets/entryability/EntryAbility.ets
cat entry/src/main/resources/base/profile/main_pages.json
# 原生壳是否还有应用内入口（预期：无 pages/Index 的导航调用）
grep -rn "pages/Index" entry/src/main/ets/
```

---

## 2. 全篇的纲：两个根本约束

`docs/70-鸿蒙移植踩坑与修复总览.md` §0 把这两条挑出来放在最前面。**后面几乎所有设计都是它们的推论**，
所以这一节把它们吃透并补上后续批次新增的证据。

```text
约束一：--jitless  ⇒  WebAssembly === undefined  ⇒  依赖 WASM 的 npm 包全废
约束二：execve 受签名域管辖  ⇒  沙箱内第三方 ELF 一律被拒  ⇒  必须构建期自签名
```

### 2.1 约束一：不申请 JIT ⇒ 全程 `--jitless` ⇒ 没有 WASM

#### 2.1.1 为什么必须 jitless（这不是偏好，是上架前提）

V8 依赖**可写可执行的匿名内存**，鸿蒙默认拦截。要开 JIT 必须申请 ACL 权限
`ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY`，而华为的口径是**当前仅平板 / PC-2in1
设备应用可申请**（`docs/50-端侧核心运行架构.md:99`，E13）。项目的产品决策是
**各端统一不申请该权限**，以保证顺利上架（同文件 `:564-568`）。

因此 `--jitless` 不是"配置项"，而是**唯一形态**，并且被门禁钉死：

- 契约的唯一事实来源是 `hostruntime/src/main/ets/runtime/RuntimePort.ets:125-170` 的
  `buildHostArgv()`，第一项就是 `--jitless`，且**必须排在脚本路径之前**
  （Node 把第一个非选项参数当脚本；写反了就去执行一个叫 `--jitless` 的文件）；
- `entry/src/ohosTest/ets/test/CoreDecision.test.ets:196-205` 用单测钉住这两条；
- `tools/check-store-readiness.mjs` 把"argv 里必须有 `--jitless`"作为上架红线之一
  （本机实跑：`RESULT: PASS`）；
- `entry/src/main/module.json5` 的 10 项权限（`:16-123`，十项 `name` 分别在第
  `18,28,38,48,58,68,78,88,98,114` 行）里**没有任何 `ohos.permission.kernel.*`**。

#### 2.1.2 代价：`WebAssembly === undefined`，且它**恒定**

V8 的 `--jitless` 与 `--expose_wasm` 互斥，启动即打印 `disabling flag --expose_wasm`
（真机首次观测见 `docs/50-端侧核心运行架构.md:121` E33；源码级依据 E19 在同文件 `:105`）。
可复跑的对照（本机 Windows / Node **v24.19.0**）：

```bash
node -e "console.log(typeof WebAssembly)"            # object
node --jitless -e "console.log(typeof WebAssembly)"  # undefined
```

#### 2.1.3 由此推出的硬判据

> **凡上游直接 `import('undici')` 的功能，在端侧都会失败** —— undici 的 HTTP 解析器是 WASM
> （`lib/llhttp/llhttp-wasm.js`）。

已实证的受害者是 `web_fetch`（`dsh-web-fetch-http` 自建 `Agent` 并把 `dispatcher` 传进 fetch），
而 `web_search` 正常，因为它走的是全局 `fetch`（我们自己的纯 JS 垫片）。
**同一核心树、同一个本地 HTTP 服务，只有 `--jitless` 一个变量就能复现两组结果**
（`README.md`、`docs/parity-matrix.md:233-247`）。

#### 2.1.4 怎么绕过：**两层**垫片（缺一层就会出现"Host 起来了、模型也能回话，但某个工具静默坏掉"）

| 层 | 落点 | 做什么 | 不做的后果 |
|---|---|---|---|
| 全局 `fetch` 垫片 | `hostcore/app/fetch-shim.js`（`installFetchShim()` 在 `:586`），由 `main.js:378-379` 装载 | 用 `node:http/https`（**原生 llhttp**，与 WASM 无关）重写 `fetch/Request/Response/Headers/FormData/Blob/File` | **调模型就走不通**（dsh 调模型就是用 fetch） |
| `undici` **模块名**解析钩子 | `hostcore/app/undici-shim.mjs` + `undici-loader.mjs`，由 `main.js:411-425` 的 `installUndiciNameHook()` 注册 | 让上游 `await import("undici")` 拿到同一个垫片，并把 `dispatcher` 翻译成 `lookup` | **`web_fetch` 打不开任何网页**（`web_search` 仍正常，因为后者走第一层） |

三个必须记住的实现细节（都来自真机/门禁的对抗实验，不是推断）：

1. **钩子只在 `WebAssembly` 不可用时注册**（`main.js:412-415`）。原生 undici 可用时不该被替换
   —— 它的连接池与协议实现比垫片完整得多。
2. **垫片必须尊重 `redirect: 'manual'`**：上游 `web_fetch` 靠它自己实现"仅同源跳转"的安全策略，
   垫片擅自跟跳等于绕过它（`docs/parity-matrix.md:233`）。
3. **不要先读 `globalThis.fetch` 的原值**：Node 用 getter 惰性装 fetch，一读就触发 undici 初始化
   （`docs/50` E36，`:124`）。同一个坑还有一个变体：`node:http` 上有一批惰性 getter
   （实测 `maxHeaderSize, globalAgent, WebSocket, CloseEvent, MessageEvent`），
   触发栈的关键帧是 `at lazyUndici (node:http:123:21)`（E38，`:126`）。
   `main.js:168-183` 因此在任何人访问之前用 `defineProperty` 把**全部**惰性 getter 封掉
   —— 这一步是"WASM 阻塞被消除"的直接原因（E39，`:127`）。

守护它的门禁自带**对照实验**：`tools/check-web-fetch-jitless.mjs` 要求
A 臂（不注册钩子）**必须失败且必须给出 WASM 因果证据**，B 臂**必须全过**，且**跨源跳转仍须被拒**
（`:47-111`、`:231`；用法见 `:41-43`）。**2026-09-28 起不再需要 Node 22**：子进程 flag 改为**运行时探测**
（此前写死 `--no-experimental-fetch`，该 flag 的否定形态在 Node 24 已无效 ⇒ 两臂同时哑火），
loader 路径改用 `pathToFileURL`（此前裸盘符路径使 **B 臂从未跑成过**）——详见 §3.6。

```bash
# 端侧同参：本机复现整条链（秒级迭代，只把最终结论拿上设备）
node --jitless --experimental-sqlite --expose-internals hostcore/app/main.js   # 需先设 DSHM_* 环境变量
node tools/check-web-fetch-jitless.mjs
```

#### 2.1.5 上游升级时必须重做的事

**搜一遍核心树里对 `undici` 的直接依赖，并把垫片覆盖率当作一项验收项**
（`README.md`；同一要求以"升级后必须重搜 undici 直接依赖"的形式登记在
`docs/README.md:53`，并指向 `docs/70` §0.1）。理由：垫片覆盖的是"名字被显式 `import`"的那条路，
上游换一个 HTTP 实现（或换包名）就会静默绕过它。

> **本次核对的缺口（如实登记）**：`docs/40-上游升级手册.md` 全文**不含 `undici` 字样**
> （可复跑：`Select-String -Path docs/40-上游升级手册.md -Pattern "undici"` → 0 命中）。
> 该手册的第 5 步清单里没有这一条，只有 `docs/README.md:53` 的阅读顺序表那一行提到它。
> ⇒ 按手册逐步执行升级的人**不会**被提醒去做这次搜索。

### 2.2 约束二：execve 受**签名域**管辖 ⇒ 沙箱内第三方 ELF 一律被拒

#### 2.2.1 结论与"不是什么"

鸿蒙对"应用沙箱里执行第三方原生二进制"的判据**不是权限位、不是创建者、不是 inode**，
而是**签名域**。这个结论是**对照实验推翻了旧假设**之后才得到的（`docs/70:32-46`）：

决定性实验：把 `rg` 的字节由宿主进程物化到 `bin/rg-real`（与**可用的** busybox 同目录、
**同创建者**），期望复现"本进程创建即可执行"——

```text
exec 探测：… rg=denied，rg-real=denied，bash=ok
```

**两处都 denied**（`docs/device-validation.md:1247-1257`）。真正的分界是
**ELF 与脚本**：`bash` 垫片能跑，是因为它是 `#!/system/bin/sh` **脚本**，内核 exec 的是
**系统**二进制 `/system/bin/sh`，脚本只作参数传入。

| 对象 | 能否 execve | 说明 |
|---|---|---|
| 系统二进制（`/system/bin/sh`、toybox） | ✅ | 内核 exec 的是**系统**路径 |
| **脚本**（`#!/system/bin/sh`） | ✅ | 解释器是系统那个 |
| 沙箱里的第三方 ELF，**签名前**（busybox 副本 / rg / git / python3.12） | ❌ | 表现为 `inaccessible or not found` / `EACCES` |
| 同上，**构建期自签名后** | ✅ | `binary-sign-tool -selfSign 1` |
| HAP 内随包分发的 `.so`（`libnode.so`、`libkoffi.so`、我们自建的 `.so`…） | ⛔ **不经 execve** | 它们走 **dlopen**，因此**不需要** `.codesign`（本机实测：HAP 内这些库全部 `.codesign=False`，只有 `.note.ohos.ident`） |

（判据表的前四行见 `docs/70:37-43`；真机签名前后对照：`docs/device-validation.md:4340-4343`。
最后一行是本章补的**更正**——原表把"HAP 内随包分发的 ELF"与"自建 `.so`"并列成 execve 的 ✅，
会把读者引向"`.so` 也需要 `.codesign`"，从而去重签已验证过的 dlopen 链路。）

> **⚠️ 这条结论带实验条件，条件变了要重验。** 早期文档写的是"执行许可绑创建者"，
> 已被上述实验否定（`docs/70:35`、`docs/device-validation.md:1299`）。
> 同样重要的一条是**脚本可执行 ⇒ 一切都走脚本**：bash 垫片、`pnpm`/`npm`/`npx`/`dsh` 四个假壳、
> `python`/`pip3`/`git`/`rg` 四个 wrapper，全部是文本脚本（`main.js:1139`、`:1849-1866`、`:2045-2277`）。

#### 2.2.2 由此推出三条路（本项目三条都用，且按场景选）

**路 1 —— 构建期自签名（能签的 ELF 首选这条）。**

签名动作有两处落点，因为两类 ELF 的处境不同：

| 目标 | 落点 | 时机与理由 |
|---|---|---|
| 核心树里的 `rg`（要被 spawn） | `tools/pack-core.mjs:247-305` 的 `selfSignNatives()` | **必须放在 `pack()` 之前、所有"会改写产物"的步骤之后**。踩过的坑：最初放在 `replaceKoffiJs()` 之后，被后面的 `ensureRipgrepPlatformPackage()`（它会重写 rg）**覆盖** ⇒ 磁盘上的 rg 又变回未签名（`docs/70:297-304`；顺序在 `pack-core.mjs:3050-3057` 有长注释） |
| 工具链归档里的 git / python3.12 | `tools/place-toolchain.mjs` + `tools/sign-tar-elf.py` | 它们在**归档**里，解包发生在设备上 ⇒ 构建期必须先解 → 签 → 重新打包 |

**"构建期自签名"这一整套是怎么工作的**（这一节是本约束的重点）：

1. **只签"要被 exec 的独立件"，不碰每个 `.so`。** 这条边界必须先分清**两条不同的门**：

   | 门 | 走哪些东西 | 是否需要 `.codesign` |
   |---|---|---|
   | **execve** | rg、git、python3.12、busybox 副本… | **需要**（本约束） |
   | **dlopen** | `.node` / `.so`（koffi / sharp / node-pty / libpython / 我们自建的 `.so`） | **不需要** |

   后一条是本机实测的：当前 HAP 内 `libnode.so.137`、`libkoffi.so`、`libdshhost.so`、`libsystem.so`、
   `libdshm-gitcompat.so` **全部 `.codesign=False`**（只有 `.note.ohos.ident`），
   而它们在真机上加载并工作正常（如 `原生库重定向已启用：libs=/data/storage/el1/bundle/libs/arm64`
   与 koffi 加载成功）。`pack-core.mjs:255-267` 因此把目标集压到**只有一个 rg**，并写明理由：
   "`.node`/`.so` 走 dlopen，重签反而有破坏已验证链路的风险"。

   `place-toolchain.mjs:37-61` 的口径是
   "git 归档签 `usr/bin/git` / `usr/libexec/git-core/*` / `usr/lib/*.so*`；python 归档签
   `bin/*` + 少量动态件 —— 全树签名会把 27 MB 归档膨胀数倍且没必要"。
   **判据取魔数 `\x7fELF`，不按扩展名猜**（`tools/sign-tar-elf.py:29-37`）。

   **本机独立复核**（不依赖自家门禁，见 §5 的脚本）：git 的 15 个 apk 里 **27 个 ELF 全部已签**；
   python 归档里 **10 个 ELF 全部已签**。

   **第三个自签名落点（注意，它不在任何 `tools/` 脚本里）**：入库存放的
   `entry/src/main/resources/resfile/busybox/busybox`（1,042,048 B）**已经带 `.codesign`**
   （本机实测 `ELF=True .codesign=True .note.ohos.ident=True`；该文件在 `.gitignore` 之外，
   属入库资产）。它由 `main.js:1168-1178` 的 `placeBusyboxDir()` 以 `fs.copyFileSync` 复制到沙箱
   `bin/`（本体 + 8 个 applet 副本），副本逐字节相同 ⇒ 签名随之继承。
   ⇒ 若将来要换 busybox 本体，**必须自己重新签名**，因为 `pack-core.mjs` 与 `place-toolchain.mjs`
   都不覆盖它。

2. **must-use-Python 的原因（Windows 侧）**：归档里有 symlink 条目（`python/bin/python` → `python3.12`、
   git-core 里 180+ 个指向 git 本体的链接）。Windows 上
   `bsdtar` **丢条目**（不可逆地损坏归档）、`7z` 把 symlink **物化**（git-core 8 MB → 1.3 GB）；
   **只有 Python `tarfile` 能逐条目读出来再原样写回去**（`tools/sign-tar-elf.py:1-22`；
   `docs/70:241-250`）。这是 `README.md` 把 Python 3 列为构建前置的唯一原因。

3. **签名命令是 `selfSign`，不需要 keystore 密码**：
   `binary-sign-tool sign -mode localSign -selfSign 1 -signAlg SHA256withECDSA`
   走 `SelfSignSignProvider`，只加 `.codesign` 段并用描述符摘要当签名，
   **跳过 `.profile`/`.permission` 与证书链写入**（`tools/sign-tar-elf.py:40-51`；
   `docs/device-validation.md:1259-1262`）。

4. **版本标记必须存在**：设备侧解包判据原本是"存在即跳过"（`pythonReady()`/`gitReady()`
   只看文件在不在），不改判据的话**重新打包的已签名归档永远不会被解包**——
   那正是报告里"git mtime 仍是 09-22"的成因（`docs/70:306-315`、`main.js:2280-2298`）。
   所以构建期在归档目录写 `dshm-signed.txt`，端侧比对"归档标记 vs 解包目录标记"，
   不一致即强制重解（`main.js:2338-2344`）。

5. **标记文件名不能以点开头**：HAP 打包会丢弃**所有** dotfile 条目（实测打包产物里以点开头的
   条目数为 0）。最初用 `.dshm-signed` ⇒ 标记传不到设备 ⇒ 换代判定永不触发 ⇒ 新签名归档
   永远不被解包，**白签一场**（`docs/70:291-295`、`tools/place-toolchain.mjs:64-72`）。

6. **E-TS2：标记必须是"内容相关的摘要"，固定常量会导致"白签一场"。** 这是本项目里
   同一类坑换了个触发点又出现一次：
   `SIGN_MARKER = 'dshm-signed-v1'` 是**固定字符串**，而端侧判据是
   `解包目录标记 !== 归档目录标记 ⇒ 重解`。若 09-22 那版（**未签名**）也写同一个常量，
   今天这版（**已签名**）标记不变 ⇒ 端侧判成"没换代" ⇒ **不重解** ⇒ 新签名到不了设备
   （`docs/device-validation.md:4352-4361`）。
   修法：标记改为 **`前缀 + 内容摘要`**，且**每个归档目录各算各的**（python 与 git 分开，
   因为端侧是分别比较两个目录的）。摘要取**该归档目录内文件大小之和** ——
   签名会改变文件字节，大小必然变，且不必读 27 MB 算哈希（`tools/place-toolchain.mjs:182-200`）。
   真机实证：

   ```text
   files/toolchain/gitroot/dshm-signed.txt:    dshm-signed-v1+8501127
   files/toolchain/python/dshm-signed.txt:     dshm-signed-v1+27720007
   ```

   （`docs/device-validation.md:4363-4367`；本机复跑实测同上）

   **实现时自己踩的坑（留档）**：摘要在**签名之前**算过一版，而签名会改变文件大小 ⇒
   标记记的是签名前的值，与落盘文件对不上。**新建的门禁立刻报出不一致**
   （`tools/place-toolchain.mjs:211-216`、`docs/device-validation.md:4369-4371`）
   —— 这就是加门禁的价值。

7. **签发"静默跳过"必须变成显式失败（E-TS1）。** 真实事故：本机 PATH 里没有 `python3`/`python`/`py`，
   `findHostPython()` 返回 null ⇒ 只打一行 ⚠ 就跳过自签名，而脚本**仍 exit=0**。
   后果是设备上 `exec 探测 = python3.12=denied，git=denied，git-core/git=denied` 长期存在，
   **而构建端一切正常、没有任何门禁会红**（`docs/device-validation.md:4313-4328`）。
   三步修法（同文件 `:4330-4336`）：
   ① `findHostPython()` 追加**项目自带**的 python 候选（`.dsh/dsh-runtimes/.../dependencies/python`），
   不依赖调用者 PATH；② 签名未执行 ⇒ **exit 1**（保留 `DSHM_ALLOW_UNSIGNED_TOOLCHAIN=1` 逃生阀）；
   ③ 新增门禁 `tools/check-toolchain-sign.mjs`。
   真机决定性读数：**2/7 → 7/7**（`:4340-4343`）。

**路 2 —— 纯 JS / 脚本降级（签不了或不该签的场景）。**

| 场景 | 做法 | 落点 |
|---|---|---|
| 内容搜索（`glob`/`grep`） | rg 被拒时降级到系统 `find`/`grep`（toybox applet 在白名单内可 exec；打包器注释引用了"busybox 探测同源实证"）；探测结果进程内 memoize，**abort 竞态不记忆** | `tools/pack-core.mjs:931`（`patchFsSearchFallback()`，打包期注入核心树），门禁 `tools/assert-fs-search-fallback.mjs`（三层防线：结构 / 语法 / 行为） |
| `bash` 工具通道 | busybox **未编** bash applet，改成文本垫片：真 bash → busybox ash → `/system/bin/sh` | `main.js:1096`（applet 清单）、`:1139`（`ensureBashShim`） |
| 包管理器（`pnpm`/`npm`/`npx`/`dsh`） | 端侧一个都没有 ⇒ 用 POSIX sh 假壳把命令转成"安装队列投递"（Host 进程内安装器接单） | `main.js:1849-1866`，门禁 `tools/assert-cli-shim.mjs`（40 项） |
| `python3`/`pip3`/`git` 调用 | wrapper 先探真身可 exec 则 exec，否则走桥模式或明确降级（`exit 126`，附人话原因） | `main.js:2045-2187` |
| git 的子进程类子命令 | 见下（平台 libc 缺能力，不是 git 用法错） | `main.js:2109-2160` + `libdshm-gitcompat.so` |

**git 那一层值得单独看**，因为它是"平台缺能力，但不必重编"的范例：
`clone/fetch/pull/push` 一律 `rc=134`（SIGABRT），原文
`BUG: run-command.c:525: disabling cancellation: Operation not permitted`。
根因是 `run-command.c` 的 `atfork_prepare()` 用 `CHECK_BUG()` 包了
`pthread_setcancelstate(PTHREAD_CANCEL_DISABLE)` —— `CHECK_BUG` 的语义是"**这个调用不该失败**"，
失败即 `BUG()`（abort）。而**鸿蒙 musl 缺取消点控制**，该调用返回 EPERM。
**不是 git 用法错**（`docs/70:127-159`）。
修法是 **LD_PRELOAD 垫片**（`entry/src/main/cpp/gitcompat.c` → `libdshm-gitcompat.so`），
口径是**透明优先**：先调 libc 真身、真身成功就原样成功，只在真身缺失或返回非 0 时才改判成功
⇒ 在真 Linux 上完全透明，不掩盖真实错误。
**为什么不是重编 git**：git 是动态链接的 PIE，`DT_NEEDED libc.musl-aarch64.so.1`（用**系统** musl，
我们没随包带 libc）⇒ 重编要配整套 Alpine musl 交叉工具链，且产物还要再过一次签名域
（`docs/70:148-149`）。
**第二层（修好第一层后才浮现）**：垫片生效后 stderr 变成 `git-upload-pack: inaccessible or not found`
—— `usr/libexec/git-core/` 下 **141 个 symlink** 在 hmfs 上解不出来。修法是从本版 git 的 apk 归档
**现读 symlink 表**（纯 JS 扫 tar 头，不解包），按需以真身拷贝补齐
（`main.js:1909-1949`；`docs/70:150-155`）。**硬编码的清单会在升级时静默失效**是本项目的既有教训
（`docs/70:780-783`）。

**路 3 —— 进程内 dlopen 桥（平台根本不给 execve 的场景）。**

沙箱 `dlopen` 与 `execve` 是**两条不同的门**：运行时解包到沙箱的原生库 `dlopen` 被拦
（`Error loading shared library …: No error information`，E39④，`docs/50:127`），
而放在 HAP `libs/` 里的**不拦**（E18 已证，**即使没有 `.codesign` 也能加载**，`docs/50:104`）。
于是本项目把"原生能力"整体搬进 HAP `libs/`，用进程内加载替代起进程：

- **内嵌 CPython 桥**：`tools/place-toolchain.mjs:329-343` 把 `libpython3.12.so.1.0` 从 python 归档
  直接解出写进 `entry/libs/arm64-v8a/`（字节取自归档，不额外维护副本）；
  `entry/src/main/cpp/python_runner.cpp` 编成 `libpython_runner.so`，
  运行时 `process.dlopen` 它，再由它 `dlopen` libpython（**必须是 el1 的 libs 路径**：
  resfile 与 el2 `files/` 实测**不可 dlopen**，`python_runner.cpp:12-18`）。
  ⇒ `bin/python3.12` 永远起不来，但解释器本体已经在我们的进程里。
- **原生 npm 件**（koffi / node-pty / sharp）：放 HAP `libs/`，并在入口脚本里做**重定向**
  （见 §4 选型表第 5 行）。

#### 2.2.3 这条约束的"判决性验收锚点"

端侧每次启动都会自动跑一次 `exec 探测`：`main.js:3078-3131` 是七目标清单，
`:3142-3173` 是 `ensureExecutables()`（`:3170` 汇总结果、`:3172` 打出那一行），
**只探测不再修复**——E1–E19 的实验矩阵已拆除。
其中一个目标是 `git ls-remote file://<本地裸仓库>`：它会走 `start_command()`
（即那两处 `CHECK_BUG`），但**不需要网络**，是最小、可重复、不受外部服务波动影响的判据。

```bash
# 期望（签名齐全 + 垫片就位）：7/7
python3.12=ok，git=ok，git-core/git=ok，git-remote-http=ok，rg=ok，bash=ok，git-ls-remote=ok
# 真机取法
hdc shell "grep -E 'exec 探测：' /data/app/el2/100/base/com.dshm.dshclient/haps/entry/files/dshm-host.log | tail -1"
```

（读数出处在 `docs/80-真机更新与数据保全.md:126-127`、`dist/sideload/README.md:78`；
签名前的 2/7 与签名后的 7/7 对照在 `docs/device-validation.md:4340-4343`）

### 2.3 由两条约束推出的"能跑 ≠ 跑通"

**很多设计是"看起来能跑但语义不对"**，因为端侧工具链是
"起进程 → 找辅助程序 → 连远端 → 认证"这样的长链，**每一环**都可能被 §2.1/§2.2 波及
（`docs/70:48-51` §0.3、`:769-778` §8.8）。三个已实证的例子：

| 现象 | 看起来像 | 实际是 |
|---|---|---|
| `web_search` 正常、`web_fetch` 打不开任何网页 | "网络问题" | 两条路走的是**不同的** HTTP 实现（前者全局 fetch 垫片，后者 `import("undici")`） |
| `pnpm add` 报"缺少 DSH_HOME"（比 127 前进了一层） | "PATH 没配" | bash 子进程的 env 是**白名单构造**，`process.env.DSH_HOME` 两头都不沾（`docs/70:175-194`） |
| `pip3 --version` exit 0 但没有 pip 版本号 | "pip 坏了" | `-V|--version` **快速分支**绕过了 `pipMode`；pip 本体无恙（`docs/70:541-548`） |

**通用教训**：**版本探测 ≠ 功能路径探测**；凡"某功能整条链不可用"，
先把链上**每一步**都列出来逐层验（`docs/70:793-800`）。

---

## 3. 整体架构

### 3.1 五层（一个进程内的五个角色）

```text
┌─ HAP：com.dshm.dshclient ──────────────────────────────────────────────────┐
│                                                                            │
│  ① ArkTS 壳（原生）                    entry/src/main/ets/**               │
│     · EntryAbility  起 Host、写 AppStorage 的「本次启动 URL」               │
│       (entryability/EntryAbility.ets:386-387, 453, 505)                    │
│     · NodeRuntime   载体实现：调原生模块 + 轮询回环端口                     │
│       (runtime/NodeRuntime.ets)                                            │
│     · 页面：pages/WebApp（默认主页）/ pages/Index（原生壳，回退）/ Poc1      │
│     · HAR：appstate（状态与投影）/ connection（连接）/                      │
│            dshcompat（**上游知识的唯一落点**）/ platform（系统能力）/        │
│            hostruntime（核心仓库 + 载体契约 + DshHost 状态机）              │
│                                                                            │
│  ② ArkWeb（官方 Web UI）              pages/WebApp.ets:1971-2019           │
│     加载 http://127.0.0.1:3120/?token=…（带 token 的完整启动 URL）           │
│     桥：javaScriptProxy 聚合对象 __DSHM_BRIDGES__（**一次注册**）           │
│        + javaScriptOnDocumentStart 垫片（目录选择 / 外观跟随）              │
│     权限：onPermissionRequest 只对**回环来源**放行 AUDIO_CAPTURE（:2064）   │
│           ——**不挂该回调 = 一律被拒**，网页只会拿到 NotAllowedError         │
│                                                                            │
│  ③ hostcore（Node 宿主脚本，跑在 libnode 里）  hostcore/app/**             │
│     main.js 4204 行：诊断 / 垫片 / 重定向 / exec 探测 / 工具链 / Python 桥   │
│     + fetch-shim.js · undici-shim.mjs · undici-loader.mjs                  │
│     + require-builtin-shim.cjs · dshm-installer.js · dshm-user-rows.js     │
│     + dshm-skills.js（内容哈希同步）· dshm-compat.js（兼容性豁免）          │
│                                                                            │
│  ④ dsh 核心树（按版本可切换）    <filesDir>/dsh/cores/<ver>/                │
│     由 resfile/dsh-core-<ver>-openharmony-arm64.zip 首启解包（zip 容器）     │
│     $DSH_HOME = <filesDir>/dsh/home（**跨版本共享的唯一一份用户数据**）      │
│                                                                            │
│  ⑤ 工具链与原生件                                                          │
│     · HAP libs/arm64-v8a/*.so（59 个：运行时、koffi、flock、python、语音…）  │
│     · resfile/toolchain/{python,git}（归档 + **构建期自签名**）             │
│     · resfile/busybox、resfile/ohos-skills                                 │
└────────────────────────────────────────────────────────────────────────────┘

进程内 loopback（不跨隔离边界）：
  ③ 起 Host → 监听 127.0.0.1:3120 → 把带 token 的 URL 写 $DSH_HOME/host-ready.json
  ① 读该文件（做 pid 校验）→ 写 AppStorage → ② 用它加载官方 Web UI
```

**为什么全部塞进同一个进程**：鸿蒙手机**禁止三方应用 fork/创建进程**
（`childProcessManager` 仅平板/PC-2in1，`docs/50:101` E15）。更硬的一条实测是
**`fork` 不只是返回错误而是触发 native crash**：`koffi` 直调 `libc fork()` 后进程死亡，
appspawn 侧日志 `SetForkDenied success, cgroup's owner:<pid>`
（`main.js:809-816`；两次 `cppcrash` 记录）。所以 `libnode.so` + NAPI 引导是**四条形态
唯一共同可行的路径**（`dshhost.cc:8-10`）。同进程还带来一个安全语义上的简化：
Host 与客户端走回环，不需要绑 `0.0.0.0`、不需要伪造 `Host`/`Origin`
（`README.md`、`docs/50:75-79`）——这正是与社区 Electron-on-鸿蒙方案的**结构性差别**。

### 3.2 两个存储域（判据不可混淆）

| 域 | 内容 | 覆盖安装后 | 判据 |
|---|---|---|---|
| `el1`（`/data/storage/el1/bundle/…`） | `libs/*.so`、核心 zip、工具链归档、入口脚本、ArkTS 字节码 | **被替换** | 代码与资源，**可换** |
| `el2`（`/data/app/el2/100/base/<bundle>/haps/entry/files/…`） | `dsh/home`（会话/插件/凭据/工作区）、`dsh/cores`、`toolchain`、`workspace`、`bin` | **保留** | **用户数据，不可删** |

**纪律**：一律 `hdc install -r <hap>`，**禁止** `hdc uninstall`。唯一例外是换签名导致覆盖安装失败时的
`hdc uninstall -k <bundle>`，且卸载后**立即验证数据仍在**。这条纪律的起因是一次真实事故：
一次排障中的裸 `hdc uninstall` 删掉了 **6 个会话、7 个插件、2 个工作区**，
系统备份为空、**不可恢复**（`AGENTS.md`、`docs/80-真机更新与数据保全.md:8-46`）。
唯一允许的装机入口是 `tools/update-device.ps1`（它第 0 步会**自检脚本自身不含卸载调用**，
`tools/update-device.ps1:46-70`）。

### 3.3 启动链（一眼版）

```text
aa start
  └─ EntryAbility.onCreate → new NodeRuntime(<resourceDir>/resources/app/main.js, filesDir)
       new DshHost(filesDir, runtime) → host.start()
         └─ dshhost.startHost(argv, envPairs)          ← 原生引导（NAPI）
              setenv(DSHM_*) 必须在 node::Start **之前**（Node 启动即读 process.env）
              构造器里：dladdr 问出自身路径 → 同目录 libnode.so.137 以 RTLD_GLOBAL 首载
                       → dlsym("_ZN4node5StartEiPPc")  ← 为什么不是 DT_NEEDED 见 §4
              node::Start(--jitless --experimental-sqlite --expose-internals <main.js>)
                └─ main.js: BOOT_00 → … → BOOT_70（阶段标记打在 stdout → node-output.log）
                     ⑥端口绑定 ⑦写 host-ready.json（带 token 与 pid）
  └─ WebApp 页读 AppStorage 的「本次启动 URL」→ Web 组件加载官方 Web UI → 200
```

`BOOT_*` 与 `DSHM_READY` 打在 **`node-output.log`**，而 `diag()` 打在 **`dshm-host.log`** ——
**两个文件都要拉**，只看后者会误判成"宿主从未就绪"（`docs/70:1086`、`:1090`）。

---

## 4. 关键技术选型表（只写有依据的）

| # | 选项 | 选了什么 | 为什么（否决了什么） | 证据 |
|---|---|---|---|---|
| 1 | JS 运行时 | **自建 `libnode.so.137`**（Node 24.2.0），`--jitless` 运行 | 华为侧 Electron 产物**要账号、无公开 URL**，且其 V8 **带 JIT**、子进程方案依赖 JIT ⇒ 与"不申请特殊权限"直接冲突。自建源在自己手里，且是唯一能天然满足 jitless 的形态 | `tools/node-runtime/README.md:4-6`、`docs/50:139` E49、`:564-568` §4.4 |
| 2 | 运行时载体 | **同进程 `libnode` + NAPI 引导**（`libdshhost.so`） | 手机**禁止三方应用创建进程**（E15），且实测 `fork` 直接 native crash ⇒ 独立进程 / HNP 子进程在手机上不成立 | `dshhost.cc:8-10`、`main.js:809-816`、`docs/50:101` |
| 3 | 界面 | **ArkWeb 加载官方 Web UI 为默认主页**；ArkTS 原生壳保留为回退页 | 官方 UI 是 41 个客户端插件包拼成的，逐包复刻要无限追上游；Web UI 路线下上游新增面板/按钮自动获得 | `entryability/EntryAbility.ets:503-505`、`main_pages.json`、`docs/50:1014-1018`（并见 §1.2 的"文档与实现不一致"登记） |
| 4 | 核心树分发 | **zip 容器**（自建 zip 写入器） | 鸿蒙侧只有 `@ohos.zlib.decompressFile`（zip），**没有 tar/gzip 等价 API** ⇒ 用 zip 只调一个系统 API，避免在 ArkTS 里手写 tar 解析 + gzip 解压；且固定时间戳 ⇒ 同输入产出逐字节相同的包 | `hostcore/README.md:42-43`、`docs/50:550` R5 |
| 5 | 原生 npm 件投放 | **HAP `libs/` + 入口脚本重定向**，不放沙箱解包 | 沙箱 `dlopen` 被系统拦（E39④），HAP `libs/` 不拦（E18）。hvigor **只打包扁平的 `libs/<abi>/*.so`**（嵌套 `.node` 不进产物）⇒ 同时接管 `fs.existsSync`、`Module._extensions['.node']`、`Module._resolveFilename`（裸相对路径的 `.node` 请求在 `_findPath` 阶段就 MODULE_NOT_FOUND），命名约定 `lib<stem>.so`。**副作用**：原生部分与应用版本绑定 ⇒ "核心版本切换"只能切纯 JS 部分 | `main.js:240-332`、`docs/50:127-128` E39④/E40、`docs/70:59-73` |
| 6 | 原生件编译方式 | **hvigor 的 CMake 路径**（`entry/src/main/cpp/CMakeLists.txt`） | **手工把编好的 `.so` 拷进 `entry/libs/` 绑不上**：同一进程相隔几毫秒并列对照 —— CMake 版返回 `dshm-probe-ok`，手工版 `runtimeVersion is undefined`（导出键全是 ArkUI 节点 API）。五轮排查的结论 | `CMakeLists.txt:11-19`、`docs/50:116` E30、`:119` E31 |
| 7 | 工具链 | **归档随包 + 构建期自签名**，端侧解包 | execve 受签名域管辖（§2.2）⇒ 不签就跑不了；归档原样带 symlink 元数据进 HAP，端侧解包失败仅告警跳过，真身 ELF 全在 | `tools/place-toolchain.mjs:1-21`、`:37-61`、`tools/sign-tar-elf.py` |
| 8 | 插件安装 | **进程内纯 JS 安装器**（HTTPS 拉 tarball + `zlib.gunzipSync` + 纯 JS ustar 解包） | 端侧没有 pnpm/npm/git，也没有独立 node 可执行文件；spawn 在端侧始终带平台级不确定性（执行位/权限策略），纯 JS 是零依赖的确定性路径 | `hostcore/app/dshm-installer.js:1-33`、`docs/70:370-394` |
| 9 | 语音模型存放 | **沙箱目录（启动后在线下载）**，不放 HAP `rawfile` | 模型 228 MB 量级，放 rawfile 会让 HAP 暴涨；而 sherpa-onnx 的鸿蒙实现**不传 `resourceManager` 时走通用文件路径**（源码级确认：`use_resource_manager` 为假时调 `SherpaOnnxCreateOfflineRecognizer`），⇒ 沙箱绝对路径可行。**当前 `entry/src/main/resources/rawfile/` 实测为空（0 个文件）** | `docs/device-validation.md:3413-3415`、`:3487-3508`；`entry/src/main/ets/speech/SenseVoiceRecognizer.ets:64-73,90,124` |
| 10 | 语音识别后端 | **sherpa-onnx 端侧离线**（`sherpa_onnx@1.13.3` HAR） | HMS `speechRecognizer` 是**流式听写引擎**，单会话只处理**开头 4~5 秒**且端点检测不可关（七轮真机实测）⇒ 长语音此路线无法稳定实现。sherpa-onnx **官方已有鸿蒙移植**（源码内置 6 个示例、官方 `build-ohos-arm64-v8a.sh`、预编译件零 glibc 依赖） | `docs/70:892-946`、`:976-987` |
| 11 | 权限面 | **10 项普通权限，不申请任何 ACL 特殊权限** | 需 JIT 的方案一律不进入选型，以保证可正常上架；代价（WASM 不可用）由 §2.1.4 的两层垫片吸收 | `README.md`、`module.json5:17-119`、`tools/check-store-readiness.mjs`（本机 PASS） |
| 12 | 其它 JS 引擎（QuickJS / Hermes / Bun / Deno 等） | **无选型记录** | `README.md`、`AGENTS.md`、`docs/*.md` 全库检索 `QuickJS`/`Hermes`/`JerryScript`/`Bun`/`Deno` **零命中**（唯一的 `quickjs` 命中在**上游核心树**里：`dsh-client-ui-sidebar-documentpreview` 的 pdf.js 自带一个 **WASM 版** QuickJS 沙箱，与运行时选型无关，而且在 `--jitless` 下必然不可用 —— 顺带印证约束一）。⇒ **不作论断**：不是评估后否决，而是从未进入候选 | `grep -rn "QuickJS\|Hermes\|JerryScript" README.md AGENTS.md docs/` → 0；核心树命中见 `dist/core/work/dsh-core-0.2.0-rc.1/node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js` |

---

## 5. 本章验证命令（可复跑）

```bash
# ── 约束一：jitless ⇒ 无 WASM（本机即可，与设备同结论）──────────────────
node -e "console.log(typeof WebAssembly)"             # object
node --jitless -e "console.log(typeof WebAssembly)"   # undefined
grep -n "'--jitless'" hostruntime/src/main/ets/runtime/RuntimePort.ets
node tools/check-store-readiness.mjs                  # 上架红线（含 --jitless 必须在 argv）

# ── 约束一：两层垫片覆盖率（自带双臂对照，需 Node 22 跑）────────────────
node tools/check-web-fetch-jitless.mjs

# ── 约束二：签名域与"构建期自签名"───────────────────────────────────────
node tools/check-toolchain-sign.mjs                   # 实跑：python/git 标记与归档大小自洽 ✓
# 独立复核：归档里的 ELF 是否真的带 .codesign（不依赖自家门禁；脚本落到临时文件再跑）
cat > /tmp/dshm_sign_check.py <<'PY'
import glob, tarfile
tot = sig = 0
paths = sorted(glob.glob('entry/src/main/resources/resfile/toolchain/git/*.apk'))
paths += ['entry/src/main/resources/resfile/toolchain/python/cpython-3.12.14-aarch64-musl.tar.gz']
for p in paths:
    with tarfile.open(p, 'r:*') as t:
        for m in t:
            if not m.isfile():
                continue
            f = t.extractfile(m)
            if f is None or f.read(4) != b'\x7fELF':
                continue
            tot += 1
            if b'.codesign' in f.read():
                sig += 1
print('ELF 总数=%d 已签=%d' % (tot, sig))
PY
python /tmp/dshm_sign_check.py     # 本机实跑：ELF 总数=37 已签=37（git 15 个 apk 共 27 + python 10）
# 单个文件的快速判据（busybox 属入库资产，见 §2.2.2 第 1 条）
python -c "d=open('entry/src/main/resources/resfile/busybox/busybox','rb').read();print(len(d), b'.codesign' in d)"
# HAP 内 libs 是否被签名（预期：全部 False —— dlopen 不需要签名，只有 execve 需要）
python -c "import zipfile;z=zipfile.ZipFile('entry/build/default/outputs/default/entry-default-signed.hap');\
print([ (n, b'.codesign' in z.read(n)) for n in ['libs/arm64-v8a/libnode.so.137','libs/arm64-v8a/libkoffi.so'] ])"

# ── 宿主侧结构性门禁（AGENTS.md 必跑链 + 断言计数）─────────────────────
node tools/assert-cli-shim.mjs            # 实跑：40 项
node tools/assert-resfile-sync.mjs        # 实跑：13 件快照同步（2026-10-05 复核）
node tools/assert-exec-fix.mjs            # 实跑：35 项
node tools/assert-python-bridge.mjs       # 实跑：69 项
node tools/assert-fs-search-fallback.mjs  # 实跑：58 通过 / 0 失败（2026-10-05 复核）
node tools/check-native-closure.mjs       # 实跑：PASS
node tools/check-parity.mjs               # 实跑：通过
node tools/compat-drift.mjs               # 实跑：140/140 无漂移（核心 0.2.0-rc.2）

# ── 真机（只覆盖安装，永不卸载）─────────────────────────────────────────
.\tools\update-device.ps1 -SkipRebuild
F=/data/app/el2/100/base/com.dshm.dshclient/haps/entry/files
hdc file recv $F/node-output.log ./node-output.log && grep -E "BOOT_00|DSHM_READY" node-output.log
hdc file recv $F/dshm-host.log   ./dshm-host.log   && grep -E "exec 探测|归档已换代|标记" dshm-host.log | tail
```

---

## 6. 交接时必须知道的三处"文档与实物不一致"（本章新增记录）

写在这里，是因为它们都属于"照着文档推断会得出错误结论"的那一类，且都可复跑核验。

### 6.1 `libnode.so.137` 的 Node 版本：二进制说 24.2.0，注释说 26.7.0

- 二进制自述：`entry/libs/arm64-v8a/libnode.so.137` 内含字符串
  `v24.2.0-openharmony-arm64`、`node-v24.2.0.tar.gz`、`v24.2.0-headers.tar.gz`；
- 真机自述：`BOOT_00` 打的 `process.version` 是 **`node=v24.2.0`**
  （`docs/device-validation.md:951`）；
- 而仓库里三处注释把 `.137` 写成 **26.x**：`entry/build-profile.json5:18`、
  `entry/src/main/cpp/CMakeLists.txt:104`、`hostruntime/src/main/cpp/dshhost.cc:483-489`。

⇒ **soname 后缀不能按注释推断**。当前唯一可靠的对应关系只能从二进制里读
（`strings` / 字节扫描，见 §5 的命令）；改 Node 版本时 `CMakeLists.txt:108` 的候选列表
（`libnode.so.137 / .127 / .so`）本就是为了避免写死。

**另一处同源现象**：`libdshhost.so` 由 `node-headers/` 编译，其中 `node_version.h:25-27`
是 `26.7.0`（`CMakeLists.txt:6` 的注释也印证"换到 26.7.0 的头文件"），
所以 `runtimeVersion()` 报的是**编译期头文件版本**（本机字节扫描：该 `.so` 里 `2x.y.z` 形态的串
只有一个 `26.7.0`，另有编译器版本 `15.0.4`），
而 `process.version` 报的是**运行中运行时的版本**（24.2.0）。两者在同一台设备上**不一致**。
`DshHost.mergeRuntimeFacts()` 让原生模块的读数优先
（`hostruntime/src/main/ets/runtime/DshHost.ets:216-218`），
⇒ **核心页"Node 运行时"一行显示的可能不是设备的真实运行版本**。

> **未验证**：本章没有真机核对核心页那一行（无设备在此环境）。核验方法是同时取
> `node-output.log` 的 `BOOT_00`（应含 `node=v24.2.0`）与核心页的"Node 运行时"读数，两者比对。

### 6.2 `docs/00` 说 ArkWeb 只作"可选第二页面"，实现把它作成了默认主页

见 §1.2 末的登记（证据：`EntryAbility.ets:503-505`、`main_pages.json:2-5`）。

### 6.3 `docs/70` 的 HAP 体积表停在旧时点

`docs/70:331-337`（§3.6 "HAP 体积的两次大回收"）把末行写成"现状 **277 MB**"，
而当前构建产物实测（核心 0.2.0-rc.2）
`entry/build/default/outputs/default/entry-default-signed.hap` = **314,166,762 B**
（= 299.62 MiB / 314.17 MB；核心 0.2.0-rc.1 时为 314,673,276 B = 300.10 MiB）。
差额来自 rc.1 → rc.2 的核心树变化（78,705,318 → 78,081,448 B，−623,870 B）与 libvips 家族从
46 件减为 45 件（−121,328 B）。⇒ 引用体积时**以实测为准**，不要引用那张表的末行。

---

## 7. 与相邻章节的分工

> **历史说明（2026-09-28 补）**：本文档合并自三份分章草稿——`A-总览与根本约束.md`、
> `C-端侧运行时.md`、`E-验收运维与踩坑总表.md`。合并后它们分别是本文档的
> **第一章**「总览与两个根本约束」、**第三章**「端侧运行时：HAP 里有什么、启动时发生什么」、
> **第五章**「真机验收、运维与踩坑总表」。`docs/90-staging/` 这个目录
> **从未入库**（`git log --all -- docs/90-staging` 为空），因此正文里任何
> `docs/90-staging/…` 形态的旧引用都按上面的对应关系解读为本文档的章。

| 章 | 覆盖 |
|---|---|
| **第一章**（本节所在） | 项目是什么、**两个根本约束**（含"构建期自签名"整套与 E-TS2）、整体架构、选型表、文档与实物不一致 |
| **第三章** | HAP 目录布局与职责、首启解包与 `.dshm-bundled-stamp`、`BOOT_00→70` 逐阶段、argv/env 契约、`hostcore/app` 补丁清单、沙箱布局、网络与端口 |
| **第五章** | 真机数据保全、验收流程与门禁清单、诊断手段、按主题的踩坑索引 |

**读法建议**：第一章给"为什么必须这样"，第三章给"具体长什么样、怎么起来的"，
第五章给"怎么安全地送上去、怎么判定真的生效了"。三者冲突时，
以代码与实测读数为准，并在本节第 6 条的模式下**登记差异**。

---

# 第二章 构建流水线：从上游素材到可装 HAP

## 0. 本章的范围：从"素材"到"侧载包"的九步

本章覆盖**构建流水线**——从 `third_party/` 里的原始素材，到一个可以 `hdc install -r` 的签名 HAP，
再到 `dist/sideload/` 的交付包。端侧运行期行为（Host 如何起、垫片如何接管）不在这里，见 D6。

命令与顺序**以 `README.md`「构建」一节（README.md:81-121）为准**，
本节把每一步补上"输入 / 输出 / 为什么必须这么做 / 失败会怎样"，并给出可复跑的验证。

```text
third_party/  ─┬─► ① tools/pack-core.mjs --skip-install --place-in-app   → resfile/dsh-core-<ver>-openharmony-arm64.zip
               ├─► ② tools/place-host-app.mjs                            → resfile/resources/app/*
               ├─► ③ tools/place-toolchain.mjs                           → resfile/toolchain/{python,git}/ + entry/libs/libpython3.12.so.1.0
               ├─► ④ tools/gen-fish-logo.mjs                             → resources/base/media/fish_logo.svg
               └─► ⑤ python tools/make-icon.py                           → AppScope + entry 的 APP 图标
                                                                          ↓
                                                     ⑥ hvigor assembleHap（含 CompileArkTS / CMake / strip / SignHap）
                                                                          ↓
                                        ⑦ entry/build/default/outputs/default/entry-default-signed.hap
                                                                          ↓
                                                     ⑧ dist/sideload/（README + SHA256SUMS + HAP）
```

一个必须记住的结构性事实：**①②③④⑤ 的产物全部落在 `entry/src/main/resources/` 与 `entry/libs/` 下，
它们都是 `.gitignore` 里的生成物**（`.gitignore:31-45`）。进版本库的是**生成方法**，不是字节。
所以"新克隆编不过"最常见的原因不是代码问题，而是这五步没跑。

---

## 1. 步骤 0：前置素材

### 1.1 入库 / 不入库的边界

| 类别 | 路径 | 是否入库 | 谁生产 |
|---|---|---|---|
| 配方与源脚本 | `hostcore/core-recipe.json`、`hostcore/app/*`、`hostcore/profile/ondevice/*`、`tools/*` | **入库** | 人 |
| 核心树 zip | `entry/src/main/resources/resfile/dsh-core-*.zip` | 否（`.gitignore:35`） | `pack-core.mjs` |
| 入口脚本快照 | `entry/src/main/resources/resfile/resources/app/` | 否（`.gitignore:39`） | `place-host-app.mjs` |
| 工具链归档 | `entry/src/main/resources/resfile/toolchain/` | 否（`.gitignore:37`） | `place-toolchain.mjs` |
| Node 头文件 | `entry/src/main/cpp/node-headers/` | 否（`.gitignore:43`） | `tools/node-runtime/sync-node-headers.sh` |
| 原生库 | `entry/libs/` | 否（`.gitignore:45`） | 自建 Node / `collect-libvips.mjs` / CMake |
| 第三方原始素材 | `third_party/` | 否（`.gitignore:31`） | 手工取得 |

### 1.2 `third_party/` 里必须备齐什么

按本机实测的清点（`Get-ChildItem third_party -Recurse`）：

| 素材 | 本机实测 | 谁消费 | 缺了会怎样 |
|---|---|---|---|
| `python/cpython-3.12.14-aarch64-musl-install_only_stripped.tar.gz` | 28,594,621 B | `place-toolchain.mjs:144-149` | **`exit 1`**，脚本明确给出 `curl` 取法 |
| `git/apks/*.apk`（15 个，Alpine v3.21 main aarch64：`git-2.47.3-r0` + so 闭包 + `ca-certificates-bundle`） | 15 个文件 | `place-toolchain.mjs:153-158` | **`exit 1`**（目录里没有 `.apk` 即失败） |
| `sherpa_onnx-1.13.3.har` | 6,673,132 B | `entry/oh-package.json5:10` 以 `file:` 依赖引入 | ohpm 装不上，ArkTS 编译失败 |
| `sherpa_onnx-1.13.3.har.bak` | 14,680,645 B | **不消费**，是裁剪前的正本备份 | 无影响；它的存在本身就是证据（见 §1.4） |
| `koffi/koffi-3.2.1.tgz`、`koffi/package/`、`koffi/trampolines/` | 见目录 | `pack-core.mjs` 的 `replaceKoffiJs()`（1342）与 `entry/src/main/cpp/CMakeLists.txt:127` | koffi JS 层替换 `die`，或 `libkoffi.so` 编不出来 |
| `ripgrep/vscode-ripgrep-linux-arm64-1.18.0.tgz` | 2,095,071 B | `pack-core.mjs:874` | 不存在时**自动 `npm pack`**（唯一联网点），失败则 `die` |
| `brand-original/{startIcon.png,logo_dark.png}` | 各 15,246 B | `make-icon.py:432-448` 与 `check-icon-assets.mjs:25-28` | 启动画面守卫退化为"跳过内容校验"（`make-icon.py:436-437`）；不会静默改错 |
| Node 头文件源 | 不在 `third_party/`，由 `tools/node-runtime/sync-node-headers.sh` 从 Node 源码树同步 | CMake 编 `libdshhost` / `koffi` / `flock` / `python_runner` | 编不过（`CMakeLists.txt:36-38` 的 include 路径为空） |
| 原生库 | 同上，`entry/libs/<abi>/`（含 `libnode.so.137`） | CMake 链接 + HAP 打包 | koffi/flock/python_runner **被跳过**（`CMakeLists.txt:123-125`、`:222`），得到"能装、缺能力"的包 |

### 1.3 关于 Node 版本：soname 后缀与"版本号"不能相互推断

项目文档里到处写着 `libnode.so.127`，**但当前 `entry/libs/arm64-v8a/` 下是 `libnode.so.137`**
（126,809,264 B）。**但"是 .137"并不等于"是 Node 26.7.0"**——本机实测三者不一致：

| 事实源 | 读数 | 证据 |
|---|---|---|
| **运行期二进制** `libnode.so.137` | **`v24.2.0-openharmony-arm64`** | 字节扫描：`entry/libs/arm64-v8a/libnode.so.137` 内含 `v24.2.0-openharmony-arm64`、`node-v24.2.0.tar.gz`、`v24.2.0-headers.tar.gz` |
| **编译期头文件** `node-headers/` | **`26.7.0`**（`NODE_MODULE_VERSION` 默认 **147**） | `entry/src/main/cpp/node-headers/src/node_version.h:25-27` |
| **注释/文档** | 多处写成 `26.x` | `entry/build-profile.json5:17-20`、`entry/src/main/cpp/CMakeLists.txt:6`、`hostruntime/src/main/cpp/dshhost.cc:483-488` |

```bash
# 唯一可靠的读法：直接问二进制（不要按注释推断）
python -c "
import re
b=open(r'entry/libs/arm64-v8a/libnode.so.137','rb').read()
print(sorted({m.group(0).decode() for m in re.finditer(rb'v\d+\.\d+\.\d+-openharmony-arm64', b)}))
"
# 实测 → ['v24.2.0-openharmony-arm64']
```

**这条对构建的实际影响**：`libdshhost.so` 由 `node-headers/` 编译，所以它自述的
`runtimeVersion()` 是**编译期头文件版本**（26.7.0），而运行中的 `libnode` 是 24.2.0
（`docs/90:623-646`（§6.1）记录了这条不一致的完整证据链与
它对核心页那一行的后果——那一节另有"未验证：无设备在此环境"的如实标注）。
构建侧只需要记住：**头文件与 libnode 是两套版本号，改任一方时不要用另一方的数字做判据。**

CMake 已按 soname **候选列表**探测而不是写死
（`entry/src/main/cpp/CMakeLists.txt` 里三组各自独立的候选循环：
`koffi` 用 :108、`system`(flock) 用 :189、`python_runner` 用 :216，
三处都是 `foreach(cand libnode.so.137 libnode.so.127 libnode.so)`），
`dshhost.cc:487-490` 的 `kLibnodeCandidates[]` 同源。
⇒ **换 Node 版本时不必改这些代码**；但也不要因为"文件名是 .137"就以为跑的是 26.x。

### 1.4 `har.bak` 与 x86_64 裁剪之间的因果

`sherpa_onnx-1.13.3.har` 的 `libs/` 下**只剩 `arm64-v8a`**（4 个文件 / 18,616,448 B），
而 `.bak` 里是 **8 个 / 40,013,528 B**（多一份 `x86_64`：4 个文件 / 21,397,080 B = 20.41 MiB）。

```text
package/libs/x86_64/libc++_shared.so              1,294,568
package/libs/x86_64/libonnxruntime.so            15,011,792
package/libs/x86_64/libsherpa-onnx-c-api.so       4,308,992
package/libs/x86_64/libsherpa_onnx.so               781,728
                                                 ──────────
                                                 21,397,080 B = 20.41 MiB
```

这不是"没清干净"，而是**刻意在源头裁剪**：`entry/build-profile.json5:23` 的
`abiFilters: ["arm64-v8a"]` **管不到 HAR 内自带的 `libs/<abi>`**，
`nativeLib.filter.excludePattern` 也无效 ⇒ 只能改 HAR 本身（解包删 `package/libs/x86_64` 再重打包）。
HAP 体积因此 320.1 → 299.5（`docs/device-validation.md:3756-3760`，那两栏按同文档惯例是 MiB）。
本机复核的 **20.41 MiB** 与该次的 **−20.6** 在四舍五入范围内相符
（HAP 内所有条目都是 stored 不压缩，所以"HAR 内解包量"与"包内字节量"同一个口径；
0.2 MiB 的差来自同一批次的其它改动，未逐项核对）。

> **一个真实的二次陷阱**：`ohpm` **按 lock 判定、不会因为 har 文件变化而重新解包**。
> 改了 HAR 之后必须清 `oh_modules/.ohpm` 里 sherpa 的解包缓存并重跑 `ohpm install`，
> 否则旧缓存会把 `x86_64` 再带回来（同处注释）。
> 本机复核：`oh_modules/.ohpm` 下 sherpa 缓存里 `x86` 命中 **0**（`Get-ChildItem -Recurse | Where-Object FullName -match 'x86'`）。

### 1.5 验证

```powershell
# 素材齐不齐（四类必补输入）
Test-Path third_party/python/cpython-3.12.14-aarch64-musl-install_only_stripped.tar.gz
(Get-ChildItem third_party/git/apks -Filter *.apk).Count          # 期望 15
Test-Path third_party/sherpa_onnx-1.13.3.har
Test-Path entry/src/main/cpp/node-headers/src/node.h              # 头文件已同步
Get-ChildItem entry/libs/arm64-v8a | Measure-Object               # 原生库已就位（本机 49 项）

# HAR 是否已裁掉 x86_64
python -c "import tarfile;t=tarfile.open(r'third_party/sherpa_onnx-1.13.3.har');print(sorted({n.split('/')[1] for n in t.getnames() if n.startswith('package/libs/')}))"
# 期望 ['arm64-v8a']
```

---

## 2. 步骤 1：`node tools/pack-core.mjs --skip-install --place-in-app`

**输入**：`hostcore/core-recipe.json`（配方）、`third_party/`（koffi 包、ripgrep tgz）、
`dist/core/work/dsh-core-<ver>/node_modules`（`--skip-install` 时复用）
**输出**：`dist/core/dsh-core-<ver>-openharmony-arm64.zip` + `dist/core/dsh-core-<ver>.manifest.json`，
并（带 `--place-in-app` 时）复制一份到 `entry/src/main/resources/resfile/`

### 2.1 为什么参数是 `--skip-install`

全流程 `materialize()`（pack-core.mjs:106-134）会跑
`npm install --os=openharmony --cpu=arm64 --ignore-scripts --no-audit --no-fund`。
在 Windows 宿主上按鸿蒙平台物化依赖树，这一步是**分钟级、且要联网**的。

日常改的是**补丁逻辑**（`pack-core.mjs` 里的 `patch*()`），不是依赖树；
`--skip-install` 跳过它、直接在已有 `node_modules` 上重放全部裁剪与补丁（秒级）。

失败条件很明确：`--skip-install` 但 `node_modules` 不存在 ⇒
`die('--skip-install 但 node_modules 不存在')`（pack-core.mjs:111）。

> **为什么产物落在 `dist/` 而不是根 `build/`**：根 `build/` 属于 HarmonyOS 构建器，
> `devecocli build` 会清掉它。实测踩过——`node_modules` 被清空后 `--skip-install` 直接失败
> （pack-core.mjs:44-46 的注释）。这是"目录归置"影响正确性、不只是影响整洁的例子。

### 2.2 执行顺序（顺序本身是知识）

主流程是**显式的一串调用**（pack-core.mjs:3004-3049），不是自动发现的步骤：

```js
materialize();                        // ① 物化
prune();                              // ② 裁掉非鸿蒙二进制
replaceKoffiJs();                     // ③ 把 koffi JS 层换成 3.2.1
const sig = verify();                 // ④ 校验必需原生产物 + .codesign 清单
addPlatformAliases();                 // ⑤ openharmony_arm64 → linux_arm64 / musl_arm64 复制别名
allowOriginList();                    // ⑥ Origin 栅栏接受逗号分隔列表
wrapSharp();                          // ⑦ sharp 换成"调度器 + 真件"
addSystemAddonPackage();              // ⑧ 补 node-addon-system 平台包 + flock 平台门
patchLinkForSandbox();                // ⑨ link(2) → rename
patchCredentialsOwnerCheck();         // ⑩ hmfs 强制 660 ⇒ 凭据权限检查豁免
patchAppBootReadonlyStack();          // ⑪ 只读 message/stack 赋值包 try/catch
patchAgentPresetWorkflow();           // ⑫ 端侧禁 workflow 工具行
patchFsLocalLink();                   // ⑬ fs-local 的 no-clobber 发布
patchAttachmentLocalLink();           // ⑭ attachment-local 的 link + syncDirectory
ensureRipgrepPlatformPackage();       // ⑮ 注入 rg 真二进制
patchFsSearchFallback();              // ⑯ rg 不可 exec 时的 find/grep 降级
addOnDevicePreset();                  // ⑰ 端侧 preset（现在只是如实报告用官方 standard）
embedTreeInfo();                      // ⑱ 写树内 dshm-core.json
verifyTreeInfoContract();             // ⑲ 把 ⑱ 的字段契约钉死
patchSensevoiceForHms();              // ⑳ 语音识别换成 HMS 实现（含语法门禁）
patchVoiceInputNoiseSuppression();    // ㉑ 关降噪
patchVoiceInputNativeCapture();       // ㉒ 官方麦克风按钮改走原生采集
embedProfile();                       // ㉓ 放端侧 profile
const selfSign = selfSignNatives();   // ㉔ 构建期自签名（必须在这里）
const packed = pack();                // ㉕ 打包 zip
const manifest = writeManifest(...);  // ㉖ 写清单
```

**㉔ 的位置是踩坑换来的**（pack-core.mjs:3050-3057）：

> 最初 `selfSignNatives()` 放在 `replaceKoffiJs()` 之后，结果签名被后面的
> `ensureRipgrepPlatformPackage()` 覆盖掉了——**它是"把 rg 重新拷进树"的步骤**，
> 拷进去的是未签名的字节。磁盘上的 rg 又变回未签名，构建全绿，端侧 `rg=denied`。
> ⇒ 规则：**签名必须排在所有"会重写这些文件"的步骤之后、`pack()` 之前。**
> 改这一串顺序时，必须先回答一个问题：**这一步会不会重写要被签名的文件？**
> 会，就要把它排到 `selfSignNatives()` 之前。

### 2.3 补丁机制：为什么必须有它，patch 了哪些东西

**为什么必须有**：这是移植项目的核心矛盾——上游 dsh 是给常驻桌面机写的，
它的若干假设（有 `link(2)`、有硬链接、文件权限可 `chmod`、WebSocket 客户端只附一个 Origin、
平台标识是 `linux`/`darwin`、有 WASM）在 OpenHarmony 沙箱里**逐条为假**。
项目纪律是"**不 fork、不魔改 dsh**"（README.md:332），
端侧差异只通过 dsh 自己的组合面（profile / `cordis.patch.yml` / bundle）表达。
但有几处差异**组合面够不着**（例如 `link(2)` 的调用点在包内部），
于是统一收在 `pack-core.mjs` 里做成**文本补丁**，而不是留一份 fork。

补丁分三类，性质完全不同：

| 类 | 例子 | 幂等判据 | 锚点未命中时 |
|---|---|---|---|
| **替换上游实现** | `allowOriginList`(1183)、`patchLinkForSandbox`(1533)、`patchCredentialsOwnerCheck`(1632)、`patchFsLocalLink`(1851)、`patchAttachmentLocalLink`(1921)、`patchAgentPresetWorkflow`(1681)、`patchAppBootReadonlyStack`(1783) | 文件里带**标记字面量** | **`die`**：`拒绝静默跳过`（如 1227、1599、1652、1902） |
| **注入/追加载荷** | `patchFsSearchFallback`(931)、`patchVoiceInputNativeCapture`(421)、`wrapSharp`(1254)、`replaceKoffiJs`(1342)、`addSystemAddonPackage`(1404) | 注入段带**版本标记**，或看包版本号 | 多数 `die`（933、1067、1103、1118、1360、1363） |
| **只补文件/包** | `addPlatformAliases`(1138)、`ensureRipgrepPlatformPackage`(871)、`embedProfile`(797) | 目标已存在即跳过 | 复制类多半只跳过；`embedProfile` 源目录缺失 **`die`**（800） |

**"锚点未命中就 die"是本项目最值得抄的一条纪律**：静默失败的表现是
"装了没打补丁的旧树而自己全然不知"——构建绿、装机成功、功能少一块，
排查成本远高于打包期直接红。脚本里共 **60 处 `die()`**（去掉注释与函数定义后计数）。

### 2.4 幂等标记：为什么必须新旧都认

`pack-core.mjs` 判"是否已打过补丁"用的是**标记字面量**。这带来一个真事故（E-SV22）：

> 项目从 `HDSH` 改名为 `DSHM`（docs/device-validation.md:3809 批次二十九）。
> 核心树里由**上一版 pack-core** 打过的是 `HDSH_ORIGIN_LIST`。
> 若幂等判定只认新名 `DSHM_ORIGIN_LIST`，就会判成"没打过" ⇒ **重跑替换**，
> 而待替换的片段**已经被换掉了** ⇒ 锚点找不到 ⇒ `die`，整个打包中断。
> 严格性是正确的（正是它暴露了问题），但代价是老树无法增量重打包。

修法是**判定同时接受新旧标记**。代码里现在有 **8 处**双标记判定：

```text
pack-core.mjs:771   DSHM_HMS_PROVIDER            || HDSH_HMS_PROVIDER
pack-core.mjs:1549  DSHM_ORIGIN_LIST             || HDSH_ORIGIN_LIST
pack-core.mjs:1949  DSHM_LINK_SANDBOX            || HDSH_LINK_SANDBOX
pack-core.mjs:2012  DSHM_CREDENTIALS_MODE_EXEMPT || HDSH_CREDENTIALS_MODE_EXEMPT
pack-core.mjs:2073  DSHM_WORKFLOW_DISABLED       || MARK.replace('DSHM_','HDSH_')
pack-core.mjs:2172  DSHM_READONLY_STACK_GUARD    || HDSH_READONLY_STACK_GUARD
pack-core.mjs:2236  DSHM_FS_LOCAL_SANDBOX        || HDSH_FS_LOCAL_SANDBOX
pack-core.mjs:2306  DSHM_ATTACHMENT_SANDBOX      || HDSH_ATTACHMENT_SANDBOX
```

（`docs/70` 的 E-SV22 记的是"同一类共 7 处"，指那一轮批量修的范围；
`HMS_PROVIDER` 那处是另一轮单独修的，代码里现在共 8 处。）

**规矩**：**凡改幂等标记名，必须同时认旧名**，否则老树无法增量重建。
彻底消掉旧名的办法是删 `dist/core/work/<ver>` 重新 `npm install` 物化
（旧标记随上游重新解包而消失）——验证方式是搜旧标记残留数为 0。

### 2.5 `MARK_VERSION`：为什么"存在即跳过"不够

有一类补丁是**在同一处反复迭代**的（如 `patchVoiceInputNativeCapture` 给官方录音注入原生采集覆盖）。
如果幂等判据是"文件里有 `DSHM_NATIVE_CAPTURE` 就整段跳过"，那么
**给注入段新增内容（如 `amplitude` 覆盖）时新版永远注入不进去**，
表现为"改了补丁但设备行为没变"——这类问题排查成本极高（pack-core.mjs:430-438 注释）。

现在的写法是**标记 + 版本**（pack-core.mjs:429/439-453）：

```js
const MARK = 'DSHM_NATIVE_CAPTURE';
const MARK_VERSION = 'v3-permission-window';
const VERSION_TAG = MARK + '@' + MARK_VERSION;
if (text.includes(VERSION_TAG)) { /* 已是最新版，跳过 */ return; }
if (text.includes(MARK)) { /* 旧版：先删掉旧注入段再注入新版 */ }
```

**为什么不删旧段直接注入不行**：会出现两份 `start`/`stop` 覆盖，后者包住前者，行为难预测
（同处注释 436-437）。而删旧段必须**先定位边界**，定位不到就
`die('原生采集补丁：发现旧注入但无法定位其边界，请人工检查 client.js')`（450）。

**结论性规矩**：凡"会出现多个版本的同位注入"，幂等判据必须是版本标记，不能是存在性。
同类做法还有：`wrapSharp` 用 `package.json` 的版本号 `0.0.0-dshm-dispatch` 当标记（1631），
`replaceKoffiJs` 用 `3.2.1 + name === 'koffi' + src/koffi/index.cjs 存在` 三条一起判（1698-1699），
`addSystemAddonPackage` 用 `0.1.2-dshm-shim`（1762）。

### 2.6 打包容器：为什么是 zip

`writeZip()` 是**自己实现的最小 ZIP 写入器**（pack-core.mjs:2796-2897），
不用外部 `zip` 工具、不支持 zip64。理由是**端侧只有 zip 解压 API**：

> 鸿蒙侧只有 `@ohos.zlib.decompressFile`，没有 tar/gzip 的等价物。
> 用 tar.gz 就得在 ArkTS 里手写 tar 解析 + gzip 解压——纯额外风险与代码量
> （pack-core.mjs:2771-2775）。

规模核对（同处）：本机实测 zip **29,351 条目**（`dist/core/dsh-core-0.2.0-rc.2.manifest.json` 的
`package.entries`），< 65535；解包约 241 MB < 4 GB ⇒ **不需要 zip64**。
（`0.2.0-rc.1` 时代为 29,602 条目 / 242.7 MiB，同量级。）

另一个刻意的设计：**zip 条目时间戳固定**（pack-core.mjs:2793-2794，`DOS_TIME`/`DOS_DATE` 写死）。
⚠️ 但这**不等于"包可复现"**：清单与树内元数据都带 `generatedAt`/`builtAt`
（`pack-core.mjs:2958`、`:2700`，值来自 `new Date().toISOString()`），
实测同一配方连跑三次，**条目数与体积恒定、sha256 每次不同**
（`0.2.0-rc.1` 三次：`9279c4d5…` / `b8b48252…` / `67b85c26…`）。
所以"固定时间戳"只保证**同一批文件在同一次运行内的可比性**，不要拿它推断"重跑一次应当同哈希"。
这条对"交付包是否真的等于构建产物"的校验很有用——但要注意
**签名会引入非确定性**：实测对同一个源码归档跑两次 `sign-tar-elf.py`，
产出 sha256 不同（27,719,980 B 相同、哈希不同），因为签名块含时间/随机因子。所以
**"逐字节相等"只适用于整个 HAP 对整段流程的复核，不适用于"重跑一次签名"**。

### 2.7 `--place-in-app`：为什么放 resfile 而不是 rawfile

```js
// 随应用分发：放进 entry 的 resfile（**不是 rawfile**）——resfile 安装后解压到沙箱、
// 可按真实路径只读访问；rawfile 的 fd 不是文件系统 fd，copyFile 会拷坏
// （pack-core.mjs:2922-2923）
```

所以 `--place-in-app` 的复制目标是
`entry/src/main/resources/resfile/dsh-core-<ver>-openharmony-arm64.zip`（pack-core.mjs:2924-2945）。

### 2.8 失败会死在哪些点（关键分组）

60 处 `die()` 里，按"排查时最可能撞上"排：

| 分组 | 代表消息 | 真因方向 |
|---|---|---|
| 物化 | `--skip-install 但 node_modules 不存在`(111)、`找不到 npm`(116)、`npm install 失败`(133) | 没跑过全量 / 网络 / 路径含空格 |
| 裁剪/校验 | `必需原生产物缺失`(329) | `@ohos-ports` 别名没生效、`node_modules` 是桌面形态 |
| 平台包 | `ripgrep 平台包里缺 bin/rg`(893)、`bin/rg 不是 ELF aarch64`(898) | 缓存被污染；**这一条是防串包用的** |
| 上游形态变化 | `Origin 栅栏补丁：上游实现已变化`(1227)、`link 沙箱补丁：上游调用点…`(1603)、`fs-local 补丁：…已变化`(1902) | 升级了 dsh 版本 ⇒ 要去核对锚点，**不是**跳过 |
| 树内清单契约 | `树内清单字段 <k> 不是字符串`(2045)、`missing plugins 数组`(2047) | 改了 `embedTreeInfo()` 的字段名而没同步 `CoreStore.readTreeInfo()` |
| 语音注入 | `语音语法门禁：ESM 解析失败`(684)、`顶层重复声明`(702) | 注入的 provider 是 ESM，`node --check` 按 CJS 解析抓不到——所以要单独门禁 |
| 输入/输出 | `profile 源目录不存在`(800)、`hostcore/speech-models/index.js 不存在`(754) | 仓库不完整 |

### 2.9 验证

```bash
# 1) 重跑打包（幂等，秒级）
node tools/pack-core.mjs --skip-install --place-in-app

# 2) 看清单：版本、体积、条目数、sha256、签名清单
cat dist/core/dsh-core-0.2.0-rc.2.manifest.json

# 3) resfile 里的 zip 与 dist 里的逐字节相同（本机实测同 sha256）
node -e "const c=require('node:crypto'),f=require('node:fs');for(const p of ['dist/core/dsh-core-0.2.0-rc.2-openharmony-arm64.zip','entry/src/main/resources/resfile/dsh-core-0.2.0-rc.2-openharmony-arm64.zip'])console.log(p,c.createHash('sha256').update(f.readFileSync(p)).digest('hex'))"

# 4) 幂等性：连跑两次，第二次的补丁应全部报"已存在（跳过）"
```

本机基线（`dist/core/dsh-core-0.2.0-rc.2.manifest.json`）：

```text
核心版本      0.2.0-rc.2
解包体积      252,069,490 B (240.8 MiB) / 26,066 文件（node_modules 段）
分发包        78,081,448 B (74.46 MiB) / 29,351 条目
sha256        45836d8a34b0b6d40e4d8b3997492b557cc87853c19813e2df4e070173fff3b3
原生          signed 47 / unsigned 1 + selfSign attempted=1 signed=1
```

> **`unsigned 3 → 1` 的变化要说清**：上面 `unsigned 1` 就是清单里那一条
> `koffi/build/koffi/openharmony_arm64/koffi.node`（走 `dlopen`，`dlopen` 通道不要求
> `.codesign`，见下方注）。`0.2.0-rc.1` 时代清单额外记进去的两个
> `@deepseek-ai/node-addon-system-linux-arm64/bin/{glibc,musl}/system.node`，是 `pack-core`
> 自己写的**占位文本**（非 ELF，真身是 HAP `libs/` 里的 `libsystem.so`，见
> `docs/device-validation.md:1984-1991`）；它们在当前清单里不再出现。
> **判据一律看清单内容，不看计数**（下一条正好说明了计数为什么不可靠）。
> ⚠️ **`selfSignNatives()` 不幂等**：`ensureRipgrepPlatformPackage()` 会把未签名的 `rg` 拷回原位，
> 所以"再跑一次 pack-core"会**重新签 1 个**（实测 run2/run3 各签 1/1）。这不是缺陷，
> 但会让"签名数"的比对失去意义——**比对要看 `signed`/`unsigned` 清单内容，不看计数**。

> `koffi.node` 长期在 `unsigned` 清单里**是正常的**：它走 `dlopen`，`dlopen` 通道
> **不要求 `.codesign`**（真机已验证），重签反而有破坏已验证链路的风险。
> `selfSignNatives()` 的目标集刻意只列"真正要被 `exec` 的独立件"
> （包内只有 rg 一个，pack-core.mjs:255-267），最小化爆炸半径。

> ⚠️ **注意有两处自签名，失败策略相反**（这是很容易混的一对）：
>
> | 位置 | 签什么 | 失败策略 |
> |---|---|---|
> | `pack-core.mjs` 的 `selfSignNatives()`（:247-305） | 核心树 zip 内的独立可执行件（只有 `rg`） | **只告警、不 die**（:243-245），但把 `selfSignSkipped` 如实写进清单（:2274） |
> | `place-toolchain.mjs` 的签名段（:218-292） | 工具链归档里的 git / python ELF | **`exit 1`**（E-TS1 的修复），另有逃生阀 |
>
> 两者为何不同，是有理由的：`selfSignNatives` 面对的是"能产出可运行核心树"的整条链——
> 它的注释写明"签名是解锁被平台拒绝的能力的**增量**步骤，不该让整条打包链失败"；
> 而工具链签名的失败意味着 **git/python 真身全废**，且症状只在设备上显现（构建端无任何报错），
> 故必须硬失败。**改动任一处前先想清楚它属于哪一类。**

---

## 3. 步骤 2：`node tools/place-host-app.mjs`

**输入**：`hostcore/app/` 下 7 个文件
**输出**：`entry/src/main/resources/resfile/resources/app/`（7 个文件 + 内联生成的 `package.json`）

### 3.1 为什么必须是"拷贝"而不是软链/引用

鸿蒙侧通过 `resourceDir + /resources/app/main.js` **按真实路径读取**
（resfile 安装后解压到沙箱，可按真实路径只读访问），
所以 HAP 里必须有这几份**真实文件**（place-host-app.mjs:11-13）。

而"入口从 HAP 里消失"是**真实发生过**的事故（docs/70 §3.5）：
入口原先靠 `web_engine` 那个 HAR 的 resfile 合并进 HAP；阶段一 Electron 链整体移除后，
`entry` 不再依赖 `web_engine` ⇒ 入口跟着没了 ⇒ **Host 永远起不来，且构建零报错**。
现在入口改由 `entry` 自己携带，用本脚本同步。

### 3.2 清单里每一个文件都有理由，漏一个的后果都不同

`FILES`（place-host-app.mjs:42）共 7 项，注释（:26-41）逐条写明漏掉的后果：

| 文件 | 漏掉会怎样 |
|---|---|
| `main.js` | 入口本身没了 |
| `fetch-shim.js` | 被 `require('./fetch-shim.js')`：**调模型就走不通**（dsh 调模型用的就是 fetch） |
| `undici-shim.mjs` / `undici-loader.mjs` | **不报错**，只让 `import("undici")` 落回原生 undici ⇒ `WebAssembly is not defined` ⇒ 表现为"web_fetch 打不开任何网页" |
| `require-builtin-shim.cjs` | **Host 直接起不来**（`No usable native binding found for …openharmony-arm64`） |
| `dshm-installer.js` | 插件安装器缺失 |
| `dshm-user-rows.js` | 用户插件行读写缺失 |
| `dshm-skills.js` | **不报错**，只让内置技能退回旧的「字节数判等」⇒ `hdsh-*`→`dshm-*` 这类**等长替换**永远推不下去（P0-1） |
| `dshm-compat.js` | **不报错**，只让兼容性豁免通道失效 ⇒ `.compat-req` 队列被忽略、插件照旧被 0.2.0 跳过（P1-3） |

`dshm-installer.js` 那一行还带着一条**具体教训**（place-host-app.mjs:40-41）：

> 它曾靠 9/21 手工拷贝进 resfile、**不在本清单**——源头修改后 build 仍打旧文件，
> **全程零报错**，装机后表现为"修复不生效"。

⇒ **加文件时必须同时改两处**：本脚本的 `FILES`（place-host-app.mjs:42）与
`tools/assert-resfile-sync.mjs:18-26` 的同名清单。否则门禁不认识新文件、等于没有门禁。
（2026-09-28 新增 `dshm-skills.js` 与 `dshm-compat.js` 时正是照这条做的：两处清单一同扩到 **9 项**。）

### 3.3 `package.json` 是内联生成的，且**刻意不带 `type` 字段**

```js
// package.json 刻意**不带** "type" 字段 ⇒ CommonJS（main.js 里用 require/__dirname）
// place-host-app.mjs:57-58
```

带 `"type": "module"` 会让 `main.js` 里的 `require`/`__dirname` 全炸。
这条约束由 `assert-resfile-sync.mjs:56-66` 的**语义锁**守着
（`pkg.main === 'main.js' && pkg.type === undefined`），而不是靠记住。

### 3.4 验证

```bash
node tools/place-host-app.mjs
node tools/assert-resfile-sync.mjs     # 必须「全部快照同步」（**别写死件数**：清单加文件时它会变，2026-10-05 已是 13 件）

# 源与快照逐字节比对（本机实测 9/9 相同 + package.json 语义锁）
```

本机实测（`assert-resfile-sync.mjs` 输出，2026-09-28）：

```text
ok  ：main.js 一致（208567B）        ok  ：dshm-installer.js 一致（60096B）
ok  ：fetch-shim.js 一致（33278B）   ok  ：dshm-user-rows.js 一致（48866B）
ok  ：undici-shim.mjs 一致（5530B）  ok  ：dshm-skills.js 一致（4995B）
ok  ：undici-loader.mjs 一致（1223B）ok  ：dshm-compat.js 一致（10154B）
ok  ：require-builtin-shim.cjs 一致（2453B）
ok  ：package.json 语义锁（main=main.js，无 type 字段 ⇒ CommonJS）
assert-resfile-sync：13 件快照全部同步
```

---

## 4. 步骤 3：`node tools/place-toolchain.mjs`

**输入**：`third_party/python/cpython-…_stripped.tar.gz`、`third_party/git/apks/*.apk`
**输出**：`entry/src/main/resources/resfile/toolchain/{python,git}/`（归档 + `dshm-signed.txt` 标记）
+ `entry/libs/arm64-v8a/libpython3.12.so.1.0`

这一步动作最多，也踩坑最多。它做四件事：**放置归档 → 构建期自签名 → 写版本标记 → 抽 libpython 进 el1 libs**。

### 4.1 为什么原样放归档而不是解开的目录

> hmfs 禁 symlink（docs/70 §2.4）。Windows 侧解包会把 git-core 里 180+ 个指向 git 本体的
> symlink 变成 **1.3 GB** 拷贝；apk/tar.gz 原样带 symlink 元数据进 HAP，
> 端侧 busybox tar 解包时 symlink 失败仅告警跳过，真身 ELF 全在
> （place-toolchain.mjs:15-19）。

⇒ 所以 `python` 归档被**改名**放置（源 `…-install_only_stripped.tar.gz` → 目标
`cpython-3.12.14-aarch64-musl.tar.gz`，place-toolchain.mjs:34-35），
注释里明确要求"`main.js` 的 `PYTHON_TARBALL_REL` 与此对应；改名时两处同步"（:33）。

### 4.2 构建期自签名：为什么必须签，为什么只签这些

**为什么必须签**：端侧 `execve` 对**第三方 ELF** 一律拒绝（签名域策略），与权限位/创建者无关。
决定性实证：`binary-sign-tool sign -selfSign 1` 后 `exec 探测` 从 `rg=denied` 变 `rg=ok`
（place-toolchain.mjs:40-44）。git / python3.12 同属"要被 exec 的独立 ELF"，
区别是它们躺在**归档**里、解包发生在设备上 ⇒ 构建期要把归档解到临时目录 → 签名 → 重新打包。

**为什么用 `-selfSign` 而不是完整证书链**：走 `SelfSignSignProvider`，
只加 `.codesign` 段并用描述符摘要当签名，**跳过 `.profile`/`.permission` 段与证书链写入**，
因此**不需要 keystore 密码**。这正是需要的：文件在应用私有沙箱内由本进程使用，
不需要可分发性证明（pack-core.mjs:233-237 同源说明）。

**为什么连 `.so` 一起签**：`execve` 放行主程序后，动态链接阶段仍要加载 musl loader 与
`libcurl`/`libssl` 等。把 `*.so*` 一并签，与"主程序能起来"是同一件事的两半（:46-48）。

**为什么 python 只签 `bin/*` + 少量 `.so`**：
python-build-standalone 的 musl 变体把核心扩展静态内建进 `libpython`，
动态件很少；全树签名会把 27 MB 归档膨胀数倍且没必要（:50-52）。

**为什么走 Python 的 `tarfile`**（`tools/sign-tar-elf.py` 头注释）：

| 工具 | 行为 | 后果 |
|---|---|---|
| Windows `bsdtar` | 无符号链接特权 ⇒ 每条 symlink `Invalid argument` 且**条目丢失** | 不可逆改坏归档 |
| `7z` / Node 展开 | 把 symlink **物化**成副本 | git-core 8 MB → 1.3 GB |
| Python `tarfile` | 逐条目读出再原样写回，symlink 仍是 symlink 条目（不落盘、不需特权） | **唯一既保结构又能改字节的路** |

`sign-tar-elf.py:59-93` 的逻辑：非 `isfile()` 的成员原样搬运；普通文件读出来判
`\x7fELF` 魔数（与 `main.js` 的 `isElf` 同一判据，**不按扩展名猜**），是 ELF 才签名；
任何单文件签名失败**只打印并继续**（不半途毁归档）；归档重写用临时文件 + `os.replace`（原子）。
本机实测：`resign: cpython-…tar.gz signed 10/10 ELF`。

### 4.3 E-TS1：静默跳过签名的陷阱 ⇒ 现在改为 `exit 1`

这是本章最值得逐字读的一条。

**事故链（三层，缺一不可）**（place-toolchain.mjs:112-123、docs/device-validation.md:4313-4336）：

1. 本机 PATH 里**没有** `python3`/`python`/`py`（只有 DevEco 的 jbr 与 node）；
2. `findHostPython()` 当时**只找 PATH** ⇒ 返回 `null`；
3. 找不到宿主 python 时**只打一行 ⚠ 就跳过签名**，脚本仍 **exit=0** ⇒
   构建全绿、装机后才暴露。

**症状（设备侧）**：

```text
exec 探测：python3.12=denied，git=denied，git-core/git=denied，
          git-remote-http=denied，rg=ok，bash=ok，git-ls-remote=denied   ← 2/7
```

只有 `rg`/`bash` 通（rg 在核心树里已被签、bash 是 `#!/system/bin/sh` 脚本）。

**这一条最危险的地方**：没有任何门禁会红。构建端一切正常，症状只在设备上显现。

**修法（三处）**：

| # | 改动 | 落点 |
|---|---|---|
| 1 | `findHostPython()` 追加候选：先 `DSHM_HOST_PYTHON` → 再**项目自带**的 python → 最后才试 PATH | place-toolchain.mjs:124-139、`bundledPythonCandidates()` 89-104 |
| 2 | 签名未执行 ⇒ **`process.exit(1)`**，并给出可直接照做的修法 | place-toolchain.mjs:276-292 |
| 3 | 新增 `tools/check-toolchain-sign.mjs` 门禁 | 见 §4.5 |

第 1 条的关键设计是**不依赖调用者 PATH**：项目其实自带了可用的宿主 python
（`%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`，
实测带 `tarfile`，本机 `PIL 12.3.0` 也在），把它加为候选 ⇒ "忘配 PATH"不会再导致静默降级。

第 2 条保留了**显式逃生阀** `DSHM_ALLOW_UNSIGNED_TOOLCHAIN=1`，
供"只改 ArkTS、不碰工具链"的快速迭代使用，但它会**高声提示**
"此包在设备上 git/python 真身会被 execve 拒（仅桥模式可用）"（:277-279）。

**真机验证（决定性）**：

```text
修前：python3.12=denied, git=denied, git-core/git=denied, git-remote-http=denied,
      rg=ok, bash=ok, git-ls-remote=denied                          ← 2/7
修后：python3.12=ok, git=ok, git-core/git=ok, git-remote-http=ok,
      rg=ok, bash=ok, git-ls-remote=ok                              ← 7/7
```

**现在这条的边界**：`exit 1` 只在"工具/宿主 python 缺失"或"签名器抛错"时触发。
`tool === null`（找不到 `binary-sign-tool.jar` / JDK）与 `hostPython === null` 都走
`signOk = false` 分支（:219-224）⇒ 最终 `exit 1`。
**"签名器整体成功但内部有个别文件签失败"不会 `exit 1`**——`sign-tar-elf.py` 对单文件失败
只打印并继续（:47-51），整体仍返回 0。这一点是**如实记录的边界**：
门禁 `check-toolchain-sign.mjs` 只验"标记存在 + 是前缀+摘要形态 + 摘要自洽"，
**不逐个验归档内 ELF 是否都带 `.codesign`**。

### 4.4 E-TS2：标记必须是"前缀 + 内容摘要"，不能是固定常量

**端侧判据**是 `解包目录的标记 !== 归档目录的标记 ⇒ 重解`
（`main.js` 的 `needsReextractForSign`）。设备侧解包是"存在即跳过"
（`gitReady()`/`pythonReady()` 只看文件在不在）。

**若标记是固定常量**（place-toolchain.mjs:243-250）：

- 09-22 那版（**未签名**）的归档也写同一个常量，且设备已解包并记下该常量；
- 今天这版（**已签名**）的标记仍是同一常量；
- ⇒ 端侧判成"没换代" ⇒ **不重解** ⇒ 新签名的 ELF 永远到不了设备，
  `exec 探测` 继续 `denied`，**白签一场**。

**修法**：标记值 = `前缀 + 归档目录内文件大小之和`（`SIGN_MARKER_PREFIX + '+' + archiveDigest(sub)`，
place-toolchain.mjs:201-210、254-257）。归档一变、标记就变，换代判定必然触发；
端侧只做字符串比较，**无需任何改动**。

**摘要取"文件大小之和"而不是哈希** 的三条理由（:189-192）：
签名会改变文件字节（追加签名块），**大小必然变** ⇒ 能捕捉签名前后差异；
不需要读全文件算哈希（27 MB 归档，读一遍没必要）；端侧只做字符串比较，长度无所谓。

**为什么 python 与 git 各算各的、不共用一个总和**（:194-199）：
端侧是**分别**比较两个目录的标记。若两边写同一个总和，
则"只有 git 换代、python 没变"时两个标记都会变，python 被无谓重解（27 MB / 4,530 文件）；
更糟的是门禁 `check-toolchain-sign.mjs` 是**按目录**核算的，共用总和会让它误报不一致。

**实现时自己踩的坑（留档）**（:211-216）：摘要最初在**签名之前**计算，
而签名会改变文件大小 ⇒ 标记记的是签名前的值，与落盘文件对不上。
**新建的门禁立刻报出了这个不一致**——是它替本项目抓住了这处顺序错误。
现在摘要的计算挪到文件末尾的写标记处（签名之后）。

**标记文件名不能以点开头**（:64-72）：

> 最初用 `.dshm-signed`，结果 **HAP 打包把所有 dotfile 条目丢掉**
> （实测：打包产物里以点开头的条目数为 0）⇒ 端侧读不到标记 ⇒ 判"归档无标记"
> ⇒ 走"存在即跳过" ⇒ 新签名归档永远不会被解包，白签一场。故改用 `dshm-signed.txt`。

**真机换上后的读数**（docs/device-validation.md:4345-4349、4365-4366）：

```text
工具链：python 归档已换代（dshm-signed.txt 变化），强制重解以取到已签名的 ELF
工具链：git    归档已换代（dshm-signed.txt 变化），强制重解以取到已签名的 ELF
工具链：解包收尾 python=OK，git=OK

files/toolchain/gitroot/dshm-signed.txt:    dshm-signed-v1+8501127
files/toolchain/python/dshm-signed.txt:     dshm-signed-v1+27720007
```

本机复核（`Get-Content entry/src/main/resources/resfile/toolchain/*/dshm-signed.txt`）：

```text
python   dshm-signed-v1+27720007     ← 与归档实际字节数一致
git      dshm-signed-v1+8501127      ← 与 15 个 apk 之和一致
```

### 4.5 门禁 `tools/check-toolchain-sign.mjs`

检查三件事（:14-18）：① 两个归档目录里 `dshm-signed.txt` 存在；
② 标记是"前缀 + 内容摘要"形态（正则 `^dshm-signed-v1\+(\d+)$`，:62）；
③ 摘要与归档**实际大小之和**自洽（证明标记没被伪造、归档没被偷换）。

退出码语义（:20）：**0 通过 / 1 有问题 / 3 环境不足**。
归档目录不存在 ⇒ **exit 3**（"工具链尚未布置，place-toolchain 没跑过"），
明确区分"环境不足"与"签名缺失"。

本机实测输出：

```text
工具链自签名门禁
  ok  ：python：标记 dshm-signed-v1+27720007，与归档实际大小自洽（27720007B）
  ok  ：git：标记 dshm-signed-v1+8501127，与归档实际大小自洽（8501127B）
  ✓ 通过（2 项）
```

### 4.6 抽出 `libpython3.12.so.1.0` 进 el1 libs

`place-toolchain.mjs:303-320` 自己写了个最小 ustar 解析器 `untarMembers(gzPath, wanted)`，
只取一个成员 `python/lib/libpython3.12.so.1.0`，写进
`entry/libs/arm64-v8a/libpython3.12.so.1.0`（:339-343）。

**为什么这条路径必须存在**（:329-337）：

> exec 管控调查结论（E16/E17b）：**`dlopen` 只放行 HAP 安装的 `libs/<abi>/` 目录**
> （koffi/sharp 全家同一通道）；`resfile/` 与解包后的 el2 `files/` 一律 "No error information"。
> 内嵌 CPython 桥在运行时从这里 `dlopen libpython`（`DSHM_PYTHON_LIB`）。
> **体积**：+22 MB 进 HAP。

**注意顺带清掉的历史包袱**：曾有"HAP 裸 ELF 段"（`resfile/toolchain/elf/`，52.4 MB）——
E1-E19 实验证明 resfile 只读挂载下的 `execve` 同样被签名域拒绝，该段沦为诊断素材；
Phase 5 拆除诊断后零引用，已整体移除（体积回收 −52.4 MB，:295-301 与
docs/device-validation.md:848-878）。

### 4.7 失败会死在哪些点

| 行 | 条件 | 消息 |
|---|---|---|
| place-toolchain.mjs:146-148 | 缺 python 归档 | 打印 `curl` 取法后 `exit 1` |
| :154-157 | `third_party/git/apks` 下没有 `.apk` | 指向 `docs/device-validation.md` 工具链批次后 `exit 1` |
| :276-292 | 签名未执行且没设逃生阀 | 列出三条修法后 `exit 1` |
| :323-325 | python 归档里取不到 `libpython` | `python 归档缺 libpython（实得 …）` 后 `exit 1` |

### 4.8 验证

```bash
node tools/place-toolchain.mjs
node tools/check-toolchain-sign.mjs     # 必须 exit 0

# 归档里的 ELF 是否真的被签（抽查 git 主程序）
python - <<'EOF'
import tarfile, tempfile, os, subprocess
t = tarfile.open('entry/src/main/resources/resfile/toolchain/git/git-2.47.3-r0.apk')
m = [x for x in t.getmembers() if x.name.endswith('usr/bin/git')][0]
d = tempfile.mkdtemp(); t.extract(m, d)
print(subprocess.run(['llvm-readelf','-S',os.path.join(d,m.name)],capture_output=True,text=True).stdout.count('.codesign'))
EOF

# 标记与实际大小自洽（门禁已在做，这里手工复核）
python -c "
import os
for sub in ('python','git'):
    p='entry/src/main/resources/resfile/toolchain/'+sub
    s=sum(os.path.getsize(os.path.join(p,f)) for f in os.listdir(p) if f!='dshm-signed.txt')
    print(sub, open(os.path.join(p,'dshm-signed.txt')).read().strip(), s)"
```

本机实测基线：

```text
python/  cpython-3.12.14-aarch64-musl.tar.gz   27,720,007 B (26.44 MiB)   ← 签名后（源 28,594,621 B）
git/     15 个 apk 合计                         8,501,127 B ( 8.11 MiB)
entry/libs/arm64-v8a/libpython3.12.so.1.0      23,149,128 B           ← 取自归档副本 libpython3.12.so.1.0
```

> **一个必须知道的不确定性**：`sign-tar-elf.py` 不是确定性的。
> 对同一份源归档跑两次，产出**大小相同（27,719,980 B）但 sha256 不同**
> （本机实测：`EF7E8BBF…` vs `C6089AE5…`）。
> 所以 `entry/libs/libpython3.12.so.1.0`（23,149,128 B，取自归档）
> 与 HAP 里那一份（20,461,032 B）**字节不同**——HAP 里的是 hvigor 的
> `DoNativeStrip` 处理过的版本，不是同一份字节。**不要用"大小相等"去断言它们一致。**

---

## 5. 步骤 4：`node tools/gen-fish-logo.mjs`

**输入**：核心树里的 `@deepseek-ai/dsh-client-ui-primitives/lib/index.js`
**输出**：`entry/src/main/resources/base/media/fish_logo.svg`

### 5.1 为什么是"生成"而不是内联在 ArkTS 里

此前 ArkTS 侧内联了一份 3449 字符的 path 字面量，出过两个问题（gen-fish-logo.mjs:9-12）：

1. **手抄错 1 位**：`12.6435` 应为 `12.643`（差 0.0005，但那是控制点，轮廓会变形）；
2. **无法核对**：内联后没人会去逐字节比，错了也不知道。

改成生成式 + 资源文件后，"路径与官方是否一致"变成一条可执行的自检。

### 5.2 三条自检，任一不成立即 `exit 1`

| 自检 | 位置 | 判据 |
|---|---|---|
| 找得到 primitives 包 | :47-51 | 在 `dist/core/work/dsh-core-*/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js` 里**倒序**找（目录名随版本变，**不写死**），找不到就提示"请先跑 pack-core" |
| **真实紧包围盒 == 官方 viewBox** | :106-116 | 把每段三次贝塞尔离散成 400 点取极值，与 `FISH_LOGO_VIEWBOX` 比，`eps=0.01` |
| **落盘后仍与官方一致** | :130-135 | 读回文件、正则取 `d="…"`，与源串逐字节比 |

第二条的来由（:14-18）值得记住：

> 曾经算过一个"墨迹盒"（`x=-0.2229 w=23.3967`）并据此设 ArkUI `viewPort`——**那是错的**：
> 它取的是**贝塞尔控制点**的包围盒，而控制点可以落在曲线**外面**。
> 把每段 C 曲线离散成 400 点采样后，真实紧包围盒 = `x 0.0000 w 23.1600 h 17.0434`，
> **恰好等于官方 viewBox**（零溢出）。

这条自检若是红的，说明**上游换了几何**或"零溢出"结论有误——
此时**应停下来人工确认**，而不是默默生成一个可能偏心的资源。

### 5.3 为什么是 SVG 而不是 ArkUI `Shape` 自绘

真机实测：`Shape.viewPort` **并没有把路径缩放进组件盒**
（组件盒 42×31px，墨迹只占左上角 25×18px，左留白 0 / 右留白 18px）⇒ 用户看到的"歪"。
改用 SVG + `Image` 后，等比缩放由图片组件负责，问题消失（:20-22，对应 E380）。

`fill="#151517"` 是**占位实色**：HarmonyOS 的 `Image.fillColor` 会**整体重着色**单色 SVG
（把非透明像素统一替换成指定色），等价官方 Web 层的 `fill: currentColor`；
运行时由 ArkTS 侧按主题覆盖。**不能用 `currentColor`**——ArkUI 的 `Image` 不解析 CSS 关键字（:119-123）。

### 5.4 验证（本机实测，幂等）

```bash
node tools/gen-fish-logo.mjs
# 输出：
# [gen-fish-logo] 真实紧包围盒 x=0.0000..23.1600 y=0.0000..17.0434  (官方 viewBox 0 0 23.16 17.04)
# [gen-fish-logo] ✓ 零溢出，直接用官方 viewBox
# [gen-fish-logo] ✓ 已生成 entry\src\main\resources\base\media\fish_logo.svg
# [gen-fish-logo]   path 3448 字符，与官方逐字节一致；文件 3577 字节

# 幂等：连跑两次，sha256 不变（本机实测 02F91389C40CCEF…9005E9）
Get-FileHash entry/src/main/resources/base/media/fish_logo.svg -Algorithm SHA256
```

---

## 6. 步骤 5：`python tools/make-icon.py`

**输入**：`entry/src/main/resources/base/media/fish_logo.svg`（**必须先有它**）
**输出**：6 个 PNG——`AppScope/` 与 `entry/` 各一套 `foreground.png` + `background.png`（1024）、
`docs/brand/dshm-icon.png`（512）、`docs/brand/dshm-mark.png`（256）

### 6.1 前置依赖是硬性的

`make-icon.py:183-185`：`fish_logo.svg` 不存在就打印
`缺 fish_logo.svg；先跑 node tools/gen-fish-logo.mjs` 并 `return 1`。
⇒ 顺序上**④ 必须在 ⑤ 之前**。

### 6.2 🔴 本脚本**不产出**启动画面资源（2026-09-27 起）

这是本章少数几条**用户明示约束**，违反的后果是"跑一次就把启动画面改成带角标的版本"：

| 不再产出的文件 | 现在由谁负责 |
|---|---|
| `entry/src/main/resources/base/media/logo_dark.png` | **原版**（启动页大标识/动画），归档在 `third_party/brand-original/` |
| `entry/src/main/resources/base/media/startIcon.png` | **原版**（启动窗口图标），同上 |

实现上有**双层护栏**，不只是靠注释：

1. `outs` 列表（make-icon.py:347-354）**不含**这两个文件；
2. 写盘后**逐字节**与 `third_party/brand-original/` 比对，不一致即 `return 1`
   （:428-448）。注释里写明旧版的缺陷：
   > 旧版只 `print('（未改动）…')`，即使把 `startIcon` 加进 `outs` 被覆盖，
   > 也照样打印"未改动"（审查实测：文件从 3577B 被改成 59441B 而日志说没改）。

`tools/check-icon-assets.mjs` 里还有第三处独立守卫（:56-72），并带一条硬编码的原版 sha256
（`5a1a1ac3885f100842e555131586357429ce241c95974a405db3a383d7d24b1a`，:28）。

### 6.3 "先自检后写盘"：一个关于回滚纪律的设计

> **【为什么"先自检后写盘"】** 旧版先落盘再自检：自检失败时坏图**已经写进资源目录**，
> 等于"退出码 1 但资源被污染"（审查实测：强制失败后磁盘上仍留下 6 个 PNG）。
> 现在全部自检通过才写；失败则**一个文件都不动**。（make-icon.py:355-358、415-419）

这是本节最值得抄的一条：**失败路径不能留下副作用**。

### 6.4 三条自检的判据是怎么定出来的

判据**按实测差标定，不是拍脑袋**（这点决定了它真的能拦住 bug）：

| 自检 | 判据 | 标定依据 |
|---|---|---|
| **鲸鱼必须"带洞"**（even-odd 生效） | 前景不透明像素占比落在 **16%~20%**（1024 画布） | 正常 even-odd **18.10%**；错用逐子路径 `fill`（填黑内腔）**23.46%** ⇒ 带宽必须**窄于**两者之差（+5.36pp）才有鉴别力。曾用 15%~25%，坏图 23.46% **落在带内 ⇒ 根本拦不住**（:367-379） |
| **画布四角必须透明** | 四角像素 alpha ≤ 128 | 鲸鱼不该铺满（:381-383） |
| **`mark` 不能带角标** | 在**同一 512 尺度**上比"角标框内"的不透明像素数，`mk_ink` 必须明显少于 `fg_ink`（阈值 0.9×） | 两次写错判据："看右下角有没有墨"——尾鳍本来就有墨；"放大到 1024 与 fg 逐像素比"——重采样路径不同会引入遍地差异（:385-408） |

另有一条角标自检：墨迹面积必须落在块画布的 6%~30%，
否则说明块尺寸/行距/位置算错（如"块高漏算行距"会让第二行被裁，:314-329）。

### 6.5 验证

```bash
python tools/make-icon.py
node tools/check-icon-assets.mjs       # 必须 exit 0

# 本机实测输出（check-icon-assets）：
#   ok  ：foreground.png：AppScope 与 entry 一致
#   ok  ：background.png：AppScope 与 entry 一致
#   ok  ：startIcon.png：与原版一致
#   ok  ：logo_dark.png：与原版一致
#   ok  ：foreground.png 体积 58.0KB（在预期带内）
#   ✓ 通过（5 项）
```

`check-icon-assets.mjs` 的第三条判据是**文件大小带 30–120 KB**（:84-90）——
一个粗但有效的"是不是新版"判据：新版（鲸鱼 + 旋转角标）约 57–60 KB，
旧的纯鲸鱼版约 15–18 KB。本机实测 `foreground.png` 59,441 B = 58.0 KB，在带内。

---

## 7. 步骤 6：hvigor 构建

### 7.1 命令

仓库里**唯一能照着跑通的命令**是 `tools/update-device.ps1:93-108` 里那一段
（`README.md` 写的是 `devecocli build`，但**本机 PATH 里没有 `devecocli`**——
`where.exe devecocli` 返回 "Could not find files"；`devecocli` 由 DevEco Command Line Tools 提供，
本机只有 `C:\Program Files\Huawei\DevEco Studio\tools\{hvigor,node,ohpm,...}`）：

```powershell
$env:JAVA_HOME           = 'C:\Program Files\Huawei\DevEco Studio\jbr'
$env:DEVECO_SDK_HOME     = 'C:\Program Files\Huawei\DevEco Studio\sdk'
$env:DEVECO_CLI_CLT_PATH = 'C:\Program Files\Huawei\DevEco Studio\tools'
$env:PATH                = "$env:JAVA_HOME\bin;$env:DEVECO_CLI_CLT_PATH\node;$env:PATH"

& "$env:DEVECO_CLI_CLT_PATH\node\node.exe" `
  "$env:DEVECO_CLI_CLT_PATH\hvigor\bin\hvigorw.js" assembleHap `
  --mode module -p product=default -p buildMode=debug --no-daemon
```

对应的落点（本机实测存在）：

| 项 | 本机路径 |
|---|---|
| hvigor 入口 | `C:\Program Files\Huawei\DevEco Studio\tools\hvigor\bin\hvigorw.js` |
| 自带 node | `…\tools\node\node.exe` |
| JDK | `…\jbr\bin\java.exe`（实测 `openjdk version "25.0.2"` / `JBR-25.0.2+1-329.117-nomod`） |
| SDK | `…\sdk`（含 `default\openharmony\{native,toolchains}`） |
| hdc（装机用） | `%USERPROFILE%\AppData\Local\OpenHarmony\Sdk\<版本>\toolchains\hdc.exe`（`update-device.ps1:31`） |

### 7.2 为什么 `PATH` 里**必须**有 `jbr\bin`：`spawn java ENOENT`

`SignHap` 阶段的签名器是用 **java 命令行** 起的，而它的可执行名是**裸 `java`**，
**不读 `JAVA_HOME`**：

- `hvigor-ohos-plugin/src/builder/java-command-builder.js` 的构造函数里
  `this.commandList.push("java")` —— 命令名就是字符串 `"java"`；
- `…/tasks/sign/sign-util.js` 的 `executeSign()` 走
  `new ProcessUtils(…).execute(o)`，而 `ProcessUtils.execute()`
  （`…/utils/process-utils.js`）直接 `spawn(e[0], e.slice(1), opts)`；
- 同一文件里的 `validateExecuteFile()` **特意跳过** `java`/`javac` 的存在性校验
  （`if ("java" !== e && "javac" !== e && …)`），
  ⇒ **没有 java 时不会给出"找不到 java"的友好提示**，而是让 `spawn` 抛 `ENOENT`。

本机实测复现（`PATH` 里没有 java 时）：

```text
node -e "const {spawnSync}=require('child_process');const r=spawnSync('java',['-version'],{encoding:'utf8'});console.log(r.status, r.error && r.error.code, r.error && r.error.message)"
→ null ENOENT spawnSync java ENOENT
```

`where.exe java` 在本机返回空 ⇒ **不设 `PATH` 就一定会走到这条路**。
报错文本是 `spawn java ENOENT`，看不出与"签名证书"有关，容易往证书方向排查。

⇒ **`$env:JAVA_HOME` 只是给 hvigor 读的（`abstract-pre-build.js` 会把它打进 debug 输出），
真正让 `SignHap` 能起来的是 `PATH` 里的 `<JAVA_HOME>\bin`**。
`update-device.ps1:98` 同时设了两者，这是对的——但要知道哪一条是**必需**的。

### 7.3 `buildMode=debug` 不是可选装饰

**注意有两个 `build-profile.json5`，职责完全不同**——这是本节最容易走错的一处：

| 文件 | 管什么 | 关键行 |
|---|---|---|
| **根** `build-profile.json5` | 应用级：`signingConfigs` / `products` / `modules` 清单 | `signingConfigs` 见 :3-17；`products[0].signingConfig = "default"` 见 :21；`targetSdkVersion`/`compatibleSdkVersion = 6.1.1(24)` 见 :22-23；`bundleName` 见 :39 |
| **`entry/build-profile.json5`** | 模块级：CMake 路径与 `abiFilters` | `abiFilters: ["arm64-v8a"]` 见 :23 |

根 `build-profile.json5:3-17` 只声明了**一个** `signingConfigs`（`name: "default"`，
`type: "HarmonyOS"`，`keyAlias: "debugKey"`，材料在
`%USERPROFILE%\.ohos\config\default_desktop.ohos.arm64_*.{p12,cer,p7b}`），
`products[0].signingConfig = "default"`（:21）。
⇒ **签名材料与应用版本、构建模式都无关**，它固定是那套调试证书。
本机复核：`.p7b` 里嵌的 bundle 名是 `com.dshm.dshclient`，与
根 `build-profile.json5:39`、`AppScope/app.json5:3`、HAP 内 `module.json` 的
`app.bundleName` 三处一致（HAP 内 `pack.info` / `module.json` 可直接读出）。

> ⚠️ 根 `build-profile.json5:8-14` 里的 `certpath`/`profile`/`storeFile` 是
> **写死的绝对路径**（`%USERPROFILE%\.ohos\config\…`）⇒ **换机器必须重新生成签名**，
> 否则 `SignHap` 找不到材料。`storePassword`/`keyPassword` 那两串 `0000001B…` 是
> DevEco 加密存储的密文，**不是明文密码**（`tools/node-runtime/sign-native.ps1:15-17` 有同源说明：
> 它们由 DevEco 在调用工具时自行解密，脚本读不出、也不要猜）。

**签名 profile 绑定 bundleName**（docs/70 §11.10 / E-SV9）：
`signingConfigs.default.profile` 指向的 `.p7b` 是 **provisioning profile，内部绑定了一个具体
bundle-name**。改 `bundleName` 不是一个"只影响装到哪个包"的单点动作——它同时决定了**签名材料**，
而签名材料是 GUI 生成的、不在仓库里。改回去必须在 DevEco GUI 里重新走一次自动签名
（要登录华为账号 + 设备在线），且 `SignHap` 会明确报：

```text
ERROR: 00303074 Configuration Error
The bundleName in app.json5/hvigorfile.ts does not match the bundleName in the generated SigningConfigs.
```

### 7.4 构建链里 hvigor 自己做了什么（对体积与签名有影响）

| 阶段 | 行为 | 证据 |
|---|---|---|
| `CompileArkTS` | 产出 `ets/modules.abc`（本机 2,955,428 B） | HAP 内 |
| `BuildNativeWithCmake` | 按 `entry/build-profile.json5:23` 的 `abiFilters: ["arm64-v8a"]` 编 `entry/src/main/cpp/CMakeLists.txt` 的 6 个目标 | `CMakeLists.txt:28/32/127/198/224/260` |
| `DoNativeStrip` | **strip 原始 `entry/libs/<abi>/*.so` 后入库** | 本机实测：HAP 内 `librsvg-2.so` 与 `entry/build/default/intermediates/stripped_native_libs/…/librsvg-2.so` **逐字节相同**（sha256 `e8d7fc95…`），而 `entry/libs/arm64-v8a/librsvg-2.so` 是另一份（`978ea2ff…`） |
| `PackageHap` + `SignHap` | 组装 + 用调试证书签（产出 `entry-default-signed.hap`） | `…/tasks/sign-hap.js`、`…/tasks/sign/sign-util.js` |

> ⚠️ **`DoNativeStrip` 会移除 `.codesign`**（实测：`entry/libs` 下 47 个库带 `.codesign`，
> **HAP 内 59 个库带 `.codesign` 的数量是 0**）。
> 但这是**可接受的**：`.so` 走 `dlopen`，`dlopen` 通道不要求 `.codesign`
> （E18 已证"即使没有 `.codesign` 也能加载"，docs/70 §1.1）；
> 真正需要 `.codesign` 的是**要被 `execve` 的独立件**——rg（在核心树 zip 内，
> 实测带 `.codesign`）与工具链归档里的 git/python（在 resfile 归档内，已签）。
> **这条边界要说清楚**：HAP 的 `libs/` 里没有签名段是**预期状态**，不是漏签。

### 7.5 已知的构建期环境陷阱

| 陷阱 | 现象 | 处置 |
|---|---|---|
| `JAVA_HOME` 没进 `PATH` | `SignHap` 报 `spawn java ENOENT` | `$env:PATH = "$env:JAVA_HOME\bin;…"` |
| 缺 `DEVECO_SDK_HOME` | 找不到 SDK / toolchains | 指向 DevEco 的 `sdk` 目录 |
| 产物目录被构建清掉 | `pack-core --skip-install` 直接失败 | pack-core 输出刻意放 `dist/`（pack-core.mjs:44-46） |
| hvigor 编译失败**仍可能以 0 退出** | 看退出码会误判成功 | `tools/check-arkts-entry.mjs:44` 注释；判定必须**解析输出**找 `COMPILE RESULT` |
| 增量构建任务被 `UP-TO-DATE` 跳过 | 没有 `COMPILE RESULT` 行，"通过"是复用旧结果 | 同上，脚本会如实标注并提示 `--clean` |
| `ohpm` 按 lock 判定、不重解 HAR | 改了 HAR 但旧 `x86_64` 又回来了 | 清 `oh_modules/.ohpm` 缓存 + 重跑 `ohpm install` |

---

## 8. 步骤 7：产物

```text
entry/build/default/outputs/default/
├── entry-default-unsigned.hap     312,150,304 B  (297.69 MiB)
├── entry-default-signed.hap       314,166,762 B  (299.61 MiB)   ← 装机用这个
├── pack.info
└── mapping/
```

签名只多两样东西（本机逐条目对比，2026-09-29 / 核心 0.2.0-rc.2）：

| 差异 | 大小 |
|---|---|
| 新增条目 `.pages.info` | 23,800 B |
| 条目总和解包量 | 312,134,144 → 312,157,944 B（**差额就是 `.pages.info`**）；其余 110 个条目**大小逐条相同** |
| 文件级附加块（中央目录 + 签名块） | 16,160 → 2,008,818 B |

⇒ 两个 HAP 的差异**只有签名块与 `.pages.info`**，内容零差异。
这条对"签名没改内容"是个有用的断言。

⚠️ **该目录会被 `clean` 覆盖**（`AGENTS.md`）⇒ **不要当交付物留档**。留档去 `dist/sideload/`。

### 8.1 装机（唯一的允许入口）

```powershell
.\tools\update-device.ps1              # 构建 + 覆盖安装 + 验证
.\tools\update-device.ps1 -SkipRebuild   # 只装现有产物
# 或最小动作：
hdc install -r entry\build\default\outputs\default\entry-default-signed.hap
```

**绝对禁止 `hdc uninstall`**——2026-09-25 的事故里，一次裸卸载删掉了真机上
**6 个历史会话、7 个插件、2 个工作区**，且系统备份为空、**不可恢复**
（`docs/80-真机更新与数据保全.md:8-45`）。
判据：`/data/app/el1/...` = 代码与资源（覆盖安装会换，**安全**）；
`/data/app/el2/...` = **用户数据**（任何删除都是不可逆的，**禁止**）。
`update-device.ps1` 把这条做成了代码约束——第 0 步**自检脚本自身不含卸载调用**（:46-70），
且装前记录 `home` 条目数、装后比对，减少就判 FAIL（:145-167）。

> ⚠️ **版本硬编码，升级核心后必须同步改**（否则脚本会误判失败，或被误当成"没验证"）。
> 其中核心版本判据**已于 2026-09-28（批次三十五）改为从 recipe 读取**，不再需要手改：
>
> | 位置 | 内容 | 状态 |
> |---|---|---|
> | `update-device.ps1` 的核心版本判据 | `$wantCore = (Get-Content hostcore/core-recipe.json -Raw \| ConvertFrom-Json).coreVersion` → `if ($afterCores -notmatch [regex]::Escape($wantCore)) { Bad … }` | ✅ 已改为读配方（2026-09-28）。判据是"**新版在不在**"，不要求旧版不在——新旧核心树并存是预期行为（`docs/50:45`） |
> | `update-device.ps1` Step 8 的 exec 探测判据 | 原 `if ($okCount -ge 7)`；现改为 `$probe = [regex]::Match($log,'exec 探测：(.*)')` → 按 `[，,]` 切分逐项要求 `=ok$`，全通才 `$execOk = $true`，结论段用 `if ($dataOk -and $execOk)` | ✅ **已改为逐项判定**（2026-09-28）。写死总数会在新增探测目标后失效（8 项只 ok 7 项仍算通过） |
>
> 这两条都是"**写死总数/版本**"的门禁形态。本项目在
> `docs/70` §8.13（`docs/70-鸿蒙移植踩坑与修复总览.md:885`）已把这类问题
> 登记为一条独立教训（E381/E382：「写死总数」的断言会让人放松警惕）。
> 同一形态的三处脚本硬编码**已于 2026-09-28 一并清理**（原记"留档未改"）：
> `tools/func_test_final.py`（`'0.1.7-rc.2' in ls` ⇒ 改为读 recipe 的 `want_core()`；另 T0.2 的
> `detail.count('=ok') >= 7` 同步改为逐项判定）、`tools/repro_report9.py:41`
> （`DSHM_CORE_DIR=…/cores/0.1.7-rc.2` ⇒ 属一次性脚本，随清理 `git rm`）、
> `tools/scan-core-plugins.mjs`（默认 `coreDir` 停在 `dsh-core-0.1.5-rc.2` ⇒ 改为
> `join(ROOT,'dist','core','work', \`dsh-core-${RECIPE.coreVersion}\`)`）。
> 清理明细见本章 §5.3。

---

## 9. 步骤 8：交付包归置 `dist/sideload/`

**内容**（本机实测）：`DSHM-1.0.0-arm64-signed.hap`（314,166,762 B / 299.62 MiB，2026-09-29 22:48 / 核心 0.2.0-rc.2）、`README.md`、`SHA256SUMS.txt`。

> **2026-09-30 复核：这份交付包又落后了一整个核心版本**（仍嵌 `dsh-core-0.2.0-rc.1`，缺托盘图标、
> `dshm-compat.js`、`dshm-skills.js`），已按 §9.2 四步刷新到 2026-09-29 22:48 的构建产物。
> ⇒ **E-DL1 的教训是"会复发"的**：四步纪律只是人记得住的部分，缺的仍是脚本约束（见 §9.3）。

### 9.1 踩过的坑：顺序错一次，交付包就落后一个版本

**事故（E-DL1，docs/device-validation.md:4373-4384）**：

> `dist/sideload/` 里的 HAP 比 `entry/build/` 的**旧一个版本**
> （299.5 vs 300.3 MB 差异期；差 1172 B，逐条比对**仅** `ets/modules.abc` 与
> `sourceMaps.map` 不同）。反汇编显示 dist 版仍含 `concat`/`sleepMs`——
> 那是**已经删掉的死代码**。
>
> **根因（顺序错）**：先刷新了交付包，之后 `check-dead-code` 抓出死代码 → 删掉 → 重新构建。
> **交付包漏掉了最后一次改动。**

**这条的危险性**：`dist/sideload/` 按 `AGENTS.md` 是**交付物**，
照它装机等于装旧版；而它比 build 只小 0.8 MB，肉眼与体积都看不出来。

### 9.2 现在的强制顺序（四步，前两步是断言）

```powershell
$build = 'entry\build\default\outputs\default\entry-default-signed.hap'
$dist  = 'dist\sideload\DSHM-1.0.0-arm64-signed.hap'

# ① 先确认没有比构建更新的源文件 —— 有则必须先重新构建
$t = (Get-Item $build).LastWriteTime
Get-ChildItem hostcore,appstate,connection,dshcompat,platform,hostruntime,entry\src,tools,AppScope -Recurse -File |
  Where-Object { $_.LastWriteTime -gt $t -and $_.FullName -notmatch '\\(build|\.cxx|node_modules|oh_modules)\\' } |
  Select-Object LastWriteTime, FullName
# 期望：**空**。非空 ⇒ 回到 §7 重新构建，不要往下走。

# ② 复制
Copy-Item $build $dist -Force

# ③ 断言 sha256 相等（这一步是本次事故的直接补丁）
if ((Get-FileHash $build).Hash -ne (Get-FileHash $dist).Hash) { throw '交付包与构建产物不一致' }

# ④ 重算校验值与 README（sha256 / 字节数 / MiB / MB 四处都要按实际重算）
$h = (Get-FileHash $dist).Hash.ToLower()
$n = (Get-Item $dist).Length
"$h  DSHM-1.0.0-arm64-signed.hap" | Set-Content -Encoding ascii dist\sideload\SHA256SUMS.txt
"$n B = $([math]::Round($n/1MB,1)) MiB = $([math]::Round($n/1e6,1)) MB"
```

**关于 ① 的一个实测说明**：本机此刻跑这个断言会**命中两条**
（`appstate/src/main/ets/model/PiAiProviders.ets` 17:39、`fish_logo.svg` 17:39，
而 HAP 是 17:22）——但 `fish_logo.svg` 的 sha256 与 HAP 内那一份**相同**
（都是 `02f91389…005E9`），说明它只是被**重放了一次生成器**、内容没变。
`PiAiProviders.ets` 的字面量在 HAP 字节码里也能全部找到（17/17 命中）。
⇒ **时间戳断言是"可疑信号"，不是"有罪判定"**：命中后要按内容复核，
不能只凭 mtime 就重编（也不能只凭 mtime 就放过）。

### 9.3 本条纪律的推广形式

> **凡"把产物 A 复制成交付物 B"的步骤，都必须写成"先断言 A 比所有输入都新 → 复制 → 断言
> sha256 相等 → 重算校验值"这四步**，而不是"复制 + 记个哈希"。
> 因为**顺序错误**（先复制后改代码）在单次执行里是完全合法的，只有断言能拦住它。

**注意**：仓库里**没有任何脚本**在做这件事——
`Select-String -Path tools\* -Pattern 'sideload'` 命中 **0**。
也就是说这四步目前是**手工纪律**，不是代码约束。
`README.md`／`SHA256SUMS.txt`／实际文件三方一致这件事，每次都靠人复核
（前两次事故分别发生在 `docs/device-validation.md:4286-4293` 与 `:4373-4384`）。
**这是本章登记的一个真实缺口**：它值得一个 `tools/refresh-sideload.ps1`。

---

## 10. 步骤 9：体积账

### 10.1 HAP 总量与构成（签名版，本机实测，2026-09-29 22:48 / 核心 0.2.0-rc.2）

| 分组 | 条目数 | 字节 | MiB | 占比 |
|---|---:|---:|---:|---:|
| `libs/arm64-v8a/*` | 59 | 191,791,760 | 182.91 | 61.44% |
| `└ libnode.so.137` | 1 | 126,809,264 | 120.93 | 40.62% |
| `└ libpython3.12.so.1.0` | 1 | 20,461,032 | 19.51 | 6.55% |
| `└ libvips 家族`（含 sharp 与 44 个库） | 45 | 23,889,984 | 22.78 | 7.65% |
| `└ CMake 编出 + HAR 带入`（`libkoffi`/`libdshhost`/`libsystem`/`libpython_runner`/`libentryprobe`/`libdshm-gitcompat` + onnxruntime + sherpa 2 件 + `libc++_shared` + `libz`） | 11 | 20,587,640 | 19.63 | 6.60% |
| `└ libpty.so` | 1 | 43,840 | 0.04 | 0.01% |
| 核心树 zip（`resfile/dsh-core-*.zip`） | 1 | 78,081,448 | 74.46 | 25.01% |
| `resources/` 其余 | 44 | 37,744,474 | 36.00 | 12.09% |
| `└ toolchain/python/`（归档 + 标记） | 2 | 27,720,031 | 26.44 | 8.88% |
| `└ toolchain/git/`（15 apk + 标记） | 16 | 8,501,150 | 8.11 | 2.72% |
| `└ busybox` | 1 | 1,042,048 | 0.99 | 0.33% |
| `└ hostcore 入口（`resources/app/*`，9 文件 + package.json）` | 10 | 388,800 | 0.37 | 0.12% |
| `└ 媒体 / skills / rawfile / profile` | 15 | 92,445 | 0.09 | 0.03% |
| `ets/` 与其他（`modules.abc`/`sourceMaps.map`/`module.json`/`pack.info`/`.pages.info`） | 7 | 4,540,262 | 4.33 | 1.45% |
| **条目合计（stored，未压缩）** | **111** | **312,157,944** | **297.70** | 100% |
| 中央目录 + 签名块 | — | 2,008,818 | 1.92 | — |
| **`.hap` 文件** | — | **314,166,762** | **299.62** | — |

`libs/` 的 59 = 1（libnode）+ 1（libpython）+ 45（libvips 家族）+ 11（CMake 编出 / HAR 带入）+ 1（libpty）。
其中第 5 行那 11 个，**10 个只存在于 HAP**（`libc++_shared.so` / `libdshhost.so` / `libdshm-gitcompat.so` /
`libentryprobe.so` / `libkoffi.so` / `libonnxruntime.so` / `libpython_runner.so` / `libsherpa-onnx-c-api.so` /
`libsherpa_onnx.so` / `libsystem.so`），另 1 个 `libz.so` 在 `entry/libs/arm64-v8a/` 里也有。
逐条实测：HAP `libs/` 59 条、`entry/libs/arm64-v8a/` 49 条，`only-in-HAP` = 10 条（即上面那 10 个）、
`only-in-repo` = 0 条。
**vips 家族的 45 件**判据是核心 manifest 的 `native.signed` 清单（47 项里 45 项来自
`@ohos-ports/img-sharp-libvips-openharmony-arm64/lib/*`（44 个 `.so`）+ `@ohos-ports/img-sharp-openharmony-arm64/lib/sharp-openharmony-arm64.node`
（其一，对应 HAP 里的 `libsharp-openharmony-arm64.so`），另 2 项是 `node-pty` 的 `pty.node` / `spawn-helper`，不在 `libs/` 下）。
注意 manifest 里记的是 `libvips.so.42.20.3` 这类**带版本号的名字**，入 HAP 后统一改名为 `libvips.so`，
所以**不能按文件名直接对表**，要按去版本号的基名比。

> **关于"压缩"**：本 HAP 内**所有条目 `compress_type == 0`（stored，不压缩）**
> （实测 `sorted({i.compress_type for i in z.infolist()}) == [0]`）。
> 所以"解包体积"与"条目字节和"是同一个数——**不要**以为 299.62 MiB 是压缩后的。
> 单位口径：299.62 MiB = 314.17 MB（十进制）= 314,166,762 B，同一个文件三种写法。

### 10.2 各次回收

| 时点 | 动作 | 效果 | 证据 |
|---|---|---|---|
| 阶段一收尾 | 移除 Electron 链（`libadapter.so` / `libelectron.so` / `libffmpeg.so`）与 `entry` 对 `web_engine` 的依赖 | **−190 MB** | docs/70 §3.6、docs/50 E49② |
| 批次八 | 拆除 `execDiagnostics` + 删 `resfile/toolchain/elf/` 裸 ELF 段（52.4 MB：python3.12 22.1 + libpython 22.1 + rg 4.6 + git 2.9 + git-remote-http 0.7） | HAP **327 → 274.6 MB（−52.4 MB）** | docs/device-validation.md:827-878 |
| 语音模型改在线下载 | HAP 内不再内嵌 228 MB 模型（`rawfile/sensevoice` 条目 0） | **550.3 → 320.1 MB（−230.2 MB）** | docs/device-validation.md:3754-3760 |
| HAR 源裁剪 x86_64 | 解包 HAR 删 `package/libs/x86_64`（4 个文件 / 21,397,080 B = **20.41 MiB**）后重打包 | **320.1 → 299.5 MB（−20.6 MB）** | 同上；本机复核 `.har` 4 个 `arm64-v8a` / `.har.bak` 8 个含 `x86_64` |
| 构建期 `DoNativeStrip` | hvigor 自动 strip `entry/libs` 后入库 | **回收 10.43 MiB**（49 个同名条目磁盘 173.82 MiB → HAP 163.39 MiB）；另有 10 个 HAP 独有件（CMake 编出 + HAR 带入）19.52 MiB | 本机逐条目比对；`entry/build/default/intermediates/stripped_native_libs/` 59 个文件 |

**当前状态**：299.62 MiB（2026-09-29 22:48 产物，核心 0.2.0-rc.2）。项目自身体积门是 `≤ 400 MB`（docs/50 §7 的 G2″，docs/device-validation.md:3389），
**已达标**。

### 10.3 体积的下一步空间（如实登记，未做）

- `libs/arm64-v8a/` 里 59 个条目中，有 **45 个**是"libvips 家族"（含 `sharp` 绑定与它的
  依赖闭包），HAP 内合计 **23,889,984 B = 22.78 MiB** = `libs/` 的 12.5% / 整包的 7.65%。
  它们服务于**图片附件**（sharp）。若产品接受"图片附件降级"，这一段可整体回收——
  但那是**产品决策**，不是构建优化。
- `libnode.so.137` 单件 120.93 MiB（占 HAP 40.5%）是自建 Node 运行时，**不可裁**。
- 核心树 zip 74.46 MiB 已按"只删命中的路径，绝不广谱清理"（`core-recipe.json` 的 `$comment_prune`）裁过；
  `core-recipe.json:51` 记着一个**尚未启用**的候选裁剪项（`@ohos-ports/img-sharp-wasm32`），
  注释写明**先不启用**的理由：需要先确认 sharp 的加载器是不是**无条件** `require` 这个包——
  "若是条件 require，删掉安全；若无条件，删掉会直接抛错。这一步要能跑一次 Node 才能验，**别凭猜删**"。
  **这正是一个"看起来明显能删、但缺少一条证据"的例子**，值得保留该注释而不是现在就删。

---

## 11. 一条完整的命令串（顺序纪律）

```bash
# ── 前置（一次）──
# 备齐 third_party/、entry/libs/、entry/src/main/cpp/node-headers/、Har 裁剪（见 §1）

# ── 生成物重放（改了哪一类跑哪一条，顺序不可颠倒）──
node tools/pack-core.mjs --skip-install --place-in-app   # ① 核心树（改了 core-recipe / pack-core 补丁 / 上游版本）
node tools/place-host-app.mjs                            # ② 入口脚本（改了 hostcore/app/**）
node tools/assert-resfile-sync.mjs                       #    必须绿（漏跑 ② 的唯一防线）
node tools/place-toolchain.mjs                           # ③ 工具链（改了 place-toolchain / 换了 python|git 素材）
node tools/check-toolchain-sign.mjs                      #    必须绿（E-TS1 的防线）
node tools/gen-fish-logo.mjs                             # ④ 鲸鱼 SVG（改了核心版本 ⇒ 官方几何可能变）
python tools/make-icon.py                                # ⑤ APP 图标（改了 ④ 或图标设计；**不要**顺手改启动画面）
node tools/check-icon-assets.mjs                         #    必须绿

# ── 门禁（改任何东西都要跑）──
node tools/assert-cli-shim.mjs
node tools/assert-resfile-sync.mjs
node tools/check-parity.mjs
node tools/compat-drift.mjs
node tools/assert-exec-fix.mjs
node tools/assert-python-bridge.mjs
node tools/assert-fs-search-fallback.mjs
node tools/check-toolchain-sign.mjs
node tools/check-icon-assets.mjs
node tools/check-native-closure.mjs
node tools/check-store-readiness.mjs
.\tools\device-acceptance.ps1        # 真机端侧验收

# ── 构建（§7.1 的四行环境变量 + assembleHap）──

# ── 装机（唯一允许的入口）──
.\tools\update-device.ps1

# ── 交付包归置（§9.2 的四步，**必须在最后一次构建之后**）──
```

**顺序纪律的三条硬约束**：

1. **`place-host-app` → `assert-resfile-sync` → `build`**：快照失同步是**静默**的
   （批次备注八事故：门禁链漏跑 `place-host-app`，resfile 里的 `main.js` 停在上一次拷贝的快照，
   build 忠实打包旧文件，**全程零报错**，直到装机后 `tail dshm-host.log` 才发现设备在跑旧代码）。
2. **`place-toolchain` 必须在 `build` 之前**：它要就地把 `entry/libs/arm64-v8a/libpython3.12.so.1.0`
   写好——那是 `PackageHap` 的输入。
3. **交付包归置必须在最后一次 `build` 之后**：见 §9.1 的事故。

---

## 12. 常见失败与定位（速查）

| 现象 | 最可能的原因 | 第一步动作 |
|---|---|---|
| `SignHap` 报 `spawn java ENOENT` | `PATH` 里没有 `jbr\bin`（`JAVA_HOME` 不够） | `$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"` |
| `SignHap` 报 `bundleName … does not match` | 签名 `.p7b` 绑的 bundle 名 ≠ `build-profile.json5` 的 `bundleName` | 去 DevEco GUI 对目标 bundle 重新生成签名（§7.3） |
| 装机后 `exec 探测` 只有 2/7 | 工具链归档**未签名**（E-TS1） | `node tools/check-toolchain-sign.mjs`；若标记缺失 ⇒ 跑 `place-toolchain.mjs` 并看它有没有 `exit 1` |
| 装机后设备在跑旧代码 | 漏跑 `place-host-app.mjs` | `node tools/assert-resfile-sync.mjs` |
| 改了 pack-core 补丁但设备行为没变 | 幂等标记让新版注入不进去（E-SV14） | 升 `MARK_VERSION`；确认"删旧段再注入"那段没被跳过 |
| `pack-core` 报"上游实现已变化，拒绝静默跳过" | 升级了 dsh，锚点文本变了 | **去核对锚点**，不要为了让它过而放宽判定 |
| 交付包与 build 不一致 | 归置顺序错（E-DL1） | 按 §9.2 四步重做 |
| `包元信息错误` 红字 | app-boot 只读 `message`/`stack` 赋值抛错（已修） | 确认 `patchAppBootReadonlyStack` 在补丁串里 |
| `web_fetch` 打不开网页、`web_search` 正常 | `undici` 模块名钩子未注册 / 缺 `undici-shim.mjs` | `assert-resfile-sync` + 检查 resfile 里那两个 `.mjs` |
| 首次启动白屏、重启就好 | 宿主首启解包 6~7 s，WebView 早于它就绪 ⇒ 404（E-SV18） | 是**竞态**，修在自愈（`scheduleAutoRetry`），不是构建问题 |

---

## 13. 本章结论（给接手人的三句话）

1. **顺序是知识，不是风格**：`pack-core` 内部的 ㉔ 必须在最后、`place-host-app` 必须在
   `assert-resfile-sync` 之前、交付包必须在最后一次构建之后。三条都各有一场事故作为依据。
2. **幂等标记是这套流水线的重心**：8 处"标记字面量"双名判定（新 `DSHM_*` + 旧 `HDSH_*`）、
   1 处 `MARK_VERSION` 版本标记（原生采集注入）、3 处"包版本号"式标记
   （`sharp` 的 `0.0.0-dshm-dispatch`、`koffi` 的 `3.2.1` + 包名 + 文件存在三条合判、
   `node-addon-system` 的 `0.1.2-dshm-shim`）。
   改标记名必须同时认旧名；同位注入必须带版本。这两条各自有一次"改了但没生效"的真事故。
3. **"静默成功"比"失败"危险得多**：本章里的 E-TS1（签名静默跳过）、E-TS2（标记是常量）、
   E-DL1（交付包陈旧）、批次八（resfile 快照失同步）四件事的**共同形态**都是
   "构建全绿、装机后才发现"。所以每一步都要有一条**能红的断言**，而不是一段"应该没问题"的说明。

---

# 第三章 端侧运行时：HAP 里有什么、启动时发生什么

## 1. HAP 的目录布局与职责

### 1.1 实测的 HAP 条目清单

下面这份清单是**对当前产物逐条读出来的**（111 个条目），不是设计文档里的设想：

```bash
# 按目录桶统计 HAP 条目（用随项目可用的 Python zipfile，不依赖 unzip）
python - <<'PY'
import zipfile, collections
z = zipfile.ZipFile("entry/build/default/outputs/default/entry-default-signed.hap")
b = collections.Counter()
for n in z.namelist():
    p = n.split("/")
    if n.startswith("libs/"):            k = "libs/" + p[1]
    elif n.startswith("resources/resfile/"): k = "resources/resfile/" + "/".join(p[2:4])
    elif n.startswith("resources/"):     k = "resources/" + "/".join(p[1:3])
    else:                                k = "/".join(p[:1])
    b[k] += 1
for k, v in sorted(b.items()): print(f"{v:8d}  {k}")
PY
```

| 条目数 | 位置 | 关键读法 |
|---|---|---|
| 59 | `libs/arm64-v8a/*.so` | 含 `libnode.so.137`（126,809,264 B）与 `libpython3.12.so.1.0`（20,461,032 B） |
| 1 | `resources/resfile/dsh-core-0.2.0-rc.2-openharmony-arm64.zip` | 78,081,448 B，dsh 核心树的容器 |
| 10 | `resources/resfile/resources/app/` | 宿主入口脚本族（见 §6） |
| 16 + 2 | `resources/resfile/toolchain/git/`、`toolchain/python/` | 15 个 Alpine apk + 1 个签名标记；1 个 CPython 归档 + 1 个签名标记 |
| 1 | `resources/resfile/busybox/busybox` | 1,042,048 B，arm64 静态 busybox |
| 5 | `resources/resfile/ohos-skills/*.md` | 端侧知识技能（Python/Shell/PC/工作区/插件安装） |
| 6 | `resources/base/media/*` | 图标与鲸鱼 SVG（见 §1.2） |
| 2 | `resources/rawfile/tray_{white,black}.png` | 状态栏托盘图标（494 / 441 B） |
| 2 | `resources/base/profile/` | `main_pages.json`、`backup_config.json` |
| 2 | `ets/` | `modules.abc`（3,012,044 B）+ `sourceMaps.map`（1,481,152 B） |

**只有 111 个条目**这件事本身就是一条设计结论：核心树的 2.9 万个条目**不在 HAP 里平铺**，而是压在一个 zip 里（`tools/pack-core.mjs` 的自建 zip 写入器，`tools/pack-core.mjs:2796-2897`）。原因见 §2。

### 1.2 每个位置放什么、谁生成它

| 位置 | 里面是什么 | 谁生成 | 该由谁维护 |
|---|---|---|---|
| `resources/resfile/*.zip` | dsh 核心树（**518 个包 / 26,066 文件 / 252,069,490 B（240.8 MiB）解包后**，`dist/core/dsh-core-0.2.0-rc.2.manifest.json`；解包后树里 `dsh-client-ui-*` 53 个） | `node tools/pack-core.mjs --skip-install --place-in-app`（放置点：`tools/pack-core.mjs:2924-2945`） | `hostcore/core-recipe.json`（唯一事实来源）+ `tools/pack-core.mjs` 的补丁函数 |
| `resources/resfile/resources/app/` | `main.js` / `fetch-shim.js` / `undici-shim.mjs` / `undici-loader.mjs` / `require-builtin-shim.cjs` / `dshm-installer.js` / `dshm-user-rows.js` / `dshm-skills.js` / `dshm-compat.js` / `package.json`（**10 件**） | `node tools/place-host-app.mjs`（清单：`tools/place-host-app.mjs:29` 的 `FILES`；`package.json` 由脚本内联生成，`:43-50`） | `hostcore/app/`（源），放置件是**快照** |
| `resources/resfile/toolchain/{python,git}/` | CPython 3.12.14 musl 归档（27,720,007 B）+ Alpine git 2.47.3 及 14 个依赖 apk（合计 8,501,127 B） | `node tools/place-toolchain.mjs`（目标目录：`tools/place-toolchain.mjs:31`） | `third_party/`（不入库） |
| `resources/resfile/busybox/busybox` | 单文件多合一 busybox | 入库资产（不在 `tools/` 脚本里生成） | 手工更新 |
| `resources/resfile/ohos-skills/*.md` | 5 个技能文档 | 入库资产 | 手写 |
| `libs/arm64-v8a/*.so` | 49 个入库件 + **10 个构建产出**（见下） | 入库件来自 `tools/node-runtime/`、`tools/collect-libvips.mjs`；构建件由 hvigor 的 CMake 与 HAR 合并 | 见 §1.3 |
| `ets/modules.abc` | ArkTS 编译后的字节码 | `devecocli build` 的 `CompileArkTS` 任务 | ArkTS 源码 |
| `resources/base/media/fish_logo.svg` | 官方鲸鱼路径（逐字节取自核心树的 `FISH_LOGO_PATH`） | `node tools/gen-fish-logo.mjs`（`:125` 输出路径） | 生成器 |
| `resources/base/media/{foreground,background}.png`、`layered_image.json`、`startIcon.png`、`logo_dark.png` | 应用图标 / 启动图 | `python tools/make-icon.py`（**`tools/make-brand-assets.mjs` 已废弃**，它会拒绝执行：`:19-25`） | 生成器 |

**`libs/` 里入库件与构建产出的区分方式**（这是接手时最容易误判的一处）：仓内 `entry/libs/arm64-v8a/` 只有 **49 个文件**，HAP 里是 **59 个**。多出来的 10 个全部由构建链产生：

| 构建件 | 来源 |
|---|---|
| `libdshhost.so`（133,144 B） | hvigor CMake 编 `hostruntime/src/main/cpp/dshhost.cc`（`entry/src/main/cpp/CMakeLists.txt:31-33`） |
| `libentryprobe.so`（5,808 B） | CMake 编 `entry/src/main/cpp/probe.cpp`（`CMakeLists.txt:28`）；它是 E30 对照实验的**留存证据**，说明"CMake 路径能绑定、手工拷 .so 不能" |
| `libkoffi.so`（1,600,112 B） | CMake 从 `third_party/koffi/` 编译（`CMakeLists.txt:127-148`） |
| `libsystem.so`（10,464 B） | CMake 从核心树的 `node-addon-system/src/flock.c` 编译（`CMakeLists.txt:198`） |
| `libpython_runner.so`（94,464 B） | CMake 编 `entry/src/main/cpp/python_runner.cpp`（`CMakeLists.txt:224-231`） |
| `libdshm-gitcompat.so`（5,472 B） | CMake 编 `entry/src/main/cpp/gitcompat.c`，`OUTPUT_NAME` 特意改为 `dshm-gitcompat`（`CMakeLists.txt:260-263`） |
| `libc++_shared.so`（1,262,504 B） | OHOS 工具链运行时 |
| `libonnxruntime.so`、`libsherpa-onnx-c-api.so`、`libsherpa_onnx.so` | `third_party/sherpa_onnx-1.13.3.har`（`entry/oh-package.json5` 的 `dependencies`） |

**为什么必须用 CMake 路径而不是"编好再拷进 `entry/libs/`"**：这是 E25–E30 五轮排查的结论 —— 手工放进 `entry/libs/` 的预编译 `.so`，运行时 `dlopen` 得到的是**别的模块**（`import … from 'libdshhost.so'` 拿回 ArkUI 节点 API，导出全是 `undefined`），而经 hvigor CMake 构建的同一份源码能绑上（`entry/src/main/cpp/CMakeLists.txt:11-19` 的注释、`docs/50-端侧核心运行架构.md` E30）。所以 **不要**为了省事把 `.so` 拷进 `libs/`。

### 1.3 入库边界

`entry/libs/`、`entry/src/main/cpp/node-headers/`、`resfile/*.zip`、`resfile/toolchain/`、`resfile/resources/app/` **全部不入库**（`.gitignore:33-45`），它们由 README「构建」的四条命令重建。`resfile/busybox/` 与 `resfile/ohos-skills/` **入库**（`.gitignore` 没有覆盖它们）。

> **判据**：能由 `tools/` 下的脚本重放的 → 不入库；只能手工取得或手写的 → 入库。改这条边界前先想清"新克隆能不能只靠 README 备齐"。

### 1.4 验证

```bash
# 1) HAP 条目布局（上表可复跑）
python -c "import zipfile;z=zipfile.ZipFile('entry/build/default/outputs/default/entry-default-signed.hap');print(len(z.namelist()));[print(i.file_size, i.filename) for i in z.infolist() if 'resfile' in i.filename]"
# 2) 入口脚本快照是否与源一致（这道门禁存在的理由见 §6.5）
node tools/assert-resfile-sync.mjs
# 3) libs 数量口径
python -c "import zipfile;z=zipfile.ZipFile('entry/build/default/outputs/default/entry-default-signed.hap');print(len([n for n in z.namelist() if n.startswith('libs/')]))"
```

---

## 2. 首次启动的解包

### 2.1 为什么不能直接在 zip 上跑

本项目**没有**实现"从归档里直接 require/exec"的虚拟文件系统，理由是几条可证据化的约束叠在一起：

1. **resfile 是只读资源**。HAP 内的资源在安装后被解压到沙箱，可以按**真实文件路径只读访问**（`entry/src/main/resources/resfile/resources/app/main.js` 就是以真实路径被读的，`docs/70-鸿蒙移植踩坑与修复总览.md:317-321`）。
2. **解压 API 要求目标目录可读写**，所以 `BundledCore` 必须先做一次"只读资源 → 可写目录"的拷贝：`// 第一步：把只读的 resfile 拷到可写目录（解压 API 要求可读写路径）`（`hostruntime/src/main/ets/core/BundledCore.ets:139`，拷贝动作在 `:143`）。
3. **工作目录契约锚在真实文件系统上**。运行期的一切路径知识都假设核心树是普通目录：`main.js` 用 `path.join(CORE_DIR, 'node_modules', …)` 去 `require` 三个硬原生依赖（`hostcore/app/main.js:731`）、用 `fs.existsSync` 判断 dsh CLI 入口（`:3781`）、用 `readdirSync` 找 profile-boot 薄入口（`:3565`）。
4. **原生件必须被重定向到 HAP `libs/`，而重定向的判据是"沙箱里的路径 → libs 下的平铺文件名"**（`hostcore/app/main.js:284-322`）。若核心树不以真实文件存在，`existsSync` 与 `Module._resolveFilename` 两层钩子都失去可判断的对象。

> **未验证**：本节没有实测过"挂载 zip 跑 Node"这条路，也没有查到 hmfs（鸿蒙沙箱文件系统）对归档 mmap/exec 的官方结论。上文 1–4 条是**本项目已实现路径的依据**，不构成"平台绝对做不到"的证明。

### 2.2 解包到哪里、机器怎么走

布局（`hostruntime/src/main/ets/core/CoreStore.ets:5-9`）：

```text
<filesDir>/dsh/
  ├── cores/<version>/             已安装的某一版核心树（内含 dshm-core.json 元数据）
  ├── cores/<version>.staging/     正在解包/校验，未激活
  ├── home/                        $DSH_HOME：跨版本共享的唯一一份用户数据
  └── state.json                   { current, previous, history }
```

首启的实际动作序列（`BundledCore.installBundledCores`，`BundledCore.ets:48-205`）：

| 步 | 动作 | 代码 |
|---|---|---|
| 1 | 列 resfile，用 `parseArchiveName` 认出自家的容器（不是就不猜、跳过） | `:85-89`、`hostruntime/src/main/ets/core/Naming.ets:51-57` |
| 2 | 已装的版本比**归档字节数**指纹：一致才跳过 | `:101-114` |
| 3 | 指纹不同 ⇒ 旧树 `renameSync` 成 `<coreDir>.stale-<ts>.tmp`（毫秒级），删除推迟到末尾**异步**做 | `:126-135`、`:187-193` |
| 4 | 把 zip 拷到 `<workDir>/bundled-<name>`（调用方给的是 `cacheDir`，`entry/src/main/ets/entryability/EntryAbility.ets:396`） | `:137-143` |
| 5 | `zlib.decompressFile(zipPath, staging)` | `CoreStore.ets:349` |
| 6 | 校验顶层目录 + `dshm-core.json` + **三件哨兵** | `CoreStore.ets:356-376`、`:412-442` |
| 7 | `renameSync(inner, target)` 落位，清 staging | `CoreStore.ets:389-390` |
| 8 | 写指纹 `.dshm-bundled-stamp` | `BundledCore.ets:149-159` |
| 9 | `finally` 删临时 zip（63 MB × N 份留在沙箱是纯浪费） | `BundledCore.ets:169-178` |

**为什么"删旧树"必须是 rename + 异步删除**（这是本项目最贵的一次教训）：换包后首次启动，同步 `rmdirSync(旧树)` 删 216 MB / 25k 文件把 ArkUI 主线程锁死十余秒，系统以 `Reason:LIFECYCLE_TIMEOUT` + `SYS_FREEZE` 直接 kill 进程，表现为"应用起来就消失、连一条自己的日志都没有"（`BundledCore.ets:116-125`；`docs/50-端侧核心运行架构.md` E45）。**纪律：安装/删除路径上不得出现任何"删几万个文件"的同步调用。**

**为什么要三件哨兵而不是"解压成功就算成功"**：`zlib.decompressFile` 会校验每个条目的 CRC，所以截断的 zip 通常在那一步就失败；但"解压成功、树却不对"仍有真实可能（容器不是我们的、打包漏了某类文件、磁盘不足时提前返回），而它的症状最难查 —— **装上了、也激活了，直到启动时才以"某个插件加载失败"的形态冒出来**。哨兵只查三件"缺了宿主必然起不来"的东西：`@deepseek-ai/dsh/package.json`、`koffi.node`（abis 里任一命中）、`profiles/ondevice/cordis.patch.yml`（`CoreStore.ets:400-442`）。**刻意不做全树计数**：2.5 万文件的遍历正是端侧要避免的同步大目录操作。

### 2.3 `.dshm-bundled-stamp`：指纹、作用、删它的后果

**它是什么**：解包成功后写在 `<coreDir>/.dshm-bundled-stamp` 里的一串**资源包字节数**（`BundledCore.ets:152-158`）。

**为什么必须有它**：原来的判据是"版本已装即跳过"。代价是 —— **换了核心包（补了平台别名、改了补丁）并重装应用后，端侧仍报「内置核心已全部安装过，无需重复解包」**，设备上一直跑旧树，新改动根本没进去。这不只是调试便利：**没有它，"核心版本安装/切换/回滚"这条功能形同虚设**（`BundledCore.ets:91-94`）。

**为什么重解包要删它**：指纹是"归档字节数 vs 上次记下的字节数"。改 `hostcore/**` 只影响入口脚本（进 HAP），不影响核心 zip；改 `tools/pack-core.mjs` 的补丁但产物大小恰好相同，设备也**不会**更新。装机后固定删 stamp 可消除这个不确定性（`docs/device-validation.md:3150`）。

**删它的代价（必须写清）**：该次启动要重解 26,066 个文件（`0.2.0-rc.1` 时代为 26,267 个），实测宿主启动耗时 **+6,648 ms**（`docs/device-validation.md:3606-3607`、`:3615`）。由此引出一个**安装流程导致的启动竞态**：WebView 早于宿主就绪发起加载 ⇒ 拿到 HTTP 404 ⇒ `fail()` ⇒ `phase=ERROR` ⇒ 白屏；重启即恢复（`docs/70-鸿蒙移植踩坑与修复总览.md` E-SV16）。**所以删 stamp 只能当"验证新代码真的进了设备"的手段用，不能进常规装机流程。**

**删 stamp 是安全的**：它是几十字节的安装元数据，只影响"下次启动是否重解包"，不碰用户数据（`docs/device-validation.md:3159`）。

### 2.4 首启 60–90 秒的来源

先给实测规模（当前核心版本）：

| 项 | 数值 | 出处 |
|---|---|---|
| 核心 zip | 78,081,448 B / 29,351 条目 | `dist/core/dsh-core-0.2.0-rc.2.manifest.json` |
| 核心树解包后 | 26,066 文件 / 252,069,490 B（node_modules 部分） | 同上 |
| CPython 归档 | 27,720,007 B / 4,530 文件 | 仓内实测；`docs/device-validation.md:642` |
| git apk 组 | 15 个包，合计 8,501,127 B | 仓内实测（与 `toolchain/git/dshm-signed.txt` 的标记一致） |

时间量级有两处**有出处的**读数：

1. **侧载包 README 的口径**：`首次启动会解包核心树（约 60–90 秒）`（`dist/sideload/README.md:27`，同 `:89`）。
2. **日常冷启动逐段实测**（不删 stamp 的稳态）：`aa start → Node 起来 ~2.1 s`、`Node → BOOT_40 0.3 s`、`BOOT_40 → BOOT_50 7.4 s`、`→ BOOT_70 0.2 s`、`WebView 加载 → 200 1.7 s`，**合计 ~10.1 s**（`docs/device-validation.md:3927-3934`）。

**这两个数字差在哪儿**：稳态 ~10 s 里**不含核心解包**（trees 已在设备上）；首启的 60–90 s 额外包含：① 26,066 文件的 `decompressFile`（`0.2.0-rc.1` 时代为 26,267 个）；② 首启必然触发的**工具链后台解包**（`main.js:3197-3301`：`tar xmzf` 解 CPython 4,530 文件 + 15 个 apk，`hmfs` 上每个文件还会打一条 `settime: Permission denied`）；③ 首次 core 执行位补齐与 exec 探测（`main.js:2204-2235`、调用点 `:3410-3412`）。

> **未验证**：本项目**没有**对首启做过"核心解包 vs 工具链解包"的逐段计时分解，上面 ①②③ 是按代码路径列出的耗时来源，不是分摊过的实测值。要拿到分解，可在 `installBundled` 前后与 `finishToolchainExtraction` 处临时插桩（注意：**临时插桩必须在同一次改动内撤除**，见 `docs/device-validation.md:3940-3943` 的先例）。

**首启为什么不能"少解一点"**：
- 核心树不能按需解 —— dsh 的 loader 在启动时就要见到整棵 `node_modules`（`:3788-3791` 检查 `dsh-app-boot`、`:3565` 扫 profile-boot 入口）。
- 工具链解包已经做成**后台子进程**（`spawn busybox ash -c …`，`:3282-3284`），刻意不阻塞启动，因为 28.6 MB / 4,530 文件同步解会卡死 Host 事件循环、拖垮 boot 探针（`:1875-1877`）。
- 唯一真实的压缩空间是**减少核心树体积**（配方里的 `prune` 规则，`hostcore/core-recipe.json:16-50`）与**减少启动插件数**（见 §3.2）。

### 2.5 验证

```bash
# 容器规模与指纹（构建侧）
cat dist/core/dsh-core-0.2.0-rc.2.manifest.json
# 真机：stamp 与已装版本（读设备需要 hdc，路径见 §7）
hdc shell "ls -la /data/app/el2/100/base/com.dshm.dshclient/haps/entry/files/dsh/cores"
hdc shell "cat  /data/app/el2/100/base/com.dshm.dshclient/haps/entry/files/dsh/cores/<ver>/.dshm-bundled-stamp"
# 真机：首启/重解包只在 node-output.log 留下 BOOT_* 与 DSHM_READY（见 §3.4）
hdc file recv /data/app/el2/100/base/com.dshm.dshclient/haps/entry/files/node-output.log ./node-output.log
grep -E "BOOT_(10|40|50|60)_|DSHM_READY" ./node-output.log
```

---

## 3. 启动序列：BOOT_00 → BOOT_70

### 3.1 为什么要把启动切成显式阶段

端侧只有 hilog 可看（应用进程的 stdout 在设备上不可见，`docs/50-端侧核心运行架构.md` E23），而"Host 没起来"这类问题最贵的成本是**猜停在哪一步**。所以把启动过程切成显式阶段：**成功的最后一段 + 失败的第一段，本身就是结论**（`hostcore/app/main.js:614-632`）。

`stage()` 的实现只有三行，但关键在于它打的是**从脚本第一行起算的相对毫秒**：

```js
const BOOT_T0 = Date.now();
function stage(name, extra) {
  bootStage = name;
  console.log(`[dshm-host] ${name}${suffix} (+${Date.now() - BOOT_T0}ms)`);
}
```

（`hostcore/app/main.js:633-639`）

### 3.2 逐阶段：每步在做什么、实测耗时

| 阶段 | 行号 | 这一步在做什么 | 耗时（有出处的实测） |
|---|---|---|---|
| `BOOT_00_NODE_START` | `:640-641` | 打出 pid / node 版本 / platform / **是否真的 jitless**。能读到它就说明 `libnode` + `node::Start` 成立 | — |
| （前置，未编号） | `:71-555` | 诊断引导、`process.exit` 拦截、`node:http` getter 封堵、原生库重定向、三个垫片、execPath 兜底。**全部在 BOOT_00 之前**，因为后文任何一行都可能抛错或退出 | 实测 `aa start → Node 起来` ≈ **2.1 s**（含 libnode 初始化与 libuv io_uring 关闭，`docs/device-validation.md:3929`） |
| `BOOT_00 → BOOT_40` | `:640`→`:3828` | 环境解析 + 核心定位 + profile 就位（不含 `recoverOrphanLocks`，它在 `:3834` 且发生在 `BOOT_40` 之后） | 实测 **0.3 s**（`docs/device-validation.md:3930`：`Node → BOOT_40 0.3 s`） |
| `BOOT_10_ENV_READY` | `:3778-3779` | 打出 core/home/sandbox/port/profile 的**实际取值**，便于核对是否指向错目录。进入 `start()` 后先跑 `reportConfigError()`（`:899-908`）：缺 `DSHM_CORE_DIR`/`DSHM_HOME` 时**不 throw、不 exit**，只记录并让 Host 不启动 | 同上 |
| `BOOT_20_CORE_FOUND` | `:3780-3793` | 三处存在性检查：`@deepseek-ai/dsh/lib`（CLI）、profile-boot 薄入口（`findProfileBootEntry`，`:3564-3580`）、`dsh-app-boot/lib/index.js`。缺任一处 `fail()` | 毫秒级 |
| `BOOT_30_PROFILE_READY` | `:3794-3796` | `ensureDir(HOME_DIR)` + `ensureProfile()`（`:3609-3737`）：把核心树里的 `profiles/ondevice` 装到 `$DSH_HOME/profiles/ondevice`，合并 bundles、拼用户行、洗坏依赖/坏 bundle/坏 home-patch | 毫秒级（不含 `recoverOrphanLocks`） |
| （阶段间） | `:3798-3800` | `await import(entry)` + `await import(appBoot)` —— 动态 import dsh 本体 | 计入 40→50 |
| `BOOT_40_PROFILE_BOOT` | `:3828` | 即将 `runProfile`。**插件树从这里开始挂载** | 基准点 |
| **`BOOT_40 → BOOT_50`** | `:3838-3844` | `profileBoot.runProfile({ environment, profile, patchFiles: [], args })` 内部：dsh 解析 profile、装载插件树 | **7.4 s** ★（`docs/device-validation.md:3931`；另一次同批读数 `BOOT_40 (+317ms) → BOOT_50 (+7765ms)`，`:4009`） |
| `BOOT_50_DSH_INIT` | `:3844` | `runProfile` 已返回且拿到 `ctx`；`!ctx.webServer` 即 `fail()` | — |
| `BOOT_60_HTTP_BIND` | `:3850` | `ctx.webServer.port` 存在（dsh 已绑定端口） | `BOOT_50 → BOOT_70` 合计 **0.2 s**（`:3932`） |
| `BOOT_62_PY_BRIDGE_HTTP` | `:2676` | `/dshm-python/status|run-get|exec` 已注册（失败只 `diag`，不影响已验证的 web 链路） | 毫秒级 |
| `BOOT_63_REGISTRY_VIEW` | `:2839` | `/dshm-registry/view` 已注册（`pnpm view` 假壳的转发目标） | 毫秒级 |
| `BOOT_63B_PACKAGE_LIST` | `:2918` | `/dshm-packages/list` 已注册（skin-market 的 inventory 目标） | 毫秒级 |
| `BOOT_65_AUTH_URL` | `:849-850` | 抓到 dsh 打印的带 token URL，写 `host-ready.json`。**时间点取决于 dsh 何时打印**，见 §3.3 | 实测 `+6648ms` / `+6610ms`（`docs/device-validation.md:3615`、`:3670`） |
| `DSHM_READY`（非阶段，机器可读信号） | `:3863-3868` | `console.log('DSHM_READY ' + JSON)`，ArkTS 侧等到端口可连为止 | — |
| `BOOT_70_HTTP_READY` | `:3871-3873` | **自探一次** `GET /`（`probeHttpReady`，`:3746-3767`）。"dsh 说它绑了端口"与"端口真的应答"是两件事 | 实测 `GET / → HTTP 401（10ms/187ms/192ms）`（`docs/50` E54、`docs/device-validation.md:1907`、`:1152`） |
| `BOOT_ERR` | `:887-888` | `fail()` 打出 `after=<最后一个成功阶段> reason=<原因>`，并写 `globalThis.__dshmHostError` 与启动失败标记 | — |

**`GET / → 401` 是正确响应**：dsh 的 `/api` 前面是 browser-trust fence，不带 token 一律 401（`main.js:648-655`）。

### 3.3 命名顺序 ≠ 时间顺序（`BOOT_65` 的坑）

`BOOT_65` 名字排在 60 之后，但它**可能比 60 更早打印**。原因是 `BOOT_65` 由 `watchdogAuthUrl()` 在 **stdout 拦截**里触发（`main.js:657-683`），而 dsh 是在 `runProfile` **内部**打印那一行 URL 的。真机日志里可以直接看到这个交错：

```text
行 652: BOOT_65_AUTH_URL (+6610ms)     ← 更早
行 655: BOOT_60_HTTP_BIND port=3120 (+6639ms)
```

（`docs/device-validation.md:3615-3617`、`:3670-3672`）

> **接手要点**：任何"按阶段名排序推断因果"的脚本都会在这里出错。因果顺序应当按**时间戳**读，而不是按编号读。

### 3.4 失败路径与日志通道（最容易误判的一处）

两个日志文件，**用途不同、落点相同**（都在 `DSHM_SANDBOX_HOME`，即 `filesDir`）：

| 文件 | 谁写 | 语义 | 证据 |
|---|---|---|---|
| `dshm-host.log` | `diag()`（`main.js:79-92`），`flags:'a'` **append** | 跨重启保留的**取证**通道 | `main.js:71-77` |
| `node-output.log` | `dshhost.cc` 把 Node 的 stdout/stderr `freopen` 进来，每次启动 `"w"` **截断** | 本次启动的**流程**输出 | `hostruntime/src/main/cpp/dshhost.cc:247-257` |

**`BOOT_*` 与 `DSHM_READY` 打在 `node-output.log`，不在 `dshm-host.log`。** 只看后者会得出"宿主从未就绪"的**错误**结论（`docs/device-validation.md:3621-3623`）。反过来，取证类信息（用户行预检、孤儿锁清理、exec 探测）走 `diag`，因为它在下次启动时还会在（`hostcore/app/dshm-user-rows.js:14-17`）。

**启动期还有一个可观测性缺口**：`dshhost.cc` 的 tail 线程**不是 `tail -f` 语义**，而是"每 300ms 从文件头按 `offset` 续读全量"——`tail` 的 `offset` 初值为 **0**、用 `fseek(f, offset, SEEK_SET)`（`hostruntime/src/main/cpp/dshhost.cc:137-163`，全文件 `SEEK_END` 命中 **0** 次）。
它仍然**追不上启动早期**的输出，原因不同：该线程在 Node 起来之后才启动，在此之前 stdout/stderr 已被 `freopen`/`dup2` 重定向到 `node-output.log`（`dshhost.cc:250-255`），因此早期内容**只落在文件里、不进 hilog**
（`docs/device-validation.md:606-611`）。结论不变但机制要写对：**启动期问题不能依赖 hilog，要依赖落盘文件 + 行为验证**。

### 3.5 验证

```bash
# 本机（不需要设备）：完整 BOOT 链 + 就绪探测
#   env/argv 与端侧同口径，见 hostcore/app/main.js 头部
DSHM_CORE_DIR=dist/core/work/dsh-core-0.2.0-rc.2 \
DSHM_HOME=dist/localtest/boot-home DSHM_SANDBOX_HOME=dist/localtest/boot-home \
DSHM_PORT=3120 DSHM_PROFILE=ondevice \
node --jitless --experimental-sqlite --expose-internals hostcore/app/main.js
# 真机：BOOT_* 只在 node-output.log
hdc file recv .../entry/files/node-output.log ./node-output.log
grep -E "BOOT_" node-output.log | tail -12
grep -E "DSHM_READY" node-output.log | tail -1
# 真机：取证通道
hdc file recv .../entry/files/dshm-host.log ./dshm-host.log
grep -E "exec 探测|孤儿写锁|用户插件行" dshm-host.log | tail
```

---

## 4. Node 启动参数

### 4.1 `buildHostArgv`：三个开关各自为什么必需

`hostruntime/src/main/ets/runtime/RuntimePort.ets:125-170` 是这条契约的唯一事实来源。它返回的是**交给 `node::Start` 的 Node 自身 argv**（不含 `argv[0]`，引导层会补一个 `"node"`，`dshhost.cc:179-181`）：

```ts
export function buildHostArgv(entryScript: string): string[] {
  return [
    '--jitless',              // ①
    '--experimental-sqlite',  // ②
    '--expose-internals',     // ③
    entryScript,              // ④ 必须排在所有选项之后
  ];
}
```

**① `--jitless` —— 它是"不申请 `ALLOW_WRITABLE_CODE_MEMORY`"能成立的前提**（`:127-140`）。少了它，V8 会在初始化时申请可写可执行内存而被系统拦。它是**真实的一等 CLI 选项**，不是碰运气透传：Node 自己在 `src/node_options.cc` 注册了它，V8 侧 `flag-definitions.h` 用 `DEFINE_NEG_IMPLICATION(jitless, …)` 关掉 turbofan / sparkplug / always_sparkplug / maglev —— 整条 JIT 链。
**代价要写清**：同处隐含 `--no-expose-wasm` ⇒ **`WebAssembly` 会是 `undefined`**。任何依赖 WASM 的 npm 依赖在端侧直接不可用，而且报错形式往往是"某个东西是 undefined"而不是"缺了 WASM"。这是 jitless 路线已知且接受的代价（换的是可正常上架）。
守护它的门禁：`tools/check-store-readiness.mjs:150-157`（argv 里必须有 `--jitless`，否则 FAIL）。

**为什么必须排在脚本路径之前**：Node 把**第一个非选项参数**当脚本。写反了就等于让 Node 去执行一个叫 `--jitless` 的文件。

**② `--experimental-sqlite`**（`:148-152`）：`session-query-sqlite` 用 `node:sqlite`，而 Node 22 里该模块需要这个开关才会被暴露（本项目构建**确实带 SQLite**：版本串里有 `"sqlite"`（本机多次实测为 **3.53.3**；早期日志曾见 3.50.0，随 libnode 版本变））。不加它，那一行会在 import 期抛 `ERR_UNKNOWN_BUILTIN_MODULE` —— 与其因此禁掉一个鸿蒙上**本来能做**的能力，不如把开关打开。

**③ `--expose-internals`**（`:153-159`）：`0.1.6-alpha.2` 的 host preparation（`dsh-app-boot` 的 `internalModules`，经 `node-addon-require-builtin`）要访问 internal 模块做 profile 的 link 解析。端侧没有该 addon 的 openharmony 平台包，`main.js` 的 `installRequireBuiltinShim()` 用纯 JS shim 顶替，而 shim 的前提就是 `require("internal/…")` 可用 —— 即本开关。官方桌面端同样开它（`apps/desktop/src/host-process.ts` 的 spawn 参数第 1 位）。

**④ 为什么没有 `--no-experimental-fetch`**（`:141-147`）：端侧 `libnode` 已升到 Node 24 及以后的线（`libnode.so.137`），fetch 那时已转正 —— `--experimental-fetch` 不再是 boolean 选项，`--no-` 否定形态会让进程**死在 CLI 解析**（真机实测 `invalid negation because it is not a boolean option`，Host 因此从未启动，见 `files/node-output.log`）。原 flag 的目的（不装原生 fetch、避开 undici 的 WASM llhttp）改由运行期垫片兜底：`fetch-shim.js` 的 `installFetchShim()` 在 WASM 不可用时无条件覆盖 `globalThis.fetch`（`hostcore/app/fetch-shim.js:586-603`）。原生 fetch 在 jitless 下反正不可用，覆盖是无损的。

> **口径冲突（接手时必须先确认的一件事）**：仓库内对"当前 libnode 是哪个 Node 版本"有**两种互斥的说法**，不要在没核对设备前把任何一个当定论：
> - `libnode.so.137` 是 **Node 26.x** 的 soname（`hostruntime/src/main/cpp/dshhost.cc:483`、`:487-490`；`entry/src/main/cpp/CMakeLists.txt:104` 注释"26.x=.137、24.x=.127"，且 `:6` 提到"换到 26.7.0 的头文件"）；
> - 但 `RuntimePort.ets:141` 写的是"已升级到 **v24.2.0**（libnode.so.137）"，`docs/device-validation.md:951` 的真机读数也是 `jitless=true node=v24.2.0`。
>
> 其中"soname 随 Node 版本走"这条映射是可靠的（CMake 用它做候选探测）；而 `.137` 究竟对应 24 还是 26，本仓的两处文字互相矛盾。**可靠的取法是问设备**：`BOOT_00_NODE_START` 会打出 `node=<process.version>`，`host-ready.json` 的 `runtime.nodeVersion` 也会落盘同一读数。

### 4.2 绝对不要放 dsh 应用级选项

`RuntimePort.ets:160-167` 把这条写成了文件内最重的警告，因为踩过：

> 实测（E68）：把 `--trusted-host` 加在这里 ⇒ dsh 侧只有一行 `node: bad option: --trusted-host`，随后 `启动 Host：ok=false … 3120 端口未应答（Node 线程已经退出）`，而**上一版是能起来的**。

根因：`buildHostArgv()` 的返回值是 Node 自身的 argv，任何 Node 不认识的开关都会让进程直接死在 CLI 解析阶段。`docs/50-端侧核心运行架构.md` E68 另记了这条的自查结论，并给出纪律：**改完 argv/env 之后，第一件事必须是跑一次完整启动看 `BOOT_*` 是否仍全绿** —— 只确认 `BUILD SUCCESSFUL` 完全不够。

### 4.3 dsh 的四个选项走 `runProfile({ args })`

合法的应用级开关只有四个（以 `dsh-web-app` 的 `startup.js` 为准）：`--host` / `--no-open` / `--port` / `--trusted-host <authority...>`（`main.js:3802-3819`）。端侧传的是：

```js
const args = [
  '--port', PORT,
  '--host', '127.0.0.1',
  '--no-open',
  '--trusted-host', `127.0.0.1:${PORT}`,
];
```

（`hostcore/app/main.js:3821-3826`）

**为什么不传 `--skip-auth`**：这个选项**不存在**。真机读数 `error: unknown option '--skip-auth'` → `runProfile` 直接拒绝，Host 从未起监听（rc=1，`main.js:3808-3812`）。而且 dsh 的"认证"不是可以关掉的开关，而是 `/api` 的 browser-trust fence：客户端该做的是**从 Host 输出里取 URL**，而不是试图关掉认证。

### 4.4 引导层怎么把 argv / env 交进去

`hostruntime/src/main/cpp/dshhost.cc`：

- `StartHost` 收两个参数（`:165-344`）：`argv: string[]`（不含 argv[0]）与 `envPairs: string[]`（每项 `KEY=VALUE`）。
- argv[0] 由 C++ 补 `"node"`（`:181`），其余逐个 `napi_get_value_string_utf8` 拷进静态存储（argv 必须活到线程结束）。
- **env 必须在 `node::Start` 之前 `setenv()`**（`:199-221`），因为 Node 启动时就会读 `process.env` 初始化，之后再 setenv 对已启动的 Host 没有任何作用。
- 格式不合法的条目**跳过并计数**（`:216-218`），条数回报给上层（`envApplied`，`:334-335`）。**不允许静默忽略**：被忽略的 `DSHM_HOME` 会让 Host 悄悄用上默认目录，看上去一切正常却写错了地方。
- `g_started` 是"同一进程只允许一个 Node 实例"的守卫，**线程退出时必须复位**（`:269-279`，E119）。不复位会让核心版本切换、重启核心**全部失败**。
- **同一进程内第二次 `node::Start` 会让进程 SIGABRT**（`exitSigno=6`，`docs/50` E149）。所以端侧"切换核心版本"被改成"安排激活 + 重启应用生效"（`hostruntime/src/main/ets/runtime/DshHost.ets:436-467`，E151/E152）。

### 4.5 验证

```bash
node --check hostcore/app/main.js                                  # 语法
node tools/check-store-readiness.mjs                               # --jitless 必须在 argv 里、不得出现 --experimental-fetch
grep -n "'--jitless'\|'--experimental-sqlite'\|'--expose-internals'" hostruntime/src/main/ets/runtime/RuntimePort.ets
# 端侧实证：Node 起来后第一行就自报 jitless
grep -m1 "BOOT_00_NODE_START" node-output.log
```

---

## 5. 环境变量契约

### 5.1 `buildHostEnv` 传了什么

`hostruntime/src/main/ets/runtime/RuntimePort.ets:178-194`：

```ts
export function buildHostEnv(coreDir: string, homeDir: string, sandboxHome: string,
  port: number, profile: string): string[] {
  return [
    `DSHM_CORE_DIR=${coreDir}`,       // 当前版本的核心树根（内含 node_modules/ 与 profiles/）
    `DSHM_HOME=${homeDir}`,           // $DSH_HOME：跨版本共享的用户数据目录
    `DSHM_SANDBOX_HOME=${sandboxHome}`, // HOME：可写沙箱目录（= filesDir）
    `DSHM_PORT=${port}`,              // 监听端口
    `DSHM_PROFILE=${profile}`,        // profile 名（ondevice）
    'UV_USE_IO_URING=0',              // 见 §5.3
  ];
}
```

**为什么这条通道是环境变量而不是 argv**（`:106-113` 的注释）：入口脚本读的这五个键是它的"配置面"，而 ArkTS 侧**没有任何办法设置原生进程的环境变量** —— 只能由引导层在 `node::Start` 之前 `setenv()`。于是"该传哪些键、argv 该带什么"成了两端之间最容易写错、**且写错了不会报错**的接口：键名拼错 → Host 用上默认目录，表面上起来了、实际指向错的 `$DSH_HOME`。所以这两条契约必须是**可单测的纯函数**，而不是散在实现里的字符串拼接。

**为什么用 `KEY=VALUE` 字符串而不是两个平行数组**（`:172-177`）：两端都不必维护下标对应关系，少一类"键值错位"的错法。判据函数 `isWellFormedEnvPair()`（`:203-206`）只要求"有 `=` 且键非空"，C++ 侧按**同一规则**处理并把条数回报（`dshhost.cc:216-218`）。

**入口脚本侧的兜底与推导**（宿主侧也能离线跑，所以有第二套逻辑）：

| 变量 | 入口脚本里的取值 | 行号 |
|---|---|---|
| `DSHM_CORE_DIR` | env 优先；否则读 `<DSH_BASE>/state.json` 的 `current` 拼出 `cores/<current>` | `main.js:577`、`currentCoreDir()` `:558-575` |
| `DSHM_HOME` | env 优先；否则 `<DSH_BASE>/home` | `:578` |
| `DSHM_SANDBOX_HOME` | env 优先；否则 USER_DATA（Electron 时代残留）→ HOME_DIR | `:579` |
| `DSHM_PORT` / `DSHM_PROFILE` | env 优先，默认 `3120` / `ondevice` | `:580-581` |

**默认值是双刃**：`DSHM_PORT` 与 `RuntimePort.HOST_DEFAULT_PORT = 3120`（`:116`）刻意保持同值，但**显式传**，不依赖默认值 —— 否则两处漂移会变成"客户端连 3120、Host 听别的端口"。

### 5.2 入口脚本自己再设的一批（宿主进程内的）

`main.js` 在 `BOOT_00` 前后自行设置这些，它们**不来自 ArkTS**：

| 键 | 值 / 判据 | 为什么 | 行号 |
|---|---|---|---|
| `HOME` / `USERPROFILE` | `SANDBOX_HOME` | 鸿蒙下 `os.homedir()` 返回沙箱外目录，会 EPERM | `:910-914` |
| `DSH_HOME` | `HOME_DIR` | dsh 只认这个 | `:915` |
| `DSH_DISABLE_HMR` / `DSH_TELEMETRY_DISABLED` | `1` | HMR 的文件监听在沙箱里不可靠；遥测默认关 | `:916-920` |
| `TMPDIR` / `TMP` / `TEMP` | `<SANDBOX_HOME>/tmp`（**只补空值**） | `os.tmpdir()` 与 `os.homedir()` 是同类探测，而 `dsh-spill-local` 与两个 worker-thread 运行器真的用它 | `:936-944` |
| `DSHM_PLATFORM` | `ohos`（**仅当** sandbox/home 以 `/data/storage` 开头） | `dsh-credentials-local` 的 `assertOwnerOnly()` 要求凭据不能被属主以外读到，而 hmfs 把权限强制成 660 ⇒ 该检查在鸿蒙永远不可能通过。端侧 `process.platform` 是 `linux`，与桌面无法区分 ⇒ 用"我们自己确知的事实"当判据 | `:968-982` |
| `NO_PROXY` / `no_proxy` | `127.0.0.1,localhost,::1`（只补空值） | 回环流量不该经过任何代理；有系统代理时"端口通了但连不上" | `:983-987` |
| `PATH` | busybox bin 前插 + 去重 + 剔除确认不存在的绝对目录 | 端侧 PATH 里只有 `/bin/sh` 与 toybox | `:3374-3395` |
| `DSHM_PYTHON_LIB` / `DSHM_PYTHON_HOME` | el1 libs 的 `libpython3.12.so.1.0` / `PYTHON_PREFIX` | 必须在 `process.dlopen(addon)` **之前**设好，addon 的 `EnsurePythonInit` 要读它 | `:2395-2399` |
| `DSHM_NATIVE_LIBS` | 覆盖用（默认由 `__dirname` 上溯推出 `<bundle>/libs/arm64`） | 离线调试 | `:255-267` |
| `DSHM_IN_LOG` | `1` 才打普通入站请求 | 每个 RPC 一行会把 hilog 冲掉 | `:217-223` |
| `DSHM_ALLOW_EXECPATH_SPAWN` | `1` 关闭 execPath 兜底（**调试用**） | 正常路径不允许 | `:460-464` |

**`DSHM_PYTHON_TOKEN` 不在这一列**：它只出现在**生成的 shell 垫片**里作为"快路径"，脚本每次调用会回落到读 `host-ready.json` 的 `token`（`main.js:1499-1502`、`:1966-1969`）。这是刻意的：垫片现读现取，绕开"DShM 时代 token 注入滞后 30–90 s"的窗口期。

### 5.3 `UV_USE_IO_URING`：注释说"必须"，事实是别的东西在生效

`RuntimePort.ets:186-192` 把 `UV_USE_IO_URING=0` 写成【必须】，理由是真机崩溃日志 `Reason:Signal:SIGSYS(SYS_SECCOMP) syscall number is 425`，栈为 `uv_loop_init ← node::tracing::Agent::Agent() ← node::V8Platform::Initialize ← node::Start`；arm64 上系统调用号 425 就是 `io_uring_setup`，libuv 在 loop 初始化时会尝试它，而鸿蒙的 seccomp **直接拒绝并杀掉进程**。

但同一仓库里还有一条更硬的事实（`tools/node-runtime/fix-uv-io-uring.sh:14-30`）：从 libuv 的 `deps/uv/src/unix/linux.c` 读出来的实现是——

```c
static int uv__use_io_uring(uint32_t flags) {
  if (0 == (flags & UV__IORING_SETUP_SQPOLL))
    return 1;                       /* 普通路径：无条件 YES */
  ...
  val = getenv("UV_USE_IO_URING");  /* 只有 SQPOLL 才会读它 */
}
```

`uv_loop_init` 以 `flags == 0` 调用它，**所以环境变量在那条路径上根本不会被读到**（无关实测：`envApplied=6`，即变量确实设进去了，进程照样崩）。真正的修法是构建期改源码为**无条件 `return 0`** 后重建 libnode（`fix-uv-io-uring.sh:25-33`、`:60-72`），这一步是"自建 Node 能在鸿蒙上跑"的第一条完整正面证据（`docs/50-端侧核心运行架构.md` E42）。

> **结论（对本节契约的影响）**：今天让 Node 起得来的是**构建期补丁**；`UV_USE_IO_URING=0` 保留在 env 里是**防御性的**（上游若改动 `uv__use_io_uring` 的读取位置，它就会立刻发挥作用），而不是当前生效的那一层。
> **未验证**：本项目没有做过"删掉该 env 看是否仍能启动"的对照实验。要做对照请在同一次改动内还原，并把结论写进注释。

### 5.4 验证

```bash
# env 契约的纯函数级检查（键名、格式判据）
grep -n "DSHM_CORE_DIR\|DSHM_HOME\|DSHM_SANDBOX_HOME\|DSHM_PORT\|DSHM_PROFILE\|UV_USE_IO_URING" \
  hostruntime/src/main/ets/runtime/RuntimePort.ets
# 入口脚本实际读到的键（离线跑一遍，第一条 diag 就会打出 env 与 argv）
head -5 dist/localtest/*/dshm-host.log
# Node 侧确认 jitless 真的生效 + 确认当前 libnode 的 Node 版本（BOOT_00 自报，见 §4.1 的口径冲突）
grep -m1 "BOOT_00" node-output.log   # 期望 jitless=true node=<版本>
```

---

## 6. 宿主侧补丁清单（`hostcore/app/`）

这一层是"移植"里最厚的一块：`main.js` 4,084 行 / 200,369 B，另有 6 个被它 `require` 的模块。**按功能域**列，因为按文件读是不可能的。

### 6.1 `main.js` 的功能域

| 域 | 做什么 | 行号 |
|---|---|---|
| **诊断引导** | `diag()` 落 `dshm-host.log`（append，跨重启）；拦截 `process.exit` 记栈**不真退出**（真退出在 OHOS 上变成 SIGABRT，什么都不留下）；`ALLOW_EXIT` 只给停止路径放行 | `:71-121` |
| **异常单一入口** | `uncaughtException` / `unhandledRejection` 各只注册一处（原先两处 ⇒ 每条拒绝打两遍）；识别并降级 `WebAssembly is not defined` + `lazyllhttp/internal/deps/undici` 这条**已知噪声** | `:141-159` |
| **封 `node:http` 惰性 getter** | 在任何人访问前用 `defineProperty` 把全部惰性 getter 定义掉，避免触发惰性 undici（jitless 下必然抛）。**不能先读原值**（读一下就初始化） | `:168-183` |
| **入站请求观测** | 包 `createServer`，`upgrade` 永远打（罕见且决定性），普通请求要 `DSHM_IN_LOG=1`。它把"WS 升级失败"的三种完全不同的原因分开 | `:202-236` |
| **原生库重定向** | 三层钩子：`fs.existsSync` 认平铺名、`Module._extensions['.node']` 改写到 libs、`Module._resolveFilename` 接住裸相对 `.node`、补 `.so` 扩展处理器 | `:255-332` |
| **`node-addon-require-builtin` → JS shim** | 拦 `Module._load`（**不拦 `_resolveFilename`**，因为 app-boot 会替换它）；实现见 `require-builtin-shim.cjs` | `:350-359` |
| **jitless fetch 垫片** | WASM 不可用时无条件覆盖 `globalThis.fetch` 等全局 | `:375-386` |
| **`undici` 模块名解析钩子** | `register()` 一个解析钩子，把 `import("undici")` 指到本仓垫片；**只在 WASM 不可用时注册**；失败只降级不阻断 | `:411-425` |
| **`process.execPath` spawn 兜底** | 端侧 `execPath` 是 `/system/bin/appspawn`，拿它 spawn 必然 EACCES ⇒ 精确匹配 `file === execPath` 时拒绝并给可读原因；**但 `args[0]==='-e'` 的内联脚本形态识别为"重启意图"**，转入整机冷启动通道并返回 stub child | `:460-555` |
| **无窗口保活** | Electron 语义遗留（订阅 `window-all-closed`）——阶段一已移除，这段在 libnode 形态下是惰性代码，保留成本极低 | `:598-612` |
| **BOOT 阶段标记** | 见 §3 | `:614-641` |
| **token 抓取** | 拦 `process.stdout.write`，匹配 `dsh web: <url>`，一次性写 `host-ready.json`；只留尾部 32 KB 防 buffer 无限涨 | `:657-683` |
| **运行时事实** | 当场 `require` koffi/sharp/node-pty，把"能不能加载"与原因带上；**缓存**（它在"拦截 stdout 写"的路径上被调用，不能每次重活） | `:701-821` |
| **`host-ready.json`** | 一次落盘：url / baseUrl / token / port / profile / **pid** / startedAt / workspace / runtime 事实 | `:823-854` |
| **失败契约** | `fail()` 绝不 `process.exit`（会连同 ArkUI 应用一起杀掉），只记录 + 写启动失败标记 + throw | `:881-894` |
| **沙箱环境** | 见 §5.2 | `:910-987` |
| **busybox 布置** | 复制本体 + 8 个 applet 副本（`ash bzip2 xz hexdump less nc unzip vi`，**刻意不含 `sh`**）；带 hmfs"封存态"自愈（删除重铺）；主 bin 不可恢复时退到 `bin-<pid>`；失败一律**不注入 PATH** | `:1015-1251`、`:1209-1251` |
| **内置 skills** | `resfile/ohos-skills/*.md` → `$DSH_HOME/skills/`（dsh-skill-filesystem 的 user-dsh root） | `:1258-1284` |
| **CLI 假壳** | 生成 `pnpm`/`npm`/`npx`/`dsh` 四个 POSIX sh 脚本：`add`/`install`/`rm` 投递安装队列并同步等结果；`view`/`config get registry`/`list` 转发 Host 端点。三个假壳**共用**同一段 `--dir` 归一化片段 | `:1286-1866` |
| **工具链 wrapper** | `python`/`python3`/`pip3`/`git` 四个 wrapper：能 exec 真身就 exec，否则走桥模式/明确降级。git 对**子进程类子命令**分流：先试 `LD_PRELOAD` 垫片，否则给出可读原因而不是 core dump | `:1868-2187` |
| **core 执行位补齐** | `zlib.decompressFile` 不保留权限位 ⇒ 补 `rg` 与 `sharp-*.node` 的 x 位（**缺了才补**，多余 chmod 在 hmfs 上可能 EACCES） | `:2204-2235` |
| **rg wrapper** | 把 core 树自带 ripgrep 挂进 PATH；exec 被拒时明确降级 | `:2242-2277` |
| **工具链签名标记** | `dshm-signed.txt`（**不能以点开头**，HAP 打包丢 dotfile）的读写与"换代即重解"判据 | `:2279-2344` |
| **内嵌 Python 桥** | `process.dlopen(libpython_runner.so)` → CPython embedding；**stdlib 未就位时绝不放行**（`Py_Initialize` 在半成品上会 fatal 整个进程） | `:2346-2552` |
| **三个 HTTP 端点** | `/dshm-python/{status,run-get,exec}`、`/dshm-registry/view`、`/dshm-packages/list`。鉴权用常数时间风格比对 token；执行端点注入 SIGALRM 超时（默认 120 s，可调 1–300） | `:2553-2933` |
| **工具链收尾** | rename 归位、从 apk 现读 `git-core` 的 141 条 symlink 表并用**真身拷贝**补齐、chmod、锚点复验、写签名标记 | `:2934-3008`、`:3307-3355` |
| **exec 探测** | 七目标真实 spawn：python3.12 / git / git-core/git / git-remote-http / rg / bash / **git-ls-remote（本地 file:// 最小判据）**。**只探测不再修复**（E1–E19 实验矩阵已拆除） | `:3010-3173` |
| **解包调度** | 残局自愈（`py-stage` 归位）、签名换代强制重解、**后台** `spawn busybox ash -c "tar xmzf …"`、exit 回调收尾 | `:3180-3355` |
| **顶层布置块** | 上面这一大串的实际调用点（顺序即依赖） | `:3357-3417` |
| **让 dsh 走 ESM proxy 分支** | `process.pkg = process.pkg \|\| {}` —— `isPackagedExecutable()` 只看 `process.pkg !== void 0`，而 proxy 分支**完全基于普通文件系统 API**；沙箱全局禁 symlink，走 symlink 分支必然 boot 失败 | `:3419-3446` |
| **孤儿写锁清理** | 巡检 `$DSH_HOME`（深度 ≤3、跳过 `node_modules`、最多 200 锁 / 20000 目录项）里的 `*.lock`，**只删 pid 明确已不存在的**；读不出 pid / 是自进程 / pid 仍存活（含 EPERM）一律不动 | `:3484-3553` |
| **profile 就位** | bundles 合并（种子顺序并集 **减去** `removeBundles`）、种子覆盖前抢读旧 patch、拼用户行、四道预检（rows / dependencies / home-patch / bundles）、半残包隔离、7 天残留回收 | `:3609-3737` |
| **自探 HTTP** | 用 `node:http`（原生 llhttp）而不是 fetch；失败不抛、只返回描述串 | `:3746-3767` |
| **`start()` 主流程** | 见 §3；末尾挂协作式停止（1.5 s 巡检 `host-stop-request`）、整机冷启动通道（`host-exit-mode=app-restart`）、安装队列轮询（2 s）、`SIGTERM` | `:3769-4075` |

### 6.2 `dshm-user-rows.js`：用户行机制与旧名迁移

**它解决的问题**：端侧要能做"插件启停"。而 dsh 的 profile 分层里，"用户层"就是 `<profile 目录>/cordis.patch.yml`，**入口脚本每次启动都会用核心种子覆盖那个文件**（否则核心升级带来的 profile 变更进不来）。于是拆成两件事（`hostcore/app/dshm-user-rows.js:9-16`）：

- `cordis.patch.yml`：**每次启动重新拼装** = 核心种子 + 用户行（后写覆盖先写）；
- `.dshm-plugin-rows.yml`：**只放用户行**，谁都不覆盖它。

⇒ 启停在重启后仍然成立，且核心升级照常流入。**"恢复默认"因此是一次删除**（删掉用户行文件，下次拼出来的就是纯种子）。

**旧名迁移（HDSH → DSHM）**：2026-09-27 做了全局改名，端侧若干**状态文件**随之改名。这些文件躺在用户数据目录里，改名后新代码只读新名 ⇒ **升级安装的老用户会读不到自己的插件启停设置，表现为"设置被重置"**。所以做一次防御性迁移：新名不存在、旧名存在 ⇒ `renameSync`（`dshm-user-rows.js:39-71`，调用点 `:486-488`）。用 rename 而不是复制：同目录同一文件系统、原子，且旧名留着会让"下次启动又读到旧名"的困惑长期存在。迁移失败静默容错。

**四道防线（D27 死锁事故的产物）**：一次真实事故是 web UI 装了插件后，用户行每次启动被拼进 patch，而设备上该包的 `lib/index.js` 缺失 ⇒ dsh loader import 抛错 ⇒ `BOOT_ERR`：Host fatal、无 HTTP、python 桥也没了；而 `files/dsh/home` 是 700，hdc 不可写 ⇒ **没有任何外部恢复通道，只能重装 HAP 自救**（`dshm-user-rows.js:6-11`）。

| 防线 | 做什么 | 函数 |
|---|---|---|
| ① 用户行预检 | 拼行前逐条验证 `node_modules/<id>/package.json` 与入口文件在；坏行不拼、`diag` 留取证，但**行本身不删**（包修好后下次启动自动恢复） | `prefilterUserRows` `:276`、入口候选判定 `entryCandidates` `:114-189`、`userRowLoadable` `:204` |
| ② dependencies 预检 | profile `package.json` 的 `dependencies` 是 dsh loader 的 include 源，且该文件**刻意不被种子覆盖** ⇒ 脏行必须逐条预检移除 | `sanitizeDependencies` `:627`（`anchorDirs` 要先查核心树，否则会误杀 optional bundle，`:632-635`） |
| ③ home 层 patch 预检 | `$DSH_HOME/cordis.patch.yml` 每次 startup 都进 patch 栈，种子够不着 | `sanitizeHomePatch` `:821` |
| ④ 启动失败自愈 | `fail()` 时往 `$DSH_HOME` 写 `.dshm-boot-failed`；下次启动在拼行**之前**发现标记 ⇒ 隔离用户行文件 + 清空 dependencies + 隔离 home patch + 隔离半残包（**全是改名/备份，保数据不删**），再清标记 | `writeBootFailMarker` `:600`、`quarantineAfterBootFailure` `:984-1056` |

**为什么自愈要做到"连 dependencies 和 home patch 一起隔离"**：真机实证了三轮 —— 第一轮只隔离 rows，`BOOT_ERR` 原样复现；第二轮清 rows + dependencies 仍在；第三轮才发现 home 层 patch 也进 patch 栈（`dshm-user-rows.js:971-983`）。**"回到纯种子"才叫自愈。**

**另外两处值得单独记**：
- `entryCandidates` 对"**子路径专用包**"（`exports` 只有 `./mode/*` 之类）返回**空数组**，语义是"本包按设计没有根入口"，由 `userRowLoadable` 据此放行（`:100-113`、`:162-163`）。旧实现回退 `index.js` 把 `@codemirror/legacy-modes` 判成半残 ⇒ 整单安装被回滚。
- 同理，**纯类型包**（`main: ""` + `types: index.d.ts`）也放行（`:167-184`）。判据不一致就是"装完即被拒拼/隔离"的配方。
- 市场配置托管块（`.dshm-market-rows.yml`）只在 `node_modules/dsh-skin-market` 存在时才写，包一没就清（`:76-97`、`ensureMarketRows` `:351`）—— 它是**引用第三方包的 patch 行**，包不在就是坏引用。

### 6.3 `dshm-installer.js`

**它解决的问题**：端侧没有 pnpm/npm/git（上游 `dsh plugin add` = `spawnSync("pnpm")`，第一步就 ENOENT），也没有独立 node 可执行文件跑它们 ⇒ web/CLI 的所有安装路径在端侧都是死路。本模块把"安装"拉回**进程内**：spec 解析 → HTTPS 拉 tarball → **纯 JS gunzip + ustar 解包** → profile `node_modules` 落位 → `package.json` merge → 用户插件行追加（`hostcore/app/dshm-installer.js:1-33`）。

**为什么纯 JS 解 tar 而不 spawn busybox tar**：spawn 在端侧始终带平台级不确定性（执行位/权限策略），而 tgz = gzip(ustar)，`zlib.gunzipSync` + 512 字节头解析是零依赖的确定性路径。

**触发方式不由本模块决定**：`main.js` 轮询 `$DSH_HOME/install-queue/*.req`（spec 文本），结果写回同目录 `<id>.done` / `<id>.fail`（JSON）；卸载走 `.rem`。写入方可以是 ArkUI 设置页或模型（skill）。

**其它事实**：默认 registry 是 `https://registry.npmmirror.com`（`:44`，可在 `<homeDir>/installer.json` 覆盖）；依赖递归深度 ≤3，只递归 `dependencies`；皮肤市场的"展示名 → 真实安装 spec"映射表 `SKIN_ALIAS_MAP`（`:57-68`）—— 展示名在 registry 上查无此包，不改写就会让市场的 `pnpm view` 恒 exit 1。

### 6.4 两个垫片家族

**（A）fetch 垫片（`fetch-shim.js`，605 行）**：用 `node:http/https`（**原生 llhttp**，与 WASM 无关）重写 `fetch/Request/Response/Headers/FormData/Blob/File`。五条踩过的坑直接写在代码里：
- `DshmHeaders` 必须单独处理"原生 Headers / Map"（数据不在自有可枚举属性上）—— 之前 `Object.keys(nativeHeaders)` 返回 `[]`，**一个请求头都不发**，提供方回 401 `invalid_api_key`（`:59-79`）。
- 已知长度的 body **必须显式给 `Content-Length`**：node 在首次 write 时自动改用 `Transfer-Encoding: chunked`，而部分网关的前置 WAF 直接拒 chunked POST（412 空体）（`:485-508`）。
- **必须尊重 `redirect: 'manual'`**：上游 `web_fetch` 靠它自己做"仅同源跳转"的安全策略，垫片擅自跟跳等于绕过它（`:510-517`）。
- `DshmRequest` 是必需的：dsh 的 `/api` 挂载点会 `new Request(...)`，缺它 ⇒ `ReferenceError` ⇒ 被 catch-all 兜成**空体 400**（`:523-536`）。
- **原生 `FormData` 必须按能力识别**（2026-09-28 加）：Node 24 启动就自带 `FormData`（与 WASM 无关，`installFetchShim()` **不替换**它），而 `encodeRequestBody` 原先只认 `instanceof DshmFormData` ⇒ 体退化成 `Buffer.from(String(body))` = 字面量 `"[object FormData]"`（`:248`、`:254`，见 §3.6 末段）。

**（B）undici 模块名垫片（`undici-shim.mjs` 114 行 + `undici-loader.mjs` 22 行）**：上游 `dsh-web-fetch-http` **不用全局 fetch** —— 它 `await import("undici")` 自建 Agent（HTTP 解析器是 WASM）⇒ jitless 下 `web_fetch` 打不开任何网页和 IP，而走第一层的 `web_search` 正常。做法是**运行期组合**：注册解析钩子让 `import("undici")` 解析到本仓垫片，并把 `dispatcher` 翻译成垫片认识的 `lookup`，**保住上游的 DNS 钉住/SSRF 防护**。核心树一个字节都不动。

**守它的门禁**：`node tools/check-web-fetch-jitless.mjs` —— 自带对照实验：不注册钩子时必须失败（并给出 WASM 因果证据），注册后必须全过，且**跨源跳转仍须被拒**。

### 6.5 改完必须重放（流程纪律）

`resfile/resources/app/` 是 `hostcore/app/` 的**快照**。快照失同步是**静默**的：门禁链漏跑 `place-host-app.mjs` 时，build 忠实打包旧文件，**全程零报错**，直到装机后 tail 日志才发现设备在跑旧代码（`tools/assert-resfile-sync.mjs:5-8`）。真机上还发生过一次同源事故：给 `main.js` 加了平台标识却只跑了 `pack-core --place-in-app`（放的是核心 zip），入口脚本没重放 ⇒ 包内是旧脚本，凭据豁免在真机上根本没生效（`docs/50` E148）。

**纪律**：

```bash
# 改 hostcore/** 之后的固定三步（缺一步都可能"改了、构建绿、设备上没生效"）
node tools/place-host-app.mjs
node tools/assert-resfile-sync.mjs      # 全部快照必须一致（`FILES` 清单 + package.json 语义锁；件数看清单，别写死）
devecocli build
```

`assert-resfile-sync.mjs` 另有一条**语义锁**：生成的 `package.json` 必须 `main=main.js` 且**没有 `type` 字段**（有 `"type":"module"` 会让 `main.js` 里的 `require`/`__dirname` 全炸，`:56-66`）。

### 6.6 验证

```bash
node --check hostcore/app/main.js
node --check hostcore/app/fetch-shim.js
node --check hostcore/app/dshm-user-rows.js
node --check hostcore/app/dshm-installer.js
node --check hostcore/app/dshm-skills.js
node --check hostcore/app/dshm-compat.js
node tools/assert-cli-shim.mjs            # CLI 假壳 40 项
node tools/assert-python-bridge.mjs
node tools/assert-exec-fix.mjs
node tools/assert-fs-search-fallback.mjs
node tools/assert-resfile-sync.mjs
node tools/check-skill-sync.cjs           # 32 passed（含等长改动用例）
node tools/check-compat-exemption.cjs     # 48 passed（臂 A 透传 + 臂 B 上游挂载决策）
node tools/check-dshm-installer.cjs       # 43 passed（含版本漂移双向用例 + GitHub→npm 回退 / monorepo 子包判定）
```

---

## 7. 沙箱布局

### 7.1 `files/` 下有什么

真机绝对路径形态：`/data/storage/el2/base/haps/entry/files/...`（`docs/device-validation.md:1028`）。ArkTS 侧通过 `context.filesDir` 拿到它，并作为 `DSHM_SANDBOX_HOME` 传下去（`entry/src/main/ets/entryability/EntryAbility.ets:386`）。

| 路径（相对 `filesDir`） | 内容 | 谁写 | 跨重启是否保留 |
|---|---|---|---|
| `dshm-host.log` | `diag()` 取证日志（append） | 入口脚本 `main.js:71-77` | **是** |
| `node-output.log` | Node stdout+stderr（每启动 `"w"` 截断） | `dshhost.cc:247-257` | 覆盖 |
| `bin/`（或 `bin-<pid>/`） | busybox 本体 + 8 个 applet + `bash`/`hush` 文本垫片 + `pnpm`/`npm`/`npx`/`dsh` 假壳 + `python`/`python3`/`pip3`/`git` wrapper + `rg` wrapper | 入口脚本，**每次启动重建** | 重建 |
| `dsh/state.json` | `{ current, previous, history }` | `CoreStore.writeState`（`CoreStore.ets:212-225`） | 是 |
| `dsh/cores/<ver>/` | 已安装核心树 + `.dshm-bundled-stamp` | `BundledCore` | 是 |
| `dsh/cores/<ver>.staging/` | 解包中，未激活 | `CoreStore` | 残留会被忽略（`listInstalled` 跳过 `.staging`/`.tmp`，`CoreStore.ets:229-253`） |
| `dsh/cores/<ver>.stale-<ts>.tmp/` | 被换掉的旧树，等异步删 | `BundledCore.ets:126-135` | 残留会被忽略 |
| `dsh/home/`（= `$DSH_HOME`） | **跨版本共享的唯一一份用户数据**（`CoreStore.ets:159-162`） | dsh + 入口脚本 | **是** |
| `dsh/home/host-ready.json` | url / token / port / **pid** / workspace / runtime 事实 | `main.js:823-854` | 每次 boot 重写 |
| `dsh/home/host-stop-request` | 协作式停止的请求文件 | ArkTS 写（`DshHost.ets:633-643`），入口脚本 1.5 s 巡检消费 | 消费即删 |
| `dsh/home/host-exit-mode` | `app-restart` 表示"停完要冷启动" | 入口脚本 `main.js:3953-3964`，ArkTS 1.5 s 巡检 | 消费即删 |
| `dsh/home/.dshm-boot-failed` | 上次启动失败的标记（含 stage 与原因） | `dshm-user-rows.js:600-611` | 自愈后删 |
| `dsh/home/install-queue/` | `*.req` / `*.rem` / `*.dir` / **`*.compat-req`** → `*.done` / `*.fail` | 假壳写、入口脚本消费（`.compat-req` 走 `dshm-compat.js` `applyRequest`） | 是 |
| `dsh/home/profiles/ondevice/compatibility.json` | **兼容性豁免表**（`{"<包名>@<精确版本>": ["<dsh 版本>"]}`，如 `{"dshmarket@1.66.2":["0.2.0-rc.1"]}`） | 上游 `dsh-app-boot` 的 `setProfileVersionExemption`（经 `dshm-compat.js` 薄封装），**先于任何插件加载读取** | 是（P1-3；写坏时上游 `rewritable=false` 拒绝改写，界面如实回报） |
| `dsh/home/skills/` | 内置技能（5 个 `.md`） | `ensureBundledSkills` `main.js:1261-1285` → `dshm-skills.js` `syncSkills` | 是（**内容 sha256 幂等**同步，2026-09-28 P0-1 修） |
| `dsh/home/profiles/ondevice/` | `package.json`、`cordis.patch.yml`（**每次启动重拼**）、`.dshm-plugin-rows.yml`、`.dshm-market-rows.yml`、若干 `.quarantine-<ts>` | `ensureProfile` + `dshm-user-rows.js` | 混合（见 §6.2） |
| `dsh/home/speech-to-text/{hms-bridge,sensevoice}/` | 语音桥队列与模型 | `entry/src/main/ets/speech/HmsSpeechBridge.ets:106`、`SenseVoiceRecognizer.ets:124` | 是 |
| `workspace/` | 会话的默认工作目录（写进 `host-ready.json` 的 `workspace`） | `main.js:963-966` | 是 |
| `tmp/` | `TMPDIR`/`TMP`/`TEMP` 的落点 | `main.js:936-944` | 是 |
| `toolchain/` | `python/`（CPython）、`gitroot/`（Alpine git）、`py-stage/`（解包中）、`.extract.log`、`.probe-repo`（本地探测仓库）、`dshm-signed.txt` | `scheduleToolchainExtraction`、`finalizeToolchain` | 是（签名标记换代才重解） |
| `hms-speech-bridge-heartbeat` | 语音桥心跳（`hdc shell cat` 可读，不受 hilog 滚动影响） | `HmsSpeechBridge.ets:117-120` | 覆盖 |
| `diag-*` 若干 | ArkTS 侧追加式取证标记：`diag-pick-called`、`diag-select-returned`、`diag-persist-done`、`diag-native`、`diag-web-load`、`diag-web-permission`、`diag-mic-probe`、`diag-file-selector`… | `entry/src/main/ets/pages/WebApp.ets:457-471`（`filesDir/<name>`，**追加**） | 累积 |

**为什么要自造 diag 文件而不是靠 hilog**：真机上 hilog 有丢日志前科，且 `pick()` 的 hilog 一条都没出现（`WebApp.ets:429`），所以凡是"是否被调用过"这类判定，一律落文件（`WebApp.ets:452-456`、`:1156`）。写失败静默 —— 诊断辅助不碰业务路径。

**为什么 `bin/` 里的东西每次启动都被重写**：这些是"生成物"，重建才能让 `HOME_DIR` 变化、假壳逻辑更新、wrapper 版本更新立刻生效（幂等：内容/大小指纹一致就跳过，避免多余的 chmod —— hmfs 上对健康文件做多余 chmod 可能触发 EACCES）。因此 **`files/bin/*` 不能当修复落点**（`docs/device-validation.md:1156-1161`）。

### 7.2 el1（代码）与 el2（用户数据）

| 域 | 真机路径（实测读数） | 内容 | 覆盖安装后 |
|---|---|---|---|
| **el1 = 代码与资源** | `/data/storage/el1/bundle/libs/arm64/`（`docs/70:73` 的 `原生库重定向已启用：libs=…` 读数）、`/data/storage/el1/bundle/entry/resources/resfile/…`（`docs/50` E32 的入口脚本路径） | `libs/*.so`、核心 zip、工具链归档、入口脚本、ArkTS 字节码 | **被替换**（这正是要更新的） |
| **el2 = 用户数据** | `/data/storage/el2/base/haps/entry/files/…`（`docs/device-validation.md:1028`）；`/data/app/el2/100/base/<bundle>/haps/entry/files/…` 是同一处的另一条访问路径（`docs/80:61`） | `dsh/home`（会话/插件/凭据/工作区注册）、`dsh/cores`、`toolchain`、`workspace`、`bin` | **保留** |

**判据与纪律（不可逆，务必遵守）**：`el1` = 代码（可换），`el2` = **用户数据（不可删）**。一律 `hdc install -r <hap>` 覆盖安装，**禁止** `hdc uninstall`。唯一例外是换签名导致覆盖安装失败时的 `hdc uninstall -k <bundle>`，且卸载后**立即验证数据仍在**（`-k` 未在真机验证过）。这条纪律的起因是真实事故：一次排障中的裸 `hdc uninstall` 删掉了 6 个会话、7 个插件、2 个工作区，系统备份为空、**不可恢复**（`docs/80-真机更新与数据保全.md:8-46`、`AGENTS.md`）。

**唯一允许的装机入口**：`tools/update-device.ps1`（它第 0 步会自检脚本自身不含卸载调用，`tools/update-device.ps1:46-70`）。注意它有一个**已知盲点**：装前 `home` 就是空的时候（`ls home | wc -l` 在权限受限的真机上恒返回 0），前后都是 0，检查无法发现丢失，脚本会如实打印 SKIP 而不是 OK（`docs/80:113-116`、`docs/device-validation.md:2244-2253`）。

### 7.3 验证

```bash
# 真机：布局与"哪些文件活下来了"
BUNDLE=com.dshm.dshclient
F=/data/app/el2/100/base/$BUNDLE/haps/entry/files
hdc shell "ls $F"
hdc shell "ls $F/dsh $F/dsh/cores $F/dsh/home $F/toolchain"
hdc shell "cat $F/dsh/home/host-ready.json"
# 装机前/后的用户数据基线（不要用 ls|wc -l 当唯一判据，见 §7.2 盲点）
.\tools\update-device.ps1 -SkipRebuild
```

---

## 8. 网络与端口

### 8.1 回环 + token 鉴权

| 项 | 事实 | 出处 |
|---|---|---|
| 监听地址 | 只 `127.0.0.1`，端口 3120（显式传，不依赖默认值） | `main.js:3821-3826`、`RuntimePort.ets:116` |
| 就绪判定 | **TCP 直连**（`socket.constructTCPSocketInstance`），任何应答（哪怕 404）都算"在监听" | `entry/src/main/ets/runtime/NodeRuntime.ets:266-304` |
| 为什么不用 `@ohos.net.http` | 真机实测：Host 正常 LISTEN、`hdc fport` 也能拿到 401，但应用进程内 `http.createHttp()` 的 GET 在 15 s 预算里**全部**超时。HTTP 栈受系统代理等环境因素影响；TCP connect 才是"在不在监听"的最原始事实 | `NodeRuntime.ets:280-285` |
| token 来源 | dsh 把 `dsh web: http://127.0.0.1:3120/?token=…` 打到 stdout；入口脚本**拦 stdout** 抓下来写 `host-ready.json`（对上游零 patch） | `main.js:643-683` |
| 为什么必须走文件 | `libdshhost` 没有"读走 Node 输出"的 API（只有 `runtimeVersion`/`startHost`/`isHostRunning`/`stopHost`）⇒ 通道只能是文件 | `main.js:644-655`、`entry/src/main/cpp/types/libdshhost/index.d.ts:65-77` |
| 客户端为什么必须带 token | dsh 的"认证"不是可关的开关，而是 `/api` 的 **browser-trust fence**：入口脚本自探 `GET /` 得到 401 是**正确**响应，而客户端拿不到 token 就只能一直 401 | `main.js:646-649`、`docs/50` E55 |
| 防旧文件 | `host-ready.json` 里带 `pid`；`NodeRuntime.readAuthUrl` 做 pid 校验，且要求 url 含 `:<port>/` —— 应用重启窗口里读到上一次进程的文件会让 token 立刻作废（dsh 每次启动换 token） | `main.js:834`、`NodeRuntime.ets:195-209` |
| 就绪链的窗口处理 | `BOOT_60`（端口通）→ `BOOT_65`（写文件）只差毫秒级，端口轮询"赢"在窗口里时文件可能还没写好 ⇒ 短重试 5 × 500 ms | `NodeRuntime.ets:43-46`、`:175-184` |

### 8.2 Origin 栅栏：`check-origin-fence.mjs` 守的是什么

dsh 的 `isTrustedApiRequest()` 做一件事：请求带了 `Origin` 就必须与请求 `Host` 同源，否则 403，WebSocket 升级永远完不成。而鸿蒙的 WebSocket 客户端（netstack → libwebsockets）有两条我们控制不了的行为：

1. 它**一定会**自己附一个 `Origin`，并且是按 URL 推导时**丢掉端口**的形态（`ws://127.0.0.1:3120` → `Origin: http://127.0.0.1`）；
2. 调用方在 `WebSocketRequestOptions.header` 里再给一个 `origin` 时，它**追加**而不是替换，于是线上值是 `http://127.0.0.1, ws://127.0.0.1:3120`。

这个值永远不可能等于 `127.0.0.1:3120`，所以**每一次** WS 升级都被判 403；而 ArkTS 客户端把这个失败报成 `error code=200`（"升级响应不是 101"），长期让人以为"链路是好的、只是握手后掉了"（`tools/pack-core.mjs:1155-1178`，真机 `IN-UPGRADE` 原始日志在 `:1168-1171`）。

**修法的语义边界**（很关键，不是"把栅栏关了"）：仍然要求"不得跨源" —— 只有当**某一项**与 Host 同源时才放行，跨源项一律不认。补的不是安全策略的洞，而是**多值形态**带来的误判：浏览器（单值 Origin）行为完全不变；纯原生客户端从"必被拒"变成"可同源"（`pack-core.mjs:1175-1182`）。补丁落在核心树的 `dsh-client-connection/lib/index.js`，**上游若改了这段实现会报错退出而不是静默跳过**（`:1186-1189`、`:1226-1228`）—— 悄悄发出一个"WS 永远连不上"的包，比打包失败难查得多。

**门禁守的五种情形**（`tools/check-origin-fence.mjs:175-208`）：

| case | 发什么 | 期望 |
|---|---|---|
| `clean` | 一个正确的 Origin | **101** |
| `absent` | 完全没有 Origin | **101** |
| `duplicated` | libwebsockets 形态的逗号列表 | **101**（只有打了补丁才可能） |
| `foreign` | `http://evil.example` | **403**（负对照：跨源仍须拒） |
| `no-cookie` | 有 Origin 但无 cookie | **401**（负对照：无凭据仍须拒） |

门禁跑法（`check-origin-fence.mjs:31-33`、`:156-162`）：

```bash
# 需要一个已物化的核心树（dist/core/work/dsh-core-<ver>）
node tools/check-origin-fence.mjs
# 慢机器/大机器上放宽就绪等待（本机实测冷启动 62,951 ms，默认 60 s 不够）
DSHM_CHECK_READY_MS=180000 node tools/check-origin-fence.mjs
```

**注意 argv 口径的历史**：这几个门禁原先给 `process.execPath` 起 Host 时传 `--no-experimental-fetch`，而该 flag 在 Node 22+ 已被移除 ⇒ 在 Node 24 下 Host 直接启动失败（`--no-experimental-fetch is an invalid negation`，`docs/parity-matrix.md:110`；对照 §4.1 ④）。当前 `check-origin-fence.mjs:119-124` 已把 argv 对齐到与 `RuntimePort.buildHostArgv` 同口径（`--jitless --experimental-sqlite --expose-internals <entry>`，**不带** `--no-experimental-fetch`），所以 Node 版本的约束不再是硬性的。**但放宽就绪等待仍是必需的**：本机（Orange Pi 5B + 工作区在 NFS）实测 `BOOT_60_HTTP_BIND … (+62951ms)`，**63 秒**恰好越过默认的 60 秒（`check-origin-fence.mjs:156-162`）。

### 8.3 本仓自己注册的三个端点

都挂在 `ctx.webServer` 上，都要求 token（`pyBridgeTokenOk` 常数时间风格比对，`main.js:2481-2495`）：

| 端点 | 用途 | 谁在调 |
|---|---|---|
| `GET /dshm-python/status\|run-get\|exec` | 把"从 shell 会话调进本进程内嵌 CPython"打通。执行语义全走 GET（沙箱 shell 里 toybox wget 只能 GET） | `python3`/`pip3` 桥模式垫片 |
| `GET /dshm-registry/view?token&spec` | `pnpm view --json` 的 Host 侧实现（查 npmmirror，与安装器同 registry） | `pnpm view` 假壳 |
| `GET /dshm-packages/list?token&dir` | `pnpm list --json --depth=0` 的 Host 侧实现（skin-market 用它定位已装包真实路径） | `pnpm list` 假壳 |

**注册失败一律只 `diag`，不阻断启动** —— 这三个是增量能力，不许影响已验证的 web 服务链路（`main.js:3852-3860`）。

### 8.4 验证

```bash
node tools/check-origin-fence.mjs                       # 五情形（clean/absent/duplicated/foreign/no-cookie）
DSHM_CHECK_READY_MS=180000 node tools/check-origin-fence.mjs
node tools/check-web-fetch-jitless.mjs                  # jitless 下 web_fetch 的两层垫片
# 真机（需要 hdc）：端口在听 + 端口真的应答
hdc shell "cat /proc/net/tcp" | grep -i "0C30"          # 0C30 = 3120
hdc shell "cat /proc/net/tcp" | grep -i "0C30" | grep -i " 0A "   # 状态 0A = LISTEN
```

---

## 9. 一页速查：这一章所有验证命令

```bash
# ── 布局与产物 ─────────────────────────────────────────────────────────
python -c "import zipfile;z=zipfile.ZipFile('entry/build/default/outputs/default/entry-default-signed.hap');print(len(z.namelist()))"
cat dist/core/dsh-core-0.2.0-rc.2.manifest.json

# ── 入口脚本与垫片一致性（改 hostcore/** 之后必跑）───────────────────────
node tools/place-host-app.mjs
node tools/assert-resfile-sync.mjs

# ── 语法与契约门禁 ──────────────────────────────────────────────────────
node --check hostcore/app/main.js
node tools/check-store-readiness.mjs      # 上架红线：不得出现 ACL 权限；argv 必须保留 --jitless
node tools/assert-cli-shim.mjs
node tools/assert-python-bridge.mjs
node tools/assert-exec-fix.mjs
node tools/assert-fs-search-fallback.mjs

# ── 起真 Host 的门禁（需要已物化核心树）─────────────────────────────────
node tools/check-origin-fence.mjs
node tools/check-plugin-toggle.mjs
node tools/check-web-fetch-jitless.mjs

# ── 本机以端侧同参跑一次完整启动（看 BOOT 链）───────────────────────────
DSHM_CORE_DIR=dist/core/work/dsh-core-0.2.0-rc.2 \
DSHM_HOME=dist/localtest/boot-home DSHM_SANDBOX_HOME=dist/localtest/boot-home \
DSHM_PORT=3120 DSHM_PROFILE=ondevice \
node --jitless --experimental-sqlite --expose-internals hostcore/app/main.js

# ── 真机（只覆盖安装，永不卸载）─────────────────────────────────────────
.\tools\update-device.ps1 -SkipRebuild
F=/data/app/el2/100/base/com.dshm.dshclient/haps/entry/files
hdc file recv $F/node-output.log ./node-output.log && grep -E "BOOT_" node-output.log | tail -12
hdc file recv $F/dshm-host.log   ./dshm-host.log   && grep -E "exec 探测|孤儿写锁" dshm-host.log | tail
```

---

# 第四章 界面层与语音（ArkTS 侧）

## 模块划分与依赖方向

### 分层与落点

| 层 | 目录 | 职责 | 规模（`.ets` 文件数） |
|---|---|---|---|
| entry | `entry/src/main/ets/` | 唯一 `UIAbility`、页面、视图组件、原生桥、语音桥 | `pages/` 3 · `view/` 44 · `view/shell/` 6 · `speech/` 2 · `runtime/` 1 · `entryability/` 1 |
| platform | `platform/src/main/ets/` | 系统能力封装（文件选择 / 剪贴板 / 通知 / 窗口记忆 / 密钥存储 / 设备事实） | `system/` 11 · `notify/` 3 · `window/` 2 · `runtime/` 1 |
| appstate | `appstate/src/main/ets/` | 状态中枢与投影（`store/SessionHub.ets`）+ 设计令牌与布局/导航纯逻辑 | `model/` 31 · `ui/` 7 · `store/` 1 |
| hostruntime | `hostruntime/src/main/ets/` | 核心版本仓库与激活事务、端侧 profile、运行时载体接口 | `core/` 5 · `runtime/` 2 |
| dshcompat | `dshcompat/src/main/ets/` | **上游接口事实的唯一落点**：端点、事件、字段别名、能力表 | 8 |
| connection | `connection/src/main/ets/protocol/` | dsh 线协议实现（RPC / mux / 事件流 / 认证 / 重连） | 13 |

`entry` 另有一层 `src/main/cpp/`（CMake 构建的原生模块 `libdshhost.so`、`libentryprobe.so`），它是"进程内跑 Node"的唯一入口（`entry/src/main/ets/entryability/EntryAbility.ets:39-40`）。

### 允许的依赖方向（由 `oh-package.json5` 逐条钉住）

```text
entry      → appstate, platform, dshcompat, connection, hostruntime, sherpa_onnx
appstate   → connection, dshcompat, platform
dshcompat  → connection
connection → （空）
platform   → （空）
hostruntime→ （空）
```

证据：`entry/oh-package.json5`、`appstate/oh-package.json5`、`dshcompat/oh-package.json5`、`connection/oh-package.json5`、`platform/oh-package.json5`、`hostruntime/oh-package.json5` 各自的 `dependencies` 字段。

**为什么方向必须单向**：`platform` 与 `hostruntime` 的 `dependencies` 是**空对象**，这意味着它们连"想反向依赖"都没有声明通道 —— 这是刻意的，不是遗漏。`platform/src/main/ets/system/InputDevices.ets:36` 与 `platform/src/main/ets/system/LocalPrefs.ets:145` 各留了一条注释记录原因：`platform` 在 `appstate` 之下，不许反向依赖；所以 `LocalPrefs` 只存取一个裸数字，**"这个数字合法范围是多少"的判定留在 `appstate/model`**（`detailWidthOf` / `sidebarExpandedOf` 之类）。这一刀切下去的好处是：平台层不随产品策略变，产品策略层可以随便改而不动平台。

**`appstate` 是"零 UI 依赖"**（`appstate/oh-package.json5` 的 description 原文）。可复跑的判据：

```bash
# appstate 里不该出现任何 ArkUI/系统 kit 的 import —— 期望 0
grep -rn "from '@kit\|from '@ohos" appstate/src/main/ets --include=*.ets
```

`appstate` 确实持有 `$r('sys.color.*')` 这类资源（40 处），但那是**资源标识符**而非 UI 组件依赖 —— 这是"零 UI 依赖"的边界，不是违反。它的意义在于：`appstate` 的全部逻辑能在本机用 `tsc` 直接编译执行，因此布局/导航/投影能被 `tools/check-layout-fixtures.mjs`（2157 行、覆盖 500+ 条断言）当普通 TS 单测跑，而不需要设备、不需要模拟器、不需要 hvigor。该门禁的编译方式是"把 `PURE_FILES` 列出的 `.ets` 复制成 `.ts` 后交给 CLT 自带的 tsc"——待测清单是**逐文件显式列举**的（`tools/check-layout-fixtures.mjs:37-83`），`tsc` 的路径探测见 `:91-95`（`findTsc`），并为 `$r` 补一条 ArkUI 全局声明（`:85-89`）。

> ⚠️ **量口径提醒**：本节所有行号以**按 `\n` 切分**为准（`node` / Python / `read` 工具一致）。本机 PowerShell 5.1 的 `Get-Content` 对某些含长模板串的文件**会少数行**（实测 `tools/check-layout-fixtures.mjs` 被读成 2045 行，真值 2157 行），用 `Get-Content` 定位会整体错位。核行号请用 `Select-String`（它的行号与真值一致）或 `node -e` 自己切。

### 「上游知识只允许出现在 dshcompat」—— 由 `tools/arch-check.mjs` 强制

这条纪律写在 `docs/README.md:61`（纪律第 5 条）：违反即为架构回归，与功能 bug 同级处理。

**为什么必须有门禁**：多写一处端点名字面量不会让任何东西失败 —— 代码照样编译、照样运行，直到上游改名那天才以"某个功能莫名其妙失效"的形式暴露，且极难定位（`tools/arch-check.mjs:6-8`）。它属于 `docs/70` §8.2 的"静默失效家族"。

门禁的两档判据（`tools/arch-check.mjs:17-24`）：

- **端点名 / 事件名**（形如 `ns/method` 的字符串字面量）：唯一允许出现在 `dshcompat/**`，其它模块必须 import。
- **上游线上字段名**（`requestId`、`entries`…）：允许出现在 `dshcompat/**` 与 `appstate/src/main/ets/model/Wire.ets`。**本脚本只强制第一档** —— 字段名没有可靠的正则判据，强行匹配会大量误报，而"误报的门禁等于没有门禁"。

扫描范围是四个根（`tools/arch-check.mjs:46-51`）：

```js
const SCAN_ROOTS = ['connection/src', 'appstate/src', 'platform/src', 'entry/src/main/ets'];
```

**为什么不含 `hostkit/`**（`tools/arch-check.mjs:36-45`）：`hostkit` 是独立可选的 PC 侧搭桥服务（Node 包，有自己的测试与发布面），其职责之一就是「以受管方式拉起并守护本机 dsh Host」，因此**合法地**知道上游的启动面（`dsh web` 的调用方式与它打印的启动行格式）。把它纳进来会迫使那些知识藏到一个不属于它的模块里，反而破坏分层。该注释说适用范围是"客户端**四层**（connection / dshcompat / appstate / platform / entry）"—— **括号里实际列了五个**，措辞与 `SCAN_ROOTS` 的四个根也不完全对应（`dshcompat` 不在 `SCAN_ROOTS` 里，因为它本身就是允许持有上游字面量的那一层）。这两处不一致属注释瑕疵，不影响门禁行为。

> **缺口（未验证）**：`hostruntime/src` 不在 `SCAN_ROOTS` 内，且脚本注释只解释了 `hostkit` 的排除理由，**没有说明 `hostruntime` 为何不在内**。已用 `grep -rnE "'(session|settings|workspace|assistant|tool|user|approval)/" hostruntime/src/main/ets` 跑过一次，无命中；但这是针对该模式的抽查，不等于"该目录已合规"。要补上口径，应把它加入 `SCAN_ROOTS` 后重跑。

**为什么从 `grep` 升级成脚本**（`tools/arch-check.mjs:10-15`）：原先 CI 里是一条 `grep -rnE`，它有两个致命问题 —— ① **命中注释**：说明性文档里写端点名是必要的，于是门禁长期一片红，人就开始忽略它；② **无法自检**：没人能证明那条 grep 真的会命中。因此脚本先**剥注释再匹配**（`stripComments`，`tools/arch-check.mjs:97-136`，是一个懂字符串的状态机 —— 朴素的 `//` 查找会把 `'http://127.0.0.1:3000'` 的后半行误当注释剥掉），并内置**注入式自检**。

命名空间表的维护教训同样写进了代码（`tools/arch-check.mjs:62-75`）：该表曾只含**端点**命名空间，于是对**事件**命名空间基本失明 —— 一次真实的违规里 9 处只报出 4 处；补齐后又漏了 `deliverables/` 与 `permission/`。结论是 **"门禁通过 ≠ 覆盖到了"**，门禁的覆盖面自身也要被审视。

### 目录切分的三个"为什么"

**① 为什么"载体实现"在 `entry` 而"载体契约"在 `hostruntime`**（`entry/src/main/ets/runtime/NodeRuntime.ets:7-10`）：`hostruntime` 是 HAR，它**没法直接 import 声明在 `entry/oh-package.json5` 里的原生模块** `libdshhost.so`；而 `entry` 同时能 import HAR 的类型与原生模块。所以契约（`RuntimePort` / `buildHostArgv` / `buildHostEnv`）留在 `hostruntime`，实现落在 `entry/src/main/ets/runtime/NodeRuntime.ets`。这也是为什么那个目录只有 1 个文件。

**② 为什么 `speech/` 在 `entry` 而不是 `appstate`**：识别要用 `@kit.CoreSpeechKit`（ArkTS API）与 `sherpa_onnx` HAR，两者都是"系统/HAR 能力"，`appstate` 不允许碰（零 UI 依赖的必然结论）。但其中**纯数学部分**（重采样、定长切片、累计文本合并、静音判定）被抽到 `appstate/src/main/ets/model/SpeechPcm.ets`（257 行），因为它零依赖、可单测 —— `tools/check-layout-fixtures.mjs` 对它有一整段断言（`tools/check-layout-fixtures.mjs:2006-2155`，共 **59** 条 `t.eq`，含"整数秒录音字节数能被 640 整除"`:2150-2154`）。同一条边界也用在 Web 权限裁决上：`isLoopbackOrigin` / `shouldGrantWebPermission` 放在 `appstate/src/main/ets/model/WebPermission.ets`（60 行），因为原先内联在 `@Component` 里时**没有任何门禁覆盖**，2026-09-26 真机因此暴露 bug（`appstate/src/main/ets/model/WebPermission.ets:4-10`）；该段现有 **21** 条断言（`tools/check-layout-fixtures.mjs:1961-2004`）。

**为什么"上游知识只允许出现在 `dshcompat`"这条纪律在本题上还有一层意义**：`SpeechPcm.ets` 里 `WAV_HEADER_BYTES = 44` / `WAV_BYTES_PER_SECOND = 32000` 的依据是**上游 `encodeWave()` 的头布局**（`appstate/src/main/ets/model/SpeechPcm.ets:26-39`），这属于"上游接口细节"；但同一组常量在 **Host 侧也各写了一份**（`hostcore/speech-provider/index.js:66-73`，因为两侧语言不同、无法共享模块）。两侧的**一致性**因此不靠架构纪律、而靠一条门禁断言钉住：`tools/check-layout-fixtures.mjs:2140-2148` 直接读 `hostcore/speech-provider/index.js` 做正则匹配，断言"Host 侧也写着 44 / 32000"。**这是 `arch-check` 覆盖不到的一类重复**，值得记住它的存在。

### 本节的验证命令

```bash
# 架构门禁：上游字面量只在 dshcompat
node tools/arch-check.mjs              # 期望 ✅ 无违规
node tools/arch-check.mjs --self-test  # 期望 10 个正/负样例全 ok（证明检测器会命中）
# ⚠ 脚本自己的收尾文案写的是"8 个"，与实际不符（`cases` 数组实为 10 项）—— 以实跑输出为准
node tools/arch-check.mjs --list       # 打印被扫描的文件清单

# 依赖方向：逐模块看 dependencies（应为单向、且三个底层模块为空对象）
for m in entry appstate dshcompat connection platform hostruntime; do
  echo "== $m"; node -e "console.log(require('fs').readFileSync('$m/oh-package.json5','utf8'))" \
    | tr -d '\r' | grep -A6 '"dependencies"'
done

# appstate 零 UI 依赖（期望 0 命中）
grep -rn "from '@kit\|from '@ohos" appstate/src/main/ets --include=*.ets
```

本机实测读数（2026-09-28 重测）：`arch-check` 扫描 **131** 个文件、**无违规**，自检 10/10 通过 —— `docs/parity-matrix.md:119` 已同步为同一读数（此前记的是"扫描 75 文件"）；`:121` 记 99 文件 / 102 个 `@Builder`、`:122` 记 99 文件 / **2237** 处判定声明 / 256 个门面字段（此前记的是"81 文件 / 1855 处声明"），与本章当场实跑一致。这类数字随文件数增长，**引用时仍必须以当场实跑为准**（本次同时实跑：`check-feature-wiring` 扫 133 文件 / 18 功能 / 1 条反面规则；`check-dead-code` 扫 99 文件 / 2237 处声明 / 256 个门面字段）。

---

## Web 视图加载链

### 链路全程

```text
UIAbility.onCreate
  └─ autoStartHostForDiagnosis()            EntryAbility.ets:262 / 定义 :374
       ├─ installBundled(resourceDir,cacheDir)   :396   （首启解包核心树）
       ├─ host.start()                            :401
       └─ adoptLocalHost(handle.url)               :406 / 定义 :425
            └─ AppStorage.setOrCreate(KEY_HOST_LAUNCH_URL, handleUrl)   :453
                     │
                     ▼   （AppStorage 是能力层与页面之间的约定交接通道）
Web 壳页 pages/WebApp
  @StorageProp('dshHostLaunchUrl') @Watch('onLaunchUrlChanged') launchUrl   WebApp.ets:645
  onLaunchUrlChanged → enterLoading()                                       :1095 / :1101
  build(): Web({ src: this.launchUrl, controller: this.controller })         :1977
  onPageEnd → phase = READY, everReady = true, finishProgress()              :2042/:2044/:2051
```

启动 URL 的两个来源（`EntryAbility.ets:127-136` 的注释 + `:425` / `:684` 两处实现）：① 本端自起 Host（dsh 打印带 token 的地址 → 入口脚本写 `host-ready.json` → `NodeRuntime.start()` 读出放进句柄）；② 启动参数（`aa start --ps dshHost … --ps dshToken …`）。**只有本键（`dshHostLaunchUrl`）被 Web 页消费**，不认 `dshLastHost*` 那组 —— 后者是"记住的 Host"语义，token 对**本次进程**可能是旧的（dsh 每次启动换 token），而本键只在"本次启动成功"或"启动参数显式给出"后才发布，拿到的 token 一定有效（`entry/src/main/ets/pages/WebApp.ets:14-17`）。

**就绪判定为什么是轮询回环端口而不是解析 stdout**（`entry/src/main/ets/runtime/NodeRuntime.ets:12-14`、`:277-285`）：`DSHM_READY` 是入口脚本打到 **stdout** 的，而应用进程的 stdout 在设备上不可见（`docs/70` E23）。回环端口能应答 TCP，就说明 Host 真的在监听。这里还刻意**放弃 `@ohos.net.http`**：真机实测（2026-09-20）Host 在 `127.0.0.1:3120` 正常 LISTEN、设备外经 `hdc fport` 也能拿到 401 应答，但应用进程内 `http.createHttp()` 的 GET 在 15 秒预算里**全部**超时（HTTP 栈受系统代理等环境因素影响）；TCP connect 则是"在不在监听"的最原始事实。**任何应答（哪怕 404）都算"在监听"**。

`host-ready.json` 的读取还带 **pid 校验**（`NodeRuntime.ets:199-209`）：应用重启的窗口里可能读到**上一次进程**留下的文件，其 token 对本次 Host 无效，拿去只会换来 401。既然 Node 线程的 `process.pid` 就是应用进程 pid，`pid` 不符即一票否决。

### 坑 1：首载早于宿主就绪 ⇒ 404

**机制**：宿主的启动链是 `BOOT_40_PROFILE_BOOT` → `BOOT_50_DSH_INIT` → `BOOT_60_HTTP_BIND`（端口绑定）→ `BOOT_65_AUTH_URL`（写 `host-ready.json`）→ `BOOT_70_HTTP_READY`（自探 HTTP），标记定义在 `hostcore/app/main.js:627-630`（注释块），五处落点分别是 `:3828`（`BOOT_40`）、`:3844`（`BOOT_50`）、`:3850`（`BOOT_60`）、`:849`（`BOOT_65`，写 `host-ready.json`）、`:3872`（`BOOT_70`）。

真机分段实测（`docs/device-validation.md:3925-3934`）：

| 阶段 | 耗时 |
|---|---|
| `aa start` → Node 起来 | ~2.1 s |
| Node → `BOOT_40_PROFILE_BOOT` | 0.3 s |
| **`BOOT_40` → `BOOT_50_DSH_INIT`** | **7.4 s**（`runProfile` 内部，dsh 加载插件树）|
| → `BOOT_70_HTTP_READY` | 0.2 s |
| WebView 加载 → 200 | 1.7 s（含一次 600ms 自动重试）|

而**首启解包核心树时这段可达 30–60 秒**（`entry/src/main/ets/pages/WebApp.ets:19` 的阶段机注释）。

**为什么必然 404**：Web 组件的 `src` **直接绑定** `launchUrl`（`WebApp.ets:1977`），只要这个值在"端口刚监听、路由还没挂"的窗口里被置上，页面就会在那一瞬间发起请求 ⇒ 拿回 **HTTP 404**（真机记到 `is_error_page=1`, `net_error=-379`），见 `WebApp.ets:1135-1137`。

**为什么不能靠"消除竞态"**：宿主启动耗时不可预测（首启解包 / 插件数 / 设备负载），**消除不了**。所以修法不是消除竞态，而是**让页面会自己重试**（`WebApp.ets:1140-1141`）。

### 坑 2：失败后没有自愈 ⇒ 用户只能手动刷新

**修法**：`scheduleAutoRetry()`（`WebApp.ets:1199-1222`），指数退避 `600 * 2^n`，上限 `AUTO_RETRY_MAX = 6`（`WebApp.ets:1191`）。

```ts
const delay: number = 600 * Math.pow(2, this.autoRetryCount);   // WebApp.ets:1208
```

**为什么用递增退避而不是固定间隔**（`WebApp.ets:1143-1145`）：宿主启动是秒级且不可预测，固定间隔会在宿主还没起来时空转多次；退避能在头几秒快速跟上，又不至于一直高频重试。它覆盖所有**时序性失败**：404（路由未就绪）、连接被拒（端口未监听）、401（宿主刚重启、token 换过）。

**为什么重试调用 `retry()` 而不是 `refresh()`**（`WebApp.ets:1216-1219`）：`retry()` 已处理"`launchUrl` 仍为空"的情形（退回 `BOOTING` 等宿主就绪，`WebApp.ets:1366-1373`），而 `refresh()` 会对着空 URL 空转。`retry()` 在 URL 为空时**也要排重试** —— 因为 `launchUrl` 为空的成因同样是时序：只被动等 `@Watch` 会漏掉"发布已发生过、但当时页面还没创建"的组合。

真机取证（文件标记，`docs/device-validation.md:4008`）：

```text
失败：HTTP 404
  ↳ 保持启动页（未向用户展示错误页），重试预算剩 6 次
成功：页面已就绪（200）
```

### 坑 3：有重试预算时必须保持启动页，不向用户弹错误页

**为什么**（`WebApp.ets:1161-1173`）：`fail()` 里立刻置 `phase = ERROR` 会让用户**先看到一次**「无法连接本地核心 / Host 返回 HTTP 404」，约 600ms 后自愈又跳走 —— 这正是"启动报错，然后又进去了"的直接原因。自愈本身没问题，**把一次内部重试暴露给了用户**才是问题。

**判据**（`WebApp.ets:1175-1184`）：

```ts
if (this.autoRetryCount < WebApp.AUTO_RETRY_MAX) {
  this.phase = WebPhase.LOADING;   // 保持启动页，不切 ERROR
  this.scheduleAutoRetry();
  return;
}
this.phase = WebPhase.ERROR;       // 预算用尽才是真失败
```

**这条规则的边界**：它只把 `fail()` 挂在了 Web 回调（`onErrorReceive` / `onHttpErrorReceive`，`WebApp.ets:2093/2099`）上。因此存在一个**已知限制：宿主彻底起不来时没有超时兜底** —— 实现依赖宿主自行报错。这一条在独立审查中被提出，经核实后**有意未改**，已登记为已知限制（`docs/device-validation.md:4136`）。

### 坑 4：启动页要覆盖 BOOTING **与** LOADING，且必须带 `!everReady`

**修法**（`WebApp.ets:2132-2133`）：

```ts
if (this.phase === WebPhase.BOOTING
  || (this.phase === WebPhase.LOADING && !this.everReady)) {
```

**为什么 LOADING 也要盖**（`WebApp.ets:2117-2130`）：原实现只给 `BOOTING` 盖启动页，而阶段流转是 `BOOTING（显示启动页）→ enterLoading() → LOADING → 200`。`LOADING` **没有任何覆盖层** ⇒ 这一阶段直接露出底层 Web 组件：页面此时要么还没渲染完（空白），要么正显示上面那次 404 的错误页。用户看到的就是"启动页过后有 2 秒左右白屏"。

**为什么必须带 `!everReady`（这是上一次修复自己引入的回归）**：`onPageBegin`（`WebApp.ets:2021-2026`）在**整页导航**（303 落地、点链接跳转）时也会把 `READY` 打回 `LOADING`。若只看 `phase`，**应用内每次整页跳转都会闪一下启动页**。`everReady` 只在首次 `onPageEnd` 时置 `true`（`WebApp.ets:2044`），此后不再把启动页盖在 LOADING 上。字段定义与理由见 `WebApp.ets:686-695`。

**第二个必须记住的次生陷阱：`onPageEnd` 在失败时也会触发**（`WebApp.ets:2027-2041`）。真机日志显示两者**只差 10ms**、且顺序是"先 404 后 onPageEnd"：

```text
47.144 web UI 加载失败：Host 返回 HTTP 404     ← fail() 置 ERROR 并排重试
47.154 web UI 页面渲染完成（phase=READY）      ← 原实现无条件覆盖成 READY
```

后果有两层：① ERROR 被瞬间抹掉，用户看到的是 ArkWeb 自己的 404 错误页（**白屏**）；② 若这里再清重试，刚排上的自愈也会被取消。所以加了 `loadFailed` 标志（`WebApp.ets:703-710`），**失败标记优先**：加载出错时 `onPageEnd` 不得改写阶段、也不得清重试。

### 坑 5：进度条必须"时间驱动"，且要匀速线性而非指数曲线

**为什么必须时间驱动**（`WebApp.ets:1549-1553`）：宿主启动耗时**不可预知** —— 正常约 8 秒（主体是 dsh 的插件初始化），首启解包核心树可达 30–60 秒。**没有任何可读的真实进度源**（`BOOT_xx` 只打在宿主 stdout，ArkTS 读不到中间值）。所以进度条不是"进度指示"，而是"**正在加载**"的表达。

**为什么不用指数曲线**（`WebApp.ets:1555-1568`）：前两版都用 `90·(1−e^(−t/τ))`，用户**两次**反馈"冲"。实测速度分布是关键：

```text
τ=3.2s ⇒ t=0s 时 28.1 %/s，t=8s 时 2.3 %/s  ——  相差 12 倍
```

也就是"开头猛冲、后面几乎不动"。指数曲线**天然不匀速，再怎么调 τ 也治不好"冲"**（调小 τ 更冲）。

**现在的曲线**（常量全在 `WebApp.ets:670-685`）：

| 常量 | 值 | 作用 |
|---|---|---|
| `PROGRESS_RATE` | 11.5 %/s | 匀速主段速度（按实测冷启动 ~8 秒标定：8 秒到 ~92%，92/8≈11.5）|
| `PROGRESS_CREEP_AT` | 92 % | 匀速段终点，之后转极慢爬升 |
| `PROGRESS_CREEP_RATE` | 0.3 %/s | 慢爬速度（只表达"还在动"）|
| `PROGRESS_CEIL` | 98 % | **自走上限，永不自走到 100%** |
| `PROGRESS_FINISH_MS` | 380 ms | 就绪时的收尾缓出时长 |

ticker 实现在 `WebApp.ets:1576-1607`：收尾阶段用 ease-out cubic（`:1586-1588`），常规阶段用 `(elapsed/1000)*PROGRESS_RATE`（`:1597-1606`），节拍 **40ms（25fps）**（`:1607`）。

**另外三个为"丝滑"做的决定**：

1. **不取整**（`WebApp.ets:1571-1572`）：`Math.floor` 会让整数位连续多拍不变（看着像卡住），攒够再跳一格 —— 那也是"冲"的一部分。`Progress.value` 接受浮点。
2. **停表判据写在 ticker 内部**（`WebApp.ets:1593-1596`）：只有 `READY`/`ERROR` 才停表。**`enterLoading()` 不许停表** —— 这是 E-SP1 修复的副作用教训：启动页挂到 LOADING 之后，若 `enterLoading()` 里仍 `stopLoadTicker()`，就会形成"进 LOADING 冻住 → 就绪时 `= 100` 一次性猛跳"（`WebApp.ets:1102-1115`）。
3. **就绪时不由外部直接赋值 100**（`WebApp.ets:1611-1617`）：实测就绪时进度约在 80%，一把设 100 就是"突然冲一下"。改由 `finishProgress()`（`:1618-1627`）置 `progressFinishing`，让 ticker 自己用 380ms 补完。

### 本节的验证命令

```bash
# ① 静态核对五条硬判据（不依赖设备）
grep -n "stopLoadTicker" entry/src/main/ets/pages/WebApp.ets          # enterLoading(:1101-1122) 内不得有
grep -n "Math.exp"       entry/src/main/ets/pages/WebApp.ets          # 期望 0 命中（匀速方案）
grep -n "everReady"      entry/src/main/ets/pages/WebApp.ets          # 启动页条件必须含 !everReady(:2133)
grep -n "loadFailed"     entry/src/main/ets/pages/WebApp.ets          # onPageEnd 必须先用它阻断(:2037)
grep -n "AUTO_RETRY_MAX" entry/src/main/ets/pages/WebApp.ets          # 有预算 ⇒ 保持 LOADING(:1175)

# ② ArkTS 真编译（比"读代码"强一档；缺 CLT 时退出码 3 = 环境受阻，不是通过）
node tools/check-arkts-entry.mjs

# ③ 真机：装机后看文件标记（本机 hilog 有丢日志前科，时序类排查必须用文件）
hdc shell "cat /data/app/el2/100/base/com.dshm.dshclient/haps/entry/files/diag-web-load"
#   期望出现：失败：Host 返回 HTTP 404 → ↳ 保持启动页… → 成功：页面已就绪（200）

# ④ 真机：宿主侧的启动分段（注意位置——BOOT_* 不在 dshm-host.log）
hdc shell "cat /data/app/el2/100/base/com.dshm.dshclient/haps/entry/files/dsh/home/node-output.log" | grep BOOT_
#   若只看 dshm-host.log 会误判成"宿主从未就绪"（docs/70 E-SV20）
```

**诊断通道的分工必须分清**（`docs/70-鸿蒙移植踩坑与修复总览.md:549-550` 与 `:1090`）：`log()` / `stage()` / `DSHM_READY` 走 **stdout**（`node-output.log`），`diag()` **写 `dshm-host.log` 并同时镜像到 stdout**（`hostcore/app/main.js:79-92`：`diagStream.write` + `process.stdout.write`）。注意别写成"走 stderr"——stderr 在 `dshhost.cc:255` 被 `dup2` 指向 `node-output.log`，与 `dshm-host.log` 无关⇒ **两个文件都要拉**。Web 侧的 13 个 `diag-*` 标记全部由 `DshDirectoryPickerBridge.writeDiagMarker`（`WebApp.ets:457-471`）以**追加模式**写进 `filesDir`，判据是"文件里有那行"而不是"hilog 打过"。

---

## 原生麦克风与语音识别

### 为什么必须绕开 `getUserMedia`

官方语音 UI 的录音走浏览器 `navigator.mediaDevices.getUserMedia` + `MediaRecorder`，**录音发生在内嵌 Web 组件里**。`tools/pack-core.mjs:400-408` 记录了对照实验（这是整块工作的出发点）：

| 路径 | 并发 `getUserMedia` | 识别结果 |
|---|---|---|
| 自检（ArkTS 直采 + 识别）| 无 | `"12342234。"` ✅ |
| 无并发桥（采好再识别）| 无 | `"一到三四号三四。"` ✅ |
| 官方按钮 | **有** | `"。"` ❌ |

已排除 12 个假设（采样率 / 高频 / 降噪 / AEC / 编解码 / 时长 / 投喂路径 / 噪声化…）。**结论：只要官方 `Recording.start()` 打开 `getUserMedia`，识别就崩；不并发它就正常。**

另一个佐证是"音频本身没问题"：采集侧落盘的 `native-btn-audio.wav` 与桥收到的 `last-audio.wav` **sha256 完全一致**，声学指标同级（`docs/device-validation.md:3114`）。

### 修法：覆盖 `Recording.prototype` 的采集，不动其它

`tools/pack-core.mjs:421` 的 `patchVoiceInputNativeCapture()` 在 `dsh-experimental-client-ui-voice-input/lib/client.js` 里**追加**一段覆盖：

- **只换采集**：覆盖 `start()` / `stop()`（和后面的 `amplitude()`），官方后续的 `transcribe() → provider → 识别 → 插入草稿`**全部保留**（`tools/pack-core.mjs:410-414`）。
- **追加而非锚点替换**：`Recording` 是模块级变量，同作用域可引用 ⇒ 不依赖任何锚点，不会被上游格式变化打断。
- **但必须插在 factory 内部**（`tools/pack-core.mjs:551-562`）：`client.js` 是 `window.__ModuleLoader__.load({ factory: (require) => { … return module.exports; } })` 的形式，`Recording` 定义在 factory 里。若追加到**文件末尾**（factory 之外），`Recording` 不在作用域 ⇒ 抛 `ReferenceError` ⇒ 覆盖不生效（真机表现：`diag-native` 永远为空）。所以插到 `return module.exports;` **之前**。
- **只用块注释**（`tools/pack-core.mjs:459-462`）：整段是**单行**模板，写 `//` 会把后面整行注释掉。

**幂等必须带版本号，不能"存在即跳过"**（`tools/pack-core.mjs:431-454`，E-SV14）：原守卫只要文件里含标记就整段跳过，于是给注入段**新增 `amplitude` 覆盖**时，核心树里已有旧版注入 ⇒ 新版永远注入不进去，而 `pack-core` 仍报"✓ 完成"，表现为"改了补丁但设备行为没变"。现在用 `DSHM_NATIVE_CAPTURE@v3-permission-window`（`tools/pack-core.mjs:439-440`）：版本一致才跳过，版本不同则**先删旧注入段再注入新版**（不删会出现两份 `start`/`stop` 覆盖，后者包住前者）。

### 原生采集链（ArkTS 侧）

桥的注册（`entry/src/main/ets/pages/WebApp.ets:758-764`）：

```ts
private bridges: Record<string, Function> = {
  'startPick': …, 'onThemeMode': …,
  'startNativeCapture': (): string => this.startNativeCapture(),
  'nativeCaptureState': (): string => this.nativeCaptureState(),
  'takeNativeCapture': (): string => this.takeNativeCapture()
};
```

`.javaScriptProxy` 注册点为 `WebApp.ets:2013-2018`（`name: '__DSHM_BRIDGES__'`，`methodList` 五项）。**桥必须聚合成一个对象、只注册一次** —— 同一 Web 组件上链式写两次 `.javaScriptProxy({...})` **只有最后一个生效**，判据来自真机 DOM 探针的"交换顺序后可见性精确对调"（`WebApp.ets:1999-2010`）。

完整链路：

```text
官方麦克风按钮（Web）
  └─ Recording.start() 被覆盖 → __DSHM_BRIDGES__.startNativeCapture()
       └─ startNativeCapture()                         WebApp.ets:802
            ├─ ensureMicPermission()                    :780   （先申请，再开采集）
            └─ startNativeCaptureWithPermission()       :840
                 └─ audio.createAudioCapturer(16k/单声道/S16LE/RAW)   :841-852
                      └─ on('readData') 累积 natChunks，同时算 peak/RMS   :855-902
  └─ Recording.stop() → __DSHM_BRIDGES__.takeNativeCapture()
       └─ takeNativeCapture()                          :948
            └─ natPcmToWav()（44 字节 canonical WAV 头）:86 → base64      :1007
  → RPC speech/transcribe → provider（Host/Node）
       └─ 写 <id>.req 到 hms-bridge 队列                hostcore/speech-provider/index.js:225-238
            └─ HmsSpeechBridge 轮询取件                  entry/src/main/ets/speech/HmsSpeechBridge.ets:197
                 └─ SenseVoiceRecognizer.recognize(pcm)   speech/SenseVoiceRecognizer.ets:194
            ← 写 <id>.done / <id>.fail                    HmsSpeechBridge.ets:720
       ← 读回文本 → 官方 UI insertText 填进输入框草稿
```

### 坑：全新安装首次录音必失败（权限从未申请）

**机制（架构性的）**（`WebApp.ets:766-779`，E-SV13）：官方流程是「Web 侧 `getUserMedia` → 触发 `onPermissionRequest` → 客户端调 `requestPermissionsFromUser`」。但**原生采集覆盖绕过了 `getUserMedia`**（直接调 `createAudioCapturer`），那条申请路径永远不会被走到 ⇒ 全新安装时权限从未授予 ⇒ `createAudioCapturer` 失败 ⇒ 界面显示「录音中断，请重试」。

**为什么测试包看不出来**：测试包 `micverify` 早前已授权（换签名前的包），正式包 `dshclient` 换了签名属于全新安装，**必然**首次失败。

**修法**：`startNativeCapture()` 先 `ensureMicPermission()` 再开采集（`WebApp.ets:821-836`）；同时 JS 侧等待窗口 **3 秒 → 15 秒**（`tools/pack-core.mjs:513-518`），因为首次会弹系统授权框，"用户读完再点"是**人的时间尺度**，旧窗口会在用户还在看弹框时就超时（现象：点一下没反应，再点才可能成功）。

真机证据（`docs/device-validation.md:3555-3561`）：

```text
2026-09-27T03:35:52.341Z ensureMicPermission granted=true results=[0]
2026-09-27T03:35:52.381Z ★ 官方按钮 → 原生采集已启动
2026-09-27T03:35:56.021Z ★ 取走 115840 字节（3620ms，peak=28376）
2026-09-27T03:35:57.343Z 改用 SenseVoice pcm=115840B
```

**两道闸门缺一不可**（`entry/src/main/module.json5:107-122` 与 `WebApp.ets:1241-1244`）：`module.json5` 声明 `ohos.permission.MICROPHONE` ⇒ 系统层有权限；`Web()` 上挂 `onPermissionRequest` 并显式 `grant(AUDIO_CAPTURE)` ⇒ Web 内核允许页面访问麦克风。只做前者：WebView 仍拒绝；只做后者：系统层拿不到设备。`ohos.permission.MICROPHONE` 是 `user_grant`，**按需懒申请**而不是启动就弹（`WebApp.ets:1295-1301`）。

**回环判定必须容忍结尾斜杠**（`appstate/src/main/ets/model/WebPermission.ets:21-28`）：真机实测 ArkWeb 的 `getOrigin()` 返回 `http://127.0.0.1:3120/`（**带结尾斜杠**），而原正则 `(:\d+)?$` 要求端口后立刻结束 ⇒ 判成非回环 ⇒ **把本应用自己的麦克风请求也 DENY**。同时不允许用 `startsWith('http://127.0.0.1')` 之类的宽松匹配 —— `http://127.0.0.1.evil.com` 会骗过它。现在是锚定的完整正则（`WebPermission.ets:37`），并有 21 条 fixture 断言（`tools/check-layout-fixtures.mjs:1968-2004`，含"前缀伪装"`http://127.0.0.1.evil.com` 与"路径里带回环"`http://evil.com/127.0.0.1/` 两个反例）。

### 波形 / 电平是怎么来的

**现象**：说话时波形是静止的最小值（E-SV15）。

**根因**（`tools/pack-core.mjs:469-476`）：官方 `Waveform` 组件每 50ms 调 `recording.amplitude()`，而它读的是 `this.analyser`（`AudioContext.createAnalyser()`）。原生采集覆盖了 `start()` ⇒ **创建 analyser 的那段被跳过** ⇒ `amplitude()` 恒返回 0。

**修法**：覆盖 `Recording.prototype.amplitude`，改读 ArkTS 侧 `nativeCaptureState()` 的 `rms` 字段（`tools/pack-core.mjs:488-503`）。

**为什么用 RMS 而不用峰值**（`tools/pack-core.mjs:482-486` + `docs/device-validation.md:3575-3584`）：官方按下式使用该值 —— `height = 1 + Math.min(1, level * 5) * 17`（18 = 满格），且官方 `amplitude()` 返回的就是 RMS。真机实测：

| 场景 | peak | peak/4 | 真 RMS（= 官方口径）|
|---|---|---|---|
| 平静说话 | 21020 | 14.6 / 18 | **9.1** |
| 较大声 | 28311 | 18.0（顶格）| **11.9** |

⇒ 用峰值即使除以 4 也几乎顶格，看不出起伏。

**性能纪律（这条最重要）**：平方和在**已有**的采样循环里顺带累加（每 8 样本一次乘加），**不新增遍历**（`WebApp.ets:862-901` 的注释）。此前在实时回调里额外加逐样本计算，**导致丢块 ⇒ VAD 失效 ⇒ 识别全灭**。三个量各司其职：`natPeak`（累计峰值，只增不减，诊断用）、`natRecent`（最近一次回调的峰值，柱状图用）、`natSumSq/natSampleCount`（算 RMS，频谱用，带指数平滑 `natRms = natRms*0.6 + batchRms*0.4`，见 `WebApp.ets:898-899`）。

**另外三个采集侧的坑**：

1. **`readData` 的 `ArrayBuffer` 必须拷贝**（`WebApp.ets:856-860`）：采集器**复用**同一个 `ArrayBuffer`，不拷贝会得到一堆指向同一块内存的引用。
2. **`takeNativeCapture()` 里必须在清零之前保存 peak**（`WebApp.ets:951-956`）：原实现把 `natPeak = 0` 放在前面，而诊断语句还要读它 ⇒ 永远报 `peak=0`，让人误判"录到的是静音"。真机证据：provider 侧收到同一份音频时 `peak=28371`。
3. **`javaScriptProxy` 是同步契约，但停止采集是异步的**（`WebApp.ets:968-977`）：JS 侧要立即拿到 base64，所以先 `cap.off('readData')`（立即停收）→ 返回 → `stopAndReleaseLater()` 延后 300ms 停止并释放（`WebApp.ets:938-946`）。若不等释放就开始识别，采集与识别会争音频资源。

诊断落盘：每次取走都把 WAV 写进 `filesDir/native-btn-audio.wav`（`WebApp.ets:995-1006`），这是唯一能定论"识别为空是音频问题还是别的问题"的办法。

### 模型改为在线下载

**为什么不在 HAP 内置**（`docs/device-validation.md:3463-3465`、`docs/70:1043-1044`）：内置时模型放 `entry/src/main/resources/rawfile/sensevoice/`，**HAP 从 ~300MB 涨到 550MB**。

**为什么下载放在 host 侧（Node）而不是 ArkTS 侧**（`hostcore/speech-models/index.js:5-14`，两条路线对比见 `docs/device-validation.md:3467-3485`）：Node 侧已有可用的 HTTP 通道（`fetch` 垫片基于 `node:http/https`）与 `node:crypto` 的 `createHash` —— 下载 + sha256 校验开箱即用；ArkTS 侧要引入 `cryptoFramework` 才能算 sha256，且大文件读写受单次 write 限制、需自行分块。落盘位置同属应用沙箱，ArkTS 侧可直接用绝对路径读取。

**资源清单**（`hostcore/speech-models/index.js:35-54`）：

| 文件 | 字节 | sha256 前 16 位 | 来源 |
|---|---|---|---|
| `model.int8.onnx` | 239,233,841 | `c71f0ce00bec95b0` | gitcode Release 附件（超 git 单文件上限）|
| `tokens.txt` | 315,894 | `f449eb28dc567533` | 仓库 raw |
| `silero_vad.onnx` | 1,807,522 | `a35ebf52fd3ce5f1` | 仓库 raw |

**两级校验（这是本题最容易做错的设计）**（`hostcore/speech-models/index.js:56-91`）：

- **默认**只 `stat`（存在 + 字节数，O(1)）；
- 只在**下载收尾**与显式 `{ verify: true }` 时才 `readFileSync` 整文件算 sha256。

**为什么不能每次都算 sha256**（`hostcore/speech-models/index.js:59-74`）：早期实现每次调用都整读文件算哈希，而 `missingAssets()` 被 `transcribe`、`inspect()`、`preparation.snapshot()` 路径反复调用 ⇒ **每次识别都要把 228MB 读一遍 + 哈希一遍**；且它与下载路径刻意做的"流式写盘、避免 228MB 峰值"**自相矛盾**。取舍是：文件一旦经 sha256 校验才会被 `renameSync` 到正式名，此后被改写/损坏的概率极低（`downloadAsset`，`hostcore/speech-models/index.js:166-174`），而每次读 228MB 是**确定**的代价 —— 用确定的小代价换极小的风险。

**下载本身的两个决定**：

1. **边读边写盘**（`hostcore/speech-models/index.js:127-136`）：228MB 若先累积成数组再 `Buffer.concat`，需要约两倍峰值内存；端侧 Node 跑在嵌入式运行时上，这种分配可能失败，且失败信息**容易被误读成"磁盘空间不足"**（E-SV11：界面报"磁盘空间不足或没有写入权限"，实际磁盘空闲 174GB）。改成 `openSync` + `writeSync` 后 PC 实测峰值 `heapUsed` 从 228MB+ 降到 **9.9MB**。
2. **先写 `.part` 再原子改名**（`hostcore/speech-models/index.js:107-109`）：直接写目标名时，若中途失败会留下一个尺寸不对但名字正确的文件，下次启动会把它当成"已存在"而跳过下载。

**provider 侧必须提供 `preparation`**（`hostcore/speech-provider/index.js:176-191`、`docs/device-validation.md:3460-3465`）：模型不再随包内置 ⇒ 首次使用前要下 228MB。若不报状态，UI 会认为 provider 一直可用，用户点麦克风后长时间无响应且无从得知原因。上游 UI 读 `preparation.snapshot().phase`：`downloading` ⇒ 渲染进度条（用 `completedBytes`/`totalBytes`），`failed` ⇒ 渲染失败提示，`unprepared` ⇒ 触发"需准备"引导；`reason` 取值域见 `docs/device-validation.md:3448-3449`。

**启动就下、不等用户点麦克风**（`hostcore/speech-provider/index.js:258-267`）：那会让首次使用变成"点了之后长时间无响应"。失败不中断启动，只把状态置为 `failed`（UI 显示原因）。`transcribe` 里也做了一次"缺就先下载再投递"（`hostcore/speech-provider/index.js:207-212`）—— 对用户来说"第一次慢一点"远好于"第一次报错"。

**provider 注册里的一个反直觉细节**（`hostcore/speech-provider/index.js:18-25` 与 `:186-191` 的**互相矛盾**）：文件头注释说"**不提供 preparation** ⇒ 服务报 `phase=ready` ⇒ 按钮可用"，而代码里 `preparation: prep` 是**提供了**的（同一文件 `:186`）。这是文档与代码不同步：注释描述的是模型随包内置时代的形态，改成在线下载后**必须**提供（否则首次使用表现为"点了没反应"，`docs/device-validation.md:3464-3465`）。**改这块代码前先以代码为准，并留意这段注释会误导人。**

### ArkTS 侧从**沙箱文件路径**加载模型

`entry/src/main/ets/speech/SenseVoiceRecognizer.ets:64-75` 记录了这个关键依据（sherpa-onnx 源码，`harmony-os/.../non-streaming-asr.cc`）：

```cpp
bool use_resource_manager = info.Length() == 2 && !info[1].IsUndefined() && !info[1].IsNull();
if (use_resource_manager) {
  recognizer = SherpaOnnxCreateOfflineRecognizerOHOS(&c, mgr.get());  // 从 rawfile 读
} else {
  recognizer = SherpaOnnxCreateOfflineRecognizer(&c);                 // 从文件系统读
}
```

⇒ **不传 `resourceManager` 就走文件路径**（与 Linux/Windows/macOS 同一条路径）；另注 OHOS 版在 `mgr === nullptr` 时也会回退到通用路径，是双保险。

模型目录由 `$DSH_HOME` 推导，两侧**不新增配置项**（`SenseVoiceRecognizer.ets:113-125` 与 `hostcore/speech-provider/index.js:117-126`）：

```text
provider 侧：dataRoot = dshHomePath('speech-to-text','sensevoice')
             queueDir = dirname(dataRoot) + '/hms-bridge'
ArkTS  侧：<filesDir>/dsh/home/speech-to-text/sensevoice
真机读数：$DSH_HOME = <filesDir>/dsh/home
```

`modelsReady()` 判"三个文件都在且 size > 0"（`SenseVoiceRecognizer.ets:127-149`）—— **只判存在会让"点麦克风就崩"变成"点了没反应"**（下载中断会留下 0 字节或截断的文件）。

### 预热必须重试（模型下载完才轮到预热，只预热一次必然失败）

`entry/src/main/ets/speech/HmsSpeechBridge.ets:135-189`。

**为什么必须预热**（`HmsSpeechBridge.ets:124-134`）：provider 侧单次识别预算 `TIMEOUT_MS = 25000`（`hostcore/speech-provider/index.js:65`，`awaitResult` 在 `:476-504`）。若不预热，**第一次**点麦克风要在这 25 秒里完成"读 228MB 模型 + 建 onnxruntime session + 初始化 Silero VAD"，超时对用户表现为"识别超时" —— **必然发生，不是概率问题**。

**为什么只预热一次会失败**（`HmsSpeechBridge.ets:136-149`）：旧形态下模型随包内置（rawfile），桥一启动就能预热成功。现在模型由 host 侧在启动后**异步下载**（首启约 228MB），而桥启动通常**早于**下载完成 ⇒ 只预热一次必然"失败"，之后**再没有任何时机**触发预热。

**修法**：按间隔重试，直到成功或超过窗口。

| 参数 | 值 | 出处 |
|---|---|---|
| `WARM_RETRY_MS` | 3000 ms | `HmsSpeechBridge.ets:150` |
| `WARM_WINDOW_MS` | 5 分钟 | `HmsSpeechBridge.ets:151` |

**先让 `modelsReady()` 探路**（`HmsSpeechBridge.ets:158-163`）：模型文件不在时直接重试，**不去构建 `OfflineRecognizer`** —— 后者在文件缺失时会走一遍失败路径（读路径、建 session 的失败开销），没必要反复付；`modelsReady()` 只做 stat，代价可忽略。

`warmUp()` 内部先 `setTimeout(0)` 让出一次（`SenseVoiceRecognizer.ets:173-176`）：ArkTS 主线程上做长同步加载会卡住 UI，本项目已吃过同类亏（`docs/70` E45 的 `LIFECYCLE_TIMEOUT` + `SYS_FREEZE`）。**失败不抛**（`SenseVoiceRecognizer.ets:164-165`）：真正的错误留到 `recognize()` 里如实抛出，那时用户能看到原因，而不是在启动阶段静默失败。桥的调用点**刻意不 `await`**（`HmsSpeechBridge.ets:132-134`）：桥必须立刻开始轮询，否则请求堆在队列里。

**与官方示例的两处刻意偏离**（`docs/70:1098-1126`）：官方把 ASR 放在 worker 线程，本实现放在桥的线程（桥本身不在 UI 渲染路径上；再加 worker 会引入"worker 生命周期 + 消息序列化"两个新失效面，而识别是串行、用户显式触发的）；官方在 `aboutToAppear` 里显式初始化，本实现用 `warmUp()` 预热 + `ensureReady()` 懒加载兜底。**若日后发现卡 UI**，把 `SenseVoiceRecognizer` 整体搬进 worker 是干净的改法 —— 它已经是无 UI 依赖的独立类，接口只有 `recognize(pcm)`。

### 从 HMS 换成 SenseVoice（为什么）

HMS `speechRecognizer` 是**流式听写引擎**，带内建 VAD 端点检测，七轮真机实测的硬约束（`docs/70:894-908`）：单会话只处理**开头 4~5 秒**（喂入 4025~4152ms 即提前结束，4.0/8.0/13.82s 音频返回同一结果）；端点检测不可关（`extraParams` 全 SDK 只有 `locale`/`recognizerMode`/`online` 三个键）；`recognizerMode:'long'` **更差**（实测禁用 VAD、返回空）；前导静音有害（中段音频 +220ms 静音即让 VAD 完全不触发）。⇒ **4~5 秒是引擎固有行为，不是配置问题。**

SenseVoice 是**离线批处理模型**：一次给整段音频、一次出结果，没有端点检测截断问题（`SenseVoiceRecognizer.ets:4-8`）。代码保留回退：`SenseVoice 优先 → 失败回退 HMS`（`HmsSpeechBridge.ets:536-548`），便于对照。

**`onEvent` 是 SDK 要求的 5 个回调之一，不是可选的诊断钩子**（`HmsSpeechBridge.ets:641-653` 与 `docs/device-validation.md:3153`）：`RecognitionListener` = `onStart` / `onEvent` / `onResult` / `onComplete` / `onError`。清理代码时曾误删它，导致识别全部为空。**教训：诊断代码也算代码，清理后要重验功能。**

### 队列协议与它的三个自愈点

队列目录 `$DSH_HOME/speech-to-text/hms-bridge`（`HmsSpeechBridge.ets:106`），协议：`<id>.req`（Host 写，JSON `{audio: base64, language}`）→ 本侧改名为 `<id>.wip`（`HmsSpeechBridge.ets:409-414`）→ 写 `<id>.done` / `<id>.fail`（先 `.tmp` 再改名，`HmsSpeechBridge.ets:719-739`）。

**为什么用文件队列当桥**（`hostcore/speech-provider/index.js:40-45`）：`speechRecognizer` 是 ArkTS API，Node 进程调不到；而原生层（`dshhost.cc`）只暴露 `startHost`/`isHostRunning`/`stopHost`，**没有消息通道**。项目既有同手法先例且已验证：`host-stop-request`、`host-exit-mode`、`install-queue`。两侧同 UID、同文件系统视图。

三个必须保留的自愈点：

1. **取走即改名（`.req → .wip`）而不是立即删除**（`HmsSpeechBridge.ets:373-381`）：若在读取后、处理前崩溃，`.req` 已删 ⇒ 请求永久丢失且 Host 端只会超时。改名让"处理中"可观察。
2. **陈旧回收必须包含 `.req`**（`HmsSpeechBridge.ets:434-443`）：原实现只清 `.wip/.done/.fail`。若某个 `.req` 内容不完整（不以 `}` 结尾），`takeNextRequest` 会**每轮都返回 `undefined`**，而该 `.req` 既不满足新鲜度检查也不会被删 ⇒ **整个队列被永久堵死**，直到应用重启（用户表现："语音按钮再也不动"）。补上 `.req` 的陈旧回收即可自愈（`STALE_MS = 600000` = **10 分钟**，`HmsSpeechBridge.ets:74`）。
3. **超时必须随音频长度伸缩**（`hostcore/speech-provider/index.js:466-472`）：原实现固定 25 秒，但 ArkTS 侧是**按实时节奏送音频**的（每 640B 睡 20ms ⇒ 送完耗时 ≈ 音频时长本身），而 API 允许的录音最长 120 秒 ⇒ 录 25 秒以上时 Host **必然**先超时。改为 `Math.max(TIMEOUT_MS, audioMs + 15000)`（`hostcore/speech-provider/index.js:479`）。

心跳与日志**必须每次结果都写**（`HmsSpeechBridge.ets:213-222`）：最初只在"收到请求/异常"时写心跳，成功时什么都不写，后果是事后看心跳**无法区分"识别成功"与"请求根本没被处理"**（两者都停在 `alive`）。改用追加模式并按 64KB 轮转（`HmsSpeechBridge.ets:263-285`）。

### 本节的验证命令

```bash
# ① 生成物必须过语法规程（ESM 解析 + 顶层重复声明 + 未定义常量）
node tools/pack-core.mjs --skip-install --place-in-app     # 内含 validateSpeechProviderSyntax
#   为什么必须校验"生成后的字节"：push 的 hms-provider.js 里曾有重复的顶层 const
#   ⇒ 作为 ES Module 是 SyntaxError ⇒ 插件 failed to import ⇒ 点按钮直接跳设置页
#   （tools/pack-core.mjs:648-666）。而 node --check 默认按 CJS 解析，拦不住。

# ② 打完包后，验证到"HAP 内 core zip 内"这一层才算数（docs/70:988-1004）
tar -xf entry/build/default/outputs/default/entry-default-signed.hap -C <x> \
  resources/resfile/dsh-core-<ver>-openharmony-arm64.zip
tar -xf <x>/resources/resfile/dsh-core-<ver>-*.zip -C <y>
ls <y>/dsh-core-<ver>/node_modules/@deepseek-ai/\
dsh-experimental-speech-to-text-sensevoice/{lib/hms-provider.js,speech-models/index.js}
#   两者都必须存在：provider 以 ../speech-models/index.js 引用下载器，
#   不显式拷贝会在运行时 Cannot find module（E-SV12）

# ③ 确认没有内置模型（期望 0 个条目）
tar -tf <hap> | grep -c "rawfile/sensevoice"

# ④ 真机：桥的心跳（它能区分"桥在跑"与"有请求"）
hdc shell "cat /data/app/el2/100/base/com.dshm.dshclient/haps/entry/files/hms-speech-bridge-heartbeat"
#   期望看到：started dir=… → 预热成功 模型已就绪=true → got request id=… → done … text=…
hdc shell "cat /data/app/el2/100/base/…/files/hms-speech-bridge-heartbeat-asr"
#   ASR 逐步日志：开始识别 → 改用 SenseVoice → 结束 finished=true
#   若出现"SenseVoice 不可用，回退 HMS" ⇒ 预热没成功，查模型是否下载完

# ⑤ 真机：采集侧与 provider 侧的音频是否同一份
hdc file recv /data/app/el2/100/base/…/files/native-btn-audio.wav ./a.wav
hdc file recv /data/app/el2/100/base/…/files/dsh/home/speech-to-text/hms-bridge/last-audio.wav ./b.wav
certutil -hashfile a.wav SHA256 ; certutil -hashfile b.wav SHA256   # 期望一致
```

---

## 图标与启动画面

这是**两个不同用途的资源**，混起来做会得到"启动画面被改成带角标的版本"，而用户明确要求启动画面用原版。

| 资源 | 用途 | 内容 | 谁产出 |
|---|---|---|---|
| `AppScope/resources/base/media/{foreground,background}.png` | **APP 图标**（分层图标的两层，系统自己加遮罩）| 官方白鲸 + `HM`/`OS` 角标 | `tools/make-icon.py` |
| `entry/src/main/resources/base/media/{foreground,background}.png` | 同上，**必须与 AppScope 逐字节一致** | 同上 | 同上 |
| `docs/brand/dshm-icon.png` / `dshm-mark.png` | README 展示图 / 透明底纯标记 | 前者白底合成版、后者**无角标** | 同上 |
| `entry/src/main/resources/base/media/startIcon.png` | **启动窗口图标** | **原版** | 归档在 `third_party/brand-original/` |
| `entry/src/main/resources/base/media/logo_dark.png` | **启动页大标识**（透明底黑鲸）| **原版** | 同上 |

`tools/make-icon.py:22-30` 用一整个段落写着「本脚本**不产出**启动画面资源」，并给出反面后果：**否则跑一次就会把启动画面改成带角标的版本**。

### 关键点 1：就地合成导致 `mark` 带角标

`PIL.Image.alpha_composite` 是**就地修改**（该方法无返回值、直接改宿主画布）。原实现这样写：

```python
whale.alpha_composite(blk_r, (px_, py_))   # whale 从此带上 HM/OS
mark = whale.resize((512, 512))            # ← mark 因此也带角标
```

证据（`docs/device-validation.md:4068-4074`，E-RV1）：mark 与 foreground 缩到同尺寸后**逐像素 alpha 差异 0**，右下角墨点 386。而 `docs/brand/README.md:20` 写的是「纯标记、**透明底**、**不含右下角角标**」—— **当时文档与产出物不符**。

**修法**（`tools/make-icon.py:303-306`、`:341`）：合成角标**之前**先 `whale_base = whale.copy()`，`mark` 从 `whale_base` 出图：

```python
whale_base = whale.copy()                                 # make-icon.py:306
whale.alpha_composite(blk_r, (max(0, px_), max(0, py_)))   # :312 就地修改
mark = whale_base.resize((512, 512), Image.LANCZOS)        # :341
```

对应的自检在 `tools/make-icon.py:385-408`，**判据本身被写错过两次，都记在注释里**：

- ❌ "看右下角有没有墨"——那片区域**鲸鱼尾鳍本来就有墨**，无法区分鳍与角标；
- ❌ "把 mark 放大到 1024 与 fg 逐像素比"——mark 走 3072→512→1024 的重采样路径与 fg 不同，会引入**遍地**差异，判据失效；
- ✅ **在 512 尺度上比较 mark 与 fg 在角标框内的不透明像素数**：mark 干净 ⇒ 框内只有鳍 ⇒ 明显少于 fg；mark 带角标 ⇒ 与 fg 基本相等（`:403-408`）。

另一处同类边界：`whale` path 有 **4 个子路径，绕向 CW/CCW 混合**（外轮廓 CW、三个内腔 CCW）⇒ 是"带洞"图形。**逐个子路径 `fill` 会把内腔填黑**（第一版即如此，靠绕向自检发现），所以必须用扫描线 + even-odd 填充（`tools/make-icon.py:32-36`、实现 `:154-179`）。

### 关键点 2：自检必须在写盘前跑完

旧版先落盘再自检：自检失败时坏图**已经写进资源目录** —— 审查实测"强制失败后磁盘上仍留下 6 个 PNG"（`tools/make-icon.py:355-358`）。现在是**全部自检通过才写**（`failures` 累积 → `:415-419` 未过则 `return 1`，一个文件都不动；`:421-426` 才写盘）。

三条自检的**判据设计**（都是"拦不住就没意义"）：

| 自检 | 判据 | 为什么能拦住 |
|---|---|---|
| 内腔未被填黑 | 前景**不透明像素占比**须在 16%~20%（`make-icon.py:375-379`）| 实测正常 even-odd **18.10%**、错成逐子路径 fill **23.46%**。带宽必须**窄于两者之差**才有鉴别力 —— 曾用 15%~25%，坏图 23.46% 落在带内，**根本拦不住**（对抗测试发现）|
| mark 不带角标 | 角标框内 `mark` 墨点须明显少于 `fg`（`make-icon.py:403-408`）| 直接针对"鳍 vs 鳍+角标"的差异；框坐标换算写错过一次（除以 2 得 1536 越界、框内空 ⇒ 判据失效），现为 `512/big` 即除以 6 |
| 启动画面未动 | 与 `third_party/brand-original/` **逐字节比对**，不符即 `exit 1`（`make-icon.py:428-448`）| 旧版只 `print('（未改动）…')`，**不做校验**：把 `startIcon` 加进 `outs` 被覆盖后，照样打印"未改动"（实测文件从 3577B 被改成 59441B 而日志说没改）|

**对抗性验证是可复跑的**（`docs/device-validation.md:4114-4120`）：把 bug 注入脚本副本，确认自检真的 `exit 1` —— 三个注入（mark 从 whale 出图 / even-odd 换成逐子路径 fill / 把 startIcon 加进 outs）全被拦住。

**内腔那条还留下一个方法论教训**：更早的判据是"固定窗口里的透明采样点 > 0"，而采样窗里本就有落在鲸鱼**轮廓外**的点，恒为透明 ⇒ 永远 > 0 ⇒ 注入 bug 后脚本仍 `exit 0`。**"装饰性护栏"比没有护栏更危险**（`docs/device-validation.md:4095-4104`）。

### 语料来源：鲸鱼路径必须逐字节取自官方

`entry/src/main/resources/base/media/fish_logo.svg` 由 `node tools/gen-fish-logo.mjs`（137 行）从核心树的官方 `dsh-client-ui-primitives` 生成，内含两条自检（`tools/gen-fish-logo.mjs:62-117`、`:126-137`）：

1. **"真实紧包围盒 == 官方 viewBox"** —— 把每段 C 曲线**离散成 400 点采样**后取极值。这条断言存在的原因是一个**被推翻的错误结论**：曾用**贝塞尔控制点**的包围盒（控制点可以落在曲线**外面**）得出"墨迹溢出了官方 viewBox（x∈[-0.2229, 23.1738]）"并据此改了视口，而真实紧包围盒 = `x 0.0000 w 23.1600 h 17.0434`，**恰好等于官方 viewBox**（零溢出）。上游几何变了它会 `exit 1` 停下要人确认。
2. **"落盘后路径仍与官方逐字节一致"** —— 手抄曾错 1 位（`12.6435` 应为 `12.643`，3449 字符里错一个控制点轮廓就会变形）。

**为什么从 `Shape` 自绘改成"官方 SVG 资源 + `Image.fillColor`"**（`WebApp.ets:1865-1885`）：真因是 `Shape.viewPort` **没有把路径缩放进组件盒** —— 鲸鱼以"1 用户单位 ≈ 1 物理像素"的自然尺寸画在**左上角**（`uitest dumpLayout` 权威数据：盒 42×31px，墨迹只占左上角 25×18px，左留白 0 / 右留白 18px）。改用 `Image` 后**等比缩放由图片组件负责**（`objectFit`），不再依赖 `Shape.viewPort` 的缩放语义。`fillColor` 对单色 SVG 是**整体重着色**，等价于官方 Web 层的 `fill: currentColor`。

### 本节的验证命令

```bash
# ① 图标资源门禁（4 处一致性，全部是逐字节/sha256 判据）
node tools/check-icon-assets.mjs
#   查三件事：AppScope ↔ entry 的 foreground/background 逐字节相同；
#             startIcon.png / logo_dark.png 与 third_party/brand-original 的 sha256 相同；
#             foreground.png 体积落在 30–120KB（新版"鲸鱼+角标"约 57–60KB，旧纯鲸鱼版 15–18KB）

# ② 重生成图标（会覆盖 APP 图标资源；前置：fish_logo.svg 已存在）
node tools/gen-fish-logo.mjs && python tools/make-icon.py
#   退出码 0 且打印每条自检的实测值；非 0 时"未写任何文件"

# ③ 直接核对启动资源仍是原版（期望两个 sha256 相同）
sha256sum entry/src/main/resources/base/media/{startIcon,logo_dark}.png \
          third_party/brand-original/{startIcon,logo_dark}.png

# ④ 真机：HAP 内的启动资源与 APP 图标
tar -tf <hap> | grep -E "media/(startIcon|logo_dark|foreground|background).png"
```

本机实测读数（2026-09-27）：`check-icon-assets` 5 项全过（两份 foreground/background 一致、两份启动资源与原版一致、`foreground.png` 58.0KB 在带内）；`startIcon.png` 与 `logo_dark.png` 均为 **15,246 字节**、sha256 前 16 位 `5a1a1ac3885f1008`，与 `third_party/brand-original/` 相同 —— 注意这两个文件当前**内容相同**（同一个原版位图被两个资源名各引用一次），不是复制错了。

---

## 设计体系

### 三层落点

| 层 | 文件 | 回答什么 |
|---|---|---|
| 尺度原语 | `appstate/src/main/ets/ui/Tokens.ets`（122 行）| **"有哪些档位"** —— `Sp` / `Radius` / `Border` / `Fs` / `Lh` / `Dur` / `Sz` / `Breakpoint` / `SemanticColor` |
| 语义角色 | `appstate/src/main/ets/ui/HarmonyTheme.ets`（305 行）| **"这个位置该用哪一档"** —— `HarmonyColor` / `HarmonyType` / `HarmonySpacing` / `HarmonyRadius` / `HarmonyBorder` / `HarmonyElevation` / `HarmonyMotion` / `HarmonyTouch` / `HarmonyIconSize` + `WEB_TOKEN_MAP` |
| 原生原语 | `entry/src/main/ets/view/NativePrimitives.ets`（539 行）| **"这个控件长什么样"** —— `NativeChip` / `NativeSectionTitle` / `NativeCard` / `NativeButton` / `NativeActionBar` + `harmonySheetOptions` |

**为什么分三层而不是一层**（`HarmonyTheme.ets:17-20`）：`Tokens.ets` 是尺度原语（"有哪些档位"），`HarmonyTheme.ets` 是语义角色（"这个位置该用哪一档"）；**角色的值引用原语，不另立数字**。而再包一层 `HarmonySpacing`（`INLINE`/`CONTROL_INNER`/`CONTAINER`/`SECTION`/`PAGE`）的原因是 `Sp.M` 只说明"12"，不说明"哪儿该用 12"（`HarmonyTheme.ets:107-112`）。

**颜色一律走系统语义资源，不写色值**（`HarmonyTheme.ets:32-38`）：`$r('sys.color.*')` 让深浅色、品牌色、无障碍对比由系统保证 —— **手工色值在深色模式下必然有一处看不清，而那是真机上才发现的缺陷**。一条硬约束：`$r('sys.color.*')` 的名字**由编译器校验**（注入假名字会 `Unknown resource name` 并 BUILD FAILED），所以本文件里每个系统资源名都是**编译期验证过存在**的（`HarmonyTheme.ets:22-25`）。

**排版角色是"一套"而不是三个独立令牌**（`HarmonyTheme.ets:75-83`）：`TypeRole = { size, lineHeight, weight }` 三者一起才构成"一种文字"。分开写必然出现"标题的字号配了正文的行高"这类**只在真机上才看得出**的错位。`weight` 用数值（400/500/600）而不是 `FontWeight` 枚举，让该文件保持**不依赖 ArkUI 枚举**（HAR 里的纯数据更可测）。

**`WEB_TOKEN_MAP` 是一张可枚举的数据表**（`HarmonyTheme.ets:273-295`，21 条）：把官方 Web 的 `--dsw-*` 语义 token 名映射到本层的视觉令牌，每条带一句 `note` 说明"为什么这样对应"（尤其是非 1:1 的地方）。**为什么做成数据而不是注释**：官方 Web 的主题**会变**；写成可枚举的数据，升级时"改了哪几条"是可核对、可测试的（fixture 会检查每条映射都填齐），写在注释里则一定会随代码漂移。

**`HarmonyMaterial.IMMERSIVE_ENABLED = false` 是一个已决策项，不是待办**（`HarmonyTheme.ets:194-216`）：官方「沉浸光感」材质明确要求 `targetAPIVersion >= 26`，而本仓 `compatibleSdkVersion` 固定 `6.1.1(24)`（`README.md`）。写进代码而不是只写文档的理由：否则半年后总有人问"为什么不用沉浸光感"，或者更糟 —— 有人顺手开一下，写出一个在目标设备上**不生效**的材质。升级路径与要动的三处也写在同处注释里。

### 设计令牌门禁：棘轮，不是一刀切

`tools/check-design-tokens.mjs`（197 行）守的是**四类裸值**（`tools/check-design-tokens.mjs:35-44`）：

| id | 匹配 |
|---|---|
| `fontSize` | `.fontSize(<数字>)` |
| `lineHeight` | `.lineHeight(<数字>)` |
| `borderRadius` | `.borderRadius(<数字>)` |
| `borderWidth` | `.borderWidth(<数字>)` |
| `colorLiteral` | `.backgroundColor/fontColor/borderColor` 的 `'#hex'` / `'rgb()'` / `'rgba()'` / `'hsl()'` / `Color.X`（`Color.Transparent` 除外）|

**为什么用"棘轮"而不是"一刀切禁止"**（`tools/check-design-tokens.mjs:10-15`）：本仓仍有存量裸值，其中**图标尺寸的收敛会改变视觉、必须真机验收**。一刀切会立刻几百处红，而那正是本项目明确警惕的失败模式：**永远红的门禁等于没有门禁**。所以基线 `tools/design-token-baseline.json` 记录"每个文件当前有几处"，门禁只保证**这个数字不再变大**；修掉存量后用 `--update-baseline` 把基线调低（棘轮只往一个方向转）。

**"门禁通过 ≠ 覆盖到了"在本题上也发生过**（`tools/check-design-tokens.mjs:40-43`）：首版只匹配 `'#hex'` 与 `Color.X`，于是 **`'rgba(0,0,0,0.35)'` 这类函数式颜色被漏掉** —— 实测手写浮层里就有一个硬编码遮罩。现已把 `rgb/rgba/hsl/hsla` 一并纳入，并加了对应的自检样例。

**豁免必须写理由**（`tools/check-design-tokens.mjs:16-17`、`:46`）：行尾写 `// token-exempt: 理由` 即不计入，但**必须写理由** —— 豁免本身也是一种设计决定，不该匿名。WebApp 里的用例是"品牌启动页底色"/"顶栏底色跟随外观"这类**像素级复刻官方桌面版**的值（`WebApp.ets:2145`、`:1967`）。

**扫描范围是 `entry/src/main/ets` + `appstate/src/main/ets`**（`tools/check-design-tokens.mjs:32`）—— 即"会渲染出界面的两个模块"；`platform` 与 `hostruntime` 不含（它们不出 UI 元素）。

### 三形态（三档）与断点

`appstate/src/main/ets/ui/Breakpoints.ets:11-29`：

| 档位 | 判据 | 典型设备 |
|---|---|---|
| `SINGLE` | widthVp < **600**（`Breakpoint.MD`）| 手机 / 折叠屏折叠态 |
| `DOUBLE` | 600 ≤ widthVp < **840**（`Breakpoint.LG`）| 折叠屏展开态 / 平板竖屏 |
| `TRIPLE` | widthVp ≥ 840 | 折叠屏悬停 / 平板横屏 / 2in1 |

**只用窗口宽度判定顶层形态**（`Breakpoints.ets:4-6`，D3 §2.2 硬规则）；**组件级自适应由组件自己按容器尺寸处理**（如 `onAreaChange`），不读窗口宽度。

**已实测的边界事实**：手机横屏（800vp 宽）**会落成 DOUBLE** —— 这是"按宽度判定"的直接后果，**不是 bug**；要不要为手机横屏加一条高度/方向子句需真机看效果后定（`tools/check-layout-fixtures.mjs:253-262` 的 fixture，`note` 里标注为"待决"）。`Breakpoint` 的数值唯一来源是 `Tokens.ets:103-108`，`breakpointThresholds()`（`LayoutController.ets:279-281`）把它暴露给 UI 与 fixture，避免各处重写 600/840。

**轨道呈现与断点是两件事**（`appstate/src/main/ets/ui/ShellTracks.ets:38-57`）：

| 档位 | sidebar | main | rightbar |
|---|---|---|---|
| SINGLE | `OVERLAY` | `COLUMN` | `OVERLAY` |
| DOUBLE | `RAIL` | `COLUMN` | `OVERLAY` |
| TRIPLE | `PANEL` | `COLUMN` | `COLUMN` |

**为什么单独一个文件**（`ShellTracks.ets:1-13`）：它回答的是几何/呈现问题，**不是**导航问题 —— 导航状态关心"选中了哪个面板"，这里关心"这条轨道摆在哪"。分开之后 `NavigationState` 不必依赖 `LayoutMode`，两个模型各自都能在最扁平的编译环境里被测。**要紧的一条语义**：这里**只**回答"轨道怎么摆"，**绝不**回答"这个形态要显示哪些栏目"—— 后者若随设备变，四形态就成了四套 UI，而官方 `ui-layout` 是同一套 AppFrame + 面板选择跨设备。

**用户偏好叠在形态默认之上**（`ShellTracks.ets:59-126`）：`sidebarPresentationOf(mode, expanded)`（单栏一律浮层：那个档位没有"展开的侧栏"，按钮也不给）、`sidebarExpandedForMode(mode, stored)`（"没存过"必须按形态给默认）、`sidebarTrackWidthOf(mode, stored)`（panel 240 / rail 56 / 浮层 0）。**为什么要有"没存过"这一档**：侧栏默认展开，而"偏好里没有记录"若直接读成 `false`，就会把"从没设置过"变成"收起"，用户第一次启动只看到一条 rail（`README.md` 记录了这条三态问题的处置）。

`LayoutController.ets`（281 行）承担形态 → 几何决策：`decideLayout`（`:239`）/ `decideLayoutWithDetail`（`:248`）/ `concedeDetail`（`:207`，让步链）/ `detailPresentationOf`（`:103`，三值枚举：三栏真右栏 / 双栏侧边浅层面板 / 单栏整页下钻）。**"详情栏呈现"为什么是三值枚举而不是一个布尔**：此前是一个 `detailOverlay: boolean`，语义只覆盖了"单栏下详情不是并排的栏"，**而且没有任何消费点**；于是一个布尔表达不了三种呈现（`LayoutController.ets:83-86`）。

### ArkUI 与 Web 的语义差异（改界面前必读）

`docs/70-鸿蒙移植踩坑与修复总览.md:604-613` 有一张表，这里列其中对本项目实际造成过损失的几条：

| 差异 | 后果 / 修法 |
|---|---|
| **SVG 默认裁剪溢出 `viewBox` 的墨迹，ArkUI `Shape` 不裁** | 换素材时视觉会变 |
| **`Shape.viewPort` 不做缩放** | 鲸鱼"歪"的真因（`docs/70:615-639`，E380）|
| **`@Builder` 可以多根，`build()` 只能一个根** | `@Builder` → 组件搬迁时多根必须先包容器；这一条**踩了六次** |
| **`@Builder` 调用返回 `void`** | 不能链属性修饰 ⇒ `margin`/`height` 要放外层容器（`WebApp.ets:1944-1946`）|
| **`@Builder` 里的 `this.x()` 就是再调一遍自己** | Builder **没有"上层"这个**概念 —— 兜底分支写成自递归会让冷启后点一下就被系统杀进程（`RangeError: Stack overflow!`）。已加门禁 `tools/check-builder-recursion.mjs`，并**对修前的提交归真命中** `MainShell.ets:380`（E343）|
| **`$r` 只能字面量** | 模型持不了 `Resource` ⇒ 图标/文案映射必须留在 `view/` 层（`Breakpoints.ets:58-63` 与 `:84-87` 就是两处"按 id 映射资源"的编译期函数）|
| **ArkWeb 的 `getOrigin()` 带结尾斜杠** | 见上文语音一节的回环判定 bug |

**响应式：读到非 `@State` 的字段 ⇒ 改它不触发重渲染**（E379，`WebApp.ets:725-735`）：现象是"状态栏变了、鲸鱼不变"。根因是 `fishMarkColor()` 读的是普通 `private` 字段（非响应式），而顶栏底色 `topBarBg` 是 `@State` 所以跟着变 —— "两个值一个响应式、一个不是"的典型症状。修法是引入 `@State themeMode`，与 `systemBarApplied`（幂等闸门，用于"设置失败可重试"）**分成两个字段**。

**浮层用系统形态、遮罩交给系统**（`README.md`）：半模态一律 `bindSheet`（参数统一由 `harmonySheetOptions` 给），不再手写"整屏 Column + 自制遮罩"。`bindSheet` 是**组件属性**、同一节点只能绑一个 ⇒ 本项目用**单一浮层宿主**：全应用只在根节点挂一次 `bindSheet`，由 `sheetKind()`（**从既有状态派生**，不另立字段）决定显示哪个浮层、`closeSheet()` 一处复位。且**门户必须挂在页面根而不是单栏根节点** —— 那会导致双栏/三栏下浮层够不着（E292，`docs/70:685-691`）。同理**图标只用系统符号**（`SymbolGlyph` 只支持系统预置资源，不引入 Web SVG）—— 这条是 API 约束，不是偏好。

### 本节的验证命令

```bash
# ① 令牌棘轮（期望：当前处数 ≤ 基线处数）
node tools/check-design-tokens.mjs
node tools/check-design-tokens.mjs --list            # 列出每一处裸值及其位置
node tools/check-design-tokens.mjs --self-test       # 13 个样例全 ok（证明判定器会失败）
#   退出码 3 = 基线文件缺失 ⇒ 环境受阻，不是通过

# ② 布局/形态/摆位与纯逻辑（本机直接跑，无需设备）
node tools/check-layout-fixtures.mjs
node tools/check-layout-fixtures.mjs --self-test
#   覆盖四形态 fixture（PHONE 竖/横、TABLET 竖/横、DESKTOP 2in1）、断点边界、
#   让步链、令牌档位、以及语音纯逻辑（重采样/切片/合并/静音）

# ③ @Builder 自递归（真机崩溃 E343 的门禁）
node tools/check-builder-recursion.mjs

# ④ 死按钮/无反应的空实现（逐条判断用途，不追求归零）
node tools/check-dead-handlers.mjs

# ⑤ 改了 hostcore/** 之后必须带回入口脚本，否则设备跑的还是旧脚本
node tools/place-host-app.mjs && node tools/assert-resfile-sync.mjs
```

本机实测读数（2026-09-27）：`check-design-tokens` 当前 **21 处裸值 / 8 个文件**，基线同为 21 处 / 8 个文件（`tools/design-token-baseline.json` 的 `total: 21`），通过；`--self-test` 13/13。注意 `docs/parity-matrix.md:105` 记录的旧读数是"58 处 / 11 文件"—— 同样**引用时必须以当场实跑为准**。

---

## 已知缺口与本轮成稿时发现的问题（如实登记）

| 项 | 事实 | 证据 / 复现 | 建议处置 |
|---|---|---|---|
| **`arch-check` 的 `SCAN_ROOTS` 不含 `hostruntime/src`** | 扫描根只有 `connection/src`、`appstate/src`、`platform/src`、`entry/src/main/ets`；脚本注释只解释了 `hostkit` 的排除理由 | `tools/arch-check.mjs:46-51`、`:36-45` | 要么把 `hostruntime/src` 加入扫描根，要么在注释里写明它的合规依据（**现状是"没扫也没说明"**）|
| **`check-dead-code` 规则①（零使用 import）的实际有效性存疑** | `stripCommentsAndStrings` 消费块注释时**不补回换行** ⇒ 剥注释后的行号与原文整体偏移；而规则的"排除导入行"用的是**原文行号**、计数用的是**剥离后文本**。两者错位后，被排除的行不是真正的导入行，于是**导入标识符被自己计成了一次使用** | 机制在 `tools/check-dead-code.mjs:59-91`（块注释分支不 `out += '\n'`）与 `:284-294`；实测：对 `entry/src/main/ets/pages/WebApp.ets` 做 A/B ——**原样 0 处违规，去掉头部块注释后立刻报出 10 处**（`HMS_CHUNK_BYTES`/`makeTonePcm16`/`slicePcmChunks`/`resamplePcm16`/`pcmDurationMs`/`mergeTranscript`/`isNearSilence`/`speechRecognizer`/`textToSpeech`/`copyText`）。另对 4 个文件确认头部块注释净换行数 > 0（WebApp 28 / Index 18 / HmsSpeechBridge 35 / SpeechPcm 12）| 修法二选一：剥离时**保留换行**（块注释分支按 `\n` 计数补回），或把"排除导入行"改成**按文本匹配**而非行号。**修完必须先在已知坏版本上红过一次**（`docs/README.md:62` 纪律 6）|
| 同上，`WebApp.ets` 里确实存在**零使用符号** | `INSERT_TEXT_JS`（`WebApp.ets:156`）、`applyThemeFromProbe`（`:1413`）、`lastMicProbe`（`:1031`）、`hmsEngineInfo`（`:1037`）、`hmsTranscript`（`:1038`）、`hmsE2eTranscript`（`:1041`）、`hmsE2eDetail`（`:1042`）全仓各仅 1 次出现（= 声明本身）。`probeTimerId`（`:741`）只在 `aboutToDisappear` 里被清（`:1053-1055`），**没有任何地方给它赋过值** ⇒ 那个"10s DOM 探针"已不存在，字段是残留。`PROBE_INTERVAL_MS`（`:303`）仅出现在注释里。**连带影响**：`applyTopBarTheme`（`:1510`）的唯一调用点在 `:1438`（= `applyThemeFromProbe` 体内）⇒ 它同样不可达 | 调用图核对：`Select-String -Path entry\src\main\ets\pages\WebApp.ets -Pattern 'applyThemeFromProbe\|applyTopBarTheme\|applySystemBarTheme'`（`applyThemeFromProbe` 只命中声明行 `:1413`；`applyTopBarTheme` 命中 `:1438` 与声明 `:1510`；`applySystemBarTheme` 命中 `:747`（桥回调）/`:1515`（探针路径内）与声明 `:1460`）；`node tools/check-dead-code.mjs` 当前**报绿**（`扫描 99 个文件 · 判定声明 2237 处` → "无死代码"）| 逐条判断：`INSERT_TEXT_JS` / `applyThemeFromProbe` 与已删除的探针/自检菜单配套，删除前先确认没有"非本文件"的调用点；字段类残留可直接删。**注意"探针没了"这条的连带后果**：外观跟随现在**只**靠 `THEME_SHIM_JS` 桥这一条路径，而 `WebApp.ets:1504-1509` 的注释仍按"桥 + 探针兜底两条路径"描述（"探针每 10s 一轮，保证桥万一没装上也能最终收敛"）—— **该注释已与实现不符，需同步更正**。这属于 `docs/70` §8.2「静默失效」：注释让人以为还有兜底，实际没有 |
| `hostcore/speech-provider/index.js` 的注释与代码互相矛盾 | 文件头注释（`:18-25`）说"**刻意不提供 preparation**"，而代码 `:186` 是 `preparation: prep` 且 `createPreparation` 是实际实现 | `grep -n "preparation" hostcore/speech-provider/index.js` | 注释描述的是"模型随包内置"时代的形态；应改写成"模型在线下载后**必须**提供 preparation"，否则下一个读注释的人会把它删掉 |
| 宿主**彻底起不来**时无启动超时兜底 | `fail()` 只挂在 Web 回调上；`retry()` 在 `launchUrl` 为空时会排重试，`adoptLocalHost` 成功后会经 `@Watch` 触发加载 —— 但宿主**完全起不来**时没有任何超时判据 | `docs/device-validation.md:4136`（独立审查结论，经核实后**有意未改**）| 既有设计依赖宿主自行报错；加超时兜底会改变既有语义，属独立决策 |
| 本节涉及的真机读数全部来自 `docs/device-validation.md` 已有批次 | 本稿未新跑任何真机验证（无设备通道）| 批次二十五/二十六/二十七/三十/三十一，见 `docs/device-validation.md:3074/3167/3407/3921/4060` | 任何"启动页/语音"改动落地后，必须按 `AGENTS.md` 的回归纪律重跑基线并对照，且**只允许 `hdc install -r`**（`docs/80-真机更新与数据保全.md:40-56`）|

---

# 第五章 真机验收、运维与踩坑总表

## 0. 本章在讲什么

本章覆盖三件互相咬合的事：

1. **把改动安全地送到真机上**——项目里唯一允许的装机路径，以及它为什么必须如此严格；
2. **送上去之后怎么判定"这次改动真的生效了"**——门禁清单、基线纪律、诊断手段；
3. **踩过的坑**——按技术主题重排，每条写清"现象 / 根因 / 修法 / 怎么验证"，并指向 `docs/70` 中已有的详述。

本章**不是**详述文档。`docs/70-鸿蒙移植踩坑与修复总览.md`（D8）已经把每个坑讲透；本章的价值在于
**四段式压缩 + 交叉索引 + 门禁与诊断的可操作口径**，使接手的人能快速判断"我能不能改这里"。

> **阅读顺序建议**：先读完本章 §1（数据保全），再看 §3（诊断手段），最后按 §4 的主题表检索具体坑。
> §1 和 §2 是纪律，§3 是工具，§4 是索引。

---

## 1. 真机数据保全（最高优先级）

### 1.1 一次真实事故：2026-09-25，不可恢复的数据丢失

**发生了什么**：为"清理环境准备重装"，执行了裸卸载（`AGENTS.md`、`docs/80-真机更新与数据保全.md:14`）：

```powershell
hdc uninstall com.dshm.dshclient     # ← 裸卸载，默认连数据一起删
```

**损失（真机实测读数，`docs/80-真机更新与数据保全.md:17-26`）**：

| 内容 | 结果 |
|---|---|
| 历史会话 | **6/6 全丢** |
| 已装插件 | **丢 7/8**（仅剩"智能体团队"） |
| 工作区 | **丢 2/3**（`test`、`data` 没了） |
| `.backup` 系统备份 | **空** |
| `preferences` | **空** |

**且不可逆**：没有备份可回滚。这事后经五条通道逐一证伪"有备份可退"——`hdc shell ls home` 被拒
（`drwx------`，属主是应用 uid）、`hdc smode` 报 `Cannot set root run mode in undebuggable version`、
设备上不存在 `run-as`、`hdc file recv` 拉 `home/sessions` 报 `permission denied`、
宿主 HTTP API 能认证但没有导出文件的方法（`docs/device-validation.md:2202-2212`）。

**第二层错误更危险**：事故之后，该操作在汇报里被写成了正常步骤——
"清理 | 卸载旧应用（**连数据一起清**）、清设备临时文件、删 build/.cxx/.hvigor …"
⇒ **等于把破坏性操作固化进了流程**，下一个人照做会再丢一次
（`docs/80-真机更新与数据保全.md:29-36`）。

**根因（三条，与"不知道 `-r`"无关）**：把卸载当成清理的常规动作；执行不可逆操作前没有向用户确认；
事后没有把它标记为事故（`docs/80-真机更新与数据保全.md:39-44`）。

### 1.2 绝对禁止的命令清单

除非用户**明确说**"全部清掉"，以下命令一律禁止（`AGENTS.md`、`docs/80:73-77`）：

```powershell
hdc uninstall com.dshm.dshclient                    # ✗ 禁止：默认连数据一起删
hdc shell bm uninstall -n com.dshm.dshclient        # ✗ 禁止
hdc shell bm uninstall -n <name>                    # ✗ 禁止（任何 bundle 都不行）
hdc shell "rm -rf /data/app/el2/100/base/com.dshm.dshclient/*"   # ✗ 禁止
hdc shell "rm -rf .../haps/entry/files/dsh/home"                 # ✗ 禁止
```

`AGENTS.md` 那条要特别留意：**删 `files/dsh/home` 与卸载等价**——那下面就是会话、插件行与配置。

### 1.3 判断依据：这条命令会不会碰 el2

这条判据记住就不会犯错（`AGENTS.md`、`docs/80:56-67`）：

| 路径 | 内容 | 覆盖安装（`install -r`）后 |
|---|---|---|
| `/data/app/el1/bundle/public/<bundle>/` | 代码 + 资源 | **被替换**——这正是要更新的部分 |
| `/data/app/el2/100/base/<bundle>/haps/entry/files/dsh/home/` | **会话 + 插件 + 配置** | **保留** |
| `.../files/dsh/cores/` | 核心树 | 保留（新版本解到新目录，**旧目录不删**） |
| `.../files/toolchain/` | python / git | 保留 |
| `.../files/workspace/` | 工作区 | 保留 |
| `.../files/bin/` | busybox + wrapper | 保留 |

> **一句话口径**：`el1` = 代码（可换），`el2` = 用户数据（**任何删除都不可逆**）。

核心树的分离布局是结构性的保护：核心按版本解到 `cores/<ver>/`，旧版本目录不删可回退；
插件在 `home/` 下，与核心版本目录**相互独立** ⇒ 核心升级本身不会动插件
（`docs/80:145-146`）。

### 1.4 正确做法：一律覆盖安装

```powershell
hdc install -r <hap 路径>
```

`-r` = replace。同签名覆盖安装只替换 el1 的代码与资源，不动 el2 的用户数据（`AGENTS.md`）。

**兼容性边界**（"保留会话与插件"的前提是插件与核心版本不冲突，`docs/80:137-143`）：

| 情形 | 可否直接覆盖安装 |
|---|---|
| 核心不变，只改 ArkTS / 宿主 | ✅ 可以 |
| 核心小版本升级（rc.2 → rc.3），插件只用公开 API | ✅ 可以（装后跑一遍插件面板） |
| 核心大版本升级，插件用了变更的 API | ⚠ 需评估插件能否加载 |
| 插件声明了核心版本约束 | ⚠ 先看插件 `peerDependencies` |

### 1.5 唯一允许的装机入口：`tools/update-device.ps1`

**用法**（`tools/update-device.ps1:14-18`）：

```powershell
.\tools\update-device.ps1                 # 完整：构建 + 覆盖安装 + 验证
.\tools\update-device.ps1 -SkipRebuild    # 只装现有产物
.\tools\update-device.ps1 -Hap <路径>     # 指定 HAP
```

**它把规则做成了代码约束**（`tools/update-device.ps1:1-18,46-70,82-90,123-133,144-191`）：

| 步 | 做什么 | 守什么 |
|---|---|---|
| 0 | **自检脚本自身**不含卸载调用 | 防止以后有人把脚本改坏（`48-70`）|
| 1 | 检查设备连接 | 无设备时不建垃圾 |
| 2 | 记录装前 `home` 条目数基线 | 为第 7 步的比对提供基准（`84-90`）|
| 3 | 构建（可 `-SkipRebuild` 跳过）| 保证装的是刚构建的产物 |
| 4 | 定位 HAP | — |
| 5 | **只用 `hdc install -r`** | 全程无 `uninstall`（`123-133`）|
| 6 | `aa force-stop` + `aa start` 冷启动 | — |
| 7 | **装前/装后 `home` 条目数比对**，减少即 FAIL | 数据保全的关键一步（`144-174`）|
| 8 | exec 七项 + HTTP 就绪 | 端侧是否真的可用（`175-191`）|

第 0 步的自检实现本身有讲究（`tools/update-device.ps1:46-64`）：**不做全文文本扫描**，
而是只匹配"真正的命令调用形态"（`[&$] hdc … uninstall`、`bm … uninstall`、`rm -rf`）。
原因写在注释里：前两版全文扫描都会误报——v1 被自己的注释命中、v2 去掉 `#` 开头行后仍误报，
因为块注释 `<# … #>` 内容不以 `#` 开头，且 `Write-Host` 的提示文字**必须**提到这些命令名
（否则没法向人解释禁止原因）。**纯文本扫描分不清"提到"与"执行"**。

**第 7 步有一个必须知道的盲点**（`tools/update-device.ps1:153-167`、`docs/80:113-115`）：
如果装前 `home` 条目数就是 0，前后都是 0 ⇒ **检查发现不了丢失**，脚本会打印
`SKIP home 基线为 0 —— 本次无法证明「数据被保留」`，并在收尾打印"本次**未能验证**"而不是"OK"。
第一版在这里直接判 OK，是**假通过**；改成 SKIP 是修掉了它。
⇒ 文档记录过这台设备当时 `home` 为空（`docs/80:113-115`："就像现在这台设备"），
所以脚本在那台机器上无法证明"数据被保留"。
真机读数（曾有过数据的那次装机）用另一条通道取证：
装后应用**加载了已存在的会话**（`/sidebar/ws/agent-opens?sessionId=session-9734-…`），
`home` 目录 link 数装前装后一致（`docs/device-validation.md:2232-2242`）。

### 1.6 唯一例外（且必须先问用户）

| 情形 | 允许 | 必须 |
|---|---|---|
| 用户明确说"全部清掉"/"重新装" | 可卸载 | **先复述确认** |
| 换签名（调试证书 → 发布证书）导致覆盖安装失败 | `hdc uninstall -k <bundle>` | 卸载**立即验证数据仍在**，不可假定 `-k` 生效 |

（`AGENTS.md`、`docs/80:79-87`）

两点必须说清：

- `-k`（`--keep-data`）**确实存在**（`hdc uninstall -h` 可见，`docs/80:86`），
  但**未在真机上验证过** ⇒ 不能假定它一定保留成功（`docs/80:86-87`）。**本章未复验**这一点。
- 即使落在例外里，也要**先问用户**，不自行决定（`AGENTS.md`）。
  `update-device.ps1` 在安装失败时也是这么做的——它打印"若报签名冲突：先问用户，不要自行卸载"
  （`tools/update-device.ps1:129-131`）。

**历史上成功绕开这个例外的做法**（值得记住，但要看约束是否仍成立）：
当需要换签名而用户数据又无备份通道时，**改 `bundleName` 到独立名字**（曾用 `com.dshm.micverify`）
⇒ 新 bundle 名没有旧签名要匹配，签名可以随便换，现有 `com.dshm.dshclient` 的数据**零风险**
（`docs/device-validation.md:2214-2221`）。
⚠ 注意 **`bundleName` 与签名材料是绑定的**：签名 profile（`.p7b`）内部绑定了一个具体
bundle-name，改 `bundleName` 会让构建在 `SignHap` 报 `00303074`
（"The bundleName in app.json5/hvigorfile.ts does not match the generated SigningConfigs"），
**必须回到 DevEco GUI 用目标 bundleName 重新走一次自动签名**——
所以"临时改 bundle 验证、验完改回"这个计划里的**改回这一步是有外部依赖的**
（`docs/70-鸿蒙移植踩坑与修复总览.md:1047-1078`）。

### 1.7 装完之后的三步验收

```powershell
# 1) 数据是否保留（会话 / 插件 / 工作区）——按功能逐项跑
python tools\func_test_final.py

# 2) 端侧是否就绪（exec 七项）
hdc shell "grep -E 'exec 探测：' /data/app/el2/100/base/com.dshm.dshclient/haps/entry/files/dshm-host.log | tail -1"
#  期望：python3.12=ok，git=ok，git-core/git=ok，git-remote-http=ok，rg=ok，bash=ok，git-ls-remote=ok

# 3) 本次改动是否真生效 —— 按功能做一次端到端（日志判不出来的项必须看界面）
```

（`docs/80:121-130`）

> **为什么第 3 步不能省**：本项目反复出现"门禁全绿但某个工具静默坏掉"的形态。
> 例如 `web_fetch` 一度打不开任何网页、`web_search` 却正常——同一条核心树、
> 同一个本地 HTTP 服务，只有 `--jitless` 一个变量不同
> （`README.md`、`docs/70:24-30`）。

### 1.8 数据保全的"反例识别"能力

排障时最容易把"读不到"当成"不存在"。已知的三条观测边界（`docs/70:278-285`）：

| 路径 | hdc shell 视角 |
|---|---|
| `files/`（含 `files/bin/`、`dshm-host.log`、`node-output.log`）| **可读** |
| `.../files/dsh/home` | **不可读**（`700`）⇒ `host-ready.json`（含 token）取不到 |
| `.../files/toolchain/` | **不可读** |
| `cacheDir` | **不可读**（`Permission denied`）|

推论有两条，都很硬（`docs/70:284-285`、`docs/device-validation.md:2244-2253`）：

1. **凡需要跨 uid 观测的东西，都必须由宿主自己写到 `files/` 下**——诊断通道的设计就是被这条逼出来的（见 §3）。
2. **`ls home | wc -l` 在权限受限的真机上恒为 0** ⇒ 装前/装后比对会退化成 `0 → 0` 的**假通过**。
   要另找**世界可读**的旁证（`dshm-host.log` / `node-output.log` 都是 `-rw-rw-rw-`，
   含 sessionId、`应用用户插件行`、`BOOT_30_PROFILE_READY`）。

### 1.9 本节验证方式

```powershell
# A. 脚本自身不含卸载调用（脚本第 0 步做的就是这件事，也可手工核）
node -e "const s=require('fs').readFileSync('tools/update-device.ps1','utf8');console.log(/rm\s+-rf/.test(s)?'有 rm -rf 形态':'无 rm -rf 形态')"

# B. 装机只用 -r（检查脚本第 5 步）
grep -n "install" tools/update-device.ps1

# C. 真机边界：确认哪些目录 hdc 读不到（对照 §1.8 的表）
hdc shell "ls /data/app/el2/100/base/com.dshm.dshclient/haps/entry/files | head"
hdc shell "ls /data/app/el2/100/base/com.dshm.dshclient/haps/entry/files/dsh/home"   # 期望 Permission denied

# D. 装机后：exec 七项
.\tools\device-acceptance.ps1            # 见 §2.4，它会自动判定 5 项并逐个点开设置分区
```

---

## 2. 验收流程

### 2.1 AGENTS.md 规定的必跑门禁（逐个说明它在守什么）

**清单的权威位置是 `AGENTS.md` 的「必跑的回归门禁」块**（本节只转抄并逐条解释；
2026-10-05 更新为 15 条 node + `device-acceptance.ps1`）：

```powershell
node tools/assert-cli-shim.mjs
node tools/assert-resfile-sync.mjs
node tools/check-parity.mjs
node tools/compat-drift.mjs
node tools/assert-exec-fix.mjs
node tools/assert-python-bridge.mjs
node tools/assert-fs-search-fallback.mjs
node tools/check-web-fetch-jitless.mjs   # jitless 下 web_fetch 真能抓网页（带对照臂）
node tools/check-worker-jitless.mjs      # worker 线程也要拿到 jitless 补齐（带对照臂）
node tools/check-internal-undici.mjs     # Node 内部 require 的内建 undici 必须被纯 JS 垫片接管（带对照臂）
node tools/check-skill-sync.cjs          # 内置技能同步（判据是内容 sha256，不是字节数）
node tools/check-ptc-ts-strip.mjs        # PTC 的纯 JS erasable-TS 擦除器（81 条 + wasm 陷阱 + 变异自检）
node tools/check-ptc-runtime-inproc.mjs  # PTC 同进程运行时契约（在 --jitless 的临时舞台里跑真 run）
node tools/check-ptc-wiring.mjs          # PTC"换实现"接线：profile ↔ pack-core ↔ 核心树 三处一致
.\tools\device-acceptance.ps1        # 真机端侧验收
```

| 门禁 | 守什么 | 本次实跑 |
|---|---|---|
| `assert-cli-shim.mjs` | `pnpm`/`npm`/`npx`/`dsh` 四个 CLI 假壳：队列路径**生成期写死**（不再运行时读 `$DSH_HOME`）、`--dir` 取值与跳过口径、不写死总数而逐壳断言 | `exit 0`，**40 项断言全过** |
| `assert-resfile-sync.mjs` | `hostcore/app/**` 与 `entry/src/main/resources/resfile/resources/app/**` **逐字节一致**（快照漂移是静默的：改了源码忘了 `place-host-app`，构建照打旧文件）| `exit 0`，**13 件快照全部同步**（2026-10-05 复核；此前写"10 件"是 main.js 那次漂移修复前的数） |
| `check-parity.mjs` | `docs/parity-matrix.md` 不能注水、不能悄悄漂移（覆盖 39 个官方能力面 / token 合法 / 不许整体 DONE 盖住某形态缺口 / 非 DONE 必须有缺口登记 / 统计与实算逐项相等）| `exit 0`，§6 缺口登记 36 个 id |
| `compat-drift.mjs` | 上游漂移：对当前 checkout 的上游重新提取端点表，与仓库里已提交的 `dshcompat/.../Endpoints.ets` 逐条比对 | `exit 0`，**期望 140 / 基线 140，无漂移**（2026-10-05 复核；138 是 `0.2.0-rc.2` 时代的数） |
| `assert-exec-fix.mjs` | exec 探测链（`probeExec` / `ensureExecutables` / rg wrapper）的结构与**语义锁**：`denied` 只映射 `EACCES`、`so-fail` 正则覆盖 musl+glibc、Phase 5 已拆除的实验代码**不得复存** | `exit 0`，**35 项断言全过** |
| `assert-python-bridge.mjs` | 内嵌 Python 桥（`python_runner.cpp` + el1 `libpython` + `main.js` 自检）的结构锁，含 `pipMode` 不再生成 `-V\|--version` 分支 | `exit 0`，**69 项断言全过** |
| `assert-fs-search-fallback.mjs` | fs-search 降级 patch（rg 被拒时切 `find`/`grep`）的**三层防线**：结构（五个注入函数、两段替换、旧段已消失）、语法（`vm.SourceTextModule` 全文解析）、行为（从注入块提纯函数跑参数转换与 NDJSON 转换） | `exit 0`，**39 通过 / 0 失败** |
| `device-acceptance.ps1` | 真机端侧验收：装机 + **冷启动** + 抓日志/布局/截图 + 生成 `dist/acceptance/<ts>/report.md`，**自动判定 5 项**（设备在线 / 核心已启动并读出运行核心版本 / 客户端已接入 / 平台标识=ohos / 本次启动后无异常退出），另逐个点开设置九个分区并记 `nav.md` | 需真机；用法与首跑踩到的坑见 §2.4 |

> **为什么表里只解释这些条**：这张表逐条解释的是**最早那 7 条**——它们覆盖最容易被静默破坏的接线点
> （假壳、快照、台账、上游契约、exec 链、Python 桥、fs-search）。后续新增的必跑项
> （`check-web-fetch-jitless` / `check-worker-jitless` / `check-internal-undici` / `check-skill-sync` /
> 3 条 PTC 门禁）只在上面的清单里列出、**未逐条解释**（每个文件头都有"为什么存在"一节）。
> **权威清单与条数始终是 `AGENTS.md` 的「必跑的回归门禁」块**；"按改动面选跑"的分组见本章 §2.2，
> 更完整的历史清单见 `docs/50-端侧核心运行架构.md` §15.1（该文件在演化，行号未固定）。

### 2.2 门禁以外的"结构性守卫"

后续批次新增的门禁同样属于回归纪律的一部分，按引入顺序列出（各自守什么一并说明）：

| 门禁 | 守卫 | 来源批次 |
|---|---|---|
| `check-store-readiness.mjs` | 上架红线：不申请 `ohos.permission.kernel.*`（尤其 `ALLOW_WRITABLE_CODE_MEMORY`）、包名/权限等级/设备类型/jitless | 早期 |
| `check-native-closure.mjs` | 原生依赖闭包：SONAME 必须等于文件名、每个 `DT_NEEDED` 必须解析到同一 HAP 内的库或已登记的系统库 | 上一轮补 `librawfile.z.so` 白名单（`E-SV17`）|
| `check-origin-fence.mjs` | WS 升级的 `Origin` 围栏（clean/absent/duplicated → 101；foreign → 403；no-cookie → 401）| 早期 |
| `check-plugin-toggle.mjs` | 插件启停：写 `$DSH_HOME/cordis.patch.yml` 后行状态真的翻转（186 条目 → `ui-deliverables enabled=false`）| 早期 |
| `check-feature-wiring.mjs` | **功能接线回归**：对已实现功能检查"中枢实现 + **界面调用点**"是否都在。构建查不出"调用点被删" | 早期 |
| `check-builder-recursion.mjs` | `@Builder` 体里不许出现自己的名字（自递归在真机上是 `Stack overflow` 直接杀进程）| `E343` |
| `check-dead-code.mjs` | 零使用 import / `@Builder` / 组件成员 / 门面字段 | `E-DC1`、`E-DC2` |
| `check-dead-handlers.mjs` | 空实现扫描：只报"**调用处**内联空实现"，不报回调 prop 的声明默认值 | `E-DH1` |
| `check-design-tokens.mjs` | 设计令牌**棘轮**：裸 `fontSize`/圆角/描边/颜色字面量只许变少 | 早期 |
| `check-icon-assets.mjs` | 图标资源：`AppScope`↔`entry` 逐字节一致、启动资源与原版一致、APP 图标体积在预期带 | `E-RV1` 同批 |
| `check-toolchain-sign.mjs` | 工具链自签名：标记存在 + 是"前缀+摘要"形态 + 摘要与归档实际大小自洽 | `E-TS1`、`E-TS2` |
| `check-web-fetch-jitless.mjs` | `web_fetch` 在端侧 jitless 下真能抓网页（**自带双臂对照**：无钩子必须失败且必须给出 WASM 因果证据，有钩子必须全过，跨源跳转仍须被拒）| 早期 |
| `assert-report9-fixes.mjs` | 报告 9 的四项修复：原生 `Headers` 当输入、中文 body 长度按**字节**算、设置写入后 patch 保留非种子条目 | 早期 |
| `assert-speech-syntax.mjs` | 语音 provider 按 **ESM** 解析（`node --check` 默认 CJS，顶层重复 `const` 不报）：顶层重复声明 / 引用常量有定义 / 括号配平 / 必需导出 | `E-SV` 同批 |
| `check-user-rows-preflight.cjs` | 用户插件行预检 + 启动失败自愈（坏行不拼、失败后隔离用户行，**不删数据**）| 早期 |
| `arch-check.mjs` | 上游端点/事件名字面量不得泄漏出 `dshcompat` | 早期 |

### 2.3 本次全量实跑读数（用于判断"哪些红是环境问题、哪些是真回归"）

2026-09-27 在本机（Windows / Node **v24.19.0**）逐条跑全量清单，结果如下。
**"没跑成"与"通过"必须分开记**——这是本项目的既有约定（退出码 3 = 环境受阻，不算通过）。

> **2026-09-28 重测（收尾批）**：同机同 Node，跑 23 条核心门禁得 **`20×0 / 1×3 / 2×1`**
> （旧记的 `23×0 / 2×3 / 7×1` 已过期——其中 `check-arkts-entry.mjs`、`check-fetch-shim.cjs`、
> `check-web-fetch-jitless.mjs`、`check-dshm-installer.cjs` 四条**已修至 0**；
> 下表各行的"退出码"列已就地改为 `… → 0（已修）` 形态）。
> **2026-09-30 再重测：`22×0 / 1×1`** —— 唯一剩下的 1 条是 `check-model-roundtrip.mjs`（本机缺 koffi，
> 加 `--no-prompt` 后 exit 0）。`check-layout-fixtures.mjs` 与随之级联的 `neg-test-piai.mjs`
> **已随 `findTsc()` 补上 Windows 回退而变绿**（§2.4），**exit 3 已清零**。
> 三条新增门禁的读数：`check-skill-sync.cjs` ⇒ `RESULT: 32 passed, 0 failed`；
> `check-compat-exemption.cjs` ⇒ `RESULT: 48 passed, 0 failed`；`check-doc-refs.mjs` ⇒ **21 个文档 / 247 条引用 / 0 问题**（2026-09-30 读数；引用数随文档增改漂移）。
> `assert-resfile-sync.mjs` 的快照数已由 8 件增至 **10 件**（9 个 `FILES` + `package.json` 语义锁）。

> ⚠ **下表是 2026-09-28 / 09-30 的读数快照，不是当前值**（历史留档，故意不改）。判断"今天是否为绿"
> 请直接跑 `AGENTS.md` 清单里的命令、读它自己的输出；**条数会随实现增长**，写死在文档里必然过期
> （本文件 §8.13 已总结过这个教训）。**2026-10-05 复核的当前值**：`assert-exec-fix` **38** 项、
> `assert-fs-search-fallback` **58** 项、`assert-resfile-sync` **13** 件快照、`check-dead-code`
> **101 文件 / 2275 处声明**、`compat-drift` **140** 端点；`AGENTS.md` 的必跑清单现为
> **16 项 = 15 条 node + `device-acceptance.ps1`**（本次 19 条实测全绿）。

| 脚本 | 退出码 | 读数摘要 |
|---|---|---|
| `arch-check.mjs` | 0 | 扫描 131 个文件，无违规 |
| `assert-cli-shim.mjs` | 0 | 40 项断言全过 |
| `assert-exec-fix.mjs` | 0 | 35 项断言全过 |
| `assert-fs-search-fallback.mjs` | 0 | 39 通过 / 0 失败 |
| `assert-python-bridge.mjs` | 0 | 69 项断言全过 |
| `assert-report9-fixes.mjs` | 0 | 通过 29 / 失败 0 |
| `assert-resfile-sync.mjs` | 0 | 10 件快照全部同步（9 个 `FILES` + `package.json` 语义锁；2026-09-28 由 8 件增至 10 件）|
| `assert-speech-syntax.mjs` | 0 | 语法门禁通过（检查 1 个文件）|
| `check-builder-recursion.mjs` | 0 | 99 文件 / 102 个 `@Builder`，无自递归 |
| `check-custom-api-discovery.mjs` | 0 | 端点探测在垫片上可用 |
| `check-custom-api-save.mjs` | 0 | 创建/编辑/存密钥/重启存活/删除全链路成立 |
| `check-dead-code.mjs` | 0 | 99 文件 / 2237 处声明 / 256 个门面字段 ⇒ **无死代码** |
| `check-dead-handlers.mjs` | 0 | 未发现空实现 |
| `check-design-tokens.mjs` | 0 | 棘轮未增长 |
| `check-feature-wiring.mjs` | 0 | 扫描 133 文件 / **18 个功能** / 1 条反面规则，全部在 |
| `check-icon-assets.mjs` | 0 | 5 项通过 |
| `check-native-closure.mjs` | 0 | `RESULT: PASS`（含 `libsharp-openharmony-arm64.so` 的 SONAME 不一致告警，该库按路径 dlopen，属可接受）|
| `check-origin-fence.mjs` | 0 | `RESULT: PASS`（no-cookie → 401 等）|
| `check-parity.mjs` | 0 | 覆盖完整、状态合法、无形态注水、缺口已登记、统计与实算一致 |
| `check-plugin-toggle.mjs` | 0 | 186 条目 → `ui-deliverables enabled=false`，`RESULT: PASS` |
| `check-store-readiness.mjs` | 0 | `RESULT: PASS` |
| `check-toolchain-sign.mjs` | 0 | git `dshm-signed-v1+8501127`、python `dshm-signed-v1+27720007`，与归档实际大小自洽 |
| `check-user-rows-preflight.cjs` | 0 | 86 项通过 / 0 项失败 |
| `compat-drift.mjs` | 0 | 期望 138 / 基线 138，无漂移 |
| `audit-unused-exports.mjs` | 0 | 审计报告（非门禁）：entry 未引用 416 个，近零引用 144 个 |
| `check-model-roundtrip.mjs --no-prompt --wait-ms 60000` | 0 | 真起 Host → 铸 cookie → 读模型目录 → 建会话 → 开 mux → 收到 snapshot（含 projections）|
| `check-arkts-entry.mjs` | **3 → 0（2026-09-28 已修）** | 原因**不是**"缺 DevEco CLT"（CLT 本机就在 `<IDE>\tools`），而是脚本里**四处 Linux 布局写死**；修后 exit 0，日志含 `CompileArkTS` + `BUILD SUCCESSFUL`（§2.4）|
| `check-layout-fixtures.mjs` | **3 → 0**（2026-09-30 已把回退写进脚本，**不再需要 junction**） | 设 `DEVECO_CLI_CLT_PATH` 后仍找不到 tsc：`<CLT>\codelinter\node_modules\typescript\bin\tsc` 不存在；当时用 junction 指向 `<IDE>\tools\hvigor\hvigor\node_modules\typescript` 后 **768 条断言 / 0 失败**。**现已根治**：`findTsc()` 自己找 `<IDE>\tools\hvigor\{hvigor,hvigor-ohos-plugin}\...\typescript` 与 `<IDE>\tools\ohpm\...\typescript`（§2.4）|
| `check-fetch-shim.cjs` | **1 → 0（2026-09-28 已修）** | 修前：① 前提断言建在 `--no-experimental-fetch` 上，而 Node 24.19.0 **已移除该 flag**（传了死在 CLI 解析）⇒ 不带 flag 时 ① 报"原生 fetch 竟然可用"、带上 flag 时进程起不来，**两条路都红**；② 取证探针打在 `127.0.0.1:9`，**9 是 fetch 规范禁用端口** ⇒ 入口就返回 `bad port`，探不出 WASM 因果；③ 判据含 `fetch failed` 太宽。修后：前提改为 **WASM 不可用**、探针改用活着的本地 server、判据收紧为 `/WebAssembly\|not defined/`；**并且这一修顺带暴露一个产品真 bug**（见 §3.6 末段）|
| `check-model-roundtrip.mjs`（默认带 prompt）| **1 —— 环境依赖，不是产品缺陷** | **2026-10-05 复核更正**：默认模式的失败点是 `turn/end` 的 `reason.kind=error`，错误原文 `Cannot find the native Koffi module; did you bundle it correctly?` —— **本机缺 koffi**（它只随 HAP 分发、不在仓库里），属**环境缺件**；`--no-prompt` 复跑 **exit 0**。本节原先写"这是可复现的失败（连续两次同形），**不是环境缺件**，应单独排查"——**口径有误**（当时看到的 `ECONNREFUSED` 是更早一次运行的另一种形态，现已不复现）。⇒ 在无 koffi 的机器上，这条门禁的**正确跑法是 `--no-prompt`**；把它当红项会误导"仓库有缺陷" |
| `check-dshm-installer.cjs` | **1 → 0（2026-09-28 已修）** | 两处陈旧断言：① 期望依赖值带 `^`（`^4.3.4`），而实现自 2026-09-26 起优先写**请求 spec** ⇒ 实为 `4.3.4`；② 断言 installer 写 `.dshm-plugin-rows.yml`，而 `appendUserRow` 已于 2026-09-25 有意删除 ⇒ ENOENT 恒红。两处已重写（改为锁**不再写用户行**），并补 P1-2 双向用例（5a 真幂等 / 5b 版本漂移必重装 / 5c 一次追平后回幂等）⇒ `RESULT: 24 passed, 0 failed`（**2026-09-29 随 GitHub 安装修复增至 43 passed**，见 §2.5）|
| `check-web-fetch-jitless.mjs` | **1 → 0（2026-09-28 已修）** | 两处硬缺陷：① flag 写死 `--no-experimental-fetch` 在 Node 24.19.0 下无效 ⇒ **两臂同时哑火**；② loader 传裸盘符路径 ⇒ 默认 ESM 加载器拒收 ⇒ **B 臂从未跑成过**。修后 A 臂 4/4 按预期失败（`WebAssembly is not defined`）、B 臂 8/8 全过、`PASS：对照实验成立`（§3.6）|

> **读这张表的方式**：`exit 3` 与 `check-fetch-shim.cjs` 的红
> 都已在 `docs/device-validation.md:4423-4435` 登记为"环境不足 / 需特定 flag"。
> **但其中 `check-arkts-entry.mjs`、`check-layout-fixtures.mjs`、`check-web-fetch-jitless.mjs`、
> `check-fetch-shim.cjs` 四条已在 2026-09-28 查明并修掉，实际原因都不是环境**（详见 §2.4 与 §3.6）；
> 其中 `check-fetch-shim.cjs` 那条的代价最重——它被"环境"这个标签挡住的这段时间里，
> 内部藏着的**产品真 bug**（原生 `FormData` 被编成 `"[object FormData]"`，直接砸 dsh 附属的附件上传）
> 一直没人看见（§3.6 末段）。
> `check-dshm-installer.cjs` 的两处陈旧断言同期重写（原来它一直是红的，见 §2.5）。
> **【2026-10-05 结案】`check-model-roundtrip.mjs` 默认参数那条红已定位、且不是缺陷**：现在的失败点
> 不再是 `ECONNREFUSED`，而是 `turn/end` 的 `reason.kind=error`，原文
> `Cannot find the native Koffi module; did you bundle it correctly?` ⇒ **本机缺 koffi**
> （它只随 HAP 分发、不在仓库里）。属**环境缺件**：`--no-prompt` 复跑 **exit 0**。
> 本节原先"待查 / 不是环境缺件"的措辞已在上表就地更正。
> 同一次普查（2026-10-05）把仓库 **43 个门禁脚本**逐个跑了一遍：**42 exit 0 / 1 exit 1**
> （唯一那条就是本节这条，且已定性为环境依赖）。

### 2.4 真机端侧验收：`tools/device-acceptance.ps1`

**用法**（`tools/device-acceptance.ps1:1-25`，全文 307 行）：

```powershell
powershell -NoProfile -File tools\device-acceptance.ps1
powershell -NoProfile -File tools\device-acceptance.ps1 -SkipInstall   # 已装最新包，只冷启动取证据
```

它**自动判定 5 项可脚本化的读数**（设备在线 / 核心已启动并读出运行核心版本 / 客户端已接入 /
平台标识 = ohos / 本次启动后无异常退出，`tools/device-acceptance.ps1:240-244`）；
**界面行为类项不做通过/失败判断**，只把布局与截图摆好，判定按
`docs/50-端侧核心运行架构.md` §12.9 / §14 由人来做。脚本全文只用
`hdc install -r` / `aa force-stop` / `aa start`，**没有 `hdc uninstall`** ⇒ 不碰设备数据。

#### 2.4.1 首跑的 4 项"FAIL"全部是脚本缺陷（不是应用缺陷）

2026-09-30 首次真机跑，6 项判定里 4 项 FAIL。逐条坐实真因后**全部归到脚本**：

| 现象 | 真因 |
|---|---|
| 5 份 hilog 摘录全部 **5 字节**（只有一个换行） | hilog 是环形缓冲，**实测覆盖仅约 8–10 秒**；而"等核心就绪"要 45 秒 ⇒ 一次性启动事件早被冲掉。`hilog -r` 又把仅存的也清了 |
| 9 组 json/jpeg **尺寸完全相同**（`*.json` 恒 261,513 B、`*.jpeg` 恒 232,434 B） | 6 次 `Click-Text` 一次都没点动：**主界面上根本没有「设置」这个文本** |
| 「核心已启动 / 客户端已接入 / 平台标识 / 文件变更流」4 项 FAIL | 判据源（hilog）取不到 ⇒ 假 FAIL，见下 |
| 加 `-SkipInstall` 时"重启"是 no-op | `aa start` 对已运行进程不重启 ⇒ **冷启动必须显式 force-stop**，否则抓到的是上一次启动的日志（假 PASS） |

#### 2.4.2 判据改读设备侧持久日志（`E385`）

hilog 判"启动事件"必然假 FAIL。改读设备侧文件（shell 身份可读，实测）：

- `node-output.log` —— **每次启动轮转**，含本次启动全量 ⇒ 本轮权威；
- `dshm-host.log` —— **跨启动累积** ⇒ 必须用本次启动标记（`写锁巡检`）切片后才有效。

判据与信号源（改后）：

| 判据 | 信号源 |
|---|---|
| 核心已启动（**并读出运行核心版本**） | `node-output.log` 的 `BOOT_10_ENV_READY`（`cores/<版本>` 一眼可见） |
| 客户端已接入（凭据豁免生效） | `node-output.log` 的 `IN-UPGRADE GET /api/remote.mux` |
| 平台标识 = `ohos` | `node-output.log` 的 `平台标识：DSHM_PLATFORM=ohos` |
| 本次启动后无异常退出 / 无崩溃 | 上述两源里无 `!! process.exit` / `CppCrash` / `JS_ERROR` 等 |

**两条原判据被撤销，原因是结构性取不到**（不是"暂时取不到"）：

1. **`DSHM-AUTH connect`**：唯一产出点是 `entry/src/main/ets/pages/Index.ets:1365`，
   而当前入口是 `windowStage.loadContent('pages/WebApp')` ⇒ `pages/Index` **不可达**，
   这条判据永远取不到（`E264` 记过同一件事的另一面）；
2. **`files changes opened`**：唯一产出点在 `SessionHub.ets:2500`，经 `console.info`
   走 hilog（缓冲过后即失）；且设备侧日志里 `fs-watch` **全史只出现过 1 次**
   （2026-09-27）⇒ 不是每次启动都有，**不能当每次验收的判据**。该
   项**降级为人工看界面**（"改一个工作区文件 → 右侧「文件变动」是否出现条目"）。

#### 2.4.3 导航：设置对话框不在主界面上

主界面**没有「设置」文本**。真实路径 = 点「账号菜单」`popUpButton` → 弹出菜单里才有
`设置` / `意见反馈` / `退出登录` → 点「设置」。改前脚本点的「通用 / 核心 / 预设 / 技能」
**一个都不存在**（这就是 6 行"未找到可点文本…跳过"的来源）。

设置对话框（实测 `[711,391][2112,1529]`）左栏九个分区：
`账号与余额 / 通用设置 / 模型 / 内置插件 / Agent 预设 / Our Free Model / 插件市场 /
皮肤市场 / 侧边卡片`。脚本逐个点开并各存一份布局与截图，点动与否记进同目录 `nav.md`。

**按文本点击，不写死坐标**（`tools/device-acceptance.ps1:93` 起）：
dump 布局 → 找 `attributes.text` 匹配的节点 → 取其 bounds 中心点击。
理由写在注释里：**坐标依赖分辨率与布局**，换台设备必然点错，而"点错"在验收里最危险——
它看起来像"功能坏了"（`E261`）。实测同一台设备**重启后主窗口整体位移**
（`应用` 从 `[67,90]` 变 `[513,302]`）⇒ 硬编码坐标在单机上也会失效。
菜单未打开时点旧坐标会落到**系统桌面**（把应用切到后台），这也是"看起来像功能坏了"的一例。

#### 2.4.4 另外两个修掉的坑

- **`hdc` 只认写死单一路径**（`E386`）：原实现只试 `D:\Huawei\DevEco Studio\...`，
  本机不存在即 `exit 2`；它和前一章那些"环境受限"是同一类**误报**。改为
  `DSHM_HDC` 优先 + 探测 `%LOCALAPPDATA%\OpenHarmony\Sdk\<版本>\toolchains\hdc.exe`
  （多版本降序取第一个存在的）。
- **`hdc shell cat` 读中文日志必乱**（`E387`）：输出经控制台 GBK 解码。必须
  `hdc file recv` 落盘后用 `[System.IO.File]::ReadAllText(..., UTF8)` 读。
  同类坑在 `.ps1` 自身的编码上也存在：**UTF-8 无 BOM 的 `.ps1`** 会被
  Windows PowerShell 5.1 按 ANSI 解码 ⇒ 中文乱码 + 解析报错（看起来像语法错）。

#### 2.4.5 修后实跑（2026-09-30 12:01，设备 `86E0226429000417`）

```
dist/acceptance/20260930-120131/
  自动判定：设备在线 PASS / 核心已启动 PASS（运行核心 0.2.0-rc.2）
            客户端已接入 PASS / 平台标识 = ohos PASS / 无异常退出 PASS
  nav.md：账号菜单 OK → 设置 OK → 9 个分区全部 OK
  device-node-output.log 165,601 B、device-dshm-host.log 209,907 B（UTF-8 原文）
```

**报告里"必须看界面"的项为什么不能自动化**：它们考的是"行为与呈现"
（命令面板、模型选择、计划模式、轨迹、插件启停、删除/归档、多形态、目标栏、消息反馈），
日志判不出来（`tools/device-acceptance.ps1:275-296`）。

### 2.5 回归纪律：不允许"修好后面、前面又坏"

三条（`AGENTS.md`、`docs/80:150-176`）：

1. **改动前**先跑基线并记录结果；
2. **改动后**跑同一批，逐项对比；**任何 ok → fail 必须当场修，不许延后**；
3. **临时实验必须在同一次改动内还原**，把验证到的结论写进代码注释，而不是留下实验代码。

**为什么第 3 条是硬的**：本项目在定位 `javaScriptProxy` 双桥覆盖时，为找原因交换过注册顺序，
**差点留下实验残留**（`docs/80:150-153`）。同类事件还有一次可执行的正例：
给 `runProfile` 前后临时插计时桩量化启动分段（读到 `runProfile-returned +7261ms`）后，
**插桩已完全撤除**，并核验 `hostcore/app/main.js` 与 resfile 副本都不含 `SP_TIMING`/`spMark`
（`docs/device-validation.md:3940-3943`）。

**为什么"跑过了"不等于"修对了"**：本项目有过"断言绿了但测错了对象"的先例——
`[bool]([regex]::Match(...))` 恒为真，掩盖了 5 个章节页缺背景的真 bug
（`docs/80:174-176`）。⇒ **门禁必须跑，但结论要人看**。

### 2.6 门禁自身的两条纪律（否则门禁会退化成噪声）

1. **门禁必须先在已知坏版本上红过一次**（`E344`，`docs/70:737-742`）。
   用人工注入的样例能过，只证明"检测器会匹配我写的样例"，**不能**证明"它会命中真实的那行代码"。
   ⇒ 必须做**归真验证**（`git show HEAD:<file>` 存成临时文件 → 扫 → 命中）；为此检测器要导出
   `scanText` 而不只在 `main()` 里跑。已在 `check-builder-recursion.mjs`（命中 `MainShell.ets:380`）、
   `check-dead-code.mjs`（对修前 `SettingsPane` 命中 5 处）、`check-feature-wiring.mjs`
   （对修前 `HEAD` 命中 `AppShell.ets:228`）三处做过。
2. **负测试"没生效"比负测试"失败"更危险**（`E381/E382`，`docs/70:816-823`）。
   按纪律做负测试时，第一版按 `\n` 拼锚点，而文件是 **CRLF** ⇒ 替换没生效，
   脚本却只打印一句"锚点没对上"就继续跑完，最后报了"✓ 负测试通过"——**一个虚假的安全感**。
   ⇒ 负测试必须**断言篡改本身真的发生了**（替换前后字符串不等），没发生即报错退出。

### 2.7 本节验证方式

```powershell
# 1) 门禁清单（以 AGENTS.md 的「必跑的回归门禁」为准，当前 16 项 + 结构性守卫），逐条记退出码
foreach ($g in @('assert-cli-shim.mjs','assert-resfile-sync.mjs','check-parity.mjs','compat-drift.mjs',
                 'assert-exec-fix.mjs','assert-python-bridge.mjs','assert-fs-search-fallback.mjs')) {
  node "tools/$g"; "  -> $g exit=$LASTEXITCODE"
}

# 2) 门禁自检（证明检测器真的会失败）
node tools/check-parity.mjs --self-test
node tools/check-layout-fixtures.mjs --self-test
node tools/arch-check.mjs --self-test

# 3) 真机端侧验收
powershell -NoProfile -File tools\device-acceptance.ps1

# 4) 装机 + 数据保全
.\tools\update-device.ps1
```

---

## 3. 诊断手段（真机排障按顺序用）

### 3.1 为什么必须有"文件式 diag"：本地 hilog 会丢日志

三处实证，构成同一条结论：

- **hilog 在本机有丢日志前科**（`docs/70:855`）：`pick()` 的 hilog 一条没出现，
  但 `filesDir/diag-pick-called` 文件存在（`entry/src/main/ets/pages/WebApp.ets:428-431`）。
- **时序类排查必须用文件标记取证**，不能凭"日志里没出现"下结论
  （`docs/device-validation.md:3803`、`docs/70:1090`）。
- **应用进程的 stdout 在设备上不可见**，`filesDir` 又给 hdc 读 ⇒ 必须"自己抓 stdout 再转 hilog"
  或"自己写文件"（`docs/50-端侧核心运行架构.md` E23/E33 条目）。

⇒ 于是有了**文件式 diag 标记**：写入 `filesDir` 下的固定文件名，**追加模式 + ISO 时间戳**
（`WebApp.ets:452-471`——`fileIo.openSync(p, CREATE|READ_WRITE|APPEND)` + `writeSync(ISO + detail + '\n')`，
**写失败静默**，因为它是诊断辅助、不碰业务路径）。
追加而非覆盖的理由：多次事件按序累积，**既能证明发生过，又能看到时间线**（`WebApp.ets:453-455`）。

### 3.2 两个日志文件的分工（**最容易误判的一处**）

| 文件 | 内容 | 谁写 | 生命周期 |
|---|---|---|---|
| `node-output.log` | Host stdout/stderr：`BOOT_*` 阶段标记、`DSHM_READY` | 原生侧 `dshhost.cc` 用 `freopen` 把 stdout 指到它、`dup2(1,2)` 让 stderr 也进同一文件（`hostruntime/src/main/cpp/dshhost.cc:235-255`）| **每次启动截断** |
| `dshm-host.log` | `diag()` 输出：exec 探测、工具链解包、假壳布置、插件行预检等取证行 | `hostcore/app/main.js` 的 `diag()`：`createWriteStream(DIAG_LOG, { flags: 'a' })`（`hostcore/app/main.js:71-92`）| **追加，跨重启保留** |

**判据**：`stage()`/`console.log`（含 `DSHM_READY`）走 **stdout → `node-output.log`**；
`diag()` 走 **stderr → `dshm-host.log`**（`docs/70:549-550`）。
`diag()` 同时也会 `process.stdout.write` 一份（`main.js:90-91`），所以在 PC 侧离线跑时两边都能看到。

> **真实误判**：曾有批次据 `dshm-host.log` 判定"宿主从未就绪"，据此得出"真实启动失败"的**错误**结论；
> 实际 `BOOT_60/65/70` + `DSHM_READY` 齐全，只是那些标记打在 **`node-output.log`**
> （`E-SV16`/`E-SV20`，`docs/70:1086,1090`、`docs/device-validation.md:3801-3803`）。
> **取证时必须两个文件都拉**。

### 3.3 `BOOT_*` 阶段标记：把启动切成可判定的段

`hostcore/app/main.js:615-640` 定义了完整阶段链：

| 标记 | 含义 |
|---|---|
| `BOOT_00_NODE_START` | 入口脚本开始执行（能读到它就说明 libnode + `node::Start` 成立）|
| `BOOT_10_ENV_READY` | 环境/路径已解析（打出实际取值，便于核对是否指向错目录）|
| `BOOT_20_CORE_FOUND` | 核心树与 dsh CLI 入口都在 |
| `BOOT_30_PROFILE_READY` | 端侧 profile 已就位（bundle 列表 + patch 层）|
| `BOOT_40_PROFILE_BOOT` | 即将 `runProfile`（插件树从这里开始挂载）|
| `BOOT_50_DSH_INIT` | `runProfile` 返回且拿到 `ctx` |
| `BOOT_60_HTTP_BIND` | `ctx.webServer` 存在（dsh 已绑定端口）|
| `BOOT_62_PY_BRIDGE_HTTP` / `BOOT_63_REGISTRY_VIEW` / `BOOT_63B_PACKAGE_LIST` | 三个自建端点注册完成 |
| `BOOT_65_AUTH_URL` | 已写出 `host-ready.json`（带 port 与 tokenLen）|
| `BOOT_70_HTTP_READY` | **自探**一次 HTTP，确认端口**真的应答**（不是"应该应答"）|
| `BOOT_ERR` | 失败：带 `after=<最后一个成功阶段>` + 原因 |

**`BOOT_70` 为什么必须是自探**：dsh 报"绑了端口"与"端口真的应答"是两件事——
自探用 `node:http` GET 一次 `/`（`docs/70:853`）。

**`BOOT_ERR` 的取证语法**：`console.error('[dshm-host] BOOT_ERR after=<阶段> reason=<原因>')`
（`main.js:887`），所以直接 grep `BOOT_ERR after=` 就能一眼看到卡在哪一段。

### 3.4 `diag-*` 文件家族：各自的用途与守卫能力

以下是当前代码里**确实存在写入点**的 diag 标记（已逐一核到源码行）：

| 标记 | 用途 | 写入点 |
|---|---|---|
| `diag-pick-called` | 目录选择的同步入口被调（**证明桥真的被调过**）| `WebApp.ets:737` |
| `diag-select-returned` | 系统选择器返回，`count=` 选了几个 | `WebApp.ets:781` |
| `diag-select-error` | 选择器抛错（`code=` + `message`）| `WebApp.ets:776` |
| `diag-persist-done` / `diag-persist-skip` | 目录授权持久化的结果（失败不影响本次选择）| `WebApp.ets:807,811` |
| `diag-resolve-dispatched` | 结果回传 H5 的三态：`path=` / `error=` / `cancelled` | `WebApp.ets:828,830,832` |
| `diag-dispatch-error` | 回传阶段自身抛错 | `WebApp.ets:837,842` |
| `diag-file-selector` | 区分"用户看到的是 ArkWeb 默认选择器"还是"我们的 DocumentViewPicker" | `WebApp.ets:2420` |
| `diag-web-load` | Web 加载三态：失败（含"已排第 N 次自动重试"）/ 保持启动页 / 成功 200 | `WebApp.ets:1498,1520,1552,2396` |
| `diag-web-permission` | 每次 `onPermissionRequest` 都落一条：`origin=` / `requested=` / `audio=` / `loopback=` | `WebApp.ets:1695` |
| `diag-mic-permission` | 麦克风权限申请结果 | `WebApp.ets:1130,1135` |
| `diag-native` | 原生采集：启动 / 取走 N 字节（含 ms 与 peak）/ 落盘 wav | `WebApp.ets:1244,1326,1340,1343` |
| `diag-native-error` | 原生采集失败（权限未授予 / 启动失败 / 落盘失败）| `WebApp.ets:1164,1172,1257` |
| `diag-openlink` | 外链外开请求：`auto <url>`（授权页自动外开）/ `confirm <url>`（外链二次确认）/ `failed <url>`（`openLink` 未受理）/ `error <msg>` | `WebApp.ets:1041,1086,1100` |

> 行号随 `WebApp.ets` 增删浮动（2026-09-28 加外链外开垫片后整体后移 340 行，已按新行号更新一遍）。
> 判断某个标记是否还存在，**以标记名 grep `WebApp.ets` 为准**，不要照行号找；
> 本表在 `docs/70` §7.9（m00001 修复）落地时同步补入 `diag-openlink` 一行。

**已经被删掉、不再存在的标记**：当前源码里**没有写入点**的包括
`diag-mic-probe`、`diag-hms-speech`、`diag-hms-e2e`、`diag-loadpath`
（前者的名字只出现在注释与纯逻辑模型的说明里，后三者只在 `docs/device-validation.md` 的历史批次里有读数）。
**照旧文档去找这几个文件会找不到**——它们属于 HMS 路线 / 麦克风自检探针时代
（`docs/device-validation.md:2632,2757,3431`；探针曾由"应用 → 麦克风自检"菜单触发，
该菜单项已随测试探针清理一并删除，`docs/device-validation.md:4259-4279`）。

**语音链路的当前观测点**（换 SenseVoice 后）：

| 文件 | 内容 |
|---|---|
| `files/hms-speech-bridge-heartbeat` | 桥心跳：`started dir=…` / `预热…` / `alive ticks=… busy=…` / `got request id=…` / `done id=… text=…`（超过 64KB 轮转）|
| `…-heartbeat-asr` | 该次识别的 ASR 侧日志 |
| `<filesDir>/dsh/home/speech-to-text/hms-bridge/requests.log` | provider 侧：`transcribe #N whole audioMs=… bytes=…`、`transcribe #N done <ms> -> <json>` |
| 同目录 `model-dir-diag.txt` | 模型目录的真实状态 |
| 队列协议 | `*.req`（投递，先写 `*.tmp` 再改名）/ `*.done` / `*.fail` |

（`entry/src/main/ets/speech/HmsSpeechBridge.ets:117-121,263-280,534`、
`hostcore/speech-provider/index.js:96-98,226-254,270-295,476-478`）

### 3.5 `hdc` 常用命令，以及"读不到应用私有目录"这个边界

```bash
# 读文件（files/ 下都可读；dsh/home 与 toolchain/ 不可读，见 §1.8）
hdc shell "cat /data/app/el2/100/base/com.dshm.dshclient/haps/entry/files/dshm-host.log"
hdc shell "tail -n 40 .../files/dshm-host.log"
hdc shell "grep -E 'exec 探测：' .../files/dshm-host.log | tail -1"
hdc shell "grep -E 'BOOT_' .../files/node-output.log | tail -12"
hdc shell "grep DSHM_READY .../files/node-output.log | tail -1"
hdc file recv .../files/dshm-host.log .            # 整份拉回（曾用它取回 37KB 诊断日志）

# 看进程
hdc shell "pidof com.dshm.dshclient"
hdc shell "ps -ef | grep com.dshm.dshclient"       # 计"4 进程"

# 看端口（3120 = 0x0C30）
hdc shell "cat /proc/net/tcp | grep 0C30"
hdc fport tcp:3120 tcp:3120                        # PC 侧转发后 curl 自检
curl -s http://127.0.0.1:3120/dshm-python/status   # 期望 {"ok":true,…,"initialized":true}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3120/   # 期望 401（信任栅栏文案）
hdc fport rm tcp:3120                              # 验收后清理

# 启停（只停进程，不删数据）
hdc shell "aa force-stop com.dshm.dshclient"
hdc shell "aa start -a EntryAbility -b com.dshm.dshclient"

# 界面取证（ArkUI 层级的权威坐标与文本）
hdc shell "uitest dumpLayout -p /data/local/tmp/_ui.json" && hdc shell "cat /data/local/tmp/_ui.json"
hdc shell "snapshot_display -f /data/local/tmp/x.jpeg" && hdc file recv /data/local/tmp/x.jpeg .

# 设备 UDID（与签名材料核对用）
hdc shell "bm get -u"
```

依据：`docs/80:126`、`docs/50-端侧核心运行架构.md` §12.0（`:889-897`）、
`docs/device-validation.md:447,413,803,919-920,2583`、`tools/dshtest.py`（这些命令的定型封装）。

**"读不到应用私有目录"这个边界必须记住**（`docs/70:278-285`、`docs/device-validation.md:2353`）：

- **可读**：`files/`（含 `files/bin/`、`dshm-host.log`、`node-output.log`）；
- **不可读**：`dsh/home`（`700`）⇒ `host-ready.json`（含 token）取不到；`toolchain/` 也读不了；
- **不可读**：`cacheDir`（`Permission denied`）⇒ **诊断日志落点必须用 `filesDir`**（`E32②`）。

**还有一个方向相反的坑**：`hdc` 的 `Permission denied` 有时只是**跨 uid 观测限制**，
不代表文件真的不可用。例如 symlink 占位：hdc（shell uid）`stat`/`open` 全拒，
而 app（属主 uid）`open`+`read` 占位**成功且读到真身 ELF**（`docs/70:232-239`）。
⇒ "hdc 说不行"与"应用说不行"是两件事，要用**属主视角**的证据（应用自己写出的 diag）来判。

### 3.6 `aa start` 失败**先读 Error Code**

真实误判：本轮排查中一度把"应用崩溃"当结论（进程数 0、无 diag、hilog 无异常），
真因是 `aa start` 返回：

```text
aa start: error: failed to start ability.
Error Code:10106102  The device screen is locked during the application launch
```

⇒ **设备锁屏**（`E-SP4`，`docs/70:1096`、`docs/device-validation.md:4046-4056`）。
同类记录还有一处更早的：连续两次 `aa start` 失败，真因同样是 `10106102`，
而当时最新崩溃日志仍是旧的、没有新崩溃（`docs/50-端侧核心运行架构.md` E32 条目）。

**纪律**：`aa start` 的返回值一定要读。**设备状态问题与代码问题表现相同（进程不存在、无日志），
但成因完全不同**——不读错误码就会去改一件根本没坏的东西。

**已知的其他设备侧错误码/现象**（供对照，避免误判）：

| 现象 | 真因 | 处置 |
|---|---|---|
| `Error Code:10106102` | 设备锁屏 | 解锁后重试（`docs/70:1096`）|
| `EADDRINUSE: … 127.0.0.1:3120` | 另一个 bundle 的 Host 占着 3120（两个 bundle 都硬编码该端口 ⇒ 互斥）| `aa force-stop` 旧应用（**只停进程、不删数据**）|
| 应用"起来就消失"、`pidof` 为空、无任何 `DSHM-*` 日志 | `Reason:LIFECYCLE_TIMEOUT` + `FreezeDetector`（主线程删 25k 文件）| 见 §4.1 的 `E45` |

（`docs/device-validation.md:2581-2585,2624`、`docs/70:252-260`）

### 3.7 三级取证顺序（建议照做）

1. **先读文件标记**（`files/diag-*`、`node-output.log`、`dshm-host.log`）——最可靠，不丢日志；
2. **再看进程与端口**（`pidof` / `/proc/net/tcp` 的 `0C30` / `fport` + HTTP 状态码）——
   判定"Host 到底有没有起来"；
3. **最后才看界面**（`uitest dumpLayout` 取权威坐标与文本、`snapshot_display` 截图）——
   要判"行为与呈现"时只能用这个，且**不要从截图里找像素猜坐标**
   （`docs/70:619-621`：鲸鱼"歪"排查中曾从整屏像素猜位置，量到的其实是窗口外的桌面图标）。

### 3.8 本节验证方式

```bash
# 1) 两个日志文件都在，且分工符合 §3.2
hdc shell "ls -la .../files/node-output.log .../files/dshm-host.log"
hdc shell "grep -c 'BOOT_' .../files/node-output.log"        # >0
hdc shell "grep -c 'BOOT_' .../files/dshm-host.log"          # 期望 0（这些标记不在这个文件）

# 2) diag 标记家族存在（触发一次目录选择后应新增记录）
hdc shell "ls -la .../files/diag-*"

# 3) BOOT 链完整性与 EXEC 七项
hdc shell "grep -E 'BOOT_' .../files/node-output.log | tail -12"
hdc shell "grep -E 'exec 探测：' .../files/dshm-host.log | tail -1"

# 4) 端口与 HTTP
hdc shell "cat /proc/net/tcp | grep 0C30"
hdc fport tcp:3120 tcp:3120 && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3120/ && hdc fport rm tcp:3120
```

---

## 4. 踩坑总表（本批与近几批新增）

### 4.0 表怎么读

每条一行，四段式：**现象 → 根因 → 修法 → 验证**。末列指向 `docs/70-鸿蒙移植踩坑与修复总览.md`
或 `docs/device-validation.md` 中**已有的详述位置**（不要把详述当成本表的替代）。

编号沿用 `docs/70` 与 `docs/device-validation.md` 里既有的用法，**不新增编号**。

### 4.1 平台与进程模型

| # | 现象 | 根因 | 修法 | 验证 | 详述 |
|---|---|---|---|---|---|
| `E45` | 换核心包后启动，"起来就消失"，`pidof` 为空且**连一条 `DSHM-*` 都没有** | `BundledCore.installBundledCores` 用 `fs.rmdirSync` 删 **216MB / 25k 文件**，**在主线程**上做（异步函数里的同步段同样阻塞 ArkUI 线程）⇒ 系统 `LIFECYCLE_TIMEOUT` | 改为 `fs.renameSync` 挪成 `<coreDir>.stale-<ts>.tmp`（毫秒级元数据操作；`.tmp` 后缀被 `CoreStore.listInstalled` 明确忽略），安装末尾再用**异步** `fs.rmdir` 清理 | 系统日志 `Reason:LIFECYCLE_TIMEOUT` 消失；`pidof` 有值；`BOOT_*` 链完整 | `docs/70:252-260` |
| `E32` | `建立端侧核心目录失败：13900015 File exists` | OHOS 的 `fs.mkdirSync(path, true)` 在**目标目录已存在时抛错**，而 Node 的 `recursive:true` 是幂等的 ⇒ "幂等"的 `ensureLayout()` 第二次调用必然失败（安装与启动都会调）| 先 `fs.accessSync` 判存在 | 连续两次启动都成功建目录 | `docs/70:270-276`、`docs/50` E32 |
| `E32②` | 诊断日志落 `cacheDir` 后取不到 | `hdc shell` 对 `cacheDir` 无读权限（`Permission denied`），`files` 目录可读 | 落点从 `cacheDir` 改 **`filesDir`**（`DSHM_SANDBOX_HOME` 一并指向 filesDir）| `hdc shell cat .../files/dshm-host.log` 有内容 | `docs/70:283` |
| `E149` | 点「切换」核心 → 进程**原生崩溃**（`exitSigno = 6` / SIGABRT），无 `DSHM-CORE 切换结果` | 同一进程内**第二次** `node::Start` 让进程 abort（libnode 在一个应用进程里被设计为只启动一次）| 未解决；界面**不得**声称"切换/回滚"可用（"界面不撒谎"）| `uitest dumpLayout` 取精确 bounds 后再点，仍复现即确认 | `docs/50` E149 |
| `E-SP4` | 进程 0、无 diag、hilog 无异常 ⇒ 误判"应用崩溃" | `aa start` 返回 `Error Code:10106102 The device screen is locked during the application launch`——**设备锁屏** | 读 `aa start` 的返回值再下结论 | 解锁后同一命令成功 | 本章 §3.6；`docs/70:1204` |
| `E-SV20` | 据 `dshm-host.log` 判定"宿主从未就绪"，得出"真实启动失败" | **`BOOT_*`/`DSHM_READY` 打在 `node-output.log`**，不在 `dshm-host.log` | 两个文件都拉；时序类排查用**文件标记** | `grep -c 'BOOT_' node-output.log` > 0 | 本章 §3.2；`docs/70:1198` |
| 端口互斥 | `EADDRINUSE: address already in use 127.0.0.1:3120` | 两个 bundle 都硬编码 3120 ⇒ 互斥；`/proc/net/tcp` 的 `0C30` LISTEN socket 属**旧应用**的 uid | `aa force-stop` 旧应用（**只停进程、不删数据**）| `pidof` 空、`/proc/net/tcp` 无 `0C30` | `docs/device-validation.md:2581-2585,2624` |

### 4.2 hmfs 文件系统

| # | 现象 | 根因 | 修法 | 验证 | 详述 |
|---|---|---|---|---|---|
| 元数据不可信 | `bin/` 里 5 个文件 `stat` 显示 `?????`；apk 内 symlink 在 hmfs 留下"残缺链接占位"（`l????????`），而 Node 的 `statSync`/`lstatSync`/`accessSync` **全部返回成功且 `mode=0777`** | hmfs 的元数据（`stat`/`lstat`/`access`）**会撒谎**；symlink 固有 x 位 ⇒ 按元数据判"可执行"永远被骗 | 判据只用**真实数据面**：`isElf()`——`open` + `read` 前 4 字节验 `\x7fELF` magic。**骗不了** | 用 `isElf()` 判定后，"残缺链接"不再被当成可执行文件 | `docs/70:203-213` |
| "封存态" | 03:04 首次布置成功；06:10 幂等 `chmod` 仍通过；**07:57 起每次 boot 对同路径 chmod 全部 EACCES** ⇒ 四命令全 127 | 曾布置过的文件可能 **chmod 与覆盖写都被拒**；`ensureBusybox` 按设计整体放弃 ⇒ PATH 未注入 ⇒ 假壳/wrapper/解包全链跳过 | `rewriteExecutable`：直写 → 失败 → **删除重铺全新 inode** → chmod → X_OK；健康快路径改双条件（`statSize` 一致 **且** `execOk`）+ `bin-<pid>` fallback 目录 + `cleanupStaleBinDirs` | `diag` 出现 `…：直接写入失败，已删除重铺`；exec 探测七项恢复 | `docs/70:214-222` |
| tar `settime` | 解包 4530 文件全部 `tar: settime: Permission denied` | hmfs 上 `settime` 恒 EACCES | `tar -m`（`--touch`）——**内容与权限恢复本不受影响**（`python3.12` 23MB `rwxr-xr-x` 实证）| 不再出现 `tar: had errors`；文件大小 + ELF magic 正常 | `docs/70:224-230` |
| symlink 观测差 | hdc 对 symlink 占位 `stat`/`open` 全拒，但 app 属主 `open`+`read` 成功且读到真身 ELF | 跨 uid 观测限制，不是"不可用" | `git-remote-https` 实际可执行、无需补齐；`isElf` 防御保留兜底 | 属主视角的证据（应用自写 diag）| `docs/70:232-239` |
| 25k 文件树删除超时 | python 桥 `shutil.rmtree` / `rm -rf` 25k 文件树 → `rc=124`（桥 `run-get` 默认 120s SIGALRM 超时）| 桥的同步超时语义 | ① `os.rename` 成 `.tmp` 后缀（**原子瞬间完成**，`listInstalled` 立即视同不存在）；② `os.system('rm -rf …')` 配 `&timeout=300` 后台慢删 | 返回非 124；`cores/` 下无残留 `.tmp` 被误认 | `docs/70:262-268` |

### 4.3 打包与资源

| # | 现象 | 根因 | 修法 | 验证 | 详述 |
|---|---|---|---|---|---|
| HAP 丢 dotfile | 用 `.dshm-signed` 做签名标记，端侧永远认为"未签名" | **HAP 打包丢弃所有 dot-前缀条目**（实测 dotfile 条目数 = 0）| 标记文件名不能以点开头 ⇒ 改为 `dshm-signed.txt` | HAP 内能 `tar -tf` 看到 `dshm-signed.txt` | `docs/70:291-296` |
| 签名被后续补丁覆盖 | 签名"做了但无效" | `selfSignNatives()` 曾在 `replaceKoffiJs()` 之后，而 `ensureRipgrepPlatformPackage()` 会**重写 rg** ⇒ 冲掉签名 | 移到 `pack()` 之前 ⇒ **"改写产物"的步骤之后才是签名** | `display-sign` → `code signature is self-sign` | `docs/70:297-304` |
| "存在即跳过"缓存 | 构建期的改动**永不到达设备**（签名改了，设备上还是旧文件）| 端侧门（`gitReady()`/`pythonReady()`）只判存在 | 加版本标记（`dshm-signed.txt`）+ `readArchiveSignMarker` / `readExtractedSignMarker` / `needsReextractForSign` ⇒ **标记不符就强制重解包** | 真机 diag：`工具链：python 归档已换代（dshm-signed.txt 变化），强制重解…` | `E-TS2` 详述；`docs/70:306-315` |
| `E-TS1` | 侧载前设备 `exec 探测` 只有 **2/7**（`rg`/`bash` 通，git/python 真身全被 execve 拒）| **三层**：① 本机 PATH 无 `python3`/`python`/`py`；② `place-toolchain.mjs` 的 `findHostPython()` 只找 PATH ⇒ 返回 null；③ 找不到宿主 python 时**只打一行 ⚠ 就跳过**，脚本仍 `exit=0` ⇒ **构建全绿、装机后才暴露** | ① `findHostPython()` 追加候选（`DSHM_HOST_PYTHON` → **项目自带** python → PATH）；② 签名未执行 ⇒ **`exit 1`**，保留 `DSHM_ALLOW_UNSIGNED_TOOLCHAIN=1` 逃生阀（高声提示）；③ 新增 `check-toolchain-sign.mjs` 门禁 | 真机实测 **2/7 → 7/7**（`python3.12=ok, git=ok, git-core/git=ok, git-remote-http=ok, rg=ok, bash=ok, git-ls-remote=ok`）；`check-toolchain-sign.mjs` exit 0 | `docs/device-validation.md:4313-4350`；与 §4.3 的"存在即跳过"是同族（构建期改动到不了设备）|
| `E-TS2` | 端侧判成"没换代"⇒不重解 ⇒ **新签名永远到不了设备，白签一场** | `SIGN_MARKER = 'dshm-signed-v1'` 是**固定常量**，而端侧判据是"解包目录标记 !== 归档目录标记 ⇒ 重解" | 标记改为 **前缀 + 内容摘要**（每个归档目录**各算各的**文件大小之和；python 与 git 分开算）| 设备上标记变为 `dshm-signed-v1+8501127`（git）/ `dshm-signed-v1+27720007`（python），换代判定确实触发 | `docs/device-validation.md:4352-4368` |
| `E-TS2` 实现顺序坑 | 标记与落盘文件对不上 | 摘要最初在**签名之前**计算，而签名会改变文件大小 | 改为"**签名后、写标记前**"计算 | **新建的门禁立刻报出不一致**（它替我们抓住了顺序错误）| `docs/device-validation.md:4369-4371` |
| `E-SV19` | HAP 里混进 20.4MB 无用的 `libs/x86_64` | `build-profile.json5` 的 `abiFilters: ["arm64-v8a"]` **不影响 HAR 内自带的 `libs/x86_64`**（`nativeLib.filter.excludePattern` 尝试亦无效）| 改在**源头**：HAR 是 tar.gz，解包删 `package/libs/x86_64` 后重打包（原 HAR 备份 `.har.bak`）。**还必须清 `oh_modules/.ohpm` 的 sherpa 解包缓存并 `ohpm install`**——ohpm 按 lock 判定，不会因 har 文件变化重新解包 | HAP **320.1 → 299.5MB**；arm64 字节未动（`llvm-readelf` 对比 `DT_NEEDED` 一致）| `docs/70:1089`、`docs/device-validation.md:3762-3768` |
| `E-SV12` | 运行时 `Cannot find module`（新加的下载器模块）| `pack-core` 只拷 `speech-provider/index.js` → `lib/hms-provider.js`，而 provider 以 `../speech-models/index.js` 引用下载器 ⇒ 解析到 `<pkg>/speech-models/` | 在 `pack-core` 里**显式拷贝**，且**缺失即报错**（不静默跳过）| HAP → core zip → 解开 → 确认 `speech-models/` 在 | `docs/70:1082` |
| `E-SV22` | `pack-core` 连续 `die` 三次：`Origin 栅栏补丁：未找到待替换片段` / `agent preset 补丁：没有任何 preset 文件被改到` / `HMS provider 替换：未找到导出语句` | 用**字面标记**判"是否已打过"，而树里是上一版的**旧标记** ⇒ 判成未打过 ⇒ 重复替换 ⇒ 锚点已消失 | ① **判定兼容新旧名**；② 删 `dist/core/work/<ver>` 重新 `npm install` 物化，让旧标记随上游解包消失 | 旧标记残留 **0**，全部为新名 | `docs/70:1092`、`docs/device-validation.md:3860-3883` |
| `E-RV2` | 同类残留：`patchSensevoiceForHms` 判 `text.includes('DSHM_HMS_PROVIDER')` **无旧名分支** | 同 `E-SV22`（改名后只认新名）| 加 `\|\| includes('HDSH_HMS_PROVIDER')` | 重跑 `pack-core` 不再 `die` | `docs/device-validation.md:4076-4083` |
| `E-DL1` | `dist/sideload/` 里的 HAP 比 `entry/build/` **旧一个版本**（差 1172B，仅 `ets/modules.abc` 与 `sourceMaps.map` 不同），反汇编显示仍含已删的 `concat`/`sleepMs` | **操作顺序错误**：先刷新交付包，之后门禁抓出死代码 → 删掉 → 重新构建 ⇒ 交付包漏掉最后一次改动 | ① 刷新**前**断言"没有比构建更新的源文件"、刷新**后**断言"dist sha256 == build sha256"；② README 的 sha256 / 字节数 / 两个单位换算全部按实际重算 | `dist` 逐字节等于 `build`；README、`SHA256SUMS`、实际文件**三方一致** | `docs/device-validation.md:4373-4384` |

### 4.4 dsh 上游集成

| # | 现象 | 根因 | 修法 | 验证 | 详述 |
|---|---|---|---|---|---|
| `E-SV14` | 改了注入代码、`pack-core` 也报"✓ 完成"，但**设备行为毫无变化** | 注入守卫是"文件含标记就**整段跳过**"；核心树里已有**旧版**注入 ⇒ 新增的 `amplitude` 覆盖**从未被注入** | 改为**版本标记**判断（`DSHM_NATIVE_CAPTURE@v3-…`）：版本一致才跳过；版本不同则**先删旧注入段再注入新版**（不删会出现两份 `start`/`stop` 覆盖）| 设备上行为随版本变化；注入段唯一 | `docs/70:1084`、`docs/device-validation.md:3590-3600` |
| `E-RV5` | 改名后**端侧状态文件无迁移**：新代码只读 `.dshm-plugin-rows.yml`，升级老用户读不到自己的插件启停设置 | 改名把状态文件换了名，而它们在**用户数据目录**里 | `migrateLegacyRowsName()`——新名不存在且旧名存在时 `renameSync`；静默容错（失败退回"视为没有用户行"）| 单测三种情形：只有旧名→迁移；新名已存在→不动；都没有→false。**⚠ 本机实测未发生**（该设备改名前后一直在用）| `docs/device-validation.md:4122-4130` |
| `E-SV11` | 下载保存失败，界面报"磁盘空间不足或没有写入权限"，**实际磁盘空闲 174GB** | 原实现把响应用 `chunks.push` 累积后 `Buffer.concat`，峰值内存 ≈ **2×228MB**；端侧嵌入式运行时分派失败，且失败信息被分类逻辑**误判成 `storage`** | 改为 `openSync` + `writeSync` **边读边写盘** | PC 实测峰值 `heapUsed` 从 228MB+ 降到 **9.9MB** | `docs/70:1081`、`docs/device-validation.md:3521-3530` |
| `E-RV3` | 每次识别都付一遍 228MB 读 + 哈希 | `isAssetReady` 恒 `readFileSync` 整文件算 sha256，而 `missingAssets()` 被 `transcribe`/`inspect`/`snapshot` 反复调用；**且与下载路径刻意"流式写盘避免峰值"自相矛盾** | 改**两级校验**：默认只 `stat`（存在 + 字节数，微秒级）；只在**下载收尾**与显式 `{verify:true}` 时才读全文件算 sha256 | 识别延迟不再随模型大小线性增长；下载收尾仍校验 | `docs/device-validation.md:4085-4093` |

### 4.5 工具链与 exec

| # | 现象 | 根因 | 修法 | 验证 | 详述 |
|---|---|---|---|---|---|
| 签名域 | 沙箱内**未签名 ELF** execve 一律 `inaccessible or not found`（busybox / rg / git / python3.12）| 鸿蒙对"执行第三方原生二进制"的判据是**签名域**（不是权限位、创建者、inode）| **所有端侧原生二进制在构建期自签名**（`binary-sign-tool -selfSign 1`）；落点 `tools/pack-core.mjs`（签 core 树的 rg）与 `tools/place-toolchain.mjs`（签工具链归档）| `exec 探测` 七项全 `=ok`；`display-sign` 报 `code signature is self-sign` | `docs/70:32-46`、§0.2 |
| git 子进程 `rc=134` | `git clone/fetch/pull/push/ls-remote` 一律 SIGABRT：`BUG: run-command.c:525: disabling cancellation: Operation not permitted` | git v2.47.3 的 `atfork_prepare()` 用 `CHECK_BUG(pthread_setcancelstate/…)`——语义是"**这个调用不该失败**"；而**鸿蒙 musl 缺取消点控制**（返回 EPERM）⇒ `BUG()` abort。**不是 git 用法错，是平台 libc 缺能力** | 不重编 git：新增 `entry/src/main/cpp/gitcompat.c` → `libdshm-gitcompat.so`（**LD_PRELOAD** 垫片）。口径**透明优先**：先调 libc 真身，真身成功就原样成功；只在真身缺失或返回非 0 时改判成功。两个调用**一起兜**；`DT_NEEDED` **仅 libc.so** | 真机锚点 **`git-ls-remote=ok`**（`git ls-remote file://<本地裸仓库>`，走 `start_command()` 但**不需要网络**）| `docs/70:127-160`（`E376`）|
| git 第二层 | 垫片生效后 stderr 变成 `git-upload-pack: inaccessible or not found` | `usr/libexec/git-core/` 下 **141 个 symlink**（138 个指向 `../../bin/git`）在 hmfs 上**解不出来** ⇒ 子命令辅助程序一个都不存在；原先的 `GIT_SYMLINK_REPLICA` **只硬编码了 1 条** | `readGitCoreSymlinks()`——**从本版 git 的 apk 归档直接读 symlink 表**（纯 JS 扫 tar 头，不解包），按需以**真身拷贝**补齐 ⇒ 名字永远与这一版 git 一致 | diag：`工具链：从 <apk> 读到 git-core symlink 表 N 条` + `已用真身补齐 N 个` | `docs/70:150-155`、`docs/70:780-784` |
| bash 不存在 | `bash` 看起来"存在"但报 `applet not found`（exit 127）| busybox **未编** `bash`/`hush` applet | 移除这两个 applet；写 **bash 垫片**（文本脚本）：真 bash → busybox ash → `/system/bin/sh`，`exec` 直通。**脚本可执行**，因为由**系统** `/bin/sh` 执行 ⇒ 不受签名域约束 | 真机读数 `bash=ok` | `docs/70:504-512` |
| `E-SV13` | 正式包首次点听写即报「录音中断，请重试」，**没到录音环节** | 官方流程是 Web `getUserMedia` → `onPermissionRequest` → 申请权限，但**原生采集覆盖绕过了 `getUserMedia`** ⇒ 申请路径永不执行 ⇒ `createAudioCapturer` 失败。测试包早前已授权所以掩盖了该缺陷 | `startNativeCapture` 先 `ensureMicPermission()`；JS 等待窗口 3s → **15s**（首次要弹系统授权框，用户读完再点是人的时间尺度）| 真机：`ensureMicPermission granted=true results=[0]` → `★ 官方按钮 → 原生采集已启动` | `docs/70:1083`、`docs/device-validation.md:3539-3561` |
| python 桥冷路径卡死 | `exec -m pip` 冷路径**卡死**，`status`/`dsh web` 全挂 4 分钟+，只能 force-stop | `captureRun` 是**同步 NAPI 调用**，Python 卡多久 node 事件循环就卡多久 | 每个执行请求注入 **SIGALRM**（默认 120s，`&timeout=1..300` 可调），超时 handler 抛 `SystemExit(124)` 由 `captureRun` 捕获；请求后**统一清 itimer** | 冷路径返回 `rc=124` 而非挂死；后续请求仍可用 | `docs/70:534-537` |
| 桥的致命顺序坑 | 进程**暴毙** | `ErrPrint` 必须在 `GILRelease` **之前**；释放后再调 CPython API 直接 fatal（真机实证：清 itimer 的 `runString` 遇 `NameError` → `ErrPrint` 在已释放 GIL 上执行）| 调整调用顺序 | 真机不再暴毙 | `docs/70:538-540` |
| `E-SV21` | 门禁里有一条**自相矛盾**的断言（同时要求 `includes('/dshm-python/')` 与 `!includes('dshm-python')`），却**长期通过** | 当时文档里是 `hdsh-python`，恰好一条命中一条不命中——**命名往返（DSHM→HDSH→DSHM）的化石** | 方向翻转到旧名（`!includes('hdsh-python')`），守卫意图不变，写明来龙去脉 | 门禁语义可同时成立；本次实跑 exit 0 | `docs/70:1091`、`docs/device-validation.md:3844-3858` |
| `E-SV17` | `check-native-closure` **长期 FAIL**，报"1 个依赖无法解析" | 白名单把 `libace_napi.z.so`/`libhilog_ndk.z.so` 列为系统库，**漏了 `librawfile.z.so`**（`docs/70` 的依赖表把三者并列，明说都是 OHOS 标准库）| 补白名单 | 转 PASS；判定"是否本轮引入"用 **A/B**（拿备份原始 HAR 跑同一判定，同样 FAIL ⇒ 既有缺陷）| `docs/70:1087`、`docs/device-validation.md:3770-3782` |

### 4.6 ArkTS 与 UI

| # | 现象 | 根因 | 修法 | 验证 | 详述 |
|---|---|---|---|---|---|
| **`E-SP1`** | 启动页过后约 **2 秒白屏** | 启动页只挂在 `BOOTING`，而阶段流转是 `BOOTING → enterLoading() → LOADING → 200`；**`LOADING` 没有任何覆盖层** ⇒ 直接露出底层 Web（未渲染完的空白，或那次 404 的错误页）| 启动页条件改为 `phase === BOOTING \|\| (phase === LOADING && !this.everReady)` | `diag-web-load`：`失败：HTTP 404` → `↳ 保持启动页…` → `成功：页面已就绪（200）` | `docs/70:1093`、`docs/device-validation.md:3945-3967` |
| **`E-SP1` 的自身回归（必带 `!everReady`）** | 只看 phase 会让**应用内每次整页跳转都闪一下启动页** | `onPageBegin` 在**整页导航**（点链接、303 落地）时也会把 `READY` 打回 `LOADING` | `everReady` 在首次 `onPageEnd` 时置 true，此后不再把启动页盖在 LOADING 上 | 应用内跳转不闪启动页 | `docs/device-validation.md:3964-3967` |
| **`E-SP2`** | 进度条不准 + 中途冻结 | ① `setInterval(…, 220)` 每拍 `+3` ⇒ 走满需 **7.3s**（与真实耗时接近纯属**巧合**，首启 30–60s 时会"跑满一圈又重来"）；② `phase !== BOOTING` 就 `stopLoadTicker()` ⇒ 进 LOADING 后**冻结** | 改为**按经过时间渐进**并渐近逼近 90%，覆盖 BOOTING+LOADING 全程，就绪时置 100% | 8 秒启动下读数 24/42/64/76/83%，上限 90%（曲线校准依据见详述）| `docs/70:1094`、`docs/device-validation.md:3969-4002` |
| **`E-SP5`** | 进度条跑到某处**停住**，就绪时**猛地跳到 100%**（用户复报）| 两个叠加：① **`E-SP1` 的副作用**——`enterLoading()` 里的 `stopLoadTicker()` 把表提前杀掉、进度冻结；② `Math.floor(90*(1−e^(−t/τ)))` 指数衰减后期每拍推进不足 1%，**取整后连续多拍不变** | ① `enterLoading()` **不再停表**（只由 READY/ERROR 停）；② 去掉取整（`Progress.value` 收浮点）；③ 节拍 120ms → **40ms**；④ 就绪收尾用 **380ms ease-out** 补到 100% | 见详述的四项改前/改后对照表 | `docs/70:1145`（该行在文件末尾，是 E-SP 表格的续行）、`docs/device-validation.md:4015-4044` |
| **`E-SP3`** | "启动慢"的主体在哪 | 实测分段：`aa start`→Node ~2.1s；→`BOOT_40` 0.3s；**→`BOOT_50` 7.4s（`runProfile` 内部，dsh 加载插件树）**；→`BOOT_70` 0.2s；WebView→200 1.7s；合计 **~10.1s** ⇒ **主体在上游**（对上游零 patch）| 要真正缩短只能**减少启动插件数**（设备上 19 个非种子行），属产品决策 | 量化手段：临插计时桩读到 `enter-runProfile +0ms` / `runProfile-returned +7261ms`；**插桩已撤除并核验无残留** | `docs/70:1095`、`docs/device-validation.md:3925-3943` |
| `E-SV16` / `E-SV18` | 装机后首次打开**白屏**（宿主首启解包后固定 6～7s 才可用，WebView 早于它就绪 ⇒ **HTTP 404** ⇒ `fail()` ⇒ `phase=ERROR`，且**原实现停住不动**）| 竞态**无法消除**（宿主启动耗时可长可短）⇒ 修在**自愈** | 新增 `scheduleAutoRetry()`（退避 0.6s→1.2s→…，最多 6 次）+ `loadFailed` 标志（`onPageEnd` 在失败时也会触发，会**无条件置 READY 抹掉 ERROR**，必须阻断）| `diag-web-load`：`失败：HTTP 404（已排第 1 次自动重试）` → `第 1 次自动重试，延迟 600ms` → `成功：页面已就绪（200）`（**1.6 秒后自愈，零用户干预**）| `docs/70:1086,1088`、`docs/device-validation.md:3685-3719` |
| `E-SV15` | 频谱（波形）**恒为最小值** | 官方 `Waveform` 每 50ms 调 `recording.amplitude()`，它读 `this.analyser`；而原生采集覆盖了 `start()` ⇒ 创建 analyser 的那段被跳过 ⇒ 恒返回 0 | 覆盖 `Recording.prototype.amplitude`，改读 ArkTS 侧 `nativeCaptureState()` 的 `rms`。**用 RMS 而非峰值**（真机数据反推：官方映射 `height=1+min(1,level*5)*17`，peak=21020 时 peak/4=14.6、真 RMS=9.1，与官方同口径）| 用户确认识别正常、频谱正常；平方和在**已有**采样循环里顺带累加，**不新增遍历** | `docs/70:1085`、`docs/device-validation.md:3563-3588` |
| `E-DC1` | `check-dead-code` 长期红（3 处 PIAI/View 零使用声明）| 真死代码 + 搬迁未收尾 | 删 `Index.ets` 的 `protocolLabel` import、`SettingsModels` 的 `@Prop piAiProtocols`，**以及"转发一个没人读的字段"的末三跳**（`SettingsPane.states → TabContentView.facade → Index.facade`）| `扫描 99 文件 · 声明 2237 处 · 门面字段 256 个` → **无死代码** | `docs/device-validation.md:4443-4456` |
| `E-DC1` 的关键判断（差点删错）| — | `Index.ets` 的 `@State piAiProtocols` **不能删**——它在 `Index.ets:2177` 传给了 `PiAiProviderSheet.protocols`，而浮层**确实在读**它（`PiAiProviderSheet.ets:239/246` 渲染协议下拉）| 只删**末三跳**（转发链），保留源头与真实读者 | 删完构建报错（`piAiProtocols does not exist in type TabContentFacade`）⇒ 说明还有一处 facade 字面量没删干净；这正是"编译器会兜住转发链断裂"的体现 | `docs/device-validation.md:4451-4456` |
| `E-DC2` | `check-dead-code` 报一条**指向注释**的假阳性 | `importedNames()` 把 `import {…}` 块按逗号切分，而块内**可以写 `//` 注释** ⇒ 注释被当成一个待检查的"名字" | 切片后先按 `//` 截断，再要求匹配合法标识符（含 `A as B`），否则视为解析噪声跳过 | 重跑无该条。**留档口径：假阳性比漏报更糟——它让人不再相信这份报告** | `docs/device-validation.md:4458-4470` |
| `E-DH1` | `check-dead-handlers` 报 **180 处**，逐条分拣后 **177 处是误报**、**2 处是真·死按钮** | 旧判据报"所有跨行空箭头"，而绝大多数是**回调 prop 的必需默认值**（ArkTS 组件若回调 prop 无默认值，父组件不传就编译失败）⇒ 180 处的报告量让门禁**彻底失去信号** | 收紧为只报"**调用处内联空实现**"（`onX: () => { },` 写在组件构造参数里）；声明默认值 + 本文件别处用到 ⇒ 不报 | **180 → 2 → 0**（两处真 bug 经核实是**有意的空实现**，处置是**补注释说明"为什么空"**，而不是为了门禁变绿去改能跑的代码）| `docs/device-validation.md:4472-4515` |
| `E-DH1` 门禁自身两个缺陷 | 跨行声明形态漏判 / 只看"声明行之后"导致 6 处误报 | ① `onX: (…) => void =` 换行 `(…) => {` 只看单行会误判成"调用处空实现"；② ArkTS 组件里 `build()` 常写在成员声明**之前** | ① **同时看本行与上一行**；② **扫全文件、只排除声明那一行** | 180 → 0 | `docs/device-validation.md:4506-4513` |
| `E-RV1` | `dshm-mark.png` 实际**带着角标**（文档说"纯标记不带"）| `whale.alpha_composite(blk_r, …)` 是**就地**修改（PIL 该方法无返回值），之后 `mark = whale.resize(...)` 就继承了 HM/OS | 合成角标**之前**先 `whale_base = whale.copy()`，mark 从 `whale_base` 出图 | mark 与 foreground 缩到同尺寸后逐像素 alpha 差异 **0**（原右下角墨点 386）| `docs/device-validation.md:4068-4074` |
| `E-RV4` | 自检是"**装饰性护栏**"（拦不住任何东西）| 三条判据都恒真或只是 `print`：① "内腔透明采样点 > 0"（采样窗里本就有轮廓外的点，恒透明）；② "旋转后墨迹触边"（`rotate(expand=True)` 会扩画布，几乎不触发）；③ "确认启动画面未被改动"**只 print 不校验** | 三条全部做成真断言：内腔未被填黑（前景**不透明像素占比**须在 16%~20%，实测正常 18.1% / 填黑 23.5%）；mark 不带角标（在**角标框内**比较墨点）；启动画面与 `third_party/brand-original/` **逐字节比对**；**全部自检通过后才写盘** | 对抗性验证：把 bug 注入脚本副本，确认自检真的 exit 1（三条全拦住）| `docs/device-validation.md:4095-4120` |
| `E-RV5` | 改名后**端侧状态文件无迁移**（见 §4.4）| — | — | — | `docs/device-validation.md:4122-4130` |
| 状态栏跟随外观 | — | — | web 侧注入脚本读官方锚点 `getComputedStyle(documentElement).colorScheme` + `matchMedia` + `MutationObserver(documentElement)`；ArkTS 侧 `setWindowSystemBarProperties` + **同色**窗口底色消闪白 | 真机：外观切浅/深/跟随系统，状态栏与窗口底色即时跟随，**无闪白** | `docs/70:651-668`（`E375`）|

### 4.7 构建期 Windows 侧

| # | 现象 | 根因 | 修法 | 验证 | 详述 |
|---|---|---|---|---|---|
| tar 破坏 symlink | 用 `bsdtar`/`7z` 改工具链归档后归档损坏 | `bsdtar` **丢弃 symlink 条目**（不可逆地损坏归档）；`7z` 把 symlink **物化**成真文件（git-core 8MB → **1.3GB**）| **只用 Python `tarfile`**（逐条目复制，symlink 保持 symlink）：`tools/sign-tar-elf.py`。这也是 README 把 Python 3 列为构建前置的原因 | 归档内 symlink 条目数与原始一致；git-core 体积不膨胀 | `docs/70:241-250`、`docs/70:565-568` |
| `E63` | `pack-core` 在 `JSON.parse` 报 `Bad control character in string literal` | 用 `Get-Content -Raw` + `-replace` + `Set-Content` 改 JSON/文本，写进了一个**控制字符**（PowerShell 默认编码与正则的副作用）| `[System.IO.File]::ReadAllText(path, UTF8)` + `String.Replace` + `WriteAllText(…, UTF8Encoding($false))` | 生成物能 `JSON.parse` | `docs/70:587-593` |
| `E48` | 以相对路径调用脚本必然失败：`cd: tools/node-runtime: No such file or directory` | `HERE` 在脚本中途 `cd` 到源码树**之后**才用相对路径解析 | 在 `cd` 之前解析出绝对路径 | 从任意 cwd 调用脚本都成功 | `docs/70:582-585` |
| `E50` | 交叉编译**静默失败**：目标对象可能由宿主编译器编出 | — | 判据：检查日志里出现的是 `x86_64-unknown-linux-ohos-clang++`（1495 次），**未见宿主 g++ 编译目标对象** | 日志计数核对 | `docs/70:576-581` |
| npm 路径含空格 | `spawnSync/execFileSync(cmd, args, {shell:true})` 时命令串被 shell 拆词 ⇒ `'D:\Program' is not recognized…` | 本机 Node 装在 `D:\Program Files\nodejs\` | `tools/pack-core.mjs` 的 `materialize()` 与 `tools/fetch-koffi.mjs` 的 `run()` 对含空格的命令加引号。**注意**：加引号只解决"路径含空格"；若传的是裸名（不含空格），它由 shell 按 PATH 解析 ⇒ **真正的排查顺序是先看 npm 的真实 stderr，别急着改脚本** | 两个脚本在本机成功产出 | `.local-rules/current-machine.local.md:9-21` |
| 代理变量 | `pack-core` 跑 npm 时**静默卡住**（只有 `package.json`，`node_modules` 不生成），不报错也不退出 | 带失效的 `HTTPS_PROXY`（`127.0.0.1:7897` ECONNREFUSED）时 npm 静默卡；直连 `registry.npmmirror.com` 返回 200 | 跑 npm 相关脚本时**清空** `HTTPS_PROXY`/`HTTP_PROXY`/小写同名变量 | 判断依据：观察 `dist/core/work/dsh-core-*/node_modules` 是否出现 | `.local-rules/current-machine.local.md:25-40` |

### 4.8 工程方法与流程（最值得复用）

| # | 现象 | 根因 / 教训 | 处置 | 验证 | 详述 |
|---|---|---|---|---|---|
| 测错对象 | 断言绿了，但测的不是那个东西 | `assert-fs-search-fallback.mjs` 曾**写死旧版本路径** ⇒ 升级后断言**悄悄测旧树** | 改为读 `corerecipe.json` 的 `coreVersion`（唯一事实来源）| 改版本后断言跟着走 | `docs/70:719` |
| 测错坐标系 | 鲸鱼"歪"排查中从**整屏像素**猜位置，量到的是**窗口外**的桌面图标 | 需要 ArkUI 层级的权威坐标 | 用 `uitest dumpLayout` | 权威坐标：窗口从 x=357 起、`Shape` 盒在 `x[374..416]` | `docs/70:621`、`docs/70:720` |
| 统计前先定口径 | 事件清单因"按通用字段名 `type` 遍历"**虚增 4 种** | **多统计与统计错对象，比少统计更危险** | 定口径并写进文档 | — | `docs/70:722`、`docs/README.md:65-68` |
| 脚本化搬迁的头号坑 | 替换点在被删区间**之前** ⇒ 后面所有行号整体偏移 | — | 一次搬迁里的所有改动按**原始行号降序**施加（`E293`/`E318`/`E336` **三次**踩同一坑）| 搬迁后无错行 | `docs/70:724` |
| 升级手册"每一步都在挡某个东西" | 上一轮升到 `0.1.7-rc.1` **漏跑了「重生成上表」**⇒ 提交基线停在 rc.2 之前。后果**不是红灯**，而是**无法区分"新漂移"与"旧欠账"**（漂移报告 70 处，其中 58 处是上轮欠账）| — | 直接对比两份契约，发现"7 个被移除的端点"**在 rc.1 里就已经不存在** ⇒ 拆开新旧欠账 | 漂移报告能归因到具体一轮 | `docs/70:840-848`（`E383`）|
| 把顺序当依据 | 真机出现"装了 `0.1.7-rc.2` 却仍跑 rc.1" | `DshHost.start()` 在 `state.current` 为空时取 `installed[0]`，而 `listInstalled()` 返回 `fs.listFileSync()` 的**未定义顺序**；长期只有一棵核心树 ⇒ 恰好总是对的，文档还把它记成一条"设计"——**其实那是掩盖未定义行为** | 新增 `compareVersions()` + `newestVersion()`（纯函数，15 条比较 + 8 条选择单测）| rc.2 启动、且 rc.1 与 rc.2 **并存**（不再需要删旧树）| `docs/70:825-838`（`E383`）|
| 只做并集的合并 | `bundles` 的 `cur ∪ seed` 让任何 bundle 一旦进入就**再也去不掉** | 凡"合并"都要能表达"**移除**" | 引入显式移除清单 `dsh.profile.removeBundles`，口径改为「种子顺序并集 **−** 移除清单」| 真机读数：`profile bundles 已移除（按种子 removeBundles 清单）：…voice-input-bundle` | `docs/70:759-762`（`E378`）|
| "修半条链" | "禁 4 行插件"（半条链）≠"从 bundles 移除"（根因）| **修症状 ≠ 修根因**——要问"这个东西还**能从哪里被挂起来**" | 两处都改（profile patch + 打包期补丁 preset 文件），且 preset 补丁要**幂等** | 真机读数与 `removeBundles` 两处一致 | `docs/70:764-767` |
| 硬编码清单升级失效 | `GIT_SYMLINK_REPLICA` 只有 1 条而实际 **141** 条 | 硬编码清单会在升级时**静默失效** | 改为**从归档现读**（同类：平台别名表、preset 补丁标记）| 补齐条数等于归档内 symlink 条数 | `docs/70:780-784` |
| "文档说了、配置没做" | `docs/README.md` 的「清理与留档纪律」早就写着"临时过程产物一律只落 `dist/`（**已 gitignore**）"，而 `.gitignore` **从未包含 `dist/`** | 下一个人会按文档行事（以为不会误提交），直到某次 `git add -A` 把 500MB 中间产物带进去 | **修配置，不修文档措辞** | `.gitignore` 与实际边界一致 | `docs/70:786-791` |
| "快速分支"绕过功能路径 | `npx -v ✓` 没暴露 `DSH_HOME` 恒定缺失（`-v` 排在检查**之前**）；`pip3 --version` 被 `-V\|--version` 分支拦截去 echo banner（而 pip 本体无恙）| **版本探测 ≠ 功能路径探测** | 验收要靠**功能路径**的探针（`ls-remote`、`-m pip list`）| 两条都被功能路径探针抓住 | `docs/70:793-800` |
| 门禁在 Node 24 上失灵 | `check-fetch-shim.cjs` / `check-web-fetch-jitless.mjs` 自 spawn 子进程时给的 flag 在 Node 24.19.0 下无效 | `--no-experimental-fetch` 在 Node 22+ 已移除；门禁未把"子进程没产出断言汇总"归为环境受阻 | **已修（2026-09-28）**：`check-web-fetch-jitless.mjs` 改为**运行时探测可用 flag** + `pathToFileURL` 修掉 loader 路径（后者使 B 臂**从未跑成过**）；`check-fetch-shim.cjs` 同理修掉 flag 语义、禁用端口探针、取证引用时机三处缺陷，**并顺带挖出产品真 bug**（原生 `FormData` 被编成字面量）；见 §3.6 | 两条门禁均 **exit 0**（`check-web-fetch-jitless` A 臂 4/4 按预期失败、B 臂 8/8；`check-fetch-shim` 6 条 ok） | §3.6；`docs/parity-matrix.md:110` |
| 用户报"还是不对" | 同一个卸载残留行 bug **复现**：上批只修了"名字来源"、**漏了引号** | **别重做同一个修法，先换测量工具**；要问"**这条链上还有几个判据**" | 修法：`removeRowBlockById` **剥引号再比较** + 后缀匹配兜残局 | 五场景验证（正常 / 残局 / 不误伤 / 反向不串味 / npm 包回归）| `docs/70:744-752`、`docs/70:755-757` |
| 序列化改字面量 | 凡"写进去的和读出来的不是同一串"的地方都要单独验：YAML 自动加引号 ⇒ `m[1] === name` 永假 | 字符串比对会被格式噪声淹没（378 处差异），**语义比对**才看得出真差异（1 处） | 剥引号 + 语义级比对 | 五场景验证 | `docs/70:753-757` |

---

## 5. 交接时的最小检查单

改动前后各跑一遍，任一项不符即停：

```powershell
# ① 数据保全（先看，不要跳）
grep -n "install -r" tools/update-device.ps1            # 装机只有覆盖安装
grep -cn "uninstall" tools/update-device.ps1            # 期望：仅注释/自检模式串

# ② 门禁（AGENTS.md 清单，当前 16 项）
node tools/assert-cli-shim.mjs
node tools/assert-resfile-sync.mjs
node tools/check-parity.mjs
node tools/compat-drift.mjs
node tools/assert-exec-fix.mjs
node tools/assert-python-bridge.mjs
node tools/assert-fs-search-fallback.mjs

# ③ 结构性守卫（按改动面选跑，改 UI 跑前四个、改宿主跑后两个）
node tools/check-feature-wiring.mjs
node tools/check-dead-code.mjs
node tools/check-builder-recursion.mjs
node tools/check-dead-handlers.mjs
node tools/check-toolchain-sign.mjs
node tools/check-native-closure.mjs

# ④ 装机（唯一入口）+ 端侧验收
.\tools\update-device.ps1
powershell -NoProfile -File tools\device-acceptance.ps1

# ⑤ 端侧取证（两个日志文件都要拉）
hdc shell "grep -E 'BOOT_' .../files/node-output.log | tail -12"
hdc shell "grep -E 'exec 探测：' .../files/dshm-host.log | tail -1"   # 期望 7/7 全 ok
hdc shell "ls -la .../files/diag-*"
```

**结论怎么判**：

- 门禁有 `exit 3` 或"没跑成"的，**不算通过**，也不要写成通过（现有 `exit 3` 项见 §2.3）；
- 任何 ok → fail **当场修**，不许延后（§2.5）；
- 任何"我改了但它没生效"的现象，**先怀疑 §4.3 的"存在即跳过"缓存与版本标记**，再怀疑代码；
- 任何"进程不在、日志也空"的现象，**先读 `aa start` 的 Error Code**（§3.6），别从代码查起。

---

# 第六章 门禁体系与工程纪律

## 1. 为什么需要这一章：本项目的缺陷形态是"静默失效"

### 1.1 一句话

这个项目**不是**"编译能过就算完成"。它反复出现的缺陷形态是：

> **编译通过、界面无感、既有门禁全绿，但功能其实不对。**

`docs/70-鸿蒙移植踩坑与修复总览.md:802-812`（§8.2）把这一族缺陷命名为「**静默失效**家族」，并给出六种形态。
`docs/70` 的开篇进一步解释了它为什么在本项目格外致命：两条根本约束
（`jitless ⇒ WebAssembly === undefined`、**execve 受签名域管辖**）使得
"能跑 ≠ 跑通"（`docs/70-鸿蒙移植踩坑与修复总览.md:14-51`）。
一条链上任何一环被平台拒绝，症状都只在设备上出现，构建端一切正常。

### 1.2 四个真实例子（每个都发生过，且都不是"编译器能抓住"的）

| # | 例子 | 为什么既有的检查手段全都抓不住 | 证据 |
|---|---|---|---|
| ① | **改了补丁但设备没变**——`hostcore/app/main.js` 加了 `DSHM_PLATFORM=ohos`，只跑了 `pack-core --place-in-app`（放的是**核心 zip**），而**入口脚本要 `tools/place-host-app.mjs`** ⇒ 包内是旧脚本，凭据豁免在真机上**根本没生效** | 构建、装机、启动全都不报错。改的源文件"确实改了"，`git diff` 也对 | `docs/50-端侧核心运行架构.md:241`（E148）；同类更早一次见 `docs/device-validation.md:869-889`（门禁链漏跑 `place-host-app`，设备在跑拆除前的 `main.js`） |
| ② | **门禁只 print 不校验**——`tools/make-icon.py` 的"确认启动画面未改动"**只是一句 `print`**：把 `startIcon` 加进待写清单、文件被真实覆盖（**3577B → 59441B**）后，脚本**照样打印"（未改动）"**并 exit 0 | 它是"自检"的样子，有输出、有 ✓，没有任何失败路径 | `tools/make-icon.py:429-430`（注释里留了事故数值）；`docs/device-validation.md:4095-4112`（E-RV4） |
| ③ | **文档说了、配置没做**——`docs/README.md` 的「清理与留档纪律」早就写着"临时过程产物一律只落 `dist/`（**已 gitignore**）"，而根 `.gitignore` **当时只有两行**（`.git/`、`*.class`）——**`dist/` 从未被忽略** | 没有任何机制会让文档与配置对账。下一个人会按文档行事（以为不会误提交），直到某次 `git add -A` 把 500MB 中间产物带进去 | `docs/README.md:27-36`（E126 更正）；`.gitignore:7-11`（把这段教训写进了注释）；`docs/70-鸿蒙移植踩坑与修复总览.md:786-791` |
| ④ | **门禁报得对，但没人看得懂**——`tools/check-dead-handlers.mjs` 的旧判据报 **180 处**"空箭头函数体（跨行）"，逐条分拣后 **177 处是误报**（回调 prop 的**必需默认值**，ArkTS 组件若回调 prop 无默认值，父组件不传就编译失败），**2 处是真·死按钮** | 报 180 处 ⇒ 人不再逐条看 ⇒ 真问题淹没在噪声里。这就是"**假阳性比漏报更糟**" | `docs/device-validation.md:4472-4485`（E-DH1）；复现见图下 §3.2 |

### 1.3 推论：门禁不是"锦上添花"，它是这条路线上**唯一**能自动发现该类缺陷的手段

四例的共同点：**症状与成因之间隔着一次真机运行或一次人工分拣**。
构建器、类型系统、`codelinter` 都不会红（`docs/parity-matrix.md:104` 与 `:154` 记录过实测：
往 `appstate` 里填 `return a +;`，`codelinter` **一条都不报**，真编译器立刻 `BUILD FAILED`）。
所以本项目把"能自动化的判据"一律固化成 `tools/` 下的脚本，并给它接进必跑链。

### 1.4 本节验证方式

```bash
# ① 门禁链是否完整（AGENTS.md 规定的必跑清单 + 真机验收；**别写死条数**，见该文件）
grep -n "node tools/" AGENTS.md

# ② ②号例子：make-icon.py 的启动画面守卫现在是真断言还是 print
grep -n "brand-original" tools/make-icon.py        # 期望：逐字节比对（不再是 print）

# ③ ③号例子：文档与配置是否一致
grep -n "dist/" .gitignore                          # 期望：命中 /dist/

# ④ ④号例子：当前门禁报多少处（收紧后应为 0）
node tools/check-dead-handlers.mjs; echo "exit=$?"
```

---

## 2. 门禁清单

### 2.1 分类口径

| 类别 | 含义 | 判据 |
|---|---|---|
| **必跑（AGENTS.md）** | `AGENTS.md` 明文列出的回归链 | 任何改动后都要跑 |
| **本轮新增 / 本轮收紧** | 本轮（2026-09-27 收尾批）引入或改判据的门禁 | 按引入批次标注 |
| **环境受限（exit 3）** | **"没跑成"不是"通过"**——脚本以退出码 3 明确区分 | 见 §2.4 |
| **既有红项** | 本机/本环境下稳定非 0，且已在文档登记 | 见 §2.5，**不许写成通过** |

### 2.2 全量清单（`tools/assert-*.mjs` / `check-*.mjs` / `check-*.cjs`）

下表覆盖 `tools/` 下全部 `assert-*.mjs`（7 个）、`check-*.mjs`（19 个）、`check-*.cjs`（5 个），
以及与之同族的 `arch-check.mjs` / `compat-drift.mjs` / `neg-test-piai.mjs`。
**"是否必须绿"一列**取三值：**必须**（改动后即须为 0）、**条件**（只在特定改动面或特定设备上必须绿）、**否**（是审计/工具，不是门禁）。

#### 2.2.1 AGENTS.md 强制必跑（**当前 16 条** = 15 条 node + `device-acceptance.ps1`；下表只逐条解释了最早的 7 条）

| 文件名 | 守什么 | 触发条件 | 失败意味着什么 | 是否必须绿 |
|---|---|---|---|---|
| `assert-cli-shim.mjs` | `pnpm`/`npm`/`npx`/`dsh` **四个 CLI 假壳**：队列路径**生成期写死**（`${HOME_DIR}/install-queue`，不再运行时读 `$DSH_HOME`）、`--dir` 取值口径、等待上限、卸载走 `.rem` 队列 | 改 `hostcore/app/main.js` 的假壳段 | 模型在端侧跑 `pnpm add` / `dsh plugin remove` 会失败或**静默投递到错误目录**（曾实测 `$DSH_HOME` 恒空导致"缺少 DSH_HOME 环境变量"） | **必须** |
| `assert-resfile-sync.mjs` | `hostcore/app/**` 与 `entry/src/main/resources/resfile/resources/app/**` **逐字节一致** + `package.json` 语义锁（`main=main.js`、**无 `type` 字段** ⇒ CommonJS） | 改 `hostcore/app/**` 之后、build 之前 | **设备在跑旧代码**——快照失同步是静默的，build 忠实打包旧文件，全程零报错（真实事故见 `docs/device-validation.md:869-889`） | **必须** |
| `check-parity.mjs` | `docs/parity-matrix.md` 不能注水：**五条不变式** A 覆盖 / B 单调 / C 登记 / D 统计 / E 陈旧登记（`docs/parity-matrix.md:57-69`） | 改对等矩阵或能力面时 | 台账开始说谎（漏一行、整体 DONE 盖住某形态缺口、统计与实算不符）。**台账失效不会让构建失败**，只会慢慢不可信 | **必须** |
| `compat-drift.mjs` | 上游漂移：用 `protocol-contract.mjs` 的同一套提取逻辑对**当前环境的上游**重新生成端点表，与仓库里已提交的 `dshcompat/src/main/ets/Endpoints.ets` 逐条比对（新增/删除/形状/流式标记/参数名/id） | 每次上游升级；改 `dshcompat` | 端侧调用会收到 404 或 `gateway/arguments-invalid`，而**本机开发时看不出来** | **必须** |
| `assert-exec-fix.mjs` | exec 探测链（`probeExec` / `ensureExecutables` / rg wrapper）的结构与**语义锁**：`denied` 只映射 `EACCES`、`so-fail` 正则覆盖 musl+glibc、Phase 5 已拆的实验代码**不得复存** | 改 `hostcore/app/main.js` 的 exec 段 | "哪些原生件真的能执行"的判断失真 ⇒ 核心页与诊断读数一起说谎 | **必须** |
| `assert-python-bridge.mjs` | 内嵌 Python 桥（`entry/src/main/cpp/python_runner.cpp` + el1 `libpython` + `main.js` 自检 + 垫片文案）的结构锁，含 `pipMode` 不再生成 `-V\|--version` 分支 | 改 Python 桥或垫片 | `python3` / `pip3` 在端侧整条链不可用（长链中任一环被平台拒绝的表现都是"工具失败"） | **必须** |
| `assert-fs-search-fallback.mjs` | fs-search 降级 patch（rg 被拒 ⇒ 切 `find`/`grep`）的**三层防线**：结构（五个注入函数 + 两段替换 + 旧段已消失）、语法（`vm.SourceTextModule` 全文 ESM 解析）、行为（从注入块提纯函数跑参数转换 / 花括号展开 / NDJSON 转换） | 改 `pack-core.mjs` 的 `patchFsSearchFallback` 之后（须在 pack 之后跑） | `glob`/`grep` 工具恒 `SEARCH_FAILED`（曾是长期症状），而"Host 起来了、模型能回话"完全掩盖这条路径 | **必须** |

> `AGENTS.md` 另列 `.\tools\device-acceptance.ps1`（真机端侧验收）。它采集设备侧持久日志、各页面布局
> dump 与截图，生成报告骨架，并**自动判定 5 项可脚本化的读数**（设备在线 / 核心已启动并读出运行核心版本 /
> 客户端已接入 / 平台标识 = ohos / 本次启动后无异常退出，`tools/device-acceptance.ps1:237-244`）；
> **界面行为类项不做判定**，留给人按 `docs/50-端侧核心运行架构.md` §12.9 / §14 勾选。
> **因此它是"条件"而非"必须"**：没设备时它跑不了。用法与首跑踩到的坑见 §2.4。

> **本表只逐条解释了最早的 7 条**（2026-10-05 复核确认，避免读者把"表里没有"误读成"不必跑"）。
> 之后陆续加入的必跑项**未逐条进表**：`check-web-fetch-jitless.mjs`、`check-worker-jitless.mjs`、
> `check-internal-undici.mjs`、`check-skill-sync.cjs`，以及 2026-10-05 为 PTC 加的三条
> （`check-ptc-ts-strip.mjs` / `check-ptc-runtime-inproc.mjs` / `check-ptc-wiring.mjs`）。
> **权威清单与条数以 `AGENTS.md` 的「必跑的回归门禁」块为准**，本节不再复制一份会过期的名单。

#### 2.2.2 结构性守卫（按改动面选跑；全部 exit 0）

| 文件名 | 守什么 | 触发条件 | 失败意味着什么 | 是否必须绿 |
|---|---|---|---|---|
| `arch-check.mjs` | **上游接口细节不得泄漏出 `dshcompat`**（D5 §1 的核心可维护性主张）。含**剥注释**后匹配 + 内置注入式自检 | 每次改动（尤其新增端点/事件名） | 上游改个名字，症状只在设备上以"某功能莫名失效"出现，且极难定位（违反它**没有任何即时症状**） | **条件**（改 UI/协议层即必须） |
| `check-feature-wiring.mjs` | **功能接线回归**：对 18 个已实现功能检查"中枢实现 + **界面调用点**"是否都在；另有 **1 条反面规则**（`AppShell.ets` 里不许出现 `TrackPresentation.RAIL`） | 任何 UI 重构/搬迁 | **构建查不出"调用点被删"**——功能留着、入口被重构顺手删掉，编译照样通过（E135 的技能触发点缺失即此类） | **条件**（改 UI 即必须） |
| `check-builder-recursion.mjs` | 任何一个 `@Builder` 体内**不许出现自己的名字**（剥注释与字符串后判定） | 改任何 `@Builder` | 真机上 `RangeError: Stack overflow!` 直接杀进程；而静态读起来像"交回上层继续分派"（E343） | **条件**（改 UI 即必须） |
| `check-dead-code.mjs` | 搬迁留下的壳：零使用 **import / `@Builder` / 组件成员 / 门面字段**（四条规则） | 任何搬迁/拆分之后 | 死代码让下一个人以为"这里还在用"，并连带拖出级联死链（E345/E346/E346b/E367） | **条件**（做搬迁即必须） |
| `check-dead-handlers.mjs` | 空实现扫描：**只报"调用处内联空实现"**（`onX: () => { },` 写在组件构造参数里），不报回调 prop 的声明默认值 | 改 UI 组件 | 界面上有、点了没反应。旧判据报 180 处把信号淹了；现在有一份**带理由的豁免清单**（`tools/check-dead-handlers.mjs:101-103`） | **条件**（改 UI 即必须） |
| `check-design-tokens.mjs` | **棘轮门禁**：裸 `fontSize`/圆角/描边/颜色字面量**只许变少**（基线 `tools/design-token-baseline.json`） | 改 UI 样式 | 裸值继续进来，视觉一致性随时间退化。**刻意不做一刀切**：存量收敛会改变视觉、须真机验收 ⇒ 一刀切会立刻几百处红，而"永远红的门禁等于没有门禁"（`docs/parity-matrix.md:105`） | **条件**（改 UI 即必须） |
| `check-store-readiness.mjs` | 上架红线：不申请任何 `ohos.permission.kernel.*`（尤其 `ALLOW_WRITABLE_CODE_MEMORY`）、包名、设备类型覆盖 phone/tablet/2in1、**`--jitless` 必须留在 host argv 里** | 改 `module.json5` / `build-profile.json5` / host argv | 该权限在手机上**不可申请**，一旦出现在 `requestPermissions` 里，装机直接 `grant request permissions failed`，上架也就没了；且它是 `--jitless` 存在的**理由** | **条件**（改配置/启动参数即必须） |
| `check-native-closure.mjs` | 原生依赖闭包：**SONAME 必须等于文件名**（hvigor 只打扁平 `libs/<abi>/*`）、每个 `DT_NEEDED` 必须解析到同目录的库或已登记的系统库 | 改 `entry/libs/**` 或任何 `.so` | 失败只在设备上表现为一次不透明的 `dlopen` 失败（E44/E45 就是这一类） | **条件**（动原生库即必须） |
| `check-origin-fence.mjs` | WS 升级的 `Origin` 围栏：clean/absent/duplicated → 101；foreign → 403；no-cookie → 401（**起真 Host**） | 改连接层/载体 | 手机一条逻辑流都开不起来，且 ArkTS 侧把 403 报成极具误导性的 `error code=200` | **条件** |
| `check-plugin-toggle.mjs` | 插件启停：写 `$DSH_HOME/cordis.patch.yml` 后行状态**真的翻转**（**起真 Host**） | 改插件管理路径 | "启停"变成假功能（点了不生效），而界面看起来完全正常 | **条件** |
| `check-user-rows-preflight.cjs` | 用户插件行预检 + 启动失败自愈（坏行不拼进 profile；启动失败后**隔离**用户行文件而**不删数据**） | 改 `hostcore/app/dshm-user-rows.js` | 真机死锁事故的重演：坏用户行 ⇒ dsh loader 抛错 ⇒ Host fatal ⇒ 无 HTTP/python 桥、`home` 700 不可写 ⇒ **无外部恢复通道**（`docs/device-validation.md` 批次十一） | **条件** |
| `assert-report9-fixes.mjs` | 报告 9 的四项修复：**原生 `Headers`** 当输入、中文 body 长度**按字节**算、设置写入后 patch 保留非种子条目、托管块不累积 | 改 `fetch-shim.js` / `dshm-user-rows.js` | 真机 401 的触发形态回归；`models` 写入覆盖用户条目 | **条件** |
| `assert-speech-syntax.mjs` | 语音 provider 按 **ESM** 解析（`node --check` 默认按 CommonJS，**顶层重复 `const` 在 CJS 下不报错**）：顶层重复声明 / 引用常量有定义 / 括号配平 / 必需导出 | 改 `hostcore/speech-provider/index.js` | 重复的顶层 `const SEG_ATTEMPTS` 会导致整个插件 `failed to import` ⇒ 语音降级到 stub ⇒ 官方 UI 判 `usable=false` ⇒ **点按钮跳设置页**（表现为"功能失效"） | **条件** |
| `check-icon-assets.mjs` | 图标资源四项：`AppScope`↔`entry` 的 foreground/background **逐字节一致**、`startIcon.png`/`logo_dark.png` 必须与 `third_party/brand-original/` 一致、APP 图标体积在预期带 | 改任何图标资源 | 三类不一致**都不会让构建失败、也不会在运行时立刻报错**，只在"换个入口打开"或"看启动画面"时表现为奇怪的观感问题 | **条件**（改图标即必须） |
| `check-toolchain-sign.mjs` | 工具链自签名：两个归档目录里 `dshm-signed.txt` 存在 + 是 **"前缀+内容摘要"形态** + 摘要与归档**实际大小之和**自洽 | 跑完 `place-toolchain.mjs` 之后 | 端侧判"归档无标记" ⇒ 走"存在即跳过" ⇒ **重新签名过的归档不会被解包**（历史上"白签一场"的成因） | **条件**（改工具链即必须） |

#### 2.2.3 需要真 Host / 真模型 / 真设备（"条件"里最重的一类）

| 文件名 | 守什么 | 触发条件 | 失败意味着什么 | 是否必须绿 |
|---|---|---|---|---|
| `check-model-roundtrip.mjs` | **一次真实模型往返**：真起 Host → 铸 cookie → 读模型目录 → 建会话 → 开 mux → 等 assistant 消息落盘。跑的是**与设备同一份入口脚本、同一个 `ondevice` profile、同一组 jitless flag** | 改垫片 / 请求载荷 / 会话路径 | 结构检查与 stub 全过、但真实 SSE 流断掉——"一切都证明管道通了，没有一条证明提示真的到达模型并**经由本仓代码**回来"（脚本头注释） | **条件**（本机缺项见 §2.5） |
| `check-custom-api-discovery.mjs` | 自定义模型 API 保存链上的关键一环：**模型端点探测**（`llm/discoverModels`）。官方 `CustomProviderCard` 的 `ready` 判据含 `models.length > 0` | 改设置写路径 / 自定义 API | 探测失败 ⇒ 表单永远 `ready=false` ⇒ 用户看到的就是「自定义 API 保存不了」 | **条件** |
| `check-custom-api-save.mjs` | 「添加自定义模型 API」的**完整保存链**：新建 profile → 存密钥 → 逐字段编辑 → 改模型目录（**整值**） → 重启确认存活 → 删除。每步都**看 Host** 验证 | 改自定义 API / 设置写路径 | 界面看起来有入口但写不进 Host（曾经**根本没有这个入口**，见 `docs/parity-matrix.md` v1.31 变更记录） | **条件** |

#### 2.2.4 **本轮新增 / 本轮调整**的门禁

| 文件名 | 何时引入 / 收紧 | 一句话 |
|---|---|---|
| `check-icon-assets.mjs` | **批次三十一新增**（`docs/device-validation.md:4149-4153`） | 审查发现"图标有 4 处必须一致，但**此前没有任何门禁**" |
| `check-toolchain-sign.mjs` | **批次三十三新增**（`docs/device-validation.md:4330-4336`） | 工具链自签名被**静默跳过**（找不到宿主 python 时只打一行 ⚠ 就 `exit 0`）⇒ 真机 `exec 探测` 只有 **2/7** |
| `check-dead-code.mjs` | **批次三十四收紧判据**（`docs/device-validation.md:4458-4470`） | 修掉"把 import 块里的 `//` 注释当成符号名"的假阳性 |
| `check-dead-handlers.mjs` | **批次三十四收紧判据**（`docs/device-validation.md:4472-4515`） | 180 → 2 → 0；并补了两处自身缺陷（跨行声明形态漏判、只看"声明行之后"） |
| `assert-cli-shim.mjs` | **本轮修掉 5 条历史红断言**（`docs/70-鸿蒙移植踩坑与修复总览.md:802-814`、`tools/assert-cli-shim.mjs:17-23,51,65-73,83-87`） | 判据从"总数恰好是 N"改成"**每个**实体都满足" |
| `check-skill-sync.cjs` | **2026-09-28 新增**（P0-1；`hostcore/app/dshm-skills.js`） | 内置技能同步原先按**文件字节数**判等，`hdsh-*`→`dshm-*` 是**等长替换** ⇒ 大小完全不变 ⇒ 永远判成"同一份"，设备端停在旧端点。现按**内容 sha256** 判等，门禁含 A–H 八组，其中 C/D 组专测**等长改动**必被复制 / 必以源为准恢复 |
| `check-compat-exemption.cjs` | **2026-09-28 新增**（P1-3；`hostcore/app/dshm-compat.js`） | 兼容性豁免通道的失败模式**极其安静**（写错 profile 目录 / 文件名或 schema 偏离 / 版本写成 range / 假确认风险 ⇒ 上游**静默跳过**，界面只看到"授予成功"）。⇒ 判据不能是"文件写了没"，臂 B 直接用**上游自己的** `evaluatePluginCompatibility` 对比 `exempted` 是否真的翻转 |
| `check-doc-refs.mjs` | **2026-09-28 新增**（文档引用门禁） | `docs/` 内的「文件:行号」引用要落在它声称的那一节上。首版判据把**任何两位数字 + 冒号**当引用目标 ⇒ 395 条里 188 处报错几乎全是时间戳（`` `14:11:07.000` ``）、IP 片段（`192.168.1.50:3111`）、代码行号（`main.js:1139`）；收紧为**短式必须带 `docs/` 前缀**后 ⇒ 真问题 **0 处**；此后长期读数**恒为 0 问题**，引用总数随文档增改漂移（2026-09-28 首版为 **188 条 / 19 个文档**；**2026-09-30 为 247 条 / 21 个文档**）。判据以当场实跑为准 |
| `audit-unused-exports.mjs` / `neg-test-piai.mjs` | **审计/负测试，不是门禁** | 前者报"实现了但没接"的候选清单；后者是**一次性的负测试脚本**（见 §5.3 的"用完即删"讨论） |
| **（本章新增记录）** `check-layout-fixtures.mjs` 的"环境受限"**已解除** | **本章实测 + 2026-09-30 根治** | 不是缺 CLT，而是 `findTsc()` 只认 Linux 布局；当时用 junction 暴露 Windows 上的 `typescript` 后 **exit 0 / 768 条断言**。**2026-09-30 已把 Windows 回退写进脚本本身**（候选列表照抄 `tools/check-arkts-entry.mjs:49-59`：env → Linux 既定位置 → `<IDE>\tools\hvigor\{hvigor,hvigor-ohos-plugin}\...\typescript` → `<IDE>\tools\ohpm\...\typescript` → 仓库 `node_modules`），**不再需要外部 junction**。⇒ 它**从来不是盲区**（见 §2.4） |

### 2.3 分类小结

- **AGENTS.md 明文必跑：15 条 node + 真机 `device-acceptance.ps1`**（权威清单始终是 `AGENTS.md` 的
  「必跑的回归门禁」块；本条**不再钉行号**——2026-10-05 复核时发现旧写法把 `AGENTS.md` 写死，
  清单每加一条就过期一次，而审核方无法分辨"过期"与"漏写"）。
- **本轮新增：5 条**——`check-icon-assets`、`check-toolchain-sign`（更早批次），以及 2026-09-28 收尾批的
  `check-skill-sync.cjs`（P0-1）、`check-compat-exemption.cjs`（P1-3）、`check-doc-refs.mjs`（文档引用）；
  **本轮收紧判据：3 条**（`check-dead-code`、`check-dead-handlers`，以及 `check-dshm-installer.cjs` 的两处陈旧断言重写）。
- **环境受限（exit 3）：0 条**——**已清零**。`check-layout-fixtures.mjs` 的 exit 3 与
  `check-arkts-entry.mjs` 的 exit 3 **同属一类脚本缺陷（Windows 布局未支持）**：
  前者已于 **2026-09-30** 修掉（`findTsc()` 补上 Windows IDE 自带 `typescript` 的候选路径，写法照抄
  `tools/check-arkts-entry.mjs:49-59`）⇒ **现 exit 0 / 768 条断言**，且**不再需要外部 junction**（§2.4）。
- **既有红项：1 条**——`check-model-roundtrip.mjs`（本机缺 koffi / 需真 Host）。
  `neg-test-piai.mjs` 原为**级联红**（依赖 `check-layout-fixtures` 的 exit 3），随之上绿。
  `check-dshm-installer.cjs`、`check-arkts-entry.mjs`、`check-fetch-shim.cjs`、
  `check-web-fetch-jitless.mjs` 四条**已修至绿**（§2.5）。
- **本机全量实跑退出码分布（2026-09-30 重测，23 条）：`22×0 / 1×1`**（旧记的
  `20×0 / 1×3 / 2×1`、`23×0 / 2×3 / 7×1` 均已过期）。

### 2.4 环境受限：`exit 3` = **没跑成，不是通过**

项目约定（写在脚本头里，可复跑核对）：

```bash
grep -n "exit code\|退出码" tools/check-arkts-entry.mjs tools/check-layout-fixtures.mjs \
        tools/check-design-tokens.mjs tools/check-toolchain-sign.mjs tools/check-web-fetch-jitless.mjs
```

| 脚本 | 本机读数 | 缺什么 | 脚本自己怎么说 |
|---|---|---|---|
| `check-arkts-entry.mjs` | ~~**exit 3**~~ ⇒ **exit 0（2026-09-28 已修）** | 当时"缺 CLT"只是**表象**：CLT 本机就在 `<IDE>\tools`，真正的阻断是脚本里**四处 Linux 布局写死**（见本节下方实测） | 退出码语义写在头注释 `tools/check-arkts-entry.mjs:7`（"3 = **环境受阻**（找不到 CLT / SDK / JDK）…**不把'没跑成'说成'通过'**"），运行期提示在 `:108` |
| `check-layout-fixtures.mjs` | **exit 3** | 找不到 CLT 自带的 `tsc` | 头注释 `tools/check-layout-fixtures.mjs:11`；运行期提示 `:108-109`（"⚠️ 这是'没跑成'，不是'通过'——退出码 3。"） |

**实测（本章新增，重要）**：exit 3 的**直接原因**不是"本机没有 DevEco"，
而是**脚本里的 CLT 布局假定是按 Linux 写的**。本机装了 DevEco Studio
（`C:\Program Files\Huawei\DevEco Studio`），其 `<IDE>\tools` **就是一个可用的 CLT 根**
（`<IDE>\tools\hvigor\bin\hvigorw.js` 存在，`Test-Path` = True）：

```powershell
$env:DEVECO_CLI_CLT_PATH = "C:\Program Files\Huawei\DevEco Studio\tools"
Test-Path "$env:DEVECO_CLI_CLT_PATH\hvigor\bin\hvigorw.js"   # True ⇒ CLT 找到了
node tools/check-layout-fixtures.mjs; echo "exit=$?"          # 仍 3，但原因换了一条
#   环境受阻：找不到 tsc（DevEco CLT 自带的 typescript）。
```

⇒ 第一层（CLT 根）已经过关，**卡在第二层：Windows 的 DevEco 没有 `codelinter/typescript` 这个布局**。
`tsc` 实际藏在：

```
C:\Program Files\Huawei\DevEco Studio\tools\hvigor\hvigor\node_modules\typescript\bin\tsc
C:\Program Files\Huawei\DevEco Studio\tools\ohpm\node_modules\typescript\bin\tsc
```

而脚本只找 `<CLT>/codelinter/node_modules/typescript/bin/tsc`
（`tools/check-layout-fixtures.mjs` 的 `findTsc()`）与一个 Linux 绝对路径。
用**目录联接（junction）**把前者指向实际的 `typescript` 之后，**门禁完整跑通**：

```
断言 768 条，失败 0 条。
✅ 四形态 fixture 与边界全部符合预期。
exit=0
```

> **⚠️ 2026-09-30 根治**：下面的 junction 只是**当时的绕过手段**，它把"脚本缺陷"留在了脚本里
> （要求每个新机器先手工建联接，否则永远 exit 3）。现已把候选列表写进 `findTsc()` 本身
> （env → Linux 既定位置 → `<IDE>\tools\hvigor\{hvigor,hvigor-ohos-plugin}\...\typescript`
> → `<IDE>\tools\ohpm\...\typescript` → 仓库 `node_modules`），**写法照抄同族的
> `tools/check-arkts-entry.mjs:49-59`**；找不到仍 exit 3，不静默回退。
> ⇒ **现在直接 `node tools/check-layout-fixtures.mjs` 即 exit 0 / 768 条断言，无需任何 shim。**
> 下面的复现块保留作**历史取证**（它是"这条从来不是环境限制"的证据）。

```powershell
# 复现（shim 落在 dist/ 下，随 dist/ 一起被忽略；用完即删）
$shim = "$PWD\dist\clt-shim"
New-Item -ItemType Directory -Force -Path "$shim\codelinter\node_modules" | Out-Null
cmd /c mklink /J "$shim\codelinter\node_modules\typescript" `
      "C:\Program Files\Huawei\DevEco Studio\tools\hvigor\hvigor\node_modules\typescript"
$env:DEVECO_CLI_CLT_PATH = $shim
node tools/check-layout-fixtures.mjs; echo "exit=$?"     # 期望 0，768 条断言
node tools/check-layout-fixtures.mjs --self-test; echo "exit=$?"
Remove-Item -Recurse -Force $shim                         # 用完即删（AGENTS.md:81）
```

**同一改动还解锁了两个级联红项**：

| 脚本 | 解锁前 | 解锁后 |
|---|---|---|
| `check-layout-fixtures.mjs` | exit 3 | **exit 0**（768 条断言 / 0 失败） |
| `check-layout-fixtures.mjs --self-test` | exit 3 | **exit 0**（769 条，注入的失败被如实报出） |
| `neg-test-piai.mjs` | exit 1（四个变异全 `(no summary)`） | **exit 0**（"负测试总体：全部按预期（新断言确实会红）"） |

⇒ **`docs/parity-matrix.md` 曾把这两个门禁记为"盲区"这件事，本身是可以消除的**；
它不是"本机能力不足"，而是**脚本的 CLT 路径解析只认 Linux 布局**。
这是一条值得记的教训：**"环境受限"这四个字要先验证**，
否则它会把"可修的脚本缺陷"永久正当化成"客观限制"。
（2026-09-30 复核：这条教训当时**只落实了一半** —— 绕过手段进了文档，缺陷留在脚本里，
直到本节补上候选列表才算真的修完。**"文档能跑通"与"脚本自己能跑通"是两件事。**）

**`check-arkts-entry.mjs` 的门禁（同样只认 Linux 布局）——2026-09-28 已修，本机实跑通过。**

> 下面保留修前的取证与判断（它们是"为什么这条建议可信"的依据），
> 修法写在取证之后，**实测读数也一并落在这里**，不另开一节。

它是**多处 Windows 不兼容**叠加（修前形态）：

1. `join(clt,'tool','node','bin','node')`（`tools/check-arkts-entry.mjs:119`）——Linux 布局；
   Windows 上是 `<IDE>\tools\node\node.exe`，且**必须带 `.exe`**：
   `execFileSync` 在 Windows 上不会为无扩展名的路径补 `.exe`
   （本章实测：`spawnSync <shim>/tool/node/bin/node ENOENT`，
   换成显式 `node.exe` 立刻成功）。
2. `JAVA_HOME` 默认值写死 `/home/node/jdk/jdk-17.0.20.1+1`（`:111`）——Linux 路径；
   不设 `JAVA_HOME` 时 exit 3（提示语会说"找不到 JDK"）。
   设成 `<IDE>\jbr` 后能越过这一关，但随后**仍然失败**：

```
❌ 没拿到结论行（hvigor 可能没跑起来）。**不得当作通过**。
```

  且 `dist/arkts-entry/compile.log` **长度为 0** —— 说明子进程**根本没起来**，
   而不是"起来了但没说结论"。这正是**判定器的强项**：它没有把"空输出"当通过
   （`classify()` 对"输出里什么都没有"显式返回 `inconclusive`，
   `--self-test` 的 9 个样例里就有这一条，见 §4.3 的样例表）。

⇒ **`check-arkts-entry.mjs` 的 Windows 支持是一处真实的、可修的脚本缺陷**。
修法（**2026-09-28 已落**）：
`nodeBin` 与 `javaHome`（以及另外两处同族写死）都改为**按平台/候选列表解析**，
并**在找不到时仍 exit 3**（不要静默回退）——与 `place-toolchain.mjs` 的 `findHostPython()`
（`DSHM_HOST_PYTHON` → 项目自带 → PATH）是同一套写法。

**修的时候另外发现两处本章未记载的写死**，它们叠在一起才是"设了 JAVA_HOME 也起不来"的完整原因：

3. `DEVECO_SDK_HOME = join(clt,'sdk')`（`:194`）——同样是 Linux 布局；
   Windows 上是 `<IDE>\sdk`（`<CLT>` 已经是 `<IDE>\tools`，所以是 `join(clt,'..','sdk')`）。
4. `PATH: \`${join(javaHome,'bin')}:${process.env.PATH||''}\``（`:196`）——分隔符写死 `:`。
   Windows 的 PATH 分隔符是 `;`，拼出来的整段会被当成**一个**目录名 ⇒ `java` 找不到，
   报的是 `spawn java ENOENT`（**与本机跑基线构建时未设 JAVA_HOME 踩的
   `Error Code: 00308018 / spawn java ENOENT` 是同一个坑**），
   与"这台机器没有 JDK"完全无关，极易误判。改用 `node:path` 的 `delimiter`。

**为什么这条纪律重要**：`check-arkts-entry.mjs` 的判定器本身**已经过注入验证**
（`--self-test` 9 个样例全过，含"hvigor 失败却退出码 0"的真实形态）。
它的**判定逻辑是可信的**，不可信的只是"本机没有可用的编译器路径"。
把 exit 3 写成"通过"，等于宣称 entry 层 ArkTS 编译正确——**这一层在本机从未被验证过**。

**这条门禁恰好守的是本次改动所在的目录**（`entry/src/main/ets`，即 `Index.ets` 与全部 Pane）。
它长期 exit 3，意味着 P1~P3 的 UI 改动在本机**从未被真编译器验证过**，而
"exit 3 环境受限"这句话很容易被读成"客观限制、没办法"——正是 §2.4 开头那条教训
（**"环境受限"这四个字要先验证**）的同一个形态，只不过第一次记的是
`check-layout-fixtures.mjs`，第二次才是它。

**修后实测（本机 Windows / Node v24.19.0）**：

```
# node tools/check-arkts-entry.mjs
模块 entry · CLT C:\Program Files\Huawei\DevEco Studio\tools
✅ entry 的 ArkTS 编译通过（0 error）。
   完整日志：dist/arkts-entry/compile.log
exit=0

# dist/arkts-entry/compile.log 里有两行真证据（不再是 0 字节）
Finished :entry:default@CompileArkTS... after 4 s 801 ms
BUILD SUCCESSFUL in 8 s 77 ms

# 判定器自检未被动到
# node tools/check-arkts-entry.mjs --self-test  ⇒ 9 个样例全过，exit=0
```

⇒ **`docs/parity-matrix.md` 里"entry 应用模块的 ArkTS 编译要看环境"这条，在 Windows 上不再成立**。

```bash
# 复现：本机两条 exit 3（修前形态）
node tools/check-arkts-entry.mjs;    echo "exit=$?"   # 修前 3；**修后 0**
node tools/check-layout-fixtures.mjs; echo "exit=$?"   # 修前 3；**2026-09-30 修后 0（不需要 shim）**

# 判定器自检仍可跑（证明"红"不是因为检测器坏了）
node tools/check-arkts-entry.mjs --self-test; echo "exit=$?"   # 0，9 个样例

# ── 解除 check-layout-fixtures 的环境受限（本章实测有效）────────────────
$clt = "C:\Program Files\Huawei\DevEco Studio\tools"
Test-Path "$clt\hvigor\bin\hvigorw.js"                        # True ⇒ 这是个可用的 CLT 根
Test-Path "$clt\codelinter\node_modules\typescript\bin\tsc"   # False ⇒ 脚本期望的路径不存在
Test-Path "$clt\hvigor\hvigor\node_modules\typescript\bin\tsc" # True ⇒ tsc 实际在这

$shim = "$PWD\dist\clt-shim"
New-Item -ItemType Directory -Force -Path "$shim\codelinter\node_modules" | Out-Null
cmd /c mklink /J "$shim\codelinter\node_modules\typescript" `
      "$clt\hvigor\hvigor\node_modules\typescript"
$env:DEVECO_CLI_CLT_PATH = $shim
node tools/check-layout-fixtures.mjs;             echo "exit=$?"   # 0，768 条断言
node tools/check-layout-fixtures.mjs --self-test; echo "exit=$?"   # 0，769 条（注入的失败被报出）
node tools/neg-test-piai.mjs;                     echo "exit=$?"   # 0，四个变异全红后还原回绿
Remove-Item -Recurse -Force $shim                                    # 用完即删（AGENTS.md:81）

# ── check-arkts-entry：修前 exit 3 / 设了 JAVA_HOME 后 exit 1，2026-09-28 已修 ──
# 修前形态（留证）：
#   $env:JAVA_HOME = "C:\Program Files\Huawei\DevEco Studio\jbr"
#   node tools/check-arkts-entry.mjs; echo "exit=$?"     # 1（注意：不再是 3！）
#   #   ❌ 没拿到结论行（hvigor 可能没跑起来）。**不得当作通过**。
#   Get-Item dist\arkts-entry\compile.log | Select-Object Length
#   #   Length = 0 ⇒ 子进程根本没起来（不是"起来了没说结论"）
#   #   根因：脚本按 Linux 布局找 node（<CLT>/tool/node/bin/node），且 Windows 上
#   #   execFileSync 不会为无扩展名路径补 .exe；另有两处：DEVECO_SDK_HOME 与 PATH 分隔符
# 修后形态（同一条命令，不需要任何环境变量）：
node tools/check-arkts-entry.mjs; echo "exit=$?"     # 0（真实编译：CompileArkTS + BUILD SUCCESSFUL）
```

### 2.5 既有红项（如实登记，不许改写成通过）

本机（Windows / Node **v24.19.0**）全量实跑读数（2026-09-27 首测；其中 `check-arkts-entry.mjs`、`check-web-fetch-jitless.mjs`、`check-fetch-shim.cjs` 三条已于 **2026-09-28** 查明并修掉，见 §2.4 / §2.5 下方坑表 / §3.6）：

| 脚本 | exit | 实测原因 | 属"环境"还是"真回归" |
|---|---|---|---|
| `check-arkts-entry.mjs` | **3 → 0（2026-09-28 已修）** | 原因**不是**"缺 DevEco CLT"：CLT 本机就在 `<IDE>\tools`。**实测真实原因是四处 Linux 布局假定**（`tool/node/bin/node` 缺 `.exe`、`JAVA_HOME` 默认值、`DEVECO_SDK_HOME=join(clt,'sdk')`、`PATH` 用 `:` 而非 `delimiter`），见 §2.4。修后 exit 0，日志里有 `CompileArkTS` + `BUILD SUCCESSFUL` | 环境（**可修的脚本缺陷，已修**） |
| `check-layout-fixtures.mjs` | **3 → 0（2026-09-30 已修）** | 缺 CLT 自带 tsc —— 与 `check-arkts-entry.mjs` **同属一类脚本缺陷**（CLT 路径只认 Linux 布局）。当时用 junction 暴露 `<IDE>\tools\hvigor\hvigor\node_modules\typescript` 后可跑通（768 条断言 / 0 失败）；**2026-09-30 已把候选列表写进 `findTsc()`**（env → Linux 既定位置 → `<IDE>\tools\hvigor\{hvigor,hvigor-ohos-plugin}\...\typescript` → `<IDE>\tools\ohpm\...\typescript` → 仓库 `node_modules`，写法照抄 `tools/check-arkts-entry.mjs:49-59`）⇒ **不需任何 shim 即 exit 0**，见 §2.4 | 环境（**可修的脚本缺陷，已修**） |
| `check-fetch-shim.cjs` | **1 → 0（2026-09-28 已修）** | 修前：需 `node --jitless --no-experimental-fetch`，而该 flag **在 Node 22+ 已被移除**。不带 flag 直跑则第一句断言就失败（`AssertionError: 原生 fetch 竟然可用…`）。**但真因不止于此**：① 前提建在错误的 flag 语义上；② 取证探针打在 `127.0.0.1:9`（**fetch 规范禁用端口，入口即返回 `bad port`**）⇒ 探不出 WASM 因果；③ 取证引用在装垫片**之后**才取 ⇒ 探的是自己。修后 exit 0，且**修的过程挖出一个产品真 bug**（原生 `FormData` 被编成字面量 `"[object FormData]"`，见 §3.6 末段） | **脚本缺陷（已修），且原先那个"环境"标签掩盖了产品真 bug** |
| `check-web-fetch-jitless.mjs` | **1 → 0（2026-09-28 已修）** | 原先判成"环境"：它用 `process.execPath` 起子进程并传 `FLAGS = ['--jitless','--no-experimental-fetch']`（`tools/check-web-fetch-jitless.mjs:308`）⇒ 子进程启动即失败，两臂都"没有产出断言汇总"。**真因不是环境，是两处硬缺陷**：① 该 flag 的**否定形态**在 Node 24 无效 ⇒ **两臂同时哑火**；② loader 传**裸盘符路径** ⇒ 默认 ESM 加载器拒收（`ERR_UNSUPPORTED_ESM_URL_SCHEME`）⇒ **B 臂从未跑成过**。修后 A 臂 4/4 按预期失败、B 臂 8/8 全过（见 §3.6） | **脚本缺陷（已修）** |
| `check-dshm-installer.cjs` | **1 → 0（2026-09-28 已修）** | 两处叠加：① `[FAIL] package.json top-level row only -- {"debug":"4.3.4"}`，而断言期望 `^4.3.4`（`tools/check-dshm-installer.cjs:102`）⇒ **语义前缀期望已漂移**；② 随后 `ENOENT: ...profiles/ondevice/.dshm-plugin-rows.yml`（`:104`）——该门禁仍在断言 `appendUserRow` 写用户行，**而该函数已于 2026-09-25 有意删除**（`tools/assert-cli-shim.mjs:110-111` 正是在锁"不再写用户行"）。两处已重写并补 P1-2 双向用例（5a/5b/5c），现 `RESULT: 43 passed, 0 failed`、exit 0（2026-09-28 修后为 24 passed；**2026-09-29 随 GitHub→npm 回退与 monorepo 子包判定用例新增 19 例**） | **门禁设计失配**（已修：两条门禁曾对同一件事的方向相反） |
| `check-model-roundtrip.mjs` | **1（环境依赖，已定性）** | 本机两次运行得到**两种不同**失败：① `FAIL: session/page -> 0 connect ECONNREFUSED 127.0.0.1:3252`；② `assistant (none after 150485ms)`，mux 帧里 `turn/end reason=error`：`Cannot find the native Koffi module; did you bundle it correctly?` | **环境（2026-10-05 复核定论）**：koffi 是 HAP 专属（自编 `libkoffi.so` 放 `entry/libs/arm64/`），本机 PC 侧离线跑必然缺它；**2026-10-05 复跑只复现第 ② 种**（第 ① 种已不复现），`--no-prompt` **exit 0** ⇒ 在无 koffi 的机器上这就是**正确跑法**，不该记成"仓库有缺陷" |
| `neg-test-piai.mjs` | **1 → 0（2026-09-30 随上游解除）** | 依赖 `check-layout-fixtures.mjs`，后者 exit 3 ⇒ 四个变异全部 `[A]/[B]/[C]/[D] FAIL — (no summary)`。`findTsc()` 修好后：**exit 0**，"负测试总体：全部按预期（新断言确实会红）"——**现在不需要 junction 也不需要 `DEVECO_CLI_CLT_PATH`** | 环境（**级联，已随根因修掉**） |
| `scan-core-plugins.mjs` | **1 → 修（2026-09-28）** | 原：`FATAL: no node_modules under dist\core\work\dsh-core-0.1.5-rc.2`——**默认 coreDir 写死旧版本**（`tools/scan-core-plugins.mjs:20`），而当前核心树是 `0.2.0-rc.1`。**已改为读 recipe**：`join(ROOT,'dist','core','work', \`dsh-core-${RECIPE.coreVersion}\`)` | **脚本硬编码版本**（与 `check-fs-search-fallback` 曾经"写死旧版本路径"同型，见 `docs/70-鸿蒙移植踩坑与修复总览.md:795`）。2026-09-28 收尾清理一并修掉（本章 §5.3） |

> **读这张表的方式**：`exit 3` 与上表前四项，都已在 `docs/device-validation.md:4423-4435` 登记为
> "环境不足 / 需特定 flag"。**`check-dshm-installer.cjs` 的两处陈旧断言已于 2026-09-28 重写**，
> 其语义前缀漂移（期望 `^4.3.4` 而实现写 `4.3.4`）与"断言 `appendUserRow` 写用户行"都已成为历史；
> 它此前**自首次提交起就一直是红的**（两条门禁曾对同一件事方向相反），现 exit 0。
> **【2026-10-05 结案】`check-model-roundtrip.mjs` 的"待查"到此为止**：复跑只复现 koffi 缺失那一种
> （`Cannot find the native Koffi module…`），属**环境缺件**；`--no-prompt` **exit 0**。
> 同一次普查把仓库 **43 个门禁脚本**逐个跑完：**42 exit 0 / 1 exit 1**（就是这一条，且已定性为环境）。
> 那张"红项定性表"里其余条目都是历史记录，保留原样。

```bash
# 一键复现本节的退出码分布（2026-09-30 重测，本机实测：22×0 / 1×1）
foreach ($g in @('arch-check.mjs','assert-cli-shim.mjs','assert-resfile-sync.mjs','check-parity.mjs',
                 'compat-drift.mjs','assert-exec-fix.mjs','assert-python-bridge.mjs',
                 'assert-fs-search-fallback.mjs','check-dead-code.mjs','check-dead-handlers.mjs',
                 'check-icon-assets.mjs','check-toolchain-sign.mjs','check-arkts-entry.mjs',
                 'check-layout-fixtures.mjs','check-fetch-shim.cjs','check-model-roundtrip.mjs',
                 'check-dshm-installer.cjs','check-web-fetch-jitless.mjs','neg-test-piai.mjs',
                 'scan-core-plugins.mjs','check-skill-sync.cjs','check-compat-exemption.cjs',
                 'check-doc-refs.mjs')) {
  $null = & node "tools/$g" 2>&1; "  {0,-32} exit={1}" -f $g, $LASTEXITCODE
}

# Node 版本是"环境"还是"回归"的分水岭：这条命令必须失败才算环境问题
node --no-experimental-fetch -e "0" 2>&1 | Select-Object -First 1   # 期望：invalid negation
```

---

## 3. 门禁的自我要求（本章最有价值的一节）

一个门禁**本身**也可能是坏的。本项目对门禁提出了四条硬要求，
每一条都对应一次真实事故。

### 3.1 要求一：门禁必须**在已知坏版本上红过**，才算门禁

**道理**：用人工注入的样例能过，只证明"检测器会匹配我写的样例"，
**不能**证明"它会命中真实的那行代码"。前者是自证，后者才是归真。

**做法（E344）**：把坏版本从历史里取出 → 用**同一个检测器**扫 → 必须命中。
为此检测器要导出 `scanText()`，而不只在 `main()` 里跑
（`docs/70-鸿蒙移植踩坑与修复总览.md:737-742`、`docs/50-端侧核心运行架构.md:2078`）。

已做过归真验证的三处（文档登记）：`check-builder-recursion`（命中 `MainShell.ets:380`）、
`check-dead-code`（对修前 `SettingsPane` 命中 5 处）、`check-feature-wiring`（对修前 `HEAD` 命中 `AppShell.ets:228`）。

**本章实测**：`check-builder-recursion.mjs` 确实导出了 `scanText`
（`tools/check-builder-recursion.mjs:154`），`check-dead-code.mjs` 同样（`tools/check-dead-code.mjs:278`）。
注入式负测试可复跑：

```bash
# 把当前的兜底渲染换回 E343 的自递归形态，检测器必须命中
node -e "
const fs=require('fs');
(async()=>{
  const m=await import('./tools/check-builder-recursion.mjs');
  const cur=fs.readFileSync('entry/src/main/ets/view/shell/MainShell.ets','utf8');
  console.log('改前:', JSON.stringify(m.scanText(cur).violations));
  const bad=cur.replace('TabContentView({ f: this.f.tabFacade, compact: this.compact })',
                         'this.mainContent(this.compact)');
  console.log('改后:', JSON.stringify(m.scanText(bad).violations));
})();
"
# 期望：改前 [] ；改后 命中 1 处，名字 mainContent
```

**⚠️ 但这条纪律有一个正在失效的前提：被取的"已知坏版本"必须还在。**

归真验证的取版本手段是 `git show HEAD:<file>`。**本仓根目录不是 git 仓库**：

```bash
git rev-parse --show-toplevel     # exit 128：fatal: not a git repository
Test-Path .git                     # False
```

唯一的历史版本载体是 **`.codegenie/.git`**——一个把 `worktree` 指向仓库根的 git 目录
（`.codegenie/.git/config` 里 `worktree = <仓库工作区>`），
只有 **3 个提交，全部停在 2026-09-21**（`.codegenie/.git/logs/HEAD`）。
用 `GIT_DIR` + `GIT_WORK_TREE` 显式指向它才能读：

```bash
$env:GIT_DIR="$PWD\.codegenie\.git"; $env:GIT_WORK_TREE="$PWD"
git log --oneline                 # 3 条，最新 61f6ab7，日期 2026-09-21
git show HEAD:entry/src/main/ets/view/shell/MainShell.ets | Select-String "this\.mainContent\("
```

**实测结论（重要）**：直接对 `HEAD:MainShell.ets` 跑同一检测器，**命中 0 处**——

```
HEAD(归真): builders=1 violations=0
```

原因不是检测器坏了（同一检测器对**当前文件注入自递归后命中 1 处**），
而是 **HEAD 已经包含 E343 的修复**（该文件第 430 行已是
`TabContentView({ f: this.f.tabFacade, compact: this.compact })`，
第 435 行的 `this.mainContent(this.compact)` 在 `build()` 里，是**合法调用**）。
`docs/50` E344 里记的那条命令（"`git show HEAD:…MainShell.ets` → 命中 1 处（`mainContent`，行 380）"）
**现在跑不出命中**——因为 HEAD 已经前进（或该项目当时指的是另一个 HEAD）。

⇒ **可复用的结论**：归真验证是"**对一个具体提交**"的验证，**不是一个可以无限复用的命令**。
写下归真记录时，必须同时写下**被验证的那个提交 id**；否则下一个人跑同一条命令会得到 0 命中，
并误判"门禁失效"或"修复被回滚"。

```bash
# 复核上述结论（两行都要看）
$env:GIT_DIR="$PWD\.codegenie\.git"; $env:GIT_WORK_TREE="$PWD"
git rev-parse HEAD                                    # 期望 61f6ab7…（2026-09-21）
git show HEAD:entry/src/main/ets/view/shell/MainShell.ets |
  Select-String "TabContentView\(\{ f: this\.f\.tabFacade"   # 期望命中 ⇒ HEAD 已含修复
```

### 3.2 要求二：**假阳性比漏报更糟**

**道理**：门禁的价值来自"**红 = 真的有问题**"这个信任。
一旦报告量超过人能逐条看的上限，人就不再逐条看了——真问题会安静地躺在噪声里。
`tools/check-dead-handlers.mjs` 的头注释自己写着"**假阳性比漏报更糟**"。

**真实案例（E-DH1）**：旧判据报"所有跨行空箭头"，报出 **180 处**，
其中 **177 处是误报**（回调 prop 的必需默认值），**2 处是真·死按钮**。

**本章实测复现**：从 `.codegenie/.git` 取出**收紧前**的检测器（`HEAD:tools/check-dead-handlers.mjs`，
该版本不含 `isPropDefault` 与 `ALLOW`），对**当前树**跑：

```
死按钮扫描：发现 185 处空实现（需逐条判断：空实现常常就是"点了没反应"）
  entry/src/main/ets/view/ChoiceSheet.ets:39  [空箭头函数体（跨行）]  onPick: (value: string) => void = () => {
  entry/src/main/ets/view/ChoiceSheet.ets:42  [空箭头函数体（跨行）]  onCancel: () => void = () => {
  entry/src/main/ets/view/CommandList.ets:29  [空箭头函数体（跨行）]  onRun: (command: CommandCandidate) => void = () => {
```

**185 vs 文档记的 180**：差异来自树本身在本轮又改动过（该快照是 2026-09-21）；
两者同量级，**都印证"报告量会淹没信号"**。收紧后的当前版本对同一棵树报 **0 处**：

```
死按钮扫描：未发现空实现（范围 entry/src/main/ets, platform/src/main/ets）
```

**收紧后的判据**（`tools/check-dead-handlers.mjs:18-26`）区分三种形态：

| 形态 | 示例 | 是否报 |
|---|---|---|
| 声明默认值 + 本文件别处用到 | `onX: (a: T) => void = () => {…}` 且 `this.onX(…)` 存在 | **不报**（正常兜底） |
| 声明默认值 + 本文件从未用到 | 同上但无 `this.onX` | 报（可疑死声明） |
| **调用处内联空实现** | `onX: () => { },`（写在组件构造参数里） | **报**（子组件一调就无反应） |

**本章实测（对抗验证）**：把 `RightbarShell.ets:326` 那份**带理由的空实现**退回成裸 `() => { }`，
门禁立刻点名那一行：

```bash
# 见 dist/gate-probe/inject-dead-handler.mjs —— 一次性负测试，跑完自动还原
node dist/gate-probe/inject-dead-handler.mjs
# 期望输出：
#   锚点命中 1 次；篡改已生效（sha256 …）
#   --- 篡改态：exit=1 ---
#   死按钮扫描：发现 1 处空实现
#     entry/src/main/ets/view/shell/RightbarShell.ets:326  [空箭头函数体]  onCommit: () => { },
#   还原：与改前一致=true
#   --- 还原态：exit=0 ---
```

**同类第二例（E-DC2）**：`check-dead-code.mjs` 曾报一条
`零使用 import：// pi-ai 路由（自定义模型 API）：…` —— 指向的是**一句注释**，不是符号。
根因是 `import {…}` 块按逗号切分，而块内可以写 `//` 注释。
**本章实测**：取收紧前的检测器（`HEAD:tools/check-dead-code.mjs`，不含 `split('//')` 与标识符判据）
对当前树跑，**精确复现这条假阳性**：

```
❌ 检出 1 处零使用声明（E345 / E346 / E346b / E367 都是这一类）：
  entry/src/main/ets/pages/Index.ets:47  零使用 import：// pi-ai 路由（自定义模型 API）：…
```

而当前版本报 `✅ 无死代码`（`扫描文件 99 个 · 判定声明 2237 处 · 门面字段 256 个`）。
修法见 `tools/check-dead-code.mjs:170-186`：先按 `//` 截断，再要求是合法标识符（含 `A as B`）。

### 3.3 要求三："**只 print 不校验**"是假门禁

**真实案例（E-RV4）**：`tools/make-icon.py` 的"确认启动画面未改动"原本**只是一句 `print`**。
审查构造反例：把 `startIcon` 加进 `outs` 被覆盖后，脚本**照样打印"（未改动）"**
（文件从 3577B 被改成 59441B，日志说没改）。

**两处"装饰性护栏"**（同批被审查证明拦不住任何东西）：

| 原自检 | 为什么拦不住 | 现在是什么 |
|---|---|---|
| "内腔透明采样点 > 0" | 采样窗里本就有落在鲸鱼**轮廓外**的点，恒透明 ⇒ **永远 > 0** | 改成"前景**不透明像素占比**须在 16%~20%"；带宽是按实测差标定的（正常 18.10% / 填黑 23.46%），并注明"曾用 15%~25%，坏图落在带内 ⇒ 根本拦不住"（`tools/make-icon.py:367-379`） |
| "旋转后墨迹触边" | `rotate(expand=True)` 会扩画布，墨迹几乎不贴边 ⇒ 几乎不触发 | 改成"在**角标框内**比较 mark 与 fg 的不透明像素数"（`tools/make-icon.py:385-408`），并记录两次写错判据的过程 |
| "确认启动画面未改动" | **只是 `print`** | 改为与 `third_party/brand-original/` **逐字节比对**，不符即 `return 1`（`tools/make-icon.py:428-448`） |

**同一处还修了一个顺序问题**：旧版**先落盘再自检**，自检失败时坏图**已经写进资源目录**
（"退出码 1 但资源被污染"，审查实测强制失败后磁盘上仍留下 6 个 PNG）。
现在**全部自检通过才写盘**（`tools/make-icon.py:355-358,415-425`）。

**本章实测（对抗验证当前门禁是否是真断言）**：往 `startIcon.png` 末尾追加 1 个字节，
`check-icon-assets.mjs` 立刻 FAIL 并点名该文件；还原后回绿：

```bash
# 改前 sha256 = 5a1a1ac3885f1008…（15246 B）
# 追加 1 字节后 sha256 = f106a2188064b661…（15247 B）
node tools/check-icon-assets.mjs; echo "exit=$?"
#   ✗ startIcon.png：**已被改动**（与原版不符）。…
#   RESULT: FAIL (1)          exit=1
# 还原后
node tools/check-icon-assets.mjs; echo "exit=$?"     # ✓ 通过（5 项） exit=0
```

**⚠️ 但这条断言有一个静默弱化路径**：它比对的对象 `third_party/brand-original/` 在
**`.gitignore:31` 里被忽略**（`/third_party/`）。新克隆的仓库里该目录不存在时，
门禁走的是"跳过"分支而不是失败：

```
notes.push(`${name}：无 brand-original 正本可比（跳过内容校验，仅记存在）`)
```

（`tools/check-icon-assets.mjs:61-63`）。**跳过时它仍然 `exit 0`、仍然打 ✓** ——
这正是 §3.3 要防的形态，只是这次藏在"数据缺失"而不是"只 print"里。
另外该文件第 28 行的 `ORIGINAL_SPLASH_SHA256` 常量**全文件只出现一次**（写死但从未被引用），
是"写下来的判据没接上"的残留。

### 3.4 要求四：断言方向要能**自洽**

**真实案例（E-SV21）**：`tools/assert-python-bridge.mjs` 里曾同时存在两条**互相矛盾**的断言：

```js
ok(skillDoc.includes('/dshm-python/'), '...');      // 要求必须有 /dshm-python/
ok(!skillDoc.includes('dshm-python'), '...清除');   // 要求不得有 dshm-python
```

**两条不可能同时成立。** 它之所以**长期通过**，是因为当时文档里是 `hdsh-python`——
恰好一条命中、另一条不命中。这是 **DSHM → HDSH → DSHM 两轮命名往返的化石**：
那条 `!includes('dshm-python')` 是**更早一轮**（DSHM→HDSH）留下的"清除 DSHM 残留"守卫。
改名改回来之后，两条断言同时指向 DSHM ⇒ 必然失败
（`docs/device-validation.md:3844-3858`、`tools/assert-python-bridge.mjs:93-101`）。

**修法**：守卫意图不变，**方向翻转到旧名**：

```js
ok(!skillDoc.includes('hdsh-python'), 'skill 文档：不再残留旧端点名 hdsh-python');
```

**教训（可复用）**：`!includes(X)` 与 `includes(X)` 同时存在时，
**唯一让它"看起来能过"的条件是"X 也存在于别处"**——那是巧合，不是设计。
凡写"清除某残留"的断言，必须问一句"**它清的是哪一代的残留**"，
并把来龙去脉写进注释（这一条已经写进去了）。

```bash
# 自洽性自查：找出可能互相矛盾的断言对
grep -n "includes(" tools/assert-python-bridge.mjs | grep -E "dshm-python|hdsh-python"
node tools/assert-python-bridge.mjs; echo "exit=$?"     # 期望 0（69 项断言全过）
```

### 3.5 要求五：门禁"通过"不等于"覆盖到了"

`docs/README.md:69-71` 把它列为文档纪律第 **9** 条：

> **门禁「通过」不等于「覆盖到了」**。门禁的覆盖面自身必须被审视：本项目两次出现
> 「门禁全绿但实际漏检」（命名空间表缺事件前缀、之后又缺 `deliverables/` 等三项）。
> **新增任何上游名词（端点、事件、命名空间）时，都要问一句「门禁认识它吗」**。

`docs/parity-matrix.md:159` 把这条纪律落到了具体对象上：跑不动的门禁，
**其覆盖面在本环境是盲区，不是通过**。

**为什么这条比前四条更难**：前四条的失败会体现在"门禁红了/绿了"这个二元信号上；
这一条的失败**信号本身就是绿的**。已知盲区（2026-09-28 复核后）：

| 盲区 | 表现 | 现状 |
|---|---|---|
| `check-arkts-entry.mjs` | **entry（UI 层）在本机零编译验证** | 修前 exit 3；判定器可信（`--self-test` 9 样例全过），但**脚本的 CLT 路径只认 Linux 布局**（§2.4）。**2026-09-28 已修 ⇒ exit 0**，日志里有 `CompileArkTS` + `BUILD SUCCESSFUL` ⇒ **不再是盲区** |
| **`check-layout-fixtures.mjs`** | 曾被记为"本环境跑不了"（`docs/parity-matrix.md` §3.1） | **本章实测解除 + 2026-09-30 根治**：不是缺 CLT，是 `findTsc()` 只认 Linux 布局。当时暴露 Windows 的 `typescript` 后 **exit 0 / 768 条断言**（§2.4）；**现已把 Windows 回退写进脚本**，直接跑即 exit 0，**无需 shim** |
| `compat-drift.mjs` | 依赖 `.research/protocol/contracts.json` 与上游 `node_modules` | 本机可跑（**见下**），但它守的是"**当前环境的上游**"，不是"上游的所有版本" |
| `check-model-roundtrip.mjs` | 端侧 `--expose-internals` 垫片是**设备专属**；本机还缺 koffi（HAP 内的自编 `libkoffi.so`） | 真实盲区（PC 侧测不了设备专属垫片） |

> **⚠️ 一处口径澄清（本章实测发现，很关键；2026-09-28 补注）**：
> 这个"分不清是哪台机器"的问题**已经修掉**：`docs/parity-matrix.md` §3.1 已按**本机 2026-09-28 的重测读数**整体重写
> （`check-layout-fixtures.mjs` 记为 **768 条断言**、`arch-check` 131 文件、`check-dead-code` 99 文件 / 2237 处声明…）。
> 但这条教训仍然成立，因为**它当初确实发生过**：改动前的 §3.1（`:119-145`）把
> `check-layout-fixtures.mjs` 记为 **"✅ 533 条断言通过"**、把 `check-arkts-entry.mjs` 记为
> **"✅ BUILD SUCCESSFUL（0 error / 32 warn）"**,
> 并给出了可跑命令 `<CLT>/tool/node/bin/node <CLT>/hvigor/bin/hvigorw.js …`（`:102`）。
> **那份读数是在另一台机器（Linux 开发机）上取得的** ——
> 同文件 `:110` 提到 `/home/node/node22/bin/node`、`:96` 附近的 `/home/node/deveco-clt/command-line-tools`。
> ⇒ **"环境受限"是"哪台机器"受限**，不是项目级结论。
> 本机（Windows）的两个 exit 3，根因是**脚本里的 Linux 布局硬编码**。
> 写文档时若不分机器，"某台机器跑不了"会很轻易地被读成"这个门禁是盲区"。

> **这一节最大的收获是一条方法论**：`docs/parity-matrix.md:159` 把"跑不动的门禁"
> 计入盲区时，用的是**结果**（退出码 3）而不是**原因**。而这两条 exit 3 的原因**都不是环境，
> 而是脚本没支持 Windows 布局**。⇒ **"环境受限"必须先验证再记**；
> 把它当结论写进文档，会把"一行路径解析的脚本缺陷"永久正当化成"客观限制"，
> 下一批人也就不再去查了。这正是 `docs/README.md` 纪律第 9 条
> （"门禁通过 ≠ 覆盖到了"）的一个**反向**应用：**门禁没通过 ≠ 覆盖不到**。
>
> **这条方法论在 2026-09-28 得到了第二次验证**：`check-arkts-entry.mjs` 的
> exit 3 被记了将近两周（`docs/parity-matrix.md` 记为"盲区"、§5.6 登记为"未在本章改动"），
> 而实际原因只是**四处路径写死**；一旦照 §2.4 的修法改掉，它当场就绿了。
> **"留给对应负责人"这句话的真实代价是：这一层在这两周里没有任何自动验证。**

**本章实测（盲区收窄）**：`compat-drift.mjs` 在本机**可以**跑通，只要显式指向上游包目录：

```bash
$env:DSH_NODE_MODULES="$PWD\dist\core\work\dsh-core-0.2.0-rc.2\node_modules"
node tools/protocol-contract.mjs --json dist/contracts.json; echo "exit=$?"   # 0，140 个 endpoint
node tools/compat-drift.mjs; echo "exit=$?"
#   期望：期望 140 / 基线 140，无漂移（2026-09-30 实测）
```

⇒ **`docs/parity-matrix.md:195` 记的"漂移门禁仍是盲区（唯一仍跑不动的门禁）"这条已经过时**：
只要用环境变量指向仓库内自带的核心树（`dist/core/work/<ver>/node_modules`），它是可跑的。

**2026-09-30 补记（已收口）**：`tools/protocol-enum2.mjs` 与 `tools/compat-drift.mjs` 的**默认**路径
此前仍硬编码**别人的用户名**（`C:\Users\aotian\…`）——现与 `tools/protocol-contract.mjs`（`:30` import `homedir`、
`:40-42` 兜底）**同法改为按当前用户推导**（`protocol-enum2.mjs:16/:19-20`、`compat-drift.mjs:22/:36-37`）。
⇒ 三个脚本口径一致，换机器不再静默失效；`DSH_NODE_MODULES` 仍可覆盖，找不到上游时**明确失败**。

```bash
# 找剩下的硬编码用户名（2026-09-30 实测：0 命中）
grep -nE 'C:\\\\Users\\\\[A-Za-z]' tools/*.mjs
```

### 3.6 要求六（衍生）：门禁必须把"环境不足"与"真的失败"分开

**真实案例（E381/E382 门禁自身的修）**：
① **"写死总数"的断言会让人放松警惕**——`assert-cli-shim` 里五条断言**本来就一直在红**
（三条是 `总数 === 2`，加第三个假壳后变成 3；两条锁的是**已被取代的文案**）。
更糟的是这五条**红了却没人发现**，因为 `assert-cli-shim` 当时**不在必跑链里**。
⇒ **判据应锁"每个都满足"（逐实体断言），而不是"总数恰好是 N"**；
⇒ **新增断言后必须接进必跑链**，否则红多久都没人知道。
（`docs/70-鸿蒙移植踩坑与修复总览.md:802-814`；修好后的逐实体判据见
`tools/assert-cli-shim.mjs:24-36,52-58,85-87`）

② **负测试"没生效"比负测试"失败"更危险**——按纪律做负测试时，
第一版按 `\n` 拼锚点，而文件是 **CRLF** ⇒ 替换**没生效**，
脚本却只打印一句"锚点没对上"就**继续跑完**，最后报"✓ 负测试通过"——
**一个虚假的安全感**。⇒ **负测试必须断言"篡改本身真的发生了"（替换前后字符串不等），
没发生即报错退出**（`docs/70-鸿蒙移植踩坑与修复总览.md:816-823`）。

**本章实测（这条纪律的价值）**：写 `dist/gate-probe/inject-parity.mjs` 之前，
第一次尝试在 PowerShell 里按 `\n` 拼锚点，**命中 77 次**（文件是 CRLF），脚本按设计
**报错退出且未修改文件**——正是这条纪律要求的形态：

```
anchorCount=77
ANCHOR FAILED
```

改用 node（按文件实际内容定位行，并在替换后**断言字符串确实变了**）之后，
负测试才真正生效。**这正是"未验证篡改是否发生"会掩盖的那类失败。**

**同一纪律也暴露了一个门禁归类缺陷**：`check-web-fetch-jitless.mjs` 自己声明
"退出码 0 通过 / 1 失败 / 3 环境不具备"（`tools/check-web-fetch-jitless.mjs:45`），
但当**子进程因 Node 版本不兼容而根本没起来**时，它报的是 **1（FAIL）**，
输出"B 臂没有产出断言汇总（可能崩在断言之前）"。
⇒ **"没跑成"被判成了"代码失败"**。与它同族的 `check-arkts-entry.mjs`
就做对了（缺 CLT 时明确 exit 3）。

**2026-09-28 已修，且实测证明它不只"归类不对"——这条门禁当时是整体失效的**（本机 Node v24.19.0）：

| # | 缺陷 | 后果 | 修法 |
|---|---|---|---|
| 1 | `FLAGS = ['--jitless','--no-experimental-fetch']`（`:308`）写死 | Node 24 拒绝该**否定形态**（`invalid negation because it is not a boolean option`）⇒ 子进程在第一条断言前就退出，**两臂同时哑火**（A 臂"失败但给不出 WASM 因果证据"、B 臂"没有产出断言汇总"）⇒ **A/B 对照实验两个方向都失去意义** | 改为**运行时探测**：`CANDIDATE_FLAGS.filter(f => spawnSync(process.execPath,[f,'-e','0']).status === 0)`，并打印一行说明剔了哪个。依据：仓内 `check-origin-fence.mjs:119-121` 已写明"不带 `--no-experimental-fetch`（libnode v24 fetch 已转正）"，端侧 `RuntimePort.buildHostArgv` 也不带它 ⇒ 剔掉反而**更贴近端侧** |
| 2 | `LOADER = join(ROOT,'entry','src','main','resources','resfile','resources','app','undici-loader.mjs')`（`:191`）把裸盘符路径传给 `--experimental-loader` | 默认 ESM 加载器报 `ERR_UNSUPPORTED_ESM_URL_SCHEME: …Received protocol 'd:'` ⇒ **B 臂从来没有跑成过**（崩在断言之前，与 Node 版本无关） | 改用 `pathToFileURL(LOADER_PATH).href`（该文件 `:50` 已导入），`existsSync` 判定仍用真实路径 |

修后实测：A 臂 `WASM=undefined` + `[probe] 真 undici 失败原因: WebAssembly is not defined`、4/4 断言按预期失败；
B 臂 **8/8 全过**（含跨源跳转仍被拒为 `WEB_REDIRECT_BLOCKED`）⇒ `PASS：对照实验成立`、**exit=0**。

⇒ **教训**：这个门禁的红被登记成"环境（需特定 flag）"之后，**没有人再去看它内部**——
而它内部同时藏着"两臂哑火"与"B 臂从未跑成"两处硬缺陷。**"环境问题"这个标签会掩盖它内部的 bug**，
与 §2.4 那条是同一个形态（"环境受限"必须先验证，否则会永固化）。

**同一天（2026-09-28）在 `check-fetch-shim.cjs` 上重演了同一个形态，而且这次挖到了产品代码**：

| # | 缺陷 | 后果 | 修法 |
|---|---|---|---|
| 1 | 前提断言建在 `--no-experimental-fetch` 的**语义**上（"原生 fetch 必须不可用"） | Node 24 已移除该 flag ⇒ **不带 flag 时 ① 直接 FAIL、带上 flag 时进程死在 CLI 解析**，两条路都红 | 前提改为 **`WebAssembly === undefined`**——这才是垫片与 `installFetchShim()` 共用的真判据（`hostcore/app/fetch-shim.js:600`）；并新增**未带 flag 时自动用 `--jitless` 重新拉起自己**（`DSHM_FETCH_SHIM_RERUN` 防死循环），免得"忘了加 flag"长得像"代码失败" |
| 2 | 取证探针打在 `http://127.0.0.1:9/never` | **9 是 fetch 规范里的禁用端口**，原生 fetch 在**入口**就返回 `bad port`，**根本没走到 undici 的解析器** ⇒ "reason 里没有 WebAssembly 字样"被误读成"本机没关 WASM"，把下面那条真 bug 挡在了后面 | 改用**真的活着**的本地 server（提到取证之前 `listen(0)` 取 `port`）；判据从 `/WebAssembly\|not defined\|fetch failed/i` **收紧**为 `/WebAssembly\|not defined/i`（原先那个 `fetch failed` 太宽，任何网络错误都能满足，等于没判） |
| 3 | 取证用的 `fetch` 引用**是在装完垫片之后取的** | 探的是垫片自己 ⇒ 得出"原生 fetch 没炸"这个**假结论**，而它恰好把真 bug 挡住了 | `const nativeFetch = globalThis.fetch;` 必须在 `installFetchShim()` **之前**抓 |

**顺带挖出的产品真 bug（`hostcore/app/fetch-shim.js`）**：`installFetchShim()` 的全局是"缺哪个补哪个"
（`:587-592`），而 Node 24 **启动就自带** `FormData`/`Blob`/`Headers`，且它们来自内部实现、**不碰 WASM**
（实测 `[JS]` 而非 `[native code]`）⇒ 当前端侧**一个都不补**，`globalThis.FormData` 保持原生。
而 `encodeRequestBody` 原先**只认 `instanceof DshmFormData`**（`:248`）⇒ 原生 FormData 落到最后一行
`Buffer.from(String(body))` ⇒ **请求体变成字面量 `"[object FormData]"`（17 字节）**。
受害路径是 dsh 的**附件上传**（`dsh-llm-deepseek/lib/index.js:686`、
`dsh-client-connection/lib/index.js:747` 的 `new FormData()`），症状是"上传静默失败 / 服务端收到乱码"。
**这条与 jitless 无关**——本机同结构同代码照样踩；它之所以一直被记成"环境问题"，纯粹是因为那个门禁
从来没跑到过 FormData 那一条。

修法是**在编码侧按能力识别**（新增 `isForeignFormData()` / `encodeForeignFormData()`，
`encodeRequestBody` 增加一支），而不是去替换全局：调用方拿的是哪个实现都能编对，
且这一层比"改写全局类"更稳（同 `isBlobLike()` 早已写明的取舍）。
`isForeignFormData` 用 `Object.prototype.toString.call(value) === '[object FormData]'` 精确匹配——
**只判能力会误收 `URLSearchParams`**（它同样有 `append`/`entries`/`forEach`）。

**这条断言做了故障注入**（按 §3.7 的纪律）：把 `if (isForeignFormData(body))` 短路成 `if (false && …)`
⇒ 门禁 exit=1，且**只有 FormData 那一条红**，报的是
`请求体没被当成 FormData 编码（服务端读到的 content-type=undefined，body="[object FormData]"）`；
还原后 sha256 与注入前一致。首次注入时那句报的是
`Cannot read properties of undefined (reading 'startsWith')`——**症状在下一跳**，
读的人看不出是"FormData 没被编码"，故断言改为先分别判 `contentType === undefined`
与 `body.includes('[object FormData]')`，最后才判 multipart，让失败信息直接点名缺陷。

**远端两条断言的归类也一并修正**：本机实测 `https://example.com/` **裸 `https.get` 就超时**
（`ERR timeout 5029ms`），而 `https://nodejs.org/dist/index.json` 是 `200 / 331923B / 1379ms`
⇒ 原 ③ 的红**是网络，不是垫片**。现改为：链路层错误码（`ENOTFOUND`/`ETIMEDOUT`/…）**降级为 skip**，
但**两条全链路层失败时仍报 FAIL**（那时无法区分"本机不通外网"与"垫片的 TLS 路径坏了"），
并给出 `DSHM_FETCH_SHIM_SKIP_REMOTE=1` 供离线环境显式跳过。
**这里我自己又犯了同一形态的错**：`withTimeout` 触发的 abort 抛出的 error **`code` 是空的**，
特征在 `name === 'AbortError'` ⇒ 只看 `code` 会把"本机主机连不上、被我们自己的 8s 超时掐掉"
记成**代码失败**，正是同一段注释刚说要避免的事。已加 `error.name === 'AbortError'` 判据。

修后读数（本机 Node v24.19.0）：`node --jitless tools/check-fetch-shim.cjs` → 6 条 ok / `exit=0`
（`example.com` 显示 skip 而非 FAIL）；不带 `--jitless` 自动重拉后同样 `exit=0`。

### 3.7 本节验证方式

```bash
# ① 哪些门禁支持 --self-test（注入式自检）—— 期望 8 个
grep -l "self-test" tools/*.mjs

# ② 自检全跑（证明检测器真的会失败，而不是永远绿）
node tools/arch-check.mjs --self-test
node tools/check-parity.mjs --self-test
node tools/check-dead-code.mjs --self-test
node tools/check-builder-recursion.mjs --self-test
node tools/check-design-tokens.mjs --self-test
node tools/check-arkts-entry.mjs --self-test
node tools/check-web-fetch-jitless.mjs --self-test
node tools/check-layout-fixtures.mjs --self-test   # 需 tsc；缺则 exit 3（"没跑成"，不是通过）

# ③ 归真：坏版本必须还在（这一步是 §3.1 的前提检查）
$env:GIT_DIR="$PWD\.codegenie\.git"; $env:GIT_WORK_TREE="$PWD"
git log --oneline             # 期望 3 条，最新 2026-09-21 —— 若为空，归真能力已丢失

# ④ 假阳性对照：收紧前的旧检测器 vs 当前树（期望 185 / 0）
git show HEAD:tools/check-dead-handlers.mjs > dist/check-dead-handlers-OLD.mjs
node dist/check-dead-handlers-OLD.mjs | Select-Object -First 1
node tools/check-dead-handlers.mjs

# ⑤ 对抗验证：真断言 vs 只 print（两个包装脚本，跑完自动还原并复核 sha256）
node dist/gate-probe/inject-dead-handler.mjs
node dist/gate-probe/inject-parity.mjs
```

---

## 4. 独立审查制度：三路对抗性审查

### 4.1 为什么需要"独立"审查，门禁为什么不够

门禁只能守住**已经想到的**判据。它守不住三类东西：

1. **判据本身错了**（§3.1–§3.6 的六个例子，全部发生在门禁内部）；
2. **该有的判据没写**——"图标有 4 处必须一致，但此前没有任何门禁"
   （`docs/device-validation.md:4149-4153`）；
3. **文档与实物不符**——"文档里有没有**描述『当前实现』却与实际代码不符**的地方？
   这比残留改名更危险，会误导后续"（`docs/review-prompts.md:74`）。

这三类都要靠**外部视角**发现。因此本项目建立了三路对抗性审查制度，
提示词固化在 `docs/review-prompts.md`（可复跑）。

### 4.2 三路的分工

| 路 | 方向 | 专属怀疑 | 提示词位置 |
|---|---|---|---|
| **A** | **正确性**（语音 + 启动 + 图标） | 残留调试代码/插桩、同一常量两处定义、`everReady` 只增不减、宿主第一次就失败时能否看到错误页 | `docs/review-prompts.md:7-53` |
| **B** | **一致性与残留**（改名 + 文档） | 文档里"描述当前实现"却与代码不符之处、断言方向是否合理、`pack-core` 的幂等标记是否新旧都认 | `docs/review-prompts.md:55-78` |
| **C** | **工程纪律**（可维护性） | 自检是否真能拦住错误、**注释与代码不符**（"这是最难查也最坑的"）、只在一处生效的常量、文档"已修"条目代码里是否真修了 | `docs/review-prompts.md:80-107` |

三路共同的角色设定（`docs/review-prompts.md:9-11`）：

> **你是独立审查者，任务是找出这轮改动中的缺陷。不要复述改动说明，不要称赞，
> 只报告你能用证据证明的问题。**

输出格式统一为三段（`docs/review-prompts.md:42-53`）：
`## 结论`（通过 / 有 N 个问题）、`## 问题清单`（严重度 / 位置 / 问题 / **证据** / 建议）、
`## 无法验证的项`（**如实列出没能确认的，不要猜**）。

### 4.3 为什么审查要"**证伪**"而不是"复述"

**理由一：复述没有信息量。** 一个审查者如果只重复改动说明，他提供的信息量是**零**——
改动说明本来就是我方写的。**只有"能找到的反例"才是新增信息。**

**理由二：这是被实测验证过的纠偏机制。** 三路审查各自命中过真实缺陷：

| 审查发现的**真实**缺陷 | 内容 | 处置 |
|---|---|---|
| `E-RV1` | `dshm-mark.png` **实际带着角标**（文档说"纯标记不带"）。根因：`whale.alpha_composite(...)` 是**就地**修改（PIL 该方法无返回值），之后 `mark = whale.resize(...)` 就继承了角标。证据：mark 与 foreground 缩到同尺寸后**逐像素 alpha 差异 0**，右下角墨点 386 | 从 `whale_base` 出图；并加自检（`tools/make-icon.py:335-341`） |
| `E-RV2` | `pack-core.mjs` 的 `patchSensevoiceForHms` 判 `text.includes('DSHM_HMS_PROVIDER')` **无旧名分支** ⇒ 核心树里是上一版打的 `HDSH_HMS_PROVIDER` 时判成"没打过" ⇒ 重复替换 ⇒ `die` | 加 `\|\| includes('HDSH_HMS_PROVIDER')`（`docs/device-validation.md:4076-4083`） |
| `E-RV3` | `missingAssets` **每次识别都整读 228MB 模型**算 sha256，而它被 `transcribe`/`inspect`/`snapshot` 反复调用；**且与下载路径刻意"流式写盘避免峰值"自相矛盾** | 改两级校验：默认只 `stat`，只在下载收尾与显式 `{verify:true}` 时读全文件 |
| `E-RV4` | **自检是"装饰性护栏"**（§3.3 详述） | 三条自检全部改成真断言 + 写盘顺序改为"全过才写" |
| `E-RV5` | 改名后**端侧状态文件无迁移**（`.hdsh-plugin-rows.yml` → `.dshm-plugin-rows.yml` 在**用户数据目录**里）⇒ 升级老用户读不到自己的插件启停设置 | 加防御性迁移 `migrateLegacyRowsName()`；静默容错（失败不阻断启动） |
| `E-TS1` | 工具链自签名被**静默跳过**（三层缺一不可：本机 PATH 无 python3 → `findHostPython()` 只找 PATH → 找不到时只打一行 ⚠ 就**跳过签名并 exit 0**） | `findHostPython()` 追加候选；签名未执行 ⇒ **exit 1**；**新增门禁** `check-toolchain-sign.mjs`（`docs/device-validation.md:4313-4350`） |
| `E-TS2` | 标记是**固定常量** ⇒ 换代测不出来（"白签一场"）；**且实现时自己踩了顺序坑**：摘要最初在**签名之前**计算，而签名会改变文件大小 | 标记改为"前缀 + 内容摘要"；**新门禁立刻报出不一致**（`docs/device-validation.md:4352-4371`） |
| `E-DL1` | `dist/sideload/` 里的 HAP 比 `entry/build/` **旧一个版本**（差 1172B，反汇编显示仍含**已删的** `concat`/`sleepMs`）；**根因是操作顺序错**：先刷新交付包 → 之后门禁抓出死代码 → 删掉 → 重新构建 ⇒ 交付包漏掉最后一次改动 | 刷新**前**断言"没有比构建更新的源文件"、刷新**后**断言"dist sha256 == build sha256"（`docs/device-validation.md:4373-4384`） |
| `E-DC2` | `check-dead-code` 的**假阳性**（把 `//` 注释当符号名，见 §3.2） | 切片后先按 `//` 截断，再要求匹配合法标识符 |
| `E-DH1` | `check-dead-handlers` **180 处误报里有 2 个真 bug** + 门禁自身两个缺陷（§3.2） | 收紧判据；两处真 bug 经核实是**有意的空实现**，处置是**补注释**而不是改能跑的代码 |

> `E-DL1` 与 `E-TS2` 两例特别值得记：**审查抓的是"流程/顺序"错误，不是代码错误**。
> 编译器、类型系统、单元测试**都不可能**发现"交付包漏掉最后一次改动"。
> `E-TS2` 更微妙——**新加的门禁替我们抓住了自己的顺序错误**，这就是加门禁的价值。

### 4.4 为什么审查结论必须**逐条自行复核**

**理由**：审查者与被审者拿到的是**同一份材料**，审查者也会犯同类思维错误
（本项目已两次记录"跨来源比对必须先确认字段对等"，`docs/README.md:63-64`）。
把审查结论直接采信，等于**用一个新的未验证判断替换一个未验证判断**。

`docs/device-validation.md:4132-4138` 记录了三条**审查判断有偏差、经核实后不改**的例子：

| 审查结论 | 核实结果 | 是否改 |
|---|---|---|
| "宿主真失败时用户永远看不到错误页（`BOOTING` 期 `fail()` 不可达）" | **部分成立但影响被高估**：`fail()` 确实只挂在 Web 回调上；但 `retry()` 在 `launchUrl` 为空时会排重试，且 `EntryAbility` 的 `adoptLocalHost` 成功后会经 `@Watch` 触发加载。真正的缺口是"宿主**彻底起不来**时无超时兜底"——这是**既有设计**（依赖宿主自行报错） | **未改**，如实记为已知限制 |
| "`DSHM_NATIVE_CAPTURE` 只认新名" | **不成立**：该处靠"发现旧 MARK → 删旧段 → 重注入"，旧名**同样**被识别并替换（与 `E-RV2` 那处**不同**——`E-RV2` 是真的只认新名） | **未改** |
| "mark 的角标区域是 140..256" | **判据本身有误**：那片区域鲸鱼**尾鳍本来就有墨**，"有没有墨"无法区分鳍与角标 | 判据**改成**"与 fg 在角标框内的墨点比较"后才成立 |

**第三个例子最典型**：它不是"审查者错了"或"我方对了"，
而是**双方共用一个坏判据**（"那片区域有没有墨"），
**必须换判据**才能得到结论。这与 `docs/70` §8.4「用户报"还是不对"时，
别重做同一个修法，先换测量工具」是同一条方法论
（`docs/70-鸿蒙移植踩坑与修复总览.md:744-752`）。

**另一条同类记录**：审查指出的"从整屏像素猜位置"问题，
root cause 是**测错了坐标系**——量到的是**窗口外**的桌面图标；
权威坐标源是 `uitest dumpLayout`（`docs/70-鸿蒙移植踩坑与修复总览.md:720`）。

⇒ **制度上的落点**：审查结论**不直接采信**，
每条都自行复核后才处置（`docs/device-validation.md:4062-4064`）；
**无法验证的项如实列出，不猜**（`docs/review-prompts.md:52-53`）。

**本章实测（补一条自身的复核例）**：审查提示词 B4 要求确认
"已知曾有一条自相矛盾断言（`includes('/dshm-python/')` 与 `!includes('dshm-python')` 同存），
确认它已修正且**没有同类**存在"（`docs/review-prompts.md:70`）。核实：

```
tools/assert-python-bridge.mjs:90   ok(skillDoc.includes('/dshm-python/'), …)      ← 新名，方向正确
tools/assert-python-bridge.mjs:101  ok(!skillDoc.includes('hdsh-python'), …)        ← 旧的矛盾项已翻转到旧名
```

⇒ **该条已修，且没有同类**（全文只有这两条 `includes` 断言，方向不再冲突）。

### 4.5 本节验证方式

```bash
# ① 三路提示词仍在（可复跑）
grep -c "^| " docs/review-prompts.md
grep -n "^## 路 " docs/review-prompts.md          # 期望 A / B / C 三路

# ② 审查结论必须逐条复核 —— 找出"审查发现但判断有偏差"的登记
grep -n "判断有偏差\|已核实澄清\|不改" docs/device-validation.md

# ③ 本节引用的 8 个真实缺陷，各自在代码/文档里的落点
grep -n "whale_base" tools/make-icon.py                          # E-RV1
grep -n "HDSH_HMS_PROVIDER" tools/pack-core.mjs                  # E-RV2
grep -n "migrateLegacyRowsName" hostcore/app/*.js                # E-RV5
grep -n "DSHM_ALLOW_UNSIGNED_TOOLCHAIN" tools/place-toolchain.mjs # E-TS1 的逃生阀（必须高声提示）
grep -n "split('//')" tools/check-dead-code.mjs                  # E-DC2
grep -n "isPropDefault" tools/check-dead-handlers.mjs            # E-DH1
```

---

## 5. 工程纪律清单

### 5.1 来自 `AGENTS.md`

| # | 纪律 | 位置 | 为什么是硬约束 |
|---|---|---|---|
| 1 | **真机数据保全**：绝对禁止任何会删设备用户数据的命令；一律 `hdc install -r` | `AGENTS.md` | **真实事故，不可逆**：一次裸 `hdc uninstall` 删掉 6 个历史会话 / 7 个插件 / 2 个工作区，系统备份为空、**不可恢复**。更严重的是事后把它写成了正常步骤（`docs/80-真机更新与数据保全.md:8-44`） |
| 2 | **回归纪律**：改动前跑基线并记录；改动后跑同一批、逐项对比；**任何 ok → fail 必须当场修，不许延后** | `AGENTS.md` | 不允许"修好后面、前面又坏" |
| 3 | **临时实验必须在同一次改动内还原**，并把验证到的结论写进**代码注释**，而不是留下实验代码 | `AGENTS.md`、`docs/80:155-159` | 曾差点留下实验残留（定位 `javaScriptProxy` 双桥覆盖时交换过注册顺序） |
| 4 | **产物归置**：构建产物不给留档、交付包落 `dist/sideload/`、文档编号连续、**一次性排查脚本用完即删** | `AGENTS.md` | 见 §5.3 的现状 |
| 5 | **判据以 el1/el2 为界**：`/data/app/el1/…` = 代码资源（可换）；`/data/app/el2/…` = **用户数据**（任何删除都不可逆） | `AGENTS.md` | 这是"这条命令安不安全"的唯一判据 |

### 5.2 来自 `docs/README.md` 的 9 条纪律

| # | 纪律 | 位置 |
|---|---|---|
| 1 | D1 冻结后，范围/目标/验收的变更必须走变更流程并升版本号，**不允许静默偏离** | `docs/README.md:57` |
| 2 | D2 的每条事实必须标注来源（代码 / 官方文档 / 实测 / 待实测）；标"待实测"的条目**在补齐证据前不得据以实现** | `:58` |
| 3 | D4 的每个 POC 必须有证据；**无证据的"通过"视为未通过**；失败结论必须与通过结论**同等留档** | `:59` |
| 4 | 实施期与设计的偏差写进 `specs/`（as-built 记录），**不改写历史文档** | `:60` |
| 5 | **上游知识只允许出现在 `dshcompat`**；违反即为架构回归，与功能 bug 同级处理。由 `tools/arch-check.mjs` 强制 | `:61` |
| 6 | **任何门禁必须经注入式负测试验证**其真的会失败，否则视为没有门禁 | `:62` |
| 7 | **跨来源比对必须先确认字段对等**（已因此得到一个"看起来很有说服力的错误结论"，差点删掉一处正确的防护） | `:63-64` |
| 8 | **统计实测数据前必须先定口径**，并把口径写出来（事件清单曾因"按通用字段名 `type` 遍历"**虚增 4 种**） | `:65-68` |
| 9 | **门禁"通过"不等于"覆盖到了"** | `:69-71` |

另有「清理与留档纪律」（E126，`docs/README.md:27-38`）三条：

- **临时过程产物一律只落 `dist/`**，随用随清；
- **文档只标"历史/已取代"，不删契约**（契约是排除歧义的依据，删了等于丢失判据）；
- **仓库根部只保留构建与许可文件**。

### 5.3 专项纪律一：一次性排查脚本"用完即删"

**AGENTS.md 原文**：`| 一次性排查脚本 | 用完即删 | 不要把临时诊断脚本留在 tools/ |`（`AGENTS.md`）。

**现状核查（2026-09-27）**——以下脚本按此条纪律属于"用完即删"或"来源存疑"：
（计数口径：`tools/` **顶层文件 64 个**；递归含 `lib/`、`electron-runtime/`、`node-runtime/` 三个子目录共 **92 条** git 跟踪文件。2026-09-27 那次记的"89"未注明口径、事后不可复核，已按 `git ls-tree -r --name-only HEAD tools` 的数替换。）

| 文件 | 性质 | 引用情况 | 处置状态（2026-09-28 已清） |
|---|---|---|---|
| `tools/repro_all.py` / `repro_local.py` / `repro_report9.py` | 复现报告 9 四个缺陷的**一次性**脚本 | 仓库内**零引用**（grep 命中 0） | **已删**（`git rm`，2026-09-28） |
| `tools/close_picker2.py` | "按坐标关闭系统选择器（收尾用）" | 仅 `docs/functional-test-report.md:143` 提到 | **已删**（同上；该处登记已同步移除） |
| `tools/verify_t1_clean.py` | 修复项的**单项干净复验** | 仅 `docs/functional-test-report.md:15,141` | **已删**（同上；结论数值已留在该报告正文，脚本本身是一次性的） |
| `tools/func_test_final.py` + `tools/dshtest.py` | 真机功能测试套件（A/B 级自动化 + 支撑库） | **有活引用**：`docs/80:123`、`docs/90:3544`（第五章 §1.7「装完之后的三步验收」；原 `docs/90-staging/E:172`，该目录从未入库，见 §7 历史说明）、`tools/update-device.ps1:208` | **保留**（属验收资产，`docs/functional-test-report.md:135-143` 有登记）。2026-09-28 顺手修掉两处硬编码：`func_test_final.py` 的核心版本读 recipe、`dshtest.py` 的 hdc 路径按 `DSHM_HDC`→PATH→DevEco 工具链解析（原先写死 `%USERPROFILE%\…\<版本>\…` 占位符与仓库绝对路径） |
| `tools/protocol-enum.mjs` | 已被 `protocol-enum2.mjs` 取代的迭代产物 | `docs/50-端侧核心运行架构.md:2421-2425` 曾登记"标记为待确认无引用后删除——**本轮不动**" | **已删**（2026-09-28 确认全仓无代码调用，仅文档里的采集记录；`docs/50` §15.4 已同步） |
| `tools/dump-piai-schema-full.mjs` / `tools/neg-test-piai.mjs` | 排障/负测试用 | 各 1 处引用 | **保留**（`neg-test-piai.mjs` 属负测试族，`docs/90:4222` 有登记） |
| `tools/check-layout-fixtures.mjs.bak`（09-25，124824 B） | 来源存疑、无引用 | `docs/device-validation.md:4177,4536` 两次登记"**是否删由项目方定**" | **已删**（2026-09-28 项目方以"全清"拍板；§6.3 待决策项随之关闭） |
| `tools/show_ui.py` | 被 `docs/functional-test-report.md:142` 登记为可复用测试资产 | **文件不存在** | **文档与实物不符**（同 §1.2 例③）⇒ 2026-09-28 已从该报告的可复用资产表中移除 |

**清理结果**：`git rm` 一次删 7 个文件（上表 6 行 + `.bak`）。计数口径（均为 `git ls-tree -r --name-only HEAD tools` 实测）：顶层 **64 → 57**，递归（含 `lib/`、`electron-runtime/`、`node-runtime/`）**92 → 85**。全仓剩余的引用全部在文档里，已逐处同步（见 §5.6 表格）。

**顺便记一条正例**：`tools/make-brand-assets.mjs` 走的是"**拒绝执行 + 指向新脚本**"而不是静默跳过
（`tools/make-brand-assets.mjs:20-25`，`process.exit(1)`），并把原实现保留在文件下半部供参考。
这是"废弃脚本"的推荐形态。

### 5.4 专项纪律二：产物归置表

`AGENTS.md` 的归置表（判据同样写在 `README.md` 与 `.gitignore:13-45`）：

| 类型 | 位置 | 说明 |
|---|---|---|
| 构建产物 | `entry/build/default/outputs/default/` | 会被 clean 覆盖，**不要当交付物留档** |
| 交付/侧载包 | `dist/sideload/` | 不会被构建清掉，含 README + 校验（SHA256SUMS） |
| 文档 | `docs/` | 编号连续：`00-`…`80-` |
| 一次性排查脚本 | 用完即删 | 见 §5.3 |

**`dist/` 与 `entry/build/` 都已进 `.gitignore`**（`.gitignore:14-16`），
但**`dist/sideload/` 是交付物**：它虽然落在被忽略的目录里，仍需**人**保证它与
`entry/build/` 逐字节一致——`E-DL1` 就是没保证住（§4.3）。

```bash
# 交付包一致性（E-DL1 的修法要求两处断言）
(Get-FileHash dist\sideload\*.hap -Algorithm SHA256).Hash
(Get-FileHash entry\build\default\outputs\default\*.hap -Algorithm SHA256).Hash
# dist/sideload/README.md 里声明的 sha256 必须与上面一致（三方一致）
```

### 5.5 专项纪律三：**改名等大规模操作的等价性证明**

`HDSH → DSHM` 改名不是"文案替换"：**213 种标识符 / 1244 处 / 115 个文件 + 9 个文件改名**
（`docs/device-validation.md:3815`）。规模到这个量级，
"我逐处看过"已经不是证据。本项目采用的方法是**归一化后逐字节比对**：

> **等价性证明**：把新旧文件都归一化（`hdsh`/`dshm` → 同一记号）后**逐字节比较**，
> 证明"**只改了名字、没动逻辑**"。据此可断定其余门禁失败与我无关。
> （`docs/device-validation.md:3909-3912`）

**为什么这个方法成立**：它把"改名没改坏"这个**主观判断**变成了**可执行断言**，
并且顺带产出一个副产品——**可以把别处的失败一次性排除**：
复核确认失败项全是环境依赖（找不到 CLT / 需特定 Node flag）或既有设计失配，
**无一与命名相关**（`docs/device-validation.md:3911-3912`）。

**改名类改动的两个必查项**（`docs/device-validation.md:3914-3916`，本次都查了）：

1. **成对关系**：文件名与 `require`、签名标记的**写入方与校验方**必须同步；
2. **幂等标记**：凡"改标记名"，必须**同时认旧名**，否则老产物无法增量重建
   （`pack-core` 的 7 处标记即此，`docs 50-端侧核心运行架构.md` E-SV22；实测 `die` 三次逐个暴露）。

**实测的等价性证明命令（可复跑）**：

```bash
# 归一化后逐字节比对：只改名字、没动逻辑
$env:GIT_DIR="$PWD\.codegenie\.git"; $env:GIT_WORK_TREE="$PWD"
$old = git show HEAD:entry/src/main/ets/view/shell/MainShell.ets | Out-String
$new = Get-Content entry\src\main\ets\view\shell\MainShell.ets -Raw
# 归一化（把两代命名折成同一记号）后比较行长与结构
($old -replace 'hdsh','X' -replace 'dshm','X' -replace 'HDSH','X' -replace 'DSHM','X').Length
($new -replace 'hdsh','X' -replace 'dshm','X' -replace 'HDSH','X' -replace 'DSHM','X').Length

# 幂等标记必须新旧都认（E-SV22 的落点）
grep -n "includes('DSHM_.*')" tools/pack-core.mjs
grep -n "includes('HDSH_.*')" tools/pack-core.mjs      # 期望：每处新名旁边都有旧名分支
```

### 5.6 专项纪律四：**文档与配置/代码必须一致**

这条是 `docs/README.md:33-35` 的原文教训（E126）：

> **教训**：这类"**文档说了、配置没做**"的偏差比单个 bug 更危险——下一个人会按文档行事
> （以为不会误提交），直到某次 `git add -A` 把 500MB 中间产物带进去。

**处置原则（写进了 `.gitignore` 的头部注释，``.gitignore:7-11`）：
「**修配置，不修文档措辞。**」**

**本章实测的若干处"文档与实物不一致"**（如实登记）：

| # | 文档说 | 实物 | 影响 | 现状（2026-09-28） |
|---|---|---|---|---|
| ① | `docs/parity-matrix.md:195`："协议契约…❌ 缺 ⇒ 漂移门禁**仍是盲区**（唯一仍跑不动的门禁）" | 实测**可跑**（指向仓库内核心树即可，138/138 无漂移，见 §3.5） | 让人放弃一条本可用的门禁 | **已改**（`parity-matrix.md` §3.3 该行 + §3.2 盲区表） |
| ② | `docs/50-端侧核心运行架构.md:2089`（E344）：`git show HEAD:…MainShell.ets` → 命中 1 处 | 实测 **0 处**（HEAD 已含修复，见本章 §3.1） | 让人误判"门禁失效"或"修复被回滚" | 待该文档负责人处置 |
| ③ | `docs/functional-test-report.md:142` 登记 `tools/show_ui.py` 为可复用资产 | 文件**不存在**（`Test-Path tools\show_ui.py` → False） | 照文档去跑会找不到脚本 | **已改**（2026-09-28 随一次性脚本清理，从该报告的"可复用测试资产"表中移除；同表另外两行 `verify_t1_clean.py` / `close_picker2.py` 的脚本本体已 `git rm`，登记一并去掉） |
| ④ | `docs/parity-matrix.md:159` 把 4 个门禁记为"覆盖面在本环境是盲区" | 实测**没有一条**是"本机能力不足"：`check-layout-fixtures`（768 断言）、`check-arkts-entry`（exit 0）、`compat-drift`（138/138）、`check-web-fetch-jitless`（exit 0）**全部可跑**；另见 `:119-145` 的旧读数其实取自**另一台 Linux 机器**（该块已于 2026-09-28 按本机重测重写） | 把"某台机器的限制"读成"项目盲区"，从此不再去查 | **已改**（`parity-matrix.md` §3 两处 + §3.1 命令块） |
| ⑤ | `docs/parity-matrix.md:126`："`check-dead-handlers` 78 处（**不追求归零**）" | 当前门禁报 **0 处**（`未发现空实现`），且 78 处那批是**旧判据的误报**（§3.2） | 旧读数会让人以为门禁"故意留红" | 待该文档负责人处置 |

**为什么这几处要逐条登记而不是一律顺手改**：②③⑤ 都在**其它文档**里，
按纪律第 4 条"实施期与设计的偏差写进 `specs/`（as-built 记录），**不改写历史文档**"
（`docs/README.md:60`），本章只负责**记录**，改动应由对应文档的负责人做。

**但 ①④ 本章已经改了**，理由与 §2.4 同一条：它们指向的是**脚本缺陷**，而
"记成盲区"的代价已经实测过了——`check-arkts-entry.mjs` 被记成盲区之后，
`entry`（UI 层）**将近两周没有任何自动验证**，而本次 m00001 的修复恰好改在这个目录里。
**"留给对应负责人"在无人接手的项目里等于"永久留红"。**
本章的做法是把验证结论落成可复现的命令（§2.4），再同步掉那两处会误导人的表述。

### 5.7 本节验证方式

```bash
# ① AGENTS.md 必跑链是否完整（15 条 node + 真机）
grep -n "node tools/\|device-acceptance" AGENTS.md

# ② 文档与配置对账：纪律里说的每一条都要能在配置里找到
grep -n "^/" .gitignore                       # dist/ build/ codegenie/ third_party/ 都应在
grep -n "dist/" docs/README.md                # 纪律条款

# ③ 注释与代码对账（审查路 C 的专项：这是最难查也最坑的）
grep -rn "已修\|已修复\|已改为" tools/*.mjs | Measure-Object      # 每条都应能在同一文件里找到实现

# ④ 一次性脚本现状（§5.3 的表）
#    已删的 7 个应当 exists=False；保留的 4 个应当 exists=True。
foreach ($f in @('repro_all.py','repro_local.py','repro_report9.py','close_picker2.py',
                 'verify_t1_clean.py','protocol-enum.mjs','check-layout-fixtures.mjs.bak',
                 'func_test_final.py','dshtest.py','scan-core-plugins.mjs','show_ui.py')) {
  "  tools/$f  exists=$(Test-Path "tools/$f")"
}
# 期望：前 7 个 False，func_test_final/dshtest/scan-core-plugins True，show_ui.py False（从未存在）

# ⑤ 幂等标记新旧都认（E-SV22）
grep -c "DSHM_ORIGIN_LIST\|HDSH_ORIGIN_LIST" tools/pack-core.mjs
```

---

## 6. 本轮清理记录

### 6.1 已清（可复核）

| 项 | 状态 | 复核方式 |
|---|---|---|
| `tmp/`（仓库根） | **检查时点为空** | `Get-ChildItem tmp -Force -Recurse \| Measure-Object` ⇒ 0 |
| `workspace/`（仓库根） | **不存在**（从未在根下建过；端侧工作区在**设备沙箱**里，见第三章 §7「沙箱布局」= `docs/90:2477`） | `Test-Path workspace` ⇒ False |
| 本轮门禁探针产物 | 全部落在 **`dist/gate-probe/`**（退出码读数、旧版检测器、注入脚本） | 符合"临时过程产物一律只落 `dist/`"（`docs/README.md:29`） |
| `dist/clt-shim/`（§2.4 的 junction shim） | **已删**（用完即删，`AGENTS.md`） | `Test-Path dist/clt-shim` ⇒ False |
| `dist/localtest/*` 脚手架 | 各门禁自己的 scratch HOME/sandbox（`model-sandbox` 等 13 个） | 属**可再生**产物，随 `dist/` 一起被 `.gitignore` 忽略 |

**⚠️ 两点如实说明**：

1. **`tmp/` 的"已清"是时点事实，不是持续状态。** 复核期间（本次撰写过程中）
   `tmp/` 下又出现了 9 个文件（`assert.mjs`、`count_die.py`、`extract_refs.py`、`fx.mjs`、`fx2.mjs`、
   `probe.mjs`、`show.py`、`show2.py`、`verify_refs.py`，mtime 均为 2026-09-27 17:58~18:00），
   来自并行的文档撰写工作。⇒ **"清空 tmp/" 需要一个执行时点，并且要复跑一次确认。**
2. **"32 个一次性脚本 + 空目录"这个数字在本仓库内找不到书面出处** ——
   已检索 `docs/**`、`README.md`、`AGENTS.md`、`tools/**`，无任何文件记录过该计数。
   **本章不做转述，标为"未验证"。** 若要留档，应写成可复跑的清单
   （本节 §5.3 给的就是这种清单）。

### 6.2 待决策项：`.codegenie/`（449 MB，含嵌套 `.git`）

**实测事实**：

| 项 | 数值 | 依据 |
|---|---|---|
| 体积 | **449.2 MB** | `Get-ChildItem .codegenie -Recurse -File \| Measure-Object -Property Length -Sum` |
| 文件数 | **24137**（其中 `.codegenie/.git` 占 24136，`objects` 占 24129） | 同上 |
| 内容 | **只有一个 `.git/` 目录**，无工作树文件 | `Get-ChildItem .codegenie -Force -Directory` |
| 它的身份 | 一个 `worktree` **指向仓库根**的 git 目录 | `.codegenie/.git/config`：`worktree = <仓库工作区>` |
| 提交数 | **3 条，全部停在 2026-09-21** | `.codegenie/.git/logs/HEAD`（最新 `61f6ab7`，时间戳 1789928363 = 2026-09-21 02:19:23） |
| 索引规模 | **28724 条目**（与当时整棵树同规模） | `git ls-files \| Measure-Object` |
| 是否入库 | **已被忽略** | `.gitignore:20`：`/.codegenie/` |
| 是否被现有门禁引用 | **无任何引用** | 全仓 grep `codegenie`（排除 `dist/`、`node_modules/`、`oh_modules/`）命中 **0** |

**清除它的好处**：释放 449 MB；移除一个"仓库里有个陌生 `.git`、但根目录又不是 git 仓库"的
认知陷阱（`git status` 在根下报 `fatal: not a git repository`，exit 128）。

**清除它的风险（关键）**：**它是本仓库唯一的历史版本载体**，
因此也是 §3.1「门禁必须在已知坏版本上红过」这条纪律**唯一的取版本手段**
（本章 §3.1、§3.2 的两处归真对照，正是靠它复现的）。删掉之后：

- `docs/50` E344 / `docs/parity-matrix.md`（`git show HEAD:…` 的归真记录）**全部变成不可复跑**；
- §3.2 里"旧判据报 185 处"这类**门禁自身退化**的对照，以后无法再取证；
- 一旦未来某次改动把某个门禁写坏，将**没有基线可比**。

**同时要注意它的能力边界**：HEAD 停在 2026-09-21，
所以它**不能**为更早的修复（如 2026-09-15 的 E343）提供归真——那些修复**已在 HEAD 里**
（本章 §3.1 实测：`HEAD:MainShell.ets` 已含 `TabContentView` 兜底，`scanText` 命中 0）。

⇒ **本章的处理：记为待决策项，不做处置。** 决策需要回答两件事：

1. **本项目的历史版本基线要不要保留？** 若要，应由项目方决定一个**正式**的位置
   （例如把 3 个提交打包成一个小归档放进 `dist/` 或 `third_party/`，只留必要对象），
   而不是留一个 449 MB 的运行时残留；
2. **若保留 `.codegenie/`**，必须在文档里写明"**它是归真验证的唯一载体，不得删除**"
   ——否则下一个人看到 449 MB 的未知目录，会当成垃圾清掉。

**决策前的安全边界**：在得到明确指示前**不删**。
它已被 `.gitignore:20` 忽略，不会误入版本库；对构建与门禁**零影响**（全仓零引用）。

### 6.3 已关闭的待决策项：`tools/check-layout-fixtures.mjs.bak`（2026-09-28 删）

`tools/check-layout-fixtures.mjs.bak`（2026-09-25，124824 B）曾在
`docs/device-validation.md:4289` 与 `:4545` **两次**被登记为"来源存疑、无引用、是否删由项目方定"。
它不属于一次性排查脚本，而是**被取代的检测器快照**；按 `AGENTS.md`
（"一次性排查脚本用完即删，不要把临时诊断脚本留在 `tools/`"）它**不该**留在 `tools/` 里——
留在那里的最差后果是**被后来者当成"门禁"**。

**处置（2026-09-28，项目方以"全清"拍板）**：`git rm` 删除。
判据是它**零代码引用**（`dump-piai-schema-full.mjs` 与 `check-layout-fixtures.mjs` 里的注释提及供参考，
不构成依赖），且现役检测器 `tools/check-layout-fixtures.mjs`（768 断言）在位、可跑（exit 0）。
`docs/device-validation.md` 的三处登记（`:4289`、`:4545`、`:4648`）已随之改为"已删（2026-09-28）"。

### 6.4 本节验证方式

```bash
# ① tmp/ 与 workspace/ 的现状（要给出执行时点，见 §6.1 的说明）
"tmp entries = " + (Get-ChildItem tmp -Force -Recurse -ErrorAction SilentlyContinue | Measure-Object).Count
"workspace exists = " + (Test-Path workspace)

# ② .codegenie 的体积、身份与提交时间（决策依据）
$s = Get-ChildItem .codegenie -Recurse -File -Force | Measure-Object -Property Length -Sum
"{0} files  {1:N1} MB" -f $s.Count, ($s.Sum/1MB)
Get-Content .codegenie\.git\config                  # 期望：worktree = <仓库根>
Get-Content .codegenie\.git\logs\HEAD               # 期望：3 条，最新 2026-09-21
$env:GIT_DIR="$PWD\.codegenie\.git"; $env:GIT_WORK_TREE="$PWD"
(git ls-files | Measure-Object).Count               # 期望 28724

# ③ 它是否被门禁引用（决策的另一半依据）
$files = Get-ChildItem -Recurse -File -Include *.md,*.mjs,*.cjs,*.ps1,*.py,*.json,*.ets `
          | Where-Object { $_.FullName -notmatch '\\dist\\|\\node_modules\\|\\oh_modules\\|\\.codegenie\\|\\.cxx\\|\\build\\' }
Select-String -Path $files.FullName -Pattern "codegenie"          # 期望：0 命中

# ④ 它在 .gitignore 里（不会误入版本库）
Select-String -Path .gitignore -Pattern "codegenie"               # 期望：/.codegenie/

# ⑤ 待决策的残留
#    2026-09-28：.bak 已按项目方"全清"决定删除（§6.3），此处期望 False
"check-layout-fixtures.mjs.bak exists = " + (Test-Path tools\check-layout-fixtures.mjs.bak)
```

---

## 7. 一页速查

| 问题 | 去哪一节 | 最快的一条命令 |
|---|---|---|
| 我改了 UI，该跑什么？ | §2.2.2 | `node tools/check-feature-wiring.mjs && node tools/check-dead-code.mjs && node tools/check-builder-recursion.mjs` |
| 我改了宿主脚本，该跑什么？ | §2.2.1 | `node tools/place-host-app.mjs && node tools/assert-resfile-sync.mjs`（缺第一步 = §1.2 例①） |
| 某条门禁红了，是环境还是真回归？ | §2.4 / §2.5 | `echo $LASTEXITCODE`：**3 = 没跑成，不是通过**；但**先验证"环境"这个结论**（§2.4 实测：两条 exit 3 其实是脚本的 Linux 布局硬编码） |
| 我要写一条新门禁 | §3.1–§3.6 | ①先在已知坏版本上红过；②报量要能逐条看；③断言要真校验不是 print；④方向要自洽；⑤接进必跑链 |
| 审查说我改的不对 | §4.4 | **逐条自行复核**——本项目已有 3 条"审查判断有偏差、经核实后不改"的记录 |
| 我要做一次大规模改名/搬迁 | §5.5 | 归一化后**逐字节比对**；并查"成对关系"与"幂等标记新旧都认" |
| 文档说的和代码不一致 | §5.6 | **修配置，不修文档措辞**；偏差写进 as-built 记录，不改写历史文档 |
| `.codegenie` 那 449 MB 能删吗？ | §6.2 | **待决策**。它是归真验证（§3.1）的唯一取版本手段 |
| 归真验证跑不出命中 | §3.1 | 先 `git --git-dir=.codegenie/.git log --oneline` 确认基线提交——**归真是对"一个具体提交"的验证，不是可无限复用的命令** |

---

## 8. as-built 增量（2026-10-04）：核心升到 `0.2.1-alpha.1`

本章 §2.9 的基线数字是 `0.2.0-rc.2` 那一版的实测值。按 §5.6 的纪律（**偏差写进 as-built 记录、不改写历史文档**），新值单列于此；逐条判定与完整命令链见 `docs/40-上游升级手册.md` §4.5，契约事实见 `docs/10-协议兼容事实基线.md` §8.7.25。

| 项 | `0.2.0-rc.2`（§2.9 基线） | `0.2.1-alpha.1`（本次实测） |
|---|---|---|
| 解包体积 / 文件数 | 252,069,490 B / 26,066 文件 | 264.0 MB / 27,034 文件 |
| 分发包 / 条目数 | 78,081,448 B / 29,351 条目 | **84,003,922 B / 30,451 条目** |
| 分发包 sha256 | `45836d8a…fff3b3` | **`7103724994614f2321d45a8d64f09c1ede379fde698e99eb52992c61d4c826e3`** |
| 原生签名 | signed 47 / unsigned 1 | signed 47 / unsigned 3（判据见下注，不看计数） |
| 契约 | 140 端点 / 13 流式 / 15 能力 / 86 未被引用 | **140 / 13 / 15 / 86，逐条一致（连续第四次零漂移）** |
| HAP（signed） | 314,329,793 B（E388 版） | **320,195,241 B** / sha256 `60eb817f094be90419eb28becdf55dacd6bb9f6cfd44bdd5517bea9651920c7c` |
| 真机验收 | LOOP-GAP 0 条（E388 修复后） | `BOOT_10_ENV_READY core=…/dsh/cores/0.2.1-alpha.1`、`LOOP-GAP` 0 条、`IN-DONE` 53 条（最慢 6341/4965 ms） |

> ⚠️ 本次 `unsigned` 由 1 变 3 **不是回归**：`addSystemAddonPackage()` 在 `selfSignNatives()` **之后**才创建 `@deepseek-ai/node-addon-system-linux-arm64/bin/{glibc,musl}/system.node` 两个占位文本（真身是 HAP `libs/` 里的 `libsystem.so`），首次打包（占位尚未生成）报 1、重打包报 3 ⇒ 判据仍看清单内容，不看计数（§2.9 的两个注已说明这一点）。

> ⚠️ 本次还暴露并修掉一处**门禁自身缺陷**（与升级无关，但被新核的启动顺序变化暴露）：`tools/check-origin-fence.mjs` 的就绪判定把任何 `status > 0` 当作就绪、随后一次性读 `host-ready.json`；新核改成「先 404 应答、后落盘」后该门禁 3/3 误报失败（旧核 3/3 通过）。修法 = `waitReady` 之后再等文件真正落盘（`DSHM_CHECK_READY_FILE_MS`，默认 20000）；修后两版核心各 3/3 PASS，并按 §3 的纪律补了两条负测试。

> ⚠️ 升级还会在**设备侧 live profile** 留下一条历史包袱：真机 `dsh.profile.bundles` 仍列着新核已删除的
> `@deepseek-ai/dsh-experimental-schedule-bundle`，由宿主启动时的 bundle 预检**静默移除**（日志：
> `【bundle 预检】dsh.profile.bundles 里 1 行不可解析，已移除（防启动抛错）`），**不抛错、功能不丢**
> ——`POST /api/schedule/{catalog,list}` 仍 200（schedule 现由 `dsh-web-app` 自带）。
