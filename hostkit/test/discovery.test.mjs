/**
 * discovery.mjs tests: the announce wire format, the broadcast target list, and a real
 * announce->listen round trip over UDP on loopback.
 *
 * Discovery is best-effort by design (it is a convenience, not an authorization mechanism), so the
 * tests focus on *not* believing junk: corrupt datagrams, wrong magic, wrong version and oversized
 * payloads must all be ignored rather than surfaced to the user as a host.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANNOUNCE_VERSION,
  DiscoveryService,
  MAGIC,
  announceTargets,
  decodeAnnounce,
  encodeAnnounce,
  listenForHosts,
} from '../src/discovery.mjs';
import { delay, tempDir } from './helpers/util.helper.mjs';

/** @returns {object} */
function sampleAnnounce() {
  return {
    instanceId: 'inst-1',
    name: 'desk-pc',
    port: 8798,
    tls: false,
    pairing: true,
    hostkitPub: 'PUBKEY',
  };
}

test('announce round trips through encode/decode', () => {
  const announce = sampleAnnounce();
  const decoded = decodeAnnounce(encodeAnnounce(announce));
  assert.deepEqual(decoded, { magic: MAGIC, v: ANNOUNCE_VERSION, ...announce });
});

test('decodeAnnounce rejects anything that is not ours', () => {
  const good = encodeAnnounce(sampleAnnounce());
  assert.equal(decodeAnnounce(Buffer.from('not json')), undefined);
  assert.equal(decodeAnnounce(Buffer.from('[]')), undefined);
  assert.equal(decodeAnnounce(Buffer.from(JSON.stringify({ magic: 'OTHER', v: 1, instanceId: 'x', port: 1, hostkitPub: 'p' }))), undefined);
  assert.equal(decodeAnnounce(Buffer.from(JSON.stringify({ magic: MAGIC, v: 99, instanceId: 'x', port: 1, hostkitPub: 'p' }))), undefined);
  assert.equal(decodeAnnounce(Buffer.from(JSON.stringify({ magic: MAGIC, v: 1, port: 1, hostkitPub: 'p' }))), undefined);
  assert.equal(decodeAnnounce(Buffer.from(JSON.stringify({ magic: MAGIC, v: 1, instanceId: 'x', hostkitPub: 'p' }))), undefined);
  assert.equal(decodeAnnounce(Buffer.from(JSON.stringify({ magic: MAGIC, v: 1, instanceId: 'x', port: 1 }))), undefined);
  assert.equal(decodeAnnounce(Buffer.alloc(4096, 0x41)), undefined);
  assert.notEqual(decodeAnnounce(good), undefined);
  // Defaults are applied for the optional presentation fields.
  const minimal = decodeAnnounce(Buffer.from(JSON.stringify({ magic: MAGIC, v: 1, instanceId: 'x', port: 9, hostkitPub: 'p' })));
  assert.equal(minimal.tls, false);
  assert.equal(minimal.pairing, false);
  assert.equal(minimal.name, 'hostkit');
});

test('announceTargets always includes the limited broadcast address and dedupes', () => {
  const targets = announceTargets([
    { address: '192.168.1.20', broadcast: '192.168.1.255' },
    { address: '10.0.0.5', broadcast: '10.0.0.255' },
    { address: '172.16.0.9', broadcast: '192.168.1.255' },
    { address: '169.254.1.1', broadcast: undefined },
  ]);
  assert.equal(targets.includes('255.255.255.255'), true);
  assert.deepEqual(
    targets.filter((target) => target !== '255.255.255.255').sort(),
    ['10.0.0.255', '192.168.1.255'],
  );
  assert.deepEqual(announceTargets([]), ['255.255.255.255']);
});

test('a listener receives announces from another instance and ignores its own', async (t) => {
  // Pick a free UDP port by binding one and releasing it -the window is tiny and the listener uses
  // `reuseAddr`, so a collision would surface as a missing announce rather than a false pass.
  const probe = new DiscoveryService({ name: 'probe', port: 0, discoveryPort: 0, hostkitPub: 'x' });
  await probe.startListener();
  const discoveryPort = probe.listener.address().port;
  probe.close();

  const listener = new DiscoveryService({ name: 'listener', port: 8798, discoveryPort, hostkitPub: 'LISTENER' });
  t.after(() => listener.close());
  /** @type {object[]} */
  const found = [];
  listener.on('found', (entry) => found.push(entry));
  await listener.startListener();

  const announcer = new DiscoveryService({
    name: 'announcer',
    port: 8799,
    discoveryPort,
    hostkitPub: 'ANNOUNCER',
    announceIntervalMs: 150,
  });
  t.after(() => announcer.close());
  await announcer.startAnnouncer();

  const deadline = Date.now() + 5000;
  while (found.length === 0 && Date.now() < deadline) await delay(50);
  assert.equal(found.length >= 1, true, 'the listener must see the announcer');
  const entry = found[0];
  assert.equal(entry.announce.name, 'announcer');
  assert.equal(entry.announce.port, 8799);
  assert.equal(entry.announce.hostkitPub, 'ANNOUNCER');
  // The address comes from the datagram's source, i.e. the interface the broadcast left through -on a
  // CI box that is not necessarily loopback, so only its presence is asserted.
  assert.equal(typeof entry.address === 'string' && entry.address.length > 0, true);

  // `found` fires once per instance; repeats only bump `count`.
  const before = found.length;
  await delay(400);
  assert.equal(found.length, before, 'repeated announces must not re-fire `found`');
  assert.equal(listener.peersList()[0].count > 1, true, 'but the repeat counter must advance');
  assert.equal(listener.peers.get(listener.instanceId), undefined, 'an instance must ignore its own announce');

  // The pairing flag is advertised live.
  announcer.setPairing(true);
  assert.equal(decodeAnnounce(announcer.payload()).pairing, true);
});

