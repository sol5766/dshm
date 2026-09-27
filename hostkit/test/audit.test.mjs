/**
 * audit.mjs tests: append-only JSONL, tail queries, filtering, and tolerance of a torn last line.
 *
 * The audit log is the user-facing answer to "who connected?", so it has to keep working after a crash
 * mid-write. That means: a partial final line must be skipped and *reported*, never allowed to hide the
 * records that came before it, and never allowed to make `read()` throw.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AUDIT_EVENTS, AuditLog } from '../src/core/audit.mjs';
import { tempDir } from './helpers/util.helper.mjs';

/** @param {import('node:test').TestContext} t @param {{disabled?: boolean}} [options] */
function makeLog(t, options = {}) {
  const file = path.join(tempDir(t), 'audit.jsonl');
  return { file, log: new AuditLog(file, options) };
}

test('append writes one JSON object per line with a timestamp and the event name', (t) => {
  const { file, log } = makeLog(t);
  log.append(AUDIT_EVENTS.PAIR_SUCCESS, { deviceId: 'd1', deviceName: 'Phone' });
  log.append(AUDIT_EVENTS.TUNNEL_OPEN, { deviceId: 'd1' });

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.match(parsed.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof parsed.event, 'string');
  }
  assert.equal(JSON.parse(lines[0]).deviceId, 'd1');
});

test('append rejects unknown event names so the query surface stays predictable', (t) => {
  const { log } = makeLog(t);
  assert.throws(() => log.append('made.up.event', {}), /unknown event/);
});

test('read with tail returns the last N records in order', (t) => {
  const { log } = makeLog(t);
  for (let index = 0; index < 10; index += 1) log.append(AUDIT_EVENTS.TUNNEL_OPEN, { deviceId: `d${index}` });
  const { records, skipped } = log.read({ tail: 3 });
  assert.equal(skipped, 0);
  assert.deepEqual(records.map((record) => record.deviceId), ['d7', 'd8', 'd9']);
  assert.equal(log.count(), 10);
});

test('read filters by event and by deviceId', (t) => {
  const { log } = makeLog(t);
  log.append(AUDIT_EVENTS.PAIR_SUCCESS, { deviceId: 'a' });
  log.append(AUDIT_EVENTS.PAIR_SUCCESS, { deviceId: 'b' });
  log.append(AUDIT_EVENTS.DEVICE_REVOKE, { deviceId: 'a' });

  assert.equal(log.read({ event: AUDIT_EVENTS.PAIR_SUCCESS }).records.length, 2);
  assert.equal(log.read({ event: AUDIT_EVENTS.DEVICE_REVOKE }).records.length, 1);
  assert.equal(log.read({ deviceId: 'a' }).records.length, 2);
  assert.equal(log.read({ deviceId: 'a', event: AUDIT_EVENTS.DEVICE_REVOKE }).records.length, 1);
});

test('a torn last line is skipped and counted, and earlier records survive', (t) => {
  const { file, log } = makeLog(t);
  log.append(AUDIT_EVENTS.TUNNEL_OPEN, { deviceId: 'ok-1' });
  log.append(AUDIT_EVENTS.TUNNEL_CLOSE, { deviceId: 'ok-2' });
  fs.appendFileSync(file, '{"at":"2026-01-01T00:00:00.000Z","event":"tunnel.op');

  const { records, skipped } = log.read();
  assert.equal(skipped, 1);
  assert.deepEqual(records.map((record) => record.deviceId), ['ok-1', 'ok-2']);
  assert.equal(log.count(), 2);
});

test('a missing log file reads as empty instead of throwing', (t) => {
  const file = path.join(tempDir(t), 'never-written.jsonl');
  const log = new AuditLog(file);
  assert.deepEqual(log.read(), { records: [], skipped: 0 });
  assert.equal(log.count(), 0);
});

test('the disabled log records nothing on disk but still returns the record', (t) => {
  const file = path.join(tempDir(t), 'audit.jsonl');
  const log = new AuditLog(file, { disabled: true });
  const record = log.append(AUDIT_EVENTS.START, { port: 1 });
  assert.equal(record.event, AUDIT_EVENTS.START);
  assert.equal(fs.existsSync(file), false);
  assert.equal(log.read().records.length, 0);
});

test('every declared event name is accepted (the enum and the writer agree)', (t) => {
  const { log } = makeLog(t);
  for (const event of Object.values(AUDIT_EVENTS)) log.append(event, {});
  assert.equal(log.count(), Object.values(AUDIT_EVENTS).length);
});
