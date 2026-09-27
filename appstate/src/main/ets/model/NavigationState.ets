/**
 * 导航状态（P0-2：`NavigationState`）。
 *
 * ## 要解决的问题
 *
 * 现在"页面"与"右栏显示什么"是两套互不相干的机制：
 *   · 页面 = `NavTab`（`WORKSPACES / CORE / SETTINGS`，三者同级）+ `StackPage`（下钻）
 *   · 右栏 = `DetailPane` 里的一串 `if`
 * 于是**"谁拥有哪个界面"没有被表达**：`Index.ets` 直接按 `NavTab` 装配 Pane，
 * 每加一个面板就要改大装配器；而官方是「三条轨道 + 面板选择」。
 *
 * ## 关键语义：页面 ≠ 选中的面板
 *
 * 官方把 `conversation / files / trajectory / settings.general / settings.models / …`
 * 都表达为**面板**（各自带 location），而不是塞进一个 `NavTab`。本文件照此把状态拆开：
 *
 * | 字段 | 含义 |
 * |---|---|
 * | `selectedMainPanel` | 主区显示哪个面板（对话 / 工作区 / 核心 / 设置 / 诊断 / 连接） |
 * | `selectedRightPanel` | 右栏显示哪个面板（文件 / 轨迹 / 工具 / 子代理 / 交付物 / 预览） |
 * | `settingsSection` | 设置域内部的二级分区（General / Models / Plugins / Inventory） |
 * | `mobileDrawer` | 手机上侧栏是抽屉时的开合状态 |
 *
 * 【为什么"页面"还要留着】迁移是分步的：本步**只把结构表达出来，不改行为**。
 * `mainPanels()` 里暂时保留了工作区/核心/设置等面板（它们现在确实显示在主区），
 * P1 会把工作区与设置移进侧栏、P4 再拆设置域。**语义先立起来，位置再搬。**
 *
 * ## 为什么是纯函数
 *
 * "这个面板能不能选""返回键该关哪一层""这个形态下哪几条轨道可见"都是**判断**，
 * 放这里之后可在本机直接测（`tools/check-layout-fixtures.mjs`），视图只读结论。
 */

import { PanelDescriptor, PanelLocation, PanelRegistry, PANEL_RIGHT_DETAIL, PANEL_SIDEBAR_WORKSPACES, PANEL_SIDEBAR_SETTINGS, PANEL_SIDEBAR_CORE } from './PanelRegistry';

/* ───────────────────────── 主区面板 ───────────────────────── */

/** 主区面板 id */
export const MAIN_CONVERSATION: string = 'main.conversation';
export const MAIN_WORKSPACES: string = 'main.workspaces';
export const MAIN_CORE: string = 'main.core';
export const MAIN_SETTINGS: string = 'main.settings';
export const MAIN_DIAGNOSTICS: string = 'main.diagnostics';
export const MAIN_CONNECT: string = 'main.connect';

/** 设置域的二级分区 id（P4 会按此拆 `SettingsShell`） */
export const SETTINGS_GENERAL: string = 'settings.general';
export const SETTINGS_MODELS: string = 'settings.models';
export const SETTINGS_PLUGINS: string = 'settings.plugins';
export const SETTINGS_INVENTORY: string = 'settings.plugin-inventory';
/*
 * 以下四项是**本仓特有**的设置分区（官方没有对应分区，见 PanelRegistry.settingsSections 的说明）：
 * 核心（E110）、预设（E129）、技能（E135）、设备（本机事实）。
 */
export const SETTINGS_CORE: string = 'settings.core';
export const SETTINGS_PRESETS: string = 'settings.presets';
export const SETTINGS_SKILLS: string = 'settings.skills';
export const SETTINGS_DEVICE: string = 'settings.device';

/** 手机侧栏抽屉状态 */
export enum DrawerState {
  CLOSED = 'closed',
  OPEN = 'open',
}

