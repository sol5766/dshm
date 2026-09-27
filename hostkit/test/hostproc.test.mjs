/**
 * hostproc.mjs tests: upstream announce parsing, command splitting, the optional-Host advisory, and
 * supervision lifecycle with an **injected** spawn.
 *
 * The supervisor is the one place in hostkit that creates a process, so the tests here never let it
 * touch a real `dsh`: `spawnImpl` is injected, which makes the restart ladder and the give-up cap
 * observable without spawning anything.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  BACKOFF_STEPS_MS,
  HostSupervisor,
  MAX_RESTARTS_PER_MINUTE,
  parseAnnounce,
  splitCommand,
} from '../src/core/hostproc.mjs';
import { AuditLog } from '../src/core/audit.mjs';
import { tempDir } from './helpers/util.helper.mjs';

/** A fake ChildProcess good enough for the supervisor. */
class FakeChild extends EventEmitter {
  /** @param {number} pid @param {string[]} [lines] */
  constructor(pid, lines = []) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = [];
    this.stdin = { end: () => {} };
    setImmediate(() => {
      for (const line of lines) this.stdout.emit('data', Buffer.from(`${line}\n`));
    });
  }

  /** @param {string} signal */
  kill(signal) {
    this.killed.push(signal);
    setImmediate(() => this.emit('exit', null, signal));
    return true;
  }
}

/**
 * @param {import('node:test').TestContext} t
 * @param {object} [options]
 * @returns {{supervisor: HostSupervisor, spawned: object[], children: FakeChild[], audit: AuditLog}}
 */
function makeSupervisor(t, options = {}) {
  const stateDir = tempDir(t, 'hostkit-hostproc-');
  const audit = new AuditLog(`${stateDir}/audit.jsonl`);
  /** @type {object[]} */
  const spawned = [];
  /** @type {FakeChild[]} */
  const children = [];
  let pid = 1000;
  const supervisor = new HostSupervisor({
    command: options.command ?? 'dsh web --no-open --host 127.0.0.1 --port 3111',
    dshPort: options.dshPort ?? 3111,
    dshHost: '127.0.0.1',
    healthIntervalMs: 60_000,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    audit,
    now: options.now,
    spawnImpl: (command, args, spawnOptions) => {
      spawned.push({ command, args, spawnOptions });
      // The supervisor terminates the child by spawning the platform killer (`taskkill` / `kill`) with
      // the child's own pid. A real killer process would make the child exit; the fake one must model
      // that, otherwise `stop()` would wait for an exit that never happens.
      if (command === 'taskkill' || command === 'kill') {
        const target = Number(args.find((argument) => /^-?\d+$/.test(argument)));
        const victim = children.find((entry) => entry.pid === Math.abs(target));
        if (victim !== undefined) setImmediate(() => victim.emit('exit', null, 'SIGTERM'));
        return new FakeChild(-1);
      }
      const child = new FakeChild(pid++, options.lines ?? ['dsh web: http://127.0.0.1:3111/?token=ABC']);
      children.push(child);
      return child;
    },
    ...options.extra,
  });
  // The fake Host port is never actually listening, so override the health probe to keep tests
  // deterministic and offline.
  supervisor.probeOnce = async () => options.probeResult ?? false;
  return { supervisor, spawned, children, audit };
}

test('parseAnnounce reads the upstream `dsh web:` line, with and without a LAN suffix', () => {
  const plain = parseAnnounce('dsh web: http://127.0.0.1:3111/?token=<示例 token>');
  assert.equal(plain.host, '127.0.0.1');
  assert.equal(plain.port, 3111);
  assert.equal(plain.token, '<示例 token>');
  assert.equal(plain.lan, null);

  const withLan = parseAnnounce(
    'dsh web: http://127.0.0.1:3111/?token=T (LAN: http://192.168.1.20:3111/?token=T)',
  );
  assert.equal(withLan.lan, 'http://192.168.1.20:3111/?token=T');
  assert.equal(withLan.token, 'T');

  // Anything that is not the announce line is ignored rather than guessed at.
  assert.equal(parseAnnounce('dsh web: opening the default browser; pass --no-open to disable'), undefined);
  assert.equal(parseAnnounce('some other log line'), undefined);
  assert.equal(parseAnnounce(''), undefined);
  assert.equal(parseAnnounce(undefined), undefined);
  assert.equal(parseAnnounce('  dsh web:   http://localhost:4000/  ').port, 4000);
});

test('splitCommand honours quotes and whitespace', () => {
  assert.deepEqual(splitCommand('dsh web --no-open'), { command: 'dsh', args: ['web', '--no-open'] });
  assert.deepEqual(splitCommand('"C:\\Program Files\\dsh\\dsh.exe" web'), {
    command: 'C:\\Program Files\\dsh\\dsh.exe',
    args: ['web'],
  });
  assert.deepEqual(splitCommand("node 'a b' c"), { command: 'node', args: ['a b', 'c'] });
  assert.deepEqual(splitCommand('   '), { command: '', args: [] });
  assert.deepEqual(splitCommand('single'), { command: 'single', args: [] });
});

