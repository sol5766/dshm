# 交接说明（HANDOFF）

> 本文给**接手的人**：现在到哪一步、哪些是真结论、哪些还没做、下一步怎么动手。
> 契约类文档（D1/D2/D2b/D3/D3b/D4/D5）不动，见 [`README.md`](README.md) 的索引；本文只讲**状态**。
> 最近一次更新：2026-10-04（§5 补上侧边栏 office 预览的根因、做法与真机验收）。

---

## 1. 一句话现状

鸿蒙 arm64 客户端（`com.dshm.dshclient`，DSHM）已能在 MateBook 14（2in1，OpenHarmony-7.0.0.105 / API 26）上自足跑起端侧 dsh core 0.2.1-alpha.1，界面走 WebView 加载 Host web UI，语音输入、托盘常驻、长时保活均已真机验证。
`DSHM-DEV-TODO-ALL-2026-10-03.md` 的 9 项（D1/D2/D3/N1–N5）**已全部落地并真机核验**（逐项状态见 §5 末段）。
**三个症状（其中两个已定案）**：①托盘/应用启动约 40 秒后自杀（未判因）；②"正在连接"抖动（Windows 端同源；鸿蒙端心跳覆盖 2026-10-03 落盘、**2026-10-04 已回退**，Windows 端从未做）；③原先"启动后一两分钟什么都慢"已于 2026-10-04 **定案并修复**——E388 的 `process.report.getReport()`，见 §4③。①②见 §4。

---

## 2. Windows 端 dsh desktop 重装（用户当前最要紧的事）

### 2.1 为什么不能直接覆盖安装

**官方安装器对"覆盖安装"不做版本回退保护**：直接双击新版安装包通常也能装，但旧版把 Host 与
`%USERPROFILE%\.dsh\host-ready.json` 留在原位，版本错配时最容易出现"界面连不上 Host"而误判成
网络问题。所以**先卸载再装**，按 §2.4 的七步走。

另一个反复踩的误判：更新器缓存里的
`%LOCALAPPDATA%\@deepseek-ai\dsh-desktop-updater\installer.exe`
**往往就是当前已装的那个版本**，不是新版本 —— 指望它做升级是错的。新版包从官方发布渠道取。

### 2.2 现状事实（实测，勿再猜）

| 项 | 值 |
|---|---|
| 注册表 DisplayName / DisplayVersion | `HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*` 里 `DisplayName -match 'DeepSeek'` |
| InstallLocation | **非 per-user 安装**（`%LOCALAPPDATA%\Programs` 下没有 `@deepseek-ai`）⇒ 可装在任意盘 |
| UninstallString | 同上注册表项，形如 `"<install>\Uninstall DeepSeek Harness.exe" /currentuser` |
| Electron 版本 | `<install>\version` |
| 随包 Node/pnpm | `resources\runtime\versions.json` |

> 本节不记录任何一台机器的用户名与绝对路径；装在哪、装的哪个版本，用上表两条命令现取。

### 2.3 必须保住的数据（删了不可恢复）

| 路径 | 内容 |
|---|---|
| `%USERPROFILE%\.dsh` | `sessions\`、`storages\`、`profiles\{desktop,ondevice}`、`dsh-runtimes\`、**`.credentials.yaml`**、`host-ready.json`（实测约 1 GB 量级） |
| `%APPDATA%\@deepseek-ai` | Electron userData（`dsh-desktop\`：Local Storage / Session Storage / Preferences / logs） |

⇒ 卸载/重装**只动安装目录**，上面两处不要碰。
开工前先复制 `.credentials.yaml` 到安全位置（凭据丢了要重新登录，其余数据可重建）。

### 2.4 步骤

1. **先录基线**（下面对比用）：
   ```powershell
   Get-ChildItem "$env:USERPROFILE\.dsh\sessions" | Measure-Object        # 会话数
   Get-ChildItem "$env:USERPROFILE\.dsh\profiles" | Select-Object Name   # profile 列表
   Get-Content "$env:USERPROFILE\.dsh\host-ready.json" -Raw              # 记下当前内容（见下）
   ```
2. **结束所有 dsh 进程**（不结束会锁文件、卸载器报"文件被占用"）：
   ```powershell
   Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
   Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*dsh*' } | Stop-Process -Force
   # 关键的两个：dsh-desktop-host（监听 127.0.0.1:19387）与 billion-context（127.0.0.1:49498）
   Get-NetTCPConnection -State Listen |
     Where-Object { $_.LocalPort -in 19387, 49498 } |
     ForEach-Object { Get-Process -Id $_.OwningProcess } | Select-Object Id,ProcessName,Path
   ```
   上一次观测到的 PID 供对照：主进程 `13056`、gpu `12352`、network service `1836`、
   renderer `12084`、**dsh-desktop-host `2240`**、subprocess runner `13500`/`21292`，
   另有 `node.exe` 跑在 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\billion-context`。
   **PID 会变，按名字/端口杀，不要按上面这些数字杀。**
3. **卸载旧版**（两个办法，任选）：
   ```powershell
   # A. 走注册表里的卸载串（推荐，会清理注册表项与快捷方式）
   $u = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" |
     Where-Object DisplayName -match 'DeepSeek').UninstallString
   & cmd /c "$u"
   # B. 图形界面：设置 → 应用 → 已安装的应用 → "DeepSeek Harness …" → 卸载
   ```
   卸载完确认安装目录已消失、注册表项已消失；**若残留则手动删目录**（只删这个目录）。
4. **清掉过期更新器缓存**（否则新版本可能仍被旧包挡住）：
   ```powershell
   Remove-Item "$env:LOCALAPPDATA\@deepseek-ai\dsh-desktop-updater" -Recurse -Force
   ```
5. **删掉过期的 `host-ready.json`**：它可能残留着**上一轮 PC 侧本地测试**的内容——
   端口是 `3156` 而不是桌面端 Host 实际监听的 **19387**（owner = `dsh-desktop-host`），
   `workspace` 指向一份临时沙箱目录。这就是一份**撒谎的探针文件**，留着会误导排查。
   新版启动会自己重写。
   ```powershell
   Get-Content "$env:USERPROFILE\.dsh\host-ready.json" -Raw   # 先看一眼
   Remove-Item "$env:USERPROFILE\.dsh\host-ready.json" -Force
   ```
6. **装新版**：从官方发布渠道取包（`deepseek-harness-<version>-win-x64.exe`），先验版本与哈希再装。
   ```powershell
   $p = "$env:USERPROFILE\Downloads\deepseek-harness-<version>-win-x64.exe"
   (Get-Item $p).VersionInfo.FileVersion          # 核对版本
   (Get-FileHash $p -Algorithm SHA256).Hash       # 与该版本的发布哈希核对
   Start-Process $p                                 # 双击效果，走图形安装器
   ```
   装完核对：
   ```powershell
   Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" |
     Where-Object DisplayName -match 'DeepSeek' | Select-Object DisplayName,DisplayVersion,InstallLocation
   ```
7. **验证数据还在**：会话数 / profile 列表 / 能正常登录（`.credentials.yaml` 生效）。

> ⚠️ 卸载前**不要**用 `Remove-Item -Recurse` 去"清干净"`%USERPROFILE%\.dsh` 或 `%APPDATA%\@deepseek-ai`——
> 那 1 GB 里是用户的全部会话与凭据。

---

## 3. 鸿蒙侧工程结构（接手必读）

- 仓库根：本仓库所在目录（下文相对路径均以仓库根为基准）。构建产物 `entry/build/default/outputs/default/entry-default-signed.hap`；
  交付件在 `dist/sideload/`。
- **真机数据保全（AGENTS.md 最高优先级，必须先读）**：只允许 `hdc install -r <hap>`；
  禁止 `hdc uninstall` / `bm uninstall` / 任何对 `/data/app/el2/.../com.dshm.dshclient` 的删除。
  el2 里是 `files/dsh/home`（会话与插件）、`dsh/cores`、`dshm-host.log`、`node-output.log`。
- 门禁（改完必跑）：`node tools/assert-cli-shim.mjs`、`assert-resfile-sync.mjs`、
  `check-parity.mjs`、`compat-drift.mjs`、`assert-exec-fix.mjs`、`assert-python-bridge.mjs`、
  `assert-fs-search-fallback.mjs`、`.\tools\device-acceptance.ps1`。另有 `check-dead-code.mjs`、
  `check-dead-handlers.mjs`、`check-feature-wiring.mjs`、`check-arkts-entry.mjs`。
- **改 `hostcore/**` 后必须先 `node tools/pack-core.mjs` 重打 core zip 再构建**
  （`tools/update-device.ps1` 只跑 `assembleHap`，不会自动重打包）。
- 一键构建+装机：`.\tools\update-device.ps1`（Step5 是唯一的装机动作 `hdc install -r`）。
- 设备：`86E0226429000417`，HUAWEI MateBook 14 / `MNTXM-24B` / `devicetype=2in1`。

---

## 4. 未完成事项（按优先级）

### ① 连接抖动「重新连接中 → 连接成功」（Windows 端与鸿蒙端同源）

现象：左下角设置 banner 反复闪「重新连接中 / 连接成功」。

**已定位的机制**（上游源码，两端共用同一 core）：

- Host 侧 `@deepseek-ai/dsh-api-gateway/lib/index.js`：
  `MAX_MISSED_HEARTBEATS = 2`（`:172`）；`startHeartbeat()`（`:241-248`）每 `websocketHeartbeatIntervalMs`
  给每个 OPEN socket 发 Ping，漏掉 2 次 Pong 即 `socket.terminate()`。**默认周期 2000ms**（schema `:597`），
  ⇒ 约 3 个周期（4–6s）无 Pong 就杀连接。
- ★ **误杀机理**：发 Ping 与收 Pong 都跑在 Host **同一个事件循环**上。任务一忙（端侧还是 `--jitless`，无 JIT）
  事件循环被占 ⇒ 计数照涨 ⇒ **健康连接被杀**。上游 README 明写：
  "如果部署的事件循环或网络可能停顿超过该间隔，必须调大此配置"。
- Client 侧 `@deepseek-ai/dsh-client-connection/lib/client.js`：断线 → `emitState("disconnected")`
  → `backoffDelay`（`backoffBaseMs 500` / `factor 2` / `max 1e4`，半抖动）→ 重试前 `emitState("connecting")`
  → 握手成功 `emitState("connected")`。UI `CONNECTING_MIN_VISIBLE_MS = 800`（`dsh-client-ui-settings-general/lib/client.js:242`）。
  ⇒ banner 闪 = **socket 被掐 + 立刻重连成功**。

