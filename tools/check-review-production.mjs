#!/usr/bin/env node
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const appRequire = createRequire(new URL('../hostcore/app/dshm-installer.js', import.meta.url));
const root = fs.mkdtempSync('/data/storage/el2/base/files/tmp/deveco/review-production-');
const read = p => fs.readFileSync(p, 'utf8');
function ets(text, result, deps) {
  const code = text.replace(/^import[\s\S]*?from '[^']+';\n/gm, '')
    .replace(/^export \{[^\n]+\} from '[^']+';\n/gm, '').replaceAll('export ', '');
  return vm.runInNewContext(stripTypeScriptTypes(code, { mode: 'strip' }) + '\n' + result, { ...deps });
}
try {
  const installer = read('hostcore/app/dshm-installer.js');
  const context = { require: appRequire,
    module: { exports: {} }, exports: {}, __dirname: process.cwd() + '/hostcore/app', process, console, Buffer, URL, setTimeout, clearTimeout };
  vm.runInNewContext(installer + '\nmodule.exports.dependencyValueFor = dependencyValueFor; module.exports.parseNpm = parseNpm; module.exports.parseGitHub = parseGitHub;', context);
  const api = context.module.exports;
  const manifest = ets(read('platform/src/main/ets/sync/PluginManifest.ets'), '({parsePluginManifest,toInstallPayload})', {});
  const restoreText = read('platform/src/main/ets/sync/PluginRestore.ets');
  const restoreStart = restoreText.indexOf('export function restoreInstallSpec(');
  const restore = ets(restoreText.slice(restoreStart, restoreText.indexOf('\n/**', restoreStart)), 'restoreInstallSpec', {});
  const cases = [
    ['demo', 'demo@^1.2.3', false], ['@scope/demo', '@scope/demo@next', false],
    ['alias', 'alias@npm:@scope/real@^1.2.3', false], ['alias', 'alias@npm:@scope/real@^1.2.3', true],
    ['demo', 'owner/repo#commit', false], ['demo', 'github.com/owner/repo', false],
    ['demo', 'github:owner/repo#commit&path:/plugin', false]
  ];
  for (const [name, spec, exact] of cases) {
    const saved = api.dependencyValueFor({ name, spec, version: '1.2.3', exact });
    const parsed = manifest.parsePluginManifest(JSON.stringify({ dependencies: { [name]: saved }, dsh: { profile: { bundles: [name] } } }));
    const wire = JSON.parse(manifest.toInstallPayload(parsed));
    const request = restore(wire.plugins[0]);
    if (api.parseGitHub(spec)) assert.equal(request, spec);
    else {
      const npm = api.parseNpm(request);
      assert.equal(npm.aliasName || npm.name, name);
      if (name === 'alias') { assert.equal(npm.name, '@scope/real'); assert.equal(npm.range, exact ? '1.2.3' : '^1.2.3'); }
    }
  }
  console.log('R4 producer→manifest→payload→restore→real parser 7/7 PASS');

  const taskText = read('platform/src/main/ets/sync/SyncTask.ets');
  const Task = ets(taskText, 'SyncTask', {});
  const uploadText = read('platform/src/main/ets/sync/UploadRunner.ets');
  async function cancelUpload(text, rejectHash) {
    const task = new Task();
    let enableCalls = 0, sinkAfter = 0, stageCount = 0, hashCount = 0;
    const run = ets(text, 'runUpload', {
      SyncTask: Task, initialProgress: () => ({ succeeded: 0, failed: 0, skipped: 0, preparedBytes: 0 }),
      UploadStage: {}, UnitOutcome: {}, UNIT_METADATA_SCHEMA: 1, UnitKind: {},
      openStore: async () => ({ ok: true, value: {} }),
      reusableAsset: async () => undefined,
      sha256OfFile: async () => {
        if (++hashCount === 4) { task.cancel(); if (rejectHash) throw new Error('HASH_FAILED'); }
        return 'a'.repeat(64);
      },
      stageAsset: () => ({ ok: true, value: { path: '/owned/' + (++stageCount), size: '3' } }),
      discardUnregisteredAsset() {}, encodeMetadata: () => '', deviceIdNow: () => 'test',
      upsertUnit: async () => ({ ok: true }),
      enableCloudSync: async () => { enableCalls++; return { ok: true }; },
      statByKind: async () => ({ ok: true, value: [] }), relationalStore: { SyncMode: {} }
    });
    await assert.rejects(() => run({}, { plans: [{ unitId: '1', sourcePath: '/1', bytes: 3 }, { unitId: '2', sourcePath: '/2', bytes: 3 }] }, () => { if (!task.isCurrent()) sinkAfter++; }, task));
    assert.equal(enableCalls, 0);
    assert.equal(sinkAfter, 0);
  }
  await cancelUpload(uploadText, false); await cancelUpload(uploadText, true);
  console.log('R5 actual runner last hash resolve/reject cancellation, prior success, zero late sink/cloud 2/2 PASS');

  const keepText = read('platform/src/main/ets/notify/KeepAlive.ets');
  const className = /export class (\w+)/.exec(keepText)[1];
  async function lateAcquire(text) {
    let resolveStart;
    let stops = 0;
    const Keep = ets(text, className, {
      backgroundTaskManager: { BackgroundMode: { DATA_TRANSFER: 1, TASK_KEEPING: 9 },
        startBackgroundRunning: () => new Promise(r => { resolveStart = r; }),
        stopBackgroundRunning: async () => { stops++; } },
      wantAgent: { getWantAgent: async () => ({}), OperationType: {} },
      hilog: { info() {}, warn() {} }, setTimeout, clearTimeout, console
    });
    const keep = new Keep();
    keep.context = { abilityInfo: { bundleName: 'test', name: 'Main' } };
    keep.writeDiag = () => {};
    const job = keep.acquire();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof resolveStart, 'function');
    const releasing = keep.forceRelease();
    resolveStart();
    await releasing;
    assert.equal(await job, false);
    assert.equal(keep.facts().refs, 0);
    assert.equal(keep.facts().active, false);
    assert.equal(stops, 1);
  }
  await lateAcquire(keepText);
  console.log('R6 complete production KeepAlive acquire→forceRelease→system late-success stop PASS');
  {
    const starts = [];
    let stops = 0;
    const Keep = ets(keepText, className, {
      backgroundTaskManager: { BackgroundMode: { DATA_TRANSFER: 1 },
        startBackgroundRunning: () => new Promise(resolve => starts.push(resolve)),
        stopBackgroundRunning: async () => { stops++; } },
      wantAgent: { getWantAgent: async () => ({}), OperationType: {} },
      hilog: { info() {}, warn() {} }, setTimeout, clearTimeout, console
    });
    const keep = new Keep(); keep.context = { abilityInfo: { bundleName: 't', name: 'M' } }; keep.writeDiag = () => {};
    const a = keep.acquire(); await new Promise(r => setImmediate(r));
    const release = keep.forceRelease(); const b = keep.acquire();
    await new Promise(r => setImmediate(r)); assert.equal(starts.length, 1);
    starts[0](); await a; await release; await new Promise(r => setImmediate(r));
    assert.equal(starts.length, 2); starts[1](); assert.equal(await b, true);
    assert.equal(keep.facts().active, true); assert.equal(keep.facts().refs, 1); assert.equal(stops, 1);
    console.log('N6 A→forceRelease→B cannot start until stale A stop settles; B remains active PASS');
  }
  async function releasePending(text) {
    let resolveStop;
    let starts = 0;
    const Keep = ets(text, className, {
      backgroundTaskManager: { BackgroundMode: { DATA_TRANSFER: 1 },
        startBackgroundRunning: async () => { starts++; },
        stopBackgroundRunning: () => new Promise(resolve => { resolveStop = resolve; }) },
      wantAgent: { getWantAgent: async () => ({}), OperationType: {} },
      hilog: { info() {}, warn() {} }, setTimeout, clearTimeout, console
    });
    const keep = new Keep(); keep.context = { abilityInfo: { bundleName: 't', name: 'M' } }; keep.writeDiag = () => {};
    assert.equal(await keep.acquire(), true);
    const releasing = keep.release(); await new Promise(resolve => setImmediate(resolve));
    let returned = false;
    const b = keep.acquire().then(value => { returned = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(returned, false, 'cannot grant reference while previous stop is pending');
    resolveStop(); await releasing;
    assert.equal(await b, true);
    assert.equal(starts, 2);
    assert.equal(keep.facts().refs, 1); assert.equal(keep.facts().active, true);
  }
  await releasePending(keepText);
  console.log('N6 existing lease→release pending stop→acquire B waits and reacquires: refs1/active true PASS');
  const storeText = read('platform/src/main/ets/sync/SyncStore.ets');
  const assetRoot = root + '/assets'; fs.mkdirSync(assetRoot);
  const input = root + '/input'; fs.writeFileSync(input, 'SAME');
  const io = {
    OpenMode: {}, accessSync: fs.existsSync, mkdirSync: p => fs.mkdirSync(p, { recursive: true }),
    listFileSync: p => fs.readdirSync(p), statSync: p => fs.statSync(p),
    mkdtempSync: p => fs.mkdtempSync(p.replace('XXXXXX', '')), copyFileSync: fs.copyFileSync,
    unlinkSync: fs.unlinkSync, rmdirSync: fs.rmdirSync
  };
  const assetDeps = {
    fs: io, SyncTask: Task, relationalStore: { AssetStatus: {}, ConflictResolution: {} },
    sha256OfFile: async p => require('node:crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex')
  };
  const assets = ets(storeText, '({stageAsset,discardUnregisteredAsset,upsertUnit,reusableAsset})', assetDeps);
  const ctx = { distributedFilesDir: assetRoot };
  const first = assets.stageAsset(ctx, input, 'skill/global/unit'); assert(first.ok);
  assets.discardUnregisteredAsset(first.value); assert.equal(fs.existsSync(first.value.path), false);
  const second = assets.stageAsset(ctx, input, 'skill/global/unit'); assert(second.ok);
  let registered;
  await assets.upsertUnit({ insert: async (_table, row) => { registered = row; } },
    { unitId: 'unit', sha256: require('node:crypto').createHash('sha256').update('SAME').digest('hex') }, second.value, new Task());
  assets.discardUnregisteredAsset(second.value); assert(fs.existsSync(second.value.path));
  const reusable = await assets.reusableAsset({ querySql: async () => ({
    goToFirstRow: async () => true, getColumnIndex: p => p,
    getString: () => registered.sha256, getAsset: () => registered.payload, close: async () => {}
  }) }, 'unit', registered.sha256, new Task());
  assert.equal(reusable.path, second.value.path);
  const big = root + '/large'; fs.truncateSync(input, 513 * 1024 * 1024);
  const refused = assets.stageAsset(ctx, input, 'large'); assert.equal(refused.ok, false);
  assert.match(refused.error, /512 MiB/);
  assert(fs.existsSync(second.value.path));
  console.log('R8 actual store unregistered cleanup/registered retention/verified reuse/budget refusal PASS (4)');
  if (process.argv.includes('--self-test')) {
    await assert.rejects(() => releasePending(keepText.replace('this.active && this.pendingStops === 0', 'this.active')));
    console.log('N6 pending-stop active-fastpath regression mutation rejected 1/1');
    await assert.rejects(() => lateAcquire(keepText.replaceAll('this.releaseGeneration++;', '/* generation removed */')));
    await assert.rejects(() => cancelUpload(uploadText.replace('discardUnregisteredAsset(assetRes.value);\n      task.check();', 'discardUnregisteredAsset(assetRes.value);'), false));
    console.log('R5/R6 actual production mutations rejected 2/2');
    const badBudget = ets(storeText.replace('retainedAssetBytes(dir) + sourceBytes > ASSET_BUDGET_BYTES', 'false')
      .replace('retainedAssetBytes(dir) > ASSET_BUDGET_BYTES', 'false'), 'stageAsset', {
      ...assetDeps, fs: { ...io, copyFileSync: () => { throw new Error('MUTANT_REACHED_COPY'); } }
    });
    assert.match(badBudget(ctx, input, 'large').error, /MUTANT_REACHED_COPY/);
    const safeBudget = ets(storeText, 'stageAsset', { ...assetDeps,
      fs: { ...io, copyFileSync: () => { throw new Error('MUTANT_REACHED_COPY'); } } });
    assert.match(safeBudget(ctx, input, 'large').error, /512 MiB/);
    const badReuse = ets(storeText.replace('digest === sha && fs.statSync(asset.path).size === Number(asset.size)', 'true'), 'reusableAsset', assetDeps);
    fs.writeFileSync(second.value.path, 'CHANGED');
    const rows = { querySql: async () => ({ goToFirstRow: async () => true, getColumnIndex: p => p,
      getString: () => registered.sha256, getAsset: () => registered.payload, close: async () => {} }) };
    assert.equal(await assets.reusableAsset(rows, 'unit', registered.sha256, new Task()), undefined);
    assert.notEqual(await badReuse(rows, 'unit', registered.sha256, new Task()), undefined);
    console.log('R8 removed-budget/unchecked-reuse mutation contrasts 2/2 PASS');
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
