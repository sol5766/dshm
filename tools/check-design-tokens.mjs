/**
 * 设计令牌门禁（P1，计划 §6）：不让"新的裸魔数"继续进来。
 *
 * 存在理由：
 *   计划 §6 要求「优先使用设计 token」，并点名四类不该再散落的写法：
 *   `.fontSize(...)` / `.borderWidth(...)` / `.backgroundColor(...)` / `.borderRadius(...)` 的**字面量**。
 *   但这条要求如果不落成门禁，就只是一个愿望——加一个新的 `.fontSize(15)` 不会让任何东西失败，
 *   它的代价（"到底还有几档字号？"永远说不清）要很久以后才显现。
 *
 * 【为什么用"棘轮"而不是"一刀切禁止"】本仓当前仍有存量裸值（图标尺寸、少量圆角、颜色字面量），
 * 其中**图标尺寸的收敛会改变视觉，必须真机验收**（见 docs/parity-matrix.md 的缺口登记）。
 * 一刀切会立刻几百处红，而那正是本项目明确警惕的失败模式：**永远红的门禁等于没有门禁**。
 * 因此基线记录"每个文件当前有几处"，门禁只保证**这个数字不再变大**；
 * 修掉存量后可用 `--update-baseline` 把基线调低（棘轮只往一个方向转）。
 *
 * 豁免：行尾写 `// token-exempt: 理由` 即不计入（例如系统符号的几何尺寸），
 *       但**必须写理由**——豁免本身也是一种设计决定，不该匿名。
 *
 * 退出码：0 通过；1 出现新的裸值；3 环境受阻（基线缺失）。
 *
 * 用法：
 *   node tools/check-design-tokens.mjs                 # 检查（棘轮）
 *   node tools/check-design-tokens.mjs --list          # 列出每处裸值
 *   node tools/check-design-tokens.mjs --update-baseline  # 存量下降后下调基线
 *   node tools/check-design-tokens.mjs --self-test     # 注入式自检：证明判定会失败
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const BASELINE = join(ROOT, 'tools', 'design-token-baseline.json');
const SCAN_DIRS = ['entry/src/main/ets', 'appstate/src/main/ets'];

/** 四类裸值：属性名 + 值必须是**字面量数字/颜色**（token 是标识符，不会命中） */
const PATTERNS = [
  { id: 'fontSize', re: /\.fontSize\(\s*\d+(?:\.\d+)?\s*\)/ },
  { id: 'lineHeight', re: /\.lineHeight\(\s*\d+(?:\.\d+)?\s*\)/ },
  { id: 'borderRadius', re: /\.borderRadius\(\s*\d+(?:\.\d+)?\s*\)/ },
  { id: 'borderWidth', re: /\.borderWidth\(\s*\d+(?:\.\d+)?\s*\)/ },
  // 【覆盖面的教训】首版只匹配 `'#hex'` 与 `Color.X`，于是 **`'rgba(0,0,0,0.35)'` 这类函数式颜色被漏掉**——
  // 实测手写浮层里就有一个硬编码遮罩。门禁"通过"不等于"覆盖到了"，所以这里把 rgb/rgba/hsl 一并纳入，
  // 并加了对应的自检样例。颜色**资源**（`$r('sys.color.*')`）不是字面量，仍然不命中。
  { id: 'colorLiteral', re: /\.(?:backgroundColor|fontColor|borderColor)\(\s*(?:'#[0-9a-fA-F]{3,8}'|'rgba?\([^']*\)'|'hsla?\([^']*\)'|Color\.(?!Transparent)[A-Z]\w*)/ }
];

const EXEMPT = /\/\/\s*token-exempt:\s*\S+/;

/** 递归收集 .ets */
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
    if (e.isDirectory()) out.push(...collect(p));
    else if (e.name.endsWith('.ets')) out.push(p);
  }
  return out;
}

/**
 * 统计裸值（纯函数，供自检注入样例）。
 * 注释行整行跳过；行尾 `// token-exempt: 理由` 跳过。
 */
export function scanText(text, fileForReport) {
  const found = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const s = line.trimStart();
    if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) continue;
    if (EXEMPT.test(line)) continue;
    for (const p of PATTERNS) {
      if (p.re.test(line)) found.push({ file: fileForReport, line: i + 1, kind: p.id, text: line.trim() });
    }
  }
  return found;
}

/** 扫描整个仓库，返回 文件 → 处数 */
export function scanRepo() {
  const perFile = {};
  const details = [];
  for (const d of SCAN_DIRS) {
    for (const f of collect(join(ROOT, d))) {
      const rel = relative(ROOT, f).replace(/\\/g, '/');
      const hits = scanText(readFileSync(f, 'utf8'), rel);
      if (hits.length) {
        perFile[rel] = hits.length;
        details.push(...hits);
      }
    }
  }
  return { perFile, details };
}

