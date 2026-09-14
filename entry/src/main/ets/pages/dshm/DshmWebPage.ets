/**
 * DSHM DSH Web UI 页（ArkWeb 容器）+ 菜单栏风格顶栏。
 *
 * 启动流程：解压 DSH 环境 → 启动 native 子进程（libnode + DSH）→ 轮询 3080 → 加载 ArkWeb。
 * 顶栏左侧品牌：深色 logo + "DeepSeek"，同行三个下拉菜单：
 *   Harness（主页 / 检查App更新 / 检查Harness更新并自动更新 / 重启服务）
 *   编辑（撤销 Ctrl+Z / 重做 Ctrl+Y / 刷新 / 终端）
 *   窗口（关闭窗口 Ctrl+W＝退出应用 / 最小化）
 * 顶栏为**浅色主题（白底 + 深色 logo/文字）**：EntryAbility 隐藏了系统标题栏，
 * 系统的最小化/最大化/关闭按钮会浮在顶栏右端，系统按浅色模式绘制深色图标，
 * 深色顶栏会让这三个按钮完全看不见。
 * 终端为右侧边栏，走 dshm-terminal 的 pty 会话（zsh，回退 /bin/sh）；
 * 其输入行**内联在输出流末尾**并随输出滚动（对齐 mac 端终端手感），
 * 而不是钉死在面板底部的独立输入行。
 * 服务端可通过 /dshm-admin/ui/event 请求页面刷新或服务重启（插件安装后常见）。
 */
import { webview } from '@kit.ArkWeb';
import { KeyCode } from '@kit.InputKit';
import { common, bundleManager, appRecovery } from '@kit.AbilityKit';
import { window, uiMaterial } from '@kit.ArkUI';
import { fileIo } from '@kit.CoreFileKit';
import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { DshBootstrap, RuntimeModeInfo, DshBootState } from '../../dshm/bootstrap/DshBootstrap';
import { WorkspaceAccess } from '../../dshm/access/WorkspaceAccess';
import { writeOhosInfo } from '../../dshm/access/OhosInfoBridge';
import { DshmLogger } from '../../dshm/utils/Logger';
import { StatusBarTray } from '../../dshm/system/StatusBarTray';
import { EnvAssetClient, EnvManifest, EnvDownloadProgress } from '../../dshm/env/EnvAssetClient';
import { DshmAppActions } from '../../dshm/system/AppActions';
import { ImmersiveMaterialUtil } from '../../dshm/ui/ImmersiveMaterialUtil';


const TAG: string = 'DshmWebPage';
const HOME_URL: string = 'http://127.0.0.1:3080';
const VERSION_ENDPOINT: string = 'http://127.0.0.1:3080/dshm-admin/version';
const UPDATE_ENDPOINT: string = 'http://127.0.0.1:3080/dshm-admin/update';
const UPDATE_APPLY_ENDPOINT: string = 'http://127.0.0.1:3080/dshm-admin/update/apply';
// Harness 更新是服务端后台任务（同进程 Worker 跑 pnpm），ArkTS 侧轮询进度；
// 单次 HTTP 请求只负责"开始"与"查进度"，不承担长连接等待。
const UPDATE_POLL_INTERVAL_MS: number = 4000;
const UPDATE_POLL_TIMEOUT_MS: number = 15 * 60 * 1000;
// 连续查询失败次数上限（4s 一次 → 默认 40s 无响应即判定服务端已不可用）。
const UPDATE_POLL_MAX_FAILURES: number = 10;
const UI_EVENTS_GET: string = 'http://127.0.0.1:3080/dshm-admin/ui/events';
const TERM_START_ENDPOINT: string = 'http://127.0.0.1:3080/dshm-terminal/start';
const TERM_WRITE_ENDPOINT: string = 'http://127.0.0.1:3080/dshm-terminal/write';
const TERM_READ_ENDPOINT: string = 'http://127.0.0.1:3080/dshm-terminal/read';
const TERM_KILL_ENDPOINT: string = 'http://127.0.0.1:3080/dshm-terminal/kill';
// Harness 版本检查源：GitHub Releases API 优先（国内加速）。
// 注意：dsh 的 rc/alpha 都是 GitHub prerelease，`releases/latest` 端点（latest 非预发布）
// 不会返回它们，因此这里统一用 `releases` 列表接口（?per_page=N，含 prerelease），
// 由检索逻辑自行从全部 release 中筛选「仅 RC / 稳定版、排除 alpha」并取最新。
// npm registry 仅作为**下载**源，不参与**版本检测**（镜像只同步到 0.1.5-rc.1，
// 用它检测会把 0.1.5-rc.2 误判为"没有更新"）。
const HARNESS_GITHUB_RELEASE_LIST: string = 'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=3';
const HARNESS_VERSION_ENDPOINTS: string[] = [
  'https://gh-proxy.com/' + HARNESS_GITHUB_RELEASE_LIST,
  'https://ghproxy.net/' + HARNESS_GITHUB_RELEASE_LIST,
  HARNESS_GITHUB_RELEASE_LIST
];

/**
 * 顶栏高度。
 *
 * EntryAbility 调了 setWindowDecorVisible(false) 隐藏系统标题栏，系统的最小化/
 * 最大化/关闭按钮会浮在顶栏右端之上。顶栏必须留出足够高度承载这三个按钮。
 * 40 → 38：白底区域在视觉上留白偏多，按反馈再收 5%。
 */
const TOP_BAR_HEIGHT: number = 38;

/** 终端输入行 id：输入行随输出滚动后会重建，需要用它在输出刷新后交还焦点。 */
const TERM_INPUT_ID: string = 'termInput';

interface TermReadResp {
  ok: boolean;
  lines: string[];
  exited: boolean;
  exitCode: number | null;
}

interface TermStartResp {
  ok: boolean;
  sid: number;
  pty?: boolean;
  shell?: string;
  user?: string;
  host?: string;
  cwd?: string;
}

interface UiEventPayload {
  id: number;
  type: string;
}

interface UiEventsResp {
  ok: boolean;
  since: number;
  events: UiEventPayload[];
}

/** 检查更新/请求体的具名类型（ArkTS 禁止匿名对象字面量）。 */
interface EmptyBody {
}

interface StartBody {
  shell: string;
}

interface WriteBody {
  sid: number;
  text: string;
  /**
   * 原始模式：服务端**不补换行**。
   *
   * 终端默认（缺省 false）收到的是一行命令，服务端会补 `\n` 执行；而 Tab 补全、
   * 方向键、Ctrl-C 这类控制序列必须原样送进 pty，补了 `\n` 会变成「补全后立刻执行」。
   */
  raw?: boolean;
}

interface KillBody {
  sid: number;
}

interface UpdateBody {
  version: string;
}

interface DshPkgVersion {
  version?: string;
}

/** GitHub Releases 列表接口的单条 release（/releases?per_page=N，含 prerelease）。 */
interface GitHubRelease {
  tag_name?: string;
  prerelease?: boolean;
  published_at?: string;
}

interface UpdateResp {
  ok?: boolean;
  message?: string;
  started?: boolean;
  running?: boolean;
  version?: string;
}

/** GET /dshm-admin/update 的进度应答（后台更新任务状态）。 */
interface UpdateStatusResp {
  ok?: boolean;
  running?: boolean;
  phase?: string;
  message?: string;
  resolved?: number;
  downloaded?: number;
  added?: number;
  percent?: number;
  elapsedSec?: number;
  staged?: boolean;
  done?: boolean;
  success?: boolean;
  version?: string;
}

/** GET /dshm-admin/version：运行时与环境版本信息。 */
interface VersionResp {
  ok?: boolean;
  message?: string;
  dsh?: string;
  staged?: string;
  koffi?: string;
  node?: string;
  platform?: string;
  arch?: string;
  envRoot?: string;
  cwd?: string;
}

/** "关于版本"面板的一行（左对齐标签 + 值）。 */
interface AboutRow {
  label: string;
  value: string;
}

/** 轮询更新的最终结果（ArkTS 不允许元组返回，用具名类型）。 */
interface UpdateOutcome {
  success: boolean;
  message: string;
}


@Entry
@Component
struct DshmWebPage {
  private controller: webview.WebviewController = new webview.WebviewController();
  @State private ready: boolean = false;
  @State private webUrl: string = HOME_URL;
  @State private statusText: string = '正在启动 DeepSeek Harness 运行时...';
  @State private restarting: boolean = false;
  /** 启动是否失败（用于在启动加载页显示恢复按钮）。 */
  @State private bootError: boolean = false;
  /** 首屏白屏兜底：是否已启动按内容判断的重试流程（只启动一次）。 */
  private initialReloadDone: boolean = false;
  /** 冷启动计时反馈的 interval id（-1 表示未启动）。 */
  private bootTicker: number = -1;
  /** 启动阶段说明（会与计时一起展示；由 boot() 按阶段更新）。 */
  private bootPhase: string = '';
  // Harness 更新进度浮层：更新由服务端后台任务执行（数分钟），
  // 主界面就绪后 statusText 不可见，用浮层常显当前阶段。
  @State private updateRunning: boolean = false;
  @State private updateMsg: string = '';
  @State private updatePercent: number = 0;
  @State private updateElapsed: number = 0;
  @State private updateDetail: string = '';
  @State private updateTrack: string = '';
  private updateTicker: number = -1;
  @State private updateReady: boolean = false;
  @State private updateVersion: string = '';
  @State private applying: boolean = false;
  @State private applyPhase: string = '';
  // “关于版本”面板（页内浮层，便于左对齐排版，不用系统 alert 的居中文本）
  @State private aboutOpen: boolean = false;
  @State private aboutRows: AboutRow[] = [];
  // 沉浸光感能力（空间化 Spatial UI）：设备支持时顶栏等组件使用沉浸式系统材质，
  // 否则回退传统实色/模糊。探测结果由 ImmersiveMaterialUtil 缓存。
  @State private immersiveEnabled: boolean = false;
  // 启动加载页品牌动效：brandOpacity 负责淡入，brandBreath 负责常驻呼吸缩放。
  // 拆成两个属性是为了让两段动画作用于不同属性，避免同一属性被并发动画抢占。
  @State private brandOpacity: number = 0;
  @State private brandBreath: number = 1;
  // 终端侧边栏状态
  @State private terminalOpen: boolean = false;
  @State private termLines: string[] = ['DeepSeek Harness 终端（pty 会话，zsh）。输入命令回车执行。'];
  @State private termInput: string = '';
  @State private termBusy: boolean = false;
  @State private termPty: boolean = false;
  @State private termConnected: boolean = false;
  @State private termShell: string = '';
  @State private termUser: string = '';
  @State private termHost: string = '';
  @State private termCwd: string = '';
  private termSid: number = -1;
  private termPoller: number = -1;
  private listScroller: Scroller = new Scroller();
  // 服务端事件轮询（刷新/重启）
  private uiEventSince: number = 0;
  private uiEventPoller: number = -1;
  private lastWidthBucket: number = -1;
  private sizeListenerOn: boolean = false;

  /** 判断目录是否存在（ArkTS fileIo 无 isDirectory 便捷 API，用 stat 判定）。 */
  static dirExists(dir: string): boolean {
    try {
      const s = fileIo.statSync(dir);
      return s.isDirectory();
    } catch (e) {
      return false;
    }
  }

  aboutToAppear(): void {
    webview.WebviewController.setWebDebuggingAccess(true);
    // 沉浸光感能力探测（同步、带缓存）：必须在首帧前完成，避免顶栏材质闪烁。
    this.immersiveEnabled = ImmersiveMaterialUtil.isUsable();
    DshmLogger.info(TAG, ImmersiveMaterialUtil.describe());
    // 重启完成后 dsh 会换新 token，页面必须用新 URL 重新加载，否则停在旧 token 上
    //（401/白屏）。事件由 DshmAppActions.restartDsh 广播；**页面自己发起的重启也会
    // 收到**（restartAndWait 里已经在事件之前写过 webUrl），因此这里只在 URL 真的
    // 变了才 reload，避免同一次重启触发两次 loadUrl。
    DshmAppActions.subscribeRestartDone((): void => {
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const url: string = DshBootstrap.readWebUrl(ctx);
      if (url.length === 0 || url === this.webUrl) {
        return;
      }
      DshmLogger.info(TAG, '收到重启完成事件，重新加载 ' + url);
      this.webUrl = url;
      this.ready = true;
      this.controller.loadUrl(url);
      this.startUiEventPoll();
    });
    this.boot();
  }

