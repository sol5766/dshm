# Place OUR Node-side host entry into the runtime's Electron app directory.
#
# Why a script: the runtime resolves its Node entry through Electron's stock mechanism
# (process.resourcesPath + appSearchPaths -> resources/resfile/resources/app/package.json
# -> "main"). Overwriting that directory is the sanctioned way to run our own Node code,
# and it must be reproducible (a fresh clone re-runs extract.ps1 + collect.ps1 + this).
#
# ASCII-ONLY FILE (Windows PowerShell 5.1 reads .ps1 as ANSI).
#
# Usage: & tools\electron-runtime\place-host-app.ps1

param(
    [string]$Dest = ''
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if ([string]::IsNullOrWhiteSpace($Dest)) {
    $Dest = Join-Path $repoRoot 'web_engine\src\main\resources\resfile\resources\app'
}

$srcMain = Join-Path $repoRoot 'hostcore\app\main.js'
if (-not (Test-Path $srcMain)) {
    Write-Output ('ERROR: missing ' + $srcMain)
    exit 1
}
if (-not (Test-Path $Dest)) {
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
}

Copy-Item $srcMain (Join-Path $Dest 'main.js') -Force

# package.json: no "type" field on purpose -> CommonJS. libelectron.so's bootstrap reads
# this manifest and loads "main"; our entry uses require(), so CJS is what we want.
$pkg = @'
{
  "name": "dshm-host",
  "version": "0.0.0",
  "description": "DSHM on-device DSH host (started by the Electron runtime, no BrowserWindow)",
  "main": "main.js"
}
'@
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $Dest 'package.json'), $pkg, $utf8NoBom)

Write-Output ('placed   : main.js + package.json -> ' + $Dest)
Get-ChildItem $Dest -File | Select-Object Name, Length | ForEach-Object {
    Write-Output ('           ' + $_.Name + '  ' + $_.Length + ' bytes')
}
