import hashlib
import io
import json
import pathlib
import re
import subprocess
import tempfile
import zipfile
import sys
import os

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / os.environ.get('DSHM_EVIDENCE_DIR', 'dist/acceptance/fix-review-dual-release')
BATCH = ROOT / os.environ.get('DSHM_BETA_BATCH', 'dist/beta/DSHM-beta-1.1.8-1010016-20261113T074043')
AGC = ROOT / os.environ.get('DSHM_AGC_APP', 'dist/release-test/dshm-1.1.8-1010016-dshm.1-AGC-invite-20261113T075635.app')
TOOL = '/data/service/hnp/hmos-clt.org/hmos-clt_1.0.0/sdk/default/openharmony/toolchains/lib/hap-sign-tool'
sha = lambda b: hashlib.sha256(b).hexdigest()
report = {'artifacts': [], 'signatures': [], 'checks': {}}
suffix = sys.argv[1] if len(sys.argv) > 1 else ''
assert re.fullmatch(r'[a-z0-9-]*', suffix)
version = json.loads((ROOT / 'hostcore/core-recipe.json').read_text())['coreVersion']
core = ROOT / f'hostruntime/src/main/resources/resfile/dsh-core-{version}-openharmony-arm64.zip'
core_sha = sha(core.read_bytes())
assert core_sha == os.environ.get('DSHM_CORE_SHA', '3e4c5e3849eaf1c41afa1d43e927ebdbe3fe2e88d03e447c29b174d05bb83e4d')
assert AGC.with_suffix('.app.sha256').read_text().split()[0] == sha(AGC.read_bytes())
scratch = pathlib.Path(tempfile.mkdtemp(prefix='phase5-signatures-', dir='/data/storage/el2/base/files/tmp/deveco'))
scratch.chmod(0o700)
files = [BATCH / 'DSHM-beta-1.1.8-1010016-combined-debug.app',
         BATCH / 'tablet/DSHM-1.1.8-beta-entry-debug.hap',
         BATCH / 'phone/DSHM-1.1.8-beta-phone-debug.hap',
         BATCH / 'tablet/DSHM-1.1.8-beta-hostruntime-debug.hsp', AGC]
for i, file in enumerate(files):
    report['artifacts'].append({'path': str(file.relative_to(ROOT)), 'bytes': file.stat().st_size, 'sha256': sha(file.read_bytes())})
    profile = scratch / f'{i}.p7b'
    cert = scratch / f'{i}.cer'
    decoded = scratch / f'{i}.json'
    with (OUT / f'signature-{i}{suffix}.txt').open('x') as log:
        result = subprocess.run([TOOL, 'verify-app', '-inFile', str(file), '-outCertChain', str(cert), '-outProfile', str(profile)], stdout=log, stderr=subprocess.STDOUT)
    assert result.returncode == 0
    with (OUT / f'profile-{i}{suffix}.txt').open('x') as log:
        result = subprocess.run([TOOL, 'verify-profile', '-inFile', str(profile), '-outFile', str(decoded)], stdout=log, stderr=subprocess.STDOUT)
    assert result.returncode == 0
    provision = json.loads(decoded.read_text())
    bundle = 'com.dshm.dshclient' if file == AGC else 'com.dshm.dshmbeta'
    assert provision['bundle-info']['bundle-name'] == bundle
    assert provision['type'] == ('release' if file == AGC else 'debug')
    acls = provision.get('acls', {}).get('allowed-acls', [])
    report['signatures'].append({'path': str(file.relative_to(ROOT)), 'verify_app_exit': 0, 'verify_profile_exit': 0, 'type': provision['type'], 'bundle': bundle, 'distribution': provision.get('app-distribution-type'), 'acls': acls, 'certificate_sha256': sha(cert.read_bytes()), 'profile_sha256': sha(profile.read_bytes())})

with zipfile.ZipFile(AGC) as app:
    assert app.testzip() is None
    summary = json.loads(app.read('pack.info'))['summary']
    assert summary['app']['bundleName'] == 'com.dshm.dshclient'
    assert summary['app']['version'] == {'code': 1010016, 'name': '1.1.8'}
    report['agc_pack'] = summary
    modules = {}
    for member in app.namelist():
        if not member.endswith(('.hap', '.hsp')):
            continue
        with zipfile.ZipFile(io.BytesIO(app.read(member))) as z:
            assert z.testzip() is None
            data = json.loads(z.read('module.json'))
            name = data['module']['name']
            assert name not in modules
            modules[name] = True
            assert data['app']['bundleName'] == 'com.dshm.dshclient'
            assert data['app']['versionCode'] == 1010016 and data['app']['versionName'] == '1.1.8'
            assert data['app']['buildMode'] == 'release' and data['app']['debug'] is False
            assert data['module']['deviceTypes'] == {'entry': ['tablet', '2in1'], 'phone': ['phone'], 'hostruntime': ['phone', 'tablet', '2in1']}[name]
            if name in ('entry', 'phone'):
                src = (ROOT / name / 'src/main/module.json5').read_text()
                perms = data['module']['requestPermissions']
                expected = re.findall(r'"name"\s*:\s*"(ohos\.permission\.[^"]+)"', src)
                assert [p['name'] for p in perms] == expected
                assert len(perms) == (18 if name == 'entry' else 9)
                for p in perms:
                    block = re.search(r'"name"\s*:\s*"' + re.escape(p['name']) + r'"[^}]*\}', src).group()
                    reason = re.search(r'"reason"\s*:\s*"([^"]+)"', block)
                    assert p.get('reason') == (reason.group(1) if reason else None)
                assert all('"' + p['reason'] + '"' in src for p in perms if 'reason' in p)
                assert any(n.endswith('OSS-NOTICES.json') for n in z.namelist())
                assert b'com.dshm.dshclient' in z.read('ets/modules.abc')
            else:
                cores = [n for n in z.namelist() if re.search(r'dsh-core-.*\.zip$', n)]
                assert len(cores) == 1 and sha(z.read(cores[0])) == core_sha
                resources = []
                for n in z.namelist():
                    if n.startswith('resources/resfile/resources/app/') and not n.endswith('/'):
                        source = ROOT / 'hostruntime/src/main' / n
                        assert source.exists() and z.read(n) == source.read_bytes(), n
                        resources.append({'member': n, 'sha256': sha(z.read(n))})
                report['agc_host_resources'] = resources
    assert set(modules) == {'entry', 'phone', 'hostruntime'}
report['checks'] = {'agc_crc_identity_modes_devices_permissions_reasons_oss_abc': True, 'core_sha256': core_sha, 'agc_source_resources_equal': True, 'independent_signatures': True}
(OUT / f'dual-package-audit{suffix}.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(report, ensure_ascii=False, indent=2))
