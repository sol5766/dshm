#!/usr/bin/env node
/**
 * 门禁：DSHM 独立品牌面 + 开源归属。
 *
 * AGC 1.1.6 第 4 项要求消除与 DeepSeek 应用的名称、图标和内容混淆；同时
 * DeepSeek Harness 的 MIT 要求保留版权与许可声明。本门禁同时守两侧：
 *   A. 用户可见资源不得继续使用鲸鱼资产或 DeepSeek Harness 品牌文案；
 *   B. Web UI 品牌垫片必须隐藏上游 Mark/Name/Hero Fish，显示**本应用自己的品牌名**；
 *   C. entry / phone 的图标资源一致，背景层存在；
 *   D. MIT 与第三方声明必须随包提供，且两份 HAP 副本逐字一致；
 *   E. 声明可以出现 DeepSeek 归属，但只能作为开源归属，不得回到产品标题。
 *
 * 离线门禁：不需要核心树、DevEco 或真机。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

/**
 * 本应用的用户可见品牌名（2026-10-30 由 DSHM 更名为「DSHM」，见 docs/320）。
 *
 * 【为什么要常量】门禁要判"垫片真的把上游产品名换成了我们的名字"，
 * 但**这个名字会变**（这次就变了）。写成常量，换名只需改这里与 `dshcompat/WebBrand.ets` 两处；
 * 散在断言里写死，换名时门禁会变成"必须让页面继续叫旧名字"的错误约束。
 */
const BRAND_NAME = 'DSHM';

const FILES = {
  brand: 'dshcompat/src/main/ets/WebBrand.ets',
  index: 'dshcompat/src/main/ets/Index.ets',
  entryWeb: 'entry/src/main/ets/pages/WebApp.ets',
  phoneWeb: 'phone/src/main/ets/pages/WebApp.ets',
  entryNotice: 'entry/src/main/resources/rawfile/licenses/LICENSES.txt',
  phoneNotice: 'phone/src/main/resources/rawfile/licenses/LICENSES.txt',
  rootNotice: 'THIRD_PARTY_NOTICES.md',
};

const ICON_FILES = [
  'AppScope/resources/base/media/background.png',
  'AppScope/resources/base/media/foreground.png',
  'entry/src/main/resources/base/media/background.png',
  'entry/src/main/resources/base/media/foreground.png',
  'phone/src/main/resources/base/media/background.png',
  'phone/src/main/resources/base/media/foreground.png',
  'entry/src/main/resources/base/media/logo_dark.png',
  'phone/src/main/resources/base/media/logo_dark.png',
  'entry/src/main/resources/base/media/startIcon.png',
  'phone/src/main/resources/base/media/startIcon.png',
  'entry/src/main/resources/rawfile/common/dshm_agent_icon.png',
  'phone/src/main/resources/rawfile/common/dshm_agent_icon.png',
];

const VISIBLE_STRING_FILES = [
  'entry/src/main/resources/base/element/string.json',
  'entry/src/main/resources/en_US/element/string.json',
  'phone/src/main/resources/base/element/string.json',
  'phone/src/main/resources/en_US/element/string.json',
  'entry/src/main/resources/base/profile/agent_config.json',
  'phone/src/main/resources/base/profile/agent_config.json',
  'entry/src/main/ets/insightintents/StartNewSessionImpl.ets',
  'phone/src/main/ets/insightintents/StartNewSessionImpl.ets',
  /* 2026-10-29 审核：关于页是**用户可见**的品牌/版权面，此前没纳入守护。 */
  'entry/src/main/ets/view/AboutPanel.ets',
];

const read = (rel) => readFileSync(rel, 'utf8');
const sha = (rel) => createHash('sha256').update(readFileSync(rel)).digest('hex');

/**
 * 取垫片脚本体，并**模拟 ArkTS 编译期插值**。
 *
 * 【为什么必须模拟】`BRAND_SHIM_JS` 是 ArkTS 模板字符串，其中 `${CONST}` 在编译期就被替换成
 * 常量字面量；而门禁直接读源码文本时拿到的仍是 `${CONST}` 原文。
 * 若不模拟，就会出现两种误判：
 *   · 真机有效（插值正常）而门禁把 `"${HERO_LINE}"` 当成最终文案 ⇒ 假红；
 *   · 忘记写插值（裸常量名）时字符串里根本没有 `${}` ⇒ 门禁看不出问题 ⇒ 假绿。
 * ⇒ 这里按源码里 `const NAME: string = '…'` 的定义做一次替换，与编译期行为对齐。
 */
