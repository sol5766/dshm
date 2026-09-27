/**
 * 改动前后对照（P2 §11 的 diff 呈现）。
 *
 * ## 要解决的问题
 *
 * §11 要求 Tool 按类别区分呈现，其中 `write`/`edit` 这一类的官方形态是**改动对照卡**
 * （加/减行），而不是"一行参数 + 一段输出"。此前本仓对编辑类工具只显示参数摘要与输出原文，
 * 用户看不出"到底改了什么"。
 *
 * ## 判定基准（不靠猜）
 *
 * 全部规则逐条对齐**官方客户端渲染器** `dsh-client-ui-tool/lib/client.js` 的
 * `intendedDiff()` / `narrowDiffs()` / `validEscalationFields()`：
 *
 * | 工具 | 参数 | 官方产出的对照 |
 * |---|---|---|
 * | `write` | `file_path` + `content` | `{path, oldText: null, newText: content}`（整文件都是新增） |
 * | `edit` | `file_path` + `old_string` + `new_string`(+`replace_all`) | `{path, oldText: old_string \|\| null, newText}` |
 * | `str_replace_editor` | `command: create` + `file_text` | `{path, oldText: null, newText: file_text ?? ""}` |
 * | `str_replace_editor` | `command: str_replace` + `old_str`/`new_str` | `{path, oldText: old_str ?? null, newText: new_str ?? ""}` |
 *
 * 细节都对上了：
 *   · `file_path` 必须是**非空字符串**，否则整卡不出（`path.trim() === ""` 也拒绝）
 *   · `edit` 的空 `old_string` **归一成 `null`**（表示纯新增），不是空串
 *   · `replace_all` 若出现则必须是布尔，否则拒绝
 *   · `validEscalationFields`：出现 `sandbox_permissions`/`justification` 任一时，前者必须是
 *     `workspace-write` / `danger-all-access` 之一、后者必须是非空字符串，否则整卡不出
 *   · **工具名按精确匹配**（与官方一致）：`str_replace_editor` 归到 EDIT 类是我方 `toolKindOf`
 *     的模糊判定，但**出不出 diff 卡**这里刻意用精确名——否则 `create_file` 之类名字相近、
 *     参数却不同的工具会被套上错误的对照。官方对不认识的名字也是直接返回 null。
 *
 * ## 半条边界（如实标注）
 *
 * 官方有**两个来源**：运行中用参数推导（intended），结束后优先用工具结果 `meta.diffs`（applied）。
 * 本仓**只实现了 intended**——因为会话投影（`SessionHub.applyToolSlots`）目前只解析
 * `TOOL_NAME`/`TOOL_ARGS`/`TOOL_OUTPUT`/`CALL_ID` 四个槽位，**没有携带 `meta`**。
 * 因此"工具回报的真实落盘改动"（可能与意图不同，例如 replace_all 命中多处）**看不到**，
 * 已登记在 `docs/parity-matrix.md` 的 `tool` 行缺口里（需要先确认事件里 meta 的槽位名）。
 * 另一处小差异：官方对嵌套调用（`parentCallId !== undefined`）不出 diff 卡，而本仓
 * `TrajectoryItem` 没有父子调用关系字段（子代理是**独立的种类**），故无从区分——同样已登记。
 *
 * ## 为什么是纯函数
 *
 * "这段参数是不是一次文件改动""哪几行是增哪几行是删"是**判断**，不是渲染；
 * 放这里之后可在本机直接测（`tools/check-layout-fixtures.mjs`），视图只把结果映射到 ArkUI。
 */

/** 一次改动对照：`oldText === null` 表示纯新增（没有"改动前"可言） */
export interface ToolDiff {
  path: string;
  oldText: string | null;
  newText: string;
}

