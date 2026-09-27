/**
 * Identity keys, session key agreement and the AEAD framing primitive.
 *
 * Why this module exists: hostkit's whole value proposition (D1 §6.4, levels L1/L2) is that the
 * plaintext of every Remote call crosses the LAN *inside* our own cryptographically sealed frames —
 * never through TLS alone, and never through a Host/Origin forgery. So the sealing primitive is the
 * one piece of hostkit that must be boring, small and independently testable.
 *
 * Design notes:
 *  - X25519 for the device identity and the per-session ephemeral agreement. The device keypair is
 *    generated on the phone (ArkTS side); hostkit only ever stores the *public* half plus its own
 *    long-term private half.
 *  - HKDF-SHA256 for key separation, with the transcript hash `SHA256(hostPub||devicePub)` as salt,
 *    so both ends derive identical keys without the salt ever being transmitted.
 *  - AES-256-GCM only. The 12-byte nonce is *deterministic* (`prefix || direction || counter`) with a
 *    per-session random prefix, so reusing a key across sessions cannot repeat a nonce; a per-session
 *    strictly-increasing counter is the replay guard required by the task book.
 *  - The nonce prefix is negotiated in the first sealed frame (`Session.open()` writes it into the
 *    AAD and adopts the peer's prefix), which keeps the handshake to a single round trip.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** Wire version of the tunnel protocol. */
export const TUNNEL_VERSION = 1;
/** HKDF info strings — changing either one is a wire break. */
export const INFO_ENC = 'dshkit-tunnel-v1-enc';
export const INFO_MAC = 'dshkit-tunnel-v1-mac';
/** AAD domain separator, also mixed into HKDF so the two derivations cannot collide. */
export const AAD_PREFIX = Buffer.from('dshkit-tunnel-v1', 'utf8');
/** DER prefixes for raw X25519 keys (RFC 8410 SPKI / PKCS#8). */
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
/** Nonce layout: 3-byte session prefix || 1-byte direction || 8-byte big-endian counter. */
export const NONCE_PREFIX_BYTES = 3;
export const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/* ------------------------------------------------------------------ *
 * Encoding helpers
 * ------------------------------------------------------------------ */

/** @param {Buffer|Uint8Array|string} value @returns {Buffer} */
export function toBuf(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return Buffer.from(value);
}

/** @param {Buffer} buf @returns {string} base64url without padding */
export function b64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * base64url decode that tolerates missing padding (ArkTS clients differ here).
 * @param {string} text @returns {Buffer}
 */
export function unb64u(text) {
  const normalized = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, 'base64');
}

/** @param {Buffer} buf @returns {string} standard base64 */
export function b64(buf) {
  return Buffer.from(buf).toString('base64');
}

/** @param {string} text @returns {Buffer} */
export function unb64(text) {
  return Buffer.from(String(text), 'base64');
}

/* ------------------------------------------------------------------ *
 * Constant-time comparison
 * ------------------------------------------------------------------ */

/**
 * Constant-time string comparison. Both sides are hashed first so unequal lengths cannot leak
 * through `timingSafeEqual`'s length check, and so a caller passing a raw token never gets a
 * length-dependent early exit.
 * @param {string} a @param {string} b @returns {boolean}
 */
export function constantTimeEqual(a, b) {
  const ha = createHash('sha256').update(String(a), 'utf8').digest();
  const hb = createHash('sha256').update(String(b), 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/* ------------------------------------------------------------------ *
 * X25519 identity
 * ------------------------------------------------------------------ */

/** @returns {string} 32 raw private bytes, base64url */
export function generateIdentityPrivate() {
  const { privateKey } = generateKeyPairSync('x25519');
  const der = privateKey.export({ type: 'pkcs8', format: 'der' });
  return b64u(der.subarray(der.length - 32));
}

/** @param {string} privateB64u @returns {string} 32 raw public bytes, base64url */
export function identityPublicFromPrivate(privateB64u) {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, unb64u(privateB64u)]),
    format: 'der',
    type: 'pkcs8',
  });
  const pub = createPublicKey(key).export({ type: 'spki', format: 'der' });
  return b64u(pub.subarray(pub.length - 32));
}

