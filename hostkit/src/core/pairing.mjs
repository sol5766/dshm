/**
 * Pairing-code lifecycle: a short-lived, single-use window in which exactly one device may obtain
 * authorization by presenting a fresh X25519 public key.
 *
 * Why this module exists: pairing is the *only* moment where hostkit grants trust, so it is the one
 * place where the L1 threat model can be broken by a sloppy implementation. The rules enforced here:
 *
 *  1. A pairing window is **time-boxed** (default 120 s, D1 §6.5 「短时配对码」).
 *  2. `pairToken` is 32 random bytes and compared with a **constant-time** comparison, so a LAN
 *     attacker cannot recover it byte-by-byte by timing `POST /pair`.
 *  3. `pairId` is **burned on first success** — a captured request cannot be replayed, and a second
 *     device cannot join the same window.
 *  4. Failure reasons are distinguished (`unknown` / `expired` / `consumed` / `token-mismatch`) so the
 *     audit log says what actually happened; only the caller-facing response stays vague.
 *  5. Pairing is only accepted when a window is *open* — i.e. the user explicitly ran `hostkit pair`.
 *     There is no ambient "pairing endpoint" that is always listening.
 */

import { constantTimeEqual, randomToken } from './crypto.mjs';

/** Default window: D1 §6.5 says "短时"; the task book for hostkit fixes 120 s. */
export const DEFAULT_PAIRING_WINDOW_MS = 120_000;

/** Machine-readable rejection reasons (audited, and mapped to a wire `code`). */
export const PAIR_REJECT = Object.freeze({
  NO_WINDOW: 'no-window',
  UNKNOWN_PAIR_ID: 'unknown-pair-id',
  EXPIRED: 'expired',
  CONSUMED: 'consumed',
  TOKEN_MISMATCH: 'token-mismatch',
  BAD_REQUEST: 'bad-request',
});

export class PairingService {
  /**
   * @param {{windowMs?: number, now?: () => number}} [options]
   */
  constructor(options = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_PAIRING_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    /** @type {Map<string, {pairId: string, pairToken: string, createdAt: number, expiresAt: number, consumedAt?: number, deviceId?: string}>} */
    this.windows = new Map();
    /** @type {string|null} id of the window the CLI/UI currently advertises, if any */
    this.activePairId = null;
    /** @type {((event: {type: string, [k: string]: unknown}) => void)|null} */
    this.onEvent = null;
  }

  /**
   * Open a new pairing window. Any previously open window is closed first: two simultaneously valid
   * pairing codes would double the attack surface for no product benefit.
   * @param {{name?: string}} [options]
   * @returns {{pairId: string, pairToken: string, createdAt: number, expiresAt: number, windowMs: number}}
   */
  openWindow(options = {}) {
    this.closeWindow('superseded');
    const pairId = randomToken(12);
    const window = {
      pairId,
      pairToken: randomToken(32),
      name: options.name ?? 'hostkit',
      createdAt: this.now(),
      expiresAt: this.now() + this.windowMs,
    };
    this.windows.set(pairId, window);
    this.activePairId = pairId;
    this.emit({ type: 'open', pairId, expiresAt: window.expiresAt });
    return window;
  }

  /**
   * @param {string} [reason]
   * @returns {void}
   */
  closeWindow(reason = 'closed') {
    if (this.activePairId !== null) {
      const window = this.windows.get(this.activePairId);
      if (window !== undefined) {
        this.windows.delete(this.activePairId);
        this.emit({ type: 'close', pairId: window.pairId, reason });
      }
    }
    this.activePairId = null;
  }

  /** Drop expired windows so a long-running process does not accumulate them. */
  prune() {
    const now = this.now();
    for (const [pairId, window] of this.windows) {
      if (window.consumedAt === undefined && window.expiresAt <= now) {
        this.windows.delete(pairId);
        if (this.activePairId === pairId) this.activePairId = null;
        this.emit({ type: 'expire', pairId });
      }
    }
  }

  /** @returns {boolean} whether a pairing window is currently advertised and unexpired */
  get isOpen() {
    this.prune();
    if (this.activePairId === null) return false;
    const window = this.windows.get(this.activePairId);
    return window !== undefined && window.expiresAt > this.now();
  }

