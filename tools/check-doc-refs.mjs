/**
 * 文档引用门禁：`docs/*.md` 内「文件:行号」的引用，必须仍落在它声称的那一节上。
 *
 * ## 存在理由（2026-09-28 实测）
 *
 * 这一轮 `docs/70` 增删较多，用一次性核对脚本在带行号的引用里抓出 **6 处真实漂移**
 * （声称的节 与 行号实际落到的节 不是同一节，已全部改正）：
 *
 *   | 引用位置 | 声称 | 指向 | 实际落在 | 本门禁能否守 |
 *   |---|---|---|---|---|
 *   | `docs/90:1680` | §8.13 | `docs/70:802` | **§8.2**  | ✅ 守（`§X（FILE:N）` 形态） |
 *   | `docs/90:4171` | §8.2  | `docs/70:726-736` | **§7.9** | ✅ 守（`FILE:N（§X）` 形态） |
 *   | `docs/90:4010` | §3.6  | `docs/70:1096` | **§11.7** | ⚠️ 不守（声称写成 `本章 §3.6`⇒判为自引用） |
 *   | `docs/90:4011` | §3.2  | `docs/70:1090` | **§11.6** | ⚠️ 同上 |
 *   | `docs/90:4484` | §5.3  | `docs/70:719` | **§7.9** | ⚠️ 同上 |
 *   | `docs/90:5168` | §3.1  | `docs/50:2078` | **§15.4** | ⚠️ 同上 |
 *
 * 后四处**故意不守**：它们把"本文档自己的节号"和"别的文档的行号"写在同一行，
 * 靠距离猜归属会猜错（一次性脚本当初正是靠猜，才同时报出大量假阳性）。
 * 本门禁只守**归属无歧义**的写法 —— 宁可少守，也不许把假阳性塞给人看。
 *
 * 为什么必须有门禁：这类漂移**不会让任何构建失败**。读者按「文件:行号」跳过去，
 * 看到的是**另一节**——要么读到无关内容，要么以为那条结论已被删掉。
 * 而它只在文档增删之后出现，文档增删恰恰是没人跑门禁的时刻（同族教训见
 * `docs/70` §8.13「写死总数」与 §8.10「硬编码清单升级静默失效」）。
 *
 * ## 判据
 *   A 落点：引用覆盖到的节，必须包含与它**相邻**声称的 `§A.B`。
 *   B 存在：被引文件必须存在（挡住"指向已删文档"的悬引用）。
 *   C 界内：行号不得超过被引文件行数。
 *   D 次序：`N-M` 必须 N ≤ M。
 *   E 编号：`docs/NN` 必须唯一对应一个文档（短式引用才可解析）。
 *   F 不可核对：**不得**对"不在判定集内"的文档写行号 —— `` `AGENTS.md:N` `` / `` `README.md:N` ``。
 *     理由：这类引用既不是 `docs/` 内的互引、也不在被引判定集内 ⇒ **行号无人核对、必然无声腐烂**。
 *     实测事故（2026-10-05 收尾审计）：`AGENTS.md` 一次增行 35 行，`docs/90` 里 **16 处**
 *     `AGENTS.md:N` 引用**全部指错**，而当时没有任何门禁能挡（本条是那次审计补的）。
 *     处置：去掉行号（推荐 —— `AGENTS.md` 的节标题就是稳定锚点），或把该文件纳入判定集。
 *
 * ## 认哪些写法（其余一律不看 ⇒ 不会误报）
 *   引用目标：`docs/70:878`（短式）｜`docs/70-…md:878`｜`70-…md:878`（全名）
 *   续写：紧接的 `、`/`，`/`,` + 行号（如 `` `docs/70:892-946`、`:976-987` ``），
 *         以及独立成反引号段的 `` `:976-987` ``、`` `:105` ``。
 *   声称：**相邻**的 `§A.B`。相邻 = 中间只隔反引号/空格/括号。
 *         两种语序都认：`` `FILE:N`（§A.B） `` 与 `§A.B（FILE:N）`。
 *   自引用：`§A.B` 前带「本章 / 见 / 详见 / 本节」⇒ 不算对被引文档的声称（跳过）。
 *   ⇒ `README.md`、`AGENTS.md`、`tools/xxx.mjs:20` 这类**不参与判定**：
 *     既不在本文档集内，也不是"`docs/` 内的互引"。
 *
 * ## 已知边界（如实记，不假装更全）
 *   - 不带行号的引用（`docs/70-…md`、`docs/70`）无从核对，**不在判据内**。
 *   - 被引文件没有"数字编号标题"时，判据 A 自动跳过，只做 B/C/D。
 *   - 含省略号的省写（`docs/70-…md`）无法解析，跳过。
 *   - 全名形态只认 `NN-….md`（左边界须为行首/反引号/斜杠等）。因此 `docs/` 下的
 *     **非编号文档名**（如 `review-report-2026-09-29.md`）**不在判据内**：不解析、
 *     不报错——这是刻意的，之前它会被当成文件名中段的 `26-09-29.md` 而假报 B。
 *
 * ## 用法
 *   node tools/check-doc-refs.mjs              # 检查，有问题则非零退出
 *   node tools/check-doc-refs.mjs --self-test  # 注入式自检：证明检测器真的会红
 *   node tools/check-doc-refs.mjs --list       # 打印每条引用及其落点
 *
 * 退出码：0 干净 / 1 有问题 / 2 前置条件不成立（找不到 `docs/`）。
 *
 * 注：仓库根由**脚本自身位置**推出，不依赖 cwd —— 本轮曾因 cwd 不在仓库根，
 * 让两条门禁报出「找不到矩阵」的假红（见 `docs/90` §2.4）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const NUM = '(\\d+)(?:\\s*[-–~]\\s*(\\d+))?';
/** 行号之后允许紧跟的字符：分隔符 / 收尾符 / 行尾。**不含空格**，以免把「，3 条」算成行号。 */
const AFTER = '(?=[,，、；;)\\]）】|。`]|$)';
/** 「相邻」允许的噪声字符：反引号、空格、开括号。 */
const NOISE = '[\\s`（(【\\[]{0,4}';
/** 全名形态：`70-鸿蒙移植踩坑与修复总览.md`。 */
const FULLNAME = '(?<![\\w.\\-])[0-9]{2}-[^\\s:：`()\\[\\]，、]+?\\.md';
/**
 * 引用目标。两条分支都必须匹配到一处**文档名**：
 *   ① 全名 `70-…md`（`docs/` 前缀可省）；
 *   ② 短式 `70` —— **必须**带 `docs/` 前缀。
 *
 * ② 的前缀是 2026-09-28 补上的硬要求。原先短式也允许省前缀，于是**任何**
 * 「两位数字 + 冒号 + 数字」都被当成引用目标：实测 188 处报错里，141 处是
 * 时间戳（`` `14:11:07.000` ``）、另有 IP 片段（`192.168.1.50:3111`）、
 * 界面读数（`` `09:41 · 3.2s` ``）与**代码行号**（`main.js:1139`、`:1849-1866`）。
 * 这些写法里的"被引文件"当然不存在 ⇒ 门禁把结论引向了错误方向
 * （不是文档坏了，是判据坏了）。要求前缀即可全部消掉，因为真实引用**都带前缀**。
 *
 * **全名排在前面的分支**：否则 `docs/10-协议兼容事实基线.md:24` 会被短式先吃掉
 * `10`，后面的 `:24` 不再紧跟，整条引用就退化成"无声称"而被静默跳过。
 */
