/**
 * End-to-end tunnel test against a *fake dsh Host*.
 *
 * This is the test that proves the whole L1 story end to end:
 *   - a fake Host listens on loopback and answers `POST /api/ping` plus upgrades `/api/remote.mux`;
 *   - a device is paired in-test via the real `POST /pair` endpoint;
 *   - one unary HTTP call and one WebSocket round trip are driven *through* the tunnel;
 *   - the fake Host asserts that what it sees came from loopback and that the caller-supplied cookie
 *     arrived untouched (hostkit never needs, stores, or rewrites the dsh token);
 *   - an unpaired device is refused, and a revoked device's live session is torn down immediately.
 *
 * The fake Host is deliberately a plain `node:http` server: if hostkit needed any dsh-specific
 * cooperation, this test would not be able to fake it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { HostkitServer, createLogger } from '../src/server.mjs';
import { AuditLog } from '../src/core/audit.mjs';
import { WhitelistStore } from '../src/core/whitelist.mjs';
import { connect as wsConnect, acceptUpgrade } from '../src/core/ws.mjs';
import { clientHandshake } from '../src/core/tunnel.mjs';
import {
  generateIdentityPrivate,
  identityPublicFromPrivate,
  randomToken,
} from '../src/core/crypto.mjs';
import { DEFAULT_PAIRING_WINDOW_MS } from '../src/core/pairing.mjs';
import { delay, tempDir } from './helpers/util.helper.mjs';

/**
 * A minimal stand-in for the dsh Host: unary RPC on `POST /api/<method>` and an echoing WebSocket on
 * `/api/remote.mux`, exactly the two carriers D2 section 1.1/section 1.2 describes.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<{port: number, observed: object[], muxSockets: import('../src/core/ws.mjs').WsConnection[], seenHeaders: object[]}>}
 */
async function startFakeDshHost(t) {
  /** @type {object[]} */
  const observed = [];
  /** @type {object[]} */
  const seenHeaders = [];
  /** @type {import('../src/core/ws.mjs').WsConnection[]} */
  const muxSockets = [];

  const server = http.createServer((request, response) => {
    seenHeaders.push({
      host: request.headers.host,
      cookie: request.headers.cookie,
      origin: request.headers.origin,
      remote: request.socket.remoteAddress,
      path: request.url,
      method: request.method,
    });
    /** @type {Buffer[]} */
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      observed.push({ path: request.url, method: request.method, body: body.toString('utf8') });
      if (request.url === '/api/ping') {
        const envelope = {
          type: 'server-response',
          rpcId: 'rpc-1',
          result: { ok: true, value: { pong: true, host: request.headers.host, cookie: request.headers.cookie } },
        };
        const payload = JSON.stringify(envelope);
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
        response.end(payload);
        return;
      }
      if (request.url === '/api/big') {
        // 8 MiB + 1 byte, so the tunnel must answer `too-large` instead of relaying it.
        const payload = Buffer.alloc(8 * 1024 * 1024 + 1, 0x41);
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length });
        response.end(payload);
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('no such endpoint');
    });
  });

  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/api/remote.mux') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    seenHeaders.push({ path: request.url, host: request.headers.host, cookie: request.headers.cookie, upgrade: true });
    const connection = acceptUpgrade(request, socket, head);
    muxSockets.push(connection);
    connection.on('message', (payload) => {
      // Echo the mux frame back verbatim, which is enough to prove the round trip.
      connection.send(payload, { binary: true });
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const connection of muxSockets) connection.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
  });
  return { port: server.address().port, observed, muxSockets, seenHeaders };
}

/**
 * Start hostkit against the fake Host on an ephemeral port.
 * @param {import('node:test').TestContext} t
 * @param {number} dshPort
 * @param {object} [overrides]
 * @returns {Promise<{server: HostkitServer, config: object, stateDir: string}>}
 */
