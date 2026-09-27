/**
 * The tunnel session state machine.
 *
 * Why this module exists: this is where the task book's wire protocol lives, and it is the piece the
 * L1/L2 security claim rests on. One session = one WebSocket from a paired device, authenticated by a
 * one-frame plaintext hello carrying the device's X25519 public key, then sealed by AES-256-GCM frames
 * for the rest of its life. Everything that crosses the LAN *after* the hello is ciphertext.
 *
 * States: `hello` (plaintext handshake) → `open` (sealed envelopes) → `closed`.
 * Kinds carried in `open`: `http`/`http-res`, `ws-open`/`ws-open-res`, `ws-data`, `ws-close`,
 * `ping`/`pong`, `error` (see hostkit/README.md for the tables).
 *
 * Heartbeat mirrors the dsh mux: we send `{kind:'ping'}` every `pingIntervalMs` (default 2000 ms) and
 * tear the session down after `3 × pingIntervalMs` with no inbound frame of any kind. The teardown
 * threshold is deliberately *traffic*-based rather than pong-based: a device that is busy streaming a
 * large response is clearly alive.
 */

import { EventEmitter } from 'node:events';
import {
  agree,
  deriveSessionKeys,
  randomToken,
  unb64u,
  SealedChannel,
  SealedError,
  sessionIdFrom,
} from './crypto.mjs';
import {
  decodeBodyField,
  decodeEnvelope,
  encodeEnvelope,
  encodeFrame,
  errorResponse,
  FrameError,
  FrameSplitter,
  httpResponse,
  isBinaryData,
  KIND,
  normalizeHeaders,
} from './frames.mjs';

/** Hello/first-frame protocol version. */
export const TUNNEL_V1 = 1;

/** Session states. */
export const STATE = Object.freeze({ HELLO: 'hello', OPEN: 'open', CLOSED: 'closed' });

/** Default grace period for the plaintext hello. */
export const DEFAULT_HELLO_TIMEOUT_MS = 10_000;

/**
 * Build the plaintext hello frame (client → server).
 * @param {string} deviceId @param {Buffer} nonce @returns {string}
 */
export function buildHello(deviceId, nonce) {
  return JSON.stringify({ v: TUNNEL_V1, deviceId, nonce: nonce.toString('base64') });
}

/**
 * Server side of one tunnel connection.
 *
 * Events: `open` ({deviceId, sessionId}), `call` ({id, ...}) — unused, `close` ({reason}),
 * `error` (Error). Envelope handling is done by the owner (server.mjs) through {@link onEnvelope}.
 */
export class TunnelSession extends EventEmitter {
  /**
   * @param {{
   *   ws: import('./ws.mjs').WsConnection,
   *   hostkitPrivate: string,
   *   hostkitPublic: string,
   *   whitelist: import('./whitelist.mjs').WhitelistStore,
   *   proxy: import('./proxy.mjs').HostProxy,
   *   audit?: import('./audit.mjs').AuditLog,
   *   remoteAddress?: string,
   *   pingIntervalMs?: number,
   *   maxBodyBytes?: number,
   *   helloTimeoutMs?: number,
   *   logger?: object,
   * }} options
   */
  constructor(options) {
    super();
    this.ws = options.ws;
    this.hostkitPrivate = options.hostkitPrivate;
    this.hostkitPublic = options.hostkitPublic;
    this.whitelist = options.whitelist;
    this.proxy = options.proxy;
    this.audit = options.audit;
    this.remoteAddress = options.remoteAddress ?? 'unknown';
    this.pingIntervalMs = options.pingIntervalMs ?? 2000;
    this.maxBodyBytes = options.maxBodyBytes ?? 8 * 1024 * 1024;
    this.helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    this.logger = options.logger;

    this.state = STATE.HELLO;
    /** @type {string|null} */
    this.deviceId = null;
    /** @type {string|null} */
    this.sessionId = null;
    /** @type {SealedChannel|null} */
    this.channel = null;
    this.splitter = new FrameSplitter();
    this.lastActivity = Date.now();
    this.helloNonce = randomToken(16);
    this.closed = false;

    this.ws.on('message', (payload) => this.onMessage(payload));
    this.ws.on('close', (info) => this.finish(`ws-close:${info.code}`));
    this.ws.on('error', (error) => {
      this.emit('error', error);
    });

    this.helloTimer = setTimeout(() => {
      if (this.state === STATE.HELLO) {
        this.reject('hello-timeout');
      }
    }, this.helloTimeoutMs);
    if (typeof this.helloTimer.unref === 'function') this.helloTimer.unref();
  }

