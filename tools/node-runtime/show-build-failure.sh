#!/usr/bin/env bash
# Print the tail of the Node build log with each line truncated, so a failure is readable
# without dumping whole compiler command lines. ASCII only.
#   usage: bash show-build-failure.sh [lines] [maxlen]
LOG="$HOME/ohos/build-node.log"
N="${1:-60}"
W="${2:-200}"

if [ ! -f "$LOG" ]; then
  echo "no log at $LOG" >&2
  exit 1
fi

echo "--- last $N lines (each cut to $W chars) ---"
tail -n "$N" "$LOG" | cut -c1-"$W"

echo
echo "--- compiler/linker error markers ---"
grep -n -E "error:|Error [0-9]|undefined reference|fatal error" "$LOG" | tail -n 20 | cut -c1-"$W"
