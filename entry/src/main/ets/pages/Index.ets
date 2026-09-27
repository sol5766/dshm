/**
 * 应用首屏：三形态导航 + 让步链 + 全部页面装配（D3 §2 / §1）。
 *
 * 形态（按**窗口宽度**判定，D3 §2.2 硬规则）：
 *   单栏 SINGLE（< 600vp，手机 / 折叠态）  ：内容区 + 底部标签栏；会话栈式下钻
 *   双栏 DOUBLE（600–839vp，折叠展开 / 平板竖屏）：左侧图标条 + 内容区
 *   三栏 TRIPLE（>= 840vp，平板横屏 / 2in1）    ：导航面板 + 主区 + 详情栏
 *
 * 让步链（D3 §2.1）：详情栏收窄 → 详情栏关闭 → 导航收为图标条 → 导航抽屉化。
 * 让步只改几何、不改数据；变宽时自行恢复。
 *
 * 页面装配（D3 §1 信息架构全覆盖）：
 *   待决 / 会话（+轨迹+输入区+详情栏）/ 工作区（工作区→文件树→预览）/
 *   设置（通用·模型·凭据·插件·设备）/ 连接诊断 / 添加 Host
 *
 * 数据全部来自 `SessionHub`（真实连接）或**空态**。这里**不再有任何桩数据**：
 * 桩数据曾把「功能没接上」伪装成「功能正常」，也曾在设备页编造一条
 * 「本机 Host · 已授权」——那是安全陈述，编造它比空列表危险得多。
 */

import { display, router, window } from '@kit.ArkUI';
import { fileIo as fs } from '@kit.CoreFileKit';

import {
  checkVersion,
  emptyProbeTable,
  SURFACE,
  tableStats
} from 'dshcompat';
import type { VersionCheck } from 'dshcompat';
import type { DiagnosticItem, DiagnosticReport } from 'connection';
import {
  applyThemeMode,
  copyText,
  LocalPrefs,
  PickOutcome,
  pickDocument,
  pickFolder,
  localizedOr,
  readDeviceFacts,
  readInputSources,
  themeModeOf,
  watchInputSources
} from 'platform';
import type { InputSourceReading, NotifyRoute, PickedFile, PickedFolder } from 'platform';
import { common } from '@kit.AbilityKit';
import {
  APPROVAL_CHOICE_ALLOW_ALWAYS,
  APPROVAL_CHOICE_DENY,
  CommandCandidate,
  CredentialItem,
  DetailSection,
  DiagEntry,
  DiagReport,
  FileNode,
  FilePreview,
  Fs,
  HostRecord,
  HubPhase,
  BackAction,
  decideBack,
  HarmonyColor,
  HarmonyRadius,
  HarmonySpacing,
  LayoutMode,
  showsConversation,
  deliverablesOf,
  itemsOfKind,
  DrawerState,
  enterSession,
  selectRightPanel,
  setDrawer,
  shellTracksOf,
  mainPanelOfSidebarPanel,
  sidebarPanelOfMainPanel,
  TrackPresentation,
  selectTab as decideTabSelection,
  StackPage,
  ModelOption,
  ModelSelection,
  NavTab,
  PendingItem,
  PendingAttachment,
  PluginItem,
  QueuedItem,
  ReferenceCandidate,
  SessionListItem,
  SettingGroup,
  SettingKind,
  SettingOrigin,
  SettingValueType,
  DEFAULT_MODEL_NS,
  SettingsWriteOutcome,
  sidebarExpandedForMode,
  sidebarTrackWidthOf,
  settingsDomainOfNs,
  sheetNoteVisible,
  workspaceNameOf,
  splitSettingKey,
  parseSettingInput,
  parseStructInput,
  parseNotifyRoute,
  buildCoreView,
  CoreFact,
  CorePhase,
  CoreViewState,
  corePhaseOfHostState,
  emptyCoreView,
  emptyDiagReport,
  DiagMode,
  diagModeOf,
  fact,
  unknownFact,
  mergeSettingsGroups,
  normalizePathKey,
  projectDetailSections,
  projectHosts,
  projectWorkspaces,
  pluginInventoryFact,
  pluginRowOf,
  rankPluginRows,
  SessionHub,
  Sz,
  TrajectoryItem,
  TrajectoryKind,
  WorkspaceItem,
  WorkspaceRow,
  SkillRow,
  AgentPresetRow,
  ActionNotice,
  clampDetailDesired,
  decideLayoutWithDetail,
  DetailPresentation,
  detailRoomOf,
  detailWidthOf,
  dragDetailWidth,
  flattenSources,
  createPanelRegistry,
  initialNavigationState,
  openSettings,
  legacyTabOfMainPanel,
  mainPanelOfLegacyTab,
  activeMainPanelOf,
  navigateToMain,
  guessFromKeyboardForm,
  mainPanels,
  PanelDescriptor,
  PanelLocation,
  PanelRegistry,
  modalityFromSources,
  modalityOf,
  modalityTrace,
  unionModality,
  // pi-ai 路由（自定义模型 API）：校验、路径与载荷构造都在纯逻辑模块里（有 fixture 断言）
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
  modelsDiffer,
  modelsPayload,
  piAiFieldPath,
  piAiModelsPath,
  piAiRoutePath,
  scalarFieldValue,
} from 'appstate';
/**
 * 类型单独用 `import type` 引入。
 *
 * 原因：`HubSnapshot` / `HubSubscriber` 在 appstate 里是 `export type` 导出的类型，
 * 与值导入分开写更贴近 ArkTS 的类型/值导入区分。
 */
import type { AttachOutcome, PluginInventoryTotals, CredentialWriteResult, HubSnapshot, HubSubscriber, InputModality, LayoutDecision, LayoutInput, ModalityEvidence, NavState, NavigationState, OverlayState, PiAiFieldCheck, PiAiModelRow, PiAiProviderView, PluginRow, SessionJob, SessionStatsInput, SettingChoice, SettingInputResult, SettingItem, SettingsKeyParts, SettingsWriteResult, TabSelection } from 'appstate';
import { emitter } from '@kit.BasicServicesKit';
import { parseJson } from 'connection';
import { EVENT_HOST_CONNECTED, EVENT_KEY_HOST_TOKEN, EVENT_KEY_HOST_URL } from 'platform';
import { ConnectPane } from '../view/ConnectPane';
import { FolderPicker, FolderPickerController } from '../view/FolderPicker';
import { ChoiceSheet } from '../view/ChoiceSheet';
import { CredentialSheet } from '../view/CredentialSheet';
import { SettingStructSheet } from '../view/SettingStructSheet';
import { SettingTextSheet } from '../view/SettingTextSheet';
import { PiAiProviderSheet, PiAiSheetMode } from '../view/PiAiProviderSheet';
import { MainShell } from '../view/shell/MainShell';
import { AppShell } from '../view/shell/AppShell';
import type { AppShellFacade } from '../view/shell/AppShell';
import type { MainShellFacade } from '../view/shell/MainShell';
import type { RightbarFacade } from '../view/shell/RightbarShell';
import { TabContentView } from '../view/TabContentView';
import type { TabContentFacade } from '../view/TabContentView';
import type { WorkspaceBrowserFacade } from '../view/WorkspaceBrowser';
import type { FileTreeFacade } from '../view/FileTreePane';
import { RightbarShell } from '../view/shell/RightbarShell';
import { DetailPane } from '../view/DetailPane';
import { NodeRuntime } from '../runtime/NodeRuntime';
import { WorkspacePane } from '../view/WorkspacePane';
import { hitOfKeyEvent } from '../view/ShortcutKeys';
import type { ShortcutHit } from '../view/ShortcutKeys';
import { harmonySheetOptions, NativeButton } from '../view/NativePrimitives';
// 端侧核心运行层（D6）：核心版本仓库与激活事务。运行时载体尚未接线，
// 因此这里现在只用它的"仓库/状态"部分，不声称任何"已启动"。
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BundledInstallResult, DshHost, HostStartResult, HostStatus, OpResult, RuntimeProbe, hostStateIsTransient } from 'hostruntime';

/**
 * 把紧凑 JSON 美化以便人读写；失败时原样返回。
 *
 * 【为什么要自己缩进而不是用 `JSON.stringify(v, null, 2)`】整值编辑的对象是
 * **已经解析过的文本**，而 `JSON.stringify` 的缩进参数只对「对象」生效——
 * 我们手上是字符串，必须先 parse。失败（旧数据里存了非法 JSON）时原样返回，
 * 让用户在编辑器里直接看到原文并自己修，而不是显示一个空白框。
 */
function prettyJson(compact: string): string {
  if (compact.length === 0) {
    return '';
  }
  const parsed: Object | undefined = parseJson(compact);
  if (parsed === undefined) {
    return compact;
  }
  return JSON.stringify(parsed, null, 2) ?? compact;
}

/**
 * 把「刚刚连上的 Host」报告给能力层，由它落盘（地址明文、token 加密）。
 *
 * 【为什么页面不自己存】页面拿不到 `UIAbilityContext`（`preferences` / Asset Store
 * 都需要它），而且「零 UI 依赖」是本工程的纪律——视图层不该认识存储细节。
 * 页面只报告事实，怎么记由能力层决定。
 *
 * 【为什么只报告成功的连接】失败的地址/token 不该被记住：否则下次启动会拿一个
 * 已知无效的 token 去自动重连，用户看到「自动重连失败」；而正确行为是回到「添加 Host」。
 */
function reportConnectedHost(baseUrl: string, token: string): void {
  if (baseUrl.length === 0) {
    return;
  }
  const payload: Record<string, Object> = {};
  payload[EVENT_KEY_HOST_URL] = baseUrl;
  payload[EVENT_KEY_HOST_TOKEN] = token;
  emitter.emit({ eventId: EVENT_HOST_CONNECTED }, { data: payload });
}

/**
 * 把 connection 的真实诊断报告投影成诊断页的呈现模型。
 *
 * 【为什么不在这里再跑一次版本判定】`Connection.diagnose()` 已经产出
 * 「端点 / TLS / 认证 / 协议 / Host」五项判定，**其中就包含 Host 版本判定**。
 * 在这里用 `checkVersion()` 再算一次不但重复，还需要一份运行时 `ProbeTable`——
 * 而那份探测结果正是 connection 内部的产物，从外面拿不到，硬凑只会得到错误结论。
 * 因此这里只做两件事：
 *   1. 逐项搬运**已实测**的判定；
 *   2. 附上 `dshcompat` 的**静态兼容面事实**（受支持版本矩阵、上表规模）——
 *      UI 不得自行拼写上游版本号或端点名（D5 §1）。
 */
function projectDiagnostics(report: DiagnosticReport): DiagReport {
  const entries: DiagEntry[] = [];
  for (let i = 0; i < report.items.length; i++) {
    const item: DiagnosticItem = report.items[i];
    entries.push({
      name: item.name,
      passed: item.passed,
      detail: item.detail,
      advice: item.advice === undefined ? '' : item.advice
    });
  }
  const stats = tableStats();
  // 版本判定走 `dshcompat.checkVersion`，**不能**把「受支持矩阵」当成判定结论：
  // 诊断页按 `versionVerdict` 的三态（supported/unverified/incompatible）分支渲染，
  // 塞进一个版本号字符串会让三个分支**全部落空**——界面既没有图标也没有文案，
  // 而它看起来只是「这里没内容」，比报错更难发现。
  //
  // 这里传空版本号是**如实**的：上游没有任何端点或帧给出 Host 核心包版本
  // （`$events` 的 ready 帧实测只有 clientId 与 host.home，D2 §8.7.12），
  // 所以结论必然是 unverified，且必须把原因写清楚。
  const verdict: VersionCheck = checkVersion('', emptyProbeTable());
  return {
    entries: entries,
    healthy: report.healthy,
    generatedAt: report.generatedAt,
    versionVerdict: verdict.verdict,
    versionMessage: verdict.message,
    versionAdvice: verdict.advice,
    tableStats: `${stats.endpoints} 个端点 / ${stats.streamEndpoints} 个流式 / ${stats.capabilities} 个能力`,
    // 接口面必须来自载体常量：写死字符串会在上游改路径后继续显示旧路径，
    // 而这一行正是用来判断「是不是漏注入/走错路由」的。
    surface: `${SURFACE.apiChannel} · ${SURFACE.muxPath} · ${SURFACE.eventsEndpoint}`
  };
}

/**
 * 应用名（**唯一来源**）。
 *
 * 【为什么要有这个常量】应用名此前散落在四处：`AppScope` 的 `app_name`、
 * `entry` 的三个 string 资源、以及本文件里的一处字面量。它们各不相同
 * （「DSH 鸿蒙端」「DeepSeek Harness 鸿蒙客户端」），于是桌面图标、任务卡片、
 * 侧栏标题**互相不一致**——用户会以为是两个应用。
 *
 * 资源文件里的 `app_name`/`EntryAbility_label` 是系统读取的（改名要同步改资源），
 * 这里的常量供**应用内**渲染使用；两处必须字面一致，改名时一起改。
 */
const APP_NAME: string = 'DSHM';

/** 本机偏好「主题模式」的 key 与取值（与 `platform/LocalPrefs` 的 `ThemeMode` 一致） */
const LOCAL_THEME_KEY: string = 'local.themeMode';
const LOCAL_THEME_SYSTEM: string = 'system';
const LOCAL_THEME_LIGHT: string = 'light';
const LOCAL_THEME_DARK: string = 'dark';

/** 单栏下的页面栈 */

/** 一级导航顺序 */
// 「核心」放在工作区与设置之间：它属于"能力/运维"一类，紧邻设置但不与设置混在一起
// E110：收敛为两项——核心并入设置（它是"这台设备上 DSH 怎么跑"的配置，不该另开一级）

/** 自动连接路径的诊断日志（前缀 DSHM-CONN）：端侧只有 hilog 可看，而这条路径
 *  "既不发请求也不报错"的失败模式极难从外部定位（见 E55/E56）。 */
const DOMAIN: number = 0x0000;
const TAG: string = 'DSHM-Index';

// 【本轮移除】阶段一 Electron 运行时宿主（`RuntimeHost` + `MOUNT_ELECTRON_RUNTIME_HOST`）
// 连同它对 `web_engine` 的依赖一起删掉了：那条通道依赖 JIT、不可上架，
// 且它在模拟器（x86_64）上因缺少 `libadapter.so` 会把应用直接打崩（见 AppAbilityStage 的说明）。
// 端侧运行时现在只有一条路径：`libdshhost.so` → `libnode.so.127`（D6 §4.1）。

@Entry
@Component
struct Index {
  // ── 形态 ──
  @State mode: LayoutMode = LayoutMode.SINGLE;
  /**
   * 导航状态（P0-2：**页面 = 选中的面板**）。
   *
   * 【为什么收在这里】此前"当前是哪个页面"是 `@State tab: NavTab`，而右栏选择、设置分区、
   * 抽屉、浮层各是另一份字段——**页面与面板是两套机制**，于是 `Index` 必须自己写 if 链装配 Pane。
   * 现在唯一真值是 `NavigationState.selectedMainPanel`，`NavTab` 只是**迁移期的别名**
   * （`legacyTabOfMainPanel` / `mainPanelOfLegacyTab` 是双向桥，有往返断言）。
   */
  @State nav: NavigationState = initialNavigationState();
  @State stackPage: StackPage = StackPage.MAIN;
  @State detailOpen: boolean = false;
  /**
   * 当前窗口尺寸（vp）。形态与几何**不再由本文件各算一遍**，
   * 统一交给 `appstate/ui/LayoutController.decideLayoutWithDetail()`（P1：布局决策出栈；
   * 带"用户想要的栏宽"参数，见 `detailWidthDesired`）。
   * 两者在 `applySize()` 里同时写入，因此 `mode !== SINGLE` 时它们必定有效。
   */
  @State winWidthVp: number = 0;
  @State winHeightVp: number = 0;
  /**
   * 详情**半模态 Sheet**（P1.5）。
   *
   * 【为什么不再是一条栈页】鸿蒙 `bindSheet` 的语义是"非全屏弹窗、底层父视图部分可见"，
   * 正好对应"边看对话边看详情"的真实意图；整页替换会把对话顶掉，用户还得再退回来。
   * 三栏形态不走这条（`mode === TRIPLE` 时用真正的右栏，可调宽、可记忆）。
   */
  /**
   * 详情是否以**浮层**形式打开（P3）。
   *
   * 【为什么不再叫 detailSheetOpen】它在单栏下是半模态 Sheet、在双栏下是**侧边浅层面板**
   * （计划 §12），两者共用这一个"打开"状态；呈现方式由布局决策的 `detailPresentation` 决定
   * （`underlying` 的档位判定），不在这里各写一套。改名是为了不让名字说谎。
   */
  @State detailOverlayOpen: boolean = false;

  /**
   * 输入模态事实（**合成结果**：键盘 / 指针各一个布尔）。
   *
   * 【为什么不再用一个布尔】此前这里是 `hasPointerInput = keyboardLikely`，并把它**同时**
   * 当作 hasPointer 与 hasKeyboard 传下去，于是手机插鼠标、平板配触控笔都画不出 hover 与右键，
   * 而 2in1 拆掉键盘后仍被当成有键盘。两个事实各有消费点（`InputPolicy.hoverEnabled` /
   * `contextMenuGestures`），必须分开。
   *
   * 【事实从哪来（优先级见 appstate/model/InputFacts）】
   *   ① 系统枚举的输入设备（`platform/system/InputDevices`，可增可减）
   *   ② 运行时事件证据（悬停过 ⇒ 有指针；这里只增不减）
   *   ③ 设备形态猜测（2in1/桌面模式，最弱的兜底，保证不比旧行为更差）
   */
  /**
   * 面板注册表（P0：三条轨道的面板清单与可用性的**唯一事实**）。
   *
   * 【为什么用 `@Provide` 而不是一路传 props】本轮把它 `@Provide` 出来、由 shell `@Consume`，
   * 是 MainShell 迁移的**前置机制验证**：主区六个面板直接读本组件约 100 个 `@State`，
   * 要把它们交给 shell，必须先确认这种"祖先提供、后代消费"的方式在本仓 ArkTS 里可用
   * （`@Provide/@Consume` 在本仓**无先例**；`@BuilderParam` 曾导致真机 JS 崩溃，D4）。
   * 先在最窄的一条轨道（侧栏）上用起来，再决定是否用于主区。
   */
  @Provide('panelRegistry') panelRegistry: PanelRegistry = createPanelRegistry(mainPanels());

  @State modality: InputModality = { hasKeyboard: false, hasPointer: false };

  /** 上面这次合成的**理由**（诊断用：说不出理由时，只能到真机上猜） */
  @State modalityNote: string = '';

  /**
   * 会话统计（快照字段原样带过去，供轨迹的时间总览用）。
   *
   * 【为什么单独存一份数字】上面那条 `statsLine` 是"给人看的一行字"（轮次/缓存命中/预设），
   * 而时间总览要的是**数字本身**（模型用时、工具用时、TTFT、TPS）——把数字拼成字符串再反向解析
   * 是典型的错法。故两者各存各的，都由同一份快照落地。
   */
  @State sessionStats: SessionStatsInput = {
    turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0
  };

  /**
   * 详情栏**用户想要的**宽度（P3：拖拽把手与宽度记忆的唯一真值）。
   *
   * 【为什么要有它】布局模型里 `decideLayoutWithDetail(input, desiredVp)` 这条路径早就做好了
   * （含让步链与 fixture），但此前**没有任何 UI 去产生这个宽度** —— `decideLayout()` 直接用常量
   * `Sz.DETAIL_PANEL`。于是"用户可以调栏宽"这件事在模型里存在、在界面上不存在。
   *
   * 注意它存的是**意图**而不是最终宽度：最终宽度由模型按当前窗口可用空间夹取
   * （`clampDetailDesired`），所以窗口变小时栏会自己收窄，而用户拖出来的意图不丢。
   */
  @State detailWidthDesired: number = Sz.DETAIL_PANEL;

  /**
   * 侧栏展开偏好（P5-2）：`undefined` = **没存过**（按形态默认）。
   *
   * 【为什么偏好不能放进 `NavigationState`】它描述的不是"导航到哪儿"，而是用户的
   * 几何偏好；更要紧的是**它的默认值随形态变**（双栏默认 rail、三栏默认 panel）——
   * 一个 `boolean` 字段存不下"没存过"，于是双栏首启会被读成"展开"，与
   * `shellTracksOf(DOUBLE).sidebar = RAIL` 直接矛盾。故真值只有这一份原始值，
   * 生效值每次渲染由 `sidebarExpandedForMode(mode, stored)` 派生。
   */
  @State sidebarStored: boolean | undefined = undefined;

  /** 一次拖拽开始时的宽度（PanGesture 的 offsetX 是**累计量**，必须用起点换算） */
  private dragStartWidth: number = Sz.DETAIL_PANEL;

  /** 系统枚举到的输入设备；`null` = 枚举不可用 ⇒ 退回形态猜测（与"当前没有设备"是两件事） */
  private enumeratedModality: InputModality | null = null;

  /** 运行时事件证据（只增不减） */
  private observedModality: InputModality = { hasKeyboard: false, hasPointer: false };

  /** 设备形态猜测（最弱兜底） */
  private formGuessModality: InputModality = { hasKeyboard: false, hasPointer: false };

  /** 取消设备热插拔监听（页面销毁时调用） */
  private unwatchInput: (() => void) | undefined = undefined;

  // ── 数据（当前来自桩数据源） ──
  @State sessions: SessionListItem[] = [];
  @State pending: PendingItem[] = [];
  @State selectedSessionId: string = '';
  @State selectedSessionTitle: string = '';
  @State trajectoryItems: TrajectoryItem[] = [];
  @State detailSections: DetailSection[] = [];
  /** 端侧核心的呈现模型（D6）。初始为「运行时未接线」的如实状态，不含任何桩数据 */
  @State coreView: CoreViewState = emptyCoreView();
  /** 核心页的一次性提示（动作未接线/进行中等），显示后由用户下次操作覆盖 */
  @State coreNotice: string = '';
  /** 端侧核心的生命周期句柄（懒建；只有一个，与"单一状态机"的纪律一致） */
  private host: DshHost | null = null;
  /** 本机沙箱里可写的工作区目录（E98：连接后注册进 Host，建会话带上 workspaceId） */
  private localWorkspaceDir: string = '';
  /** 插件启停操作的即时反馈（重启后生效这类事实必须让用户看到） */
  @State pluginNotice: string = '';
  @State workspaces: WorkspaceItem[] = [];
  /** 宿主报告的权限组合（E124：`currentValue` + `options`；空串=宿主没投影，界面不显示） */
  @State permissionCurrent: string = '';
  @State permissionOptions: string[] = [];
  /** 会话统计行（E125：官方措辞「N 轮 M 步 · 缓存命中 X%」；空串=没有可显示的统计） */
  @State statsLine: string = '';
  /** 会话的 Agent 预设（E129：官方显示在会话标题上；创建后固定，只读） */
  @State agentPreset: string = '';
  /** 工作区注册表（E132：带 workspaceId；删除需要它） */
  @State workspaceRows: WorkspaceRow[] = [];
  /** 注册表全局归档集合（E132）：常规列表按它过滤 */
  @State archivedSessionIds: string[] = [];
  /** 技能清单与其读取结论（E135） */
  @State skills: SkillRow[] = [];
  @State skillNote: string = '';
  /** Agent 预设名单与其读取结论（E161：预设 = 会话的 Agent 插件组装） */
  @State presets: AgentPresetRow[] = [];
  @State presetNote: string = '';
  /** 已按过一次「删除」、等待确认的工作区路径（两步确认） */
  @State confirmingDeletePath: string = '';
  /**
   * 归档分组是否展开（E165，用户反馈②）。
   *
   * 用户原话："归档后的会话不应该在工作区显示。" 归档集本身是对的（真机读数 `archived=3/4`），
   * 问题在于我把「归档 · N」**平铺在工作区页里** ⇒ 看起来像"归档了还留在工作区"。
   * 默认**折叠**：只留一行「归档 · N」作为入口，点开才展开——既不再"显示在工作区里"，
   * 也没有把已归档的会话变得找不到。
   */
  @State archiveOpen: boolean = false;
  @State fileTree: FileNode[] = [];
  /** 文件预览结果；undefined = 未选择文件（@State 必须给默认值） */
  @State preview: FilePreview | undefined = undefined;
  @State settings: SettingGroup[] = [];
  /**
   * 本客户端本地偏好（通知 / 离线缓存等）。
   *
   * 与 `settings`（最终渲染的合并结果）分开保存的理由：这些偏好**不存在于上游**，
   * 连上 Host 后不能被 Host 设置顶掉——否则用户会以为功能消失了。
   * 见 `mergeSettingsGroups` 的说明。
   */
  @State localSettings: SettingGroup[] = [];
  /**
   * Host 设置分组（`settings/describe` 的那一份）。
   *
   * 与 `localSettings` **分开存**：界面用到的 `settings` 是两者合并的结果，
   * 而"本机偏好改了要重新合并"时必须有一份没被覆盖的 Host 分组可用。
   * 只存合并结果的话，第二次合并会把上一次的本机组再叠一遍。
   */
  @State hostSettings: SettingGroup[] = [];
  /** 设置命名空间的写状态（含 revision）；用于诊断「界面值与 Host 版本是否一致」 */
  /** 设置写入的结果回显（成功/失败/冲突都如实显示，不做乐观更新） */
  @State settingWriteNote: string = '';
  /**
   * 这条回执**属于哪个设置分区**（E347：空串 = 判不出来）。
   *
   * 设置页只在"域 == 当前分区"时显示回执——否则在通用改了外观、切到模型页，
   * 那条回执还挂在模型页上方，看起来像模型页刚写出来的结果。
   */
  @State settingsWriteDomain: string = '';
  /**
   * 正在选择的枚举设置项。
   *
   * 【为什么用浮层而不是「点一下轮换到下一个值」】枚举可能有 3–4 个取值，
   * 轮换要求用户记住顺序并反复点击才能到达目标值，而且**每一跳都会写一次 Host**——
   * 中途的每一次都是真实副作用。浮层让用户一次选中目标值，只写一次。
   */
  @State choosing: SettingChoice[] | undefined = undefined;
  @State choosingKey: string = '';
  @State choosingLabel: string = '';
  @State choosingCurrent: string = '';
  /**
   * 正在编辑的凭据引用（空串 = 没有在编辑）。
   *
   * 【为什么先起编辑态再写】写凭据是**破坏性**操作（`credentials/unset` 会删掉
   * Host 侧的值，依赖它的功能立刻失效）。要求用户先明确进入编辑态再提交，
   * 比「点一下就直接写」多一道有意的摩擦。
   */
  @State credentialRef: string = '';
  /** 待写入的凭据明文。**只在这里存在**：提交后立刻清空，不进任何持久状态。 */
  @State credentialDraft: string = '';
  /**
   * 凭据浮层自己的结果/进度文案。
   *
   * 【为什么不用共享的 `settingWriteNote`】那个字段被列表上方的回显与设置写入共用，
   * 而浮层盖住了列表——把结果写进一个**看不见**的地方，失败就变成了静默失败。
   * 实测踩到过：写入没有到达 Host，而界面上没有任何提示。
   * 每个会盖住内容的界面都必须有自己的结果出口。
   */
  @State credentialNote: string = '';
  /**
   * 这条回执**属于哪个浮层**（E353：空串 = 没人认领）。
   *
   * 【为什么必须有它】三个浮层（凭据 / 文本设置 / 结构设置）共用 `credentialNote` 与
   * `credentialBusy` 这一对字段。实测后果：在凭据浮层里写入失败 → 关掉 → 打开「编辑文本设置」，
   * **那条凭据的失败文案会出现在文本编辑浮层里**；而在文本浮层里提交还会把凭据浮层的
   * 按钮置忙（`credentialBusy` 被跨浮层读）。这与设置页那条"回执没有归属域"（E347）是同一类缺陷。
   *
   * 取值是 `sheetKind()` 的三个返回值之一：`credential` / `text` / `struct`。
   * 每个浮层只在"这条回执是我的"时显示它；打开浮层时由它认领并清空上一条。
   */
  @State sheetNoteOwner: string = '';
  /** 凭据请求进行中（防重复提交；不复用 `connectBusy`，那是连接的状态） */
  @State credentialBusy: boolean = false;
  /**
   * 正在编辑的文本/数字设置项 key（空串 = 没有在编辑）。
   *
   * 与凭据浮层复用同一个模式：先进入编辑态，再提交。
   */
  @State textSettingKey: string = '';
  @State textSettingLabel: string = '';
  @State textSettingDraft: string = '';
  /** 编辑中的设置项（提交时要按它的 `valueType` 与约束解析输入） */
  private textSettingItem: SettingItem | undefined = undefined;
  /**
   * 正在整值编辑的结构化设置项 key（数组 / 嵌套对象 / 复杂 union）。
   *
   * 【为什么必须整值编辑】实测数组元素**无法按路径寻址**
   * （字符串下标 → `settings/rejected`；数字下标 → `gateway/input-invalid`），
   * 详见 `SettingKind.STRUCT` 的说明。唯一可行的写法是读整个值、本地改、整值写回。
   */
  @State structSettingKey: string = '';
  @State structSettingLabel: string = '';
  @State structSettingDraft: string = '';
  private structSettingItem: SettingItem | undefined = undefined;