function extractShim(src) {
  const head = 'export const BRAND_SHIM_JS: string = `';
  const start = src.indexOf(head);
  if (start < 0) throw new Error('找不到 BRAND_SHIM_JS');
  const tail = '\n})();`;';
  const end = src.indexOf(tail, start);
  if (end < 0) throw new Error('BRAND_SHIM_JS 没有顶格收尾');
  const body = src.slice(start + head.length, end + '\n})();'.length);
  return interpolateConstants(body, src);
}

/** 把 `\${NAME}` 换成源码里 `const NAME: string = '...'` 的单引号字面量内容。 */
/**
 * 取源码里 `const NAME: string = <字面量>` 的字面量内容。
 *
 * 【为什么两种引号都要支持】原先只认单引号。而 2026-11-01 的 Hero 文案
 * `Let's Vibe Coding` **含英文撇号**，ArkTS 里只能用双引号包（单引号会提前闭合），
 * 于是插值模拟取不到定义 ⇒ 误判成「未定义常量」+「CSS 残留插值标记」两条假红。
 * 字面量语法本来就允许两种引号，判据要跟着语言走，而不是跟着以前的写法走。
 *
 * 返回 `{ found, value }`；`found=false` 表示源码里没有该常量的字符串定义。
 */
function stringConstValue(src, name) {
  const re = new RegExp(
    'const ' + name + '\\s*:\\s*string\\s*=\\s*'
    + '(?:\'((?:[^\'\\\\]|\\\\.)*)\'|"((?:[^"\\\\]|\\\\.)*)")',
  );
  const m = re.exec(src);
  if (m === null) {
    return { found: false, value: '' };
  }
  const raw = m[1] !== undefined ? m[1] : m[2];
  /* 反解字符串字面量里的转义（\\' \\" \\\\ \\n \\t），其余原样 */
  const value = raw.replace(/\\(.)/g, (all, ch) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch));
  return { found: true, value };
}

function interpolateConstants(body, src) {
  return body.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => {
    const hit = stringConstValue(src, name);
    return hit.found ? hit.value : whole;
  });
}

/**
 * 列出模板里**引用了、但源码里没有定义**的常量。
 *
 * 【为什么要有它】插值模拟对"找不到定义"的常量会原样保留 `${NAME}`，
 * 于是 CSS 变量里就是一段垃圾字符串（本轮踩过：把 `${HERO_LINE}` 写成
 * `${HERO_LINE_MISSING}` 时，只看 path 形状的用例仍然通过 ⇒ 判据不够尖）。
 * 这里单独把这个差异报出来。
 */
function unresolvedConstants(body, src) {
  const missing = [];
  for (const m of body.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    if (!stringConstValue(src, m[1]).found) missing.push(m[1]);
  }
  return missing;
}

function runShim(body) {
  let style = null;
  const attrs = {};
  /* 垫片用 documentElement.style.setProperty 注入 CSS 变量（--dshm-brand-mask / --dshm-hero-line） */
  const cssVars = {};
  const bodyAttrs = {};
  const doc = {
    title: 'DeepSeek Harness',
    body: {
      getAttribute(name) {
        return bodyAttrs[name] ?? null;
      },
      style: {
        setProperty(name, value) {
          cssVars[name] = value;
        },
      },
    },
    documentElement: {
      style: {
        setProperty(name, value) {
          cssVars[name] = value;
        },
      },
      setAttribute(name, value) {
        attrs[name] = value;
      },
    },
    head: {
      appendChild(node) {
        if (node.tag === 'style') style = node;
      },
    },
    getElementById(id) {
      return style !== null && style.id === id ? style : null;
    },
    createElement(tag) {
      return { tag, id: '', textContent: '' };
    },
  };
  class Observer {
    observe() {}
  }
  delete globalThis.__DSHM_BRAND_SHIM__;
  const fn = new Function('document', 'MutationObserver', 'setInterval', 'console', body);
  fn(doc, Observer, () => 0, { info() {}, warn() {}, error() {} });
  return { doc, attrs, style, cssVars };
}

