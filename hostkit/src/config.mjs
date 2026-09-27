/**
 * Configuration resolution: defaults ← config file ← environment ← CLI flags.
 *
 * Why this module exists: the tunnel's security properties depend on a handful of values (which host
 * the tunnel exits to, which interfaces the listener may bind, how long a pairing window lasts). Those
 * must be inspectable in one place, overridable from the CLI the task book specifies, and *validated*
 * before anything binds a socket. Notably: `dshHost` is pinned to a loopback literal by
 * {@link assertLoopbackHost}, which is what makes the "never bind the dsh Host to anything but
 * loopback" red line structural instead of a code-review promise.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';
import { platform } from './platform/index.mjs';

/** Defaults, documented in hostkit/README.md as the config table. */
export const DEFAULTS = Object.freeze({
  /** Advertised name in discovery announces and in the pairing URI. */
  name: os.hostname(),
  /** Port the hostkit listener binds (tunnel WebSocket + `POST /pair` + status). */
  port: 8798,
  /** UDP port for discovery broadcast/announce. */
  discoveryPort: 8799,
  /** Interface the hostkit listener binds. `0.0.0.0` is intended: this is *our* listener. */
  bindHost: '0.0.0.0',
  /** Loopback port of the local `dsh web` Host — the tunnel's only exit. */
  dshPort: 3111,
  /** Loopback host of the local dsh Host. Must be a loopback literal; never configurable upward. */
  dshHost: '127.0.0.1',
  /** Command used to spawn/supervise the local Host. Empty string = supervise nothing. */
  dshCmd: '',
  /** Tunnel heartbeat interval (ms). Mirrors the dsh mux `websocketHeartbeatIntervalMs` default. */
  pingIntervalMs: 2000,
  /** Pairing window (ms). */
  pairingWindowMs: 120_000,
  /** TLS certificate / key. Both empty = plain ws:// on the LAN (payload is E2E-sealed anyway). */
  cert: '',
  certKey: '',
  /** Mint a self-signed pair with `openssl` when no cert is supplied. */
  tlsSelfSigned: false,
  /** Disable discovery announce/listen entirely. */
  noDiscovery: false,
  /** Write the audit log. */
  audit: true,
  /** Log level: silent | error | warn | info | debug. */
  logLevel: 'info',
  /** DNS/interface refresh cadence for discovery announces (ms). */
  announceIntervalMs: 3000,
  /** Health-check cadence for the supervised Host (ms). */
  healthIntervalMs: 10_000,
  /** Maximum bytes of one tunnel HTTP body before the call is refused as `too-large`. */
  maxBodyBytes: 8 * 1024 * 1024,
});

/** Environment variable names (all optional). */
export const ENV = Object.freeze({
  HOME: 'DSHKIT_STATE_DIR',
  PORT: 'DSHKIT_PORT',
  DISCOVERY_PORT: 'DSHKIT_DISCOVERY_PORT',
  NAME: 'DSHKIT_NAME',
  BIND_HOST: 'DSHKIT_BIND_HOST',
  DSH_PORT: 'DSHKIT_DSH_PORT',
  DSH_CMD: 'DSHKIT_DSH_CMD',
  CERT: 'DSHKIT_CERT',
  CERT_KEY: 'DSHKIT_CERT_KEY',
  LOG_LEVEL: 'DSHKIT_LOG_LEVEL',
});

/**
 * Boolean flags the CLI accepts. Kept explicit so a typo'd flag is an error, not a silent no-op.
 * @type {Record<string, {key: string, value: boolean, help: string}>}
 */
export const BOOLEAN_FLAGS = Object.freeze({
  '--no-discovery': { key: 'noDiscovery', value: true, help: 'disable UDP discovery announce/listen' },
  '--no-audit': { key: 'audit', value: false, help: 'do not append to the audit log' },
  '--tls-selfsigned': { key: 'tlsSelfSigned', value: true, help: 'mint a self-signed TLS pair with openssl' },
  '--pair': { key: 'pair', value: true, help: 'open a pairing window right after `start`' },
  '--json': { key: 'json', value: true, help: 'machine-readable output' },
  '--quiet': { key: 'quiet', value: true, help: 'only print errors' },
});

/**
 * Value flags the CLI accepts.
 * @type {Record<string, {key: string, help: string}>}
 */
