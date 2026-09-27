#!/usr/bin/env bash
# Where does -latomic come from, and what does the OHOS toolchain actually provide?
# ASCII only.
SRC="${1:-$HOME/ohos/node-v22.23.2}"
SDK="$HOME/ohos/sdk"
cd "$SRC"

echo "=== 1) which generated makefiles ask for -latomic ==="
grep -rl -- "-latomic" out --include='*.target.mk' 2>/dev/null | head -20
echo "--- occurrences count ---"
grep -rc -- "-latomic" out/Makefile 2>/dev/null

echo
echo "=== 2) where in the gyp sources ==="
grep -rn -- "-latomic" *.gyp common.gypi deps/*/*.gyp 2>/dev/null | head -20

echo
echo "=== 3) libatomic in the sysroot / toolchain ==="
find "$SDK/native/sysroot" -name '*atomic*' 2>/dev/null | head -20
echo "--- llvm dir ---"
find "$SDK/native/llvm" -name '*atomic*' 2>/dev/null | head -20

echo
echo "=== 4) compiler-rt builtins available? ==="
find "$SDK/native/llvm" -name 'libclang_rt.builtins*' 2>/dev/null | head -20

echo
echo "=== 5) what lib dirs exist in the sysroot ==="
ls -d "$SDK"/native/sysroot/usr/lib/* 2>/dev/null | head -20
