/**
 * 本机偏好（客户端自己的设置，**没有** Host 侧对应项）。
 *
 * ───────────────────────── 为什么它必须存在 ─────────────────────────
 *   D1 §7.6.5 把「主题：跟随系统深浅色 + 品牌色」列为 **P0** 验收点
 *   （判据：系统切换主题 1 秒内生效），D3 §8 的表格又写着
 *   「主题模式 | 跟随系统 / 浅色 / 深色（**设置可覆盖**）」——
 *   也就是**必须有一个端侧设置能覆盖系统主题**，而 Host 设置里没有这一项
 *   （它不属于 dsh 的配置面）。所以它只能落在本机偏好里。
 *
 * ───────────────────────── 与 Host 设置的边界（重要） ─────────────────────────
 *   本文件**只**存端侧自己的偏好。Host 设置（模型、沙箱、主题里的 Host 侧部分…）
 *   一律走 `settings/describe` + `settings/mutate`，绝不落到这里——
 *   两处都存同一件事必然不一致，而"改了一个地方另一个地方没变"是最难查的一类问题。
 *   界面上靠 `SettingOrigin.LOCAL` 与 Host 项区分（见 `appstate/model/Settings.ets`）。
 *
 * 存储：`preferences`（键值），与 `WindowMemory` 同一个库、不同键前缀。
 * 不用加密存储：主题模式不是凭据，加密只会让它读不出来时更难排查。
 */

import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { ConfigurationConstant } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/prefs';
const STORE: string = 'dsh_local_prefs';
const KEY_THEME: string = 'themeMode';
/**
 * 详情栏宽度的偏好键（P3：把用户拖出来的宽度记住）。
 *
 * 【为什么是"全局一份"而不是按形态各记一份】四形态的**可用空间**差别很大，但让步链
 * （`concedeDetail`）已经会在放不下时收窄/关闭详情栏；按形态分记会让"用户在桌面上拖宽了、
 * 换到平板发现没记住"这种体验更常见。先记一份、由模型按当前窗口夹住，是最少惊讶的做法。
 */
const KEY_DETAIL_WIDTH: string = 'detailWidth';

/**
 * 侧栏展开 / 收起的偏好键（P2-17：把用户收没收起记住）。
 *
 * 【为什么存字符串而不是布尔】本仓的偏好读取习惯是"没有记录 ⇒ 用默认"
 * （`has()` 判存在 + `get(键, 默认)`）。存布尔时"没记过"与"记过 false"读出来都是 `false`，
 * 就分不清"用户收起过"与"从没设置过"—— 而这两者的**默认**是相反的（默认展开）。
 * 故存 `'true'` / `'false'` 字符串，缺失即 `undefined` ⇒ 由 `Index` 决定用什么默认值。
 * （`loadThemeMode` 用字符串枚举、`loadDetailWidth` 用 `has()`，走的都是同一条"三态"思路。）
 */
const KEY_SIDEBAR_EXPANDED: string = 'sidebarExpanded';

/** 主题模式（D3 §8 的三个取值） */
export enum ThemeMode {
  /** 跟随系统（默认） */
  SYSTEM = 'system',
  LIGHT = 'light',
  DARK = 'dark'
}

/**
 * 主题模式经 AppStorage 在各窗口/页面之间共享的键。
 *
 * 【为什么这个键由本模块导出】它跨"能力层 ↔ 页面"这条边界（两层都要读写同一份值）。
 * 两边各写一个字面量迟早会写歪一个字符，而症状是"设置里改了、主题没变"或反之——
 * 没有任何报错。集中在唯一的事实落点，两边都 import 它。
 */
export const KEY_THEME_MODE: string = 'dshThemeMode';

/**
 * 把主题模式**真正应用到系统**（D1 §7.6.5 判据：1 秒内生效）。
 *
 * @returns 是否成功。失败**不是致命错误**（某些设备/窗口模式可能拒绝），
 *   但调用方必须如实提示"本次没生效"，而不是假装成功。
 */
export function applyThemeMode(context: common.UIAbilityContext, mode: ThemeMode): boolean {
  try {
    context.getApplicationContext().setColorMode(colorModeOf(mode));
    return true;
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, 'setColorMode failed: %{public}s', e.message);
    return false;
  }
}

/** 把字符串收窄成 `ThemeMode`；未知取值一律回到 `SYSTEM`。 */
export function themeModeOf(raw: string): ThemeMode {
  if (raw === ThemeMode.LIGHT) {
    return ThemeMode.LIGHT;
  }
  if (raw === ThemeMode.DARK) {
    return ThemeMode.DARK;
  }
  // 未知值回到"跟随系统"而不是抛错：偏好存的是**用户可见的行为**，
  // 一个坏值不该让应用起不来或停在某个随机主题上。
  return ThemeMode.SYSTEM;
}

/**
 * 主题模式 → ArkUI 的 `ColorMode`。
 *
 * 【为什么单独成函数并被单测覆盖】这是"偏好值"与"系统调用"之间唯一的映射点。
 * 映射写反（LIGHT↔DARK）不会报错，只会让用户觉得"这个开关是坏的"。
 */
