/**
 * crypto.mjs tests: key agreement, key schedule, seal/open round trips, tamper detection and the
 * replay guard.
 *
 * These are the assertions the whole L1 security claim reduces to, so each one is written to fail
 * loudly if the property is only *approximately* true (e.g. a replay that changes one byte, a frame
 * reflected back at its sender, a nonce reused across two frames).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SealedChannel,
  SealedError,
  agree,
  b64u,
  constantTimeEqual,
  deriveSessionKeys,
  generateIdentityPrivate,
  identityPublicFromPrivate,
  randomToken,
  sessionIdFrom,
  unb64u,
} from '../src/core/crypto.mjs';

/** Build two channels that share a session, as the tunnel does. */
function pairedChannels() {
  const serverPriv = generateIdentityPrivate();
  const serverPub = identityPublicFromPrivate(serverPriv);
  const devicePriv = generateIdentityPrivate();
  const devicePub = identityPublicFromPrivate(devicePriv);

  const sharedServer = agree(serverPriv, devicePub);
  const sharedDevice = agree(devicePriv, serverPub);
  assert.deepEqual(sharedServer, sharedDevice, 'X25519 must agree in both directions');

  const serverKeys = deriveSessionKeys(sharedServer, serverPub, devicePub);
  const deviceKeys = deriveSessionKeys(sharedDevice, serverPub, devicePub);
  assert.deepEqual(serverKeys.kEnc, deviceKeys.kEnc, 'kEnc must match');
  assert.deepEqual(serverKeys.kMac, deviceKeys.kMac, 'kMac must match');
  assert.notDeepEqual(serverKeys.kEnc, serverKeys.kMac, 'kEnc and kMac must be different keys');

  const server = new SealedChannel(serverKeys.kEnc, serverKeys.kMac, serverKeys.saltHash, 's2c');
  const device = new SealedChannel(deviceKeys.kEnc, deviceKeys.kMac, deviceKeys.saltHash, 'c2s');
  const serverNonce = Buffer.from(randomToken(16), 'base64');
  const deviceNonce = Buffer.from(randomToken(16), 'base64');
  server.setOwnNoncePrefix(serverNonce.subarray(0, 3));
  server.setPeerNoncePrefix(deviceNonce.subarray(0, 3));
  device.setOwnNoncePrefix(deviceNonce.subarray(0, 3));
  device.setPeerNoncePrefix(serverNonce.subarray(0, 3));
  return { server, device, serverNonce, deviceNonce, serverPub, devicePub, serverKeys };
}

test('X25519 identity: public key derivable from the private half, base64url round trip', () => {
  const priv = generateIdentityPrivate();
  const pub = identityPublicFromPrivate(priv);
  assert.equal(unb64u(priv).length, 32);
  assert.equal(unb64u(pub).length, 32);
  assert.equal(priv, b64u(unb64u(priv)));
  assert.notEqual(priv, pub);
});

test('sealed channel: round trip in both directions', () => {
  const { server, device } = pairedChannels();
  const fromServer = Buffer.from('hello from hostkit');
  const fromDevice = Buffer.from('hello from the phone');

  const sealed = server.seal(fromServer);
  assert.deepEqual(device.open(sealed), fromServer);

  const sealedBack = device.seal(fromDevice);
  assert.deepEqual(server.open(sealedBack), fromDevice);
});

test('sealed channel: nonces never repeat and the counter advances', () => {
  const { server } = pairedChannels();
  const seen = new Set();
  for (let index = 0; index < 64; index += 1) {
    const frame = server.seal(Buffer.from([index]));
    const nonce = frame.subarray(0, 12).toString('hex');
    assert.equal(seen.has(nonce), false, `nonce ${nonce} reused at index ${index}`);
    seen.add(nonce);
  }
});

