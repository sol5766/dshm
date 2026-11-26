#!/usr/bin/env node
/**
 * 门禁：自绘顶栏的底色与窗口三键（全屏/最小化/关闭）的配色必须**接线一致**。
 *
 * 【为什么需要它（2026-10-05 真机回归，用户报"右上角三个按钮消失、只剩一个关闭"）】
 *   顶栏底色有**两条通道**会改：
 *     ① 主通道：web 的 THEME_SHIM_JS → `themeBridge` → `applySystemBarTheme(mode)`
 *     ② 窗口生产路径：`applySystemBarTheme(mode)` → `applyDecorButtonMode(mode)`
 *   而三键配色原先**只挂在②上**（外加 EntryAbility 创建窗口时强制 LIGHT，
 *   那是给当年"恒白底顶栏"配的）。于是深色外观下：主通道把顶栏翻成 #151517，
 *   三键却仍是被强制/兜底之外的深色图标 ⇒ **黑底黑键、三键整体不可见**，
 *   只有「关闭」因 hover 有底色才现形。
 *   ⇒ 修法是把三键配色收进**同一个** `applySystemBarTheme`（顶栏什么底色、三键配什么明暗）。
 *
 * 【这条门禁断言什么】结构断言（不跑真机，因而能在 CI 里跑）：
 *   1. `applySystemBarTheme` 里出现 `applyDecorButtonMode(...)` —— 主通道也必须管三键；
 *   2. `applySystemBarTheme` 里出现 `this.topBarFg =` —— 前提成立（它确实是"改顶栏观感"的那个方法；
 *      2026-11-16 沉浸起顶栏不画底色、topBarBg/topBarBgNow 退役，观感锚点改为前景色 topBarFg）；
 *   3. `applyDecorButtonMode` 方法本身存在，且**是唯一**调用 `setDecorButtonStyle` 的地方
 *      —— 防止再冒出一条"只改一处、另一处漂移"的分支；
 *   4. `themeBridge` 的回调确实接到 `applySystemBarTheme` —— 主通道没被改道到别处；
 *   5. `applySystemBarTheme` 的生产接线保留在幂等闸门前后两个阶段。
 *
 * 【对照臂（必修）】把源码在内存里做一次"删掉主通道那次调用"的变异，
 *   断言门禁**必须变红** —— 否则这条门禁就是恒真摆设（本仓的 `check-*-jitless` 同款做法）。
 *
 * 【2026-10-10 加第二组：三键区的**纵向**让位】MatePad Edge 报「右上角三键与右侧边栏
 *   按钮重叠」⇒ 手持档整块 Web 内容按让位量下移（手持档没有自绘顶栏、窗口标题栏那条
 *   没人画）。判据是**纯函数 decorTopInsetVp 的求值行为**（非手持恒 0 / 手持 + 三键在 ⇒ 让位）
 *   加接线，另有让位常量的上下限与一条前提不变量（TOP_BAR_HEIGHT ↔ setWindowDecorHeight）。
 *
 * 【2026-10-10 第二轮：第一版修法在平板真机上没生效，本组因此扩围】平板实测 `diag-decor-top`
 *   原文 `handheld=true keys=false rect.w=0 rect.h=0 inset=0` ⇒ 让位恒 0。根因不是"探测取不到
 *   值"，而是能力层把 `setWindowDecorVisible(false)` / `setWindowDecorHeight(38)` /
 *   `setDecorButtonStyle(...)` 塞进**同一个 try**，而平板自由窗口上中间那条抛 801
 *   （能力受限设备不支持）⇒ 整串落进 catch ⇒ 发布 false。修法：只有"标题栏已隐藏"决定
 *   `decorHiddenOk`，后两条各自独立捕获（可选步骤）；"三键在不在"另交纯函数
 *   `decorPresentOf(decorHiddenOk, decorHeightVp, statusFloating)` 判定（**状态可读时以
 *   windowStatus==FLOATING 为唯一权威**：真机三张截图证明最大化态右上角没有系统按钮；
 *   状态读不到 801 才退回"装饰高度 > 0"的保守推测），并新增 `windowStatusChange` 上的
 *   动态刷新（**只在手持档挂**，PC 一个字节不动）与 `files/diag-decor-caps` 逐项落盘。
 *
 * 【2026-10-10 第三轮：让位量收窄成常量，本组随之改口径】第二轮那版把让位量写成"系统三键区
 *   高度"（本机 = 我们自己 `setWindowDecorHeight(38)` 的 38vp）；平板真机验收**不再重叠、但
 *   两排按钮之间的空档偏宽**（用户原话"三键和 web 右上角稍微有点宽了"）。算得出来的最小让位
 *   只有 8vp 量级（三键下缘距内容上缘约 26vp，而官方壳那排按钮天然比内容上缘低约 18vp）
 *   ⇒ 改成一个**命名常量 `HANDHELD_DECOR_INSET_VP = 24`**（3 倍余量、比 38 收掉约 37%），并
 *   **整条撤掉** `dshDecorHeightVp` 那条只有诊断用途的 AppStorage 通道（能力层自己仍然读
 *   `getWindowDecorHeight()`：`decorPresentOf` 在窗口状态读不到时要用它兜底）。本组相应：纯函数
 *   改两输入、新增常量上下限（`>= 12` 盖住实测 8vp 重叠 / `< TOP_BAR_HEIGHT` 否则等于退回
 *   "偏宽"那一版）、新增"通道已撤掉"，对照臂 F 改成"把常量压到下限以下必须判红"、
 *   新增对照臂 H（把撤掉的通道塞回来必须判红）。 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'entry/src/main/ets/pages/WebApp.ets');
const PHONE_FILE = join(ROOT, 'phone/src/main/ets/pages/WebApp.ets');
const FILE_PICKER_FILE = join(ROOT, 'platform/src/main/ets/system/FilePicker.ets');
const filePickerSrc = readFileSync(FILE_PICKER_FILE, 'utf8');

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
  const helper = body('private applyDecorButtonMode(');
  const bridge = body('private themeBridge');

  ok(sysbar.length > 0, '找到 applySystemBarTheme 方法');
  ok(helper.length > 0, '找到 applyDecorButtonMode 方法');
  /* 2026-11-16 沉浸：顶栏不再画底色（Color.Transparent），topBarBg/topBarBgNow 退役；
     本条前提随之改锚前景色 —— applySystemBarTheme 仍是"改顶栏观感"的那个方法。 */
  ok(/this\.topBarFg\s*=/.test(sysbar), 'applySystemBarTheme 确实会改自绘顶栏观感（this.topBarFg = …）');
  ok(/this\.applyDecorButtonMode\(/.test(sysbar), '【核心】applySystemBarTheme（主通道）里调用了 applyDecorButtonMode');

  // setDecorButtonStyle 只允许出现在 helper 里
  const total = (src.match(/setDecorButtonStyle/g) || []).length;
  const inHelper = (helper.match(/setDecorButtonStyle/g) || []).length;
  ok(inHelper === 1, 'applyDecorButtonMode 内部恰好调用一次 setDecorButtonStyle');
  ok(total === inHelper, `setDecorButtonStyle 只出现在 applyDecorButtonMode 内（全仓 ${total} 处 / 方法内 ${inHelper} 处）`);

  const decorCalls = sysbar.match(/this\.applyDecorButtonMode\(mode\);/g) || [];
  ok(decorCalls.length === 2, '生产路径在幂等闸门前后各调用一次 applyDecorButtonMode');
  ok(/applySystemBarTheme\(mode\)/.test(bridge), 'themeBridge 回调接到 applySystemBarTheme（主通道没被改道）');

  // 未就绪时不能把幂等闸门锁死（否则窗口就绪后永不补齐三键配色）
  ok(/this\.systemBarApplied\s*=\s*''/.test(sysbar), '窗口未就绪/失败时会清掉幂等闸门（下次调用能补齐）');

  return { pass, fail, notes };
}

