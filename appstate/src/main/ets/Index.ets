/**
 * 状态层对外入口（HAR 模块 appstate）。
 *
 * 上层（entry 页面与视图）只应通过本入口导入。
 */

// ── Web 权限裁决（纯逻辑，可单测）──
export { isLoopbackOrigin, shouldGrantWebPermission, AUDIO_CAPTURE_RESOURCE } from './model/WebPermission';

// ── 语音音频换算（路线 A：HMS 系统语音识别的 48k→16k 重采样与定长分块）──
export {
  HMS_SAMPLE_RATE,
  HMS_CHUNK_BYTES,
  HMS_CHUNK_BYTES_ALT,
  HMS_MAX_AUDIO_MS,
  BYTES_PER_SAMPLE,
  isValidAudioChunk,
  slicePcmChunks,
  resamplePcm16,
  pcmDurationMs,
  makeTonePcm16,
  mergeTranscript,
  WAV_HEADER_BYTES,
  WAV_BYTES_PER_SECOND,
  isNearSilence
} from './model/SpeechPcm';

// ── 会话列表 ──
export { projectSessionList, sessionListEndpoint, sessionListPayload } from './model/SessionList';
export type { SessionListItem, SessionListPage } from './model/SessionList';

// ── 轨迹与待决的呈现层契约 ──
export {
  APPROVAL_CHOICE_ALLOW,
  APPROVAL_CHOICE_ALLOW_ALWAYS,
  APPROVAL_CHOICE_DENY,
  PendingKind,
  RiskLevel,
  Speaker,
  ToolState,
  TrajectoryKind,
  indexOfItem,
  makeItem,
  mergeTrajectoryItem,
  itemsOfKind,
  deliverablesOf
} from './model/Trajectory';
export type {
  PendingChoice,
  PendingItem,
  TrajectoryItem
} from './model/Trajectory';

// ── 呈现层纯函数 ──
export {
  formatBytes,
  formatClock,
  formatDate,
  formatDuration,
  LARGE_OUTPUT_BYTES,
  LARGE_OUTPUT_PREVIEW,
  pendingSortKey,
  previewOutput,
  relativeTime,
  riskLabel,
  sessionSubtitle,
  sortPending,
  speakable,
  toolStateIsProblem,
  toolStateLabel
} from './model/Present';
export type { OutputPreview } from './model/Present';

// ── 工作区与文件 ──
export {
  fileSummary,
  languageOf,
  NodeKind,
  PREVIEW_LIMIT_BYTES,
  PreviewKind,
  previewKindOf
} from './model/Workspace';
export type { FileNode, FilePreview, WorkspaceItem } from './model/Workspace';
/** E132：工作区注册表行（带 workspaceId；声明在 SessionHub，这里对外转出） */
export type { WorkspaceRow } from './store/SessionHub';
/** E160：Agent 预设名单行与其"随附只读"判定 */
export type { AgentPresetRow } from './store/SessionHub';
/** E253：消息反馈行（供界面按 messageId 取用） */
export type { FeedbackCategory, FeedbackRow } from './store/SessionHub';
export { presetIsBundled } from './store/SessionHub';
/** E135：技能清单行 */
export type { SkillRow } from './store/SessionHub';
/** E145：结构化操作回执（中枢产出码+参数，视图层本地化） */
export type { ActionNotice } from './store/SessionHub';

