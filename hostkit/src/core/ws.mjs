/**
 * A dependency-free RFC 6455 WebSocket implementation (server *and* client side).
 *
 * Why hand-rolled: hostkit promises zero runtime dependencies (`ws` is the obvious one to reach for),
 * and the tunnel needs a client-mode implementation anyway to dial the dsh Host's
 * `/api/remote.mux` mux from inside the PC process. Writing one framing layer that both directions
 * share is less code than adapting a library twice.
 *
 * What is implemented: RFC 6455 §4 handshake (SHA-1 `Sec-WebSocket-Accept`), §5 framing with
 * 7/16/64-bit lengths, masking (client→server frames are *always* masked, server→client frames are
 * *always* unmasked, both enforced), fragmentation with continuation frames, and the control opcodes
 * ping/pong/close including the close handshake.
 *
 * What is deliberately not implemented (see hostkit/README.md §Limitations): `permessage-deflate`
 * (the dsh mux does not negotiate it), HTTP/2 `CONNECT`-style bootstrapping, `Sec-WebSocket-Protocol`
 * negotiation beyond echoing nothing, and proxy tunnelling.
 */

import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { Buffer } from 'node:buffer';

/** RFC 6455 §1.3 magic GUID. */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = Object.freeze({
  CONT: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});

/** Default cap on a single message (fragments included) before the connection is failed. */
export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** Close codes we originate. */
export const CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  POLICY_VIOLATION: 1008,
  TOO_LARGE: 1009,
  INTERNAL_ERROR: 1011,
});

/**
 * @param {string} key client `Sec-WebSocket-Key`
 * @returns {string} the `Sec-WebSocket-Accept` value
 */
export function acceptKey(key) {
  return createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

/**
 * @returns {string} a fresh base64 16-byte `Sec-WebSocket-Key`
 */
export function generateKey() {
  return randomBytes(16).toString('base64');
}

/** Frame-layer failure. */
export class WsProtocolError extends Error {
  /** @param {string} code @param {string} [detail] */
  constructor(code, detail) {
    super(`ws protocol error: ${code}${detail === undefined ? '' : ` (${detail})`}`);
    this.name = 'WsProtocolError';
    this.code = code;
    this.closeCode = CLOSE.PROTOCOL_ERROR;
  }
}

/**
 * XOR-mask a payload in place-equivalent fashion. `maskOffset` lets a caller continue a mask across
 * fragments, which RFC 6455 requires the client to do.
 * @param {Buffer} payload @param {Buffer} mask 4 bytes @param {number} [maskOffset]
 * @returns {Buffer} a new masked buffer
 */
export function applyMask(payload, mask, maskOffset = 0) {
  const out = Buffer.allocUnsafe(payload.length);
  let i = 0;
  const limit = payload.length - 7;
  const m0 = mask[(0 + maskOffset) & 3];
  const m1 = mask[(1 + maskOffset) & 3];
  const m2 = mask[(2 + maskOffset) & 3];
  const m3 = mask[(3 + maskOffset) & 3];
  for (; i < limit; i += 4) {
    out[i] = payload[i] ^ m0;
    out[i + 1] = payload[i + 1] ^ m1;
    out[i + 2] = payload[i + 2] ^ m2;
    out[i + 3] = payload[i + 3] ^ m3;
  }
  for (; i < payload.length; i += 1) out[i] = payload[i] ^ mask[(i + maskOffset) & 3];
  return out;
}

/**
 * Build one frame.
 * @param {number} opcode @param {Buffer} payload
 * @param {{mask?: boolean, fin?: boolean}} [options]
 * @returns {Buffer}
 */
export function encodeFrame(opcode, payload, options = {}) {
  const fin = options.fin !== false;
  const masked = options.mask === true;
  const body = payload.length === 0 ? Buffer.alloc(0) : Buffer.from(payload);
  const length = body.length;

  let headerLength = 2;
  if (length >= 65536) headerLength += 8;
  else if (length >= 126) headerLength += 2;
  if (masked) headerLength += 4;

  const header = Buffer.alloc(headerLength);
  header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  let offset = 2;
  if (length >= 65536) {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
    offset = 10;
  } else if (length >= 126) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    offset = 4;
  } else {
    header[1] = length;
  }

  let out;
  if (masked) {
    header[1] |= 0x80;
    const mask = randomBytes(4);
    mask.copy(header, offset);
    out = Buffer.concat([header, applyMask(body, mask)]);
  } else {
    out = Buffer.concat([header, body]);
  }
  return out;
}

