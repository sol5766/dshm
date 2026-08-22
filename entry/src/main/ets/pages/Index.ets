import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { defaultCandidates, discoverServer, DEFAULT_SERVER_URL } from '../common/ServerDiscovery';
import { loadServerUrl, loadAutoStartEnabled } from '../common/ServerSettings';
import { DshBootstrap } from '../hdsh/bootstrap/DshBootstrap';
import { WorkspaceAccess } from '../hdsh/access/WorkspaceAccess';
import { writeOhosInfo } from '../hdsh/access/OhosInfoBridge';
import { BrewChecker, BrewCheckResult } from '../hdsh/brew/BrewChecker';
import { BrewInstaller, BrewInstallResult } from '../hdsh/brew/BrewInstaller';
import { DshServiceManager } from '../hdsh/service/DshServiceManager';

const DOMAIN: number = 0xd511;
const TAG: string = 'dsh-client';

type PageState = 'checking' | 'installing' | 'starting' | 'discovering' | 'booting' | 'guide' | 'web' | 'error';

const DISCOVER_MAX_ATTEMPTS: number = 5;
const DISCOVER_INTERVAL_MS: number = 2000;
const BOOT_TIMEOUT_MS: number = 120000;
const START_COMMAND: string = 'dsh web';
const INSTALL_COMMAND: string = 'brew install deepseek-harness';

@Entry
@Component
struct Index {
  @State pageState: PageState = 'checking';
  @State serverUrl: string = '';
  @State statusText: string = '正在检查环境…';
  @State autoStartEnabled: boolean = true;
  @State guideError: string = '';
  @State installProgress: string = '';
  @State dshInstalled: boolean = false;
  @State brewInstalled: boolean = false;
  @State serviceConnected: boolean = false;
  private controller: webview.WebviewController = new webview.WebviewController();
  private downloadDelegate: webview.WebDownloadDelegate = new webview.WebDownloadDelegate();
  private configuredUrl: string = '';
  private discoveryGeneration: number = 0;
  private progressTimer: number = -1;

  aboutToAppear(): void {
    this.installDownloadDelegate();
    this.startFullFlow();
  }

  onPageShow(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    if (this.configuredUrl !== '' && loadServerUrl(context) !== this.configuredUrl) {
      this.startFullFlow();
    }
  }

  private async startFullFlow(): Promise<void> {
    const gen = ++this.discoveryGeneration;
    this.pageState = 'checking';
    this.guideError = '';
    this.statusText = '正在检查环境…';
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;

    // Step 1: Check if dsh is installed
    this.statusText = '正在检测 DeepSeek Harness 安装状态…';
    const checkResult: BrewCheckResult = await BrewChecker.check(context);
    if (gen !== this.discoveryGeneration) {
      return;
    }
    this.brewInstalled = checkResult.brewInstalled;
    this.dshInstalled = checkResult.dshInstalled;

    // Step 2: If not installed, go to installing state
    if (!checkResult.dshInstalled) {
      this.pageState = 'installing';
      this.statusText = 'DeepSeek Harness 未安装，准备安装…';
      this.startProgressTimer(context);
      const installResult: BrewInstallResult = await BrewInstaller.installDsh(context);
      this.stopProgressTimer();
      if (gen !== this.discoveryGeneration) {
        return;
      }
      if (!installResult.success) {
        this.guideError = '安装失败：' + installResult.message;
        this.pageState = 'guide';
        return;
      }
      this.dshInstalled = true;
      this.brewInstalled = true;
      this.statusText = '安装完成，正在启动服务…';
    }

    // Step 3: Check if dsh web is already running
    const configured = loadServerUrl(context);
    this.configuredUrl = configured;
    this.autoStartEnabled = loadAutoStartEnabled(context);
    const candidates: string[] = defaultCandidates(configured);

    this.pageState = 'discovering';
    this.statusText = '正在检查本机 dsh 服务…';
    const existing = await discoverServer(candidates);
    if (gen !== this.discoveryGeneration) {
      return;
    }
    if (existing !== undefined) {
      this.connect(gen, existing, 'dsh server already running');
      return;
    }

    // Step 4: If dsh is installed but not running, try to start it
    if (this.dshInstalled) {
      this.pageState = 'starting';
      this.statusText = '正在启动 dsh 服务…';
      const startedUrl: string = await DshServiceManager.startDshWeb(context, 0);
      if (gen !== this.discoveryGeneration) {
        return;
      }
      if (startedUrl.length > 0) {
        // Verify with fingerprint
        const verified: string | undefined = await discoverServer([startedUrl, DEFAULT_SERVER_URL]);
        if (gen !== this.discoveryGeneration) {
          return;
        }
        if (verified !== undefined) {
          this.connect(gen, verified, 'dsh server started and verified');
          return;
        }
      }
      // Start failed or not verified, try polling
      const url = await this.pollLoop(candidates, gen);
      if (gen !== this.discoveryGeneration) {
        return;
      }
      if (url !== undefined) {
        this.connect(gen, url, 'dsh server appeared after start');
        return;
      }
    }

    // Step 5: If auto-start embedded is enabled, boot embedded runtime
    if (this.autoStartEnabled) {
      await this.bootEmbedded(gen);
      return;
    }

    this.pageState = 'guide';
  }

