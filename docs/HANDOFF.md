# 交接说明（HANDOFF）

> 本文给**接手的人**：现在到哪一步、哪些是真结论、哪些还没做、下一步怎么动手。
> 契约类文档（D1/D2/D2b/D3/D3b/D4/D5）不动，见 [`README.md`](README.md) 的索引；本文只讲**状态**。
> 最近一次更新：2026-09-29。

---

## 1. 一句话现状

鸿蒙 arm64 客户端（`com.dshm.dshclient`，DSHM）已能在 MateBook 14（2in1，OpenHarmony-7.0.0.105 / API 26）上自足跑起端侧 dsh core 0.2.0-rc.1，界面走 WebView 加载 Host web UI，语音输入、托盘常驻、长时保活均已真机验证。
**两个未修完的缺陷**：①托盘/应用启动约 40 秒后自杀；②"正在连接"抖动（Windows 端同源，已定位机制、修法未落盘）。见 §4。

---

## 2. Windows 端 dsh desktop 重装（用户当前最要紧的事）

### 2.1 为什么不能直接覆盖安装 —— 以及新版包在哪

**已装的是 `0.1.7-rc.2`**（注册表 `DisplayName = DeepSeek Harness 0.1.7-rc.2`）。
而 `%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater\installer.exe`
（286,837,333 B，`FileVersion = 0.1.7-rc.2`，mtime **2026-09-26 08:24:56**）
**就是当前已装的那个版本的包，不是新版本** —— 指望它做升级是错的。

**真正的新版包已在本机**（实测）：

```
C:\Users\Sol\Downloads\deepseek-harness-0.2.0-rc.1-win-x64.exe
  288,472,536 B   FileVersion/ProductVersion = 0.2.0-rc.1
  mtime 2026-09-29 12:39:14
  sha256 9DD8538E554D3139998A8458E21C64A6F99470915CBF6CFD22BB71F356C7F399
```

它比已装版本高一个 minor（`0.1.7-rc.2` → `0.2.0-rc.1`）。**Electron 侧安装器对"覆盖安装"
不做版本回退保护**，直接双击通常也能装，但本项目**要求先卸载再装**：旧版把 Host 与
`~/.dsh/host-ready.json` 留在原位，版本错配时最容易出现"界面连不上 Host"而误判成网络问题。
按 §2.4 的七步走。

### 2.2 现状事实（实测，勿再猜）

| 项 | 值 |
|---|---|
| 注册表 DisplayName | `DeepSeek Harness 0.1.7-rc.2` |
| DisplayVersion | `0.1.7-rc.2` |
| InstallLocation | `D:\Program Files\dsh` |
| UninstallString | `"D:\Program Files\dsh\Uninstall DeepSeek Harness.exe" /currentuser` |
| 主程序 | `D:\Program Files\dsh\DeepSeek Harness.exe`（244,468,224 B，`ProductVersion 0.1.7.0`） |
| Electron 版本 | `D:\Program Files\dsh\version` = `44.0.0` |
| 随包 Node/pnpm | `resources\runtime\versions.json` = `{"node":"24.18.1","pnpm":"11.7.0"}` |
| 快捷方式 | `D:\desktop\DeepSeek Harness.lnk` |
| `@deepseek-ai` 已在 `%LOCALAPPDATA%\Programs` 下 | 无（只有 `Common`）⇒ 是**非 per-user 安装**，装在 `D:\` |

### 2.3 必须保住的数据（删了不可恢复）

| 路径 | 大小 | 内容 |
|---|---|---|
| `C:\Users\Sol\.dsh` | **975.06 MiB** | `sessions\`、`storages\`、`profiles\{desktop,ondevice}`、`dsh-runtimes\`、**`.credentials.yaml`**(665 B)、`host-ready.json` |
| `%APPDATA%\@deepseek-ai` | 46.4 MiB | Electron userData（`dsh-desktop\`：Local Storage / Session Storage / Preferences / logs） |

⇒ 卸载/重装**只动安装目录 `D:\Program Files\dsh`**，上面两处不要碰。
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
   renderer `12084`、**dsh-desktop-host `2240`**、subprocess runner `13500`/`21292`、
   `node.exe 4004`（`C:\Users\Sol\.dsh\profiles\desktop\node_modules\billion-context`）。
   **PID 会变，按名字/端口杀，不要按上面这些数字杀。**
3. **卸载旧版**（两个办法，任选）：
   ```powershell
   # A. 走注册表里的卸载串（推荐，会清理注册表项与快捷方式）
   & "D:\Program Files\dsh\Uninstall DeepSeek Harness.exe" /currentuser
   # B. 图形界面：设置 → 应用 → 已安装的应用 → "DeepSeek Harness 0.1.7-rc.2" → 卸载
   ```
   卸载完确认 `D:\Program Files\dsh` 已消失、注册表项已消失；**若残留则手动删目录**（只删这个目录）。
4. **清掉过期更新器缓存**（否则新版本可能仍被旧包挡住）：
   ```powershell
   Remove-Item "$env:LOCALAPPDATA\@deepseek-aidsh-desktop-updater" -Recurse -Force
   ```
5. **删掉过期的 `host-ready.json`**：当前内容是**上一轮 PC 侧本地测试的残留**——
   ```json
   {"port":3156,"profile":"ondevice","pid":17560,"startedAt":"2026-09-28T15:10:52.882Z",
    "workspace":"D:\\desktop\\temp\\desktop.ohos.arm64\\dist\\localtest\\model-sandbox\\workspace",
    "runtime":{"nodeVersion":"v24.19.0","platform":"win32/x64","jitless":true,
               "listenAddress":"127.0.0.1:3156","natives":{...}}}
   ```
   而桌面端 Host 实际监听的是 **19387**（owner = `dsh-desktop-host`）。这就是一份**撒谎的探针文件**，
   留着会误导排查。新版启动会自己重写。
   ```powershell
   Remove-Item "$env:USERPROFILE\.dsh\host-ready.json" -Force
   ```
6. **装新版**：用 §2.1 给出的那个包（`C:\Users\Sol\Downloads\deepseek-harness-0.2.0-rc.1-win-x64.exe`）。
   ```powershell
   $p = "$env:USERPROFILE\Downloads\deepseek-harness-0.2.0-rc.1-win-x64.exe"
   (Get-Item $p).VersionInfo.FileVersion          # 应为 0.2.0-rc.1
   (Get-FileHash $p -Algorithm SHA256).Hash       # 应为 9DD8538E...C7F399
   Start-Process $p                                 # 双击效果，走图形安装器
   ```
   装完核对：
   ```powershell
   (Get-Item "D:\Program Files\dsh\DeepSeek Harness.exe").VersionInfo.FileVersion   # 应为 0.2.0-rc.1
   Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" |
     Where-Object DisplayName -match 'DeepSeek' | Select-Object DisplayName,DisplayVersion
   ```
7. **验证数据还在**：会话数 / profile 列表 / 能正常登录（`.credentials.yaml` 生效）。

> ⚠️ 卸载前**不要**用 `Remove-Item -Recurse` 去"清干净"`C:\Users\Sol\.dsh` 或 `%APPDATA%\@deepseek-ai`——
> 那 1 GB 里是用户的全部会话与凭据。

---

## 3. 鸿蒙侧工程结构（接手必读）

- 仓库根：`D:\desktop\temp\desktop.ohos.arm64`。构建产物 `entry/build/default/outputs/default/entry-default-signed.hap`；
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

### ① 连接抖动「重新连接中 → 连接成功」（**Windows 端与鸿蒙端同源，优先级最高**）

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

**修法（未落盘）**：把心跳周期调大，两个键都要列（patch 的语义是**整块替换**目标 config）：

```yaml
- id: typert-gateway
  name: "@deepseek-ai/dsh-api-gateway"
  config:
    websocketHeartbeatIntervalMs: 30000
    streamInboxBytes: 262144
