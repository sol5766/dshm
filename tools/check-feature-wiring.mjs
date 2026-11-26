/**
 * 功能接线回归门禁（E258）。
 *
 * 【为什么需要它】构建能查出语法与类型错误，**查不出"调用点被删"**：
 * 一个功能的实现留在中枢、界面上的入口被某次重构顺手删掉，编译依然通过，
 * 只有跑一遍界面才会发现（本项目 E135 就出过：技能的数据层与界面都在，**触发点没了**，页面永远显示"未读"）。
 *
 * 【它做什么】对一组**已实现/已真机验证**的功能，检查"必须存在的接线特征"是否还在：
 *   · 中枢侧：方法/端点调用存在；
 *   · 界面侧：调用点存在（这是最容易悄悄消失的一环）。
 * 缺任何一项就退出码 1 并列出缺哪一项——**宁可吵，也不要静默**。
 *
 * 【它不做什么】不做语义判断（不保证逻辑正确），也不替代真机验收；它是"接线还在不在"的粗筛。
 *
 * 用法：node tools/check-feature-wiring.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = [
  'appstate/src/main/ets',
  'entry/src/main/ets',
  'hostruntime/src/main/ets',
  'dshcompat/src/main/ets',
  'platform/src/main/ets'
];

/** 递归收集 .ets 文件 */
function collect(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...collect(p));
    } else if (e.name.endsWith('.ets')) {
      out.push(p);
    }
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => collect(join(ROOT, d)));
/** `let`：`--self-test` 的对照臂要在**同一份代码路径**上换成变异体（见文件尾）。 */
let sources = files.map((f) => ({ path: relative(ROOT, f).replace(/\\/g, '/'), text: readFileSync(f, 'utf8') }));

function count(pattern) {
  const re = new RegExp(pattern);
  let n = 0;
  const where = [];
  for (const s of sources) {
    const lines = s.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        n++;
        if (where.length < 3) where.push(`${s.path}:${i + 1}`);
      }
    }
  }
  return { n, where };
}

/**
 * 每个功能列出"必须存在的接线"。
 * `min` 是期望的最少出现次数：**1 处往往意味着只剩定义（没有调用）**，所以要 >1。
 */
