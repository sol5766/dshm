#!/usr/bin/env bash
# Make c-ares use its OpenHarmony config instead of the glibc/Linux one.
#
# SYMPTOM (measured)
#   out/Release/libnode.so.127 links, but linking any executable against it fails:
#       ld.lld: error: undefined reference due to --no-allow-shlib-undefined: getservbyport_r
#   getservbyport_r is a GLIBC-ONLY symbol; musl/OHOS does not provide it. A shared library
#   is allowed to carry undefined symbols, so libnode.so linked happily -- and would then
#   FAIL TO LOAD on device. The test binary's --no-allow-shlib-undefined is what turned a
#   device-only failure into a visible local error.
#
# ROOT CAUSE (verified, not guessed)
#   deps/cares/cares.gyp picks its ares_config.h per OS. It is the ONLY place in the whole
#   tree with a STRICT `OS=="openharmony"` branch (everywhere else openharmony appears in a
#   list with linux, e.g. `OS=="linux" or OS=="openharmony"`, so those branches do fire):
#       deps/cares/cares.gyp:252  [ 'OS=="openharmony"', { include_dirs: ['config/openharmony'] } ]
#   `--dest-os=openharmony` never makes gyp's OS variable openharmony -- gyp's OS comes from
#   the BUILD HOST (here: linux). Checked: config.gypi contains neither "openharmony" nor
#   "flavor", and the generated out/deps/cares/cares.target.mk has
#       -I$(srcdir)/deps/cares/config/linux
#   and no config/openharmony at all. Node SHIPS a correct
#   deps/cares/config/openharmony/ares_config.h (where HAVE_GETSERVBYPORT_R is #undef'd),
#   but this build never selected it.
#
# FIX
#   Put config/openharmony FIRST in the linux branch's include_dirs, so the compiler resolves
#   `ares_config.h` from it. Other OS branches are left untouched.
#
#   WHY THIS IS SAFE *IN THIS TREE*: this source tree is used only to cross-compile Node for
#   OHOS/arm64 (tools/node-runtime/build-node-ohos.sh). Do NOT reuse this tree to build Node
#   for Linux -- the linux branch now prefers the OHOS config, which would silently disable
#   glibc-only features there.
#
#   The generated makefile is patched too: make does NOT re-run gyp by itself (no GYPFILES
#   rule), so editing the .gyp alone would have no effect on the current build.
#
# Also removes the cares objects and libnode.so* so they are rebuilt/linked again.
# ASCII only. Idempotent.
set -uo pipefail

SRC="${1:-$HOME/ohos/node-v22.23.2}"
cd "$SRC" || exit 1

GYP="deps/cares/cares.gyp"
CFG_OHOS="deps/cares/config/openharmony/ares_config.h"

if [ ! -f "$GYP" ]; then
  echo "ERROR: $SRC/$GYP not found" >&2
  exit 1
fi
if [ ! -f "$CFG_OHOS" ]; then
  echo "ERROR: $SRC/$CFG_OHOS not found (Node should ship it; wrong version?)" >&2
  exit 1
fi

echo "=== the only strict OS==openharmony branch in the tree ==="
grep -n 'config/linux' "$GYP" | head -5

patched=0

# 1) gyp: make the linux branch prefer the OHOS config
if grep -q "'include_dirs': \[ 'config/openharmony', 'config/linux' \]" "$GYP"; then
  echo "gyp: already patched"
else
  sed -i "s@'include_dirs': \[ 'config/linux' \]@'include_dirs': [ 'config/openharmony', 'config/linux' ]@" "$GYP"
  patched=$((patched + 1))
  echo "gyp: patched linux include_dirs"
fi
grep -n "config/openharmony', 'config/linux'" "$GYP" | head -3

# 2) generated makefiles: put the OHOS include dir BEFORE config/linux
for mk in out/deps/cares/cares.target.mk; do
  [ -f "$mk" ] || continue
  if grep -q 'config/openharmony' "$mk"; then
    echo "$mk: already patched"
    continue
  fi
  sed -i 's@-I\$(srcdir)/deps/cares/config/linux@-I$(srcdir)/deps/cares/config/openharmony -I$(srcdir)/deps/cares/config/linux@g' "$mk"
  patched=$((patched + 1))
  echo "$mk: patched ($(grep -c 'config/openharmony' "$mk") occurrences)"
done

# 3) drop cares objects + libnode.so so they rebuild/relink
removed=0
for d in out/Release/obj.target/cares; do
  if [ -d "$d" ]; then rm -rf "$d"; removed=$((removed + 1)); echo "removed $d"; fi
done
while IFS= read -r f; do
  [ -n "$f" ] || continue
  rm -f "$f"
  removed=$((removed + 1))
done < <(find out/Release -maxdepth 1 -name 'libcares*.a' -o -maxdepth 1 -name 'libnode.so*' 2>/dev/null || true)
echo "patched=$patched removed=$removed"
echo "next: bash tools/node-runtime/resume-make.sh"
