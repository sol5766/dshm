#!/usr/bin/env node
/**
 * 门禁：随包 `libnode.so.137` 的 libuv io_uring 必须"打不出来"（离线，不需要设备）。
 *
 * ## 治的是什么
 *
 * `dist/triage/2026-10-19/APMS.md` §4.3：1.1.4 的 1979 次崩溃里 1951 次是同一台设备的
 * `Signal:SIGSYS(SYS_SECCOMP) syscall number is 425` 循环；arm64 上 425 = `io_uring_setup`，
 * 鸿蒙的 seccomp **不返回 EPERM，直接 SIGSYS 杀进程**。`docs/50` E42 当年在 Node v22 源码树里
 * 给 `uv__use_io_uring()` 加 `return 0` 修过；`docs/203` 把 v24 预编译件的现状核清。
 *
 * 关键结论（本门禁钉的就是它）：**修法不是"让 `uv__use_io_uring()` 返回 0"，而是让
 * `syscall(425/426/427)` 永不真正发出**。随包件里 libuv 的 17 个 io_uring 系统调用槽已经全是
 * `mov w0,#-1`（见 `tools/patch-libnode-io-uring.mjs` 的 `SITES`），libuv 拿到 -1 即回退 epoll。
 *
 * ## 判据
 *
 *   A 身份：`hostruntime/libs/arm64-v8a/libnode.so.137` 的 sha256 / 字节数 == 记录值；
 *   B 中性态：16/16 系统调用槽 == `mov w0,#-1`（`00 00 80 12`），定位锚点全部对上
 *     （含 `v24.9.0` 版本串与 `syscall@plt` 桩首字节；桩地址由 `.rela.plt` 符号解析
 *      钉死，广扫只认它 —— 否则 OpenSSL NID 常量 427 会被误判，见 docs/365 §1），
 *     全文件广扫**没有**活着的 425/426/427 → syscall 路径；
 *   C 幂等：`patch-libnode-io-uring.mjs --check` 连跑两次都绿，且**文件 sha256 不变**
 *     （`--apply` 在已是中性态时一个字节都不写）；
 *   D 对照臂①：临时副本把 1 个槽改回原本的 `bl syscall@plt` ⇒ 必须判红；
 *   E 对照臂②：临时副本把 17 个槽全改回去 ⇒ 必须判红（且报出 count=17）；
 *   F 备份：`dist/node/libnode.so.137.orig` 必须存在且与随包件逐字节相同（`--restore` 才有意义）；
 *   G 接线：`.github/workflows/gates.yml` 里必须挂着本门禁与它的 `--self-test`。
 *
 * `--self-test` 另外跑（更重、会写临时副本）：
 *   H 往返：把全部槽改回去得到"假想的未中性化件"，`--apply` 后 sha256 必须**逐字节回到**随包值
 *     （证明"随包件 = 未中性化件 + N×4 字节"，也就是中性化集合既不多也不少）；
 *   I 回退：`--restore` 后必须回到未中性化的 sha256；
 *   J 拒绝：槽里塞入既非中性化也非原值的字（0xdeadbeef）⇒ `--apply` 必须**拒绝写入**（exit 2）。
 *
 * 退出码：0 通过 / 1 判红 / 3 前置条件不成立（文件缺失）。
 *
 * 用法：
 *   node tools/check-libnode-io-uring.mjs
 *   node tools/check-libnode-io-uring.mjs --self-test
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect, NEUTRALISED_WORD, LAYOUTS, originalWordOf } from './patch-libnode-io-uring.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/* 随包件按"谁在 libs 里"选：147（Node 26）优先，137 仅作回滚基线。 */
const SO_147 = join(ROOT, 'hostruntime/libs/arm64-v8a/libnode.so.147');
const SO_137 = join(ROOT, 'hostruntime/libs/arm64-v8a/libnode.so.137');
const VER = existsSync(SO_147) ? '147' : '137';
const SO = VER === '147' ? SO_147 : SO_137;
const ORIG = join(ROOT, `dist/node/libnode.so.${VER}.orig`);
const LAYOUT = LAYOUTS[VER];
const SITES = LAYOUT.sites;
const SHIPPED = LAYOUT.shipped;
const ANCHORS = LAYOUT.anchors;
const TOOL = join(ROOT, 'tools/patch-libnode-io-uring.mjs');
const GATES_YML = join(ROOT, '.github/workflows/gates.yml');
const UV_SOURCE_PATCH = join(ROOT, 'tools/node-runtime/fix-uv-io-uring.sh');

