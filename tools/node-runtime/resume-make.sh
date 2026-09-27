#!/usr/bin/env bash
# Resume the Node cross-compile in $SRC, with the cross toolchain actually exported,
# and record the real exit code in the log.
#
# Why this is a script and not an inline `wsl bash -lc '...'`:
#   a payload that itself contains quotes, passed through PowerShell -> wsl -> bash,
#   gets mangled (observed: the compound command silently did not run and the previous
#   run's log tail was reported instead).
#
# Why it sources toolchain-env.sh:
#   out/Makefile uses `CC.target ?= $(CC)`. Without the exports, make compiles TARGET
#   objects with the host cc/g++ and nothing complains until much later.
#
# It also purges any target objects that are not AArch64 before resuming, so a tree
# polluted by an earlier env-less run is repaired instead of silently linked.
# ASCII only.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${1:-$HOME/ohos/node-v22.23.2}"
LOG="$HOME/ohos/build-node.log"

if [ ! -d "$SRC" ]; then
  echo "ERROR: no source tree at $SRC" >&2
  exit 1
fi

# shellcheck source=toolchain-env.sh
source "${HERE}/toolchain-env.sh" || exit 1

cd "$SRC"

# ── purge target objects built by the wrong (host) compiler ────────────────
if [ "${PURGE_FOREIGN:-1}" = "1" ]; then
  READELF="${OHOS_CLANG_DIR}/llvm-readelf"
  [ -x "$READELF" ] || READELF="readelf"
  purged=0
  while IFS= read -r o; do
    m="$("$READELF" -h "$o" 2>/dev/null | grep Machine: | head -1)"
    case "$m" in
      *AArch64*) ;;
      *) rm -f "$o"; purged=$((purged + 1)) ;;
    esac
  done < <(find out/Release/obj.target -name '*.o' 2>/dev/null)
  echo "purged foreign-arch target objects: $purged"
fi

JOBS="$(nproc)"
echo "=== make -j${JOBS} (resume) $(date -Is) ===" > "$LOG"
echo "CC.target = ${CC}" >> "$LOG"
make -j"${JOBS}" >> "$LOG" 2>&1
code=$?
echo "MAKE_EXIT=$code" >> "$LOG"
echo "MAKE_EXIT=$code"
exit 0
