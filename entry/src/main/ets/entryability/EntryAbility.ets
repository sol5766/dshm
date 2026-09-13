/**
 * DSHM EntryAbility。
 *
 * 加载 DSHM 主页面（pages/dshm/DshmWebPage）：启动时完成 DSH 环境解压、
 * 工作区授权引导与 busybox 就绪，拉起 native 子进程运行 DSH web server，
 * 由 ArkWeb 加载本地 Web UI。
 *
 * 同时负责 PC 系统托盘常驻（见 dshm/system/StatusBarTray）：
 *   - 启动时挂载托盘图标，并拉起绑定的 BackGroundAbility 维持后台保活；
 *   - 左键点托盘图标 / 右键菜单"打开" → showAbility() 把窗口唤回前台；
 *   - 系统关闭按钮（窗口右上角 X、Dock/托盘右键退出）→ 隐藏到托盘常驻；
 *   - 应用内「窗口 → 关闭窗口」或托盘右键"退出" → 真正退出（摘托盘 + 结束
 *     主 Ability，node 服务随进程回收）。
 */
import { AbilityConstant, ConfigurationConstant, UIAbility, Want, abilityAccessCtrl, Permissions } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { window } from '@kit.ArkUI';
import { setContext, clearContext, DshmAbilityContextLike } from '../GlobalContext';
import { DshmLogger } from '../dshm/utils/Logger';
import { StatusBarTray } from '../dshm/system/StatusBarTray';
import { DshmAppActions } from '../dshm/system/AppActions';
import { removeQuickBarMenu } from '../dshm/system/QuickBarMenuCleanup';

const TAG: string = 'EntryAbility';

/**
 * 需要在启动时向用户申请/引导开启的权限。
 *
 * - `ACCESS_USER_FULL_DISK`：BrewDSH 的**核心依赖**。Harmonybrew 装在
 *   `~/.harmonybrew`、工作区默认也是个人文件夹，没有它 App 读不到
 *   `/storage/Users/currentUser`（运行环境面板全显示未安装、工作区选不到
 *   个人文件夹、hostDsh 永远 missing）。属 `manual_settings` 类型：
 *   profile 只给「资格」，**必须由用户在系统设置里手动开启**。
 * - `READ_WRITE_USER_FILE` / `FILE_ACCESS_PERSIST`：个人文件读写与持久授权。
 * - `ALLOW_EXTERNAL_NATIVE_CODE`：执行包内签名的原生二进制（busybox、pty helper）。
 * - `CUSTOM_SANDBOX`：沙箱放宽，pty 终端 fork/exec 依赖它。
 *
 * 这些权限无法用 `requestPermissionsFromUser` 弹窗申请（非 user_grant 类型），
 * 只能用 `openPermissionOnSetting` 引导用户到系统设置页开启。
 */
const RUNTIME_PERMISSIONS: Array<Permissions> = [
  'ohos.permission.ACCESS_USER_FULL_DISK',
  'ohos.permission.CUSTOM_SANDBOX',
  'ohos.permission.READ_WRITE_USER_FILE',
  'ohos.permission.FILE_ACCESS_PERSIST',
  'ohos.permission.ALLOW_EXTERNAL_NATIVE_CODE'
];

