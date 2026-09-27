/**
 * 布局决策（P1：把「形态/几何」决策从 `Index.ets` 里搬出来）。
 *
 * 【为什么要有这个文件】`Index.ets` 有 4613 行，其中一类职责是**形态决策**：
 * 窗口宽度 → 档位（单/双/三栏）；档位 → 导航怎么呈现；空间不足 → 先让哪一块。
 * 这类判断是**纯函数**（输入是宽度/高度/输入模态，输出是几何），却和 ArkUI 的
 * 渲染代码缠在一起，于是既没法单独测试、也没法复用。
 *
 * 【与既有分层的关系】不重复实现已有能力：
 *   - 档位判定仍用 `Breakpoints.layoutModeOf`（D3 §2.2 的硬规则：顶层只看**窗口**宽度）；
 *   - 导航呈现方式仍用 `Breakpoints.navPresentation`——**这个函数此前只有定义与桶导出、
 *     没有任何调用点**（P0 矩阵登记的「登记了没接」）。本文件是它第一个真实消费者。
 *   - 尺寸/阈值仍取自 `Tokens`（`Sz` / `Breakpoint`），不在这里写魔数。
 *
 * 【今天不改变任何行为】`decideLayout` 在现有断点配置下的输出与 `Index.ets` 现有判断**逐项相同**
 * （见 `tools/check-layout-fixtures.mjs` 的 fixture 断言）。让步链里当前不可达的那一步也如实标注，
 * 不用「假分支」充数。
 *
 * 【可测性】本文件是**纯 TypeScript**（不含 ArkUI 装饰器/DSL），因此
 * `tools/check-layout-fixtures.mjs` 能用 CLT 自带的 tsc 编译它并**在本机直接执行**——
 * 无需真机、无需模拟器就能测四形态与断点边界（计划 §16/§17 的 layout fixture）。
 */

import { Breakpoint, Sz } from './Tokens';
import {
  detailPanelAvailable,
  LayoutMode,
  layoutModeOf,
  NavPresentation,
  navPresentation
} from './Breakpoints';

/**
 * 布局输入：只放**决策真正需要**的事实。
 *
 * 刻意不收 `deviceType`：D3 §2.2 的硬规则是「顶层形态只用窗口断点」，
 * 设备类型只用于门控系统能力（文件选择器、快捷键提示），不参与几何决策。
 * 收进来会让"手机横屏"这类场景被错误地当成桌面处理。
 */
export interface LayoutInput {
  /** 窗口宽度（vp） */
  widthVp: number;
  /** 窗口高度（vp） */
  heightVp: number;
  /** 是否存在物理/外接键盘（决定快捷键提示、hover 语义） */
  hasKeyboard: boolean;
  /** 是否存在指针设备（鼠标/触控笔：决定 hover 与右键菜单可用性） */
  hasPointer: boolean;
}

/** 详情栏让到了哪一步（D3 §2.1 的让步链，顺序即优先级） */
export enum ConcessionStep {
  /** 想要的宽度放得下 */
  NONE = 'none',
  /** 收窄到 `Sz.DETAIL_MIN` */
  DETAIL_NARROW = 'detail-narrow',
  /** 放不下：关闭详情栏（不保留占位） */
  DETAIL_CLOSED = 'detail-closed'
}

/** 由宽度与导航宽度推出的详情栏容量 */
export interface DetailCapacity {
  widthVp: number;
  step: ConcessionStep;
}

/**
 * 主内容区的最小宽度（vp）。
 *
 * 【这个数从哪来】不是拍的：三栏档位下限 `Breakpoint.LG = 840`、
 * 导航面板 `Sz.NAV_PANEL = 240`、详情栏默认 `Sz.DETAIL_PANEL = 320`，
 * 于是 840 − 240 − 320 = **280** 正是**当前配置下已经接受的最小主区宽度**。
 * 取它作为下限，`decideLayout` 才能在**不改变现有行为**的前提下把让步链表达出来
 * （若拍一个更大的值，840vp 窗口的详情栏会突然被判定为"放不下"而自动关闭——那是行为变更，
 * 得单独走设备验收，不能塞进重构里）。
 */
export const MAIN_MIN_VP: number = 280;

/** 完整的布局决策（渲染层只读它，不再自己算） */
/**
 * 详情在某个档位下**怎么呈现**（P3 §12：四形态各自的详情呈现方式）。
 *
 * 【为什么把它做成三值而不是一个布尔】此前这里是一个 `detailOverlay: boolean`，
 * 语义只覆盖了"单栏下详情不是并排的栏"，**而且没有任何消费点**（视图用自己的 `sheetKind()` 判断）。
 * 于是双栏（平板 / 手机横屏）实际上和手机一样弹**半模态 Sheet** —— 而计划 §12 要求平板是
 * "侧边浅层面板"。一个布尔表达不了三种呈现，把它换成枚举，并且**真的被视图消费**。
 */
