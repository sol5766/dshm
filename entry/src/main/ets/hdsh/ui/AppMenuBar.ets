/**
 * DSHM 桌面式标题栏（自绘，紧凑版）。
 *
 * 窗口装饰条已被 EntryAbility 隐藏（setWindowDecorVisible(false)），
 * 因此这一条就是窗口最顶部的标题栏：左侧四个下拉菜单（HARNESS/EDIT/VIEW/WINDOWS），
 * 右侧为连接状态 + 自绘的最小化/最大化(还原)/关闭窗口控制按钮，与系统三键同处一水平线。
 *
 * 本组件只负责 UI 与回调：菜单/按钮里需要 App 层或窗口操作的能力全部通过回调上抛
 * （在 Index 里取 UIAbilityContext，避免菜单弹层场景 getUIContext 失效导致「点了没反应」）。
 *
 * 作用于 Web 内容（编辑/主题/缩放）的在此直接注入 JS；窗口相关交给 Index 回调。
 */

import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0xd511;
const TAG: string = 'AppMenuBar';

// 统一配色：浅色标题栏 + 深色文字，避免原 Button 默认主题色/白字造成的错乱。
const BAR_BG: string = '#F5F7F6';
const TEXT_COLOR: string = '#2F3A36';
const CTRL_COLOR: string = '#4A5551';
const DOT_ON: string = '#4CC39A';
const DOT_OFF: string = '#E85D5D';

@Component
export struct AppMenuBar {
  controller: webview.WebviewController = new webview.WebviewController();
  @Prop serviceConnected: boolean = false;
  @State isMaximized: boolean = false;
  onOpenSettings: () => void = () => {};
  onRestart: () => void = () => {};
  onStartService: () => void = () => {};
  onStopService: () => void = () => {};
  onInstallDsh: () => void = () => {};
  onInstallBrew: () => void = () => {};
  onOpenWorkspace: () => void = () => {};
  onReloadWeb: () => void = () => {};
  onGoDefaultUrl: () => void = () => {};
  onNewSession: () => void = () => {};
  onCheckUpdate: () => void = () => {};
  onCloseWindow: () => void = () => {};
  onMinimize: () => void = () => {};
  onToggleMaximize: () => void = () => {};
  onRestore: () => void = () => {};
  onStartMove: () => void = () => {};

  /** 执行一段 JS（作用于 ArkWeb 内当前页面）。 */
  private runJs(script: string): void {
    try {
      this.controller.runJavaScript(script).then(() => {}).catch((e: Error) => {
        hilog.warn(DOMAIN, TAG, `runJavaScript failed: ${e.message}`);
      });
    } catch (e) {
      hilog.warn(DOMAIN, TAG, `runJavaScript throw: ${String(e)}`);
    }
  }

  private pasteFromClipboard(): void {
    this.runJs("navigator.clipboard.readText().then(function(t){var a=document.activeElement;if(a){if(a.value!==undefined){a.value+=t}else{a.textContent+=t}}}).catch(function(){})");
  }

  private toggleTheme(): void {
    this.runJs("(function(){var i=document.querySelector('html');if(!i)return;var dark=i.getAttribute('data-dshm-theme')==='dark';i.setAttribute('data-dshm-theme',dark?'light':'dark');var s=document.getElementById('dshm-theme');if(!s){s=document.createElement('style');s.id='dshm-theme';document.head.appendChild(s)}s.textContent='html[data-dshm-theme=dark]{filter:invert(0.92) hue-rotate(180deg) brightness(0.95)}';return 'ok'})()");
  }

  private zoom(delta: number): void {
    this.runJs("(function(){var z=parseFloat(document.body.style.zoom||'1')||1;z=Math.max(0.5,Math.min(1.5,z+(" + delta + ")));document.body.style.zoom=String(z)})()");
  }

  // ==== 窗口操作：上抛给 Index（上下文可靠）====
  private minimizeAction(): void {
    this.onMinimize();
  }

  private toggleMaximizeAction(): void {
    this.isMaximized = !this.isMaximized;
    this.onToggleMaximize();
  }

  private restoreAction(): void {
    this.onRestore();
  }

  private closeAction(): void {
    this.onCloseWindow();
  }

  private startMoveAction(): void {
    this.onStartMove();
  }

  /** 延迟执行窗口操作：菜单在 2in1 上可能以独立弹窗存在，需等菜单关闭、主窗口回到前台后再执行，
   *  否则 minimize / maximize / restore 会被系统忽略（表现为「点了没反应」）。 */
  private deferWindow(fn: () => void): void {
    setTimeout(() => {
      try {
        fn();
      } catch (e) {
        hilog.warn(DOMAIN, TAG, `deferWindow throw: ${String(e)}`);
      }
    }, 150);
  }

