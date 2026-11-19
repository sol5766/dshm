#!/usr/bin/env node
/**
 * 门禁：Web 外壳玻璃垫片（`GLASS_SKIN_JS`，docs/359 一期）。
 *
 * 【为什么需要它】这段垫片是**拼出来的 CSS + 结构选择器**，两类事故都不会被编译发现：
 *   ① CSS 括号不配平 —— 浏览器在 EOF 处补右括号，规则**静默落进上一个块**（本项目在
 *      `SIDEBAR_SHIM_JS` 上真机踩过一次，症状是"选择器全对、样式全不生效"）；
 *   ② 面少一个 / 开关或探针被删 —— 界面"看起来还行"，但降级与诊断已经断了；
 *   ③ 已被裁决撤掉的面又被打标 —— 用户 2026-11-11 明确要求顶栏与输入框恢复 dsh 默认。
 * 所以这里按**可执行事实**判：常量存在且是单个模板字面量、已登记注入清单、三个面齐全、
 * 顶栏 / 输入框没有被打标、深浅只认页面采样属性（不认系统媒体查询）、
 * 有 CSS.supports 探针与 @supports 降级、开关 API 在、诊断桥在 bridges 与 methodList 两处。
 *
 * 对照臂（`--self-test`）变异必须各自判红：去掉一个面 / CSS 少一个右括号 /
 * 去掉 supports 探针 / 去掉注入登记 / 从 methodList 里删掉诊断方法 /
 * 给顶栏重新打标 / 深浅退回系统媒体查询。
 */
import { readFileSync } from 'node:fs';

const FILE = 'entry/src/main/ets/pages/WebApp.ets';
/* 三个面。topbar / composer 属"已撤"，见 FORBIDDEN。 */
const SURFACES = ['sidebar', 'dialog', 'menu'];
const FORBIDDEN = ['topbar', 'composer'];

function extractBlock(text) {
  const start = text.indexOf('const GLASS_SKIN_JS');
  if (start < 0) return null;
  const open = text.indexOf('`', start);
  if (open < 0) return null;
  let i = open + 1;
  for (; i < text.length; i++) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text[i] === '`') break;
  }
  if (i >= text.length) return null;
  return { block: text.slice(open + 1, i), after: text.slice(i + 1, i + 3) };
}

function cssBalance(block) {
  /* ArkTS 模板字面量里换行要写成 `\\n`（源码两个反斜杠），这里两种写法都认。 */
  const m = /var CSS_TEXT = \[([\s\S]*?)\]\.join\('\\{1,2}n'\)/.exec(block);
  if (!m) return { ok: false, why: '找不到 CSS_TEXT 数组（无法判括号）' };
  let css = '';
  const re = /'((?:[^'\\]|\\.)*)'/g;
  let s;
  while ((s = re.exec(m[1])) !== null) css += s[1] + '\n';
  let depth = 0;
  let min = 0;
  for (const ch of css) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth < min) min = depth;
  }
  if (depth !== 0 || min < 0) return { ok: false, why: `CSS 括号不配平（收尾 depth=${depth}，最小 ${min}）` };
  return { ok: true, rules: css.split('\n').length };
}

