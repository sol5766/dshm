# Extract the HarmonyOS Electron runtime artifacts (phase-1 runtime carrier).
#
# Input : the Huawei release zip placed in the repo root, e.g.
#         v37.2.3-20260825.1-release.zip  (single entry: libelectron_138.tar.gz)
# Output: dist/electron/  (gitignored) with the unpacked runtime tree
#
# Why a script: this artifact cannot be downloaded by CI (Huawei DevCloud,
# account-gated), so the extraction steps must be reproducible by hand.
#
# === TWO HARD-WON RULES FOR .ps1 FILES IN THIS REPO (do not "fix" them) ===
# 1. THIS FILE MUST STAY PURE ASCII.
#    Windows PowerShell 5.1 reads .ps1 as ANSI (GBK on a zh-CN host). A UTF-8
#    Chinese comment is decoded as mojibake, and a trailing byte can swallow the
#    next line -- observed here as "Test-Path : ... 'Path' because it is null"
#    right after the assignment line was eaten. Use English comments.
# 2. USE THE WINDOWS BSDTAR, NOT THE tar ON PATH.
#    PATH usually resolves to Git's GNU tar, which treats "D:\..." as a remote
#    host: "tar (child): Cannot connect to D: resolve failed".
#    C:\Windows\System32\tar.exe handles drive letters natively.
#
# Usage:
#   & tools\electron-runtime\extract.ps1
#   & tools\electron-runtime\extract.ps1 -ZipPath 'D:\path\to\v37.2.3-...-release.zip'

param(
    [string]$ZipPath = ''
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

if ([string]::IsNullOrWhiteSpace($ZipPath)) {
    $candidate = Get-ChildItem -Path $repoRoot -Filter 'v*-release.zip' -File |
        Sort-Object Length -Descending | Select-Object -First 1
    if ($null -eq $candidate) {
        Write-Output 'ERROR: no v*-release.zip found in repo root; pass -ZipPath explicitly'
        exit 1
    }
    $ZipPath = $candidate.FullName
}

Write-Output ('zip      : ' + $ZipPath)
Write-Output ('size MB  : ' + [math]::Round((Get-Item $ZipPath).Length / 1MB, 1))

$outDir = Join-Path $repoRoot 'dist\electron'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# --- 1. unpack the release zip (single entry: libelectron_<abi>.tar.gz) ---
$tgz = Get-ChildItem -Path $outDir -Filter 'libelectron*.tar.gz' -File -ErrorAction SilentlyContinue |
    Sort-Object Length -Descending | Select-Object -First 1
if ($null -ne $tgz) {
    Write-Output ('unzip    : skipped, already have ' + $tgz.Name)
} else {
    Write-Output ('unzip    : -> ' + $outDir)
    Expand-Archive -Path $ZipPath -DestinationPath $outDir -Force
    $tgz = Get-ChildItem -Path $outDir -Filter 'libelectron*.tar.gz' -File |
        Sort-Object Length -Descending | Select-Object -First 1
}
if ($null -eq $tgz) {
    Write-Output 'ERROR: libelectron*.tar.gz not found after unzip'
    exit 1
}
Write-Output ('tgz      : ' + $tgz.Name + '  (' + [math]::Round($tgz.Length / 1MB, 1) + ' MB)')

# --- 2. unpack the tar.gz with the Windows bsdtar ---
$tarExe = 'C:\Windows\System32\tar.exe'
if (-not (Test-Path $tarExe)) {
    $tarExe = (Get-Command tar -ErrorAction SilentlyContinue).Source
}
if ([string]::IsNullOrWhiteSpace($tarExe)) {
    Write-Output 'ERROR: no tar executable found'
    exit 1
}
Write-Output ('tar      : ' + $tarExe)

$srcDir = Join-Path $outDir 'runtime'
New-Item -ItemType Directory -Force -Path $srcDir | Out-Null
Write-Output ('untar    : -> ' + $srcDir)

# Selective extraction via a member list.
# Why: the archive has 296 members including two PDFs under ohos_hap/docs whose names
# contain Chinese characters; bsdtar aborts the WHOLE extraction on them
# ("Invalid empty pathname"). bsdtar's --exclude did not help, so we build an explicit
# member list instead -- deterministic, and it also lets us skip lib.unstripped/ (large).
$members = & $tarExe -tzf $tgz.FullName
if ($LASTEXITCODE -ne 0) {
    Write-Output ('ERROR: cannot list archive, exit ' + $LASTEXITCODE)
    exit 1
}
Write-Output ('members  : ' + $members.Count)

$wanted = New-Object System.Collections.Generic.List[string]
$skippedNonAscii = 0
$skippedDir = 0
foreach ($m in $members) {
    if ($m -like 'libelectron/ohos_hap/docs/*') { $skippedDir++; continue }
    if ($m -like 'libelectron/lib.unstripped/*') { $skippedDir++; continue }
    # any remaining non-ASCII path is skipped and reported (they are docs by nature)
    $isAscii = $true
    foreach ($ch in $m.ToCharArray()) { if ([int]$ch -gt 127) { $isAscii = $false; break } }
    if (-not $isAscii) { $skippedNonAscii++; continue }
    $wanted.Add($m)
}
Write-Output ('wanted   : ' + $wanted.Count + '  (skipped docs/unstripped=' + $skippedDir + ', non-ascii=' + $skippedNonAscii + ')')

$listFile = Join-Path $outDir 'members.txt'
# UTF-8 WITHOUT BOM, explicitly. PowerShell 5.1's `Set-Content -Encoding UTF8` writes a
# BOM, and bsdtar then reads the first member as "\ufefflibelectron" ->
# "tar.exe: libelectron: Not found in archive". Cost us a full round trip.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($listFile, $wanted, $utf8NoBom)

& $tarExe -xzf $tgz.FullName -C $srcDir -T $listFile
if ($LASTEXITCODE -ne 0) {
    Write-Output ('ERROR: tar failed with exit ' + $LASTEXITCODE)
    exit 1
}

# --- 3. report what we got, emphasising the .so files we actually need ---
Write-Output ''
Write-Output '=== native libraries (.so), largest first ==='
Get-ChildItem -Path $srcDir -Recurse -File -Filter '*.so' |
    Sort-Object Length -Descending |
    Select-Object -First 25 |
    ForEach-Object { '{0,12}  {1}' -f $_.Length, $_.FullName.Substring($srcDir.Length + 1) }

Write-Output ''
Write-Output '=== directories (depth <= 3) ==='
Get-ChildItem -Path $srcDir -Recurse -Depth 3 -Directory |
    Select-Object -First 40 |
    ForEach-Object { $_.FullName.Substring($srcDir.Length + 1) }

Write-Output ''
Write-Output 'done.'