  private harnessMenu(): Array<MenuElement> {
    return [
      { value: '新建会话', action: () => this.onNewSession() },
      { value: '打开工作区…', action: () => this.onOpenWorkspace() },
      { value: '主页', action: () => this.onGoDefaultUrl() },
      { value: '设置', action: () => this.onOpenSettings() },
      { value: '启动服务', action: () => this.onStartService() },
      { value: '停止服务', action: () => this.onStopService() },
      { value: '安装 DeepSeek Harness', action: () => this.onInstallDsh() },
      { value: '安装 Harmonybrew', action: () => this.onInstallBrew() },
      { value: '检查更新', action: () => this.onCheckUpdate() },
      { value: '重启客户端', action: () => this.onRestart() }
    ];
  }

  private editMenu(): Array<MenuElement> {
    return [
      { value: '撤销', action: () => this.runJs("document.execCommand('undo')") },
      { value: '重做', action: () => this.runJs("document.execCommand('redo')") },
      { value: '剪切', action: () => this.runJs("document.execCommand('cut')") },
      { value: '复制', action: () => this.runJs("document.execCommand('copy')") },
      { value: '粘贴', action: () => this.pasteFromClipboard() },
      { value: '全选', action: () => this.runJs("document.execCommand('selectAll')") },
      { value: '刷新', action: () => this.onReloadWeb() }
    ];
  }

  private viewMenu(): Array<MenuElement> {
    return [
      { value: '切换深色/浅色主题', action: () => this.toggleTheme() },
      { value: '放大', action: () => this.zoom(0.1) },
      { value: '缩小', action: () => this.zoom(-0.1) },
      { value: '重置缩放', action: () => this.runJs("document.body.style.zoom='1'") }
    ];
  }

  private windowMenu(): Array<MenuElement> {
    return [
      { value: '最小化', action: () => this.deferWindow(() => this.minimizeAction()) },
      { value: '最大化', action: () => this.deferWindow(() => this.toggleMaximizeAction()) },
      { value: '还原', action: () => this.deferWindow(() => this.restoreAction()) },
      { value: '关闭窗口', action: () => this.closeAction() }
    ];
  }

  @Builder
  private menuItem(label: string, items: Array<MenuElement>) {
    Button(label)
      .type(ButtonType.Normal)
      .backgroundColor(Color.Transparent)
      .fontColor(TEXT_COLOR)
      .fontSize(11)
      .fontWeight(FontWeight.Medium)
      .borderRadius(4)
      .padding({ left: 7, right: 7, top: 4, bottom: 4 })
      .bindMenu(items)
  }

  build() {
    Row() {
      Text('DSHM')
        .fontSize(11)
        .fontWeight(FontWeight.Bold)
        .fontColor(TEXT_COLOR)
        .margin({ right: 6 })

      this.menuItem('HARNESS', this.harnessMenu())
      this.menuItem('EDIT', this.editMenu())
      this.menuItem('VIEW', this.viewMenu())
      this.menuItem('WINDOWS', this.windowMenu())

      Blank()

      Row() {
        Circle({ width: 6, height: 6 })
          .fill(this.serviceConnected ? DOT_ON : DOT_OFF)
        Text(this.serviceConnected ? '已连接' : '已断线')
          .fontSize(9)
          .fontColor('#F3F7F5')
          .margin({ left: 3 })
      }
      .padding({ left: 6, right: 6, top: 2, bottom: 2 })
      .borderRadius(8)
      .backgroundColor(this.serviceConnected ? '#3A5A4A' : '#5A3A3A')
      .alignItems(VerticalAlign.Center)
      .margin({ right: 4 })

      Button('—')
        .type(ButtonType.Normal)
        .backgroundColor(Color.Transparent)
        .fontColor(CTRL_COLOR)
        .fontSize(13)
        .width(28)
        .height(24)
        .borderRadius(0)
        .onClick(() => this.minimizeAction())

      Button(this.isMaximized ? '▣' : '□')
        .type(ButtonType.Normal)
        .backgroundColor(Color.Transparent)
        .fontColor(CTRL_COLOR)
        .fontSize(12)
        .width(28)
        .height(24)
        .borderRadius(0)
        .onClick(() => this.toggleMaximizeAction())

      Button('✕')
        .type(ButtonType.Normal)
        .backgroundColor(Color.Transparent)
        .fontColor(CTRL_COLOR)
        .fontSize(13)
        .width(28)
        .height(24)
        .borderRadius(0)
        .onClick(() => this.closeAction())
    }
    .width('100%')
    .height(30)
    .padding({ left: 6, right: 2 })
    .alignItems(VerticalAlign.Center)
    .backgroundColor(BAR_BG)
    .gesture(
      PanGesture({ direction: PanDirection.All, distance: 10 })
        .onActionStart(() => {
          this.startMoveAction();
        })
    )
  }
}
