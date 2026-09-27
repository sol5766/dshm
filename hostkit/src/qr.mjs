/**
 * A self-contained QR Code encoder (byte mode, EC level M, version auto-selected).
 *
 * Why this module exists: `hostkit pair` should be scannable from a phone camera, and the red line is
 * "zero runtime dependencies" — so `qrcode`/`qrcode-terminal` are out. A QR encoder is a bounded,
 * testable amount of work (this file), and it is *verifiable without a camera*: `test/helpers/qr-decode.mjs`
 * is an independent decoder (its own Reed–Solomon decoder, its own un-masking, its own de-interleaving)
 * that reconstructs the payload from the rendered module matrix. If the encoder were wrong in a way that
 * matters, that test fails.
 *
 * Parameters: byte mode only (mode indicator `0100`), EC level **M**, version chosen as the smallest
 * that fits. Byte mode is what a `dshkit://` URI needs; nothing here handles numeric/alphanumeric/kanji
 * modes or multiple segments, and `encode()` throws rather than silently truncating if the payload does
 * not fit version 40-M (2331 bytes).
 *
 * The tables are transcribed from ISO/IEC 18004. Two of them are load-bearing for correctness and are
 * cross-checked in the tests against the closed-form module-count formula, so a transcription slip in
 * either table cannot pass unnoticed:
 *   - `EC_CODEWORDS_PER_BLOCK[level][version]`
 *   - `NUM_ERROR_CORRECTION_BLOCKS[level][version]`
 */

import { Buffer } from 'node:buffer';

/** Error-correction levels, indexed the way the spec's tables are. */
export const EC_LEVEL = Object.freeze({ L: 0, M: 1, Q: 2, H: 3 });

/** EC codewords per block, indexed `[level][version]` (version 1..40 at index 1..40; index 0 unused). */
const EC_CODEWORDS_PER_BLOCK = [
  // version:  0   1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30  31  32  33  34  35  36  37  38  39  40
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // H
];

/** Number of error-correction blocks, indexed `[level][version]`. */
const NUM_ERROR_CORRECTION_BLOCKS = [
  // version:  0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
  [-1, 1, 1, 2, 4, 4, 4, 5, 5, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // H
];

/** Alignment-pattern centre coordinates per version (ISO/IEC 18004 Annex E). */
const ALIGNMENT_PATTERN_POSITIONS = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];

const MIN_VERSION = 1;
const MAX_VERSION = 40;
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** Character-count indicator width for byte mode, per version range. */
export function countBitsForByteMode(version) {
  return version <= 9 ? 8 : 16;
}

/**
 * Number of data modules (i.e. modules that can hold codeword bits) before error correction is
 * subtracted. Closed form from ISO/IEC 18004 §8.9 / Nayuki's derivation; used both to size the symbol
 * and — in the tests — to validate the two block tables.
 * @param {number} version
 * @returns {number}
 */
export function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/**
 * Total codewords in a version (all blocks, data + EC).
 * @param {number} version @returns {number}
 */
export function totalCodewords(version) {
  return Math.floor(rawDataModules(version) / 8);
}

/**
 * @param {number} version @param {number} level @returns {number} data codewords
 */
export function dataCodewords(version, level) {
  return (
    Math.floor(rawDataModules(version) / 8) -
    EC_CODEWORDS_PER_BLOCK[level][version] * NUM_ERROR_CORRECTION_BLOCKS[level][version]
  );
}

/**
 * @param {number} version @param {number} level @returns {{numBlocks: number, ecCodewordsPerBlock: number, shortBlockLength: number, numShortBlocks: number}}
 */
export function blockStructure(version, level) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[level][version];
  const ecCodewordsPerBlock = EC_CODEWORDS_PER_BLOCK[level][version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlockLength = Math.floor(rawCodewords / numBlocks) - ecCodewordsPerBlock;
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  return { numBlocks, ecCodewordsPerBlock, shortBlockLength, numShortBlocks };
}

/**
 * Smallest version whose data capacity fits `byteLength` bytes at the given level.
 * @param {number} byteLength @param {number} level @returns {number|undefined}
 */
export function pickVersion(byteLength, level = EC_LEVEL.M) {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version += 1) {
    const capacityBits = dataCodewords(version, level) * 8;
    const needed = 4 + countBitsForByteMode(version) + 8 * byteLength;
    if (needed <= capacityBits) return version;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * GF(256) arithmetic + Reed–Solomon
 * ------------------------------------------------------------------ */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let index = 0; index < 255; index += 1) {
    GF_EXP[index] = x;
    GF_LOG[x] = index;
    x <<= 1;
    if ((x & 0x100) !== 0) x ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) GF_EXP[index] = GF_EXP[index - 255];
})();

