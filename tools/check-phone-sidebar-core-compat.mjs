#!/usr/bin/env node
/**
 * 门禁：两壳（phone=手机+折叠 / entry=平板+PC）侧栏垫片对核心 0.2.2-rc.1 的兼容适配。
 *
 * 【为什么要有它】上游 0.2.2-rc.1 在「改善手机端侧栏导航与窄屏布局」这条里做了三件事：
 *
 *   ① HeaderLeadingControls 新增**常驻**的 `data-sidebar-opener`，其 aria-label 恒为
 *      「打开侧边栏」——不再随展开态改文案；
 *   ② `<768` 改叫 `data-sidebar-drawer`，sidebarCol 变绝对定位 + `z-index:71`，
 *      并铺一层 `drawerMask`（`z-index:70`，`--dsw-alias-bg-mask-1` + blur，
 *      展开时 `pointer-events:auto`）；
 *   ③ drawer 态给 CenterColumn / RightbarColumn / sidebarCol / bottomRow / leadingSeat
 *      加 HTML `inert`。
 *
 * 1.1.7（0.2.1-rc.5）这三样**一个都没有**（inert / drawer / drawerOpen 计数全 0）。
 *
 * 【真机事故链（2026-11-06，两份云调试日志）】
 *   · 状态被 opener 污染 ⇒ state() 恒 collapsed ⇒ 轨道压 0、⊞ 常驻、几何整体错位；
 *   · 我们覆盖式侧栏 `z-index:40` 低于官方 `drawerMask:70` ⇒ 侧栏被遮罩盖住（看着"灰"）
 *     且点击被遮罩吃掉（"点不到"）；
 *   · 主区被 inert 冻结 ⇒ 设置 / DeepSeek 登录 / 插件入口 / 终端全部点不到。
 *
 * 判据（两壳各读自己的 SIDEBAR_SHIM_JS 段）：
 *   ① findToggle() 两个循环都跳过 data-sidebar-opener（≥2 处）；
 *   ② 状态以官方 frame 为准：`frame.hasAttribute('data-sidebar-collapsed')`；
 *   ③ 有 findOpener()，且 clickToggle() 在找不到 toggle 时兜底点它（抽屉档唯一开关）；
 *   ④ clearDrawerInert() 整页清 + watchInert() 同帧压制，且都在 tick() 里调用；
 *   ⑤ 覆盖式几何只在 768–1023 生效（`(min-width:768px) and (max-width:1023.98px)`）；
 *      且 z-index 必须高于官方遮罩（80），不得残留 40；
 *   ⑥ 网格归零规则带 `:not([data-sidebar-drawer])`（抽屉档让给官方）；
 *   ⑦ 手机壳：不自绘任何按钮；收起态常显官方 opener，轨内那颗真的点得到时收掉 leading 那颗
 *      （syncOpener + elementFromPoint 命中测试，避免"两颗"与"一颗都不剩"）；
 *   ⑧ 垫片正文不得出现第二个反引号（模板字面量会提前闭合）。
 *
 * 用法：
 *   node tools/check-phone-sidebar-core-compat.mjs
 *   node tools/check-phone-sidebar-core-compat.mjs --self-test   # 变异体必须各自判红
 */
import { readFileSync } from 'node:fs';

const PHONE = 'phone/src/main/ets/pages/WebApp.ets';
const ENTRY = 'entry/src/main/ets/pages/WebApp.ets';

function shimOf(src) {
  const head = 'const SIDEBAR_SHIM_JS: string = `';
  const s = src.indexOf(head);
  if (s < 0) { throw new Error('找不到 SIDEBAR_SHIM_JS'); }
  const e = src.indexOf('\n})();`', s);
  if (e < 0) { throw new Error('SIDEBAR_SHIM_JS 没有顶格收尾 })();`'); }
  return src.slice(s, e);
}

/**
 * @param src 壳文件全文
 * @param opts.hideOpener 是否要求「手持档隐藏官方 opener」（手机档需要，平板档保留自己的入口接管）
 */
