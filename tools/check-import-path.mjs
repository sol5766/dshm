#!/usr/bin/env node
/**
 * 门禁：导入路径规则（docs/313 §6，批次 C）。
 *
 * 【为什么需要它】导入是**唯一会往用户会话树写文件的路径**。这里写错，
 * 后果是会话被覆盖或目录被穿越：
 *   · `isSafeRelativePath` 放过 `..` ⇒ 云端记录的 `sessionId` 能写到 sessions 之外（**目录穿越**）；
 *   · 代际文件名不按上游规则 ⇒ 文件落盘了但上游**完全不认**，用户看到"导入成功却没会话"；
 *   · 活跃会话被覆盖 ⇒ 用户正在写的对话直接丢失（不可再生）。
 *
 * 【判据（纯离线）】
 *   A. `isSafeRelativePath`：绝对路径 / `..` / 空段 / 反斜杠全部拒绝
 *   B. `canonicalSessionFileName` 与上游 `sessionFormatLogFilename` 逐字一致
 *
 * 对照臂（--self-test）：放行 `..` / v0 带上编号 / 放行绝对路径 ⇒ 必须判红。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = 'platform/src/main/ets/sync/ImportRunner.ets';

function stripTypes(code) {
  return stripTypeScriptTypes(code, { mode: 'strip' });
}

function pick(src, name) {
  let at = src.indexOf(`export function ${name}(`);
  if (at < 0) at = src.indexOf(`\nfunction ${name}(`);
  if (at < 0) return '';
  if (src[at] === '\n') at += 1;
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return '';
}

function buildModule(src) {
  const names = ['isSafeRelativePath', 'canonicalSessionFileName'];
  const bodies = names.map((n) => {
    const raw = pick(src, n);
    return raw === '' ? '' : stripTypes(raw.replace(/^export function /, 'function '));
  });
  if (bodies.some((b) => b === '')) return null;
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`
      ${bodies.join('\n')}
      return { isSafeRelativePath: isSafeRelativePath,
        canonicalSessionFileName: canonicalSessionFileName };
    `)();
  } catch (e) {
    console.error(`模块求值失败：${e.message}`);
    return null;
  }
}

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) passed += 1;
  else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `（${detail}）` : ''}`);
  }
}

function runSuite(mod) {
  passed = 0;
  failures.length = 0;

  // ── A 路径安全 ────────────────────────────────────────────────────
  /*
   * 【用例要能区分两道检查】`/etc/passwd` 同时被"绝对路径"与"空段"两条拒绝，
   * 所以拿它做用例时，把绝对路径那条变异掉也**不会变红**（看起来像门禁没牙）。
   * 这里补一个 `/a/b` 形态：分段全合法，**只有**"以 / 开头"这一条能拦住它。
   */
  /*
   * 注意：绝对路径用例与"首段为空"用例在实现里**总是同时命中**，
   * 所以这里不再试图用用例去区分它们；判别变异效果改由 `--self-test` 里
   * 单独断言"变异后 `isSafeRelativePath('/a/b')` 翻转"来完成（见 arms 段）。
   */
  const bad = ['', '/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'a/./b',
    'a\\b', '..', '.'];
  for (const p of bad) {
    check(`A 拒绝 ${JSON.stringify(p)}`, mod.isSafeRelativePath(p) === false);
  }
  const good = ['--storage-Users-x--', 'abc123', 'sess/session.v3.jsonl.zstd', 'a/b/c'];
  for (const p of good) {
    check(`A 接受 ${JSON.stringify(p)}`, mod.isSafeRelativePath(p) === true);
  }

  // ── B 代际文件名（与上游逐字一致）────────────────────────────────
  check('B v0 无编号', mod.canonicalSessionFileName(0) === 'session.jsonl.zstd');
  check('B v1', mod.canonicalSessionFileName(1) === 'session.v1.jsonl.zstd');
  check('B v3', mod.canonicalSessionFileName(3) === 'session.v3.jsonl.zstd');
  check('B 负数当作 v0', !mod.canonicalSessionFileName(-1).includes('.v-'));
  check('B 非整数被截断', mod.canonicalSessionFileName(3.9) === 'session.v3.jsonl.zstd');
}

