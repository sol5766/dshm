#!/usr/bin/env bash
# Turn OFF zlib's optional ARMv8 CRC32 SIMD path, which OHOS clang 15 cannot compile.
#
# Evidence (measured, not guessed):
#   src:   deps/zlib/crc32_simd.c
#   build: fatal error: error in backend: Cannot select: intrinsic %llvm.aarch64.crc32b
#   cause: zlib.gyp only adds `-march=armv8-a+aes+crc` when clang==0 (i.e. NOT for clang).
#          On the clang path it relies on the function attribute
#              __attribute__((target("arch=armv8-a+aes+crc")))
#          but OHOS clang 15 warns "unknown architecture ... 'target' attribute ignored"
#          and then cannot lower the __crc32b intrinsic at the baseline target.
#   tried: adding -march=armv8-a+crc fixes the crc32b error but the SAME function also uses
#          inline `pmull`/`pmull2`, which need +aes -> "error: instruction requires: aes".
#          So the only way to keep the path is to raise the whole object's CPU baseline,
#          which is a bad trade for an optional gzip-CRC optimisation on an embedded runtime.
#
# What this does: renames the macro token CRC32_ARMV8_CRC32 everywhere it is spelled
# (zlib.gyp + the generated *.target.mk), so it is never defined. crc32_simd.c's ARM block
# is guarded by `#if defined(CRC32_ARMV8_CRC32)` and therefore compiles to nothing, and
# zlib.c stops referencing armv8_crc32_little. Correctness is unchanged: zlib falls back to
# its portable C CRC32. Cost is gzip-CRC throughput only.
#
# NOTE: Node's generated Makefile has no GYPFILES rule, so editing the .gyp alone does NOT
# regenerate the makefiles. That is why the generated .mk files are patched too, and why the
# stale objects are removed (their old command line carried -DCRC32_ARMV8_CRC32, so a stale
# zlib.o would still reference armv8_crc32_little and fail at link time).
#
# ASCII only. Idempotent. Run from anywhere:  bash tools/node-runtime/fix-zlib-crc32.sh
set -euo pipefail

SRC="${1:-$HOME/ohos/node-v22.23.2}"
FROM='CRC32_ARMV8_CRC32'
TO='DSHM_CRC32_ARMV8_OFF'

if [ ! -d "$SRC" ]; then
  echo "ERROR: no source tree at $SRC (pass it as \$1)" >&2
  exit 1
fi

cd "$SRC"

if [ ! -f deps/zlib/zlib.gyp ]; then
  echo "ERROR: deps/zlib/zlib.gyp not found under $SRC" >&2
  exit 1
fi

patched=0
already=0

# 1) the gyp (source of truth for future reconfigures)
if grep -q "$FROM" deps/zlib/zlib.gyp; then
  sed -i "s/$FROM/$TO/g" deps/zlib/zlib.gyp
  patched=$((patched + 1))
else
  already=$((already + 1))
fi

# 2) the already-generated makefiles (make does not re-run gyp by itself).
#    NOTE: gyp writes them under out/<gyp-dir>/<target>.target.mk, i.e.
#    out/deps/zlib/zlib_arm_crc32.target.mk -- NOT next to the .gyp. The define also
#    propagates via direct_dependent_settings to out/deps/zlib/zlib.target.mk and onwards,
#    so patch every generated target makefile that spells the token.
while IFS= read -r mk; do
  [ -n "$mk" ] || continue
  if grep -q "$FROM" "$mk"; then
    sed -i "s/$FROM/$TO/g" "$mk"
    patched=$((patched + 1))
    echo "patched mk: ${mk#$SRC/}"
  fi
done < <(find out -name '*.target.mk' 2>/dev/null || true)

if [ "$patched" -eq 0 ] && [ "$already" -gt 0 ]; then
  echo "already patched (nothing to do)"
fi

# 3) drop the stale objects/archives so they rebuild without the define
removed=0
for d in out/Release/obj.target/zlib out/Release/obj.target/zlib_arm_crc32; do
  if [ -d "$d" ]; then
    rm -rf "$d"
    removed=$((removed + 1))
  fi
done
# archives named libzlib*.a (deps/zlib static libs)
while IFS= read -r a; do
  [ -n "$a" ] || continue
  rm -f "$a"
  removed=$((removed + 1))
done < <(find out -name 'libzlib*.a' 2>/dev/null || true)

echo "renamed $FROM -> $TO in $patched file(s); removed $removed stale path(s)"
echo "next: make -j8"
