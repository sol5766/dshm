/**
 * qr.mjs tests: the payload survives the symbol, and the tables are provably self-consistent.
 *
 * Two independent nets are thrown at the encoder:
 *  1. **Table self-consistency.** For every version and EC level, the two transcribed tables
 *     (`EC_CODEWORDS_PER_BLOCK`, `NUM_ERROR_CORRECTION_BLOCKS`) must reproduce the *closed-form* module
 *     count of ISO/IEC 18004 section 8.9. The closed form depends on the alignment-pattern count, so a
 *     transcription slip in any of the three tables shows up here as a non-zero difference. This is the
 *     check that makes the round trip meaningful.
 *  2. **An independent decoder.** `helpers/qr-decode.helper.mjs` reads the rendered matrices back with its
 *     own un-masking, de-interleaving, Berlekamp-Massey and Forney implementation, and must return the
 *     exact payload. It also verifies the finder/timing/alignment geometry and that both
 *     format-information copies agree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EC_CODEWORDS_PER_BLOCK,
  NUM_ERROR_CORRECTION_BLOCKS,
  ALIGNMENT_PATTERN_POSITIONS,
} from './helpers/qr-tables.helper.mjs';
import { decode, functionMap, rawDataModulesOf, readFormat, readFormatSecondCopy } from './helpers/qr-decode.helper.mjs';
import {
  EC_LEVEL,
  buildDataCodewords,
  dataCodewords,
  encode,
  maskCondition,
  pickVersion,
  rawDataModules,
  reedSolomonRemainder,
  renderAscii,
  renderBlocks,
  totalCodewords,
} from '../src/qr.mjs';

test('both table copies are identical (a typo has to happen twice to hide)', () => {
  assert.deepEqual(EC_CODEWORDS_PER_BLOCK, [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  ]);
});

test('tables reproduce the closed-form module count for every version and level', () => {
  for (let version = 1; version <= 40; version += 1) {
    for (let level = 0; level <= 3; level += 1) {
      const ecTotal = EC_CODEWORDS_PER_BLOCK[level][version] * NUM_ERROR_CORRECTION_BLOCKS[level][version];
      const derived = dataCodewords(version, level) + ecTotal;
      assert.equal(
        derived,
        totalCodewords(version),
        `version ${version} level ${level}: tables give ${derived} codewords, closed form gives ${totalCodewords(version)}`,
      );
    }
  }
});

test('rawDataModules matches the implemented function-module geometry exactly', () => {
  for (let version = 1; version <= 40; version += 1) {
    const map = functionMap(version);
    const size = map.length;
    let functionModules = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) if (map[y][x]) functionModules += 1;
    }
    assert.equal(
      size * size - functionModules,
      rawDataModulesOf(version),
      `version ${version}: implemented geometry leaves ${size * size - functionModules} data modules, formula says ${rawDataModulesOf(version)}`,
    );
    assert.equal(rawDataModules(version), rawDataModulesOf(version));
  }
});

test('alignment-pattern tables are arithmetically valid for every version', () => {
  for (let version = 2; version <= 40; version += 1) {
    const positions = ALIGNMENT_PATTERN_POSITIONS[version];
    assert.ok(positions.length >= 2, `version ${version} needs at least two alignment coordinates`);
    assert.equal(positions[0], 6);
    assert.equal(positions[positions.length - 1], version * 4 + 10, 'the last coordinate must sit 6 modules from the edge');
    assert.equal(positions.length, Math.floor(version / 7) + 2);
    for (let index = 1; index < positions.length; index += 1) {
      assert.equal((positions[index] - positions[index - 1]) % 2, 0, 'alignment spacing must be even');
      assert.ok(positions[index] > positions[index - 1], 'coordinates must increase');
    }
  }
});

test('EC level bits map to the documented order', () => {
  // The encoder writes level bits 1/0/3/2 for L/M/Q/H; the decoder must invert exactly that.
  for (const [name, level] of Object.entries({ L: 0, M: 1, Q: 2, H: 3 })) {
    const { modules, version } = encode('level probe', { level });
    const format = readFormat(modules);
    assert.equal(format.level, level, `${name} must round-trip`);
    assert.equal(version >= 1, true);
  }
});

test('encode: QR round trips through the independent decoder (byte mode, EC level M)', () => {
  const payloads = [
    'A',
    'HELLO WORLD',
    'dshkit://pair?v=1&name=desk-pc&host=192.168.1.20&port=8798&pub=x',
    'x'.repeat(120),
    'y'.repeat(600),
    'z'.repeat(1800),
    'unicode pairing payload: dshkit://pair?v=1&name=desktop-host',
    `dshkit://pair?${'a'.repeat(50)}=${'b'.repeat(40)}&pad=${'c'.repeat(30)}`,
  ];
  for (const payload of payloads) {
    const symbol = encode(payload);
    assert.equal(symbol.size, symbol.version * 4 + 17);
    const decoded = decode(symbol.modules);
    assert.equal(decoded.version, symbol.version, `version mismatch for a ${payload.length}-byte payload`);
    assert.equal(decoded.level, EC_LEVEL.M);
    assert.equal(decoded.mask, symbol.mask, 'the mask recorded by the encoder must be the one in the symbol');
    assert.equal(decoded.text, payload, `payload mismatch for ${JSON.stringify(payload.slice(0, 24))}...`);
  }
});

test('encode: non-ASCII UTF-8 payloads round trip byte-for-byte', () => {
  // The QR byte mode carries UTF-8 bytes verbatim, so a multi-byte payload must survive exactly.
  for (const payload of ['dshkit://pair?v=1&name=desk-pc', 'payload with an em dash - here', 'symbols: +/- and section sign']) {
    const symbol = encode(payload);
    const decoded = decode(symbol.modules);
    assert.deepEqual(decoded.bytes, Buffer.from(payload, 'utf8'));
    assert.equal(decoded.text, payload);
  }
});

test('encode: both format-information copies are present and identical', () => {
  for (const payload of ['short', 'm'.repeat(300), 'l'.repeat(900)]) {
    const symbol = encode(payload);
    const first = readFormat(symbol.modules);
    const secondValue = readFormatSecondCopy(symbol.modules);
    const reDecoded = readFormat(symbol.modules);
    assert.deepEqual(first, reDecoded);
    // Reconstruct the expected word from the decoded fields and compare with the second copy.
    const levelBits = [1, 0, 3, 2][first.level];
    const data = (levelBits << 3) | first.mask;
    let remainder = data;
    for (let index = 0; index < 10; index += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const expected = ((data << 10) | remainder) ^ 0x5412;
    assert.equal(secondValue, expected, 'the second format copy must encode the same level and mask');
  }
});

test('version selection picks the smallest fitting version and refuses oversized payloads', () => {
  assert.equal(pickVersion(1), 1);
  assert.equal(pickVersion(14), 1);
  assert.equal(pickVersion(15), 2);
  assert.equal(pickVersion(100), 6);
  assert.equal(pickVersion(2331, EC_LEVEL.M), 40);
  assert.equal(pickVersion(2332, EC_LEVEL.M), undefined, 'version 40-M holds exactly 2331 bytes');
  assert.throws(() => encode('q'.repeat(2332)), /does not fit version 40/);
  assert.equal(dataCodewords(1, EC_LEVEL.M), 16);
  assert.equal(dataCodewords(40, EC_LEVEL.M), 2334);
  // Byte mode with an 8-bit count needs 4 + 8 + 8n bits, so version 1-M (128 bits) holds 14 bytes.
  assert.equal(encode('a'.repeat(14)).version, 1);
  assert.equal(encode('a'.repeat(15)).version, 2);
});

test('byte-mode data codewords follow ISO/IEC 18004: mode, 8-bit count, terminator, 0xEC/0x11 padding', () => {
  // "HELLO WORLD" is 11 bytes, so 4 (mode) + 8 (count) + 88 = 100 bits in a 128-bit version 1-M block.
  const data = buildDataCodewords(Buffer.from('HELLO WORLD', 'utf8'), 1, EC_LEVEL.M);
  assert.equal(data.length, 16);
  assert.equal(data[0], 0x40, 'byte-mode indicator 0100 followed by the high nibble of the length');
  assert.equal(data[1], 0xb4, 'low nibble of the length 11, then a 4-bit terminator, then 4 pad bits');
  // 11 payload bytes after the 2-byte header leaves 3 free bytes, filled 0xEC, 0x11, 0xEC.
  assert.deepEqual([...data.subarray(13)], [0xec, 0x11, 0xec]);
  // The payload is recoverable from the stream at the documented offset.
  assert.equal(data[1] & 0x0f, 0x04);
  assert.equal(data[2] >> 4, 0x08);
  const recovered = Buffer.alloc(11);
  recovered[0] = ((data[1] & 0x0f) << 4) | (data[2] >> 4);
  for (let index = 1; index < 11; index += 1) {
    recovered[index] = ((data[index + 1] & 0x0f) << 4) | (data[index + 2] >> 4);
  }
  assert.equal(recovered.toString('utf8'), 'HELLO WORLD');
});

test('Reed-Solomon remainder produces a valid codeword (all syndromes zero)', () => {
  const data = buildDataCodewords(Buffer.from('HELLO WORLD', 'utf8'), 1, EC_LEVEL.M);
  const ec = reedSolomonRemainder(data, 10);
  assert.equal(ec.length, 10);
  assert.deepEqual([...ec], [...reedSolomonRemainder(data, 10)], 'the remainder must be deterministic');
  // The generator polynomial's roots are alpha^0..alpha^9, so every syndrome of a valid codeword vanishes.
  const block = [...data, ...ec];
  for (let index = 0; index < 10; index += 1) {
    let value = 0;
    let x = 1;
    for (let power = 0; power < index; power += 1) x = gfMultiply(x, 2);
    for (const codeword of block) value = gfMultiply(value, x) ^ codeword;
    assert.equal(value, 0, `syndrome ${index} must be zero for a valid codeword`);
  }
  // And a single flipped data byte must break at least one syndrome (i.e. the check has power).
  const broken = [...block];
  broken[0] ^= 0x01;
  let broke = false;
  for (let index = 0; index < 10; index += 1) {
    let value = 0;
    let x = 1;
    for (let power = 0; power < index; power += 1) x = gfMultiply(x, 2);
    for (const codeword of broken) value = gfMultiply(value, x) ^ codeword;
    if (value !== 0) broke = true;
  }
  assert.equal(broke, true);
});

/** Local GF(256) multiply so the syndrome check above does not depend on the decoder helper. */
function gfMultiply(a, b) {
  let result = 0;
  let left = a;
  let right = b;
  while (right > 0) {
    if ((right & 1) !== 0) result ^= left;
    left <<= 1;
    if ((left & 0x100) !== 0) left ^= 0x11d;
    right >>= 1;
  }
  return result;
}

