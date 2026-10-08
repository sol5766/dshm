<#
  DSHM 真机安全更新 —— 唯一允许的装机入口。

  【为什么必须用这个脚本而不是手敲 hdc install】
  2026-09-25 的事故：为"清理环境"执行了裸 `hdc uninstall`，删掉了真机上
  用户的 6 个会话、7 个插件、2 个工作区，且不可恢复。
  根因不是"不知道 -r"，而是**把破坏性操作当成了流程的正常一步**。

  所以本脚本的设计目标是：**让"删数据"这件事在流程里不存在**。
    · 全程只用 `hdc install -r`（覆盖安装），不出现任何 uninstall
    · 装完必须验证用户数据仍在，否则明确失败
    · 任一步失败就停，不静默继续

  【用法】
    .\tools\update-device.ps1                      # 用默认构建产物
    .\tools\update-device.ps1 -Hap <路径>          # 指定 HAP
    .\tools\update-device.ps1 -SkipRebuild         # 不重编，只装现有产物
#>

param(
    [string]$Hap = '',
    [switch]$SkipRebuild,
    [int]$BootWaitSec = 90
)

$ErrorActionPreference = 'Stop'

# ── 路径 ─────────────────────────────────────────────────────────────────
$root = Split-Path -Parent $PSScriptRoot
$clt = 'C:\Program Files\Huawei\DevEco Studio\tools'
# 从已安装的 SDK 版本目录里找 hdc：版本号会随 SDK 升级而变，写死就得改脚本
$sdkRoot = Join-Path $env:USERPROFILE 'AppData\Local\OpenHarmony\Sdk'
$hdc = (Get-ChildItem -Path (Join-Path $sdkRoot '*\toolchains\hdc.exe') -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1).FullName
if (-not $hdc) { $hdc = '' }
$bundle = 'com.dshm.dshclient'
$filesDir = "/data/app/el2/100/base/$bundle/haps/entry/files"

if (-not (Test-Path $hdc)) { throw "找不到 hdc：$hdc" }

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  OK   $msg" -ForegroundColor Green }
function Bad($msg)  { Write-Host "  FAIL $msg" -ForegroundColor Red }
function Info($msg) { Write-Host "       $msg" -ForegroundColor DarkGray }

function Shell($cmd) {
    return (& $hdc shell $cmd 2>&1 | Out-String).Trim()
}

# ── 0) 硬约束自检：本脚本自身不得含破坏性命令 ────────────────────────────
# 【为什么不做全文本扫描】前两版都误报了：
#   v1 扫全文 → 被自己的注释命中，一运行就 throw
#   v2 去掉 # 开头的行 → 仍误报，因为块注释 <# ... #> 的内容不以 # 开头，
#      且 Write-Host 的提示文字**必须**提到这些命令名（否则没法向人解释禁止原因）
# 纯文本扫描分不清「提到」与「执行」。改成只检查**真正的命令调用形态**。
Step 0 '自检：确认本脚本不含任何卸载/删数据命令'
$violations = @()
$UNST = 'unin' + 'stall'          # 片段拼接：避免模式串本身被后续匹配到
foreach ($raw in (Get-Content $PSCommandPath)) {
    $t = $raw.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    # 形态一：把 hdc 当命令调用且带卸载子命令
    if ($t -match '[&$]\s*hdc\b' -and $t -match $UNST) { $violations += $t; continue }
    # 形态二：Shell/反引号里跑 bm 卸载
    if ($t -match '\bbm\b' -and $t -match $UNST) { $violations += $t; continue }
    # 形态三：任何 rm -rf
    if ($t -match ('rm' + '\s+' + '-rf')) { $violations += $t }
}
if ($violations.Count -gt 0) {
    Bad '代码里出现了卸载/删数据调用：'
    $violations | ForEach-Object { Write-Host "    $_" }
    throw '拒绝运行：本脚本只允许覆盖安装'
}
Ok '无卸载调用，符合「永不删数据」约束'

# ── 1) 设备 ──────────────────────────────────────────────────────────────
Step 1 '检查设备连接'
$targets = (& $hdc list targets 2>&1 | Out-String).Trim()
if ($targets -match 'Empty' -or $targets -eq '') {
    Bad '没有连接的设备'
    throw '请先连接设备'
}
$dev = ($targets -split "`r?`n")[0].Trim()
Ok "设备 $dev"

