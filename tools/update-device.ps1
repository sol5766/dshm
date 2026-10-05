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
$beforeHome = Shell "ls $filesDir/dsh/home 2>/dev/null | wc -l"
$beforeCores = Shell "ls $filesDir/dsh/cores 2>/dev/null"
Info "home 条目数：$beforeHome"
Info "核心树：$($beforeCores -replace "`n", ', ')"
if ($beforeHome -eq '0') {
    Write-Host '  NOTE 当前 home 为空（可能是全新设备，或数据已被清）' -ForegroundColor Yellow
}

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
Info "等待 $BootWaitSec 秒（首次可能需解包核心树）"
Start-Sleep -Seconds $BootWaitSec

# ── 7) 验证：数据是否保留 ────────────────────────────────────────────────
Step 7 '验证用户数据仍在（这是关键一步）'
$afterHome = Shell "ls $filesDir/dsh/home 2>/dev/null | wc -l"
$afterCores = Shell "ls $filesDir/dsh/cores 2>/dev/null"
Info "home 条目数：$beforeHome → $afterHome"
Info "核心树：$($afterCores -replace "`n", ', ')"

$dataOk = $true
$dataChecked = $false
if ([int]$beforeHome -eq 0) {
    # 【必须区分「没有数据」与「数据被保留」】
    # 第一版在这里直接判 OK，是**假通过**：home 本来就是空的，前后都是 0，
    # 检查发现不了丢失，却会打印 OK 让人以为验证过了。
    Write-Host '  SKIP home 基线为 0 —— 本次无法证明「数据被保留」（没有数据可验）' -ForegroundColor Yellow
    Write-Host '       如果这台设备本该有会话/插件，说明数据此前已丢失。' -ForegroundColor Yellow
} else {
    $dataChecked = $true
    if ([int]$afterHome -lt [int]$beforeHome) {
        Bad "home 条目减少（$beforeHome → $afterHome）—— 数据可能丢失"
        $dataOk = $false
    } else {
        Ok "home 条目保留（$beforeHome → $afterHome）"
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
Step 8 '验证端侧就绪（exec 探测逐项 + HTTP）'
$log = Shell "grep -E 'exec 探测：' $filesDir/dshm-host.log 2>/dev/null | tail -1"
Info $log
$probe = [regex]::Match($log, 'exec 探测：(.*)')
$execOk = $false
if (-not $probe.Success) {
    Bad '宿主日志里没有 exec 探测行'
} else {
    $items = @($probe.Groups[1].Value -split '[，,]' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    $bad = @($items | Where-Object { $_ -notmatch '=ok$' })
    if ($items.Count -gt 0 -and $bad.Count -eq 0) {
        Ok "exec 探测 $($items.Count)/$($items.Count) 全通"
        $execOk = $true
    } else {
        Bad "exec 探测未全通（共 $($items.Count) 项）：$($bad -join '，')"
    }
}

$http = Shell "grep -c 'IN-UPGRADE GET /api/remote.mux' $filesDir/dshm-host.log 2>/dev/null"
if ($http -match '^\d+$' -and [int]$http -gt 0) {
    Ok 'Host HTTP 已就绪（有 websocket 接入）'
} else {
    Bad '未见 HTTP 就绪迹象'
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
