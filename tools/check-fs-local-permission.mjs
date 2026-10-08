#!/usr/bin/env node
/**
 * 门禁：`dsh-fs-local` 的**权限错误人话化**（`docs/109`）必须真的改到行为 ——
 * 「路径可达、但 `stat`（或 `open`/`readFile`）被平台拒」要报 `FS_PERMISSION_DENIED`，
 * 而不是把 node 的裸 `EPERM` 上抛。
 *
 * ─────────────────── 为什么必须有一条"跑真代码"的门禁 ───────────────────
 * 真机复测（仓库外 `dshm-sandbox-retest-r3.md` §4）写得很清楚：该平台的策略粒度是
 * 「路径解析放行、目录 `readdir`/创建被拒」，而且**受限目录里的路径 `stat` 也返回 `ENOENT`**：
 *     stat  …/Documents/some-file.txt → ENOENT（真的不存在）
 *     stat  …/Documents              → OK
 *     stat  /storage/nope.txt        → ENOENT（父目录受限也报"不存在"）
 * ⇒ 在那台设备上**构造不出「文件存在、`stat` 被拒」的样本**，这条分支设备侧**不可达**，
 * 复测报告只能"建议单测"。而静态门禁（`check-core-openharmony-patches` 的 ⑩b 组）只证明
 * **文本还在**，不证明它**改到了行为** —— 顺序写反、分支写错、`throw` 漏掉，静态断言全看不出来。
 *
 * ─────────────────── 怎么在不换设备的前提下真跑它 ───────────────────
 * 用 `module.registerHooks()` 把 `node:fs/promises` **这一个模块**换成垫片：
 *   · 垫片对**标记路径**按表抛错（`EPERM` / `EACCES` / `EBUSY` …），其余一律转真实现；
 *   · 被 import 的仍是**树里那份真代码**（同一个文件、同一条依赖解析路径，不复制、不改写）；
 * ⇒ 断言的是"真代码在这个失败面前的反应"，不是"它的文本长什么样"。
 * 垫片源码在跑之前**按真模块的导出清单生成**（`Object.keys(require('fs/promises'))`），
 * 所以上游加一个导出（真机就发生过：`readdirp` 要 `realpath`）不会让门禁假红。
 *
 * ─────────────────── 注入式负控制（每次运行都跑，不是可选） ───────────────────
 * 第二臂用 `load` 钩子把树里那份源码的**两处** `if (isPermissionError(error)) throw …`
 * 就地删掉（URL 不变 ⇒ 依赖仍按原路径解析；只改内存，不落地、不碰核心树）⇒ 同样的调用
 * 必须退回**裸 EPERM**。若这一臂也"通过"，说明本门禁没有判别力（那正是上一条要挡的假绿）。
 *
 * ─────────────────── 覆盖边界（不在本门禁内的事，别当成绿） ───────────────────
 *   · `readBytes` / `readByteRange` **不走 `stat`**（直接 `createReadStream`）⇒ 上游本来就没有
 *     这条分支，本补丁也**不覆盖**它们（照旧只有 `open` 那一步会拒）。
 *   · `editHealthy` 那条对照臂只断言"**不许报权限**"，不断言"编辑一定成功"：树是**端侧 arm64**
 *     的树，宿主机（x64）上 `writeFileAtomic` 要用的 `koffi` 原生绑定加载不了，
 *     会在**更后面**以别的错失败（`Cannot find the native Koffi module`）。这不是补丁的问题，
 *     也不能拿它当"通过" —— 所以断言的只是"与权限无关"。
 *
 * 用法：node tools/check-fs-local-permission.mjs [--self-test]
 * 退出码：0 通过 / 1 失败 / 3 环境不具备（无核心树）或自检失败
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = join(ROOT, 'dist', 'localtest', 'fs-local-permission');
const requireHere = createRequire(import.meta.url);
/** 期望逐字（`<DIR>` 是夹具侧临时目录的占位符，见夹具里的归一化）。 */
const READ_DENIED = 'cannot read "<DIR>/denied.txt": permission denied';
const EDIT_DENIED = 'cannot edit "<DIR>/edit-denied.txt": permission denied';

