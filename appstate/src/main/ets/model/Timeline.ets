/**
 * 轨迹时间线（P2 §11 的 `TrajectoryPresenter`：交互式时间总览）。
 *
 * ## 要解决的问题
 *
 * 矩阵 `trajectory` 行的缺口是"**无交互式时间总览**"：轨迹视图只有一条扁平的事件列表，
 * 看不出"这一步花了多久、时间花在哪、总耗时多少"。而 `sessionStats`
 * （turns/steps/llmMs/toolMs/ttftMs/ttftSteps/decodeMs/decodeTokens）**已经投影出来、
 * 也已经在快照里暴露，却没有任何界面显示它**——这些数字此前在界面上完全缺席。
 *
 * ## 判定基准（不靠猜）
 *
 * 逐条对齐官方 `dsh-client-ui-trajectory/lib/client.js`：
 *
 * | 项 | 官方事实（原文） |
 * |---|---|
 * | 格子的种类 | `timelineKindLabel()` 的 7 个分支：`system / user / context / compacted / message / tool / subtool` |
 * | 中文标签 | `kind.system=系统`、`kind.user=用户`、`kind.context=上下文`、`kind.compacted=已压缩`、`kind.message=消息`、`kind.tool=工具`、`kind.subtool=子工具` |
 * | 每格的数据 | `cell.timeSeconds`（时长）、`cell.startedAt`、`cell.isError`——**错误是格子上的一个标记，不是一种 kind** |
 * | 助手计时（**官方有、我方没有**） | 官方按 `assistantTimingDetail(metrics)` 给每步算「首 token / 解码」，校验很严（`timingRecorded === true`、三个时间戳有限、`start ≤ first ≤ completed`，否则不显示）。但这些字段来自**官方客户端自己的 metrics**（`timingRecorded` 只出现在 `dsh-client-ui-trajectory/lib/client.js` 内部），**我方投影里没有** ⇒ 本模型不提供该函数；会话级「首 token 平均（TTFT）」由 `sessionStats` 给（见下）。要按步显示，得先让投影带上这些字段（已登记在矩阵 `trajectory` 行） |
 * | 文案 | `timeline.total=总计 {duration}`、`timeline.started=开始于 {time}`、`timeline.noTimingData=无计时数据`、`timeline.aria=轨迹时间线`、`timeline.overviewAria=时间线概览；水平拖动可聚焦事件` |
 *
 * ## 我方数据能对上多少（如实标注）
 *
 * 官方的时间线把**整场会话**摊成格子（请求、提示词变更、压缩、用户轮、工具调用…）。
 * 我方 `TrajectoryItem` 能对上的部分是"有耗时的事件"：
 *
 * | 我方 `TrajectoryKind` | 映射到 | 依据 |
 * |---|---|---|
 * | `MESSAGE` + 用户 | `USER` | 官方 `kind: "user"` |
 * | `MESSAGE` + 助手 | `MESSAGE` | 官方 `kind: "message"`（一次请求/回答） |
 * | `REASONING` | `MESSAGE` | 官方**没有**独立的思考格（思考并入助手那一步的展示），故不另立种类 |
 * | `TOOL` | `TOOL` | 官方 `kind: "tool"` |
 * | `SUBAGENT` | `TOOL` | 子代理本身就是一次工具调用。官方区分 `tool`/`subtool` 指的是"子代理**内部**的工具"，那需要父子调用关系，而我方 `TrajectoryItem` 没有该字段（已登记为边界）⇒ **不假装能分**，一律 `TOOL` |
 * | `DELIVERABLE` / `GOAL` / `JOB` | **不产生格子** | 官方时间线里没有对应种类（交付物/目标/任务在官方是独立的面板，不是时间格） |
 * | `ERROR` | **不产生格子** | 官方把错误记在格子自身的 `isError` 上，而不是一种 kind；我方错误条目仍在列表里可见 |
 * | `SYSTEM` / `CONTEXT` / `COMPACTED` / `SUBTOOL` | 保留常数 | 官方有这些种类，但我方投影目前**没有**对应的事件类型；保留是为了标签表与官方一致，并让"将来接上"只改映射不改类型 |
 *
 * **每格耗时**取 `TrajectoryItem.elapsedMs`；`elapsedMs === 0`（没有计时数据）的条目不进比例条，
 * 但**仍算在总数里**（`count`），以免"看起来一条都没有"。
 *
 * ## 为什么是纯函数
 *
 * "哪一格算哪一类""时间怎么分配成比例""拖到哪里算选中哪一格"都是**判断**，
 * 放这里之后可在本机直接测（`tools/check-layout-fixtures.mjs`），视图只把比例映射成宽度。
 */

