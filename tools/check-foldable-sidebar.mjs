#!/usr/bin/env node
/**
 * 门禁：折叠屏形态分派必须遵循用户口径（2026-11-12 裁决，回退 407）。
 *
 * 【口径】
 *   · 折叠单屏（form=phone）→ 跟直板机一样（手机抽屉档）；
 *   · 折叠屏双屏/三屏（form=foldable 且原生桥报告非单屏）→ 跟 PC 打开一样，
 *     归入桌面档 dshm-desktop，收起左侧栏由**官方原生窄轨**处理；
 *   · 平板（form=tablet）保持独立档 dshm-tablet，不因折叠屏改动；
 *   · 判据只用原生桥 form / platformSingleScreen / platformPcMode，**不看视口宽度**。
 *
 * 【为什么回退 407】407 把折叠屏宽态塞进平板独立档，套的是我们自绘的
 * `grid-template-columns:56px` + railMark 交换那套 CSS，用户判定「不伦不类」。
 * 而桌面档本来就是官方原生的 56px 图标轨（见 WebApp.ets 头注：
 * 「官方默认只收到 56px 图标轨（那是桌面口径）」）。用户选 B：
 * 仍要窄轨，但必须跟 PC 一致 —— 即走桌面档、不再挂 dshm-tablet。
 *
 * 【判据】
 *   entry：foldable 不进手持档分支；tablet 仍挂 dshm-tablet；单屏展开能摘 dshm-phone；
 *   phone：desktop 判据含 (foldable && !compact)；TABLET_CLASS 只认 tablet；
 *   两壳：无 tabletLikeForm / foldWide、无 innerWidth>=600 视口兜底。
 *
 * 用法：node tools/check-foldable-sidebar.mjs [--self-test]
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const ENTRY = 'entry/src/main/ets/pages/WebApp.ets';
const PHONE = 'phone/src/main/ets/pages/WebApp.ets';

const VIEWPORT_ANCHOR = /Math\.round\(window\.innerWidth \|\| 0\)\s*>=\s*600/;

export function judgeEntry(text) {
  text = sidebarTemplate(text);
  const p = [];
  if (text.includes('tabletLikeForm')) p.push('entry: 仍有 tabletLikeForm（407 视口兜底未清干净）');
  if (VIEWPORT_ANCHOR.test(text)) p.push('entry: 形态判定又看了视口宽度（判据应只认原生桥）');
  if (!text.includes("if (form === 'phone' || form === 'tablet') {")) {
    p.push('entry: 手持档分支不是 phone/tablet 两支（foldable 又被塞回来了）');
  }
  if (text.includes("if (form === 'phone' || form === 'tablet' || form === 'foldable') {")) {
    p.push('entry: foldable 仍进手持档（双屏/三屏没有走桌面档）');
  }
  if (!/if \(form === 'tablet'\) \{ addClass\(htmlEl, TABLET_CLASS\); \}/.test(text)) {
    p.push('entry: 平板没有挂独立档 dshm-tablet');
  }
  if (!text.includes('else { removeClass(htmlEl, PHONE_CLASS); }')) {
    p.push('entry: 单屏展开成双屏后没有摘掉 dshm-phone（会残留手机档样式）');
  }
  return p;
}

export function judgePhone(text) {
  text = sidebarTemplate(text);
  const p = [];
  if (text.includes('foldWide')) p.push('phone: 仍有 foldWide（407 视口兜底未清干净）');
  if (VIEWPORT_ANCHOR.test(text)) p.push('phone: 形态判定又看了视口宽度（判据应只认原生桥）');
  if (!text.includes("var desktop = form === 'desktop' || pcm || (foldable && !compact);")) {
    p.push('phone: desktop 判据没有把折叠屏双屏/三屏归入桌面档');
  }
  if (!text.includes("setFlag(htmlEl, TABLET_CLASS, !desktop && !phone && form === 'tablet');")) {
    p.push('phone: TABLET_CLASS 不是只认平板（又接了折叠屏宽态）');
  }
  try { runPhone(text); } catch (error) {
    if (error.code === 'ENOENT' && String(error.path).includes('dist/core/work/')) { throw error; }
    p.push('phone cooked behavior/CSS: ' + error.message);
  }
  return p;
}

function runPhone(text) {
  const head = 'const SIDEBAR_SHIM_JS: string = ';
  const start = text.indexOf(head);
  const end = text.indexOf('\n})();`', start);
  assert(start >= 0 && end > start, 'sidebar template range');
  const cooked = vm.runInNewContext(text.slice(start + head.length, end + '\n})();`'.length), {
    SIDEBAR_STATE_ATTR: 'data-dshm-sidebar'
  });
  const element = (tag, attrs = {}) => ({
    tagName: tag, attrs, style: { display: '' }, children: [], parentElement: null,
    getAttribute(name) { return this.attrs[name] ?? null; },
    hasAttribute(name) { return this.attrs[name] !== undefined; },
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    appendChild(child) { child.parentElement = this; this.children.push(child); },
    addEventListener() {}, contains(child) { return child === this; },
    getBoundingClientRect() { return { left: 8, top: 8, width: 32, height: 32 }; },
    getClientRects() { return [this.getBoundingClientRect()]; }
  });
  const html = element('HTML');
  const frame = element('DIV', { 'data-sidebar-collapsed': '' });
  const overlay = element('DIV');
  const column = element('DIV');
  const rail = element('BUTTON', { 'aria-label': 'Open sidebar' });
  const opener = element('BUTTON', { 'data-sidebar-opener': '', 'aria-label': 'Open sidebar' });
  const right = element('DIV', { 'data-sidebar-right-open': '' });
  frame.appendChild(overlay);
  frame.appendChild(column);
  column.appendChild(rail);
  let form = 'foldable';
  let single = true;
  let pc = false;
  let width = 390;
  let railHit = false;
  let rightOpen = false;
  let clicks = 0;
  let tick;
  let createdButtons = 0;
  const nodes = [];
  const click = () => {
    clicks++;
    if (frame.hasAttribute('data-sidebar-collapsed')) frame.removeAttribute('data-sidebar-collapsed');
    else frame.setAttribute('data-sidebar-collapsed', '');
    rail.setAttribute('aria-label', frame.hasAttribute('data-sidebar-collapsed') ? 'Open sidebar' : 'Collapse sidebar');
  };
  rail.click = click;
  opener.click = click;
  const doc = {
    documentElement: html, visibilityState: 'visible',
    head: { appendChild(node) { nodes.push(node); } },
    body: { appendChild(node) { nodes.push(node); } },
    addEventListener() {},
    createElement(tag) {
      if (tag.toLowerCase() === 'button') createdButtons++;
      return element(tag);
    },
    getElementById(id) { return nodes.find(node => node.id === id) ?? null; },
    elementFromPoint() { return railHit ? rail : null; },
    querySelector(selector) {
      if (selector === '[data-shell-overlay]') return overlay;
      if (selector === '[data-sidebar-collapsed]') return frame.hasAttribute('data-sidebar-collapsed') ? frame : null;
      if (selector === '[data-sidebar-drawer]') return frame.hasAttribute('data-sidebar-drawer') ? frame : null;
      if (selector === 'button[data-sidebar-opener]') return opener;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'button') return frame.hasAttribute('data-sidebar-drawer') ? [opener] : [opener, rail];
      if (selector === '[data-sidebar-right-open]') return rightOpen ? [right] : [];
      return [];
    }
  };
  const win = {
    get innerWidth() { return width; }, innerHeight: 1000,
    getComputedStyle() { return { display: 'block', visibility: 'visible', opacity: '1', cursor: 'auto' }; }
  };
  const context = {
    document: doc, window: win, console: { info() {} },
    __DSHM_BRIDGES__: { platformForm: () => form, platformSingleScreen: () => single, platformPcMode: () => pc },
    setInterval(fn) { tick = fn; return 1; }, clearInterval() {}, setTimeout() { return 1; }
  };
  vm.runInNewContext(cooked, context);
  const style = nodes.find(node => node.id === 'dshm-sidebar-style');
  assert(style, 'production CSS not injected; check SIDEBAR_SHIM_JS declarations/runtime');
  const css = style.textContent;
  assert(css.length > 0, 'production CSS injected');
  assert.equal(createdButtons, 0, 'no custom opener created');
  const matches = (selector, node) => {
    let valid = true;
    selector = selector.replace(/:not\(([^()]*)\)/g, (_all, inner) => {
      if (matches(inner, node)) valid = false;
      return '';
    });
    for (const token of selector.matchAll(/\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g)) {
      if (token[1] && !(node.getAttribute('class') ?? '').split(/\s+/).includes(token[1])) valid = false;
      if (token[2] && (token[3] === undefined ? !node.hasAttribute(token[2]) : node.getAttribute(token[2]) !== token[3])) valid = false;
    }
    return valid;
  };
  const declarations = target => {
    const result = {};
    const scan = (body, active = true) => {
      let offset = 0;
      while (offset < body.length) {
        const open = body.indexOf('{', offset);
        if (open < 0) break;
        let depth = 1;
        let close = open + 1;
        while (close < body.length && depth > 0) {
          if (body[close] === '{') depth++;
          if (body[close] === '}') depth--;
          close++;
        }
        assert.equal(depth, 0, 'CSS balanced');
        const selector = body.slice(offset, open);
        const content = body.slice(open + 1, close - 1);
        if (selector.startsWith('@media')) {
          const min = /min-width:([\d.]+)px/.exec(selector);
          const max = /max-width:([\d.]+)px/.exec(selector);
          scan(content, active && (!min || width >= Number(min[1])) && (!max || width <= Number(max[1])));
        } else if (active && selector.split(',').some(part => {
          const space = part.indexOf(' ');
          const parent = part.slice(0, space);
          const child = part.slice(space + 1);
          if (space < 0 || !matches(parent, html)) return false;
          if (target === frame) return child.startsWith('.dshm-frame') && matches(child, frame);
          if (target === column) return child === '.dshm-sbcol';
          return child === 'button[data-sidebar-opener]';
        })) {
          for (const declaration of content.split(';')) {
            const colon = declaration.indexOf(':');
            if (colon >= 0) result[declaration.slice(0, colon)] = declaration.slice(colon + 1).replace(/ !important$/, '');
          }
        }
        offset = close;
      }
    };
    scan(css);
    return result;
  };
  const hasClass = name => (html.getAttribute('class') ?? '').split(/\s+/).includes(name);
  const recipe = JSON.parse(readFileSync('hostcore/core-recipe.json', 'utf8'));
  const layoutSource = readFileSync(`dist/core/work/dsh-core-${recipe.coreVersion}/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js`, 'utf8');
  const compute = /function computeColumns\([^]*?return\{sidebar:s,center:Math\.max\(0,viewport-s-r\),rightbar:r\}\}/.exec(layoutSource);
  assert(compute, 'official computeColumns available');
  const nativeColumns = vm.runInNewContext(compute[0] + ';computeColumns', {
    clampWidth: (value, min, max) => Math.min(max, Math.max(min, Math.round(value))), RIGHTBAR_MAX_RATIO: 0.7
  });
  for (const state of [
    ['single', true, 390], ['dual', false, 900], ['triple', false, 1400],
    ['expanded narrow window', false, 540], ['drawer boundary', false, 767],
    ['rail boundary', false, 768], ['single again', true, 390], ['triple again', false, 1400]
  ]) {
    single = state[1]; width = state[2];
    if (width < 768) frame.setAttribute('data-sidebar-drawer', '');
    else frame.removeAttribute('data-sidebar-drawer');
    railHit = width >= 768;
    frame.setAttribute('data-sidebar-collapsed', '');
    tick();
    assert(hasClass('dshm-form-foldable'), state[0] + ': hardware marker retained');
    assert.equal(hasClass('dshm-desktop'), !single, state[0] + ': desktop visual classification');
    assert.equal(hasClass('dshm-handheld'), single, state[0] + ': handheld visual classification');
    assert.equal(hasClass('dshm-pc'), false, state[0] + ': no PC zero-grid takeover');
    assert.equal(hasClass('dshm-compact'), single, state[0] + ': compact follows native bridge');
    assert.equal(hasClass('dshm-tablet'), false, state[0] + ': no tablet geometry');
    assert.equal(declarations(frame)['grid-template-columns'], undefined, state[0] + ': native grid untouched');
    assert.equal(declarations(column).position, undefined, state[0] + ': native sidebar positioning');
    assert.equal(html.getAttribute('data-dshm-rail-opener'), railHit ? '1' : '0');
    assert.equal(declarations(opener).display === 'none', railHit, state[0] + ': exactly one usable official opener');
    if (width < 768) assert(frame.hasAttribute('data-sidebar-drawer'), state[0] + ': official drawer retained');
    if (!single && width >= 768) {
      const cols = nativeColumns(width, 0, 300);
      assert.equal(cols.sidebar, 56, state[0] + ': official collapsed rail 56');
      assert(cols.rightbar > 0, state[0] + ': official rightbar has room');
    }
    for (const open of [false, true]) {
      rightOpen = open;
      tick();
      assert.equal(declarations(frame)['grid-template-columns'], undefined, state[0] + ': rightbar not zeroed');
    }
    rightOpen = false;
    railHit = false;
    tick();
    assert.equal(declarations(opener).display, undefined, state[0] + ': clipped rail keeps leading opener');
    assert.equal(declarations(opener).opacity, '1');
    const before = clicks;
    context.__DSHM_SIDEBAR__.toggle();
    assert.equal(clicks, before + 1, state[0] + ': official toggle works');
    tick();
    assert.equal(html.getAttribute('data-dshm-sidebar'), 'expanded');
    assert.equal(declarations(frame)['grid-template-columns'], undefined, state[0] + ': expanded geometry native');
    context.__DSHM_SIDEBAR__.toggle();
    tick();
    assert.equal(html.getAttribute('data-dshm-sidebar'), 'collapsed', state[0] + ': collapse again');
    assert.equal(declarations(frame)['grid-template-columns'], undefined, state[0] + ': collapsed geometry native');
  }
  for (const mode of [['desktop', false, false], ['phone', true, false], ['desktop', false, true]]) {
    form = mode[0]; single = mode[1]; pc = mode[2]; width = form === 'phone' ? 390 : 800;
    frame.removeAttribute('data-sidebar-drawer');
    frame.setAttribute('data-sidebar-collapsed', '');
    tick();
    assert.equal(html.getAttribute('data-dshm-sidebar'), 'collapsed', form + ': collapsed state');
    assert.equal(hasClass('dshm-form-foldable'), false, form + ': fold marker cleared');
    assert.equal(hasClass('dshm-pc'), form === 'desktop');
    assert.equal(hasClass('dshm-phone'), form === 'phone');
    assert.equal(declarations(frame)['grid-template-columns'], '0 minmax(0,1fr) 0', form + ': existing collapsed grid unchanged');
  }
}

function sidebarTemplate(text) {
  const head = 'const SIDEBAR_SHIM_JS: string = ';
  const start = text.indexOf(head);
  const end = text.indexOf('\n})();`', start);
  assert(start >= 0 && end > start, 'sidebar template range');
  return text.slice(start, end + '\n})();`'.length);
}

const selfTest = process.argv.includes('--self-test');
const entry = readFileSync(ENTRY, 'utf8');
const phone = readFileSync(PHONE, 'utf8');
let base;
try { base = [...judgeEntry(entry), ...judgePhone(phone)]; }
catch (error) {
  console.error('UNVERIFIED official core tree unavailable: ' + error.path);
  process.exit(2);
}

function mutant(source, from, to, judge) {
  const changed = source.replace(from, to);
  assert.notEqual(changed, source, 'mutation must match production source');
  return judge(changed);
}

if (!selfTest) {
  if (base.length > 0) {
    console.error(`❌ 折叠屏形态分派不符合用户口径（${base.length} 处）：`);
    for (const x of base) console.error(`   · ${x}`);
    process.exit(1);
  }
  console.log('PASS fold sidebar: scoped entry contracts; cooked phone JS/CSS; 8 fold transitions; native 56px rail/rightbar; drawer/opener fallback; PC/phone controls.');
  process.exit(0);
}

console.log('--self-test：变异体必须判红 --');
let failures = 0;
if (base.length !== 0) {
  console.error('FAIL production baseline; mutation sensitivity cannot be established:');
  for (const problem of base) console.error(problem);
  process.exit(1);
}
const arms = [
  ['entry foldable 又被塞回手持档', () => mutant(entry,
    "if (form === 'phone' || form === 'tablet') {",
    "if (form === 'phone' || form === 'tablet' || form === 'foldable') {", judgeEntry)],
  ['entry 平板不挂独立档', () => mutant(entry,
    "if (form === 'tablet') { addClass(htmlEl, TABLET_CLASS); }", '', judgeEntry)],
  ['entry 又引入视口兜底', () => mutant(entry,
    'function removeClass(el, cls) {',
    'function tabletLikeForm(form) { return Math.round(window.innerWidth || 0) >= 600; }\n  function removeClass(el, cls) {', judgeEntry)],
  ['phone 桌面档丢掉折叠屏', () => mutant(phone,
    "var desktop = form === 'desktop' || pcm || (foldable && !compact);",
    "var desktop = form === 'desktop' || pcm;", judgePhone)],
  ['phone TABLET_CLASS 又接 foldWide', () => mutant(phone,
    "setFlag(htmlEl, TABLET_CLASS, !desktop && !phone && form === 'tablet');",
    "var foldWide = foldable && (!compact || Math.round(window.innerWidth || 0) >= 600);\n    setFlag(htmlEl, TABLET_CLASS, !desktop && !phone && (form === 'tablet' || foldWide));", judgePhone)],
  ['phone 单屏误判成桌面档', () => mutant(phone,
    "var desktop = form === 'desktop' || pcm || (foldable && !compact);",
    "var desktop = form === 'desktop' || pcm || foldable;", judgePhone)],
  ['fold PC zero-grid regression', () => mutant(phone,
    'PC_CLASS, desktop && !(foldable && !compact)', 'PC_CLASS, desktop', judgePhone)],
  ['fold hardware marker regression', () => mutant(phone,
    'FOLDABLE_CLASS, foldable', 'FOLDABLE_CLASS, !desktop && foldable', judgePhone)],
  ['opener dedup removed', () => mutant(phone,
    '      syncOpener();', '', judgePhone)],
  ['clipped rail incorrectly usable', () => mutant(phone,
    '&& hitTest(el)', '&& true', judgePhone)],
  ['drawer removed for expanded fold', () => mutant(phone,
    'if (isTabletForm()) {', "if (isTabletForm() || document.documentElement.getAttribute('class').includes(FOLDABLE_CLASS)) {", judgePhone)],
  ['PC behavior changed', () => mutant(phone,
    'PC_CLASS, desktop && !(foldable && !compact)', 'PC_CLASS, false', judgePhone)],
  ['phone behavior changed', () => mutant(phone,
    'COMPACT_CLASS, !desktop && compact', 'COMPACT_CLASS, false', judgePhone)],
  ['missing handheld declaration', () => mutant(phone,
    "var HANDHELD_CLASS = 'dshm-handheld';", '', judgePhone)],
  ['fold collapsed grid forced to zero', () => mutant(phone,
    'style.textContent = css;', 'style.textContent = css + \'html.dshm-form-foldable.dshm-desktop[data-dshm-sidebar="collapsed"] .dshm-frame{grid-template-columns:0 minmax(0,1fr) 0 !important}\';', judgePhone)],
  ['fold fixed geometry overrides native drawer', () => mutant(phone,
    'style.textContent = css;', 'style.textContent = css + \'html.dshm-form-foldable.dshm-desktop .dshm-frame{grid-template-columns:280px minmax(0,1fr) 0 !important}\';', judgePhone)],
  ['fold rightbar hidden', () => mutant(phone,
    'style.textContent = css;', 'style.textContent = css + \'html.dshm-form-foldable.dshm-desktop[data-dshm-right="open"] .dshm-frame{grid-template-columns:56px minmax(0,1fr) 0 !important}\';', judgePhone)],
  ['leading opener hidden unconditionally', () => mutant(phone,
    'style.textContent = css;', 'style.textContent = css + \'html[data-dshm-sidebar="collapsed"] button[data-sidebar-opener]{display:none !important}\';', judgePhone)],
];
for (const [name, run] of arms) {
  try {
    const problems = run();
    if (problems.length === 0) { failures += 1; console.error(`  FAIL ${name}: mutant accepted`); }
    else console.log(`  PASS ${name}: rejected (${problems[0]})`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}: ${error.message}`);
  }
}
console.log(failures === 0 ? `PASS self-test: ${arms.length}/${arms.length} mutants rejected` : `FAIL self-test: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