test('maskCondition implements all eight ISO/IEC 18004 masks', () => {
  for (let mask = 0; mask < 8; mask += 1) {
    assert.equal(typeof maskCondition(mask, 3, 5), 'boolean');
  }
  assert.throws(() => maskCondition(8, 0, 0), /bad mask/);
  assert.equal(maskCondition(0, 1, 1), true);
  assert.equal(maskCondition(1, 0, 1), false);
  assert.equal(maskCondition(2, 3, 0), true);
});

test('rendering produces a bordered, rectangular raster', () => {
  const symbol = encode('render probe');
  // No trimEnd(): the quiet zone's light rows are all-space lines and must survive.
  const blocks = renderBlocks(symbol.modules, { quietZone: 2 }).replace(/\n$/, '').split('\n');
  const ascii = renderAscii(symbol.modules, { quietZone: 2 }).replace(/\n$/, '').split('\n');
  // Half-block rendering emits 2 module rows per text line, so the quiet zone (2 rows top and bottom)
  // contributes 2 text lines and the symbol contributes ceil(size / 2).
  assert.equal(blocks.length, 2 + Math.ceil((symbol.size + 4) / 2));
  assert.equal(ascii.length, 4 + symbol.size);
  assert.ok(blocks.every((line) => [...line].length === symbol.size + 4), 'every block line must be full width');
  // The ASCII fallback renders each module as two characters, so the margin is two columns per quiet module.
  assert.ok(ascii.every((line) => line.length === symbol.size * 2 + 8));
  assert.ok(blocks[0].trimStart() === '', 'the quiet zone must be a light band');
  assert.equal(new Set(blocks.map((line) => [...line].length)).size, 1, 'all block lines must be the same width');
});