import { Speaker, TrajectoryItem, TrajectoryKind } from './Trajectory';
import { formatDuration } from './Present';

/** 时间线的格子种类（与官方 `timelineKindLabel` 的 7 个分支一一对应） */
export enum TimelineKind {
  SYSTEM = 'system',
  USER = 'user',
  CONTEXT = 'context',
  COMPACTED = 'compacted',
  MESSAGE = 'message',
  TOOL = 'tool',
  SUBTOOL = 'subtool',
}

/** 种类标签（**逐字取官方中文文案**，不自创） */
export function timelineKindLabel(kind: TimelineKind): string {
  if (kind === TimelineKind.SYSTEM) {
    return '系统';
  }
  if (kind === TimelineKind.USER) {
    return '用户';
  }
  if (kind === TimelineKind.CONTEXT) {
    return '上下文';
  }
  if (kind === TimelineKind.COMPACTED) {
    return '已压缩';
  }
  if (kind === TimelineKind.MESSAGE) {
    return '助手';
  }
  if (kind === TimelineKind.TOOL) {
    return '工具';
  }
  return '子工具';
}

/**
 * 一条轨迹条目在时间线里算哪一格。
 *
 * @returns `null` = **不产生格子**（交付物 / 目标 / 任务 / 错误：官方时间线里没有对应种类）
 */
export function timelineKindOf(item: TrajectoryItem): TimelineKind | null {
  if (item.kind === TrajectoryKind.MESSAGE) {
    // 用户与助手共用一个 kind，靠 speaker 分开（官方也是两格：user / message）
    return item.speaker === Speaker.USER ? TimelineKind.USER : TimelineKind.MESSAGE;
  }
  if (item.kind === TrajectoryKind.REASONING) {
    return TimelineKind.MESSAGE;
  }
  if (item.kind === TrajectoryKind.TOOL) {
    return TimelineKind.TOOL;
  }
  if (item.kind === TrajectoryKind.SUBAGENT) {
    return TimelineKind.TOOL;
  }
  return null;
}

/** 时间线里的一格 */
export interface TimelineCell {
  /** 来源条目 id（视图据此滚动/高亮） */
  id: string;
  kind: TimelineKind;
  /** 耗时（毫秒；0 = 没有计时数据） */
  durationMs: number;
  /** 开始时刻（毫秒时间戳；0 = 未知） */
  startedAtMs: number;
  /** 是否出错（官方把错误记在格子上，而不是一种 kind） */
  isError: boolean;
}

export function timelineCellsOf(items: TrajectoryItem[]): TimelineCell[] {
  const out: TimelineCell[] = [];
  for (let i = 0; i < items.length; i++) {
    const item: TrajectoryItem = items[i];
    const kind: TimelineKind | null = timelineKindOf(item);
    if (kind === null) {
      continue;
    }
    out.push({
      id: item.id,
      kind: kind,
      durationMs: item.elapsedMs > 0 ? item.elapsedMs : 0,
      startedAtMs: item.at > 0 ? item.at : 0,
      isError: item.kind === TrajectoryKind.ERROR
    });
  }
  return out;
}

/* ───────────────────────── 比例（时间总览条） ───────────────────────── */

/** 比例条上的一段（`ratio` 之和为 1，`startRatio` 为累计起点） */
export interface TimelineSegment {
  id: string;
  kind: TimelineKind;
  durationMs: number;
  /** 占总时长的比例（0–1） */
  ratio: number;
  /** 在条上的起点比例（0–1） */
  startRatio: number;
}

