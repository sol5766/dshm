import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../hostcore/plugins/dshm-vm-bash/lib/terminal.js', import.meta.url), 'utf8');
const shq = (value) => "'" + String(value).split("'").join("'\\''") + "'";

/*
 * 选一个真的支持 POSIX 函数覆盖 `kill()` 的 sh。
 * 模拟脚本靠 `kill() { ... }` / `sleep() { ... }` 两个函数截获信号；
 * 若宿主 sh 不支持（或内置优先），脚本会**静默**走真空 signal ⇒ 只剩 WAIT，
 * 与本次外部复核看到的假象一致。找不到就明确报错，不产出误导性结论。
 */
const SHELL_CANDIDATES = ['/bin/sh', '/system/bin/sh', '/usr/bin/sh', 'bash'];
let chosenShell = '';
function pickShell() {
  if (chosenShell) return chosenShell;
  for (const candidate of SHELL_CANDIDATES) {
    const probe = spawnSync(candidate, ['-c', 'kill() { printf K; }; kill -TERM -1'],
      { encoding: 'utf8', timeout: 3000 });
    if (!probe.error && probe.status === 0 && probe.stdout === 'K') {
      chosenShell = candidate;
      return candidate;
    }
  }
  throw new Error('宿主 sh 不支持函数覆盖 kill()，无法模拟信号；请安装 bash 或换用支持 POSIX 函数的 sh');
}

