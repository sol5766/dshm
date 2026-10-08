# 115 · 手持档（手机 / 平板）的工具链解包：从 `spawn busybox tar` 改成进程内纯 JS

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-07 |
| 来源报告 | ① **手持档**体检：`DSHM-环境与工具调用-完整体检报告.md`（仓库外，389 行，2026-10-07 13:0x，手机档 UA `(Phone; OpenHarmony 7.0) … Mobile`，核心 `+dshm.13`，pid 6737）；② **PC 档**发布门禁：`dshm-release-gate-report.md`（仓库外，198 行，2026-10-07 12:24–12:30，核心 `+dshm.13`，pid 15224） |
| 用户原话 | 「第一个手机端的检测报告，第二个PC端的检测报告，一起看下，有问题的分开处理，手机端和PC端类似。」→ 随后更正：「说错了，**手机端和平板端**的问题是类似的，**他俩都不能调用 bash**」 |
| 本轮性质 | **改代码**（`hostcore/app/**` + `tools/**`）+ 文档；**未装机、未 push、未动核心树**。两份报告**分开处理**：手持档（手机 + 平板＝同一类）与 PC 档各自分诊（§2） |
| 设备 | 本轮开工与收工**都没有设备在线**（`hdc list targets` → `[Empty]`）⇒ 所有端侧读数**待真机复验**（§6） |
| `coreVersion` | **未升**（`0.2.1-alpha.1+dshm.13` 不变）。本轮一个字节都没碰核心树注入 ⇒ 容器与上一份逐字节一致，`tools/check-resfile-core-zip.mjs` 复验通过（§5.3） |

---

## 1. 一页结论

| # | 问题 | 档位 | 本轮处置 | 判据 |
|---|---|---|---|---|
| 1 | **Python 运行时永久不可用**（`stdlib=false`、`toolchain/python/bin/*` 空、`.extract.log` 0 字节） | 手持档（手机 + 平板） | ✅ **已修**：解包改走**进程内纯 JS**（不创建任何进程） | 报告 P0-2；根因 §3；修法 §4 |
| 2 | 「不能调用 `bash`」（`spawn bash EACCES`） | 手持档（手机 + 平板） | ⛔ **不是本仓能修的**：`docs/104` 已判决本档**没有真 shell 进程**（三条件全否）；本轮**未改**这条，也**没有**把终端做成"看起来能用" | `docs/104` §2/§3 的六条判决性读数；`docs/114` 的 WorkBuddy 印证 |
| 3 | 「给 Agent 一条可达的进程内通道」 | 手持档 | 🟡 **部分推进**：Python 运行时（`dlopen` + 进程内 CPython）是本档**唯一**真正能跑的工具链，本轮的修复正是它的前置条件；**入口**（`run_code`/PTC 或进程内 binding）仍待拍板 | 报告 P1-1；§8 |
| 4 | 会话写锁累积（启动巡检「发现 21 个，清理孤儿 0」） | PC | 🟡 **只加读数、不改策略**：把"为什么保留"按类计数打出来，下一轮据此定口径 | §5.3 |
| 5 | `GET /api/changes.summary` 404 ×289 | PC | ➖ **重报**，不动：`docs/106` §1.1 已裁定为**上游设计**（客户端与 Host 路由口径就是这么定的） | `docs/106` §1.1 |
| 6 | `modelCatalog` 冷启动长尾 / `read_image` 不可用 / `sandbox-dlopen` FAIL | PC | ➖ 都不是本仓缺陷：上游 provider 侧 / 模型能力声明 / 已知平台限制（已由扁平重定向兜底） | 报告 §六 |

**回归门禁**：开工时 **1 红**（`assert-exec-fix` 第 34 条，由**本轮**新增的一行诊断措辞触发 —— 见 §5.2），收工时全绿（§5.1）。

---

## 2. 分诊：两份报告"分开处理"的落点

用户要求"有问题的分开处理"，并更正了两类问题的归属。下表把两份报告的每一条落到"改 / 不改 / 待拍板"：

### 2.1 手持档（手机 + 平板，**同一类**）