const FEATURES = [
  { name: '工作区删除', patterns: [['deleteWorkspaceByPath', 2]] },
  { name: '会话归档', patterns: [['archiveSession', 2]] },
  { name: '预设复制', patterns: [['copyAgentPreset', 2]] },
  { name: '预设删除', patterns: [['deleteAgentPreset', 2]] },
  { name: '预设查看', patterns: [['readAgentPreset', 2]] },
  { name: '技能清单', patterns: [['refreshSkills', 2], ['skills/list', 1]] },
  { name: '提供方目录', patterns: [['refreshProviderCatalog', 2]] },
  { name: '命令面板', patterns: [['refreshCommands', 2], ['executeCommand', 2]] },
  { name: '长期目标', patterns: [['refreshGoal', 2]] },
  { name: '消息反馈', patterns: [['putFeedback', 2], ['refreshFeedback', 2]] },
  { name: '文件变更流', patterns: [['openFilesStream', 2]] },
  { name: '计划模式', patterns: [['planActive|planPending', 2]] },
  { name: '核心版本切换', patterns: [['switchTo', 2], ['rollbackTo', 2]] },
  { name: '插件启停', patterns: [['plugin', 4]] },
  { name: '凭据写入', patterns: [['openCredentialSheet', 2]] },
  /*
   * 后台任务条（P2-2）。这一条正是**本门禁该拦下的那类缺口**：`Jobs` 模型 40 条断言、
   * 中枢一直在维护 `jobs` 字段，而视图里一个消费者都没有（"通道有、没接"）——
   * 编译不报、界面不报，只有肉眼看才发现的缺口。故把它钉成三段接线：
   * 模型判定（orderedJobs/jobListVisible）+ 中枢投影 + 会话头的传参。
   */
  { name: '后台任务条', patterns: [['orderedJobs', 2], ['jobListVisible', 2], ['jobs: this.f.jobs', 1]] },
  /*
   * 主区兜底（E343）。它同样是"接线断了不会有任何症状"的那一类，**后果更重**：
   * `MainShell` 只分派诊断/连接/会话三块，剩下的工作区/设置/核心由 `TabContentView` 渲染。
   * 这条接线曾断过——兜底写成 `this.mainContent(...)`（真机栈溢出杀进程，见 E343）。
   * 故钉住"视图里真的绑定了 tabFacade"（它是"剩下的面板归谁渲染"的唯一凭据）。
   */
  { name: '主区兜底', patterns: [['TabContentView\\(\\{ f: this\\.f\\.tabFacade', 1], ['tabFacade', 2]] },
  /*
   * 侧栏可收起（P2-15）。这一条是**功能缺口**而不是"接线断了"：`NavigationState.sidebarExpanded`
   * 长期没有任何控制点（侧栏呈现完全由形态决定），于是官方 AppFrame 那个"收起侧栏腾出宽度"
   * 的动作在本仓做不到。现在钉住三段接线：纯函数判定 + 门面开关 + 视图里的控制点。
   */
  /*
   * 旧核心树清理（2026-10-08）。这一条**正是本门禁该拦下的那类缺口**：
   * `CoreStore.evict()` 与它的判据（`Types.evictionCandidates`）早就写好、还配了单元用例，
   * **却一个调用点都没有** —— 编译不报、界面不报，代价是真机上 15 棵核心树并存（≈5 GB）。
   * 故钉两处：定义签名（唯一）+ 调用点（唯一，装入内置核心之后）。
   */
  { name: '旧核心树清理', patterns: [['evict\\(keep: number, keepExtra', 1], ['store\\.evict\\(0,', 1]] },
  { name: '侧栏收起', patterns: [['sidebarPresentationOf', 2], ['onToggleSidebarExpanded', 2], ['showExpandToggle', 2]] },
  /*
   * 底部手势区沉浸（docs/130）。它同样是"接线断了不会有任何症状"的那一类：读数、分档闸门、
   * 那次扩展各在一处，少任何一处编译都不报 —— 现象只是"小白条还浮在一条不属于页面的带子上"。
   * 故钉三段：① 读数要真去读**手势导航**报数的那个类型（真机实测：TYPE_SYSTEM 报 0、
   * TYPE_NAVIGATION_INDICATOR 报 98 —— 少读它，这条功能在手机上就是死的）；② 分档闸门
   * （只在手持档接管，PC/2in1 一个字都不动）；③ 按避让读数的那一次扩展 —— 写成带参数的
   * 调用形态，避免"别处随便一次 expandSafeArea"就算通过（整条链各自都要挂，故 ≥3 处）。
   */
  {
    name: '底部手势区沉浸',
    patterns: [
      ['TYPE_NAVIGATION_INDICATOR', 2],
      ['bottomInsetArmed', 4],
      ['expandSafeArea\\(this\\.bottomSafeAreaTypes\\(\\)', 3]
    ]
  },
  /*
   * 分屏旋转视口回正（docs/188）。真机“窗口 460vp / 内容 313.5vp”的本质是
   * 内容宽度停在横屏分屏值。注入脚本必须同时存在、被 Web 面积变化和主窗几何变化调用，
   * 并把 frame 的宽度锚回 100%；少任何一环，编译都不会报错，只会在旋转后露白。
   */
  {
    name: '手持档视口回正',
    patterns: [
      ['VIEWPORT_RECONCILE_SCRIPT', 2],
      ['scheduleViewportReconcile\\(', 3],
      ["frame\\.style\\.width = '100%'", 1],
      ['\\.onAreaChange\\(', 1],
      ['TYPE_KEYBOARD', 1],
      ['keyboardVisible', 4],
      ['KEYBOARD_OPEN_SCRIPT', 2],
      ['KEYBOARD_CLOSE_SCRIPT', 2],
      ['applyWebKeyboardState\\(', 2],
      ["win\\.on\\('windowSizeChange', this\\.onWindowGeometryChanged\\)", 1],
      ["win\\.on\\('windowRectChange', this\\.onWindowGeometryChanged\\)", 1]
    ]
  },
  /*
   * 收起态只显示 dsh 官方 opener（2026-11-11 用户裁决：删掉自绘浮动开关）。
   *
   * 【为什么还要钉】官方 opener 默认"鼠标移入才显形"，一旦那条常显规则被删/写歪，
   * 收起态就只剩一个看不见的按钮 —— 用户会报"侧栏收不回去了，没有按钮"，
   * 而编译、运行、日志全都不报。钉三处：① 状态属性常量仍被两处引用（CSS 与巡检）；
   * ② 收起态常显规则在；③ 面板/右栏打开时隐去的两条也都在（否则会压住标题）。
   */
  {
    name: '收起态官方 opener 常显',
    patterns: [
      ['SIDEBAR_STATE_ATTR', 2],
      ["STATE_ATTR \\+ '=\"collapsed\"\\]", 2],
      ['button\\[data-sidebar-opener\\]\\{display:inline-flex !important;opacity:1 !important', 1],
      ['button\\[data-sidebar-opener\\]\\{opacity:0 !important', 2]
    ]
  },
  /*
   * 官方侧栏按钮是桌面档唯一入口（2026-11-11 用户裁决，反转 docs/136 的旧口径）。
   *
   * 【为什么还要钉】断掉的症状同样"没有任何报错"：顶栏那颗自绘按钮已经删了，
   * 如果官方按钮又被垫片藏起来，桌面档就完全没有侧栏开关 —— 编译、运行、日志都不报。
   * 钉三条：① 桌面档类名还在（垫片靠它分档）；② pcMode 桥还在；
   * ③ 反面条在 FORBIDDEN：不得再出现 hideNativeToggle / 自绘按钮。
   */
  {
    name: '官方侧栏按钮恢复为桌面档入口',
    patterns: [
      ["var DESKTOP_CLASS = 'dshm-desktop';", 1],
      ['addClass\\((document\\.documentElement|htmlEl), DESKTOP_CLASS\\);', 1],
      ["var PC_CLASS = 'dshm-pc';", 1],
      ['platformPcMode', 1]
    ]
  },
  /*
   * 目录授权跨启动恢复必须**三端都跑**（docs/157）。
   *
   * 【为什么必须钉】这条接线断掉的症状是"没有任何报错"：PC 档重启后
   * `workspaceFiles/list` 只是报 `Errno 1 Operation not permitted`，用户看到的是
   * "工作区目录又读不到了"。旧实现正是**实现全在、只把 PC 档排除在调用之外** ——
   * 与 E135（数据层与界面都在、触发点没了）同一类缺陷，编译与运行都不报。
   *
   * 钉三段：① 启动恢复的调用点存在（它**不许**再被 `isHandheldForm()` 包住，
   * 反面条见 FORBIDDEN 的"三端授权链"）；② 两处 pick 真的走 `rememberFolderGrant()`
   *（定义 1 处 + 调用 2 处 ⇒ ≥3：只留定义 = 调用点被删）；③ PC 支的采纳判据里真的
   * 把 `persisted` 算进去（少了它，登记了授权也不会被采纳 —— 这一支的判据从
   * `probePathWritable(path)` 单条件改成了 `granted.persisted || probePathWritable(path)`）。
   */
  {
    name: '目录授权跨启动恢复（三端）',
    patterns: [
      ['restoreFolderGrants\\(this\\.context\\)', 1],
      ['private folderGrantsReady: Promise<string>', 1],
      ['this\\.folderGrantsReady = restoreFolderGrants\\(this\\.context\\)', 1],
      ['await this\\.folderGrantsReady', 1],
      ['rememberFolderGrant\\(', 3],
      ['granted\\.persisted \\|\\| probePathWritable\\(realPath\\)', 1],
      ['granted\\.persisted \\|\\| probePathWritable\\(path\\)', 1]
    ]
  }
];

