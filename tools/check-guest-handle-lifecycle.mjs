import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import { getEventListeners } from 'node:events';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../hostcore/plugins/dshm-vm-bash/lib/handle.js', import.meta.url), 'utf8');

function fixture(text, delayedPid = false) {
  const timers = new Map();
  const kills = [];
  const writes = new Map();
  let complete;
  let reject;
  let calls = 0;
  let pidHook;
  let resultHook;
  const execution = new Promise((resolve, fail) => { complete = resolve; reject = fail; });
  const live = {
    exec(path, argv, timeout, poll, hooks) {
      calls++;
      pidHook = hooks.onPid;
      if (!delayedPid) pidHook(101);
      return { then(resolve, fail) { resultHook = resolve; return execution.then(resolve, fail); } };
    },
    async kill(pid, signal) { kills.push([pid, signal]); },
  };
  const module = runInNewContext(text.replace(/^import .*;\n/gm, '').replace(/^export /gm, '')
    + '\n({createVmHandle})', {
    Buffer, Promise, Date, Math, PassThrough, join, dirname, process: { env: {} },
    workPath: (path) => join('/isolated', path), mkdirSync() {},
    createWriteStream: (path) => ({ end: (data) => writes.set(path, Buffer.from(data)) }),
    setTimeout: (fn) => { const timer = { unref() {} }; timers.set(timer, fn); return timer; },
    clearTimeout: (timer) => timers.delete(timer),
  });
  const controller = new AbortController();
  const open = (acquire = async () => live) => module.createVmHandle({
    argv: ['sh', '-c', 'true'], stdio: { stdout: 'pipe', stderr: 'pipe' }, signal: controller.signal,
  }, acquire);
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const success = () => complete({ stdout: 'normal output', stderr: 'normal error', exitCode: 0, signal: null });
  return { open, controller, timers, kills, flush, success, reject, calls: () => calls,
    deliverPid: () => pidHook(101),
    replayResult: () => resultHook({ stdout: 'late output', stderr: 'late error', exitCode: 0, signal: null }),
    listeners: () => getEventListeners(controller.signal, 'abort') };
}