| 报告条目 | 判定 | 本轮 |
|---|---|---|
| P0-2 Python 解包未完成 | **真缺陷，可修** | ✅ 已修（§3/§4） |
| P0-1 市场上游文案误判（把 `EACCES` 当"没有权限写 Node 安装目录"） | 上游 bug，且**已被市场桥覆盖**（用户不会再看到） | 不改（§8） |
| P1-1 给 Agent 一条可达的进程内 Python 通道 | 本仓可做，但涉及工具集投放口径 | 待拍板（§8） |
| P1-2 核心树 `statSync` 扫描停顿（本次 7 次 `LOOP-GAP`，最大 3.4 s） | 与 PC 报告口径不同（PC 当前实例 0 次），需按档位/实例分别看 | 不改，记待查（§8） |
| P2-1 工作区根与会话 cwd 对齐 | 老问题，`docs/113` 已把"默认工作区登记"收窄；`cwd` 对齐属产品口径 | 不改（§8） |
| P2-2 文档口径（`ohos-pc` / `ohos-python` 说"运行在 PC"） | **已在前轮修**（三份技能已按档位分叉） | 无需再改（§8） |
| §3.2「不能调用 `bash`」 | **平台级硬约束**（非本仓可修） | 不改（§1 #2） |

### 2.2 PC 档

| 报告条目 | 判定 | 本轮 |
|---|---|---|
| B1 附件上传（上轮 BLOCKER） | 已修复，本轮**未回退** | 不动 |
| B2–B5 垫片 / 沙箱策略 / 终端能力 / 性能 | 全部通过 | 不动 |
| P2 会话写锁累积 | 判据可加强（当前只能看出"没删"） | 🟡 加读数（§5.3） |
| P3 / P1 / P2 其余 | 见 §1 #5/#6 | 不动 |

---

## 3. 根因：手持档为什么永远 `stdlib=false`

### 3.1 原链路（每启动一次，必然失败一次）

`hostcore/app/main.js` 的 `scheduleToolchainExtraction()`：

```js
fs.rmSync(PYTHON_PREFIX, { recursive: true, force: true });   // ① 先删掉已有的 python/
fs.rmSync(pyStage, { recursive: true, force: true });         // ② 再删掉暂存区
child = spawn(path.join(binDir, 'busybox'), ['ash', '-c', cmds.join('\n')], …);  // ③ 解包
```

③ 在手持档**必然失败**：本档 SELinux 域下应用自带可执行文件一律 `EACCES`
（`docs/104` §2/§3 的判决性读数，含"用能执行的程序当启动器"同判的实测）。
后果是一条**静默**的坏链：

```
spawn 失败 → .extract.log 落 0 字节 → py-stage 里什么都没有
          → finishToolchainExtraction 的 rename 无源可 rename
          → pythonReady() 永远 false
          → host-ready.json 的 runtime.python 永远 stdlib=false / selftest=pending
          → Python 桥（本档唯一真正能跑的工具链）永久不可用
```

**"静默"是本条最要紧的形态**：不会有任何报错冒到界面上，`runtime.python` 只是永远 `pending`。
（这也是为什么本轮的门禁要按"接线"逐个断言 —— §5.2。）

### 3.2 关键认识：解包**不需要**新进程

`tar.gz = gzip(ustar)`。`node:zlib.gunzipSync` + 512 字节头解析是**零依赖的确定性路径**，
不需要 `spawn`、不需要 `dlopen`、不需要任何原生件。所以"本档禁止创建进程"与"能不能解包"
是两件不相干的事 —— 原实现把它们绑在了一起。

---

## 4. 修法

### 4.1 `hostcore/app/tar-gz.cjs`（新增，9,780 B）：**单份**纯 JS tar 实现

- 生成器 `walkTar(buf, opts)` + 同步 `extractTar(tarBuf, destDir, opts)` + 异步 `extractTarGzFile(archive, dest, opts)`；
- 异步入口按批 `await setImmediate`（`yieldEvery: 64`）让出事件循环 —— 27.7 MB / 4,539 条目不能把主线程钉死（`LOOP-GAP` 上踩过一次）；
- 三条语义与旧实现逐条对齐：
 1. 可配置前缀剥离（npm tarball 的 `package/`）；
 2. `..` 段与绝对路径**抛错**（tar-slip，不静默跳过）；
 3. `symlink`/`hardlink` **不建链**（沙箱禁 link，真机探针 13900012）⇒ 如实跳过并计数；
