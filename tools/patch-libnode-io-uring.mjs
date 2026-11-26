#!/usr/bin/env node
/**
 * libnode（随包预编译 Node v24）里 libuv 的 io_uring 调用点：**体检 / 幂等"补丁" / 回退**。
 *
 * ## 为什么是"调用点"而不是"函数入口"
 *
 * `docs/50` E42 那次崩溃（`Signal:SIGSYS(SYS_SECCOMP) syscall number is 425`，arm64 上
 * 425 = `io_uring_setup`）当年的修法是给 **Node v22 源码树**打补丁（`uv__use_io_uring()`
 * 开头 `return 0`，见 `tools/node-runtime/fix-uv-io-uring.sh`）。那是源码级修法，只对
 * `libnode.so.127`（自建）有效。
 *
 * 现在随包的是 **自建 Node v24.9.0**（`libnode.so.137`，155,413,312 B，2026-11-05 换入，
 * 见 `docs/365`）。它同时具备两层保护：
 *
 *   1. **编译期**：`fix-uv-io-uring.sh` 给 `uv__use_io_uring()` 加了无条件 `return 0`，
 *      死代码消除后二进制里连 `UV_USE_IO_URING` 字符串都没有（24.2.0 预编译件里有 1 处）。
 *   2. **字节级**：libuv 的 **16 个** `syscall(425/426/427)` 调用槽由本工具改成
 *      `mov w0,#-1`（`0x12800000`），libuv 拿到 -1 即回退 epoll。
 *      ⇒ 即使将来某条路径绕过 ①，也**不会触发 seccomp 的 SIGSYS**。
 *
 * ⚠️ **广扫只认 `syscall@plt` 桩**（24.9 布局 = vaddr `0x778cb40`，由 `.rela.plt`
 * 符号索引解析确认，`sym 59 = syscall`）。新库里另外 7 处 `movz w0,#427` 后面也跟着
 * `bl`，但目标是 `OBJ_nid2sn` / `ossl_X509_ALGOR_from_nid` / V8 `ExternalReference`
 * —— 427 在那里是 OpenSSL NID 常量，不是系统调用号。**按"movz 后立即跟 bl"广谱
 * 改字节会打断 OpenSSL / V8**，这是 2026-11-05 换库时实测出来的教训（全树 23 处候选，
 * 只有 16 处可改）。
 *
 * 所以本工具的定位是 **"守状态"**，不是"造修复"：
 *   - `--check`  ：核对 16 个调用槽是否都还是 `mov w0,#-1`，并且全文件没有别的活着的
 *                  425/426/427 → `syscall@plt` 路径；
 *   - `--apply`  ：幂等。已经是中性态 ⇒ **一个字节都不写**；只有换进来一份**未中性化**
 *                  的 .so 时才会补上（每个槽先验证"当前确实是原本的 `bl syscall@plt`"，
 *                  否则拒绝写入并打印原因）；写前先备份；
 *   - `--restore`：把 `--orig` 指定的原文件还原回去（默认 `dist/node/libnode.so.137.orig`）。
 *
 * 只改 `.text` 里的 4 字节字，**不动**符号表 / 段表 / 其余任何字节（有 sha 逐字节校验）。
 * ⚠️ 随包件带 `.codesign`（selfSign）：**改完字节必须用 CLT 原生 `binary-sign-tool`
 * 重签**，且工具拒绝给已有 `.codesign` 段的文件再签 ⇒ 需先把该 section 的 sh_name
 * 置 0 再签。本工具不负责签名；换库流程见 `docs/365` §4。
 *
 * ## 用法
 *
 *   node tools/patch-libnode-io-uring.mjs                 # = --check
 *   node tools/patch-libnode-io-uring.mjs --check --json
 *   node tools/patch-libnode-io-uring.mjs --apply         # 幂等；已中性化则 0 字节写入
 *   node tools/patch-libnode-io-uring.mjs --restore       # 从 .orig 还原
 *   node tools/patch-libnode-io-uring.mjs --file=<so> --orig=<bak>
 *
 * 退出码：0 = 干净/成功；1 = 体检判红（有槽不是中性态 / 存在活着的 io_uring 系统调用）；
 *         2 = 拒绝操作（二进制不是预期的那份，或槽里不是预期的原字节）；3 = 用法错误。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 当前随包件：优先 147（Node 26），其次 137（Node 24 回滚基线）。 */