export const VALUE_FLAGS = Object.freeze({
  '--port': { key: 'port', help: 'hostkit listener port', number: true },
  '--bind': { key: 'bindHost', help: 'hostkit listener bind address' },
  '--discovery-port': { key: 'discoveryPort', help: 'UDP discovery port', number: true },
  '--dsh-port': { key: 'dshPort', help: 'loopback port of the dsh Host', number: true },
  '--dsh-cmd': { key: 'dshCmd', help: 'command that starts the dsh Host' },
  '--name': { key: 'name', help: 'advertised host name' },
  '--cert': { key: 'cert', help: 'TLS certificate (PEM) for wss://' },
  '--key': { key: 'certKey', help: 'TLS private key (PEM) for wss://' },
  '--state-dir': { key: 'stateDir', help: 'state directory override' },
  '--config': { key: 'configPath', help: 'config file path' },
  '--log-level': { key: 'logLevel', help: 'silent|error|warn|info|debug' },
  '--pair-window': { key: 'pairingWindowMs', help: 'pairing window in seconds', number: true, scale: 1000 },
  '--wait': { key: 'waitSeconds', help: '`discover` listen duration in seconds', number: true },
  '--ping-interval': { key: 'pingIntervalMs', help: 'tunnel heartbeat interval in ms', number: true },
  '--max-body': { key: 'maxBodyBytes', help: 'max tunnel HTTP body size in bytes', number: true },
  '--tail': { key: 'tail', help: 'number of audit records to print', number: true },
});

/**
 * Parse argv into `{command, flags, positionals, errors}`. Never throws: the CLI wants to print a
 * usage message, not a stack trace, when the user typo's a flag.
 * @param {string[]} argv
 * @returns {{command: string|undefined, flags: Record<string, unknown>, positionals: string[], errors: string[]}}
 */
export function parseArgv(argv) {
  /** @type {Record<string, unknown>} */
  const flags = {};
  /** @type {string[]} */
  const positionals = [];
  /** @type {string[]} */
  const errors = [];
  let command;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      flags.help = true;
      continue;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token : token.slice(0, eq);
      const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);
      const booleanFlag = BOOLEAN_FLAGS[name];
      if (booleanFlag !== undefined) {
        if (inlineValue !== undefined) {
          errors.push(`${name} does not take a value`);
          continue;
        }
        flags[booleanFlag.key] = booleanFlag.value;
        continue;
      }
      const valueFlag = VALUE_FLAGS[name];
      if (valueFlag === undefined) {
        errors.push(`unknown flag ${name}`);
        continue;
      }
      const raw = inlineValue ?? argv[++index];
      if (raw === undefined) {
        errors.push(`${name} requires a value`);
        continue;
      }
      if (valueFlag.number === true) {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          errors.push(`${name} requires a number`);
          continue;
        }
        flags[valueFlag.key] = parsed * (valueFlag.scale ?? 1);
      } else {
        flags[valueFlag.key] = raw;
      }
      continue;
    }
    if (command === undefined) command = token;
    else positionals.push(token);
  }
  return { command, flags, positionals, errors };
}

/**
 * Resolve the effective configuration.
 * @param {{argv?: string[], env?: Record<string,string|undefined>, cwd?: string, overrides?: Record<string, unknown>}} [input]
 * @returns {{config: object, command: string|undefined, positionals: string[], errors: string[], warnings: string[]}}
 */
