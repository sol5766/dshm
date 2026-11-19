#!/usr/bin/env node
/**
 * 门禁：插件「项目地址安装」的 GitHub 地址归一化（+dshm.48，2026-10-14 用户报障）。
 *
 * 【用户看到的现象】「设置 → 插件 → 项目地址」里粘贴**从浏览器地址栏复制的 GitHub 地址**
 * （`https://github.com/o/r/tree/main/sub`、带 `?tab=readme-ov-file`、带尾斜杠…），
 * UI 回「无法识别这个包名或地址」。
 *
 * 【根因】上游 `dsh-plugin-manager` 的 `HOSTED_REPOSITORY_URL` 只认
 * "Host + 恰好两段路径"：`github.com/o/r` 之外的一切（`/tree/…`、`/blob/…`、`?tab=…`、
 * 尾斜杠）都落到 `invalid-spec`。而 `inspect()` / `installBundle()` 还把**原始 spec**
 * 交给连接检查与 `pnpm add` ⇒ 只改 `parseInstallSpec()` 内部是不够的（真机实证过）。
 *
 * 【本门禁钉什么】
 *   ① 行为：`tools/pack-core.mjs` 注入的那份 `dshmNormalizeInstallSpec()`，逐用例比对
 *      （GitHub 各种页面形态 → `github:o/r[#ref][&path:/sub]`；**非 GitHub 形态必须一个字节不改**）。
 *   ② 接线：这条补丁在 pack-core 主流程里真的被调用、且计划打**两个站点**（`parseInstallSpec`
 *      头部 + `lib/index.js` 的两个入口）——与 `check-core-openharmony-patches.mjs` 的
 *      ㉕ 静态审计互补（那边判"树里真的注入了"，这边判"注入的东西是对的"）。
 *   ③ 对照臂：两条内存变异（恒等函数 / 关掉页面段解析）**必须**让用例表变红 ——
 *      证明用例表不是恒真的摆设（本仓 check-*-jitless 同款做法）。
 *
 * 离线门禁：只读仓库内文件，不需要核心树、不需要设备。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK_CORE = join(HERE, 'pack-core.mjs');

/*
 * 用例表：[输入, 期望输出, 类别]。
 * 类别 `accept` = 必须归一成 pnpm 认的 `github:` 形态；`asis` = 必须**原样返回**
 * （npm 名 / 作用域包 / file: / link: / 负号开头 / 其它 host / git+ssh 都不要碰）。
 */