function defaultSo() {
  const p147 = join(ROOT, 'hostruntime/libs/arm64-v8a/libnode.so.147');
  return existsSync(p147) ? p147 : join(ROOT, 'hostruntime/libs/arm64-v8a/libnode.so.137');
}
function defaultOrig(ver) {
  return join(ROOT, `dist/node/libnode.so.${ver}.orig`);
}
const DEFAULT_SO = defaultSo();
const DEFAULT_ORIG = defaultOrig(DEFAULT_SO.endsWith('.147') ? '147' : '137');

// ---------------------------------------------------------------- 已知基线（本仓随包件）
/** 随包 `libnode.so.137` 的字节指纹（= 已中性化状态）。 */
export const SHIPPED = {
  sha256: 'dfe298d0ec52dbf0807623ae673fe2d14a19921ef1751bc47751a8088bb9ed0f',
  size: 155413312,
};

/**
 * Node **v24.9.0 自建件**（2026-11-05 换入）的 `syscall@plt` 桩 vaddr。
 * 由 `.rela.plt` 的符号索引解析确认（sym 59 = `syscall`），不是靠猜偏移。
 * 同时确认另外 3 个被 `movz w0,#427` 后 `bl` 命中的 PLT 桩分别是
 * `OBJ_nid2sn` / `ossl_X509_ALGOR_from_nid` / V8 `ExternalReference` —— 那里的 427 是
 * OpenSSL NID 常量，**不是** io_uring_register 系统调用号，绝不能中性化（docs/365 §1）。
 * 这就是为什么广扫必须只认 syscall 桩：按"movz 后立即跟 bl"广谱改字节会打断 OpenSSL / V8。
 */
export const SYSCALL_STUB = 0x778cb40;
/** 兄弟活体包装器（nr=90）的 bl 位置，用于反推并交叉验证 syscall 桩地址。 */
export const SIBLING_SLOT = 0x48f7620;

/** 定位锚点：确认拿到的就是这份布局，而不是"另一个布局的 .so"。 */
export const ANCHORS = [
  { vaddr: 0x165f541, bytes: Buffer.from('v24.9.0', 'ascii'), what: 'Node 版本字符串 v24.9.0' },
  { vaddr: 0x11308d1, bytes: Buffer.from('libnode.so.137', 'ascii'), what: 'SONAME 字符串' },
  { vaddr: 0x778cb40, word: 0xb0001290, what: 'syscall@plt 桩首条 adrp x16' },
  { vaddr: 0x48f7620, word: 0x94ba5548, what: '兄弟包装器 nr=90 的 bl syscall@plt' },
  { vaddr: 0x4b38e5c, word: 0x94b14f39, what: '兄弟包装器 nr=215 的 bl syscall@plt' },
  { vaddr: 0x4fa0b20, word: 0x910003fd, what: 'uv__io_uring_setup 包装器的 mov x29,sp' },
  { vaddr: 0x4fa0b2c, word: 0x52803520, what: 'SITES[0] 的 movz w0,#425' },
];

/**
 * libuv io_uring 的 17 个系统调用槽（逐个反汇编确认）。
 *   movz  = `movz w0,#NR` 指令处（425=setup / 426=enter / 427=register）
 *   slot  = 本该是 `bl syscall@plt` 的那条指令处；本仓随包件里是 `mov w0,#-1`
 *   orig  = 未中性化时该槽的字节（= bl 到同文件 `syscall@plt` 桩，可由 vaddr 重编码，
 *           已在 0x4f7e954 的活体兄弟包装器上做过编码往返验证）
 */
