/**
 * 上游会话事件类型的**形状表**（实测事实，唯一来源）。
 *
 * 【这个文件是什么】
 *   一张纯数据表 + 几个纯函数：把「会话事件类型」映射到
 *   「它携带什么字段（取值路径）」「它属于哪个内容槽（槽位，不是家族）」。
 *
 * 【为什么单独一个文件，而不是散在投影代码里】
 *   本工程有一条硬纪律：**上游接口事实只能出现在 `dshcompat`**。
 *   事件字段名属于典型的「上游一改就全错」的事实——例如把 `message.content`
 *   写成 `content`，界面不会报错，只会**永远空白**。所以字段名必须与端点上表
 *   同级管理：集中、可枚举、可门禁。
 *
 * 【这些数据的来源（不是推断）】
 *   D2 §8.7.7：直接逐帧解码 Host 落盘的 `session.v3.jsonl.zstd`
 *   （1485 帧 / 17.1 M 字符 / 5257 条记录，零凭据、零设备）。
 *   `data` 内部结构的取值路径在同一份日志里逐条确认，表尾有「未确认」标注。
 *   未标「未确认」的路径都是**实测到的字面路径**，不要凭直觉改写。
 *
 * 【这张表为什么不会过期】
 *   1. `tools/arch-check.mjs` 禁止 `dshcompat` 之外的模块出现事件名字面量——
 *      想加事件就得改这里；
 *   2. 上游升级时 `tools/compat-drift.mjs` 会报端点漂移；事件名字面量
 *      不在契约 JSON 里，所以另靠 `SessionHub.noteUnknown()` 在真机上汇总
 *      「收到了但本表没有的类型」，回填成本次实测清单即可。
 *
 * 【这里没有、也不该有「前缀猜测表」】
 *   本文件与 `RemoteEvents.ets` 曾经各有一张把命名空间前缀硬编码成家族的
 *   猜测表（`assistant/` → 思考、`error/` → 错误、`job/` → 任务）。
 *   它们已被 D2 §8.7.7 的实测推翻：**不存在** `reasoning/*`、`error/*`、
 *   `job/*` 事件族。两张表都已删除（不是注释掉）——它们是导出过的公开 API，
 *   留着就会被后来者当权威用法照抄，而失效方式是**静默的**：
 *   思考归入普通消息、错误与作业永不显示。
 *   照前缀写代码这条路已被有意堵死，分类只能走实测枚举。
 */

import { EventFamily } from './RemoteEvents';

/**
 * 内容槽位：**与呈现家族正交**的一张表。
 *
 * 【为什么必须分开】
 *   家族（`EventFamily`）回答「这条事件算什么性质」；槽位回答
 *   「它携带的字段该往条目模板的哪一格放」。两者混成一个枚举会出现
 *   自相矛盾的行：`tool/result` 的**家族是 TOOL**（它是一个工具条目），
 *   但它携带的字段是**工具输出**（`toolOutput` 槽位），不是工具名。
 *   用一个 `bodyPath` 字段去表达这两件事，必然要为一类事件写特例分支。
 *
 * 所以：家族表在 `RemoteEvents.ets`（`classifyEventType`），槽位表在本文件。
 *   新增事件时**两处都要看**，这是有意的摩擦点。
 */