- **唯一行为改进**：采纳 **PAX `path=`**（CPython 归档里有 9 条 >100 字符的 pip license 路径，旧实现忽略 PAX 会把它们落到截断名上）。

### 4.2 `hostcore/app/main.js`：进程内回退（**只解 python**）

- `spawn` 的**两条**失败路径都接上回退：同步抛错、以及异步 `'error'` 事件（本档实测形态）；
- 新增**一次性门闩** `inProcFallback`：同一个 `child` 上两条路径**可能都触发**，而两遍都往同一个 `py-stage` 写 ⇒ 第二遍会去 rename 一个已经被 rename 走的目录；
- 回退只解 python，**不解 git**：git 真身是随包 ELF，本档 `execve` 一律被拒，解出来也永远起不来，只是白占 ~100 MB；
- 完成后走同一个 `finishToolchainExtraction(true, false)` ⇒ rename 归位、签名标记落盘、`pyOk` 时 `setImmediate(ensurePythonBridge)` 补跑自检（既有链路一个字不改）；
- `.extract.log` 仍照旧打开（保持既有可观测面）。

`PC/2in1 档行为零变化`：那里 `spawn` 成功，**回退根本不会被调用**（判据是"spawn 失败"，不是"看档位"）。

### 4.3 `hostcore/app/dshm-installer.js`：删掉私有 ustar 解包

原第 144–224 行有一份**只支持 ustar + GNU longname** 的私有实现；现改为复用同一份 walker
（`tarGz.extractTar(tarBuf, destDir, { stripPrefixes: ['package'] })`，同步契约不变）。
⇒ 插件安装顺带拿到 PAX 支持，且**全仓只有一份 tar 实现**（少一处会各自腐烂的复制品）。

### 4.4 快照与打包接线（漏一个就整车哑掉）

| 文件 | 改动 | 漏了会怎样 |
|---|---|---|
| `tools/place-host-app.mjs` | `FILES` 加 `'tar-gz.cjs'` | `require('./tar-gz.cjs')` 抛 `MODULE_NOT_FOUND`，被调用点吞成一行 diag ⇒ **与修复前症状一模一样** |
| `tools/assert-resfile-sync.mjs` | `FILES` 同步加 `'tar-gz.cjs'` | 快照门禁不认识它 ⇒ 改了源码而 resfile 没重放时不会红 |

---

## 5. 门禁

### 5.1 门禁基线（本轮收工实测）

- `tools/` 下 **49 个** `assert-*` / `check-*` 全量跑一遍：**48 个 rc=0**。唯一非零是
 `check-model-roundtrip.mjs`（rc=1）—— 那是**门禁自述的 Windows 平台差异**（它自己的注释 `:63-70` 写明
 "本机跑不出完整的一转：核心树只保留 OHOS/Linux 的 koffi 预编译，win32 那份被裁掉 ⇒ 正式用法是对真机
 `--remote-url/--remote-token`"，`docs/40` §4.5 已按此登记）。**与本轮改动无关**：本轮只动了
 "工具链解包失败后的回退" 与一处诊断读数，两者都不在模型链路上；该门禁在本轮之前就是这条读数；
- 受本轮直接影响的四条：`check-tar-extract` **33/33**、`assert-exec-fix` **38/38**、
  `assert-resfile-sync` **14 件快照全部同步**、`check-resfile-core-zip` **resfile 只有 1 份容器且与配方/产出三者一致**；
- `check-dead-code`、`check-doc-refs` 通过。

### 5.2 `tools/check-tar-extract.mjs`：26 → **33 条**断言（+7 条接线断言），另有 4 条对照臂

新增的 7 条接线断言（§10）断的是"**修法真的被用上**"（实现对了却没接上，症状与修复前完全一样静默）：

