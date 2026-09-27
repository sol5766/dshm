#!/usr/bin/env bash
# Make libuv never attempt io_uring on OpenHarmony.
#
# SYMPTOM (measured on device, D6 E42/E43)
#   The app dies within ~5 s with nothing but:
#       Reason: Signal:SIGSYS(SYS_SECCOMP) syscall number is 425
#       #03 libnode.so.127(uv_loop_init+292)
#       #04 libnode.so.127(node::tracing::Agent::Agent()+184)
#       #05 libnode.so.127(node::V8Platform::Initialize(int)+60)
#       #07 libnode.so.127(node::Start(int, char**)+76)
#   On arm64 syscall 425 is `io_uring_setup`. OpenHarmony's seccomp policy does not
#   return an error for it -- it KILLS the process with SIGSYS.
#
# WHY UV_USE_IO_URING=0 DOES NOT HELP (read from deps/uv/src/unix/linux.c)
#       static int uv__use_io_uring(uint32_t flags) {
#         ...
#         /* SQPOLL is all kinds of buggy but epoll batching should work fine. */
#         if (0 == (flags & UV__IORING_SETUP_SQPOLL))
#           return 1;                       <-- unconditional YES for the plain path
#         ...
#         val = getenv("UV_USE_IO_URING");  <-- only consulted for SQPOLL
#   `uv_loop_init` calls it with flags==0, so the env var is never read on that path.
#   (Verified on device: envApplied=6, i.e. the variable WAS set, and it still crashed.)
#
# FIX
#   Upstream libuv already does exactly this for Android, for exactly this reason:
#       #if defined(__ANDROID_API__)
#         return 0;  /* Possibly available but blocked by seccomp. */
#   This source tree is only ever used to cross-compile Node for OpenHarmony
#   (tools/node-runtime/build-node-ohos.sh), so the early return is unconditional here.
#
# After running this you MUST rebuild and re-copy libnode (see the echo at the end).
# ASCII only. Idempotent.
set -uo pipefail

SRC="${1:-$HOME/ohos/node-v22.23.2}"
FILE="$SRC/deps/uv/src/unix/linux.c"
MARK="DSHM: OHOS seccomp kills io_uring_setup"

if [ ! -f "$FILE" ]; then
  echo "ERROR: no $FILE (wrong SRC?)" >&2
  exit 1
fi

if grep -q "$MARK" "$FILE"; then
  echo "already patched: $FILE"
  exit 0
fi

# 在函数开括号后立刻插入早期返回
python3 - "$FILE" "$MARK" <<'PY'
import sys
path, mark = sys.argv[1], sys.argv[2]
with open(path, 'r', encoding='utf-8') as f:
    text = f.read()
anchor = "static int uv__use_io_uring(uint32_t flags) {\n"
if anchor not in text:
    print("ERROR: anchor not found; libuv layout changed", file=sys.stderr)
    sys.exit(1)
inject = anchor + (
    "  /* %s (arm64 syscall 425), so libuv must never try it.\n"
    "     Upstream returns 0 for Android for the same reason; this tree only ever\n"
    "     cross-compiles Node for OHOS, so it is unconditional here.\n"
    "     See tools/node-runtime/fix-uv-io-uring.sh for the full evidence. */\n"
    "  (void) flags;\n"
    "  return 0;\n" % mark
)
text = text.replace(anchor, inject, 1)
with open(path, 'w', encoding='utf-8') as f:
    f.write(text)
print("patched:", path)
PY

echo
echo "now rebuild and re-copy libnode:"
echo "  cd $SRC && make -j\$(nproc)"
echo "  cp -f $SRC/out/Release/libnode.so.127 <repo>/entry/libs/arm64-v8a/libnode.so.127"
echo "  (then rebuild the HAP so the new .so is packed)"
