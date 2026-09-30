# 交接说明（HANDOFF）

> 本文给**接手的人**：现在到哪一步、哪些是真结论、哪些还没做、下一步怎么动手。
> 契约类文档（D1/D2/D2b/D3/D3b/D4/D5）不动，见 [`README.md`](README.md) 的索引；本文只讲**状态**。
> 最近一次更新：2026-09-30（§4④ 开源推送完成：GitCode + GitHub 覆盖、GitHub Release 重发）。

---

## 1. 一句话现状

鸿蒙 arm64 客户端（`com.dshm.dshclient`，DSHM）已能在 MateBook 14（2in1，OpenHarmony-7.0.0.105 / API 26）上自足跑起端侧 dsh core 0.2.0-rc.2，界面走 WebView 加载 Host web UI，语音输入、托盘常驻、长时保活均已真机验证。
**两个未修完的缺陷**：①托盘/应用启动约 40 秒后自杀；②"正在连接"抖动（Windows 端同源，已定位机制、修法未落盘）。见 §4。

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
| Windows | `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`（当前**没有** `typert-gateway` 覆盖 ⇒ 仍是默认 2000ms） | 改完重启 desktop 即可 |
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

- **端侧核心自足运行**：core 0.2.0-rc.2 打进 HAP，`libdshhost.so` 与应用同进程起 Node 线程；
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
