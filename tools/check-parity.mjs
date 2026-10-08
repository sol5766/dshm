/**
 * 功能对等门禁（P0 交付物）：让 `docs/parity-matrix.md` 不能注水、不能悄悄漂移。
 *
 * 存在理由：
 *   对等矩阵是本项目「还差什么」的唯一清单。这类台账的失效方式**不会报错**——
 *   它只是慢慢变得不可信：漏掉一行（能力面没覆盖）、状态写着 DONE 而某个形态其实是
 *   TODO、把某行从 DONE 降级却不写原因、统计口径不明导致数字对不上。
 *   这些都不会让构建失败，所以必须由门禁来强制（与 arch-check 的存在理由同类）。
 *
 * 强制四条不变式（对应矩阵 §1.4）：
 *   A 覆盖：行集必须**恰好**等于官方能力面清单（39 个 id：38 个 dsh-client-ui-* + client-locale），
 *           外加允许的 `dshm-` 端侧独有行——不允许漏、不允许重复。
 *   A2 端侧独有登记：`REQUIRED_LOCAL_SURFACE` 里列出的端侧能力面**必须各有行**。
 *           这是 2026-10-05 收尾审计补的规则：此前"新增一个端侧能力"**永远没有门禁要求登记**
 *           （`dshm-tool-fs-remove` / `dshm-fs-write-nonchmod` / `dshm-workspace-claim` /
 *           `dshm-office-system-preview` / `dshm-ptc-runtime-inproc` 五个能力面当时在矩阵里
 *           一个都没有，全仓只有一处顺带提及）。
 *   B 单调：任一形态列不是 DONE 时，整体 Status **不得**是 DONE（不许用整体 DONE 盖住某个形态的缺口）。
 *   C 登记：任何非 DONE 的行必须在 §6 缺口登记里有对应行（不许只留结论不留原因）。
 *   D 统计：§5 统计表必须与矩阵实际计数**逐项相等**（口径见矩阵 §5；本项目曾因口径不明差点得出错误结论）。
 *
 * 用法：
 *   node tools/check-parity.mjs              # 检查，有违规则非零退出
 *   node tools/check-parity.mjs --self-test  # 自检：注入式负测试，证明检测器真的会命中
 *   node tools/check-parity.mjs --list       # 打印解析出的行与状态
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const MATRIX = join(ROOT, 'docs', 'parity-matrix.md');

/** 合法状态 token（矩阵 §1.1：只允许这四个） */
const TOKENS = ['DONE', 'PARTIAL', 'BOUNDARY', 'TODO'];
/** 形态列允许的额外占位：该行与形态无关（由整体 Status 代表） */
const NO_DIFF = '—';
const DEVICE_COLUMNS = 4; // Phone / Tablet / PC / 2-in-1

/**
 * 官方能力面清单（矩阵 §7.1）。
 *
 * 【来源与版本】本机安装的官方客户端包 `@deepseek-ai/dsh`（**0.1.2-alpha.1**）依赖树里
 * 全部 `dsh-client-ui-*`（38 个）+ `dsh-client-locale`。
 * 复现：ls -d <dsh>/node_modules/@deepseek-ai/dsh-client-ui-* | xargs -n1 basename
 *       | sed 's/^dsh-client-ui-//' | sort
 *
 * 【必须复核】本项目协议基线是 0.1.5-rc.1（D2 §8.7），比上面这个版本新。
 * 拿到 0.1.5-rc.1 后重跑上面的命令，与本表比对——本门禁会直接报出差集（多/少哪个 id）。
 * **上游新增了能力面而本表没跟上，就是"门禁通过但没覆盖到"**（docs/README 纪律 9）。
 */
export const OFFICIAL_SURFACE = [
  'agent-preset', 'approval', 'attachment', 'brand-official', 'chat', 'commands',
  'conversation', 'cordis', 'deliverables', 'directory-picker-browse',
  'directory-picker-native', 'goal', 'input-trigger', 'jobs', 'layout',
  'message-feedback', 'model-selection', 'permission-presets', 'plan', 'primitives',
  'reference', 'renderer', 'session', 'settings', 'settings-general',
  'settings-models', 'settings-plugin-inventory', 'settings-plugins', 'sidebar', 'skill',
  'slots', 'subagent', 'theme', 'tool', 'trajectory', 'user-questions', 'workflow-run',
  'workspace',
  'client-locale'
];