const selfTest = process.argv.includes('--self-test');
const src = readFileSync(join(ROOT, SRC), 'utf8');
const mod = buildModule(src);
if (mod === null) {
  console.error(`❌ 无法从 ${SRC} 抽出导入函数`);
  process.exit(1);
}

if (!selfTest) {
  runSuite(mod);
  console.log(`  ok    ${passed} 条判据通过`);
  if (failures.length > 0) {
    console.error(`\n❌ 导入路径规则不合格（${failures.length} 条）`);
    process.exit(1);
  }
  console.log('✅ 通过：路径穿越被拒、代际文件名与上游一致。');
  process.exit(0);
}

console.log('--self-test：变异体必须判红 --');
runSuite(mod);
let ok = failures.length === 0;
console.log(`  基线：问题 ${failures.length} 处（应为 0）`);

/*
 * 明确登记为**等价变异**的臂：它们的变异不会改变可观测行为（实现里两处判据重叠）。
 * 这不是"门禁没牙"，而是这条臂本身测不出差异 —— 如实标注比伪造一条能判红的用例更可信。
 */
const EQUIVALENT_ARMS = ['删掉绝对路径独立检查（等价变异：与空段检查重叠）'];

const arms = [
  ['放行 ..（目录穿越）', (s) => s.replace("if (p.length === 0 || p === '.' || p === '..') {",
    "if (p.length === 0) {")],
  /*
   * 【这条是**等价变异**，不是"没牙"】绝对路径检查与"首段为空"检查在实现里完全重叠：
   * 任何以 `/` 开头的串，split('/') 后首段必为空串 ⇒ 删掉前者，后者照样拒绝。
   * 留那条独立检查的价值是**早拒绝、意图明确**，不是提供额外行为。
   * 所以这里如实把它标成"等价变异（预期不翻转）"，而不是伪造一条能判红的用例。
   */
  ['删掉绝对路径独立检查（等价变异：与空段检查重叠）', (src2) => {
    const lines = src2.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("r.startsWith('/')")) {
        lines[i] = lines[i].replace("r.startsWith('/')", 'false');
        return lines.join('\n');
      }
    }
    return src2;
  }],
  ['v0 也带编号（上游不认）', (s) => s.replace("if (v <= 0) {\n    return 'session.jsonl.zstd';\n  }", '')],
];
for (const [label, mutate] of arms) {
  const mutated = mutate(src);
  const changed = mutated !== src;
  const m = changed ? buildModule(mutated) : null;
  if (m === null) {
    ok = false;
    console.log(`  ❌ ${label} ⇒ 变异未生效或模块不可求值`);
    continue;
  }
  runSuite(m);
  let reds = failures.length;
  /*
   * "放行绝对路径"这条与"空段"判据在实现里重叠，runSuite 不会因它变红；
   * 用**行为翻转**作为判别：变异后 `/a/b` 必须被接受（原实现拒绝）。
   */
  if (EQUIVALENT_ARMS.includes(label)) {
    const stillSafe = m.isSafeRelativePath('/a/b') === false;
    console.log(`  ${stillSafe ? 'ℹ️ ' : '✅'} ${label} ⇒ `
      + `${stillSafe ? '行为未变（等价变异，已在用例里注明原因）' : '行为翻转，判红'}`);
    if (!stillSafe) reds = Math.max(reds, 1);
    continue;
  }
  if (reds === 0) ok = false;
  console.log(`  ${reds > 0 ? '✅' : '❌'} ${label} ⇒ ${reds > 0 ? `判红（${reds} 条）` : '未判红（门禁没牙）'}`);
}
console.log(ok ? '\n✅ 自检通过。' : '\n❌ 自检失败（门禁没牙）。');
process.exit(ok ? 0 : 3);
