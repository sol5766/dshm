/**
 * LAN discovery over plain UDP broadcast.
 *
 * Why this module exists: D1 §6.5 requires 「局域网 mDNS/广播播发『可配对的 DSH Host』，供端侧一键发现」.
 *
 * **Why UDP broadcast and not mDNS** (the deliberate deviation, also recorded in hostkit/README.md):
 *  1. There is no zero-dependency mDNS implementation in Node's standard library, and the task book's
 *     red line is "zero runtime dependencies". A correct mDNS client is ~800 lines of DNS wire format
 *     plus multicast handling; a correct UDP announce/listen is ~120.
 *  2. The *consumer* is an ArkTS app. HarmonyOS's `@ohos.net.socket` exposes UDP sockets directly, but
 *     an mDNS responder would need `@ohos.net.mdns` (API-version and permission sensitive) or a
 *     hand-written DNS-SD parser on the device — more risk on the side we can test least.
 *  3. The announce payload we actually need (name, port, TLS flag, is-pairing, host public key) does not
 *     fit DNS-SD's TXT record ergonomics any better than a 200-byte JSON datagram does.
 *  4. Discovery is a *convenience*: pairing works from a typed `dshkit://` URI or a 6-digit manual code
 *     with discovery entirely disabled. So the cheapest mechanism that satisfies the requirement wins.
 *
 * Protocol: one JSON datagram per announce, sent to `255.255.255.255:<discoveryPort>` plus every
 * interface's directed broadcast address, every `announceIntervalMs` (default 3000 ms). Listeners bind
 * the same UDP port. `instanceId` lets a listener ignore its own announce and lets the CLI de-duplicate
 * hosts that move between interfaces.
 */

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { randomToken } from './core/crypto.mjs';
import { platform } from './platform/index.mjs';

/** Magic string that makes a stray datagram on the port cheap to reject. */
export const MAGIC = 'DSHKIT1';
/** Wire version of the announce payload. */
export const ANNOUNCE_VERSION = 1;
/** Maximum accepted datagram size; anything larger is not ours. */
const MAX_DATAGRAM_BYTES = 2048;

/**
 * @param {{instanceId: string, name: string, port: number, tls: boolean, pairing: boolean, hostkitPub: string}} input
 * @returns {Buffer}
 */
export function encodeAnnounce(input) {
  return Buffer.from(
    JSON.stringify({
      magic: MAGIC,
      v: ANNOUNCE_VERSION,
      instanceId: input.instanceId,
      name: input.name,
      port: input.port,
      tls: input.tls === true,
      pairing: input.pairing === true,
      hostkitPub: input.hostkitPub,
    }),
    'utf8',
  );
}

/**
 * @param {Buffer|string} datagram
 * @returns {{magic: string, v: number, instanceId: string, name: string, port: number, tls: boolean, pairing: boolean, hostkitPub: string}|undefined}
 */
export function decodeAnnounce(datagram) {
  const text = Buffer.isBuffer(datagram) ? datagram.toString('utf8') : String(datagram);
  if (text.length === 0 || text.length > MAX_DATAGRAM_BYTES) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  if (parsed.magic !== MAGIC || parsed.v !== ANNOUNCE_VERSION) return undefined;
  if (typeof parsed.instanceId !== 'string' || typeof parsed.port !== 'number') return undefined;
  if (typeof parsed.hostkitPub !== 'string') return undefined;
  return {
    magic: MAGIC,
    v: ANNOUNCE_VERSION,
    instanceId: parsed.instanceId,
    name: typeof parsed.name === 'string' ? parsed.name : 'hostkit',
    port: parsed.port,
    tls: parsed.tls === true,
    pairing: parsed.pairing === true,
    hostkitPub: parsed.hostkitPub,
  };
}

/**
 * The set of addresses to send an announce to: the limited broadcast address plus each interface's
 * directed broadcast. Directed broadcasts matter because many Wi-Fi stacks drop 255.255.255.255.
 * @param {{address: string, broadcast: string|undefined}[]} interfaces
 * @returns {string[]}
 */
export function announceTargets(interfaces) {
  const targets = new Set(['255.255.255.255']);
  for (const entry of interfaces) {
    if (typeof entry.broadcast === 'string' && entry.broadcast !== '') targets.add(entry.broadcast);
  }
  return [...targets];
}

/**
 * `dgram.send` that swallows "socket already closed" races. Announcing is best-effort: a datagram
 * lost because hostkit is shutting down is not an error worth reporting, and an unhandled
 * `ERR_SOCKET_DGRAM_NOT_RUNNING` would take the process down.
 * @param {import('node:dgram').Socket} socket
 * @param {Buffer} datagram
 * @param {number} port
 * @param {string} address
 * @param {(error: Error|null) => void} callback
 * @returns {void}
 */
function sendSafely(socket, datagram, port, address, callback) {
  try {
    socket.send(datagram, 0, datagram.length, port, address, callback);
  } catch {
    /* the socket was closed between the interval firing and this call */
  }
}