export enum ContentSlot {
  /** 用户消息正文 */
  USER_TEXT = 'user-text',
  /** 助手消息正文 */
  ASSISTANT_TEXT = 'assistant-text',
  /** 从 `content: array<{type,text}>` 块里拼接出的文本 */
  CONTENT_BLOCKS = 'content-blocks',
  /** 工具名 */
  TOOL_NAME = 'tool-name',
  /** 工具参数（已编码字符串） */
  TOOL_ARGS = 'tool-args',
  /** 工具输出 */
  TOOL_OUTPUT = 'tool-output',
  /** 工具失败的错误码（实测 `tool/result.data.error.code`） */
  TOOL_ERROR_CODE = 'tool-error-code',
  /** 工具失败的错误名（实测 `tool/result.data.error.name`） */
  TOOL_ERROR_NAME = 'tool-error-name',
  /** 工具结果内层的 `isError` 布尔（实测存在，与 `error` 同时出现） */
  TOOL_IS_ERROR = 'tool-is-error',
  /** 工具调用 id（用于把 `tool/result` 配回 `tool/call`） */
  CALL_ID = 'call-id',
  /** 子代理名称 */
  SUBAGENT_LABEL = 'subagent-label',
  /** 目标标题 */
  GOAL_TITLE = 'goal-title',
  /** 目标阶段 */
  GOAL_PHASE = 'goal-phase',
  /** 任务清单（`array<{content,status}>`） */
  TODO_LIST = 'todo-list',
  /** 模型名 */
  MODEL = 'model',
  /** token 用量 */
  USAGE = 'usage',
  /** 一句话摘要（仅压缩摘要等少数事件有） */
  SUMMARY = 'summary',
  /** 增量流（`array<{type,time,chunk}>`） */
  STREAM = 'stream',
  /** 轮次结束原因 */
  TURN_REASON = 'turn-reason',
  /** 重试计数 */
  RETRY = 'retry',
  /** 边界序号（轮次号 / 步号 / 队列下标）；只驱动状态，不显示为用户内容 */
  ORDINAL = 'ordinal',
  /** 命令或其结果的文本 */
  COMMAND_TEXT = 'command-text',
  /** 子代理会话 id */
  CHILD_ID = 'child-id',
  /** 交付物文件名 */
  DELIVERABLE_FILE = 'deliverable-file',
  /** 交付物说明 */
  DELIVERABLE_DESC = 'deliverable-desc',
  /** 目标 id */
  GOAL_ID = 'goal-id',
  /** 待发队列 splice 的目标位置 */
  INBOX_TARGET = 'inbox-target',
  /** 审计用：只作诊断显示，不进对话流 */
  AUDIT_VALUE = 'audit-value',
  /** 该事件不携带可呈现内容（边界事件、队列 splice 等），只驱动状态 */
  NONE = 'none'
}

/**
 * 一条「路径 → 槽位」的绑定。
 *
 * 用 `slots: ContentSlot[]` 而不是固定的 `bodyPath/namePath/...` 字段：
 * 绑定数量各不相同（`assistant/message` 有 5 条，`turn/start` 只有 1 条），
 * 固定字段会逼出一堆 `path: ''` 的占位空串——占位空串正是「这格没测过」
 * 与「这格确实没有」无法区分的原因。
 *
 * **刻意没有 `alts`（候选路径）字段**：候选路径等于把猜测藏进表里
 * （「先试这个键名，不行再试那个」），一旦写错就会静默取到错误的兄弟字段。
 * 实测确有「同一事件类型两种形状」的情况（`tool/result` 成功/失败），
 * 但两种形状都能用**一条确定的路径**表达（失败形态多出 `error.*` 而已）。
 */
export interface SlotBinding {
  /** 该绑定填充哪个内容槽位 */
  slot: ContentSlot;
  /** 取值路径；整数段按数组下标解释（`files.0.path`）。语义同 `readPath()` */
  path: string;
  /** 该字段是 JSON 编码后的字符串 */
  encoded?: boolean;
  /** 该路径尚未实测确认 */
  unconfirmed?: boolean;
}

/** 一个事件类型的完整形状 */
export interface SessionEventShape {
  /** 事件类型（`event.type` 的线上字面量） */
  type: string;
  /** 路径 → 槽位绑定 */
  slots: SlotBinding[];
  /**
   * 该事件是否会产生一条独立的轨迹条目。
   *
   * `false` 的事件**仍然到达并驱动状态**（轮次、步、标题…），
   * 只是不单独占一行——否则一次对话会被 `step/start`、`step/end`、
   * `turn/start` 之类的边界事件淹成刷屏。
   */
  standalone: boolean;
}