export default class EntryAbility extends UIAbility {
  /**
   * 是否已发起过权限引导（每次进程生命周期只引导一轮，避免反复弹设置页）。
   */
  private hasRequestedRuntimePermissions: boolean = false;
  /**
   * 是否处于"用户主动退出"流程。为 true 时 onPrepareToTerminate 放行，
   * 否则系统关闭动作一律按"隐藏到托盘常驻"处理。
   */
  private exiting: boolean = false;
  /**
   * 托盘图标是否真的挂上了。只有挂上才允许"关闭窗口 = 隐藏到托盘"，
   * 否则用户关掉窗口后没有任何入口能唤回（实测托盘 addToStatusBar 失败时，
   * 窗口被 hideAbility 隐藏后应用再也进不去）。
   */
  private trayReady: boolean = false;
  /** 主窗口 stage（onForeground 兜底显示窗口时需要）。 */
  private stage: window.WindowStage | null = null;

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    const abilityContext = this.context as DshmAbilityContextLike;
    setContext(abilityContext);
    DshmLogger.info(TAG, 'onCreate');
    // 固定浅色模式：本应用外壳是浅色（白色顶栏 + 浅色启动页），只有让应用
    // 恒为浅色，系统才会用深色绘制窗口右上角的最小化/最大化/关闭按钮；
    // 否则系统深色模式会画成白色图标，压在白色顶栏上等于隐形（实测该区域
    // 像素全为 255 纯白）。同时启动窗口也会走 base 资源（浅底 + 深色品牌字标）。
    try {
      this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT);
      DshmLogger.info(TAG, '已固定应用为浅色模式');
    } catch (e) {
      DshmLogger.warn(TAG, '固定浅色模式失败（可忽略）: ' + String(e));
    }
    this.setupStatusBar();
  }

  onDestroy(): void {
    clearContext();
    DshmLogger.info(TAG, 'onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    DshmLogger.info(TAG, 'onWindowStageCreate');
    this.stage = windowStage;
    windowStage.loadContent('pages/dshm/DshmWebPage', (err: BusinessError): void => {
      if (err.code !== 0) {
        DshmLogger.error(TAG, '加载页面失败: ' + JSON.stringify(err));
        return;
      }
      DshmLogger.info(TAG, '页面加载成功');
      // 2in1 系统中窗口自带标题栏会在顶栏上方再渲染一行应用名，导致页面自定义
      // 顶栏看起来"被挤到下面单独一排"。隐藏系统标题栏，让应用顶栏独占最顶一线。
      try {
        const win = windowStage.getMainWindowSync();
        win.setWindowDecorVisible(false);
        win.setTitleAndDockHoverShown(false, false);
        DshmLogger.info(TAG, '已隐藏系统窗口标题栏');
      } catch (e) {
        DshmLogger.warn(TAG, '隐藏系统标题栏失败（可忽略）: ' + String(e));
      }
      // 使用系统为当前设备形态提供的默认主窗口尺寸，避免将 2in1 强制缩成手机长条比例。
    });
    // 清理旧版本在任务栏（Dock/快捷栏）右键菜单里注册的分组。
    // 该入口已废弃（原因见 QuickBarMenuCleanup.ets 头部注释），但历史注册项会留在系统里，
    // 必须主动删掉，否则用户的任务栏右键会一直挂着一个点了没反应的「重启」。
    removeQuickBarMenu(this.context).catch((e: Object): void => {
      DshmLogger.warn(TAG, 'Dock 菜单清理异常（可忽略）: ' + String(e));
    });
  }

  onForeground(): void {
    DshmLogger.info(TAG, 'onForeground');
    // 兜底：无论从 Dock、任务栏还是托盘唤回，都确保主窗口真的显示出来
    //（窗口被 hideAbility 隐藏后，仅回前台不会自动取消隐藏）。
    this.ensureWindowShown();
    // 运行时权限引导：缺 ACCESS_USER_FULL_DISK 会让整个 Harmonybrew 集成失效，
    // 因此在每次进入前台时检查并引导（每进程只引导一轮）。
    this.ensureRuntimePermissions();
  }

  /**
   * 检查运行时权限并引导用户开启。
   *
   * `ACCESS_USER_FULL_DISK` / `CUSTOM_SANDBOX` 等属受限权限，**不是**
   * `user_grant` 类型，无法用 `requestPermissionsFromUser` 弹窗申请；
   * 只能通过 `openPermissionOnSetting` 拉起系统级的权限设置页让用户手动开启。
   *
   * 检查用 `checkAccessTokenSync`（同步、无弹窗），已授予的权限不重复引导；
   * 只对**未授予**的权限调用一次设置页跳转（多个未授予权限时系统会在同一
   * 设置页内呈现，无需逐个跳转）。
   */
  private ensureRuntimePermissions(): void {
    if (this.hasRequestedRuntimePermissions) {
      return;
    }
    this.hasRequestedRuntimePermissions = true;
    try {
      const atManager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
      const tokenId: number = this.context.applicationInfo.accessTokenId;
      let firstMissing: Permissions | null = null;
      for (let i = 0; i < RUNTIME_PERMISSIONS.length; i++) {
        const permission: Permissions = RUNTIME_PERMISSIONS[i];
        try {
          const status: abilityAccessCtrl.GrantStatus =
            atManager.checkAccessTokenSync(tokenId, permission);
          const granted: boolean = (status === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED);
          DshmLogger.info(TAG, '权限 ' + permission + (granted ? ' 已授予' : ' 未授予'));
          if (!granted && firstMissing === null) {
            firstMissing = permission;
          }
        } catch (e) {
          DshmLogger.warn(TAG, '检查权限 ' + permission + ' 失败: ' + String(e));
        }
      }
      if (firstMissing !== null) {
        DshmLogger.info(TAG, '引导用户开启权限: ' + firstMissing);
        atManager.openPermissionOnSetting(this.context, firstMissing)
          .then((): void => {
            DshmLogger.info(TAG, '权限设置页已关闭');
          })
          .catch((err: BusinessError): void => {
            DshmLogger.warn(TAG, '打开权限设置页失败: ' + String(err.code) + ' ' + err.message);
          });
      }
    } catch (e) {
      DshmLogger.warn(TAG, '运行时权限检查失败（跳过）: ' + String(e));
    }
  }

  /**
   * 确保主窗口处于显示状态（Dock 左键唤回 / 托盘唤回的兜底）。
   *
   * Dock 左键点击由系统直接把任务切到前台，只保证触发 `onForeground`，**不是**
   * startAbility，所以不会走 `onNewWant`。窗口若处于**最小化**状态，仅 `showWindow()`
   * 不一定能恢复（官方对 `Window.restore()` 的说明是"主窗口最小化且 Ability 处于
   * onForeground 时恢复到前台，已在前台则仅抬升层级"，且明确 PC/2in1 可正常调用）。
   * 因此这里优先 `restore()`，失败或无效果时回退 `showWindow()` 兜底。
   */
  private ensureWindowShown(): void {
    if (this.stage === null) {
      return;
    }
    let mainWin: window.Window | null = null;
    try {
      mainWin = this.stage.getMainWindowSync();
    } catch (e) {
      DshmLogger.warn(TAG, '获取主窗口失败: ' + String(e));
      return;
    }
    if (mainWin === null) {
      return;
    }
    // 取一个非空别名给回调使用：ArkTS 不会在异步回调里保持外层变量的非空收窄，
    // 显式别名比在回调里写可选链（?.）更符合本仓库的空值处理规范。
    const target: window.Window = mainWin;
    target.restore().then((): void => {
      DshmLogger.info(TAG, '主窗口已从最小化恢复');
    }).catch((e: BusinessError): void => {
      // 未最小化时 restore 可能报错，这属正常路径，用 showWindow 兜底。
      DshmLogger.info(TAG, 'restore 未生效（' + JSON.stringify(e) + '），回退 showWindow');
      try {
        target.showWindow().then((): void => {
          DshmLogger.info(TAG, '主窗口已显示');
        }).catch((err: BusinessError): void => {
          DshmLogger.warn(TAG, '显示主窗口失败（已显示时属正常）: ' + JSON.stringify(err));
        });
      } catch (err2) {
        DshmLogger.warn(TAG, '显示主窗口异常: ' + String(err2));
      }
    });
  }

  onBackground(): void {
    DshmLogger.info(TAG, 'onBackground');
  }

  /**
   * 系统即将关闭本 Ability（窗口右上角 X、Dock/托盘右键退出）。
   *
   * 返回 true 表示拦截本次关闭：窗口隐藏但应用继续在托盘常驻，用户点托盘图标
   * 即可恢复 —— 这正是官方《PC应用通过系统托盘后台保活》的做法。用户通过应用内
   * 菜单或托盘右键主动退出时，exiting 已置位，这里放行。
   *
   * 该回调需要 ohos.permission.PREPARE_APP_TERMINATE。
   */
  onPrepareToTerminate(): boolean {
    if (this.exiting) {
      DshmLogger.info(TAG, 'onPrepareToTerminate：主动退出流程，放行');
      return false;
    }
    // 托盘不可用时绝不拦截关闭：隐藏到托盘会让应用彻底进不去（无入口唤回）。
    if (!this.trayReady) {
      DshmLogger.warn(TAG, '托盘图标未就绪，放行关闭以免窗口被隐藏后无法唤回');
      return false;
    }
    DshmLogger.info(TAG, 'onPrepareToTerminate：拦截关闭，隐藏到托盘常驻');
    this.context.hideAbility().then((): void => {
      DshmLogger.info(TAG, '窗口已隐藏，托盘图标保持常驻');
    }).catch((e: BusinessError): void => {
      DshmLogger.warn(TAG, '隐藏窗口失败: ' + JSON.stringify(e));
    });
    return true;
  }

  // ============ 系统托盘 ============

  /** 挂载托盘图标、拉起后台保活 Ability，并注册托盘交互。 */
  private setupStatusBar(): void {
    const ctx = this.context;
    try {
      // 退出事件：应用内「窗口→关闭窗口」发出的整体退出请求；
      // 以及后台 Ability 被系统结束时的联动退出。
      StatusBarTray.subscribeExitRequest((): void => {
        this.exitApp('应用内退出请求');
      });
      StatusBarTray.subscribeBgTerminating((): void => {
        this.exitApp('后台 Ability 被系统结束');
      });
      // 左键点托盘图标 → 唤回主窗口。
      StatusBarTray.onIconClick((clickType: string): void => {
        if (clickType === 'leftClick') {
          this.showMainWindow();
        }
      });
      // 托盘右键不注册自定义菜单（见 StatusBarTray.install 注释）：
      // 「打开」靠左键、「退出」由系统右键菜单自带、「重启」在应用内 Harness 菜单里。
      StatusBarTray.install(ctx).then((): void => {
        this.trayReady = true;
        // 绑定托盘进程的前置条件是"应用已有托盘图标"，故挂图标后再拉起，留一点缓冲。
        setTimeout((): void => {
          StatusBarTray.hold(ctx);
        }, 300);
      }).catch((e: Object): void => {
        DshmLogger.warn(TAG, '托盘初始化失败（不影响主流程）: ' + String(e));
      });
    } catch (e) {
      DshmLogger.warn(TAG, '托盘初始化异常（不影响主流程）: ' + String(e));
    }
  }

  /** 把主窗口唤回前台。 */
  private showMainWindow(): void {
    this.context.showAbility().then((): void => {
      DshmLogger.info(TAG, '主窗口已切到前台');
    }).catch((e: BusinessError): void => {
      DshmLogger.warn(TAG, '切换主窗口失败: ' + JSON.stringify(e));
    });
  }

  /**
   * 真正退出应用：**先停掉 DSH** → 摘掉托盘图标 → 结束主 Ability。
   *
   * 为什么要显式停 DSH：官方没有任何一句保证 `terminateSelf()` 会清理应用自己
   * spawn 的 native 子进程。宿主模式下一个 brew dsh 子进程 + 守候进程都挂在
   * `Native_libdsh_host0` 上，不先发停止信号就会残留在设备里继续占着 3080，
   * 下次启动时新实例绑不上端口。停止走 AppActions.stopForExit（有超时兜底，
   * 超时也必须继续退，避免"退不掉"）。
   *
   * 后台保活 Ability 通过公共事件一并结束（否则托盘进程残留）。
   */
  private async exitApp(reason: string): Promise<void> {
    if (this.exiting) {
      return;
    }
    this.exiting = true;
    DshmLogger.info(TAG, '开始退出应用（' + reason + '）');
    try {
      const stopped: boolean = await DshmAppActions.stopForExit(this.context);
      DshmLogger.info(TAG, '退出前停止 DSH：' + (stopped ? '已确认退出' : '超时未确认，继续退出'));
    } catch (e) {
      DshmLogger.warn(TAG, '退出前停止 DSH 失败（继续退出）: ' + String(e));
    }
    try {
      StatusBarTray.remove(this.context);
    } catch (e) {
      DshmLogger.warn(TAG, '摘除托盘图标失败: ' + String(e));
    }
    StatusBarTray.delayBeforeTerminate().then((): void => {
      this.context.terminateSelf().then((): void => {
        DshmLogger.info(TAG, '主 Ability 已结束，DSH 服务随进程回收');
      }).catch((e: BusinessError): void => {
        DshmLogger.warn(TAG, '结束主 Ability 失败: ' + JSON.stringify(e));
      });
    });
  }
}
