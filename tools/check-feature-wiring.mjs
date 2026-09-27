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
const sources = files.map((f) => ({ path: relative(ROOT, f).replace(/\\/g, '/'), text: readFileSync(f, 'utf8') }));

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
  { name: '侧栏收起', patterns: [['sidebarPresentationOf', 2], ['onToggleSidebarExpanded', 2], ['showExpandToggle', 2]] }
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
    patterns: ['TrackPresentation\\.RAIL']
  }
];

/** 剥掉块注释与行注释（只做这一步：规则关心的常量名不会出现在字符串字面量里） */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const problems = [];
for (const f of FEATURES) {
  for (const [pattern, min] of f.patterns) {
    const { n, where } = count(pattern);
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
    const body = stripComments(src.text);
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const pattern of rule.patterns) {
        if (new RegExp(pattern).test(lines[i])) {
          problems.push(`  ✗ ${rule.name}：${rel}:${i + 1} 出现了 "${pattern.replace(/\\/g, '')}"`
            + '（呈现判定必须走 sidebarPresentation()，不许写常量）');
        }
      }
    }
  }
}

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
