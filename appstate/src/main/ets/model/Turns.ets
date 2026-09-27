/**
 * 回合模型（P1：计划 §8「Conversation 对齐 Web」的模型半边）。
 *
 * ## 要解决的问题
 *
 * 官方 Web 的会话不是"一串条目"，而是：
 *
 * ```
 * Turn
 *  ├─ ProcessGroup { reasoning / tool / subagent / progress }
 *  └─ Answer { ActionStrip }
 * ```
 *
 * 而本仓此前把轨迹当成**扁平列表**渲染——于是"已完成的回合可折叠、进行中的回合展开"
 * 这类规则没有落脚点：折叠的单位是**回合**，不是条目。这个文件提供那个单位。
 *
 * ## 为什么单独成文件、且是纯函数
 *
 * 分组规则（什么算一个回合的"过程"、什么算"回答"、空回合怎么处理）是**判断**，
 * 不是渲染。放在这里之后：
 *   · `tools/check-layout-fixtures.mjs` 能在**本机直接执行**它（无需真机）；
 *   · 视图层只回答"这个回合该怎么画"，不再自己判断"这两条是不是同一个回合"。
 *
 * ## 与既有分层的关系
 *
 * 输入是 `model/Trajectory.ets` 的 `TrajectoryItem`（呈现层契约），输出是本文件的新类型。
 * 不碰协议、不碰 `dshcompat`——事件到条目的投影仍由 `SessionHub.projectWireRecord` 负责。
 */

import { Speaker, TrajectoryItem, TrajectoryKind } from './Trajectory';

/** 一个回合里的"过程"条目类型：思考、工具、子代理、目标/任务进度、交付物 */
function isProcessKind(kind: TrajectoryKind): boolean {
  return kind === TrajectoryKind.REASONING
    || kind === TrajectoryKind.TOOL
    || kind === TrajectoryKind.SUBAGENT
    || kind === TrajectoryKind.GOAL
    || kind === TrajectoryKind.JOB
    || kind === TrajectoryKind.DELIVERABLE;
}

/**
 * 一条条目在**对话视图**里的角色（P0-1：提示词/内部事件泄漏）。
 *
 * 【为什么单独成一个判据而不是散在视图里】此前"该不该显示"由两处各自猜：
 * `groupTurns()` 无条件把 `MESSAGE + 助手` 塞进 `answers`，
 * `chatVisibleItems()` 又自己写了一条"speaker 不是 SYSTEM 就显示"。
 * 两处判据不同，且**都不看来源**——于是 `command/run`（斜杠命令）、
 * `compaction/summary`（上下文压缩）与**未识别事件**（正文是原始 JSON）都漏进了对话。
 *
 * 现在只有这一个判据，且它只看**结构**（`internal` 来源事实 + 种类 + 角色）：
 *   · `HIDDEN`   —— 内部事件：不进对话的任何位置（系统提示词 / 未知类型 / 命令 / 压缩 / 审计）
 *   · `USER`     —— 用户消息（正文气泡）
 *   · `ASSISTANT`—— 助手回答（正文气泡）
 *   · `PROCESS`  —— 过程（工具/子代理/目标/任务/交付物）：只进**折叠的过程分组**，不与回答抢层级
 *   · `NOTICE`   —— 其它明面提示（当前只有错误）
 */
export enum ConversationAudience {
  HIDDEN = 'hidden',
  USER = 'user',
  ASSISTANT = 'assistant',
  PROCESS = 'process',
  NOTICE = 'notice',
}

export function conversationAudienceOf(item: TrajectoryItem): ConversationAudience {
  if (item.internal) {
    return ConversationAudience.HIDDEN;
  }
  if (item.kind === TrajectoryKind.MESSAGE) {
    if (item.speaker === Speaker.USER) {
      return ConversationAudience.USER;
    }
    if (item.speaker === Speaker.ASSISTANT) {
      return ConversationAudience.ASSISTANT;
    }
    // SYSTEM 等其它角色：即便来源可见也不进对话（系统提示词就是这一类）
    return ConversationAudience.HIDDEN;
  }
  if (item.kind === TrajectoryKind.ERROR) {
    return ConversationAudience.NOTICE;
  }
  if (isProcessKind(item.kind)) {
    return ConversationAudience.PROCESS;
  }
  return ConversationAudience.HIDDEN;
}

/** 该条目是否需要与普通回答**视觉隔离**（P0-1 最后一条要求） */
export function needsInternalIsolation(item: TrajectoryItem): boolean {
  return item.internal;
}

/** 回合 */

export interface Turn {
  /** 稳定 id（取回合首条的 id；用于 ForEach 的键与折叠状态记忆） */
  id: string;
  /** 触发这个回合的用户消息（历史加载或系统发起时可能没有） */
  user: TrajectoryItem | undefined;
  /** 过程条目（工具/思考/子代理/进度…），按原顺序 */
  process: TrajectoryItem[];
  /** 回答条目（助手消息）；可能多条，`answer` 是最后一条 */
  answers: TrajectoryItem[];
  answer: TrajectoryItem | undefined;
  /** 不参与回合结构、但要如实显示的条目（错误、系统提示） */
  notices: TrajectoryItem[];
  /**
   * 这个回合**是否仍在进行**。
   *
   * 判定：会话正在跑且这是最后一个回合，或最后一条是流式输出。
   * 【为什么要显式建模】§8 要求"进行中的回合展开、已完成的回合可折叠"——
   * 折叠的默认态由它决定，而不是由"用户上次点过什么"决定。
   */
  running: boolean;
}