  /*
   * ── pi-ai 路由浮层（编辑 / 新建「自定义模型 API」）────────────────────────
   *
   * 【为什么必须新增一套状态，而不是复用 struct 那套】`llm-pi-ai` 在设置项粒度上
   * 只有一个 `providers` object 项，STRUCT 浮层只能给一个 JSON 大框；而官方形态是
   * **逐字段**（显示名 / 端点 / API 协议 / 模型目录）**且必须能从零新建**。
   * 两者是不同形态的编辑器，不是一个编辑器换文案。
   */
  /** 非空 = 该浮层开着（值同时是它的模式：`PiAiSheetMode`） */
  @State piAiMode: string = '';
  /** 正在编辑的表单草稿（真值在此；浮层只渲染） */
  @State piAiDraft: PiAiProviderView = emptyProviderView('');
  /** 进入编辑时的**原始值**：用来算"哪些字段真的变了"，避免无脑全量写回 */
  private piAiOriginal: PiAiProviderView | undefined = undefined;
  /** 密钥草稿（只写不读：每次打开都为空；空 = 保留 Host 上那把） */
  @State piAiKeyDraft: string = '';
  /** 该路由的凭据引用（显示用） */
  @State piAiKeyRef: string = '';
  /** 该引用当前是否已配置 */
  @State piAiKeyConfigured: boolean = false;
  /** 字段级校验文案（端点/协议/模型/密钥） */
  @State piAiFieldError: string = '';
  /** 本浮层自己的忙标志（不借别的浮层的，见 E353） */
  @State piAiBusy: boolean = false;
  @State credentials: CredentialItem[] = [];
  @State plugins: PluginItem[] = [];
  @State hosts: HostRecord[] = [];
  @State models: ModelOption[] = [];
  /**
   * 会话的后台任务（中枢 `jobs` 投影；官方 `conversation.header.jobs`）。
   *
   * 【为什么要接这条】`appstate/model/Jobs.ets` 早就写好了一整套判定（live / 状态点语义 /
   * 五种文案 / 时长三档 / 排序 / 计数 / 是否需要定时器），**40 条断言**，中枢也一直在维护
   * `jobs` 字段——但**视图里没有任何消费者**（"通道有、没接"）。
   */
  @State jobs: SessionJob[] = [];
  @State selection: ModelSelection = { provider: '', modelId: '', effort: '' };
  /** pi-ai 路由（官方 Models 页的"提供方"，含自定义模型 API 建的那些） */
  @State piAiProviders: PiAiProviderView[] = [];
  /** pi-ai 可声明的 API 协议（空=Host 没报告） */
  @State piAiProtocols: string[] = [];
  /** 诊断是否在跑（驱动「重新检测」按钮的忙碌态） */
  @State diagRunning: boolean = false;
  @State diag: DiagReport = {
    entries: [], healthy: false, generatedAt: 0, versionVerdict: '',
    versionMessage: '', versionAdvice: '', tableStats: '', surface: ''
  };
  @State references: ReferenceCandidate[] = [];
  @State commands: CommandCandidate[] = [];
  /**
   * 计划模式状态（E202，来自 `plan` 投影）。
   *
   * 官方 chip 的判据是"**生效目标**是计划模式"= `pending ? !active : active`
   * （`pending` = 刚切换、等宿主确认）⇒ 我们照这条公式推导显示，不自己发明状态。
   * 切换没有专用端点：执行 `plan` 命令（E190 的命令面板已能执行）。
   */
  @State planActive: boolean = false;
  @State planPending: boolean = false;
  /** 命令面板是否打开（E190：短命令面板的可见状态） */
  @State paletteOpen: boolean = false;
  /** 能力缺失的一次性提示（透传给输入区；如附件上传尚未接线） */
  @State attachNotice: string = '';
  /** 用户是否已经点过一个工作区（决定文件树空态该说哪一句） */
  @State pendingWorkspacePick: boolean = false;
  /** 文件树空态标题与说明（由交互状态算出，见 `updateTreeEmptyText`） */
  @State treeEmptyTitle: string = '该工作区暂无文件';
  @State treeEmptyHint: string = '选择一个工作区以浏览它的文件';

  // ── 交互状态 ──
  @State draft: string = '';
  @State attachments: PendingAttachment[] = [];
  /** Host 侧待发队列（与会话一一对应，由 `session/control` 驱动） */
  @State queued: QueuedItem[] = [];
  @State running: boolean = false;
  @State offline: boolean = false;
  @State queuedCount: number = 0;
  @State wsDrill: number = 0;
  @State traceEnabled: boolean = false;
  @State traceLines: string[] = [];
  @State connectAddress: string = '';
  @State connectToken: string = '';
  @State connectBusy: boolean = false;
  @State connectResult: string = '';
  @State connectOk: boolean = false;
  @State connectAdvice: string = '';

  /** 派生值：避免在循环体内读取 @State（ArkTS 性能规则） */
  @State pendingBadge: string = '';

  // ── 真实连接状态（来自 SessionHub；未连接时保持桩数据） ──
  /** 中枢阶段；只有 LIVE 时才用中枢的数据覆盖桩数据 */
  @State hubPhase: HubPhase = HubPhase.IDLE;
  /** 已连接 Host 的 authority（供诊断与状态条显示） */
  @State hubAuthority: string = '';
  /** 中枢最近一次错误（用户可见文案，已含「可以做什么」） */
  @State hubError: string = '';
  /** `$events` 是否已就绪（D1 §7.7.5b 的验收点之一） */
  @State hubEventsReady: boolean = false;
  /** 控制流是否已收到 baseline */
  @State hubControlReady: boolean = false;
  /** 当前 mux 活动逻辑流数（正常为 2 或 3） */
  @State hubStreams: number = 0;
  /**
   * 是否已连上 Host（一元可用）。
   *
   * **与 `hubPhase === LIVE` 不是一回事**：`phase` 会因 `$events` 流终止而降级为
   * `DEGRADED`，而那一刻一元调用（会话列表、新建会话、发送…）仍然是真实可用的。
   * 视图判断「用真实数据还是桩数据」必须用本字段——用 `phase` 会让
   * 「连上了但事件流恰好断了」的时刻又退回桩数据，等于给用户看假会话。
   */
  @State hubConnected: boolean = false;
  /**
   * 上次连上的 Host（能力层从存储读出来后经 AppStorage 发布）。
   *
   * 三个键对应三种**不同**的处置，不能合成一个：
   *   - `rememberedUrl` 非空且可自动重连 → 直接连；
   *   - `rememberedTokenState === 'absent'` → 首次使用，显示「添加 Host」；
   *   - `rememberedTokenState === 'unavailable'` → **有记录但读不到**
   *     （锁屏策略变化 / 存储故障）。此时提示「请重新粘贴 token」是错的：
   *     token 还在，只是这次读不出来。两种情况的文案必须不同。
   */
  @StorageProp('dshLastHostUrl') rememberedUrl: string = '';
  @StorageProp('dshLastHostToken') rememberedToken: string = '';
  @StorageProp('dshLastHostTokenState') rememberedTokenState: string = 'pending';
  @StorageProp('dshHostAutoConnect') shouldAutoConnect: boolean = false;
  /**
   * 是否已经**结束过一次**连接尝试（E111）。
   *
   * 【为什么需要】启动时应用要先等本机核心就绪，再完成 token→cookie 兑换；
   * 这几十秒里中枢的 `lastError` 可能带着"尚未连接"这类中间态文本，而状态条是无条件渲染的
   * ⇒ 用户看到「无法连接核心」**闪一下再消失**（真机反馈）。判据不能是"有没有错误文本"，
   * 只能是"有没有真的试过并且失败了"。
   */
  @State connectSettled: boolean = false;
  /**
   * 内置核心是否正在解包（EntryAbility 广播；E99）。
   * 首启时它必须让页面显示「正在解包核心」而不是「还没有安装核心」。
   */
  @StorageProp('dshm.core.installing') coreInstalling: boolean = false;
  /**
   * 启动参数里的**路由**（通知点击直达的那一半）。
   *
   * 【为什么必须有它】`NotificationCenter` 会给通知挂一个携带 `dshRoute` 的 WantAgent，
   * 能力层把它解析后发布到 `dshLaunchRouteJson`；如果页面**不读**这个键，
   * 用户点通知的结果就只是"应用到了前台"——而通知的全部价值恰恰是"点了就到那件事上"。
   * 这条链路的平台半段早已就位（`buildAgent`），此前缺的就是这里的消费。
   */
  @StorageProp('dshLaunchRouteJson') launchRouteJson: string = '';
  /**
   * 本机偏好「主题模式」（能力层从 preferences 读出后发布）。
   *
   * 三种取值的界面呈现由 `localPreferenceGroup()` 负责；这里只做只读订阅。
   */
  @StorageProp('dshThemeMode') themeMode: string = 'system';
  /** 主题上次应用是否成功（能力层写入；失败时设置页要如实说明） */
  @StorageProp('dshThemeApplied') themeApplied: boolean = true;
  /** 会话内搜索条是否打开（D3 §5.1 的 Ctrl/Cmd+F；由快捷键打开、由搜索条自己关闭） */
  @State searchOpen: boolean = false;
  /** 自动重连只跑一次（StorageProp 变化会触发，重复跑会反复认证） */
  private autoConnectAttempted: boolean = false;
  /**
   * 最近一次自动连接用的 `(url, token)` 组合。
   *
   * 【为什么不能用布尔量表示"已连过"】**dsh 每次启动都会生成新 token**（真机读数：
   * 上一轮落盘的 token 在这一轮启动 250 ms 时就被页面读到并拿去连接，而新 token 要到
   * `BOOT_65_AUTH_URL`（约 2.2 秒）才发布）⇒ 只有记录"用的是哪一对"才能在 token 刷新后
   * 再连一次。用布尔量会让刷新后的新 token 永远没有机会被使用（E57）。
   */
  private lastConnectKey: string = '';
  /** 自动连接尝试上限：为"先用旧 token、随后 token 刷新"这一正常序列留出余量。 */
  private connectAttempts: number = 0;
  /** 未识别的上游事件类型数量（真机跑一次即可据此回填事件表） */
  @State hubUnknownEvents: number = 0;
  /** 协议旁路日志（取尾部若干行展示，用于区分「列表为空」与「调用失败」） */
  @State hubTrace: string[] = [];

  private widthListener?: (size: window.Size) => void;
  /**
   * 中枢订阅者（在 `aboutToAppear` 里构造）。
   *
   * 为什么不在字段上直接写字面量：ArkTS 禁止「无类型对象字面量」
   * （`arkts-no-untyped-obj-literals`），即使是带类型标注的类字段也不接受。
   * 用「局部变量 + 具名接口标注」再赋值即可满足约束。
   *
   * 注意语义：**每个窗口各自订阅、但共享同一个中枢**——
   * 中枢（`SessionHub.shared()` 模块级单例）持有唯一连接，窗口只是视图。
   * 这正是 D1 §7.7.5b 要求的归属关系：视图可以有很多份，连接与会话状态只有一份。
   */
  private hubListener?: HubSubscriber;

  /**
   * 把中枢快照落到页面状态。
   *
   * 判据是 `s.connected`（认证与载体就绪），**不是** `s.phase`：
   * `phase` 会因事件流终止而降级为 `DEGRADED`，那时一元调用仍然可用，
   * 用 `phase` 会让「连上了但事件流恰好断了」的时刻退回空态，
   * 等于把已经拿到的真实数据丢掉。
   */
  private applyHubSnapshot(s: HubSnapshot): void {
    this.hubPhase = s.phase;
    this.hubAuthority = s.authority;
    this.hubError = s.lastError;
    this.hubEventsReady = s.eventsReady;
    this.hubControlReady = s.controlReady;
    this.hubStreams = s.activeStreams;
    this.hubUnknownEvents = s.unknownEventTypes.length;
    this.hubTrace = s.trace;
    this.hubConnected = s.connected;
    // E124：宿主报告的权限组合（真实事实，不是我们写死的默认值）
    this.permissionCurrent = s.permissionsCurrent;
    this.permissionOptions = s.permissionsOptions;
    /*
     * E125：官方在会话里显示「{turns} 轮 {steps} 步」「缓存命中 {percent}%」。
     * 这里在应用快照时**算成一行**（把 13 个数字塞进 13 个 @State 只会让状态面变大，
     * 而界面需要的本来就是这一行字）。缓存命中率 = 缓存读取 /（未缓存输入 + 缓存读取）。
     */
    {
      const turns: number = s.statsTurns;
      const steps: number = s.statsSteps;
      const cached: number = s.tokensCacheRead;
      const totalIn: number = s.tokensUncachedInput + cached;
      const percent: number = totalIn > 0 ? Math.round((cached / totalIn) * 100) : 0;
      const counts: string = turns > 0 ? `${turns} 轮 ${steps} 步` : '';
      const hit: string = totalIn > 0 ? `缓存命中 ${percent}%` : '';
      /*
       * E129：把 Agent 预设挂进这一行（官方把它显示在**会话标题**上：「在会话标题中查看当前 preset」）。
       * 预设**在会话创建时即固定**，所以它是状态而不是控件——只显示，不给"改当前会话"的入口。
       */
      const preset: string = s.agentPreset.length > 0 ? `预设 ${s.agentPreset}` : '';
      const parts: string[] = [];
      if (counts.length > 0) {
        parts.push(counts);
      }
      if (hit.length > 0) {
        parts.push(hit);
      }
      if (preset.length > 0) {
        parts.push(preset);
      }
      this.statsLine = parts.join(' · ');
      // 时间总览要的是数字本身（见 `sessionStats` 的说明）
      this.sessionStats = {
        turns: turns,
        steps: steps,
        llmMs: s.statsLlmMs,
        toolMs: s.statsToolMs,
        ttftMs: s.statsTtftMs,
        ttftSteps: s.statsTtftSteps,
        decodeMs: s.statsDecodeMs,
        decodeTokens: s.statsDecodeTokens
      };
    }
    // E132：工作区注册表与归档集合（删除/归档的依据）
    this.workspaceRows = s.workspaceRows;
    this.archivedSessionIds = s.archivedSessionIds;
    this.skills = s.skills;
    this.skillNote = s.skillNote;
    this.presets = s.presets;
    this.presetNote = s.presetNote;
    this.queuedCount = s.outbox;
    // 附件列表由中枢拥有（回执是会话作用域的），这里只跟随
    this.attachments = s.attachments;
    this.queued = s.queued;
    this.offline = s.phase === HubPhase.DEGRADED;
    if (!s.connected) {
      // 断开后**清空**上一段连接的数据，而不是留着当「缓存」：
      // 留着的会话列表会让用户以为还能点开会话，点下去全是失败。
      this.sessions = [];
      this.pending = [];
      this.trajectoryItems = [];
      this.workspaces = [];
      this.fileTree = [];
      this.detailSections = [];
      this.models = [];
      this.jobs = [];
      this.plugins = [];
      this.credentials = [];
      // 断连后 Host 设置没了，但**本机偏好仍然有效**（它本来就与 Host 无关）
      this.hostSettings = [];
      this.settings = this.localSettings;
      this.hosts = [];
      this.commands = [];
      this.references = [];
      this.preview = undefined;
      this.attachments = [];
      this.queued = [];
      this.updateHosts();
      this.recomputeDerived();
      return;
    }
    this.sessions = s.sessions;
    this.pending = s.pending;
    this.models = s.models;
    this.jobs = s.jobs;
    this.plugins = s.plugins;
    this.credentials = s.credentials;
    this.hostSettings = s.settings;
    this.settings = mergeSettingsGroups(this.hostSettings, this.localSettings);
    this.piAiProviders = s.piAiProviders;
    this.piAiProtocols = s.piAiProtocols;
    this.commands = s.commands;
    this.planActive = s.planActive;
    this.planPending = s.planPending;
    this.references = s.references;
    // 文件树与预览由中枢持有（它们与会话绑定），这里只跟随：
    // 中枢换了会话就会清空并重列，视图不做任何缓存，避免两边各存一份而后不一致。
    this.fileTree = s.fileNodes;
    this.preview = s.filePreview;
    if (s.defaultSelection !== undefined) {
      /*
       * E167（用户反馈⑤）：**宿主默认里没有推理强度**。
       * 实测 `session/modelCatalog` 的 `default` 只有 `{provider, model}`（没有 effort）
       * ⇒ `selection.effort` 为空 ⇒ 推理强度一排档位**没有任何一个被选中**，
       * 用户看到"默认 high 却没被选中"。用**目录里该模型的 `defaultEffort`** 兜底：
       * 它同样是宿主给的事实（模型自己的能力默认），不是我们编的。
       */
      const selection: ModelSelection = s.defaultSelection;
      if (selection.effort.length === 0) {
        for (let i = 0; i < this.models.length; i++) {
          const m: ModelOption = this.models[i];
          if (m.provider === selection.provider && m.modelId === selection.modelId
            && m.defaultEffort.length > 0) {
            this.selection = {
              provider: selection.provider, modelId: selection.modelId, effort: m.defaultEffort
            };
            break;
          }
        }
      }
      this.selection = this.selection.effort.length > 0 ? this.selection : selection;
    }
    this.selectedSessionTitle = s.selectedTitle;
    if (s.selectedSessionId === this.selectedSessionId) {
      this.trajectoryItems = s.trajectory;
      this.running = s.running;
    }
    // 工作区与详情分区是**派生量**：从真实会话与真实轨迹算出来，
    // 因此只要底料变了就重算，不需要 Host 另发一份。
    this.workspaces = projectWorkspaces(this.sessions);
    this.detailSections = projectDetailSections(this.trajectoryItems);
    this.updateHosts();
    this.recomputeDerived();
  }

  /**
   * 刷新「已配置 Host」列表。
   *
   * 数据源只有两个真实事实：**上次记住的地址**（能力层存储）与**当前连接状态**。
   * 这里绝不编造条目——这个列表上的「已授权」是一条安全陈述。
   */
  private updateHosts(): void {
    this.hosts = projectHosts({
      url: this.rememberedUrl,
      connected: this.hubConnected,
      authority: this.hubAuthority,
      authorized: this.hubConnected || this.rememberedTokenState === 'present',
      // 上游**没有**任何端点或帧给出 Host 核心包版本（`$events` 的 ready 帧
      // 实测只有 `clientId` 与 `host.home`，见 D2 §8.7.12），因此这里只能诚实留空，
      // 设备页显示「核心包版本 未知」。不能拿「受支持版本矩阵」冒充 Host 的版本。
      version: ''
    });
  }

  /**
   * 在当前设置分组里找一项。
   *
   * 返回 `undefined` 说明这个 key 不属于 Host 设置——即**本机偏好**。
   * 两条路径的处置完全不同（Host 项可以写、本机项没有上游写路径），
   * 所以必须先分清，而不是一律当 Host 项去写（那会对不存在的命名空间发起 RPC）。
   */
  private settingItemOf(key: string): SettingItem | undefined {
    for (let i = 0; i < this.settings.length; i++) {
      const items: SettingItem[] = this.settings[i].items;
      for (let j = 0; j < items.length; j++) {
        if (items[j].key === key) {
          return items[j];
        }
      }
    }
    return undefined;
  }

  aboutToAppear(): void {
    // 设备形态只给**最弱的兜底猜测**；真实事实来自系统枚举（下面异步取回），
    // 三者按优先级合成（appstate/model/InputFacts，37 条断言）。它决定右键/悬停是否启用。
    this.formGuessModality = guessFromKeyboardForm(readDeviceFacts().keyboardLikely);
    this.recomputeModality();
    readInputSources().then((sources: InputSourceReading) => {
      this.applyInputSources(sources);
    });
    // 热插拔：运行中插上鼠标/键盘要立刻生效（"手机/平板当工作台用"的常见动作）
    this.unwatchInput = watchInputSources((sources: InputSourceReading) => {
      this.applyInputSources(sources);
    });
    // 详情栏宽度记忆：读回用户上次拖出来的值（没有记录时保持默认）
    this.loadDetailWidth();
    // 侧栏收起状态记忆：读回用户上次的选择（没有记录 ⇒ 默认展开）
    this.loadSidebarExpanded();
    // 初始值 = 空态。所有真实数据都在 `applyHubSnapshot` 到达时落地；
    // 连接建立前界面显示的是各视图自己的空态文案（D3 §4），而不是编造的示例数据。
    this.diag = emptyDiagReport();
    // 核心页先落地一次"未接线/仓库实况"的呈现（D6）。它不依赖连接，因此一开始就能读。
    this.refreshCoreView();
    // 本机偏好是**端侧**的，与连接无关，因此一开始就要有（否则设置页会缺一组）。
    // 当前值来自能力层（它从 preferences 读出后发布到 AppStorage）。
    this.localSettings = this.localPreferenceGroup();
    this.settings = this.localSettings;
    this.updateHosts();
    this.recomputeDerived();
    this.applySize(initialWidthVp(), initialHeightVp());
    this.watchWindowSize();
    // 订阅中枢：多窗口下每个窗口各自订阅，但共用同一个连接与会话状态
    const listener: HubSubscriber = (s: HubSnapshot) => {
      this.applyHubSnapshot(s);
    };
    this.hubListener = listener;
    SessionHub.shared().subscribe(listener);

    // 自动重连：能力层从（加密）存储里读「上次的 Host」是异步的，
    // 可能晚于本页就绪。这里**轮询等待**而不是「读一次就下结论」——
    // 读一次就下结论会让用户看到「请添加 Host」，而他上次明明连过。
    this.waitForRememberedHost();
    // 冷启动时也可能是"从通知进来"的（应用被杀后点通知 → onCreate 带参数）
    this.applyLaunchRoute();
  }