  private async startDiscovery(): Promise<void> {
    const gen = ++this.discoveryGeneration;
    this.pageState = 'discovering';
    this.guideError = '';
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const configured = loadServerUrl(context);
    this.configuredUrl = configured;
    this.autoStartEnabled = loadAutoStartEnabled(context);
    const candidates: string[] = defaultCandidates(configured);

    try {
      this.statusText = '正在检查本机 dsh 服务…';
      const existing = await discoverServer(candidates);
      if (existing !== undefined) {
        this.connect(gen, existing, 'dsh server already running');
        return;
      }

      const url = await this.pollLoop(candidates, gen);
      if (gen !== this.discoveryGeneration) {
        return;
      }
      if (url !== undefined) {
        this.connect(gen, url, 'dsh server appeared while polling');
        return;
      }

      if (this.autoStartEnabled) {
        await this.bootEmbedded(gen);
        return;
      }
      this.pageState = 'guide';
    } catch (error) {
      hilog.error(DOMAIN, TAG, `discovery failed: ${JSON.stringify(error)}`);
      if (gen === this.discoveryGeneration) {
        this.pageState = 'guide';
      }
    }
  }

  private async bootEmbedded(gen: number): Promise<void> {
    this.pageState = 'booting';
    this.statusText = '未检测到外部服务，正在准备内置 DSH 运行环境…';
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    try {
      await DshBootstrap.ensureDshDir(context);
      await DshBootstrap.ensureBusybox(context);
      await DshBootstrap.ensurePnpm(context);
      await WorkspaceAccess.syncAuthorizedToWorkspace(context);
      await writeOhosInfo(context);
      DshBootstrap.clearNodeLogs(context);
      this.statusText = '正在启动内置 dsh 服务（首次需解压运行环境，约 1~2 分钟）…';
      await DshBootstrap.launchDsh();
      const ready: boolean = await DshBootstrap.waitForServer(BOOT_TIMEOUT_MS);
      if (gen !== this.discoveryGeneration) {
        return;
      }
      if (!ready) {
        hilog.error(DOMAIN, TAG, 'embedded dsh server start timed out');
        await DshBootstrap.dumpNodeLogs(context);
        this.guideError = DshBootstrap.readNodeLogTail(context);
        this.pageState = 'guide';
        return;
      }
      const url = await discoverServer([DEFAULT_SERVER_URL]);
      if (gen !== this.discoveryGeneration) {
        return;
      }
      if (url !== undefined) {
        this.connect(gen, url, 'embedded dsh server ready');
        return;
      }
      this.guideError = '内置服务已就绪但指纹校验未通过，可能端口被其他程序占用。';
      this.pageState = 'guide';
    } catch (error) {
      hilog.error(DOMAIN, TAG, `embedded boot failed: ${JSON.stringify(error)}`);
      if (gen === this.discoveryGeneration) {
        this.guideError = error instanceof Error ? error.message : String(error);
        this.pageState = 'guide';
      }
    }
  }

  private connect(gen: number, url: string, reason: string): void {
    if (gen !== this.discoveryGeneration) {
      return;
    }
    hilog.info(DOMAIN, TAG, `${reason} at ${url}`);
    this.serverUrl = url;
    this.serviceConnected = true;
    this.pageState = 'web';
  }

