/**
 * 面板注册表（P0-3：`PanelRegistry`）。
 *
 * ## 要解决的问题
 *
 * 现在"右侧显示什么"是 `DetailPane` 里的一串 `if`，而"主区显示哪个页面"由 `NavTab`
 * 决定、`Index.ets` 直接装配 Pane。两者合起来意味着：**谁拥有哪个界面**这件事没有被表达出来，
 * 于是每加一个面板就要改一遍大装配器。
 *
 * 官方 `ui-layout` 的做法是「面板选择 + 注册表」：sidebar / main / rightbar 是三条轨道，
 * 每条轨道显示哪个面板由 `selectedPanel` 查注册表得到，**面板自己声明它属于哪条轨道**。
 * 本文件把这件事落成纯逻辑：**位置（location）是面板的属性，不是页面的 if 分支**。
 *
 * ## 语义边界（照官方语义，不机械抄 API）
 *
 * | 语义 | 本文件如何表达 |
 * |---|---|
 * | 面板属于哪条轨道 | `PanelDescriptor.location`（SIDEBAR / MAIN / RIGHTBAR） |
 * | 谁拥有它 | 注册时给出 `owner`（"workspace"/"settings"/"conversation"…）；**同一轨道同一 owner 的面板互斥** |
 * | 出现顺序 | `order`（升序；相等时按 id 稳定排序，避免依赖注册顺序） |
 * | 能不能用 | `available()` 谓词：**不可用的面板不出现在选择集里**，而不是"选得中但打不开" |
 * | 选中 | `select(location, id)`：**只接受该轨道里可用的面板**，否则保持原值（不做静默回退到第一个） |
 *
 * 【为什么不做"静默回退"】回退会让"我点了 A 却显示 B"变成常态，而且不报错。
 * 官方那侧同样要求面板必须存在/可用才能选中。故 `select` 失败时返回**原状态**，
 * 由调用方决定是否改选（例如 `firstAvailable()`）。
 */

/** 一条轨道（官方把 sidebar / main / rightbar 看作独立结构，而不是一个页面里的几个区块） */
export enum PanelLocation {
  /**
   * 设置域内部的二级分区（General / Models / Plugins / Plugin Inventory …）。
   *
   * 【为什么它也算一种"位置"】设置页的切换器与侧栏/右栏的切换器是**同一件事**：
   * "一组可选面板 + 排序 + 可用性"。放进注册表之后，三处共用一套机制
   * （`descriptors(location)` / `canSelect` / `firstAvailable`），不必各写一套。
   */
  SETTINGS = 'settings',
  SIDEBAR = 'sidebar',
  MAIN = 'main',
  RIGHTBAR = 'rightbar',
}

/**
 * 面板描述。
 *
 * `label` 只给**默认值**：视图可以按设备改写呈现（四形态共享信息架构，
 * 允许几何/呈现不同），但 `id`/`location`/`owner` 是语义，不能改。
 */
export interface PanelDescriptor {
  id: string;
  location: PanelLocation;
  /** 哪一部分拥有它（互斥组）：例如 SIDEBAR 下的 "workspace" 与 "settings" */
  owner: string;
  /**
   * 面板名（默认值；视图可按设备改写文案）。
   *
   * 【为什么没有 `icon`】图标是**编译期资源**（`$r('sys.symbol.…')` 只能字面量），
   * 而模型不能持有 `Resource`。第一版这里放过一个字符串名字段，但它**没有任何消费者**
   * （视图没法把字符串变 `$r`）——留着就是空 API，故删除。图标映射放在
   * `appstate/ui` 的编译期函数里：**P1-4 已补上"面板 id → 符号"的 `sidebarPanelSymbol`**
   * （同时把 `navTabSymbol` / `navTabLabelRes` 那两张按 `NavTab` 取的表删掉了——
   * 侧栏入口现在由注册表决定，视图只按 id 取图标与文案）。
   */
  label: string;
  order: number;
  /** 是否可用（默认 true）。不可用的面板不进选择集 */
  available: () => boolean;
}