1. `main.js` require 进程内解包实现；
2. 两条 `spawn` 失败路径都经一次性门闩接上（且真身**只被引用 2 次**：定义 + 门闩体内那一次，多一处即绕过门闩）；
3. 回退**是一次性门闩**（重复触发只留一行 diag）；
4. 回退只解 python（`extractTarGzFile(tarball, pyStage)` + `finishToolchainExtraction(true, false)`，且函数体内不出现 `apks`）；
5. 插件安装器复用同一份 walker；6–7. 两个 resfile 快照清单（`place-host-app` / `assert-resfile-sync`）都带上 `tar-gz.cjs`。

**两条断言被"注入式负测试"验过有牙**（本项目纪律：未经负测试验证的断言视为没有断言），
本轮实测 4 个变异体全部判红、随后原样还原后复绿：

```
baseline rc=0
[CONTROL OK] 绕过门闩直呼（第二处）        -> rc=1
[CONTROL OK] 拆掉一次性门闩                -> rc=1
[CONTROL OK] place-host-app 漏件           -> rc=1
[CONTROL OK] 安装器不再复用同一份 walker    -> rc=1
restored rc=0  ALL CONTROLS VALID
```

（连同既有两条：忽略 PAX 的旧实现必须**落错位置**、去掉 `..` 守卫的朴素实现必须**真的越界写出文件**。）

### 5.3 `tools/assert-exec-fix.mjs` 第 34 条：从"裸短语计数"改成"完整文案断言"

**这是一条本轮自己踩出来的回归**：原判据是短语 `execve 被拒` 恰好出现 2 次 ——
本轮在工具链回退里加了一行解释性 diag（"本档 execve 被拒 ⇒ git 真身起不来"），**就把它踩红了**。
脆锚点的两面都成立：① 任何一处无关措辞都会误伤；② 它真正想守的东西（"两条用户可见的降级文案都在"）
反而没被断言到。现口径 = 断言**完整句子**
`该设备系统策略禁止运行第三方原生二进制（execve 被拒），暂不可用` 恰好 2 次（helper 与 rg 各一条）：
少一条仍 FAIL，别处出现同义措辞不再误伤。

> 顺带记一条口径：**改门禁的判据属于"改判据"，不是"改读数"** —— 本轮只做了"把锚点收紧"这一个方向
> （裸短语 → 完整句），没有放宽任何一条。

### 5.4 PC 档写锁：**只加读数，不改策略**

PC 报告那条「发现 21 个，清理孤儿 0」只能看出"没删"，看不出**为什么没删** —— 而这正是下一步定策略的唯一信息。
本轮在 `recoverOrphanLocks()` 里加了按类计数（`存活` / `EPERM(异uid)` / `本进程` / `非pid` / `不可读` / `删除失败`）
与最多 6 条样例，挂在**「写锁巡检」这一行之后**（`tools/device-acceptance.ps1` 拿那一行当"本次启动"的起点，
明细放前面会被切掉）。

**为什么不顺手改策略**：判据 `process.kill(pid, 0)` 在鸿蒙上有两种解释 ——
`EPERM` 既可能意味着"记录的 pid 已被**无关进程**占用（原持有者早没了 ⇒ 是孤儿）"，
也可能意味着"进程在但不属于我们（⇒ 不能动）"。**两种解释的处置相反**，而现有实现的取向是
"**误判方向永远是少删**"（代价只是回到上游行为）。在没有真机读数之前把取向反过来，
风险是把一个**活着的**写者锁删掉（并发写 → 数据损坏），比"多留几个文件"严重得多。故：先取事实（§6 第 4 项），再定口径。

---

## 6. 真机复验清单（装机后照做）

**手持档（手机 / 平板）——本轮修的就是它：**

1. `host-ready.json` 的 `runtime.python` 应从 `stdlib=false / selftest=pending` 变为
   `stdlib=true`，且自检 `print(1+1)=2`；
2. `toolchain/python/bin/*` 应有产物（`python3.12` ≈ 23 MB、`-rwxr-xr-x`）；
   ⚠️ **`.extract.log` 在手持档仍是 0 字节，这不是故障**（2026-10-07 手机实测更正）：
   该文件只是 **spawn 子进程**的输出槽（`openSync(…, 'w')` 只服务 spawn 路径），**进程内路径不写它**；