/** 端侧独有行的 id 前缀（无 Web 对应，允许存在于矩阵但不在官方清单里） */
const LOCAL_PREFIX = 'dshm-';

/**
 * **必须登记的端侧独有能力面**（矩阵 §4.6 的行集）。
 *
 * 【为什么要有这份清单】官方能力面有 `OFFICIAL_SURFACE` 兜着——上游新增一个面而矩阵没跟上，
 * 门禁会红。但**端侧自建的能力面此前无人兜底**：新增一个插件（例如三个文件能力插件 + PTC
 * 同进程运行时 + office 系统预览）在矩阵里可以一行都没有，门禁照样全绿（2026-10-05 审计实证）。
 * 这份清单把"新增端侧能力必须登记"变成**会失败的判据**：能力面一旦落地并入 profile/打包清单，
 * 就把它加到这里，矩阵 §4.6 必须有对应行。
 *
 * 【维护约定】只列"端侧自建的能力面"（有自己的插件/子系统），不列"对官方能力面的补丁/替换实现"
 * （那些归官方行，状态写在对应行里）。
 */
export const REQUIRED_LOCAL_SURFACE = [
  // 框架与宿主（批次一~三）
  'dshm-core', 'dshm-host', 'dshm-diag', 'dshm-notify', 'dshm-hosttrust',
  'dshm-multiwindow', 'dshm-share', 'dshm-clipboard', 'dshm-window',
  'dshm-shortcuts', 'dshm-a11y',
  // 2026-10-03 起的端侧文件能力与运行时（此前从未被要求登记）
  'dshm-tool-fs-remove', 'dshm-fs-write-nonchmod', 'dshm-workspace-claim',
  'dshm-office-system-preview', 'dshm-ptc-runtime-inproc'
];

/** 期望的矩阵列数：Feature + 4（Web/状态/界面/协议）+ 4 形态 + Status */
const EXPECTED_COLUMNS = 1 + 4 + DEVICE_COLUMNS + 1;

/**
 * 把一行 markdown 表格拆成单元格。
 *
 * 【必须懂转义竖线】表格里要写类型记法（如 `ifVersion: string | null`）时，竖线必须写成 `\|`，
 * 否则 markdown 会把它当列分隔符。门禁若按裸 `|` 切，就会把一行合法的 10 列读成 11 列
 * （实测踩过：`message-feedback` 行因此报「列数 11，期望 10」并连带"覆盖缺失"）。
 * 做法：先把 `\|` 换成占位符再切，切完还原。
 */
const ESCAPED_PIPE = '\u0000PIPE\u0000';

function cells(line) {
  return line
    .replace(/\\\|/g, ESCAPED_PIPE)
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim().split(ESCAPED_PIPE).join('|'));
}

