/**
 * 窗口形态与几何的持久化（D1 §7.7.5「窗口位置/大小记忆」）。
 *
 * 边界说明（重要，避免过度承诺）：
 *   - 窗口**位置与大小**：在 2in1 自由窗口模式下，系统自身会记忆自由窗口几何，
 *     应用不应越权改写。本文件只在**主窗处于 FLOATING 状态**时尝试读取并回写几何，
 *     其余状态（全屏/分屏/最大化）一律不触碰——那些状态下的 moveWindowTo/resize
 *     语义由窗口管理器决定，强行设置会导致窗口跳到奇怪的位置。
 *   - 窗口**内部布局状态**（哪些栏展开、上次停在哪一页）：这是应用自己的状态，
 *     必须自己记住。这是本文件的主要职责。
 *
 * 存储：`preferences`（键值），不是文件——避免与凭据存储混淆（凭据走 huks）。
 */

import { window } from '@kit.ArkUI';
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/window';
const STORE: string = 'dsh_window_state';

/** 窗口几何（vp） */
export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 窗口内部布局状态。
 *
 * 用「一个字符串 + 若干布尔」而不是嵌套对象：preferences 只支持基础类型与数组，
 * 保持扁平可以免去序列化层，也便于将来加字段时向后兼容。
 */
export interface WindowLayoutState {
  /** 详情栏是否展开 */
  detailOpen: boolean;
  /** 左导航是否为常驻栏（false = 图标栏/抽屉） */
  navPinned: boolean;
  /** 上次停留的页面（MAIN / CONVERSATION / DETAIL / DIAGNOSTICS / CONNECT） */
  lastPage: string;
  /** 上次打开的会话 id（空串=无） */
  lastSessionId: string;
}

/** 安全默认值：任何读取失败都回到它，保证 UI 永远有可用状态 */
export function defaultLayoutState(): WindowLayoutState {
  return { detailOpen: true, navPinned: true, lastPage: 'MAIN', lastSessionId: '' };
}

export class WindowMemory {
  private store?: preferences.Preferences;
  private context?: common.UIAbilityContext;

  async attach(context: common.UIAbilityContext): Promise<void> {
    this.context = context;
    try {
      this.store = await preferences.getPreferences(context, STORE);
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, 'open preferences failed: %{public}s', e.message);
      this.store = undefined;
    }
  }

  /** 读取窗口布局状态（无记录或读取失败时返回默认值）。 */
  async loadLayout(key: string): Promise<WindowLayoutState> {
    const fallback: WindowLayoutState = defaultLayoutState();
    if (this.store === undefined) {
      return fallback;
    }
    try {
      const raw: string = await this.store.get(`${key}.layout`, '') as string;
      if (raw.length === 0) {
        return fallback;
      }
      const parsed: WindowLayoutState = JSON.parse(raw) as WindowLayoutState;
      // 逐字段兜底：旧版本写入的状态可能缺少新字段
      return {
        detailOpen: parsed.detailOpen === undefined ? fallback.detailOpen : parsed.detailOpen,
        navPinned: parsed.navPinned === undefined ? fallback.navPinned : parsed.navPinned,
        lastPage: parsed.lastPage === undefined ? fallback.lastPage : parsed.lastPage,
        lastSessionId: parsed.lastSessionId === undefined ? fallback.lastSessionId : parsed.lastSessionId
      };
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, 'loadLayout failed: %{public}s', e.message);
      return fallback;
    }
  }

  /** 保存窗口布局状态（写入失败只记日志——布局记忆不是关键路径）。 */
  async saveLayout(key: string, state: WindowLayoutState): Promise<void> {
    if (this.store === undefined) {
      return;
    }
    try {
      await this.store.put(`${key}.layout`, JSON.stringify(state));
      await this.store.flush();
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, 'saveLayout failed: %{public}s', e.message);
    }
  }

  /**
   * 读取并（仅当处于自由悬浮窗口时）恢复主窗几何。
   *
   * 为什么必须先判断窗口状态：非自由窗口下调用 moveWindowTo/resize 会被系统
   * 忽略或产生回弹（官方文档明确「不建议在除自由悬浮窗口模式外的其他窗口模式下使用」）。
   * 与其制造一次无效调用，不如什么都不做。
   */
  async restoreMainGeometry(win: window.Window): Promise<boolean> {
    if (this.store === undefined) {
      return false;
    }
    try {
      const status: window.WindowStatusType = win.getWindowStatus();
      if (status !== window.WindowStatusType.FLOATING) {
        hilog.info(DOMAIN, TAG, '窗口非自由悬浮态，跳过几何恢复');
        return false;
      }
      const raw: string = await this.store.get('main.rect', '') as string;
      if (raw.length === 0) {
        return false;
      }
      const rect: WindowRect = JSON.parse(raw) as WindowRect;
      await win.moveWindowToAsync(rect.x, rect.y);
      await win.resizeAsync(rect.width, rect.height);
      return true;
    } catch (err) {
      const e = err as BusinessError;
      // 1300010 = 窗口非自由悬浮态；这里是预期分支，不作为错误上报
      hilog.debug(DOMAIN, TAG, 'restore geometry skipped: %{public}s', e.message);
      return false;
    }
  }

  /** 记录主窗几何（自由悬浮态下由 windowSizeChange 驱动节流调用）。 */
  async saveMainGeometry(win: window.Window): Promise<void> {
    if (this.store === undefined) {
      return;
    }
    try {
      const status: window.WindowStatusType = win.getWindowStatus();
      if (status !== window.WindowStatusType.FLOATING) {
        return;
      }
      const props: window.WindowProperties = win.getWindowProperties();
      const rect: WindowRect = {
        x: props.windowRect.left,
        y: props.windowRect.top,
        width: props.windowRect.width,
        height: props.windowRect.height
      };
      await this.store.put('main.rect', JSON.stringify(rect));
      await this.store.flush();
    } catch (err) {
      const e = err as BusinessError;
      hilog.debug(DOMAIN, TAG, 'save geometry skipped: %{public}s', e.message);
    }
  }
}