/**
 * X25519 scalar multiplication over raw 32-byte keys.
 * @param {string} privateB64u local private key @param {string} publicB64u peer public key
 * @returns {Buffer} 32-byte shared secret
 */
export function agree(privateB64u, publicB64u) {
  const priv = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, unb64u(privateB64u)]),
    format: 'der',
    type: 'pkcs8',
  });
  const pub = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, unb64u(publicB64u)]),
    format: 'der',
    type: 'spki',
  });
  return diffieHellman({ privateKey: priv, publicKey: pub });
}

/* ------------------------------------------------------------------ *
 * Key schedule
 * ------------------------------------------------------------------ */

/** @param {Buffer} data @returns {Buffer} */
function sha256(data) {
  return createHash('sha256').update(data).digest();
}

/**
 * Derive the session key material from a shared secret and the public-key transcript.
 * @param {Buffer} shared X25519 output
 * @param {string} hostPubB64u hostkit identity public key
 * @param {string} devicePubB64u device identity public key
 * @returns {{kEnc: Buffer, kMac: Buffer, saltHash: Buffer}}
 */
export function deriveSessionKeys(shared, hostPubB64u, devicePubB64u) {
  const saltHash = sha256(Buffer.concat([unb64u(hostPubB64u), unb64u(devicePubB64u)]));
  const kEnc = Buffer.from(hkdfSync('sha256', shared, saltHash, `${INFO_ENC}|${AAD_PREFIX.toString('utf8')}`, 32));
  const kMac = Buffer.from(hkdfSync('sha256', shared, saltHash, `${INFO_MAC}|${AAD_PREFIX.toString('utf8')}`, 32));
  return { kEnc, kMac, saltHash };
}

/** Session id: a short, non-secret label used in the nonce prefix and audit records. */
export function sessionIdFrom(saltHash, clientNonce, serverNonce) {
  return createHash('sha256')
    .update(Buffer.concat([saltHash, toBuf(clientNonce), toBuf(serverNonce)]))
    .digest('hex')
    .slice(0, 16);
}

/* ------------------------------------------------------------------ *
 * Sealed channel
 * ------------------------------------------------------------------ */

/**
 * One direction-independent AEAD channel: seal/open with a per-session nonce prefix and a
 * strictly-increasing counter.
 *
 * Replay/reorder guard: `open()` refuses any frame whose counter is not strictly greater than the
 * highest counter already accepted *and whose counter was not already seen*. Because the frames must
 * be processed in order the session is torn down on violation rather than silently dropping.
 */
export class SealedChannel {
  /**
   * @param {Buffer} kEnc @param {Buffer} kMac @param {Buffer} saltHash
   * @param {'c2s'|'s2c'} direction this channel writes in
   */
  constructor(kEnc, kMac, saltHash, direction) {
    this.kEnc = kEnc;
    this.kMac = kMac;
    this.saltHash = saltHash;
    this.role = direction === 'c2s' ? 0 : 1;
    this.peerRole = direction === 'c2s' ? 1 : 0;
    /** @type {Buffer|null} */
    this.ownNoncePrefix = null;
    /** @type {Buffer|null} */
    this.peerNoncePrefix = null;
    this.sendSeq = 0n;
    // `-1n` so that the peer's first frame (counter 0) is accepted; every later frame must be strictly
    // greater, which is what makes reordering and replay detectable.
    this.lastRecvSeq = -1n;
    /** @type {Set<string>} accepted counters, kept only as a defensive second check */
    this.seen = new Set();
  }

  /** @param {Buffer} prefix @returns {void} */
  setOwnNoncePrefix(prefix) {
    this.ownNoncePrefix = Buffer.from(prefix);
  }

  /** @param {Buffer} prefix @returns {void} */
  setPeerNoncePrefix(prefix) {
    this.peerNoncePrefix = Buffer.from(prefix);
  }

  /** @returns {boolean} */
  get ready() {
    return this.ownNoncePrefix !== null && this.peerNoncePrefix !== null;
  }

