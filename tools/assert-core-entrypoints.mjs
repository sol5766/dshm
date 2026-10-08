#!/usr/bin/env node
/**
 * assert-core-entrypoints.mjs —— 裁剪后核心树的**入口可达性**门禁。
 *
 * 【为什么需要它】`pack-core.mjs` 的 `prune()` 按 glob 删文件（`*.d.ts` / `*.map` / `*.md` /
 * 测试目录）。glob 是**按路径形状**匹配的，而路径里的段**不一定**是它看起来的意思 ——
 * 2026-10-07 就差点栽在这里：候选规则里有一条 `**&#47;spec/**`（本意"spec 目录是测试语料"），
 * 而 `@standard-schema/spec` 里的 `spec` 是**包名**，那条规则会删掉它的 `dist/index.cjs`
 * ⇒ 交付到设备上才会以"某个包 require 失败"的形式炸，**症状离原因很远**。
 * 同一天还查出另一类：`matchGlob` 的链式 replace 会自我改写，`**&#47;*.d.ts` 实际只删到**一层**
 * 目录（见 `tools/pack-core.mjs` 里那段注释）—— 那次的方向是**删得太少**；本门禁管的是**删错**。
 *
 * 所以这条门禁把「删错文件」从**运行期**提前到**打包后立刻判红**：遍历核心树里每个**包根**的
 * `package.json`，把它声明的**运行期入口**逐条解析，要求**文件真的在**。
 *
 * 【判据（Node 的解析语义，简化但覆盖实况）】
 *   · 精确文件 ⇒ 通过；
 *   · 补扩展名（`.js` / `.cjs` / `.mjs` / `.json` / `.node`）命中 ⇒ 通过；
 *   · 目录 + `index.*` 命中 ⇒ 通过（`main: "lib"` 这类写法）；
 *   · 其余 ⇒ 记为缺失。
 *
 * 【刻意排除的声明面（排除是**判据的一部分**，不是漏检）】
 *   · `types` / `typings` / `exports` 里 `types` 条件的值：指向 `*.d.ts`，而**类型声明正是
 *     本门禁要放行的那类裁剪**（`**&#47;*.d.ts` 规则按设计删掉它们）⇒ 检它必然假红；
 *   · `module` / `browser` 字段与 `browser` 条件：**bundler 专用**，Node 运行期一律不读。
 *     实测两处上游实况：`@xterm/headless` 的 `module: lib/xterm.mjs` 在公开 tarball 里根本
 *     不存在（真正生效的是 `main: lib-headless/xterm-headless.js`）；`@opentelemetry/*` 的
 *     `browser[./src/...ts]` 指向**未随包发布**的 `src/` 源码。把它们算进来只会让门禁常红，
 *     而**常红等于没有门禁** ⇒ 判据里明确排除（这不是漏检：Node 确实不读这两处）；
 *   · `exports` 里的**非 Node 条件**：Node 只认 `node` / `node-addons` / `require` / `import` /
 *     `default`；`development` / `production` / `standard-schema-spec` 之类自定义条件一律不读
 *     （`@standard-schema/spec` 的 `standard-schema-spec: ./src/index.ts` 就是这么一条）；
 *   · 通配 / 前缀子路径（含 `*`、或以 `/` 结尾，如 `tslib` 的 `"./": "./"`）：无法逐条解析；
 *   · **非包根**的 `package.json`：Node 的包解析只发生在 `node_modules/<name>`（或
 *     `@scope/<name>`）；落在包体**内部**的那些不是解析位置 —— `fast-uri/benchmark/package.json`
 *     （private 开发目录，`main: index.js` 从来没发布过）、`@google/genai/node/package.json`
 *     （上游 shim，`main` 指向包外的 `../dist/node/index.js`，而真正发布的是 `index.cjs`/
 *     `index.mjs`）；
 *   · 裸说明符（`node:`、`@scope/pkg`、含 `:` 的协议串）：不是包内路径。
 *
 * 【定点不变量】`@standard-schema/spec` 存在时，它的**运行期**入口必须解析得到 —— 这条把上面那个
 * 具体陷阱钉死，失败信息里直接点名"spec 是包名"。
 *
 * 【对照臂 `--tree=`】`--tree=<核心树根>` 改检查指定树。用途：判"某条入口缺失是**本次裁剪引入**的，
 * 还是**上游本来就有**的" —— 拿上一版树跑同一段判据，两份 missing 列表逐一比对即可
 * （本轮就这么证过：+dshm.11 ↔ +dshm.12 的缺失集合都为空）。
 *
 * 用法：
 *   node tools/assert-core-entrypoints.mjs               # 检查配方当前版本那棵树（需要核心树）
 *   node tools/assert-core-entrypoints.mjs --tree=<dir>  # 检查指定核心树（对照臂）
 *   node tools/assert-core-entrypoints.mjs --self-test   # 注入式负测试：证明检测器真的会红
 *
 * 退出码：0 = 通过；1 = 有缺失；3 = 核心树不存在（需先 `node tools/pack-core.mjs --place-in-app`）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const RECIPE = JSON.parse(readFileSync(join(ROOT, 'hostcore', 'core-recipe.json'), 'utf8'));

/** Node 认的条件名；其余一律按 bundler/自定义条件排除（运行期不读）。 */
const NODE_CONDITIONS = new Set(['node', 'node-addons', 'require', 'import', 'default']);

