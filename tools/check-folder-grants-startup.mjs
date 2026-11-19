#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const source = fs.readFileSync('platform/src/main/ets/system/FolderGrants.ets', 'utf8');
const grants = (count = 16) => Array.from({ length: count }, (_, i) => ({
  uri: `file://docs/${i}`, path: `/folder/${i}`, at: i
}));
const context = (filesDir = '/app/files', name = 'com.example.app') => ({
  filesDir, applicationInfo: { name }
});
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };

function load(text, list = grants(), behavior = () => 'hang') {
  let now = 0;
  let sequence = 0;
  let active = 0;
  let peak = 0;
  let reads = 0;
  let preferenceFailure = false;
  let diagnosticFailure = false;
  const timers = new Map();
  const calls = [];
  const logs = [];
  const schedule = (callback, delay) => {
    const id = ++sequence;
    timers.set(id, { at: now + delay, callback });
    return id;
  };
  const code = stripTypeScriptTypes(text.replace(/^import .*;\r?\n/gm, '')
    .replace(/\bexport /g, ''), { mode: 'strip', disableExperimentalWarning: true });
  const api = vm.runInNewContext(`${code}\n({ restoreFolderGrants, withWatchdog, restoresInFlight })`, {
    setTimeout: schedule,
    clearTimeout: id => timers.delete(id),
    preferences: { async getPreferences() {
      reads++;
      if (preferenceFailure) throw new Error('prefs');
      return { async get() { return JSON.stringify(list); } };
    } },
    fileShare: {
      OperationMode: { READ_MODE: 1, WRITE_MODE: 2 },
      activatePermission(policies) {
        assert.equal(policies.length, 1);
        assert.equal(policies[0].operationMode, 3);
        const call = { uri: policies[0].uri, at: now };
        calls.push(call);
        const result = behavior(call, calls.length - 1);
        active++;
        peak = Math.max(peak, active);
        return new Promise((resolve, reject) => {
          call.resolve = () => { active--; resolve(); };
          call.reject = () => { active--; reject(Object.assign(new Error('denied'), { code: 13900001 })); };
          if (result === 'ok') call.resolve();
          if (result === 'fail') call.reject();
          if (typeof result === 'number') schedule(call.resolve, result);
        });
      }
    },
    fileIo: {
      OpenMode: { CREATE: 1, READ_WRITE: 2, APPEND: 4 },
      openSync() { return { fd: 1 }; },
      writeSync(fd, line) { logs.push(line); }, closeSync() {}
    },
    hilog: { info() {}, warn() { if (diagnosticFailure) throw new Error('diagnostic'); } }
  });
  return {
    ...api, calls, logs, timers,
    get now() { return now; }, get peak() { return peak; }, get reads() { return reads; },
    failRestore(value) { preferenceFailure = value; diagnosticFailure = value; },
    async tick(ms) {
      const end = now + ms;
      await flush();
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await flush();
      }
      now = end;
      await flush();
    }
  };
}

