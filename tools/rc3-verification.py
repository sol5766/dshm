import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'dist/acceptance/dsh-rc3-sync-dual'


def snapshot():
    text = (ROOT / 'tools/build-beta.mjs').read_text()
    block = text.split('const TEXT_EDITS = [', 1)[1].split('];', 1)[0]
    paths = set(re.findall(r"'([^']+)'", block))
    paths.update(['phone/src/main/module.json5', 'build-profile.json5'])
    for directory in ['signing', '.certs', 'AGC-operations/release-signing']:
        base = ROOT / directory
        if base.exists():
            paths.update(str(p.relative_to(ROOT)) for p in base.rglob('*') if p.is_file())
    return {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in sorted(paths)}


mode = sys.argv[1]
if mode == 'snapshot':
    with (OUT / (sys.argv[2] + '.json')).open('x') as stream:
        json.dump(snapshot(), stream, indent=2)
elif mode == 'compare':
    expected = json.loads((OUT / (sys.argv[2] + '.json')).read_text())
    actual = snapshot()
    changed = [p for p in expected if expected[p] != actual.get(p)]
    print('Original byte comparison:', len(expected), 'files; changed:', changed)
    assert expected == actual
elif mode == 'run':
    guarded = any(x in sys.argv for x in ['tools/build-beta.mjs', 'tools/build-agc.mjs'])
    originals = {}
    if guarded:
        expected = json.loads((OUT / 'prebuild-original.json').read_text())
        assert snapshot() == expected
        originals = {p: (ROOT / p).read_bytes() for p in expected}
        safe = pathlib.Path(tempfile.mkdtemp(prefix='rc3-config-', dir='/data/storage/el2/base/files/tmp/deveco'))
        safe.chmod(0o700)
        for i, (p, b) in enumerate(originals.items()):
            target = safe / str(i)
            target.write_bytes(b)
            target.chmod(0o600)
        (safe / 'paths.json').write_text(json.dumps(list(originals)))
        (safe / 'paths.json').chmod(0o600)
        print('Private original bytes preserved; files:', len(originals), flush=True)
    try:
        with (OUT / sys.argv[2]).open('x') as log:
            result = subprocess.run(sys.argv[3:], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
            log.write('\nCOMMAND_EXIT=' + str(result.returncode) + '\n')
    finally:
        if guarded:
            changed = [p for p, b in originals.items() if (ROOT / p).read_bytes() != b]
            for p in changed:
                (ROOT / p).write_bytes(originals[p])
            assert snapshot() == expected
            print('Build finally restored originals; fallback files:', changed, flush=True)
    print('Command exit:', result.returncode, 'Log:', sys.argv[2], flush=True)
    sys.exit(result.returncode)
