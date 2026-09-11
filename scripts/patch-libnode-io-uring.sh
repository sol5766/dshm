#!/bin/bash
# ============================================================
# DSHM: patch libnode.so —— 禁用 libuv io_uring 初始化
#
# 背景: 鸿蒙沙箱 seccomp 过滤器禁止 io_uring_setup（aarch64 syscall 425），
#       触发即 SIGSYS 崩溃（node::V8Platform::Initialize → uv_loop_init）。
#       libuv 虽有 UV_USE_IO_URING 环境变量开关，但本预编译 libnode.so 的
#       uv__iou_init 在 uv__platform_loop_init 以 flags=0 调用时**绕过该检查**，
#       无条件执行 syscall(425)，故 setenv 无效（实测确认）。
#
# 修复: 将 uv__iou_init 中的 "bl syscall@plt"(io_uring_setup) 指令替换为
#       "mov w0, #-1"，使 io_uring_setup 返回 -1，libuv 走失败路径回退 epoll。
#       （uv__platform_loop_init 会忽略 iou_init 返回值，主循环使用 epoll fd）
#
# 用法: bash scripts/patch-libnode-io-uring.sh [libnode.so 路径，默认 entry/libs/arm64-v8a/libnode.so]
# 幂等: 已 patch 则跳过；请在每次 fetch-libnode.sh 重新下载后重新执行。
# ============================================================
set -e
LIB="${1:-entry/libs/arm64-v8a/libnode.so}"
[ -f "$LIB" ] || { echo "错误: $LIB 不存在（先运行 scripts/fetch-libnode.sh）"; exit 1; }

# 原始指令: bl syscall@plt（objdump: 44e15d8: 94ac36ee bl 0x6fef190）
# 替换为:   mov w0, #-1（movn w0, #0 = 0x12800000）
OFF=0x44e15d8
ORIG="ee36ac94"
NEW="00008012"

CUR=$(python -c "
d = open(r'$LIB','rb').read()
print(d[$OFF:$OFF+4].hex())
")

if [ "$CUR" = "$NEW" ]; then
  echo "已 patch，跳过: $LIB"
  exit 0
fi
if [ "$CUR" != "$ORIG" ]; then
  echo "错误: 偏移 $OFF 处字节为 $CUR，期望 $ORIG（libnode.so 版本不符？）"
  exit 1
fi

cp "$LIB" "$LIB.orig" 2>/dev/null || true
python -c "
d = bytearray(open(r'$LIB','rb').read())
d[$OFF:$OFF+4] = bytes.fromhex('$NEW')
open(r'$LIB','wb').write(bytes(d))
print('✅ patch 完成: 0x$OFF  $ORIG -> $NEW')
"

# 校验
VERIFY=$(python -c "
d = open(r'$LIB','rb').read()
print(d[$OFF:$OFF+4].hex())
")
[ "$VERIFY" = "$NEW" ] && echo "✅ 校验通过: $LIB（io_uring_setup 已禁用，libuv 回退 epoll）" || { echo "❌ 校验失败"; exit 1; }
