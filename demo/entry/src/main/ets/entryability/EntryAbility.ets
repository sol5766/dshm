import { AbilityConstant, ConfigurationConstant, UIAbility, Want, abilityAccessCtrl, Permissions } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';

const DOMAIN = 0x0000;

export default class EntryAbility extends UIAbility {
  private hasRequestedDirectoryPermission: boolean = false;
  private readonly directoryPermissions: Array<Permissions> = [
    'ohos.permission.READ_WRITE_USER_FILE',
    'ohos.permission.FILE_ACCESS_PERSIST',
    'ohos.permission.ACCESS_USER_FULL_DISK'
  ];

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    try {
      this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
    } catch (err) {
      hilog.error(DOMAIN, 'testTag', 'Failed to set colorMode. Cause: %{public}s', JSON.stringify(err));
    }
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onCreate');
  }

  onDestroy(): void {
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    // Main window is created, set main page for this ability
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onWindowStageCreate');

    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, 'testTag', 'Failed to load the content. Cause: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, 'testTag', 'Succeeded in loading the content.');
    });
  }

  onWindowStageDestroy(): void {
    // Main window is destroyed, release UI related resources
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onWindowStageDestroy');
  }

  onForeground(): void {
    // Ability has brought to foreground
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onForeground');
    if (this.hasRequestedDirectoryPermission) {
      return;
    }
    this.hasRequestedDirectoryPermission = true;
    const atManager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
    const tokenId: number = this.context.applicationInfo.accessTokenId;
    for (const permission of this.directoryPermissions) {
      const status = atManager.checkAccessTokenSync(tokenId, permission);
      hilog.info(DOMAIN, 'testTag', 'directory permission=%{public}s status=%{public}d', permission, status);
      if (status !== abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED) {
        void atManager.openPermissionOnSetting(this.context, permission);
      }
    }
  }

  onBackground(): void {
    // Ability has back to background
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onBackground');
  }
}