function inspectThemeProbe(src, label, report = true) {
  const probeNames = ['PROBE_INTERVAL_MS', 'probeTimerId', 'applyThemeFromProbe',
    'applyTopBarTheme', 'applyWindowChromeFromProbe'];
  const legacyPresent = probeNames.some((name) => new RegExp('\\b' + name + '\\b').test(src));
  if (report) {
    console.log('  ' + (!legacyPresent ? 'PASS' : 'FAIL') + ' ' + label
      + ' 不含旧像素主题探针链');
  }
  return !legacyPresent;
}

function inspectProductionThemePath(src, requireEntryShims) {
  const shimAt = src.indexOf('const THEME_SHIM_JS: string =');
  const schemeAt = src.indexOf('colorScheme', shimAt);
  const bridgeAt = src.indexOf('bridges.onThemeMode(mode)', schemeAt);
  const themeAt = src.indexOf('private themeBridge:', bridgeAt);
  const applyAt = src.indexOf('this.applySystemBarTheme(mode)', themeAt);
  const sysbarAt = src.indexOf('private applySystemBarTheme(', applyAt);
  const decorCall = 'this.applyDecorButtonMode(mode);';
  const firstDecorAt = src.indexOf(decorCall, sysbarAt);
  const gateAt = src.indexOf('if (this.systemBarApplied === mode) {', sysbarAt);
  const secondDecorAt = src.indexOf(decorCall, firstDecorAt + decorCall.length);
  const glassAt = src.indexOf('const GLASS_SKIN_JS: string =');
  const cloudAt = src.indexOf('static readonly CLOUD_MENU_SHIM', glassAt);
  const shimsOk = !requireEntryShims || (glassAt >= 0 && cloudAt > glassAt);
  const ok = shimAt >= 0 && schemeAt > shimAt && bridgeAt > schemeAt
    && themeAt > bridgeAt && applyAt > themeAt && sysbarAt > applyAt
    && firstDecorAt > sysbarAt && gateAt > firstDecorAt && secondDecorAt > gateAt && shimsOk;
  console.log('  ' + (ok ? 'PASS' : 'FAIL')
    + ' 生产色彩方案桥、状态栏/三键同步'
    + (requireEntryShims ? '、GLASS 与 CLOUD_MENU_SHIM 保留' : ''));
  return ok;
}

const src = readFileSync(FILE, 'utf8');
const phoneSrc = readFileSync(PHONE_FILE, 'utf8');
console.log('== 顶栏底色 ↔ 三键配色 接线门禁 ==');
console.log('文件: ' + FILE);
let themeProbeOk = inspectThemeProbe(src, 'entry');
themeProbeOk = inspectThemeProbe(phoneSrc, 'phone') && themeProbeOk;
themeProbeOk = inspectProductionThemePath(src, true) && themeProbeOk;
themeProbeOk = inspectProductionThemePath(phoneSrc, false) && themeProbeOk;
const r = inspect(src);
r.notes.forEach((n) => console.log(n));
console.log(`\n正例结果: ${r.pass} passed, ${r.fail} failed`);

// ── 对照臂：把"主通道那次调用"删掉，必须变红 ──
//   2026-10-10 起 applySystemBarTheme 在幂等闸门**之前**也有一次三键调用（闸门不许挡三键），
//   故这里按**调用点**逐个删，必须同时破坏主题生产路径的两个阶段。
console.log('\n== 对照臂：删掉 applyDecorButtonMode 的调用点（应立刻变红）==');
const mutated = src.replace(/^.*this\.applyDecorButtonMode\(mode\);\n/gm, '');
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

const revivedProbe = src.replace('const THEME_SHIM_JS: string =',
  'const PROBE_INTERVAL_MS: number = 10000;\nconst THEME_SHIM_JS: string =');
const brokenThemePath = src.replace('this.applyDecorButtonMode(mode);', 'this.applyDecorButtonMode(\'light\');');
if (revivedProbe === src || inspectThemeProbe(revivedProbe, 'mutant', false)) {
  console.log('  FAIL  旧像素主题探针复活的负控制未被拒绝');
  themeProbeOk = false;
} else {
  console.log('  PASS  负控制：复活旧采样常量被拒绝');
}
if (brokenThemePath === src || inspectProductionThemePath(brokenThemePath, true)) {
  console.log('  FAIL  主题与三键不同步的负控制未被拒绝');
  themeProbeOk = false;
} else {
  console.log('  PASS  负控制：破坏三键生产同步被拒绝');
}

// ==========================================================================
// 第二组：三键区的**纵向**让位（2026-10-10，MatePad Edge 报「三键与右侧边栏按钮重叠」）
//
//   手持档不渲染自绘顶栏（docs/132 起的口径），窗口标题栏那一条就**没人画**；而
//   EntryAbility 的 setWindowDecorVisible(false) 只隐藏标题栏，不隐藏右上角三键。
//   ⇒ 平板统一调用 setWindowTitleButtonVisible(false,false,false) 隐藏三键；
//   只有隐藏失败（801 等）时才保留整块 Web 内容向下让位的兜底。
//
//   断言：① 纯函数的**求值行为**（不是"字符串出现过"）—— 非手持恒 0；手持 + 三键在 ⇒ 按常量让位；
//         手持 + 三键不在（全屏）⇒ 恒 0；② 让位常量有上下限（>= 12 且 < TOP_BAR_HEIGHT）；
//        ③ 接线：手持档隐藏三键；成功即发布 keys=false；失败才走让位；PC 显式跳过。
//         三键可见性（@StorageProp，键名两侧同名同值；成功/失败各发布一次）+ Web 容器
//         padding + 页面侧诊断读数；④ 前提不变量：TOP_BAR_HEIGHT === EntryAbility.setWindowDecorHeight(N)；
//        ⑤ 旧的高度通道（KEY_DECOR_HEIGHT_VP / dshDecorHeightVp）两侧**都必须已经没有实现引用**。
//   对照臂：A 拆掉「非手持恒 0 / 三键在」的守卫 ⇒ ① 变红；B 拆掉接线 ⇒ ③ 变红；
//           C 拆掉能力层的 false 发布 ⇒ ③ 变红；D 丢掉「自由窗口」真判据 ⇒ 判据变红；
//           E 三个装饰调用并回一个 try ⇒ 结构断言变红；F 常量压到下限以下 ⇒ ② 变红；
//           G 拆掉 @Watch ⇒ ③ 变红；H 把撤掉的高度通道塞回来 ⇒ ⑤ 变红。
// ==========================================================================
const ENTRY_FILE = join(ROOT, 'entry/src/main/ets/entryability/EntryAbility.ets');
const CHROME_FILE = join(ROOT, 'platform/src/main/ets/system/WindowChrome.ets');
const chromeSrc = readFileSync(CHROME_FILE, 'utf8');
const COLOR_FILE = join(ROOT, 'entry/src/main/resources/base/element/color.json');
const colorSrc = readFileSync(COLOR_FILE, 'utf8');
const COLOR_DARK_FILE = join(ROOT, 'entry/src/main/resources/dark/element/color.json');
const colorDarkSrc = readFileSync(COLOR_DARK_FILE, 'utf8');
const publishDecorKeysHelper = /^  private publishDecorKeysVisible\(value: boolean\): void \{[\s\S]*?^  \}/m;