> ⚠️ **上面这条"误杀机理"只有上游源码依据，不是现场读数。** 早前版本本文写"本端表现为约 6 秒一轮的
> 断开-重连"，那个读数出自**自研连接层**（`connection/src/main/ets/protocol/RemoteMux.ets:294-305` 的
> "5.4s 关闭"），而该层在生产入口**不可达**（生产走官方 Web UI + 官方 gateway，见
> `docs/review-report-2026-09-29.md:39`）。本机实测 `/api/remote.mux` 的 85 次 upgrade 间隔为
> **median 304.7 s / max ≈45.9 h，全期只有 1 个 <10 s** ⇒ **不存在 6 秒固定节奏，本机未复现该症状**。
> 因此这条改动应算**预防性加固**（依据 = 上游 README 的"必须调大"），不算某个已观测缺陷的修复。

**修法**：把心跳周期调大，两个键都要列（patch 的语义是**整块替换**目标 config）：

```yaml
- id: typert-gateway
  name: "@deepseek-ai/dsh-api-gateway"
  config:
    websocketHeartbeatIntervalMs: 30000
    streamInboxBytes: 262144
```

> ⚠️ **2026-10-04：这条覆盖已在鸿蒙端回退，恢复官方默认 2000ms**
> （`hostcore/profile/ondevice/cordis.patch.yml` 的 ⑪ 段现在只留说明、不留 `config`）。理由三条：
> ① 它的依据（下面那段"6 秒成对断开"）出自生产入口**不可达**的自研连接层，本机从未复现该症状
>    ⇒ 它从来不是某个已观测缺陷的修复，只是预防性加固；
> ② 读代码可以确认**判死发生在自增之前**，即回收时刻是 `3 × interval` 而不是注释里写的 `2 × interval`：
>    上游默认 `3 × 2s ≈ 6s`，改成 `30000` 后是 **~90 秒**。它把**半死连接的回收窗口拉长 15 倍**，而
>    "启动后一两分钟什么都慢、之后突然全好"正是这个形态 —— 登录/模型选择/插件市场/插件预览四个
>    症状都走这条 mux 连接，它是这条路径上**唯一的自定义改动**，先复归默认再谈别的原因；
> ③ 恢复首版行为，也让将来追平上游时少一处自定义（用户明确要求过"回到首版那套"）。
> **想重开**：恢复上面的 yaml 与 ⑪ 段，且必须在**回退后先量到现场读数**（默认 6 秒回收是否真的
> 造成重连/卡顿）再决定，不要再只凭上游 README 那句"必须调大"。
>
> ⚠️ 与下面 §4③ 的关系：③ 的现场读数（`127.0.0.1:3120` 在 `boot+8s` 起约 60 s 不收请求）是**这四个症状
> 的另一种解释**，而且有真机日志作证（`dist/_silence2.cjs` 找到 `_h2.log` 一处 **+61.5 s** 的会话内沉默，
> 沉默前后正是"请求排队 → 一次性补齐"）。两者谁是真因，由 ③ 的读数计划（ACCEPT / LOOP-GAP /
> 采样档案）判决。**2026-10-04 判决结果：胜出的是 ③（E388）**——真机 `.cpuprofile` 显示 90.6% 的样本落在
> `getReport()` 这一条同步链上，改用廉价 libc 判定后 60 s 停滞消失；**心跳这条路径真机从未观测到缺陷**，
> 回退保持，但理由不再是它。

| 端 | 落到哪 | 生效代价 |
|---|---|---|
| Windows | `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`（**没有** `typert-gateway` 覆盖 ⇒ 官方默认 2000ms；与鸿蒙端现状一致） | 改完重启 desktop 即可 |
| 鸿蒙 | ❌ **已回退**（2026-10-04）：`hostcore/profile/ondevice/cordis.patch.yml` 的 ⑪ 段不再带 `config` | 若重开需 `node tools/pack-core.mjs` 重打 core → 重建 HAP → `hdc install -r` |

**鸿蒙端落地核验（历史：2026-10-03 落盘 → 2026-10-04 回退）**：当时跑完整链路（pack-core →
assembleHap → `hdc install -r`），设备 `dsh/home/profiles/ondevice/cordis.patch.yml` 里
`- id: typert-gateway` + `config:` + 两个键**都在**（compose 结果，不只是源文件）。⚠️ **但"心跳是否
真的变成 30s"从来没有直接读数**：`dsh-api-gateway` 启动不打印任何配置
（`log(`/`logger`/`ctx.logger`/`console.` 全 0 命中），设备上又找不到 node 二进制
（`--dump-config` 与 Node REPL 都不通）⇒ 只能证明"配置被 compose 进 profile"，不能证明"运行期生效"。
**"没量到就落盘"正是这次回退的第一条教训。**

另有一个已实证的次要触发源：WebView 到 `ws://127.0.0.1:…`（`/api/remote.mux`）报
`ERR_CONNECTION_REFUSED(-102)`，以及 arkweb 自带 30s `NetworkTransactionTimeout`（`node-output.log` 里 206 次）。
宿主进程短时不可达（例如下面 ② 的自杀）也会造成同一现象。

### ② 应用启动约 40 秒后自杀（鸿蒙端，**未判因**）

时间线（本地时间；日志是 UTC）：
`[09:40:03.637Z] --- boot pid=14371`（= 17:40:03，`aa start`）
→ **`[09:40:43.510Z] !! process.exit(0)：停止路径放行，真正退出`**（= 17:40:43，**冷启动后 40 秒**）。
hilog 同步显示整个进程消失、托盘图标被摘（`removeAccessPluginInfo slot: 537591617`
⇒ 确认 `537591617` 就是我们的托盘图标）、长时任务通知被撤（已存在 37.4s）。

**最大嫌疑链**：`host-stop-request` 只可能由 `DshHost.stop()` 写出，其非用户路径调用点只有
`EntryAbility.exitApp()`（`hostruntime` 的 `switchTo/rollbackTo` 已排除，本次宿主在跑）。
`exitApp()` 的触发点只有托盘右键「打开应用」（需人手点，本次没有）与
**`StatusBarTray.subscribeBgTerminating`** 订阅者（`EntryAbility.ets` 内），而它的源头是
`BackGroundAbility.onPrepareToTerminate()` → `StatusBarTray.notifyBgTerminating()`。
⇒ **怀疑系统在启动约 40s 后例行触发该回调，我们把它当成"托盘后台进程已被系统结束"进而关掉整个应用。**

**下一步**：冷启动后静置 90s 看是否复现；复现则在 `BackGroundAbility.onPrepareToTerminate` 与
`notifyBgTerminating` 两侧加日志（含调用栈/caller），确认调用者；再决定是"只摘图标不退应用"
还是"该链整体删掉"。已排除：`appfreeze`/`SIGKILL`/`LowMemory` 全 0 命中；
`/data/log/faultlog/**` 无读权限（查不到崩溃单）。

> **2026-10-04 晚更新（信道缺口 + 机制定案）**：上面「没有 `收到停止请求`」这条推断**不成立**——
> `hostcore/app/main.js:756 log()` 只走 `console.log`（→ `node-output.log`，每次冷启动被截断），
> 只有 `diag()` 才落 `dshm-host.log`（我们唯一能拉回的文件），而 `requestStop` / `requestAppRestart`
> 全用 `log()`。停宿主的两条入口（`NodeRuntime.stop`、`DshHost.stop`）的机制已在本机实证：
> `host-stop-request` → `requestStop()` → 上游 `shutdown.shutdown(0)`（`createProcessShutdown` 的
> `complete` 只设 `process.exitCode`，`profile-boot-BZ2ZjNWi.js:21-25`）→ 整棵树 dispose →
> `@deepseek-ai/dsh-host-webserver/lib/index.js:307-308` 经 cordis `runDisposable`
> （`@deepseek-ai/cordis/lib/index.js:965`）关掉 HTTP server → loop 排空 → `beforeExit` →
> **code 0 自然退出**；`requestStop` 的 1.5 s 兜底 timer 是 `unref()` 的，所以**只有排空超过 1.5 s**
> 才会出现 `!! process.exit(0)：停止路径放行` 行（`_h6.log` 里 15 次有、3 次没有，就是这个差别）。
> ⇒ 这类"自杀"**一定是应用侧某个 `DshHost.stop(reason)` 被调到了**，不是上游自然排空，也不是崩溃
> （`installFailLoud` 对未捕获异常是 exit 1）。`dist/_patch6.cjs` + `dist/_patch7.cjs` 已把
> 「谁按的停止键」变成日常读数：`log()` 镜像进文件、`SERVER-CLOSE … :: <调用者栈>`、
> `!! beforeExit` / `!! EXIT-SNAPSHOT <句柄快照>`、把 `host-stop-request` **文件内容**（= 调用方签名）
> 拼进停止原因，且 ArkTS 侧四处调用点报名（`switchCore`×2 / `rollbackTo` /
> `EntryAbility.stopHostThenExit` / `Index 核心操作`）。本机自检 `dist/_p6test.mjs` PASS。
> **设备侧下一次自杀就会直接打印是哪条 ArkTS 路径。**

### ③ 启动后一两分钟「什么都慢」（鸿蒙端，**未判因；本机不可复现**）

用户原话（m17861/m17885）：**每次启动都慢；登录转圈、模型选择卡「加载中」、插件市场与插件预览都在等
登录**——四个症状共用同一条路径。已实测的现场形态（真机，冷启动）：

- 约 `boot+8s` 起、约 60–80 s 内，`127.0.0.1:3120` 的 TCP **三次握手 1ms 内就完成**，但 `recv` 一直超时
  （sampler 连续 59 个样本 `conn=1…4ms recv=-1 RECV-TimeoutError`）⇒ 连接进了 accept 队列**没人收**；
  `/proc/net/tcp` 的 LISTEN `rx_queue` 单调增长也证明没 accept。
- 同一窗口内宿主 `dshm-host.log` **字节数恒定**（无任何 `diag()`）、进程 CPU 只涨 ~1.4% 单核、所有线程
  停在 `FUTEX`/`EVENTPOLL`；但监听 fd 确实以 `EPOLLIN` 注册在某个 epoll 集合里。
- 停滞结束后积压一次性补齐，**登录全链只花 2.2 s**（`POST /api/account/startSignIn` → 浏览器回跳
  `GET /oauth/callback` → `modelCatalog` → `getProfile`/`getBalance`）。

