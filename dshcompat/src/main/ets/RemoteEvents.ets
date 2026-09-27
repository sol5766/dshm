/**
 * 上游「转发事件」事实表与审批/提问的线上词汇。
 *
 * 为什么单独成文件（回答「方便适配上游升级」）：
 *   审批与提问是 dsh 客户端的**第一交互**（D1 §G5）。它们不走业务端点，
 *   而是走网关的**转发事件流**（`$events`）——上游叫 Remote Events。
 *   这条链路上有两块易碎的上游知识：
 *     1. **哪些事件会被转发**：上游有一份显式白名单（`API_REMOTE_FORWARDED_EVENTS`），
 *        不在白名单里的事件永远到不了客户端。漏一条就是功能缺失，多一条就是幻想。
 *     2. **答复的词表与编码**：审批结果是封闭枚举，提问答案有固定结构，
 *        写错一个字符串就是「用户点了同意但 Host 认为非法」。
 *   把这两块集中在本文件后，上游增删事件或改词表时只改这里。
 *
 * 证据来源（全部来自实测的上游类型声明，非推测）：
 *   - 白名单：`@deepseek-ai/dsh-api-remotes/lib/types/remote-events.d.ts`
 *     → `API_REMOTE_FORWARDED_EVENTS`
 *   - 帧结构：`@deepseek-ai/dsh-api-gateway/lib/types/stream-protocol.d.ts`
 *     → `RemoteEventReadyFrame` / `RemoteEventEmitFrame` / `RemoteEventInvocationFrame` /
 *       `RemoteEventCancellationFrame` / `RemoteEventResult`
 *   - 审批词汇：`@deepseek-ai/dsh-user-approval/lib/types/types.d.ts` → `ApprovalOutcome`
 *   - 提问结构：`@deepseek-ai/dsh-user-questions/lib/types/types.d.ts`
 *     → `AskUserQuestionItem` / `AskUserQuestionAnswerItem`
 *   - 会话标题投影键：`@deepseek-ai/dsh-session-title/lib/types/types.d.ts`
 *     → `SessionProjectionMap.title`
 *
 * 采集版本：`@deepseek-ai/dsh` 0.1.5-rc.1
 */

/** 转发模式 */
export enum ForwardedEventMode {
  /** 单向通知：客户端只收，不回 */
  EMIT = 'emit',
  /** 瀑布调用：客户端可以「应答」或「交给下一个应答者」 */
  WATERFALL = 'waterfall'
}

/** 一条被转发到客户端的上游事件 */
export interface ForwardedEvent {
  /** 上游 Cordis 事件名（原样，不重命名） */
  event: string;
  mode: ForwardedEventMode;
  /** 该事件在客户端侧对应什么功能（便于升级时判断影响面） */
  purpose: string;
}

/**
 * 上游转发白名单（19 条）。
 *
 * 纪律：**不在本表的事件不会到达客户端**。想用某个上游事件前先在这里查；
 * 查不到说明要么上游没转发它，要么我们还没同步白名单——两种情况都必须先核实，
 * 不能靠「监听一下试试」。
 */
