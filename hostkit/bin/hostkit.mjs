#!/usr/bin/env node
/**
 * `hostkit` CLI.
 *
 * Why this module exists: hostkit is a PC-side service a human runs. The CLI is therefore the whole
 * user interface, and its job is to make the security posture *legible*: `pair` prints the window and
 * its expiry, `devices` and `audit` show who was let in, `revoke` shows what was torn down, and `status`
 * shows whether the dsh Host is actually reachable on loopback. A bridge service that hides those facts
 * would be worse than no bridge service.
 *
 * Commands: start | pair | devices | revoke | audit | status | discover | help
 * Exit codes: 0 success, 1 usage/validation error, 2 runtime failure.
 */

import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, assertLoopbackHost, loadConfig } from '../src/config.mjs';
import { platform } from '../src/platform/index.mjs';
import { WhitelistStore } from '../src/core/whitelist.mjs';
import { AuditLog } from '../src/core/audit.mjs';
import { HostkitServer, createLogger } from '../src/server.mjs';
import { listenForHosts } from '../src/discovery.mjs';
import { encode, renderAscii, renderBlocks } from '../src/qr.mjs';

const EXIT = { OK: 0, USAGE: 1, RUNTIME: 2 };

const USAGE = `hostkit — optional PC-side bridge for the DeepSeek Harness HarmonyOS client

Usage:
  hostkit start   [--pair] [options]     run discovery + pairing endpoint + tunnel endpoint
  hostkit pair    [options]              open a 120 s pairing window and print the dshkit:// URI + QR
  hostkit devices [--json]               list paired devices
  hostkit revoke  <deviceId> [...]       revoke one or more devices (closes their live sessions)
  hostkit audit   [--tail N] [--json]    print the audit log
  hostkit status  [--json]               print hostkit/Host status
  hostkit discover [--wait SECONDS]      listen for LAN announces and print found hosts

Options:
  --port <n>                hostkit listener port (default ${DEFAULTS.port})
  --bind <addr>             listener bind address (default ${DEFAULTS.bindHost})
  --discovery-port <n>      UDP discovery port (default ${DEFAULTS.discoveryPort})
  --dsh-port <n>            loopback port of the dsh Host (default ${DEFAULTS.dshPort})
  --dsh-cmd "<cmd>"         command that starts the dsh Host, supervised by hostkit
  --name <text>             advertised host name
  --cert <pem> --key <pem>  serve wss:// on the listener (TLS is an *additional* layer)
  --tls-selfsigned          mint a self-signed TLS pair with openssl when available
  --state-dir <dir>         state directory (default ${platform.stateDir()})
  --no-discovery            do not announce/listen on UDP
  --no-audit                do not append to the audit log
  --pair-window <seconds>   pairing window length (default ${DEFAULTS.pairingWindowMs / 1000})
  --wait <seconds>          listen duration for 'discover' (default 5)
  --log-level <level>       silent|error|warn|info|debug
  --json                    machine-readable output
  -h, --help                this text

The tunnel exit is always 127.0.0.1:<dsh-port>; hostkit refuses to start otherwise.
`;

/**
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv.slice(2)) {
  const first = loadConfig({ argv });
  const options = {
    json: first.config.json === true,
    waitMs: typeof first.config.waitSeconds === 'number' ? first.config.waitSeconds * 1000 : 5000,
  };
  if (first.errors.length > 0) {
    for (const error of first.errors) process.stderr.write(`hostkit: ${error}\n`);
    return EXIT.USAGE;
  }
  const command = first.command;
  if (first.config.help === true || command === undefined || command === 'help') {
    process.stdout.write(USAGE);
    return command === undefined && first.config.help !== true ? EXIT.USAGE : EXIT.OK;
  }

  // Re-resolve so command-specific defaults (no Host supervision while pairing, no wait-seconds leak)
  // are part of one config object instead of scattered mutations.
  const overrides = {};
  if (command === 'pair') {
    // Pairing must never spawn a Host: `hostkit pair` is meant to run next to an already-running Host,
    // and hostkit is optional by design.
    overrides.dshCmd = '';
  }
  const { config, warnings } = loadConfig({ argv, overrides });
  for (const warning of warnings) process.stderr.write(`hostkit: warning: ${warning}\n`);

  try {
    assertLoopbackHost(config.dshHost);
    switch (command) {
      case 'start':
        return await commandStart(config, first.config.pair === true);
      case 'pair':
        return await commandPair(config, options);
      case 'devices':
        return commandDevices(config, options);
      case 'revoke':
        return commandRevoke(config, first.positionals);
      case 'audit':
        return commandAudit(config, options);
      case 'status':
        return await commandStatus(config, options);
      case 'discover':
        return await commandDiscover(config, options);
      default:
        process.stderr.write(`hostkit: unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
        return EXIT.USAGE;
    }
  } catch (error) {
    process.stderr.write(`hostkit: ${error.message}\n`);
    return EXIT.RUNTIME;
  }
}

/** @param {object} config @param {boolean} openPair @returns {Promise<number>} */
async function commandStart(config, openPair) {
  const logger = createLogger(config.logLevel);
  const server = new HostkitServer(config, { logger });
  const info = await server.start();
  logger.info(`hostkit ${info.tls ? 'wss' : 'ws'} listener on ${config.bindHost}:${info.port}`);
  logger.info(`advertise to the phone as ${server.advertiseHost()}:${info.port}${info.tls ? ' (TLS)' : ''}`);
  logger.info(`tunnel exit → http://${config.dshHost}:${config.dshPort} (loopback only)`);
  logger.info(`state dir: ${config.stateDir}`);

  if (openPair) {
    printPairing(server.openPairingWindow(), config, logger);
  } else {
    logger.info('pair a device with:  hostkit pair');
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}; shutting down (closing sessions, stopping the supervised Host)`);
    try {
      await server.stop();
    } catch (error) {
      logger.error(`shutdown error: ${error.message}`);
    }
    process.exit(EXIT.OK);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Keep the process alive while the listener is up.
  await new Promise(() => {});
  return EXIT.OK;
}

/** @param {object} config @param {{json: boolean}} options @returns {Promise<number>} */
async function commandPair(config, options) {
  const logger = createLogger(config.logLevel);
  const server = new HostkitServer(config, { logger });
  const info = await server.start();
  const window = server.openPairingWindow();
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...window, port: info.port, tls: info.tls, stateDir: config.stateDir })}\n`);
  } else {
    printPairing(window, config, logger);
  }
  const paired = await waitForPairing(server, Math.max(0, window.expiresAt - Date.now()));
  await server.stop();
  if (!paired) {
    process.stderr.write('hostkit: pairing window closed without a device\n');
    return EXIT.RUNTIME;
  }
  return EXIT.OK;
}

