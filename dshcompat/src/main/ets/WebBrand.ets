/**
 * Web UI 品牌垫片。
 *
 * 上游 Web 客户端通过 `sidebar.brand.*` 与 `conversation.hero.brand.mark`
 * 槽位注册 DeepSeek 鲸鱼和官方字标。MIT 允许修改与再分发，但不授予商标；
 * AGC 1.1.6 第 4 项也要求消除名称、图标和内容混淆。
 *
 * 本垫片只在 DSHM 的 ArkWeb 宿主中注入：
 *   - 隐藏上游品牌 Mark / Name / Hero Fish；
 *   - **左上角品牌标换成「DSHM」自己的标**（docs/322）：把上游 `sidebar.brand.mark`
 *     槽位里的官方鲸鱼隐藏，用本垫片内联的矢量剪影盖上去；浅色主题黑、深色主题白；
 *   - 会话区 Hero 换成本产品的四字标语（见 HERO_LINE 注释）；
 *   - 将文档标题中的上游产品名替换为「DSHM」；
 *   - 不修改上游代码、不删除任何 LICENSE / NOTICE。
 *
 * 使用类名中的语义后缀（如 `_brandIdentity`）而不是构建哈希前缀；
 * 上游若重命名槽位结构，本垫片会安全退回上游原样，不会阻断页面。
 */
/**
 * 左上角与会话区品牌标：**彩色 logo**（docs/324）。
 *
 * 用户口径（2026-10-31）："web 左上角的品牌 logo 不用做成黑色，直接彩色的接入，会话区的也一样"。
 *
 * 【为什么是 base64 PNG 而不是之前的 SVG path】SVG path 只能表达**单色剪影**——
 * 之前那版是黑色剪影盖上去。彩色图必须走位图，而 ArkWeb 页面拿不到 `rawfile`，
 * 所以只能把 96px 的彩色 PNG 内联成 data URI（约 4.5 KB，一次随脚本注入）。
 * 素材由 `tools/make-icon.py` 产出（`web_brand_color.png`），与 APP 图标同源。
 */
const BRAND_MARK_BASE64: string = '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';


/**
 * 会话区 Hero 标题（docs/325）。
 *
 * 沿革：上游「开始一个任务」→「DSHM一瞥」→「今天做点什么」→「惊鸿启动！」
 * →「我们要构建什么？」→「DSHM已就绪」→ **本次用户定为「Let's Vibe Coding」**。
 *
 * 【为什么用双引号】文案里有英文撇号（Let's），ArkTS 单引号字符串会提前闭合。
 * 【宽度】西文 17 字符，26px/500 下约 200px；Hero 行是 nowrap + 居中，
 * 桌面/平板宽屏放得下，手机档 21px 下约 165px，同样在屏宽内。
 */
const HERO_LINE: string = "Let's Vibe Coding";