  /** @param {Buffer} payload @returns {void} */
  onMessage(payload) {
    if (this.closed) return;
    this.lastActivity = Date.now();
    if (this.state === STATE.HELLO) {
      this.onHello(payload);
      return;
    }
    let frames;
    try {
      frames = this.splitter.push(payload);
    } catch (error) {
      this.onProtocolError(error);
      return;
    }
    for (const frame of frames) {
      let plaintext;
      try {
        plaintext = this.channel.open(frame);
      } catch (error) {
        // A replay, a tamper, or a frame from a different session: all fatal for this session.
        this.audit?.append('tunnel.reject', {
          deviceId: this.deviceId,
          remote: this.remoteAddress,
          reason: error instanceof SealedError ? `sealed-${error.code}` : 'sealed-unknown',
        });
        this.finish(`sealed:${error.code ?? 'unknown'}`);
        return;
      }
      let envelope;
      try {
        envelope = decodeEnvelope(plaintext);
      } catch (error) {
        this.onProtocolError(error);
        return;
      }
      this.onEnvelope(envelope);
      if (this.closed) return;
    }
  }

  /** @param {Buffer} payload @returns {void} */
  onHello(payload) {
    let hello;
    try {
      hello = JSON.parse(payload.toString('utf8'));
    } catch {
      this.reject('bad-hello');
      return;
    }
    const deviceId = hello?.deviceId;
    const nonceText = hello?.nonce;
    if (hello?.v !== TUNNEL_V1 || typeof deviceId !== 'string' || typeof nonceText !== 'string') {
      this.reject('bad-hello');
      return;
    }
    const record = this.whitelist.get(deviceId);
    if (record === undefined || record.revokedAt !== undefined) {
      this.audit?.append('tunnel.reject', {
        deviceId,
        remote: this.remoteAddress,
        reason: record === undefined ? 'unknown-device' : 'revoked-device',
      });
      this.reject('unauthorized');
      return;
    }

    let deviceNonce;
    try {
      deviceNonce = unb64u(nonceText);
    } catch {
      this.reject('bad-hello');
      return;
    }
    if (deviceNonce.length !== 16) {
      this.reject('bad-hello');
      return;
    }

    let shared;
    try {
      shared = agree(this.hostkitPrivate, record.devicePub);
    } catch {
      this.audit?.append('tunnel.reject', { deviceId, remote: this.remoteAddress, reason: 'bad-device-key' });
      this.reject('unauthorized');
      return;
    }

    const serverNonce = randomToken(16);
    const { kEnc, kMac, saltHash } = deriveSessionKeys(shared, this.hostkitPublic, record.devicePub);
    const channel = new SealedChannel(kEnc, kMac, saltHash, 's2c');
    // Server's own nonce prefix is the first 3 bytes of its nonce; so is the peer's. The nonces are
    // exchanged in the clear, but they are inputs to the AAD and to the session id, so both ends
    // commit to the same transcript before any ciphertext exists.
    const serverPrefix = Buffer.from(serverNonce, 'base64').subarray(0, 3);
    const devicePrefix = deviceNonce.subarray(0, 3);
    channel.setOwnNoncePrefix(serverPrefix);
    channel.setPeerNoncePrefix(devicePrefix);
    this.channel = channel;
    this.deviceId = deviceId;
    this.sessionId = sessionIdFrom(saltHash, deviceNonce, Buffer.from(serverNonce, 'base64'));
    this.state = STATE.OPEN;
    if (this.helloTimer !== undefined) clearTimeout(this.helloTimer);
    /** Reset liveness so the handshake itself cannot trip the heartbeat watchdog. */
    this.lastActivity = Date.now();

    this.ws.send(
      JSON.stringify({ v: TUNNEL_V1, ok: true, hostkitPub: this.hostkitPublic, serverNonce }),
      { binary: false },
    );
    this.whitelist.touch(deviceId);
    this.audit?.append('tunnel.open', {
      deviceId,
      sessionId: this.sessionId,
      remote: this.remoteAddress,
      deviceName: record.deviceName,
    });
    this.emit('open', { deviceId, sessionId: this.sessionId });
    this.startHeartbeat();
  }

