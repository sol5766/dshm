/**
 * 轨迹（会话内容）视图模型。
 *
 * 这些类型是**呈现层契约**：UI 只认识它们，不认识协议原始对象。
 * 因此「桩数据」与「真实事件投影」可以互换而不改动任何组件（见 StubFeed）。
 *
 * 与 D3 §3.2 / §3.3 的界面规格一一对应。
 */

/** 角色 */
export enum Speaker {
  USER = 'user',
  ASSISTANT = 'assistant',
  SYSTEM = 'system'
}

/** 工具调用状态（D3 §3.3 的徽标） */
export enum ToolState {
  PENDING = 'pending',
  RUNNING = 'running',
  SUCCESS = 'success',
  FAILED = 'failed',
  REJECTED = 'rejected'
}

/** 轨迹条目类型 */
export enum TrajectoryKind {
  MESSAGE = 'message',
  REASONING = 'reasoning',
  TOOL = 'tool',
  SUBAGENT = 'subagent',
  DELIVERABLE = 'deliverable',
  GOAL = 'goal',
  JOB = 'job',
  ERROR = 'error'
}

/** 轨迹条目基类（用一个接口承载所有可选字段，避免 ArkTS 联合类型在 UI 中难用） */
export interface TrajectoryItem {
  id: string;
  kind: TrajectoryKind;
  /** 稳定排序键（毫秒时间戳） */
  at: number;
  /** 正文（Markdown；仅 MESSAGE / REASONING / ERROR 使用） */
  body: string;
  /**
   * 思考内容（仅 MESSAGE；E107）。
   *
   * 【为什么单独一个字段】真实事件里的助手消息是**多块**的：
   *   `content: [{type:'reasoning', text:…}, {type:'text', text:…}]`
   * 早先的解析把所有块**拼成一段**塞进 `body`，于是界面上"思考"与"正文"糊在一个气泡里
   * （真机截图就是这样：先一段英文自述、再一句回答）。官方 web 把思考放进**折叠块**、
   * 正文单独成段——在这里把两者分开，视图层才能照做。
   */
  reasoning: string;
  /** 角色（仅 MESSAGE） */
  speaker: Speaker;
  /** 模型名（仅 ASSISTANT 消息显示为次要信息） */
  model: string;
  /** 耗时毫秒（0 = 不显示） */
  elapsedMs: number;
  /** 工具名（仅 TOOL） */
  toolName: string;
  /**
   * 工具调用 id（仅 TOOL；`tool/call` 与 `tool/result` 靠它配对）。
   *
   * 实测：`tool/result` 用 `message.source.callId` 指回调用，
   * 但**结果帧本身不携带工具名**——工具名只在 `tool/call` 上。
   * 因此两帧必须合成同一条目，否则工具卡会显示成「没有名字的结果」。
   */
  callId: string;
  /** 工具参数摘要（仅 TOOL，单行） */
  toolArgs: string;
  /** 工具状态（仅 TOOL） */
  toolState: ToolState;
  /** 工具输出（仅 TOOL；大输出由 UI 截断，D3 §3.3） */
  toolOutput: string;
  /** 子代理名称（仅 SUBAGENT） */
  subagentName: string;
  /** 交付物文件名（仅 DELIVERABLE） */
  fileName: string;
  /** 交付物大小（字节；0 = 未知） */
  fileSize: number;
  /** 目标/任务标题（仅 GOAL / JOB） */
  title: string;
  /** 目标/任务进度描述（仅 GOAL / JOB） */
  progress: string;
  /** 进度百分比（0–100；负数 = 不确定） */
  percent: number;
  /** 是否正在流式输出（UI 显示尾部光标） */
  streaming: boolean;
  /**
   * **内部事件**：只属于轨迹详情，不属于对话（P0-1）。
   *
   * 【为什么要有这个结构字段】对话视图此前靠"正文文本 + speaker"判断该显示什么，
   * 而"这个事件是不是用户可见的会话内容"是**来源事实**，不是内容特征：
   *   · `system/message`（系统提示词）、`command/run`（斜杠命令）、
   *     `compaction/summary`（上下文压缩摘要）都是 MESSAGE 族，会被当成"助手的回答"；
   *   · **未识别事件**更糟：投影会把原始载荷 JSON 当正文，对话里就出现一条"助手说：{…}"。
   * 判定由 `dshcompat.isConversationVisibleEvent()` 在**投影时**（拿到事件类型名那一刻）做出，
   * 这里只存结论——视图与分组模型都不再猜。
   *
   * 轨迹视图**保留**它们（排查需要），但必须与普通回答视觉隔离。
   */
  internal: boolean;
  /** 是否默认展开（如失败的工具、错误） */
  expanded: boolean;
}

