#!/usr/bin/env bash
# 取 OpenHarmony 公开 SDK（含 Linux 宿主 NDK），供交叉编译 Node 用。
# 来源：华为云镜像（公开，无需账号）
#   https://repo.huaweicloud.com/openharmony/os/<ver>/ohos-sdk-windows_linux-public.tar.gz
#
# 产物：~/ohos/sdk/{ets,native,toolchains,previewer}
#   我们只关心 native/（llvm + sysroot）——交叉编译 Node 需要
#   native/llvm/bin/aarch64-unknown-linux-ohos-clang
set -euo pipefail

VER="${OHOS_SDK_VER:-6.1-Release}"
BASE="https://repo.huaweicloud.com/openharmony/os/${VER}"
ROOT="${HOME}/ohos"
TGZ="${ROOT}/ohos-sdk-${VER}.tar.gz"
SDK="${ROOT}/sdk"

mkdir -p "${ROOT}"
cd "${ROOT}"

if [ ! -s "${TGZ}" ] || [ "$(stat -c%s "${TGZ}")" -lt 1000000000 ]; then
  echo "[sdk] 下载 ${BASE}/ohos-sdk-windows_linux-public.tar.gz"
  # -C - 断点续传；--retry 抗抖；-sS 不打印进度条
  # （进度条走 stderr 会让 PowerShell 侧报 NativeCommandError，把任务判成失败）
  curl -fsSL --retry 5 --retry-delay 5 -C - -o "${TGZ}" \
    "${BASE}/ohos-sdk-windows_linux-public.tar.gz"
else
  echo "[sdk] 已有 ${TGZ}（$(du -h "${TGZ}" | cut -f1)），跳过下载"
fi

if [ ! -d "${ROOT}/linux" ]; then
  echo "[sdk] 解外层 tar.gz（约 2.3 GB，需要几分钟）"
  tar -xzf "${TGZ}"
else
  echo "[sdk] 外层已解包"
fi

ls -1 "${ROOT}/linux" 2>/dev/null | head -20 || true

echo "[sdk] 解内层 zip 到 ${SDK}"
mkdir -p "${SDK}"
cd "${ROOT}/linux"
for z in *.zip; do
  [ -e "$z" ] || continue
  echo "[sdk]   unzip $z"
  unzip -oq "$z" -d "${SDK}"
done

echo "[sdk] 结果："
ls -1 "${SDK}" || true
CLANG="${SDK}/native/llvm/bin/aarch64-unknown-linux-ohos-clang"
if [ -x "${CLANG}" ]; then
  echo "[sdk] ✓ 找到交叉编译器 ${CLANG}"
  "${CLANG}" --version | head -3
else
  echo "[sdk] ✗ 未找到 ${CLANG}"
  exit 1
fi
echo "[sdk] 完成"
