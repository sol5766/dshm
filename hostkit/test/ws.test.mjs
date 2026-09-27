/**
 * ws.mjs tests: the RFC 6455 implementation, exercised over real loopback sockets.
 *
 * A WebSocket implementation is easy to get *nearly* right, so these tests check the parts that are
 * individually observable:
 *   - the handshake accept token matches the spec's SHA-1 construction;
 *   - a 126-byte and a >64 KiB payload round trip (both extended-length encodings);
 *   - a fragmented message reassembles;
 *   - control frames work and a fragmented control frame is a protocol error;
 *   - **masking is enforced in both directions**: the server refuses an unmasked client frame, the
 *     server's own frames are never masked, and client-mode `connect()` masks its frames -which is
 *     what the dsh mux will expect from us.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import {
  CLOSE,
  OPCODE,
  WsConnection,
  WsProtocolError,
  acceptKey,
  acceptUpgrade,
  applyMask,
  connect,
  encodeFrame,
  generateKey,
  isUpgrade,
} from '../src/core/ws.mjs';
import { delay, waitForEvent } from './helpers/util.helper.mjs';

/**
 * Start an HTTP server that accepts WebSocket upgrades on any path (completing the real handshake via
 * `acceptUpgrade`, so the client sees a valid `Sec-WebSocket-Accept`) and hands the connection to
 * `onConnection`.
 * @param {import('node:test').TestContext} t
 * @param {(connection: WsConnection, request: import('node:http').IncomingMessage) => void} onConnection
 * @returns {Promise<{port: number, server: http.Server, connections: WsConnection[]}>}
 */
async function startWsServer(t, onConnection) {
  const server = http.createServer((request, response) => {
    response.writeHead(426, { 'content-type': 'text/plain' });
    response.end('upgrade required');
  });
  /** @type {WsConnection[]} */
  const connections = [];
  server.on('upgrade', (request, socket, head) => {
    if (!isUpgrade(request)) {
      socket.destroy();
      return;
    }
    const connection = acceptUpgrade(request, socket, head);
    connections.push(connection);
    onConnection(connection, request);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
  });
  return { port: server.address().port, server, connections };
}

/**
 * Open a raw TCP connection and complete the client side of the handshake by hand.
 *
 * The 101 response and any frame bytes that arrived in the same TCP segment are kept in `captured`, so a
 * caller can inspect them without racing a late `data` listener.
 * @param {number} port @param {string} [path]
 * @returns {Promise<net.Socket & {captured: Buffer}>}
 */
async function rawHandshake(port, path = '/') {
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.captured = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    socket.captured = Buffer.concat([socket.captured, chunk]);
  });
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${generateKey()}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  // Wait for the response headers.
  const deadline = Date.now() + 3000;
  while (!socket.captured.includes('\r\n\r\n')) {
    if (Date.now() > deadline) throw new Error('raw handshake timed out');
    await delay(10);
  }
  return socket;
}

test('acceptKey matches the RFC 6455 example vector', () => {
  // RFC 6455 section 1.3: key "dGhlIHNhbXBsZSBub25jZQ==" ->accept "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=".
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  assert.equal(Buffer.from(generateKey(), 'base64').length, 16);
});

test('applyMask is its own inverse and handles offsets', () => {
  const payload = Buffer.from('The quick brown fox jumps over the lazy dog');
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const masked = applyMask(payload, mask);
  assert.notDeepEqual(masked, payload);
  assert.deepEqual(applyMask(masked, mask), payload);
  const offsetMasked = applyMask(payload, mask, 2);
  assert.deepEqual(applyMask(offsetMasked, mask, 2), payload);
});

test('frame encode: 7-bit, 16-bit and 64-bit length encodings', () => {
  for (const size of [0, 125, 126, 65535, 65536, 70_000]) {
    const payload = Buffer.alloc(size, 0x5a);
    const framed = encodeFrame(OPCODE.BINARY, payload);
    if (size <= 125) assert.equal(framed[1], size);
    else if (size <= 65535) assert.equal(framed[1], 126);
    else assert.equal(framed[1], 127);
    assert.equal(framed[1] & 0x80, 0, 'server frames must not be masked');
  }
});

