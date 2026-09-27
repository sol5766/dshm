"""
在本地 node 上复现报告 9 的四个缺陷。

【为什么本地复现是有效证据】
  · 四个缺陷都是**纯 JS 逻辑问题**，与设备无关
  · 部署一致性可验证：resfile 的 fetch-shim.js 与 hostcore 源码逐字节相同
    （assert-resfile-sync 覆盖），且它被原样打包进 HAP
  · 本地 node 版本需与设备一致（设备是 v24.2.0）才能触发生成原生 Headers 的条件

【判据】每条都给出"期望 vs 实际"，失败的即为确认缺陷。
"""
import subprocess
from pathlib import Path

ROOT = Path(r'D:\desktop\temp\desktop.ohos.arm64')
SHIM = ROOT / 'hostcore' / 'app' / 'fetch-shim.js'
NODE = r'C:\Program Files\Huawei\DevEco Studio\tools\node\node.exe'

print(f'垫片: {SHIM}')
print(f'node: {NODE}')
ver = subprocess.run([NODE, '--version'], capture_output=True, text=True).stdout.strip()
print(f'版本: {ver}（设备是 v24.2.0）')
print()

# ── 用例 1：原生 Headers 传进 DshmHeaders ────────────────────────────────
probe1 = r'''
const path = process.argv[2];
const shim = require(path);
// 垫片把类挂在导出上吗？先看导出
const keys = Object.keys(shim);
const DshmHeaders = shim.DshmHeaders || (shim.default && shim.default.DshmHeaders);
if (!DshmHeaders) {
  console.log('EXPORT_KEYS=' + JSON.stringify(keys));
  process.exit(2);
}
const native = new Headers({ authorization: 'Bearer k', 'content-type': 'application/json' });
const h = new DshmHeaders(native);
console.log(JSON.stringify({
  authz: h.get('authorization'),
  ctype: h.get('content-type'),
  hasAuth: h.has('authorization'),
}));
'''

tmp = ROOT / 'dist' / '_r9_probe1.js'
tmp.write_text(probe1, encoding='utf-8')
r = subprocess.run([NODE, str(tmp), str(SHIM)], capture_output=True, text=True)
print('=== 缺陷1：DshmHeaders(new Headers({authorization, content-type})) ===')
print(f'  stdout: {r.stdout.strip()}')
if r.stderr.strip():
    print(f'  stderr: {r.stderr.strip()[:300]}')
print('  期望: authz="Bearer k", ctype="application/json", hasAuth=true')
print('  判据: 若 authz 为 null ⇒ 缺陷1 成立（请求头全丢）')
tmp.unlink(missing_ok=True)
