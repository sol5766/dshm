/**
 * Persistent device whitelist.
 *
 * Why this module exists: the tunnel's authorization decision ("may this deviceId open a session?")
 * has to survive a hostkit restart, and it has to survive an *interrupted* write — a half-written
 * JSON file would either lock every device out or, worse, authorize a device whose public key was
 * never fully persisted. So writes go through temp-file + `fsync` + `rename` (atomic on the same
 * filesystem on Windows/macOS/Linux alike) and the file is created mode 0600 from the start.
 *
 * Revocation is a *sticky flag*, not a delete: the tunnel must be able to answer "this device was
 * paired and then revoked" differently from "this device was never paired" in the audit log, and the
 * device id must not be silently reusable by a later pairing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';

const SCHEMA_VERSION = 1;

/** Shape of one whitelist record (documented for the ArkTS side). */
export const DEVICE_FIELDS = Object.freeze([
  'deviceId',
  'devicePub',
  'deviceName',
  'pairedAt',
  'lastSeenAt',
  'revokedAt',
  'pairs',
]);

export class WhitelistStore {
  /**
   * @param {string} filePath absolute path of the `devices.json` file
   */
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {Map<string, object>} deviceId → record */
    this.records = new Map();
    this.loaded = false;
  }

  /** Load from disk (idempotent). A missing file is an empty whitelist, not an error. */
  load() {
    if (this.loaded) return this;
    this.loaded = true;
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return this;
      throw new Error(`whitelist: cannot read ${this.filePath}: ${error.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt file is a hard error: guessing would mean guessing about authorization.
      throw new Error(`whitelist: ${this.filePath} is not valid JSON; refusing to start`);
    }
    const devices = parsed?.devices;
    if (!Array.isArray(devices)) throw new Error(`whitelist: ${this.filePath} has no devices array`);
    for (const record of devices) {
      if (typeof record?.deviceId !== 'string' || typeof record?.devicePub !== 'string') continue;
      this.records.set(record.deviceId, record);
    }
    return this;
  }

  /**
   * @param {string} deviceId @returns {object|undefined}
   */
  get(deviceId) {
    this.load();
    return this.records.get(deviceId);
  }

  /** @returns {object[]} every record, newest pairing first */
  list() {
    this.load();
    return [...this.records.values()].sort((a, b) => String(b.pairedAt).localeCompare(String(a.pairedAt)));
  }

  /**
   * Whether a device may open a tunnel right now.
   * @param {string} deviceId @returns {boolean}
   */
  isAuthorized(deviceId) {
    const record = this.get(deviceId);
    return record !== undefined && record.revokedAt === undefined;
  }

  /**
   * Add (or re-authorize) a device. Re-pairing a revoked device clears the revocation but keeps the
   * pairing history, so the audit trail is not rewritten.
   * @param {{deviceId: string, devicePub: string, deviceName?: string, now?: string}} input
   * @returns {object} the stored record
   */
  add(input) {
    this.load();
    if (typeof input.deviceId !== 'string' || input.deviceId.length === 0) {
      throw new Error('whitelist: deviceId is required');
    }
    if (typeof input.devicePub !== 'string' || input.devicePub.length === 0) {
      throw new Error('whitelist: devicePub is required');
    }
    const now = input.now ?? new Date().toISOString();
    const previous = this.records.get(input.deviceId);
    if (previous !== undefined && previous.devicePub !== input.devicePub) {
      // Same id, different key: treat as a fresh device rather than silently trusting the new key
      // under an old authorization decision — but keep the id, which the client chose.
      previous.pairs = (previous.pairs ?? 1) + 1;
      previous.devicePub = input.devicePub;
      previous.deviceName = input.deviceName ?? previous.deviceName;
      previous.pairedAt = now;
      delete previous.revokedAt;
      this.persist();
      return previous;
    }
    const record = {
      deviceId: input.deviceId,
      devicePub: input.devicePub,
      deviceName: input.deviceName ?? previous?.deviceName ?? input.deviceId.slice(0, 8),
      pairedAt: now,
      pairs: (previous?.pairs ?? 0) + 1,
      ...(previous?.lastSeenAt === undefined ? {} : { lastSeenAt: previous.lastSeenAt }),
    };
    this.records.set(input.deviceId, record);
    this.persist();
    return record;
  }

  /**
   * @param {string} deviceId @param {string} [now] @returns {object|undefined} the revoked record
   */
  revoke(deviceId, now = new Date().toISOString()) {
    this.load();
    const record = this.records.get(deviceId);
    if (record === undefined) return undefined;
    record.revokedAt = now;
    this.persist();
    return record;
  }

  /**
   * @param {string} deviceId @param {string} [now] @returns {void}
   */
  touch(deviceId, now = new Date().toISOString()) {
    this.load();
    const record = this.records.get(deviceId);
    if (record === undefined) return;
    record.lastSeenAt = now;
    // Best-effort: a failure to record `lastSeenAt` must never break a tunnel that is already open.
    try {
      this.persist();
    } catch {
      /* ignore */
    }
  }

  /** Atomically write the whitelist. */
  persist() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const payload = `${JSON.stringify(
      { version: SCHEMA_VERSION, updatedAt: new Date().toISOString(), devices: this.list() },
      null,
      2,
    )}\n`;
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const handle = fs.openSync(temp, 'w', 0o600);
    try {
      fs.writeFileSync(handle, payload, 'utf8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temp, this.filePath);
  }
}
