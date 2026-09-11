#!/bin/bash
# 获取 libnode.so（Node.js for OpenHarmony 预编译产物）
# 使用者通过 DSHM_LIBNODE_URL 提供已审核的 libnode 发行包地址。
# 下载后自动应用 io_uring 禁用 patch（鸿蒙沙箱 seccomp 禁止 syscall 425，见 patch-libnode-io-uring.sh）
set -e
cd "$(dirname "$0")/.."
DEST=entry/libs/arm64-v8a/libnode.so
if [ -f "$DEST" ]; then echo "libnode.so 已存在"; exit 0; fi
echo "下载 libnode v26.7.0 (OpenHarmony arm64)..."
mkdir -p entry/libs/arm64-v8a
if [ -z "${DSHM_LIBNODE_URL:-}" ]; then
  echo "请先设置 DSHM_LIBNODE_URL，再下载 libnode 运行时。" >&2
  exit 2
fi
curl -sL -o /tmp/libnode.tar.gz "$DSHM_LIBNODE_URL"
tar -xzf /tmp/libnode.tar.gz -C /tmp
cp /tmp/libnode-v26.7.0-openharmony-arm64/lib/libnode.so "$DEST"
rm -rf /tmp/libnode.tar.gz /tmp/libnode-v26.7.0-openharmony-arm64
echo "libnode.so 就绪: $DEST ($(du -h $DEST | cut -f1))"
# 应用 io_uring 禁用 patch（幂等）
bash "$(dirname "$0")/patch-libnode-io-uring.sh" "$DEST"