async function suite(text, report = false) {
  const all = load(text);
  let finished = false;
  const pending = all.restoreFolderGrants(context()).then(value => { finished = true; return value; });
  await flush();
  assert.equal(all.calls.length, 4);
  await all.tick(11999);
  assert.equal(finished, false);
  await all.tick(1);
  assert.match(await pending, /^0\/16 /);
  assert.equal(all.now, 12000);
  assert.equal(all.calls.length, 16);
  assert.equal(all.peak, 16);
  assert.equal(all.timers.size, 0);
  assert.equal(all.restoresInFlight.size, 0);
  assert.deepEqual(all.calls.map(c => c.at), Array.from({ length: 16 }, (_, i) => Math.floor(i / 4) * 3000));

  const fast = load(text, grants(), () => 'ok');
  assert.match(await fast.restoreFolderGrants(context()), /^16\/16 /);
  assert.equal(fast.now, 0);
  assert.equal(fast.peak <= 4, true);
  assert.equal(fast.timers.size, 0);
  await fast.restoreFolderGrants(context());
  assert.equal(fast.calls.length, 32);
  assert.equal(fast.reads, 2);

  const getters = load(text, grants(1), () => 'ok');
  for (const broken of [
    { get filesDir() { throw new Error('filesDir getter'); } },
    { filesDir: '/app/files', get applicationInfo() { throw new Error('applicationInfo getter'); } },
    { filesDir: '/app/files', applicationInfo: { get name() { throw new Error('name getter'); } } }
  ]) {
    let rejection;
    assert.doesNotThrow(() => { rejection = getters.restoreFolderGrants(broken); });
    await assert.rejects(rejection, /getter/);
    assert.equal(getters.restoresInFlight.size, 0);
  }
  assert.equal(getters.reads, 0);

  const syncThrow = load(text, grants(), (call, i) => {
    if (i === 0) throw Object.assign(new Error('sync denied'), { code: 13900001 });
    return 'ok';
  });
  assert.match(await syncThrow.restoreFolderGrants(context()), /^15\/16 .*\/folder\/0=失败\(13900001 sync denied\)/);
  assert.equal(syncThrow.calls.length, 16);
  assert.equal(syncThrow.now, 0);
  assert.equal(syncThrow.timers.size, 0);
  assert.equal(syncThrow.restoresInFlight.size, 0);

  const mixed = load(text, grants(), (call, i) => i === 0 ? 'hang' : i === 1 ? 'fail' : 25);
  const mixedResult = mixed.restoreFolderGrants(context());
  await mixed.tick(2999);
  assert.equal(mixed.calls.length, 16);
  await mixed.tick(1);
  const summary = await mixedResult;
  assert.match(summary, /^14\/16 /);
  assert.match(summary, /\/folder\/0=超时 \| \/folder\/1=失败\(13900001 denied\) \| \/folder\/2=ok/);
  assert.equal(mixed.timers.size, 0);
  const logCount = mixed.logs.length;
  mixed.calls[0].resolve();
  await flush();
  assert.equal(mixed.logs.length, logCount);
  assert.equal(mixed.restoresInFlight.size, 0);

  const shared = load(text, grants(1));
  const first = shared.restoreFolderGrants(context());
  assert.equal(shared.restoreFolderGrants(context()), first);
  const otherDir = shared.restoreFolderGrants(context('/other/files'));
  const otherApp = shared.restoreFolderGrants(context('/app/files', 'com.other.app'));
  assert.notEqual(otherDir, first);
  assert.notEqual(otherApp, first);
  await flush();
  assert.equal(shared.calls.length, 3);
  await shared.tick(3000);
  await Promise.all([first, otherDir, otherApp]);
  assert.equal(shared.restoresInFlight.size, 0);
  const retry = shared.restoreFolderGrants(context());
  await flush();
  assert.equal(shared.calls.length, 4);
  shared.calls[0].reject();
  await flush();
  assert.equal(shared.restoresInFlight.size, 1);
  await shared.tick(3000);
  await retry;

  const duplicateList = grants(2);
  duplicateList[1].uri = duplicateList[0].uri;
  const duplicates = load(text, duplicateList, () => 'ok');
  assert.match(await duplicates.restoreFolderGrants(context()), /^2\/2 /);
  assert.equal(duplicates.calls.length, 2);
  assert.equal(duplicates.calls[0].uri, duplicates.calls[1].uri);

  const failed = load(text, grants(1), () => 'ok');
  failed.failRestore(true);
  await assert.rejects(failed.restoreFolderGrants(context()), /diagnostic/);
  assert.equal(failed.restoresInFlight.size, 0);
  failed.failRestore(false);
  assert.match(await failed.restoreFolderGrants(context()), /^1\/1 /);

  const empty = load(text, []);
  assert.equal(await empty.restoreFolderGrants(context()), '无已登记目录');
  assert.equal(empty.calls.length, 0);
  assert.equal(empty.restoresInFlight.size, 0);

  const watchdog = load(text, []);
  let resolveLate;
  let rejectLate;
  let settlements = 0;
  const late = watchdog.withWatchdog(new Promise(resolve => { resolveLate = resolve; }), 3000)
    .then(value => { settlements++; return value; });
  const lateFailure = watchdog.withWatchdog(new Promise((resolve, reject) => { rejectLate = reject; }), 3000)
    .then(value => { settlements++; return value; });
  await watchdog.tick(3000);
  assert.equal(await late, undefined);
  assert.equal(await lateFailure, undefined);
  resolveLate(true);
  rejectLate(new Error('late'));
  await flush();
  assert.equal(settlements, 2);
  assert.equal(watchdog.timers.size, 0);
  if (report) console.log('PASS production restore/activate: 4 watchdog slots; 16 hangs=12000ms, underlying API peak=16 (not cancelled); immediate success=0ms; mixed 14 ok/1 failure/1 timeout=3000ms; getter rejection, API synchronous throw, single-flight, identity isolation, retry, duplicates, timer cleanup, late callbacks');
}

await suite(source, true);
const serial = load(source.replace('RESTORE_WORKERS: number = 4', 'RESTORE_WORKERS: number = 1'));
const serialResult = serial.restoreFolderGrants(context());
await serial.tick(48000);
assert.match(await serialResult, /^0\/16 /);
assert.equal(serial.calls.at(-1).at, 45000);
console.log('PASS virtual serial control: 16 x 3000ms=48000ms; production 4 watchdog slots=12000ms (75% less watchdog wait)');

if (process.argv.includes('--self-test')) {
  const mutations = [
    ['serial regression', source.replace('RESTORE_WORKERS: number = 4', 'RESTORE_WORKERS: number = 1')],
    ['timer leak', source.replaceAll('clearTimeout(timer);', '')],
    ['permanent cache', source.replaceAll('restoresInFlight.delete(key);', '')],
    ['identity collision', source.replace('context.filesDir, context.applicationInfo.name', 'context.filesDir')]
  ];
  for (const [name, mutant] of mutations) {
    assert.notEqual(mutant, source);
    await assert.rejects(suite(mutant), undefined, name);
    console.log(`PASS self-test rejects ${name}`);
  }
}
