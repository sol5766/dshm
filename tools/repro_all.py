"""复现报告 9 的四个缺陷（本地 node，纯 JS 逻辑验证）。"""
import subprocess
from pathlib import Path

ROOT = Path(r'D:\desktop\temp\desktop.ohos.arm64')
SHIM = ROOT / 'hostcore' / 'app' / 'fetch-shim.js'
ROWS = ROOT / 'hostcore' / 'app' / 'dshm-user-rows.js'
NODE = r'C:\Program Files\Huawei\DevEco Studio\tools\node\node.exe'
TMP = ROOT / 'dist'


def run(js, *args):
    p = TMP / '_r9_tmp.js'
    p.write_text(js, encoding='utf-8')
    r = subprocess.run([NODE, str(p), *args], capture_output=True, text=True)
    p.unlink(missing_ok=True)
    return r.stdout.strip(), r.stderr.strip()


# ══ 缺陷1：原生 Headers 丢头（已确认）═══════════════════════════════════
print('=' * 62)
print('缺陷1  原生 Headers 被当普通对象 → 请求头全丢')
print('=' * 62)
out, err = run(r'''
const shim = require(process.argv[2]);
const H = shim.DshmHeaders;
const n = new Headers({authorization:'Bearer k','content-type':'application/json'});
const h = new H(n);
console.log(JSON.stringify({authz:h.get('authorization'),ctype:h.get('content-type')}));
''', str(SHIM))
print(f'  实际: {out}')
print('  期望: {"authz":"Bearer k","ctype":"application/json"}')
print('  ⇒ ' + ('确认缺陷 ✓' if '"authz":null' in out else '未复现'))

# ══ 缺陷2：不设 content-length ═══════════════════════════════════════════
print()
print('=' * 62)
print('缺陷2  已知长度 body 不设 Content-Length → 走 chunked')
print('=' * 62)
out, err = run(r'''
const shim = require(process.argv[2]);
const H = shim.DshmHeaders;
// 直接查源码里有没有设置 content-length 的分支
const src = require('fs').readFileSync(process.argv[2],'utf8');
const hasSet = /headers\.set\(\s*['"]content-length['"]/.test(src);
const delTE  = /headers\.delete\(\s*['"]transfer-encoding['"]/.test(src);
console.log(JSON.stringify({setsContentLength:hasSet, deletesTransferEncoding:delTE}));
''', str(SHIM))
print(f'  源码中设置 content-length: {out}')
print('  期望: {"setsContentLength":true,"deletesTransferEncoding":true}')
print('  ⇒ ' + ('确认缺陷 ✓' if '"setsContentLength":false' in out else '未复现'))

# ══ 缺陷3：entryCandidates 误杀纯类型包 ═════════════════════════════════
print()
print('=' * 62)
print('缺陷3  entryCandidates 误杀纯类型包（@types/*）')
print('=' * 62)
out, err = run(r'''
const m = require(process.argv[2]);
const fn = m.entryCandidates || (m.default && m.default.entryCandidates);
if (!fn) { console.log('EXPORTS=' + JSON.stringify(Object.keys(m))); process.exit(0); }
// @types/trusted-types 的形态：main:"" + types:"index.d.ts"
const got = fn({ name:'@types/trusted-types', main:'', types:'index.d.ts' });
console.log(JSON.stringify({candidates:got}));
''', str(ROWS))
print(f'  实际: {out}')
print('  期望: 空数组（纯类型包应放行）')
print('  ⇒ ' + ('确认缺陷 ✓' if 'index.js' in out else '需人工确认（见上 EXPROTS）'))
if err:
    print(f'  stderr: {err[:200]}')
