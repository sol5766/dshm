#!/usr/bin/env bash
# 交叉编译 Node.js（OpenHarmony aarch64）→ libnode.so + node
#
# 依据（都已核实）：
#   - Node 官方 BUILDING.md 的平台表列 OpenHarmony/arm64（Experimental）
#   - v22.23.2 的 common.gypi 里确有 `OS=="openharmony"` 分支（在 tag 上核对过）
#   - `--dest-os` 的合法取值是 openharmony（不是 ohos）
#   - 版本下限：OHOS 支持 >= 22.17.0；会话持久化的 zstd 需要 >= 22.15 ⇒ 取 v22.23.2
#   - `--shared` 在 OpenHarmony 上属官方"未测试"路径（D6 E12）——本脚本就是去证伪/证实它
#
# 产物（关键）：
#   out/Release/libnode.so.<n>   ← 端侧要的"能被 HAP 加载的 Node"
#   out/Release/node             ← 同一次构建的副产品，可用于 HNP 路线
#
# 用法：bash 02-build-node.sh
# 说明：会先等 01-fetch-sdk.sh 把 SDK 放好（轮询），因此可以并行启动。
set -euo pipefail

# HERE 必须**在任何 cd 之前**算出来：脚本中途会 cd 到源码树，
# 之后再解析相对路径的 ${BASH_SOURCE[0]} 就会变成 "tools/node-runtime: No such file or directory"
# （实测踩过：以相对路径调用时整脚本在此处失败）。
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NODE_VER="${NODE_VER:-v22.23.2}"
ROOT="${HOME}/ohos"
SDK="${ROOT}/sdk"
CLANG_DIR="${SDK}/native/llvm/bin"
# 目标架构：arm64 = 真机（上架目标），x64 = 本机鸿蒙模拟器（镜像为 x86_64）。
# 与 toolchain-env.sh 用同一个 OHOS_ARCH 变量；这里提前算出 triple 只为下面的
# "等 SDK 就绪"循环能用上正确的那份 clang。
OHOS_ARCH="${OHOS_ARCH:-arm64}"
case "${OHOS_ARCH}" in
  arm64) OHOS_TRIPLE="aarch64-unknown-linux-ohos"; DEST_CPU="arm64" ;;
  x64)   OHOS_TRIPLE="x86_64-unknown-linux-ohos";  DEST_CPU="x64" ;;
  *) echo "[node] ✗ OHOS_ARCH 只能是 arm64 或 x64（收到 ${OHOS_ARCH}）"; exit 1 ;;
esac
export OHOS_ARCH
CLANG="${CLANG_DIR}/${OHOS_TRIPLE}-clang"
SYSROOT="${SDK}/native/sysroot"
SRC_DIR="${ROOT}/node-${NODE_VER}"
BUILD_LOG="${ROOT}/build-node-${OHOS_ARCH}.log"
# 说明：SRC_DIR 必须在 ${ROOT} 下——解包发生在 ${ROOT}（见下），
# 曾经写成 ${HOME}/node-<ver> 导致 cd 到不存在的目录（实测踩过）

echo "[node] 等待 SDK 就绪（${CLANG}）"
for i in $(seq 1 240); do
  [ -x "${CLANG}" ] && break
  sleep 15
done
if [ ! -x "${CLANG}" ]; then
  echo "[node] ✗ 等待 SDK 超时（40 分钟）"
  exit 1
fi
echo "[node] ✓ SDK 就绪"

cd "${ROOT}"

# ── 取源码（用官方源码包，比 clone 快且不带历史）──
if [ ! -d "${SRC_DIR}" ]; then
  TARBALL="node-${NODE_VER}.tar.xz"
  if [ ! -s "${TARBALL}" ]; then
    echo "[node] 下载源码 ${NODE_VER}"
    # -sS：不打印进度条。进度条走 stderr 会让调用方（PowerShell）报 NativeCommandError，
    # 把整个任务判成失败，从而掩盖真实结果（实测踩过）
    curl -fsSL --retry 5 -o "${TARBALL}" "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}.tar.xz"
  fi
  echo "[node] 解包源码 → ${ROOT}"
  tar -xf "${TARBALL}"
fi
cd "${SRC_DIR}"

# ── 源码修补（**必须**在 configure 之前）──
# 这两条修的是"我们自己编译 Node"的构建配置，与"对 dsh 上游零 patch"的纪律无关。
# 放在 configure 之前，是为了让 gyp 直接生成正确的 makefile；若改在之后，
# 还得手工改 out/**/*.target.mk（make 不会自己重跑 gyp——实测过）。
echo "[node] 应用源码修补：C++ 标准 / 目标链接的 -latomic / c-ares 的 OHOS 配置 / libuv 的 io_uring"
bash "${HERE}/fix-cxx-std.sh" "${SRC_DIR}"
# zlib 的 ARMv8 CRC32 SIMD 修补只对 aarch64 有意义（x86_64 上那段 intrinsic 本就能编）
if [ "${OHOS_ARCH}" = "arm64" ]; then
  echo "[node] 应用 zlib ARMv8 CRC32 修补（arm64 专用）"
  bash "${HERE}/fix-zlib-crc32.sh" "${SRC_DIR}"
else
  echo "[node] 跳过 zlib ARMv8 CRC32 修补（${OHOS_ARCH} 不需要）"
fi
bash "${HERE}/fix-latomic.sh" "${SRC_DIR}"
bash "${HERE}/fix-cares-ohos-config.sh" "${SRC_DIR}"
bash "${HERE}/fix-uv-io-uring.sh" "${SRC_DIR}"

# ── 工具链环境 ──
# 单一来源：toolchain-env.sh。**不要**在这里另写一份 export。
# 原因（实测踩过，代价是一次全量重建）：out/Makefile 里是 `CC.target ?= $(CC)`，
# 目标编译器取自环境变量；漏掉导出时 make 会静默用宿主 cc/g++ 编译**目标**对象，
# 编译期不报错，几千个对象之后才以一个看不懂的错误暴露。
# shellcheck source=toolchain-env.sh
source "${HERE}/toolchain-env.sh"
echo "[node] 交叉工具链 CC=${CC}"

echo "[node] configure（dest-os=openharmony dest-cpu=${DEST_CPU} --shared）"
./configure \
  --dest-os=openharmony \
  --dest-cpu="${DEST_CPU}" \
  --cross-compiling \
  --openssl-no-asm \
  --shared \
  --prefix="${ROOT}/node-install" \
  2>&1 | tee -a "${BUILD_LOG}"

echo "[node] make -j$(nproc)（V8 很重，预计 30~90 分钟）"
make -j"$(nproc)" 2>&1 | tee -a "${BUILD_LOG}"

echo "[node] ── 产物 ──"
ls -la out/Release/ 2>/dev/null | grep -E 'libnode|^.*node$|\.so' || ls -la out/Release/ | head -30
echo "[node] ── 交叉产物 ELF 校验 ──"
READELF="${CLANG_DIR}/llvm-readelf"
for f in out/Release/libnode.so* out/Release/node; do
  [ -e "$f" ] || continue
  echo "--- $f"
  "${READELF}" -h "$f" | grep -E 'Class|Machine|Type' || true
  "${READELF}" -S "$f" | grep -E '\.codesign|\.note\.ohos' || echo "    （无 ohos 签名段：需要自行签名）"
done
echo "[node] 完成（日志 ${BUILD_LOG}）"
