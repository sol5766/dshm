#!/usr/bin/env node
/**
 * Multi-HAP surface guard (2026-10-24).
 *
 * One App now ships a desktop/tablet entry HAP, a phone entry HAP and one
 * shared runtime HSP. This guard
 * pins the split so a future edit cannot silently copy the 300MB core back into
 * each HAP, duplicate an entry type, or reintroduce a dependency on the
 * independent sibling workspace.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const MODULE_FILES = new Map([
  ['entry/src/main/module.json5', ['tablet', '2in1']],
  ['phone/src/main/module.json5', ['phone']],
  ['hostruntime/src/main/module.json5', ['phone', 'tablet', '2in1']],
]);
const ENTRY_MODULES = ['entry', 'phone'];

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function strictJson5(text) {
  return text.replace(/^\uFEFF/, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
}

function sourceFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'oh_modules' || e.name === 'build') continue;
      sourceFiles(full, out);
    } else if (e.isFile() && extname(e.name) === '.ets') {
      out.push(full);
    }
  }
  return out;
}

function selfTest() {
  const problems = [];
  if (JSON.stringify(MODULE_FILES.get('entry/src/main/module.json5')) !== JSON.stringify(['tablet', '2in1'])) {
    problems.push('desktop/tablet entry mapping drifted');
  }
  if (JSON.stringify(MODULE_FILES.get('hostruntime/src/main/module.json5')) !== JSON.stringify(['phone', 'tablet', '2in1'])) {
    problems.push('shared HSP mapping drifted');
  }
  console.log(problems.length === 0 ? 'SELF-TEST PASS' : `SELF-TEST FAIL: ${problems.join('; ')}`);
  process.exit(problems.length === 0 ? 0 : 3);
}

if (process.argv.includes('--self-test')) selfTest();

const problems = [];
for (const [rel, expectedTypes] of MODULE_FILES) {
  const path = join(ROOT, rel);
  if (!existsSync(path)) {
    problems.push(`missing module manifest: ${rel}`);
    continue;
  }
  const mod = JSON.parse(strictJson5(readFileSync(path, 'utf8')));
  const types = mod?.module?.deviceTypes ?? [];
  if (JSON.stringify(types) !== JSON.stringify(expectedTypes)) {
    problems.push(`${rel}: deviceTypes=${JSON.stringify(types)}, expected ${JSON.stringify(expectedTypes)}`);
  }
}

for (const name of ENTRY_MODULES) {
  const pkg = JSON.parse(strictJson5(readFileSync(join(ROOT, name, 'oh-package.json5'), 'utf8')));
  if (pkg?.dependencies?.hostruntime !== 'file:../hostruntime') {
    problems.push(`${name}/oh-package.json5: must depend on the shared hostruntime HSP`);
  }
  if (existsSync(join(ROOT, name, 'src/main/ets/runtime/NodeRuntime.ets'))) {
    problems.push(`${name}: must not carry a private NodeRuntime implementation`);
  }
  const resfile = join(ROOT, name, 'src/main/resources/resfile');
  if (existsSync(resfile)) {
    const coreZips = readdirSync(resfile).filter((n) => /^dsh-core-.*\.zip$/.test(n));
    if (coreZips.length > 0) problems.push(`${name}: duplicates shared core container ${coreZips.join(', ')}`);
  }
}

const sharedResfile = join(ROOT, 'hostruntime/src/main/resources/resfile');
const sharedCores = existsSync(sharedResfile)
  ? readdirSync(sharedResfile).filter((n) => /^dsh-core-.*\.zip$/.test(n))
  : [];
if (sharedCores.length !== 1) problems.push(`hostruntime HSP must contain exactly one core zip, got ${sharedCores.length}`);
if (!existsSync(join(ROOT, 'hostruntime/src/main/ets/runtime/NodeRuntime.ets'))) {
  problems.push('hostruntime: shared NodeRuntime implementation is missing');
}

const buildFiles = ['oh-package.json5', 'build-profile.json5', 'hvigorfile.ts'];
for (const rel of buildFiles) {
  const path = join(ROOT, rel);
  if (!existsSync(path)) continue;
  const text = readFileSync(path, 'utf8');
  if (text.includes('DSHM-mobile')) problems.push(`${rel}: depends on sibling mobile tree`);
}

const runtimePort = readFileSync(join(ROOT, 'hostruntime/src/main/ets/runtime/RuntimePort.ets'), 'utf8');
if (/return\s*\[\s*['"]--jitless['"]/.test(runtimePort)) {
  problems.push('RuntimePort.ets still forces jitless in the production host argv');
}

console.log('# Multi-HAP surface guard');
if (problems.length === 0) {
  console.log('PASS: desktop/tablet entry / phone entry and one shared runtime HSP are wired without duplicate core assets.');
  process.exit(0);
}
for (const p of problems) console.error(`FAIL: ${p}`);
process.exit(1);