// ── 设置 / 凭据 / 插件 / 设备 / 诊断 / 模型 ──
export {
  humanizeKey,
  mergeSettingsGroups,
  modelSelectionLabel,
  pluginSummary,
  projectCredentials,
  projectCredentialRefs,
  projectDefaultSelection,
  projectModelCatalog,
  projectPluginInventory,
  projectSettingsEntries,
  projectGeneralGroups,
  GENERAL_NAMESPACES,
  projectSettingsGroups,
  projectSettingsNamespace,
  parseSettingInput,
  parseStructInput,
  SettingKind,
  SettingOrigin,
  SettingValueType,
  DEFAULT_MODEL_NS,
  SettingsWriteOutcome,
  settingsDomainOfNs,
  settingsMutateArgs,
  settingsUnsetArgs,
  splitSettingKey
} from './model/Settings';
export { sessionContextLine, workspaceNameOf } from './model/SessionContext';
export { sheetNoteText, sheetNoteVisible } from './model/Sheets';
export { placeholderOf, structSettingEditorHints, textSettingEditorHints } from './model/SettingEditors';
export type { EditorHints } from './model/SettingEditors';
// pi-ai 路由（对齐官方 Models 页：逐字段编辑 + 自定义模型 API 创建表单）
export {
  PIAI_SETTINGS_NS,
  baseURLPlaceholder,
  buildRouteProfile,
  changedScalarFields,
  checkApiKeyDraft,
  checkBaseURL,
  checkModels,
  checkProtocol,
  checkRoute,
  deriveKeyRef,
  emptyModelRow,
  emptyProviderView,
  isHttpUrl,
  isRouteValid,
  modelsDiffer,
  modelsPayload,
  piAiFieldPath,
  piAiModelsPath,
  piAiProtocolChoices,
  piAiRoutePath,
  projectPiAiModels,
  projectPiAiProviders,
  protocolLabel,
  scalarFieldValue
} from './model/PiAiProviders';
export type { PiAiFieldCheck, PiAiModelRow, PiAiProviderView } from './model/PiAiProviders';
export type {
  AboutInfo,
  ConnectionBanner,
  CredentialItem,
  CredentialWriteResult,
  DiagEntry,
  DiagReport,
  HostRecord,
  ModelOption,
  ModelSelection,
  PluginItem,
  SettingChoice,
  SettingGroup,
  SettingItem,
  SettingInputResult,
  SettingsGroupEntry,
  SettingsKeyParts,
  SettingsNamespaceItems,
  SettingsNamespaceState,
  SettingsWriteResult
} from './model/Settings';

// ── 「关于」与诊断空态（**不是桩数据**：全部从 dshcompat 实时派生） ──
export { aboutInfo } from './model/StubData2';
export { emptyDiagReport } from './model/Diag';
// 诊断模式（D7 §3 第 4 项）：本地核心 / 远程 Host 分流
export { DiagMode, diagHintOf, diagModeOf, diagTitleOf, filterDiagEntries } from './model/Diag';

// ── 会话内搜索（D3 §5.1 的 Ctrl/Cmd + F） ──
export { chatRowOfItemIndex, matchConversationIndices, matchCounterText, matchTrajectoryIndices, stepMatch } from './model/Search';

// ── 详情栏分区（从真实轨迹派生，D3 §3.6） ──
export { projectDetailSections } from './model/Detail';
export type { DetailSection } from './model/Detail';

// ── 端侧核心的呈现契约（D6 §2/§6）：阶段、运行时事实、版本行、插件分类、动作可用性 ──
export {
  CorePhase,
  PluginNative,
  buildCoreView,
  classifyPlugin,
  corePhaseLabel,
  corePhaseOfHostState,
  emptyCoreView,
  fact,
  pluginNativeOf,
  sessionEmptyCopy,
  unknownFact
} from './model/Core';
export type { CoreActionSpec, CoreFact, CoreVersionRow, CoreViewInput, CoreViewState, EmptyCopy, PluginRow } from './model/Core';

// ── 核心页投影（宿主报告的结构子集 → 事实与行） ──
export { pluginInventoryFact, pluginRowOf, rankPluginRows } from './model/CoreProjection';
export type { PluginInventoryTotals } from './model/CoreProjection';

// ── 断点与导航模型 ──
export {
  detailPanelAvailable,
  layoutModeOf,
  navPresentation,
  NavPresentation,
  NavTab,
  LayoutMode,
  settingsSectionLabelRes,
  sidebarPanelLabelRes,
  sidebarPanelSymbol,
} from './ui/Breakpoints';

// ── 设计令牌 ──
export { Border, Breakpoint, Dur, Fs, Lh, Radius, SemanticColor, Sp, Sz } from './ui/Tokens';

// ── 工具呈现（P2 §11：按工具类别区分呈现；纯函数，可本机直接测） ──
export { presentTool, toolA11y, toolDefaultExpanded, ToolKind, toolKindLabel, toolKindOf, toolSummaryOf, toolToneOf } from './model/ToolPresentation';
export { parseMarkdown, parseInline, plainTextOf, MdBlock, MdBlockKind, MdSpan } from './model/Markdown';
export type { ToolPresentation } from './model/ToolPresentation';

