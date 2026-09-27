/**
 * Length-prefixed sealed-frame transport and the JSON envelope carried inside it.
 *
 * Why this module exists: the tunnel multiplexes several logical things (HTTP calls, WS streams,
 * heartbeats) over one WebSocket. The WebSocket is only a *carrier*; nothing about its framing may be
 * trusted, so every payload gets a `uint32be length` prefix of its own inside the (already sealed)
 * application frame. That prefix is what lets the receiver reject a truncated or oversized frame
 * deterministically instead of buffering until the process dies.
 *
 * Envelope kinds are deliberately a closed set with `v` omitted: the version lives in two places
 * already (the tunnel handshake and the HKDF info string), and a third copy would only be a way to
 * disagree with itself.
 */

import { b64, unb64, toBuf } from './crypto.mjs';

/** Maximum bytes of a single sealed (ciphertext) frame. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** Maximum bytes of a decoded JSON envelope. */
export const MAX_ENVELOPE_BYTES = 3 * 1024 * 1024;

/** All envelope kinds. Anything else is a protocol error. */
export const KIND = Object.freeze({
  HTTP: 'http',
  HTTP_RES: 'http-res',
  WS_OPEN: 'ws-open',
  WS_OPEN_RES: 'ws-open-res',
  WS_DATA: 'ws-data',
  WS_CLOSE: 'ws-close',
  PING: 'ping',
  PONG: 'pong',
  ERROR: 'error',
});

/** Frame header size: uint32be length of the sealed blob that follows. */
export const FRAME_HEADER_BYTES = 4;

/* ------------------------------------------------------------------ *
 * Framing
 * ------------------------------------------------------------------ */

/**
 * @param {Buffer} sealed `nonce||ciphertext||tag`
 * @returns {Buffer} `uint32be(len) || sealed`
 */
export function encodeFrame(sealed) {
  const body = toBuf(sealed);
  if (body.length === 0 || body.length > MAX_FRAME_BYTES) {
    throw new FrameError('frame-size', `sealed frame is ${body.length} bytes`);
  }
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Failure modes of the frame layer. */
export class FrameError extends Error {
  /** @param {string} code @param {string} [detail] */
  constructor(code, detail) {
    super(`frame error: ${code}${detail === undefined ? '' : ` (${detail})`}`);
    this.name = 'FrameError';
    this.code = code;
  }
}

/**
 * Incremental frame splitter. Feed it whatever the transport produced; pull complete frames out.
 * A declared length above {@link MAX_FRAME_BYTES} is rejected immediately — the alternative (waiting
 * for 4 GiB) is a denial-of-service primitive.
 */
export class FrameSplitter {
  /** @param {number} [maxFrameBytes] */
  constructor(maxFrameBytes = MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes;
    /** @type {Buffer} */
    this.buffer = Buffer.alloc(0);
  }

  /**
   * @param {Buffer|Uint8Array} chunk
   * @returns {Buffer[]} complete sealed frames
   */
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? toBuf(chunk) : Buffer.concat([this.buffer, toBuf(chunk)]);
    /** @type {Buffer[]} */
    const out = [];
    for (;;) {
      if (this.buffer.length < FRAME_HEADER_BYTES) break;
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > this.maxFrameBytes) throw new FrameError('frame-size', `declared ${length}`);
      if (this.buffer.length < FRAME_HEADER_BYTES + length) break;
      out.push(this.buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length));
      this.buffer = this.buffer.subarray(FRAME_HEADER_BYTES + length);
    }
    return out;
  }

  /** @returns {number} bytes currently buffered (for diagnostics) */
  get pending() {
    return this.buffer.length;
  }
}

/* ------------------------------------------------------------------ *
 * Envelope
 * ------------------------------------------------------------------ */

/**
 * Serialize an envelope object.
 * @param {object} envelope @returns {Buffer}
 */
export function encodeEnvelope(envelope) {
  const json = JSON.stringify(envelope);
  const buf = Buffer.from(json, 'utf8');
  if (buf.length > MAX_ENVELOPE_BYTES) throw new FrameError('envelope-size', `${buf.length} bytes`);
  return buf;
}

