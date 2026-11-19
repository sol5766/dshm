#!/usr/bin/env node
/**
 * 门禁：自带插件的 `output.render` 必须是**两参函数** `(args, value)`。
 *
 * 【为什么需要它（2026-10-16 真机回归，「用浏览器打开baidu.com」没动起来）】
 *   dsh-tools 的工具框架是这样调渲染器的（`createSuccessResult`，
 *   `@deepseek-ai/dsh-tools/lib/index.js`）：
 *
 *       rendered = tool.output.render(exec.arguments, value);
 *       snapshotProjection(tool.name, 'render', rendered);   // 返回必须无损 JSON
 *
 *   而 `dshm-tool-browser` 初版把渲染器写成**单参** `(value) => …value.detail…` ⇒
 *   实际收到的是 **args** ⇒ `value.detail === undefined` ⇒
 *   `snapshotJsonValue([{type:'text', text: undefined}]) === undefined` ⇒
 *   框架判 **`tool "browser_status" returned invalid output: output.render
 *   returned non-lossless JSON`（INVALID_TOOL_OUTPUT）**。
 *   后果不只是工具报错：模型连"桥在不在"都问不出来，被迫转去翻文件系统找扩展。
 *   （同文件 `browser_tree` / `browser_text` 的内联 render 同一写法、同一隐患。）
 *
 * 【判什么】`hostcore/plugins/<name>/lib/index.js` 里每一处 `render:` 赋值：
 *   · `render: (a, b) => …` / `render: function (a, b) {…}` —— 形参 ≥ 2 个；
 *   · `render: someFn,` —— 找到 `someFn` 在本文件里的声明，形参 ≥ 2 个；
 *   · 认不出的写法（动态表达式等）**一律判红**，让人来复核 —— 门禁不做静默放行。
 *   ⚠️ 只查**个数**：参数含义（args / value）由调用点约定，计数是能静态判定的那一半；
 *   真正跑框架快照的那一半在 `dist/dbg-sessions/`（离线）与真机会话里验。
 *
 * 【对照臂（必修）】脚本自带两组合成夹具：
 *   · 反例：单参内联 render + 单参命名 render ⇒ 必须各报一条；
 *   · 正例：两参内联 + 两参命名 ⇒ 必须零报。
 *   任一不成立即 exit 1 —— 防"门禁恒真当摆设"（本仓 check-*-jitless 同款做法）。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PLUGINS_ROOT = join('hostcore', 'plugins');

/** 从 `(` 开始找配对 `)`；返回形参表文本与收尾下标；找不到时返回 null。 */
function readParens(src, openIndex) {
  if (src[openIndex] !== '(') return null;
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return { inner: src.slice(openIndex + 1, i), end: i };
    } else if (ch === '"' || ch === "'" || ch === '`') {
      // 跳过字符串字面量（形参表里出现字符串只可能是默认值）
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
    }
  }
  return null;
}

/** 数形参个数：按**顶层逗号**切（忽略嵌套括号与字符串），空表 = 0。 */
function countParams(paramText) {
  const text = paramText.trim();
  if (text.length === 0) return 0;
  let depth = 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i++;
        i++;
      }
    } else if (ch === ',' && depth === 0) count++;
  }
  return count;
}

