#!/bin/bash
# ============================================================
# HDSH: 获取 pnpm standalone（linuxstatic arm64，musl 静态，自带 node）
# 用途: dsh plugin 命令是 pnpm 前向器（spawnSync("pnpm")），沙箱内无 node
#       可执行文件，须内置 pnpm standalone 并注入 PATH。
# 来源: npm registry @pnpm/linuxstatic-arm64（官方 SEA 单文件可执行）
# 产物: entry/src/main/resources/rawfile/pnpm/pnpm（随 HAP 分发，gitignore 不提交）
# 注意: 使用 llvm-strip 去除 debug 符号减小体积（~138MB -> ~106MB）。
# ============================================================
set -e
cd "$(dirname "$0")/.."

DEST_DIR=entry/src/main/resources/rawfile/pnpm
DEST="$DEST_DIR/pnpm"
PNPM_VERSION="${1:-11.9.0}"

if [ -f "$DEST" ]; then
  echo "pnpm standalone 已存在: $DEST ($(du -h "$DEST" | cut -f1))"
  exit 0
fi

# 可通过 LLVM_STRIP 指定工具；否则从 PATH 查找，避免绑定到某台机器的 SDK 路径。
if [ -z "${LLVM_STRIP:-}" ]; then
  LLVM_STRIP="$(command -v llvm-strip 2>/dev/null || true)"
fi
if [ -z "$LLVM_STRIP" ] || [ ! -x "$LLVM_STRIP" ]; then
  echo "警告: 未找到 llvm-strip，跳过 strip（体积将偏大）"
  LLVM_STRIP=""
fi

echo "下载 pnpm standalone v$PNPM_VERSION (linuxstatic-arm64)..."
mkdir -p "$DEST_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

TARBALL="https://registry.npmjs.org/@pnpm/linuxstatic-arm64/-/linuxstatic-arm64-$PNPM_VERSION.tgz"
curl -fsSL -m 300 -o "$TMP/pnpm.tgz" "$TARBALL" || { echo "下载失败: $TARBALL"; exit 1; }
tar -xzf "$TMP/pnpm.tgz" -C "$TMP"

SRC="$(find "$TMP" -type f -name pnpm -size +10M | head -1)"
if [ -z "$SRC" ]; then
  echo "错误: tarball 内未找到 pnpm 可执行文件"; exit 1
fi

cp "$SRC" "$DEST"
chmod 755 "$DEST"
if [ -n "$LLVM_STRIP" ]; then
  "$LLVM_STRIP" "$DEST" 2>/dev/null || echo "strip 失败（忽略，继续使用未 strip 版本）"
fi

echo "pnpm standalone 就绪: $DEST ($(du -h "$DEST" | cut -f1))"
