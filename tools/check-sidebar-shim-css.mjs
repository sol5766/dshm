#!/usr/bin/env node
/**
 * 门禁：侧栏垫片（SIDEBAR_SHIM_JS）注入的样式表**结构**：括号配平、桌面档规则在顶层、
 * 手持档抽屉规则仍在 @media 内，且 §A/§B/§D 的收起 / 抽屉 / 入口按钮规则用
 * :not(.dshm-tablet) 排除平板独立档。平板形态 / 官方按钮 / 配置层的硬约束由
 * check-window-mode.mjs 守（两门禁职责不重叠）。
 *
 * 【2026-11-07 第七次收敛 / 用户裁决】平板就是平板：form=tablet 独立挂 dshm-tablet，
 * 既不套手机也不套 PC。前几轮叠加的「去掉按钮 / 复用 PC / 静态锚点」全部作废。
 * 口径以 docs/385 + docs/386 为准：展开 280 交回官方 computeColumns（不写死，否则
 * "弹一下又缩回去"）；收起保留 56px 图标轨 ⇒ "收起只是缩小、按钮不会看不见"。
 *
 * 【2026-11-11 用户裁决：侧栏只留 dsh 官方那一颗】不自绘任何按钮、也不整体隐藏官方
 * opener：收起态把官方 opener 强制常显；轨内那颗真的点得到时（syncOpener 用
 * elementFromPoint 实测，不扣祖先裁剪的 getBoundingClientRect 不算数）才收掉 leading
 * 座位里重复的那颗 —— 否则会出现用户报的"左上角两个按钮"。
 *
 * 【为什么要数括号（2026-10-10 真机事故）】样式表是拼接字符串，追加规则时若把
 * "追加在收尾大括号之后" 写成 "替换掉它"，括号不配平，浏览器在 EOF 自动补右括号 ⇒
 * 桌面档规则静默落进 @media 里 ⇒ PC 窗口 >1024 时一条都不生效。故本门禁把垫片真跑
 * 一遍、拿注入的 CSS 数括号。
 *
 * 判定：括号配平 / 桌面档 ≥4 条且在顶层 / 手持档抽屉在 @media /
 * 所有手持档收起规则带 :not(.dshm-tablet) / 注入 CSS 不含针对平板的按钮隐藏规则。
 *
 * 【对照臂 --self-test】内存变异必须各自让门禁变红。
 */
import { readFileSync } from 'node:fs';

const FILE = 'entry/src/main/ets/pages/WebApp.ets';
const SHIM = 'SIDEBAR_SHIM_JS';
const INTERP = [
  ['${SIDEBAR_STATE_ATTR}', 'data-dshm-sidebar'],
];
const KNOWN_INTERP = ['${SIDEBAR_STATE_ATTR}'];

function shimRange(src) {
  const head = 'const ' + SHIM + ': string = `';
  const s = src.indexOf(head);
  if (s < 0) { throw new Error('找不到 ' + SHIM); }
  const e = src.indexOf('\n})();`', s);
  if (e < 0) { throw new Error(SHIM + ' 没有顶格收尾 })();`'); }
  return src.slice(s, e + '\n})();`'.length);
}

function shimBody(shim) {
  const open = shim.indexOf('`');
  return shim.slice(open + 1, shim.length - 1);
}

/** 把垫片跑一遍，收集它注入的样式表文本。 */
function collectInjectedCss(body) {
  let injected = '';
  const mkEl = (tag) => ({
    tag, id: '', textContent: '', style: {}, children: [], _attrs: {},
    getAttribute(n) { return this._attrs[n] === undefined ? null : this._attrs[n]; },
    setAttribute(n, v) { this._attrs[n] = v; },
    appendChild(c) { this.children.push(c); },
    addEventListener() {}, click() {},
    matches() { return false; },
    getBoundingClientRect() { return { width: 0, height: 0 }; },
  });
  const doc = {
    documentElement: mkEl('html'),
    head: { appendChild(c) { if (c.tag === 'style') { injected += c.textContent; } } },
    body: { appendChild() {} },
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement: mkEl,
  };
  const win = { getComputedStyle: () => ({ display: 'block', cursor: 'auto' }) };
  globalThis.__DSHM_BRIDGES__ = { platformForm: () => 'desktop' };
  globalThis.__DSHM_GRID__ = {};
  const fn = new Function('document', 'window', 'setTimeout', 'setInterval', 'console', body);
  fn(doc, win, () => 0, () => 0, { info() {}, warn() {}, error() {} });
  return injected;
}

