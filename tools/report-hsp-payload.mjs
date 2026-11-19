#!/usr/bin/env node
/**
 * 报表工具：按 `hostruntime/payload.manifest.json` 统计一份 HSP（或目录）的
 * 「公共 / 仅原生档 / 仅 VM 档 / 未分类」体积，并给出两端瘦身后的预估大小。
 *
 * 用途：拆分 HSP 之前的量化依据（docs/406）。不改包、不签名。
 *
 * 用法：
 *   node tools/report-hsp-payload.mjs <file.hsp|dir> [--json]
 *   node tools/report-hsp-payload.mjs --self-test
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const MANIFEST = 'hostruntime/payload.manifest.json';

function globToRe(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp('^' + out + '$');
}

export function classify(path, manifest) {
  for (const key of ['vmOnly', 'nativeOnly', 'common']) {
    for (const g of manifest[key] ?? []) {
      if (globToRe(g).test(path)) return key;
    }
  }
  return 'unknown';
}

export function summarize(entries, manifest) {
  const sums = { common: 0, nativeOnly: 0, vmOnly: 0, unknown: 0 };
  const unknown = [];
  for (const { path, size } of entries) {
    const k = classify(path, manifest);
    sums[k] += size;
    if (k === 'unknown') unknown.push({ path, size });
  }
  const pc = sums.common + sums.nativeOnly;
  const phone = sums.common + sums.vmOnly;
  return { sums, unknown, pc, phone, total: entries.reduce((a, e) => a + e.size, 0) };
}

function listHsp(file) {
  const out = execFileSync('/usr/bin/unzip', ['-l', file], { maxBuffer: 64 * 1024 * 1024 }).toString();
  const rows = out.split('\n');
  const entries = [];
  for (const line of rows) {
    const m = line.match(/^\s*(\d+)\s+\S+\s+\S+\s+(.+)$/);
    if (!m) continue;
    const path = m[2].trim();
    if (path.endsWith('/') || path === 'Name' || path.startsWith('----')) continue;
    entries.push({ path, size: Number(m[1]) });
  }
  return entries;
}

function listDir(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push({ path: relative(dir, p).split(sep).join('/'), size: st.size });
    }
  };
  walk(dir);
  return out;
}

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

const selfTest = process.argv.includes('--self-test');
if (selfTest) {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const cases = [
    ['libs/arm64-v8a/libnode.so.137', 'common'],
    ['resources/resfile/dsh-core-0.2.2-rc.1+dshm.1-openharmony-arm64.zip', 'common'],
    ['resources/resfile/toolchain/bash/bin/bash', 'nativeOnly'],
    ['libs/arm64-v8a/libpython3.12.so.1.0', 'nativeOnly'],
    ['resources/resfile/vm/rootfs_aarch64.qcow2', 'vmOnly'],
    ['libs/arm64-v8a/libqemu-system-aarch64.so', 'vmOnly'],
    ['libs/arm64-v8a/libX11.so', 'vmOnly'],
    ['weird/unknown.bin', 'unknown'],
  ];
  let fail = 0;
  for (const [p, want] of cases) {
    const got = classify(p, manifest);
    if (got !== want) {
      fail++;
      console.error(`  ✗ ${p} ⇒ ${got}，期望 ${want}`);
    } else {
      console.log(`  ✓ ${p} ⇒ ${got}`);
    }
  }
  console.log(fail === 0 ? '✅ 自检通过' : `❌ 自检失败（${fail}）`);
  process.exit(fail === 0 ? 0 : 1);
}

const target = process.argv[2];
if (!target || !existsSync(target)) {
  console.error('用法：node tools/report-hsp-payload.mjs <file.hsp|dir> [--json]');
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const entries = target.endsWith('.hsp') ? listHsp(target) : listDir(target);
const r = summarize(entries, manifest);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total: r.total, ...r, manifest: undefined }, null, 2));
  process.exit(0);
}

console.log(`目标：${target}`);
console.log(`总计：${mb(r.total)}（${entries.length} 个文件）`);
console.log('');
console.log(`  公共      ${mb(r.sums.common).padStart(10)}`);
console.log(`  仅原生档  ${mb(r.sums.nativeOnly).padStart(10)}`);
console.log(`  仅 VM 档 ${mb(r.sums.vmOnly).padStart(10)}`);
console.log(`  未分类    ${mb(r.sums.unknown).padStart(10)}`);
console.log('');
console.log(`瘦身后预估：原生档 ${mb(r.pc)}（-${(100 - (r.pc / r.total) * 100).toFixed(1)}%）`
  + ` ｜ VM 档（平板/手机）${mb(r.phone)}（-${(100 - (r.phone / r.total) * 100).toFixed(1)}%）`);
if (r.unknown.length > 0) {
  console.log('');
  console.log('未分类（需补清单）：');
  for (const u of r.unknown.sort((a, b) => b.size - a.size).slice(0, 15)) {
    console.log(`  ${mb(u.size).padStart(10)}  ${u.path}`);
  }
}
