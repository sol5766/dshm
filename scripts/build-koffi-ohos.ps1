# 构建 koffi 的 OpenHarmony arm64 N-API 原生模块（libkoffi.so）。
#
# 为什么需要这个脚本（2026-09-11）：
#   随包分发的 tools/prebuilt/koffi-3.2.1-ohos-arm64.node 是一个**没有构建配方**的黑盒产物，
#   它在链接时**漏掉了 koffi 自己的基础库** koffi/lib/native/base/base.cc。上游
#   koffi/src/koffi/CMakeLists.txt 的 KOFFI_SRC 明确包含 `../../lib/native/base/base.cc`，
#   该文件提供 K:: 命名空间的分配器/格式化器/日志/Unicode 工具。
#   后果：libkoffi.so 内有 18 个 K:: 符号为 UND，设备端 dlopen 重定位失败：
#     Error relocating .../libkoffi.so: _ZN1K16PrintAssertErrorEPKciS1_: symbol not found
#   进而 dsh 插件树加载失败（@deepseek-ai/dsh-subprocess-local），应用起不来。
#
#   注意：OHOS/musl 链接器对 dlopen 的对象**只在该对象自身的 DT_NEEDED 闭包内解析符号，
#   不查全局作用域**。因此「预先 RTLD_GLOBAL 加载一个提供这些符号的 .so」是无效的
#   （已实测），必须让缺失符号就编进 libkoffi.so 本身。
#
# 用法：
#   pwsh -File scripts/build-koffi-ohos.ps1
#   产物：entry/libs/arm64-v8a/libkoffi.so（hvigor 会把它打进 el1 bundle 库目录）
#
# 说明：包内不含 crc.inc 与 vendor/dragonbox，base.cc 里两者都是 __has_include 保护，
#   编译时自动走回退实现（仅影响 koffi 的浮点格式化，不影响 FFI 调用正确性）。

[CmdletBinding()]
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
    [string]$DevEcoSdk = 'C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony',
    [string]$DevecoNode = 'C:\Program Files\Huawei\DevEco Studio\tools\node\node.exe',
    [int]$TrampolineCount = 8192
)

$ErrorActionPreference = 'Stop'

$koffiDir = Join-Path $RepoRoot 'entry\src\main\resources\rawfile\dsh\node_modules\koffi'
$libDir = Join-Path $RepoRoot 'entry\libs\arm64-v8a'
$libNode = Join-Path $libDir 'libnode.so.137'
$outFile = Join-Path $libDir 'libkoffi.so'
$workDir = Join-Path $RepoRoot 'build\koffi-ohos'
$trampolineDir = Join-Path $workDir 'trampolines'

$clang = Join-Path $DevEcoSdk 'native\llvm\bin\clang++.exe'
$sysroot = Join-Path $DevEcoSdk 'native\sysroot'
$nodeInclude = Join-Path $RepoRoot 'entry\src\main\cpp\include\node'

foreach ($p in @($koffiDir, $libNode, $clang, $sysroot, $nodeInclude)) {
    if (-not (Test-Path $p)) { throw "缺少必需路径: $p" }
}

$koffiVersion = (Get-Content -Raw -Encoding utf8 (Join-Path $koffiDir 'package.json') | ConvertFrom-Json).version
Write-Host "[build-koffi-ohos] koffi $koffiVersion"

# 1) 生成汇编跳板（arm64_asm.S 内部 #include "gnu.inc"）
New-Item -ItemType Directory -Force -Path $trampolineDir | Out-Null
Write-Host "[build-koffi-ohos] 生成 trampolines -> $trampolineDir"
& $DevecoNode (Join-Path $koffiDir 'src\koffi\src\trampolines.cjs') $trampolineDir $TrampolineCount
if ($LASTEXITCODE -ne 0) { throw "trampolines.cjs 失败 ($LASTEXITCODE)" }

# 2) 编译并链接为 libkoffi.so
#    源文件列表对齐上游 CMakeLists.txt 的 KOFFI_SRC（arm64 分支）：关键是不能漏 base.cc。
$sources = @(
    'src/ffi.cc'
    'src/call.cc'
    'src/interp.cc'
    'src/parser.cc'
    'src/type.cc'
    'src/util.cc'
    'src/uv.cc'
    'src/win32.cc'
    'src/abi/arm64.cc'
    'src/abi/arm64_asm.S'
    '../../lib/native/base/base.cc'
)

$clangArgs = @(
    '--target=aarch64-linux-ohos'
    '-fPIC', '-shared', '-std=c++20', '-O2'
    '-fno-exceptions', '-fno-rtti', '-fwrapv'
    '-fno-delete-null-pointer-checks', '-fno-strict-aliasing'
    '-fdata-sections', '-ffunction-sections'
    '-D_FILE_OFFSET_BITS=64'
    '-DFELIX_TARGET=koffi'
    '-DNAPI_VERSION=NAPI_VERSION_EXPERIMENTAL'
    '-DNODE_ADDON_API_DISABLE_CPP_EXCEPTIONS'
    '-DNODE_ADDON_API_REQUIRE_BASIC_FINALIZERS'
    "-DVERSION=`"$koffiVersion`""
    "--sysroot=$sysroot"
    "-I$koffiDir"
    "-I$(Join-Path $koffiDir 'src\koffi')"
    "-I$(Join-Path $koffiDir 'vendor\node-addon-api')"
    "-I$(Join-Path $koffiDir 'vendor\node-api-headers\include')"
    "-I$nodeInclude"
    "-I$trampolineDir"
) + $sources + @(
    '-o', $outFile
    '-Wl,--gc-sections'
    $libNode
    '-lc++_shared'
)

Write-Host "[build-koffi-ohos] 编译 $($sources.Count) 个源文件 -> $outFile"
# 原生工具写 stderr（clang 的 #warning 等）在 $ErrorActionPreference='Stop' 下会被当成终止
# 错误并中断调用（本脚本首版就因此编译到一半被杀）。这里临时放宽，只以退出码判定成败。
Push-Location (Join-Path $koffiDir 'src\koffi')
$previousEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & $clang @clangArgs 2>&1 | ForEach-Object { Write-Host "    $_" }
    $clangExit = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousEap
    Pop-Location
}
if ($clangExit -ne 0) { throw "clang++ 失败 ($clangExit)" }

# 3) 自检：不允许残留任何 koffi 自身的 K:: 未定义符号
$readelf = Join-Path $DevEcoSdk 'native\llvm\bin\llvm-readelf.exe'
$undef = & $readelf --dyn-syms $outFile |
    Select-String 'UND' |
    ForEach-Object { ($_ -split '\s+')[-1] } |
    Where-Object { $_ -match '^_ZN1K|^_ZNK1K' } |
    Sort-Object -Unique

if ($undef) {
    Write-Host "[build-koffi-ohos] ❌ 仍有未定义的 K:: 符号：" -ForegroundColor Red
    $undef | ForEach-Object { Write-Host "    $_" }
    throw '仍然漏编了 K:: 基础库'
}

Write-Host "[build-koffi-ohos] ✅ 已生成 $outFile（无残留 K:: 未定义符号）" -ForegroundColor Green
Write-Host ("[build-koffi-ohos] 大小 {0:N0} B" -f (Get-Item $outFile).Length)