function cleanupScript(script, owner, processes) {
  const root = mkdtempSync(join(tmpdir(), 'dshm-term-gate-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'tr'), '#!' + process.execPath + '\n'
      + 'require("fs").appendFileSync(' + JSON.stringify(join(bin, 'tr.calls')) + ', "1");\n'
      + 'process.stdin.on("data", (chunk) => process.stdout.write(chunk.toString().split("\\0").join("\\n")));\n', { mode: 0o755 });
    /*
     * 【为什么连 grep 也要桩化（2026-11-18 外部复核假红）】
     * 收尾脚本用 `grep -Fxq 'DSHM_TERM_OWNER=<owner>'` 做 owner 二次确认。
     * 若让门禁跑宿主 PATH 上的 grep：本机 / 某些 agent 环境的 toybox grep 对
     * `-Fxq` 组合会静默返回 1（不报错）⇒ 每组都被判"owner 不匹配"⇒ 只剩 WAIT，
     * 看起来像"代码丢了 TERM/KILL"，实际是门禁不自洽（连跑必然复现，但换台机器就绿）。
     * 这里用确定的 Node 实现桩住 -F/-x/-q 语义；被测脚本仍原样执行。
     */
    writeFileSync(join(bin, 'grep'), '#!' + process.execPath + '\n'
      + 'require("fs").appendFileSync(' + JSON.stringify(join(bin, 'grep.calls')) + ', "1");\n'
      + 'const args = process.argv.slice(2);\n'
      + 'const flags = args.filter((a) => a.startsWith("-")).join("");\n'
      + 'const pat = args.find((a) => !a.startsWith("-")) ?? "";\n'
      + 'let data = "";\n'
      + 'process.stdin.on("data", (c) => { data += c.toString(); });\n'
      + 'process.stdin.on("end", () => {\n'
      + '  const lines = data.split("\\n");\n'
      + '  const hit = flags.includes("x") ? lines.includes(pat) : lines.some((l) => l.includes(pat));\n'
      + '  process.exit(hit ? 0 : 1);\n'
      + '});\n', { mode: 0o755 });
    for (const p of processes) {
      mkdirSync(join(root, String(p.pid)));
      writeFileSync(join(root, String(p.pid), 'environ'), 'DSHM_TERM_OWNER=' + (p.owner === false ? 'other' : owner) + '\0');
      writeFileSync(join(root, String(p.pid), 'stat'), `${p.pid} (child with spaces) S 1 ${p.pg} ${p.sid ?? 101} 1 ${p.fg ?? p.pg}\n`);
    }
    const loseOwner = processes.filter((p) => p.loseOwner).map((p) => ': > ' + shq(join(root, String(p.pid), 'environ'))).join('\n');
    const command = 'PATH=' + shq(bin) + ':$PATH\n'
      + 'kill() { printf "SIGNAL %s %s\\n" "$1" "$2"; }\n'
      + 'sleep() { printf "WAIT\\n"; ' + (loseOwner || ':') + '; }\n'
      + script.replaceAll('/proc/', root + '/');
    const result = spawnSync(pickShell(), ['-c', command], { encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    if (!existsSync(join(bin, 'tr.calls')) || !existsSync(join(bin, 'grep.calls'))) {
      throw new Error('门禁桩未被执行（tr=' + existsSync(join(bin, 'tr.calls'))
        + ', grep=' + existsSync(join(bin, 'grep.calls')) + '）：宿主环境无法运行临时 PATH 下的 Node 桩');
    }
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split('\n').filter(Boolean);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fixture(text = source, realChannel = false) {
  let now = 100000;
  let sequence = 0;
  const timers = new Map();
  const sockets = [];
  const scripts = [];
  const signals = [];
  const outputs = [];
  let owner;
  const guest = { missing: false, claim: true, fail: false, launchWait: null, cleanupWait: null,
    processes: null };
  class Channel extends EventEmitter {
    destroyed = false;
    writes = [];
    pause() { return this; }
    resume() { return this; }
    write(data) { this.writes.push(Buffer.from(data)); }
    destroy() { this.destroyed = true; this.emit('close'); }
  }
  class StreamChannel extends Duplex {
    pauses = 0;
    resumes = 0;
    _read() {}
    _write(data, encoding, callback) { callback(); }
    pause() { this.pauses++; return super.pause(); }
    resume() { this.resumes++; return super.resume(); }
  }
  class Output extends PassThrough {
    constructor() { super(); outputs.push(this); }
  }
  const live = {
    async exec(path, args) {
      assert.equal(path, '/bin/busybox');
      const script = args[2];
      scripts.push(script);
      if (script.includes('DSHM_TERM_SPAWNED')) {
        owner = /export DSHM_TERM_OWNER='([^']+)'/.exec(script)?.[1];
        if (guest.launchWait) await guest.launchWait;
        return { stdout: 'DSHM_TERM_SPAWNED\n' + (guest.claim ? 'DSHM_TERM_ROW 101 101 101 101\n' : '') };
      }
      if (script.includes('kill -')) {
        if (guest.cleanupWait) await guest.cleanupWait;
        signals.push(...cleanupScript(script, owner, guest.processes ?? [{ pid: 101, pg: 101 }]));
        return { stdout: '' };
      }
      if (guest.fail) throw new Error('QGA transport unavailable');
      if (script.includes('DSHM_TERM_EXITED')) return { stdout: guest.missing ? 'DSHM_TERM_EXITED\n' : '101 101 101 101\n' };
      return { stdout: guest.missing || !guest.claim ? '' : '101 101 101 101\n' };
    },
  };
  const module = runInNewContext(text.replace(/^import .*;\n/gm, '').replace(/^export /gm, '')
    + '\n({ createVmTerminal, terminalDiagnostics, terminalLaunchScript });', {
    PassThrough: Output, randomUUID, shq, translateProgram: () => '/bin/sh', TERM_PORTS: 4,
    termSocket: (index) => '/isolated/term' + index, termTty: (index) => '/dev/hvc' + (index - 1),
    session: () => live,
    connect: async () => { const socket = realChannel ? new StreamChannel() : new Channel(); sockets.push(socket); return socket; },
    console: { log() {} }, Buffer, Promise, Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
  async function advance(ms) {
    const until = now + ms;
    for (;;) {
      await flush();
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    now = until;
    await flush();
  }
  return { ...module, guest, sockets, scripts, signals, outputs, advance, flush,
    open: (spec = {}) => module.createVmTerminal({ argv: ['sh', '-i'], ...spec }, async () => ({ ok: true })),
    kills: () => scripts.filter((script) => script.includes('for sig in TERM KILL')),
  };
}

const cases = {
  async backpressure(text) {
    const f = fixture(text, true);
    const handle = await f.open();
    const socket = f.sockets[0];
    const chunk = Buffer.alloc(65536, 7);
    socket.push(chunk);
    await new Promise(setImmediate);
    assert.ok(socket.pauses > 0 && socket.isPaused(), 'write false must pause source');
    const size = handle.output.writableLength;
    socket.push(chunk);
    await new Promise(setImmediate);
    assert.equal(handle.output.writableLength, size, 'paused source must not fill output');
    const received = [];
    handle.output.on('data', (data) => received.push(data));
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    assert.ok(socket.resumes > 1 && !socket.isPaused(), 'drain must resume source');
    assert.deepEqual(Buffer.concat(received), Buffer.concat([chunk, chunk]));
    await handle.terminate();
    for (const event of ['data', 'error', 'close']) assert.equal(socket.listenerCount(event), 0);
    assert.equal(handle.output.listenerCount('drain'), 0);
    const resumes = socket.resumes;
    handle.output.emit('drain');
    assert.equal(socket.resumes, resumes, 'settled stream cannot resume socket');
  },
  async bufferedEnd(text) {
    const f = fixture(text, true);
    const handle = await f.open();
    const socket = f.sockets[0];
    const first = Buffer.alloc(65536, 19);
    const second = Buffer.alloc(65536, 23);
    socket.push(first);
    await new Promise(setImmediate);
    assert.equal(socket.isPaused(), true);
    socket.push(second);
    await new Promise(setImmediate);
    assert.equal(socket.readableLength, second.length);
    assert.equal(handle.output.writableLength, first.length);
    await handle.terminate();
    assert.equal(socket.destroyed, true);
    assert.equal(socket.readableLength, 0);
    assert.ok(handle.output.writableLength <= first.length + second.length);
    assert.equal(handle.output.destroyed, false, 'delivered output must remain consumable');
    const received = [];
    for await (const chunk of handle.output) received.push(chunk);
    assert.ok(Buffer.concat(received).equals(Buffer.concat([first, second])), 'settlement must not truncate source tail');
  },
  async failedOutput(text) {
    const f = fixture(text, true);
    const controller = new AbortController();
    let release;
    f.guest.launchWait = new Promise((resolve) => { release = resolve; });
    const pending = f.open({ signal: controller.signal });
    await f.flush();
    f.sockets[0].push(Buffer.alloc(65536));
    await new Promise(setImmediate);
    f.sockets[0].push(Buffer.alloc(65536));
    controller.abort();
    release();
    await assert.rejects(pending, /取消/);
    assert.equal(f.outputs[0].destroyed, true, 'undelivered output must be destroyed');
    assert.equal(f.outputs[0].listenerCount('drain'), 0);
    for (const event of ['data', 'error', 'close']) assert.equal(f.sockets[0].listenerCount(event), 0);
  },
  async shellExit(text) {
    const f = fixture(text);
    const handle = await f.open();
    let result;
    handle.done.then((value) => { result = value; });
    f.guest.missing = true;
    await f.advance(3000);
    await f.flush();
    assert.ok(result, 'PID disappearance with persistent channel must settle done');
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, 'SIGHUP');
    assert.equal(f.kills().length, 1);
    assert.deepEqual([...f.terminalDiagnostics().inUse], []);
    assert.equal(f.sockets[0].destroyed, true);
  },
  async shellExitWithChildOwner(text) {
    const f = fixture(text);
    const handle = await f.open();
    f.guest.processes = [{ pid: 203, pg: 202 }, { pid: 301, pg: 301, owner: false }];
    let release;
    f.guest.cleanupWait = new Promise((resolve) => { release = resolve; });
    f.guest.missing = true;
    await f.advance(3000);
    let result;
    handle.done.then((value) => { result = value; });
    const stops = [handle.terminate(), handle.terminate()];
    assert.equal(result, undefined, 'done must wait for child cleanup');
    assert.deepEqual([...f.terminalDiagnostics().inUse], [1], 'port must stay held during child cleanup');
    release();
    await Promise.all(stops);
    assert.equal((await handle.done).signal, 'SIGHUP', 'shell exit must stop before done');
    assert.deepEqual(f.signals, ['SIGNAL -TERM -202', 'WAIT', 'SIGNAL -KILL -202']);
    assert.equal(f.kills().length, 1);
    assert.equal(f.terminalDiagnostics().inUse.length, 0);
    f.guest.cleanupWait = null;
    f.guest.missing = false;
    const again = await f.open();
    assert.deepEqual([...f.terminalDiagnostics().inUse], [1]);
    await handle.terminate();
    assert.equal(f.kills().length, 1, 'stale handle cannot clean reused port');
    await again.terminate();
  },
  async creationFailure(text) {
    const f = fixture(text);
    f.guest.claim = false;
    let error;
    const pending = f.open().catch((value) => { error = value; });
    await f.advance(9000);
    await pending;
    assert.ok(error, 'claim timeout must reject');
    assert.equal(f.kills().length, 1, 'claim timeout must reclaim guest shell');
    assert.deepEqual([...f.terminalDiagnostics().inUse], []);
  },
  async disconnect(text) {
    for (const event of ['close', 'error']) {
      const f = fixture(text);
      const handle = await f.open();
      f.sockets[0].emit(event, new Error('disconnected'));
      await f.flush();
      const result = await handle.done;
      assert.equal(result.exitCode, null);
      assert.equal(result.signal, 'SIGHUP');
      assert.equal(f.kills().length, 1, 'disconnect must reclaim only owned guest shell');
      assert.deepEqual([...f.terminalDiagnostics().inUse], []);
    }
  },
  async repeatedStop(text) {
    const f = fixture(text);
    const handle = await f.open();
    await Promise.all([handle.terminate(), handle.terminate(), handle.terminate()]);
    await handle.terminate();
    assert.equal(f.kills().length, 1, 'concurrent terminate must share cleanup');
    assert.equal(f.terminalDiagnostics().closed, 1);
    assert.equal((await handle.done).signal, 'SIGTERM');
  },
  async ignoredTermForeground(text) {
    const f = fixture(text);
    const handle = await f.open();
    f.guest.processes = [
      { pid: 101, pg: 101, fg: 202 }, { pid: 203, pg: 202 },
      { pid: 204, pg: 202 }, { pid: 301, pg: 301, owner: false },
    ];
    await Promise.all([handle.terminate(), handle.terminate()]);
    assert.deepEqual(f.signals, ['SIGNAL -TERM -101', 'SIGNAL -TERM -202', 'WAIT', 'SIGNAL -KILL -101', 'SIGNAL -KILL -202']);
    assert.equal(f.terminalDiagnostics().inUse.length, 0);
    assert.equal(f.kills().length, 1, 'repeated stop must share one cleanup');
  },
  async ownerRecheck(text) {
    const f = fixture(text);
    const handle = await f.open();
    f.guest.processes = [
      { pid: 101, pg: 101, fg: 301, loseOwner: true },
      { pid: 203, pg: 202 }, { pid: 301, pg: 301, owner: false },
      { pid: 401, pg: 1 },
    ];
    await handle.terminate();
    assert.deepEqual(f.signals, ['SIGNAL -TERM -101', 'SIGNAL -TERM -202', 'WAIT', 'SIGNAL -KILL -202'], 'KILL requires a fresh owner hit in each group; tpgid alone is not ownership');
  },
  async ports(text) {
    const f = fixture(text);
    const handles = await Promise.all(Array.from({ length: 4 }, () => f.open()));
    assert.deepEqual([...f.terminalDiagnostics().inUse], [1, 2, 3, 4]);
    await assert.rejects(f.open(), /端口已用满/);
    await Promise.all(handles.map((handle) => handle.terminate()));
    assert.deepEqual([...f.terminalDiagnostics().inUse], []);
    const again = await Promise.all(Array.from({ length: 4 }, () => f.open()));
    assert.deepEqual([...f.terminalDiagnostics().inUse], [1, 2, 3, 4]);
    const count = f.kills().length;
    await handles[0].terminate();
    assert.equal(f.kills().length, count, 'stale handle must not kill reused port');
    await Promise.all(again.map((handle) => handle.terminate()));
  },
  async interaction(text) {
    const f = fixture(text);
    const handle = await f.open();
    const output = [];
    handle.output.on('data', (data) => output.push(data));
    const bytes = Buffer.from([0, 27, 255, 13]);
    f.sockets[0].emit('data', bytes);
    await handle.write(bytes);
    assert.deepEqual(Buffer.concat(output), bytes);
    assert.deepEqual(f.sockets[0].writes[0], bytes);
    await handle.resize(80, 24);
    assert.ok(f.scripts.some((script) => script.includes('stty -F /dev/hvc0 rows 24 cols 80')));
    f.guest.fail = true;
    await f.advance(3000);
    assert.deepEqual([...f.terminalDiagnostics().inUse], [1], 'transport error is not proof of shell exit');
    await handle.terminate();
  },
  async cancellation(text) {
    const f = fixture(text);
    const controller = new AbortController();
    let release;
    f.guest.launchWait = new Promise((resolve) => { release = resolve; });
    const pending = f.open({ signal: controller.signal });
    await f.flush();
    controller.abort();
    controller.abort();
    release();
    await assert.rejects(pending, /取消/);
    assert.equal(f.kills().length, 1);
    assert.deepEqual([...f.terminalDiagnostics().inUse], []);
    assert.equal(f.sockets[0].destroyed, true);
    const pre = new AbortController();
    pre.abort();
    await assert.rejects(f.open({ signal: pre.signal }), /取消/);
    assert.equal(f.sockets.length, 1);
  },
  async creationDisconnect(text) {
    const f = fixture(text);
    let release;
    f.guest.launchWait = new Promise((resolve) => { release = resolve; });
    const pending = f.open();
    await f.flush();
    f.sockets[0].emit('close');
    release();
    await assert.rejects(pending, /关闭/);
    assert.equal(f.kills().length, 1);
    assert.deepEqual([...f.terminalDiagnostics().inUse], []);
  },
  async cleanupBeforeReuse(text) {
    const f = fixture(text);
    const handle = await f.open();
    let release;
    f.guest.cleanupWait = new Promise((resolve) => { release = resolve; });
    const pending = handle.terminate();
    await f.flush();
    assert.deepEqual([...f.terminalDiagnostics().inUse], [1]);
    release();
    await pending;
    assert.deepEqual([...f.terminalDiagnostics().inUse], []);
    const script = f.kills()[0];
    assert.ok(script.includes('DSHM_TERM_OWNER=') && script.includes('grep -Fxq'));
    assert.ok(!/rootfs|userdata|quit|kill -\w+ -1\b/.test(script));
    assert.ok(script.includes('for sig in TERM KILL'));
    assert.ok(script.includes('sleep 0.4'));
  },
};

const selfTest = process.argv.includes('--self-test');
if (selfTest) {
  const mutations = [
    ['pause omitted', (text) => text.replace('if (!output.write(chunk)) socket.pause();', 'output.write(chunk);'), 'backpressure'],
    ['resume omitted', (text) => text.replace('if (!ended) socket.resume();', ''), 'backpressure'],
    ['drain cleanup omitted', (text) => text.replace("output.removeListener('drain', onDrain);", ''), 'backpressure'],
    ['data cleanup omitted', (text) => text.replace("socket.removeListener('data', onData);", ''), 'backpressure'],
    ['error cleanup omitted', (text) => text.replace("socket.removeListener('error', onError);", ''), 'backpressure'],
    ['close cleanup omitted', (text) => text.replace("socket.removeListener('close', onClose);", ''), 'backpressure'],
    ['source tail discarded', (text) => text.replace('if (delivered) output.end(tail);', 'if (delivered) output.end();'), 'bufferedEnd'],
    ['normal output destroyed', (text) => text.replace('if (delivered) output.end(tail);', 'if (delivered) output.destroy();'), 'bufferedEnd'],
    ['failed output retained', (text) => text.replace('else output.destroy();', 'else output.end();'), 'failedOutput'],
    ['shell exit is ignored', (text) => text.replace("if (shellRow !== null && text.trim() === 'DSHM_TERM_EXITED') {", "if (false && shellRow !== null && text.trim() === 'DSHM_TERM_EXITED') {")],
    ['shell exit skips stop', (text) => text.replace("void stop('SIGHUP');\n        return null;", "end(null);\n        return null;")],
    ['creation failure skips guest cleanup', (text) => text.replace("await stop(spec.signal?.aborted ? 'SIGTERM' : 'SIGHUP');", "end('SIGHUP');")],
    ['network disconnect skips guest cleanup', (text) => text.replace("void stop('SIGHUP');", "end('SIGHUP');")],
    ['stop is not shared/idempotent', (text) => text.replace('if (stopping !== null) return stopping;', 'if (false && stopping !== null) return stopping;')],
    ['released port is not reusable', (text) => text.replace('state.used.delete(index);', '')],
    ['foreground KILL omitted', (text) => text.replace('for sig in TERM KILL; do', 'for sig in TERM; do'), 'ignoredTermForeground'],
    ['dead shell child ignored', (text) => text.replace('[ "$#" -eq 4 ] && [ "$1" = "$pid" ] || continue', '[ "$#" -eq 4 ] && [ "$1" = "$pid" ] && [ "$3" = "$pid" ] || continue'), 'shellExitWithChildOwner'],
    ['group dedup removed', (text) => text.replace('case "$groups" in *" $pg "*) continue;; esac', ':'), 'ignoredTermForeground'],
    ['owner check removed', (text) => text.replace("+ owner) + ' || continue'", "+ owner) + ' || true'"), 'ownerRecheck'],
    ['TERM wait removed', (text) => text.replace('[ "$sig" != TERM ] || sleep 0.4', ':'), 'ignoredTermForeground'],
  ];
  for (const [label, mutate, testCase] of mutations) {
    const changed = mutate(source);
    assert.notEqual(changed, source, 'mutation anchor must match: ' + label);
    let rejected = false;
    try { await cases[testCase ?? (label.startsWith('shell exit skips') ? 'shellExitWithChildOwner' : label.startsWith('shell') ? 'shellExit' : label.startsWith('creation') ? 'creationFailure' : label.startsWith('network') ? 'disconnect' : label.startsWith('stop') ? 'repeatedStop' : 'ports')](changed); }
    catch { rejected = true; }
    assert.ok(rejected, 'mutant must be detected: ' + label);
    console.log('MUTANT caught ' + label);
  }
}

let failures = 0;
for (const [name, test] of Object.entries(cases)) {
  try { await test(source); console.log('PASS ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); }
}
if (failures) process.exitCode = 1;