const CASES = [
  // ── accept：浏览器地址栏能复制出来的 GitHub 形态 ──
  ['https://github.com/o/r', 'github:o/r', 'accept'],
  ['https://github.com/o/r/', 'github:o/r', 'accept'],
  ['https://github.com/o/r.git', 'github:o/r', 'accept'],
  ['github.com/o/r', 'github:o/r', 'accept'],
  ['https://www.github.com/o/r', 'github:o/r', 'accept'],
  ['o/r', 'github:o/r', 'accept'],
  ['github:o/r', 'github:o/r', 'accept'],
  ['  https://github.com/o/r  ', 'github:o/r', 'accept'],
  ['https://github.com/o/r?tab=readme-ov-file', 'github:o/r', 'accept'],
  ['https://github.com/o/r/issues/12', 'github:o/r', 'accept'],
  ['https://github.com/o/r/releases', 'github:o/r', 'accept'],
  ['https://github.com/o/r/archive/refs/tags/v1.tgz', 'github:o/r', 'accept'],
  ['https://github.com/o/r/tree/main', 'github:o/r#main', 'accept'],
  ['https://github.com/o/r/tree/v1.2.3', 'github:o/r#v1.2.3', 'accept'],
  ['https://github.com/o/r/tree/', 'github:o/r', 'accept'],
  ['https://github.com/o/r/tree/feature%2Fx', 'github:o/r#feature%2Fx', 'accept'],
  ['https://github.com/o/r/tree/main/sub', 'github:o/r#main&path:/sub', 'accept'],
  ['https://github.com/o/r/tree/main/sub/', 'github:o/r#main&path:/sub', 'accept'],
  ['https://github.com/o/r/tree/main?tab=x', 'github:o/r#main', 'accept'],
  ['https://github.com/o/r/tree/main/sub?tab=x', 'github:o/r#main&path:/sub', 'accept'],
  ['https://github.com/o/r/blob/main/x.md', 'github:o/r#main', 'accept'],
  ['https://github.com/o/r/blob/main/a/b/x.md', 'github:o/r#main&path:/a/b', 'accept'],
  ['https://github.com/o/r/blob/main/a/b/x.md?plain=1', 'github:o/r#main&path:/a/b', 'accept'],
  ['https://github.com/o/r/blob/', 'github:o/r', 'accept'],
  ['https://github.com/o/r/releases/tag/v1.2.3', 'github:o/r#v1.2.3', 'accept'],
  ['https://github.com/o/r#main&path:/sub', 'github:o/r#main&path:/sub', 'accept'],
  ['https://github.com/o/r#main&path:/deep/dir', 'github:o/r#main&path:/deep/dir', 'accept'],
  ['https://github.com/o/r?path=/sub', 'github:o/r&path:/sub', 'accept'],
  ['github:o/r#main&path:/sub', 'github:o/r#main&path:/sub', 'accept'],
  // 两种拼法的优先级：显式 `&path:`/`?path=` 胜过页面段里的目录
  ['https://github.com/o/r/tree/main/sub?tab=x&path:/other', 'github:o/r#main&path:/other', 'accept'],

  // ── asis：一律不碰（碰了就伤到现有的 npm / 本地路径 / 其它 host 安装） ──
  ['@scope/name', '@scope/name', 'asis'],
  ['left-pad', 'left-pad', 'asis'],
  ['file:../x', 'file:../x', 'asis'],
  ['-rf', '-rf', 'asis'],
  ['https://gitee.com/o/r', 'https://gitee.com/o/r', 'asis'],
  ['git+https://github.com/o/r.git', 'git+https://github.com/o/r.git', 'asis'],
  ['git@github.com:o/r.git', 'git@github.com:o/r.git', 'asis'],
];

/**
 * 从 `pack-core.mjs` 里取出 `installSpecNormalizeHelper()` 的 `String.raw` 片段。
 * 提取失败返回 `null`（那是门禁自身的结构判据，不许静默）。
 */
function extractHelper(src) {
  const fnAt = src.indexOf('function installSpecNormalizeHelper() {');
  if (fnAt < 0) return null;
  const mark = 'return String.raw`';
  const rawAt = src.indexOf(mark, fnAt);
  if (rawAt < 0) return null;
  const bodyStart = rawAt + mark.length;
  /*
   * 严格收尾：**下一个**反引号必须紧跟 `;`。若片段正文里混进反引号（`String.raw` 模板会被
   * 提前闭合 ⇒ pack-core.mjs 直接语法错），这里会先红，而不是等到打包那一刻才炸。
   * 同理，`$` + `{` 的插值起手也不许出现在正文里。
   */
  const bodyEnd = src.indexOf('`', bodyStart);
  if (bodyEnd < 0 || src.slice(bodyEnd, bodyEnd + 2) !== '`;') return null;
  if (src.slice(bodyStart, bodyEnd).includes('$' + '{')) return null;
  return src.slice(bodyStart, bodyEnd);
}

/** 把 helper 片段求值成真函数（片段零依赖，只用字符串/正则内建）。 */
function compileNormalizer(helper) {
  // eslint-disable-next-line no-new-func
  return new Function(helper + '\nreturn dshmNormalizeInstallSpec;')();
}

function runCases(normalize) {
  const fails = [];
  for (const [input, expected, kind] of CASES) {
    let got;
    try {
      got = normalize(input);
    } catch (error) {
      fails.push(`[${kind}] ${JSON.stringify(input)} 抛异常：${error && error.message}`);
      continue;
    }
    if (got !== expected) {
      fails.push(`[${kind}] ${JSON.stringify(input)} -> ${JSON.stringify(got)}（期望 ${JSON.stringify(expected)}）`);
    }
  }
  return fails;
}

const src = readFileSync(PACK_CORE, 'utf8');
let pass = 0;
let fail = 0;
const notes = [];
const ok = (cond, msg) => {
  if (cond) { pass++; notes.push('  PASS  ' + msg); } else { fail++; notes.push('  FAIL  ' + msg); }
};

