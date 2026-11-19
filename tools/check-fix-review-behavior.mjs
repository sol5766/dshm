#!/usr/bin/env node
// Execute extracted production functions, not a parallel implementation.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';

const source = fs.readFileSync('platform/src/main/ets/system/FilePicker.ets', 'utf8');
function probeFunction(text, io) {
  const start = text.indexOf('export function probePathWritable(');
  const end = text.indexOf('\n/**', start);
  const code = text.slice(start, end).replace('export ', '')
    .replaceAll(': string', '').replaceAll(': boolean', '')
    .replace(': fs.File | undefined', '').replace(' as BusinessError', '');
  return vm.runInNewContext(`${code}\nprobePathWritable`, {
    fs: io, WRITE_PROBE_NAME: 'dshm-write-probe.tmp',
    hilog: { info() {}, warn() {} }, DOMAIN: 0, TAG: 'test'
  });
}
function runProbe(text) {
  let count = 0;
  for (const fault of ['', 'mkdir', 'open', 'write', 'close', 'unlink', 'rmdir']) {
    const files = new Map([['/selected/dshm-write-probe.tmp', 'USER ORIGINAL']]);
    const dirs = new Set();
    let seq = 0;
    const fail = op => { if (op === fault) throw new Error(op); };
    const io = {
      OpenMode: { CREATE: 1, READ_WRITE: 2, TRUNC: 4 },
      mkdtempSync(prefix) { fail('mkdir'); const p = prefix.replace('XXXXXX', String(++seq)); dirs.add(p); return p; },
      openSync(p) { fail('open'); files.set(p, ''); return { fd: p }; },
      writeSync(p, value) { fail('write'); files.set(p, value); },
      closeSync() { fail('close'); },
      unlinkSync(p) { fail('unlink'); files.delete(p); },
      rmdirSync(p) { fail('rmdir'); assert(![...files.keys()].some(f => f.startsWith(p + '/'))); dirs.delete(p); }
    };
    const probe = probeFunction(text, io);
    assert.equal(probe('/selected'), fault === '');
    assert.equal(files.get('/selected/dshm-write-probe.tmp'), 'USER ORIGINAL');
    assert.equal(probe(''), false);
    if (!['unlink', 'rmdir', 'close'].includes(fault)) {
      assert.equal(dirs.size, 0);
      assert.equal(files.size, 1);
    }
    count++;
  }
  return count;
}
console.log(`DR1 production behavior: ${runProbe(source)} fault/success cases PASS`);
const restoreSource = fs.readFileSync('platform/src/main/ets/sync/PluginRestore.ets', 'utf8');
function restoreFunction(text) {
  const start = text.indexOf('export function restoreInstallSpec(');
  const end = text.indexOf('\n/**', start);
  const code = text.slice(start, end).replace('export ', '').replace(': PluginSpec', '')
    .replaceAll(': string', '');
  return vm.runInNewContext(`${code}\nrestoreInstallSpec`);
}
function runRestore(text) {
  const restore = restoreFunction(text);
  const cases = [
    ['demo', '^1.2.3', 'demo@^1.2.3'],
    ['@scope/demo', '~2.0.0', '@scope/demo@~2.0.0'],
    ['alias', 'npm:@scope/real@1.0.0', 'alias@npm:@scope/real@1.0.0'],
    ['demo', 'github:owner/repo#ref', 'github:owner/repo#ref'],
    ['demo', 'git+https://example.invalid/repo#ref', 'git+https://example.invalid/repo#ref']
  ];
  for (const [name, spec, expected] of cases) assert.equal(restore({ name, spec }), expected);
  assert.match(text, /installOne\(queueDir, restoreInstallSpec\(s\)/);
  return cases.length;
}
console.log(`E01 production request intent: ${runRestore(restoreSource)} cases PASS`);
const keepSource = fs.readFileSync('platform/src/main/ets/notify/KeepAlive.ets', 'utf8');
async function runKeep(text) {
  const start = text.indexOf('  private async acquireWithMode(');
  const end = text.indexOf('\n  private async requestMode(', start);
  const code = text.slice(start, end).replace('private async acquireWithMode', 'async function acquireWithMode')
    .replaceAll(': backgroundTaskManager.BackgroundMode', '').replaceAll(': string', '')
    .replaceAll(': boolean', '').replaceAll(': number', '').replace(': Promise<boolean>', '');
  const acquire = vm.runInNewContext(`${code}\nacquireWithMode`, {
    backgroundTaskManager: { BackgroundMode: { DATA_TRANSFER: 1 } },
    hilog: { info() {}, warn() {} }, DOMAIN: 0, TAG: 'test'
  });
  const obj = { refs: 0, context: {}, active: false, userStopped: false,
    pendingAcquire: false, writeDiag() {}, requestMode: async () => false };
  assert.equal(await acquire.call(obj, 1, 'data', false), false);
  assert.equal(obj.refs, 0);
  obj.requestMode = async () => { obj.active = true; return true; };
  assert.equal(await acquire.call(obj, 1, 'data', false), true);
  assert.equal(obj.refs, 1);
  obj.refs--; // caller releases its single successful lease
  assert.equal(obj.refs, 0);
  obj.active = false;
  obj.context = undefined;
  assert.equal(await acquire.call(obj, 1, 'data', true), false);
  assert.equal(obj.refs, 0);
  obj.userStopped = true;
  assert.equal(await acquire.call(obj, 1, 'data', false), false);
  return 4;
}
console.log(`B01 production ownership: ${await runKeep(keepSource)} cases PASS`);
const taskSource = fs.readFileSync('platform/src/main/ets/sync/SyncTask.ets', 'utf8');
const Task = vm.runInNewContext(taskSource.replace('export class', 'class')
  .replace('private valid: boolean', 'valid').replaceAll(': void', '').replaceAll(': boolean', '') + '\nSyncTask');
const task = new Task();
task.check();
task.cancel();
assert.equal(task.isCurrent(), false);
assert.throws(() => task.check());
console.log('E04 production cancellation: live/cancelled checks PASS (2)');
function loadEngine(text, deps) {
  const withoutImports = text.replace(/^import[\s\S]*?from '[^']+';\n/gm, '');
  const code = stripTypeScriptTypes(withoutImports.replaceAll('export ', ''), { mode: 'strip' });
  return vm.runInNewContext(`${code}\nSyncEngine`, deps);
}
const engineSource = fs.readFileSync('platform/src/main/ets/sync/SyncEngine.ets', 'utf8');
async function runEngine(text) {
  let resume;
  let uploadCount = 0;
  const deps = {
    SyncTask: Task, initialProgress: task => ({ task, note: '' }),
    maskUnionId: () => '', planSessions: () => [], planAttachments: () => [], planSkills: () => [],
    mergePlans: () => ({}), runUpload: async (_ctx, _plan, sink, token) => {
      uploadCount++;
      await new Promise(resolve => { resume = resolve; });
      token.check();
      sink({ note: 'OLD RESULT' });
      return { summary: 'OLD RESULT', cloudError: '', ok: true };
    }
  };
  const Engine = loadEngine(text, deps);
  Engine.attachSessionsRoot('/home/sessions');
  Engine.adoptLogin('account');
  await Engine.setEnabled(true);
  const generation = Engine.currentGeneration();
  Engine.attachSessionsRoot('/home/sessions');
  assert.equal(Engine.currentGeneration(), generation);
  const old = Engine.syncNow({});
  Engine.signOut();
  Engine.adoptLogin('account');
  await Engine.setEnabled(true);
  assert.equal(await Engine.syncNow({}), '已有同步任务在进行');
  resume();
  assert.equal(await old, '同步任务已取消');
  assert.equal(Engine.isRunning(), false);
  assert.equal(uploadCount, 1);
  assert.notEqual(Engine.state().lastSyncText, 'OLD RESULT');
  return 5;
}
console.log(`E04 production engine async cancellation/lock/root: ${await runEngine(engineSource)} assertions PASS`);
function runMappings(text) {
  let keys = ['--first--'];
  const Engine = loadEngine(text, {
    SyncTask: Task, initialProgress: () => ({}),
    fs: { listFileSync: () => keys }, workspaceIdOf: k => k
  });
  Engine.attachSessionsRoot('/sessions');
  assert.equal(Engine.resolveMappings().length, 1);
  keys = ['--first--', '--second--'];
  assert.equal(Engine.resolveMappings().length, 2);
  keys = [];
  assert.equal(Engine.resolveMappings().length, 0);
}
runMappings(engineSource);
console.log('E02 production mapping refresh: initial/new-directory/empty PASS (3)');
const importSource = fs.readFileSync('platform/src/main/ets/sync/ImportRunner.ets', 'utf8');
async function runUnmapped(text) {
  const code = stripTypeScriptTypes(text.replace(/^import[\s\S]*?from '[^']+';\n/gm, '')
    .replaceAll('export ', ''), { mode: 'strip' });
  const writes = [];
  const api = vm.runInNewContext(code + '\n({discoverImportCandidates, runImport})', {
    SyncTask: Task, SYNC_TABLE: 'sync_units',
    fs: { mkdirSync: (...args) => writes.push(args) },
    initialProgress: task => ({ task, total: 0, failed: 0, skipped: 0, succeeded: 0, preparedBytes: 0 }),
    UnitOutcome: { FAILED: 'failed' }, ImportStage: {}
  });
  let next = 0;
  const row = { workspace_id: 'unmapped', unit_id: 'session/u/1', session_id: 'id', sha256: 'a'.repeat(64) };
  const store = { querySql: async () => ({
    goToNextRow: async () => ++next === 1, close: async () => {},
    getColumnIndex: key => key, getString: key => row[key], getLong: () => 1,
    getAsset: () => ({ path: '/remote/asset', size: '1' })
  }) };
  const candidates = await api.discoverImportCandidates(store, []);
  assert.equal(candidates.length, 1);
  const report = await api.runImport({}, '/sessions', candidates, [], () => {});
  assert.equal(report.ok, false);
  assert.equal(report.progress.failed, 1);
  assert.match(report.summary, /1 项工作区未映射/);
  assert.equal(writes.length, 0);
}
await runUnmapped(importSource);
console.log('E02 production discovery/import: unmapped retained/reported/no-write PASS (3)');
if (process.argv.includes('--self-test')) {
  const mutant = source.replace('probe = `${ownedDir}/${WRITE_PROBE_NAME}`;', 'probe = `${path}/${WRITE_PROBE_NAME}`;');
  assert.throws(() => runProbe(mutant));
  console.log('DR1 mutation: fixed flat probe rejected 1/1');
  assert.throws(() => runRestore(restoreSource.replace('return `${plugin.name}@${spec}`;', 'return spec;')));
  console.log('E01 mutation: lost package name rejected 1/1');
  await assert.rejects(() => runKeep(keepSource.replace('    if (this.context === undefined) {\n      return false;\n    }\n    this.pendingAcquire = true;', '    this.refs++;\n    if (this.context === undefined) {\n      return false;\n    }\n    this.pendingAcquire = true;')));
  console.log('B01 mutation: failed acquire increments refs rejected 1/1');
  await assert.rejects(() => runEngine(engineSource.replace('SyncEngine.task?.cancel();', '/* cancellation removed */')));
  console.log('E04 mutation: logout does not cancel rejected 1/1');
  assert.throws(() => runMappings(engineSource.replace('const out: WorkspaceMapping[] = [];',
    'if (SyncEngine.saved) return SyncEngine.saved; const out: WorkspaceMapping[] = [];').replace('return out;\n  }\n\n  /** 刷新', 'SyncEngine.saved = out; return out;\n  }\n\n  /** 刷新')));
  console.log('E02 mutation: nonempty cached mappings rejected 1/1');
  await assert.rejects(() => runUnmapped(importSource.replace('const ws: string = rs.getString(rs.getColumnIndex(\'workspace_id\'));',
    "const ws: string = rs.getString(rs.getColumnIndex('workspace_id')); if (knownWorkspaces.length === 0) continue;")));
  console.log('E02 mutation: silently filter unmapped rejected 1/1');
}
