/**
 * 真实连接的**接线契约**：请求构造器 + 回复投影（UI 意图 ↔ Host）。
 *
 * 事实基线（**逐条实测自上游声明文件**，不是推测）：
 *   来源：`@deepseek-ai/dsh-api-session-controller` 0.1.5-rc.1 的 `lib/types/types.d.ts`，
 *        外加 `@deepseek-ai/dsh-api-gateway` 的 `lib/types/stream-protocol.d.ts`
 *        与 `@deepseek-ai/dsh-user-approval` / `@deepseek-ai/dsh-user-questions` 的 `types.d.ts`。
 *   采集路径：`.research/upstream-0.1.5/node_modules/@deepseek-ai/`。
 *
 * 分层纪律：
 *   - **端点名**一律来自 `dshcompat`（唯一允许持有上游端点字面量的模块），本文件不写任何端点字面量；
 *   - **取值工具**来自 `connection`（`isRecord` / `getString` 等），因为所有输入都是外部 JSON；
 *   - 本文件不含 UI 依赖，可单测。
 *
 * ───────────────────────── 最重要的一条更正 ─────────────────────────
 * **会话标题不在顶层字段上。**
 *   `SessionSummary` 的实测字段是
 *   `{sessionId, updatedAt, running, blank, parentSessionId?, origin?, cwd?, projections?}`——
 *   **没有** `title`。标题在 `summary.projections.values.title`，由会话标题投影提供，
 *   且其类型是 **`string | null`**（`null` = 还没有标题落地，不是空串）。
 *   因此绝不能用 `getString(summary, 'title')` 去取标题：那永远得到空串，
 *   而「空串」与「用户真的没起标题」在 UI 上表现不同，会被误判成「标题为空」而掩盖问题。
 *   本文件用 `titleOfSummary()` 读投影并给出**诚实**的兜底（cwd 末段），
 *   同时用 `TitleResolution.source` 告诉 UI「这是真标题还是占位」。
 * ─────────────────────────────────────────────────────────────────────
 */

import { SessionJob } from './Jobs';

import {
  argsFor,
  COMMANDS_LIST_ENDPOINT,
  COMMANDS_EXECUTE_ENDPOINT,
  SESSION_SELECT_MODEL_ENDPOINT,
  FILE_REFERENCES_LIST_ENDPOINT,
  FILE_UPLOAD_ENDPOINT,
  SESSION_CANCEL_ENDPOINT,
  SESSION_CREATE_ENDPOINT,
  SESSION_FOLLOW_ENDPOINT,
  SESSION_LIST_ENDPOINT,
  SESSION_PAGE_ENDPOINT,
  SESSION_PROMPT_ENDPOINT,
  SESSION_REFERENCE_CANDIDATES_ENDPOINT,
  SESSION_RENAME_ENDPOINT,
  SESSION_UPDATE_QUEUE_ENDPOINT,
  WORKSPACE_FILES_LIST_ENDPOINT,
  WORKSPACE_FILES_READ_ALL_ENDPOINT,
  WORKSPACE_FILES_READ_ENDPOINT
} from 'dshcompat';
import {
  EVENTS_RESULT_ENDPOINT,
  getArray,
  getField,
  getNumber,
  getRecord,
  getString,
  isRecord
} from 'connection';
import { SessionListItem } from './SessionList';
import { HostRecord } from './Settings';
import { FileNode, FilePreview, languageOf, NodeKind, PreviewKind, previewKindOf, WorkspaceItem } from './Workspace';

/** JSON 安全值的读法：一律经 `connection` 的取值工具收窄，不做无检查下标访问。 */
type JsonBag = Record<string, Object>;

/** 标题占位文案（Host 没有标题且无从兜底时使用）。 */
export const UNTITLED_SESSION: string = '未命名会话';

// ═════════════════════════ 1. session/list ═════════════════════════

/**
 * `session/list` 的业务参数体。
 *
 * 实测：该端点参数形态是 `ArgsShape.UNDERSCORE_REQUEST`，
 * 即上线时会被 `dshcompat.buildArgs()` 包成 `{_request: {...}}`。
 * **因此这里不自己加 `_request` 外壳**：外壳由生成上表决定，
 * 手写外壳会在上游改形态时变成双重包装（`{_request:{_request:…}}`）。
 */
export interface SessionListRequest {
  /** 翻页游标；不传表示第一页 */
  cursor?: string;
}

/**
 * 构造 `session/list` 的 args 载荷（含形态外壳）。
 *
 * 返回 `Object | undefined`：undefined 表示该 endpoint 不在兼容上表里
 * （Host 版本过旧或上表未收录），调用方据此走能力探测降级，而不是盲目发包。
 *
 * 命名说明：`SessionList.ets` 已有一份 `sessionListPayload(body: Object)`（容忍字段改名的宽松版）。
 * 本函数是**线形精确版**且入参是游标而不是整包 body，两者签名不同，
 * 因此改名成 `sessionListWirePayload` 以避免 `Index.ets` 出口重名
 * （重复导出会让整个模块编译失败，而不是只报一个警告）。
 */
export function sessionListWirePayload(cursor: string): Object | undefined {
  const body: SessionListRequest = {};
  if (cursor.length > 0) {
    body.cursor = cursor;
  }
  return argsFor(SESSION_LIST_ENDPOINT, body);
}

/** `session/list` 的端点（供连接层发起调用，避免 UI 层写字面量）。 */
export function sessionListEndpoint(): string {
  return SESSION_LIST_ENDPOINT;
}

/** `session/list` 的回复值：`{items: SessionSummary[]}`。 */
export interface SessionListValue {
  items: SessionSummaryWire[];
}

/**
 * 会话列表项的**实测线形**。
 *
 * 字段名与上游声明文件逐字对应；`projections` 是「投影快照」，
 * 标题等被折叠出来的值都在里面（见文件头「最重要的一条更正」）。
 *
 * ── 权威样本（0.1.5-rc.1 真实 Host 实测，逐字保留） ──
 * ```json
 * {"sessionId":"session-07917d40-…","updatedAt":1789051283087,"running":false,"blank":true,
 *  "cwd":"D:\\dev\\deepseek-harness-desktop-HarmonyOS",
 *  "projections":{"asOfSeq":2,"values":{
 *    "title":null,"goal":null,"tokenUsage":{},"contextPressure":{},
 *    "contextBreakdown":{},"sessionStats":{},"turnOutline":[],
 *    "agentPreset":"standard","subagentCatalog":[],"subagentTiming":{},"subagent":null,
 *    "permissions":{"options":[…],"currentValue":"workspace-write"},
 *    "modelSelection":{"lastUsed":null,"next":null},
 *    "sessionListMetadata":{"blank":true,"lastPromptAt":null},
 *    "imageLimits":{"maxImageBytes":20971520,…},
 *    "inbox":{"next-turn":[],"next-step":[]},"todos":null,
 *    "plan":{"active":false,"pending":false}}}}
 * ```
 * 两条可直接依赖的事实：
 *   1. **顶层没有 `title`**（本文件因此把标题读法集中在 `resolveSessionTitle()`）；
 *   2. `projections.values` 实测有 **18 个键**（见下清单），
 *      因此**投影键是开放集合**，不能用「键不存在 ⇒ 值就是空」的假设去读业务字段。
 */
export interface SessionSummaryWire {
  sessionId: string;
  /** 最近活动时间（毫秒时间戳） */
  updatedAt: number;
  running: boolean;
  /** 折叠后的前缀里是否**没有任何轮次**（空会话）；用于列表区分「刚建好还没说话」 */
  blank: boolean;
  /** 父会话 id（仅子代理会话有） */
  parentSessionId?: string;
  /** 来源；实测唯一取值是 `'subagent'` */
  origin?: string;
  /** 工作目录 */
  cwd?: string;
  /** 投影提示：`asOfSeq` 是快照对应的会话事件游标 */
  projections?: ProjectionHints;
}

/** 投影快照：`values` 的每个值都是 JSON 安全值（上游类型 `JsonValue`）。 */
export interface ProjectionHints {
  asOfSeq: number;
  values: JsonBag;
}

/**
 * 投影里承载标题的键。
 *
 * **上游字段名，本文件唯一刻意保留的一处字面量**，理由：
 *   它是**投影键**（由 `dsh-session-title` 注册的 `title` 投影提供），
 *   既不是一个 endpoint，也不在上表（上表只收 endpoint，不收投影键）里，
 *   因此无处可 import。它必须与 endpoint 名一样集中且可被漂移检查发现——
 *   见本文件末尾「上游字段名缺口」一节，已列为待补清单。
 *
 * 实测类型是 `string | null`：`null` = 还没有标题落地（不是空串）。
 */
const TITLE_PROJECTION_KEY: string = 'title';

/**
 * 实测的 `projections.values` 键清单（0.1.5-rc.1，共 18 个，逐字精确）。
 *
 * 存在理由：
 *   这份清单是**可执行的事实记录**。它有两个用途——
 *   1. 评审时可比对「上游新增/删除了哪个投影」；
 *   2. 提醒后续实现者：`values` 是开放集合，读任何键都必须容忍缺失，
 *      绝不能因为「样本里见过 title 就以为 title 一定有值」。
 * 不导出（本层没有消费方）：它只作为本文件的校验性文档。
 */
const KNOWN_PROJECTION_KEYS: string[] = [
  'title', 'goal', 'tokenUsage', 'contextPressure', 'contextBreakdown', 'sessionStats',
  'turnOutline', 'agentPreset', 'subagentCatalog', 'subagentTiming', 'subagent', 'permissions',
  'modelSelection', 'sessionListMetadata', 'imageLimits', 'inbox', 'todos', 'plan'
];

/** 标题来源：区分「Host 真的给了标题」与「我们兜底出来的占位」。 */
export enum TitleSource {
  /** Host 投影里的真标题 */
  HOST = 'host',
  /** Host 没有标题，用 cwd 末段兜底 */
  CWD_FALLBACK = 'cwd-fallback',
  /** 完全无从得知 */
  NONE = 'none'
}

/**
 * 标题解析结果。
 *
 * 为什么要带 `source` 而不只返回字符串：
 *   D3 §4 文案纪律要求「不把技术噪声伪装成用户内容」。
 *   把 cwd 末段当成会话标题显示是可以接受的兜底，但 UI 必须能选择**弱化**显示
 *   （否则用户会以为会话真的叫 `my-repo`）。只返回字符串就永久丢失了这个信息。
 */
export interface TitleResolution {
  title: string;
  source: TitleSource;
}

/**
 * 读取会话标题（**唯一正确姿势**）。
 *
 * 顺序：`projections.values.title`（string | null）
 *   → `cwd` 末段（末段为空则退回完整 cwd）
 *   → `UNTITLED_SESSION`。
 */
export function resolveSessionTitle(summary: SessionSummaryWire): TitleResolution {
  const direct: string | null = projectionTitle(summary);
  if (direct !== null && direct.length > 0) {
    return { title: direct, source: TitleSource.HOST };
  }
  const cwd: string = summary.cwd !== undefined ? summary.cwd : '';
  const base: string = cwdBasename(cwd);
  if (base.length > 0) {
    return { title: base, source: TitleSource.CWD_FALLBACK };
  }
  return { title: UNTITLED_SESSION, source: TitleSource.NONE };
}

/** 便捷形式：只要标题字符串（丢失来源信息，列表排序/搜索等场景够用）。 */
export function titleOfSummary(summary: SessionSummaryWire): string {
  return resolveSessionTitle(summary).title;
}

/**
 * 读投影标题，**严格区分 null 与「键不存在」**。
 *
 * 上游类型是 `string | null`：`null` 有明确语义（还没有标题落地）；
 * 键不存在则说明**这个 Host 根本没挂标题投影**（能力缺失）。
 * 两者对 UI 的含义不同（前者等标题生成，后者永远不会有标题），
 * 因此这里都返回 `null` 但由 `TitleSource` 兜底体现差异——不额外再分一档，
 * 是因为当前 UI 对两者的处理相同（都走 cwd 兜底）。
 */
function projectionTitle(summary: SessionSummaryWire): string | null {
  const hints: ProjectionHints | undefined = summary.projections;
  if (hints === undefined) {
    return null;
  }
  const value: string | undefined = getString(hints.values, TITLE_PROJECTION_KEY);
  return value !== undefined ? value : null;
}