test('handshake + payload round trip: small, >125 bytes and >64 KiB', async (t) => {
  /** @type {WsConnection|null} */
  let serverSide = null;
  /** @type {boolean|undefined} */
  let lastServerBinary;
  const { port } = await startWsServer(t, (connection, request) => {
    serverSide = connection;
    connection.on('message', (payload, isBinary) => {
      lastServerBinary = isBinary;
      // Echo it straight back, preserving the text/binary distinction.
      connection.send(payload, { binary: isBinary });
    });
    assert.equal(request.headers['sec-websocket-version'], '13');
  });

  const client = await connect(new URL(`ws://127.0.0.1:${port}/echo`));
  t.after(() => client.destroy());
  await delay(20);
  assert.ok(serverSide !== null, 'the server must have accepted the upgrade');

  for (const payload of [Buffer.from('hi'), Buffer.alloc(200, 0x41), Buffer.alloc(70_000, 0x42)]) {
    const received = waitForEvent(client, 'message');
    client.send(payload);
    const [echo] = await received;
    assert.equal(echo.length, payload.length);
    assert.deepEqual(echo, payload);
    assert.equal(lastServerBinary, true, 'binary frames must arrive with the binary flag set');
  }

  client.send('text-frame');
  const deadline = Date.now() + 3000;
  while (lastServerBinary !== false) {
    if (Date.now() > deadline) break;
    await delay(10);
  }
  assert.equal(lastServerBinary, false, 'text frames must arrive with the binary flag clear');
});

test('masking: the server rejects an unmasked client frame', async (t) => {
  let failed = false;
  const { port } = await startWsServer(t, (connection) => {
    connection.on('error', (error) => {
      failed = error instanceof WsProtocolError && error.code === 'mask-required';
    });
  });
  const socket = await rawHandshake(port);
  socket.write(encodeFrame(OPCODE.TEXT, Buffer.from('unmasked'), { mask: false }));
  await delay(150);
  assert.equal(failed, true, 'an unmasked client frame must be a protocol error');
  socket.destroy();
});

test('masking: server ->client frames are unmasked on the wire', async (t) => {
  const { port } = await startWsServer(t, (connection) => {
    connection.send(Buffer.from([0xaa, 0xbb, 0xcc]));
  });
  const socket = await rawHandshake(port);
  await delay(200);
  const raw = socket.captured;
  const frameStart = raw.indexOf('\r\n\r\n') + 4;
  assert.ok(frameStart > 3, 'expected a 101 response');
  assert.equal(raw[frameStart + 1] & 0x80, 0, 'server ->client frames must not set the mask bit');
  assert.equal(raw[frameStart] & 0x0f, OPCODE.BINARY);
  assert.deepEqual(raw.subarray(frameStart + 2, frameStart + 5), Buffer.from([0xaa, 0xbb, 0xcc]));
  socket.destroy();
});

