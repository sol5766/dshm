/**
 * config.mjs + platform tests.
 *
 * Two things here are load-bearing for the project red lines and therefore get explicit tests:
 *   - `assertLoopbackHost` / `isLoopbackHost`: the structural half of "never expose the dsh Host";
 *   - `spawnOptions`: the platform split that keeps Windows from orphaning a supervised child.
 *
 * Every `loadConfig` call is given an explicit `--state-dir`, because the real default state directory
 * may hold a user's `config.json` and a test must never depend on (or touch) it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULTS,
  assertLoopbackHost,
  isLoopbackHost,
  loadConfig,
  parseArgv,
  saveConfig,
} from '../src/config.mjs';
import { broadcastOf, intToIpv4, ipv4ToInt, lanIPv4FromInterfaces, opensslCandidates } from '../src/platform/common.mjs';
import { darwinPlatform, linuxPlatform, platform, platformFor, win32Platform } from '../src/platform/index.mjs';
import { tempDir } from './helpers/util.helper.mjs';

test('parseArgv: value flags, inline values, booleans and positionals', () => {
  const parsed = parseArgv([
    'revoke',
    'device-a',
    'device-b',
    '--port',
    '9000',
    '--dsh-port=3111',
    '--no-discovery',
    '--pair-window',
    '30',
    '--tail',
    '5',
  ]);
  assert.equal(parsed.command, 'revoke');
  assert.deepEqual(parsed.positionals, ['device-a', 'device-b']);
  assert.equal(parsed.flags.port, 9000);
  assert.equal(parsed.flags.dshPort, 3111);
  assert.equal(parsed.flags.noDiscovery, true);
  assert.equal(parsed.flags.pairingWindowMs, 30_000, '--pair-window is in seconds and scaled to ms');
  assert.equal(parsed.flags.tail, 5);
  assert.deepEqual(parsed.errors, []);
});

test('parseArgv: unknown flags, missing values and non-numbers are reported, not thrown', () => {
  assert.deepEqual(parseArgv(['--nope']).errors, ['unknown flag --nope']);
  assert.deepEqual(parseArgv(['--port']).errors, ['--port requires a value']);
  assert.deepEqual(parseArgv(['--port', 'abc']).errors, ['--port requires a number']);
  assert.deepEqual(parseArgv(['--no-audit=1']).errors, ['--no-audit does not take a value']);
  assert.deepEqual(parseArgv(['-h']).flags.help, true);
});

test('loadConfig: CLI beats environment beats file beats defaults', (t) => {
  const stateDir = tempDir(t, 'hostkit-config-');
  const configPath = path.join(stateDir, 'config.json');
  saveConfig({ stateDir, configPath, ...DEFAULTS, port: 1111, name: 'from-file' });

  const fromFile = loadConfig({ argv: ['start', '--state-dir', stateDir], env: {} }).config;
  assert.equal(fromFile.port, 1111, 'the file wins over the default');
  assert.equal(fromFile.name, 'from-file');

  const envWins = loadConfig({ argv: ['start', '--state-dir', stateDir], env: { DSHKIT_PORT: '2222', DSHKIT_NAME: 'from-env' } }).config;
  assert.equal(envWins.port, 2222, 'the environment wins over the file');
  assert.equal(envWins.name, 'from-env');

  const cliWins = loadConfig({
    argv: ['start', '--state-dir', stateDir, '--port', '3333', '--name', 'from-cli'],
    env: { DSHKIT_PORT: '2222', DSHKIT_NAME: 'from-env' },
  }).config;
  assert.equal(cliWins.port, 3333, 'the CLI wins over everything');
  assert.equal(cliWins.name, 'from-cli');
});

test('loadConfig: overrides are applied last and derived paths live in the state dir', (t) => {
  const stateDir = tempDir(t, 'hostkit-config2-');
  const cleared = loadConfig({ argv: ['pair', '--state-dir', stateDir], env: {}, overrides: { dshCmd: '', port: 4444 } }).config;
  assert.equal(cleared.dshCmd, '', 'the pair command clears dshCmd through overrides');
  assert.equal(cleared.port, 4444, 'overrides beat CLI flags');

  const custom = loadConfig({ argv: ['start', '--state-dir', stateDir], env: {}, overrides: {} }).config;
  assert.equal(custom.stateDir, path.resolve(stateDir));
  assert.equal(custom.devicesPath, path.join(path.resolve(stateDir), 'devices.json'));
  assert.equal(custom.identityPath, path.join(path.resolve(stateDir), 'identity.json'));
  assert.equal(custom.auditPath, path.join(path.resolve(stateDir), 'audit.jsonl'));
  assert.equal(custom.configPath, path.join(path.resolve(stateDir), 'config.json'));
});

test('loadConfig: invalid numbers and log levels fall back with a warning', (t) => {
  const stateDir = tempDir(t, 'hostkit-config5-');
  const { config, warnings } = loadConfig({
    argv: ['start', '--state-dir', stateDir, '--port', '0', '--log-level', 'loud'],
    env: {},
  });
  assert.equal(config.port, DEFAULTS.port);
  assert.equal(config.logLevel, 'info');
  assert.equal(warnings.some((warning) => warning.includes('port must be a positive integer')), true);
  assert.equal(warnings.some((warning) => warning.includes('unknown logLevel')), true);

  const tooBig = loadConfig({ argv: ['start', '--state-dir', stateDir, '--port', '70000'], env: {} });
  assert.equal(tooBig.config.port, DEFAULTS.port);
  assert.equal(tooBig.warnings.some((warning) => warning.includes('exceeds 65535')), true);
});

test('loadConfig: a corrupt config file is ignored with a warning instead of changing defaults', (t) => {
  const stateDir = tempDir(t, 'hostkit-config3-');
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{ not json');
  const { config, warnings } = loadConfig({ argv: ['start', '--state-dir', stateDir], env: {} });
  assert.equal(config.port, DEFAULTS.port);
  assert.equal(warnings.some((warning) => warning.includes('could not be parsed')), true);
});

test('loadConfig: a config file that is not an object is ignored with a warning', (t) => {
  const stateDir = tempDir(t, 'hostkit-config6-');
  fs.writeFileSync(path.join(stateDir, 'config.json'), '[1,2,3]');
  const { config, warnings } = loadConfig({ argv: ['start', '--state-dir', stateDir], env: {} });
  assert.equal(config.port, DEFAULTS.port);
  assert.equal(warnings.some((warning) => warning.includes('is not an object')), true);
});

test('loadConfig: an unknown command is reported through `errors` for the CLI to print usage', () => {
  const parsed = loadConfig({ argv: ['frobnicate'], env: {} });
  assert.equal(parsed.command, 'frobnicate');
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(loadConfig({ argv: ['start', '--bogus'], env: {} }).errors, ['unknown flag --bogus']);
});

test('saveConfig round-trips the portable fields and never writes secrets', (t) => {
  const stateDir = tempDir(t, 'hostkit-config4-');
  const { config } = loadConfig({ argv: ['start', '--state-dir', stateDir], env: {}, overrides: { name: 'portable', port: 5555 } });
  const written = saveConfig(config);
  assert.equal(written, path.join(path.resolve(stateDir), 'config.json'));
  const parsed = JSON.parse(fs.readFileSync(written, 'utf8'));
  assert.equal(parsed.name, 'portable');
  assert.equal(parsed.port, 5555);
  assert.equal('privateKey' in parsed, false);
  assert.equal('identity' in parsed, false);
  assert.equal('adminToken' in parsed, false);
});

test('isLoopbackHost accepts loopback literals and rejects everything else', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]', ' 127.0.0.1 ']) {
    assert.equal(isLoopbackHost(host), true, `${host} must be accepted`);
  }
  for (const host of ['0.0.0.0', '192.168.1.5', '10.0.0.1', '8.8.8.8', 'example.com', '127.0.0.1.evil.com', '', '::', 'fe80::1']) {
    assert.equal(isLoopbackHost(host), false, `${host} must be rejected`);
  }
});

test('assertLoopbackHost refuses a non-loopback target with an explanatory error', () => {
  assert.doesNotThrow(() => assertLoopbackHost('127.0.0.1'));
  assert.throws(() => assertLoopbackHost('0.0.0.0'), /not a loopback literal/);
  assert.throws(() => assertLoopbackHost('192.168.0.10'), /D1 §6\.4/);
});

test('platform selection falls back to the POSIX implementation for unknown platforms', () => {
  assert.equal(platformFor('win32').name, 'win32');
  assert.equal(platformFor('darwin').name, 'darwin');
  assert.equal(platformFor('linux').name, 'linux');
  assert.equal(platformFor('freebsd').name, 'linux');
  assert.equal(platform.name, platformFor(process.platform).name);
});

test('spawnOptions: Windows hides the console and never detaches; POSIX detaches', () => {
  const win = win32Platform.spawnOptions('dsh', ['web'], {});
  assert.equal(win.options.windowsHide, true);
  assert.equal(win.options.detached, false, 'a detached child on Windows could never be reclaimed safely');
  assert.equal(win.options.shell, true, 'the dsh shim is a .cmd/.ps1');
  assert.equal(win.options.stdio[1], 'pipe', 'stdout must be piped so the announce line can be parsed');

  const winExe = win32Platform.spawnOptions('C:\\tools\\node.exe', [], {});
  assert.equal(winExe.options.shell, false, 'a real executable does not need a shell');

  const posix = linuxPlatform.spawnOptions('dsh', ['web'], {});
  assert.equal(posix.options.detached, true, 'POSIX children lead their own process group so we can signal them');
  assert.equal(posix.options.shell, false);
  assert.equal(darwinPlatform.spawnOptions('dsh', [], {}).options.detached, true);
});

test('killTree only ever addresses a pid we were given', () => {
  assert.deepEqual(win32Platform.killTree(7), { command: 'taskkill', args: ['/PID', '7', '/T', '/F'] });
  assert.deepEqual(linuxPlatform.killTree(7), { command: 'kill', args: ['-TERM', '-7'] });
  assert.deepEqual(darwinPlatform.killTree(7), { command: 'kill', args: ['-TERM', '-7'] });
  for (const implementation of [win32Platform, linuxPlatform, darwinPlatform]) {
    const command = implementation.killTree(4242);
    assert.equal(command.args.some((argument) => argument.includes('4242')), true);
  }
});

test('state dirs and openssl candidates are non-empty per platform', () => {
  for (const implementation of [win32Platform, linuxPlatform, darwinPlatform]) {
    assert.equal(typeof implementation.stateDir(), 'string');
    assert.equal(implementation.stateDir().length > 0, true);
    assert.equal(implementation.defaultCertDir().startsWith(implementation.stateDir()), true);
    assert.equal(implementation.findOpensslCandidates().length > 0, true);
  }
  assert.equal(opensslCandidates('win32').some((entry) => entry.endsWith('openssl.exe')), true);
  assert.equal(opensslCandidates('linux').includes('openssl'), true);
});

test('lanIPv4 filters loopback/private-internal entries and computes directed broadcasts', () => {
  const entries = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
    eth0: [{ family: 'IPv4', address: '192.168.1.20', netmask: '255.255.255.0', internal: false }],
    eth1: [{ family: 'IPv6', address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', internal: false }],
  };
  const lan = lanIPv4FromInterfaces(entries);
  assert.equal(lan.length, 1);
  assert.equal(lan[0].name, 'eth0');
  assert.equal(lan[0].broadcast, '192.168.1.255');
  assert.deepEqual(lanIPv4FromInterfaces({}), []);
});

test('IPv4 helpers round-trip and reject junk', () => {
  assert.equal(ipv4ToInt('192.168.1.20'), 0xc0a80114);
  assert.equal(intToIpv4(0xc0a80114), '192.168.1.20');
  assert.equal(ipv4ToInt('256.0.0.1'), undefined);
  assert.equal(ipv4ToInt('1.2.3'), undefined);
  assert.equal(ipv4ToInt('a.b.c.d'), undefined);
  assert.equal(broadcastOf('10.0.0.5', '255.255.0.0'), '10.0.255.255');
  assert.equal(broadcastOf('bad', '255.255.255.0'), undefined);
});

test('the platform layer enumerates this machine without throwing', () => {
  const lan = platform.lanIPv4();
  assert.equal(Array.isArray(lan), true);
  for (const entry of lan) {
    assert.equal(typeof entry.address, 'string');
    assert.equal(entry.address.startsWith('127.'), false, 'loopback must be filtered out');
  }
  assert.equal(typeof os.hostname(), 'string');
});
