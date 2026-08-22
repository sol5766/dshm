import { common } from '@kit.AbilityKit';
import { DEFAULT_SERVER_URL } from '../common/ServerDiscovery';
import { loadServerUrl, saveServerUrl, loadAutoStartEnabled, saveAutoStartEnabled } from '../common/ServerSettings';
import { WorkspaceAccess } from '../hdsh/access/WorkspaceAccess';
import { HdshLogger } from '../hdsh/utils/Logger';
import { BrewChecker, BrewCheckResult } from '../hdsh/brew/BrewChecker';
import { BrewInstaller, BrewInstallResult } from '../hdsh/brew/BrewInstaller';
import { DshServiceManager } from '../hdsh/service/DshServiceManager';

const TAG: string = 'Settings';

@Entry
@Component
struct Settings {
  @State serverUrl: string = '';
  @State autoStart: boolean = true;
  @State dshInstalled: boolean = false;
  @State brewInstalled: boolean = false;
  @State dshPath: string = '';
  @State isInstalling: boolean = false;
  @State installProgress: string = '';
  @State isServiceRunning: boolean = false;
  @State serviceUrl: string = '';
  private progressTimer: number = -1;

  aboutToAppear(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.serverUrl = loadServerUrl(context);
    this.autoStart = loadAutoStartEnabled(context);
    this.refreshInstallStatus(context);
    this.refreshServiceStatus();
  }

  private async refreshInstallStatus(context: common.UIAbilityContext): Promise<void> {
    const result: BrewCheckResult = await BrewChecker.check(context);
    this.brewInstalled = result.brewInstalled;
    this.dshInstalled = result.dshInstalled;
    this.dshPath = result.dshPath;
  }

  private refreshServiceStatus(): void {
    this.isServiceRunning = DshServiceManager.isServiceRunning();
    this.serviceUrl = DshServiceManager.getServiceUrl();
  }

  private save(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    saveServerUrl(context, this.serverUrl);
    this.getUIContext().getPromptAction().showToast({ message: '已保存，返回后重新连接' });
    this.getUIContext().getRouter().back();
  }