export const FORWARDED_EVENTS: ForwardedEvent[] = [
  { event: 'agent-preset/selected', mode: ForwardedEventMode.EMIT, purpose: '会话的 Agent 预设变更 → 详情栏刷新' },
  { event: 'approval/request', mode: ForwardedEventMode.WATERFALL, purpose: '**审批请求 → 待决卡**（需应答）' },
  { event: 'api-session/activity', mode: ForwardedEventMode.EMIT, purpose: '会话活动时间推进 → 列表排序' },
  { event: 'api-session/added', mode: ForwardedEventMode.EMIT, purpose: '会话出现 → 列表新增' },
  { event: 'api-session/error', mode: ForwardedEventMode.EMIT, purpose: '会话异常 → 错误条目' },
  { event: 'api-session/removed', mode: ForwardedEventMode.EMIT, purpose: '会话移除 → 列表删除' },
  { event: 'api-session/status', mode: ForwardedEventMode.EMIT, purpose: '运行状态变化 → 列表徽标' },
  { event: 'commands/change', mode: ForwardedEventMode.EMIT, purpose: '斜杠命令集变化 → 输入区弹层刷新' },
  { event: 'credentials/reference-updated', mode: ForwardedEventMode.EMIT, purpose: '凭据引用变化 → 设置页刷新' },
  { event: 'goal/activation-changed', mode: ForwardedEventMode.EMIT, purpose: '目标激活状态变化 → 目标区块' },
  { event: 'cordis/request-run', mode: ForwardedEventMode.EMIT, purpose: '插件请求运行 → 插件页（当前未接入）' },
  { event: 'cordis/request-run-resolved', mode: ForwardedEventMode.EMIT, purpose: '插件请求已决 → 插件页（当前未接入）' },
  { event: 'cordis/dynamic-package', mode: ForwardedEventMode.EMIT, purpose: '动态插件包 → 插件页（当前未接入）' },
  { event: 'cordis/dynamic-retract', mode: ForwardedEventMode.EMIT, purpose: '动态插件撤回 → 插件页（当前未接入）' },
  { event: 'cordis/inspect-query', mode: ForwardedEventMode.EMIT, purpose: '插件检视查询 → 插件页（当前未接入）' },
  { event: 'cordis/inspect-query-resolved', mode: ForwardedEventMode.EMIT, purpose: '插件检视已决 → 插件页（当前未接入）' },
  { event: 'llm/adapters-updated', mode: ForwardedEventMode.EMIT, purpose: '模型适配器变化 → 模型页刷新' },
  { event: 'settings/document-updated', mode: ForwardedEventMode.EMIT, purpose: '设置文档变化 → 设置页刷新' },
  { event: 'user-questions/request', mode: ForwardedEventMode.WATERFALL, purpose: '**用户提问 → 提问卡**（需应答）' }
];

/** 审批请求事件名（waterfall） */
export const WATERFALL_APPROVAL: string = 'approval/request';
/** 用户提问事件名（waterfall） */
export const WATERFALL_QUESTION: string = 'user-questions/request';

// ── 会话列表相关通知事件（emit） ──
//
// 为什么要点名导出而不是让上层写字符串：上层一旦自己拼事件名，就等于在
// 「唯一的上游事实落点」之外多出一份上游知识，上游改名时必然漏改一处。
// 架构门禁（`tools/arch-check.mjs`）会拒绝在 dshcompat 之外出现这些字面量。

/** 会话出现 */
export const EVENT_SESSION_ADDED: string = 'api-session/added';
/** 会话移除 */
export const EVENT_SESSION_REMOVED: string = 'api-session/removed';
/** 会话运行状态变化 */
export const EVENT_SESSION_STATUS: string = 'api-session/status';
/** 会话活动时间推进 */
export const EVENT_SESSION_ACTIVITY: string = 'api-session/activity';
/** 会话异常 */
export const EVENT_SESSION_ERROR: string = 'api-session/error';

/** 设置文档变化 */
export const EVENT_SETTINGS_DOCUMENT_UPDATED: string = 'settings/document-updated';
/** 凭据引用变化 */
export const EVENT_CREDENTIALS_REFERENCE_UPDATED: string = 'credentials/reference-updated';
/** 模型适配器变化 */
export const EVENT_LLM_ADAPTERS_UPDATED: string = 'llm/adapters-updated';
/** 斜杠命令集变化 */
export const EVENT_COMMANDS_CHANGE: string = 'commands/change';
/** 目标激活状态变化 */
export const EVENT_GOAL_ACTIVATION_CHANGED: string = 'goal/activation-changed';

// ── 会话轨迹事件的**命名空间前缀** ──
//
// 事件类型由各插件通过 declaration merging 扩展，完整取值域只能实测得到；
// 但「family/name」这个结构约定是稳定的，可据此做保守归类（见 `SessionHub.projectWireRecord`）。

