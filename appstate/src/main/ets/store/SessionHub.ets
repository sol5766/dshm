/**
 * 会话中枢（SessionHub）——全应用**唯一**的连接与会话状态所有者。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 存在理由（D1 §7.7.5b，P0）：
 *   规范原文：「全应用**单一**连接池 + 单一会话状态机 + 单一待发队列；
 *   窗口只是视图，不得各自开连接或各自维护会话状态」。
 *
 *   实现依据（系统事实）：HarmonyOS 的 `specified` 启动模式会为不同 key 创建不同的
 *   UIAbility 实例，但官方文档明确这些实例是在**同一个应用进程**中创建的
 *   （见 `platform/src/main/ets/window/WindowRegistry.ets` 的窗口模型说明）。
 *   同一进程 ⇒ 模块级单例被所有窗口共享 ⇒ 把连接放这里就天然是「单一连接池」。
 *
 *   可核查性：`platform.RuntimeSingleton` 给出进程级 runtimeId 与窗口台账。
 *   诊断页展示它们；若两个窗口显示不同 runtimeId，说明单例假设被推翻，
 *   必须改跨进程方案——本文件不掩盖这种可能性。
 * ────────────────────────────────────────────────────────────────────────
 *
 * 流的所有权（精确到条数，便于抓包核对）：
 *   - 1 条物理 mux 连接（`/api/remote.mux`）
 *   - 1 条 `$events` 逻辑流（由 `Connection.start()` 持有）→ 审批/提问/通知
 *   - 1 条 `session/control` 逻辑流 → 队列/作业/投影基线
 *   - 0 或 1 条 `session/follow` 逻辑流 → 当前选中会话的轨迹
 *   切换会话时**先取消**旧的 follow，再开新的；绝不并发两条 follow。
 *
 * 数据来源纪律：
 *   本文件只做「机制 → 呈现契约」的投影，不认识 UI，也不认识上游字段细节之外的策略。
 *   上游事件名与词汇全部来自 `dshcompat`（`RemoteEvents` / `Aliases`），
 *   本文件不出现任何上游字面量。
 */

import { Connection } from 'connection';
import { SessionJob } from '../model/Jobs';
import { ConnectionState } from 'connection';
import { MAX_ATTACHMENT_BYTES } from 'platform';
import type { DiagnosticReport, EventSink, HostFacts, RemoteFailure, RpcResult, StreamSink } from 'connection';
import { EVENTS_RESULT_ENDPOINT, getArray, getBoolean, getNumber, getRecord, getString, readPath } from 'connection';
import {
  APPROVAL_ALLOWED_ONCE,
  APPROVAL_REJECTED,
  argsFor,
  classifyEventType,
  ContentSlot,
  eventShapeOf,
  EventFamily,
  EVENT_CREDENTIALS_REFERENCE_UPDATED,
  EVENT_COMMANDS_CHANGE,
  EVENT_SETTINGS_DOCUMENT_UPDATED,
  EVENT_TURN_END,
  GATEWAY_ARGUMENTS_INVALID,
  GATEWAY_INPUT_INVALID,
  GATEWAY_SIGNATURE_INVALID,
  isAuditEventType,
  isKnownEventType,
  isSessionListEvent,
  isUserAuthoredEvent,
  isConversationVisibleEvent,
  isSystemAuthoredEvent,
  mayChangeSessionTitle,
  mayChangeTurnState,
  CREDENTIALS_DESCRIBE_ENDPOINT,
  CREDENTIALS_SET_ENDPOINT,
  CREDENTIALS_UNSET_ENDPOINT,
  CREDENTIAL_REJECTED,
  MODEL_CATALOG_ENDPOINT,
  PLUGIN_INVENTORY_ENDPOINT,
  PROJECTION_TITLE,
  PROJECTION_PERMISSIONS,
  PROJECTION_SESSION_STATS,
  PROJECTION_TOKEN_USAGE,
  PROJECTION_AGENT_PRESET,
  SETTINGS_DESCRIBE_ENDPOINT,
  SETTINGS_CONFLICT,
  SETTINGS_MUTATE_ENDPOINT,
  SETTINGS_REJECTED,
  RemoteEventFrameType,
  SESSION_CANCEL_ENDPOINT,
  SESSION_CONTROL_ENDPOINT,
  SESSION_CREATE_ENDPOINT,
  SESSION_FOLLOW_ENDPOINT,
  SESSION_LIST_ENDPOINT,
  SESSION_PROMPT_ENDPOINT,
  SESSION_UPDATE_QUEUE_ENDPOINT,
  slotBinding,
  SURFACE,
  WATERFALL_APPROVAL,
  WATERFALL_QUESTION,
  WORKSPACE_CREATE_ENDPOINT,
  WORKSPACE_FOLLOW_ENDPOINT,
  WORKSPACE_DELETE_ENDPOINT,
  WORKSPACE_ARCHIVE_SESSION_ENDPOINT,
  SKILLS_LIST_ENDPOINT,
  WORKSPACE_FILES_CHANGES_ENDPOINT,
  GOALS_GET_ENDPOINT,
  MESSAGE_FEEDBACK_DELETE_ENDPOINT,
  MESSAGE_FEEDBACK_LIST_ENDPOINT,
  MESSAGE_FEEDBACK_PUT_ENDPOINT,
  AGENT_PRESETS_LIST_ENDPOINT,
  AGENT_PRESETS_COPY_ENDPOINT,
  AGENT_PRESETS_DELETE_ENDPOINT,
  AGENT_PRESETS_READ_ENDPOINT,
  LLM_LIST_PROVIDERS_ENDPOINT,
  LLM_LIST_CONFIGURABLE_PROVIDERS_ENDPOINT
} from 'dshcompat';
import type { SessionEventShape, SlotBinding } from 'dshcompat';
import { projectSessionList } from '../model/SessionList';
import {
  notifyInputForPending,
  notifyInputForTurn,
  withdrawalKeysForPending
} from '../model/Notify';
import type { NotifyInput } from '../model/Notify';
import type { SessionListItem } from '../model/SessionList';
import {
  APPROVAL_CHOICE_ALLOW,
  APPROVAL_CHOICE_ALLOW_ALWAYS,
  APPROVAL_CHOICE_DENY,
  indexOfItem,
  makeItem,
  mergeTrajectoryItem,
  PendingKind,
  RiskLevel,
  Speaker,
  ToolState,
  TrajectoryKind
} from '../model/Trajectory';
import type { PendingChoice, PendingItem, TrajectoryItem } from '../model/Trajectory';
import {
  projectCredentials,
  projectSettingsEntries,
  projectDefaultSelection,
  projectModelCatalog,
  projectPluginInventory,
  projectCredentialRefs,
  CredentialRefInfo,
  settingsMutateArgs,
  settingsUnsetArgs,
  SettingsWriteOutcome,
  splitSettingKey
} from '../model/Settings';
import {
  PIAI_SETTINGS_NS,
  piAiProtocolChoices,
  projectPiAiProviders
} from '../model/PiAiProviders';
import type { PiAiProviderView } from '../model/PiAiProviders';
import type {
  CredentialItem,
  CredentialWriteResult,
  ModelOption,
  ModelSelection,
  PluginItem,
  SettingGroup,
  SettingsGroupEntry,
  SettingsKeyParts,
  SettingsNamespaceState,
  SettingsWriteResult
} from '../model/Settings';
import {
  commandsListEndpoint,
  commandsListPayload,
  commandsExecuteEndpoint,
  commandsExecutePayload,
  sessionSelectModelEndpoint,
  sessionSelectModelPayload,
  ControlFrameType,
  filePart,
  fileReferencesEndpoint,
  fileReferencesPayload,
  fileUploadEndpoint,
  fileUploadPayload,
  projectCommands,
  projectFileReferences,
  projectFileUpload,
  projectQueuedItems,
  projectSessionPrompt,
  projectSessionReferences,
  projectSessionPage,
  sessionCursorOf,
  sessionPageEndpoint,
  sessionPagePayload,
  projectWorkspaceFailure,
  projectWorkspaceListing,
  projectWorkspaceText,
  projectWorkspaceBytes,
  promptPayload,
  PromptMode,
  queueEditAction,
  queueRemoveAction,
  queueSteerAction,
  jobsOf,
  readControlFrame,
  queuedItemsOf,
  sessionReferencesEndpoint,
  sessionReferencesPayload,
  sessionUpdateQueuePayload,
  textPart,
  workspaceListEndpoint,
  workspaceListPayload,
  workspaceReadAllEndpoint,
  workspaceReadAllPayload,
  workspaceReadEndpoint,
  workspaceReadPayload,
  WORKSPACE_ROOT_REQUEST_PATH
} from '../model/Wire';
import type {
  CommandCandidate,
  ControlFrame,
  FileUploadValue,
  PromptContentPart,
  QueuedItem,
  QueueActionBody,
  ReferenceCandidate,
  SessionPageValue,
  SessionQueuedItem,
  WorkspaceBytesWire
} from '../model/Wire';
import type { FileNode, FilePreview } from '../model/Workspace';

/** 中枢运行阶段 */
export enum HubPhase {
  /** 未配置 Host */
  IDLE = 'idle',
  /** 正在认证/连接 */
  CONNECTING = 'connecting',
  /** 已连接，事件流就绪 */
  LIVE = 'live',
  /** 连接失败或降级（仍可看缓存与会话内已有数据） */
  DEGRADED = 'degraded'
}

/** 待发队列里的一条（离线时用户已提交但尚未送达的提示词） */
export interface OutboxEntry {
  /** 客户端生成的请求 id（与 prompt 的 requestId 一致，用于去重与回执匹配） */
  requestId: string;
  sessionId: string;
  text: string;
  at: number;
}

/**
 * 已上传、等待随下一条提示词发出的附件。
 *
 * 只保留**回执**与展示信息：字节内容上传后不再需要留在端侧
 * （Host 已按内容寻址保存），留在内存里只会让大附件长期占内存。
 */
export interface PendingAttachment {
  /** 不透明回执（**会话作用域**；只对当前选中会话有效） */
  receiptId: string;
  /** 展示名（Host 消毒后的名字） */
  name: string;
  /** 精确字节数 */
  bytes: number;
  /** 推断出的 MIME（仅展示） */
  mediaType: string;
}

/** 一次添加附件的结果（UI 据此决定提示什么） */
export interface AttachOutcome {
  ok: boolean;
  name: string;
  /** 失败原因（可直接展示；成功时为空串） */
  reason: string;
}

/**
 * 通知发布钩子。
 *
 * 【为什么由**能力层**实现而不是中枢直接发通知】
 *   发系统通知需要一个 `UIAbilityContext`（授权申请、渠道创建都要它），
 *   而那只有 `EntryAbility` 持有。中枢若自己去拿 context，就会把"UI 生命周期"
 *   拖进状态层；反过来，中枢把**发生了什么**告诉能力层、由后者决定怎么发，
 *   两侧都只做自己知道的事。
 *
 * 【为什么用钩子而不是让能力层轮询快照】通知的时机是**事件**（待决项出现、
 * 轮次结束），不是状态；轮询快照需要上层自己 diff，而 diff 一旦写错就会
 * 漏通知或重复通知——都是只在锁屏上才看得见的错误。
 */
export interface NotifyHooks {
  /**
   * 出现一个待决项（审批/提问）：应立即发布一条决策类通知
   *
   * 【为什么成员写成"函数类型属性"而不是方法语法】`arkts-no-untyped-obj-literals`
   * 会拒绝把对象字面量赋给**方法语法**声明的接口（即使标注完全正确），
   * 而"函数类型属性"可以——这正是本仓库 `EventSink`/`StreamSink` 能写字面量的原因。
   */
  onPending: (input: NotifyInput) => void;
  /** 待决项已处理：撤回对应通知（按待决项自己的 kind 算键，不能按"全部 kind"撤） */
  onPendingResolved: (keys: string[]) => void;
  /** 轮次结束（完成或失败） */
  onTurn: (input: NotifyInput) => void;
}

/** 中枢快照：UI 只读它，不直接碰连接 */
export interface HubSnapshot {
  phase: HubPhase;
  hostName: string;
  authority: string;
  sessions: SessionListItem[];
  pending: PendingItem[];
  trajectory: TrajectoryItem[];
  selectedSessionId: string;
  selectedTitle: string;
  running: boolean;
  /** `$events` 是否已收到 ready 帧 */
  eventsReady: boolean;
  /** `session/control` 是否已收到 baseline 帧 */
  controlReady: boolean;
  /**
   * 是否已连上 Host（认证 + 载体验证通过），一元能力可用。
   *
   * **与 `phase === LIVE` 不是一回事**：`phase` 会因事件流终止而降级为 `DEGRADED`，
   * 那时一元调用仍然可用。视图判断「该用真实数据还是桩数据」必须用本字段——
   * 用 `phase` 会让「连上了但事件流恰好断了」的时刻又退回桩数据，等于给用户看假会话。
   */
  connected: boolean;
  /** 当前 mux 上的活动逻辑流数（诊断用；正常为 2 或 3） */
  activeStreams: number;
  /** 离线待发条数 */
  outbox: number;
  lastError: string;
  /** 协议旁路日志（诊断页；仅在开启时累积） */
  trace: string[];
  /** 未识别的上游事件类型（自证缺口：设备上跑一次就能看到真实清单） */
  unknownEventTypes: string[];
  /** 模型目录（来自 `session/modelCatalog`；未连接或能力缺失时为空数组） */
  models: ModelOption[];
  /** Host 为未配置会话准备的默认模型选择（无则 undefined，界面保持当前选择） */
  defaultSelection: ModelSelection | undefined;
  /**
   * 宿主报告的权限组合（E124）：`currentValue` 当前访问模式，`options` 可选集合。
   * 空串 / 空数组表示宿主没有投影它（那时界面不显示这一行，而不是编一个默认值）。
   */
  permissionsCurrent: string;
  permissionsOptions: string[];
  /** 会话统计与 Token 用量（E125；字段缺失一律 0，表示"没有"而不是"未探测"） */
  statsTurns: number;
  statsSteps: number;
  statsLlmMs: number;
  statsToolMs: number;
  statsTtftMs: number;
  statsTtftSteps: number;
  statsDecodeMs: number;
  statsDecodeTokens: number;
  tokensUncachedInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  /** 会话的 Agent 预设（E129；空串=宿主没投影，界面不显示） */
  agentPreset: string;
  /** 工作区注册表行（E132：带 workspaceId，删除/归档要用它；与按 cwd 派生的列表并存） */
  workspaceRows: WorkspaceRow[];
  /** 注册表全局归档集合（E132）：常规列表按它过滤，归档视图按它列出 */
  archivedSessionIds: string[];
  /** 技能清单（E135）与其读取结论（结论非空时界面必须显示它，不能假装"没有技能"） */
  skills: SkillRow[];
  skillNote: string;
  /** Agent 预设名单（E159 真机确证契约；空数组=未读到，note 说明原因） */
  presets: AgentPresetRow[];
  presetNote: string;
  /** 提供方目录（E179：已注册 + 可配置，用于'可添加'） */
  providerCatalog: string[];
  providerCatalogNote: string;
  /** 插件清单（来自 `pluginInventory/list`） */
  plugins: PluginItem[];
  /** 凭据状态（来自 `settings/describe` 取 refs + `credentials/describe` 取状态）。**永不含明文** */
  credentials: CredentialItem[];
  /** Host 设置分组（来自 `settings/describe`，每个命名空间一组） */
  settings: SettingGroup[];
  /**
   * pi-ai 的路由（= 官方 Models 页的"提供方"，含**自定义模型 API** 新建的那些）。
   *
   * 【为什么不复用 `settings` 的那组 items】`llm-pi-ai` 的 schema 根是
   * `{providers: dict}`，投影出来只有一个 `llm-pi-ai.providers` item（object），
   * 界面只能把它当一整块 JSON 编辑。官方形态是**逐字段**（显示名/端点/API 协议/模型），
   * 而且必须能**新建**路由——目录里没有的中转站只能从创建表单来。
   * 两个形态的粒度不同，所以单独投影一份。
   */
  piAiProviders: PiAiProviderView[];
  /** pi-ai 可声明的 API 协议（来自该命名空间 schema 的 `api` union；空=没读到，界面禁用选择） */
  piAiProtocols: string[];
  /**
   * 每个设置命名空间的**写状态**（`revision` 是并发令牌）。
   *
   * 为什么要暴露给界面：它是「界面上的值到底对应 Host 的哪一版」的唯一依据。
   * 写操作后 revision 必然 +1；若界面显示的 revision 没变，
   * 就说明**界面拿的是旧视图**——这类不一致不看 revision 无法察觉
   * （值恰好相同的时候尤其如此）。
   */
  settingsStates: SettingsNamespaceState[];
  /** 斜杠命令目录（**全部来自 Host**；未连接或未拉到时为空数组） */
  commands: CommandCandidate[];
  /** 长期任务目标（E242：`goals/get`；空串=该会话没有目标） */
  goalText: string;
  goalNote: string;
  /** 计划模式（E201：`plan` 投影的 active/pending） */
  planActive: boolean;
  planPending: boolean;
  /** `@` 引用候选（来自 Host 的两个候选端点；只对应当前查询串） */
  references: ReferenceCandidate[];
  /** 当前会话工作区的根层文件节点（子层挂在 `children` 上，按需加载） */
  fileNodes: FileNode[];
  /** 根层是否被上游条目上限截断 */
  fileTruncated: boolean;
  /** 当前预览的文件（未打开时为 undefined） */
  filePreview: FilePreview | undefined;
  /**
   * 已上传、等待随下一条提示词发出的附件。
   *
   * 暴露给界面而不是留在中枢内部：用户必须能看到「这条消息会带哪些附件」，
   * 否则他无法判断附件到底加上了没有——而这正是历史上那个假附件名造成的困惑。
   */
  attachments: PendingAttachment[];
  /**
   * 当前会话的**排队项**（已提交、尚未进入轮次的用户消息）。
   *
   * 与 `outbox`（离线待发队列）是**两回事**，不要合并：
   *   - `queued` 是 **Host 侧**的真实队列，用户可以对它编辑/移除/插话；
   *   - `outbox` 是**端侧**因离线而暂存的提示词，只在连接恢复后自动补发。
   * 把两者混在一个列表里会让用户对着一条"端侧暂存"的消息点"插话"，
   * 而那条消息 Host 根本还没见过。
   */
  queued: QueuedItem[];
  /**
   * 本会话的后台任务注册表（`JOBS` 控制帧 / `BASELINE` 帧）。
   *
   * 界面据 `model/Jobs` 的规则决定：要不要出现控件、怎么排、时长怎么算（纯函数，有断言）。
   */
  jobs: SessionJob[];
}

/**
 * 订阅者：**每窗口一个**（窗口只是视图）。
 *
 * 为什么是函数类型而不是 `{ onHubSnapshot(s): void }` 这样的单方法接口：
 * ArkTS 的 `arkts-no-untyped-obj-literals` 会拒绝在页面里写
 * `const l: HubListener = { onHubSnapshot: … }`（即使标注完全正确，
 * 编译器仍认为目标不是「已声明的类或接口」）。
 * 函数类型没有这个问题，而且对只有一个方法的订阅者来说更直接。
 */
export type HubSubscriber = (snapshot: HubSnapshot) => void;

/** trace 上限，避免长时间运行吃内存 */
const TRACE_LIMIT: number = 300;
/** 会话列表刷新节流（上游事件可能成串到达） */
const SESSION_REFRESH_THROTTLE_MS: number = 800;
/**
 * 设置刷新节流。
 *
 * 比列表刷新长：实测 `settings/document-updated` 在**每次**提交后都会发，
 * 包括本端自己写的那次。太短会让「本端写 → 事件 → 重拉」与写操作本身的
 * 重拉叠在一起，白白多打一次 RPC。
 */
const SETTINGS_REFRESH_THROTTLE_MS: number = 1200;
/**
 * 一元读回历史的兜底节奏与单页上限。
 *
 * 3 秒：比长连接的断线周期（约 5 秒）短，因此即使每次开流都失败，
 * 用户也能在几秒内看到内容；又不至于把一元通道打满。
 * 200 条：`session/page` 的默认单页是 50，实测传 200 也能整段取回（19 条的会话一次拿完）；
 * 去掉"翻页"这条分支能让兜底通路保持简单——它本来就是应急用的。
 */
const PAGE_FALLBACK_INTERVAL_MS: number = 3000;
const PAGE_MAX_MESSAGES: number = 200;

export class SessionHub {
  private static instance: SessionHub | undefined;

  /** 全局唯一实例（模块级单例 = 进程级单例，见文件头「实现依据」） */
  static shared(): SessionHub {
    if (SessionHub.instance === undefined) {
      SessionHub.instance = new SessionHub();
    }
    return SessionHub.instance;
  }

  private conn: Connection;
  private listeners: HubSubscriber[] = [];

  // ── 状态 ──
  private phase: HubPhase = HubPhase.IDLE;
  private hostName: string = '';
  private authority: string = '';
  private sessions: SessionListItem[] = [];
  private pendingList: PendingItem[] = [];
  private trajectoryList: TrajectoryItem[] = [];
  private selectedSessionId: string = '';
  private running: boolean = false;
  private eventsReady: boolean = false;
  private controlReady: boolean = false;
  /**
   * **一元能力是否可用**——与「事件流是否存活」解耦。
   *
   * 存在理由（真机验证发现的设计缺陷）：原先 `createSession` / `sendPrompt` 用
   * `phase === LIVE` 作为前置条件，而 `phase` 会在 `$events` 流终止时降级为 `DEGRADED`。
   * 于是「事件流死了」连带把**仍然可用**的一元调用也一起禁掉了——
   * 真机上表现为「连上了、列表能拉（`list ok 4 条`）、但点新建会话毫无反应」。
   *
   * 事实是：一元 RPC 走 HTTP，`$events` 走 WebSocket，**两者是独立的载体**，
   * 一条断了不代表另一条不能用。因此这里用一个独立的标志表示
   * 「认证与载体已就绪，一元调用可以尝试」，只在 `disconnect()` 时清除。
   * 至于调用到底成不成，交给调用本身去回答——**预判可用性比尝试更不可靠**。
   */
  private unaryReady: boolean = false;
  private lastError: string = '';
  private traceLines: string[] = [];
  /**
   * 协议旁路日志开关。
   *
   * **默认开启**（有 300 行上限，不构成内存风险）。理由：连接问题是移动端最难复现的一类，
   * 而「连上了但列表是空的」「连上几秒后掉线」这些症状**无法从界面区分原因**——
   * 必须能看到「list ok 4 条」「list fail gateway/...」「events end ...」这类原始轨迹。
   * 首次真机验证就吃了这个亏：错误只存进状态没渲染，导致「列表为空」被误读成
   * 「Host 上没有会话」。D3 §7.8 的旁路日志本就要求可查，这里只是把默认值改成开。
   */
  private traceEnabled: boolean = true;
  private unknownTypes: string[] = [];
  private outboxList: OutboxEntry[] = [];
  private models: ModelOption[] = [];
  private defaultSelection: ModelSelection | undefined = undefined;
  private plugins: PluginItem[] = [];
  private credentials: CredentialItem[] = [];
  /**
   * Host 设置分组（来自 `settings/describe`，已按命名空间分组）。
   *
   * 与 `credentials` 共享同一次 `settings/describe` 调用：一次 RPC 同时喂两个页面，
   * 而不是为了「干净」再拉一次。
   */
  private settingsGroups: SettingGroup[] = [];
  /**
   * 每个 Host 设置命名空间的写状态（**并发令牌 `revision` 的唯一副本**）。
   *
   * 为什么不能放进 `SettingItem`：revision 属于命名空间而不属于某个字段。
   * 存多份副本必然不同步——改完 A 字段后改 B 字段会带着过期 revision，恒被 Host 拒绝。
   */
  private namespaceStates: SettingsNamespaceState[] = [];
  /** pi-ai 路由视图（来自 `settings/describe` 的 `llm-pi-ai` 命名空间） */
  private piAiViews: PiAiProviderView[] = [];
  /** pi-ai 可声明协议（同上命名空间 schema 的 `api` union） */
  private piAiProtocolList: string[] = [];
  /** `settings/describe` 的顶层 `writable`（Host 是否整体接受写） */
  private describeWritable: boolean = false;
  /** 从 `settings/describe` 取到的凭据引用（`credentials/describe` 的入参） */
  private credentialRefs: CredentialRefInfo[] = [];
  /**
   * 宿主报告的**权限组合**（E124）：`currentValue` 是当前访问模式，`options` 是可选集合。
   *
   * 【用途与边界】只用于**如实显示**"当前是什么模式"。切换需要 `dsh-permission-presets`，
   * 它在端侧因依赖 shell 服务无法启用（E116），所以界面上不给可切换的假档位。
   */
  private permissionsCurrent: string = '';
  private permissionsOptions: string[] = [];
  /**
   * 会话统计与 Token 用量（E125）：官方 web 在会话里显示「N 轮 M 步」「缓存命中 X%」
   * 以及统计面板（模型用时 / 工具调用用时 / TTFT / TPS）。这些数字**早就在投影里**，
   * 我们此前只读 `title` ⇒ 界面上完全缺席。这里按结构取出来，缺字段一律按 0（不是猜，是"没有"）。
   */
  private statsTurns: number = 0;
  private statsSteps: number = 0;
  private statsLlmMs: number = 0;
  private statsToolMs: number = 0;
  private statsTtftMs: number = 0;
  private statsTtftSteps: number = 0;
  private statsDecodeMs: number = 0;
  private statsDecodeTokens: number = 0;
  private tokensUncachedInput: number = 0;
  private tokensOutput: number = 0;
  private tokensCacheRead: number = 0;
  private tokensCacheWrite: number = 0;
  /**
   * 会话的 Agent 预设（E129）：官方把它显示在**会话标题**上。
   * 预设**在会话创建时即固定**（官方原话），所以这里只读、不提供"改当前会话"的入口。
   */
  private agentPresetId: string = '';
  /**
   * 工作区**注册表**行（E132）：来自 `workspace/follow` 的基线/增量。
   *
   * 【与 `sessions` 派生的工作区列表有何不同】派生列表只有路径（由会话 `cwd` 归并），
   * 注册表行带 **`workspaceId`** —— 删除与归档都要用它，所以两者并存、用途不同。
   */
  private workspaceRows: WorkspaceRow[] = [];
  /** 注册表全局的**归档集合**（`workspace/follow` 基线与 `workspace/archiveSession` 回复都给） */
  private archivedIds: string[] = [];
  private cancelWorkspace: (() => void) | undefined = undefined;
  /** 技能清单（E135：来自 `skills/list`；失败或形状未知时为空 + 一条诊断记录） */
  private skillRows: SkillRow[] = [];
  /** 技能清单的读取结论（面向界面的一句话，空串=未读/正常） */
  private skillNote: string = '';
  /** Agent 预设名单（E159）与其读取结论 */
  private presetRows: AgentPresetRow[] = [];
  private presetNote: string = '';
  /** 提供方目录（E179）：已注册路由 + 可配置提供方 ⇒ 「可添加」的来源 */
  private providerCatalog: string[] = [];
  private providerCatalogNote: string = '';
  /**
   * 建会话时使用的**默认工作区**（E98）。
   *
   * 【为什么需要它】真机上建出来的会话 `cwd` 是 `/`（宿主进程的工作目录继承自应用进程），
   * 于是打开会话时 `session/follow` 抛 `gateway/internal …reading 'kind'`（用户看到
   * 「轨迹流失败」），`workspaceFiles/list` 也必然失败。入口脚本会把沙箱里的可写目录
   * 写进 `host-ready.json`，由页面注入到这里；**空串表示不传 `cwd`**（回到 Host 默认行为），
   * 绝不猜一个路径。
   */
  private defaultWorkspace: string = '';
  /** 已注册的工作区 id / 路径（E98；空串 = 尚未注册） */
  private workspaceId: string = '';
  private workspacePath: string = '';
  /** 斜杠命令目录（来自 `commands/list`，按当前会话的 agentId） */
  private commands: CommandCandidate[] = [];
  /** 命令目录是为哪个会话拉的（切会话后必须重拉，否则命令集是别人的） */
  private commandsFor: string = '';
  /**
   * 计划模式状态（E201：宿主计算的 `plan` 投影）。
   *
   * 官方 `ui-plan` 的 chip 判据是"**生效目标**是计划模式"=`pending ? !active : active`
   * （`pending` = 用户刚切换、等宿主确认）。我们原样读这两个布尔值，由视图层用同一条公式推导显示。
   * **没有专用端点**：切换走 `plan` 命令（命令面板已能执行，E190）。
   */
  private planActive: boolean = false;
  private planPending: boolean = false;
  /** `@` 引用候选（来自 `fileReferences/list` + `sessionReferenceResolver/candidates`） */
  private references: ReferenceCandidate[] = [];
  /** 引用候选对应的查询串（回包只对得上这个查询，用于丢弃过期回包） */
  private referencesFor: string = '';
  /** 当前工作区文件树的**根层**节点（子层挂在各自的 `children` 上） */
  private fileNodes: FileNode[] = [];
  /** 根层是否被上游截断 */
  private fileTruncated: boolean = false;
  /** 文件树对应的会话（切会话后必须重列，否则看到的是别的会话的工作区） */
  private fileTreeFor: string = '';
  /** 文件变更流的取消句柄（E226：`workspaceFiles/changes`） */
  private cancelFileChanges: (() => void) | undefined = undefined;
  /**
   * 长期任务目标（E242：官方 `ui-goal` 的目标栏数据源）。
   *
   * 契约（已核对）：`goals/get` 参数只有 `agentId`；同一族还有 `create/edit/pause/complete/clear`
   * （`agentId` + `ref`/`request`）。**回复形状未确证** ⇒ 解析容忍多种可能，都不中就把真实顶层键记账（不猜）。
   */
  private goalText: string = '';
  private goalNote: string = '';
  /** 消息级反馈（E253：`messageFeedback/list`；按 messageId 查） */
  private feedbackRows: FeedbackRow[] = [];
  private feedbackFor: string = '';
  /** 当前预览的文件（未打开时为 undefined） */
  private filePreview: FilePreview | undefined = undefined;
  /** 待发附件（回执 + 展示信息；字节不留在端侧） */
  private attachmentList: PendingAttachment[] = [];
  /** 当前会话的排队项（由 `session/control` 的 baseline 与 queue 帧驱动） */
  private queuedItems: QueuedItem[] = [];

