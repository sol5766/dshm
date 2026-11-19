#!/usr/bin/env node
// Real materialized manager methods with IO/package-manager boundaries injected.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { withUpdateTransaction } = require('../hostcore/app/dshm-update-transaction.cjs');
const { withProfileWriter, currentToken, assertQueueOwnership } = require('../hostcore/app/dshm-profile-writer.cjs');
let source = fs.readFileSync('dist/core/work/dsh-core-0.2.2-rc.2+dshm.1/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js', 'utf8');
if (process.argv.includes('--mutate-reconcile')) source = source.replace('reconcile: ids => this.configure(() => this.publishAndReload(ids))', 'reconcile: () => ({})');
function method(name, next) {
  const begin = source.indexOf('\n\t\t' + name);
  assert(begin >= 0, name);
  const end = source.indexOf(next, begin);
  assert(end > begin, next);
  return source.slice(begin, end).replace(/\s*\/\*\*[\s\S]*$/, '');
}
const update = method('async updateBundle(', '\n\t\t/**\n\t\t* The target of a Git');
const remove = method('removeBundle(', '\n\t\t/** The rows a bundle');
const root = fs.mkdtempSync('/data/storage/el2/base/files/tmp/deveco/manager-chain-');
async function main() {
  let count = 0;
  for (const scenario of ['check', 'remove-refused', 'dual-failure', 'enable-failure', 'official-restore', 'no-hmr']) {
    const profile = path.join(root, scenario);
    const dest = path.join(profile, 'node_modules/demo');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'old'), 'OLD');
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dependencies: { demo: '1.0.0' }, dsh: { profile: { bundles: ['demo'] } } }));
    const rows = '- id: different-entry\n  config:\n    secret: keep\n- id: unrelated\n  enabled: false\n';
    for (const name of ['.dshm-plugin-rows.yml', 'cordis.patch.yml']) fs.writeFileSync(path.join(profile, name), rows);
    let installs = 0, reloads = 0, removals = 0;
    const enabled = { value: true };
    class Failure extends Error {}
    const Manager = vm.runInNewContext('class Manager {' + update + remove + '\n}\nManager', {
      globalThis: { __dshmProfileWriter: withProfileWriter, __dshmUpdateTransaction: withUpdateTransaction },
      updateRefusal: target => scenario === 'check' ? 'invalid-spec' : target,
      semver: { valid: () => '2.0.0', gt: () => true },
      managementError: e => ({ diagnostic: e.message }), ManagementFailure: Failure
    });
    const manager = new Manager();
    manager.profile = { dir: profile, startedBundles: [] };
    manager.ownerContext = { get: () => scenario === 'no-hmr' ? undefined : {}, emit() {} };
    manager.installedFrom = new Map(); manager.configuredRegistries = {};
    manager.ctx = { loader: { entries: () => [] } };
    manager.bundleRows = () => [{ id: 'different-entry', name: 'module' }];
    manager.listBundles = async () => [{ name: 'demo', kind: 'registry', installed: '1.0.0', removable: scenario !== 'remove-refused', enabled: enabled.value, bundle: { enabled: true } }];
    manager.checkRegistryUpdate = async () => ({ spec: 'demo@2.0.0' });
    manager.configure = async fn => fn();
    manager.selectBundle = async (_name, value) => { enabled.value = value; };
    manager.reload = async () => { reloads++; return {}; };
    manager.publishAndReload = async () => { enabled.value = true; reloads++; return {}; };
    manager.change = async (fn, request) => {
      const result = { ...request, application: 'applied', changed: false };
      try { await fn(result); result.changed = true; } catch (error) { result.application = 'failed'; result.error = { diagnostic: error.message }; }
      return result;
    };
    manager.runPnpm = async () => {
      removals++;
      fs.rmSync(dest, { recursive: true, force: true });
      for (const name of ['.dshm-plugin-rows.yml', 'cordis.patch.yml']) fs.writeFileSync(path.join(profile, name), '- id: unrelated\n  config: changed\n');
      return { exitCode: 0 };
    };
    manager.installBundle = async spec => {
      installs++;
      if (scenario === 'no-hmr') return { application: 'restart-required', changed: false };
      if (scenario === 'official-restore' && installs === 2) {
        fs.mkdirSync(dest, { recursive: true }); fs.writeFileSync(path.join(dest, 'old'), 'OFFICIAL OLD');
        return { application: 'applied' };
      }
      return { application: 'failed', stage: scenario === 'enable-failure' && installs === 1 ? 'enable' : 'install' };
    };
    const result = await manager.updateBundle('demo', '2.0.0', {});
    if (scenario === 'check' || scenario === 'remove-refused') {
      assert.equal(removals, 0); assert.equal(installs, 0);
      assert.equal(fs.readFileSync(path.join(dest, 'old'), 'utf8'), 'OLD');
    } else if (scenario === 'no-hmr') {
      assert.equal(removals, 0); assert.equal(installs, 1);
    } else {
      assert.equal(installs, 2); // actual official previous recovery branch ran
      assert.equal(fs.readFileSync(path.join(dest, 'old'), 'utf8'), scenario === 'official-restore' ? 'OFFICIAL OLD' : 'OLD');
      for (const name of ['.dshm-plugin-rows.yml', 'cordis.patch.yml']) {
        const restored = fs.readFileSync(path.join(profile, name), 'utf8');
        assert.match(restored, /different-entry[\s\S]*secret: keep/);
        assert.match(restored, /config: changed/);
      }
      assert(reloads >= 3); assert.equal(enabled.value, true);
      if (scenario !== 'official-restore') assert.match(result.result.error.diagnostic, /本地恢复/);
    }
    count++;
  }
  const profile = path.join(root, 'locks'); fs.mkdirSync(profile);
  let finish;
  const running = withProfileWriter(profile, async () => {
    const token = currentToken(profile);
    await withProfileWriter(profile, async () => assertQueueOwnership(profile, token), token);
    assert.throws(() => assertQueueOwnership(profile, ''), /not applied/);
    await new Promise(resolve => { finish = resolve; });
  });
  await new Promise(resolve => setImmediate(resolve));
  let uninstalled = false;
  const uninstall = withProfileWriter(profile, async () => { uninstalled = true; });
  assert.equal(uninstalled, false); finish(); await running; await uninstall;
  assert.equal(uninstalled, true);
  console.log(`Real materialized manager update/remove/previous recovery ${count}/6 PASS; writer reentry/FIFO/uninstall intent PASS`);
  if (process.argv.includes('--self-test')) {
    const run = require('node:child_process').spawnSync(process.execPath, [__filename, '--mutate-reconcile'], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    console.log('Real manager lost-reconcile mutation rejected 1/1');
  }
}
main().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch(e => { console.error(e); process.exitCode = 1; });