/**
 * 该投影键是否在实测清单内。
 *
 * 用途：诊断页与漂移检查。返回 `false` **不代表数据有问题**——
 * 它只说明「这个键不在我们采集样本时见过的 18 个里」，
 * 可能是上游新增了投影（正是我们想尽早知道的事）。
 * 因此消费方应把它当**提示**而不是校验失败。
 */
export function isKnownProjectionKey(key: string): boolean {
  for (let i = 0; i < KNOWN_PROJECTION_KEYS.length; i++) {
    if (KNOWN_PROJECTION_KEYS[i] === key) {
      return true;
    }
  }
  return false;
}

/**
 * 取路径末段（Windows `\` 与 POSIX `/` 都支持）。
 *
 * 为什么不直接用 `split('/')`：Host 可能跑在 Windows 上（本产品的主力平台之一），
 * cwd 会是 `D:\dev\repo`，只按 `/` 切会得到整条路径。
 */
export function cwdBasename(cwd: string): string {
  let end: number = cwd.length;
  while (end > 0 && isSeparator(cwd.charAt(end - 1))) {
    end--;
  }
  let start: number = end;
  while (start > 0 && !isSeparator(cwd.charAt(start - 1))) {
    start--;
  }
  return cwd.substring(start, end);
}

function isSeparator(ch: string): boolean {
  return ch === '/' || ch === '\\';
}

/**
 * 从 `session/list` 回复里投影出列表。
 *
 * 与 `appstate/model/SessionList.ets` 的宽松投影（多字段别名容忍）不同，
 * 本函数按**实测线形**取值：它服务于已确认 0.1.5-rc.1 的连接。
 * 容忍改名的旧投影仍保留在 SessionList.ets，两者并存不冲突。
 */
export function projectSessionListWire(value: Object | undefined): SessionSummaryWire[] {
  const out: SessionSummaryWire[] = [];
  if (value === undefined) {
    return out;
  }
  const items: Object[] | undefined = getArray(value, 'items');
  if (items === undefined) {
    return out;
  }
  for (let i = 0; i < items.length; i++) {
    const item: Object = items[i];
    if (!isRecord(item)) {
      continue;
    }
    const id: string | undefined = getString(item, 'sessionId');
    if (id === undefined || id.length === 0) {
      // 无 id 的条目无法用于任何后续调用，跳过而不是产出脏数据。
      continue;
    }
    out.push({
      sessionId: id,
      updatedAt: readNumber(item, 'updatedAt'),
      running: readBoolean(item, 'running'),
      blank: readBoolean(item, 'blank'),
      parentSessionId: optionalString(item, 'parentSessionId'),
      origin: optionalString(item, 'origin'),
      cwd: optionalString(item, 'cwd'),
      projections: readProjections(item)
    });
  }
  return out;
}

function readProjections(source: Object | null | undefined): ProjectionHints | undefined {
  const raw: Object | undefined = getRecord(source, 'projections');
  if (raw === undefined) {
    return undefined;
  }
  return {
    asOfSeq: readNumber(raw, 'asOfSeq'),
    values: bagOf(raw, 'values')
  };
}

// ═════════════════════════ 2. session/create ═════════════════════════

/** `session/create` 业务参数体（全部可选：三者都不传即「用默认工作区建一个新会话」）。 */
export interface SessionCreateRequest {
  workspaceId?: string;
  cwd?: string;
  /** 显式指定 id（用于「认领」一个已知 id）；不传由 Host 生成 */
  sessionId?: string;
  agentPreset?: string;
}

/** `session/create` 的 args 载荷（形态外壳由上表决定）。 */
export function sessionCreatePayload(workspaceId: string, cwd: string, sessionId: string,
  agentPreset: string): Object | undefined {
  const body: SessionCreateRequest = {};
  if (workspaceId.length > 0) {
    body.workspaceId = workspaceId;
  }
  if (cwd.length > 0) {
    body.cwd = cwd;
  }
  if (sessionId.length > 0) {
    body.sessionId = sessionId;
  }
  if (agentPreset.length > 0) {
    body.agentPreset = agentPreset;
  }
  return argsFor(SESSION_CREATE_ENDPOINT, body);
}

/** `session/create` 回复值。 */
export interface SessionCreateValue {
  sessionId: string;
  /** Host 实际生效的 agent 预设（未指定时可能回填默认值） */
  agentPreset?: string;
}

/** 投影 `session/create` 回复。 */
export function projectSessionCreate(value: Object | undefined): SessionCreateValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  const id: string | undefined = getString(value, 'sessionId');
  if (id === undefined || id.length === 0) {
    return undefined;
  }
  return { sessionId: id, agentPreset: optionalString(value, 'agentPreset') };
}

// ═════════════════════════ 3. session/prompt ═════════════════════════

/** 提示词入队模式：排队，或打断当前轮次改为插话。 */
export enum PromptMode {
  QUEUE = 'queue',
  STEER = 'steer'
}

/**
 * 提示词内容片段（**三选一**，与上游 `PromptContentPart` 逐字对应）。
 *
 * 取舍：上游是三路联合类型（`{type:'text'} | {type:'image'} | {type:'file'}`）。
 * 本文件按仓内既有约定把联合字段收到一个接口里（可选字段），
 * 原因是对象字面量与联合类型在 ArkTS 里容易触发「字面量必须匹配已声明类型」的报错，
 * 而本结构要由 UI 直接构造。判别依据仍是必需的 `type` 字段。
 */
export interface PromptContentPart {
  /** 判别字段：`'text'` / `'image'` / `'file'` */
  type: string;
  /** 文本正文（仅 `type='text'`） */
  text?: string;
  /** 图片 MIME 类型（仅 `type='image'`） */
  mediaType?: string;
  /** 图片 base64 数据（仅 `type='image'`） */
  data?: string;
  /** 原始文件名（仅 `type='image'`，可选） */
  name?: string;
  /**
   * 上传回执 id（仅 `type='file'`）。
   * 来自**同一会话**上先行的 `fileUploads/upload` 调用返回的不透明回执；
   * 跨会话复用该 id 会被 Host 拒绝（它绑定了会话身份）。
   */
  receiptId?: string;
}

/** 构造文本片段。 */
export function textPart(text: string): PromptContentPart {
  return { type: 'text', text: text };
}

/** 构造图片片段（`data` 是 base64，不含 `data:` 前缀）。 */
export function imagePart(mediaType: string, data: string, name: string): PromptContentPart {
  const part: PromptContentPart = { type: 'image', mediaType: mediaType, data: data };
  if (name.length > 0) {
    part.name = name;
  }
  return part;
}

/** 构造文件片段（`receiptId` 必须来自同一会话的先行上传）。 */
export function filePart(receiptId: string): PromptContentPart {
  return { type: 'file', receiptId: receiptId };
}

/** `session/prompt` 业务参数体。 */
export interface SessionPromptRequest {
  /** 客户端铸造的请求 id：用于把乐观消息与落库消息对上 */
  requestId: string;
  sessionId: string;
  mode: string;
  content: PromptContentPart[];
  /** 客户端时区（可选；Host 需要它来做时间上下文） */
  clientTimeZone?: string;
}

/**
 * 构造 `session/prompt` 的 args 载荷。
 *
 * `requestId` 由**调用方**铸造并传入（而不是本函数内部生成）：
 * 它是纯函数的一部分输入才能让本模块保持可单测，
 * 同时调用方需要在同一处用这个 id 建立「乐观消息 → 落库消息」的映射。
 * 客户端的 uuid 生成器在 `connection`（`randomUuid`），装配层取用即可。
 */
export function promptPayload(requestId: string, sessionId: string, mode: PromptMode,
  content: PromptContentPart[], clientTimeZone: string): Object | undefined {
  const body: SessionPromptRequest = {
    requestId: requestId,
    sessionId: sessionId,
    mode: mode === PromptMode.STEER ? 'steer' : 'queue',
    content: content
  };
  if (clientTimeZone.length > 0) {
    body.clientTimeZone = clientTimeZone;
  }
  return argsFor(SESSION_PROMPT_ENDPOINT, body);
}

/** `session/prompt` 回复值：上游是字面量 `true`（不是对象），表示「已进 Agent 收件箱」。 */
export interface SessionPromptValue {
  accepted: boolean;
}

/** 投影 `session/prompt` 回复（容错：字段缺失视为未接收，绝不乐观当成成功）。 */
export function projectSessionPrompt(value: Object | undefined): SessionPromptValue {
  if (value === undefined) {
    return { accepted: false };
  }
  return { accepted: readBoolean(value, 'accepted') };
}

// ═════════════════════════ 4. 会话变更类端点（endpoint 由调用方给出） ═════════════════════════

/**
 * ⚠ **上游端点名缺口（必须补在 dshcompat，本文件刻意不写）** ⚠
 *
 * 下列两个端点在 `dshcompat` 的上表（`DSH_ENDPOINTS`）里**有记录**，
 * 但 `Aliases.ets` 尚未为它们导出便捷常量：
 *   `session/fork`、`session/updateQueue`
 *
 * 按分层纪律，「上游端点名」只允许出现在 `dshcompat`；
 * 本文件是 `appstate` 的文件，**不得**在此写字面量，也不得在别处新造一个常量模块
 * （那会把上游知识复制出第二份，漂移检查就管不到了）。
 * 因此在常量补齐前，下面两个构造器把 endpoint 作为**参数**接收：
 *   调用方从 `dshcompat` 取得（`argsFor`/上表里可查），本文件保持零端点字面量。
 * 补齐方式：在 `Aliases.ets` 增加 `SESSION_FORK_ENDPOINT` 与
 * `SESSION_UPDATE_QUEUE_ENDPOINT` 两个常量并加入 `Index.ets` 的导出清单即可；
 * 届时把这两个构造器的入参收敛掉，本文件的其余部分不需要改动。
 *
 * （`session/cancel` 与 `session/rename` 原先也在此清单里，
 *   现已在 `dshcompat` 补上常量，故本文件已改为直接使用常量。）
 */

/**
 * 校验并包装一个「由调用方提供的」端点参数体。
 *
 * 用 `argsFor()` 而不是自己拼 `{request: body}`：形态外壳（REQUEST / UNDERSCORE_REQUEST /
 * NAMED）是生成上表的事实，手写会让上游改形态时静默发错包。
 * endpoint 不在上表 ⇒ `argsFor()` 返回 undefined ⇒ 调用方走能力降级。
 *
 * 约定：`endpoint` 必须来自 `dshcompat`（本文件是 appstate 层，不接受端点字面量）。
 * 目前仅 `session/fork` 与 `session/updateQueue` 仍需调用方传入——
 * 见下方「⚠ 上游端点名缺口」。
 */
function payloadFor(endpoint: string, body: Object): Object | undefined {
  if (endpoint.length === 0) {
    return undefined;
  }
  return argsFor(endpoint, body);
}

/** `session/cancel` 业务参数体。 */
export interface SessionCancelRequest {
  sessionId: string;
}

/** `session/cancel` 回复值（`{accepted: true}`）。 */
export interface SessionCancelValue {
  accepted: boolean;
}

/** 构造 `session/cancel` 的 args 载荷（端点取自 `dshcompat`）。 */
export function sessionCancelPayload(sessionId: string): Object | undefined {
  const body: SessionCancelRequest = { sessionId: sessionId };
  return payloadFor(SESSION_CANCEL_ENDPOINT, body);
}

/** `session/rename` 业务参数体。 */
export interface SessionRenameRequest {
  sessionId: string;
  title: string;
}

/** `session/rename` 回复值：规范化后的标题 + 提交它的持久事件序号。 */
export interface SessionRenameValue {
  title: string;
  seq: number;
}

/** 构造 `session/rename` 的 args 载荷（端点取自 `dshcompat`）。 */
export function sessionRenamePayload(sessionId: string, title: string): Object | undefined {
  const body: SessionRenameRequest = { sessionId: sessionId, title: title };
  return payloadFor(SESSION_RENAME_ENDPOINT, body);
}

/**
 * 投影 `session/rename` 回复。
 *
 * 注意：Host 会**规范化**标题（去控制字符、按 UTF-8 字节预算截断），
 * 因此返回的 `title` 可能与我们提交的不同——UI 必须用回复里的值回写输入框，
 * 否则界面显示的标题与落库标题会不一致。
 */
export function projectSessionRename(value: Object | undefined): SessionRenameValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  const title: string | undefined = getString(value, 'title');
  if (title === undefined) {
    return undefined;
  }
  return { title: title, seq: readNumber(value, 'seq') };
}