/** 声明面里**不参与**校验的值：类型声明（按设计被裁）、子路径模式、裸说明符。 */
function isCheckable(spec) {
  if (typeof spec !== 'string' || spec.length === 0) return false;
  if (spec.includes('*')) return false;
  if (/\.d\.(ts|cts|mts)$/.test(spec)) return false;
  if (spec.startsWith('node:')) return false;
  if (spec.includes(':')) return false;
  if (spec.startsWith('@')) return false;
  return true;
}

/** 收集一个 package.json 里所有"应当指向包内文件"的**运行期**入口声明。 */
function entrySpecs(pkg) {
  const out = [];
  const push = (v, label) => {
    if (isCheckable(v)) out.push({ spec: v, label });
  };
  push(pkg.main, 'main');
  if (typeof pkg.bin === 'string') push(pkg.bin, 'bin');
  if (pkg.bin !== null && typeof pkg.bin === 'object' && !Array.isArray(pkg.bin)) {
    for (const [k, v] of Object.entries(pkg.bin)) push(v, `bin[${k}]`);
  }
  const walkExports = (node, label) => {
    if (typeof node === 'string') {
      push(node, label);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((n, i) => walkExports(n, `${label}[${i}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'types' || k === 'typings' || k === 'browser') continue;
        const isSubpath = k.startsWith('.');
        // 非子路径键必须是 Node 认的条件名；自定义条件（如 standard-schema-spec）运行期不读。
        if (!isSubpath && !NODE_CONDITIONS.has(k)) continue;
        // 通配 / 前缀映射（`./*`、`"./"`）：无法逐条解析。
        if (k.endsWith('*') || k.endsWith('/')) continue;
        walkExports(v, isSubpath ? (k === '.' ? label : `${label}[${k}]`) : `${label}.${k}`);
      }
    }
  };
  if (pkg.exports !== undefined) walkExports(pkg.exports, 'exports');
  return out;
}

/** Node 的解析语义（简化）：精确文件 → 补扩展名 → 目录 index。返回命中的路径，或 null。 */
function resolvesToFile(pkgDir, spec) {
  const base = spec.startsWith('./') ? join(pkgDir, spec.slice(2)) : join(pkgDir, spec);
  const cands = [
    base,
    `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}.json`, `${base}.node`,
    join(base, 'index.js'), join(base, 'index.cjs'), join(base, 'index.mjs'),
    join(base, 'index.json'), join(base, 'index.node'),
  ];
  for (const c of cands) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      // 不存在（或权限异常）：继续试下一个候选
    }
  }
  return null;
}

function listPackageJsons(nm) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name === 'package.json') out.push(p);
    }
  };
  walk(nm);
  return out;
}

/**
 * 是不是 Node 的**包解析位置**：`<nm>/<name>`、`<nm>/@scope/<name>`，或任意 `node_modules/<name>`。
 * 包体**内部**的 package.json（`fast-uri/benchmark`、`@google/genai/node`）不是 —— 见文件头。
 */
