/**
 * frames.mjs tests: length-prefixed framing, the JSON envelope contract, and the body/header helpers.
 *
 * The framing layer sits directly on top of untrusted input, so the tests focus on the *rejections*:
 * short frames, oversized declarations, unknown kinds, malformed headers and non-integer sequence
 * numbers. A frame layer that accepts junk becomes a memory-exhaustion vector.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME_HEADER_BYTES,
  FrameError,
  FrameSplitter,
  KIND,
  MAX_FRAME_BYTES,
  decodeBodyField,
  decodeEnvelope,
  encodeEnvelope,
  encodeFrame,
  errorResponse,
  httpRequest,
  httpResponse,
  isBinaryData,
  normalizeHeaders,
  wsClose,
  wsData,
} from '../src/core/frames.mjs';
import { b64, unb64 } from '../src/core/crypto.mjs';

test('frame: header is a uint32be length followed by the payload', () => {
  const payload = Buffer.from('sealed-bytes');
  const framed = encodeFrame(payload);
  assert.equal(framed.length, FRAME_HEADER_BYTES + payload.length);
  assert.equal(framed.readUInt32BE(0), payload.length);
  assert.deepEqual(framed.subarray(FRAME_HEADER_BYTES), payload);
});

test('frame: an empty or oversized payload is refused at encode time', () => {
  assert.throws(() => encodeFrame(Buffer.alloc(0)), FrameError);
  assert.throws(() => encodeFrame(Buffer.alloc(MAX_FRAME_BYTES + 1)), FrameError);
});

test('splitter: reassembles frames across arbitrary chunk boundaries', () => {
  const frames = [Buffer.from('a'), Buffer.from('b'.repeat(300)), Buffer.from('c'.repeat(70_000))];
  const stream = Buffer.concat(frames.map((frame) => encodeFrame(frame)));
  const splitter = new FrameSplitter();

  const collected = [];
  for (let offset = 0; offset < stream.length; offset += 7) {
    collected.push(...splitter.push(stream.subarray(offset, Math.min(stream.length, offset + 7))));
  }
  assert.equal(collected.length, 3);
  assert.deepEqual(collected, frames);
  assert.equal(splitter.pending, 0);
});

test('splitter: a declared length above the cap is rejected immediately', () => {
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
  const splitter = new FrameSplitter();
  assert.throws(() => splitter.push(header), (error) => error instanceof FrameError && error.code === 'frame-size');

  const zero = Buffer.alloc(FRAME_HEADER_BYTES);
  assert.throws(() => new FrameSplitter().push(zero), FrameError);
});

test('envelope: round trip preserves every documented kind', () => {
  const envelopes = [
    httpRequest('1', 'POST', '/api/session/list', { 'content-type': 'application/json' }, Buffer.from('{"a":1}')),
    httpResponse('1', 200, { 'set-cookie': ['a=1', 'b=2'] }, Buffer.from('{"ok":true}')),
    errorResponse('1', 'too-large', 'body too big'),
    { kind: KIND.WS_OPEN, id: '2', path: '/api/remote.mux' },
    { kind: KIND.WS_OPEN_RES, id: '2', ok: true },
    wsData('2', b64(Buffer.from('chunk')), true),
    wsData('2', b64(Buffer.from('text')), false),
    wsClose('2', 1000, 'done'),
    { kind: KIND.PING, seq: 7 },
    { kind: KIND.PONG },
    { kind: KIND.ERROR, code: 'x', message: 'y' },
  ];
  for (const envelope of envelopes) {
    assert.deepEqual(decodeEnvelope(encodeEnvelope(envelope)), envelope);
  }
});

test('envelope: rejects non-JSON, non-objects, unknown kinds and bad seq', () => {
  assert.throws(() => decodeEnvelope(Buffer.from('not json')), (error) => error instanceof FrameError && error.code === 'envelope-json');
  assert.throws(() => decodeEnvelope(Buffer.from('[1,2]')), (error) => error.code === 'envelope-shape');
  assert.throws(() => decodeEnvelope(Buffer.from('"text"')), (error) => error.code === 'envelope-shape');
  assert.throws(() => decodeEnvelope(encodeEnvelope({ kind: 'newer-protocol' })), (error) => error.code === 'envelope-kind');
  assert.throws(() => decodeEnvelope(encodeEnvelope({ kind: KIND.PING, seq: -1 })), (error) => error.code === 'envelope-seq');
  assert.throws(() => decodeEnvelope(encodeEnvelope({ kind: KIND.PING, seq: 1.5 })), (error) => error.code === 'envelope-seq');
});

test('httpRequest encodes the body as base64 and tolerates an absent body', () => {
  const withBody = httpRequest('id', 'POST', '/api/x', {}, Buffer.from([0, 255, 16]));
  assert.equal(withBody.bodyB64, Buffer.from([0, 255, 16]).toString('base64'));
  assert.deepEqual(decodeBodyField(withBody.bodyB64), Buffer.from([0, 255, 16]));
  assert.deepEqual(httpRequest('id', 'GET', '/', {}).bodyB64, '');
  assert.deepEqual(decodeBodyField(httpRequest('id', 'GET', '/', {}).bodyB64), Buffer.alloc(0));
  assert.deepEqual(decodeBodyField(undefined), Buffer.alloc(0));
  assert.throws(() => decodeBodyField({ not: 'a string' }), FrameError);
});

test('httpResponse keeps array-valued headers (set-cookie) intact', () => {
  const response = httpResponse('id', 200, { 'set-cookie': ['a=1', 'b=2'] }, Buffer.from('x'));
  const decoded = decodeEnvelope(encodeEnvelope(response));
  assert.deepEqual(decoded.headers['set-cookie'], ['a=1', 'b=2']);
  assert.deepEqual(unb64(decoded.bodyB64), Buffer.from('x'));
});

test('normalizeHeaders lower-cases names, stringifies scalars and drops non-representable values', () => {
  const headers = normalizeHeaders({
    'Content-Type': 'application/json',
    'X-Retry': 3,
    'X-Flag': true,
    'X-List': [1, 2],
    'X-Object': { nested: true },
  });
  assert.deepEqual(headers, {
    'content-type': 'application/json',
    'x-retry': '3',
    'x-flag': 'true',
    'x-list': ['1', '2'],
  });
  assert.deepEqual(normalizeHeaders(undefined), {});
  assert.throws(() => normalizeHeaders('nope'), (error) => error.code === 'headers-type');
});

test('isBinaryData defaults to binary and honours the explicit text flag', () => {
  assert.equal(isBinaryData(wsData('1', 'AAAA', true)), true);
  assert.equal(isBinaryData(wsData('1', 'AAAA', false)), false);
  assert.equal(isBinaryData({ kind: KIND.WS_DATA, id: '1', dataB64: 'AAAA' }), true);
});
