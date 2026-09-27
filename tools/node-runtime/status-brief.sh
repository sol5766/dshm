#!/usr/bin/env bash
# 只报告三件事：构建是否还在跑、产物是否出现、日志最后两行的前 120 字符。
# ASCII only；输出刻意极小，避免把整条编译命令行刷进日志。
SRC="${HOME}/ohos/node-v22.23.2"
LOG="${HOME}/ohos/build-node.log"

echo "--- runners ---"
if pgrep -f 'make' > /dev/null 2>&1; then echo "make RUNNING"; else echo "make IDLE"; fi
if pgrep -f 'build-node-ohos' > /dev/null 2>&1; then echo "script RUNNING"; else echo "script IDLE"; fi

echo "--- artifacts ---"
found=0
for f in "${SRC}/out/Release/libnode.so" "${SRC}/out/Release/libnode.so.127" "${SRC}/out/Release/node"; do
  if [ -e "$f" ]; then
    echo "PRESENT $(stat -c%s "$f") $f"
    found=1
  fi
done
if [ "$found" = "0" ]; then
  echo "none"
  echo "so candidates:"; ls -1 "${SRC}/out/Release/" 2>/dev/null | grep -i 'libnode\|^node$' || echo "  (no libnode/node names in out/Release)"
fi

echo "--- object progress (host vs target) ---"
if [ -d "${SRC}/out/Release" ]; then
  h=$(find "${SRC}/out/Release/obj.host" -name '*.o' 2>/dev/null | wc -l)
  t=$(find "${SRC}/out/Release/obj.target" -name '*.o' 2>/dev/null | wc -l)
  echo "obj.host   .o files: ${h}"
  echo "obj.target .o files: ${t}"
  echo "host subtrees present:"
  ls -1 "${SRC}/out/Release/obj.host" 2>/dev/null | head -20 | sed 's/^/  /'
else
  echo "(no out/Release yet)"
fi

echo "--- progress counter (distinguishes 'slow' from 'stuck') ---"
# 对象计数会在编大文件时**连续两轮不变**，看起来像卡死。真正能区分的是：
#   日志的 mtime 距今多久 + 累计的编译器调用次数（单调递增）。
# 实测：obj.host 停在 870 时，日志 mtime 仅距今 2 秒、turboshaft 的 .o 每分钟都在产出
# ⇒ 是"慢"，不是"卡"。只看对象计数会误判。
if [ -f "${LOG}" ]; then
  now=$(date +%s)
  m=$(stat -c %Y "${LOG}" 2>/dev/null || echo 0)
  echo "log age: $((now - m))s (small = actively compiling)"
  echo "compiler invocations so far: $(grep -c g++ "${LOG}" 2>/dev/null)"
else
  echo "(no log yet)"
fi

echo "--- log tail (truncated) ---"
tail -n 2 "${LOG}" 2>/dev/null | cut -c1-120
