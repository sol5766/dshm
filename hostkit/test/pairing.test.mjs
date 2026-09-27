/**
 * pairing.mjs tests: the one-time pairing window.
 *
 * Pairing is the only trust-granting moment, so these tests are written around the ways it can go
 * wrong: a token that is accepted twice, a window that outlives its expiry, a second device joining the
 * same window, a mismatched token being accepted, and an "always listening" pairing endpoint existing
 * when the user did not ask for one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PAIR_REJECT, PairingService } from '../src/core/pairing.mjs';
import { manualCodeFrom } from '../src/server.mjs';
import { unb64u } from '../src/core/crypto.mjs';

/** A controllable clock so expiry is tested without sleeping. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

test('openWindow issues a pairId, a 32-byte token and an expiry window', () => {
  const clock = fakeClock();
  const service = new PairingService({ windowMs: 120_000, now: clock.now });
  const window = service.openWindow();
  assert.match(window.pairId, /^[A-Za-z0-9_-]+$/);
  assert.equal(unb64u(window.pairToken).length, 32);
  assert.equal(window.expiresAt - window.createdAt, 120_000);
  assert.equal(service.isOpen, true);
});

test('a correct pairId + pairToken is accepted exactly once', () => {
  const clock = fakeClock();
  const service = new PairingService({ now: clock.now });
  const window = service.openWindow();
  const body = { pairId: window.pairId, pairToken: window.pairToken, deviceId: 'phone-1', devicePub: 'PUB' };

  const first = service.consume(body);
  assert.equal(first.ok, true);
  assert.ok(first.window.consumedAt !== undefined);

  const replay = service.consume(body);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, PAIR_REJECT.CONSUMED, 'a byte-identical replay must be refused');
  assert.equal(service.isOpen, false, 'the window is burned on success');
});

test('the same window cannot be used by a second device', () => {
  const clock = fakeClock();
  const service = new PairingService({ now: clock.now });
  const window = service.openWindow();
  assert.equal(service.consume({ pairId: window.pairId, pairToken: window.pairToken, deviceId: 'a', devicePub: 'PA' }).ok, true);
  const second = service.consume({ pairId: window.pairId, pairToken: window.pairToken, deviceId: 'b', devicePub: 'PB' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, PAIR_REJECT.CONSUMED);
});

test('an expired window is refused', () => {
  const clock = fakeClock();
  const service = new PairingService({ windowMs: 1000, now: clock.now });
  const window = service.openWindow();
  clock.advance(1001);
  const result = service.consume({ pairId: window.pairId, pairToken: window.pairToken, deviceId: 'late', devicePub: 'P' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, PAIR_REJECT.EXPIRED);
  assert.equal(service.isOpen, false);
});

test('a wrong token is refused and does not burn the window', () => {
  const clock = fakeClock();
  const service = new PairingService({ now: clock.now });
  const window = service.openWindow();
  const wrong = service.consume({ pairId: window.pairId, pairToken: `${window.pairToken}x`, deviceId: 'attacker', devicePub: 'P' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, PAIR_REJECT.TOKEN_MISMATCH);
  // The legitimate device can still pair -a wrong guess must not be a denial of service.
  assert.equal(service.consume({ pairId: window.pairId, pairToken: window.pairToken, deviceId: 'real', devicePub: 'P' }).ok, true);
});

test('an unknown pairId is refused, and "no window" is distinguished from "wrong window"', () => {
  const clock = fakeClock();
  const service = new PairingService({ now: clock.now });
  assert.equal(service.consume({ pairId: 'nope', pairToken: 'nope', deviceId: 'd', devicePub: 'p' }).reason, PAIR_REJECT.NO_WINDOW);

  const window = service.openWindow();
  assert.equal(service.consume({ pairId: 'other', pairToken: window.pairToken, deviceId: 'd', devicePub: 'p' }).reason, PAIR_REJECT.UNKNOWN_PAIR_ID);
});

test('malformed bodies are refused before any lookup', () => {
  const service = new PairingService();
  service.openWindow();
  for (const body of [
    {},
    { pairId: 'x' },
    { pairId: 'x', pairToken: 'y' },
    { pairId: 'x', pairToken: 'y', deviceId: '', devicePub: 'p' },
    { pairId: 'x', pairToken: 'y', deviceId: 'd', devicePub: '' },
    { pairId: 1, pairToken: 2, deviceId: 'd', devicePub: 'p' },
  ]) {
    const result = service.consume(body);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(body)}`);
    assert.equal(result.reason, PAIR_REJECT.BAD_REQUEST);
  }
});

test('opening a new window supersedes the previous one', () => {
  const service = new PairingService();
  const first = service.openWindow();
  const second = service.openWindow();
  assert.notEqual(first.pairId, second.pairId);
  assert.equal(service.windows.size, 1);
  assert.equal(service.consume({ pairId: first.pairId, pairToken: first.pairToken, deviceId: 'd', devicePub: 'p' }).ok, false);
  assert.equal(service.consume({ pairId: second.pairId, pairToken: second.pairToken, deviceId: 'd', devicePub: 'p' }).ok, true);
});

test('closeWindow removes the window so pairing stops immediately', () => {
  const service = new PairingService();
  const window = service.openWindow();
  service.closeWindow('user-cancelled');
  assert.equal(service.isOpen, false);
  const result = service.consume({ pairId: window.pairId, pairToken: window.pairToken, deviceId: 'd', devicePub: 'p' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, PAIR_REJECT.NO_WINDOW);
});

test('events are emitted for open/consume/close so the server can audit them', () => {
  const service = new PairingService();
  /** @type {string[]} */
  const events = [];
  service.onEvent = (event) => events.push(event.type);
  const window = service.openWindow();
  service.consume({ pairId: window.pairId, pairToken: window.pairToken, deviceId: 'd', devicePub: 'p' });
  assert.deepEqual(events, ['open', 'consume', 'close']);
});

test('the dshkit:// URI round-trips every field the client needs', () => {
  const service = new PairingService();
  const window = service.openWindow();
  const payload = PairingService.payload({
    name: 'desk-pc',
    host: '192.168.1.20',
    port: 8798,
    hostkitPub: 'PUBKEY',
    pairId: window.pairId,
    pairToken: window.pairToken,
    expiresAt: window.expiresAt,
    tls: true,
  });
  const uri = PairingService.toUri(payload);
  assert.match(uri, /^dshkit:\/\/pair\?/);
  assert.deepEqual(PairingService.fromUri(uri), payload);
  // The parser must reject anything that is not our action, rather than guessing.
  assert.throws(() => PairingService.fromUri('https://example.com'), /not a dshkit/);
  assert.throws(() => PairingService.fromUri('dshkit://other?x=1'), /unknown dshkit action/);
  assert.throws(() => PairingService.fromUri('dshkit://pair?v=1'), /missing/);
});

test('the manual code is a stable 6-digit derivation of the token', () => {
  const service = new PairingService();
  const window = service.openWindow();
  const code = manualCodeFrom(window.pairToken);
  assert.match(code, /^\d{6}$/);
  assert.equal(manualCodeFrom(window.pairToken), code);
  assert.notEqual(manualCodeFrom(`${window.pairToken}x`), code);
});