export interface TimelineScale {
  /** 总耗时（毫秒；仅统计有计时数据的格子） */
  totalMs: number;
  /** 格子总数（**含没有计时数据的**，避免"看起来一条都没有"） */
  count: number;
  /** 有条目的比例段（只有耗时 > 0 的格子才进） */
  segments: TimelineSegment[];
  /** 是否有任何计时数据（false ⇒ 界面显示官方那句"无计时数据"） */
  hasData: boolean;
}

/**
 * 把格子摊成比例。
 *
 * 【为什么要算累计起点】视图按 `startRatio` + `ratio` 摆在条上，而不是靠"浮动宽度相加"——
 * 后者在比例被四舍五入后会出现缝隙或重叠，累计起点不会。
 */
export function timelineScaleOf(cells: TimelineCell[]): TimelineScale {
  let totalMs: number = 0;
  const timed: TimelineCell[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].durationMs > 0) {
      totalMs += cells[i].durationMs;
      timed.push(cells[i]);
    }
  }
  const segments: TimelineSegment[] = [];
  if (totalMs > 0) {
    let cursor: number = 0;
    for (let i = 0; i < timed.length; i++) {
      const ratio: number = timed[i].durationMs / totalMs;
      segments.push({
        id: timed[i].id,
        kind: timed[i].kind,
        durationMs: timed[i].durationMs,
        ratio: ratio,
        startRatio: cursor
      });
      cursor += ratio;
    }
  }
  return {
    totalMs: totalMs,
    count: cells.length,
    segments: segments,
    hasData: segments.length > 0
  };
}

/**
 * 条上的某个比例位置落在哪一格（官方："水平拖动可聚焦事件"）。
 *
 * 越界一律夹到首/尾：拖动时手指很容易滑出条外，此时"什么都不聚焦"是更差的行为——
 * 用户已经明确在做"往前/往后扫"这个动作。
 */
export function cellIdAtRatio(segments: TimelineSegment[], ratio: number): string {
  if (segments.length === 0) {
    return '';
  }
  if (ratio <= 0) {
    return segments[0].id;
  }
  for (let i = 0; i < segments.length; i++) {
    const seg: TimelineSegment = segments[i];
    const end: number = i === segments.length - 1 ? 1 : seg.startRatio + seg.ratio;
    if (ratio < end || i === segments.length - 1) {
      return seg.id;
    }
  }
  return segments[segments.length - 1].id;
}

/** 选中项的序号（从 1 开始；找不到返回 0），用于「第 n / 共 m 格」这类提示 */
export function segmentOrdinalOf(segments: TimelineSegment[], id: string): number {
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].id === id) {
      return i + 1;
    }
  }
  return 0;
}

/**
 * 聚焦某一格时，**列表**该滚到第几行（条 ↔ 列表联动的条→列表方向）。
 *
 * @returns 行号；`-1` = 不滚（该格不在当前列表里）
 *
 * 【为什么这是个需要判断的查询，而不是一行 indexOf】它有三种"找不到"的情形，
 * 而它们**都不该滚**：格子 id 为空（还没聚焦）、该条目被过滤出列表（搜索/视图切换后
 * 列表与时间线的来源可能不同）、以及列表本身为空。滚到一个越界行号会直接抛错，
 * 而"滚到第 0 行"则是比不滚更糟的行为（用户没点任何东西，列表自己跳到顶部）。
 */
export function listIndexForCell(items: TrajectoryItem[], cellId: string): number {
  if (cellId.length === 0) {
    return -1;
  }
  for (let i = 0; i < items.length; i++) {
    if (items[i].id === cellId) {
      return i;
    }
  }
  return -1;
}

/** 列表第 `index` 行的条目在时间线里是哪一格（列表→条方向）；`''` = 该条目不产生格子 */
export function cellIdForListIndex(items: TrajectoryItem[], index: number): string {
  if (index < 0 || index >= items.length) {
    return '';
  }
  const kind: TimelineKind | null = timelineKindOf(items[index]);
  return kind === null ? '' : items[index].id;
}