function scanCss(css) {
  let depth = 0;
  let min = 0;
  for (const ch of css) {
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth < min) min = depth;
    }
  }
  return { depth, min };
}

function testSources() {
  const notes = [];
  let pass = 0;
  let fail = 0;
  const ok = (cond, msg) => {
    if (cond) {
      pass += 1;
      notes.push('  PASS  ' + msg);
    } else {
      fail += 1;
      notes.push('  FAIL  ' + msg);
    }
  };

  for (const rel of [...new Set([...Object.values(FILES), ...ICON_FILES])]) {
    ok(existsSync(rel), `存在 ${rel}`);
  }

  const brand = read(FILES.brand);
  ok(brand.includes('Original') === false, '品牌垫片源不冒充上游官方品牌');
  ok(brand.includes('__DSHM_BRAND_SHIM__'), '垫片有单例闸门');
  ok(brand.includes('data-dshm-brand'), '垫片给根节点挂 DSHM 品牌标记');

  let shim;
  try {
    shim = runShim(extractShim(brand));
  } catch (error) {
    ok(false, '垫片可在 DOM 桩中执行：' + error.message);
    return { pass, fail, notes };
  }
  ok(shim.attrs['data-dshm-brand'] === 'dshm', '根节点品牌标记实际写入 dshm');
  ok(shim.doc.title === BRAND_NAME, `文档标题中的 DeepSeek Harness 被替换为 ${BRAND_NAME}`);

  /*
   * 【docs/322】左上角品牌标换成自有剪影、会话区 Hero 换成自有四字标语。
   *
   * 判据取的是**运行后**的读数（不是源码里的字符串）：垫片把 SVG 与标语放进 CSS 变量，
   * 所以只要变量真的注入且不为空，就说明模板里的 ArkTS 常量**已在编译期展开**。
   * 这正好挡住"把常量名直接写进模板、注入后变成未定义变量"这类静默失效。
   */
  const markUrl = shim.cssVars['--dshm-brand-mark'] ?? '';
  const heroLine = (shim.cssVars['--dshm-hero-line'] ?? '').replace(/^"|"$/g, '');
  /* 2026-10-31：改为**彩色 PNG**（docs/324），不再是单色 SVG 剪影 */
  ok(markUrl.startsWith('url("data:image/png;base64,'),
    '品牌标以彩色 PNG data URI 注入（不是空值）');
  ok(markUrl.length > 1000, '品牌标 base64 长度合理（图确实内联进去了）');
  /* 2026-10-31：用户要求换掉「DSHM一瞥」，改为平实文案（不再限定四字） */
  ok(heroLine.length > 0 && heroLine !== '开始一个任务',
    `Hero 使用自有文案且不再是上游默认（实际 "${heroLine}"）`);
  ok(heroLine !== 'DSHM一瞥', 'Hero 已不再使用「DSHM一瞥」');
  /*
   * 【为什么判"经过插值后的具体内容"】模板里的 `${BRAND_MARK_PATH}` 若被误删插值
   * （写成裸常量名），运行后变量会变成 "d=" 空串 —— 下面这条会立刻判红。
   */
  /*
   * data URI 里的 path 被 encodeURIComponent 编码过（空格 → %20），要先解码再匹配；
   * 直接对编码串用 \s 永远匹配不上 —— 那是判据写错，不是实现错。
   */
  let markDecoded = '';
  try {
    markDecoded = decodeURIComponent(markUrl);
  } catch (e) {
    markDecoded = '';
  }
  ok(/^[A-Za-z0-9+/=]{1000,}$/.test(markUrl.replace('url("data:image/png;base64,', '').replace('")', '')),
    '品牌标 base64 已展开为真实数据（插值生效）');
  const shimSrc = read(FILES.brand);
  const shimBody = extractShim(shimSrc);
  /* 判原始模板（未插值）里确实写了 ${} —— 上面两条判的是插值后的运行结果 */
  const rawBody = read(FILES.brand);
  ok(rawBody.includes('${BRAND_MARK_BASE64}') && rawBody.includes('${HERO_LINE}'),
    '模板里用 ${} 插值引用 ArkTS 常量（不是裸变量名）');
  /*
   * 模板里引用的常量必须在源码里**真的定义**：否则插值模拟会原样留下 `${…}`，
   * 运行期的 CSS 变量就是一段垃圾（本轮就踩过：写成 ${HERO_LINE_MISSING} 时
   * 只判 path 形状的用例仍然通过 ⇒ 判据不够尖）。
   */
  const unresolved = unresolvedConstants(rawBody, read(FILES.brand));
  ok(unresolved.length === 0,
    `模板引用的常量都已定义（未定义：${unresolved.length === 0 ? '无' : unresolved.join(', ')}）`);
  ok(!markDecoded.includes('${') && !heroLine.includes('${'),
    '运行期 CSS 变量里没有残留未解析的插值标记');
  ok(shim.style !== null && shim.style.textContent.length > 0, '垫片实际注入品牌样式表');
  const css = shim.style?.textContent ?? '';
  for (const fragment of ['_brandMark', '_brandName', '_railMark', '_fishHitbox', '_previewBadge']) {
    ok(css.includes(fragment), `隐藏上游品牌节点 ${fragment}`);
  }
  /*
   * 【2026-10-31 判据更新（docs/322）】旧设计用 `>_` 终端提示符冒充品牌；
   * 现在侧栏与 Hero 都换成**自有 logo 剪影**（`--dshm-brand-mask`），
   * 故判据从"有没有 >_" 改成"有没有用 mask 画品牌标"。
   */
  ok(css.includes('_brandMark') && css.includes('var(--dshm-brand-mark)'),
    '侧栏品牌标使用自有彩色 logo');
  /*
   * 咬住一个真实旧缺陷：上一版把 _brandMark 同时放进 display:none 组，
   * 等于"既画又隐藏"，标从没显示过。这里断言它不在隐藏组里。
   */
  /*
   * 咬住一个真实旧缺陷：上一版把 _brandMark 同时放进 display:none 组，
   * 等于"既画又隐藏"，标从没显示过。
   * 判据：找到所有含 display:none 的 CSS 段，看其中有没有 `_brandMark` 选择器。
   */
  const noneSegments = css.split('}').filter((seg) => seg.includes('display:none'));
  const markHidden = noneSegments.some((seg) => /\[class\*="_brandMark"\]/.test(seg));
  ok(!markHidden, '侧栏品牌标没有被 display:none 隐藏掉（旧缺陷回归守卫）');
  ok(css.includes(`content:"${BRAND_NAME}"`), `侧栏显示 ${BRAND_NAME} 名称`);
  /* Hero 文案改为自有四字标语，由 `--dshm-hero-line` 注入（docs/322） */
  ok(css.includes('content:var(--dshm-hero-line)'), 'Hero 标题改用自有标语变量');
  const brackets = scanCss(css);
  ok(brackets.depth === 0 && brackets.min >= 0,
    `品牌样式括号配平（depth=${brackets.depth}, min=${brackets.min}）`);

  const index = read(FILES.index);
  ok(index.includes("export { BRAND_SHIM_JS } from './WebBrand';"), 'dshcompat 导出品牌垫片');
  for (const rel of [FILES.entryWeb, FILES.phoneWeb]) {
    const src = read(rel);
    ok(src.includes("import { BRAND_SHIM_JS } from 'dshcompat';"), `${rel} 导入品牌垫片`);
    ok(src.includes("{ script: BRAND_SHIM_JS, scriptRules: ['*'] },"), `${rel} 注册品牌垫片`);
  }
  /*
   * 【2026-11-11 菜单重构】「关于」从「应用」菜单拎出来独立成第二个菜单，含
   * 「版本信息 / 开源组件声明」两个子项（用户裁决）。入口判据跟着形态走：
   * 仍要求 PC 端有关于入口、关于页仍保留上游版权与无隶属声明。
   */
  /*
   * 【2026-11-11 菜单收敛（第三次）】顶栏只剩一颗三点菜单：「应用」（主页 / 刷新）
   * 整条删除，入口以三个实心圆点呈现，点开仍是「版本信息 / 开源组件声明」。
   * 反向判据守住"别再顺手加回来"。
   */
  const aboutPanel = read('entry/src/main/ets/view/AboutPanel.ets');
  const entryWebSrc = read(FILES.entryWeb);
  ok(entryWebSrc.includes('this.DotsMenu()') && entryWebSrc.includes('private aboutMenu(): Array<MenuElement>'),
    'PC 端顶栏以三点菜单提供关于入口（含开源许可与版权）');
  ok(!entryWebSrc.includes('this.appMenu') && !entryWebSrc.includes('function goHome') && !entryWebSrc.includes('function refreshView'),
    '「应用」菜单（主页 / 刷新）及其实现在顶栏删除');
  ok(entryWebSrc.includes("value: '版本信息'") && entryWebSrc.includes("value: '开源组件声明'"),
    '「关于」菜单含「版本信息 / 开源组件声明」两个子项');
  /*
   * 【同日二次裁决】两个子项各自单页：点哪个入口只显示哪一页，面板内不再并列页签。
   * 反向判据 —— 防止后续「顺手加回页签」把这条裁决冲掉。
   */
  ok(!aboutPanel.includes('TabButton') && aboutPanel.includes("this.initialTab === 'version'"),
    '关于面板两个入口各自单页（面板内不再并列页签）');
  ok(aboutPanel.includes("Copyright (c) 2026 DeepSeek"), 'PC 关于页保留上游版权归属');
  ok(aboutPanel.includes('不存在隶属、授权、代理'),
    'PC 关于页明确无隶属/授权关系');
  ok(aboutPanel.includes('DSHM自有原生件（不计入第三方）'),
    'PC 关于页的自有原生件署名已同步为DSHM');

  /*
   * 【docs/321 复核补】改名不能停在资源文件：Beta 出包器和 AGC 草稿也要跟上。
   * 旧 build-beta 写死 DSHM→DSHM beta，改名后会在最后一步断言失败；
   * AGC 草稿若继续叫 DSHM，则上传后商店名与包内显示名不一致。
   */
  const betaBuilder = read('tools/build-beta.mjs');
  ok(betaBuilder.includes("const PROD_LABEL = 'DSHM';")
    && betaBuilder.includes("const BETA_LABEL = 'DSHM beta';")
    && betaBuilder.includes('Buffer.from(BETA_LABEL'),
    'Beta 出包器按新品牌名改写并校验可见名称');
  const agcDraftPath = 'metadata/agc-listing-1.1.8-rc2-zh-CN.json';
  /* metadata/ 是运营物料，不随公开仓库分发：本地存在时才校验草稿，缺失不算失败。 */
  if (existsSync('metadata')) {
    ok(existsSync(agcDraftPath), '存在DSHM当前版本的 AGC 元数据草稿');
  }
  if (existsSync(agcDraftPath)) {
    const agcDraft = JSON.parse(read(agcDraftPath));
    ok(agcDraft.appName === 'DSHM' && agcDraft.bundleName === 'com.dshm.dshclient',
      'AGC 草稿显示名为DSHM、包名保持 com.dshm.dshclient');
    ok(agcDraft.privacyPolicy?.name === 'DSHM隐私政策',
      'AGC 草稿的隐私政策展示名同步为DSHM');
    /*
     * 版本号**从配方动态取**，不写死：写死会在每次升核心时假红（本轮 rc.4→rc.5 就是这样）。
     * 判据本意是"草稿说的版本 == 配方里的版本"，而不是"== 某个特定字符串"。
     */
    const recipeVersion = JSON.parse(read('hostcore/core-recipe.json')).coreVersion;
    ok(agcDraft.newFeatures?.includes(recipeVersion),
      `AGC 草稿更新说明与实际核心版本一致（${recipeVersion}）`);
  }
  /*
   * 【所有**当前生效**的 AGC 元数据都必须用新品牌名】（docs/334 复核查出的漏网）
   *
   * 上一版判据只钉了 `agc-listing-jinghong-1.1.6-*.json` 一份 —— 而上传 AGC 时
   * 真正可能被用到的 `agc-listing-1.1.7-*.json` 与 `agc-listing-zh-CN.json` 里
   * `appName` 仍是 **DSHM**，品牌改名等于没做完就上架。
   *
   * 判据：除 `1.1.6` 历史草稿（保留为历史记录）外，其余 `agc-listing*.json`
   * 的 appName 必须是 `BRAND_NAME`（当前 = DSHM）；appDesc 不得以**旧品牌名**自称开头。
   *
   * 【2026-11-01 品牌回退】「鲸鸿」与华为自有品牌「鲸鸿动能」撞名，用户要求
   * **图标保留新版、应用名与全部文案改回 DSHM**。于是"旧品牌名"从 DSHM 变成「鲸鸿」，
   * 这条断言的方向必须跟着翻，否则它会把正确的元数据判红（当时确实红了 3 条）。
   */
  {
    const dir = 'metadata';
    const drafts = existsSync(dir)
      ? readdirSync(dir).filter((f) => /^agc-listing.*\.json$/.test(f)
          && !f.includes('1.1.6-zh-CN'))      // 历史草稿：保留原样
      : [];
    /* 同上：metadata/ 不入库，本地没有时不判红 */
    if (existsSync(dir)) ok(drafts.length > 0, '存在当前生效的 AGC 元数据草稿');
    for (const f of drafts) {
      const j = JSON.parse(read(`${dir}/${f}`));
      ok(j.appName === 'DSHM', `AGC 元数据 ${f} 的 appName 是DSHM（当前：${j.appName}）`);
      const desc = typeof j.appDesc === 'string' ? j.appDesc : '';
      ok(!desc.startsWith('鲸鸿'), `AGC 元数据 ${f} 的简介不以已弃用的旧品牌名「鲸鸿」自称`);
    }
  }

  /*
   * 【两个模块的 OSS 声明都必须存在、且核心版本与配方一致】（docs/328 复核发现的真问题）
   *
   * `gen-oss-notices.mjs` 曾把输出目录**硬编码成只有 entry** ⇒ phone 那份永远停在
   * 生成它的那一天，而 `--check` 也只校验 entry。实测 phone 那时仍是 `+dshm.97`、
   * 还列着已被剥离的 `@deepseek-ai/dshm-meeting-ai` —— 而它**会随 phone HAP 上架**。
   *
   * 这里钉三件事：① 两份都在；② 两份的 coreVersion 都等于配方；③ 两份的组件集合一致
   * （模板相同，内容不该分叉）。
   */
  {
    const wantCore = JSON.parse(read('hostcore/core-recipe.json')).coreVersion;
    const ossOf = {};
    for (const mod of ['entry', 'phone']) {
      const rel = `${mod}/src/main/resources/rawfile/licenses/OSS-NOTICES.json`;
      /*
       * 本门禁的 read() 按 cwd 相对路径读（全文件同一惯例），没有 ROOT/join。
       * ⚠️ `ok()` **不返回值**（只累加 pass/fail），所以这里**不能**写 `if (!ok(...)) continue`
       * —— 那会让判断恒真、整段被静默跳过（第一版就是这么写的，负向对照当场发现"应红没红"）。
       */
      const present = existsSync(rel);
      ok(present, `${mod} 有 OSS-NOTICES.json（随 HAP 上架）`);
      if (!present) continue;
      try {
        ossOf[mod] = JSON.parse(read(rel));
      } catch (e) {
        ok(false, `${mod} 的 OSS-NOTICES.json 可解析（${e.message}）`);
      }
    }
    for (const [mod, oss] of Object.entries(ossOf)) {
      ok(oss.coreVersion === wantCore,
        `${mod} 的 OSS 声明核心版本与配方一致（${oss.coreVersion} vs ${wantCore}）`);
      ok(!JSON.stringify(oss).includes('dshm-meeting-ai'),
        `${mod} 的 OSS 声明不含已剥离的会议插件`);
    }
    if (ossOf.entry !== undefined && ossOf.phone !== undefined) {
      const keys = ['upstream', 'npm', 'ohpm', 'runtimes', 'nativeLibs', 'copyleft'];
      const same = keys.every((k) => JSON.stringify(ossOf.entry[k] ?? null) === JSON.stringify(ossOf.phone[k] ?? null));
      ok(same, 'entry 与 phone 的 OSS 组件集合一致（同一份模板，不该分叉）');
    }
  }

  for (const rel of VISIBLE_STRING_FILES) {
    const src = read(rel);
    ok(!/DeepSeek\s+Harness/i.test(src), `${rel} 不含 DeepSeek Harness 用户文案`);
  }

  ok(!existsSync('entry/src/main/resources/base/media/fish_logo.svg'), 'entry 源资源已移除鲸鱼 SVG');
  ok(!existsSync('phone/src/main/resources/base/media/fish_logo.svg'), 'phone 源资源已移除鲸鱼 SVG');

  ok(sha('AppScope/resources/base/media/background.png')
    === sha('entry/src/main/resources/base/media/background.png')
    && sha('entry/src/main/resources/base/media/background.png')
    === sha('phone/src/main/resources/base/media/background.png'), '三处应用图标背景逐字节一致');
  ok(sha('AppScope/resources/base/media/foreground.png')
    === sha('entry/src/main/resources/base/media/foreground.png')
    && sha('entry/src/main/resources/base/media/foreground.png')
    === sha('phone/src/main/resources/base/media/foreground.png'), '三处应用图标前景逐字节一致');
  ok(sha('entry/src/main/resources/base/media/logo_dark.png')
    === sha('phone/src/main/resources/base/media/logo_dark.png'), 'entry / phone 启动标识一致');
  ok(sha('entry/src/main/resources/base/media/startIcon.png')
    === sha('phone/src/main/resources/base/media/startIcon.png'), 'entry / phone 快捷方式图标一致');
  ok(sha('entry/src/main/resources/rawfile/common/dshm_agent_icon.png')
    === sha('phone/src/main/resources/rawfile/common/dshm_agent_icon.png'), 'entry / phone Agent 图标一致');

  const entryNotice = read(FILES.entryNotice);
  const phoneNotice = read(FILES.phoneNotice);
  const rootNotice = read(FILES.rootNotice);
  ok(entryNotice === phoneNotice, 'entry / phone 随包许可声明逐字一致');
  for (const [label, text] of [['root', rootNotice], ['entry', entryNotice], ['phone', phoneNotice]]) {
    ok(text.includes('Copyright (c) 2026 DeepSeek'), `${label} 声明保留 DeepSeek Harness 上游版权`);
    ok(text.includes('Copyright (c) 2026 sol'), `${label} 声明保留 DSHM 修改版权`);
    ok(text.includes('MIT License'), `${label} 声明包含 MIT License`);
    ok(text.includes('not affiliated') || text.includes('不存在隶属'),
      `${label} 声明明确 DSHM 与 DeepSeek 无隶属关系`);
    ok(text.includes('trademark') || text.includes('商标') || text.includes('marks'),
      `${label} 声明区分版权与商标`);
  }

  return { pass, fail, notes };
}