// ── 改动对照（P2 §11：编辑类工具出"改了什么"；纯函数，可本机直接测） ──
export { collapseContext, diffLines, diffStatOf, DiffLineKind, intendedDiffOf, presentDiff } from './model/ToolDiff';
export type { DiffLine, DiffPresentation, DiffStat, ToolDiff } from './model/ToolDiff';

// ── 输入模态策略（P1/P3：触控+鼠标+键盘同一套语义；纯函数，可本机直接测） ──
export { contextMenuGestures, contextMenuHintLabel, hoverEnabled, MenuGesture } from './model/InputPolicy';
export type { InputModality } from './model/InputPolicy';

// ── 页面框架：面板注册表与导航状态（P0：官方信息架构对齐；纯逻辑，可本机直接测） ──
export {
  createPanelRegistry, PanelLocation, PanelRegistry, rightbarPanels, sidebarPanels,
  sidebarEntries, sidebarPinnedEntries, SIDEBAR_PINNED_ORDER,
  settingsSections,
  PANEL_RIGHT_DELIVERABLES, PANEL_RIGHT_DETAIL, PANEL_RIGHT_FILES, PANEL_RIGHT_PREVIEW, PANEL_RIGHT_SUBAGENT,
  PANEL_RIGHT_TOOL, PANEL_RIGHT_TRAJECTORY, PANEL_SIDEBAR_CORE, PANEL_SIDEBAR_SETTINGS,
  PANEL_SIDEBAR_WORKSPACES,
} from './model/PanelRegistry';
export type { PanelDescriptor, PanelList } from './model/PanelRegistry';
export {
  activeMainPanelOf,
  mainPanelOfSidebarPanel,
  sidebarPanelOfMainPanel,
copyOf, defaultRightPanel, DrawerState, enterSession,
  initialNavigationState, legacyTabOfMainPanel, mainPanelOfLegacyTab, mainPanels,
  defaultSidebarPanel, navigateToMain, openSettings, selectRightPanel, setDrawer,
  sidebarPanelIdOfTab,
  MAIN_CONNECT, MAIN_CONVERSATION, MAIN_CORE, MAIN_DIAGNOSTICS, MAIN_SETTINGS, MAIN_WORKSPACES,
  SETTINGS_CORE, SETTINGS_DEVICE, SETTINGS_GENERAL, SETTINGS_INVENTORY, SETTINGS_MODELS,
  SETTINGS_PLUGINS, SETTINGS_PRESETS, SETTINGS_SKILLS,
} from './model/NavigationState';
export type { NavigationState } from './model/NavigationState';

// ── 三条轨道在四形态下的呈现（P0：AppFrame 的几何层） ──
export { shellTracksOf, sidebarExpandedForMode, sidebarPresentationOf, sidebarTrackWidthOf, TrackPresentation } from './ui/ShellTracks';
export type { ShellTracks } from './ui/ShellTracks';

// ── 后台任务（P2：会话头部的任务注册表；纯函数，可本机直接测） ──
export {
  jobCountLabel, jobDotState, jobDurationText, jobDurationTitle, jobElapsedMs, jobIsLive,
  jobListA11y, jobListVisible, jobRowStatusText, jobStatusLabel, jobTickerNeeded,
  liveJobCount, orderedJobs, JobDot,
} from './model/Jobs';

// ── 轨迹时间线（P2 §11：交互式时间总览；纯函数，可本机直接测） ──
export {
  cellIdAtRatio, cellIdForListIndex, listIndexForCell, segmentOrdinalOf, statsLinesOf,
  timelineCellsOf, timelineKindLabel, timelineKindOf, timelineScaleOf,
  timelineStartedLabel, timelineTotalLabel, TimelineKind, StatsUnit,
} from './model/Timeline';
export type {
  SessionStatsInput, StatsLine, TimelineCell, TimelineScale, TimelineSegment,
} from './model/Timeline';

// ── 输入模态事实（P3：形态猜测 / 系统枚举 / 事件证据三者按优先级合成；纯函数，可本机直接测） ──
export {
  flattenSources, guessFromKeyboardForm, modalityFromSources, modalityOf, modalityTrace,
  noModality, sourceIsKeyboard, sourceIsPointer, unionModality,
} from './model/InputFacts';
export type { ModalityEvidence } from './model/InputFacts';