/* ───────────────────────── 定位核心树里那份被注入的文件 ───────────────────────── */

function findPatchedTree() {
  const base = join(ROOT, 'dist', 'core', 'work');
  if (!existsSync(base)) return null;
  const versions = readdirSync(base).filter((n) => n.startsWith('dsh-core-')).sort().reverse();
  for (const v of versions) {
    const file = join(base, v, 'node_modules', '@deepseek-ai', 'dsh-fs-local', 'lib', 'index.js');
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    if (text.includes('DSHM_FS_LOCAL_PERMISSION_HINT')) return { version: v, file, text };
  }
  return null;
}

/* ───────────────────────── 静态断言（文本层） ───────────────────────── */

function staticChecks(text) {
  const results = [];
  const add = (ok, name, detail = '') => results.push({ ok, name, detail });
  const marks = text.split('DSHM_FS_LOCAL_PERMISSION_HINT').length - 1;
  add(marks === 4, '树内标记恰好 4 处', `实际 ${marks} 处`);

  /* 顺序即行为：权限分支必须在 ENOENT 分支**之前**，否则 not-found 会被吞成 permission denied */
  const statRegion = text.slice(text.indexOf('async function statRegularFile'), text.indexOf('function readWholeText'));
  const iPerm = statRegion.indexOf('if (isPermissionError(error)) throw new FsError');
  const iEnoent = statRegion.indexOf('if (!isENOENT(error)) throw error;');
  add(iPerm >= 0 && iEnoent >= 0 && iPerm < iEnoent, 'statRegularFile：权限分支在 ENOENT 分支之前',
    `perm@${iPerm} enoent@${iEnoent}`);

  add(text.includes('async function readFileAbortable(absolutePath, verb, signal, displayPath)'),
    'readFileAbortable：函数头收下 displayPath（第 4 参）');
  const readCall = 'const raw = await readFileAbortable(target.targetKey, "read", signal, target.displayPath);';
  const editCall = 'const buffer = await readFileAbortable(absolutePath, "edit", signal, displayPath);';
  add(text.includes(readCall) && text.includes(editCall), '两个调用点都带上 displayPath（read / edit）');
  add(text.includes('function isPermissionError(error)') && text.includes('"FS_PERMISSION_DENIED"'),
    '复用上游已有的 isPermissionError() 与 FS_PERMISSION_DENIED（不新造错误码）');
  return results;
}

/* ───────────────────────── 夹具与垫片 ───────────────────────── */

/** 按**真模块的导出清单**生成垫片：上游加导出也不会让它变成"缺导出"的假红。 */
function shimSource() {
  const keys = Object.keys(requireHere('fs/promises'))
    .filter((k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)).sort();
  return [
    'import { createRequire } from "node:module";',
    'const req = createRequire(import.meta.url);',
    'const real = req("fs/promises");',
    '/* 只有"标记路径 + 指定操作"按表抛错，其余一律转真实现（垫片必须对上游透明）。 */',
    'function wrap(name) {',
    '  const fn = real[name];',
    '  return (...args) => {',
    '    const p = typeof args[0] === "string" ? args[0] : "";',
    '    const code = (globalThis.__DSHM_GATE_DENY || {})[p] && globalThis.__DSHM_GATE_DENY[p][name];',
    '    if (code !== undefined) {',
    '      const e = new Error(name + " " + code + ": " + p);',
    '      e.code = code; e.errno = -1; e.syscall = name; e.path = p;',
    '      return Promise.reject(e);',
    '    }',
    '    return fn(...args);',
    '  };',
    '}',
    ...keys.map((k) => 'export const ' + k + ' = wrap("' + k + '");'),
    'export default real;',
    '',
  ].join('\n');
}