export interface NavigationState {
  currentSessionId: string;
  currentWorkspaceId: string;
  /** 主区面板 id（见 `MAIN_*`） */
  selectedMainPanel: string;
  /** 右栏面板 id（见 `PANEL_RIGHT_*`） */
  selectedRightPanel: string;
  /** 设置域分区 id（见 `SETTINGS_*`） */
  settingsSection: string;
  mobileDrawer: DrawerState;
  /** 右栏是否正在显示（几何层已由 `LayoutController` 决定可用性） */
  detailOpen: boolean;
}

export function initialNavigationState(): NavigationState {
  return {
    currentSessionId: '',
    currentWorkspaceId: '',
    selectedMainPanel: MAIN_CONVERSATION,
    selectedRightPanel: PANEL_RIGHT_DETAIL,
    settingsSection: SETTINGS_GENERAL,
    mobileDrawer: DrawerState.CLOSED,
    detailOpen: false,
  };
}

/**
 * 显式拷贝一份状态。
 *
 * 【为什么不用 `{ ...state }`】ArkTS 对对象展开有限制（`arkts-no-spread` 一类的规则），
 * 而这里每个转移函数都要"改一个字段、其余照抄"。写一个显式拷贝函数比在每个转移里
 * 各展开一次更安全，也让"新增字段时忘了带上"这件事变成**编译错误**而不是静默丢失。
 */
export function copyOf(state: NavigationState): NavigationState {
  return {
    currentSessionId: state.currentSessionId,
    currentWorkspaceId: state.currentWorkspaceId,
    selectedMainPanel: state.selectedMainPanel,
    selectedRightPanel: state.selectedRightPanel,
    settingsSection: state.settingsSection,
    mobileDrawer: state.mobileDrawer,
    detailOpen: state.detailOpen
  };
}

/* ───────────────────────── 主区面板清单 ───────────────────────── */

/**
 * 主区面板清单。
 *
 * 【为什么把工作区/核心/设置也列在这里】它们现在**确实显示在主区**（迁移还没做）。
 * 列出它们让"当前主区在显示哪个面板"成为显式状态；P1/P4 会把它们逐个搬去侧栏，
 * 届时只改这张表与视图，不动状态结构。
 */
export function mainPanels(): PanelDescriptor[] {
  return [
    { id: MAIN_CONVERSATION, location: PanelLocation.MAIN, owner: 'conversation',
      label: '会话', order: 10, available: () => true },
    { id: MAIN_WORKSPACES, location: PanelLocation.MAIN, owner: 'workspace',
      label: '工作区', order: 20, available: () => true },
    { id: MAIN_CORE, location: PanelLocation.MAIN, owner: 'core',
      label: '核心', order: 30, available: () => true },
    { id: MAIN_SETTINGS, location: PanelLocation.MAIN, owner: 'settings',
      label: '设置', order: 40, available: () => true },
    { id: MAIN_DIAGNOSTICS, location: PanelLocation.MAIN, owner: 'diagnostics',
      label: '诊断', order: 50, available: () => true },
    { id: MAIN_CONNECT, location: PanelLocation.MAIN, owner: 'connect',
      label: '连接', order: 60, available: () => true },
  ];
}

/* ───────────────────────── 迁移桥（行为不变的保证） ───────────────────────── */

/**
 * 既有的 `NavTab` 取值 → 主区面板 id。
 *
 * 【为什么要这个桥】`NavTab` 在视图里有几十处调用点。本步的目标是**改结构不改行为**，
 * 所以不一次性重写所有调用点，而是让旧取值在这里落到新结构上：结构先立起来，
 * 调用点分后续几步迁走。桥本身有断言，保证"迁移期间不会点错页面"。
 *
 * 注意 `'conversation'`：在旧模型里它是 `StackPage`（下钻页）而不是页签，
 * 这里统一收进"主区面板"——**这正是本步要修的那件事**（页面与面板不再两套机制）。
 */
export function mainPanelOfLegacyTab(tab: string): string {
  if (tab === 'workspaces') {
    return MAIN_WORKSPACES;
  }
  if (tab === 'core') {
    return MAIN_CORE;
  }
  if (tab === 'settings') {
    return MAIN_SETTINGS;
  }
  if (tab === 'conversation') {
    return MAIN_CONVERSATION;
  }
  if (tab === 'diagnostics') {
    return MAIN_DIAGNOSTICS;
  }
  if (tab === 'connect') {
    return MAIN_CONNECT;
  }
  // 未知取值回到会话（主区的默认面板），而不是空串——空串会让主区什么都不显示
  return MAIN_CONVERSATION;
}