/** 轮次事件前缀（轮次状态变化会影响运行态与列表） */
export const EVENT_PREFIX_TURN: string = 'turn/';
/**
 * 轮次结束。
 *
 * 这是**唯一可靠的"这一轮跑完了"信号**（`running` 投影读不到，见 D2 §8.7.2 的
 * `session/follow` 快照形状：`header`/`cursor`/`records`/`hasMore`/`projections` 里没有 `running`）。
 * 失败与否在 `data.reason.kind`：实测失败轮次是
 * `turn/end {turn, reason:{kind:'error', error:{message}}}`。
 */
export const EVENT_TURN_END: string = 'turn/end';
/** 会话标题事件前缀（标题变化需要刷新列表） */
export const EVENT_PREFIX_SESSION_TITLE: string = 'session/title';

/** 该事件是否会影响会话列表（出现/消失/运行态/活动时间） */
export function isSessionListEvent(name: string): boolean {
  return name === EVENT_SESSION_ADDED || name === EVENT_SESSION_REMOVED
    || name === EVENT_SESSION_STATUS || name === EVENT_SESSION_ACTIVITY;
}

/** 该事件是否可能改变当前选中会话的标题 */
export function mayChangeSessionTitle(name: string): boolean {
  return name.indexOf(EVENT_PREFIX_SESSION_TITLE) === 0;
}

/** 该事件是否可能改变当前轮的运行态 */
export function mayChangeTurnState(name: string): boolean {
  return name.indexOf(EVENT_PREFIX_TURN) === 0;
}

// ── 轨迹事件归类（把任意上游事件名映射到「呈现家族」） ──
//
// 归类规则是**实测清单**（`SESSION_EVENT_FAMILY`，见 D2 §8.7.7 的 32 种类型），
// 不是命名空间前缀推断。返回的是中性字符串，`appstate` 再把它映射到自己的
// `TrajectoryKind` 枚举——这样 dshcompat 不反向依赖状态层。
//
// 【已删除的三个前缀常量】这里原有 `EVENT_PREFIX_USER` /
// `EVENT_PREFIX_ASSISTANT_MESSAGE` / `EVENT_PREFIX_ASSISTANT`，用来按前缀
// 区分「用户消息」与「助手思考」。它们与本文件已删除的前缀猜测表同源，
// 已被实测推翻（不存在 `reasoning/*`；思考内容在 `assistant/message` 的
// `stream` 里）。留着就是让 `assistant/attempt` 之类的事件被归错家族，
// 而且**不报错**——所以删除而不是保留。

/**
 * 审计类事件：有记录价值但**没有用户可读对话内容**。
 *
 * 实测已确认存在的事件类型（见 D2 §8.7.2 第 9 项）：
 * `permission/preset`、`sandbox/mode`、`approval/policy`。
 * 把它们放进对话流只会淹没真正的内容，因此投影时跳过。
 */
export const AUDIT_EVENT_TYPES: string[] = ['permission/preset', 'sandbox/mode', 'approval/policy'];

/** 呈现家族（中性名；由 appstate 映射到自己的枚举） */
export enum EventFamily {
  MESSAGE = 'message',
  REASONING = 'reasoning',
  TOOL = 'tool',
  SUBAGENT = 'subagent',
  GOAL = 'goal',
  JOB = 'job',
  DELIVERABLE = 'deliverable',
  ERROR = 'error'
}

/** 是否为无需进入对话流的审计事件 */
export function isAuditEventType(name: string): boolean {
  for (let i = 0; i < AUDIT_EVENT_TYPES.length; i++) {
    if (AUDIT_EVENT_TYPES[i] === name) {
      return true;
    }
  }
  return false;
}