export const SITES = [
  { nr: 425, movz: 0x4fa0b2c, slot: 0x4fa0b30, orig: 0x949fb004, where: 'uv__io_uring_setup 独立包装器' },
  { nr: 426, movz: 0x4fa0b54, slot: 0x4fa0b60, orig: 0x949faff8, where: 'uv__io_uring_enter 独立包装器' },
  { nr: 427, movz: 0x4fa0b84, slot: 0x4fa0b88, orig: 0x949fafee, where: 'uv__io_uring_register 独立包装器' },
  { nr: 426, movz: 0x4fa11f8, slot: 0x4fa1210, orig: 0x949fae4c, where: 'io_poll 内联的 enter #1' },
  { nr: 426, movz: 0x4fa1354, slot: 0x4fa136c, orig: 0x949fadf5, where: 'io_poll 内联的 enter #2' },
  { nr: 426, movz: 0x4fa148c, slot: 0x4fa14a4, orig: 0x949fada7, where: 'io_poll 内联的 enter #3' },
  { nr: 426, movz: 0x4fa15e8, slot: 0x4fa1600, orig: 0x949fad50, where: 'io_poll 内联的 enter #4' },
  { nr: 426, movz: 0x4fa174c, slot: 0x4fa1764, orig: 0x949facf7, where: 'io_poll 内联的 enter #5' },
  { nr: 426, movz: 0x4fa189c, slot: 0x4fa18b4, orig: 0x949faca3, where: 'io_poll 内联的 enter #6' },
  { nr: 426, movz: 0x4fa19d8, slot: 0x4fa19f0, orig: 0x949fac54, where: 'io_poll 内联的 enter #7' },
  { nr: 426, movz: 0x4fa1b30, slot: 0x4fa1b48, orig: 0x949fabfe, where: 'io_poll 内联的 enter #8' },
  { nr: 426, movz: 0x4fa1c6c, slot: 0x4fa1c84, orig: 0x949fabaf, where: 'io_poll 内联的 enter #9' },
  { nr: 426, movz: 0x4fa1dd0, slot: 0x4fa1de8, orig: 0x949fab56, where: 'io_poll 内联的 enter #10' },
  { nr: 426, movz: 0x4fa1f5c, slot: 0x4fa1f74, orig: 0x949faaf3, where: 'io_poll 内联的 enter #11' },
  { nr: 426, movz: 0x4fa2758, slot: 0x4fa2770, orig: 0x949fa8f4, where: 'io_poll 内联的 enter #12' },
  { nr: 426, movz: 0x4fa2ae8, slot: 0x4fa2b00, orig: 0x949fa810, where: 'io_poll 内联的 enter #13' },
];

/** 中性化字节：`mov w0,#-1`（movn w0,#0）。libuv 看到"系统调用失败"就回退 epoll。 */
export const NEUTRALISED_WORD = 0x12800000;
/** `movz w0,#425/426/427` 的指令字。 */
export const MOVZ_WORD = { 425: 0x52803520, 426: 0x52803540, 427: 0x52803560 };

// ---------------------------------------------------------------- 版本布局表
/**
 * Node **v26.13.0 预编译件**（`libnode.so.147`，119,875,640 B，2026-11-23 换入）的布局。
 * - `syscall@plt` 桩 vaddr `0x7049dc0` 由 `.rela.plt` 符号 `syscall` 解析确认；
 * - 17 个 io_uring 槽逐个反汇编确认（425×2 / 426×14 / 427×1）；
 * - 兄弟包装器 nr=90 / nr=57 的 `bl` 用于反推并交叉验证桩地址；
 * - `pristine` = 换入时的原样（**仍是活的 io_uring**，2026-11-24 手机 SIGSYS 实测的根因）。
 */