/** 构造一个带默认值的条目（ArkTS 要求显式初始化所有字段） */
export function makeItem(id: string, kind: TrajectoryKind, at: number): TrajectoryItem {
  return {
    id: id,
    kind: kind,
    at: at,
    body: '',
    reasoning: '',
    speaker: Speaker.ASSISTANT,
    model: '',
    elapsedMs: 0,
    toolName: '',
    callId: '',
    toolArgs: '',
    toolState: ToolState.PENDING,
    toolOutput: '',
    subagentName: '',
    fileName: '',
    fileSize: 0,
    title: '',
    progress: '',
    percent: -1,
    streaming: false,
    expanded: false,
    internal: false
  };
}

/**
 * 合并两条**同一工具调用**的条目（`tool/call` 与 `tool/result`）。
 *
 * 【为什么必须合并，而不是各占一行】
 *   实测（D2 §8.7.7）：`tool/call` 携带 `name` + `arguments`，
 *   `tool/result` 只携带 `message.content` + `message.source.callId`——
 *   **结果帧里没有工具名**。若各占一行，用户会看到一张没有名字的工具卡，
 *   后面跟着一段不知从哪来的输出。两帧必须落在同一张卡上。
 *
 * 【保留策略】把 `next`（后到的那条）当作真相：
 *   - 工具名与参数**只在 call 上有**，所以从 `previous` 补；
 *   - 输出与状态**只在 result 上有**，所以以 `next` 为准；
 *   - `at` 取两者较晚者（排序键要跟着最新活动走）。
 *   这是纯函数，刻意与事件到达顺序解耦：无论 snapshot 里哪条先出现，
 *   合并结果都一样——顺序依赖正是这类缺陷最难查的形态。
 */
export function mergeTrajectoryItem(previous: TrajectoryItem, next: TrajectoryItem): TrajectoryItem {
  const merged: TrajectoryItem = makeItem(previous.id, next.kind, Math.max(previous.at, next.at));
  merged.body = next.body.length > 0 ? next.body : previous.body;
  merged.speaker = next.speaker;
  merged.model = next.model.length > 0 ? next.model : previous.model;
  merged.elapsedMs = next.elapsedMs > 0 ? next.elapsedMs : previous.elapsedMs;
  merged.toolName = next.toolName.length > 0 ? next.toolName : previous.toolName;
  merged.callId = next.callId.length > 0 ? next.callId : previous.callId;
  merged.toolArgs = next.toolArgs.length > 0 ? next.toolArgs : previous.toolArgs;
  merged.toolOutput = next.toolOutput.length > 0 ? next.toolOutput : previous.toolOutput;
  // PENDING 是「这帧没解析出状态」的占位，此时保留另一侧的真实状态
  merged.toolState = next.toolState === ToolState.PENDING ? previous.toolState : next.toolState;
  merged.subagentName = next.subagentName.length > 0 ? next.subagentName : previous.subagentName;
  merged.fileName = next.fileName.length > 0 ? next.fileName : previous.fileName;
  merged.fileSize = next.fileSize > 0 ? next.fileSize : previous.fileSize;
  merged.title = next.title.length > 0 ? next.title : previous.title;
  merged.progress = next.progress.length > 0 ? next.progress : previous.progress;
  merged.percent = next.percent >= 0 ? next.percent : previous.percent;
  merged.streaming = next.streaming;
  merged.expanded = next.expanded || previous.expanded;
  return merged;
}

/** 在列表中按 id 定位条目；不存在返回 -1 */
export function indexOfItem(items: TrajectoryItem[], id: string): number {
  for (let i = 0; i < items.length; i++) {
    if (items[i].id === id) {
      return i;
    }
  }
  return -1;
}