3. `dshm-host.log` 应出现 `工具链：改用进程内解包（…）` 与 `工具链：进程内解包完成（写 3482 个文件，跳过 … 个链接/特殊条目）`；
   失败行以 **`工具链：解包子进程异常：Error: spawn … EACCES`** 的形态出现（异步 `'error'` 路径）——
   它不是退回旧故障：同步抛错的 `…spawn 失败：…` 与这条异步路径**共用同一个一次性门闩**；
   若两条路径都触发过，应有且仅有一条 `工具链：进程内回退已在进行（忽略重复触发：…）`；
4. `runtime.python` 就绪后 `finishToolchainExtraction` 会 `setImmediate(ensurePythonBridge)` 补跑自检 ——
   这次自检**不需要重启**就能看到结果。

**手持档本轮实测（手机档，2026-10-07 14:13 CST；`VYG-AL00` / `62T0225B18039433`，API 26）**

装机：`tools/update-device.ps1 -SkipRebuild`（走 `install -r`；`home` 指纹 `links=8 size=3440` 装机前后不变 ⇒ 用户数据保留）。

| 项 | 读数 | 判定 |
|---|---|---|
| 1 · `host-ready.json` | `python:{bridge:true, stdlib:true, ready:true, selftest:"ok", stdout:"2", elapsedMs:86}` | ✅ 对照改前的 `stdlib:false / selftest:"pending"` |
| 2 · `toolchain/python/bin/` | `python3.12` 23,197,504 B `-rwxr-xr-x`（另有 `pip3` / `2to3-3.12` / `pydoc3.12` / …） | ✅ 产物到位 |
| 3 · 回退链 | `解包子进程异常：Error: spawn …/bin/busybox EACCES` → `改用进程内解包（子进程无法启动 ⇒ 本档不能创建进程）` → 7 条 `进程内解包进行中` → `进程内解包完成（写 3482 个文件，跳过 1048 个链接/特殊条目）` → `git 归档不做进程内解包` → `解包收尾 python=OK，git=FAIL` | ✅ 与宿主彩排**逐字一致**（3482 / 1048） |
| 3 · 门闩 | `改用进程内解包` 恰好 **1** 条；无 `进程内回退已在进行（忽略重复触发）` | ✅ |
| 4 · 无重启自检 | `06:13:14.745Z python 桥自检通过：print(1+1)=2（85ms），内嵌 CPython 可用` —— 启动于 `06:13:07`，**同一进程内**完成 | ✅ |
| 端到端 · HTTP 桥 | `hdc fport` 转发后 `GET /dshm-python/status` → `{"ok":true,"bridge":true,"stdlib":true,"ready":true,"initialized":true,"home":"…/toolchain/python"}` | ✅ |
| 回归 · 市场桥 | `[dshm-market-bridge] 已接管市场包操作：profile=ondevice，队列=…/dsh/home/install-queue` | ✅ 未回退 |
| 回归 · 启动洁净 | 本 boot `LOOP-GAP` 实际 **0** 次；`MODULE_NOT_FOUND` / `did not activate` / `ReferenceError` / 崩溃关键字 **0** 行 | ✅ |
| 耗时 | 进程内解包 7.1 s（`06:13:07.455` → `06:13:14.569`），启动期后台完成 | ⚠️ 仅首次；第二 boot 已不再解包 |

**第二次冷启动（稳态，同一台手机，`06:15:00`，`aa force-stop` + `aa start`）**：

```
工具链：python/python3/pip3/git wrapper 已布置（归档解包进行中，就位前 exec 会报 not found）
工具链：后台解包启动（python=false，git apk 15 个），输出见 .extract.log
工具链：解包子进程异常：Error: spawn …/bin/busybox EACCES
工具链：进程内回退无事可做（python 无需解包；原因=子进程无法启动）
工具链：解包收尾 python=OK，git=FAIL（详见 .extract.log）
python 桥自检通过：print(1+1)=2（61ms），内嵌 CPython 可用
exec 探测：python3.12=denied，git=缺，…，bash=denied，toybox=ok
```