  /** Start the heartbeat/keepalive timers. */
  startHeartbeat() {
    this.pingTimer = setInterval(() => {
      if (this.closed) return;
      if (Date.now() - this.lastActivity > 3 * this.pingIntervalMs) {
        this.audit?.append('tunnel.close', {
          deviceId: this.deviceId,
          sessionId: this.sessionId,
          reason: 'heartbeat-timeout',
        });
        this.finish('heartbeat-timeout');
        return;
      }
      this.send({ kind: KIND.PING, t: Date.now() });
    }, this.pingIntervalMs);
    if (typeof this.pingTimer.unref === 'function') this.pingTimer.unref();
  }

  /**
   * Handle one decoded envelope. Subclasses/owners may override {@link onUnhandled}.
   * @param {object} envelope
   * @returns {void}
   */
  onEnvelope(envelope) {
    switch (envelope.kind) {
      case KIND.PING:
        this.send({ kind: KIND.PONG, t: envelope.t });
        return;
      case KIND.PONG:
        this.emit('pong', envelope);
        return;
      case KIND.HTTP:
        void this.onHttp(envelope);
        return;
      case KIND.HTTP_RES:
        this.emit('http-res', envelope);
        return;
      case KIND.WS_OPEN:
        void this.onWsOpen(envelope);
        return;
      case KIND.WS_OPEN_RES:
        this.emit('ws-open-res', envelope);
        return;
      case KIND.WS_DATA:
        this.onWsData(envelope);
        return;
      case KIND.WS_CLOSE:
        this.proxy.closeStream(String(envelope.id), Number(envelope.code ?? 1000), String(envelope.reason ?? ''));
        this.emit('ws-close', envelope);
        return;
      case KIND.ERROR:
        this.emit('peer-error', envelope);
        return;
      default:
        this.onUnhandled(envelope);
    }
  }

  /**
   * @param {object} envelope
   * @returns {void}
   */
  onUnhandled(envelope) {
    this.send({ kind: KIND.ERROR, code: 'unsupported-kind', message: `unsupported kind ${String(envelope.kind)}` });
  }

  /** @param {object} envelope @returns {void} */
  async onHttp(envelope) {
    const id = String(envelope.id ?? '');
    let body;
    try {
      body = decodeBodyField(envelope.bodyB64);
    } catch (error) {
      this.send(errorResponse(id, 'bad-body', error.message));
      return;
    }
    if (body.length > this.maxBodyBytes) {
      this.send(errorResponse(id, 'too-large', `request body ${body.length} > ${this.maxBodyBytes}`));
      return;
    }
    try {
      const result = await this.proxy.forwardUnary({
        id,
        method: String(envelope.method ?? 'POST'),
        path: String(envelope.path ?? ''),
        headers: normalizeHeaders(envelope.headers),
        body,
      });
      if (result.body.length > this.maxBodyBytes) {
        this.send(errorResponse(id, 'too-large', `response body ${result.body.length} > ${this.maxBodyBytes}`));
        return;
      }
      this.send(httpResponse(id, result.status, result.headers, result.body));
    } catch (error) {
      const code = error?.code ?? error?.name ?? 'proxy-error';
      this.send(errorResponse(id, String(code), String(error?.message ?? error)));
    }
  }