/**
 * 既有 `NavTab` → **侧栏面板 id**。
 *
 * 【为什么需要】侧栏要按 `PanelRegistry` 的**可用性**决定显示哪些入口（不可用的面板不该占位置），
 * 而当前侧栏仍按 `NavTab` 取值渲染（面板各自的视图还没做，见 docs/ia-parity-plan.md 的 P1）。
 * 这个映射就是两者之间的桥：注册表管"能不能用"，`NavTab` 暂时管"长什么样"。
 */
export function sidebarPanelIdOfTab(tab: string): string {
  if (tab === 'workspaces') {
    return 'sidebar.workspaces';
  }
  if (tab === 'core') {
    return 'sidebar.core';
  }
  if (tab === 'settings') {
    return 'sidebar.settings';
  }
  return 'sidebar.workspaces';
}

/** 主区面板 id → 既有的 `NavTab` 取值（供尚未迁移的调用点使用） */
export function legacyTabOfMainPanel(panelId: string): string {
  if (panelId === MAIN_WORKSPACES) {
    return 'workspaces';
  }
  if (panelId === MAIN_CORE) {
    return 'core';
  }
  if (panelId === MAIN_SETTINGS) {
    return 'settings';
  }
  return 'workspaces';
}

/** 主区面板 id → 它在侧栏里的**席位** id（没有席位时返回空串） */
export function sidebarPanelOfMainPanel(mainPanelId: string): string {
  if (mainPanelId === MAIN_WORKSPACES) {
    return PANEL_SIDEBAR_WORKSPACES;
  }
  if (mainPanelId === MAIN_SETTINGS) {
    return PANEL_SIDEBAR_SETTINGS;
  }
  if (mainPanelId === MAIN_CORE) {
    return PANEL_SIDEBAR_CORE;
  }
  // 会话 / 诊断 / 连接不是侧栏入口 ⇒ 空串（"没有哪一项该高亮"，而不是随便高亮一项）
  return '';
}

/**
 * 侧栏席位 id → 它代表的**主区面板** id（点侧栏入口时该切到哪个主区面板）。
 *
 * 【为什么未知取值回落工作区而不是空串】空串会让主区什么都不显示；
 * 宁可回到一个有内容的默认面（与 `mainPanelOfLegacyTab` 的处理一致）。
 */
export function mainPanelOfSidebarPanel(sidebarPanelId: string): string {
  if (sidebarPanelId === PANEL_SIDEBAR_SETTINGS) {
    return MAIN_SETTINGS;
  }
  if (sidebarPanelId === PANEL_SIDEBAR_CORE) {
    return MAIN_CORE;
  }
  return MAIN_WORKSPACES;
}

/**
 * **此刻主区实际在显示哪个面板**（P0-2：页面 = 选中的面板）。
 *
 * 【为什么需要它】此前这件事由**视图自己组合**出来：`stackPage`（下钻页）
 * + `showsConversation()` + 当前页签，三条线索在 `mainContent()` 里用 if 链拼出结果。
 * 组合逻辑散在视图里，就是"栏目/框架看起来不对"的滋生处——而且它**不可测**
 * （门禁跑不了 ArkUI）。
 *
 * 现在：三类线索进同一个函数，视图只按**返回的一个面板 id** 分派。
 *
 * @param stackPage 下钻页（`'main'` / `'conversation'` / `'diagnostics'` / `'connect'`）
 * @param hasSession 是否已选中会话（会话页必须有会话，否则应落回列表）
 */
export function activeMainPanelOf(nav: NavigationState, stackPage: string, hasSession: boolean): string {
  if (stackPage === 'diagnostics') {
    return MAIN_DIAGNOSTICS;
  }
  if (stackPage === 'connect') {
    return MAIN_CONNECT;
  }
  if (stackPage === 'conversation' && hasSession) {
    return MAIN_CONVERSATION;
  }
  return nav.selectedMainPanel;
}

