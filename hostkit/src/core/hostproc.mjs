/**
 * Managed supervision ("代持") of the local `dsh web` Host process.
 *
 * Why this module exists: D1 §6.5's first responsibility is 保活与代持 — keep the local Host alive and
 * act on the user's behalf — with the hard constraint that we never patch upstream. So hostkit does
 * exactly two things: it *launches* the official CLI as a child process and it *observes* the child's
 * own stdout. Nothing inside the dsh installation is read or written.
 *
 * The upstream announcement format is taken from the upstream source, not guessed
 * (D2 §2.1 / `dsh-web-app` lib/index.js):
 *
 *     dsh web: http://127.0.0.1:<port>/?token=<token> (LAN: http://<ip>:<port>/?token=<token>)
 *
 * The `(LAN: …)` suffix is only printed for a `0.0.0.0` bind; we always bind loopback, so in practice
 * only the first URL appears. We parse the URL for diagnostics (`hostkit status` shows it) but we
 * never need the token ourselves — the phone authenticates end-to-end with its own cookie. That is a
 * deliberate property: a hostkit process that never stores the dsh token cannot leak it.
 *
 * Restart policy: exponential backoff 500 ms → 10 s with a cap of 5 restarts per rolling minute, then
 * give up and report an advisory. A Host that is being restarted in a tight loop is a bug in the
 * Host's configuration, not something hostkit should mask.
 *
 * Process discipline (red line #5): every `kill` in this file is addressed to the child's own pid
 * (or, on POSIX, to the process group it leads because we spawned it detached). No name matching.
 */

import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';
import http from 'node:http';
import { platform } from '../platform/index.mjs';

/** Backoff ladder (ms), identical in spirit to the client's `Backoff.ets`. */
export const BACKOFF_STEPS_MS = [500, 1000, 2000, 4000, 8000, 10000];
/** Maximum automatic restarts inside a rolling minute before giving up. */
export const MAX_RESTARTS_PER_MINUTE = 5;

/**
 * Parse an upstream `dsh web:` announcement line.
 * @param {string} line
 * @returns {{url: string, host: string, port: number, token: string, lan: string|null}|undefined}
 */
export function parseAnnounce(line) {
  if (typeof line !== 'string') return undefined;
  const match = /dsh web:\s+(http:\/\/\S+?)\s*(?:\(LAN:\s*(http:\/\/\S+?)\s*\))?\s*$/.exec(line.trim());
  if (match === null) return undefined;
  try {
    const url = new URL(match[1]);
    const token = url.searchParams.get('token') ?? '';
    return {
      url: match[1],
      host: url.hostname,
      port: Number(url.port === '' ? 80 : url.port),
      token,
      lan: match[2] === undefined ? null : match[2],
    };
  } catch {
    return undefined;
  }
}

/**
 * Split a `--dsh-cmd` string into command + args. Quotes are honoured so a Windows path with spaces
 * works. This is *our* argument, supplied by the user on their own command line — it is never derived
 * from network input.
 * @param {string} text @returns {{command: string, args: string[]}}
 */
export function splitCommand(text) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current !== '') tokens.push(current);
  const [command = '', ...args] = tokens;
  return { command, args };
}

/** Supervisor state machine. */
export class HostSupervisor extends EventEmitter {
  /**
   * @param {{
   *   command?: string, dshPort: number, dshHost?: string,
   *   healthIntervalMs?: number, logger?: object, audit?: import('./audit.mjs').AuditLog,
   *   spawnImpl?: typeof nodeSpawn, now?: () => number, setTimer?: typeof setTimeout,
   * }} options
   */
  constructor(options) {
    super();
    this.commandLine = options.command ?? '';
    this.dshPort = options.dshPort;
    this.dshHost = options.dshHost ?? '127.0.0.1';
    this.healthIntervalMs = options.healthIntervalMs ?? 10_000;
    this.logger = options.logger;
    this.audit = options.audit;
    this.spawnImpl = options.spawnImpl ?? nodeSpawn;
    this.now = options.now ?? (() => Date.now());
    // Injectable so tests can drive the restart ladder without waiting for real backoff delays.
    this.setTimer = options.setTimer ?? setTimeout;
    /** @type {import('node:child_process').ChildProcess|null} */
    this.child = null;
    this.stopping = false;
    this.restarts = 0;
    /** @type {number[]} */
    this.restartTimes = [];
    this.announcement = null;
    this.ready = false;
    this.externalHostDetected = false;
    this.lastExit = null;
    this.startTimer = undefined;
    this.healthTimer = undefined;
  }