/** 在本文件里找 identifier 的函数声明，回形参个数；找不到回 undefined。 */
function declaredParamCount(src, identifier) {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s+)?function\\s*\\(`, 'g'),
    new RegExp(`(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s+)?\\(`, 'g'),
    new RegExp(`(?:async\\s+)?function\\s+${escaped}\\s*\\(`, 'g'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(src);
    if (match === null) continue;
    const open = src.indexOf('(', match.index + match[0].length - 1);
    const parens = readParens(src, open);
    if (parens !== null) return countParams(parens.inner);
  }
  return undefined;
}

/** 检查一段源码里的全部 `render:` 赋值；返回 [{line, params, detail}]。 */
function inspectRenderAssignments(src) {
  const findings = [];
  const re = /render\s*:/g;
  let match;
  while ((match = re.exec(src)) !== null) {
    const line = src.slice(0, match.index).split('\n').length;
    let i = match.index + match[0].length;
    while (i < src.length && /\s/.test(src[i])) i++;
    let params;
    let detail = '';
    const rest = src.slice(i);
    const inlineArrow = /^(async\s+)?\(/.exec(rest);
    const inlineFn = /^(async\s+)?function\s*\(/.exec(rest);
    if (inlineArrow !== null || inlineFn !== null) {
      const open = src.indexOf('(', i);
      const parens = readParens(src, open);
      params = parens === null ? undefined : countParams(parens.inner);
      detail = parens === null ? '内联 render 的形参表读不到' : '内联 render';
      if (params === undefined) findings.push({ line, params, detail });
      else if (params < 2) findings.push({ line, params, detail });
      continue;
    }
    const identMatch = /^([A-Za-z_$][\w$]*)\s*[,}]/.exec(rest);
    if (identMatch !== null) {
      const ident = identMatch[1];
      const declared = declaredParamCount(src, ident);
      if (declared === undefined) {
        findings.push({ line, params: undefined, detail: `render: ${ident} —— 本文件里找不到其函数声明` });
      } else if (declared < 2) {
        findings.push({ line, params: declared, detail: `render: ${ident}（声明 ${declared} 参）` });
      }
      continue;
    }
    findings.push({ line, params: undefined, detail: `认不出的 render 写法：${rest.slice(0, 60)}` });
  }
  return findings;
}

let failed = false;

// ── 对照臂一：合成反例（单参 × 2）必须各报一条 ──────────────────────────────
const armBad = [
  'const def = {',
  '  output: { render: (value) => [{ type: \'text\', text: value.detail }] },',
  '};',
  'const renderRun = (value) => [];',
  'const def2 = { output: { render: renderRun } };',
].join('\n');
const badFindings = inspectRenderAssignments(armBad);
console.log('== 对照臂一：单参 render 合成反例（期望 2 条报出）==');
console.log(`  报出 ${badFindings.length} 条：${badFindings.map((f) => `L${f.line}(${f.detail})`).join('；')}`);
if (badFindings.length !== 2) {
  console.log('  FAIL  反例没有如期被报出 => 本门禁是恒真摆设，必须修');
  failed = true;
} else {
  console.log('  PASS  反例如期变红 => 判据有牙');
}

// ── 对照臂二：合成正例（两参 × 2）必须零报 ─────────────────────────────────
const armGood = [
  'const def = {',
  '  output: { render: (_args, value) => [{ type: \'text\', text: value.detail }] },',
  '};',
  'function renderRun(args, value) { return []; }',
  'const def2 = { output: { render: renderRun } };',
].join('\n');
const goodFindings = inspectRenderAssignments(armGood);
console.log('\n== 对照臂二：两参 render 合成正例（期望 0 条）==');
console.log(`  报出 ${goodFindings.length} 条`);
if (goodFindings.length !== 0) {
  console.log('  FAIL  正例被误报 => 判据过苛，必须修');
  failed = true;
} else {
  console.log('  PASS  正例零报');
}

// ── 主体：扫 hostcore/plugins/*/lib/index.js ────────────────────────────────
console.log('\n== 主体：自带插件 render 形参数（要求 ≥ 2）==');
const pluginDirs = existsSync(PLUGINS_ROOT)
  ? readdirSync(PLUGINS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  : [];
let scannedFiles = 0;
let totalFindings = 0;
for (const dir of pluginDirs) {
  const file = join(PLUGINS_ROOT, dir, 'lib', 'index.js');
  if (!existsSync(file)) continue;
  scannedFiles++;
  const src = readFileSync(file, 'utf8');
  const findings = inspectRenderAssignments(src);
  if (findings.length === 0) {
    console.log(`  PASS  ${file}`);
  } else {
    totalFindings += findings.length;
    failed = true;
    for (const f of findings) console.log(`  FAIL  ${file}:${f.line} —— ${f.detail}（参数 ${f.params ?? '?'} < 2）`);
  }
}
if (scannedFiles === 0) {
  console.log('  FAIL  没有扫到任何插件入口（hostcore/plugins/*/lib/index.js）—— 目录结构变了？');
  failed = true;
}

console.log('\nRESULT: ' + (failed ? 'FAIL' : 'PASS')
  + ` —— 扫描 ${scannedFiles} 个插件入口，render 违规 ${totalFindings} 处，对照臂 2 组`);
process.exit(failed ? 1 : 0);