  aboutToDisappear(): void {
    if (this.sizeListenerOn) {
      this.unregisterWindowSizeListener();
    }
    this.termStopPoll();
    this.stopUiEventPoll();
  }

  /**
   * 启动加载页品牌动效：品牌 mark 淡入，随后进入常驻呼吸循环。
   * 用显式动画（animateTo）而非属性动画，便于控制延迟与循环节奏。
   */
  private startBrandAnimation(): void {
    animateTo({ duration: 640, curve: Curve.Friction, delay: 80 }, () => {
      this.brandOpacity = 1;
    });
    animateTo({
      duration: 1800,
      curve: Curve.EaseInOut,
      iterations: -1,
      playMode: PlayMode.Alternate,
      delay: 720,
    }, () => {
      this.brandBreath = 1.09;
    });
  }

  private async unregisterWindowSizeListener(): Promise<void> {
    if (!this.sizeListenerOn) return;
    try {
      const hostCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const win = await window.getLastWindow(hostCtx);
      if (win !== null) {
        win.off('windowSizeChange');
        DshmLogger.info(TAG, '注销 windowSizeChange 监听');
      }
    } catch (e) {
      /* 窗口监听注销失败时忽略 */
    }
    this.sizeListenerOn = false;
  }

  private async registerWindowSizeListener(): Promise<void> {
    if (this.sizeListenerOn) return;
    try {
      const hostCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const win = await window.getLastWindow(hostCtx);
      if (win === null) return;
      win.on('windowSizeChange', (size: window.Size): void => {
        const w: number = size.width;
        const bucket: number = w < 700 ? 0 : (w < 1024 ? 1 : 2);
        if (this.lastWidthBucket !== -1 && bucket !== this.lastWidthBucket) {
          DshmLogger.info(TAG, '窗口宽度跨断点 ' + this.lastWidthBucket + '→' + bucket + '（' + w + 'px），刷新 ArkWeb');
          this.controller.refresh(true);
        }
        this.lastWidthBucket = bucket;
      });
      this.lastWidthBucket = win.getWindowProperties().windowRect.width < 700 ? 0 :
        (win.getWindowProperties().windowRect.width < 1024 ? 1 : 2);
      this.sizeListenerOn = true;
      DshmLogger.info(TAG, '已注册 windowSizeChange 监听（初始断点桶 ' + this.lastWidthBucket + '）');
    } catch (e) {
      DshmLogger.warn(TAG, '注册 windowSizeChange 监听失败: ' + String(e));
    }
  }