test('masking: client ->server frames from connect() are masked on the wire', async () => {
  /** @type {Buffer[]} */
  const frames = [];
  const server = net.createServer((socket) => {
    socket.once('data', (request) => {
      const key = /sec-websocket-key:\s*(\S+)/i.exec(request.toString('latin1'));
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Accept: ${acceptKey(key[1])}\r\n\r\n`,
      );
      socket.once('data', (frame) => {
        frames.push(Buffer.from(frame));
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const connection = await connect(new URL(`ws://127.0.0.1:${server.address().port}/x`));
    await delay(30); // let the raw server attach its second data listener
    connection.send('mask-me');
    await delay(150);
    assert.equal(frames.length, 1, 'expected one frame on the wire');
    assert.equal(frames[0][1] & 0x80, 0x80, 'client ->server frames must be masked');
    connection.destroy();
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

test('fragmentation: a fragmented message reassembles and interleaved control frames are allowed', async (t) => {
  /** @type {{message: Buffer|null, ping: string|null}} */
  const observed = { message: null, ping: null };
  const { port } = await startWsServer(t, (connection) => {
    connection.on('message', (payload) => {
      observed.message = payload;
    });
    connection.on('ping', (payload) => {
      observed.ping = payload.toString('utf8');
    });
  });
  const socket = await rawHandshake(port);
  const parts = ['frag-', 'men', '-ted'];
  socket.write(encodeFrame(OPCODE.TEXT, Buffer.from(parts[0]), { fin: false, mask: true }));
  socket.write(encodeFrame(OPCODE.PING, Buffer.from('mid'), { mask: true }));
  socket.write(encodeFrame(OPCODE.CONT, Buffer.from(parts[1]), { fin: false, mask: true }));
  socket.write(encodeFrame(OPCODE.CONT, Buffer.from(parts[2]), { fin: true, mask: true }));
  const deadline = Date.now() + 3000;
  while (observed.message === null && Date.now() < deadline) await delay(10);
  assert.equal(observed.message?.toString('utf8'), parts.join(''));
  assert.equal(observed.ping, 'mid', 'control frames are delivered out of band, between fragments');
  socket.destroy();
});

test('fragmentation: a fragmented control frame is a protocol error', async (t) => {
  let failed = false;
  const { port } = await startWsServer(t, (connection) => {
    connection.on('error', (error) => {
      failed = error instanceof WsProtocolError && error.code === 'fragmented-control';
    });
  });
  const socket = await rawHandshake(port);
  socket.write(encodeFrame(OPCODE.PING, Buffer.from('x'), { fin: false, mask: true }));
  await delay(150);
  assert.equal(failed, true);
  socket.destroy();
});

test('control: ping is answered with pong carrying the same payload', async (t) => {
  const { port } = await startWsServer(t, () => {});
  const client = await connect(new URL(`ws://127.0.0.1:${port}/ping`));
  t.after(() => client.destroy());
  await delay(30); // let the server attach its frame handlers before we speak

  const first = waitForEvent(client, 'pong');
  client.ping(Buffer.from('probe'));
  const [payload] = await first;
  assert.equal(payload.toString('utf8'), 'probe');

  const closed = waitForEvent(client, 'close');
  client.close(CLOSE.NORMAL, 'bye');
  const [info] = await closed;
  assert.equal(info.clean, true);
});

test('close handshake: the peer echoes the local close code', async (t) => {
  const { port } = await startWsServer(t, () => {});
  const client = await connect(new URL(`ws://127.0.0.1:${port}/close`));
  t.after(() => client.destroy());
  await delay(30);
  const closed = waitForEvent(client, 'close');
  client.close(CLOSE.POLICY_VIOLATION, 'revoked');
  const [info] = await closed;
  assert.equal(info.clean, true);
  assert.equal(info.code, CLOSE.POLICY_VIOLATION);
  assert.equal(info.reason, 'revoked');
});

test('handshake: isUpgrade accepts only version 13 upgrades', async (t) => {
  const server = http.createServer((request, response) => {
    response.writeHead(200);
    response.end('plain');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(() => resolve())));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(response.status, 200);
  assert.equal(isUpgrade({ headers: {} }), false);
  assert.equal(
    isUpgrade({ headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'x', 'sec-websocket-version': '13' } }),
    true,
  );
  assert.equal(
    isUpgrade({ headers: { upgrade: 'websocket', connection: 'keep-alive, Upgrade', 'sec-websocket-key': 'x', 'sec-websocket-version': '13' } }),
    true,
  );
  assert.equal(
    isUpgrade({ headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'x', 'sec-websocket-version': '8' } }),
    false,
  );
});

test('connect(): a refused upgrade rejects with a clear protocol error', async (t) => {
  const server = http.createServer((request, response) => {
    response.writeHead(404);
    response.end('no upgrade here');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  await assert.rejects(
    connect(new URL(`ws://127.0.0.1:${server.address().port}/nope`)),
    (error) => error instanceof WsProtocolError && error.code === 'upgrade-refused',
  );
});