test('sealed channel: tampering with ciphertext, tag, nonce or AAD is rejected', () => {
  const { server, device } = pairedChannels();
  const plaintext = Buffer.from(JSON.stringify({ kind: 'ping', seq: 1 }));
  const frame = server.seal(plaintext);

  const flipCiphertext = Buffer.from(frame);
  flipCiphertext[13] ^= 0x01;
  assert.throws(() => device.open(flipCiphertext), (error) => error instanceof SealedError && error.code === 'auth');

  const flipTag = Buffer.from(frame);
  flipTag[flipTag.length - 1] ^= 0x80;
  assert.throws(() => device.open(flipTag), SealedError);

  const flipCounter = Buffer.from(frame);
  flipCounter[11] ^= 0x01; // low byte of the counter lives in the last nonce byte
  assert.throws(() => device.open(flipCounter), SealedError);

  const flipDirection = Buffer.from(frame);
  flipDirection[3] ^= 0x01; // nonce layout is prefix[0..2] || direction[3] || counter[4..11]
  assert.throws(() => device.open(flipDirection), (error) => error instanceof SealedError && error.code === 'bad-direction');

  const flipAadByte = Buffer.from(frame);
  flipAadByte[0] ^= 0x01; // nonce prefix: session mismatch, caught before the AEAD is even consulted
  assert.throws(
    () => device.open(flipAadByte),
    (error) => error instanceof SealedError && (error.code === 'bad-nonce-prefix' || error.code === 'auth'),
  );
});

test('sealed channel: a frame reflected back at its sender is rejected', () => {
  const { server } = pairedChannels();
  const frame = server.seal(Buffer.from('reflect'));
  // Same key, but the direction byte in the nonce/AAD belongs to the peer.
  assert.throws(() => server.open(frame), (error) => error instanceof SealedError && error.code === 'bad-direction');
});

test('sealed channel: replaying an accepted frame is rejected, and the session is left unusable', () => {
  const { server, device } = pairedChannels();
  const first = server.seal(Buffer.from('one'));
  const second = server.seal(Buffer.from('two'));

  assert.deepEqual(device.open(first), Buffer.from('one'));
  assert.throws(
    () => device.open(first),
    (error) => error instanceof SealedError && error.code === 'replay',
    'a byte-identical replay must be rejected',
  );
  assert.deepEqual(device.open(second), Buffer.from('two'));
});

test('sealed channel: out-of-order delivery is rejected', () => {
  const { server, device } = pairedChannels();
  const first = server.seal(Buffer.from('first'));
  const second = server.seal(Buffer.from('second'));
  // Deliver #2 first: the counter jumps, so #1 is now strictly smaller and must be refused.
  assert.deepEqual(device.open(second), Buffer.from('second'));
  assert.throws(
    () => device.open(first),
    (error) => error instanceof SealedError && error.code === 'replay',
  );
});

test('sealed channel: frames from a different session do not authenticate', () => {
  const a = pairedChannels();
  const b = pairedChannels();
  const frame = a.server.seal(Buffer.from('cross-session'));
  assert.throws(() => b.device.open(frame), SealedError);
});

test('sealed channel: refuses to operate before the nonce prefixes are negotiated', () => {
  const priv = generateIdentityPrivate();
  const pub = identityPublicFromPrivate(priv);
  const { kEnc, kMac, saltHash } = deriveSessionKeys(agree(priv, pub), pub, pub);
  const channel = new SealedChannel(kEnc, kMac, saltHash, 's2c');
  assert.throws(() => channel.seal(Buffer.from('x')), /nonce prefix/);
  assert.throws(() => channel.open(Buffer.alloc(64)), /nonce prefix/);
});

test('session id is deterministic per transcript and differs between transcripts', () => {
  const { serverKeys, serverNonce, deviceNonce } = pairedChannels();
  const first = sessionIdFrom(serverKeys.saltHash, deviceNonce, serverNonce);
  const second = sessionIdFrom(serverKeys.saltHash, deviceNonce, serverNonce);
  assert.equal(first, second);
  const other = sessionIdFrom(serverKeys.saltHash, deviceNonce, Buffer.from(randomToken(16), 'base64'));
  assert.notEqual(first, other);
  assert.match(first, /^[0-9a-f]{16}$/);
});

test('constantTimeEqual compares by value and is length-safe', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcdef'), false);
  assert.equal(constantTimeEqual('', ''), true);
});

test('base64url helpers tolerate padded and unpadded input', () => {
  const raw = Buffer.from([0xfb, 0xef, 0x01, 0x02, 0x03]);
  const encoded = b64u(raw);
  assert.equal(encoded.includes('+'), false);
  assert.equal(encoded.includes('/'), false);
  assert.equal(encoded.includes('='), false);
  assert.deepEqual(unb64u(encoded), raw);
  assert.deepEqual(unb64u(`${encoded}==`), raw);
  assert.deepEqual(unb64u(encoded.replace(/-/g, '+').replace(/_/g, '/')), raw);
});
