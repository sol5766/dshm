#!/bin/bash
# Build hello ELF for HarmonyOS PC
# Run this ON the build machine (which has the HarmonyOS SDK).
#
# The HAP build system already has clang in PATH during native builds.
# To build standalone:
#   bash hello/build-hello.sh
#
# Output: hello/hello-unsigned, hello/hello-signed
# Then copy them to: entry/src/main/resources/rawfile/
#   cp hello/hello-unsigned entry/src/main/resources/rawfile/
#   cp hello/hello-signed entry/src/main/resources/rawfile/
#   cp hello/hello-unsigned entry/src/main/resources/rawfile/imported-unsigned
#   cp hello/hello-signed entry/src/main/resources/rawfile/imported-signed
#
# For signing, use DevEco Studio or 'hdc shell codesign sign <path>' on the device.

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Detect the OHOS SDK root from clang
#   clang = .../.harmonybrew/Cellar/ohos-sdk/26.0.0.18_1/native/llvm/bin/clang
#   sysroot = .../.harmonybrew/Cellar/ohos-sdk/26.0.0.18_1/native/sysroot
CLANG="clang"
SYSROOT=""
if command -v "$CLANG" &>/dev/null; then
    CLANG_FULL="$(which "$CLANG")"
    # Walk up from bin/clang: bin → llvm → native → ohos-sdk-version
    NATIVE_DIR="$(dirname "$(dirname "$(dirname "$CLANG_FULL")")")"
    SYSROOT="$NATIVE_DIR/sysroot"
fi

if [ ! -d "$SYSROOT" ]; then
    # Fallback: find any sysroot under .harmonybrew
    SYSROOT="$(find /storage/Users/currentUser/.harmonybrew -type d -name sysroot -path '*/native/sysroot' 2>/dev/null | head -1)"
fi

if [ -z "$SYSROOT" ] || [ ! -d "$SYSROOT" ]; then
    echo "ERROR: Cannot find sysroot. Set SYSROOT env var."
    echo "Example: SYSROOT=/path/to/native/sysroot bash build-hello.sh"
    exit 1
fi

TARGET="aarch64-linux-ohos"
OUT="$SCRIPT_DIR"

echo "=== Building hello ELF for HarmonyOS PC ==="
echo "CLANG: $CLANG"
echo "SYSROOT: $SYSROOT"

# ── Build hello-unsigned ─────────────────────────────────────────
echo "--- Building hello-unsigned ---"
"$CLANG" --target="$TARGET" --sysroot="$SYSROOT" -static -nostartfiles \
    -Wl,-e,main \
    -D__MUSL__ -O0 -g "$SCRIPT_DIR/hello.c" -o "$OUT/hello-unsigned" -lc
echo "  -> $OUT/hello-unsigned"

# ── Build hello-signed ───────────────────────────────────────────
cp "$OUT/hello-unsigned" "$OUT/hello-signed"
if command -v binary-sign-tool-fix &>/dev/null; then
    binary-sign-tool-fix sign -selfSign 1 -inFile "$OUT/hello-signed" -outFile "$OUT/hello-signed.resigned" 2>/dev/null && \
        mv "$OUT/hello-signed.resigned" "$OUT/hello-signed" && \
        echo "  -> signed OK with binary-sign-tool-fix"
else
    echo "  -> binary-sign-tool-fix not found, hello-signed is unsigned copy"
fi

# ── Copy to HAP resources ────────────────────────────────────────
HAP_RAWFILE="$SCRIPT_DIR/../entry/src/main/resources/rawfile"
if [ -d "$HAP_RAWFILE" ]; then
    cp "$OUT/hello-unsigned" "$HAP_RAWFILE/"
    cp "$OUT/hello-signed" "$HAP_RAWFILE/"
    cp "$OUT/hello-unsigned" "$HAP_RAWFILE/imported-unsigned"
    cp "$OUT/hello-signed" "$HAP_RAWFILE/imported-signed"
    echo "  -> Copied to $HAP_RAWFILE"
fi

echo "=== Done ==="
ls -la "$OUT/hello-unsigned" "$OUT/hello-signed" 2>/dev/null