  private toggleAutoStart(enabled: boolean): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.autoStart = enabled;
    saveAutoStartEnabled(context, enabled);
    this.getUIContext().getPromptAction().showToast({ message: enabled ? '已开启内置后端自动启动' : '已关闭内置后端自动启动' });
  }

  private pickWorkspaceFolder(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    WorkspaceAccess.selectAndPersistFolder(context).then((uri: string) => {
      if (uri !== '') {
        this.getUIContext().getPromptAction().showToast({ message: '工作区目录已授权，内置后端将同步该目录' });
      }
    }).catch((e: Error) => {
      HdshLogger.error(TAG, '选择工作区目录失败: ' + e.message);
    });
  }

  private clearWorkspaceFolder(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    WorkspaceAccess.clearSaved(context);
    this.getUIContext().getPromptAction().showToast({ message: '已清除工作区授权记录' });
  }

  private async installDsh(): Promise<void> {
    if (this.isInstalling) {
      return;
    }
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.isInstalling = true;
    this.installProgress = '安装中…';

    this.progressTimer = setInterval(() => {
      this.installProgress = BrewInstaller.readInstallProgress(context);
    }, 1000);

    const result: BrewInstallResult = await BrewInstaller.installDsh(context);

    if (this.progressTimer >= 0) {
      clearInterval(this.progressTimer);
      this.progressTimer = -1;
    }

    this.isInstalling = false;
    if (result.success) {
      this.getUIContext().getPromptAction().showToast({ message: 'DeepSeek Harness 安装成功' });
      await this.refreshInstallStatus(context);
    } else {
      this.getUIContext().getPromptAction().showToast({ message: '安装失败：' + result.message });
      this.installProgress = '安装失败：' + result.message;
    }
  }

  private async startService(): Promise<void> {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const url: string = await DshServiceManager.startDshWeb(context, 0);
    this.refreshServiceStatus();
    if (url.length > 0) {
      this.getUIContext().getPromptAction().showToast({ message: '服务已启动：' + url });
    } else {
      this.getUIContext().getPromptAction().showToast({ message: '服务启动失败' });
    }
  }

  private async stopService(): Promise<void> {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    await DshServiceManager.stopDshWeb(context);
    this.refreshServiceStatus();
    this.getUIContext().getPromptAction().showToast({ message: '服务已停止' });
  }

  build() {
    Scroll() {
      Column({ space: 20 }) {
        Row() {
          Button('返回')
            .height(32)
            .fontSize(13)
            .backgroundColor('#E3F2EC')
            .fontColor('#2E3A36')
            .onClick(() => this.getUIContext().getRouter().back())
          Text('设置')
            .fontSize(18)
            .fontWeight(FontWeight.Bold)
            .fontColor('#2E3A36')
            .margin({ left: 12 })
        }
        .width('100%')

        // Install status section
        Column({ space: 8 }) {
          Text('安装状态')
            .fontSize(16)
            .fontWeight(FontWeight.Medium)
            .fontColor('#2E3A36')

          Row({ space: 12 }) {
            Column({ space: 4 }) {
              Text('Harmonybrew')
                .fontSize(14)
                .fontColor('#2E3A36')
              Text(this.brewInstalled ? '已安装' : '未安装')
                .fontSize(12)
                .fontColor(this.brewInstalled ? '#5CC9A8' : '#E85D5D')
            }
            .alignItems(HorizontalAlign.Start)

            Column({ space: 4 }) {
              Text('DeepSeek Harness')
                .fontSize(14)
                .fontColor('#2E3A36')
              Text(this.dshInstalled ? '已安装' : '未安装')
                .fontSize(12)
                .fontColor(this.dshInstalled ? '#5CC9A8' : '#E85D5D')
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)

            if (!this.dshInstalled) {
              Button(this.isInstalling ? '安装中…' : '安装 DSH')
                .height(32)
                .fontSize(13)
                .enabled(!this.isInstalling)
                .linearGradient({ angle: 135, colors: [['#5CC9A8', 0.0], ['#7FD8BC', 1.0]] })
                .fontColor('#FFFFFF')
                .onClick(() => this.installDsh())
            }
          }
          .width('100%')
          .alignItems(VerticalAlign.Center)

          if (this.isInstalling && this.installProgress.length > 0) {
            Scroll() {
              Text(this.installProgress)
                .fontSize(11)
                .fontFamily('monospace')
                .fontColor('#5A6B62')
            }
            .width('100%')
            .height(60)
            .backgroundColor('#EDF5F1')
            .borderRadius(8)
            .padding(8)
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding(16)
        .backgroundColor('#FFFFFF')
        .borderRadius(12)

        // Service management section
        Column({ space: 8 }) {
          Text('服务管理')
            .fontSize(16)
            .fontWeight(FontWeight.Medium)
            .fontColor('#2E3A36')

          Row({ space: 12 }) {
            Column({ space: 4 }) {
              Text('服务状态')
                .fontSize(14)
                .fontColor('#2E3A36')
              Text(this.isServiceRunning ? '运行中' : '未运行')
                .fontSize(12)
                .fontColor(this.isServiceRunning ? '#5CC9A8' : '#9AB5AB')
            }
            .alignItems(HorizontalAlign.Start)

            if (this.isServiceRunning) {
              Text(this.serviceUrl)
                .fontSize(12)
                .fontFamily('monospace')
                .fontColor('#7E9A8F')
                .layoutWeight(1)
            }

            if (this.dshInstalled) {
              if (this.isServiceRunning) {
                Button('停止')
                  .height(32)
                  .fontSize(13)
                  .backgroundColor('#F5E9E9')
                  .fontColor('#8A4B4B')
                  .onClick(() => this.stopService())
              } else {
                Button('启动服务')
                  .height(32)
                  .fontSize(13)
                  .linearGradient({ angle: 135, colors: [['#5CC9A8', 0.0], ['#7FD8BC', 1.0]] })
                  .fontColor('#FFFFFF')
                  .onClick(() => this.startService())
              }
            }
          }
          .width('100%')
          .alignItems(VerticalAlign.Center)
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding(16)
        .backgroundColor('#FFFFFF')
        .borderRadius(12)

        // Backend URL section
        Column({ space: 8 }) {
          Text('后端服务地址')
            .fontSize(14)
            .fontColor('#2E3A36')
          TextInput({ text: this.serverUrl, placeholder: DEFAULT_SERVER_URL })
            .fontSize(14)
            .backgroundColor('#EDF5F1')
            .borderRadius(8)
            .onChange((value: string) => {
              this.serverUrl = value;
            })
          Text('留空则自动探测本机 8080（登录自启）与 3080（dsh 默认）端口。保存后回到主页自动重新连接。')
            .fontSize(12)
            .fontColor('#9AB5AB')
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding(16)
        .backgroundColor('#FFFFFF')
        .borderRadius(12)

        // Auto-start toggle
        Row({ space: 12 }) {
          Column({ space: 4 }) {
            Text('打开时自动启动内置后端')
              .fontSize(14)
              .fontColor('#2E3A36')
            Text('未检测到外部 dsh 服务时，自动解压内置运行时并拉起服务（首次约 1~2 分钟）。')
              .fontSize(12)
              .fontColor('#9AB5AB')
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)
          Toggle({ type: ToggleType.Switch, isOn: this.autoStart })
            .onChange((isOn: boolean) => this.toggleAutoStart(isOn))
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
        .padding(16)
        .backgroundColor('#FFFFFF')
        .borderRadius(12)

        // Workspace section
        Row({ space: 12 }) {
          Column({ space: 4 }) {
            Text('工作区目录授权')
              .fontSize(14)
              .fontColor('#2E3A36')
            Text('内置后端在沙箱内运行，如需读写外部目录请授权（tool-fs/bash 使用）。')
              .fontSize(12)
              .fontColor('#9AB5AB')
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)
          Button('选择目录')
            .height(32)
            .fontSize(13)
            .backgroundColor('#E3F2EC')
            .fontColor('#2E3A36')
            .onClick(() => this.pickWorkspaceFolder())
          Button('清除')
            .height(32)
            .fontSize(13)
            .backgroundColor('#F5E9E9')
            .fontColor('#8A4B4B')
            .onClick(() => this.clearWorkspaceFolder())
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
        .padding(16)
        .backgroundColor('#FFFFFF')
        .borderRadius(12)

        Button('保存')
          .height(40)
          .width(160)
          .borderRadius(20)
          .fontSize(14)
          .linearGradient({ angle: 135, colors: [['#5CC9A8', 0.0], ['#7FD8BC', 1.0]] })
          .onClick(() => this.save())
      }
      .width('100%')
      .padding(24)
      .backgroundColor('#F5FAF8')
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F5FAF8')
  }
}