  /**
   * 本会话的后台任务注册表（`JOBS` 控制帧 / `BASELINE` 帧里的 `jobs`）。
   *
   * 【为什么是"整份替换"】JOBS 帧给的是**当前注册表的全量**（与队列帧同理），
   * 按 id 做增量合并会引入"哪条被删了"的推断——而帧里根本没表达删除，只有新列表本身。
   */
  private jobs: SessionJob[] = [];
  /** 通知发布钩子（由 `EntryAbility` 注入；未注入时一切照常，只是不发通知） */
  private notifyHooks?: NotifyHooks;
  /** 一元读回历史的兜底轮询计时器（-1 = 未启用） */
  private pageTimer: number = -1;

  /** waterfall 待答项：eventId → 呈现项 id（应答时必须原样带回 eventId） */
  private waterfallEventIds: Map<string, string> = new Map();
  /**
   * 逻辑流的取消闭包（`Connection.openStream` 的返回值）。
   *
   * 用闭包而不是记 streamId：流的生命周期由连接层拥有，上层不该知道 streamId 的形态，
   * 也不该能凭一个陈旧 id 去取消一条已经属于别人的流。闭包天然「只能取消自己开的那条」。
   */
  private followCancel: (() => void) | undefined;
  private controlCancel: (() => void) | undefined;
  private lastRefreshAt: number = 0;
  private refreshTimer: number = -1;
  /** 设置刷新自己的节流状态（与列表刷新分开，理由见 `scheduleSettingsRefresh`） */
  private lastSettingsRefreshAt: number = 0;
  private settingsRefreshTimer: number = -1;

  private constructor() {
    this.conn = new Connection({ surface: SURFACE });
    // 【订阅必须只做一次，放在构造里】此前它写在 `connect()` 开头，
    // 而 `connect()` 会被**每次自动重连与手动重连**调用，于是每重连一次就多一个
    // 监听者：同一份降级事件被处理 N 次（N = 重连次数）。这类泄漏不会报错，
    // 只会让日志与状态更新随运行时长越来越重，属于最难在测试里发现的一类。
    this.conn.onStateChange((state: ConnectionState, detail: string) => {
      this.handleConnectionState(state, detail);
    });
  }

  // ───────────────────────── 生命周期 ─────────────────────────

  /** 配置目标 Host。返回规范化后的配置摘要（供 UI 显示 authority）。 */
  configure(address: string, name?: string): boolean {
    const cfg = this.conn.configure(address, name);
    if (cfg === undefined) {
      this.lastError = '地址无法解析：请检查形如 http://主机:端口 的写法';
      this.notify();
      return false;
    }
    this.hostName = cfg.name;
    this.authority = cfg.authority;
    this.lastError = '';
    this.notify();
    return true;
  }

  /**
   * 建立连接并按顺序打开各条流。
   *
   * 顺序有意义：先认证（拿 cookie）→ 再起 `$events`（证明网关事件源可用）
   * → 再开控制流 → 最后拉一次会话列表。
   * 任一步失败都进入 DEGRADED 而不是抛错：移动端网络随时可能不可用，
   * 降级可读比崩溃重要（D3 §4「每处失败都有建议」）。
   */
  async connect(): Promise<boolean> {
    if (this.phase === HubPhase.LIVE || this.phase === HubPhase.CONNECTING) {
      return this.phase === HubPhase.LIVE;
    }
    // 【连接状态订阅已在构造函数里做过一次】这里**不再重复订阅**：
    // 重复订阅会让同一次降级被处理多次，且随重连次数累积。
    this.phase = HubPhase.CONNECTING;
    this.lastError = '';
    this.notify();

    const auth = await this.conn.authenticate();
    if (!auth.ok) {
      this.phase = HubPhase.DEGRADED;
      this.lastError = authAdvice(auth.status, auth.reason === undefined ? '未提供原因' : auth.reason);
      this.notify();
      return false;
    }

    const sink: EventSink = {
      onReady: (facts: HostFacts) => {
        this.eventsReady = true;
        this.record(`events ready clientId=${facts.clientId.substring(0, 8)} home=${facts.home}`);
        this.notify();
      },
      onEvent: (event: Object) => {
        this.handleForwardedEvent(event);
      },
      onEnd: (error?: string) => {
        this.eventsReady = false;
        if (error !== undefined && error.length > 0) {
          this.lastError = `事件流终止：${error}`;
          this.record(`events end ${error}`);
        }
        this.phase = this.phase === HubPhase.LIVE ? HubPhase.DEGRADED : this.phase;
        this.notify();
      }
    };

    const started = await this.conn.start(sink);
    if (!started) {
      this.phase = HubPhase.DEGRADED;
      this.lastError = this.conn.getLastError() ?? '连接未建立：请检查 Host 是否在运行、令牌是否有效';
      this.notify();
      return false;
    }

    this.openControlStream();
    // E132：工作区注册表变更流——删除与归档都以它的 id 为键
    this.openWorkspaceStream();
    this.phase = HubPhase.LIVE;
    // 认证与载体已就绪：一元能力从此可用，且**不随事件流的生死变化**
    this.unaryReady = true;
    this.notify();
    await this.refreshSessions();
    // 静态事实（模型目录 / 插件清单）随后拉一次：无参只读，失败不影响连接
    await this.loadStaticFacts();
    this.flushOutbox();
    return true;
  }

  /**
   * 把底层的连接状态映射到中枢阶段。
   *
   * 【为什么映射而不是照抄】中枢的阶段是**呈现契约**（IDLE/CONNECTING/LIVE/DEGRADED），
   * 底层的状态是**载体事实**（idle/connecting/connected/disconnected）。
   * 两者不是一回事：底层 `CONNECTING` 在中枢看来是「降级（可读但实时性损失）」
   * 而不是「正在首次连接」——因为此时界面上的数据仍在、只是可能不新。
   * 直接把枚举抄过来会让界面把「重连中」显示成「首次连接中」，误导用户以为
   * 自己从没连上过。
   */
  private handleConnectionState(state: ConnectionState, detail: string): void {
    if (state === ConnectionState.CONNECTED) {
      this.record('connection connected');
      /**
       * 【必须在载体恢复后重新开流】这里曾经直接 `return`，于是**一次断线之后
       * `session/follow` 永远不会再被打开**：轨迹停在断开那一刻的内容上，
       * 用户看到的是「消息发出去了、对方永远不回」——而 Host 其实早就把这一轮算完了、
       * 结果就在它自己的日志里（实测：无订阅时 Host 仍会跑完整轮，
       * 迟到的 follow 快照里能读到 `assistant/message`）。
       * 在"约 5 秒必断"的设备上，这条缺陷会让应用**看起来完全不能执行任务**。
       */
      this.refreshSessions();
      if (this.selectedSessionId.length > 0) {
        // `selectSession` 的守卫已放宽为「同会话但流已断 ⇒ 重开」，因此这里可以安全复用
        this.selectSession(this.selectedSessionId);
      }
      return;
    }
    if (state === ConnectionState.DISCONNECTED) {
      this.phase = HubPhase.DEGRADED;
      if (this.lastError.length === 0) {
        this.lastError = detail;
      }
      this.record(`connection disconnected: ${detail}`);
      this.notify();
      return;
    }
    if (state === ConnectionState.CONNECTING && this.phase === HubPhase.LIVE) {
      // 从 LIVE 退回 CONNECTING：载体失效、正在重连 —— 中枢据此显示「降级」
      this.phase = HubPhase.DEGRADED;
      this.eventsReady = false;
      this.record(`connection degraded: ${detail}`);
      this.notify();
    }
  }

  /**
   * 手动重连（D3 §4「已断连」横幅的必需动作）。
   *
   * 【为什么自动重连之外还必须有它】自动重试的档位表**有终点**：
   * 走到「重试已耗尽」就是终态，此后不再有任何自动尝试。
   * 而问题往往只是 Host 刚重启、网络刚恢复——此时用户唯一的动作竟只能是
   * **重启应用**，这显然不合规范，也不合直觉。
   *
   * 【为什么先 `disconnect()` 而不是直接 `connect()`】`connect()` 在
   * `CONNECTING` 时会早退（避免并发连接），而「重试耗尽」后底层可能还留着
   * 半死的 socket 与探活计时器。先显式停干净再重来，重连路径只有一条，
   * 不会出现「旧的探活计时器把新连接判死」这种交叉。
   */
  async reconnect(): Promise<boolean> {
    this.record('手动重连');
    await this.disconnect();
    return await this.connect();
  }

  /** 断开并释放所有流（仅一个窗口会调用；其他窗口只订阅快照） */
  async disconnect(): Promise<void> {    this.cancelFollow();
    this.cancelControl();
    await this.conn.stop();
    this.phase = HubPhase.IDLE;
    this.eventsReady = false;
    this.controlReady = false;
    this.unaryReady = false;
    this.record('connection stopped');
    this.notify();
  }

  private cancelFollow(): void {
    const cancel: (() => void) | undefined = this.followCancel;
    this.followCancel = undefined;
    if (cancel !== undefined) {
      cancel();
    }
    // 取消之后若仍选中着会话，一元兜底应当接管（否则切会话会留下一个空白的会话页）
    this.ensurePageFallback();
  }

  private cancelControl(): void {
    const cancel: (() => void) | undefined = this.controlCancel;
    this.controlCancel = undefined;
    if (cancel !== undefined) {
      cancel();
    }
  }

  // ───────────────────────── 订阅 ─────────────────────────

  subscribe(listener: HubSubscriber): void {
    this.listeners.push(listener);
    listener(this.snapshot());
  }

  unsubscribe(listener: HubSubscriber): void {
    const next: HubSubscriber[] = [];
    for (let i = 0; i < this.listeners.length; i++) {
      if (this.listeners[i] !== listener) {
        next.push(this.listeners[i]);
      }
    }
    this.listeners = next;
  }

  snapshot(): HubSnapshot {
    return {
      phase: this.phase,
      hostName: this.hostName,
      authority: this.authority,
      sessions: this.sessions,
      pending: this.pendingList,
      trajectory: this.trajectoryList,
      selectedSessionId: this.selectedSessionId,
      selectedTitle: this.titleOf(this.selectedSessionId),
      running: this.running,
      eventsReady: this.eventsReady,
      controlReady: this.controlReady,
      connected: this.unaryReady,
      activeStreams: this.activeStreamCount(),
      outbox: this.outboxList.length,
      lastError: this.lastError,
      trace: this.traceLines,
      unknownEventTypes: this.unknownTypes,
      models: this.models,
      defaultSelection: this.defaultSelection,
      permissionsCurrent: this.permissionsCurrent,
      permissionsOptions: this.permissionsOptions,
      statsTurns: this.statsTurns,
      statsSteps: this.statsSteps,
      statsLlmMs: this.statsLlmMs,
      statsToolMs: this.statsToolMs,
      statsTtftMs: this.statsTtftMs,
      statsTtftSteps: this.statsTtftSteps,
      statsDecodeMs: this.statsDecodeMs,
      statsDecodeTokens: this.statsDecodeTokens,
      tokensUncachedInput: this.tokensUncachedInput,
      tokensOutput: this.tokensOutput,
      tokensCacheRead: this.tokensCacheRead,
      tokensCacheWrite: this.tokensCacheWrite,
      agentPreset: this.agentPresetId,
      workspaceRows: this.workspaceRows,
      archivedSessionIds: this.archivedIds,
      skills: this.skillRows,
      skillNote: this.skillNote,
      presets: this.presetRows,
      presetNote: this.presetNote,
      providerCatalog: this.providerCatalog,
      providerCatalogNote: this.providerCatalogNote,
      plugins: this.plugins,
      credentials: this.credentials,
      settings: this.settingsGroups,
      settingsStates: this.namespaceStates,
      piAiProviders: this.piAiViews,
      piAiProtocols: this.piAiProtocolList,
      commands: this.commands,
      goalText: this.goalText,
      goalNote: this.goalNote,
      planActive: this.planActive,
      planPending: this.planPending,
      references: this.references,
      fileNodes: this.fileNodes,
      fileTruncated: this.fileTruncated,
      filePreview: this.filePreview,
      attachments: this.attachmentList,
      queued: this.queuedItems,
      jobs: this.jobs
    };
  }

  private notify(): void {
    const snap: HubSnapshot = this.snapshot();
    for (let i = 0; i < this.listeners.length; i++) {
      this.listeners[i](snap);
    }
  }

  /** 活动逻辑流数：控制流 + follow（`$events` 由连接层持有，单独看 eventsReady） */
  private activeStreamCount(): number {
    let n: number = 0;
    if (this.eventsReady) {
      n++;
    }
    if (this.controlCancel !== undefined) {
      n++;
    }
    if (this.followCancel !== undefined) {
      n++;
    }
    return n;
  }

  setTraceEnabled(on: boolean): void {
    this.traceEnabled = on;
    this.notify();
  }

  // ───────────────────────── 上游事件处理 ─────────────────────────

  /**
   * 处理一条 `$events` 转发事件。
   *
   * 帧判别（`dshcompat.RemoteEventFrameType`）：`ready` / `emit` / `waterfall` / `cancel`。
   * `emit` 是单向通知，`waterfall` 需要应答（审批与提问走这条）。
   */
  private handleForwardedEvent(raw: Object): void {
    const type: string = getString(raw, 'type') ?? '';
    if (type === RemoteEventFrameType.READY) {
      this.eventsReady = true;
      this.notify();
      return;
    }
    if (type === RemoteEventFrameType.WATERFALL) {
      this.handleWaterfall(raw);
      return;
    }
    if (type === RemoteEventFrameType.CANCEL) {
      // 另一端已处理：撤回卡片与通知（D3 §6「通知去重」、POC-8 步骤 4）
      const eventId: string = getString(raw, 'eventId') ?? '';
      this.resolvePendingById(eventId, '已由其他端处理');
      return;
    }
    if (type === RemoteEventFrameType.EMIT) {
      const name: string = getString(raw, 'event') ?? '';
      this.record(`emit ${name}`);
      // 通知类事件只需触发一次「重新拉取」；具体投影由各页各自负责，
      // 中枢只维护会话列表这一项（它被多个页面共享）。
      if (isSessionListEvent(name)) {
        this.scheduleSessionRefresh();
      }
      // 设置文档 / 凭据引用被别的客户端（或 Host 自身）改了：拉一次最新状态。
      //
      // 【为什么必须处理这两条事件】`settings/describe` 是**读一次就冻结**的快照。
      // 不接它们时，另一个窗口或另一台设备改了设置，本端界面会一直显示旧值，
      // 而且**正在编辑的 revision 已经过期**——用户改一次撞一次
      // `settings/conflict`，却看不出为什么。
      // `credentials/reference-updated` 同理：别的客户端新增/删除凭据后，
      // 本端的 refs 列表（它只来自 `settings/describe`）会多一项或少一项。
      //
      // 【为什么要节流】实测 `settings/document-updated` 在每次提交后都会发
      // （**包括本端自己写的那次**）。不节流会与写操作自身的重拉叠在一起，
      // 白白多打一次 RPC。节流让一串连改合并成一次读取。
      if (name === EVENT_SETTINGS_DOCUMENT_UPDATED || name === EVENT_CREDENTIALS_REFERENCE_UPDATED) {
        this.scheduleSettingsRefresh();
      }
      // 命令目录是插件装的：插件启用/禁用后命令集会变。上游为此发了
      // `commands/change`。不接它，用户会一直看到一批已经失效的命令。
      if (name === EVENT_COMMANDS_CHANGE) {
        this.refreshCommands();
      }
      return;
    }
    this.noteUnknown(`events:${type}`);
  }

  /** 处理 waterfall（审批/提问）——客户端价值的核心路径 */
  private handleWaterfall(raw: Object): void {
    const event: string = getString(raw, 'event') ?? '';
    const eventId: string = getString(raw, 'eventId') ?? '';
    const agentId: string = getString(raw, 'agentId') ?? '';
    const request: Object | undefined = getRecord(raw, 'request');
    if (eventId.length === 0 || request === undefined) {
      this.noteUnknown(`waterfall:${event}:malformed`);
      return;
    }

    if (event === WATERFALL_APPROVAL) {
      this.addApprovalPending(eventId, agentId, request);
      return;
    }
    if (event === WATERFALL_QUESTION) {
      this.addQuestionPending(eventId, agentId, request);
      return;
    }
    // 白名单里将来可能新增 waterfall：不认识就**交还给 Host 链条**，
    // 绝不假装处理（假装会让 Host 以为有人答了，实际没人答）。
    this.declineToHandle(eventId);
    this.noteUnknown(`waterfall:${event}`);
  }

  private addApprovalPending(eventId: string, agentId: string, request: Object): void {
    const toolName: string = getString(request, 'toolName') ?? '未知操作';
    const reason: string = getString(request, 'reason') ?? '';
    const callId: string = getString(request, 'callId') ?? '';

    const item: PendingItem = {
      id: eventId,
      kind: PendingKind.APPROVAL,
      // agentId 在根会话上等于会话 id（实测形态待真机审批场景确认，见 D4 POC-8）
      sessionId: agentId,
      sessionTitle: this.titleOf(agentId),
      title: toolName,
      detail: reason,
      raw: JSON.stringify(request),
      risk: riskOfTool(toolName),
      choices: approvalChoices(),
      multiSelect: false,
      allowFreeText: false,
      at: Date.now()
    };
    this.upsertPending(item);
    this.waterfallEventIds.set(eventId, eventId);
    this.record(`waterfall approval eventId=${eventId.substring(0, 8)} tool=${toolName} callId=${callId.length > 0 ? callId.substring(0, 8) : '-'}`);
  }

  private addQuestionPending(eventId: string, agentId: string, request: Object): void {
    const questions: Object[] | undefined = getArray(request, 'questions');
    if (questions === undefined || questions.length === 0) {
      // 没有问题的请求无法呈现：交还链条比造一张空卡片更正确
      this.declineToHandle(eventId);
      this.noteUnknown(`waterfall:${WATERFALL_QUESTION}:no-questions`);
      return;
    }
    const first: Object = questions[0];
    const qid: string = getString(first, 'id') ?? 'q0';
    const text: string = getString(first, 'question') ?? '';
    const detail: string = getString(first, 'detail') ?? '';
    const header: string = getString(first, 'header') ?? '';
    const multi: boolean = getBoolean(first, 'multiSelect') === true;

    const choices: PendingChoice[] = [];
    const options: Object[] | undefined = getArray(first, 'options');
    if (options !== undefined) {
      for (let i = 0; i < options.length; i++) {
        const opt: Object = options[i];
        choices.push({
          id: getString(opt, 'label') ?? `option-${i}`,
          label: getString(opt, 'label') ?? `选项 ${i + 1}`,
          detail: getString(opt, 'description') ?? ''
        });
      }
    }

    const item: PendingItem = {
      // 同一 waterfall 可能带多个问题：用 eventId + 问题 id 组合，应答时按 question id 回填
      id: `${eventId}#${qid}`,
      kind: PendingKind.QUESTION,
      sessionId: agentId,
      sessionTitle: this.titleOf(agentId),
      title: text.length > 0 ? text : (header.length > 0 ? header : '需要你回答'),
      detail: detail,
      raw: JSON.stringify(first),
      risk: RiskLevel.NORMAL,
      choices: choices,
      multiSelect: multi,
      allowFreeText: true,
      at: Date.now()
    };
    this.upsertPending(item);
    this.waterfallEventIds.set(eventId, item.id);
    this.record(`waterfall question eventId=${eventId.substring(0, 8)} qid=${qid} options=${choices.length} multi=${multi}`);
  }

  // ───────────────────────── 应答（核心价值路径） ─────────────────────────

  /**
   * 答复审批。
   *
   * 词汇纪律（`dshcompat.APPROVAL_OUTCOMES`）：上游只有 `allowed-once` / `rejected` /
   * `cancelled` / `unavailable`，**没有**「始终允许」。
   * 因此 `allowAlways` 在当前实现里只影响**本地**不再重复打扰的策略，
   * 发到 Host 的仍然是 `allowed-once`——绝不伪造一个上游不认识的词。
   */
  async decideApproval(pendingId: string, allow: boolean, allowAlways: boolean): Promise<boolean> {
    const outcome: string = allow ? APPROVAL_ALLOWED_ONCE : APPROVAL_REJECTED;
    if (allowAlways) {
      this.record('注意：上游无持久授权词汇，本次仍按 allowed-once 上报');
    }
    const ok: boolean = await this.answerWaterfall(pendingId, outcome);
    if (ok) {
      this.resolvePending(pendingId, allow ? '已允许' : '已拒绝');
    }
    return ok;
  }

  /** 答复提问（结构化答案：选中项 + 可选自由文本） */
  async answerQuestion(pendingId: string, selected: string[], custom: string): Promise<boolean> {
    const hash: number = pendingId.indexOf('#');
    const eventId: string = hash > 0 ? pendingId.substring(0, hash) : pendingId;
    const qid: string = hash > 0 ? pendingId.substring(hash + 1) : 'q0';
    const answers: Object[] = [];
    const one: Record<string, Object> = {};
    one['id'] = qid;
    one['selected'] = selected;
    if (custom.length > 0) {
      one['custom'] = custom;
    }
    answers.push(one as Object);
    const value: Record<string, Object> = {};
    value['answers'] = answers;
    const ok: boolean = await this.answerWithResultValue(eventId, value as Object);
    if (ok) {
      this.resolvePending(pendingId, '已回答');
    }
    return ok;
  }

  /**
   * 明确「我不处理这一条」，把它交还 Host 的应答者链条。
   *
   * 这是 waterfall 语义允许的**正确**回应之一，也是我们处理未知 waterfall 事件的唯一
   * 正当做法：`{kind:'next'}` 让 Host 继续问下一个应答者。
   * 相比之下「回一个空结果」会让 Host 认为已有人答了，从而丢掉这次审批。
   */
  async declineToHandle(eventId: string): Promise<boolean> {
    const outcome: Record<string, Object> = {};
    outcome['kind'] = 'next';
    return await this.sendEventResult(eventId, outcome as Object);
  }

  private async answerWaterfall(pendingId: string, outcomeValue: string): Promise<boolean> {
    const value: Record<string, Object> = {};
    value['value'] = outcomeValue;
    return await this.answerWithResultValue(pendingId, value as Object);
  }

  /**
   * 发送 `$events/result`。
   *
   * 参数是**扁平**的 `{clientId, eventId, outcome}`（实测：上游
   * `parseRemoteEventResult(payload.args)` 直接读 args，没有 `request` 包装层）。
   * `clientId` 来自 `$events` 的 ready 帧，必须与当前那次事件流 generation 一致——
   * 重连后 clientId 会变，用旧值会被 Host 拒绝（`identifies no active event stream`）。
   * 因此这里每次都向连接层现取。
   */
  private async answerWithResultValue(eventId: string, value: Object): Promise<boolean> {
    if (eventId.length === 0) {
      return false;
    }
    const outcome: Record<string, Object> = {};
    outcome['kind'] = 'result';
    outcome['value'] = value;
    return await this.sendEventResult(eventId, outcome as Object);
  }

  private async sendEventResult(eventId: string, outcome: Object): Promise<boolean> {
    const clientId: string | undefined = this.conn.getHostFactsClientId();
    if (clientId === undefined || clientId.length === 0) {
      this.lastError = '事件流尚未就绪，无法应答；请等待连接恢复后重试';
      this.notify();
      return false;
    }
    const args: Record<string, Object> = {};
    args['clientId'] = clientId;
    args['eventId'] = eventId;
    args['outcome'] = outcome;

    const result: RpcResult = await this.conn.call(EVENTS_RESULT_ENDPOINT, args as Object);
    if (result.ok) {
      this.record(`result ok eventId=${eventId.substring(0, 8)}`);
      return true;
    }
    const failure = result.error;
    const code: string = failure === undefined ? 'unknown' : failure.code;
    const message: string = failure === undefined ? '应答未被 Host 接受' : failure.message;
    this.lastError = `应答失败：${code} ${message}`;
    this.record(`result fail ${code}`);
    this.notify();
    return false;
  }

  // ───────────────────────── 会话与轨迹 ─────────────────────────

  /**
   * 拉取「静态事实」：模型目录 + 插件清单。
   *
   * 这两个端点是**无参只读**的（参数形态 `NONE`，实测可用，见 D2 §8.7.2），
   * 因此可以在连接建立后无条件拉一次，作为模型页/插件页的真实数据来源。
   *
   * 失败不抛也不阻断连接：能力缺失（老 Host 没有这些端点）应当表现为
   * 「对应页面为空 + 可解释」，而不是让整个连接失败。
   */
  async loadStaticFacts(): Promise<void> {
    const empty: Record<string, Object> = {};

    const catalogArgs: Object | undefined = argsFor(MODEL_CATALOG_ENDPOINT, empty as Object);
    if (catalogArgs !== undefined) {
      const result: RpcResult = await this.conn.call(MODEL_CATALOG_ENDPOINT, catalogArgs);
      if (result.ok) {
        this.models = projectModelCatalog(result.value);
        this.defaultSelection = projectDefaultSelection(result.value);
        this.record(`modelCatalog ok ${this.models.length} 个模型`);
      } else {
        const f = result.error;
        this.record(`modelCatalog fail ${f === undefined ? '?' : f.code}`);
      }
    }

    const pluginArgs: Object | undefined = argsFor(PLUGIN_INVENTORY_ENDPOINT, empty as Object);
    if (pluginArgs !== undefined) {
      const result: RpcResult = await this.conn.call(PLUGIN_INVENTORY_ENDPOINT, pluginArgs);
      if (result.ok) {
        this.plugins = projectPluginInventory(result.value);
        this.record(`pluginInventory ok ${this.plugins.length} 个条目`);
      } else {
        const f = result.error;
        this.record(`pluginInventory fail ${f === undefined ? '?' : f.code}`);
      }
    }

    // 凭据：两跳。第一跳 settings/describe 拿 refs（credentials/describe 没有「列出全部」模式），
    // 第二跳 credentials/describe 拿状态。**任何一跳失败都只是让凭据页为空**，
    // 绝不因此把整个连接判为失败。
    const settingsArgs: Object | undefined = argsFor(SETTINGS_DESCRIBE_ENDPOINT, empty as Object);
    if (settingsArgs !== undefined) {
      const described: RpcResult = await this.conn.call(SETTINGS_DESCRIBE_ENDPOINT, settingsArgs);
      if (described.ok) {
        // 同一次回复同时喂设置页与凭据页：两者都来自 settings/describe，
        // 再拉一次只为了「一个函数做一件事」是浪费一次 RPC。
        this.applySettingsDescribe(described.value);
        const refs: CredentialRefInfo[] = this.credentialRefs;
        let itemCount: number = 0;
        for (let i = 0; i < this.settingsGroups.length; i++) {
          itemCount += this.settingsGroups[i].items.length;
        }
        this.record(`settings/describe ok, ${refs.length} 个凭据引用, ${itemCount} 个设置项`);
        if (refs.length > 0) {
          const credArgs: Record<string, Object> = {};
          credArgs['refs'] = this.refNames(refs);
          const creds: RpcResult = await this.conn.call(CREDENTIALS_DESCRIBE_ENDPOINT, credArgs as Object);
          if (creds.ok) {
            this.credentials = projectCredentials(creds.value, refs);
            this.record(`credentials ok ${this.credentials.length} 条`);
          } else {
            const f = creds.error;
            this.record(`credentials fail ${f === undefined ? '?' : f.code}`);
          }
        } else {
          // 该 Host 没有任何声明了 secret 的命名空间：这是**正常状态**，不是失败
          this.credentials = [];
        }
      } else {
        const f = described.error;
        this.record(`settings/describe fail ${f === undefined ? '?' : f.code}`);
      }
    }

    this.notify();
  }