const FIXTURE = `
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
(async () => {
  const { registerHooks } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const path = await import('node:path');
  const os = await import('node:os');
  const sync = await import('node:fs');
  const NEUTER = process.env.DSHM_GATE_NEUTER === '1';
  const TREE_FILE = ${JSON.stringify('<TREE>')};

  /* 只换这一个模块；load 钩子仅用于负控制臂的就地删除（URL 不变）。 */
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'node:fs/promises') {
        return { url: pathToFileURL(${JSON.stringify(join(SCRATCH, 'fsp-shim.mjs'))}).href, format: 'module', shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      const r = nextLoad(url, context);
      if (!NEUTER) return r;
      if (!String(url).endsWith('/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js')) return r;
      let src = typeof r.source === 'string' ? r.source : Buffer.from(r.source).toString('utf8');
      const before = src;
      src = src.split('\\n').filter((line) => !line.includes('if (isPermissionError(error)) throw new FsError')).join('\\n');
      out({ case: 'neuter', removedLines: before.split('\\n').length - src.split('\\n').length });
      return { format: 'module', source: src, shortCircuit: true };
    }
  });

  const dir = sync.mkdtempSync(path.join(os.tmpdir(), 'dshm-fsloc-gate-'));
  const healthy = path.join(dir, 'healthy.txt');
  sync.writeFileSync(healthy, 'hello-dshm\\n', 'utf8');
  const editHealthy = path.join(dir, 'edit-healthy.txt');
  sync.writeFileSync(editHealthy, 'alpha beta gamma\\n', 'utf8');
  const editDenied = path.join(dir, 'edit-denied.txt');
  sync.writeFileSync(editDenied, 'alpha beta gamma\\n', 'utf8');

  const denied = path.join(dir, 'denied.txt');          /* 故意**不创建**：stat 由垫片拒绝 */
  const deniedEacces = path.join(dir, 'denied-eacces.txt');
  const deniedBusy = path.join(dir, 'denied-busy.txt');
  const missing = path.join(dir, 'missing.txt');        /* 垫片放行 ⇒ 真 ENOENT */
  globalThis.__DSHM_GATE_DENY = {
    [denied]: { stat: 'EPERM' },
    [deniedEacces]: { stat: 'EACCES' },
    [deniedBusy]: { stat: 'EBUSY' },
    [editDenied]: { readFile: 'EPERM' },
  };

  const mod = await import(pathToFileURL(TREE_FILE).href);
  const seam = Object.create(mod.LocalFileSystem.prototype);
  seam.config = { cwd: dir, diffBasisMaxBytes: 64 * 1024 * 1024 };
  seam.locks = new Map();
  seam.internals = {};

  const norm = (s) => String(s).split(dir).join('<DIR>').split('\\\\').join('/');
  const call = async (name, fn) => {
    try {
      const v = await fn();
      out({ case: name, outcome: 'resolved', value: typeof v === 'string' ? norm(v) : JSON.stringify(v) });
    } catch (e) {
      out({
        case: name, outcome: 'rejected',
        ctor: e && e.constructor ? e.constructor.name : 'none',
        code: e && e.code, message: norm(e && e.message),
        causeCode: e && e.cause ? e.cause.code : null,
      });
    }
  };

  const target = (p) => ({ targetKey: p, displayPath: p });
  await call('readStatEperm', () => seam.readText(target(denied)));
  await call('readStatEacces', () => seam.readText(target(deniedEacces)));
  await call('readStatOther', () => seam.readText(target(deniedBusy)));
  await call('readMissing', () => seam.readText(target(missing)));
  await call('readHealthy', () => seam.readText(target(healthy)));
  await call('readAborted', () => seam.readText(target(healthy), { aborted: true }));
  await call('editReadDenied', () => seam.editText(target(editDenied), { oldString: 'beta', newString: 'BETA' }));
  await call('editHealthy', () => seam.editText(target(editHealthy), { oldString: 'beta', newString: 'BETA' }));
  out({ stage: 'done' });
  process.exit(0);
})().catch((e) => { out({ stage: 'fatal', error: String(e && e.message) }); process.exit(1); });
`;

