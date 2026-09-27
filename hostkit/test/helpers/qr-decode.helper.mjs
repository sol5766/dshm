/**
 * An **independent** QR decoder used only by the tests.
 *
 * Why this file exists: an encoder tested by round-tripping through itself proves nothing — a shared
 * table transcribed wrong is invisible. So this decoder is written against the specification from
 * scratch (its own function-module map, its own un-masking, its own de-interleaving, its own
 * Reed–Solomon *decoder* including Berlekamp–Massey and Forney) and only shares the ISO/IEC 18004
 * constants that are also cross-checked numerically in `qr.test.mjs`.
 *
 * If the encoder's tables, masking, interleaving or format bits were wrong, either the decode fails or
 * the decoded payload differs — both are test failures.
 */

import { Buffer } from 'node:buffer';
import { EC_CODEWORDS_PER_BLOCK, NUM_ERROR_CORRECTION_BLOCKS, ALIGNMENT_PATTERN_POSITIONS } from './qr-tables.helper.mjs';

/* ------------------------------------------------------------------ *
 * GF(256) + polynomial helpers
 * ------------------------------------------------------------------ */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let index = 0; index < 255; index += 1) {
    EXP[index] = x;
    LOG[x] = index;
    x <<= 1;
    if ((x & 0x100) !== 0) x ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) EXP[index] = EXP[index - 255];
})();

/** @param {number} a @param {number} b @returns {number} */
function mul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** @param {number} a @returns {number} */
function inv(a) {
  if (a === 0) throw new Error('qr-decode: inverse of zero');
  return EXP[255 - LOG[a]];
}

/**
 * Polynomials are stored highest-degree-first.
 * @param {number[]} poly @param {number} x @returns {number}
 */
function evaluate(poly, x) {
  let result = 0;
  for (const coefficient of poly) result = mul(result, x) ^ coefficient;
  return result;
}

/** @param {number[]} poly @returns {number[]} formal derivative, highest-degree-first */
function derivative(poly) {
  const degree = poly.length - 1;
  if (degree <= 0) return [0];
  const out = [];
  for (let index = 0; index < degree; index += 1) {
    const power = degree - index;
    out.push(power % 2 === 0 ? 0 : poly[index]);
  }
  return out;
}

/** @param {number[]} a @param {number[]} b @returns {number[]} */
function polyMul(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) out[i + j] ^= mul(a[i], b[j]);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Reed–Solomon decoding
 * ------------------------------------------------------------------ */

/**
 * @param {number[]} received @param {number} ecLength
 * @returns {number[]} corrected codewords
 */