/**
 * 会话事件类型 → 呈现家族的**显式表**。
 *
 * 【为什么从「前缀猜测」改成显式枚举】
 *   原实现按命名空间前缀归类（`assistant/` → 思考、`error` → 错误、`job` → 任务…），
 *   那些前缀是**猜的**。2026-09-10 通过逐帧解码 Host 落盘日志取得权威清单，
 *   2026-09-11 复核修订为 **32 种**（D2 §8.7.7：4876 帧 / 11013 条记录）后，
 *   四条假设被推翻：
 *     - **不存在 `reasoning/*` 事件族**：思考内容在 `assistant/message.data.stream[]`
 *       的 `reasoning-chunks` 记录里
 *     - **不存在 `error/*`**：错误来自转发事件 `api-session/error`、`llm/retry`，
 *       以及 `tool/result` 自带的 `error` 字段
 *     - **不存在 `job/*`**：作业只经 `session/control` 的 `jobs` 帧到达
 *     - `subagent` 前缀实际是 `subagent/catalog` 与 `subagent/descriptor` 两个事件
 *   照猜实现的话，思考会被当成普通消息、错误与作业永远不会显示——
 *   而且**不报错**。所以这里改为逐条枚举，未列出的类型显式走「未知」分支。
 *
 * 未列出的类型归为 `MESSAGE`（把原始 JSON 显示出来），而不是静默丢弃：
 * 宁可让用户看到「这里有一条不认识的事件」，也不要让对话少一截。
 * `SessionHub.noteUnknown()` 会把未识别类型汇总到诊断页，便于回填本表。
 */
const SESSION_EVENT_FAMILY: Record<string, EventFamily> = {
  // 消息
  'user/message': EventFamily.MESSAGE,
  'assistant/message': EventFamily.MESSAGE,
  'system/message': EventFamily.MESSAGE,
  // 工具
  'tool/call': EventFamily.TOOL,
  'tool/result': EventFamily.TOOL,
  // 子代理（两行都登记：descriptor 不是独立条目，但仍须「已被认识」）
  'subagent/catalog': EventFamily.SUBAGENT,
  'subagent/descriptor': EventFamily.SUBAGENT,
  // 目标
  'goal/change': EventFamily.GOAL,
  // 任务（上游的任务清单就是 todo）
  'todo/write': EventFamily.JOB,
  // 交付物（实测：工具把产物路径与说明放在这里）
  'deliverables/presented': EventFamily.DELIVERABLE,
  // 失败信号（上游没有独立的 error 事件族）
  'llm/retry': EventFamily.ERROR,
  'llm/retry-started': EventFamily.ERROR,
  // 上下文压缩
  'compaction/start': EventFamily.REASONING,
  'compaction/end': EventFamily.REASONING,
  'compaction/summary': EventFamily.REASONING,
  // 增量流式尝试：不是独立条目，但语义上属于推理过程
  'assistant/attempt': EventFamily.REASONING,
  // ── 以下均已实测确认，但不产生独立条目（只驱动状态或只作中间过程） ──
  // 【为什么也要登记】`classifyEventType` 对未登记类型返回 MESSAGE，
  // 而上层用「形状表里没有」来判定未识别事件。若已实测的类型只登记在形状表、
  // 不登记在这里，两表就不一致，且 `noteUnknown()` 与分类结果会给出不同的答案。
  // 登记为 MESSAGE 表示「这是普通内容类事件，但没有独立条目」。
  'turn/start': EventFamily.MESSAGE,
  'turn/end': EventFamily.MESSAGE,
  'step/start': EventFamily.MESSAGE,
  'step/end': EventFamily.MESSAGE,
  'session/title': EventFamily.MESSAGE,
  'session/title-llm-request': EventFamily.MESSAGE,
  'session/end-seed': EventFamily.MESSAGE,
  'request/context': EventFamily.MESSAGE,
  'request/header': EventFamily.MESSAGE,
  'command/run': EventFamily.MESSAGE,
  'command/done': EventFamily.MESSAGE,
  'agent/inbox/spliced': EventFamily.MESSAGE,
  'web/deepseek-search-llm-request': EventFamily.MESSAGE,
  // 审计类：有记录价值、无对话内容（`isAuditEventType` 另有判定）
  'permission/preset': EventFamily.MESSAGE,
  'sandbox/mode': EventFamily.MESSAGE,
  'approval/policy': EventFamily.MESSAGE
};

