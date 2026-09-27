#!/usr/bin/env bash
# Does hvigor SIGN the native .so it packs into the HAP?
#
# Why this matters now (before libnode.so even links):
#   D6 E14: HarmonyOS blocks native libraries without a valid signature; a .so downloaded
#   by hot-update is intercepted because it lacks one. Phase 2 ships libnode.so and
#   libdshhost.so *inside* the HAP, so the question "does the HAP build add .codesign?"
#   decides whether the packaging script needs its own signing step.
#   The source-tree .so under entry/libs/ have NO .codesign (measured earlier), yet the
#   HAP is signed and installs -- so either hvigor signs them during packaging, or the
#   device has not actually loaded them yet. This script answers which.
#
# Method: pull one native lib out of the built (signed) HAP and look for .codesign.
# ASCII only.
set -uo pipefail

REPO="/mnt/d/Develop/deepseek-harness-desktop-HarmonyOS"
# 优先已签名 HAP；没有就用未签名的那份。
# 【为什么未签名也能回答一部分问题】HAP 签名是最后一步（往 HAP 追加签名块），
# 而"打包时有没有动 .so"可以从"包里的 .so 与源树里的 .so 是否逐字节相同"看出来。
HAP=""
for cand in \
  "${REPO}/entry/build/default/outputs/default/entry-default-signed.hap" \
  "${REPO}/entry/build/default/outputs/default/entry-default-unsigned.hap"; do
  if [ -f "$cand" ]; then HAP="$cand"; break; fi
done
READELF="${HOME}/ohos/sdk/native/llvm/bin/llvm-readelf"
[ -x "$READELF" ] || READELF="readelf"

if [ -z "$HAP" ]; then
  echo "no HAP under entry/build/default/outputs/default/" >&2
  echo "（先跑一次 devecocli build）" >&2
  exit 1
fi

case "$HAP" in
  *unsigned*) echo "注意：只有未签名 HAP。它仍能回答「打包有没有改 .so」与「源树里的 .so 有无签名段」。" ;;
esac
echo "HAP: ${HAP#$REPO/} ($(stat -c%s "$HAP") bytes)"

OUT=/tmp/hapcheck
rm -rf "$OUT"
mkdir -p "$OUT"

python3 - "$HAP" "$OUT" <<'PY'
import sys, zipfile, os
hap, out = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(hap)
names = [n for n in z.namelist() if n.startswith('libs/') and (n.endswith('.so') or '.so.' in n)]
print("--- libs/*.so in HAP ---")
for n in sorted(names):
    print("   %-52s %10d" % (n, z.getinfo(n).file_size))
pick = None
total = sum(z.getinfo(n).file_size for n in names)
print("--- 解包全部 .so 做检查（共 %d bytes）---" % total)
for n in sorted(names):
    target = os.path.join(out, os.path.basename(n))
    with z.open(n) as src, open(target, 'wb') as dst:
        dst.write(src.read())
    print("   %-52s -> %d bytes" % (n, os.path.getsize(target)))
if not names:
    print("!! HAP 里没有任何 libs/*.so")
    sys.exit(2)
PY
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "extract failed rc=$rc" >&2
  exit 1
fi

echo
for SO in "$OUT"/*.so; do
  [ -f "$SO" ] || continue
  echo "=== $(basename "$SO") ($(stat -c%s "$SO") bytes) ==="
  "$READELF" -h "$SO" | grep -E 'Class|Machine|Type' | sed 's/^/   /' || true
  if "$READELF" -S "$SO" | grep -qE '\.codesign'; then
    echo "   .codesign : 有"
  else
    echo "   .codesign : 无"
  fi
  if "$READELF" -S "$SO" | grep -qE '\.note\.ohos\.ident'; then
    echo "   .note.ohos.ident : 有"
  else
    echo "   .note.ohos.ident : 无"
  fi
  SRC_SO="${REPO}/entry/libs/arm64-v8a/$(basename "$SO")"
  if [ -f "$SRC_SO" ]; then
    a=$(sha256sum "$SO" | cut -d' ' -f1)
    b=$(sha256sum "$SRC_SO" | cut -d' ' -f1)
    if [ "$a" = "$b" ]; then
      echo "   与源树：逐字节相同（打包未改动）"
    else
      echo "   与源树：**不同**（打包改动了它）"
    fi
  fi
done