export function correctBlock(received, ecLength) {
  const syndromes = [];
  let hasError = false;
  for (let index = 0; index < ecLength; index += 1) {
    const value = evaluate(received, EXP[index]);
    syndromes.push(value);
    if (value !== 0) hasError = true;
  }
  if (!hasError) return received.slice();

  // Berlekamp–Massey on the syndrome sequence.
  let locator = [1];
  let previous = [1];
  let errors = 0;
  for (let n = 0; n < ecLength; n += 1) {
    let discrepancy = syndromes[n];
    for (let index = 1; index <= errors; index += 1) {
      discrepancy ^= mul(locator[locator.length - 1 - index] ?? 0, syndromes[n - index]);
    }
    if (discrepancy === 0) continue;
    const scaled = previous.map((coefficient) => mul(coefficient, discrepancy));
    if (scaled.length > locator.length - (n - errors) - 1) {
      const shift = scaled.length - (locator.length - (n - errors) - 1);
      const shifted = [...locator, ...new Array(shift).fill(0)];
      previous = locator.map((coefficient) => mul(coefficient, inv(discrepancy)));
      locator = shifted.map((coefficient, index) => coefficient ^ (scaled[index] ?? 0));
      errors = n + 1 - errors;
    } else {
      const offset = locator.length - (n - errors) - 1 - scaled.length;
      const shifted = [...new Array(offset).fill(0), ...scaled];
      locator = locator.map((coefficient, index) => coefficient ^ (shifted[index] ?? 0));
    }
  }

  const errorCount = locator.length - 1;
  if (errorCount === 0 || errorCount * 2 > ecLength) throw new Error('qr-decode: too many errors to locate');

  // Chien search: error positions are the inverses of the locator roots.
  const positions = [];
  for (let index = 0; index < received.length; index += 1) {
    const x = EXP[(255 - (received.length - 1 - index)) % 255];
    if (evaluate(locator, x) === 0) positions.push(index);
  }
  if (positions.length !== errorCount) throw new Error(`qr-decode: located ${positions.length} of ${errorCount} errors`);

  // Forney: Omega(x) = S(x)·Lambda(x) mod x^ec, e_i = X_i · Omega(X_i^-1) / Lambda'(X_i^-1).
  const omega = polyMul(syndromes.slice().reverse(), locator).slice(-(ecLength + 1));
  const lambdaPrime = derivative(locator);
  const corrected = received.slice();
  for (const position of positions) {
    const x = EXP[(255 - (received.length - 1 - position)) % 255];
    const xInverse = inv(x);
    const numerator = evaluate(omega, xInverse);
    const denominator = evaluate(lambdaPrime, xInverse);
    if (denominator === 0) throw new Error('qr-decode: Forney denominator is zero');
    corrected[position] ^= mul(numerator, inv(denominator));
  }
  for (let index = 0; index < ecLength; index += 1) {
    if (evaluate(corrected, EXP[index]) !== 0) throw new Error('qr-decode: correction did not converge');
  }
  return corrected;
}

/* ------------------------------------------------------------------ *
 * Symbol decoding
 * ------------------------------------------------------------------ */

/**
 * @param {number} version
 * @returns {boolean[][]} function-module map
 */
export function functionMap(version) {
  const size = version * 4 + 17;
  const map = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x, y) => {
    if (x >= 0 && x < size && y >= 0 && y < size) map[y][x] = true;
  };
  // Finder patterns with separators (9×9 areas centred on each finder's centre module).
  for (const center of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]) {
    const [cx, cy] = center;
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) mark(cx + dx, cy + dy);
    }
  }
  // Timing patterns, only between the separators.
  for (let index = 8; index < size - 8; index += 1) {
    mark(6, index);
    mark(index, 6);
  }
  // Format-information bands plus the always-dark module. These occupy row 8 / column 8, which the
  // 9×9 finder boxes above deliberately leave alone (they start at index 8), so they must be marked
  // here or the data traversal would read them as data.
  for (let index = 0; index <= 8; index += 1) {
    mark(8, index);
    mark(index, 8);
  }
  for (let index = 0; index < 8; index += 1) {
    mark(size - 1 - index, 8);
    mark(8, size - 1 - index);
  }
  mark(8, size - 8); // dark module
  // Alignment patterns: `positions` holds both axes' coordinates (the grid is symmetric).
  const positions = ALIGNMENT_PATTERN_POSITIONS[version];
  const count = positions.length;
  for (let rowIndex = 0; rowIndex < count; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < count; columnIndex += 1) {
      if (
        (rowIndex === 0 && columnIndex === 0) ||
        (rowIndex === 0 && columnIndex === count - 1) ||
        (rowIndex === count - 1 && columnIndex === 0)
      ) {
        continue;
      }
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) mark(positions[columnIndex] + dx, positions[rowIndex] + dy);
      }
    }
  }
  if (version >= 7) {
    for (let index = 0; index < 18; index += 1) {
      const a = size - 11 + (index % 3);
      const b = Math.floor(index / 3);
      mark(a, b);
      mark(b, a);
    }
  }
  return map;
}

/**
 * @param {boolean[][]} modules
 * @returns {number} the version read from the size (the size fully determines the version)
 */
