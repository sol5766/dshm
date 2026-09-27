/**
 * 详情栏分区（D3 §3.6）：从**真实轨迹**派生「工具 / 子代理 / 交付物 / 目标 / 任务」。
 *
 * 【为什么必须派生，不能是固定几行】
 *   旧实现这里是 `stubDetailSections()`：固定的「read · 成功 · 42ms」「reviewer · 26s」
 *   等示例行。它在**任何**会话里都显示同样内容，包括空会话——
 *   于是「这个会话调了哪些工具」这个问题得到的是**别人会话的答案**。
 *   详情栏的全部价值就是回答这个问题，编造它等于把这一栏变成装饰。
 *
 * 【为什么只取尾部若干条】轨迹可以很长，而详情栏是**摘要**。
 *   `count` 给真实总数（用户知道有多少），`lines` 给最近若干条（用户知道最近发生了什么）。
 *   只给尾部而不给总数会让用户以为「就这么多」；只给总数而不给内容则等于没说。
 */

import { formatBytes, formatDuration, toolStateLabel } from './Present';
import { TrajectoryItem, TrajectoryKind } from './Trajectory';

/** 详情栏分区 */
export interface DetailSection {
  title: string;
  /** 真实条数（0 = 显示空态） */
  count: number;
  /** 每行摘要（最多 `DETAIL_LINE_LIMIT` 行，取最近者） */
  lines: string[];
  /** 空态说明（D3 §4：空态要说明「可以做什么」） */
  emptyHint: string;
}

/** 每区最多展示的行数 */
const DETAIL_LINE_LIMIT: number = 8;

/** 五个分区：标题 + 空态文案 + 该区关心的条目类型 */
interface SectionSpec {
  title: string;
  emptyHint: string;
  kind: TrajectoryKind;
  /** 是否反向展示（最近在上） */
  newestFirst: boolean;
}

const SECTION_SPECS: SectionSpec[] = [
  { title: '工具调用', emptyHint: '本次会话还没有工具调用', kind: TrajectoryKind.TOOL, newestFirst: true },
  { title: '子代理', emptyHint: '本次会话还没有子代理', kind: TrajectoryKind.SUBAGENT, newestFirst: true },
  { title: '交付物', emptyHint: '本次会话还没有产出文件', kind: TrajectoryKind.DELIVERABLE, newestFirst: false },
  { title: '目标', emptyHint: '本次会话还没有设定目标', kind: TrajectoryKind.GOAL, newestFirst: false },
  { title: '任务', emptyHint: '本次会话还没有后台任务', kind: TrajectoryKind.JOB, newestFirst: true }
];

/**
 * 从轨迹派生分区。
 *
 * 纯函数：同样的轨迹必然得到同样的分区（不依赖「当前时间」等外部状态），
 * 因此可以直接单测，也可以在多次渲染间复用。
 */
export function projectDetailSections(trajectory: TrajectoryItem[]): DetailSection[] {
  const out: DetailSection[] = [];
  for (let s = 0; s < SECTION_SPECS.length; s++) {
    const spec: SectionSpec = SECTION_SPECS[s];
    const matched: TrajectoryItem[] = [];
    for (let i = 0; i < trajectory.length; i++) {
      if (trajectory[i].kind === spec.kind) {
        matched.push(trajectory[i]);
      }
    }
    // 轨迹本身按时间递增排列；`newestFirst` 只影响「取哪几条」。
    const start: number = spec.newestFirst && matched.length > DETAIL_LINE_LIMIT
      ? matched.length - DETAIL_LINE_LIMIT : 0;
    const stop: number = spec.newestFirst ? matched.length
      : Math.min(matched.length, DETAIL_LINE_LIMIT);
    const lines: string[] = [];
    for (let i = start; i < stop; i++) {
      const line: string = summarize(matched[i]);
      if (line.length > 0) {
        lines.push(line);
      }
    }
    out.push({ title: spec.title, count: matched.length, lines: lines, emptyHint: spec.emptyHint });
  }
  return out;
}

/** 单条轨迹的摘要行（按类型取该类型真正有意义的字段） */
function summarize(item: TrajectoryItem): string {
  if (item.kind === TrajectoryKind.TOOL) {
    const name: string = item.toolName.length > 0 ? item.toolName : '（未命名工具）';
    return `${name} · ${toolStateLabel(item.toolState)}${elapsedSuffix(item.elapsedMs)}`;
  }
  if (item.kind === TrajectoryKind.SUBAGENT) {
    const name: string = item.subagentName.length > 0 ? item.subagentName : '（未命名子代理）';
    const state: string = item.toolState === undefined ? '' : toolStateLabel(item.toolState);
    return `${name}${state.length > 0 ? ` · ${state}` : ''}${elapsedSuffix(item.elapsedMs)}`;
  }
  if (item.kind === TrajectoryKind.DELIVERABLE) {
    const name: string = item.fileName.length > 0 ? item.fileName : item.title;
    return `${name}${item.fileSize > 0 ? ` · ${formatBytes(item.fileSize)}` : ''}`;
  }
  // GOAL / JOB
  const title: string = item.title.length > 0 ? item.title : '（无标题）';
  const progress: string = item.progress.length > 0
    ? item.progress
    : (item.percent >= 0 ? `${item.percent}%` : '');
  return progress.length > 0 ? `${title} · ${progress}` : title;
}

/** 耗时后缀（0 = 不显示；不显示比显示「0ms」诚实） */
function elapsedSuffix(ms: number): string {
  return ms > 0 ? ` · ${formatDuration(ms)}` : '';
}
