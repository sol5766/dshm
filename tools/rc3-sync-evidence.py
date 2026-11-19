import hashlib
import io
import json
import pathlib
import re
import subprocess
import tarfile
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'dist/acceptance/dsh-rc3-sync-dual'
sha = lambda b: hashlib.sha256(b).hexdigest()
report = {}
packages = {
    'dsh-experimental-terminal-bundle': 'cordis.patch.yml',
    'dsh-fs-local': 'lib/index.js',
    'dsh-client-resources': 'lib/client.js',
    'dsh-client-ui-sidebar-right': 'lib/client.js',
    'dsh-client-ui-subagent': 'lib/client.js',
    'dsh-client-ui-sidebar-terminal': 'lib/client.terminal.js',
    'dsh-plugin-manager': 'lib/index.js',
}
for package, member in packages.items():
    rows = []
    for version in ['0.2.2-rc.2', '0.2.2-rc.3']:
        url = f'https://registry.npmjs.org/@deepseek-ai/{package}/-/{package}-{version}.tgz'
        data = urllib.request.urlopen(url, timeout=60).read()
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            names = archive.getnames()
            name = next((n for n in names if n == 'package/' + member), None)
            if name is None and package == 'dsh-terminal-bundle':
                name = next(n for n in names if n.endswith('cordis.yml'))
            content = archive.extractfile(name).read()
        (OUT / f'upstream-{package}-{version}.txt').write_bytes(content)
        rows.append({'version': version, 'url': url, 'tarball_sha256': sha(data), 'member': name, 'member_sha256': sha(content)})
    report[package] = {'sources': rows, 'same_upstream_bytes': rows[0]['member_sha256'] == rows[1]['member_sha256']}
old = json.loads((OUT / 'contracts-rc2-current-extractor.json').read_text())
new = json.loads((ROOT / '.research/protocol/contracts-0.2.2-rc.3.json').read_text())
report['contracts'] = {'old_count': len(old), 'new_count': len(new), 'equal': old == new,
                       'added': [row for row in new if row not in old],
                       'removed': [row for row in old if row not in new]}
recipe = json.loads((ROOT / 'hostcore/core-recipe.json').read_text())
version = recipe['coreVersion']
stage = ROOT / f'dist/core/work/dsh-core-{version}'
lock = json.loads((stage / 'package-lock.json').read_text())
report['installed_dsh'] = lock['packages']['node_modules/@deepseek-ai/dsh']
report['lock_sha256'] = sha((stage / 'package-lock.json').read_bytes())
core = ROOT / f'dist/core/dsh-core-{version}-openharmony-arm64.zip'
report['core'] = {'path': str(core.relative_to(ROOT)), 'bytes': core.stat().st_size, 'sha256': sha(core.read_bytes())}
with zipfile.ZipFile(core) as archive:
    names = archive.namelist()
    plugins = []
    for source in sorted((ROOT / 'hostcore/plugins').glob('*/package.json')):
        package = json.loads(source.read_text())
        suffix = '/node_modules/' + package['name'] + '/package.json'
        member = next(n for n in names if n.endswith(suffix))
        assert archive.read(member) == source.read_bytes()
        plugins.append(package['name'])
    assert len(plugins) == len(list((ROOT / 'hostcore/plugins').glob('*/package.json')))
    manager = next(n for n in names if n.endswith('/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js'))
    text = archive.read(manager).decode()
    assert 'DSHM_LIFECYCLE_CANONICAL_V2' in text and 'restore: await settled(' in text
    report['plugins'] = plugins
    report['manager_canonical_and_previous'] = True
for phase in ['before', 'postpackage']:
    gates = (OUT / f'{phase}-gates.txt').read_text()
    rows = re.findall(r'^(OK|BAD)\s+rc=(\d+)\s+[\d.]+s\s+(.*?)\s+\|', gates, re.M)
    assert len(rows) == 113 and all(row[0] == 'OK' for row in rows)
    report[phase + '_commands'] = [row[2] for row in rows]
    ci = (OUT / f'{phase}-ci.txt').read_text()
    statuses = re.findall(r'^RC=(\d+)$', ci, re.M)
    assert len(statuses) == 22 and set(statuses) == {'0'}
    targeted = re.findall(r'^RC=(\d+)$', (OUT / f'{phase}-targeted.txt').read_text(), re.M)
    assert len(targeted) == 15 and set(targeted) == {'0'}
assert report['before_commands'] == report['postpackage_commands']
report['ok_to_bad'] = 0
(OUT / 'sync-evidence.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({k: v for k, v in report.items() if not k.endswith('_commands')}, ensure_ascii=False, indent=2))
