/**
 * DSHM PC 系统托盘（状态栏）常驻模块。
 *
 * 背景：HarmonyOS PC 不允许应用在后台私自常驻。官方给出的方案是"系统托盘保活"：
 * 用 statusBarManager 在系统托盘挂一枚应用图标，再另起一个绑定该图标的后台
 * Ability 进程来维持保活。这样用户能在系统状态栏看到"程序正在运行"，左键点击
 * 图标即可把主窗口唤回前台。
 *
 * 官方文档：PC应用通过系统托盘后台保活
 *   https://developer.huawei.com/consumer/cn/doc/architecture-guides/pc_status_bar-0000002551100435
 * API 参考：statusBarManager（@kit.DeskTopExtensionKit，HMS SDK）
 *
 * 退出链路（两条，均收敛到 EntryAbility.exitApp()）：
 *   1) 应用内「窗口 → 关闭窗口」→ publishExitRequest() → EntryAbility 与
 *      BackGroundAbility 各自 terminateSelf，node 服务随主进程回收。
 *   2) 系统托盘/Dock 右键退出 → 系统先结束 BackGroundAbility → 其
 *      onPrepareToTerminate 发 EVENT_BG_TERMINATING → EntryAbility 移除托盘
 *      图标并 terminateSelf。
 */
import { statusBarManager } from '@kit.DeskTopExtensionKit';
import { common, Want, StartOptions, contextConstant } from '@kit.AbilityKit';
import { image } from '@kit.ImageKit';
import { emitter, commonEventManager, BusinessError } from '@kit.BasicServicesKit';
import { DshmLogger } from '../utils/Logger';

const TAG: string = 'StatusBarTray';
/** 应用包名（AppScope/app.json5）。 */
const BUNDLE_NAME: string = 'com.brewdsh.app';
/** 承载托盘的模块名。 */
const MODULE_NAME: string = 'entry';
/** 绑定托盘的常驻后台 Ability。 */
const BG_ABILITY_NAME: string = 'BackGroundAbility';
/** 托盘图标（rawfile；官方建议 24vp×24vp，实产 72px 便于高分屏）。 */
const ICON_WHITE: string = 'tray_white.png';
const ICON_BLACK: string = 'tray_black.png';
/** 左键点击托盘的快捷弹窗区高度（vp）。 */
const QUICK_HEIGHT: number = 30;
/** 移除托盘到结束 Ability 之间的缓冲，避免图标残留。 */
const REMOVE_DELAY_MS: number = 120;

/** 应用内请求整体退出。 */
export const EVENT_EXIT_REQUEST: string = 'dshm.tray.exit.request';
/** 后台 Ability 即将被系统结束（托盘/Dock 右键退出）。 */
export const EVENT_BG_TERMINATING: string = 'dshm.tray.bg.terminating';

/** 托盘图标点击事件载荷（statusBarManager 'statusBarIconClick'）。 */
interface IconClickPayload {
  iconClickType?: string;
}

function errOf(e: Object): string {
  return e instanceof Error ? e.message : String(e);
}

export class StatusBarTray {
  /** 托盘图标是否已挂载（addToStatusBar 重复调用无效，这里做幂等）。 */
  private static installed: boolean = false;
  /** 后台保活 Ability 是否已拉起。 */
  private static bgHeld: boolean = false;
  /** 托盘图标点击回调。 */
  private static iconClickCb: ((clickType: string) => void) | null = null;
  /** 已创建的公共事件订阅者（避免重复订阅）。 */
  private static subscribers: Array<commonEventManager.CommonEventSubscriber> = [];

  /** 读取 rawfile 图片为 PixelMap。 */
  private static async pixelMapOf(context: common.UIAbilityContext, name: string): Promise<image.PixelMap> {
    const bytes: Uint8Array = context.resourceManager.getRawFileContentSync(name);
    const src: image.ImageSource = image.createImageSource(bytes.buffer as ArrayBuffer);
    return await src.createPixelMap();
  }

  /** 在系统托盘挂载应用图标（幂等）。 */
  static async install(context: common.UIAbilityContext): Promise<void> {
    if (StatusBarTray.installed) {
      return;
    }
    const icons: statusBarManager.StatusBarIcon = {
      white: await StatusBarTray.pixelMapOf(context, ICON_WHITE),
      black: await StatusBarTray.pixelMapOf(context, ICON_BLACK)
    };
    // abilityName 传空串：左键点击不弹自定义页面，改由 'statusBarIconClick' 事件处理。
    const quick: statusBarManager.QuickOperation = {
      abilityName: '',
      title: 'DeepSeek Harness',
      height: QUICK_HEIGHT,
      moduleName: MODULE_NAME,
      loadingStatus: false
    };
    // 不注册自定义右键菜单（statusBarGroupMenu）：
    //   - 「打开」不需要 —— 左键点托盘图标本来就把主窗口唤回前台（onIconClick → showWindow）；
    //   - 「退出」不需要 —— PC 的系统托盘右键**自带退出项**（走 onPrepareToTerminate 拦截），
    //     自己再放一个就是重复；
    //   - 「重启」也不需要 —— 应用内 Harness 菜单已有「重启服务」，且本项目评估后决定
    //     不再往系统级菜单里塞自定义项（Dock 那条入口同样已移除，见 QuickBarMenuCleanup）。
    // 因此右键完全交给系统默认菜单，应用只提供"左键唤回"。
    const item: statusBarManager.StatusBarItem = {
      icons: icons,
      quickOperation: quick,
      hoverTips: 'DeepSeek Harness 正在运行'
    };
    statusBarManager.addToStatusBar(context, item);
    StatusBarTray.installed = true;
    DshmLogger.info(TAG, '系统托盘图标已挂载（无自定义右键菜单，左键唤回）');
  }