  /**
   * 节流地重新读取设置。
   *
   * 与 `scheduleSessionRefresh` 同样的形状，但用**独立的计时器与时间戳**：
   * 两类刷新由不同事件驱动、频率也不同（设置改动远少于会话活动）。
   * 共用一个时间戳会让「刚刷过会话列表」把设置刷新一起压掉——
   * 表现为另一个客户端改了设置而本端半天不动。
   */
  private scheduleSettingsRefresh(): void {
    const now: number = Date.now();
    if (now - this.lastSettingsRefreshAt < SETTINGS_REFRESH_THROTTLE_MS) {
      if (this.settingsRefreshTimer !== -1) {
        return;
      }
      const wait: number = SETTINGS_REFRESH_THROTTLE_MS - (now - this.lastSettingsRefreshAt);
      this.settingsRefreshTimer = setTimeout(() => {
        this.settingsRefreshTimer = -1;
        this.lastSettingsRefreshAt = Date.now();
        this.refreshSettings();
      }, wait);
      return;
    }
    this.lastSettingsRefreshAt = now;
    this.refreshSettings();
  }

  /**
   * 写入一个 Host 设置项（`settings/mutate`，按路径 set 单个字段）。
   *
   * 【为什么必须带 `expectedRevision`】上游把「并发写」做成一种**独立结果**
   * （`settings/conflict{expected, actual}`），而不是静默后写覆盖先写。
   * 省略 revision 等于放弃这个保护：两个客户端同时改同一命名空间时，
   * 后提交的人会**无声地抹掉**前一个人的改动。
   *
   * 冲突的处置是**重新读取后再改**，不是重试同一请求——重试必然再次失败，
   * 用户看到的是「点了没反应」。因此冲突分支会主动刷新设置并给出这句建议。
   *
   * @param key - 设置项 key（`ns.field`）
   * @param value - 新值（布尔 / 字符串 / 数字，按 schema 类型由调用方给对）
   * @returns 面向界面的结果（含可执行建议）
   */
  async writeSetting(key: string, value: Object): Promise<SettingsWriteResult> {
    const parts: SettingsKeyParts | undefined = splitSettingKey(key);
    if (parts === undefined) {
      return {
        outcome: SettingsWriteOutcome.FAILED, actualRevision: -1,
        message: `设置项标识「${key}」无法解析出命名空间，已拒绝写入（这属于本客户端的缺陷，请提交诊断报告）。`
      };
    }
    const state: SettingsNamespaceState | undefined = this.namespaceState(parts.ns);
    if (state === undefined) {
      return {
        outcome: SettingsWriteOutcome.FAILED, actualRevision: -1,
        message: `Host 上没有名为「${parts.ns}」的设置命名空间，已拒绝写入。请重新连接以刷新设置清单。`
      };
    }
    if (!state.writable) {
      return {
        outcome: SettingsWriteOutcome.REJECTED, actualRevision: state.revision,
        message: 'Host 不接受对这项设置的写入（可能是只读来源，例如环境变量或文件基线）。'
      };
    }
    if (!this.unaryReady) {
      return {
        outcome: SettingsWriteOutcome.FAILED, actualRevision: state.revision,
        message: '尚未连接 Host，改动没有生效。请先完成连接后重试。'
      };
    }

    const args: Object = settingsMutateArgs(parts.ns, parts.fieldPath, value, state.revision);
    const result: RpcResult = await this.conn.call(SETTINGS_MUTATE_ENDPOINT, args);
    if (result.ok) {
      // 【为什么写成功后要整页重拉，而不是用回复里的视图局部替换】
      //   局部替换只在「界面当前持有的视图确实来自 Host」时才安全。
      //   而写操作前后可能已经被其它刷新（定时列表刷新、事件触发的重载）改过
      //   `settingsGroups`，此时局部替换会把旧的分组原样保留下来——
      //   表现就是「Host 说写入成功、界面值却没变」，而且**不报错**。
      //   实测就踩到了：写了两次，第二次界面仍显示旧值。
      //   整页重拉的代价是一次 RPC；换来的是「界面一定等于 Host 的当前状态」这个不变量。
      await this.refreshSettings();
      this.record(`settings/mutate ok ${key}`);
      this.notify();
      return {
        outcome: SettingsWriteOutcome.OK, actualRevision: this.namespaceState(parts.ns) === undefined
          ? state.revision : (this.namespaceState(parts.ns) as SettingsNamespaceState).revision,
        message: `已写入 ${key}。`
      };
    }

    const failure: RemoteFailure | undefined = result.error;
    const code: string = failure === undefined ? 'unknown' : failure.code;
    if (code === SETTINGS_CONFLICT) {
      const actual: number = this.conflictActualRevision(failure);
      this.record(`settings/mutate conflict ${key} expected=${state.revision} actual=${actual}`);
      // 冲突后必须刷新：用户手上的界面已经过期，让他们在旧值上继续改只会连撞冲突
      await this.refreshSettings();
      return {
        outcome: SettingsWriteOutcome.CONFLICT, actualRevision: actual,
        message: '这项设置已被其他客户端改过，你的界面是旧的。已为你重新读取最新值，请确认后再改一次。'
      };
    }
    if (code === SETTINGS_REJECTED) {
      this.record(`settings/mutate rejected ${key}`);
      await this.refreshSettings();
      return {
        outcome: SettingsWriteOutcome.REJECTED, actualRevision: state.revision,
        message: 'Host 拒绝了这个值（可能不符合该设置的类型或取值范围）。已重新读取最新值，请检查后重试。'
      };
    }
    this.record(`settings/mutate fail ${key} ${code}`);
    return {
      outcome: SettingsWriteOutcome.FAILED, actualRevision: state.revision,
      message: `写入未生效：${friendlyFailure(code, failure === undefined ? '' : failure.message)}`
    };
  }

  /**
   * 删除一个 Host 设置项在**用户层**的取值（`settings/mutate` 的 `unset`）。
   *
   * 语义是「恢复默认」而不是「清空」：实测该键的用户层被移除后，
   * 值回落到 schema 默认（`.research/protocol/probe-deep-path.mjs`）。
   * 这一点必须在界面文案上说清——用户以为自己在清空、实际在恢复默认
   * （或反过来）都会造成困惑。
   */
  async unsetSetting(key: string): Promise<SettingsWriteResult> {
    const parts: SettingsKeyParts | undefined = splitSettingKey(key);
    if (parts === undefined) {
      return {
        outcome: SettingsWriteOutcome.FAILED, actualRevision: -1,
        message: `设置项标识「${key}」无法解析出命名空间，已拒绝操作。`
      };
    }
    const state: SettingsNamespaceState | undefined = this.namespaceState(parts.ns);
    if (state === undefined) {
      return {
        outcome: SettingsWriteOutcome.FAILED, actualRevision: -1,
        message: `Host 上没有名为「${parts.ns}」的设置命名空间。请重新连接以刷新设置清单。`
      };
    }
    if (!state.writable) {
      return {
        outcome: SettingsWriteOutcome.REJECTED, actualRevision: state.revision,
        message: 'Host 不接受对这项设置的写入（可能是只读来源）。'
      };
    }
    if (!this.unaryReady) {
      return {
        outcome: SettingsWriteOutcome.FAILED, actualRevision: state.revision,
        message: '尚未连接 Host，未做改动。请先完成连接后重试。'
      };
    }
    const args: Object = settingsUnsetArgs(parts.ns, parts.fieldPath, state.revision);
    const result: RpcResult = await this.conn.call(SETTINGS_MUTATE_ENDPOINT, args);
    if (result.ok) {
      await this.refreshSettings();
      this.record(`settings/unset ok ${key}`);
      this.notify();
      return { outcome: SettingsWriteOutcome.OK, actualRevision: state.revision, message: `已恢复 ${key} 的默认值。` };
    }
    const failure: RemoteFailure | undefined = result.error;
    const code: string = failure === undefined ? 'unknown' : failure.code;
    if (code === SETTINGS_CONFLICT) {
      const actual: number = this.conflictActualRevision(failure);
      this.record(`settings/unset conflict ${key} expected=${state.revision} actual=${actual}`);
      await this.refreshSettings();
      return {
        outcome: SettingsWriteOutcome.CONFLICT, actualRevision: actual,
        message: '这项设置已被其他客户端改过，你的界面是旧的。已重新读取最新值，请确认后再操作。'
      };
    }
    if (code === SETTINGS_REJECTED) {
      this.record(`settings/unset rejected ${key}`);
      await this.refreshSettings();
      return {
        outcome: SettingsWriteOutcome.REJECTED, actualRevision: state.revision,
        message: 'Host 拒绝了这个操作（该键可能不允许删除，或是必填项）。已重新读取最新值。'
      };
    }
    this.record(`settings/unset fail ${key} ${code}`);
    return {
      outcome: SettingsWriteOutcome.FAILED, actualRevision: state.revision,
      message: `未生效：${friendlyFailure(code, failure === undefined ? '' : failure.message)}`
    };
  }

  /**
   * 设置**默认模型**（E96，对齐官方 web）。
   *
   * 【为什么是这三个字段】`settings/describe` 里 `agent-default-model` 是一个**结构化命名空间**：
   * `{"provider": string(required), "model": string(required), "reasoningEffort": string}`，
   * `value/base/user` 三层合并。它不像其它命名空间那样暴露成一串"设置项"，
   * 所以设置页的通用渲染看不到它——**这就是模型页此前"选不了模型"的根因**。
   *
   * 【为什么分三次写】上游 `settings/mutate` 的语义就是"一次一个字段的 set"
   * （官方的编辑卡片也是每个改动字段一次 set）。每次失败都**如实回报**，
   * 不做乐观更新：半写成功的状态由 Host 的 revision 与随后的 describe 兜住。
   *
   * 【推理强度为什么跟模型一起写】它是**模型的能力**（`reasoningEfforts` 因模型而异），
   * 换模型时把旧档位带过去可能不被接受，所以调用方应在换模型时给出该模型支持的档位。
   */
  async setDefaultModel(provider: string, model: string, effort: string): Promise<string> {
    if (provider.length === 0 || model.length === 0) {
      return '未选择模型：provider 与 model 都不能为空。';
    }
    const fields: string[] = ['provider', 'model'];
    const values: string[] = [provider, model];
    if (effort.length > 0) {
      fields.push('reasoningEffort');
      values.push(effort);
    }
    const done: string[] = [];
    for (let i = 0; i < fields.length; i++) {
      const res: SettingsWriteResult = await this.writeSetting(`agent-default-model.${fields[i]}`, values[i]);
      if (res.outcome !== SettingsWriteOutcome.OK) {
        this.lastError = res.message;
        this.notify();
        return `默认模型只写成了 ${done.length > 0 ? done.join('、') : '0'} 个字段：${res.message}`;
      }
      done.push(fields[i]);
    }
    // 默认模型变了 ⇒ 模型目录里的 defaultSelection 也会变：重拉静态事实让界面同步
    await this.loadStaticFacts();
    this.record(`默认模型 → ${provider}/${model}${effort.length > 0 ? ` · ${effort}` : ''}`);
    this.notify();
    return `默认模型已设为 ${provider} / ${model}${effort.length > 0 ? ` · 推理强度 ${effort}` : ''}。新会话会用它。`;
  }

  /** 重新拉一次 `settings/describe`（只刷新设置页与凭据，不做其它副作用） */
  async refreshSettings(): Promise<void> {    const empty: Record<string, Object> = {};
    const args: Object | undefined = argsFor(SETTINGS_DESCRIBE_ENDPOINT, empty as Object);
    if (args === undefined) {
      return;
    }
    const described: RpcResult = await this.conn.call(SETTINGS_DESCRIBE_ENDPOINT, args);
    if (!described.ok) {
      return;
    }
    this.applySettingsDescribe(described.value);
    this.notify();
  }

  /**
   * 写入一份凭据（`credentials/set`）。
   *
   * 【本客户端**绝不保存**这份明文】它只在一次 `set` 调用里存在，
   * 之后立刻从内存里消失（D1 §11.5 S3/S4：端侧不保存也不显示明文值）。
   * 真正持有它的是 Host 的凭据存储。
   *
   * 【成功回复是 `{ok:true}`——没有 `value` 键】不能用「有没有 value」判成败：
   * 那会把每一次成功都判为畸形响应（D2b §4.1 / D2 §8.7.6 缺陷 2）。
   * 解析层已按键存在性处理，这里只看 `result.ok`。
   *
   * @param ref - 凭据引用（实测编码：`path.join('.')`，**不带命名空间前缀**）
   * @param value - 明文值；调用方用完即弃，不要存进任何状态
   */
  async setCredential(ref: string, value: string): Promise<CredentialWriteResult> {
    if (ref.length === 0 || value.length === 0) {
      return { ok: false, message: '凭据引用或值不能为空。' };
    }
    if (!this.unaryReady) {
      return { ok: false, message: '尚未连接 Host，值没有写入。请先完成连接后重试。' };
    }
    const args: Record<string, Object> = {};
    args['ref'] = ref;
    args['value'] = value;
    const result: RpcResult = await this.conn.call(CREDENTIALS_SET_ENDPOINT, args as Object);
    if (result.ok) {
      // 写完立刻回读状态：界面要显示的是**Host 的实际状态**，
      // 而不是「我们认为写成功了」。实测 `source` 会变成写入目标（如 `file`）。
      await this.refreshCredentials();
      this.record(`credentials/set ok ${ref} 快照已配置=${this.countConfiguredCredentials()}`);
      this.notify();
      return { ok: true, message: `已写入 ${ref}。明文没有留在本机。` };
    }
    const failure: RemoteFailure | undefined = result.error;
    const code: string = failure === undefined ? 'unknown' : failure.code;
    this.record(`credentials/set fail ${ref} ${code}`);
    if (code === CREDENTIAL_REJECTED) {
      // 上游只回传 `ref`，不回传任何值——这里也不能把它打印出来
      return {
        ok: false,
        message: `${ref} 被 Host 拒绝：可能是只读来源（例如环境变量）遮蔽了这个引用。`
          + '请在 Host 侧检查该引用的来源后重试。'
      };
    }
    return { ok: false, message: `写入未生效：${friendlyFailure(code, failure === undefined ? '' : failure.message)}` };
  }

  /**
   * 按**路径**写一个设置命名空间里的值（`settings/mutate` 的 `set`）。
   *
   * 【为什么不能复用 `writeSetting(key, value)`】那个接口的 key 是 `ns.field` 字符串，
   * 只能表达**一级字段**。而 pi-ai 的路由结构是
   * `providers.<route>.<field>`——路由 id 由用户起名、名字里可能含点，
   * 拼成字符串再切开必然切错（`splitSettingKey` 只切第一个点，正是为此）。
   * 这里直接收**段数组**，与线协议的 `path` 一一对应，不做任何字符串往返。
   *
   * 【为什么沿用同一个 revision 语义】`expectedRevision` 仍是必需的乐观并发令牌，
   * 省略等于放弃保护：两个客户端同时改同一命名空间时后写者会静默抹掉前一个。
   *
   * @param ns - 命名空间（如 `llm-pi-ai`）
   * @param path - 段数组（如 `['providers','wb2api','baseURL']`）
   * @param value - 待写入的值（标量以逐字段写；数组**必须整值写**，见 PiAiProviders 注释）
   */
  async writeSettingPath(ns: string, path: string[], value: Object): Promise<SettingsWriteResult> {
    if (ns.length === 0 || path.length === 0) {
      return {
        outcome: SettingsWriteOutcome.FAILED, actualRevision: -1,
        message: '写入路径为空，已拒绝（这属于本客户端的缺陷，请提交诊断报告）。'
      };
    }
    const state: SettingsNamespaceState | undefined = this.namespaceState(ns);
    if (state === undefined) {
      return {
        outcome: SettingsWriteOutcome.FAILED, actualRevision: -1,
        message: `Host 上没有名为「${ns}」的设置命名空间，已拒绝写入。请重新连接以刷新设置清单。`
      };
    }
    if (!state.writable) {
      return {
        outcome: SettingsWriteOutcome.REJECTED, actualRevision: state.revision,
        message: 'Host 不接受对这项设置的写入（可能是只读来源，例如环境变量或文件基线）。'
      };
    }
    if (!this.unaryReady) {
      return {
        outcome: SettingsWriteOutcome.FAILED, actualRevision: state.revision,
        message: '尚未连接 Host，改动没有生效。请先完成连接后重试。'
      };
    }
    const op: Record<string, Object> = {};
    op['op'] = 'set';
    op['path'] = path;
    op['value'] = value;
    const args: Record<string, Object> = {};
    args['ns'] = ns;
    args['ops'] = [op as Object];
    args['expectedRevision'] = state.revision;
    const result: RpcResult = await this.conn.call(SETTINGS_MUTATE_ENDPOINT, args as Object);
    if (result.ok) {
      // 与 writeSetting 同一条纪律：写成功后整页重拉，保证"界面 == Host 当前状态"
      await this.refreshSettings();
      this.record(`settings/mutate ok ${ns} ${path.join('.')}`);
      this.notify();
      return {
        outcome: SettingsWriteOutcome.OK,
        actualRevision: this.namespaceState(ns) === undefined
          ? state.revision : (this.namespaceState(ns) as SettingsNamespaceState).revision,
        message: `已写入 ${ns} ${path.join('.')}。`
      };
    }
    const failure: RemoteFailure | undefined = result.error;
    const code: string = failure === undefined ? 'unknown' : failure.code;
    if (code === SETTINGS_CONFLICT) {
      const actual: number = this.conflictActualRevision(failure);
      this.record(`settings/mutate conflict ${ns} ${path.join('.')} expected=${state.revision} actual=${actual}`);
      await this.refreshSettings();
      return {
        outcome: SettingsWriteOutcome.CONFLICT, actualRevision: actual,
        message: '这项设置已被其他客户端改过，你的界面是旧的。已为你重新读取最新值，请确认后再改一次。'
      };
    }
    if (code === SETTINGS_REJECTED) {
      this.record(`settings/mutate rejected ${ns} ${path.join('.')}`);
      await this.refreshSettings();
      return {
        outcome: SettingsWriteOutcome.REJECTED, actualRevision: state.revision,
        message: 'Host 拒绝了这个值（可能不符合该设置的类型或取值范围）。已重新读取最新值，请检查后重试。'
      };
    }
    this.record(`settings/mutate fail ${ns} ${path.join('.')} ${code}`);
    return {
      outcome: SettingsWriteOutcome.FAILED, actualRevision: state.revision,
      message: `写入未生效：${friendlyFailure(code, failure === undefined ? '' : failure.message)}`
    };
  }

  /**
   * 删除一个设置命名空间里的路径取值（`settings/mutate` 的 `unset`）。
   *
   * `unset` 的语义是**回落 schema 默认**，不是"设为 null"（`null` 在若干 schema 里
   * 是合法取值）。界面上必须说成"恢复默认"——把两者混为一谈会让用户以为自己清空了、
   * 实际只是回到默认（或反过来）。
   */
  async unsetSettingPath(ns: string, path: string[]): Promise<SettingsWriteResult> {
    if (ns.length === 0 || path.length === 0) {
      return { outcome: SettingsWriteOutcome.FAILED, actualRevision: -1, message: '删除路径为空，已拒绝。' };
    }
    const state: SettingsNamespaceState | undefined = this.namespaceState(ns);
    if (state === undefined) {
      return {
        outcome: SettingsWriteOutcome.FAILED, actualRevision: -1,
        message: `Host 上没有名为「${ns}」的设置命名空间，未做改动。`
      };
    }
    if (!state.writable) {
      return {
        outcome: SettingsWriteOutcome.REJECTED, actualRevision: state.revision,
        message: 'Host 不接受对这项设置的写入（可能是只读来源）。'
      };
    }
    if (!this.unaryReady) {
      return {
        outcome: SettingsWriteOutcome.FAILED, actualRevision: state.revision,
        message: '尚未连接 Host，未做改动。请先完成连接后重试。'
      };
    }
    const op: Record<string, Object> = {};
    op['op'] = 'unset';
    op['path'] = path;
    const args: Record<string, Object> = {};
    args['ns'] = ns;
    args['ops'] = [op as Object];
    args['expectedRevision'] = state.revision;
    const result: RpcResult = await this.conn.call(SETTINGS_MUTATE_ENDPOINT, args as Object);
    if (result.ok) {
      await this.refreshSettings();
      this.record(`settings/unset ok ${ns} ${path.join('.')}`);
      this.notify();
      return { outcome: SettingsWriteOutcome.OK, actualRevision: state.revision,
        message: `已恢复 ${ns} ${path.join('.')} 的默认值。` };
    }
    const failure: RemoteFailure | undefined = result.error;
    const code: string = failure === undefined ? 'unknown' : failure.code;
    this.record(`settings/unset fail ${ns} ${path.join('.')} ${code}`);
    if (code === SETTINGS_CONFLICT) {
      const actual: number = this.conflictActualRevision(failure);
      await this.refreshSettings();
      return {
        outcome: SettingsWriteOutcome.CONFLICT, actualRevision: actual,
        message: '这项设置已被其他客户端改过，你的界面是旧的。已为你重新读取最新值，请确认后再操作。'
      };
    }
    if (code === SETTINGS_REJECTED) {
      await this.refreshSettings();
      return {
        outcome: SettingsWriteOutcome.REJECTED, actualRevision: state.revision,
        message: 'Host 拒绝了这个操作（该键可能不允许删除，或是必填项）。已重新读取最新值。'
      };
    }
    return {
      outcome: SettingsWriteOutcome.FAILED, actualRevision: state.revision,
      message: `未生效：${friendlyFailure(code, failure === undefined ? '' : failure.message)}`
    };
  }

  /**
   * 删除一份凭据（`credentials/unset`）。
   *
   * 【为什么需要显式确认】这是**破坏性**操作：Host 侧的值会被删除，
   * 依赖它的功能（例如联网搜索）会立刻失效。调用方必须来自一次明确的用户确认。
   */
  async unsetCredential(ref: string): Promise<CredentialWriteResult> {
    if (ref.length === 0) {
      return { ok: false, message: '凭据引用不能为空。' };
    }
    if (!this.unaryReady) {
      return { ok: false, message: '尚未连接 Host，未做改动。请先完成连接后重试。' };
    }
    const args: Record<string, Object> = {};
    args['ref'] = ref;
    const result: RpcResult = await this.conn.call(CREDENTIALS_UNSET_ENDPOINT, args as Object);
    if (result.ok) {
      await this.refreshCredentials();
      this.record(`credentials/unset ok ${ref} 快照已配置=${this.countConfiguredCredentials()}`);
      this.notify();
      return { ok: true, message: `已清除 ${ref}。` };
    }
    const failure: RemoteFailure | undefined = result.error;
    const code: string = failure === undefined ? 'unknown' : failure.code;
    this.record(`credentials/unset fail ${ref} ${code}`);
    if (code === CREDENTIAL_REJECTED) {
      return { ok: false, message: `${ref} 被 Host 拒绝删除：该引用由只读来源提供。` };
    }
    return { ok: false, message: `清除未生效：${friendlyFailure(code, failure === undefined ? '' : failure.message)}` };
  }

  /** 已配置的凭据数（诊断用；凭据写入后界面没变时靠它区分「Host 说没配置」与「我们没刷新」） */
  private countConfiguredCredentials(): number {
    let configured: number = 0;
    for (let i = 0; i < this.credentials.length; i++) {
      if (this.credentials[i].configured) {
        configured++;
      }
    }
    return configured;
  }

  /** 重新拉一次凭据状态（`settings/describe` 取 refs → `credentials/describe` 取状态） */
  async refreshCredentials(): Promise<void> {
    if (this.credentialRefs.length === 0) {
      this.credentials = [];
      return;
    }
    const credArgs: Record<string, Object> = {};
    credArgs['refs'] = this.refNames(this.credentialRefs);
    const creds: RpcResult = await this.conn.call(CREDENTIALS_DESCRIBE_ENDPOINT, credArgs as Object);
    if (creds.ok) {
      this.credentials = projectCredentials(creds.value, this.credentialRefs);
      // 记下**回读到的**状态：凭据写入成功但界面没变时，这行是唯一能区分
      // 「Host 说没配置」与「我们没刷新」的证据（实测靠它定位过）。
      let configured: number = 0;
      for (let i = 0; i < this.credentials.length; i++) {
        if (this.credentials[i].configured) {
          configured++;
        }
      }
      this.record(`credentials 回读 refs=${this.credentialRefs.length} 已配置=${configured}`);
    } else {
      const f = creds.error;
      this.record(`credentials 回读失败 ${f === undefined ? '?' : f.code}`);
    }
  }

  /** 在命名空间台账里找写状态 */
  private namespaceState(ns: string): SettingsNamespaceState | undefined {
    for (let i = 0; i < this.namespaceStates.length; i++) {
      if (this.namespaceStates[i].ns === ns) {
        return this.namespaceStates[i];
      }
    }
    return undefined;
  }


  /** 从冲突错误的 details 里取实际 revision（取不到返回 -1，不猜） */
  private conflictActualRevision(failure: RemoteFailure | undefined): number {
    if (failure === undefined) {
      return -1;
    }
    const details: Object | undefined = failure.details;
    if (details === undefined) {
      return -1;
    }
    return getNumber(details, 'actual') ?? -1;
  }

  /** 把一次 `settings/describe` 回复应用到设置页与凭据页 */
  private applySettingsDescribe(value: Object | undefined): void {
    const entries: SettingsGroupEntry[] = projectSettingsEntries(value);
    const groups: SettingGroup[] = [];
    const states: SettingsNamespaceState[] = [];
    for (let i = 0; i < entries.length; i++) {
      groups.push(entries[i].group);
      states.push(entries[i].state);
    }
    this.settingsGroups = groups;
    this.namespaceStates = states;
    // pi-ai 路由与协议候选单独投影（见 HubSnapshot.piAiProviders 的说明）
    this.applyPiAiDescribe(value);
    this.describeWritable = value === undefined ? false : getBoolean(value, 'writable') === true;
    const refs: CredentialRefInfo[] = projectCredentialRefs(value);
    this.credentialRefs = refs;
  }