**已排除**：① 本机复现不了——`dist/_bootprobe.mjs` 用同一份 `hostcore/app/main.js` + 核心树冷启动
150 s，295 次探针只有 7 次 `ECONNREFUSED`（都在 listen 之前），启动爆发 18 个请求全部 49–108 ms，
宿主 stdout 662 行、**无任何 ≥3 s 沉默**；后来又补上 `BOOTPROBE_MUX=1`（原始 WebSocket 握手升级
`/api/remote.mux`，5 次全部 `101`，连接保持 20 s 再重连）**仍不停滞**（177 探针、慢点只有 listen 前的
`ECONNREFUSED`、宿主 stdout 635 行无 ≥3 s 沉默）⇒ 停滞是**设备独有**（剩余差异只可能是 ArkWeb 交互、
设备独有插件、FUSE 路径、busybox/git 包装器、内存/发热节流）；② accept 队列满（`connect()` 立即成功、
`rx_queue` 只有 1–2）；③ libuv 线程池饥饿（4 个 `libuv-worker` 两种状态下都在 FUTEX）；④
`/api/dynamicCordisRunner/*` 端点阻塞（`syncInspectManifest`/`inventory` 是纯内存同步操作）；
⑤ 我们自己的采样器自伤（boot `pid=1129` 那一轮 `IN-REQ` 命中数为 1、`dshm-python` 命中数为 1，都是
启动横幅 ⇒ 那轮既没开 `IN_LOG` 也没跑过 python 桥）；⑥ `@deepseek-ai/dsh-schedule`（停滞前最后一条
请求 `POST /api/schedule/list` 的归属）、`@deepseek-ai/dsh-atomic-write`（`withFileLock` 的退避是
`await new Promise(resolve => setTimeout(...))`，异步）、`recoverOrphanLocks`（宿主唯一一处启动期同步
递归遍历，但调用点在 `main.js:4318`、即 `BOOT_40_PROFILE_BOOT (+335ms)` 附近，早于停滞 8 s）；
⑦ 进程被平台冻结/SIGSTOP（round 2 的 18 个 `/proc/<pid>/stat` 样本 state **全程 S**、pid 恒定 `7359`
（无重启）、`nthr` 79→72、Δcpu 181 ticks / 57.8 s ≈ 3.1% 单核；不过 `S` 不能完全排除 cgroup freezer，
这一点交给采样档案的 A/B 判决）；⑧ python 桥自伤（round 2 里采样器**自己的** socket 探针在 11:07:34
收到过宿主响应，而同一个 python 脚本当时仍在执行 ⇒ 桥跑 python 时不占 JS 线程；本机 `dist/_pytest.mjs`
想再验一次，但本机 python stdlib 未就绪（`stdlib not ready (extraction in progress?)`），结论待真机复验）。

**本轮新增读数（2026-10-04 晚，二次判读 round 2 数据）**：

- `dist/_state.cjs` 读 `_net5.sh` 采样里的 `/proc/<pid>/stat`：停滞窗口 18 个样本 **state 全 S**、
  `nthr` 79→72、`Δcpu = 181 ticks / 57.8 s ≈ 3.1% 单核`；窗口内探针结局 `rc=137 killed=1` ×17
  （3 s 看门狗杀掉）与 `rc=1 killed=0` ×1（恢复瞬间连接被断）。
- 🎯 **宿主自己的日志把「整段没跑 JS」钉死了**：`dist/_s7.txt` 的 631 条 `HOST` 行里，恢复瞬间
  （采样本地时刻 `1791112054309–1791112054311`，≈2 ms）一次性出现 **120 条**宿主日志，其**内容时间戳
  全落在 `11:07:34.078–11:07:34.284`（206 ms 内）**，且**没有任何一条落在停滞窗口
  `11:06:31–11:07:33` 内**；这 120 条里既有一路积压的探针 `GET /`，也有真实客户端请求
  （`POST /api/commands/list`、`POST /api/jet-hub`、`POST /api/dsh-context/detail`、`POST /api/skills/list`）。
  ⇒ 60 s 内宿主**一次 `IN-REQ`（= 一次 accept + 一次 JS 回调）都没有**，恢复时才一次性排空。
- **可加的一步决定性探针（会停掉宿主，建议 opt-in）**：停滞期内写 `<files>/dsh/home/host-stop-request`
  （或 `kill -TERM <pid>`），若宿主 ~2 s 内退出 ⇒ 1.5 s 停止轮询/整条 loop 还活着（偏 H2），
  若迟迟不退出 ⇒ JS loop 整段没在跑（偏 H1）；退出原因串会进 `dshm-host.log`（patch6/7）。
- 🎯 **已加「JS 线程 tid」读数（`dist/_patch8.cjs`，2026-10-04 晚）**：真机上停滞期只能看到一个七十多行的
  线程表（`MainThread`/`.dshm.dshclient` 都重复出现），**无法确定哪个 tid 是 JS 主线程**，而
  `/proc/<tid>/syscall` 在真机不可读 ⇒ H1/H2 判不了。现在宿主启动时读一次 `/proc/thread-self/stat`
  的第 1 字段（= **当前线程**的 tid），写日志行 `JS 线程 tid=…` 并落到 `<files>/dsh-js-tid`，
  `LOOP-GAP` 行同时带 `js-tid=`。于是停滞期 shell 侧**无需任何注入**即可：
  `tid=$(cat <files>/dsh-js-tid); cat /proc/<pid>/task/$tid/wchan; cat /proc/<pid>/task/$tid/stat`
  ⇒ `wchan=futex_wait`/state `R` 自旋 = H1（被同步调用挡住）；`wchan=*epoll*` = H2（loop 在转）。

**候选（未定，别当结论）**：停滞是否紧跟 `/api/remote.mux` 的 WebSocket 升级。`dist/_muxcorr.cjs` 对
`dist/_h*.log` 里 125 次去重升级统计「到下一条带时间戳日志行的间隔」，分布
`<100ms:4 / 100ms-1s:13 / 1-5s:47 / 5-20s:11 / 20-50s:5 / 50-100s:3 / >100s:42`（`>100s` 那批多是
"升级后本会话再无日志"，不可判）；**三次已知停滞确实都在升级后 1–2 s**（`_h2.log` 09:42:42.000→
09:42:43.116、09:49:24.133→09:49:25.166；round 2 `11:06:28.989`→`11:06:31.060`），但样本量不足以定因，
且本机已能复现 101 升级却仍不停滞。

**已知的死路**（别再走）：只靠「沉默间隙的绝对大小」判因。宿主只在启动与入站请求时写日志，沉默是常态；
`dist/_silence.cjs` 在 `dist/_h*.log` 上找到的 198 处 ≥8 s 间隙，最大的全是跨天/设备休眠（165,127.8 s、
66,294.6 s…），其后一律是新 boot 横幅。**但把「沉默 + 一次性爆发」当成签名是有用的**：
`dist/_silence2.cjs`（≥6 s 间隙、分类为会话内 / 跨 boot、并把沉默前最后一条 `IN-REQ` 与爆发后的
`IN-DONE` 配对）在 206 处里筛出**只有 4 处会话内**，其中 `dist/_h2.log` 的 09:49:25.166 → 09:50:26.668
（**+61.5 s**）沉默前最后一条是 `POST /api/schedule/list`，爆发后头 5 行是 5 个 `toybox wget` 的 `GET /`
挤在 26.668–26.673 的 5 ms 内 = accept 队列积压一次性排空 ⇒ **「60 s 不收请求」在宿主自己的日志里就有
证据**（不再只依赖我的探针）；另一处 09:42:43.116（+186.3 s）同形。注意 `_h2.log` 那段时间约每 60 s
一次 boot（09:42:36.574 → 09:47:16.817 → 09:48:17.779 → 09:49:18.630），与下面 §4② 的自杀现象同期。

**读数计划**（设备一回来就跑）：`dist/_verify1.ps1` 一键完成「`hdc install -r` → 轮询
`host-ready.json` 等宿主就位（核心 zip 指纹变了，首启要先解包 26k 文件）→ 预热一轮 → 正式冷启动 →
留 240 s 让用户点【设置→账号→登录】（这 240 s 里**后台并行**跑 `dist/_routeaudit.mjs`：把那 27 条
「停滞前到达的路由」串行+并发各复放一遍、500 ms 一发 `GET /` 探针找无应答窗口）→ 拉日志（含 `dsh-js-tid` /
`dshm-hb.log`）+ 自动拉 `.cpuprofile` 档案 → 打印诊断版自检、
时间轴、H1/H2 粗判，并对每份档案跑 `dist/_prof.js` 输出 A/B/C/A′ 判决」；`_verify1.ps1` 另拉
`dsh-js-tid` 并每 ~250 ms 采一次 `wchan/stat` 写 `jstid-samples.log`（判 H1/H2 的 wchan 直方图），
外加 `dshm-hb.log`（心跳最大间隔 ⇒ H1／(B) 判决段）与 `SYNC-RING`/`SYNC-WARN`/`SYNC-WARN-LOG`/
`SYNC-COUNT` 判读段（含「统计到的大头 ≠ LOOP-GAP 总量」这条读法）。
为此已加这些自证读数（全部**默认开启**，不再需要在宿主进程里跑 python 桥 setenv）：

- 宿主 `ACCEPT #n ip:port`（`hostcore/app/main.js`，包 `server.on('connection')`）——直接回答
  「accept 到底有没有被调用」，不再靠 `/proc` 推断；
- 宿主 `LOOP-GAP <ms>` / `LOOP-ALIVE 第 n 拍`（1 s 一拍看门狗）——判决 (H1) JS loop 被同步操作挡住
  还是 (H2) loop 在转只是没轮到 accept；
- 宿主 **V8 CPU 采样档案**（commit `2e0bf6f`，`dist/_patch4.cjs`）：`LOOP-GAP >= 3000ms` 时自动
  `Profiler.stop` 落盘 `<files>/dshm-diag/dshm-profile-loop-gap-<ts>.cpuprofile`（最多 3 份）再重开采样。
  阻塞发生在**原生同步调用**里时，采样线程照样能采到发起它的 JS 帧；`dist/_prof.js` 给三态判决：
  **A)** 无 ≥5 s 采样缺口 + 非空转同栈连续 ≥1000 样本 ⇒ loop 被同步调用挡住，**档案里直接点名
  `node_modules/<插件>/lib/index.js:<行>`**；**B)** 存在 ≥5 s 采样缺口 ⇒ 采样整段缺失 ⇒ 进程/线程被
  **冻结或节流**（不是 JS 阻塞）；**C)** 空转 ≥50% 且无长非空转段 ⇒ loop 在转但没收请求 ⇒ 查
  accept/事件注册路径。仪器自检 `dist/_blocktest.cjs`（`spawnSync` / `Atomics.wait` / 忙等三种合成阻塞）
  三份档案都正确判成 A) 并逐字点名阻塞行（3930 / 3237 / 2350 样本）；
- 页面 `fetch start|done|fail`（前 300 条全量 + 耗时）、`ws open|close|error`、`rpc start|done`
  （`entry/src/main/ets/pages/WebApp.ets` 的 `OPEN_LINK_SHIM_JS`）——把「点击 → 拿授权 URL → 外开」
  拆成「页面发不出去」（被挡住）与「宿主回得慢」两半，并排除「mux 直到 boot+70s 才 open」；