// ── 贴底跟随模型（P1 §8：sticky-follow 独立管理；纯函数，可本机直接测） ──
export { followTimerShouldRun, FollowSignal, nextFollowing, shouldJumpOnNewItems } from './model/Follow';

// ── 回合模型（P1 §8：Turn → ProcessGroup + Answer；纯函数，可本机直接测） ──
export {
  chatVisibleItems,
  conversationAudienceOf,
  ConversationAudience,
  defaultExpanded,
  groupTurns,
  hasProcessGroup,
  needsInternalIsolation,
  processSummary
} from './model/Turns';
export type { Turn } from './model/Turns';
export type { SessionJob } from './model/Jobs';

// ── HarmonyTheme（P1.5：Web 语义 → HarmonyOS 视觉的映射层） ──
export {
  harmonyTokenFor,
  HarmonyBorder,
  HarmonyColor,
  HarmonyElevation,
  HarmonyIconSize,
  HarmonyMaterial,
  HarmonyMotion,
  HarmonyRadius,
  HarmonySpacing,
  HarmonyTouch,
  HarmonyType,
  WEB_TOKEN_MAP
} from './ui/HarmonyTheme';
export type { ShadowLevel, TypeRole, WebTokenMapping } from './ui/HarmonyTheme';

// ── 布局决策（P1：形态/几何决策的唯一落点，见 LayoutController 的说明） ──
export {
  breakpointThresholds,
  clampDetailDesired,
  concedeDetail,
  decideLayout,
  decideLayoutWithDetail,
  detailPresentationOf,
  detailRoomOf,
  detailWidthOf,
  dragDetailWidth,
  DetailPresentation,
  MAIN_MIN_VP,
  navWidthOf,
  ConcessionStep
} from './ui/LayoutController';
export type { DetailCapacity, LayoutDecision, LayoutInput } from './ui/LayoutController';

// ── 导航状态机（P1：返回键优先级阶梯与页签归一化，见 NavigationController 的说明） ──
export {
  BackAction,
  decideBack,
  navTabs,
  normalizeTab,
  selectTab,
  showsConversation,
  StackPage
} from './ui/NavigationController';
export type { NavState, OverlayState, TabSelection } from './ui/NavigationController';

// ── 会话中枢（D1 §7.7.5b：全应用单一连接池 + 单一会话状态机 + 单一待发队列） ──
export { FEEDBACK_CATEGORIES, HubPhase, projectWireRecord, SessionHub, notice, noticeWith, put } from './store/SessionHub';
export type {
  AttachOutcome,
  HubSnapshot,
  HubSubscriber,
  NotifyHooks,
  OutboxEntry,
  PendingAttachment
} from './store/SessionHub';

// ── 通知策略（D3 §6：六类通知的标题/正文/优先级/点击目标 + 内容纪律 + 去重键） ──
export {
  assertNoSensitiveContent,
  collapseWhitespace,
  DEFAULT_DETAIL_LIMIT,
  dedupeKeyOf,
  groupOf,
  inAppFallbackText,
  looksSensitive,
  NOTIFY_POLICIES,
  NOTIFY_PAGES,
  NotifyKind,
  notificationFor,
  notifyInputForConnection,
  notifyInputForPending,
  notifyInputForTurn,
  NotifyTarget,
  parseNotifyRoute,
  policyOf,
  QUESTION_DETAIL_LIMIT,
  REDACTED,
  routeOf,
  sanitizeDetail,
  scrubCredentials,
  UNTITLED_SESSION,
  withdrawalKeysFor,
  withdrawalKeysForPending,
  withdrawalKeysForSession
} from './model/Notify';
export type { InAppNotice, NotifyInput, NotifyPolicy } from './model/Notify';

// ── 2in1 快捷键表（D3 §5.1：规范 11 行 → 13 个规格；数据 + 纯函数） ──
export {
  findShortcut,
  keyboardShortcutSpecs,
  keyEventSpecs,
  MODIFIER_LABEL,
  modifierLabel,
  SHORTCUTS,
  shortcutBindingLabel,
  ShortcutModifier,
  shortcutsForDesktop
} from './ui/Shortcuts';
export type { ShortcutSpec } from './ui/Shortcuts';