  /**
   * 本机偏好分组（D1 §7.6.5 P0：主题「跟随系统深浅色」，且 D3 §8 要求「设置可覆盖」）。
   *
   * 【为什么这一组是"真的"而不再是桩数据】此前它是被删掉的桩项之一——
   * 删得对（那些项点了没有任何效果），但**功能本身是指定要有的**：
   * 主题模式必须能覆盖系统。现在它由 `platform/LocalPrefs` 持久化、
   * 由能力层在启动时应用、由这里写回并立即生效。
   *
   * 【为什么 key 用 `local.` 前缀】`settingItemOf()` 用"能不能在 Host 设置分组里找到"
   * 来判定一项是不是本机偏好；前缀让来源一眼可辨，也避免与 Host 的命名空间撞名
   * （Host 侧不存在 `local.*` 命名空间）。
   */
  private localPreferenceGroup(): SettingGroup[] {
    const choices: SettingChoice[] = [];
    const options: string[] = [LOCAL_THEME_SYSTEM, LOCAL_THEME_LIGHT, LOCAL_THEME_DARK];
    const labels: string[] = ['跟随系统', '浅色', '深色'];
    for (let i = 0; i < options.length; i++) {
      choices.push({ value: options[i], label: labels[i] });
    }
    const items: SettingItem[] = [{
      key: LOCAL_THEME_KEY,
      label: '主题模式',
      hint: this.themeApplied
        ? '本机偏好：覆盖系统深浅色，只在端侧生效（Host 设置里没有这一项）'
        : '本机偏好：覆盖系统深浅色。**上次应用未成功**（系统拒绝或当前窗口模式不支持）',
      kind: SettingKind.CHOICE,
      boolValue: false,
      textValue: this.themeMode,
      options: options,
      choices: choices,
      readOnly: false,
      hostWritable: false,
      appliesLive: true,
      origin: SettingOrigin.LOCAL,
      userSet: this.themeMode !== LOCAL_THEME_SYSTEM,
      credentialRef: false,
      valueType: SettingValueType.STRING,
      minValue: 0, maxValue: 0, stepValue: 0, hasMin: false, hasMax: false,
      pattern: '', required: false, rawJson: '', structType: ''
    }];
    const out: SettingGroup[] = [];
    out.push({ title: '本机偏好', items: items });
    return out;
  }

  /**
   * 写入本机偏好并**立即应用**主题。
   *
   * 三步的顺序有意义：先落盘（失败要能说出来）→ 再应用（D1 判据：1 秒内生效）→
   * 最后把新值放回 AppStorage 让界面跟着变。任何一步失败都要在 `settingWriteNote`
   * 里如实说明，而不是让用户对着一个没生效的开关反复点。
   */
  private async writeLocalTheme(mode: string): Promise<void> {
    const prefs: LocalPrefs = new LocalPrefs();
    await prefs.attach(getContext(this) as common.UIAbilityContext);
    const saved: boolean = await prefs.saveThemeMode(themeModeOf(mode));
    const applied: boolean = applyThemeMode(getContext(this) as common.UIAbilityContext, themeModeOf(mode));
    AppStorage.setOrCreate<string>('dshThemeMode', mode);
    AppStorage.setOrCreate<boolean>('dshThemeApplied', applied);
    this.localSettings = this.localPreferenceGroup();
    this.settings = mergeSettingsGroups(this.hostSettings, this.localSettings);
    if (!saved || !applied) {
      this.noteSettingWrite(LOCAL_THEME_KEY, !saved
        ? '主题已切换，但**没能保存**：下次启动会回到上次的值。'
        : '主题已保存，但**本次应用未成功**（系统拒绝或当前窗口模式不支持）。');
      return;
    }
    this.noteSettingWrite(LOCAL_THEME_KEY, '主题模式已保存并在本次生效。');
  }

  /**
   * 页面每次变为可见时消费一次路由。
   *
   * 【为什么用 `onPageShow` 而不是 `@Watch`】`@StorageProp` 的 `@Watch` 在本项目里
   * 不被信任（见 `waitForRememberedHost` 的说明）。而通知点击的场景是
   * "应用被切到前台"，`onPageShow` 正是这个时刻——由生命周期驱动比轮询可靠，
   * 也不会在页面已经可见时反复触发。
   */
  onPageShow(): void {
    this.applyLaunchRoute();
  }

  /**
   * 系统返回键（E94）：**有东西可退就先消费，真的到根了才交给系统**。
   *
   * 【为什么要自己处理】本页的导航是**自绘状态机**（`tab` / `stackPage` / `wsDrill` /
   * 各种浮层），不经过 router 栈 ⇒ 系统返回事件没有任何人消费，默认行为是
   * **直接把应用退回桌面**。用户实测报告："许多页面用系统返回会直接退回桌面"。
   *
   * 【顺序 = 从最上面那层往回退】返回键的语义是"关掉当前这一层"，所以：
   *   浮层/编辑态 → 二级页 → 会话详情 → 工作区下钻 → 文件预览 → 非首页签 → 交给系统。
   * 只有**确实停在首页、且没有任何浮层**时才返回 false——那时系统把应用切到后台
   * 才是正确行为，不该被应用吞掉（吞掉会变成"按返回没反应"）。
   *
   * 每一步都写 hilog：真机上核对"到底哪一层没退掉"时，这行日志就是答案。
   */
  onBackPress(): boolean {
    // 优先级阶梯（浮层 → 二级页 → 详情 → 下钻 → 预览 → 首页签 → 交给系统）全部在
    // `appstate/ui/NavigationController.decideBack` 里，并有 fixture 逐级断言；
    // 这里只做**执行 + 日志**，不再自己排顺序。
    const action: BackAction = decideBack(this.navState(), this.overlayState());
    switch (action) {
      case BackAction.CLOSE_CREDENTIAL:
        this.credentialRef = '';
        this.credentialDraft = '';
        this.credentialNote = '';
        this.sheetNoteOwner = '';
        hilog.info(DOMAIN, TAG, 'DSHM-BACK 关闭凭据编辑浮层');
        return true;
      case BackAction.CLOSE_SETTING_DRAFT:
        this.textSettingDraft = '';
        this.structSettingDraft = '';
        this.credentialNote = '';
        this.sheetNoteOwner = '';
        hilog.info(DOMAIN, TAG, 'DSHM-BACK 关闭设置编辑浮层');
        return true;
      case BackAction.CLOSE_SEARCH:
        this.searchOpen = false;
        hilog.info(DOMAIN, TAG, 'DSHM-BACK 关闭搜索');
        return true;
      case BackAction.CLOSE_CHOICE:
        this.choosing = undefined;
        hilog.info(DOMAIN, TAG, 'DSHM-BACK 关闭选择浮层');
        return true;
      case BackAction.CLOSE_DETAIL_OVERLAY:
        // 交给 Sheet 自己收起（`shouldDismiss` 里会复位状态）
        this.detailOverlayOpen = false;
        hilog.info(DOMAIN, TAG, 'DSHM-BACK 关闭详情半模态');
        return true;
      case BackAction.STACK_TO_MAIN: {
        const from: string = this.stackPage;
        this.stackPage = StackPage.MAIN;
        hilog.info(DOMAIN, TAG, 'DSHM-BACK 二级页回主列表：%{public}s', from);
        return true;
      }
      case BackAction.CLOSE_DETAIL:
        this.closeDetail();
        hilog.info(DOMAIN, TAG, 'DSHM-BACK 关闭会话详情');
        return true;
      case BackAction.DRILL_UP:
        this.wsDrill -= 1;
        hilog.info(DOMAIN, TAG, 'DSHM-BACK 工作区上退一层，drill=%{public}d', this.wsDrill);
        return true;
      case BackAction.CLOSE_PREVIEW:
        this.preview = undefined;
        hilog.info(DOMAIN, TAG, 'DSHM-BACK 关闭文件预览');
        return true;
      case BackAction.CLOSE_DRAWER:
        this.setDrawerOpen(false);
        hilog.info(DOMAIN, TAG, 'DSHM-BACK 收起手机导航抽屉');
        return true;
      case BackAction.TAB_TO_SESSIONS:
        this.selectTab(NavTab.SESSIONS);
        hilog.info(DOMAIN, TAG, 'DSHM-BACK 回首页签（会话）');
        return true;
      default:
        // EXIT：**不消费**，交给系统（最小化）。写成 false 是刻意的——
        // "按返回没反应"的假入口都是在这里 return true 造成的。
        hilog.info(DOMAIN, TAG, 'DSHM-BACK 已在根层，交给系统');
        return false;
    }
  }

  /** 导航状态快照（视图持有真实状态，控制器只读） */
  private navState(): NavState {
    return {
      tab: this.currentTab(),
      stackPage: this.stackPage,
      wsDrill: this.wsDrill,
      hasSession: this.selectedSessionId.length > 0,
      detailOpen: this.detailOpen,
      // 手机抽屉：真值在 NavigationState.mobileDrawer（视图不另立一份状态）
      drawerOpen: this.nav.mobileDrawer === DrawerState.OPEN
    };
  }

  /** 浮层状态快照（返回键的第一优先级） */
  private overlayState(): OverlayState {
    return {
      credentialOpen: this.credentialRef.length > 0 || this.credentialDraft.length > 0,
      settingDraftOpen: this.textSettingDraft.length > 0 || this.structSettingDraft.length > 0,
      searchOpen: this.searchOpen,
      choosingOpen: this.choosing !== undefined,
      detailOverlayOpen: this.detailOverlayOpen,
      previewOpen: this.preview !== undefined
    };
  }

  /**
   * 消费通知点击携带的路由。
   *
   * 【为什么消费后要清掉它】不清掉的话，用户此后每次把应用切到前台
   * （甚至只是切回来）都会被重新导航一次——他正在看别的地方，界面却跳走。
   * 清掉用的是 `AppStorage.setOrCreate`（`@StorageProp` 的赋值只改本地副本）。
   */
  private applyLaunchRoute(): void {
    const json: string = this.launchRouteJson;
    if (json.length === 0) {
      return;
    }
    AppStorage.setOrCreate<string>('dshLaunchRouteJson', '');
    const route: NotifyRoute | undefined = parseNotifyRoute(json);
    if (route === undefined) {
      // 解析不出来就**不跳转**：宁可停在当前页面，也不要跳到一个猜出来的位置。
      // （能走到这里通常意味着通知是旧版本写下的，参数形状已经变了。）
      return;
    }
    // `hostId` 目前不使用：本客户端只保存一个 Host（多 Host 管理未落地），
    // 因此"切回正确连接"这一步无对象可切。等多 Host 落地后在这里接。
    if (route.page === 'pending') {
      this.selectTab(NavTab.PENDING);
      return;
    }
    if (route.page === 'diagnostics') {
      this.openDiagnostics();
      return;
    }
    // 默认：会话页；带 sessionId 时直接下钻到那个会话
    this.selectTab(NavTab.SESSIONS);
    const sessionId: string | undefined = route.sessionId;
    if (sessionId !== undefined && sessionId.length > 0) {
      this.openSession(sessionId);
    }
  }

  /**
   * 等待并尝试自动重连（D1 §7.1：记住上次的 Host）。
   *
   * 【为什么轮询而不是订阅】`@StorageProp` 会在 AppStorage 变化时刷新界面，
   * 但**不会通知一段命令式代码**（ArkTS 的 `@Watch` 不保证可用于 `@StorageProp`）。
   * 与其依赖一个不确定的机制，不如用一个有界、可读的等待：
   * 每 250 ms 看一次，最多等 4 秒（存储打开 + 解密读取的正常量级）。
   * 超时后**不再自动重连**，但保留 UI 上的「添加 Host」——用户不会卡住。
   *
   * 【为什么只跑一次】`StorageProp` 的任何变化都会重进这个函数时，
   * 多次认证会在 Host 侧产生多次 token 兑换，也会让界面反复闪「连接中」。
   */
  private waitForRememberedHost(): void {
    if (this.autoConnectAttempted) {
      hilog.info(DOMAIN, TAG, 'DSHM-CONN 已安排过等待，跳过重复安排');
      return;
    }
    this.autoConnectAttempted = true;
    hilog.info(DOMAIN, TAG,
      'DSHM-CONN 开始等待记住的 Host：url=%{public}s tokenLen=%{public}d state=%{public}s auto=%{public}s',
      this.rememberedUrl, this.rememberedToken.length, this.rememberedTokenState,
      this.shouldAutoConnect ? 'true' : 'false');
    let waited: number = 0;
    const step: number = 250;
    /*
     * 【窗口为什么是 45 秒】本端自起 Host 要先解包核心再让 dsh 启动，实测 15~20 秒才把
     * token 发布到 AppStorage。窗口太短（原 4 秒）会让页面**从未发出认证请求**。
     *
     * 【为什么不在第一次连接后就停】因为**先到的那份凭据通常是过期的**：`persistConnectedHost`
     * 会把上一轮的 baseUrl+token 落盘，页面在 250 ms 就能读到，而 **dsh 每次启动都换新 token**
     * （本轮实测：新 token 在 +2238 ms 才由 `adoptLocalHost` 发布）。所以轮询要**一直跑到预算用完**，
     * 只在 `(url, token)` 这一对**变化**时重连（最多 3 次）——这既覆盖"首次连接"，
     * 也覆盖"旧 token 失败 → 新 token 到达后重连"这个正常序列。
     */
    const limit: number = 45000;
    const maxAttempts: number = 3;
    const timer: number = setInterval(() => {
      waited += step;
      const state: string = this.rememberedTokenState;
      const ready: boolean = state === 'found'
        && this.rememberedUrl.length > 0
        && this.rememberedToken.length > 0;
      if (ready) {
        const key: string = `${this.rememberedUrl}\u0000${this.rememberedToken}`;
        if (key !== this.lastConnectKey && this.connectAttempts < maxAttempts) {
          this.lastConnectKey = key;
          this.connectAttempts += 1;
          hilog.info(DOMAIN, TAG, 'DSHM-CONN 第 %{public}d 次自动连接：url=%{public}s tokenLen=%{public}d',
            this.connectAttempts, this.rememberedUrl, this.rememberedToken.length);
          this.applyRememberedHostOutcome(state);
        }
      }
      if (waited >= limit || this.connectAttempts >= maxAttempts) {
        clearInterval(timer);
        hilog.info(DOMAIN, TAG, 'DSHM-CONN 等待结束：waited=%{public}dms attempts=%{public}d state=%{public}s',
          waited, this.connectAttempts, state);
      }
    }, step);
  }

  /**
   * 按 token 的读取结果决定下一步，并给出**如实的**说明。
   *
   * 三种状态对应三种不同的用户动作，绝不能用同一句「请重新粘贴 token」糊过去：
   *   - `found`：直接重连；
   *   - `absent`：首次使用（或用户清过数据），引导添加 Host；
   *   - `unavailable`：**记录还在但这次读不到**（设备锁屏策略变化、存储系统故障）。
   *     让用户重新粘贴 token 是错的建议——token 并没有丢。
   */
  private applyRememberedHostOutcome(state: string): void {
    if (this.rememberedUrl.length === 0) {
      hilog.info(DOMAIN, TAG, 'DSHM-CONN 无记住的地址：不自动连接（等待本端 Host 或用户添加）');
      return;
    }
    if (state === 'found' && this.rememberedToken.length > 0) {
      const hub: SessionHub = SessionHub.shared();
      /*
       * 【E98】把入口脚本准备好的**可写工作区**交给中枢：建会话时它会被当成 `cwd` 传下去。
       *
       * 真机证据：不设它时，设备上建出来的会话 `cwd` 是 `/`（宿主进程工作目录继承自应用进程），
       * 于是打开会话时轨迹流抛 `gateway/internal …reading 'kind'`、文件列表 `cannot list`。
       * 取不到就**不设**（回到 Host 默认行为），绝不猜一个路径。
       */
      try {
        const wsCtx = getContext(this) as common.UIAbilityContext;
        const wsHost: DshHost = this.coreHost(wsCtx.filesDir, wsCtx.resourceDir, wsCtx.cacheDir);
        const ws: string = wsHost.localHostWorkspace();
        if (ws.length > 0) {
          hub.setDefaultWorkspace(ws);
          this.localWorkspaceDir = ws;
          hilog.info(DOMAIN, TAG, 'DSHM-CONN 默认工作区：%{public}s', ws);
        }
      } catch (e) {
        const err = e as Error;
        hilog.warn(DOMAIN, TAG, 'DSHM-CONN 读默认工作区失败（不设 cwd）：%{public}s', err.message);
      }
      // 【token 必须拼回 URL】`SessionHub.configure(address, name)` 的第二个参数是
      // **显示名**，不是 token——token 是从地址串里解析出来的（`parseTarget`）。
      // 只传裸 baseUrl 会让认证拿着空 token 去请求，Host 回
      // 「未提供 token」而界面显示「连接失败（HTTP 0）」，看起来像网络问题。
      // 实测踩到过。拼接后走同一条解析路径，与手动粘贴 URL 完全等价。
      const connectUrl: string = composeHostUrl(this.rememberedUrl, this.rememberedToken);
      if (!hub.configure(connectUrl, undefined)) {
        hilog.warn(DOMAIN, TAG, 'DSHM-CONN configure 被拒（地址形态不合法？）：%{public}s', this.rememberedUrl);
        return;
      }
      this.connectBusy = true;
      this.connectResult = `正在自动重连 ${this.rememberedUrl}…`;
      this.connectSettled = false;
      hub.connect().then((ok: boolean) => {
        this.connectBusy = false;
        // 尝试已结束（成功或失败都算"结束"）：从这里开始，错误文本才是**结论**而不是中间态
        this.connectSettled = true;
        const snap: HubSnapshot = hub.snapshot();
        /*
         * 【为什么这里一定要打日志（E62/E63）】`connect()` 内部会先做 token→cookie 兑换
         * （`SessionHub.connect` 无条件调 `authenticate()`，失败即 `DEGRADED` 返回），
         * 而端侧实测到 3120 的流量只有"就绪探测 401 + 8 次 POST 400"、**没有兑换请求**。
         * 失败原因就在 `snap.lastError`（例如"未提供 token"）——不打出来，外面只能看到
         * "端口通了但界面没连上"，与真实原因隔着一层。
         */
        hilog.info(DOMAIN, TAG, 'DSHM-AUTH connect 结果：ok=%{public}s sessions=%{public}d err=%{public}s',
          ok ? 'true' : 'false', snap.sessions.length,
          snap.lastError.length > 0 ? snap.lastError : '(none)');
        this.connectResult = ok
          ? `已自动重连 ${snap.authority}，收到 ${snap.sessions.length} 个会话`
          : '自动重连失败，请检查 Host 是否仍在运行。';
        if (!ok) {
          this.hubError = snap.lastError.length > 0
            ? snap.lastError
            : '自动重连失败。若 Host 已重启，它的 token 会重新生成，请重新粘贴启动链接。';
        } else {
          // 自动重连也报告一次：地址可能没变但 token 被轮换过（Host 重启），
          // 报告让存储里始终是**最近一次真正有效的**token。
          reportConnectedHost(this.rememberedUrl, this.rememberedToken);
          // 【连上就重读核心阶段（E83）】核心起来与"页面渲染完"是两件事，先后不定：
          // 首启时页面往往先渲染（阶段"未安装"），核心随后才 READY。会话页的空态文案
          // 由阶段决定，所以连上的这一刻必须把阶段刷新一次，否则空态会一直停留在
          // 「还没有安装核心」，把用户指向一个完全错误的方向。
          this.refreshCoreView();
          // 【连上就把沙箱工作区注册进 Host（E98）】注册后建会话会带上 `workspaceId`：
          // 真机上只传 cwd 而不注册时，打开会话会抛 `…reading 'kind'`（轨迹流失败）、
          // 文件列表也 `cannot list`。这一步是"能真正在某个目录里干活"的前提。
          if (this.localWorkspaceDir.length > 0) {
            hub.ensureWorkspace(this.localWorkspaceDir).then((note: string) => {
              hilog.info(DOMAIN, TAG, 'DSHM-CONN 工作区注册：%{public}s', note);
            }).catch((e: Object) => {
              const err = e as Error;
              hilog.warn(DOMAIN, TAG, 'DSHM-CONN 工作区注册异常：%{public}s', err.message);
            });
          }
        }
      });
      return;
    }
    if (state === 'unavailable') {
      // 关键区别：token 还在，只是这次取不出来
      this.connectResult = `已记住 Host ${this.rememberedUrl}，但这次的访问令牌读不出来`
        + '（通常是设备锁屏状态或存储策略变化导致的）。令牌没有被删除，'
        + '解锁设备后重启应用通常即可恢复；也可以现在重新粘贴启动链接覆盖它。';
      return;
    }
    // absent：首次使用
    this.connectResult = `已记住 Host ${this.rememberedUrl}，但没有可用的访问令牌。`
      + '请在 Host 上重新获取带 token 的启动链接并粘贴到下方。';
  }

  aboutToDisappear(): void {
    this.unwatchWindowSize();
    if (this.unwatchInput !== undefined) {
      this.unwatchInput();
      this.unwatchInput = undefined;
    }
    // 只退订本窗口；**不得**在此断开连接——关掉一个窗口不能让其他窗口掉线
    // （D1 §7.7.5b：「关任一窗口不影响其他窗口与连接」）
    const listener: HubSubscriber | undefined = this.hubListener;
    if (listener !== undefined) {
      SessionHub.shared().unsubscribe(listener);
      this.hubListener = undefined;
    }
  }

  /**
   * 跑一次**真实**连接诊断并把结果接到界面。
   *
   * 【为什么必须用真实报告】此前诊断页整页显示的是 `stubDiagnostics()` 的桩数据，
   * 于是连上真实 Host 后仍然显示 `home=D:/work`、`74 个端点（0.1.2-rc.1）`——
   * 与真正连着的 Host（`home=C:\Users\aotian`、48 个设置项的 0.1.5-rc.1）**完全不同**。
   * 一个「诊断页」报出与事实不符的主机信息，比没有诊断页更糟：
   * 用户会据此判断「连错了 Host」或「版本不匹配」，而两者都不成立。
   * （本轮就是这么被误导过一次。）
   *
   * 结论行仍由 `dshcompat` 提供（UI 不得自行拼写上游端点名，D5 §1），
   * 五项的判定值来自 `SessionHub.diagnose()` → `Connection.diagnose()`。
   */
  /** 打开诊断页：先跑一次**真实**诊断再进入，避免显示上一次或桩的结果 */
  private openDiagnostics(): void {
    this.stackPage = StackPage.DIAGNOSTICS;
    this.runDiagnostics();
  }

  private async runDiagnostics(): Promise<void> {
    this.diagRunning = true;
    const hub: SessionHub = SessionHub.shared();
    const report: DiagnosticReport = await hub.diagnose();
    this.diag = projectDiagnostics(report);
    this.diagRunning = false;
  }

  /**
   * 导出诊断报告到剪贴板。
   *
   * 只包含判定结论与旁路日志，**不含**消息内容、token、cookie（D1 §11.5 S4）。
   */
  private exportDiagnostics(): void {
    const lines: string[] = [];
    lines.push(`# ${APP_NAME} 诊断报告（${new Date().toISOString()}）`);
    lines.push(`Host: ${this.hubAuthority.length > 0 ? this.hubAuthority : '未配置'}`);
    lines.push(`阶段: ${this.hubPhase} · 连接=${this.hubConnected}`);
    lines.push('');
    for (let i = 0; i < this.diag.entries.length; i++) {
      const e: DiagEntry = this.diag.entries[i];
      lines.push(`${e.passed ? '通过' : '失败'}  ${e.name}: ${e.detail}`);
      if (e.advice.length > 0) {
        lines.push(`      建议: ${e.advice}`);
      }
    }
    lines.push('');
    lines.push(`版本判定: ${this.diag.versionVerdict} — ${this.diag.versionMessage}`);
    lines.push(`端点上表: ${this.diag.tableStats}`);
    if (this.traceEnabled) {
      lines.push('');
      lines.push('## 协议旁路日志');
      for (let j = 0; j < this.traceLines.length; j++) {
        lines.push(this.traceLines[j]);
      }
    }
    const text: string = lines.join('\n');
    copyText(text).then((ok: boolean) => {
      this.hubError = ok
        ? '诊断报告已复制到剪贴板（已剔除凭据与消息内容）。'
        : '复制失败：剪贴板不可用。';
    });
  }

  private recomputeDerived(): void {
    const n: number = this.pending.length;
    this.pendingBadge = n <= 0 ? '' : (n > 99 ? '99+' : `${n}`);
  }

  // ───────────────────── 形态判定（D3 §2.2） ─────────────────────

  private watchWindowSize(): void {
    try {
      window.getLastWindow(getContext(this)).then((win: window.Window) => {
        const rect = win.getWindowProperties().windowRect;
        this.applySize(px2vp(rect.width), px2vp(rect.height));
        const listener = (size: window.Size) => {
          this.applySize(px2vp(size.width), px2vp(size.height));
        };
        this.widthListener = listener;
        win.on('windowSizeChange', listener);
      }).catch(() => {
      });
    } catch (error) {
    }
  }

  private unwatchWindowSize(): void {
    const listener = this.widthListener;
    if (listener === undefined) {
      return;
    }
    this.widthListener = undefined;
    try {
      window.getLastWindow(getContext(this)).then((win: window.Window) => {
        win.off('windowSizeChange', listener);
      }).catch(() => {
      });
    } catch (error) {
    }
  }

