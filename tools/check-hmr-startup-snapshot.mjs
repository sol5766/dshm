import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join as nativeJoin, posix, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { startupSnapshotSource } from './lib/hmr-startup-snapshot.mjs';

const arg = process.argv.indexOf('--stage');
if (arg === -1 || !process.argv[arg + 1]) throw new Error('Use --stage <packed core tree>');
const { basename, dirname, join, relative, sep } = posix;
const root = resolve(process.argv[arg + 1], 'node_modules/@deepseek-ai');
const originalApp = readFileSync(nativeJoin(root, 'dsh-app-boot/lib/index.js'), 'utf8');
const originalHmr = readFileSync(nativeJoin(root, 'dsh-hmr/lib/index.js'), 'utf8');
const app = startupSnapshotSource(originalApp, 'app');
const hmr = startupSnapshotSource(originalHmr, 'hmr');
assert.equal(app, originalApp, 'packed app boot is missing the startup snapshot');
assert.equal(hmr, originalHmr, 'packed HMR is missing the startup snapshot guard');
assert.equal(startupSnapshotSource(startupSnapshotSource(app, 'app', false), 'app'), app);
assert.equal(startupSnapshotSource(hmr, 'hmr'), hmr);

function between(source, begin, end) {
  const a = source.indexOf(begin), b = source.indexOf(end, a + begin.length);
  assert(a >= 0 && b > a, 'test anchor missing: ' + begin);
  return source.slice(a, b);
}

const coreDir = '/signed/core', profileDir = '/local/profiles/ondevice', home = '/local';
const manifestName = profileDir + '/package.json';
const patchName = profileDir + '/cordis.patch.yml', homePatchName = home + '/cordis.patch.yml';
const manifest = ' { "dsh": {"profile":{"bundles":["base"]}} }\n';
const initialPatch = ' [ ] \n';
const files = new Map([[manifestName, manifest], [patchName, initialPatch]]);
const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
const read = path => {
  if (!files.has(path)) throw missing();
  return files.get(path);
};
const env = { DSHM_WORKBENCH_STARTUP: '1', DSHM_CORE_DIR: coreDir };
const resolution = () => ({
  localPackageNames: [], linkedRoots: [],
  entries: [{ scope: 'installation', packageDir: coreDir + '/node_modules/base' }],
});

const profileApi = runInNewContext([
  between(app, 'function readProfileManifest(', '\n/**\n* Write a profile'),
  between(app, 'function loadProfileDirectory(', '\n/**\n* Load a profile:'),
  between(app, 'function readProfilePatches(', '\n//#endregion'),
  between(app, 'function loadOptionalPatches(', '\n/** Convert inserted'),
  '({ readProfileManifest, loadProfileDirectory, readProfilePatches })',
].join('\n'), {
  readFileSync: read, existsSync: path => files.has(path), basename, join, process: { env },
  PROFILE_PATCH_FILENAME: 'cordis.patch.yml',
  dropRetiredBundles: (_dir, data) => data,
  readProfileVersionExemptions: () => ({}),
  evaluatePluginCompatibility: () => undefined,
  assertBundlePlatform() {},
  resolveBundleDir: () => '/signed/base',
  bundlePatchPaths: () => [],
  parsePatchList: (_bin, _file, contents) => JSON.parse(contents),
  readBundlePatches: (_bin, _context, initial) => initial.layers.flatMap(layer => layer.patches),
  resolveTelemetryPatch: () => undefined, composeEntries: () => [], structuredClone,
});
files.set('/signed/base/package.json', '{"dsh":{"bundle":{}}}');
const load = (opts = {}) => profileApi.loadProfileDirectory('dsh', profileDir, coreDir + '/package.json', opts);
function startupContext(overlayPaths = []) {
  const loaded = load();
  const profile = {
    startedBundles: loaded.layers.map(x => x.packageName),
    dir: profileDir, patchPath: patchName, home, overlayPaths,
  };
  profileApi.readProfilePatches('dsh', profile, loaded);
  return profile;
}
const context = startupContext();
assert.deepEqual({ ...context.dshmStartupSnapshot }, { manifest, profilePatch: initialPatch, homePatch: null });
const overlay = home + '/extra.yml';
files.set(overlay, '[]');
assert.equal(startupContext([overlay]).dshmStartupSnapshot, undefined);
files.delete(overlay);
assert.equal(load({ userLayer: false }).dshmStartupSnapshot, undefined);
env.DSHM_HMR_STARTUP_SNAPSHOT = '0';
assert.equal(startupContext().dshmStartupSnapshot, undefined);
delete env.DSHM_HMR_STARTUP_SNAPSHOT;

