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
# libnode.so.127 链接完成后，node/embedtest/cctest 可执行文件会因
# --no-allow-shlib-undefined 检查（libnode.so 带未解析符号）失败而中断，
# 属预期行为；完整日志保留，供下一步提取 libnode.so.127 链接命令。
make -j"$JOBS" > build-make.log 2>&1 || true

echo "[4.5/6] 补链 libnode.so（cpu_check_features stub + libc++）..."
# OHOS SDK clang 15 不编译 openssl 的 crypto/aarch64cpuid.S，导致 libnode.so
# 带未定义符号 cpu_check_features；node 22 链接又依赖 libc++。用 stub 补上
# 缺失符号并静态链入 libc++，保证 dlopen(RTLD_NOW) 不会因未定义符号失败。
cat > stub.c <<'EOF'
/* OpenSSL arm64 cpu_check_features 缺失定义 stub（OHOS clang 15 未编译
 * crypto/aarch64cpuid.S）：不声明任何 CPU 特性，OpenSSL 走基础路径。 */
unsigned int cpu_check_features(void) { return 0; }
EOF
"$CC" --target=aarch64-ohos -c -O2 -fPIC stub.c -o stub.o
LIBCXX_DIR="$(find "$HOMEBREW_PREFIX/Cellar/ohos-sdk" -type d -path "*/llvm/lib/aarch64-linux-ohos" | head -1)"
if [ -z "$LIBCXX_DIR" ]; then
  echo "未找到 ohos-sdk 的 aarch64-linux-ohos libc++，请检查 harmonybrew 安装"
  exit 1
fi
LINKCMD="$(grep -oE "clang\+\+ -o [^ ]*obj\.target/libnode\.so\.127 -shared .*" build-make.log | head -1)"
if [ -z "$LINKCMD" ]; then
  echo "未从 make 日志提取到 libnode.so.127 链接命令，无法补链"
  exit 1
fi
eval "$LINKCMD stub.o $LIBCXX_DIR/libc++_static.a $LIBCXX_DIR/libc++abi.a $LIBCXX_DIR/libunwind.a"

echo "[4.6/6] strip 调试符号..."
"$HOMEBREW_PREFIX/bin/llvm-strip" --strip-all -o libnode.so "$SRC/out/Release/obj.target/libnode.so.127"

echo "[5/6] 产物检查..."
ls -la libnode.so || { echo "未找到 libnode.so"; exit 1; }
"$HOMEBREW_PREFIX/bin/llvm-nm" -D libnode.so | grep -E "cpu_check_features|_ZN4node5Start" || {
  echo "libnode.so 缺少关键符号（node::Start / cpu_check_features）"; exit 1; }

echo "[6/6] 拷贝到 $DEST_DIR/libnode.so..."
cp -f libnode.so "$DEST_DIR/libnode.so"
file "$DEST_DIR/libnode.so"
du -h "$DEST_DIR/libnode.so"

echo "✅ libnode.so 就绪: $DEST_DIR/libnode.so"
echo "   提示: 构建目录 $WORK 可保留（含 node 可执行文件可自测），删除后重新构建即可复现。"
echo "   注意: 顶层 make 对 node/embedtest 的链接失败可忽略（本流程仅需 libnode.so）。"