  /**
   * Begin supervision. Never throws when no command was supplied: hostkit must remain optional, so a
   * missing/absent Host degrades to an advisory (see {@link advisory}).
   * @returns {Promise<{started: boolean, reason?: string, advisory?: string}>}
   */
  async start() {
    const alive = await this.probeOnce();
    if (this.commandLine.trim() === '') {
      if (alive) {
        this.externalHostDetected = true;
        this.ready = true;
        return { started: false, reason: 'external-host', advisory: this.advisory() };
      }
      return { started: false, reason: 'no-command', advisory: this.advisory() };
    }
    if (alive) {
      // Something already answers on the loopback port. We did not spawn it, so we must not touch it;
      // we also must not spawn a second Host on the same port.
      this.externalHostDetected = true;
      this.ready = true;
      this.logger?.info?.(`host supervision: a dsh Host already answers on ${this.dshHost}:${this.dshPort}; not spawning another`);
      return { started: false, reason: 'external-host', advisory: this.advisory() };
    }
    this.spawnChild();
    this.startHealthLoop();
    return { started: true };
  }

  /** @returns {string} the advisory printed when hostkit cannot (or should not) supervise a Host */
  advisory() {
    if (this.externalHostDetected) {
      return `using the dsh Host already listening on ${this.dshHost}:${this.dshPort} (hostkit did not spawn it)`;
    }
    return (
      `no dsh Host found on ${this.dshHost}:${this.dshPort} and no --dsh-cmd given.\n` +
      '  hostkit is optional: L0 (same-machine loopback) works with hostkit absent entirely.\n' +
      '  To let hostkit supervise a Host, start it with:\n' +
      `    hostkit start --dsh-port ${this.dshPort} --dsh-cmd "dsh web --no-open --host ${this.dshHost} --port ${this.dshPort}"\n` +
      '  Pairing, discovery and the tunnel listener still work; only the upstream exit will be unavailable.'
    );
  }

  /** Spawn the child (once). */
  spawnChild() {
    const { command, args } = splitCommand(this.commandLine);
    if (command === '') return;
    const shaped = platform.spawnOptions(command, args, {});
    this.logger?.info?.(`host supervision: spawning ${command} ${args.join(' ')}`);
    this.child = this.spawnImpl(shaped.command, shaped.args, shaped.options);
    this.childPid = this.child.pid;

    let buffered = '';
    const onLine = (line) => {
      const announcement = parseAnnounce(line);
      if (announcement !== undefined) {
        this.announcement = announcement;
        this.logger?.info?.(`host supervision: upstream announced ${announcement.url}`);
      } else if (line.trim() !== '') {
        this.logger?.debug?.(`[dsh] ${line}`);
      }
    };
    const feed = (chunk, stream) => {
      buffered += chunk.toString('utf8');
      let index = buffered.indexOf('\n');
      while (index !== -1) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        if (stream === 'stdout') onLine(line);
        else if (line.trim() !== '') this.logger?.debug?.(`[dsh:err] ${line}`);
        index = buffered.indexOf('\n');
      }
      if (buffered.length > 64 * 1024) buffered = buffered.slice(-8192);
    };
    this.child.stdout?.on('data', (chunk) => feed(chunk, 'stdout'));
    this.child.stderr?.on('data', (chunk) => feed(chunk, 'stderr'));

