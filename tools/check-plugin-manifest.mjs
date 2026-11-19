#!/usr/bin/env node
/**
 * 门禁：插件清单同步（docs/310）。
 *
 * 【为什么需要它】插件清单是"跨端重装插件"的唯一依据。这里错了，后果是
 * **在用户的另一台设备上装错东西**：
 *   · 把 `@deepseek-ai/*` 上游自带的包当成"用户插件"去装 ⇒ 与核心树自带版本冲突；
 *   · 丢掉 `bundles` 顺序 ⇒ patch 应用顺序乱掉（`cordis.patch.yml` 头注明确顺序有意义）；
 *   · 读错 spec ⇒ 装了个错的仓库。
 * 这三条都不会报编译错，只会安静地把错误清单送到云端。
 *
 * 【判据（纯离线）】
 *   A. 基础包过滤：`@deepseek-ai/*` 一律不进清单
 *   B. 顺序：以 `dsh.profile.bundles` 为准（不是 dependencies 的键顺序）
 *   C. spec 原样保留（`github:o/r#ref` 与 npm 版本号逐字不动）
 *   D. 缺 dependencies 的 bundle 要记进 skipped，不能静默丢
 *   E. specKind 分类正确
 *
 * 对照臂（--self-test）：去掉基础包过滤 / 改用 dependencies 顺序 / 改写 spec ⇒ 必须判红。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = 'platform/src/main/ets/sync/PluginManifest.ets';

/**
 * 剥掉 TypeScript 类型标注，让函数体能被纯 JS 求值。
 * （与 `check-session-sync-scope` 同一手法：**真跑行为**，不是正则匹配字面量。）
 */
/**
 * 剥掉 TypeScript 类型标注，让函数体能被纯 JS 求值。
 *
 * 【为什么用 Node 自带的 stripTypeScriptTypes】自己写正则剥类型踩过两次坑：
 *   · `for (let i: number = 0` 里的标注漏掉；
 *   · `as Record<string, Object>` 的泛型被截断成 `, Object>`。
 * Node 26 内置的 `module.stripTypeScriptTypes()` 是**官方类型擦除**，
 * 不必再手写正则 —— 而且它和 TypeScript 的语义一致，不会因写法变化而漏。
 */
function stripTypes(code) {
  return stripTypeScriptTypes(code, { mode: 'strip' });
}

/** 从 .ets 抽出可求值的函数集合。 */
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
  const parts = ['isBundledPackage', 'specKind', 'parsePluginManifest', 'toInstallPayload']
    .map((n) => pick(n));
  if (parts.some((p) => p === '')) return null;
  const schemaMatch = /export const PLUGIN_MANIFEST_SCHEMA: number = (\d+);/.exec(src);
  const prefixMatch = /const BUNDLED_PREFIX: string = '([^']+)';/.exec(src);
  if (schemaMatch === null || prefixMatch === null) return null;
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`
      const BUNDLED_PREFIX = ${JSON.stringify(prefixMatch[1])};
      const PLUGIN_MANIFEST_SCHEMA = ${schemaMatch[1]};
      ${parts.map((p, i) => stripTypes(p.replace('export function', 'function'))).join('\n')}
      return { isBundledPackage, specKind, parsePluginManifest, toInstallPayload };
    `)();
  } catch (e) {
    console.error(`模块求值失败：${e.message}`);
    return null;
  }
}

/**
 * 一份贴近真机的 profile（顺序刻意与 dependencies 键顺序不同）。
 *
 * 【dsh-base 版本为什么写死】这是**合成样例**，用来验证排序/遍历逻辑，
 * 不参与"与配方同版"的判据（那条判据对着真 profile 跑）。改动它没有意义。
 */
