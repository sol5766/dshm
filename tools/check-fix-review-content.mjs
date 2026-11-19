#!/usr/bin/env node
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { stripTypeScriptTypes } from 'node:module';
import assert from 'node:assert/strict';

function load(text, expression, deps) {
  const code = text.replace(/^import[\s\S]*?from '[^']+';\n/gm, '').replaceAll('export ', '');
  return vm.runInNewContext(stripTypeScriptTypes(code, { mode: 'strip' }) + '\n' + expression, deps);
}
const importText = fs.readFileSync('platform/src/main/ets/sync/ImportRunner.ets', 'utf8');
const storeText = fs.readFileSync('platform/src/main/ets/sync/SyncStore.ets', 'utf8');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
class Token { check() {} isCurrent() { return true; } }
function memoryIo(initial) {
  const files = new Map(Object.entries(initial));
  let serial = 0;
  return { files, OpenMode: {},
    listFileSync: dir => [...new Set([...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1).split('/')[0]))],
    accessSync: p => files.has(p),
    mkdirSync() {}, mkdtempSync: p => p.replace('XXXXXX', String(++serial)), rmdirSync() {},
    copyFileSync: (a, b) => { assert(files.has(a)); files.set(b, files.get(a)); },
    renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    unlinkSync: p => files.delete(p),
    statSync: p => { const directory = !files.has(p) && [...files.keys()].some(f => f.startsWith(p + '/')); assert(files.has(p) || directory); return { size: directory ? 0 : Buffer.byteLength(files.get(p)), atime: 1, mtime: 1, isDirectory: () => directory }; },
    openSync: p => ({ fd: p }), closeSync() {},
    readSync: (fd, buf) => { const bytes = Buffer.from(files.get(fd)); new Uint8Array(buf).set(bytes.subarray(0, buf.byteLength)); return Math.min(bytes.length, buf.byteLength); }
  };
}
async function runImport(text) {
  let cases = 0;
  const target = '/sessions/--project--/id/session.jsonl.zstd';
  for (const mode of ['new', 'same', 'conflict', 'bad-asset', 'missing-sha']) {
    const io = memoryIo({ '/asset': mode === 'bad-asset' ? 'BAD' : 'ABC' });
    if (mode === 'same' || mode === 'conflict') io.files.set(target, mode === 'same' ? 'ABC' : 'XYZ');
    const api = load(text, 'runImport', {
      SyncTask: Token, fs: io, sha256OfFile: async p => hash(io.files.get(p)),
      initialProgress: task => ({ task, failed: 0, skipped: 0, succeeded: 0, preparedBytes: 0 }),
      isValidSha256: s => /^[a-f0-9]{64}$/i.test(s), ImportStage: {},
      UnitOutcome: { OK: 'ok', FAILED: 'failed', SKIPPED: 'skipped' }
    });
    const report = await api({ cacheDir: '/cache' }, '/sessions', [{
      unitId: 'session/p/id', kind: 'session', workspaceId: 'p', sessionId: 'id', version: 0,
      bytes: 3, sha256: mode === 'missing-sha' ? '' : hash('ABC'), assetPath: '/asset'
    }], [{ workspaceId: 'p', projectKey: '--project--' }], () => {});
    assert.equal(report.outcomes[0].outcome, mode === 'new' ? 'ok' : mode === 'same' ? 'skipped' : 'failed');
    if (mode === 'conflict') assert.equal(io.files.get(target), 'XYZ');
    if (mode === 'bad-asset' || mode === 'missing-sha') assert.equal(io.files.has(target), false);
    cases++;
  }
  return cases;
}
console.log(`E03 actual import: ${await runImport(importText)}/5 PASS`);
function runAssets(text) {
  const io = memoryIo({ '/one': 'ABC', '/two': 'XYZ' });
  const api = load(text, 'stageAsset', { fs: io, ASSET_DIR: 'dshm-sync-assets', relationalStore: { AssetStatus: {} } });
  const ctx = { distributedFilesDir: '/distributed' };
  const a = api(ctx, '/one', 'skill/global/demo/SKILL.md');
  const b = api(ctx, '/two', 'skill/global/demo_SKILL.md');
  const c = api(ctx, '/two', 'skill/global/demo/SKILL.md');
  assert(a.ok && b.ok && c.ok);
  assert.equal(new Set([a.value.path, b.value.path, c.value.path]).size, 3);
  assert.equal(io.files.get(a.value.path), 'ABC');
  assert.equal(io.files.get(b.value.path), 'XYZ');
  assert.equal(a.value.size, '3');
  return 3;
}
console.log(`E05 actual staging collision/same-unit snapshots: ${runAssets(storeText)}/3 PASS`);

