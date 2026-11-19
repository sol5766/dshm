#!/usr/bin/env bash
# Resume the OpenHarmony x86_64 Node build without purging completed x64 objects.
# The generic resume-make.sh intentionally retains AArch64 objects only.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${1:-$HOME/ohos/node-v22.23.2}"
TARGET="${2:-}"
LOG="$HOME/ohos/build-node-x64.log"

if [ ! -d "$SRC" ]; then
  echo "ERROR: no source tree at $SRC" >&2
  exit 1
fi

OHOS_ARCH=x64
export OHOS_ARCH
# shellcheck source=toolchain-env.sh
source "${HERE}/toolchain-env.sh" || exit 1

cd "$SRC"
echo "=== make -j8 x64 (resume target=${TARGET:-all}) $(date -Is) ===" | tee -a "$LOG"
if [ -n "$TARGET" ]; then
  make -C out -j8 "$TARGET" 2>&1 | tee -a "$LOG"
else
  make -j8 2>&1 | tee -a "$LOG"
fi
code=${PIPESTATUS[0]}
echo "MAKE_EXIT=$code" | tee -a "$LOG"
exit "$code"
