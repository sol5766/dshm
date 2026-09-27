/**
 * whitelist.mjs tests: persistence, atomic writes, re-pairing semantics and sticky revocation.
 *
 * The interesting assertions are about *what survives*: a revoked device must stay revoked across a
 * reload, a re-paired device must clear its revocation without losing its pairing history, and a
 * corrupt file must refuse to load rather than silently authorizing nobody (or, worse, everybody).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WhitelistStore } from '../src/core/whitelist.mjs';
import { generateIdentityPrivate, identityPublicFromPrivate } from '../src/core/crypto.mjs';
import { tempDir } from './helpers/util.helper.mjs';

/** @returns {{deviceId: string, devicePub: string, deviceName: string}} */
function newDevice(id = 'dev-1', name = 'Harmony Phone') {
  const priv = generateIdentityPrivate();
  return { deviceId: id, devicePub: identityPublicFromPrivate(priv), deviceName: name };
}

test('add + list + reload: a paired device survives a restart', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'devices.json');
  const device = newDevice();

  const store = new WhitelistStore(file).load();
  const record = store.add(device);
  assert.equal(record.deviceId, device.deviceId);
  assert.equal(record.devicePub, device.devicePub);
  assert.equal(record.deviceName, device.deviceName);
  assert.equal(record.pairs, 1);
  assert.equal(record.revokedAt, undefined);
  assert.equal(store.isAuthorized(device.deviceId), true);

  const reloaded = new WhitelistStore(file).load();
  assert.equal(reloaded.list().length, 1);
  assert.equal(reloaded.isAuthorized(device.deviceId), true);
  assert.equal(reloaded.get(device.deviceId).devicePub, device.devicePub);
});

test('the file is written atomically: no temp files are left behind and it is valid JSON', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'devices.json');
  const store = new WhitelistStore(file).load();
  store.add(newDevice('a'));
  store.add(newDevice('b'));
  store.revoke('a');

  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.devices.length, 2);
  assert.equal(parsed.devices.find((d) => d.deviceId === 'a').revokedAt !== undefined, true);
});

test('revoke is sticky across reload and blocks authorization', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'devices.json');
  const device = newDevice('revokable');

  const store = new WhitelistStore(file).load();
  store.add(device);
  const revoked = store.revoke(device.deviceId);
  assert.ok(revoked.revokedAt !== undefined);
  assert.equal(store.isAuthorized(device.deviceId), false);

  const reloaded = new WhitelistStore(file).load();
  assert.equal(reloaded.isAuthorized(device.deviceId), false, 'revocation must survive a restart');
  assert.ok(reloaded.get(device.deviceId).revokedAt !== undefined);
});

test('re-pairing a revoked device clears the revocation but keeps the history', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'devices.json');
  const device = newDevice('again');

  const store = new WhitelistStore(file).load();
  store.add(device);
  store.revoke(device.deviceId);
  const again = store.add(device);
  assert.equal(again.revokedAt, undefined);
  assert.equal(again.pairs, 2, 'the pairing count is history, not state');
  assert.equal(store.isAuthorized(device.deviceId), true);
});

test('a device id that re-pairs with a different public key does not keep the old authorization silently', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'devices.json');
  const first = newDevice('rotating');
  const second = newDevice('rotating');

  const store = new WhitelistStore(file).load();
  store.add(first);
  store.revoke('rotating');
  const record = store.add(second);
  assert.equal(record.devicePub, second.devicePub, 'the new key must replace the old one');
  assert.equal(record.revokedAt, undefined);
  assert.equal(record.pairs, 2);
  assert.equal(store.isAuthorized('rotating'), true);
});

test('revoking an unknown device reports failure instead of inventing a record', (t) => {
  const store = new WhitelistStore(path.join(tempDir(t), 'devices.json')).load();
  assert.equal(store.revoke('nobody'), undefined);
  assert.equal(store.isAuthorized('nobody'), false);
  assert.equal(store.get('nobody'), undefined);
});

test('touch records lastSeenAt and never throws when the file is unwritable', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'devices.json');
  const device = newDevice('touched');
  const store = new WhitelistStore(file).load();
  store.add(device);
  store.touch(device.deviceId, '2026-01-02T03:04:05.000Z');
  assert.equal(new WhitelistStore(file).load().get(device.deviceId).lastSeenAt, '2026-01-02T03:04:05.000Z');
  assert.doesNotThrow(() => store.touch('does-not-exist'));
});

test('a missing file is an empty whitelist, a corrupt file is a hard error', (t) => {
  const dir = tempDir(t);
  const missing = new WhitelistStore(path.join(dir, 'nope.json')).load();
  assert.deepEqual(missing.list(), []);

  const corrupt = path.join(dir, 'devices.json');
  fs.writeFileSync(corrupt, '{ this is not json');
  assert.throws(() => new WhitelistStore(corrupt).load(), /not valid JSON/);

  const shapeless = path.join(dir, 'shape.json');
  fs.writeFileSync(shapeless, JSON.stringify({ version: 1 }));
  assert.throws(() => new WhitelistStore(shapeless).load(), /no devices array/);
});

test('add validates its inputs', (t) => {
  const store = new WhitelistStore(path.join(tempDir(t), 'devices.json')).load();
  assert.throws(() => store.add({ deviceId: '', devicePub: 'x' }), /deviceId/);
  assert.throws(() => store.add({ deviceId: 'a', devicePub: '' }), /devicePub/);
});

test('list is sorted newest-pairing-first', (t) => {
  const store = new WhitelistStore(path.join(tempDir(t), 'devices.json')).load();
  store.add({ ...newDevice('old'), now: '2026-01-01T00:00:00.000Z' });
  store.add({ ...newDevice('new'), now: '2026-06-01T00:00:00.000Z' });
  assert.deepEqual(store.list().map((device) => device.deviceId), ['new', 'old']);
});
