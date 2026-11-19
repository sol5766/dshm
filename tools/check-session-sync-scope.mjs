#!/usr/bin/env node
/**
 * 门禁：会话同步的**本地清单**（docs/298 P2）。
 *
 * 【为什么需要它】清单是同步的输入面。这里错了，后果是**不可逆的数据事故**：
 *   · 把 `cores/`（350 MB/棵）扫进清单 ⇒ 上传巨量非用户数据；
 *   · 把 `cache/` 扫进去 ⇒ 传一堆可再生垃圾；
 *   · 代际版本解析错 ⇒ 恢复时把 v2 的日志当成 v0 交给老核心 ⇒ 会话读不出来；
 *   · 清单顺序不稳定 ⇒ 每次同步都"发现变更"，退化成全量重传。
 * 这些都不报编译错，只会安静地把错数据送到云上。
 *
 * 【判据（纯离线，不需要设备）】
 *   A. 代际解析与上游 `CANONICAL_LOG_FILENAME` 同口径：
 *      `session.jsonl` ⇒ 0；`session.v3.jsonl` ⇒ 3；
 *      `session.v01.jsonl` / `session.v0.jsonl` / `SESSION.v3.jsonl` / 其它名 ⇒ -1
 *   B. 排除面：`cache` / `cores` / `node_modules` / `*.tmp` / `*..stale` / `.dsh-mkdir-*` 全部判真
 *   C. 对外 JSON **不含绝对路径**（云端索引里不该出现本机路径）
 *   D. `relativePathOf` 与上游命名同形（v0 无编号、vN 带编号）
 *
 * 对照臂（--self-test）：把排除面去掉 cores / 把前导零规则放宽 / 让 JSON 带 root 路径
 * ⇒ 必须判红。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = 'platform/src/main/ets/system/SessionSyncScope.ets';

/**
 * 剥掉 TypeScript 类型标注，让函数体能在 **纯 JS** 里求值。
 *
 * 【为什么需要】`.ets` 是 ArkTS 源码：`function f(x: string): number` 这种签名
 * 在 Node 里是语法错误（`Unexpected token ':'`）。本门禁要**真跑**行为，
 * 所以只做最小改写：去掉参数与返回类型、去掉 `const x: T =` 里的 `: T`、
 * 去掉 `as T`。**不做通用转译**——抽出来的都是本文件的纯函数，形状可控。
 */
