#!/usr/bin/env node

/**
 * Gate: the bundled QEMU must stay on the TCI backend and must not contain
 * AArch64 CNTW instructions.
 *
 * APMS 1.1.3 CPP_CRASH showed SIGILL(ILL_ILLOPC) at CNTW on CHZ-AL00. The
 * binary was built with HiSH's armv8.5-a ARCH_FLAGS, which is above the CPU
 * baseline of some HarmonyOS phones. Rebuild with an armv8-a baseline.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const QEMU = 'entry/libs/arm64-v8a/libqemu-system-aarch64.so'
const fileArg = process.argv.indexOf('--file')
const qemuFile = fileArg > 0 ? process.argv[fileArg + 1] : QEMU

function u16(buffer, offset) {
  return buffer.readUInt16LE(offset)
}

function u32(buffer, offset) {
  return buffer.readUInt32LE(offset)
}

function u64(buffer, offset) {
  return Number(buffer.readBigUInt64LE(offset))
}

function cString(buffer, offset) {
  let end = offset
  while (end < buffer.length && buffer[end] !== 0) end += 1
  return buffer.subarray(offset, end).toString('utf8')
}

function sectionRange(buffer, wanted) {
  if (buffer.length < 64 || buffer[0] !== 0x7f || buffer[1] !== 0x45
    || buffer[2] !== 0x4c || buffer[3] !== 0x46) {
    throw new Error('not an ELF file')
  }
  if (buffer[4] !== 2 || buffer[5] !== 1) {
    throw new Error('expected ELF64 little-endian')
  }
  const shoff = u64(buffer, 0x28)
  const shentsize = u16(buffer, 0x3a)
  const shnum = u16(buffer, 0x3c)
  const shstrndx = u16(buffer, 0x3e)
  if (shoff <= 0 || shentsize < 64 || shnum <= 0 || shstrndx >= shnum) {
    throw new Error('invalid section table')
  }
  const shstr = shoff + shstrndx * shentsize
  const shstrOffset = u64(buffer, shstr + 0x18)
  const shstrSize = u64(buffer, shstr + 0x20)
  for (let index = 0; index < shnum; index += 1) {
    const header = shoff + index * shentsize
    const nameOffset = u32(buffer, header)
    const name = cString(
      buffer.subarray(shstrOffset, shstrOffset + shstrSize),
      nameOffset,
    )
    if (name === wanted) {
      return {
        offset: u64(buffer, header + 0x18),
        size: u64(buffer, header + 0x20),
      }
    }
  }
  throw new Error(`section not found: ${wanted}`)
}

function findCntw(buffer) {
  const hits = []
  for (let offset = 0; offset + 4 <= buffer.length; offset += 1) {
    if (
      buffer[offset + 1] === 0xe3
      && buffer[offset + 2] === 0xa0
      && buffer[offset + 3] === 0x04
      && (buffer[offset] & 0xf0) === 0xe0
    ) {
      hits.push(offset)
    }
  }
  return hits
}

function countAscii(buffer, needle) {
  const target = Buffer.from(needle, 'ascii')
  let count = 0
  for (let offset = 0; offset <= buffer.length - target.length; offset += 1) {
    if (buffer.subarray(offset, offset + target.length).equals(target)) count += 1
  }
  return count
}

function selfTest() {
  const synthetic = Buffer.from([0, 0, 0xe8, 0xe3, 0xa0, 0x04, 0])
  const hits = findCntw(synthetic)
  if (hits.length !== 1) throw new Error(`CNTW detector self-test failed: ${hits.length}`)
  console.log('QEMU ISA self-test: PASS')
}

if (process.argv.includes('--self-test')) {
  selfTest()
  process.exit(0)
}

const binary = readFileSync(resolve(qemuFile))
const text = sectionRange(binary, '.text')
const textBytes = binary.subarray(text.offset, text.offset + text.size)
const cntw = findCntw(textBytes)
const tciProbe = countAscii(binary, 'print_insn_tci')
const tciTbPtr = countAscii(binary, 'tci_tb_ptr')

console.log(`QEMU=${qemuFile}`)
console.log(`.text=${text.size} bytes`)
console.log(`CNTW=${cntw.length}`)
console.log(`TCI print_insn_tci=${tciProbe}`)
console.log(`TCI tci_tb_ptr=${tciTbPtr}`)
if (cntw.length > 0) {
  console.log(`CNTW offsets=${cntw.slice(0, 12).map((n) => '0x' + n.toString(16)).join(',')}`)
  throw new Error('QEMU text contains unsupported CNTW instructions')
}
if (tciProbe === 0 || tciTbPtr === 0) {
  throw new Error('QEMU is not the TCI interpreter build')
}
console.log('QEMU ISA gate: PASS')