/**
 * Incremental frame parser. Emits `frame` objects `{fin, opcode, payload, masked}` and enforces the
 * directional masking rule via {@link WsProtocolError}.
 */
export class FrameParser extends EventEmitter {
  /** @param {{expectMasked: boolean, maxMessageBytes?: number}} options */
  constructor(options) {
    super();
    this.expectMasked = options.expectMasked;
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    /** @type {Buffer} */
    this.buffer = Buffer.alloc(0);
    this.fragmentOpcode = 0;
    /** @type {Buffer[]} */
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentMaskOffset = 0;
  }

  /** @param {Buffer|Uint8Array} chunk @returns {void} */
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (this.parseOne()) {
      /* keep draining */
    }
  }

  /** @returns {boolean} whether a frame was consumed */
  parseOne() {
    const buf = this.buffer;
    if (buf.length < 2) return false;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let offset = 2;

    if (rsv !== 0) throw new WsProtocolError('rsv-set');
    if (masked !== this.expectMasked) {
      throw new WsProtocolError(masked ? 'unexpected-mask' : 'mask-required');
    }

    if (length === 126) {
      if (buf.length < offset + 2) return false;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return false;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(this.maxMessageBytes)) throw new WsProtocolError('too-large', `${big} bytes`);
      length = Number(big);
      offset += 8;
    }

    const isControl = (opcode & 0x08) !== 0;
    if (isControl) {
      if (!fin) throw new WsProtocolError('fragmented-control');
      if (length > 125) throw new WsProtocolError('control-too-large');
    }
    if (length > this.maxMessageBytes) throw new WsProtocolError('too-large', `${length} bytes`);

    const maskOffsetStart = offset;
    if (masked) offset += 4;
    if (buf.length < offset + length) return false;

    /** @type {Buffer} */
    let payload = buf.subarray(offset, offset + length);
    if (masked) {
      const mask = buf.subarray(maskOffsetStart, maskOffsetStart + 4);
      payload = applyMask(payload, mask, 0);
    }

    this.buffer = buf.subarray(offset + length);
    this.emit('frame', { fin, opcode, payload: Buffer.from(payload), masked });
    // We just consumed a frame, so another one may be waiting even if fewer than 2 bytes remain.
    return true;
  }

  /**
   * Reassemble a (possibly fragmented) data message and return it, or `undefined` if more fragments
   * are needed. Control frames are returned immediately, out of band.
   * @param {{fin: boolean, opcode: number, payload: Buffer}} frame
   * @returns {{opcode: number, payload: Buffer} | undefined}
   */
  assemble(frame) {
    const { fin, opcode, payload } = frame;
    if (opcode === OPCODE.CONT) {
      if (this.fragmentOpcode === 0) throw new WsProtocolError('unexpected-continuation');
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
    } else {
      if (this.fragmentOpcode !== 0) throw new WsProtocolError('interleaved-data-frame');
      if (fin) return { opcode, payload };
      this.fragments = [payload];
      this.fragmentBytes = payload.length;
    }
    if (this.fragmentBytes > this.maxMessageBytes) throw new WsProtocolError('too-large', 'fragments');
    if (!fin) {
      if (opcode !== OPCODE.CONT) this.fragmentOpcode = opcode;
      return undefined;
    }
    const message = Buffer.concat(this.fragments, this.fragmentBytes);
    const messageOpcode = this.fragmentOpcode === 0 ? opcode : this.fragmentOpcode;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = 0;
    return { opcode: messageOpcode, payload: message };
  }
}

/* ------------------------------------------------------------------ *
 * Connection
 * ------------------------------------------------------------------ */

/**
 * A live WebSocket connection. Symmetric: the same class wraps an accepted server-side socket and an
 * established client-side socket. Events:
 *   `message` (Buffer, boolean isBinary), `ping` (Buffer), `pong` (Buffer),
 *   `close` ({code, reason, clean}), `error` (Error)
 */
