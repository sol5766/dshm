# 设备代码指纹核对（DSHM）
#
# 用法（仓库根目录）：
#   powershell -NoProfile -File tools\device-code-fingerprint.ps1
#   powershell -NoProfile -File tools\device-code-fingerprint.ps1 -Token <tok> -Port 3120
#
# ── 它回答什么问题 ────────────────────────────────────────────────────────────
#   复测报告 R4 §1（`dshm-sandbox-retest-r4.md`）用了一整节做**人工取证**来回答
#   「设备上是不是这一轮的新部署」（HAP 安装时间 / cores 目录 / 宿主 pid / 有无新写入）。
#   那四条读数都对，但每轮都要重做，而且**判不出"设备跑的就是本机这份代码"** ——
#   只判得出"最近有没有装过东西"。
#   本脚本把这件事变成一次核对：把**设备核心树里几个决定行为的关键文件**逐字节比对本机树。
#
# ── 三个状态（不许把"读不到"写成"一致"）──────────────────────────────────────
#   一致   /  不一致（列出哪个文件、两个 sha256）  /  未验证（桥不通、超时、树缺文件）
#   退出码：0 一致 / 1 不一致 / 2 未验证（环境不满足）
#
# ── 为什么走应用自身的 Python 桥 ──────────────────────────────────────────────
#   宿主 home（`$filesDir/dsh/home`）是 0700 ⇒ shell 身份读不到里面的 cores 树；
#   而 Python 桥（`/dshm-python/*`）跑在**应用进程内**、与宿主同 UID ⇒ 读得到。
#   token **优先**读 `<HOME_DIR>/host-ready.json` 的 `token` 字段（**当前进程**写出的权威值；
#   实测 0666 ⇒ shell 也读得到），读不到才退回 `$filesDir/dshm-host.log` 里那行 URL ——
#   ⚠️ 日志里的 token 是**启动当时**打印的，`tail -1` 可能抓到**上一个进程**留下的那行，
#   于是桥回 401 `{"error":"token required"}`、脚本把偶发写成「未验证」（2026-10-07 手机档实测：
#   同一台设备手动喂 live token 立刻 5/5 一致）。命令行 `-Token` 优先级最高。
#
# ── 端口从哪来（**别再从日志里猜**）──────────────────────────────────────────
#   那份日志里混着 `ACCEPT #n 127.0.0.1:<临时端口>`（客户端源端口，hdc 转发会保留地址），
#   `grep '127.0.0.1:[0-9]*' | tail -1` 会抓到一个**没人监听**的号 —— 2026-10-06 实测抓到 45700，
#   于是桥请求直接失败、结果被打成"未验证"（真端口是 3120）。真端口读**仓库常量**
#   `entry/src/main/ets/runtime/RuntimePort.ets` 的 `HOST_DEFAULT_PORT`（与运行时同源），
#   并**逐个候选探测**：只有真的答出桥的 JSON 才算数。
#
# 它不做什么：不安装、不卸载、不改设备上任何文件（**只读**）。