- **日志开关本身**（`dist/_patch5.cjs`）：`IN-REQ/IN-DONE` 与插件日志时间戳从「运行期 setenv 才开」
  改成**默认开**（`DSHM_IN_LOG=0` / `DSHM_TS_LOG=0` 可关）。理由：原来每次取证都要先用 python 桥
  在宿主进程里 setenv，而那个桥就是在宿主进程里跑 CPython，属于「谁挡住了事件循环」的嫌疑人；
  测量工具不能依赖被测对象。本机自检 `dist/_p5test.mjs`：不设任何 env，`IN-REQ`/`IN-DONE`/
  时间戳横幅/看门狗横幅/`ACCEPT #` 全部出现（PASS）。

- **退出成因读数**（`dist/_patch6.cjs` + `dist/_patch7.cjs`，2026-10-04 晚，一并纳入本计划）：
  `SERVER-LISTENING` / `SERVER-CLOSE <addr> :: <调用者栈 6 帧>`（谁关掉监听句柄）、
  `!! beforeExit code=… exitCode=…（loop 已排空） handles=…`、`!! EXIT-SNAPSHOT …`（退出瞬间句柄/请求快照）、
  六种信号与 `disconnect` 记录、`log()` 镜像进可拉取文件、停止原因串里带 `host-stop-request` 内容
  （= 调用方签名）。本机自检 `dist/_p6test.mjs`：写 `host-stop-request`（含签名）→ 6/6 读数齐备、
  `exit=0`、用时 6.2 s（PASS）。

- **同步调用环 `SYNC-RING`**（`dist/_patch9.cjs`，2026-10-04 晚）：包装同步
  `fs.existsSync/statSync/lstatSync/readdirSync/readFileSync/realpathSync/readlinkSync/accessSync/`
  `openSync/readSync/writeSync/mkdirSync/rmSync/renameSync/unlinkSync/copyFileSync`、
  `child_process.spawnSync/execFileSync/execSync`、`Atomics.wait`：进入即入环（上限 24 条，**零 I/O**），
  单次 ≥1 s 立刻 `diagSync('SYNC-SLOW …')`（同步落盘，进程被杀也不丢），环内 ≥1 s 的另存一份
  `SYNC-SLOW-LOG`（不会被便宜调用挤出环外）。`LOOP-GAP` 行后追加
  `SYNC-RING <最后 12 条：时长（多久前进入）调用名 参数>`。⇒ 挡住 loop 的那个同步调用**直接点名**；
  即使阻塞方是原生/FFI 调用（环尾不变），也能看到它前后是哪几条调用。
  本机自检 `dist/_p9test.mjs`（用 `--require dist/_p9block.cjs` 在宿主里造一次 2.5 s `Atomics.wait`）：
  `LOOP-GAP 3256ms`、`SYNC-SLOW 2500ms Atomics.wait`、`SYNC-SLOW-LOG`、`SYNC-RING`、`js-tid=`、
  恢复后仍 `401`、退出 `code=0`，8/8 检查 PASS。

- **心跳线程 `HB`**（`dist/_patch10.cjs`，2026-10-04 晚）：宿主里再起一个 `Worker`（`DSHM_HB=0` 可关），
  每秒往 `<DIAG_LOG 同目录>/dshm-hb.log` 追一行 `HB <n> <epochMs> <iso> cpu=<utime+stime ticks>`
  （`appendFileSync` 在 worker 自己的线程里跑，与主 loop 是否被挡无关）。⇒ 主线程静默而 `HB` 连续 = **H1**
  （主线程被同步调用挡住，再由 `SYNC-RING`/`SYNC-SLOW-LOG`/`js-tid` 的 wchan 点名）；`HB` 也断在同一段 =
  **(B) 进程级冻结/节流**。worker 必须 `unref()`，否则会拖住主进程的自然排空退出。
  本机自检 `dist/_p10test.mjs`：6 项 5 OK（心跳启动 / HB 12 行 / 与 `LOOP-GAP` 同期 / `cpu=` 单调不减 /
  退出 `code=0`）；1 项 MISS 是**合成阻塞器自身的假象**——`Atomics.wait` 那 3.2 s 里同进程 worker 的
  `setInterval` 也停了（`HB 4 27.228` → `HB 5 30.712` 正好盖住 `LOOP-GAP 3186@30.582`），而启动期那次
  3.27 s 停顿（同步模块加载）期间 HB 连续正常。⇒ 心跳判别力不受影响，但「`Atomics.wait` 期间心跳会不会断」
  在 Windows 本机**尚未孤立验证**（记在这里，别再当结论用）。

- **`dist/_prof.js` 新增判决 A′ + 族直方图**（2026-10-04 晚）：`idlePct < 30 && 覆盖 >= 1000 ms &&
  最长同栈 < 300 样本` ⇒ `A′) 采样不停、覆盖 ms、非空转 99%：loop 整段都在跑「一长串短同步调用」
  （既不是等待、也不是空转）`。旧的三态 A/B/C 只认「同一条栈被连续采到 ≥1000 次」，会把这种
  **每个调用只占几十微秒**的同步洪流误判成「不明」。同时新增族直方图（`esm-sync-loader` /
  `profile-resolution` / `cjs-loader` / `v8-compile` / `fs-sync-*` / `yaml-config` / `inflate-trie` /
  `gc` / `idle`）与「other 族里最多的 8 条链」——未知族必须点名，不能把没归类的当不重要。
  ⚠️ 判族只看**非伪帧**：早期版本拿整条链去匹配 `/\(root\)/`，任何未命中的栈都被算成 `idle`
  （曾把 idle 抬到 28%，真实 idle 只有 0.2%）。

- 🎯 **本机已复现同形态的同步模块加载块**（2026-10-04 晚，`dist/_bootprobe.mjs` 原配方空 home：
  `--jitless --experimental-sqlite --expose-internals`）：每次冷启动都有一段 **3.2–3.4 s 的同步
  模块解析/加载/编译**（`LOOP-GAP 3357ms`），期间零 accept、零日志，之后一次性恢复 = 真机
  「冷启动后 ~60 s 完全静默再爆发」的同形态、小规模版本。档案
  `dist/bootprobe/sandbox_A/dshm-diag/dshm-profile-loop-gap-*.cpuprofile`（2020 样本 / 覆盖 3213 ms /
  **无 ≥200 ms 采样缺口**）判 **A′**，族直方图：`esm-sync-loader 45.2%`、`other 18.7%`、
  `cjs-loader 15.0%`、`profile-resolution 12.5%`、`fs-sync-read 3.2%`、`yaml-config 2.2%`、
  `fs-sync-stat 1.2%`、`gc 0.9%`、`inflate-trie 0.8%`、`idle 0.1%`。链上点名的是 dsh 自己的运行时拦截：
  `installRuntimeInterception @…/lib/index.js:1656` → `ResolutionRouter:1355` → `compileResolution:1185` →
  `canonicalPath:1173` → `collectInstallationScopePackages:681` → `readPackageManifest:673`
  （+ `composeProfile @…/profile-boot-BZ2ZjNWi.js:205` → `runProfile:224`），以及同步 ESM 钩子
  `makeSyncRequest @node:esm/hooks:632 ← resolveSync ← #resolveAndMaybeBlockOnLoaderThread`。
  ⇒ 目标①的**首选机制候选**：首次用到的模块树在同步解析/加载（真机 10 个 bundle + 6 个第三方插件 +
  eMMC/冷缓存；本机 2 个 bundle 就 3.2 s ⇒ 真机 60 s 量级合理）。**待真机档案证伪或证实。**

- **A/B 反证：`--expose-internals` 去不掉**。`dist/_bootprobe.mjs` 新增 `BOOTPROBE_INTERNALS=0` 与
  `BOOTPROBE_SUFFIX=_x`（A/B 两次运行互不覆盖 home/timeline）。同配方两轮：带它时 `LOOP-GAP 3357ms`、
  第一发成功探针 +3582 ms；去掉后宿主**启动即失败**（`dsh-app-boot/lib/index.js:4120 boot()` →
  `runProfile` 抛错 → 我的 `fail()` 路径 `code=0` 退出，89/89 探针全失败）。⇒ 这条**同步**加载路径正是
  `--expose-internals` 买来的（`@deepseek-ai/cordis-plugin-loader/lib/index.js:11-38` 用
  `requireInternal("internal/modules/esm/loader").getOrInitializeCascadedLoader()` 拿内部 loader 再
  `resolveSync`），但删掉这个参数宿主根本起不来，所以不能靠「去掉参数」解决。
  另测 **`NODE_COMPILE_CACHE`**（同配方冷/热两轮，`dist/ccache`）对 `LOOP-GAP` 无影响
  （3485 / 3328 ms，缓存目录只有 1 个文件、0 B）——`--jitless` 下没有 JIT 编译产物可缓存，这条路不通。

- **同步调用环升级：从「只看最后 12 条」到「能看出形状」**（`dist/_patch11.cjs`，E94/E95，2026-10-04 晚）。
  patch9 的 `SYNC-RING` 只能回答「最后 12 条同步调用是谁」：一次**巨型**调用（例：一次 58 s 的
  `readFileSync`）能被 `SYNC-SLOW` 直接点名；但真机最可能的形状是**一长串中等调用**（每次几十~几百 ms，
  累计 60 s）——它们单次都不到 1 s（一条 `SYNC-SLOW` 都不会有），又会被便宜调用挤出环外。故新增：
  `SYNC-WARN`（单次 ≥200 ms 立即同步落盘，上限 600 行 ⇒ 停滞期**实时流**：是「1 条 58 s」还是
  「600 条 100 ms」一眼可辨）、`SYNC-WARN-LOG`（环里最近 24 条 ≥200 ms，随 `LOOP-GAP` 打印）、
  `SYNC-COUNT`（按调用名累计**次数/总耗时**，`LOOP-GAP` 时打 Top12 ⇒ 耗时归谁：`statSync` 洪流＝解析、
  `readFileSync` 洪流＝加载、`openSync/readSync`＝冷 eMMC I/O、`spawnSync`＝子进程）。5/5 hunk，
  `node --check` rc=0，自检 `dist/_p11test.mjs` **PASS 12/12**（含「实时 SYNC-WARN ≥2000 ms」与
  「SYNC-COUNT 记到了 Atomics.wait」）。`diagSync` 走 `fs.appendFileSync`（不在被包装名单里）⇒ 不会自递归。
- ⚠️ **校准读数（必读，别把 SYNC-COUNT 当总数）**：本机那次 3.4 s 启动块里，`SYNC-COUNT` 只统计到
  **490–506 ms**（`readFileSync×2213=209ms ⏐ realpathSync×1909=182ms ⏐ existsSync×2022=84ms ⏐ statSync×335=11ms …`）
  ⇒ 被包装的 fs/子进程入口只占整段的 **~1/7**；剩下的大头在 V8 **内部**（ESM/CJS loader 用内部绑定读文件、
  `v8 compile`），我们的包装器看不见。所以真机停滞期若 `SYNC-COUNT 总耗时` 远小于 `LOOP-GAP 值`，
  那**不是**「没有同步调用」，而是「大头在包装面之外」——此时只有 `.cpuprofile` 的族直方图能点名
  （本机 45.2% 落在 `esm-sync-loader`）。这条已写进 `_verify1.ps1` 的判读文字。
