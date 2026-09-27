/**
 * proxy.mjs tests: the loopback exit.
 *
 * The proxy is the only component that talks to the dsh Host, so its tests assert the two properties
 * the whole L1 design rests on:
 *   1. the upstream request is made from loopback with the **client's** cookie and Host header intact;
 *   2. hop-by-hop headers are the only thing hostkit rewrites.
 *
 * It also covers the failure paths that must not become unbounded memory: an oversized upstream body
 * and a non-absolute path from a client.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { HostProxy, ProxyError } from '../src/core/proxy.mjs';
import { acceptUpgrade, isUpgrade } from '../src/core/ws.mjs';
import { delay } from './helpers/util.helper.mjs';

/**
 * A fake Host that records what it saw.
 *
 * Upgraded sockets are explicitly destroyed on teardown: on Windows a socket handed to an `upgrade`
 * listener is no longer tracked by the HTTP server, so `server.close()` would otherwise wait forever.
 * @param {import('node:test').TestContext} t
 * @param {{bodyBytes?: number}} [options]
 */
async function startFakeHost(t, options = {}) {
  /** @type {object[]} */
  const seen = [];
  /** @type {import('../src/core/ws.mjs').WsConnection[]} */
  const upgrades = [];
  const server = http.createServer((request, response) => {
    /** @type {Buffer[]} */
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({
        method: request.method,
        url: request.url,
        headers: { ...request.headers },
        body: Buffer.concat(chunks),
        remote: request.socket.remoteAddress,
      });
      if (request.url === '/big') {
        const size = options.bodyBytes ?? 1024;
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(Buffer.alloc(size, 0x41));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'x-seen-cookie': request.headers.cookie ?? '' });
      response.end(JSON.stringify({ ok: true, url: request.url, cookie: request.headers.cookie ?? null, host: request.headers.host ?? null }));
    });
  });
  server.on('upgrade', (request, socket, head) => {
    if (!isUpgrade(request)) {
      socket.destroy();
      return;
    }
    seen.push({ upgrade: true, url: request.url, headers: { ...request.headers }, remote: request.socket.remoteAddress });
    const connection = acceptUpgrade(request, socket, head);
    upgrades.push(connection);
    connection.on('message', (payload, isBinary) => connection.send(payload, { binary: isBinary }));
    connection.on('close', () => {});
  });  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const connection of upgrades) connection.destroy();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  });
  return { port: server.address().port, seen };
}

test('forwardUnary dials loopback and passes the client cookie and Host through untouched', async (t) => {
  const host = await startFakeHost(t);
  const proxy = new HostProxy({ dshPort: host.port });
  t.after(() => proxy.destroy());

  const result = await proxy.forwardUnary({
    id: 'c1',
    method: 'POST',
    path: '/api/session/list',
    headers: {
      'content-type': 'application/json',
      cookie: 'dsh-auth-TEST=secret',
      host: `127.0.0.1:${host.port}`,
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
    },
    body: Buffer.from('{"x":1}'),
  });

  assert.equal(result.status, 200);
  assert.equal(result.headers['x-seen-cookie'], 'dsh-auth-TEST=secret');
  const body = JSON.parse(result.body.toString('utf8'));
  assert.equal(body.cookie, 'dsh-auth-TEST=secret');
  assert.equal(body.host, `127.0.0.1:${host.port}`);

  const entry = host.seen[0];
  assert.equal(entry.url, '/api/session/list');
  assert.equal(entry.method, 'POST');
  assert.equal(entry.remote === '127.0.0.1' || entry.remote === '::1' || entry.remote === '::ffff:127.0.0.1', true);
  assert.equal(entry.body.toString('utf8'), '{"x":1}');
  assert.equal(entry.headers['content-length'], '7', 'hostkit sets the length the client omitted');
  // Hop-by-hop headers are the only thing removed.
  assert.equal(entry.headers['transfer-encoding'], undefined);
});

test('forwardUnary preserves array-valued response headers (set-cookie)', async (t) => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'], 'content-type': 'text/plain' });
    response.end('ok');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(() => resolve())));

  const proxy = new HostProxy({ dshPort: server.address().port });
  t.after(() => proxy.destroy());
  const result = await proxy.forwardUnary({ id: 'c', method: 'GET', path: '/', headers: {}, body: Buffer.alloc(0) });
  assert.deepEqual(result.headers['set-cookie'], ['a=1; Path=/', 'b=2; Path=/']);
});

test('forwardUnary refuses a path that is not absolute (no absolute-URL smuggling)', async (t) => {
  const host = await startFakeHost(t);
  const proxy = new HostProxy({ dshPort: host.port });
  t.after(() => proxy.destroy());
  await assert.rejects(
    proxy.forwardUnary({ id: 'c', method: 'POST', path: 'http://evil.example/steal', headers: {}, body: Buffer.alloc(0) }),
    (error) => error instanceof ProxyError && error.code === 'bad-path',
  );
  await assert.rejects(
    proxy.forwardUnary({ id: 'c', method: 'POST', path: '', headers: {}, body: Buffer.alloc(0) }),
    (error) => error.code === 'bad-path',
  );
  await assert.rejects(
    proxy.forwardUnary({ id: 'c', method: 'POST', path: undefined, headers: {}, body: Buffer.alloc(0) }),
    (error) => error.code === 'bad-path',
  );
  assert.equal(host.seen.length, 0, 'nothing may reach the Host for a rejected path');
});

