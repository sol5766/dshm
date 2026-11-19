#!/usr/bin/env node
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { patchManagerLifecycle } from './lib/manager-lifecycle.mjs';
const require = createRequire(import.meta.url);
const work = fs.readFileSync('dist/core/work/dsh-core-0.2.2-rc.2+dshm.1/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js', 'utf8');
const clean = `class Manager {
async updateBundle(name, version, options) { return this.original(name); }
installBundle(spec, options) { return this.change(() => spec); }
async change(operation, request, reason, identity) { return operation(); }
}`;
for (const input of [clean, work]) {
  const patched = patchManagerLifecycle(input);
  assert.equal(patchManagerLifecycle(patched), patched);
  const start = patched.indexOf('async updateBundle(');
  const body = patched.slice(start, patched.indexOf('async dshmUpdateBundleInner', start));
  assert.match(body, /__dshmProfileWriter\(this.profile.dir, transaction\)/);
  assert.match(body, /__dshmUpdateTransaction/);
  assert(!patched.includes('DSHM_PROFILE_WRITER:installBundle'));
  assert(patched.includes('DSHM_WRITER_CHANGE'));
}
console.log('N3 clean/work canonical writer→transaction order and repeated idempotence PASS (2 inputs)');
{
  const canonical = patchManagerLifecycle(work);
  const start = canonical.indexOf('\n\t\tinstallBundle(spec, options) {');
  const end = canonical.indexOf('\n\t\t/** Recover the result', start);
  const cancelStart = canonical.indexOf('\n\t\tasync cancelInstall(');
  const cancelEnd = canonical.indexOf('\n\t\t/** Unload and remove', cancelStart);
  const methods = canonical.slice(start, end) + canonical.slice(cancelStart, cancelEnd);
  class Cancelled extends Error {}
  const Manager = vm.runInNewContext('class Manager {' + methods + '}\nManager', {
    AbortController, Promise, dshmNormalizeInstallSpec: s => s,
    ManagementFailure: Error, InstallCancelledError: Cancelled
  });
  let release, executed = false;
  const gate = new Promise(resolve => { release = resolve; });
  const manager = new Manager(); manager.installs = new Map(); manager.abort = new AbortController();
  manager.ownerContext = { emit() {} };
  manager.change = async (operation, request) => {
    await gate;
    const result = { ...request, application: 'applied' };
    try { await operation(result); executed = true; } catch (_) { result.application = 'cancelled'; }
    return result;
  };
  const install = manager.installBundle('demo', { requestId: 'queued' });
  assert(manager.installs.has('queued'));
  const cancellation = manager.cancelInstall('queued');
  assert(manager.installs.get('queued').abort.signal.aborted);
  release(); await cancellation; const result = await install;
  assert.equal(result.application, 'cancelled'); assert.equal(executed, false);
  console.log('N5 actual public install synchronously registers cancellation before change FIFO; cancelled queued operation never installs PASS');
}

const writerText = fs.readFileSync('hostcore/app/dshm-profile-writer.cjs', 'utf8');
const c = { module: { exports: {} }, require: id => id === 'node:fs' ? {
  mkdirSync() {}, rmdirSync() { throw new Error('LOCK_RELEASE_FAILED'); }
} : require(id) };
vm.runInNewContext(writerText, c);
await assert.rejects(() => c.module.exports.withProfileWriter('/test', async () => { throw new Error('ORIGINAL'); }), /ORIGINAL.*LOCK_RELEASE_FAILED/);
await Promise.race([
  assert.rejects(() => c.module.exports.withProfileWriter('/test', async () => {}), /LOCK_RELEASE_FAILED/),
  new Promise((_, reject) => setTimeout(() => reject(new Error('FIFO_HUNG')), 500))
]);
console.log('N2 cleanup failure retains original diagnostic and settles next FIFO request PASS');

