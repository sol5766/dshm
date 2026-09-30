# 设备验收一键脚本（DSHM）
#
# 用法（在仓库根目录）：
#   powershell -NoProfile -File tools\device-acceptance.ps1
#   powershell -NoProfile -File tools\device-acceptance.ps1 -SkipInstall   # 已装最新包，只重启取证据
#   （环境里有 pwsh 的话，把 powershell 换成 pwsh 亦可）
#
# 它做什么：
#   1) 找设备、装最新 HAP（-SkipInstall 时跳过）、**冷启动一次**应用、等核心就绪；
#   2) 采集**可脚本化**的证据：hilog 早期窗口、设备侧持久日志、各页面布局 dump 与截图；
#   3) 落盘到 dist/acceptance/<时间戳>/，并生成 report.md（自动读数已填好，需看界面的项留给你勾选）。
#
# 【E385 判据为什么改读设备侧持久日志】
#   hilog 是环形缓冲，实测覆盖只有约 8–10 秒；而"等核心就绪"要几十秒，一次性启动事件
#   （BOOT_10_ENV_READY / 平台标识 / DSHM-AUTH connect）会被冲掉 ⇒ 用 hilog 当判据必然假 FAIL。
#   换成设备侧文件（shell 身份可读，实测）：
#     · node-output.log —— **每次启动轮转**，含本次启动全量（核心路径 / 平台标识 / 接入）
#     · dshm-host.log   —— 跨启动累积，取"本次启动标记（写锁巡检）之后"的行才有效
#   因此本脚本**强制冷启动**（aa force-stop + aa start），否则 node-output.log 是上一次启动的，
#   会把上一轮的读数当成本轮结果（假 PASS）。
#
# 它不做什么：
#   · 不做界面项的判定——那些按 docs/50-端侧核心运行架构.md §14 由人看（脚本只把布局与截图摆好）；
#   · 不改动仓库（只写 dist/ 下的证据目录，该目录已在 .gitignore 内）；
#   · 不动设备数据：全文只用 hdc install -r / aa force-stop / aa start，**没有 hdc uninstall**。

param(
  [switch]$SkipInstall,
  [int]$BootWaitSeconds = 45,
  [int]$HilogEarlySeconds = 8
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# hdc：显式指定优先，其次按本机常见安装位置探测（E386：写死单一路径会让人误判成"环境受限"）
function Resolve-Hdc {
  if ($env:DSHM_HDC -and (Test-Path $env:DSHM_HDC)) { return $env:DSHM_HDC }
  $cands = @(
    'D:\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe',
    (Join-Path $env:LOCALAPPDATA 'OpenHarmony\Sdk')
  )
  foreach ($c in $cands) {
    if ($c -like '*\Sdk' -and (Test-Path $c)) {
      $hit = Get-ChildItem $c -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName 'toolchains\hdc.exe' } |
        Where-Object { Test-Path $_ } | Select-Object -First 1
      if ($hit) { return $hit }
    } elseif (Test-Path $c) { return $c }
  }
  return $null
}
$hdc = Resolve-Hdc
if (-not $hdc) {
  Write-Host '找不到 hdc：请设置 DSHM_HDC 指向 hdc.exe' -ForegroundColor Red
  exit 2
}

# 设备侧可读的应用文件目录（shell 身份可读；注意不是 /data/storage/... 那条沙箱视图路径，那条 hdc 读不到）
$devFiles = '/data/app/el2/100/base/com.dshm.dshclient/haps/entry/files'

function Run-Hdc([string]$cmd) {
  return ((& $hdc shell $cmd 2>&1) -join "`n")
}
function Save-Log([string]$name, [string]$pattern) {
  $text = Run-Hdc "hilog -x | grep -E '$pattern' | tail -60"
  $text | Set-Content -Path (Join-Path $out "$name.log") -Encoding UTF8
}
# 拉设备侧文件并按 UTF-8 解码（E387：`hdc shell cat` 会经控制台 GBK 解码，中文全乱 ⇒ 必须 recv 后读）
function Pull-DeviceFile([string]$remote, [string]$name) {
  $local = Join-Path $out $name
  & $hdc file recv $remote $local 2>&1 | Out-Null
  if (Test-Path $local) { return [System.IO.File]::ReadAllText($local, [Text.Encoding]::UTF8) }
  return ''
}
function Save-Ui([string]$name, [string]$clickAt) {
  if ($clickAt.Length -gt 0) {
    & $hdc shell "uitest uiInput click $clickAt" 2>&1 | Out-Null
    Start-Sleep -Seconds 2
  }
  & $hdc shell "uitest dumpLayout -p /data/local/tmp/acc-$name.json" 2>&1 | Out-Null
  & $hdc file recv "/data/local/tmp/acc-$name.json" (Join-Path $out "$name.json") 2>&1 | Out-Null
  & $hdc shell "rm -f /data/local/tmp/acc-$name.jpeg; snapshot_display -f /data/local/tmp/acc-$name.jpeg" 2>&1 | Out-Null
  & $hdc file recv "/data/local/tmp/acc-$name.jpeg" (Join-Path $out "$name.jpeg") 2>&1 | Out-Null
}