export class WsConnection extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket
   * @param {{isServer: boolean, maxMessageBytes?: number}} options
   */
  constructor(socket, options) {
    super();
    this.socket = socket;
    this.isServer = options.isServer;
    this.closed = false;
    this.closeSent = false;
    this.closeReceived = false;
    this.closeCode = 1006;
    this.closeReason = '';
    this.parser = new FrameParser({
      expectMasked: options.isServer,
      maxMessageBytes: options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
    });
    this.parser.on('frame', (frame) => this.onFrame(frame));
    socket.on('data', (chunk) => this.onData(chunk));
    // `destroy()` does not always emit 'close' synchronously for an upgraded socket, so the teardown
    // path also resolves through 'close' explicitly; `finish` is idempotent.
    socket.on('close', () => this.finish(false));
    socket.on('error', (error) => {
      if (this.closed) return;
      this.closed = true;
      this.emit('error', error);
      this.emit('close', { code: 1006, reason: 'socket-error', clean: false });
    });
    socket.on('close', () => {
      if (this.closed) return;
      this.closed = true;
      this.emit('close', { code: 1006, reason: 'socket-closed', clean: false });
    });
  }

  /** @param {Buffer} chunk @returns {void} */
  onData(chunk) {
    if (this.closed) return;
    try {
      this.parser.push(chunk);
    } catch (error) {
      this.fail(error);
    }
  }

  /** @param {{fin: boolean, opcode: number, payload: Buffer}} frame @returns {void} */
  onFrame(frame) {
    if (this.closed) return;
    try {
      if (frame.opcode === OPCODE.PING) {
        this.emit('ping', frame.payload);
        this.write(encodeFrame(OPCODE.PONG, frame.payload));
        return;
      }
      if (frame.opcode === OPCODE.PONG) {
        this.emit('pong', frame.payload);
        return;
      }
      if (frame.opcode === OPCODE.CLOSE) {
        this.closeReceived = true;
        this.closeCode = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
        this.closeReason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : '';
        if (!this.closeSent) {
          this.closeSent = true;
          this.write(encodeFrame(OPCODE.CLOSE, frame.payload.subarray(0, 125)));
        }
        this.finish(true);
        return;
      }
      const message = this.parser.assemble(frame);
      if (message !== undefined) this.emit('message', message.payload, message.opcode === OPCODE.BINARY);
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * @param {Buffer} data @returns {void}
   */
  write(data) {
    if (this.socket.destroyed) return;
    this.socket.write(data);
  }

  /**
   * Send one message. An explicit `binary` option always wins, so a caller holding a `Buffer` can
   * still send a *text* frame — which the dsh mux needs, because its frames are JSON text even though
   * the transport hands them around as bytes.
   * @param {Buffer|string} data @param {{binary?: boolean}} [options] @returns {boolean}
   */
  send(data, options = {}) {
    if (this.closed) return false;
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const binary = options.binary ?? typeof data !== 'string';
    this.write(encodeFrame(binary ? OPCODE.BINARY : OPCODE.TEXT, payload, { mask: !this.isServer }));
    return true;
  }

  /** @param {Buffer} data @returns {void} */
  ping(data = Buffer.alloc(0)) {
    if (this.closed) return;
    this.write(encodeFrame(OPCODE.PING, data, { mask: !this.isServer }));
  }

  /** @param {Buffer} data @returns {void} */
  pong(data = Buffer.alloc(0)) {
    if (this.closed) return;
    this.write(encodeFrame(OPCODE.PONG, data, { mask: !this.isServer }));
  }

  /**
   * Start (or complete) the close handshake. A peer that does not answer within `timeoutMs` gets its
   * socket destroyed; that is the only way to bound a half-open TCP connection.
   * @param {number} [code] @param {string} [reason] @param {number} [timeoutMs]
   * @returns {void}
   */
  close(code = CLOSE.NORMAL, reason = '', timeoutMs = 3000) {
    if (this.closed) return;
    if (!this.closeSent) {
      this.closeSent = true;
      const reasonBytes = Buffer.from(String(reason), 'utf8').subarray(0, 123);
      const payload = Buffer.alloc(2 + reasonBytes.length);
      payload.writeUInt16BE(code, 0);
      reasonBytes.copy(payload, 2);
      this.write(encodeFrame(OPCODE.CLOSE, payload, { mask: !this.isServer }));
    }
    if (this.closed) return;
    this.closeTimer = setTimeout(() => this.finish(false), timeoutMs);
    if (typeof this.closeTimer.unref === 'function') this.closeTimer.unref();
  }

  /** @param {Error} error @returns {void} */
  fail(error) {
    this.emit('error', error);
    const code = typeof error?.closeCode === 'number' ? error.closeCode : CLOSE.INTERNAL_ERROR;
    if (!this.closed) {
      this.closeSent = true;
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      this.write(encodeFrame(OPCODE.CLOSE, payload, { mask: !this.isServer }));
    }
    this.finish(false);
  }

  /** @param {boolean} clean @returns {void} */
  finish(clean) {
    if (this.closed) return;
    this.closed = true;
    if (this.closeTimer !== undefined) clearTimeout(this.closeTimer);
    // `socket.destroy()` — deliberately no argument. `destroy(error)` only *records* the error object
    // and does not tear the socket down, which would leave the descriptor open forever.
    if (!this.socket.destroyed) this.socket.destroy();
    this.emit('close', {
      code: this.closeReceived ? this.closeCode : clean ? CLOSE.NORMAL : this.closeCode,
      reason: this.closeReason,
      clean,
    });
  }

  /** Force-destroy without a close handshake (used when the tunnel session is revoked). */
  destroy() {
    this.finish(false);
  }
}

/* ------------------------------------------------------------------ *
 * Server side handshake
 * ------------------------------------------------------------------ */

/**
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean} whether the request is a usable WebSocket upgrade
 */
export function isUpgrade(request) {
  const upgrade = String(request.headers.upgrade ?? '').toLowerCase();
  const connection = String(request.headers.connection ?? '').toLowerCase();
  return (
    upgrade === 'websocket' &&
    connection.split(',').some((token) => token.trim() === 'upgrade') &&
    typeof request.headers['sec-websocket-key'] === 'string' &&
    request.headers['sec-websocket-version'] === '13'
  );
}

/**
 * Complete the server side of the handshake and return a {@link WsConnection}.
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:net').Socket} socket
 * @param {Buffer} [head] bytes already consumed by the HTTP parser
 * @param {{maxMessageBytes?: number}} [options]
 * @returns {WsConnection}
 */
export function acceptUpgrade(request, socket, head, options = {}) {
  if (!isUpgrade(request)) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    throw new WsProtocolError('bad-upgrade');
  }
  const key = request.headers['sec-websocket-key'];
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '',
    '',
  ];
  socket.write(headers.join('\r\n'));
  socket.setNoDelay(true);
  const connection = new WsConnection(socket, { isServer: true, ...options });
  if (head !== undefined && head.length > 0) connection.onData(head);
  return connection;
}

