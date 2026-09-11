#!/bin/bash
# 获取 busybox（OpenHarmony arm64-v8a 预编译产物），为 dsh 提供 bash/Linux 环境。
# 来源: Harmonybrew/ohos-busybox 1.37.0（OHOS 专用 aarch64，动态 musl，含 bash applet）
# 注意: busybox.net 的 "busybox-armv8l" 实为 32 位 ARM (armhf)，不可用于 arm64-v8a，勿作备源。
# 产物: entry/src/main/resources/rawfile/busybox/busybox（随 HAP 分发，运行时解压到沙箱）
set -e
cd "$(dirname "$0")/.."

DEST=entry/src/main/resources/rawfile/busybox/busybox
PRIMARY_URL="https://github.com/Harmonybrew/ohos-busybox/releases/download/1.37.0/busybox-1.37.0-ohos-arm64.tar.gz"

if [ -f "$DEST" ]; then
  echo "busybox 已存在: $DEST ($(du -h "$DEST" | cut -f1))"
  exit 0
fi
mkdir -p entry/src/main/resources/rawfile/busybox

echo "下载 busybox (OpenHarmony arm64-v8a)..."
TMPDIR_BB="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BB"' EXIT

curl -fsSL -m 120 -o "$TMPDIR_BB/busybox.tar.gz" "$PRIMARY_URL" \
  || { echo "busybox 下载失败: $PRIMARY_URL"; exit 1; }
tar -xzf "$TMPDIR_BB/busybox.tar.gz" -C "$TMPDIR_BB"
BB_BIN="$(find "$TMPDIR_BB" -type f -name busybox | head -1)"
[ -n "$BB_BIN" ] || { echo "busybox 包内未找到 busybox 二进制"; exit 1; }
cp "$BB_BIN" "$DEST"
chmod 0755 "$DEST"

# 校验 ELF 64 位 + AArch64（e_machine=183）
MAGIC="$(od -An -tx1 -N4 "$DEST" | tr -d ' \n')"
CLASS="$(od -An -tx1 -j4 -N1 "$DEST" | tr -d ' \n')"
MACHINE="$(od -An -tx2 -j18 -N2 "$DEST" | tr -d ' \n')"
[ "$MAGIC" = "7f454c46" ] || { echo "校验失败: 不是 ELF 文件"; exit 1; }
[ "$CLASS" = "02" ] || { echo "校验失败: 不是 64 位 ELF"; exit 1; }
[ "$MACHINE" = "b700" ] || { echo "校验失败: 不是 AArch64 (e_machine=$MACHINE)"; exit 1; }
echo "busybox 就绪: $DEST ($(du -h "$DEST" | cut -f1))"