/** @param {number} a @param {number} b @returns {number} */
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/**
 * @param {Uint8Array} data data codewords
 * @param {number} degree number of EC codewords
 * @returns {Uint8Array} the EC codewords
 */
export function reedSolomonRemainder(data, degree) {
  const divisor = new Uint8Array(degree);
  divisor[degree - 1] = 1;
  let root = 1;
  for (let index = 0; index < degree; index += 1) {
    for (let j = 0; j < degree; j += 1) {
      divisor[j] = gfMul(divisor[j], root);
      if (j + 1 < degree) divisor[j] ^= divisor[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  const result = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[degree - 1] = 0;
    for (let index = 0; index < degree; index += 1) result[index] ^= gfMul(divisor[index], factor);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Bit stream
 * ------------------------------------------------------------------ */

class BitBuffer {
  constructor() {
    /** @type {number[]} */
    this.bits = [];
  }

  /** @param {number} value @param {number} length */
  append(value, length) {
    for (let index = length - 1; index >= 0; index -= 1) this.bits.push((value >>> index) & 1);
  }

  get length() {
    return this.bits.length;
  }

  /** @returns {Uint8Array} */
  toBytes() {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, index) => {
      if (bit !== 0) out[index >>> 3] |= 0x80 >>> (index & 7);
    });
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * Encoding pipeline
 * ------------------------------------------------------------------ */

/**
 * @param {Uint8Array} dataBytes
 * @param {number} version
 * @param {number} level
 * @returns {Uint8Array} the final codeword sequence (data, interleaved, then EC interleaved)
 */
export function addEccAndInterleave(dataBytes, version, level) {
  const { numBlocks, ecCodewordsPerBlock, shortBlockLength, numShortBlocks } = blockStructure(version, level);
  const numDataCodewords = dataCodewords(version, level);
  if (dataBytes.length !== numDataCodewords) {
    throw new Error(`qr: expected ${numDataCodewords} data codewords, got ${dataBytes.length}`);
  }

  const shortBlockDataLength = shortBlockLength;
  const longBlockDataLength = shortBlockLength + 1;

  /** @type {Uint8Array[]} */
  const dataBlocks = [];
  /** @type {Uint8Array[]} */
  const ecBlocks = [];
  let offset = 0;
  for (let block = 0; block < numBlocks; block += 1) {
    const length = block < numShortBlocks ? shortBlockDataLength : longBlockDataLength;
    dataBlocks.push(dataBytes.slice(offset, offset + length));
    offset += length;
  }
  for (const block of dataBlocks) ecBlocks.push(reedSolomonRemainder(block, ecCodewordsPerBlock));

  const out = new Uint8Array(numBlocks * (shortBlockLength + ecCodewordsPerBlock) + (numBlocks - numShortBlocks));
  let outIndex = 0;
  const longBlockLength = longBlockDataLength + ecCodewordsPerBlock;
  for (let index = 0; index < shortBlockLength; index += 1) {
    for (const block of dataBlocks) out[outIndex++] = block[index];
  }
  // The one extra data codeword of each long block sits between the data and EC interleaves.
  for (let block = numShortBlocks; block < numBlocks; block += 1) out[outIndex++] = dataBlocks[block][shortBlockLength];
  for (let index = 0; index < ecCodewordsPerBlock; index += 1) {
    for (const block of ecBlocks) out[outIndex++] = block[index];
  }
  if (outIndex !== totalCodewords(version)) {
    throw new Error(`qr: interleave produced ${outIndex} codewords, expected ${totalCodewords(version)}`);
  }
  if (longBlockLength <= 0) throw new Error('qr: degenerate block length');
  return out;
}

/**
 * Build the data codeword stream for a byte-mode segment.
 * @param {Uint8Array} payload
 * @param {number} version
 * @param {number} level
 * @returns {Uint8Array}
 */
export function buildDataCodewords(payload, version, level) {
  const capacityBits = dataCodewords(version, level) * 8;
  const bits = new BitBuffer();
  bits.append(0b0100, 4); // byte mode
  bits.append(payload.length, countBitsForByteMode(version));
  for (const byte of payload) bits.append(byte, 8);
  if (bits.length > capacityBits) throw new Error('qr: payload does not fit the chosen version');

  // Terminator, then pad to a byte boundary, then the standard 0xEC/0x11 pad codewords.
  bits.append(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.append(0, 1);
  const data = new Uint8Array(capacityBits / 8);
  const partial = bits.toBytes();
  data.set(partial, 0);
  let pad = 0xec;
  for (let index = partial.length; index < data.length; index += 1) {
    data[index] = pad;
    pad = pad === 0xec ? 0x11 : 0xec;
  }
  return data;
}

/* ------------------------------------------------------------------ *
 * Matrix construction
 * ------------------------------------------------------------------ */

/**
 * A QR symbol under construction.
 *
 * Module values are `0`/`1`; "is this a function module" is tracked in a **parallel bitmap** rather
 * than as a sentinel value. Using a sentinel (e.g. `0xff` for "not yet written") silently breaks as
 * soon as a function module is legitimately written as `0`, because that module then looks like free
 * space and the codeword placement shifts by one bit — a corruption that still produces a
 * plausible-looking symbol.
 */
class Matrix {
  /** @param {number} version @param {number} level */
  constructor(version, level) {
    this.version = version;
    this.level = level;
    this.size = version * 4 + 17;
    this.modules = new Uint8Array(this.size * this.size);
    this.reserved = new Uint8Array(this.size * this.size);
  }

  /** @param {number} x @param {number} y @param {number} value */
  set(x, y, value) {
    this.modules[y * this.size + x] = value ? 1 : 0;
  }

  /** @param {number} x @param {number} y @returns {number} */
  get(x, y) {
    return this.modules[y * this.size + x];
  }

  /** @param {number} x @param {number} y @returns {boolean} */
  isFunction(x, y) {
    return this.reserved[y * this.size + x] !== 0;
  }
}

/**
 * @param {Matrix} matrix @param {number} x @param {number} y @param {number} value
 */
function setFunctionModule(matrix, x, y, value) {
  matrix.reserved[y * matrix.size + x] = 1;
  matrix.set(x, y, value);
}

/**
 * @param {Matrix} matrix
 */
function drawFunctionPatterns(matrix) {
  const size = matrix.size;
  // Finder patterns with separators. Each is a 9×9 area centred on the finder's centre module; the
  // centre coordinates are written as (x, y) pairs, matching `setFunctionModule(x, y, …)`.
  for (const center of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]) {
    const [cx, cy] = center;
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const px = cx + dx;
        const py = cy + dy;
        if (px < 0 || px >= size || py < 0 || py >= size) continue;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        setFunctionModule(matrix, px, py, distance !== 2 && distance !== 4);
      }
    }
  }
  // Timing patterns. Drawn after the finders so they overwrite the finder rows/columns inside the
  // separator area, which is what ISO/IEC 18004 specifies.
  for (let index = 8; index < size - 8; index += 1) {
    setFunctionModule(matrix, 6, index, index % 2 === 0);
    setFunctionModule(matrix, index, 6, index % 2 === 0);
  }
  // Alignment patterns. `positions` is the list of **both** x and y coordinates (the pattern grid is
  // symmetric), so the first index selects the column and the second selects the row.
  const positions = ALIGNMENT_PATTERN_POSITIONS[matrix.version];
  const count = positions.length;
  for (let rowIndex = 0; rowIndex < count; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < count; columnIndex += 1) {
      if (
        (rowIndex === 0 && columnIndex === 0) ||
        (rowIndex === 0 && columnIndex === count - 1) ||
        (rowIndex === count - 1 && columnIndex === 0)
      ) {
        continue; // overlaps a finder pattern
      }
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFunctionModule(
            matrix,
            positions[columnIndex] + dx,
            positions[rowIndex] + dy,
            Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
          );
        }
      }
    }
  }
  // Reserve the format-information areas (values written later) and the version block.
  drawFormatBits(matrix, 0);
  drawVersionBits(matrix);
}

