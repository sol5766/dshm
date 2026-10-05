#!/usr/bin/env node
/**
 * 门禁：自绘顶栏的底色与窗口三键（全屏/最小化/关闭）的配色必须**接线一致**。
 *
 * 【为什么需要它（2026-10-05 真机回归，用户报"右上角三个按钮消失、只剩一个关闭"）】
 *   顶栏底色有**两条通道**会改：
 *     ① 主通道：web 的 THEME_SHIM_JS → `themeBridge` → `applySystemBarTheme(mode)`
 *     ② 兜底通道：DOM 探针（~10s 一轮）→ `applyTopBarTheme(...)` → `applySystemBarTheme(mode)`
 *   而三键配色原先**只挂在②上**（外加 EntryAbility 创建窗口时强制 LIGHT，
 *   那是给当年"恒白底顶栏"配的）。于是深色外观下：主通道把顶栏翻成 #151517，
 *   三键却仍是被强制/兜底之外的深色图标 ⇒ **黑底黑键、三键整体不可见**，
 *   只有「关闭」因 hover 有底色才现形。
 *   ⇒ 修法是把三键配色收进**同一个** `applySystemBarTheme`（顶栏什么底色、三键配什么明暗）。
 *
 * 【这条门禁断言什么】结构断言（不跑真机，因而能在 CI 里跑）：
 *   1. `applySystemBarTheme` 里出现 `applyDecorButtonMode(...)` —— 主通道也必须管三键；
 *   2. `applySystemBarTheme` 里出现 `this.topBarBg =` —— 前提成立（它确实是"改顶栏底色"的那个方法）；
 *   3. `applyDecorButtonMode` 方法本身存在，且**是唯一**调用 `setDecorButtonStyle` 的地方
 *      —— 防止再冒出一条"只改一处、另一处漂移"的分支；
 *   4. `themeBridge` 的回调确实接到 `applySystemBarTheme` —— 主通道没被改道到别处；
 *   5. `applyTopBarTheme` 也走同一个 `applyDecorButtonMode`（不内联自己的 setDecorButtonStyle）。
 *
 * 【对照臂（必修）】把源码在内存里做一次"删掉主通道那次调用"的变异，
 *   断言门禁**必须变红** —— 否则这条门禁就是恒真摆设（本仓的 `check-*-jitless` 同款做法）。
 */
import { readFileSync } from 'node:fs';

const FILE = 'entry/src/main/ets/pages/WebApp.ets';

/** 对给定的源码文本跑全部判据；返回 {pass, fail, notes} */
function inspect(src) {
  const notes = [];
  let pass = 0;
  let fail = 0;
  const ok = (cond, msg) => {
    if (cond) { pass++; notes.push('  PASS  ' + msg); } else { fail++; notes.push('  FAIL  ' + msg); }
  };

  // 切出两个方法体（到下一个同缩进的成员声明为止）
  const body = (name) => {
    const i = src.indexOf(name);
    if (i < 0) return '';
    const j = src.indexOf('\n  private ', i + name.length);
    const k = src.indexOf('\n  /**', i + name.length);
    let end = src.length;
    if (j > 0) end = Math.min(end, j);
    if (k > 0) end = Math.min(end, k);
    return src.slice(i, end);
  };

  const sysbar = body('private applySystemBarTheme(');
  const topbar = body('private applyTopBarTheme(');
  const helper = body('private applyDecorButtonMode(');
  const bridge = body('private themeBridge');

  ok(sysbar.length > 0, '找到 applySystemBarTheme 方法');
  ok(helper.length > 0, '找到 applyDecorButtonMode 方法');
  ok(/this\.topBarBg\s*=/.test(sysbar), 'applySystemBarTheme 确实会改自绘顶栏底色（this.topBarBg = …）');
  ok(/this\.applyDecorButtonMode\(/.test(sysbar), '【核心】applySystemBarTheme（主通道）里调用了 applyDecorButtonMode');

  // setDecorButtonStyle 只允许出现在 helper 里
  const total = (src.match(/setDecorButtonStyle/g) || []).length;
  const inHelper = (helper.match(/setDecorButtonStyle/g) || []).length;
  ok(inHelper === 1, 'applyDecorButtonMode 内部恰好调用一次 setDecorButtonStyle');
  ok(total === inHelper, `setDecorButtonStyle 只出现在 applyDecorButtonMode 内（全仓 ${total} 处 / 方法内 ${inHelper} 处）`);

  ok(/this\.applyDecorButtonMode\(/.test(topbar), '兜底通道 applyTopBarTheme 也复用同一个 applyDecorButtonMode（不内联自己的口径）');
  ok(/applySystemBarTheme\(mode\)/.test(bridge), 'themeBridge 回调接到 applySystemBarTheme（主通道没被改道）');

  // 未就绪时不能把幂等闸门锁死（否则窗口就绪后永不补齐三键配色）
  ok(/this\.systemBarApplied\s*=\s*''/.test(sysbar), '窗口未就绪/失败时会清掉幂等闸门（下次调用能补齐）');

  return { pass, fail, notes };
}

const src = readFileSync(FILE, 'utf8');
console.log('== 顶栏底色 ↔ 三键配色 接线门禁 ==');
console.log('文件: ' + FILE);
const r = inspect(src);
r.notes.forEach((n) => console.log(n));
console.log(`\n正例结果: ${r.pass} passed, ${r.fail} failed`);

// ── 对照臂：把"主通道那次调用"删掉，必须变红 ──
console.log('\n== 对照臂：删掉 applySystemBarTheme 里的 applyDecorButtonMode 调用（应立刻变红）==');
const mutated = src.replace(
  /(\n\s*this\.topBarFg = contentColor;\n)([\s\S]{0,400}?)(\n\s*if \(this\.decorWin === undefined\) \{)/,
  '$1$3',
);
if (mutated === src) {
  console.log('  FAIL  对照臂没能构造出变异体（锚点变了 —— 说明源码结构大改，请复核本门禁）');
  process.exit(1);
}
const rm = inspect(mutated);
console.log(`  变异体: ${rm.pass} passed, ${rm.fail} failed（期望 failed > 0）`);
if (rm.fail === 0) {
  console.log('  FAIL  变异体竟然全绿 ⇒ 本门禁是恒真摆设，必须修');
  process.exit(1);
}
console.log('  PASS  变异体如期变红 ⇒ 门禁有效');

const bad = r.fail > 0;
console.log('\nRESULT: ' + (bad ? 'FAIL' : 'PASS') + ` —— 正例 ${r.pass} passed / ${r.fail} failed，对照臂已证明有效`);
process.exit(bad ? 1 : 0);