/**
 * 「不许出现」的接线（E366）。
 *
 * 【为什么要反面规则】`FEATURES` 只能表达"某特征至少出现 N 次"，而这一轮查出的缺陷恰恰是
 * **多了一个不该有的东西**：`AppShell.buildDouble` 自己画了一份 rail surface，把侧栏呈现
 * **硬编码**成 `TrackPresentation.RAIL`，于是双栏下「展开侧栏」是个死按钮（偏好变了、纯函数
 * 判定也变了，只有这一个调用点没问判定）。这类缺陷正面计数拦不住 —— 该在的特征（`sidebarPresentationOf`
 * 的定义与调用）全都在。
 *
 * 【为什么只拦 RAIL，不拦 PANEL / OVERLAY】`RAIL` 在本仓**永远是判定的结果**（形态默认或用户
 * 收起），任何地方把它写成常量就等于绕过了判定；而 `PANEL`（手机抽屉）与 `OVERLAY`（底部标签）
 * 在 `AppShell` 里是**结构上固定**的表面，写常量是对的。
 *
 * 【注释先剥掉】规则命中的是代码；本轮修复留下的那段注释里就写着那个常量名，
 * 不剥注释的话门禁会拦下自己的说明文字。
 */
const FORBIDDEN = [
  {
    name: '侧栏呈现判定不得被硬编码',
    files: ['entry/src/main/ets/view/shell/AppShell.ets'],
    patterns: ['TrackPresentation\\.RAIL'],
    hint: '（呈现判定必须走 sidebarPresentation()，不许写常量）'
  },
  /*
   * 三端授权链不得按形态被排除（docs/157）。
   *
   * 【为什么是"结构"而不是"某一行"】这轮的缺陷是**两个相邻行合起来**才成立的：
   * `if (isHandheldForm()) {` 包住 `restoreFolderGrants(...)`，以及 pick 处把 PC 支
   * 写成不登记的占位对象（`{ persisted: false, note: '非手持档：不记授权' }`）。
   * 逐行规则看不见这种组合 ⇒ 这里用**多行**规则（`textPatterns`，在剥掉注释的整段
   * 正文上匹配），命中即报出**起止行号**，让下次的修法一眼看到是哪一处又分了档。
   */
  {
    name: '三端授权链不得按形态排除',
    files: [
      'entry/src/main/ets/entryability/EntryAbility.ets',
      'platform/src/main/ets/system/FilePicker.ets',
      'entry/src/main/ets/pages/WebApp.ets'
    ],
    patterns: [],
    hint: '（授权链必须三端同一套，见 docs/157）',
    textPatterns: [
      // 启动恢复被手持档闸门包住（旧实现的原形）
      'if\\s*\\(\\s*isHandheldForm\\(\\)\\s*\\)\\s*\\{[\\s\\S]{0,120}?restoreFolderGrants',
      // pick 处把授权登记按形态分叉（旧实现的原形：手持档才 remember）
      'handheld\\s*\\?\\s*await\\s+rememberFolderGrant',
      // 旧的"非手持档不记授权"占位读数（保留它 = 那条分支还在）
      '非手持档：不记授权'
    ]
  }
];

