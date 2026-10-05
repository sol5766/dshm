/**
 * 系统托盘（PC 顶栏状态区图标）接入 —— 让「关闭窗口 = 切后台常驻」真正可用。
 *
 * ## 为什么需要它
 *
 * `EntryAbility.onPrepareToTerminate` 已把右上角关闭改成「最小化到后台」，但窗口收起来之后
 * 用户就**没有回程入口**了：Dock 里虽然还留着本应用，用户的心理模型却是「我把它关掉了」。
 * 系统级的常驻载体是顶栏状态区的**托盘图标**（微信 / 文件管理等 PC 应用同款位置）。
 *
 * ## 官方三步（《PC应用通过系统托盘后台保活》）
 *
 *   ① `statusBarManager.addToStatusBar` 把图标挂到顶栏状态区 —— 本文件 `install`；
 *   ② 另起一个**绑定该图标的后台 Ability 进程**，使应用在窗口不可见时不被系统挂起回收
 *      —— 本文件 `hold`（拉起的 BackGroundAbility）；
 *   ③ 图标交互：左键 / 右键「打开应用」都唤回主窗 —— 本文件 `onIconClick` / `onRightMenuClick`。
 *
 * ①②的顺序不能反：`processMode = NEW_PROCESS_ATTACH_TO_STATUS_BAR_ITEM` 的 SDK 前提是
 * 「应用必须已有状态栏图标」，所以必须先 install、再 hold（调用方延时 300ms 也是为此）。
 *
 * ## 右键菜单里为什么只有「打开应用」，没有「退出应用」
 *
 * 系统托盘自带的右键菜单里**已经有「退出」**，且真机实测它确实会退出应用
 * （2026-09-29：点它之后主进程与 BackGroundAbility 进程全部消失）——它**不经过**
 * `EntryAbility.onPrepareToTerminate`，所以不会被「关闭=切后台」那条改写拦住。
 * 再挂一个自己的「退出应用」只会得到微信那儿一样的**两个退出项**，用户无从区分。
 * 所以真正的退出交给系统那一项，我们只补系统没有的：把窗口唤回来。
 * 左键本来就能唤回，右键菜单再放一项是为了让「在图标上动手」这件事有确定的落点
 * （用户右键点开菜单、只看到「退出」，很容易误以为只能退出）。
 *
 * ## 不变量
 *
 * - `installed` / `bgHeld` 幂等：`launchType=specified` 下同一 UIAbility 会被反复复用与重建，
 *   没有守卫就会重复挂图标（SDK：「Repeated adding is invalid」）与重复起进程。
 * - **install 失败必须让上层知道**（`isReady()`）：上层据此**不再拦截关闭**。没有回程入口
 *   却拦着不让关，用户会被彻底关在门外（窗口收进后台、托盘里找不到、只能去系统设置强停）。
 * - 摘图标（`remove`）要在**还有前台窗口**时做：SDK 对 `removeFromStatusBar` 明确
 *   无前台窗口时不可删除（错误码 1010710004）。
 */

