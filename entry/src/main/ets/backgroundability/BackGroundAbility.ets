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
import { DshmLogger } from '../dshm/utils/Logger';
import { StatusBarTray } from '../dshm/system/StatusBarTray';

const TAG: string = 'BackGroundAbility';

export default class BackGroundAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    DshmLogger.info(TAG, 'onCreate（托盘保活进程）');
    // 用户从应用内发起整体退出时，本进程也要结束，否则托盘进程会残留。
    StatusBarTray.subscribeExitRequest((): void => {
      DshmLogger.info(TAG, '收到整体退出事件，结束后台进程');
      this.context.terminateSelf().then((): void => {
        DshmLogger.info(TAG, '后台进程已结束');
      }).catch((e: BusinessError): void => {
        DshmLogger.warn(TAG, '结束后台进程失败: ' + JSON.stringify(e));
      });
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