  /**
   * 从同一次 `settings/describe` 回复里取出 pi-ai 的**路由视图**与**协议候选**。
   *
   * 【为什么两件事一起做】它们来自同一个命名空间对象、同一次回复：
   * 路由在 `value.providers`，协议在 `schema.refs`。分两处读会让"界面显示的协议候选"
   * 与"当前路由值"可能来自不同的 revision。
   *
   * 【不做任何兜底编码】命名空间不在（旧核心/未挂载）或形状不认识时，两者都如实置空：
   * 界面据此显示"Host 没有报告"，而不是画一个空的可添加列表（那会像"没有可加的"）。
   */
  private applyPiAiDescribe(value: Object | undefined): void {
    const namespaces: Object[] | undefined = value === undefined
      ? undefined : getArray(value, 'namespaces');
    let ns: Object | undefined = undefined;
    if (namespaces !== undefined) {
      for (let i = 0; i < namespaces.length; i++) {
        if (getString(namespaces[i], 'ns') === PIAI_SETTINGS_NS) {
          ns = namespaces[i];
        }
      }
    }
    if (ns === undefined) {
      this.piAiViews = [];
      this.piAiProtocolList = [];
      return;
    }
    const providers: Object | undefined = fieldOf(fieldOf(ns, 'value'), 'providers');
    this.piAiViews = projectPiAiProviders(providers);
    const schema: Object | undefined = fieldOf(ns, 'schema');
    this.piAiProtocolList = schema === undefined
      ? [] : piAiProtocolChoices(fieldOf(schema, 'refs'), getNumber(schema, 'uid') ?? 0);
  }

  /**
   * 线协议只认**引用名数组**（`credentials/describe` 的 `refs`），而内存里我们多带了
   * 命名空间与提供方 id（E96：用来把密钥挂到"提供方"上）。这个映射只此一处，
   * 免得两处各写一遍、日后又对不上。
   */
  private refNames(refs: CredentialRefInfo[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < refs.length; i++) {
      out.push(refs[i].ref);
    }
    return out;
  }

  /**
   * 设置建会话用的默认工作区并**向 Host 注册它**（E98）。
   *
   * 【为什么必须注册，而不只是传 cwd】`workspace/create` 的语义是"在已有目录上创建或
   * 幂等解析一个工作区"。只给 `session/create` 传 `cwd` 时，会话没有可折叠的工作区条目：
   * 真机上表现为打开会话即抛 `gateway/internal Cannot read properties of undefined
   * (reading 'kind')`（用户看到的「轨迹流失败」），`workspaceFiles/list` 也必然 `cannot list`。
   * 注册一次、把 `workspaceId` 带进建会话请求，两处都成立。
   *
   * 幂等：同一目录重复调用只会 resolve 已有工作区（回复里的 `created` 区分是新注册还是复用）。
   */
  async ensureWorkspace(dir: string): Promise<string> {
    if (dir.length === 0) {
      return '未提供工作区目录：保持 Host 默认行为。';
    }
    if (this.workspaceId.length > 0 && this.workspacePath === dir) {
      return `工作区已就绪：${dir}`;
    }
    if (!this.unaryReady) {
      return '尚未连接 Host，工作区未注册。';
    }
    /*
     * 【不要把 body 手工包成 `{request: …}`】`dshcompat.buildArgs` 对 `ArgsShape.REQUEST`
     * 的端点**自己会包一层**（`{'request': body}`）。这里若再包一次，宿主收到的是
     * `request.request`，于是 `path` 变成 undefined —— 真机实测报错：
     *   `workspace/invalid-path cannot create a Workspace at "undefined"`
     * 所以这里传**内层请求对象**本身。
     */
    const inner: Record<string, Object> = {};
    inner['path'] = dir;
    const args: Object | undefined = argsFor(WORKSPACE_CREATE_ENDPOINT, inner as Object);
    if (args === undefined) {
      return '兼容面缺少工作区注册端点的参数契约（上表未生成？）。';
    }
    const result: RpcResult = await this.conn.call(WORKSPACE_CREATE_ENDPOINT, args);
    if (!result.ok) {
      const f = result.error;
      const code: string = f === undefined ? 'unknown' : f.code;
      this.record(`workspace/create fail ${code}`);
      return `工作区注册失败：${friendlyFailure(code, f === undefined ? '' : f.message)}`;
    }
    const value: Object | undefined = result.value;
    const ws: Object | undefined = value === undefined ? undefined : getRecord(value, 'workspace');
    const id: string = ws === undefined ? '' : (getString(ws, 'workspaceId') ?? '');
    const created: boolean = value === undefined ? false : getBoolean(value, 'created') === true;
    if (id.length === 0) {
      // 注册"看起来成功"但拿不到 id：如实回报，并且**不假装**后续建会话会带上它
      this.record('workspace/create ok 但没有 workspaceId');
      return '工作区注册回复里没有 workspaceId，后续建会话将退回 Host 默认行为。';
    }
    this.workspaceId = id;
    this.workspacePath = dir;
    this.record(`workspace ${created ? 'created' : 'resolved'} ${id.substring(0, 12)}`);
    this.notify();
    return `工作区已${created ? '注册' : '就绪'}：${dir}`;
  }

  /**
   * 清理**本机缓存**（E130：诊断页「清理离线缓存」此前是空实现）。
   *
   * 【清什么、不清什么】只清我们自己攒下的东西：旁路日志、未识别事件清单、
   * 缓存的会话/轨迹/待决视图。**不碰 Host 侧任何数据**——诊断页不该有
   * "顺手删远端东西"的按钮；那类动作必须由用户在明确的语境里发起。
   * 清完立即 notify，界面读到的就是"清空后的真实状态"。
   */
  clearLocalCache(): void {
    this.traceLines = [];
    this.unknownTypes = [];
    this.trajectoryList = [];
    this.pendingList = [];
    this.fileNodes = [];
    this.filePreview = undefined;
    this.record('已清理本机缓存');
    this.notify();
  }

  /**
   * 设置建会话用的默认工作区（E98）。空串 = 交回 Host 的默认行为。
   */
  setDefaultWorkspace(dir: string): void {
    if (this.defaultWorkspace !== dir) {
      this.record(`默认工作区 ${dir.length > 0 ? dir : '(未设)'}`);
      this.defaultWorkspace = dir;
    }
  }

  /** 当前生效的默认工作区（诊断用；空串表示未设） */
  defaultWorkspaceDir(): string {
    return this.defaultWorkspace;
  }

  /**
   * 新建会话。
   *
   * 上游 `session/create` 的 `request` 字段**全部可选**，传 `{}` 即
   * 「用默认工作区建一个新会话」——已实测（D2 §8.7.2）：返回 `{sessionId, agentPreset}`。
   * 不传 `cwd` 是刻意的：`cwd` 由 Host 的默认工作区决定，客户端不该猜一个路径塞过去。
   *
   * 建好后立刻拉一次列表并选中它：新会话在 Host 上 `blank: true`、`title: null`，
   * 界面上会显示为「新会话 + cwd 末段」，用户马上就能往里发消息。
   *
   * @returns 新会话 id；失败或未连接时返回 undefined（错误已写入 lastError 并广播）
   */
  async createSession(): Promise<string | undefined> {
    if (!this.unaryReady) {
      this.lastError = '尚未连接 Host，无法新建会话。请先在「添加 Host」里完成连接。';
      this.notify();
      return undefined;
    }
    // 空对象也要有声明类型：ArkTS 禁止无类型对象字面量
    const inner: Record<string, Object> = {};
    // E98：注册过的工作区是**权威**（cwd 一并带上，便于 Host 校验/回退）。
    // 真机上只传 cwd 而不注册工作区时，打开会话会抛 `…reading 'kind'`（轨迹流失败）。
    /*
     * 【E101】注册过的工作区是**权威**，而且二者**只能给一个**：真机实测 Host 会直接拒绝
     *   `gateway/bad-request session.create accepts workspaceId or cwd, not both`
     * 所以有 `workspaceId` 就只送它；没有才退回 `cwd`（都没设则不送，交回 Host 默认行为）。
     */
    if (this.workspaceId.length > 0) {
      inner['workspaceId'] = this.workspaceId;
    } else if (this.defaultWorkspace.length > 0) {
      inner['cwd'] = this.defaultWorkspace;
    }
    /*
     * 【不要把 body 手工包成 `{request: …}`（E101，真机根因）】`dshcompat.buildArgs` 对
     * `ArgsShape.REQUEST` 的端点**自己会包一层**（`{'request': body}`，见 CompatIndex.buildArgs）。
     * 这里再包一次 ⇒ 线上是 `request.request` ⇒ Host 看不到 `workspaceId`/`cwd`/`prompt` 等字段，
     * 一切"参数没生效"的现象都由此而来（真机取证：会话 `cwd` 始终是 `/`，而请求体里确实带了路径）。
     * 所以这里传**内层请求对象**本身。
     */
    const args: Object | undefined = argsFor(SESSION_CREATE_ENDPOINT, inner as Object);
    if (args === undefined) {
      this.lastError = '兼容面缺少会话创建端点的参数契约（上表未生成？）';
      this.notify();
      return undefined;
    }
    const result: RpcResult = await this.conn.call(SESSION_CREATE_ENDPOINT, args);
    if (!result.ok) {
      const failure = result.error;
      const code: string = failure === undefined ? 'unknown' : failure.code;
      this.lastError = `新建会话失败：${friendlyFailure(code, failure === undefined ? '' : failure.message)}`;
      this.record(`create fail ${code}`);
      this.notify();
      return undefined;
    }
    const value: Object | undefined = result.value;
    const sessionId: string | undefined = value === undefined ? undefined : getString(value, 'sessionId');
    this.record(`create ok ${sessionId === undefined ? '(无 sessionId)' : sessionId.substring(0, 12)}`);
    await this.refreshSessions();
    if (sessionId !== undefined && sessionId.length > 0) {
      await this.selectSession(sessionId);
    }
    return sessionId;
  }

  /**
   * 拉取会话列表
   */
  async refreshSessions(): Promise<void> {
    const body: Record<string, Object> = {};
    const args: Object | undefined = argsFor(SESSION_LIST_ENDPOINT, body as Object);
    if (args === undefined) {
      this.lastError = '兼容面缺少会话列表端点的参数契约（上表未生成？）';
      this.notify();
      return;
    }
    const result: RpcResult = await this.conn.call(SESSION_LIST_ENDPOINT, args);
    if (!result.ok) {
      const failure = result.error;
      const code: string = failure === undefined ? 'unknown' : failure.code;
      this.lastError = `会话列表获取失败：${friendlyFailure(code, failure === undefined ? '' : failure.message)}`;
      this.record(`list fail ${code}`);
      this.notify();
      return;
    }
    const page = projectSessionList(result.value);
    this.sessions = page.items;
    this.record(`list ok ${page.items.length} 条`);
    this.notify();
  }