  private async pollLoop(candidates: string[], gen: number): Promise<string | undefined> {
    for (let attempt = 1; attempt <= DISCOVER_MAX_ATTEMPTS; attempt++) {
      if (gen !== this.discoveryGeneration) {
        return undefined;
      }
      this.statusText = `正在等待 dsh 服务就绪…（已等待 ${(attempt - 1) * 3} 秒）`;
      const found = await discoverServer(candidates);
      if (found !== undefined) {
        return found;
      }
      await this.sleep(DISCOVER_INTERVAL_MS);
    }
    return undefined;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private startProgressTimer(context: common.UIAbilityContext): void {
    this.stopProgressTimer();
    this.progressTimer = setInterval(() => {
      this.installProgress = BrewInstaller.readInstallProgress(context);
    }, 1000);
  }

  private stopProgressTimer(): void {
    if (this.progressTimer >= 0) {
      clearInterval(this.progressTimer);
      this.progressTimer = -1;
    }
  }

  private installDownloadDelegate(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const downloadDir = `${context.filesDir}/download`;
    try {
      if (!fs.accessSync(downloadDir)) {
        fs.mkdirSync(downloadDir, true);
      }
    } catch (error) {
      hilog.error(DOMAIN, TAG, `mkdir ${downloadDir} failed: ${JSON.stringify(error)}`);
    }
    this.downloadDelegate.onBeforeDownload((item: webview.WebDownloadItem) => {
      const target = `${downloadDir}/${item.getSuggestedFileName()}`;
      hilog.info(DOMAIN, TAG, `download start: ${target}`);
      item.start(target);
    });
    this.downloadDelegate.onDownloadFinish((item: webview.WebDownloadItem) => {
      this.getUIContext().getPromptAction().showToast({ message: `下载完成：应用沙箱/download/${item.getSuggestedFileName()}` });
    });
    this.downloadDelegate.onDownloadFailed((item: webview.WebDownloadItem) => {
      this.getUIContext().getPromptAction().showToast({ message: `下载失败：${item.getSuggestedFileName()}` });
    });
    webview.WebDownloadManager.setDownloadDelegate(this.downloadDelegate);
  }

  private handleFileSelector(event: OnShowFileSelectorEvent): boolean {
    const context = this.getUIContext().getHostContext() as common.Context;
    const documentPicker = new picker.DocumentViewPicker(context);
    const options = new picker.DocumentSelectOptions();
    documentPicker.select(options).then((uris: string[]) => {
      event.result.handleFileList(uris);
    }).catch(() => {
      event.result.handleFileList([]);
    });
    return true;
  }

  private copyStartCommand(): void {
    const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, START_COMMAND);
    pasteboard.getSystemPasteboard().setData(data).then(() => {
      this.getUIContext().getPromptAction().showToast({ message: '已复制启动命令' });
    }).catch(() => {
      this.getUIContext().getPromptAction().showToast({ message: '复制失败' });
    });
  }