# 按文本自动定位并点击（E261）。
# 【为什么不用硬编码坐标】坐标依赖分辨率与布局：换台设备必然点错，而"点错"在验收里最危险——
# 它看起来像"功能坏了"。做法：dump 布局 → 找 attributes.text 匹配的节点 → 取 bounds → 点中心。
# 注意 dump 出的文本是「当前界面」的：设置对话框**不在主界面上**，得先点「账号菜单」展开菜单才看得到「设置」。
function Click-Text([string]$text) {
  & $hdc shell "uitest dumpLayout -p /data/local/tmp/find.json" 2>&1 | Out-Null
  $local = Join-Path $env:TEMP 'dshm-find.json'
  if (Test-Path $local) { Remove-Item $local -Force }
  & $hdc file recv "/data/local/tmp/find.json" $local 2>&1 | Out-Null
  if (-not (Test-Path $local)) { return $false }
  try {
    $doc = [System.IO.File]::ReadAllText($local, [Text.Encoding]::UTF8) | ConvertFrom-Json
  } catch { return $false }
  $hit = $null
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($doc)
  while ($queue.Count -gt 0 -and -not $hit) {
    $node = $queue.Dequeue()
    if ($node -is [PSCustomObject] -and ($node.PSObject.Properties.Name -contains 'attributes')) {
      $a = $node.attributes
      if ($a.text -and $a.text.ToString().Trim() -eq $text -and $a.bounds) { $hit = $a.bounds.ToString(); break }
    }
    if ($node -is [PSCustomObject]) {
      foreach ($p in $node.PSObject.Properties) {
        if ($p.Value -is [System.Object[]]) { foreach ($c in $p.Value) { $queue.Enqueue($c) } }
        elseif ($p.Value -is [PSCustomObject]) { $queue.Enqueue($p.Value) }
      }
    }
  }
  if (-not $hit) {
    Write-Host ('未找到可点文本「' + $text + '」——跳过（界面可能已变化）') -ForegroundColor Yellow
    return $false
  }
  $m = [regex]::Match($hit, '\[(\d+),(\d+)\]\[(\d+),(\d+)\]')
  if (-not $m.Success) { return $false }
  $cx = [int](([int]$m.Groups[1].Value + [int]$m.Groups[3].Value) / 2)
  $cy = [int](([int]$m.Groups[2].Value + [int]$m.Groups[4].Value) / 2)
  & $hdc shell "uitest uiInput click $cx $cy" 2>&1 | Out-Null
  Start-Sleep -Seconds 2
  return $true
}

# ── 1) 设备（先确认，再建目录：无设备时不留垃圾）──────────────────────────
$targets = ((& $hdc list targets 2>&1) -join ' ')
if ($targets.Contains('[Empty]') -or $targets.Trim().Length -eq 0) {
  Write-Host '没有设备（hdc list targets = [Empty]）。接上设备后重跑本脚本。' -ForegroundColor Yellow
  exit 3
}
Write-Host ('设备：' + $targets.Trim())

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $root ('dist\acceptance\' + $stamp)
New-Item -ItemType Directory -Force -Path $out | Out-Null
Write-Host ('证据目录：' + $out)

# ── 2) 装机 + 冷启动 ───────────────────────────────────────────────────────
if (-not $SkipInstall) {
  $hap = Get-ChildItem 'entry\build' -Recurse -Filter *.hap -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $hap) { Write-Host '找不到 HAP，请先 devecocli build' -ForegroundColor Red; exit 4 }
  Write-Host ('安装：' + $hap.Name)
}
& $hdc shell 'aa force-stop com.dshm.dshclient' 2>&1 | Out-Null
if (-not $SkipInstall) {
  & $hdc install -r $hap.FullName 2>&1 | Select-Object -Last 1 | Write-Host
}
& $hdc shell 'hilog -r' 2>&1 | Out-Null
& $hdc shell 'aa start -b com.dshm.dshclient -a EntryAbility' 2>&1 | Select-Object -First 1 | Write-Host

# hilog 只在启动后几秒内还有启动事件，先抢一份早窗；剩下的时间留给界面就绪
$early = [Math]::Min($HilogEarlySeconds, [Math]::Max(0, $BootWaitSeconds - 2))
Start-Sleep -Seconds $early
Save-Log 'hilog-early' 'BOOT_|DSHM_PLATFORM|平台标识|DSHM-AUTH|DSHM-TRACE|files changes|remote\.mux'
Write-Host ('等待核心就绪（剩余 ' + ([Math]::Max(0, $BootWaitSeconds - $early)) + ' s）…')
Start-Sleep -Seconds ([Math]::Max(0, $BootWaitSeconds - $early))