/** 注册表快照（纯数据，便于测试与传递） */
export interface PanelList {
  location: PanelLocation;
  panels: PanelDescriptor[];
}

export function emptyPanelList(location: PanelLocation): PanelList {
  return { location: location, panels: [] };
}

/**
 * 面板注册表。
 *
 * 【为什么是类而不是纯函数】注册表**有状态**（注册顺序、已注册集合），
 * 但它的每个操作都是确定的、不碰 UI、不碰协议 ⇒ 仍可在本机直接测。
 * 视图只读 `descriptors()` 与 `find()`，不自己维护名单。
 */
export class PanelRegistry {
  private items: PanelDescriptor[] = [];

  /** 注册一个面板。**同 id 重复注册会被拒绝**（返回 false），而不是静默覆盖 */
  register(descriptor: PanelDescriptor): boolean {
    if (descriptor.id.length === 0) {
      return false;
    }
    if (this.find(descriptor.id) !== undefined) {
      return false;
    }
    this.items.push(descriptor);
    return true;
  }

  /** 注销（面板随能力消失时用，例如某个插件被禁用） */
  unregister(id: string): boolean {
    for (let i = 0; i < this.items.length; i++) {
      if (this.items[i].id === id) {
        this.items.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  find(id: string): PanelDescriptor | undefined {
    for (let i = 0; i < this.items.length; i++) {
      if (this.items[i].id === id) {
        return this.items[i];
      }
    }
    return undefined;
  }

  /**
   * 某条轨道里**可用**的面板，按 `order` 升序、同序按 id 稳定排序。
   *
   * 【为什么不按注册顺序】注册顺序取决于插件装配次序，不同设备/不同版本都可能不同，
   * 于是同一条侧栏在不同机器上顺序不一样——排序必须由 `order` + `id` 决定。
   */
  descriptors(location: PanelLocation): PanelDescriptor[] {
    const out: PanelDescriptor[] = [];
    for (let i = 0; i < this.items.length; i++) {
      const d: PanelDescriptor = this.items[i];
      if (d.location === location && d.available()) {
        out.push(d);
      }
    }
    out.sort((left: PanelDescriptor, right: PanelDescriptor): number => {
      if (left.order !== right.order) {
        return left.order - right.order;
      }
      return left.id < right.id ? -1 : (left.id > right.id ? 1 : 0);
    });
    return out;
  }

  /** 某条轨道里第一个可用面板的 id（没有任何可用面板时返回空串） */
  firstAvailable(location: PanelLocation): string {
    const list: PanelDescriptor[] = this.descriptors(location);
    return list.length > 0 ? list[0].id : '';
  }

  /**
   * 校验"这个 id 能不能被选中"。
   *
   * 【为什么要单独暴露】调用方常常需要在**改状态之前**知道能不能选
   * （例如返回键的处理、深链解析）。把判断放在这里，避免各处自己 `find()` 之后
   * 又忘了查 `available()` 与 `location`。
   */
  canSelect(location: PanelLocation, id: string): boolean {
    const d: PanelDescriptor | undefined = this.find(id);
    if (d === undefined) {
      return false;
    }
    if (d.location !== location) {
      return false;
    }
    return d.available();
  }

  /**
   * 选中：返回**应落到哪个 id**。
   *
   * - id 合法且可用 ⇒ 返回 id
   * - 否则 ⇒ 返回 `current`（**保持原状**，不静默回退到第一个）
   */
  select(location: PanelLocation, id: string, current: string): string {
    return this.canSelect(location, id) ? id : current;
  }

  /** 当前注册了多少个面板（诊断/断言用） */
  size(): number {
    return this.items.length;
  }
}

/* ───────────────────────── 内置面板清单（位置与 owner 的单一事实） ───────────────────────── */

/** 侧栏面板 id（官方 sidebar 的固定席位） */
export const PANEL_SIDEBAR_WORKSPACES: string = 'sidebar.workspaces';
export const PANEL_SIDEBAR_CORE: string = 'sidebar.core';
export const PANEL_SIDEBAR_SETTINGS: string = 'sidebar.settings';

/**
 * 右栏"详情"面板（本仓当前**唯一有内容**的右栏面板：投影好的 sections 清单）。
 *
 * 【为什么它不在官方的六个候选里】官方右栏的候选是"文件 / 轨迹 / 工具 / 子代理 / 交付物 / 预览"
 * （内容都是**原始素材**），我们的"sections"是**已经投影好的摘要行**——它更像官方的
 * `conversation.detail`，而不是那六个。与其把一个摘要清单硬塞进"文件"这个 id 下（名字骗人），
 * 不如如实登记成第七个面板。它同时也说明：右栏要真正对齐官方，缺的是**六个面板的内容视图**，
 * 而不是"面板体系"本身。
 */
export const PANEL_RIGHT_DETAIL: string = 'right.detail';

/**
 * 设置域的分区（P4-1）。
 *
 * 【官方四段 + 本仓特有四项】官方 `ui-settings` 的分区是
 * **General / Models / Plugins / Plugin Inventory**（矩阵 §4 的四个 id 各一行）。
 * 本仓另有四项在官方没有对应分区、但确实是"设置"（前端已有内容、且已登记在矩阵里）：
 *   · **核心**（E110：核心内容作为设置的第一段；官方没有独立核心页）
 *   · **预设**（E129：官方把 Agent 预设放在设置里管理）
 *   · **技能**（E135：`skills/list` 的呈现面）
 *   · **设备**（本机事实：权限/模态/外观等）
 * 它们排在官方四段**之后**，并在 `owner` 上标成 `'dshm'`：谁是官方对齐项、谁是端侧补充，
 * 一眼可分（不给它们编一个"官方分区名"）。
 *
 * 【为什么把"插件清单"拆成独立分区】它此前是插件段里的一个子页签（`config` / `list`）。
 * 官方把它作为**独立分区**（`settings-plugin-inventory`，只读的 Cordis Loader 清单）——
 * 只读清单与"可配置的插件卡"是两件事，拆开后各自的入口、排序与可用性都能被注册表统一管。
 */
export function settingsSections(): PanelDescriptor[] {
  return [
    { id: 'settings.general', location: PanelLocation.SETTINGS, owner: 'settings',
      label: '通用', order: 10, available: () => true },
    { id: 'settings.models', location: PanelLocation.SETTINGS, owner: 'settings',
      label: '模型', order: 20, available: () => true },
    { id: 'settings.plugins', location: PanelLocation.SETTINGS, owner: 'settings',
      label: '插件', order: 30, available: () => true },
    { id: 'settings.plugin-inventory', location: PanelLocation.SETTINGS, owner: 'settings',
      label: '插件清单', order: 40, available: () => true },
    { id: 'settings.core', location: PanelLocation.SETTINGS, owner: 'dshm',
      label: '核心', order: 50, available: () => true },
    { id: 'settings.presets', location: PanelLocation.SETTINGS, owner: 'dshm',
      label: '预设', order: 60, available: () => true },
    { id: 'settings.skills', location: PanelLocation.SETTINGS, owner: 'dshm',
      label: '技能', order: 70, available: () => true },
    { id: 'settings.device', location: PanelLocation.SETTINGS, owner: 'dshm',
      label: '设备', order: 80, available: () => true },
  ];
}

/** 右栏面板 id（官方右栏的六个候选） */
export const PANEL_RIGHT_FILES: string = 'right.files';
export const PANEL_RIGHT_PREVIEW: string = 'right.preview';
export const PANEL_RIGHT_TRAJECTORY: string = 'right.trajectory';
export const PANEL_RIGHT_TOOL: string = 'right.tool';
export const PANEL_RIGHT_SUBAGENT: string = 'right.subagent';
export const PANEL_RIGHT_DELIVERABLES: string = 'right.deliverables';

/**
 * `order ≥ 此值` 的侧栏面板**沉到底部**（官方把 Settings 固定在底部，不随面板清单浮动）。
 *
 * 【为什么用 order 而不是"视图里 if 一下 settings"】"哪些入口沉底"是**清单的属性**，
 * 不是渲染时的特例；写成 order 之后，将来若有第二个"沉底项"（例如账户），不必再改视图。
 */
export const SIDEBAR_PINNED_ORDER: number = 900;

/**
 * 侧栏的固定席位。
 *
 * `owner` 都用各自的域："workspace" / "core" / "settings"——侧栏不是"三个同级页签"，
 * 而是**不同域在侧栏里的入口**（`ui-workspace` 填 `sidebar.workspaces`、
 * `ui-settings` 填 `sidebar.settings`）。
 *
 * 【核心为什么 `available: () => false`】E110 已定的产品语义：核心不是独立一级，
 * 而是"这台设备上 DSH 怎么跑"的配置，内容作为设置页的第一个分区呈现（真机截图核对过）。
 * 席位仍登记在这里，是为了**把这条语义写在模型里**（而不是靠视图"恰好没遍历它"）——
 * 谁改 `available` 都会当场改掉侧栏，而不是改出一个"点了没反应"的入口。
 */
export function sidebarPanels(): PanelDescriptor[] {
  return [
    { id: PANEL_SIDEBAR_WORKSPACES, location: PanelLocation.SIDEBAR, owner: 'workspace',
      label: '工作区', order: 10, available: () => true },
    { id: PANEL_SIDEBAR_CORE, location: PanelLocation.SIDEBAR, owner: 'core',
      label: '核心', order: 20, available: () => false },
    // order 很大 ⇒ 始终排在末尾（官方把 Settings 固定在底部）
    { id: PANEL_SIDEBAR_SETTINGS, location: PanelLocation.SIDEBAR, owner: 'settings',
      label: '设置', order: SIDEBAR_PINNED_ORDER, available: () => true },
  ];
}

/**
 * 侧栏里**不沉底**的入口（主入口清单，按 `order`）。
 *
 * 【为什么视图不自己遍历 + 过滤】"哪些算主入口、哪些沉底"是清单的属性；放在这里，
 * 视图（`SidebarShell`）就只负责画，且这条规则能被 fixture 直接测。
 */
export function sidebarEntries(registry: PanelRegistry): PanelDescriptor[] {
  const out: PanelDescriptor[] = [];
  const all: PanelDescriptor[] = registry.descriptors(PanelLocation.SIDEBAR);
  for (let i = 0; i < all.length; i++) {
    if (all[i].order < SIDEBAR_PINNED_ORDER) {
      out.push(all[i]);
    }
  }
  return out;
}

/** 侧栏里**沉底**的入口（设置等；官方把它固定在底部，不随面板清单浮动） */
export function sidebarPinnedEntries(registry: PanelRegistry): PanelDescriptor[] {
  const out: PanelDescriptor[] = [];
  const all: PanelDescriptor[] = registry.descriptors(PanelLocation.SIDEBAR);
  for (let i = 0; i < all.length; i++) {
    if (all[i].order >= SIDEBAR_PINNED_ORDER) {
      out.push(all[i]);
    }
  }
  return out;
}

/**
 * 右栏候选面板。
 *
 * 【`available` 就是"有没有内容"】例如没有交付物时"交付物"面板不该出现在选择集里——
 * 这比"选得中但打开是空的"诚实。默认全可用，由装配方按实际能力改写。
 */
export function rightbarPanels(): PanelDescriptor[] {
  return [
    // 唯一有内容的面板（sections 清单）；order 最小 ⇒ 它是默认面板
    { id: PANEL_RIGHT_DETAIL, location: PanelLocation.RIGHTBAR, owner: 'conversation',
      label: '详情', order: 5, available: () => true },
    /*
     * 至此官方右栏的六个候选**全部接上**（文件 / 预览 / 交付物 / 子代理 / 工具 / 轨迹）。
     * 右栏的面板体系（注册表 → 选择 → 切换器 → 各面板内容）到此完整。
     *
     * 【为什么不先"可选"再补内容】按 E110 的口径：不能填的入口不进选择集。
     * 若让它们可选，用户点进去会看到一个空面板——那比"暂时少一个入口"糟得多。
     * 内容视图一旦落地（P3 后续），把这里的断言改成 `true` 即可，**面板体系本身不用动**。
     */
    // 「文件」在 P3-3 接上：呈现用 `FileTreePane`（与工作区页签**同一份**）⇒ 可用
    { id: PANEL_RIGHT_FILES, location: PanelLocation.RIGHTBAR, owner: 'workspace',
      label: '文件', order: 10, available: () => true },
    // 「轨迹」在 P3-6 接上：右栏只放**时间总览**（`TimelineOverview`）——
    // 官方右栏的 trajectory 是"当前回合的过程"，而本仓 `TrajectoryItem` 没有回合字段，
    // 没有"回合作用域的过程列表"这个概念 ⇒ **宁可只放总览，也不把主区那份全量台账在 320vp 里照抄**
    { id: PANEL_RIGHT_TRAJECTORY, location: PanelLocation.RIGHTBAR, owner: 'conversation',
      label: '轨迹', order: 20, available: () => true },
    // 「工具」在 P3-5 接上：呈现用 `ToolCard`（与会话过程流里那张卡**同一份**）⇒ 可用
    { id: PANEL_RIGHT_TOOL, location: PanelLocation.RIGHTBAR, owner: 'conversation',
      label: '工具', order: 30, available: () => true },
    // 「子代理」在 P3-5 接上：呈现用 `SubagentCard`（与会话过程流里那张卡**同一份**）⇒ 可用
    { id: PANEL_RIGHT_SUBAGENT, location: PanelLocation.RIGHTBAR, owner: 'conversation',
      label: '子代理', order: 40, available: () => true },
    // 「交付物」在 P3-4 接上：呈现用 `DeliverableCard`（与会话过程流里那张卡**同一份**）⇒ 可用
    { id: PANEL_RIGHT_DELIVERABLES, location: PanelLocation.RIGHTBAR, owner: 'conversation',
      label: '交付物', order: 50, available: () => true },
    // 「预览」在 P3-2 接上：呈现用 `FilePreviewPane`（与工作区页签**同一份**），故可用
    { id: PANEL_RIGHT_PREVIEW, location: PanelLocation.RIGHTBAR, owner: 'workspace',
      label: '预览', order: 60, available: () => true },
  ];
}

/**
 * 按内置清单建一个可用注册表（装配方在启动时调用一次）。
 *
 * 三条轨道的清单分别由各自的工厂给（`mainPanels` 在 `NavigationState` 里，
 * 因为它同时定义主区面板 id 的语义），注册表本身不关心有哪些面板。
 */
export function createPanelRegistry(mainPanels: PanelDescriptor[]): PanelRegistry {
  const registry: PanelRegistry = new PanelRegistry();
  for (let i = 0; i < mainPanels.length; i++) {
    registry.register(mainPanels[i]);
  }
  const side: PanelDescriptor[] = sidebarPanels();
  for (let i = 0; i < side.length; i++) {
    registry.register(side[i]);
  }
  const right: PanelDescriptor[] = rightbarPanels();
  for (let i = 0; i < right.length; i++) {
    registry.register(right[i]);
  }
  const sections: PanelDescriptor[] = settingsSections();
  for (let i = 0; i < sections.length; i++) {
    registry.register(sections[i]);
  }
  return registry;
}