test('advisory is printed when no command is given and no Host is reachable', async (t) => {
  const { supervisor, spawned } = makeSupervisor(t, { command: '', probeResult: false });
  const result = await supervisor.start();
  assert.equal(result.started, false);
  assert.equal(result.reason, 'no-command');
  assert.match(result.advisory, /hostkit is optional/);
  assert.match(result.advisory, /L0/);
  assert.equal(spawned.length, 0, 'hostkit must never spawn a Host it was not asked to supervise');
  await supervisor.stop();
});

test('an already-running Host is adopted, never re-spawned, and never signalled', async (t) => {
  const { supervisor, spawned } = makeSupervisor(t, { probeResult: true });
  const result = await supervisor.start();
  assert.equal(result.started, false);
  assert.equal(result.reason, 'external-host');
  assert.match(result.advisory, /already listening/);
  assert.equal(spawned.length, 0);
  assert.equal(supervisor.status().supervised, false);
  await supervisor.stop();
  assert.equal(spawned.length, 0, 'stop() must not try to kill a Host we did not create');
});

test('supervision spawns the child, parses its announce line and records both in the audit log', async (t) => {
  const { supervisor, spawned, audit } = makeSupervisor(t);
  const result = await supervisor.start();
  assert.equal(result.started, true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, 'dsh');
  assert.deepEqual(spawned[0].args, ['web', '--no-open', '--host', '127.0.0.1', '--port', '3111']);
  assert.equal(spawned[0].spawnOptions.stdio[0], 'ignore', 'stdin is not used');

  // The fake child's stdout arrives on `setImmediate`, so poll rather than assume a fixed delay.
  const deadline = Date.now() + 3000;
  while (supervisor.status().announcement === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const status = supervisor.status();
  assert.equal(status.supervised, true);
  assert.equal(status.pid, 1000);
  assert.ok(status.announcement !== null, 'the upstream announce line must be parsed');
  assert.equal(status.announcement.token, 'ABC');

  const events = audit.read().records.map((record) => record.event);
  assert.equal(events.includes('host.spawn'), true);
  await supervisor.stop();
});

test('a non-zero exit schedules a restart with the documented backoff ladder, and stop() stops it', async (t) => {
  const { supervisor, spawned, children, audit } = makeSupervisor(t);
  const restarts = [];
  supervisor.on('restart', (event) => restarts.push(event));
  await supervisor.start();
  assert.equal(spawned.length, 1);

  children[0].emit('exit', 1, null);
  assert.equal(restarts.length, 1);
  assert.equal(restarts[0].delayMs, BACKOFF_STEPS_MS[0], 'the first retry uses the 500 ms step');

  // `stop()` must cancel the pending restart timer rather than letting it fire after shutdown.
  await supervisor.stop();
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(spawned.length, 1, 'no restart may happen after stop()');
  const events = audit.read().records.map((record) => record.event);
  assert.equal(events.includes('host.exit'), true);
  assert.equal(events.includes('host.restart'), true);
});

test('the restart ladder climbs through the documented steps and then gives up', async (t) => {
  // A frozen clock plus an injected scheduler means the ladder is walked without waiting for real
  // backoff delays, and every exit still looks like it happened inside the same rolling minute.
  const now = 1_000_000;
  /** @type {{delay: number, fn: () => void}[]} */
  const pending = [];
  const { supervisor, children, audit } = makeSupervisor(t, {
    now: () => now,
    extra: {
      setTimer: (fn, delay) => {
        pending.push({ delay, fn });
        return { unref() {} };
      },
    },
  });
  const restarts = [];
  const giveups = [];
  supervisor.on('restart', (event) => restarts.push(event));
  supervisor.on('giveup', (event) => giveups.push(event));
  await supervisor.start();

  const fire = async () => {
    while (pending.length > 0 && giveups.length === 0) {
      const next = pending.shift();
      next.fn();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  for (let round = 0; round < 2 * MAX_RESTARTS_PER_MINUTE && giveups.length === 0; round += 1) {
    const child = children[children.length - 1];
    if (child === undefined) break;
    child.emit('exit', 1, null);
    await fire();
  }

  assert.deepEqual(
    restarts.map((event) => event.delayMs),
    BACKOFF_STEPS_MS.slice(0, MAX_RESTARTS_PER_MINUTE),
    'the ladder must be walked step by step',
  );
  assert.equal(giveups.length, 1, 'the supervisor must give up instead of restarting forever');
  assert.equal(audit.read({ event: 'host.giveup' }).records.length, 1);
  await supervisor.stop();
});

test('status() reports nothing supervised when no command was configured', async (t) => {
  const { supervisor } = makeSupervisor(t, { command: '' });
  assert.deepEqual(supervisor.status().supervised, false);
  assert.equal(supervisor.status().pid, undefined);
  assert.equal(supervisor.status().announcement, null);
  assert.equal(supervisor.status().lastExit, null);
});

test('stop() is safe when no child was ever spawned', async (t) => {
  const { supervisor } = makeSupervisor(t, { command: '' });
  await supervisor.stop();
  await supervisor.stop();
  assert.equal(supervisor.status().pid, undefined);
});