export const LAYOUT_147 = {
  soname: 'libnode.so.147',
  size: 119879736,
  pristine: {
    sha256: '9cd15d25724df6604e67c3c0d7cf253fc9cd2d2d79195e7467435e859c058180',
    size: 119875640,
  },
  /** 打完全部槽并重新签名后的目标态（2026-11-24 手机修复轮实填）。 */
  shipped: { sha256: 'c58785c96e224644dd6ba8bb4a7e22aa23257d494f92c59c6878d2581862bcd1', size: 119879736, reSigned: true },
  syscallStub: 0x7049dc0,
  siblings: [
    { slot: 0x3e6ece0, nr: 90 },
    { slot: 0x4550930, nr: 57 },
  ],
  anchors: [
    { vaddr: 0x3f5a29, bytes: Buffer.from('libnode.so.147', 'ascii'), what: 'SONAME 字符串' },
    { vaddr: 0x753f22, bytes: Buffer.from('v26.13.0', 'ascii'), what: 'Node 版本字符串 v26.13.0' },
    { vaddr: 0x7049dc0, word: 0x90000d10, what: 'syscall@plt 桩首条 adrp x16' },
    { vaddr: 0x3e6ece0, word: 0x94c76c38, what: '兄弟包装器 nr=90 的 bl syscall@plt' },
    { vaddr: 0x4550930, word: 0x94abe524, what: '兄弟包装器 nr=57 的 bl syscall@plt' },
    { vaddr: 0x4560204, word: 0x52803520, what: 'SITES[0] 的 movz w0,#425' },
  ],
  sites: [
    { nr: 425, movz: 0x4560204, slot: 0x4560208, where: 'uv__io_uring_setup 独立包装器' },
    { nr: 426, movz: 0x456022c, slot: 0x4560238, where: 'uv__io_uring_enter 独立包装器' },
    { nr: 427, movz: 0x456025c, slot: 0x4560260, where: 'uv__io_uring_register 独立包装器' },
    { nr: 425, movz: 0x45603a4, slot: 0x45603ac, where: 'uv__use_io_uring 门控路径的 setup' },
    { nr: 426, movz: 0x4560a88, slot: 0x4560aa0, where: 'io_poll 内联的 enter #1' },
    { nr: 426, movz: 0x4560cd0, slot: 0x4560ce8, where: 'io_poll 内联的 enter #2' },
    { nr: 426, movz: 0x4560d9c, slot: 0x4560db4, where: 'io_poll 内联的 enter #3' },
    { nr: 426, movz: 0x4560e88, slot: 0x4560ea0, where: 'io_poll 内联的 enter #4' },
    { nr: 426, movz: 0x4560f80, slot: 0x4560f98, where: 'io_poll 内联的 enter #5' },
    { nr: 426, movz: 0x456105c, slot: 0x4561074, where: 'io_poll 内联的 enter #6' },
    { nr: 426, movz: 0x456111c, slot: 0x4561134, where: 'io_poll 内联的 enter #7' },
    { nr: 426, movz: 0x4561200, slot: 0x4561218, where: 'io_poll 内联的 enter #8' },
    { nr: 426, movz: 0x45612c8, slot: 0x45612e0, where: 'io_poll 内联的 enter #9' },
    { nr: 426, movz: 0x45613bc, slot: 0x45613d4, where: 'io_poll 内联的 enter #10' },
    { nr: 426, movz: 0x45614e8, slot: 0x4561500, where: 'io_poll 内联的 enter #11' },
    { nr: 426, movz: 0x4561b90, slot: 0x4561ba8, where: 'io_poll 内联的 enter #12' },
    { nr: 426, movz: 0x4561d98, slot: 0x4561db0, where: 'io_poll 内联的 enter #13' },
  ],
};

