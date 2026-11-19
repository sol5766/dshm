#!/usr/bin/env node
/**
 * 一键自检（**全部用绝对路径**，不依赖当前目录）。
 *
 * 【为什么要有它】2026-11-05 用户把 `wc -c < bin/node` 贴到 zsh，cwd 是工作区
 * `/storage/Users/currentUser/data/test`，那里没有 `bin/`；同时行尾的 `#` 注释在 zsh
 * 交互模式会触发 `parse error near '#'`。根因是**我给的是相对路径 + 注释**，不是设备问题。
 * 以后验收只跑这一条：`node tools/dshm-verify.mjs`。
 *
 * 用法：
 *   node tools/dshm-verify.mjs              # 人类可读（PASS/FAIL + 绝对路径）
 *   node tools/dshm-verify.mjs --json       # 机器可读
 *   node tools/dshm-verify.mjs --dir <files>  # 指定应用 files 根（默认自动探测 entry/phone）
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

function evaluateGlass(root, glass) {
  const pathModule = /\/haps\/(entry|phone)\/files$/.exec(resolve(root))?.[1];
  const phoneDeclaration = glass?.module === 'phone' && glass.implemented === false
    && glass.effective === false && glass.reason === 'phone-shell-no-glass-skin'
    && glass.cssSupport === null;
  const module = pathModule || (phoneDeclaration ? 'phone' : 'unknown');
  if (module === 'phone') {
    return { module, status: 'notapplicable', ok: true, implemented: false,
      effective: false, cssSupport: null, reason: 'phone-shell-no-glass-skin' };
  }
  if (module === 'unknown') {
    return { module, status: 'unknown', ok: null, effective: null,
      cssSupport: null, reason: 'module-capability-unknown' };
  }
  const valid = glass !== null && typeof glass?.support === 'boolean'
    && typeof glass?.effective === 'boolean' && glass?.counts !== null
    && typeof glass?.counts === 'object' && !phoneDeclaration;
  return { module, status: valid ? 'pass' : 'fail', ok: valid,
    effective: valid ? glass.effective : null, cssSupport: valid ? glass.support : null,
    reason: valid ? 'entry-diagnostics-present' : 'entry-diagnostics-missing-or-invalid' };
}

const CANDIDATES = [
  process.env.DSHM_FILES_DIR,
  '/data/storage/el2/base/haps/entry/files',
  '/data/storage/el2/base/haps/phone/files',
  '/data/storage/el2/base/haps/tablet/files',
].filter(Boolean);

function parseArgs() {
  const out = { json: false, dir: '' };
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--json') out.json = true;
    else if (process.argv[i] === '--dir') out.dir = process.argv[i + 1] ?? '';
  }
  return out;
}

function magic(file) {
  try {
    const b = readFileSync(file).subarray(0, 4);
    if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return 'ELF';
    if (b[0] === 0x23 && b[1] === 0x21) return 'script';
    return b.toString('hex');
  } catch { return 'missing'; }
}

function run(file, args) {
  try {
    const r = spawnSync(file, args, { encoding: 'utf8', timeout: 20000 });
    const text = String(r.stdout || '').trim().split('\n')[0];
    return text.length > 0 ? text : `rc=${r.status}`;
  } catch (e) { return `error: ${e.message}`; }
}

const args = parseArgs();
const root = args.dir || CANDIDATES.find((d) => existsSync(join(d, 'bin')));
if (!root) {
  console.error('找不到应用 files 根（试过 entry/phone/tablet）；用 --dir 指定');
  process.exit(2);
}

const bin = join(root, 'bin');
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: String(detail) });
}

const launchers = ['node', 'npm', 'npx', 'pnpm', 'dsh'];
const forms = [];
for (const name of launchers) {
  const file = join(bin, name);
  const exists = existsSync(file);
  const size = exists ? statSync(file).size : 0;
  const kind = magic(file);
  forms.push({ name, file, exists, size, kind });
  check(`启动器 ${name} 是 ELF`, exists && kind === 'ELF', `${file}（${size} B / ${kind}）`);
}

const versions = {
  'node -v': run(join(bin, 'node'), ['-v']),
  'npm -v': run(join(bin, 'npm'), ['-v']),
  'pnpm -v': run(join(bin, 'pnpm'), ['-v']),
  'dsh --version': run(join(bin, 'dsh'), ['--version']),
};
for (const [k, v] of Object.entries(versions)) {
  check(`${k} 有真版本`, /^v?\d+\.\d+/.test(v) || /\d+\.\d+\.\d+/.test(v), v);
}

const toolchain = join(root, 'toolchain');
const roots = ['bashroot', 'npmroot', 'pnpmroot', 'tmuxroot', 'ghroot', 'gitroot'];
const counts = {};
for (const name of roots) {
  const dir = join(toolchain, name);
  let n = 0;
  try { n = readdirSync(dir).length; } catch { n = 0; }
  counts[name] = n;
  check(`toolchain/${name} 非空`, n > 0, `${dir}（${n} 项）`);
}
const extractLog = join(toolchain, '.extract.log');
check('.extract.log 有内容', existsSync(extractLog) && statSync(extractLog).size > 0,
  `${extractLog}（${existsSync(extractLog) ? statSync(extractLog).size : 0} B）`);

const diagGlass = join(root, 'diag-glass');
let glass = null;
if (existsSync(diagGlass)) {
  try {
    const lines = readFileSync(diagGlass, 'utf8').trim().split('\n');
    glass = JSON.parse(lines[lines.length - 1].replace(/^\S+\s+/, ''));
  } catch { glass = null; }
}

const glassAssessment = evaluateGlass(root, glass);
checks.push({ name: '玻璃诊断', ok: glassAssessment.ok, status: glassAssessment.status,
  detail: JSON.stringify(glassAssessment) });

const homeTask = join(root, 'dsh', 'home', 'task-state.json');
const compatTask = join(root, 'task-state.json');
check('task-state 主文件在', existsSync(homeTask), homeTask);
check('task-state 兼容副本是真文件（非 symlink）',
  existsSync(compatTask) && !(() => { try { return statSync(compatTask).isSymbolicLink(); } catch { return true; } })(),
  compatTask);

const cores = join(root, 'dsh', 'cores');
let coreList = [];
try { coreList = readdirSync(cores).sort(); } catch { coreList = []; }
check('核心树存在', coreList.length > 0, coreList.length > 0 ? coreList.join(', ') : `${cores} 为空`);

const report = {
  filesRoot: root,
  launchers: forms,
  versions,
  toolchain: counts,
  glass,
  glassAssessment,
  core: coreList,
  checks,
};
const failed = checks.filter((c) => c.ok === false);
const unknown = checks.filter((c) => c.ok === null);

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`files 根：${root}`);
  console.log(`启动器：${forms.map((f) => `${f.name}=${f.size}B/${f.kind}`).join('  ')}`);
  console.log(`版本：${Object.entries(versions).map(([k, v]) => `${k} → ${v}`).join(' | ')}`);
  console.log(`toolchain：${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`玻璃：${JSON.stringify(glassAssessment)}`);
  console.log('');
  for (const c of checks) {
    console.log(`${c.status === 'notapplicable' ? 'NOTAPPLICABLE' : c.ok === null ? 'UNKNOWN' : c.ok ? 'PASS' : 'FAIL'}  ${c.name}  —  ${c.detail}`);
  }
  console.log('');
  console.log(failed.length > 0 ? `失败 ${failed.length} 项（见上方 FAIL）` : unknown.length > 0 ? '存在未知项，验收未完成' : '适用项全部通过');
}
process.exit(failed.length > 0 ? 1 : unknown.length > 0 ? 2 : 0);