/**
 * Wait for `POST /pair` to land, or for the window to expire.
 * @param {HostkitServer} server @param {number} timeoutMs @returns {Promise<boolean>}
 */
function waitForPairing(server, timeoutMs) {
  return new Promise((resolve) => {
    const before = server.whitelist.list().length;
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const devices = server.whitelist.list();
      if (devices.length > before) {
        clearInterval(timer);
        process.stdout.write(`\npaired: ${devices[0].deviceName} (${devices[0].deviceId})\n`);
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(timer);
        resolve(false);
      }
    }, 250);
  });
}

/** @param {object} window @param {object} config @param {object} logger @returns {void} */
function printPairing(window, config, logger) {
  const seconds = Math.max(0, Math.round((window.expiresAt - Date.now()) / 1000));
  process.stdout.write('\n');
  try {
    process.stdout.write(renderBlocks(encode(window.uri).modules));
  } catch (error) {
    logger.warn(`qr: ${error.message}; falling back to the ASCII renderer`);
    try {
      process.stdout.write(renderAscii(encode(window.uri).modules));
    } catch (fallbackError) {
      logger.warn(`qr: ASCII fallback unavailable too (${fallbackError.message}); use the URI below`);
    }
  }
  process.stdout.write(`manual code: ${window.manualCode}\n`);
  process.stdout.write(`expires in : ${seconds}s (${new Date(window.expiresAt).toISOString()})\n`);
  process.stdout.write(`state dir  : ${config.stateDir}\n\n`);
  process.stdout.write(`${window.uri}\n\n`);
  process.stdout.write('Scan the QR (or paste the URI) into the DSH HarmonyOS client → device pairing.\n');
  process.stdout.write('The window accepts exactly one device and burns itself on success.\n');
}

/** @param {object} config @param {{json: boolean}} options @returns {number} */
function commandDevices(config, options) {
  const devices = new WhitelistStore(config.devicesPath).load().list();
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ devices }, null, 2)}\n`);
    return EXIT.OK;
  }
  if (devices.length === 0) {
    process.stdout.write(`no paired devices (state dir ${config.stateDir})\n`);
    return EXIT.OK;
  }
  process.stdout.write(`${'deviceId'.padEnd(20)} ${'name'.padEnd(20)} ${'pairedAt'.padEnd(26)} ${'lastSeen'.padEnd(26)} status\n`);
  for (const device of devices) {
    process.stdout.write(
      `${device.deviceId.padEnd(20)} ${String(device.deviceName).padEnd(20)} ${String(device.pairedAt).padEnd(26)} ` +
        `${String(device.lastSeenAt ?? '-').padEnd(26)} ${device.revokedAt === undefined ? 'active' : `revoked ${device.revokedAt}`}\n`,
    );
  }
  return EXIT.OK;
}

/** @param {object} config @param {string[]} positionals @returns {number} */
function commandRevoke(config, positionals) {
  if (positionals.length === 0) {
    process.stderr.write('hostkit: revoke requires at least one <deviceId>\n');
    return EXIT.USAGE;
  }
  const whitelist = new WhitelistStore(config.devicesPath).load();
  const audit = new AuditLog(config.auditPath, { disabled: config.audit === false });
  let failures = 0;
  for (const deviceId of positionals) {
    const record = whitelist.revoke(deviceId);
    if (record === undefined) {
      process.stderr.write(`hostkit: no such device ${deviceId}\n`);
      failures += 1;
      continue;
    }
    audit.append('device.revoke', { deviceId, sessionsClosed: 0, source: 'cli' });
    process.stdout.write(
      `revoked ${deviceId} (${record.deviceName}); a running \`hostkit start\` refuses its next handshake. ` +
        'To close its live sessions immediately, revoke through the running server (`GET /state` shows them).\n',
    );
  }
  return failures === 0 ? EXIT.OK : EXIT.RUNTIME;
}

