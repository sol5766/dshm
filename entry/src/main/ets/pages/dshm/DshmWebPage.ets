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
import { common, bundleManager, appRecovery } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { fileIo } from '@kit.CoreFileKit';
import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { DshBootstrap, RuntimeModeInfo } from '../../dshm/bootstrap/DshBootstrap';
import { WorkspaceAccess } from '../../dshm/access/WorkspaceAccess';
import { writeOhosInfo } from '../../dshm/access/OhosInfoBridge';
import { DshmLogger } from '../../dshm/utils/Logger';
import { StatusBarTray } from '../../dshm/system/StatusBarTray';
import { EnvAssetClient, EnvManifest, EnvDownloadProgress } from '../../dshm/env/EnvAssetClient';

const TAG: string = 'DshmWebPage';
const HOME_URL: string = 'http://127.0.0.1:3080';
const RESTART_ENDPOINT: string = 'http://127.0.0.1:3080/dshm-admin/restart';
const UPDATE_ENDPOINT: string = 'http://127.0.0.1:3080/dshm-admin/update';
const UPDATE_APPLY_ENDPOINT: string = 'http://127.0.0.1:3080/dshm-admin/update/apply';
const VERSION_ENDPOINT: string = 'http://127.0.0.1:3080/dshm-admin/version';
// Harness 更新是服务端后台任务（同进程 Worker 跑 pnpm），ArkTS 侧轮询进度；
// 单次 HTTP 请求只负责“开始”与“查进度”，不承担长连接等待。
const UPDATE_POLL_INTERVAL_MS: number = 4000;
const UPDATE_POLL_TIMEOUT_MS: number = 15 * 60 * 1000;
// 连续查询失败次数上限（4s 一次 → 默认 40s 无响应即判定服务端已不可用）。
const UPDATE_POLL_MAX_FAILURES: number = 10;
const UI_EVENTS_GET: string = 'http://127.0.0.1:3080/dshm-admin/ui/events';
const TERM_START_ENDPOINT: string = 'http://127.0.0.1:3080/dshm-terminal/start';
const TERM_WRITE_ENDPOINT: string = 'http://127.0.0.1:3080/dshm-terminal/write';
const TERM_READ_ENDPOINT: string = 'http://127.0.0.1:3080/dshm-terminal/read';
const TERM_KILL_ENDPOINT: string = 'http://127.0.0.1:3080/dshm-terminal/kill';
// Harness 版本检查源：国内镜像优先，失败再回退官方源。
const HARNESS_VERSION_ENDPOINTS: string[] = [
  'https://registry.npmmirror.com/@deepseek-ai/dsh/latest',
  'https://registry.npmjs.org/@deepseek-ai/dsh/latest'
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

interface NpmLatestPkg {
  version?: string;
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

/** “关于版本”面板的一行（左对齐标签 + 值）。 */
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
  /**
   * 进度阶段（ArkTS 自己维护，不依赖服务进程）：
   *   ''        未进行
   *   download  正在下载/准备更新包
   *   apply     正在应用更新（替换环境 + 重启校验）
   *   rollback  新版本起不来，正在回滚
   * 服务端只在上报可用时覆盖百分比；服务不可用时按本机计时继续推进，
   * 保证用户始终看得到“还在动”。
   */
  @State private updateTrack: string = '';
  private updateTicker: number = -1;
  // 更新包已下载/安装完成，等待用户确认后重启生效（不确认就一直挂在小胶囊上）。
  @State private updateReady: boolean = false;
  @State private updateVersion: string = '';
  // 应用更新（替换环境 + 重启校验）期间界面会短暂不可用，用全屏提示说明进度。
  @State private applying: boolean = false;
  @State private applyPhase: string = '';
  // “关于版本”面板（页内浮层，便于左对齐排版，不用系统 alert 的居中文本）
  @State private aboutOpen: boolean = false;
  @State private aboutRows: AboutRow[] = [];
  // 运行模式面板（宿主 dsh / 内嵌运行时）
  @State private modeOpen: boolean = false;
  @State private modeCurrent: string = 'auto';
  @State private modeActive: string = '';
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
      DshBootstrap.ensureBundleMirror(hostCtx);
      // 品牌迁移：用户 profile 里遗留的旧 bundle 名必须在 dsh 启动前改掉，
      // 否则 dsh-app-boot 解析不到 bundle 会直接 abort（实测 SIGNAL 6）。
      DshBootstrap.migrateLegacyProfileBundleNames(hostCtx);
      mark('t4.wsInfo');
      await DshBootstrap.launchDsh();
      DshmLogger.info(TAG, '等待 DSH server 就绪...');
      const serverUp: boolean = await DshBootstrap.waitForServer(hostCtx, 120000);
      mark('t5.serverReady');
      if (serverUp) {
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
      DshmLogger.error(TAG, '启动失败: ' + msg);
    } finally {
      // 无论走成功分支还是超时分支（含中途抛异常），都要处理待验收的环境切换：
      // 否则会留下 .dshm-pending-verify + 几百 MB 备份，且下次 boot 失败会误触发回滚。
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
    const modeLabel: string = modeInfo.mode === 'host'
      ? '宿主 dsh（Harmonybrew' + (modeInfo.version.length > 0 ? ' ' + modeInfo.version : '') + '）'
      : '内嵌运行时（libnode/jitless）';
    // 宿主模式下「DSH 版本 / 运行时」应以宿主为准（内嵌端点此时不可用）。
    if (modeInfo.mode === 'host') {
      if (modeInfo.version.length > 0) {
        dshVer = modeInfo.version;
      }
      if (modeInfo.nodeVersion.length > 0) {
        nodeVer = modeInfo.nodeVersion;
        platform = 'Harmonybrew node';
      }
    }
    const rows: AboutRow[] = [
      { label: '应用版本', value: appVer + '（versionCode ' + appCode + '）' },
      { label: 'DSH 版本', value: dshVer },
      { label: '运行时', value: 'node ' + nodeVer + (platform.length > 0 ? '　' + platform : '') },
      { label: '内置环境', value: DshBootstrap.envVersion() }
    ];
    rows.unshift({ label: '运行模式', value: modeLabel });
    if (modeInfo.dshPath.length > 0) {
      rows.push({ label: '宿主 dsh', value: modeInfo.dshPath });
    }
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

  /** 读取当前内置 Harness 版本（供检查更新与关于页复用）。 */
  /**
   * 宿主模式下的更新检查。
   *
   * 宿主 dsh 由 Harmonybrew 管理：应用沙箱内**无法执行 brew**（brew 需要 zsh，
   * 而沙箱里没有任何可执行的 zsh，用 sh 跑会报 "Zsh is required to run brew"），
   * 所以这里只做版本比对 + 给出终端升级指引，升级后重启服务即可生效。
   */
  private async checkHostHarnessUpdate(active: RuntimeModeInfo): Promise<void> {
    const installed: string = active.version.length > 0 ? active.version : '未知';
    let latest: string = '';
    let source: string = '';
    for (let i = 0; i < HARNESS_VERSION_ENDPOINTS.length && latest.length === 0; i++) {
      const endpoint: string = HARNESS_VERSION_ENDPOINTS[i];
      try {
        const remote = await this.httpGetJson(endpoint) as NpmLatestPkg;
        const v: string = remote.version ?? '';
        if (v.length > 0) {
          latest = v;
          source = endpoint.includes('npmmirror') ? '淘宝镜像' : 'npm 官方源';
        }
      } catch (e) {
        DshmLogger.warn(TAG, '版本检查源失败 ' + endpoint + ': ' + this.errOf(e));
      }
    }
    if (latest.length === 0) {
      this.showDialog('检查 Harness 更新',
        '运行模式：宿主 dsh（Harmonybrew）\n当前版本：' + installed +
          '\n\n远端版本检查失败（镜像与官方源均不可达）。');
      return;
    }
    if (latest === installed) {
      this.showDialog('检查 Harness 更新',
        '运行模式：宿主 dsh（Harmonybrew）\n当前版本：' + installed +
          '\n远端最新版：' + latest + '（' + source + '）\n\n已经是最新版，无需更新。');
      return;
    }
    this.showDialog('检测到 Harness 更新（宿主模式）',
      '当前（Harmonybrew 安装）：' + installed + '\n远端最新版：' + latest + '（' + source + '）\n\n' +
        '宿主模式由 Homebrew 管理版本，应用沙箱内无法执行 brew（它需要 zsh）。\n' +
        '请在系统终端执行：\n\n    brew upgrade deepseek-harness\n\n' +
        '升级完成后，回到「Harness → 重启服务」即可加载新版本。');
  }

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

  /** Harness: 检查 Harness 更新 —— 远端 npm 检测到新版后自动执行更新并重启服务。 */
  private async checkHarnessUpdate(): Promise<void> {
    const hostCtxNow = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const activeMode: RuntimeModeInfo = DshBootstrap.readActiveMode(hostCtxNow);
    if (activeMode.mode === 'host' && DshBootstrap.readRuntimeMode(hostCtxNow) !== 'embedded') {
      await this.checkHostHarnessUpdate(activeMode);
      return;
    }
    const harnessVer: string = await this.readHarnessVersion();
    let latest: string = '';
    let source: string = '';
    // 国内镜像优先（设备直连 registry.npmjs.org 常超时）；任一源成功即采用。
    for (let i = 0; i < HARNESS_VERSION_ENDPOINTS.length && latest.length === 0; i++) {
      const endpoint: string = HARNESS_VERSION_ENDPOINTS[i];
      try {
        const remote = await this.httpGetJson(endpoint) as NpmLatestPkg;
        const v: string = remote.version ?? '';
        if (v.length > 0) {
          latest = v;
          source = endpoint.includes('npmmirror') ? '淘宝镜像' : 'npm 官方源';
        }
      } catch (e) {
        DshmLogger.warn(TAG, '版本检查源失败 ' + endpoint + ': ' + this.errOf(e));
      }
    }
    if (latest.length === 0) {
      this.showDialog('检查 Harness 更新', '当前内置 Harness 版本：' + harnessVer +
        '\n\n远端版本检查失败（镜像与官方源均不可达），无法自动更新。');
      return;
    }
    if (latest === harnessVer || (harnessVer !== '未知' && harnessVer.includes(latest))) {
      this.showDialog('检查 Harness 更新', '当前内置 Harness 版本：' + harnessVer +
        '\n远端最新版：' + latest + '（' + source + '）\n\n已经是最新版，无需更新。');
      return;
    }
// 检测到新版 → 确认后自动更新
    this.showDialogWithConfirm('检测到 Harness 更新',
      '当前版本：' + harnessVer + '\n远端最新版：' + latest + '（' + source + '）' +
      '\n\n更新包将从国内镜像下载（registry.npmmirror.com），失败自动回退官方源。' +
      '\n\n是否立即自动更新并重启服务？', '立即更新', () => this.doAutoUpdate(latest));
  }

  /** 执行自动更新：调服务端 /update 端点（dsh 目录内 pnpm add），成功后重启服务。 */
  private async doAutoUpdate(version: string): Promise<void> {
    // 宿主模式由 Harmonybrew 管版本，应用内不跑 pnpm/替换环境。
    const activeNow: RuntimeModeInfo = DshBootstrap.readActiveMode(
      this.getUIContext().getHostContext() as common.UIAbilityContext);
    if (activeNow.mode === 'host') {
      await this.checkHostHarnessUpdate(activeNow);
      return;
    }
    DshmLogger.info(TAG, '开始自动更新 Harness to ' + version);
    // 更新是服务端后台任务：这里只做“启动 + 轮询”，界面只用顶栏一枚小胶囊
    // 显示进度，不覆盖内容、不挡操作。
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
        // 已有任务在跑时不要当成失败：直接转入进度轮询。
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
      // 真实安装远超 HTTP 读超时，改由后台任务执行 + 轮询取进度。
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
      // 下载/安装完成后才征询：用户确认后才重启生效，否则一直挂在小胶囊上。
      this.promptApplyUpdate(outcome.message);
    } finally {
      this.stopUpdateTicker();
      this.updateRunning = false;
    }
  }

  /** 更新包就绪后的确认：用户点“立即更新”才重启生效。 */
  /** 顶栏更新胶囊文案：有百分比显示百分比，否则退化为明细/已用时。 */
  /** 打开运行模式面板（宿主 dsh / 内嵌运行时）。 */
  private openModePanel(): void {
    const hostCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.modeCurrent = DshBootstrap.readRuntimeMode(hostCtx);
    const info: RuntimeModeInfo = DshBootstrap.readActiveMode(hostCtx);
    this.modeActive = info.mode === 'host'
      ? '当前生效：宿主 dsh（Harmonybrew' + (info.version.length > 0 ? ' ' + info.version : '') + '）'
      : '当前生效：内嵌运行时（libnode / --jitless）';
    this.modeOpen = true;
  }

  /** 切换运行模式并重启服务。 */
  private applyRuntimeMode(mode: string): void {
    const hostCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    DshBootstrap.writeRuntimeMode(hostCtx, mode);
    this.modeOpen = false;
    const label: string = mode === 'host' ? '宿主 dsh（Harmonybrew）'
      : (mode === 'embedded' ? '内嵌运行时' : '自动（有宿主就用宿主）');
    this.showDialog('运行模式已切换',
      '已设置为：' + label + '\n\n正在重启 Harness 服务以生效…');
    this.restartService();
  }

  /** 读取当前生效模式（未启动时回退到用户选择）。 */
  private currentMode(): string {
    const hostCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    return DshBootstrap.readActiveMode(hostCtx).mode;
  }

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

  /**
   * 启动本机进度计时器（与 DSH 服务进程完全解耦）。
   *
   * 服务端上报的真实百分比只会把进度“往上顶”；服务未就绪/未响应时，
   * 由本机按已用时把进度推到 90%，用户始终能看到进度在动。
   */
  private startUpdateTicker(): void {
    this.stopUpdateTicker();
    this.updateElapsed = 0;
    this.updateTicker = setInterval((): void => {
      this.updateElapsed += 2;
      if (this.updateTrack === 'apply' || this.updateTrack === 'download') {
        if (this.updatePercent < 90) {
          // 每 2s 涨 1%，90% 封顶等待真实结果。
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

  /**
   * 更新后验收：重启服务，起不来就整体回滚备份并再重启一次。
   *
   * 服务端更新任务只能做静态校验（文件齐备 + 原生模块 import），无法证明新
   * 版本真能启动 —— 实测 dsh 0.1.5 的树两项都过，但 boot 时卡在插件加载阶段。
   * 因此最终验收放在这里：失败即回滚，保证用户始终有可用环境。
   */
  private async applyUpdateWithRollback(updateMessage: string): Promise<void> {
    const hostCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.updateReady = false;
    // 第一步：把暂存环境替换进活环境（此前的下载/适配全程没碰活环境）。
    // 注意：替换后旧服务仍在内存里跑，界面暂时还能用；真正切换在下面的重启。
    this.applying = true;
    this.applyPhase = '正在应用更新包…';
    // 应用/重启阶段的进度也由本机维护：服务要重启，期间根本没人在上报。
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
    // 第二步：切换需要重启服务；这里界面会短暂不可用，所以用全屏提示进度。
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

  /**
   * 故障恢复：把运行环境从安装包重新解压一份干净的。
   *
   * 用于更新失败/回滚后环境损坏（表现为白屏、服务端返回资源不完整）等
   * 普通重启治不好的情况。会话/工作区/API Key 在 filesDir/home，不受影响。
   */
  /**
   * 在线环境包安装（M2/M3 第一步）。链路：拉 manifest → 多源 failover 下载 + sha256
   * → 系统 zlib 解压到暂存目录 → 按 manifest.sentinels 校验。
   *
   * 本步**只做下载/解压/校验，不切换活环境**，用于在真机上验证整条链路。
   * 原子切换与回退复用 DshBootstrap 现成的 backup/rollback 原语，随后接入。
   */
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
      // 原子切换：备份 → 换树 → 写版本标记 → 活环境哨兵复校（内部失败即回滚）
      this.updateMsg = '正在替换运行环境…';
      const err: string = DshBootstrap.installStagedEnv(hostCtx, stage, manifest.version);
      if (err.length > 0) {
        this.showDialog('环境包安装失败', err + '\n\n当前运行环境未受影响。');
        return;
      }
      // 按用户确认的交互：**不自动重启**，先告知「已就绪」，由用户点按钮触发重启。
      // 重启走确定性通道（restart-request → node 退出 → node-exited → 重新拉起），
      // 既不用 appRecovery（本设备实测为空操作），也不用 http 探测 loopback（不可靠）。
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

  /**
   * 用户在「环境包已就绪」对话框点「重启并生效」后执行：
   * 确定性重启服务 → 验收（日志 `dsh web:` 标记）→ 成功即清理备份与标记；失败即回滚再重启。
   */
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

  /**
   * 待验收的环境切换收尾。
   *
   * 判定「新环境是否起来了」**只用 node 日志里的 `dsh web:` 标记**（`countWebReadyMarkers`
   * 读文件），不依赖 ArkTS 侧 http 探测 loopback —— 后者实测不可靠（服务明明在跑却判失败，
   * 见 bug-log 2026-09-11），会导致 boot 走超时分支、成功分支里的收尾被跳过。
   *
   * 成功 → 丢弃备份 + 清标记（切换正式生效）；失败 → 回滚 + 清标记（避免回滚循环）。
   */
  private async resolvePendingEnvSwitch(): Promise<void> {
    const hostCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    if (!DshBootstrap.hasPendingVerify(hostCtx)) {
      return;
    }
    try {
      // boot 前已 clearNodeLogs，故本环境启动成功时日志里必有新的 `dsh web:`
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
      // 先让旧服务退出，避免它继续引用即将被删除的文件。
      try {
        await this.postJson(RESTART_ENDPOINT, {} as EmptyBody);
      } catch (e) {
        DshmLogger.warn(TAG, '重置前停止服务失败（可能已退出）: ' + this.errOf(e));
      }
      await this.waitPortDown(10000);
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

  /** 菜单项：查看 Harness 更新进度（后台任务可在使用过程中持续进行）。 */
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
        // 上一轮已下好但用户没确认的更新包：直接给出应用入口。
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

  /**
   * 轮询后台更新进度：每 2s 取一次 GET /dshm-admin/update。
   * 连续查询失败达阈值视为服务端已不可用（更新可能已中断），提前结束。
   */
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
      // 只在内容变化时写 @State：轮询期间频繁赋值会让整页反复重建，是卡顿来源。
      if (text.length > 0 && text !== this.updateMsg) {
        this.updateMsg = text;
      }
      const percent: number = status.percent ?? 0;
      // 服务端真实百分比只“往上顶”，本机计时器负责在服务不可用时维持推进。
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

  /** Harness: 重启服务 → 请求进程退出（应答后 200ms 退出），等待离线后重新拉起。 */
  private async restartService(): Promise<void> {
    await this.restartAndWait();
  }

  /**
   * 重启服务并等待就绪，返回是否成功。
   * 更新后的环境仅靠服务端静态校验无法证明可启动，这里在重启后做最终验收。
   */
  private async restartAndWait(): Promise<boolean> {
    if (this.restarting) return false;
    this.restarting = true;
    this.statusText = '正在重启 DeepSeek Harness 服务...';
    DshmLogger.info(TAG, '主菜单：重启 DSH 服务');
    this.stopUiEventPoll();
    this.closeTerminal();
    const hostCtx0 = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const hostMode: boolean = DshBootstrap.readActiveMode(hostCtx0).mode === 'host'
      && DshBootstrap.readRuntimeMode(hostCtx0) !== 'embedded';
    try {
      if (hostMode) {
        // 宿主模式：native 守候进程负责结束并重新拉起 dsh（无 /dshm-admin 端点）
        const markersBefore: number = DshBootstrap.countWebReadyMarkers(hostCtx0);
        DshBootstrap.requestHostRestart(hostCtx0);
        this.ready = await this.waitForNewWebMarker(hostCtx0, markersBefore, 90000);
      } else {
        // 内嵌模式：文件信号让旧 node 退出 → 等 node-exited（确定性）→ 拉起新实例。
        // 全程不依赖 http 探测 loopback（不可靠，会造成新旧 node 抢 3080）。
        const exited: boolean = await DshBootstrap.requestEmbeddedRestart(hostCtx0, 25000);
        if (!exited) {
          this.statusText = '旧服务未退出，重启已取消';
          DshmLogger.error(TAG, '旧 node 未在超时内退出，放弃重启（避免抢端口）');
          return false;
        }
        DshmLogger.info(TAG, '旧进程已退出，拉起新实例');
        DshBootstrap.clearNodeLogs(hostCtx0);
        // 重启也必须重做 bundle 镜像：profile 的 web bundles 里挂着 dshm-*，
        // 而 ensureDshDir 在版本变化时会清掉 profiles/node_modules；不重镜像
        // 就会 ERR_MODULE_NOT_FOUND: Cannot find package 'dshm-terminal' 直接崩。
        DshBootstrap.ensureBundleMirror(hostCtx0);
        await DshBootstrap.launchDsh();
        // 就绪判定用日志里的 `dsh web:`（文件读取，可靠）
        this.ready = await DshBootstrap.waitForWebMarker(hostCtx0, 120000);
      }
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

  /** 等待日志里出现新的 `dsh web:` 标记（宿主模式重启用）。 */
  private async waitForNewWebMarker(hostCtx: common.UIAbilityContext, before: number, timeoutMs: number): Promise<boolean> {
    const deadline: number = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.sleep(1000);
      if (DshBootstrap.countWebReadyMarkers(hostCtx) > before) {
        return true;
      }
    }
    return false;
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

  private async httpProbe(timeoutMs: number): Promise<http.HttpResponse> {
    const client = http.createHttp();
    try {
      return await client.request(HOME_URL, {
        method: http.RequestMethod.GET,
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
        usingProxy: false
      });
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

  /** 探测端口直到不再响应（驱动旧进程退出），最多 maxWaitMs，间隔 200ms。 */
  private async waitPortDown(maxWaitMs: number): Promise<boolean> {
    const deadline: number = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      try {
        await this.httpProbe(300);
      } catch (e) {
        return true;
      }
      await this.sleep(200);
    }
    return false;
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

  /** 打开 pty 终端会话并启动轮询（zsh，服务端自动回退 /bin/sh）。 */
  private async startTerminalSession(): Promise<void> {
    if (this.termSid > 0) return;
    try {
      const body: StartBody = { shell: 'zsh' };
      const resp = await this.postJson(TERM_START_ENDPOINT, body);
      if (resp !== null && resp.responseCode === 200) {
        const payload = JSON.parse(resp.result as string) as TermStartResp;
        if (payload.ok) {
          this.termSid = payload.sid;
          this.termPty = payload.pty === true;
          this.termConnected = true;
          this.termShell = payload.shell ?? '';
          this.termUser = payload.user ?? '';
          this.termHost = payload.host ?? '';
          this.termCwd = payload.cwd ?? '';
          const shellName: string = payload.shell ?? 'zsh';
          this.termLines = ['DeepSeek Harness 终端 · ' + shellName +
            (this.termPty ? '（pty）' : '（管道回退）') + '。输入命令，回车执行。'];
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

  /** 移除终端输出中的 ANSI 转义序列（仅显示文本，保色码丢弃）。 */
  private stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    const re = /\u001b\[[0-9;?]*[A-Za-z]/g;
    return s.replace(re, '');
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

  private harnessMenu(): Array<MenuElement> {
    return [
      { value: '主页', action: (): void => { this.goHome(); } },
      { value: '关于版本', action: (): void => { this.showAboutVersions(); } },
      { value: '运行模式（宿主 / 内嵌）', action: (): void => { this.openModePanel(); } },
      { value: '检查 App 更新', action: (): void => { this.checkAppUpdate(); } },
      { value: '检查 Harness 更新（自动）', action: (): void => { this.checkHarnessUpdate(); } },
      { value: '查看更新进度', action: (): void => { this.showUpdateProgress(); } },
      { value: '安装在线环境包（开发）', action: (): void => { this.installEnvAsset(); } },
      { value: '重置运行环境（故障恢复）', action: (): void => { this.resetRuntimeEnv(); } },
      { value: '重启服务', action: (): void => { this.restartService(); } }
    ];
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
  ModeRow(mode: string, text: string) {
    Row() {
      Text(this.modeCurrent === mode ? '●' : '○')
        .fontSize(12)
        .fontColor(this.modeCurrent === mode ? '#1c2430' : '#94a3b8')
        .width(18)
      Text(text)
        .fontSize(12)
        .fontColor('#1c2430')
        .layoutWeight(1)
        .textAlign(TextAlign.Start)
    }
    .width('100%')
    .padding({ top: 8, bottom: 8 })
    .alignItems(VerticalAlign.Center)
    .onClick((): void => {
      this.applyRuntimeMode(mode);
    })
  }

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

  build() {
    Column() {
      // 顶栏：品牌 + 三菜单 —— 全部同一条水平线。
      // 底色取白：EntryAbility 隐藏了系统标题栏，系统窗口按钮（最小化/最大化/
      // 关闭）会浮在顶栏右端，系统按浅色模式绘制深色图标，深色底会让它们完全看不见。
      // 因此顶栏用浅色主题：白底 + 深色 logo + 深色文字。
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
            .backgroundColor('#66000000')
          }

          // 运行模式面板：宿主 dsh（Harmonybrew）/ 内嵌运行时 / 自动
          if (this.modeOpen) {
            Column() {
              Column() {
                Text('运行模式')
                  .fontSize(16)
                  .fontWeight(FontWeight.Medium)
                  .fontColor('#1c2430')
                  .width('100%')
                  .textAlign(TextAlign.Start)
                Text(this.modeActive)
                  .fontSize(11)
                  .fontColor('#64748b')
                  .width('100%')
                  .textAlign(TextAlign.Start)
                  .margin({ top: 4, bottom: 12 })

                this.ModeRow('auto', '自动（检测到 Harmonybrew 的 dsh 就用宿主模式）')
                this.ModeRow('host', '宿主 dsh —— Harmonybrew 安装，原生 node/JIT，插件能力完整')
                this.ModeRow('embedded', '内嵌运行时 —— 应用自带 libnode（--jitless），不依赖 brew')

                Text('宿主模式需要已安装 Harmonybrew 且执行过 brew install deepseek-harness；' +
                  '切换后会重启 Harness 服务。宿主模式下的版本升级请在终端执行 brew upgrade deepseek-harness。')
                  .fontSize(11)
                  .fontColor('#94a3b8')
                  .width('100%')
                  .textAlign(TextAlign.Start)
                  .margin({ top: 12 })

                Row() {
                  Button('关闭')
                    .fontSize(12)
                    .height(30)
                    .backgroundColor('#1c2430')
                    .fontColor('#ffffff')
                    .onClick((): void => {
                      this.modeOpen = false;
                    })
                }
                .width('100%')
                .justifyContent(FlexAlign.End)
                .margin({ top: 16 })
              }
              .width(520)
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
            .backgroundColor('#66000000')
          }
        }
        .width('100%')
        .height('100%')
        .layoutWeight(1)

        // 终端侧边栏（终端样式）
        if (this.terminalOpen) {
          Column() {
            Row() {
              Circle({ width: 8, height: 8 })
                .fill(this.termConnected ? '#4ade80' : '#9ca3af')
                .margin({ right: 6 })
              Text('终端')
                .fontSize(12)
                .fontColor('#e5e7eb')
                .layoutWeight(1)
              Text(this.termPty ? 'pty · ' + (this.termShell ?? 'zsh') : 'pipe')
                .fontSize(11)
                .fontColor('#6b7280')
                .margin({ right: 8 })
              Text('清屏')
                .fontSize(12)
                .fontColor('#9ca3af')
                .onClick(() => { this.termLines = []; })
              Text('断开')
                .fontSize(12)
                .fontColor('#9ca3af')
                .margin({ left: 12 })
                .onClick(() => this.closeTerminal())
            }
            .padding({ left: 10, right: 10, top: 6, bottom: 6 })
            .width('100%')
            .backgroundColor('#0d1117')

            List({ space: 0, scroller: this.listScroller }) {
              ForEach(this.termLines, (line: string) => {
                ListItem() {
                  Text(line.length === 0 ? ' ' : line)
                    .width('100%')
                    .fontSize(12)
                    .fontFamily('monospace')
                    .fontColor('#e6edf3')
                    .padding({ left: 10, right: 6, top: 1, bottom: 1 })
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
                    .fontColor('#00ff9c')
                    .maxLines(1)
                  TextInput({ text: this.termInput })
                    .id(TERM_INPUT_ID)
                    .layoutWeight(1)
                    .fontSize(12)
                    .fontFamily('monospace')
                    .fontColor('#e6edf3')
                    .caretColor('#00ff9c')
                    .backgroundColor(Color.Transparent)
                    .borderRadius(0)
                    .padding({ left: 6, right: 0, top: 0, bottom: 0 })
                    .onChange((v: string) => { this.termInput = v; })
                    .onSubmit(() => { this.sendTermCommand(); })
                }
                .width('100%')
                .alignItems(VerticalAlign.Center)
                .padding({ left: 10, right: 6, top: 1, bottom: 1 })
              }
            }
            .layoutWeight(1)
            .backgroundColor('#010409')
            .scrollBar(BarState.Auto)
          }
          .width(420)
          .height('100%')
          .backgroundColor('#0d1117')
          .border({ width: { left: 1 }, color: '#21262d' })
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
