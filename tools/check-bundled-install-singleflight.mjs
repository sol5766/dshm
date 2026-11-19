#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const source = fs.readFileSync(new URL('../hostruntime/src/main/ets/core/BundledCore.ets', import.meta.url), 'utf8');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const turn = () => new Promise(resolve => setImmediate(resolve));

async function verify(text, report = false) {
  const files = new Map();
  const counts = { hash: 0, stage: 0, copy: 0, evict: 0 };
  const staging = new Map();
  let active = 0;
  let maxConcurrentTransactions = 0;
  let rejectLayout = false;
  let failStage = false;
  let releaseHash;
  let barrier = Promise.resolve();
  const norm = p => p.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  const io = {
    OpenMode: {}, accessSync: p => files.has(norm(p)),
    listFileSync: () => ['core.zip'], statSync: p => ({ size: files.get(norm(p)).length }),
    readTextSync: p => files.get(norm(p)),
    copyFile: async (a, b) => { counts.copy++; files.set(norm(b), files.get(norm(a))); await turn(); },
    unlinkSync: p => files.delete(norm(p)),
    renameSync: (a, b) => { assert(files.has(norm(a))); files.set(norm(b), files.get(norm(a))); files.delete(norm(a)); },
    openSync: p => ({ fd: norm(p) }), writeSync: (fd, value) => files.set(fd, value), closeSync() {},
    rmdir: async p => { files.delete(norm(p)); }
  };
  const code = text.replace(/^import[\s\S]*?from '[^']+';\n/gm, '').replaceAll('export ', '');
  const install = vm.runInNewContext(stripTypeScriptTypes(code, { mode: 'strip' }) + '\ninstallBundledCores', {
    fs: io, parseArchiveName: () => 'v', hilog: { info() {}, warn() {}, error() {} },
    sha256OfFile: async p => { counts.hash++; await barrier; return digest(files.get(norm(p))); }
  });
  function store(base) {
    const root = norm(base);
    let archive;
    return {
      baseDir: () => base, coreDir: () => root + '/cores/v',
      ensureLayout: () => {
        if (rejectLayout) { rejectLayout = false; throw new Error('LAYOUT_FAILURE'); }
        active++;
        maxConcurrentTransactions = Math.max(maxConcurrentTransactions, active);
        return { ok: true };
      },
      listInstalled: () => files.has(root + '/cores/v') ? ['v'] : [],
      treeInfoPath: () => root + '/cores/info', readTreeInfo: () => ({ builtAt: 'OLD' }),
      stage: async tmp => {
        counts.stage++;
        archive = files.get(norm(tmp));
        staging.set(root, archive);
        await turn();
        assert.equal(files.get(norm(tmp)), archive, 'shared temporary zip must retain archive');
        assert.equal(staging.get(root), archive, 'shared staging must retain archive');
        return { ok: !failStage, message: 'STAGE_FAILURE' };
      },
      commitStaged: async () => {
        await turn();
        assert.equal(staging.get(root), archive);
        files.set(root + '/cores/v', staging.get(root));
        return { ok: true };
      },
      evict: async () => {
        counts.evict++;
        assert.equal(active, 1, 'only one transaction may touch files');
        active--;
        return [];
      }
    };
  }
  function resource(dir) { files.set(norm(dir), 'DIR'); files.set(norm(dir + '/core.zip'), 'ABC'); }
  function hold() { barrier = new Promise(resolve => { releaseHash = resolve; }); }
  resource('/res');
  hold();
  const a = install('/res', '/work', store('/data'));
  const b = install('/res///', '/work//', store('/data/'));
  await turn();
  assert.equal(counts.hash, 1, 'same normalized tuple must hash once');
  releaseHash();
  const results = await Promise.all([a, b]);
  assert.equal(results[0], results[1], 'share the running result');
  assert.equal(counts.stage, 1);
  assert.equal(counts.copy, 1);
  assert.equal(counts.evict, 1);
  if (report) console.log('same-key 2 requests: hash=1 copy=1 stage=1 evict=1');

  hold();
  const matchedOne = install('/res', '/work', store('/data'));
  const matchedTwo = install('/res', '/work', store('/data'));
  await turn();
  assert.equal(counts.hash, 2, 'completed task must rehash');
  releaseHash();
  const matched = await Promise.all([matchedOne, matchedTwo]);
  assert.equal(matched[0].skipped.length, 1);
  assert.equal(matched[0], matched[1]);
  assert.equal(counts.stage, 1, 'matching content stamp still skips stage');
  files.set('/res/core.zip', 'XYZ');
  await install('/res', '/work', store('/data'));
  assert.equal(counts.hash, 3);
  assert.equal(counts.stage, 2, 'same version and same length changed content must reinstall');
  assert.equal(files.get('/data/cores/v/.dshm-bundled-stamp'), 'sha256:' + digest('XYZ'));
  if (report) console.log('matching stamp 2 requests: +1 hash/+0 stage; same-length content change: +1 hash/+1 stage');

  for (const mode of ['stage', 'reject']) {
    failStage = mode === 'stage';
    rejectLayout = mode === 'reject';
    hold();
    const one = install('/res', '/retry', store('/retry-data'));
    const two = install('/res', '/retry', store('/retry-data'));
    const settled = Promise.allSettled([one, two]);
    await turn();
    releaseHash();
    const failed = await settled;
    for (const item of failed) {
      if (mode === 'reject') { assert.equal(item.status, 'rejected'); assert.match(item.reason.message, /LAYOUT_FAILURE/); }
      else { assert.equal(item.status, 'fulfilled'); assert.equal(item.value.failed.length, 1); }
    }
    failStage = false;
    rejectLayout = false;
    const before = counts.hash;
    const retry = await install('/res', '/retry', store('/retry-data'));
    assert.equal(counts.hash, before + 1, 'failed/rejected task must release key');
    assert.equal(retry.failed.length, 0);
    files.delete('/retry-data/cores/v');
  }

  for (const [left, right] of [
    [['/res', '/w', '/d1'], ['/res', '/w', '/d2']],
    [['/res', '/w1', '/d'], ['/res', '/w2', '/d']],
    [['/r1', '/w', '/d'], ['/r2', '/w', '/d']],
    [['/temp-left', '/shared-work', '/store-left'], ['/temp-right', '/shared-work', '/store-right']],
    [['/stage-left', '/work-left', '/shared-store'], ['/stage-right', '/work-right', '/shared-store']],
    [['/a|/b', '/c', '/d'], ['/a', '/b|/c', '/d']],
    [['/literal/link/../res', '/w', '/d'], ['/literal/res', '/w', '/d']]
  ]) {
    resource(left[0]); resource(right[0]);
    const leftArchive = left.join(':');
    const rightArchive = right.join(':');
    files.set(norm(left[0] + '/core.zip'), leftArchive);
    files.set(norm(right[0] + '/core.zip'), rightArchive);
    const expectedLeft = files.get(norm(left[0] + '/core.zip'));
    const expectedRight = files.get(norm(right[0] + '/core.zip'));
    files.delete(norm(left[2]) + '/cores/v');
    files.delete(norm(right[2]) + '/cores/v');
    hold();
    const before = counts.hash;
    const one = install(left[0], left[1], store(left[2]));
    const two = install(right[0], right[1], store(right[2]));
    await turn();
    assert.equal(counts.hash, before + 1, 'different tuples must queue before touching files');
    releaseHash();
    const first = await one;
    assert.equal(files.get(norm(left[2]) + '/cores/v'), expectedLeft);
    const second = await two;
    assert.notEqual(first, second, 'distinct keys must not share result');
    assert.equal(counts.hash, before + 2);
    assert.equal(files.get(norm(right[2]) + '/cores/v'), expectedRight);
    assert.equal(files.get(norm(right[2]) + '/cores/v/.dshm-bundled-stamp'), 'sha256:' + digest(expectedRight));
  }
  rejectLayout = true;
  const failedQueue = install('/res', '/queue-fail', store('/queue-fail'));
  const nextQueue = install('/res', '/queue-next', store('/queue-next'));
  const queueResults = await Promise.allSettled([failedQueue, nextQueue]);
  assert.equal(queueResults[0].status, 'rejected');
  assert.equal(queueResults[1].status, 'fulfilled');
  assert.equal(queueResults[1].value.installed.length, 1);
  assert.equal(maxConcurrentTransactions, 1);
  assert.equal(active, 0);
  if (report) console.log('shared staging/temp archive identities, maxConcurrentTransactions=1, failure queue continuation: PASS');
}