/**
 * Write both copies of the 15 format bits (level + mask).
 * @param {Matrix} matrix @param {number} mask
 */
function drawFormatBits(matrix, mask) {
  const size = matrix.size;
  const levelBits = [1, 0, 3, 2][matrix.level]; // EC level bits, indexed by the spec's level order
  const data = (levelBits << 3) | mask;
  let remainder = data;
  for (let index = 0; index < 10; index += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const bits = ((data << 10) | remainder) ^ 0x5412;

  // First copy: around the top-left finder.
  for (let index = 0; index <= 5; index += 1) setFunctionModule(matrix, 8, index, ((bits >>> index) & 1) !== 0);
  setFunctionModule(matrix, 8, 7, ((bits >>> 6) & 1) !== 0);
  setFunctionModule(matrix, 8, 8, ((bits >>> 7) & 1) !== 0);
  setFunctionModule(matrix, 7, 8, ((bits >>> 8) & 1) !== 0);
  for (let index = 9; index < 15; index += 1) setFunctionModule(matrix, 14 - index, 8, ((bits >>> index) & 1) !== 0);
  // Second copy: split between the top-right and bottom-left finders; the dark module is the 15th bit.
  for (let index = 0; index < 8; index += 1) setFunctionModule(matrix, size - 1 - index, 8, ((bits >>> index) & 1) !== 0);
  for (let index = 8; index < 15; index += 1) setFunctionModule(matrix, 8, size - 15 + index, ((bits >>> index) & 1) !== 0);
  setFunctionModule(matrix, 8, size - 8, true); // always-dark module
}

/**
 * Write the 18-bit version information for versions ≥ 7.
 * @param {Matrix} matrix
 */
function drawVersionBits(matrix) {
  if (matrix.version < 7) return;
  const size = matrix.size;
  let remainder = matrix.version;
  for (let index = 0; index < 12; index += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  const bits = (matrix.version << 12) | remainder;
  for (let index = 0; index < 18; index += 1) {
    const bit = ((bits >>> index) & 1) !== 0;
    const a = size - 11 + (index % 3);
    const b = Math.floor(index / 3);
    setFunctionModule(matrix, a, b, bit);
    setFunctionModule(matrix, b, a, bit);
  }
}

/**
 * Place codewords in the standard upward/downward zig-zag, skipping the vertical timing column and
 * all function modules.
 * @param {Matrix} matrix @param {Uint8Array} codewords
 */
function drawCodewords(matrix, codewords) {
  const size = matrix.size;
  let index = 0; // bit index into codewords
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (matrix.isFunction(x, y)) continue;
        if (index < codewords.length * 8) {
          const bit = (codewords[index >>> 3] >>> (7 - (index & 7))) & 1;
          matrix.set(x, y, bit !== 0);
          index += 1;
        } else {
          // Remainder bits stay light.
          matrix.set(x, y, false);
        }
      }
    }
  }
  if (index !== codewords.length * 8) throw new Error(`qr: placed ${index} bits, expected ${codewords.length * 8}`);
}

