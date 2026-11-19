import hashlib
import json
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'dist/acceptance/dsh-rc3-sync-dual'
version = json.loads((ROOT / 'hostcore/core-recipe.json').read_text())['coreVersion']
core = ROOT / f'dist/core/dsh-core-{version}-openharmony-arm64.zip'
sha = hashlib.sha256(core.read_bytes()).hexdigest()
batch = 'dist/beta/DSHM-beta-1.1.8-1010016-20261113T124121'
agc = 'dist/release-test/dshm-1.1.8-1010016-dshm.1-AGC-invite-20261113T124336.app'
env = dict(os.environ, DSHM_EVIDENCE_DIR=str(OUT.relative_to(ROOT)), DSHM_BETA_BATCH=batch, DSHM_AGC_APP=agc, DSHM_CORE_SHA=sha)
commands = [
    ['python3', 'dist/acceptance/rc2-beta-package-audit.py', batch, str(OUT.relative_to(ROOT) / 'beta-package-audit.json'), sha],
    ['python3', 'tools/fix-review-package-audit.py'],
]
for i, command in enumerate(commands):
    with (OUT / f'package-audit-{i}.txt').open('x') as log:
        result = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    print('Audit', i, 'exit', result.returncode, flush=True)
    if result.returncode:
        sys.exit(result.returncode)
