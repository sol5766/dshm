/**
 * 系统托盘（PC 顶栏 / 托盘区状态图标）接入 —— 运行时挂图标 + 左键唤回主窗。
 *
 * ## 现在做什么（2026-10-05 定案的三条需求）
 *
 *   ① `statusBarManager.addToStatusBar` 把图标挂到系统状态栏 —— 本文件 `install`。
 *      显示在**顶栏**还是**右下角托盘区**由系统按桌面形态决定，本代码不做任何位置分支。
 *   ② 左键单击唤回主窗 —— 订阅 `statusBarIconClick`（本文件 `onIconClick`，接线在
 *      `EntryAbility.setupTray`）。SDK 明确 `iconClickType` 目前只返回 `leftClick`。
 *   ③ **不注册任何自定义右键菜单项**（`statusBarGroupMenu` 不传）⇒ 也**不订阅** `rightMenuClick`：
 *      SDK 文档写明该事件只在 `updateStatusBarMenu()` 加过带 `notifyOnly` 的菜单项后才可能触发。
 *      右键菜单里是系统自带的项（含系统那个「退出」），我们不复制一份、也不自写退出链。
 *   ④ 另起一个**绑定该图标的后台 Ability 进程**（`hold`，`NEW_PROCESS_ATTACH_TO_STATUS_BAR_ITEM`），
 *      使窗口不可见时进程不被系统挂起回收。①④ 顺序不能反：该 processMode 的 SDK 前提是
 *      「应用必须已有状态栏图标」，所以先 install、再 hold（调用方延时 300ms 也是为此）。
 *
 * ## 幂等：**踩过一次真回归，别再改回去**
 *
 * `launchType=specified` 下同一 UIAbility 会被反复复用与重建（多窗），`onWindowStageCreate`
 * 可能在**同一进程**里被第二次走到 ⇒ `install()` 会被调用两次。两条不变量必须同时成立：
 *   · **重复调用必须先返回**（`installed` 早退），**绝不能先摘**；
 *   · 「先摘残留再挂新图标」只属于**首次挂载**路径（覆盖安装/异常退出后系统侧可能残留旧注册，
 *     表现为「应用没开、图标还挂着」）。
 * 反面教材（2026-10-05 实测的真回归）：把「摘残留」放在早退**之前** ⇒ 第二次 `install()`
 * 会先 `removeFromStatusBar` 摘掉**活着**的图标，再因 `installed === true` 直接 return
 * ⇒ 图标永久消失（直到进程结束）。触发场景：会话窗还在（同进程存活）时关掉主窗，
 * 再从 Dock/任务栏重开主窗（模块级 static 不重置，于是走第二次 install）。
 *
 * `bgHeld` 同理：不守卫就会重复拉起托盘进程（SDK：「Repeated adding is invalid」）。
 *
 * ## 失败降级
 *
 * `install()` 失败**抛出**，由调用方 `EntryAbility.setupTray` 捕获并记日志降级：
 * 官方行为下「关闭窗口 = 退出应用」，图标挂不上只是少一个入口，不影响关闭与退出。
 *
 * ## 摘图标（`remove`）要在**还有前台窗口**时做
 *
 * SDK 对 `removeFromStatusBar` 明确：无前台窗口时不可删除（错误码 1010710004）。
 * ⇒ **不要**在无窗口的进程（如 `BackGroundAbility`）里指望它能摘掉图标：那个进程连
 * `installed` 都是自己的 `false`（模块级 static 不跨进程），第一行就早退了。
 *
 * ⇒ 因此摘图标**必须排在"停核心"之前**（见 `EntryAbility.finalizeBeforeExit`）：停核心是
 * 不定长等待，等它回来窗口可能已经不在了。历史上 `exitApp` 把 `remove` 排在
 * `stopHostThenExit()` 之后，叠加"先 markUnavailable 把 installed 清零"，摘图标在唯一一条
 * 退出路径上**一次都没发出去**（2026-10-06 修）。
 *
 * ## 可观测性（为什么托盘事件要落文件）
 *
 * 本机 `hilog` 读不到本应用的 ArkTS 输出 ⇒ 托盘事件一律追加到 `filesDir/diag-tray`
 * （`diag`）：挂上 / 摘掉 / 摘失败（带错误码）/ 幂等跳过 / 谁按的退出键。事后一份文件
 * 就能判定"走了哪条路径、有没有真摘掉"。
 */