# ── 3) 采证据 ─────────────────────────────────────────────────────────────
# 设备侧持久日志：node-output.log 每次启动轮转（本轮权威），dshm-host.log 跨启动累积（配合启动标记用）
$nodeOut = Pull-DeviceFile "$devFiles/node-output.log" 'device-node-output.log'
$hostLog = Pull-DeviceFile "$devFiles/dshm-host.log"   'device-dshm-host.log'

Save-Log 'boot'     'BOOT_10_ENV_READY|BOOT_65|DSHM_PLATFORM|平台标识'
Save-Log 'connect'  'DSHM-AUTH connect|DSHM-CONN|DSHM-WS'
Save-Log 'trace'    'DSHM-TRACE'
Save-Log 'features' 'commands/list|agentPresets/list|skills/list|llm providers|workspace baseline|files changes opened'
Save-Log 'errors'   'CppCrash|AppKilledReporter|JS_ERROR|exitSigno'

# 界面：主界面 → 账号菜单 → 设置 → 各分区（文本取自界面实测标签，E261）
$nav = @()
Save-Ui 'workspace' ''
$nav += , @('账号菜单', (Click-Text '账号菜单'))
Save-Ui 'account-menu' ''
$nav += , @('设置', (Click-Text '设置'))
Save-Ui 'settings' ''
$panels = @(
  @('账号与余额', 'settings-account'),
  @('通用设置', 'settings-general'),
  @('模型', 'settings-models'),
  @('内置插件', 'settings-builtin-plugins'),
  @('Agent 预设', 'settings-agent-presets'),
  @('Our Free Model', 'settings-free-model'),
  @('插件市场', 'settings-marketplace'),
  @('皮肤市场', 'settings-skins'),
  @('侧边卡片', 'settings-side-cards')
)
foreach ($p in $panels) {
  $ok = Click-Text $p[0]
  $nav += , @($p[0], $ok)
  if ($ok) { Save-Ui $p[1] '' }
}
$navLines = @('| 点击目标 | 结果 |', '|---|---|')
foreach ($n in $nav) {
  $r = 'FAIL'
  if ($n[1]) { $r = 'OK' }
  $navLines += ('| ' + $n[0] + ' | ' + $r + ' |')
}
$navLines -join "`r`n" | Set-Content -Path (Join-Path $out 'nav.md') -Encoding UTF8

# ── 4) 自动判定 ───────────────────────────────────────────────────────────
# dshm-host.log 是跨启动累积的：只看"本次启动标记（写锁巡检）之后"的行
$hostLines = @()
if ($hostLog.Length -gt 0) { $hostLines = $hostLog -split "`r?`n" }
$bootIdx = -1
for ($i = $hostLines.Count - 1; $i -ge 0; $i--) {
  if ($hostLines[$i].Contains('写锁巡检')) { $bootIdx = $i; break }
}
$hostSinceBoot = ''
if ($bootIdx -ge 0) { $hostSinceBoot = ($hostLines[$bootIdx..($hostLines.Count - 1)] -join "`n") }

$coreLine = ''
$mCore = [regex]::Match($nodeOut, 'BOOT_10_ENV_READY[^\r\n]*')
if ($mCore.Success) { $coreLine = $mCore.Value }
$coreVer = ''
$mVer = [regex]::Match($coreLine, 'cores/([^/\s]+)')
if ($mVer.Success) { $coreVer = $mVer.Groups[1].Value }
$platLine = ''
$mPlat = [regex]::Match($nodeOut, '[^\r\n]*DSHM_PLATFORM=ohos[^\r\n]*')
if ($mPlat.Success) { $platLine = $mPlat.Value }
$muxLine = ''
$mMux = [regex]::Match($nodeOut, '[^\r\n]*IN-UPGRADE GET /api/remote\.mux[^\r\n]*')
if ($mMux.Success) { $muxLine = $mMux.Value }
$errPat = 'CppCrash|AppKilledReporter|JS_ERROR|exitSigno|!! process\.exit'
$errHit = ''
$mErr = [regex]::Match(($nodeOut + "`n" + $hostSinceBoot), $errPat)
if ($mErr.Success) { $errHit = $mErr.Value }