param(
  [string]$Token = '',
  [int]$Port = 0,
  [int]$TimeoutSec = 25,
  # 只给**负控制**用：把"本机树"指到别处，验证本脚本真的会红（正常用法不要传）。
  [string]$LocalTree = ''
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

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
if (-not $hdc) { Write-Host '找不到 hdc：请设置 DSHM_HDC 指向 hdc.exe' -ForegroundColor Red; exit 2 }
$targets = (& $hdc list targets 2>&1 | Out-String).Trim()
if ($targets.Length -eq 0 -or $targets -match 'Empty') {
  Write-Host '没有设备（hdc list targets = [Empty]）。接上设备后重跑。' -ForegroundColor Yellow
  exit 2
}
$filesDir = '/data/app/el2/100/base/com.dshm.dshclient/haps/entry/files'
Write-Host ('设备：' + $targets)
Write-Host ('filesDir：' + $filesDir)

# ── 1) 关键文件清单（决定「权限 / 落盘 / 删除」这几条行为的那几个）────────────
# 判据来源：docs/109。清单刻意保持**短**：被改到 = 设备行为会变。
$keyFiles = @(
  'node_modules/@deepseek-ai/dsh-fs-local/lib/index.js',
  'node_modules/@deepseek-ai/dshm-fs-write-nonchmod/lib/denial-hints.js',
  'node_modules/@deepseek-ai/dshm-fs-write-nonchmod/lib/fsio-nochmod.js',
  'node_modules/@deepseek-ai/dshm-tool-fs-remove/lib/denial-hints.js',
  'node_modules/@deepseek-ai/dshm-tool-fs-remove/lib/index.js'
)

# ── 2) 运行中的核心树版本（node-output.log 每轮启动轮转，含 cores/<ver>）────────
$nodeOut = (& $hdc shell "cat $filesDir/node-output.log 2>/dev/null" 2>&1 | Out-String)
$ver = ''
$mv = [regex]::Match($nodeOut, 'cores/([^/\s"'']+)')
if ($mv.Success) { $ver = $mv.Groups[1].Value }
if ($ver.Length -eq 0) {
  Write-Host '读不到运行中的核心树版本（node-output.log 里没有 cores/<ver>）—— 端侧可能没起来' -ForegroundColor Yellow
  exit 2
}
$localTree = if ($LocalTree.Length -gt 0) { $LocalTree } else { Join-Path $root ('dist\core\work\dsh-core-' + $ver) }
Write-Host ('运行中的核心树：' + $ver)
if (-not (Test-Path $localTree)) {
  Write-Host ('本机没有对应目录：' + $localTree + ' ⇒ 先跑 node tools/pack-core.mjs --place-in-app') -ForegroundColor Yellow
  exit 2
}

# ── 3) 安装时间（宿主侧捕获 bm dump：设备侧重定向拿不到 stdout，见 AGENTS.md）──
$bm = (& $hdc shell 'bm dump -n com.dshm.dshclient' 2>&1 | Out-String)
$upd = [regex]::Match($bm, '"updateTime"\s*:\s*(\d{10,})')
if ($upd.Success) {
  $t = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$upd.Groups[1].Value).ToOffset([TimeSpan]::FromHours(8))
  Write-Host ('HAP 安装时间（bm dump updateTime）：' + $t.ToString('yyyy-MM-dd HH:mm:ss') + ' +0800')
} else {
  Write-Host 'HAP 安装时间：读不到（bm dump 里没有 updateTime）' -ForegroundColor DarkGray
}

# ── 4) token 与端口 ──────────────────────────────────────────────────────────
# 取 token 的顺序：命令行 -Token > host-ready.json（权威） > dshm-host.log（可能过期）。
# 每条来源都记下来打进输出 —— "token 从哪来"是判「未验证」时唯一能自证的信息。
$TokenSrc = ''
if ($Token.Length -gt 0) { $TokenSrc = '命令行 -Token' }
if ($Token.Length -eq 0) {
  $readyRaw = (& $hdc shell "cat $filesDir/dsh/home/host-ready.json 2>/dev/null" 2>&1 | Out-String)
  $rm = [regex]::Match($readyRaw, '"token"\s*:\s*"([A-Za-z0-9_\-]+)"')
  if ($rm.Success) { $Token = $rm.Groups[1].Value; $TokenSrc = 'host-ready.json' }
}
if ($Token.Length -eq 0) {
  $tokLine = (& $hdc shell "grep -ao 'token=[A-Za-z0-9_-]*' $filesDir/dshm-host.log 2>/dev/null | tail -1" 2>&1 | Out-String)
  $Token = ($tokLine -replace '.*token=', '').Trim()
  if ($Token.Length -gt 0) { $TokenSrc = 'dshm-host.log（⚠️ 可能是旧进程留下的）' }
}
if ($Token.Length -eq 0) {
  Write-Host '拿不到宿主 token（host-ready.json 与 dshm-host.log 都没有）⇒ 未验证' -ForegroundColor Yellow
  exit 2
}
Write-Host ('token 来源：' + $TokenSrc + '（长度 ' + $Token.Length + '）') -ForegroundColor DarkGray