const NAME = `(?:(?:docs[\\\\/])?(${FULLNAME})|docs[\\\\/]([0-9]{2}))`;
/** 纯行号段（用于识别续写）：`:976-987`、`,268,275`、`:105`。 */
const BARE_SPAN = /^[:：,，、]?\s*\d+(\s*[-–~]\s*\d+)?(\s*[,，、]\s*[:：]?\s*\d+(\s*[-–~]\s*\d+)?)*$/;

// ── 纯函数部分（可被自检复用） ───────────────────────────────────────

/** 「行号 → 节号」表：只认数字编号标题（`## 8.1 x` ⇒ `8.1`；`## 9. 表` ⇒ `9`）。 */
export function headingMap(lines) {
  const out = [];
  lines.forEach((l, i) => {
    const m = l.match(/^#{2,4}\s+(\d+(?:\.\d+)*)/);
    if (m) out.push([i + 1, m[1]]);
  });
  return out;
}

/** 第 n 行所属的节（它之前最近的编号标题）。 */
export function sectionAt(heads, n) {
  let s = '?';
  for (const [ln, id] of heads) {
    if (ln <= n) s = id;
    else break;
  }
  return s;
}

/** a..b 覆盖到的全部节（引一段跨节内容是合法的，故返回集合）。 */
export function sectionsInRange(heads, a, b) {
  const out = [];
  for (let n = a; n <= b; n++) {
    const s = sectionAt(heads, n);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * 本行的「引用目标」与「声称」。返回按出现位置排序的 items：
 *   { kind:'mention', raw(解析用名), label(原样), start, end, a|null, b|null }
 *   { kind:'bare',    label, start, end, a, b }   ← 续写行号，归属"前一个 mention"
 *   { kind:'claim',   id, start, end }            ← 非自引用的 §X.Y
 */
export function parseLine(line) {
  const items = [];
  const spans = [];
  for (const m of line.matchAll(/`([^`]*)`/g)) {
    spans.push({ start: m.index, end: m.index + m[0].length, inner: m[1] });
  }
  /** 独立成反引号段的续写：`` `:976-987` `` / `` `,268,275` `` / `` `:105` `` */
  const bareSpans = [];
  for (const s of spans) {
    if (!new RegExp(`^[:：]?\\s*\\d+(\\s*[-–~]\\s*\\d+)?(\\s*[,，、]\\s*[:：]?\\s*\\d+(\\s*[-–~]\\s*\\d+)?)*$`).test(s.inner.trim())) continue;
    bareSpans.push(s);
  }

  // 组号：m[1] 全名（不含 docs/ 前缀）、m[2] 短式两位数字、m[3]/m[4] 行号区间。
  // **不要**再在外面套 `(?:docs[\/])?(...)`：NAME 内部已各自处理前缀，
  // 外套一层会让全名分支把 `docs/` 一起捕进 raw ⇒ byName 查不到 ⇒ 所有全名引用假报 B。
  const reName = new RegExp(`${NAME}(?::${NUM})?`, 'g');
  let m;
  while ((m = reName.exec(line))) {
    const raw = m[1] !== undefined ? m[1] : m[2];
    if (raw === undefined) continue;
    const label = m[0];
    if (raw.includes('…')) continue; // 省写，解析不了
    const hasNum = m[3] !== undefined;
    const item = {
      kind: 'mention', raw, label, start: m.index, end: m.index + m[0].length,
      a: hasNum ? +m[3] : null,
      b: hasNum ? (m[4] !== undefined ? +m[4] : +m[3]) : null,
    };
    items.push(item);
    // 紧接的续写：`、:976-987` / `,268` / `，275`（允许被反引号包住）
    const reTail = new RegExp(`^\`?\\s*[,，、；;]\\s*\`?\\s*[:：]?\\s*${NUM}${AFTER}`);
    let i = item.end;
    for (;;) {
      const t = reTail.exec(line.slice(i));
      if (!t) break;
      items.push({
        kind: 'bare', label: `${label} 的续写`, start: i, end: i + t[0].length,
        a: +t[1], b: t[2] !== undefined ? +t[2] : +t[1],
      });
      i += t[0].length;
    }
  }
  // 独立反引号段里的续写：整段只含行号 ⇒ 全部归前一个 mention
  for (const s of bareSpans) {
    if (items.some((it) => it.kind === 'mention' && it.start >= s.start && it.end <= s.end)) continue;
    // 判重必须用**区间相交**，不能用包含：紧接续写的匹配会把前一段的收尾反引号
    // 一起吃掉（`…:4`、`:6` 里那对反引号），于是 bare item 的 start 落在
    // span.start 的**前一个字符**上，包含判据恒为假 ⇒ 同一条续写被记两次。
    if (items.some((it) => it.kind === 'bare' && it.start < s.end && it.end > s.start)) continue;
    const re = new RegExp(`[:：]?\\s*${NUM}`, 'g');
    let t;
    while ((t = re.exec(s.inner))) {
      items.push({
        kind: 'bare', label: `反引号段 ${s.inner}`, start: s.start + t.index, end: s.start + t.index + t[0].length,
        a: +t[1], b: t[2] !== undefined ? +t[2] : +t[1],
      });
    }
  }
  // 声称：非自引用的 §X.Y
  for (const c of line.matchAll(/§(\d+(?:\.\d+)*)/g)) {
    const before = line.slice(0, c.index);
    if (/(本章|见|详见|本节)\s*$/.test(before)) continue;
    items.push({ kind: 'claim', id: c[1], start: c.index, end: c.index + c[0].length });
  }
  return items.sort((x, y) => x.start - y.start);
}

/** 把 items 折成「记录 + 相邻声称」。返回 [{raw, a, b, claim|null}] */
export function recordsOf(items, line) {
  const claims = items.filter((i) => i.kind === 'claim');
  const out = [];
  let host = null;
  for (const it of items) {
    if (it.kind === 'mention') {
      host = it.raw;
      if (it.a === null) continue;
      out.push({ raw: it.raw, a: it.a, b: it.b, start: it.start, end: it.end, claim: adjacent(claims, it) });
    } else if (it.kind === 'bare' && host !== null) {
      out.push({ raw: host, a: it.a, b: it.b, start: it.start, end: it.end, claim: adjacent(claims, it) });
    }
  }
  return out;
}

/**
 * 与某条引用**相邻**的声称：优先"紧跟其后"（`FILE:N（§X）`），其次"紧贴其前"（`§X（FILE:N）`）。
 * 相邻 = 中间的字符只可能是反引号 / 空格 / 括号（`NOISE`）。
 */
function adjacent(claims, item) {
  const after = claims.find((c) => {
    if (c.start < item.end) return false;
    return new RegExp(`^${NOISE}$`).test(join_noise(item, c));
  });
  if (after) return after.id;
  const before = [...claims].reverse().find((c) => {
    if (c.end > item.start) return false;
    return new RegExp(`^${NOISE}$`).test(join_noise(c, item));
  });
  return before ? before.id : null;
}

// 相邻性判定要看到原行文本，故由 recordsOf 注入；这里用极小的闭包避免改签名。
let LINE = '';
function join_noise(from, to) {
  return LINE.slice(from.end, to.start);
}

/**
 * 扫描文档源，返回 { issues, records }。
 * @param {Array<{name: string, lines: string[]}>} sources `name` 是 `docs/` 下的文件名。
 */
export function scanSources(sources) {
  const byName = new Map();
  const byNum = new Map();
  for (const s of sources) {
    byName.set(s.name, { name: s.name, lines: s.lines, heads: headingMap(s.lines) });
    const num = s.name.match(/^(\d{2})-/);
    if (!num) continue;
    if (!byNum.has(num[1])) byNum.set(num[1], []);
    byNum.get(num[1]).push(s.name);
  }
  const resolve = (raw) => {
    if (/^[0-9]{2}$/.test(raw)) {
      const hits = byNum.get(raw);
      if (!hits || hints_empty(hits)) return { missing: true };
      if (hits.length > 1) return { ambiguous: hits };
      return { target: byName.get(hits[0]) };
    }
    const t = byName.get(raw);
    return t ? { target: t } : { missing: true };
  };

  const issues = [];
  const records = [];
  for (const src of sources) {
    src.lines.forEach((line, i) => {
      const at = i + 1;
      if (!/§|:\d/.test(line)) return;
      LINE = line;
      // 判据 F：不许对"不在判定集内"的文档写行号（见文件头「F 不可核对」）。
      // 【为什么必须在 scanSources 内】自检也走这条路径 ⇒ 否则这条判据没有变异用例证明它会红。
      for (const m of line.matchAll(/`((?:AGENTS|README)\.md):(\d+)(?:-(\d+))?`/g)) {
        issues.push({
          where: `${src.name}:${at}  引用 ${m[1]}:${m[2]}`,
          kind: 'F 不可核对',
          detail: `${m[1]} 不参与行号判定 ⇒ 该行号无人核对、必然腐烂；请去掉行号，或改引它的节标题`,
        });
      }
      const items = parseLine(line);
      for (const r of recordsOf(items, line)) {
        const res = resolve(r.raw);
        const where = `${src.name}:${at}  引用 ${r.raw}:${r.a === r.b ? r.a : `${r.a}-${r.b}`}`;
        records.push({
          file: src.name, at, raw: r.raw, a: r.a, b: r.b,
          target: res.target?.name ?? (res.ambiguous ? `（歧义：${res.ambiguous.join(' / ')}）` : '（缺失）'),
          claim: r.claim,
        });
        if (res.missing) { issues.push({ where, kind: 'B 存在', detail: `被引文件不存在：${r.raw}` }); continue; }
        if (res.ambiguous) { issues.push({ where, kind: 'E 编号', detail: `${r.raw} 对应多个文档（${res.ambiguous.join('、')}），短式引用无法解析` }); continue; }
        const t = res.target;
        if (r.a > r.b) { issues.push({ where, kind: 'D 次序', detail: `起止反了（${r.a} > ${r.b}）` }); continue; }
        if (r.b > t.lines.length) { issues.push({ where, kind: 'C 界内', detail: `${t.name} 只有 ${t.lines.length} 行` }); continue; }
        if (!r.claim) continue;
        const secs = sectionsInRange(t.heads, r.a, r.b);
        if (secs.includes('?')) continue; // 被引文件无编号标题 ⇒ 无从判定
        if (!secs.includes(r.claim)) {
          issues.push({
            where, kind: 'A 落点',
            detail: `声称 §${r.claim}，但 ${t.name}:${r.a === r.b ? r.a : `${r.a}-${r.b}`} 落在 §${secs.join(' §')}`,
          });
        }
      }
    });
  }
  LINE = '';
  return { issues, records };
}

const hints_empty = (a) => a === undefined || a.length === 0;

// ── 自检：注入式，证明检测器真的会红 ─────────────────────────────────

function selfTest() {
  // 被引文档：`## 1. 一` 在 :2、`### 1.1 一甲` 在 :4、`## 2. 二` 在 :6
  const A = ['# 甲', '## 1. 一', 'x', '### 1.1 一甲', 'x', '## 2. 二', 'x'];
  const B = [
    '# 乙',
    '后置对：`docs/10:4`（§1.1）',
    '后置错：`docs/10:3`（§1.1）',
    '自引用：本章 §2.1；另有 `docs/10:4`（§1.1）',
    '无声称：`docs/10:3`',
    '缺失：`docs/99:1`（§1）',
    '越界：`docs/10:99`（§1）',
    '反序：`docs/10:5-2`（§1）',
    '全名：`10-甲.md:4`（§2）',
    '续写紧接：`docs/10:4`、`:6`（§1.1）',
    '不看的写法：`README.md:36`（§1）',
    '跨节合法：`docs/10:3-6`（§2）',
    '前置对：§2（`docs/10:6`）',
    '前置错：§1.1（`docs/10:6`）',
    '远处声称不算：`docs/10:3` 这一节的内容在本文档里另见 §9.9',
    // 【为什么新样例必须加在**末尾**】本数组的下标 = 行号，上面所有用例都按 `90-乙.md:N` 断言；
    // 插在中间会让后面每个断言的"N"整体位移 —— 本次加样例时就踩过一次（3 个用例转红）。
    '不可核对：`AGENTS.md:29-34`（§1）',
  ].map((s, i) => (i === 0 ? s : `- ${s}`));
  const cases = [
    ['后置声称（FILE:N（§X））落点对 ⇒ 不报', (is) => !is.some((i) => i.where.startsWith('90-乙.md:2'))],
    ['后置声称落点错 ⇒ 必须报 A', (is) => is.some((i) => i.kind === 'A 落点' && i.where.startsWith('90-乙.md:3'))],
    ['带「本章」的自引用不算声称', (is) => !is.some((i) => i.where.startsWith('90-乙.md:4'))],
    ['同行无声称 ⇒ 不判落点（不猜）', (is) => !is.some((i) => i.where.startsWith('90-乙.md:5'))],
    ['被引文件不存在 ⇒ 报 B', (is) => is.some((i) => i.kind === 'B 存在' && i.where.startsWith('90-乙.md:6'))],
    ['行号越界 ⇒ 报 C', (is) => is.some((i) => i.kind === 'C 界内' && i.where.startsWith('90-乙.md:7'))],
    ['起止反序 ⇒ 报 D', (is) => is.some((i) => i.kind === 'D 次序' && i.where.startsWith('90-乙.md:8'))],
    ['省略 docs/ 的全名要认出来', (is) => is.some((i) => i.where.startsWith('90-乙.md:9') && i.kind === 'A 落点')],
    ['紧接续写 :6 归同一目标并判落点', (is) => is.some((i) => i.kind === 'A 落点' && i.where.includes('90-乙.md:10'))],
    ['docs/ 之外的 .md 不参与**落点**判定（只可能报 F）', (is) => !is.some((i) => i.where.includes('README') && i.kind !== 'F 不可核对')],
    ['对 README.md 写行号 ⇒ 报 F 不可核对', (is) => is.some((i) => i.kind === 'F 不可核对' && i.where.includes('README.md:36'))],
    ['对 AGENTS.md 写行号 ⇒ 报 F 不可核对（含区间写法）', (is) => is.some((i) => i.kind === 'F 不可核对' && i.where.includes('AGENTS.md:29'))],
    ['跨节的区间（3-6）算通过', (is) => !is.some((i) => i.where.startsWith('90-乙.md:12'))],
    ['前置声称（§X（FILE:N））落点对 ⇒ 不报', (is) => !is.some((i) => i.where.startsWith('90-乙.md:13'))],
    ['前置声称落点错 ⇒ 必须报 A', (is) => is.some((i) => i.kind === 'A 落点' && i.where.startsWith('90-乙.md:14'))],
    ['同行的远处声称不当成相邻 ⇒ 不报', (is) => !is.some((i) => i.where.startsWith('90-乙.md:15'))],
  ];
  const { issues, records } = scanSources([
    { name: '10-甲.md', lines: A },
    { name: '90-乙.md', lines: B },
  ]);
  let failed = 0;
  console.log('# 文档引用门禁自检（注入式）\n');
  console.log(`样例：${records.length} 条引用 / ${issues.length} 处问题\n`);
  for (const [name, want] of cases) {
    const ok = want(issues);
    if (!ok) failed++;
    console.log(`${ok ? '✓' : '✗'} ${name}`);
  }
  console.log(failed === 0
    ? `\n✅ 自检通过：检测器在 ${cases.length} 个样例上都符合预期。`
    : `\n❌ 自检失败 ${failed} 项——门禁不可信，不得据此判断文档引用是否漂移。`);
  if (failed !== 0) {
    console.log('\n实际报出：');
    for (const i of issues) console.log(`  [${i.kind}] ${i.where} :: ${i.detail}`);
    console.log('\n实际记录：');
    for (const r of records) console.log(`  ${r.file}:${r.at}  ${r.raw}:${r.a}-${r.b} 声称 §${r.claim}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

// ── 主流程 ───────────────────────────────────────────────────────────

function main(argv) {
  if (argv.includes('--self-test')) selfTest();

  let names;
  try {
    names = readdirSync(join(ROOT, 'docs'));
  } catch {
    console.error(`找不到 docs/（解析出的仓库根：${ROOT}）`);
    process.exit(2);
  }
  const sources = names
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ name: f, lines: readFileSync(join(ROOT, 'docs', f), 'utf8').split(/\r?\n/) }));

  // 【2026-10-05 收尾审计补】把仓库根的 `AGENTS.md` / `README.md` 也作为**源**纳入扫描：
  //   它们同样会引用 `docs/NN-*.md`，而此前"既不是 docs/ 内互引、也不在被引判定集内" ⇒ 没人核对。
  //   注意它们**不是被引目标**（`byName` 里没有 `AGENTS.md`/`README.md`）⇒ 对它们写行号由判据 F 拦下。
  for (const extra of ['AGENTS.md', 'README.md']) {
    try {
      sources.push({ name: extra, lines: readFileSync(join(ROOT, extra), 'utf8').split(/\r?\n/) });
    } catch {
      // 缺文件不算错：两者属可选；门禁只保证"存在时其引用要被核对"。
    }
  }

  const { issues, records } = scanSources(sources);
  console.log('# 文档引用门禁：docs/ 内的「文件:行号」引用要落在它声称的那一节上\n');
  console.log(`扫描文档 ${sources.length} 个 · 带行号的引用 ${records.length} 条`);

  if (argv.includes('--list')) {
    console.log('');
    for (const r of records) {
      console.log(`  ${r.file}:${r.at}  ${r.raw}:${r.a === r.b ? r.a : `${r.a}-${r.b}`}  → ${r.target}${r.claim ? `  声称 §${r.claim}` : ''}`);
    }
  }

  if (issues.length === 0) {
    console.log('\n✅ 通过：每条引用的落点都与它声称的节一致，被引文件都在、行号都在界内。');
    process.exit(0);
  }
  console.log(`\n❌ 检测到 ${issues.length} 处引用问题：\n`);
  for (const i of issues) console.log(`  [${i.kind}] ${i.where} :: ${i.detail}`);
  console.log('\n处置：改行号让它落回所声称的节；若那一节本身已被移走/删除，');
  console.log('      就连同声称一起改写——**不要**留一条指向别处的引用。');
  process.exit(1);
}

const isMain = import.meta.main === true
  || (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]);
if (isMain) main(process.argv.slice(2));