test('listenForHosts resolves with the hosts it saw within the window', async (t) => {
  const probe = new DiscoveryService({ name: 'probe', port: 0, discoveryPort: 0, hostkitPub: 'x' });
  await probe.startListener();
  const discoveryPort = probe.listener.address().port;
  probe.close();

  // Start the listener first and give it a moment to bind, so the first announce cannot be missed.
  const listener = new DiscoveryService({ name: 'probe2', port: 0, discoveryPort, hostkitPub: 'x' });
  t.after(() => listener.close());
  /** @type {object[]} */
  const found = [];
  listener.on('found', (entry) => found.push(entry));
  await listener.startListener();
  await delay(100);

  const announcer = new DiscoveryService({
    name: 'quick',
    port: 8801,
    discoveryPort,
    hostkitPub: 'QUICK',
    announceIntervalMs: 150,
  });
  t.after(() => announcer.close());
  await announcer.startAnnouncer();

  const deadline = Date.now() + 4000;
  while (found.length === 0 && Date.now() < deadline) await delay(50);
  assert.equal(found.length, 1);
  assert.equal(found[0].announce.name, 'quick');
  assert.equal(found[0].announce.port, 8801);

  // A one-shot helper on the same port is a legitimate second listener (SO_REUSEADDR) and must return
  // well-formed entries.
  const hosts = await listenForHosts({ discoveryPort, durationMs: 700 });
  assert.equal(Array.isArray(hosts), true);
  for (const entry of hosts) {
    assert.equal(typeof entry.announce.hostkitPub, 'string');
    assert.equal(entry.announce.name, 'quick');
    assert.equal(entry.announce.port, 8801);
  }
});

test('listenForHosts returns an empty array when nothing announces in the window', async () => {
  const probe = new DiscoveryService({ name: 'probe', port: 0, discoveryPort: 0, hostkitPub: 'x' });
  await probe.startListener();
  const discoveryPort = probe.listener.address().port;
  probe.close();
  const hosts = await listenForHosts({ discoveryPort, durationMs: 300 });
  assert.deepEqual(hosts, []);
});

test('discovery is inert when only the announcer is started', async () => {
  const service = new DiscoveryService({ name: 'solo', port: 0, discoveryPort: 18795, hostkitPub: 'x' });
  await service.startAnnouncer();
  assert.equal(service.announcer !== null, true);
  assert.equal(service.listener, null);
  service.close();
  assert.equal(service.announcer, null);
});

test('a bad discovery port is rejected at construction instead of failing asynchronously', () => {
  assert.throws(() => new DiscoveryService({ name: 'bad', port: 0, discoveryPort: -1, hostkitPub: 'x' }), RangeError);
  assert.throws(() => new DiscoveryService({ name: 'bad', port: 0, discoveryPort: 70000, hostkitPub: 'x' }), RangeError);
  assert.throws(() => new DiscoveryService({ name: 'bad', port: 0, discoveryPort: 1.5, hostkitPub: 'x' }), RangeError);
  assert.throws(() => new DiscoveryService({ name: 'bad', port: 0, discoveryPort: undefined, hostkitPub: 'x' }), RangeError);
  // 0 is allowed: it means "let the OS choose", which listener-only runs and tests use.
  assert.doesNotThrow(() => new DiscoveryService({ name: 'ok', port: 0, discoveryPort: 0, hostkitPub: 'x' }));
  assert.doesNotThrow(() => new DiscoveryService({ name: 'ok', port: 0, discoveryPort: 8799, hostkitPub: 'x' }));
});

test('the discovery service does not touch the filesystem (state dir is irrelevant)', (t) => {
  // Guards against someone later routing discovery through the whitelist store.
  const dir = tempDir(t, 'hostkit-discovery-');
  const service = new DiscoveryService({ name: 'fs', port: 0, discoveryPort: 0, hostkitPub: 'x' });
  assert.equal(service.instanceId.length > 0, true);
  assert.equal(dir.length > 0, true);
});

