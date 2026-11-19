import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const main = readFileSync(new URL('../hostcore/app/main.js', import.meta.url), 'utf8');
const timers = readFileSync(new URL('../hostcore/plugins/dshm-ptc-runtime-inproc/lib/vm-run.js', import.meta.url), 'utf8');
const DAY = 86400000;
const NOW = 1800000000000;
const usagePath = '/files/dsh/home/card-usage.jsonl';
const row = (n, t = NOW) => ({ t, in: n, out: 2 });
const line = (n, t) => JSON.stringify(row(n, t)) + '\n';

function host(text, initial, failures = {}) {
  const start = text.indexOf('function registerCardState(ctx) {');
  const end = text.indexOf('\n/**', start);
  assert.ok(start >= 0 && end > start);
  const files = new Map(initial === undefined ? [] : [[usagePath, Buffer.from(initial)]]);
  const timeouts = [];
  const intervals = [];
  const logs = [];
  const reads = [];
  let now = NOW;
  let event;
  let closed = 0;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = {
    path, Buffer, Date: Clock, HOME_DIR: '/files/dsh/home', SANDBOX_HOME: '/files',
    process: { env: {} }, diag: message => logs.push(message), stage() {},
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return { unref() {} }; },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return { unref() {} }; },
    fs: {
      constants: { W_OK: 2 }, accessSync() {},
      existsSync: p => files.has(p),
      lstatSync() { throw new Error('ENOENT'); },
      readFileSync: (p, encoding) => {
        assert.notEqual(p, usagePath, 'ledger must not be read as one allocation');
        if (!files.has(p)) throw new Error('ENOENT');
        return encoding ? files.get(p).toString(encoding) : files.get(p);
      },
      openSync: p => { assert.equal(p, usagePath); return p; },
      fstatSync: fd => ({ size: files.get(fd).length }),
      readSync: (fd, buffer, offset, length, position) => {
        reads.push(length);
        assert.ok(length <= 65536);
        if (failures.read) throw new Error('read failure');
        return files.get(fd).copy(buffer, offset, position, position + Math.min(length, 997));
      },
      closeSync() { closed++; },
      writeFileSync: (p, body) => {
        if (failures.write && p === usagePath + '.tmp') throw new Error('write failure');
        files.set(p, Buffer.from(body));
      },
      appendFileSync: (p, body) => files.set(p, Buffer.concat([files.get(p) || Buffer.alloc(0), Buffer.from(body)])),
      renameSync: (from, to) => {
        if (failures.rename && to === usagePath) throw new Error('rename failure');
        files.set(to, files.get(from));
        files.delete(from);
      },
    },
  };
  vm.createContext(context);
  const code = text.slice(start, end).replace('return { stateFile, usageFile };',
    'return { stateFile, usageFile, inspect: () => ({ records, titles, current }), compactUsage, backfillUsage };');
  vm.runInContext(code + '\nthis.register = registerCardState;', context);
  const state = context.register({ on: (name, fn) => { event = fn; } });
  assert.ok(state, logs.join('\n'));
  return {
    state, files, reads, logs, closed: () => closed,
    emit(sid, type, data, log = []) { event({ header: { id: sid }, log }, { type, time: now, data }); },
    usage(n) { this.emit('A', 'assistant/message', { usage: { inputTokens: n, outputTokens: 2 } }); },
    advance(ms) { now += ms; },
    periodic() { for (const timer of intervals) timer.fn(); },
    flush() { for (const timer of timeouts.splice(0)) if (timer.ms === 500) timer.fn(); },
    disk() { return files.get(usagePath).toString().split('\n').filter(Boolean).map(JSON.parse); },
  };
}

function checkTimers(text) {
  const start = text.indexOf('function makeTimerSet() {');
  const end = text.indexOf('\n/**', start);
  const live = new Set();
  const arm = fn => { const h = { fn }; live.add(h); return h; };
  const context = { setTimeout: arm, setInterval: arm, clearTimeout: h => live.delete(h), clearInterval: h => live.delete(h) };
  vm.createContext(context);
  vm.runInContext(text.slice(start, end) + '\nthis.timers = makeTimerSet();', context);
  let count = 0;
  const interval = context.timers.api.setInterval(() => count++, 1);
  interval.fn();
  interval.fn();
  const timeout = context.timers.api.setTimeout(() => count++, 1);
  live.delete(timeout);
  timeout.fn();
  const cancelled = context.timers.api.setInterval(() => count++, 1);
  context.timers.api.clearInterval(cancelled);
  context.timers.settle();
  context.timers.settle();
  assert.equal(count, 3);
  assert.equal(live.size, 0, 'fired interval must still be cleared at settlement');
  interval.fn();
  assert.equal(count, 3);
}