/**
 * 按**实测清单**把事件名归入呈现家族。
 *
 * 未列出的类型返回 `MESSAGE` 并由上层汇总到「未识别事件类型」（见文件头说明）。
 * **不要**用返回值去判断「这是不是未知事件」——那要问 `isKnownEventType()`。
 */
export function classifyEventType(name: string): EventFamily {
  const known: EventFamily | undefined = SESSION_EVENT_FAMILY[name];
  if (known !== undefined) {
    return known;
  }
  return EventFamily.MESSAGE;
}

/**
 * **对话里用户可见**的事件类型白名单（P0-1：提示词/内部事件泄漏）。
 *
 * 【要解决的问题】`groupTurns()` 之前把**任何** `MESSAGE + 助手` 的条目当作"助手的回答"，
 * 于是三类东西漏进了对话视图：
 *   · `command/run` —— 斜杠命令的执行事件（MESSAGE 族、standalone）被当成回答；
 *   · `compaction/summary` —— 上下文压缩摘要（"内部 context"）推进了过程分组；
 *   · **未识别事件** —— `classifyEventType` 对未知类型**有意降级**为 MESSAGE，
 *     而投影会把原始载荷 JSON 当正文，于是对话里出现一条"助手说：{"…"}"。
 *
 * 【为什么用白名单而不是黑名单】事件类型由各插件通过 declaration merging 扩展，
 * 完整取值域只能实测得到（见上文）。黑名单意味着"每出现一种新的内部事件就漏一次"，
 * 而白名单的失败方向是**保守**的：不认识的类型不进对话，但**仍进轨迹**（可查、可排查）。
 * 这与本仓"宁可少分类，也不要凭想象塞进某类"的一贯取舍一致。
 *
 * 【判定依据是结构，不是文案】只看事件类型名与家族，不读任何正文文本——
 * 因此"模型恰好在回答里写了 SYSTEM"这种情形不会被误判。
 *
 * 白名单 = 两条真正的会话消息 + 过程族（工具/子代理/目标/任务/交付物）+ 错误族。
 * 其中过程族与错误族仍会进对话，但**分别落在折叠的过程分组与错误提示里**（P1-2 的视觉层级）。
 * 注意 `system/message` 虽与 `user/message` 同族，但**不在**白名单里。
 */
export function isConversationVisibleEvent(name: string): boolean {
  if (name === 'user/message' || name === 'assistant/message') {
    return true;
  }
  const family: EventFamily = classifyEventType(name);
  return family === EventFamily.TOOL || family === EventFamily.SUBAGENT
    || family === EventFamily.GOAL || family === EventFamily.JOB
    || family === EventFamily.DELIVERABLE || family === EventFamily.ERROR;
}

/**
 * 已认识的事件类型名清单（由 `SESSION_EVENT_FAMILY` 的键派生）。
 *
 * 为什么要单独一个数组：ArkTS **禁止 `Object.prototype` 上的调用**
 * （`arkts-no-func-apply-call` / `arkts-no-prototype-assignment`），
 * 所以不能用 `Object.keys()`／`hasOwnProperty.call()` 在运行时查表键。
 * 把键集**在声明处**物化成数组，既绕开限制，也让「键集」本身可被测试断言。
 */
const KNOWN_EVENT_TYPES: string[] = [
  'user/message', 'assistant/message', 'system/message',
  'tool/call', 'tool/result',
  'subagent/catalog', 'subagent/descriptor',
  'goal/change', 'todo/write', 'deliverables/presented',
  'llm/retry', 'llm/retry-started',
  'compaction/start', 'compaction/end', 'compaction/summary',
  'assistant/attempt',
  'turn/start', 'turn/end', 'step/start', 'step/end',
  'session/title', 'session/title-llm-request', 'session/end-seed',
  'request/context', 'request/header',
  'command/run', 'command/done',
  'agent/inbox/spliced', 'web/deepseek-search-llm-request',
  'permission/preset', 'sandbox/mode', 'approval/policy'
];