  private async boot(): Promise<void> {
    const bootT0: number = Date.now();
    const marks: string[] = [];
    const mark = (stage: string): void => {
      const elapsed: number = Date.now() - bootT0;
      marks.push(stage + ' ' + elapsed + 'ms');
      DshmLogger.info('BootTimer', stage + ' ' + elapsed + 'ms');
      try {
        const hostCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
        const p: string = hostCtx.filesDir + '/boot-timing.txt';
        const f = fileIo.openSync(p,
          fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
        fileIo.writeSync(f.fd, marks.join('\n') + '\n');
        fileIo.closeSync(f);
      } catch (e) {
        /* 打点落盘失败不阻断启动 */
      }
    };
    try {
      const hostCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      mark('t0.bootStart');
      // 冷启动耗时反馈：--jitless 下 dsh 全量 JS 解释执行，真机冷启动约 26-33s。
      this.startBootTicker();
      // ArkWeb 的 cookie 接受是可关闭的，必须在 Web 组件创建前打开。
      // 为什么现在才必须：dsh 0.1.5 起服务端鉴权改为「GET /?token=T → 303 + Set-Cookie
      // dsh-auth-…（HttpOnly; SameSite=Strict）→ GET / → 200」。ArkWeb 若丢弃该 cookie，
      // 跳转后的 `/` 就是 401，页面只剩一行 "dsh web authentication required"，即白屏。
      // 0.1.2 的 `?token=` 直接返回页面、不需要 cookie，所以此前从未暴露。
      try {
        if (!webview.WebCookieManager.isCookieAllowed()) {
          webview.WebCookieManager.putAcceptCookieEnabled(true);
          DshmLogger.info(TAG, 'ArkWeb 已开启 cookie 接受（0.1.5 的 303+cookie 鉴权需要）');
        }
        DshmLogger.info(TAG, 'ArkWeb cookie allowed=' + webview.WebCookieManager.isCookieAllowed());
      } catch (e) {
        DshmLogger.warn(TAG, '开启 ArkWeb cookie 失败: ' + this.errOf(e));
      }
      await DshBootstrap.ensureDshDir(hostCtx);
      mark('t1.dshEnv');
      await DshBootstrap.ensureBusybox(hostCtx);
      mark('t2.busybox');
      await DshBootstrap.ensurePnpm(hostCtx);
      mark('t3.pnpm');
      await WorkspaceAccess.ensureInitialSelection(hostCtx);
      await WorkspaceAccess.syncAuthorizedToWorkspace(hostCtx);
      await DshBootstrap.ensureOhosSkills(hostCtx);
      await writeOhosInfo(hostCtx);
      DshBootstrap.clearNodeLogs(hostCtx);
      // profiles 卫生清理（跳过 dsh 托管符号链接，只清真实目录副本）。
      DshBootstrap.cleanHealFallbackProfiles(hostCtx);
      DshBootstrap.ensureBundleMirror(hostCtx);
      // 内置插件市场：把 dshmarket 补进两种模式各自 web profile 的 bundles/dependencies
      // （全新 profile 由 dsh-app-boot 模板带出，存量 profile 在这里补写一次）。
      DshBootstrap.ensureMarketBundle(hostCtx);
      // 品牌迁移：用户 profile 里遗留的旧 bundle 名必须在 dsh 启动前改掉，
      // 否则 dsh-app-boot 解析不到 bundle 会直接 abort（实测 SIGNAL 6）。
      DshBootstrap.migrateLegacyProfileBundleNames(hostCtx);
      mark('t4.wsInfo');
      await DshBootstrap.launchDsh();
      DshmLogger.info(TAG, '等待 DSH server 就绪...');
      const serverUp: boolean = await DshBootstrap.waitForServer(hostCtx, 120000);
      mark('t5.serverReady');
      if (serverUp) {
        // ── A1 快路径（阶段0）：读 _fetch-shim 写的结构化 boot-state.json ──
        // dsh 打印带 token 的 URL 时文件即就绪（原子写），不必刮日志。
        // 读不到（旧环境 / 剖析模式 / 嗅探失败）时，回退下方原有轮询刮削路径。
        const bootState: DshBootState | null = DshBootstrap.readBootState(hostCtx);
        if (bootState !== null) {
          this.webUrl = bootState.url;
          this.statusText = 'DeepSeek Harness 已就绪';
          DshmLogger.info(TAG, 'boot-state 就绪（A1 快路径），ArkWeb 加载 ' + this.webUrl);
          this.ready = true;
          this.ensureFirstPaintVisible();
          await DshBootstrap.echoNodeLogMarks(hostCtx);
          this.registerWindowSizeListener();
          this.startUiEventPoll();
          if (await WorkspaceAccess.shouldNotifyFullDisk(hostCtx)) {
            this.showDialog('开启「全盘文件访问」权限',
              '系统不提供该权限的授权弹窗 —— 它属于受限权限，只能在系统设置中手动开启。\n\n' +
                '路径：设置 → 应用和元服务 → DeepSeek Harness → 权限 → 全盘文件访问 → 允许。\n\n' +
                '开启后 DSH 才能读写工作区（默认：个人文件夹）下的任意文件；' +
                '未开启时仅可访问「下载」「文档」目录。');
          }
          return;
        }
        // 关键：Web 组件以创建时的 webUrl 为准（src 后续改动不会重载）。
        // 必须先把带鉴权 token 的完整 URL 解析好（日志里的
        // "dsh web: http://127.0.0.1:3080/?token=..."），再一次性给 webUrl
        // 并置 ready=true；若先置 ready，Web 会以初始裸 URL 创建并收到
        // 401/404 而白屏。
        //
        // 2026-09-11 实测修正：dsh **先监听 3080、后打印带 token 的 URL**，两者之间
        // 可能相隔数十秒（本次观测：`waitForServer` 于 6.7s 因端口可连而返回，而
        // URL 行到约 40-60s 才落盘）。原实现只轮询 30 次（30s）后回退**裸 URL**，
        // 于是 ArkWeb 加载裸 URL 拿到 401 → 白屏（必须手动「编辑→刷新」，而那时
        // 日志里已有 token，刷新才恢复正常）。这里把等待上限放宽到 120s 并把
        // 「拿到带 token 的 URL」当作真正就绪的判据，否则不创建 Web。
        let readyUrl: string = DshBootstrap.readWebUrl(hostCtx);
        if (!readyUrl.includes('token=')) {
          DshmLogger.info(TAG, 'web URL 尚无 token（dsh 先监听后打印 URL），轮询等待…');
          this.bootPhase = '正在等待鉴权地址（dsh 先监听端口，再打印带 token 的地址）';
          const deadline: number = Date.now() + 120000;
          while (Date.now() < deadline && !readyUrl.includes('token=')) {
            await new Promise<void>((resolve: () => void) => {
              setTimeout(resolve, 500);
            });
            readyUrl = DshBootstrap.readWebUrl(hostCtx);
          }
          if (!readyUrl.includes('token=')) {
            DshmLogger.error(TAG, '120s 内未读到带 token 的 web URL，回退裸 URL（大概率 401，需用「编辑→刷新」）');
          } else {
            DshmLogger.info(TAG, '已取得带 token 的 web URL');
          }
        }
        this.webUrl = readyUrl;
        this.statusText = 'DeepSeek Harness 已就绪';
        DshmLogger.info(TAG, 'DSH server 就绪，ArkWeb 加载 ' + this.webUrl);
        this.ready = true;
        // 启动成功即认定当前环境可用：清掉可能残留的更新备份，释放空间。
        DshBootstrap.discardEnvBackup(hostCtx);
        // 若有「待验收的环境切换」，此刻即确认生效（清理标记，保留新环境）
        DshBootstrap.clearPendingVerify(hostCtx);
        // 首屏白屏兜底：dsh 0.1.5 首页要等 `?token=` → 303 + Set-Cookie → `/` 走完，
        // 并拉一个 11MB 的客户端模块合并包（/plugins/??…），首次加载常赶在服务端就绪前
        // → 白屏；手动「编辑→刷新」即恢复（实测）。
        // 只用「一次 4s 定时重载」不够稳（2026-09-11 实测重建后仍白屏，必须手动刷新），
        // 改成**按内容判断**的轮询兜底：用 runJavaScript 读 body.innerText 长度，
        // 确认没渲染出内容才重载，避免在正常渲染时无谓打断加载。
        this.ensureFirstPaintVisible();
        await DshBootstrap.echoNodeLogMarks(hostCtx);
        this.registerWindowSizeListener();
        // 服务端 push 事件（插件安装后请求刷新/重启）
        this.startUiEventPoll();
        // 全盘访问权限没有系统弹窗（system_basic + manual_settings 受限权限，
        // 只能手动开启），所以这里给一次应用内引导，指明系统设置路径。
        if (await WorkspaceAccess.shouldNotifyFullDisk(hostCtx)) {
          this.showDialog('开启「全盘文件访问」权限',
            '系统不提供该权限的授权弹窗 —— 它属于受限权限，只能在系统设置中手动开启。\n\n' +
              '路径：设置 → 应用和元服务 → DeepSeek Harness → 权限 → 全盘文件访问 → 允许。\n\n' +
              '开启后 DSH 才能读写工作区（默认：个人文件夹）下的任意文件；' +
              '未开启时仅可访问「下载」「文档」目录。');
        }
      } else {
        this.statusText = 'DeepSeek Harness server 启动超时';
        DshmLogger.error(TAG, 'DSH server 启动超时，回读 node 日志');
        await DshBootstrap.dumpNodeLogs(hostCtx);
        const nodeLogTail: string = DshBootstrap.readNodeLogTail(hostCtx);
        if (nodeLogTail.length > 0) {
          this.statusText = 'DeepSeek Harness server 启动失败\n' + nodeLogTail;
        }
        await DshBootstrap.dumpFallbackDiag(hostCtx);
        await DshBootstrap.dumpWebProfileManifest(hostCtx);
        // 待验收的环境切换起不来 → 回滚到切换前并再重启一次应用。
        // 先清标记，避免重启后被再次判定为「待验收」而形成回滚循环。
        if (DshBootstrap.hasPendingVerify(hostCtx) && DshBootstrap.hasEnvBackup(hostCtx)) {
          DshmLogger.error(TAG, '环境包切换后启动失败，回滚到切换前环境');
          DshBootstrap.clearPendingVerify(hostCtx);
          if (DshBootstrap.rollbackEnv(hostCtx)) {
            this.statusText = '新环境启动失败，已回滚，正在重启…';
            await this.sleep(1000);
            appRecovery.restartApp();
            return;
          }
          DshmLogger.error(TAG, '回滚失败，需用「重置运行环境（故障恢复）」');
        }
      }
    } catch (e) {
      const msg: string = e instanceof Error ? e.message : String(e);
      this.statusText = '启动失败: ' + msg;
      this.bootError = true;
      DshmLogger.error(TAG, '启动失败: ' + msg);
    } finally {
      this.stopBootTicker();
      await this.resolvePendingEnvSwitch();
    }
  }

  /**
   * 首屏白屏兜底（按内容判断，最多 4 次）。
   *
   * 为什么不用「就绪后固定 4s 重载一次」：2026-09-11 重建安装后实测仍会白屏，
   * 必须手动「编辑→刷新」；固定时点既可能太早（客户端 11MB 合并包还没到），
   * 也可能在已经渲染成功时无谓打断加载。这里改成读 DOM 内容长度来决定。
   */
  private async ensureFirstPaintVisible(): Promise<void> {
    if (this.initialReloadDone) {
      return;
    }
    this.initialReloadDone = true;
    const delays: number[] = [2500, 3000, 4000, 6000];
    for (let i = 0; i < delays.length; i++) {
      await this.sleep(delays[i]);
      if (!this.ready || !this.controller) {
        return;
      }
      const chars: number = await this.pageTextLength();
      if (chars < 0) {
        DshmLogger.warn(TAG, '首屏兜底：无法读取页面文本长度，跳过本轮');
        continue;
      }
      if (chars >= 40) {
        DshmLogger.info(TAG, '首屏内容已渲染（文本 ' + chars + ' 字符），无需兜底重载');
        return;
      }
      DshmLogger.warn(TAG, '首屏疑似白屏（文本仅 ' + chars + ' 字符），第 ' + (i + 1) + ' 次兜底重载');
      try {
        this.controller.refresh();
      } catch (e) {
        DshmLogger.warn(TAG, '首屏兜底重载失败: ' + this.errOf(e));
      }
    }
    DshmLogger.error(TAG, '多次兜底重载后首屏仍疑似空白，请手动「编辑 → 刷新」');
  }

  /** 读取当前页面可见文本长度；失败返回 -1（不据此判定白屏）。 */
  private pageTextLength(): Promise<number> {
    return new Promise<number>((resolve: (value: number) => void) => {
      try {
        this.controller.runJavaScript(
          '(function(){try{var b=document.body;if(!b||!b.innerText){return 0;}' +
          'return b.innerText.replace(/\\s+/g,"").length;}catch(e){return -1;}})()',
          (err: BusinessError, result: string): void => {
            if (err) {
              resolve(-1);
              return;
            }
            const n: number = Number(result);
            resolve(Number.isNaN(n) ? -1 : n);
          });
      } catch (e) {
        resolve(-1);
      }
    });
  }

  /**
   * 冷启动计时反馈。
   *
   * --jitless 下 dsh 全量 JS 只能解释执行：本机实测（x86 主机）冷启动 17.8s，
   * 2in1 真机约 26-33s，环境版本变化时还要多约 6.6s 解压。启动页必须给出
   * 可感知的进度，否则用户会以为卡死。
   */
  private startBootTicker(): void {
    if (this.bootTicker !== -1) {
      return;
    }
    const startedAt: number = Date.now();
    this.bootTicker = setInterval((): void => {
      if (this.ready) {
        this.stopBootTicker();
        return;
      }
      const secs: number = Math.floor((Date.now() - startedAt) / 1000);
      this.statusText = '正在启动 DeepSeek Harness 运行时…\n' +
        (this.bootPhase.length > 0 ? this.bootPhase + '\n' : '') +
        '已用时 ' + secs + ' 秒' +
        (secs >= 15 ? '\n（--jitless 解释执行，首次启动通常 30 秒左右）' : '');
    }, 1000);
  }

  private stopBootTicker(): void {
    if (this.bootTicker !== -1) {
      clearInterval(this.bootTicker);
      this.bootTicker = -1;
    }
  }

  // ============ 顶栏菜单动作 ============
  /** Harness: 主页 —— 回到 DSH web 首页。 */
  private goHome(): void {
    DshmLogger.info(TAG, '菜单：回到主页 ' + HOME_URL);
    if (this.ready && this.controller) {
      this.controller.loadUrl(HOME_URL);
    }
  }

  /** Harness: 选择工作区 —— 拉起目录选择器（可到个人目录下），选中后同步到沙箱 workspace。 */
  private async chooseWorkspace(): Promise<void> {
    const hostCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.statusText = '正在拉起目录选择器…';
    const uri: string = await WorkspaceAccess.chooseWorkspaceFromMenu(hostCtx);
    if (uri === '') {
      this.showDialog('选择工作区', '未选择目录（已取消，或当前设备不支持目录选择）。');
      return;
    }
    this.showDialog('工作区已就绪', '已授权并同步目录：\n' + uri + '\n\n刷新页面后 tool-fs/bash 即可读写该目录内容。');
  }

  /** Harness: 检查 App 更新 —— 弹窗展示当前 HAP 版本。 */
  private async checkAppUpdate(): Promise<void> {
    let appVer: string = '?';
    try {
      const info = await bundleManager.getBundleInfoForSelf(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
      appVer = info.versionName;
    } catch (e) {
      appVer = '?';
    }
    this.showDialog('检查应用（App）更新', '当前 DeepSeek Harness App 版本：' + appVer + '\n\n' +
      '应用本体更新随安装包发布；有新版请重新安装 HAP。\n' +
      '要查看 DSH 与运行时版本，请用 Harness → 关于版本。');
  }

  /** Harness: 关于版本 —— App / DSH / 运行时（node）版本一览。 */
  private async showAboutVersions(): Promise<void> {
    const hostCtxForMode = this.getUIContext().getHostContext() as common.UIAbilityContext;
    let appVer: string = '?';
    let appCode: string = '?';
    try {
      const info = await bundleManager.getBundleInfoForSelf(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
      appVer = info.versionName;
      appCode = String(info.versionCode);
    } catch (e) {
      DshmLogger.warn(TAG, '读取 App 版本失败: ' + this.errOf(e));
    }
    let dshVer: string = '读取中…';
    let nodeVer: string = '读取中…';
    let stagedVer: string = '';
    let platform: string = '';
    let envRoot: string = '';
    let koffiVer: string = '';
    try {
      const resp = await this.httpGetJson(VERSION_ENDPOINT) as VersionResp;
      if (resp.ok === true) {
        dshVer = (resp.dsh ?? '') .length > 0 ? (resp.dsh as string) : '未知';
        nodeVer = resp.node ?? '未知';
        stagedVer = resp.staged ?? '';
        const k: string = resp.koffi ?? '';
        koffiVer = k === 'native' ? '真原生模块（可用）'
          : (k === 'stub' ? 'stub（FFI 不可用）' : (k.length > 0 ? k : ''));
        platform = (resp.platform ?? '') + '/' + (resp.arch ?? '');
        envRoot = resp.envRoot ?? '';
      } else {
        dshVer = '运行时未就绪';
        nodeVer = '运行时未就绪';
      }
    } catch (e) {
      // 服务未起来时退化为读文件，至少能看到内置环境版本。
      const hostCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const candidates: string[] = [
        hostCtx.filesDir + '/dsh/node_modules/@deepseek-ai/dsh/package.json',
        hostCtx.filesDir + '/home/.dsh/profiles/node_modules/@deepseek-ai/dsh/package.json'
      ];
      dshVer = '未知';
      for (const p of candidates) {
        if (fileIo.accessSync(p)) {
          try {
            const pkg = JSON.parse(fileIo.readTextSync(p)) as DshPkgVersion;
            dshVer = pkg.version ?? '未知';
            break;
          } catch (parseError) {
            /* 继续尝试下一个 */
          }
        }
      }
      nodeVer = '未运行（服务未就绪）';
    }
    const modeInfo: RuntimeModeInfo = DshBootstrap.readActiveMode(hostCtxForMode);
    const modeLabel: string = '内嵌运行时（libnode/jitless）';
    const rows: AboutRow[] = [
      { label: '应用版本', value: appVer + '（versionCode ' + appCode + '）' },
      { label: 'DSH 版本', value: dshVer },
      { label: '运行时', value: 'node ' + nodeVer + (platform.length > 0 ? '　' + platform : '') }
    ];
    rows.push({ label: '内置环境', value: DshBootstrap.envVersion() });

    rows.unshift({ label: '运行模式', value: modeLabel });
    // 会话库：两种模式各自独立（切换模式即切换会话库），这是用户最常困惑的差异点。
    rows.push({
      label: '会话库（DSH_HOME）',
      value: modeInfo.dshHome.length > 0
        ? modeInfo.dshHome
        : DshBootstrap.dshHomeForMode(hostCtxForMode, false)
    });
    if (stagedVer.length > 0) {
      rows.push({ label: '待应用更新', value: '@deepseek-ai/dsh@' + stagedVer + '（已下载，确认后替换）' });
    }
    if (koffiVer.length > 0) {
      rows.push({ label: 'koffi（FFI）', value: koffiVer });
    }
    if (envRoot.length > 0) {
      rows.push({ label: '环境目录', value: envRoot });
    }
    this.aboutRows = rows;
    this.aboutOpen = true;
  }





  /** 更新包就绪后的确认：用户点“立即更新”才重启生效。 */
  /** 顶栏更新胶囊文案：有百分比显示百分比，否则退化为明细/已用时。 */












  /** 读取当前内置 Harness 版本（供检查更新与关于页复用）。 */
  private async readHarnessVersion(): Promise<string> {
    const hostCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const candidates: string[] = [
      hostCtx.filesDir + '/dsh/node_modules/@deepseek-ai/dsh/package.json',
      hostCtx.filesDir + '/home/.dsh/profiles/node_modules/@deepseek-ai/dsh/package.json'
    ];
    for (const p of candidates) {
      if (fileIo.accessSync(p)) {
        try {
          const pkg = JSON.parse(fileIo.readTextSync(p)) as DshPkgVersion;
          return pkg.version ?? '未知';
        } catch (e) {
          /* 单个文件解析失败则继续尝试下一个 */
        }
      }
    }
    return '未知';
  }

  /**
   * 版本检测过滤口径：只接受「稳定版（x.y.z）或 RC（x.y.z-rc.n）」，
   * 排除 alpha / beta / dev 等其它预发布。
   * @param version 形如 0.1.5 或 0.1.5-rc.2
   */
  private isAcceptableRelease(version: string): boolean {
    const idx: number = version.indexOf('-');
    if (idx >= 0) {
      const pre: string = version.substring(idx + 1);
      // 只认 rc 预发布；alpha/beta/dev 等一概排除
      return pre === 'rc' || pre.startsWith('rc.');
    }
    return true; // 无后缀 = 稳定版
  }

  /** 解析版本号的主.次.修部分；失败返回空串。 */
  private parseSemverCore(version: string): string {
    const idx: number = version.indexOf('-');
    const core: string = idx >= 0 ? version.substring(0, idx) : version;
    const parts: string[] = core.split('.');
    if (parts.length !== 3) {
      return '';
    }
    for (let i = 0; i < parts.length; i++) {
      if (!(/^[0-9]+$/.test(parts[i]))) {
        return '';
      }
    }
    return core;
  }

  /**
   * 比较两个版本，返回 >0 / 0 / <0。
   * 先比 主.次.修；相同再比 RC 序号（rc.n 越大越新），无后缀（稳定）> 任何 rc。
   */
  private compareVersions(a: string, b: string): number {
    const coreA: string = this.parseSemverCore(a);
    const coreB: string = this.parseSemverCore(b);
    if (coreA.length === 0 || coreB.length === 0) {
      return a.localeCompare(b);
    }
    const pa: string[] = coreA.split('.');
    const pb: string[] = coreB.split('.');
    for (let i = 0; i < 3; i++) {
      const na: number = parseInt(pa[i], 10);
      const nb: number = parseInt(pb[i], 10);
      if (na !== nb) {
        return na > nb ? 1 : -1;
      }
    }
    const aIsStable: boolean = a.indexOf('-') < 0;
    const bIsStable: boolean = b.indexOf('-') < 0;
    if (aIsStable !== bIsStable) {
      return aIsStable ? 1 : -1;
    }
    if (aIsStable) {
      return 0;
    }
    const ar: number = this.prereleaseNum(a);
    const br: number = this.prereleaseNum(b);
    return ar === br ? 0 : (ar > br ? 1 : -1);
  }

  /** 提取 rc 序号，如 0.1.5-rc.2 → 2；解析失败返回 0。 */
  private prereleaseNum(version: string): number {
    const idx: number = version.indexOf('-rc');
    if (idx < 0) {
      return 0;
    }
    let tail: string = version.substring(idx + 3);
    if (tail.startsWith('.')) {
      tail = tail.substring(1);
    }
    // tail 形如 "2" 或 "2.x…"，取第一段数值
    const dot: number = tail.indexOf('.');
    const numStr: string = dot >= 0 ? tail.substring(0, dot) : tail;
    if (!/^[0-9]+$/.test(numStr)) {
      return 0;
    }
    return parseInt(numStr, 10);
  }

  /** 探测指定版本是否已同步到 npm 镜像（淘宝优先，失败回退官方源）。 */
  private async isNpmVersionSynced(version: string): Promise<boolean> {
    const npmEndpoints: string[] = [
      'https://registry.npmmirror.com/@deepseek-ai/dsh/' + version,
      'https://registry.npmjs.org/@deepseek-ai/dsh/' + version
    ];
    for (let i = 0; i < npmEndpoints.length; i++) {
      try {
        await this.httpGetJson(npmEndpoints[i]);
        return true;
      } catch (e) {
        DshmLogger.warn(TAG, 'npm 版本探测未命中 ' + npmEndpoints[i] + ': ' + this.errOf(e));
      }
    }
    return false;
  }

  /** 从 GitHub Releases 可接受候选中取最新版本（仅 RC / 稳定版，排除 alpha）。 */
  private pickLatestRelease(list: GitHubRelease[]): string {
    let best: string = '';
    for (let i = 0; i < list.length; i++) {
      const tag: string = list[i].tag_name ?? '';
      let v: string = '';
      if (tag.startsWith('dsh-v')) {
        v = tag.substring(5);
      } else if (tag.length > 0) {
        v = tag;
      }
      if (v.length === 0 || !this.isAcceptableRelease(v)) {
        continue;
      }
      if (best.length === 0 || this.compareVersions(v, best) > 0) {
        best = v;
      }
    }
    return best;
  }

  /** Harness: 检查 Harness 更新 —— 仅 GitHub Releases（含 prerelease）检测，只取最新 RC / 稳定版、排除 alpha。 */
  private async checkHarnessUpdate(): Promise<void> {
    const harnessVer: string = await this.readHarnessVersion();
    let latest: string = '';
    let source: string = '';
    for (let i = 0; i < HARNESS_VERSION_ENDPOINTS.length && latest.length === 0; i++) {
      const endpoint: string = HARNESS_VERSION_ENDPOINTS[i];
      let label: string = '';
      if (endpoint.includes('gh-proxy.com')) {
        label = 'GitHub (gh-proxy.com 加速)';
      } else if (endpoint.includes('ghproxy.net')) {
        label = 'GitHub (ghproxy.net 加速)';
      } else {
        label = 'GitHub 直连';
      }
      try {
        const remote = await this.httpGetJson(endpoint);
        const list = remote as GitHubRelease[];
        const picked: string = this.pickLatestRelease(list);
        if (picked.length > 0) {
          latest = picked;
          source = label;
        }
      } catch (e) {
        DshmLogger.warn(TAG, '版本检查源失败 ' + endpoint + ': ' + this.errOf(e));
      }
    }
    if (latest.length === 0) {
      this.showDialog('检查 Harness 更新', '当前内置 Harness 版本：' + harnessVer +
        '\n\n远端版本检查失败（GitHub 加速源与直连均不可达），暂时无法自动更新。');
      return;
    }
    if (latest === harnessVer || (harnessVer !== '未知' && harnessVer.includes(latest))) {
      this.showDialog('检查 Harness 更新', '当前内置 Harness 版本：' + harnessVer +
        '\n远端最新版：' + latest + '（' + source + '）\n\n已经是最新版，无需更新。');
      return;
    }
    // 校验该版本是否已发布到 npm 镜像：dsh 是纯 npm 包，下载只能从 npm 拉。
    // GitHub 上打了 rc tag 但尚未同步到 npm 镜像时，无法在线安装，需明确提示，不假下载。
    const synced: boolean = await this.isNpmVersionSynced(latest);
    if (!synced) {
      this.showDialog('检测到 Harness 更新',
        '当前版本：' + harnessVer + '\nGitHub 最新版：' + latest + '（' + source + '）' +
        '\n\n该版本已发布（RC/稳定版），但尚未同步到 npm 镜像，当前无法在线安装。' +
        '\n可稍后重试，或等待上游发布该版本到 npm 后再更新。');
      return;
    }
    this.showDialogWithConfirm('检测到 Harness 更新',
      '当前版本：' + harnessVer + '\n远端最新版：' + latest + '（' + source + '）' +
      '\n\n更新包将从国内镜像下载（registry.npmmirror.com），失败自动回退官方源。' +
      '\n\n是否立即自动更新并重启服务？', '立即更新', () => this.doAutoUpdate(latest));
  }

  /** 执行自动更新：调服务端 /update 端点（dsh 目录内 pnpm add），成功后重启服务。 */
  private async doAutoUpdate(version: string): Promise<void> {
    DshmLogger.info(TAG, '开始自动更新 Harness to ' + version);
    this.updateRunning = true;
    this.updateReady = false;
    this.updateVersion = version;
    this.updateMsg = '正在连接更新服务…';
    this.updatePercent = 0;
    this.updateElapsed = 0;
    this.updateDetail = '';
    this.updateTrack = 'download';
    this.startUpdateTicker();
    try {
      const body: UpdateBody = { version: version };
      const resp = await this.postJson(UPDATE_ENDPOINT, body);
      if (resp === null || resp.responseCode !== 200) {
        this.updateRunning = false;
        this.showDialog('自动更新失败', '服务端 /update 不可用或已离线。\n请手动重新安装应用安装包完成更新。');
        return;
      }
      let started: boolean = false;
      let message: string = '更新请求未被受理。';
      try {
        const payload = JSON.parse(resp.result as string) as UpdateResp;
        started = (payload.ok === true && payload.started === true) || payload.running === true;
        message = payload.message ?? message;
      } catch (e) {
        message = '服务端应答无法解析。';
      }
      if (!started) {
        this.updateRunning = false;
        this.showDialog('自动更新失败', message + '\n\n请手动重新安装应用安装包完成更新。');
        return;
      }
      if (message.length > 0) {
        this.updateMsg = message;
      }
      const outcome: UpdateOutcome = await this.pollHarnessUpdate();
      this.updateRunning = false;
      this.stopUpdateTicker();
      if (!outcome.success) {
        this.updateTrack = '';
        DshmLogger.warn(TAG, '自动更新失败: ' + outcome.message);
        this.showDialog('自动更新失败', outcome.message + '\n\n请手动重新安装应用安装包完成更新。');
        return;
      }
      this.updateReady = true;
      this.updateTrack = '';
      this.updatePercent = 100;
      this.updateMsg = outcome.message;
      this.promptApplyUpdate(outcome.message);
    } finally {
      this.stopUpdateTicker();
      this.updateRunning = false;
    }
  }

  /** 顶栏更新胶囊文案：有百分比显示百分比，否则退化为明细/已用时。 */
  private updateChipText(): string {
    if (this.updateTrack === 'download') {
      return '下载中 ' + this.updatePercent + '%';
    }
    if (this.updateTrack === 'apply') {
      return '更新中 ' + this.updatePercent + '%';
    }
    if (this.updateTrack === 'rollback') {
      return '回滚中…';
    }
    if (this.updatePercent > 0) {
      return '更新中 ' + this.updatePercent + '%';
    }
    if (this.updateDetail.length > 0) {
      return '更新中 ' + this.updateDetail;
    }
    if (this.updateElapsed > 0) {
      return '更新中 ' + this.updateElapsed + 's';
    }
    return '更新中…';
  }

  private startUpdateTicker(): void {
    this.stopUpdateTicker();
    this.updateElapsed = 0;
    this.updateTicker = setInterval((): void => {
      this.updateElapsed += 2;
      if (this.updateTrack === 'apply' || this.updateTrack === 'download') {
        if (this.updatePercent < 90) {
          this.updatePercent = Math.min(90, this.updatePercent + 1);
        }
      }
    }, 2000);
  }

  private stopUpdateTicker(): void {
    if (this.updateTicker !== -1) {
      clearInterval(this.updateTicker);
      this.updateTicker = -1;
    }
  }

  private promptApplyUpdate(message: string): void {
    this.showDialogWithConfirm('更新包已就绪',
      (this.updateVersion.length > 0 ? 'Harness v' + this.updateVersion + ' ' : '') +
        '已下载并完成适配，暂存在本地（当前运行环境未改动）。\n\n' +
        message + '\n\n现在应用更新并重启 Harness 服务吗？\n' +
        '（若新版本在当前鸿蒙环境无法启动，会自动回滚到更新前的版本）',
      '立即更新', (): void => {
        this.applyUpdateWithRollback(message);
      });
  }

  private async applyUpdateWithRollback(updateMessage: string): Promise<void> {
    const hostCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.updateReady = false;
    this.applying = true;
    this.applyPhase = '正在应用更新包…';
    this.updateTrack = 'apply';
    this.updatePercent = 0;
    this.updateRunning = true;
    this.startUpdateTicker();
    let applied: boolean = false;
    try {
      const resp = await this.postJson(UPDATE_APPLY_ENDPOINT, {} as EmptyBody);
      if (resp !== null && resp.responseCode === 200) {
        const payload = JSON.parse(resp.result as string) as UpdateResp;
        applied = payload.ok === true;
        if (!applied) {
          this.showDialog('更新失败', (payload.message ?? '替换运行环境失败') + '\n\n当前环境未受影响。');
        }
      }
    } catch (e) {
      DshmLogger.warn(TAG, '应用更新包失败: ' + this.errOf(e));
    }
    if (!applied) {
      this.stopUpdateTicker();
      this.updateTrack = '';
      this.updateRunning = false;
      this.applying = false;
      this.applyPhase = '';
      if (!DshBootstrap.hasEnvBackup(hostCtx)) {
        this.showDialog('更新失败', '更新包替换失败，运行环境未改变，可继续使用当前版本。');
      }
      return;
    }
    this.applyPhase = '正在校验新版本能否启动…';
    if (this.updatePercent < 30) {
      this.updatePercent = 30;
    }
    const booted: boolean = await this.restartAndWait();
    if (booted) {
      this.stopUpdateTicker();
      DshBootstrap.discardEnvBackup(hostCtx);
      this.applying = false;
      this.applyPhase = '';
      this.updatePercent = 100;
      this.updateTrack = '';
      this.updateRunning = false;
      this.showDialog('更新已生效', updateMessage);
      return;
    }
    if (!DshBootstrap.hasEnvBackup(hostCtx)) {
      this.stopUpdateTicker();
      this.applying = false;
      this.applyPhase = '';
      this.updateTrack = '';
      this.updateRunning = false;
      this.showDialog('更新后启动失败',
        '新版本在当前设备上无法启动，且没有可用的回滚备份。\n请重新安装应用安装包恢复环境。');
      return;
    }
    this.updateTrack = 'rollback';
    this.updateMsg = '新版本无法启动，正在回滚到更新前的版本…';
    this.applyPhase = '新版本启动失败，正在回滚…';
    const rolled: boolean = DshBootstrap.rollbackEnv(hostCtx);
    let backOk: boolean = false;
    if (rolled) {
      this.applyPhase = '正在用旧版本恢复服务…';
      backOk = await this.restartAndWait();
    }
    this.updateRunning = false;
    this.stopUpdateTicker();
    this.updateTrack = '';
    this.applying = false;
    this.applyPhase = '';
    if (rolled && backOk) {
      this.showDialog('已回滚更新',
        '新版本在当前鸿蒙环境无法启动，已自动回滚到更新前的版本，应用可继续使用。\n\n' +
          '原因通常是新版本缺少构建期的鸿蒙适配（原生模块/插件补丁）。\n\n' + updateMessage);
    } else {
      this.showDialog('回滚失败', '自动回滚未能恢复运行，请重新安装应用安装包。');
    }
  }

  private async installEnvAsset(): Promise<void> {
    const hostCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.updateRunning = true;
    this.updateTrack = 'download';
    this.updatePercent = 0;
    this.updateMsg = '正在获取环境清单…';
    this.startUpdateTicker();
    try {
      const manifest: EnvManifest | null = await EnvAssetClient.fetchManifest(EnvAssetClient.defaultSources());
      if (manifest === null) {
        this.showDialog('环境包安装失败',
          '所有清单源均不可达或内容非法。\n\n开发期请确认本机静态服务器已启动、且 hdc fport 已映射到设备 loopback。');
        return;
      }
      const zipPath: string | null = await EnvAssetClient.downloadAsset(hostCtx, manifest,
        (p: EnvDownloadProgress): void => {
          this.updateMsg = '下载中（' + p.source + '）' + (p.received / 1048576).toFixed(1) +
            '/' + (p.total / 1048576).toFixed(1) + ' MB' +
            (p.attempt > 1 ? '（第 ' + p.attempt + ' 次尝试）' : '');
          this.updatePercent = p.total > 0 ? Math.min(99, Math.floor((p.received / p.total) * 100)) : 0;
        });
      if (zipPath === null) {
        this.showDialog('环境包安装失败', '所有下载源均失败，或 sha256 校验不通过（已拒绝该包）。');
        return;
      }
      this.updateMsg = '正在解压（共 ' + manifest.asset.entries + ' 个条目）…';
      this.updatePercent = 99;
      const stage: string = hostCtx.filesDir + '/env-staging';
      DshBootstrap.resetDirForStaging(stage);
      await EnvAssetClient.extractZip(zipPath, stage);
      const missing: string[] = EnvAssetClient.missingSentinels(stage, manifest.asset.sentinels);
      if (missing.length > 0) {
        this.showDialog('环境包校验未通过', '解压后缺少关键文件：\n' + missing.join('\n'));
        return;
      }
      this.updateMsg = '正在替换运行环境…';
      const err: string = DshBootstrap.installStagedEnv(hostCtx, stage, manifest.version);
      if (err.length > 0) {
        this.showDialog('环境包安装失败', err + '\n\n当前运行环境未受影响。');
        return;
      }
      this.applyPhase = '';
      this.updateMsg = '';
      this.showDialogWithConfirm('环境包已就绪，需重启生效',
        '已切换为在线环境包 v' + manifest.version + '（' + manifest.asset.entries + ' 个条目）。\n\n' +
          '点击「重启并生效」后重启 DeepSeek Harness 服务；' +
          '若新环境无法启动，会自动回滚到当前环境。',
        '重启并生效', (): void => {
          this.restartAfterEnvSwitch(manifest.version);
        });
    } catch (e) {
      this.showDialog('环境包安装异常', this.errOf(e));
    } finally {
      this.stopUpdateTicker();
      this.updateRunning = false;
      this.updateTrack = '';
      this.updateMsg = '';
    }
  }

  private async restartAfterEnvSwitch(version: string): Promise<void> {
    const hostCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.updateRunning = true;
    this.applyPhase = '正在重启服务…';
    this.updateMsg = '正在重启服务…';
    this.startUpdateTicker();
    try {
      const booted: boolean = await this.restartAndWait();
      if (booted) {
        DshBootstrap.discardEnvBackup(hostCtx);
        DshBootstrap.clearPendingVerify(hostCtx);
        this.showDialog('环境包已生效', '已切换到在线环境包 v' + version + '。');
        return;
      }
      DshmLogger.error(TAG, '在线环境包启动失败，回滚');
      DshBootstrap.clearPendingVerify(hostCtx);
      if (DshBootstrap.hasEnvBackup(hostCtx) && DshBootstrap.rollbackEnv(hostCtx)) {
        const back: boolean = await this.restartAndWait();
        this.showDialog(back ? '已回滚' : '回滚失败',
          back ? '在线环境包在当前设备无法启动，已回滚到原有环境。'
            : '请用菜单「重置运行环境（故障恢复）」。');
      } else {
        this.showDialog('环境包启动失败', '无可用回滚备份，请用菜单「重置运行环境（故障恢复）」。');
      }
    } catch (e) {
      this.showDialog('重启失败', this.errOf(e));
    } finally {
      this.stopUpdateTicker();
      this.updateRunning = false;
      this.applyPhase = '';
      this.updateMsg = '';
    }
  }

  private async resolvePendingEnvSwitch(): Promise<void> {
    const hostCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    if (!DshBootstrap.hasPendingVerify(hostCtx)) {
      return;
    }
    try {
      const ready: boolean = DshBootstrap.countWebReadyMarkers(hostCtx) > 0;
      if (ready) {
        DshmLogger.info(TAG, '在线环境包验收通过（日志已见 dsh web:）');
        DshBootstrap.discardEnvBackup(hostCtx);
        DshBootstrap.clearPendingVerify(hostCtx);
        return;
      }
      DshmLogger.error(TAG, '在线环境包验收失败（日志无 dsh web:），回滚');
      DshBootstrap.clearPendingVerify(hostCtx);
      if (DshBootstrap.hasEnvBackup(hostCtx) && DshBootstrap.rollbackEnv(hostCtx)) {
        this.statusText = '新环境启动失败，已回滚';
        await this.sleep(800);
        appRecovery.restartApp();
      }
    } catch (e) {
      DshmLogger.warn(TAG, '待验收收尾异常: ' + this.errOf(e));
    }
  }

  private async showUpdateProgress(): Promise<void> {
    if (this.updateReady) {
      this.promptApplyUpdate(this.updateMsg);
      return;
    }
    try {
      const status = await this.httpGetJson(UPDATE_ENDPOINT) as UpdateStatusResp;
      const msg: string = status.message ?? '';
      if (this.updateRunning || status.running === true) {
        this.showDialog('Harness 更新进行中',
          '阶段：' + (status.phase ?? '') + '\n' + (msg.length > 0 ? msg : '正在进行中…') +
            '\n\n更新在后台执行，可继续使用应用；完成后会提示是否应用。');
        return;
      }
      if (status.done === true && status.success === true) {
        this.updateVersion = status.version ?? this.updateVersion;
        this.updateReady = true;
        this.updateMsg = msg;
        this.promptApplyUpdate(msg);
        return;
      }
      if (status.staged === true) {
        this.updateVersion = status.version ?? this.updateVersion;
        this.updateReady = true;
        this.updateMsg = msg;
        this.promptApplyUpdate(msg);
        return;
      }
      this.showDialog('Harness 更新', msg.length > 0 ? msg : '当前没有进行中的更新任务。');
    } catch (e) {
      this.showDialog('查看更新进度', '无法读取更新状态：' + this.errOf(e));
    }
  }

  private async pollHarnessUpdate(): Promise<UpdateOutcome> {
    const deadline: number = Date.now() + UPDATE_POLL_TIMEOUT_MS;
    let failures: number = 0;
    let lastPhase: string = '';
    while (Date.now() < deadline) {
      await this.sleep(UPDATE_POLL_INTERVAL_MS);
      let status: UpdateStatusResp | null = null;
      try {
        status = await this.httpGetJson(UPDATE_ENDPOINT) as UpdateStatusResp;
        failures = 0;
      } catch (e) {
        failures++;
        if (failures >= UPDATE_POLL_MAX_FAILURES) {
          return { success: false, message: '更新过程中服务端持续无响应（已等待约 ' +
            (UPDATE_POLL_INTERVAL_MS / 1000 * UPDATE_POLL_MAX_FAILURES) + 's），已中止等待。' };
        }
        continue;
      }
      const phase: string = status.phase ?? '';
      if (phase.length > 0 && phase !== lastPhase) {
        lastPhase = phase;
        DshmLogger.info(TAG, '更新阶段: ' + phase);
      }
      const text: string = status.message ?? '';
      if (text.length > 0 && text !== this.updateMsg) {
        this.updateMsg = text;
      }
      const percent: number = status.percent ?? 0;
      if (percent > this.updatePercent && percent <= 100) {
        this.updatePercent = percent;
      }
      const resolved: number = status.resolved ?? 0;
      const added: number = status.added ?? 0;
      const downloaded: number = status.downloaded ?? 0;
      const detail: string = resolved > 0
        ? ('已就绪 ' + added + '/' + resolved + '，已下载 ' + downloaded)
        : '';
      if (detail.length > 0 && detail !== this.updateDetail) {
        this.updateDetail = detail;
      }
      if (status.done === true) {
        return { success: status.success === true, message: text };
      }
    }
    return { success: false, message: '等待更新完成超时；服务端可能仍在安装，可稍后重启应用确认。' };
  }

  private resetRuntimeEnv(): void {

    this.showDialogWithConfirm('重置运行环境',
      '将从安装包重新解压一份干净的 DSH 运行环境（约 10–60 秒），用于修复更新失败或环境损坏。\n\n' +
        '会话、工作区与 API Key 保存在应用数据目录的 home 下，不会被清除。\n\n确定继续吗？',
      '重置', (): void => {
        this.doResetRuntimeEnv();
      });
  }

  private async doResetRuntimeEnv(): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    this.updateRunning = true;
    this.updateMsg = '正在重新解压运行环境…';
    this.updatePercent = 0;
    const hostCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    try {
      // 先按内嵌模式的通道停掉旧实例并**等它真正退出**，再重解压，避免旧 node
      // 继续引用即将被删除的文件（等价于旧实现的 /dshm-admin/restart + 端口探测，
      // 但用 node-exited 标记判定，确定且不依赖 http 探测）。
      const stopped: boolean = await DshBootstrap.stopDsh(hostCtx, 'embedded', 30000);
      if (!stopped) {
        DshmLogger.warn(TAG, '重置前旧 node 未确认退出，仍继续重解压（旧进程可能已死）');
      }
      this.stopUiEventPoll();
      this.closeTerminal();
      const rebuilt: boolean = await DshBootstrap.forceReinstallEnv(hostCtx);
      if (!rebuilt) {
        this.showDialog('重置失败', '重新解压运行环境失败，请重新安装应用安装包。');
        return;
      }
      DshBootstrap.clearNodeLogs(hostCtx);
      // 重解压会清掉 profiles/node_modules（内含 dshm-* 镜像），必须重做镜像，
      // 否则 profile 解析不到 dshm-terminal 会直接崩（ERR_MODULE_NOT_FOUND）。
      DshBootstrap.ensureBundleMirror(hostCtx);
      await DshBootstrap.launchDsh();
      this.ready = await DshBootstrap.waitForServer(hostCtx, 120000);
      if (this.ready) {
        this.webUrl = DshBootstrap.readWebUrl(hostCtx);
        this.controller.loadUrl(this.webUrl);
        this.startUiEventPoll();
        this.showDialog('运行环境已重置', '已重新解压并启动 DSH 运行环境，界面应已恢复正常。');
      } else {
        this.showDialog('重置后仍未就绪', '重新解压完成但服务未就绪，请查看设备日志或重新安装应用安装包。');
      }
    } catch (e) {
      this.showDialog('重置失败', this.errOf(e));
    } finally {
      this.updateRunning = false;
      this.restarting = false;
    }
  }



  /** Harness: 重启服务 → 请求进程退出（应答后 200ms 退出），等待离线后重新拉起。 */
  private async restartService(): Promise<void> {
    await this.restartAndWait();
  }

  /**
   * 重启服务并等待就绪，返回是否成功。
   *
   * 统一流程（2026-09-13 重写，同时服务「重启服务」与「切换运行模式」）：
   *   1. 按**当前生效模式**停掉旧实例，并确定性等待它真正退出（host 等 host-stopped、
   *      embedded 等 node-exited）——旧实例的监听套接字必须先释放，否则新模式实例
   *      绑不上 3080 或两个实例交替抢端口；
   *   2. 清掉上一轮日志与陈旧 boot-state（就绪判据要读新日志）；
   *   3. 重新 launchDsh()：起一个**读当前 runtime-mode.txt** 的 native 进程，
   *      因此切换模式后不需要任何额外分支，新模式自然生效；
   *   4. 等 `dsh web:` 标记出现（文件读取，可靠）。
   *
   * 关键点：切换模式时这里读的是**旧模式**（要用旧模式的通道去停它），
   * 而第 3 步起的是新模式，两者不能混。
   */
  private async restartAndWait(): Promise<boolean> {
    if (this.restarting) return false;
    this.restarting = true;
    this.statusText = '正在重启 DeepSeek Harness 服务...';
    DshmLogger.info(TAG, '主菜单：重启 DSH 服务');
    this.stopUiEventPoll();
    this.closeTerminal();
    const hostCtx0 = this.getUIContext().getHostContext() as common.UIAbilityContext;

    try {
      // 停旧 → 清日志 → 重做镜像 → 按当前 mode 拉起 → 等 `dsh web:` 标记。
      // 与 Dock 菜单、托盘菜单共用 DshmAppActions.restartDsh（唯一实现，避免漂移）。
      this.ready = await DshmAppActions.restartDsh(hostCtx0);
      if (this.ready) {
        this.webUrl = DshBootstrap.readWebUrl(hostCtx0);
        this.statusText = 'Harness 服务已重启';
        this.controller.loadUrl(this.webUrl);
        this.startUiEventPoll();
        DshmLogger.info(TAG, '服务重启完成，加载 ' + this.webUrl);
        return true;
      }
      this.statusText = '重启后服务未就绪';
      return false;
    } catch (e) {
      this.statusText = '重启服务失败: ' + this.errOf(e);
      return false;
    } finally {
      this.restarting = false;
    }
  }

  /** 编辑: 撤销（Ctrl+Z）。 */
  private undo(): void {
    this.execCommand('undo');
  }

  /** 编辑: 重做（Ctrl+Y）。 */
  private redo(): void {
    this.execCommand('redo');
  }

  private execCommand(cmd: string): void {
    DshmLogger.info(TAG, '顶栏：execCommand ' + cmd);
    if (!this.ready || !this.controller) return;
    // ArkWeb 没有原生 undo/redo API（@ohos.web.webview 无 sendKeyEvent/undo），
    // 只能走页面内的 document.execCommand。该命令只对"当前获得焦点的可编辑元素"
    // 生效，焦点在页面空白处时会静默失败 —— 所以先把焦点交回可编辑元素再执行。
    const js: string = '(() => {'
      + ' var el = document.activeElement;'
      + ' if (!el) return false;'
      + ' var tag = el.tagName;'
      + ' if (el.isContentEditable || tag === "INPUT" || tag === "TEXTAREA") {'
      + ' el.focus();'
      + ' return document.execCommand("' + cmd + '");'
      + ' }'
      + ' return false; })()';
    this.controller.runJavaScript(js).catch(() => { /* 焦点不在可编辑区域时忽略 */ });
  }

  /** 编辑: 刷新 → 强制 ArkWeb 重载当前页面（等价 Ctrl+R）。 */
  private refreshView(): void {
    DshmLogger.info(TAG, '顶栏：刷新 ArkWeb');
    if (this.ready && this.controller) {
      this.controller.refresh(true);
    }
  }

  /** 编辑: 终端 toggle（右侧边栏，pty 会话）。 */
  private toggleTerminal(): void {
    if (this.terminalOpen) {
      this.closeTerminal();
    } else {
      this.terminalOpen = true;
      this.startTerminalSession();
      // 面板刚展开，输入行要等首帧渲染后才存在，延后一帧再交还焦点。
      setTimeout(() => { this.focusTermInput(); }, 100);
    }
  }

  /**
   * 展开终端并等待 pty 会话建立（供「运行环境」面板的一键命令使用）。
   *
   * `startTerminalSession` 内部是异步建会话 + 轮询，这里按会话 id 就绪为条件
   * 做有限次等待，避免把命令发给尚不存在的会话。
   */
  private async openTerminal(): Promise<void> {
    if (!this.terminalOpen) {
      this.terminalOpen = true;
      this.startTerminalSession();
    }
    for (let i = 0; i < 40 && this.termSid <= 0; i++) {
      await new Promise<void>((resolve: () => void) => {
        setTimeout(() => { resolve(); }, 150);
      });
    }
  }

  /**
   * 窗口: 最小化（后台运行，应用常驻，点击系统托盘图标即可打开）。
   *
   * 不用 `win.minimize()`：在 2in1 上实测该调用没有可见效果（窗口不收起）。
   * 改为 hideAbility() —— 窗口隐藏、应用继续后台运行，托盘图标常驻可见；
   * 用户点托盘图标（或右键菜单"打开"）即由 EntryAbility 调 showAbility() 唤回。
   * 这与官方《PC应用通过系统托盘后台保活》的隐藏/唤回语义完全一致。
   */
  private async minimizeWindow(): Promise<void> {
    try {
      const hostCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      await hostCtx.hideAbility();
      DshmLogger.info(TAG, '窗口已隐藏到后台（托盘常驻）');
    } catch (e) {
      DshmLogger.warn(TAG, '最小化（隐藏到后台）失败: ' + this.errOf(e));
    }
  }

  /**
   * 窗口: 关闭窗口（等价 Ctrl+W）—— 退出整个应用，并停掉 DSH web 服务。
   *
   * 退出链路由 EntryAbility 统一编排：摘掉系统托盘图标 → 结束主 Ability
   * （DSH 的 node/web 服务跑在主 Ability 所属进程的 native 子进程里，进程回收
   * 即服务停止）→ 绑托盘的后台保活进程通过公共事件一并结束。
   *
   * 这里走事件而不是直接 terminateSelf：托盘图标必须先摘掉，否则会留下一个
   * 点不开的幽灵托盘图标。若事件链路异常（订阅者创建失败等），600ms 后兜底
   * 直接结束主 Ability，保证"关闭"在任何情况下都有效。
   *
   * 注意：这里**不能**对主窗口调 `win.destroy()` —— 主窗口销毁后 ArkUI 实例
   * 即失效，而 node 子进程仍在，会留下"界面还在但整条顶栏点不动"的僵尸窗口。
   */
  private async closeWindow(): Promise<void> {
    DshmLogger.info(TAG, '窗口：退出应用（真退出 + 停服务）');
    this.termStopPoll();
    this.stopUiEventPoll();
    const hostCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    try {
      StatusBarTray.publishExitRequest();
      setTimeout((): void => {
        hostCtx.terminateSelf().then((): void => {
          DshmLogger.info(TAG, '应用已退出，DSH 服务随进程回收');
        }).catch((e: Object): void => {
          DshmLogger.warn(TAG, '退出兜底失败: ' + this.errOf(e));
        });
      }, 600);
    } catch (e) {
      DshmLogger.warn(TAG, '退出应用失败: ' + this.errOf(e));
    }
  }

  /** 通用错误转字符串。 */
  private errOf(e: Object): string {
    return e instanceof Error ? e.message : String(e);
  }

  // ============ 服务端事件（插件安装后刷新/重启） ============

  private startUiEventPoll(): void {
    if (this.uiEventPoller !== -1) return;
    this.uiEventPoller = setInterval(() => { this.pollUiEvents(); }, 4000);
    DshmLogger.info(TAG, '已启动服务端事件轮询');
  }

  private stopUiEventPoll(): void {
    if (this.uiEventPoller !== -1) {
      clearInterval(this.uiEventPoller);
      this.uiEventPoller = -1;
    }
  }

  private async pollUiEvents(): Promise<void> {
    if (!this.ready) return;
    const url: string = UI_EVENTS_GET + '?since=' + String(this.uiEventSince);
    const client = http.createHttp();
    try {
      const resp = await client.request(url, { method: http.RequestMethod.GET, connectTimeout: 3000, usingProxy: false });
      if (resp.responseCode === 200) {
        const payload = JSON.parse(resp.result as string) as UiEventsResp;
        this.uiEventSince = payload.since;
        for (const ev of payload.events) {
          DshmLogger.info(TAG, '服务端事件: ' + ev.type + ' (id ' + ev.id + ')');
          if (ev.type === 'refresh') {
            this.refreshView();
          } else if (ev.type === 'restart' && !this.restarting) {
            this.restartService();
          }
        }
      }
    } catch (e) {
      /* 服务重启窗口期忽略单次失败 */
    } finally {
      client.destroy();
    }
  }

  // ============ 终端侧边栏 ============

  private async httpGetJson(url: string): Promise<Object> {
    const client = http.createHttp();
    try {
      const resp = await client.request(url, {
        method: http.RequestMethod.GET,
        connectTimeout: 5000,
        readTimeout: 8000,
        usingProxy: false,
        expectDataType: http.HttpDataType.STRING
      });
      if (resp.responseCode !== 200) {
        throw new Error('HTTP ' + String(resp.responseCode));
      }
      const raw = resp.result as string;
      return JSON.parse(raw);
    } finally {
      client.destroy();
    }
  }

  private async postJson(url: string, body: EmptyBody | UpdateBody | StartBody | WriteBody | KillBody): Promise<http.HttpResponse | null> {
    const client = http.createHttp();
    try {
      return await client.request(url, {
        method: http.RequestMethod.POST,
        header: { 'content-type': 'application/json' },
        extraData: JSON.stringify(body),
        connectTimeout: 5000,
        readTimeout: 5000,
        usingProxy: false
      });
    } catch (e) {
      DshmLogger.warn(TAG, 'POST ' + url + ' 失败: ' + this.errOf(e));
      return null;
    } finally {
      client.destroy();
    }
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private showDialog(title: string, message: string): void {
    this.getUIContext().showAlertDialog({
      title: title,
      message: message,
      autoCancel: true
    });
  }

  private showDialogWithConfirm(title: string, message: string, confirmLabel: string, onConfirm: () => void): void {
    this.getUIContext().showAlertDialog({
      title: title,
      message: message,
      autoCancel: true,
      primaryButton: { value: confirmLabel, action: (): void => onConfirm() },
      secondaryButton: { value: '取消', action: (): void => {} }
    } as AlertDialogParamWithButtons);
  }

  /** 打开 pty 终端会话并启动轮询（shell 按运行模式选择，服务端自动回退 /bin/sh）。 */
  private async startTerminalSession(): Promise<void> {
    if (this.termSid > 0) return;
    try {
      // 内嵌模式沙箱内没有 brew，用 hnp bash（dshm-terminal 找不到时回退 /bin/sh）。
      const shellName: string = 'bash';
      const body: StartBody = { shell: shellName };
      const resp = await this.postJson(TERM_START_ENDPOINT, body);
      if (resp !== null && resp.responseCode === 200) {
        const payload = JSON.parse(resp.result as string) as TermStartResp;
        if (payload.ok) {
          this.termSid = payload.sid;
          this.termPty = payload.pty === true;
          this.termConnected = true;
          // 只取可执行文件名（如 "zsh"），完整路径又长又没有交互价值
          // （实测会显示 "/storage/Users/currentUser/.harmonybrew/bin/zsh"）。
          const shellRaw: string = payload.shell ?? '';
          const slashAt: number = shellRaw.lastIndexOf('/');
          this.termShell = slashAt >= 0 ? shellRaw.substring(slashAt + 1) : shellRaw;
          this.termUser = payload.user ?? '';
          this.termHost = payload.host ?? '';
          this.termCwd = payload.cwd ?? '';
          // 横幅极简：模式已由标题栏徽标表达（pty/pipe），shell 名只取文件名。
          const shellRaw2: string = payload.shell ?? 'zsh';
          const slashAt2: number = shellRaw2.lastIndexOf('/');
          const shellName: string = slashAt2 >= 0 ? shellRaw2.substring(slashAt2 + 1) : shellRaw2;
          this.termLines = ['终端已连接 · ' + shellName + '。输入命令，回车执行。'];
          this.startPoll();
          this.focusTermInput();
          return;
        }
      }
      this.termLines.push('会话启动失败');
    } catch (e) {
      this.termLines.push('会话启动异常: ' + this.errOf(e));
    }
  }

  private startPoll(): void {
    if (this.termPoller !== -1) return;
    this.termPoller = setInterval(() => {
      if (this.termBusy) return;
      this.termBusy = true;
      this.pollRead()
        .then(() => { this.termBusy = false; })
        .catch(() => { this.termBusy = false; });
    }, 300);
  }

  private async pollRead(): Promise<void> {
    if (this.termSid <= 0) return;
    const url = TERM_READ_ENDPOINT + '?sid=' + this.termSid;
    const client = http.createHttp();
    try {
      const resp = await client.request(url, { method: http.RequestMethod.GET, connectTimeout: 3000, usingProxy: false });
      if (resp.responseCode === 200) {
        const payload = JSON.parse(resp.result as string) as TermReadResp;
        for (const line of payload.lines) {
          this.termLines.push(this.stripAnsi(line));
        }
        if (payload.exited) {
          this.termLines.push('[会话退出，code=' + String(payload.exitCode) + ']');
          this.termStopPoll();
        }
        this.scrollTermBottom();
      }
    } catch (e) {
      /* 面板关闭/进程重启时忽略单次失败 */
    } finally {
      client.destroy();
    }
  }

  /**
   * 清理终端输出为纯文本（仅显示用，丢弃所有控制序列）。
   *
   * 管道回退模式下 shell 不经过 pty 的行规程，大量非 CSI 控制序列会泄漏进
   * 输出流（2026-09-12 实测）：
   *   - OSC 9278 序列：`\u001b]9278;f;{"event": "SetupComplete"}\u0007`
   *     （ArkWeb 桥接的 viewport 标记，终端里纯属噪音）；
   *   - zsh 的粗体/反显提示符：`\u001b[1m\u001b[7m%\u001b[27m\u001b[0m`；
   *   - 其它 CSI（色码/光标）与 OSC 标题设置等。
   *
   * 原 stripAnsi 只匹配 `\u001b[...` 形式的 CSI，对 OSC（`\u001b]...` 终止于
   * BEL 或 ST）与独立 BEL 字符不生效，导致用户看到 `"SetupComplete"}` 这类
   * 半截 JSON。这里统一处理四类：CSI、OSC(BEL/ST 终止)、独立 BEL、其余 C0
   * 控制符（保留 \n \r \t）。
   */
  private stripAnsi(s: string): string {
    let out: string = s;
    // 1) OSC 序列：ESC ] ... 终止于 BEL(\x07) 或 ST(ESC \)
    // eslint-disable-next-line no-control-regex
    out = out.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '');
    // 2) CSI 序列：ESC [ ... 参数字节 + 终止字母
    // eslint-disable-next-line no-control-regex
    out = out.replace(/\u001b\[[0-9;?<>=! ]*[A-Za-z@`]/g, '');
    // 3) 独立 BEL（OSC 被截断时残留）
    // eslint-disable-next-line no-control-regex
    out = out.replace(/\u0007/g, '');
    // 4) 其余 C0 控制符（保留 \n \r \t）
    // eslint-disable-next-line no-control-regex
    out = out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    return out;
  }

  /**
   * 终端 prompt：固定 `用户名@localhost$`。
   *
   * 按反馈去掉主机名与工作目录 —— 原来会拼成
   * `Sol@MateBook-XXXX:/storage/Users/currentUser$`，路径过长且对交互没有帮助。
   * 主机名统一显示 localhost。
   */
  private termPrompt(): string {
    const role: string = this.termUser.length > 0 ? this.termUser :
      (this.termShell === '' ? 'dshm' : this.termShell);
    return role + '@localhost$';
  }

  /** cd 后同步本地 pwd（仅做展示，真实切换由 pty shell 完成）。 */
  private applyCd(text: string): void {
    const t: string = text.trim();
    if (t === 'cd') {
      this.termCwd = '~';
      return;
    }
    if (!t.startsWith('cd ')) return;
    const target: string = t.substring(3).trim().split(' ')[0];
    const cur: string = this.termCwd.length > 0 ? this.termCwd : '~';
    let next: string = target;
    if (target === '~') {
      next = '~';
    } else if (target.startsWith('/')) {
      next = target;
    } else if (target.startsWith('~/')) {
      next = '~/' + target.substring(2);
    } else if (cur === '~') {
      next = '~/' + target;
    } else if (target === '..') {
      const idx: number = cur.lastIndexOf('/');
      next = idx > 0 ? cur.substring(0, idx) : '/';
    } else if (target.startsWith('../')) {
      const idx: number = cur.lastIndexOf('/');
      const base: string = idx > 0 ? cur.substring(0, idx) : '/';
      next = base + '/' + target.substring(3);
    } else {
      next = cur + '/' + target;
    }
    // 收敛 . 与重复斜杠
    next = next.replace(/\/+/g, '/');
    if (next.length > 1 && next.endsWith('/')) {
      next = next.substring(0, next.length - 1);
    }
    this.termCwd = next;
  }

  private scrollTermBottom(): void {
    try {
      this.listScroller.scrollEdge(Edge.Bottom);
    } catch (e) {
      /* 无滚动需求时忽略 */
    }
  }

  /**
   * 把焦点交还终端输入行。
   *
   * 输入行现在是输出流的最后一个 ListItem，输出刷新会让列表重建，
   * 重建后输入框会失去焦点，因此需要在会话建立、以及每次提交命令后重新请求。
   */
  private focusTermInput(): void {
    if (!this.terminalOpen) return;
    try {
      this.getUIContext().getFocusController().requestFocus(TERM_INPUT_ID);
    } catch (e) {
      /* 输入行尚未挂载时忽略 */
    }
  }

  private termStopPoll(): void {
    if (this.termPoller !== -1) {
      clearInterval(this.termPoller);
      this.termPoller = -1;
    }
  }

  /**
   * 向终端会话发送**原始控制序列**（不 trim、不补换行）。
   *
   * 为什么必须与 `sendTermCommand()` 分开：
   *   - `sendTermCommand()` 会 `trim()` 并补 `\n`，而 `'\t'.trim() === ''`，
   *     Tab 会在发出前就被丢掉；
   *   - Tab / 方向键 / Ctrl-C / Esc 都是控制序列（`\t`、`\x1b[A`、`\x03`、`\x1b`），
   *     语义上也不是「一行命令」，不能附加回车。
   *
   * 仅在 pty 会话（`termPty === true`）下有意义：管道回退模式下 shell 的 stdin
   * 不是 tty，本就没有行编辑与补全，发了也不会有反应。
   */
  private async sendTermRaw(text: string): Promise<void> {
    if (this.termSid <= 0 || text.length === 0) return;
    const body: WriteBody = { sid: this.termSid, text: text, raw: true };
    await this.postJson(TERM_WRITE_ENDPOINT, body);
    this.focusTermInput();
  }

  /**
   * 终端按键直通：把键盘事件翻译成 shell 需要的控制序列。
   *
   * 背景（2026-09-13 实测）：终端输入行是 ArkUI `TextInput`，而 ArkUI 默认把
   * **Tab 当作焦点切换键**在框架层消费掉，`onChange/onSubmit` 永远收不到 `\t`，
   * 于是「Tab 补全没反应」。这里在 `onKeyEvent` 里拦下并 `stopPropagation()`，
   * 把按键交给 pty，行为与真实终端一致；返回 true 表示事件已消费。
   *
   * 触摸/无实体键盘场景由标题栏的 Tab / ^C / ↑ 按钮兜底（见终端标题栏）。
   */
  private onTermKeyEvent(event: KeyEvent): boolean {
    if (event.type !== KeyType.Down) return false;
    if (event.keyCode === KeyCode.KEYCODE_TAB) {
      this.sendTermRaw('\t');
      event.stopPropagation();
      return true;
    }
    if (event.keyCode === KeyCode.KEYCODE_DPAD_UP) {
      this.sendTermRaw('\u001b[A');
      event.stopPropagation();
      return true;
    }
    if (event.keyCode === KeyCode.KEYCODE_DPAD_DOWN) {
      this.sendTermRaw('\u001b[B');
      event.stopPropagation();
      return true;
    }
    if (event.keyCode === KeyCode.KEYCODE_ESCAPE) {
      this.sendTermRaw('\u001b');
      event.stopPropagation();
      return true;
    }
    // Ctrl-C 中断当前前台命令。
    if (event.keyCode === KeyCode.KEYCODE_C
      && event.getModifierKeyState !== undefined
      && event.getModifierKeyState(['ctrl'])) {
      this.sendTermRaw('\u0003');
      event.stopPropagation();
      return true;
    }
    return false;
  }

  /** 发送一行命令到终端。 */
  private async sendTermCommand(): Promise<void> {
    const text = this.termInput.trim();
    if (text.length === 0) return;
    this.termInput = '';
    this.applyCd(text);
    if (this.termSid <= 0) {
      this.termLines.push(this.termPrompt() + ' ' + text);
      this.scrollTermBottom();
      this.focusTermInput();
      return;
    }
    // 管道回退模式无回显：本地补一行 prompt+命令；pty 模式 shell 自身回显。
    if (this.termPty === false) {
      this.termLines.push(this.termPrompt() + ' ' + text);
      this.scrollTermBottom();
    }
    const body: WriteBody = { sid: this.termSid, text: text + '\n' };
    await this.postJson(TERM_WRITE_ENDPOINT, body);
    // 输出流追加后列表会重建，重新把焦点交还输入行，支持连续输入。
    this.focusTermInput();
  }

  private closeTerminal(): void {
    this.termStopPoll();
    if (this.termSid > 0) {
      const body: KillBody = { sid: this.termSid };
      this.postJson(TERM_KILL_ENDPOINT, body);
      this.termSid = -1;
    }
    this.termConnected = false;
    this.terminalOpen = false;
  }


  // ============ 三下拉菜单数据 ============

  /**
   * Harness 菜单。
   */
  private harnessMenu(): Array<MenuElement> {
    const items: Array<MenuElement> = [
      { value: '主页', action: (): void => { this.goHome(); } }
    ];
    items.push({ value: '关于版本', action: (): void => { this.showAboutVersions(); } });
    items.push({ value: '检查 App 更新', action: (): void => { this.checkAppUpdate(); } });
    items.push({ value: '检查 Harness 更新（自动）', action: (): void => { this.checkHarnessUpdate(); } });
    items.push({ value: '查看更新进度', action: (): void => { this.showUpdateProgress(); } });
    items.push({ value: '安装在线环境包（开发）', action: (): void => { this.installEnvAsset(); } });
    items.push({ value: '重置内嵌运行环境（故障恢复）', action: (): void => { this.resetRuntimeEnv(); } });
    items.push({ value: '重启服务', action: (): void => { this.restartService(); } });
    return items;
  }


  private editMenu(): Array<MenuElement> {
    return [
      { value: '撤销 (Ctrl+Z)', action: (): void => { this.undo(); } },
      { value: '重做 (Ctrl+Y)', action: (): void => { this.redo(); } },
      { value: '刷新', action: (): void => { this.refreshView(); } },
      { value: '终端 (zsh pty)', action: (): void => { this.toggleTerminal(); } }
    ];
  }

  private windowMenu(): Array<MenuElement> {
    return [
      { value: '关闭窗口 (Ctrl+W)', action: (): void => { this.closeWindow(); } },
      { value: '最小化（后台运行）', action: (): void => { this.minimizeWindow(); } }
    ];
  }

  // ============ UI ============

  @Builder

  MenuTitle(text: string, items: Array<MenuElement>) {
    Text(text)
      .fontSize(12)
      .fontColor('#334155')
      .padding({ left: 5, right: 5, top: 1, bottom: 1 })
      .borderRadius(3)
      .bindMenu(items)
      .onClick(() => { /* bindMenu 点击弹出 */ })
  }

  /** 运行环境面板的一行状态：名称 + 就绪指示。 */
  @Builder
  EnvRow(name: string, ready: boolean) {
    Row() {
      Text(ready ? '\u2713' : '\u2715')
        .fontSize(12)
        .fontColor(ready ? '#1a9e6a' : '#c0392b')
        .width(18)
      Text(name)
        .fontSize(12)
        .fontColor(this.immersiveEnabled ? $r('sys.color.font_primary') : '#1c2430')
        .layoutWeight(1)
      Text(ready ? '已就绪' : '未安装')
        .fontSize(11)
        .fontColor(ready ? '#1a9e6a' : '#94a3b8')
    }
    .width('100%')
    .height(26)
    .alignItems(VerticalAlign.Center)
  }

  /**
   * 顶栏（**必须为不透明实色**）。
   *
   * ⚠️ 回归教训（2026-09-12，实测踩坑）：本顶栏**不能**使用沉浸式系统材质。
   *
   * `EntryAbility.onWindowStageCreate` 调用了 `setWindowDecorVisible(false)`
   * 隐藏系统标题栏，于是系统的最小化/最大化/关闭三个窗口按钮**浮在应用顶栏之上**
   * 并由系统按浅色模式绘制**深色图标**。一旦顶栏改为半透明材质
   * （`systemMaterial` 会把 `backgroundColor` 恢复为透明色），会出现两个后果：
   *   1. 顶栏文字与系统按钮图标同时落在"半透明底 + Web 内容"之上，对比度崩溃，
   *      实测表现就是**菜单文字和右上角三个按钮全都看不清**（用户直接反馈）；
   *   2. Web 内容透出后与顶栏文字混叠，可读性进一步恶化。
   *
   * 结论：沉浸光感适用于「下方有内容可透出」的卡片/浮层，**不适用于背后压着系统
   * 按钮层的固定工具条**。顶栏保持白底 + 底部描边；沉浸光感只用在下方的面板卡片上
   * （那些场景背景有半透明遮罩，材质效果安全且观感更好）。
   */
  @Builder
  TopBar() {
    Row() {
      Image($r('app.media.logo_dark'))
        .width(16)
        .height(16)
        .borderRadius(3)
      Text('DeepSeek')
        .fontSize(12)
        .fontWeight(FontWeight.Medium)
        .fontColor('#1c2430')
        .margin({ left: 6, right: 12 })
      this.MenuTitle('Harness', this.harnessMenu())
      this.MenuTitle('编辑', this.editMenu())
      this.MenuTitle('窗口', this.windowMenu())
      // 更新状态小胶囊：只在顶栏占一格，不覆盖内容、不拦截点击，
      // 点它才展开详情/确认应用。
      if (this.updateRunning) {
        Row() {
          Text(this.updateChipText())
            .fontSize(11)
            .fontColor('#78350f')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .padding({ left: 8, right: 8, top: 3, bottom: 3 })
        .backgroundColor('#fef3c7')
        .borderRadius(10)
        .border({ width: 1, color: '#fcd34d' })
        .margin({ left: 8 })
        .onClick((): void => {
          this.showUpdateProgress();
        })
      } else if (this.updateReady) {
        Row() {
          Text('更新已就绪')
            .fontSize(11)
            .fontColor('#065f46')
        }
        .padding({ left: 8, right: 8, top: 3, bottom: 3 })
        .backgroundColor('#d1fae5')
        .borderRadius(10)
        .border({ width: 1, color: '#6ee7b7' })
        .margin({ left: 8 })
        .onClick((): void => {
          this.showUpdateProgress();
        })
      }
      Blank()
    }
    .width('100%')
    .height(TOP_BAR_HEIGHT)
    .padding({ left: 10, right: 4 })
    .backgroundColor('#ffffff')
    .alignItems(VerticalAlign.Center)
    .border({ width: { bottom: 1 }, color: '#e4e7ec' })
  }

  build() {
    Column() {
      // 顶栏：沉浸光感材质，见 TopBar() 实现。
      this.TopBar()

      // 内容区：Web + 右侧终端边栏
      Row() {
        Stack() {
          if (this.ready) {
            Web({ src: this.webUrl, controller: this.controller })
              .width('100%')
              .height('100%')
              .domStorageAccess(true)
              .onPageBegin((e: OnPageBeginEvent) => {
                DshmLogger.info(TAG, 'Web onPageBegin: ' + e.url);
              })
              .onPageEnd((e: OnPageEndEvent) => {
                DshmLogger.info(TAG, 'Web onPageEnd: ' + e.url);
              })
              .onHttpErrorReceive((e: OnHttpErrorReceiveEvent) => {
                DshmLogger.warn(TAG, 'Web onHttpError: ' + e.request.getRequestUrl() + ' code=' + String(e.response.getResponseCode()));
              })
              .onErrorReceive((e: OnErrorReceiveEvent) => {
                DshmLogger.error(TAG, 'Web onError: ' + e.request.getRequestUrl() + ' desc=' + e.error.getErrorInfo() + ' code=' + String(e.error.getErrorCode()));
              })
              .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
          } else {
            // 启动加载页：官方品牌 mark + 状态文案。mark 淡入后进入常驻呼吸循环，
            // 状态文案常显，即使动效未触发也不会出现整屏空白的降级画面。
            // 浅色主题：与顶栏、启动窗口（#F3F7FB + 深色字标）保持一致。
            Column() {
              Image($r('app.media.logo_dark'))
                .width(88)
                .height(88)
                .scale({ x: this.brandBreath, y: this.brandBreath })
                .opacity(this.brandOpacity)
              Text(this.statusText)
                .fontSize(14)
                .fontColor('#5b6472')
                .margin({ top: 24 })
                .textAlign(TextAlign.Center)
                .padding({ left: 24, right: 24 })
              // 启动失败时显示恢复按钮（借鉴 dsh 官方 desktop 的 emergency document）
              if (this.bootError) {
                Button('重置内嵌运行环境')
                  .fontSize(13)
                  .fontColor('#ffffff')
                  .backgroundColor('#4f6bed')
                  .borderRadius(6)
                  .height(36)
                  .margin({ top: 20 })
                  .onClick(() => {
                    this.bootError = false;
                    this.resetRuntimeEnv();
                  })
              }
            }
            .width('100%')
            .height('100%')
            .justifyContent(FlexAlign.Center)
            .alignItems(HorizontalAlign.Center)
            .backgroundColor('#F3F7FB')
            .onAppear(() => {
              this.startBrandAnimation();
            })
          }

          // 应用更新/回滚期间：旧 Web 还在内存里但即将被替换，内容不可用，
          // 用一层全屏提示把真实阶段说清楚（下载阶段不会出现这层）。
          if (this.applying) {
            Column() {
              LoadingProgress()
                .width(36)
                .height(36)
                .color('#f59e0b')
              Text(this.applyPhase)
                .fontSize(14)
                .fontColor('#334155')
                .margin({ top: 16 })
                .textAlign(TextAlign.Center)
                .padding({ left: 32, right: 32 })
              Text('请稍候，期间请不要关闭应用。')
                .fontSize(12)
                .fontColor('#94a3b8')
                .margin({ top: 8 })
            }
            .width('100%')
            .height('100%')
            .justifyContent(FlexAlign.Center)
            .backgroundColor('#F3F7FB')
          }

          // “关于版本”面板：页内浮层，左对齐排版。
          if (this.aboutOpen) {
            Column() {
              Column() {
                Text('关于版本')
                  .fontSize(16)
                  .fontWeight(FontWeight.Medium)
                  .fontColor('#1c2430')
                  .width('100%')
                  .textAlign(TextAlign.Start)
                Text('DeepSeek Harness on HarmonyOS')
                  .fontSize(11)
                  .fontColor('#94a3b8')
                  .width('100%')
                  .textAlign(TextAlign.Start)
                  .margin({ top: 2, bottom: 12 })
                ForEach(this.aboutRows, (row: AboutRow) => {
                  Row() {
                    Text(row.label)
                      .fontSize(12)
                      .fontColor('#64748b')
                      .width(84)
                      .textAlign(TextAlign.Start)
                      .flexShrink(0)
                    Text(row.value)
                      .fontSize(12)
                      .fontColor('#1c2430')
                      .layoutWeight(1)
                      .textAlign(TextAlign.Start)
                  }
                  .width('100%')
                  .alignItems(VerticalAlign.Top)
                  .margin({ top: 10 })
                }, (row: AboutRow) => row.label)
                Row() {
                  Button('关闭')
                    .fontSize(12)
                    .height(30)
                    .backgroundColor('#1c2430')
                    .fontColor('#ffffff')
                    .onClick((): void => {
                      this.aboutOpen = false;
                    })
                }
                .width('100%')
                .justifyContent(FlexAlign.End)
                .margin({ top: 18 })
              }
              .width(440)
              .padding(20)
              .alignItems(HorizontalAlign.Start)
              .backgroundColor('#ffffff')
              .borderRadius(12)
              .border({ width: 1, color: '#e4e7ec' })
            }
            .width('100%')
            .height('100%')
            .justifyContent(FlexAlign.Center)
            .alignItems(HorizontalAlign.Center)
            .backgroundColor('#33000000')
          }


        }
        .width('100%')
        .height('100%')
        .layoutWeight(1)

        // 终端侧边栏：与 dsh 本体 UI 视觉语言对齐
        //（浅色底、圆角、系统字体、语义状态色；顶栏同色系，避免黑白割裂）
        if (this.terminalOpen) {
          Column() {
            // 标题栏：状态点 + 标题 + 环境标记 + 操作
            Row() {
              Circle({ width: 7, height: 7 })
                .fill(this.termConnected ? '#1a9e6a' : '#c0c6d0')
                .margin({ right: 8 })
              Text('终端')
                .fontSize(13)
                .fontWeight(FontWeight.Medium)
                .fontColor('#1c2430')
              Text(this.termPty ? 'pty' : 'pipe')
                .fontSize(10)
                .fontColor('#64748b')
                .backgroundColor('#eef2f7')
                .borderRadius(4)
                .padding({ left: 5, right: 5, top: 1, bottom: 1 })
                .margin({ left: 8 })
              Blank()
              // 触摸兜底：实体键盘的 Tab/↑/Ctrl-C 由 onTermKeyEvent 直通，
              // 触屏（平板/手机）上没有这些键，用按钮发送同样的控制序列。
              Text('Tab')
                .fontSize(12)
                .fontColor(this.termPty ? '#64748b' : '#c0c6d0')
                .padding({ left: 8, right: 8, top: 3, bottom: 3 })
                .borderRadius(5)
                .onClick(() => { this.sendTermRaw('\t'); })
              Text('↑')
                .fontSize(12)
                .fontColor(this.termPty ? '#64748b' : '#c0c6d0')
                .padding({ left: 8, right: 8, top: 3, bottom: 3 })
                .borderRadius(5)
                .margin({ left: 2 })
                .onClick(() => { this.sendTermRaw('\u001b[A'); })
              Text('^C')
                .fontSize(12)
                .fontColor(this.termPty ? '#64748b' : '#c0c6d0')
                .padding({ left: 8, right: 8, top: 3, bottom: 3 })
                .borderRadius(5)
                .margin({ left: 2 })
                .onClick(() => { this.sendTermRaw('\u0003'); })
              Text('清屏')
                .fontSize(12)
                .fontColor('#64748b')
                .padding({ left: 8, right: 8, top: 3, bottom: 3 })
                .borderRadius(5)
                .onClick(() => { this.termLines = []; })
              Text('关闭')
                .fontSize(12)
                .fontColor('#64748b')
                .padding({ left: 8, right: 8, top: 3, bottom: 3 })
                .borderRadius(5)
                .margin({ left: 4 })
                .onClick(() => this.closeTerminal())
            }
            .padding({ left: 12, right: 8, top: 8, bottom: 8 })
            .width('100%')
            .backgroundColor('#f7f9fc')
            .border({ width: { bottom: 1 }, color: '#e4e7ec' })

            // 会话信息条：user@host + cwd（对齐 dsh 的语义化信息展示）
            if (this.termConnected == false) {
              Row() {
                Text('正在连接终端…')
                  .fontSize(11)
                  .fontColor('#94a3b8')
              }
              .width('100%')
              .padding({ left: 12, right: 12, top: 6, bottom: 6 })
              .backgroundColor('#fbfcfe')
            }

            List({ space: 0, scroller: this.listScroller }) {
              ForEach(this.termLines, (line: string) => {
                ListItem() {
                  Text(line.length === 0 ? ' ' : line)
                    .width('100%')
                    .fontSize(12)
                    .fontFamily('monospace')
                    .fontColor('#24292f')
                    .padding({ left: 12, right: 8, top: 1.5, bottom: 1.5 })
                    .textAlign(TextAlign.Start)
                }
              }, (line: string, index: number) => index.toString())

              // 输入行内联在输出流末尾：提示符 + 输入框就是最后一行，
              // 随输出一起滚动，而不是钉死在面板底部（对齐 mac 端终端手感）。
              ListItem() {
                Row() {
                  Text(this.termPrompt())
                    .fontSize(12)
                    .fontFamily('monospace')
                    .fontColor('#1a9e6a')
                    .maxLines(1)
                  TextInput({ text: this.termInput })
                    .id(TERM_INPUT_ID)
                    .layoutWeight(1)
                    .fontSize(12)
                    .fontFamily('monospace')
                    .fontColor('#24292f')
                    .caretColor('#1a9e6a')
                    .backgroundColor(Color.Transparent)
                    .borderRadius(0)
                    .padding({ left: 6, right: 0, top: 0, bottom: 0 })
                    .onChange((v: string) => { this.termInput = v; })
                    .onSubmit(() => { this.sendTermCommand(); })
                    // Tab 补全 / 历史 / Esc / Ctrl-C 直通到 pty（见 onTermKeyEvent 注释）。
                    .onKeyEvent((event: KeyEvent): boolean => this.onTermKeyEvent(event))
                }
                .width('100%')
                .alignItems(VerticalAlign.Center)
                .padding({ left: 12, right: 8, top: 1.5, bottom: 1.5 })
              }
            }
            .layoutWeight(1)
            .backgroundColor('#ffffff')
            .scrollBar(BarState.Auto)
          }
          .width(440)
          .height('100%')
          .backgroundColor('#ffffff')
          .border({ width: { left: 1 }, color: '#e4e7ec' })
        }
      }
      .width('100%')
      .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#0a0a0d')
    .keyboardShortcut('z', [ModifierKey.CTRL], () => { this.undo(); })
    .keyboardShortcut('y', [ModifierKey.CTRL], () => { this.redo(); })
    .keyboardShortcut('w', [ModifierKey.CTRL], () => { this.closeWindow(); })
  }
}
