#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const source = fs.readFileSync(new URL('../hostruntime/src/main/ets/core/BundledCore.ets', import.meta.url), 'utf8');
const namingSource = fs.readFileSync(new URL('../hostruntime/src/main/ets/core/Naming.ets', import.meta.url), 'utf8');
const isSafeVersion = vm.runInNewContext(stripTypeScriptTypes(namingSource.replaceAll('export ', '')) + '\nisSafeVersion');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const turn = () => new Promise(resolve => setImmediate(resolve));

const storeSource = fs.readFileSync(new URL('../hostruntime/src/main/ets/core/CoreStore.ets', import.meta.url), 'utf8');
const typesSource = fs.readFileSync(new URL('../hostruntime/src/main/ets/core/Types.ets', import.meta.url), 'utf8');

function verifyRetireMethod(text) {
  const start = text.indexOf('  retireUnused(');
  const end = text.indexOf('  async evict(', start);
  const selection = typesSource.slice(typesSource.indexOf('export function evictionCandidates('));
  assert(start !== -1 && end > start);
  const stable = '/cores/';
  const directories = new Set(['1.0.0', '1.0.1', '1.0.2', '1.0.3', '0.0.1', '0.0.2', '0.0.3']);
  const collision = '0.0.3.retired-22.tmp';
  const links = new Set(['0.0.2']);
  directories.add(collision);
  const renames = [];
  const io = {
    lstatSync: path => ({ isDirectory: () => !links.has(path.slice(stable.length)) }),
    statSync: () => ({ isDirectory: () => true }),
    accessSync: path => directories.has(path.slice(stable.length)),
    renameSync: (from, to) => {
      assert(directories.delete(from.slice(stable.length)));
      assert(!directories.has(to.slice(stable.length)));
      directories.add(to.slice(stable.length));
      renames.push([from, to]);
    }
  };
  const textWithState = namingSource.replaceAll('export ', '') + '\n' +
    selection.replace('export ', '') + '\nclass Store {\n' + text.slice(start, end) + '\n}';
  const Store = vm.runInNewContext(stripTypeScriptTypes(textWithState) + '\nStore', {
    fs: io, DOMAIN: 0, TAG: 'test', hilog: { warn() {} }, Date: { now: () => 22 }
  });
  const retire = new Store();
  retire.coreDir = version => stable + version;
  retire.listInstalled = () => [...directories].filter(x => !x.endsWith('.tmp'));
  retire.readState = () => ({ current: 'absent', previous: '1.0.1', history: ['1.0.2'] });
  const expected = ['1.0.0', '0.0.1'];
  assert.deepEqual(Array.from(retire.retireUnused(1, ['1.0.2'])), expected);
  assert.deepEqual(renames, expected.map(v => [stable + v, stable + v + '.retired-22.tmp']));
  for (const v of ['1.0.1', '1.0.2', '1.0.3', '0.0.2', '0.0.3', collision]) {
    assert(directories.has(v), 'preserve ' + v);
  }
}

