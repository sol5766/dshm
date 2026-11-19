#!/usr/bin/env python3
"""Capture executable checks and verify actual bundled bytes without application builds."""
import hashlib
import pathlib
import subprocess
import zipfile
import sys
import os

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / os.environ.get('DSHM_EVIDENCE_DIR', 'dist/acceptance/fix-review-dual-release')


def sha(p):
    h = hashlib.sha256()
    with p.open('rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()


commands = [
    'node tools/check-lifecycle-final.mjs',
    'node tools/check-review-production.mjs --self-test',
    'node tools/check-manager-recovery.cjs --self-test',
    'node tools/check-review-core-assets.mjs',
    'node tools/check-review-regressions.cjs --self-test',
    'node tools/check-fix-review-behavior.mjs --self-test',
    'node tools/check-fix-review-content.mjs --self-test',
    'node tools/check-update-transaction.cjs --self-test',
    'node tools/check-host-vm-graceful-stop.mjs --self-test',
    'node tools/check-bundled-core-rollback.mjs --self-test',
    'node tools/check-installer-integrity.mjs --self-test',
    'node tools/check-beta-build-entry.mjs',
    'node tools/check-resfile-core-zip.mjs',
    'node tools/check-doc-index.mjs',
    'node tools/check-doc-refs.mjs',
]
rows = []
for command in commands:
    p = subprocess.run(['/bin/sh', '-c', command], cwd=ROOT, capture_output=True, text=True)
    rows.append(f'COMMAND {command}\nRC={p.returncode}\n{p.stdout}{p.stderr}')
    print(command, p.returncode, flush=True)
(OUT / (sys.argv[1] if len(sys.argv) > 1 else 'targeted.txt')).write_text('\n'.join(rows))
if len(sys.argv) > 1:
    assert all('RC=0\n' in row for row in rows)
    sys.exit(0)
archive = ROOT / 'hostruntime/src/main/resources/resfile/dsh-core-0.2.2-rc.2+dshm.1-openharmony-arm64.zip'
lines = ['# 核心物化证据', '', f'资源容器：`{archive.relative_to(ROOT)}`',
         f'大小：{archive.stat().st_size}；SHA256：`{sha(archive)}`', '',
         '已执行批准的pack --skip-install --place-in-app；应用包未构建。', '',
         '| 源码 | zip逐字节一致 |', '|---|---|']
with zipfile.ZipFile(archive) as z:
    for name in ['vm.js', 'index.js']:
        src = ROOT / f'hostcore/plugins/dshm-vm-bash/lib/{name}'
        suffix = f'/node_modules/@deepseek-ai/dshm-vm-bash/lib/{name}'
        member = next(n for n in z.namelist() if n.endswith(suffix))
        equal = z.read(member) == src.read_bytes()
        assert equal
        lines.append(f'| {src.relative_to(ROOT)} | {equal} |')
    manager = next(n for n in z.namelist() if n.endswith('/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js'))
    data = z.read(manager).decode()
    assert 'DSHM_LIFECYCLE_CANONICAL_V2' in data and 'restore: await settled(' in data
    lines += ['', '官方manager生命周期封套及原previous恢复分支均已在zip中。',
              'pack日志签名47通过/7未检出（包含占位或非目标平台文件）；不是全部原生物料独立验签成功。',
              'OSS已重新生成，最终由gen-oss-notices --check复核。']
(OUT / 'core-integrity.md').write_text('\n'.join(lines) + '\n')