  private scheduleSessionRefresh(): void {
    const now: number = Date.now();
    if (now - this.lastRefreshAt < SESSION_REFRESH_THROTTLE_MS) {
      if (this.refreshTimer !== -1) {
        return;
      }
      const wait: number = SESSION_REFRESH_THROTTLE_MS - (now - this.lastRefreshAt);
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = -1;
        this.lastRefreshAt = Date.now();
        this.refreshSessions();
      }, wait);
      return;
    }
    this.lastRefreshAt = now;
    this.refreshSessions();
  }

  /**
   * 选中会话并打开它的轨迹流。
   *
   * 「先取消旧 follow、再开新 follow」是硬约束：并发两条 follow 会让同一个会话的轨迹
   * 被写两遍，且抓包会看到多于一条 follow 流，直接违反 D1 §7.7.5b 的验收点。
   */
  async selectSession(sessionId: string): Promise<void> {
    /**
     * 【守卫为什么要看 `followCancel`】只比 id 会让"重连后重开流"无处落脚：
     * 载体恢复时 `selectedSessionId` 没变，而 `followCancel` 已在流被终结时清空。
     * 于是同 id 会被直接 `return`，轨迹永远停在断开那一刻——
     * 用户看到的是"发出去了、永远不回"（而 Host 其实早算完了）。
     */
    if (this.selectedSessionId === sessionId && this.followCancel !== undefined) {
      return;
    }
    // 只有**换了会话**才清空那些与会话绑定的东西（附件回执、排队项）；
    // 重连重开流时清空会把用户刚加好的附件悄悄丢掉。
    const changed: boolean = this.selectedSessionId !== sessionId;
    this.cancelFollow();
    this.selectedSessionId = sessionId;
    this.trajectoryList = [];
    this.running = false;
    if (changed) {
      // 附件回执是**上一个会话的** Agent 作用域内的东西，切会话后一律失效。
      // 不清理会让用户以为附件还挂着，实际发送时被 Host 判为未知回执。
      this.attachmentList = [];
      // 排队项同理：它是**每个会话各自**的队列。切会话后旧列表必须清空，
      // 否则用户会对着 A 会话的队列项在 B 会话上点"插话"。
      this.queuedItems = [];
      // 后台任务同样是**每个会话各自**的注册表：切会话后不清空会把 A 会话的任务显示在 B 上
      this.jobs = [];
    }
    this.notify();
    if (sessionId.length === 0) {
      return;
    }

    const address: Record<string, Object> = {};
    address['kind'] = 'session';
    address['sessionId'] = sessionId;
    const request: Record<string, Object> = {};
    request['address'] = address as Object;
    request['maxMessages'] = 60;
    // assistantStream:true 让 Host 额外推送「正在进行中的助手输出」，
    // 这样流式光标与逐字输出才有数据（否则只能等整条消息落盘）。
    request['assistantStream'] = true;
    // 【E101】不要再手工包 `request`：`argsFor` 会按端点形态自己包（`session/follow` 是 REQUEST）。
    // 双重包裹会让 Host 收到 `request.request`，服务端随后在折叠快照时抛
    // `gateway/internal Cannot read properties of undefined (reading 'kind')`
    // —— 这正是用户看到的「轨迹流失败」。
    const args: Object | undefined = argsFor(SESSION_FOLLOW_ENDPOINT, request as Object);
    if (args === undefined) {
      this.lastError = '兼容面缺少轨迹流端点的参数契约';
      this.notify();
      return;
    }

    const sink: StreamSink = {
      onItem: (value: Object) => {
        this.handleFollowFrame(value);
      },
      onError: (code: string, message: string) => {
        this.followCancel = undefined;
        this.lastError = `轨迹流失败：${code} ${message}`;
        this.record(`follow error ${code}`);
        // 流没了 ⇒ 立刻接管：这是设备上最常见的一条路径（开流帧发出后 ~40ms 就撞上载体死亡）
        this.ensurePageFallback();
        this.notify();
      },
      onEnd: () => {
        // 正常结束（上游会显式发 `end` 帧）：不是错误，不触发重连
        this.followCancel = undefined;
        this.record('follow end');
        this.ensurePageFallback();
        this.notify();
      }
    };
    const cancel = this.conn.openStream(SESSION_FOLLOW_ENDPOINT, args, sink);
    if (cancel === undefined) {
      this.lastError = '无法打开轨迹流：连接尚未就绪';
      // 流开不起来 ⇒ 交给一元兜底（否则会话页会永远空白）
      this.ensurePageFallback();
      this.notify();
      return;
    }
    this.followCancel = cancel;
    this.record(`follow open ${sessionId.substring(0, 12)}`);
    // 流开起来了 ⇒ 停掉一元兜底轮询（它只是"流开不起来时"的替代通路）
    this.ensurePageFallback();
    this.notify();
    // 【先一元读一次历史】不能等流的第一帧：在这台设备上流往往开不起来（§8.7.19），
    // 而用户已经把会话点开了——一元的这一次读回能立刻把内容显示出来。
    // 失败也无所谓（能力缺失 / 老 Host 没有 session/page），流式通路照旧。
    this.refreshTrajectoryByPage();
    // 命令目录与文件树都是**会话作用域**的（`commands/list` 要 agentId，
    // `workspaceFiles/*` 要 workspaceFileScopeId = sessionId）。因此切会话必须重拉。
    //
    // 【但重连重开流时不该重拉】自从 `handleConnectionState(CONNECTED)` 会重开 follow，
    // 每次重连都会走到这里；在"约 5 秒必断、每 2 秒重连"的设备上，
    // 无条件重拉意味着**每 2 秒多打 4 个一元调用**（命令目录 / 文件树根 / 两类引用候选），
    // 而它们的内容一个字都没变。
    // 判据用「数据是否已经属于这个会话」而不是「是否换了会话」：
    // 若上一次拉取失败（例如选会话时恰好离线），`commandsFor` 仍是空串，
    // 那么重连时必须补拉——只看"换没换"会让命令目录永远空着。
    if (changed || this.commandsFor !== sessionId || this.fileTreeFor !== sessionId) {
      // E253：反馈也是会话范围的，跟随同一处刷新（保持 E245 的"状态→触发→呈现"成环）
      this.refreshFeedback();
      this.refreshSessionScoped();
    }
  }

  /**
   * 拉取与「当前选中会话」绑定的三类数据：命令目录、文件树根、`@` 引用候选。
   *
   * 三个调用都是只读的，且互不依赖，所以顺序发起即可，不需要并发原语。
   */
  private refreshSessionScoped(): void {
    this.refreshCommands();
    this.openWorkspace(this.selectedSessionId);
    this.refreshReferences('');
  }

  // ─────────────────── 一元读回历史（长连接开不起来时的兜底） ───────────────────

  /**
   * 一元读回当前会话的历史（`session/list` 取游标 → `session/page` 读记录）。
   *
   * ───────────────────── 为什么必须有这条兜底 ─────────────────────
   *   实测（D2 §8.7.19）：设备侧 ArkTS 的 WebSocket 不回 Pong，服务端每 2 s Ping、
   *   漏两次即关，因此 `session/follow` 经常连不上（诊断页显示
   *   「WebSocket 已建立；事件流 opening」）。而**一元 HTTP 一直是好的**
   *   （`session/list` / `settings/describe` / `commands/list` 都能成功）。
   *   没有这条兜底，用户看到的是一个**永远空白的会话**：明明能列出会话、能发消息，
   *   却读不出任何内容——这是"看起来完全不能用"的最直接来源。
   *
   * ───────────────────── 为什么能复用 follow 的投影 ─────────────────────
   *   `session/page` 的 `records` 与 `session/follow` 快照的 `records` **同形**
   *   （都是 `{type:'event', event:{type,seq,time,data}}`），因此同一条
   *   `projectWireRecord()` 直接可用——这条通路的实现成本因此很低。
   *
   * 返回是否读到了内容（`false` 表示能力缺失/调用失败，调用方据此保持现状）。
   */
  async refreshTrajectoryByPage(): Promise<boolean> {
    const sessionId: string = this.selectedSessionId;
    if (!this.unaryReady || sessionId.length === 0) {
      return false;
    }
    // 游标从**已有的会话列表**里取（`projections.asOfSeq`），不额外打一次 list：
    // 列表本来就在快照里；而没有真实游标时 `session/page` 只会读回空页（见 D2 §8.7.23）。
    const cursor: number = this.cursorOfSession(sessionId);
    if (cursor < 0) {
      this.record('page skip：取不到游标（projections.asOfSeq）');
      return false;
    }
    const payload: Object | undefined = sessionPagePayload(sessionId, cursor, PAGE_MAX_MESSAGES);
    if (payload === undefined) {
      return false;
    }
    const result: RpcResult = await this.conn.call(sessionPageEndpoint(), payload);
    if (!result.ok) {
      const code: string = result.error === undefined ? 'unknown' : result.error.code;
      this.record(`page fail ${code}`);
      return false;
    }
    const page: SessionPageValue = projectSessionPage(result.value);
    // 用这一页**整体替换**轨迹：它是"到 cursor 为止的完整历史"，
    // 追加会与流式通路已写入的内容重复（用户会看到每条消息两遍）。
    const items: TrajectoryItem[] = [];
    for (let i = 0; i < page.records.length; i++) {
      // E112：一条记录可能展开成多条（消息 + 它夹带的工具调用）
      const projected: TrajectoryItem[] = projectWireRecords(page.records[i]);
      for (let j = 0; j < projected.length; j++) {
        appendOrMerge(items, projected[j]);
      }
    }
    // 期间用户切走了会话：这批记录不属于当前视图，丢弃（否则会把别人的内容显示在他的会话里）
    if (this.selectedSessionId !== sessionId) {
      return false;
    }
    this.trajectoryList = items;
    this.record(`page ok ${items.length} 条（cursor=${cursor}）`);
    this.notify();
    return items.length > 0;
  }

  /** 取某个会话的日志游标（列表摘要的 `projections.asOfSeq`）；取不到返回 -1 */
  private cursorOfSession(sessionId: string): number {
    for (let i = 0; i < this.sessions.length; i++) {
      if (this.sessions[i].id === sessionId) {
        return sessionCursorOf(this.sessions[i].raw);
      }
    }
    return -1;
  }

  /**
   * 兜底轮询的启停：**只在当前会话的轨迹流没开着时**启用。
   *
   * 【为什么按需而不是常开】长连接正常时轮询是纯浪费（每轮一次一元调用），
   * 而它要救的恰恰是"长连接开不起来"这一种情况。判据用 `followCancel === undefined`
   * ——它精确表示"这条流不在"，比任何阶段标志都直接。
   */
  private ensurePageFallback(): void {
    const need: boolean = this.selectedSessionId.length > 0
      && this.unaryReady && this.followCancel === undefined;
    if (!need) {
      if (this.pageTimer !== -1) {
        clearInterval(this.pageTimer);
        this.pageTimer = -1;
      }
      return;
    }
    if (this.pageTimer !== -1) {
      return;
    }
    this.pageTimer = setInterval(() => {
      if (this.selectedSessionId.length === 0 || this.followCancel !== undefined) {
        // 流又开了（或被切了会话）：停掉轮询并交还给流式通路
        this.ensurePageFallback();
        return;
      }
      this.refreshTrajectoryByPage();
    }, PAGE_FALLBACK_INTERVAL_MS);
  }

  // ─────────────────── 斜杠命令（commands/list） ───────────────────

  /**
   * 拉取当前会话的斜杠命令目录。
   *
   * 【为什么按会话拉，而不是拉一次全局共用】上游 `commands/list` 的第一个参数是
   * `agentId`——命令集是**每个 agent 的**（插件可对单个会话禁用命令）。
   * 用别人的结果会让界面显示一批发出去必然失败的命令。
   */
  async refreshCommands(): Promise<void> {
    const agentId: string = this.selectedSessionId;
    if (!this.unaryReady || agentId.length === 0) {
      this.commands = [];
      this.commandsFor = '';
      this.notify();
      return;
    }
    const payload: Object | undefined = commandsListPayload(agentId);
    if (payload === undefined) {
      // 能力缺失（老 Host 没有这个端点）：**清空而不是保留旧值**，
      // 否则界面上会留着一份来自上一个会话/上一个 Host 的命令集。
      this.commands = [];
      this.commandsFor = '';
      this.record('commands 端点不在兼容上表');
      this.notify();
      return;
    }
    const result: RpcResult = await this.conn.call(commandsListEndpoint(), payload);
    if (!result.ok) {
      const failure = result.error;
      const code: string = failure === undefined ? 'unknown' : failure.code;
      this.commands = [];
      this.commandsFor = '';
      this.record(`commands fail ${code}`);
      this.notify();
      return;
    }
    const list: CommandCandidate[] = projectCommands(result.value);
    // 回包可能晚于一次切会话：只接受仍然对应当前会话的结果。
    if (this.selectedSessionId !== agentId) {
      return;
    }
    this.commands = list;
    this.commandsFor = agentId;
    this.record(`commands ok ${list.length} 条`);
    this.notify();
  }

  // ─────────────────── @ 引用候选（两个候选端点） ───────────────────

  /**
   * 拉取 `@` 引用候选。
   *
   * 【两个端点都发，合并结果】文件候选与会话候选是**两个不同端点**
   * （`fileReferences/list` / `sessionReferenceResolver/candidates`），
   * 没有哪一个能替代另一个。任一失败都只用另一个的结果，
   * 不用「失败的那个」的旧数据充数。
   *
   * `query` 是用户在输入框里已经打出的前缀：上游按它做**服务端筛选**，
   * 因此本地不再二次筛选（本地筛会与 Host 的排序/匹配规则不一致）。
   */
  async refreshReferences(query: string): Promise<void> {
    const agentId: string = this.selectedSessionId;
    this.referencesFor = query;
    if (!this.unaryReady || agentId.length === 0) {
      this.references = [];
      this.notify();
      return;
    }
    const filePayload: Object | undefined = fileReferencesPayload(agentId, query);
    const sessionPayload: Object | undefined = sessionReferencesPayload(agentId, query);
    const merged: ReferenceCandidate[] = [];
    if (filePayload !== undefined) {
      const files: RpcResult = await this.conn.call(fileReferencesEndpoint(), filePayload);
      if (files.ok) {
        const list: ReferenceCandidate[] = projectFileReferences(files.value);
        for (let i = 0; i < list.length; i++) {
          merged.push(list[i]);
        }
      } else {
        this.record(`refs(file) fail ${files.error === undefined ? 'unknown' : files.error.code}`);
      }
    }
    if (sessionPayload !== undefined) {
      const sessions: RpcResult = await this.conn.call(sessionReferencesEndpoint(), sessionPayload);
      if (sessions.ok) {
        const list: ReferenceCandidate[] = projectSessionReferences(sessions.value);
        for (let i = 0; i < list.length; i++) {
          merged.push(list[i]);
        }
      } else {
        this.record(`refs(session) fail ${sessions.error === undefined ? 'unknown' : sessions.error.code}`);
      }
    }
    // 丢弃过期回包：用户已经又敲了一个字符，这批候选对应的不是当前查询。
    if (this.referencesFor !== query || this.selectedSessionId !== agentId) {
      return;
    }
    this.references = merged;
    this.notify();
  }

  // ─────────────────── 工作区文件（workspaceFiles/*） ───────────────────

  /**
   * 打开某个会话的工作区根目录（设置文件浏览的**作用域**）。
   *
   * 【为什么文件浏览的作用域必须显式设置，而不能「跟着当前会话」】
   *   文件端点的作用域参数是 `workspaceFileScopeId`，而它**就是会话 id**（D2b §2.0）。
   *   用户在「工作区」页选的是一个**目录**，此时并没有「当前会话」——
   *   靠当前会话会让工作区页永远显示空目录（没有任何会话作用域），
   *   而空目录看起来只是「这个目录是空的」，是个看不见的缺陷。
   *   所以这里把作用域与会话选择**解耦**：会话是「在看哪个对话」，
   *   作用域是「在浏览哪个目录」，两者可以不同。
   */
  /**
   * 订阅**文件变更流**（E226：`workspaceFiles/changes`，契约 stream + `workspaceFileScopeId`）。
   *
   * 【为什么要它】文件视图此前只在"进入/切会话"时取一次（`openWorkspace`）——Agent 改了文件后
   * 界面仍显示旧目录，用户会以为"没生效"。官方有这条通道，我们登记了常量却一直没接（§15.8 第 2 条）。
   *
   * 【取舍：不做增量补丁，收到任何变更帧就重列】目录几十到几百项、`list` 很轻，
   * 重列比"猜增量语义"稳，也避免"补丁打错导致界面与磁盘不一致"；真机若发现过频再按帧节流。
   * 【失败不静默】只记旁路日志（E164 后 hdc 可见），保留"重进刷新"退路——能力降级要说得出原因。
   */
  private openFilesStream(sessionId: string): void {
    if (this.cancelFileChanges !== undefined) {
      this.cancelFileChanges();
      this.cancelFileChanges = undefined;
    }
    const inner: Record<string, Object> = {};
    inner['workspaceFileScopeId'] = sessionId;
    const args: Object | undefined = argsFor(WORKSPACE_FILES_CHANGES_ENDPOINT, inner as Object);
    if (args === undefined) {
      this.record('workspaceFiles/changes 不在兼容上表');
      return;
    }
    const sink: StreamSink = {
      onItem: (value: Object) => {
        // 变更帧的具体形状不重要：**任何**变更都意味着"目录可能变了" ⇒ 重列
        this.openWorkspace(sessionId).catch((e: Object) => {
          this.record('workspaceFiles 变更后重列失败 ' + (e as Error).message);
        });
      },
      onError: (code: string, message: string) => {
        this.record('workspaceFiles/changes 失败 ' + code + ' ' + message);
      },
      onEnd: () => {
        this.record('workspaceFiles/changes 结束');
      }
    };
    this.cancelFileChanges = this.conn.openStream(WORKSPACE_FILES_CHANGES_ENDPOINT, args, sink);
    this.record('files changes opened cancel='
      + (this.cancelFileChanges === undefined ? 'none' : 'ok'));
  }

  async openWorkspace(sessionId: string): Promise<void> {
    // E226：文件视图要随变更自动刷新 ⇒ 每次打开/重列时确保订阅存在
    // （重列由订阅回调触发，回调里再调本函数会重订阅一次——不会自激：重订阅本身不产生变更帧）
    if (sessionId.length > 0) {
      this.openFilesStream(sessionId);
    }
    this.filePreview = undefined;
    this.fileTruncated = false;
    if (!this.unaryReady || sessionId.length === 0) {
      this.fileNodes = [];
      this.fileTreeFor = '';
      this.notify();
      return;
    }
    this.fileTreeFor = sessionId;
    const listing: FileNode[] | undefined =
      await this.listDirectory(WORKSPACE_ROOT_REQUEST_PATH, '', sessionId);
    if (listing === undefined) {
      this.fileNodes = [];
      this.fileTreeFor = '';
      this.notify();
      return;
    }
    // 期间用户又换了一个工作区：这次回包作废（否则文件树会串到别的工作区）
    if (this.fileTreeFor !== sessionId) {
      return;
    }
    this.fileNodes = listing;
    this.notify();
  }

  /**
   * 列出一层目录。
   *
   * `requestPath` 是**发给 Host 的路径**，`parentPath` 是**用来拼子节点路径的
   * 工作区相对路径**。两者在根目录上**不相等**：请求必须用
   * `WORKSPACE_ROOT_REQUEST_PATH`（空串会被 `gateway/bad-request: path is required`
   * 拒绝），而子节点前缀必须是空串（回复词法里工作区根就是空串）。
   * 合并成一个参数会让根目录要么列不出来、要么子节点路径变成 `./docs`。
   *
   * 返回 `undefined` 表示**调用失败**（与「目录为空」严格区分）：
   * 把失败当成空目录会让用户以为目录里没有文件。
   */
  private async listDirectory(requestPath: string, parentPath: string,
    scope: string): Promise<FileNode[] | undefined> {
    const payload: Object | undefined = workspaceListPayload(scope, requestPath);
    if (payload === undefined) {
      this.record('workspaceFiles 端点不在兼容上表');
      return undefined;
    }
    const result: RpcResult = await this.conn.call(workspaceListEndpoint(), payload);
    if (!result.ok) {
      const code: string = result.error === undefined ? 'unknown' : result.error.code;
      const message: string = result.error === undefined ? '' : result.error.message;
      // 把上游的 message 一起记下来：`gateway/bad-request` 的成因可能是
      // 「path 必填」（根写成空串）或别的参数问题，而错误码本身不区分它们。
      this.record(`ws list fail ${code} ${message}`);
      return undefined;
    }
    const projection = projectWorkspaceListing(result.value, parentPath, this.deliverablePaths());
    if (projection.truncated) {
      this.fileTruncated = true;
    }
    return projection.nodes;
  }

  /** 交付物相对路径（来自当前轨迹的 `deliverables/presented`），用于给文件树打标。 */
  private deliverablePaths(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.trajectoryList.length; i++) {
      const item: TrajectoryItem = this.trajectoryList[i];
      if (item.kind === TrajectoryKind.DELIVERABLE && item.fileName.length > 0) {
        out.push(item.fileName);
      }
    }
    return out;
  }

  /**
   * 展开/折叠一个目录。
   *
   * **懒加载**：首次展开才发 `workspaceFiles/list`。上游没有「整棵树」端点
   * （D2b §2.1：只有某一层的直接子项），预先递归会在大仓库上打出成百上千次 RPC。
   */
  async toggleDirectory(path: string): Promise<void> {
    const scope: string = this.fileTreeFor.length > 0 ? this.fileTreeFor : this.selectedSessionId;
    if (scope.length === 0) {
      return;
    }
    const node: FileNode | undefined = findNode(this.fileNodes, path);
    if (node === undefined) {
      return;
    }
    if (node.loaded) {
      this.fileNodes = replaceNode(this.fileNodes, path, collapseNode(node));
      this.notify();
      return;
    }
    const children: FileNode[] | undefined = await this.listDirectory(path, path, scope);
    if (children === undefined) {
      this.lastError = `目录「${path}」列表获取失败（详见诊断页旁路日志）`;
      this.notify();
      return;
    }
    this.fileNodes = replaceNode(this.fileNodes, path, expandNode(node, children));
    this.notify();
  }

  /**
   * 打开一个文件并取回文本。
   *
   * 失败时给出**上游的拒绝理由**（如 `workspace-file/not-text`），
   * 而不是一个空白预览：静默空白会被读成「文件是空的」。
   */
  async openFile(path: string, name: string): Promise<void> {
    const scope: string = this.fileTreeFor.length > 0 ? this.fileTreeFor : this.selectedSessionId;
    if (!this.unaryReady || scope.length === 0) {
      this.filePreview = undefined;
      this.notify();
      return;
    }
    const payload: Object | undefined = workspaceReadPayload(scope, path, 0);
    if (payload === undefined) {
      this.filePreview = projectWorkspaceFailure(path, name, '该 Host 不提供文件读取端点');
      this.notify();
      return;
    }
    const result: RpcResult = await this.conn.call(workspaceReadEndpoint(), payload);
    if (!result.ok) {
      const failure = result.error;
      const code: string = failure === undefined ? 'unknown' : failure.code;
      const message: string = failure === undefined ? '' : failure.message;
      this.record(`ws read fail ${code}`);
      this.filePreview = projectWorkspaceFailure(path, name, friendlyWorkspaceFailure(code, message));
      this.notify();
      return;
    }
    this.filePreview = projectWorkspaceText(result.value, path, name, 0);
    this.record(`ws read ok ${path}`);
    this.notify();
  }

  /** 关闭当前预览。 */
  closeFilePreview(): void {
    this.filePreview = undefined;
    this.notify();
  }

  /** 处理 `session/follow` 的一帧：snapshot / event / assistant-stream */
  private handleFollowFrame(value: Object): void {
    const type: string = getString(value, 'type') ?? '';
    if (type === 'snapshot') {
      const records: Object[] | undefined = getArray(value, 'records');
      const items: TrajectoryItem[] = [];
      if (records !== undefined) {
        for (let i = 0; i < records.length; i++) {
          const projected: TrajectoryItem[] = projectWireRecords(records[i]);
          for (let j = 0; j < projected.length; j++) {
            appendOrMerge(items, projected[j]);
          }
        }
      }
      this.trajectoryList = items;
      this.applySessionProjections(value);
      this.record(`follow snapshot records=${records === undefined ? 0 : records.length}`);
      this.notify();
      return;
    }
    if (type === 'event') {
      // E112：一条事件可能展开成多条（消息 + 夹带的工具调用）
      const projected: TrajectoryItem[] = projectWireRecords(value);
      if (projected.length > 0) {
        const next: TrajectoryItem[] = this.trajectoryList.slice();
        for (let i = 0; i < projected.length; i++) {
          appendOrMerge(next, projected[i]);
        }
        this.trajectoryList = next;
      }
      const event: Object | undefined = getRecord(value, 'event');
      if (event !== undefined) {
        const eventType: string = getString(event, 'type') ?? '';
        // 未识别的事件类型要汇总到诊断页供回填形状表。
        // 判据是 `isKnownEventType()` 而**不是** `classifyEventType()` 的返回值：
        // 后者对未知类型刻意降级为 MESSAGE，用返回值判断会把「新事件」
        // 和「已知但不占行的内容事件」混为一谈，于是升级永远静默通过。
        if (!isKnownEventType(eventType)) {
          this.noteUnknown(`event:${eventType}`);
        }
        // 运行态与标题都可能因事件变化；标题取投影，需要重新拉列表才准，
        // 这里只在「轮次结束」类事件上做一次轻量刷新，避免每个 token 都拉一次列表。
        if (mayChangeTurnState(eventType) || mayChangeSessionTitle(eventType)) {
          this.scheduleSessionRefresh();
        }
        if (eventType === EVENT_TURN_END) {
          /**
           * 轮次结束是**唯一**可靠的"跑完了"信号，而在此之前中枢从没处理过它：
           * `running` 只在「发送被接受」时置真、「取消」时置假，
           * 因此正常跑完一轮之后，界面会一直显示"运行中"（停止按钮再也变不回发送按钮）。
           *
           * 失败与否从 `data.reason.kind` 判定：实测失败轮次的形状是
           * `turn/end {turn, reason:{kind:'error', error:{message}}}`。
           * **判据只认 `kind === 'error'`**：其它取值（含未知的新取值）一律按"正常完成"，
           * 因为把一次正常完成误报成失败会让用户白查一场。
           */
          this.running = false;
          this.publishTurnNotice(event);
        }
      }
      this.notify();
      return;
    }
    if (type === 'assistant-stream') {
      // 进行中的助手输出：当前只用于把「运行中」点亮，逐块文本渲染待事件契约确认后接入
      this.running = true;
      this.notify();
      return;
    }
    this.noteUnknown(`follow:${type}`);
  }

  /** 从 snapshot 里读投影，更新运行态（标题等由列表投影负责） */
  private applySessionProjections(value: Object): void {
    const projections: Object | undefined = getRecord(value, 'projections');
    if (projections === undefined) {
      return;
    }
    const values: Object | undefined = getRecord(projections, 'values');
    if (values === undefined) {
      return;
    }
    const typed: Record<string, Object> = values as Record<string, Object>;
    const title: Object | undefined = typed[PROJECTION_TITLE];
    if (typeof title === 'string') {
      const text: string = title as string;
      this.updateSessionTitle(this.selectedSessionId, text);
    }
    /*
     * 【E124：权限组合本来就投影过来了】线协议文档（`Wire.ets` 的投影样例）里写着
     * `"permissions":{"options":[…],"currentValue":"workspace-write"}`，而此前我们**从未读它**——
     * 界面上的"工作区内修改"是我写死的字符串，而不是 Host 的事实。
     * 这里按结构取出来（`options` 允许缺失：缺失表示这一档没有可选集合），
     * 让界面显示**宿主真正报告的档位**。
     */
    /*
     * E201：`plan` 投影（计划模式）。
     *
     * 官方 chip 的判据是"**生效目标**是计划模式"=`pending ? !active : active`
     * （`pending` 表示用户刚切换、等宿主确认）。我们原样读这两个布尔值，
     * 由视图层用同一条公式推导显示——**不自己发明状态**。
     */
    const plan: Object | undefined = typed['plan'];
    if (plan !== undefined) {
      this.planActive = getBoolean(plan, 'active') === true;
      this.planPending = getBoolean(plan, 'pending') === true;
    }
    const permissions: Object | undefined = typed[PROJECTION_PERMISSIONS];
    if (permissions !== undefined) {
      const current: string = getString(permissions, 'currentValue') ?? '';
      const optionsArray: Object[] | undefined = getArray(permissions, 'options');
      const options: string[] = [];
      if (optionsArray !== undefined) {
        for (let i = 0; i < optionsArray.length; i++) {
          const one: Object = optionsArray[i];
          if (typeof one === 'string') {
            options.push(one as string);
          }
        }
      }
      if (current !== this.permissionsCurrent || options.length !== this.permissionsOptions.length) {
        this.permissionsCurrent = current;
        this.permissionsOptions = options;
        this.notify();
      }
    }
    // E125：会话统计与 Token 用量（同样"投影里本来就有，只是没读"）
    const stats: Object | undefined = typed[PROJECTION_SESSION_STATS];
    if (stats !== undefined) {
      this.statsTurns = getNumber(stats, 'turns') ?? 0;
      this.statsSteps = getNumber(stats, 'steps') ?? 0;
      this.statsLlmMs = getNumber(stats, 'llmMs') ?? 0;
      this.statsToolMs = getNumber(stats, 'toolMs') ?? 0;
      this.statsTtftMs = getNumber(stats, 'ttftMs') ?? 0;
      this.statsTtftSteps = getNumber(stats, 'ttftSteps') ?? 0;
      this.statsDecodeMs = getNumber(stats, 'decodeMs') ?? 0;
      this.statsDecodeTokens = getNumber(stats, 'decodeTokens') ?? 0;
    }
    const usage: Object | undefined = typed[PROJECTION_TOKEN_USAGE];
    if (usage !== undefined) {      this.tokensUncachedInput = getNumber(usage, 'uncachedInputTokens') ?? 0;
      this.tokensOutput = getNumber(usage, 'outputTokens') ?? 0;
      this.tokensCacheRead = getNumber(usage, 'cacheReadTokens') ?? 0;
      this.tokensCacheWrite = getNumber(usage, 'cacheWriteTokens') ?? 0;
    }
    // E129：会话的 Agent 预设（官方显示在会话标题上；预设创建后固定，所以只读）
    const preset: Object | undefined = typed[PROJECTION_AGENT_PRESET];
    if (typeof preset === 'string') {
      this.agentPresetId = preset as string;
    }
    this.notify();
  }

  private updateSessionTitle(sessionId: string, title: string): void {
    let changed: boolean = false;
    const next: SessionListItem[] = [];
    for (let i = 0; i < this.sessions.length; i++) {
      const s: SessionListItem = this.sessions[i];
      if (s.id === sessionId && s.title !== title) {
        changed = true;
        next.push({
          id: s.id, title: title, cwd: s.cwd, updatedAt: s.updatedAt, createdAt: s.createdAt,
          running: s.running, blank: s.blank, raw: s.raw
        });
      } else {
        next.push(s);
      }
    }
    if (changed) {
      this.sessions = next;
    }
  }

  // ───────────────────────── 控制流（队列/作业/投影） ─────────────────────────

  /**
   * 工作区注册表变更流（E132）。
   *
   * 【首帧是基线，后续是增量】实测形状（`dsh-api-workspace-controller` 的类型定义）：
   *   `{type:'baseline', value:{items: WorkspaceView[], archivedSessionIds}}`
   *   `{type:'upsert', workspace}`（增量）
   * 注册表是**唯一**给出 `workspaceId` 的地方；`workspace/delete` 与
   * `workspace/archiveSession` 都以 id 为键，所以这条流是那两个动作的前置。
   *
   * 【失败不阻断连接】拿不到注册表只影响"删除工作区/看归档"这两件事，
   * 不该让整个客户端连不上——所以这里失败只记账，不改 phase。
   */
  private openWorkspaceStream(): void {
    // ArkTS 禁止无类型的空对象字面量：先声明再传
    const empty: Record<string, Object> = {};
    const args: Object | undefined = argsFor(WORKSPACE_FOLLOW_ENDPOINT, empty as Object);
    if (args === undefined) {
      this.record('workspace/follow 不在兼容上表');
      return;
    }
    const sink: StreamSink = {
      onItem: (value: Object) => {
        this.handleWorkspaceFrame(value);
      },
      onError: (code: string, message: string) => {
        this.record(`workspace follow error ${code}`);
        this.lastError = `工作区注册表流异常：${friendlyFailure(code, message)}`;
        this.notify();
      },
      onEnd: () => {
        this.record('workspace follow end');
      }
    };
    this.cancelWorkspace = this.conn.openStream(WORKSPACE_FOLLOW_ENDPOINT, args, sink);
    /*
     * E164：**开流本身也要记账**。此前只有失败分支有记录，于是设备上"没有 baseline 也没有 error"
     * 时无法判断到底是"流没开"还是"开了但没送数据"——这正是归档集在重启后为空、
     * 归档会话"复活"的取证卡点。加上这一行，一次真机运行就能分清。
     */
    this.record(`workspace follow opened cancel=${this.cancelWorkspace === undefined ? 'none' : 'ok'}`);
  }

  /** 处理注册表帧：基线整表替换，增量按 id upsert */
  private handleWorkspaceFrame(value: Object): void {
    const type: string = getString(value, 'type') ?? '';
    if (type === 'baseline') {
      const baseline: Object | undefined = getRecord(value, 'value');
      if (baseline === undefined) {
        return;
      }
      this.workspaceRows = projectWorkspaceRows(baseline);
      this.archivedIds = getStringArray(baseline, 'archivedSessionIds');
      /*
       * E166：**把 id 打出来**，而不是只报个数。
       * 反馈②（归档会话仍出现在工作区）卡在"分组里那些行到底在不在归档集里"——
       * 只报 `archived=3` 无法回答这个问题。这一行让下一次真机运行直接给出答案
       * （E164 修好了 hilog 通道，记账才真正可用于排障）。
       */
      this.record(`workspace baseline items=${this.workspaceRows.length} archived=${this.archivedIds.length}`
        + ` ids=${this.archivedIds.map((v: string) => v.substring(0, 12)).join(',')}`);
      this.notify();
      return;
    }
    if (type === 'upsert') {
      const ws: Object | undefined = getRecord(value, 'workspace');
      if (ws === undefined) {
        return;
      }
      const row: WorkspaceRow | undefined = projectWorkspaceRow(ws);
      if (row === undefined) {
        return;
      }
      const next: WorkspaceRow[] = [];
      let replaced: boolean = false;
      for (let i = 0; i < this.workspaceRows.length; i++) {
        if (this.workspaceRows[i].id === row.id) {
          next.push(row);
          replaced = true;
        } else {
          next.push(this.workspaceRows[i]);
        }
      }
      if (!replaced) {
        next.push(row);
      }
      this.workspaceRows = next;
      this.notify();
    }
  }

  /**
   * 删除一个工作区注册（E132）。请求 `{workspaceId}`，回复 `{deleted:true}`。
   *
   * 【只删注册，不删目录】官方语义如此：删除的是"这个目录曾被登记为工作区"这件事，
   * 磁盘上的文件一个都不动。界面上必须把这句话写清楚，否则没人敢按。
   */
  async deleteWorkspace(workspaceId: string): Promise<ActionNotice> {
    if (workspaceId.length === 0) {
      return notice('workspace.no-id');
    }
    if (!this.unaryReady) {
      return noticeWith('offline', 'action', 'workspace.delete');
    }
    const inner: Record<string, Object> = {};
    inner['workspaceId'] = workspaceId;
    const args: Object | undefined = argsFor(WORKSPACE_DELETE_ENDPOINT, inner as Object);
    if (args === undefined) {
      return noticeWith('contract.missing', 'endpoint', WORKSPACE_DELETE_ENDPOINT);
    }
    const result: RpcResult = await this.conn.call(WORKSPACE_DELETE_ENDPOINT, args);
    if (!result.ok) {
      const f = result.error;
      const code: string = f === undefined ? 'unknown' : f.code;
      this.record(`workspace/delete fail ${code}`);
      return noticeWith('workspace.delete.failed', 'reason',
        friendlyFailure(code, f === undefined ? '' : f.message));
    }
    // 本地立即过滤（流的增量帧可能稍后才到，界面不该等它）
    const next: WorkspaceRow[] = [];
    for (let i = 0; i < this.workspaceRows.length; i++) {
      if (this.workspaceRows[i].id !== workspaceId) {
        next.push(this.workspaceRows[i]);
      }
    }
    this.workspaceRows = next;
    this.record(`workspace/delete ok ${workspaceId.substring(0, 8)}`);
    this.notify();
    return notice('workspace.deleted');
  }

  /**
   * 归档一个会话（E132）。请求 `{sessionId}`，回复**完整**归档集合。
   *
   * 归档集是"注册表全局"的：客户端按它把会话从常规列表过滤掉——
   * 这也是官方 `workspace/follow` 基线里带 `archivedSessionIds` 的原因。
   */
  async archiveSession(sessionId: string): Promise<ActionNotice> {
    if (sessionId.length === 0) {
      return notice('archive.no-session');
    }
    if (!this.unaryReady) {
      return noticeWith('offline', 'action', 'session.archive');
    }
    const inner: Record<string, Object> = {};
    inner['sessionId'] = sessionId;
    const args: Object | undefined = argsFor(WORKSPACE_ARCHIVE_SESSION_ENDPOINT, inner as Object);
    if (args === undefined) {
      return noticeWith('contract.missing', 'endpoint', WORKSPACE_ARCHIVE_SESSION_ENDPOINT);
    }
    const result: RpcResult = await this.conn.call(WORKSPACE_ARCHIVE_SESSION_ENDPOINT, args);
    if (!result.ok) {
      const f = result.error;
      const code: string = f === undefined ? 'unknown' : f.code;
      this.record(`workspace/archiveSession fail ${code}`);
      return noticeWith('archive.failed', 'reason',
        friendlyFailure(code, f === undefined ? '' : f.message));
    }
    const value: Object | undefined = result.value;
    if (value !== undefined) {
      this.archivedIds = getStringArray(value, 'archivedSessionIds');
    }
    this.record(`archive ok ${sessionId.substring(0, 12)}（归档集 ${this.archivedIds.length}）`);
    this.notify();
    return notice('session.archived');
  }

  /**
   * **复制**一个预设（E169：官方唯一的创建入口）。
   *
   * 【契约来自宿主 schema，不是猜的】`typert.host.js` 里 `agentPresets/copy` 的参数是
   * **`from` + `id` + `name`** 三个：
   * `from` = 被复制的预设标识，`id` = 新预设的标识（kebab-case），`name` = 它的显示名。
   * 这也解释了此前的崩溃：只传 `{id,name}` 时处理函数读 `from.length` 得到 undefined。
   * 复制成功后刷新名单。
   */
  async copyAgentPreset(from: string, id: string, name: string): Promise<ActionNotice> {
    if (!this.unaryReady) {
      return noticeWith('offline', 'action', 'agentPresets.copy');
    }
    if (from.length === 0 || id.length === 0 || name.length === 0) {
      return notice('preset.copy.missing');
    }
    const inner: Record<string, Object> = {};
    inner['from'] = from;
    inner['id'] = id;
    inner['name'] = name;
    const args: Object | undefined = argsFor(AGENT_PRESETS_COPY_ENDPOINT, inner as Object);
    if (args === undefined) {
      return noticeWith('contract.missing', 'endpoint', AGENT_PRESETS_COPY_ENDPOINT);
    }
    const result: RpcResult = await this.conn.call(AGENT_PRESETS_COPY_ENDPOINT, args);
    if (!result.ok) {
      const f = result.error;
      const code: string = f === undefined ? 'unknown' : f.code;
      this.record(`agentPresets/copy fail ${code}`);
      return noticeWith('preset.copy.failed', 'reason',
        friendlyFailure(code, f === undefined ? '' : f.message));
    }
    this.record(`agentPresets/copy ok ${from} → ${id}`);
    await this.refreshAgentPresets();
    return noticeWith('preset.copied', 'id', id);
  }

  /**
   * 删除一个**自定义**预设（E169）。
   *
   * 【随附预设的只读由宿主强制】真机实测：对 `standard` 调用会返回
   * `agent-presets: preset "standard" cannot be written: it ships with the deployment`
   * ⇒ 我们不需要自己判断"能不能删"，把宿主的话原样转达即可（`params.reason`）。
   */
  async deleteAgentPreset(id: string): Promise<ActionNotice> {
    if (!this.unaryReady) {
      return noticeWith('offline', 'action', 'agentPresets.deletePreset');
    }
    if (id.length === 0) {
      return notice('preset.delete.missing');
    }
    const inner: Record<string, Object> = {};
    inner['id'] = id;
    const args: Object | undefined = argsFor(AGENT_PRESETS_DELETE_ENDPOINT, inner as Object);
    if (args === undefined) {
      return noticeWith('contract.missing', 'endpoint', AGENT_PRESETS_DELETE_ENDPOINT);
    }
    const result: RpcResult = await this.conn.call(AGENT_PRESETS_DELETE_ENDPOINT, args);
    if (!result.ok) {
      const f = result.error;
      const code: string = f === undefined ? 'unknown' : f.code;
      this.record(`agentPresets/deletePreset fail ${code}`);
      return noticeWith('preset.delete.failed', 'reason',
        friendlyFailure(code, f === undefined ? '' : f.message));
    }
    this.record(`agentPresets/deletePreset ok ${id}`);
    await this.refreshAgentPresets();
    return noticeWith('preset.deleted', 'id', id);
  }

  /**
   * 读取一个预设的内容（E169：只读查看器用）。
   *
   * 【参数名是 `agentPreset`】宿主 schema 里 `agentPresets/read` 只有一个字段 `agentPreset`
   * （回复也是 `{agentPreset: …}`）——`id`/`presetId`/`name` 都被描述符拒过，别再试。
   */
  async readAgentPreset(id: string): Promise<string> {
    if (!this.unaryReady) {
      return '';
    }
    const inner: Record<string, Object> = {};
    inner['agentPreset'] = id;
    const args: Object | undefined = argsFor(AGENT_PRESETS_READ_ENDPOINT, inner as Object);
    if (args === undefined) {
      return '';
    }
    const result: RpcResult = await this.conn.call(AGENT_PRESETS_READ_ENDPOINT, args);
    if (!result.ok) {
      this.record(`agentPresets/read fail ${result.error === undefined ? 'unknown' : result.error.code}`);
      return '';
    }
    const value: Object | undefined = result.value;
    if (value === undefined) {
      return '';
    }
    // 回复是 `{agentPreset: …}`：能取到字符串就直接给，取到对象就序列化（只读查看器只要求"看得见"）
    const text: string | undefined = getString(value, 'agentPreset');
    if (text !== undefined) {
      return text;
    }
    return JSON.stringify(value, null, 2) ?? '';
  }

  /**
   * 读取**提供方目录**（E179）：官方 Models 页把"已注册路由"与"声明的可配置提供方"联合起来，
   * 前者是"当前可用"，后者是"**可添加**"。
   *
   * 【两个端点都是 NONE 形态】`llm/listProviders` 与 `llm/listConfigurableProviders` 都不收参数
   * （兼容表里 shape=NONE ⇒ `argsFor` 给出空具名参数）。**形状未在真机确证**：
   * 这里沿用既定纪律——容忍 `providers` / `items` / 裸数组三种，**都不中就返回 undefined**，
   * 由调用方把**真实顶层键**记进旁路日志（E164 之后 hdc 可见），绝不猜一个键名当事实用。
   */
  async refreshProviderCatalog(): Promise<void> {
    if (!this.unaryReady) {
      this.providerCatalogNote = '尚未连接 Host，提供方目录未读取。';
      this.notify();
      return;
    }
    const registered: string[] = await this.providerNamesFrom(LLM_LIST_PROVIDERS_ENDPOINT);
    const configurable: string[] = await this.providerNamesFrom(LLM_LIST_CONFIGURABLE_PROVIDERS_ENDPOINT);
    const merged: string[] = [];
    for (let i = 0; i < registered.length; i++) {
      if (merged.indexOf(registered[i]) < 0) {
        merged.push(registered[i]);
      }
    }
    for (let i = 0; i < configurable.length; i++) {
      if (merged.indexOf(configurable[i]) < 0) {
        merged.push(configurable[i]);
      }
    }
    this.providerCatalog = merged;
    this.providerCatalogNote = merged.length === 0
      ? '宿主没有报告可配置的提供方（两个目录都为空或形状未识别，见旁路日志）。'
      : '';
    this.record(`llm providers registered=${registered.length} configurable=${configurable.length}`);
    this.notify();
  }

  /**
   * **执行一条斜杠命令**（E188，官方命令面板的落点）。
   *
   * 名字用 `CommandCandidate.name`（宿主给的、含前导 `/`，与用户手输一致）⇒ 不翻译不拼接。
   * 参数契约缺失或执行失败时，把原因**原样**带回去并记账：若字段名与宿主不符，
   * 宿主返回的那条 `gateway/arguments-invalid` 就是唯一能告诉我们正确形状的东西——
   * 客户端不猜着"修正"。
   */
  async executeCommand(name: string): Promise<ActionNotice> {
    if (!this.unaryReady) {
      return noticeWith('offline', 'action', 'commands.execute');
    }
    /*
     * E219：这条端点要的是 **agentId**（权威契约：`commands/execute: agentId, line, submittedAttachments`），
     * 不是会话 id。`commandsFor` 正是拉取命令目录时用的那个 agentId ⇒ 复用它。
     * 没拉过目录就**不发请求**并如实说明（避免又拿一个 undefined 去撞上游的 TypeError）。
     */
    const agent: string = this.commandsFor;
    if (agent.length === 0) {
      return notice('command.not-loaded');
    }
    if (name.length === 0) {
      return notice('command.no-name');
    }
    const payload: Object | undefined = commandsExecutePayload(agent, name);
    if (payload === undefined) {
      return noticeWith('contract.missing', 'endpoint', commandsExecuteEndpoint());
    }
    const result: RpcResult = await this.conn.call(commandsExecuteEndpoint(), payload);
    if (!result.ok) {
      const f = result.error;
      const code: string = f === undefined ? 'unknown' : f.code;
      const why: string = friendlyFailure(code, f === undefined ? '' : f.message);
      this.record('commands/execute fail ' + code + ' ' + (f === undefined ? '' : f.message));
      return noticeWith('command.failed', 'reason', why);
    }
    this.record('commands/execute ok ' + name);
    return noticeWith('command.executed', 'name', name);
  }
  /**
   * **按会话切换模型与推理强度**（E194；官方把该控件放在会话输入区）。
   *
   * 【与 `setDefaultModel` 的分工】后者写 `agent-default-model`（**新会话默认用什么**，
   * 设置页的职责）；本方法写 `session/selectModel`（**这个会话从现在起用什么**）。
   * 官方也是这样分成两处的——此前我们只有前者，等于"已存在的会话改不了模型"。
   *
   * 前置与失败处理沿用 `executeCommand` 的分档：未连接 / 未选会话 / 参数不全 / 契约缺失
   * 各自返回结构化回执；执行失败把宿主原文作为 `reason` 带回并记账（字段名若与宿主不符，
   * 那条 `arguments-invalid` 就是唯一能告诉我们正确形状的东西）。
   */
  async selectSessionModel(provider: string, model: string, effort: string): Promise<ActionNotice> {
    if (!this.unaryReady) {
      return noticeWith('offline', 'action', 'session.selectModel');
    }
    const scope: string = this.selectedSessionId;
    if (scope.length === 0) {
      return notice('model.needs-session');
    }
    if (provider.length === 0 || model.length === 0) {
      return notice('model.incomplete');
    }
    const payload: Object | undefined = sessionSelectModelPayload(scope, provider, model, effort);
    if (payload === undefined) {
      return noticeWith('contract.missing', 'endpoint', sessionSelectModelEndpoint());
    }
    const result: RpcResult = await this.conn.call(sessionSelectModelEndpoint(), payload);
    if (!result.ok) {
      const f = result.error;
      const code: string = f === undefined ? 'unknown' : f.code;
      const why: string = friendlyFailure(code, f === undefined ? '' : f.message);
      this.record('session/selectModel fail ' + code + ' ' + (f === undefined ? '' : f.message));
      return noticeWith('model.select.failed', 'reason', why);
    }
    this.record('session/selectModel ok ' + provider + '/' + model + ' effort=' + effort);
    return noticeWith('model.selected', 'model', provider + '/' + model);
  }

  /**
   * 读取**长期任务目标**（E242：官方 `ui-goal` 的目标栏）。
   *
   * 【为什么用 `commandsFor` 当 agentId】契约里 `goals/get` 只要 `agentId`，而我们拉命令目录时
   * 记下的 `commandsFor` 正是当前会话的 agentId（同族端点的作用域口径一致）。
   * 【形状未确证】回复可能是 `{goal:{…}}`、`{goal:"…"}` 或直接含 `text/objective/title`
   * ⇒ 三种都试；都不中就把**真实顶层键**记账并如实告知，**不猜键名**。
   */
  async refreshGoal(): Promise<void> {
    if (!this.unaryReady) {
      this.goalNote = '尚未连接 Host，目标未读取。';
      this.notify();
      return;
    }
    const agent: string = this.commandsFor;
    if (agent.length === 0) {
      this.goalText = '';
      this.goalNote = '目标取决于具体会话：请先选中一个会话。';
      this.notify();
      return;
    }
    const inner: Record<string, Object> = {};
    inner['agentId'] = agent;
    const args: Object | undefined = argsFor(GOALS_GET_ENDPOINT, inner as Object);
    if (args === undefined) {
      this.goalNote = '兼容面缺少目标端点的参数契约。';
      this.notify();
      return;
    }
    const result: RpcResult = await this.conn.call(GOALS_GET_ENDPOINT, args);
    if (!result.ok) {
      const f = result.error;
      const code: string = f === undefined ? 'unknown' : f.code;
      this.goalText = '';
      this.goalNote = '目标读取失败：' + friendlyFailure(code, f === undefined ? '' : f.message);
      this.record('goals/get fail ' + code);
      this.notify();
      return;
    }
    const value: Object | undefined = result.value;
    const parsed: string | undefined = goalTextFromReply(value);
    if (parsed === undefined) {
      const keys: string = value === undefined ? '(空回复)' : Object.keys(value as Record<string, Object>).join(', ');
      this.goalText = '';
      this.goalNote = '宿主返回的目标形状未识别（顶层键：' + keys + '）；已记账，待按真实形状收紧解析。';
      this.record('goals/get shape unknown keys=' + keys);
      this.notify();
      return;
    }
    this.goalText = parsed;
    // 空串是**合法结果**（该会话没有设定目标），不是错误——如实说明，别让用户以为坏了
    this.goalNote = parsed.length === 0 ? '该会话当前没有长期目标。' : '';
    this.record('goals/get ok len=' + parsed.length);
    this.notify();
  }

  /**
   * 读取**消息反馈**（E253：`messageFeedback/list`，契约 `{sessionId}` → `{items}`）。
   *
   * 会话范围（同族规则：`sessionId` 必带）。形状按契约是 `{items:[…]}`；不中就把真实顶层键记账、不猜。
   * 失败与空是两件事：**"没有反馈"是正常空态**，"读失败"要如实说原因。
   */
  async refreshFeedback(): Promise<void> {
    const scope: string = this.selectedSessionId;
    if (!this.unaryReady || scope.length === 0) {
      this.feedbackRows = [];
      this.feedbackFor = '';
      this.notify();
      return;
    }
    const inner: Record<string, Object> = {};
    inner['sessionId'] = scope;
    const args: Object | undefined = argsFor(MESSAGE_FEEDBACK_LIST_ENDPOINT, inner as Object);
    if (args === undefined) {
      this.record('messageFeedback/list 不在兼容上表');
      return;
    }
    const result: RpcResult = await this.conn.call(MESSAGE_FEEDBACK_LIST_ENDPOINT, args);
    if (!result.ok) {
      const f = result.error;
      this.record('messageFeedback/list fail ' + (f === undefined ? 'unknown' : f.code));
      return;
    }
    // 回包可能晚于一次切会话：只接受仍对应当前会话的结果
    if (this.selectedSessionId !== scope) {
      return;
    }
    const rows: FeedbackRow[] | undefined = feedbackFromReply(result.value);
    if (rows === undefined) {
      const keys: string = result.value === undefined
        ? '(空回复)' : Object.keys(result.value as Record<string, Object>).join(', ');
      this.record('messageFeedback/list shape unknown keys=' + keys);
      return;
    }
    this.feedbackRows = rows;
    this.feedbackFor = scope;
    this.record('messageFeedback/list ok ' + rows.length);
    this.notify();
  }

  /** 查某条消息的反馈（E253：界面按 messageId 取；没有则返回 undefined） */
  feedbackOf(messageId: string): FeedbackRow | undefined {
    for (let i = 0; i < this.feedbackRows.length; i++) {
      if (this.feedbackRows[i].messageId === messageId) {
        return this.feedbackRows[i];
      }
    }
    return undefined;
  }

  /**
   * 写入/替换某条助手消息的反馈（E253：`messageFeedback/put`）。
   *
   * 契约：`{sessionId, messageId, rating, note?, category?}`——上游注释是
   * *"Create or replace feedback for one assistant message"*，所以同一个 messageId 再写就是**替换**。
   * `note` 为空串时**不带上该字段**（契约里它是可选，空白由上游记为"无"）。
   */
  /**
   * 写入/替换某条助手消息的反馈。
   *
   * @param category 契约里的可选取值（`task-result` / `instruction-following` / `product-interaction` /
   *   `service-stability` / `resource-cost` / `security-privacy-permission` / `other`）。
   *   空串 = 未分类（缺省即不分类，与契约一致），此时**不发这个字段**而不是发空串——
   *   空串不是合法取值，发出去只会换来 `arguments-invalid`。
   */
  async putFeedback(messageId: string, rating: string, note: string, category: string = ''): Promise<ActionNotice> {
    if (!this.unaryReady) {
      return noticeWith('offline', 'action', 'messageFeedback.put');
    }
    const scope: string = this.selectedSessionId;
    if (scope.length === 0) {
      return notice('feedback.needs-session');
    }
    if (messageId.length === 0 || rating.length === 0) {
      return notice('feedback.incomplete');
    }
    const inner: Record<string, Object> = {};
    inner['sessionId'] = scope;
    inner['messageId'] = messageId;
    inner['rating'] = rating;
    if (note.length > 0) {
      inner['note'] = note;
    }
    if (category.length > 0) {
      inner['category'] = category;
    }
    /*
     * `ifVersion` 是契约里的必填（乐观并发）——"值为观察到的版本，或 `null` 表示要求原本不存在"。
     * E254 曾把它记成"编码待宿主确认"；**现已按上游源码核对确认**
     * （`@deepseek-ai/dsh-message-feedback/lib/types/types.d.ts` 的 `MessageFeedbackPutRequest`）：
     *   `readonly ifVersion: MessageFeedbackVersion | null`，
     *   `MessageFeedbackVersion = Branded<'MessageFeedbackVersion'>`（即字符串）。
     * 我们**能表达**的是"已有反馈 ⇒ 回传它的 version"；"要求原本不存在"（`null`）需要
     * 空值编码，而 ArkTS 的 `Record<string, Object>` 表达不了 null ⇒ 仍按能表达的方式发：
     * 新建时**不带**该字段（而不是发空串——空串不是合法 token，只会换来 `arguments-invalid`）。
     */
    const known: FeedbackRow | undefined = this.feedbackOf(messageId);
    if (known !== undefined && known.version.length > 0) {
      inner['ifVersion'] = known.version;
    }
    const args: Object | undefined = argsFor(MESSAGE_FEEDBACK_PUT_ENDPOINT, inner as Object);
    if (args === undefined) {
      return noticeWith('contract.missing', 'endpoint', MESSAGE_FEEDBACK_PUT_ENDPOINT);
    }
    const result: RpcResult = await this.conn.call(MESSAGE_FEEDBACK_PUT_ENDPOINT, args);
    if (!result.ok) {
      const f = result.error;
      const code: string = f === undefined ? 'unknown' : f.code;
      const why: string = friendlyFailure(code, f === undefined ? '' : f.message);
      this.record('messageFeedback/put fail ' + code + ' ' + (f === undefined ? '' : f.message));
      return noticeWith('feedback.failed', 'reason', why);
    }
    this.record('messageFeedback/put ok ' + messageId.substring(0, 12) + ' ' + rating);
    await this.refreshFeedback();
    return noticeWith('feedback.saved', 'rating', rating);
  }

  /**
   * 撤回某条消息的反馈（官方 `ui-message-feedback` 的 withdraw；§10 要求的闭环最后一步）。
   *
   * 【为什么必须带 ifVersion】按上游源码核对（同文件的 `MessageFeedbackDeleteRequest`）：
   * `ifVersion: MessageFeedbackVersion`（**必填、不可为 null**），语义是"观察到该条目当时的版本"。
   * 上游对该字段的注释还有一条关键信息：*"ignored when the item is already absent"* ⇒ **删除是幂等的**，
   * 重复撤回安全（`MessageFeedbackDeleteValue.absent === true` 是稳定后置条件）。
   *
   * 我们**只撤回本地已读到 version 的那条**；没读到（或 version 为空）时如实返回原因，
   * **不猜一个版本号去删**——猜错就是删掉别人/别的状态的记录。
   */
  async clearFeedback(messageId: string): Promise<ActionNotice> {
    if (!this.unaryReady) {
      return noticeWith('offline', 'action', 'messageFeedback.delete');
    }
    const scope: string = this.selectedSessionId;
    if (scope.length === 0) {
      return notice('feedback.needs-session');
    }
    if (messageId.length === 0) {
      return notice('feedback.incomplete');
    }
    const known: FeedbackRow | undefined = this.feedbackOf(messageId);
    if (known === undefined || known.version.length === 0) {
      // 没有版本就无法 CAS：这是"读不到状态"，不是"宿主拒绝了"
      return noticeWith('feedback.no-version', 'messageId', messageId.substring(0, 12));
    }
    const inner: Record<string, Object> = {};
    inner['sessionId'] = scope;
    inner['messageId'] = messageId;
    inner['ifVersion'] = known.version;
    const args: Object | undefined = argsFor(MESSAGE_FEEDBACK_DELETE_ENDPOINT, inner as Object);
    if (args === undefined) {
      return noticeWith('contract.missing', 'endpoint', MESSAGE_FEEDBACK_DELETE_ENDPOINT);
    }
    const result: RpcResult = await this.conn.call(MESSAGE_FEEDBACK_DELETE_ENDPOINT, args);
    if (!result.ok) {
      const f = result.error;
      const code: string = f === undefined ? 'unknown' : f.code;
      const why: string = friendlyFailure(code, f === undefined ? '' : f.message);
      this.record('messageFeedback/delete fail ' + code + ' ' + (f === undefined ? '' : f.message));
      return noticeWith('feedback.failed', 'reason', why);
    }
    this.record('messageFeedback/delete ok ' + messageId.substring(0, 12));
    await this.refreshFeedback();
    return notice('feedback.withdrawn');
  }

  /** 从"提供方目录"类端点取名字数组；形状不识别时返回空数组并记账（不猜） */
  private async providerNamesFrom(endpoint: string): Promise<string[]> {
    const inner: Record<string, Object> = {};
    const args: Object | undefined = argsFor(endpoint, inner as Object);
    if (args === undefined) {
      this.record(`${endpoint} 缺少参数契约`);
      return [];
    }
    const result: RpcResult = await this.conn.call(endpoint, args);
    if (!result.ok) {
      const f = result.error;
      this.record(`${endpoint} fail ${f === undefined ? 'unknown' : f.code}`);
      return [];
    }
    const value: Object | undefined = result.value;
    if (value === undefined) {
      return [];
    }
    let raw: Object[] | undefined = getArray(value, 'providers');
    if (raw === undefined) {
      raw = getArray(value, 'items');
    }
    if (raw === undefined && Array.isArray(value)) {
      raw = value as Object[];
    }
    if (raw === undefined) {
      const keys: string = Object.keys(value as Record<string, Object>).join(', ');
      this.record(`${endpoint} shape unknown keys=${keys}`);
      return [];
    }
    const out: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      const one: Object = raw[i];
      // 元素可能是字符串，也可能是带 id/name 的对象——两种都收（官方目录两种形态都可能出现）
      if (typeof one === 'string') {
        out.push(one as string);
        continue;
      }
      const id: string = getString(one, 'id') ?? getString(one, 'provider') ?? getString(one, 'name') ?? '';
      if (id.length > 0) {
        out.push(id);
      }
    }
    return out;
  }

  /**
   * 读取 Agent 预设名单（E159）。
   *
   * 【形状是实测的，不是推的】真机探针：`agentPresets/list` **不接受 `request` 包裹**
   * （带包裹会被 `gateway/arguments-invalid: unexpected "request"` 拒），传**空具名参数**才成功；
   * 回复是 `{"presets":[{id,trust,isDefault,name,description}…]}`。
   * 这与 `session/*` 那一族的 `request` 包裹**相反**——所以这里用 `argsFor` 的具名分支结果即可
   * （端点形态在兼容表里，`argsFor` 会按它处理）。
   */
  async refreshAgentPresets(): Promise<void> {
    if (!this.unaryReady) {
      this.presetNote = '尚未连接 Host，预设名单未读取。';
      this.notify();
      return;
    }
    const empty: Record<string, Object> = {};
    const args: Object | undefined = argsFor(AGENT_PRESETS_LIST_ENDPOINT, empty as Object);
    if (args === undefined) {
      this.presetNote = '兼容面缺少预设名单端点的参数契约。';
      this.notify();
      return;
    }
    const result: RpcResult = await this.conn.call(AGENT_PRESETS_LIST_ENDPOINT, args);
    if (!result.ok) {
      const f = result.error;
      const code: string = f === undefined ? 'unknown' : f.code;
      this.presetNote = `预设名单读取失败：${friendlyFailure(code, f === undefined ? '' : f.message)}`;
      this.record(`agentPresets/list fail ${code}`);
      this.notify();
      return;
    }
    const value: Object | undefined = result.value;
    const rows: AgentPresetRow[] | undefined = value === undefined ? undefined : presetsFromReply(value);
    if (rows === undefined) {
      const keys: string = value === undefined ? '(空回复)' : Object.keys(value as Record<string, Object>).join(', ');
      this.presetRows = [];
      this.presetNote = `宿主返回的预设名单形状未识别（顶层键：${keys}）；已记账，待按真实形状收紧解析。`;
      this.record(`agentPresets/list shape unknown keys=${keys}`);
      this.notify();
      return;
    }
    this.presetRows = rows;
    this.presetNote = rows.length === 0 ? '宿主报告没有可用预设。' : '';
    this.record(`agentPresets/list ok ${rows.length} 项`);
    this.notify();
  }

  /**
   * 读取技能清单（E135）。
   *
   * 【为什么解析要容忍三种形状】见 `skillsFromReply` 的说明：外层键未确证。
   * 都不中时**不猜**：把回复的键名打进旁路日志（`record`），界面上如实显示"宿主返回的形状未识别"——
   * 下一次连真机时这一条就会把真实形状写出来，然后收紧解析。
   */
  async refreshSkills(): Promise<void> {
    if (!this.unaryReady) {
      this.skillNote = '尚未连接 Host，技能清单未读取。';
      this.notify();
      return;
    }
    /*
     * E174（用户反馈：技能读取失败）——真机错误原文：
     * `failed to observe session "undefined": cannot read properties of undefined (reading 'length')`
     *
     * 【读出了什么】`skills/list` **不是"全局读名单"**，它要**观察一个会话**：
     * 技能的可调用性取决于该会话的 scope（工具/权限/预设），因此请求必须带**会话范围**。
     * 我们此前传空 `{}` ⇒ 宿主拿到 `sessionId = undefined` ⇒ 内部读 `.length` 直接抛。
     * 这也解释了"技能"页为什么一直读不出来。
     *
     * 【修法】带上当前选中的会话；**没选中会话就不发请求**，并如实说明原因——
     * "发了再报错"会把上游的 TypeError 当成本功能坏掉，是误导。
     */
    const skillScope: string = this.selectedSessionId;
    if (skillScope.length === 0) {
      this.skillRows = [];
      this.skillNote = '技能清单取决于具体会话（可调用的工具与权限随会话而定）：请先在工作区里选中一个会话，再回来看这里。';
      this.notify();
      return;
    }
    const inner: Record<string, Object> = {};
    inner['sessionId'] = skillScope;
    const args: Object | undefined = argsFor(SKILLS_LIST_ENDPOINT, inner as Object);
    if (args === undefined) {
      this.skillNote = '兼容面缺少技能清单端点的参数契约。';
      this.notify();
      return;
    }
    const result: RpcResult = await this.conn.call(SKILLS_LIST_ENDPOINT, args);
    if (!result.ok) {
      const f = result.error;
      const code: string = f === undefined ? 'unknown' : f.code;
      this.skillNote = `技能清单读取失败：${friendlyFailure(code, f === undefined ? '' : f.message)}`;
      this.record(`skills/list fail ${code}`);
      this.notify();
      return;
    }
    const value: Object | undefined = result.value;
    const rows: SkillRow[] | undefined = value === undefined ? undefined : skillsFromReply(value);
    if (rows === undefined) {
      // 形状未识别：如实记账（含真实键名），界面不假装"没有技能"
      const keys: string = value === undefined ? '(空回复)' : Object.keys(value as Record<string, Object>).join(', ');
      this.skillRows = [];
      this.skillNote = `宿主返回的技能清单形状未识别（顶层键：${keys}）；已记账，待按真实形状收紧解析。`;
      this.record(`skills/list shape unknown keys=${keys}`);
      this.notify();
      return;
    }
    this.skillRows = rows;
    this.skillNote = rows.length === 0 ? '宿主报告没有可用技能。' : '';
    this.record(`skills/list ok ${rows.length} 项`);
    this.notify();
  }

  private openControlStream(): void {
    this.cancelControl();
    const sink: StreamSink = {
      onItem: (value: Object) => {
        const frame: ControlFrame = readControlFrame(value);
        if (frame.type === ControlFrameType.BASELINE) {
          this.controlReady = true;
          // 基线里就带着**当前会话**的排队项（`queues` 是 sessionId → 条目数组）。
          // 不在这里取一次的话，用户在"轮次进行中排队了两条"之后切走再切回来，
          // 队列会显示为空——直到下一次 queue 帧到达才恢复。
          this.queuedItems = projectQueuedItems(frame.baseline === undefined
            ? emptyQueued() : queuedItemsOf(frame.baseline.queues, this.selectedSessionId));
          // 基线里带着本会话的后台任务（与 queues 同构：sessionId → 任务数组）。
          // 不读它的话，重连后任务列表会空着直到下一次状态变化——"没有"与"没收到"分不开。
          this.jobs = jobsOf(frame.baseline === undefined ? undefined : frame.baseline.jobs,
            this.selectedSessionId);
          this.record('control baseline');
          this.notify();
          return;
        }
        if (frame.type === ControlFrameType.QUEUE) {
          // 队列帧是**整份替换**（不是增量），因此直接整体覆盖。
          // 只接受当前会话的帧：别的会话的队列与正在看的这一屏无关。
          if (frame.sessionId === this.selectedSessionId) {
            this.queuedItems = projectQueuedItems(frame.items);
            this.record(`control queue ${frame.items.length} 条`);
            this.notify();
          }
          return;
        }
        if (frame.type === ControlFrameType.JOBS) {
          // 整份替换（帧给的是当前注册表全量）；只接受当前会话的帧
          if (frame.sessionId === this.selectedSessionId) {
            this.jobs = frame.jobs;
            this.record(`control jobs ${frame.jobs.length} 条`);
            this.notify();
          }
          return;
        }
        if (frame.type === ControlFrameType.PROJECTION) {
          this.record('control projection');
          return;
        }
        this.noteUnknown(`control:${frame.type}`);
      },
      onError: (code: string, message: string) => {
        this.controlCancel = undefined;
        this.record(`control error ${code}`);
        if (code !== GATEWAY_SIGNATURE_INVALID) {
          this.lastError = `控制流失败：${code} ${message}`;
        }
        this.notify();
      },
      onEnd: () => {
        this.controlCancel = undefined;
        this.record('control end');
        this.notify();
      }
    };
    // 空参数也要有声明类型：ArkTS 禁止无类型对象字面量（arkts-no-untyped-obj-literals）
    const emptyArgs: Record<string, Object> = {};
    const args: Object | undefined = argsFor(SESSION_CONTROL_ENDPOINT, emptyArgs as Object);
    if (args === undefined) {
      this.noteUnknown('control:no-args-contract');
      return;
    }
    const cancel = this.conn.openStream(SESSION_CONTROL_ENDPOINT, args, sink);
    this.controlCancel = cancel;
    this.record(`control open ${cancel === undefined ? 'failed' : 'ok'}`);
  }

  // ───────────────────────── 附件（投喂本机文件） ─────────────────────────

  /**
   * 上传一个本机文件并把得到的**回执**挂到待发附件上。
   *
   * 为什么回执必须存在中枢而不是视图里：回执是 **Agent 作用域**的
   * （上游注释：只在接收它的 Agent 作用域内有效），因此它天然绑定
   * 「当前会话」这份状态——而那是中枢独占的。放在视图里会在多窗口下
   * 出现「两个窗口各持一份回执、其中一份已经因会话切换而失效」。
   *
   * @param name 展示名（Host 会再消毒一次）
   * @param base64 文件字节的规范 base64（由 `platform.pickDocument` 产出）
   * @param bytes 精确字节数（仅用于界面展示）
   */
  async attachLocalFile(name: string, base64: string, bytes: number,
    mediaType: string): Promise<AttachOutcome> {
    const agentId: string = this.selectedSessionId;
    if (agentId.length === 0) {
      return { ok: false, name: name, reason: '请先选择一个会话：附件回执绑定在会话作用域上。' };
    }
    if (!this.unaryReady) {
      return { ok: false, name: name, reason: '当前离线，无法上传附件。连接恢复后请重新选择文件。' };
    }
    const payload: Object | undefined = fileUploadPayload(agentId, base64, name);
    if (payload === undefined) {
      return { ok: false, name: name, reason: '该 Host 不提供附件上传端点（兼容面上表里没有它）。' };
    }
    const result: RpcResult = await this.conn.call(fileUploadEndpoint(), payload);
    if (!result.ok) {
      const failure = result.error;
      const code: string = failure === undefined ? 'unknown' : failure.code;
      const message: string = failure === undefined ? '' : failure.message;
      this.record(`upload fail ${code}`);
      return { ok: false, name: name, reason: friendlyFailure(code, message) };
    }
    const uploaded: FileUploadValue | undefined = projectFileUpload(result.value);
    if (uploaded === undefined) {
      // 没有回执就没法构造 `filePart()`。**不能**乐观地认为「上传成功」：
      // 那样用户会看到一个附件条目，而它发出去时会被 Host 判为未知回执。
      this.record('upload ok 但缺 receiptId');
      return { ok: false, name: name, reason: '上传已返回，但没有回执 id（上游回复缺 receiptId）。' };
    }
    const next: PendingAttachment[] = this.attachmentList.slice();
    next.push({
      receiptId: uploaded.receiptId,
      name: uploaded.file.name.length > 0 ? uploaded.file.name : name,
      bytes: uploaded.file.bytes > 0 ? uploaded.file.bytes : bytes,
      mediaType: mediaType
    });
    this.attachmentList = next;
    this.record(`upload ok ${uploaded.file.name} ${uploaded.file.bytes}B`);
    this.notify();
    return { ok: true, name: uploaded.file.name, reason: '' };
  }

  /**
   * 把 Host 侧的工作区文件投喂成附件。
   *
   * 路径是「读整文件字节 → 上传拿回执」，而不是「把路径塞进提示词」：
   * 上游的提示词里附件只有两种载体（内联 base64 图片 / 上传回执），
   * **没有**「引用一个 Host 路径」这种形式。发一个路径字符串只会变成普通文本，
   * 用户以为把文件给了 agent，实际只给了一个文件名。
   *
   * 用 `readAll` 而不是 `read`：后者只返回 UTF-8 文本（非文本直接拒绝），
   * 拿不到可上传的字节；`readAll` 返回完整 base64。
   */
  async attachWorkspaceFile(path: string, name: string, bytes: number): Promise<AttachOutcome> {
    const scope: string = this.fileTreeFor.length > 0 ? this.fileTreeFor : this.selectedSessionId;
    if (scope.length === 0) {
      return { ok: false, name: name, reason: '尚未确定文件浏览的作用域（请先选一个工作区）。' };
    }
    if (!this.unaryReady) {
      return { ok: false, name: name, reason: '当前离线，无法读取与上传文件。' };
    }
    if (bytes > MAX_ATTACHMENT_BYTES) {
      return {
        ok: false, name: name,
        reason: `文件超过端侧附件上限（${bytes} 字节 > ${MAX_ATTACHMENT_BYTES} 字节），请改用更小的文件。`
      };
    }
    const payload: Object | undefined = workspaceReadAllPayload(scope, path);
    if (payload === undefined) {
      return { ok: false, name: name, reason: '该 Host 不提供整文件读取端点（兼容面上表里没有它）。' };
    }
    const result: RpcResult = await this.conn.call(workspaceReadAllEndpoint(), payload);
    if (!result.ok) {
      const code: string = result.error === undefined ? 'unknown' : result.error.code;
      this.record(`ws readAll fail ${code}`);
      return { ok: false, name: name, reason: friendlyWorkspaceFailure(code, result.error === undefined ? '' : result.error.message) };
    }
    const content: WorkspaceBytesWire | undefined = projectWorkspaceBytes(result.value);
    if (content === undefined) {
      // 没有字节就不能上传。**不能**用一个空 base64 顶上：
      // 那会产生一个 0 字节的附件，而用户以为文件已经带上。
      this.record('ws readAll ok 但无 data');
      return { ok: false, name: name, reason: 'Host 未返回文件内容（回复里没有 data）。' };
    }
    return await this.attachLocalFile(name, content.data, content.bytes, '');
  }

  /** 移除一个待发附件（只影响本地列表；Host 侧的回执会自然过期） */
  removeAttachment(receiptId: string): void {
    const next: PendingAttachment[] = [];
    for (let i = 0; i < this.attachmentList.length; i++) {
      if (this.attachmentList[i].receiptId !== receiptId) {
        next.push(this.attachmentList[i]);
      }
    }
    this.attachmentList = next;
    this.notify();
  }

  /**
   * 清空待发附件。
   *
   * 切会话时必须调用：回执是 Agent 作用域的，带着上一个会话的回执去发
   * 会被 Host 判为未知回执（`session/attachment-invalid` / `FILE_NOT_STAGED`）。
   */
  clearAttachments(): void {
    if (this.attachmentList.length === 0) {
      return;
    }
    this.attachmentList = [];
    this.notify();
  }

  // ───────────────────────── 排队项（已提交但未进入轮次） ─────────────────────────

  /**
   * 修改一个排队项的动作。
   *
   * 三个动作都走同一个端点（`session/updateQueue`），Host 处理完会推一份**整份**的
   * `queue` 帧回来，因此这里**不做乐观更新**：本地改一份、Host 再推一份，
   * 两份一旦不一致（例如 Host 拒绝了这次编辑），界面就会停在错误的状态上，
   * 而用户以为自己改成功了。等 Host 的回帧是唯一不会说谎的做法。
   */
  private async updateQueue(action: QueueActionBody, itemId: string): Promise<boolean> {
    const sessionId: string = this.selectedSessionId;
    if (sessionId.length === 0 || itemId.length === 0) {
      return false;
    }
    if (!this.unaryReady) {
      this.lastError = '当前离线，无法修改待发队列。';
      this.notify();
      return false;
    }
    const payload: Object | undefined = sessionUpdateQueuePayload(sessionId, itemId, action);
    if (payload === undefined) {
      this.lastError = '兼容面缺少队列更新端点的参数契约';
      this.notify();
      return false;
    }
    const result: RpcResult = await this.conn.call(SESSION_UPDATE_QUEUE_ENDPOINT, payload);
    if (!result.ok) {
      const failure = result.error;
      const code: string = failure === undefined ? 'unknown' : failure.code;
      this.lastError = `修改待发队列失败：${friendlyFailure(code, failure === undefined ? '' : failure.message)}`;
      this.record(`updateQueue fail ${code}`);
      this.notify();
      return false;
    }
    this.record(`updateQueue ok ${action.kind}`);
    return true;
  }

  /** 移除一个排队项。 */
  async removeQueuedItem(itemId: string): Promise<boolean> {
    return await this.updateQueue(queueRemoveAction(), itemId);
  }

  /** 把排队项提前为**插话**（打断当前轮次，立即处理）。 */
  async steerQueuedItem(itemId: string): Promise<boolean> {
    return await this.updateQueue(queueSteerAction(), itemId);
  }

  /**
   * 改写排队项的正文。
   *
   * 「取回编辑」的实现方式（先移除、再把文本放进输入框）**不用**这个函数：
   * 那是一次本地动作 + 一次移除，不需要把文本回传 Host。
   * 本函数留给"就地改一行、直接提交"的路径（当前 UI 未使用，但契约在此，
   * 避免将来有人绕开 `queueEditAction` 自己拼块）。
   */
  async editQueuedItem(itemId: string, text: string): Promise<boolean> {
    const trimmed: string = text.trim();
    if (trimmed.length === 0) {
      // 上游要求 `content` 非空（D2b）：发空内容必然被拒，不如提前说清楚
      this.lastError = '排队项内容不能为空（Host 拒绝空内容的编辑）。';
      this.notify();
      return false;
    }
    return await this.updateQueue(queueEditAction([trimmed]), itemId);
  }

  // ───────────────────────── 发送与取消 ─────────────────────────

  /**
   * 发送提示词。
   *
   * 离线时进入待发队列（D3 §3.6「离线排队」）：网络恢复后由 `flushOutbox()` 按序补发。
   * `requestId` 由客户端生成，用于把乐观回显与最终落盘消息对上（上游 `SessionPromptRequest`
   * 的 `requestId` 就是为这个用途存在的）。
   */
  async sendPrompt(text: string): Promise<boolean> {
    const sessionId: string = this.selectedSessionId;
    if (sessionId.length === 0) {
      this.lastError = '尚未选择会话';
      this.notify();
      return false;
    }
    const trimmed: string = text;
    if (trimmed.trim().length === 0) {
      return false;
    }
    const requestId: string = mintRequestId();
    if (!this.unaryReady) {
      // 【离线时**不**排队附件】回执是会话作用域的、且有生命周期
      // （进入某个 prompt 的收件箱后 Host 就回收它）。排队一条「等会儿再发」的
      // 附件消息，几乎注定在补发时因回执已失效而失败，而用户以为它会发出去。
      // 因此离线时只排文本，并明确告知附件不会跟着走。
      if (this.attachmentList.length > 0) {
        this.lastError = '当前离线：已加入待发队列，但**附件不会随队列发送**，请恢复连接后重新添加附件。';
      } else {
        this.lastError = '当前离线：已加入待发队列，连接恢复后自动发送';
      }
      this.outboxList.push({ requestId: requestId, sessionId: sessionId, text: trimmed, at: Date.now() });
      this.notify();
      return false;
    }
    return await this.sendPromptNow(requestId, sessionId, trimmed);
  }

  private async sendPromptNow(requestId: string, sessionId: string, text: string): Promise<boolean> {
    // 只把「属于本次会话」的附件带上：会话可能在入队后切换过，
    // 而回执绑定会话——带上别的会话的回执会被 Host 判为未知回执。
    const content: PromptContentPart[] = [textPart(text)];
    for (let i = 0; i < this.attachmentList.length; i++) {
      content.push(filePart(this.attachmentList[i].receiptId));
    }
    const args: Object | undefined =
      promptPayload(requestId, sessionId, PromptMode.QUEUE, content, '');
    if (args === undefined) {
      this.lastError = '兼容面缺少提示词端点的参数契约';
      this.notify();
      return false;
    }
    const result: RpcResult = await this.conn.call(SESSION_PROMPT_ENDPOINT, args);
    if (result.ok && projectSessionPrompt(result.value).accepted) {
      this.running = true;
      // 回执「成功进入收件箱」后即被 Host 回收，因此本地列表必须同时清空：
      // 留着它下次再发会被判为未知回执，而用户以为附件还在。
      this.attachmentList = [];
      this.record(`prompt accepted ${requestId.substring(0, 8)}`);
      this.notify();
      return true;
    }
    if (result.ok) {
      // `ok` 但没被接受（上游回复缺 `accepted`）——**不当作成功**：
      // 乐观清空附件会让用户丢失一次上传，而失败的原因被掩盖。
      this.lastError = '发送未获确认：Host 没有明确接受这次提示词。';
      this.record('prompt ok 但未 accepted');
      this.notify();
      return false;
    }
    const failure = result.error;
    this.lastError = `发送失败：${friendlyFailure(failure === undefined ? 'unknown' : failure.code, failure === undefined ? '' : failure.message)}`;
    this.record(`prompt fail ${failure === undefined ? '?' : failure.code}`);
    this.notify();
    return false;
  }

  /** 网络恢复后按序补发待发队列 */
  private async flushOutbox(): Promise<void> {
    if (!this.unaryReady || this.outboxList.length === 0) {
      return;
    }
    const queue: OutboxEntry[] = this.outboxList;
    this.outboxList = [];
    for (let i = 0; i < queue.length; i++) {
      const entry: OutboxEntry = queue[i];
      await this.sendPromptNow(entry.requestId, entry.sessionId, entry.text);
    }
    this.notify();
  }

  /** 取消当前轮次（D3 §5.1 Esc / 停止按钮） */
  async cancelTurn(): Promise<boolean> {
    const sessionId: string = this.selectedSessionId;
    if (sessionId.length === 0) {
      return false;
    }
    const request: Record<string, Object> = {};
    request['sessionId'] = sessionId;
    // 【E101】同前：不要手工包 `request`（`argsFor` 按端点形态自己包）
    const args: Object | undefined = argsFor(SESSION_CANCEL_ENDPOINT, request as Object);
    if (args === undefined) {
      return false;
    }
    const result: RpcResult = await this.conn.call(SESSION_CANCEL_ENDPOINT, args);
    if (result.ok) {
      this.running = false;
      this.record('cancel accepted');
      this.notify();
      return true;
    }
    const failure = result.error;
    this.lastError = `取消失败：${friendlyFailure(failure === undefined ? 'unknown' : failure.code, failure === undefined ? '' : failure.message)}`;
    this.notify();
    return false;
  }

  // ───────────────────────── 诊断 ─────────────────────────

  /** 连接诊断 + 中枢自身事实（D1 §7.8 五项的落点） */
  async diagnose(): Promise<DiagnosticReport> {
    return await this.conn.diagnose();
  }

  // ───────────────────────── 内部工具 ─────────────────────────

  private titleOf(sessionId: string): string {
    for (let i = 0; i < this.sessions.length; i++) {
      if (this.sessions[i].id === sessionId) {
        return this.sessions[i].title;
      }
    }
    return '';
  }

  private upsertPending(item: PendingItem): void {
    const next: PendingItem[] = [];
    let replaced: boolean = false;
    for (let i = 0; i < this.pendingList.length; i++) {
      if (this.pendingList[i].id === item.id) {
        next.push(item);
        replaced = true;
      } else {
        next.push(this.pendingList[i]);
      }
    }
    if (!replaced) {
      next.push(item);
      // 【只对新出现的项发通知】重复的 `upsert` 来自快照重放与断线重连，
      // 每次都发会让同一个待决项在锁屏上刷屏；而 `upsert` 的语义是"同一 id 覆盖"，
      // 只有 `!replaced` 才是"这是一件新事情"。
      this.publishPendingNotice(item);
    }
    this.pendingList = next;
    this.notify();
  }

  private resolvePending(pendingId: string, note: string): void {
    this.record(`pending resolved ${pendingId.substring(0, 8)} ${note}`);
    this.removePending(pendingId);
  }

  private resolvePendingById(eventId: string, note: string): void {
    const renderId: string | undefined = this.waterfallEventIds.get(eventId);
    this.waterfallEventIds.delete(eventId);
    if (renderId !== undefined) {
      this.resolvePending(renderId, note);
      return;
    }
    this.removePending(eventId);
  }

  private removePending(pendingId: string): void {
    const next: PendingItem[] = [];
    let removed: PendingItem | undefined = undefined;
    for (let i = 0; i < this.pendingList.length; i++) {
      if (this.pendingList[i].id !== pendingId) {
        next.push(this.pendingList[i]);
      } else {
        removed = this.pendingList[i];
      }
    }
    this.pendingList = next;
    // 待决项处理完就撤回它的通知：留着会让用户在一个已经答复过的问题上继续点。
    const hooks: NotifyHooks | undefined = this.notifyHooks;
    if (removed !== undefined && hooks !== undefined) {
      hooks.onPendingResolved(withdrawalKeysForPending(removed));
    }
    this.notify();
  }

  /** 发布一条待决项通知（未注入钩子时静默跳过——没有通知不等于丢事件） */
  private publishPendingNotice(item: PendingItem): void {
    const hooks: NotifyHooks | undefined = this.notifyHooks;
    if (hooks === undefined) {
      return;
    }
    hooks.onPending(notifyInputForPending(item, this.titleOf(item.sessionId), this.hostName));
  }

  /** 注入通知钩子（由持有 `UIAbilityContext` 的能力层调用；传 undefined 可撤销） */
  setNotifyHooks(hooks: NotifyHooks | undefined): void {
    this.notifyHooks = hooks;
  }

  /** 轮次结束 → 一条完成或失败的通知（失败判据见调用处） */
  private publishTurnNotice(turnEndEvent: Object): void {
    const hooks: NotifyHooks | undefined = this.notifyHooks;
    if (hooks === undefined) {
      return;
    }
    const data: Object | undefined = getRecord(turnEndEvent, 'data');
    const reason: Object | undefined = data === undefined ? undefined : getRecord(data, 'reason');
    const kind: string = reason === undefined ? '' : (getString(reason, 'kind') ?? '');
    const failed: boolean = kind === 'error';
    const sessionId: string = this.selectedSessionId;
    hooks.onTurn(notifyInputForTurn(sessionId, this.titleOf(sessionId), this.hostName, failed));
  }

  private record(line: string): void {
    /*
     * E164：**记账必须先出去，再谈留档**。
     *
     * 此前这里有两个"看不见"的问题叠加：① 只写应用内 trace、**不写 hilog**（hdc 侧看不到）；
     * ② 而且被 `traceEnabled`（界面上的旁路日志开关）挡着——默认关闭 ⇒ **平时一行都不产出**。
     * 结果是：本项目一路写的"如实记账"（工作区流、技能/预设形状、归档/删除结果…）
     * 在真机排障时**等于不存在**，我只能靠猜（本轮就在"流没开"和"开了没数据"之间卡住）。
     * 现在改成：**无条件 `console.info`**（ArkTS 的 console 会进 hilog，tag=JSAPP，hdc 可直接 grep），
     * 应用内 trace 仍尊重开关（那是给用户看的界面，不是排障通道）。
     */
    console.info(`DSHM-TRACE ${line}`);
    if (!this.traceEnabled) {
      return;
    }
    const next: string[] = this.traceLines.slice();
    next.push(`${new Date().toISOString().substring(11, 23)}  ${line}`);
    while (next.length > TRACE_LIMIT) {
      next.shift();
    }
    this.traceLines = next;
  }

  /**
   * 记录一条我们**不认识**的上游事件类型。
   *
   * 存在理由：轨迹的事件类型清单无法从「我们没有的文档」里得到，
   * 但我们可以在真实设备上**观测**到它。把未识别类型汇总在诊断页，
   * 一次真机运行就能得到权威清单——把「未知」变成可观测、可收敛的缺口，
   * 而不是让它静默丢失。
   */
  private noteUnknown(kind: string): void {
    for (let i = 0; i < this.unknownTypes.length; i++) {
      if (this.unknownTypes[i] === kind) {
        return;
      }
    }
    const next: string[] = this.unknownTypes.slice();
    next.push(kind);
    this.unknownTypes = next;
    this.record(`unknown ${kind}`);
    this.notify();
  }
}