export function versionOf(modules) {
  const size = modules.length;
  if (size < 21 || size > 177 || (size - 17) % 4 !== 0) throw new Error(`qr-decode: bad symbol size ${size}`);
  return (size - 17) / 4;
}

/**
 * Strip the mask and blank out every function module, so the data traversal below cannot accidentally
 * read a timing, alignment or format module. `functionMap` already covers the format bands (they live
 * in the finder separators), and this function asserts that rather than assuming it.
 * @param {boolean[][]} modules @param {number} version @returns {(boolean|null)[][]}
 */
function dataMask(modules, version) {
  const map = functionMap(version);
  const size = modules.length;
  const out = [];
  for (let y = 0; y < size; y += 1) {
    const row = [];
    for (let x = 0; x < size; x += 1) row.push(map[y][x] ? null : modules[y][x]);
    out.push(row);
  }
  for (let index = 0; index <= 8; index += 1) {
    if (out[8][index] !== null || out[index][8] !== null) {
      throw new Error(`qr-decode: format band module (8,${index})/(${index},8) is not marked as a function module`);
    }
  }
  for (let index = 0; index < 8; index += 1) {
    if (out[8][size - 1 - index] !== null) {
      throw new Error('qr-decode: the second format copy (top-right) is not marked as a function module');
    }
  }
  for (let index = 8; index < 15; index += 1) {
    if (out[size - 15 + index][8] !== null) {
      throw new Error('qr-decode: the second format copy (bottom-left) is not marked as a function module');
    }
  }
  if (out[size - 8][8] !== null) throw new Error('qr-decode: the always-dark module is not marked as a function module');
  return out;
}

/**
 * @param {boolean[][]} modules
 * @returns {{level: number, mask: number}}
 */
export function readFormat(modules) {
  /** @type {number[]} */
  const bits = [];
  // Mirror of the encoder's write order: LSB first around the top-left copy.
  for (let index = 0; index <= 5; index += 1) bits.push(modules[index][8] ? 1 : 0);
  bits.push(modules[7][8] ? 1 : 0);
  bits.push(modules[8][8] ? 1 : 0);
  bits.push(modules[8][7] ? 1 : 0);
  for (let index = 9; index < 15; index += 1) bits.push(modules[8][14 - index] ? 1 : 0);
  let value = 0;
  for (let index = 0; index < 15; index += 1) value |= bits[index] << index;

  const decoded = decodeFormatBits(value);
  if (decoded === undefined) throw new Error('qr-decode: format information failed to decode');
  return decoded;
}

/**
 * Read the *second* copy of the format information (used to prove both copies carry the same bits).
 * @param {boolean[][]} modules @returns {number}
 */
export function readFormatSecondCopy(modules) {
  const size = modules.length;
  /** @type {number[]} */
  const bits = [];
  for (let index = 0; index < 8; index += 1) bits.push(modules[8][size - 1 - index] ? 1 : 0);
  for (let index = 8; index < 15; index += 1) bits.push(modules[size - 15 + index][8] ? 1 : 0);
  let value = 0;
  for (let index = 0; index < 15; index += 1) value |= bits[index] << index;
  return value;
}

/**
 * BCH(15,5) decode of the (already un-XORed) format word.
 * @param {number} value @returns {{level: number, mask: number}|undefined}
 */
export function decodeFormatBits(value) {
  let best = undefined;
  let bestDistance = 4; // the code corrects up to 3 bit errors
  for (let data = 0; data < 32; data += 1) {
    let remainder = data;
    for (let index = 0; index < 10; index += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const candidate = ((data << 10) | (remainder & 0x3ff)) ^ 0x5412;
    let distance = 0;
    let diff = candidate ^ value;
    while (diff !== 0) {
      distance += diff & 1;
      diff >>>= 1;
    }
    if (distance < bestDistance) {
      bestDistance = distance;
      best = data;
    }
  }
  if (best === undefined) return undefined;
  const levelBits = best >>> 3;
  const mask = best & 7;
  const level = [1, 0, 3, 2].indexOf(levelBits);
  if (level < 0) return undefined;
  return { level, mask };
}

/**
 * @param {number} mask @param {number} x @param {number} y @returns {boolean}
 */
function maskBit(mask, x, y) {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      throw new Error(`qr-decode: bad mask ${mask}`);
  }
}