/** `session/fork` 业务参数体。 */
export interface SessionForkRequest {
  sessionId: string;
  /** 分叉点（含）；不传 = 从当前位置分叉 */
  atSeq?: number;
}

/** `session/fork` 回复值。 */
export interface SessionForkValue {
  sessionId: string;
}

/** 构造 `session/fork` 的 args 载荷（endpoint 由调用方从 dshcompat 提供）。 */
export function sessionForkPayload(endpoint: string, sessionId: string,
  atSeq: number): Object | undefined {
  const body: SessionForkRequest = { sessionId: sessionId };
  if (atSeq >= 0) {
    body.atSeq = atSeq;
  }
  return payloadFor(endpoint, body);
}

/** 投影 `session/fork` 回复。 */
export function projectSessionFork(value: Object | undefined): SessionForkValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  const id: string | undefined = getString(value, 'sessionId');
  if (id === undefined || id.length === 0) {
    return undefined;
  }
  return { sessionId: id };
}

/**
 * 队列项动作（三选一）：改内容 / 移除 / 转插话。
 *
 * 上游是联合类型；按仓内约定收成一个接口 + `kind` 判别字段。
 */
export interface QueueActionBody {
  /** `'edit'` / `'remove'` / `'steer'` */
  kind: string;
  /**
   * 替换内容（仅 `kind='edit'`）。
   *
   * 上游声明为 `readonly ContentBlock[]`，并注明「**非空的纯文本**替换内容」。
   * 已确认 `ContentBlock` = `ContentBlockMap[ContentBlockType]` 的联合，其中
   * `TextBlock = {type:'text', text:string}`（`@deepseek-ai/dsh-llm/lib/types/types.d.ts`）。
   * 上游把编辑限制为纯文本，因此本文件**只**允许 `QueueTextBlock`：
   * 用「任意 ContentBlock」放开等于允许 UI 传图片块/工具块，而那些会被 Host 拒绝。
   */
  content?: QueueTextBlock[];
}

/** 队列编辑用的文本块（`ContentBlock` 里唯一被「编辑」动作接受的分支）。 */
export interface QueueTextBlock {
  type: string;
  text: string;
}

/**
 * `session/updateQueue` 业务参数体。
 *
 * `itemId` 的上游类型是 `MessageId`。**已确认线形就是字符串**：
 * `MessageId = Branded<'MessageId'>`，而
 * `Branded<B> = string & {readonly [BRAND]: B}`（`@deepseek-ai/dsh-brand`）——
 * 品牌是**编译期独有**的标记（源码注释原话：brand is compile-time-only），
 * 运行时与原字符串完全同构（`string & {...}` 在 TS 里退化为 `string`）。
 * 因此本文件用 `string` 承载，不引入品牌类型。
 */
export interface SessionUpdateQueueRequest {
  sessionId: string;
  itemId: string;
  action: QueueActionBody;
}

/**
 * 构造队列「编辑」动作。
 *
 * 入参是**文本数组**而不是块数组：上游要求 `content` 非空且为纯文本，
 * 让调用方自己拼 `{type:'text'}` 只会给「拼错/传图片块」留机会。
 * 返回的 `content` 在 `texts` 为空时为空数组——Host 会拒绝，调用方须保证非空。
 */
export function queueEditAction(texts: string[]): QueueActionBody {
  const blocks: QueueTextBlock[] = [];
  for (let i = 0; i < texts.length; i++) {
    blocks.push({ type: 'text', text: texts[i] });
  }
  return { kind: 'edit', content: blocks };
}

/** 构造队列「移除」动作。 */
export function queueRemoveAction(): QueueActionBody {
  return { kind: 'remove' };
}

/** 构造队列「转插话」动作（把已排队项提前为打断当前轮次）。 */
export function queueSteerAction(): QueueActionBody {
  return { kind: 'steer' };
}

/** 构造 `session/updateQueue` 的 args 载荷。 */
export function sessionUpdateQueuePayload(sessionId: string, itemId: string,
  action: QueueActionBody): Object | undefined {
  const body: SessionUpdateQueueRequest = { sessionId: sessionId, itemId: itemId, action: action };
  return payloadFor(SESSION_UPDATE_QUEUE_ENDPOINT, body);
}

// ═════════════════════════ 6c. 一元读回历史（session/page） ═════════════════════════

/**
 * `session/page` 的业务参数体。
 *
 * 【实测语义（D2 §8.7.23，与文档注释相反的那一条）】
 *   - `throughSeq` 是**包含式**上界：`0 → 1 条`、`1 → 2 条`、`5 → 6 条`（含 seq 0）；
 *   - 超过游标会被**明确拒绝**：`throughSeq: 19` → `gateway/bad-request:
 *     session page through seq 19 is past cursor 18`；
 *   - **`-1` 不是"到当前末尾"**：实测返回 `{ok:true, records:[]}`。
 *     因此要读整段历史，必须拿到真实游标 ⇒ 用 `sessionCursorOf()` 从
 *     `session/list` 的 `projections.asOfSeq` 取（实测它就是那个上界：18 → 19 条）。
 */
export interface SessionPageRequest {
  address: SessionAddressWire;
  /** 包含式日志切点；**必须是真实游标**，`-1` 读不到东西 */
  throughSeq: number;
  /** 向前分页游标（可选） */
  beforeSeq?: number;
  /** 单页最大条数（可选，默认 50） */
  maxMessages?: number;
}

/** 会话地址（`session/follow` 与 `session/page` 共用同一形状）。 */
export interface SessionAddressWire {
  kind: string;
  sessionId: string;
}

/**
 * 构造 `session/page` 的 args 载荷。
 *
 * @param throughSeq 包含式上界；传 `sessionCursorOf()` 的结果即为"读到当前末尾"
 */
export function sessionPagePayload(sessionId: string, throughSeq: number,
  maxMessages: number): Object | undefined {
  const address: SessionAddressWire = { kind: 'session', sessionId: sessionId };
  const request: SessionPageRequest = { address: address, throughSeq: throughSeq };
  if (maxMessages > 0) {
    request.maxMessages = maxMessages;
  }
  return payloadFor(SESSION_PAGE_ENDPOINT, request);
}

/** `session/page` 的端点。 */
export function sessionPageEndpoint(): string {
  return SESSION_PAGE_ENDPOINT;
}

/**
 * 从 `session/list` 的会话摘要里取**日志游标**（`projections.asOfSeq`）。
 *
 * 返回 `-1` 表示取不到（老 Host 没有这个投影 / 形状变了）。调用方据此**放弃**一元读回，
 * 而不是拿 `-1` 去请求——那只会得到一页空记录，把"读不到"伪装成"这个会话是空的"。
 */
export function sessionCursorOf(summary: Object | undefined): number {
  const projections: Object | undefined = getRecord(summary, 'projections');
  if (projections === undefined) {
    return -1;
  }
  const asOf: number | undefined = getNumber(projections, 'asOfSeq');
  if (asOf === undefined || asOf < 0) {
    return -1;
  }
  return asOf;
}

/** `session/page` 的回复值：`{records, hasMore}`；`records` 与 `session/follow` 的**同形**。 */
export interface SessionPageValue {
  records: Object[];
  hasMore: boolean;
}

/**
 * 投影 `session/page` 的回复。
 *
 * **`records` 与 `session/follow` 快照里的 `records` 是同一形状**（都是
 * `{type:'event', event:{type,seq,time,data}}`）——这是本项目能把同一条投影函数
 * （`projectWireRecord`）用在两条通路上的原因，也是这条兜底通路实现成本低的原因。
 */
export function projectSessionPage(value: Object | undefined): SessionPageValue {
  const records: Object[] | undefined = value === undefined ? undefined : getArray(value, 'records');
  return {
    records: records === undefined ? emptyObjectList() : records,
    hasMore: value !== undefined && getField(value, 'hasMore') === true
  };
}

/** 空的对象数组（规避无类型数组字面量）。 */
function emptyObjectList(): Object[] {
  const list: Object[] = [];
  return list;
}

// ═════════════════════════ 6b. 排队项的呈现投影 ═════════════════════════

/**
 * 排队项（呈现层契约）。
 *
 * 【为什么要单独投影，而不是把 `SessionQueuedItem` 直接给 UI】
 *   `SessionQueuedItem.message` 是**原始消息对象**（含 content 块数组、角色等协议细节）。
 *   直接把原始对象交给视图，等于让每个视图各写一遍"从 message 里抠文本"的逻辑——
 *   而这类重复实现迟早会出现两处不一致（一处显示文本、一处显示 `[object Object]`）。
 */
export interface QueuedItem {
  /** 队列项 id（`session/updateQueue` 的 `itemId`） */
  id: string;
  /** 位置：`queued` / `steering` / `context`（原样带上，UI 据此标注） */
  placement: string;
  /** 正文（纯文本部分拼接；没有文本时给出一句如实的说明，不给空串） */
  text: string;
}

/** 从基线里的 `queues`（sessionId → 条目数组）取某个会话的排队项。 */
export function queuedItemsOf(queues: Object | undefined, sessionId: string): SessionQueuedItem[] {
  const raw: Object[] | undefined = getArray(queues, sessionId);
  return raw === undefined ? emptyQueuedItems() : readQueuedArray(raw);
}

/** 投影成呈现层条目。 */
export function projectQueuedItems(items: SessionQueuedItem[]): QueuedItem[] {
  const out: QueuedItem[] = [];
  for (let i = 0; i < items.length; i++) {
    out.push({
      id: items[i].id,
      placement: items[i].placement,
      text: queuedTextOf(items[i].message)
    });
  }
  return out;
}

/**
 * 从排队项的消息里取正文。
 *
 * 【为什么"没有文本"要给一句话而不是空串】排队项可能只带附件（合法的用户消息）。
 * 显示空串会让用户看到一行**空白的待发条目**，无法判断它是"坏掉了"还是"只有附件"。
 * 因此这里如实说出块数与类型，用户才知道该不该把它取回来补文字。
 */
function queuedTextOf(message: Object): string {
  const parts: Object[] | undefined = getArray(message, 'content');
  if (parts === undefined || parts.length === 0) {
    return '（无可显示内容）';
  }
  let text: string = '';
  let nonText: number = 0;
  for (let i = 0; i < parts.length; i++) {
    const part: Object | undefined = parts[i];
    const kind: string = readString(part, 'type');
    if (kind === 'text') {
      const piece: string = readString(part, 'text');
      text += text.length > 0 && piece.length > 0 ? '\n' : '';
      text += piece;
    } else {
      nonText++;
    }
  }
  if (text.length > 0) {
    return nonText > 0 ? `${text}\n（另有 ${nonText} 个非文本块）` : text;
  }
  return `（${nonText} 个非文本块，如附件/图片）`;
}

// ═════════════════════════ 5. session/follow（流式） ═════════════════════════

/** 追流地址：普通会话。 */
export interface FollowSessionAddress {
  kind: string;
  sessionId: string;
}

/** 追流地址：子代理会话（必须同时给出父子 id 与模式）。 */
export interface FollowSubagentAddress {
  kind: string;
  parentSessionId: string;
  childSessionId: string;
  /** `'one-shot'` 或 `'continuable'`；两种模式的续跑语义不同 */
  mode: string;
}

/** 构造普通会话地址。 */
export function followSessionAddress(sessionId: string): FollowSessionAddress {
  return { kind: 'session', sessionId: sessionId };
}

/** 构造子代理地址。 */
export function followSubagentAddress(parentSessionId: string, childSessionId: string,
  mode: string): FollowSubagentAddress {
  return { kind: 'subagent', parentSessionId: parentSessionId, childSessionId: childSessionId, mode: mode };
}

/** `session/follow` 业务参数体。 */
export interface SessionFollowRequest {
  address: Object;
  /** 快照里最多带多少条历史消息（不传 = Host 默认） */
  maxMessages?: number;
  /** 是否附带进程内的助手流帧（仅 `true` 是合法值；不传即关闭） */
  assistantStream?: boolean;
}

/**
 * 构造 `session/follow` 的 args 载荷。
 *
 * `assistantStream` 取布尔入参而不是写死 `true`：
 * 上游类型是字面量 `true`（只能开不能显式关），
 * 用布尔入参把「开/不开」表达清楚，`false` 时**整个字段不出现**
 * （而不是发 `assistantStream: false`——那不是合法值，会被 Host 拒绝）。
 */
