import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DshServiceManager } from '../hdsh/service/DshServiceManager';

const DOMAIN: number = 0xd511;
const TAG: string = 'dsh-client';

export default class EntryAbility extends UIAbility {
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