export enum DetailPresentation {
  /** 三栏：真右栏，与主内容并排、不遮内容（宽度由一个槽位决定） */
  COLUMN = 'column',
  /** 双栏（平板 / 手机横屏）：**侧边浅层面板**——压在内容右缘，不占布局宽度、不挡住列表 */
  SIDE_PANEL = 'side-panel',
  /** 单栏（手机竖屏）：整页下钻 / 半模态——详情是一次"进入"，因为并排放不下 */
  OVERLAY = 'overlay',
}

/**
 * 档位 → 详情呈现方式。
 *
 * `DOUBLE` 之所以给侧边浅层面板：600–839vp 放不下"列表 + 真右栏"，但**足够宽**到让详情
 * 与列表同时可见；用半模态 Sheet 会把列表整个盖住，"边看列表边看详情"这件事就没了。
 */
export function detailPresentationOf(mode: LayoutMode): DetailPresentation {
  if (mode === LayoutMode.TRIPLE) {
    return DetailPresentation.COLUMN;
  }
  if (mode === LayoutMode.DOUBLE) {
    return DetailPresentation.SIDE_PANEL;
  }
  return DetailPresentation.OVERLAY;
}

export interface LayoutDecision {
  /** 单/双/三栏 */
  mode: LayoutMode;
  /** 导航呈现方式：底部标签栏 / 图标条 / 完整面板 */
  nav: NavPresentation;
  /** 导航占用的侧向宽度（底部标签栏为 0，因为它不占侧边） */
  navWidthVp: number;
  /** 是否显示导航文字标签（图标条下不显示） */
  navLabels: boolean;
  /** 详情栏可用性（false 时不并排、不占位） */
  detailAvailable: boolean;
  /** 详情栏宽度（available 为 false 时为 0） */
  detailWidthVp: number;
  /**
   * 详情怎么呈现（三栏 = 真右栏 / 双栏 = 侧边浅层面板 / 单栏 = 整页）。
   *
   * 取代了此前那个**没有任何消费点**的 `detailOverlay: boolean`。
   */
  detailPresentation: DetailPresentation;
  /** 详情让步到了哪一步 */
  detailStep: ConcessionStep;
  /** 横屏（宽 > 高） */
  landscape: boolean;
  /** 键鼠齐备（P3 的 hover / 右键 / 快捷键提示据此启用） */
  pointerRich: boolean;
}

/**
 * 让步链的**唯一判定点**（D3 §2.1：详情栏收窄 → 详情栏关闭）。
 *
 * 抽成独立纯函数的原因有两个：
 *   1. 拖拽调宽（P2 的右栏）要对**用户想要的宽度**反复求值，逻辑必须与"默认宽度"解耦；
 *   2. 它的三个分支必须能被直接测——否则最坏的那一支（关闭）永远没人验证。
 *
 * 【如实标注】在当前断点配置下（LG=840、NAV_PANEL=240、MAIN_MIN=280），
 * 三栏的可用空间恒 ≥ 320vp，因此 `DETAIL_CLOSED` 这一支**当前不可达**。
 * 保留它不是"假分支"：`tools/check-layout-fixtures.mjs` 会直接对 `concedeDetail`
 * 断言三个分支（含关闭），P2 接入拖拽调宽与更窄断点后它就会真正生效。
 */
/**
 * 详情栏**当前窗口下**可用的最大宽度（主内容至少留 `MAIN_MIN_VP`）。
 *
 * 【为什么单独暴露】拖拽时必须在这里夹住用户拖出来的值。否则会出现很难看的跳变：
 * 用户往宽拖、超过了可用空间 ⇒ 让步链判定"想要的大于可用"⇒ 直接缩到 `DETAIL_MIN`
 * （往右拖一点，栏反而猛地变窄）。夹在可用空间以内，让步链只在**窗口变小**时才需要介入。
 */
export function detailRoomOf(widthVp: number, navWidthVp: number): number {
  return widthVp - navWidthVp - MAIN_MIN_VP;
}

/**
 * 把"想要的详情栏宽度"夹进合法区间 `[DETAIL_MIN, room]`。
 *
 * `room < DETAIL_MIN` 时返回 `DETAIL_MIN`：此时栏本来就该被让步链关掉，
 * 这里不再制造一个更小的值（那会让记忆里存下一个不可能成立的宽度）。
 */
export function clampDetailDesired(desiredVp: number, roomVp: number): number {
  const upper: number = roomVp > Sz.DETAIL_MIN ? roomVp : Sz.DETAIL_MIN;
  if (!Number.isFinite(desiredVp) || desiredVp < Sz.DETAIL_MIN) {
    return Sz.DETAIL_MIN;
  }
  return desiredVp > upper ? upper : desiredVp;
}