// ───────────────────────── 纯函数：线上事件 → 呈现契约 ─────────────────────────

/**
 * 把一条 `session/follow` 记录投影成轨迹条目。
 *
 * 【取值路径从哪来（这一版的关键变化）】
 *   字段名与取值路径**全部**来自 `dshcompat` 的实测形状表
 *   （`SESSION_EVENT_SHAPES`，见 D2 §8.7.7：逐帧解码 Host 落盘日志取得）。
 *   本文件不再持有任何字段名——这不是纪律上的洁癖：**写错字段名不会报错，
 *   只会让正文永远是空的**，这种失效必须在编译期与门禁上被拦住。
 *
 *   上一版这里把整段 `data` 用 `JSON.stringify` 塞进正文，理由是
 *   「字段名还没有实测证据」。证据现已取得，那条妥协随之失效：
 *   用户该看到的是消息正文，不是一段 JSON。
 *
 * 【未识别事件怎么办】
 *   形状表里没有的类型（升级后新出现的）**不静默丢弃**：仍按消息呈现原始
 *   `data` 并标记展开，同时由 `noteUnknown()` 汇总到诊断页，
 *   让下次升级时能回填形状表。宁可多一行「未识别」，也不要让对话少一截。
 */
/**
 * 把一条记录投影成**一组**条目（E112：一条消息里可以夹带多个工具调用）。
 *
 * 【为什么需要它】真机截图暴露了旧行为：助手消息的 `content` 里除了思考与正文，
 * 还夹着 `tool-call` 块，而 `splitBlocks` 只认识文本 ⇒ 界面出现 `[tool-call]` 占位，
 * 甚至把一整段 `{"id":…,"toolName":"write","callId":…}` 当成助手正文显示出来。
 * 官方 web 把这类块渲染成**工具卡**（名字 + 参数 + 状态 + 结果），这里就在数据层分出条目，
 * 视图层无需再猜。
 *
 * 兼容：`projectWireRecord`（单条）保持原样导出，老调用点不受影响。
 */