# ── 2) 记录安装前的数据基线（用于装后比对）───────────────────────────────
Step 2 '记录安装前的用户数据基线'
$beforeHomeStat = Shell "stat -c 'links=%h size=%s' $filesDir/dsh/home 2>/dev/null"
$beforeHomeCount = Shell "ls $filesDir/dsh/home 2>/dev/null | wc -l"
$beforeCores = Shell "ls $filesDir/dsh/cores 2>/dev/null"
# 【为什么用 stat 而不是 `ls | wc -l`（2026-10-05 修）】`dsh/home` 是 **0700**、`hdc shell` 是另一个 uid
# ⇒ `ls` 被拒、`| wc -l` **恒 0**，于是这里每次打"home 为空"、第 7 步必然 SKIP ——
# 那个"数据保全"校验是**结构性假通过**，还会把人误导成"数据被清了"。
# 实测：同一时刻 `stat` 给出 `links=13 size=3440`（数据完好）。`stat` 读目录本身可用 ⇒ 改用它做判据。
$beforeHomeLinks = if ($beforeHomeStat -match 'links=(\d+)') { [int]$Matches[1] } else { -1 }
Info "home 指纹：$beforeHomeStat"
Info "核心树：$($beforeCores -replace "`n", ', ')"
if ($beforeHomeLinks -lt 0) {
    Write-Host '  NOTE 拿不到 home 指纹（路径不存在或权限受限）——本次无法比对数据保全' -ForegroundColor Yellow
} elseif ([int]$beforeHomeCount -eq 0) {
    Info "（`ls` 读不到条目是**预期**：home 是 0700、shell 是另一个 uid；以指纹为准，不要据此判断「数据被清」）"
}

# ── 2b) 日志台账基线（本轮"新鲜度"判据）──────────────────────────────────
# 【为什么必须有这一段（2026-10-06 真机踩到）】`dshm-host.log` 是**跨 boot 追加**的
# （首行至今仍是 2026-09-27 的 boot 标记），而第 8 步原先只取"最后一行 exec 探测"——
# 于是一次 `hdc install -r` 之后应用根本没起来，脚本照样报
#   OK   Host HTTP 已就绪（有 websocket 接入）
#   FAIL exec 探测未全通（共 13 项）：…（**上一轮**的读数）
# 即"端侧就绪"是**假绿**，而它正是"装机到底成没成"的唯一判据。改法：先记几个只增不减的
# 计数器，装后必须**增加**才认这一轮。
function LogCount($pattern) {
    # 【必须带 -e（2026-10-06 实测）】模式串以 `-` 开头时（如 `--- boot pid=`）会被 grep
    # 当成选项：`grep -c '--- boot pid='` 实测返回 **0**（不是报错），基线因此静默变成 0。
    $n = Shell "grep -c -e '$pattern' $filesDir/dshm-host.log 2>/dev/null"
    if ($n -match '^\d+$') { return [int]$n }
    return 0
}
$beforeBootCount = LogCount '--- boot pid='
$beforeExecCount = LogCount 'exec 探测：'
$beforeMuxCount  = LogCount 'IN-UPGRADE GET /api/remote.mux'
Info "日志台账基线：boot=$beforeBootCount exec=$beforeExecCount mux=$beforeMuxCount"

# ── 3) 构建 ──────────────────────────────────────────────────────────────
if (-not $SkipRebuild) {
    Step 3 '构建 debug 版（侧载与验收统一用 debug，签名=debugKey）'
    $env:JAVA_HOME = 'C:\Program Files\Huawei\DevEco Studio\jbr'
    $env:DEVECO_SDK_HOME = 'C:\Program Files\Huawei\DevEco Studio\sdk'
    $env:DEVECO_CLI_CLT_PATH = $clt
    $env:PATH = "$env:JAVA_HOME\bin;$clt\node;$env:PATH"
    Push-Location $root
    # 【为什么这一段临时把 ErrorActionPreference 降为 Continue（2026-10-05 实测踩到）】
    # 下面那行是 `*> 日志文件` —— 这是 **PowerShell 层的 stderr 重定向**。PS 5.1 会把原生命令
    # 写到 stderr 的**每一行**包成一个 ErrorRecord；而本脚本开头设了
    # `$ErrorActionPreference = 'Stop'`，于是 hvigor 的一句警告
    # （实测逐字：`> hvigor WARN: Warning: 'page_show' conflict, first declared.`）
    # 就会把脚本**当场终止**并报 `NativeCommandError`，构建根本没跑完 ——
    # 症状是"唯一受认可的装机入口突然装不了"，而且真正的构建错误反而被这行噪声盖住。
    # 因此只在这一段放宽：stderr 一行不少地进日志，构建结果照旧用 $LASTEXITCODE 判定（见下）。
    # 别把这段挪出 try/finally —— 它只保护这一次重定向调用。
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & "$clt\node\node.exe" "$clt\hvigor\bin\hvigorw.js" assembleHap `
            --mode module -p product=default -p buildMode=debug --no-daemon *> "$root\dist\_update_build.log"
        $buildExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
        Pop-Location
    }
    if ($buildExit -ne 0) {
        Get-Content "$root\dist\_update_build.log" -Tail 25
        throw '构建失败'
    }
    Ok '构建成功'
} else {
    Step 3 '跳过构建（-SkipRebuild）'
}