  /** 切档位并修正派生状态（不重载数据，D3 §2） */
  private applySize(widthVp: number, heightVp: number): void {
    this.winWidthVp = widthVp;
    this.winHeightVp = heightVp;
    // 档位与详情栏可用性都来自**一处**决策（appstate/ui/LayoutController），
    // 本文件不再自己拼断点判断——否则"什么宽度显示什么"会有两份实现，破版时两处都要查。
    const decision: LayoutDecision = this.layoutDecision();
    const next: LayoutMode = decision.mode;
    if (next === this.mode) {
      return;
    }
    this.mode = next;
    if (next !== LayoutMode.SINGLE && this.stackPage === StackPage.CONVERSATION) {
      this.stackPage = StackPage.MAIN;
    }
    // 变宽到三栏时，详情改由右栏承担 ⇒ 关掉 Sheet（否则两处同时显示详情）
    if (next === LayoutMode.TRIPLE) {
      this.detailOverlayOpen = false;
    }
    if (!decision.detailAvailable) {
      this.detailOpen = false;
    } else if (this.selectedSessionId.length > 0) {
      this.detailOpen = true;
    }
  }

  /**
   * 落地一次枚举结果（`null` 表示枚举不可用，此时靠形态猜测兜底）。
   *
   * 摊平去重由纯模型做（`flattenSources`）——平台层只把"每台设备的输入源"原样交回来，
   * 它**不认识** appstate（架构边界：platform 在 appstate 之下，不许反向依赖）。
   */
  private applyInputSources(sources: InputSourceReading): void {
    this.enumeratedModality = sources === null
      ? null
      : modalityFromSources(flattenSources(sources));
    this.recomputeModality();
  }

  /** 重新合成输入模态事实：① 枚举（权威，可增可减）② 事件证据（只增不减）③ 形态猜测（兜底） */
  private recomputeModality(): void {
    const evidence: ModalityEvidence = {
      enumerated: this.enumeratedModality,
      observed: this.observedModality,
      formGuess: this.formGuessModality
    };
    this.modality = modalityOf(evidence);
    this.modalityNote = modalityTrace(evidence).join('；');
  }

  /**
   * 事件证据：指针悬停过 ⇒ 这台设备有指针。
   *
   * 【为什么还需要它】设备枚举可能失败（API 不可用/系统差异），那时只剩形态猜测，
   * 而"手机插鼠标"恰恰是猜测判错的场景；一次悬停就能把它救回来。
   * 只增不减：一次证明即长期成立，鼠标拔掉后留着 hover 语义也不会错（只是不再触发）。
   */
  private notePointerEvidence(): void {
    if (this.observedModality.hasPointer) {
      return;
    }
    this.observedModality = unionModality(this.observedModality, { hasKeyboard: false, hasPointer: true });
    this.recomputeModality();
  }

  /** 事件证据：收到物理按键 ⇒ 这台设备有键盘（软键盘不产生按键事件） */
  private noteKeyboardEvidence(): void {
    if (this.observedModality.hasKeyboard) {
      return;
    }
    this.observedModality = unionModality(this.observedModality, { hasKeyboard: true, hasPointer: false });
    this.recomputeModality();
  }

  /**
   * 输入模态作为**一条真实诊断项**。
   *
   * 【为什么它该出现在诊断页】这条链路上"采集失败"与"真的没有设备"现象完全一样
   * （hover 不生效），而诊断页是用户唯一能看到"为什么"的地方。`passed` 判的是
   * **设备枚举是否可用**（不可用时会退回形态猜测，那是已知会判错的路径）。
   */
  private modalityEntry(): DiagEntry {
    const enumerated: InputModality | null = this.enumeratedModality;
    const flags: string = `键盘=${this.modality.hasKeyboard ? '是' : '否'} 指针=${this.modality.hasPointer ? '是' : '否'}`;
    return {
      name: '输入模态（键鼠 / 指针）',
      passed: enumerated !== null,
      detail: this.modalityNote.length === 0 ? flags : `${flags} · ${this.modalityNote}`,
      advice: enumerated === null
        ? '输入设备枚举不可用，已退回按设备形态猜测：手机插鼠标、平板用触控笔时可能画不出 hover 与右键'
        : '真实事实来自系统枚举；插拔鼠标/键盘会自动重新枚举'
    };
  }

  /**
   * 当前窗口尺寸下的布局决策。
   *
   * 输入模态现在传**真实事实**（此前硬编码 false，因为 `pointerRich` 当时没有消费点；
   * 事实链路打通后按实际值传，避免"决策里写着 false、别处却按有鼠标渲染"这种两个真值）。
   */
  private layoutDecision(): LayoutDecision {
    const input: LayoutInput = {
      widthVp: this.winWidthVp,
      heightVp: this.winHeightVp,
      hasKeyboard: this.modality.hasKeyboard,
      hasPointer: this.modality.hasPointer
    };
    // 用**用户想要的**栏宽（拖拽把手会改它；窗口装不下时由让步链夹取）
    return decideLayoutWithDetail(input, this.detailWidthDesired);
  }

  /**
   * 关闭详情。
   *
   * 【为什么要一处收口】详情的"打开"状态有两个标志：三栏用 `detailOpen`（真右栏）、
   * 单栏/双栏用 `detailOverlayOpen`（Sheet / 侧边面板）。面板内的 × 若只清其中一个，
   * 在另一种呈现下就是**点了没反应**——这正是本项目反复出现的缺陷形态。
   * 两个标志在任一时刻只有一个是有效的，所以一起清是安全的。
   */
  private closeDetail(): void {
    this.detailOpen = false;
    this.detailOverlayOpen = false;
  }

  /** 切换详情：呈现方式随档位（三栏 = 右栏，单栏/双栏 = 浮层） */
  private toggleDetail(): void {
    if (this.detailPresentationNow() === DetailPresentation.COLUMN) {
      this.detailOpen = !this.detailOpen;
      return;
    }
    this.detailOverlayOpen = !this.detailOverlayOpen;
  }

  /** 当前档位下详情怎么呈现（真右栏 / 侧边浅层面板 / 整页） */
  private detailPresentationNow(): DetailPresentation {
    return this.layoutDecision().detailPresentation;
  }

  /**
   * 双栏下侧边浅层面板的宽度。
   *
   * 复用"用户想要的宽度"与同一套夹取规则（`clampDetailDesired`）：双栏虽然不并排详情栏，
   * 但面板仍要让列表露出来，故必须夹在可用空间内。用户拖过的宽度在这里也被尊重。
   */
  private sidePanelWidthVp(): number {
    return clampDetailDesired(this.detailWidthDesired, this.detailRoomVp());
  }

  /** 当前窗口下详情栏可用的最大宽度（拖拽时在这里夹住，避免"拖宽反而跳成最窄"） */
  private detailRoomVp(): number {
    return detailRoomOf(this.winWidthVp, this.navWidthVp());
  }

  /** 抓手的目标尺寸：触控要 44vp 才点得准，指针 24vp 就够（与 `Sz` 的既有取舍一致） */
  private gripHitWidth(): number {
    return this.modality.hasPointer ? Sz.POINTER_MIN : Sz.TOUCH_MIN;
  }

  /**
   * 开始拖拽：先**归一化**再记起点。
   *
   * 【为什么必须先夹一次】窗口缩小后 `detailWidthDesired`（用户意图）会大于当前可用空间，
   * 而屏幕上显示的是被让步链夹过的宽度。此时若直接拿意图当起点，`offsetX` 从 0 开始的第一帧
   * 就会把栏宽"刷"到夹取值——表现为**一碰把手栏就跳一下**。先夹再记，拖拽从用户看到的宽度开始。
   * （`offsetX` 是相对手势起点的累计量，故必须用起点换算而不是逐帧累加。）
   */
  private beginDetailDrag(): void {
    this.detailWidthDesired = clampDetailDesired(this.detailWidthDesired, this.detailRoomVp());
    this.dragStartWidth = this.detailWidthDesired;
  }

  /** 拖拽中：把手在详情栏左边缘 ⇒ 往左拖是变宽（方向规则在模型里，有断言） */
  private updateDetailDrag(deltaXVp: number): void {
    this.detailWidthDesired = dragDetailWidth(this.dragStartWidth, deltaXVp, this.detailRoomVp());
  }

  /**
   * 拖拽结束：把宽度记进本机偏好（下次开窗沿用）。
   *
   * 【落盘失败要说出来吗】它与主题不同（主题失效用户立刻看得见），但"静默不生效"正是本项目
   * 反复批评的形态，故给一句轻提示、不阻断操作。
   */
  private endDetailDrag(): void {
    const prefs: LocalPrefs = new LocalPrefs();
    const width: number = this.detailWidthDesired;
    prefs.attach(getContext(this) as common.UIAbilityContext).then(() => {
      prefs.saveDetailWidth(width).then((ok: boolean) => {
        if (!ok) {
          this.attachNotice = '详情栏宽度这次没能记住：下次打开会回到默认宽度。';
        }
      });
    });
  }

  /** 读回记住的宽度（没有记录/坏值 ⇒ 默认值；收窄规则在模型里，有断言） */
  private async loadDetailWidth(): Promise<void> {
    const prefs: LocalPrefs = new LocalPrefs();
    await prefs.attach(getContext(this) as common.UIAbilityContext);
    const stored: number | undefined = await prefs.loadDetailWidth();
    this.detailWidthDesired = detailWidthOf(stored);
  }

  /**
   * **布局决策里的**导航宽度（形态默认：三栏 240 / 双栏 56 / 单栏 0）。
   *
   * 【与 `sidebarTrackWidthVp` 的分工，不要合并】这个值是"按形态该留多少"，
   * 让步链（`decideLayoutWithDetail`）内部用的就是它，拖拽夹取（`detailRoomOf`）
   * 必须跟它一致，否则夹出来的宽度会被决策再收窄一次，拖动时跳变。
   * 侧栏轨道实际画多宽是另一件事（用户可能收起了侧栏）——那一个叫
   * `sidebarTrackWidthOf`。收起侧栏会让主区自然变宽（主区是 `layoutWeight(1)`），
   * 详情栏的可用空间仍然按这条保守值算：偏保守只会让栏窄一点，不会重叠。
   */
  private navWidthVp(): number {
    return this.layoutDecision().navWidthVp;
  }

  /** 详情栏宽度（唯一来源：布局决策，含让步链的收窄结果） */
  private detailWidthVp(): number {
    return this.layoutDecision().detailWidthVp;
  }

  // ───────────────────── 交互 ─────────────────────

