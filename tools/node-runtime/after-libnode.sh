#!/usr/bin/env bash
# One-shot follow-up for the moment out/Release/libnode.so finally appears.
#
# It exists because that moment is the bottleneck of phase 2, and the steps right after it
# are mechanical but easy to fumble (wrong ELF check, forgotten signature question,
# linking the NAPI module against a missing library). Running this once replaces all of
# that with a single command and a clear "what is left" list.
#
# It does NOT pretend the runtime works: it only establishes the verifiable facts
# (ELF class/machine/type, signature section, linkability) and then prints the remaining
# wiring steps. "Runtime is available" is only true after a device proves it.
#
# ASCII only.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
SRC="${NODE_SRC:-$HOME/ohos/node-v22.23.2}"
REL="${SRC}/out/Release"
READELF="${HOME}/ohos/sdk/native/llvm/bin/llvm-readelf"
[ -x "$READELF" ] || READELF="readelf"

echo "=== 1) artifact presence ==="
found=""
for cand in "${REL}/libnode.so" "${REL}"/libnode.so.* ; do
  [ -e "$cand" ] || continue
  case "$cand" in *'.so.'*) continue ;; esac
  found="$cand"
done
# libnode.so is usually a symlink to libnode.so.<abi>; accept either
if [ -z "$found" ]; then
  for cand in "${REL}"/libnode.so*; do
    [ -e "$cand" ] && found="$cand" && break
  done
fi

if [ -z "$found" ]; then
  echo "  libnode.so        : NOT FOUND"
  echo "  node              : $([ -e "${REL}/node" ] && echo present || echo 'not found')"
  echo
  echo "==> 阶段二的产物还没出来。继续用："
  echo "      bash tools/node-runtime/resume-make.sh        # 续跑（会先清掉非 AArch64 对象）"
  echo "      bash tools/node-runtime/show-build-failure.sh # 失败时看原因"
  echo "      bash tools/node-runtime/status-brief.sh       # 看进度"
  echo "    若某个附属二进制反复失败，可用绕行（代价见 README：可能没有内置快照）："
  echo "      cd ${SRC} && make libnode -j\$(nproc)"
  exit 1
fi

echo "  libnode.so : ${found}"
ls -la "${REL}"/libnode.so* 2>/dev/null | sed 's/^/    /'
echo "  node       : $([ -e "${REL}/node" ] && echo present || echo 'not built (ok for HAP embedding)')"

# 链接 libdshhost.so 时要用 -lnode，而链接器只认不带版本号的 libnode.so；
# make 只产出 libnode.so.<abi>，所以这里补一个符号链接（**只在本机构建树里**——
# HAP 内部不能有符号链接，见下面第 5 节关于 NEEDED 名字的说明）。
if [ ! -e "${REL}/libnode.so" ] && [ -e "${REL}/libnode.so.127" ]; then
  ln -sf libnode.so.127 "${REL}/libnode.so" && echo "  + created symlink libnode.so -> libnode.so.127 (for -lnode)"
fi

echo
echo "=== 2) ELF check (must be ELF64 / AArch64 / DYN) ==="
"$READELF" -h "$found" | grep -E 'Class|Machine|Type' | sed 's/^/  /'
hdr="$("$READELF" -h "$found")"
case "$hdr" in
  *AArch64*) echo "  => machine OK" ;;
  *) echo "  !! machine is NOT AArch64 -- this is not a device-loadable library" ;;
esac
case "$hdr" in
  *DYN*) echo "  => shared object OK" ;;
  *) echo "  !! not ET_DYN (shared object)" ;;
esac

echo
echo "=== 3) signature ==="
if "$READELF" -S "$found" | grep -qE '\.codesign'; then
  echo "  .codesign : present"
else
  echo "  .codesign : ABSENT -- and that is EXPECTED / FINE"
  echo "  E23 settled this on a real device: the bundled libs (libelectron.so etc.) carry no"
  echo "  .codesign either, yet the device LOADED and RAN them (crash stack shows"
  echo "  ElectronMain -> node::LoadEnvironment -> node::StartExecution -> JS)."
  echo "  So a bundled .so does not need a code signature; no signing step is required."
  echo "  (sign-native.ps1 stays available in case a future device test ever says otherwise."
  echo "   If it were ever needed it must run BEFORE HAP assembly.)"
fi

echo
echo "=== 4) link the NAPI bootstrap against it ==="
if bash "${HERE}/build-dshhost.sh"; then
  echo "  libdshhost.so built."
else
  echo "  !! build-dshhost.sh failed -- see its output above" >&2
  exit 1
fi

echo
echo "=== 5) what is still missing (do NOT skip the ordering) ==="
cat <<'NEXT'
  0) ship the runtime into the HAP: copy out/Release/libnode.so.127 to
       entry/libs/arm64-v8a/libnode.so.127
     The filename is NOT free: libdshhost.so's NEEDED entry is `libnode.so.127`
     (checked by step 4), and the loader looks up exactly that name. Also a HAP cannot
     carry symlinks, so do NOT plan on shipping libnode.so -> libnode.so.127.
     entry/libs/ is gitignored (138 MB: bytes out of git, procedure in git).
  a) entry/src/main/cpp/types/libdshhost/oh-package.json5
       { "name": "libdshhost.so", "types": "./index.d.ts", "version": "1.0.0" }
     (index.d.ts already exists and is inert until referenced)
  b) entry/oh-package.json5 dependencies:
       "libdshhost.so": "file:./src/main/cpp/types/libdshhost"
     Both (a) and (b) MUST wait until libdshhost.so really exists: declaring a native
     library that cannot load is not a compile error, it is a load/call-time crash that
     would take the currently working pages down with it.
  c) hostruntime: an ArkTS NodeRuntime implementing RuntimePort, calling
       dshhost.startHost(buildHostArgv(entry), buildHostEnv(coreDir, homeDir, sandboxHome, port, profile))
     Readiness is detected by polling 127.0.0.1:<port> (the shim cannot hand stdout to ArkTS),
     not by parsing DSHM_READY.
  d) select it in DshHost (today the default is NotWiredRuntime, which honestly reports
     "not wired" -- keep it until (c) is real and device-verified).
  e) device: does libnode.so load at all; does startHost really bring up the Host;
     does an unsigned bundled .so get rejected (E18). None of these can be answered here.
NEXT
