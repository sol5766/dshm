/**
 * Append-only JSONL audit log.
 *
 * Why this module exists: D1 §6.5 lists 审计 ("record device access / revocation events, queryable")
 * as one of hostkit's five responsibilities, and the L1 threat model leans on it — "未配对设备一律拒绝"
 * is only auditable if every rejected handshake leaves a trace. Append-only JSONL means a crash can
 * at worst lose the last line, and a partial last line is detected and reported instead of poisoning
 * the whole log.
 *
 * Deliberately *not* tamper-proof: an attacker with filesystem write access can edit the log. Its job
 * is to answer "what happened and when" for the user, not to be evidence against a local root.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Canonical event names. Free-form strings are rejected so the query surface stays predictable. */
export const AUDIT_EVENTS = Object.freeze({
  START: 'hostkit.start',
  STOP: 'hostkit.stop',
  PAIR_WINDOW_OPEN: 'pair.window.open',
  PAIR_WINDOW_CLOSE: 'pair.window.close',
  PAIR_SUCCESS: 'pair.success',
  PAIR_REJECT: 'pair.reject',
  TUNNEL_OPEN: 'tunnel.open',
  TUNNEL_CLOSE: 'tunnel.close',
  TUNNEL_REJECT: 'tunnel.reject',
  DEVICE_REVOKE: 'device.revoke',
  HOST_SPAWN: 'host.spawn',
  HOST_EXIT: 'host.exit',
  HOST_RESTART: 'host.restart',
  HOST_GIVEUP: 'host.giveup',
  ERROR: 'hostkit.error',
});

export class AuditLog {
  /**
   * @param {string} filePath absolute path of the `audit.jsonl` file
   * @param {{disabled?: boolean}} [options]
   */
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.disabled = options.disabled === true;
    if (!this.disabled) fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  }

  /**
   * Append one event.
   * @param {string} event one of {@link AUDIT_EVENTS}
   * @param {object} [detail] extra fields; must be JSON-serializable
   * @returns {object} the written record
   */
  append(event, detail = {}) {
    const record = { at: new Date().toISOString(), event, ...detail };
    if (!Object.values(AUDIT_EVENTS).includes(event)) {
      throw new Error(`audit: unknown event ${event}`);
    }
    if (this.disabled) return record;
    // Re-create the directory if it vanished (an operator cleaning up state while hostkit runs, or a
    // test removing its temp tree). Losing the record would be worse than re-creating one directory.
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    // A single `appendFileSync` with O_APPEND is atomic enough for records well under PIPE_BUF
    // (4096 bytes on Linux, 512 on some filesystems); oversized records are truncated in audit,
    // never in the log-correctness sense — see README §Limitations.
    const line = `${JSON.stringify(record)}\n`;
    fs.appendFileSync(this.filePath, line, { encoding: 'utf8', mode: 0o600 });
    return record;
  }

  /**
   * Read the log.
   * @param {{tail?: number, event?: string, deviceId?: string}} [filter]
   * @returns {{records: object[], skipped: number}}
   */
  read(filter = {}) {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { records: [], skipped: 0 };
      throw error;
    }
    const lines = raw.split('\n');
    /** @type {object[]} */
    const records = [];
    let skipped = 0;
    for (const line of lines) {
      if (line.trim() === '') continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        skipped += 1;
        continue;
      }
      if (filter.event !== undefined && parsed.event !== filter.event) continue;
      if (filter.deviceId !== undefined && parsed.deviceId !== filter.deviceId) continue;
      records.push(parsed);
    }
    const tail = filter.tail;
    if (typeof tail === 'number' && tail >= 0 && records.length > tail) {
      return { records: records.slice(records.length - tail), skipped };
    }
    return { records, skipped };
  }

  /** @returns {number} number of well-formed records */
  count() {
    return this.read().records.length;
  }
}