  private titleOf(id: string): string {
    const list: SessionListItem[] = this.sessions;
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        return list[i].title;
      }
    }
    return '';
  }

  private openSession(id: string): void {
    // "进会话要同步哪些字段"在模型里只有一处（`enterSession`）：当前会话、主区回会话面板、
    // **收起手机抽屉**、右栏在不可用时回落到可用面板。此前这几个字段散在这里手写，
    // 抽屉那条就没人管（手机上从抽屉里点会话 ⇒ 抽屉还挡在前面）。
    this.nav = enterSession(this.nav, id, this.panelRegistry);
    this.selectedSessionId = id;
    this.selectedSessionTitle = this.titleOf(id);
    // 先清空再由中枢的 `session/follow` 推真实轨迹。
    // 不清空会让新会话的轨迹追加在旧会话后面（看起来像「会话里混进了别人的内容」）。
    this.trajectoryItems = [];
    this.running = false;
    if (this.hubConnected) {
      // 中枢会在切会话后重拉命令目录、文件树与引用候选（三者都是会话作用域的）
      SessionHub.shared().selectSession(id);
    }
    if (this.mode === LayoutMode.SINGLE) {
      this.stackPage = StackPage.CONVERSATION;
    } else if (this.mode === LayoutMode.TRIPLE) {
      this.detailOpen = true;
    }
  }

  /**
   * 切换一级页签（E108：待决已并入工作区，这里做一次归一化）。
   *
   * `NavTab.PENDING` 还留在枚举里（历史调用点仍会传它，例如"有待决时跳过去看"），
   * 但页签栏里已经没有它——统一落到工作区视图，那里有内联的待决区。
   */
  /**
   * 切换一级页签。
   *
   * 归一化（待决→工作区、核心→设置）、清栈、是否清空会话选择、是否重读静态事实，
   * 全部来自 `appstate/ui/NavigationController.selectTab`（纯函数，有 fixture 覆盖）；
   * 本方法只负责把决策**落到状态**并执行副作用。
   */
  /**
   * 此刻主区在显示哪个面板（P0-2：三类线索的组合收在纯模型里，视图只读一个值）。
   *
   * 组合规则见 `NavigationState.activeMainPanelOf`（有 fixture）——**视图不再自己拼**。
   */
  private activePanel(): string {
    return activeMainPanelOf(this.nav, this.stackPage, this.selectedSessionId.length > 0);
  }

  /** 当前页签（派生值：由主区面板经桥反查；视图不再持有第二份真值） */
  /**
   * 选中会话的工作区名（给会话头的上下文行）。
   *
   * 【为什么拿不到就给空串】「不知道」与「没有工作区」是两件事，而在这一格上两者的表现相同：
   * 整段不显示。拿不到的原因如实写在代码里——会话列表还没回来，或这条会话 host 侧给了空 cwd。
   */
  private selectedSessionWorkspaceName(): string {
    for (let i = 0; i < this.sessions.length; i++) {
      if (this.sessions[i].id === this.selectedSessionId) {
        return workspaceNameOf(this.sessions[i].cwd);
      }
    }
    return '';
  }

  /** 选中会话的最近活动时间（毫秒；0 = 列表里没有它 ⇒ 不显示「多久没动」） */
  private selectedSessionUpdatedAt(): number {
    for (let i = 0; i < this.sessions.length; i++) {
      if (this.sessions[i].id === this.selectedSessionId) {
        return this.sessions[i].updatedAt;
      }
    }
    return 0;
  }

  private currentTab(): NavTab {
    return legacyTabOfMainPanel(this.nav.selectedMainPanel) as NavTab;
  }

  private selectTab(tab: NavTab): void {
    const d: TabSelection = decideTabSelection(this.navState(), tab);
    // 唯一真值是主区面板：旧页签取值经桥落到面板 id，并且**经注册表校验**
    // （不可用的面板切不过去——要么切过去，要么不动，不会"点了却到别处"）
    this.nav = navigateToMain(this.nav, mainPanelOfLegacyTab(d.tab), this.panelRegistry);
    this.stackPage = d.stackPage;
    this.wsDrill = d.wsDrill;
    if (d.clearSession) {
      this.selectedSessionId = '';
      this.selectedSessionTitle = '';
    }
    if (d.refreshStaticFacts) {
      // 空态文案由核心阶段决定，而首启时序是"页面先渲染、核心后就绪" ⇒ 每次进
      // 非工作区页签都重读，避免出现"核心页说就绪、会话页说没装"的自相矛盾读数。
      this.refreshCoreView();
      if (this.hubConnected) {
        // 技能/预设/提供方目录都是会话无关的静态事实，进设置页时一并刷新
        SessionHub.shared().refreshSkills();
        SessionHub.shared().refreshAgentPresets();
        SessionHub.shared().refreshProviderCatalog();
      }
    }
  }

  private openPoc(): void {
    router.pushUrl({ url: 'pages/Poc1' }).catch(() => {
    });
  }

  /**
   * 把工作区里的一个文件投喂成附件（读整文件字节 → 上传 → 拿回执）。
   *
   * 投喂后**跳回会话页**：附件是「下一条消息的附件」，用户需要看到它挂在输入区上。
   * 停在文件树页会让人以为投喂没发生（那条上传成功的 trace 只有诊断页能看到）。
   */
  private async attachWorkspaceFileToComposer(node: FileNode): Promise<void> {
    if (!this.hubConnected) {
      this.attachNotice = '当前离线：无法读取与上传 Host 侧文件。';
      return;
    }
    this.attachNotice = `正在读取并上传「${node.name}」…`;
    const outcome: AttachOutcome = await SessionHub.shared()
      .attachWorkspaceFile(node.path, node.name, node.size);
    this.attachNotice = outcome.ok ? '' : `投喂「${node.name}」失败：${outcome.reason}`;
    if (outcome.ok) {
      this.selectTab(NavTab.SESSIONS);
    }
  }

  /**
   * 抬起系统文件选择器，并把选中的文件上传成附件回执。
   *
   * 三种非成功结果**必须分开提示**（见 `platform.PickOutcome`）：
   *   - 用户取消 → **什么都不提示**（提示「失败」会让人以为操作出错了）；
   *   - 文件过大 → 说明大小与上限（这是可修复的选择）；
   *   - 选择/读取失败 → 给出原因与建议。
   * 合并成一句「附件添加失败」会让用户重试同一个动作。
   */
  private async pickAndAttach(): Promise<void> {
    const picked: PickedFile = await pickDocument(getContext(this) as common.Context);
    if (picked.outcome === PickOutcome.CANCELLED) {
      return;
    }
    if (picked.outcome === PickOutcome.TOO_LARGE) {
      this.attachNotice = picked.reason;
      return;
    }
    if (picked.outcome === PickOutcome.FAILED) {
      this.attachNotice = picked.reason;
      return;
    }
    this.attachNotice = '正在上传附件…';
    const outcome: AttachOutcome =
      await SessionHub.shared().attachLocalFile(picked.name, picked.base64, picked.bytes, picked.mediaType);
    // 上传结果必须覆盖掉「正在上传」——否则失败时界面会一直停在「正在上传…」，
    // 而用户以为它还在传（实际早就失败了）。
    this.attachNotice = outcome.ok ? '' : `附件「${picked.name}」添加失败：${outcome.reason}`;
  }

  /**
   * 取一个 cwd 属于该工作区的会话 id，作为文件浏览的作用域。
   *
   * 文件端点的作用域是会话级（`workspaceFileScopeId` = sessionId，D2b §2.0），
   * 而工作区只是一个目录，本身不是端点参数。因此「浏览某个工作区」必须落实到
   * 「用某个 cwd 落在该目录里的会话去列目录」。没有这样的会话时返回空串，
   * 由调用方保持空态并说明原因（而不是拿别的会话去列，那会列出**错误目录**的内容）。
   */
  private sessionForWorkspace(workspaceId: string): string {
    for (let i = 0; i < this.sessions.length; i++) {
      const item: SessionListItem = this.sessions[i];
      if (item.cwd.length > 0 && normalizePathKey(item.cwd) === workspaceId) {
        return item.id;
      }
    }
    return '';
  }

  /**
   * 展开/折叠文件树节点。
   *
   * 真实数据在枢纽里（目录内容要发 `workspaceFiles/list`），因此这里只转发。
   * 文件树**没有本地副本**——两份必然不同步，而「展开了一个不存在的子节点」
   * 这种不一致在界面上看起来完全正常。
   */
  private toggleDirectory(path: string): void {
    SessionHub.shared().toggleDirectory(path);
  }

  private openFile(node: FileNode): void {
    SessionHub.shared().openFile(node.path, node.name);
    if (this.mode === LayoutMode.SINGLE) {
      this.wsDrill = 2;
    }
  }

  /**
   * 切换计划模式（官方 `ui-plan` 的一级 chip，E202）。
   *
   * 【为什么走命令而不是端点】切换没有专用端点——宿主把"进入或退出计划模式"做成了一条
   * `plan` 命令（见 `ui-commands` 的 `description.plan`），所以这里执行 `/plan`。
   * 判据（生效值 = `pending ? !active : active`）在 Composer 与这里各用一次，
   * 但**只由中枢的投影驱动**，不缓存派生值。
   */
  private togglePlan(): void {
    SessionHub.shared().executeCommand('/plan').then((n: ActionNotice) => {
      // 计划模式的开关在会话输入区 ⇒ 回执也必须落在会话输入区上方那条通道里
      // （设置回执只在设置页顶部显示，用户看不见）。
      this.attachNotice = this.noticeText(n);
    }).catch((e: Object) => {
      this.attachNotice = '切换计划模式失败：' + (e as Error).message;
    });
  }

  /**
   * 引用一条消息到输入框。
   *
   * 【为什么是"加前缀"而不是把原文塞进去】引用要给**上下文**：只复制原文，用户会分不清
   * 哪句是自己写的哪句是引的。逐行加 `> ` 是 Markdown 的引用语法，也是官方 Web 的做法，
   * 发送后模型与界面都能正确理解这是引用。
   */
  private quoteIntoDraft(item: TrajectoryItem): void {
    if (item.body.length === 0) {
      this.attachNotice = '这条消息没有可引用的正文。';
      return;
    }
    const lines: string[] = item.body.split('\n');
    const quoted: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      quoted.push('> ' + lines[i]);
    }
    const prefix: string = this.draft.length > 0 ? this.draft + '\n' : '';
    this.draft = prefix + quoted.join('\n') + '\n';
  }

  /**
   * 重发一条消息。
   *
   * 走中枢的 `sendPrompt`——**不是**复制到输入框让用户再点一次：
   * "重发"的语义就是立刻再发一遍（有真实协议面 `session/prompt`）。
   * 失败时如实说明（未连接/无会话），不假装已发出。
   */
  private resendMessage(item: TrajectoryItem): void {
    if (item.body.length === 0) {
      this.attachNotice = '这条消息没有可重发的正文。';
      return;
    }
    SessionHub.shared().sendPrompt(item.body).then((ok: boolean) => {
      this.attachNotice = ok ? '已重发。' : '重发失败：消息未发出（连接或会话不可用）。';
    }).catch((e: Object) => {
      this.attachNotice = '重发失败：' + (e as Error).message;
    });
  }

  private showsConversation(): boolean {
    // 判据在控制器里（`NavTab.SESSIONS` 是 `WORKSPACES` 的别名这事只该写在那一处）
    return showsConversation(this.navState());
  }

  /**
   * 当前该显示哪个浮层（**从既有状态派生，不另立状态**）。
   *
   * 【为什么不新增一个 `sheetKind` 字段】那会造成两个真值来源：字段说"credential"、
   * 而 `credentialRef` 已空——两者一旦不同步，就是"浮层里内容不对/关不掉"这类疑难 bug。
   * 这里只做**派生**：谁的状态在，就显示谁。顺序即优先级（同时满足时按此取第一个）。
   */
  private sheetKind(): string {
    // 详情仅在**整页**档位（单栏）走半模态；双栏改用侧边浅层面板（见 AppShell.buildDouble）
    if (this.detailOverlayOpen && this.detailPresentationNow() === DetailPresentation.OVERLAY) {
      return 'detail';
    }
    if (this.choosing !== undefined) {
      return 'choice';
    }
    if (this.credentialRef.length > 0) {
      return 'credential';
    }
    if (this.folderPickerOpen) {
      return 'folder';
    }
    if (this.textSettingKey.length > 0) {
      return 'text';
    }
    if (this.structSettingKey.length > 0) {
      return 'struct';
    }
    if (this.piAiMode.length > 0) {
      return 'piai';
    }
    return '';
  }

  /** 各类浮层的高度：内容长（详情/目录/整值编辑/pi-ai 表单）给 LARGE，短表单给 MEDIUM */
  private sheetHeight(): SheetSize {
    const kind: string = this.sheetKind();
    if (kind === 'detail' || kind === 'folder' || kind === 'struct' || kind === 'piai') {
      return SheetSize.LARGE;
    }
    return SheetSize.MEDIUM;
  }

  /**
   * 关闭当前浮层：**一处复位全部**。
   *
   * 复位与"谁在显示"分开写是有意的——原生关闭路径（下拉/遮罩/关闭按钮）只知道"关了"，
   * 不知道关的是哪一个；让宿主统一清干净，就不会出现"关掉后状态还留着、再也打不开"。
   */
  private closeSheet(): void {
    this.detailOverlayOpen = false;
    this.choosing = undefined;
    this.folderPicker.close();
    this.folderPickerOpen = false;
    this.credentialRef = '';
    this.credentialDraft = '';
    this.credentialNote = '';
    this.textSettingKey = '';
    this.textSettingDraft = '';
    this.structSettingKey = '';
    this.structSettingDraft = '';
    this.piAiMode = '';
    this.piAiKeyDraft = '';
    this.piAiFieldError = '';
    this.piAiBusy = false;
  }

  /** 浮层内容分派（宿主的另一半：谁在显示就渲染谁） */
  @Builder
  sheetContent() {
    if (this.sheetKind() === 'detail') {
      this.detailSheet()
    } else if (this.sheetKind() === 'choice') {
      ChoiceSheet({
        label: this.choosingLabel,
        settingKey: this.choosingKey,
        current: this.choosingCurrent,
        choices: this.choosing === undefined ? [] : this.choosing,
        onPick: (value: string) => {
          this.applyChoice(value);
        },
        onCancel: () => {
          this.choosing = undefined;
        }
      })
    } else if (this.sheetKind() === 'credential') {
      CredentialSheet({
        credentialRef: this.credentialRef,
        configured: this.credentialConfigured,
        draft: this.credentialDraft,
        note: this.credentialNote,
        noteOwned: sheetNoteVisible(this.sheetNoteOwner, 'credential'),
        busy: this.credentialBusy,
        onDraftChange: (v: string) => {
          this.credentialDraft = v;
        },
        onSubmit: () => {
          this.submitCredential();
        },
        onClear: () => {
          this.clearCredential();
        },
        onClose: () => {
          this.closeCredentialSheet();
        }
      })
    } else if (this.sheetKind() === 'folder') {
      FolderPicker({
        sandboxRoot: this.filesDirOf(),
        startDir: this.localWorkspaceDir,
        controller: this.folderPicker,
        onChoose: (path: string) => {
          this.folderUsePath(path);
        },
        onClose: () => {
          // 返回键要用"浮层是否开着"这一事实；关闭时把宿主自己那份标记也收掉
          this.folderPickerOpen = false;
        }
      })
    } else if (this.sheetKind() === 'text') {
      SettingTextSheet({
        item: this.textSettingItem,
        label: this.textSettingLabel,
        draft: this.textSettingDraft,
        note: this.credentialNote,
        noteOwned: sheetNoteVisible(this.sheetNoteOwner, 'text'),
        busy: this.textBusy,
        onDraftChange: (v: string) => {
          this.textSettingDraft = v;
        },
        onSubmit: () => {
          this.submitTextSetting();
        },
        onClose: () => {
          this.closeTextSettingSheet();
        }
      })
    } else if (this.sheetKind() === 'struct') {
      SettingStructSheet({
        item: this.structSettingItem,
        label: this.structSettingLabel,
        settingKey: this.structSettingKey,
        draft: this.structSettingDraft,
        note: this.credentialNote,
        noteOwned: sheetNoteVisible(this.sheetNoteOwner, 'struct'),
        busy: this.structBusy,
        onDraftChange: (v: string) => {
          this.structSettingDraft = v;
        },
        onRestore: () => {
          this.resetStructDraft();
        },
        onSubmit: () => {
          this.submitStructSetting();
        },
        onUnset: () => {
          this.unsetStructSetting();
        },
        onClose: () => {
          this.closeStructSettingSheet();
        }
      })
    } else if (this.sheetKind() === 'piai') {
      PiAiProviderSheet({
        mode: this.piAiMode,
        draft: this.piAiDraft,
        protocols: this.piAiProtocols,
        baseURLPlaceholder: baseURLPlaceholder(this.piAiDraft.api),
        keyDraft: this.piAiKeyDraft,
        keyRef: this.piAiKeyRef,
        keyConfigured: this.piAiKeyConfigured,
        fieldError: this.piAiFieldError,
        note: this.credentialNote,
        noteOwned: sheetNoteVisible(this.sheetNoteOwner, 'piai'),
        busy: this.piAiBusy,
        onRouteChange: (v: string) => {
          this.piAiDraft.route = v.trim();
          this.clearPiAiFieldError();
        },
        onDisplayNameChange: (v: string) => {
          this.piAiDraft.displayName = v;
        },
        onBaseURLChange: (v: string) => {
          this.piAiDraft.baseURL = v;
          this.clearPiAiFieldError();
        },
        onApiChange: (v: string) => {
          this.piAiDraft.api = v;
          this.clearPiAiFieldError();
        },
        onKeyChange: (v: string) => {
          this.piAiKeyDraft = v;
          this.clearPiAiFieldError();
        },
        onModelChange: (index: number, row: PiAiModelRow) => {
          if (index >= 0 && index < this.piAiDraft.models.length) {
            this.piAiDraft.models[index] = row;
            this.clearPiAiFieldError();
          }
        },
        onAddModel: () => {
          this.piAiDraft.models.push(emptyModelRow());
        },
        onRemoveModel: (index: number) => {
          // 守卫：官方要求 ≥1 个模型，删空会让表单永远不可提交
          if (this.piAiDraft.models.length > 1 && index >= 0 && index < this.piAiDraft.models.length) {
            this.piAiDraft.models.splice(index, 1);
          }
        },
        onSubmit: () => {
          this.submitPiAiSheet();
        },
        onDelete: () => {
          this.deletePiAiProvider();
        },
        onClose: () => {
          this.closePiAiSheet();
        }
      })
    }
  }

  /**
   * 详情半模态内容（P1.5：手机上详情不再整页替换会话）。
   *
   * 复用既有的 `DetailPane`（它本就有 `onLineTap` 的"复制该行"行为），
   * 所以这不是新功能，而是把**同一份内容换一种更合适的呈现**。
   */
  @Builder
  detailSheet() {
    // Sheet 呈现同样归 RightbarShell：关闭由原生 Sheet 提供（拖拽条/点击外部）
    RightbarShell({
      presentation: DetailPresentation.OVERLAY,
      widthVp: 0,
      f: this.buildRightbarFacade(),
      sections: this.detailSections
    })
  }

  /** AppFrame 轨道所需能力的门面（**每次渲染重建**：值型快照、写型 setter、方法型闭包） */
  private buildShellFacade(): AppShellFacade {
    const facade: AppShellFacade = {
    activePanel: () => this.activePanel(),
    appName: APP_NAME,    // 品牌名是宿主给的事实（同 brand 入参）
    // 侧栏 PANEL 呈现里要挂工作区→会话树（P1）：与主区那份**同源**（同一个门面构建器）
    browser: this.buildBrowserFacade(),
    selectedSidebarPanel: sidebarPanelOfMainPanel(this.nav.selectedMainPanel),
    // 侧栏展开 / 收起（P2-15）：生效值由"形态默认 + 用户偏好"派生（P5-2），视图只读结论
    sidebarExpanded: sidebarExpandedForMode(this.mode, this.sidebarStored),
    // 侧栏**轨道**宽度（P5-2）：跟随实际呈现（panel 240 / rail 56 / 浮层 0），
    // 而不是形态默认——否则"收起侧栏腾出宽度"只改了呈现、没改几何
    sidebarTrackWidthVp: (): number => sidebarTrackWidthOf(this.mode, this.sidebarStored),
    onToggleSidebarExpanded: () => this.toggleSidebarExpanded(),
    onSelectSidebarPanel: (panelId: string) => this.selectSidebarPanel(panelId),
    onNewSession: () => this.newSession(),
    panelLabel: this.selectedPanelLabel(),
    rightbar: this.buildRightbarFacade(),
    mobileDrawerOpen: this.nav.mobileDrawer === DrawerState.OPEN,
    onOpenDrawer: () => this.setDrawerOpen(true),
    onCloseDrawer: () => this.setDrawerOpen(false),
    beginDetailDrag: () => this.beginDetailDrag(),
    closeDetail: () => this.closeDetail(),
    detailOpen: this.detailOpen,
    detailOverlayOpen: this.detailOverlayOpen,
    setDetailOverlayOpen: (value: boolean) => {
      this.detailOverlayOpen = value;
    },
    detailPresentationNow: () => this.detailPresentationNow(),
    detailSections: this.detailSections,
    detailWidthVp: () => this.detailWidthVp(),
    endDetailDrag: () => this.endDetailDrag(),
    gripHitWidth: () => this.gripHitWidth(),
    mainShell: this.buildMainFacade(),
    mode: this.mode,
    openDiagnostics: () => this.openDiagnostics(),
    pendingBadge: this.pendingBadge,
    selectedSessionTitle: this.selectedSessionTitle,
    showsConversation: () => this.showsConversation(),
    sidePanelWidthVp: () => this.sidePanelWidthVp(),
    stackPage: this.stackPage,
    setStackPage: (value: StackPage) => {
      this.stackPage = value;
    },
    updateDetailDrag: (deltaXVp: number) => this.updateDetailDrag(deltaXVp),
    };
    return facade;
  }

  /**
   * 页面根 = **浮层门户**（AppFrame 最外层）；三形态轨道布局不在这里 —— 归 `AppShell`。
   *
   * 【为什么 `bindSheet` 挂在这个根节点上】它是**组件属性**、同一节点只能绑一个 ⇒ 全应用只有一个
   * 宿主：单一分派（`sheetKind()`）在结构上保证不可能同时开出两个浮层，单一复位（`closeSheet()`）
   * 保证原生关闭路径（下拉 / 遮罩 / 关闭按钮）之后状态不留残（`isShow` 是**单向**的，不复位就再也打不开）。
   *
   * 【为什么从单栏根节点提上来】原先它挂在 `buildSingle` 的根 `Column` 上 ⇒ **双栏 / 三栏下
   * 模型选择、凭据、目录、整值编辑这些浮层根本打不开**（不是没做，是够不着 —— 宿主不在树的那个位置）。
   * 门户挂在页面根就与形态无关了，这正是官方 Web「portal 挂在 `App` 根、不属于任何 pane」的语义。
   */
  build() {
    // 轨道布局归 AppFrame：`AppShell` 拥有「窗口宽度 → 几条轨道」这件事（见 docs/ia-parity-plan.md）。
    Stack() {
      AppShell({ f: this.buildShellFacade() })
    }
    .width('100%')
    .height('100%')
    /**
     * 事件证据采集（输入模态的兜底来源，见 `notePointerEvidence`）。
     *
     * 悬停：只有鼠标/触控笔会 hover（触控不会）⇒ 一次悬停即证明有指针。
     * 按键：软键盘不走按键事件 ⇒ 收到按键即证明有物理键盘。
     * 两者都**不消费**事件（不调用 stopPropagation），下面那 8 个快捷键不受影响。
     */
    .onHover((isHover: boolean) => {
      if (isHover) {
        this.notePointerEvidence();
      }
    })
    .onKeyEvent((event: KeyEvent) => {
      if (event.type === KeyType.Down) {
        this.noteKeyboardEvidence();
      }
    })
    /**
     * 2in1 / 平板（外接键盘）快捷键：**声明式**那 8 个规格。
     *
     * 【为什么在这里声明而不是在各自的按钮上】这些动作是**全局**的（新建、切页签、
     * 重连…），挂在某个按钮上会随该按钮的可见性一起失效（例如"新建会话"按钮只在
     * 会话页存在，于是别的页面上 Ctrl+N 不生效）。挂在根容器上语义才是对的。
     *
     * 【为什么只有 8 个】另外 5 个（Enter / Esc / Alt+↑↓ / F5）`keyboardShortcut`
     * 表达不了（见 `ShortcutKeys.ets` 的说明），走下面的 `onKeyEvent`。
     *
     * 【为什么不做形态门控】D3 §5.1 那一节的适用对象是"有外接键盘"的设备，
     * 但**绑定本身在无键盘设备上无害**（手机没有 Ctrl 键，按不出来）。
     * 真正需要按形态过滤的是"把它展示给用户看"（帮助浮层/设置页），
     * 那部分用 `shortcutsForDesktop()`——目前尚无该浮层，故不在此假装。
     */
    .keyboardShortcut('n', [ModifierKey.CTRL], () => {
      this.runShortcut('new-session');
    })
    .keyboardShortcut('k', [ModifierKey.CTRL], () => {
      this.runShortcut('command-palette');
    })
    .keyboardShortcut('f', [ModifierKey.CTRL], () => {
      this.runShortcut('search-in-session');
    })
    .keyboardShortcut('b', [ModifierKey.CTRL], () => {
      this.runShortcut('toggle-nav');
    })
    .keyboardShortcut('j', [ModifierKey.CTRL], () => {
      this.runShortcut('toggle-detail');
    })
    .keyboardShortcut('p', [ModifierKey.CTRL, ModifierKey.SHIFT], () => {
      this.runShortcut('pending-inbox');
    })
    .keyboardShortcut('c', [ModifierKey.CTRL, ModifierKey.SHIFT], () => {
      this.runShortcut('copy-code-block');
    })
    .keyboardShortcut(',', [ModifierKey.CTRL], () => {
      this.runShortcut('open-settings');
    })
    .onKeyEvent((event: KeyEvent) => {
      // 只取「按下」那一次：抬起时再分发会执行两遍（`sendDraft` 会被调用两次）
      if (event.type !== KeyType.Down) {
        return;
      }
      const shift: boolean = event.getModifierKeyState !== undefined
        && event.getModifierKeyState(['shift']);
      const alt: boolean = event.getModifierKeyState !== undefined
        && event.getModifierKeyState(['alt']);
      const hit: ShortcutHit = hitOfKeyEvent(event.keyCode, shift, alt);
      this.dispatchKeyHit(hit);
    })
    .bindSheet(this.sheetKind().length > 0, this.sheetContent(),
      harmonySheetOptions(() => {
        this.closeSheet();
      }, this.sheetHeight()))
  }

  /**
   * 按键判定 → 动作。
   *
   * 【为什么单独抽出来】声明式绑定与 `onKeyEvent` 两条路都要落到同一处分发；
   * 分散写会让"某个 id 忘了接"成为一件没有提示的事（而 `ShortcutKeys` 只能保证
   * id 来自表，保证不了"每个 id 都有人处理"）。
   */
  private runShortcut(id: string): void {
    if (id === 'new-session') {
      SessionHub.shared().createSession();
      return;
    }
    if (id === 'toggle-detail') {
      // 呈现方式随档位：三栏翻右栏、单栏/双栏翻浮层。
      // 原先这里只翻 `detailOpen` ⇒ 手机与平板上按了没有任何反应（死开关）。
      this.toggleDetail();
      return;
    }
    if (id === 'pending-inbox') {
      this.selectTab(NavTab.PENDING);
      return;
    }
    if (id === 'open-settings') {
      // 走导航状态转移（`openSettings` 会同时校验面板可用性）；空分区 = 保持当前分区
      this.nav = openSettings(this.nav, '', this.panelRegistry);
      return;
    }
    if (id === 'reconnect') {
      SessionHub.shared().reconnect();
      return;
    }
    if (id === 'stop-turn') {
      this.escapePressed();
      return;
    }
    if (id === 'send-message') {
      this.sendDraft();
      return;
    }
    if (id === 'search-in-session') {
      // D3 §5.1 的 Ctrl/Cmd+F：打开会话内搜索条（仅会话页有意义）
      if (this.showsConversation()) {
        this.searchOpen = true;
      } else {
        this.attachNotice = '会话内搜索需要先打开一个会话。';
      }
      return;
    }
    if (id === 'command-palette') {
      this.paletteOpen = true;
      SessionHub.shared().refreshCommands();
      // E243：面板同时读目标（官方 ui-goal 的目标栏数据源；未选会话/未连接时中枢会如实说明）
      SessionHub.shared().refreshGoal();
      return;
    }
    if (id === 'toggle-nav') {
      this.attachNotice = '导航栏的显隐当前由窗口宽度自动决定（让步链），手动折叠尚未实现。';
      return;
    }
    if (id === 'copy-code-block') {
      this.attachNotice = '「复制选中代码块」需要消息内的选中状态，尚未实现。';
      return;
    }
    if (id === 'prev-next-message') {
      this.attachNotice = '「上一条 / 下一条消息」跳转尚未实现。';
      return;
    }
  }

  /** `Enter`（无 Shift）与 `Shift+Enter` 的分流 */
  private dispatchKeyHit(hit: ShortcutHit): void {
    if (hit.id.length === 0) {
      return;
    }
    if (hit.id === 'send-message' && hit.delta < 0) {
      // Shift+Enter = 换行：交给输入框自己处理，页面**不**拦截
      return;
    }
    this.runShortcut(hit.id);
  }

  /**
   * `Esc`：先关浮层，再停轮次（D3 §5.1「停止当前轮次（弹二次确认）/ 关闭弹层」）。
   *
   * 顺序不能反：有浮层时按 Esc 的意图是"关掉它"，而不是把正在跑的轮次停掉——
   * 后者是有副作用的破坏性动作，绝不能被"我只是想关个弹窗"触发。
   */
  private escapePressed(): void {
    if (this.folderPickerOpen) {
      // 与返回键同一条复位：选择器的真值在组件内，故走控制器（E354）
      this.folderPicker.close();
      this.folderPickerOpen = false;
      return;
    }
    if (this.choosing !== undefined) {
      this.choosing = undefined;
      return;
    }
    if (this.credentialRef.length > 0) {
      this.credentialRef = '';
      return;
    }
    if (this.textSettingKey.length > 0) {
      this.textSettingKey = '';
      return;
    }
    if (this.structSettingKey.length > 0) {
      this.structSettingKey = '';
      return;
    }
    if (this.running && this.hubConnected) {
      SessionHub.shared().cancelTurn();
    }
    this.running = false;
  }

  // ───────────────────── 枚举选择浮层 ─────────────────────

  /**
   * 写入一个 Host 设置项并把结果如实告诉用户。
   *
   * 【为什么必须把结果回显，而不是乐观更新界面】
   *   乐观更新在这里特别危险：设置项的值会影响**后续所有请求**（模型、超时、重试策略）。
   *   界面显示「已改」而 Host 没改，用户会基于一个假状态继续工作，
   *   而且下次打开设置页才发现值回去了——那时已经很难判断是哪一步出的问题。
   *   所以这里一律等 Host 答复，并按结果给出**可执行**的一句话。
   */
  private async writeSetting(key: string, value: Object, label: string): Promise<void> {
    this.noteSettingWrite(key, `正在写入 ${key}…`);
    const hub: SessionHub = SessionHub.shared();
    const result: SettingsWriteResult = await hub.writeSetting(key, value);
    this.noteSettingWrite(key, result.message);
    // 【不要在这里再套一层 applyHubSnapshot(hub.snapshot())】
    //   中枢在写成功/冲突/被拒时都已经 `notify()` 过，订阅回调会带着
    //   **已与本地偏好合并**的视图刷新界面。手动再套一次快照不但多余，
    //   还会在「快照比 notify 更旧」时把刚刷新的值盖回旧值——
    //   那正是「Host 说写入成功、界面却没变」的成因（实测踩到过）。
    // 【为什么失败不再顺手写 hubError】那条横幅在会话页顶部，而"这次设置写入被拒"
    //   对没在看设置页的人是一句无来由的横幅（E347）。回执已经挂在设置页里，
    //   并且 `applyHubSnapshot` 收到断连/错误时会自己点亮横幅。
    if (result.outcome !== SettingsWriteOutcome.OK) {
      hilog.info(DOMAIN, TAG, 'DSHM-SET 写入 %{public}s 未成功：%{public}s', key, result.outcome);
    }
  }

  /**
   * 记一条**带归属域**的设置写入回执（E347）。
   *
   * 【为什么要有这个包装】写入回执是一个全局字符串，而读取它的地方只有设置页顶部那条回显。
   * 不记域就会出现"在通用改了外观、切到模型页，那条回执还挂在模型页上方"——
   * 看起来像模型页刚写出来的结果（界面在撒谎）。域由 key 的命名空间判定
   * （`settingsDomainOfNs`，纯函数、有 fixture），判不出来的**不隐藏**。
   */
  private noteSettingWrite(key: string, message: string): void {
    // 本机偏好（`local.*`）是**设置项**，但它的 key 不在 Host 命名空间里
    // ⇒ 命名空间判不出域，只能显式指到「通用」（它就长在那一段里）。
    if (key === LOCAL_THEME_KEY) {
      this.settingsWriteDomain = 'settings.general';
      this.settingWriteNote = message;
      return;
    }
    const parts: SettingsKeyParts | undefined = splitSettingKey(key);
    this.settingsWriteDomain = parts === undefined ? '' : settingsDomainOfNs(parts.ns);
    this.settingWriteNote = message;
  }

  private applyChoice(value: string): void {
    const key: string = this.choosingKey;
    this.choosing = undefined;
    // 本机偏好走端侧持久化 + 立即生效；Host 项走 `settings/mutate`。
    // 分流判据是"这一项在不在 Host 分组里"——与本机偏好分组的存在无关，
    // 因为 Host 分组在未连接时本来就是空的。
    if (this.settingItemOf(key) === undefined) {
      this.writeLocalChoice(key, value);
      return;
    }
    this.writeSetting(key, value as Object, this.choosingLabel);
  }

  /** 在本机偏好分组里找一项 */
  private localItemOf(key: string): SettingItem | undefined {
    for (let i = 0; i < this.localSettings.length; i++) {
      const items: SettingItem[] = this.localSettings[i].items;
      for (let j = 0; j < items.length; j++) {
        if (items[j].key === key) {
          return items[j];
        }
      }
    }
    return undefined;
  }

  /** 写入本机偏好（目前只有主题模式；新增项时在这里加分支并说明它的生效路径） */
  private writeLocalChoice(key: string, value: string): void {
    if (key === LOCAL_THEME_KEY) {
      this.writeLocalTheme(value);
      return;
    }
    // 防御：本机偏好表里出现了没有写入路径的项。如实说明，而不是静默丢弃这次点击。
    this.noteSettingWrite(key, `本机偏好「${key}」尚未实现写入路径（选项已选中，但没有生效）。`);
  }

  // ───────────────────── 选择文件夹（工作区，E100）─────────────────────

  /** 浏览浮层是否打开 */
  /** 当前浏览目录（绝对路径） */
  /** 当前目录下的子目录名（已排序） */
  /** 浏览提示/错误（空串不显示） */

  /** 文件夹选择器的控制器（宿主持句柄、组件注册实现；与 TurnViewController 同源） */
  private folderPicker: FolderPickerController = new FolderPickerController();
  /** 选择器是否开着（宿主侧的镜像：返回键与 escape 要用；真值仍在组件内） */
  @State folderPickerOpen: boolean = false;

  private filesDirOf(): string {
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      return ctx.filesDir;
    } catch (e) {
      return '';
    }
  }

  /**
   * 打开「选择文件夹」。
   *
   * 【端侧的现实，先说清楚】应用只申请了 INTERNET / GET_NETWORK_INFO / KEEP_BACKGROUND_RUNNING
   * 三项权限，**没有公共存储权限**，所以"选本地文件夹"的范围是**沙箱内可读写目录**——
   * 入口脚本已准备好 `<filesDir>/workspace`，用户可以进去、建子目录、挑一个作为工作区。
   * 这不是降级：端侧核心本来也只能在沙箱里读写；把范围写在界面上，比给一个点了没反应的
   * 「添加」强（原实现正是那样一个死入口）。
   */
  private openFolderPicker(): void {
    /*
     * 【先试系统文件夹选择器（E102）】2in1/平板支持"选真实文件夹"（SDK：
     * `DocumentSelectMode` 仅 2in1），那是"选择本地项目"的正路；手机不支持，
     * 此时**如实说明原因**再回退到沙箱浏览（而不是让入口点了没反应）。
     */
    const ctx = getContext(this) as common.UIAbilityContext;
    pickFolder(ctx).then((picked: PickedFolder) => {
      if (picked.outcome === PickOutcome.PICKED && picked.path.length > 0) {
        this.folderUsePath(picked.path);
        return;
      }
      if (picked.outcome === PickOutcome.CANCELLED) {
        return; // 用户主动取消：不打扰
      }
      // 失败（手机上的常态）：回退到沙箱浏览，并把原因写在浮层顶部
      this.folderPicker.open(picked.reason);
      this.folderPickerOpen = true;
    }).catch((e: Object) => {
      const err = e as Error;
      this.folderPicker.open(`文件夹选择器异常：${err.message}`);
      this.folderPickerOpen = true;
    });
  }

  /** 选定一个真实路径作为工作区（注册 + 就地开会话） */
  private folderUsePath(path: string): void {
    const hub: SessionHub = SessionHub.shared();
    hub.setDefaultWorkspace(path);
    this.attachNotice = `正在把 ${path} 设为工作区…`;
    hilog.info(DOMAIN, TAG, 'DSHM-WS 选择工作区：%{public}s', path);
    hub.ensureWorkspace(path).then((note: string) => {
      this.attachNotice = note;
      hilog.info(DOMAIN, TAG, 'DSHM-WS 注册结果：%{public}s', note);
      return hub.createSession();
    }).then((sid: string | undefined) => {
      if (sid !== undefined) {
        this.attachNotice = `已在这里开始工作：${path}`;
        this.selectTab(NavTab.SESSIONS);
      }
    }).catch((e: Object) => {
      const err = e as Error;
      this.attachNotice = `选择文件夹失败：${err.message}`;
      hilog.warn(DOMAIN, TAG, 'DSHM-WS 失败：%{public}s', err.message);
    });
  }

  // ───────────────────── 凭据写入浮层 ─────────────────────

  private closeCredentialSheet(): void {
    this.credentialRef = '';
    // 清掉草稿：明文不该因为「关掉了浮层」而继续留在状态里
    this.credentialDraft = '';
    this.credentialNote = '';
    this.sheetNoteOwner = '';
    this.credentialBusy = false;
  }

  /** 当前编辑的凭据是否已配置（决定是否显示「清除」） */
  private credentialConfigured: boolean = false;

  private openCredentialSheet(ref: string): void {
    // 认领这条回执（并清掉上一个浮层留下的）：否则失败文案会跟到别的浮层里（E353）
    this.sheetNoteOwner = 'credential';
    this.credentialNote = '';
    for (let i = 0; i < this.credentials.length; i++) {
      if (this.credentials[i].ref === ref) {
        this.credentialConfigured = this.credentials[i].configured;
      }
    }
    this.credentialDraft = '';
    this.credentialNote = '';
    this.credentialBusy = false;
    this.credentialRef = ref;
  }

  private async submitCredential(): Promise<void> {
    const ref: string = this.credentialRef;
    const value: string = this.credentialDraft;
    // 先清草稿再发请求：请求发出后明文就不再需要留在内存里，
    // 也避免用户重复点击导致重复写入。
    this.credentialDraft = '';
    this.credentialBusy = true;
    this.credentialNote = `正在写入 ${ref}…`;
    const hub: SessionHub = SessionHub.shared();
    const result: CredentialWriteResult = await hub.setCredential(ref, value);
    this.credentialBusy = false;
    if (result.ok) {
      // 【成功时必须关掉浮层】`HubSnapshot` 里没有凭据写入的结果字段，
      // 而浮层盖住了凭据列表——用户看不到状态已经变成「已配置」，
      // 会以为写入没生效（实测踩到：Host 已经 configured=true，
      // 而界面还停在浮层上）。
      // 关掉浮层让列表回到视野，成功信息写到列表上方那条回显里。
      this.settingWriteNote = result.message;
      this.closeCredentialSheet();
      this.applyHubSnapshot(hub.snapshot());
      return;
    }
    // 失败留在浮层里：用户需要就地改值重试，而不是被赶回列表
    this.credentialNote = result.message;
  }

  private async clearCredential(): Promise<void> {
    const ref: string = this.credentialRef;
    this.credentialBusy = true;
    this.credentialNote = `正在清除 ${ref}…`;
    const hub: SessionHub = SessionHub.shared();
    const result: CredentialWriteResult = await hub.unsetCredential(ref);
    this.credentialBusy = false;
    if (result.ok) {
      this.settingWriteNote = result.message;
      this.closeCredentialSheet();
      this.applyHubSnapshot(hub.snapshot());
      return;
    }
    this.credentialNote = result.message;
  }

  // ───────────────────── 文本 / 数字设置编辑浮层 ─────────────────────

  private closeTextSettingSheet(): void {
    this.textSettingKey = '';
    this.textSettingDraft = '';
    this.textSettingItem = undefined;
    this.credentialNote = '';
    this.sheetNoteOwner = '';
  }

  private openTextSettingSheet(item: SettingItem): void {
    this.textSettingKey = item.key;
    this.textSettingLabel = item.label;
    // 预填当前值：改一个长数字串时，让用户从现值改起比从空开始可靠得多
    this.textSettingDraft = item.textValue;
    this.textSettingItem = item;
    // 认领回执并清掉上一条（E353）
    this.sheetNoteOwner = 'text';
    this.credentialNote = '';
  }

  private async submitTextSetting(): Promise<void> {
    const item: SettingItem | undefined = this.textSettingItem;
    if (item === undefined) {
      return;
    }
    // 客户端先校验：Host 的拒绝文案是给开发者看的（「不符合 schema」），
    // 而用户需要的是「不能大于 17」这类具体原因（见 parseSettingInput 的说明）。
    const parsed: SettingInputResult = parseSettingInput(item, this.textSettingDraft);
    if (!parsed.ok || parsed.value === undefined) {
      this.credentialNote = parsed.message;
      return;
    }
    const key: string = item.key;
    this.textBusy = true;
    this.credentialNote = `正在写入 ${key}…`;
    const hub: SessionHub = SessionHub.shared();
    const result: SettingsWriteResult = await hub.writeSetting(key, parsed.value);
    this.textBusy = false;
    if (result.outcome === SettingsWriteOutcome.OK) {
      this.settingWriteNote = result.message;
      this.closeTextSettingSheet();
      return;
    }
    // 冲突/被拒/失败都留在浮层里：用户需要就地看到原因并改值重试
    this.credentialNote = result.message;
  }

  // ───────────────────── pi-ai 路由（自定义模型 API）浮层 ─────────────────────

  /** 清字段级错误（用户一改输入就撤掉旧结论，避免"改了还挂着旧红字"） */
  private clearPiAiFieldError(): void {
    if (this.piAiFieldError.length > 0) {
      this.piAiFieldError = '';
    }
  }

  /** 该路由的凭据引用（有 `apiKeyEnv` 用它，否则按官方规则派生） */
  private piAiKeyRefOf(route: string, apiKeyEnv: string): string {
    return apiKeyEnv.length > 0 ? apiKeyEnv : deriveKeyRef(route);
  }

  /**
   * 打开 pi-ai 浮层。
   *
   * @param mode `PiAiSheetMode.EDIT`（编辑已有路由）/ `PiAiSheetMode.CREATE`（新建）
   * @param route 编辑时的路由 id；新建时忽略
   *
   * 【编辑模式为什么要把原值留一份】提交时用 `changedScalarFields` 比对，
   * 只写真正变了的字段——既省往返，也避免把界面上的旧值覆盖回去（若别处同时改过）。
   */
  private openPiAiSheet(mode: string, route: string): void {
    const hub: SessionHub = SessionHub.shared();
    this.sheetNoteOwner = 'piai';
    this.credentialNote = '';
    this.piAiFieldError = '';
    this.piAiBusy = false;
    this.piAiKeyDraft = '';
    this.piAiMode = mode;
    if (mode === PiAiSheetMode.EDIT) {
      let found: PiAiProviderView | undefined = undefined;
      const list: PiAiProviderView[] = hub.snapshot().piAiProviders;
      for (let i = 0; i < list.length; i++) {
        if (list[i].route === route) {
          found = list[i];
        }
      }
      if (found === undefined) {
        // 路由在两次刷新之间消失了：如实说明并**不打开**浮层（打开一个空表单更糟）
        this.piAiMode = '';
        this.settingWriteNote = `提供方「${route}」已不在 Host 的设置里（可能刚被删除）。已刷新，请重试。`;
        return;
      }
      this.piAiDraft = found;
      this.piAiOriginal = found;
      this.piAiKeyRef = this.piAiKeyRefOf(found.route, found.apiKeyEnv);
    } else {
      // 新建：协议预选 schema 的第一个候选（官方 `protocols[0]`）；
      // 读不到候选时留空，由浮层显示"Host 没有报告可声明的协议"并禁用提交
      const protocols: string[] = hub.snapshot().piAiProtocols;
      this.piAiDraft = emptyProviderView(protocols.length > 0 ? protocols[0] : '');
      this.piAiOriginal = undefined;
      this.piAiKeyRef = '';
    }
    // 密钥状态：界面要显示 Host 的**实际**状态，而不是"我们以为写过"
    this.piAiKeyConfigured = this.credentialConfiguredOf(this.piAiKeyRef);
  }

  /** 某个引用当前是否已配置（读中枢快照；找不到就是未配置，不猜） */
  private credentialConfiguredOf(ref: string): boolean {
    if (ref.length === 0) {
      return false;
    }
    const list: CredentialItem[] = SessionHub.shared().snapshot().credentials;
    for (let i = 0; i < list.length; i++) {
      if (list[i].ref === ref) {
        return list[i].configured;
      }
    }
    return false;
  }

  private closePiAiSheet(): void {
    this.piAiMode = '';
    this.piAiKeyDraft = '';
    this.piAiFieldError = '';
    this.piAiBusy = false;
    this.piAiOriginal = undefined;
    this.credentialNote = '';
    this.sheetNoteOwner = '';
  }

  /**
   * 提交（新建或保存）。校验顺序与官方一致：**先全部校验通过，再写**。
   *
   * 【为什么先写 profile 再写密钥】官方 `createOnce` 就是这个顺序，并且用一个
   * `committed` 标志记住"profile 已落盘"——这样密钥写失败后的重试路径**只重试密钥**，
   * 不会重复写 profile（重复写会再推一次 revision，并可能覆盖别处的改动）。
   */
  private async submitPiAiSheet(): Promise<void> {
    const creating: boolean = this.piAiMode === PiAiSheetMode.CREATE;
    const hub: SessionHub = SessionHub.shared();

    // ① 路由 id（新建才校验占用；编辑时 id 不可改）
    if (creating) {
      const taken: string[] = [];
      const list: PiAiProviderView[] = hub.snapshot().piAiProviders;
      for (let i = 0; i < list.length; i++) {
        taken.push(list[i].route);
      }
      const routeCheck: PiAiFieldCheck = checkRoute(this.piAiDraft.route, taken);
      if (!routeCheck.ok) {
        this.piAiFieldError = routeCheck.message;
        return;
      }
    }
    // ② 端点
    const urlCheck: PiAiFieldCheck = checkBaseURL(this.piAiDraft.baseURL);
    if (!urlCheck.ok) {
      this.piAiFieldError = urlCheck.message;
      return;
    }
    // ③ 协议（必须来自 Host 报告的候选）
    const apiCheck: PiAiFieldCheck = checkProtocol(this.piAiDraft.api, hub.snapshot().piAiProtocols);
    if (!apiCheck.ok) {
      this.piAiFieldError = apiCheck.message;
      return;
    }
    // ④ 模型目录
    const modelCheck: PiAiFieldCheck = checkModels(this.piAiDraft.models);
    if (!modelCheck.ok) {
      this.piAiFieldError = modelCheck.message;
      return;
    }
    // ⑤ 密钥草稿（空 = 保留原密钥，不是失败）
    const keyCheck: PiAiFieldCheck = checkApiKeyDraft(this.piAiKeyDraft);
    if (!keyCheck.ok) {
      this.piAiFieldError = keyCheck.message;
      return;
    }

    const route: string = this.piAiDraft.route.trim();
    const storesKey: boolean = this.piAiKeyDraft.trim().length > 0;
    const keyRef: string = creating ? deriveKeyRef(route) : this.piAiKeyRef;

    this.piAiBusy = true;
    this.credentialNote = creating ? '正在添加提供方…' : '正在保存…';

    // ⑥ 写 profile
    let writeOk = false;
    if (creating) {
      const profile: Record<string, Object> = buildRouteProfile(this.piAiDraft, storesKey, keyRef);
      const res: SettingsWriteResult = await hub.writeSettingPath(
        PIAI_SETTINGS_NS, piAiRoutePath(route), profile as Object);
      if (res.outcome === SettingsWriteOutcome.OK) {
        writeOk = true;
      } else {
        this.piAiBusy = false;
        this.credentialNote = res.message;
        return;
      }
    } else {
      // 编辑：只写**真的变了**的字段（省往返，也不会把界面旧值覆盖回去）
      const before: PiAiProviderView | undefined = this.piAiOriginal;
      if (before === undefined) {
        this.piAiBusy = false;
        this.credentialNote = '原始值已丢失，已放弃本次保存（请重新打开）。';
        return;
      }
      const changed: string[] = changedScalarFields(before, this.piAiDraft);
      for (let i = 0; i < changed.length; i++) {
        const res: SettingsWriteResult = await hub.writeSettingPath(PIAI_SETTINGS_NS,
          piAiFieldPath(route, changed[i]), scalarFieldValue(this.piAiDraft, changed[i]));
        if (res.outcome !== SettingsWriteOutcome.OK) {
          this.piAiBusy = false;
          this.credentialNote = res.message;
          return;
        }
      }
      // 模型目录：**整值写**（数组元素无法按路径寻址，见 PiAiProviders 的实测表）
      if (modelsDiffer(before.models, this.piAiDraft.models)) {
        const res: SettingsWriteResult = await hub.writeSettingPath(PIAI_SETTINGS_NS,
          piAiModelsPath(route), modelsPayload(this.piAiDraft.models) as Object);
        if (res.outcome !== SettingsWriteOutcome.OK) {
          this.piAiBusy = false;
          this.credentialNote = res.message;
          return;
        }
      }
      writeOk = true;
    }

    if (!writeOk) {
      this.piAiBusy = false;
      this.credentialNote = '写入未生效。';
      return;
    }

    // ⑦ 写密钥（只写不读：明文不留在本机任何状态里）
    if (storesKey) {
      const stored: CredentialWriteResult = await hub.setCredential(keyRef, this.piAiKeyDraft.trim());
      if (!stored.ok) {
        // profile 已落盘 ⇒ **留在浮层**，让人只重试密钥（与官方 committed 同语义）
        this.piAiBusy = false;
        this.credentialNote = `提供方已保存，但密钥没有写入：${stored.message}`;
        this.piAiKeyConfigured = this.credentialConfiguredOf(keyRef);
        return;
      }
    }

    this.piAiBusy = false;
    this.settingWriteNote = creating
      ? `已添加提供方「${route}」。${storesKey ? '密钥已写入。' : '尚未配置密钥。'}`
      : `已保存提供方「${route}」。${storesKey ? '密钥已写入。' : ''}`;
    this.closePiAiSheet();
  }

  /**
   * 删除一个 pi-ai 路由（`unset ['providers', route]`）。
   *
   * 【破坏性，且要如实说清代价】删除会去掉这条路由的端点、协议与模型目录，
   * 依赖它的对话/默认模型选择会失去这个提供方。所以：入口单独一行、文案写"删除"，
   * 并**在回执里说明密钥没有一并删除**（密钥是独立引用，可能被别处使用）。
   */
  private async deletePiAiProvider(): Promise<void> {
    const route: string = this.piAiDraft.route.trim();
    if (route.length === 0) {
      return;
    }
    const hub: SessionHub = SessionHub.shared();
    this.piAiBusy = true;
    this.credentialNote = `正在删除提供方「${route}」…`;
    const res: SettingsWriteResult = await hub.unsetSettingPath(PIAI_SETTINGS_NS, piAiRoutePath(route));
    this.piAiBusy = false;
    if (res.outcome !== SettingsWriteOutcome.OK) {
      this.credentialNote = res.message;
      return;
    }
    const keyRef: string = this.piAiKeyRef;
    this.settingWriteNote = `已删除提供方「${route}」。`
      + (keyRef.length > 0 ? `它的凭据引用 ${keyRef} 仍保留（可能被别处使用），可在「凭据」里单独清除。` : '');
    this.closePiAiSheet();
  }

  // ───────────────────── 结构化值（数组 / 对象）整值编辑浮层 ─────────────────────

  /** 把草稿恢复为进入编辑器时的值（整值编辑的安全网） */
  private resetStructDraft(): void {
    const item: SettingItem | undefined = this.structSettingItem;
    if (item === undefined) {
      return;
    }
    this.structSettingDraft = prettyJson(item.rawJson);
    this.credentialNote = '已恢复为 Host 上的当前值（尚未写回）。';
  }

  private closeStructSettingSheet(): void {
    this.structSettingKey = '';
    this.structSettingDraft = '';
    this.structSettingItem = undefined;
    this.credentialNote = '';
    this.credentialBusy = false;
  }

  /** 结构设置写入进行中（**本浮层自己的**忙标志；此前借用了凭据浮层的，见 E353） */
  @State structBusy: boolean = false;
  /** 文本设置写入进行中（同上：本浮层自己的） */
  @State textBusy: boolean = false;

  private openStructSettingSheet(item: SettingItem): void {
    this.structSettingKey = item.key;
    this.structSettingLabel = item.label;
    this.structSettingDraft = prettyJson(item.rawJson);
    this.structSettingItem = item;
    // 认领回执并清掉上一条（E353）
    this.sheetNoteOwner = 'struct';
    this.credentialNote = '';
    this.structBusy = false;
  }

  private async submitStructSetting(): Promise<void> {
    const item: SettingItem | undefined = this.structSettingItem;
    if (item === undefined) {
      return;
    }
    const parsed: SettingInputResult = parseStructInput(item, this.structSettingDraft);
    if (!parsed.ok || parsed.value === undefined) {
      this.credentialNote = parsed.message;
      return;
    }
    const key: string = item.key;
    this.structBusy = true;
    this.credentialNote = `正在写入 ${key}…`;
    const hub: SessionHub = SessionHub.shared();
    // 整值写回：`parsed.value` 已经是完整的新值（见 SettingKind.STRUCT 的说明）
    const result: SettingsWriteResult = await hub.writeSetting(key, parsed.value);
    this.structBusy = false;
    if (result.outcome === SettingsWriteOutcome.OK) {
      this.settingWriteNote = result.message;
      this.closeStructSettingSheet();
      return;
    }
    this.credentialNote = result.message;
  }

  /**
   * 「恢复默认」：移除该项在 Host 用户层的取值。
   *
   * 与「写入」分开是刻意的：`unset` 是**破坏性**的（用户层的值会消失，
   * 值回落到 schema 默认，可能与用户当前看到的不同），
   * 不该和「保存」长得一样、也不该顺手就点到。
   */
  private async unsetStructSetting(): Promise<void> {
    const item: SettingItem | undefined = this.structSettingItem;
    if (item === undefined) {
      return;
    }
    const key: string = item.key;
    this.credentialBusy = true;
    this.credentialNote = `正在恢复 ${key} 的默认值…`;
    const hub: SessionHub = SessionHub.shared();
    const result: SettingsWriteResult = await hub.unsetSetting(key);
    this.credentialBusy = false;
    if (result.outcome === SettingsWriteOutcome.OK) {
      this.settingWriteNote = result.message;
      this.closeStructSettingSheet();
      return;
    }
    this.credentialNote = result.message;
  }

  /** 侧栏该用哪种呈现（几何层判定；**栏目不随形态变**，见 docs/ia-parity-plan.md） */

  /**
   * 栏间拖拽把手（P3 §12：官方 AppFrame 有 drag handles）。
   *
   * 【为什么视觉只有 12vp】它在两栏之间，视觉上应当只是一条线；但**命中区域**按输入模态放宽
   * （触控 44vp / 指针 24vp，`responseRegion` 只扩大命中不改布局）——细线点不中是
   * 移动端最常见的"看起来能用、实际点不到"。
   */

  // ───────────────────── 主内容路由 ─────────────────────

  /** 标签页内容所需能力的门面（**每次渲染重建**：值型快照、写型 setter、方法型闭包） */
  private buildMainFacade(): MainShellFacade {
    const facade: MainShellFacade = {
    TAG: TAG,
    DOMAIN: DOMAIN,
    composeHostUrl: (address: string, token: string) => composeHostUrl(address, token),
    storageBaseUrl: (url: string) => storageBaseUrl(url),
    reportConnectedHost: (baseUrl: string, token: string) => reportConnectedHost(baseUrl, token),
    activePanel: () => this.activePanel(),
    answerPending: (item: PendingItem, selected: string[], custom: string) => this.answerPending(item, selected, custom),
    attachNotice: this.attachNotice,
    setAttachNotice: (value: string) => {
      this.attachNotice = value;
    },
    attachments: this.attachments,
    commands: this.commands,
    connectAddress: this.connectAddress,
    setConnectAddress: (value: string) => {
      this.connectAddress = value;
    },
    connectAdvice: this.connectAdvice,
    setConnectAdvice: (value: string) => {
      this.connectAdvice = value;
    },
    connectBusy: this.connectBusy,
    setConnectBusy: (value: boolean) => {
      this.connectBusy = value;
    },
    connectOk: this.connectOk,
    setConnectOk: (value: boolean) => {
      this.connectOk = value;
    },
    connectResult: this.connectResult,
    setConnectResult: (value: string) => {
      this.connectResult = value;
    },
    connectToken: this.connectToken,
    setConnectToken: (value: string) => {
      this.connectToken = value;
    },
    decidePending: (item: PendingItem, choiceId: string, reason: string) => this.decidePending(item, choiceId, reason),
    detailOverlayOpen: this.detailOverlayOpen,
    setDetailOverlayOpen: (value: boolean) => {
      this.detailOverlayOpen = value;
    },
    diag: this.diag,
    diagMode: () => this.diagMode(),
    diagRunning: this.diagRunning,
    draft: this.draft,
    setDraft: (value: string) => {
      this.draft = value;
    },
    exportDiagnostics: () => this.exportDiagnostics(),
    hosts: this.hosts,
    hubAuthority: this.hubAuthority,
    hubConnected: this.hubConnected,
    hubError: this.hubError,
    hubPhase: this.hubPhase,
    hubStreams: this.hubStreams,
    hubTraceTail: () => this.hubTraceTail(),
    modality: this.modality,
    modalityEntry: () => this.modalityEntry(),
    models: this.models,
    jobs: this.jobs,
    nav: this.nav,
    setNav: (value: NavigationState) => {
      this.nav = value;
    },
    noticeText: (n: ActionNotice) => this.noticeText(n),
    offline: this.offline,
    openDiagnostics: () => this.openDiagnostics(),
    openPoc: () => this.openPoc(),
    paletteOpen: this.paletteOpen,
    setPaletteOpen: (value: boolean) => {
      this.paletteOpen = value;
    },
    panelRegistry: this.panelRegistry,
    pending: this.pending,
    permissionCurrent: this.permissionCurrent,
    pickAndAttach: () => this.pickAndAttach(),
    planActive: this.planActive,
    planPending: this.planPending,
    queuedCount: this.queuedCount,
    quoteIntoDraft: (item: TrajectoryItem) => this.quoteIntoDraft(item),
    references: this.references,
    resendMessage: (item: TrajectoryItem) => this.resendMessage(item),
    runDiagnostics: () => this.runDiagnostics(),
    running: this.running,
    setRunning: (value: boolean) => {
      this.running = value;
    },
    searchOpen: this.searchOpen,
    setSearchOpen: (value: boolean) => {
      this.searchOpen = value;
    },
    selectedSessionId: this.selectedSessionId,
    // 会话头上下文行（P2-7）：工作区名从选中会话的 cwd 派生（拿不到就空串 ⇒ 界面不显示那段）
    sessionWorkspaceName: this.selectedSessionWorkspaceName(),
    sessionUpdatedAt: this.selectedSessionUpdatedAt(),
    selection: this.selection,
    sendDraft: () => this.sendDraft(),
    sessionStats: this.sessionStats,
    settingWriteNote: this.settingWriteNote,
    settingWriteDomain: this.settingsWriteDomain,
    setSettingWriteNote: (value: string) => {
      this.settingWriteNote = value;
    },
    stackPage: this.stackPage,
    setStackPage: (value: StackPage) => {
      this.stackPage = value;
    },
    statsLine: this.statsLine,
    tabFacade: this.buildTabFacade(),
    togglePlan: () => this.togglePlan(),
    traceEnabled: this.traceEnabled,
    setTraceEnabled: (value: boolean) => {
      this.traceEnabled = value;
    },
    traceLines: this.traceLines,
    setTraceLines: (value: string[]) => {
      this.traceLines = value;
    },
    trajectoryItems: this.trajectoryItems,
    };
    return facade;
  }

  /**
   * 答复审批。
   *
   * 上游的审批结果词表是封闭四值（`dshcompat.APPROVAL_OUTCOMES`），**没有「始终允许」**。
   * 因此「本次会话内均允许」被映射为 `allowed-once` 发送，只在本客户端记住「不再打扰」——
   * 绝不为了满足 UI 而去伪造一个上游不认识的词（那会让 Host 直接拒绝或静默误解）。
   * 当前 `always` 标记只写进协议旁路日志，供用户排查时看到「这条其实是逐次询问的」。
   *
   * 未连接时不发任何请求、也不把卡片移除：卡片消失会让用户以为已经答复成功。
   */
  private decidePending(item: PendingItem, choiceId: string, reason: string): void {
    if (!this.hubConnected) {
      return;
    }
    // 【已知缺口】拒绝理由目前**无法随审批应答上传**：上游的审批 outcome 只是一个
    // 封闭词汇里的字符串（`allowed-once | rejected | cancelled | unavailable`），
    // 没有承载理由的字段。用户填的理由因此只能留在本地。
    // 不走「把理由塞进 waterfall 的 rejected 错误」这条歪路——那表达的是
    // 「本应答者处理失败」，会让 Host 转问下一个应答者并最终 fail-closed 成
    // `unavailable`，与「用户明确拒绝」语义完全不同，会把一次明确拒绝变成一次失败。
    // 已作为能力缺口登记在 D2 §8.7.5 与 D3 §3.4 的偏离记录里。
    const allow: boolean = choiceId !== APPROVAL_CHOICE_DENY;
    const always: boolean = choiceId === APPROVAL_CHOICE_ALLOW_ALWAYS;
    SessionHub.shared().decideApproval(item.id, allow, always);
  }

  /** 答复提问（`selected` 是选项 label 原文，符合上游 `AskUserQuestionAnswerItem`）。 */
  private answerPending(item: PendingItem, selected: string[], custom: string): void {
    if (!this.hubConnected) {
      return;
    }
    SessionHub.shared().answerQuestion(item.id, selected, custom);
  }

  /**
   * 发送当前草稿。
   *
   * 连上 Host 时交给中枢（它负责构造兼容面要求的 prompt 载荷、
   * 维护乐观回显对账用的 requestId，以及离线时进待发队列）。
   * 未连接时只清空输入框——**不伪造成功**，否则用户会以为消息发出去了。
   */
  private sendDraft(): void {
    const text: string = this.draft.trim();
    if (text.length === 0) {
      return;
    }
    this.draft = '';
    // 【附件列表**不在这里**清空】它由中枢拥有：回执只在 Host 确认接受这次提示词后
    // 才会被回收，那时中枢清空并广播。在这里乐观清空会让「发送失败」时
    // 附件条目凭空消失——用户既发不出去，也看不到自己加过什么。
    if (this.hubConnected) {
      SessionHub.shared().sendPrompt(text);
    }
  }

  /** 旁路日志尾部（最多 4 行）：状态条只展示最近发生的几步，完整日志在诊断页 */
  private hubTraceTail(): string[] {
    const all: string[] = this.hubTrace;
    if (all.length <= 4) {
      return all;
    }
    return all.slice(all.length - 4);
  }

  /** 诊断模式（D7 §3 第 4 项）：本机核心 / 远程 Host / 未接线 */
  private diagMode(): DiagMode {
    const ready: boolean = this.coreView.phase === CorePhase.READY
      || this.coreView.phase === CorePhase.DEGRADED;
    return diagModeOf(ready, this.hosts.length > 0);
  }

  // ── 端侧核心页（D6）────────────────────────────────────────────────────
  /**
   * 刷新核心页的呈现模型。
   *
   * 【为什么现在只读"版本仓库"、不报任何"就绪"】运行时载体（阶段一的 Electron-on-鸿蒙
   * 运行时 / 阶段二的 libnode.so）**尚未接线**，因此任何"已启动 / 就绪"的说法都是假的。
   * 这里只做两件真实的事：
   *   1. 读沙箱里的核心仓库（已经装了哪些版本、当前/上一版是谁）；
   *   2. 把还没探测到的事实如实写成「未探测 + 探测条件」——而不是编一个值。
   * 这条纪律与项目"界面不说谎"的要求一致（D3 §4）。
   */
  private refreshCoreView(): void {
    this.refreshCoreViewAsync().catch(() => {
    });
  }

  /**
   * 端侧核心的生命周期入口。
   *
   * 【载体已换成阶段二】此前这里用 `NotWiredRuntime`（如实报告"未接线"）。现在运行时门
   * 已在真机通过（D6 E31：`libnode 版本 = 22.23.2`），所以默认载体换成 `NodeRuntime`
   * ——它 import 的 `libdshhost.so` 由 hvigor/CMake 构建（E30：手工放 `.so` 绑不上）。
   *
   * 【入口脚本路径怎么来】`resourceDir` 是 HAP 资源目录，入口脚本随包放在
   * `resources/app/main.js` 下（由 `tools/electron-runtime/place-host-app.ps1` 放置）。
   * 它**不属于任何一版核心树**：核心树可切换/回滚，入口脚本随应用发版
   * （见 `hostruntime` 里 `buildHostArgv` 的说明）。
   */
  private coreHost(filesDir: string, resourceDir: string, cacheDir: string): DshHost {
    if (this.host === null) {
      this.host = new DshHost(filesDir, new NodeRuntime(`${resourceDir}/resources/app/main.js`, filesDir));
    }
    return this.host;
  }

  /**
   * 刷新核心页的呈现模型。
   *
   * 【为什么状态从 DshHost 来，而不是在这里写死】阶段的判断（未接线/未安装/待启动/就绪/失败）
   * 与"为什么"必须只有一个来源，否则核心页与诊断页迟早会给出互相矛盾的结论。
   * 这里只做**映射**：hostruntime 的事实 → appstate 的呈现契约。
   */
  private async refreshCoreViewAsync(): Promise<void> {
    let status: HostStatus | null = null;
    let repoNote: string = '';
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      const host: DshHost = this.coreHost(ctx.filesDir, ctx.resourceDir, ctx.cacheDir);
      status = await host.status();
      repoNote = `核心树目录：${host.store_().coresDir()}`;
    } catch (e) {
      repoNote = '读取核心树目录失败（详见 hilog）';
    }
    if (status === null) {
      this.coreView = emptyCoreView();
      return;
    }

    /*
     * 宿主报告 → 本页投影：逐字段取出（ArkTS 禁止结构化类型，见 CoreProjection 顶部说明）。
     * 行在这里只做"清单行 → 界面行"的搬运，排序与文案都在 appstate 的纯函数里。
     */
    const inventory: PluginInventoryTotals = {
      pluginRows: status.plugins.totals.pluginRows,
      pureJs: status.plugins.totals.pureJs,
      native: status.plugins.totals.native,
      unknown: status.plugins.totals.unknown,
      disabled: status.plugins.totals.disabled
    };
    const pluginRows: PluginRow[] = [];
    for (const r of status.plugins.rows) {
      pluginRows.push(pluginRowOf(r.id, r.name, r.nativeKind, r.disabled));
    }

    const probe: RuntimeProbe = status.probe;
    const facts: CoreFact[] = [
      probe.nodeVersion.length > 0
        ? fact('Node 运行时', probe.nodeVersion, 'ok', '')
        : unknownFact('Node 运行时', '运行时载体接线后显示实际版本（要求 ≥ 22.17.0）'),
      probe.zstd === null
        ? unknownFact('zlib zstd 能力', '会话持久化依赖 node:zlib 的 zstd，接线后自动探测')
        : fact('zlib zstd 能力', probe.zstd ? '可用' : '不可用', probe.zstd ? 'ok' : 'warn',          probe.zstd ? '' : '缺少 zstd 会让会话持久化不可用'),
      probe.jitless === null
        ? unknownFact('JIT 状态', '本项目统一按 jitless 运行，不申请任何特殊权限')
        : fact('JIT 状态', probe.jitless ? '未启用' : '已启用', probe.jitless ? 'ok' : 'warn',
          probe.jitless ? '' : '本项目要求 jitless：不申请特殊权限以保证顺利上架（D6 §4.4）'),
      this.nativeFact(probe),
      probe.listenAddress.length > 0
        ? fact('监听地址', probe.listenAddress,
          probe.listenAddress.startsWith('127.0.0.1') ? 'ok' : 'warn',
          probe.listenAddress.startsWith('127.0.0.1') ? '' : '端侧核心只应监听回环地址')
        : unknownFact('监听地址', '核心起来后应只监听 127.0.0.1'),
      fact('核心仓库',
        status.installed.length > 0 ? `已安装 ${status.installed.length} 个版本` : '空',
        status.installed.length > 0 ? 'ok' : 'warn',
        repoNote),
      pluginInventoryFact(status.plugins.note, status.plugins.version, inventory,
        status.plugins.nativePackages.length)
    ];

    /*
     * 【首启阶段：解包中优先于"未安装"（E99）】内置核心的解包发生在 EntryAbility 的
     * `DshHost` 实例里，而页面用的是另一个实例 ⇒ `transient` 看不到，`installed` 又还是空，
     * 于是首启时会话页显示「还没有安装核心」——事实正相反。用 AppStorage 里那个
     * 跨实例标志把阶段纠正为 EXTRACTING（空态文案随之变成「正在解包核心」）。
     */
    const phase: CorePhase = (this.coreInstalling && status.installed.length === 0)
      ? CorePhase.EXTRACTING
      : corePhaseOfHostState(status.state);

    this.coreView = buildCoreView({
      phase: phase,
      title: this.coreInstalling && status.installed.length === 0
        ? '正在解包内置核心（首次启动只需一次）'
        : status.note,
      detail: probe.available
        ? ''
        : '版本仓库与运行时事实现在就能看；载体接线后即可在这里起 Host。',
      busy: this.coreInstalling || hostStateIsTransient(status.state),
      installed: status.installed,
      currentVersion: status.currentVersion,
      previousVersion: status.previousVersion,
      profileName: status.profile,
      facts: facts,
      plugins: rankPluginRows(pluginRows)
    });
  }

  /**
   * 安装随应用内置的核心包（首启解包）。
   *
   * 与"启动核心"的区别：这一步**不需要运行时载体**，所以运行时还没接上时也能先把核心装好。
   * 诚实性要求：解压 API 没有进度回调，因此这里**不编造百分比**，只说明"正在解包"与量级。
   */
  private installBundledCore(): void {
    this.installBundledCoreAsync().catch(() => {
    });
  }

  private async installBundledCoreAsync(): Promise<void> {
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      const host: DshHost = this.coreHost(ctx.filesDir, ctx.resourceDir, ctx.cacheDir);
      this.coreNotice = '正在安装内置核心：解包约 2.5 万个文件，请勿退出应用……';
      const result: BundledInstallResult = await host.installBundled(ctx.resourceDir, ctx.cacheDir);
      this.coreNotice = result.note;
    } catch (e) {
      const err = e as Error;
      this.coreNotice = `安装内置核心失败：${err.message}`;
    }
    await this.refreshCoreViewAsync();
  }

  /** 原生件加载事实。没有数据时如实写"未探测"，不写 0/N 这种看起来像结论的值。 */  private nativeFact(probe: RuntimeProbe): CoreFact {
    if (probe.natives.length === 0) {
      return unknownFact('原生件加载', 'koffi / node-pty / sharp 三个鸿蒙移植件的加载结果');
    }
    let loaded: number = 0;
    for (let i = 0; i < probe.natives.length; i++) {
      if (probe.natives[i].loaded) {
        loaded++;
      }
    }
    const all: boolean = loaded === probe.natives.length;
    /*
     * 【2/3 到底是谁没加载（E121）】此前只写"2/3 已加载"，用户（和排查的人）无法知道
     * 缺的是哪一件、为什么缺——而"哪一个"直接决定受影响的能力：
     * koffi → 进程/沙箱链，node-pty → 终端，sharp → 图片处理。
     * 这里把**未加载者的名字与原因**一并写出来，原因取自 Host 的探测记录（原生 require 的真实报错）。
     */
    const missing: string[] = [];
    for (let i = 0; i < probe.natives.length; i++) {
      const n = probe.natives[i];
      if (!n.loaded) {
        const why: string = n.note === undefined || n.note.length === 0 ? '原因未记录' : n.note;
        missing.push(`${n.name}：${why}`);
      }
    }
    /*
     * 【E121 修正：缺失件必须写进**值**，不能只放 note】
     * 真机验收时发现：`fact()` 的第三个参数（note）在核心页这一版式里**不渲染**，
     * 于是"2/3 已加载"照旧，缺的是谁、为什么缺，用户仍然看不到——等于没改。
     * 与"界面不撒谎"同一条纪律：**信息要出现在真正被渲染的位置**。
     * 值里只放名字（短），完整原因仍留在 note 里供将来有版式时使用。
     */
    const names: string[] = [];
    for (let i = 0; i < probe.natives.length; i++) {
      const n = probe.natives[i];
      if (!n.loaded) {
        names.push(n.name);
      }
    }
    const value: string = names.length === 0
      ? `${loaded}/${probe.natives.length} 已加载`
      : `${loaded}/${probe.natives.length} 已加载 · 缺 ${names.join(' / ')}`;
    return fact('原生件加载', value,
      all ? 'ok' : 'warn',
      all ? '' : `未加载：${missing.join('；')}`);
  }

  /**
   * 核心页的动作。
   *
   * 【接线原则】能在今天真实执行的，就接真实实现，而不是统一回一句"尚未接线"。
   * 因为"尚未接线"这句话必须**只用于真的没实现的东西**——否则等载体接上以后，
   * 这些按钮还会继续说不接线，而没人会想起来改。具体：
   *   - install  ：解包内置核心包，**不依赖运行时**，早已接线；
   *   - start/stop/restart：`DshHost` 上已实现的真实调用。未接载体时它返回的是
   *                 **真实原因**（运行时探测结果），载体一接上同一段代码就直接可用；
   *   - rollback ：`CoreStore.rollback()` 是真实状态事务，且**不要求健康检查**
   *                （回滚的语义就是退回已知可用的上一版），所以今天就能做；
   *   - import   ：需要文件选择器 + 包校验 + 签名检查，确实还没做；
   *   - diagnose ：需要运行时事实，确实还没做。
   */
  private onCoreAction(id: string): void {
    if (id === 'install') {
      this.installBundledCore();
      return;
    }
    if (id === 'start' || id === 'restart' || id === 'stop') {
      this.coreLifecycleAction(id);
      return;
    }
    if (id === 'rollback') {
      this.rollbackCore();
      return;
    }
    if (id === 'import') {
      this.coreNotice = '「导入核心包」尚未接线：需要文件选择器、容器校验与签名检查'
        + '（校验规则见 hostcore/README.md 的容器契约），现在导入无法保证包可用。';
      return;
    }
    this.coreNotice = '「诊断导出」尚未接线：运行时接上后，这里会导出运行时事实与核心状态。';
  }

  /** 起停核心。restart = 先停再起（stop 是幂等的）。 */
  private coreLifecycleAction(id: string): void {
    this.coreLifecycleActionAsync(id).catch(() => {
      this.coreNotice = '核心操作失败（详见 hilog）';
    });
  }

  private async coreLifecycleActionAsync(id: string): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    const host: DshHost = this.coreHost(ctx.filesDir, ctx.resourceDir, ctx.cacheDir);
    const notes: string[] = [];
    if (id === 'stop' || id === 'restart') {
      const stopped: OpResult = await host.stop();
      notes.push(stopped.ok ? '核心已停止' : stopped.message);
    }
    if (id !== 'stop') {
      const started: HostStartResult = await host.start();
      // start() 失败时给的是真实原因（例如运行时未接线的探测结论），不要改写成"请稍后"
      notes.push(started.ok ? started.note : `未启动：${started.note}`);
    }
    this.coreNotice = notes.join('；');
    await this.refreshCoreViewAsync();
  }

  /**
   * 回滚到上一版。
   *
   * `CoreStore.rollback()` 要求 previous 存在且仍是已安装版本（判据在 Types.decideRollback，
   * 可单测），不满足就 REFUSE 且**不动状态**。这里如实区分三种结果：
   * 拒绝、写盘失败、成功。成功后还要说清"核心并未随之重启"——
   * 状态指向变了 ≠ 有东西在跑，这句话不能省。
   */
  /**
   * 回滚到上一版本（E92）：停 → 事务 → 起回滚后的版本 → 重新接入。
   *
   * 【为什么不能只改状态】早先这里只调 `rollback()` 写状态，提示语还写着"核心并未随之重启"——
   * 那是运行时未接线时的旧事实。现在运行时是通的：只改状态会让界面显示的版本与**正在跑的**
   * 版本不一致，那种不一致比回滚失败更难查。所以这里做完整的"停 → 回滚 → 起 → 重连"。
   */
  private rollbackCore(): void {
    this.rollbackCoreAsync().catch(() => {
      this.coreNotice = '回滚失败（详见 hilog）';
    });
  }

  private async rollbackCoreAsync(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    const host: DshHost = this.coreHost(ctx.filesDir, ctx.resourceDir, ctx.cacheDir);
    this.coreNotice = '正在回滚：先停当前核心，再把上一版本起回来…';
    this.refreshCoreView();
    const res: OpResult = await host.rollbackTo();
    this.coreNotice = res.message;
    hilog.info(DOMAIN, TAG, 'DSHM-CORE 回滚结果：ok=%{public}s note=%{public}s',
      res.ok ? 'true' : 'false', res.message);
    if (res.ok) {
      this.adoptLocalHostAfterRestart(host);
    }
    this.refreshCoreViewAsync().catch(() => {
    });
  }

  /**
   * 选择某个已安装版本作为**切换目标**。
   *
   * 「切换」走的是 `activate(candidate, health, …)`，而它的判据要求健康检查为 PASS
   * （`Types.decideActivation`：宁可停在旧版本，也不要把没验证过的核心设为当前）。
   * 健康检查必须先把候选版本起一次，因此运行时未接线时这一步**做不了**；
   * 这里不写任何状态，只说明原因。
   */
  /**
   * 写入**默认模型**（E96）：provider / model / reasoningEffort 三个字段一起落到
   * `agent-default-model` 命名空间，由 `SessionHub.setDefaultModel` 负责逐个 set 并处理
   * revision 冲突。结果（含失败原因）通过 `settingWriteNote` 就地回显——设置页顶部那行
   * 就是用户唯一能看到"Host 到底接受了没有"的地方。
   */
  /**
   * 重置一项设置为**部署默认**（E114：对齐官方"重置"）。
   *
   * 走 `settings/unset`（删掉用户层的那一项，值立刻回落到基线/默认），
   * 结果（含冲突/被拒的原因）与写入一样回显在设置页顶部——用户唯一能看到
   * "Host 到底接受了没有"的地方。
   */
  private resetSetting(key: string): void {
    this.noteSettingWrite(key, `正在重置 ${key}…`);
    SessionHub.shared().unsetSetting(key).then((result: SettingsWriteResult) => {
      this.noteSettingWrite(key, result.message);
      hilog.info(DOMAIN, TAG, 'DSHM-SET 重置 %{public}s：%{public}s', key, result.outcome);
    }).catch((e: Object) => {
      const err = e as Error;
      this.noteSettingWrite(key, `重置失败：${err.message}`);
    });
  }

  /**
   * 取本地化字符串（E140：**运行时状态字符串**不能用 `$r`）。
   *
   * 【为什么需要这个函数】`Text('…')` 这类**渲染绑定**直接写 `$r('app.string.x')` 即可，
   * 系统按语言解析；但 `this.settingWriteNote = …` 这类 **string 字段**不行——
   * ArkTS 不会把资源引用解析成文本（塞进去要么编译不过，要么在别处以对象形态露馅）。
   * 正确做法是经**资源管理器**取值。取不到（资源缺失/上下文不可用）时返回空串，
   * 由调用方决定回落到什么文案——**不抛**，因为文案取不到不该让操作失败。
   */
  private localized(id: Resource): string {
    try {
      // E147：取值实现只留一份（platform/system/Strings），页面只负责提供上下文
      const ctx = getContext(this) as common.UIAbilityContext;
      return localizedOr(ctx, id, '');
    } catch (e) {
      return '';
    }
  }

  /**
   * 忘记当前 Host（E137）。
   *
   * 【为什么是"忘记"而不是"吊销"】官方那套是"设备配对 + 逐设备吊销密钥"，而本应用
   * **没有配对模型**：它只记**一个** Host（`rememberedUrl` + token），默认还是本机核心。
   * 所以按钮的真实语义是"忘掉这个地址与令牌"——改了名字才对得上它实际做的事。
   *
   * 【忘记之后会怎样】清掉记住的地址/令牌并断开；下次启动会重新走"本机核心自启 + 自动接入"，
   * 也就是说**不会把用户留在无 Host 的空白状态**。
   */
  private forgetHost(): void {
    AppStorage.setOrCreate<string>('dshLastHostUrl', '');
    AppStorage.setOrCreate<string>('dshLastHostToken', '');
    AppStorage.setOrCreate<string>('dshLastHostTokenState', 'none');
    AppStorage.setOrCreate<boolean>('dshHostAutoConnect', false);
    this.rememberedUrl = '';
    this.rememberedToken = '';
    this.rememberedTokenState = 'none';
    this.shouldAutoConnect = false;
    SessionHub.shared().disconnect();
    this.attachNotice = '已忘记这个 Host；下次启动会重新接入本机核心，也可以现在粘贴新的启动链接。';
    hilog.info(DOMAIN, TAG, 'DSHM-CONN 已忘记 Host');
  }

  private applyDefaultModel(provider: string, model: string, effort: string): void {
    this.noteSettingWrite(DEFAULT_MODEL_NS, `正在写入默认模型 ${provider} / ${model}…`);
    SessionHub.shared().setDefaultModel(provider, model, effort).then((note: string) => {
      this.noteSettingWrite(DEFAULT_MODEL_NS, note);
      hilog.info(DOMAIN, TAG, 'DSHM-MODEL 默认模型写入结果：%{public}s', note);
    }).catch((e: Object) => {
      const err = e as Error;
      this.noteSettingWrite(DEFAULT_MODEL_NS, `写入默认模型失败：${err.message}`);
      hilog.warn(DOMAIN, TAG, 'DSHM-MODEL 默认模型写入异常：%{public}s', err.message);
    });
  }

  /**
   * 插件行启停（E91）。
   *
   * 【这件事在端侧的真实边界】安装/卸载插件做不到（上游经 pnpm 创建进程，鸿蒙不允许），
   * 但"启停随包发版的行"是纯文件操作：写 `$DSH_HOME/profiles/<profile>/.dshm-plugin-rows.yml`，
   * 由入口脚本在下次启动时拼进 profile 的 `cordis.patch.yml`。所以这里的结果话术必须带
   * **"重启核心后生效"**——插件树是启动时挂载的，不重启就改了也不生效。
   */
  private onTogglePlugin(id: string, disabled: boolean): void {
    const host: DshHost | null = this.host;
    if (host === null) {
      this.pluginNotice = '核心尚未接线，无法保存插件启停';
      return;
    }
    const res: OpResult = host.setPluginDisabled(id, disabled);
    this.pluginNotice = res.message;
    hilog.info(DOMAIN, TAG, 'DSHM-PLUGIN 设置启停：id=%{public}s disabled=%{public}s ok=%{public}s note=%{public}s',
      id, disabled ? 'true' : 'false', res.ok ? 'true' : 'false', res.message);
    // 清单里的 disabled 会叠加用户行，刷新一次让界面显示"重启后会生效的状态"
    this.refreshCoreView();
  }

  /** 恢复默认启停（清空用户行文件；核心包自带的启停不受影响）。 */
  private onResetPluginRows(): void {
    const host: DshHost | null = this.host;
    if (host === null) {
      this.pluginNotice = '核心尚未接线，无法恢复默认';
      return;
    }
    const res: OpResult = host.resetPluginRows();
    this.pluginNotice = res.ok ? `${res.message}；重启核心后生效` : res.message;
    hilog.info(DOMAIN, TAG, 'DSHM-PLUGIN 恢复默认：ok=%{public}s note=%{public}s',
      res.ok ? 'true' : 'false', res.message);
    this.refreshCoreView();
  }

  /**
   * 选择某个已安装版本作为**切换目标**（E92）。
   *
   * 走 `DshHost.switchTo`：停当前 → 起候选做健康检查 → 通过才激活；候选起不来就把它停掉、
   * 把旧版本起回来并如实报告。健康检查之所以只能是"真的起一次"，见 `Types.decideActivation`
   * 的判据（宁可停在旧版本，也不要把没验证过的核心设为当前）。
   */
  private onCoreSelectVersion(version: string): void {
    this.switchCoreAsync(version).catch(() => {
      this.coreNotice = '切换核心失败（详见 hilog）';
    });
  }

  private async switchCoreAsync(version: string): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    const host: DshHost = this.coreHost(ctx.filesDir, ctx.resourceDir, ctx.cacheDir);
    this.coreNotice = `正在切换到 ${version}：先停当前核心，再起候选做健康检查…`;
    this.refreshCoreView();
    const res: OpResult = await host.switchTo(version);
    this.coreNotice = res.message;
    hilog.info(DOMAIN, TAG, 'DSHM-CORE 切换结果：ok=%{public}s note=%{public}s',
      res.ok ? 'true' : 'false', res.message);
    if (res.ok) {
      this.adoptLocalHostAfterRestart(host);
    }
    this.refreshCoreViewAsync().catch(() => {
    });
  }

  /**
   * 核心重启后**重新接入本机 Host**（E92）。
   *
   * 【为什么必须做】切换/回滚都会重启宿主，而 dsh 每个进程都会重新生成启动 token
   * （cookie 也绑进程）⇒ 旧 token 立刻作废。若只重启不重连，界面会停在
   * "刚切完就掉线"，看起来像"切换把连接弄坏了"；而真相是"凭据换了，需要重新取一次"。
   * 取不到新的启动链接时**如实说**，不静默装作没事。
   */
  private adoptLocalHostAfterRestart(host: DshHost): void {
    const url: string = host.localHostReadyUrl();
    if (url.length === 0) {
      this.hubError = '核心已重启，但没能读到新的启动链接（host-ready.json）；请到「设置」页重新接入本机 Host。';
      return;
    }
    const hub: SessionHub = SessionHub.shared();
    if (!hub.configure(url, undefined)) {
      this.hubError = '核心已重启，但新的启动链接形态不合法，未能自动接入。';
      return;
    }
    this.connectBusy = true;
    hub.connect().then((ok: boolean) => {
      this.connectBusy = false;
      const snap: HubSnapshot = hub.snapshot();
      hilog.info(DOMAIN, TAG, 'DSHM-CORE 重启后接入：ok=%{public}s sessions=%{public}d err=%{public}s',
        ok ? 'true' : 'false', snap.sessions.length,
        snap.lastError.length > 0 ? snap.lastError : '(none)');
      if (ok) {
        this.hubError = '';
      } else if (snap.lastError.length > 0) {
        this.hubError = snap.lastError;
      }
    });
  }

  // ───────────────────── 工作区视图（E108：会话与待决并入）─────────────────────

  /** 某个工作区下的会话（按 `cwd` 归一化匹配：工作区本来就是由会话的 cwd 归并出来的） */
  /** 已归档的会话（E134：按注册表归档集过滤；用于归档分组） */
  private archivedSessions(): SessionListItem[] {
    const out: SessionListItem[] = [];
    for (let i = 0; i < this.sessions.length; i++) {
      const s: SessionListItem = this.sessions[i];
      if (this.archivedSessionIds.indexOf(s.id) >= 0) {
        out.push(s);
      }
    }
    return out;
  }

  /**
   * 工作区 → 注册表 id（E132）。
   *
   * 【为什么按路径匹配】我们的工作区列表由会话 `cwd` 归并而来（没有 id），
   * 而注册表行带 `workspaceId`——两者之间**唯一**可靠的共同键是目录路径。
   * 匹配不到就返回空串：调用方据此**不显示**删除入口，而不是给一个点了没反应的按钮。
   */
  /**
   * 在**指定工作区**里新建会话（E163，用户反馈①）。
   *
   * 【为什么要先注册工作区】会话归属由宿主按 `workspaceId`（注册表 id）记账，
   * 而列表里的工作区是由会话目录归并出来的、本身没有 id。所以顺序是：
   * ①`ensureWorkspace(w.path)` 把该目录注册/解析成工作区并拿到 id，
   * ②`createSession()` 便会带上这个 `workspaceId`（E98 已实现）⇒ 新会话**确实落在这个工作区**，
   * 而不是像以前那样落在"当前默认工作区"（用户看不出是给谁加的）。
   *
   * 未连接时如实提示，不做乐观动作。
   */
  private createSessionIn(w: WorkspaceItem): void {
    const hub: SessionHub = SessionHub.shared();
    if (!this.hubConnected) {
      this.attachNotice = '尚未连接 Host，无法新建会话。';
      return;
    }
    this.attachNotice = `正在把 ${w.path} 设为当前工作区…`;
    hub.setDefaultWorkspace(w.path);
    hub.ensureWorkspace(w.path).then((note: string) => {
      hilog.info(DOMAIN, TAG, 'DSHM-WS 目标工作区：%{public}s', note);
      return hub.createSession();
    }).then((sid: string | undefined) => {
      this.attachNotice = sid === undefined
        ? '新建会话失败：见状态条上的原因。'
        : `已在 ${w.name.length > 0 ? w.name : w.path} 里新建会话。`;
    }).catch((e: Object) => {
      const err = e as Error;
      this.attachNotice = `新建会话失败：${err.message}`;
    });
  }

  private registryIdOf(w: WorkspaceItem): string {
    const key: string = normalizePathKey(w.path);
    for (let i = 0; i < this.workspaceRows.length; i++) {
      const row: WorkspaceRow = this.workspaceRows[i];
      if (normalizePathKey(row.path) === key) {
        return row.id;
      }
    }
    return '';
  }

  /** 删除工作区注册（E132）：只删登记，不动磁盘；结果回显在设置页那条提示上 */
  private deleteWorkspaceByPath(w: WorkspaceItem): void {
    const id: string = this.registryIdOf(w);
    if (id.length === 0) {
      this.attachNotice = this.localized($r('app.string.note_no_workspace_id'));
      return;
    }
    SessionHub.shared().deleteWorkspace(id).then((n: ActionNotice) => {
      this.attachNotice = this.noticeText(n);
      hilog.info(DOMAIN, TAG, 'DSHM-WS 删除工作区：%{public}s', n.code);
    }).catch((e: Object) => {
      const err = e as Error;
      this.attachNotice = `${this.localized($r('app.string.note_workspace_delete_failed'))}${err.message}`;
    });
  }

  /**
   * 把中枢的**结构化回执**渲染成本地化文案（E143 方案①）。
   *
   * 【兜底纪律】不认识的码**必须显示"码 + 数据"，而不是空白**——空白会让人以为操作没发生，
   * 而这正是本项目反复清理的那类"界面撒谎"。Host 侧给的原因（`params.reason`）**原样透传**：
   * 它是上游文案，不是我们的 UI 文案，不翻译。
   */
  private noticeText(n: ActionNotice): string {
    if (n.code === 'workspace.deleted') {
      return this.localized($r('app.string.note_workspace_deleted'));
    }
    if (n.code === 'session.archived') {
      return this.localized($r('app.string.note_session_archived'));
    }
    if (n.code === 'workspace.no-id') {
      return this.localized($r('app.string.note_no_workspace_id'));
    }
    if (n.code === 'archive.no-session') {
      return this.localized($r('app.string.note_archive_no_session'));
    }
    if (n.code === 'offline') {
      return this.localized($r('app.string.note_offline'));
    }
    if (n.code === 'contract.missing') {
      return `${this.localized($r('app.string.note_contract_missing'))}${n.params.endpoint}`;
    }
    if (n.code === 'workspace.delete.failed') {
      return `${this.localized($r('app.string.note_workspace_delete_failed'))}${n.params.reason}`;
    }
    // E170：预设的复制/删除回执（宿主原因原样透传；随附预设的只读由宿主强制）
    if (n.code === 'preset.copied') {
      return `已复制为预设「${n.params.id}」。会话创建时固定用哪一份，改默认只影响此后新建的会话。`;
    }
    if (n.code === 'preset.deleted') {
      return `已删除预设「${n.params.id}」；已据它组装的会话继续运行。`;
    }
    /*
     * E220：命令与模型选择的回执文案。
     * 这两批码在 E188/E194 引入时**只写了中枢、没接文案**（会落到"码 + 数据"的兜底显示）——
     * 兜底本身是对的（不撒谎），但能说人话就该说人话。
     */
    if (n.code === 'command.executed') {
      return `已执行「${n.params.name}」。`;
    }
    if (n.code === 'command.failed') {
      return `命令执行失败：${n.params.reason}`;
    }
    if (n.code === 'command.not-loaded') {
      return '命令目录尚未加载（需要先选中一个会话让宿主报告命令），请稍后重试。';
    }
    if (n.code === 'command.no-name') {
      return '未选择要执行的命令。';
    }
    if (n.code === 'model.selected') {
      return `本会话已改用「${n.params.model}」。`;
    }
    if (n.code === 'model.select.failed') {
      return `切换本会话模型失败：${n.params.reason}`;
    }
    if (n.code === 'model.needs-session') {
      return '请先在工作区里选中一个会话，再切换模型。';
    }
    if (n.code === 'model.incomplete') {
      return '切换模型需要提供方与模型名两者。';
    }
    if (n.code === 'preset.copy.failed') {
      return `复制预设失败：${n.params.reason}`;
    }
    if (n.code === 'preset.delete.failed') {
      return `删除预设失败：${n.params.reason}`;
    }
    if (n.code === 'preset.copy.missing') {
      return '复制预设需要"来源 + 新标识 + 名称"三项，缺一不可（宿主 schema 如此）。';
    }
    if (n.code === 'preset.delete.missing') {
      return '未指定要删除的预设。';
    }
    if (n.code === 'archive.failed') {
      return `${this.localized($r('app.string.note_archive_failed'))}${n.params.reason}`;
    }
    // 兜底：显示码与数据本身（绝不显示空白）
    return `${n.code} ${JSON.stringify(n.params)}`;
  }

  private sessionsOf(w: WorkspaceItem): SessionListItem[] {
    const key: string = normalizePathKey(w.path);
    const out: SessionListItem[] = [];
    for (let i = 0; i < this.sessions.length; i++) {
      const s: SessionListItem = this.sessions[i];
      if (s.cwd.length > 0 && normalizePathKey(s.cwd) === key) {
        // E132：已归档的会话从常规分组隐去（归档集是注册表全局的）
        if (this.archivedSessionIds.indexOf(s.id) >= 0) {
          continue;
        }
        out.push(s);
      }
    }
    return out;
  }

  /**
   * 打开某个工作区的**文件**视图（下钻一层）。
   *
   * 文件接口的作用域是**会话级**（`workspaceFileScopeId` = 会话 id），所以必须先在这个目录下
   * 有会话才看得到文件——这就是原实现里那条空态文案的由来。这里直接取该工作区的第一个会话当作用域。
   */
  private openWorkspaceFiles(w: WorkspaceItem): void {
    const scope: SessionListItem[] = this.sessionsOf(w);
    this.pendingWorkspacePick = true;
    if (scope.length === 0) {
      this.treeEmptyTitle = '该工作区下还没有会话';
      this.treeEmptyHint = '文件浏览的作用域是会话级（workspaceFileScopeId = 会话 id），请先在这个目录里新建一个会话。';
      this.wsDrill = 1;
      return;
    }
    this.treeEmptyTitle = '该目录暂无文件';
    this.treeEmptyHint = '目录确实为空，或 Host 拒绝列出它的内容（详见连接诊断）。';
    if (this.hubConnected) {
      SessionHub.shared().openWorkspace(scope[0].id);
    }
    this.wsDrill = 1;
  }


  /**
   * 核心页内容（E110：原「核心」页签并入设置，作为设置页的第一个页签）。
   *
   * 【为什么合并】核心不是"另一个世界"，它就是这台设备上 DSH 的运行配置：版本、插件、运行时事实。
   * 与"设置"并列成两个一级页签，会让用户在两个地方找同一类东西（官方 web 也没有独立的"核心"页，
   * 它是设置里的一个分区）。内容原样搬过来，能力一个不少。
   */
  /** 标签页内容所需能力的门面（**每次渲染重建**：值型快照、写型 setter、方法型闭包） */
  /** 工作区浏览器所需能力的门面（由 `buildTabFacade()` 的同类包装行筛出：同源同形状） */
  /**
   * 归档一个会话（视图只给 id）。
   *
   * 【为什么提到宿主】宽版行与窄版菜单都要归档 —— 副作用（提示文案、失败处理）写两遍必然走样。
   * 线协议只有 `workspace/archiveSession`，**没有反向端点**，故没有"取消归档"。
   */
  /**
   * 删除工作区登记的**两步确认**（E132：只删注册，不删磁盘目录）。
   *
   * 【为什么在宿主】宽版行与窄版行都要这个两步确认；判定（当前是否在确认态）与提示文案
   * 写在视图里就会有两份，而"两份确认态"必然走样。视图只问"按下去了"。
   */
  /** 侧栏席位被按下：翻译成"切到哪个主区面板"，再走既有的页签切换（归一化/清栈等决策不重写） */
  /** 开合手机侧栏抽屉（模型 `setDrawer`；它是唯一真值，视图不自持一份） */
  /**
   * 收起 / 展开侧栏（P2-15）。
   *
   * 【为什么这个动作此前不存在】侧栏呈现完全由形态决定（`shellTracksOf(mode)`），
   * 而 `NavigationState.sidebarExpanded` 这个字段**没有任何控制点** ——
   * 于是官方 AppFrame 那个"收起侧栏腾出宽度"的动作在本仓做不到（功能缺口，不是字段冗余）。
   * 现在：形态给默认（双栏 rail / 三栏 panel），用户展开或收起给偏好。
   */
  private toggleSidebarExpanded(): void {
    // 翻的是**当前生效值**（用户看到的那个），存的是显式偏好 ⇒ 三态收敛为两态
    const next: boolean = !sidebarExpandedForMode(this.mode, this.sidebarStored);
    this.sidebarStored = next;
    // 落盘：下次启动沿用它（与详情栏宽度同一套做法）。
    // 【失败不弹提示】与宽度记忆同类：下次启动回到默认展开，不值得打断用户；
    // 真要看落盘结果时去设置里的诊断。
    const prefs: LocalPrefs = new LocalPrefs();
    prefs.attach(getContext(this) as common.UIAbilityContext).then(() => {
      prefs.saveSidebarExpanded(next);
    });
  }

  /**
   * 读回记住的侧栏展开偏好。
   *
   * 【原样存，不在这里解析】"没存过 ⇒ 展开"曾在这里被判成 `true`，于是双栏首启拿到的是
   * "展开"（与形态默认矛盾）。现在这一层只搬运原始值（`boolean | undefined`），
   * "没存过用什么"交给纯函数 `sidebarExpandedForMode`（有 fixture，且随形态变）。
   */
  private async loadSidebarExpanded(): Promise<void> {
    const prefs: LocalPrefs = new LocalPrefs();
    await prefs.attach(getContext(this) as common.UIAbilityContext);
    this.sidebarStored = await prefs.loadSidebarExpanded();
  }

  private setDrawerOpen(open: boolean): void {
    this.nav = setDrawer(this.nav, open ? DrawerState.OPEN : DrawerState.CLOSED);
  }

  /** 右栏当前面板的中文名（标题行用；注册表找不到时兜底"详情"） */
  private selectedRightPanelLabel(): string {
    const d: PanelDescriptor | undefined = this.panelRegistry.find(this.nav.selectedRightPanel);
    return d !== undefined ? d.label : '详情';
  }

  /** 切右栏面板（经注册表校验：内容没做的候选切不过去） */
  /** 切设置分区（经注册表校验；写进 `NavigationState.settingsSection`——唯一真值） */
  private selectSettingsSection(sectionId: string): void {
    this.nav = openSettings(this.nav, sectionId, this.panelRegistry);
  }

  private selectRightPanelById(panelId: string): void {
    this.nav = selectRightPanel(this.nav, panelId, this.panelRegistry);
  }

  private selectSidebarPanel(panelId: string): void {
    // 席位 id → 主区面板 id → 旧页签取值：双跳是迁移期的形状（控制器仍说 NavTab），
    // 好处是"归一化 / 清栈 / 是否清会话选择"这些决策一条都不用重新实现。
    this.selectTab(legacyTabOfMainPanel(mainPanelOfSidebarPanel(panelId)) as NavTab);
  }

  /** 新建会话（侧栏一级入口与 Ctrl+N 走同一条路） */
  private newSession(): void {
    SessionHub.shared().createSession();
  }

  /** 选中面板的中文名（页头标题用；注册表找不到时给空串，由视图兜底） */
  private selectedPanelLabel(): string {
    const d: PanelDescriptor | undefined = this.panelRegistry.find(this.nav.selectedMainPanel);
    return d !== undefined ? d.label : '';
  }

  private toggleDeleteConfirm(w: WorkspaceItem): void {
    if (this.confirmingDeletePath === w.path) {
      this.confirmingDeletePath = '';
      this.deleteWorkspaceByPath(w);
      return;
    }
    this.confirmingDeletePath = w.path;
    // E140：状态字符串经资源管理器取值；并附上名字——确认框必须指名道姓
    const note: string = this.localized($r('app.string.confirm_delete_workspace_note'));
    const label: string = w.name.length > 0 ? w.name : w.path;
    this.attachNotice = note.length > 0
      ? `${note}（${label}）`
      : `再按一次「确认删除」即移除该工作区的登记；磁盘上的目录与文件不会被删除。（${label}）`;
  }

  private archiveSessionById(id: string): void {
    SessionHub.shared().archiveSession(id).then((n: ActionNotice) => {
      this.attachNotice = this.noticeText(n);
    }).catch((e: Object) => {
      const err = e as Error;
      this.attachNotice = `${this.localized($r('app.string.note_archive_failed'))}${err.message}`;
    });
  }

  /**
   * 右栏「文件」面板的门面。
   *
   * 【为什么选中项取预览的路径】"选中"的唯一真值就是**当前预览的文件**（`preview.path`）——
   * 与主区工作区页签用的是同一个表达式（见 `TabContentView` 里给 `WorkspacePane.selectedPath` 的写法）。
   * 空态文案也直接复用主区那份：它已按"没选工作区 / 目录下没会话 / 列目录失败"三种事实分档。
   */
  /**
   * 右侧内容的门面（P2-12）：**两处挂载点共用这一份**。
   *
   * 【为什么收在一处】`RightbarShell` 有两个挂载点 —— 三栏的真右栏（`AppShell`）与
   * 「详情」浮层（本文件的 `detailSheet`）。此前本文件把十来个 `right*` 值
   * **塞进 AppShell 门面**给前者，又**在同一文件里内联重算一遍**给后者：
   * 两处各写一遍必然漂移（新加一个面板的数据很容易只给一处）。
   * 现在两处都吃这个构造器的产物。
   */
  private buildRightbarFacade(): RightbarFacade {
    const facade: RightbarFacade = {
      panelId: this.nav.selectedRightPanel,
      panelLabel: this.selectedRightPanelLabel(),
      panels: this.panelRegistry.descriptors(PanelLocation.RIGHTBAR),
      preview: this.preview,
      files: this.buildRightFilesFacade(),
      // 交付物面板只要『已筛好的那一类条目』——筛选是纯模型（deliverablesOf，有断言），视图不做 for
      deliverables: deliverablesOf(this.trajectoryItems),
      subagents: itemsOfKind(this.trajectoryItems, TrajectoryKind.SUBAGENT),
      tools: itemsOfKind(this.trajectoryItems, TrajectoryKind.TOOL),
      trajectoryItems: this.trajectoryItems,
      stats: this.sessionStats,
      onSelectPanel: (panelId: string) => {
        this.selectRightPanelById(panelId);
      },
      onAttachFile: (node: FileNode) => {
        this.attachWorkspaceFileToComposer(node);
      },
      onLineTap: (section: string, text: string) => {
        if (text.length > 0) {
          copyText(text);
        }
      }
    };
    return facade;
  }

  private buildRightFilesFacade(): FileTreeFacade {
    const facade: FileTreeFacade = {
      tree: this.fileTree,
      selectedPath: this.preview === undefined ? '' : this.preview.path,
      emptyTitle: this.treeEmptyTitle,
      emptyHint: this.treeEmptyHint,
      onToggleDirectory: (path: string) => this.toggleDirectory(path),
      onOpenFile: (node: FileNode) => this.openFile(node)
    };
    return facade;
  }

  private buildBrowserFacade(): WorkspaceBrowserFacade {
    const facade: WorkspaceBrowserFacade = {
    answerPending: (item: PendingItem, selected: string[], custom: string) => this.answerPending(item, selected, custom),
    archiveOpen: this.archiveOpen,
    archivedSessionIds: this.archivedSessionIds,
    archivedSessions: () => this.archivedSessions(),
    archiveSession: (id: string) => this.archiveSessionById(id),
    toggleDeleteConfirm: (w: WorkspaceItem) => this.toggleDeleteConfirm(w),
    confirmingDeletePath: this.confirmingDeletePath,
    connectBusy: this.connectBusy,
    connectSettled: this.connectSettled,
    coreView: this.coreView,
    createSessionIn: (w: WorkspaceItem) => this.createSessionIn(w),
    decidePending: (item: PendingItem, choiceId: string, reason: string) => this.decidePending(item, choiceId, reason),
    hubAuthority: this.hubAuthority,
    hubError: this.hubError,
    hubPhase: this.hubPhase,
    hubStreams: this.hubStreams,
    hubTraceTail: () => this.hubTraceTail(),
    openDiagnostics: () => this.openDiagnostics(),
    openFolderPicker: () => this.openFolderPicker(),
    openSession: (id: string) => this.openSession(id),
    openWorkspaceFiles: (w: WorkspaceItem) => this.openWorkspaceFiles(w),
    pending: this.pending,
    registryIdOf: (w: WorkspaceItem) => this.registryIdOf(w),
    selectedSessionId: this.selectedSessionId,
    sessionsOf: (w: WorkspaceItem) => this.sessionsOf(w),
    setArchiveOpen: (value: boolean) => {
      this.archiveOpen = value;
    },
    workspaces: this.workspaces,
    };
    return facade;
  }

  private buildTabFacade(): TabContentFacade {
    const facade: TabContentFacade = {
    browserInSidebar: shellTracksOf(this.mode).sidebar === TrackPresentation.PANEL,
    settingsSection: this.nav.settingsSection,
    settingsSections: this.panelRegistry.descriptors(PanelLocation.SETTINGS),
    onSelectSettingsSection: (sectionId: string) => this.selectSettingsSection(sectionId),
    browser: this.buildBrowserFacade(),
    answerPending: (item: PendingItem, selected: string[], custom: string) => this.answerPending(item, selected, custom),
    applyDefaultModel: (provider: string, model: string, effort: string) => this.applyDefaultModel(provider, model, effort),
    archiveOpen: this.archiveOpen,
    setArchiveOpen: (value: boolean) => {
      this.archiveOpen = value;
    },
    archivedSessionIds: this.archivedSessionIds,
    archivedSessions: () => this.archivedSessions(),
    attachWorkspaceFileToComposer: (node: FileNode) => this.attachWorkspaceFileToComposer(node),
    choosing: this.choosing,
    setChoosing: (value: SettingChoice[] | undefined) => {
      this.choosing = value;
    },
    choosingCurrent: this.choosingCurrent,
    setChoosingCurrent: (value: string) => {
      this.choosingCurrent = value;
    },
    choosingKey: this.choosingKey,
    setChoosingKey: (value: string) => {
      this.choosingKey = value;
    },
    choosingLabel: this.choosingLabel,
    setChoosingLabel: (value: string) => {
      this.choosingLabel = value;
    },
    confirmingDeletePath: this.confirmingDeletePath,
    connectBusy: this.connectBusy,
    connectSettled: this.connectSettled,
    coreNotice: this.coreNotice,
    coreView: this.coreView,
    createSessionIn: (w: WorkspaceItem) => this.createSessionIn(w),
    credentials: this.credentials,
    currentTab: () => this.currentTab(),
    decidePending: (item: PendingItem, choiceId: string, reason: string) => this.decidePending(item, choiceId, reason),
    deleteWorkspaceByPath: (w: WorkspaceItem) => this.deleteWorkspaceByPath(w),
    fileTree: this.fileTree,
    forgetHost: () => this.forgetHost(),
    hosts: this.hosts,
    hubAuthority: this.hubAuthority,
    hubConnected: this.hubConnected,
    hubError: this.hubError,
    hubPhase: this.hubPhase,
    hubStreams: this.hubStreams,
    hubTraceTail: () => this.hubTraceTail(),
    localItemOf: (key: string) => this.localItemOf(key),
    localized: (id: Resource) => this.localized(id),
    mode: this.mode,
    models: this.models,
    noticeText: (n: ActionNotice) => this.noticeText(n),
    onCoreAction: (id: string) => this.onCoreAction(id),
    onCoreSelectVersion: (version: string) => this.onCoreSelectVersion(version),
    onResetPluginRows: () => this.onResetPluginRows(),
    onTogglePlugin: (id: string, disabled: boolean) => this.onTogglePlugin(id, disabled),
    openCredentialSheet: (ref: string) => this.openCredentialSheet(ref),
    openDiagnostics: () => this.openDiagnostics(),
    openFile: (node: FileNode) => this.openFile(node),
    openFolderPicker: () => this.openFolderPicker(),
    openSession: (id: string) => this.openSession(id),
    openStructSettingSheet: (item: SettingItem) => this.openStructSettingSheet(item),
    openTextSettingSheet: (item: SettingItem) => this.openTextSettingSheet(item),
    openPiAiSheet: (mode: string, route: string) => this.openPiAiSheet(mode, route),
    piAiProviders: this.piAiProviders,
    openWorkspaceFiles: (w: WorkspaceItem) => this.openWorkspaceFiles(w),
    pending: this.pending,
    pendingWorkspacePick: this.pendingWorkspacePick,
    setPendingWorkspacePick: (value: boolean) => {
      this.pendingWorkspacePick = value;
    },
    permissionCurrent: this.permissionCurrent,
    permissionOptions: this.permissionOptions,
    plugins: this.plugins,
    presetNote: this.presetNote,
    presets: this.presets,
    preview: this.preview,
    registryIdOf: (w: WorkspaceItem) => this.registryIdOf(w),
    resetSetting: (key: string) => this.resetSetting(key),
    selectedSessionId: this.selectedSessionId,
    selection: this.selection,
    sessionForWorkspace: (workspaceId: string) => this.sessionForWorkspace(workspaceId),
    sessionsOf: (w: WorkspaceItem) => this.sessionsOf(w),
    settingItemOf: (key: string) => this.settingItemOf(key),
    settingWriteNote: this.settingWriteNote,
    settingWriteDomain: this.settingsWriteDomain,
    setSettingWriteNote: (value: string) => {
      this.settingWriteNote = value;
    },
    settings: this.settings,
    skillNote: this.skillNote,
    skills: this.skills,
    stackPage: this.stackPage,
    setStackPage: (value: StackPage) => {
      this.stackPage = value;
    },
    toggleDirectory: (path: string) => this.toggleDirectory(path),
    treeEmptyHint: this.treeEmptyHint,
    setTreeEmptyHint: (value: string) => {
      this.treeEmptyHint = value;
    },
    treeEmptyTitle: this.treeEmptyTitle,
    setTreeEmptyTitle: (value: string) => {
      this.treeEmptyTitle = value;
    },
    workspaces: this.workspaces,
    writeSetting: (key: string, value: Object, label: string) => this.writeSetting(key, value, label),
    wsDrill: this.wsDrill,
    setWsDrill: (value: number) => {
      this.wsDrill = value;
    },
    };
    return facade;
  }

}

