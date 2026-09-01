import { webview } from '@kit.ArkWeb';
import { window } from '@kit.ArkUI';
import { common, Want } from '@kit.AbilityKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { defaultCandidates, discoverServer, DEFAULT_SERVER_URL } from '../common/ServerDiscovery';
import { loadServerUrl } from '../common/ServerSettings';
import { WorkspaceAccess } from '../hdsh/access/WorkspaceAccess';
import { BrewChecker, BrewCheckResult } from '../hdsh/brew/BrewChecker';
import { InstallManager } from '../hdsh/install/InstallManager';
import { DshServiceManager } from '../hdsh/service/DshServiceManager';
import launcher from 'libdsh_launcher.so';
import { AppMenuBar } from '../hdsh/ui/AppMenuBar';
import { http } from '@kit.NetworkKit';

const DOMAIN: number = 0xd511;
const TAG: string = 'dsh-client';

type PageState = 'checking' | 'installing' | 'starting' | 'discovering' | 'guide' | 'web' | 'error';

const DISCOVER_MAX_ATTEMPTS: number = 5;
const DISCOVER_INTERVAL_MS: number = 2000;
const START_COMMAND: string = 'dsh web';
const INSTALL_COMMAND: string = 'brew install deepseek-harness';

@Entry
@Component
struct Index {
  @State pageState: PageState = 'checking';
  @State serverUrl: string = '';
  @State statusText: string = '正在检查环境…';
  @State guideError: string = '';
  @State installProgress: string = '';
  @State dshInstalled: boolean = true;
  @State brewInstalled: boolean = false;
  @State serviceConnected: boolean = false;
  @State isInstalling: boolean = false;
  private controller: webview.WebviewController = new webview.WebviewController();
  private downloadDelegate: webview.WebDownloadDelegate = new webview.WebDownloadDelegate();
  private configuredUrl: string = '';
  private discoveryGeneration: number = 0;
  private progressTimer: number = -1;
  private flowWatchdog: number = -1;
  private pendingStart: boolean = false;

  aboutToAppear(): void {
    // 冷启动时 getUIContext() 在 aboutToAppear 阶段可能尚未就绪，
    // 直接调用会抛异常导致 startFullFlow 静默中断（表现为不自动拉起）。
    // 统一推迟到 onPageShow（UI 上下文就绪后）执行。
    this.pendingStart = true;
  }

  onPageShow(): void {
    if (this.pendingStart) {
      this.pendingStart = false;
      this.installDownloadDelegate();
      this.startFullFlow();
      return;
    }
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    if (this.configuredUrl !== '' && loadServerUrl(context) !== this.configuredUrl) {
      this.startFullFlow();
    }
  }

  private async startFullFlow(): Promise<void> {
    const gen = ++this.discoveryGeneration;
    this.pageState = 'checking';
    this.guideError = '';
    this.statusText = '正在准备 dsh 服务…';
    this.armWatchdog(gen);
    try {
      await this.fullFlowBody(gen);
    } catch (error) {
      const msg: string = error instanceof Error ? error.message : String(error);
      hilog.error(DOMAIN, TAG, `startFullFlow failed: ${msg}`);
      this.physTrace('startFullFlow error: ' + msg);
      if (gen === this.discoveryGeneration) {
        this.guideError = '自动连接出错：' + msg;
        this.pageState = 'guide';
      }
    }
  }