  /** @param {object} envelope @returns {void} */
  async onWsOpen(envelope) {
    const id = String(envelope.id ?? '');
    try {
      await this.proxy.openStream(id, String(envelope.path ?? ''), {
        headers: normalizeHeaders(envelope.headers),
        onData: (streamId, dataB64, binary) => {
          this.send({ kind: KIND.WS_DATA, id: streamId, dataB64, t: binary ? 'b' : 't' });
        },
        onClose: (frame) => this.send(frame),
      });
      this.send({ kind: KIND.WS_OPEN_RES, id, ok: true });
    } catch (error) {
      this.send({ kind: KIND.WS_OPEN_RES, id, ok: false, code: String(error?.code ?? 'ws-open-failed'), message: String(error?.message ?? error) });
    }
  }

  /** @param {object} envelope @returns {void} */
  onWsData(envelope) {
    const id = String(envelope.id ?? '');
    let data;
    try {
      data = decodeBodyField(envelope.dataB64);
    } catch (error) {
      this.send({ kind: KIND.ERROR, id, code: 'bad-data', message: error.message });
      return;
    }
    if (!this.proxy.sendStreamData(id, data, isBinaryData(envelope))) {
      this.send({ kind: KIND.ERROR, id, code: 'no-such-stream', message: `stream ${id} is not open` });
    }
  }

  /** @param {object} envelope @returns {void} */
  send(envelope) {
    if (this.closed) return;
    if (this.state !== STATE.OPEN || this.channel === null) {
      // Heartbeat/pong may race the handshake; drop rather than encrypt with an unset prefix.
      return;
    }
    let sealed;
    let framed;
    try {
      sealed = this.channel.seal(encodeEnvelope(envelope));
      framed = encodeFrame(sealed);
    } catch (error) {
      this.emit('error', error);
      this.finish('send-failed');
      return;
    }
    this.ws.send(framed, { binary: true });
  }

  /** @param {Error} error @returns {void} */
  onProtocolError(error) {
    const code = error instanceof FrameError ? error.code : 'protocol';
    this.send({ kind: KIND.ERROR, code, message: error.message });
    this.finish(`protocol:${code}`);
  }

  /** @param {string} code @returns {void} */
  reject(code) {
    if (this.closed) return;
    try {
      this.ws.send(JSON.stringify({ v: TUNNEL_V1, ok: false, code }), { binary: false });
    } catch {
      /* the socket may already be gone; closing is what matters */
    }
    this.finish(`rejected:${code}`);
  }

  /**
   * Tear the session down. Idempotent; `reason` is audited exactly once.
   * @param {string} reason @returns {void}
   */
  finish(reason) {
    if (this.closed) return;
    this.closed = true;
    this.state = STATE.CLOSED;
    if (this.helloTimer !== undefined) clearTimeout(this.helloTimer);
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    // Upstream resources belong to the proxy's owner (server.mjs); it is shared across sessions and
    // must outlive any single one of them.
    if (this.deviceId !== null) {
      this.audit?.append('tunnel.close', {
        deviceId: this.deviceId,
        sessionId: this.sessionId,
        remote: this.remoteAddress,
        reason,
      });
    }
    // Give a queued close frame a chance to flush before the socket dies.
    try {
      this.ws.close(1000, reason.slice(0, 100));
    } catch {
      this.ws.destroy();
    }
    this.emit('close', { reason, deviceId: this.deviceId, sessionId: this.sessionId });
  }

  /** Immediately destroy the transport (used by `hostkit revoke`). */
  kick(reason = 'revoked') {
    this.audit?.append('tunnel.close', {
      deviceId: this.deviceId,
      sessionId: this.sessionId,
      remote: this.remoteAddress,
      reason,
    });
    this.finish(reason);
    this.ws.destroy();
  }
}