- **排除一个候选：同步 SQLite**。`--experimental-sqlite` 是启动参数，`@deepseek-ai/dsh-session-query-sqlite`
  里面 `const { DatabaseSync } = await import("node:sqlite")` 后所有查询都是**同步 native**（`.get()/.all()`），
  理论上「一个同步调用挡 60 s」很合形状。但**两层 profile 层都把它钉成永不打开**：
  `node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:143-149` 与
  `node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml:22-30` 都是
  `- id: session-query-sqlite` + `path: ':memory:'` + `openAt: never`；全树 grep `openAt` 只有这两处（另两个
  命中是前端 pdf.js 与插件自身的 schema），我们的 `hostcore/profile/ondevice/cordis.patch.yml`、home 层、
  真机 live profile 都没有覆盖它 ⇒ **SQLite 在端侧从未被打开**，这条候选可以划掉（不要再翻）。
- **本机加 bundle 数的实验（负结果）**：`dist/core/devlike/dsh-core-0.2.0-rc.2/` 用 **Junction** 拼出真实核心树
  （顶层 `node_modules`）＋ `profiles/ondevice/` 只列本机存在的 4 个 `@deepseek-ai/*`（`dsh-base`/`dsh-web-app`/
  `dsh-experimental-auto-review`/`dsh-experimental-schedule-bundle`），`_bootprobe.mjs` 新增 `BOOTPROBE_CORE_DIR`
  指过去：`LOOP-GAP 3383ms`（对 2 bundle 的 3357 ms **无差别**）、档案 `nodes=5227 samples=2039`、`>=3s 沉默间隙 0 处`。
  ⇒ 本机加 bundle **不会**拉长同步加载块，也仍复现不出「HTTP ready 之后的停顿」；设备侧 6 个第三方 bundle
  （`dsh-skin-market`/`dsh-our-free-model`/`dshmarket`/`dsh-codearts-auth`/`dsh-context`/`dshm-dev-link`）本机全都不存在，
  照搬不了设备 profile ⇒ 真机 60 s 只能靠真机档案定因。

- 🎯 **停滞前那一秒到底到达了哪些请求（真机日志逐行取全）**。`dist/_s7.txt` 的 HOST 行共 631 条，
  范围 `11:06:27.906`–`11:08:57.838`，而**停滞窗口 `11:06:31.060`–`11:07:33.598` 内 HOST 行数 = 0**。
  窗口前 `11:06:28.300`–`11:06:30.100` 共 46 行，**最后 12 条**是：
  `29.643 POST /api/session/modelCatalog`、`29.654 POST /api/settings/describe`、`29.723 GET /`（探针）、
  `29.725 POST /api/dynamicCordisRunner/syncInspectManifest`、`29.735 GET /favicon-dark.svg`、
  `29.738 GET /favicon.svg`、`29.742 POST /api/credentials/describe`、`29.898 GET /`（探针）、
  `29.970 POST /api/schedule/catalog`、`29.972 POST /api/agentPresets/list`、`29.978 POST /api/schedule/list`、
  `29.987 GET /`（探针）。整段 46 条里还有 `28.989 IN-UPGRADE GET /api/remote.mux`、
  `29.618 POST /api/session/list`、`29.515 GET /plugins/events`、`29.518 GET /api/our-free-model/events`、
  `29.274/29.626 POST /api/dynamicCordisRunner/inventory`、`29.141/29.142 GET /api/our-free-model/announcements|meta`、
  `29.381 GET /open-in-app/apps` 等（27 条 API 路由已逐条抄进 `dist/_routeaudit.mjs` 的 `SEQ`）。
  两次独立停滞（round 2 的 `11:06:29.978`、`_h2.log` 的 `09:49:25.166`）**最后一条真实请求都是
  `POST /api/schedule/list`** ⇒ `schedule/list` 进嫌疑名单，但这只是**到达顺序**，没证明因果
  （它由 `dsh-schedule/lib/typert.host.js:427` 暴露；本机 2-bundle profile 无 schedule bundle ⇒ 本机 404，复放不了）。
  另注：`POST /api/jet-hub` 是**每 60.0 s 一发**的客户端轮询 ⇒ 日志里看到「间隔 60 s」多半是它、不是停滞；
  判停滞必须看「探针连上但不回包」或 `LOOP-GAP`。
  会话列表链（本机读源码，用于判「攒了几周会话会不会拖慢冷启动」）：
  `dsh-api-session-controller/lib/index.js:1888 async list(signal)` → `dsh-session-query/lib/index.js:95-116 async listSessions(signal)`
  → `dsh-session-persistence-jsonl/lib/index.js:2603 async list(options)` → `listArtifacts(signal)` `:3065-3091`
  对**每个**已存会话做 `listGenerations()`（`:3038-3046`）+ `readGenerationHeader()`（`:3093-3127`，读首行、必要时
  `zstd` 首帧解压、`JSON.parse`）+ `stat` ⇒ 列一次会话表 = O(会话数) 次小 I/O；同步原语只有 `:3 readdirSync`
  （仅 `:3409-3416 assertUsableRoot()` 用）。本机 home 里**一个会话都没有**（只有 `install-queue/`、`profiles/`、
  `storages/workspace.json`、`.credentials.yaml`、`host-ready.json`）⇒ 本机 `POST /api/session/list` 永远 0 工作，
  「设备攒的会话把冷启动拖慢」这条**本机无法验证**，只能看真机 `IN-DONE POST /api/session/list <ms>`。
- **新工具 `dist/_routeaudit.mjs`（PC 侧，经 `hdc fport tcp:3120 tcp:3120` 直接打设备宿主）**：不必等用户点登录，
  宿主一就绪就把上面那 27 条 API 路由复放一遍 —— `Pass A` 串行逐条（归因单条路由）、`Pass B` 并发爆发
  （`keepAlive`、`maxSockets:8`，复现争用），全程另开 500 ms 一发的 `GET /` 探针（3 s 超时）推断「宿主无应答窗口」，
  爆发后再盯 `--watch`（默认 25 s）——设备上正是「爆发之后立刻 60 s 静默」。用法：
  `node dist/_routeaudit.mjs --port 3120 --token-file dist/verify1/host-ready.json [--timeout 20000] [--watch 45]`；
  输出判决行 + `dist/routeaudit/routeaudit-<ts>.json`（逐条 `started/ms/ttfb/status/len`）。
  本机验证（bootprobe 起的本机宿主、2-bundle 空 home）：27 条全绿、`settings/describe 36ms/33333B`、
  `session/list 1ms/268B`、`dynamicCordisRunner/inventory 1ms/91B`、`GET /` 探针 13 发 0 失败、无应答窗口 0 段；
  设备独有的 `our-free-model/*`、`open-in-app/apps`、`schedule/*` 在本机是 404（本机没有那些 bundle/插件，设备上有）。
  ⚠️ 两个坑都在脚本里修掉了：① `GET /plugins/events` 与 `GET /api/our-free-model/events` 是**长连事件流**，
  本来就不回 end —— 早期版本把它们记成「20 s TIMEOUT」，判决行因此误报「最慢落在 GET /plugins/events」；
  现在这两条只量 ttfb（拿到响应头即成功、随即断开）。② 盯守窗口必须延续到爆发**之后**，否则漏掉「爆发后转静默」。
- **`dist/_verify1.ps1` 新增 6a/7 步**：宿主就位后立刻 `hdc file recv $F/dsh/home/host-ready.json` 到
  `dist/verify1/host-ready.json`，再**后台**起 `_routeaudit.mjs`（`--watch 45`），与 6/7 步的 250 ms `wchan/stat`
  采样**并行**跑完 240 s 登录窗口 ⇒ 停滞一旦被触发，同一时刻有四份对齐读数：探针失败窗口（routeaudit）、
  `jstid-samples.log` 的 wchan、`dshm-hb.log` 的心跳断档、patch4 的 `.cpuprofile`。
  7/7 之后新增「路由延迟审计」段打印判决与关键行（全文 `dist/verify1/routeaudit.out.txt`，明细 json 在
  `dist/verify1/routeaudit/`）。脚本仍是 UTF-8 **带 BOM**（`edit` 会吃掉 BOM，改完必须
  `[System.IO.File]::WriteAllText($f, $t, (New-Object System.Text.UTF8Encoding($true)))` 再
  `[Parser]::ParseFile` 验 0 error —— 少 BOM 时 PowerShell 5.1 按 ANSI 读，中文串会把语法读崩、报一堆假错）。

- **冷/热对照读数：`dist/_bootgaps.mjs`（按 boot 段切分 `dshm-host.log`）**。一次取证里日志是**追加**的，
  里面有「装完首启（4/7）→ 预热重启（4b/7）→ 正式测量」三段 boot。脚本按 `--- boot pid=` 切段，打印每段
  「行数 / 最大 LOOP-GAP / 次数 / 心跳最大间隔（给 `--hb`）」并附最大那次的 `SYNC-RING`/`SYNC-WARN-LOG`/
  `SYNC-COUNT` 上下文，最后给冷/热对照判决：第 1 段 60 s 而第 2 段只有 3 s ⇒ **冷缓存/冷 eMMC I/O 放大**
  （页缓存预热、提前异步读能显著改善）；两段同量级 ⇒ **不是冷缓存**，是固定的同步工作量
  （模块数/解析/编译/插件数）。这也正是本机（SSD、热缓存、2 bundle、0 会话）复现不出 60 s 的原因：
  真机的放大因子在**存储层**，本机把 CPU 侧形态复现出来了、把 I/O 侧放大丢掉了。
  自检：`dist/_bg_fixture.log`（合成「冷 60123ms / 热 3122ms」两段 + `--hb`）判决正确；真机旧日志
  `dist/_h6.log`（11,150 行）正确切成 114 段 boot。`_verify1.ps1` 的 7/7 之后新增「每轮 boot 的 LOOP-GAP
  对照」段自动跑它（`--json dist/verify1/bootgaps.json`）。

**🎯 2026-10-04 定案并修复（E388）：冷启动后 ~60 s 全静默的真根因 = `flock.js` 里的 `process.report.getReport()`。**

