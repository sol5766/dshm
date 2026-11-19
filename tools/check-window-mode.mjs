#!/usr/bin/env node
/**
 * 门禁：平板就是平板（第六次收敛 / 用户裁决 2026-11-07）。
 *
 * 用户口径：「平板在后台依旧显示PC应用…平板就是平板，不要像手机还是像PC了，
 * 他就是平板，左侧边栏给按钮收起展开，默认展开不收起。重新修忽略之前做的改动，
 * 手机和PC不要动」。绕一圈回到第一版 §F 的诉求。前几轮叠加的补丁全部作废。
 *
 * 本门禁守**配置层 / 形态判定层**（CSS 结构由 check-sidebar-shim-css.mjs 守）：
 *   ① 回退到工程基线：entry / phone 的 module.json5 都**不含** supportWindowMode。
 *      上一轮把它声明在 ability 上是全局改动，会动到 2in1/PC 与手机 —— 用户明确
 *      「手机和PC不要动」「忽略之前做的改动」。系统对平板应用的默认窗口能力由
 *      deviceTypes 决定，不需要显式声明 floating（那反而让系统在最近任务里按
 *      桌面/PC 应用登记）。
 *   ② platformForm 桥恒答 'tablet'：平板不因 pcMode（自由窗口）改答 desktop，
 *      即不切 PC 桌面档。真 PC/2in1（!handheld）仍答 desktop，逐字不动。
 *   ③ 平板独立档：form=tablet 挂 dshm-tablet（既不挂 dshm-phone 也不挂 dshm-desktop）。
 *   ④ 官方「DSHM」右侧按钮对平板**可见可点**：§E hideNativeToggle 不含针对
 *      dshm-tablet 的隐藏规则；tagLayout 内联隐藏判据不含平板。它是唯一的
 *      收起/展开入口（收起只缩到官方 56px 轨）。
 *   ⑤ 平板常驻（docs/385 §3.2 / docs/386 B.3）：默认展开，且被官方"切面板 / 切会话 /
 *      跨断点"自动收起后补点展开（800ms 节流）；**尊重用户** —— 意图闩只认真人点击
 *      （isTrusted），用户亲手收起后停手。收起态入口 = **官方 56px 图标轨里的 opener**
 *      （2026-11-11 用户裁决：删掉自绘 ⊞，只留 dsh 官方那一颗）。展开态几何**不写死**，
 *      交还官方 computeColumns（写死 = docs/385 §2 的"弹一下又缩回去"）。
 *   ⑥ 手机（phone→dshm-handheld+dshm-phone）与 PC（desktop→dshm-desktop）分支不动。
 *
 * 【对照臂 --self-test】内存变异必须各自让门禁变红。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const WEB = 'entry/src/main/ets/pages/WebApp.ets';
const MODULES = ['entry/src/main/module.json5', 'phone/src/main/module.json5'];

function run(sources) {
  const notes = [];
  let pass = 0, fail = 0;
  const ok = (cond, msg) => { if (cond) { pass++; notes.push('  PASS  ' + msg); } else { fail++; notes.push('  FAIL  ' + msg); } };
  const web = sources[WEB] ?? '';

  // ① 回退基线：所有交付模块都不声明 supportWindowMode（手机和PC不动）
  for (const mod of MODULES) {
    const text = sources[mod];
    if (text === undefined) { continue; } // 该工作区没有这个模块（1.1.4 基线无 phone）
    ok(!text.includes('supportWindowMode'),
      `${mod.split('/')[0]} 的 module.json5 回到基线（不含 supportWindowMode）`);
  }

  // ② platformForm 桥：恒答 tablet，不切 PC 桌面档
  const formLine = (web.match(/^\s*,'platformForm':[^\n]*/m) ?? [''])[0];
  ok(formLine.length > 0, '能定位到 platformForm 桥');
  ok(!formLine.includes("this.pcMode ? 'desktop'"),
    "platformForm 不含 `this.pcMode ? 'desktop'`（平板不因自由窗口切 PC 桌面档）");
  for (const v of ['phone', 'tablet', 'desktop']) {
    ok(formLine.includes("'" + v + "'"), `platformForm 仍保留 '${v}' 档`);
  }
  ok(formLine.includes("!this.handheld ? 'desktop'"),
    "platformForm 仍保留 `!this.handheld ? 'desktop'`（真 PC/2in1 端逐字不动）");

  // ③ 平板独立档 dshm-tablet
  ok(web.includes("var TABLET_CLASS = 'dshm-tablet';"), '平板独立档 TABLET_CLASS 已声明');
  ok(web.includes("if (form === 'phone' || form === 'tablet') {"),
    'phone / tablet 进手持档；foldable（折叠双屏/三屏）走桌面档');
  ok(/if \(form === 'tablet'\) \{ addClass\(htmlEl, TABLET_CLASS\); \}/.test(web),
    '平板额外挂独立档 dshm-tablet（折叠屏双屏/三屏不挂）');
  ok(!web.includes("form === 'tablet') { addClass(htmlEl, DESKTOP_CLASS)"),
    'tablet 绝不挂 dshm-desktop（不切 PC 桌面档）');

  // ④ 官方侧栏按钮对所有形态可见（2026-11-11 反转：顶栏自绘按钮已删除）
  ok(!web.includes('hideNativeToggle'),
    '已无 hideNativeToggle（官方按钮不再被样式表隐藏）');
  ok(!web.includes('hideForNativeTopBar'),
    '已无 hideForNativeTopBar（不再按形态内联隐藏官方按钮）');
  ok(web.includes("toggle.style.display === 'none'"),
    '只清历史内联藏值（升级残留），不主动隐藏');

  // ⑤ 平板常驻：默认展开 + 补点 + 尊重用户 + 收起仍可见入口
  ok(web.includes('function ensureTabletExpanded()'), '有平板常驻补点 ensureTabletExpanded()');
  ok(/\n      ensureTabletExpanded\(\);/.test(web), 'tick 每拍调用 ensureTabletExpanded（持续常驻）');
  ok(web.includes('ev.isTrusted !== true'), '意图闩只认真人点击（程序化补点不改意图）');
  ok(web.includes('tabletWantsExpanded = false'), '用户亲手收起后停手（不抢用户操作）');
  ok(web.includes('tabletWantsExpanded = true'), '用户展开 / 点官方按钮后恢复常驻');
  ok(!web.includes('function ensureFab') && !web.includes('dshm-sidebar-fab'),
    '自绘浮动 ⊞ 已整体删除（收起态入口 = 官方 opener）');
  ok(web.includes("'html.' + TABLET_CLASS + '[' + STATE_ATTR + '=\"collapsed\"]"),
    '平板收起态有独立 CSS（56px 图标轨）');
  ok(web.includes("'html.' + TABLET_CLASS + '[' + STATE_ATTR + '=\"expanded\"]"),
    '平板展开态写死 280（左栏真常驻，不跟官方 narrow 判定走）');
  ok(web.includes("removeAttribute('data-sidebar-drawer')"),
    '平板每拍摘掉官方抽屉标记（点会话区空白不会再收起）');
  ok(web.includes('[class*="drawerMask"]'), '平板隐藏抽屉遮罩（收起态按钮不被盖住）');

  // ⑥ 手机 / PC 分支不动
  ok(web.includes("var PHONE_CLASS = 'dshm-phone';") && web.includes("if (form === 'phone') { addClass(htmlEl, PHONE_CLASS); }"),
    '手机 dshm-phone 分支原样');
  ok(web.includes("addClass(htmlEl, DESKTOP_CLASS);"), 'PC dshm-desktop 分支原样');

  return { pass, fail, notes };
}

