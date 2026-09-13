/**
 * DSHM 后台保活 Ability（绑定系统托盘）。
 *
 * 由 EntryAbility 以
 *   processMode        = contextConstant.ProcessMode.NEW_PROCESS_ATTACH_TO_STATUS_BAR_ITEM
 *   startupVisibility  = contextConstant.StartupVisibility.STARTUP_HIDE
 * 拉起：独立进程、无窗口、不进 Dock、不触发 onForeground，唯一职责是把该进程
 * 挂到系统托盘图标上，使 HarmonyOS PC 允许应用在窗口隐藏后继续后台运行
 * （DSH node 服务不会因为窗口不可见而被系统挂起/回收）。
 *
 * 设计取舍：本 Ability 不承载任何业务；DSH 运行时仍由 EntryAbility 所在进程
 * 的 native 子进程承担。它只负责"保住进程 + 托盘可见"。
 */
import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo } from '@kit.CoreFileKit';
import { DshmLogger } from '../dshm/utils/Logger';
import { StatusBarTray } from '../dshm/system/StatusBarTray';
import { DshmAppActions } from '../dshm/system/AppActions';
import {
  QUICKBAR_PARAM_KEY,
  QUICKBAR_ACTION_EXIT,
  QUICKBAR_ACTION_RESTART
} from '../dshm/system/QuickBarMenu';

const TAG: string = 'BackGroundAbility';

/**
 * Dock 菜单动作诊断文件。
 *
 * 为什么需要：hilog 在本机 2in1 上读不到应用日志（`hilog -x` 无本应用 tag），
 * 而"Dock 菜单点击到底有没有进来、WantParams 有没有带过来"只能靠文件留证。
 */
function writeActionDiag(context: Context, line: string): void {
  try {
    const f = fileIo.openSync(context.filesDir + '/quickbar-action.txt',
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    fileIo.writeSync(f.fd, new Date().toISOString() + ' ' + line + '\n');
    fileIo.closeSync(f);
  } catch (e) {
    DshmLogger.warn(TAG, '写 Dock 动作诊断失败: ' + String(e));
  }
}

export default class BackGroundAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    DshmLogger.info(TAG, 'onCreate（托盘保活进程）');
    // 用户从应用内发起整体退出时，本进程也要结束，否则托盘进程会残留。
    StatusBarTray.subscribeExitRequest((): void => {
      DshmLogger.info(TAG, '收到整体退出事件，结束后台进程');
      this.terminateSelfQuietly();
    });
    // Dock 右键菜单冷启动路径：系统以 startAbility 拉起本 Ability 并带回 WantParams。
    this.dispatchQuickBarAction(want);
  }

  /**
   * Dock 右键菜单热启动路径：目标 Ability 已存在时系统只回调 onNewWant。
   *
   * 这里必须实现，否则"应用已在后台时点 Dock 菜单"会完全没反应（冷热两条路径
   * 是系统行为，不走哪个取决于 Ability 是否存活）。
   */
  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    DshmLogger.info(TAG, 'onNewWant');
    this.dispatchQuickBarAction(want);
  }

  /**
   * 分发 Dock 菜单动作。
   *
   * quickBarManager 的菜单项只能指定 abilityName，参数经 WantParams 回传，
   * 所以动作识别放在这里。两个动作都**不把主窗口拉到前台**：
   *   - 重启：直接调 DshmAppActions.restartDsh（停旧 → 按当前模式拉起 → 等就绪），
   *     页面若存活会由 UI 轮询自然感知；窗口保持原状；
   *   - 退出：广播整体退出请求，由 EntryAbility 统一走「停 DSH → 摘托盘 → 结束」
   *     链路（与托盘右键退出、应用内退出完全同一条路），本 Ability 随后自行结束。
   */
  private dispatchQuickBarAction(want: Want): void {
    const params: Record<string, Object> | undefined = want.parameters;
    const raw: Object | undefined = params === undefined ? undefined : params[QUICKBAR_PARAM_KEY];
    // 诊断：Dock 菜单点击是否真的到达本 Ability、参数是否原样带回。
    writeActionDiag(this.context,
      'want.parameters=' + (params === undefined ? 'undefined' : JSON.stringify(params))
        + ' action=' + (raw === undefined ? '(none)' : String(raw)));
    if (params === undefined || raw === undefined) {
      return;
    }
    const action: string = String(raw);
    DshmLogger.info(TAG, '收到 Dock 菜单动作: ' + action);
    if (action === QUICKBAR_ACTION_EXIT) {
      StatusBarTray.publishExitRequest();
      this.terminateSelfQuietly();
      return;
    }
    if (action === QUICKBAR_ACTION_RESTART) {
      // dsh 的 native 子进程归属主进程（EntryAbility），本 Ability 在独立进程里，
      // 不能直接重启 —— 广播请求，由主进程执行并广播完成事件让页面换新 token 重载。
      DshmAppActions.requestRestart();
    }
  }

  private terminateSelfQuietly(): void {
    this.context.terminateSelf().then((): void => {
      DshmLogger.info(TAG, '后台进程已结束');
    }).catch((e: BusinessError): void => {
      DshmLogger.warn(TAG, '结束后台进程失败: ' + JSON.stringify(e));
    });
  }

  /**
   * 系统结束本 Ability（用户从 Dock / 托盘右键退出，或系统回收）时触发。
   * 这里只广播事件，由 EntryAbility 负责摘掉托盘图标并结束自己 —— 否则会出现
   * "后台进程已销毁、主 Ability 却还活着"的半死状态（官方文档第 8 步明确提示）。
   */
  onPrepareToTerminate(): boolean {
    DshmLogger.info(TAG, 'onPrepareToTerminate：通知主 Ability 一并退出');
    StatusBarTray.notifyBgTerminating();
    return false;
  }

  onDestroy(): void {
    DshmLogger.info(TAG, 'onDestroy');
  }
}