export function projectWireRecords(record: Object): TrajectoryItem[] {
  const primary: TrajectoryItem | undefined = projectWireRecord(record);
  const out: TrajectoryItem[] = [];
  if (primary !== undefined) {
    out.push(primary);
  }
  const tools: TrajectoryItem[] = toolItemsOfRecord(record);
  for (let i = 0; i < tools.length; i++) {
    out.push(tools[i]);
  }
  return out;
}

/**
 * 记录里夹带的工具调用块 → 工具卡条目。
 *
 * 认得的块类型：`tool-call` / `tool_call` / `tool-use` / `tool_use`。
 * 工具名与参数按**多个候选字段**取（上游不同适配器用 `toolName`/`name`、`arguments`/`args`/`input`），
 * 取到哪个算哪个——取不到名字就不造条目（宁可少一行，也不要一张没有名字的工具卡）。
 */
function toolItemsOfRecord(record: Object): TrajectoryItem[] {
  const out: TrajectoryItem[] = [];
  const event: Object | undefined = getRecord(record, 'event');
  if (event === undefined) {
    return out;
  }
  const data: Object | undefined = getRecord(event, 'data');
  if (data === undefined) {
    return out;
  }
  const time: number = getNumber(event, 'time') ?? 0;
  const seq: number = getNumber(event, 'seq') ?? 0;
  // 消息块可能直接放在 data.content，也可能在 data.message.content
  const message: Object | undefined = getRecord(data, 'message');
  const blocks: Object[] | undefined = getArray(data, 'content')
    ?? (message === undefined ? undefined : getArray(message, 'content'));
  if (blocks === undefined) {
    return out;
  }
  for (let i = 0; i < blocks.length; i++) {
    const block: Object = blocks[i];
    const blockType: string = getString(block, 'type') ?? '';
    if (!isToolCallBlock(blockType)) {
      continue;
    }
    const name: string = firstStringOf(block, ['toolName', 'name', 'tool']);
    if (name.length === 0) {
      continue;
    }
    const item: TrajectoryItem = makeItem(`ev-tool-${seq}-${i}`, TrajectoryKind.TOOL, time);
    item.speaker = Speaker.ASSISTANT;
    item.toolName = name;
    item.toolArgs = firstStringOf(block, ['arguments', 'args', 'input', 'parameters']);
    item.callId = firstStringOf(block, ['callId', 'id', 'toolCallId']);
    if (item.callId.length > 0) {
      item.id = `ev-call-${item.callId}`;
    }
    item.toolState = ToolState.RUNNING;
    out.push(item);
  }
  return out;
}

function isToolCallBlock(type: string): boolean {
  return type === 'tool-call' || type === 'tool_call' || type === 'tool-use' || type === 'tool_use';
}

/** 依次尝试多个字段名，返回第一个非空字符串（上游字段名不统一，这是实测的应对） */
function firstStringOf(container: Object, keys: string[]): string {
  for (let i = 0; i < keys.length; i++) {
    const value: string | undefined = getString(container, keys[i]);
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }
  return '';
}

/**
 * 操作结果的**结构化回执**（E143 方案①的样板）。
 *
 * 【为什么不让中枢直接给字符串】中枢是纯 TS 模块、没有 UI 上下文 ⇒ 既拿不到资源、
 * 也不知道用户在用哪种语言。让中枢产出**码 + 参数**、由视图层本地化，是唯一
 * 不把 UI 依赖倒灌进状态层的做法（与"协议事实集中在 dshcompat、展示逻辑归视图"同一条纪律）。
 *
 * `code` 用点分命名（`workspace.deleted`），`params` 只放**数据**（名字、id、Host 给的原因），
 * 不放任何整句文案。视图层若遇到不认识的码，必须回落到"显示码本身 + 数据"，
 * 而不是显示空白——那会让人以为操作没发生。
 */
export interface ActionNotice {
  code: string;
  params: Record<string, string>;
}

/**
 * 构造回执（唯一的构造点）。
 *
 * 【为什么不是一个 `notice(code, {…})`】ArkTS 的 `arkts-no-untyped-obj-literals` 不允许
 * 把**无类型的对象字面量**当作参数传出去；而这里恰恰需要"键值对任意"的载荷。
 * 于是提供两个无字面量的构造器：不带参数的、以及带**单个键值**的
 * （需要两个以上键时连续调用 `put()` 追加即可）。
 */
export function notice(code: string): ActionNotice {
  const params: Record<string, string> = {};
  return { code: code, params: params };
}

/** 带一个键值参数的回执 */
export function noticeWith(code: string, key: string, value: string): ActionNotice {
  const n: ActionNotice = notice(code);
  n.params[key] = value;
  return n;
}

/** 追加一个键值参数（返回自身，便于链式书写） */
export function put(n: ActionNotice, key: string, value: string): ActionNotice {
  n.params[key] = value;
  return n;
}

/** 工作区注册表的一行（E132：`workspace/follow` 投影） */
export interface WorkspaceRow {
  id: string;
  path: string;
  title: string;
  /** 该工作区记账的会话数（注册表给的是 sessionIds，这里只留数量供列表显示） */
  sessionCount: number;
}

/** 单个 `WorkspaceView` → 行；没有 id 就不造行（id 是删除/归档唯一的键） */
function projectWorkspaceRow(view: Object): WorkspaceRow | undefined {
  const id: string = getString(view, 'workspaceId') ?? '';
  if (id.length === 0) {
    return undefined;
  }
  const sessionIds: Object[] | undefined = getArray(view, 'sessionIds');
  return {
    id: id,
    path: getString(view, 'path') ?? '',
    title: getString(view, 'title') ?? '',
    sessionCount: sessionIds === undefined ? 0 : sessionIds.length
  };
}

function projectWorkspaceRows(baseline: Object): WorkspaceRow[] {
  const items: Object[] | undefined = getArray(baseline, 'items');
  const out: WorkspaceRow[] = [];
  if (items === undefined) {
    return out;
  }
  for (let i = 0; i < items.length; i++) {
    const row: WorkspaceRow | undefined = projectWorkspaceRow(items[i]);
    if (row !== undefined) {
      out.push(row);
    }
  }
  return out;
}

/** 取字符串数组（缺字段一律空数组——"没有"与"没读到"在这里无需区分） */
/**
 * 按字面键取一个字段（`connection` 的取值工具只吃点分路径，
 * 而上游的键名可能含点 ⇒ pi-ai 的 `providers.<route>` 这类结构必须按字面键取）。
 */
function fieldOf(source: Object | undefined, key: string): Object | undefined {
  if (source === undefined || source === null || typeof source !== 'object' || Array.isArray(source)) {
    return undefined;
  }
  return (source as Record<string, Object>)[key];
}

function getStringArray(container: Object, key: string): string[] {
  const raw: Object[] | undefined = getArray(container, key);
  const out: string[] = [];
  if (raw === undefined) {
    return out;
  }
  for (let i = 0; i < raw.length; i++) {
    const one: Object = raw[i];
    if (typeof one === 'string') {
      out.push(one as string);
    }
  }
  return out;
}

/** 技能清单的一行（E135：`dsh-skill` 的 `SkillSummary` 摘出来的可显示字段） */
export interface SkillRow {
  name: string;
  description: string;
  whenToUse: string;
  provider: string;
}

/**
 * Agent 预设名单的一行（E159 真机确证）。
 *
 * 真机返回字段：`id` / `trust` / `isDefault` / `name` / `description`。
 * 语义（用户纠正 + 官方文档）：预设 = **一个会话的 Agent 所运行的插件组装**（工具/提示词/能力）。
 * `trust === 'system'` 表示**随附预设**：只读展示，不提供复制/删除（官方如此）。
 */
export interface AgentPresetRow {
  id: string;
  name: string;
  description: string;
  trust: string;
  isDefault: boolean;
}

/** 是否随附（只读）预设 */
export function presetIsBundled(row: AgentPresetRow): boolean {
  return row.trust === 'system';
}

/**
 * 解析 `agentPresets/list` 的回复（E159 真机形状：`{presets:[…]}`）。
 *
 * 【为什么这里可以"直接认 presets 键"】与 skills 不同：**这个形状是真机探针实测到的**
 * （`args={}` → `{"presets":[…]}`，5 项），不是从类型定义推的。仍然容忍缺字段：
 * 没有 `id` 的行跳过（id 是后续 copy/delete 的键），其余字段缺就是空。
 */
function presetsFromReply(value: Object): AgentPresetRow[] | undefined {
  const raw: Object[] | undefined = getArray(value, 'presets');
  if (raw === undefined) {
    return undefined;
  }
  const out: AgentPresetRow[] = [];
  for (let i = 0; i < raw.length; i++) {
    const one: Object = raw[i];
    const id: string = getString(one, 'id') ?? '';
    if (id.length === 0) {
      continue;
    }
    out.push({
      id: id,
      name: getString(one, 'name') ?? '',
      description: getString(one, 'description') ?? '',
      trust: getString(one, 'trust') ?? '',
      isDefault: getBoolean(one, 'isDefault') === true
    });
  }
  return out;
}

/**
 * 从 `skills/list` 的回复里取技能数组（E135）。
 *
 * 【为什么容忍三种形状】类型定义只给了**单个摘要**的字段，没说列表挂在哪：
 * `{skills:[…]}` / `{items:[…]}` / 裸数组都可能。这里三种都试，
 * **都不中就返回 undefined**，由调用方如实记账（把真实键名打进旁路日志），
 * 而不是猜一个键名然后把它当成事实用一整个版本。
 */
function skillsFromReply(value: Object): SkillRow[] | undefined {
  let raw: Object[] | undefined = getArray(value, 'skills');
  if (raw === undefined) {
    raw = getArray(value, 'items');
  }
  if (raw === undefined && Array.isArray(value)) {
    raw = value as Object[];
  }
  if (raw === undefined) {
    return undefined;
  }
  const out: SkillRow[] = [];
  for (let i = 0; i < raw.length; i++) {
    const one: Object = raw[i];
    const name: string = getString(one, 'name') ?? '';
    if (name.length === 0) {
      continue;
    }
    out.push({
      name: name,
      description: getString(one, 'description') ?? '',
      whenToUse: getString(one, 'whenToUse') ?? '',
      provider: getString(one, 'provider') ?? ''
    });
  }
  return out;
}

/**
 * 从 `goals/get` 的回复里取目标文本（E242）。
 *
 * 形状未确证 ⇒ 依次尝试：`value` 是字符串；`goal` 是字符串；`goal` 是对象里的
 * `text`/`objective`/`title`/`description`；顶层直接带这些键。**都不中返回 undefined**，
 * 由调用方把真实顶层键记账——不猜键名（本会话已用这条纪律避过多次误判）。
 */
function goalTextFromReply(value: Object | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value as string;
  }
  const GOAL_TEXT_KEYS: string[] = ['text', 'objective', 'title', 'description', 'content'];
  const goal: Object | undefined = getRecord(value, 'goal');
  if (goal !== undefined) {
    const nested: string = firstStringOf(goal, GOAL_TEXT_KEYS);
    if (nested.length > 0) {
      return nested;
    }
    // goal 是对象但没有可读文本 ⇒ 仍算"读到了、只是为空"
    return '';
  }
  const direct: string = firstStringOf(value, GOAL_TEXT_KEYS);
  if (direct.length > 0) {
    return direct;
  }
  return undefined;
}

/* E242 备注：原本我还写了一个 firstStringOf，但**它已经存在**（构建报重复实现）——已删除并复用既有的那个。
   这正是本项目"先查再写"的纪律：新增辅助函数前先搜一遍，否则同一功能会有两份实现（本会话已因此返工数次）。 */

/**
 * 一条消息反馈（E253：官方 `ui-message-feedback`）。
 *
 * 字段按上游契约：`messageId` + `rating`（总体判断）+ `note?`（说明）+ `category?`（分类）。
 * 我们只存渲染需要的四个字符串，避免把上游类型整棵搬进来。
 */