function isPackageRoot(dir, nm) {
  const segs = dir.slice(nm.length + 1).split(sep);
  const i = segs.lastIndexOf('node_modules');
  const after = i >= 0 ? segs.slice(i + 1) : segs;
  if (after.length === 1) return true;
  return after.length === 2 && after[0].startsWith('@');
}

/**
 * 检查一棵 node_modules：返回 {packages, resolved, unparsable, skipped, missing[]}。
 * 抽成函数是为了让 `--self-test` 能在**临时合成的树**上跑同一段判据（注入式负测试）。
 */
function checkTree(nm) {
  const missing = [];
  let packages = 0;
  let unparsable = 0;
  let resolved = 0;
  let skipped = 0;
  for (const pkgPath of listPackageJsons(nm)) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch {
      unparsable++;
      continue;
    }
    const dir = pkgPath.slice(0, pkgPath.length - 'package.json'.length - 1);
    if (!isPackageRoot(dir, nm)) {
      skipped++;
      continue;
    }
    packages++;
    for (const { spec, label } of entrySpecs(pkg)) {
      if (resolvesToFile(dir, spec) !== null) {
        resolved++;
        continue;
      }
      // rel 统一用 `/` 作分隔符：自检的期望串与报错输出都不该随平台变（Windows 下 join 给的是 `\`）。
      missing.push({ rel: pkgPath.slice(nm.length + 1).split(sep).join('/'), label, spec });
    }
  }
  return { packages, resolved, unparsable, skipped, missing };
}