/**
 * 剥掉块注释与行注释（只做这一步：规则关心的常量名不会出现在字符串字面量里）。
 *
 * 【为什么把注释换成等量空白而不是直接删掉】删掉会让**行号整体前移**，报错指到别的行
 *（实测：真文件第 539 行的闸门被报成 248 行）⇒ 下次排查得自己倒推。换成空白后
 * 行号与真文件一一对应，`file:line` 可以直接跳过去。
 */
function stripComments(text) {
  const blank = (m) => m.replace(/[^\n\r]/g, ' ');
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

/**
 * 跑一遍全部判据，返回问题清单（空数组 = 全绿）。
 *
 * 【为什么收成函数】`--self-test` 的对照臂要在**同一条代码路径**上跑变异体：
 * 把变异体喂给另一份"简化版判据"，等于用另一份判据做实验 —— 那种对照臂是假的。
 */
function collectProblems() {
  const problems = [];
  for (const f of FEATURES) {
    for (const [pattern, min] of f.patterns) {
      const { n } = count(pattern);
      if (n < min) {
        problems.push(`  ✗ ${f.name}：接线 "${pattern}" 只找到 ${n} 处（期望 ≥${min}）`);
      }
    }
  }

  for (const rule of FORBIDDEN) {
    for (const rel of rule.files) {
      const src = sources.find((x) => x.path === rel);
      if (src === undefined) {
        problems.push(`  ✗ ${rule.name}：受检文件不存在 ${rel}`);
        continue;
      }
      // 注释先剥掉：本轮修复留下的说明文字里就写着被禁的形态（不剥 = 门禁拦自己的注释）
      const body = stripComments(src.text);
      const lines = body.split('\n');
      for (let i = 0; i < lines.length; i++) {
        for (const pattern of rule.patterns ?? []) {
          if (new RegExp(pattern).test(lines[i])) {
            problems.push(`  ✗ ${rule.name}：${rel}:${i + 1} 出现了 "${pattern.replace(/\\/g, '')}"`
              + (rule.hint ?? ''));
          }
        }
      }
      for (const pattern of rule.textPatterns ?? []) {
        const m = new RegExp(pattern).exec(body);
        if (m !== null) {
          const line = body.slice(0, m.index).split('\n').length;
          problems.push(`  ✗ ${rule.name}：${rel}:${line} 命中多行规则 `
            + `"${pattern.replace(/\\/g, '').slice(0, 60)}…"` + (rule.hint ?? ''));
        }
      }
    }
  }
  return problems;
}

/** 造一份"只改一个文件"的变异体（找不到锚点 = 对照臂自身失效，必须报红而不是静默跳过）。 */
function mutate(rel, search, replace) {
  const target = sources.find((s) => s.path === rel);
  if (target === undefined || target.text.indexOf(search) < 0) {
    throw new Error(`对照臂失效：${rel} 里找不到锚点 ${JSON.stringify(search.slice(0, 60))}`);
  }
  const copy = sources.map((s) => (s.path === rel
    ? { path: s.path, text: s.text.replace(search, replace) }
    : s));
  return copy;
}

/**
 * `--self-test`：把**已修好的形态**退回成旧的"按形态分档"形态，判据必须翻红。
 *
 * 【为什么必须有对照臂】只测"现在是绿的"证明不了判据有牙 —— 一个永远返回空的
 * 判据也是绿的。四条对照臂各自退回一处旧实现（启动闸门 / 未等待授权 / pick 分叉 / 采纳判据），
 * 少任何一条都得判红。
 */
if (process.argv.includes('--self-test')) {
  const ENTRY = 'entry/src/main/ets/entryability/EntryAbility.ets';
  const PICKER = 'platform/src/main/ets/system/FilePicker.ets';
  const WEBAPP = 'entry/src/main/ets/pages/WebApp.ets';
  const arms = [
    {
      name: '把启动恢复重新包进 isHandheldForm() 闸门',
      sources: mutate(ENTRY, '    this.folderGrantsReady = restoreFolderGrants(this.context).then(',
        '    if (isHandheldForm()) {\n      this.folderGrantsReady = restoreFolderGrants(this.context).then(')
    },
    {
      name: '宿主启动前不再等待目录授权恢复',
      // 【2026-11-05 锚点更新】启动等待改成了「let grants: string; … try { grants = await … } finally」，
      // 旧锚点 `const grants: string = await` 早已不在 ⇒ 对照臂注入失败把自检打成 rc=1。
      sources: mutate(ENTRY, '        grants = await this.folderGrantsReady;',
        "        grants = '不等待授权恢复';")
    },
    {
      name: '把 pick 处的授权登记退回"非手持档不记授权"',
      sources: mutate(PICKER, '  const granted: GrantOutcome = await rememberFolderGrant(context, uri, realPath);',
        "  const granted: GrantOutcome = handheld\n    ? await rememberFolderGrant(context, uri, realPath)\n"
        + "    : { persisted: false, note: '非手持档：不记授权' };")
    },
    {
      name: '把 PC 支的采纳判据退回"只看探写"',
      sources: mutate(WEBAPP, '      : (granted.persisted || probePathWritable(path));',
        '      : probePathWritable(path);')
    }
  ];
  const saved = sources;
  let failures = 0;
  for (const arm of arms) {
    sources = arm.sources;
    const problems = collectProblems();
    sources = saved;
    if (problems.length === 0) {
      failures += 1;
      console.log(`  ✗ 对照臂没判红：${arm.name}（判据无牙）`);
    } else {
      console.log(`  ✓ 对照臂判红：${arm.name}（${problems.length} 条）`);
      console.log(`      ${problems[0].trim()}`);
    }
  }
  console.log(`# 对照臂 ${arms.length - failures}/${arms.length} 通过`);
  process.exit(failures === 0 ? 0 : 1);
}

const problems = collectProblems();
console.log(`# 功能接线回归（扫描 ${files.length} 个文件，${FEATURES.length} 个功能，${FORBIDDEN.length} 条反面规则）`);
if (problems.length === 0) {
  console.log('✅ 全部功能的接线都在（中枢实现 + 界面调用点）。');
  process.exit(0);
}
console.log('发现断线或缺调用点：');
for (const p of problems) {
  console.log(p);
}
console.log('\n提示：构建查不出"调用点被删"——这正是本门禁存在的理由（见 E135/E258）。');
process.exit(1);