    this.child.on('error', (error) => {
      this.logger?.error?.(`host supervision: spawn failed: ${error.message}`);
      this.audit?.append('host.exit', { reason: 'spawn-error', message: error.message });
    });
    this.child.on('exit', (code, signal) => {
      const pid = this.childPid;
      this.child = null;
      this.childPid = undefined;
      this.ready = false;
      this.lastExit = { code, signal, at: new Date(this.now()).toISOString() };
      this.audit?.append('host.exit', { pid, code, signal });
      this.logger?.warn?.(`host supervision: child ${pid} exited (code=${code}, signal=${signal})`);
      if (this.stopping) return;
      this.scheduleRestart();
    });
    this.audit?.append('host.spawn', { pid: this.child.pid, command, args });
  }

  /** Restart with exponential backoff, capped per rolling minute. */
  scheduleRestart() {
    const now = this.now();
    this.restartTimes = this.restartTimes.filter((at) => now - at < 60_000);
    if (this.restartTimes.length >= MAX_RESTARTS_PER_MINUTE) {
      this.audit?.append('host.giveup', { restarts: this.restartTimes.length });
      this.emit('giveup', { restarts: this.restartTimes.length });
      this.logger?.error?.(
        `host supervision: giving up after ${this.restartTimes.length} restarts in one minute; ` +
          'run `hostkit status` and check the upstream command',
      );
      return;
    }
    const step = BACKOFF_STEPS_MS[Math.min(this.restarts, BACKOFF_STEPS_MS.length - 1)];
    this.restarts += 1;
    this.restartTimes.push(now);
    this.audit?.append('host.restart', { attempt: this.restarts, delayMs: step });
    this.emit('restart', { attempt: this.restarts, delayMs: step });
    this.logger?.warn?.(`host supervision: restarting in ${step} ms (attempt ${this.restarts})`);
    this.startTimer = this.setTimer(() => {
      this.startTimer = undefined;
      if (!this.stopping) this.spawnChild();
    }, step);
    if (typeof this.startTimer?.unref === 'function') this.startTimer.unref();
  }

  /** Periodically confirm the Host is still answering on loopback. */
  startHealthLoop() {
    if (this.healthTimer !== undefined) return;
    this.healthTimer = setInterval(() => {
      void this.probeOnce().then((alive) => {
        const wasReady = this.ready;
        this.ready = alive;
        if (alive && !wasReady) this.emit('ready', { announcement: this.announcement });
        if (!alive && wasReady) this.emit('not-ready', {});
      });
    }, this.healthIntervalMs);
    if (typeof this.healthTimer.unref === 'function') this.healthTimer.unref();
  }
  /**
   * One health check against the Host's loopback listener. Any HTTP response counts as alive
   * (including 401/403 — those prove the webserver and its trust fence are up, which is exactly what
   * the tunnel needs).
   * @returns {Promise<boolean>}
   */
  probeOnce() {
    return new Promise((resolve) => {
      const request = http.request(
        { host: this.dshHost, port: this.dshPort, path: '/', method: 'GET', agent: false, timeout: 3000 },
        (response) => {
          response.resume();
          resolve(true);
        },
      );
      request.on('error', () => resolve(false));
      request.on('timeout', () => {
        request.destroy();
        resolve(false);
      });
      request.end();
    });
  }

  /** @returns {{supervised: boolean, pid: number|undefined, ready: boolean, restarts: number, announcement: object|null, lastExit: object|null}} */
  status() {
    return {
      supervised: this.commandLine.trim() !== '' && !this.externalHostDetected,
      pid: this.child?.pid,
      ready: this.ready,
      restarts: this.restarts,
      announcement: this.announcement,
      lastExit: this.lastExit,
    };
  }

  /**
   * Shut the child down cleanly. Only the pid/process-group we created is ever signalled.
   * @param {number} [graceMs]
   * @returns {Promise<void>}
   */
  async stop(graceMs = 5000) {
    this.stopping = true;
    if (this.startTimer !== undefined) clearTimeout(this.startTimer);
    if (this.healthTimer !== undefined) clearInterval(this.healthTimer);
    const child = this.child;
    if (child === null || child.pid === undefined) return;
    const pid = child.pid;
    const exited = new Promise((resolve) => {
      child.once('exit', () => resolve());
    });
    try {
      if (platform.name === 'win32') {
        // Politely close stdin first: `dsh web` exits when its stdio closes. Then the pid-specific kill.
        child.stdin?.end();
      }
      const killer = platform.killTree(pid);
      this.spawnImpl(killer.command, killer.args, { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      this.logger?.warn?.(`host supervision: could not signal child ${pid}: ${error.message}`);
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, graceMs);
    if (typeof timer.unref === 'function') timer.unref();
    await exited;
    clearTimeout(timer);
    this.child = null;
    this.childPid = undefined;
  }
}