/**
 * 实测的 32 种会话事件类型（D2 §8.7.7）。
 *
 * 【口径说明（必须写清楚，否则下一个人会数出别的数）】
 *   - 统计对象：`session.v3.jsonl.zstd` 里的**顶层事件记录**；
 *   - 不含 `session` 文件头记录（它不是事件，只是日志头）；
 *   - **不含** `assistant/message.data.stream[]` 里的流式记录
 *     （`text-chunks` / `reasoning-chunks` / `tool-call-chunks` / `chunk`）——
 *     它们有 `type` 字段但**不是事件类型**。这一条曾经把清单从 32 污染到 39。
 *
 * 顺序与 D2 表格一致，便于逐行核对。**改这张表必须同步改 D2 表格**。
 */
export const SESSION_EVENT_SHAPES: SessionEventShape[] = [
  // ── 消息 ──────────────────────────────────────────────────────────
  {
    type: 'user/message',
    standalone: true,
    slots: [
      { slot: ContentSlot.CONTENT_BLOCKS, path: 'content' },
      { slot: ContentSlot.MODEL, path: 'source.model' }
    ]
  },
  {
    type: 'assistant/message',
    standalone: true,
    slots: [
      { slot: ContentSlot.CONTENT_BLOCKS, path: 'message.content' },
      { slot: ContentSlot.MODEL, path: 'message.source.model' },
      { slot: ContentSlot.USAGE, path: 'usage' },
      { slot: ContentSlot.STREAM, path: 'stream' }
    ]
  },
  {
    // 一次尝试的开端：不是独立条目（实测结论），只作推理推进
    type: 'assistant/attempt',
    standalone: false,
    slots: [{ slot: ContentSlot.STREAM, path: 'stream' }]
  },
  {
    type: 'system/message',
    standalone: true,
    slots: [{ slot: ContentSlot.CONTENT_BLOCKS, path: 'message.content' }]
  },
  // ── 工具 ──────────────────────────────────────────────────────────
  {
    type: 'tool/call',
    standalone: true,
    slots: [
      { slot: ContentSlot.TOOL_NAME, path: 'name' },
      // 实测：arguments 是 JSON 编码后的**字符串**，不是对象
      { slot: ContentSlot.TOOL_ARGS, path: 'arguments', encoded: true },
      { slot: ContentSlot.CALL_ID, path: 'callId' }
    ]
  },
  {
    type: 'tool/result',
    standalone: true,
    slots: [
      // 实测两种形态：成功只有 message；失败额外有 error{name,code}
      { slot: ContentSlot.CONTENT_BLOCKS, path: 'message.content' },
      { slot: ContentSlot.CALL_ID, path: 'message.source.callId' },
      { slot: ContentSlot.TOOL_IS_ERROR, path: 'message.content.0.isError' },
      { slot: ContentSlot.TOOL_ERROR_CODE, path: 'error.code' },
      { slot: ContentSlot.TOOL_ERROR_NAME, path: 'error.name' }
    ]
  },
  // ── 交付物 ────────────────────────────────────────────────────────
  {
    type: 'deliverables/presented',
    standalone: true,
    slots: [
      { slot: ContentSlot.DELIVERABLE_FILE, path: 'files.0.path' },
      { slot: ContentSlot.DELIVERABLE_DESC, path: 'files.0.description' },
      { slot: ContentSlot.CALL_ID, path: 'callId' }
    ]
  },
  // ── 子代理 ────────────────────────────────────────────────────────
  {
    type: 'subagent/catalog',
    standalone: true,
    slots: [
      { slot: ContentSlot.SUBAGENT_LABEL, path: 'label' },
      { slot: ContentSlot.CHILD_ID, path: 'childId' }
    ]
  },
  {
    // 实测与 `subagent/catalog` 同 label、**没有 childId**：是同一个子代理的另一面。
    // 非独立条目，靠 label 把模型信息补回 catalog 那一行。
    type: 'subagent/descriptor',
    standalone: false,
    slots: [
      { slot: ContentSlot.SUBAGENT_LABEL, path: 'label' },
      { slot: ContentSlot.MODEL, path: 'agentModel' }
    ]
  },
  // ── 目标 ──────────────────────────────────────────────────────────
  {
    type: 'goal/change',
    standalone: true,
    slots: [
      { slot: ContentSlot.GOAL_TITLE, path: 'goal.objective' },
      { slot: ContentSlot.GOAL_PHASE, path: 'goal.phase' },
      { slot: ContentSlot.GOAL_ID, path: 'goal.id' }
    ]
  },
  // ── 任务清单 ──────────────────────────────────────────────────────
  {
    type: 'todo/write',
    standalone: true,
    slots: [{ slot: ContentSlot.TODO_LIST, path: 'todos' }]
  },
  // ── 轮次 / 步边界（只驱动状态，不占行） ───────────────────────────
  {
    type: 'turn/start',
    standalone: false,
    slots: [{ slot: ContentSlot.ORDINAL, path: 'turn' }]
  },
  {
    type: 'turn/end',
    standalone: false,
    slots: [
      { slot: ContentSlot.TURN_REASON, path: 'reason.kind' },
      { slot: ContentSlot.ORDINAL, path: 'turn' }
    ]
  },
  {
    type: 'step/start',
    standalone: false,
    slots: [{ slot: ContentSlot.ORDINAL, path: 'step' }]
  },
  {
    type: 'step/end',
    standalone: false,
    slots: [{ slot: ContentSlot.ORDINAL, path: 'step' }]
  },
  // ── 标题 ──────────────────────────────────────────────────────────
  {
    type: 'session/title',
    standalone: false,
    slots: [{ slot: ContentSlot.SUMMARY, path: 'title' }]
  },
  {
    // 让 LLM 生成标题的那次请求（含完整 prompt 与消息）。中间过程，不进对话流。
    type: 'session/title-llm-request',
    standalone: false,
    slots: [
      { slot: ContentSlot.MODEL, path: 'route.model' },
      { slot: ContentSlot.SUMMARY, path: 'titleProvider' }
    ]
  },
  // ── 上下文压缩 ────────────────────────────────────────────────────
  {
    type: 'compaction/start',
    standalone: false,
    slots: [{ slot: ContentSlot.SUMMARY, path: 'sourceCommandId' }]
  },
  {
    type: 'compaction/end',
    standalone: false,
    slots: [{ slot: ContentSlot.SUMMARY, path: 'compactionId' }]
  },
  {
    type: 'compaction/summary',
    standalone: true,
    slots: [
      { slot: ContentSlot.SUMMARY, path: 'summary' },
      { slot: ContentSlot.MODEL, path: 'model' },
      { slot: ContentSlot.USAGE, path: 'usage' }
    ]
  },
  // ── 重试（失败可视化的真实来源） ──────────────────────────────────
  {
    type: 'llm/retry',
    standalone: true,
    slots: [
      // 实测 data 顶层有 delayMs / failure / maxRetries / retry，
      // 但 failure 的内部形状（错误码字段名）**未实测**，故不在此绑定。
      { slot: ContentSlot.RETRY, path: 'retry' },
      { slot: ContentSlot.MODEL, path: 'provider' }
    ]
  },
  {
    type: 'llm/retry-started',
    standalone: false,
    slots: [{ slot: ContentSlot.RETRY, path: 'retry' }]
  },
  // ── 请求上下文 ────────────────────────────────────────────────────
  {
    type: 'request/context',
    standalone: false,
    slots: [
      { slot: ContentSlot.MODEL, path: 'model' },
      { slot: ContentSlot.USAGE, path: 'contextWindow' }
    ]
  },
  {
    type: 'request/header',
    standalone: false,
    slots: [{ slot: ContentSlot.SUMMARY, path: 'reason' }]
  },
  // ── 斜杠命令 ──────────────────────────────────────────────────────
  {
    type: 'command/run',
    standalone: true,
    slots: [
      { slot: ContentSlot.SUMMARY, path: 'name' },
      { slot: ContentSlot.COMMAND_TEXT, path: 'args' }
    ]
  },
  {
    type: 'command/done',
    standalone: false,
    slots: [{ slot: ContentSlot.COMMAND_TEXT, path: 'text' }]
  },
  // ── 待发队列 splice ──────────────────────────────────────────────
  {
    type: 'agent/inbox/spliced',
    standalone: false,
    slots: [
      { slot: ContentSlot.ORDINAL, path: 'start' },
      { slot: ContentSlot.INBOX_TARGET, path: 'target' }
    ]
  },
  // ── 联网搜索 ──────────────────────────────────────────────────────
  {
    type: 'web/deepseek-search-llm-request',
    standalone: false,
    slots: [{ slot: ContentSlot.SUMMARY, path: 'endpoint' }]
  },
  // ── 分叉种子结束标记（data 为空） ─────────────────────────────────
  {
    type: 'session/end-seed',
    standalone: false,
    slots: [{ slot: ContentSlot.NONE, path: '$' }]
  },
  // ── 审计类：有记录价值但无对话内容，投影时跳过 ───────────────────
  {
    type: 'permission/preset',
    standalone: false,
    slots: [{ slot: ContentSlot.AUDIT_VALUE, path: 'preset' }]
  },
  {
    type: 'sandbox/mode',
    standalone: false,
    slots: [{ slot: ContentSlot.AUDIT_VALUE, path: 'mode' }]
  },
  {
    type: 'approval/policy',
    standalone: false,
    slots: [{ slot: ContentSlot.AUDIT_VALUE, path: 'policy' }]
  }
];