const selfTest = process.argv.includes('--self-test');
/**
 * 变异只作用于 sources 里某个文件，用 { key: transform } 描述。
 */
const MUTATIONS = [
  { name: 'M1 又给 entry 声明了 supportWindowMode（动了 PC/手机）',
    apply: (s) => ({ ...s, 'entry/src/main/module.json5': (s['entry/src/main/module.json5'] ?? '').replace('"launchType": "specified",', '"launchType": "specified",\n        "supportWindowMode": ["fullscreen", "split", "floating"],') }) },
  { name: 'M2 platformForm 改回 pcMode→desktop（平板又变 PC 桌面档）',
    apply: (s) => ({ ...s, [WEB]: s[WEB].replace(/,'platformForm': \(\): string => /, ",'platformForm': (): string => this.pcMode ? 'desktop' : (") }) },
  { name: 'M3 platformForm 丢掉 tablet 档',
    apply: (s) => ({ ...s, [WEB]: s[WEB].replace(" : 'tablet'", " : 'phone'") }) },
  { name: 'M4 平板不挂独立档 dshm-tablet',
    apply: (s) => ({ ...s, [WEB]: s[WEB].replace("if (form === 'tablet') { addClass(htmlEl, TABLET_CLASS); }", '') }) },
  { name: 'M5 平板被改判为 dshm-desktop（PC 化回退）',
    apply: (s) => ({ ...s, [WEB]: s[WEB].replace("if (form === 'tablet') { addClass(htmlEl, TABLET_CLASS); }", "if (form === 'tablet') { addClass(htmlEl, DESKTOP_CLASS); }") }) },
  { name: 'M6 又把官方侧栏按钮藏起来（旧 hideNativeToggle 形态）',
    apply: (s) => ({ ...s, [WEB]: s[WEB].replace(
      "    var css = '#' + BACKDROP_ID",
      "    var hideNativeToggle = 'html.dshm-desktop button{display:none !important}';\n    var css = '#' + BACKDROP_ID") }) },
  { name: 'M7 删掉平板常驻补点调用（左栏又会被官方收起）',
    apply: (s) => ({ ...s, [WEB]: s[WEB].replace('      ensureTabletExpanded();\n', '') }) },
  { name: 'M8b 删掉平板展开 280 几何（又回到不常驻）',
    apply: (s) => ({ ...s, [WEB]: s[WEB].replace(
      "      + 'html.' + TABLET_CLASS + '[' + STATE_ATTR + '=\"expanded\"]:not([' + RIGHT_ATTR + '=\"open\"]) .' + FRAME_CLASS\n      + '{grid-template-columns:280px minmax(0,1fr) 0 !important}'\n", '') }) },
  { name: 'M8c 自绘 ⊞ 又被塞回来（收起态出现两颗按钮）',
    apply: (s) => ({ ...s, [WEB]: s[WEB].replace(
      "  var BACKDROP_ID = 'dshm-sidebar-backdrop';",
      "  var BACKDROP_ID = 'dshm-sidebar-backdrop';\n  var FAB_ID = 'dshm-sidebar-fab';") }) },
  { name: 'M8 删掉平板独立档声明',
    apply: (s) => ({ ...s, [WEB]: s[WEB].replace("  var TABLET_CLASS = 'dshm-tablet';\n", '') }) },
];