/* ------------------------------------------------------------------ *
 * Masking
 * ------------------------------------------------------------------ */

/**
 * @param {number} mask @param {number} x @param {number} y @returns {boolean}
 */
export function maskCondition(mask, x, y) {
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
      throw new Error(`qr: bad mask ${mask}`);
  }
}

/**
 * @param {Matrix} matrix @param {number} mask
 */
function applyMask(matrix, mask) {
  const size = matrix.size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (matrix.isFunction(x, y)) continue;
      if (maskCondition(mask, x, y)) matrix.modules[y * size + x] ^= 1;
    }
  }
}

/**
 * ISO/IEC 18004 §8.8.2 penalty score; the lowest score wins.
 * @param {Matrix} matrix @returns {number}
 */
export function penaltyScore(matrix) {
  const size = matrix.size;
  const get = (x, y) => matrix.get(x, y) === 1;
  let result = 0;

  // Rule 1: runs of five or more same-coloured modules in a row/column.
  for (let y = 0; y < size; y += 1) {
    let runColour = get(0, y);
    let runLength = 1;
    for (let x = 1; x < size; x += 1) {
      if (get(x, y) === runColour) {
        runLength += 1;
      } else {
        if (runLength >= 5) result += PENALTY_N1 + (runLength - 5);
        runColour = get(x, y);
        runLength = 1;
      }
    }
    if (runLength >= 5) result += PENALTY_N1 + (runLength - 5);
  }
  for (let x = 0; x < size; x += 1) {
    let runColour = get(x, 0);
    let runLength = 1;
    for (let y = 1; y < size; y += 1) {
      if (get(x, y) === runColour) {
        runLength += 1;
      } else {
        if (runLength >= 5) result += PENALTY_N1 + (runLength - 5);
        runColour = get(x, y);
        runLength = 1;
      }
    }
    if (runLength >= 5) result += PENALTY_N1 + (runLength - 5);
  }

  // Rule 2: 2×2 blocks of one colour.
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const colour = get(x, y);
      if (colour === get(x + 1, y) && colour === get(x, y + 1) && colour === get(x + 1, y + 1)) {
        result += PENALTY_N2;
      }
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns with a four-module light margin.
  const pattern = [true, false, true, true, true, false, true];
  const matches = (x, y, dx, dy) => {
    for (let index = 0; index < 7; index += 1) {
      const px = x + dx * index;
      const py = y + dy * index;
      if (px < 0 || px >= size || py < 0 || py >= size) return false;
      if (get(px, py) !== pattern[index]) return false;
    }
    return true;
  };
  const quiet = (x, y, dx, dy) => {
    for (let index = 0; index < 4; index += 1) {
      const px = x + dx * index;
      const py = y + dy * index;
      if (px < 0 || px >= size || py < 0 || py >= size) return true; // the outside of the symbol counts as light
      if (get(px, py)) return false;
    }
    return true;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (matches(x, y, 1, 0) && (quiet(x - 4, y, 1, 0) || quiet(x + 7, y, 1, 0))) result += PENALTY_N3;
      if (matches(x, y, 0, 1) && (quiet(x, y - 4, 0, 1) || quiet(x, y + 7, 0, 1))) result += PENALTY_N3;
    }
  }

  // Rule 4: deviation from a 50% dark ratio.
  let dark = 0;
  for (let index = 0; index < size * size; index += 1) if (matrix.modules[index] === 1) dark += 1;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * PENALTY_N4;
  return result;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Encode `text` (UTF-8 bytes) into a QR module matrix.
 * @param {string} text
 * @param {{level?: number}} [options]
 * @returns {{version: number, size: number, level: number, mask: number, modules: boolean[][]}}
 */