- ✅ **不再解包**（`needPy=false`）⇒ 进程内解包只在**首次**发生，不是每次启动都跑（否则每次开机都要白等 7 s）。
- ✅ 回退**幂等**：git 仍 `needGit=true`（15 个 apk）时会再走一次 spawn 失败，但门闩直接判「无事可做」，无磁盘动作。
- ⚠️ **`python3.12` 从 `缺` 变成 `denied`（不是 `ok`）**：文件已在盘上，但 execve 仍被签名域策略拒（`docs/104`）。
  ⇒ **手机档拿到的是「进程内 CPython」，不是「命令行 python3」**；`bash` 同理，仍 `denied`。
  （探针读数只是**启动时刻**的快照 —— 第一 boot 那份 `runtime.exec.measuredAt` 早于解包收尾，所以写的是 `缺`。）

> **未测（如实登记）**：`dshm-installer.js` 的 `extractTar`（本轮把私有 ustar 换成共用 walker）**同属本包**，
> 且按 `docs/107`/`docs/110`，手持档的**市场安装/卸载就是走它**；但它没有 dry-run，要真跑必须**实际装一次插件** ——
> 本轮**未做**（不替用户改插件配置）。离线侧由 `check-tar-extract` 的三条断言兜底：
> `npm: package/ 前缀被剥掉`、`npm: package.json 不被误剥`、`接线: 插件安装器复用同一份 walker`。

---

**PC 档（回归，行为应与改前逐字一致）：**

5. `.extract.log` 里应正常出现 `解包子进程退出（code=0）`，**不应**出现任何 `进程内解包` 字样（说明回退确实惰性）；
6. 写锁新增读数：`写锁保留明细：…` 一行 —— 把它连同 `写锁巡检` 那行一起记下来（§5.4 的定口径输入）。

**PC 档本轮实测（2026-10-07 14:04–14:06 CST，设备 `86E0226429000417`，2in1，API 26）**

装机包：`entry/build/default/outputs/default/entry-default-signed.hap` 与 §10 的
`dist/sideload/DSHM-1.1.0-core0.2.1-alpha.1+dshm.13-arm64-signed.hap` **逐字节同一份**
（295,513,599 B，sha256 `b9eee53e85efeec0…`）⇒ **设备跑的就是 r2 那份**。

| 项 | 读数 | 判定 |
|---|---|---|
| 第 5 项 · 解包子进程 | `工具链：无需解包（python=true，git=true）` | **本轮未触发**（本档稳态无需解包；`.extract.log` 仍是 2026-09-27 那次留下的 0 字节） |
| 第 5 项 · 回退惰性 | 全量日志 **0 处** `进程内解包`／`进程内回退`／`解包子进程 spawn 失败` | ✅ 惰性成立（PC 档未被改坏） |
| 第 6 项 · 写锁读数 | `写锁巡检：发现 22 个，清理孤儿 0 个，保留 22 个` ＋ `写锁保留明细：非pid=22；样例 session.lock(pid=未知，非pid，age=110035s)` | ✅ 已取到 |
| 装机包内宿主层 | HAP 内 `resources/resfile/resources/app/` 14 件与本机 `hostcore/app/` 逐字节一致（含 `tar-gz.cjs` 9,780 B、`main.js` 278,239 B） | ✅ |
| `require` 真解开 | 启动日志 **无** `MODULE_NOT_FOUND`，`BOOT_10_ENV_READY` 正常 | ✅ 这一条才证明 §4.4 的接线在**装机包**里成立 |
| 端侧验收 | `tools/device-acceptance.ps1` 五项自动判定全 PASS | ✅ |
| 核心树指纹 | `tools/device-code-fingerprint.ps1` **5/5** 一致 | ✅ |
| exec 探测 | `python3.12=ok … toybox=ok，git-ls-remote=ok` **10/10** | ✅ |