/**
 * Read the final codeword sequence out of the symbol.
 * @param {boolean[][]} modules @param {number} version @param {number} mask @returns {number[]}
 */
export function readCodewords(modules, version, mask) {
  const size = modules.length;
  const data = dataMask(modules, version);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (data[y][x] === null) continue;
        const bit = data[y][x] ? 1 : 0;
        bits.push(bit ^ (maskBit(mask, x, y) ? 1 : 0));
      }
    }
  }
  const total = Math.floor(bits.length / 8);
  const codewords = [];
  for (let index = 0; index < total; index += 1) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | bits[index * 8 + bit];
    codewords.push(value);
  }
  return codewords;
}

/**
 * De-interleave and error-correct the codeword sequence back into data codewords.
 * @param {number[]} codewords @param {number} version @param {number} level @returns {number[]}
 */
/**
 * @param {number} version @returns {number} the closed-form module count (independent of any table)
 */
export function rawDataModulesOf(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

export function extractData(codewords, version, level) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[level][version];
  const ecLength = EC_CODEWORDS_PER_BLOCK[level][version];
  const rawCodewords = Math.floor(rawDataModulesOf(version) / 8);
  const shortBlockLength = Math.floor(rawCodewords / numBlocks) - ecLength;
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const longBlockLength = shortBlockLength + 1 + ecLength;
  const shortBlockTotal = shortBlockLength + ecLength;

  const blocks = [];
  for (let block = 0; block < numBlocks; block += 1) {
    blocks.push(new Array(block < numShortBlocks ? shortBlockTotal : longBlockLength).fill(0));
  }
  let offset = 0;
  for (let index = 0; index < shortBlockLength; index += 1) {
    for (const block of blocks) block[index] = codewords[offset++];
  }
  for (let block = numShortBlocks; block < numBlocks; block += 1) blocks[block][shortBlockLength] = codewords[offset++];
  for (let index = 0; index < ecLength; index += 1) {
    for (const block of blocks) block[shortBlockLength + (block.length === longBlockLength ? 1 : 0) + index] = codewords[offset++];
  }
  if (offset !== codewords.length) throw new Error(`qr-decode: consumed ${offset} of ${codewords.length} codewords`);

  const out = [];
  for (const block of blocks) {
    const corrected = correctBlock(block, ecLength);
    out.push(...corrected.slice(0, corrected.length - ecLength));
  }
  return out;
}

/**
 * Full decode: modules → `{version, level, mask, text}`.
 * @param {boolean[][]} modules
 * @returns {{version: number, level: number, mask: number, text: string, bytes: Buffer}}
 */
export function decode(modules) {
  const version = versionOf(modules);
  const { level, mask } = readFormat(modules);
  const codewords = readCodewords(modules, version, mask);
  const data = extractData(codewords, version, level);

  // Byte-mode segment: 4-bit mode, byte count (8 or 16 bits), payload bytes.
  let bitIndex = 0;
  const readBits = (count) => {
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      const byte = data[bitIndex >>> 3];
      const bit = (byte >>> (7 - (bitIndex & 7))) & 1;
      value = (value << 1) | bit;
      bitIndex += 1;
    }
    return value;
  };
  const mode = readBits(4);
  if (mode !== 0b0100) throw new Error(`qr-decode: expected byte mode, got 0b${mode.toString(2)}`);
  const length = readBits(version <= 9 ? 8 : 16);
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) bytes[index] = readBits(8);
  return { version, level, mask, text: bytes.toString('utf8'), bytes };
}