let sources = {};
for (const f of [WEB, ...MODULES]) {
  if (existsSync(resolve(f))) { sources[f] = readFileSync(f, 'utf8'); }
}

let rc = 0;
console.log('# 平板就是平板（独立档 / 官方按钮收起展开 / 手机PC不动 / 回退窗口声明）');
if (!selfTest) {
  const r = run(sources);
  for (const n of r.notes) console.log(n);
  console.log(r.fail === 0 ? 'PASS ' + r.pass + ' / 0' : 'FAIL ' + r.fail + '（通过 ' + r.pass + '）');
  rc = r.fail === 0 ? 0 : 1;
} else {
  let bad = 0;
  const base = run(sources);
  console.log('  基线：' + (base.fail === 0 ? 'PASS ' + base.pass : 'FAIL ' + base.fail));
  if (base.fail !== 0) bad++;
  for (const m of MUTATIONS) {
    const mutated = m.apply(sources);
    const same = Object.keys(mutated).every((k) => mutated[k] === sources[k]);
    if (same) { console.log('  ' + m.name + '：变异没生效（锚点漂了）⇒ 视为红'); bad++; continue; }
    const red = run(mutated).fail > 0;
    console.log('  ' + m.name + ' ⇒ ' + (red ? 'RED（对）' : 'GREEN（错：变异必须让门禁变红）'));
    if (!red) bad++;
  }
  console.log(bad === 0 ? 'PASS：基线绿 + ' + MUTATIONS.length + ' 个变异全部变红' : 'FAIL：有 ' + bad + ' 处不对');
  rc = bad === 0 ? 0 : 1;
}
process.exit(rc);