  /**
   * Validate a `POST /pair` body without consuming it. Split from {@link consume} so the caller can
   * audit a rejection before deciding to burn the window.
   * @param {{pairId?: unknown, pairToken?: unknown, deviceId?: unknown, devicePub?: unknown}} body
   * @returns {{ok: true, window: object} | {ok: false, reason: string}}
   */
  verify(body) {
    if (typeof body?.pairId !== 'string' || typeof body?.pairToken !== 'string') {
      return { ok: false, reason: PAIR_REJECT.BAD_REQUEST };
    }
    if (typeof body?.deviceId !== 'string' || body.deviceId.length === 0) {
      return { ok: false, reason: PAIR_REJECT.BAD_REQUEST };
    }
    if (typeof body?.devicePub !== 'string' || body.devicePub.length === 0) {
      return { ok: false, reason: PAIR_REJECT.BAD_REQUEST };
    }
    const window = this.windows.get(body.pairId);
    if (window === undefined) {
      return { ok: false, reason: this.isOpen ? PAIR_REJECT.UNKNOWN_PAIR_ID : PAIR_REJECT.NO_WINDOW };
    }
    if (window.consumedAt !== undefined) return { ok: false, reason: PAIR_REJECT.CONSUMED };
    if (window.expiresAt <= this.now()) return { ok: false, reason: PAIR_REJECT.EXPIRED };
    if (!constantTimeEqual(window.pairToken, body.pairToken)) {
      return { ok: false, reason: PAIR_REJECT.TOKEN_MISMATCH };
    }
    return { ok: true, window };
  }

  /**
   * Verify and burn. On success the window is marked consumed and cannot be reused, even if the same
   * request is replayed byte-for-byte.
   *
   * The consumed window is **retained** (until the process exits) so a replay reports `consumed` rather
   * than the misleading `no-window` — the audit log should say "someone replayed a burned pairing code",
   * which is a different event from "someone knocked while no window was open".
   * @param {{pairId?: unknown, pairToken?: unknown, deviceId?: unknown, devicePub?: unknown}} body
   * @returns {{ok: true, window: object} | {ok: false, reason: string}}
   */
  consume(body) {
    const result = this.verify(body);
    if (!result.ok) return result;
    result.window.consumedAt = this.now();
    result.window.deviceId = String(body.deviceId);
    this.emit({ type: 'consume', pairId: result.window.pairId, deviceId: result.window.deviceId });
    if (this.activePairId === result.window.pairId) {
      this.emit({ type: 'close', pairId: result.window.pairId, reason: 'consumed' });
      this.activePairId = null;
    }
    return result;
  }

  /**
   * The exact object a client receives over the `dshkit://` URI (or the QR payload).
   * Keeping this function as the single source of truth means the QR image and the printed URI can
   * never disagree.
   * @param {{host: string, port: number, hostkitPub: string, tls?: boolean, pairId?: string, pairToken?: string, name?: string, expiresAt?: number}} input
   * @returns {{v: number, name: string, host: string, port: number, hostkitPub: string, pairId: string, pairToken: string, expiresAt: number, tls: boolean}}
   */
  static payload(input) {
    return {
      v: 1,
      name: input.name ?? 'hostkit',
      host: input.host,
      port: input.port,
      hostkitPub: input.hostkitPub,
      pairId: input.pairId ?? '',
      pairToken: input.pairToken ?? '',
      expiresAt: input.expiresAt ?? 0,
      tls: input.tls === true,
    };
  }

  /**
   * Encode the payload as a compact `dshkit://` URI. Field order is fixed so the QR image is
   * deterministic for a given window (easier to eyeball in a terminal).
   * @param {ReturnType<typeof PairingService.payload>} payload
   * @returns {string}
   */
  static toUri(payload) {
    const params = new URLSearchParams();
    params.set('v', String(payload.v));
    params.set('name', payload.name);
    params.set('host', payload.host);
    params.set('port', String(payload.port));
    params.set('pub', payload.hostkitPub);
    params.set('pairId', payload.pairId);
    params.set('token', payload.pairToken);
    params.set('exp', String(payload.expiresAt));
    params.set('tls', payload.tls ? '1' : '0');
    return `dshkit://pair?${params.toString()}`;
  }

  /**
   * Parse a `dshkit://` URI back into a payload (used by the ArkTS side and by tests).
   * @param {string} uri @returns {object}
   */
  static fromUri(uri) {
    const text = String(uri);
    if (!text.startsWith('dshkit://')) throw new Error('not a dshkit:// URI');
    const url = new URL(text);
    if (url.hostname !== 'pair') throw new Error(`unknown dshkit action: ${url.hostname}`);
    const get = (key) => {
      const value = url.searchParams.get(key);
      if (value === null) throw new Error(`dshkit URI is missing ${key}`);
      return value;
    };
    return PairingService.payload({
      v: Number(get('v')),
      name: get('name'),
      host: get('host'),
      port: Number(get('port')),
      hostkitPub: get('pub'),
      pairId: get('pairId'),
      pairToken: get('token'),
      expiresAt: Number(get('exp')),
      tls: get('tls') === '1',
    });
  }

  /** @param {object} event @returns {void} */
  emit(event) {
    if (typeof this.onEvent === 'function') this.onEvent(event);
  }
}
