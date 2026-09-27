#!/usr/bin/env bash
# Build the NAPI bootstrap module (libdshhost.so) that starts libnode.so in-process.
#
#   bash tools/node-runtime/build-dshhost.sh --compile-only   # 只编译，不需要 libnode.so
#   bash tools/node-runtime/build-dshhost.sh                  # 编译 + 链接（需要 libnode.so）
#
# Why --compile-only exists: the C++ can be validated long before libnode.so finishes
# linking. A compile-only pass catches every signature/header mistake; only the final
# link needs the Node library. Doing that first means the moment libnode.so appears we
# are one command away from a module, instead of starting to debug C++ then.
#
# ASCII only.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
# shellcheck source=toolchain-env.sh
source "${HERE}/toolchain-env.sh" || exit 1

SRC="${NODE_SRC:-$HOME/ohos/node-v22.23.2}"
SRC_FILE="${REPO}/hostruntime/src/main/cpp/dshhost.cc"
OUT_DIR="${REPO}/entry/libs/arm64-v8a"
OUT_SO="${OUT_DIR}/libdshhost.so"
COMPILE_ONLY=0
[ "${1:-}" = "--compile-only" ] && COMPILE_ONLY=1

CXX_OHOS="${OHOS_CLANG_DIR}/aarch64-unknown-linux-ohos-clang++"

if [ ! -f "$SRC_FILE" ]; then
  echo "ERROR: source not found: $SRC_FILE" >&2
  exit 1
fi
for d in src deps/v8/include deps/uv/include; do
  if [ ! -d "$SRC/$d" ]; then
    echo "ERROR: missing include dir: $SRC/$d (need the Node source tree)" >&2
    exit 1
  fi
done

INCLUDES=(
  "-I$SRC/src"
  "-I$SRC/deps/v8/include"
  "-I$SRC/deps/uv/include"
)

# -fno-emulated-tls: OHOS ABI. -std=gnu++20: matches how we build Node itself.
# --sysroot/-D__MUSL__: musl-based OHOS target.
CFLAGS=(
  "--target=aarch64-linux-ohos"
  "--sysroot=${OHOS_SYSROOT}"
  "-D__MUSL__"
  "-fno-emulated-tls"
  "-std=gnu++20"
  "-fPIC"
  "-O2"
  "-Wall"
  # V8/Node 的头文件里有大量未使用参数，-Wextra 会把它们全刷出来，把真正的错误淹掉
  "-Wno-unused-parameter"
)

echo "[dshhost] compiling ${SRC_FILE#${REPO}/}"
if ! "$CXX_OHOS" "${CFLAGS[@]}" "${INCLUDES[@]}" -c "$SRC_FILE" -o /tmp/dshhost.o; then
  echo "[dshhost] ✗ 编译失败" >&2
  exit 1
fi
echo "[dshhost] ✓ 编译通过（$(stat -c%s /tmp/dshhost.o) 字节）"

if [ "$COMPILE_ONLY" = "1" ]; then
  echo "[dshhost] --compile-only：跳过链接（不需要 libnode.so）"
  exit 0
fi

LIBNODE="${SRC}/out/Release/libnode.so"
if [ ! -e "$LIBNODE" ] && [ ! -e "${LIBNODE}.1" ]; then
  echo "[dshhost] ✗ 找不到 libnode.so（${SRC}/out/Release/）——先跑完 build-node-ohos.sh" >&2
  echo "[dshhost]   提示：确认 'make' 已经产出 libnode.so* 再做这一步" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
echo "[dshhost] linking → ${OUT_SO#${REPO}/}"
if ! "$CXX_OHOS" "${CFLAGS[@]}" -shared -o "$OUT_SO" /tmp/dshhost.o \
      -L"${SRC}/out/Release" -lnode -lhilog_ndk.z -Wl,-soname,libdshhost.so; then
  echo "[dshhost] ✗ 链接失败" >&2
  exit 1
fi

READELF="${OHOS_CLANG_DIR}/llvm-readelf"
echo "[dshhost] ✓ ${OUT_SO}"
"$READELF" -h "$OUT_SO" | grep -E 'Class|Machine|Type' || true
echo "--- 需要的动态库（libnode.so 必须在内，且随 HAP 一起打包）---"
"$READELF" -d "$OUT_SO" | grep NEEDED || true
echo "--- 签名段（应出现 .codesign；没有就要补签，见 D6 §4.2 R4）---"
"$READELF" -S "$OUT_SO" | grep -E '\.codesign' || echo "    （未检出 .codesign）"