export function sessionFollowPayload(address: Object, maxMessages: number,
  assistantStream: boolean): Object | undefined {
  const body: SessionFollowRequest = { address: address };
  if (maxMessages >= 0) {
    body.maxMessages = maxMessages;
  }
  if (assistantStream) {
    body.assistantStream = true;
  }
  return argsFor(SESSION_FOLLOW_ENDPOINT, body);
}

/** 追流帧类型判别值（收成一个枚举，避免各层拼字符串）。 */
export enum FollowFrameType {
  SNAPSHOT = 'snapshot',
  EVENT = 'event',
  ASSISTANT_STREAM = 'assistant-stream'
}

/** 追流头（快照携带的会话逻辑元信息）。 */
export interface SessionWireHeader {
  version: number;
  id: string;
  createdAt: number;
  cwd?: string;
  parentSession?: string;
  /** 会话是否含分叉继承的前缀 */
  isSeeded: boolean;
  origin?: string;
  /** 子代理委派深度 */
  delegationDepth?: number;
  agentPreset?: string;
}

/** 一条会话事件（线形）。`data` 是事件私有载荷，本层不解释。 */
export interface SessionWireEvent {
  type: string;
  seq: number;
  time: number;
  data: Object;
  /** 可忽略事件标记：客户端不认识的 `ignorable` 事件可以安全跳过 */
  ignorable?: boolean;
  /** 表面替换操作的来源序号（见 `surfaceOp`） */
  sourceEventSeqs?: Object;
  /**
   * 表面位置操作：`'append'` 或 `{op:'replace', startSeq, endSeq}`。
   * 历史页重放时用它把「被替换掉的旧事件」从表面上摘掉。
   */
  surfaceOp?: Object;
}

/** 一条历史记录（实测只有 `type='event'` 一种）。 */
export interface SessionHistoryRecord {
  type: string;
  event: SessionWireEvent;
}

/** 快照帧。 */
export interface FollowSnapshotFrame {
  type: string;
  header: SessionWireHeader;
  /** 快照对应的会话事件游标（后续 `session/page` 要用它作为 `throughSeq`） */
  cursor: number;
  records: SessionHistoryRecord[];
  hasMore: boolean;
  projections: ProjectionHints;
  /** 进程内助手流的基线（仅在请求里开了 `assistantStream` 时出现） */
  assistantStream?: Object;
}

/** 实时事件帧。 */
export interface FollowEventFrame {
  type: string;
  event: SessionWireEvent;
}

/** 助手流帧的外壳。 */
export interface FollowAssistantStreamFrame {
  type: string;
  frame: Object;
}

/** 追流帧读取结果（判别字段 + 三种载荷；同一时刻只有一种非空）。 */
export interface FollowFrame {
  type: string;
  snapshot: FollowSnapshotFrame | undefined;
  event: FollowEventFrame | undefined;
  assistantStream: FollowAssistantStreamFrame | undefined;
}

/**
 * 把一条原始帧投影成 `FollowFrame`。
 *
 * 取值纪律：先读 `type` 再读对应载荷，
 * 不认识的 `type` 原样返回（`snapshot/event/assistantStream` 全为 undefined），
 * 让调用方决定是忽略还是报警——**不抛异常**，因为未知帧在协议升级期是正常现象。
 */
export function readFollowFrame(value: Object): FollowFrame {
  const type: string = readString(value, 'type');
  const frame: FollowFrame = {
    type: type,
    snapshot: undefined,
    event: undefined,
    assistantStream: undefined
  };
  if (type === FollowFrameType.SNAPSHOT) {
    frame.snapshot = readSnapshot(value);
  } else if (type === FollowFrameType.EVENT) {
    const event: SessionWireEvent | undefined = readEvent(getRecord(value, 'event'));
    if (event !== undefined) {
      frame.event = { type: type, event: event };
    }
  } else if (type === FollowFrameType.ASSISTANT_STREAM) {
    const inner: Object | undefined = getRecord(value, 'frame');
    if (inner !== undefined) {
      frame.assistantStream = { type: type, frame: inner };
    }
  }
  return frame;
}

function readSnapshot(value: Object): FollowSnapshotFrame | undefined {
  const header: SessionWireHeader | undefined = readHeader(getRecord(value, 'header'));
  if (header === undefined) {
    return undefined;
  }
  const records: SessionHistoryRecord[] = [];
  const raw: Object[] | undefined = getArray(value, 'records');
  if (raw !== undefined) {
    for (let i = 0; i < raw.length; i++) {
      const entry: Object | undefined = getRecord(raw[i], 'event');
      const event: SessionWireEvent | undefined = readEvent(entry);
      if (event !== undefined) {
        records.push({ type: 'event', event: event });
      }
    }
  }
  const projections: ProjectionHints | undefined = readProjections(value);
  const snapshot: FollowSnapshotFrame = {
    type: FollowFrameType.SNAPSHOT,
    header: header,
    cursor: readNumber(value, 'cursor'),
    records: records,
    hasMore: readBoolean(value, 'hasMore'),
    projections: projections !== undefined ? projections : emptyProjectionHints()
  };
  const stream: Object | undefined = getRecord(value, 'assistantStream');
  if (stream !== undefined) {
    snapshot.assistantStream = stream;
  }
  return snapshot;
}

function readHeader(value: Object | undefined): SessionWireHeader | undefined {
  if (value === undefined) {
    return undefined;
  }
  const id: string | undefined = getString(value, 'id');
  if (id === undefined || id.length === 0) {
    return undefined;
  }
  return {
    version: readNumber(value, 'version'),
    id: id,
    createdAt: readNumber(value, 'createdAt'),
    cwd: optionalString(value, 'cwd'),
    parentSession: optionalString(value, 'parentSession'),
    isSeeded: readBoolean(value, 'isSeeded'),
    origin: optionalString(value, 'origin'),
    delegationDepth: optionalNumber(value, 'delegationDepth'),
    agentPreset: optionalString(value, 'agentPreset')
  };
}

function readEvent(value: Object | undefined): SessionWireEvent | undefined {
  if (value === undefined) {
    return undefined;
  }
  const type: string | undefined = getString(value, 'type');
  if (type === undefined || type.length === 0) {
    return undefined;
  }
  const data: Object | undefined = getRecord(value, 'data');
  const event: SessionWireEvent = {
    type: type,
    seq: readNumber(value, 'seq'),
    time: readNumber(value, 'time'),
    data: data !== undefined ? data : emptyBagObject()
  };
  // 可选字段只在**真的存在**时才赋值：对象字面量里显式写 `undefined`
  // 在 ArkTS 严格模式下容易触发类型不匹配，而且会让「字段存在但为空」与「字段不存在」混淆。
  const ignorable: boolean | undefined = optionalBoolean(value, 'ignorable');
  if (ignorable !== undefined) {
    event.ignorable = ignorable;
  }
  const sources: Object | undefined = getRecord(value, 'sourceEventSeqs');
  if (sources !== undefined) {
    event.sourceEventSeqs = sources;
  }
  const surfaceOp: Object | undefined = getField(value, 'surfaceOp');
  if (surfaceOp !== undefined) {
    event.surfaceOp = surfaceOp;
  }
  return event;
}

// ═════════════════════════ 6. session/control（流式） ═════════════════════════

/** 控制帧类型判别值。 */
export enum ControlFrameType {
  BASELINE = 'baseline',
  QUEUE = 'queue',
  JOBS = 'jobs',
  PROJECTION = 'projection'
}

/** 一个排队项（尚未进入轮次的用户消息）。 */
export interface SessionQueuedItem {
  id: string;
  /** 位置：`'queued'` / `'steering'` / `'context'` */
  placement: string;
  /** 铸造该消息的 prompt 请求 id（用于清掉本地的乐观回显） */
  rpcId?: string;
  message: Object;
}

/**
 * 一条后台任务（`SessionJob`）。
 *
 * `id` 的上游类型是 `JobId`，与 `MessageId` / `SessionId` 同属
 * `Branded<string>`——**编译期独有的标记，线形上就是字符串**（见 `SessionUpdateQueueRequest` 的说明），
 * 因此本文件用 `string` 承载。
 */

/**
 * 控制流的起始基线。
 *
 * 三个字段都是 **sessionId → 数据** 的映射（上游是 `Record<SessionId, …>`）。
 */
export interface ControlBaseline {
  queues: JsonBag;
  jobs: JsonBag;
  projections: JsonBag;
}

/** 控制帧读取结果（判别字段 + 各载荷）。 */
export interface ControlFrame {
  type: string;
  baseline: ControlBaseline | undefined;
  sessionId: string;
  items: SessionQueuedItem[];
  jobs: SessionJob[];
  key: string;
  value: Object | undefined;
  seq: number;
}

/**
 * 把一条原始控制帧投影成 `ControlFrame`。
 *
 * **审批与提问不在这里**（重要）：
 *   它们不走 `session/control`，而是走网关 `$events` 流的 waterfall 帧
 *   （见本文件第 7 节）。把这条事实写进注释，是因为
 *   `session/control` 的归属能力恰好叫 `approvals`，
 *   很容易让人以为审批从这里来——实测不是。
 */
export function readControlFrame(value: Object): ControlFrame {
  const type: string = readString(value, 'type');
  const frame: ControlFrame = {
    type: type,
    baseline: undefined,
    sessionId: '',
    items: emptyQueuedItems(),
    jobs: emptyJobs(),
    key: '',
    value: undefined,
    seq: 0
  };
  if (type === ControlFrameType.BASELINE) {
    const raw: Object | undefined = getRecord(value, 'value');
    if (raw !== undefined) {
      frame.baseline = {
        queues: bagOf(raw, 'queues'),
        jobs: bagOf(raw, 'jobs'),
        projections: bagOf(raw, 'projections')
      };
    }
    return frame;
  }
  if (type === ControlFrameType.PROJECTION) {
    frame.sessionId = readString(value, 'sessionId');
    frame.key = readString(value, 'key');
    frame.value = getField(value, 'value');
    frame.seq = readNumber(value, 'seq');
    return frame;
  }
  if (type === ControlFrameType.QUEUE) {
    frame.sessionId = readString(value, 'sessionId');
    frame.items = readQueuedItems(value);
    return frame;
  }
  if (type === ControlFrameType.JOBS) {
    frame.sessionId = readString(value, 'sessionId');
    frame.jobs = readJobs(value);
    return frame;
  }
  return frame;
}

function readQueuedItems(value: Object): SessionQueuedItem[] {
  const raw: Object[] | undefined = getArray(value, 'items');
  return raw === undefined ? emptyQueuedItems() : readQueuedArray(raw);
}

/** 把一个**已经取出的**排队项数组投影成条目（基线里的 `queues[sessionId]` 是这种形态）。 */
function readQueuedArray(raw: Object[]): SessionQueuedItem[] {
  const out: SessionQueuedItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item: Object = raw[i];
    if (!isRecord(item)) {
      continue;
    }
    const id: string | undefined = getString(item, 'id');
    if (id === undefined || id.length === 0) {
      continue;
    }
    const message: Object | undefined = getRecord(item, 'message');
    out.push({
      id: id,
      placement: readString(item, 'placement'),
      rpcId: optionalString(item, 'rpcId'),
      message: message !== undefined ? message : emptyBagObject()
    });
  }
  return out;
}

function readJobs(value: Object): SessionJob[] {
  const raw: Object[] | undefined = getArray(value, 'jobs');
  return raw === undefined ? emptyJobs() : readJobArray(raw);
}

/**
 * 基线里的 jobs 与 queues **同构**：`sessionId → 任务数组`（照 `queuedItemsOf` 的先例）。
 *
 * 【为什么必须有它】`JOBS` 帧只在**变化时**推送，而重连/首次订阅拿到的是 `BASELINE`。
 * 不读基线 ⇒ 重连后任务列表会空着，直到下一次任务状态变化——"界面上没有"与
 * "真的没有"必须分得开。
 */
export function jobsOf(jobs: Object | undefined, sessionId: string): SessionJob[] {
  const raw: Object[] | undefined = getArray(jobs, sessionId);
  return raw === undefined ? emptyJobs() : readJobArray(raw);
}