> **§5.4 的定口径输入到齐了 —— 结论是「不该删」，不是「没删」：**
> 22 个 `.lock` **全部**判 `非pid`。查上游后确认它们**根本不是** `dsh-atomic-write` 的锁：
> 文件名是 `session.lock`，属 `@deepseek-ai/dsh-session-persistence-jsonl` 的 **flock(2) 租约文件**
> （`lib/index.js:677`，`LEASE_FILENAME = "session.lock"`）。同文件 660–671 行的上游注释把边界写死了：
> 锁的是 **inode**，所以**释放时刻意不删该文件**（"the surviving file keeps the stable inode later
> lockers verify against"），并直接点名 **"Removing a live session's lock file therefore forfeits
> exclusion on POSIX"**。
> ⇒ **`session.lock` 永远不许清**；今天的「清理孤儿 0」不是漏清，是「非pid ⇒ 不动」这条判据
> 恰好把它挡在门外（**偶然安全**）。另：全量日志里 `atomic-write: timed out waiting for the
> writer lock` **0 次** ⇒ 真机上原子写锁从未冲突过。
> ⇒ **待办（本轮未做）**：把「租约文件按名豁免」写成**显式**守卫＋注释，替掉这份偶然性 ——
> 否则下一个人照着「22 个孤儿」写清理逻辑，就会踩掉上面那条 POSIX 排除权（会话日志撕裂）。

---

## 7. 可核查的复现命令

```powershell
# 受影响的门禁
node tools/check-tar-extract.mjs          # 33 pass / 0 fail
node tools/assert-exec-fix.mjs            # 38 项断言全过
node tools/place-host-app.mjs             # 14 件快照落到 resfile
node tools/assert-resfile-sync.mjs        # 14 件快照全部同步
node tools/check-resfile-core-zip.mjs     # resfile 只有 1 份容器，且与配方/产出三者一致
node tools/check-dead-code.mjs ; node tools/check-doc-refs.mjs

# 真归档实测（不需要设备；2026-10-07 本机实测 2.85 s）
node -e "const t=require('./hostcore/app/tar-gz.cjs');t.extractTarGzFile(process.argv[1],require('os').tmpdir()+'/dshm-py-probe',{yieldEvery:64}).then(s=>console.log(JSON.stringify({written:s.written,skipped:s.skipped.length})))" entry/src/main/resources/resfile/toolchain/python/cpython-3.12.14-aarch64-musl.tar.gz
# 参考读数（宿主 Windows / Node 24）：ms=2846、written=3482、skipped=1048（全是被跳过的链接）、
#   topLevel=["python"] —— **归档里带一层 `python/` 前缀**：进程内回退解到 `py-stage/`，再由
#   `finishToolchainExtraction` 把 `py-stage/python` rename 成 `toolchain/python/`；宿主磁盘上 3481 个文件。
#   ⚠ 少 1 个的原因：`share/terminfo/E` 与 `e` 在 Windows 上大小写不敏感碰撞（宿主假象，设备侧区分大小写）。
#   4 个锚点（**都带那层前缀**）：python/bin/python3.12=true、python/lib/python3.12/os.py=true、
#   python/lib/python3.12/json/__init__.py=true、python/lib/python3.12/site-packages/pip/__init__.py=true；
#   最长相对路径 106 字符 > 100 ⇒ **PAX `path=` 确实被采纳**（ustar 的名字字段上限就是 100 字节）。

# 设备侧（用户接机后）
.\tools\update-device.ps1                 # 覆盖安装，-r，不动用户数据
.\tools\device-acceptance.ps1             # 端侧验收（只读）
```

---

## 8. 未做 / 待拍板（如实登记）

| 项 | 状态 | 说明 |
|---|---|---|
| 手持档「真 `bash` / 真 shell 进程」 | **未做，且不是本仓可解** | `docs/104` 的三条修法（① 纯 JS 命令翻译层 ② 只读命令走 `toybox <applet>` ③ 收回终端入口）**仍未拍板**；`docs/114` 证明了"外移执行主机"（`hostkit/` + 远程 Host）是另一条门。本轮**没有**擅自实施方案 |
| 手持档 Agent 的**进程内入口**（P1-1） | **待拍板** | 运行时已在本轮变得可用（前置条件），但"怎么给 Agent 用"有三条互斥选项：把 PTC（`dshm-ptc-runtime-inproc`）放进工具集 / 提供不依赖 HTTP 与 exec 的 binding / 不做 |
| P0-1 市场上游文案误判 | **不改** | 上游 `dshmarket/lib/dsh-cli.js:721-735`、`:801-812`、`:858-859`；桥接管后用户不会再看到它。要改就得往核心树注入第 24 处补丁，收益低于风险 |
| P1-2 `statSync` 长停顿 | **待查** | 手持档报告本次 7 次 / 最大 3.4 s；PC 报告当前实例 0 次（判据=心跳线程同时停止 ⇒ 后台冻结）。两档口径不同，需先拿到"热点在哪一段"的读数 |
| P2-1 工作区根 ↔ 会话 cwd 对齐 | **不改** | 属产品口径（`docs/113` 已把登记侧收窄）；空目录时的空态文案可在下一轮讨论 |
| P2-2 技能文档口径 | **已在前轮修** | `ohos-pc.md` / `ohos-python.md` / `ohos-shell.md` / `ohos-workspace.md` 已按档位分叉（见 `docs/106` §4 的裁定） |
| 真机验收 | **未做** | 本轮开工/收工都没有设备在线（§6 的清单留给下一次） |
| `coreVersion` | **未升** | 未碰核心树注入 ⇒ 不升（升了只会白换一次树） |

