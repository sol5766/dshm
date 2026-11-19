<#
  DevEco Studio 安装根的**唯一解析口**（PowerShell 侧；node 侧是同目录的 `deveco-home.mjs`）。
  用法：`. "$PSScriptRoot\lib\deveco-home.ps1"`，然后 Get-DevEcoRoot / Get-DevEcoPath。

  【为什么要有这个文件】装机（update-device.ps1）、发布签名（sign-release-hap.ps1）、
  端侧验收（device-acceptance.ps1 / device-code-fingerprint.ps1）里原先都写死了
  `C:\Program Files\Huawei\DevEco Studio`。2026-10-10 用户把 DevEco 从 C 盘卸载、
  改装到 `D:\Program Files\Huawei\DevEco Studio`，这四个脚本**当场全部失效**。
  再写死另一个盘符只是把同一颗雷埋到下一位用户脚下，故收成一个候选列表。

  【判据】候选根必须真的含 `tools\hvigor\bin\hvigorw.js` —— 只看目录存在会把
  卸载后残留的空目录 `C:\Program Files\Huawei` 误判成安装根（本次实测：存在但为空）。
  找不到返回 $null，调用方自己决定 exit 3（没跑成）还是抛错，**不返回假路径**。
#>

$script:DevEcoRootCache = $null
$script:DevEcoRootResolved = $false

function Get-DevEcoRootCandidates {
    $out = New-Object System.Collections.Generic.List[string]
    $add = { param($p) if ($p -and -not $out.Contains($p)) { $out.Add($p) } }
    if ($env:DEVECO_HOME) { & $add $env:DEVECO_HOME }
    foreach ($pf in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:PROGRAMFILES, ${env:PROGRAMFILES(X86)}, $env:ProgramW6432)) {
        if ($pf) { & $add (Join-Path $pf 'Huawei\DevEco Studio') }
    }
    # 盘符顺序：C 优先，A/B（软驱盘符）垫底
    $letters = @([char]67) + @(68..90 | ForEach-Object { [char]$_ }) + @([char]65, [char]66)
    foreach ($L in $letters) {
        $d = "${L}:"
        if (-not (Test-Path -LiteralPath "$d\")) { continue }
        & $add (Join-Path "$d\" 'Program Files\Huawei\DevEco Studio')
        & $add (Join-Path "$d\" 'Huawei\DevEco Studio')
    }
    return $out
}

function Get-DevEcoRoot {
    if ($script:DevEcoRootResolved) { return $script:DevEcoRootCache }
    $script:DevEcoRootResolved = $true
    foreach ($c in (Get-DevEcoRootCandidates)) {
        if (Test-Path -LiteralPath (Join-Path $c 'tools\hvigor\bin\hvigorw.js')) {
            $script:DevEcoRootCache = $c
            return $c
        }
    }
    return $null
}

function Get-DevEcoRootHint {
    return ((Get-DevEcoRootCandidates) -join ' / ')
}

# 安装根下的一个相对路径；不存在返回 $null。$Root 留空则实时解析安装根。
function Get-DevEcoPath {
    param([Parameter(Mandatory = $true)][string]$Relative, [string]$Root = '')
    if ($Root -eq '') { $Root = Get-DevEcoRoot }
    if (-not $Root) { return $null }
    $p = Join-Path $Root $Relative
    if (Test-Path -LiteralPath $p) { return $p }
    return $null
}

# 按顺序取第一个存在的候选路径；都不存在返回 $null（空串与 $null 自动跳过）。
function Resolve-FirstExisting {
    param([string[]]$Candidates)
    foreach ($c in $Candidates) {
        if (-not $c) { continue }
        if (Test-Path -LiteralPath $c) { return $c }
    }
    return $null
}