export function loadConfig(input = {}) {
  const argv = input.argv ?? process.argv.slice(2);
  const env = input.env ?? process.env;
  const parsed = parseArgv(argv);
  /** @type {string[]} */
  const warnings = [...parsed.errors];

  const stateDir = typeof parsed.flags.stateDir === 'string'
    ? path.resolve(parsed.flags.stateDir)
    : env[ENV.HOME] !== undefined && env[ENV.HOME] !== ''
      ? path.resolve(env[ENV.HOME])
      : platform.stateDir();

  const configPath = typeof parsed.flags.configPath === 'string'
    ? path.resolve(parsed.flags.configPath)
    : path.join(stateDir, 'config.json');

  /** @type {Record<string, unknown>} */
  let fromFile = {};
  if (fs.existsSync(configPath)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (fromFile === null || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
        warnings.push(`config file ${configPath} is not an object; ignoring it`);
        fromFile = {};
      }
    } catch (error) {
      // A malformed config must not silently change security-relevant defaults.
      warnings.push(`config file ${configPath} could not be parsed (${error.message}); ignoring it`);
      fromFile = {};
    }
  }

  /** @type {Record<string, unknown>} */
  const fromEnv = {};
  const envNumber = (name, key) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return;
    const parsedNumber = Number(raw);
    if (Number.isFinite(parsedNumber)) fromEnv[key] = parsedNumber;
    else warnings.push(`${name} is not a number; ignoring it`);
  };
  if (env[ENV.PORT]) envNumber(ENV.PORT, 'port');
  if (env[ENV.DISCOVERY_PORT]) envNumber(ENV.DISCOVERY_PORT, 'discoveryPort');
  if (env[ENV.DSH_PORT]) envNumber(ENV.DSH_PORT, 'dshPort');
  if (env[ENV.NAME]) fromEnv.name = env[ENV.NAME];
  if (env[ENV.BIND_HOST]) fromEnv.bindHost = env[ENV.BIND_HOST];
  if (env[ENV.DSH_CMD]) fromEnv.dshCmd = env[ENV.DSH_CMD];
  if (env[ENV.CERT]) fromEnv.cert = env[ENV.CERT];
  if (env[ENV.CERT_KEY]) fromEnv.certKey = env[ENV.CERT_KEY];
  if (env[ENV.LOG_LEVEL]) fromEnv.logLevel = env[ENV.LOG_LEVEL];

  const config = {
    ...DEFAULTS,
    ...fromFile,
    ...fromEnv,
    ...Object.fromEntries(Object.entries(parsed.flags).filter(([key]) => key !== 'configPath')),
    ...(input.overrides ?? {}),
    stateDir,
    configPath,
  };
  delete config.configPathOverride;

  if (config.quiet === true) config.logLevel = 'silent';
  config.devicesPath = path.join(stateDir, 'devices.json');
  config.identityPath = path.join(stateDir, 'identity.json');
  config.auditPath = path.join(stateDir, 'audit.jsonl');
  config.certDir = config.certDir ?? platform.defaultCertDir();

  for (const field of ['port', 'discoveryPort', 'dshPort', 'pingIntervalMs', 'pairingWindowMs', 'healthIntervalMs', 'announceIntervalMs', 'maxBodyBytes']) {
    if (!Number.isInteger(config[field]) || config[field] <= 0) {
      warnings.push(`${field} must be a positive integer; using default ${DEFAULTS[field]}`);
      config[field] = DEFAULTS[field];
    }
  }
  for (const field of ['port', 'discoveryPort', 'dshPort']) {
    if (config[field] > 65535) {
      warnings.push(`${field} exceeds 65535; using default ${DEFAULTS[field]}`);
      config[field] = DEFAULTS[field];
    }
  }
  if (!['silent', 'error', 'warn', 'info', 'debug'].includes(config.logLevel)) {
    warnings.push(`unknown logLevel ${config.logLevel}; using info`);
    config.logLevel = 'info';
  }

  return { config, command: parsed.command, positionals: parsed.positionals, errors: parsed.errors, warnings };
}

/**
 * Refuse to forward to anything but a loopback literal.
 *
 * This is the structural half of red line #2 ("NEVER bind the dsh Host itself to anything but
 * loopback"). The other half is that hostkit's *proxy* module only ever constructs
 * `http://127.0.0.1:<dshPort>` URLs from this value.
 * @param {string} host @returns {boolean}
 */
export function isLoopbackHost(host) {
  const text = String(host).trim().toLowerCase();
  if (text === 'localhost') return true;
  const bare = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  if (isIP(bare) === 4) return bare.startsWith('127.');
  if (isIP(bare) === 6) return bare === '::1' || bare === '0:0:0:0:0:0:0:1';
  return false;
}

/**
 * Throwing form of {@link isLoopbackHost}, used before any socket is bound or any request forwarded.
 * @param {string} host @returns {void}
 */
export function assertLoopbackHost(host) {
  if (!isLoopbackHost(host)) {
    throw new Error(
      `refusing to start: dsh host target ${JSON.stringify(String(host))} is not a loopback literal. ` +
        'hostkit may only exit the tunnel on 127.0.0.1 / ::1 / localhost; exposing the dsh Host to the ' +
        'network is an explicit project red line (D1 §6.4).',
    );
  }
}

/**
 * Write the (non-secret) configuration back to disk. Secrets are deliberately excluded: the identity
 * private key lives in `identity.json` (mode 0600) and TLS keys stay wherever the user put them.
 * @param {object} config @returns {string} the path written
 */
export function saveConfig(config) {
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const portable = {
    name: config.name,
    port: config.port,
    bindHost: config.bindHost,
    discoveryPort: config.discoveryPort,
    dshPort: config.dshPort,
    dshHost: config.dshHost,
    dshCmd: config.dshCmd,
    pingIntervalMs: config.pingIntervalMs,
    pairingWindowMs: config.pairingWindowMs,
    cert: config.cert,
    certKey: config.certKey,
    tlsSelfSigned: config.tlsSelfSigned,
    noDiscovery: config.noDiscovery,
    audit: config.audit,
    logLevel: config.logLevel,
  };
  const temp = `${config.configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(portable, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, config.configPath);
  return config.configPath;
}