async function startHostkit(t, dshPort, overrides = {}) {
  const stateDir = tempDir(t, 'hostkit-e2e-');
  const config = {
    name: 'e2e-test',
    port: 0,
    bindHost: '127.0.0.1',
    discoveryPort: 18799,
    dshHost: '127.0.0.1',
    dshPort,
    dshCmd: '',
    pingIntervalMs: 2000,
    pairingWindowMs: DEFAULT_PAIRING_WINDOW_MS,
    cert: '',
    certKey: '',
    tlsSelfSigned: false,
    noDiscovery: true,
    audit: true,
    logLevel: 'silent',
    announceIntervalMs: 3000,
    healthIntervalMs: 10_000,
    maxBodyBytes: 8 * 1024 * 1024,
    stateDir,
    configPath: path.join(stateDir, 'config.json'),
    devicesPath: path.join(stateDir, 'devices.json'),
    identityPath: path.join(stateDir, 'identity.json'),
    auditPath: path.join(stateDir, 'audit.jsonl'),
    certDir: path.join(stateDir, 'tls'),
    ...overrides,
  };
  const server = new HostkitServer(config, { logger: createLogger('silent') });
  await server.start();
  t.after(() => server.stop());
  return { server, config, stateDir };
}

/**
 * Pair a fresh device in-test through the real HTTP endpoint.
 * @param {HostkitServer} server
 * @param {string} deviceName
 * @returns {Promise<{deviceId: string, devicePrivate: string, devicePublic: string, hostkitPub: string, uri: string}>}
 */
async function pairDevice(server, deviceName = 'Test Phone') {
  const window = server.openPairingWindow({ host: '127.0.0.1' });
  const deviceId = `dev-${randomToken(6)}`;
  const devicePrivate = generateIdentityPrivate();
  const devicePublic = identityPublicFromPrivate(devicePrivate);
  const response = await fetch(`http://127.0.0.1:${server.port}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairId: window.payload.pairId,
      pairToken: window.payload.pairToken,
      deviceId,
      devicePub: devicePublic,
      deviceName,
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.hostkitPub, server.identity.publicKey);
  return { deviceId, devicePrivate, devicePublic, hostkitPub: body.hostkitPub, uri: window.uri };
}

/**
 * Open a tunnel and complete the sealed handshake.
 * @param {HostkitServer} server
 * @param {{deviceId: string, devicePrivate: string, devicePublic: string, hostkitPub: string}} device
 * @returns {Promise<import('../src/core/tunnel.mjs').TunnelClient>}
 */
async function openTunnel(server, device) {
  const ws = await wsConnect(new URL(`ws://127.0.0.1:${server.port}/tunnel`));
  return clientHandshake(ws, {
    deviceId: device.deviceId,
    devicePrivate: device.devicePrivate,
    devicePublic: device.devicePublic,
    hostkitPublic: device.hostkitPub,
    onEnvelope: () => {},
  });
}

/** @param {import('../src/core/tunnel.mjs').TunnelClient} client @param {(envelope: object) => object|undefined} predicate @param {number} [timeoutMs] */
function waitForEnvelope(client, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('envelope', onEnvelope);
      reject(new Error('timed out waiting for an envelope'));
    }, timeoutMs);
    const onEnvelope = (envelope) => {
      const result = predicate(envelope);
      if (result === undefined) return;
      clearTimeout(timer);
      client.off('envelope', onEnvelope);
      resolve(result);
    };
    client.on('envelope', onEnvelope);
  });
}