  private async fullFlowBody(gen: number): Promise<void> {
    this.physTrace('startFullFlow begin');
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;

    const configured = loadServerUrl(context);
    this.configuredUrl = configured;
    const candidates: string[] = defaultCandidates(configured);

    // 恢复工作区持久授权（best-effort，不阻塞启动）
    WorkspaceAccess.activatePersisted(context);

    // 探活本机服务 + 检测安装状态（ArkTS 不支持解构，顺序执行）
    this.pageState = 'discovering';
    this.statusText = '正在检查本机 dsh 服务…';
    this.physTrace('discovering...');
    const existing: string | undefined = await discoverServer(candidates);
    const installStatus: BrewCheckResult = await BrewChecker.check(context);
    this.dshInstalled = installStatus.dshInstalled;
    this.brewInstalled = installStatus.brewInstalled;
    this.physTrace('installStatus: brew=' + this.brewInstalled + ' dsh=' + this.dshInstalled);
    if (gen !== this.discoveryGeneration) {
      return;
    }
    if (existing !== undefined) {
      this.connect(gen, existing, 'dsh server already running');
      return;
    }
    // 未安装且无服务：直接进引导页，提供一键安装
    if (!this.dshInstalled) {
      this.physTrace('dsh not installed, guide to install');
      this.guideError = '未检测到 dsh 服务，可点击下方按钮一键安装。';
      this.pageState = 'guide';
      return;
    }
    this.physTrace('no existing server, launching');

    // Step 2: 未运行则自动拉起 dsh web
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

    // Step 3: 启动失败，展示引导（未安装可一键安装，已安装提示手动启动）
    this.physTrace('flow reached guide');
    this.guideError = this.dshInstalled
      ? 'dsh 服务启动超时。请确认已在终端执行过 dsh web，或点击「重新连接」重试。'
      : '未检测到 dsh 服务，可点击下方按钮一键安装。';
    this.pageState = 'guide';
  }