const FIXTURE = JSON.stringify({
  name: 'dshm-ondevice-profile',
  version: '0.0.0',
  dependencies: {
    'dsh-xdpool': 'github:XDTrees/dsh-xdpool#v2.5.0',
    '@deepseek-ai/dsh-base': '0.2.1-rc.4',
    'dsh-context': '0.77.0',
    '@deepseek-ai/dsh-subagent-codex': '0.2.1-rc.3',
    'dsh-cost-meter': '1.9.41',
    'dshmarket': 'github:dsh-market/dsh-market#d797f38834c53a97a5827651f60ab35a461b44d3',
  },
  dsh: {
    profile: {
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-subagent-codex',
        'dsh-context',
        'dsh-xdpool',
        'dsh-cost-meter',
        'dshmarket',
        'dsh-ghost-pkg',
      ],
      removeBundles: [],
    },
  },
});

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

  // A 基础包过滤
  check('A @deepseek-ai/dsh-base 判为基础包', mod.isBundledPackage('@deepseek-ai/dsh-base') === true);
  check('A dsh-context 不是基础包', mod.isBundledPackage('dsh-context') === false);

  // E specKind
  check('E github: 判为 git', mod.specKind('github:o/r#v1') === 'git');
  check('E 版本号判为 npm', mod.specKind('0.77.0') === 'npm');
  check('E file: 判为 local', mod.specKind('file:../x') === 'local');

  // B/C/D 解析
  const m = mod.parsePluginManifest(FIXTURE);
  const names = m.plugins.map((p) => p.name);
  check('A 清单不含 @deepseek-ai/*', names.every((n) => !n.startsWith('@deepseek-ai/')), names.join(','));
  check('B 顺序按 bundles（dsh-context 在 dsh-xdpool 之前）',
    names.indexOf('dsh-context') < names.indexOf('dsh-xdpool'), names.join(','));
  check('B/C 数量正确（4 个用户插件）', names.length === 4, String(names.length));
  check('C github spec 原样保留',
    m.plugins.find((p) => p.name === 'dsh-xdpool').spec === 'github:XDTrees/dsh-xdpool#v2.5.0');
  check('C npm spec 原样保留',
    m.plugins.find((p) => p.name === 'dsh-context').spec === '0.77.0');
  check('D bundles 里缺 dependencies 的包记进 skipped',
    m.skipped.some((s) => s.includes('dsh-ghost-pkg')), m.skipped.join('|'));

  // toInstallPayload 形状
  const payload = JSON.parse(mod.toInstallPayload(m));
  check('payload 带 schema', payload.schema === 1);
  check('payload 只含 name/spec', Object.keys(payload.plugins[0]).sort().join(',') === 'name,spec');

  // 边界：非法 JSON
  const bad = mod.parsePluginManifest('{not json');
  check('非法 JSON 不抛错且 skipped 有原因', bad.plugins.length === 0 && bad.skipped.length > 0);
}

const selfTest = process.argv.includes('--self-test');
const src = readFileSync(join(ROOT, SRC), 'utf8');
const mod = buildModule(src);
if (mod === null) {
  console.error(`❌ 无法从 ${SRC} 抽出插件清单函数`);
  process.exit(1);
}

if (!selfTest) {
  runSuite(mod);
  console.log(`  ok    ${passed} 条判据通过`);
  if (failures.length > 0) {
    console.error(`\n❌ 插件清单不合格（${failures.length} 条）`);
    process.exit(1);
  }
  console.log('✅ 通过：基础包过滤、bundles 顺序、spec 原样保留、skipped 可解释。');
  process.exit(0);
}

console.log('--self-test：变异体必须判红 --');
runSuite(mod);
let ok = failures.length === 0;
console.log(`  基线：问题 ${failures.length} 处（应为 0）`);

const arms = [
  ['去掉基础包过滤（会把上游自带包当用户插件）', (s) => s.replace(
    'return n.startsWith(BUNDLED_PREFIX);', 'return false;')],
  /*
   * 【变异必须真的换掉"顺序来源"】第一版是反转 dependencies 键顺序 ——
   * 无效：补 dependencies 那一轮只处理 bundles 之外的包，反不反转都不影响最终顺序
   * ⇒ 变异不判红，看起来像"门禁没牙"。
   * 这里改成**跳过 bundles 那一轮**，完全按 dependencies 顺序产出 —— 这才是
   * "顺序来源错误"的真实形态（bundles 里 dsh-context 在 dsh-xdpool 之前，
   * 而 dependencies 里 xdpool 在前，两者必然不同）。
   */
  ['改用 dependencies 顺序（不按 bundles）', (s) => {
    const loop = 'for (let i: number = 0; i < bundles.length; i++) {';
    if (!s.includes(loop)) return s;
    return s.replace(loop, 'for (let i: number = 0; i < 0; i++) {');
  }],
  ['改写 spec（丢掉 #ref）', (s) => s.replace(
    'out.plugins.push({ name: name, spec: String(spec) });',
    'out.plugins.push({ name: name, spec: String(spec).split("#")[0] });')],
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
