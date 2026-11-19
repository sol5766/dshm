/**
 * 三条轨道在四形态下**怎么呈现**（P0：AppFrame 的几何层）。
 *
 * 【为什么单独一个文件、放在 ui 层】它回答的是几何/呈现问题（与 `LayoutController` 的
 * `detailPresentation` 同族），**不是**导航问题：导航状态关心"选中了哪个面板"，
 * 这里关心"这条轨道摆在哪"。分开之后，`NavigationState` 不必依赖 `LayoutMode`——
 * 这也让两个模型各自都能在最扁平的编译环境里被测（门禁会把纯逻辑文件摊平到一个目录，
 * 跨目录相对路径会解析不了；这条约束反过来帮我们把分层的边界划清了）。
 *
 * 【最要紧的一条语义】这里**只**回答"轨道怎么摆"，**绝不**回答"这个形态要显示哪些栏目"。
 * 后者若随设备变，四形态就成了四套 UI——而官方 `ui-layout` 是同一套 AppFrame +
 * 面板选择跨设备，变的只有几何与呈现。
 */

import { LayoutMode } from './Breakpoints';
import { Sz } from 'platform';

/** 某形态下各条轨道如何呈现 */
export enum TrackPresentation {
  /** 不占位（收进抽屉或浮层） */
  HIDDEN = 'hidden',
  /** 收窄的图标条 */
  RAIL = 'rail',
  /** 完整面板 */
  PANEL = 'panel',
  /** 并排的栏 */
  COLUMN = 'column',
  /** 浮层（Sheet / 侧边浅层面板） */
  OVERLAY = 'overlay',
}

export interface ShellTracks {
  sidebar: TrackPresentation;
  main: TrackPresentation;
  rightbar: TrackPresentation;
}

/**
 * 形态 → 三条轨道的呈现。
 *
 * - 单栏（手机）：侧栏与右栏都是浮层，主区全屏
 * - 双栏（平板竖屏 / 手机横屏 / 2in1 拖窄）：侧栏收成 rail；右栏是**侧边浅层面板**
 *   （与 `LayoutController` 的 `detailPresentation` 语义一致：不并排但可以看到）
 * - 三栏：三条轨道都在
 */
export function shellTracksOf(mode: LayoutMode): ShellTracks {
  if (mode === LayoutMode.SINGLE) {
    return { sidebar: TrackPresentation.OVERLAY, main: TrackPresentation.COLUMN,
      rightbar: TrackPresentation.OVERLAY };
  }
  if (mode === LayoutMode.DOUBLE) {
    return { sidebar: TrackPresentation.RAIL, main: TrackPresentation.COLUMN,
      rightbar: TrackPresentation.OVERLAY };
  }
  return { sidebar: TrackPresentation.PANEL, main: TrackPresentation.COLUMN,
    rightbar: TrackPresentation.COLUMN };
}

/**
 * 侧栏**实际**用哪种呈现：形态给默认，用户的"展开 / 收起"给偏好。
 *
 * ## 为什么需要它（这个字段此前没有控制点）
 *
 * `NavigationState.sidebarExpanded` 早就存在（初始 `true`、`copyOf` 会拷、还有
 * `setSidebarExpanded`），但**没有任何消费者**：侧栏呈现完全由形态决定
 * （`shellTracksOf(mode)`）。于是官方 AppFrame 那个"收起侧栏腾出宽度"的动作在本仓**做不到** ——
 * 三栏窄窗口下想多看主区一点，没有任何办法（这是一个功能缺口，不是一个状态字段的冗余）。
 *
 * ## 规则（两条，都很保守）
 *
 * 1. **单栏一律浮层**：手机竖屏下"展开的侧栏"会盖住主区，用户要的是抽屉 ⇒
 *    `expanded` 在单栏下**不生效**（不是忽略用户，而是那个档位本来就没有第二个选项）。
 * 2. **其余形态跟随偏好**：双栏默认 rail，用户展开就是 PANEL；三栏默认 PANEL，
 *    收起就是 rail（腾出 184vp 给主区）。宽度不够时**不阻止**用户——`LayoutController`
 *    的档位判定已经保证了"能到这个形态就有基本空间"，而"我要不要这 184vp"是用户的判断。
 */