# 端口候选：**不要**再从日志里 grep `127.0.0.1:<n>` 当端口 —— 那份日志里混着
# `ACCEPT #n 127.0.0.1:<临时端口>`（客户端源端口，hdc 转发会保留），
# `tail -1` 抓到的是一个**没人监听**的号：2026-10-06 实测抓到 45700，
# 于是桥请求失败、报告打成"未验证"（真端口是 3120）。
# 真端口是**仓库里的常量**，与运行时同源：entry/src/main/ets/runtime/RuntimePort.ets
# 的 HOST_DEFAULT_PORT（NodeRuntime.ets 取它传给 buildHostEnv ⇒ main.js 的 DSHM_PORT）。
$portCands = New-Object 'System.Collections.Generic.List[int]'
if ($Port -gt 0) { $portCands.Add([int]$Port) }
$portSrc = Join-Path $root 'entry\src\main\ets\runtime\RuntimePort.ets'
if (Test-Path $portSrc) {
  $pm = [regex]::Match([IO.File]::ReadAllText($portSrc), 'HOST_DEFAULT_PORT\s*:\s*number\s*=\s*(\d+)')
  if ($pm.Success) { $portCands.Add([int]$pm.Groups[1].Value) }
}
$oriLine = (& $hdc shell "grep -aoE 'origin=http://127\.0\.0\.1:[0-9]+' $filesDir/dshm-host.log 2>/dev/null | tail -1" 2>&1 | Out-String)
$pm2 = [regex]::Match($oriLine, ':(\d+)')
if ($pm2.Success) { $portCands.Add([int]$pm2.Groups[1].Value) }
if ($portCands.Count -eq 0) { $portCands.Add(3120) }
$portCands = @($portCands | Select-Object -Unique)

# 我们建的转发要记下来：失败时撤掉，别在宿主/设备上留垃圾（只动 fport，不碰任何设备文件）。
$fpBefore = (& $hdc fport ls 2>&1 | Out-String)
$fpCreated = New-Object 'System.Collections.Generic.List[int]'

# ── 5) 设备侧取指纹（Python 桥跑在应用进程内 ⇒ 读得到 0700 的 home）────────────
$keyJson = '["' + ($keyFiles -join '","') + '"]'
$pyLines = @(
 'import hashlib, json, os',
 'home = os.environ.get("HOME", "")',
 'ver = "__VER__"',
 'root = os.path.join(home, "dsh", "cores", ver)',
 'print("TREE " + root)',
 'files = json.loads(__FILES__)',
 'for rel in files:',
 '    p = os.path.join(root, rel)',
 '    try:',
 '        with open(p, "rb") as f:',
 '            b = f.read()',
 '        print("SHA %s %d %s" % (rel, len(b), hashlib.sha256(b).hexdigest()))',
 '    except Exception as e:',
 '        print("MISS %s %s" % (rel, e))'
)
# Python 里带 json 清单也要单引号包住（json.loads 的实参）⇒ 用 json.loads(<list literal>) 形式：
$py = ($pyLines -join "`n").Replace('__VER__', $ver).Replace('json.loads(__FILES__)', 'json.loads(' + "'" + $keyJson + "'" + ')')
$urlCode = '&code=' + [uri]::EscapeDataString($py)