/** 按事件类型查形状；未实测过的类型返回 `undefined`（**不猜**） */
export function eventShapeOf(type: string): SessionEventShape | undefined {
  for (let i = 0; i < SESSION_EVENT_SHAPES.length; i++) {
    if (SESSION_EVENT_SHAPES[i].type === type) {
      return SESSION_EVENT_SHAPES[i];
    }
  }
  return undefined;
}

/** 该事件类型是否已被实测记录 */
export function isMeasuredEventType(type: string): boolean {
  return eventShapeOf(type) !== undefined;
}

/** 在形状里找某个槽位的绑定；没有则返回 `undefined` */
export function slotBinding(shape: SessionEventShape, slot: ContentSlot): SlotBinding | undefined {
  for (let i = 0; i < shape.slots.length; i++) {
    if (shape.slots[i].slot === slot) {
      return shape.slots[i];
    }
  }
  return undefined;
}

/** 实测清单里的事件类型总数（供诊断页与测试断言） */
export const MEASURED_EVENT_TYPE_COUNT: number = SESSION_EVENT_SHAPES.length;

/**
 * 家族 → 是否可作为独立轨迹条目呈现。
 *
 * 与 `standalone` 的区别：`standalone` 是**每种事件**的实测结论
 * （`session/title` 不是条目，但它确实改了状态）；本函数是**家族级**的兜底，
 * 用于「未知类型」——未知类型一律以消息形式呈现，宁可多一行也不要少一截对话。
 */
export function familyIsStandalone(family: EventFamily): boolean {
  return family === EventFamily.MESSAGE
    || family === EventFamily.TOOL
    || family === EventFamily.SUBAGENT
    || family === EventFamily.GOAL
    || family === EventFamily.JOB
    || family === EventFamily.DELIVERABLE
    || family === EventFamily.ERROR;
}