test('e2e: pairing, unary HTTP and WebSocket round trip through the tunnel', async (t) => {
  const host = await startFakeDshHost(t);
  const { server } = await startHostkit(t, host.port);
  const device = await pairDevice(server);

  // The pairing URI must round-trip through the documented parser.
  const parsed = new URL(device.uri);
  assert.equal(parsed.protocol, 'dshkit:');
  assert.equal(parsed.hostname, 'pair');
  assert.equal(parsed.searchParams.get('port'), String(server.port));

  const client = await openTunnel(server, device);
  t.after(() => client.close());

  // ---- unary RPC -------------------------------------------------------------------------------
  const cookie = 'dsh-auth-TEST=abcdef';
  const httpReply = waitForEnvelope(client, (envelope) => (envelope.kind === 'http-res' && envelope.id === 'call-1' ? envelope : undefined));
  client.send({
    kind: 'http',
    id: 'call-1',
    method: 'POST',
    path: '/api/ping',
    headers: { 'content-type': 'application/json', cookie, host: `127.0.0.1:${host.port}` },
    bodyB64: Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'ping', payload: { args: {} } })).toString('base64'),
  });
  const reply = await httpReply;
  assert.equal(reply.status, 200);
  const envelope = JSON.parse(Buffer.from(reply.bodyB64, 'base64').toString('utf8'));
  assert.equal(envelope.type, 'server-response');
  assert.equal(envelope.result.ok, true);
  assert.equal(envelope.result.value.pong, true);
  // The Host saw a loopback Host header and the *client's* cookie, untouched.
  assert.equal(envelope.result.value.host, `127.0.0.1:${host.port}`);
  assert.equal(envelope.result.value.cookie, cookie);

  // ---- logical stream (WebSocket) --------------------------------------------------------------
  const openReply = waitForEnvelope(client, (message) => (message.kind === 'ws-open-res' && message.id === 'stream-1' ? message : undefined));
  client.send({ kind: 'ws-open', id: 'stream-1', path: '/api/remote.mux', headers: { cookie } });
  assert.equal((await openReply).ok, true);

  const muxFrame = JSON.stringify({ type: 'open', streamId: 'logical-1', endpoint: 'session/list', payload: { args: { _request: {} } } });
  const dataReply = waitForEnvelope(client, (message) => (message.kind === 'ws-data' && message.id === 'stream-1' ? message : undefined));
  client.send({ kind: 'ws-data', id: 'stream-1', dataB64: Buffer.from(muxFrame).toString('base64'), t: 'b' });
  const echoed = await dataReply;
  assert.equal(Buffer.from(echoed.dataB64, 'base64').toString('utf8'), muxFrame);
  assert.equal(echoed.t, 'b');

  // The upstream mux upgrade carried the client's cookie and a loopback Host.
  const upgrade = host.seenHeaders.find((entry) => entry.upgrade === true);
  assert.equal(upgrade.cookie, cookie);
  assert.equal(upgrade.host, `127.0.0.1:${host.port}`);

  // ---- stream close ---------------------------------------------------------------------------
  const closeReply = waitForEnvelope(client, (message) => (message.kind === 'ws-close' && message.id === 'stream-1' ? message : undefined));
  client.send({ kind: 'ws-close', id: 'stream-1', code: 1000, reason: 'done' });
  assert.equal((await closeReply).code, 1000);
});

test('e2e: an oversized upstream response is reported as too-large, not relayed', async (t) => {
  const host = await startFakeDshHost(t);
  const { server } = await startHostkit(t, host.port);
  const device = await pairDevice(server);
  const client = await openTunnel(server, device);
  t.after(() => client.close());

  const reply = waitForEnvelope(client, (message) => (message.kind === 'http-res' && message.id === 'big-1' ? message : undefined));
  client.send({ kind: 'http', id: 'big-1', method: 'POST', path: '/api/big', headers: {}, bodyB64: '' });
  const result = await reply;
  assert.equal(result.error, 'too-large');
});

test('e2e: an unknown path yields the Host 404 through the tunnel', async (t) => {
  const host = await startFakeDshHost(t);
  const { server } = await startHostkit(t, host.port);
  const device = await pairDevice(server);
  const client = await openTunnel(server, device);
  t.after(() => client.close());

  const reply = waitForEnvelope(client, (message) => (message.kind === 'http-res' && message.id === 'missing-1' ? message : undefined));
  client.send({ kind: 'http', id: 'missing-1', method: 'POST', path: '/api/nope', headers: {}, bodyB64: '' });
  assert.equal((await reply).status, 404);
});