function selfTest() {
  const cases = [
    { why: '裸字号必须命中', text: 'Text(x).fontSize(15)', want: 1 },
    { why: 'token 写法不得命中', text: 'Text(x).fontSize(Fs.BODY)', want: 0 },
    { why: '裸圆角必须命中', text: '.borderRadius(6)', want: 1 },
    { why: '裸描边必须命中', text: '.borderWidth(1)', want: 1 },
    { why: '颜色字面量必须命中', text: "Text(x).fontColor('#ff0000')", want: 1 },
    { why: 'Color.Red 必须命中', text: '.fontColor(Color.Red)', want: 1 },
    { why: 'rgba() 字面量必须命中（首版漏检过）', text: ".backgroundColor('rgba(0,0,0,0.35)')", want: 1 },
    { why: 'rgb()/hsl() 同理', text: ".backgroundColor('hsl(0,0%,0%)')", want: 1 },
    { why: '语义资源不得命中', text: ".fontColor($r('sys.color.alert'))", want: 0 },
    { why: '整行注释不得命中', text: '// Text(x).fontSize(15)', want: 0 },
    { why: '块注释行不得命中', text: ' * Text(x).fontSize(15)', want: 0 },
    { why: '写了理由的豁免不得命中', text: 'Text(x).fontSize(15) // token-exempt: 系统符号几何尺寸', want: 0 },
    { why: '豁免没写理由（只有 token-exempt:）不得豁免', text: 'Text(x).fontSize(15) // token-exempt:', want: 1 }
  ];
  let failed = 0;
  for (const c of cases) {
    const got = scanText(c.text, '<self-test>').length;
    const ok = got === c.want;
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  期望 ${c.want} 实际 ${got}  ${c.why}`);
  }
  console.log(failed === 0
    ? `\n✅ 判定器自检通过（${cases.length} 个样例）。`
    : `\n❌ 判定器自检失败 ${failed} 项——门禁不可信。`);
  process.exit(failed === 0 ? 0 : 1);
}

const argv = process.argv.slice(2);
if (argv.includes('--self-test')) {
  console.log('# 设计令牌门禁 · 判定器自检\n');
  selfTest();
}

const { perFile, details } = scanRepo();
const total = details.length;

if (argv.includes('--update-baseline')) {
  mkdirSync(join(ROOT, 'tools'), { recursive: true });
  const body = {
    note: '设计令牌棘轮基线：每个文件的裸值处数上限。只允许下降（改完存量后跑 --update-baseline 下调）。',
    generatedAt: new Date().toISOString().slice(0, 10),
    total,
    files: Object.fromEntries(Object.entries(perFile).sort(([a], [b]) => a.localeCompare(b)))
  };
  writeFileSync(BASELINE, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  console.log(`基线已写入 tools/design-token-baseline.json：${Object.keys(perFile).length} 个文件 / ${total} 处`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error('环境受阻：缺少基线 tools/design-token-baseline.json。');
  console.error('  首次建立：node tools/check-design-tokens.mjs --update-baseline');
  console.error('  ⚠️ 退出码 3 = 没跑成，不是通过。');
  process.exit(3);
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));

console.log('# 设计令牌门禁（棘轮：裸值只许变少）\n');
console.log(`扫描 ${SCAN_DIRS.join(' + ')}`);
console.log(`当前 ${total} 处裸值 / ${Object.keys(perFile).length} 个文件；基线 ${baseline.total} 处 / ${Object.keys(baseline.files).length} 个文件`);

if (argv.includes('--list')) {
  console.log('');
  for (const d of details) console.log(`  ${d.file}:${d.line}  [${d.kind}]  ${d.text.slice(0, 90)}`);
}

const problems = [];
for (const [f, n] of Object.entries(perFile)) {
  const base = baseline.files[f];
  if (base === undefined) problems.push(`  ✗ ${f}：新增文件带 ${n} 处裸值（基线里没有它）`);
  else if (n > base) problems.push(`  ✗ ${f}：裸值 ${base} → ${n}（变多了）`);
}
const improved = Object.entries(perFile)
  .filter(([f, n]) => baseline.files[f] !== undefined && n < baseline.files[f])
  .map(([f, n]) => `${f} ${baseline.files[f]}→${n}`);
for (const f of Object.keys(baseline.files)) {
  if (perFile[f] === undefined) improved.push(`${f} ${baseline.files[f]}→0（已清零）`);
}

if (problems.length === 0) {
  console.log('\n✅ 通过：没有新增裸值。');
  if (improved.length) {
    console.log(`\n📉 存量下降（可跑 --update-baseline 把棘轮调紧）：`);
    for (const i of improved) console.log(`  ${i}`);
  }
  console.log(`\n提示：本门禁只管"不再变多"；要把某处裸值换成语义 token，见 appstate/ui/Tokens.ets。`);
  console.log(`      图标尺寸等**会改变视觉**的收敛需真机验收，见 docs/parity-matrix.md 缺口登记。`);
  process.exit(0);
}

console.log(`\n❌ 检测到 ${problems.length} 处新增裸值：\n`);
for (const p of problems) console.log(p);
console.log('\n处置：换成 appstate/ui/Tokens.ets 里的 token（Fs / Sp / Radius / Border / SemanticColor…）。');
console.log('      确实不该 token 化的（如系统符号几何尺寸），行尾写 `// token-exempt: 理由`。');
process.exit(1);