function checkTitles(text) {
  const h = host(text);
  for (let i = 0; i < 3000; i++) h.emit('s' + i, 'session/title', { title: 'title-' + i });
  assert.ok(h.state.inspect().titles.size <= 1024);
  const log = [{ type: 'session/title', data: { title: 'persistent-title' } }];
  h.emit('s0', 'turn/start', { turn: 1 }, log);
  assert.equal(h.state.inspect().current.title, 'persistent-title');
  assert.equal(log[0].data.title, 'persistent-title');
  h.emit('s0', 'turn/end', { turn: 1 });
  h.emit('s2999', 'session/title', { title: 'renamed' });
  assert.equal(h.state.inspect().titles.get('s2999'), 'renamed');
  assert.ok(h.state.inspect().titles.size <= 1024);
}

async function checkRealTimers(text) {
  const start = text.indexOf('function makeTimerSet() {');
  const end = text.indexOf('\n/**', start);
  const live = new Set();
  const context = {
    setTimeout, clearTimeout,
    setInterval: (...args) => { const handle = setInterval(...args); live.add(handle); return handle; },
    clearInterval: handle => { live.delete(handle); clearInterval(handle); },
  };
  vm.createContext(context);
  vm.runInContext(text.slice(start, end) + '\nthis.timers = makeTimerSet();', context);
  try {
    let count = 0;
    await new Promise(resolve => context.timers.api.setInterval(() => {
      count++;
      if (count === 2) resolve();
    }, 1));
    context.timers.settle();
    assert.equal(live.size, 0);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(count, 2);
  } finally {
    for (const handle of live) clearInterval(handle);
  }
}