读数链（三个自证埋点 + 一次 `.cpuprofile`）：① 心跳线程连续（`dshm-hb.log` 每秒一行、`cpu=` 单调增）
⇒ **进程没被冻**，是 JS 主线程被**同步**调用挡住；② `LOOP-GAP 62915ms`，而 `SYNC-COUNT 同步调用总耗时 425ms`
（包装过的 fs 只占 0.4 s）⇒ **大头在包装面之外的 native**，只看 fs 记账会误判成「没有同步调用」；
③ `.cpuprofile`（61,621 样本）判决 **A**、**最长连续非空转同栈 55,829 样本（≈55.8 s、自耗时 90.6%）**，整条链是
`getReport @node:internal/process/report ← loadBinding @…/node-addon-system/lib/flock.js:6 ← errno ← tryLockExclusive
@…/node-addon-system/lib/index.js:700 ← SessionWriteLease.acquire`。
根因是我们自己的 **E103 平台门**（`platformRaw` 不是 win32/darwin 就一律当 `linux`）放行了上游
「openharmony 直接抛 `ERR_FLOCK_UNSUPPORTED_PLATFORM`」的那条分支，把**快失败**变成 **56 s 同步停顿**。
修法：`tools/pack-core.mjs` 里重写 `flock.js` 的模板不再调 `getReport()`，改读 `/proc/self/maps` 判 glibc/musl
（判不出按 musl）——两个 libc 变体本来就是同一份占位文件、都由 `.node` 处理器按 basename 重定向到
HAP `libs/arm64/libsystem.so`，判哪个目录**不影响加载**。
真机复验（同一台设备、同一冷启动窗口）：`LOOP-GAP` **0 条**、`.cpuprofile` 转储 **0**、
`session/modelCatalog` 首次 **66,503 ms → 4,535 ms**（随后 58–222 ms）、最慢 4.5 s、无 ≥10 s 请求；
预热后第二次冷启动同样 0 条。详见 `70-鸿蒙移植踩坑与修复总览.md` §13。

当前构建：`entry/build/default/outputs/default/entry-default-signed.hap` = **320,195,241 B**（核心升到
`0.2.1-alpha.1` + E388 修复 + patch6/7/8/9/10/11），sha256 `60eb817f094be90419eb28becdf55dacd6bb9f6cfd44bdd5517bea9651920c7c`
（unsigned 318,182,482 B）；
核心分发包 `dist/core/dsh-core-0.2.1-alpha.1-openharmony-arm64.zip` = **84,003,922 B** / 30,451 条目，
sha256 `7103724994614f2321d45a8d64f09c1ede379fde698e99eb52992c61d4c826e3`；
备份 `dist/fallback/DSHM-core0.2.1a1-320195241.hap`；另有 DSHM-E388-314329793 / patch11 314,325,699 /
patch10 314,325,699 / patch9 314,321,604 / patch8 314,317,507 / patch6 314,317,511 / patch5 314,309,739 /
patch4 314,309,738 / patch3 314,309,740。
⚠️ **signed 体积会撞车**（patch10 与 patch11 同为 314,325,699 B）
——**核对产物靠 sha256 + 内容**（`resfile` 里 `main.js` 252,510 B、含 `SYNC-COUNT`/`dshmSyncNote`；
HAP 内核心 zip 的条目名就是新版本号、抽出的 zip sha256 与 `dist/core/` 一致，
其 `…/node-addon-system/lib/flock.js` 含 `/proc/self/maps` 且**已无** `getReport` 调用）。
真机：`hdc install -r` 已装并复验通过（`BOOT_10_ENV_READY core=…/dsh/cores/0.2.1-alpha.1`、`LOOP-GAP` 0 条）。

> **hilog 取证纪律（血泪）**：缓冲区只有 4MB，**实测只覆盖约 8–10 秒**。
> 清空 → 立刻动作 → 数秒内 dump。`entry/tray`、`entry/background`、`testTag` 在事后 dump 里
> 0 命中**不代表日志没打**。另：**不要用 `hdc shell 'cmd | grep A|B'`**（`/bin/sh` 会报
> `B: inaccessible or not found` 并挂死命令）。

### ③ 交付前最终验收

产物已就绪：`dist/sideload/DSHM-1.0.0-arm64-signed.hap`（**299.61 MiB / 314.17 MB / 314,166,762 B**，
sha256 `e8ef8be567f9a2b9c40d17c6a0dd2e3664c626b98069a1eb2afcd9644c4d8060`）。
**注意这里是 2026-09-30 按 `docs/90` §9.2 四步刷新过的那一份** —— 刷新前 `dist/sideload/` 里那份
（299.5 MB / `4e776ecf6b573862…`）**落后一整个核心版本**（仍嵌 `dsh-core-0.2.0-rc.1`，且缺托盘图标、
`dshm-compat.js`、`dshm-skills.js`）。

**2026-09-30 已做**（详见 `docs/device-validation.md` 批次三十八）：

- `tools/func_test_final.py` 真机复测 **PASS=38 / FAIL=0 / MANUAL=6** —— 上一轮两条失败断言
  （`T0.4 Host HTTP 有响应`、`T2.4 会话列表渲染历史会话`）**均已转绿**；主进程连续存活约 4.7 h，
  40 s 自杀未复现。
- `tools/device-acceptance.ps1` 首跑报 4 项 FAIL，**全部是脚本自身缺陷**（hilog 当判据、导航路径写错、
  两条判据结构性取不到）⇒ 已重写为 307 行并复跑 **5 项判定全 PASS**
  （证据 `dist/acceptance/20260930-120131/`，含 `nav.md`：设置九个分区逐个点开全部 OK）。

**仍剩**：`report.md` 里的人工清单需逐条勾选（命令面板、计划模式、轨迹、插件启停、工作区删除/归档、
核心切换/回滚、**文件变更流**——该项因无稳定信号已从自动判定降级）；文档走查
`docs/device-validation.md` 批次三十六/三十七/三十八。

**2026-10-03 续记**：`tools/device-acceptance.ps1` 又修了一处**脚本自身缺陷** —— 六个 hilog 摘录
（`boot/connect/errors/features/trace/hilog-early.log`）**恒为 5 B 空文件**。根因：`Save-Log` 用
`hilog -x | grep …` 当判据，而本机 hilog 环形缓冲只覆盖约 8–10 s、ArkTS 侧 domain 也从未进过可读缓冲
（见 §4② 的纪律框）⇒ 摘录注定为空。现改为**三源合并**：hilog（尽力而为）+ 设备侧持久日志（权威，
`node-output.log` 与 `dshm-host.log` 已经精确切片到本轮 boot），并在 0 命中时写一行
`# 本机没摘到 —— 不是"没问题"，是这几条信号本轮确实没出现；请回原始 device-*.log 复核`，
避免"空文件"被读成"没信号"。复跑（`dist/acceptance/20261003-160344/`）：`boot.log` 711 B /
`connect.log` 1558 B / `hilog-early.log` 2024 B，`report.md` 5/5 PASS、`nav.md` 11/11 OK。

### ④ 开源推送（**已完成**：GitCode + GitHub，两边都已覆盖为新血统）

本地提交链（7 个）：`e7b5ed7` 初始公开版本 → `32e1710` 开源前加固 → `33e9631` 签名配置移出跟踪
→ `826dc09` 补齐构建必需源码 → `33662bd` 文档修正 → `07f97c5` 面向新读者整理 → `4995f3a` 文档索引对齐。

**GitCode**：`git@gitcode.com:u010189254/dshm.git`，本机 `~/.ssh/id_ed25519_gitcode` 已在账号注册。
远端原有 master 是**无关的旧项目**（`a6bfe14`，另一套 `deepseek-harness.rb` 补丁集），
覆盖前已留本地备份 ref `refs/backup/gitcode-old-master`，再 `--force` 覆盖；tag `v1.0.0` 已推。
**SSH 足够，不需要 token**（`tools/publish-gitcode.sh` 那条 HTTPS + PRIVATE-TOKEN 的路没用上）。

**GitHub**：`sol5766/dshm`，同样先备份再覆盖（远端原 `main` `4989ce5` 存为
`refs/heads/backup/pre-dshm-import`）。⚠️ **本网络 `github.com:443` 不可达**（`api.github.com` 可用），
且令牌无权管理 SSH 密钥（`/repos/.../keys` 与 `POST /user/keys` 均 403）⇒ **git 传输走不通**，
改用 **Git Data API** 导入（blob → tree → commit → ref），脚本 `dist/_gh-import.mjs`。

⚠️ **两端的 commit id 不同**：远端 `main` = `ea4b5608`（本地 `4995f3a`），7 条一一对应但 id 全不同。
原因 **不在内容**：根 tree sha 完全一致（`416690fd`）、477 个 blob 与 173 个 tree 的 sha 逐个相同、
author/committer 时刻相同。差异只在 commit 对象的元数据，且用 GitHub 返回的字段**重建不出它给的 id**
（见 `dist/_diag-commit2.mjs`）⇒ 属 GitHub 内部改写。**描述口径**：文件树与本地完全一致，
提交 id 因 GitHub 重写提交元数据而不同 —— 不要说「与本地逐字节相同」。
（副产物：`826dc09` / `33662bd` 的标题行本地就带 BOM，一并带了过去。）

**Release**：GitHub `v1.0.0` 已重发（原 release 挂的是旧血统的 2 MB `entry-default-signed.hap`，
已删）—— 现挂 `DSHM-1.0.0-arm64-signed.hap` 314,166,762 B + `SHA256SUMS.txt`，
上传后 API 返回的 `digest` 与本地 sha256 **逐字符一致**。**GitCode 侧尚未建 Release**（需个人访问令牌）。

**待用户处置**：GitHub 上另有一条旧血统的 `feat/embedded-runtime` 分支与 4 个旧 release
（`v1.1.0` / `v2.0.0-debug` / 一个 draft `v1.0.0`）**仍在**，本次只覆盖了 `main` 与 `v1.0.0`；
仓库描述有一处笔误（`deepseek harnes`）与一个无关 topic（`sentation`），**令牌权限不足，改不了**。

### ⑤ `.codegenie\`（已定：留本地，不入库）

