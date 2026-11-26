import { webview } from '@kit.ArkWeb';
import { window, display } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';
import { PetWindowHolder } from './PetWindowHolder';

const DOMAIN: number = 0xD004;
const TAG: string = 'entry/pet';

/** 与 dsh-pet preload.js 同名的桥；回调由 runJavaScript 调 __DSHM_PET_DELIVER__。 */
class PetBridge {
  controller: webview.WebviewController | undefined = undefined;
  private interactive: boolean = true;
  private busy: boolean = false;
  private touchableState: boolean = true;
  private pulseTimer: number = -1;
  private pulseRestoreTimer: number = -1;
  /** 最近一次成功下发的可触区域（窗口内 px，四元组）；空 = 未启用按区域可触。 */
  private lastArea: number[] = [];
  private lastAreaAt: number = 0;

  setBounds(x: number, y: number, w: number, h: number, boxX: number, boxY: number,
    size: number, bottomPad: number, vx: number, vy: number, marginL: number, marginT: number): void {
    const sub: window.Window | undefined = PetWindowHolder.sub;
    if (sub === undefined) {
      return;
    }
    PetWindowHolder.boxX = boxX;
    PetWindowHolder.boxY = boxY;
    PetWindowHolder.boxSize = size;
    /*
     * 【透明区穿透】窗口矩形变化会让 setTouchableAreas 的设置失效（SDK 明文），
     * 所以每次 move/resize 落地后都要按新的宠物包围盒重设一次。两个 Promise 都
     * settle 后再算，避免拿到旧 rect。
     */
    const moved: Promise<void> = sub.moveWindowTo(Math.round(x), Math.round(y)).catch((e: BusinessError): void => {
      hilog.info(DOMAIN, TAG, 'setBounds move rejected: %{public}d', e.code);
    });
    const resized: Promise<void> = sub.resize(Math.round(w), Math.round(h)).catch((e: BusinessError): void => {
      hilog.info(DOMAIN, TAG, 'setBounds resize rejected: %{public}d', e.code);
    });
    Promise.all([moved, resized]).then((): void => {
      this.applyTouchableAreas();
    }).catch((_e: Error): void => {});
  }

  setInteractive(v: boolean): void {
    this.interactive = v;
    // 窗口常态可触：窗口已由 shim 收紧到「宠物∪可见UI+20px」，透明区点击损失不可感知；
    // 换取 hover 稳定（不再依赖 300ms 脉冲碰运气，点按/拖动/右键即时生效）。
    this.stopPulse();
    this.applyTouchable(true);
  }

  setInputBusy(v: boolean): void {
    this.busy = v;
    this.stopPulse();
    this.applyTouchable(true);
  }

  setInputRegions(json: string): void {
    // 插件侧上报的可触区域统一以「宠物本体包围盒」为准（setBounds 已带 boxX/boxY/size），
    // 这里只作为触发点，不信任 json 的坐标系（插件可能传屏幕坐标或 DOM 坐标）。
    this.applyTouchableAreas();
  }

  requestKeyboardFocus(): void {
  }