export class DiscoveryService extends EventEmitter {
  /**
   * @param {{
   *   name: string, port: number, discoveryPort: number, hostkitPub: string, tls?: boolean,
   *   announceIntervalMs?: number, logger?: object, instanceId?: string,
   * }} options
   */
  constructor(options) {
    super();
    this.name = options.name;
    this.port = options.port;
    this.discoveryPort = options.discoveryPort;
    // Fail fast: a bad UDP port would otherwise surface as an unhandled `ERR_SOCKET_BAD_PORT` from an
    // asynchronous `send()`, which is much harder to diagnose than a constructor error. `0` is allowed
    // and means "let the OS choose", which both the tests and a listener-only run rely on.
    if (!Number.isInteger(this.discoveryPort) || this.discoveryPort < 0 || this.discoveryPort > 65535) {
      throw new RangeError(`discovery: discoveryPort must be 0..65535, got ${options.discoveryPort}`);
    }
    this.hostkitPub = options.hostkitPub;
    this.tls = options.tls === true;
    this.announceIntervalMs = options.announceIntervalMs ?? 3000;
    this.logger = options.logger;
    this.instanceId = options.instanceId ?? randomToken(8);
    this.pairing = false;
    /** @type {import('node:dgram').Socket|null} */
    this.announcer = null;
    /** @type {import('node:dgram').Socket|null} */
    this.listener = null;
    this.timer = undefined;
    /** @type {Map<string, {announce: object, address: string, at: number, count: number}>} */
    this.peers = new Map();
  }

  /** @param {boolean} value @returns {void} */
  setPairing(value) {
    this.pairing = value === true;
  }

  /** @returns {Buffer} the datagram currently advertised */
  payload() {
    return encodeAnnounce({
      instanceId: this.instanceId,
      name: this.name,
      port: this.port,
      tls: this.tls,
      pairing: this.pairing,
      hostkitPub: this.hostkitPub,
    });
  }

  /**
   * Start announcing and listening.
   * @param {{announce?: boolean, listen?: boolean}} [options]
   * @returns {Promise<{announcer: boolean, listener: boolean}>}
   */
  async start(options = {}) {
    const result = { announcer: false, listener: false };
    if (options.announce !== false) {
      await this.startAnnouncer();
      result.announcer = true;
    }
    if (options.listen !== false) {
      await this.startListener();
      result.listener = true;
    }
    return result;
  }

  /** @returns {Promise<void>} */
  startAnnouncer() {
    if (this.announcer !== null) return Promise.resolve();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.announcer = socket;
    socket.on('error', (error) => this.emit('error', error));
    const send = () => {
      if (this.announcer !== socket) return;
      const datagram = this.payload();
      for (const target of announceTargets(platform.lanIPv4())) {
        // `send` is asynchronous, so the socket can already be closed when the callback runs. A
        // teardown race must never surface as an uncaught exception.
        sendSafely(socket, datagram, this.discoveryPort, target, (error) => {
          if (error !== null && error !== undefined && error.code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') {
            this.logger?.debug?.(`discovery: announce to ${target} failed: ${error.message}`);
          }
        });
      }
    };
    this.announceTick = send;
    this.timer = setInterval(send, this.announceIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    // Announce once immediately so a listener started afterwards does not wait a full interval.
    setImmediate(send);
    return Promise.resolve();
  }

  /** @returns {Promise<void>} */
  startListener() {
    if (this.listener !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.listener = socket;
      // Registered *before* bind so a bind/open failure rejects instead of becoming an unhandled
      // 'error' event; later runtime errors are surfaced on the service instead.
      socket.once('error', (error) => {
        if (this.listener === socket) {
          this.listener = null;
          try {
            socket.close();
          } catch {
            /* already closed */
          }
        }
        this.emit('error', error);
        reject(error);
      });
      socket.on('message', (message, remote) => this.onDatagram(message, remote));
      socket.bind(this.discoveryPort, () => {
        try {
          socket.setBroadcast(true);
        } catch (error) {
          this.logger?.debug?.(`discovery: setBroadcast failed: ${error.message}`);
        }
        resolve();
      });
    });
  }

  /**
   * @param {Buffer} message @param {import('node:dgram').RemoteInfo} remote
   * @returns {void}
   */
  onDatagram(message, remote) {
    const announce = decodeAnnounce(message);
    if (announce === undefined) return;
    if (announce.instanceId === this.instanceId) return; // our own announce
    if (announce.port <= 0 || announce.port > 65535) return;
    const existing = this.peers.get(announce.instanceId);
    const entry = {
      announce,
      address: remote.address,
      at: Date.now(),
      count: (existing?.count ?? 0) + 1,
    };
    this.peers.set(announce.instanceId, entry);
    this.emit('peer', entry);
    if (existing === undefined) this.emit('found', entry);
  }

  /**
   * @param {number} [maxAgeMs]
   * @returns {object[]} peers seen recently, newest first
   */
  peersList(maxAgeMs = 60_000) {
    const now = Date.now();
    return [...this.peers.values()]
      .filter((entry) => now - entry.at <= maxAgeMs)
      .sort((a, b) => b.at - a.at);
  }

  /** Stop both sockets. */
  close() {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const socket of [this.announcer, this.listener]) {
      if (socket === null) continue;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
    this.announcer = null;
    this.listener = null;
  }
}

/**
 * One-shot listener used by `hostkit discover`: collect announces for `durationMs`, or until `count`
 * distinct hosts have been seen.
 * @param {{discoveryPort: number, durationMs?: number, count?: number, logger?: object}} options
 * @returns {Promise<object[]>}
 */
export function listenForHosts(options) {
  return new Promise((resolve) => {
    const service = new DiscoveryService({
      name: 'discover',
      port: 0,
      discoveryPort: options.discoveryPort,
      hostkitPub: '',
      logger: options.logger,
    });
    /** @type {Map<string, object>} */
    const found = new Map();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      service.close();
      resolve([...found.values()]);
    };
    service.on('found', (entry) => {
      found.set(entry.announce.instanceId, entry);
      if (options.count !== undefined && found.size >= options.count) finish();
    });
    const timer = setTimeout(finish, options.durationMs ?? 5000);
    service.startListener().then(finish, finish);
  });
}