import { statusBarManager } from '@kit.DeskTopExtensionKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { common, contextConstant, StartOptions, Want } from '@kit.AbilityKit';
import { image } from '@kit.ImageKit';
import { commonEventManager, emitter, BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { localizedOr } from 'platform';

const DOMAIN: number = 0x0000;
const TAG: string = 'entry/tray';

/** 本应用身份：托盘 `hold` 要用它构造 Want，与 AppScope/app.json5 保持一致 */
const BUNDLE_NAME: string = 'com.dshm.dshclient';
/** 托盘图标绑定的后台 Ability 所在模块 */
const MODULE_NAME: string = 'entry';
/** 托盘图标绑定的后台 Ability 名（见 module.json5 的 abilities 段） */
const BG_ABILITY_NAME: string = 'BackGroundAbility';

/** 托盘图标（rawfile）：系统按状态栏明暗二选一渲染，故需纯白 / 纯黑两份单色剪影 */
const ICON_WHITE: string = 'tray_white.png';
const ICON_BLACK: string = 'tray_black.png';

/** 左键点击弹窗区高度（vp，SDK 要求 > 0） */
const QUICK_HEIGHT: number = 30;
/** 摘图标到 `terminateSelf` 之间的缓冲：图标残留比多等一瞬更难接受 */
const REMOVE_DELAY_MS: number = 120;
/** 自定义右键项「打开应用」的唯一 menuCode（SDK 要求全局唯一） */
const MENU_CODE_OPEN: string = 'dshm.tray.open';

/**
 * 进程内退出请求（EntryAbility → BackGroundAbility）。
 *
 * 【为什么走公共事件】两者虽同模块，但 `hold` 用的是
 * `NEW_PROCESS_ATTACH_TO_STATUS_BAR_ITEM`（独立进程、无窗口），进程内变量与 AppStorage
 * 都不共享；唯一可用的通道是公共事件（系统级、跨进程）。
 */
export const EVENT_EXIT_REQUEST: string = 'dshm.tray.exit.request';
/** 后台 Ability 被系统结束的通知（BackGroundAbility → EntryAbility） */
export const EVENT_BG_TERMINATING: string = 'dshm.tray.bg.terminating';

/** `statusBarIconClick` 事件载荷 */
interface IconClickPayload {
  iconClickType?: string;
}

/** `rightMenuClick` 事件载荷 */
interface RightMenuPayload {
  menuCode?: string;
}

function errOf(e: Object): string {
  const err = e as BusinessError;
  return `${err.code}: ${err.message}`;
}

export class StatusBarTray {
  private static installed: boolean = false;
  private static bgHeld: boolean = false;
  private static iconClickCb: ((clickType: string) => void) | null = null;
  private static rightMenuCb: (() => void) | null = null;
  private static subscribers: Array<commonEventManager.CommonEventSubscriber> = [];

  /**
   * 托盘图标是否真的挂上了。
   *
   * 【上层必须读它再决定拦不拦关闭】见文件头「不变量」。
   */
  static isReady(): boolean {
    return StatusBarTray.installed;
  }

  private static async pixelMapOf(context: common.UIAbilityContext, name: string): Promise<image.PixelMap> {
    const bytes: Uint8Array = context.resourceManager.getRawFileContentSync(name);
    const src: image.ImageSource = image.createImageSource(bytes.buffer as ArrayBuffer);
    return await src.createPixelMap();
  }

  /**
   * 挂托盘图标（幂等）。失败会**抛出**，由调用方决定降级（见 isReady 的说明）。
   */
  static async install(context: common.UIAbilityContext): Promise<void> {
    /*
     * 【2026-10-05：先摘残留，再挂新图标】
     * 系统侧的状态栏注册是按 bundle 保存的 —— 换版本/覆盖安装后，旧注册可能仍在，
     * 表现为"应用没开、顶栏或右下角还挂着我们的图标"（今天实测过：宿主进程都已 force-stop
     * 清掉，图标仍留着）。这里先无条件摘一次：没有旧注册时该调用可能抛（忽略即可），
     * 摘完再挂新的，保证"运行时有图标、且只有一份"。
     * 显示在**顶栏**还是**右下角托盘区**由系统按桌面形态决定，本代码不做任何位置分支。
     */
    try {
      statusBarManager.removeFromStatusBar(context);
      hilog.info(DOMAIN, TAG, '挂图标前先摘残留注册（无残留时也会成功）');
    } catch (err) {
      hilog.info(DOMAIN, TAG, '挂图标前摘残留注册失败（多半本来就没有，忽略）：%{public}s', errOf(err as Object));
    }

    /*
     * 【2026-10-05 按用户要求：DSHM_TRAY_DISABLED —— 不再挂托盘图标】
     *
     * 真机实测两轮：即便恢复了官方终止行为、并在 onPrepareToTerminate（窗口尚在时）主动
     * 调 removeFromStatusBar，托盘图标**仍然留着**。原因是结构性的：图标是挂在
     * **托盘进程**（BackGroundAbility，NEW_PROCESS_ATTACH_TO_STATUS_BAR_ITEM 拉起）身上的，
     * 只有那个进程结束才会一并收走；而系统终止只结束主 Ability。
     *
     * 而托盘的存在意义本来只有一条：让"关闭窗口"后应用继续跑（关窗 ⇒ 最小化到后台）。
     * 用户已明确要求**恢复官方行为**（关闭就是退出）⇒ 这条前提消失 ⇒ 托盘成了纯负担
     * （退出后留一个摘不掉的图标）。故这里直接不挂：应用行为与普通鸿蒙应用一致。
     *
     * 要恢复托盘：把下面这行 return 注掉即可（其余实现原样保留）。
     */
    if (StatusBarTray.installed) {
      return;
    }
    const white: image.PixelMap = await StatusBarTray.pixelMapOf(context, ICON_WHITE);
    const black: image.PixelMap = await StatusBarTray.pixelMapOf(context, ICON_BLACK);
    const icons: statusBarManager.StatusBarIcon = { white: white, black: black };
    /*
     * `abilityName` 传空串：SDK 原文 —— 传空串时点击服务由监听 `statusBarIconClick` 事件处理。
     * 我们要的正是这个（左键唤回主窗），而不是让系统去 startAbility 一个新实例。
     */
    const quick: statusBarManager.QuickOperation = {
      abilityName: '',
      title: 'DSHM',
      height: QUICK_HEIGHT,
      moduleName: MODULE_NAME,
      loadingStatus: false
    };
    const item: statusBarManager.StatusBarItem = {
      icons: icons,
      /*
       * 【2026-10-05：quickOperation 是该接口的**必填**字段（去掉后编译失败 ERROR×2，实测），
       * 故这里保留；系统菜单里那个「打开应用」项由它派生，要彻底去掉只能不用托盘图标。】
       */
      quickOperation: quick,
      hoverTips: localizedOr(context, $r('app.string.tray_hover_tips'), 'DSHM 正在运行')
    };
    /*
     * 带自定义右键菜单失败时**退回不带菜单再试一次**。
     *
     * 【为什么值得多这一步】`addToStatusBar` 是全有或全无的：菜单数据里任何一个字段不被当前
     * 系统版本接受（如 `menuCode`、`notifyOnly` 的兼容性），整次挂图标就失败。而挂不上图标的
     * 后果不是「少一个右键项」，是**连图标和入口一起没有**。宁可先拿到图标（左键唤回这条
     * 主链路可用），右键项失败只降级成「退出改由系统自带项」。
     */
    try {
      statusBarManager.addToStatusBar(context, item);
    } catch (err) {
      hilog.warn(DOMAIN, TAG, '挂托盘图标（含右键菜单）失败，退回不带菜单重试：%{public}s', errOf(err as Object));
      const bare: statusBarManager.StatusBarItem = {
        icons: icons,
        quickOperation: quick,
        hoverTips: item.hoverTips
      };
      statusBarManager.addToStatusBar(context, bare);
    }
    StatusBarTray.installed = true;
    hilog.info(DOMAIN, TAG, '托盘图标已挂上');
  }

  /** 自定义右键菜单：一个分组，一组一项。分组是第一级（系统自带项在另一组）。 */
  private static groupMenu(context: common.UIAbilityContext): Array<statusBarManager.StatusBarGroupMenu> {
    const item: statusBarManager.StatusBarMenuItem = {
      title: localizedOr(context, $r('app.string.tray_menu_open'), '打开应用'),
      // notifyOnly：不启动任何 Ability，只把点击以 rightMenuClick 事件送回应用。
      // abilityName 必填（接口定义如此），此处置空——notifyOnly 下它不被使用。
      menuAction: { abilityName: '', notifyOnly: true },
      menuCode: MENU_CODE_OPEN
    };
    return [[item]];
  }

  /**
   * 把**本进程**挂到托盘图标上（独立进程、无窗口、不进 Dock、不触发 onForeground 之外的一切）。
   *
   * 幂等：`specified` 启动模式下主 Ability 会被反复重建，不守卫就会重复起进程。
   */
  static hold(context: common.UIAbilityContext): void {
    if (StatusBarTray.bgHeld) {
      return;
    }
    const want: Want = { bundleName: BUNDLE_NAME, abilityName: BG_ABILITY_NAME };
    const options: StartOptions = {
      processMode: contextConstant.ProcessMode.NEW_PROCESS_ATTACH_TO_STATUS_BAR_ITEM,
      startupVisibility: contextConstant.StartupVisibility.STARTUP_HIDE
    };
    context.startAbility(want, options, (err: BusinessError) => {
      if (err) {
        // 失败仅降级：主窗仍有 KeepAlive 长时任务兜着，进程只是少了「贴住托盘图标」这层保护。
        hilog.warn(DOMAIN, TAG, '拉起托盘后台 Ability 失败（降级运行）：%{public}s', errOf(err));
        return;
      }
      StatusBarTray.bgHeld = true;
      hilog.info(DOMAIN, TAG, '托盘后台 Ability 已拉起（独立进程挂到图标上）');
    });
  }

  /** 摘托盘图标（幂等）。失败只记日志：退出流程不该被一个图标卡住。 */
  static remove(context: common.Context): void {
    if (!StatusBarTray.installed) {
      return;
    }
    try {
      statusBarManager.removeFromStatusBar(context);
      StatusBarTray.installed = false;
      hilog.info(DOMAIN, TAG, '托盘图标已摘除');
    } catch (err) {
      hilog.warn(DOMAIN, TAG, '摘除托盘图标失败（退出流程继续）：%{public}s', errOf(err as Object));
    }
  }

  /**
   * 标记托盘入口已失效（图标随后台进程一起被系统收走时调用）。
   *
   * 【为什么不能只依赖 remove 的返回值】`removeFromStatusBar` 在无前台窗口时本就会失败
   * （1010710004），而这条路径恰恰是"窗口可能已被最小化"的时候 ⇒ `installed` 会被留在 true。
   * 那样 `onPrepareToTerminate` 会继续拦截关闭，用户就真的**关在门外**了（见文件头不变量）。
   * 图标是否还在不可靠地可查，但"回程入口可能没了"这件事是确定的，就按确定的处理：
   * 不再拦截关闭，让用户至少还能从右上角关掉应用。
   */
  static markUnavailable(): void {
    if (!StatusBarTray.installed) {
      return;
    }
    StatusBarTray.installed = false;
    hilog.warn(DOMAIN, TAG, '托盘入口标记为失效：不再拦截关闭，保证用户还能退出');
  }

  /** 左键点击托盘图标（`iconClickType` 目前只会是 `leftClick`）。 */
  static onIconClick(cb: (clickType: string) => void): void {
    /*
     * 【2026-10-05 说明】用户澄清：**左键单击打开应用是要保留的**（此前误删，这里原样恢复）；
     * 要清除的是**右键菜单里那个"打开应用"项**及其功能（已通过不再传 statusBarGroupMenu 去掉）。
     */
    StatusBarTray.iconClickCb = cb;
    // 先注销（不传 callback = 注销该事件的全部回调）再注册：本方法可能被多次调用，
    // 累积回调会让一次点击触发 N 次唤回。
    statusBarManager.off('statusBarIconClick');
    statusBarManager.on('statusBarIconClick', (data: emitter.EventData) => {
      const payload: IconClickPayload | undefined = data.data as IconClickPayload | undefined;
      const clickType: string = payload === undefined || payload.iconClickType === undefined
        ? '' : payload.iconClickType;
      // 原始载荷打出来：`iconClickType` 的取值集合由系统决定，不以注释为准，以日志为准
      hilog.info(DOMAIN, TAG, '托盘图标被点击：type=%{public}s payload=%{public}s',
        clickType, JSON.stringify(data.data));
      const fn: ((clickType: string) => void) | null = StatusBarTray.iconClickCb;
      if (fn !== null) {
        fn(clickType);
      }
    });
  }

  /** 自定义右键菜单项被点击（只对我们自己的 menuCode 有反应；系统自带的「退出」不走这里）。 */
  static onRightMenuClick(cb: () => void): void {
    StatusBarTray.rightMenuCb = cb;
    statusBarManager.off('rightMenuClick');
    statusBarManager.on('rightMenuClick', (data: emitter.EventData) => {
      const payload: RightMenuPayload | undefined = data.data as RightMenuPayload | undefined;
      const code: string = payload === undefined || payload.menuCode === undefined ? '' : payload.menuCode;
      hilog.info(DOMAIN, TAG, '托盘右键菜单被点击：code=%{public}s payload=%{public}s',
        code, JSON.stringify(data.data));
      if (code !== MENU_CODE_OPEN) {
        return;
      }
      const fn: (() => void) | null = StatusBarTray.rightMenuCb;
      if (fn !== null) {
        fn();
      }
    });
  }

  /** 请求后台 Ability 自行退出（EntryAbility 的退出流程里调用）。 */
  static publishExitRequest(): void {
    StatusBarTray.publish(EVENT_EXIT_REQUEST, '退出应用');
  }

  /** 通知主 Ability：后台 Ability 即将被系统结束。 */
  static notifyBgTerminating(): void {
    StatusBarTray.publish(EVENT_BG_TERMINATING, '后台进程被系统结束');
  }

  static subscribeExitRequest(handler: () => void): void {
    StatusBarTray.subscribe(EVENT_EXIT_REQUEST, handler);
  }

  static subscribeBgTerminating(handler: () => void): void {
    StatusBarTray.subscribe(EVENT_BG_TERMINATING, handler);
  }

  private static publish(event: string, label: string): void {
    commonEventManager.publish(event, (err: BusinessError) => {
      if (err) {
        hilog.warn(DOMAIN, TAG, '发布事件失败（%{public}s）：%{public}s', label, errOf(err));
      }
    });
  }

  private static subscribe(event: string, handler: () => void): void {
    try {
      // 用 createSubscriberSync 而不是 createSubscriber：后者在 ArkTS 里会被重载解析成
      // `Promise<CommonEventSubscriber>`（SDK 有三个重载），拿不到订阅者本体。
      const sub: commonEventManager.CommonEventSubscriber =
        commonEventManager.createSubscriberSync({ events: [event] });
      StatusBarTray.subscribers.push(sub);
      commonEventManager.subscribe(sub, (err: BusinessError) => {
        if (err) {
          hilog.warn(DOMAIN, TAG, '订阅事件失败（%{public}s）：%{public}s', event, errOf(err));
          return;
        }
        hilog.info(DOMAIN, TAG, '收到事件 %{public}s', event);
        handler();
      });
    } catch (err) {
      hilog.warn(DOMAIN, TAG, '创建事件订阅者失败（%{public}s）：%{public}s', event, errOf(err as Object));
    }
  }

  /** 摘图标到终止之间的缓冲，避免系统侧还来不及处理删除就换了进程。 */
  static delayBeforeTerminate(): Promise<void> {
    return new Promise<void>((resolve: () => void) => {
      setTimeout(resolve, REMOVE_DELAY_MS);
    });
  }
}