  private async startDiscovery(): Promise<void> {
    const gen = ++this.discoveryGeneration;
    this.pageState = 'discovering';
    this.guideError = '';
    this.armWatchdog(gen);
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const configured = loadServerUrl(context);
    this.configuredUrl = configured;
    const candidates: string[] = defaultCandidates(configured);

    try {
      this.statusText = '正在检查本机 dsh 服务…';
      const existing = await discoverServer(candidates);
      if (existing !== undefined) {
        this.connect(gen, existing, 'dsh server already running');
        return;
      }

      this.statusText = '正在启动 dsh 服务…';
      const startedUrl: string = await DshServiceManager.startDshWeb(context, 0);
      if (gen !== this.discoveryGeneration) {
        return;
      }
      if (startedUrl.length > 0) {
        const verified: string | undefined = await discoverServer([startedUrl, DEFAULT_SERVER_URL]);
        if (gen !== this.discoveryGeneration) {
          return;
        }
        if (verified !== undefined) {
          this.connect(gen, verified, 'dsh server started and verified');
          return;
        }
      }
      const url = await this.pollLoop(candidates, gen);
      if (gen !== this.discoveryGeneration) {
        return;
      }
      if (url !== undefined) {
        this.connect(gen, url, 'dsh server appeared while polling');
        return;
      }

      this.guideError = this.dshInstalled
        ? 'dsh 服务启动超时。请确认已在终端执行过 dsh web，或点击「重新连接」重试。'
        : '未检测到 dsh 服务，可点击下方按钮一键安装。';
      this.pageState = 'guide';
    } catch (error) {
      hilog.error(DOMAIN, TAG, `discovery failed: ${JSON.stringify(error)}`);
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
    this.disarmWatchdog();
    this.serverUrl = url;
    this.serviceConnected = true;
    this.pageState = 'web';
  }

  /** 冷启动流程看门狗：发现/拉起/验证整体 90 秒内必须出结果，否则进引导页并说明当前卡点。 */
  private armWatchdog(gen: number): void {
    this.disarmWatchdog();
    this.flowWatchdog = setTimeout(() => {
      if (gen !== this.discoveryGeneration || this.pageState === 'web' || this.pageState === 'guide') {
        return;
      }
      this.flowWatchdog = -1;
      hilog.error(DOMAIN, TAG, `cold start flow timed out at phase: ${this.statusText}`);
      this.pageState = 'guide';
      this.guideError = `自动连接超时（卡在：${this.statusText}）。服务可能已就绪，点「重新连接」重试，或到设置页手动启动服务。`;
    }, 90000);
  }

  private disarmWatchdog(): void {
    if (this.flowWatchdog >= 0) {
      clearTimeout(this.flowWatchdog);
      this.flowWatchdog = -1;
    }
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

  /** 镜像一行日志到物理机 ~/dshm-launcher.log（best-effort，失败忽略）。 */
  private physTrace(msg: string): void {
    try {
      launcher.physTrace(msg);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, `physTrace failed: ${String(e)}`);
    }
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
    try {
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
    } catch (error) {
      hilog.error(DOMAIN, TAG, `install download delegate failed: ${JSON.stringify(error)}`);
    }
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
    this.startDiscovery();
  }

  // 引导页一键安装 DeepSeek Harness（NAPI 主进程执行），带进度条
  private installFromGuide(): void {
    if (InstallManager.isInstalling) {
      return;
    }
    this.isInstalling = true;
    this.installProgress = '正在安装 DeepSeek Harness…';
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    InstallManager.startInstall(context, 'dsh',
      (tail: string) => {
        this.installProgress = tail;
      },
      (success: boolean) => {
        this.isInstalling = false;
        if (success) {
          this.dshInstalled = true;
          this.getUIContext().getPromptAction().showToast({ message: 'DeepSeek Harness 安装成功，正在连接…' });
          this.startDiscovery();
        } else {
          this.guideError = '安装失败，可查看日志后重试，或在终端手动安装。';
          this.getUIContext().getPromptAction().showToast({ message: '安装失败' });
        }
      });
  }

  private reloadWeb(): void {
    if (this.pageState === 'web') {
      this.controller.refresh();
    }
  }

  private goToDefaultUrl(): void {
    if (this.pageState !== 'web') {
      return;
    }
    // 即便当前 URL 已是 3080，也强制重载，保证「回到默认页」语义生效
    this.controller.loadUrl(DEFAULT_SERVER_URL);
    this.serverUrl = DEFAULT_SERVER_URL;
  }


  // ==== 菜单栏回调实现 ====

  private async restartApp(): Promise<void> {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const want: Want = {
      bundleName: context.abilityInfo.bundleName,
      abilityName: context.abilityInfo.name
    };
    this.physTrace('client restart requested');
    try {
      // 先停掉自启服务：令 currentService=undefined，避免旧实例 onDestroy 在短暂窗口误停刚起的服务；
      // 也让新实例以全新状态重新拉起服务并连接。
      if (DshServiceManager.isSelfStarted()) {
        await DshServiceManager.stopDshWeb(context);
      }
      // 先新建实例（module.json5 已设 launchType=multiton，startAbility 会新建窗口/实例），
      // 成功后再关掉旧实例；否则异常时序下会「只关没开」。
      await context.startAbility(want);
      context.terminateSelf();
    } catch (e) {
      const msg: string = e instanceof Error ? e.message : String(e);
      hilog.error(DOMAIN, TAG, `restart failed: ${msg}`);
      this.getUIContext().getPromptAction().showToast({ message: '重启失败: ' + msg });
    }
  }

  private newSessionFromMenu(): void {
    if (this.pageState !== 'web') {
      return;
    }
    this.controller.runJavaScript("(function(){var keys=['new session','new chat','new conversation','new chat session','new','新会话','新对话','新建','新聊天'];var els=document.querySelectorAll('button,a,[role=button],[data-command],[data-testid],[aria-label]');for(var i=0;i<els.length;i++){var el=els[i];var t=(el.textContent||'').trim().toLowerCase();var al=(el.getAttribute('aria-label')||'').toLowerCase();var dl=(el.getAttribute('data-label')||'').toLowerCase();var dc=(el.getAttribute('data-command')||'').toLowerCase();var dt=(el.getAttribute('data-testid')||'').toLowerCase();for(var k=0;k<keys.length;k++){var key=keys[k];if(t===key||t.indexOf(key)===0||al.indexOf(key)>=0||dl.indexOf(key)>=0||dc.indexOf(key)>=0||dt.indexOf(key)>=0){el.click();return 'ok'}}}return 'not-found'})()").catch(() => {});
  }

  private openWorkspaceFromMenu(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    WorkspaceAccess.selectAndPersistFolder(context).then((uri: string) => {
      if (uri !== '') {
        this.getUIContext().getPromptAction().showToast({ message: '工作区目录已授权' });
        if (this.pageState === 'web') {
          this.controller.runJavaScript("window.dispatchEvent(new CustomEvent('dshm:workspace',{detail:'" + uri + "'}))").catch(() => {});
        }
      }
    }).catch((e: Error) => {
      hilog.warn(DOMAIN, TAG, `open workspace failed: ${e.message}`);
    });
  }

  private startServiceFromMenu(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    DshServiceManager.startDshWeb(context, 0).then((url: string) => {
      if (url.length > 0) {
        this.getUIContext().getPromptAction().showToast({ message: '服务已启动：' + url });
        this.startDiscovery();
      }
    }).catch((e: Error) => {
      this.getUIContext().getPromptAction().showToast({ message: '服务启动失败：' + e.message });
    });
  }

  private stopServiceFromMenu(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    DshServiceManager.stopDshWeb(context);
    this.getUIContext().getPromptAction().showToast({ message: '已停止自启动服务' });
  }

  private installDshFromMenu(): void {
    if (InstallManager.isInstalling) {
      return;
    }
    this.isInstalling = true;
    this.installProgress = '正在安装 DeepSeek Harness…';
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    InstallManager.startInstall(context, 'dsh',
      (tail: string) => { this.installProgress = tail; },
      (success: boolean) => {
        this.isInstalling = false;
        if (success) {
          this.dshInstalled = true;
          this.getUIContext().getPromptAction().showToast({ message: 'DeepSeek Harness 安装成功' });
          this.startDiscovery();
        } else {
          this.guideError = '安装失败，详情见日志。';
          this.getUIContext().getPromptAction().showToast({ message: '安装失败' });
        }
      });
  }

  private installBrewFromMenu(): void {
    if (InstallManager.isInstalling) {
      return;
    }
    this.isInstalling = true;
    this.installProgress = '正在安装 Harmonybrew…';
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    InstallManager.startInstall(context, 'brew',
      (tail: string) => { this.installProgress = tail; },
      (success: boolean) => {
        this.isInstalling = false;
        if (success) {
          this.brewInstalled = true;
          this.getUIContext().getPromptAction().showToast({ message: 'Harmonybrew 安装成功' });
        } else {
          this.getUIContext().getPromptAction().showToast({ message: '安装失败，详情见日志' });
        }
      });
  }

  private async checkUpdateFromMenu(): Promise<void> {
    const currentTag: string = 'v1.1.0';
    const req = http.createHttp();
    try {
      const response = await req.request('https://api.github.com/repos/sol5766/dshm/releases/latest', {
        method: http.RequestMethod.GET,
        expectDataType: http.HttpDataType.STRING
      });
      const body: string = response.result as string;
      const m: RegExpMatchArray | null = body.match(/"tag_name"\s*:\s*"([^"]+)"/);
      const latest: string = m !== null && m.length > 1 ? m[1] : '';
      if (latest.length > 0 && latest !== currentTag) {
        this.getUIContext().getPromptAction().showToast({ message: '发现新版本：' + latest });
      } else {
        this.getUIContext().getPromptAction().showToast({ message: '已是最新版本' });
      }
    } catch (e) {
      this.getUIContext().getPromptAction().showToast({ message: '检查更新失败，请检查网络' });
    } finally {
      req.destroy();
    }
  }