function inspectTopInset(src, entry, chrome = chromeSrc, colorJson = colorSrc, colorDarkJson = colorDarkSrc) {
  const notes = [];
  let pass = 0;
  let fail = 0;
  const ok = (cond, msg) => {
    if (cond) { pass++; notes.push('  PASS  ' + msg); } else { fail++; notes.push('  FAIL  ' + msg); }
  };

  const inset = Number((src.match(/const HANDHELD_DECOR_INSET_VP: number = (\d+);/) || [])[1]);
  const topBarConst = Number((src.match(/const TOP_BAR_HEIGHT: number = (\d+);/) || [])[1]);
  ok(Number.isFinite(inset), '找到让位常量 HANDHELD_DECOR_INSET_VP = ' + inset);
  ok(inset >= 12, '【核心】让位常量 >= 12vp（盖住真机实测的 8vp 重叠，留 4vp 余量）：' + inset);
  ok(Number.isFinite(topBarConst) && inset < topBarConst,
    '【核心】让位常量 < TOP_BAR_HEIGHT(' + topBarConst + ')（否则等于退回"偏宽"那一版）：' + inset);

  const policyMatch = src.match(
    /function shouldShowAppTopBar\(rawType: string, desktopForced: boolean, landscape: boolean\): boolean \{([\s\S]*?)\n\}/);
  ok(policyMatch !== null,
    '找到纯函数 shouldShowAppTopBar(rawType, desktopForced, landscape)（顶栏三端策略）');
  let policy = null;
  if (policyMatch !== null) {
    try {
      policy = new Function('rawType', 'desktopForced', 'landscape', policyMatch[1]);
    } catch (e) {
      policy = null;
    }
  }
  ok(policy !== null, 'shouldShowAppTopBar 的函数体可独立求值');
  if (policy !== null) {
    ok(policy('phone', false, true) === false, '【核心】手机横屏也不显示 APP 顶栏');
    /* 2026-11-06 口径反转：普通平板**不渲染**自绘顶栏（与手机一致的沉浸形态）。
       Edge / ProMax 虽上报 tablet，但 desktopForced=true，仍走 PC 顶栏策略（见下一条）。 */
    ok(policy('tablet', false, true) === false, '【核心】普通平板横屏不显示 APP 顶栏');
    ok(policy('tablet', false, false) === false, '【核心】普通平板竖屏也不显示 APP 顶栏');
    ok(policy('2in1', false, false) === true, 'PC / 2in1 竖窗口仍显示 APP 顶栏');
    ok(policy('2in1', true, true) === true, 'MatePad Edge 强制 desktop 时横屏显示 APP 顶栏');
    ok(policy('2in1', true, false) === false, 'MatePad Edge 强制 desktop 时竖屏不显示 APP 顶栏');
    ok(policy('tablet', true, true) === true, 'MatePad Edge / ProMax 的 tablet 原始型横屏仍走原策略');
    ok(policy('tablet', true, false) === false, 'MatePad Edge / ProMax 的 tablet 原始型竖屏仍不显示顶栏');
  }

  const m = src.match(
    /function decorTopInsetVp\(handheld: boolean, decorPresent: boolean, appTopBarVisible: boolean\): number \{([\s\S]*?)\n\}/);
  ok(m !== null, '找到纯函数 decorTopInsetVp(handheld, decorPresent, appTopBarVisible)（三输入）');
  let fn = null;
  if (m !== null) {
    try {
      fn = new Function('handheld', 'decorPresent', 'appTopBarVisible',
        'HANDHELD_DECOR_INSET_VP', m[1]);
    } catch (e) { fn = null; }
  }
  ok(fn !== null, 'decorTopInsetVp 的函数体可独立求值（无 this、只引用 HANDHELD_DECOR_INSET_VP）');
  if (fn !== null) {
    ok(fn(false, true, true, inset) === 0, '非手持恒 0（PC/2in1 一字不动）');
    ok(fn(false, false, false, inset) === 0, '非手持 + 无装饰 => 0');
    ok(fn(true, true, false, inset) === inset, '手持顶栏未显示且三键在 => 保留 24vp 兜底让位');
    ok(fn(true, true, true, inset) === 0, '【核心】APP 顶栏可见时装饰让位恒 0（禁止双重占位）');
    ok(fn(true, false, false, inset) === 0, '手持 + 全屏（三键不在）=> 不让位');
    ok(fn(true, false, false, 999) === 0, '常量不是判据的替代：三键不在时不管常量为多少都返 0');
  }

  ok(/@State\s+decorRectHeightVp/.test(src), 'decorRectHeightVp 仍是 @State（页面侧读数，进诊断行）');
  ok(/this\.decorRectHeightVp\s*=\s*rect\.height > 0 \? rect\.height : 0/.test(src),
    'applyDecorRect 只把**页面侧读数**写进 decorRectHeightVp（让位量不由它决定）');
  ok(/@StorageProp\(KEY_DECOR_KEYS_VISIBLE\)[\s\S]{0,60}?decorKeysVisible/.test(src),
    'decorKeysVisible 由 @StorageProp 接收（能力层在首帧之后发布也能跟上）');
  ok(/@StorageProp\(KEY_DECOR_KEYS_VISIBLE\) @Watch\('onDecorKeysVisibleChanged'\) decorKeysVisible/.test(src),
    '【核心】decorKeysVisible 挂 @Watch（真机 rect 恒 0/0 ⇒ 不补这一条，diag-decor-top 会永远停在 keys=false）');
  ok(/private onDecorKeysVisibleChanged\(\): void \{[\s\S]{0,900}?diag-decor-top/.test(src),
    'watch 回调把新结论落盘到 diag-decor-top（只写诊断、不碰渲染）');
  ok(/return\s+decorTopInsetVp\(this\.handheld,\s*this\.decorKeysVisible,\s*this\.shouldShowTopBar\(\)\);/.test(src),
    '【核心】渲染期把设备形态、三键状态、APP 顶栏可见性交给纯函数');
  ok(!/decorTopInsetVp\(this\.handheld,\s*this\.decorKeysVisible,\s*this\.decorRectHeightVp/.test(src),
    '【核心】装饰高度不重新参与让位判据');
  ok(/\.padding\(\{\s*top:\s*this\.decorTopInsetNow\(\)\s*\}\)/.test(src),
    '【核心】build() 里 Web 容器按 decorTopInsetNow() 让位');
  ok(/if \(this\.shouldShowTopBar\(\)\) \{\s*this\.TopBar\(\)/.test(src),
    '【核心】顶栏由 shouldShowAppTopBar 统一裁决：PC/Edge 横屏显 / 普通平板不显 / 手机不显');
  ok(/private updateOrientationFromWindow\(win: window\.Window \| undefined\): void \{[\s\S]{0,900}?getWindowProperties\(\)\.windowRect/.test(src),
    '【核心】主窗尺寸也更新横竖屏（Web 未挂载时不会停在首帧方向）');
  ok(/this\.updateOrientationFromWindow\(this\.decorWin\);/.test(src)
    && /this\.updateOrientationFromWindow\(win\);/.test(src),
    '【核心】窗口变化与首次取窗两条链都接线横竖屏更新');
  ok(/return form === FormFactor\.PHONE \|\| form === FormFactor\.TABLET;/.test(filePickerSrc),
    '【核心】tablet 与 phone 仍同归手持档；普通平板顶栏由页面策略单独接管');

  // 键名两侧必须同名同值（各写一份字面量，漂移了不会生效且没症状）
  const k = 'KEY_DECOR_KEYS_VISIBLE';
  const keyPage = (src.match(new RegExp('const ' + k + ": string = '([^']+)'")) || [])[1];
  const keyAbility = (entry.match(new RegExp('const ' + k + ": string = '([^']+)'")) || [])[1];
  ok(keyPage !== undefined && keyPage === keyAbility,
    k + ` 页面与能力层同名同值（页面 ${keyPage} / 能力层 ${keyAbility}）`);
  // 旧的高度通道整条撤掉：两侧都不许再有实现引用（注释里提到键值 dshDecorHeightVp 不算）
  ok(!/KEY_DECOR_HEIGHT_VP/.test(src), '【核心】页面侧不再有 KEY_DECOR_HEIGHT_VP（高度通道已撤）');
  ok(!/KEY_DECOR_HEIGHT_VP/.test(entry)
    && !/AppStorage\.(?:set|setOrCreate)<number>\(['\"]dshDecorHeightVp/.test(entry),
  '【核心】能力层不再发布高度读数（旧高度通道已撤）');

  // ── 判据纯函数 decorPresentOf 的**求值行为**（不是"字符串出现过"）────────────────
  // 真因复现（2026-10-10 第二轮）：平板自由窗口上 `getWindowDecorHeight()` 可能读不到（801），
  // 但三键确实浮着 ⇒ 判据不能只看高度，也不能把"整串调用成功"当必要条件。
  const pm = entry.match(/function shouldRestoreFreeDecor\([\s\S]*?\): boolean \{([\s\S]*?)\n\}/);
  let restorePolicy;
  try {
    restorePolicy = new Function('freeMode', 'status', 'foreground', 'window', pm?.[1] || 'throw Error("missing policy")');
    for (const free of [undefined, false, true]) {
      for (const status of [undefined, 0, 1, 2, 3, 4, 5]) {
        for (const foreground of [false, true]) {
          ok(restorePolicy(free, status, foreground, { WindowStatusType: { FLOATING: 4, MAXIMIZE: 2 } })
            === (free === true && foreground && (status === 4 || status === 2)),
          `free-window policy free=${free} status=${status} foreground=${foreground}`);
        }
      }
    }
  } catch {
    ok(false, '生产 shouldRestoreFreeDecor 必须可独立求值');
  }

  // ── 能力层：标题栏、三键、三键高度必须**各自独立**捕获 ────────────────────────
  // 平板自由窗口上 setWindowDecorHeight 抛 801 是常态；塞在同一个 try 里就会把那串调用整体的
  // 结论带成"失败"（2026-10-10 第一版就是这么被真机打回的）。
  const refresh = entry.match(/private refreshDecorCaps\([\s\S]*?(?=\n  \/\*\*|\n  private )/)?.[0] || '';
  ok(!/setWindowDecorHeight|setWindowDecorVisible\(false\)|hideHandheldTitleButtons/.test(refresh),
    '移动刷新不隐藏装饰、不强设 PC 高度');
  ok(/win\.isInFreeWindowMode\(\)/.test(entry),
    '【核心】原生策略读取真实 free-window 环境，不用 FLOATING 推断环境资格');
  ok(/win\.on\('freeWindowModeChange'/.test(entry)
    && /win\.off\('freeWindowModeChange', this\.onFreeWindowModeChanged\)/.test(entry)
    && /win\.on\('windowStatusDidChange', this\.onDecorStatusChanged\)/.test(entry)
    && /win\.off\('windowStatusDidChange', this\.onDecorStatusChanged\)/.test(entry),
    '【核心】自由窗口环境监听有对称解绑');
  ok(/if \(!isHandheldForm\(\)\) \{\s*return 'desktop-skip';/.test(entry),
    '【核心】PC / 2in1 显式跳过隐藏三键（桌面三键逐字不动）');
  ok(/onFreeWindowModeChanged/.test(entry)
    && /this\.refreshDecorCaps\(win,\s*false\)/.test(entry),
    '【核心】free-window 事件值驱动刷新，避免必须等待旧状态事件');
  ok(/private freeWindowMode: boolean \| undefined = undefined;/.test(entry),
    '能力层保存真实自由窗口环境读数');
  /*
   * 2026-11-19 修复 A：撤销 11-12 的「手持档早分支」。
   * 旧断言钉的正是那个半成品结构（手持只 publish(false)），导致平板整段装饰链被跳过、
   * 探针恒为 decor=skip。现在要求：不再有早分支，且持有 `decorPresentOf` 的真实结论发布。
   */
  ok(!/if \(isHandheldForm\(\)\) \{[^{}]*?this\.publishDecorKeysVisible\(false\);\s*\} else \{/.test(entry),
    '不再有"手持档只发布 false"的早分支（它会跳过整段装饰/三键链）');
  ok(/const decorPresent: boolean = decorPresentOf\(/.test(entry)
    && /this\.publishDecorKeysVisible\(decorPresent\);/.test(entry),
    '手持档启动也按 decorPresentOf 的结论发布三键让位（与 PC 同一条链）');
  ok(!/decorPresentOf\(\s*this\.decorHiddenOk,\s*this\.decorButtonsHidden,\s*this\.decorHeightVp,\s*this\.decorFloating\)/.test(entry),
    '不再以旧刷新参数顺序判定自由窗口环境');
  ok(/private refreshDecorCaps\(win: window\.Window \| undefined/.test(entry),
    'refreshDecorCaps 存在并重算真实环境策略');
  ok(/if \(restore\) \{[\s\S]*?win\.setWindowDecorVisible\(true\)[\s\S]*?win\.setWindowTitleButtonVisible\(true, true, true\)/.test(refresh)
    && /shouldRestoreFreeDecor\(this\.freeWindowMode, this\.freeWindowStatus,/.test(refresh),
    '【核心】系统装饰恢复仅在真实自由窗口环境策略 restore 分支中调用');
  ok(/setWindowDecorVisible\(true\);[\s\S]*?catch[\s\S]*?try \{\s*win\.setWindowTitleButtonVisible/.test(refresh),
    '标题栏与三键恢复独立捕获失败');
  const publishHelper = entry.match(publishDecorKeysHelper)?.[0] || '';
  ok(/\{\s*if \(isHandheldForm\(\) && this\.launchParams\.kind === WindowKind\.MAIN\) \{\s*this\.revokeDecorStyle\(\);\s*\}\s*AppStorage\.setOrCreate<boolean>\(KEY_DECOR_KEYS_VISIBLE, value\);\s*\}$/.test(publishHelper),
    'publishDecorKeysVisible 在手持主窗先 revokeDecorStyle，再向 AppStorage 发布可见性');
  ok(!/AppStorage\.setOrCreate<number>\(['\"]dshDecorHeightVp/.test(entry),
    '【核心】能力层不再往 AppStorage 发布高度读数（旧通道撤掉后不留孤儿发布）');
  ok(/writeDecorCapsDiag\(this\.context\.filesDir/.test(entry),
    '逐项调用结果落盘（files/diag-decor-caps，真机可 `hdc shell cat` 自证）');

  const topBar = (src.match(/const TOP_BAR_HEIGHT: number = (\d+)/) || [])[1];
  const decorH = (entry.match(/^\s*win\.setWindowDecorHeight\((\d+)\);/m) || [])[1];
  ok(topBar !== undefined && decorH !== undefined && topBar === decorH,
    '前提不变量：TOP_BAR_HEIGHT(' + topBar + ') === EntryAbility.setWindowDecorHeight(' + decorH + ')');

  // ── 第三组（2026-10-10）：三键配色的**权威唯一** + 窗口状态变化时**重放** ────────────
  // 背景：用户报平板（鸿蒙 6.1）偶发「按钮反色」；端侧诊断报告（2026-10-10 16:16）里唯一能
  // 归因到本仓的那一半是：三键配色**只在主题变化时设一次**，而真机 `diag-decor-caps` 显示
  // 窗口状态在 FLOATING / 其它之间来回切、同一次变更**同一毫秒触发 3 次**刷新 ⇒ 装饰态一旦
  // 被平台重建/丢弃就再也补不回来（深色外观下顶栏 #151517 + 深色图标 = 黑底黑键 = 用户看到的
  // "反色"）。修法两条：① 能力层不再写死 LIGHT，改从**页面发布的外观**取；② 每次窗口状态
  // 变化都按当前外观重放一遍（幂等、廉价）。
  const btnCount = (entry.match(/\.setDecorButtonStyle\(/g) || []).length;
  ok(btnCount === 1, `【核心】能力层恰好 1 处 setDecorButtonStyle（收进 reassertDecorButtons）：${btnCount}`);
  ok(/private reassertDecorButtons\(win: window\.Window\): string \{[\s\S]{0,400}?const mode: string = this\.appearanceMode\(\);/.test(entry),
    '【核心】reassertDecorButtons 的配色取自 appearanceMode()（不在这里写死明暗）');
  ok(/private reassertDecorButtons\(win: window\.Window\): string \{[\s\S]{0,900}?mode === 'dark'[\s\S]{0,200}?COLOR_MODE_DARK[\s\S]{0,200}?COLOR_MODE_LIGHT/.test(entry),
    '【核心】三键配色按**外观三元**取色（深底浅键 / 浅底深键）');
  ok(!/colorMode:\s*ConfigurationConstant\.ColorMode\.COLOR_MODE_LIGHT\s*\}/.test(entry),
    '【核心】能力层不再出现**裸** colorMode: COLOR_MODE_LIGHT（2026-10-05「黑底黑键」回归的写法）');
  const kMode = 'KEY_APPEARANCE_MODE';
  const modePage = (src.match(new RegExp('const ' + kMode + ": string = '([^']+)'")) || [])[1];
  const modeAbility = (entry.match(new RegExp('const ' + kMode + ": string = '([^']+)'")) || [])[1];
  ok(modePage !== undefined && modePage === modeAbility,
    kMode + ` 页面与能力层同名同值（页面 ${modePage} / 能力层 ${modeAbility}）`);
  ok(/AppStorage\.setOrCreate<string>\(KEY_APPEARANCE_MODE, mode\)/.test(src),
    '【核心】页面在 applySystemBarTheme 里**发布**当前生效外观');
  ok(/AppStorage\.get<string>\(KEY_APPEARANCE_MODE\)/.test(entry) &&
    /private appearanceMode\(\): string \{[\s\S]{0,300}?v === 'dark'/.test(entry),
    '【核心】能力层**读**同一个键取权威，且只有 dark 才当深色（其余一律浅色）');
  const iApply = src.indexOf('this.applyDecorButtonMode(mode);');
  const iGate = src.indexOf('if (this.systemBarApplied === mode) {');
  ok(iApply > 0 && iGate > 0 && iApply < iGate,
    '【核心】applyDecorButtonMode 在幂等闸门**之前**（闸门只挡状态栏/窗口底色，不许挡三键）');
  ok(/if \(isHandheldForm\(\) && \(!this\.decorStyleWritable[\s\S]{0,500}?shouldRestoreFreeDecor\(this\.freeWindowMode, this\.freeWindowStatus, true\)\)\) \{\s*return 'system-owned';/.test(entry),
    '移动配色须经原生许可、真实环境与前台守卫，否则交还系统');
  ok(/if \(this\.systemBarApplied === mode\) \{/.test(src),
    '主题幂等闸门仍保留');
  ok(/function windowStatusName\(st: window\.WindowStatusType\): string \{/.test(entry),
    '刷新行记**状态码 + 短名**（`other` 说不出是哪个状态 —— 正是 2026-10-10 报告查不下去的原因）');

  // ── 第四组（2026-10-16）：状态栏属性的**归属** —— 手持档只有"全屏/最大化"才由我们设 ─────
  // 真机证据：同一台 MatePad Pro 12.2（鸿蒙 6.1）—— QQ 的自由窗口 ⇒ 系统状态栏深色（跟着桌面），
  // 我们的自由窗口 / 切后台 ⇒ 整条被涂成 #FFFFFF（浅色外观）。SDK 原文（@ohos.window.d.ts 的
  // setWindowSystemBarProperties）写明这套属性 "does not take effect … non-full-screen …"，
  // 但真机上它把系统状态栏也涂了 ⇒ 判据收窄成"手持档 且 窗口是全屏/最大化"。
  const sm = chrome.match(/function statusBarOwnedByApp\(handheld: boolean, windowStatus: number \| undefined\): boolean \{([\s\S]*?)\n\}/);
  ok(sm !== null, '找到纯函数 statusBarOwnedByApp(handheld, windowStatus)');
  let sfn = null;
  if (sm !== null) {
    try {
      sfn = new Function('handheld', 'windowStatus', sm[1]);
    } catch (e) { sfn = null; }
  }
  ok(sfn !== null, 'statusBarOwnedByApp 的函数体可独立求值（无 this、无外部引用）');
  if (sfn !== null) {
    ok(sfn(false, 4) === true, '【核心】PC / 2in1 恒由我们设（handheld=false ⇒ 自由窗口也 true，逐字不动）');
    ok(sfn(true, 1) === true, '【核心】手持 + 全屏(1) ⇒ 由我们设（手机路线不变）');
    ok(sfn(true, 2) === true, '【核心】手持 + 最大化(2) ⇒ 由我们设');
    ok(sfn(true, 4) === false, '【核心】手持 + 自由窗口(4) ⇒ 交还系统（用户报的"一条白"就是它）');
    ok(sfn(true, 3) === false, '【核心】手持 + 后台 MINIMIZE(3) ⇒ 交还系统（用户报的第二种形态）');
    ok(sfn(true, 5) === false, '手持 + 分屏(5) ⇒ 交还系统');
    ok(sfn(true, undefined) === true, '状态读不到（801）⇒ 维持老行为（照旧设，不把状态栏弄丢）');
  }
  ok(/statusBarOwnedByApp\(this\.handheld, winStatus\)/.test(src),
    '【核心】页面 applySystemBarTheme 真的用这条纯函数判归属');
  ok(/statusBarOwnedByApp\(handheld, winStatus\)/.test(entry),
    '【核心】能力层 reassertWindowChrome 用**同一条**纯函数（两处口径不许各写一份）');
  ok(/reassertWindowChrome\('background', false\)/.test(entry),
    '【核心】onBackground 那条链显式传 false（真机实测：那刻窗口状态还是 FULL_SCREEN，只看状态判不出"正在离开前台"）');
  ok(/const ownStatusBar: boolean = statusBarOwnedByApp\(handheld, winStatus\) && \(!handheld \|\| foreground\);/.test(entry),
    '【核心】"手持档 + 离开前台 ⇒ 不写系统状态栏"与纯函数判据合成一处（PC/2in1 不受 foreground 影响）');
  ok(/private readWindowStatus\(\): number \| undefined \{/.test(src),
    '页面有 readWindowStatus()（801 时回 undefined ⇒ 走"照旧设"分支）');
  ok(/function readWindowStatusOf\(win: window\.Window\): number \| undefined \{/.test(entry),
    '能力层有 readWindowStatusOf()（同上）');
  ok(/\$\{statusBarOwnedByApp\(isHandheldForm\(\), readWindowStatusOf\(win\)\) \? 'app' : 'system'\}/.test(entry),
    '【核心】diag-decor-caps 落 `sb=app|system`（平板只把这一行发回来就能自证走到哪条分支）');
  ok(/this\.reassertWindowChrome\('decor-status'\);/.test(refresh),
    '【核心】窗口状态变化那条链（refreshDecorCaps）也会重判状态栏归属（自由窗口 ↔ 最大化切换）');

  // ── 第五组（2026-10-16 用户第二次报障）：启动期三处同色 + "交还系统"必须是**显式透明** ──────────
  // ① 启动：状态栏 `#FFFFFF`、启动页 `#F3F7FB`、start_window_background `#FFFFFF` ⇒ 用户看到"状态栏一条白"。
  // ② 多任务：状态栏还是 `#151517`（= 深色外观的色）——"切后台什么都不做"只是不覆盖，前台那笔写入会留着。
  const handoffBg = (chrome.match(/export const SYSTEM_BAR_HANDOFF_BG: string = '([^']+)';/) || [])[1];
  ok(handoffBg === '#00000000',
    '【核心】SYSTEM_BAR_HANDOFF_BG == 全透明（实读 ' + handoffBg + '）—— 交还必须是"显式写透明"，空分支会把前台的色留在系统状态栏上');
  ok(/statusBarColor: SYSTEM_BAR_HANDOFF_BG/.test(src),
    '【核心】页面"交还系统"分支真的写透明底色');
  ok(/statusBarColor: SYSTEM_BAR_HANDOFF_BG/.test(entry),
    '【核心】能力层"交还系统"分支同样写透明底色（两处口径不许各写一份）');
  /*
   * 2026-11-21：启动页不再固定取白，改为**跟随系统深浅色**。
   *   启动视图 → `$r('app.color.start_window_background')`（与 module.json5 的
   *   startWindowBackground 同一份 ⇒ 系统启动窗与页面首帧零色差）；
   *   启动期状态栏/窗口底色 → `windowChromeFor(this.systemAppearance())`；
   *   `systemAppearance()` 在 web 主题上报前读 UIAbility 的 `config.colorMode`。
   */
  ok(/\$r\('app\.color\.start_window_background'\)/.test(src),
    '启动视图用 start_window_background 资源画底色（与系统启动窗同一份）');
  ok(/private systemAppearance\(\): string \{[\s\S]{0,500}?config\.colorMode[\s\S]{0,140}?COLOR_MODE_DARK/.test(src),
    '【核心】启动页按系统 colorMode 定深浅（web 主题上报前也能取到）');
  ok(/const splashChrome = windowChromeFor\(this\.systemAppearance\(\)\);/.test(src),
    '【核心】启动期窗口色与启动页同源（windowChromeFor + 系统色）');
  ok(/const barBg: string = splashUp \? splashChrome\.bg : chrome\.bg;/.test(src),
    '【核心】启动期状态栏 / 窗口底色取启动页色（首帧后再切成外观色）');
  ok(/const lightIcon: boolean = splashUp \? splashChrome\.lightIcon : chrome\.lightIcon;/.test(src),
    '【核心】启动期状态栏图标明暗同步翻转（深色启动页配浅图标）');
  ok(/const contentColor: string = splashUp \? splashChrome\.content : chrome\.content;/.test(src),
    '【核心】启动期状态栏前景色同步翻转');
  ok(/@State @Watch\('onPhaseChanged'\) phase: WebPhase/.test(src),
    '【核心】phase 挂 @Watch（阶段切换要重量一遍，否则幂等闸门会把换色挡掉）');
  // 资源值必须与 windowChromeFor 的深浅色一致（base = light / dark 目录 = dark）
  const chromeDarkBg = (chrome.match(/mode === 'dark'\) \{\s*return \{ bg: '([^']+)'/) || [])[1];
  const chromeLightBg = (chrome.match(/return \{ bg: '([^']+)', content: '#0F1115'/) || [])[1];
  const startWindowLight = (colorJson.match(/"name": "start_window_background",\s*"value": "([^"]+)"/) || [])[1];
  const startWindowDark = (colorDarkJson.match(/"name": "start_window_background",\s*"value": "([^"]+)"/) || [])[1];
  ok(startWindowLight !== undefined && chromeLightBg !== undefined
    && startWindowLight.toUpperCase() === chromeLightBg.toUpperCase(),
    '【核心】start_window_background 浅色（' + startWindowLight + '）= windowChromeFor(light).bg（' + chromeLightBg + '）');
  ok(startWindowDark !== undefined && chromeDarkBg !== undefined
    && startWindowDark.toUpperCase() === chromeDarkBg.toUpperCase(),
    '【核心】start_window_background 深色（' + startWindowDark + '）= windowChromeFor(dark).bg（' + chromeDarkBg + '）—— 深色启动不再白闪');

  return { pass, fail, notes };
}
console.log('\n== 三键区纵向让位（手持档 Web 内容下移）==');
console.log('文件: ' + FILE + ' + ' + ENTRY_FILE);
const entrySrc = readFileSync(ENTRY_FILE, 'utf8');
const t = inspectTopInset(src, entrySrc);
t.notes.forEach((n) => console.log(n));
console.log('\n第二组正例结果: ' + t.pass + ' passed, ' + t.fail + ' failed');

// -- 对照臂 A：拆掉「非手持恒 0 / 三键在」的守卫，行为判据必须变红 --
console.log('\n== 对照臂 A：去掉 decorTopInsetVp 的形态/顶栏守卫（应立刻变红）==');
const mutTop = src.replace('if (!handheld || !decorPresent || appTopBarVisible) {', 'if (false) {');
if (mutTop === src) {
  console.log('  FAIL  对照臂 A 没能构造出变异体（锚点变了 —— 请复核本门禁）');
  process.exit(1);
}
const tm = inspectTopInset(mutTop, entrySrc);
console.log('  变异体: ' + tm.pass + ' passed, ' + tm.fail + ' failed（期望 failed > 0）');
if (tm.fail === 0) {
  console.log('  FAIL  变异体竟然全绿 => 本门禁是恒真摆设，必须修');
  process.exit(1);
}
console.log('  PASS  变异体如期变红 => 行为判据有牙');

// -- 对照臂 B：拆掉接线（Web 容器不再让位），结构判据必须变红 --
console.log('\n== 对照臂 B：删掉 Web 容器的 decorTopInsetNow() 让位（应立刻变红）==');
const mutWire = src.replace('.padding({ top: this.decorTopInsetNow() })', '');
if (mutWire === src) {
  console.log('  FAIL  对照臂 B 没能构造出变异体（锚点变了 —— 请复核本门禁）');
  process.exit(1);
}
const tw = inspectTopInset(mutWire, entrySrc);
console.log('  变异体: ' + tw.pass + ' passed, ' + tw.fail + ' failed（期望 failed > 0）');
if (tw.fail === 0) {
  console.log('  FAIL  变异体竟然全绿 => 接线判据是恒真摆设，必须修');
  process.exit(1);
}
console.log('  PASS  变异体如期变红 => 接线判据有牙');

// -- 对照臂通用骨架：构造一个变异体，断言门禁在它上面**必须变红** --
//   `base` 是变异前的源码：变异没生效 = 锚点漂了 ⇒ 直接判失败（否则门禁会悄悄退化成摆设）。
function arm(name, base, mutated, mutatedIsEntry) {
  console.log('\n== 对照臂 ' + name + '（应立刻变红）==');
  if (mutated === base) {
    console.log('  FAIL  对照臂 ' + name + ' 没能构造出变异体（锚点变了 —— 请复核本门禁）');
    return false;
  }
  const res = mutatedIsEntry ? inspectTopInset(src, mutated) : inspectTopInset(mutated, entrySrc);
  console.log('  变异体: ' + res.pass + ' passed, ' + res.fail + ' failed（期望 failed > 0）');
  const baseline = inspectTopInset(src, entrySrc);
  if (res.fail <= baseline.fail) {
    console.log('  FAIL  变异体竟然全绿 => 对应判据是恒真摆设，必须修');
    return false;
  }
  console.log('  PASS  变异体如期变红 => 判据有牙');
  return true;
}

let armsOk = true;

// -- 对照臂 C：删掉能力层启动路径那次「结论发布」，计数判据必须变红 --
armsOk = arm('C：删掉能力层启动路径的那次结论发布',
  entrySrc,
  entrySrc.replace('this.publishDecorKeysVisible(decorPresent);', ''),
  true) && armsOk;

// -- 对照臂 D：把 decorPresentOf 变异成「只看装饰高度」，丢掉"自由窗口"这条真判据 --
//    （= 2026-10-10 第一版那种"整串调用成功才算"的思路）⇒ 求值判据必须变红
armsOk = arm('D：丢掉真实 free-window 环境判据',
  entrySrc,
  entrySrc.replace('freeMode === true', 'true'),
  true) && armsOk;

// -- 对照臂 E：把三个装饰调用并回同一个 try（= 第一版真机被打回的形态）⇒ 结构判据必须变红 --
const mergeDecorTry = (text) => {
  const visibleAt = text.indexOf('win.setWindowDecorVisible(true);', text.indexOf('private refreshDecorCaps('));
  const buttonsAt = text.indexOf('win.setWindowTitleButtonVisible(true, true, true);', visibleAt);
  if (visibleAt < 0 || buttonsAt <= visibleAt) {
    return text;
  }
  const between = text.slice(visibleAt, buttonsAt);
  const catchAt = between.indexOf('} catch (err) {');
  const catchEnd = catchAt < 0 ? -1 : between.indexOf('try {', catchAt);
  if (catchAt < 0 || catchEnd < 0) {
    return text;
  }
  const from = visibleAt + catchAt;
  const to = visibleAt + catchEnd + 'try {'.length;
  return text.slice(0, from) + text.slice(to);
};
armsOk = arm('E：三个装饰调用并回同一个 try',
  entrySrc,
  mergeDecorTry(entrySrc),
  true) && armsOk;

// -- 对照臂 F：把让位常量压到下限以下（< 12vp，会与系统三键重叠）⇒ 上下限判据必须变红 --
armsOk = arm('F：让位常量压到下限以下（8vp）',
  src,
  src.replace(/const HANDHELD_DECOR_INSET_VP: number = \d+;/, 'const HANDHELD_DECOR_INSET_VP: number = 8;'),
  false) && armsOk;

// -- 对照臂 G：拆掉 decorKeysVisible 的 @Watch（真机 rect 恒 0/0 ⇒ 诊断会永远停在 keys=false）--
armsOk = arm('G：拆掉 decorKeysVisible 的 @Watch（诊断不再补读数）',
  src,
  src.replace("@StorageProp(KEY_DECOR_KEYS_VISIBLE) @Watch('onDecorKeysVisibleChanged') decorKeysVisible",
    '@StorageProp(KEY_DECOR_KEYS_VISIBLE) decorKeysVisible'),
  false) && armsOk;

// -- 对照臂 H：把撤掉的高度通道塞回来 ⇒ 「通道已撤」判据必须变红 --
armsOk = arm('H：把撤掉的高度通道（KEY_DECOR_HEIGHT_VP）塞回来',
  src,
  src.replace('const HANDHELD_DECOR_INSET_VP',
    "const KEY_DECOR_HEIGHT_VP: string = 'dshDecorHeightVp';\nconst HANDHELD_DECOR_INSET_VP"),
  false) && armsOk;

// -- 对照臂 I：把「按发布外观取色」写死成 light（= 2026-10-05 那次回归的写法）⇒ 判据必须变红 --
armsOk = arm('I：reassertDecorButtons 的外观写死（不再读发布值）',
  entrySrc,
  entrySrc.replace("const mode: string = this.appearanceMode();", "const mode: string = 'light';"),
  true) && armsOk;

// -- 对照臂 J：页面侧不再发布当前外观 ⇒ "跨层唯一权威"那条判据必须变红 --
armsOk = arm('J：页面不再发布 KEY_APPEARANCE_MODE',
  src,
  src.replace('AppStorage.setOrCreate<string>(KEY_APPEARANCE_MODE, mode);', ''),
  false) && armsOk;

// -- 对照臂 K：拿掉刷新路径的去重（回到"同毫秒 3 连发各发布一次"）⇒ 去重判据必须变红 --
armsOk = arm('K：拿掉主题幂等闸门',
  src,
  src.replace('if (this.systemBarApplied === mode) {', 'if (false) {'),
  false) && armsOk;

// -- 对照臂 L：状态栏归属判据退回"永远由我们设"（= 2026-10-16 收窄前的行为）⇒ 行为判据必须变红 --
console.log('\n== 对照臂 L：statusBarOwnedByApp 退回恒 true（应立刻变红）==');
const chromeMut = chromeSrc.replace(
  'return windowStatus === 1 /* FULL_SCREEN */ || windowStatus === 2 /* MAXIMIZE */;',
  'return true;');
if (chromeMut === chromeSrc) {
  console.log('  FAIL  对照臂 L 没能构造出变异体（锚点变了 —— 请复核本门禁）');
  process.exit(1);
}
const tl = inspectTopInset(src, entrySrc, chromeMut);
console.log('  变异体: ' + tl.pass + ' passed, ' + tl.fail + ' failed（期望 failed > 0）');
if (tl.fail === 0) {
  console.log('  FAIL  变异体竟然全绿 => 状态栏归属判据是恒真摆设，必须修');
  process.exit(1);
}
console.log('  PASS  变异体如期变红 => 状态栏归属判据有牙');

// -- 对照臂 M：页面不再按窗口状态判归属（接线断）⇒ 接线判据必须变红 --
console.log('\n== 对照臂 M：删掉页面那条 statusBarOwnedByApp 归属判断（应立刻变红）==');
const mutOwn = src.replace('if (!statusBarOwnedByApp(this.handheld, winStatus)) {', 'if (false) {');
if (mutOwn === src) {
  console.log('  FAIL  对照臂 M 没能构造出变异体（锚点变了 —— 请复核本门禁）');
  process.exit(1);
}
const to = inspectTopInset(mutOwn, entrySrc);
console.log('  变异体: ' + to.pass + ' passed, ' + to.fail + ' failed（期望 failed > 0）');
if (to.fail === 0) {
  console.log('  FAIL  变异体竟然全绿 => 接线判据是恒真摆设，必须修');
  process.exit(1);
}
console.log('  PASS  变异体如期变红 => 接线判据有牙');

// -- 对照臂 N：onBackground 不再声明"离开前台"（回到"只看窗口状态"的写法）⇒ 判据必须变红 --
armsOk = arm('N：onBackground 不再传 foreground=false',
  entrySrc,
  entrySrc.replace("this.reassertWindowChrome('background', false);",
    "this.reassertWindowChrome('background');"),
  true) && armsOk;

// -- 对照臂 O：交还底色改成不透明（= 把我们的色留在系统状态栏上）⇒ 判据必须变红 --
console.log('\n== 对照臂 O：SYSTEM_BAR_HANDOFF_BG 改成不透明色（应立刻变红）==');
const chromeOpaque = chromeSrc.replace(
  "export const SYSTEM_BAR_HANDOFF_BG: string = '#00000000';",
  "export const SYSTEM_BAR_HANDOFF_BG: string = '#151517';");
if (chromeOpaque === chromeSrc) {
  console.log('  FAIL  对照臂 O 没能构造出变异体（锚点变了 —— 请复核本门禁）');
  process.exit(1);
}
const tO = inspectTopInset(src, entrySrc, chromeOpaque);
console.log('  变异体: ' + tO.pass + ' passed, ' + tO.fail + ' failed（期望 failed > 0）');
if (tO.fail === 0) {
  console.log('  FAIL  变异体竟然全绿 => "交还 = 透明"这条判据是摆设，必须修');
  process.exit(1);
}
console.log('  PASS  变异体如期变红 => 交还口径有牙');

// -- 对照臂 P：start_window_background 与 SPLASH_BG 不同值（= 用户看到的"状态栏一条白"）⇒ 判据必须变红 --
console.log('\n== 对照臂 P：start_window_background 与启动页色拉掉同值（应立刻变红）==');
const colorMismatch = colorSrc.replace(/"name": "start_window_background",\s*"value": "#FFFFFF"/,
  '"name": "start_window_background",\n      "value": "#F3F7FB"');
if (colorMismatch === colorSrc) {
  console.log('  FAIL  对照臂 P 没能构造出变异体（锚点变了 —— 请复核本门禁）');
  process.exit(1);
}
const tP = inspectTopInset(src, entrySrc, chromeSrc, colorMismatch);
console.log('  变异体: ' + tP.pass + ' passed, ' + tP.fail + ' failed（期望 failed > 0）');
if (tP.fail === 0) {
  console.log('  FAIL  变异体竟然全绿 => "启动期三处同色"这条判据是摆设，必须修');
  process.exit(1);
}
console.log('  PASS  变异体如期变红 => 启动期同色判据有牙');

// -- 对照臂 Q：普通平板退回显示顶栏的旧策略 ⇒ 无顶栏策略判据必须变红 --
console.log('\n== 对照臂 Q：普通平板退回显示顶栏（应立刻变红）==');
const topBarLandscapeOnlyForTablet = src.replace(
  'return desktopForced ? landscape : false;',
  'return desktopForced ? landscape : landscape;');
if (topBarLandscapeOnlyForTablet === src) {
  console.log('  FAIL  对照臂 Q 没能构造出变异体（锚点变了 —— 请复核本门禁）');
  process.exit(1);
}
const tQ = inspectTopInset(topBarLandscapeOnlyForTablet, entrySrc);
console.log('  变异体: ' + tQ.pass + ' passed, ' + tQ.fail + ' failed（期望 failed > 0）');
if (tQ.fail === 0) {
  console.log('  FAIL  变异体竟然全绿 => 平板横竖屏顶栏策略是摆设，必须修');
  process.exit(1);
}
console.log('  PASS  变异体如期变红 => 平板横竖屏策略有牙');

// -- 对照臂 R：窗口变化不再更新横竖屏 ⇒ 启动页/Web 未挂载时顶栏方向判据必须变红 --
armsOk = arm('R：窗口几何不再更新横竖屏',
  src,
  src.replace('this.updateOrientationFromWindow(this.decorWin);', ''),
  false) && armsOk;

armsOk = arm('S: mobile refresh forces PC height', entrySrc,
  entrySrc.replace("let decorResult: string = 'skip';", "win.setWindowDecorHeight(38); let decorResult: string = 'skip';"), true) && armsOk;
armsOk = arm('T: mobile style permission removed', entrySrc,
  entrySrc.replace("return 'system-owned';", 'win.setDecorButtonStyle({ colorMode: 1 });'), true) && armsOk;
armsOk = arm('U: free environment listener not removed', entrySrc,
  entrySrc.replace("win.off('freeWindowModeChange', this.onFreeWindowModeChanged);", ''), true) && armsOk;
armsOk = arm('V: PC height no longer matches top bar', entrySrc,
  entrySrc.replace(/^(\s*)win\.setWindowDecorHeight\(38\);/m, '$1win.setWindowDecorHeight(40);'), true) && armsOk;
armsOk = arm('W: visibility wrapper removed', entrySrc,
  entrySrc.replace(publishDecorKeysHelper, ''), true) && armsOk;
armsOk = arm('X: visibility published before style revocation', entrySrc,
  entrySrc.replace(publishDecorKeysHelper, (helper) => helper.replace(
    /(\s+if \(isHandheldForm\(\) && this\.launchParams\.kind === WindowKind\.MAIN\) \{\s*this\.revokeDecorStyle\(\);\s*\})(\s+AppStorage\.setOrCreate<boolean>\(KEY_DECOR_KEYS_VISIBLE, value\);)/,
    '$2$1')), true) && armsOk;

// 普通平板顶部避让依赖 avoidAreaChange 动态读数；监听必须在页面离开时对称解绑。
const avoidListenerOk = /win\.on\('avoidAreaChange',\s*this\.bottomAvoidCb\)/.test(src)
  && /this\.decorWin\.off\('avoidAreaChange',\s*this\.bottomAvoidCb\)/.test(src);
console.log('\n== 平板顶部避让生命周期 ==');
console.log((avoidListenerOk ? '  PASS' : '  FAIL')
  + '  avoidAreaChange 首次取窗注册、页面销毁对称解绑');

/*
 * 手机沉浸（2026-11-19，用户报「多任务/最近任务界面不沉浸」）。
 * layout-fullscreen 与顶部让位必须**成对**存在：只开全屏不补让位 ⇒ 状态栏压住 Web 内容；
 * 只补让位不开全屏 ⇒ 最近任务卡片顶部仍是一条与页面割裂的色带。
 */
const phoneAbilitySrc = readFileSync(join(ROOT, 'phone/src/main/ets/entryability/EntryAbility.ets'), 'utf8');
const phoneImmersiveOk = phoneAbilitySrc.includes('this.enterHandheldImmersive();')
  && phoneAbilitySrc.includes('setWindowLayoutFullScreen(true)')
  && phoneSrc.includes('@State topInsetVp')
  && phoneSrc.includes('this.decorTopInsetNow() + this.topInsetVp');
console.log('\n== 手机沉浸（最近任务不沉浸回归） ==');
console.log((phoneImmersiveOk ? '  PASS' : '  FAIL')
  + '  layout-fullscreen + topInset 成对接线');

const bad = r.fail > 0 || t.fail > 0 || !armsOk || !avoidListenerOk || !themeProbeOk
  || !phoneImmersiveOk;
console.log('\nRESULT: ' + (bad ? 'FAIL' : 'PASS')
  + ' —— 第一组 ' + r.pass + '/' + r.fail + '、第二组 ' + t.pass + '/' + t.fail
  + '，对照臂 A–X ' + (armsOk ? '有效' : '失败'));
process.exitCode = bad ? 1 : 0;
