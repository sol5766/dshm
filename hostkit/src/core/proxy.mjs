/**
 * The *only* place in hostkit that talks to the dsh Host.
 *
 * Why this module exists: D1 §6.4's conclusion is that "the tunnel exit stays on the Host's loopback",
 * which is what makes the upstream trust fence and the loopback-only privileged methods satisfied
 * without a single forged header. Concentrating every upstream dial here means that property is
 * checkable by reading one file: every URL is built from `127.0.0.1:<dshPort>`, and no code path
 * rewrites `Host`, `Origin`, `Cookie` or `Sec-Fetch-*`.
 *
 * Two carriers, mirroring D2 §1.1 and §1.2:
 *   - unary RPC      → `POST http://127.0.0.1:<port><path>` (client's cookie passes through)
 *   - logical stream → `ws://127.0.0.1:<port><path>`    (client-mode RFC 6455, see core/ws.mjs)
 */

import http from 'node:http';
import { wsData, wsClose } from './frames.mjs';
import { connect as wsConnect } from './ws.mjs';

/** Hop-by-hop headers, which must not be forwarded in either direction (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export class ProxyError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ProxyError';
    this.code = code;
  }
}

export class HostProxy {
  /**
   * @param {{dshHost?: string, dshPort: number, maxBodyBytes?: number, timeoutMs?: number, logger?: object}} options
   */
  constructor(options) {
    this.dshHost = options.dshHost ?? '127.0.0.1';
    this.dshPort = options.dshPort;
    this.maxBodyBytes = options.maxBodyBytes ?? 8 * 1024 * 1024;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.logger = options.logger;
    /** in-flight upstream requests, keyed by tunnel call id — aborted when the session ends */
    this.inflight = new Map();
    /** @type {Map<string, import('./ws.mjs').WsConnection>} */
    this.streams = new Map();
  }

  /** Base URL of the Host, used in diagnostics. */
  get baseUrl() {
    return `http://${this.dshHost}:${this.dshPort}`;
  }

  /**
   * Forward one unary call to the Host's loopback listener.
   * Always asynchronous, so a validation failure surfaces as a rejection rather than a synchronous
   * throw from inside a caller's `await` expression.
   * @param {{id: string, method: string, path: string, headers: Record<string,string|string[]>, body: Buffer}} call
   * @returns {Promise<{status: number, headers: Record<string,string|string[]>, body: Buffer}>}
   */
  async forwardUnary(call) {
    // The path is taken verbatim from the client so the envelope semantics (`/api/<ns>/<method>`)
    // survive; it is validated to be an absolute path so a client cannot smuggle an absolute URL.
    if (typeof call.path !== 'string' || !call.path.startsWith('/')) {
      throw new ProxyError('bad-path', `path must be an absolute path, got ${JSON.stringify(call.path)}`);
    }
    const method = String(call.method ?? 'POST').toUpperCase();
    const headers = { ...call.headers };
    for (const name of Object.keys(headers)) {
      if (HOP_BY_HOP.has(name.toLowerCase())) delete headers[name];
    }
    // Only set what the client did not: length and connection discipline.
    if (headers['content-length'] === undefined && call.body.length > 0) {
      headers['content-length'] = String(call.body.length);
    }
    headers.connection = 'keep-alive';

    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: this.dshHost,
          port: this.dshPort,
          path: call.path,
          method,
          headers,
          agent: false,
          // A tunnel that dies mid-call must not leave a socket parked on the Host forever.
          timeout: this.timeoutMs,
        },
        (response) => {
          /** @type {Buffer[]} */
          const chunks = [];
          let total = 0;
          response.on('data', (chunk) => {
            total += chunk.length;
            if (total > this.maxBodyBytes) {
              // Stop reading; the caller gets a `too-large` answer instead of unbounded memory.
              request.destroy();
              reject(new ProxyError('too-large', `upstream response body exceeded ${this.maxBodyBytes} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            this.inflight.delete(call.id);
            resolve({
              status: response.statusCode ?? 502,
              headers: normalizeResponseHeaders(response.headers),
              body: Buffer.concat(chunks, total),
            });
          });
          response.on('error', (error) => {
            this.inflight.delete(call.id);
            reject(error);
          });
        },
      );
      this.inflight.set(call.id, request);
      request.on('error', (error) => {
        this.inflight.delete(call.id);
        reject(error);
      });
      request.on('timeout', () => {
        request.destroy(new ProxyError('timeout', `upstream call ${call.id} timed out`));
      });
      if (call.body.length > 0) request.write(call.body);
      request.end();
    });
  }

  /**
   * Open a logical stream against the Host and bridge it to the tunnel.
   * @param {string} id tunnel stream id
   * @param {string} path e.g. `/api/remote.mux`
   * @param {{headers?: Record<string,string|string[]>, onData: (id: string, dataB64: string, binary: boolean) => void, onClose: (frame: object) => void}} hooks
   * @returns {Promise<{subprotocol: string|null, headers: Record<string,string|string[]>}>}
   */
  async openStream(id, path, hooks) {
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new ProxyError('bad-path', `stream path must be absolute, got ${JSON.stringify(path)}`);
    }
    const url = new URL(`ws://${this.dshHost}:${this.dshPort}${path}`);
    const connection = await wsConnect(url, { headers: stripHopByHop(hooks.headers ?? {}) });
    this.streams.set(id, connection);
    connection.on('message', (payload, isBinary) => hooks.onData(id, payload.toString('base64'), isBinary));
    connection.on('close', (info) => {
      this.streams.delete(id);
      hooks.onClose(wsClose(id, info.code, info.reason));
    });
    connection.on('error', (error) => {
      // The close event always follows, so the tunnel is told exactly once.
      this.logger?.debug?.(`proxy: stream ${id} error: ${error.message}`);
    });
    return { subprotocol: null, headers: {} };
  }

  /**
   * @param {string} id @param {Buffer|Uint8Array} data @param {boolean} [binary]
   * @returns {boolean} whether the stream existed
   */
  sendStreamData(id, data, binary = true) {
    const stream = this.streams.get(id);
    if (stream === undefined) return false;
    stream.send(Buffer.from(data), { binary });
    return true;
  }

  /**
   * @param {string} id @param {number} code @param {string} reason
   * @returns {void}
   */
  closeStream(id, code, reason) {
    const stream = this.streams.get(id);
    if (stream === undefined) return;
    this.streams.delete(id);
    stream.close(code, reason);
  }

  /** Abort everything (tunnel session ended or hostkit is shutting down). */
  destroy() {
    for (const request of this.inflight.values()) request.destroy();
    this.inflight.clear();
    for (const stream of this.streams.values()) stream.destroy();
    this.streams.clear();
  }

  /**
   * @param {string} id @param {string} path @returns {object}
   */
  static openResult(id, path) {
    return { kind: 'ws-open-res', id, ok: true, path };
  }

  /**
   * @param {string} id @param {string} dataB64 @param {boolean} [binary] @returns {object}
   */
  static data(id, dataB64, binary = true) {
    return wsData(id, dataB64, binary);
  }
}

/**
 * @param {Record<string, string|string[]>} headers @returns {Record<string,string|string[]>}
 */
function stripHopByHop(headers) {
  /** @type {Record<string,string|string[]>} */
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Node gives us `string | string[] | undefined`; the tunnel wire type is `string | string[]`.
 * `set-cookie` is the reason arrays must survive untouched.
 * @param {Record<string, string|string[]|undefined>} headers
 * @returns {Record<string,string|string[]>}
 */
function normalizeResponseHeaders(headers) {
  /** @type {Record<string,string|string[]>} */
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}