export const BRAND_SHIM_JS: string = `(function () {
  if (globalThis.__DSHM_BRAND_SHIM__) { return; }
  globalThis.__DSHM_BRAND_SHIM__ = true;
  var STYLE_ID = 'dshm-brand-style';
  /*
   * 彩色品牌标（PNG base64）。
   *
   * 【必须用模板插值把 ArkTS 常量拼进来】这里是 **ArkTS 模板字符串**，
   * 常量名本身不会在网页里展开 —— 若写成字符串拼接，注入到页面后就是未定义标识符，
   * logo 直接不显示，而且**不报错**（静默失效）。
   * 下一行用模板插值，让编译期把 4.5KB 的 base64 字面量拼进脚本。
   *
   * ⚠️ 注释里刻意不写插值符号本身：模板字符串不认注释，注释里的插值符号同样会被展开。
   */
  var MARK_URL = 'url("data:image/png;base64,${BRAND_MARK_BASE64}")';
  /* 同上：必须用模板插值，否则网页里没有 HERO_LINE 这个变量 */
  var HERO_TEXT = JSON.stringify("${HERO_LINE}");
  function ensureStyle() {
    if (document.documentElement !== null) {
      document.documentElement.setAttribute('data-dshm-brand', 'dshm');
      document.documentElement.style.setProperty('--dshm-brand-mark', MARK_URL);
      document.documentElement.style.setProperty('--dshm-hero-line', HERO_TEXT);
    }
    if (document.getElementById(STYLE_ID) !== null || document.head === null) { return; }
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      /*
       * 彩色品牌标：直接铺背景图（不再用 mask —— 那是单色剪影的做法）。
       * 上游那个槽位里的官方鲸鱼 SVG 用 visibility 隐藏，槽位本身保留（宽度 24px）。
       * 【修一个旧缺陷】上一版把 _brandMark 同时放进了下面的 display:none 组，
       * 等于"既画又隐藏"，标其实从没显示过；这里把它从隐藏组里拿出来。
       */
      'html[data-dshm-brand="dshm"] [class*="_brandMark"]{'
      + 'background:var(--dshm-brand-mark) center/contain no-repeat!important;'
      + 'width:24px!important;height:24px!important;min-width:24px!important}'
      + 'html[data-dshm-brand="dshm"] [class*="_brandMark"]>*{visibility:hidden!important}'
      + 'html[data-dshm-brand="dshm"] [class*="_brandName"],'
      + 'html[data-dshm-brand="dshm"] [class*="_railMark"],'
      + 'html[data-dshm-brand="dshm"] [class*="_fishHitbox"],'
      + 'html[data-dshm-brand="dshm"] [class*="_previewBadge"]{display:none!important}'
      + 'html[data-dshm-brand="dshm"] [class*="_brandIdentity"]{display:inline-flex!important;'
      + 'align-items:center;gap:8px;min-width:0;color:var(--dsw-alias-label-primary,#111719)}'
      + 'html[data-dshm-brand="dshm"] [class*="_brandIdentity"]::after{content:"DSHM";'
      + 'font:650 15px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.4px;white-space:nowrap}'
      /*
       * ── Hero 的 logo 与字号（docs/325）────────────────────────────
       * 用户口径："字体跟之前 dsh 官方的看齐，与 logo 高度差不多，调整下字号"。
       *
       * 官方 Hero 的排版事实（dsh-client-ui-conversation 的 _headline 类）：
       *   font-size:26px / font-weight:500 / line-height:32px / color:label-primary
       * 我们此前写的是 650/30px —— **比官方更粗更大**，所以显眼得不协调。
       *
       * 现在两件事一起对齐：
       *   ① 字号/字重/行高**直接抄官方的 26/500/32**（不再自定义粗细）；
       *   ② logo 高度取与这行字**视觉高度**一致的值 —— 官方 headline 的行高是 32px，
       *      故 logo 用 32px（此前 44px 比字高一截，看着像两个不同层级的元素）。
       * 用 rem 无关的 px：官方这里也是 px，跟着它才在同 DPI 下比例一致。
       */
      + 'html[data-dshm-brand="dshm"] [class*="_titleGroup"]::before{content:"";'
      + 'display:inline-block;width:32px;height:32px;margin-right:10px;vertical-align:middle;'
      + 'flex:none;background:var(--dshm-brand-mark) center/contain no-repeat}'
      + 'html[data-dshm-brand="dshm"] [class*="_titleGroup"]>span:not([class*="_previewBadge"])'
      + '{font-size:0!important;line-height:0!important}'
      + 'html[data-dshm-brand="dshm"] [class*="_titleGroup"]>span:not([class*="_previewBadge"])::after'
      + '{content:var(--dshm-hero-line);font-size:26px;font-weight:500;line-height:32px;'
      + 'font-family:ui-sans-serif,system-ui,sans-serif;'
      + 'color:var(--dsw-alias-label-primary,#111719);white-space:nowrap}'
      /* 窄屏（手机）：按官方 headline 的收窄幅度等比缩，logo 跟着缩到 26px 保持"与字同高" */
      + '@media(max-width:640px){'
      + 'html[data-dshm-brand="dshm"] [class*="_titleGroup"]::before{width:26px;height:26px;margin-right:8px}'
      + 'html[data-dshm-brand="dshm"] [class*="_titleGroup"]>span:not([class*="_previewBadge"])::after'
      + '{font-size:21px;line-height:26px}}';
    document.head.appendChild(style);
  }
  function syncTitle() {
    var title = String(document.title || '');
    var next = title
      .replace(/DeepSeek Harness/gi, 'DSHM')
      .replace(/DeepSeek/gi, 'DSHM');
    if (next === '') { next = 'DSHM'; }
    if (next !== title) { document.title = next; }
  }
  ensureStyle();
  syncTitle();
  if (typeof MutationObserver !== 'undefined' && document.head !== null) {
    try {
      new MutationObserver(function () { ensureStyle(); syncTitle(); })
        .observe(document.head, { childList: true });
    } catch (e) { /* 观察失败时交给定时巡检 */ }
  }
  setInterval(function () { ensureStyle(); syncTitle(); }, 500);
})();`;