/** 把一个**已经取出的**任务数组解析成条目 */
function readJobArray(raw: Object[]): SessionJob[] {
  const out: SessionJob[] = [];
  for (let i = 0; i < raw.length; i++) {
    const job: Object = raw[i];
    if (!isRecord(job)) {
      continue;
    }
    const id: string | undefined = getString(job, 'id');
    if (id === undefined || id.length === 0) {
      continue;
    }
    out.push({
      id: id,
      kind: readString(job, 'kind'),
      label: readString(job, 'label'),
      status: readString(job, 'status'),
      detail: optionalString(job, 'detail'),
      startedAt: readNumber(job, 'startedAt'),
      finishedAt: optionalNumber(job, 'finishedAt')
    });
  }
  return out;
}

// ═════════════════════════ 7. 网关 $events waterfall：审批与提问 ═════════════════════════

/**
 * waterfall 事件名（审批 / 提问）。
 *
 * **不再在本文件写字面量，改为从 `dshcompat` 转出。**
 * 这两个名字是上游事实，唯一落点必须是 `dshcompat/RemoteEvents.ets`
 * （`WATERFALL_APPROVAL` / `WATERFALL_QUESTION`，含完整白名单与依据出处）。
 * 本文件原先各自复制了一份字面量，等于在「唯一事实落点」之外又开了一处——
 * 上游改名时必然漏改一处。架构门禁 `tools/arch-check.mjs` 会拒绝这类复制。
 *
 * 保留这两个导出名是为了不破坏既有调用方；它们现在只是别名。
 */
export { WATERFALL_APPROVAL as APPROVAL_REQUEST_EVENT, WATERFALL_QUESTION as USER_QUESTIONS_REQUEST_EVENT } from 'dshcompat';

/**
 * 一条 waterfall 帧。
 *
 * 实测字段：`{type:'waterfall', event, eventId, agentId, request}`。
 * `eventId` 是**回送结果时的关联键**，`clientId` 则由 `$events` 流的 `ready` 帧给出——
 * 两者一起构成 `$events/result` 的定位参数。
 */
export interface WaterfallFrame {
  type: string;
  /** 事件名（`approval/request` / `user-questions/request` / …） */
  event: string;
  eventId: string;
  agentId: string;
  request: Object;
}

/** 判定是否为 waterfall 帧（非 waterfall 的（如 `emit`/`ready`/`cancel`）交给上层忽略）。 */
export function isWaterfallFrame(value: Object): boolean {
  return readString(value, 'type') === 'waterfall';
}

/** 投影一条 waterfall 帧；字段不全（缺 eventId）时返回 undefined，避免发出无法关联的结果。 */
export function readWaterfallFrame(value: Object): WaterfallFrame | undefined {
  if (!isWaterfallFrame(value)) {
    return undefined;
  }
  const eventId: string = readString(value, 'eventId');
  if (eventId.length === 0) {
    return undefined;
  }
  const request: Object | undefined = getRecord(value, 'request');
  return {
    type: 'waterfall',
    event: readString(value, 'event'),
    eventId: eventId,
    agentId: readString(value, 'agentId'),
    request: request !== undefined ? request : emptyBagObject()
  };
}

/** 审批请求载荷（实测：`{agent, toolName, callId?, reason?}`）。 */
export interface ApprovalRequestPayload {
  /** Agent 身份（线形上是不透明对象，本层不解释） */
  agent: Object;
  toolName: string;
  callId?: string;
  reason?: string;
}

/** 投影审批请求载荷。`toolName` 是唯一必填的业务字段（缺它 UI 无法说明「在批准什么」）。 */
export function projectApprovalRequest(request: Object): ApprovalRequestPayload | undefined {
  const toolName: string | undefined = getString(request, 'toolName');
  if (toolName === undefined || toolName.length === 0) {
    return undefined;
  }
  const agent: Object | undefined = getRecord(request, 'agent');
  return {
    agent: agent !== undefined ? agent : emptyBagObject(),
    toolName: toolName,
    callId: optionalString(request, 'callId'),
    reason: optionalString(request, 'reason')
  };
}

/** 审批结果词表（实测的**闭集**，四个值，没有第五个）。 */
export enum ApprovalOutcome {
  /** 只批准这一次 */
  ALLOWED_ONCE = 'allowed-once',
  /** 明确拒绝 */
  REJECTED = 'rejected',
  /** 请求已被撤回 */
  CANCELLED = 'cancelled',
  /** 没有可用的答复者（**fail closed**：视为拒绝） */
  UNAVAILABLE = 'unavailable'
}

/** 审批卡上的三选（产品层词汇，与线形词表刻意分开）。 */
export enum ApprovalDecision {
  /** 仅本次允许 */
  ALLOW_ONCE = 'allow-once',
  /** 拒绝 */
  DENY = 'deny',
  /** 总是允许 */
  ALWAYS = 'always'
}

/**
 * 产品决策 → 线形结果。
 *
 * ⚠ `取舍`（**产品决策，需要确认，不许静默糊过去**）：
 *   上游的结果词表是 `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`，
 *   **没有 `'allow-always'`**（也不接受把 `'always'` 当值发出去）。
 *   因此 UI 上的「总是允许」在本线协议里**无处表达**，只能落成 `allowed-once`。
 *   后果必须说清楚：
 *     - 若 UI 保留「总是允许」按钮，那它**只能是纯客户端行为**——
 *       把该工具名记进本地白名单，后续同工具的审批在本端自动回答「允许一次」。
 *       换了设备、清了数据、或另一个客户端在答，就都不生效。
 *     - 更诚实的做法是**去掉这个按钮**，避免用户以为「Host 记住了」。
 *   本文件按最保守的方式映射（`always → allowed-once`），
 *   并提供 `decisionIsClientSideOnly()` 让 UI 能显式提示这一点。
 *   最终保留哪个形态属产品决策，此处只把事实与代价钉在代码里。
 */
export function approvalOutcomeFor(decision: ApprovalDecision): ApprovalOutcome {
  if (decision === ApprovalDecision.DENY) {
    return ApprovalOutcome.REJECTED;
  }
  return ApprovalOutcome.ALLOWED_ONCE;
}

/** 该决策是否只在客户端生效（见 `approvalOutcomeFor()` 的取舍说明）。 */
export function decisionIsClientSideOnly(decision: ApprovalDecision): boolean {
  return decision === ApprovalDecision.ALWAYS;
}

/** 审批答复值（`allowed-once` 只需要回一个词）。 */
export interface ApprovalAnswerValue {
  outcome: string;
}

/** 构造审批答复值。 */
export function approvalAnswer(decision: ApprovalDecision): ApprovalAnswerValue {
  return { outcome: approvalOutcomeFor(decision) };
}

// ── 提问 ──

/** 一个候选项。 */
export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

/** 提问的呈现意图：`plan-review` 表示「这是待批准的方案」，`approve` 指向表示同意的那一项。 */
export interface AskUserQuestionIntent {
  kind: string;
  approve: string;
}

/** 一条提问（实测字段逐字对应）。 */
export interface AskUserQuestionItem {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: AskUserQuestionOption[];
  multiSelect?: boolean;
  intent?: AskUserQuestionIntent;
}

/** 提问请求载荷。 */
export interface AskUserQuestionRequest {
  questions: AskUserQuestionItem[];
  agent?: Object;
}

/**
 * 投影提问请求载荷（跳过无 `id` 的条目：没有 id 就无法把答案对回去）。
 */
export function projectAskUserQuestionRequest(request: Object): AskUserQuestionRequest | undefined {
  const raw: Object[] | undefined = getArray(request, 'questions');
  if (raw === undefined) {
    return undefined;
  }
  const questions: AskUserQuestionItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item: Object = raw[i];
    if (!isRecord(item)) {
      continue;
    }
    const id: string | undefined = getString(item, 'id');
    if (id === undefined || id.length === 0) {
      continue;
    }
    questions.push({
      id: id,
      question: readString(item, 'question'),
      detail: optionalString(item, 'detail'),
      header: optionalString(item, 'header'),
      options: readOptions(item),
      multiSelect: optionalBoolean(item, 'multiSelect'),
      intent: readIntent(item)
    });
  }
  const agent: Object | undefined = getRecord(request, 'agent');
  const out: AskUserQuestionRequest = { questions: questions };
  if (agent !== undefined) {
    out.agent = agent;
  }  return out;
}

function readOptions(item: Object): AskUserQuestionOption[] | undefined {
  const raw: Object[] | undefined = getArray(item, 'options');
  if (raw === undefined) {
    return undefined;
  }
  const out: AskUserQuestionOption[] = [];
  for (let i = 0; i < raw.length; i++) {
    const option: Object = raw[i];
    if (!isRecord(option)) {
      continue;
    }
    const label: string | undefined = getString(option, 'label');
    if (label === undefined) {
      continue;
    }
    const entry: AskUserQuestionOption = { label: label };
    const description: string | undefined = getString(option, 'description');
    if (description !== undefined) {
      entry.description = description;
    }
    out.push(entry);
  }
  return out;
}

function readIntent(item: Object): AskUserQuestionIntent | undefined {
  const raw: Object | undefined = getRecord(item, 'intent');
  if (raw === undefined) {
    return undefined;
  }
  const kind: string | undefined = getString(raw, 'kind');
  if (kind === undefined) {
    return undefined;
  }
  return { kind: kind, approve: readString(raw, 'approve') };
}

/** 一条答案（实测：`{id, selected: string[], custom?}`）。 */
export interface AskUserQuestionAnswerItem {
  id: string;
  /** 选中的**选项标签**（不是下标）；多选时可与 `custom` 并存 */
  selected: string[];
  /** 自由文本「其他」答案 */
  custom?: string;
}

/** 提问答复值（实测：`{answers: [...]}`）。 */
export interface AskUserQuestionAnswer {
  answers: AskUserQuestionAnswerItem[];
}

/** 构造一条答案。 */
export function questionAnswerItem(id: string, selected: string[],
  custom: string): AskUserQuestionAnswerItem {
  const item: AskUserQuestionAnswerItem = { id: id, selected: selected };
  if (custom.length > 0) {
    item.custom = custom;
  }
  return item;
}

/** 构造提问答复值。 */
export function questionAnswer(answers: AskUserQuestionAnswerItem[]): AskUserQuestionAnswer {
  return { answers: answers };
}

// ═════════════════════════ 8. $events/result 回送 ═════════════════════════

/** 回送错误（实测：`{name, message, code?, details?}`）。 */
export interface WireError {
  name: string;
  message: string;
  code?: string;
  details?: Object;
}

/** `kind='result'` 的结果值（审批回一个词，提问回一个答案对象）。 */
export interface OutcomeResult {
  value?: Object;
}

/** `kind='rejected'` 的载荷。 */
export interface OutcomeRejected {
  error: WireError;
}

/**
 * 回送参数（实测：`{clientId, eventId, outcome}`；`outcome` 三选一）。
 *
 * 三种 outcome 的含义（照上游语义）：
 *   - `{kind:'next'}`：**把决定权交回 waterfall 链上的下一个答复者**。
 *     这是我们**选择不处理**某请求时的正确回应——
 *     例如宿主自己有自动批准钩子，或另一个客户端更该回答（如方案评审）。
 *     绝不能为了「让流程往下走」而回一个假结果：回假结果等于我们**代替用户批准**了，
 *     这是权限问题，不是便利性问题。
 *   - `{kind:'result', value}`：我们认领了这个请求，附上回答。
 *   - `{kind:'rejected', error}`：我们认领了但处理失败（异常路径）。
 */
export interface EventResultArgs {
  clientId: string;
  eventId: string;
  outcome: Object;
}

/** 构造 `{kind:'next'}` —— 交回链上的下一个答复者（**我们不做决定**）。 */
export function outcomeNext(): Object {
  const outcome: Record<string, Object> = { 'kind': 'next' };
  return outcome as Object;
}

/** 构造 `{kind:'result', value}`。`value` 为 undefined 时不带 `value` 字段。 */
export function outcomeResult(value: Object | undefined): Object {
  const outcome: Record<string, Object> = { 'kind': 'result' };
  if (value !== undefined) {
    outcome['value'] = value;
  }
  return outcome as Object;
}

/** 构造 `{kind:'rejected', error}`。 */
export function outcomeRejected(error: WireError): Object {
  const outcome: Record<string, Object> = { 'kind': 'rejected', 'error': error };
  return outcome as Object;
}

