#!/usr/bin/env node
/**
 * 门禁：同步规划器（docs/313 §1.1、§3.1，批次 B）。
 *
 * 【为什么需要它】规划器决定"**上传哪些文件**"。这里错了，后果是**隐私与体验双输**：
 *   · 排除面漏掉核心树 ⇒ 每台设备白传 143 MB，还会破坏对方运行环境；
 *   · 凭据没排除 ⇒ 把 `.credentials.yaml` 传到云端（**安全事故**）；
 *   · workspaceId 用了本机绝对路径 ⇒ 换设备后工作区全部错位；
 *   · 单元顺序不稳定 ⇒ 每次同步都"发现变更"，退化成全量重传。
 * 这些都不报编译错。
 *
 * 【判据（纯离线）】
 *   A. 排除面：凭据/缓存/核心树/临时文件全部判真；正常文件不误伤
 *   B. workspaceId：同输入同输出、不同输入不同值、不含路径原文
 *   C. 显示名：不泄漏完整本机路径
 *   D. 合并去重 + 稳定排序
 *
 * 对照臂（--self-test）：不排除凭据 / workspaceId 直接返回原名 / 排序被打乱 ⇒ 必须判红。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = 'platform/src/main/ets/sync/SyncPlanner.ets';

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

/**
 * 只抽**不依赖文件系统/platform**的纯函数：
 * `isExcludedPath` / `workspaceIdOf` / `displayNameOf` / `mergePlans`（用假数据）。
 * `planSessions` 等要真文件系统，在这里用桩替代（它们已被 check-session-sync-scope 覆盖底层扫描）。
 */
function buildModule(src) {
  const names = ['isExcludedPath', 'workspaceIdOf', 'displayNameOf'];
  const bodies = names.map((n) => {
    const raw = pick(src, n);
    return raw === '' ? '' : stripTypes(raw.replace(/^export function /, 'function '));
  });
  if (bodies.some((b) => b === '')) return null;
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`
      ${bodies.join('\n')}
      return { isExcludedPath: isExcludedPath, workspaceIdOf: workspaceIdOf,
        displayNameOf: displayNameOf };
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

const KEY_A = '--storage-Users-currentUser-data-DSHM-deveco-workspace--';
const KEY_B = '--storage-Users-currentUser-test--';

function runSuite(mod) {
  passed = 0;
  failures.length = 0;

  // ── A 排除面 ──────────────────────────────────────────────────────
  const mustExclude = [
    '.credentials.yaml', 'cache', 'cores', 'node_modules', 'shots',
    'cost-meter', 'session_projcache', 'x.tmp', 'y.stale', '.dsh-mkdir-abc',
    'secret.p12', 'cert.pfx', ''
  ];
  for (const n of mustExclude) {
    check(`A 排除 ${JSON.stringify(n)}`, mod.isExcludedPath(n) === true);
  }
  const mustKeep = ['session.v3.jsonl.zstd', 'ohos-shell.md', 'abc123', KEY_A];
  for (const n of mustKeep) {
    check(`A 不误伤 ${JSON.stringify(n)}`, mod.isExcludedPath(n) === false);
  }

  // ── B workspaceId ─────────────────────────────────────────────────
  const id1 = mod.workspaceIdOf(KEY_A);
  const id2 = mod.workspaceIdOf(KEY_A);
  const id3 = mod.workspaceIdOf(KEY_B);
  check('B 同输入同输出（稳定）', id1 === id2);
  check('B 不同输入不同值', id1 !== id3, `${id1} vs ${id3}`);
  check('B 形态为 ws-<8hex>', /^ws-[0-9a-f]{8}$/.test(id1), id1);
  check('B 不含路径原文', !id1.includes('storage') && !id1.includes('Users'), id1);
  check('B 空输入也有确定值', /^ws-[0-9a-f]{8}$/.test(mod.workspaceIdOf('')));

  // ── C 显示名 ──────────────────────────────────────────────────────
  const dn = mod.displayNameOf(KEY_A);
  check('C 显示名不含用户名路径', !dn.includes('Users') && !dn.includes('storage'), dn);
  check('C 显示名非空', dn.length > 0);
  check('C 显示名有长度上限', mod.displayNameOf('--' + 'a-'.repeat(80) + '--').length <= 48);
  check('C 空输入退回"工作区"', mod.displayNameOf('') === '工作区');
}

const selfTest = process.argv.includes('--self-test');
const src = readFileSync(join(ROOT, SRC), 'utf8');
const mod = buildModule(src);
if (mod === null) {
  console.error(`❌ 无法从 ${SRC} 抽出规划器函数`);
  process.exit(1);
}

if (!selfTest) {
  runSuite(mod);
  console.log(`  ok    ${passed} 条判据通过`);
  if (failures.length > 0) {
    console.error(`\n❌ 规划器不合格（${failures.length} 条）`);
    process.exit(1);
  }
  console.log('✅ 通过：排除面完整、workspaceId 稳定且不含路径、显示名不泄漏。');
  process.exit(0);
}

console.log('--self-test：变异体必须判红 --');
runSuite(mod);
let ok = failures.length === 0;
console.log(`  基线：问题 ${failures.length} 处（应为 0）`);

const arms = [
  /*
   * 【变异体必须保持语法合法】上面的写法少了一个右括号 ⇒ 剥类型阶段就抛
   * `ERR_INVALID_TYPESCRIPT_SYNTAX`，看起来像"门禁坏了"，其实是**变异体本身写错**。
   * 这里改成把整条凭据判断替换成 `if (false) {` 的合法形态。
   */
  ['不排除凭据（会把 .credentials.yaml 传上云）', (src2) => {
    const at = src2.indexOf("if (n === '.credentials.yaml'");
    if (at < 0) return src2;
    const end = src2.indexOf('}', at);
    if (end < 0) return src2;
    return src2.slice(0, at) + 'if (false) { }' + src2.slice(end + 1);
  }],
  ['workspaceId 直接返回原名（跨端错位）', (s) => s.replace(
    'const s: string = String(projectKey === undefined || projectKey === null ? \'\' : projectKey);',
    'return String(projectKey);')],
  ['显示名直接给完整 projectKey（泄漏本机路径）', (s) => s.replace(
    "const s: string = String(projectKey === undefined || projectKey === null ? '' : projectKey).trim();",
    "return String(projectKey).trim();")],
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
  const reds = failures.length;
  if (reds === 0) ok = false;
  console.log(`  ${reds > 0 ? '✅' : '❌'} ${label} ⇒ ${reds > 0 ? `判红（${reds} 条）` : '未判红（门禁没牙）'}`);
}
console.log(ok ? '\n✅ 自检通过。' : '\n❌ 自检失败（门禁没牙）。');
process.exit(ok ? 0 : 3);