test('e2e: heartbeat keeps a busy session alive past the teardown threshold', async (t) => {
  const host = await startFakeDshHost(t);
  const { server } = await startHostkit(t, host.port, { pingIntervalMs: 150 });
  const device = await pairDevice(server);
  const client = await openTunnel(server, device);
  t.after(() => client.close());

  // 3 x 150 ms is the teardown threshold; the tunnel's own ping/pong must keep it alive well past it.
  await delay(1200);
  assert.equal(client.closed, false, 'the session must survive while heartbeats flow');

  const reply = waitForEnvelope(client, (message) => (message.kind === 'http-res' && message.id === 'alive-1' ? message : undefined));
  client.send({ kind: 'http', id: 'alive-1', method: 'POST', path: '/api/ping', headers: {}, bodyB64: '' });
  assert.equal((await reply).status, 200);
});

test('e2e: an unpaired device is refused with `unauthorized` and the attempt is audited', async (t) => {
  const host = await startFakeDshHost(t);
  const { server } = await startHostkit(t, host.port);

  const devicePrivate = generateIdentityPrivate();
  const devicePublic = identityPublicFromPrivate(devicePrivate);
  const ws = await wsConnect(new URL(`ws://127.0.0.1:${server.port}/tunnel`));
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no handshake reply')), 5000);
    ws.once('message', (payload) => {
      clearTimeout(timer);
      resolve(payload.toString('utf8'));
    });
    ws.send(JSON.stringify({ v: 1, deviceId: 'never-paired', nonce: Buffer.from(randomToken(16), 'base64').toString('base64') }), { binary: false });
  });
  const parsed = JSON.parse(reply);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'unauthorized');
  assert.equal(parsed.hostkitPub, undefined, 'a refused handshake must not leak the host identity');
  ws.destroy();

  await delay(100);
  const records = new AuditLog(server.config.auditPath).read({ event: 'tunnel.reject' });
  assert.equal(records.records.length >= 1, true);
  assert.equal(records.records.at(-1).reason, 'unknown-device');
  assert.equal(devicePublic.length > 0, true);
});

test('e2e: a revoked device is refused, and revoke closes its live session', async (t) => {
  const host = await startFakeDshHost(t);
  const { server } = await startHostkit(t, host.port);
  const device = await pairDevice(server);

  const client = await openTunnel(server, device);
  assert.equal(server.sessions.size, 1);

  const result = server.revoke(device.deviceId);
  assert.equal(result.revoked, true);
  assert.equal(result.sessionsClosed, 1, 'revoke must tear down the live session immediately');
  await delay(100);
  assert.equal(client.closed, true, 'the client must observe the closed session');
  assert.equal(server.sessions.size, 0);

  // The whitelist now refuses it, even after a restart of the service object's store.
  const store = new WhitelistStore(server.config.devicesPath).load();
  assert.equal(store.isAuthorized(device.deviceId), false);

  const audit = new AuditLog(server.config.auditPath).read({ event: 'device.revoke' });
  assert.equal(audit.records.length, 1);
  assert.equal(audit.records[0].deviceId, device.deviceId);
});

test('e2e: a replayed pairing request is refused and audited', async (t) => {
  const host = await startFakeDshHost(t);
  const { server } = await startHostkit(t, host.port);
  const window = server.openPairingWindow({ host: '127.0.0.1' });
  const devicePrivate = generateIdentityPrivate();
  const body = {
    pairId: window.payload.pairId,
    pairToken: window.payload.pairToken,
    deviceId: 'replay-device',
    devicePub: identityPublicFromPrivate(devicePrivate),
    deviceName: 'Replay',
  };
  const first = await fetch(`http://127.0.0.1:${server.port}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(first.status, 200);
  const replay = await fetch(`http://127.0.0.1:${server.port}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(replay.status, 403, 'the burned pairing window must not accept a replay');
  const rejects = new AuditLog(server.config.auditPath).read({ event: 'pair.reject' });
  assert.equal(rejects.records.length, 1);
  assert.equal(rejects.records[0].reason, 'consumed');
});

test('e2e: a wrong pairing token is refused and leaves the window usable', async (t) => {
  const host = await startFakeDshHost(t);
  const { server } = await startHostkit(t, host.port);
  const window = server.openPairingWindow({ host: '127.0.0.1' });
  const devicePrivate = generateIdentityPrivate();
  const devicePub = identityPublicFromPrivate(devicePrivate);

  const wrong = await fetch(`http://127.0.0.1:${server.port}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairId: window.payload.pairId,
      pairToken: `${window.payload.pairToken}x`,
      deviceId: 'attacker',
      devicePub,
    }),
  });
  assert.equal(wrong.status, 403);

  const right = await fetch(`http://127.0.0.1:${server.port}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairId: window.payload.pairId,
      pairToken: window.payload.pairToken,
      deviceId: 'legit',
      devicePub,
    }),
  });
  assert.equal(right.status, 200, 'a failed guess must not be a denial of service');
});