  private closeWindowFromMenu(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    context.terminateSelf();
  }

  // ==== 窗口操作：统一在 Index 取 UIAbilityContext（菜单动作里取上下文可靠，
  // 避免 AppMenuBar 内部 getUIContext 在菜单弹层场景失效导致「点了没反应」）====

  private minimizeWindow(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    window.getLastWindow(context).then((win: window.Window) => {
      win.minimize().catch(() => {});
    }).catch((e: Error) => {
      hilog.warn(DOMAIN, TAG, `minimize failed: ${e.message}`);
      this.getUIContext().getPromptAction().showToast({ message: '最小化失败: ' + e.message });
    });
  }

  private toggleMaximizeWindow(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    window.getLastWindow(context).then((win: window.Window) => {
      try {
        const st = win.getWindowStatus();
        if (st === window.WindowStatusType.MAXIMIZE || st === window.WindowStatusType.FULL_SCREEN) {
          win.restore().catch(() => {});
        } else {
          win.maximize().catch(() => {});
        }
      } catch (e) {
        hilog.warn(DOMAIN, TAG, `toggle maximize getStatus failed: ${String(e)}`);
        this.getUIContext().getPromptAction().showToast({ message: '最大化状态读取失败: ' + String(e) });
      }
    }).catch((e: Error) => {
      hilog.warn(DOMAIN, TAG, `toggle maximize failed: ${e.message}`);
      this.getUIContext().getPromptAction().showToast({ message: '最大化/还原失败: ' + e.message });
    });
  }