/**
 * 反馈类别（契约 D2b §6.7 给出的取值域，7 个）。
 *
 * 【为什么把线上取值与界面文案放在一起】取值域是**契约事实**，文案是它的显示名；
 * 两者分开写必然漂移（加了一个取值，界面还显示旧的 6 个）。放在一处，改的时候一眼看到。
 */
export interface FeedbackCategory {
  /** 线上取值（发 `messageFeedback/put` 的 `category`） */
  id: string;
  /** 界面文案 */
  label: string;
}

export const FEEDBACK_CATEGORIES: FeedbackCategory[] = [
  { id: 'task-result', label: '任务结果' },
  { id: 'instruction-following', label: '指令遵循' },
  { id: 'product-interaction', label: '产品交互' },
  { id: 'service-stability', label: '服务稳定性' },
  { id: 'resource-cost', label: '资源消耗' },
  { id: 'security-privacy-permission', label: '安全隐私权限' },
  { id: 'other', label: '其他' }
];

export interface FeedbackRow {
  messageId: string;
  rating: string;
  note: string;
  category: string;
  /**
   * 乐观并发令牌（E254）。
   *
   * 上游 `MessageFeedbackItem.version` 的注释是 *"Equality-only token replaced by every material
   * create or update"*；写入时必须回传 `ifVersion`（值就是它，或 `null` 表示"要求原本不存在"）。
   * 空串 = 我们没拿到（只可能出现在"新建"场景）⇒ 调用方据此决定怎么带 `ifVersion`。
   */
  version: string;
}

/** 从 `messageFeedback/list` 的回复取反馈行（`{items:[…]}`；缺 id 的行跳过——id 是写入的键） */
function feedbackFromReply(value: Object | undefined): FeedbackRow[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const raw: Object[] | undefined = getArray(value, 'items');
  if (raw === undefined) {
    return undefined;
  }
  const out: FeedbackRow[] = [];
  for (let i = 0; i < raw.length; i++) {
    const one: Object = raw[i];
    const messageId: string = getString(one, 'messageId') ?? '';
    if (messageId.length === 0) {
      continue;
    }
    out.push({
      messageId: messageId,
      rating: getString(one, 'rating') ?? '',
      note: getString(one, 'note') ?? '',
      category: getString(one, 'category') ?? '',
      version: getString(one, 'version') ?? ''
    });
  }
  return out;
}

export function projectWireRecord(record: Object): TrajectoryItem | undefined {
  const type: string = getString(record, 'type') ?? '';
  if (type !== 'event') {
    return undefined;
  }
  const event: Object | undefined = getRecord(record, 'event');
  if (event === undefined) {
    return undefined;
  }
  const eventType: string = getString(event, 'type') ?? '';
  const seq: number = getNumber(event, 'seq') ?? 0;
  const time: number = getNumber(event, 'time') ?? 0;
  const data: Object | undefined = getRecord(event, 'data');
  const shape: SessionEventShape | undefined = eventShapeOf(eventType);

  // 审计类事件不进轨迹：它们没有用户可读内容，放进去只会淹没对话
  if (isAuditEventType(eventType)) {
    return undefined;
  }
  // 边界事件（轮次/步/标题…）驱动状态但不占行——一次对话会被它们刷屏
  if (shape !== undefined && !shape.standalone) {
    return undefined;
  }

  const family: EventFamily = classifyEventType(eventType);
  const kind: TrajectoryKind = familyKind(family);
  const item: TrajectoryItem = makeItem(`ev-${seq}`, kind, time);
  /*
   * 角色三分（E109）：用户 / 系统 / 助手。
   *
   * 以前只有"用户或助手"两分，于是 `system/message`（系统提示词）被标成**助手**，
   * 真机截图里就出现了一条"助手说：You are an AI agent powered by DeepSeek Harness…"。
   * 官方 web 不把系统上下文放进对话视图——这里标对角色，视图层才能在对话里隐去、
   * 在轨迹里可查。
   */
  item.speaker = isUserAuthoredEvent(eventType) ? Speaker.USER
    : (isSystemAuthoredEvent(eventType) ? Speaker.SYSTEM : Speaker.ASSISTANT);
  /*
   * P0-1：这一条**是不是用户可见的会话内容**，在拿到事件类型名的此刻一次性判定。
   *
   * 【为什么必须在这里判定，而不是在视图里】"内部事件"是**来源事实**（系统提示词、斜杠命令、
   * 上下文压缩、以及**未识别类型**——后者的正文是原始载荷 JSON），不是内容特征；
   * 靠正文文本或 speaker 去猜必然漏（`command/run` 与 `compaction/summary` 都戴着
   * "助手"的角色）。判定用 `dshcompat` 的结构化白名单，视图只读结论。
   */
  item.internal = !isConversationVisibleEvent(eventType);

  if (shape === undefined) {
    // 未识别类型：如实呈现原始载荷（不是猜测，也不丢弃）
    item.body = data === undefined ? '' : (JSON.stringify(data) ?? '');
    item.expanded = true;
    return item;
  }
  const text: ResolvedSlot = resolveSlot(data, shape, ContentSlot.CONTENT_BLOCKS);
  if (text.found) {
    // E107：按块类型拆分——思考进 `reasoning`（折叠块），正文进 `body`
    const split: BlockText = splitBlocks(text.value);
    item.reasoning = split.reasoning;
    item.body = split.body;
  }
  const model: ResolvedSlot = resolveSlot(data, shape, ContentSlot.MODEL);
  if (model.found) {
    item.model = asText(model.value);
  }

  if (kind === TrajectoryKind.TOOL) {
    applyToolSlots(item, data, shape);
    // 用调用 id 作条目 id：`tool/call` 与 `tool/result` 因此落到同一张工具卡
    const callId: ResolvedSlot = resolveSlot(data, shape, ContentSlot.CALL_ID);
    if (callId.found) {
      item.callId = asText(callId.value);
      item.id = `ev-call-${item.callId}`;
    }
  } else if (kind === TrajectoryKind.SUBAGENT) {
    const label: ResolvedSlot = resolveSlot(data, shape, ContentSlot.SUBAGENT_LABEL);
    if (label.found) {
      item.title = asText(label.value);
    }
    item.subagentName = item.title;
  } else if (kind === TrajectoryKind.GOAL) {
    const objective: ResolvedSlot = resolveSlot(data, shape, ContentSlot.GOAL_TITLE);
    if (objective.found) {
      item.title = asText(objective.value);
    }
    const phase: ResolvedSlot = resolveSlot(data, shape, ContentSlot.GOAL_PHASE);
    if (phase.found) {
      item.progress = asText(phase.value);
    }
  } else if (kind === TrajectoryKind.JOB) {
    applyTodoSlots(item, data, shape);
  } else if (kind === TrajectoryKind.DELIVERABLE) {
    applyDeliverableSlots(item, data, shape);
  } else if (!text.found) {
    // 压缩摘要等「有正文但无 role」的事件：摘要就是正文
    const summary: ResolvedSlot = resolveSlot(data, shape, ContentSlot.SUMMARY);
    if (summary.found) {
      item.body = asText(summary.value);
    }
  }

  if (kind === TrajectoryKind.ERROR) {
    // 失败信号默认展开：D3 §4 要求失败必须可见，而不是等用户点开
    item.expanded = true;
    const retry: ResolvedSlot = resolveSlot(data, shape, ContentSlot.RETRY);
    if (retry.found) {
      item.title = `重试 ${asText(retry.value)}`;
    }
  }
  return item;
}

/**
 * 把投影结果并入列表：同 id 则合并，否则追加。
 *
 * 为什么不是简单 `push`：`tool/call` 与 `tool/result` 共享同一个条目 id
 * （由 `callId` 派生），而**只有 call 携带工具名**。若各占一行，
 * 用户看到的是「没有名字的工具卡 + 不知出处的输出」。
 * 合并策略与到达顺序无关（见 `mergeTrajectoryItem`）。
 */
function appendOrMerge(items: TrajectoryItem[], incoming: TrajectoryItem): void {
  const at: number = indexOfItem(items, incoming.id);
  if (at < 0) {
    items.push(incoming);
    return;
  }
  items[at] = mergeTrajectoryItem(items[at], incoming);
}

/**
 * 在文件树里找一个节点（深度优先）。
 *
 * 为什么按路径找而不是持有节点引用：ArkUI 的 `@State` 在更新时**复制数组**
 * （`this.fileNodes = next`），旧引用会指向被替换掉的旧树。
 * 按路径查找与「树被重建过几次」无关，因此不会拿到失效引用。
 */
function findNode(nodes: FileNode[], path: string): FileNode | undefined {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].path === path) {
      return nodes[i];
    }
    const hit: FileNode | undefined = findNode(nodes[i].children, path);
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}

/** 不可变替换：返回一棵把 `path` 处节点换成 `next` 的新树。 */
function replaceNode(nodes: FileNode[], path: string, next: FileNode): FileNode[] {
  const out: FileNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node: FileNode = nodes[i];
    if (node.path === path) {
      out.push(next);
      continue;
    }
    if (node.children.length === 0) {
      out.push(node);
      continue;
    }
    out.push({
      name: node.name, path: node.path, kind: node.kind, size: node.size,
      modifiedAt: node.modifiedAt, loaded: node.loaded,
      children: replaceNode(node.children, path, next), deliverable: node.deliverable
    });
  }
  return out;
}

/** 展开：挂上子节点并标记已加载。 */
function expandNode(node: FileNode, children: FileNode[]): FileNode {
  return {
    name: node.name, path: node.path, kind: node.kind, size: node.size,
    modifiedAt: node.modifiedAt, loaded: true, children: children, deliverable: node.deliverable
  };
}

/**
 * 折叠：**保留**已加载的子节点。
 *
 * 保留的理由：折叠只是视觉状态，丢弃子节点会让再次展开又打一次 RPC；
 * 而 `loaded` 已经表达了「拉过了」，清空它等于把一次成功的结果扔掉。
 */
function collapseNode(node: FileNode): FileNode {
  return {
    name: node.name, path: node.path, kind: node.kind, size: node.size,
    modifiedAt: node.modifiedAt, loaded: node.loaded, children: node.children,
    deliverable: node.deliverable
  };
}

/**
 * 文件读取失败的上游错误码 → 用户可读理由。
 *
 * 上游对不可预览的文件是**明确拒绝**（D2b §2.3），拒绝理由本身就是给用户的信息；
 * 但要翻译成「发生了什么 + 可以做什么」，而不是把错误码抛到界面上（D3 §4 文案纪律）。
 */
function friendlyWorkspaceFailure(code: string, message: string): string {
  if (code === 'workspace-file/not-text') {
    return '二进制文件（非 UTF-8 文本），端侧不预览。可在 Host 侧用工具读取。';
  }
  if (code === 'workspace-file/too-large') {
    return '文件超过 Host 的单页上限，端侧不预览。可在 Host 侧用工具分段读取。';
  }
  if (code === 'workspace-file/not-regular-file') {
    return '不是一个普通文件（可能是目录或符号链接），无法预览。';
  }
  if (code === 'workspace-file/not-found') {
    return '文件不存在或已被移动。';
  }
  if (code === 'workspace-file/outside-workspace') {
    return '该路径在会话工作区之外，Host 拒绝访问。';
  }
  return message.length > 0 ? `读取失败：${message}（${code}）` : `读取失败：${code}`;
}

/** 空的排队项数组（规避无类型数组字面量）。 */
function emptyQueued(): SessionQueuedItem[] {
  const list: SessionQueuedItem[] = [];
  return list;
}

/** 形状表里一个槽位的解析结果 */
interface ResolvedSlot {
  /** 是否命中了某条路径（命中但值为空串也算命中——空串是有效内容） */
  found: boolean;
  value: Object | undefined;
}

/**
 * 按形状表取一个槽位的值。
 *
 * 只走形状表给出的那**一条**路径。**不做任何类型转换、不做候选回退**：
 * 取到的可能是字符串、数组、对象，由调用方按槽位语义解释。
 * 路径取不到就如实「没取到」——静默回退到别的字段名比取不到更危险。
 */
function resolveSlot(data: Object | undefined, shape: SessionEventShape,
  slot: ContentSlot): ResolvedSlot {
  const binding: SlotBinding | undefined = slotBinding(shape, slot);
  if (binding === undefined || data === undefined) {
    return { found: false, value: undefined };
  }
  const value: Object | undefined = readPath(data, binding.path);
  if (value === undefined) {
    return { found: false, value: undefined };
  }
  return { found: true, value: value };
}

/** 按块类型拆开的文本（E107）：思考与正文分开，视图层才能分开展示 */
interface BlockText {
  reasoning: string;
  body: string;
}

/**
 * 判断一个内容块是否为**思考**块。
 *
 * 上游用过的类型名不止一个（`reasoning` / `thinking` / `analysis`），所以按**集合**判断，
 * 而不是只认一个字符串——漏认的后果是思考又混回正文里，界面上看不出区别。
 */
function isReasoningBlock(type: string): boolean {
  return type === 'reasoning' || type === 'thinking' || type === 'analysis'
    || type === 'reasoning-text' || type === 'reasoning_text';
}

/**
 * `content` 块数组 → `{reasoning, body}`（E107）。
 *
 * 真机取证：助手消息常常是 `[{type:'reasoning',…},{type:'text',…}]`，早先的 `textFromBlocks`
 * 把它们**拼成一段**，于是界面上"思考"和"回答"糊在同一个气泡里（截图可见：先一段英文自述、
 * 再一句回答）。官方 web 把思考收进**折叠块**、正文单独成段；这里先把两者分开。
 */
function splitBlocks(value: Object | undefined): BlockText {
  if (typeof value === 'string') {
    return { reasoning: '', body: value as string };
  }
  if (!Array.isArray(value)) {
    return { reasoning: '', body: asText(value) };
  }
  const blocks: Object[] = value as Object[];
  const reasoning: string[] = [];
  const body: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block: Object = blocks[i];
    const blockType: string = getString(block, 'type') ?? '';
    if (isReasoningBlock(blockType)) {
      const text: string | undefined = getString(block, 'text');
      if (text !== undefined && text.length > 0) {
        reasoning.push(text);
      }
      continue;
    }
    // 工具调用块由 `toolItemsOfRecord` 单独出条目（工具卡），正文里不再留 `[tool-call]` 占位
    if (isToolCallBlock(blockType)) {
      continue;
    }
    // 工具结果块：正文在内层 content 里（实测）
    const nested: Object[] | undefined = getArray(block, 'content');
    if (nested !== undefined && blockType === 'tool-result') {
      const inner: string = textFromBlocks(nested);
      if (inner.length > 0) {
        body.push(inner);
      }
      continue;
    }
    const text: string | undefined = getString(block, 'text');
    if (text !== undefined) {
      body.push(text);
      continue;
    }
    if (blockType.length > 0 && blockType !== 'text') {
      // 非文本块：显示类型占位，不猜内部结构
      body.push(`[${blockType}]`);
    }
  }
  return { reasoning: reasoning.join('\n'), body: body.join('\n') };
}

/**
 * `content` 块数组 → 文本。
 *
 * 实测形状（D2 §8.7.7）：`array<{type:'text', text}>`。
 * 需要处理两种真实的嵌套：
 *   1. `tool/result` 的块是 `{type:'tool-result', content:[…]}`——正文在**内层** `content`；
 *   2. 非文本块的内部形状**仍未实测**，因此按块类型名占位，
 *      而不是猜它的字段名去渲染（猜错只会显示空白，且不报错）。
 * 若整段根本不是数组（旧版或异常），按字符串处理。
 */
function textFromBlocks(value: Object | undefined): string {
  if (typeof value === 'string') {
    return value as string;
  }
  if (!Array.isArray(value)) {
    return asText(value);
  }
  const blocks: Object[] = value as Object[];
  const parts: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block: Object = blocks[i];
    // 工具结果块：正文在内层 content 里（实测）
    const nested: Object[] | undefined = getArray(block, 'content');
    if (nested !== undefined && getString(block, 'type') === 'tool-result') {
      const inner: string = textFromBlocks(nested);
      if (inner.length > 0) {
        parts.push(inner);
      }
      continue;
    }
    const text: string | undefined = getString(block, 'text');
    if (text !== undefined) {
      parts.push(text);
      continue;
    }
    const blockType: string = getString(block, 'type') ?? '';
    if (blockType.length > 0 && blockType !== 'text') {
      // 非文本块：显示类型占位，不猜内部结构
      parts.push(`[${blockType}]`);
    }
  }
  return parts.join('\n');
}

/** 把任意 JSON 值渲染成一行可读文本（用于标题类槽位） */
function asText(value: Object | undefined): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value as string;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${value}`;
  }
  return JSON.stringify(value) ?? '';
}

/** 工具类事件的槽位填充（名称 / 参数 / 输出 / 配对 id） */
function applyToolSlots(item: TrajectoryItem, data: Object | undefined,
  shape: SessionEventShape): void {
  const name: ResolvedSlot = resolveSlot(data, shape, ContentSlot.TOOL_NAME);
  if (name.found) {
    item.toolName = asText(name.value);
  }
  const args: ResolvedSlot = resolveSlot(data, shape, ContentSlot.TOOL_ARGS);
  if (args.found) {
    // 实测：`arguments` 已是 JSON 编码后的**字符串**；直接显示，不要二次编码
    item.toolArgs = asText(args.value);
  }
  const output: ResolvedSlot = resolveSlot(data, shape, ContentSlot.TOOL_OUTPUT);
  if (output.found) {
    item.toolOutput = asText(output.value);
  } else {
    const blocks: ResolvedSlot = resolveSlot(data, shape, ContentSlot.CONTENT_BLOCKS);
    if (blocks.found) {
      item.toolOutput = textFromBlocks(blocks.value);
    }
  }
  const callId: ResolvedSlot = resolveSlot(data, shape, ContentSlot.CALL_ID);
  if (callId.found) {
    item.callId = asText(callId.value);
  }

  if (item.toolState === ToolState.PENDING) {
    // 形状里有没有「工具名」绑定，决定这是调用帧还是结果帧——
    // 不去看工具名**字符串**是否为空：结果帧本来就不携带工具名（实测），
    // 用字符串判空会把每个结果都当成「还没开始的调用」。
    item.toolState = slotBinding(shape, ContentSlot.TOOL_NAME) === undefined
      ? ToolState.SUCCESS
      : ToolState.RUNNING;
  }

  // 实测：失败的结果帧同时带内层 `isError:true` 与顶层 `error{name,code}`。
  // 只看 `message.content` 会把失败显示成成功——最典型的静默错误。
  const isError: boolean | undefined = boolSlot(data, shape, ContentSlot.TOOL_IS_ERROR);
  const errorCode: ResolvedSlot = resolveSlot(data, shape, ContentSlot.TOOL_ERROR_CODE);
  const errorName: ResolvedSlot = resolveSlot(data, shape, ContentSlot.TOOL_ERROR_NAME);
  if (isError === true || errorCode.found || errorName.found) {
    item.toolState = ToolState.FAILED;
    const label: string = errorName.found ? asText(errorName.value) : asText(errorCode.value);
    if (label.length > 0 && item.toolOutput.indexOf(label) < 0) {
      item.toolOutput = item.toolOutput.length === 0 ? label : `${item.toolOutput}\n[${label}]`;
    }
    // D3 §4：失败默认展开
    item.expanded = true;
  }
}

/** 读一个布尔槽位（值不是布尔时视为未取到） */
function boolSlot(data: Object | undefined, shape: SessionEventShape,
  slot: ContentSlot): boolean | undefined {
  const resolved: ResolvedSlot = resolveSlot(data, shape, slot);
  if (!resolved.found) {
    return undefined;
  }
  return typeof resolved.value === 'boolean' ? resolved.value as boolean : undefined;
}

/** 交付物类事件的槽位填充（实测：`files` 是数组，取第一项） */
function applyDeliverableSlots(item: TrajectoryItem, data: Object | undefined,
  shape: SessionEventShape): void {
  const path: ResolvedSlot = resolveSlot(data, shape, ContentSlot.DELIVERABLE_FILE);
  const desc: ResolvedSlot = resolveSlot(data, shape, ContentSlot.DELIVERABLE_DESC);
  if (path.found) {
    const full: string = asText(path.value);
    item.fileName = full;
    item.title = full;
  }
  if (desc.found) {
    item.progress = asText(desc.value);
    item.body = item.progress;
  }
  if (item.title.length === 0) {
    item.title = '交付物';
  }
}

/** 任务清单类事件的槽位填充（`array<{content,status}>`） */
function applyTodoSlots(item: TrajectoryItem, data: Object | undefined,
  shape: SessionEventShape): void {
  const list: ResolvedSlot = resolveSlot(data, shape, ContentSlot.TODO_LIST);
  if (!list.found || !Array.isArray(list.value)) {
    return;
  }
  const todos: Object[] = list.value as Object[];
  const lines: string[] = [];
  let done: number = 0;
  for (let i = 0; i < todos.length; i++) {
    const content: string = getString(todos[i], 'content') ?? '';
    const status: string = getString(todos[i], 'status') ?? '';
    if (status === 'completed') {
      done++;
    }
    const mark: string = status === 'completed' ? '✓' : (status === 'in_progress' ? '▸' : '·');
    lines.push(`${mark} ${content}`);
  }
  item.body = lines.join('\n');
  item.title = `任务清单（${done}/${todos.length}）`;
  item.progress = item.title;
  item.percent = todos.length === 0 ? -1 : Math.round(done * 100 / todos.length);
}

/** 上游呈现家族（`dshcompat.EventFamily`）→ 本层轨迹枚举 */
function familyKind(family: EventFamily): TrajectoryKind {
  if (family === EventFamily.REASONING) {
    return TrajectoryKind.REASONING;
  }
  if (family === EventFamily.TOOL) {
    return TrajectoryKind.TOOL;
  }
  if (family === EventFamily.SUBAGENT) {
    return TrajectoryKind.SUBAGENT;
  }
  if (family === EventFamily.GOAL) {
    return TrajectoryKind.GOAL;
  }
  if (family === EventFamily.JOB) {
    return TrajectoryKind.JOB;
  }
  if (family === EventFamily.ERROR) {
    return TrajectoryKind.ERROR;
  }
  if (family === EventFamily.DELIVERABLE) {
    return TrajectoryKind.DELIVERABLE;
  }
  return TrajectoryKind.MESSAGE;
}

/**
 * 审批的三选。
 *
 * id 取自 `Trajectory.ets` 的稳定契约（桩数据与中枢必须一致，否则「主选项判定」会失效——
 * 真实发生过：桩用 `once`、中枢用 `allow`，导致真机上危险动作的拒绝按钮拿不到主选样式）。
 *
 * 上游只有一次性授权与拒绝（见 `decideApproval` 的词汇纪律说明），
 * 因此第三项「本次会话内均允许」必须是**本地策略**，文案如实说明，
 * 不能让用户以为它改变了 Host 的行为。
 */
function approvalChoices(): PendingChoice[] {
  return [
    { id: APPROVAL_CHOICE_ALLOW, label: '允许一次', detail: '仅本次放行' },
    { id: APPROVAL_CHOICE_ALLOW_ALWAYS, label: '本次会话内均允许', detail: '仅在本客户端生效，Host 侧仍逐次询问' },
    { id: APPROVAL_CHOICE_DENY, label: '拒绝', detail: '阻止该操作' }
  ];
}

/** 由工具名推断风险等级（D3 §3.4「危险动作视觉权重反转」） */
function riskOfTool(toolName: string): RiskLevel {
  const lower: string = toolName.toLowerCase();
  if (lower.indexOf('bash') >= 0 || lower.indexOf('pwsh') >= 0 || lower.indexOf('shell') >= 0
    || lower.indexOf('delete') >= 0 || lower.indexOf('rm') >= 0 || lower.indexOf('write') >= 0
    || lower.indexOf('edit') >= 0) {
    return RiskLevel.DANGEROUS;
  }
  if (lower.indexOf('web') >= 0 || lower.indexOf('fetch') >= 0 || lower.indexOf('git') >= 0) {
    return RiskLevel.ELEVATED;
  }
  return RiskLevel.NORMAL;
}

/** 生成客户端请求 id（用于乐观回显与落盘消息对账） */
function mintRequestId(): string {
  const hex: string = '0123456789abcdef';
  let out: string = '';
  for (let i = 0; i < 32; i++) {
    out += hex.charAt(Math.floor(Math.random() * 16));
  }
  return `req-${out.substring(0, 8)}-${out.substring(8, 12)}-${out.substring(12, 16)}-${out.substring(16, 20)}-${out.substring(20)}`;
}

/**
 * 认证失败的用户可见建议。
 *
 * D3 §4 纪律：错误文案必须包含「发生了什么 + 可以做什么」，
 * 禁止裸抛技术栈信息。因此这里把状态码翻译成可执行动作。
 */
function authAdvice(status: number, message: string): string {
  if (status === 401) {
    return 'Host 拒绝了本次访问（未认证）。请回到「添加 Host」重新粘贴带令牌的启动链接。';
  }
  if (status === 403) {
    return 'Host 的信任栅栏拒绝了该来源。请确认你是通过本机回环地址或已配对的隧道访问，而不是直接暴露 Host。';
  }
  if (status === 404) {
    return '该地址上没有 dsh Web 服务。请确认 Host 已启动，且端口与链接中的一致。';
  }
  return `连接失败（HTTP ${status}）：${message}。请检查网络与 Host 状态后重试。`;
}

/**
 * 把载体层失败码翻译成「发生了什么 + 可以做什么」。
 *
 * 为什么必须做这层翻译（有实测驱动）：首次真机端到端验证时，界面显示的是
 * `carrier/parse invalid JSON body for session/list`。这条消息对用户毫无用处——
 * 它既不说清是网络问题还是 Host 问题，也指不出下一步。而 D3 §4 明确要求
 * 每条失败文案都要给出可执行动作。
 *
 * 这几条翻译背后是一个**真实的排查结论**：`carrier/parse` 与 `carrier/closed`
 * 同时出现，说明载体链路本身不可靠（典型场景是用 `hdc rport` 之类的开发转发
 * 通道承载多条并发长连接），而不是 Host 或协议栈的问题——
 * 同样的调用从宿主直连全部成功。文案要能把用户引向这个判断。
 */
function friendlyFailure(code: string, message: string): string {
  if (code === 'client/endpoint-invalid') {
    return `客户端拼装了一个 Host 不认识的 endpoint（${message}）。这是本客户端的兼容面缺陷，`
      + '请提交诊断报告以便修正上表——重试与换网络都不会有用。';
  }
  if (code === 'carrier/parse') {
    return '响应无法解析——通常是中间转发通道截断了连接（开发期的端口转发常见）。'
      + '请改用直连本机回环，或使用 hostkit 的加密隧道。'
      + (message.length > 0 ? `（底层原因：${message}）` : '');
  }
  if (code === 'carrier/closed' || code === 'carrier/transport') {
    /*
     * 【为什么必须把底层 `message` 带上（E71）】`reason` 一路从
     * `RemoteMux.onSocketClosed(reason)`（`:457` 以 `onError('carrier/closed', reason)` 传给每条
     * 逻辑流）传到这里，内容通常是**明确的**——例如 `探活超时（连接级）：在阈值内未收到任何回帧`
     * 或 `send 失败 code=-1`。但这条固定文案把它覆盖掉了，于是端侧只能看到
     * "连接在传输中断开"，排查被迫从零开始猜（本项目为此耗掉数轮，且一度把方向指向"转发通道"）。
     * 带上它，一次运行就能判定该改探活判死策略还是发送时机。
     */
    return '连接在传输中断开——中间转发通道不稳定，或 Host 已停止。'
      + '请检查 Host 是否仍在运行；若经端口转发访问，请改用 hostkit 隧道。'
      + (message.length > 0 ? `（底层原因：${message}）` : '');
  }
  if (code === 'carrier/timeout') {
    return '请求超时。请检查网络连通性；若 Host 负载很高可稍后重试。';
  }
  if (code === GATEWAY_ARGUMENTS_INVALID || code === GATEWAY_INPUT_INVALID) {
    return `调用参数与 Host 的契约不符（${message}）。这是客户端兼容面的问题，请提交诊断报告以便修正上表。`;
  }
  return `${code} ${message}`;
}
