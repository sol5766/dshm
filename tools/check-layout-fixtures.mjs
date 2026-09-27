/**
 * 布局 fixture 门禁（P1）：把「形态/几何决策」变成**无需设备**就能验证的东西。
 *
 * 存在理由：
 *   计划 §16 要求「即使没有设备，也必须测试 width / height / orientation / input mode」，
 *   §17 要求把「布局分支」与「state → UI 映射」当作可自动化的验收对象。
 *   而 `entry`（UI 层）在本环境**没有编译验证**（原生构建被 node-headers/libnode 阻塞），
 *   真机也没有 —— 于是「布局决策对不对」这件事在重构中极易静默劣化。
 *
 * 做法（关键点）：
 *   `appstate/src/main/ets/ui/LayoutController.ets` 是**纯 TypeScript**（不含 ArkUI 装饰器与 DSL），
 *   所以可以把它连同依赖（`Tokens.ets` / `Breakpoints.ets`）按 `.ts` 编译并**在本机直接执行**——
 *   被测的是**同一个源文件**，不是复制品（复制一份来测等于测了个假东西）。
 *   编译器用 CLT 自带的 tsc（`<CLT>/codelinter/node_modules/typescript/bin/tsc`）。
 *
 * 四套形态 fixture（计划 §16）+ 断点边界 + 让步链三分支：
 *   PHONE / PHONE-LANDSCAPE / TABLET-PORTRAIT / TABLET-LANDSCAPE / DESKTOP / TWO-IN-ONE（拖窄两种）
 *
 * 退出码：0 通过；1 断言失败；3 **环境受阻**（找不到 tsc）——
 *   沿用本项目既有约定（无设备时 exit 3 且不建产物），**不把"没跑成"说成"通过"**。
 *
 * 用法：
 *   node tools/check-layout-fixtures.mjs              # 跑全部 fixture
 *   node tools/check-layout-fixtures.mjs --self-test  # 注入式自检：证明断言真的会失败
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = process.cwd();
const WORK = join(ROOT, 'dist', 'layout-fixtures');
const SRC = join(WORK, 'src');
const OUT = join(WORK, 'out');

/** 纯逻辑源文件（不依赖 ArkUI DSL，故可当 TS 编译并执行） */
const PURE_FILES = [
  'appstate/src/main/ets/ui/ShellTracks.ets',
  'appstate/src/main/ets/ui/Tokens.ets',
  'appstate/src/main/ets/ui/Breakpoints.ets',
  'appstate/src/main/ets/ui/LayoutController.ets',
  'appstate/src/main/ets/ui/NavigationController.ets',
  // 回合模型（§8）：纯逻辑，可在本机直接执行
  'appstate/src/main/ets/model/Trajectory.ets',
  'appstate/src/main/ets/model/Turns.ets',
  'appstate/src/main/ets/model/Search.ets',
  'appstate/src/main/ets/model/Markdown.ets',
  // 设置域判定（P4-6）：零依赖，故可以被本 fixture 直接执行
  'appstate/src/main/ets/model/SettingsDomains.ets',
  // 会话头上下文行（P2-7）：零依赖，故可以被本 fixture 直接执行
  'appstate/src/main/ets/model/SessionContext.ets',
  // 浮层回执归属（P2-8，E353）：零依赖
  'appstate/src/main/ets/model/Sheets.ets',
  // 设置编辑浮层的输入提示（P2-10）：零依赖
  'appstate/src/main/ets/model/SettingEditors.ets',
  // pi-ai 路由的纯逻辑（对齐官方 Models 页：逐字段编辑 + 自定义模型 API 创建表单）。
  // 零依赖，可被本门禁直接执行 —— 见文件头"为什么是独立文件"。
  'appstate/src/main/ets/model/PiAiProviders.ets',
  // Web 权限裁决的纯逻辑。抽出来是为了让"回环来源 + 只要麦克风"这条判断
  // 受门禁覆盖 —— 2026-09-26 真机暴露的 bug（getOrigin() 带结尾斜杠导致
  // 本应用自己的麦克风请求被 DENY）正是因为原逻辑内联在 @Component 里、
  // 没有任何断言盯着。见该文件头注释。
  'appstate/src/main/ets/model/WebPermission.ets',
  // 语音音频换算（路线 A：HMS 系统语音识别）。HMS 对音频有硬约束
  // （只收 16000 Hz、`writeAudio` 只收 640/1280 字节），而真机麦克风是 48000 Hz
  // —— 换算错了在真机上只表现为"识别没结果"，很贵。所以抽成纯函数受门禁覆盖。
  'appstate/src/main/ets/model/SpeechPcm.ets',
  // 核心页投影（P5-1）：依赖 Core.ets，两者一起执行
  'appstate/src/main/ets/model/Core.ets',
  'appstate/src/main/ets/model/CoreProjection.ets',
  'appstate/src/main/ets/model/PanelRegistry.ets',
  'appstate/src/main/ets/model/NavigationState.ets',
  'appstate/src/main/ets/model/Follow.ets',
  'appstate/src/main/ets/model/InputPolicy.ets',
  'appstate/src/main/ets/model/ToolPresentation.ets',
  'appstate/src/main/ets/model/ToolDiff.ets',
  'appstate/src/main/ets/model/InputFacts.ets',
  'appstate/src/main/ets/model/Timeline.ets',
  'appstate/src/main/ets/model/Jobs.ets',
  'dshcompat/src/main/ets/RemoteEvents.ets',
  'dshcompat/src/main/ets/EventShape.ets',
  'appstate/src/main/ets/model/Present.ets'
];

/** ArkUI 全局的声明补丁：Tokens.ets 用它取系统资源色/符号 */
const GLOBALS_DTS = `
declare function $r(value: string): Resource;
declare type Resource = object;
`;