/* ───────────────────────── 判定 ───────────────────────── */

function parse(stdout) {
  const cases = {};
  let stage = 'none';
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let o = null;
    try { o = JSON.parse(t); } catch (e) { continue; }
    if (o.stage !== undefined) stage = o.stage;
    if (o.case !== undefined) cases[o.case] = o;
  }
  return { cases, stage };
}

function judgeFixed(c) {
  const bad = [];
  const want = (ok, why) => { if (!ok) bad.push(why); };
  want(c.readStatEperm && c.readStatEperm.outcome === 'rejected', 'readStatEperm 应被拒');
  want(c.readStatEperm && c.readStatEperm.ctor === 'FsError', 'readStatEperm 应是 FsError（不是裸错）');
  want(c.readStatEperm && c.readStatEperm.code === 'FS_PERMISSION_DENIED', 'readStatEperm 码应为 FS_PERMISSION_DENIED');
  want(c.readStatEperm && c.readStatEperm.message === READ_DENIED, 'readStatEperm 文案应为 ' + READ_DENIED);
  want(c.readStatEperm && c.readStatEperm.causeCode === 'EPERM', 'readStatEperm 应把原始 EPERM 留在 cause');
  want(c.readStatEacces && c.readStatEacces.code === 'FS_PERMISSION_DENIED' && c.readStatEacces.causeCode === 'EACCES',
    'readStatEacces 也吃 EACCES → FS_PERMISSION_DENIED');
  want(c.readStatOther && c.readStatOther.outcome === 'rejected' && c.readStatOther.code === 'EBUSY'
    && c.readStatOther.ctor !== 'FsError', 'readStatOther（EBUSY）必须原样上抛，不许翻成权限');
  want(c.readMissing && c.readMissing.code === 'FS_NOT_FOUND' && /not found$/.test(c.readMissing.message || ''),
    'readMissing 必须仍是 FS_NOT_FOUND（顺序/分支不许把 ENOENT 也吞成 permission denied）');
  want(c.readHealthy && c.readHealthy.outcome === 'resolved' && c.readHealthy.value === 'hello-dshm\n',
    'readHealthy 对照臂：垫片不许破坏正常读取');
  want(c.readAborted && c.readAborted.code === 'FS_ABORTED', 'readAborted 必须仍是 FS_ABORTED（权限分支不许吞 abort）');
  want(c.editReadDenied && c.editReadDenied.code === 'FS_PERMISSION_DENIED', 'editReadDenied 码应为 FS_PERMISSION_DENIED');
  want(c.editReadDenied && c.editReadDenied.message === EDIT_DENIED, 'editReadDenied 文案应为 ' + EDIT_DENIED);
  want(c.editReadDenied && c.editReadDenied.causeCode === 'EPERM', 'editReadDenied 应把原始 EPERM 留在 cause');
  want(c.editHealthy && c.editHealthy.code !== 'FS_PERMISSION_DENIED'
    && !/permission denied/.test(String(c.editHealthy.message || '')),
    'editHealthy 对照臂：可读文件的 edit 不许报权限（差分对照 —— 证明垫片不是一律拒绝）');
  return bad;
}