// ── 真实连接接线契约（请求构造器 + 回复投影；端点名一律来自 dshcompat） ──
export {
  approvalAnswer,
  ApprovalDecision,
  ApprovalOutcome,
  approvalOutcomeFor,
  APPROVAL_REQUEST_EVENT,
  authorityOfUrl,
  basenameOf,
  commandsListEndpoint,
  commandsListPayload,
  ControlFrameType,
  cwdBasename,
  decisionIsClientSideOnly,
  eventResultArgs,
  eventResultEndpoint,
  filePart,
  fileReferencesEndpoint,
  fileReferencesPayload,
  fileUploadEndpoint,
  fileUploadPayload,
  FollowFrameType,
  followSessionAddress,
  followSubagentAddress,
  hostOfUrl,
  imagePart,
  isKnownProjectionKey,
  isLoopbackUrl,
  isWaterfallFrame,
  normalizePathKey,
  outcomeNext,
  outcomeRejected,
  outcomeResult,
  projectApprovalRequest,
  projectAskUserQuestionRequest,
  projectCommands,
  projectFileReferences,
  projectFileUpload,
  projectHosts,
  projectSessionCreate,
  projectSessionFork,
  projectSessionListWire,
  projectSessionPrompt,
  projectSessionReferences,
  projectSessionPage,
  sessionCursorOf,
  sessionPageEndpoint,
  sessionPagePayload,
  projectQueuedItems,
  queuedItemsOf,
  projectSessionRename,
  projectWorkspaceListing,
  projectWorkspaces,
  projectWorkspaceText,
  projectWorkspaceFailure,
  promptPayload,
  PromptMode,
  queueEditAction,
  queueRemoveAction,
  queueSteerAction,
  questionAnswer,
  questionAnswerItem,
  readControlFrame,
  readFollowFrame,
  readWaterfallFrame,
  resolveSessionTitle,
  sessionCancelPayload,
  sessionCreatePayload,
  sessionFollowPayload,
  sessionForkPayload,
  sessionListWirePayload,
  sessionReferencesEndpoint,
  sessionReferencesPayload,
  sessionRenamePayload,
  sessionUpdateQueuePayload,
  textPart,
  TitleSource,
  titleOfSummary,
  UNTITLED_SESSION as WIRE_UNTITLED_SESSION,
  USER_QUESTIONS_REQUEST_EVENT,
  workspaceListEndpoint,
  workspaceListPayload,
  workspaceReadAllEndpoint,
  workspaceReadAllPayload,
  projectWorkspaceBytes,
  workspaceReadEndpoint,
  workspaceReadPayload,
  WORKSPACE_ROOT_REQUEST_PATH
} from './model/Wire';
export type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionIntent,
  AskUserQuestionItem,
  AskUserQuestionOption,
  AskUserQuestionRequest,
  ApprovalAnswerValue,
  ApprovalRequestPayload,
  CommandCandidate,
  ControlBaseline,
  ControlFrame,
  EventResultArgs,
  FollowAssistantStreamFrame,
  FollowEventFrame,
  FollowFrame,
  FollowSessionAddress,
  FollowSnapshotFrame,
  FollowSubagentAddress,
  FileAttachmentRefValue,
  FileUploadRequest,
  FileUploadValue,
  HostProjectionInput,
  OutcomeRejected,
  OutcomeResult,
  ProjectionHints,
  PromptContentPart,
  QueueActionBody,
  QueuedItem,
  QueueTextBlock,
  ReferenceCandidate,
  SessionCancelRequest,
  SessionCancelValue,
  SessionCreateRequest,
  SessionCreateValue,
  SessionFollowRequest,
  SessionForkRequest,
  SessionForkValue,
  SessionHistoryRecord,
  SessionListRequest,
  SessionListValue,
  SessionPageRequest,
  SessionPageValue,
  SessionPromptRequest,
  SessionPromptValue,
  SessionQueuedItem,
  SessionRenameRequest,
  SessionRenameValue,
  SessionSummaryWire,
  SessionUpdateQueueRequest,
  SessionWireEvent,
  SessionWireHeader,
  TitleResolution,
  WaterfallFrame,
  WireError,
  WorkspaceEntryWire,
  WorkspaceBytesWire,
  WorkspaceFileRange,
  WorkspaceListingProjection,
  WorkspaceListingWire,
  WorkspaceTextWire
} from './model/Wire';