  /**
   * 拉起绑定托盘的常驻后台 Ability。
   *
   * processMode = NEW_PROCESS_ATTACH_TO_STATUS_BAR_ITEM：新建进程承载它并把该
   * 进程绑到托盘图标；startupVisibility = STARTUP_HIDE：启动后不显示窗口、不进
   * Dock、不触发 onForeground。前置条件是应用必须已有托盘图标。
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
    context.startAbility(want, options, (err: BusinessError): void => {
      if (err && err.code !== 0) {
        DshmLogger.warn(TAG, '拉起后台保活 Ability 失败: ' + JSON.stringify(err));
        return;
      }
      StatusBarTray.bgHeld = true;
      DshmLogger.info(TAG, '后台保活 Ability 已启动（独立进程，绑定托盘）');
    });
  }

  /** 移除托盘图标（幂等）。 */
  static remove(context: common.Context): void {
    if (!StatusBarTray.installed) {
      return;
    }
    try {
      statusBarManager.removeFromStatusBar(context);
      StatusBarTray.installed = false;
      DshmLogger.info(TAG, '系统托盘图标已移除');
    } catch (e) {
      DshmLogger.warn(TAG, '移除系统托盘图标失败: ' + errOf(e));
    }
  }

  /** 注册托盘图标左键点击回调（可重复注册，后者覆盖前者）。 */
  static onIconClick(cb: (clickType: string) => void): void {
    StatusBarTray.iconClickCb = cb;
    statusBarManager.off('statusBarIconClick');
    statusBarManager.on('statusBarIconClick', (data: emitter.EventData): void => {
      const payload: IconClickPayload | undefined = data.data as IconClickPayload | undefined;
      const clickType: string = payload !== undefined && payload.iconClickType !== undefined
        ? payload.iconClickType : '';
      DshmLogger.info(TAG, '托盘图标点击: ' + clickType);
      const fn: ((clickType: string) => void) | null = StatusBarTray.iconClickCb;
      if (fn !== null) {
        fn(clickType);
      }
    });
  }

  /** 申请整体退出：主 Ability 与后台 Ability 都会收到并各自结束。 */
  static publishExitRequest(): void {
    StatusBarTray.publish(EVENT_EXIT_REQUEST, '整体退出请求');
  }

  /** 后台 Ability 被系统结束时广播，通知主 Ability 一并退出。 */
  static notifyBgTerminating(): void {
    StatusBarTray.publish(EVENT_BG_TERMINATING, '后台 Ability 即将结束');
  }

  /** 订阅"应用内请求整体退出"事件，供 EntryAbility 与 BackGroundAbility 共用。 */
  static subscribeExitRequest(handler: () => void): void {
    StatusBarTray.subscribe(EVENT_EXIT_REQUEST, handler);
  }

  /** 订阅"后台 Ability 即将结束"事件（仅 EntryAbility 需要）。 */
  static subscribeBgTerminating(handler: () => void): void {
    StatusBarTray.subscribe(EVENT_BG_TERMINATING, handler);
  }

  private static publish(event: string, label: string): void {
    commonEventManager.publish(event, (err: BusinessError): void => {
      if (err) {
        DshmLogger.warn(TAG, '发布事件失败（' + label + '）: ' + JSON.stringify(err));
        return;
      }
      DshmLogger.info(TAG, '已发布事件: ' + event + '（' + label + '）');
    });
  }

  private static subscribe(event: string, handler: () => void): void {
    const info: commonEventManager.CommonEventSubscribeInfo = { events: [event] };
    commonEventManager.createSubscriber(info)
      .then((sub: commonEventManager.CommonEventSubscriber): void => {
        StatusBarTray.subscribers.push(sub);
        commonEventManager.subscribe(sub, (err: BusinessError): void => {
          if (err) {
            DshmLogger.warn(TAG, '订阅回调异常（' + event + '）: ' + JSON.stringify(err));
            return;
          }
          DshmLogger.info(TAG, '收到事件: ' + event);
          handler();
        });
      })
      .catch((e: Object): void => {
        DshmLogger.warn(TAG, '创建订阅者失败（' + event + '）: ' + errOf(e));
      });
  }

  /** 供退出流程使用：等托盘图标先摘掉，再结束 Ability。 */
  static delayBeforeTerminate(): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, REMOVE_DELAY_MS);
    });
  }
}