export const LAYOUTS = {
  '137': {
    soname: 'libnode.so.137',
    size: SHIPPED.size,
    shipped: SHIPPED,
    pristine: { sha256: null, size: 155413312 },
    syscallStub: SYSCALL_STUB,
    siblings: [
      { slot: SIBLING_SLOT, nr: 90 },
      { slot: 0x4b38e5c, nr: 215 },
    ],
    anchors: ANCHORS,
    sites: SITES,
  },
  '147': LAYOUT_147,
};

/** 依据 SONAME 字符串识别布局；认不出就拒绝（绝不盲改）。 */
export function detectLayout(buf) {
  if (buf.includes(Buffer.from('libnode.so.147\0', 'ascii'))) return { ver: '147', layout: LAYOUTS['147'] };
  if (buf.includes(Buffer.from('libnode.so.137\0', 'ascii'))) return { ver: '137', layout: LAYOUTS['137'] };
  throw new Error('认不出 libnode 版本（找不到 SONAME 字符串 libnode.so.137/147）');
}

// ---------------------------------------------------------------- ELF 小工具
const u32 = (x) => x >>> 0;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function readElf(buf) {
  if (buf.length < 64 || buf.readUInt32LE(0) !== 0x464c457f) throw new Error('不是 ELF 文件');
  if (buf[4] !== 2) throw new Error('不是 ELF64');
  if (buf[5] !== 1) throw new Error('不是小端');
  const machine = buf.readUInt16LE(0x12);
  if (machine !== 183) throw new Error(`不是 AArch64（e_machine=${machine}）`);
  const phoff = Number(buf.readBigUInt64LE(0x20));
  const phentsize = buf.readUInt16LE(0x36);
  const phnum = buf.readUInt16LE(0x38);
  const segs = [];
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    if (buf.readUInt32LE(o) !== 1) continue; // PT_LOAD
    const flags = buf.readUInt32LE(o + 4);
    segs.push({
      off: Number(buf.readBigUInt64LE(o + 8)),
      va: Number(buf.readBigUInt64LE(o + 16)),
      fsz: Number(buf.readBigUInt64LE(o + 32)),
      exec: (flags & 1) !== 0,
    });
  }
  if (!segs.length) throw new Error('没有 PT_LOAD 段');
  return { segs, exec: segs.filter((s) => s.exec && s.fsz > 0) };
}

function mapper(elf, label) {
  return (va, len = 1) => {
    for (const s of elf.segs) {
      if (va >= s.va && va + len <= s.va + s.fsz) return s.off + (va - s.va);
    }
    throw new Error(`${label}: vaddr 0x${va.toString(16)} 不在任何 PT_LOAD 段内`);
  };
}

const readWord = (buf, off) => u32(buf.readUInt32LE(off));

/** 某个槽"未中性化"时应有的指令字（`bl syscall@plt`）；布局里显式给了 orig 就用它。 */
export function originalWordOf(site, syscallStub) {
  return site.orig !== undefined ? u32(site.orig) : encodeBl(site.slot, syscallStub);
}

function decodeBlTarget(word, pc) {
  const imm26 = u32(word) & 0x3ffffff;
  const signed = imm26 & 0x2000000 ? imm26 - 0x4000000 : imm26;
  return pc + signed * 4;
}
const encodeBl = (pc, target) => u32(0x94000000 | (((target - pc) >> 2) & 0x3ffffff));

function isBl(word) {
  return u32(word) >>> 26 === 0x25; // BL 的 opcode 位
}
function isMovzW0(word, nr) {
  return u32(word) === MOVZ_WORD[nr];
}

// ---------------------------------------------------------------- 体检
/**
 * @returns {{ok:boolean, failures:string[], notes:string[], sha256:string, size:number,
 *            sites:Array<{nr:number,slot:number,state:string,word:number}>, liveCalls:Array<object>}}
 */