/**
 * 构造 `$events/result` 的 args。
 *
 * **该端点不在业务端点上表内**（它是网关内部端点，不是 `ns/method` 形式的业务端点），
 * 因此 `dshcompat.argsFor()` 对它返回 `undefined` —— 这是**正确行为**，不要试图绕开。
 * 实测依据：上游 `dsh-api-gateway` 的 `dispatchRpc` 直接调用
 * `parseRemoteEventResult(payload.args)`，即 **args 本身就是** `{clientId, eventId, outcome}`，
 * **没有** `request` / `_request` 包装层。
 * 因此这里直接构造扁平对象，不经任何形态包装。
 *
 * endpoint 常量取自 `connection` 的 `EVENTS_RESULT_ENDPOINT`（连接层已导出，本文件不重复定义）。
 */
export function eventResultArgs(clientId: string, eventId: string, outcome: Object): EventResultArgs {
  return { clientId: clientId, eventId: eventId, outcome: outcome };
}

/** `$events/result` 的端点（供连接层直接调用）。 */
export function eventResultEndpoint(): string {
  return EVENTS_RESULT_ENDPOINT;
}

// ═════════════════════════ 9. 附件上传（本机文件 → filePart 所需回执） ═════════════════════════

/**
 * `fileUploads/upload` 的端点（用于把本机文件换成 `filePart()` 所需的不透明回执）。
 *
 * 参数形态是 `ArgsShape.NAMED`（具名参数 `agent` + `request`），
 * 因此下面的构造器返回的 body **不含任何包装层**，由 `argsFor()` 原样透传。
 */
export function fileUploadEndpoint(): string {
  return FILE_UPLOAD_ENDPOINT;
}

/**
 * 一次上传请求（上游 `EncodedFileUploadRequest`）。
 *
 * 已确认（`@deepseek-ai/dsh-client-file-upload/lib/types/types.d.ts`）：
 *   `{data: string, name?: string}`，其中 `data` 是文件字节的规范 base64。
 * `data` 内联在 RPC 里；另有一条原始字节 HTTP 路由
 * `/api/session/uploadFileBinary`，本文件不使用（我们走 RPC 面）。
 */
export interface FileUploadRequest {
  /** 文件字节的规范 base64 编码（不含 `data:` 前缀） */
  data: string;
  /** 展示名；Host 会把它消毒成存储用的叶子名（**永远不会**当路径解释） */
  name?: string;
}

/** 文件附件引用（上游 `FileAttachmentRef`）。 */
export interface FileAttachmentRefValue {
  /** 内容寻址 id：**就是这些字节的 sha256**，不是路径也不是带授权的 URL */
  attachmentId: string;
  /** 消毒后的展示文件名 */
  name: string;
  /** 精确字节数 */
  bytes: number;
}

/** 上传成功后的回执（上游 `FileUploadValue`）。 */
export interface FileUploadValue {
  /**
   * 不透明回执 id。
   * 上游注释：**只在接收它的 Agent 作用域内有效**——
   * 因此它既不能跨会话复用，也不能缓存起来给下次用（见 `filePart()` 的说明）。
   */
  receiptId: string;
  file: FileAttachmentRefValue;
}

/**
 * 构造 `fileUploads/upload` 的 args 载荷。
 *
 * 返回 `Object | undefined`（endpoint 不在上表时为 undefined，调用方降级）。
 *
 * 【线上参数名是 `agentId`，不是 `agent`】
 *   本函数此处曾经写成 `agent`（依据是上游 `.d.ts` 里的**形参名**）。
 *   生成上表里这个端点的 `params` 是 `['agentId', 'request']`，也就是线上名。
 *   按形参名发会被拒：`gateway/arguments-invalid: missing "agentId"`。
 *   这与 `commands/execute` 的 `images` → `submittedAttachments` 是同一类陷阱
 *   （见 `Aliases.PARAM_ALIASES` 的长注释）：**形参名 ≠ 线上名**。
 *   这个端点在客户端里此前从未被真正调用过，所以错误一直没暴露——
 *   只在第一次点「附件」时才会以一条 `arguments-invalid` 出现。
 *   注意：这里**不能**靠 `PARAM_ALIASES` 兜底，因为那张表只覆盖「改名过」的端点，
 *   而本端点是「一直叫 agentId，是我们写错了」。
 */
export function fileUploadPayload(agentId: string, data: string, name: string): Object | undefined {
  const request: FileUploadRequest = { data: data };
  if (name.length > 0) {
    request.name = name;
  }
  const body: Record<string, Object> = { 'agentId': agentId, 'request': request };
  return argsFor(FILE_UPLOAD_ENDPOINT, body as Object);
}

/**
 * 投影上传回执。
 *
 * 收窄策略：`receiptId` 缺失即视为失败（返回 undefined）——
 * 没有回执就没法构造 `filePart()`，静默返回半成品只会让 prompt 在更远处失败。
 */
export function projectFileUpload(value: Object | undefined): FileUploadValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  const receiptId: string | undefined = getString(value, 'receiptId');
  if (receiptId === undefined || receiptId.length === 0) {
    return undefined;
  }
  const file: Object | undefined = getRecord(value, 'file');
  const ref: FileAttachmentRefValue = {
    attachmentId: file !== undefined ? readString(file, 'attachmentId') : '',
    name: file !== undefined ? readString(file, 'name') : '',
    bytes: file !== undefined ? readNumber(file, 'bytes') : 0
  };
  return { receiptId: receiptId, file: ref };
}

// ═════════════════════════ 11. 工作区与文件（workspaceFiles/*） ═════════════════════════

/**
 * 列举**工作区根目录**时 `path` 要填的实参。
 *
 * 【这是一条实测事实，不是约定】把根写成空串会被 Host 拒绝：
 *   `workspaceFiles/list { workspaceFileScopeId, path: '' }`
 *   → `{"ok":false,"error":{"code":"gateway/bad-request","message":"path is required"}}`
 * 而 `path: '.'` 正确返回根层条目，且**回复里的 `path` 仍是空串**
 * （回复说「工作区相对路径」，工作区根就是空串——请求词法与回复词法不是一回事）。
 *
 * 【为什么要单独起个常量】`path` 与 `workspaceFileScopeId` 在上游声明里都标必填，
 * 但「必填」并不告诉你「根该怎么写」。空串是最自然的猜法，而它**静默地**变成一个
 * 空文件树——用户看到的是「这个目录是空的」，而不是任何错误。
 * 出处：`.research/protocol/probe-workspace.mjs`（见 D2 §8.7.16）。
 */
export const WORKSPACE_ROOT_REQUEST_PATH: string = '.';

/**
 * `workspaceFiles/list` 的 args 载荷。
 *
 * 【`workspaceFileScopeId` 填什么】就是当前会话 id，**不是**工作区 id，
 * 也**不需要**额外端点去「取得」它（D2b §2.0 有确证）。
 * 上游按这个 id 解析出 `workspaceRoot`（会话 header 的 cwd）后再做包含性校验。
 */
export function workspaceListPayload(sessionId: string, path: string): Object | undefined {
  const body: Record<string, Object> = { 'workspaceFileScopeId': sessionId, 'path': path };
  return argsFor(WORKSPACE_FILES_LIST_ENDPOINT, body as Object);
}

/** `workspaceFiles/list` 的端点（供连接层发起调用，UI 不写字面量）。 */
export function workspaceListEndpoint(): string {
  return WORKSPACE_FILES_LIST_ENDPOINT;
}

/** `workspaceFiles/list` 的逐项线形（**判别字段是 `type`，不是 `kind`/`isDirectory`**）。 */
export interface WorkspaceEntryWire {
  name: string;
  /** `file` / `directory` / `other`；未知取值按 `other` 处置（不猜成文件） */
  type: string;
  /** 仅常规文件且后端报告时存在 */
  size: number;
}

/** `workspaceFiles/list` 的回复线形。 */
export interface WorkspaceListingWire {
  /** 被列举目录的**工作区相对路径**；工作区根为空串 */
  path: string;
  entries: WorkspaceEntryWire[];
  /** 是否因条目上限（默认 2000）被截断 */
  truncated: boolean;
}

/** 把 `entry.type` 收窄成枚举；未知取值 ⇒ `other`（**不能默认成 file**）。 */
function entryKindOf(type: string): NodeKind {
  return type === 'directory' ? NodeKind.DIRECTORY : NodeKind.FILE;
}

/**
 * 投影一层目录列表为 `FileNode[]`。
 *
 * 【为什么不建树】上游 `workspaceFiles/list` 只返回**某一层**的直接子项
 * （D2b §2.1），要建树必须逐层调用。因此这里只把「一层」转成节点，
 * `loaded=false` 的目录在用户点开时才去拉下一层——这也是唯一不会
 * 在大型仓库上打出成百上千次 RPC 的做法。
 *
 * @param value 回复值（`{path, entries, truncated}`）
 * @param parentPath 被列举目录的工作区相对路径（根为空串）
 * @param deliverables 当前会话的交付物相对路径（`deliverables/presented` 事件）
 * @param truncatedOut 出参：是否被上游截断（调用方据此提示「只显示了前 N 项」）
 */
export function projectWorkspaceListing(value: Object | undefined, parentPath: string,
  deliverables: string[]): WorkspaceListingProjection {
  const nodes: FileNode[] = [];
  const result: WorkspaceListingProjection = { nodes: nodes, truncated: false };
  if (value === undefined) {
    return result;
  }
  const entries: Object[] | undefined = getArray(value, 'entries');
  if (entries === undefined) {
    return result;
  }
  if (getField(value, 'truncated') === true) {
    result.truncated = true;
  }
  for (let i = 0; i < entries.length; i++) {
    const entry: Object | undefined = entries[i];
    const name: string = readString(entry, 'name');
    if (name.length === 0) {
      continue;
    }
    const childPath: string = parentPath.length === 0 ? name : `${parentPath}/${name}`;
    nodes.push({
      name: name,
      path: childPath,
      kind: entryKindOf(readString(entry, 'type')),
      size: readNumber(entry, 'size'),
      // 上游不提供 mtime（D2b §2.1 明列），因此**只能**是 0（未知），
      // 不能拿列表拉取时刻冒充文件修改时刻。
      modifiedAt: 0,
      loaded: false,
      children: emptyFileNodes(),
      deliverable: containsPath(deliverables, childPath)
    });
  }
  return result;
}

/** 一层目录的投影结果（节点 + 上游是否截断）。 */
export interface WorkspaceListingProjection {
  nodes: FileNode[];
  /** 上游是否因条目上限丢弃了部分条目 */
  truncated: boolean;
}

/**
 * `workspaceFiles/read` 的 args 载荷。
 *
 * `range` 是**必填**的（可为 `{}`）；`offset` 是**行号（1-based）**不是字节偏移，
 * 默认 1；`limit` 是行数上限。这里的参数名必须按上表，不能按方法名猜。
 */
export function workspaceReadPayload(sessionId: string, path: string, maxLines: number): Object | undefined {
  const range: WorkspaceFileRange = {};
  if (maxLines > 0) {
    range.limit = maxLines;
  }
  const body: Record<string, Object> = {
    'workspaceFileScopeId': sessionId, 'path': path, 'range': range
  };
  return argsFor(WORKSPACE_FILES_READ_ENDPOINT, body as Object);
}

/** `workspaceFiles/read` 的端点。 */
export function workspaceReadEndpoint(): string {
  return WORKSPACE_FILES_READ_ENDPOINT;
}

/**
 * `workspaceFiles/readAll` 的 args 载荷（**整文件 base64，无 `range`**）。
 *
 * 用于「把 Host 侧的工作区文件投喂给 agent」：`readAll` 直接给出
 * `WorkspaceFileBytes.data`（完整 base64），正好是 `fileUploads/upload` 的输入。
 * 用 `read` 做不到这件事——它只返回文本，且非文本直接拒绝。
 *
 * 【根目录的那条坑在这里不存在】`path` 是**文件**路径，没有「根」这种调用形态，
 * 因此不需要 `WORKSPACE_ROOT_REQUEST_PATH` 之类的约定。
 */
export function workspaceReadAllPayload(sessionId: string, path: string): Object | undefined {
  const body: Record<string, Object> = { 'workspaceFileScopeId': sessionId, 'path': path };
  return argsFor(WORKSPACE_FILES_READ_ALL_ENDPOINT, body as Object);
}

/** `workspaceFiles/readAll` 的端点。 */
export function workspaceReadAllEndpoint(): string {
  return WORKSPACE_FILES_READ_ALL_ENDPOINT;
}