  private restoreWindow(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    window.getLastWindow(context).then((win: window.Window) => {
      win.restore().catch(() => {});
    }).catch((e: Error) => {
      hilog.warn(DOMAIN, TAG, `restore failed: ${e.message}`);
      this.getUIContext().getPromptAction().showToast({ message: '还原失败: ' + e.message });
    });
  }

  private startWindowMove(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    window.getLastWindow(context).then((win: window.Window) => {
      try {
        const st = win.getWindowStatus();
        if (st === window.WindowStatusType.MAXIMIZE || st === window.WindowStatusType.FULL_SCREEN) {
          return;
        }
      } catch (e) { /* 非最大化状态下允许拖动 */ }
      win.startMoving().catch(() => {});
    }).catch((e: Error) => {
      hilog.warn(DOMAIN, TAG, `startMoving failed: ${e.message}`);
      this.getUIContext().getPromptAction().showToast({ message: '拖动失败: ' + e.message });
    });
  }

  build() {
    Column() {
      AppMenuBar({
        controller: this.controller,
        serviceConnected: this.serviceConnected,
        onOpenSettings: () => this.openSettings(),
        onRestart: () => this.restartApp(),
        onStartService: () => this.startServiceFromMenu(),
        onStopService: () => this.stopServiceFromMenu(),
        onInstallDsh: () => this.installDshFromMenu(),
        onInstallBrew: () => this.installBrewFromMenu(),
        onOpenWorkspace: () => this.openWorkspaceFromMenu(),
        onReloadWeb: () => this.reloadWeb(),
        onGoDefaultUrl: () => this.goToDefaultUrl(),
        onNewSession: () => this.newSessionFromMenu(),
        onCheckUpdate: () => this.checkUpdateFromMenu(),
        onMinimize: () => this.minimizeWindow(),
        onToggleMaximize: () => this.toggleMaximizeWindow(),
        onRestore: () => this.restoreWindow(),
        onStartMove: () => this.startWindowMove(),
        onCloseWindow: () => this.closeWindowFromMenu()
      })

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

      } else {
        this.StatusView()
      }

      }
      .width('100%')
      .layoutWeight(1)
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
          .color('#000000')
        Text(this.statusText)
          .fontSize(13)
          .fontColor('#7E9A8F')
          .textAlign(TextAlign.Center)
          .padding({ left: 24, right: 24 })
      } else if (this.pageState === 'installing') {
        LoadingProgress()
          .width(40)
          .height(40)
          .color('#000000')
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
          .color('#000000')
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
      } else if (this.pageState === 'discovering') {
        LoadingProgress()
          .width(40)
          .height(40)
          .color('#000000')
        Text(this.statusText)
          .fontSize(13)
          .fontColor('#7E9A8F')
          .textAlign(TextAlign.Center)
          .padding({ left: 24, right: 24 })
      } else {
        // guide or error state
        Text(this.pageState === 'error' ? '页面加载失败，dsh 服务可能已停止。' : '未找到运行中的 dsh 服务。')
          .fontSize(14)
          .fontColor('#7E9A8F')

        if (this.guideError.length > 0) {
          Text(this.guideError)
            .fontSize(12)
            .fontColor('#E85D5D')
            .textAlign(TextAlign.Center)
            .padding({ left: 24, right: 24 })
        }

        if (!this.dshInstalled) {
          // 未安装：一键安装（带进度条）或手动安装
          if (this.isInstalling) {
            LoadingProgress()
              .width(40)
              .height(40)
              .color('#000000')
            Text('正在安装 DeepSeek Harness，请稍候…')
              .fontSize(13)
              .fontColor('#2E3A36')
            Scroll() {
              Text(this.installProgress)
                .fontSize(11)
                .fontFamily('monospace')
                .fontColor('#5A6B62')
                .textAlign(TextAlign.Start)
            }
            .width('90%')
            .height(100)
            .backgroundColor('#EDF5F1')
            .borderRadius(8)
            .padding(8)
          } else {
            Button('安装 DeepSeek Harness')
              .height(36)
              .fontSize(13)
              .linearGradient({ angle: 135, colors: [['#5CC9A8', 0.0], ['#7FD8BC', 1.0]] })
              .fontColor('#FFFFFF')
              .onClick(() => this.installFromGuide())
            Text('或在终端手动安装：')
              .fontSize(12)
              .fontColor('#7E9A8F')
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
          }
        } else {
          Text('安装完成后再启动服务：')
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
