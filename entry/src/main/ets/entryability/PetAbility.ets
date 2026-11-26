import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window, display } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { http } from '@kit.NetworkKit';
import { PetWindowHolder } from '../pages/PetWindowHolder';

const DOMAIN: number = 0xD004;
const TAG: string = 'entry/pet';

/**
 * dsh-pet 桌面宿主 Ability（PC/2in1）。
 *
 * 不绘制宠物：只创建宿主主窗 + 透明子窗，子窗加载 dsh-pet 自己的
 * runtime/electron-helper/probe.html（由宿主 /dsh-pet-native 路由提供）。
 *
 * 插件未安装 / 无 desktop 宠物时，页面会 404 / 无内容；本 Ability 只做窗口壳，
 * 不解析宠物配置。
 */
export default class PetAbility extends UIAbility {
  private hostWin: window.Window | undefined = undefined;
  private petSub: window.Window | undefined = undefined;
  private syncTimer: number = -1;
  private maskedW: number = -1;
  private maskedH: number = -1;
  private checkTimer: number = -1;
  private checkBusy: boolean = false;
  private petHttp: http.HttpRequest = http.createHttp();

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, 'PetAbility onCreate');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/PetHost', (err: BusinessError): void => {
      if (err.code !== 0) {
        hilog.error(DOMAIN, TAG, 'loadContent failed: %{public}d', err.code);
        return;
      }
      windowStage.getMainWindow().then((win: window.Window): void => {
        this.waitAndSetup(windowStage, win);
      }).catch((e: BusinessError): void => {
        hilog.error(DOMAIN, TAG, 'getMainWindow failed: %{public}d', e.code);
      });
    });
  }

  /** dsh-pet 配置地址（带宿主 token）。 */
  private configUrl(): string {
    const base: string = AppStorage.get<string>('dshLastHostUrl') ?? '';
    const token: string = AppStorage.get<string>('dshLastHostToken') ?? '';
    if (base.length === 0) {
      return '';
    }
    const origin: string = base.endsWith('/') ? base.substring(0, base.length - 1) : base;
    return origin + '/dsh-pet-7340/config'
      + (token.length > 0 ? '?token=' + encodeURIComponent(token) : '');
  }

  /** 是否存在 display=desktop|both 的宠物；插件未装/接口 404 时返回 false。 */
  private async hasDesktopPet(): Promise<boolean> {
    if (this.checkBusy) {
      return true; // 上一次查询未回：按"仍在显示"处理，避免误杀
    }
    const url: string = this.configUrl();
    if (url.length === 0) {
      return false;
    }
    this.checkBusy = true;
    try {
      const resp: http.HttpResponse = await this.petHttp.request(url, {
        method: http.RequestMethod.GET,
        connectTimeout: 3000,
        readTimeout: 3000,
        expectDataType: http.HttpDataType.STRING
      });
      const body: string = String(resp.result ?? '');
      return resp.responseCode === 200 && /"display"\s*:\s*"(desktop|both)"/.test(body);
    } catch (e) {
      return false;
    } finally {
      this.checkBusy = false;
    }
  }

  /** 静态路由是否可用（插件包已找到且 /dsh-pet-native 已注册）。 */
  private async hasNativePage(): Promise<boolean> {
    const page: string = this.buildUrl();
    if (page.length === 0) {
      return false;
    }
    try {
      const resp: http.HttpResponse = await this.petHttp.request(page, {
        method: http.RequestMethod.GET,
        connectTimeout: 3000,
        readTimeout: 3000,
        expectDataType: http.HttpDataType.STRING
      });
      return resp.responseCode === 200;
    } catch (e) {
      return false;
    }
  }

  /** 用宿主已发布的 URL/token 拼渲染页地址；拿不到就退出。 */
  private buildUrl(): string {
    const base: string = AppStorage.get<string>('dshLastHostUrl') ?? '';
    const token: string = AppStorage.get<string>('dshLastHostToken') ?? '';
    if (base.length === 0) {
      return '';
    }
    const origin: string = base.endsWith('/') ? base.substring(0, base.length - 1) : base;
    const sep: string = token.length > 0 ? '?' : '';
    const tokenPart: string = token.length > 0 ? 'token=' + encodeURIComponent(token) : '';
    const configUrl: string = origin + '/dsh-pet-7340/config' + sep + tokenPart;
    const d: display.Display = display.getDefaultDisplaySync();
    const scale: number = d.densityPixels > 0 ? d.densityPixels : 1;
    return origin + '/dsh-pet-native/probe.html' + sep + tokenPart
      + '&configUrl=' + encodeURIComponent(configUrl)
      + '&petIndex=0&scale=' + String(scale)
      + '&bridge=0&openTarget=web&isWindowClampedToWorkArea=1';
  }

  /** 宿主 URL/token 可能晚于窗口就绪发布：最多等 30s 再建窗，避免首启空跑。 */
  private async waitAndSetup(stage: window.WindowStage, host: window.Window): Promise<void> {
    for (let i = 0; i < 60; i++) {
      if (this.buildUrl().length > 0) {
        if (!await this.hasDesktopPet()) {
          hilog.info(DOMAIN, TAG, '无 desktop/both 宠物，PetAbility 退出');
          this.context.terminateSelf().catch((_e: BusinessError): void => {});
          return;
        }
        if (!await this.hasNativePage()) {
          hilog.warn(DOMAIN, TAG, '/dsh-pet-native 不可用（插件路径未找到/路由未注册）');
          this.context.terminateSelf().catch((_e: BusinessError): void => {});
          return;
        }
        await this.setup(stage, host);
        this.startPetCheck();
        return;
      }
      await new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, 500);
      });
    }
    hilog.warn(DOMAIN, TAG, '等待宿主 URL 超时，PetAbility 退出');
    this.context.terminateSelf().catch((_e: BusinessError): void => {});
  }

  /** 运行期轮询：用户右键「不在桌面显示」后自动收起。 */
  private startPetCheck(): void {
    if (this.checkTimer >= 0) {
      return;
    }
    this.checkTimer = setInterval((): void => {
      this.hasDesktopPet().then((ok: boolean): void => {
        if (!ok) {
          hilog.info(DOMAIN, TAG, 'desktop 宠物已关闭，PetAbility 退出');
          this.context.terminateSelf().catch((_e: BusinessError): void => {});
        }
      }).catch((_e: Error): void => {});
    }, 2000);
  }

  private async setup(stage: window.WindowStage, host: window.Window): Promise<void> {
    const url: string = this.buildUrl();
    if (url.length === 0) {
      hilog.warn(DOMAIN, TAG, 'host url 未就绪，PetAbility 退出');
      this.context.terminateSelf().catch((_e: BusinessError): void => {});
      return;
    }
    try {
      this.hostWin = host;
      const d: display.Display = display.getDefaultDisplaySync();
      const petSize: number = 620;
      const petX: number = Math.max(0, d.width - petSize - Math.round(d.width * 0.03));
      const petY: number = Math.max(0, d.height - petSize - Math.round(d.height * 0.12));

      // 宿主主窗只作「topmost 父窗 + 子窗跟随」用，不应被看见：
      // 用 forcible 限制把系统最小尺寸压到 40 步长，再缩成 70×70px 的小块，
      // 由 syncHostUnderPet 钉在宠物本体包围盒中心 → 被宠物不透明像素完全覆盖。
      try {
        await host.setWindowLimits({ minWidth: 40, minHeight: 40 }, true);
      } catch (e) {
        const err = e as BusinessError;
        hilog.warn(DOMAIN, TAG, 'setWindowLimits failed: %{public}d', err.code);
      }
      await host.resize(24, 24);
      host.setWindowDecorVisible(false);
      host.setWindowTitleButtonVisible(false, false, false);
      await host.setWindowTopmost(true);
      /*
       * 【Alt+Tab 修复，2026-11-23】桌宠窗口 Focusable=true + PetAbility 独立 mission
       * ⇒ 切换器里会出现一张没有画面的 PetAbility 卡片，切过去键盘事件还被桌宠 webview 吃掉。
       * 置顶与「不可获焦」必须成对：只置顶不关焦点就是报告里的故障态。
       */
      try {
        await host.setWindowFocusable(false);
      } catch (e) {
        const err = e as BusinessError;
        hilog.warn(DOMAIN, TAG, 'host setWindowFocusable(false) failed: %{public}d', err.code);
      }

      const options: window.SubWindowOptions = { title: 'DshPet', decorEnabled: false, outlineEnabled: false };
      const sub: window.Window = await stage.createSubWindowWithOptions('DshPet', options);
      this.petSub = sub;
      PetWindowHolder.sub = sub;
      await sub.resize(petSize, petSize);
      await sub.moveWindowTo(petX, petY);
      AppStorage.setOrCreate<string>('dshPetUrl', url);
      await sub.setUIContent('pages/PetWeb');
      try {
        sub.setWindowBackgroundColor('#00000000');
      } catch (e) {
        hilog.info(DOMAIN, TAG, 'setWindowBackgroundColor skipped');
      }
      /*
       * 桌宠只负责显示与指针交互，不接受键盘焦点（Alt+Tab 报告 §3：焦点落进来后
       * 按键被 ArkWeb 消费、切换器反而接不住）。点击/拖拽仍由 setWindowTouchable 负责。
       */
      try {
        await sub.setWindowFocusable(false);
      } catch (e) {
        const err = e as BusinessError;
        hilog.warn(DOMAIN, TAG, 'sub setWindowFocusable(false) failed: %{public}d', err.code);
      }
      await sub.showWindow();
      hilog.info(DOMAIN, TAG, 'pet subwindow ready: %{public}s', url);
      this.syncHostUnderPet();
      this.syncTimer = setInterval((): void => {
        this.syncHostUnderPet();
        this.applyBorderMask();
      }, 100);
    } catch (e) {
      const err = e as BusinessError;
      hilog.error(DOMAIN, TAG, 'setup failed: %{public}d %{public}s', err.code, err.message);
    }
  }

  /**
   * 边框掩码：窗口外圈 4px alpha=0、其余 255。实测可使 WM 不再绘制窗口矩形阴影
   * （setWindowShadowEnabled 仅主窗可用，子窗报 1300004），且不裁剪任何内容；
   * 窗口尺寸变化时重挂。
   */
  private applyBorderMask(): void {
    const sub: window.Window | undefined = this.petSub;
    if (sub === undefined) {
      return;
    }
    try {
      const rect = sub.getWindowProperties().windowRect;
      const w: number = rect.width;
      const h: number = rect.height;
      if (w <= 0 || h <= 0 || (w === this.maskedW && h === this.maskedH)) {
        return;
      }
      const border: number = 4;
      const mask: Uint8Array = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        const inY: boolean = y >= border && y < h - border;
        const rowBase: number = y * w;
        for (let x = 0; x < w; x++) {
          if (inY && x >= border && x < w - border) {
            mask[rowBase + x] = 255;
          }
        }
      }
      sub.setWindowMaskWithAlpha(mask, w, h).then((): void => {
        this.maskedW = w;
        this.maskedH = h;
        hilog.info(DOMAIN, TAG, 'border mask applied %{public}d x %{public}d', w, h);
      }).catch((e: BusinessError): void => {
        hilog.warn(DOMAIN, TAG, 'border mask failed: %{public}d', e.code);
      });
    } catch (e) {
      // 未就绪
    }
  }

  private syncHostUnderPet(): void {
    const host: window.Window | undefined = this.hostWin;
    const sub: window.Window | undefined = this.petSub;
    if (host === undefined || sub === undefined) {
      return;
    }
    try {
      const sr = sub.getWindowProperties().windowRect;
      const hr = host.getWindowProperties().windowRect;
      let cx: number = sr.left + sr.width / 2;
      let cy: number = sr.top + sr.height / 2;
      if (PetWindowHolder.boxSize > 0 && PetWindowHolder.boxX >= 0) {
        // 宠物本体包围盒中心（物理像素）：宿主整窗藏到宠物身体下面
        cx = PetWindowHolder.boxX + PetWindowHolder.boxSize / 2;
        cy = PetWindowHolder.boxY + PetWindowHolder.boxSize * 0.5;
      }
      const x: number = Math.round(cx - hr.width / 2);
      const y: number = Math.round(cy - hr.height / 2);
      if (Math.abs(x - hr.left) > 2 || Math.abs(y - hr.top) > 2) {
        host.moveWindowTo(x, y).catch((e: BusinessError): void => {
          hilog.info(DOMAIN, TAG, 'host move rejected: %{public}d', e.code);
        });
      }
    } catch (e) {
      // 窗口未就绪：忽略
    }
  }

  onWindowStageDestroy(): void {
    if (this.checkTimer >= 0) {
      clearInterval(this.checkTimer);
      this.checkTimer = -1;
    }
    if (this.syncTimer >= 0) {
      clearInterval(this.syncTimer);
      this.syncTimer = -1;
    }
    this.hostWin = undefined;
    this.petSub = undefined;
    PetWindowHolder.sub = undefined;
  }

  onForeground(): void {
  }

  onBackground(): void {
  }

  onDestroy(): void {
  }
}