const vmText = fs.readFileSync('hostcore/plugins/dshm-vm-bash/lib/vm.js', 'utf8');
async function runStop(text) {
  const start = text.indexOf('export const VM_STOP_GRACE_MS');
  const end = text.indexOf('/** 机器可读状态', start);
  const code = text.slice(start, end).replaceAll('export ', '');
  const worker = new EventEmitter();
  const qmp = new EventEmitter();
  qmp.write = () => {};
  qmp.destroy = () => {};
  let timer;
  let logged = '';
  const stop = vm.runInNewContext(code + '\nstop', {
    state: { worker, session: null }, createConnection: () => qmp, sockets: () => ({ qmp: '/qmp' }),
    setTimeout: fn => { timer = fn; return 1; }, clearTimeout() {}, log: s => { logged = s; }
  });
  let settled = false;
  const one = stop();
  assert.equal(stop(), one);
  one.then(() => { settled = true; });
  for (const event of ['connect', 'data', 'close', 'end', 'error']) {
    qmp.emit(event, '{}');
    await Promise.resolve(); await Promise.resolve();
    assert.equal(settled, false, event + ' is not exit');
  }
  worker.emit('exit', 0);
  await one;
  assert.equal(settled, true);
  const two = stop();
  timer();
  await two;
  assert.match(logged, /unconfirmed/);
  return 8;
}
console.log(`C01 actual stop worker/QMP/timeout/repeated: ${await runStop(vmText)} PASS`);
const coreText = fs.readFileSync('hostruntime/src/main/ets/core/BundledCore.ets', 'utf8');
function runIdentity(text) {
  const start = text.indexOf('export function matchesBundledIdentity(');
  const end = text.indexOf('\n/**', start);
  const matches = load(text.slice(start, end), 'matchesBundledIdentity', {});
  const identity = 'sha256:' + hash('ABC');
  assert.equal(matches(identity, identity), true);
  for (const old of ['', '3', '999', 'broken', 'sha256:' + hash('XYZ')]) {
    assert.equal(matches(old, identity), false);
  }
  assert.equal(matches('', ''), false);
}
runIdentity(coreText);
console.log('FR1 production content identity: matching/legacy/missing/bad/same-size-different PASS (7)');
if (process.argv.includes('--self-test')) {
  await assert.rejects(() => runImport(importText.replace('same = fs.statSync(target).size === c.bytes &&\n          (await sha256OfFile(target)) === c.sha256.toLowerCase();', 'same = fs.statSync(target).size === c.bytes;')));
  await assert.rejects(() => runImport(importText.replace("if ((await sha256OfFile(tmpPath)) !== c.sha256.toLowerCase())", 'if (false)')));
  assert.throws(() => runAssets(storeText.replace('dst = `${snapshot}/${name}`;', 'dst = `${dir}/${name}`;')));
  await assert.rejects(() => runStop(vmText.replace("qmp.on('data', () => { /* greeting/response is not worker exit */ });", "qmp.on('data', finish);")));
  console.log('E03/E05/C01 production mutations rejected 4/4');
  assert.throws(() => runIdentity(coreText.replace("return identity.startsWith('sha256:') && identity.length === 71 && stamp === identity;", 'return stamp.length > 0;')));
  console.log('FR1 weak-stamp mutation rejected 1/1');
}
