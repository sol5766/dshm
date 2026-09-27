# Verify the extracted Electron runtime native libraries:
#   * ELF class / machine / type
#   * presence of .codesign and .note.ohos.ident
#
# Why it matters: HarmonyOS blocks unsigned ELF at load/exec time (XPM). The evidence
# gathered for this project shows .note.ohos.ident alone is NOT proof of signing --
# one known unsigned artifact carried .note.ohos.ident but no .codesign, and that exact
# path appears in Huawei's XPM denial log. So we must look for .codesign.
#
# ASCII output only.

$readelf = 'D:\Huawei\DevEco Studio\sdk\default\openharmony\native\llvm\bin\llvm-readelf.exe'
if (-not (Test-Path $readelf)) {
    Write-Output ('ERROR: llvm-readelf not found at ' + $readelf)
    exit 1
}

$libsDir = 'D:\Develop\deepseek-harness-desktop-HarmonyOS\dist\electron\runtime\libelectron\ohos_hap\electron\libs\arm64-v8a'
$targets = @('libelectron.so', 'libadapter.so', 'libffmpeg.so')

Write-Output ('libs dir : ' + $libsDir)
Write-Output ''

foreach ($name in $targets) {
    $path = Join-Path $libsDir $name
    if (-not (Test-Path $path)) {
        Write-Output ('--- ' + $name + ' : MISSING')
        continue
    }
    Write-Output ('--- ' + $name + '  (' + [math]::Round((Get-Item $path).Length / 1MB, 1) + ' MB)')
    $header = & $readelf -h $path 2>&1
    $header | Select-String -Pattern 'Class|Machine|Type' | ForEach-Object { Write-Output ('    ' + $_.Line.Trim()) }
    $sections = & $readelf -S $path 2>&1
    $codesign = ($sections | Select-String -Pattern '\.codesign').Count
    $ohosIdent = ($sections | Select-String -Pattern '\.note\.ohos\.ident').Count
    Write-Output ('    .codesign        : ' + $(if ($codesign -gt 0) { 'PRESENT' } else { 'ABSENT' }))
    Write-Output ('    .note.ohos.ident : ' + $(if ($ohosIdent -gt 0) { 'present' } else { 'absent' }))
    Write-Output ''
}

Write-Output '=== libc++_shared.so from the OHOS SDK (needed alongside) ==='
$sdkLibcxx = 'D:\Huawei\DevEco Studio\sdk\default\openharmony\native\llvm\lib\aarch64-linux-ohos\libc++_shared.so'
if (Test-Path $sdkLibcxx) {
    Write-Output ('found    : ' + $sdkLibcxx + '  (' + [math]::Round((Get-Item $sdkLibcxx).Length / 1KB, 1) + ' KB)')
    $sections = & $readelf -S $sdkLibcxx 2>&1
    Write-Output ('    .codesign        : ' + $(if (($sections | Select-String -Pattern '\.codesign').Count -gt 0) { 'PRESENT' } else { 'ABSENT' }))
    $inHap = Join-Path $libsDir 'libc++_shared.so'
    Write-Output ('    copied into libs : ' + (Test-Path $inHap))
} else {
    Write-Output ('NOT FOUND: ' + $sdkLibcxx)
}