/** 用 display 推导初始窗口宽度（vp）；失败时给一个安全的手机宽度 */
function initialWidthVp(): number {
  try {
    const d: display.Display = display.getPrimaryDisplaySync();
    return px2vp(d.width);
  } catch (error) {
    return 400;
  }
}

/** 初始窗口高度（vp）。与 initialWidthVp 同款：读不到就给一个安全默认值 */
function initialHeightVp(): number {
  try {
    const d: display.Display = display.getPrimaryDisplaySync();
    return px2vp(d.height);
  } catch (error) {
    return 800;
  }
}

/**
 * 把「地址」与「令牌」两个输入合成一个启动链接。
 *
 * 为什么需要它：`ConnectPane` 给用户两个输入框（地址 / 令牌），而连接层的
 * `configure()` 只接受**一个**启动链接（token 由它从链接里解析）。
 * 在 UI 与连接层之间做这个合成，比让连接层同时容忍两种输入形态更简单：
 * 连接层的职责是解析一种确定的形态，而不是猜测用户的意图。
 *
 * 三种输入都被正确处理：
 *   1. 只有地址            → 补 `http://` 前缀
 *   2. 地址 + 令牌         → 合成 `http://地址/?token=令牌`
 *   3. 粘贴的完整启动链接   → 原样返回（已含 token，不重复拼接）
 */