import { statusBarManager } from '@kit.DeskTopExtensionKit';
import { common, contextConstant, StartOptions, Want } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
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

/**
 * 托盘诊断落点（`filesDir/diag-tray`，一行「ISO 时间戳 + 事件」）。
 *
 * 【为什么必须有它】本机 `hilog` 读不到本应用的 ArkTS 输出（`hilog -x` 里 `entry/tray`
 * 0 条、持久 hilog 里 `com.dshm.dshclient` 0 条，见 docs/98 §6），而「退出后图标还在」是
 * **概率性**故障 ⇒ 不落文件就只能靠猜。这里只记事实，不做任何业务判断。
 */
const DIAG_FILE: string = 'diag-tray';

/** 左键点击弹窗区高度（vp，SDK 要求 > 0） */
const QUICK_HEIGHT: number = 30;
/** 摘图标到 `terminateSelf` 之间的缓冲：图标残留比多等一瞬更难接受 */
const REMOVE_DELAY_MS: number = 120;

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

function errOf(e: Object): string {
  const err = e as BusinessError;
  return `${err.code}: ${err.message}`;
}

export class StatusBarTray {
  private static installed: boolean = false;
  private static bgHeld: boolean = false;
  private static iconClickCb: ((clickType: string) => void) | null = null;
  private static subscribers: Array<commonEventManager.CommonEventSubscriber> = [];

  /** 追加一条托盘诊断（与 pages/WebApp.ets 的 writeDiagMarker 同一套写法；写失败静默）。 */
  private static diag(context: common.Context, detail: string): void {
    try {
      const p: string = `${context.filesDir}/${DIAG_FILE}`;
      const f: fileIo.File = fileIo.openSync(p,
        fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.APPEND);
      fileIo.writeSync(f.fd, `${new Date().toISOString()} ${detail}\n`);
      fileIo.closeSync(f);
    } catch (err) {
      hilog.warn(DOMAIN, TAG, '托盘诊断写入失败：%{public}s', errOf(err as Object));
    }
  }

  private static async pixelMapOf(context: common.UIAbilityContext, name: string): Promise<image.PixelMap> {
    const bytes: Uint8Array = context.resourceManager.getRawFileContentSync(name);
    const src: image.ImageSource = image.createImageSource(bytes.buffer as ArrayBuffer);
    return await src.createPixelMap();
  }