function checkUsage(text) {
  const initial = line(1) + 'bad-json\n' + line(2, NOW - 36 * DAY)
    + line(3) + JSON.stringify(row(4));
  const h = host(text, initial);
  assert.deepEqual(h.disk(), [row(1), row(3), row(4)]);
  assert.equal(h.closed(), 1);
  h.usage(5);
  h.state.compactUsage();
  assert.deepEqual(h.disk(), [row(1), row(3), row(4), row(5)]);
  h.flush();
  const summary = JSON.parse(h.files.get('/files/dsh/home/card-state.json')).usage;
  assert.equal(summary.last30d, 21);
  const partial = host(text, line(1) + '{"t":1800');
  partial.usage(2);
  partial.state.compactUsage();
  assert.deepEqual(partial.disk(), [row(1), row(2)]);
  for (const content of [JSON.stringify({ ...row(99), padding: 'x'.repeat(70 * 1024) }),
    'x'.repeat(150000)]) {
    const original = line(1) + content + '\n' + line(2);
    const oversized = host(text, original);
    assert.equal(oversized.files.get(usagePath).toString(), original, 'unknown oversized line must survive startup');
    assert.equal(oversized.files.has(usagePath + '.tmp'), false);
    assert.ok(oversized.logs.some(message => message.includes('usage ledger read incomplete:')));
    assert.deepEqual(JSON.parse(JSON.stringify(oversized.state.inspect().records)), [row(1), row(2)]);
    for (let i = 0; i < 256; i++) oversized.usage(3);
    const appended = oversized.files.get(usagePath).toString();
    assert.ok(appended.startsWith(original), 'append compaction must preserve unparsed ledger');
    assert.equal(appended.slice(original.length), ('\n' + line(3)).repeat(256));
    oversized.advance(36 * DAY);
    oversized.periodic();
    oversized.state.compactUsage();
    assert.equal(oversized.files.get(usagePath).toString(), appended, 'age and manual compaction must preserve unparsed ledger');
    const restarted = host(text, appended);
    assert.equal(restarted.files.get(usagePath).toString(), appended, 'restart must preserve oversized record');
    assert.equal(oversized.closed(), 1);
  }
  const crossed = host(text, line(1) + JSON.stringify({ ...row(7), padding: '\u732b'.repeat(21000) }) + '\r\n' + line(2));
  assert.deepEqual(crossed.disk(), [row(1), row(7), row(2)]);
  const windows = host(text, [line(1), line(2, NOW - 6 * 3600000), line(3, NOW - 8 * DAY),
    line(4, NOW - 31 * DAY), line(5, NOW - 35 * DAY), line(6, NOW - 35 * DAY - 1)].join(''));
  assert.deepEqual(windows.disk(), [row(1), row(2, NOW - 6 * 3600000), row(3, NOW - 8 * DAY),
    row(4, NOW - 31 * DAY), row(5, NOW - 35 * DAY)]);
  windows.flush();
  const usage = JSON.parse(windows.files.get('/files/dsh/home/card-state.json')).usage;
  assert.equal(usage.last5h, 3);
  assert.equal(usage.last7d, 7);
  assert.equal(usage.last30d, 12);
  const long = host(text, Array.from({ length: 21000 }, (_, i) => line(i)).join(''));
  assert.equal(long.disk().length, 20000);
  assert.equal(long.disk()[0].in, 1000);
  for (let i = 0; i < 256; i++) long.usage(30000 + i);
  assert.equal(long.disk().length, 20000, 'periodic append compaction');
  assert.equal(long.disk().at(-1).in, 30255);
  long.advance(36 * DAY);
  long.periodic();
  assert.equal(long.disk().length, 0, 'age-based periodic compaction');
  const absent = host(text);
  absent.periodic();
  assert.equal(absent.files.has(usagePath), false, 'do not suppress initial backfill');
  const tail = host(text, 'x'.repeat(2000000) + '\n' + Array.from({ length: 20000 }, (_, i) => line(i)).join(''));
  assert.ok(tail.reads.reduce((sum, n) => sum + Math.min(n, 997), 0) < 1500000, 'stop once enough valid records are loaded');
  for (const failure of ['read', 'write', 'rename']) {
    const flags = { [failure]: true };
    const failed = host(text, line(9) + '{bad', flags);
    assert.equal(failed.files.get(usagePath).toString(), line(9) + '{bad');
    if (failure === 'read') {
      failed.usage(10);
      failed.state.compactUsage();
      assert.ok(failed.files.get(usagePath).toString().startsWith(line(9) + '{bad'));
    } else {
      failed.usage(10);
      flags[failure] = false;
      failed.state.compactUsage();
      assert.deepEqual(failed.disk(), [row(9), row(10)]);
    }
    assert.equal(failed.closed(), 1);
  }
}

checkTimers(timers);
await checkRealTimers(timers);
checkTitles(main);
checkUsage(main);
console.log('PASS production timer, title and usage lifecycle behavior');

if (process.argv.includes('--self-test')) {
  const mutations = [
    ['interval deregistration', () => checkTimers(timers.replace('if (kind === "timeout") registry.delete(handle);', 'registry.delete(handle);'))],
    ['unbounded titles', () => checkTitles(main.replace('if (this.size > 1024)', 'if (false)'))],
    ['unbounded ledger read', () => checkUsage(main.replace("const fd = fs.openSync(usageFile, 'r');", "fs.readFileSync(usageFile, 'utf8'); const fd = fs.openSync(usageFile, 'r');"))],
    ['missing append compaction', () => checkUsage(main.replace('if (usageAppends >= 256) compactUsage();', ''))],
    ['missing age compaction', () => checkUsage(main.replace('if (Date.now() - usageLastCompactAt >= 10 * 60 * 1000) compactUsage();', ''))],
    ['oversized record silently discarded', () => checkUsage(main.replace("                usageReadable = false;", "                usageReadable = true;"))],
    ['incomplete ledger overwritten', () => checkUsage(main.replace('if (!usageReadable || !fs.existsSync(usageFile)) return;', 'if (!fs.existsSync(usageFile)) return;'))],
    ['unbounded line accumulation', () => checkUsage(main.replace('if (lineBytes <= 65536) parts.push(Buffer.from(segment));', 'if (true) parts.push(Buffer.from(segment));').replace('if (lineBytes > 0 && lineBytes <= 65536)', 'if (lineBytes > 0)'))],
  ];
  for (const [name, run] of mutations) {
    assert.throws(run, undefined, 'negative control must fail: ' + name);
    console.log('PASS negative control: ' + name);
  }
}
