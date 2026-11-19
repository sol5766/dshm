#!/usr/bin/env python3
"""Phase-5 evidence: byte-preservation snapshots and logged command execution."""
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'dist/acceptance/fix-review-dual-release'

def snapshot():
    text = (ROOT / 'tools/build-beta.mjs').read_text()
    block = text.split('const TEXT_EDITS = [', 1)[1].split('];', 1)[0]
    paths = set(re.findall(r"'([^']+)'", block))
    paths.add('phone/src/main/module.json5')
    for directory in ['signing', '.certs', 'AGC-operations/release-signing']:
        base = ROOT / directory
        if base.exists():
            paths.update(str(p.relative_to(ROOT)) for p in base.rglob('*') if p.is_file())
    return {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in sorted(paths)}

mode = sys.argv[1]
if mode == 'snapshot':
    target = OUT / (sys.argv[2] + '.json')
    assert not target.exists(), 'refuse overwrite evidence'
    target.write_text(json.dumps(snapshot(), indent=2) + '\n')
    print('Snapshot saved:', target)
elif mode == 'compare':
    expected = json.loads((OUT / (sys.argv[2] + '.json')).read_text())
    actual = snapshot()
    changed = [p for p in expected if expected[p] != actual.get(p)]
    print('Byte hash comparison:', len(expected), 'files; changed:', changed)
    assert not changed
elif mode == 'restore-verified-backup':
    expected = json.loads((OUT / 'phase5-original.json').read_text())
    backup = pathlib.Path(sys.argv[2]).resolve()
    assert backup.parent == pathlib.Path('/data/storage/el2/base/files/tmp/deveco')
    originals = {p: (backup / str(i)).read_bytes() for i, p in enumerate(expected)}
    assert all(hashlib.sha256(b).hexdigest() == expected[p] for p, b in originals.items())
    changed = [p for p, b in originals.items() if (ROOT / p).read_bytes() != b]
    assert changed == ['build-profile.json5'], 'refuse unexpected restoration scope'
    (ROOT / changed[0]).write_bytes(originals[changed[0]])
    assert snapshot() == expected
    print('Verified original backup restored:', changed, '; all', len(expected), 'hashes match')
elif mode == 'run':
    target = OUT / sys.argv[2]
    assert not target.exists(), 'refuse overwrite evidence'
    guarded = 'tools/build-beta.mjs' in sys.argv or 'tools/build-agc.mjs' in sys.argv
    originals = {}
    if guarded:
        hashes = json.loads((OUT/'phase5-original.json').read_text())
        originals = {p:(ROOT/p).read_bytes() for p in hashes}
        assert all(hashlib.sha256(b).hexdigest() == hashes[p] for p,b in originals.items())
        safe = pathlib.Path(tempfile.mkdtemp(prefix='phase5-config-', dir='/data/storage/el2/base/files/tmp/deveco'))
        safe.chmod(0o700)
        for i,(p,b) in enumerate(originals.items()):
            f = safe/str(i)
            f.write_bytes(b)
            f.chmod(0o600)
        print('Private original byte preservation prepared', flush=True)
    try:
        with target.open('w') as log:
            result = subprocess.run(sys.argv[3:], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
            log.write('\nCOMMAND_EXIT=' + str(result.returncode) + '\n')
    finally:
        if guarded:
            changed = [p for p,b in originals.items() if (ROOT/p).read_bytes() != b]
            for p in changed: (ROOT/p).write_bytes(originals[p])
            assert all((ROOT/p).read_bytes() == b for p,b in originals.items())
            print('Original buffers restored; fallback count:',len(changed),flush=True)
    print('Command exit:', result.returncode, 'Log:', target)
    sys.exit(result.returncode)
