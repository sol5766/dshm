# Copy the Electron-on-HarmonyOS runtime modules from dist/ into the project (runtime/).
#
# Why a separate step: the runtime is a Huawei-provided artifact (account-gated, no public
# URL) that must not live in version control -- libelectron.so alone is 172.7 MB. We keep
# the *procedure* in git and the *bytes* out of git.
#
# ASCII-ONLY FILE. Windows PowerShell 5.1 reads .ps1 as ANSI; UTF-8 non-ASCII comments get
# decoded as mojibake and can swallow the following line. See tools/electron-runtime/README.md.
#
# Usage:
#   & tools\electron-runtime\collect.ps1                      # electron module only (Node-only usage)
#   & tools\electron-runtime\collect.ps1 -IncludeWebEngine    # also copy web_engine (renderer support)

param(
    [switch]$IncludeWebEngine,
    [string]$Source = ''
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if ([string]::IsNullOrWhiteSpace($Source)) {
    $Source = Join-Path $repoRoot 'dist\electron\runtime\libelectron\ohos_hap'
}

if (-not (Test-Path $Source)) {
    Write-Output ('ERROR: runtime source not found: ' + $Source)
    Write-Output '       run tools\electron-runtime\extract.ps1 first'
    exit 1
}

$dest = Join-Path $repoRoot 'runtime'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

# Directories that are build outputs / VCS noise and must not be copied.
$excludeDirs = @('build', 'oh_modules', 'node_modules', '.git', '.hvigor', '.idea', '.cxx')

$modules = @('electron')
if ($IncludeWebEngine) { $modules += 'web_engine' }

foreach ($m in $modules) {
    $src = Join-Path $Source $m
    if (-not (Test-Path $src)) {
        Write-Output ('ERROR: module missing: ' + $src)
        exit 1
    }
    $dst = Join-Path $dest $m
    if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
    New-Item -ItemType Directory -Force -Path $dst | Out-Null

    $files = Get-ChildItem -Path $src -Recurse -File | Where-Object {
        $rel = $_.FullName.Substring($src.Length + 1)
        $top = ($rel -split '\\')[0]
        $excludeDirs -notcontains $top
    }
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($src.Length + 1)
        $target = Join-Path $dst $rel
        $targetDir = Split-Path -Parent $target
        if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Force -Path $targetDir | Out-Null }
        Copy-Item -Path $f.FullName -Destination $target -Force
    }
    $bytes = ($files | Measure-Object Length -Sum).Sum
    Write-Output ('copied   : ' + $m + '  files=' + $files.Count + '  MB=' + [math]::Round($bytes / 1MB, 1))
}

Write-Output ''
Write-Output ('dest     : ' + $dest)
Write-Output 'note     : runtime/ is gitignored on purpose (see .gitignore)'
