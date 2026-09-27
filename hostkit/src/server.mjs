/**
 * The wiring: discovery + pairing endpoint + tunnel endpoint + audit + supervised Host, behind one
 * listener.
 *
 * Why this module exists: every other module in hostkit is a part with one job; this is the only place
 * that knows how they fit together, and therefore the only place where the L1 invariants are enforced
 * end-to-end:
 *
 *  - `GET /tunnel` is the *only* upgrade route. The Host's own `/api/remote.mux` is never exposed
 *    directly; the client's logical streams are dialled by {@link HostProxy} from loopback.
 *  - `POST /pair` is the only unauthenticated mutation, and it is only accepted while a pairing window
 *    is explicitly open (`hostkit pair`) and only once per window.
 *  - `GET /state` and `GET /audit` require the *current* pairing token or a per-run admin token.
 *  - Revoking a device closes its live sessions immediately ({@link HostkitServer.revoke}).
 *
 * TLS is optional and additive. When `--cert`/`--key` (or a minted self-signed pair) are supplied the
 * listener speaks `wss://`; when they are not, it speaks plain `ws://` on the LAN. That is safe because
 * the payload is sealed with AES-256-GCM *before* it reaches the transport (see core/tunnel.mjs), so TLS
 * only protects the plaintext handshake metadata (device id, public keys) — not the session.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AuditLog } from './core/audit.mjs';
import { constantTimeEqual, generateIdentityPrivate, identityPublicFromPrivate, randomToken } from './core/crypto.mjs';
import { HostProxy } from './core/proxy.mjs';
import { HostSupervisor } from './core/hostproc.mjs';
import { PairingService } from './core/pairing.mjs';
import { TunnelSession } from './core/tunnel.mjs';
import { WhitelistStore } from './core/whitelist.mjs';
import { acceptUpgrade, isUpgrade } from './core/ws.mjs';
import { DiscoveryService } from './discovery.mjs';
import { assertLoopbackHost } from './config.mjs';
import { platform } from './platform/index.mjs';

const VERSION = '0.1.0';

/** Maximum `POST /pair` body. */
const MAX_PAIR_BODY = 8 * 1024;
/** Maximum session count from one address (a LAN attacker should not be able to exhaust memory). */
const MAX_SESSIONS = 16;

/** Minimal leveled logger; `silent` really is silent so tests can run quietly. */
export function createLogger(level = 'info') {
  const order = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
  const threshold = order[level] ?? 3;
  const write = (name, stream, ...args) => {
    if (order[name] <= threshold) stream.write(`${args.join(' ')}\n`);
  };
  return {
    level,
    error: (...args) => write('error', process.stderr, ...args),
    warn: (...args) => write('warn', process.stderr, ...args),
    info: (...args) => write('info', process.stdout, ...args),
    debug: (...args) => write('debug', process.stdout, ...args),
  };
}

/**
 * Load or create the hostkit long-term identity. The private key file is created mode 0600 and its
 * containing directory 0700; on POSIX the mode is enforced after write as well, because a `umask`
 * can weaken the `openSync` mode.
 * @param {string} path
 * @param {object} logger
 * @returns {{privateKey: string, publicKey: string, generated: boolean}}
 */
export function loadIdentity(path, logger) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (typeof parsed?.privateKey === 'string' && typeof parsed?.publicKey === 'string') {
      return { privateKey: parsed.privateKey, publicKey: parsed.publicKey, generated: false };
    }
    logger.warn(`identity: ${path} is malformed; generating a new identity`);
  } catch (error) {
    if (error.code !== 'ENOENT') logger.warn(`identity: could not read ${path} (${error.message}); regenerating`);
  }
  const privateKey = generateIdentityPrivate();
  const publicKey = identityPublicFromPrivate(privateKey);
  fs.mkdirSync(path.replace(/[\\/][^\\/]+$/, ''), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, createdAt: new Date().toISOString(), privateKey, publicKey }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temp, path);
  try {
    fs.chmodSync(path, 0o600);
  } catch {
    /* Windows has no POSIX modes; ACLs apply instead */
  }
  return { privateKey, publicKey, generated: true };
}