export function sidebarPresentationOf(mode: LayoutMode, expanded: boolean): TrackPresentation {
  if (mode === LayoutMode.SINGLE) {
    return TrackPresentation.OVERLAY;
  }
  if (expanded) {
    return TrackPresentation.PANEL;
  }
  return TrackPresentation.RAIL;
}

/**
 * 侧栏展开状态的**取值规则**。
 *
 * ⚠️ 2026-10-31 重写（docs/325）：旧规则是「没存过 ⇒ `mode !== DOUBLE`」，
 * 即双栏默认 rail、三栏默认 panel。它造成一个用户可见的硬伤：
 *
 *   平板/PC 上选了工作区 → 布局重算 → `mode` 在 DOUBLE / TRIPLE 之间跳 →
 *   侧栏**在展开与收起之间自己翻转**，而用户根本没碰那个按钮
 *   （用户原话："怎么选完工作区自己还回去了"）。
 *
 * 根因不是选工作区这个动作，而是**"形态"参与了展开与否的判定**：
 * 只要有第二个因素能决定同一件事，它就会在用户没操作时把状态改掉。
 *
 * ⇒ 全新规则，只有一个输入：
 *   · 用户**显式点过**按钮（`stored` 有值）→ 就是那个值，形态怎么变都不动它；
 *   · 从没点过 → **默认常驻展开**（PC / 平板一直显示侧栏）；
 *   · 单栏（手机）例外：那个档位没有"并排的侧栏"，呈现由 `sidebarPresentationOf`
 *     统一给 OVERLAY，本函数的返回值在那里**不参与**呈现判定（见该函数）。
 *
 * 换句话说：**展开与否只由左侧边栏那个按钮决定**，形态不再有能力把它收回去。
 *
 * @param mode 当前形态（保留在签名里：单栏的语义差异由 `sidebarPresentationOf` 承担，
 *             且调用方已经按 `mode` 传参，改签名会波及四处调用点而无收益）
 * @param stored 用户显式偏好；`undefined` = 从没点过
 */
export function sidebarExpandedForMode(mode: LayoutMode, stored: boolean | undefined): boolean {
  /*
   * ⚠️ 2026-10-31 第二次修（docs/330，用户第二次反馈平板侧栏仍会收起）：
   *
   * 规则本身没问题（只认显式偏好、否则常驻），但**"显式偏好"是跨启动持久化的** ——
   * 平板上只要历史上点过一次收起，`stored` 就永远是 `false`，于是每次启动都收起。
   * 用户的原话是「**不主动收起他就一直显示**」：收起应当只对**当前这次运行**有效，
   * 而不是变成一条永久设定。
   *
   * ⇒ 现在 `stored` 只在**本次运行内**有意义（见 `Index.toggleSidebarExpanded`：
   * 收起写内存、不落盘；`loadSidebarExpanded` 也不再被调用）。本函数保持纯函数形态，
   * 便于 fixture 直接钉住"任何形态 + 任何未显式收起的状态 ⇒ 展开"。
   */
  if (stored !== undefined) {
    return stored;
  }
  return true;
}

/**
 * 侧栏这条轨道**实际**占的侧向宽度（P5-2）。
 *
 * 【为什么必须有它】P2-15 让侧栏能收起、但只改了"呈现"，几何仍按**形态默认**算
 * （`LayoutDecision.navWidthVp`）：三栏收起之后轨道照样是 240vp，"腾出宽度"根本没发生；
 * 双栏收起之后是 240vp 的轨道里放一条 56vp 的 rail（右边空出 184vp 的底色）。
 * 判定收在这里，页面**只读结论**，不再自己按形态拼宽度。
 *
 * OVERLAY（单栏抽屉 / 底部标签）返回 0：那条轨道不占侧边宽度（底部标签占的是高度）。
 */
export function sidebarTrackWidthOf(mode: LayoutMode, stored: boolean | undefined): number {
  const presentation: TrackPresentation =
    sidebarPresentationOf(mode, sidebarExpandedForMode(mode, stored));
  if (presentation === TrackPresentation.PANEL) {
    return Sz.NAV_PANEL;
  }
  if (presentation === TrackPresentation.RAIL) {
    return Sz.NAV_RAIL;
  }
  return 0;
}