function stripTypes(code) {
  let out = code;
  // 函数签名里的 (a: T, b?: T): R => 去掉类型
  out = out.replace(/\(([^()]*)\)\s*:\s*[\w<>\[\]|\s.,]+\s*\{/g, (m, params) => {
    const clean = params
      .split(',')
      .map((p) => p.trim().replace(/\?\s*:/, ':').replace(/\s*:[^,]+$/, '').trim())
      .filter((p) => p.length > 0)
      .join(', ');
    return `(${clean}) {`;
  });
  // const x: T =  ⇒ const x =
  out = out.replace(/(const|let)\s+([A-Za-z_$][\w$]*)\s*:\s*[^=]+=/g, '$1 $2 =');
  // 形如 `arr: Type[]` 的参数已在上一步处理；再兜底去掉 `as Type`
  out = out.replace(/\s+as\s+[\w<>\[\]|]+/g, '');
  // 返回类型里的 `: Type` 已在首条正则处理；剩下的 `: Array<...>` 之类再兜一次
  out = out.replace(/\)\s*:\s*[\w<>\[\]|]+\s*\{/g, ') {');
  return out;
}

/**
 * 从 .ets 里抽出纯函数并**真跑**。
 *
 * 【为什么不用正则断言而用真跑】这些函数的判据是"输入 → 输出"，正则只能证明
 * "代码里有某个词"，证明不了行为。把源码里的函数体取出来用 `new Function` 求值，
 * 断言的就是**真实行为**（与 `check-cli-shim-semantics` 同一手法）。
 */
function buildModule(src) {
  const pick = (name) => {
    const at = src.indexOf(`export function ${name}(`);
    if (at < 0) return '';
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
  };
  const genVer = pick('generationVersionOf');
  const excluded = pick('isExcludedName');
  const relPath = pick('relativePathOf');
  const toJson = pick('toManifestJson');
  const schemaLine = /export const MANIFEST_SCHEMA: number = (\d+);/.exec(src);
  if (genVer === '' || excluded === '' || relPath === '' || toJson === '' || schemaLine === null) {
    return null;
  }
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`
      ${stripTypes(genVer.replace('export function', 'function'))}
      ${stripTypes(excluded.replace('export function', 'function'))}
      ${stripTypes(relPath.replace('export function', 'function'))}
      ${stripTypes(toJson.replace('export function', 'function'))}
      const MANIFEST_SCHEMA = ${schemaLine[1]};
      return { generationVersionOf, isExcludedName, relativePathOf, toManifestJson, MANIFEST_SCHEMA };
    `)();
  } catch (e) {
    console.error(`模块求值失败：${e.message}`);
    return null;
  }
}

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
  } else {
    failures.push(`${name}${detail ? `：${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? `（${detail}）` : ''}`);
  }
}

function runSuite(mod) {
  passed = 0;
  failures.length = 0;

  // ── A：代际解析 ──────────────────────────────────────────────────────
  const cases = [
    ['session.jsonl', 0, 'v0 无编号'],
    ['session.jsonl.zstd', 0, 'v0 + zstd 后缀'],
    ['session.v1.jsonl', 1, 'v1'],
    ['session.v3.jsonl.zstd', 3, 'v3 + zstd'],
    ['session.v12.jsonl.zstd', 12, '两位数'],
    ['session.v01.jsonl', -1, '前导零非规范'],
    ['session.v0.jsonl', -1, 'v0 带编号非规范'],
    ['SESSION.v3.jsonl', -1, '大写非规范'],
    ['session.v3.jsonl.tmp', -1, '临时文件'],
    ['other.jsonl', -1, '非 session 前缀'],
    ['session.txt', -1, '非 jsonl'],
  ];
  for (const [name, want, why] of cases) {
    const got = mod.generationVersionOf(name);
    check(`A 代际解析 ${name} ⇒ ${want}（${why}）`, got === want, `实际 ${got}`);
  }

  // ── B：排除面 ────────────────────────────────────────────────────────
  for (const name of ['cache', 'cores', 'node_modules', 'x.tmp', 'x.stale', '.dsh-mkdir-abc', '']) {
    check(`B 排除 ${JSON.stringify(name)} ⇒ 判真`, mod.isExcludedName(name) === true);
  }
  for (const name of ['--storage-Users-...--', 'abc123', 'session']) {
    check(`B 不误伤 ${name} ⇒ 判假`, mod.isExcludedName(name) === false);
  }

  // ── C：对外 JSON 不含绝对路径 ────────────────────────────────────────
  const manifest = {
    root: '/data/storage/el2/base/haps/entry/files/dsh/home/sessions',
    sessions: [{
      id: 'sess-1',
      projectKey: '--storage-Users-currentUser-test--',
      bytes: 100,
      generations: [{ version: 0, path: '/abs/path/session.jsonl.zstd', bytes: 100 }],
    }],
    sessionCount: 1,
    totalBytes: 100,
    skipped: [],
  };
  const json = mod.toManifestJson(manifest);
  const text = JSON.stringify(json);
  check('C 清单 JSON 不含本机绝对路径', !text.includes('/abs/path') && !text.includes('/data/storage'),
    text.slice(0, 120));
  check('C 清单 JSON 带 schema 号', json.schema === mod.MANIFEST_SCHEMA);
  check('C 清单 JSON 只留 version/bytes（不泄漏路径字段）',
    json.sessions[0].generations[0].path === undefined
    && json.sessions[0].generations[0].version === 0);

  // ── D：相对落点与上游命名同形 ────────────────────────────────────────
  check('D v0 相对路径无编号',
    mod.relativePathOf('--pk--', 'sid', 0) === '--pk--/sid/session.jsonl.zstd',
    mod.relativePathOf('--pk--', 'sid', 0));
  check('D v3 相对路径带 .v3',
    mod.relativePathOf('--pk--', 'sid', 3) === '--pk--/sid/session.v3.jsonl.zstd',
    mod.relativePathOf('--pk--', 'sid', 3));
}

const selfTest = process.argv.includes('--self-test');
const src = readFileSync(join(ROOT, SRC), 'utf8');
const mod = buildModule(src);
if (mod === null) {
  console.error(`❌ 无法从 ${SRC} 抽出清单函数（导出被改名？）`);
  process.exit(1);
}

if (!selfTest) {
  runSuite(mod);
  console.log(`  ok    ${passed} 条判据通过`);
  if (failures.length > 0) {
    console.error(`\n❌ 同步清单不合格（${failures.length} 条）`);
    process.exit(1);
  }
  console.log('✅ 通过：代际解析与上游同口径、排除面完整、对外 JSON 无绝对路径。');
  process.exit(0);
}

console.log('--self-test：变异体必须判红 --');
runSuite(mod);
let ok = failures.length === 0;
console.log(`  基线：问题 ${failures.length} 处（应为 0）`);

const arms = [
  ['排除面去掉 cores（会把 350MB/棵 核心树传上去）', (s) => s.replace(
    "  if (n === 'cache' || n === 'cores' || n === 'node_modules') {",
    "  if (n === 'cache' || n === 'node_modules') {")],
  ['放宽前导零规则（把 v01 当成 v1）', (src2) => {
    /*
     * 【为什么要按行找、且避开转义】`[1-9][0-9]*` 在文件里出现两次（注释 + 实现），
     * `String.replace` 默认只换第一处 ⇒ 改到注释、实现没动，变异"生效"但行为不变。
     * 这里按行匹配：只挑**以 const m = new RegExp 开头**的那一行整体替换，
     * 新行用同样合法的正则（字符类放宽成 [0-9]+）。
     */
    const lines = src2.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('const m = new RegExp') && lines[i].includes('[1-9][0-9]*')) {
        lines[i] = lines[i].replace('[1-9][0-9]*', '[0-9]+');
        return lines.join('\n');
      }
    }
    return src2;
  }],
  ['对外 JSON 带出本机 root 路径', (s) => s.replace(
    "    root: '',\n    sessionCount: manifest.sessionCount,",
    "    root: manifest.root,\n    sessionCount: manifest.sessionCount,")],
];
for (const [label, mutate] of arms) {
  const mutated = mutate(src);
  const changed = mutated !== src;
  const m = changed ? buildModule(mutated) : null;
  if (m === null) { ok = false; console.log(`  ❌ ${label} ⇒ 变异未生效或模块不可求值`); continue; }
  runSuite(m);
  const reds = failures.length;
  if (reds === 0) ok = false;
  console.log(`  ${reds > 0 ? '✅' : '❌'} ${label} ⇒ ${reds > 0 ? `判红（${reds} 条）` : '未判红（门禁没牙）'}`);
}
console.log(ok ? '\n✅ 自检通过。' : '\n❌ 自检失败（门禁没牙）。');
process.exit(ok ? 0 : 3);