/** 对照里一行的性质 */
export enum DiffLineKind {
  /** 未变动的上下文行 */
  CONTEXT = 'context',
  /** 新增行 */
  ADDED = 'added',
  /** 删除行 */
  REMOVED = 'removed',
  /** 被折叠掉的一整段未变动行（移动端不能把 500 行上下文都铺出来） */
  SKIPPED = 'skipped',
}

export interface DiffLine {
  kind: DiffLineKind;
  /** 行内容（SKIPPED 时为空串，行数在 `skipped` 里） */
  text: string;
  /** 仅 SKIPPED 有意义：被折叠掉的未变动行数 */
  skipped: number;
}

export interface DiffStat {
  added: number;
  removed: number;
}

/** 视图要的成品：路径 + 行 + 增删计数 + 是否被截断 */
export interface DiffPresentation {
  path: string;
  lines: DiffLine[];
  added: number;
  removed: number;
  /** 因为篇幅上限而截断（视图应如实告诉用户"还有更多"，而不是假装这就是全部） */
  truncated: boolean;
}

/* ───────────────────────── 参数读取 ───────────────────────── */

/** 只读我们真正需要的键——不做全量 JSON 遍历，避免类型与迭代上的不确定性 */
const STRING_KEYS: string[] = [
  'file_path', 'old_string', 'new_string', 'content', 'path',
  'file_text', 'old_str', 'new_str', 'command', 'justification', 'sandbox_permissions',
];

/**
 * 参数视图：区分"键不存在"与"键存在但类型不对"。
 *
 * 这个区分是**必须**的：官方对 `replace_all` 的规则是"出现则必须是布尔"，
 * 对 `sandbox_permissions` 是"出现则必须是那两个值之一"。把"不存在"当成"类型不对"，
 * 会让正常调用全部被拒；反过来则会让畸形调用被放过。
 */
class ArgsView {
  /** 非 null 的值（JSON 的 null 进不来，但键的"存在性"仍要算） */
  private values: Map<string, Object> = new Map<string, Object>();
  /** 键出现过（含值为 null 的情况） */
  private present: Set<string> = new Set<string>();

  constructor(parsed: Record<string, Object>) {
    for (let i = 0; i < STRING_KEYS.length; i++) {
      this.take(parsed, STRING_KEYS[i]);
    }
    this.take(parsed, 'replace_all');
  }

  /**
   * 取一个键。**不用 `in` 运算符**（ArkTS 上不必要的风险）：
   * JSON 里键不存在时取值就是 `undefined`，而 `null !== undefined`，
   * 于是"不存在"与"存在但值为 null"照样分得开——这个区分正是官方校验所依赖的。
   */
  private take(parsed: Record<string, Object>, key: string): void {
    const value: Object = parsed[key];
    if (value === undefined) {
      return;
    }
    this.present.add(key);
    if (value !== null) {
      this.values.set(key, value);
    }
  }

  /** 键出现过（值为 null 也算出现过——官方对"出现但类型不对"是拒绝，不是忽略） */
  has(key: string): boolean {
    return this.present.has(key);
  }

  /** 键出现过**且**是字符串；否则 undefined（空串是合法值，不能用真值判断） */
  str(key: string): string | undefined {
    const value: Object | undefined = this.values.get(key);
    return typeof value === 'string' ? value as string : undefined;
  }

  /** 键出现过**且**是布尔；否则 undefined */
  bool(key: string): boolean | undefined {
    const value: Object | undefined = this.values.get(key);
    return typeof value === 'boolean' ? value as boolean : undefined;
  }
}

function argsViewOf(rawArgs: string): ArgsView | null {
  if (rawArgs.length === 0) {
    return null;
  }
  let parsed: Record<string, Object>;
  try {
    parsed = JSON.parse(rawArgs) as Record<string, Object>;
  } catch (e) {
    // 非 JSON（模型偶尔直接给一段文本）：与官方一样"不出对照卡"，而不是抛给视图
    return null;
  }
  if (parsed === null || parsed === undefined || typeof parsed !== 'object') {
    return null;
  }
  return new ArgsView(parsed);
}