export class HostkitServer {
  /**
   * @param {object} config resolved configuration (see config.mjs)
   * @param {{logger?: object, spawnImpl?: Function}} [options]
   */
  constructor(config, options = {}) {
    this.config = config;
    this.logger = options.logger ?? createLogger(config.logLevel);
    this.spawnImpl = options.spawnImpl;

    // Red line #2, enforced before a single socket exists.
    assertLoopbackHost(config.dshHost);

    this.identity = loadIdentity(config.identityPath, this.logger);
    this.whitelist = new WhitelistStore(config.devicesPath).load();
    this.audit = new AuditLog(config.auditPath, { disabled: config.audit === false });
    this.pairing = new PairingService({ windowMs: config.pairingWindowMs });
    this.proxy = new HostProxy({
      dshHost: config.dshHost,
      dshPort: config.dshPort,
      maxBodyBytes: config.maxBodyBytes,
      logger: this.logger,
    });
    this.adminToken = randomToken(32);
    /** @type {Set<TunnelSession>} */
    this.sessions = new Set();
    /** @type {import('node:http').Server|import('node:https').Server|null} */
    this.server = null;
    /** @type {DiscoveryService|null} */
    this.discovery = null;
    /** @type {HostSupervisor|null} */
    this.supervisor = null;
    this.startedAt = null;
    this.tls = { enabled: false, cert: '', key: '' };
  }

  /** Resolve and validate TLS material. Returns undefined when TLS is not requested. */
  resolveTls() {
    let { cert, certKey } = this.config;
    if ((cert === '' || certKey === '') && this.config.tlsSelfSigned === true) {
      const minted = mintSelfSigned(this.config.certDir, this.logger);
      cert = minted.cert;
      certKey = minted.key;
    }
    if (cert === '' || certKey === '') return undefined;
    try {
      return { cert: fs.readFileSync(cert), key: fs.readFileSync(certKey), certPath: cert, keyPath: certKey };
    } catch (error) {
      // Fail loudly: silently falling back to plaintext after the user asked for TLS would be worse
      // than not starting.
      throw new Error(`tls: cannot read certificate material (${error.message})`);
    }
  }

