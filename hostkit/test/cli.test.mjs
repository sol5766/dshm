/**
 * CLI tests.
 *
 * The CLI is the whole user interface of hostkit, so these tests drive `bin/hostkit.mjs` as a real
 * child process and assert what a user (or the ArkTS client) actually sees: the pairing URI, the
 * manual code, the exit codes, and the advisories that keep hostkit optional.
 *
 * Only the short-lived commands are exercised here; `start` is covered by the tunnel e2e tests, which
 * drive the same server object directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/util.helper.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'hostkit.mjs');

/**
 * Run the CLI to completion.
 * @param {string[]} args
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function runCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI did not exit within ${options.timeoutMs ?? 15000} ms`));
    }, options.timeoutMs ?? 15_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

test('no arguments prints usage and exits non-zero', async () => {
  const result = await runCli([]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /optional PC-side bridge/);
  assert.match(result.stdout, /hostkit start/);
  assert.match(result.stdout, /--dsh-cmd/);
});

test('--help prints usage and exits zero', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /hostkit pair/);
  assert.match(result.stdout, /tunnel exit is always 127\.0\.0\.1/);
});

test('an unknown command is a usage error, not a crash', async () => {
  const result = await runCli(['frobnicate']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown command "frobnicate"/);
  assert.equal(/\n\s+at .*:\d+:\d+/.test(result.stderr), false, 'no stack trace for a usage error');
});

test('an unknown flag is a usage error', async () => {
  const result = await runCli(['start', '--frobnicate']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown flag --frobnicate/);
});

test('`devices` on a fresh state dir reports nothing paired', async (t) => {
  const stateDir = tempDir(t, 'hostkit-cli-');
  const result = await runCli(['devices', '--state-dir', stateDir]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /no paired devices/);

  const json = await runCli(['devices', '--state-dir', stateDir, '--json']);
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.stdout).devices, []);
});

test('`audit` on a fresh state dir reports no records', async (t) => {
  const stateDir = tempDir(t, 'hostkit-cli-');
  const result = await runCli(['audit', '--state-dir', stateDir, '--tail', '5']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /no audit records/);

  const json = await runCli(['audit', '--state-dir', stateDir, '--json']);
  assert.deepEqual(JSON.parse(json.stdout), { records: [], skipped: 0 });
});

test('`revoke` without a device id is a usage error; with an unknown one it fails cleanly', async (t) => {
  const stateDir = tempDir(t, 'hostkit-cli-');
  const missing = await runCli(['revoke', '--state-dir', stateDir]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /revoke requires at least one/);

  const unknown = await runCli(['revoke', 'nope', '--state-dir', stateDir]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /no such device nope/);
});

test('`status` reports the loopback exit and the optional-Host note', async (t) => {
  const stateDir = tempDir(t, 'hostkit-cli-');
  const result = await runCli(['status', '--state-dir', stateDir, '--dsh-port', '3199', '--port', '8898']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /dsh Host \(loopback\) : 127\.0\.0\.1:3199/);
  assert.match(result.stdout, /hostkit is optional/);
  assert.match(result.stdout, /L0/);

  const json = await runCli(['status', '--state-dir', stateDir, '--dsh-port', '3199', '--json']);
  const report = JSON.parse(json.stdout);
  assert.equal(report.dsh.host, '127.0.0.1');
  assert.equal(report.dsh.port, 3199);
  assert.equal(report.dsh.reachable, false);
  assert.equal(report.devices.total, 0);
  assert.equal(
    report.platform,
    process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
  );
});

test('the dsh port can be supplied through the environment', async (t) => {
  const stateDir = tempDir(t, 'hostkit-cli-');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'status', '--state-dir', stateDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DSHKIT_DSH_PORT: '3111' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => (err += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? 0, out, err }));
  });
  assert.equal(result.code, 0);
  assert.match(result.out, /127\.0\.0\.1:3111/);
});

test('`pair --json` opens a window, prints a scannable URI, and closes on expiry', async (t) => {
  const stateDir = tempDir(t, 'hostkit-cli-');
  // A 2-second window keeps the test fast while still exercising the real expiry path.
  const child = spawn(
    process.execPath,
    [BIN, 'pair', '--state-dir', stateDir, '--pair-window', '2', '--no-discovery', '--port', '0', '--json'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`pair did not exit; stderr=${stderr}`));
    }, 20_000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
  });

  const line = stdout.split('\n').find((entry) => entry.trim().startsWith('{'));
  assert.ok(line !== undefined, `expected a JSON window on stdout, got: ${stdout} ${stderr}`);
  const window = JSON.parse(line);
  assert.match(window.uri, /^dshkit:\/\/pair\?/);
  assert.match(window.manualCode, /^\d{6}$/);
  assert.equal(window.payload.v, 1);
  assert.equal(window.payload.tls, false);
  assert.equal(window.payload.hostkitPub.length > 20, true);
  assert.equal(typeof window.expiresAt, 'number');
  assert.equal(window.expiresAt - Date.now() <= 3000, true, 'the window must honour --pair-window');
  assert.equal(exitCode, 2, 'an unused pairing window exits non-zero');
  assert.match(stderr, /pairing window closed without a device/);
});

test('`pair` prints a QR raster and the URI by default', async (t) => {
  const stateDir = tempDir(t, 'hostkit-cli-');
  const child = spawn(
    process.execPath,
    [BIN, 'pair', '--state-dir', stateDir, '--pair-window', '2', '--no-discovery', '--port', '0'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('pair did not exit'));
    }, 20_000);
    child.on('error', reject);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  assert.match(stdout, /manual code: \d{6}/);
  assert.match(stdout, /dshkit:\/\/pair\?/);
  // The block renderer uses half-block characters, so at least one must be present.
  assert.equal(/[\u2580\u2584\u2588]/.test(stdout), true, 'a QR raster must be printed');
});