/**
 * 投影整文件字节读取结果。
 *
 * 返回 `undefined` 表示**取不到可用的 base64**（缺 `data` 或为空）：
 * 调用方必须据此放弃这次上传，而不是拿空串去上传（那会产生一个 0 字节的附件，
 * 而用户以为文件带上了）。
 */
export interface WorkspaceBytesWire {
  absolutePath: string;
  version: string;
  bytes: number;
  offset: number;
  /** 完整文件字节的 base64 */
  data: string;
  eof: boolean;
}

/** 取出 `readAll` 返回的 base64（缺失即 undefined）。 */
export function projectWorkspaceBytes(value: Object | undefined): WorkspaceBytesWire | undefined {
  if (value === undefined) {
    return undefined;
  }
  const data: string = readString(value, 'data');
  if (data.length === 0) {
    return undefined;
  }
  return {
    absolutePath: readString(value, 'absolutePath'),
    version: readString(value, 'version'),
    bytes: readNumber(value, 'bytes'),
    offset: readNumber(value, 'offset'),
    data: data,
    eof: getField(value, 'eof') === true
  };
}

/** `workspaceFiles/read` 的 `range`（行号/行数，不是字节偏移/长度）。 */
export interface WorkspaceFileRange {
  /** 起始**行号**，1-based；缺省 = 1 */
  offset?: number;
  /** 行数上限；缺省 = Host 的 `maxLines` */
  limit?: number;
}

/** `workspaceFiles/read` 的回复线形（`WorkspaceFileText`）。 */
export interface WorkspaceTextWire {
  path: string;
  bytes: number;
  offset: number;
  text: string;
  lines: number;
  /** 本页是否包含文件最后一行 */
  eof: boolean;
}

/**
 * 投影文本读取结果。
 *
 * 【为什么 `IMAGE` 在这里会被降级为 `CODE`】`read` 只返回**文本**
 * （非 UTF-8 或含 NUL ⇒ `workspace-file/not-text`），所以能走到这里的
 * 「图片扩展名」只有 SVG——而 SVG 本来就是 XML 文本。光栅图片永远走不到这，
 * 它会在错误分支里被投影成 `BINARY` 并带上上游的拒绝理由。
 */
export function projectWorkspaceText(value: Object | undefined, path: string, name: string,
  maxBytes: number): FilePreview {
  const text: string = readString(value, 'text');
  const bytes: number = readNumber(value, 'bytes');
  const eof: boolean = getField(value, 'eof') === true;
  let kind: PreviewKind = previewKindOf(name, 0);
  if (kind === PreviewKind.IMAGE) {
    kind = PreviewKind.CODE;
  }
  if (kind === PreviewKind.TOO_LARGE) {
    kind = PreviewKind.TEXT;
  }
  return {
    path: path,
    name: name,
    kind: kind,
    text: text,
    language: kind === PreviewKind.CODE ? languageOf(name) : '',
    size: bytes,
    // 「截断」= 本页不含文件末尾。用 `eof` 判定，**不能用** `text.length` 与
    // `bytes` 比大小：多字节字符下两者本来就不相等，会把完整文件误报成截断。
    truncated: !eof,
    note: maxBytes > 0 && bytes > maxBytes
      ? `文件 ${bytes} 字节，超过端侧单页上限 ${maxBytes} 字节，仅显示首页`
      : ''
  };
}

/**
 * 投影文件读取**失败**。
 *
 * 上游对不可预览的文件是**明确拒绝**（`workspace-file/not-text` /
 * `too-large` / `not-regular-file`），不是返回空内容。把拒绝理由原样带到界面上，
 * 用户才知道「为什么打不开」；静默显示空白会被误读成「文件是空的」。
 */
export function projectWorkspaceFailure(path: string, name: string, reason: string): FilePreview {
  return {
    path: path, name: name, kind: PreviewKind.BINARY, text: '', language: '',
    size: 0, truncated: false, note: reason
  };
}

/** 空文件节点数组（规避无类型数组字面量）。 */
function emptyFileNodes(): FileNode[] {
  const list: FileNode[] = [];
  return list;
}

// ═════════════════════════ 12. 工作区列表（从会话派生） ═════════════════════════

/**
 * 路径分组键：把连续的分隔符折叠成一个，并把 `\` 统一成 `/`。
 *
 * 【为什么分组必须归一化】实测真实 Host 上存在两个 cwd——`D:\dev\proj` 与
 * `D:\\dev\\proj`（多一个转义层，来自某次用 API 建会话时多转义了一次）。
 * 它们是**同一个目录**，但字符串不等。不归一化就会在界面上出现两个同名工作区、
 * 各带一部分会话，用户会以为有两个不同的项目目录。
 *
 * 归一化**只用于比较与分组**，不用于展示：展示仍用 Host 给的原字符串，
 * 因为那才是 Host 侧的事实（我们不该悄悄替它改写路径）。
 */
export function normalizePathKey(path: string): string {
  const slashed: string = path.replace(/\\/g, '/');
  let out: string = '';
  let prevSlash: boolean = false;
  for (let i = 0; i < slashed.length; i++) {
    const ch: string = slashed.charAt(i);
    const isSlash: boolean = ch === '/';
    if (isSlash && prevSlash) {
      continue;
    }
    out += ch;
    prevSlash = isSlash;
  }
  // 去掉尾部分隔符（`D:/a/` 与 `D:/a` 是同一个目录）
  while (out.length > 1 && out.endsWith('/')) {
    out = out.substring(0, out.length - 1);
  }
  return out;
}

/**
 * 从会话列表派生工作区列表。
 *
 * 【为什么从会话派生，而不是内置一份工作区清单】上游**没有**「工作区目录」端点：
 * 工作区的唯一定义就是「某个会话的 cwd」（`workspaceFiles` 的作用域也是会话级，
 * D2b §2.0）。凭空的「工作区列表」在 Host 上并不存在，写死一份就是编数据。
 * 因此这里按 `cwd` 分组：路径 = 工作区，会话数 = 该路径下的会话数。
 * 分组键经过 `normalizePathKey` 归一化（见其说明），展示值取先出现的那条。
 *
 * @param sessions 真实会话列表（未连接时应传空数组，而不是桩数据）
 */
export function projectWorkspaces(sessions: SessionListItem[]): WorkspaceItem[] {
  const keys: string[] = [];
  const paths: string[] = [];
  const counts: number[] = [];
  const latest: number[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const item: SessionListItem = sessions[i];
    if (item.cwd.length === 0) {
      continue;
    }
    const key: string = normalizePathKey(item.cwd);
    const at: number = keys.indexOf(key);
    if (at < 0) {
      keys.push(key);
      paths.push(item.cwd);
      counts.push(1);
      latest.push(item.updatedAt);
    } else {
      counts[at] = counts[at] + 1;
      if (item.updatedAt > latest[at]) {
        latest[at] = item.updatedAt;
      }
    }
  }
  // 主工作区 = 会话最多者；同数取最近活动者。两者都相同则取先出现的（稳定）。
  let primary: number = -1;
  for (let i = 0; i < paths.length; i++) {
    if (primary < 0 || counts[i] > counts[primary]
      || (counts[i] === counts[primary] && latest[i] > latest[primary])) {
      primary = i;
    }
  }
  const out: WorkspaceItem[] = [];
  for (let i = 0; i < paths.length; i++) {
    out.push({
      // id 用归一化键：它是**稳定身份**，用于「选中的是哪个工作区」的比较；
      // path 用 Host 的原字符串，用于展示与向用户陈述事实。
      id: keys[i],
      name: basenameOf(paths[i]),
      path: paths[i],
      sessionCount: counts[i],
      primary: i === primary
    });
  }
  // `home` 刻意不参与：没有任何会话的目录**无法**浏览——文件端点的作用域是
  // 会话级（`workspaceFileScopeId` = sessionId），列出它只会给用户一个点开就报错的入口。
  return out;
}

/** 取路径末段（容忍 `\\` 与 `/` 两种分隔符）。 */
export function basenameOf(path: string): string {
  let end: number = path.length;
  while (end > 0) {
    const ch: string = path.charAt(end - 1);
    if (ch !== '/' && ch !== '\\') {
      break;
    }
    end--;
  }
  let start: number = end;
  while (start > 0) {
    const ch: string = path.charAt(start - 1);
    if (ch === '/' || ch === '\\') {
      break;
    }
    start--;
  }
  const name: string = path.substring(start, end);
  return name.length > 0 ? name : path;
}

/** 列表里是否含该路径（精确匹配；交付物路径是工作区相对路径）。 */
function containsPath(list: string[], path: string): boolean {
  for (let i = 0; i < list.length; i++) {
    if (list[i] === path) {
      return true;
    }
  }
  return false;
}

// ═════════════════════════ 13. 斜杠命令与 @ 引用 ═════════════════════════

/** 输入区斜杠命令候选（**全部来自 Host 的 `commands/list`**） */
export interface CommandCandidate {
  /** 命令名（含前导 `/`，与用户输入一致） */
  name: string;
  /** 参数提示（Host 未提供时为空串） */
  args: string;
  /** 说明（Host 未提供时为空串） */
  detail: string;
}

/** 输入区 `@` 引用候选 */
export interface ReferenceCandidate {
  /** 引用类型：file / session */
  kind: string;
  /** 显示文本 */
  label: string;
  /** 插入到输入框的引用文本（**直接取上游给的 mention/path，不自行拼装**） */
  insert: string;
  /** 次要说明 */
  detail: string;
}

/** `commands/list` 的 args 载荷（具名参数 `agentId`）。 */
export function commandsListPayload(agentId: string): Object | undefined {
  const body: Record<string, Object> = { 'agentId': agentId };
  return argsFor(COMMANDS_LIST_ENDPOINT, body as Object);
}

/** `commands/list` 的端点。 */
export function commandsListEndpoint(): string {
  return COMMANDS_LIST_ENDPOINT;
}

/**
 * `commands/execute` 的 args 载荷（E187）。
 *
 * 【字段名交给兼容层】执行端的具名参数没有真机证据：这里给出我们认为合理的
 * `sessionId` + `name`（与 `CommandCandidate.name` 一致，含前导 `/`），
 * 由 `argsFor` 按**端点契约**映射/校验——契约不符时它返回 `undefined`，
 * 调用方就如实说"缺少参数契约"，而不是把不确定的字段发出去碰运气。
 */
/**
 * `commands/execute` 的 args 载荷（E219：**按权威契约修正**）。
 *
 * 【修正了什么】此前我按"同族端点都要会话"推断成 `{sessionId, name}`，**错了**。
 * 用 `tools/protocol-contract.mjs` 从上游生成调用描述符提取的真实契约是：
 *   `commands/execute  params: agentId, line, submittedAttachments`
 *   `commands/list     params: agentId`
 * ⇒ 这条端点要的是 **agentId**（不是 sessionId），命令本身叫 **line**，并带一个附件数组。
 * 【教训】"同族推论"不能替代契约；能生成契约时就去生成（本项目本来就有这个工具）。
 */
export function commandsExecutePayload(agentId: string, line: string): Object | undefined {
  const attachments: Object[] = [];
  const body: Record<string, Object> = {
    'agentId': agentId,
    'line': line,
    'submittedAttachments': attachments
  };
  return argsFor(COMMANDS_EXECUTE_ENDPOINT, body as Object);
}

/** `commands/execute` 的端点。 */
export function commandsExecuteEndpoint(): string {
  return COMMANDS_EXECUTE_ENDPOINT;
}

/**
 * `session/selectModel` 的 args 载荷（E193）：**按会话**切换模型与推理强度。
 *
 * 官方把这个控件放在**会话输入区**（`dsh-client-ui-model-selection`），写的就是这条端点；
 * 设置页那边管的是"新会话默认用什么"（`agent-default-model`，见 `setDefaultModel`）。
 *
 * 【字段交宿主裁决】`sessionId` 是确定的（同族端点都要会话）；`provider` / `model` / `effort`
 * 与 `setDefaultModel` 的命名保持一致，但**执行端的完整字段表没有真机证据** ⇒
 * 交给 `argsFor` 按端点契约（`Endpoints.ets:683`，REQUEST 形态）映射/校验，
 * 不符时返回 `undefined`，调用方如实说"缺少参数契约"，不把不确定的字段发出去碰运气。
 */
