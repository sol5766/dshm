#!/usr/bin/env node
/**
 * 门禁：guest 基础组件归档必须齐、必须是可解压的 tar.gz、且关键路径在里面。
 *
 * 【为什么守它】2026-11-05 补了 13 个 guest 归档（libcurl 闭包 + pnpm + dsh），
 * 它们不在 npm/构建图里，删掉/改名不会有任何编译错误，只会在真机 guest 里表现为
 * "git 远端缺 libcurl"或"pnpm/dsh 不存在"。这里做成离线判据：
 *   ① 每个前缀至少一份 `*.tar.gz`；
 *   ② gzip 头合法、能完整解压；
 *   ③ libcurl 归档里有 `usr/lib/libcurl.so.4`；pnpm 有 `opt/dshm/pnpm/bin/pnpm.cjs`
 *      与 `usr/bin/pnpm`；dsh 有 `usr/bin/dsh`。
 * 对照臂（--self-test）：删一个前缀 / 把归档内容换成垃圾 / 损坏 gzip ⇒ 必须判红。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

const DIR = 'hostruntime/src/main/resources/resfile/vm/guestpkgs';
const GROUPS = [
  { prefix: 'libcurl-', need: ['usr/lib/libcurl.so.4'] },
  { prefix: 'libcrypto3-', need: ['usr/lib/'] },
  { prefix: 'libssl3-', need: ['usr/lib/'] },
  { prefix: 'brotli-libs-', need: ['usr/lib/'] },
  { prefix: 'c-ares-', need: ['usr/lib/'] },
  { prefix: 'nghttp2-libs-', need: ['usr/lib/'] },
  { prefix: 'libidn2-', need: ['usr/lib/'] },
  { prefix: 'libunistring-', need: ['usr/lib/'] },
  { prefix: 'libpsl-', need: ['usr/lib/'] },
  { prefix: 'zlib-', need: ['usr/lib/'] },
  { prefix: 'zstd-libs-', need: ['usr/lib/'] },
  { prefix: 'pnpm-', need: ['opt/dshm/pnpm/bin/pnpm.cjs', 'usr/bin/pnpm'] },
  { prefix: 'dsh-', need: ['usr/bin/dsh'] },
];

function judge(dir) {
  const problems = [];
  if (!existsSync(dir)) return [`目录不存在：${dir}`];
  const files = readdirSync(dir).filter((n) => n.endsWith('.tar.gz'));
  for (const g of GROUPS) {
    const hit = files.find((n) => n.startsWith(g.prefix));
    if (hit === undefined) { problems.push(`缺归档：${g.prefix}*.tar.gz`); continue; }
    let raw;
    try {
      raw = gunzipSync(readFileSync(join(dir, hit)));
    } catch (e) {
      problems.push(`${hit} 不是有效 gzip：${String(e && e.message).slice(0, 80)}`);
      continue;
    }
    const text = raw.toString('latin1');
    for (const p of g.need) {
      if (!text.includes(p)) problems.push(`${hit} 缺路径：${p}`);
    }
  }
  return problems;
}

const selfTest = process.argv.includes('--self-test');
const base = judge(DIR);

if (!selfTest) {
  if (base.length > 0) {
    console.error(`❌ guest 基础组件归档不完整（${base.length} 处）：`);
    for (const p of base) console.error(`   · ${p}`);
    process.exit(1);
  }
  console.log(`✅ 通过：${GROUPS.length} 组 guest 归档齐全，gzip 可解，关键路径都在。`);
  process.exit(0);
}

console.log('--self-test：变异体必须判红 --');
let failures = 0;
if (base.length !== 0) { failures += 1; console.error(`基线应为 0，实际 ${base.length}`); }

const scratch = mkdtempSync(join(tmpdir(), 'dshm-guestpkgs-'));
try {
  const seed = (name, body) => writeFileSync(join(scratch, name), body);
  for (const g of GROUPS) {
    seed(`${g.prefix}1-r0.tar.gz`, gzipSync(Buffer.from(g.need.join('\n'))));
  }
  const good = judge(scratch);
  if (good.length !== 0) { failures += 1; console.error(`  ✗ 合成基线不应判红：${good[0]}`); } else { console.log('  ✓ 合成基线全绿'); }

  const cases = [
    ['删掉 libcurl 归档', () => rmSync(join(scratch, 'libcurl-1-r0.tar.gz'))],
    ['把 pnpm 归档内容换掉', () => writeFileSync(join(scratch, 'pnpm-1-r0.tar.gz'), gzipSync(Buffer.from('nope')))],
    ['损坏 dsh 的 gzip', () => writeFileSync(join(scratch, 'dsh-1-r0.tar.gz'), Buffer.from([0x1f, 0x8b, 0x00]))],
  ];
  for (const [label, mutate] of cases) {
    mutate();
    const problems = judge(scratch);
    if (problems.length === 0) { failures += 1; console.error(`  ✗ ${label}：判据没判红`); }
    else console.log(`  ✓ ${label} ⇒ 判红（${problems[0]}）`);
  }
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* 尽力 */ }
}
console.log(failures === 0 ? '✅ 自检通过' : `❌ 自检失败（${failures}）`);
process.exit(failures === 0 ? 0 : 1);