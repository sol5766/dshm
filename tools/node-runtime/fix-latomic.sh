#!/usr/bin/env bash
# Remove `-latomic` from the TARGET link lines: the OHOS SDK ships no libatomic.
#
# Evidence:
#   ld.lld: error: unable to find library -latomic
#   grep -rn -- -latomic *.gyp  ->  node.gyp:507  'libraries': ['-latomic'],
#   find $SDK/native/sysroot -name '*atomic*'   ->  nothing (only headers elsewhere)
#   clang compiler-rt builtins DO exist: lib/clang/15.0.4/lib/aarch64-linux-ohos/libclang_rt.builtins.a
#
# Why dropping it is reasonable on aarch64 (and why it is safe to try):
#   aarch64 has native 1/2/4/8-byte atomics, so clang lowers __atomic_* inline.
#   libatomic is only needed for 16-byte ops. If anything in Node/V8 genuinely needs
#   those, the link will fail LOUDLY with undefined `__atomic_*_16` symbols -- it cannot
#   silently produce a broken library. So this is a reversible, evidence-driven change.
#
# Host tools are left alone: they link with the host g++ against the host libatomic,
# which is present, and they already linked fine.
#
# Also patches the generated makefiles, because make does NOT re-run gyp by itself
# (no GYPFILES rule) and a changed .gyp alone would have no effect.
#
# ASCII only. Idempotent.
set -uo pipefail

SRC="${1:-$HOME/ohos/node-v22.23.2}"
cd "$SRC" || exit 1

if [ ! -f node.gyp ]; then
  echo "ERROR: node.gyp not found under $SRC" >&2
  exit 1
fi

echo "=== node.gyp context (line 500-512) ==="
sed -n '500,512p' node.gyp

patched_gyp=0
if grep -q -- "-latomic" node.gyp; then
  # comment the whole libraries line out rather than leaving an empty element
  sed -i "s@'libraries': \['-latomic'\],@# DSHM: OHOS SDK has no libatomic; aarch64 lowers atomics inline.@g" node.gyp
  patched_gyp=1
fi

echo
echo "=== patching generated makefiles (target links only) ==="
patched_mk=0
skipped_host=0
while IFS= read -r mk; do
  [ -n "$mk" ] || continue
  grep -q -- "-latomic" "$mk" || continue
  # host-only tools keep the flag: the host libatomic exists and they already link
  if grep -q 'obj\.host' "$mk" && ! grep -q 'obj\.target' "$mk"; then
    skipped_host=$((skipped_host + 1))
    continue
  fi
  sed -i 's/ -latomic//g; s/-latomic //g' "$mk"
  patched_mk=$((patched_mk + 1))
  echo "patched: ${mk}"
done < <(find out -name '*.target.mk' 2>/dev/null)

echo "gyp_patched=$patched_gyp mk_patched=$patched_mk host_skipped=$skipped_host"
echo "next: bash tools/node-runtime/resume-make.sh"