/**
 * 该事件类型是否**已被实测认识**（与是否产生独立条目无关）。
 *
 * 【为什么必须与 `classifyEventType` 分开】
 *   `classifyEventType` 对未知类型**返回 MESSAGE**（有意的降级：把原始载荷显示出来，
 *   而不是丢事件）。于是「返回 MESSAGE」同时意味着两件完全不同的事：
 *     - 「这是内容类事件，但没有独立条目」（例：`request/header`）
 *     - 「这是从没见过的类型，升级后新出现的」
 *   若用返回值判断未知，第二种情况永远检测不到——**升级静默失效**。
 *   所以「是否认识」由本函数回答；`KNOWN_EVENT_TYPES` 与 `SESSION_EVENT_FAMILY`
 *   的键集也必须一致（测试里有断言钉住，见 `Trajectory.test.ets`）。
 */
export function isKnownEventType(name: string): boolean {
  return KNOWN_EVENT_TYPES.indexOf(name) >= 0;
}

/** 已认识的事件类型总数（供测试与诊断页断言） */
export const KNOWN_EVENT_TYPE_COUNT: number = KNOWN_EVENT_TYPES.length;

/**
 * 是否为**用户本人**发起的事件（决定轨迹条目的角色）。
 *
 * 用的是唯一一个仍然成立的前缀事实：用户消息的命名空间就是 `user/`
 * （实测 32 种类型里只有 `user/message` 落在该命名空间）。
 * 这不是「前缀猜测」——它是对一个**已实测确认**的事件名的判定。
 */
export function isUserAuthoredEvent(name: string): boolean {
  return name === 'user/message';
}

/**
 * 是否为**系统侧**写进会话记录的消息（E109）。
 *
 * 【为什么需要】`system/message` 与 `user/message` 同属 `EventFamily.MESSAGE`，
 * 而系统提示词（"You are an AI agent powered by DeepSeek Harness…"）就是这样落进会话日志的。
 * 真机上表现为：**对话视图里出现一条"助手"消息，内容却是系统提示词**——用户会以为模型
 * 在自言自语。官方 web 不把系统上下文放进对话；这里给出与 `isUserAuthoredEvent` 同源的判定，
 * 让上层把角色标成 `Speaker.SYSTEM`，从而在对话视图里隐去、只在轨迹视图里可查。
 */
export function isSystemAuthoredEvent(name: string): boolean {
  return name === 'system/message';
}

/** 转发事件流 `$events` 的下行帧判别值 */
export enum RemoteEventFrameType {
  /** 首帧：证明事件源就绪，并给出 clientId（后续应答必须带上它） */
  READY = 'ready',
  /** 单向通知 */
  EMIT = 'emit',
  /** 瀑布调用（审批/提问） */
  WATERFALL = 'waterfall',
  /** 取消一个尚在等待应答的瀑布调用（例如另一端已处理） */
  CANCEL = 'cancel'
}

/**
 * 审批结果的封闭词汇（`ApprovalOutcome`）。
 *
 * 注意：上游**没有** `allow-always` 这类持久授权。D3 §3.4 的「三选」里若包含
 * 「始终允许」，它只能是客户端侧的体验（例如记住本次会话内不再问），
 * 不能伪装成上游词汇发过去——发了 Host 也不认。这条取舍已回写 D3。
 */