async function verify(text, report = false) {
  const files = new Map();
  const directories = new Set();
  const links = new Set();
  const removals = [];
  const failedRemovals = new Set();
  const timers = new Map();
  const counts = { hash: 0, stage: 0, copy: 0, evict: 0 };
  const staging = new Map();
  let active = 0;
  let maxConcurrentTransactions = 0;
  let rejectLayout = false;
  let failStage = false;
  let failCommit = false;
  let failRetirement = false;
  let failRollback = false;
  let expectedRetirementStamp;
  let removalStarted;
  let removalBarrier = Promise.resolve();
  let timerId = 0;
  let archiveChangeTime = 1;
  let archiveChangeNs = 1n;
  let nonRegular = '';
  let systemHashUnavailable = false;
  let releaseHash;
  let barrier = Promise.resolve();
  const norm = p => p.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  const listFiles = p => {
    const prefix = norm(p) + '/';
    return [...files.keys()].filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length))
      .filter(name => !name.includes('/'));
  };
  const statArchive = p => ({
    size: files.get(norm(p)).length, ino: 1n, mtime: 1, ctime: archiveChangeTime,
    mtimeNs: 1n, ctimeNs: archiveChangeNs, isFile: () => norm(p) !== nonRegular,
    isDirectory: () => directories.has(norm(p)), isSymbolicLink: () => links.has(norm(p)),
  });
  function treeNames(path) {
    return [...files.keys()].filter(name => name === path || name.startsWith(path + '/'));
  }
  function addDirectory(path, value = 'DIR') {
    files.set(path, value);
    directories.add(path);
  }
  const readDigest = async p => {
    counts.hash++;
    await barrier;
    return digest(files.get(norm(p)));
  };
  const io = {
    OpenMode: {}, accessSync: p => files.has(norm(p)),
    listFileSync: listFiles, listFile: async p => listFiles(p),
    statSync: p => links.has(norm(p)) ? { isDirectory: () => true } : statArchive(p),
    lstatSync: statArchive, lstat: async p => statArchive(p),
    readTextSync: p => files.get(norm(p)),
    copyFile: async (a, b) => { counts.copy++; files.set(norm(b), files.get(norm(a))); await turn(); },
    unlinkSync: p => files.delete(norm(p)),
    renameSync: (a, b) => {
      const from = norm(a), to = norm(b);
      assert(files.has(from));
      if (/\.stale-\d+\.tmp$/.test(from)) {
        if (/\.retired-\d+\.tmp$/.test(to)) {
          if (expectedRetirementStamp !== undefined) {
            assert.equal(files.get(from.replace(/\.stale-\d+\.tmp$/, '/.dshm-bundled-stamp')),
              expectedRetirementStamp, 'retirement requires the new tree to be committed and stamped');
          }
          if (failRetirement) throw new Error('RETIREMENT_FAILURE');
        } else if (failRollback) {
          throw new Error('ROLLBACK_FAILURE');
        }
      }
      for (const name of treeNames(from)) {
        const moved = to + name.slice(from.length);
        files.set(moved, files.get(name));
        files.delete(name);
        if (directories.delete(name)) directories.add(moved);
      }
    },
    openSync: p => ({ fd: norm(p) }), writeSync: (fd, value) => files.set(fd, value), closeSync() {},
    rmdir: async p => {
      const path = norm(p);
      removals.push(path);
      removalStarted?.(path);
      await removalBarrier;
      if (failedRemovals.has(path)) throw new Error('REMOVAL_FAILURE');
      for (const name of treeNames(path)) {
        files.delete(name);
        directories.delete(name);
      }
    }
  };
  const code = text.replace(/^import[\s\S]*?from '[^']+';\n/gm, '').replaceAll('export ', '');
  const { installBundledCores: install, preverifyBundledCore: preverify, scheduleRetiredCoreCleanup: scheduleCleanup } =
    vm.runInNewContext(stripTypeScriptTypes(code, { mode: 'strip' }) + '\n({ installBundledCores, preverifyBundledCore, scheduleRetiredCoreCleanup })', {
    fs: io, process: { pid: 42 }, isSafeVersion, parseArchiveName: name => name === 'core.zip' ? 'v' : '',
    hilog: { info() {}, warn() {}, error() {} },
    setTimeout(fire, delay) { timers.set(++timerId, { fire, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    hash: { async hash(p) {
      if (systemHashUnavailable) throw new Error('HASH_UNAVAILABLE');
      return readDigest(p);
    } },
    sha256OfFile: readDigest,
  });
  function store(base) {
    const root = norm(base);
    let archive;
    return {
      baseDir: () => base, coresDir: () => root + '/cores', coreDir: version => root + '/cores/' + version,
      ensureLayout: () => {
        if (rejectLayout) { rejectLayout = false; throw new Error('LAYOUT_FAILURE'); }
        active++;
        maxConcurrentTransactions = Math.max(maxConcurrentTransactions, active);
        addDirectory(root + '/cores');
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
        if (failCommit) return { ok: false, message: 'COMMIT_FAILURE' };
        addDirectory(root + '/cores/v', staging.get(root));
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

  await install('/res', '/work', store('/prever-data'));
  const beforePreverify = counts.hash;
  const prepared = preverify('/res///');
  const unchanged = await install('/res', '/work', store('/prever-data'), prepared);
  assert.equal(unchanged.skipped.length, 1);
  assert.equal(counts.hash, beforePreverify + 1, 'verified archive must hash exactly once');

  const old = await preverify('/res');
  archiveChangeTime++;
  files.set('/res/core.zip', 'QRS');
  const replaced = await install('/res', '/work', store('/prever-data'), Promise.resolve(old));
  assert.equal(replaced.installed.length, 1, 'changed archive identity must trigger a full hash and install');
  assert.equal(files.get('/prever-data/cores/v/.dshm-bundled-stamp'), 'sha256:' + digest('QRS'));

  hold();
  const changing = preverify('/res');
  archiveChangeTime++;
  releaseHash();
  assert.equal(await changing, undefined, 'an archive changed while hashing must not be reused');

  systemHashUnavailable = true;
  const beforeFallback = counts.hash;
  const fallback = await install('/res', '/work', store('/prever-data'), preverify('/res'));
  assert.equal(fallback.skipped.length, 1);
  assert.equal(counts.hash, beforeFallback + 1, 'preflight failure must fall back to full verification');
  if (report) console.log('read-only preverification: reuse, changed file, and system hash fallback: PASS');

  systemHashUnavailable = false;
  const signed = '/data/storage/el1/bundle/hostruntime/resources/resfile';
  const zip = signed + '/core.zip';
  const cache = '/cache/bundled-identity';
  resource(signed);
  const generation = 'installed-1';
  let expectedHashes = counts.hash + 1;
  const first = await preverify(signed, cache, generation);
  assert.equal(first.identity, 'sha256:' + digest('ABC'));
  assert.equal(counts.hash, expectedHashes);
  assert(files.has(cache), 'a full hash must populate the identity record');
  const hit = await preverify(signed, cache, generation);
  assert.equal(hit.identity, first.identity);
  assert.equal(counts.hash, expectedHashes, 'the same signed file should reuse its digest');
  await install(signed, '/work', store('/memo-data'), Promise.resolve(hit));
  assert.equal(counts.hash, expectedHashes, 'install should consume the revalidated digest');

  files.set(zip, 'DEF');
  archiveChangeNs++;
  const changed = await preverify(signed, cache, generation);
  assert.equal(changed.identity, 'sha256:' + digest('DEF'));
  assert.equal(counts.hash, ++expectedHashes, 'nanosecond changes must invalidate a same-length file');
  archiveChangeNs++;
  files.set(zip, 'GHI');
  const updated = await install(signed, '/work', store('/memo-data'), Promise.resolve(changed));
  assert.equal(updated.installed.length, 1);
  assert.equal(counts.hash, ++expectedHashes, 'install must recheck nanosecond timestamps');

  await preverify(signed, cache, generation);
  expectedHashes++;
  files.set(zip, 'JKL');
  const newGeneration = await preverify(signed, cache, 'installed-2');
  assert.equal(newGeneration.identity, 'sha256:' + digest('JKL'));
  assert.equal(counts.hash, ++expectedHashes, 'a new installation always computes a new digest');

  files.set(cache, 'invalid record');
  assert.equal((await preverify(signed, cache, 'installed-2')).identity, newGeneration.identity);
  assert.equal(counts.hash, ++expectedHashes, 'an invalid record must fall back to a full digest');
  nonRegular = zip;
  await preverify(signed, cache, 'installed-2');
  assert.equal(counts.hash, ++expectedHashes, 'links cannot use persistent metadata verification');
  nonRegular = '';
  await preverify('/res', cache, 'installed-2');
  await preverify('/res', cache, 'installed-2');
  assert.equal(counts.hash, expectedHashes + 2, 'a writable resource path always requires a full digest');
  if (report) console.log('Persistent bundled identity: reuse, replacement, nanoseconds and fallback: PASS');

  async function runCleanupTimers() {
    const scheduled = [...timers.values()];
    assert(scheduled.length > 0, 'the install must schedule background cleanup');
    timers.clear();
    for (const { fire, delay } of scheduled) {
      assert.equal(delay, 8000, 'cleanup must give startup a head start');
      fire();
    }
    await turn();
  }

  timers.clear();
  const cleanupRes = '/cleanup-res';
  const cleanupData = '/cleanup-data';
  const installCleanup = () => install(cleanupRes, '/cleanup-work', store(cleanupData));
  const cores = cleanupData + '/cores';
  resource(cleanupRes);
  assert.equal((await installCleanup()).installed.length, 1);
  files.set(cleanupRes + '/core.zip', 'DEF');
  const beforeRetirement = removals.length;
  expectedRetirementStamp = 'sha256:' + digest('DEF');
  assert.equal((await installCleanup()).installed.length, 1);
  assert.equal(files.get(cores + '/v'), 'DEF');
  const retired = listFiles(cores).filter(name => /^v\.retired-\d+\.tmp$/.test(name));
  assert.equal(retired.length, 1, 'replacement must return with the superseded tree retired');
  const retiredPath = cores + '/' + retired[0];
  assert.equal(files.get(retiredPath), 'ABC', 'the old tree must exist until background cleanup');
  assert.equal(removals.length, beforeRetirement, 'retirement must not remove a tree during installation');

  const recover = cores + '/0.2.2-rc.5+dshm.1.retired-123.tmp';
  const retry = cores + '/v2.retired-456.tmp';
  const protectedDirs = [
    cores + '/v.stale-123.tmp',
    cores + '/v..unsafe.retired-123.tmp',
    cores + '/v.retired-invalid.tmp',
    cores + '/v.retired-123.tmp-extra',
  ];
  const protectedFile = cores + '/file.retired-123.tmp';
  const protectedLink = cores + '/link.retired-123.tmp';
  for (const path of [recover, retry, ...protectedDirs]) addDirectory(path);
  files.set(protectedFile, 'FILE');
  files.set(protectedLink, 'LINK');
  links.add(protectedLink);
  failedRemovals.add(retry);

  hold();
  const concurrent = install('/res', '/cleanup-concurrent-work', store('/cleanup-concurrent-data'));
  await turn();
  await runCleanupTimers();
  assert.equal(removals.length, beforeRetirement, 'background cleanup must wait for the active install');
  releaseHash();
  await concurrent;
  await turn();
  assert.deepEqual(removals.slice(beforeRetirement).sort(), [retiredPath, recover, retry].sort());
  assert(!files.has(retiredPath));
  assert(!files.has(recover), 'a known retired directory must be recovered without an in-memory registration');
  assert(files.has(retry), 'a failed cleanup must leave the directory for a later run');
  assert([...protectedDirs, protectedFile, protectedLink].every(path => files.has(path)));

  failedRemovals.delete(retry);
  const beforeRetry = removals.length;
  assert.equal((await installCleanup()).skipped.length, 1);
  await runCleanupTimers();
  assert.deepEqual(removals.slice(beforeRetry), [retry]);
  assert(!files.has(retry), 'a no-op install must retry previous cleanup');
  if (report) console.log('Retired core cleanup: delayed, serialized, path/type checked and retried: PASS');

  failRetirement = true;
  files.set(cleanupRes + '/core.zip', 'GHI');
  expectedRetirementStamp = 'sha256:' + digest('GHI');
  let releaseRemoval;
  removalBarrier = new Promise(resolve => { releaseRemoval = resolve; });
  const firstRemoval = new Promise(resolve => { removalStarted = resolve; });
  const beforeFallbackRemoval = removals.length;
  const fallbackInstall = installCleanup();
  let fallbackFinished = false;
  const stale = await Promise.race([firstRemoval, fallbackInstall.then(() => {
    fallbackFinished = true;
    return '';
  })]);
  assert(stale.startsWith(cores + '/v.') && /^v\.stale-\d+\.tmp$/.test(stale.slice(cores.length + 1)),
    'failed retirement must await removal of the exact superseded tree');
  assert.equal(files.get(stale), 'DEF');
  assert.equal(files.get(cores + '/v'), 'GHI');
  await turn();
  assert(!fallbackFinished, 'fallback must wait until the original removal completes');
  releaseRemoval();
  removalStarted = undefined;
  assert.equal((await fallbackInstall).installed.length, 1);
  assert.deepEqual(removals.slice(beforeFallbackRemoval), [stale]);
  assert(!files.has(stale));

  failRetirement = false;
  expectedRetirementStamp = undefined;
  failCommit = true;
  files.set(cleanupRes + '/core.zip', 'JKL');
  const rollback = await installCleanup();
  assert.equal(rollback.failed.length, 1);
  assert.match(rollback.failed[0], /COMMIT_FAILURE/);
  assert.equal(files.get(cores + '/v'), 'GHI', 'a failed commit must restore the previous tree');
  assert.equal(files.get(cores + '/v/.dshm-bundled-stamp'), 'sha256:' + digest('GHI'));

  failRollback = true;
  const failedRollback = await installCleanup();
  assert.equal(failedRollback.failed.length, 1);
  assert.match(failedRollback.failed[0], /ROLLBACK_FAILURE/);
  const recoveryTree = listFiles(cores).map(name => cores + '/' + name)
    .find(path => /^v\.stale-\d+\.tmp$/.test(path.slice(cores.length + 1)) && files.get(path) === 'GHI');
  assert(recoveryTree, 'a failed rollback must retain its old tree as stale');
  const beforeFailedRollbackCleanup = removals.length;
  await runCleanupTimers();
  assert.equal(removals.length, beforeFailedRollbackCleanup, 'failed commits must never retire or delete the old tree');
  assert.equal(files.get(recoveryTree), 'GHI');
  if (report) console.log('Retirement failure: exact awaited fallback, successful rollback, and stale recovery preserved: PASS');

  failStage = failCommit = failRetirement = failRollback = false;
  const deferred = store('/paint-data');
  const purgeable = '/paint-data/cores/0.0.1';
  const hidden = purgeable + '.retired-123.tmp';
  addDirectory(purgeable, 'unused');
  const timerCount = timers.size;
  const removalsBeforePaint = removals.length;
  deferred.retireUnused = (keep, protectedVersions) => {
    assert.equal(keep, 0);
    assert.deepEqual(Array.from(protectedVersions), ['v']);
    assert.equal(active, 1);
    io.renameSync(purgeable, hidden);
    active--;
    return ['0.0.1'];
  };
  const installed = await install('/res', '/paint-work', deferred, undefined, true);
  assert.equal(installed.failed.length, 0, installed.note);
  assert(!files.has(purgeable));
  assert.equal(files.get(hidden), 'unused');
  assert.equal(timers.size, timerCount, 'deferred retirement waits for workbench notification');
  assert.equal(removals.length, removalsBeforePaint);
  scheduleCleanup(deferred);
  assert.equal(timers.size, timerCount + 1);
  await runCleanupTimers();
  assert(!files.has(hidden));
  assert.deepEqual(removals.slice(removalsBeforePaint), [hidden]);

  const skipped = store('/failed-paint-data');
  const good = '/failed-paint-data/cores/0.0.1';
  addDirectory(good, 'old');
  let attemptedRetirement = false;
  skipped.retireUnused = () => { attemptedRetirement = true; return []; };
  failStage = true;
  const failed = await install('/res', '/failed-paint-work', skipped, undefined, true);
  failStage = false;
  active--;
  assert.equal(failed.failed.length, 1);
  assert(!attemptedRetirement, 'failed install must leave old versions in place');
  assert.equal(files.get(good), 'old');
  if (report) console.log('Deferred eviction: retire after staging, delete after paint, preserve on failure: PASS');

}

await verify(source, true);
verifyRetireMethod(storeSource);
console.log('Cross-version retirement keeps active, rollback, symlink and occupied destinations safe: PASS');
if (process.argv.includes('--self-test')) {
  assert.throws(() => verifyRetireMethod(storeSource.replace('fs.lstatSync(source).isDirectory()', 'fs.statSync(source).isDirectory()')));
  assert.throws(() => verifyRetireMethod(storeSource.replace(' || fs.accessSync(backup)', '')));
  const mutations = [
    ['premature cross-version cleanup', 'if (deferEviction) {',
      'if (deferEviction) { scheduleRetiredCoreCleanup(store);'],
    ['retire after failed installation', 'if (result.failed.length === 0) {',
      'if (true) {'],
    ['no sharing', 'if (existing !== undefined)', 'if (false)'],
    ['completed cache', 'BundledInstallState.inflight.delete(key);', ''],
    ['no normalization', 'JSON.stringify([normalizeBundledPath(resourceDir)', 'JSON.stringify([resourceDir'],
    ['missing store key', 'normalizeBundledPath(store.baseDir())', "''"],
    ['missing work key', 'normalizeBundledPath(workDir)', "''"],
    ['missing resource key', 'JSON.stringify([normalizeBundledPath(resourceDir)', "JSON.stringify([''"],
    ['delimiter key', 'JSON.stringify([normalizeBundledPath(resourceDir), normalizeBundledPath(workDir),\n    normalizeBundledPath(store.baseDir())])', "[normalizeBundledPath(resourceDir), normalizeBundledPath(workDir), normalizeBundledPath(store.baseDir())].join('|')"],
    ['unchecked installation', 'JSON.stringify([installation, path,', 'JSON.stringify([path,'],
    ['unchecked archive nanoseconds', '    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;', '    true;'],
    ['writable cache input', " || !path.startsWith('/data/storage/el1/bundle/')", ''],
    ['weak identity', 'stamp === identity', 'stamp.length > 0'],
    ['changed during hashing', '!sameArchive(before, after) || ', ''],
    ['stale preverification', 'verified.path === src && sameArchive(verified.stat, stat)', 'verified.path === src'],
    ['cleanup races install', 'BundledInstallState.queue = BundledInstallState.queue.then',
      'BundledInstallState.queue = Promise.resolve().then'],
    ['arbitrary retired version', 'match === null || !isSafeVersion(match[1])', 'match === null'],
    ['cleanup touches rollback tree', '/^(.+)\\.retired-\\d+\\.tmp$/.exec(name)', '/^(.+)\\.(?:retired|stale)-\\d+\\.tmp$/.exec(name)'],
    ['cleanup follows symbolic link', 'fs.lstatSync(path).isDirectory()', 'fs.statSync(path).isDirectory()'],
    ['skip cleanup after a no-op install', 'scheduleRetiredCoreCleanup(store);',
      'if (result.installed.length > 0) scheduleRetiredCoreCleanup(store);'],
    ['no retirement fallback', 'outcome.stale = stale;', ''],
    ['unawaited retirement fallback', 'await fs.rmdir(stale);', 'void fs.rmdir(stale);'],
    ['retire before the commit is confirmed', 'if (!committed.ok) {',
      "if (!committed.ok && stale.length > 0) fs.renameSync(stale, stale.replace('.stale-', '.retired-'));\n    if (!committed.ok) {"]
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