function judgeNeuter(c) {
  const bad = [];
  const want = (ok, why) => { if (!ok) bad.push(why); };
  want(c.neuter && c.neuter.removedLines === 2, '负控制臂应删掉 2 行权限分支');
  want(c.readStatEperm && c.readStatEperm.ctor !== 'FsError' && c.readStatEperm.code === 'EPERM',
    '负控制臂：删掉分支后必须退回裸 EPERM（否则本门禁没有判别力）');
  want(c.editReadDenied && c.editReadDenied.ctor !== 'FsError' && c.editReadDenied.code === 'EPERM',
    '负控制臂：edit 那条也必须退回裸 EPERM');
  want(c.readMissing && c.readMissing.code === 'FS_NOT_FOUND', '负控制臂：not-found 仍应是 FS_NOT_FOUND（只动了权限分支）');
  want(c.readHealthy && c.readHealthy.outcome === 'resolved', '负控制臂：正常读取不受影响');
  return bad;
}

const SELF_TESTS = [
  ['固定臂：全对 → 成立', {}, []],
  ['固定臂：readStatEperm 仍是裸错 → 不成立', { readStatEperm: { outcome: 'rejected', ctor: 'Error', code: 'EPERM' } }, ['readStatEperm']],
  ['固定臂：not-found 被吞成 permission denied → 不成立', { readMissing: { code: 'FS_PERMISSION_DENIED', message: 'cannot read "x": permission denied' } }, ['readMissing']],
  ['固定臂：abort 被权限分支吞掉 → 不成立', { readAborted: { code: 'FS_PERMISSION_DENIED' } }, ['readAborted']],
  ['负控制臂：删了分支却仍报 FS_PERMISSION_DENIED → 不成立（无判别力）',
    { neuter: { removedLines: 2 }, readStatEperm: { ctor: 'FsError', code: 'FS_PERMISSION_DENIED' }, editReadDenied: { ctor: 'FsError', code: 'FS_PERMISSION_DENIED' }, readMissing: { code: 'FS_NOT_FOUND' }, readHealthy: { outcome: 'resolved' } },
    ['裸 EPERM']],
];

if (process.argv.includes('--self-test')) {
  const full = () => {
    const ok = {};
    for (const k of ['readStatEperm', 'readStatEacces', 'readStatOther', 'readMissing', 'readHealthy', 'readAborted', 'editReadDenied', 'editHealthy']) ok[k] = null;
    ok.readStatEperm = { outcome: 'rejected', ctor: 'FsError', code: 'FS_PERMISSION_DENIED', message: READ_DENIED, causeCode: 'EPERM' };
    ok.readStatEacces = { outcome: 'rejected', ctor: 'FsError', code: 'FS_PERMISSION_DENIED', message: READ_DENIED, causeCode: 'EACCES' };
    ok.readStatOther = { outcome: 'rejected', ctor: 'Error', code: 'EBUSY' };
    ok.readMissing = { outcome: 'rejected', ctor: 'FsError', code: 'FS_NOT_FOUND', message: 'cannot read "<DIR>/missing.txt": not found' };
    ok.readHealthy = { outcome: 'resolved', value: 'hello-dshm\n' };
    ok.readAborted = { outcome: 'rejected', ctor: 'FsError', code: 'FS_ABORTED' };
    ok.editReadDenied = { outcome: 'rejected', ctor: 'FsError', code: 'FS_PERMISSION_DENIED', message: EDIT_DENIED, causeCode: 'EPERM' };
    ok.editHealthy = { outcome: 'rejected', ctor: 'Error', message: 'Cannot find the native Koffi module' };
    return ok;
  };
  const NEUTER_OK = {
    neuter: { removedLines: 2 },
    readStatEperm: { outcome: 'rejected', ctor: 'Error', code: 'EPERM' },
    editReadDenied: { outcome: 'rejected', ctor: 'Error', code: 'EPERM' },
    readMissing: { outcome: 'rejected', ctor: 'FsError', code: 'FS_NOT_FOUND' },
    readHealthy: { outcome: 'resolved' },
  };
  let bad = 0;
  for (const [name, patch, wantBad] of SELF_TESTS) {
    const c = patch === undefined || Object.keys(patch).length === 0 && name.startsWith('固定臂：全对')
      ? full() : Object.assign(full(), patch);
    const bads = name.startsWith('负控制臂') ? judgeNeuter(Object.assign({}, NEUTER_OK, patch)) : judgeFixed(c);
    const ok = wantBad.length === 0 ? bads.length === 0 : wantBad.every((k) => bads.some((b) => b.includes(k)));
    if (!ok) { bad++; console.log('FAIL  ' + name + ' → ' + JSON.stringify(bads)); }
    else console.log('ok    ' + name);
  }
  console.log(bad === 0 ? '\n自检通过：' + SELF_TESTS.length + '/' + SELF_TESTS.length + ' 判定成立'
    : '\n自检失败：' + bad + ' 项');
  process.exit(bad === 0 ? 0 : 3);
}

