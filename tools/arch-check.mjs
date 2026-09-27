/**
 * 架构回归门禁：上游接口细节不得泄漏出 `dshcompat`。
 *
 * 存在理由（D5 §1）：
 *   本项目的核心可维护性主张是「上游接口细节只允许出现在 `dshcompat` 一处」。
 *   这条主张如果没有门禁，就只是一句口号——而且**违反它不会有任何即时症状**：
 *   多写一处端点名字面量，代码照样编译、照样运行，直到上游改名那天才以
 *   「某个功能莫名其妙失效」的形式暴露，且极难定位。
 *
 * 为什么从 `grep` 升级成脚本：
 *   原先 CI 里是一条 `grep -rnE "session/|settings/|..."`。它有两个致命问题：
 *     1. **命中注释**：说明性文档里写端点名是必要的（否则文档没法写），
 *        于是门禁长期处于「一片红」的状态，人就开始忽略它——门禁失效。
 *     2. **无法自检**：没人能证明这条 grep 真的会命中，还是正则写错了永远不命中。
 *   本脚本因此做两件事：先**剥掉注释**再匹配，并内置**注入式自检**（`--self-test`）。
 *
 * 判定规则（两档，刻意区分）：
 *   - **端点名 / 事件名**（形如 `ns/method`）：唯一允许出现在 `dshcompat/**`。
 *     其它模块必须从 `dshcompat` 导入，不得复制字面量。
 *   - **上游线上字段名**（`requestId`、`entries`、`receiptId` …）：允许出现在
 *     `dshcompat/**` 与 `appstate/src/main/ets/model/Wire.ets`——
 *     后者是「事实 → 类型化请求/回复绑定」的唯一转换点。
 *     本脚本只强制第一档（字段名没有可靠的正则判据，强行匹配会大量误报，
 *     而误报的门禁等于没有门禁）。
 *
 * 用法：
 *   node tools/arch-check.mjs              # 检查，有违规则非零退出
 *   node tools/arch-check.mjs --self-test  # 自检：证明检测器真的会命中
 *   node tools/arch-check.mjs --list       # 额外打印被扫描的文件数
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();

/**
 * 被扫描的源码根（相对于仓库根）。
 *
 * 为什么**不含** `hostkit/`：`hostkit` 是独立的、可选的 PC 侧搭桥服务（Node 包，
 * 有自己的测试与发布面）。它的职责之一是「以受管方式拉起并守护本机 dsh Host」，
 * 因此**合法地**知道上游的启动面（`dsh web` 的调用方式与它打印的启动行格式）。
 * 把 `hostkit` 纳进来会迫使它把这些知识藏到一个不属于它的模块里，
 * 反而破坏分层。客户端四层（connection / dshcompat / appstate / platform / entry）
 * 才是「上游知识只允许出现在 dshcompat」这条纪律的适用范围。
 */
const SCAN_ROOTS = [
  'connection/src',
  'appstate/src',
  'platform/src',
  'entry/src/main/ets'
];

/** 唯一允许持有上游接口字面量的模块目录 */
const ALLOWED_DIR = `${sep}dshcompat${sep}`;

/**
 * 上游接口名模式。
 *
 * 只匹配**字符串字面量内部**的 `ns/method` 形态：先匹配引号再匹配名字，
 * 这样普通的运算式（如 `a / b`）不会被误判。
 *
 * 【命名空间表必须按实测清单维护】
 *   本表曾只含**端点**命名空间（照 D2 §8.5 的 74 个端点写的），
 *   于是对**事件**命名空间基本失明：一次真实的违规里 9 处只报出 4 处，
 *   漏掉的正是 `user/message`、`assistant/message`、`tool/call`、
 *   `subagent/catalog`、`todo/write` 这些当时不在表内的前缀。
 *   现已按 D2 §8.7.7 的 32 种实测事件类型补齐。
 *
 *   复核（2026-09-11）：上一轮补齐后**仍然漏了两个**命名空间——
 *   `deliverables/` 与 `permission/` 在表外，于是它们的事件名可以自由泄漏。
 *   再次说明：门禁"通过"不等于"覆盖到了"。
 *
 *   教训：门禁的**覆盖面本身**也需要被审视。一个"通过"的门禁可能只是
 *   因为它不认识那些名字——这与"门禁失效"是同一种危险，但更难察觉。
 */
const NAMESPACE = [
  // 端点命名空间（D2 §8.5 / §8.7.1）
  'session', 'settings', 'workspace', 'workspaceFiles', 'pluginInventory', 'credentials',
  'fileUploads', 'goals', 'subagents', 'commands', 'skills', 'llm', 'agentPresets',
  'directoryPicker', 'fileReferences', 'messageFeedback', 'sessionFeedback',
  'dynamicCordisRunner', 'sessionReferenceResolver',
  // 转发事件命名空间（D2 §8.7.4）
  'api-session', 'approval', 'user-questions', 'cordis', 'agent-preset',
  // 会话事件命名空间（D2 §8.7.7 的 32 种实测类型）
  'user', 'assistant', 'system', 'tool', 'deliverables', 'subagent', 'goal', 'todo',
  'compaction', 'request', 'step', 'turn', 'agent', 'command', 'web', 'permission',
  'sandbox',
  // 网关内部端点
  'gateway'
].join('|');

const NAME_PATTERN = new RegExp(
  `(['"\`])((?:${NAMESPACE})/[A-Za-z$][A-Za-z0-9$-]*)\\1`,
  'g'
);

