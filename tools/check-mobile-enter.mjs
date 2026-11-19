#!/usr/bin/env node
/**
 * 门禁：移动端软键盘「换行 = 换行」（2026-11-12，两壳同源）。
 *
 * 【为什么要有这条】真机复报：换行键仍然触发发送。旧实现只认 `ev.key === 'Enter'`
 * 且必须命中 `[data-lexical-editor="true"]`；部分输入法只给 keyCode=13（key 为
 * Unidentified），焦点也可能落在 contenteditable 子节点 ⇒ 整段跳过。
 *
 * 【判据】
 *   ① 三种 Enter 形态都认（key / code / keyCode 13）；
 *   ② 会话输入判定允许 contenteditable / textarea 兜底，但仍以 composerSeat 为界；
 *   ③ 组字、修饰键、弹层三条保护仍在（不能被改回"无条件拦截"）；
 *   ④ 保留诊断计数（__DSHM_ENTER_STATS__）。
 *
 * 用法：node tools/check-mobile-enter.mjs [--self-test]
 */
import { readFileSync } from 'node:fs';

const SHELLS = ['entry/src/main/ets/pages/WebApp.ets', 'phone/src/main/ets/pages/WebApp.ets'];

export function judge(text, name) {
  const problems = [];
  const a = text.indexOf('const MOBILE_ENTER_SHIM_JS');
  if (a < 0) return [`${name}: 找不到 MOBILE_ENTER_SHIM_JS`];
  const b = text.indexOf('`;', a);
  const block = text.slice(a, b < 0 ? a + 8000 : b + 2);

  if (!block.includes("ev.keyCode !== 13")) problems.push(`${name}: 未接受 keyCode=13（部分输入法 key 为 Unidentified）`);
  if (!block.includes('isContentEditable === true')) problems.push(`${name}: 未提供 contenteditable 兜底`);
  if (!block.includes("el.tagName === 'TEXTAREA'")) problems.push(`${name}: 未提供 textarea 兜底`);
  if (!block.includes("composerSeat")) problems.push(`${name}: 丢失 composerSeat 边界（会误伤设置/终端输入）`);
  if (!block.includes('isComposing === true')) problems.push(`${name}: 丢失组字保护`);
  if (!block.includes('ev.shiftKey === true')) problems.push(`${name}: 丢失修饰键保护`);
  if (!block.includes('menuOpen(ev.target)')) problems.push(`${name}: 弹层判定没有排除焦点所在层`);
  if (!block.includes('__DSHM_ENTER_STATS__')) problems.push(`${name}: 缺少诊断计数`);
  return problems;
}

const selfTest = process.argv.includes('--self-test');
const texts = SHELLS.map((f) => [f, readFileSync(f, 'utf8')]);
const base = texts.flatMap(([f, t]) => judge(t, f));

if (!selfTest) {
  if (base.length > 0) {
    console.error(`❌ 移动端换行接线不完整（${base.length} 处）：`);
    for (const p of base) console.error(`   · ${p}`);
    process.exit(1);
  }
  console.log('✅ 通过：两壳都接受 keyCode=13，composer 内有 contenteditable/textarea 兜底，组字/修饰键/弹层保护与诊断均在。');
  process.exit(0);
}

console.log('--self-test：变异体必须判红 --');
let failures = 0;
if (base.length !== 0) { failures++; console.error(`基线应为 0 处，实际 ${base.length}`); }
const arms = [
  ['去掉 keyCode 兜底', (t) => t.replace("ev.keyCode !== 13", 'false')],
  ['去掉 contenteditable 兜底', (t) => t.replace('isContentEditable === true', 'false')],
  ['去掉 composerSeat 边界', (t) => t.split('composerSeat').join('body')],
];
for (const [name, mutate] of arms) {
  let changed = false;
  for (const [f, t] of texts) {
    const m = mutate(t);
    if (m === t) continue;
    changed = true;
    const problems = judge(m, f);
    if (problems.length === 0) { failures++; console.error(`  ✗ ${name}：判据没判红`); }
    else console.log(`  ✓ ${name} ⇒ 判红（${problems[0]}）`);
  }
  if (!changed) { failures++; console.error(`  ✗ ${name}：变异未生效（锚点漂了）`); }
}
console.log(failures === 0 ? '✅ 自检通过' : `❌ 自检失败（${failures}）`);
process.exit(failures === 0 ? 0 : 1);