export function encode(text, options = {}) {
  const level = options.level ?? EC_LEVEL.M;
  const payload = new Uint8Array(Buffer.from(String(text), 'utf8'));
  const version = pickVersion(payload.length, level);
  if (version === undefined) {
    throw new Error(`qr: payload of ${payload.length} bytes does not fit version 40 at EC level ${level}`);
  }
  const data = buildDataCodewords(payload, version, level);
  const codewords = addEccAndInterleave(data, version, level);
  const matrix = new Matrix(version, level);
  drawFunctionPatterns(matrix);
  drawCodewords(matrix, codewords);

  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(matrix, mask);
    drawFormatBits(matrix, mask);
    const score = penaltyScore(matrix);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
    applyMask(matrix, mask); // XOR is its own inverse
  }
  applyMask(matrix, bestMask);
  drawFormatBits(matrix, bestMask);

  /** @type {boolean[][]} */
  const modules = [];
  for (let y = 0; y < matrix.size; y += 1) {
    const row = [];
    for (let x = 0; x < matrix.size; x += 1) row.push(matrix.get(x, y) === 1);
    modules.push(row);
  }
  return { version, size: matrix.size, level, mask: bestMask, modules };
}

/**
 * Render a matrix for a terminal using two rows per text line (half-block characters). Depends on a
 * Nerd Font-less UTF-8 terminal; `renderAscii` is the fallback.
 * @param {boolean[][]} modules
 * @param {{quietZone?: number, light?: string, dark?: string}} [options]
 * @returns {string}
 */
export function renderBlocks(modules, options = {}) {
  const quiet = options.quietZone ?? 2;
  const light = options.light ?? '█'; // "white" module rendered as a filled block for dark terminals
  const dark = options.dark ?? ' ';
  const size = modules.length;
  const width = size + quiet * 2;
  const lines = [];
  for (let index = 0; index < quiet; index += 1) lines.push(dark.repeat(width));
  for (let y = 0; y < size; y += 2) {
    let line = dark.repeat(quiet);
    for (let x = 0; x < size; x += 1) {
      const top = modules[y][x];
      const bottom = y + 1 < size ? modules[y + 1][x] : false;
      if (top === bottom) line += top ? dark : light;
      else line += top ? '▄' : '▀';
    }
    line += dark.repeat(quiet);
    lines.push(line);
  }
  for (let index = 0; index < quiet; index += 1) lines.push(dark.repeat(width));
  return `${lines.join('\n')}\n`;
}

/**
 * Plain-ASCII fallback for terminals or log files where block characters are not safe.
 * @param {boolean[][]} modules
 * @param {{quietZone?: number}} [options]
 * @returns {string}
 */
export function renderAscii(modules, options = {}) {
  const quiet = options.quietZone ?? 2;
  const size = modules.length;
  // Each module is two characters wide, so `quiet` modules of margin become `quiet * 2` columns —
  // which keeps every line the same width as the quiet-zone bands.
  const width = size * 2 + quiet * 4;
  const lines = [];
  for (let index = 0; index < quiet; index += 1) lines.push(' '.repeat(width));
  for (let y = 0; y < size; y += 1) {
    let line = ' '.repeat(quiet * 2);
    for (let x = 0; x < size; x += 1) line += modules[y][x] ? '##' : '  ';
    line += ' '.repeat(quiet * 2);
    lines.push(line);
  }
  for (let index = 0; index < quiet; index += 1) lines.push(' '.repeat(width));
  return `${lines.join('\n')}\n`;
}