export const APPROVAL_OUTCOMES: string[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable'];

/** 允许一次 */
export const APPROVAL_ALLOWED_ONCE: string = 'allowed-once';
/** 拒绝 */
export const APPROVAL_REJECTED: string = 'rejected';
/** 撤回（例如已由其他端处理） */
export const APPROVAL_CANCELLED: string = 'cancelled';
/** 无人可答（失败关闭） */
export const APPROVAL_UNAVAILABLE: string = 'unavailable';

/** 会话标题所在的**投影键** */
export const PROJECTION_TITLE: string = 'title';
/**
 * 权限组合所在的**投影键**（E124）。
 *
 * 实测样例（`Wire.ets` 的投影清单）：`"permissions":{"options":[…],"currentValue":"workspace-write"}`。
 * 注意它**不等于**"能切换"：可切换的预设由 `dsh-permission-presets` 提供，而那个插件在端侧
 * 因依赖 shell 服务无法启用（E116）。所以这个键的用途是**如实显示宿主当前的访问模式**，
 * 而不是假装我们能在三档之间切。
 */
export const PROJECTION_PERMISSIONS: string = 'permissions';
/**
 * 会话统计所在的**投影键**（E125）。
 *
 * 实测形状（`Wire.ets` 的投影样例 + 真机读数）：
 *   `sessionStats: {turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens}`
 * 官方 web 用它显示「{turns} 轮 {steps} 步」「模型用时」「工具调用用时」「首 token 平均（TTFT）」
 * 「输出速度（TPS）」——我们此前同样只读了 `title`，于是这些数字在界面上完全缺席。
 */
export const PROJECTION_SESSION_STATS: string = 'sessionStats';
/** Token 用量所在的**投影键**（E125）：`{uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}` */
export const PROJECTION_TOKEN_USAGE: string = 'tokenUsage';
/**
 * 会话 Agent 预设所在的**投影键**（E129）。
 *
 * 真机读数里它一直是 `"agentPreset":"ondevice"`（我们 profile 的 `agent-presets.default`）。
 * 官方把这个值显示在**会话标题**上（`dsh-client-ui-agent-preset`：「在会话标题中查看当前 preset」），
 * 我们此前同样没读它。
 */
export const PROJECTION_AGENT_PRESET: string = 'agentPreset';
/** 会话待发队列所在的投影键（`dsh-session` 的 inbox 投影） */
export const PROJECTION_INBOX: string = 'inbox';

/** 查一条事件是否在转发白名单内 */
export function isForwardedEvent(name: string): boolean {
  for (let i = 0; i < FORWARDED_EVENTS.length; i++) {
    if (FORWARDED_EVENTS[i].event === name) {
      return true;
    }
  }
  return false;
}

/** 取一条事件的转发模式（不在白名单时返回 undefined） */
export function forwardedModeOf(name: string): ForwardedEventMode | undefined {
  for (let i = 0; i < FORWARDED_EVENTS.length; i++) {
    if (FORWARDED_EVENTS[i].event === name) {
      return FORWARDED_EVENTS[i].mode;
    }
  }
  return undefined;
}

/** 该事件是否需要客户端应答（waterfall） */
export function isWaterfallEvent(name: string): boolean {
  return forwardedModeOf(name) === ForwardedEventMode.WATERFALL;
}

/**
 * 从投影值里读会话标题。
 *
 * 【为什么需要这个函数】上游 `SessionSummary` **没有顶层 title 字段**：
 * 标题在 `summary.projections.values.title`，类型是 `string | null`。
 * 按顶层字段读会永远读不到——这正是本项目在 0.1.2 基线上的一处投影缺陷，
 * 已在整合 0.1.5-rc.1 时修正（D2 §8.7）。
 *
 * @param values 投影值表（可能为 undefined：老 Host 或冷会话不带投影）
 * @returns 标题；无标题时返回 undefined（调用方决定兜底文案）
 */
export function titleFromProjections(values: Record<string, Object> | undefined): string | undefined {
  if (values === undefined) {
    return undefined;
  }
  const raw: Object | undefined = values[PROJECTION_TITLE];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === 'string') {
    const text: string = raw as string;
    return text.length === 0 ? undefined : text;
  }
  return undefined;
}