# ── 4) 定位 HAP ──────────────────────────────────────────────────────────
Step 4 '定位 HAP'
if ($Hap -eq '') {
    $Hap = Join-Path $root 'entry\build\default\outputs\default\entry-default-signed.hap'
}
if (-not (Test-Path $Hap)) { throw "找不到 HAP：$Hap" }
$hapSize = [math]::Round((Get-Item $Hap).Length / 1MB, 1)
Ok "$hapSize MiB  $Hap"

# ── 5) 覆盖安装（唯一的装机动作）─────────────────────────────────────────
Step 5 '覆盖安装（hdc install -r —— 保留用户数据）'
$out = (& $hdc install -r $Hap 2>&1 | Out-String)
if ($out -notmatch 'successfully') {
    Bad '安装失败，原始输出：'
    Write-Host $out
    Write-Host ''
    Write-Host '  若报签名冲突（signature verification failed）：' -ForegroundColor Yellow
    Write-Host '    · 先问用户，不要自行卸载' -ForegroundColor Yellow
    Write-Host '    · 确需卸载时用 hdc uninstall -k，且卸载后立即验证数据仍在' -ForegroundColor Yellow
    throw '安装失败'
}
Ok '覆盖安装成功'

# ── 6) 冷启动 ────────────────────────────────────────────────────────────
Step 6 '冷启动应用'
Shell "aa force-stop $bundle" | Out-Null
Start-Sleep -Seconds 2
Shell "aa start -a EntryAbility -b $bundle" | Out-Null
# 【为什么从"盲等 90 秒"改成"轮询到出现本轮 exec 探测"（2026-10-06 真机踩到）】
# 盲等只能保证"过了 90 秒"，不能保证"应用起来了"：实测 `hdc install -r` 之后那一次
# `aa start` 没把应用拉起来（日志停在上一轮的 LOOP-ALIVE），而第 8 步读到上一轮日志，
# 于是脚本报"端侧就绪"。轮询判据用 2b 记下的 exec 计数增量——它只在**真 boot** 时长。
Info "等待启动（最多 $BootWaitSec 秒；首次可能需解包核心树）"
$booted = $false
$waited = 0
while ($waited -lt $BootWaitSec) {
    Start-Sleep -Seconds 5
    $waited += 5
    if ((LogCount 'exec 探测：') -gt $beforeExecCount) { $booted = $true; break }
}
if ($booted) {
    Ok "端侧已起来（第 $waited 秒出现本轮 exec 探测）"
} else {
    Info "第 $waited 秒仍未见本轮 boot —— 再拉一次前台（实测 install 后首次 aa start 有概率不生效）"
    Shell "aa start -a EntryAbility -b $bundle" | Out-Null
    Start-Sleep -Seconds 25
    if ((LogCount 'exec 探测：') -gt $beforeExecCount) {
        Ok '重拉之后端侧已起来'
    } else {
        Bad '端侧没有起来：本轮没有任何新的 exec 探测行'
    }
}