  /**
   * Build the 12-byte nonce: `prefix(3) || role(1) || counter(8 big-endian)`.
   * @param {Buffer} prefix @param {number} role @param {bigint} seq @returns {Buffer}
   */
  static nonce(prefix, role, seq) {
    const out = Buffer.alloc(NONCE_BYTES);
    prefix.copy(out, 0, 0, NONCE_PREFIX_BYTES);
    out.writeUInt8(role & 0xff, NONCE_PREFIX_BYTES);
    out.writeBigUInt64BE(seq, NONCE_PREFIX_BYTES + 1);
    return out;
  }

  /**
   * Additional authenticated data binds the transcript, direction and counter. A frame replayed into
   * a different session — or reflected back at its sender — cannot authenticate.
   * @param {number} role @param {bigint} seq @returns {Buffer}
   */
  aad(role, seq) {
    const head = Buffer.alloc(9);
    head.writeUInt8(role & 0xff, 0);
    head.writeBigUInt64BE(seq, 1);
    return Buffer.concat([AAD_PREFIX, this.saltHash, head]);
  }

  /**
   * Encrypt one frame.
   * @param {Buffer|Uint8Array|string} plaintext
   * @returns {Buffer} nonce || ciphertext || tag
   */
  seal(plaintext) {
    if (this.ownNoncePrefix === null) throw new Error('sealed channel: own nonce prefix not negotiated');
    const seq = this.sendSeq;
    this.sendSeq += 1n;
    const nonce = SealedChannel.nonce(this.ownNoncePrefix, this.role, seq);
    const cipher = createCipheriv('aes-256-gcm', this.kEnc, nonce);
    cipher.setAAD(this.aad(this.role, seq));
    const body = Buffer.concat([cipher.update(toBuf(plaintext)), cipher.final()]);
    return Buffer.concat([nonce, body, cipher.getAuthTag()]);
  }

  /**
   * Decrypt one frame, enforcing the replay guard.
   * @param {Buffer} frame nonce || ciphertext || tag
   * @returns {Buffer} plaintext
   */
  open(frame) {
    if (this.peerNoncePrefix === null) throw new Error('sealed channel: peer nonce prefix not negotiated');
    if (frame.length < NONCE_BYTES + TAG_BYTES) throw new SealedError('short-frame');
    const nonce = frame.subarray(0, NONCE_BYTES);
    const body = frame.subarray(NONCE_BYTES);
    // The counter travels inside the cleartext nonce, but it is authenticated: any tampering makes
    // setAAD/final() fail below. Checking it first just gives a precise error.
    const role = nonce.readUInt8(NONCE_PREFIX_BYTES);
    const seq = nonce.readBigUInt64BE(NONCE_PREFIX_BYTES + 1);
    if (role !== this.peerRole) throw new SealedError('bad-direction');
    if (!nonce.subarray(0, NONCE_PREFIX_BYTES).equals(this.peerNoncePrefix)) {
      throw new SealedError('bad-nonce-prefix');
    }
    const key = seq.toString(16);
    if (seq <= this.lastRecvSeq || this.seen.has(key)) throw new SealedError('replay');
    const decipher = createDecipheriv('aes-256-gcm', this.kEnc, nonce);
    decipher.setAAD(this.aad(role, seq));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    let plaintext;
    try {
      plaintext = Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]);
    } catch {
      throw new SealedError('auth');
    }
    this.lastRecvSeq = seq;
    this.seen.add(key);
    // Bound the defensive set; the monotonic check is the real guard.
    if (this.seen.size > 4096) this.seen.clear();
    return plaintext;
  }
}

/** Distinguishable failure modes so the tunnel can audit *why* a frame was rejected. */
export class SealedError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(`sealed frame rejected: ${code}`);
    this.name = 'SealedError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ *
 * Misc primitives
 * ------------------------------------------------------------------ */

/** @param {number} bytes @returns {string} base64url */
export function randomToken(bytes = 32) {
  return b64u(randomBytes(bytes));
}

/** @param {object} value @returns {string} */
export function signAudit(value, key) {
  return createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
}