仓库根下的 `.codegenie\`（449 MB，内含嵌套 `.git`）**已定保留在本地**：它是本地工具的工作目录，
开源不需要，因此不进版本库（`.gitignore` 已忽略）。同类的还有 `dist/`、`.probe/`、`.research/`、
`entry/build/`、`.hvigor/` —— 判据是**"开源要不要"**，不是"有没有用"。

---

## 5. 已完成的（不要再重做）

- **端侧核心自足运行**：core 0.2.1-alpha.1 打进 HAP，`libdshhost.so` 与应用同进程起 Node 线程；
  exec 探测 7/7（`python3.12`、`git`、`git-core/git`、`git-remote-http`、`rg`、`bash`、`git-ls-remote`）。
- **语音输入**：HMS `SpeechRecognizer` 桥接，已作为独立插件 `ohosSenseVoice` 开源在 GitCode。
- **系统托盘常驻**（`statusBarManager`，来自 **HMS** 的 `@kit.DeskTopExtensionKit`，不是 OpenHarmony SDK）：
  - 新增 `entry/src/main/ets/system/StatusBarTray.ets`、`entry/src/main/ets/backgroundability/BackGroundAbility.ets`；
    `module.json5` 声明 `BackGroundAbility`（`processMode = NEW_PROCESS_ATTACH_TO_STATUS_BAR_ITEM` + `STARTUP_HIDE`，
    无 `skills` ⇒ 不进启动器）；`rawfile/tray_{white,black}.png`（由 `tools/make-icon.py` 生成）。
  - 关闭按钮 = 切后台（`onPrepareToTerminate` 返回 `true` + 最小化）；
    **托盘图标未就绪时必须放行关闭**（`StatusBarTray.isReady()`），否则用户没有回程入口。
  - 托盘右键最终形态：**系统自带的「退出」** + 我们的「打开应用」（`notifyOnly` + menuCode）；
    左键点图标 = 唤回主窗。真机验证过：图标在顶栏 `[1853,5][1913,68]`，进程对 `ps` 可见
    `com.dshm.dshclient:entry:BackGroundAbility:<n>`。
  - **「退出应用」已从顶栏「DSHM」菜单移除**（按用户要求：紧邻窗口三键的"关闭"已是切后台，
    把"真退出"放同一视觉区域极易点错）——退出统一走托盘右键。
- **长时保活**：`KeepAlive`（`backgroundModes: ['dataTransfer']`）已接线并真机验证。
- **品牌与启动**：图标、启动页（`#F3F7FB`）、启动耗时（`BOOT_10_ENV_READY … BOOT_70_HTTP_READY +3592ms`）。
- **文档**：D8（`70-`，按主题的坑库）、D9（`90-`，端到端全流程，5177 行）已完稿。

### `DSHM-DEV-TODO-ALL-2026-10-03.md` 九项落地状态（2026-10-03）

| 项 | 落点 | 真机核验 |
|---|---|---|
| **D1** 皮肤市场行无限累积 | `hostcore/app/dshm-user-rows.js`：`carryForeignTopLevelEntries()` 里对 `SKIN_MARKET_PACKAGE` 去重 | 设备 `<profile>/cordis.patch.yml` 从 58 份降到 **1 份**（2,925 → 2,625 B） |
| **D2** `version-exemptions` 报「缺少 coreDir」 | `main.js` `compatOpts` 补 `coreDir: CORE_DIR` | 投递 `.compat-req` 后 `.done` = `{"ok":true,…,"exemptions":{}}`，错误消失 |
| **D3** `cd ~` 后 `pnpm add` 落到 `files/node_modules` | `main.js` `shimDirResolveLines()`：`$PWD` 分支加 `profiles/*` 形状检查 + `--profile` → `host-ready.json` → `ondevice` 回退链 | 两种 cwd 下 `.dir` 均 = `…/profiles/ondevice` |
| **N1** `raw.githubusercontent.com` 被 TLS reset | `hostcore/app/fetch-shim.js` 新增镜像改写层（`DSHM_FETCH_MIRROR_PREFIX` / 关断 `DSHM_FETCH_MIRROR=0`） | `node-output.log` 里 `DSHM-MIRROR` 命中 3 次；`.dsh-skin-market/catalog.json` 拿到完整 **302 条** |
| **N2** `dsh-our-free-model` 源顺序写反 | **不改插件源码** —— 该链经 `globalThis.fetch`，由 N1 垫片覆盖 `raw.githubusercontent.com` | 同上（raw 首跳被改写，撞墙消失） |
| **N3** `dshmarket` 备用代理 `ghfast.top` 已死 | **不改插件源码** —— 垫片 `mirrorTable()` 已含 `ghfast.top` 换主机项 | 同 N1 |
| **N4** 侧栏 `files` 页签被占死 | 根因 = `SidebarRightTabRegistry.register()` 取号非原子（`ids.add` 后 `refresh()` 抛错 ⇒ id 永久占死）。`tools/pack-core.mjs` 新增 `patchSidebarTabIdLeak()`（标记 `DSHM_TAB_ID_GUARD`）在异常路径回滚 | 只读区与核心树里标记 **各 1 处**；`tools/check-sidebar-tab-id-guard.mjs` 9/9 PASS；⚠️ 浏览器 console 实证**取不到**（本机 ArkWeb 不投递 `.onConsole`，`diag-web-console` 文件从未生成） |
| **N5** 侧栏终端未接线 | `hostcore/profile/ondevice/cordis.patch.yml` 的 `terminal-bash` `shellPath` 改 `/usr/bin/zsh` | **真机端到端打通**（三条独立证据）：① 布局树出现 `[tab] "zsh 关闭"`（页签名取自 `shellPath`，证明配置生效而非默认 `/bin/bash`）；② `ps` 见 `60902 /usr/bin/zsh -i`，**PPID = 48971 = Host 进程**；③ `/proc/60902/fd/{0,1,2,10} → /dev/pts/0`，`env` 含 `TERM=xterm-256color`。另从 PTY 主设备写入命令后实读到回显（`OUT-CAPTURED` / `ZSH=5.9`）|

另：`tools/check-fetch-mirror.cjs`（6/6 PASS）与 `tools/check-sidebar-tab-id-guard.mjs`（9/9 PASS）是 N1/N3 与 N4 的永久门禁。

### 第二轮真机报告（`DSHM-DEV-TODO-ALL-2026-10-03(1).md`，2026-10-03 17:29）落地状态

该报告新增 **U1**（P0）与 **N6**（P2），已落地并真机验证；其余条目的状态复核以本文表格为准 ——
报告的「D1/D2/D3/N5 未落实」判定与端侧实测矛盾（报告测的 `Host pid 17464` 那一轮与本机同一构建），
不可采信。

| 项 | 落点 | 真机核验 |
|---|---|---|
| **U1** `dsh-codearts-auth` 装不上（`failed to import`） | `hostcore/app/undici-shim.mjs` 补 `ProxyAgent`/`Pool`/`RetryAgent`/`RetryHandler` 具名导出 + 同步 `default` 对象 | 设备侧垫片 5,530 → **9,736 B**（sha256 `5796072bfbacb0b8…`）；重建 + `hdc install -r` 后 `node-output.log` 里 `did not activate` = **0**、`failed to import` = **0**、`codearts` = **0** |
| **N6** profile patch 残留两条同 id `better-sidebar` | `hostcore/app/dshm-user-rows.js` 的 `carryForeignTopLevelEntries()` 收尾按主键反向扫描去重（保留最后一次，符合上游整体覆盖语义） | 设备 `<profile>/cordis.patch.yml` **123 行 2,764 B → 116 行 2,621 B**，`- id: better-sidebar` **2 → 1 条**；启动日志 `用户插件行：carry 阶段按主键去重，丢弃 1 行被覆盖的重复条目` |

新增永久门禁 `tools/check-undici-shim-exports.mjs`：**以运行时事实为判据**（import 垫片取导出面 +
递归扫核心树解析 `import { … } from 'undici'` / `await import('undici')` 的实际需求名），并带对照组
（必须扫到 `Agent`/`fetch`）防假通过；无核心树时 exit 2。已进 `CONTRIBUTING.md` 门禁清单。

**U1 的两个排查陷阱**（省时间）：
1. `@deepseek-ai/dsh-app-boot/lib/index.js:3911` 的 `error: "failed to import"` 是**字符串字面量**，
   不是异常文本 —— `entry.fiber === undefined` 时真正的原因当场就丢了，别指望日志给出理由。
   （`FIBER_FAILED` 那条路径 `:3923-3934` 走 `await fiber.await()` 才拿得到 error。）
2. ESM 具名导入在**解析期**校验导出存在性 ⇒ 缺一个名字整个模块图 import 失败，插件连 `apply()`
   都到不了，表现为「插件装了但什么也没发生」。

**刻意不补的导出**（不是遗漏）：`request` / `stream` / `interceptors`。它们的替身会**静默给错语义**
（`request()` 返回 undici 专有的 `{statusCode, headers, body, trailers}` 而非 `Response`；`interceptors`
空实现会关掉调用方拦截逻辑；`stream` 绑 duplex 语义）—— "import 明确报错" 比 "静默错行为" 好查。

**N6 刻意不动的事**：「id 已不在任何 bundle 里」的孤儿行**不清理**。判定需要 profile `package.json`
的 bundle 清单（当前 `carryForeignTopLevelEntries` 签名没有），且孤儿行只是无主覆盖（上游
`applyEntryPatches` warn 后 skip）无害；误删「待装插件的配置行」会真丢用户配置。

### 侧边栏 office 文档预览（2026-10-04，`cadb811`）

**症状**：侧边栏打开 `doc/docx/ppt/pptx` 一直「渲染中」，随后报「Office 预览不可用。请在运行
DeepSeek Harness 的主机上启用文档预览服务」。

**根因（已定，勿再猜）**：内置 office 实现的 `read` 是**恒 reject 的桩**
（`dsh-client-ui-sidebar-documentpreview/lib/client.js:5652` `let read = unavailable;`），它等的是宿主侧
注册 `remote.officeToPdf`；而该服务的宿主实现 `@deepseek-ai/libreoffice-kit` 只认 darwin/win32/linux
（`lib/index.js:1267 resolveEngine()` / `:1241-1246 platformTarget()`），在 openharmony-arm64 上**结构性
不可达**（`:1288 throw new Error(\`Unsupported LibreOfficeKit host: …\`)`）。内置实现还写
`loading: "renderer"`，正文自己不结束加载 ⇒ 界面表现为永远转圈。

**做法**：新增端侧客户端插件 `@deepseek-ai/dshm-office-system-preview`，认领 `doc/docx/ppt/pptx` 的侧边栏
预览，正文显示文件名 + 大小 + 「用系统预览打开」按钮，标题栏右侧同一个入口；点击走 ArkTS 桥
`openFilePreview` → PreviewKit，由系统原生预览窗渲染。**与上游默认的取舍**：这是"把不可用变成可用"，
不是"把可用变成另一个样子"——所以只认领坏掉的那四个后缀。

