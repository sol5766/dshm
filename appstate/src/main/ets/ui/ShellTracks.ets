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
import { Sz } from './Tokens';

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
 * 侧栏展开状态的**取值规则**（P2-17；P5-2 修订为按形态给默认）。
 *
 * 【为什么不能是一个常数 `true`】`shellTracksOf` 说双栏的侧栏是 rail、三栏才是 panel ——
 * "没存过"若一律读成展开，双栏首启就变成 240vp 的完整面板，与四形态 fixture 里登记的
 * `nav: 'rail'` 直接矛盾（也把 600vp 窗口的主区挤到 360vp）。P2-17 当时只写了
 * `undefined ⇒ true`，P5-2 让它跟随形态。
 *
 * 【为什么这个三态判断要放在纯模型里】偏好层（`LocalPrefs`）只回答"有没有存过"，
 * 返回 `boolean | undefined`；"没存过时用什么"是**产品语义**。放在这里的好处是
 * 它可以被 fixture 直接钉住，而不必依赖真机上的 preferences。
 */
export function sidebarExpandedForMode(mode: LayoutMode, stored: boolean | undefined): boolean {
  if (stored !== undefined) {
    return stored;
  }
  return mode !== LayoutMode.DOUBLE;
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