const helper = extractHelper(src);
ok(helper !== null, 'pack-core.mjs 里能提取到 installSpecNormalizeHelper() 的 String.raw 片段');
const normalize = helper === null ? null : compileNormalizer(helper);
ok(typeof normalize === 'function', '片段求值出 dshmNormalizeInstallSpec() 函数');

// ── ① 行为用例表 ──
const caseFails = normalize === null ? ['（归一化函数没拿到，跳过）'] : runCases(normalize);
const accepts = CASES.filter((c) => c[2] === 'accept').length;
const asis = CASES.filter((c) => c[2] === 'asis').length;
ok(caseFails.length === 0,
  `行为用例 ${CASES.length} 条（GitHub 形态 ${accepts} / 原样返回 ${asis}）全过`
  + (caseFails.length === 0 ? '' : `：${caseFails.length} 条红 —— ${caseFails.slice(0, 5).join(' · ')}`));

// ── ② 接线：主流程调用 + 两个站点 + 入口调用计划 ──
const callCount = src.split('patchInstallSpecNormalize();').length - 1;
ok(callCount === 1, `patchInstallSpecNormalize() 在 pack-core 主流程里被调用恰好 1 次（实测 ${callCount}）`);
// 注意：pack-core 里的锚点是**源码文本**（`\t` / `\n` 是转义序列字面量）⇒ 判据也要用 String.raw 写
const siteA = src.split(String.raw`function parseInstallSpec(raw) {\n\tconst spec = dshmNormalizeInstallSpec(raw);\n`).length - 1;
const siteB = src.split(String.raw`export function parseInstallSpec(raw) {\n    const spec = dshmNormalizeInstallSpec(raw);\n`).length - 1;
ok(siteA === 1 && siteB === 1,
  `计划替换 parseInstallSpec 头部的站点是 2 个（tab 形态 ${siteA} · 4 空格形态 ${siteB}）`);
const entryCount = src.split('spec = dshmNormalizeInstallSpec(spec);').length - 1;
ok(entryCount === 1, `计划追加的入口归一化调用只声明 1 份模板（实测 ${entryCount}）`);
ok(src.includes("join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-plugin-manager', 'lib')"),
  '目标包目录写死为 @deepseek-ai/dsh-plugin-manager（架构变体会在打包期 die，而不是静默跳过）');
ok(src.includes('installSpecNormalizeHelper()'),
  '归一化源码由 installSpecNormalizeHelper() 单点生成（仓库内只有一份真源）');

console.log('== 正例：pack-core.mjs 当前形态 ==');
for (const n of notes) console.log(n);
console.log(`  小计：${pass} passed / ${fail} failed`);

// ── ③ 对照臂：两条内存变异必须让用例表变红 ──
const ARMS = [
  ['把归一化换成恒等函数', (h) => h.replace('\tif (typeof raw !== "string") return raw;', '\treturn raw;')],
  ['关掉页面段解析（/tree/… 类地址退回无效）',
    (h) => h.replace('if (head === "tree" || head === "blob") {', 'if (false) {')],
];
let armsOk = true;
console.log('\n== 对照臂：每条变异都必须判红 ==');
for (const [label, mutate] of ARMS) {
  const mutated = helper === null ? null : mutate(helper);
  const effective = helper !== null && mutated !== null && mutated !== helper;
  let red = false;
  let detail = '（提取失败，无法构造对照臂）';
  if (effective) {
    const armFails = runCases(compileNormalizer(mutated));
    red = armFails.length > 0;
    detail = `（红 ${armFails.length} 条，例：${armFails[0]}）`;
  } else if (helper !== null) {
    detail = '（替换没生效 —— 对照臂本身失效，需与 pack-core 同步复核）';
  }
  if (!red) armsOk = false;
  console.log(`  ${red ? 'PASS' : 'FAIL'}  ${label}${detail}`);
}

const rc = fail === 0 && armsOk ? 0 : 1;
console.log(`\nRESULT: ${rc === 0 ? 'PASS' : 'FAIL'} —— 正例 ${pass} passed / ${fail} failed，`
  + `对照臂 ${armsOk ? '全部有效' : '有问题'}`);
process.exit(rc);