/*
 * 【2026-11-24 重写：147 不再跳过】
 * 换 147 时本门禁曾"按设计跳过"，理由是"字节补丁偏移不适用 + UV_USE_IO_URING=0 兜底"。
 * 手机真机实测推翻了这个前提：`UV_USE_IO_URING=0` 拦不住普通 flags=0 路径，手机 seccomp 在
 * `node-MainThread` 上直接 SIGSYS 杀进程（`DfxSignalHandler :: signo(31), si_code(1)`）。
 * 现在 147 有了自己的布局（`LAYOUTS['147']`）与 17 个槽，判红/对照臂逐项同 137。
 */

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, detail = '') {
  pass++;
  console.log(`  ✅ ${name}${detail ? `：${detail}` : ''}`);
}
function bad(name, detail = '') {
  fail++;
  failures.push(`${name}${detail ? `：${detail}` : ''}`);
  console.log(`  ❌ ${name}${detail ? `：${detail}` : ''}`);
}
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// ---------------------------------------------------------------- 临时副本的写入位置
// 不写死 .text 段偏移：换版后布局全变（24.2.0 → 24.9.0 实测所有锚点失效），
// 一律由 ELF 的 PT_LOAD 段自己算 vaddr → file offset。
function vaToFileOffset(buf, va) {
  const phoff = Number(buf.readBigUInt64LE(0x20));
  const phentsize = buf.readUInt16LE(0x36);
  const phnum = buf.readUInt16LE(0x38);
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    if (buf.readUInt32LE(o) !== 1) continue;
    const off = Number(buf.readBigUInt64LE(o + 8));
    const segVa = Number(buf.readBigUInt64LE(o + 16));
    const fsz = Number(buf.readBigUInt64LE(o + 32));
    if (va >= segVa && va + 4 <= segVa + fsz) return off + (va - segVa);
  }
  throw new Error(`vaddr 0x${va.toString(16)} 不在任何 PT_LOAD 段内`);
}

function makeCopy(dir, name, mutate) {
  const dst = join(dir, name);
  copyFileSync(SO, dst);
  if (mutate) {
    const buf = readFileSync(dst);
    mutate(buf, (va) => vaToFileOffset(buf, va));
    writeFileSync(dst, buf);
  }
  return dst;
}