# E262：**可脚本化的判定**（能自动判的就别让人判）——真机上只留给"必须看一眼界面"的项。
$verdicts = @()
function Add-Verdict([string]$item, [bool]$ok, [string]$detail) {
  $script:verdicts += , @($item, $ok, $detail)
}
Add-Verdict '设备在线' ($targets.Trim().Length -gt 0) $targets.Trim()
Add-Verdict '核心已启动（读出运行核心版本）' ($coreLine.Length -gt 0) ($coreLine -replace '\s+', ' ')
Add-Verdict '客户端已接入（凭据豁免生效）' ($muxLine.Length -gt 0) ($muxLine -replace '\s+', ' ')
Add-Verdict '平台标识 = ohos' ($platLine.Length -gt 0) ($platLine -replace '\s+', ' ')
Add-Verdict '本次启动后无异常退出 / 无崩溃关键字' ($errHit.Length -eq 0) ($errHit)

$lines = @()
$lines += '# 设备验收报告（' + $stamp + '）'
$lines += ''
$lines += ('设备：' + $targets.Trim())
$lines += ('hdc：' + $hdc)
$lines += ('运行核心：' + $coreVer)
$lines += ''
$lines += '## 自动读到的读数（原样，不要转述）'
$lines += ''
$lines += '| 项 | 读数 |'
$lines += '|---|---|'
$lines += ('| 核心加载（node-output.log，每次启动轮转） | ' + ($coreLine -replace '\s+', ' ') + ' |')
$lines += ('| 客户端接入（node-output.log：远程 mux 升级） | ' + ($muxLine -replace '\s+', ' ') + ' |')
$lines += ('| 平台标识（凭据豁免是否生效） | ' + ($platLine -replace '\s+', ' ') + ' |')
$lines += ('| 本次启动后异常退出标记 | ' + $errHit + ' |')
$lines += ''
$lines += '## 自动判定（E262：能脚本化的部分，已替你判好）'
$lines += ''
$lines += '| 项 | 结论 | 读数 |'
$lines += '|---|---|---|'
foreach ($v in $verdicts) {
  $mark = 'FAIL'
  if ($v[1]) { $mark = 'PASS' }
  $lines += ('| ' + $v[0] + ' | ' + $mark + ' | ' + $v[2] + ' |')
}
$lines += ''
$lines += '> 这几项**不需要你再看**：读数是脚本按判据自动取的。判据来源已换成设备侧持久日志（E385）——'
$lines += '> hilog 环形缓冲只有约 8–10 秒覆盖，用 hilog 判"启动事件"必然假 FAIL。'
$lines += '> 进设置的导航见同目录 `nav.md`（先点「账号菜单」→ 再点「设置」；这一步点不动，下面的截图就是主界面）。'
$lines += ''
$lines += '## 需要你看界面判定的项（勾选并补读数）'
$lines += ''
$lines += '按 docs/50-端侧核心运行架构.md：'
$lines += ''
$lines += '- [ ] 14.1 展开提供方 → 是否出现「模型目录 · N」+ 模型行（看不到就不要做 14.1 的拆）'
$lines += '- [ ] 14.2 命令面板：是否列出宿主命令；点一条是否回执且不崩溃'
$lines += '- [ ] 14.2 计划模式：状态是否随「切换」变化'
$lines += '- [ ] 14.2 本会话模型：点选后是否回执 本会话已改用'
$lines += '- [ ] 14.2 轨迹：展开/收起全部；条目右侧是否有「钟点 · 时长」'
$lines += '- [ ] 14.2 候选搜索：输入关键字是否过滤'
$lines += '- [ ] 14.3 插件启停 → 是否转「待确认」→ 重启核心后生效'
$lines += '- [ ] 14.3 工作区删除/归档 → 组消失但磁盘目录仍在；归档进入「归档 · N」'
$lines += '- [ ] 14.3 核心切换/回滚 → 提示已安排 → 完全退出重开 → 新版本运行'
$lines += '- [ ] 14.3 折叠屏/平板/2in1 → 布局切换不丢当前页'
$lines += '- [ ] 文件变更流：改一个工作区文件 → 右侧「文件变动」是否出现条目'
$lines += '      （E385 降级：该判据的原信号 `files changes opened` 只在 hilog 里，且实测设备侧日志里'
$lines += '        `fs-watch` 全史只出现过 1 次（2026-09-27），不是每次启动都有 ⇒ 没法自动判，改人工看）'
$lines += ''
$lines += '## 截图与布局'
$lines += ''
$lines += '同目录下：<页面>.json（uitest dumpLayout）、<页面>.jpeg（截图）、<阶段>.log（hilog 摘录）、'
$lines += 'device-*.log（从设备拉下来的持久日志，UTF-8 原文）、nav.md（导航是否点动）。'
$lines += ''
$lines += '## 结论'
$lines += ''
$lines += '（把 FAIL 项的回执原文贴在这里——本项目排障靠原文，不靠转述。）'

$lines -join "`r`n" | Set-Content -Path (Join-Path $out 'report.md') -Encoding UTF8

Write-Host ''
Write-Host ('完成。报告：' + $out + '\report.md') -ForegroundColor Green
Write-Host '下一步：打开 report.md 按清单逐条勾选；FAIL 项请贴回执原文。'