# 候选端口逐个试：只有**真的答出桥的 JSON** 的才算数（连不上 / 401 / 非 JSON 都换下一个）。
$resp = $null
$Port = 0
$saw401 = $false
foreach ($cand in $portCands) {
  if ($fpBefore -notmatch ('tcp:' + $cand + '\s+tcp:' + $cand)) {
    & $hdc fport "tcp:$cand" "tcp:$cand" 2>&1 | Out-Null
    $fpCreated.Add([int]$cand)
  }
  # **重试是必需的**：hdc 的转发偶发在**客户端侧立刻**报 "基础连接已经关闭: 接收时发生错误"，
  # 而设备侧其实已经应答（日志里有 IN-DONE/status）。一次失败就下"未验证"结论，
  # 等于把**偶发**说成**事实** —— 2026-10-06 实测踩到过（同一设备、同一 token，下一拍就成功）。
  for ($try = 1; $try -le 3; $try++) {
    $u = 'http://127.0.0.1:' + $cand + '/dshm-python/run-get?token=' + $Token + $urlCode
    try { $c = (Invoke-WebRequest -UseBasicParsing -TimeoutSec $TimeoutSec -Uri $u).Content } catch {
      $c = $null
      if ($_.Exception.Response -and ([int]$_.Exception.Response.StatusCode -eq 401)) { $saw401 = $true }
    }
    if ($c -and $c -match '"ok"') { $Port = $cand; $resp = $c; break }
    if ($try -lt 3) { Start-Sleep -Milliseconds 500 }
  }
  if ($resp) { break }
  Write-Host ('  端口 ' + $cand + ' 不应答（或答的不是桥的 JSON），换下一个候选…') -ForegroundColor DarkGray
}
if (-not $resp) {
  foreach ($c in $fpCreated) { & $hdc fport rm "tcp:$c" "tcp:$c" 2>&1 | Out-Null }
  if ($saw401) {
    # 「401 要说清楚」：这是**能自证**的失败 —— 桥活着，只是不认这个 token。
    Write-Host ('桥回了 401（token 不被当前进程接受）—— token 来源：' + $TokenSrc) -ForegroundColor Yellow
    Write-Host ('  ⇒ 日志里的 token 会随进程重启过期；权威值是 <HOME_DIR>/host-ready.json 的 `token`，' +
                '也可直接 -Token <live> 喂进来') -ForegroundColor Yellow
  } else {
    Write-Host ('桥请求失败（候选端口 ' + ($portCands -join ' / ') + ' 都不应答）⇒ 未验证') -ForegroundColor Yellow
  }
  exit 2
}
foreach ($c in $fpCreated) { if ($c -ne $Port) { & $hdc fport rm "tcp:$c" "tcp:$c" 2>&1 | Out-Null } }
Write-Host ('桥：127.0.0.1:' + $Port + '（token 长度 ' + $Token.Length + '，来源 ' + $TokenSrc + '）')
try { $j = $resp | ConvertFrom-Json } catch {
  Write-Host ('桥返回不是 JSON ⇒ 未验证：' + $resp.Substring(0, [Math]::Min(200, $resp.Length))) -ForegroundColor Yellow
  exit 2
}
if (-not $j.ok) {
  Write-Host ('桥返回 ok=false ⇒ 未验证：' + (($j.errStderr | Out-String).Trim())) -ForegroundColor Yellow
  exit 2
}
$lines = @(($j.stdout -split "`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
$devTree = ''
$mt = $lines | Where-Object { $_ -like 'TREE *' } | Select-Object -First 1
if ($mt) { $devTree = $mt.Substring(5) }
Write-Host ('设备树：' + $devTree)

# ── 6) 比对 ─────────────────────────────────────────────────────────────────
$mismatch = 0; $unread = 0; $matched = 0
Write-Host ''
Write-Host '关键文件指纹（设备 vs 本机树；sha256）'
foreach ($rel in $keyFiles) {
  $devLine = $lines | Where-Object { $_ -like ('SHA ' + $rel + ' *') } | Select-Object -First 1
  $local = Join-Path $localTree ($rel -replace '/', '\')
  if (-not (Test-Path $local)) { Write-Host ('  ???   ' + $rel + '（本机树里没有这个文件）') -ForegroundColor Yellow; $unread++; continue }
  if (-not $devLine) { Write-Host ('  ???   ' + $rel + '（设备侧读不到）') -ForegroundColor Yellow; $unread++; continue }
  $dh = ($devLine -split ' ')[3]
  $lh = (Get-FileHash $local -Algorithm SHA256).Hash.ToLower()
  if ($dh -eq $lh) { Write-Host ('  ok    ' + $rel) -ForegroundColor Green; $matched++ }
  else {
    Write-Host ('  FAIL  ' + $rel) -ForegroundColor Red
    Write-Host ('          设备 ' + $dh)
    Write-Host ('          本机 ' + $lh)
    $mismatch++
  }
}

Write-Host ''
if ($mismatch -gt 0) {
  Write-Host ('结论：不一致（' + $mismatch + ' 个文件不同）—— 设备**不是**在本机这份核心树上跑；先确认装机/出包链路，再复测。') -ForegroundColor Red
  exit 1
}
if ($unread -gt 0) {
  Write-Host ('结论：未验证（' + $matched + ' 个一致，' + $unread + ' 个读不到）—— 读不到不等于一致。') -ForegroundColor Yellow
  exit 2
}
Write-Host ('结论：一致（' + $matched + '/' + $keyFiles.Count + '）—— 设备正在跑的核心树就是本机 ' + $ver + ' 这份。') -ForegroundColor Green
exit 0