/* ───────────────────────── 意图对照（对齐官方 intendedDiff） ───────────────────────── */

/**
 * 官方 `validEscalationFields`：提权字段要么都不出现，要么一起且合法。
 *
 * 【为什么这个校验会影响"能不能显示"】官方用它决定**是否渲染对照卡**——
 * 参数形态不像一次正常文件改动的调用，就不给对照（避免展示一个误导性的对照）。
 * 我们照抄这条闸门，是为了"一处判错就整卡不出"，而不是尽力渲染一个可能错误的对照。
 */
function escalationFieldsValid(view: ArgsView): boolean {
  const hasPermission: boolean = view.has('sandbox_permissions');
  const hasJustification: boolean = view.has('justification');
  if (!hasPermission && !hasJustification) {
    return true;
  }
  const permission: string | undefined = view.str('sandbox_permissions');
  if (permission !== 'workspace-write' && permission !== 'danger-full-access') {
    return false;
  }
  const justification: string | undefined = view.str('justification');
  if (justification === undefined || justification.trim().length === 0) {
    return false;
  }
  return true;
}

/** 非空字符串路径（官方：`typeof path === "string" && path.trim() !== ""`） */
function validPath(path: string | undefined): string | null {
  if (path === undefined || path.trim().length === 0) {
    return null;
  }
  return path;
}

/**
 * 由工具名与参数推导"意图改动"。
 *
 * 返回 null = **不显示对照卡**（官方语义），包括：名字不认识、参数不是 JSON、
 * 路径缺失、必填字段类型不对、提权字段不合法。
 */
export function intendedDiffOf(toolName: string, rawArgs: string): ToolDiff | null {
  const name: string = toolName.toLowerCase();
  const isEditor: boolean = name === 'str_replace_editor';
  const isWriteOrEdit: boolean = name === 'write' || name === 'edit';
  if (!isEditor && !isWriteOrEdit) {
    return null;
  }
  const view: ArgsView | null = argsViewOf(rawArgs);
  if (view === null) {
    return null;
  }

  if (isEditor) {
    const path: string | null = validPath(view.str('path'));
    if (path === null) {
      return null;
    }
    const command: string | undefined = view.str('command');
    if (command === 'create') {
      // 官方：file_text 出现则必须是字符串；缺失视作空文件
      if (view.has('file_text') && view.str('file_text') === undefined) {
        return null;
      }
      const fileText: string | undefined = view.str('file_text');
      const text: string = fileText === undefined ? '' : fileText;
      return { path, oldText: null, newText: text };
    }
    if (command === 'str_replace') {
      if (view.has('old_str') && view.str('old_str') === undefined) {
        return null;
      }
      if (view.has('new_str') && view.str('new_str') === undefined) {
        return null;
      }
      const oldText: string | undefined = view.str('old_str');
      const newStr: string | undefined = view.str('new_str');
      const newText: string = newStr === undefined ? '' : newStr;
      return { path, oldText: oldText === undefined || oldText.length === 0 ? null : oldText, newText };
    }
    return null;
  }

  const path: string | null = validPath(view.str('file_path'));
  if (path === null) {
    return null;
  }
  if (!escalationFieldsValid(view)) {
    return null;
  }

  if (name === 'write') {
    // 官方：`content` 必须是字符串（缺失或类型不对都不出对照卡）
    const content: string | undefined = view.str('content');
    if (content === undefined) {
      return null;
    }
    return { path, oldText: null, newText: content };
  }

  const oldRaw: string | undefined = view.str('old_string');
  const newRaw: string | undefined = view.str('new_string');
  if (oldRaw === undefined || newRaw === undefined) {
    return null;
  }
  // 官方：`replace_all` 出现则必须是布尔
  if (view.has('replace_all') && view.bool('replace_all') === undefined) {
    return null;
  }
  // 官方：`oldText || null` —— 空串归一成 null（纯新增）
  return { path, oldText: oldRaw.length === 0 ? null : oldRaw, newText: newRaw };
}

