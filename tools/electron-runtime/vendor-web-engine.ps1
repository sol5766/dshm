# Vendor the runtime's web_engine module into the PROJECT (tracked source), so it can be
# compiled as part of our app. The native .so files are NOT copied here -- they stay in
# runtime/ (gitignored) and are copied into entry/libs at build-prep time by a later step.
#
# Why web_engine and not electron: the boot chain lives entirely in web_engine
# (WebAbilityStage -> initNativeContext -> JsBindingMethod -> WebWindow/runBrowser).
# The `electron` module is only thin subclasses of web_engine's classes.
#
# ASCII-ONLY FILE (Windows PowerShell 5.1 reads .ps1 as ANSI; non-ASCII comments get
# decoded as mojibake and can swallow the next line).
#
# Usage: & tools\electron-runtime\vendor-web-engine.ps1

param(
    [string]$Source = ''
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if ([string]::IsNullOrWhiteSpace($Source)) {
    $Source = Join-Path $repoRoot 'runtime\web_engine'
}
if (-not (Test-Path $Source)) {
    Write-Output ('ERROR: not found: ' + $Source + '  (run collect.ps1 -IncludeWebEngine first)')
    exit 1
}

$dst = Join-Path $repoRoot 'web_engine'
if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
New-Item -ItemType Directory -Force -Path $dst | Out-Null

$excludeDirs = @('build', 'oh_modules', 'node_modules', '.git', '.hvigor', '.idea', '.cxx', 'test')

$files = Get-ChildItem -Path $Source -Recurse -File | Where-Object {
    $rel = $_.FullName.Substring($Source.Length + 1)
    $parts = $rel -split '\\'
    $skip = $false
    foreach ($p in $parts) { if ($excludeDirs -contains $p) { $skip = $true } }
    -not $skip
}

foreach ($f in $files) {
    $rel = $f.FullName.Substring($Source.Length + 1)
    $target = Join-Path $dst $rel
    $targetDir = Split-Path -Parent $target
    if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Force -Path $targetDir | Out-Null }
    Copy-Item -Path $f.FullName -Destination $target -Force
}
Write-Output ('vendored : web_engine  files=' + $files.Count)

# --- patch deviceTypes: the pristine module is tablet/2in1 only, but our target device
# --- is a phone, and a HAP whose deviceTypes exclude the device cannot be installed.
$mj = Join-Path $dst 'src\main\module.json5'
if (Test-Path $mj) {
    $raw = Get-Content $mj -Raw
    if ($raw -match '"phone"') {
        Write-Output 'deviceTypes: phone already present'
    } else {
        # Use String.Replace (literal) rather than -replace: PowerShell parses
        # `-replace 'a', 'b' + 'c'` as extra arguments ("allows only two elements to follow
        # it, not 4") -- cost a round trip. A literal anchor is enough here.
        $anchor = '"deviceTypes": ['
        $nl = [Environment]::NewLine
        $patched = $raw.Replace($anchor, ($anchor + $nl + '      "phone",'))
        [System.IO.File]::WriteAllText($mj, $patched, (New-Object System.Text.UTF8Encoding($false)))
        Write-Output 'deviceTypes: added "phone"'
    }
} else {
    Write-Output ('ERROR: missing ' + $mj)
    exit 1
}

Write-Output ('dest     : ' + $dst)