/**
 * `session/selectModel` 的 args 载荷（E222：**按契约修正为嵌套**）。
 *
 * 【修正了什么】我原先发的是扁平 `{sessionId, provider, model, effort}`，**错了**。
 * 上游类型定义（`dsh-api-session-controller` 的 `types.d.ts`）写的是：
 *   `interface SessionSelectModelRequest { readonly sessionId: SessionId; readonly selected: ModelSelection }`
 * ⇒ 选择项要**嵌套在 `selected` 里**（`ModelSelection` 的字段是 `provider / modelId / effort`，
 * 与我们的镜像类型一致——`setDefaultModel` 用的也是这三个名字）。
 * 【顺带核对】同一份类型定义确认 `SkillListRequest = { sessionId }` ⇒ E174 给 `skills/list`
 * 传 `sessionId` 的修复是**对的**（那条 `failed to observe session "undefined"` 正是缺它）。
 */
export function sessionSelectModelPayload(sessionId: string, provider: string, model: string,
  effort: string): Object | undefined {
  const selected: Record<string, Object> = {
    'provider': provider,
    'modelId': model,
    'effort': effort
  };
  const body: Record<string, Object> = {
    'sessionId': sessionId,
    'selected': selected
  };
  return argsFor(SESSION_SELECT_MODEL_ENDPOINT, body as Object);
}

/** `session/selectModel` 的端点。 */
export function sessionSelectModelEndpoint(): string {
  return SESSION_SELECT_MODEL_ENDPOINT;
}
/**
 * 投影命令目录。
 *
 * 【必须用 Host 的名字，不能自己补 `/`】上游 `CommandDescriptor.name`
 * 是否带前导 `/` 决定了插入文本是否可用。这里**检查**而不是假设：
 * 有前导 `/` 就原样用，没有才补——补错会让用户发出的行变成未知命令
 * （`commands/execute` 对未注册的命令返回 `undefined`，静默无反应）。
 */
export function projectCommands(value: Object | undefined): CommandCandidate[] {
  const out: CommandCandidate[] = [];
  if (value === undefined) {
    return out;
  }
  const list: Object[] | undefined = Array.isArray(value) ? value as Object[] : getArray(value, 'items');
  if (list === undefined) {
    return out;
  }
  for (let i = 0; i < list.length; i++) {
    const item: Object | undefined = list[i];
    const raw: string = readString(item, 'name');
    if (raw.length === 0) {
      continue;
    }
    const name: string = raw.startsWith('/') ? raw : `/${raw}`;
    const input: Object | undefined = getRecord(item, 'input');
    out.push({
      name: name,
      args: input !== undefined ? readString(input, 'hint') : '',
      detail: readString(item, 'description')
    });
  }
  return out;
}

/** `fileReferences/list` 的 args 载荷（具名参数 `agentId` + `query`）。 */
export function fileReferencesPayload(agentId: string, query: string): Object | undefined {
  const body: Record<string, Object> = { 'agentId': agentId, 'query': query };
  return argsFor(FILE_REFERENCES_LIST_ENDPOINT, body as Object);
}

/** `fileReferences/list` 的端点。 */
export function fileReferencesEndpoint(): string {
  return FILE_REFERENCES_LIST_ENDPOINT;
}

/** `sessionReferenceResolver/candidates` 的 args 载荷。 */
export function sessionReferencesPayload(agentId: string, query: string): Object | undefined {
  const body: Record<string, Object> = { 'agentId': agentId, 'query': query };
  return argsFor(SESSION_REFERENCE_CANDIDATES_ENDPOINT, body as Object);
}

/** `sessionReferenceResolver/candidates` 的端点。 */
export function sessionReferencesEndpoint(): string {
  return SESSION_REFERENCE_CANDIDATES_ENDPOINT;
}

/**
 * 投影文件候选（`FileReferenceCandidate[]` = `{path, kind}`）。
 *
 * 插入文本就是 `path`：上游的 `@` 提及语法对文件用的就是工作区相对路径。
 */
export function projectFileReferences(value: Object | undefined): ReferenceCandidate[] {
  const out: ReferenceCandidate[] = [];
  if (value === undefined) {
    return out;
  }
  const list: Object[] | undefined = Array.isArray(value) ? value as Object[] : getArray(value, 'items');
  if (list === undefined) {
    return out;
  }
  for (let i = 0; i < list.length; i++) {
    const item: Object | undefined = list[i];
    const path: string = readString(item, 'path');
    if (path.length === 0) {
      continue;
    }
    const isDir: boolean = readString(item, 'kind') === 'directory';
    out.push({
      kind: isDir ? 'directory' : 'file',
      label: path,
      insert: isDir ? `@${path}/` : `@${path}`,
      detail: '工作区文件'
    });
  }
  return out;
}

/**
 * 投影会话候选（`SessionReferenceMentionCandidate`）。
 *
 * 【必须用上游给的 `mention`，不能自己拼 `@session:<id>`】
 * `mention` 是「可直接插入输入框」的文本，其语法由 Host 决定；
 * 自行拼装会在上游改语法时产出无法解析的提及（而错误只在发送后才暴露）。
 */
export function projectSessionReferences(value: Object | undefined): ReferenceCandidate[] {
  const out: ReferenceCandidate[] = [];
  if (value === undefined) {
    return out;
  }
  const list: Object[] | undefined = Array.isArray(value) ? value as Object[] : getArray(value, 'items');
  if (list === undefined) {
    return out;
  }
  for (let i = 0; i < list.length; i++) {
    const item: Object | undefined = list[i];
    const mention: string = readString(item, 'mention');
    if (mention.length === 0) {
      continue;
    }
    out.push({
      kind: 'session',
      label: readString(item, 'label'),
      insert: mention,
      detail: readString(item, 'cwd')
    });
  }
  return out;
}

// ═════════════════════════ 14. Host 记录（从「记住的 Host」派生） ═════════════════════════

/** 派生 Host 记录所需的输入（全部是已经发生过的事实，不含任何猜测）。 */
export interface HostProjectionInput {
  /** 上次记住的 Host 地址（**已剔除 token 的裸 URL**；空串 = 从未配置） */
  url: string;
  /** 当前是否连着 */
  connected: boolean;
  /** 已连接时 Host 的 authority（`host:port`）；未连接时传空串 */
  authority: string;
  /** 是否持有会话 cookie（= 已授权） */
  authorized: boolean;
  /** Host 核心包版本（读不到时传空串） */
  version: string;
}

/**
 * 派生「已配置 Host」列表。
 *
 * 【为什么最多一条，而且不是编的】本客户端只保存**一个**上次连接的 Host
 * （`HostStore`：地址 + 加密 token）。多 Host 管理（D1 §7.1）尚未落地，
 * 所以真实事实最多一条。旧实现在这里放了两条写死的示例 Host
 * （其中一条还标着「已授权」），那是**纯虚构**：用户会以为设备已配对，
 * 而实际根本没连过——这比空列表危险得多。
 *
 * 未配置时返回空数组，由 `ConnectPane`/`SettingsPane` 的空态文案接手。
 */
export function projectHosts(input: HostProjectionInput): HostRecord[] {
  const out: HostRecord[] = [];
  if (input.url.length === 0) {
    return out;
  }
  const isLoopback: boolean = isLoopbackUrl(input.url);
  const authority: string = input.authority.length > 0 ? input.authority : authorityOfUrl(input.url);
  return out.concat([{
    id: input.url,
    name: isLoopback ? '本机 Host' : basenameOf(authority),
    authority: authority,
    isLoopback: isLoopback,
    level: isLoopback ? 'L0 · 直连 loopback' : 'L1 · 跨设备（需配对）',
    authorized: input.authorized,
    version: input.version
  }]);
}

/**
 * 是否为 loopback 地址。
 *
 * 只认 `127.0.0.1` / `localhost` / `::1` / `[::1]`：
 * **不能**用「以 127. 开头」之类的宽松匹配，那会把 `127.0.0.1.evil.com` 判成 loopback，
 * 从而在界面上把一个远端 Host 标成「直连 loopback」——这是安全性陈述，必须精确。
 */
export function isLoopbackUrl(url: string): boolean {
  const host: string = hostOfUrl(url).toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/** 从 URL 里取 authority（`host:port`）；解析不出时返回空串。 */
export function authorityOfUrl(url: string): string {
  const start: number = url.indexOf('://');
  const rest: string = start < 0 ? url : url.substring(start + 3);
  const slash: number = firstIndexOfAny(rest, ['/', '?', '#']);
  const authority: string = slash < 0 ? rest : rest.substring(0, slash);
  const at: number = authority.lastIndexOf('@');
  return at >= 0 ? authority.substring(at + 1) : authority;
}

/** 从 URL 里取主机名（去掉端口与 IPv6 方括号）。 */
export function hostOfUrl(url: string): string {
  let authority: string = authorityOfUrl(url);
  if (authority.startsWith('[')) {
    const close: number = authority.indexOf(']');
    return close < 0 ? authority : authority.substring(0, close + 1);
  }
  const colon: number = authority.lastIndexOf(':');
  return colon < 0 ? authority : authority.substring(0, colon);
}

/** 取最早出现的分隔符位置；都不存在返回 -1。 */
function firstIndexOfAny(text: string, marks: string[]): number {
  let best: number = -1;
  for (let i = 0; i < marks.length; i++) {
    const at: number = text.indexOf(marks[i]);
    if (at >= 0 && (best < 0 || at < best)) {
      best = at;
    }
  }
  return best;
}

// ═════════════════════════ 15. 取值助手 ═════════════════════════

/** 读字符串，缺失返回空串（用于「总是要有值」的展示字段）。 */
function readString(source: Object | null | undefined, key: string): string {
  const value: string | undefined = getString(source, key);
  return value !== undefined ? value : '';
}

/** 读字符串；缺失返回 undefined（用于「缺失与空串语义不同」的字段）。 */
function optionalString(source: Object | null | undefined, key: string): string | undefined {
  return getString(source, key);
}

/** 读数字，缺失返回 0（时间戳/序号的展示兜底）。 */
function readNumber(source: Object | null | undefined, key: string): number {
  const value: number | undefined = getNumber(source, key);
  return value !== undefined ? value : 0;
}

/** 读数字；缺失返回 undefined。 */
function optionalNumber(source: Object | null | undefined, key: string): number | undefined {
  return getNumber(source, key);
}

/** 读布尔，缺失返回 false（`running`/`blank` 这类默认「否」最安全）。 */
function readBoolean(source: Object | null | undefined, key: string): boolean {
  const value: Object | undefined = getField(source, key);
  return typeof value === 'boolean' ? value as boolean : false;
}

function optionalBoolean(source: Object | null | undefined, key: string): boolean | undefined {
  const value: Object | undefined = getField(source, key);
  return typeof value === 'boolean' ? value as boolean : undefined;
}

/** 读对象字段（缺失返回空袋，避免调用方到处判 undefined）。 */
function bagOf(source: Object | null | undefined, key: string): JsonBag {
  const value: Object | undefined = getRecord(source, key);
  return value !== undefined ? value as JsonBag : emptyBag();
}

/**
 * 空字符串键袋。
 *
 * 为什么要写成函数而不是直接写 `{}`：
 *   ArkTS 的 `arkts-no-untyped-obj-literals` 禁止**无法对应到已声明类型**的字面量，
 *   而三元表达式里的 `x !== undefined ? x : {}` 中的 `{}` 正好落在这个禁区
 *   （编译器不会用「另一分支的类型」去推断它）。
 *   因此所有空值都必须由**显式标注返回类型**的工厂函数产出——
 *   这既绕开了限制，也把「空值的类型」写死在了一处。
 */
function emptyBag(): JsonBag {
  const bag: JsonBag = {};
  return bag;
}

/** 空的对象载荷（`wire` 层里 `data` / `request` / `message` 等字段的兜底值）。 */
function emptyBagObject(): JsonBag {
  const bag: JsonBag = {};
  return bag;
}

/** 空的投影提示（快照缺 `projections` 时使用；`asOfSeq = 0` 表示「游标未知」）。 */
function emptyProjectionHints(): ProjectionHints {
  return { asOfSeq: 0, values: emptyBag() };
}

/** 空的排队项数组（同样是为了避开无类型数组字面量）。 */
function emptyQueuedItems(): SessionQueuedItem[] {
  const list: SessionQueuedItem[] = [];
  return list;
}

/** 空的任务数组。 */
function emptyJobs(): SessionJob[] {
  const list: SessionJob[] = [];
  return list;
}