/* ───────────────────────── 行级对照 ───────────────────────── */

/**
 * DP 上限：超过它就退回"全删 + 全增"。
 *
 * 【为什么要设上限】LCS 是 O(n·m)。模型改一个几百行的文件是常事，
 * 而这是在手机上跑——宁可给一个"粗但真"的对照，也不要把 UI 线程算住。
 */
const MAX_DIFF_PRODUCT: number = 250 * 250;
/** 返回的行数上限（超出则截断并置 `truncated`） */
const MAX_DIFF_LINES: number = 400;

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  return text.split('\n');
}

/**
 * 行级对照。
 *
 * 先削去公共前后缀（这是最省的一步，也覆盖了"只改一行"的绝大多数情况），
 * 再对中间那段做 LCS。`oldText === null` 时整段都是新增。
 */
export function diffLines(oldText: string | null, newText: string): DiffLine[] {
  const newLines: string[] = splitLines(newText);
  if (oldText === null) {
    const out: DiffLine[] = [];
    for (let i = 0; i < newLines.length; i++) {
      out.push({ kind: DiffLineKind.ADDED, text: newLines[i], skipped: 0 });
    }
    return out;
  }
  const oldLines: string[] = splitLines(oldText);

  let prefix: number = 0;
  while (prefix < oldLines.length && prefix < newLines.length
    && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix: number = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) {
    suffix += 1;
  }

  const oldMid: string[] = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid: string[] = newLines.slice(prefix, newLines.length - suffix);

  const out: DiffLine[] = [];
  for (let i = 0; i < prefix; i++) {
    out.push({ kind: DiffLineKind.CONTEXT, text: oldLines[i], skipped: 0 });
  }

  if (oldMid.length * newMid.length > MAX_DIFF_PRODUCT) {
    // 太大：如实给"全删 + 全增"，不做假装精确的对照
    for (let i = 0; i < oldMid.length; i++) {
      out.push({ kind: DiffLineKind.REMOVED, text: oldMid[i], skipped: 0 });
    }
    for (let i = 0; i < newMid.length; i++) {
      out.push({ kind: DiffLineKind.ADDED, text: newMid[i], skipped: 0 });
    }
  } else {
    const mid: DiffLine[] = lcsDiff(oldMid, newMid);
    for (let i = 0; i < mid.length; i++) {
      out.push(mid[i]);
    }
  }

  for (let i = oldLines.length - suffix; i < oldLines.length; i++) {
    out.push({ kind: DiffLineKind.CONTEXT, text: oldLines[i], skipped: 0 });
  }
  return out;
}

/** 经典 LCS 回溯（平面数组，避免嵌套数组的类型与分配开销） */
function lcsDiff(oldMid: string[], newMid: string[]): DiffLine[] {
  const n: number = oldMid.length;
  const m: number = newMid.length;
  if (n === 0 && m === 0) {
    return [];
  }
  if (n === 0) {
    const only: DiffLine[] = [];
    for (let j = 0; j < m; j++) {
      only.push({ kind: DiffLineKind.ADDED, text: newMid[j], skipped: 0 });
    }
    return only;
  }
  if (m === 0) {
    const only: DiffLine[] = [];
    for (let i = 0; i < n; i++) {
      only.push({ kind: DiffLineKind.REMOVED, text: oldMid[i], skipped: 0 });
    }
    return only;
  }
  const width: number = m + 1;
  const dp: number[] = new Array<number>((n + 1) * width).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (oldMid[i] === newMid[j]) {
        dp[i * width + j] = dp[(i + 1) * width + (j + 1)] + 1;
      } else {
        const down: number = dp[(i + 1) * width + j];
        const right: number = dp[i * width + (j + 1)];
        dp[i * width + j] = down >= right ? down : right;
      }
    }
  }
  const out: DiffLine[] = [];
  let i: number = 0;
  let j: number = 0;
  while (i < n && j < m) {
    if (oldMid[i] === newMid[j]) {
      out.push({ kind: DiffLineKind.CONTEXT, text: oldMid[i], skipped: 0 });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      out.push({ kind: DiffLineKind.REMOVED, text: oldMid[i], skipped: 0 });
      i += 1;
    } else {
      out.push({ kind: DiffLineKind.ADDED, text: newMid[j], skipped: 0 });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ kind: DiffLineKind.REMOVED, text: oldMid[i], skipped: 0 });
    i += 1;
  }
  while (j < m) {
    out.push({ kind: DiffLineKind.ADDED, text: newMid[j], skipped: 0 });
    j += 1;
  }
  return out;
}

