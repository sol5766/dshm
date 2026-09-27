# 设备验收一键脚本（DSHM）
#
# 用法（在仓库根目录）：
#   powershell -NoProfile -File tools\device-acceptance.ps1
#   powershell -NoProfile -File tools\device-acceptance.ps1 -SkipInstall   # 已装最新包，只抓证据
#   （环境里有 pwsh 的话，把 powershell 换成 pwsh 亦可）
#
# 它做什么：
#   1) 找设备、装最新 HAP、启动、等核心就绪；
#   2) 采集**可脚本化**的证据：关键日志（核心路径/连接结果/旁路记账）、各页面布局 dump 与截图；
#   3) 落盘到 dist/acceptance/<时间戳>/，并生成 report.md 骨架（自动读数已填好，需看界面的项留给你勾选）。
#
# 它不做什么：
#   · 不做通过/失败判断——那按 docs/50-端侧核心运行架构.md 的 §12.9 / §14 由你判定；
#   · 不改动仓库（只写 dist/ 下的证据目录，该目录已在 .gitignore 内）。

param(
  [switch]$SkipInstall,
  [int]$BootWaitSeconds = 45
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$hdc = $env:DSHM_HDC
if (-not $hdc) {
  $candidate = 'D:\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
  if (Test-Path $candidate) { $hdc = $candidate }
}
if (-not $hdc -or -not (Test-Path $hdc)) {
  Write-Host '找不到 hdc：请设置 DSHM_HDC 指向 hdc.exe' -ForegroundColor Red
  exit 2
}

function Run-Hdc([string]$cmd) {
  return ((& $hdc shell $cmd 2>&1) -join "`n")
}
function Save-Log([string]$name, [string]$pattern) {
  $text = Run-Hdc "hilog -x | grep -E '$pattern' | tail -60"
  $text | Set-Content -Path (Join-Path $out "$name.log") -Encoding UTF8
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
function Click-Text([string]$text) {
  & $hdc shell "uitest dumpLayout -p /data/local/tmp/find.json" 2>&1 | Out-Null
  $local = Join-Path $env:TEMP 'dshm-find.json'
  & $hdc file recv "/data/local/tmp/find.json" $local 2>&1 | Out-Null
  if (-not (Test-Path $local)) { return $false }
  try { $doc = Get-Content $local -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $false }
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

# ── 2) 装机与启动 ─────────────────────────────────────────────────────────
if (-not $SkipInstall) {
  $hap = Get-ChildItem 'entry\build' -Recurse -Filter *.hap -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $hap) { Write-Host '找不到 HAP，请先 devecocli build' -ForegroundColor Red; exit 4 }
  Write-Host ('安装：' + $hap.Name)
  & $hdc shell 'aa force-stop com.dshm.dshclient' 2>&1 | Out-Null
  & $hdc install -r $hap.FullName 2>&1 | Select-Object -Last 1 | Write-Host
}
& $hdc shell 'hilog -r' 2>&1 | Out-Null
& $hdc shell 'aa start -b com.dshm.dshclient -a EntryAbility' 2>&1 | Select-Object -First 1 | Write-Host
Write-Host ('等待核心就绪（' + $BootWaitSeconds + ' s）…')
Start-Sleep -Seconds $BootWaitSeconds

# ── 3) 采证据 ─────────────────────────────────────────────────────────────
Save-Log 'boot'     'BOOT_10_ENV_READY|BOOT_65|DSHM_PLATFORM|平台标识'
Save-Log 'connect'  'DSHM-AUTH connect|DSHM-CONN|DSHM-WS'
Save-Log 'trace'    'DSHM-TRACE'
Save-Log 'features' 'commands/list|agentPresets/list|skills/list|llm providers|workspace baseline|files changes opened'
Save-Log 'errors'   'CppCrash|AppKilledReporter|JS_ERROR|exitSigno'

Save-Ui 'workspace' ''
# E261：不写死坐标——按文本进入设置与各分区（文本取自界面上真实存在的中文标签）
Click-Text '设置' | Out-Null
Save-Ui 'settings' ''
Click-Text '通用' | Out-Null
Save-Ui 'settings-general' ''
Click-Text '模型' | Out-Null
Save-Ui 'settings-models' ''
Click-Text '核心' | Out-Null
Save-Ui 'settings-core' ''
Click-Text '预设' | Out-Null
Save-Ui 'settings-preset' ''
Click-Text '技能' | Out-Null
Save-Ui 'settings-skills' ''

# ── 4) 报告骨架 ───────────────────────────────────────────────────────────
$boot  = Run-Hdc "hilog -x | grep 'BOOT_10_ENV_READY' | tail -1"
$conn  = Run-Hdc "hilog -x | grep 'DSHM-AUTH connect' | tail -1"
$plat  = Run-Hdc "hilog -x | grep '平台标识' | tail -1"
$files = Run-Hdc "hilog -x | grep 'files changes opened' | tail -1"
$crashes = Run-Hdc "hilog -x | grep -E 'CppCrash|AppKilledReporter|JS_ERROR|exitSigno' | tail -5"

# E262：**可脚本化的判定**（能自动判的就别让人判）——真机上只留给"必须看一眼界面"的项。
$verdicts = @()
function Add-Verdict([string]$item, [bool]$ok, [string]$detail) {
  $script:verdicts += , @($item, $ok, $detail)
}
Add-Verdict '设备在线' ($targets.Trim().Length -gt 0) $targets.Trim()
Add-Verdict '核心已启动' ($boot -match 'BOOT_10_ENV_READY') ($boot -replace '\s+', ' ')
Add-Verdict '客户端已接入（凭据豁免生效）' ($conn -match 'ok=true') ($conn -replace '\s+', ' ')
Add-Verdict '平台标识 = ohos' ($plat -match 'DSHM_PLATFORM=ohos') ($plat -replace '\s+', ' ')
Add-Verdict '文件变更流已开' ($files -match 'cancel=ok') ($files -replace '\s+', ' ')
Add-Verdict '无崩溃记录' (-not ($crashes -match 'CppCrash|AppKilledReporter|JS_ERROR|exitSigno')) ($crashes -replace '\s+', ' ')

$lines = @()
$lines += '# 设备验收报告（' + $stamp + '）'
$lines += ''
$lines += ('设备：' + $targets.Trim())
$lines += ''
$lines += '## 自动读到的读数（原样，不要转述）'
$lines += ''
$lines += '| 项 | 读数 |'
$lines += '|---|---|'
$lines += ('| 核心加载路径 | ' + $boot.Replace("`n", ' ') + ' |')
$lines += ('| 连接结果 | ' + $conn.Replace("`n", ' ') + ' |')
$lines += ('| 平台标识（凭据豁免是否生效） | ' + $plat.Replace("`n", ' ') + ' |')
$lines += ('| 文件变更流是否开启 | ' + $files.Replace("`n", ' ') + ' |')
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
$lines += '> 这几项**不需要你再看**：读数是脚本按判据自动取的（判据与 §14 一致）。'
$lines += '> 未列入的项（命令面板、模型选择、计划模式、轨迹、模型页、插件启停、删除/归档、多形态、目标栏、消息反馈）'
$lines += '> **必须看界面**——它们考的是"行为与呈现"，日志判不出来。'
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
$lines += ''
$lines += '## 截图与布局'
$lines += ''
$lines += '同目录下：<页面>.json（uitest dumpLayout）、<页面>.jpeg（截图）、<阶段>.log（日志摘录）。'
$lines += ''
$lines += '## 结论'
$lines += ''
$lines += '（把 FAIL 项的回执原文贴在这里——本项目排障靠原文，不靠转述。）'

$lines -join "`r`n" | Set-Content -Path (Join-Path $out 'report.md') -Encoding UTF8

Write-Host ''
Write-Host ('完成。报告：' + $out + '\report.md') -ForegroundColor Green
Write-Host '下一步：打开 report.md 按清单逐条勾选；FAIL 项请贴回执原文。'