/**
 * 拖拽一个增量后应有的详情栏宽度。
 *
 * 【方向不能弄反】把手在详情栏的**左边缘**：往左拖（`deltaXVp < 0`）是**变宽**，
 * 往右拖是变窄。故这里是 `start - deltaX` 而不是 `start + deltaX`。
 * 这个符号写反不会报错、只会让用户觉得"拖反了"，所以它必须是被测试覆盖的一行。
 */
export function dragDetailWidth(startVp: number, deltaXVp: number, roomVp: number): number {
  return clampDetailDesired(startVp - deltaXVp, roomVp);
}

/**
 * 把从偏好里读回来的记忆值收窄成可用值。
 *
 * 没有记录（`undefined`）、NaN、越界一律回到 `DETAIL_PANEL`——
 * 偏好存的是"用户可见的行为"，一个坏值不该让详情栏吃掉整屏或缩成一条缝。
 */
export function detailWidthOf(stored: number | undefined): number {
  if (stored === undefined || !Number.isFinite(stored)) {
    return Sz.DETAIL_PANEL;
  }
  if (stored < Sz.DETAIL_MIN) {
    return Sz.DETAIL_MIN;
  }
  if (stored > Sz.DETAIL_MAX) {
    return Sz.DETAIL_MAX;
  }
  return stored;
}

export function concedeDetail(widthVp: number, navWidthVp: number, desiredVp: number): DetailCapacity {
  const room: number = detailRoomOf(widthVp, navWidthVp);
  if (room < Sz.DETAIL_MIN) {
    return { widthVp: 0, step: ConcessionStep.DETAIL_CLOSED };
  }
  if (desiredVp > room) {
    return { widthVp: Sz.DETAIL_MIN, step: ConcessionStep.DETAIL_NARROW };
  }
  // 想要更窄时也不能低于最小值：再窄就不是"详情栏"而是坏掉的栏
  if (desiredVp < Sz.DETAIL_MIN) {
    return { widthVp: Sz.DETAIL_MIN, step: ConcessionStep.DETAIL_NARROW };
  }
  return { widthVp: desiredVp, step: ConcessionStep.NONE };
}

/** 导航在给定档位下占用的侧向宽度（底部标签栏不占侧边，返回 0） */
export function navWidthOf(nav: NavPresentation): number {
  if (nav === NavPresentation.PANEL) {
    return Sz.NAV_PANEL;
  }
  if (nav === NavPresentation.RAIL) {
    return Sz.NAV_RAIL;
  }
  return 0;
}

/**
 * 形态决策主入口（用**默认**详情宽度，即现有行为）。
 *
 * 返回的对象是一次决策的完整结果：渲染层只读它，不再自己判断宽度或档位——
 * 这样"什么宽度显示什么"只有一处实现，出现破版时也就只有一处要查。
 */
export function decideLayout(input: LayoutInput): LayoutDecision {
  return decideLayoutWithDetail(input, Sz.DETAIL_PANEL);
}

/**
 * 同上，但详情栏宽度由调用方给定（P2 拖拽调宽后走这里）。
 *
 * @param desiredDetailVp 期望的详情栏宽度（会被 `concedeDetail` 按可用空间收敛）
 */
export function decideLayoutWithDetail(input: LayoutInput, desiredDetailVp: number): LayoutDecision {
  const mode: LayoutMode = layoutModeOf(input.widthVp);
  const nav: NavPresentation = navPresentation(mode);
  const navWidthVp: number = navWidthOf(nav);
  const sideBySide: boolean = detailPanelAvailable(mode);

  let detailAvailable: boolean = false;
  let detailWidthVp: number = 0;
  let detailStep: ConcessionStep = ConcessionStep.NONE;
  if (sideBySide) {
    const cap: DetailCapacity = concedeDetail(input.widthVp, navWidthVp, desiredDetailVp);
    detailAvailable = cap.step !== ConcessionStep.DETAIL_CLOSED;
    detailWidthVp = cap.widthVp;
    detailStep = cap.step;
  }

  return {
    mode: mode,
    nav: nav,
    navWidthVp: navWidthVp,
    navLabels: nav === NavPresentation.PANEL,
    detailAvailable: detailAvailable,
    detailWidthVp: detailWidthVp,
    detailPresentation: detailPresentationOf(mode),
    detailStep: detailStep,
    landscape: input.widthVp > input.heightVp,
    pointerRich: input.hasKeyboard && input.hasPointer
  };
}

/** 档位阈值（供 UI 与 fixture 引用，避免各处重写 600/840） */
export function breakpointThresholds(): number[] {
  return [Breakpoint.MD, Breakpoint.LG];
}