/** @param {object} config @param {{json: boolean}} options @returns {number} */
function commandAudit(config, options) {
  const audit = new AuditLog(config.auditPath, { disabled: false });
  const tail = Number.isFinite(config.tail) ? config.tail : 50;
  const { records, skipped } = audit.read({ tail });
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ records, skipped }, null, 2)}\n`);
    return EXIT.OK;
  }
  if (skipped > 0) process.stderr.write(`hostkit: warning: ${skipped} unparseable audit line(s) skipped\n`);
  for (const record of records) {
    const { at, event, ...rest } = record;
    process.stdout.write(`${at}  ${String(event).padEnd(20)} ${JSON.stringify(rest)}\n`);
  }
  if (records.length === 0) process.stdout.write(`no audit records in ${config.auditPath}\n`);
  return EXIT.OK;
}

/** @param {object} config @param {{json: boolean}} options @returns {Promise<number>} */
async function commandStatus(config, options) {
  const whitelist = new WhitelistStore(config.devicesPath).load();
  const audit = new AuditLog(config.auditPath, { disabled: false });
  const devices = whitelist.list();
  const hostUp = await probePort(config.dshHost, config.dshPort);
  const listenerUp = await probePort('127.0.0.1', config.port);
  const report = {
    stateDir: config.stateDir,
    configPath: config.configPath,
    bindHost: config.bindHost,
    port: config.port,
    discoveryPort: config.discoveryPort,
    dsh: { host: config.dshHost, port: config.dshPort, reachable: hostUp, cmd: config.dshCmd === '' ? null : config.dshCmd },
    listener: { port: config.port, running: listenerUp },
    devices: {
      total: devices.length,
      active: devices.filter((device) => device.revokedAt === undefined).length,
      revoked: devices.filter((device) => device.revokedAt !== undefined).length,
    },
    audit: { records: audit.count() },
    platform: platform.name,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return EXIT.OK;
  }
  process.stdout.write('hostkit status\n');
  process.stdout.write(`  state dir           : ${report.stateDir}\n`);
  process.stdout.write(`  hostkit listener    : ${report.bindHost}:${report.port}${report.listener.running ? ' (answering on 127.0.0.1)' : ' (not running)'}\n`);
  process.stdout.write(`  discovery (UDP)     : ${report.discoveryPort}\n`);
  process.stdout.write(`  dsh Host (loopback) : ${report.dsh.host}:${report.dsh.port}${hostUp ? ' (reachable)' : ' (NOT reachable)'}\n`);
  process.stdout.write(`  supervised Host cmd : ${report.dsh.cmd ?? 'none (hostkit was not told to spawn one)'}\n`);
  process.stdout.write(`  devices             : ${report.devices.active} active / ${report.devices.revoked} revoked\n`);
  process.stdout.write(`  audit records       : ${report.audit.records}\n`);
  process.stdout.write(`  platform            : ${report.platform}\n`);
  if (!hostUp) {
    process.stdout.write(
      '\n  note: hostkit is optional. L0 (same-machine loopback) needs no hostkit at all. To let hostkit\n' +
        `        supervise a Host: hostkit start --dsh-port ${config.dshPort} --dsh-cmd "dsh web --no-open --host 127.0.0.1 --port ${config.dshPort}"\n`,
    );
  }
  return EXIT.OK;
}

/**
 * @param {string} host @param {number} port @returns {Promise<boolean>}
 */
function probePort(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1200, () => done(false));
  });
}

/** @param {object} config @param {{json: boolean, waitMs: number}} options @returns {Promise<number>} */
async function commandDiscover(config, options) {
  const seconds = Math.max(1, Math.round(options.waitMs / 1000));
  process.stdout.write(`listening for hostkit announces on UDP ${config.discoveryPort} for ${seconds}s...\n`);
  const hosts = await listenForHosts({ discoveryPort: config.discoveryPort, durationMs: options.waitMs });
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ hosts }, null, 2)}\n`);
    return EXIT.OK;
  }
  if (hosts.length === 0) {
    process.stdout.write('no hosts found (same LAN? firewall? --discovery-port mismatch?)\n');
    return EXIT.OK;
  }
  for (const entry of hosts) {
    const { announce, address } = entry;
    process.stdout.write(
      `${announce.name}  ${address}:${announce.port}  tls=${announce.tls ? 'yes' : 'no'}  ` +
        `pairing=${announce.pairing ? 'open' : 'closed'}  instance=${announce.instanceId}\n`,
    );
  }
  return EXIT.OK;
}

/** True when this file is the process entry point (`node bin/hostkit.mjs …`), not an import. */
function isDirectRun() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(entry);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`hostkit: fatal: ${error?.stack ?? error}\n`);
      process.exitCode = EXIT.RUNTIME;
    },
  );
}