  /**
   * Bind the listener and start discovery + supervision.
   * @returns {Promise<{port: number, tls: boolean, url: string}>}
   */
  async start() {
    const tls = this.resolveTls();
    const handler = (request, response) => this.handleRequest(request, response);
    if (tls !== undefined) {
      this.server = https.createServer({ cert: tls.cert, key: tls.key }, handler);
      this.tls = { enabled: true, cert: tls.certPath, key: tls.keyPath };
    } else {
      this.server = http.createServer(handler);
      this.tls = { enabled: false, cert: '', key: '' };
    }
    this.server.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head));
    this.server.on('clientError', (error, socket) => {
      this.logger.debug(`server: client error ${error.message}`);
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      this.server.once('error', onError);
      this.server.listen(this.config.port, this.config.bindHost, () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    this.port = this.server.address().port;
    this.startedAt = new Date().toISOString();

    this.supervisor = new HostSupervisor({
      command: this.config.dshCmd,
      dshPort: this.config.dshPort,
      dshHost: this.config.dshHost,
      healthIntervalMs: this.config.healthIntervalMs,
      logger: this.logger,
      audit: this.audit,
      ...(this.spawnImpl === undefined ? {} : { spawnImpl: this.spawnImpl }),
    });    const supervision = await this.supervisor.start();
    if (supervision.advisory !== undefined) this.logger.warn(supervision.advisory);

    if (this.config.noDiscovery !== true) {
      this.discovery = new DiscoveryService({
        name: this.config.name,
        port: this.port,
        discoveryPort: this.config.discoveryPort,
        hostkitPub: this.identity.publicKey,
        tls: this.tls.enabled,
        announceIntervalMs: this.config.announceIntervalMs,
        logger: this.logger,
      });
      this.discovery.on('error', (error) => this.logger.debug(`discovery: ${error.message}`));
      try {
        await this.discovery.start();
      } catch (error) {
        this.logger.warn(`discovery: disabled (${error.message})`);
        this.discovery.close();
        this.discovery = null;
      }
    }

    this.audit.append('hostkit.start', {
      version: VERSION,
      port: this.port,
      bind: this.config.bindHost,
      tls: this.tls.enabled,
      dshPort: this.config.dshPort,
      supervise: this.supervisor.status().supervised,
    });
    return {
      port: this.port,
      tls: this.tls.enabled,
      url: `${this.tls.enabled ? 'wss' : 'ws'}://${this.config.bindHost === '0.0.0.0' ? '127.0.0.1' : this.config.bindHost}:${this.port}/tunnel`,
    };
  }

  /**
   * The address a phone should dial. `0.0.0.0` is not dialable, so pick the first LAN address, falling
   * back to loopback.
   * @returns {string}
   */
  advertiseHost() {
    if (this.config.bindHost !== '0.0.0.0' && this.config.bindHost !== '::') return this.config.bindHost;
    const addresses = platformLanAddresses();
    return addresses[0] ?? '127.0.0.1';
  }

  /* ---------------- HTTP routes ---------------- */

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @returns {void}
   */
  handleRequest(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'POST' && url.pathname === '/pair') {
      void this.handlePair(request, response);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { ok: true, name: this.config.name, version: VERSION });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/state') {
      if (!this.authorizeAdmin(url.searchParams.get('token'))) {
        this.audit.append('tunnel.reject', { route: '/state', remote: request.socket.remoteAddress, reason: 'unauthorized-status' });
        sendJson(response, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      sendJson(response, 200, this.stateReport());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/audit') {
      if (!this.authorizeAdmin(url.searchParams.get('token'))) {
        this.audit.append('tunnel.reject', { route: '/audit', remote: request.socket.remoteAddress, reason: 'unauthorized-audit' });
        sendJson(response, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      const tail = Number(url.searchParams.get('tail') ?? '50');
      sendJson(response, 200, this.audit.read({ tail: Number.isFinite(tail) ? Math.max(1, Math.min(1000, tail)) : 50 }));
      return;
    }
    sendJson(response, 404, { ok: false, error: 'not-found', routes: ['POST /pair', 'GET /health', 'GET /state', 'GET /audit', 'GET /tunnel (upgrade)'] });
  }

  /**
   * @param {string|null} token
   * @returns {boolean}
   */
  authorizeAdmin(token) {
    if (typeof token !== 'string' || token === '') return false;
    if (constantTimeEqual(token, this.adminToken)) return true;
    // The pairing token is accepted too, so the QR/URI alone is enough for a phone to poll status.
    const window = this.pairing.activePairId === null ? undefined : this.pairing.windows.get(this.pairing.activePairId);
    return window !== undefined && constantTimeEqual(token, window.pairToken);
  }

  /**
   * `POST /pair`: exchange a one-time pairing token for a place in the whitelist.
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @returns {Promise<void>}
   */
  async handlePair(request, response) {
    const remote = request.socket.remoteAddress ?? 'unknown';
    let body;
    try {
      body = await readJsonBody(request, MAX_PAIR_BODY);
    } catch (error) {
      this.audit.append('pair.reject', { remote, reason: 'bad-body', message: error.message });
      sendJson(response, 400, { ok: false, code: 'bad-request' });
      return;
    }
    const verified = this.pairing.consume(body);
    if (!verified.ok) {
      this.audit.append('pair.reject', { remote, reason: verified.reason, deviceId: typeof body?.deviceId === 'string' ? body.deviceId : undefined });
      // Deliberately vague on the wire: a LAN attacker learns only "no".
      sendJson(response, 403, { ok: false, code: 'pairing-rejected' });
      return;
    }
    const record = this.whitelist.add({
      deviceId: String(body.deviceId),
      devicePub: String(body.devicePub),
      deviceName: typeof body.deviceName === 'string' && body.deviceName !== '' ? body.deviceName : undefined,
    });
    this.audit.append('pair.success', {
      remote,
      deviceId: record.deviceId,
      deviceName: record.deviceName,
      pairs: record.pairs,
    });
    this.logger.info(`paired device ${record.deviceName} (${record.deviceId})`);
    sendJson(response, 200, {
      ok: true,
      v: 1,
      hostkitPub: this.identity.publicKey,
      name: this.config.name,
      port: this.port,
      tls: this.tls.enabled,
      deviceId: record.deviceId,
    });
  }

  /* ---------------- tunnel endpoint ---------------- */

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:net').Socket} socket
   * @param {Buffer} head
   * @returns {void}
   */
  handleUpgrade(request, socket, head) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const remote = request.socket.remoteAddress ?? 'unknown';
    if (url.pathname !== '/tunnel') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      this.audit.append('tunnel.reject', { remote, reason: 'unknown-upgrade-path', path: url.pathname });
      return;
    }
    if (!isUpgrade(request)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      this.audit.append('tunnel.reject', { remote, reason: 'too-many-sessions' });
      return;
    }
    let ws;
    try {
      ws = acceptUpgrade(request, socket, head);
    } catch (error) {
      this.logger.debug(`tunnel: upgrade rejected: ${error.message}`);
      return;
    }
    const session = new TunnelSession({
      ws,
      hostkitPrivate: this.identity.privateKey,
      hostkitPublic: this.identity.publicKey,
      whitelist: this.whitelist,
      proxy: this.proxy,
      audit: this.audit,
      remoteAddress: remote,
      pingIntervalMs: this.config.pingIntervalMs,
      maxBodyBytes: this.config.maxBodyBytes,
      logger: this.logger,
    });
    session.on('error', (error) => this.logger.debug(`tunnel: session error: ${error.message}`));
    session.on('close', () => {
      this.sessions.delete(session);
    });
    this.sessions.add(session);
  }

  /* ---------------- pairing window ---------------- */

  /**
   * Open a pairing window and return everything needed to display/publish it.
   * @param {{host?: string}} [options]
   * @returns {{payload: object, uri: string, expiresAt: number, manualCode: string}}
   */
  openPairingWindow(options = {}) {
    const window = this.pairing.openWindow({ name: this.config.name });
    const host = options.host ?? this.advertiseHost();
    const payload = PairingService.payload({
      name: this.config.name,
      host,
      port: this.port,
      hostkitPub: this.identity.publicKey,
      pairId: window.pairId,
      pairToken: window.pairToken,
      expiresAt: window.expiresAt,
      tls: this.tls.enabled,
    });
    this.audit.append('pair.window.open', { pairId: window.pairId, host, port: this.port, expiresAt: window.expiresAt });
    this.pairing.onEvent = (event) => {
      if (event.type === 'close' || event.type === 'expire') {
        this.audit.append('pair.window.close', { pairId: event.pairId, reason: event.reason ?? event.type });
        this.discovery?.setPairing(false);
      }
    };
    this.discovery?.setPairing(true);
    return {
      payload,
      uri: PairingService.toUri(payload),
      expiresAt: window.expiresAt,
      // Six digits derived from the token: enough to type by hand, never enough to brute force before
      // the window closes (10^6 against a 120 s window).
      manualCode: manualCodeFrom(window.pairToken),
    };
  }

  /** @returns {void} */
  closePairingWindow() {
    this.pairing.onEvent = (event) => {
      if (event.type === 'close' || event.type === 'expire') {
        this.audit.append('pair.window.close', { pairId: event.pairId, reason: event.reason ?? event.type });
      }
    };
    this.pairing.closeWindow('requested');
    this.discovery?.setPairing(false);
  }

  /**
   * Revoke a device: persistent flag + immediate teardown of its live sessions (D1 §6.5 「密钥可单设备吊销」).
   * @param {string} deviceId
   * @returns {{revoked: boolean, sessionsClosed: number}}
   */
  revoke(deviceId) {
    const record = this.whitelist.revoke(deviceId);
    let sessionsClosed = 0;
    for (const session of this.sessions) {
      if (session.deviceId === deviceId) {
        session.kick('revoked');
        sessionsClosed += 1;
      }
    }
    if (record !== undefined) {
      this.audit.append('device.revoke', { deviceId, sessionsClosed, deviceName: record.deviceName });
    }
    return { revoked: record !== undefined, sessionsClosed };
  }

  /** @returns {object} machine-readable status */
  stateReport() {
    return {
      version: VERSION,
      startedAt: this.startedAt,
      name: this.config.name,
      hostkitPub: this.identity.publicKey,
      port: this.port,
      bindHost: this.config.bindHost,
      advertiseHost: this.advertiseHost(),
      tls: { enabled: this.tls.enabled, cert: this.tls.cert === '' ? null : this.tls.cert },
      dsh: {
        host: this.config.dshHost,
        port: this.config.dshPort,
        supervised: this.supervisor?.status().supervised ?? false,
        pid: this.supervisor?.status().pid ?? null,
        ready: this.supervisor?.status().ready ?? false,
        restarts: this.supervisor?.status().restarts ?? 0,
        announcement: this.supervisor?.status().announcement ?? null,
      },
      discovery: { enabled: this.discovery !== null, port: this.config.discoveryPort, pairing: this.discovery?.pairing ?? false },
      pairing: { open: this.pairing.isOpen, expiresAt: this.pairing.activePairId === null ? null : (this.pairing.windows.get(this.pairing.activePairId)?.expiresAt ?? null) },
      devices: this.whitelist.list().map((device) => ({
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        pairedAt: device.pairedAt,
        lastSeenAt: device.lastSeenAt ?? null,
        revokedAt: device.revokedAt ?? null,
      })),
      sessions: [...this.sessions].map((session) => ({
        deviceId: session.deviceId,
        sessionId: session.sessionId,
        remote: session.remoteAddress,
      })),
    };
  }

  /** Stop everything, in reverse order of startup. */
  async stop() {
    const closing = [...this.sessions];
    for (const session of closing) {
      try {
        session.finish('hostkit-stop');
      } catch {
        /* best effort */
      }
    }
    this.sessions.clear();
    this.discovery?.close();
    this.discovery = null;
    this.proxy.destroy();
    if (this.supervisor !== null) await this.supervisor.stop();
    if (this.server !== null) {
      // An upgraded socket is not tracked by the HTTP server's own connection accounting, so
      // `close()` would wait forever for a peer that is still holding the connection open. Terminate
      // the upgraded sockets explicitly first — these are exactly the sockets we created.
      for (const session of closing) {
        try {
          session.ws.destroy();
        } catch {
          /* best effort */
        }
      }
      if (typeof this.server.closeAllConnections === 'function') this.server.closeAllConnections();
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }
    this.audit.append('hostkit.stop', { port: this.port });
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** @returns {string[]} non-internal IPv4 addresses, most likely first */
function platformLanAddresses() {
  const list = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const info of entries ?? []) {
      if ((info.family === 'IPv4' || info.family === 4) && !info.internal) list.push(info.address);
    }
  }
  return list;
}

/**
 * Six-digit manual code derived from the pairing token. Displayed alongside the QR so a phone without
 * a working camera (or a user typing on a PC) can pair. It is *not* an independent secret: the server
 * still requires the full `pairId` + `pairToken` over `POST /pair`, and the code is only a human
 * convenience for the UI.
 * @param {string} pairToken
 * @returns {string}
 */
export function manualCodeFrom(pairToken) {
  let hash = 0;
  for (const char of pairToken) hash = (hash * 31 + char.codePointAt(0)) % 1_000_000;
  return String(hash).padStart(6, '0');
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {number} limit
 * @returns {Promise<object>}
 */
function readJsonBody(request, limit) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error(`body exceeds ${limit} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks, total).toString('utf8');
        const parsed = text === '' ? {} : JSON.parse(text);
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {object} body
 * @returns {void}
 */
function sendJson(response, status, body) {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

/**
 * Mint a self-signed certificate with the platform's `openssl`, if one exists. Returns the paths;
 * throws a helpful error if `openssl` is unavailable so the user can pass `--cert`/`--key` instead.
 * @param {string} dir
 * @param {object} logger
 * @returns {{cert: string, key: string}}
 */
export function mintSelfSigned(dir, logger) {
  const cert = path.join(dir, 'hostkit-selfsigned.crt');
  const key = path.join(dir, 'hostkit-selfsigned.key');
  if (fs.existsSync(cert) && fs.existsSync(key)) return { cert, key };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const candidates = platform.findOpensslCandidates();
  for (const candidate of candidates) {
    const result = spawnSync(
      candidate,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '825',
        '-subj',
        '/CN=dsh-harmony-hostkit',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    if (result.status === 0 && fs.existsSync(cert) && fs.existsSync(key)) {
      logger.info(`tls: minted a self-signed certificate at ${cert}`);
      return { cert, key };
    }
  }
  throw new Error(
    'tls: --tls-selfsigned requested but no usable `openssl` was found. Either install openssl, or pass ' +
      '--cert <pem> --key <pem>. The tunnel payload is end-to-end encrypted either way; TLS only hides ' +
      'the handshake metadata.',
  );
}

export { VERSION };
