#!/usr/bin/env node
/**
 * 门禁：折叠屏适配的接线必须齐全（2026-10-28，用户口径"折叠屏单屏显示时设置 UI 要竖屏"）。
 *
 * ## 存在理由
 *
 * 折叠屏的毛病不是"少写一行样式"，而是**判据没接线**：`isFoldableSingleScreen()` 早在
 * 2026-10-13 就写好了，但**全仓零调用**；桥的 `platformForm()` 对折叠屏一律答 `foldable`，
 * 而只有 `phone` 才会挂 `dshm-phone`（设置面板手机化那套）⇒ 折叠屏**永远**拿不到竖屏设置 UI，
 * 单屏（折叠/外屏）时也一样。同一时刻朝向又走"跟屏旋转"⇒ 单屏下还能横过来，
 * 与"设置 UI 要竖屏"正好相反。两处都**不报错、不崩**，只是"表现不对"，最容易被漏看。
 *
 * ## 判据（全部离线、只读源码）
 *
 *   A. `DeviceFacts.ets`：断点常量 600 / 900 在位，`foldLayoutTierOf()` 三档齐全；
 *   B. `isSingleScreenFoldState()`：判据 = **物理折叠态** ∪ **compact 宽度档**（两条件都要在）；
 *   C. `readFoldSnapshot()`：读了 isFoldable / getFoldStatus / getFoldDisplayMode / 默认显示宽度；
 *   D. `WindowRegistry.ets`：`foldDisplayModeChange` **与** `foldStatusChange` 都订阅、且成对 `off`；
 *   E. 折叠屏朝向：单屏 ⇒ `PORTRAIT`，展开 ⇒ `AUTO_ROTATION_RESTRICTED`，**非折叠屏早退**；
 *   F. `EntryAbility.ets`：`applyFoldableOrientation(windowStage)` 被调用、销毁时 `releaseFoldableOrientation()`；
 *   G. `WebApp.ets`：`platformForm()` 的折叠分支**咨询单屏判据**，且仍保留 `foldable` 档（展开态不被吃掉）。
 *
 * 变异对照臂（`--self-test`，每条都必须判红）：拆掉 compact 分支 / 拆掉桥的判据调用 /
 * 拆掉 EntryAbility 调用 / 拆掉 foldStatusChange 订阅 / 把单屏朝向换成跟屏 /
 * 删掉兼容谓词（phone 模块会编译失败）/ phone 模块朝向不接 / 去掉非折叠早退。
 *
 * 用法：
 *   node tools/check-foldable-adaptation.mjs
 *   node tools/check-foldable-adaptation.mjs --self-test
 *
 * 退出码：0 通过；1 有缺陷；3 自检失败。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FILES = {
  facts: 'platform/src/main/ets/system/DeviceFacts.ets',
  window: 'platform/src/main/ets/window/WindowRegistry.ets',
  index: 'platform/src/main/ets/Index.ets',
  ability: 'entry/src/main/ets/entryability/EntryAbility.ets',
  web: 'entry/src/main/ets/pages/WebApp.ets',
  /* phone 模块是**另一条壳层分支**（只发布移动壳层），但它同样跑在折叠屏上
     （折叠屏的 deviceType 就是 phone）⇒ 朝向必须与 entry 同步；
     它的 `platformSingleScreen` 桥依赖 `isFoldableSingleScreen` ⇒ 那个导出不许删。 */
  phoneAbility: 'phone/src/main/ets/entryability/EntryAbility.ets',
  phoneWeb: 'phone/src/main/ets/pages/WebApp.ets',
};

function loadSources() {
  const out = {};
  for (const [k, rel] of Object.entries(FILES)) {
    out[k] = readFileSync(join(ROOT, rel), 'utf8');
  }
  return out;
}