/**
 * 把一个会话的条目切成回合。
 *
 * 规则（逐条都有理由，改动前先看这里）：
 *   1. **用户消息开一个新回合**：这是唯一可靠的回合边界（助手消息可能有多条）。
 *   2. 助手消息进 `answers`；**最后一条**是 `answer`（官方把 ActionStrip 挂在最终回答上）。
 *   3. 过程类条目（工具/思考/子代理/进度/交付物）进 `process`，保持原顺序。
 *   4. 错误与系统消息进 `notices`——它们不属于"这个回合做了什么"，
 *      但**必须显示**（错误是"为什么没有回答"的唯一说明，E134 的教训）。
 *   5. 首条用户消息之前的内容（如历史加载出来的通知）单独成一个回合，`user` 为空。
 */
export function groupTurns(items: TrajectoryItem[], sessionRunning: boolean): Turn[] {
  const turns: Turn[] = [];

  const newTurn = (id: string): Turn => ({
    id: id,
    user: undefined,
    process: [],
    answers: [],
    answer: undefined,
    notices: [],
    running: false
  });

  let current: Turn | undefined = undefined;

  for (let i = 0; i < items.length; i++) {
    const item: TrajectoryItem = items[i];

    const audience: ConversationAudience = conversationAudienceOf(item);
    if (audience === ConversationAudience.HIDDEN) {
      // 内部事件**根本不进回合**：轨迹视图仍按 `items` 显示它们（排查需要），
      // 但它们不属于对话——不占用户消息、不算回答、也不进过程分组。
      continue;
    }

    if (audience === ConversationAudience.USER) {
      current = newTurn(item.id);
      current.user = item;
      turns.push(current);
      continue;
    }

    if (current === undefined) {
      // 首条用户消息之前的内容：单独成回合（id 前缀区分，避免与真实条目 id 撞车）
      current = newTurn(`pre-${item.id}`);
      turns.push(current);
    }

    if (audience === ConversationAudience.ASSISTANT) {
      current.answers.push(item);
      current.answer = item;
    } else if (audience === ConversationAudience.PROCESS) {
      current.process.push(item);
    } else {
      current.notices.push(item);
    }
  }

  // 进行中：会话在跑时，**最后一个回合**视为进行中。
  // 另外单独看流式标记：即使中枢说停了，仍有条目在流式输出时也不该折叠它。
  for (let i = 0; i < turns.length; i++) {
    const isLast: boolean = i === turns.length - 1;
    let streaming: boolean = false;
    for (let j = 0; j < turns[i].answers.length; j++) {
      if (turns[i].answers[j].streaming) {
        streaming = true;
      }
    }
    turns[i].running = streaming || (isLast && sessionRunning);
  }

  return turns;
}

/**
 * 一个回合**是否显示过程分组**。
 *
 * §8 的「tool-only 空节点不显示」落在这里：`process` 为空时**根本不建这个节点**，
 * 而不是建一个空容器再靠样式隐藏——后者会留下可聚焦的空区域（无障碍与键盘导航都会踩到）。
 */
export function hasProcessGroup(turn: Turn): boolean {
  return turn.process.length > 0;
}

/**
 * 对话视图（chat）下可见的条目。
 *
 * 【为什么需要模型来定这件事】此前 `ConversationPane.visibleItems()` 自己写了一条规则
 * （"只留 MESSAGE 与 ERROR，且系统消息跳过"）。那是**视图层在替模型做判断**：
 * 同一个"什么算对话内容"的问题，换个视图又要再答一次。
 * 现在它由回合模型回答：用户消息、回答、以及 notices（错误必须留在这里——
 * 它是"为什么没有回答"的唯一说明）。
 *
 * 注意：**过程条目（工具/思考）不进对话视图**，但它们在轨迹视图里全都在——
 * 两个视图的区别是"看什么"，不是"有没有"。
 */
export function chatVisibleItems(turns: Turn[]): TrajectoryItem[] {
  const out: TrajectoryItem[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t: Turn = turns[i];
    if (t.user !== undefined) {
      out.push(t.user);
    }
    for (let j = 0; j < t.answers.length; j++) {
      out.push(t.answers[j]);
    }
    for (let j = 0; j < t.notices.length; j++) {
      // 与 `groupTurns()` **共用同一判据**：以前这里另写了一条"speaker 不是 SYSTEM 就显示"，
      // 两处判据不同 ⇒ 一处改了另一处不会跟着改（那正是内部事件漏进对话的成因之一）。
      const audience: ConversationAudience = conversationAudienceOf(t.notices[j]);
      if (audience !== ConversationAudience.HIDDEN) {
        out.push(t.notices[j]);
      }
    }
  }
  return out;
}

/**
 * 过程分组的摘要标题（折叠时显示）。
 *
 * 例如「工具 3 · 思考 1」——**用数量而不是猜语义**：我们只知道条目类型与数量，
 * 编一句"正在分析代码"之类的文案就是在替模型说话（本项目对"界面不撒谎"有明确纪律）。
 */
export function processSummary(turn: Turn): string {
  let tools: number = 0;
  let thoughts: number = 0;
  let others: number = 0;
  for (let i = 0; i < turn.process.length; i++) {
    const k: TrajectoryKind = turn.process[i].kind;
    if (k === TrajectoryKind.TOOL) {
      tools += 1;
    } else if (k === TrajectoryKind.REASONING) {
      thoughts += 1;
    } else {
      others += 1;
    }
  }
  const parts: string[] = [];
  if (thoughts > 0) {
    parts.push(`思考 ${thoughts}`);
  }
  if (tools > 0) {
    parts.push(`工具 ${tools}`);
  }
  if (others > 0) {
    parts.push(`其他 ${others}`);
  }
  return parts.length === 0 ? '' : parts.join(' · ');
}

/** 回合是否应该默认展开（§8：进行中展开，已完成折叠） */
export function defaultExpanded(turn: Turn, userExpanded: boolean): boolean {
  return turn.running || userExpanded;
}
