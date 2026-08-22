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
      'ohos.permission.ALLOW_EXTERNAL_NATIVE_CODE',
    // 'ohos.permission.ACCESS_USER_FULL_DISK', // debug 阶段跳过，正式申请后再启用
    // 'ohos.permission.ALLOW_EXTERNAL_NATIVE_CODE' // debug 阶段跳过，正式申请后再启用
  ];
  // private readonly customSandboxPermission: Permissions = 'ohos.permission.CUSTOM_SANDBOX'; // debug 阶段跳过
    private readonly customSandboxPermission: Permissions = 'ohos.permission.CUSTOM_SANDBOX';

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, 'EntryAbility onCreate');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, `loadContent failed: ${JSON.stringify(err)}`);
        return;
      }
      hilog.info(DOMAIN, TAG, 'loadContent succeeded');
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
    const allPermissions: Array<Permissions> = [...this.directoryPermissions, this.customSandboxPermission];
    for (const permission of allPermissions) {
      try {
        const status = atManager.checkAccessTokenSync(tokenId, permission);
        hilog.info(DOMAIN, TAG, `native permission=${permission} status=${status}`);
        if (status !== abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED) {
          // CUSTOM_SANDBOX / ALLOW_EXTERNAL_NATIVE_CODE / ACCESS_USER_FULL_DISK
          // 可能由系统安装时授予或需用户到设置开启；统一引导到设置。
          void atManager.openPermissionOnSetting(this.context, permission);
        }
      } catch (error) {
        hilog.warn(DOMAIN, TAG, `check permission ${permission} failed: ${JSON.stringify(error)}`);
      }
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