const cases = {
  async lateResult(text) {
    const f = fixture(text, true);
    const handle = f.open();
    await f.flush();
    f.controller.abort();
    f.deliverPid();
    f.success();
    await handle.done;
    let writes = 0;
    handle.stdout.write = () => { writes++; };
    handle.stderr.write = () => { writes++; };
    f.replayResult();
    assert.equal(writes, 0, 'settled streams must reject late result writes');
    assert.equal(handle.collected.stdout.readFrom().text, 'normal output');
  },
  async delayedPid(text) {
    for (const fails of [false, true]) {
      const f = fixture(text, true);
      const handle = f.open();
      let settled = false;
      const done = handle.done.then(() => { settled = true; }, () => { settled = true; });
      await f.flush();
      assert.equal(f.calls(), 1);
      f.controller.abort();
      await f.flush();
      assert.equal(settled, false, 'submitted command must wait for PID/result');
      assert.equal(handle.stdout.writableEnded, false);
      assert.equal(f.kills.length, 0);
      f.deliverPid();
      assert.deepEqual(f.kills, [[101, 'TERM']]);
      assert.equal(f.timers.size, 1);
      for (const [timer, fn] of f.timers) { f.timers.delete(timer); fn(); }
      assert.deepEqual(f.kills, [[101, 'TERM'], [101, 'KILL']]);
      if (fails) f.reject(new Error('cancelled guest failed'));
      else f.success();
      await done;
      assert.equal(f.listeners().length, 0);
      assert.equal(f.timers.size, 0);
      f.deliverPid();
      assert.equal(f.kills.length, 2);
      if (!fails) assert.equal(handle.collected.stdout.readFrom().text, 'normal output');
    }
  },
  async repeatedSignal(text) {
    const f = fixture(text);
    f.success();
    for (let i = 0; i < 30; i++) {
      const handle = f.open();
      await handle.done;
      assert.equal(f.listeners().length, 0, 'shared long-lived signal must not accumulate listeners');
      handle.stdout.resume();
      handle.stderr.resume();
    }
    f.controller.abort();
    assert.equal(f.kills.length, 0);
    assert.equal(f.timers.size, 0);
  },
  async pendingAcquire(text) {
    const f = fixture(text);
    let release;
    const acquire = new Promise((resolve) => { release = resolve; });
    const handle = f.open(() => acquire);
    await f.flush();
    f.controller.abort();
    assert.equal((await handle.done).signal, 'SIGTERM');
    assert.equal(f.listeners().length, 0);
    release({ exec() { throw new Error('cancelled acquisition must not execute'); } });
    await f.flush();
    assert.equal(f.kills.length, 0);
    assert.equal(f.timers.size, 0);
  },
  async success(text) {
    const f = fixture(text);
    const handle = f.open();
    await f.flush();
    assert.equal(f.listeners().length, 1);
    f.success();
    assert.equal((await handle.done).exitCode, 0);
    assert.equal(f.listeners().length, 0);
    f.controller.abort();
    handle.terminate();
    assert.equal(f.kills.length, 0);
    assert.equal(handle.collected.stdout.readFrom().text, 'normal output');
    const chunks = [];
    for await (const chunk of handle.stdout) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'normal output');
  },
  async failure(text) {
    for (const acquisition of [false, true]) {
      const f = fixture(text);
      const error = new Error('guest failed');
      const handle = acquisition ? f.open(async () => { throw error; }) : f.open();
      const rejected = assert.rejects(handle.done, /guest failed/);
      await f.flush();
      if (!acquisition) f.reject(error);
      await rejected;
      assert.equal(f.listeners().length, 0);
      f.controller.abort();
      handle.terminate();
      assert.equal(f.kills.length, 0);
      assert.ok(handle.collected.stderr.readFrom().text.includes('guest failed'));
      assert.equal(handle.stdout.destroyed, true);
    }
  },
  async timerCleanup(text) {
    for (const fails of [false, true]) {
      const f = fixture(text);
      const handle = f.open();
      const done = handle.done.catch(() => undefined);
      await f.flush();
      f.controller.abort();
      assert.deepEqual(f.kills, [[101, 'TERM']]);
      assert.equal(f.timers.size, 1);
      if (fails) f.reject(new Error('stopped'));
      else f.success();
      await done;
      assert.equal(f.timers.size, 0, 'settlement must clear escalation timer');
      assert.equal(f.listeners().length, 0);
      handle.terminate();
      assert.equal(f.kills.length, 1);
    }
  },
  async escalation(text) {
    const f = fixture(text);
    const handle = f.open();
    await f.flush();
    f.controller.abort();
    for (const [timer, fn] of f.timers) { f.timers.delete(timer); fn(); }
    assert.deepEqual(f.kills, [[101, 'TERM'], [101, 'KILL']]);
    f.success();
    await handle.done;
  },
  async terminalAbort(text) {
    const f = fixture(text);
    const handle = f.open();
    await f.flush();
    const stale = f.listeners()[0];
    f.success();
    await handle.done;
    stale();
    assert.equal(f.kills.length, 0);
    assert.equal(f.timers.size, 0, 'terminal abort must not schedule escalation');
  },
  async preAbort(text) {
    const f = fixture(text);
    f.controller.abort();
    const handle = f.open();
    assert.equal((await handle.done).signal, 'SIGTERM');
    await f.flush();
    assert.equal(f.calls(), 0);
    assert.equal(f.listeners().length, 0);
    assert.equal(f.timers.size, 0);
  },
};

if (process.argv.includes('--self-test')) {
  const mutations = [
    ['abort listener retained', (text) => text.replace("signal?.removeEventListener('abort', onAbort);", ''), 'success'],
    ['success cleanup omitted', (text) => text.replace('    cleanup();', ''), 'success'],
    ['failure cleanup omitted', (text) => text.replace('    cleanup();\n    //', '    //'), 'failure'],
    ['timer retained', (text) => text.replace('clearTimeout(killTimer);', ''), 'timerCleanup'],
    ['terminal abort guard omitted', (text) => text.replace("const onAbort = () => {\n    if (settled) return;", 'const onAbort = () => {'), 'terminalAbort'],
    ['terminal kill guard omitted', (text) => text.replace('if (!settled && live !== null', 'if (live !== null'), 'success'],
    ['escalation omitted', (text) => text.replace("if (!settled) killGuest('KILL');", ''), 'escalation'],
    ['waiting PID settles early', (text) => text.replace("if (!submitted) finish(null, 'SIGTERM');", "finish(null, 'SIGTERM');"), 'delayedPid'],
    ['late PID only TERM', (text) => text.replace('if (cancelled) onAbort();', "if (cancelled) qga.kill(pid, 'TERM');"), 'delayedPid'],
    ['late result writes after settlement', (text) => text.replace('}).then((result) => {\n          if (settled) return;', '}).then((result) => {'), 'lateResult'],
  ];
  for (const [label, mutate, name] of mutations) {
    const changed = mutate(source);
    assert.notEqual(changed, source, 'mutation anchor: ' + label);
    await assert.rejects(cases[name](changed), undefined, 'mutant must be detected: ' + label);
    console.log('MUTANT caught ' + label);
  }
}

for (const [name, test] of Object.entries(cases)) {
  await test(source);
  console.log('PASS ' + name);
}