/**
 * 剥掉注释，保留换行与字符位置。
 *
 * 必须是「懂字符串」的状态机，不能简单正则替换：
 * 代码里有 `'http://127.0.0.1:3000'` 这样的字符串，朴素地找 `//` 会把后半行误当注释剥掉，
 * 从而漏掉真正的违规。字符串内还要处理转义。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let state = 'code'; // code | line | block | string
  let quote = '';
  let escaped = false;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (ch === '/' && next === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { state = 'string'; quote = ch; out += ch; i++; continue; }
      out += ch; i++; continue;
    }
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; out += ch; } else { out += ' '; }
      i++; continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += ch === '\n' ? '\n' : ' ';
      i++; continue;
    }
    // string
    out += ch;
    if (escaped) { escaped = false; }
    else if (ch === '\\') { escaped = true; }
    else if (ch === quote) { state = 'code'; }
    i++;
  }
  return out;
}

/** 递归收集 .ets 文件 */
function collect(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'build' || e.name === 'oh_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) collect(p, acc);
    else if (e.isFile() && e.name.endsWith('.ets')) acc.push(p);
  }
  return acc;
}

/** 在给定文本里找出所有上游接口名字面量（供主流程与自检共用） */
export function findViolations(text) {
  const stripped = stripComments(text);
  const found = [];
  const lines = stripped.split('\n');
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    NAME_PATTERN.lastIndex = 0;
    let m;
    while ((m = NAME_PATTERN.exec(line)) !== null) {
      found.push({ line: ln + 1, name: m[2], column: m.index + 1 });
    }
  }
  return found;
}

/** 自检：注入式负测试，证明检测器真的会命中（未被负测试验证的门禁等于没有门禁） */
function selfTest() {
  const cases = [
    { text: `const x = 'session/list';`, want: 1, why: '普通字符串字面量必须命中' },
    { text: `const x = 'session/list'; // 注释里的 session/create`, want: 1, why: '行注释里的名字不得重复计数' },
    { text: `// session/list\nconst y = 1;`, want: 0, why: '纯注释行不得命中' },
    { text: `/* session/list\n   session/prompt */\nconst y = 1;`, want: 0, why: '块注释不得命中' },
    { text: `const url = 'http://127.0.0.1:3000/api'; const z = 1;`, want: 0, why: 'URL 里的 // 不得被当成注释剥掉后半行' },
    { text: `const a = 1 / 2; const s = 'workspaceFiles/list';`, want: 1, why: '除法运算符不得干扰匹配' },
    { text: 'const s = "approval/request";', want: 1, why: '双引号字符串必须命中' },
    {
      text: "const s = 'user/message';",
      want: 1,
      why: '实测事件前缀 user/ 必须被覆盖（曾因表里没有它而漏报真实违规）'
    },
    {
      text: "const s = 'tool/call';",
      want: 1,
      why: '实测事件前缀 tool/ 必须被覆盖（同上）'
    },
    { text: `import { SESSION_LIST_ENDPOINT } from 'dshcompat';`, want: 0, why: '从 dshcompat 导入常量是正确写法，不得命中' }
  ];
  let failed = 0;
  for (const c of cases) {
    const got = findViolations(c.text).length;
    const ok = got === c.want;
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  期望 ${c.want} 实际 ${got}  ${c.why}`);
  }
  console.log(failed === 0
    ? '\n✅ 自检通过：检测器在 8 个正/负样例上都符合预期。'
    : `\n❌ 自检失败 ${failed} 项——门禁不可信，不得据此判断架构是否合规。`);
  process.exit(failed === 0 ? 0 : 1);
}

const argv = process.argv.slice(2);
if (argv.includes('--self-test')) {
  console.log('# 架构门禁自检（注入式负测试）\n');
  selfTest();
}

const files = [];
for (const r of SCAN_ROOTS) {
  const abs = join(ROOT, r);
  try {
    statSync(abs);
  } catch {
    continue;
  }
  collect(abs, files);
}

const violations = [];
for (const f of files) {
  const rel = relative(ROOT, f);
  // dshcompat 本身就是上游事实的唯一落点，跳过
  if (`${sep}${rel}`.includes(ALLOWED_DIR) || rel.startsWith('dshcompat')) continue;
  const text = readFileSync(f, 'utf8');
  for (const v of findViolations(text)) {
    violations.push({ file: rel.replace(/\\/g, '/'), ...v });
  }
}

console.log('# 架构回归门禁：上游接口细节不得泄漏出 dshcompat\n');
console.log(`扫描文件 ${files.length} 个（${SCAN_ROOTS.join(', ')}）`);
if (argv.includes('--list')) {
  for (const f of files) console.log(`  ${relative(ROOT, f).replace(/\\/g, '/')}`);
  console.log('');
}

if (violations.length === 0) {
  console.log('✅ 无违规：除 dshcompat 外没有任何模块持有上游端点名/事件名字面量。');
  process.exit(0);
}

console.log(`❌ 检测到 ${violations.length} 处违规（注释内的说明性提及不计）：\n`);
for (const v of violations) {
  console.log(`  ${v.file}:${v.line}:${v.column}  ${v.name}`);
}
console.log('\n处置：从 `dshcompat` 导入既有常量；若该名字尚未在 dshcompat 中声明，');
console.log('      先在那里以「上游事实」的形式加入（附依据出处），再于此处导入。');
process.exit(1);