/** 从单元格里取出行 id（第一个反引号片段） */
function rowId(cell) {
  const m = cell.match(/`([^`]+)`/);
  return m ? m[1] : null;
}

/** 取出单元格里的**全部**反引号 id（缺口登记一行可能登记多个 id） */
function allIds(cell) {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/**
 * 解析矩阵文本 → 结构。
 * 导出以便自检注入样例（未导出则自检只能靠真实文件，无法注入）。
 */
export function parseMatrix(text) {
  const lines = text.split('\n');
  const rows = [];
  const gaps = new Set();
  const stats = {};
  let section = '';
  let inStats = false;
  let inGaps = false;

  for (const raw of lines) {
    const line = raw.trimEnd();

    // 跟踪当前章节标题（## 5. / ## 6. / ## 4. …）
    const heading = line.match(/^#{2,3}\s+([0-9]+(?:\.[0-9]+)?)[.、]?\s*(.*)$/);
    if (heading) {
      section = heading[1];
      inStats = section === '5';
      inGaps = section === '6';
      continue;
    }

    if (!line.trim().startsWith('|')) continue;
    const c = cells(line);
    if (c.every((x) => /^:?-{2,}:?$/.test(x) || x === '')) continue; // 分隔行

    const id = rowId(c[0]);
    if (!id) continue; // 表头行

    if (inGaps) {
      // 缺口登记：第一格里的所有 id
      for (const gid of allIds(c[0])) gaps.add(gid);
      continue;
    }

    if (inStats) {
      // 统计表：| `DONE` | 15 |（值里可能带 ** 加粗，一并剥掉）
      const key = c[0].replace(/[`*]/g, '').trim();
      const n = Number(c[1].replace(/[`*\s]/g, ''));
      if (Number.isFinite(n)) stats[key] = n;
      continue;
    }

    // 矩阵行只在 §4（4 / 4.1 / 4.2 …）里找。
    // 【为什么要限定】§1 的口径表、§3 的验证手段表、§7 的来源表里也有反引号单元格，
    // 不限定范围会把「`DONE` | 含义 | 判据」当成一行矩阵（实测过：报出 7 处假的行）。
    if (!(section === '4' || section.startsWith('4.'))) continue;

    // 矩阵行：必须 10 列，且末列是状态 token
    rows.push({ id, cells: c, status: c[c.length - 1], line });
  }

  return { rows, gaps, stats };
}

/** 检查（纯函数，便于自检注入） */
export function checkMatrix(parsed) {
  const problems = [];
  const seen = new Map();

  for (const r of parsed.rows) {
    if (r.cells.length !== EXPECTED_COLUMNS) {
      problems.push(`  ✗ ${r.id}：列数 ${r.cells.length}，期望 ${EXPECTED_COLUMNS}`);
      continue;
    }
    if (seen.has(r.id)) problems.push(`  ✗ ${r.id}：矩阵里出现两次（重复行）`);
    seen.set(r.id, r);

    const devices = r.cells.slice(-(DEVICE_COLUMNS + 1), -1);
    for (const d of devices) {
      if (!TOKENS.includes(d) && d !== NO_DIFF) {
        problems.push(`  ✗ ${r.id}：形态列出现非法 token "${d}"（只允许 ${TOKENS.join('/')} 或 ${NO_DIFF}）`);
      }
    }
    if (!TOKENS.includes(r.status)) {
      problems.push(`  ✗ ${r.id}：Status="${r.status}" 不是合法 token（只允许 ${TOKENS.join('/')}）`);
      continue;
    }
    // 不变式 B：不许用整体 DONE 盖住某个形态的缺口
    if (r.status === 'DONE') {
      const lagging = devices.filter((d) => d !== NO_DIFF && d !== 'DONE');
      if (lagging.length > 0) {
        problems.push(`  ✗ ${r.id}：Status=DONE，但形态列有 ${lagging.join('/')} —— 不许用整体 DONE 盖住形态缺口`);
      }
    }
  }

  // 不变式 A：覆盖
  const ids = [...seen.keys()];
  const official = ids.filter((i) => !i.startsWith(LOCAL_PREFIX));
  const missing = OFFICIAL_SURFACE.filter((i) => !seen.has(i));
  const extra = official.filter((i) => !OFFICIAL_SURFACE.includes(i));
  for (const m of missing) problems.push(`  ✗ 覆盖缺失：官方能力面 \`${m}\` 在矩阵里没有行`);
  for (const e of extra) {
    problems.push(`  ✗ 覆盖越界：\`${e}\` 既不是官方能力面（${OFFICIAL_SURFACE.length} 个 id）也没有 ${LOCAL_PREFIX} 前缀`);
  }

  // 不变式 A2：端侧独有能力面必须登记（见 REQUIRED_LOCAL_SURFACE 的注释）
  for (const r of REQUIRED_LOCAL_SURFACE) {
    if (!seen.has(r)) {
      problems.push(`  ✗ 端侧独有覆盖缺失：\`${r}\` 在矩阵 §4.6 里没有行（新增端侧能力必须登记）`);
    }
  }

  // 不变式 C：非 DONE 必须登记
  for (const r of seen.values()) {
    if (r.status !== 'DONE' && !parsed.gaps.has(r.id)) {
      problems.push(`  ✗ ${r.id}：Status=${r.status}，但 §6 缺口登记里没有它（不许只留结论不留原因）`);
    }
  }
  for (const g of parsed.gaps) {
    if (!seen.has(g)) problems.push(`  ✗ §6 登记了 \`${g}\`，但矩阵里没有这一行（幽灵登记）`);
  }

  // 不变式 E：DONE 行不得留在 §6 缺口登记里（陈旧登记）
  // 【为什么需要】只查"非 DONE 必须登记"会漏掉反方向：把某行改成 DONE 却忘了把登记行删掉，
  // 于是台账里同时说"已完成"和"缺什么"。实测：注入"把 workflow-run 谎报成 DONE"时，
  // 旧版只靠统计差额命中（可被顺手改统计掩盖），加这条后直接点名。
  for (const r of seen.values()) {
    if (r.status === 'DONE' && parsed.gaps.has(r.id)) {
      problems.push(`  ✗ ${r.id}：Status=DONE，但仍留在 §6 缺口登记里（陈旧登记：Completed 即移出）`);
    }
  }

  // 不变式 D：统计必须与实算一致
  const actual = { DONE: 0, PARTIAL: 0, BOUNDARY: 0, TODO: 0 };
  for (const r of seen.values()) if (TOKENS.includes(r.status)) actual[r.status]++;
  for (const t of TOKENS) {
    const declared = parsed.stats[t];
    if (declared === undefined) {
      problems.push(`  ✗ §5 统计表缺 \`${t}\` 一行（口径：矩阵各行的 Status 计数）`);
    } else if (declared !== actual[t]) {
      problems.push(`  ✗ §5 统计 \`${t}\`=${declared}，实算=${actual[t]}`);
    }
  }
  const declaredTotal = parsed.stats['合计'];
  const actualTotal = Object.values(actual).reduce((a, b) => a + b, 0);
  if (declaredTotal !== undefined && declaredTotal !== actualTotal) {
    problems.push(`  ✗ §5 统计 \`合计\`=${declaredTotal}，实算=${actualTotal}`);
  }

  return { problems, actual, rows: seen };
}

/** 自检：注入式负测试（未被负测试验证的门禁等于没有门禁） */
function selfTest() {
  // 【教训】矩阵行只在 §4 内解析，因此**样例文本必须带 `## 4.` 标题**——
  // 否则样例里的行全被跳过，"漏行"变成假阳性来源（本门禁第一版自检就这样红过）。
  const head = '## 4. 矩阵\n\n'
    + '| Feature | Web | St | UI | API | Phone | Tablet | PC | 2-in-1 | Status |\n'
    + '|---|---|---|---|---|---|---|---|---|---|\n';
  const goodRow = `| \`layout\` 外壳 | w | s | u | p | DONE | DONE | DONE | DONE | DONE |\n`;
  const gaps = (ids) => '## 6. 缺口登记\n\n| id | 缺什么 | 下一步 |\n|---|---|---|\n'
    + ids.map((i) => `| \`${i}\` | x | y |`).join('\n') + '\n';
  const statsWith = (o) => '## 5. 统计\n\n| 状态 | 行数 |\n|---|---|\n'
    + Object.entries(o).map(([k, v]) => `| \`${k}\` | ${v} |`).join('\n') + '\n';

  // 构造只含一个官方 id 的"全清单"，避免自检依赖真实矩阵规模
  const single = ['layout'];
  const saved = OFFICIAL_SURFACE.splice(0, OFFICIAL_SURFACE.length, ...single);
  // 不变式 A2 的清单同理按用例注入：真实清单有 16 项端侧独有能力面，而样例里没有它们的行，
  // 若让 A2 取真实清单，下面每一条"正常样例"都会被判红 —— 这正是本自检自进 CI 起就没绿过的原因
  // （A2 于 ee92b44 加入，样例没同步；2026-10-06 修）。A2 本身仍由末尾两条带 `locals` 的用例覆盖。
  const savedLocal = REQUIRED_LOCAL_SURFACE.splice(0, REQUIRED_LOCAL_SURFACE.length);
  const localRow = `| \`dshm-selfdemo\` 自检样例 | w | s | u | p | DONE | DONE | DONE | DONE | DONE |\n`;

  const cases = [
    {
      why: '正常样例必须通过（单行 DONE + 统计一致 + 无缺口）',
      text: head + goodRow + gaps([]) + statsWith({ DONE: 1, PARTIAL: 0, BOUNDARY: 0, TODO: 0, 合计: 1 }),
      want: 0
    },
    {
      why: '形态列落后于整体 Status：DONE 不得盖住 TODO 形态（不变式 B）',
      text: head + `| \`layout\` 外壳 | w | s | u | p | DONE | DONE | DONE | TODO | DONE |\n`
        + gaps([]) + statsWith({ DONE: 1, PARTIAL: 0, BOUNDARY: 0, TODO: 0, 合计: 1 }),
      want: 1
    },
    {
      why: '非法 token 必须命中',
      text: head + `| \`layout\` 外壳 | w | s | u | p | 完成 | DONE | DONE | DONE | DONE |\n`
        + gaps([]) + statsWith({ DONE: 1, PARTIAL: 0, BOUNDARY: 0, TODO: 0, 合计: 1 }),
      want: 1
    },
    {
      why: '非 DONE 未登记：PARTIAL 必须在 §6 出现（不变式 C）',
      text: head + `| \`layout\` 外壳 | w | s | u | p | PARTIAL | DONE | DONE | DONE | PARTIAL |\n`
        + gaps([]) + statsWith({ DONE: 0, PARTIAL: 1, BOUNDARY: 0, TODO: 0, 合计: 1 }),
      want: 1
    },
    {
      why: '登记了即通过（不变式 C 的正向）',
      text: head + `| \`layout\` 外壳 | w | s | u | p | PARTIAL | DONE | DONE | DONE | PARTIAL |\n`
        + gaps(['layout']) + statsWith({ DONE: 0, PARTIAL: 1, BOUNDARY: 0, TODO: 0, 合计: 1 }),
      want: 0
    },
    {
      why: '官方能力面漏行必须命中（不变式 A）',
      text: head + gaps([]) + statsWith({ DONE: 0, PARTIAL: 0, BOUNDARY: 0, TODO: 0, 合计: 0 }),
      want: 1
    },
    {
      why: '幽灵登记必须命中（§6 有、矩阵无）',
      text: head + goodRow + gaps(['layout', 'not-a-feature'])
        + statsWith({ DONE: 1, PARTIAL: 0, BOUNDARY: 0, TODO: 0, 合计: 1 }),
      want: 1
    },
    {
      why: '统计数字对不上必须命中（不变式 D）',
      text: head + goodRow + gaps([]) + statsWith({ DONE: 2, PARTIAL: 0, BOUNDARY: 0, TODO: 0, 合计: 2 }),
      want: 1
    },
    {
      why: 'DONE 却仍留在缺口登记里必须命中（不变式 E：陈旧登记）',
      text: head + goodRow + gaps(['layout'])
        + statsWith({ DONE: 1, PARTIAL: 0, BOUNDARY: 0, TODO: 0, 合计: 1 }),
      want: 1
    },
    {
      why: '统计表整个缺失必须命中（不变式 D）',
      text: head + goodRow + gaps([]),
      want: 1
    },
    {
      why: '列数不对必须命中（少一列形态）',
      text: '## 4. 矩阵\n\n| Feature | Web | St | UI | API | Phone | Tablet | PC | Status |\n|---|---|---|---|---|---|---|---|---|\n'
        + `| \`layout\` 外壳 | w | s | u | p | DONE | DONE | DONE | DONE |\n`
        + gaps([]) + statsWith({ DONE: 1, PARTIAL: 0, BOUNDARY: 0, TODO: 0, 合计: 1 }),
      want: 1
    },
    {
      why: '单元格里的转义竖线 \\| 不得被当成列分隔符（类型记法 string | null）',
      text: head + `| \`layout\` 外壳 | w | s | u | ifVersion: string \\| null | DONE | DONE | DONE | DONE | DONE |\n`
        + gaps([]) + statsWith({ DONE: 1, PARTIAL: 0, BOUNDARY: 0, TODO: 0, 合计: 1 }),
      want: 0
    },
    {
      why: `形态列允许 ${NO_DIFF}（与形态无关的行）`,
      text: head + `| \`layout\` 外壳 | w | s | u | p | ${NO_DIFF} | ${NO_DIFF} | ${NO_DIFF} | ${NO_DIFF} | TODO |\n`
        + gaps(['layout']) + statsWith({ DONE: 0, PARTIAL: 0, BOUNDARY: 0, TODO: 1, 合计: 1 }),
      want: 0
    },
    {
      why: '端侧独有能力面漏行必须命中（不变式 A2：新增端侧能力必须登记）',
      locals: ['dshm-selfdemo'],
      text: head + goodRow + gaps([]) + statsWith({ DONE: 1, PARTIAL: 0, BOUNDARY: 0, TODO: 0, 合计: 1 }),
      want: 1
    },
    {
      why: '端侧独有能力面登记了即通过（不变式 A2 的正向）',
      locals: ['dshm-selfdemo'],
      text: head + goodRow + localRow + gaps([]) + statsWith({ DONE: 2, PARTIAL: 0, BOUNDARY: 0, TODO: 0, 合计: 2 }),
      want: 0
    }
  ];

  let failed = 0;
  for (const c of cases) {
    REQUIRED_LOCAL_SURFACE.splice(0, REQUIRED_LOCAL_SURFACE.length, ...(c.locals ?? []));
    const { problems } = checkMatrix(parseMatrix(c.text));
    const got = problems.length > 0 ? 1 : 0;
    const ok = got === c.want;
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  期望${c.want ? '失败' : '通过'} 实际${got ? '失败' : '通过'}  ${c.why}`);
    if (!ok) for (const p of problems) console.log(`        ${p.trim()}`);
  }

  OFFICIAL_SURFACE.splice(0, OFFICIAL_SURFACE.length, ...saved);
  REQUIRED_LOCAL_SURFACE.splice(0, REQUIRED_LOCAL_SURFACE.length, ...savedLocal);
  console.log(failed === 0
    ? `\n✅ 自检通过：检测器在 ${cases.length} 个正/负样例上都符合预期。`
    : `\n❌ 自检失败 ${failed} 项——门禁不可信，不得据此判断对等状态。`);
  process.exit(failed === 0 ? 0 : 1);
}

const argv = process.argv.slice(2);
if (argv.includes('--self-test')) {
  console.log('# 功能对等门禁自检（注入式负测试）\n');
  selfTest();
}

let text;
try {
  text = readFileSync(MATRIX, 'utf8');
} catch {
  console.error(`找不到矩阵：docs/parity-matrix.md（当前目录 ${ROOT}）`);
  process.exit(2);
}

const parsed = parseMatrix(text);
const { problems, actual, rows } = checkMatrix(parsed);

console.log('# 功能对等门禁：docs/parity-matrix.md\n');
console.log(`解析：${rows.size} 行（官方能力面 ${OFFICIAL_SURFACE.length} 个 id + 端侧独有 ${[...rows.keys()].filter((i) => i.startsWith(LOCAL_PREFIX)).length} 行）`);
console.log(`实算：DONE ${actual.DONE} · PARTIAL ${actual.PARTIAL} · BOUNDARY ${actual.BOUNDARY} · TODO ${actual.TODO}`);
console.log(`§6 缺口登记：${parsed.gaps.size} 个 id`);

if (argv.includes('--list')) {
  console.log('');
  for (const r of rows.values()) console.log(`  ${r.status.padEnd(8)} ${r.id}`);
}

if (problems.length === 0) {
  console.log('\n✅ 通过：覆盖完整、状态合法、无形态注水、缺口已登记、统计与实算一致。');
  process.exit(0);
}

console.log(`\n❌ 检测到 ${problems.length} 处问题：\n`);
for (const p of problems) console.log(p);
console.log('\n处置：矩阵是"还差什么"的唯一清单，先改矩阵再改代码；');
console.log('      不要为了让门禁通过而调统计数字或删登记行（那是把台账变成宣传）。');
process.exit(1);