  openDshSite(url: string): void {
    try {
      const ctx = getContext() as common.UIAbilityContext;
      ctx.openLink(url, { appLinkingOnly: false }).catch((e: BusinessError): void => {
        hilog.warn(DOMAIN, TAG, 'openDshSite failed: %{public}d', e.code);
      });
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'openDshSite context failed');
    }
  }

  focusDshHost(): void {
  }

  deliverDisplays(): void {
    const c: webview.WebviewController | undefined = this.controller;
    if (c === undefined) {
      return;
    }
    try {
      const d: display.Display = display.getDefaultDisplaySync();
      const rect: string = `{"x":0,"y":0,"width":${d.width},"height":${d.height}}`;
      const geo: string = `{"hull":${rect},"areas":[${rect}],"workAreas":[${rect}],"panels":[${rect}],"primaryIndex":0,"topInsetRatio":0}`;
      c.runJavaScript(`window.__DSHM_PET_DELIVER__ && window.__DSHM_PET_DELIVER__('displays', ${geo})`)
        .catch((e: BusinessError): void => {
          hilog.info(DOMAIN, TAG, 'deliverDisplays failed: %{public}d', e.code);
        });
    } catch (e) {
      // 忽略：渲染页会用 window.screen 兜底
    }
  }

  private applyTouchable(v: boolean, force: boolean = false): void {
    if (!force && this.touchableState === v) {
      return;
    }
    this.touchableState = v;
    const sub: window.Window | undefined = PetWindowHolder.sub;
    if (sub !== undefined) {
      sub.setWindowTouchable(v).catch((e: BusinessError): void => {
        hilog.info(DOMAIN, TAG, 'setInteractive rejected: %{public}d', e.code);
      });
    }
  }

  /**
   * 按宠物本体包围盒下发「窗口可触区域」：区域外点击穿透到桌面 / 下层应用。
   *
   * 背景（2026-11-23 用户反馈）：桌宠窗口 620×620，宠物本体只占中间一块，
   * 透明区域此前也整窗 `setWindowTouchable(true)` ⇒ 点在宠物旁边什么都不会发生。
   * 官方按区域方案是 `setTouchableAreas`，但它要求 `ohos.permission.SET_WINDOW_TOUCH_AREAS`
   * （system_basic，需 ACL）且 @since 26；拿不到权限时返回 201 —— 这时降级为整窗可触，
   * 保证宠物本身仍然可点，只是透明区继续吃点击。
   *
   * 注意：SDK 明文「窗口矩形变化后设置失效」，所以每次 move/resize 落地都要重设；
   * 用 2px 容差 + 120ms 节流，避免动画每帧都调。
   */
  private applyTouchableAreas(): void {
    const sub: window.Window | undefined = PetWindowHolder.sub;
    if (sub === undefined) {
      return;
    }
    const size: number = PetWindowHolder.boxSize;
    const bx: number = PetWindowHolder.boxX;
    const by: number = PetWindowHolder.boxY;
    if (!(size > 0) || bx < 0 || by < 0) {
      this.applyTouchable(true, true);
      return;
    }
    let rect: window.Rect;
    try {
      const r: window.Rect = sub.getWindowProperties().windowRect;
      const pad: number = 10;
      const l: number = Math.max(0, Math.round(bx - r.left - pad));
      const t: number = Math.max(0, Math.round(by - r.top - pad));
      const rr: number = Math.min(r.width, Math.round(bx - r.left + size + pad));
      const bb: number = Math.min(r.height, Math.round(by - r.top + size + pad));
      if (rr <= l || bb <= t) {
        this.applyTouchable(true, true);
        return;
      }
      rect = { left: l, top: t, width: rr - l, height: bb - t };
    } catch (e) {
      this.applyTouchable(true, true);
      return;
    }
    const now: number = Date.now();
    const prev: number[] = this.lastArea;
    const same: boolean = prev.length === 4
      && Math.abs(prev[0] - rect.left) <= 2 && Math.abs(prev[1] - rect.top) <= 2
      && Math.abs(prev[2] - rect.width) <= 2 && Math.abs(prev[3] - rect.height) <= 2;
    if (same && now - this.lastAreaAt < 120) {
      return;
    }
    this.lastArea = [rect.left, rect.top, rect.width, rect.height];
    this.lastAreaAt = now;
    try {
      sub.setTouchableAreas([rect]).catch((e: BusinessError): void => {
        // 201 = 缺 SET_WINDOW_TOUCH_AREAS（system_basic，需 ACL）；801 = 设备不支持
        hilog.info(DOMAIN, TAG, 'setTouchableAreas rejected: %{public}d，降级整窗可触', e.code);
        this.lastArea = [];
        this.applyTouchable(true, true);
      });
    } catch (e) {
      this.applyTouchable(true, true);
    }
  }

  private stopPulse(): void {
    if (this.pulseTimer >= 0) {
      clearInterval(this.pulseTimer);
      this.pulseTimer = -1;
    }
    if (this.pulseRestoreTimer >= 0) {
      clearTimeout(this.pulseRestoreTimer);
      this.pulseRestoreTimer = -1;
    }
  }

  /** 页面就绪后补一次：首帧时 setBounds 可能还没到，窗口矩形却已定。 */
  refreshTouchableAreas(): void {
    this.applyTouchableAreas();
  }
}

@Entry
@Component
struct PetWeb {
  @StorageProp('dshPetUrl') private url: string = '';
  private controller: webview.WebviewController = new webview.WebviewController();
  private bridge: PetBridge = new PetBridge();

  aboutToAppear(): void {
    this.bridge.controller = this.controller;
  }

  build() {
    Stack() {
      Web({ src: this.url, controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .fileAccess(false)
        .backgroundColor(Color.Transparent)
        .javaScriptProxy({
          object: this.bridge,
          name: '__DSHM_PET_BRIDGE__',
          methodList: ['setBounds', 'setInteractive', 'setInputBusy', 'setInputRegions',
            'requestKeyboardFocus', 'openDshSite', 'focusDshHost'],
          controller: this.controller
        })
        .onPageEnd((): void => {
          this.bridge.deliverDisplays();
          this.bridge.refreshTouchableAreas();
        })
        .onHttpErrorReceive((event: OnHttpErrorReceiveEvent): void => {
          // 插件未安装 / 路由未注册：主文档 4xx 直接收起宿主，不留空白窗。
          if (event.request.isMainFrame() && event.response.getResponseCode() >= 400) {
            hilog.warn(DOMAIN, TAG, 'pet page http %{public}d，退出 PetAbility',
              event.response.getResponseCode());
            (getContext(this) as common.UIAbilityContext).terminateSelf()
              .catch((_e: BusinessError): void => {});
          }
        })
        .width('100%')
        .height('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.Transparent)
  }
}