/**
 * 按种类筛出条目（P3-4：右栏面板要的就是"本次会话的某一类条目"）。
 *
 * 【为什么放在模型里】右栏的「交付物」「工具」「子代理」三个面板做的都是同一件事：
 * **把过程流按种类筛一遍**。筛法（保序、按 id 去重、跳过程序性条目）是可以被断言的东西，
 * 而"视图里写一个 for 循环"既测不到、又会在三个面板里各写一遍（写三遍必然走样）。
 *
 * @param items 过程流（通常是当前会话的 `trajectoryItems`）
 * @param kind 想要的种类
 */
export function itemsOfKind(items: TrajectoryItem[], kind: TrajectoryKind): TrajectoryItem[] {
  const out: TrajectoryItem[] = [];
  const seen: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item: TrajectoryItem = items[i];
    if (item.kind !== kind) {
      continue;
    }
    // 同 id 只留最后一条：过程流里同一条会被反复 merge（流式更新），去重后才是"有几件事"
    const at: number = seen.indexOf(item.id);
    if (at >= 0) {
      out[at] = item;
      continue;
    }
    seen.push(item.id);
    out.push(item);
  }
  return out;
}

/** 本次会话的交付物（右栏「交付物」面板用；保序） */
export function deliverablesOf(items: TrajectoryItem[]): TrajectoryItem[] {
  return itemsOfKind(items, TrajectoryKind.DELIVERABLE);
}

/** 审批风险等级（D3 §3.4：危险动作视觉权重反转） */
export enum RiskLevel {
  NORMAL = 'normal',
  ELEVATED = 'elevated',
  DANGEROUS = 'dangerous'
}

/** 待决类型 */
export enum PendingKind {
  APPROVAL = 'approval',
  QUESTION = 'question'
}

/** 审批/提问的候选项 */
export interface PendingChoice {
  id: string;
  label: string;
  detail: string;
}

/**
 * 审批三选的**稳定 id 契约**。
 *
 * 为什么必须集中声明：审批卡的「主选项判定」（D3 §3.4 危险动作把拒绝提为主选）
 * 依赖 `choice.id`。曾出现过桩数据用 `once`、真实中枢用 `allow` 的分歧——
 * 结果是在真机上**危险动作的拒绝按钮拿不到主选样式**，
 * 而界面看起来完全正常，只是权重反转悄悄失效了（正是最难发现的那类不一致）。
 * 因此把 id 提为唯一契约，桩数据与中枢都从这里取，视图也用它判定。
 *
 * 与上游的对应关系：上游审批结果词表是 `allowed-once | rejected | cancelled | unavailable`
 * （见 `dshcompat.APPROVAL_OUTCOMES`），**没有**「始终允许」。
 * `APPROVAL_CHOICE_ALLOW_ALWAYS` 因此只表达**客户端侧**的「本会话内不再打扰」，
 * 发往 Host 的仍然是 `allowed-once`。
 */
export const APPROVAL_CHOICE_ALLOW: string = 'allow';
/** 客户端侧的「本会话内不再打扰」（**不是**一个上游 outcome） */
export const APPROVAL_CHOICE_ALLOW_ALWAYS: string = 'allow-always';
/** 拒绝 */
export const APPROVAL_CHOICE_DENY: string = 'deny';

/** 待决事项（审批或提问；D3 §3.4 / §3.5） */
export interface PendingItem {
  id: string;
  kind: PendingKind;
  /** 所属会话 id */
  sessionId: string;
  /** 所属会话标题（聚合页展示） */
  sessionTitle: string;
  /** 动作名 / 问题正文 */
  title: string;
  /** 影响说明 / 问题补充说明 */
  detail: string;
  /** 原始请求载荷（可展开查看） */
  raw: string;
  /** 风险等级 */
  risk: RiskLevel;
  /** 选项（审批为三选，提问来自 Host） */
  choices: PendingChoice[];
  /** 是否允许多选（仅提问） */
  multiSelect: boolean;
  /** 是否允许自由文本（仅提问） */
  allowFreeText: boolean;
  /** 入队时间 */
  at: number;
}
