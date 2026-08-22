#!/bin/bash
# ============================================================
# DSHM: 自建 libnode.so（Node.js for OpenHarmony arm64, 共享库）
#
# 背景: HDSH 使用的 libnode 预编译产物来源不公开（作者私有 HDSH_LIBNODE_URL），
#       且官方 OpenHarmony 移植版 (third_party_node) 需整套 OHOS 构建环境。
#       本脚本用 harmonybrew 已装的 OHOS SDK clang（LLVM 15, target
#       aarch64-unknown-linux-ohos, musl sysroot）直接编译标准 node 源码:
#       - dsh 要求 node ^22.19.0 || >=24.0.0，选 22 LTS（C++17，LLVM15 可编译；
#         node 26 需 C++20，LLVM15 无法编译 —— 见 harmonybrew node 公式注释）
#       - --shared 产出 libnode.so（HDSH 的 dlopen + node::Start 方案所需）
#       - 标准 libuv 尊重 UV_USE_IO_URING=0 环境变量（HDSH 的预编译版因 OHOS
#         移植改动需字节补丁，我们无需补丁，C++ 侧启动时置环境变量即可）
#
# 用法: bash scripts/build-libnode.sh [NODE_VERSION, 默认 v22.23.2]
# 依赖: ~/.harmonybrew（cc/clang++/make/python3/cmake），网络（nodejs.org）
# 产物: entry/libs/arm64-v8a/libnode.so（gitignore，随 HAP 分发）
# 耗时: 8 核约 30~60 分钟；可 NODE_JOBS 覆盖并行度
# ============================================================
set -e

NODE_VERSION="${1:-v22.23.2}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$REPO_ROOT/.tmp-libnode"
DEST_DIR="$REPO_ROOT/entry/libs/arm64-v8a"
JOBS="${NODE_JOBS:-$(nproc 2>/dev/null || echo 8)}"

HOMEBREW_PREFIX="${HOMEBREW_PREFIX:-$HOME/.harmonybrew}"
CC="$HOMEBREW_PREFIX/bin/cc"
CXX="$HOMEBREW_PREFIX/bin/clang++"
export PATH="$HOMEBREW_PREFIX/bin:$PATH"

echo "[0/6] 校验编译器: $CXX"
"$CXX" --version | head -1

TARBALL="$WORK/node-$NODE_VERSION.tar.xz"
SRC="$WORK/node-$NODE_VERSION"

mkdir -p "$WORK" "$DEST_DIR"

if [ ! -f "$SRC/configure" ]; then
  if [ ! -f "$TARBALL" ]; then
    echo "[1/6] 下载 node $NODE_VERSION 源码..."
    curl -fsSL -m 600 -o "$TARBALL" \
      "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION.tar.xz" \
      || { echo "下载失败（可设 NODE_DIST_MIRROR 换镜像）"; exit 1; }
  fi
  echo "[2/6] 解压源码..."
  tar -xf "$TARBALL" -C "$WORK"
fi

echo "[2.5/6] 应用本地补丁（全局 C++20）..."
# node 22.23 需要 C++20（ncrypto 的 spaceship/auto 形参、tools/js2c 的
# std::string::ends_with 等），而 common.gypi 对 linux/openharmony 全局设置
# -std=gnu++17。clang 15 完整支持 C++20，直接把全局 std 提到 gnu++20。
# 幂等：已 patch 则跳过；本次实际 patch 时清掉旧产物强制全量重建（std 变更
# 影响所有编译命令，make 按时间戳判断会误跳过旧对象）。
if grep -q -- '-std=gnu++17' "$SRC/common.gypi"; then
  python3 - "$SRC" <<'PY'
import sys
root = sys.argv[1]
gypi = root + "/common.gypi"
s = open(gypi, encoding="utf-8").read()
assert "-std=gnu++17" in s, "common.gypi 结构不符，patch 中止"
s = s.replace("-std=gnu++17", "-std=gnu++20")
open(gypi, "w", encoding="utf-8").write(s)
print("  common.gypi patched (-std=gnu++17 -> gnu++20)")
PY
  rm -rf "$SRC/out/Release"
  echo "  已清理旧产物，将全量重建"
else
  echo "  common.gypi 已 patch，跳过"
fi

echo "[2.6/6] 应用本地补丁（zlib 禁用 ARMv8 crc32 SIMD）..."
# OHOS SDK clang 15 的 openharmony 目标后端无法选择 llvm.aarch64.crc32b
# 内建函数（zlib 的 CRC32_ARMV8_CRC32 目标），直接禁用该目标走标量 CRC32。
# 幂等：已 patch 则跳过。
if grep -q "OS!=\"ios\" and OS!=\"openharmony\"" "$SRC/deps/zlib/zlib.gyp"; then
  echo "  zlib.gyp 已 patch，跳过"
else
  python3 - "$SRC" <<'PY'
import sys
root = sys.argv[1]
gyp = root + "/deps/zlib/zlib.gyp"
s = open(gyp, encoding="utf-8").read()
old = """        {
          'target_name': 'zlib_arm_crc32',
          'type': 'static_library',
          'conditions': [
            ['OS!="ios"', {"""
new = """        {
          'target_name': 'zlib_arm_crc32',
          'type': 'static_library',
          'conditions': [
            ['OS!="ios" and OS!="openharmony"', {"""
assert old in s, "zlib.gyp 结构不符，patch 中止"
s = s.replace(old, new, 1)
open(gyp, "w", encoding="utf-8").write(s)
print("  zlib.gyp patched (zlib_arm_crc32 disabled on openharmony)")
PY
fi

cd "$SRC"

echo "[3/6] configure (dest-os=openharmony, --shared)..."
# 说明:
#  - --dest-os=openharmony: 与 harmonybrew node 公式一致的标准源码 OHOS 平台开关
#  - --shared: 产出 libnode.so（dlopen 用）
#  - --without-npm: 运行时不需要 npm（插件走内置 pnpm），减少体积
#  - --with-intl=small-icu: 保留 Intl（默认），避免 dsh/插件 Intl 缺失
CC="$CC" CXX="$CXX" ./configure \
  --dest-os=openharmony \
  --dest-cpu=arm64 \
  --shared \
  --without-npm \
  --with-intl=small-icu

echo "[4/6] make -j$JOBS（较久，请耐心等待）..."
make -j"$JOBS"

echo "[5/6] 产物检查..."
ls -la out/Release/libnode.so* 2>/dev/null || { echo "未找到 libnode.so"; exit 1; }
out/Release/node --version

echo "[6/6] 拷贝到 $DEST_DIR/libnode.so..."
# out/Release/libnode.so 通常是 .so.<ver> 的软链；dlopen("libnode.so") 需要实体文件
REAL="$(find out/Release -maxdepth 1 -name 'libnode.so.*' -type f ! -name '*.a' | head -1)"
if [ -z "$REAL" ]; then REAL="out/Release/libnode.so"; fi
cp -f "$REAL" "$DEST_DIR/libnode.so"
file "$DEST_DIR/libnode.so"
du -h "$DEST_DIR/libnode.so"

echo "✅ libnode.so 就绪: $DEST_DIR/libnode.so"
echo "   提示: 构建目录 $WORK 可保留（含 node 二进制可自测），删除后重新构建即可复现。"
