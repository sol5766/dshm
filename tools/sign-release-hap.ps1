# 历史脚本（2026-11-06 标注）：走 hap-sign-tool jar，本机无 java；正式出包改走 tools/build-agc.mjs（hvigor release 签名）。示例文件名为 1.1.0 轮次，仅示格式。
﻿<#
.SYNOPSIS
  用 AGC 发布证书 + 发布 profile 给**未签名** HAP 做发布签名（上传 AGC / 上架审核用的包）。

.DESCRIPTION
  【为什么不能让 hvigor 干】build-profile.json5 的 signingConfigs 里口令必须是 DevEco 的**加密形态**，
  明文会被 hvigor 直接拒：`00303116 Configuration Error The length of the storePassword or keyPassword
  field in the signature configuration is less than 32`。本脚本改走 DevEco 自己用的那个签名器
  (`sdk/default/openharmony/toolchains/lib/hap-sign-tool.jar`)，口令用明文从参数/备注文件读，
  因此**不需要在 DevEco GUI 里 Apply**。

  【判据（脚本自己判，不靠肉眼）】签完用 `verify-app` 复验，并从它导出的 profile 里读
  `"type"` / `"allowed-acls"`：`type` 必须是 `release`，否则脚本判红退出（rc=1）。
  实测（2026-10-10）：发布 profile 的 `allowed-acls` 只有 2 条
  （`ALLOW_EXTERNAL_NATIVE_CODE` + `FILE_ACCESS_PERSIST`），比调试 profile 的 5 条少 3 条 —— 见 docs/141。

.PARAMETER InFile
  必须是**未签名**产物（`entry-default-unsigned.hap`）。对已签名包再签会得到坏包，脚本会拒。

  【也吃 `.app`（app pack）—— AGC 上传要的就是它】实测（2026-10-10，`hap-sign-tool verify-app`）：
  `.app` 里那个内层 `entry-default.hap` 是**未签名**的（`No Hap Signing Block before ZIP Central Directory`），
  **只签容器**。签法与本脚本对 `.hap` 完全一致（`-inFile <x.app>`，不带 `-inForm`）——
  这正是 hvigor `SignApp` 的做法（`HapSignCommandBuilder`，见其 `initCommandParams`）。
  产出 `build/outputs/default/<工程名>-default-unsigned.app` 由 `hvigorw assembleApp` 生成。

.PARAMETER Pwd
  密钥库口令 = 密钥口令（本套物料两者相同）。留空则从 -NoteFile 里读 `passwd:` 那一行。

.EXAMPLE
  .\tools\sign-release-hap.ps1 -OutFile dist\release-test\DSHM-1.1.0-...+dshm.31-arm64-release-signed.hap
#>
param(
    [string]$InFile  = 'entry\build\default\outputs\default\entry-default-unsigned.hap',
    [string]$OutFile = '',
    [string]$Keystore = 'D:\desktop\release\dshm.p12',
    [string]$Cert     = 'D:\desktop\release\dshm.cer',
    [string]$Profile  = 'D:\desktop\release\dshmRelease.p7b',
    # 【2026-10-14 订正默认值】`D:\desktop\release\dshm.p12` 里唯一的 PrivateKeyEntry 别名是
    #   **`ohosdshm`**（`keytool -list` 实读），旧默认值 `ohosdsh` **不存在** ⇒ 不给 -KeyAlias
    #   直接跑必然 `11014001 / sign-app failed`（docs/153 §… 记过现场）。
    #   把它改成真别名，免得每次都得记得显式传参。
    [string]$KeyAlias = 'ohosdshm',
    [string]$Pwd      = '',
    [string]$NoteFile = 'D:\desktop\release\新建文本文档.txt',
    [string]$SignAlg  = 'SHA256withECDSA'
)
$ErrorActionPreference = 'Stop'
# 【2026-10-18】pwsh 7 下 java 的 stderr（如 verify-app 的 `WARN - Missing parameter: outproof`）
# 会被当成 terminating error，让脚本在**已经签好、已经验过**之后假失败。判据只能是 $LASTEXITCODE。
$PSNativeCommandUseErrorActionPreference = $false
$root = Split-Path -Parent $PSScriptRoot
# 【为什么不写死】原先写死 `C:\Program Files\Huawei\DevEco Studio\...`；2026-10-10 用户把 DevEco
# 从 C 盘卸载、改装到 D 盘，本脚本当场失效（找不到 java / hap-sign-tool.jar ⇒ 发布签不出包）。
# 解析口收在 tools/lib/deveco-home.ps1：候选列表 + **必须真的含 tools\hvigor\bin\hvigorw.js**
# 才算命中（只看目录存在会把卸载残留的空目录当安装根）。可用环境变量 DEVECO_HOME 覆盖。
. (Join-Path $PSScriptRoot 'lib\deveco-home.ps1')
$javaCands = @()
if ($env:JAVA_HOME) { $javaCands += (Join-Path $env:JAVA_HOME 'bin\java.exe') }
$javaCands += (Get-DevEcoPath 'jbr\bin\java.exe')
$java = Resolve-FirstExisting $javaCands
$jar = Get-DevEcoPath 'sdk\default\openharmony\toolchains\lib\hap-sign-tool.jar'