  /**
   * 挂托盘图标（幂等）。失败会**抛出**，由调用方 `EntryAbility.setupTray` 降级（见文件头）。
   */
  static async install(context: common.UIAbilityContext): Promise<void> {
    /*
     * 【幂等判据必须在最前 —— 这一行是修一个真回归】
     *
     * 同一进程里 `install()` 可能被调用第二次（见文件头「幂等」：会话窗存活时关主窗、
     * 再从 Dock 重开主窗 ⇒ 新的主窗实例走第二次 setupTray）。此时图标**已经挂着**，
     * 唯一正确的动作是**什么都不做**。
     *
     * 曾经的写法把「摘残留」放在这个早退之前 ⇒ 第二次调用会先 `removeFromStatusBar`
     * 摘掉活着的图标，再 return ⇒ 图标永久消失。别把下面这个 if 挪到后面去。
     */
    if (StatusBarTray.installed) {
      hilog.info(DOMAIN, TAG, '托盘图标已在位：幂等跳过（不摘、不重挂）');
      StatusBarTray.diag(context, 'install skip：installed=true（幂等，不摘不重挂）');
      return;
    }
    /*
     * 【只在首次挂载时：先摘残留，再挂新图标】
     * 系统侧的状态栏注册是按 bundle 保存的 —— 换版本/覆盖安装、异常退出后，旧注册可能仍在，
     * 表现为「应用没开、顶栏/托盘区还挂着我们的图标」（实测过：宿主进程都已 force-stop，
     * 图标仍留着）。首次挂载前无条件摘一次：没有旧注册时该调用可能抛（忽略即可），
     * 摘完再挂新的，保证「运行时有图标、且只有一份」。
     * 显示在**顶栏**还是**右下角托盘区**由系统按桌面形态决定，本代码不做任何位置分支。
     */
    try {
      statusBarManager.removeFromStatusBar(context);
      hilog.info(DOMAIN, TAG, '首次挂载：先摘残留注册（无残留时也会成功）');
      StatusBarTray.diag(context, 'install pre-clean ok：已摘掉上次遗留的注册');
    } catch (err) {
      hilog.info(DOMAIN, TAG, '首次挂载摘残留注册失败（多半本来就没有，忽略）：%{public}s', errOf(err as Object));
      StatusBarTray.diag(context, `install pre-clean skip：${errOf(err as Object)}（无残留时正常）`);
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
       * 【quickOperation 是该接口的**必填**字段（去掉后编译失败 ERROR×2，实测）】故保留。
       * 注意这里**不传** `statusBarGroupMenu` —— 需求③：不注册任何自定义右键菜单项。
       * 代价：`rightMenuClick` 事件因此永不触发（SDK 要求先 updateStatusBarMenu 加带
       * notifyOnly 的项），所以本类也不再订阅它。
       */
      quickOperation: quick,
      hoverTips: localizedOr(context, $r('app.string.tray_hover_tips'), 'DSHM 正在运行')
    };
    /*
     * 一次调用、失败即抛出：没有自定义菜单之后，这里已经没有「退回不带菜单再试」的降级对象了
     * （两次调用的实参完全相同 ⇒ 重试只会拿到同一个错）。降级归于上层：`setupTray` 捕获后
     * 记日志，图标没挂上只等于少一个入口，不影响关闭与退出。
     */
    try {
      statusBarManager.addToStatusBar(context, item);
    } catch (err) {
      // 记完再抛：调用方（setupTray）会降级——图标没挂上只等于少一个入口
      StatusBarTray.diag(context, `install failed：addToStatusBar ${errOf(err as Object)}`);
      throw err as Error;
    }
    StatusBarTray.installed = true;
    hilog.info(DOMAIN, TAG, '托盘图标已挂上');
    StatusBarTray.diag(context, 'install ok：addToStatusBar 成功');
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

  /**
   * 摘托盘图标（幂等）。失败只记日志：退出流程不该被一个图标卡住。
   *
   * 【成败都要把 `installed` 归零 —— 这是 2026-10-06 修的那个"退出后图标还在"】
   * 成功 ⇒ 图标确实不在了，归零正确。失败（典型 1010710004「无前台窗口时不可删除」）⇒
   * 图标**可能还在**；此时若把 `installed` 留在 `true`，下一次 `install()` 会因幂等早退
   * 而**永远不再尝试清理** —— 这正是"概率性残留、重启若干次都还在"的形态。
   * 归零后下一次 `install()` 会回到「首次挂载」路径（先摘残留、再挂新的），图标能回来。
   */
  static remove(context: common.Context): void {
    if (!StatusBarTray.installed) {
      StatusBarTray.diag(context, 'remove skip：installed=false（本进程没挂过或已摘）');
      return;
    }
    try {
      statusBarManager.removeFromStatusBar(context);
      hilog.info(DOMAIN, TAG, '托盘图标已摘除');
      StatusBarTray.diag(context, 'remove ok');
    } catch (err) {
      hilog.warn(DOMAIN, TAG, '摘除托盘图标失败（退出流程继续）：%{public}s', errOf(err as Object));
      StatusBarTray.diag(context, `remove failed：${errOf(err as Object)}（图标可能仍在；下次启动先摘残留）`);
    }
    StatusBarTray.installed = false;
  }

  /** 左键点击托盘图标（`iconClickType` 目前只会是 `leftClick`，见 SDK 声明）。 */
  static onIconClick(cb: (clickType: string) => void): void {
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