export function inspect(file = DEFAULT_SO) {
  const buf = readFileSync(file);
  const elf = readElf(buf);
  const at = mapper(elf, 'file');
  const exec = elf.exec;
  if (!exec.length) throw new Error('没有可执行 PT_LOAD 段');

  const { ver, layout } = detectLayout(buf);
  const sha = sha256(buf);
  const failures = [];
  const notes = [];
  const sites = [];
  notes.push(`布局 = libnode.so.${ver}（${layout.sites.length} 个 io_uring 槽）`);

  // 1) 锚点
  for (const a of layout.anchors) {
    if (a.bytes) {
      const off = at(a.vaddr, a.bytes.length);
      const got = buf.subarray(off, off + a.bytes.length);
      if (!got.equals(a.bytes)) {
        failures.push(
          `锚点不符：0x${a.vaddr.toString(16)} 期望 ${a.bytes.toString('hex')}，实到 ${got.toString('hex')}（${a.what}）`
        );
      }
    } else {
      const got = readWord(buf, at(a.vaddr, 4));
      if (got !== a.word) {
        failures.push(
          `锚点不符：0x${a.vaddr.toString(16)} 期望 0x${u32(a.word).toString(16)}，实到 0x${got.toString(16)}（${a.what}）`
        );
      }
    }
  }

  // 2) 反推 syscall@plt 桩地址（用活体兄弟包装器），并与 .rela.plt 解析出的常量交叉验证。
  //    ⚠️ 这一条是"假绿"的分水岭：旧版把桩地址从写死的锚点反推，换版后反推出一个
  //    不存在的地址 ⇒ 广扫里所有 bl 都不匹配 ⇒ 明明 23 处 movz+bl 却报"无活体"。
  //    现在桩地址有常量兜底 + 编码往返 + 布局锚点三重校验，漂移必然判红。
  let syscallStub = layout.syscallStub;
  for (const sib of layout.siblings) {
    const siblingBl = readWord(buf, at(sib.slot, 4));
    const stub = decodeBlTarget(siblingBl, sib.slot);
    if (stub !== layout.syscallStub) {
      failures.push(
        `syscall@plt 桩漂移：兄弟(nr=${sib.nr}) 0x${sib.slot.toString(16)} 反推 0x${stub.toString(16)} ≠ 记录 0x${layout.syscallStub.toString(16)}`
      );
    }
    if (encodeBl(sib.slot, stub) !== u32(siblingBl)) {
      failures.push(`bl 编码往返自检失败（0x${sib.slot.toString(16)}）`);
    }
  }
  notes.push(`syscall@plt 桩 = 0x${syscallStub.toString(16)}`);

  // 3) 全部槽
  for (const s of layout.sites) {
    const movzWord = readWord(buf, at(s.movz, 4));
    if (!isMovzW0(movzWord, s.nr)) {
      failures.push(
        `0x${s.movz.toString(16)} 不是 movz w0,#${s.nr}（实到 0x${movzWord.toString(16)}；${s.where}）`
      );
    }
    const origWord = s.orig !== undefined ? u32(s.orig) : encodeBl(s.slot, syscallStub);
    const word = readWord(buf, at(s.slot, 4));
    let state;
    if (u32(word) === NEUTRALISED_WORD) state = 'neutralised';
    else if (u32(word) === origWord) state = 'UNPATCHED';
    else if (isBl(word) && decodeBlTarget(word, s.slot) === syscallStub) state = 'UNPATCHED';
    else state = 'UNEXPECTED';
    sites.push({ nr: s.nr, slot: s.slot, movz: s.movz, state, word: u32(word), where: s.where });
  }
  const bad = sites.filter((s) => s.state !== 'neutralised');
  if (bad.length) {
    failures.push(
      `${bad.length}/${sites.length} 个 io_uring 系统调用槽不是中性态：` +
        bad
          .map((b) => `0x${b.slot.toString(16)}=0x${b.word.toString(16)}(${b.state}/${b.nr})`)
          .join(', ')
    );
  }

  // 4) 全文件广扫：还有没有"活着的" io_uring 系统调用路径
  //    规则：movz w0,#425|426|427 之后 12 条内首次遇到 bl/svc 且目标就是 syscall 桩 ⇒ 活体。
  //    （libuv 在 musl 下走 syscall()，系统调用号在 x0；x8 那种是 V8 Runtime 函数号，不是 syscall。）
  const liveCalls = [];
  for (const seg of exec) {
    for (let i = 0; i + 64 <= seg.fsz; i += 4) {
      const w = readWord(buf, seg.off + i);
      let nr = 0;
      for (const n of [425, 426, 427]) if (isMovzW0(w, n)) nr = n;
      if (!nr) continue;
      const va = seg.va + i;
      for (let k = 1; k <= 12; k++) {
        const va2 = va + k * 4;
        const w2 = readWord(buf, seg.off + i + k * 4);
        if (u32(w2) === 0xd4000001) {
          liveCalls.push({ nr, movzAt: va, at: va2, kind: 'svc' });
          break;
        }
        if (isBl(w2)) {
          if (decodeBlTarget(w2, va2) === syscallStub) liveCalls.push({ nr, movzAt: va, at: va2, kind: 'bl' });
          break; // 任何 bl 都是"这条路径到此为止"（不是 syscall 就不是 io_uring）
        }
        if (u32(w2) === 0xd65f03c0 || wallUncondBranch(w2)) break;
        if (u32(w2) === NEUTRALISED_WORD) break; // 已经被我们的中性化吃掉
      }
    }
  }
  if (liveCalls.length) {
    failures.push(
      `存在 ${liveCalls.length} 处活着的 io_uring 系统调用路径：` +
        liveCalls.map((c) => `nr=${c.nr}@0x${c.at.toString(16)}`).join(', ')
    );
  } else {
    notes.push('全文件广扫：没有活着的 io_uring_setup/enter/register 路径');
  }

  return { ok: failures.length === 0, failures, notes, sha256: sha, size: buf.length, sites, liveCalls, syscallStub, ver };
}
const wallUncondBranch = (w) => u32(w) >>> 26 === 0x05; // B