/**
 * Parse and validate an envelope. Unknown `kind` values are rejected (not ignored): a peer that
 * speaks a newer protocol must fail loudly, because silently dropping an HTTP call would look like a
 * network timeout to the user.
 *
 * `seq` is optional on the wire — the AEAD counter already orders frames — but when present it must
 * be a non-negative integer, and the tunnel checks monotonicity per session.
 * @param {Buffer} buf @returns {{seq?: number, kind: string, [k: string]: unknown}}
 */
export function decodeEnvelope(buf) {
  let parsed;
  try {
    parsed = JSON.parse(toBuf(buf).toString('utf8'));
  } catch {
    throw new FrameError('envelope-json');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FrameError('envelope-shape');
  }
  if (typeof parsed.kind !== 'string' || !Object.values(KIND).includes(parsed.kind)) {
    throw new FrameError('envelope-kind', String(parsed.kind));
  }
  if (parsed.seq !== undefined && (!Number.isInteger(parsed.seq) || parsed.seq < 0)) {
    throw new FrameError('envelope-seq');
  }
  return parsed;
}

/* ------------------------------------------------------------------ *
 * Envelope constructors / validators
 * ------------------------------------------------------------------ */

/**
 * @param {string} id @param {string} method @param {string} path
 * @param {Record<string,string|string[]>} headers @param {Buffer|undefined} body
 * @returns {object}
 */
export function httpRequest(id, method, path, headers, body) {
  return {
    kind: KIND.HTTP,
    id,
    method,
    path,
    headers,
    bodyB64: body === undefined || body === null ? '' : b64(body),
  };
}

/** @param {string} id @param {number} status @param {Record<string,string|string[]>} headers @param {Buffer} body @returns {object} */
export function httpResponse(id, status, headers, body) {
  return { kind: KIND.HTTP_RES, id, status, headers, bodyB64: b64(body) };
}

/** @param {string} id @param {string} code @param {string} [message] @returns {object} */
export function errorResponse(id, code, message) {
  return { kind: KIND.HTTP_RES, id, error: code, message: message ?? code };
}

/** @param {string} id @param {string} dataB64 @param {boolean} [binary] @returns {object} */
export function wsData(id, dataB64, binary = true) {
  return { kind: KIND.WS_DATA, id, dataB64, t: binary ? 'b' : 't' };
}

/**
 * Whether a `ws-data` frame carries a binary (true) or text (false) WebSocket message. Absent `t`
 * means binary — the documented default, so a peer that does not send the field still interoperates.
 * @param {object} frame @returns {boolean}
 */
export function isBinaryData(frame) {
  return frame.t !== 't';
}

/**
 * @param {string} id @param {number} [code] @param {string} [reason] @returns {object}
 */
export function wsClose(id, code = 1000, reason = '') {
  return { kind: KIND.WS_CLOSE, id, code, reason };
}

/**
 * Decode a base64 body field, tolerating the empty string.
 * @param {unknown} value @returns {Buffer}
 */
export function decodeBodyField(value) {
  if (value === undefined || value === null || value === '') return Buffer.alloc(0);
  if (typeof value !== 'string') throw new FrameError('body-type');
  return unb64(value);
}

/**
 * Normalize a header bag to `Record<string, string|string[]>` with lower-cased names.
 * Header *values* are never rewritten, so the dsh-side `Host`/`Origin` fence sees exactly what the
 * client sent; hostkit only ever adds hop-by-hop corrections.
 * @param {unknown} headers @returns {Record<string,string|string[]>}
 */
export function normalizeHeaders(headers) {
  /** @type {Record<string,string|string[]>} */
  const out = {};
  if (headers === null || headers === undefined) return out;
  if (typeof headers !== 'object' || Array.isArray(headers)) throw new FrameError('headers-type');
  for (const [name, value] of Object.entries(headers)) {
    if (typeof name !== 'string') continue;
    const key = name.toLowerCase();
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
    else if (Array.isArray(value)) out[key] = value.map((entry) => String(entry));
    // Anything else (nested object) is dropped: it cannot be represented on the HTTP wire.
  }
  return out;
}