async function checkRefresh(source) {
  const create = runInNewContext([
    between(source, 'function canReuseStartupConfig(', '\nasync function findWatchRoot'),
    'function build(profile, patchFiles) {',
    between(source, '\t\t\t\tlet lastInputs;', '\t\t\t\tfor (const filename of patchFiles)'),
    'return refresh; }',
    'build',
  ].join('\n'), {
    existsSync: path => files.has(path), join, dirname, process: { env }, readFileSync: read,
    readProfileManifest: profileApi.readProfileManifest,
  });
  const profile = startupContext();
  let result = resolution(), calls = 0;
  const createRefresh = () => create.call({
    ownerContext: { get: () => ({ resolution: result }) },
    reconcileProfile: async () => { calls++; return { warnings: [], pending: [] }; },
  }, profile, [patchName, homePatchName]);
  try {
    const refresh = createRefresh();
    await refresh(false, true);
    assert.equal(calls, 0, 'default synthetic startup event may reuse the exact boot inputs');
    files.set(homePatchName, '[]');
    await refresh(false, true);
    assert.equal(calls, 1, 'new file written during startup must reload');
    files.delete(homePatchName);
    await refresh(false, true);
    assert.equal(calls, 2, 'reverting real config to startup bytes must reload');
    calls = 0;
    await createRefresh()(false, false);
    assert.equal(calls, 1, 'ordinary events must preserve original first reconciliation');
    calls = 0;
    files.set(manifestName, manifest + ' ');
    await createRefresh()(false, true);
    assert.equal(calls, 1, 'manifest edits require reconciliation even with identical bundle names');
    files.set(manifestName, manifest);
    calls = 0;
    files.set(patchName, initialPatch + ' ');
    await createRefresh()(false, true);
    assert.equal(calls, 1, 'profile patch writes during scan require reconciliation');
    files.set(patchName, initialPatch);
    for (const scope of [
      { ...resolution(), localPackageNames: ['custom'] },
      { ...resolution(), linkedRoots: [{ realPath: '/mutable/custom' }] },
      { ...resolution(), entries: [{ scope: 'installation', packageDir: '/mutable/custom' }] },
      undefined,
    ]) {
      result = scope; calls = 0;
      await createRefresh()(false, true);
      assert.equal(calls, 1, 'unproven or mutable module resolution retains startup reconciliation');
    }
    result = resolution(); calls = 0;
    files.set(profileDir + '/node_modules', '');
    await createRefresh()(false, true);
    assert.equal(calls, 1, 'local npm tree retains startup reconciliation');
  } finally {
    files.delete(homePatchName);
    files.delete(profileDir + '/node_modules');
    files.set(manifestName, manifest);
    files.set(patchName, initialPatch);
  }
}

async function checkWatcher(source, trackInitial) {
  const watcher = new EventEmitter();
  watcher.close = async () => {};
  const watchConfig = runInNewContext(between(source,
    'const registrations =', '\n//#endregion') + '\nwatchConfig', {
    watch: () => watcher, stat: async () => ({ isDirectory: () => true }), realpath: async p => p,
    resolve: posix.resolve, dirname, relative, sep,
  });
  const calls = [];
  const turn = () => new Promise(resolve => setImmediate(resolve));
  const pending = watchConfig({ effect: callback => callback(), logger: { warn() {} } },
    patchName, {}, (...args) => calls.push(args), () => false, trackInitial);
  await turn();
  watcher.emit('add', patchName);
  watcher.emit('ready');
  const stop = await pending;
  await turn();
  watcher.emit('change', patchName, {});
  await turn();
  watcher.emit('unlink', patchName);
  await turn();
  watcher.emit('add', patchName);
  await turn();
  await stop();
  assert.deepEqual(calls, trackInitial ? [[true], [false], [false], [false]] : [[], [], [], []]);
}

await checkRefresh(hmr);
await checkWatcher(hmr, true);
await checkWatcher(hmr, false);
if (process.argv.includes('--self-test')) {
  await assert.rejects(() => checkRefresh(hmr.replace('const snapshot = initial ? startupSnapshot : undefined;',
    'const snapshot = startupSnapshot;')));
  await assert.rejects(() => checkRefresh(hmr.replace('snapshot.manifest === manifest && ', '')));
  await assert.rejects(() => checkRefresh(hmr.replace('startupSnapshot = undefined;', '')));
  await assert.rejects(() => checkWatcher(hmr.replace('onChange(path, pending)', 'onChange(path, true)'), true));
  assert.throws(() => startupSnapshotSource(startupSnapshotSource(app, 'app', false)
    .replace('function loadOverlayPatches(', 'function loadOverlayPatchesChanged('), 'app'));
}
console.log('PASS HMR startup snapshot, unchanged input reuse, concurrent writes, mutable profiles and live watcher events');