/* ───────────────────────── 状态转移（都经注册表校验） ───────────────────────── */

/**
 * 切主区面板。
 *
 * 面板必须**在注册表里、属于 MAIN、且可用**；否则返回原状态（不静默回退）。
 * 这让"点了却到了别处"不可能发生——要么切过去，要么不动。
 */
export function navigateToMain(state: NavigationState, panelId: string,
  registry: PanelRegistry): NavigationState {
  if (!registry.canSelect(PanelLocation.MAIN, panelId)) {
    return state;
  }
  const next: NavigationState = copyOf(state);
  next.selectedMainPanel = panelId;
  // 手机抽屉是**临时导航面**：从它里面选了任何一项，它就该收起（否则用户要再点一次遮罩，
  // 而这层遮罩盖着的正是他刚选中的页面）。桌面/平板上抽屉本来就是关的 ⇒ 这一步是空操作。
  next.mobileDrawer = DrawerState.CLOSED;
  return next;
}

/** 选右栏面板（同样经注册表校验；不可用则保持原值） */
export function selectRightPanel(state: NavigationState, panelId: string,
  registry: PanelRegistry): NavigationState {
  if (!registry.canSelect(PanelLocation.RIGHTBAR, panelId)) {
    return state;
  }
  const next: NavigationState = copyOf(state);
  next.selectedRightPanel = panelId;
  return next;
}

/**
 * 进设置域的某个分区。
 *
 * 语义上"打开设置"与"设置里看哪一屏"是两件事，故这里同时把它们写清：
 * 主区面板 = 设置，分区 = 传入的分区。空分区 ⇒ 保持当前分区。
 */
export function openSettings(state: NavigationState, section: string,
  registry: PanelRegistry): NavigationState {
  const withMain: NavigationState = navigateToMain(state, MAIN_SETTINGS, registry);
  if (section.length === 0) {
    return withMain;
  }
  const next: NavigationState = copyOf(withMain);
  next.settingsSection = section;
  return next;
}

export function setDrawer(state: NavigationState, drawer: DrawerState): NavigationState {
  const next: NavigationState = copyOf(state);
  next.mobileDrawer = drawer;
  return next;
}

/**
 * 进入某个会话时**同步所有与它相关的字段**。
 *
 * 【为什么放在一处】"切会话"要同时处理：当前会话 id、主区回到会话面板、
 * 关掉手机抽屉、必要时给右栏一个可用面板。分散在各调用点写必然漏一个
 * （历史上就有"切了会话但主区还停在工作区"这类问题）。
 */
export function enterSession(state: NavigationState, sessionId: string,
  registry: PanelRegistry): NavigationState {
  const next: NavigationState = copyOf(state);
  next.currentSessionId = sessionId;
  next.selectedMainPanel = MAIN_CONVERSATION;
  next.mobileDrawer = DrawerState.CLOSED;
  if (!registry.canSelect(PanelLocation.RIGHTBAR, next.selectedRightPanel)) {
    const fallback: string = registry.firstAvailable(PanelLocation.RIGHTBAR);
    if (fallback.length > 0) {
      next.selectedRightPanel = fallback;
    }
  }
  return next;
}

/** 默认右栏面板（装配方在没有任何可用选择时兜底） */
export function defaultRightPanel(registry: PanelRegistry): string {
  const first: string = registry.firstAvailable(PanelLocation.RIGHTBAR);
  // 兜底也指向"详情"：它是当前唯一有内容的面板（见 `PANEL_RIGHT_DETAIL` 的说明）
  return first.length > 0 ? first : PANEL_RIGHT_DETAIL;
}

/** 默认侧栏面板（用于"侧栏先显示哪个域"） */
export function defaultSidebarPanel(registry: PanelRegistry): string {
  const first: string = registry.firstAvailable(PanelLocation.SIDEBAR);
  return first.length > 0 ? first : PANEL_SIDEBAR_WORKSPACES;
}
