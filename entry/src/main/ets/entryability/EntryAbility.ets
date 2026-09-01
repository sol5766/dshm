import { AbilityConstant, UIAbility, Want, abilityAccessCtrl, Permissions } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DshServiceManager } from '../hdsh/service/DshServiceManager';

const DOMAIN: number = 0xd511;
const TAG: string = 'dsh-client';

export default class EntryAbility extends UIAbility {
  private hasRequestedDirectoryPermission: boolean = false;
  private readonly directoryPermissions: Array<Permissions> = [
    'ohos.permission.READ_WRITE_USER_FILE',
    'ohos.permission.FILE_ACCESS_PERSIST',
      'ohos.permission.ACCESS_USER_FULL_DISK',
  ];
  // private readonly customSandboxPermission: Permissions = 'ohos.permission.CUSTOM_SANDBOX'; // debug 阶段跳过
    private readonly customSandboxPermission: Permissions = 'ohos.permission.CUSTOM_SANDBOX';

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, 'EntryAbility onCreate');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    // 桌面式客户端：隐藏系统标题栏装饰条，改用页面顶部自绘标题栏，
    // 使「HARNESS / EDIT / VIEW / WINDOWS」菜单栏能与右上角最小化/最大化/关闭同处一行。
    try {
      windowStage.getMainWindowSync().setWindowDecorVisible(false);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, `setWindowDecorVisible(false) failed: ${JSON.stringify(e)}`);
    }
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, `loadContent failed: ${JSON.stringify(err)}`);
        return;
      }
      hilog.info(DOMAIN, TAG, 'loadContent succeeded');
      // 内容加载完成后再确认一次装饰条隐藏（幂等，防止个别设备在 loadContent 时重置可见性）。
      try {
        windowStage.getMainWindowSync().setWindowDecorVisible(false);
      } catch (e2) {
        hilog.warn(DOMAIN, TAG, `re-apply setWindowDecorVisible(false) failed: ${JSON.stringify(e2)}`);
      }
    });
  }

  onForeground(): void {
    hilog.info(DOMAIN, TAG, 'EntryAbility onForeground');
      this.requestNativePermissions();

  }

  private requestNativePermissions(): void {
    if (this.hasRequestedDirectoryPermission) {
      return;
    }
    this.hasRequestedDirectoryPermission = true;
    const atManager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
    const tokenId: number = this.context.applicationInfo.accessTokenId;
    // 用户授权类权限（与 demo 一致）：未授予时引导到设置开启
    for (const permission of this.directoryPermissions) {
      try {
        const status = atManager.checkAccessTokenSync(tokenId, permission);
        hilog.info(DOMAIN, TAG, `native permission=${permission} status=${status}`);
        if (status !== abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED) {
          void atManager.openPermissionOnSetting(this.context, permission);
        }
      } catch (error) {
        hilog.warn(DOMAIN, TAG, `check permission ${permission} failed: ${JSON.stringify(error)}`);
      }
    }
    // CUSTOM_SANDBOX 为 system_grant（安装时由签名 ACL 授予），仅记录状态，不引导设置
    try {
      const sandboxStatus = atManager.checkAccessTokenSync(tokenId, this.customSandboxPermission);
      hilog.info(DOMAIN, TAG, `custom sandbox permission status=${sandboxStatus}`);
    } catch (error) {
      hilog.warn(DOMAIN, TAG, `check custom sandbox failed: ${JSON.stringify(error)}`);
    }
  }


  onBackground(): void {
    hilog.info(DOMAIN, TAG, 'EntryAbility onBackground');
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, 'EntryAbility onDestroy');
    // Only stop the dsh web service that was self-started by this app.
    // An externally running dsh (started by user in terminal) is left untouched.
    if (DshServiceManager.isSelfStarted()) {
      const context = this.context;
      DshServiceManager.stopDshWeb(context);
      hilog.info(DOMAIN, TAG, 'Self-started dsh web service stopped on app exit');
    }
  }
}
