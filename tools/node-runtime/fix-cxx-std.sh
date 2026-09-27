#!/usr/bin/env bash
# 把 Node 构建配置里的 C++ 标准从 gnu++17 提到 gnu++20（ASCII only）。
#
# 背景：deps/ncrypto/ncrypto.cc 用了 C++20 的三路比较 operator<=>，
# 而 common.gypi 第 508-514 行那个块（linux freebsd openbsd solaris android aix os400
# cloudabi openharmony）统一给 cflags_cc 加了 '-std=gnu++17'，于是编译报
#   'operator<=' cannot be the name of a variable or data membe
# 注意：这是**我们自己编译 Node 时的构建配置**，与"对 dsh 上游零 patch"的纪律无关。
set -euo pipefail
SRC="${1:-${HOME}/ohos/node-v22.23.2}"
cd "${SRC}"

if [ ! -f common.gypi.bak ]; then
  cp common.gypi common.gypi.bak
  echo "backup: common.gypi.bak"
fi

# 只改 cflags_cc 里那一行（带尾部逗号的那个），不会碰到 macOS 的
# CLANG_CXX_LANGUAGE_STANDARD 行（那行没有尾逗号）
sed -i "s/'-std=gnu++17',$/'-std=gnu++20',/" common.gypi

echo "--- 改后的相关行 ---"
grep -n 'std=gnu' common.gypi || true