export function colorModeOf(mode: ThemeMode): ConfigurationConstant.ColorMode {
  if (mode === ThemeMode.LIGHT) {
    return ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT;
  }
  if (mode === ThemeMode.DARK) {
    return ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
  }
  return ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET;
}

export class LocalPrefs {
  private store?: preferences.Preferences;

  async attach(context: common.UIAbilityContext): Promise<void> {
    try {
      this.store = await preferences.getPreferences(context, STORE);
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, 'open preferences failed: %{public}s', e.message);
      this.store = undefined;
    }
  }

  /** 读取主题模式（无记录或读取失败时返回 `SYSTEM`）。 */
  async loadThemeMode(): Promise<ThemeMode> {
    if (this.store === undefined) {
      return ThemeMode.SYSTEM;
    }
    try {
      const raw: string = await this.store.get(KEY_THEME, ThemeMode.SYSTEM as string) as string;
      return themeModeOf(raw);
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, 'loadThemeMode failed: %{public}s', e.message);
      return ThemeMode.SYSTEM;
    }
  }

  /**
   * 读取记住的详情栏宽度（**没有记录时返回 `undefined`**）。
   *
   * 【为什么这里不做范围校验】`platform` 在 `appstate` 之下，**不许**导入 `Sz` 等模型常量
   * （这条边界是由编译器守住的，已在 `InputDevices` 上实测过）。而且"多宽算合法"是**决策**，
   * 该和布局规则放在一起、被本机测试覆盖 ⇒ 收窄由 `LayoutController.detailWidthOf()` 做。
   * 这里只回答"偏好里有没有一个数字"。
   */
  async loadDetailWidth(): Promise<number | undefined> {
    if (this.store === undefined) {
      return undefined;
    }
    try {
      const present: boolean = await this.store.has(KEY_DETAIL_WIDTH);
      if (!present) {
        return undefined;
      }
      const raw: preferences.ValueType = await this.store.get(KEY_DETAIL_WIDTH, 0 as number);
      return typeof raw === 'number' ? raw : undefined;
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, 'loadDetailWidth failed: %{public}s', e.message);
      return undefined;
    }
  }

  /**
   * 读取记住的侧栏展开状态（**没有记录时返回 `undefined`**）。
   *
   * 【为什么不在这里定默认值】"没记过时该展开还是收起"是**产品语义**（本仓：展开），
   * 属 `appstate` 那一层的判断；`platform` 只回答"偏好里有没有一个值"
   * （与 `loadDetailWidth` 的分工一致）。
   */
  async loadSidebarExpanded(): Promise<boolean | undefined> {
    if (this.store === undefined) {
      return undefined;
    }
    try {
      const present: boolean = await this.store.has(KEY_SIDEBAR_EXPANDED);
      if (!present) {
        return undefined;
      }
      const raw: preferences.ValueType = await this.store.get(KEY_SIDEBAR_EXPANDED, '');
      const text: string = typeof raw === 'string' ? raw : `${raw}`;
      return text === 'true';
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, 'loadSidebarExpanded failed: %{public}s', e.message);
      return undefined;
    }
  }

  /**
   * 记住侧栏展开状态。
   *
   * @returns 是否真的落盘了。落盘失败**不值得打扰用户**（与详情栏宽度同类：
   *   下次启动回到默认展开），故调用方只记诊断、不弹提示。
   */
  async saveSidebarExpanded(expanded: boolean): Promise<boolean> {
    if (this.store === undefined) {
      return false;
    }
    try {
      await this.store.put(KEY_SIDEBAR_EXPANDED, expanded ? 'true' : 'false');
      await this.store.flush();
      return true;
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, 'saveSidebarExpanded failed: %{public}s', e.message);
      return false;
    }
  }

  /**
   * 记住详情栏宽度。
   *
   * @returns 是否真的落盘了。宽度记忆是"下次开同一形态窗口时栏还是这么宽"的兑现，
   *   落盘失败时**不值得打扰用户**（与主题不同：主题失效用户立刻看得见），
   *   故调用方只把它记进诊断，不弹提示。
   */
  async saveDetailWidth(vp: number): Promise<boolean> {
    if (this.store === undefined) {
      return false;
    }
    try {
      await this.store.put(KEY_DETAIL_WIDTH, vp);
      await this.store.flush();
      return true;
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, 'saveDetailWidth failed: %{public}s', e.message);
      return false;
    }
  }

  /**
   * 保存主题模式。
   *
   * @returns 是否真的落盘了。**调用方不能忽略它**：主题是"用户按了就该立刻看到效果"的设置，
   *   落盘失败时界面必须如实说明（下次启动会回到旧值），而不是假装已保存。
   */
  async saveThemeMode(mode: ThemeMode): Promise<boolean> {
    if (this.store === undefined) {
      return false;
    }
    try {
      await this.store.put(KEY_THEME, mode as string);
      await this.store.flush();
      return true;
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, 'saveThemeMode failed: %{public}s', e.message);
      return false;
    }
  }
}