function selfTest() {
  const mutations = [
    ['删掉 fishHitbox 隐藏规则', (s) => s.replace("\n      + 'html[data-dshm-brand=\"dshm\"] [class*=\"_fishHitbox\"],'", '')],
    [`删掉 ${BRAND_NAME} 名称`, (s) => s.replace(`content:\"${BRAND_NAME}\"`, 'content:\"\"')],
    ['改错文档标题替换', (s) => s.replace('.replace(/DeepSeek Harness/gi,', '.replace(/NO_MATCH/g,')],
  ];
  let pass = 0;
  for (const [name, mutate] of mutations) {
    const base = read(FILES.brand);
    const changed = mutate(base);
    if (changed === base) {
      console.log('  FAIL  self-test 变异未生效：' + name);
      continue;
    }
    const fake = changed;
    const executed = (() => {
      try {
        const shim = runShim(extractShim(fake));
        const css = shim.style?.textContent ?? '';
        if (name.includes('fishHitbox')) return !css.includes('_fishHitbox');
        if (name.includes('名称')) return !css.includes(`content:"${BRAND_NAME}"`);
        return shim.doc.title !== BRAND_NAME;
      } catch {
        return true;
      }
    })();
    if (executed) {
      pass += 1;
      console.log('  PASS  mutation detected: ' + name);
    } else {
      console.log('  FAIL  mutation survived: ' + name);
    }
  }
  if (pass !== mutations.length) process.exit(2);
}

if (process.argv.includes('--self-test')) selfTest();

const result = testSources();
console.log('# 门禁：DSHM 独立品牌面 + MIT/第三方声明');
for (const line of result.notes) console.log(line);
if (result.fail > 0) {
  console.error(`\n❌ 品牌面门禁失败：${result.pass} passed, ${result.fail} failed`);
  process.exit(1);
}
console.log(`\n✅ 通过：${result.pass} 项断言全过`);
