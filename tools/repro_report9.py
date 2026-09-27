"""
在设备上直接复现报告 9 的四个缺陷 —— 不看日志，直接测行为。

【为什么直接测】日志里的 401/412 是历史会话，未必可复现；而缺陷是**代码逻辑**问题，
可以在设备上用 node 直接构造最小用例验证：
  · 缺陷1：new DshmHeaders(nativeHeaders) 是否会丢头
  · 缺陷2：已知长度 body 是否设 content-length
  · 缺陷3：entryCandidates 对纯类型包是否误判
  · 缺陷4：profile patch 是否被种子覆盖

设备上有 node（宿主自带），可以用 DSHM_CORE_DIR 起一个最小脚本。
"""
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import dshtest as T

HDC = T.HDC
F = T.FILES

# 1) 先把设备上的 fetch-shim.js 拉下来看实际内容（确认与我们源码一致）
print('=== 0) 设备上的 fetch-shim.js（HAP 内，只读）===')
r = T.sh(f'ls -la /data/storage/el1/bundle/entry/resources/resfile/resources/app/fetch-shim.js')
print('  ', r)

# 2) 关键：在设备上直接跑 node 验证缺陷1
print()
print('=== 1) 缺陷1 复现：原生 Headers 传进 DshmHeaders ===')
# 用宿主的 node 二进制 + 直接 require 垫片
SHIM = '/data/storage/el1/bundle/entry/resources/resfile/resources/app/fetch-shim.js'
probe = (
    "const s=require('" + SHIM + "');"
    "globalThis.Headers = globalThis.Headers;"
    "console.log(JSON.stringify({"
    "hasNativeHeaders: typeof Headers,"
    "shimLoaded: Object.keys(s).slice(0,10)"
    "}));"
)
cmd = f'DSHM_CORE_DIR=/data/storage/el2/base/haps/entry/files/dsh/cores/0.1.7-rc.2 ' \
      f'/data/storage/el1/bundle/entry/resources/resfile/resources/app/../../../../../../libs/arm64/libnode.so 2>/dev/null || echo NO_NODE'
print('  设备自带 node 可执行位置需确认')
print('  ', T.sh('ls /data/storage/el1/bundle/entry/resources/resfile/resources/app/ | head -20')[:400])