/* ───────────────────────── 文案（逐字取官方文案） ───────────────────────── */

/** 官方 `timeline.total`：「总计 {duration}」 */
export function timelineTotalLabel(scale: TimelineScale): string {
  if (!scale.hasData) {
    // 官方 `timeline.noTimingData`
    return '无计时数据';
  }
  return `总计 ${formatDuration(scale.totalMs)}`;
}

/** 官方 `timeline.started`：「开始于 {time}」；未知时返回空串（视图不显示这一行） */
export function timelineStartedLabel(cell: TimelineCell, clockOf: (at: number) => string): string {
  if (cell.startedAtMs <= 0) {
    return '';
  }
  const clock: string = clockOf(cell.startedAtMs);
  return clock.length === 0 ? '' : `开始于 ${clock}`;
}

/* ───────────────────────── 会话统计（官方 web 的五项） ───────────────────────── */

/**
 * 会话统计的输入（视图把自己的快照字段映射进来；本模型不认识 `SessionHub`）。
 *
 * 【为什么字段缺失一律按 0 处理】投影里缺失的含义是"没有"，而不是"未探测"——
 * 于是判断规则很简单：**为 0 就不显示那一项**，而不是显示一个 0。
 */
export interface SessionStatsInput {
  turns: number;
  steps: number;
  llmMs: number;
  toolMs: number;
  ttftMs: number;
  ttftSteps: number;
  decodeMs: number;
  decodeTokens: number;
}

/** 统计项的取用单位（视图据此格式化；本模型不负责排版） */
export enum StatsUnit {
  COUNT = 'count',
  MS = 'ms',
  TPS = 'tps',
}

export interface StatsLine {
  key: string;
  label: string;
  value: number;
  unit: StatsUnit;
}

/**
 * 会话统计里**时间相关的四项**（依据本仓 `dshcompat/RemoteEvents.ets` 对 `sessionStats` 的实测注释）：
 * 「模型用时」「工具调用用时」「首 token 平均（TTFT）」「输出速度（TPS）」。
 *
 * 【为什么没有「{turns} 轮 {steps} 步」那一项】官方 web 把它与这几项放在同一条统计里，
 * 而**本应用的会话头部已经显示了它**（E125/E129 那一行还带缓存命中率与预设）。
 * 时间线里再显示一遍就是同一个数字出现两次——故这里只给"时间"相关的项，
 * `SessionStatsInput.turns`/`steps` 仅用于将来可能的分组，不参与产出。
 *
 * 显示规则（**为 0 即不显示**，而不是显示 0）：
 *   · 模型用时 / 工具调用用时：> 0 才显示
 *   · 首 token 平均：`ttftSteps > 0` 才显示（**平均值**，除以步数；没有步数就没有平均可言）
 *   · 输出速度：`decodeMs > 0 && decodeTokens > 0` 才显示（每秒 token 数）
 */
export function statsLinesOf(stats: SessionStatsInput): StatsLine[] {
  const out: StatsLine[] = [];
  if (stats.llmMs > 0) {
    out.push({ key: 'llm', label: '模型用时', value: stats.llmMs, unit: StatsUnit.MS });
  }
  if (stats.toolMs > 0) {
    out.push({ key: 'tool', label: '工具调用用时', value: stats.toolMs, unit: StatsUnit.MS });
  }
  if (stats.ttftMs > 0 && stats.ttftSteps > 0) {
    out.push({
      key: 'ttft',
      label: '首 token 平均（TTFT）',
      value: stats.ttftMs / stats.ttftSteps,
      unit: StatsUnit.MS,
    });
  }
  if (stats.decodeMs > 0 && stats.decodeTokens > 0) {
    out.push({
      key: 'tps',
      label: '输出速度（TPS）',
      value: stats.decodeTokens / (stats.decodeMs / 1000),
      unit: StatsUnit.TPS,
    });
  }
  return out;
}
