/**
 * 托盘后台 Ability —— 唯一职责：把本进程「贴」到系统托盘的图标上。
 *
 * 由 `EntryAbility` 以
 * `processMode = NEW_PROCESS_ATTACH_TO_STATUS_BAR_ITEM` +
 * `startupVisibility = STARTUP_HIDE`
 * 拉起：独立进程、无窗口、不进 Dock、不触发 onForeground。这是 HarmonyOS PC 允许应用在
 * 窗口隐藏后**继续后台运行**的官方做法（官方《PC应用通过系统托盘后台保活》第 2 步）：
 * 没有它，窗口最小化 / 切到别的应用后进程就可能被系统挂起回收，与 Host 的长连接断掉、
 * 正在跑的任务停摆。
 *
 * 注：系统「关闭窗口」在本应用是**官方行为 = 退出应用**（2026-10-05 起不再拦截），
 * 所以本 Ability 服务的是「窗口还在、只是不可见」的场景，而不是"关了窗口还常驻"。
 *
 * 设计取舍：本 Ability **不承载任何业务**。它不认识 DSH，也不碰 Host；一旦把状态放进来，
 * 就会出现「主 Ability 一份、后台 Ability 又一份」的双份真相，而这层进程本来就是短命的。
 */

import { UIAbility } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { StatusBarTray } from '../system/StatusBarTray';

const DOMAIN: number = 0x0000;
const TAG: string = 'entry/background';

export default class BackGroundAbility extends UIAbility {
  onCreate(): void {
    /*
     * 退出链：主 Ability 决定退出时不能只结束自己 —— 本进程还挂在托盘图标上，
     * 会留下「主 Ability 已死、托盘图标还在」的半死状态（官方文档明确提示）。
     * 故主 Ability 发退出请求，本 Ability 收到后自行了结。
     */
    StatusBarTray.subscribeExitRequest((): void => {
      this.terminateSelfQuietly();
    });
  }

  /**
   * 系统要终止本 Ability 时走这里：**交给主 Ability 收尾**，自己只是放行。
   *
   * 【为什么不在本处自己退】托盘图标的删除、Host 的停止、长时任务的释放都在主 Ability 那边
   * （一处收口）；本 Ability 只负责通知，然后 `return false` 让终止继续。
   */
  onPrepareToTerminate(): boolean {
    StatusBarTray.notifyBgTerminating();
    return false;
  }

  /**
   * 兜底：任何**普通** `startAbility` 拉起本 Ability 的路径都会得到一个正常窗口，而本类没有
   * 任何 UI —— 屏幕上会多出一个只显示启动图、永远进不去的窗口。立刻隐藏它。
   *
   * 【为什么用 `UIAbilityContext.hideAbility()` 而不是 `Window.hide()`】后者在 API 26 的
   * SDK 里不存在（见 `@ohos.window.d.ts`）。另：`hideAbility` 的 SDK 前提是应用已挂上托盘
   * 图标 —— 正是本 Ability 的启动条件，故这里成立。
   */
  onWindowStageCreate(windowStage: window.WindowStage): void {
    this.context.hideAbility().then(() => {
      hilog.info(DOMAIN, TAG, '托盘后台 Ability 的窗口已隐藏（它本就不该有窗口）');
    }).catch((err: BusinessError) => {
      // 非 PC/平板返回 801 属预期；此处只记日志，不抛出 —— 本 Ability 不承载业务
      hilog.warn(DOMAIN, TAG, '隐藏托盘后台 Ability 的窗口失败：%{public}s', err.message);
    });
  }

  onDestroy(): void {
    /*
     * 【2026-10-05 撤除：这里曾"兜底摘状态栏图标"，但它**不可能生效**】
     *
     *   · `StatusBarTray.installed` 是**模块级 static**，而本 Ability 跑在**独立进程**
     *     （`NEW_PROCESS_ATTACH_TO_STATUS_BAR_ITEM`）⇒ 这个进程里它恒为 `false`，
     *     `StatusBarTray.remove()` 第一行 `if (!installed) return` 就返回了：一次系统调用都不会发。
     *   · 即便绕过它，SDK 对 `removeFromStatusBar` 明确「无前台窗口时不可删除」
     *     （错误码 1010710004），而本 Ability 本来就没有前台窗口 —— 只会拿到这条错误。
     *   ⇒ 摘图标只能在**有前台窗口的主 Ability** 侧做（`EntryAbility.exitApp`）；
     *     真机实测也表明图标是随后台进程结束被系统一并收走的。
     */
    hilog.info(DOMAIN, TAG, '托盘后台 Ability 已销毁');
  }

  private terminateSelfQuietly(): void {
    this.context.terminateSelf().then(() => {
      hilog.info(DOMAIN, TAG, '托盘后台 Ability 已按退出请求终止');
    }).catch((err: BusinessError) => {
      hilog.warn(DOMAIN, TAG, '托盘后台 Ability 终止失败：%{public}s', err.message);
    });
  }
}