export function judge(text) {
  const problems = [];
  const found = extractBlock(text);
  if (found === null) {
    return ['找不到 GLASS_SKIN_JS 模板字面量（或未闭合）'];
  }
  const { block, after } = found;
  if (!/^\s*;/.test(after)) problems.push('GLASS_SKIN_JS 字面量后缺少 `;`');

  for (const name of SURFACES) {
    if (!block.includes(`'${name}'`)) problems.push(`缺少玻璃面：${name}`);
    /* 光有字符串不够：必须真的**打标**（mark(el, '面')），否则命中统计永远是 0。 */
    if (!block.includes(`'${name}')`)) problems.push(`玻璃面 ${name} 没有打标调用（mark(x, '${name}')）`);
  }
  /* 已撤的面不许回来打标：只查 mark(x, 'topbar') 这种真实调用，不查注释。 */
  for (const name of FORBIDDEN) {
    if (block.includes(`'${name}')`)) problems.push(`已撤的面又被重新打标：${name}（用户 2026-11-11 裁决恢复 dsh 默认）`);
  }
  if (!/counts = \{ sidebar: 0, dialog: 0, menu: 0 \}/.test(block)) {
    problems.push('counts 初始化没有对齐三个面（命中统计会漏或多出死计数）');
  }
  if (!block.includes("CSS.supports('backdrop-filter'")) problems.push('缺少 backdrop-filter 特性探针');
  if (!block.includes('@supports not')) problems.push('缺少 @supports 实色降级');
  if (!block.includes('backdrop-filter: none')) problems.push('降级分支没有显式关闭 backdrop-filter');
  if (!block.includes('globalThis.dshmGlass')) problems.push('缺少开关 API（window.dshmGlass）');
  if (!block.includes('setInterval(tick')) problems.push('缺少周期巡检（SPA 路由切换后不重打标记）');
  if (!block.includes('MutationObserver')) problems.push('缺少 DOM 变化后的补打标记');
  /*
   * 深浅只认页面底色采样。反例写进"必须是数组元素"的形式，避免注释里提到
   * @media (prefers-color-scheme: dark) 就误判通过（这条曾真被注释骗过）。
   */
  if (!block.includes(`'html[data-dshm-glass-dark="1"] {'`)) {
    problems.push('缺少按页面采样切换的深色令牌（html[data-dshm-glass-dark="1"]）');
  }
  if (!block.includes("setAttribute('data-dshm-glass-dark'")) {
    problems.push('缺少页面底色采样结果写回 data-dshm-glass-dark');
  }
  if (block.includes(`'@media (prefers-color-scheme: dark) {'`)) {
    problems.push('深浅又退回系统媒体查询（系统深色 + dsh 浅色会把顶栏/输入框套黑）');
  }
  if (!block.includes('dshm-phone')) problems.push('缺少手持档模糊半径降级');
  if (!block.includes('writeGlassDiag')) problems.push('垫片没有把探针写进 diag-glass');
  if (!text.includes("{ script: GLASS_SKIN_JS, scriptRules: ['*'] }")) {
    problems.push('GLASS_SKIN_JS 没有登记进 pickerShimScripts（不会注入）');
  }
  if (!text.includes("'writeGlassDiag': (detail: string): void => this.dirPickerBridge.writeDiagMarkerPublic('diag-glass', detail)")) {
    problems.push('bridges 里没有 writeGlassDiag 实现');
  }
  const methodList = /methodList:\s*\[([^\]]*)\]/.exec(text);
  if (methodList === null || !methodList[1].includes("'writeGlassDiag'")) {
    problems.push("methodList 里没有 'writeGlassDiag'（桥对象有、原生不注册）");
  }
  const bal = cssBalance(block);
  if (!bal.ok) problems.push(bal.why);

  return problems;
}

const selfTest = process.argv.includes('--self-test');
const raw = readFileSync(FILE, 'utf8');
const base = judge(raw);

if (!selfTest) {
  if (base.length > 0) {
    console.error(`❌ 玻璃皮肤接线不完整（${base.length} 处）：`);
    for (const p of base) console.error(`   · ${p}`);
    process.exit(1);
  }
  console.log('✅ 通过：三个玻璃面（侧栏/弹窗/菜单）/ 顶栏与输入框未打标 / 开关 / 特性探针 / 降级 / 诊断桥 / 注入登记齐备，CSS 括号配平。');
  process.exit(0);
}

console.log('--self-test：变异体必须判红 --');
let failures = 0;
if (base.length !== 0) {
  failures += 1;
  console.error(`基线应为 0 处，实际 ${base.length}`);
}
const arms = [
  ['去掉「菜单」面', (t) => t.replace("mark(ms[j], 'menu');", "mark(ms[j], 'menu-x');")],
  ['CSS 少一个右括号', (t) => t.replace("    '}',\n    '@media (prefers-reduced-motion: reduce) {',", "    '@media (prefers-reduced-motion: reduce) {',")],
  ['去掉 supports 探针', (t) => t.replace("CSS.supports('backdrop-filter', 'blur(1px)')", 'false')],
  ['去掉注入登记', (t) => t.replace("    { script: GLASS_SKIN_JS, scriptRules: ['*'] },\n", '')],
  ['methodList 删掉诊断方法', (t) => t.replace("'writeGlassDiag', ", '')],
  ['给顶栏重新打标', (t) => t.replace("var sb = findSidebar(); if (sb) { mark(sb, 'sidebar'); counts.sidebar = 1; }", "var sb = findSidebar(); if (sb) { mark(sb, 'sidebar'); mark(sb, 'topbar'); counts.sidebar = 1; }")],
  ['深浅退回系统媒体查询', (t) => t.replace("'html[data-dshm-glass-dark=\"1\"] {',", "'@media (prefers-color-scheme: dark) {',")],
  ['去掉深色采样写回', (t) => t.replace("document.documentElement.setAttribute('data-dshm-glass-dark', pageIsDark() ? '1' : '0');", '')]
];
for (const [name, mutate] of arms) {
  const mutated = mutate(raw);
  if (mutated === raw) {
    failures += 1;
    console.error(`  ✗ ${name}：变异未生效（锚点漂了，门禁自身要修）`);
    continue;
  }
  const problems = judge(mutated);
  if (problems.length === 0) {
    failures += 1;
    console.error(`  ✗ ${name}：判据没判红`);
  } else {
    console.log(`  ✓ ${name} ⇒ 判红（${problems.length} 处：${problems[0]}）`);
  }
}
console.log(failures === 0 ? '✅ 自检通过' : `❌ 自检失败（${failures}）`);
process.exit(failures === 0 ? 0 : 1);