function Info($m) { Write-Host "  $m" }
function Bad($m)  { Write-Host "  FAIL $m" -ForegroundColor Red; exit 1 }

foreach ($pair in @(@('jbr\bin\java.exe', $java), @('sdk\default\openharmony\toolchains\lib\hap-sign-tool.jar', $jar))) {
    if (-not $pair[1]) {
        Bad "找不到 $($pair[0])（DevEco 工具）。`n  DevEco 安装根候选：$(Get-DevEcoRootHint)`n  可用环境变量 DEVECO_HOME 指定安装根"
    }
}
foreach ($p in @($Keystore, $Cert, $Profile)) { if (-not (Test-Path -LiteralPath $p)) { Bad "缺签名物料：$p" } }
$inFull = if ([System.IO.Path]::IsPathRooted($InFile)) { $InFile } else { Join-Path $root $InFile }
if (-not (Test-Path -LiteralPath $inFull)) { Bad "缺输入：$inFull" }
if ((Split-Path -Leaf $inFull) -notmatch 'unsigned') { Bad "输入看着不是未签名产物（名字里没有 unsigned）：$inFull`n  hvigor 失败在 SignHap 时留下的 entry-default-unsigned.hap 才是本脚本的输入" }
if ($OutFile -eq '') {
    # 跟着输入的扩展名走：.hap → entry-default-release-signed.hap；.app → ….app
    $OutFile = Join-Path (Split-Path -Parent $inFull) ("entry-default-release-signed" + [System.IO.Path]::GetExtension($inFull))
}
$outFull = if ([System.IO.Path]::IsPathRooted($OutFile)) { $OutFile } else { Join-Path $root $OutFile }

if ($Pwd -eq '') {
    if (-not (Test-Path -LiteralPath $NoteFile)) { Bad "没给 -Pwd，也读不到备注文件：$NoteFile" }
    $line = (Get-Content -LiteralPath $NoteFile | Where-Object { $_ -match '^\s*passwd\s*:' } | Select-Object -First 1)
    if (-not $line) { Bad "备注文件里没有 passwd: 那一行（$NoteFile）" }
    $Pwd = ($line -replace '^\s*passwd\s*:', '').Trim()
    if ($Pwd -eq '') { Bad "备注文件里的 passwd: 是空的" }
}

