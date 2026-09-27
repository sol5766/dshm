#!/usr/bin/env bash
# Report what a NAPI/addon compile needs: which include dirs exist, and what the tree
# currently contains. ASCII only.
SRC="${1:-$HOME/ohos/node-v22.23.2}"
echo "nproc=$(nproc)"
echo "--- include dirs a NAPI module needs ---"
for d in src deps/v8/include deps/uv/include deps/uvwasi/include; do
  if [ -d "$SRC/$d" ]; then echo "OK   $d"; else echo "MISS $d"; fi
done
echo "--- key public headers ---"
for f in src/node.h src/node_api.h src/js_native_api.h src/node_api_types.h; do
  if [ -f "$SRC/$f" ]; then echo "OK   $f"; else echo "MISS $f"; fi
done
echo "--- install-time include/node (make install output; optional) ---"
ls "$SRC/include/node" 2>/dev/null | head -5 || echo "（还没有：make install 才会生成）"
echo "--- build outputs so far ---"
ls -la "$SRC/out/Release/" 2>/dev/null | grep -E 'libnode|^.*-rwx.*node$' || echo "（暂无 libnode.so / node）"
