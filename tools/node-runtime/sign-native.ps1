# Sign a native .so with HarmonyOS ELF signing (binary-sign-tool).
#
# WHEN THIS IS NEEDED
#   E18 measured that our packaging pipeline never signs embedded .so: the HAP's
#   libs/arm64-v8a/*.so are byte-identical to entry/libs/ and carry no .codesign.
#   `display-sign` confirms it objectively:
#       permission is not found
#       code signature is not found
#       verify: No signature found
#   If the device turns out to require a code signature on bundled .so, this step must be
#   inserted AFTER collecting the .so and BEFORE HAP assembly -- changing bytes inside an
#   assembled HAP would break the HAP's own signature.
#
# WHY THE PASSWORDS ARE PARAMETERS AND NOT DISCOVERED
#   DevEco stores the keystore/key passwords ENCRYPTED in build-profile.json5 (we can see
#   the 0000001B... blobs) and decrypts them only when it invokes the tool itself. Those
#   blobs are NOT the passwords. So this script cannot read them from anywhere: it takes
#   them as parameters and FAILS LOUDLY when missing, instead of guessing.
#   Never write a password into this repository.
#
# ASCII only.
#
#   usage:
#     .\sign-native.ps1 -InFile <unsigned.so> [-OutFile <signed.so>]
#                       -KeystorePwd <pwd> -KeyPwd <pwd>
#                       [-KeystoreFile <p12>] [-AppCertFile <cer>] [-ProfileFile <p7b>]
#                       [-KeyAlias debugKey] [-SignAlg SHA256withECDSA] [-Force]
#     .\sign-native.ps1 -InFile <file.so> -DisplayOnly     # just report signing state

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InFile,
  [string]$OutFile = '',
  [string]$KeystoreFile = '',
  [string]$AppCertFile = '',
  [string]$ProfileFile = '',
  [string]$KeyAlias = 'debugKey',
  [string]$SignAlg = 'SHA256withECDSA',
  [string]$KeystorePwd = '',
  [string]$KeyPwd = '',
  [switch]$DisplayOnly,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$ToolCandidates = @(
  'D:\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\lib\binary-sign-tool.jar',
  'C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\lib\binary-sign-tool.jar'
)
$Tool = $ToolCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Tool) {
  Write-Error "binary-sign-tool.jar not found. Looked in: $($ToolCandidates -join '; ')"
}

if (-not (Test-Path $InFile)) { Write-Error "input not found: $InFile" }
$InFile = (Resolve-Path $InFile).Path

function Show-SignState([string]$path) {
  # NB: this function's pipeline output is captured by the caller, so progress lines must
  # go through Write-Host -- Write-Output would be swallowed into the return value.
  Write-Host "--- display-sign: $path"
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = @()
  try {
    $out = & java -jar $Tool display-sign -inFile $path 2>&1
  } catch {
    $out = @("display-sign threw: $_")
  }
  $ErrorActionPreference = $prev
  $out | Select-Object -Last 12 | ForEach-Object { Write-Host $_ }
  return ($out | Out-String)
}

Write-Output "tool: $Tool"
$state = Show-SignState $InFile

if ($DisplayOnly) { exit 0 }

if ($state -match 'code signature is not found') {
  Write-Output "==> input has NO code signature (must be signed)"
} elseif ($state -match 'sign success|verify success|signature is found') {
  if (-not $Force) {
    Write-Output "==> input already carries a signature; pass -Force to re-sign. Nothing to do."
    exit 0
  }
}

if ($KeystorePwd.Length -eq 0) { Write-Error "-KeystorePwd is required (DevEco's stored value is encrypted and cannot be reused)" }
if ($KeyPwd.Length -eq 0) { Write-Error "-KeyPwd is required" }

$cfg = Join-Path $env:USERPROFILE '.ohos\config'
if ($KeystoreFile.Length -eq 0) {
  $c = Get-ChildItem $cfg -File -ErrorAction SilentlyContinue |
       Where-Object { $_.Name -like 'default_*' -and $_.Extension -eq '.p12' } |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($c) { $KeystoreFile = $c.FullName }
}
if ($AppCertFile.Length -eq 0) {
  $c = Get-ChildItem $cfg -File -ErrorAction SilentlyContinue |
       Where-Object { $_.Name -like 'default_*' -and $_.Extension -eq '.cer' } |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($c) { $AppCertFile = $c.FullName }
}
if ($ProfileFile.Length -eq 0) {
  $c = Get-ChildItem $cfg -File -ErrorAction SilentlyContinue |
       Where-Object { $_.Name -like 'default_*' -and $_.Extension -eq '.p7b' } |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($c) { $ProfileFile = $c.FullName }
}
if ($KeystoreFile.Length -eq 0) { Write-Error "no keystore (.p12) found; pass -KeystoreFile" }
if ($AppCertFile.Length -eq 0) { Write-Error "no app cert (.cer) found; pass -AppCertFile" }

if ($OutFile.Length -eq 0) {
  $dir = Split-Path $InFile -Parent
  $name = [System.IO.Path]::GetFileNameWithoutExtension($InFile)
  $ext = [System.IO.Path]::GetExtension($InFile)
  $OutFile = Join-Path $dir ($name + '.signed' + $ext)
}

Write-Output "keystore : $KeystoreFile"
Write-Output "appCert  : $AppCertFile"
Write-Output "profile  : $ProfileFile"
Write-Output "outFile  : $OutFile"

& java -jar $Tool sign `
  -mode localSign `
  -keyAlias $KeyAlias `
  -keyPwd $KeyPwd `
  -appCertFile $AppCertFile `
  -profileFile $ProfileFile `
  -inFile $InFile `
  -signAlg $SignAlg `
  -keystoreFile $KeystoreFile `
  -keystorePwd $KeystorePwd `
  -outFile $OutFile
if ($LASTEXITCODE -ne 0) { Write-Error "sign failed (exit $LASTEXITCODE)" }

Write-Output "=== verify the output ==="
$after = Show-SignState $OutFile
if ($after -match 'code signature is not found') {
  Write-Error "output still reports 'code signature is not found' -- signing did not take effect"
}
Write-Output "OK: $OutFile"