function scanCss(css) {
  let depth = 0;
  let minDepth = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') { depth += 1; }
    else if (ch === '}') { depth -= 1; if (depth < minDepth) { minDepth = depth; } }
  }
  return { depth, minDepth };
}

/**
 * 块注释是否成对。
 * 缺收尾标记时后续代码会被整段当注释（2026-11-08 事故：7 条浮动入口规则被吞），
 * 而最终 CSS 的括号仍可能配平 ⇒ 必须独立判，不能只看括号。
 */
function blockCommentsBalanced(text) {
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return false;
      i = end + 2;
      continue;
    }
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    i += 1;
  }
  return true;
}

function rules(css) {
  const out = [];
  let seg = '';
  let depth = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      const sel = seg.trim();
      if (sel !== '') { out.push({ sel, depth }); }
      seg = '';
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      seg = '';
    } else if (ch === ';' && depth === 0) {
      seg = '';
    } else {
      seg += ch;
    }
  }
  return out;
}

function run(src) {
  const notes = [];
  let pass = 0;
  let fail = 0;
  const ok = (cond, msg) => { if (cond) { pass += 1; notes.push('  PASS  ' + msg); } else { fail += 1; notes.push('  FAIL  ' + msg); } };

  const shim = shimRange(src);
  const body = shimBody(shim);

  ok(!body.includes('`'), '垫片体内无第二个反引号（ArkTS 模板字面量会提前闭合）');
  const interps = body.match(/\$\{[^}]*\}/g) || [];
  const unknown = interps.filter((x) => !KNOWN_INTERP.includes(x));
  ok(unknown.length === 0, '垫片体内没有未登记插值（发现：' + JSON.stringify(unknown) + '）');

  let css = '';
  try {
    let sub = body;
    for (const [from, to] of INTERP) { sub = sub.split(from).join(to); }
    css = collectInjectedCss(sub);
  } catch (err) {
    ok(false, '垫片在桩环境里没跑起来（桩该扩了）：' + err.message);
    return { pass, fail, notes };
  }
  ok(css.length > 0, '垫片真的注入了一张样式表（长度 ' + css.length + '）');

  const s = scanCss(css);
  ok(s.depth === 0, '注入的样式表括号配平（收尾 depth=' + s.depth + '，应为 0）');
  ok(s.minDepth >= 0, '括号深度从不为负（min depth=' + s.minDepth + '）');

  const all = rules(css);
  const desktop = all.filter((r) => r.sel.includes('dshm-desktop'));
  const desktopTop = desktop.filter((r) => r.depth === 0);
  ok(desktop.length === 0,
    '桌面档不再有额外规则（收起 / 展开全交官方按钮自己，实测 ' + desktop.length + ' 条）');
  ok(desktop.length === desktopTop.length,
    '若将来再补桌面规则，必须落在顶层（' + desktopTop.length + '/' + desktop.length + '）');
  const drawer = all.filter((r) => r.sel.includes('dshm-handheld') && r.sel.includes('dshm-sbcol'));
  ok(drawer.length >= 1 && drawer.every((r) => r.depth >= 1),
    '手持档抽屉那条仍在媒体查询里（' + JSON.stringify(drawer) + '）');

  /* ---- 平板独立档：§A/§B/§D 规则用 :not(.dshm-tablet) 排除 ---- */
  ok(css.includes('html.dshm-handheld:not(.dshm-tablet)[data-dshm-sidebar="collapsed"] .dshm-frame'),
    '「收起 ⇒ 整列 0」排除平板独立档（平板左栏常驻、收起只缩小）');
  ok(css.includes('html.dshm-handheld:not(.dshm-tablet)[data-dshm-sidebar="expanded"] .dshm-sbcol'),
    '覆盖式抽屉规则排除平板独立档');
  ok(!css.includes('html.dshm-handheld[data-dshm-sidebar='),
    '没有「不带 :not(.dshm-tablet)」的手持档收起规则（平板左栏不会被压成 0 / 抽屉）');

  /* ---- 平板收起态：56px 图标轨（入口交还官方 opener） ---- */
  /* 选择器与声明都在同一条注入文本里；rules() 只截到 '{' 前，故这里直接按整段文本判。 */
  const rail = /html\.dshm-tablet\[data-dshm-sidebar="collapsed"\][^{]*\{grid-template-columns:56px/.test(css);
  ok(rail, '平板收起态保留 56px 图标轨（收起只是缩小）');
  const tabFab = /html\.dshm-tablet\[data-dshm-sidebar="collapsed"\][^{]*#dshm-sidebar-fab\{display:flex\}/.test(css);
  ok(!tabFab, '平板收起态不再显示自绘 ⊞（轨里只留 dsh 官方 opener）');
  const railExpanded = /html\.dshm-tablet\[data-dshm-sidebar="expanded"\][^{]*\{grid-template-columns:280px/.test(css);
  ok(railExpanded, '平板展开态写死 280（左栏真常驻，不跟官方 narrow 判定走）');
  ok(/html\.dshm-tablet \.dshm-sbcol\{[^}]*position:relative !important/.test(css),
    '平板侧栏列强制 in-flow（不再是悬浮抽屉）');
  ok(css.includes('[class*="drawerMask"]'), '平板隐藏抽屉遮罩（点会话区空白不会把左栏收起）');
  /*
   * 【2026-11-18 竖屏 / 折叠屏展开修正】官方 narrow = viewport < 1024、drawer < 768。
   * 平板竖屏与折叠屏展开都落在 narrow：官方把侧栏列做成 absolute 抽屉、主列吃整幅网格；
   * 我们若无条件写死 280/56，主列就回流进第 1 轨 → 会话区压到左栏上（用户实测）。
   * 所以写死几何必须收在 ≥1024 的媒体查询里，<1024 改走官方抽屉浮层（JS 补 drawer 属性）。
   */
  ok(css.includes('@media (min-width:1024px){html.dshm-tablet[data-dshm-sidebar="expanded"]'),
    '平板写死几何收在 ≥1024 媒体查询里（<1024 交还官方抽屉，主区不被挤）');
  ok(body.includes("frame.setAttribute('data-sidebar-drawer', 'true')"),
    '平板 <1024 主动补官方抽屉标记（narrow 档走浮层，不写死 280）');
  ok(/ensureTabletExpanded[\s\S]{0,400}?innerWidth \|\| 0\) < 1024/.test(body),
    '平板常驻补点只在 ≥1024 生效（竖屏抽屉不每拍盖住主区）');

  /* ---- 收起态入口：只有 dsh 官方那颗 opener（自绘 ⊞ 已按用户裁决整体删除） ---- */
  /* 2026-11-08 真实事故：注释少了收尾标记，被下一段注释的收尾标记提前关闭 ⇒
     手持档规则整段变成注释，而括号仍然配平、旧断言全绿。这里守「注释成对」。 */
  ok(blockCommentsBalanced(body), '垫片体内块注释成对（缺 `*/` 会静默吞掉后续规则）');
  ok(!css.includes('dshm-sidebar-fab') && !body.includes("'dshm-sidebar-fab'"),
    '垫片不再生成任何自绘侧栏按钮（收起态轨里只有 dsh 官方 opener）');
  ok(/html\[data-dshm-sidebar="collapsed"\] button\[data-sidebar-opener\]\{display:inline-flex !important;opacity:1 !important;visibility:visible !important;pointer-events:auto !important\}/.test(css),
    '收起态把官方 opener 强制成常显（含 display:inline-flex，覆盖官方 narrow 的 display:none）');
  ok(/html\[data-dshm-sidebar="collapsed"\]\[data-dshm-panel="open"\] button\[data-sidebar-opener\]\{opacity:0 !important;pointer-events:none !important\}/.test(css),
    '设置面板打开时隐去 opener（避免压住面板标题与返回键）');
  ok(/html\[data-dshm-right="open"\] button\[data-sidebar-opener\]\{opacity:0 !important;pointer-events:none !important\}/.test(css),
    '右侧栏打开时隐去 opener（避免压住右栏标题）');
  ok(!/html\[data-dshm-sidebar="collapsed"\] button\[data-sidebar-opener\]\{[^}]*display:none/.test(css),
    '收起态 opener 不得 display:none（2026-11-21 竖屏修复改为显式 display:inline-flex）');
  /*
   * 【2026-11-11 收起态按钮"一直看得见"】读官方核心 CSS 得知：收起态轨首 toggle 显示
   * 品牌标（railMark），侧栏图标（panelIcon）被 display:none，只在 :hover 时交换。
   * 必须把交换结果固化，否则用户看到"按钮没了、鼠标碰到才出现"。
   */
  ok(/html\[data-dshm-sidebar="collapsed"\] button\[aria-label="打开侧边栏"\] \[class\*="_panelIcon"\],html\[data-dshm-sidebar="collapsed"\] button\[aria-label="Open sidebar"\] \[class\*="_panelIcon"\]\{display:inline !important\}/.test(css),
    '收起态常显侧栏图标 panelIcon（官方默认只在 hover 显示它）');
  ok(/html\[data-dshm-sidebar="collapsed"\] button\[aria-label="打开侧边栏"\] \[class\*="_railMark"\],html\[data-dshm-sidebar="collapsed"\] button\[aria-label="Open sidebar"\] \[class\*="_railMark"\]\{display:none !important\}/.test(css),
    '收起态常隐品牌标 railMark（避免与侧栏图标互换）');
  ok(/html\[data-dshm-rail-opener="1"\] button\[data-sidebar-opener\]\{display:none !important\}/.test(css)
    && /function syncOpener\(\)/.test(body) && body.includes('syncOpener();'),
    '轨内 toggle 可用时收掉 leading 座位里重复的那颗（syncOpener，平板不再出现两颗）');
  const collapseHide = all.filter((r) => r.sel.includes('dshm-tablet')
    && r.sel.includes('收起侧边栏') && r.sel.includes('display:none'));
  ok(collapseHide.length === 0,
    '平板不隐藏官方「收起侧边栏」按钮（它是展开态唯一的收起入口，实测 ' + collapseHide.length + ' 条）');
  /*
   * 【2026-11-11 用户裁决：侧栏只留 dsh 官方那一颗】上一版把轨内 opener 用
   * visibility:hidden 让位给自绘 ⊞，结果收起态同时出现两颗按钮。现在：
   *   · 平板收起态**不得**隐藏 opener（一条都不许有）；
   *   · 自绘按钮整体删除（上面已断言 dshm-sidebar-fab 零出现）。
   */
  const openerHide = (css.match(/html\.dshm-tablet\[data-dshm-sidebar="collapsed"\][^{]*button\[data-sidebar-opener\]\{[^}]*visibility:hidden/g) ?? []).length;
  ok(openerHide === 0,
    '平板收起态不隐藏官方 opener（轨内只留官方那一颗，实测 ' + openerHide + ' 条）');
  /*
   * 2026-11-11 用户裁决反转：官方按钮恢复可见、顶栏自绘按钮删除。
   * 这里从"必须藏掉"改为"一条都不许藏"，两条判据各守一半：
   *   · CSS 里不得出现针对桌面档 button 的 display:none（旧 hideNativeToggle 的产物）；
   *   · JS 里不得再写 toggle.style.display = 'none'（旧 tagLayout 的内联隐藏）。
   */
  const desktopBtnHide = all.filter((r) => r.sel.includes('dshm-desktop')
    && r.sel.includes('button') && r.sel.includes('display:none'));
  ok(desktopBtnHide.length === 0,
    '桌面档不再隐藏官方侧栏按钮（实测 ' + desktopBtnHide.length + ' 条）');
  ok(!body.includes("toggle.style.display = 'none'"),
    '官方按钮不再被内联隐藏（桌面档唯一入口）');

  return { pass, fail, notes };
}

const src = readFileSync(FILE, 'utf8');
const selfTest = process.argv.includes('--self-test');

const MUTATIONS = [
  { name: 'M1 删掉 @media 的收尾大括号',
    apply: (t) => t.replace("      + '}';", '      ;') },
  { name: 'M2 收尾多补一个大括号（深度变负）',
    apply: (t) => t.replace("      + '}';", "      + '}}';") },
  { name: 'M3 桌面档类名改成手持档',
    apply: (t) => t.replace("var DESKTOP_CLASS = 'dshm-desktop';", "var DESKTOP_CLASS = 'dshm-handheld';") },
  { name: 'M4 又把官方按钮内联藏起来',
    apply: (t) => t.replace("      if (toggle.style.display === 'none') {",
      "      try { if (toggle.style.display !== 'none') { toggle.style.display = 'none'; } } catch (e) { /* 忽略 */ }\n      if (toggle.style.display === 'none') {") },
  { name: 'M5 收起几何丢掉一处 :not(.dshm-tablet) 排除',
    apply: (t) => t.replace("':not(.' + TABLET_CLASS + ')['", "'['") },
  { name: 'M6 又藏掉桌面档官方按钮（旧 hideNativeToggle 形态）',
    apply: (t) => t.replace("var css = '#' + BACKDROP_ID",
      "var css = 'html.dshm-desktop .x button[aria-label=\"收起侧边栏\"]{display:none !important}' + '#' + BACKDROP_ID") },
  { name: 'M7 平板独立档值被改成 dshm-desktop（又 PC 化）',
    apply: (t) => t.replace("var TABLET_CLASS = 'dshm-tablet';", "var TABLET_CLASS = 'dshm-desktop';") },
  { name: 'M8 删掉平板独立档声明',
    apply: (t) => t.replace("  var TABLET_CLASS = 'dshm-tablet';\n", '') },
  { name: 'M9 删掉平板 56px 图标轨（收起变 0 宽）',
    apply: (t) => t.replace("      + 'html.' + TABLET_CLASS + '[' + STATE_ATTR + '=\"collapsed\"]:not([' + RIGHT_ATTR + '=\"open\"]) .' + FRAME_CLASS\n      + '{grid-template-columns:56px minmax(0,1fr) 0 !important}'\n", '') },
  { name: 'M10 收起态又冒出第二颗自绘按钮',
    apply: (t) => t.replace("var css = '#' + BACKDROP_ID",
      "var css = '#dshm-sidebar-fab{display:flex}' + '#' + BACKDROP_ID") },
  { name: 'M11 删掉平板展开 280 几何（又回到不常驻）',
    apply: (t) => t.replace("      + 'html.' + TABLET_CLASS + '[' + STATE_ATTR + '=\"expanded\"]:not([' + RIGHT_ATTR + '=\"open\"]) .' + FRAME_CLASS\n      + '{grid-template-columns:280px minmax(0,1fr) 0 !important}'\n", '') },
  { name: 'M12 删掉收起态注释的收尾 */（注释吞掉常显规则）',
    apply: (t) => t.replace("       * 下面第三条把 leading 那颗收掉 —— 全页始终只有一颗官方按钮。\n       */",
      "       * 下面第三条把 leading 那颗收掉 —— 全页始终只有一颗官方按钮。") },
  { name: 'M13 收起态把 opener 推开（opacity:0）',
    apply: (t) => t.replace('button[data-sidebar-opener]{display:inline-flex !important;opacity:1 !important;visibility:visible !important;pointer-events:auto !important}',
      'button[data-sidebar-opener]{display:inline-flex !important;opacity:0 !important;visibility:visible !important;pointer-events:auto !important}') },
  { name: 'M14 删掉收起态常显规则（opener 又变回 hover 才显）',
    apply: (t) => t.replace("      + 'html[' + STATE_ATTR + '=\"collapsed\"] button[data-sidebar-opener]{display:inline-flex !important;opacity:1 !important;visibility:visible !important;pointer-events:auto !important}'\n", '') },
  { name: 'M15 收起态 opener 缺 display:inline-flex（官方 narrow 仍 display:none）',
    apply: (t) => t.replace('button[data-sidebar-opener]{display:inline-flex !important;opacity:1 !important;visibility:visible !important;pointer-events:auto !important}',
      'button[data-sidebar-opener]{opacity:1 !important;visibility:visible !important;pointer-events:auto !important}') },
  { name: 'M16 收起态又只显示品牌标（侧栏图标回到 hover 才出现）',
    apply: (t) => t.replace("      + '{display:inline !important}'", "      + '{display:none !important}'") },
  { name: 'M17 品牌标不再隐藏（与侧栏图标同时出现）',
    apply: (t) => t.replace("      + 'html[' + STATE_ATTR + '=\"collapsed\"] button[aria-label=\"Open sidebar\"] [class*=\"_railMark\"]'\n      + '{display:none !important}'",
      "      + 'html[' + STATE_ATTR + '=\"collapsed\"] button[aria-label=\"Open sidebar\"] [class*=\"_railMark\"]'\n      + '{display:inline-flex !important}'") },
  { name: 'M18 删掉 syncOpener 的调用（平板又出现两颗）',
    apply: (t) => t.replace('      syncState();\n      syncOpener();', '      syncState();') },
  { name: 'M19 平板写死几何又解除 ≥1024 限定（竖屏主列回压左栏）',
    apply: (t) => t.replace("      + '@media (min-width:1024px){'\n", "      + '@media (min-width:640px){'\n") },
  { name: 'M20 平板 <1024 不再补官方抽屉标记（narrow 档又按写死几何走）',
    apply: (t) => t.replace("        } else if (!frame.hasAttribute('data-sidebar-drawer')) {\n          frame.setAttribute('data-sidebar-drawer', 'true');\n", '') },
  { name: 'M21 平板常驻补点又放开到竖屏（抽屉每拍盖主区）',
    apply: (t) => t.replace("    if (Math.round(window.innerWidth || 0) < 1024) { return; }\n", '') },
];

let rc = 0;
console.log('# 侧栏垫片样式表（括号配平 / 桌面档顶层 / 平板独立档 :not 排除 / 官方按钮不隐藏）');
if (!selfTest) {
  const r = run(src);
  for (const n of r.notes) { console.log(n); }
  console.log(r.fail === 0 ? 'PASS ' + r.pass + ' / 0' : 'FAIL ' + r.fail + '（通过 ' + r.pass + '）');
  rc = r.fail === 0 ? 0 : 1;
} else {
  let bad = 0;
  const base = run(src);
  console.log('  基线：' + (base.fail === 0 ? 'PASS ' + base.pass : 'FAIL ' + base.fail));
  if (base.fail !== 0) { bad += 1; }
  for (const m of MUTATIONS) {
    const mutated = m.apply(src);
    if (mutated === src) { console.log('  ' + m.name + '：变异没生效（锚点漂了）⇒ 视为红'); bad += 1; continue; }
    const r = run(mutated);
    const red = r.fail > 0;
    console.log('  ' + m.name + ' ⇒ ' + (red ? 'RED（对）' : 'GREEN（错：变异必须让门禁变红）'));
    if (!red) { bad += 1; }
  }
  console.log(bad === 0 ? 'PASS：基线绿 + ' + MUTATIONS.length + ' 个变异全部变红' : 'FAIL：有 ' + bad + ' 处不对');
  rc = bad === 0 ? 0 : 1;
}
process.exit(rc);