export function judge(src, opts = {}) {
  const hideOpener = opts.hideOpener === true;
  const problems = [];
  let shim;
  try { shim = shimOf(src); } catch (err) { return [String(err.message)]; }

  const skips = (shim.match(/hasAttribute\('data-sidebar-opener'\)/g) ?? []).length;
  if (skips < 2) {
    problems.push(`findToggle 两个循环都要跳过官方 opener，当前只有 ${skips} 处`);
  }
  if (!shim.includes("frame.hasAttribute('data-sidebar-collapsed')")) {
    problems.push('状态没有以官方 frame 的 data-sidebar-collapsed 为准（读 aria-label 会被常驻 opener 永久污染成 collapsed）');
  }
  if (!/function stateFromFrame\(/.test(shim) || !/function state\(\)\s*\{/.test(shim)) {
    problems.push('缺少 stateFromFrame() / state() 两层读数（frame 优先、aria-label 兜底）');
  }
  if (!/function findOpener\(/.test(shim) || !shim.includes('el = findOpener();')) {
    problems.push('缺少 findOpener() 或 clickToggle() 没有兜底点 opener（抽屉档官方只留这一颗开关）');
  }
  if (!/function clearDrawerInert\(/.test(shim)) {
    problems.push('缺少 clearDrawerInert 定义');
  }
  if (!/^\s*clearDrawerInert\(\);$/m.test(shim)) {
    problems.push('tick() 没有调用 clearDrawerInert()');
  }
  if (!shim.includes("removeAttribute('inert')")) {
    problems.push('没有清除 inert（抽屉会灰色且无法点击）');
  }
  if (!shim.includes("document.querySelectorAll('[inert]')")) {
    problems.push('inert 必须整页清除；只清侧栏列会让设置 / 登录 / 插件入口 / 终端全部点不到');
  }
  if (!/function watchInert\(/.test(shim) || !/new MutationObserver\(/.test(shim)) {
    problems.push('缺少 MutationObserver 即时清除 inert（React 重渲染间隙仍会点不动）');
  }
  if (!/^\s*watchInert\(\);$/m.test(shim)) {
    problems.push('tick() 没有调用 watchInert()');
  }
  /* ⑤ 几何档位：<768 必须交还官方抽屉 */
  if (!shim.includes('(min-width:768px) and (max-width:1023.98px)')) {
    problems.push('覆盖式几何没有限定在 768–1023（<768 必须交还官方抽屉，否则与官方遮罩打架）');
  }
  if (shim.includes('z-index:40')) {
    problems.push('残留 z-index:40 —— 低于官方 drawerMask(70)，侧栏会被遮罩盖住且点不到');
  }
  if (!shim.includes('z-index:80')) {
    problems.push('覆盖式侧栏没有抬到 z-index:80（必须高于官方 drawerMask 70 / sidebarCol 71）');
  }
  /* ⑥ 网格归零让位：PC 与 COMPACT 两条选择器都要带守卫（少一条就有一条在抽屉档抢布局） */
  const minGuards = typeof opts.minDrawerGuards === 'number' ? opts.minDrawerGuards : 1;
  const drawerGuards = (shim.match(/:not\(\[data-sidebar-drawer\]\)/g) ?? []).length;
  if (drawerGuards < minGuards) {
    problems.push(`网格归零规则缺 :not([data-sidebar-drawer]) 守卫（需 ${minGuards} 处，当前 ${drawerGuards}；抽屉档会和官方抢布局）`);
  }
  /*
   * ⑦′ 平板档：**几何与折叠全部交还官方**（2026-11-06 docs/385）
   *
   * 官方 computeColumns：collapsedWidth = drawer||darwin||windowsTitlebar ? 0 : 56
   * ⇒ 平板（非抽屉）收起是 56px 图标轨（轨内自带 toggle），展开 280。
   * 我们只保留两件事：默认展开（补点一次）+ 用户收起后停手。
   * **禁止**再写平板几何、**禁止**再自绘 ⊞ —— 两者都会造成"两套状态各说各话"。
   */
  if (hideOpener) {
    if (!shim.includes("var TABLET_CLASS = 'dshm-tablet'")) {
      problems.push('缺少 dshm-tablet 类（平板档与手机档要分开）');
    }
    if (shim.includes("+ 'html.' + TABLET_CLASS + '[' + STATE_ATTR + '=\"expanded\"] .' + FRAME_CLASS")) {
      problems.push('平板又强加了展开态几何 —— 官方自己就是 280，强加会与 56px 图标轨打架');
    }
    if (shim.includes('grid-template-columns:280px minmax(0,1fr) auto')) {
      problems.push('平板又出现强制 280px 列定义（应收敛为官方 computeColumns）');
    }
    /* 【2026-11-11 第十次收敛（用户报"小窗里左上角两个按钮"）】
       自绘 ⊞ 整体删除，收起 / 小窗 / 平板轨一律只用官方那颗；重复的那颗靠 syncOpener
       收掉（轨内那颗真的点得到时，才藏 leading 座位里的）。
       注意：getBoundingClientRect 不扣祖先 overflow 裁剪 ⇒ 必须用 elementFromPoint 实测，
       否则 0 宽列 / 抽屉出屏时会把"点不到"的按钮当成可用，连唯一入口一起藏掉。 */
    if (shim.includes('dshm-sidebar-fab') || shim.includes('FAB_ID') || /function ensureFab\(/.test(shim)) {
      problems.push('残留自绘 ⊞（FAB_ID / ensureFab / dshm-sidebar-fab）—— 会与官方 opener 同时出现两颗');
    }
    if (!/function railToggle\(/.test(shim) || !/function syncOpener\(/.test(shim)) {
      problems.push('缺少 railToggle() / syncOpener()（收起 / 小窗 / 平板轨会出现两颗官方 opener）');
    }
    if (!/^\s*syncOpener\(\);$/m.test(shim)) {
      problems.push('tick() 没有调用 syncOpener()（重复的 leading opener 不会被收掉）');
    }
    if (!/function hitTest\(/.test(shim) || !shim.includes('document.elementFromPoint(')) {
      problems.push('syncOpener 没有命中测试（被裁剪或移出屏幕的轨内按钮会被当成可用，唯一入口被藏掉）');
    }
    if (!shim.includes(`+ 'html[' + RAIL_OPENER_ATTR + '="1"] button[data-sidebar-opener]{display:none !important}'`)) {
      problems.push('轨内 toggle 可用时没有收掉 leading 座位里重复的那颗');
    }
    if (!shim.includes('button[data-sidebar-opener]{opacity:1 !important;visibility:visible !important;pointer-events:auto !important}')) {
      problems.push('收起态没有把官方 opener 强制常显（小窗 / 折叠单屏 / PC 收起会没有入口）');
    }
    if (shim.includes(`+ 'html.' + COMPACT_CLASS + ':not(.' + TABLET_CLASS + ') [data-sidebar-opener]{display:none !important}'`)) {
      problems.push('又整体隐藏了手机档官方 opener —— 轨内那颗在被压成 0 宽时不可用，会一颗都不剩');
    }
    if (shim.includes(`+ 'html.' + TABLET_CLASS + '[' + STATE_ATTR + '="collapsed"] [class*="_toggle"]{display:none`)) {
      problems.push('平板档藏了官方轨内 toggle（收起后没有任何入口）');
    }
    if (!/var tabletWantsExpanded = true;/.test(shim)) {
      problems.push('缺少 tabletWantsExpanded（平板默认展开的唯一意图源）');
    }
    if (!/if \(!tabletWantsExpanded \|\| manualTabletCollapsed\) \{ return; \}/.test(shim)) {
      problems.push('平板补点没有以 tabletWantsExpanded / manualTabletCollapsed 为闸（用户收起后会被顶回来）');
    }
    if (!/if \(onTablet\) \{ tabletWantsExpanded = false; applyState\('collapsed'/.test(shim)) {
      problems.push('用户点官方那颗收起时没有同步 tabletWantsExpanded');
    }
    if (!shim.includes('bootQuietUntil - STARTUP_QUIET_MS + 3000')) {
      problems.push('平板首帧静默期仍是 20s（用户会以为"进去没展开"）');
    }
    if (!/applyState\(state\(\), isTabletForm\(\) \? '\(poll tablet\)' : '\(poll\)'\)/.test(shim)) {
      problems.push('syncState 在平板档没有跟随官方状态（几何已交还官方，必须读官方）');
    }
    /*
     * 【2026-11-18 竖屏 / 折叠屏展开修正】官方 narrow = viewport < 1024：侧栏列变 absolute 抽屉、
     * 主列吃整幅网格。折叠屏展开与平板竖屏都落在这一档；写死 280/56 会让主列回流进第 1 轨、
     * 会话区压到左栏上（用户实测"左栏显示不全"）。⇒ 写死几何只许在 ≥1024 生效，
     * <1024 主动补 drawer 属性走官方浮层，补点也只在 ≥1024。
     */
    if (!shim.includes("+ '@media (min-width:1024px){'")) {
      problems.push('平板写死几何没有收进 ≥1024 媒体查询（官方 narrow 下主列会压到左栏）');
    }
    if (!shim.includes("frame.setAttribute('data-sidebar-drawer', 'true')")) {
      problems.push('平板 <1024 没有补官方抽屉标记（narrow 档会按写死几何走，主区被挤）');
    }
    if (!/innerWidth \|\| 0\) < 1024/.test(shim)) {
      problems.push('平板补点没有 1024 闸（竖屏 / 折叠展开时抽屉会被反复顶开、盖住主区）');
    }
  }
  /* ⑦ 手机壳专属：单入口靠 syncOpener 去重，不靠"整体藏掉官方按钮" */
  if (hideOpener) {
    if (!shim.includes("if (!isTabletForm() && (cls.indexOf(COMPACT_CLASS) >= 0")) {
      problems.push('平板常驻自愈被 compact 拦下（平板可能同时是 compact，会永不自动展开）');
    }
    if (!shim.includes(`+ 'html[' + STATE_ATTR + '="collapsed"][' + PANEL_ATTR + '="open"] button[data-sidebar-opener]{opacity:0 !important;pointer-events:none !important}'`)) {
      problems.push('设置面板打开时没有隐去 leading opener（会压在面板标题 / 返回键上）');
    }
    if (!shim.includes(`+ 'html[' + RIGHT_ATTR + '="open"] button[data-sidebar-opener]{opacity:0 !important;pointer-events:none !important}'`)) {
      problems.push('右侧栏打开时没有隐去 leading opener（会压在右栏标题上）');
    }
  }

  const body = shim.slice(shim.indexOf('`') + 1);
  if (body.includes('`')) { problems.push('垫片正文出现第二个反引号'); }
  return problems;
}

function main() {
  const phoneSrc = readFileSync(PHONE, 'utf8');
  const entrySrc = readFileSync(ENTRY, 'utf8');
  if (process.argv.includes('--self-test')) {
    const mutants = [
      ['M1 去掉所有 opener 跳过', (s) => s.replaceAll("if (buttons[i].hasAttribute('data-sidebar-opener')) { continue; }", '/* removed */').replaceAll("if (list[i].hasAttribute('data-sidebar-opener')) { continue; }", '/* removed */')],
      ['M2 去掉收掉 leading opener 的 CSS', (s) => s.replace('[data-sidebar-opener]{display:none !important}', 'x')],
      ['M3 去掉 tick 里的 syncOpener', (s) => s.replace('      syncOpener();\n', '')],
      ['M4 去掉 tick 里的 clearDrawerInert', (s) => s.replace('      clearDrawerInert();', '      /* removed */')],
      ['M5 去掉清除 inert', (s) => s.replaceAll("removeAttribute('inert')", "getAttribute('inert')")],
      ['M6 退回只清侧栏列', (s) => s.replace("var nodes = document.querySelectorAll('[inert]');", 'var nodes = [];')],
      ['M7 去掉 tick 里的 watchInert', (s) => s.replace('      watchInert();', '      /* removed */')],
      ['M8 状态退回 aria-label', (s) => s.replace("frame.hasAttribute('data-sidebar-collapsed') ? 'collapsed' : 'expanded'", "stateOf(findToggle())")],
      ['M9 去掉 opener 点击兜底', (s) => s.replace('if (el === null) { el = findOpener(); }', '/* removed */')],
      ['M10 几何退回全宽媒体查询', (s) => s.replace("(min-width:768px) and (max-width:1023.98px)", '(max-width:1023.98px)')],
      ['M11 z-index 退回 40', (s) => s.replace('z-index:80', 'z-index:40')],
      ['M12 去掉抽屉守卫', (s) => s.replaceAll(':not([data-sidebar-drawer])', '')],
      ['M13 平板自愈丢掉意图闸', (s) => s.replace("if (!tabletWantsExpanded || manualTabletCollapsed) { return; }",
        "if (manualTabletCollapsed) { return; }")],
      ['M16 平板默认改成收起', (s) => s.replace('var tabletWantsExpanded = true;', 'var tabletWantsExpanded = false;')],
      ['M20 收起态不再常显官方 opener', (s) => s.replace(
        "      + 'html[' + STATE_ATTR + '=\"collapsed\"] button[data-sidebar-opener]{opacity:1 !important;visibility:visible !important;pointer-events:auto !important}'\n", '')],
      ['M21 自绘 ⊞ 又塞回来', (s) => s.replace("  var BACKDROP_ID = 'dshm-sidebar-backdrop';",
        "  var BACKDROP_ID = 'dshm-sidebar-backdrop';\n  var FAB_ID = 'dshm-sidebar-fab';")],
      ['M25 去掉 rail-opener 去重规则', (s) => s.replace(
        "      + 'html[' + RAIL_OPENER_ATTR + '=\"1\"] button[data-sidebar-opener]{display:none !important}'\n", '')],
      ['M26 命中测试退回 getClientRects（不扣祖先裁剪）', (s) => s.replace("document.elementFromPoint(x, y)", "el.getClientRects()[0]")],
      ['M27 竖屏几何限定放宽到 640（主列又压左栏）', (s) => s.replace("'@media (min-width:1024px){'", "'@media (min-width:640px){'")],
      ['M28 <1024 不再补官方抽屉标记', (s) => s.replace("        } else if (!frame.hasAttribute('data-sidebar-drawer')) {\n          frame.setAttribute('data-sidebar-drawer', 'true');\n", '')],
      ['M29 去掉补点的 1024 闸（竖屏抽屉被反复顶开）', (s) => s.replace("if (Math.round(window.innerWidth || 0) < 1024) { return; }", '')],
    ];
    let bad = 0;
    for (const [name, mutate] of mutants) {
      const changed = mutate(phoneSrc);
      const caught = changed !== phoneSrc && judge(changed, { hideOpener: true, minDrawerGuards: 2 }).length > 0;
      if (!caught) { bad += 1; }
      console.log(`${caught ? 'OK ' : 'BAD'} ${name}${caught ? '' : ' —— 门禁没有判红'}`);
    }
    if (bad > 0) { process.exitCode = 1; }
    console.log(`自检：${mutants.length - bad}/${mutants.length} 个变异体被判红`);
    return;
  }
  const problems = [
    ...judge(phoneSrc, { hideOpener: true, minDrawerGuards: 2 }).map((p) => `[phone] ${p}`),
    ...judge(entrySrc, { hideOpener: false }).map((p) => `[entry] ${p}`),
  ];
  if (problems.length > 0) {
    for (const p of problems) { console.error('  ✗ ' + p); }
    process.exitCode = 1;
    console.error(`FAIL ${problems.length} 项`);
    return;
  }
  console.log('PASS 两壳侧栏垫片 0.2.2-rc.1 兼容齐全（状态读 frame / opener 兜底点击 / 整页清 inert + Observer / 抽屉几何交还官方）');
}

main();
