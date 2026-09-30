#!/usr/bin/env bash
# Sync the Node headers a CMake build needs into the repo, so hvigor can compile
# libdshhost.so itself.
#
# WHY THIS EXISTS (D6 E30, measured)
#   Hand-placing a prebuilt .so into entry/libs/arm64-v8a/ does NOT create the
#   ArkTS<->native-module mapping: the runtime dlopens it and the constructor runs, but the
#   registered module is never instantiated (Init is never called). A module built by
#   hvigor's own CMake path binds fine -- proven in the same process, milliseconds apart:
#       DSHM-PROBE cmake 构建的原生模块可绑定，返回值=dshm-probe-ok   (CMake-built)
#       DSHM-RUNTIME runtimeVersion is undefined                      (hand-placed)
#   So dshhost must be built by CMake too. CMake runs on Windows and cannot read the WSL
#   source tree conveniently, hence this copy step.
#
# The copy is GITIGNORED (tens of MB of third-party headers: bytes out of git, procedure in
# git). Re-run this after changing NODE_VER.
#
# ASCII only.
set -euo pipefail

SRC="${1:-$HOME/ohos/node-v22.23.2}"
# DEST 默认按脚本位置推导（本脚本在 tools/node-runtime/ 下，仓库根 = 上两级）。
# 不要写死某一台机器的检出名 —— 换台机器/换个目录名就会把文件铺到别处。
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
DEST="${2:-$REPO/entry/src/main/cpp/node-headers}"

if [ ! -d "$SRC" ]; then
  echo "ERROR: no Node source at $SRC" >&2
  exit 1
fi
for d in src deps/v8/include deps/uv/include; do
  if [ ! -d "$SRC/$d" ]; then
    echo "ERROR: missing $SRC/$d" >&2
    exit 1
  fi
done

rm -rf "$DEST"
mkdir -p "$DEST"

# src: only headers -- the .cc files are useless here and much bigger
( cd "$SRC/src" && find . -name '*.h' -print0 | tar --null -cf - -T - ) | ( cd "$DEST" && mkdir -p src && cd src && tar -xf - )
cp -r "$SRC/deps/v8/include" "$DEST/v8include"
cp -r "$SRC/deps/uv/include" "$DEST/uvinclude"

echo "=== synced ==="
du -sh "$DEST" 2>/dev/null || true
for f in src/node.h src/node_api.h src/node_version.h src/js_native_api.h; do
  if [ -f "$DEST/$f" ]; then echo "OK   $f"; else echo "MISS $f"; fi
done
[ -f "$DEST/v8include/v8.h" ] && echo "OK   v8include/v8.h" || echo "MISS v8include/v8.h"
[ -f "$DEST/uvinclude/uv.h" ] && echo "OK   uvinclude/uv.h" || echo "MISS uvinclude/uv.h"