  private copyInstallCommand(): void {
    const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, INSTALL_COMMAND);
    pasteboard.getSystemPasteboard().setData(data).then(() => {
      this.getUIContext().getPromptAction().showToast({ message: '已复制安装命令' });
    }).catch(() => {
      this.getUIContext().getPromptAction().showToast({ message: '复制失败' });
    });
  }

  private openSettings(): void {
    this.getUIContext().getRouter().pushUrl({ url: 'pages/Settings' });
  }

  private bailToGuide(): void {
    this.discoveryGeneration++;
    this.stopProgressTimer();
    this.pageState = 'guide';
  }

  private retryFromGuide(): void {
    if (this.dshInstalled) {
      this.startDiscovery();
    } else {
      this.startFullFlow();
    }
  }

  private reloadWeb(): void {
    if (this.pageState === 'web') {
      this.controller.refresh();
    }
  }

  build() {
    Stack() {
      if (this.pageState === 'web') {
        Web({ src: this.serverUrl, controller: this.controller })
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .fileAccess(true)
          .onlineImageAccess(true)
          .mixedMode(MixedMode.All)
          .cacheMode(CacheMode.Default)
          .onShowFileSelector((event: OnShowFileSelectorEvent) => this.handleFileSelector(event))
          .onErrorReceive((event: OnErrorReceiveEvent) => {
            if (event.request.isMainFrame()) {
              hilog.error(DOMAIN, TAG, `main frame error: ${event.error.getErrorInfo()}`);
              this.serviceConnected = false;
              this.pageState = 'error';
            }
          })
          .onHttpErrorReceive((event: OnHttpErrorReceiveEvent) => {
            if (event.request.isMainFrame() && event.response.getResponseCode() >= 400) {
              hilog.error(DOMAIN, TAG, `main frame http ${event.response.getResponseCode()}`);
            }
          })
          .width('100%')
          .height('100%')

        // Connection status indicator
        Row() {
          Circle({ width: 8, height: 8 })
            .fill(this.serviceConnected ? '#5CC9A8' : '#E85D5D')
          Text(this.serviceConnected ? '已连接' : '已断线')
            .fontSize(11)
            .fontColor('#FFFFFF')
            .margin({ left: 4 })
        }
        .padding({ left: 8, right: 8, top: 4, bottom: 4 })
        .borderRadius(12)
        .backgroundColor(this.serviceConnected ? '#3A5A4A' : '#5A3A3A')
        .position({ x: '100%', y: 12 })
        .markAnchor({ x: '100%', y: 0 })
        .translate({ x: -12, y: 0 })
        .onClick(() => {
          if (!this.serviceConnected) {
            this.startDiscovery();
          }
        })
      } else {
        this.StatusView()
      }

      // Settings entry (not in web mode - web has its own)
      if (this.pageState !== 'web') {
        Button('设置')
          .height(32)
          .fontSize(13)
          .fontColor('#2E3A36')
          .backgroundColor('#CCFFFFFF')
          .borderRadius(16)
          .position({ x: '100%', y: 12 })
          .markAnchor({ x: '100%', y: 0 })
          .translate({ x: -12, y: 0 })
          .onClick(() => this.openSettings())
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F5FAF8')
  }

  @Builder
  StatusView() {
    Column({ space: 16 }) {
      Image($r('app.media.icon'))
        .width(96)
        .height(96)
        .borderRadius(24)

      Text('DSHM')
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
        .fontColor('#2E3A36')

      if (this.pageState === 'checking') {
        LoadingProgress()
          .width(40)
          .height(40)
          .color('#5CC9A8')
        Text(this.statusText)
          .fontSize(13)
          .fontColor('#7E9A8F')
          .textAlign(TextAlign.Center)
          .padding({ left: 24, right: 24 })
      } else if (this.pageState === 'installing') {
        LoadingProgress()
          .width(40)
          .height(40)
          .color('#5CC9A8')
        Text(this.statusText)
          .fontSize(14)
          .fontColor('#2E3A36')
          .fontWeight(FontWeight.Medium)
        Text('正在通过 Harmonybrew 安装 DeepSeek Harness，请耐心等待…')
          .fontSize(12)
          .fontColor('#7E9A8F')
          .textAlign(TextAlign.Center)

        if (this.installProgress.length > 0) {
          Scroll() {
            Text(this.installProgress)
              .fontSize(11)
              .fontFamily('monospace')
              .fontColor('#5A6B62')
              .textAlign(TextAlign.Start)
          }
          .width('90%')
          .height(120)
          .backgroundColor('#EDF5F1')
          .borderRadius(8)
          .padding(8)
        }

        Button('跳过，手动安装')
          .height(36)
          .fontSize(13)
          .backgroundColor('#E3F2EC')
          .fontColor('#2E3A36')
          .onClick(() => this.bailToGuide())
      } else if (this.pageState === 'starting') {
        LoadingProgress()
          .width(40)
          .height(40)
          .color('#5CC9A8')
        Text(this.statusText)
          .fontSize(14)
          .fontColor('#2E3A36')
        Text('dsh web 服务启动中…')
          .fontSize(12)
          .fontColor('#7E9A8F')

        Button('跳过，手动启动')
          .height(36)
          .fontSize(13)
          .backgroundColor('#E3F2EC')
          .fontColor('#2E3A36')
          .onClick(() => this.bailToGuide())
      } else if (this.pageState === 'discovering' || this.pageState === 'booting') {
        LoadingProgress()
          .width(40)
          .height(40)
          .color('#5CC9A8')
        Text(this.statusText)
          .fontSize(13)
          .fontColor('#7E9A8F')
          .textAlign(TextAlign.Center)
          .padding({ left: 24, right: 24 })

        if (this.pageState === 'booting') {
          Button('跳过，手动启动')
            .height(36)
            .fontSize(13)
            .backgroundColor('#E3F2EC')
            .fontColor('#2E3A36')
            .onClick(() => this.bailToGuide())
        }
      } else {
        // guide or error state
        Text(this.pageState === 'error' ? '页面加载失败，dsh 服务可能已停止。' : '未找到运行中的 dsh 服务。')
          .fontSize(14)
          .fontColor('#7E9A8F')

        if (!this.dshInstalled) {
          Column({ space: 8 }) {
            Text('DeepSeek Harness 尚未安装。请在终端执行：')
              .fontSize(13)
              .fontColor('#2E3A36')
            Row({ space: 8 }) {
              Text(INSTALL_COMMAND)
                .fontSize(14)
                .fontFamily('monospace')
                .fontColor('#2E3A36')
                .padding({ left: 12, right: 12, top: 6, bottom: 6 })
                .backgroundColor('#E3F2EC')
                .borderRadius(8)
              Button('复制')
                .height(32)
                .fontSize(13)
                .onClick(() => this.copyInstallCommand())
            }
            Text('安装完成后再启动服务：')
              .fontSize(13)
              .fontColor('#2E3A36')
              .margin({ top: 4 })
            Row({ space: 8 }) {
              Text(START_COMMAND)
                .fontSize(14)
                .fontFamily('monospace')
                .fontColor('#2E3A36')
                .padding({ left: 12, right: 12, top: 6, bottom: 6 })
                .backgroundColor('#E3F2EC')
                .borderRadius(8)
              Button('复制')
                .height(32)
                .fontSize(13)
                .onClick(() => this.copyStartCommand())
            }
          }
          .alignItems(HorizontalAlign.Center)
        } else {
          Text(this.autoStartEnabled
            ? '已尝试自动启动内置后端但未成功。也可在终端手动启动后重连：'
            : '请先在终端启动后端服务：')
            .fontSize(13)
            .fontColor('#2E3A36')
          Row({ space: 8 }) {
            Text(START_COMMAND)
              .fontSize(14)
              .fontFamily('monospace')
              .fontColor('#2E3A36')
              .padding({ left: 12, right: 12, top: 6, bottom: 6 })
              .backgroundColor('#E3F2EC')
              .borderRadius(8)
            Button('复制')
              .height(32)
              .fontSize(13)
              .onClick(() => this.copyStartCommand())
          }
        }

        Text('启动后点「重新连接」。')
          .fontSize(12)
          .fontColor('#9AB5AB')
          .textAlign(TextAlign.Center)

        if (this.guideError.length > 0) {
          Text(this.guideError)
            .fontSize(11)
            .fontFamily('monospace')
            .fontColor('#8A4B4B')
            .backgroundColor('#FBF0F0')
            .borderRadius(8)
            .padding(10)
            .textAlign(TextAlign.Start)
            .maxLines(12)
            .width('90%')
        }

        Row({ space: 12 }) {
          Button('重新连接')
            .height(40)
            .borderRadius(20)
            .fontSize(14)
            .linearGradient({ angle: 135, colors: [['#5CC9A8', 0.0], ['#7FD8BC', 1.0]] })
            .onClick(() => {
              this.retryFromGuide();
            })
          if (this.dshInstalled) {
            Button('启动服务')
              .height(40)
              .borderRadius(20)
              .fontSize(14)
              .backgroundColor('#E3F2EC')
              .fontColor('#2E3A36')
              .onClick(async () => {
                const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
                const url: string = await DshServiceManager.startDshWeb(context, 0);
                if (url.length > 0) {
                  const verified: string | undefined = await discoverServer([url, DEFAULT_SERVER_URL]);
                  if (verified !== undefined) {
                    this.connect(this.discoveryGeneration, verified, 'dsh started from guide');
                    return;
                  }
                }
                this.guideError = '服务启动失败，请尝试手动启动';
              })
          }
        }
      }
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .padding(24)
  }
}