await verify(source, true);
if (process.argv.includes('--self-test')) {
  const mutations = [
    ['no sharing', 'if (existing !== undefined)', 'if (false)'],
    ['completed cache', 'BundledInstallState.inflight.delete(key);', ''],
    ['no normalization', 'normalizeBundledPath(resourceDir)', 'resourceDir'],
    ['missing store key', 'normalizeBundledPath(store.baseDir())', "''"],
    ['missing work key', 'normalizeBundledPath(workDir)', "''"],
    ['missing resource key', 'normalizeBundledPath(resourceDir)', "''"],
    ['delimiter key', 'JSON.stringify([normalizeBundledPath(resourceDir), normalizeBundledPath(workDir),\n    normalizeBundledPath(store.baseDir())])', "[normalizeBundledPath(resourceDir), normalizeBundledPath(workDir), normalizeBundledPath(store.baseDir())].join('|')"],
    ['weak identity', 'stamp === identity', 'stamp.length > 0']
  ];
  for (const [name, from, to] of mutations) {
    assert(source.includes(from));
    await assert.rejects(() => verify(source.replace(from, to)), undefined, name);
    console.log('mutation rejected: ' + name);
  }
  for (const [name, from, to] of [
    ['queue bypass', 'BundledInstallState.queue.then', 'Promise.resolve().then']
  ]) {
    assert(source.includes(from));
    await assert.rejects(() => verify(source.replace(from, to)), undefined, name);
    console.log('mutation rejected: ' + name);
  }
}