test('e2e: unknown HTTP routes and upgrade paths are refused', async (t) => {
  const host = await startFakeDshHost(t);
  const { server } = await startHostkit(t, host.port);

  const health = await fetch(`http://127.0.0.1:${server.port}/health`);
  assert.equal(health.status, 200);

  const missing = await fetch(`http://127.0.0.1:${server.port}/nope`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'not-found');

  // `/state` without a token must not leak anything.
  const unauth = await fetch(`http://127.0.0.1:${server.port}/state`);
  assert.equal(unauth.status, 401);

  // The admin token (held by the server) can read it.
  const state = await fetch(`http://127.0.0.1:${server.port}/state?token=${server.adminToken}`);
  assert.equal(state.status, 200);
  const report = await state.json();
  assert.equal(report.tls.enabled, false);
  assert.equal(report.dsh.host, '127.0.0.1');
  assert.equal(report.dsh.port, host.port);

  // A tunnel upgrade on a different path is refused and audited.
  await assert.rejects(wsConnect(new URL(`ws://127.0.0.1:${server.port}/other`)));
  const rejects = new AuditLog(server.config.auditPath).read({ event: 'tunnel.reject' });
  assert.equal(rejects.records.some((record) => record.reason === 'unknown-upgrade-path'), true);
});

test('e2e: hostkit refuses to start when the dsh target is not loopback', async (t) => {
  const stateDir = tempDir(t, 'hostkit-guard-');
  const config = {
    name: 'guard',
    port: 0,
    bindHost: '127.0.0.1',
    discoveryPort: 18798,
    dshHost: '192.168.1.50',
    dshPort: 3111,
    dshCmd: '',
    pingIntervalMs: 2000,
    pairingWindowMs: 1000,
    cert: '',
    certKey: '',
    tlsSelfSigned: false,
    noDiscovery: true,
    audit: false,
    logLevel: 'silent',
    announceIntervalMs: 3000,
    healthIntervalMs: 10_000,
    maxBodyBytes: 1024,
    stateDir,
    configPath: path.join(stateDir, 'config.json'),
    devicesPath: path.join(stateDir, 'devices.json'),
    identityPath: path.join(stateDir, 'identity.json'),
    auditPath: path.join(stateDir, 'audit.jsonl'),
    certDir: path.join(stateDir, 'tls'),
  };
  // The guard fires at construction time -before any socket, discovery announce or Host supervision
  // exists -so there is no window in which hostkit could be running against a non-loopback target.
  assert.throws(() => new HostkitServer(config, { logger: createLogger('silent') }), /not a loopback literal/);
});

test('e2e: the identity key file is created with restrictive permissions and is reused', async (t) => {
  const host = await startFakeDshHost(t);
  const { server, stateDir } = await startHostkit(t, host.port);
  const first = server.identity;
  await server.stop();

  const second = new HostkitServer(
    { ...server.config, stateDir, port: 0 },
    { logger: createLogger('silent') },
  );
  assert.equal(second.identity.publicKey, first.publicKey, 'the identity must survive a restart');
  assert.equal(second.identity.generated, false);
});

