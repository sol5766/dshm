import hashlib
import io
import json
import pathlib
import tarfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'dist/acceptance/dsh-rc4-sync'
OUT.mkdir(parents=True, exist_ok=True)
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
    for version in ['0.2.2-rc.3', '0.2.2-rc.4']:
        url = f'https://registry.npmjs.org/@deepseek-ai/{package}/-/{package}-{version}.tgz'
        data = urllib.request.urlopen(url, timeout=60).read()
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            names = archive.getnames()
            name = next((n for n in names if n == 'package/' + member), None)
            if name is None:
                name = next((n for n in names if n.endswith(member)), None)
            if name is None:
                raise SystemExit(f'{package}@{version}: member {member} not found; members={names[:5]}...')
            content = archive.extractfile(name).read()
        (OUT / f'upstream-{package}-{version}.txt').write_bytes(content)
        rows.append({'version': version, 'url': url, 'tarball_sha256': sha(data), 'member': name, 'member_sha256': sha(content)})
    report[package] = {'sources': rows, 'same_upstream_bytes': rows[0]['member_sha256'] == rows[1]['member_sha256']}

# 主包 dsh：依赖面 diff + 包内关键文件清单 diff
main_rows = []
for version in ['0.2.2-rc.3', '0.2.2-rc.4']:
    url = f'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-{version}.tgz'
    data = urllib.request.urlopen(url, timeout=120).read()
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        pkg = json.loads(archive.extractfile('package/package.json').read())
        names = sorted(archive.getnames())
    main_rows.append({'version': version, 'tarball_sha256': sha(data),
                      'dependencies': pkg.get('dependencies', {}),
                      'file_count': len(names)})
report['dsh-main'] = {
    'sources': [{k: r[k] for k in ('version', 'tarball_sha256', 'file_count')} for r in main_rows],
    'deps_added': {k: v for k, v in main_rows[1]['dependencies'].items() if main_rows[0]['dependencies'].get(k) != v},
    'deps_removed': {k: main_rows[0]['dependencies'][k] for k in main_rows[0]['dependencies'] if k not in main_rows[1]['dependencies']},
}
(OUT / 'upstream-dsh-main-0.2.2-rc.3.filelist.txt').write_text('\n'.join(
    n for n in tarfile.open(fileobj=io.BytesIO(urllib.request.urlopen(
        'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.2-rc.3.tgz', timeout=120).read()), mode='r:gz').getnames()))
(OUT / 'upstream-dsh-main-0.2.2-rc.4.filelist.txt').write_text('\n'.join(
    n for n in tarfile.open(fileobj=io.BytesIO(urllib.request.urlopen(
        'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.2-rc.4.tgz', timeout=120).read()), mode='r:gz').getnames()))
(OUT / 'upstream-evidence.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(report, ensure_ascii=False, indent=2))