test('forwardUnary reports an oversized upstream body as too-large instead of buffering it', async (t) => {
  const host = await startFakeHost(t, { bodyBytes: 4096 });
  const proxy = new HostProxy({ dshPort: host.port, maxBodyBytes: 1024 });
  t.after(() => proxy.destroy());
  await assert.rejects(
    proxy.forwardUnary({ id: 'c', method: 'GET', path: '/big', headers: {}, body: Buffer.alloc(0) }),
    (error) => error instanceof ProxyError && error.code === 'too-large',
  );
  assert.equal(proxy.inflight.size, 0, 'the aborted request must be dropped from the in-flight map');
});

test('forwardUnary surfaces a connection failure as a rejected promise', async (t) => {
  // Bind a port, then close it, so nothing is listening.
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(() => resolve()));

  const proxy = new HostProxy({ dshPort: port });
  t.after(() => proxy.destroy());
  await assert.rejects(proxy.forwardUnary({ id: 'c', method: 'POST', path: '/api/x', headers: {}, body: Buffer.alloc(0) }));
});

test('openStream dials the upstream mux and bridges both directions', async (t) => {
  const host = await startFakeHost(t);
  const proxy = new HostProxy({ dshPort: host.port });
  t.after(() => proxy.destroy());

  /** @type {{data: string, binary: boolean}[]} */
  const received = [];
  /** @type {object[]} */
  const closes = [];
  const opened = await proxy.openStream('stream-1', '/api/remote.mux', {
    headers: { cookie: 'dsh-auth-TEST=secret' },
    onData: (id, dataB64, binary) => received.push({ id, data: Buffer.from(dataB64, 'base64').toString('utf8'), binary }),
    onClose: (frame) => closes.push(frame),
  });
  assert.deepEqual(opened, { subprotocol: null, headers: {} });
  assert.equal(proxy.streams.size, 1);

  const upstream = host.seen.find((entry) => entry.upgrade === true);
  assert.equal(upstream.url, '/api/remote.mux');
  assert.equal(upstream.headers.cookie, 'dsh-auth-TEST=secret');
  assert.equal(upstream.headers.host, `127.0.0.1:${host.port}`);

  const frame = JSON.stringify({ type: 'open', streamId: 'x', endpoint: 'session/list', payload: { args: { _request: {} } } });
  assert.equal(proxy.sendStreamData('stream-1', Buffer.from(frame), false), true);
  const deadline = Date.now() + 3000;
  while (received.length === 0 && Date.now() < deadline) await delay(20);
  assert.equal(received.length, 1);
  assert.equal(received[0].data, frame);
  // The echo comes back as the fake Host re-sent it; the mux frames are JSON text, so the bridge must
  // not have upgraded them to binary somewhere in between.
  assert.equal(received[0].binary, false, 'a text mux frame must stay a text frame');

  assert.equal(proxy.sendStreamData('nope', Buffer.from('x')), false, 'an unknown stream id is reported, not thrown');
});

test('closeStream closes the upstream socket and reports it once', async (t) => {
  const host = await startFakeHost(t);
  const proxy = new HostProxy({ dshPort: host.port });
  t.after(() => proxy.destroy());

  /** @type {object[]} */
  const closes = [];
  await proxy.openStream('s', '/api/remote.mux', {
    headers: {},
    onData: () => {},
    onClose: (frame) => closes.push(frame),
  });
  assert.equal(proxy.streams.size, 1);
  proxy.closeStream('s', 1000, 'done');
  assert.equal(proxy.streams.size, 0);
  await delay(200);
  assert.equal(closes.length, 1);
  assert.equal(closes[0].kind, 'ws-close');
  assert.equal(closes[0].id, 's');
  assert.equal(closes[0].code, 1000);

  // Closing an unknown stream is a no-op, not a throw.
  assert.doesNotThrow(() => proxy.closeStream('unknown', 1000, 'x'));
});

test('openStream rejects a non-absolute path', async (t) => {
  const host = await startFakeHost(t);
  const proxy = new HostProxy({ dshPort: host.port });
  t.after(() => proxy.destroy());
  await assert.rejects(
    proxy.openStream('s', 'remote.mux', { headers: {}, onData: () => {}, onClose: () => {} }),
    (error) => error instanceof ProxyError && error.code === 'bad-path',
  );
});

test('destroy() aborts in-flight requests and closes every stream', async (t) => {
  const host = await startFakeHost(t);
  const proxy = new HostProxy({ dshPort: host.port });
  await proxy.openStream('s', '/api/remote.mux', { headers: {}, onData: () => {}, onClose: () => {} });
  const pending = proxy.forwardUnary({ id: 'slow', method: 'GET', path: '/slow', headers: {}, body: Buffer.alloc(0) });
  proxy.destroy();
  assert.equal(proxy.streams.size, 0);
  assert.equal(proxy.inflight.size, 0);
  // The in-flight call must settle (with a rejection) rather than hang forever.
  await assert.rejects(pending);
});

test('baseUrl documents the loopback exit', () => {
  const proxy = new HostProxy({ dshPort: 3111 });
  assert.equal(proxy.baseUrl, 'http://127.0.0.1:3111');
});