function runTool(args) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function main() {
  const selfTestOnly = process.argv.includes('--self-test');
  console.log(selfTestOnly ? '# libnode io_uring 门禁自检（对照臂）' : '# libnode io_uring 门禁');

  if (!existsSync(SO)) {
    console.error(`找不到 ${SO}`);
    return 3;
  }

  const before = sha256(SO);
  const report = inspect(SO);

  if (!selfTestOnly) {
    // ---------------- A 身份
    console.log('\n## A 身份');
    if (report.size === SHIPPED.size) ok('字节数', `${report.size}`);
    else bad('字节数', `期望 ${SHIPPED.size}，实到 ${report.size}`);
    if (before === SHIPPED.sha256) ok('sha256', before);
    else bad('sha256', `期望 ${SHIPPED.sha256}，实到 ${before}`);

    // ---------------- B 中性态
    console.log('\n## B libuv io_uring 系统调用槽全是 mov w0,#-1');
    const anchorsBad = report.failures.filter((f) => f.startsWith('锚点不符'));
    if (!anchorsBad.length) ok(`${ANCHORS.length} 个定位锚点`, '全部对上（含 v24.9.0 版本串与 syscall@plt 桩）');
    else bad('定位锚点', anchorsBad.join('; '));

    const neutral = report.sites.filter((s) => s.state === 'neutralised');
    if (neutral.length === SITES.length) {
      ok('系统调用槽', `${neutral.length}/${SITES.length} == 0x${NEUTRALISED_WORD.toString(16)}（mov w0,#-1）`);
    } else {
      bad(
        '系统调用槽',
        `${neutral.length}/${SITES.length}；异常：${report.sites
          .filter((s) => s.state !== 'neutralised')
          .map((s) => `0x${s.slot.toString(16)}=0x${s.word.toString(16)}(${s.state})`)
          .join(', ')}`
      );
    }
    const byNr = SITES.reduce((m, s) => ((m[s.nr] = (m[s.nr] || 0) + 1), m), {});
    ok('覆盖三件套', `setup(425)×${byNr[425]} / enter(426)×${byNr[426]} / register(427)×${byNr[427]}`);

    if (!report.liveCalls.length) ok('全文件广扫', '没有活着的 io_uring_setup/enter/register 路径');
    else
      bad(
        '全文件广扫',
        `发现 ${report.liveCalls.length} 处活体：` +
          report.liveCalls.map((c) => `nr=${c.nr}@0x${c.at.toString(16)}`).join(', ')
      );

    // ---------------- C 幂等（连跑两次，文件字节不变）
    console.log('\n## C patch 工具幂等');
    const r1 = runTool(['--check']);
    const r2 = runTool(['--check']);
    if (r1.code === 0 && r2.code === 0) ok('--check 连跑两次', '均 exit 0');
    else bad('--check 连跑两次', `exit ${r1.code} / ${r2.code}`);
    const rApply = runTool(['--apply']);
    const afterApply = sha256(SO);
    if (rApply.code === 0 && afterApply === before) ok('--apply 幂等', '退出 0 且 0 字节写入（sha256 未变）');
    else bad('--apply 幂等', `exit ${rApply.code}，sha ${before} → ${afterApply}`);

    // ---------------- F 备份
    console.log('\n## F 回退备份');
    if (!existsSync(ORIG)) bad('备份存在', `缺 ${ORIG}`);
    else {
      const o = sha256(ORIG);
      /* 147：备份是"换入时的原样（含活体 io_uring）"；137：备份与随包件逐字节相同。 */
      const expect = LAYOUT.pristine && LAYOUT.pristine.sha256 ? LAYOUT.pristine.sha256 : before;
      if (o === expect) ok(LAYOUT.pristine && LAYOUT.pristine.sha256 ? '备份 == 换入原样（未中性化件）' : '备份 == 随包件', o);
      else bad('备份内容', `备份 ${o} ≠ 期望 ${expect}`);
    }

    // ---------------- G CI 接线
    console.log('\n## G CI 接线');
    const yml = existsSync(GATES_YML) ? readFileSync(GATES_YML, 'utf8') : '';
    if (yml.includes('node tools/check-libnode-io-uring.mjs')) ok('gates.yml 挂了本门禁');
    else bad('gates.yml 挂了本门禁', '缺少 `run: node tools/check-libnode-io-uring.mjs`');
    if (yml.includes('node tools/check-libnode-io-uring.mjs --self-test')) ok('gates.yml 挂了 --self-test');
    else bad('gates.yml 挂了 --self-test', '缺少 `run: node tools/check-libnode-io-uring.mjs --self-test`');
    // v22 源码树那条老路还在（自建 libnode.so.127 时用）
    if (!existsSync(UV_SOURCE_PATCH)) bad('v22 源码补丁脚本在', `缺 ${UV_SOURCE_PATCH}`);
    else {
      const s = readFileSync(UV_SOURCE_PATCH, 'utf8');
      if (/return 0;/.test(s) && /uv__use_io_uring/.test(s)) ok('v22 源码补丁仍在', 'fix-uv-io-uring.sh 的 return 0 早退');
      else bad('v22 源码补丁仍在', 'fix-uv-io-uring.sh 里找不到 uv__use_io_uring 的 return 0 早退');
    }
  }

  // ---------------- D/E 对照臂：改回原字节必须判红
  console.log('\n## D/E 对照臂（临时副本，绝不碰真文件）');
  const tmp = mkdtempSync(join(tmpdir(), 'dshm-libnode-gate-'));
  try {
    const orig = (s) => originalWordOf(s, LAYOUT.syscallStub);
    const one = makeCopy(tmp, 'one-reverted.so', (buf, off) => {
      buf.writeUInt32LE(orig(SITES[0]), off(SITES[0].slot));
    });
    const oneReport = inspect(one);
    const oneCli = runTool(['--check', `--file=${one}`]);
    if (oneReport.ok === false && oneReport.sites.some((s) => s.state === 'UNPATCHED')) {
      ok('对照臂①（1 个槽改回 bl syscall）', '判据判红');
    } else {
      bad('对照臂①（1 个槽改回 bl syscall）', '居然还是绿的 —— 判据没牙');
    }
    if (oneCli.code === 1) ok('对照臂① 工具也判红', `exit ${oneCli.code}`);
    else bad('对照臂① 工具也判红', `exit ${oneCli.code}（应 1）`);

    const all = makeCopy(tmp, 'all-reverted.so', (buf, off) => {
      for (const s of SITES) buf.writeUInt32LE(orig(s), off(s.slot));
    });
    const allReport = inspect(all);
    const unpatchedCount = allReport.sites.filter((s) => s.state === 'UNPATCHED').length;
    if (allReport.ok === false && unpatchedCount === SITES.length) {
      ok(`对照臂②（${SITES.length} 个槽全改回）`, `判红且 count=${unpatchedCount}`);
    } else {
      bad(`对照臂②（${SITES.length} 个槽全改回）`, `ok=${allReport.ok} count=${unpatchedCount}`);
    }

    // ---------------- H/I/J 往返与拒绝（只在 --self-test 跑）
    if (selfTestOnly) {
      console.log('\n## H/I/J 往返与拒绝（--self-test）');
      const work = join(tmp, 'work.so');
      const workOrig = join(tmp, 'work.so.orig');
      copyFileSync(all, work);
      copyFileSync(all, workOrig);
      const unpatched = sha256(all);

      const applied = runTool(['--apply', `--file=${work}`, `--orig=${workOrig}`]);
      const afterApply = sha256(work);
      if (applied.code === 0 && afterApply === SHIPPED.sha256) {
        ok('H 往返逐字节', `未中性化 ${unpatched.slice(0, 16)}… + ${SITES.length}×4B ⇒ ${afterApply.slice(0, 16)}… == 随包件`);
      } else {
        bad('H 往返逐字节', `exit ${applied.code}，sha ${afterApply}（期望 ${SHIPPED.sha256}）`);
      }

      const restored = runTool(['--restore', `--file=${work}`, `--orig=${workOrig}`]);
      if (restored.code === 0 && sha256(work) === unpatched) ok('I --restore 回到原状', unpatched.slice(0, 16) + '…');
      else bad('I --restore 回到原状', `exit ${restored.code}，sha ${sha256(work)}`);

      const weird = makeCopy(tmp, 'weird.so', (buf, off) => {
        buf.writeUInt32LE(0xdeadbeef, off(SITES[3].slot));
      });
      const weirdBefore = sha256(weird);
      const neverOrig = join(tmp, 'never.orig');
      const refused = runTool(['--apply', `--file=${weird}`, `--orig=${neverOrig}`]);
      if (refused.code === 2) ok('J 未知字节 ⇒ 拒绝写入', 'exit 2');
      else bad('J 未知字节 ⇒ 拒绝写入', `exit ${refused.code}（应 2）`);
      if (sha256(weird) === weirdBefore && !existsSync(neverOrig)) {
        ok('J 拒绝时确实没写', '目标文件未变、也没建备份');
      } else {
        bad('J 拒绝时确实没写', `sha ${weirdBefore} → ${sha256(weird)}，备份存在=${existsSync(neverOrig)}`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // ---------------- 真文件是否被动过
  console.log('\n## 收尾');
  if (sha256(SO) === before) ok('真文件全程未被改动', before.slice(0, 16) + '…');
  else bad('真文件全程未被改动', `${before} → ${sha256(SO)}`);

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed / ${fail} failed`);
  if (fail) {
    console.error('\n判红明细：');
    for (const f of failures) console.error(`  · ${f}`);
  }
  return fail === 0 ? 0 : 1;
}

process.exitCode = main();