/**
 * Client side of the handshake, used by tests and by the `hostkit probe` diagnostic.
 *
 * @param {import('./ws.mjs').WsConnection} ws
 * @param {{deviceId: string, devicePrivate: string, devicePublic: string, hostkitPublic: string, onEnvelope: (envelope: object) => void, pingIntervalMs?: number}} options
 * @returns {Promise<TunnelClient>}
 */
export async function clientHandshake(ws, options) {
  const deviceNonce = Buffer.from(randomToken(16), 'base64');
  ws.send(buildHello(options.deviceId, deviceNonce), { binary: false });
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('handshake timeout')), 10_000);
    ws.once('message', (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const parsed = JSON.parse(reply.toString('utf8'));
  if (parsed?.ok !== true) throw new Error(`handshake rejected: ${parsed?.code ?? 'unknown'}`);
  if (typeof parsed.hostkitPub !== 'string' || typeof parsed.serverNonce !== 'string') {
    throw new Error('handshake reply is malformed');
  }
  const shared = agree(options.devicePrivate, parsed.hostkitPub);
  const { kEnc, kMac, saltHash } = deriveSessionKeys(shared, parsed.hostkitPub, options.devicePublic);
  const channel = new SealedChannel(kEnc, kMac, saltHash, 'c2s');
  const serverNonce = Buffer.from(parsed.serverNonce, 'base64');
  channel.setOwnNoncePrefix(deviceNonce.subarray(0, 3));
  channel.setPeerNoncePrefix(serverNonce.subarray(0, 3));
  const sessionId = sessionIdFrom(saltHash, deviceNonce, serverNonce);
  return new TunnelClient(ws, channel, { sessionId, pingIntervalMs: options.pingIntervalMs ?? 2000, onEnvelope: options.onEnvelope });
}

/** Minimal client-side session used by tests and diagnostics. */
export class TunnelClient extends EventEmitter {
  /**
   * @param {import('./ws.mjs').WsConnection} ws
   * @param {SealedChannel} channel
   * @param {{sessionId: string, pingIntervalMs?: number, onEnvelope?: (envelope: object) => void}} options
   */
  constructor(ws, channel, options) {
    super();
    this.ws = ws;
    this.channel = channel;
    this.sessionId = options.sessionId;
    this.splitter = new FrameSplitter();
    this.closed = false;
    this.lastActivity = Date.now();
    this.pingIntervalMs = options.pingIntervalMs ?? 2000;
    ws.on('message', (payload) => this.onMessage(payload));
    ws.on('close', () => this.finish());
    this.pingTimer = setInterval(() => {
      if (this.closed) return;
      if (Date.now() - this.lastActivity > 3 * this.pingIntervalMs) {
        this.finish();
        return;
      }
      this.send({ kind: KIND.PING });
    }, this.pingIntervalMs);
    if (typeof this.pingTimer.unref === 'function') this.pingTimer.unref();
  }

  /** @param {Buffer} payload @returns {void} */
  onMessage(payload) {
    if (this.closed) return;
    this.lastActivity = Date.now();
    let frames;
    try {
      frames = this.splitter.push(payload);
    } catch (error) {
      this.emit('error', error);
      this.finish();
      return;
    }
    for (const frame of frames) {
      let envelope;
      try {
        envelope = decodeEnvelope(this.channel.open(frame));
      } catch (error) {
        this.emit('error', error);
        this.finish();
        return;
      }
      if (envelope.kind === KIND.PING) {
        this.send({ kind: KIND.PONG });
        continue;
      }
      this.emit('envelope', envelope);
    }
  }

  /** @param {object} envelope @returns {void} */
  send(envelope) {
    if (this.closed) return;
    this.ws.send(encodeFrame(this.channel.seal(encodeEnvelope(envelope))), { binary: true });
  }

  /** @returns {void} */
  finish() {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    this.emit('close');
  }

  /** @returns {void} */
  close() {
    this.finish();
    this.ws.close(1000, 'client done');
  }
}