---

## 9. 与其它文档的关系

| 文档 | 关系 |
|---|---|
| `docs/104`（手持档终端与 bash 的能力判据） | **不变**。本篇是它的**下游**：那条判决说"真 shell 无解"，本篇说的是"**不需要 shell 的那部分**（解包）也不该被它拖死" |
| `docs/110`（`runProfilePnpm()` 的进程内分叉） | **同源**。同一类问题（手持档无进程可用 ⇒ 改进程内通道）、同一种判据（"能跑 ⇒ 完全惰性"） |
| `docs/106`（两份端侧自检报告的分诊与探针读数机器可读化） | **接力**。本篇的两份报告是那一轮之后的下一批；`runtime.python` 的机器可读读数正是本篇 §6 的验收口 |
| `docs/114`（WorkBuddy 的执行外移） | **不变**。它给的"外移"与 `docs/104` 的"内联"不冲突：内联覆盖"必须在本机完成"的功能（本篇的 python 就是），外移覆盖"本机根本做不到"的功能（真 `bash`） |
| `docs/112`（三端审核与正式侧载包） | **沿用其流程**：出包的三个坑（`--place-in-app` / `work/<ver>` 复用要清或升版 / 出包后跑 `check-resfile-core-zip`）与"刷新前断言没有比构建更新的源文件、刷新后断言 dist sha256 == build sha256"两条纪律，本轮照办 |

---

## 10. 本轮的侧载包（`dist/sideload/` · **r2**）

| 项 | 值 |
|---|---|
| 文件 | `dist/sideload/DSHM-1.1.0-core0.2.1-alpha.1+dshm.13-arm64-signed.hap` |
| 大小 / sha256 | **295,513,599 B**（281.8 MiB） / `b9eee53e85efeec0130e7f5b0a653023c8a90b84d8e909ddfc5e3377b06bc1f6` |
| 构建 | 2026-10-07 13:56（`hvigorw assembleHap --mode module -p module=entry@default -p product=default -p buildMode=debug --no-daemon` ⇒ **BUILD SUCCESSFUL**） |
| 与 r1 的差 | **只差宿主应用层**（`resfile/resources/app/**`）：核心容器逐字节不变（59,191,096 B）⇒ `check-resfile-core-zip` 判定三者一致 |
| 退役件 | 同日 **11:57 的 r1**（`bc9196d0…`，295,497,120 B）→ `previous-internal-test/DSHM-1.1.0-core0.2.1-alpha.1+dshm.13-20261007-1157-arm64-signed.hap`（同签名 ⇒ 可直接 `install -r` 回退） |
| 出包纪律（`docs/112` §4） | ① 改 `hostcore/**` 后先跑 `place-host-app.mjs` + `assert-resfile-sync`（**14 件同步**）；② **未跑 `pack-core`** —— 本轮没碰核心树注入，不需要重出容器（重出只会白换一份 zip）；③ 刷新**前**断言「没有比构建更新的源文件」（实测 **0 个**）；④ 刷新**后**断言 `dist sha256 == build sha256`（一致） |
| 未做 | **未装机验收**（出包时无设备在线）。`dist/sideload/README.md` 已把 r2 与 r1 的读数**分栏说明**（r1 那段原说明标注为"保留备查"），避免把 r1 的真机读数读成 r2 的 |
