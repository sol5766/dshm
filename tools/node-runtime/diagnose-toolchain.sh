#!/usr/bin/env bash
# Diagnose two things after a make run:
#   1) how the generated makefiles pick the target compiler (does it come from the env?)
#   2) whether target objects are actually AArch64 (i.e. not built by the host compiler)
# ASCII only.
SRC="${1:-$HOME/ohos/node-v22.23.2}"
cd "$SRC"

echo "=== how target compiler is chosen ==="
grep -n "CC.target" out/Makefile 2>/dev/null | head -5
echo "--- zlib.target.mk ---"
grep -n "CC.target" out/deps/zlib/zlib.target.mk 2>/dev/null | head -5
echo "--- node.target.mk ---"
grep -n "CC.target" out/node.target.mk 2>/dev/null | head -5

echo
echo "=== target object machine types ==="
READELF="${HOME}/ohos/sdk/native/llvm/bin/llvm-readelf"
if [ ! -x "$READELF" ]; then
  READELF="readelf"
fi

total=0
aarch64=0
other=0
otherlist=""
while IFS= read -r o; do
  total=$((total + 1))
  m="$("$READELF" -h "$o" 2>/dev/null | grep Machine: | head -1)"
  case "$m" in
    *AArch64*) aarch64=$((aarch64 + 1)) ;;
    *)
      other=$((other + 1))
      if [ "$other" -le 8 ]; then otherlist="${otherlist}${o#out/Release/obj.target/}
"; fi
      ;;
  esac
done < <(find out/Release/obj.target -name '*.o' 2>/dev/null)

echo "total=$total  aarch64=$aarch64  other=$other"
if [ -n "$otherlist" ]; then
  echo "--- first non-AArch64 target objects ---"
  printf '%s' "$otherlist"
fi
