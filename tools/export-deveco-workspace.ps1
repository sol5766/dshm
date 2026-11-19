[CmdletBinding()]
param(
    [string]$OutputRoot = '',
    [switch]$SkipZip
)

$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$marker = Join-Path $repoRoot 'AppScope\app.json5'
$template = Join-Path $repoRoot 'tools\build-profile.beta.template.json5'
$startHere = Join-Path $repoRoot 'tools\START-HERE.dev-eco.md'

if (-not (Test-Path -LiteralPath $marker)) {
    throw "Not a DSHM workspace: $repoRoot"
}
if (-not (Test-Path -LiteralPath $template)) {
    throw "Missing portable beta build profile template: $template"
}
if (-not (Test-Path -LiteralPath $startHere)) {
    throw "Missing migration start page: $startHere"
}

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $repoRoot 'dist\migration'
}
$OutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stage = Join-Path $OutputRoot "DSHM-deveco-workspace-$stamp"
$zip = Join-Path $OutputRoot "DSHM-deveco-workspace-$stamp.zip"
$copyLog = Join-Path $OutputRoot "robocopy-$stamp.log"

$excludeDirs = @(
    (Join-Path $repoRoot '.hvigor'),
    (Join-Path $repoRoot '.idea'),
    (Join-Path $repoRoot '.local-rules'),
    (Join-Path $repoRoot '.appanalyzer'),
    (Join-Path $repoRoot '.codegenie'),
    (Join-Path $repoRoot '.cache'),
    (Join-Path $repoRoot 'dist'),
    (Join-Path $repoRoot 'oh_modules'),
    (Join-Path $repoRoot 'tmp-gp'),
    (Join-Path $repoRoot 'entry\build'),
    (Join-Path $repoRoot 'entry\.cxx'),
    (Join-Path $repoRoot 'entry\oh_modules'),
    (Join-Path $repoRoot 'connection\build'),
    (Join-Path $repoRoot 'appstate\build'),
    (Join-Path $repoRoot 'dshcompat\build'),
    (Join-Path $repoRoot 'platform\build'),
    (Join-Path $repoRoot 'hostruntime\build'),
    (Join-Path $repoRoot 'hostkit\node_modules'),
    (Join-Path $repoRoot 'devrel\out')
)

$robocopyArgs = @(
    $repoRoot,
    $stage,
    '/E',
    '/COPY:DAT',
    '/DCOPY:DAT',
    '/R:1',
    '/W:1',
    '/XJ',
    '/NFL',
    '/NDL',
    '/NJH',
    '/NJS',
    '/NP',
    '/XD'
) + $excludeDirs

& robocopy @robocopyArgs 2>&1 | Tee-Object -FilePath $copyLog
$copyCode = $LASTEXITCODE
if ($copyCode -ge 8) {
    throw "robocopy failed with exit code $copyCode; inspect $copyLog"
}

# Never ship this machine's signing profile or temporary junk.
$removeFromStage = @(
    'build-profile.json5',
    'build-profile.local.json5',
    '$null',
    '.git\index.lock'
)
foreach ($relative in $removeFromStage) {
    $target = Join-Path $stage $relative
    if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Force
    }
}

Copy-Item -LiteralPath $template -Destination (Join-Path $stage 'build-profile.portable.json5')
Copy-Item -LiteralPath $startHere -Destination (Join-Path $stage 'START-HERE.md')

$gitHead = (& git -C $repoRoot rev-parse HEAD 2>$null | Select-Object -First 1)
$gitBranch = (& git -C $repoRoot rev-parse --abbrev-ref HEAD 2>$null | Select-Object -First 1)
$gitChanges = @(& git -C $repoRoot status --short 2>$null).Count

# 2026-11-06 复核：原三项全为旧路径/已移除依赖，已换成当前关键资产。
# 本脚本是 Windows 时代的历史迁移工具，不参与正式出包（见 AGENTS.md）。
$criticalFiles = @(
    'hostruntime\libs\arm64-v8a\libnode.so.137',
    'hostruntime\src\main\resources\resfile\dsh-core-0.2.2-rc.1+dshm.1-openharmony-arm64.zip',
    'AppScope\app.json5'
)

$manifest = New-Object System.Collections.Generic.List[string]
$manifest.Add('DSHM DevEco workspace export')
$manifest.Add("generated=$((Get-Date).ToString('o'))")
$manifest.Add("source=$repoRoot")
$manifest.Add("gitBranch=$gitBranch")
$manifest.Add("gitHead=$gitHead")
$manifest.Add("gitChangedEntries=$gitChanges")
$manifest.Add('excluded=dist,build,.cxx,.hvigor,.idea,oh_modules,tmp-gp,build-profile.json5,build-profile.local.json5')
$manifest.Add('portableProfile=build-profile.portable.json5')
$manifest.Add('')
$manifest.Add('criticalAssets:')
foreach ($relative in $criticalFiles) {
    $full = Join-Path $repoRoot $relative
    if (Test-Path -LiteralPath $full) {
        $item = Get-Item -LiteralPath $full
        $hash = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash
        $manifest.Add("$relative`t$($item.Length)`t$hash")
    }
    else {
        $manifest.Add("$relative`tMISSING")
    }
}
Set-Content -LiteralPath (Join-Path $stage 'MIGRATION-MANIFEST.txt') -Value $manifest -Encoding UTF8

$count = (Get-ChildItem -LiteralPath $stage -Recurse -File -Force | Measure-Object).Count
$bytes = (Get-ChildItem -LiteralPath $stage -Recurse -File -Force | Measure-Object -Property Length -Sum).Sum
Write-Output "STAGE=$stage"
Write-Output "FILES=$count"
Write-Output "SOURCE_BYTES=$bytes"

if (-not $SkipZip) {
    if (Test-Path -LiteralPath $zip) {
        $zipFull = [System.IO.Path]::GetFullPath($zip)
        $outputFull = [System.IO.Path]::GetFullPath($OutputRoot).TrimEnd('\') + '\'
        if (-not $zipFull.StartsWith($outputFull, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove ZIP outside output root: $zipFull"
        }
        Remove-Item -LiteralPath $zipFull -Force
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $stage,
        $zip,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $false
    )
    $zipItem = Get-Item -LiteralPath $zip
    $zipHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
    Set-Content -LiteralPath (Join-Path $OutputRoot "DSHM-deveco-workspace-$stamp.sha256") -Value "$zipHash  $($zipItem.Name)" -Encoding ASCII
    Write-Output "ZIP=$zip"
    Write-Output "ZIP_BYTES=$($zipItem.Length)"
    Write-Output "ZIP_SHA256=$zipHash"
}