| 关键点 | 事实 |
|---|---|
| 为什么非 builtin 就赢 | `matchingDocumentPreviews` rank = `priority === "builtin" ? 0 : 1`；`candidates` 只返回 matched、不追加 fallback ⇒ 后缀命中的非 builtin 必为 `candidates[0]` |
| ~~**必须** `loading: "bytes-complete"`~~ → **2026-10-05 改为 `"text-pages"`** | 原判据（10/04 验证时成立）：它由宿主读完整个文件后把 `content = {kind:"bytes", data}` 交给正文；写 `"renderer"` 则要求正文自行结束加载，否则永远转圈。**10/05 新事实**：`workspaceFiles/readBytes` 被客户端**每次立刻取消**（宿主不轮转日志 `dshm-host.log`：10/04 = 3/3 成功；10/05 = 78/78 取消、0 成功，耗时 3–13 ms；同期 `stat`/`read` 200）⇒ `bytes-complete` 永远拿不到 content、入口也不出现。本插件正文**不渲染文件内容**，故改用 `"text-pages"`（走可用的 `workspaceFiles/read`；二进制落到上游 "unsupported" 分支，**该分支与失败分支都会渲染 `.actions` 槽** `lib/client.js:798/953` ⇒ 「系统预览」按钮照常出现） |
| **不要**认领 `xls/xlsx/csv/tsv` | 内置 Excel 实现是纯客户端的、本来就正常（`LazyExcelBody` + `client.excel.js`），认领它 = 回退可用预览 |
| 读上限 | 整文件 `readBytes` 走 `maxFileBytes` = **32 MB**（`dsh-api-workspace-files/lib/index.js:385`），不是分页的 2 MB（`:384`）⇒ 3–4.6 MB 的测试 ppt 安全 |
| locale ns | 必须用自有 ns（`dshmOfficeSystemPreview`）；复用上游 `sidebarOffice` 会抛 `locale namespace "…" already has locale` |
| host 半边 | 空 `apply`（照 `@deepseek-ai/dsh-client-ui-open-in-app/lib/index.js` 的 481 B 形状）——真正干活的都在客户端半边 |
| 不需要 `dsh.client.external` | `react` / `react/jsx-runtime` / `@deepseek-ai/dsh-client-ui-primitives` 都在 9 个浏览器种子词里（`dsh-client-modules` 的 `rM()` 直接播种） |
| CSS 注入 | 必须自带（照 `dsh-client-ui-approval/lib/client.js:10-29`），且 `style.dataset.plugin` **必须是本插件包名** —— `dsh-client-modules` 的 `removeOwnedStyles(id)` 按它回收 |
| bridge 调用 | `globalThis.__DSHM_BRIDGES__.openFilePreview` 必须在**点击回调里**惰性取；核心树里 `__DSHM_BRIDGES__` 的唯一既有消费者是 `dsh-experimental-client-ui-voice-input` |

**落地三处（缺一即静默失效）**：`hostcore/plugins/dshm-office-system-preview/`、
`tools/pack-core.mjs` 的 `DSHM_PLUGIN_PACKAGES`、核心种子 `hostcore/profile/ondevice/cordis.patch.yml`
的 `- insert:` 行。⚠️ **只写前两处不会报错**：`ensureProfile()`（`hostcore/app/main.js:3935-4063`）每次启动
都用种子**覆盖**设备侧 profile，而 `assertDshmBelongingsConsistent()`（`pack-core.mjs:894-936`）只校验
目录/声明/版本，**不校验种子里的启用行**。

**ArkTS 侧**：`platform/src/main/ets/system/FilePreview.ets` 新增（后缀→MIME 表、`uriFromPath`
（`fileUri.getUriFromPath`）、`canPreviewFile`/`openSystemPreview`/`isPreviewDisplayed`/`closeSystemPreview`
薄封装）；`WebApp.ets` 加 `openFilePreview` 桥。⚠️ **bridges 对象与 `javaScriptProxy` 的 `methodList` 两处
必须同步改** —— 同一组件链式两次 `javaScriptProxy` 只有最后一次生效。

**同时删除**：上一轮加的冷启动 Office 探测（App 刚启动就弹系统预览窗，属打扰）。

**真机验收（2026-10-04）**：
- 冷启动无 console 报错；宿主 index.html 的 combo URL 逐字含 `@deepseek-ai/dshm-office-system-preview/client.js`。
- 宿主送达 Web UI 的 bundle 与仓库源码**规范化后逐字符相同**（13,501 字符，sha256
  `05bd8188430d90a2ef50e612be3e8a49fbf95b00f8ae40805f26370f09f47525`；原始 16,213 B vs 送达 16,179 B
  差 34 B = `//# sourceMappingURL=client.js.map` 的字节数，被 combo 的 `prepareSource()` 剥掉）。
- 打开真实工作区 `.pptx`：侧边栏显示文件名 + 「用系统预览打开」按钮，点击后系统预览窗弹出并显示内容；
  `diag-file-preview` 记到 `request`/`ok` 两行（**此前 Web UI 从不调用该桥**，这是行为改变的判据）。

---

## 6. 教训清单（省下重复踩坑的时间）

1. **`edit` 工具会剥掉文件 BOM** ⇒ `tools/*.ps1` 改完必须补 UTF-8 BOM，否则 PS 5.1 按 ANSI 解码、
   中文注释变乱码、脚本直接解析失败。本机 `$PSVersionTable.PSVersion = 5.1`，**没有 pwsh 7**。
2. **PS 5.1 的 `Get-Content -Raw` 默认按 ANSI 解码** ⇒ 读含中文的 JSON/日志要显式
   `[System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)`，否则 `ConvertFrom-Json` 抛
   「传入的对象无效」。
3. **`node -e "..."` 里的正则会被 PowerShell 破坏** ⇒ 一律先写成 `%TEMP%\*.cjs` 再跑。
4. **不要用 `hdc shell 'cmd | grep A|B'`**（见 §4② 的纪律框）。
5. **hilog 只覆盖约 8–10 秒**（见 §4②）。
6. **`read_image` 在本模型不可用** ⇒ 视觉结论只能靠 `uitest dumpLayout` 的数值（`layfind.cjs` /
   `layrect.cjs` / `laygrep.cjs` 三个 `%TEMP%` 下的小工具就是为此写的）。
7. **统计口径先定再数**（D9 §6 / `docs/README.md` 纪律 8）——本项目已因此虚增过 4 种事件类型。
8. **`check-arkts-entry.mjs` 退出码 3 = 环境阻塞**，不是通过。
9. **ArkTS 重载解析陷阱**：`commonEventManager.createSubscriber(info)` 会被解析成
   `Promise<CommonEventSubscriber>` 重载 ⇒ 用 `createSubscriberSync`。
10. **门禁"通过"≠"覆盖到了"**（`docs/README.md` 纪律 9）。

---

## 7. 官方桌面端（Windows）的自更新逻辑 —— 与端侧的关系

> 起因：用户观察到 Windows 端 dsh desktop「设置里会提示有新版本，下载后点击更新，重启后完成」。
> 结论来自对上游 deepseek-harness 源码仓库（只读，`0.2.0-rc.2`，commit `639ed01`）的逐条追踪。

### 7.1 一句话

**它完全不是 dsh 协议，而是 Electron 主进程 + 第三方 `electron-updater@^6.8.9` 的组合**
（`apps/desktop/package.json:44`）。端侧（ArkTS）**没有可照搬的实现层**——只有状态机与契约层可参考。
全仓**不存在** `dsh-host-update*` / `dsh-update*` 包，**不存在** `app.relaunch()`，**不存在**
`latest.yml` 或 GitHub Releases 通道。

### 7.2 实现位置与接口面

| 项 | 事实 |
|---|---|
| 实现 | 全在 `apps/desktop/`（Electron 主进程）；渲染侧只有 `packages/client/ui-settings-general` 的一个状态徽标 |
| 接口 | **Electron IPC**，非 dsh：`dsh-desktop:updates-{status,open,presentation}`（`apps/desktop/src/ipc.ts:27-29`） |
| 暴露 | preload → `globalThis.dshDesktop.updates.{status,open,subscribe}`（`apps/desktop/src/preload-app.ts:49-57`） |
| 可见性 | 仅 `dsh-app://app` 主帧（`apps/desktop/src/preload-app.ts:100`） |

### 7.3 状态机与重启

- 主进程权威的 **8 阶段**：`idle → checking → available → downloading → verifying → installing → ready`（+ `error`）；
  渲染侧只订阅**只读快照**，不参与决策。
- 重启链：`autoUpdater.quitAndInstall(true, true)`（`apps/desktop/src/update-coordinator.ts:137`）
  → 先置 `shellInstallerOwnsQuit = true`（`apps/desktop/src/main.ts:626`）让 `before-quit` 不拦截
  （`apps/desktop/src/main.ts:1259-1281`）→ 由 **NSIS** 就地安装并以 `--updated` 重启
  （`apps/desktop/installer/pages.nsh:224-237`）→ 重启后抬升聚焦一次（`apps/desktop/src/main.ts:1126-1130`）。

### 7.4 ★四层平台门禁（端侧照搬会在第一层就短路）

| # | 门禁 | 位置 |
|---|---|---|
| 1 | `app.isPackaged && existsSync(join(process.resourcesPath,'app-update.yml'))` | `apps/desktop/src/update-coordinator.ts:54` |
| 2 | 无签名构建 `publish: null` ⇒ **不产出** `app-update.yml` | `apps/desktop/electron-builder-config.mjs:249` |
| 3 | `UPDATE_TARGETS = {mac-arm64, mac-x64, win-x64}` —— **无 Linux** | `desktop-auto-update-environment.mjs:25` |
| 4 | 强制更新策略另抛 `desktop policy: unsupported platform` | `apps/desktop/src/main.ts:1297` |

> 含义：**门禁之后没有可移植的实现**。ArkTS 侧能用的只有下面 7.5 那四项。
> Windows 专有点：`--updated` 抬升、Windows 专属确认文案、`installMandatoryUpdateOverlay`、NSIS 重启链。

### 7.5 生产配置（版本来源）

- 生产硬编码 `https://download.deepseek.com`（`desktop-auto-update-environment.mjs:18`）；test 用 `DOWNLOAD_TEST_ORIGIN`。
- feed 固定 `nightly.yml`；**channel 恒为 `nightly`，用户无法 opt-in 或切换**。

### 7.6 端侧可复用的面（仅此四类）

1. 状态枚举与转移规则（7.3 那 8 阶段）；
2. `status` / `open` / `subscribe` 三角色契约；
3. 调度参数：**10 分钟**轮询 + **±20% 抖动** + **1 小时退避上限**；
4. 强制更新策略的 HTTP 契约：`<origin>/api/v0/check_client_update`、`x-client-*` 头、`40005` 表示阻断。

### 7.7 结论与不确定项

- **结论**：这是 Electron 平台能力，不是 dsh 能力。端侧若要做"检查更新"，等于**从零实现一套**
  （版本清单托管 + 下载 + 校验 + 覆盖安装），且**端侧更新路径必须先过 §4 的数据保全规则**
  （只允许 `hdc install -r`，自动化更新会直接触碰"卸载删数据"的红线）。
  当前**不建议**移植；真要做得先拍板"谁来托管 HAP 与版本清单"。
- **不确定项（未读完，如实留白）**：未逐行读 `renderer/update-dialog.*` 与 `mandatory-update.*` 正文；
  `locale.messages.later` 字面量未取；macOS 重启闭环未完整追踪；Linux 是机制推断（门禁 3）而非显式禁用断言。