/* ------------------------------------------------------------------ *
 * Client side handshake
 * ------------------------------------------------------------------ */

/**
 * Dial a WebSocket endpoint. Used to reach the dsh Host's `/api/remote.mux` from loopback: the
 * request carries the *client's* cookie and a loopback `Host`, which is exactly what the dsh trust
 * fence expects, so no header is ever forged.
 *
 * @param {URL} url `ws:` or `wss:` URL, or an `http:`/`https:` URL with the path included
 * @param {{headers?: Record<string,string>, timeoutMs?: number, maxMessageBytes?: number, socket?: import('node:net').Socket}} [options]
 * @returns {Promise<WsConnection>}
 */
export function connect(url, options = {}) {
  const target = url instanceof URL ? url : new URL(String(url));
  const secure = target.protocol === 'wss:' || target.protocol === 'https:';
  const key = generateKey();
  const port = target.port === '' ? (secure ? 443 : 80) : Number(target.port);
  const path = `${target.pathname}${target.search}`;
  const headers = {
    Host: target.host,
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    'Sec-WebSocket-Key': key,
    'Sec-WebSocket-Version': '13',
    ...(options.headers ?? {}),
  };

  return new Promise((resolve, reject) => {
    // Resolve exactly once; later events (an `error` after the upgrade detached the HTTP layer) are
    // ignored by the already-settled promise.
    const succeed = (connection) => resolve(connection);
    const request = http.request({
      host: target.hostname,
      port,
      path,
      method: 'GET',
      headers,
      protocol: secure ? 'https:' : 'http:',
      agent: false,
    });
    const timer = setTimeout(() => {
      request.destroy(new WsProtocolError('connect-timeout'));
    }, options.timeoutMs ?? 15000);
    if (typeof timer.unref === 'function') timer.unref();
    request.on('upgrade', (response, socket, head) => {
      clearTimeout(timer);
      const accept = String(response.headers['sec-websocket-accept'] ?? '');
      if (accept !== acceptKey(key)) {
        socket.destroy();
        reject(new WsProtocolError('bad-accept'));
        return;
      }
      socket.setNoDelay(true);
      succeed(new WsConnection(socket, { isServer: false, ...options }));
    });
    request.on('response', (response) => {
      clearTimeout(timer);
      response.resume();
      reject(new WsProtocolError('upgrade-refused', `HTTP ${response.statusCode}`));
    });
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}