/* ───────────────────────── 跑两臂 ───────────────────────── */

const tree = findPatchedTree();
if (tree === null) {
  console.log('环境不具备：dist/core/work/dsh-core-*/ 里没有带 DSHM_FS_LOCAL_PERMISSION_HINT 的 dsh-fs-local（先把核心树物化出来）');
  process.exit(3);
}
const statics = staticChecks(tree.text);
const treeFile = join(tree.file);
mkdirSync(SCRATCH, { recursive: true });
writeFileSync(join(SCRATCH, 'fsp-shim.mjs'), shimSource(), 'utf8');
writeFileSync(join(SCRATCH, 'fixture.mjs'), FIXTURE.split('<TREE>').join(treeFile.split('\\').join('/')), 'utf8');

function runArm(neuter) {
  const env = { ...process.env };
  if (neuter) env.DSHM_GATE_NEUTER = '1'; else delete env.DSHM_GATE_NEUTER;
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(SCRATCH, 'fixture.mjs')], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

console.log('════════ fs-local 权限文案门禁（真行为 + 注入式负控制）════════');
console.log('核心树：' + tree.version + '  ' + treeFile);
let failed = 0;
for (const s of statics) {
  console.log((s.ok ? 'ok    ' : 'FAIL  ') + s.name + (s.ok || s.detail === '' ? '' : '  ← ' + s.detail));
  if (!s.ok) failed++;
}

const fixed = await runArm(false);
const neuter = await runArm(true);
const pFixed = parse(fixed.stdout);
const pNeuter = parse(neuter.stdout);
const badFixed = judgeFixed(pFixed.cases);
const badNeuter = judgeNeuter(pNeuter.cases);

console.log('──── 固定臂（树里那份真代码）────');
for (const k of Object.keys(pFixed.cases)) console.log('  ' + JSON.stringify(pFixed.cases[k]));
if (pFixed.stage !== 'done') console.log('  stage=' + pFixed.stage + ' stderr=' + fixed.stderr.trim().slice(0, 300));
for (const b of badFixed) { console.log('  FAIL  ' + b); failed++; }
if (badFixed.length === 0) console.log('  ok    8 组行为断言全过（含 4 条对照臂）');

console.log('──── 负控制臂（删掉权限分支后必须退回裸错）────');
for (const k of Object.keys(pNeuter.cases)) console.log('  ' + JSON.stringify(pNeuter.cases[k]));
for (const b of badNeuter) { console.log('  FAIL  ' + b); failed++; }
if (badNeuter.length === 0) console.log('  ok    负控制成立：删掉分支就退回裸 EPERM');

console.log('\n════════ 结论 ════════');
if (failed === 0) {
  rmSync(SCRATCH, { recursive: true, force: true });
  console.log('PASS：`stat`/`open` 被平台拒 ⇒ `FS_PERMISSION_DENIED` 且文案逐字正确；ENOENT / abort / 非权限错一律不受影响；'
    + '删掉补丁后同一调用退回裸 EPERM（判别力已证）。');
  process.exit(0);
}
console.log('FAIL：见上面的 FAIL 行（核心树 ' + tree.version + '）。');
process.exit(1);