# ── [0] 摘掉「发布 profile 没授权」的 ACL 声明（**必须在签名之前**）──────────
# 【为什么这步是必要的，而不是可选的】2026-10-10 起源码**全量声明** 11 条（侧载/调试档要完整功能，
# 见 docs/144 的实测：撤掉任何一条受限权限，PC 档就瘫一块），而发布 profile 只授权 2 条 ACL
# （ALLOW_EXTERNAL_NATIVE_CODE + FILE_ACCESS_PERSIST）。把 11 条的产物直接签出去 ⇒ 那 3 条
# 「声明了但没授权」会被设备侧按 PERMISSION_ACL_RULE 拒装（docs/142 §1–§2），AGC 上传/审核同样会卡。
# 工具是**对着 profile 比**的（不是见 ACL 就摘），声明与 profile 齐了它会摘 0 条 —— 幂等。
#   · `.hap` 输入：自动摘到临时件，签名用摘后件（**原文件不动**，签完删临时件）。
#   · `.app` 输入：本脚本**不做容器内改写**（要重打包 .app 里的内层 hap），改为**判红并要求** ——
#     先对同一轮构建出的 `entry-default-unsigned.hap` 跑摘除，再拿摘后件组包。
$stageDir = Join-Path ([System.IO.Path]::GetTempPath()) ("dshm-sign-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
$nodeExe  = Get-DevEcoPath 'tools\node\node.exe'
$stripJs  = Join-Path $PSScriptRoot 'strip-ungranted-acl-perms.mjs'
$permDefs = Get-DevEcoPath 'sdk\default\openharmony\toolchains\lib\PermissionDefinitions.json'
if (-not $nodeExe)  { Bad "找不到 DevEco 的 node（tools\node\node.exe）。DevEco 根候选：$(Get-DevEcoRootHint)" }
if (-not $permDefs) { Bad '找不到 SDK 权限表 PermissionDefinitions.json（摘除判据要用它读 availableLevel）' }
if (-not (Test-Path -LiteralPath $stripJs)) { Bad "缺摘除工具：$stripJs" }

Write-Host '[0] 摘掉发布 profile 未授权的 ACL 声明（须在签名之前）'
if ([System.IO.Path]::GetExtension($inFull) -ieq '.hap') {
    $stripped = Join-Path $stageDir 'stripped.hap'
    & $nodeExe $stripJs --in $inFull --profile $Profile --definitions $permDefs --out $stripped
    if ($LASTEXITCODE -ne 0) { Bad "摘除工具 rc=$LASTEXITCODE（in=$inFull）" }
    if (-not (Test-Path -LiteralPath $stripped)) { Bad "摘除工具没产出文件：$stripped" }
    $inFull = $stripped
    Info "签名输入改用摘后件 = $inFull"
} else {
    # `.app`：要么内层声明与 profile 对齐，要么判红 —— **绝不静默签出一个装不上的包**。
    $probe = Join-Path $stageDir 'inner.hap'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($inFull)
    try {
        $inner = $zip.Entries | Where-Object { $_.FullName -like '*.hap' } | Select-Object -First 1
        if (-not $inner) { Bad "`.app 里找不到内层 .hap：$inFull" }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($inner, $probe, $true)
    } finally { $zip.Dispose() }
    $dry = (& $nodeExe $stripJs --in $probe --profile $Profile --definitions $permDefs --dry-run 2>&1 | Out-String)
    Write-Host $dry
    $n = if ($dry -match '摘掉\s*(\d+)\s*条') { [int]$Matches[1] } else { -1 }
    if ($n -lt 0) { Bad '读不出摘除工具的读数（它是判据，读不到就不能签）' }
    if ($n -gt 0) {
        Bad "`.app 的内层 hap 声明了 $n 条发布 profile 未授权的 ACL 权限 ⇒ 会被拒装/上传卡。`n  先跑：node tools\strip-ungranted-acl-perms.mjs --in <entry-default-unsigned.hap> --profile $Profile --out <x.hap>`n  再用摘后件组包/签名（或用 `.hap` 输入走本脚本自动摘除）。"
    }
    Info '.app 内层声明与发布 profile 对齐 ⇒ 可直接签'
}

Write-Host '[1] 发布签名（hap-sign-tool sign-app / localSign）'
Info "in       = $inFull"
Info "keystore = $Keystore  (alias=$KeyAlias)"
Info "cert     = $Cert"
Info "profile  = $Profile"
Info "out      = $outFull"
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $java -jar $jar sign-app -mode localSign -keyAlias $KeyAlias -signAlg $SignAlg `
    -appCertFile $Cert -profileFile $Profile -inFile $inFull -outFile $outFull `
    -keystoreFile $Keystore -keystorePwd $Pwd -keyPwd $Pwd 2>&1 | Out-Null
$rcSign = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($rcSign -ne 0) { Bad "sign-app rc=$rcSign" }
if (-not (Test-Path -LiteralPath $outFull)) { Bad '没有产出文件' }

Write-Host '[2] 复验（verify-app）+ 读内嵌 profile 的 type / allowed-acls'
$tmpDir = [System.IO.Path]::GetTempPath()
# 【为什么不用 GetTempFileName】verify-app 按**扩展名**判类型：`.tmp` 会被拒（11012005 Not support file）
$tmpCer = Join-Path $tmpDir ("dshm-vc-" + [guid]::NewGuid().ToString("N") + ".cer")
$tmpPro = Join-Path $tmpDir ("dshm-vp-" + [guid]::NewGuid().ToString("N") + ".p7b")
$ErrorActionPreference = 'Continue'
& $java -jar $jar verify-app -inFile $outFull -outCertChain $tmpCer -outProfile $tmpPro 2>&1 | Out-Null
$rcVerify = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($rcVerify -ne 0) { Bad "verify-app rc=$rcVerify" }
$txt = [System.IO.File]::ReadAllText($tmpPro)
Remove-Item -LiteralPath $tmpCer, $tmpPro -Force -ErrorAction SilentlyContinue
$type = if ($txt -match '"type"\s*:\s*"(\w+)"') { $Matches[1] } else { '?' }
$acls = if ($txt -match '"allowed-acls"\s*:\s*\[(.*?)\]') { ($Matches[1] -replace '"', '' -replace 'ohos\.permission\.', '') } else { '?' }
$uuid = if ($txt -match '"uuid"\s*:\s*"([0-9a-f-]+)"') { $Matches[1] } else { '?' }
Info "profile.type = $type"
Info "allowed-acls = $acls"
Info "uuid         = $uuid"
if ($type -ne 'release') { Bad "内嵌 profile 不是发布档（type=$type）—— 别拿它上传" }

$h = (Get-FileHash -LiteralPath $outFull -Algorithm SHA256).Hash.ToLower()
Write-Host '[3] 产物'
Info "大小   = $((Get-Item -LiteralPath $outFull).Length) B"
Info "sha256 = $h"

# 清掉 [0] 的临时件（只删本次自己建的临时目录，不碰任何输入/产物）
Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '  ⚠ 发布签名与调试签名**互斥**：设备上若已装调试签名的同包名应用，' -ForegroundColor Yellow
Write-Host '    本包不能 install -r（会签名不一致），只能卸载 —— 而卸载会清掉 el2 用户数据（会话/插件/工作区）。' -ForegroundColor Yellow
Write-Host '    ⇒ 要本地装机验证，请在**测试机**上做；主力机继续用调试签名的侧载包。' -ForegroundColor Yellow
Write-Host '  OK 发布签名完成。'