let helper = require('../hostcore/app/dshm-update-transaction.cjs');
const mutation = process.argv.find(arg => arg.startsWith('--mutate='));
if (mutation) {
  let text = fs.readFileSync('hostcore/app/dshm-update-transaction.cjs', 'utf8');
  if (mutation === '--mutate=neighbour') {
    text = text.replace('const next = nextIdentity ? currentBlocks.find(candidate => blockKey(candidate) === nextIdentity) : undefined;',
      'const next = item.original.slice(index + 1).find(candidate => !identities.has(blockKey(candidate)) && restored.includes(candidate));');
  } else {
    text = text.replace('selected ? [...(rowIds || [])] : []', 'selected ? [...identities].filter(id => id !== name) : []');
  }
  const context = { module: { exports: {} }, require };
  vm.runInNewContext(text, context);
  helper = context.module.exports;
}
const root = fs.mkdtempSync('/data/storage/el2/base/files/tmp/deveco/final-yaml-');
try {
  for (const anchored of [false, true]) {
    const profile = root + '/' + anchored;
    fs.mkdirSync(profile + '/node_modules/demo', { recursive: true });
    fs.writeFileSync(profile + '/node_modules/demo/old', 'OLD');
    fs.writeFileSync(profile + '/package.json', '{"dependencies":{"demo":"1"},"dsh":{"profile":{"bundles":["demo"]}}}');
    const yaml = anchored ? '- id: target\n  config: &shared { value: 1 }\n- id: other\n  config: *shared\n' : '- name: module\n  id: target\n  config:\n    value: 1\n- id: other\n  config: old\n';
    fs.writeFileSync(profile + '/cordis.patch.yml', yaml);
    let ran = false;
    const run = () => helper.withUpdateTransaction(profile, 'demo', '1', '2', async () => {
      ran = true;
      fs.writeFileSync(profile + '/cordis.patch.yml', '- id: other\n  config: changed\n');
      return { step: 'install', result: { application: 'failed', error: { diagnostic: 'NEW_FAILED' } } };
    }, { rowIds: ['target'], hasHmr: false, reconcile: async ids => { assert.deepEqual(ids, ['target']); return { warnings: [] }; } });
    if (anchored) {
      await assert.rejects(run, /YAML/); assert.equal(ran, false);
      assert.equal(fs.readFileSync(profile + '/cordis.patch.yml', 'utf8'), yaml);
    } else {
      const result = await run();
      const restored = fs.readFileSync(profile + '/cordis.patch.yml', 'utf8');
      assert.match(restored, /id: target/); assert.match(restored, /config: changed/);
      assert(restored.indexOf('id: target') < restored.indexOf('id: other'), 'target stays before changed neighbour');
      assert.equal(result.restore.application, 'restart-required');
      assert.equal(result.restore.restartReason, 'no-hmr');
      assert(!result.result.error.diagnostic.includes('运行态已'));
    }
  }
  console.log('N1 name-before-id restored; anchor/alias explicitly refused before remove; N4 no-HMR restart truth PASS');
  // Same real helper: previous-source recovery followed by reconcile requiring restart.
  const profile = root + '/restart'; fs.mkdirSync(profile + '/node_modules/demo', { recursive: true });
  fs.writeFileSync(profile + '/node_modules/demo/old', 'OLD');
  fs.writeFileSync(profile + '/package.json', '{"dependencies":{"demo":"1"}}');
  const result = await helper.withUpdateTransaction(profile, 'demo', '1', '2', async () => ({
    step: 'install', result: { application: 'failed' }, restore: { application: 'applied' }
  }), { hasHmr: true, reconcile: async () => ({ restartReason: 'module-comparison' }) });
  assert.equal(result.restore.application, 'restart-required');
  assert.equal(result.restore.restartReason, 'module-comparison');
  console.log('N4 previous recovery applied + reconcile restart is normalized restart-required PASS');
  for (const selected of [true, false]) {
    const p = root + '/same-id-' + selected; fs.mkdirSync(p + '/node_modules/demo', { recursive: true });
    fs.writeFileSync(p + '/node_modules/demo/old', 'OLD');
    fs.writeFileSync(p + '/package.json', JSON.stringify({ dependencies: { demo: '1' }, dsh: { profile: { bundles: selected ? ['demo'] : [] } } }));
    let required;
    const run = () => helper.withUpdateTransaction(p, 'demo', '1', '2', async () => ({
      step: 'install', result: { application: 'failed' }
    }), { rowIds: ['demo'], hasHmr: true, reconcile: async ids => {
      required = ids;
      if (ids.includes('demo')) throw new Error('TARGET_STILL_FAILED');
      return {};
    } });
    if (selected) await assert.rejects(run, /TARGET_STILL_FAILED/);
    else assert.equal((await run()).restore.application, 'applied');
    assert.deepEqual(required, selected ? ['demo'] : []);
  }
  console.log('N4 same-name required entry retained; failed selected target cannot report applied; disabled target not required PASS (2)');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
if (!mutation) {
  for (const mode of ['neighbour', 'required-id']) {
    const run = require('node:child_process').spawnSync(process.execPath,
      [new URL(import.meta.url).pathname, '--mutate=' + mode], { encoding: 'utf8' });
    assert.notEqual(run.status, 0, 'production regression mutant must fail: ' + mode);
  }
  console.log('N1 changed-neighbour/N4 same-name-required-id production regression mutations rejected 2/2');
}