```

| 端 | 落到哪 | 生效代价 |
|---|---|---|
| Windows | `C:\Users\Sol\.dsh\profiles\desktop\cordis.patch.yml`（121 行，当前**没有** `typert-gateway` 覆盖 ⇒ 仍是默认 2000ms） | 改完重启 desktop 即可 |
| 鸿蒙 | `hostcore/profile/ondevice/cordis.patch.yml`（314 行，`PROFILE = process.env.DSHM_PROFILE \|\| 'ondevice'`，由 `hostcore/app/main.js:3654/3681` 装到 `$DSH_HOME/profiles/<PROFILE>`） | **必须 `node tools/pack-core.mjs` 重打 core → 重建 HAP → `hdc install -r`** |

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

> **hilog 取证纪律（血泪）**：缓冲区只有 4MB，**实测只覆盖约 8–10 秒**。
> 清空 → 立刻动作 → 数秒内 dump。`entry/tray`、`entry/background`、`testTag` 在事后 dump 里
> 0 命中**不代表日志没打**。另：**不要用 `hdc shell 'cmd | grep A|B'`**（`/bin/sh` 会报
> `B: inaccessible or not found` 并挂死命令）。

### ③ 交付前最终验收

产物已就绪：`dist/sideload/DSHM-1.0.0-arm64-signed.hap`（299.5 MB，
sha256 `4e776ecf6b573862…`）。剩最后一遍逐项走查（文档 `docs/device-validation.md` 批次三十六/三十七）。

### ④ GitCode 开源推送（**被 token 阻塞**）

3 个本地提交（`e7b5ed7`、`32e1710`、`33e9631`，424 文件 / 5.84MB）已就绪，远端仍是**无关的旧项目**。
推送需要**有写权限的 token**（`http.extraheader=PRIVATE-TOKEN: <tok>`，不要放进 URL；
禁用 GCM：`credential.helper=""`、`GCM_INTERACTIVE=never`、`GIT_CREDENTIAL_MANAGER=0`，清代理）。
**注意**：`git ls-remote` 返回 0 **不能**证明 token 有效（匿名读也能成功），必须实际 push 才算。
之后打 tag `v1.0.0` + Release 上传上面那个 HAP。

### ⑤ 待用户拍板

`D:\desktop\temp\desktop.ohos.arm64\.codegenie\`（449 MB，内含嵌套 `.git`）——删还是留。

---

## 5. 已完成的（不要再重做）

- **端侧核心自足运行**：core 0.2.0-rc.1 打进 HAP，`libdshhost.so` 与应用同进程起 Node 线程；
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