// ── 注入式负测试：把「检测器真会红」证明出来 ──────────────────────────────
if (process.argv.includes('--self-test')) {
  const stage = join(tmpdir(), `dshm-entrypoints-selftest-${process.pid}`);
  const mk = (rel, body) => {
    const p = join(stage, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  };
  try {
    mk('node_modules/ok/package.json', JSON.stringify({ name: 'ok', main: 'index.js' }));
    mk('node_modules/ok/index.js', 'module.exports = 1;\n');
    mk('node_modules/broken/package.json',
      JSON.stringify({ name: 'broken', main: 'dist/index.cjs', exports: { '.': { require: './dist/index.cjs' } } }));
    mk('node_modules/dir-main/package.json', JSON.stringify({ name: 'dir-main', main: 'lib' }));
    mk('node_modules/dir-main/lib/index.js', 'module.exports = 2;\n');
    mk('node_modules/types-only/package.json',
      JSON.stringify({ name: 'types-only', main: 'index.js', types: 'index.d.ts' }));
    mk('node_modules/types-only/index.js', 'module.exports = 3;\n');
    // 负控 ①：bundler 专用字段缺文件 ⇒ **不得**报（Node 运行期不读 module/browser）
    mk('node_modules/bundler-only/package.json', JSON.stringify({
      name: 'bundler-only', main: 'index.js', module: 'nope.mjs', browser: { './index.js': './nope-browser.js' },
    }));
    mk('node_modules/bundler-only/index.js', 'module.exports = 4;\n');
    // 负控 ②：非 Node 自定义条件指向源码 ⇒ **不得**报（@standard-schema/spec 的同形）
    mk('node_modules/custom-cond/package.json', JSON.stringify({
      name: 'custom-cond',
      exports: { '.': { 'standard-schema-spec': './src/index.ts', require: './dist/index.cjs' } },
    }));
    mk('node_modules/custom-cond/dist/index.cjs', 'module.exports = 5;\n');
    // 负控 ③：包体内部的 package.json（非包根）⇒ **不得**报（fast-uri/benchmark 的同形）
    mk('node_modules/ok/benchmark/package.json', JSON.stringify({ name: 'benchmark', private: true, main: 'index.js' }));

    const r = checkTree(join(stage, 'node_modules'));
    const misses = r.missing.map((m) => `${m.rel} ${m.label}=${m.spec}`);
    const expect = ['broken/package.json main=dist/index.cjs', 'broken/package.json exports.require=./dist/index.cjs'];
    const okA = r.missing.length === expect.length && expect.every((e) => misses.includes(e));
    // 对照臂：能解析的（精确文件 / 目录 index）、"types 指向 .d.ts"、以及三条负控都**不得**被报。
    const okB = !misses.some((m) => m.startsWith('ok/') || m.startsWith('dir-main/')
      || m.startsWith('types-only/') || m.startsWith('bundler-only/')
      || m.startsWith('custom-cond/'));
    const okC = r.skipped === 1; // 只有 ok/benchmark 那一个按"非包根"跳过
    if (okA && okB && okC) {
      console.log('PASS：对照实验成立 —— 合成的缺失入口被逐条报出；可解析的、`types` 指向 .d.ts 的、'
        + 'bundler 专用字段、非 Node 自定义条件、非包根 package.json 一律不误报。');
      console.log(`      报出 ${r.missing.length} 条：${misses.join('；')}（另有 ${r.skipped} 个非包根跳过）`);
      process.exit(0);
    }
    console.error('FAIL：自检未按预期 ——');
    console.error(`      实际报出 ${r.missing.length} 条：${misses.join('；') || '（无）'}`);
    console.error(`      期望恰好报出：${expect.join('；')}`);
    console.error(`      非包根跳过数 ${r.skipped}（期望 1）；报出 ${r.packages} 个包根`);
    process.exit(1);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// ── 正式检查（需要核心树）──────────────────────────────────────────────
/*
 * 【--tree= 是给对照臂用的】默认检查"配方当前版本"那棵树；给 `--tree=<核心树根>` 时改检查指定树
 * （可以指向别的版本目录）。用途：判"某条入口缺失是本次裁剪引入的，还是上游本来就有的" ——
 * 拿上一版树跑同一段判据，两份 missing 列表逐一比对即可。
 */
const treeArg = (process.argv.find((a) => a.startsWith('--tree=')) ?? '').slice('--tree='.length);
const NM = treeArg !== ''
  ? join(resolve(treeArg), 'node_modules')
  : join(ROOT, 'dist', 'core', 'work', `dsh-core-${RECIPE.coreVersion}`, 'node_modules');
if (!existsSync(NM)) {
  console.error(`SKIP：核心树不存在（${NM}）。`);
  console.error('      先跑 node tools/pack-core.mjs --place-in-app（本门禁需要核心树）。');
  process.exit(3);
}

const r = checkTree(NM);
const treeLabel = treeArg !== '' ? NM : RECIPE.coreVersion;
console.log(`[assert-core-entrypoints] 核心树 ${treeLabel}：${r.packages} 个包根、`
  + `${r.resolved + r.missing.length} 条运行期入口声明（解析成功 ${r.resolved}）`
  + (r.skipped > 0 ? `；另有 ${r.skipped} 个包体内的 package.json 按判据跳过` : '')
  + (r.unparsable > 0 ? `；${r.unparsable} 个 package.json 无法解析（跳过）` : ''));

// 定点不变量：spec 段陷阱（见文件头）
const trapPkg = join(NM, '@standard-schema', 'spec', 'package.json');
if (existsSync(trapPkg)) {
  const pkg = JSON.parse(readFileSync(trapPkg, 'utf8'));
  const dir = join(NM, '@standard-schema', 'spec');
  const bad = entrySpecs(pkg).filter((e) => resolvesToFile(dir, e.spec) === null);
  if (bad.length > 0) {
    for (const b of bad) r.missing.push({ rel: '@standard-schema/spec/package.json', label: b.label, spec: b.spec });
    console.error('  ✗ 定点不变量：@standard-schema/spec 的运行期入口解析不到 —— 注意它的 `spec` 段是**包名**，'
      + '任何"按目录名 spec 删测试"的裁剪规则都会删掉它的 dist 入口（正是 docs/112 §5.2 记的那处陷阱）。');
  } else {
    console.log('  ✓ 定点：@standard-schema/spec 的运行期入口仍在（spec 段是包名，不是测试目录）');
  }
}

if (r.missing.length === 0) {
  console.log('结果：PASS —— 所有运行期入口声明都解析得到包内文件，裁剪没有删掉任何入口。');
  process.exit(0);
}
console.error(`结果：FAIL —— ${r.missing.length} 条运行期入口声明解析不到文件（裁剪删错了东西）：`);
for (const m of r.missing.slice(0, 40)) {
  console.error(`  ✗ ${m.rel}  ${m.label} → ${m.spec}`);
}
if (r.missing.length > 40) {
  console.error(`  …… 另有 ${r.missing.length - 40} 条（见上表口径，请先修 prune 规则）`);
}
process.exit(1);
