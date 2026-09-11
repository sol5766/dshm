# 等待真机上线后自动完成「安装 + 冷启动计时 + 对话验证」。
# 用法：& scripts\wait-and-verify-device.ps1
# 说明：本会话的设备 target 是 86E0226429000417（MNTXM-24B 2in1）。
$ErrorActionPreference = 'Continue'
$hdc = 'C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
$T = '86E0226429000417'
$hap = 'D:\desktop\temp\dsh-OHDSH\entry\build\default\outputs\default\entry-default-signed.hap'
$base = '/data/app/el2/100/base/com.dshm.agentic/haps/entry/files'
$outDir = 'D:\desktop\temp\dsh-OHDSH\build\verify'
$log = Join-Path $outDir 'device-verify.log'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function W([string]$m) {
  $line = (Get-Date -Format 'HH:mm:ss') + '  ' + $m
  Write-Host $line
  Add-Content -Path $log -Value $line -Encoding utf8
}
function DeviceOnline {
  $t = (& $hdc list targets -v 2>&1 | Out-String)
  foreach ($line in ($t -split "`n")) {
    if ($line -match [regex]::Escape($T) -and $line -match 'Connected') { return $true }
  }
  return $false
}
function Shell([string]$cmd) { (& $hdc -t $T shell $cmd 2>&1 | Out-String).Trim() }
function Shot([string]$name) {
  & $hdc -t $T shell "snapshot_display -f /data/local/tmp/$name.jpeg" 2>&1 | Out-Null
  & $hdc -t $T file recv "/data/local/tmp/$name.jpeg" (Join-Path $outDir "$name.jpeg") 2>&1 | Out-Null
}
function Layout {
  & $hdc -t $T shell "uitest dumpLayout -p /data/local/tmp/lay.json" 2>&1 | Out-Null
  $p = Join-Path $outDir 'lay.json'
  & $hdc -t $T file recv /data/local/tmp/lay.json $p 2>&1 | Out-Null
  return (Get-Content -Raw -Encoding utf8 $p | ConvertFrom-Json)
}
function Center([string]$b) {
  $m = [regex]::Match($b, '\[(\d+),(\d+)\]\[(\d+),(\d+)\]')
  if (-not $m.Success) { return $null }
  $x1 = [int]$m.Groups[1].Value; $y1 = [int]$m.Groups[2].Value
  $x2 = [int]$m.Groups[3].Value; $y2 = [int]$m.Groups[4].Value
  return @([int](($x1 + $x2) / 2), [int](($y1 + $y2) / 2))
}
function FindNodes($json, [string]$textEq, [string]$hintLike) {
  $script:acc = @()
  function Walk($n) {
    $a = $n.attributes
    if ($a) {
      if ($textEq -ne '' -and $a.text -eq $textEq) { $script:acc += $a.bounds }
      if ($hintLike -ne '' -and $a.hint -and $a.hint -like $hintLike) { $script:acc += $a.bounds }
    }
    if ($n.children) { foreach ($c in $n.children) { Walk $c } }
  }
  Walk $json
  return $script:acc
}

W '=== 等待真机上线（最多 180 分钟）==='
$deadline = (Get-Date).AddMinutes(180)
while (-not (DeviceOnline)) {
  if ((Get-Date) -gt $deadline) { W '设备在 180 分钟内未上线，退出'; exit 1 }
  Start-Sleep -Seconds 10
}
W '设备已上线'

W '=== 安装 HAP（含 ENV_VERSION=20260911-101 的环境与性能补丁）==='
$install = (& $hdc -t $T install -r $hap 2>&1 | Out-String)
W ('install: ' + ($install -replace "`r?`n", ' | '))
if ($install -notmatch 'successfully') { W '安装未成功，退出'; exit 1 }

W '=== 冷启动计时（首次启动会额外解压环境，约 6.6s）==='
& $hdc -t $T shell "aa force-stop com.dshm.agentic" 2>&1 | Out-Null
Start-Sleep -Seconds 3
$sw = [Diagnostics.Stopwatch]::StartNew()
& $hdc -t $T shell "aa start -a EntryAbility -b com.dshm.agentic" 2>&1 | Out-Null
$urlAt = $null
for ($i = 0; $i -lt 300; $i++) {
  Start-Sleep -Seconds 2
  $n = Shell "grep -c 'dsh web: http' $base/log/*.log 2>/dev/null | tail -1"
  if ($n -match '^[1-9]') { $urlAt = [math]::Round($sw.Elapsed.TotalSeconds, 1); break }
}
W ('冷启动到「打印带 token 的 URL」用时: ' + $urlAt + ' 秒')
W ('boot-timing: ' + (Shell "cat $base/boot-timing.txt 2>/dev/null | tr '\n' ' '"))
W ('环境版本: ' + (Shell "cat $base/dsh/.dshm-version 2>/dev/null"))
Start-Sleep -Seconds 12
Shot 'dev-1'

W '=== 对话验证：新建会话 → 输入 7*6 → 发送 ==='
$j = Layout
$newChat = FindNodes $j '新建会话' ''
if ($newChat.Count -eq 0) { W '未找到「新建会话」按钮'; }
else {
  $c = Center $newChat[0]
  & $hdc -t $T shell "uitest uiInput click $($c[0]) $($c[1])" 2>&1 | Out-Null
  Start-Sleep -Seconds 3
  $j = Layout
  $fields = FindNodes $j '' '*发消息*'
  if ($fields.Count -eq 0) { W '未找到输入框'; }
  else {
    $f = Center $fields[0]
    & $hdc -t $T shell "uitest uiInput click $($f[0]) $($f[1])" 2>&1 | Out-Null
    Start-Sleep -Milliseconds 900
    & $hdc -t $T shell "uitest uiInput inputText $($f[0]) $($f[1]) 7*6" 2>&1 | Out-Null
    Start-Sleep -Seconds 2
    $j = Layout
    $send = FindNodes $j '发送消息' ''
    if ($send.Count -eq 0) { W '未找到发送按钮' }
    else {
      $s = Center $send[0]
      & $hdc -t $T shell "uitest uiInput click $($s[0]) $($s[1])" 2>&1 | Out-Null
      Start-Sleep -Seconds 15
      Shot 'dev-2'
      W '已发送并截图 dev-2.jpeg（请人工确认回答是否为 42）'
    }
  }
}
W ('node 日志尾部: ' + (Shell "tail -3 $base/log/node-*.log" -replace "`r?`n", ' | '))
W '=== 完成 ==='