# ── 7) 验证：数据是否保留 ────────────────────────────────────────────────
Step 7 '验证用户数据仍在（这是关键一步）'
$afterHomeStat = Shell "stat -c 'links=%h size=%s' $filesDir/dsh/home 2>/dev/null"
$afterCores = Shell "ls $filesDir/dsh/cores 2>/dev/null"
$afterHomeLinks = if ($afterHomeStat -match 'links=(\d+)') { [int]$Matches[1] } else { -1 }
Info "home 指纹：$beforeHomeStat → $afterHomeStat"
Info "核心树：$($afterCores -replace "`n", ', ')"

$dataOk = $true
$dataChecked = $false
if ($beforeHomeLinks -lt 0 -or $afterHomeLinks -lt 0) {
    Write-Host '  SKIP 拿不到 home 指纹（路径不存在或权限受限）——本次无法比对' -ForegroundColor Yellow
} else {
    # 【判据：子目录数（links）不得减少】目录的 `size` 会随目录项增减而变、也可能因实现而异
    # ⇒ 只把它当参考值打印；**减少**才是数据丢失的信号（相等/增加都算保留）。
    $dataChecked = $true
    if ($afterHomeLinks -lt $beforeHomeLinks) {
        Bad "home 子目录数减少（links $beforeHomeLinks → $afterHomeLinks）—— 数据可能丢失"
        $dataOk = $false
    } else {
        Ok "home 指纹：子目录数未减少（links $beforeHomeLinks → $afterHomeLinks；$afterHomeStat）"
    }
}

# 【2026-09-28 升级 0.2.0-rc.1】此处的版本判据从 core-recipe.json 读取，不再写死：
# 写死的那一版在升级后会报 FAIL 并把结论置为"更新未完全通过"（:203-204 exit 1），
# 见 docs/90 §8.1 的"两处版本硬编码"表。核心树按版本各存一份、且旧树并存是**预期**
# （docs/50:45），所以这里只要求"新版在"，不要求"旧版不在"。
$recipePath = Join-Path $PSScriptRoot '..\hostcore\core-recipe.json'
# 必须显式指定 UTF-8：core-recipe.json 里有中文注释，而 PS 5.1 的 -Raw 默认按
# ANSI 解码，中文变乱码后 ConvertFrom-Json 直接抛「传入的对象无效」。
$recipeText = [System.IO.File]::ReadAllText($recipePath, [System.Text.Encoding]::UTF8)
$wantCore = ($recipeText | ConvertFrom-Json).coreVersion
if ($afterCores -notmatch [regex]::Escape($wantCore)) {
    Bad "核心树里没看到 $wantCore（core-recipe.json 的 coreVersion）"
    $dataOk = $false
} else {
    Ok "核心树 $wantCore 在"
}

# ── 8) 验证：端侧就绪 ────────────────────────────────────────────────────
# 【2026-09-28 升级 0.2.0-rc.1】原先这里写死 `$okCount -ge 7`（7 = exec 探测项数）。
# 写死总数会**在新增探测目标后失效**：8 项里只 ok 了 7 项（新的那项失败）依然是"通过"。
# 改为"逐项都必须 =ok、且至少有一项"——探测项数由 hostcore/app/main.js 的
# execProbeTargets() 决定，这里不再持有总数。见 docs/90 §8.1。
Step 8 '验证端侧就绪（exec 探测逐项 + HTTP；只认本轮新读数）'
# 【档位识别（2026-10-06 加）】`const.product.devicetype` 是宿主侧可读的系统参数，
# 与 ArkTS 侧 `deviceInfo.deviceType` 同源（platform 的 DeviceFacts.formOf 归一规则：
# phone / tablet ⇒ 手持；2in1 / 2in1_foldable / desktop ⇒ 桌面）。读不到就按**非手持**
# 处理 —— 即保持本脚本原先那条最严判据，绝不因为读不到形态而放宽。
$deviceType = (Shell 'param get const.product.devicetype' | Out-String).Trim()
$handheld = ($deviceType -eq 'phone' -or $deviceType -eq 'tablet')
Info "设备形态 const.product.devicetype=$deviceType（判据：$(if ($handheld) { '手持档' } else { 'PC/2in1 档（或未识别 ⇒ 从严）' })）"
$log = Shell "grep -E 'exec 探测：' $filesDir/dshm-host.log 2>/dev/null | tail -1"
Info $log
$afterExecCount = LogCount 'exec 探测：'
$probe = [regex]::Match($log, 'exec 探测：(.*)')
$execOk = $false
if ($afterExecCount -le $beforeExecCount) {
    Bad "本轮没有新的 exec 探测行（$beforeExecCount → $afterExecCount）—— 读数不可用，端侧可能没起来"
} elseif (-not $probe.Success) {
    Bad '宿主日志里没有 exec 探测行'
} else {
    $items = @($probe.Groups[1].Value -split '[，,]' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    if ($handheld) {
        # ── 手持档判据（2026-10-06 加）───────────────────────────────────
        # 【为什么必须分档】原先只有一条判据「逐项都 =ok」。那对 PC/2in1 是对的，对手机 /
        # 平板却是**假红**：手机档下随包自签名 ELF 一律被系统拒绝（`rg/ash/bash=denied`）、
        # 系统 sh 连 stat 都拿不到（`system-sh=缺`），这是**已定案的平台行为**（docs/104、
        # docs/106 §1.2），不是装机失败。旧写法会在手机上报「更新未完全通过」，把读者推向
        # 「回滚 / 重装」的错误方向（本项目的纪律：**假红和假绿一样有害**）。
        # 【为什么用规则而非标签白名单】探测项由 main.js 的 `execProbeTargets()` 决定，写死
        # 标签会像旧版写死总数（`-ge 7`）那样在新增探测项后静默失效（见 docs/90 §8.1）。
        # 故这里只按"值的形状"判：手持档必须至少有一条**真命令通道**（=ok），其余 =denied /
        # =缺 逐条打印但不判失败；若一条 =denied 都没有，说明平台策略可能变了 ⇒ 提示复测。
        $okItems = @($items | Where-Object { $_ -match '=ok$' })
        $deniedItems = @($items | Where-Object { $_ -match '=denied$' })
        $absentItems = @($items | Where-Object { $_ -match '=缺$' })
        if ($deniedItems.Count -gt 0) {
            Info "=denied  $($deniedItems -join '，')  ← 随包 ELF / 系统 sh 被 MAC 拒绝，属预期（docs/104）"
        } else {
            Info "本轮没有一条 =denied —— 若随包 ELF 真的被放行了（OS 升级？），docs/104 的结论需要复测"
        }
        if ($absentItems.Count -gt 0) {
            Info "=缺      $($absentItems -join '，')  ← 未解包，或连 stat 都被拒（system-sh 属后者）"
        }
        # 判据：宿主必须还能 execve **系统**真命令（toybox）。它在 PC 与手机上都该是 ok。
        $toyboxOk = @($items | Where-Object { $_ -match '^toybox=ok$' }).Count -gt 0
        if ($items.Count -gt 0 -and $toyboxOk) {
            Ok "exec 探测：手持档判据通过（toybox=ok ⇒ 真命令通道在；共 $($items.Count) 项，其中 =ok $($okItems.Count) / =denied $($deniedItems.Count)）"
            $execOk = $true
        } else {
            Bad "手持档下 toybox 未 ok（$($items -join '，')）—— 宿主连系统真命令都起不来，需查"
        }
    } else {
        $bad = @($items | Where-Object { $_ -notmatch '=ok$' })
        if ($items.Count -gt 0 -and $bad.Count -eq 0) {
            Ok "exec 探测 $($items.Count)/$($items.Count) 全通"
            $execOk = $true
        } else {
            Bad "exec 探测未全通（共 $($items.Count) 项）：$($bad -join '，')"
        }
    }
}

$afterMuxCount = LogCount 'IN-UPGRADE GET /api/remote.mux'
if ($afterMuxCount -gt $beforeMuxCount) {
    Ok "Host HTTP 已就绪（本轮有新的 websocket 接入：$beforeMuxCount → $afterMuxCount）"
} else {
    # 非判据：界面没连上来时本来就没有 websocket —— 旧写法 `grep -c … -gt 0` 对**跨 boot
    # 追加**的日志是**恒真**的，等于每次都替这一步背书。
    Info "本轮未见新的 websocket 接入（$beforeMuxCount → $afterMuxCount；非判据）"
}

# ── 9) 结论 ──────────────────────────────────────────────────────────────
Write-Host ''
if ($dataOk -and $execOk) {
    if ($dataChecked) {
        Write-Host '更新完成：代码已换、用户数据已确认保留、端侧就绪。' -ForegroundColor Green
    } else {
        Write-Host '更新完成（部分验证）：代码已换、端侧就绪。' -ForegroundColor Green
        Write-Host '  注意：本次**未能验证**「用户数据被保留」—— 安装前 home 为空。' -ForegroundColor Yellow
    }
} else {
    Write-Host '更新未完全通过 —— 见上面的 FAIL 项，不要据此宣布成功。' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '提示：如需按功能逐项验收，跑 .\tools\func_test_final.py' -ForegroundColor DarkGray