// ---------------------------------------------------------------- 动作
function doCheck(file) {
  const r = inspect(file);
  if (r.ok) {
    console.log(`✅ ${file}`);
    console.log(`   sha256 ${r.sha256}`);
    console.log(`   libuv io_uring 系统调用槽 ${r.sites.length}/${r.sites.length} 全部为 mov w0,#-1（不触发 seccomp）`);
    for (const n of r.notes) console.log(`   · ${n}`);
    return 0;
  }
  console.error(`❌ ${file}`);
  for (const f of r.failures) console.error(`   · ${f}`);
  return 1;
}

function doApply(file, origPath, { json = false } = {}) {
  const before = inspect(file);
  if (before.ok) {
    console.log('✅ 已经是中性态：一个字节都不写（幂等）');
    console.log(`   sha256 ${before.sha256}（未变）`);
    return 0;
  }
  // 只允许"未中性化"这一种情况被修；其余（布局不对/锚点不符/字节不是原值）一律拒绝
  const unexpected = before.sites.filter((s) => s.state === 'UNEXPECTED');
  const unpatched = before.sites.filter((s) => s.state === 'UNPATCHED');
  if (unexpected.length || unpatched.length !== before.sites.length) {
    console.error('⛔ 拒绝写入：目标不是"整份未中性化的已知布局"。');
    for (const f of before.failures) console.error(`   · ${f}`);
    console.error('   （逐个槽的当前值见 --check --json；只接受"全部等于记录的原字节"这一种输入）');
    return 2;
  }

  const buf = readFileSync(file);
  const elf = readElf(buf);
  const at = mapper(elf, 'file');
  const { ver, layout } = detectLayout(buf);
  const touched = [];
  for (const s of layout.sites) {
    const off = at(s.slot, 4);
    const cur = readWord(buf, off);
    const origWord = s.orig !== undefined ? u32(s.orig) : encodeBl(s.slot, layout.syscallStub);
    if (u32(cur) !== origWord) {
      console.error(`⛔ 拒绝写入：0x${s.slot.toString(16)} 当前 0x${cur.toString(16)} ≠ 记录原值 0x${origWord.toString(16)}（${s.where}）`);
      return 2;
    }
    buf.writeUInt32LE(NEUTRALISED_WORD, off);
    touched.push({ slot: s.slot, nr: s.nr, from: u32(cur), to: NEUTRALISED_WORD });
  }
  console.log(`   布局 libnode.so.${ver}`);

  if (origPath) {
    if (!existsSync(origPath)) {
      copyFileSync(file, origPath);
      console.log(`📦 备份 → ${origPath}（sha256 见下）`);
    } else {
      console.log(`📦 备份已存在，不覆盖：${origPath}`);
    }
  }

  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, buf);
  try {
    copyFileSync(tmp, file);
    unlinkSync(tmp);
  } catch (e) {
    /*
     * 【OHOS 文件系统实测】随包件由 file_manager 组持有、目标文件本身不可写时，
     * copyfile(2) 会 EPERM（哪怕目录可写、tmp 能建）。rename(2) 只需要目录权限，
     * 是同语义的原子替换 —— 这里降级用它，别再让 --apply 半途而废。
     */
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) {
      renameSync(tmp, file);
    } else {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
  }

  const after = inspect(file);
  console.log(`🔧 写入 ${touched.length * 4} 字节（${touched.length} 处 × 4B，只改 .text 里的系统调用槽）`);
  for (const t of touched) {
    console.log(`   va 0x${t.slot.toString(16)}  nr=${t.nr}  0x${t.from.toString(16)} → 0x${t.to.toString(16)}`);
  }
  console.log(`   sha256 ${sha256(readFileSync(file))}`);
  console.log(`   复核：${after.ok ? '✅ 通过' : '❌ 仍判红'}`);
  return after.ok ? 0 : 1;
}