/** 找 tsc：CLT 自带 typescript，其次看 PATH */
function findTsc() {
  const candidates = [];
  const clt = process.env.DEVECO_CLI_CLT_PATH;
  if (clt) candidates.push(join(clt, 'codelinter', 'node_modules', 'typescript', 'bin', 'tsc'));
  candidates.push('/home/node/deveco-clt/command-line-tools/codelinter/node_modules/typescript/bin/tsc');
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** 把 .ets 复制成 .ts 并编译，返回可 require 的模块 */
function buildAndLoad() {
  const tsc = findTsc();
  if (!tsc) {
    console.error('环境受阻：找不到 tsc（DevEco CLT 自带的 typescript）。');
    console.error('  设置 DEVECO_CLI_CLT_PATH 指向 Command Line Tools 安装目录后重跑。');
    console.error('  ⚠️ 这是"没跑成"，不是"通过"——退出码 3。');
    process.exit(3);
  }

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(SRC, { recursive: true });
  const tsFiles = [];
  for (const rel of PURE_FILES) {
    const from = join(ROOT, rel);
    if (!existsSync(from)) {
      console.error(`缺文件：${rel}`);
      process.exit(2);
    }
    const to = join(SRC, rel.split('/').pop().replace(/\.ets$/, '.ts'));
    cpSync(from, to);
    tsFiles.push(to);
  }
  const globals = join(SRC, 'globals.d.ts');
  writeFileSync(globals, GLOBALS_DTS, 'utf8');

  try {
    execFileSync(process.execPath, [
      tsc,
      '--target', 'ES2020',
      '--module', 'commonjs',
      '--outDir', OUT,
      '--skipLibCheck',
      '--strict', 'false',
      ...tsFiles,
      globals
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`.toString();
    console.error('tsc 编译纯逻辑源文件失败——说明 LayoutController/Tokens/Breakpoints 不是合法 TS：');
    console.error(out.trim() || '(无输出)');
    process.exit(1);
  }

  // 运行时垫片：`Tokens.ets` 在**模块顶层**就调 ArkUI 全局 `$r(...)` 取系统资源，
  // 而 Node 里没有这个全局（实测：直接 require 会 `ReferenceError: $r is not defined`）。
  // 决策逻辑本身与它无关，故给一个恒等垫片即可——注意这是"让纯逻辑跑起来"，
  // 不是"假装 ArkUI 环境"：本文件只断言几何/档位，不碰颜色与资源。
  const bootstrap = join(OUT, '__bootstrap.cjs');
  writeFileSync(bootstrap,
    "'use strict';\n"
    + 'globalThis.$r = (value) => value;\n'
    + "module.exports = require('./LayoutController.js');\n", 'utf8');

  // bootstrap 先装 `$r` 垫片，再转出 LayoutController。
  // 返回 **require 函数**：本文件现在要加载两个模块（布局 + 导航），都从同一个 OUT 目录取。
  const req = createRequire(bootstrap);
  req(bootstrap);   // 触发垫片安装
  return req;
}

/** 断言器：收集失败而不是首错即停（一次看清全部差异） */
function makeAsserter(selfTest) {
  const failures = [];
  let checked = 0;
  return {
    eq(label, actual, expected) {
      checked++;
      const ok = JSON.stringify(actual) === JSON.stringify(expected);
      if (!ok) failures.push(`  ✗ ${label}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`);
    },
    ok(label, cond) {
      checked++;
      if (!cond) failures.push(`  ✗ ${label}`);
    },
    done() {
      // 自检模式：故意制造一条失败，验证"断言真的会失败、且退出码会变"
      if (selfTest) {
        checked++;
        failures.push('  ✗ [self-test] 注入的必然失败断言');
      }
      console.log(`\n断言 ${checked} 条，失败 ${failures.length} 条。`);
      if (failures.length === 0) {
        console.log('✅ 四形态 fixture 与边界全部符合预期。');
        process.exit(0);
      }
      for (const f of failures) console.log(f);
      console.log(selfTest
        ? '\n✅ 自检通过：注入的失败被如实报出（断言器有效）。'
        : '\n❌ 失败：布局决策与 fixture 期望不符（或本文件是重构中的临时状态）。');
      // 自检模式下"有失败"正是期望结果
      process.exit(selfTest ? 0 : 1);
    }
  };
}

const selfTest = process.argv.includes('--self-test');
const require2 = buildAndLoad();
const LC = require2('./LayoutController.js');

const { decideLayout, decideLayoutWithDetail, concedeDetail, navWidthOf, ConcessionStep, MAIN_MIN_VP } = LC;
const NC = require2('./NavigationController.js');
const TM = require2('./Turns.js');
const FM = require2('./Follow.js');
const IP = require2('./InputPolicy.js');
const TP = require2('./ToolPresentation.js');
const TD = require2('./ToolDiff.js');
const IF = require2('./InputFacts.js');
const TL = require2('./Timeline.js');
const JB = require2('./Jobs.js');
const TJ = require2('./Trajectory.js');
const RE = require2('./RemoteEvents.js');
const SE = require2('./Search.js');
const PR = require2('./PanelRegistry.js');
const ST = require2('./ShellTracks.js');
const NS = require2('./NavigationState.js');
const MD = require2('./Markdown.js');
const SD = require2('./SettingsDomains.js');
const SC = require2('./SessionContext.js');
const SH = require2('./Sheets.js');
const SE2 = require2('./SettingEditors.js');
const PA = require2('./PiAiProviders.js');
const WP = require2('./WebPermission.js');
const SP = require2('./SpeechPcm.js');
const CP = require2('./CoreProjection.js');
const t = makeAsserter(selfTest);

console.log('# 布局 fixture 门禁（四形态 + 断点边界 + 让步链）\n');
console.log(`编译：${PURE_FILES.length} 个纯逻辑源文件 → ${OUT.replace(`${ROOT}/`, '')}`);
console.log(`主区最小宽度 MAIN_MIN_VP = ${MAIN_MIN_VP}\n`);

/** 便捷构造 */
const input = (widthVp, heightVp, hasKeyboard = false, hasPointer = false) =>
  ({ widthVp, heightVp, hasKeyboard, hasPointer });

/**
 * 四套形态 fixture（计划 §16）。
 * 期望值是**当前实现的行为**（本轮是重构，不改行为）；凡是"行为是否合理"存疑的，
 * 单独在下面标注为待决，而不是悄悄把期望值写成我们想要的样子。
 */
const FIXTURES = [
  {
    name: 'PHONE 竖屏 360×800',
    in: input(360, 800),
    want: {
      mode: 'single', nav: 'bottom', navWidthVp: 0, navLabels: false,
      detailAvailable: false, detailWidthVp: 0, detailPresentation: 'overlay',
      detailStep: 'none', landscape: false, pointerRich: false
    }
  },
  {
    name: 'PHONE 横屏 800×360（宽 800 ≥ 600 ⇒ 落双栏）',
    in: input(800, 360),
    want: {
      mode: 'double', nav: 'rail', navWidthVp: 56, navLabels: false,
      detailAvailable: false, detailWidthVp: 0, detailPresentation: 'side-panel',
      detailStep: 'none', landscape: true, pointerRich: false
    },
    note: '⚠️ 待决：D3 §2 的口径是"只看宽度"，于是**手机横屏会变成双栏**。'
      + '这是"按宽度决策"的直接后果，不是 bug；但要不要为手机横屏加一条高度/方向子句，需真机看效果后定。'
  },
  {
    name: 'TABLET 竖屏 800×1280',
    in: input(800, 1280),
    want: {
      mode: 'double', nav: 'rail', navWidthVp: 56, navLabels: false,
      detailAvailable: false, detailWidthVp: 0, detailPresentation: 'side-panel',
      detailStep: 'none', landscape: false, pointerRich: false
    }
  },
  {
    name: 'TABLET 横屏 1280×800',
    in: input(1280, 800),
    want: {
      mode: 'triple', nav: 'panel', navWidthVp: 240, navLabels: true,
      detailAvailable: true, detailWidthVp: 320, detailPresentation: 'column',
      detailStep: 'none', landscape: true, pointerRich: false
    }
  },
  {
    name: 'DESKTOP/2in1 全屏 1920×1080（键鼠齐备）',
    in: input(1920, 1080, true, true),
    want: {
      mode: 'triple', nav: 'panel', navWidthVp: 240, navLabels: true,
      detailAvailable: true, detailWidthVp: 320, detailPresentation: 'column',
      detailStep: 'none', landscape: true, pointerRich: true
    }
  },
  {
    name: '2in1 自由窗被拖窄 700×900（应与平板竖屏同构，不重启页面）',
    in: input(700, 900, true, true),
    want: {
      mode: 'double', nav: 'rail', navWidthVp: 56, navLabels: false,
      detailAvailable: false, detailWidthVp: 0, detailPresentation: 'side-panel',
      detailStep: 'none', landscape: false, pointerRich: true
    }
  },
  {
    name: '2in1 自由窗拖到手机宽度 480×800',
    in: input(480, 800, true, true),
    want: {
      mode: 'single', nav: 'bottom', navWidthVp: 0, navLabels: false,
      detailAvailable: false, detailWidthVp: 0, detailPresentation: 'overlay',
      detailStep: 'none', landscape: false, pointerRich: true
    }
  }
];

console.log('## 四形态 fixture');
for (const f of FIXTURES) {
  const got = decideLayout(f.in);
  t.eq(f.name, got, f.want);
  console.log(`  ${JSON.stringify(got) === JSON.stringify(f.want) ? 'ok  ' : 'FAIL'}  ${f.name}`
    + `  → ${got.mode}/${got.nav}/detail=${got.detailAvailable ? got.detailWidthVp : '—'}`);
  if (f.note) console.log(`        ${f.note}`);
}

console.log('\n## 断点边界（599/600/839/840）');
const BOUNDARIES = [
  { w: 599, mode: 'single', nav: 'bottom' },
  { w: 600, mode: 'double', nav: 'rail' },
  { w: 839, mode: 'double', nav: 'rail' },
  { w: 840, mode: 'triple', nav: 'panel' }
];
for (const b of BOUNDARIES) {
  const got = decideLayout(input(b.w, 900));
  t.eq(`宽 ${b.w}vp → 档位`, got.mode, b.mode);
  t.eq(`宽 ${b.w}vp → 导航`, got.nav, b.nav);
  console.log(`  ok    宽 ${b.w}vp → ${got.mode} / ${got.nav}`);
}

console.log('\n## 840vp 处详情栏必须是默认宽度（不得因下限收紧而收窄）');
{
  // 这条守的是"重构不改行为"：MAIN_MIN_VP 若被拍成更大的值，840vp 下详情栏会突然收窄甚至关闭
  const got = decideLayout(input(840, 900));
  t.eq('840vp 详情宽度', got.detailWidthVp, 320);
  t.eq('840vp 让步步骤', got.detailStep, 'none');
  console.log(`  ok    840vp → 详情 ${got.detailWidthVp}vp（${got.detailStep}）`);
}

console.log('\n## 让步链三分支（D3 §2.1：收窄 → 关闭）');
{
  const none = concedeDetail(1280, 240, 320);
  t.eq('放得下 → NONE/320', none, { widthVp: 320, step: 'none' });
  const narrow = concedeDetail(840, 240, 400);
  t.eq('放不下期望值 → NARROW/260', narrow, { widthVp: 260, step: 'detail-narrow' });
  const tooSmall = concedeDetail(840, 240, 100);
  t.eq('低于最小值 → NARROW/260', tooSmall, { widthVp: 260, step: 'detail-narrow' });
  const closed = concedeDetail(500, 240, 320);
  t.eq('连最小值都放不下 → CLOSED/0', closed, { widthVp: 0, step: 'detail-closed' });
  console.log(`  ok    NONE / NARROW / CLOSED 三个分支都被直接断言（含当前断点下不可达的 CLOSED）`);
}

console.log('\n## 未来的拖拽调宽路径（P2）：decideLayoutWithDetail');
{
  const wide = decideLayoutWithDetail(input(1280, 800), 400);
  t.eq('1280vp 想要 400 → 得 400', wide.detailWidthVp, 400);
  t.eq('1280vp 想要 400 → NONE', wide.detailStep, 'none');
  const tight = decideLayoutWithDetail(input(840, 800), 400);
  t.eq('840vp 想要 400 → 收窄到 260', tight.detailWidthVp, 260);
  t.eq('840vp 想要 400 → NARROW', tight.detailStep, 'detail-narrow');
  console.log('  ok    同一决策函数同时服务"默认宽度"与"用户拖拽宽度"');
}

console.log('\n## 导航宽度映射');
{
  t.eq('PANEL → 240', navWidthOf('panel'), 240);
  t.eq('RAIL → 56', navWidthOf('rail'), 56);
  t.eq('BOTTOM_TABS → 0（不占侧边）', navWidthOf('bottom'), 0);
  console.log('  ok    panel/rail/bottom 三档映射');
}

console.log('\n## 导航：返回键的优先级阶梯（迁移前写在 Index.onBackPress 里）');
{
  const { decideBack, BackAction, StackPage, selectTab, normalizeTab, showsConversation, navTabs } = NC;
  // 【坑】`NavTab.SESSIONS` 是 `'workspaces'` 的**别名**（E108：会话并入工作区），
  // 所以"在会话页签"与"在工作区页签"是同一个状态；默认值必须写 'workspaces'。
  const nav = (o) => Object.assign({ tab: 'workspaces', stackPage: StackPage.MAIN, wsDrill: 0, hasSession: true, detailOpen: false, drawerOpen: false }, o);
  const ov = (o) => Object.assign({ credentialOpen: false, settingDraftOpen: false, searchOpen: false, choosingOpen: false, detailOverlayOpen: false, previewOpen: false }, o);

  // 优先级：浮层之间也有先后（凭据 → 设置草稿 → 搜索 → 选择）
  // P1-5：手机抽屉是盖在整页上的导航面 ⇒ 比所有浮层都靠上
  t.eq('抽屉打开时，返回先收抽屉（哪怕有浮层）',
    decideBack(nav({ drawerOpen: true }), ov({ credentialOpen: true, searchOpen: true })), BackAction.CLOSE_DRAWER);
  t.eq('抽屉打开且有二级页 ⇒ 仍先收抽屉',
    decideBack(nav({ drawerOpen: true, stackPage: StackPage.DIAGNOSTICS }), ov({})), BackAction.CLOSE_DRAWER);
  t.eq('抽屉关着 ⇒ 回到原来的阶梯（关凭据浮层）',
    decideBack(nav({ drawerOpen: false }), ov({ credentialOpen: true })), BackAction.CLOSE_CREDENTIAL);
  t.eq('全开时先关凭据浮层', decideBack(nav({}), ov({ credentialOpen: true, settingDraftOpen: true, searchOpen: true, choosingOpen: true, previewOpen: true })), BackAction.CLOSE_CREDENTIAL);
  t.eq('无凭据时关设置草稿', decideBack(nav({}), ov({ settingDraftOpen: true, searchOpen: true })), BackAction.CLOSE_SETTING_DRAFT);
  t.eq('再关搜索', decideBack(nav({}), ov({ searchOpen: true, choosingOpen: true })), BackAction.CLOSE_SEARCH);
  t.eq('再关选择浮层', decideBack(nav({}), ov({ choosingOpen: true, previewOpen: true })), BackAction.CLOSE_CHOICE);
  // 浮层优先于二级页
  t.eq('浮层优先于二级页', decideBack(nav({ stackPage: StackPage.DIAGNOSTICS }), ov({ searchOpen: true })), BackAction.CLOSE_SEARCH);
  // 详情半模态（P1.5）：它盖在页面上，但排在真正的模态编辑态之后
  t.eq('详情浮层排在其它浮层之后', decideBack(nav({}), ov({ searchOpen: true, detailOverlayOpen: true })), BackAction.CLOSE_SEARCH);
  t.eq('详情浮层优先于二级页', decideBack(nav({ stackPage: StackPage.DIAGNOSTICS }), ov({ detailOverlayOpen: true })), BackAction.CLOSE_DETAIL_OVERLAY);
  t.eq('详情浮层优先于详情栏', decideBack(nav({ detailOpen: true }), ov({ detailOverlayOpen: true })), BackAction.CLOSE_DETAIL_OVERLAY);
  t.eq('详情浮层优先于工作区下钻', decideBack(nav({ tab: 'workspaces', wsDrill: 3 }), ov({ detailOverlayOpen: true })), BackAction.CLOSE_DETAIL_OVERLAY);
  // 二级页
  t.eq('二级页回主列表', decideBack(nav({ stackPage: StackPage.CONVERSATION }), ov({})), BackAction.STACK_TO_MAIN);
  // 详情
  t.eq('关详情抽屉', decideBack(nav({ detailOpen: true }), ov({})), BackAction.CLOSE_DETAIL);
  // 工作区下钻（仅工作区页签）
  t.eq('工作区下钻退一层', decideBack(nav({ tab: 'workspaces', wsDrill: 2 }), ov({})), BackAction.DRILL_UP);
  t.eq('非工作区页签不消耗下钻（留给后面的规则）', decideBack(nav({ tab: 'settings', wsDrill: 2 }), ov({})), BackAction.TAB_TO_SESSIONS);
  // 文件预览在工作区页签且未下钻时才轮到
  t.eq('关文件预览', decideBack(nav({ tab: 'workspaces', wsDrill: 0 }), ov({ previewOpen: true })), BackAction.CLOSE_PREVIEW);
  // 回首页签
  t.eq('不在首页签则回会话', decideBack(nav({ tab: 'settings' }), ov({})), BackAction.TAB_TO_SESSIONS);
  // 根层交给系统（**必须**是 EXIT，否则就是"按返回没反应"的假入口）
  t.eq('根层交给系统（不消费）', decideBack(nav({}), ov({})), BackAction.EXIT);
  console.log('  ok    返回键阶梯的每一级 + 浮层内部先后 + 详情半模态的位置，都被断言');

  // 页签归一化（E108/E110 的别名）
  t.eq('待决 → 工作区', normalizeTab('pending'), 'workspaces');
  t.eq('核心 → 设置', normalizeTab('core'), 'settings');
  t.eq('设置保持设置', normalizeTab('settings'), 'settings');

  // 点页签：清栈 + 清会话选择 + 重读静态事实
  const toSettings = selectTab(nav({ tab: 'workspaces', stackPage: StackPage.DIAGNOSTICS, wsDrill: 3, hasSession: true }), 'settings');
  t.eq('点设置：清栈', toSettings.stackPage, 'main');
  t.eq('点设置：清下钻', toSettings.wsDrill, 0);
  t.eq('点设置：清会话选择', toSettings.clearSession, true);
  t.eq('点设置：重读静态事实', toSettings.refreshStaticFacts, true);
  const toWs = selectTab(nav({ tab: 'settings' }), 'workspaces');
  t.eq('点工作区：保留会话选择', toWs.clearSession, false);
  t.eq('点工作区：不重读静态事实', toWs.refreshStaticFacts, false);
  t.eq('点待决别名 → 工作区', selectTab(nav({}), 'pending').tab, 'workspaces');

  // 详情栏并排的前提
  t.eq('看会话中：showsConversation 真', showsConversation(nav({ hasSession: true })), true);
  t.eq('无会话：假', showsConversation(nav({ hasSession: false })), false);
  t.eq('在设置页：假', showsConversation(nav({ hasSession: true, tab: 'settings' })), false);
  t.eq('一级页签顺序', navTabs(), ['workspaces', 'settings']);
  console.log('  ok    页签归一化 / 清栈 / 静态事实重读 / 会话可见性 全部断言');
}

console.log('\n## 回合模型（§8：Turn → ProcessGroup + Answer）');
{
  const { groupTurns, hasProcessGroup, chatVisibleItems, processSummary, defaultExpanded } = TM;
  const { makeItem, TrajectoryKind, Speaker } = TJ;

  // 造一个回合：user → (reasoning, tool) → assistant
  const mk = (id, kind, speaker, extra) => {
    const it = makeItem(id, kind, 0);
    it.speaker = speaker;
    if (extra) Object.assign(it, extra);
    return it;
  };
  const u1 = mk('u1', TrajectoryKind.MESSAGE, Speaker.USER);
  const r1 = mk('r1', TrajectoryKind.REASONING, Speaker.ASSISTANT);
  const t1 = mk('t1', TrajectoryKind.TOOL, Speaker.ASSISTANT);
  const a1 = mk('a1', TrajectoryKind.MESSAGE, Speaker.ASSISTANT);
  const u2 = mk('u2', TrajectoryKind.MESSAGE, Speaker.USER);
  const a2 = mk('a2', TrajectoryKind.MESSAGE, Speaker.ASSISTANT);
  const err = mk('e1', TrajectoryKind.ERROR, Speaker.SYSTEM);

  const turns = groupTurns([u1, r1, t1, a1, u2, a2, err], true);
  t.eq('回合数 = 用户消息数', turns.length, 2);
  t.eq('第 1 回合的过程条目数（思考+工具）', turns[0].process.length, 2);
  t.eq('第 1 回合的回答是最后一条助手消息', turns[0].answer.id, 'a1');
  t.eq('第 1 回合不再进行（后面还有回合）', turns[0].running, false);
  t.eq('最后回合进行中（会话在跑）', turns[1].running, true);
  t.eq('错误进 notices 而不是 process', turns[1].notices.length, 1);
  t.eq('过程分组存在', hasProcessGroup(turns[0]), true);
  t.eq('过程分组摘要按类型计数', processSummary(turns[0]), '思考 1 · 工具 1');
  t.eq('进行中的回合默认展开', defaultExpanded(turns[1], false), true);
  t.eq('已完成的回合默认折叠', defaultExpanded(turns[0], false), false);
  t.eq('用户手动展开后优先', defaultExpanded(turns[0], true), true);

  // 空过程 ⇒ 不建分组（§8「tool-only 空节点不显示」）
  t.eq('没有过程条目时不建分组', hasProcessGroup(turns[1]), false);

  // 对话视图的可见集合：用户消息 + 回答 + notices（**错误要留**），不含工具/思考。
  //
  // 【这里曾经自相矛盾】注释写着"错误要留"，期望值却把 `e1` 漏掉了——因为旧判据是
  // "speaker 不是 SYSTEM 就显示"，而这条错误条的 speaker 恰好是 SYSTEM，
  // 于是被静默丢掉。**断言的旧期望把 bug 固化了下来**（P0-1 修判据时才发现）。
  // 新判据按结构与来源判定：ERROR 永远进 notices ⇒ 可见。
  const chat = chatVisibleItems(turns).map((i) => i.id);
  t.eq('对话视图可见集合（含错误）', chat, ['u1', 'a1', 'u2', 'a2', 'e1']);

  // 首条用户消息之前的内容单独成回合
  const pre = groupTurns([err, u1, a1], false);
  t.eq('前置条目单独成回合', pre.length, 2);
  t.eq('前置回合没有 user', pre[0].user === undefined, true);
  t.eq('前置回合保留错误（notices）', pre[0].notices.length, 1);

  // 流式中的回合即使中枢说停了也不该折叠
  const streaming = mk('a3', TrajectoryKind.MESSAGE, Speaker.ASSISTANT, { streaming: true });
  const st = groupTurns([u1, streaming], false);
  t.eq('流式输出中的回合视为进行中', st[0].running, true);
  console.log('  ok    分组边界 / 过程与回答归类 / notices / 空分组 / 折叠默认态 / 流式，共 15 条断言');
}

console.log('\n## 贴底跟随模型（§8：sticky-follow 独立管理）');
{
  const { nextFollowing, followTimerShouldRun, shouldJumpOnNewItems, FollowSignal } = FM;
  t.eq('滚到/停在底部 → 跟随', nextFollowing(false, FollowSignal.AT_BOTTOM), true);
  t.eq('上翻离开底部 → 不跟随', nextFollowing(true, FollowSignal.SCROLLED_AWAY), false);
  // 下面两条是本次修的**真实缺陷**：此前几何判断顺带管意图，导致切会话/发消息不恢复跟随
  t.eq('切会话 → 恢复跟随（此前缺陷：新会话停在中间）', nextFollowing(false, FollowSignal.SESSION_CHANGED), true);
  t.eq('发消息 → 恢复跟随（此前缺陷：回答出现在看不到的地方）', nextFollowing(false, FollowSignal.USER_SENT), true);
  t.eq('跟随中 + 会话在跑 → 定时贴底跑', followTimerShouldRun(true, true), true);
  t.eq('跟随中但已停止 → 不跑', followTimerShouldRun(true, false), false);
  t.eq('未跟随（用户在看历史）→ 绝不抢滚动条', followTimerShouldRun(false, true), false);
  t.eq('新条目：跟随中才跳到底', shouldJumpOnNewItems(true), true);
  t.eq('新条目：不跟随时不把用户拽走', shouldJumpOnNewItems(false), false);
  console.log('  ok    9 条断言：三处几何 + 两条**意图信号**（切会话/发消息）+ 定时器与跳底判据');
}

console.log('\n## 输入模态策略（触控 / 鼠标 / 键盘同一套语义）');
{
  const { contextMenuGestures, hoverEnabled, contextMenuHintLabel, MenuGesture } = IP;
  const touch = { hasKeyboard: false, hasPointer: false };
  const desktop = { hasKeyboard: true, hasPointer: true };
  t.eq('纯触控：长按必须可用（否则手机没有上下文菜单）', contextMenuGestures(touch), ['long-press']);
  t.eq('有指针：长按 + 右键', contextMenuGestures(desktop), ['long-press', 'right-click']);
  t.eq('纯触控：无悬停', hoverEnabled(touch), false);
  t.eq('有指针：启用悬停', hoverEnabled(desktop), true);
  t.eq('提示文案随模态变（纯触控）', contextMenuHintLabel(touch), '长按');
  t.eq('提示文案随模态变（有指针）', contextMenuHintLabel(desktop), '长按或右键');
  console.log('  ok    6 条断言：手势集合 / 悬停 / 菜单提示文案，按输入模态分别成立');
}

console.log('\n## 工具呈现（§11：按工具类别区分，而不是一视同仁）');
{
  const { toolKindOf, toolKindLabel, toolToneOf, toolDefaultExpanded, toolSummaryOf, ToolKind } = TP;
  // 用例取自**上游客户端渲染器实际出现的工具名键**（dsh-client-ui-tool/lib/client.js）
  t.eq('bash → 终端', toolKindOf('bash'), ToolKind.TERMINAL);
  t.eq('pwsh → 终端（大小写不敏感）', toolKindOf('Pwsh'), ToolKind.TERMINAL);
  t.eq('read → 读取', toolKindOf('read'), ToolKind.READ);
  t.eq('write → 写入', toolKindOf('write'), ToolKind.WRITE);
  t.eq('str_replace → 编辑', toolKindOf('str_replace'), ToolKind.EDIT);
  t.eq('grep → 搜索', toolKindOf('grep'), ToolKind.SEARCH);
  t.eq('glob → 搜索', toolKindOf('glob'), ToolKind.SEARCH);
  t.eq('web_search → 网络', toolKindOf('web_search'), ToolKind.WEB);
  t.eq('ask_user_question → 提问', toolKindOf('ask_user_question'), ToolKind.ASK);
  t.eq('未识别的名字 → 通用（不硬塞进某类）', toolKindOf('some_future_tool'), ToolKind.GENERIC);
  t.eq('类别中文名', toolKindLabel(ToolKind.TERMINAL), '终端');
  t.eq('运行中 → running 语气', toolToneOf(ToolKind.TERMINAL, 'running'), 'running');
  t.eq('失败 → failed 语气', toolToneOf(ToolKind.READ, 'failed'), 'failed');
  t.eq('被拒 → warning 语气', toolToneOf(ToolKind.WRITE, 'rejected'), 'warning');
  t.eq('失败默认展开（§11 的展开规则）', toolDefaultExpanded('failed'), true);
  t.eq('被拒默认展开', toolDefaultExpanded('rejected'), true);
  t.eq('成功默认折叠（长会话不刷屏）', toolDefaultExpanded('success'), false);
  console.log('  ok    17 条断言：10 个真实工具名归类 + 语气 + 展开规则');

  // 摘要提炼（§11 的 path summary）：要点从参数里挖出来，而不是整段糊上去
  t.eq('终端：取 command', toolSummaryOf(ToolKind.TERMINAL, '{"command":"npm run build"}'), 'npm run build');
  t.eq('终端：忽略其它键', toolSummaryOf(ToolKind.TERMINAL, '{"command":"ls -la","timeout":60000}'), 'ls -la');
  t.eq('读取：取 file_path', toolSummaryOf(ToolKind.READ, '{"file_path":"/a/b.ts"}'), '/a/b.ts');
  t.eq('搜索：模式 + 范围', toolSummaryOf(ToolKind.SEARCH, '{"pattern":"foo","path":"src"}'), 'foo · src');
  t.eq('搜索：无范围时不加分隔符', toolSummaryOf(ToolKind.SEARCH, '{"pattern":"foo"}'), 'foo');
  t.eq('网络：取 url', toolSummaryOf(ToolKind.WEB, '{"url":"https://example.com/a"}'), 'https://example.com/a');
  t.eq('提问：取 question', toolSummaryOf(ToolKind.ASK, '{"question":"选哪一个？"}'), '选哪一个？');
  t.eq('非 JSON 原文：清理成一行', toolSummaryOf(ToolKind.TERMINAL, 'ls -la\n  /tmp'), 'ls -la /tmp');
  t.eq('空参数 → 空摘要', toolSummaryOf(ToolKind.TERMINAL, ''), '');
  const longCmd = '{"command":"' + 'x'.repeat(200) + '"}';
  const sum = toolSummaryOf(ToolKind.TERMINAL, longCmd);
  t.eq('超长截断并加省略号', sum.length, 121);
  t.eq('截断标记在末尾', sum.endsWith('…'), true);
  t.eq('转义引号还原', toolSummaryOf(ToolKind.TERMINAL, '{"command":"echo \\"hi\\""}'), 'echo "hi"');
  console.log('  ok    12 条断言：按类别提炼要点（终端的命令 / 读取的路径 / 搜索的模式+范围 / 网络的 url …）');
}

console.log('\n## 改动对照（§11：编辑类工具出"改了什么"，而不是参数原文）');
{
  const { intendedDiffOf, diffLines, diffStatOf, collapseContext, presentDiff, DiffLineKind } = TD;

  // ── 意图对照：严格对齐官方 intendedDiff 的规则 ──
  const w = intendedDiffOf('write', '{"file_path":"/a/b.ts","content":"line1\\nline2"}');
  t.eq('write → 整文件都是新增（oldText 为 null）', w !== null && w.oldText === null, true);
  t.eq('write 的 newText 取 content', w !== null && w.newText, 'line1\nline2');
  t.eq('write 的 path 取 file_path', w !== null && w.path, '/a/b.ts');

  const e = intendedDiffOf('edit', '{"file_path":"/a/b.ts","old_string":"foo","new_string":"bar"}');
  t.eq('edit → oldText 取 old_string', e !== null && e.oldText, 'foo');
  t.eq('edit → newText 取 new_string', e !== null && e.newText, 'bar');

  // 官方 `oldText || null`：空串归一成 null（纯新增），不是空串
  const eEmpty = intendedDiffOf('edit', '{"file_path":"/a/b.ts","old_string":"","new_string":"bar"}');
  t.eq('edit 空 old_string → 归一成 null（官方 `oldText || null`）', eEmpty !== null && eEmpty.oldText === null, true);

  // 大小写：官方按精确名匹配，我方工具名历史上出现过大小写差异 ⇒ 归一小写
  t.eq('工具名大小写不敏感', intendedDiffOf('EDIT', '{"file_path":"/a","old_string":"x","new_string":"y"}') !== null, true);

  // 拒绝路径（任一条不成立就**整卡不出**，而不是尽力渲染）
  t.eq('不认识的名字 → 不出对照卡', intendedDiffOf('bash', '{"command":"ls","file_path":"/a"}'), null);
  t.eq('非 JSON 参数 → 不出对照卡', intendedDiffOf('edit', 'not json at all'), null);
  t.eq('缺 file_path → 不出对照卡', intendedDiffOf('edit', '{"old_string":"a","new_string":"b"}'), null);
  t.eq('file_path 空白串 → 不出对照卡（官方 trim 判空）', intendedDiffOf('edit', '{"file_path":"   ","old_string":"a","new_string":"b"}'), null);
  t.eq('缺 new_string → 不出对照卡', intendedDiffOf('edit', '{"file_path":"/a","old_string":"a"}'), null);
  t.eq('replace_all 非布尔 → 不出对照卡（官方校验）', intendedDiffOf('edit', '{"file_path":"/a","old_string":"a","new_string":"b","replace_all":"yes"}'), null);
  t.eq('replace_all 为 null → 视为"出现但类型不对"→ 拒绝', intendedDiffOf('edit', '{"file_path":"/a","old_string":"a","new_string":"b","replace_all":null}'), null);
  t.eq('replace_all 合法布尔 → 正常出卡', intendedDiffOf('edit', '{"file_path":"/a","old_string":"a","new_string":"b","replace_all":true}') !== null, true);

  // validEscalationFields：提权字段要么都不出现，要么一起且合法
  t.eq('只给 sandbox_permissions（缺 justification）→ 拒绝',
    intendedDiffOf('edit', '{"file_path":"/a","old_string":"a","new_string":"b","sandbox_permissions":"workspace-write"}'), null);
  t.eq('justification 空白 → 拒绝',
    intendedDiffOf('edit', '{"file_path":"/a","old_string":"a","new_string":"b","sandbox_permissions":"workspace-write","justification":"  "}'), null);
  t.eq('sandbox_permissions 取值非法 → 拒绝',
    intendedDiffOf('edit', '{"file_path":"/a","old_string":"a","new_string":"b","sandbox_permissions":"root","justification":"x"}'), null);
  t.eq('提权字段合法 → 正常出卡',
    intendedDiffOf('edit', '{"file_path":"/a","old_string":"a","new_string":"b","sandbox_permissions":"danger-full-access","justification":"需要写工作区外"}') !== null, true);
  t.eq('提权字段都不出现 → 正常出卡（默认情形）',
    intendedDiffOf('edit', '{"file_path":"/a","old_string":"a","new_string":"b"}') !== null, true);

  // str_replace_editor（官方单独一支）
  const c = intendedDiffOf('str_replace_editor', '{"command":"create","path":"/n.ts","file_text":"hello"}');
  t.eq('str_replace_editor create → oldText null', c !== null && c.oldText === null, true);
  t.eq('str_replace_editor create → newText 取 file_text', c !== null && c.newText, 'hello');
  const r = intendedDiffOf('str_replace_editor', '{"command":"str_replace","path":"/n.ts","old_str":"a","new_str":"b"}');
  t.eq('str_replace_editor str_replace → oldText 取 old_str', r !== null && r.oldText, 'a');
  t.eq('str_replace_editor 其他 command → 不出卡',
    intendedDiffOf('str_replace_editor', '{"command":"view","path":"/n.ts"}'), null);

  // ── 行级对照 ──
  const ins = diffLines('a\nb', 'a\nX\nb');
  t.eq('插入一行 → 3 行（上下文/新增/上下文）', ins.length, 3);
  t.eq('插入行的性质', ins[1].kind, DiffLineKind.ADDED);
  t.eq('插入行内容', ins[1].text, 'X');

  const del = diffLines('a\nX\nb', 'a\nb');
  t.eq('删除一行 → 中间是 REMOVED', del[1].kind, DiffLineKind.REMOVED);

  const chg = diffLines('a\nold\nb', 'a\nnew\nb');
  const chgStat = diffStatOf(chg);
  t.eq('改一行 → 1 增 1 删', chgStat.added === 1 && chgStat.removed === 1, true);
  t.eq('未改动的行记为上下文（不计入增删）', diffStatOf(diffLines('a\nb\nc', 'a\nb\nc')).added, 0);

  const pure = diffLines(null, 'x\ny');
  t.eq('oldText 为 null ⇒ 全是新增', diffStatOf(pure).added === 2 && diffStatOf(pure).removed === 0, true);

  // 前后缀削去后仍然给出正确的增删（这是最省的一步，覆盖"只改一行"的多数情况）
  const big = [];
  for (let i = 0; i < 60; i++) big.push('line' + i);
  const bigNew = big.slice(); bigNew[30] = 'CHANGED';
  const bigStat = diffStatOf(diffLines(big.join('\n'), bigNew.join('\n')));
  t.eq('60 行里改 1 行 → 恰好 1 增 1 删', bigStat.added === 1 && bigStat.removed === 1, true);

  // 超上限时退回"全删 + 全增"（宁可粗但真，也不把 UI 线程算住）
  const huge = [];
  for (let i = 0; i < 400; i++) huge.push('h' + i);
  const hugeNew = huge.slice().reverse();
  const hugeStat = diffStatOf(diffLines(huge.join('\n'), hugeNew.join('\n')));
  t.eq('超出 DP 上限 → 退回全删全增（有界，不假称精确）', hugeStat.added === 400 && hugeStat.removed === 400, true);

  // ── 折叠：改两行、文件 800 行，不能把 799 行上下文铺到手机上 ──
  const long = [];
  for (let i = 0; i < 120; i++) long.push('L' + i);
  const longNew = long.slice(); longNew[60] = 'EDIT';
  const collapsed = collapseContext(diffLines(long.join('\n'), longNew.join('\n')), 2);
  let skippedTotal = 0;
  let contextCount = 0;
  for (let i = 0; i < collapsed.length; i++) {
    if (collapsed[i].kind === DiffLineKind.SKIPPED) skippedTotal += collapsed[i].skipped;
    if (collapsed[i].kind === DiffLineKind.CONTEXT) contextCount += 1;
  }
  t.eq('折叠后总行数从 121 降到 12', collapsed.length === 12, true);
  t.eq('被折叠的行数被如实记录', skippedTotal > 100, true);
  t.eq('改动两侧保留上下文', contextCount >= 4, true);
  let skippedAt = -1;
  for (let i = 0; i < collapsed.length; i++) {
    if (collapsed[i].kind === DiffLineKind.SKIPPED) { skippedAt = i; break; }
  }
  t.eq('跳过标记排在保留的上下文之后', skippedAt > 0 && collapsed[skippedAt - 1].kind === DiffLineKind.CONTEXT, true);
  t.eq('跳过标记不显示行内容（内容为空）', collapsed[skippedAt].text === '', true);

  // ── 成品：路径 + 行 + 统计 + 截断标记 ──
  const p1 = presentDiff('edit', '{"file_path":"/a/b.ts","old_string":"foo","new_string":"bar"}');
  t.eq('成品带路径', p1 !== null && p1.path, '/a/b.ts');
  t.eq('成品统计 1 增 1 删', p1 !== null && p1.added === 1 && p1.removed === 1, true);
  t.eq('未截断时 truncated=false', p1 !== null && p1.truncated === false, true);
  t.eq('不认识的工具 → 成品为 null（视图照常走摘要）', presentDiff('bash', '{"command":"ls"}'), null);

  // 截断：超过 maxLines 时必须如实置 truncated（而不是假装这就是全部）
  const manyLines = [];
  for (let i = 0; i < 60; i++) manyLines.push('x' + i);
  const manyDiff = presentDiff('write', '{"file_path":"/big.ts","content":"' + manyLines.join('\\n') + '"}', 2, 20);
  t.eq('超过行数上限 → 截断到上限', manyDiff !== null && manyDiff.lines.length, 20);
  t.eq('截断时如实置 truncated=true', manyDiff !== null && manyDiff.truncated, true);
  t.eq('截断仍如实统计增删总数（不因截断而少算）', manyDiff !== null && manyDiff.added, 60);

  console.log('  ok    45 条断言：官方 intendedDiff 规则（含提权闸门与拒绝路径）+ 行级对照 + 折叠 + 截断');
}

console.log('\n## 输入模态事实（P3：设备枚举 / 事件证据 / 形态猜测，三者优先级明确）');
{
  const {
    flattenSources, guessFromKeyboardForm, modalityFromSources, modalityOf, modalityTrace,
    noModality, sourceIsKeyboard, sourceIsPointer, unionModality,
    SOURCE_KEYBOARD, SOURCE_MOUSE, SOURCE_TOUCHPAD, SOURCE_TRACKBALL, SOURCE_TOUCHSCREEN, SOURCE_JOYSTICK,
  } = IF;

  // ── 取值映射：依据 SDK SourceType 字符串联合，逐条钉死 ──
  t.eq('keyboard 算键盘', sourceIsKeyboard(SOURCE_KEYBOARD), true);
  t.eq('mouse 不算键盘', sourceIsKeyboard(SOURCE_MOUSE), false);
  t.eq('mouse 算指针', sourceIsPointer(SOURCE_MOUSE), true);
  t.eq('touchpad 算指针（笔记本自带）', sourceIsPointer(SOURCE_TOUCHPAD), true);
  t.eq('trackball 算指针', sourceIsPointer(SOURCE_TRACKBALL), true);
  t.eq('touchscreen **不算**指针（没有悬停、没有右键，入口是长按）', sourceIsPointer(SOURCE_TOUCHSCREEN), false);
  t.eq('joystick 不算指针（无法指向具体控件）', sourceIsPointer(SOURCE_JOYSTICK), false);
  t.eq('键盘也不算指针', sourceIsPointer(SOURCE_KEYBOARD), false);
  // 未识别取值必须保守：SDK 新增输入源时不该悄悄打开 hover/右键
  t.eq('未识别的取值两者都不算（保守）', sourceIsKeyboard('hologram') === false && sourceIsPointer('hologram') === false, true);

  // ── 由枚举结果得事实 ──
  t.eq('只有触控屏 → 无键盘无指针（手机常态）',
    JSON.stringify(modalityFromSources([SOURCE_TOUCHSCREEN])), '{"hasKeyboard":false,"hasPointer":false}');
  t.eq('触控屏 + 鼠标 → 有指针（**这正是此前判错的场景**）',
    modalityFromSources([SOURCE_TOUCHSCREEN, SOURCE_MOUSE]).hasPointer, true);
  t.eq('触控屏 + 鼠标 → 仍无键盘',
    modalityFromSources([SOURCE_TOUCHSCREEN, SOURCE_MOUSE]).hasKeyboard, false);
  t.eq('触控屏 + 键盘 + 触控板 → 两者都有（笔记本）',
    modalityFromSources([SOURCE_TOUCHSCREEN, SOURCE_KEYBOARD, SOURCE_TOUCHPAD]).hasKeyboard === true
    && modalityFromSources([SOURCE_TOUCHSCREEN, SOURCE_KEYBOARD, SOURCE_TOUCHPAD]).hasPointer === true, true);
  t.eq('空列表 → 无（不抛异常）', modalityFromSources([]).hasPointer, false);

  t.eq('摊平多设备并去重', flattenSources([[SOURCE_KEYBOARD], [SOURCE_MOUSE, SOURCE_KEYBOARD]]).length, 2);
  t.eq('摊平保留原有取值', flattenSources([[SOURCE_MOUSE]]), [SOURCE_MOUSE]);

  // ── 形态猜测（最弱的兜底，与旧行为一致） ──
  t.eq('2in1 形态 → 键盘+指针都猜有（笔记本有触控板）',
    guessFromKeyboardForm(true).hasKeyboard === true && guessFromKeyboardForm(true).hasPointer === true, true);
  t.eq('手机形态 → 都猜没有', guessFromKeyboardForm(false).hasPointer, false);

  // ── 合成优先级 ──
  const noEv = noModality();
  t.eq('① 枚举成功 ⇒ 以枚举为准，**覆盖**形态猜测（2in1 拆掉键盘后不再假装有键盘）',
    modalityOf({ enumerated: noModality(), observed: noEv, formGuess: guessFromKeyboardForm(true) }).hasKeyboard, false);
  t.eq('① 枚举成功且命中 ⇒ 手机插鼠标就有指针',
    modalityOf({ enumerated: { hasKeyboard: false, hasPointer: true }, observed: noEv, formGuess: guessFromKeyboardForm(false) }).hasPointer, true);
  t.eq('② 枚举不可用 ⇒ 退回形态猜测（保证不比旧行为更差）',
    modalityOf({ enumerated: null, observed: noEv, formGuess: guessFromKeyboardForm(true) }).hasKeyboard, true);
  t.eq('② 枚举不可用 + 悬停过 ⇒ 指针被事件证据救回来',
    modalityOf({ enumerated: null, observed: { hasKeyboard: false, hasPointer: true }, formGuess: guessFromKeyboardForm(false) }).hasPointer, true);
  t.eq('事件证据不能凭空造键盘',
    modalityOf({ enumerated: null, observed: { hasKeyboard: false, hasPointer: true }, formGuess: guessFromKeyboardForm(false) }).hasKeyboard, false);
  t.eq('三项都有时逐项取或',
    JSON.stringify(modalityOf({
      enumerated: { hasKeyboard: true, hasPointer: false },
      observed: { hasKeyboard: false, hasPointer: true },
      formGuess: noModality(),
    })), '{"hasKeyboard":true,"hasPointer":true}');

  // ── 降级与升级 ──
  t.eq('枚举可降级：拔掉鼠标后重新枚举即回到"没有指针"',
    modalityOf({ enumerated: noModality(), observed: noEv, formGuess: guessFromKeyboardForm(true) }).hasPointer, false);
  t.eq('unionModality 不制造假事实', unionModality(noModality(), noModality()).hasKeyboard, false);

  // ── 可解释性：失败时能说出理由（否则只能到设备上猜） ──
  const traceUnavailable = modalityTrace({ enumerated: null, observed: noEv, formGuess: guessFromKeyboardForm(false) });
  t.eq('枚举不可用时理由里写明"退回猜测"', traceUnavailable.length > 0 && traceUnavailable[0].indexOf('形态猜测') >= 0, true);
  const traceEmpty = modalityTrace({ enumerated: [], observed: noEv, formGuess: guessFromKeyboardForm(true) });
  t.eq('枚举成功但没有键鼠时理由里写明"当前没有"', traceEmpty[0].indexOf('没有键鼠类') >= 0, true);
  const tracePointerOnly = modalityTrace({
    enumerated: { hasKeyboard: false, hasPointer: true }, observed: noEv, formGuess: noModality(),
  });
  t.eq('只有指针时点明"不提示快捷键"', tracePointerOnly.indexOf('只有指针：启用 hover/右键，但不提示快捷键') >= 0, true);
  const traceHover = modalityTrace({
    enumerated: null, observed: { hasKeyboard: false, hasPointer: true }, formGuess: noModality(),
  });
  t.eq('事件证据生效时理由里点明"观察到指针悬停"', traceHover.indexOf('观察到指针悬停') >= 0, true);

  // ── 与策略层衔接：事实确定后，手势集合与 hover 随之确定（这才是这条链路的终点） ──
  const phoneOnly = modalityFromSources([SOURCE_TOUCHSCREEN]);
  t.eq('纯触控 ⇒ 手势集合只有长按（不给触控设备绑永远不触发的右键）',
    JSON.stringify(IP.contextMenuGestures(phoneOnly)), '["long-press"]');
  t.eq('纯触控 ⇒ 不启用 hover', IP.hoverEnabled(phoneOnly), false);
  t.eq('纯触控 ⇒ 菜单提示不出现"右键"字样',
    IP.contextMenuHintLabel(phoneOnly).indexOf('右键') < 0, true);

  const phoneWithMouse = modalityFromSources([SOURCE_TOUCHSCREEN, SOURCE_MOUSE]);
  t.eq('手机插鼠标 ⇒ 手势集合多了右键',
    JSON.stringify(IP.contextMenuGestures(phoneWithMouse)), '["long-press","right-click"]');
  t.eq('手机插鼠标 ⇒ 启用 hover（此前被 keyboardLikely 卡死）', IP.hoverEnabled(phoneWithMouse), true);

  const laptop = modalityFromSources([SOURCE_TOUCHSCREEN, SOURCE_KEYBOARD, SOURCE_TOUCHPAD]);
  t.eq('笔记本 ⇒ 长按与右键都在', JSON.stringify(IP.contextMenuGestures(laptop)), '["long-press","right-click"]');
  t.eq('键盘+指针 ⇒ 菜单提示带上快捷键说法',
    IP.contextMenuHintLabel(laptop).indexOf('右键') >= 0, true);

  console.log('  ok    37 条断言：SourceType 映射（含触控不算指针）+ 三个来源的优先级 + 可解释性');
}

console.log('\n## 详情栏拖拽与宽度记忆（P3：把模型里那条"用户想要的宽度"接通）');
{
  const { detailRoomOf, clampDetailDesired, dragDetailWidth, detailWidthOf, decideLayoutWithDetail, MAIN_MIN_VP } = LC;
  const SZ_MIN = 260;   // Sz.DETAIL_MIN
  const SZ_DEFAULT = 320;  // Sz.DETAIL_PANEL
  const SZ_MAX = 720;   // Sz.DETAIL_MAX

  // 可用空间 = 窗口宽 - 导航宽 - 主内容最小宽
  t.eq('可用空间扣除导航与主内容最小宽', detailRoomOf(1440, 240), 1440 - 240 - MAIN_MIN_VP);
  t.eq('700vp 单栏宽度下可用空间仍为正（180）', detailRoomOf(700, 240), 180);
  t.eq('窗口窄到装不下主内容时可用空间为负（由档位判定接手，不会并排）', detailRoomOf(400, 240) < 0, true);

  // 夹取
  t.eq('低于最小值 ⇒ 收到最小值', clampDetailDesired(100, 800), SZ_MIN);
  t.eq('高于可用空间 ⇒ 收到可用空间（**不跳回最小** —— 跳变是这里最容易犯的错）', clampDetailDesired(900, 800), 800);
  t.eq('区间内原样保留', clampDetailDesired(400, 800), 400);
  t.eq('可用空间小于最小值时收到最小值（不制造不可能的宽度）', clampDetailDesired(400, 200), SZ_MIN);
  t.eq('NaN ⇒ 收到最小值（坏值必须有确定收敛点）', clampDetailDesired(Number.NaN, 800), SZ_MIN);

  // 拖拽方向：把手在详情栏**左边缘** ⇒ 往左拖（deltaX<0）是变宽
  t.eq('往左拖 100 ⇒ 变宽 100', dragDetailWidth(400, -100, 1000), 500);
  t.eq('往右拖 100 ⇒ 变窄 100', dragDetailWidth(400, 100, 1000), 300);
  t.eq('往左拖到超过可用空间 ⇒ 夹在可用空间', dragDetailWidth(400, -2000, 600), 600);
  t.eq('往右拖到低于最小值 ⇒ 夹在最小值（不会拖成一条缝）', dragDetailWidth(400, 2000, 1000), SZ_MIN);

  /*
   * 拖拽**起点必须先归一化**（`beginDetailDrag` 的第一句）。
   *
   * 场景：用户在宽窗口把栏拖到 900，随后把窗口缩小 ⇒ 可用空间只剩 480，屏幕上显示的是被夹过的 480，
   * 而"意图"仍是 900。此时若直接拿 900 当起点，往窄拖会**先卡住一段**（要先把那 420 的差值拖掉），
   * 表现为"把手推不动"。先夹再记，第一帧就跟随。
   */
  t.eq('未经归一化：起点 900、往窄拖 50 仍然没动（这就是"推不动"的症状）',
    dragDetailWidth(900, 50, 480), 480);
  t.eq('归一化之后：同一个动作立刻跟随（430）',
    dragDetailWidth(clampDetailDesired(900, 480), 50, 480), 430);
  t.eq('归一化不会凭空改变意图内的值', clampDetailDesired(400, 480), 400);

  // 记忆值收窄
  t.eq('没有记录 ⇒ 默认宽度', detailWidthOf(undefined), SZ_DEFAULT);
  t.eq('NaN ⇒ 默认宽度', detailWidthOf(Number.NaN), SZ_DEFAULT);
  t.eq('低于最小值 ⇒ 最小值', detailWidthOf(10), SZ_MIN);
  t.eq('高于上限 ⇒ 上限（防止一读回来就吃掉整屏）', detailWidthOf(100000), SZ_MAX);
  t.eq('合法值原样保留', detailWidthOf(480), 480);
  t.eq('上限本身合法', detailWidthOf(SZ_MAX), SZ_MAX);

  // 与决策衔接：拖出来的宽度真的进了决策
  const wide = decideLayoutWithDetail({ widthVp: 1600, heightVp: 900, hasKeyboard: true, hasPointer: true }, 600);
  t.eq('桌面窗口 + 想要 600 ⇒ 详情栏宽 600', wide.detailWidthVp, 600);
  const tight = decideLayoutWithDetail({ widthVp: 1000, heightVp: 800, hasKeyboard: false, hasPointer: false }, 600);
  t.eq('窗口放不下想要的宽度 ⇒ 让步到最小并标注变窄',
    tight.detailWidthVp === SZ_MIN && tight.detailStep === 'detail-narrow', true);
  t.eq('1000vp 已经是三栏（并排详情可用）', tight.detailAvailable, true);

  // 档位边界：这是"拖拽能不能用"的前提 —— 双栏下详情栏**不并排**，把手根本不该出现
  const double = decideLayoutWithDetail({ widthVp: 839, heightVp: 800, hasKeyboard: false, hasPointer: false }, 600);
  t.eq('839vp（LG 边界下）是双栏 ⇒ 详情栏不并排可用', double.detailAvailable, false);
  t.eq('839vp 下详情宽度为 0（把手不该出现）', double.detailWidthVp, 0);
  const atLg = decideLayoutWithDetail({ widthVp: 840, heightVp: 800, hasKeyboard: false, hasPointer: false }, 600);
  t.eq('840vp（LG 边界）起为三栏 ⇒ 详情栏可用', atLg.detailAvailable, true);
  t.eq('840vp 下可用空间 320 < 想要的 600 ⇒ 让步到最小', atLg.detailWidthVp, SZ_MIN);
  t.eq('840vp 下主内容仍保住 MAIN_MIN_VP', atLg.detailWidthVp + atLg.navWidthVp + MAIN_MIN_VP <= 840, true);

  /*
   * 一条**边界事实**（不是缺陷，但值得钉住）：
   * 详情栏只在三栏档位并排，而三栏从 840vp 起、该档导航为 240、主内容至少 280
   * ⇒ 可用空间最小为 320 > DETAIL_MIN(260) ⇒ 让步链里的 `DETAIL_CLOSED` 分支
   * **在当前阈值下不可达**（它只在"可用空间 < 最小宽度"时触发）。
   * 保留该分支是**防御性**的（常量一旦调整就会生效）；这里把它钉成断言，
   * 好让将来真的有人调整阈值时，是**有意识地**让这条分支复活，而不是意外发现"历史遗留"。
   */
  let closedReachable = false;
  for (let w = 840; w <= 2400; w += 1) {
    const d = decideLayoutWithDetail({ widthVp: w, heightVp: 900, hasKeyboard: true, hasPointer: true }, 600);
    if (d.detailStep === 'detail-closed') { closedReachable = true; break; }
  }
  t.eq('三栏档位内 DETAIL_CLOSED 不可达（可用空间恒 > 最小宽度）', closedReachable, false);
  t.eq('但可用空间小于最小宽度时它确实会触发（模型逻辑本身正确）', LC.concedeDetail(400, 240, 600).step, 'detail-closed');

  // ── 详情呈现方式（P3 §12）：四形态各有各的呈现，不再"双栏也弹半模态" ──
  const { detailPresentationOf } = LC;
  t.eq('单栏 ⇒ 整页下钻/半模态（并排放不下）', detailPresentationOf('single'), 'overlay');
  t.eq('双栏 ⇒ 侧边浅层面板（此前与手机一样弹 Sheet，把列表整个盖住）', detailPresentationOf('double'), 'side-panel');
  t.eq('三栏 ⇒ 真右栏（与主内容并排）', detailPresentationOf('triple'), 'column');
  t.eq('呈现方式与"栏是否并排"是两件事：双栏不并排但仍要并可见',
    decideLayoutWithDetail({ widthVp: 800, heightVp: 1280, hasKeyboard: false, hasPointer: false }, 400).detailAvailable, false);
  t.eq('…而它的呈现方式仍是侧边面板',
    decideLayoutWithDetail({ widthVp: 800, heightVp: 1280, hasKeyboard: false, hasPointer: false }, 400).detailPresentation, 'side-panel');

  console.log('  ok    33 条断言：可用空间 / 夹取（不跳变）/ 拖拽方向（左拖变宽）/ 起点归一化 / 记忆值收窄 / 档位边界 / 呈现方式 / 与决策衔接');
}

console.log('\n## 轨迹时间线（P2 §11：交互式时间总览；种类/比例/拖动聚焦/会话统计）');
{
  const {
    TimelineKind, timelineKindLabel, timelineKindOf, timelineCellsOf, timelineScaleOf,
    cellIdAtRatio, segmentOrdinalOf, timelineTotalLabel, timelineStartedLabel,
    listIndexForCell, cellIdForListIndex,
    statsLinesOf, StatsUnit,
  } = TL;
  const { TrajectoryKind } = TJ;

  // 造条目：只填本模型用到的字段
  const item = (id, kind, speaker, elapsedMs, at) => ({
    id, kind, speaker: speaker || 'assistant', elapsedMs: elapsedMs || 0, at: at || 0,
    body: '', reasoning: '', model: '', toolName: '', callId: '', toolArgs: '',
    toolState: 'success', toolOutput: '', subagentName: '', fileName: '', fileSize: 0,
    title: '', progress: '', percent: -1, streaming: false, expanded: false, internal: false,
  });

  // ── 种类标签：逐字取官方中文 ──
  t.eq('system 标签', timelineKindLabel(TimelineKind.SYSTEM), '系统');
  t.eq('user 标签', timelineKindLabel(TimelineKind.USER), '用户');
  t.eq('context 标签', timelineKindLabel(TimelineKind.CONTEXT), '上下文');
  t.eq('compacted 标签', timelineKindLabel(TimelineKind.COMPACTED), '已压缩');
  t.eq('message 标签是「助手」（官方 kind.message 中文就是助手）', timelineKindLabel(TimelineKind.MESSAGE), '助手');
  t.eq('tool 标签', timelineKindLabel(TimelineKind.TOOL), '工具');
  t.eq('subtool 标签', timelineKindLabel(TimelineKind.SUBTOOL), '子工具');

  // ── 条目 → 格子 ──
  t.eq('用户消息 → 用户格', timelineKindOf(item('a', TrajectoryKind.MESSAGE, 'user')), TimelineKind.USER);
  t.eq('助手消息 → 助手格', timelineKindOf(item('b', TrajectoryKind.MESSAGE, 'assistant')), TimelineKind.MESSAGE);
  t.eq('思考归入助手那一步（官方没有独立的思考格）', timelineKindOf(item('c', TrajectoryKind.REASONING)), TimelineKind.MESSAGE);
  t.eq('工具调用 → 工具格', timelineKindOf(item('d', TrajectoryKind.TOOL)), TimelineKind.TOOL);
  t.eq('子代理也是一次工具调用 → 工具格（官方 tool/subtool 之分需要父子关系，我方没有）',
    timelineKindOf(item('e', TrajectoryKind.SUBAGENT)), TimelineKind.TOOL);
  t.eq('交付物**不产生**格子（官方时间线没有这个种类）', timelineKindOf(item('f', TrajectoryKind.DELIVERABLE)), null);
  t.eq('目标不产生格子', timelineKindOf(item('g', TrajectoryKind.GOAL)), null);
  t.eq('任务不产生格子', timelineKindOf(item('h', TrajectoryKind.JOB)), null);
  t.eq('错误不产生格子（官方把错误记在格子上的 isError，而不是一种 kind）',
    timelineKindOf(item('i', TrajectoryKind.ERROR)), null);

  const cells = timelineCellsOf([
    item('t1', TrajectoryKind.TOOL, 'assistant', 3000, 1000),
    item('t2', TrajectoryKind.TOOL, 'assistant', 1000, 2000),
    item('m1', TrajectoryKind.MESSAGE, 'assistant', 0, 3000),
    item('d1', TrajectoryKind.DELIVERABLE, 'assistant', 500, 4000),
  ]);
  t.eq('只有能对上种类的条目进时间线（4 条里 3 条）', cells.length, 3);
  t.eq('没有计时数据的格子仍在（不算比例但可见）',
    cells[cells.length - 1].durationMs, 0);

  // ── 比例 ──
  const scale = timelineScaleOf(cells);
  t.eq('总耗时只统计有计时数据的格子', scale.totalMs, 4000);
  t.eq('比例段只含有计时数据的格子', scale.segments.length, 2);
  t.eq('有计时数据', scale.hasData, true);
  t.eq('第一段比例 3/4', Math.abs(scale.segments[0].ratio - 0.75) < 1e-9, true);
  t.eq('第一段起点为 0', scale.segments[0].startRatio, 0);
  t.eq('第二段起点接在第一段之后（累计起点，不是浮动相加）',
    Math.abs(scale.segments[1].startRatio - 0.75) < 1e-9, true);
  t.eq('比例之和为 1', Math.abs(scale.segments[0].ratio + scale.segments[1].ratio - 1) < 1e-9, true);
  t.eq('格子总数包含没有计时数据的', scale.count, 3);

  const noData = timelineScaleOf([item('x', TrajectoryKind.TOOL, 'assistant', 0, 0)]);
  t.eq('全都没有计时数据 ⇒ hasData=false（界面显示官方那句"无计时数据"）', noData.hasData, false);
  t.eq('无计时数据时总计文案就是官方文案', timelineTotalLabel(noData), '无计时数据');
  t.eq('有数据时的总计文案带时长', timelineTotalLabel(scale).indexOf('总计 ') === 0, true);

  // ── 拖动聚焦（官方："水平拖动可聚焦事件"） ──
  t.eq('比例 0.1 落在第一格', cellIdAtRatio(scale.segments, 0.1), 't1');
  t.eq('比例 0.9 落在第二格', cellIdAtRatio(scale.segments, 0.9), 't2');
  t.eq('恰好落在分界点 0.75 归后一格', cellIdAtRatio(scale.segments, 0.75), 't2');
  t.eq('拖到条左侧之外 ⇒ 夹到第一格（而不是什么都不选）', cellIdAtRatio(scale.segments, -0.5), 't1');
  t.eq('拖到条右侧之外 ⇒ 夹到最后一格', cellIdAtRatio(scale.segments, 1.7), 't2');
  t.eq('空条 ⇒ 空 id（不抛异常）', cellIdAtRatio([], 0.5), '');
  t.eq('序号从 1 开始', segmentOrdinalOf(scale.segments, 't2'), 2);
  t.eq('找不到序号 ⇒ 0', segmentOrdinalOf(scale.segments, 'nope'), 0);

  // ── 条 ↔ 列表联动：聚焦的格子在列表第几行 ──
  const listItems = [
    item('l1', TrajectoryKind.MESSAGE, 'user', 0, 0),
    item('l2', TrajectoryKind.TOOL, 'assistant', 100, 0),
    item('l3', TrajectoryKind.GOAL, 'assistant', 0, 0),
    item('l4', TrajectoryKind.TOOL, 'assistant', 200, 0),
  ];
  t.eq('聚焦工具格 ⇒ 滚到列表第 1 行', listIndexForCell(listItems, 'l2'), 1);
  t.eq('行号是**列表里的位置**（含不产生格子的条目）', listIndexForCell(listItems, 'l4'), 3);
  t.eq('还没聚焦（空 id）⇒ 不滚（-1，而不是第 0 行）', listIndexForCell(listItems, ''), -1);
  t.eq('条目被过滤出列表 ⇒ 不滚', listIndexForCell(listItems, 'gone'), -1);
  t.eq('空列表 ⇒ 不滚', listIndexForCell([], 'l2'), -1);

  t.eq('列表第 1 行是工具格', cellIdForListIndex(listItems, 1), 'l2');
  t.eq('列表第 2 行是目标（**不产生格子**）⇒ 空 id', cellIdForListIndex(listItems, 2), '');
  t.eq('越界行号 ⇒ 空 id（不抛异常）', cellIdForListIndex(listItems, 99), '');
  t.eq('负行号 ⇒ 空 id', cellIdForListIndex(listItems, -1), '');
  t.eq('空列表 ⇒ 空 id', cellIdForListIndex([], 0), '');

  /*
   * 助手逐步计时（官方 `assistantTimingDetail`）**故意不在本模型里**：
   * 那些字段（`timingRecorded`/`stepStartTime`/`firstTokenTime`）来自官方客户端自己的 metrics，
   * 我方投影没有 ⇒ 没有消费者的函数不留（"不预置空 API"）。
   * 会话级的「首 token 平均（TTFT）」由下面的 `sessionStats` 给，仍有覆盖。
   */
  // ── 会话统计：官方 web 的五项，为 0 即不显示 ──
  const full = statsLinesOf({ turns: 3, steps: 7, llmMs: 12000, toolMs: 4000, ttftMs: 3000, ttftSteps: 3, decodeMs: 2000, decodeTokens: 100 });
  t.eq('四项时间相关项齐全时给四行', full.length, 4);
  t.eq('不含「轮次/步数」那一项（会话头部已显示，不重复）',
    full.filter((l) => l.key === 'turns').length, 0);
  t.eq('首行是模型用时', full[0].key, 'llm');
  t.eq('模型用时单位是毫秒', full[0].unit, StatsUnit.MS);
  t.eq('TTFT 是**平均值**（除以步数）', full[2].value, 1000);
  t.eq('TPS = 输出 token / 秒', full[3].value, 50);
  const none = statsLinesOf({ turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 });
  t.eq('全为 0 ⇒ 一行都不显示（而不是显示一堆 0）', none.length, 0);
  const onlyCounts = statsLinesOf({ turns: 5, steps: 9, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 });
  t.eq('只有轮次/步数（无任何计时）⇒ 一行也不给（那两项不归这里显示）', onlyCounts.length, 0);
  const ttftNoSteps = statsLinesOf({ turns: 1, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 500, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 });
  t.eq('有 TTFT 但没有步数 ⇒ 不出平均值（没有步数就没有平均可言）',
    ttftNoSteps.filter((l) => l.key === 'ttft').length, 0);
  const decodeNoTokens = statsLinesOf({ turns: 1, steps: 1, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 1000, decodeTokens: 0 });
  t.eq('有解码时长但没有 token 数 ⇒ 不出 TPS',
    decodeNoTokens.filter((l) => l.key === 'tps').length, 0);

  console.log('  ok    47 条断言：官方种类标签 / 条目映射（含"不产生格子"的四类）/ 累计比例 / 拖动聚焦与夹取 / 会话统计四项');
}

console.log('\n## 后台任务（P2：会话头部的任务注册表；官方 dsh-client-ui-jobs 的规则）');
{
  const {
    JobDot, jobIsLive, jobDotState, jobStatusLabel, jobDurationText, jobElapsedMs,
    orderedJobs, liveJobCount, jobCountLabel, jobListVisible, jobRowStatusText,
    jobDurationTitle, jobTickerNeeded, jobListA11y,
  } = JB;

  const job = (id, status, startedAt, finishedAt, kind, label, detail) => {
    const j = { id, kind: kind || 'bash', label: label || ('job-' + id), status, startedAt };
    if (finishedAt !== undefined) { j.finishedAt = finishedAt; }
    if (detail !== undefined) { j.detail = detail; }
    return j;
  };

  // ── live 判定（官方 isLive） ──
  t.eq('running 算进行中', jobIsLive(job('a', 'running', 0)), true);
  t.eq('stopping 也算进行中（请求停止尚未落地）', jobIsLive(job('b', 'stopping', 0)), true);
  t.eq('completed 不算', jobIsLive(job('c', 'completed', 0, 10)), false);
  t.eq('killed 不算', jobIsLive(job('d', 'killed', 0, 10)), false);
  t.eq('failed 不算', jobIsLive(job('e', 'failed', 0, 10)), false);

  // ── 状态点语义（官方 dotState；stopping 与 killed 共用 attention 色） ──
  t.eq('running → ongoing', jobDotState('running'), JobDot.ONGOING);
  t.eq('stopping → warning', jobDotState('stopping'), JobDot.WARNING);
  t.eq('killed → warning（与 stopping 同色：都是"按请求结束"）', jobDotState('killed'), JobDot.WARNING);
  t.eq('completed → done', jobDotState('completed'), JobDot.DONE);
  t.eq('failed → error', jobDotState('failed'), JobDot.ERROR);
  t.eq('未知状态 → error（宁可提示异常，也不显示成正常）', jobDotState('forged'), JobDot.ERROR);

  // ── 状态文案（逐字取官方中文） ──
  t.eq('running 文案', jobStatusLabel('running'), '运行中');
  t.eq('stopping 文案', jobStatusLabel('stopping'), '正在停止');
  t.eq('completed 文案', jobStatusLabel('completed'), '已完成');
  t.eq('killed 文案是「已取消」', jobStatusLabel('killed'), '已取消');
  t.eq('failed 文案', jobStatusLabel('failed'), '已失败');

  // ── 时长：最多两个相邻单位，小时封顶 ──
  t.eq('12 秒', jobDurationText(12 * 1000), '12秒');
  t.eq('0 秒（负数也被夹到 0）', jobDurationText(-5), '0秒');
  t.eq('1 分 5 秒', jobDurationText(65 * 1000), '1分5秒');
  t.eq('59 分 59 秒', jobDurationText(3599 * 1000), '59分59秒');
  t.eq('1 小时 0 分（小时是最大单位，不再长出天/月）', jobDurationText(3600 * 1000), '1小时0分');
  t.eq('30 小时 0 分（不折成"天"）', jobDurationText(30 * 3600 * 1000), '30小时0分');

  // ── 时长算法 ──
  t.eq('进行中按 now 算', jobElapsedMs(job('a', 'running', 1000), 5000), 4000);
  t.eq('已结束按 finishedAt 算（不受 now 影响）', jobElapsedMs(job('b', 'completed', 1000, 3000), 999999), 2000);
  t.eq('已结束但缺 finishedAt ⇒ 算 0（不拿"现在"去算已结束的任务）', jobElapsedMs(job('c', 'completed', 1000), 999999), 0);
  t.eq('时钟回退也不出负时长', jobElapsedMs(job('d', 'running', 5000), 1000), 0);

  // ── 排序（官方 ordered）：进行中在前按开始升序，已结束按结束倒序 ──
  const jobs = [
    job('done-old', 'completed', 100, 1000),
    job('live-late', 'running', 500),
    job('done-new', 'completed', 200, 5000),
    job('live-early', 'running', 300),
    job('killed', 'killed', 150, 3000),
  ];
  const order = orderedJobs(jobs).map((j) => j.id).join(',');
  t.eq('进行中在前（按开始时间升序），已结束按结束时间倒序',
    order, 'live-early,live-late,done-new,killed,done-old');
  t.eq('原数组不被就地改动（返回副本）', jobs[0].id, 'done-old');
  // 同毫秒结束的两条退回开始时间升序 —— 官方为了"不依赖宿主 map 迭代顺序"
  const tie = orderedJobs([
    job('t-late', 'completed', 200, 5000),
    job('t-early', 'completed', 100, 5000),
  ]).map((j) => j.id).join(',');
  t.eq('同毫秒结束时按开始时间升序（排序不依赖迭代顺序）', tie, 't-early,t-late');

  // ── 计数与可见性 ──
  t.eq('进行中计数', liveJobCount(jobs), 2);
  t.eq('有进行中 ⇒ 文案说"运行中"', jobCountLabel(jobs), '2 个后台任务运行中');
  t.eq('只有已结束 ⇒ 只报数量', jobCountLabel([job('x', 'completed', 0, 10), job('y', 'failed', 0, 10)]), '2 个后台任务');
  t.eq('**一个任务都没有 ⇒ 控件不出现**（官方：普通对话不该长出没用的控件）', jobListVisible([]), false);
  t.eq('有任务 ⇒ 出现', jobListVisible([job('x', 'completed', 0, 10)]), true);

  // ── 行上的状态文字：detail 优先 ──
  t.eq('有 detail ⇒ 显示 detail', jobRowStatusText(job('a', 'running', 0, undefined, undefined, undefined, 'npm run build')), 'npm run build');
  t.eq('没有 detail ⇒ 退回状态文案', jobRowStatusText(job('b', 'running', 0)), '运行中');
  t.eq('空串 detail 也退回状态文案', jobRowStatusText(job('c', 'running', 0, undefined, undefined, undefined, '')), '运行中');

  // ── 时长标题（官方 duration.title.live） ──
  t.eq('进行中的标题是"已运行 …"', jobDurationTitle(job('a', 'running', 0), 65 * 1000), '已运行 1分5秒');
  t.eq('已结束的标题是"共 …"', jobDurationTitle(job('b', 'completed', 0, 2000), 0), '共 2秒');

  // ── 定时器只在需要时起（移动端不多耗电） ──
  t.eq('有进行中 ⇒ 需要定时器', jobTickerNeeded([job('a', 'running', 0)]), true);
  t.eq('全是已结束 ⇒ 不需要定时器', jobTickerNeeded([job('b', 'completed', 0, 10)]), false);
  t.eq('空列表 ⇒ 不需要定时器', jobTickerNeeded([]), false);

  // ── 无障碍 ──
  t.eq('列表无障碍文案含计数', jobListA11y([job('a', 'running', 0)]), '后台任务：1 个后台任务运行中');

  console.log('  ok    40 条断言：live 判定 / 状态点语义 / 五种文案 / 时长三档与小时封顶 / 排序（含同毫秒退回） / 计数与"无任务不出现" / detail 优先 / 定时器按需');
}

console.log('\n## P0-1 对话可见性：内部事件不得进入 Conversation（结构与来源判定，不靠文本）');
{
  const { isConversationVisibleEvent } = RE;
  const { ConversationAudience, conversationAudienceOf, needsInternalIsolation } = TM;
  const { TrajectoryKind, Speaker } = TJ;

  // ── ① 事件类型白名单（来源事实，在投影时判定） ──
  t.eq('user/message 可见', isConversationVisibleEvent('user/message'), true);
  t.eq('assistant/message 可见', isConversationVisibleEvent('assistant/message'), true);
  t.eq('**system/message 不可见**（系统提示词）', isConversationVisibleEvent('system/message'), false);
  t.eq('**未识别类型不可见**（正文是原始载荷 JSON）',
    isConversationVisibleEvent('totally/unknown-event'), false);
  t.eq('**command/run 不可见**（斜杠命令不是回答）', isConversationVisibleEvent('command/run'), false);
  t.eq('**compaction/summary 不可见**（内部 context）',
    isConversationVisibleEvent('compaction/summary'), false);
  t.eq('request/context 不可见', isConversationVisibleEvent('request/context'), false);
  t.eq('审计类不可见', isConversationVisibleEvent('permission/preset'), false);
  t.eq('tool/call 可见（进过程分组）', isConversationVisibleEvent('tool/call'), true);
  t.eq('tool/result 可见（进过程分组）', isConversationVisibleEvent('tool/result'), true);
  t.eq('llm/retry 可见（错误要留）', isConversationVisibleEvent('llm/retry'), true);
  t.eq('todo/write 可见（任务行）', isConversationVisibleEvent('todo/write'), true);
  t.eq('deliverables/presented 可见', isConversationVisibleEvent('deliverables/presented'), true);
  // 反向：白名单不能靠"像消息"来猜
  t.eq('名字里带 message 但不是会话消息 ⇒ 不可见',
    isConversationVisibleEvent('session/title-llm-request'), false);

  // ── ② 条目 → 对话角色 ──
  const mk = (id, kind, speaker, internal) => ({
    id, kind, speaker, internal, at: 0, body: '', reasoning: '', model: '', elapsedMs: 0,
    toolName: '', callId: '', toolArgs: '', toolState: 'pending', toolOutput: '',
    subagentName: '', fileName: '', fileSize: 0, title: '', progress: '', percent: -1,
    streaming: false, expanded: false,
  });
  const A = ConversationAudience;
  t.eq('用户消息 → USER', conversationAudienceOf(mk('u', TrajectoryKind.MESSAGE, Speaker.USER, false)), A.USER);
  t.eq('助手消息 → ASSISTANT', conversationAudienceOf(mk('a', TrajectoryKind.MESSAGE, Speaker.ASSISTANT, false)), A.ASSISTANT);
  t.eq('错误 → NOTICE（规格：Conversation 允许 ERROR）',
    conversationAudienceOf(mk('e', TrajectoryKind.ERROR, Speaker.ASSISTANT, false)), A.NOTICE);
  t.eq('工具 → PROCESS（只进折叠的过程分组）',
    conversationAudienceOf(mk('t', TrajectoryKind.TOOL, Speaker.ASSISTANT, false)), A.PROCESS);
  t.eq('思考 → PROCESS', conversationAudienceOf(mk('r', TrajectoryKind.REASONING, Speaker.ASSISTANT, false)), A.PROCESS);
  t.eq('系统角色的消息 → HIDDEN（即便来源可见）',
    conversationAudienceOf(mk('s', TrajectoryKind.MESSAGE, Speaker.SYSTEM, false)), A.HIDDEN);
  t.eq('**内部条目一律 HIDDEN**（不管它长得多像回答）',
    conversationAudienceOf(mk('i', TrajectoryKind.MESSAGE, Speaker.ASSISTANT, true)), A.HIDDEN);
  t.eq('内部条目需要视觉隔离', needsInternalIsolation(mk('i', TrajectoryKind.MESSAGE, Speaker.ASSISTANT, true)), true);
  t.eq('普通回答不需要隔离', needsInternalIsolation(mk('a', TrajectoryKind.MESSAGE, Speaker.ASSISTANT, false)), false);

  // ── ③ 分组与可见集合：内部事件不占任何位置 ──
  const items = [
    mk('sys', TrajectoryKind.MESSAGE, Speaker.SYSTEM, true),        // 系统提示词
    mk('ctx', TrajectoryKind.REASONING, Speaker.ASSISTANT, true),   // 压缩摘要（内部）
    mk('unk', TrajectoryKind.MESSAGE, Speaker.ASSISTANT, true),     // 未识别事件（原始 JSON）
    mk('cmd', TrajectoryKind.MESSAGE, Speaker.ASSISTANT, true),     // 斜杠命令
    mk('u1', TrajectoryKind.MESSAGE, Speaker.USER, false),
    mk('r1', TrajectoryKind.REASONING, Speaker.ASSISTANT, false),
    mk('t1', TrajectoryKind.TOOL, Speaker.ASSISTANT, false),
    mk('a1', TrajectoryKind.MESSAGE, Speaker.ASSISTANT, false),
    mk('e1', TrajectoryKind.ERROR, Speaker.ASSISTANT, false),
  ];
  const turns = TM.groupTurns(items, false);
  t.eq('内部事件不产生回合（只有一条真实用户消息）', turns.length, 1);
  t.eq('内部事件不占过程分组（过程只有思考+工具）', turns[0].process.length, 2);
  t.eq('内部事件不占 notices（notices 只有错误）', turns[0].notices.length, 1);
  t.eq('答案仍是那条真实回答', turns[0].answer.id, 'a1');
  const visible = TM.chatVisibleItems(turns).map((i) => i.id);
  t.eq('**对话里只剩 用户/回答/错误 三类**', visible.join(','), 'u1,a1,e1');
  t.eq('对话里没有 system/message', visible.indexOf('sys') < 0, true);
  t.eq('对话里没有内部 context', visible.indexOf('ctx') < 0, true);
  t.eq('对话里没有未识别事件（原始 JSON）', visible.indexOf('unk') < 0, true);
  t.eq('对话里没有斜杠命令', visible.indexOf('cmd') < 0, true);
  // 内部事件**仍在 items 里**（轨迹要看得到）
  t.eq('内部事件仍保留在轨迹条目里（可查、可排查）', items.filter((i) => i.internal).length, 4);

  // ── ④ 不靠文本：正文里写着 SYSTEM 也照样按结构判定 ──
  const sneaky = mk('sneaky', TrajectoryKind.MESSAGE, Speaker.ASSISTANT, false);
  sneaky.body = 'SYSTEM: you are a helpful assistant';
  t.eq('正文含 SYSTEM 的正常回答仍可见（判据不看文本）',
    conversationAudienceOf(sneaky), A.ASSISTANT);
  const disguisedInternal = mk('disguise', TrajectoryKind.MESSAGE, Speaker.ASSISTANT, true);
  disguisedInternal.body = '这是一段普通回答';
  t.eq('长得像回答的内部事件仍被隐藏（判据不看文本）',
    conversationAudienceOf(disguisedInternal), A.HIDDEN);

  console.log('  ok    36 条断言：事件类型白名单（14）/ 条目角色（9）/ 分组与可见集合（11）/ 不靠文本（2）');
}

console.log('\n## P0-1 搜索作用域：内部事件不得被搜到、命中必须映射到正确的行');
{
  const { matchTrajectoryIndices, matchConversationIndices, chatRowOfItemIndex } = SE;
  const { TrajectoryKind, Speaker } = TJ;
  const mk = (id, kind, speaker, internal, body) => ({
    id, kind, speaker, internal, at: 0, body: body || '', reasoning: '', model: '',
    elapsedMs: 0, toolName: '', callId: '', toolArgs: '', toolState: 'pending', toolOutput: '',
    subagentName: '', fileName: '', fileSize: 0, title: '', progress: '', percent: -1,
    streaming: false, expanded: false,
  });

  const items = [
    mk('sys', TrajectoryKind.MESSAGE, Speaker.SYSTEM, true, 'You are an AI agent powered by DeepSeek Harness'),
    mk('u1', TrajectoryKind.MESSAGE, Speaker.USER, false, '帮我看看 harness 的配置'),
    mk('t1', TrajectoryKind.TOOL, Speaker.ASSISTANT, false, ''),
    mk('a1', TrajectoryKind.MESSAGE, Speaker.ASSISTANT, false, 'harness 配置在 settings.yaml'),
    mk('unk', TrajectoryKind.MESSAGE, Speaker.ASSISTANT, true, '{"huge":"internal payload"}'),
  ];

  // ── 轨迹范围：全部可搜（内部事件在轨迹里本就该可查） ──
  t.eq('轨迹范围能搜到提示词（排查需要）', matchTrajectoryIndices(items, 'deepseek harness').length, 1);
  t.eq('轨迹范围能搜到内部载荷', matchTrajectoryIndices(items, 'internal payload').length, 1);

  // ── 对话范围：内部事件**不可搜**（提示词泄漏的第二形态：能被搜到/被计数） ──
  const conv = matchConversationIndices(items, 'deepseek harness');
  t.eq('**对话范围搜不到系统提示词**', conv.length, 0);
  t.eq('对话范围搜不到未识别事件的原始载荷', matchConversationIndices(items, 'internal payload').length, 0);
  t.eq('对话范围能搜到用户消息与回答（两处都含"配置"）',
    matchConversationIndices(items, '配置').join(','), '1,3');
  const both = matchConversationIndices(items, 'harness');
  t.eq('同一个词在对话范围只命中可见的两条（提示词那条被排除）', both.join(','), '1,3');
  t.eq('对话范围的命中下标仍是**原数组下标**（供上层继续用 items 取条目）',
    items[both[0]].id, 'u1');
  t.eq('空查询 ⇒ 无命中', matchConversationIndices(items, '   ').length, 0);

  // ── 命中 → 对话视图行号（行是回合，不是条目） ──
  const turns = TM.groupTurns(items, false);
  t.eq('这里只有一个回合（内部事件不产生回合）', turns.length, 1);
  t.eq('用户消息 → 第 0 行', chatRowOfItemIndex(items, turns, 1), 0);
  t.eq('助手回答 → 同一回合的第 0 行', chatRowOfItemIndex(items, turns, 3), 0);
  t.eq('工具条目 → 也在第 0 行（过程分组在回合内）', chatRowOfItemIndex(items, turns, 2), 0);
  t.eq('内部事件不属于任何回合 ⇒ -1（不滚，而不是滚到第 0 行）', chatRowOfItemIndex(items, turns, 0), -1);
  t.eq('越界下标 ⇒ -1', chatRowOfItemIndex(items, turns, 99), -1);

  // ── 两个回合时行号才真正不同（这正是旧实现滚错行的场景） ──
  const two = [
    mk('u1', TrajectoryKind.MESSAGE, Speaker.USER, false, 'x'),
    mk('a1', TrajectoryKind.MESSAGE, Speaker.ASSISTANT, false, 'x'),
    mk('u2', TrajectoryKind.MESSAGE, Speaker.USER, false, 'x'),
    mk('a2', TrajectoryKind.MESSAGE, Speaker.ASSISTANT, false, 'x'),
  ];
  const twoTurns = TM.groupTurns(two, false);
  t.eq('两条用户消息 ⇒ 两个回合', twoTurns.length, 2);
  t.eq('第 3 个条目属于第 1 回合（条目下标 3 ≠ 行号 1 —— 旧实现直接当行号用，必然滚错）',
    chatRowOfItemIndex(two, twoTurns, 3), 1);

  console.log('  ok    18 条断言：轨迹/对话两个作用域（6）/ 命中下标保真（3）/ 条目→行映射含"不属于任何回合"（9）');
}

console.log('\n## P0 页面框架：面板注册表 + 导航状态（页面 ≠ 选中的面板）');
{
  const { PanelRegistry, PanelLocation, createPanelRegistry, sidebarPanels, rightbarPanels,
    sidebarEntries, sidebarPinnedEntries, SIDEBAR_PINNED_ORDER,
    PANEL_SIDEBAR_SETTINGS, PANEL_SIDEBAR_WORKSPACES,
    PANEL_RIGHT_DETAIL, PANEL_RIGHT_FILES, PANEL_RIGHT_TRAJECTORY, settingsSections } = PR;
  const { initialNavigationState, mainPanels, mainPanelOfLegacyTab, legacyTabOfMainPanel,
    navigateToMain, selectRightPanel, openSettings, setDrawer, sidebarPanelIdOfTab,
    activeMainPanelOf, mainPanelOfSidebarPanel, sidebarPanelOfMainPanel,
    enterSession, defaultRightPanel, copyOf,
    DrawerState, MAIN_CONVERSATION, MAIN_WORKSPACES, MAIN_SETTINGS, MAIN_CORE,
    SETTINGS_MODELS, SETTINGS_GENERAL } = NS;

  const { shellTracksOf } = ST;
  const reg = createPanelRegistry(mainPanels());

  // ── 注册表：位置是面板的属性，不是页面的 if 分支 ──
  t.eq('四条轨道的面板都注册了（含设置域的分区）',
    reg.size(), mainPanels().length + sidebarPanels().length + rightbarPanels().length + settingsSections().length);
  t.eq('重复 id 被拒绝（不静默覆盖）',
    reg.register({ id: MAIN_CONVERSATION, location: PanelLocation.MAIN, owner: 'x', label: 'x', order: 1, available: () => true }), false);
  t.eq('空 id 被拒绝',
    reg.register({ id: '', location: PanelLocation.MAIN, owner: 'x', label: 'x', order: 1, available: () => true }), false);

  // 排序：order 升序；同序按 id 稳定排序（不依赖注册顺序）
  const side = reg.descriptors(PanelLocation.SIDEBAR).map((d) => d.id);
  // E110：核心不是独立一级（内容在设置页的第一个分区里）⇒ 席位登记着但不可用
  t.eq('侧栏可用席位：工作区 → 设置（核心按 E110 不可用）', side.join(','), 'sidebar.workspaces,sidebar.settings');
  t.eq('**Settings 固定在底部**（order 最大）', side[side.length - 1], PANEL_SIDEBAR_SETTINGS);
  t.eq('核心席位仍登记在清单里（语义写在模型里，不靠视图恰好没遍历）',
    sidebarPanels().map((d) => d.id).join(','), 'sidebar.workspaces,sidebar.core,sidebar.settings');
  t.eq('主入口清单不含沉底项', sidebarEntries(reg).map((d) => d.id).join(','), 'sidebar.workspaces');
  t.eq('沉底项恰好是设置', sidebarPinnedEntries(reg).map((d) => d.id).join(','), 'sidebar.settings');
  const right = reg.descriptors(PanelLocation.RIGHTBAR).map((d) => d.id);
  // P3-1：右栏当前**唯一有内容**的面板是"详情"（sections 清单）；官方那六个候选登记着但不可用
  // P3-2/P3-3：预览与文件面板接上了（呈现分别与工作区页签的预览/文件树共用同一份组件）
  t.eq('右栏可用面板：详情 + 文件 + 轨迹 + 工具 + 子代理 + 交付物 + 预览（官方六个候选全接上）', right.join(','),
    'right.detail,right.files,right.trajectory,right.tool,right.subagent,right.deliverables,right.preview');
  t.eq('官方候选仍登记在清单里（内容视图未做的按 E110 不进选择集）',
    rightbarPanels().length, 7);
  t.eq('七个面板全部可用（官方六个候选 + 本仓的「详情」）',
    rightbarPanels().filter((d) => d.available()).length, 7);
  t.eq('默认右栏面板 = 详情（firstAvailable）', defaultRightPanel(reg), 'right.detail');
  t.eq('初值也指向详情（宿主不调 defaultRightPanel 时也不会落到空面板）',
    initialNavigationState().selectedRightPanel, 'right.detail');

  // 可用性：不可用的面板不进选择集
  const r2 = new PanelRegistry();
  r2.register({ id: 'a', location: PanelLocation.RIGHTBAR, owner: 'o', label: 'a', order: 20, available: () => false });
  r2.register({ id: 'b', location: PanelLocation.RIGHTBAR, owner: 'o', label: 'b', order: 10, available: () => true });
  t.eq('不可用的面板不进 descripors()', r2.descriptors(PanelLocation.RIGHTBAR).length, 1);
  t.eq('firstAvailable 跳过不可用的', r2.firstAvailable(PanelLocation.RIGHTBAR), 'b');

  // 校验：错轨道 / 不存在 / 不可用 都不能选中
  t.eq('跨轨道选中被拒（右栏 id 不能当主区面板）', reg.canSelect(PanelLocation.MAIN, PANEL_RIGHT_FILES), false);
  t.eq('不存在的 id 被拒', reg.canSelect(PanelLocation.MAIN, 'nope'), false);
  t.eq('不可用的 id 被拒', r2.canSelect(PanelLocation.RIGHTBAR, 'a'), false);
  t.eq('select 失败时**保持原值**（不静默回退到第一个）',
    reg.select(PanelLocation.RIGHTBAR, 'nope', PANEL_RIGHT_FILES), PANEL_RIGHT_FILES);

  // ── 导航状态：页面与面板分开 ──
  let nav = initialNavigationState();
  t.eq('初始主区面板是会话', nav.selectedMainPanel, MAIN_CONVERSATION);
  t.eq('初始右栏面板来自注册表首项', nav.selectedRightPanel, defaultRightPanel(reg));
  t.eq('初始抽屉是关的（手机侧栏不默认挡住主区）', nav.mobileDrawer, DrawerState.CLOSED);

  nav = navigateToMain(nav, MAIN_WORKSPACES, reg);
  t.eq('切到工作区面板', nav.selectedMainPanel, MAIN_WORKSPACES);
  const beforeBad = nav.selectedMainPanel;
  nav = navigateToMain(nav, 'not-a-panel', reg);
  t.eq('切到非法面板 ⇒ 状态不变（点了不会到别处）', nav.selectedMainPanel, beforeBad);

  // P3-6 之后七个面板全部可用 ⇒ "切不过去"改用不存在的 id 来断言（注册表校验仍在）
  t.eq('**不存在/不可用的右栏面板切不过去**（注册表校验仍在）',
    selectRightPanel(nav, 'right.nope', reg).selectedRightPanel, nav.selectedRightPanel);
  t.eq('可用的轨迹面板切得过去',
    selectRightPanel(nav, PANEL_RIGHT_TRAJECTORY, reg).selectedRightPanel, PANEL_RIGHT_TRAJECTORY);
  t.eq('可用面板（详情）切得过去、且是幂等的',
    selectRightPanel(nav, PANEL_RIGHT_DETAIL, reg).selectedRightPanel, PANEL_RIGHT_DETAIL);
  t.eq('**切右栏不影响主区**（页面与面板是两件事）', nav.selectedMainPanel, MAIN_WORKSPACES);

  nav = openSettings(nav, SETTINGS_MODELS, reg);
  t.eq('进设置域：主区是设置', nav.selectedMainPanel, MAIN_SETTINGS);
  t.eq('进设置域：分区是 models', nav.settingsSection, SETTINGS_MODELS);
  nav = openSettings(nav, '', reg);
  t.eq('空分区 ⇒ 保持当前分区', nav.settingsSection, SETTINGS_MODELS);


  nav = setDrawer(nav, DrawerState.OPEN);
  t.eq('抽屉打开', nav.mobileDrawer, DrawerState.OPEN);
  t.eq('从抽屉里选主区面板 ⇒ 抽屉收起（临时导航面）',
    navigateToMain(setDrawer(initialNavigationState(), DrawerState.OPEN), MAIN_SETTINGS, reg).mobileDrawer,
    DrawerState.CLOSED);
  t.eq('不可用的面板切不过去，也不该顺手把抽屉收掉（状态原样返回）',
    (() => {
      const st = setDrawer(initialNavigationState(), DrawerState.OPEN);
      return navigateToMain(st, 'main.nope', reg) === st && st.mobileDrawer === DrawerState.OPEN;
    })(), true);

  // enterSession：一处同步所有相关字段
  const entered = enterSession(nav, 'session-1', reg);
  t.eq('进会话 ⇒ 主区回到会话面板', entered.selectedMainPanel, MAIN_CONVERSATION);
  t.eq('进会话 ⇒ 记录会话 id', entered.currentSessionId, 'session-1');
  t.eq('进会话 ⇒ 关掉手机抽屉（否则抽屉挡着会话）', entered.mobileDrawer, DrawerState.CLOSED);

  // copyOf 保真：字段一个不漏
  const a = initialNavigationState();
  const b = copyOf(a);
  t.eq('copyOf 字段完整', Object.keys(a).length, Object.keys(b).length);
  t.eq('copyOf 是真拷贝（改副本不动原件）', (function () { b.selectedMainPanel = MAIN_CORE; return a.selectedMainPanel; })(), MAIN_CONVERSATION);

  // ── 迁移桥：行为不变 ──
  t.eq('旧页签 workspaces → 工作区面板', mainPanelOfLegacyTab('workspaces'), MAIN_WORKSPACES);
  t.eq('旧页签 core → 核心面板', mainPanelOfLegacyTab('core'), MAIN_CORE);
  t.eq('旧页签 settings → 设置面板', mainPanelOfLegacyTab('settings'), MAIN_SETTINGS);
  t.eq('旧下钻页 conversation → 会话面板（**收进同一套面板模型**）', mainPanelOfLegacyTab('conversation'), MAIN_CONVERSATION);
  t.eq('未知页签回到会话（不是空串——空串会让主区空白）', mainPanelOfLegacyTab('???'), MAIN_CONVERSATION);
  t.eq('反向映射：设置面板 → settings', legacyTabOfMainPanel(MAIN_SETTINGS), 'settings');
  t.eq('反向映射：会话面板 → workspaces（旧模型没有会话页签）', legacyTabOfMainPanel(MAIN_CONVERSATION), 'workspaces');
  // 往返：三个旧页签必须原样回来（这是"迁移期间不会点错页面"的保证）
  t.eq('往返一致 workspaces', legacyTabOfMainPanel(mainPanelOfLegacyTab('workspaces')), 'workspaces');
  t.eq('往返一致 core', legacyTabOfMainPanel(mainPanelOfLegacyTab('core')), 'core');
  t.eq('往返一致 settings', legacyTabOfMainPanel(mainPanelOfLegacyTab('settings')), 'settings');

  // ── 此刻主区在显示哪个面板（三类线索的组合收在模型里，视图只读一个值） ──
  const n0 = initialNavigationState();
  t.eq('下钻到诊断 ⇒ 诊断面板', activeMainPanelOf(n0, 'diagnostics', true), 'main.diagnostics');
  t.eq('下钻到连接 ⇒ 连接面板', activeMainPanelOf(n0, 'connect', false), 'main.connect');
  t.eq('下钻到会话且有会话 ⇒ 会话面板', activeMainPanelOf(n0, 'conversation', true), 'main.conversation');
  t.eq('**下钻到会话但没有会话 ⇒ 落回选中的面板**（不显示空会话）',
    activeMainPanelOf(n0, 'conversation', false), n0.selectedMainPanel);
  t.eq('没有下钻 ⇒ 选中的面板', activeMainPanelOf(n0, 'main', true), n0.selectedMainPanel);
  const onSettings = navigateToMain(n0, MAIN_SETTINGS, reg);
  t.eq('选中设置时没有下钻 ⇒ 设置面板', activeMainPanelOf(onSettings, 'main', true), MAIN_SETTINGS);
  t.eq('**下钻优先于页签**：选中设置但下钻诊断 ⇒ 诊断面板',
    activeMainPanelOf(onSettings, 'diagnostics', true), 'main.diagnostics');

  // 迁移桥：NavTab ↔ 面板 id（迁移期间行为不变的保证）
  t.eq('工作区页签 → 侧栏工作区面板 id', sidebarPanelIdOfTab('workspaces'), 'sidebar.workspaces');
  t.eq('设置页签 → 侧栏设置面板 id', sidebarPanelIdOfTab('settings'), 'sidebar.settings');
  t.eq('工作区与设置席位可用、核心席位按 E110 不可用',
    reg.canSelect('sidebar', 'sidebar.workspaces') && reg.canSelect('sidebar', 'sidebar.settings')
      && !reg.canSelect('sidebar', 'sidebar.core'), true);

  // P1-4：侧栏席位 ↔ 主区面板（点侧栏入口该切到哪个面板、哪一项该高亮）
  t.eq('工作区席位 → 工作区面板', mainPanelOfSidebarPanel(PANEL_SIDEBAR_WORKSPACES), MAIN_WORKSPACES);
  t.eq('设置席位 → 设置面板', mainPanelOfSidebarPanel(PANEL_SIDEBAR_SETTINGS), MAIN_SETTINGS);
  t.eq('未知席位回落工作区（不返回空串：空串会让主区空着）', mainPanelOfSidebarPanel('nope'), MAIN_WORKSPACES);
  t.eq('工作区面板 → 工作区席位（高亮用）', sidebarPanelOfMainPanel(MAIN_WORKSPACES), PANEL_SIDEBAR_WORKSPACES);
  t.eq('设置面板 → 设置席位', sidebarPanelOfMainPanel(MAIN_SETTINGS), PANEL_SIDEBAR_SETTINGS);
  t.eq('会话面板没有侧栏席位 ⇒ 空串（不高亮任何一项，而不是随便高亮）',
    sidebarPanelOfMainPanel(MAIN_CONVERSATION), '');
  t.eq('席位 → 面板 → 席位 往返稳定',
    sidebarPanelOfMainPanel(mainPanelOfSidebarPanel(PANEL_SIDEBAR_SETTINGS)), PANEL_SIDEBAR_SETTINGS);
  t.eq('沉底门槛是个明确的数（视图不写 900 这种字面量）', SIDEBAR_PINNED_ORDER >= 100, true);

  // ── P4-1：设置域分区（官方四段在前、本仓特有四项在后）──
  const sections = reg.descriptors(PanelLocation.SETTINGS).map((d) => d.id);
  t.eq('官方四段排在最前（通用 / 模型 / 插件 / 插件清单）', sections.slice(0, 4).join(','),
    'settings.general,settings.models,settings.plugins,settings.plugin-inventory');
  t.eq('本仓特有四项排在后面（核心 / 预设 / 技能 / 设备）', sections.slice(4).join(','),
    'settings.core,settings.presets,settings.skills,settings.device');
  t.eq('分区总量 8（官方 4 + 本仓 4）', settingsSections().length, 8);
  t.eq('owner 能区分"官方对齐项"与"端侧补充"',
    settingsSections().filter((d) => d.owner === 'dshm').map((d) => d.id).join(','),
    'settings.core,settings.presets,settings.skills,settings.device');
  t.eq('默认分区是通用（初值）', initialNavigationState().settingsSection, 'settings.general');
  t.eq('切分区经注册表校验后写入', openSettings(initialNavigationState(), 'settings.skills', reg).settingsSection,
    'settings.skills');
  t.eq('**不可用的分区切不过去**（注册表校验对设置域同样生效）',
    reg.canSelect(PanelLocation.SETTINGS, 'settings.nope'), false);
  // 「插件清单」曾经是插件段里的子页签，现在必须是**独立分区**（官方 settings-plugin-inventory）
  t.eq('插件清单是独立分区（不再是子页签）',
    sections.indexOf('settings.plugin-inventory') >= 0 && sections.indexOf('settings.plugins') >= 0, true);

  // ── 四形态：信息架构不变，只变呈现 ──
  const single = shellTracksOf('single');
  t.eq('手机：侧栏是浮层（抽屉）', single.sidebar, 'overlay');
  t.eq('手机：主区全屏', single.main, 'column');
  t.eq('手机：右栏是浮层', single.rightbar, 'overlay');
  const double = shellTracksOf('double');
  t.eq('平板竖屏：侧栏收成 rail', double.sidebar, 'rail');
  t.eq('平板竖屏：右栏仍是浮层（侧边浅层面板）', double.rightbar, 'overlay');
  const triple = shellTracksOf('triple');
  t.eq('三栏：侧栏是完整面板', triple.sidebar, 'panel');
  t.eq('三栏：右栏并排成栏', triple.rightbar, 'column');

  // ── 侧栏可收起（P2-15）：形态给默认，用户的展开/收起给偏好 ──
  {
    const { sidebarPresentationOf } = ST;
    t.eq('三栏展开：完整面板', sidebarPresentationOf('triple', true), 'panel');
    t.eq('三栏收起：rail（腾出宽度给主区）', sidebarPresentationOf('triple', false), 'rail');
    t.eq('双栏展开：完整面板（用户要，就给）', sidebarPresentationOf('double', true), 'panel');
    t.eq('双栏收起：rail（这是默认）', sidebarPresentationOf('double', false), 'rail');
    t.eq('**单栏一律浮层**：那个档位没有第二个选项', sidebarPresentationOf('single', true), 'overlay');
    t.eq('单栏收起也还是浮层', sidebarPresentationOf('single', false), 'overlay');
  }

  // ── 侧栏轨道的几何（P5-2）：呈现改了，宽度必须跟着改 ──
  {
    const { sidebarExpandedForMode, sidebarTrackWidthOf } = ST;

    // 三态取值（P2-17 起；P5-2 改成**按形态**给默认）
    t.eq('没存过 + 三栏 ⇒ 默认展开（shellTracksOf 说三栏的侧栏是 panel）',
      sidebarExpandedForMode('triple', undefined), true);
    t.eq('没存过 + 双栏 ⇒ 默认收起（放不下两条展开轨道）',
      sidebarExpandedForMode('double', undefined), false);
    t.eq('没存过 + 单栏 ⇒ 展开无意义，取值仍为 true（呈现恒为浮层）',
      sidebarExpandedForMode('single', undefined), true);
    t.eq('存过 true ⇒ 展开（**覆盖形态默认**：双栏也照给）',
      sidebarExpandedForMode('double', true), true);
    t.eq('存过 false ⇒ 保持收起（下次启动不擅自展开）',
      sidebarExpandedForMode('triple', false), false);

    // 轨道宽度 = 实际呈现的宽度（这是 P5-2 修的那条：此前它按形态默认算）
    t.eq('三栏 + 没存过 ⇒ 完整面板宽', sidebarTrackWidthOf('triple', undefined), 240);
    t.eq('三栏 + 收起 ⇒ **rail 宽（腾出的 184vp 真给主区）**',
      sidebarTrackWidthOf('triple', false), 56);
    t.eq('双栏 + 没存过 ⇒ rail 宽（默认就是收起的）',
      sidebarTrackWidthOf('double', undefined), 56);
    t.eq('双栏 + 用户展开 ⇒ 完整面板宽', sidebarTrackWidthOf('double', true), 240);
    t.eq('单栏 ⇒ 0（抽屉与底部标签都不占侧边宽度）',
      sidebarTrackWidthOf('single', undefined), 0);
    t.eq('单栏即便"展开"也是 0（那个档位没有并排的侧栏）',
      sidebarTrackWidthOf('single', true), 0);
    // 与决策里的 nav 宽度**故意不同**：决策是"按形态该留多少"，这里是"现在实际多宽"
    t.eq('rail 宽与 rail 呈现一致（56 = Sz.NAV_RAIL）',
      sidebarTrackWidthOf('double', undefined) === 56 && ST.sidebarPresentationOf('double', undefined) === 'rail',
      true);
  }
  // 侧栏 2（工作区 / 设置；核心席位按 E110 不可用）、右栏 7（详情 / 文件 / 轨迹 / 工具 / 子代理 / 交付物 / 预览）—— 可用清单与形态无关，只与注册表有关
  t.eq('**三种形态的面板清单一致**（信息架构不随设备变）',
    JSON.stringify(reg.descriptors(PanelLocation.SIDEBAR).length) + '/' + JSON.stringify(reg.descriptors(PanelLocation.RIGHTBAR).length),
    '2/7');

  console.log('  ok    注册表（注册/排序/可用性/沉底/校验）+ 导航状态（页面与面板分离）+ 迁移桥含往返 + 四形态轨道');
}


// ── P2：Markdown 切块与行内标记（会话正文的呈现）──
{
  const { parseMarkdown, parseInline, plainTextOf, MdBlockKind } = MD;

  // ① 标题：只认"# 后有空格的"，且 7 个 # 不是标题
  const h = parseMarkdown('# 一级\n\n### 三级\n\n####### 七个不算\n\n#没空格也不算');
  t.eq('标题：识别 1 级', h[0].kind === MdBlockKind.HEADING && h[0].level, 1);
  t.eq('标题：识别 3 级', h[1].level, 3);
  t.eq('标题：7 个 # 落到段落', h[2].kind, MdBlockKind.PARAGRAPH);
  t.eq('标题：`#没空格` 落到段落（不误吃正文）', h[3].kind, MdBlockKind.PARAGRAPH);

  // ② 围栏代码：语言标注 + 闭合
  const c = parseMarkdown('前言\n\n```ts\nconst a = 1;\n```\n\n后语');
  t.eq('围栏：切成 3 块', c.length, 3);
  t.eq('围栏：类型是代码块', c[1].kind, MdBlockKind.CODE);
  t.eq('围栏：语言标注', c[1].lang, 'ts');
  t.eq('围栏：闭合', c[1].closed, true);
  t.eq('围栏：内容原样（不做行内解析）', c[1].text, 'const a = 1;');

  // ③ **流式未闭合的围栏**：剩余全部当代码块，且 closed=false（这是本模型最要紧的一条）
  const un = parseMarkdown('看代码：\n```js\nlet x = 1;\nlet y = 2;');
  t.eq('未闭合围栏：两块', un.length, 2);
  t.eq('未闭合围栏：剩余全在代码块里（没被吞成正文）', un[1].text, 'let x = 1;\nlet y = 2;');
  t.eq('未闭合围栏：如实标 closed=false', un[1].closed, false);

  // ④ 列表：无序 / 有序 / marker
  const l = parseMarkdown('- 甲\n* 乙\n+ 丙\n1. 一\n2) 二');
  t.eq('列表：五项', l.length, 5);
  t.eq('列表：无序标记', l[0].marker + l[1].marker + l[2].marker, '···');
  t.eq('列表：有序标记（保留原序号）', l[3].marker + l[4].marker, '1.2)');
  t.eq('列表：有序标记 ordered=true', l[3].ordered, true);

  // ⑤ 引用（连续行合并）、分隔线
  const q = parseMarkdown('> 第一行\n> 第二行\n\n---');
  t.eq('引用：连续行合并成一块', q[0].kind === MdBlockKind.QUOTE && q[0].text, '第一行\n第二行');
  t.eq('分隔线：识别', q[1].kind, MdBlockKind.RULE);

  // ⑥ 段落：连续非空行合并、空行分段
  const pg = parseMarkdown('甲\n乙\n\n丙');
  t.eq('段落：连续行合并（保留换行）', pg[0].text, '甲\n乙');
  t.eq('段落：空行分段', pg[1].text, '丙');

  // ⑦ 行内：粗/斜/代码/删除线/链接
  const sp = parseInline('普通 **粗** *斜* `码` ~~删~~ [官网](https://x.y)');
  const kinds = sp.map((x) => `${x.text}${x.bold ? 'B' : ''}${x.italic ? 'I' : ''}${x.code ? 'C' : ''}${x.strike ? 'S' : ''}${x.href.length > 0 ? 'L' : ''}`).join('|');
  // 片段之间的空格必须**留在片段里**（丢了空格渲染出来就会粘在一起）——故期望值含那 4 个空格片段
  t.eq('行内：五种标记各就各位（含标记之间的空格片段）', kinds, '普通 |粗B| |斜I| |码C| |删S| |官网L');
  t.eq('行内：链接目标保真', sp[sp.length - 1].href, 'https://x.y');

  // ⑧ 未配对的标记**原样保留**（宁可少强调一次，也不吃字符）
  t.eq('行内：单个 * 原样', plainTextOf(parseMarkdown('a * b')), 'a * b');
  t.eq('行内：未闭合的 ** 原样', plainTextOf(parseMarkdown('**没闭合')), '**没闭合');
  t.eq('行内：未闭合的反引号原样', plainTextOf(parseMarkdown('`) 半截')), '`) 半截');
  t.eq('行内：`a * b * c` 不当斜体（内层有空格就退回原文）', plainTextOf(parseMarkdown('a * b * c')), 'a * b * c');

  // ⑨ 转义
  t.eq('行内：\\* 是字面星号', plainTextOf(parseMarkdown('\\*不是斜体\\*')), '*不是斜体*');

  // ⑩ 边界：空串 / CRLF / 相邻片段合并（不逐字符生成 Span）
  t.eq('空串：零块', parseMarkdown('').length, 0);
  t.eq('CRLF：与 LF 等价', parseMarkdown('# 甲\r\n\r\n乙').length, 2);
  t.eq('行内：相邻纯文本合并为一个片段', parseInline('甲乙丙').length, 1);
  t.eq('纯文本去标记：用于无障碍/降级', plainTextOf(parseMarkdown('**粗**与`码`')), '粗与码');

  console.log('  ok    24 条断言：标题 / 围栏（含未闭合） / 列表 / 引用 / 分隔线 / 段落 / 行内五标记 / 未配对原样 / 转义 / 边界');

  // ── P3-4：按种类筛选（右栏「交付物」等面板的判据）──
  {
    const { itemsOfKind, deliverablesOf, makeItem, TrajectoryKind } = TJ;
    const a = makeItem('a', TrajectoryKind.DELIVERABLE, 1000);
    const b = makeItem('b', TrajectoryKind.TOOL, 2000);
    const c = makeItem('c', TrajectoryKind.DELIVERABLE, 3000);
    const list = [a, b, c];
    t.eq('按种类筛：只留交付物且保序', deliverablesOf(list).map((x) => x.id).join(','), 'a,c');
    t.eq('按种类筛：筛选不改原数组', list.length, 3);
    // 同 id 会被流式 merge 多次：筛完应当只剩一条（"有几件事"而不是"更新了几次"）
    const dupA = makeItem('a', TrajectoryKind.DELIVERABLE, 4000);
    dupA.fileName = 'later';
    t.eq('同 id 只留最后一条（流式 merge 去重）',
      deliverablesOf([a, b, dupA]).map((x) => x.fileName).join(','), 'later');
    t.eq('没有该种类 ⇒ 空数组（面板据此显示空态，而不是显示空气泡）',
      itemsOfKind([b], TrajectoryKind.SUBAGENT).length, 0);
  }

  // ── P4-6：设置写入回执的归属域（界面不该把上一段的回执挂在当前段上）──
  {
    const { settingsDomainOfNs, settingsDomainOfKey, isGeneralNamespace,
      SETTINGS_DOMAIN_UNKNOWN, DEFAULT_MODEL_NS, GENERAL_NAMESPACES } = SD;

    // 通用分区：白名单整组
    t.eq('通用：外观命名空间', settingsDomainOfNs('ui-theme'), 'settings.general');
    t.eq('通用：语言', isGeneralNamespace('locale'), true);
    t.eq('通用：不在白名单 ⇒ 假', isGeneralNamespace('llm-deepseek'), false);

    // 模型分区：模型相关的四类命名空间
    t.eq('模型：提供方命名空间', settingsDomainOfNs('llm-deepseek'), 'settings.models');
    t.eq('模型：搜索命名空间', settingsDomainOfNs('web-search-brave'), 'settings.models');
    t.eq('模型：新会话默认模型', settingsDomainOfNs(DEFAULT_MODEL_NS), 'settings.models');
    t.eq('模型：子代理模型选择', settingsDomainOfNs('subagent-model-selection'), 'settings.models');

    // 插件 / 预设 / 技能
    t.eq('插件：ui-plugin-*', settingsDomainOfNs('ui-plugin-cordis'), 'settings.plugins');
    t.eq('预设：agent-preset*', settingsDomainOfNs('agent-presets'), 'settings.presets');
    t.eq('技能：skill*', settingsDomainOfNs('skills'), 'settings.skills');

    // 不猜：未列出的命名空间必须返回"域未知"，而不是随便归一段
    t.eq('未列出的命名空间 ⇒ 域未知', settingsDomainOfNs('agent-loop'), SETTINGS_DOMAIN_UNKNOWN);
    t.eq('引擎参数 agent-presets 之外的不猜', settingsDomainOfNs('unknown-ns'), SETTINGS_DOMAIN_UNKNOWN);

    // key → 域（按第一个点切命名空间）
    t.eq('key：llm-deepseek.baseURL', settingsDomainOfKey('llm-deepseek.baseURL'), 'settings.models');
    t.eq('key：ui-theme.fontSize', settingsDomainOfKey('ui-theme.fontSize'), 'settings.general');
    t.eq('key：没有命名空间 ⇒ 域未知（本机偏好由调用方声明）',
      settingsDomainOfKey('themeMode'), SETTINGS_DOMAIN_UNKNOWN);
    t.eq('key：点在结尾 ⇒ 域未知', settingsDomainOfKey('ui-theme.'), SETTINGS_DOMAIN_UNKNOWN);
    t.eq('key：点在最前 ⇒ 域未知', settingsDomainOfKey('.fontSize'), SETTINGS_DOMAIN_UNKNOWN);

    // 白名单本身也要钉住：多一个/少一个都会让"通用"页的内容变样
    t.eq('通用白名单五项', GENERAL_NAMESPACES.length, 5);
    t.eq('通用白名单内容', GENERAL_NAMESPACES.join(','), 'ui-theme,locale,ui-conversation,ui-chat,ui-onboarding');
  }

  // ── P2-7：会话头上下文行（工作区名 · 模型 · 最近活动）──
  {
    const { workspaceNameOf, sessionContextLine } = SC;

    // 工作区名：取末两段（同名目录会撞 ⇒ 留父目录前缀）
    t.eq('工作区名：末两段', workspaceNameOf('/home/u/projects/app'), 'projects/app');
    t.eq('工作区名：只有一段时不留前缀', workspaceNameOf('/srv'), 'srv');
    t.eq('工作区名：尾斜杠不影响', workspaceNameOf('/home/u/app/'), 'u/app');
    t.eq('工作区名：家目录（~ 已展开）照样取末两段', workspaceNameOf('~/work/dshm'), 'work/dshm');
    t.eq('工作区名：根目录', workspaceNameOf('/'), '/');
    t.eq('工作区名：空串 ⇒ 空串（不显示这一段）', workspaceNameOf(''), '');
    t.eq('工作区名：只有空白 ⇒ 空串', workspaceNameOf('   '), '');
    t.eq('工作区名：相对路径也照切', workspaceNameOf('a/b/c'), 'b/c');

    // 上下文行：三段都拿到
    t.eq('三段齐全', sessionContextLine('projects/app', 'DeepSeek-V3.2', '12 分钟前'),
      '工作区 projects/app · 模型 DeepSeek-V3.2 · 12 分钟前');
    // 每段拿不到就不出现（不留空的分隔符）
    t.eq('没有工作区', sessionContextLine('', 'DeepSeek-V3.2', '刚刚'), '模型 DeepSeek-V3.2 · 刚刚');
    t.eq('没有模型', sessionContextLine('app', '', '刚刚'), '工作区 app · 刚刚');
    t.eq('没有时间', sessionContextLine('app', 'm', ''), '工作区 app · 模型 m');
    t.eq('只有工作区', sessionContextLine('app', '', ''), '工作区 app');
    t.eq('一段都没有 ⇒ 空串（界面整行不画）', sessionContextLine('', '', ''), '');
  }

  // ── P2-8：浮层回执的归属（E353：一个全局回执被三个浮层读 ⇒ 串浮层）──
  {
    const { sheetNoteVisible, sheetNoteText, SHEET_NOTE_NONE,
      SHEET_NOTE_CREDENTIAL, SHEET_NOTE_TEXT, SHEET_NOTE_STRUCT } = SH;

    // 归属相符才显示
    t.eq('凭据浮层：回执是自己的', sheetNoteVisible(SHEET_NOTE_CREDENTIAL, 'credential'), true);
    t.eq('文本浮层：回执是凭据的 ⇒ 不显示', sheetNoteVisible(SHEET_NOTE_CREDENTIAL, 'text'), false);
    t.eq('结构浮层：回执是文本的 ⇒ 不显示', sheetNoteVisible(SHEET_NOTE_TEXT, 'struct'), false);
    t.eq('结构浮层：回执是自己的', sheetNoteVisible(SHEET_NOTE_STRUCT, 'struct'), true);

    // 没人认领（刚关掉某个浮层 / 还没写过）⇒ 一律不显示
    t.eq('无人认领 ⇒ 不显示（不知道谁写的错误比不显示更糟）',
      sheetNoteVisible(SHEET_NOTE_NONE, 'credential'), false);
    t.eq('无人认领 + 文本浮层 ⇒ 不显示', sheetNoteVisible(SHEET_NOTE_NONE, 'text'), false);

    // 文案出口：归属对且非空才有文本
    t.eq('文案：归属对且有内容', sheetNoteText('credential', 'credential', '已写入'), '已写入');
    t.eq('文案：归属不对 ⇒ 空串（界面拿不到文案）',
      sheetNoteText('credential', 'text', '已写入'), '');
    t.eq('文案：归属对但内容为空 ⇒ 空串', sheetNoteText('struct', 'struct', ''), '');

    // 三个取值本身要稳定（它们与 sheetKind() 的返回值对齐）
    t.eq('三个归属取值', [SHEET_NOTE_CREDENTIAL, SHEET_NOTE_TEXT, SHEET_NOTE_STRUCT].join(','),
      'credential,text,struct');
    t.eq('未认领是空串', SHEET_NOTE_NONE, '');
  }

  // ── P2-10：设置编辑浮层的输入提示（把服务端约束在输入前讲清楚）──
  {
    const { textSettingEditorHints, structSettingEditorHints, placeholderOf } = SE2;

    // 数字项：范围 + 步长
    const num = textSettingEditorHints(true, true, 1, true, 4096, 1, '', false, '1024');
    t.eq('数字项：类型 + 范围', num.hint, '请输入数字；范围 1 – 4096');
    t.eq('数字项：占位给当前值', num.placeholder, '当前：1024');
    t.eq('数字项：步长 >1 才说',
      textSettingEditorHints(true, false, 0, false, 0, 256, '', false, '').hint,
      '请输入数字；须为 256 的整数倍');
    // 只给一侧界：另一侧说"不限"（不编 ∞）
    t.eq('数字项：只有上界',
      textSettingEditorHints(true, false, 0, true, 17, 0, '', false, '').hint,
      '请输入数字；范围 不限 – 17');
    t.eq('数字项：上下界都没有就不提范围',
      textSettingEditorHints(true, false, 0, false, 0, 0, '', false, '').hint, '请输入数字');

    // 文本项：正则 + 必填
    t.eq('文本项：正则',
      textSettingEditorHints(false, false, 0, false, 0, 0, '^[a-z]+$', false, '').hint,
      '请输入文本；须匹配 ^[a-z]+$');
    t.eq('文本项：必填追加在最后',
      textSettingEditorHints(false, false, 0, false, 0, 0, '', true, '').hint, '请输入文本；必填');
    t.eq('文本项：什么都没有也至少说"请输入文本"',
      textSettingEditorHints(false, false, 0, false, 0, 0, '', false, '').hint, '请输入文本');

    // 占位：空值说"未设置"（不显示空白）
    t.eq('占位：有值', placeholderOf('256000'), '当前：256000');
    t.eq('占位：无值', placeholderOf(''), '当前未设置');
    t.eq('结构项的占位与文本项同源', structSettingEditorHints('').placeholder, '当前未设置');
    t.eq('结构项没有约束说明（JSON 由 Host 校验）', structSettingEditorHints('x').hint, '');
  }
  // ── P5-1：核心页的插件清单投影（宿主报告的字段 → 事实与行）──
  {
    const { pluginInventoryFact, pluginRowOf, rankPluginRows } = CP;

    // 有清单：一行说清规模 + 构成 + 来源
    const full = pluginInventoryFact('', '0.9.1',
      { pluginRows: 152, pureJs: 146, native: 6, unknown: 0, disabled: 3 }, 3);
    t.eq('清单：标签', full.label, '插件清单');
    t.eq('清单：规模与构成', full.value, '152 行 · 纯 JS 146 · 依赖原生 6 · 默认禁用 3');
    // 有原生依赖 ⇒ warn（这正是用户必须看见的那件事）
    t.eq('清单：含原生 ⇒ warn', full.verdict, 'warn');
    t.eq('清单：说明给出"来自哪一版"',
      full.hint.startsWith('来自核心 0.9.1；含原生模块的包 3 个。'), true);

    // 无原生、无禁用：不加多余的尾巴（"默认禁用 0" 这种话不该出现）
    const clean = pluginInventoryFact('', '1.0.0',
      { pluginRows: 10, pureJs: 10, native: 0, unknown: 0, disabled: 0 }, 0);
    t.eq('清单：无原生无禁用', clean.value, '10 行 · 纯 JS 10 · 依赖原生 0');
    t.eq('清单：无原生 ⇒ ok', clean.verdict, 'ok');

    // 没有清单（旧核心包）：必须说"是这个包没带清单"，而不是显示 0 行
    const none = pluginInventoryFact('该核心版本未携带插件清单', '',
      { pluginRows: 0, pureJs: 0, native: 0, unknown: 0, disabled: 0 }, 0);
    t.eq('没有清单 ⇒ 写"未探测"而不是 0', none.value, '未探测');
    t.eq('没有清单 ⇒ 判定为未知', none.verdict, 'unknown');
    t.eq('没有清单 ⇒ 原样给出原因', none.hint, '该核心版本未携带插件清单');

    // 行映射：清单的 nativeKind 是打包器取值，界面取值必须由映射决定
    t.eq('行：纯 JS ⇒ 可安装', pluginRowOf('a', 'alpha', 'PURE_JS', false).installable, true);
    t.eq('行：依赖原生 ⇒ 不可安装（只能随应用发版）',
      pluginRowOf('b', 'beta', 'NATIVE', false).installable, false);
    t.eq('行：读不出来 ⇒ 待确认（不猜成可安装）',
      pluginRowOf('e', 'eps', 'UNKNOWN', false).nativeKind, 'unknown');
    t.eq('行：清单无独立版本号 ⇒ 留空（不编一个）',
      pluginRowOf('a', 'alpha', 'PURE_JS', false).version, '');
    t.eq('行：默认禁用随行带出', pluginRowOf('c', 'gamma', 'PURE_JS', true).disabled, true);

    // 排序：依赖原生 → 默认禁用 → 可安装，同档保持清单原顺序
    const rows = [
      pluginRowOf('a', 'alpha', 'PURE_JS', false),
      pluginRowOf('b', 'beta', 'NATIVE', false),
      pluginRowOf('c', 'gamma', 'PURE_JS', true),
      pluginRowOf('d', 'delta', 'NATIVE', true),
      pluginRowOf('e', 'eps', 'UNKNOWN', false)
    ];
    const ranked = rankPluginRows(rows);
    t.eq('排序：依赖原生 → 默认禁用 → 可安装', ranked.map((r) => r.id).join(','), 'b,d,c,a,e');
    t.eq('排序：一个都不少（只排序不隐藏）', ranked.length, 5);
    t.eq('排序不改原数组顺序（调用点那份仍可复用）',
      rows.map((r) => r.id).join(','), 'a,b,c,d,e');
    t.eq('空清单 ⇒ 空数组（界面据此显示空态）', rankPluginRows([]).length, 0);
  }

}

// ══════════════════════════════════════════════════════════════════════════
// pi-ai 路由（对齐官方 Models 页）：投影 / 校验 / 写入载荷
//
// 期望值来源：
//   · 协议候选与 models 字段 —— 真 Host `settings/describe` dump
//     （tools/dump-piai-schema-full.mjs，2026-09-26；api 恰为三个 const）
//   · 写入原语可达性 —— 真 Host `settings/mutate`
//     （tools/probe-piai-write-paths.mjs：标量深路径 ✅ / 数字下标 ❌）
//   · id 正则与 deriveKeyRef —— 官方 CustomProviderCard 逐字一致
//     （dsh-client-ui-settings-models/lib/client.js:938,1196）
// ══════════════════════════════════════════════════════════════════════════
{
  console.log('\n# pi-ai 路由（官方 Models 页对齐）\n');

  // ── 凭据引用派生：必须与官方 deriveKeyRef 逐字一致 ──
  t.eq('deriveKeyRef：普通 id', PA.deriveKeyRef('wb2api'), 'WB2API_API_KEY');
  t.eq('deriveKeyRef：连字符 → 下划线', PA.deriveKeyRef('minimax-cn'), 'MINIMAX_CN_API_KEY');
  t.eq('deriveKeyRef：多点/多符号折成单个下划线', PA.deriveKeyRef('a--b.c'), 'A_B_C_API_KEY');

  // ── 协议显示名：三个已命名，其余原样（不编名字）──
  t.eq('协议名：completions', PA.protocolLabel('openai-completions'), 'OpenAI Chat Completions');
  t.eq('协议名：responses', PA.protocolLabel('openai-responses'), 'OpenAI Responses');
  t.eq('协议名：anthropic', PA.protocolLabel('anthropic-messages'), 'Anthropic Messages');
  t.eq('协议名：未知协议原样显示', PA.protocolLabel('brand-new-proto'), 'brand-new-proto');

  // 端点占位：Anthropic 的 SDK 自己追加 /v1/messages，所以不写 /v1
  t.eq('端点占位：openai 带 /v1', PA.baseURLPlaceholder('openai-completions'), 'https://gateway.example/v1');
  t.eq('端点占位：anthropic 不带 /v1', PA.baseURLPlaceholder('anthropic-messages'), 'https://gateway.example');

  // ── 路由 id 正则（官方逐字）──
  t.eq('id：合法', PA.isRouteValid('my-gateway'), true);
  t.eq('id：合法（带数字）', PA.isRouteValid('gateway2'), true);
  t.eq('id：数字开头不合法（凭据引用不能数字开头）', PA.isRouteValid('2gateway'), false);
  t.eq('id：大写不合法', PA.isRouteValid('Gateway'), false);
  t.eq('id：下划线不合法', PA.isRouteValid('my_gateway'), false);
  t.eq('id：结尾连字符不合法', PA.isRouteValid('my-'), false);
  t.eq('id：连续连字符不合法', PA.isRouteValid('my--gw'), false);

  // ── 端点校验 ──
  t.eq('端点：https 合法', PA.isHttpUrl('https://gw.example/v1'), true);
  t.eq('端点：http + 端口合法', PA.isHttpUrl('http://192.168.1.10:8080/v1'), true);
  t.eq('端点：缺协议不合法', PA.isHttpUrl('gw.example/v1'), false);
  t.eq('端点：ftp 不合法', PA.isHttpUrl('ftp://gw.example'), false);
  t.eq('端点：只有协议头不合法', PA.isHttpUrl('http://'), false);
  t.eq('端点：空不合法', PA.isHttpUrl('   '), false);
  t.eq('端点检查：空给出可执行提示', PA.checkBaseURL('').message, '请填写 API 地址（端点）。');
  t.eq('端点检查：合法通过', PA.checkBaseURL('https://gw.example/v1').ok, true);

  // ── 路由 id 检查（含占用；Host 不替你拦"覆盖已有路由"）──
  t.eq('id 检查：合法且未占用', PA.checkRoute('gw', ['other']).ok, true);
  t.eq('id 检查：已被占用要拦（Host 允许覆盖 ⇒ 这里是唯一拦点）',
    PA.checkRoute('gw', ['gw']).ok, false);
  t.ok('id 检查：占用提示含该 id', PA.checkRoute('gw', ['gw']).message.indexOf('gw') >= 0);
  t.eq('id 检查：空给出可执行提示', PA.checkRoute('  ', []).ok, false);

  // ── 协议检查 ──
  const CHOICES = ['openai-completions', 'openai-responses', 'anthropic-messages'];
  t.eq('协议检查：候选内通过', PA.checkProtocol('openai-responses', CHOICES).ok, true);
  t.eq('协议检查：候选外拒绝', PA.checkProtocol('gemini', CHOICES).ok, false);
  t.eq('协议检查：未选择拒绝', PA.checkProtocol('', CHOICES).ok, false);
  // schema 读不到候选时不许放行任何字符串（否则协议写错，抓都抓不到）
  t.eq('协议检查：读不到候选 ⇒ 一律不放行', PA.checkProtocol('openai-completions', []).ok, false);
  t.ok('协议检查：读不到候选时说明原因',
    PA.checkProtocol('openai-completions', []).message.indexOf('schema') >= 0);

  // ── 模型目录检查 ──
  t.eq('模型检查：空目录拒绝（官方 ready 判据要求 ≥1）', PA.checkModels([]).ok, false);
  t.eq('模型检查：缺 id 拒绝',
    PA.checkModels([{ id: '', name: 'x', contextWindow: 0, maxTokens: 0 }]).ok, false);
  t.eq('模型检查：id 重复拒绝',
    PA.checkModels([
      { id: 'm', name: '', contextWindow: 0, maxTokens: 0 },
      { id: 'm', name: '', contextWindow: 0, maxTokens: 0 }
    ]).ok, false);
  t.eq('模型检查：单行合法',
    PA.checkModels([{ id: 'm1', name: '', contextWindow: 0, maxTokens: 0 }]).ok, true);
  t.ok('模型检查：缺 id 指出是第几个',
    PA.checkModels([
      { id: 'ok', name: '', contextWindow: 0, maxTokens: 0 },
      { id: '', name: '', contextWindow: 0, maxTokens: 0 }
    ]).message.indexOf('2') >= 0);

  // ── 密钥草稿检查（官方 apiKeyFailure 的三条语义）──
  // 空 = "保留原来那把"（页面读不回明文，"只写不读"的必然结果）⇒ 不是失败
  t.eq('密钥：空不是失败（表示保留原密钥）', PA.checkApiKeyDraft('').ok, true);
  t.eq('密钥：只有空白是失败（输入不能被静默丢弃）', PA.checkApiKeyDraft('   ').ok, false);
  t.eq('密钥：带引号是失败', PA.checkApiKeyDraft('"sk-1"').ok, false);
  t.eq('密钥：含换行是失败', PA.checkApiKeyDraft('sk-1\nsk-2').ok, false);
  t.eq('密钥：正常值通过', PA.checkApiKeyDraft('sk-abc123').ok, true);

  // ── 投影：只读取，不补默认值 ──
  const provs = PA.projectPiAiProviders({
    wb2api: {
      baseURL: 'http://192.168.1.10:8080/v1',
      api: 'openai-completions',
      apiKeyEnv: 'WB2API_API_KEY',
      displayName: '我的中转站',
      models: [{ id: 'DeepSeek-V4-Flash', name: 'Flash', contextWindow: 262144, maxTokens: 32768 }]
    }
  });
  t.eq('投影：路由数', provs.length, 1);
  t.eq('投影：route', provs[0].route, 'wb2api');
  t.eq('投影：displayName', provs[0].displayName, '我的中转站');
  t.eq('投影：api（API 协议）', provs[0].api, 'openai-completions');
  t.eq('投影：apiKeyEnv', provs[0].apiKeyEnv, 'WB2API_API_KEY');
  t.eq('投影：模型 id', provs[0].models[0].id, 'DeepSeek-V4-Flash');
  t.eq('投影：上下文窗口', provs[0].models[0].contextWindow, 262144);

  // 缺字段 ⇒ 空值，不编默认（"没配"与"配了默认"必须长得不一样）
  const bare = PA.projectPiAiProviders({ gw: { models: [] } });
  t.eq('投影：缺 displayName ⇒ 空串（不编）', bare[0].displayName, '');
  t.eq('投影：缺 api ⇒ 空串（界面显示"未选择"）', bare[0].api, '');
  t.eq('投影：缺 models ⇒ 空数组', bare[0].models.length, 0);
  t.eq('投影：providers 为空对象 ⇒ 空列表', PA.projectPiAiProviders({}).length, 0);
  t.eq('投影：providers 不是对象 ⇒ 空列表（不炸）', PA.projectPiAiProviders(undefined).length, 0);

  // ── schema 读取协议候选（真 Host dump 的形状）──
  // 结构：refs[root].dict.providers → providersUid(dict) → .inner → profileUid(object)
  //       → .dict.api → apiUid(union) → .list[] 各为 const{value}
  const REFS = {
    '1': { type: 'object', dict: { providers: 2 } },
    '2': { type: 'dict', inner: 3 },
    '3': { type: 'object', dict: { api: 4 } },
    '4': { type: 'union', list: [
      { type: 'const', value: 'openai-completions' },
      { type: 'const', value: 'openai-responses' },
      { type: 'const', value: 'anthropic-messages' }
    ] }
  };
  t.eq('schema：读到三个协议候选',
    PA.piAiProtocolChoices(REFS, 1).join(','),
    'openai-completions,openai-responses,anthropic-messages');
  // 结构不认识 ⇒ 空数组（界面据此禁用协议选择，而不是编候选）
  t.eq('schema：rootUid 错 ⇒ 空（不炸）', PA.piAiProtocolChoices(REFS, 99).length, 0);
  t.eq('schema：refs 非对象 ⇒ 空（不炸）', PA.piAiProtocolChoices(undefined, 1).length, 0);
  t.eq('schema：只有 dict 没有 inner ⇒ 空（结构变了就如实报空）',
    PA.piAiProtocolChoices({ '1': { type: 'object', dict: { providers: 2 } }, '2': { type: 'dict' } }, 1).length, 0);

  // ── 写入载荷 ──
  t.eq('路径：标量字段（实测可达）', PA.piAiFieldPath('gw', 'baseURL').join('/'), 'providers/gw/baseURL');
  // 数组一律整值写：数字下标被网关拒、字符串下标语义是错的（实测）
  t.eq('路径：模型目录整值写（不按下标）', PA.piAiModelsPath('gw').join('/'), 'providers/gw/models');
  t.eq('路径：整条路由', PA.piAiRoutePath('gw').join('/'), 'providers/gw');

  const view = {
    route: 'gw', displayName: '网关', baseURL: 'https://gw.example/v1',
    api: 'openai-completions', apiKeyEnv: '',
    models: [{ id: 'm1', name: 'M1', contextWindow: 0, maxTokens: 0 }]
  };
  const profile = PA.buildRouteProfile(view, true, PA.deriveKeyRef('gw'));
  t.eq('profile：api 写入', profile['api'], 'openai-completions');
  t.eq('profile：baseURL 去掉首尾空白', profile['baseURL'], 'https://gw.example/v1');
  t.eq('profile：存密钥时记 apiKeyEnv', profile['apiKeyEnv'], 'GW_API_KEY');
  t.eq('profile：displayName 写入', profile['displayName'], '网关');
  // 不存密钥时**不写** apiKeyEnv：编辑端点时不该顺手改掉密钥引用
  const noKey = PA.buildRouteProfile(view, false, 'GW_API_KEY');
  t.eq('profile：不存密钥则不写 apiKeyEnv（保留 Host 上既有引用）',
    noKey['apiKeyEnv'], undefined);

  // 模型载荷：可选字段为 0/空则省略（写 0 会变成"真实上限 0"，比不写危险）
  const payload = PA.modelsPayload([
    { id: 'm1', name: '', contextWindow: 0, maxTokens: 0 },
    { id: 'm2', name: 'Two', contextWindow: 1000, maxTokens: 100 }
  ]);
  t.eq('模型载荷：id 必写', payload[0]['id'], 'm1');
  t.eq('模型载荷：空 name 省略', payload[0]['name'], undefined);
  t.eq('模型载荷：0 上下文窗口省略（≠ 上限 0）', payload[0]['contextWindow'], undefined);
  t.eq('模型载荷：有值的字段照写', payload[1]['contextWindow'], 1000);
  t.eq('模型载荷：条数一致', payload.length, 2);

  // ── 差异比对：只写真正变了的字段 ──
  const before = {
    route: 'gw', displayName: '旧', baseURL: 'https://old/v1',
    api: 'openai-completions', apiKeyEnv: '', models: []
  };
  t.eq('差异：只改端点 ⇒ 只报 baseURL',
    PA.changedScalarFields(before, {
      route: 'gw', displayName: '旧', baseURL: 'https://new/v1',
      api: 'openai-completions', apiKeyEnv: '', models: []
    }).join(','), 'baseURL');
  t.eq('差异：都没改 ⇒ 空清单（不发无谓的写）',
    PA.changedScalarFields(before, before).length, 0);
  t.eq('差异：改协议也报出来',
    PA.changedScalarFields(before, {
      route: 'gw', displayName: '旧', baseURL: 'https://old/v1',
      api: 'openai-responses', apiKeyEnv: '', models: []
    }).join(','), 'api');
  t.eq('字段值：baseURL', PA.scalarFieldValue(before, 'baseURL'), 'https://old/v1');
  t.eq('字段值：api', PA.scalarFieldValue(before, 'api'), 'openai-completions');

  // 模型差异用规范化载荷比，避免"多了个空格"就判定变化
  t.eq('模型差异：空 vs 空 ⇒ 无变化', PA.modelsDiffer([], []), false);
  t.eq('模型差异：加一行 ⇒ 有变化',
    PA.modelsDiffer([], [{ id: 'x', name: '', contextWindow: 0, maxTokens: 0 }]), true);
  t.eq('模型差异：仅名称空白差异 ⇒ 视为无变化',
    PA.modelsDiffer(
      [{ id: 'x', name: 'X', contextWindow: 0, maxTokens: 0 }],
      [{ id: 'x', name: '  X  ', contextWindow: 0, maxTokens: 0 }]), false);

  // 初值
  t.eq('初值：空表单带一个空模型行（官方要求 ≥1，先给一行省一次点击）',
    PA.emptyProviderView('openai-completions').models.length, 1);
  t.eq('初值：协议预选传入值', PA.emptyProviderView('anthropic-messages').api, 'anthropic-messages');

  // 命名空间常量（界面与中枢都用它，避免字面量散落）
  t.eq('命名空间常量', PA.PIAI_SETTINGS_NS, 'llm-pi-ai');
}

// ══ Web 权限裁决（真机 bug 的回归防线）══════════════════════════════════════
// 2026-09-26 真机实测：ArkWeb 的 PermissionRequest.getOrigin() 返回
//   "http://127.0.0.1:3120/"    ← **带结尾斜杠**
// 而最初的正则要求端口后立刻结束 ⇒ 判成"非回环" ⇒ 把本应用自己的麦克风请求
// 也 DENY 了。现象：diag-mic-probe 报 NotAllowedError，
// diag-web-permission 记 "loopback=false => DENY (not-mic-or-not-loopback)"。
// 下面的断言把当时那条真实的 origin 字符串钉住，防止同类回归。
{
  const AUDIO = WP.AUDIO_CAPTURE_RESOURCE;
  t.eq('常量：麦克风资源名与 ArkWeb 一致', AUDIO, 'TYPE_AUDIO_CAPTURE');

  // ── 回环判定：必须包含**带结尾斜杠**的真实形态 ──
  t.eq('回环：★真机原样（带结尾斜杠）', WP.isLoopbackOrigin('http://127.0.0.1:3120/'), true);
  t.eq('回环：不带斜杠也认', WP.isLoopbackOrigin('http://127.0.0.1:3120'), true);
  t.eq('回环：https', WP.isLoopbackOrigin('https://127.0.0.1:3120/'), true);
  t.eq('回环：localhost', WP.isLoopbackOrigin('http://localhost:3120/'), true);
  t.eq('回环：IPv6 回环', WP.isLoopbackOrigin('http://[::1]:3120/'), true);
  t.eq('回环：无端口', WP.isLoopbackOrigin('http://127.0.0.1/'), true);

  // ── 非回环必须拒（安全性：别把外站当自己人）──
  t.eq('非回环：外站', WP.isLoopbackOrigin('http://evil.com/'), false);
  t.eq('非回环：前缀伪装（startsWith 会中招）', WP.isLoopbackOrigin('http://127.0.0.1.evil.com/'), false);
  t.eq('非回环：路径里带回环', WP.isLoopbackOrigin('http://evil.com/127.0.0.1/'), false);
  t.eq('非回环：局域网地址', WP.isLoopbackOrigin('http://192.168.1.10:3120/'), false);
  t.eq('非回环：file 协议', WP.isLoopbackOrigin('file:///data/x.html'), false);
  t.eq('非回环：空串', WP.isLoopbackOrigin(''), false);
  t.eq('非回环：undefined', WP.isLoopbackOrigin(undefined), false);

  // ── 裁决：只有"回环 + 只要麦克风"才放行 ──
  t.eq('裁决：★真机场景（回环带斜杠 + 只要麦克风）⇒ 放行',
    WP.shouldGrantWebPermission('http://127.0.0.1:3120/', [AUDIO]), true);
  t.eq('裁决：只要摄像头 ⇒ 拒（本应用不需要摄像头）',
    WP.shouldGrantWebPermission('http://127.0.0.1:3120/', ['TYPE_VIDEO_CAPTURE']), false);
  t.eq('裁决：麦克风+摄像头 ⇒ 拒（只要一项不完全符就拒）',
    WP.shouldGrantWebPermission('http://127.0.0.1:3120/', [AUDIO, 'TYPE_VIDEO_CAPTURE']), false);
  t.eq('裁决：MIDI ⇒ 拒',
    WP.shouldGrantWebPermission('http://127.0.0.1:3120/', ['TYPE_MIDI_SYSEX']), false);
  t.eq('裁决：外站要麦克风 ⇒ 拒',
    WP.shouldGrantWebPermission('http://evil.com/', [AUDIO]), false);
  t.eq('裁决：空资源列表 ⇒ 拒',
    WP.shouldGrantWebPermission('http://127.0.0.1:3120/', []), false);
  t.eq('裁决：资源列表 undefined ⇒ 拒（不炸）',
    WP.shouldGrantWebPermission('http://127.0.0.1:3120/', undefined), false);
}

// ══ 语音音频换算（路线 A：HMS 系统语音识别）══════════════════════════════════
// HMS 硬约束（@hms.ai.speechRecognizer.d.ts 逐字）：
//   sampleRate 只支持 16000；audioType 只支持 pcm；soundChannel 只支持 1；
//   sampleBit 只支持 16；writeAudio 的 audio 长度只能是 640 或 1280 字节。
// 真机麦克风实测 48000 Hz（diag-mic-probe）⇒ 必须 48k→16k 重采样 + 定长分块。
{
  t.eq('常量：HMS 只支持 16000 Hz', SP.HMS_SAMPLE_RATE, 16000);
  t.eq('常量：块大小 640', SP.HMS_CHUNK_BYTES, 640);
  t.eq('常量：块大小（备选）1280', SP.HMS_CHUNK_BYTES_ALT, 1280);
  t.eq('常量：单次上限 60000ms', SP.HMS_MAX_AUDIO_MS, 60000);
  t.eq('常量：16 位 = 2 字节', SP.BYTES_PER_SAMPLE, 2);

  // ── 块大小校验：只有 640/1280 合法 ──
  t.eq('块大小：640 合法', SP.isValidAudioChunk(640), true);
  t.eq('块大小：1280 合法', SP.isValidAudioChunk(1280), true);
  t.eq('块大小：0 非法', SP.isValidAudioChunk(0), false);
  t.eq('块大小：639 非法（差一个字节也不行）', SP.isValidAudioChunk(639), false);
  t.eq('块大小：1281 非法', SP.isValidAudioChunk(1281), false);
  t.eq('块大小：960 非法（看似合理但文档不支持）', SP.isValidAudioChunk(960), false);

  // ── 分块：整除 / 有余数（余数丢弃）──
  const pcm1280 = new Uint8Array(1280);
  t.eq('分块：1280B / 640 ⇒ 2 块', SP.slicePcmChunks(pcm1280, 640).length, 2);
  t.eq('分块：每块长度都是 640',
    SP.slicePcmChunks(pcm1280, 640).every((c) => c.length === 640), true);
  const pcm1500 = new Uint8Array(1500);
  t.eq('分块：1500B / 640 ⇒ 2 块（余 220 丢弃）', SP.slicePcmChunks(pcm1500, 640).length, 2);
  t.eq('分块：不足一块 ⇒ 0 块', SP.slicePcmChunks(new Uint8Array(100), 640).length, 0);
  t.eq('分块：空输入 ⇒ 0 块', SP.slicePcmChunks(new Uint8Array(0), 640).length, 0);
  t.eq('分块：非法块大小 ⇒ 0 块（不产出会被 HMS 拒的块）',
    SP.slicePcmChunks(pcm1280, 999).length, 0);

  // ── 重采样：48k → 16k 是 3:1 ──
  const src48k = SP.makeTonePcm16(1000, 48000, 440);   // 1 秒 48k
  t.eq('重采样：48k 1秒 的样本数', src48k.length / 2, 48000);
  const dst16k = SP.resamplePcm16(src48k, 48000, 16000);
  t.eq('重采样：48k→16k 1秒 ⇒ 16000 样本（3:1）', dst16k.length / 2, 16000);
  t.eq('重采样：同采样率原样返回', SP.resamplePcm16(src48k, 48000, 48000).length, src48k.length);
  t.eq('重采样：空输入 ⇒ 空', SP.resamplePcm16(new Uint8Array(0), 48000, 16000).length, 0);
  t.eq('重采样：非法采样率 ⇒ 空（不炸）', SP.resamplePcm16(src48k, 0, 16000).length, 0);
  t.eq('重采样：半个样本（1 字节）⇒ 空', SP.resamplePcm16(new Uint8Array(1), 48000, 16000).length, 0);
  t.eq('重采样：44.1k→16k 也工作', SP.resamplePcm16(SP.makeTonePcm16(500, 44100, 440), 44100, 16000).length > 0, true);

  // ── 重采样必须保住**符号**（写成无符号会让负半周削顶失真）──
  // 构造 +1000 / -1000 交替的方波，重采样后必须仍有负值
  const sq = new Uint8Array(600);   // 300 样本
  const sqv = new DataView(sq.buffer);
  for (let i = 0; i < 300; i++) sqv.setInt16(i * 2, i % 2 === 0 ? 1000 : -1000, true);
  const sqOut = SP.resamplePcm16(sq, 48000, 16000);
  const outV = new DataView(sqOut.buffer, sqOut.byteOffset, sqOut.byteLength);
  let hasNeg = false, hasPos = false;
  for (let i = 0; i < sqOut.length / 2; i++) {
    const v = outV.getInt16(i * 2, true);
    if (v < 0) hasNeg = true;
    if (v > 0) hasPos = true;
  }
  t.eq('重采样：★负样本仍为负（符号位没丢）', hasNeg, true);
  t.eq('重采样：正样本仍为正', hasPos, true);

  // 终值保真：常数信号重采样后应仍是同一常数
  const flat = new Uint8Array(3000);
  const fv = new DataView(flat.buffer);
  for (let i = 0; i < 1500; i++) fv.setInt16(i * 2, 1234, true);
  const flatOut = SP.resamplePcm16(flat, 48000, 16000);
  const fo = new DataView(flatOut.buffer, flatOut.byteOffset, flatOut.byteLength);
  let allSame = true;
  for (let i = 0; i < flatOut.length / 2; i++) if (fo.getInt16(i * 2, true) !== 1234) { allSame = false; break; }
  t.eq('重采样：常数信号保持常数（无漂移）', allSame, true);

  // ── 时长换算（对照 60s 上限）──
  const oneSecond16k = new Uint8Array(16000 * 2);
  t.eq('时长：16k 1 秒 ⇒ 1000ms', SP.pcmDurationMs(oneSecond16k, 16000), 1000);
  t.eq('时长：空 ⇒ 0ms', SP.pcmDurationMs(new Uint8Array(0), 16000), 0);
  t.eq('时长：采样率 0 ⇒ 0ms（不炸）', SP.pcmDurationMs(new Uint8Array(320), 0), 0);

  // ── 自检用测试音 ──
  const tone = SP.makeTonePcm16(100, 16000, 440);
  t.eq('测试音：16k 100ms ⇒ 1600 样本', tone.length / 2, 1600);
  // 3200 字节 ÷ 640 = 5 块（整除，无余数丢弃）
  t.eq('测试音：3200B 能被切成 5 块', SP.slicePcmChunks(tone, 640).length, 5);
  t.eq('测试音：3200B 用 1280 切 ⇒ 2 块余 640 丢（1500 不整除）',
    SP.slicePcmChunks(tone, SP.HMS_CHUNK_BYTES_ALT).length, 2);
  t.eq('测试音：非全零（确实是波形）', tone.some((b) => b !== 0), true);
  t.eq('测试音：时长参数非法 ⇒ 空', SP.makeTonePcm16(0, 16000, 440).length, 0);

  // ── 识别文本合并（真机 bug 的回归防线）──────────────────────────────
  // 2026-09-26 真机实测：HMS 的 onResult 每次给的是**从头累计的完整文本**，
  // 不是增量片段。天真写法 `acc += text` 会把累计文本叠一遍，得到
  // "一一二一二三一二三四一二三四五12345。"（真实错误串）。
  // 下面把当时那条真实序列钉住。
  t.eq('合并：首条直接采纳', SP.mergeTranscript('', '一', false, false), '一');
  // ★ 真机原序列：逐条覆盖后，最终应等于最后那条
  let acc = '';
  const seq = [['一', false], ['一二', false], ['一二三', false], ['一二三四', false],
               ['一二三四五', false], ['12345。', true]];
  for (const [txt, fin] of seq) acc = SP.mergeTranscript(acc, txt, fin, fin);
  t.eq('合并：★真机序列不产生重复（首次实现的实际 bug）', acc, '12345。');
  t.eq('合并：不是叠加串', acc.indexOf('一一二') < 0, true);
  t.eq('合并：最终条 isFinal 定稿', SP.mergeTranscript('一二三四五', '12345。', true, false), '12345。');
  t.eq('合并：isLast 也定稿', SP.mergeTranscript('一二三四五', '12345。', false, true), '12345。');
  t.eq('合并：空串不覆盖已有', SP.mergeTranscript('已有', '', false, false), '已有');
  t.eq('合并：空串 + 空 previous ⇒ 空', SP.mergeTranscript('', '', false, false), '');
  t.eq('合并：undefined previous 不炸', SP.mergeTranscript(undefined, '甲', false, false), '甲');
  // 引擎在某分句后重置累计（incoming 短于 previous）⇒ 应追加而非丢弃
  t.eq('合并：分句重置时追加（不丢后句）', SP.mergeTranscript('你好世界', '再见', false, false), '你好世界再见');
  /*
   * ★ 区分"信 isFinal"与"只比长度"的关键用例。
   * 负测试发现：上面那些断言在"去掉 isFinal 分支、退回纯长度判据"时**仍然全绿**
   * —— 因为真机那条序列里 incoming 恰好每次都更长，长度判据也能得出同样结果。
   * 只有"定稿比中间态更短"时两者才分道扬镳：
   *   正确（信 isFinal）⇒ 定稿 "123"
   *   退化成长度判据 ⇒ "一百二十三123"（把定稿当增量追加了）
   * 中文数字转阿拉伯数字正是这种真实情形（"一百二十三"→"123" 长度变短）。
   */
  t.eq('合并：★定稿更短时信 isFinal（区分长度判据）',
    SP.mergeTranscript('一百二十三', '123', true, false), '123');
  t.eq('合并：★同上，isLast 亦然',
    SP.mergeTranscript('一百二十三', '123', false, true), '123');
  t.eq('合并：非定稿且更短 ⇒ 追加（不能丢）',
    SP.mergeTranscript('一百二十三', '四', false, false), '一百二十三四');

  // ── 静音判别（避免把"没录到声音"误判成"ASR 不可用"）──
  t.eq('静音：0 ⇒ 静音', SP.isNearSilence(0), true);
  t.eq('静音：199 ⇒ 静音', SP.isNearSilence(199), true);
  t.eq('静音：200 ⇒ 非静音', SP.isNearSilence(200), false);
  t.eq('静音：真机 TTS 空录 peak=0 ⇒ 静音', SP.isNearSilence(0), true);
  t.eq('静音：真机人声 peak=961 ⇒ 非静音', SP.isNearSilence(961), false);
  t.eq('静音：真机低音量 peak=20 ⇒ 判为静音（但那次仍识别成功，见文档）', SP.isNearSilence(20), true);

  // ── WAV 头常量（Host 与 ArkTS 两侧必须一致，否则"一边对一边错"）──
  // 依据：上游 encodeWave 的固定 44 字节头（RIFF/size/WAVE/fmt/16/…/data/dataSize）
  t.eq('WAV 头长度 = 44', SP.WAV_HEADER_BYTES, 44);
  t.eq('WAV 每秒字节数 = 32000（16k 单声道 16bit）', SP.WAV_BYTES_PER_SECOND, 32000);
  t.eq('WAV 每秒字节数 = HMS 采样率 × 2', SP.WAV_BYTES_PER_SECOND, SP.HMS_SAMPLE_RATE * SP.BYTES_PER_SAMPLE);
  /*
   * ★ 两侧常量一致性：Host 侧 hms-provider.js 各写了一份（语言不同无法共享模块），
   * 这里直接读那个文件，把"两处写的是同一个值"变成门禁断言。
   */
  const providerSrc = readFileSync(join(ROOT, 'hostcore/speech-provider/index.js'), 'utf8');
  const hostHdr = /const WAV_HEADER_BYTES = (\d+);/.exec(providerSrc);
  const hostBps = /const WAV_BYTES_PER_SECOND = (\d+);/.exec(providerSrc);
  t.eq('★Host 侧也写着 44（两处一致）', hostHdr === null ? 'MISSING' : Number(hostHdr[1]), SP.WAV_HEADER_BYTES);
  t.eq('★Host 侧也写着 32000（两处一致）', hostBps === null ? 'MISSING' : Number(hostBps[1]), SP.WAV_BYTES_PER_SECOND);

  // ── 整数秒录音的余数必须为 0（否则末尾会丢一个块级尾巴）──
  for (const sec of [1, 3, 5, 10, 60]) {
    const data = sec * SP.WAV_BYTES_PER_SECOND;
    t.eq(`整数秒录音 ${sec}s 的字节数能被 640 整除`, data % SP.HMS_CHUNK_BYTES, 0);
  }
}

t.done();
