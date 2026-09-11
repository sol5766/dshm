// Equivalence test for the DSHM-OHOS dsh-client-modules patch.
// Verifies the two rewritten expressions produce byte-identical results to the
// originals for the real client bundles in the env, plus edge cases.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const envDir = process.argv[2];
if (!envDir) {
  console.error('usage: node verify-client-modules-patch.mjs <dshEnvDir>');
  process.exit(2);
}

function newlineCountOld(value) {
  let count = 0;
  for (const char of value) if (char === '\n') count += 1;
  return count;
}
function newlineCountNew(value) {
  let count = 0;
  let index = value.indexOf('\n');
  while (index !== -1) {
    count += 1;
    index = value.indexOf('\n', index + 1);
  }
  return count;
}
function mappingsOld(n) {
  return Array.from({ length: n }, (_, index) => (index === 0 ? 'AAAA' : 'AACA')).join(';');
}
function mappingsNew(n) {
  return n === 0 ? '' : 'AAAA' + ';AACA'.repeat(n - 1);
}

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail));
  if (!ok) failures += 1;
}

// 1. Edge cases + random strings for newlineCount.
const cases = ['', '\n', 'a', 'a\n', '\n\n\n', 'a\nb\nc', 'no newlines here', '\r\n\r\n', 'x'.repeat(1000) + '\n'];
for (let i = 0; i < 200; i++) {
  let s = '';
  const len = Math.floor(Math.random() * 400);
  for (let j = 0; j < len; j++) s += Math.random() < 0.12 ? '\n' : String.fromCharCode(97 + Math.floor(Math.random() * 26));
  cases.push(s);
}
let nlOk = true;
for (const c of cases) {
  if (newlineCountOld(c) !== newlineCountNew(c)) {
    nlOk = false;
    check('newlineCount', false, JSON.stringify(c.slice(0, 40)));
    break;
  }
}
check('newlineCount equivalence (' + cases.length + ' cases)', nlOk);

// 2. Real, large client bundles from the shipped env.
const nm = join(envDir, 'node_modules');
const found = [];
function walk(dir, depth) {
  if (depth > 4 || found.length > 4000) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.name === 'client.js') {
      try {
        const size = statSync(p).size;
        if (size > 20000) found.push({ p, size });
      } catch { /* ignore */ }
    }
  }
}
walk(nm, 0);
found.sort((a, b) => b.size - a.size);
const sample = found.slice(0, 12);
let bundleOk = true;
let totalBytes = 0;
for (const f of sample) {
  const text = readFileSync(f.p, 'utf8');
  totalBytes += text.length;
  const oldN = newlineCountOld(text);
  const newN = newlineCountNew(text);
  if (oldN !== newN || mappingsOld(oldN) !== mappingsNew(oldN)) {
    bundleOk = false;
    check('bundle ' + f.p, false, `lines old=${oldN} new=${newN}`);
    break;
  }
}
check('real client.js bundles (' + sample.length + ' files, ' + (totalBytes / 1048576).toFixed(1) + ' MB)', bundleOk);

// 3. identity mappings for a wide range of line counts.
let mapOk = true;
for (let n = 0; n <= 2000; n++) {
  if (mappingsOld(n) !== mappingsNew(n)) {
    mapOk = false;
    check('mappings n=' + n, false, mappingsOld(n).slice(0, 40) + ' vs ' + mappingsNew(n).slice(0, 40));
    break;
  }
}
check('identity mappings equivalence (n=0..2000)', mapOk);

console.log(failures === 0 ? 'ALL_PASS' : 'FAILURES=' + failures);
process.exit(failures === 0 ? 0 : 1);