/** 把注释剥成等长空白（保留行号与字面量位置），避免注释里的说明文字把判据顶红。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/** 纯判据：给定四份源码文本，返回问题清单。 */
export function judge(src) {
  const problems = [];
  const facts = stripComments(src.facts);
  const win = stripComments(src.window);
  const index = stripComments(src.index);
  const ability = stripComments(src.ability);
  const web = stripComments(src.web);
  const phoneAbility = stripComments(src.phoneAbility);
  const phoneWeb = stripComments(src.phoneWeb);

  // A. 断点常量与三档
  if (!/FOLD_BREAKPOINT_COMPACT_VP:\s*number\s*=\s*600/.test(facts)) {
    problems.push('A: DeviceFacts 缺 compact 断点常量（期望 600）');
  }
  if (!/FOLD_BREAKPOINT_MEDIUM_VP:\s*number\s*=\s*900/.test(facts)) {
    problems.push('A: DeviceFacts 缺 medium 断点常量（期望 900）');
  }
  for (const tier of ['compact', 'medium', 'expanded']) {
    if (!facts.includes(`'${tier}'`)) {
      problems.push(`A: foldLayoutTierOf 缺 ${tier} 档`);
    }
  }

  // B. 单屏判据 = **宽度优先**（2026-11-07 修正）
  //    旧口径「物理折叠态 ∪ compact 宽度档」会把三折叠双屏（FoldStatus 仍报 FOLDED）判成单屏
  //    ⇒ phone 壳挂 dshm-compact 走抽屉（有遮罩、点空白不收回）。现在宽视口一律按多屏。
  const single = /export function isSingleScreenFoldState\(([^)]*)\)[^{]*\{([\s\S]*?)\n\}/.exec(facts);
  if (single === null) {
    problems.push('B: 找不到 isSingleScreenFoldState()');
  } else {
    const body = single[2];
    if (!/foldLayoutTierOf\([^)]*\)\s*===\s*'compact'/.test(body)) {
      problems.push("B: isSingleScreenFoldState 没有用 compact 宽度档判据");
    }
    if (/foldStatus\s*===\s*FOLD_STATUS_FOLDED_VALUE\s*\)\s*\{\s*return true/.test(body)) {
      problems.push('B: 又退回「只看 foldStatus 就判单屏」（三折叠双屏会被误判成抽屉）');
    }
  }

  // C. 现场快照四个读数
  for (const [needle, what] of [
    ['display.isFoldable()', 'C: readFoldSnapshot 未读折叠能力'],
    ['display.getFoldStatus()', 'C: readFoldSnapshot 未读 FoldStatus'],
    ['display.getFoldDisplayMode()', 'C: readFoldSnapshot 未读 FoldDisplayMode'],
    ['display.getDefaultDisplaySync()', 'C: readFoldSnapshot 未读默认显示宽度'],
  ]) {
    if (!facts.includes(needle)) {
      problems.push(what);
    }
  }

  /*
   * C2. px → vp 必须用 `densityPixels`（逻辑缩放系数），**不是** `densityDPI`
   * （每英寸物理像素数）。2026-10-29 审核发现旧实现用后者，实测会让 3120px 屏算出
   * ~1134vp（真值 ~960），断点整体偏 +174vp ⇒ 折叠屏单屏可能被误判成展开。
   */
  if (!/densityPixels/.test(facts)) {
    problems.push('C2: readFoldSnapshot 没有使用 densityPixels 做 px→vp 换算');
  }
  if (/width \* 160 \/ dpi/.test(facts) || /densityDPI > 0 \? d\.densityDPI : 160/.test(facts)) {
    problems.push('C2: px→vp 仍用 densityDPI（每英寸像素数不是缩放系数）');
  }

  // D. 事件订阅与解绑成对
  if (!win.includes("display.on('foldDisplayModeChange'")) {
    problems.push('D: 未订阅 foldDisplayModeChange');
  }
  if (!win.includes("display.on('foldStatusChange'")) {
    problems.push('D: 未订阅 foldStatusChange');
  }
  if (!win.includes("display.off('foldDisplayModeChange'") || !win.includes("display.off('foldStatusChange'")) {
    problems.push('D: 折叠事件没有成对 off（多窗口会重复订阅）');
  }

  // E. 朝向分支
  const fold = /export function applyFoldableOrientation\(([\s\S]*?)\n\}/.exec(win);
  if (fold === null) {
    problems.push('E: 找不到 applyFoldableOrientation()');
  } else {
    if (!/if\s*\(!snap\.foldable\)\s*\{\s*return;/.test(fold[1])) {
      problems.push('E: 非折叠屏没有早退（会改动手机/平板/PC 的既有朝向行为）');
    }
  }
  if (!/window\.Orientation\.PORTRAIT/.test(win)) {
    problems.push('E: 单屏折叠没有锁 PORTRAIT');
  }
  if (!/window\.Orientation\.AUTO_ROTATION_RESTRICTED/.test(win)) {
    problems.push('E: 展开态没有沿用跟屏策略（AUTO_ROTATION_RESTRICTED）');
  }
  if (!/FOLD_REAPPLY_DEBOUNCE_MS/.test(win)) {
    problems.push('E: 折叠事件重算没有去抖（逐拍设朝向会与展开动画打架）');
  }

  // F. EntryAbility 接线（2026-10-29 复审：必须只认主窗——非 MAIN 实例会覆盖 foldWin 并对子窗锁朝向）
  const guardedCall = /if \(this\.launchParams\.kind === WindowKind\.MAIN\) \{\s*\n\s*applyFoldableOrientation\(windowStage\);/.test(ability);
  const bareCall = /applyFoldableOrientation\(windowStage\);/.test(ability);
  if (!bareCall) {
    problems.push('F: EntryAbility 没有调用 applyFoldableOrientation(windowStage)');
  } else if (!guardedCall) {
    problems.push('F: applyFoldableOrientation 调用缺 WindowKind.MAIN 守卫（子窗会覆盖 foldWin 并被锁朝向）');
  }
  if (!/releaseFoldableOrientation\(\)/.test(ability)) {
    problems.push('F: onWindowStageDestroy 没有解绑折叠事件');
  }

  // G. 桥的折叠分支
  const bridge = /'platformForm':[^\n]*/.exec(web);
  if (bridge === null) {
    problems.push('G: 找不到 platformForm 桥');
  } else {
    const line = bridge[0];
    if (!line.includes('isFoldableSingleScreenNow()')) {
      problems.push('G: platformForm 的折叠分支没有咨询单屏判据（折叠屏仍拿不到 dshm-phone）');
    }
    if (!/'foldable'/.test(line)) {
      problems.push("G: platformForm 丢掉了 foldable 档（展开态会被误答成 phone）");
    }
  }

  // H. 兼容谓词不许删（phone 模块的 platformSingleScreen 依赖它；删了 phone 模块编译直接失败）
  if (!/export function isFoldableSingleScreen\(\): boolean/.test(facts)) {
    problems.push('H: DeviceFacts 缺 isFoldableSingleScreen()（phone 模块的 platformSingleScreen 依赖它）');
  }
  if (!/isFoldableSingleScreen,/.test(index)) {
    problems.push('H: platform/Index 没有导出 isFoldableSingleScreen');
  }
  if (!/isFoldableSingleScreen\(\)/.test(phoneWeb)) {
    problems.push('H: phone 模块的 platformSingleScreen 桥没有用 isFoldableSingleScreen()');
  }

  // I. phone 模块的朝向必须与 entry 同步（折叠屏 deviceType 就是 phone，它同样跑在折叠屏上）
  if (!/applyFoldableOrientation\(windowStage\)/.test(phoneAbility)) {
    problems.push('I: phone 模块 EntryAbility 没有调用 applyFoldableOrientation(windowStage)');
  }
  if (!/releaseFoldableOrientation\(\)/.test(phoneAbility)) {
    problems.push('I: phone 模块 onWindowStageDestroy 没有解绑折叠事件');
  }

  return problems;
}

const src = loadSources();
const problems = judge(src);
const selfTest = process.argv.includes('--self-test');

if (!selfTest) {
  if (problems.length > 0) {
    console.error(`❌ 折叠屏适配接线有 ${problems.length} 处缺陷：`);
    for (const p of problems) console.error(`   · ${p}`);
    process.exit(1);
  }
  console.log('✅ 通过：折叠判据（宽度优先：≥600vp 判多屏，窄视口才可能单屏）、快照读数、两事件订阅/解绑、'
    + '单屏锁竖屏 + 展开跟屏、EntryAbility 接线、桥的 phone/foldable 分档，全部在位。');
  process.exit(0);
}

/* ── 变异对照臂：每条都必须判红 ─────────────────────────────────────────── */
const arms = [
  {
    name: '拆掉 compact 分支（单屏只看物理折叠态）',
    mutate: (s) => ({ ...s, facts: s.facts.replace(/return foldLayoutTierOf\(widthVp\) === 'compact';/, 'return false;') }),
  },
  {
    name: '桥不再咨询单屏判据',
    mutate: (s) => ({ ...s, web: s.web.replace(/isFoldableSingleScreenNow\(\) \? 'phone' : /, '') }),
  },
  {
    name: 'EntryAbility 不再调用折叠朝向',
    mutate: (s) => ({ ...s, ability: s.ability.replace(/applyFoldableOrientation\(windowStage\)/, '/*removed*/') }),
  },
  {
    name: '拆掉 foldStatusChange 订阅',
    mutate: (s) => ({ ...s, window: s.window.replace(/display\.on\('foldStatusChange'/, 'display.on("__none__"') }),
  },
  {
    name: '单屏朝向被改成跟屏（用户报的毛病复现）',
    mutate: (s) => ({ ...s, window: s.window.replace(/snap\.singleScreen\s*\n?\s*\?\s*window\.Orientation\.PORTRAIT/, 'snap.singleScreen ? window.Orientation.AUTO_ROTATION_RESTRICTED') }),
  },
  {
    name: '删掉兼容谓词（phone 模块会编译失败）',
    mutate: (s) => ({ ...s, facts: s.facts.replace(/export function isFoldableSingleScreen\(\): boolean/, 'function isFoldableSingleScreenGone(): boolean') }),
  },
  {
    name: 'phone 模块朝向不接（折叠屏手机上仍可横过来）',
    mutate: (s) => ({ ...s, phoneAbility: s.phoneAbility.replace(/applyFoldableOrientation\(windowStage\)/, '/*removed*/') }),
  },
  {
    name: 'F：去掉 MAIN 守卫（子窗覆盖 foldWin 并被锁竖屏）',
    mutate: (s) => ({ ...s, ability: s.ability.replace('    if (this.launchParams.kind === WindowKind.MAIN) {\n      applyFoldableOrientation(windowStage);\n    }', '    applyFoldableOrientation(windowStage);') }),
  },
  {
    name: 'C2：px→vp 退回 densityDPI（断点偏大，单屏会被误判成展开）',
    mutate: (s) => ({ ...s, facts: s.facts
      .replace('const scale: number = d.densityPixels > 0 ? d.densityPixels : 1;\n    widthVp = d.width / scale;',
               'const dpi: number = d.densityDPI > 0 ? d.densityDPI : 160;\n    widthVp = d.width * 160 / dpi;') }),
  },
  {
    name: '非折叠屏不再早退（改动既有行为）',
    mutate: (s) => ({ ...s, window: s.window.replace(/if\s*\(!snap\.foldable\)\s*\{\s*return;\s*\}/, 'if (false) { return; }') }),
  },
];

let armsOk = true;
console.log('--self-test：变异体必须逐条判红 --');
console.log(`   基线：${problems.length} 处问题（应为 0）`);
if (problems.length !== 0) {
  armsOk = false;
  console.log('   ❌ 基线自己就红，无法判定臂的灵敏度');
}
for (const arm of arms) {
  const mutated = arm.mutate(src);
  const changed = Object.keys(src).some((k) => mutated[k] !== src[k]);
  const judged = changed ? judge(mutated) : ['（变异未命中源码，臂失效）'];
  const red = changed && judged.length > 0;
  console.log(`  ${red ? '✅' : '❌'} ${arm.name} ⇒ ${red ? `判红（${judged.length} 处）` : '未判红（门禁没牙）'}`);
  if (!red) armsOk = false;
}
console.log(armsOk ? `\n✅ 自检通过：${arms.length} 条变异臂全部判红。` : '\n❌ 自检失败。');
process.exit(armsOk ? 0 : 3);