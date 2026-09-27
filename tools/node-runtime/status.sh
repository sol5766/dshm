#!/usr/bin/env bash
# 查看 WSL 侧「自建 Node 运行时」的进展。
# 输出保持 ASCII：本仓库被 PowerShell 的 ANSI/UTF-8 往返坑过，脚本输出用 ASCII 以免日志乱码。
ROOT="${HOME}/ohos"
echo "=== processes ==="
pgrep -af 'build-node-ohos|fetch-ohos-sdk|curl -fsSL|configure|make -j' | head -10 || echo none
echo
echo "=== sdk ==="
if [ -d "${ROOT}/sdk" ]; then ls -1 "${ROOT}/sdk"; else echo "sdk not extracted"; fi
echo
echo "=== node source ==="
ls -d "${ROOT}"/node-v* 2>/dev/null || echo "no source yet"
echo
echo "=== build log tail ==="
tail -n 12 "${ROOT}/build-node.log" 2>/dev/null || echo "no log yet"
echo
echo "=== artifacts ==="
ls -la "${ROOT}"/node-v*/out/Release/libnode.so* "${ROOT}"/node-v*/out/Release/node 2>/dev/null || echo "no artifacts yet"
echo
echo "=== out/Release listing (if any) ==="
ls -1 "${ROOT}"/node-v*/out/Release 2>/dev/null | head -20 || true