function doRestore(file, origPath) {
  if (!existsSync(origPath)) {
    console.error(`⛔ 没有备份文件：${origPath}`);
    console.error('   还原需要一个"改动前"的副本；本仓随包件的原样副本应放在该路径（见 docs/203）。');
    return 2;
  }
  const cur = sha256(readFileSync(file));
  const bak = sha256(readFileSync(origPath));
  if (cur === bak) {
    console.log('✅ 当前文件与备份逐字节相同：不需要写回（幂等）');
    console.log(`   sha256 ${cur}`);
    return 0;
  }
  copyFileSync(origPath, file);
  const now = sha256(readFileSync(file));
  console.log(`♻️  已从备份还原：${origPath}`);
  console.log(`   ${cur} → ${now}`);
  return now === bak ? 0 : 1;
}

function main(argv) {
  const args = argv.slice(2);
  const opt = (name, def = null) => {
    const hit = args.find((a) => a === name || a.startsWith(`${name}=`));
    if (!hit) return def;
    if (hit === name) return true;
    return hit.slice(name.length + 1);
  };
  if (opt('--help', false) || opt('-h', false)) {
    console.log('用法：node tools/patch-libnode-io-uring.mjs [--check|--apply|--restore] [--file=<so>] [--orig=<bak>] [--json]');
    return 0;
  }
  const file = resolve(opt('--file', DEFAULT_SO));
  const orig = resolve(opt('--orig', DEFAULT_ORIG));
  const json = !!opt('--json', false);
  if (!existsSync(file)) {
    console.error(`找不到文件：${file}`);
    return 3;
  }
  if (json) {
    const r = inspect(file);
    console.log(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 1;
  }
  if (opt('--apply', false)) return doApply(file, orig, { json });
  if (opt('--restore', false)) return doRestore(file, orig);
  return doCheck(file);
}

// 只在"被当脚本直接跑"时执行 main；被门禁 import 时安静地只导出判据。
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv);
}