/**
 * 从「启动 URL」里剥出可用于存储的 base URL（**去掉凭据部分**）。
 *
 * 【为什么必须剥掉 query / fragment】用户粘贴的是
 * `http://127.0.0.1:3111/?token=xxxx`，而 `token=` 是**凭据**（D2 §2.1：
 * 持有它就等于持有 Host 的完整会话权限）。把整串地址直接当 `baseUrl` 存进
 * 明文 `preferences`，等于把 token 落到明文——D1 §6.4 明确禁止。
 *
 * 实测踩到过：真机连上后 `preferences` 里存的就是带 token 的整串。
 * 这条路径上还有一个连环故障：token 别名是按 `baseUrl` 算的，存进去的
 * 却是带 query 的地址，于是「保存 token」与「读取 token」用了**两个不同的别名**，
 * 表现为下次启动读不到 token（状态 `absent`），自动重连永远不工作。
 *
 * 因此：**存储只保留 scheme://authority**，凭据一律不进这条路径
 * （token 单独走加密存储）。
 */
function storageBaseUrl(url: string): string {
  const cut: number = url.search(/[?#]/);
  return cut < 0 ? url : url.substring(0, cut);
}

function composeHostUrl(address: string, token: string): string {
  let url: string = address.trim();
  if (url.length === 0) {
    return '';
  }
  if (url.indexOf('://') < 0) {
    url = `http://${url}`;
  }
  const trimmedToken: string = token.trim();
  if (trimmedToken.length === 0 || url.indexOf('token=') >= 0) {
    return url;
  }
  return url.indexOf('?') >= 0 ? `${url}&token=${trimmedToken}` : `${url}/?token=${trimmedToken}`;
}