export function diffStatOf(lines: DiffLine[]): DiffStat {
  let added: number = 0;
  let removed: number = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind === DiffLineKind.ADDED) {
      added += 1;
    } else if (lines[i].kind === DiffLineKind.REMOVED) {
      removed += 1;
    }
  }
  return { added, removed };
}

/**
 * 折叠过长的**未变动**段。
 *
 * 这是**呈现层**的取舍（官方那侧的具体折叠阈值我没有证据，故不假装对齐）：
 * 目的是"改了两行、文件 800 行"时不要把 799 行上下文铺到手机上。
 * 首尾的 `context` 行保留，中间超出 `2*context` 的未变动段折成一条 SKIPPED。
 */
export function collapseContext(lines: DiffLine[], context: number = 2): DiffLine[] {
  if (context < 0) {
    return lines;
  }
  const out: DiffLine[] = [];
  let i: number = 0;
  while (i < lines.length) {
    if (lines[i].kind !== DiffLineKind.CONTEXT) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    let j: number = i;
    while (j < lines.length && lines[j].kind === DiffLineKind.CONTEXT) {
      j += 1;
    }
    const runLength: number = j - i;
    // 首尾与中间的未变动段一视同仁：各留 context 行
    const keepHead: number = context;
    const keepTail: number = context;
    if (runLength <= keepHead + keepTail) {
      for (let k = i; k < j; k++) {
        out.push(lines[k]);
      }
    } else {
      for (let k = i; k < i + keepHead; k++) {
        out.push(lines[k]);
      }
      out.push({ kind: DiffLineKind.SKIPPED, text: '', skipped: runLength - keepHead - keepTail });
      for (let k = j - keepTail; k < j; k++) {
        out.push(lines[k]);
      }
    }
    i = j;
  }
  return out;
}

/** 截断到 `maxLines`（超出的丢弃并如实置 `truncated`） */
function capped(lines: DiffLine[], maxLines: number): DiffLine[] {
  if (maxLines <= 0 || lines.length <= maxLines) {
    return lines;
  }
  return lines.slice(0, maxLines);
}

/**
 * 视图要的成品：一次调用拿到"要不要出对照卡 + 出什么"。
 *
 * `context`/`maxLines` 由调用方给（手机与 PC 可以不同），但默认值面向手机。
 */
export function presentDiff(toolName: string, rawArgs: string,
  context: number = 2, maxLines: number = MAX_DIFF_LINES): DiffPresentation | null {
  const diff: ToolDiff | null = intendedDiffOf(toolName, rawArgs);
  if (diff === null) {
    return null;
  }
  const all: DiffLine[] = diffLines(diff.oldText, diff.newText);
  const stat: DiffStat = diffStatOf(all);
  const collapsed: DiffLine[] = collapseContext(all, context);
  const shown: DiffLine[] = capped(collapsed, maxLines);
  return {
    path: diff.path,
    lines: shown,
    added: stat.added,
    removed: stat.removed,
    truncated: shown.length < collapsed.length,
  };
}
