/**
 * 云同步设置页（**生产级界面**，非验证页）。
 *
 * ── 定位 ──────────────────────────────────────────────────────────────
 * 这是用户真正会用的页面：显示华为账号状态、云同步开关、当前同步概况，
 * 并提供"立即同步"。
 *
 * ── 2026-10-30 生产清理（docs/313 批次 A）─────────────────────────────
 * 三个验证页（`HuaweiCloudProbe` / `RdbCloudProbe` / `AssetCloudProbe`）与
 * 本页的「诊断」分组**整体移除**：它们验证的是已放弃的 `cloudStorage` 路线与
 * BLOB 方案，留在生产界面里只会让用户看到"云盘失败"这类死路线的红叉。
 *
 * ── 视觉规范（对齐本仓 `HarmonyTheme`）───────────────────────────────
 * · 颜色一律走 `sys.color.*` 语义资源（深浅色 / 品牌色 / 对比度由系统保证，
 *   手写十六进制在深色模式下必然有看不清的地方）；
 * · 间距走 `Sp`、字号走 `Fs`、圆角走 `Radius`、最小可点尺寸走 `Sz.TOUCH_MIN`；
 * · 容器用 `Scroll` + `Column`，分组用「标题 + 卡片」，与系统设置页同构。
 *
 * ── 登录：确认后交互授权 ───────────────────────────────────────────────
 * 用户主动登录或通过宿主菜单请求登录时都先显示确认框，再调用 Account Kit；
 * 系统账号尚未登录或需要授权时会显示官方登录/授权页，完成后返回应用，用户可取消。
 *
 * ── 数据边界 ──────────────────────────────────────────────────────────
 * 本页只读**状态**（登录态 / 同步开关 / 会话统计），不直接读写会话文件。
 * 真正的同步由同步服务执行；这里只展示与触发。
 *
 * @module platform/view/CloudSyncSettings
 */
/*
 * 【为什么设计令牌从 platform 内部取，而不是 `from 'appstate'`】
 * 本文件在 **platform 里**，而 appstate 依赖 platform（`appstate/oh-package.json5`）——
 * 反向 import 会成环，编译器直接报 `Cannot find module 'appstate'`。
 * 令牌已随本文件一起搬到 platform 的 `ui/Tokens.ets`（唯一来源，appstate 侧只是再导出）。
 */
import { Fs, Radius, Sp, Sz } from '../ui/Tokens';
import { silentSignIn, SilentSignInKind, fetchAccountDisplayName } from '../system/HuaweiCloud';
import type { SilentSignInResult, AccountDisplayNameResult } from '../system/HuaweiCloud';
/* 云同步中枢与类型都在 platform 内部（同目录/上级目录的相对导入） */
import { SyncEngine, SyncEngineState, SyncScopeSummary } from '../sync/SyncEngine';
import { TaskProgress, progressRatio } from '../sync/SyncModel';
import { KindStat } from '../sync/SyncStore';
import { PluginSpec } from '../sync/PluginManifest';
import { PluginDiff, PluginRestoreReport } from '../sync/PluginRestore';
import { common } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';

/**
 * 一组设置块的标题 + 卡片容器（与系统设置页同一构造）。
 */
@Component
struct SettingGroup {
  title: string = '';
  @BuilderParam content: () => void;

  build() {
    Column({ space: Sp.S }) {
      Text(this.title)
        .fontSize(Fs.SECONDARY)
        .fontColor($r('sys.color.font_secondary'))
        .width('100%')
        .padding({ left: Sp.L })
      Column() {
        this.content();
      }
      .width('100%')
      .backgroundColor($r('sys.color.background_secondary'))
      .borderRadius(Radius.M)
      .clip(true)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}

/**
 * 一行设置项（标题 + 副标题 + 右侧控件）。
 */
@Component
struct SettingLine {
  title: string = '';
  subtitle: string = '';
  @BuilderParam trailing: () => void;
  showDivider: boolean = true;

  build() {
    Column() {
      Row({ space: Sp.M }) {
        Column({ space: Sp.XS }) {
          Text(this.title)
            .fontSize(Fs.BODY)
            .fontColor($r('sys.color.font_primary'))
            .width('100%')
          if (this.subtitle.length > 0) {
            Text(this.subtitle)
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.font_tertiary'))
              .width('100%')
          }
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        this.trailing();
      }
      .width('100%')
      .padding({ left: Sp.L, right: Sp.L, top: Sp.M, bottom: Sp.M })
      .constraintSize({ minHeight: Sz.TOUCH_MIN })

      if (this.showDivider) {
        Divider()
          .color($r('sys.color.comp_divider'))
          .margin({ left: Sp.L })
      }
    }
    .width('100%')
  }
}

/**
 * 进度卡（docs/313 §5）：**一个任务一段进度**，永不混用。
 *
 * ── 为什么要单独一个组件 ──────────────────────────────────────────────
 * 上传、拉取、导入三段的语义完全不同（本地准备 / 云端传输 / 落盘校验），
 * 若塞进一行 `SettingLine`，就会出现"进度条 80% 但在导入阶段失败"这种
 * 无法解释的显示。这里把"阶段名 + 计数 + 说明"绑在一起，读的人不会误判。
 *
 * ── 诚实的口径 ────────────────────────────────────────────────────────
 * 进度条按**单元数**推进（`progressRatio`），`preparedBytes` 只作为
 * "本地已准备多少字节"的附加信息展示，**不**充当云端百分比。
 */
@Component
struct SyncProgressCard {
  progress: TaskProgress = {
    task: '', stage: '', total: 0, succeeded: 0, failed: 0, skipped: 0,
    currentUnitId: '', note: '', preparedBytes: 0, finished: false
  };
  taskTitle: string = '';

  build() {
    Column({ space: Sp.S }) {
      Row({ space: Sp.S }) {
        Text(this.taskTitle)
          .fontSize(Fs.SECONDARY)
          .fontColor($r('sys.color.font_primary'))
          .layoutWeight(1)
        Text(this.stageText())
          .fontSize(Fs.CAPTION_XS)
          .fontColor($r('sys.color.font_tertiary'))
      }
      .width('100%')

      /* 进度条：失败/跳过也算已处理，不让它卡在 99% */
      Progress({
        value: progressRatio(this.progress) * 100,
        total: 100,
        type: ProgressType.Linear
      })
        .width('100%')
        .height(6)
        .color(this.progress.failed > 0 ? $r('sys.color.warning') : $r('sys.color.brand'))

      Text(this.progress.note)
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_secondary'))
        .width('100%')

      Row({ space: Sp.L }) {
        Text(`成功 ${this.progress.succeeded}`)
          .fontSize(Fs.CAPTION_XS)
          .fontColor($r('sys.color.confirm'))
        if (this.progress.failed > 0) {
          Text(`失败 ${this.progress.failed}`)
            .fontSize(Fs.CAPTION_XS)
            .fontColor($r('sys.color.alert'))
        }
        if (this.progress.skipped > 0) {
          Text(`跳过 ${this.progress.skipped}`)
            .fontSize(Fs.CAPTION_XS)
            .fontColor($r('sys.color.font_tertiary'))
        }
        Blank()
        Text(`${this.progress.succeeded + this.progress.failed + this.progress.skipped}/${this.progress.total}`)
          .fontSize(Fs.CAPTION_XS)
          .fontColor($r('sys.color.font_tertiary'))
      }
      .width('100%')
    }
    .width('100%')
    .padding(Sp.L)
    .backgroundColor($r('sys.color.background_secondary'))
    .borderRadius(Radius.M)
    .alignItems(HorizontalAlign.Start)
  }

  /** 阶段的中文名（三类任务的阶段码 → 用户能懂的词）。 */
  private stageText(): string {
    const st: string = this.progress.stage;
    switch (st) {
      case 'scan': return '扫描';
      case 'stage_file': return '准备文件';
      case 'write_db': return '写入同步表';
      case 'cloud_sync': return '云端同步';
      case 'verify': return '核对';
      case 'discover': return '发现变更';
      case 'fetch_meta': return '取元数据';
      case 'fetch_asset': return '下载内容';
      case 'ready': return '待导入';
      case 'map_workspace': return '映射工作区';
      case 'stage': return '暂存';
      case 'commit': return '落位';
      case 'verify_usable': return '可用性验收';
      case 'done': return '完成';
      default: return st;
    }
  }
}

/**
 * 未登录时的账号引导区（docs/313 §4.1）。
 *
 * ── 三段结构 ──────────────────────────────────────────────────────────
 * ① **产品说明**：这个功能对用户意味着什么（会话/附件/插件跟着账号走）；
 * ② **同步范围**：明确"会上传什么、不会上传什么"（隐私预期前置，而不是藏在二级页面）；
 * ③ **登录区**：调用方传入登录动作，内部走 `silentSignIn()`（docs/322 方案 C）——
 *    **不弹登录页、不跳面板**，点一下就在本分区完成。
 *
 * 【为什么不像系统设置那样只放一行"未登录 / 登录"】用户在这个页面要做的决定是
 * "要不要把数据交给云端"，而那个决定需要先说清代价与边界；一行按钮撑不起这个决定。
 */
@Component
struct AccountIntro {
  busy: boolean = false;
  onLogin: () => void = (): void => {};

  build() {
    Column({ space: Sp.XL }) {

      /* ① 产品说明 */
      Column({ space: Sp.S }) {
        Row({ space: Sp.M }) {
          Image($r('app.media.layered_image'))
            .width(Sz.HEADER)
            .height(Sz.HEADER)
            .objectFit(ImageFit.Contain)
          Column({ space: Sp.XS }) {
            Text('华为账号与云同步')
              .fontSize(Fs.TITLE_S)
              .fontWeight(FontWeight.Medium)
              .fontColor($r('sys.color.font_primary'))
            Text('让会话、附件和插件清单随账号流转')
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.font_secondary'))
          }
          .layoutWeight(1)
          .alignItems(HorizontalAlign.Start)
        }
        .width('100%')

        Text('登录后，换到另一台设备用同一个华为账号，即可拉取并导入，继续之前的工作。')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .lineHeight(Fs.CAPTION * 1.6)
          .width('100%')
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)

      /* ② 同步范围（正反两面都写清） */
      Column({ space: Sp.S }) {
        Text('同步范围')
          .fontSize(Fs.SECONDARY)
          .fontColor($r('sys.color.font_secondary'))
          .width('100%')

        SyncScopeLine({ text: '会话记录与附件', included: true })
        SyncScopeLine({ text: '技能', included: true })
        SyncScopeLine({ text: '插件清单（只记安装地址）', included: true })

        Divider()
          .color($r('sys.color.comp_divider'))
          .margin({ top: Sp.XS, bottom: Sp.XS })

        SyncScopeLine({ text: '核心运行库与缓存', included: false })
        SyncScopeLine({ text: '账号凭据与授权码', included: false })
        SyncScopeLine({ text: '本机绝对路径', included: false })
      }
      .width('100%')
      .padding(Sp.L)
      .backgroundColor($r('sys.color.background_secondary'))
      .borderRadius(Radius.M)
      .alignItems(HorizontalAlign.Start)

      /* ③ 官方登录区：按钮动作由宿主承接，真正面板在页面层渲染 */
      Column({ space: Sp.M }) {
        Button(this.busy ? '登录中…' : '登录华为账号')
          .width('100%')
          .height(Sz.TOUCH_MIN)
          .enabled(!this.busy)
          .onClick((): void => {
            this.onLogin();
          })

        /*
         * 【文案为什么必须准确（docs/322 方案 C）】静默登录**没有**协议勾选这一步
         * （`authentication` 静默授权由系统账号状态决定，不弹协议页）。若继续写
         * "登录即表示同意……"，等于替用户确认了一件他没点过的事 ⇒ 改成陈述事实。
         */
        Text('登录只读取账号标识用于同步归属，不获取头像昵称等资料')
          .fontSize(Fs.CAPTION_XS)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')
          .textAlign(TextAlign.Center)
      }
      .width('100%')

      Blank().height(Sp.XL)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}

/**
 * 同步范围的一行（✓ 包含 / ✕ 不含）。
 */
@Component
struct SyncScopeLine {
  text: string = '';
  included: boolean = true;

  build() {
    Row({ space: Sp.S }) {
      Text(this.included ? '✓' : '✕')
        .fontSize(Fs.CAPTION)
        .fontColor(this.included ? $r('sys.color.confirm') : $r('sys.color.font_tertiary'))
      Text(this.text)
        .fontSize(Fs.CAPTION)
        .fontColor(this.included
          ? $r('sys.color.font_primary') : $r('sys.color.font_tertiary'))
        .layoutWeight(1)
    }
    .width('100%')
  }
}

@Component
export struct CloudSyncSettings {
  /** 关闭（返回）回调：由宿主页面传入。 */
  onClose: () => void = (): void => {};

  /**
   * 「从顶栏菜单直接登录」的一次性信号（2026-10-30 重构）。
   *
   * 宿主（WebApp）在设置分区点「登录」时置真；本页 aboutToAppear 检测到它就
   * **直接尝试一次静默登录**（docs/322 方案 C：无弹窗、无跳转），随后清零 ——
   * 不能留在本组件状态里：否则用户下次主动打开设置页（只是想看看开关）也会再登一次。
   */
  autoLogin: boolean = false;

  @State private engineState: SyncEngineState = SyncEngine.initialState();
  @State private summary: SyncScopeSummary | null = null;
  /** 交互登录进行中（按钮显示"登录中…"并禁用，避免连点）。 */
  @State private loginBusy: boolean = false;
  @State private busy: boolean = false;
  /** 最近一次操作的提示（成功/失败都显示，不静默）。 */
  @State private notice: string = '';
  @State private noticeIsError: boolean = false;
  /**
   * 插件清单是否参与同步（docs/310）。
   *
   * 【默认开】插件清单只有几 KB，且"换台设备插件全没了"是很实际的痛点；
   * 但它仍是一个**独立开关**——用户可能不希望另一台设备被自动装插件。
   */
  @State private pluginSyncOn: boolean = true;
  /** 当前任务进度（上传/拉取/导入任一段；null 表示没有可显示的任务） */
  @State private progress: TaskProgress | null = null;
  /** 插件恢复：检查中 / 候选列表 / 已勾选 / 结果文案 */
  @State private checkingPlugins: boolean = false;
  @State private pluginCandidates: PluginSpec[] = [];
  @State private pluginPicked: Set<string> = new Set<string>();
  @State private pluginRestoreText: string = '检查云端插件清单，列出本机缺少的插件';
  @State private pluginInstallText: string = '';
  /**
   * 视口高度（vp）：面板高度按官方口径 `min(800, 100vh-48)` 算。
   * 0 表示还没量到，此时退回 800（与官方默认一致）。
   */
  @State private viewportHeightVp: number = 0;

  /** 用户确认后发起 Account Kit 登录；系统页关闭后 Promise 返回到应用。 */
  private confirmSignIn(): void {
    this.getUIContext().showAlertDialog({
      title: '登录华为账号',
      message: '继续后将使用华为账号确定同步归属。若尚未登录，系统会打开华为账号登录/授权页面，完成后返回本应用。'
        + '应用还会请求 profile 授权以显示昵称或脱敏手机号/邮箱；可以取消，取消后不会登录。',
      autoCancel: true,
      primaryButton: {
        value: '取消',
        action: (): void => {}
      },
      secondaryButton: {
        value: '登录',
        action: (): void => {
          this.signIn();
        }
      }
    });
  }

  private async signIn(): Promise<void> {
    if (this.loginBusy) {
      return;
    }
    this.loginBusy = true;
    try {
      /*
       * 【2026-11-05 / docs/378】补传 context：docs/322 早已实证不传会在需要拉起
       * 账号组件时返回 401，旧实现这里漏了。两个壳的 WebApp 一直有传，面板路径补齐。
       */
      const ctx: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
      const result: SilentSignInResult = await silentSignIn(ctx);
      if (result.kind === SilentSignInKind.OK) {
        /* 只把 UnionID 交给引擎；授权码 / idToken 本函数根本没读，也就无从泄漏 */
        SyncEngine.adoptLogin(result.unionId);
        this.refresh();
        this.setNotice('已登录华为账号', false);
        /*
         * docs/378：登录成功后尽力读取账号展示名，不 await（用户可能停在授权页上），
         * `loginBusy` 立即释放；失败/拒绝授权一律降级为「已登录」。
         */
        fetchAccountDisplayName(ctx).then((profile: AccountDisplayNameResult): void => {
          if (profile.ok) {
            SyncEngine.adoptAccountLabel(profile.label);
            this.refresh();
          }
        }).catch((): void => {
          /* 资料读取失败不提示、不阻断：账号卡保持「已登录」 */
        });
      } else if (result.kind !== SilentSignInKind.CANCELED) {
        this.setNotice(result.reason, true);
      }
    } finally {
      this.loginBusy = false;
    }
  }

  private setNotice(text: string, isError: boolean): void {
    this.notice = text;
    this.noticeIsError = isError;
  }

  private refresh(): void {
    this.engineState = SyncEngine.state();
    this.summary = SyncEngine.scopeSummary();
  }

  aboutToAppear(): void {
    this.refresh();
    /* 量一次视口高度（官方设置面板的高度是相对视口算的，见 panelHeight） */
    try {
      const win = window.getLastWindow(getContext(this) as common.UIAbilityContext);
      win.then((w: window.Window): void => {
        const rect = w.getWindowProperties().windowRect;
        this.viewportHeightVp = px2vp(rect.height);
      }).catch((): void => {
      });
    } catch (e) {
      /* 量不到就保持 0，panelHeight 退回 800 */
    }
    /* 读一次本机同步表的真实统计（清单分组显示"已同步 N 项"） */
    const ctx: common.Context = getContext(this) as common.Context;
    SyncEngine.refreshStat(ctx).then((): void => {
      this.refresh();
    }).catch((): void => {
    });
    if (this.autoLogin) {
      /* 一次性：消费即清零（宿主传入的是值拷贝，清本组件即可） */
      this.autoLogin = false;
      if (!this.engineState.signedIn) {
        this.confirmSignIn();
      }
    }
  }

  private goBack(): void {
    this.onClose();
  }

  /** 同步开关切换。 */
  private async toggleSync(on: boolean): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      const result: string = await SyncEngine.setEnabled(on);
      this.refresh();
      if (result.length > 0) {
        this.setNotice(result, true);
      } else {
        this.setNotice(on ? '已开启云同步' : '已关闭云同步', false);
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * 拉取并导入（云→端）。与上传是两条独立链路，进度分开显示。
   */
  private async pullNow(): Promise<void> {
    const generation: number = SyncEngine.currentGeneration();
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.setNotice('正在从云端拉取…', false);
    try {
      const ctx: common.Context = getContext(this) as common.Context;
      const result: string = await SyncEngine.pullAndImport(ctx);
      if (generation !== SyncEngine.currentGeneration()) { return; }
      this.progress = SyncEngine.currentProgress();
      this.refresh();
      this.setNotice(result.length > 0 ? result : '拉取并导入完成', result.length > 0);
    } finally {
      this.busy = false;
    }
  }

  /**
   * 检查云端插件清单与本机的差异（批次 D 第一步）。
   *
   * 【云端清单从哪来】同步表里的 `plugin_manifest` 单元。
   * 首版就读该单元 payload 对应资产的内容；读不到就如实说"云端没有清单"。
   */
  private async checkPlugins(): Promise<void> {
    const generation: number = SyncEngine.currentGeneration();
    if (this.checkingPlugins) {
      return;
    }
    this.checkingPlugins = true;
    try {
      const ctx: common.Context = getContext(this) as common.Context;
      const remote: string = await SyncEngine.readRemotePluginManifest(ctx);
      if (generation !== SyncEngine.currentGeneration()) { return; }
      if (remote.length === 0) {
        this.pluginRestoreText = '云端没有插件清单（先在另一台设备上传）';
        this.pluginCandidates = [];
        return;
      }
      const diff: PluginDiff = await SyncEngine.pluginDiff(ctx, remote);
      if (generation !== SyncEngine.currentGeneration()) { return; }
      this.pluginCandidates = diff.missing;
      if (diff.missing.length === 0) {
        this.pluginRestoreText = diff.differing.length > 0
          ? `本机已装齐（${diff.differing.length} 个版本不同，默认保留本机）`
          : '本机已装齐，无需恢复';
      } else {
        const differ: string = diff.differing.length > 0
          ? `，另 ${diff.differing.length} 个版本不同（保留本机）` : '';
        this.pluginRestoreText = `云端有 ${diff.missing.length} 个本机没有的插件${differ}`;
      }
      this.pluginPicked = new Set<string>();
      for (let i: number = 0; i < diff.missing.length; i++) {
        this.pluginPicked.add(diff.missing[i].name);
      }
    } finally {
      this.checkingPlugins = false;
    }
  }

  /** 安装勾选的插件（批次 D 第二步）。 */
  private async installPlugins(): Promise<void> {
    const generation: number = SyncEngine.currentGeneration();
    if (this.busy) {
      return;
    }
    const picked: PluginSpec[] = [];
    for (let i: number = 0; i < this.pluginCandidates.length; i++) {
      const p: PluginSpec = this.pluginCandidates[i];
      if (this.pluginPicked.has(p.name)) {
        picked.push(p);
      }
    }
    if (picked.length === 0) {
      return;
    }
    this.busy = true;
    this.pluginInstallText = `正在安装 ${picked.length} 个插件…`;
    try {
      const ctx: common.Context = getContext(this) as common.Context;
      const report: PluginRestoreReport = await SyncEngine.restorePlugins(ctx, picked);
      if (generation !== SyncEngine.currentGeneration()) { return; }
      this.progress = SyncEngine.currentProgress();
      /*
       * 【必须提示重启】bundle 型插件写进 dsh.profile.bundles 后要重启才挂载；
       * 说"已可用"就是撒谎（docs/313 §7.3）。
       */
      this.pluginInstallText = report.needsRestart
        ? `${report.summary} · 重启应用后生效`
        : report.summary;
      this.setNotice(this.pluginInstallText, !report.ok);
      this.refresh();
    } finally {
      this.busy = false;
    }
  }

  /** 任务名（进度卡标题用）。 */
  private taskTitleOf(task: string): string {
    if (task === 'upload') {
      return '上传进度';
    }
    if (task === 'pull') {
      return '拉取进度';
    }
    if (task === 'import') {
      return '导入进度';
    }
    return '同步进度';
  }

  /** 某一类内容的统计文案（读本机同步表的真实计数）。 */
  private kindText(kind: string): string {
    const st: KindStat[] = SyncEngine.stats();
    for (let i: number = 0; i < st.length; i++) {
      if (st[i].kind === kind) {
        return `${st[i].count} 项 · ${this.bytesText(st[i].bytes)}`;
      }
    }
    return '尚未同步';
  }

  /** 立即同步一次。 */
  private async syncNow(): Promise<void> {
    const generation: number = SyncEngine.currentGeneration();
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.setNotice('正在同步…', false);
    try {
      /*
       * 生产清理后 syncNow 需要应用上下文（它要建库、搬 Asset）。
       * 上下文从页面自身取，不给引擎缓存 Context（避免长期持有泄漏）。
       */
      const ctx: common.Context = getContext(this) as common.Context;
      const result: string = await SyncEngine.syncNow(ctx);
      if (generation !== SyncEngine.currentGeneration()) { return; }
      /* 任务结束后把最终进度交给页面显示（含失败计数与原因） */
      this.progress = SyncEngine.currentProgress();
      this.refresh();
      this.setNotice(result.length > 0 ? result : '同步完成', result.length > 0);
    } finally {
      this.busy = false;
    }
  }

  build() {
    Stack() {
      /*
       * 遮罩：与官方设置面板同一形态（centered 面板浮在暗色遮罩上）。
       * 之前本面板是全屏铺满的一层，点开时整屏被换掉；改成"面板 + 遮罩"后，
       * 观感与用户刚离开的官方设置面板一致（docs/318）。
       */
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor('#4D000000') // token-exempt: 与官方设置面板遮罩同款
        .onClick((): void => {
          this.goBack();
        })

      Column() {
        /* ── 顶栏：返回 + 标题（系统设置页同构） ───────────────────── */
        /*
         * 顶栏照**官方设置面板 header** 的规格：高 54、padding 20/14/8/10。
         * 用户口径（2026-10-30）：「直接内置吧……UI 就跟设置里面的一样，不要再单开」——
         * 所以本面板的尺寸、圆角、内边距一律对齐官方设置面板，而不是自成一套。
         */
        Row({ space: Sp.S }) {
          Button('‹ 返回')
            .buttonStyle(ButtonStyleMode.TEXTUAL)
            .fontSize(Fs.SECONDARY)
            .onClick((): void => {
              this.goBack();
            })
          Text('云同步')
            .fontSize(Fs.TITLE_S)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('sys.color.font_primary'))
          Blank()
          if (this.busy) {
            LoadingProgress()
              .width(Sz.POINTER_MIN)
              .height(Sz.POINTER_MIN)
              .color($r('sys.color.brand'))
          }
        }
        .width('100%')
        .height(54)
        .padding({ left: 10, right: 14, top: 20, bottom: 8 })

        Scroll() {
          Column({ space: Sp.XL }) {

            /* ── 提示条（有话说时才出现）─────────────────────────── */
            if (this.notice.length > 0) {
              Row({ space: Sp.S }) {
                Text(this.noticeIsError ? '⚠' : '✓')
                  .fontSize(Fs.SECONDARY)
                  .fontColor(this.noticeIsError ? $r('sys.color.warning') : $r('sys.color.confirm'))
                Text(this.notice)
                  .fontSize(Fs.CAPTION)
                  .fontColor($r('sys.color.font_secondary'))
                  .layoutWeight(1)
              }
              .width('100%')
              .padding(Sp.M)
              .backgroundColor($r('sys.color.background_secondary'))
              .borderRadius(Radius.S)
            }

            /*
             * ── 账号区（docs/313 §4.1 / §4.1a）────────────────────────
             * 未登录与已登录是**同一位置的两种形态**，不是两个页面：
             *   · 未登录 → 产品介绍 + 同步范围 + 登录区（**就地静默登录**）；
             *   · 已登录 → 账号卡（公开信息 + 云服务状态 + 同步范围）。
             * 登录不再弹出任何二级界面（docs/322 方案 C）：点一下、留在本分区。
             */
            if (!this.engineState.signedIn) {
              AccountIntro({
                busy: this.loginBusy,
                onLogin: (): void => {
                  this.confirmSignIn();
                }
              })
            } else {
              SettingGroup({ title: '华为账号与云服务' }) {
                SettingLine({
                  title: this.engineState.displayName,
                  /*
                   * docs/378：账号副标题改读 accountLabel（昵称 / 匿名手机号 / 匿名邮箱）。
                   * 旧值 `****abcd` 是脱敏 UnionID，用户反馈"很像内部代号" ⇒ 不再上 UI。
                   * 老数据/读取失败时 SyncEngine.state() 已退回「已登录」，这里直接拼即可。
                   */
                  subtitle: `华为账号 ${this.engineState.accountLabel}`,
                  showDivider: true
                }) {
                  Button('退出')
                    .buttonStyle(ButtonStyleMode.TEXTUAL)
                    .fontSize(Fs.SECONDARY)
                    .onClick((): void => {
                      SyncEngine.signOut();
                      this.refresh();
                      this.setNotice('已退出华为账号', false);
                    })
                }
                /*
                 * 云服务状态：**只陈述实测结果**。
                 * 登录成功 ≠ 云空间已连接；这里读的是端云同步实际可用性。
                 */
                SettingLine({
                  title: '云服务',
                  subtitle: this.engineState.cloudServiceText,
                  showDivider: true
                }) {
                  Text(this.engineState.cloudServiceBadge)
                    .fontSize(Fs.CAPTION)
                    .fontColor(this.engineState.cloudServiceOk
                      ? $r('sys.color.confirm') : $r('sys.color.warning'))
                }
                SettingLine({
                  title: '同步范围',
                  subtitle: '会话记录与附件、技能、插件清单',
                  showDivider: false
                }) {
                  Text('')
                }
              }
            }

            /* ── 云同步（概览 + 三段进度，docs/313 §4.2 / §5）──── */
            if (this.engineState.signedIn) {
              SettingGroup({ title: '云同步' }) {
                SettingLine({
                  title: '开启云同步',
                  subtitle: this.engineState.enabled
                    ? '数据变更后自动同步到云端'
                    : '关闭后仅在本机保存，不会上传'
                }) {
                  Toggle({ type: ToggleType.Switch, isOn: this.engineState.enabled })
                    .onChange((on: boolean): void => {
                      this.toggleSync(on);
                    })
                    .enabled(!this.busy)
                }

                /*
                 * 两个动作：上传（端→云）与 拉取并导入（云→端）。
                 * 它们**不是同一件事**，所以是两个按钮而不是一个"同步"：
                 * 用户需要知道"我现在是往上备份，还是往下取东西"。
                 */
                SettingLine({
                  title: '上传本机数据',
                  subtitle: this.engineState.lastSyncText.length > 0
                    ? this.engineState.lastSyncText : '尚未同步过'
                }) {
                  Button('上传')
                    .fontSize(Fs.SECONDARY)
                    .enabled(this.engineState.enabled && !this.busy)
                    .onClick((): void => {
                      this.syncNow();
                    })
                }

                SettingLine({
                  title: '拉取并导入',
                  subtitle: '从云端取回内容，校验后放回本机（可打开才算成功）',
                  showDivider: false
                }) {
                  Button('拉取')
                    .fontSize(Fs.SECONDARY)
                    .enabled(this.engineState.enabled && !this.busy)
                    .onClick((): void => {
                      this.pullNow();
                    })
                }
              }

              /*
               * ── 进度（只在进行中或刚结束时显示）──────────────────────
               * 三段**分开画**：上传 / 拉取 / 导入各有自己的阶段名与计数。
               * 绝不把"下载完成"显示成"同步完成"（docs/313 §5.3）。
               */
              if (this.progress !== null && this.progress.note.length > 0) {
                SyncProgressCard({
                  progress: this.progress,
                  taskTitle: this.taskTitleOf(this.progress.task)
                })
              }

              /* ── 同步内容清单（docs/313 §4.3）──────────────────────── */
              SettingGroup({ title: '同步内容' }) {
                SettingLine({
                  title: '会话记录与附件',
                  /*
                   * 两段信息拼在一起：**已同步**（同步表里的真实计数）
                   * 与 **本机待同步**（扫描结果）。
                   * 只说"已同步"会让用户以为全部传完了；只说"待同步"又看不到进度。
                   */
                  subtitle: `${this.kindText('session')} · 本机${this.syncScopeText()}`,
                  showDivider: true
                }) {
                  Text('')
                }
                SettingLine({
                  title: '技能',
                  subtitle: this.kindText('skill'),
                  showDivider: true
                }) {
                  Text('')
                }
                SettingLine({
                  title: '插件清单',
                  subtitle: this.engineState.pluginCount > 0
                    ? `${this.engineState.pluginCount} 个插件（只记安装地址）`
                    : '本机未安装用户插件',
                  showDivider: false
                }) {
                  Text('')
                }
              }

              /* ── 插件（docs/310：同步清单，到端重装）────────────── */
              SettingGroup({ title: '插件' }) {
                SettingLine({
                  title: '同步已装插件',
                  subtitle: this.engineState.pluginCount > 0
                    ? `本机已装 ${this.engineState.pluginCount} 个用户插件，换设备后按清单自动重装`
                    : '本机没有安装用户插件',
                  showDivider: false
                }) {
                  Toggle({ type: ToggleType.Switch, isOn: this.pluginSyncOn })
                    .onChange((on: boolean): void => {
                      this.pluginSyncOn = on;
                      if (on && this.engineState.pluginCount === 0) {
                        this.setNotice('本机没有可同步的插件', true);
                      }
                    })
                    .enabled(!this.busy && this.engineState.pluginCount > 0)
                }
              }

              /* ── 数据说明（合规：让用户知道什么会上云）────────── */
              Column({ space: Sp.XS }) {
                Text('同步范围')
                  .fontSize(Fs.SECONDARY)
                  .fontColor($r('sys.color.font_secondary'))
                Text('仅同步会话记录与工作区文件索引；应用缓存、核心运行库不会上传。'
                  + '云侧数据归属于你的华为账号，退出登录后本机数据不受影响。')
                  .fontSize(Fs.CAPTION)
                  .fontColor($r('sys.color.font_tertiary'))
                  .lineHeight(Fs.CAPTION * 1.5)
              }
              .width('100%')
              .padding({ left: Sp.L, right: Sp.L })
              .alignItems(HorizontalAlign.Start)
            }

              /*
               * ── 插件（docs/313 §7，批次 D）────────────────────────────
               * 完整闭环：检查云端清单 → 列出本机缺哪些 → 用户勾选 → 逐个安装 → 提示重启。
               * **不自动安装**：插件组合影响应用能否启动，不替用户做决定。
               */
              SettingGroup({ title: '插件' }) {
                SettingLine({
                  title: '本机已装',
                  subtitle: this.engineState.pluginCount > 0
                    ? `${this.engineState.pluginCount} 个用户插件`
                    : '没有安装用户插件',
                  showDivider: true
                }) {
                  Text('')
                }
                SettingLine({
                  title: '从云端恢复插件',
                  subtitle: this.pluginRestoreText,
                  showDivider: this.pluginCandidates.length > 0
                }) {
                  Button(this.checkingPlugins ? '检查中…' : '检查')
                    .fontSize(Fs.SECONDARY)
                    .enabled(!this.busy && !this.checkingPlugins)
                    .onClick((): void => {
                      this.checkPlugins();
                    })
                }
                /* 勾选列表：只在检查出缺失项时出现 */
                if (this.pluginCandidates.length > 0) {
                  ForEach(this.pluginCandidates, (p: PluginSpec) => {
                    Row({ space: Sp.M }) {
                      Checkbox()
                        .select(this.pluginPicked.has(p.name))
                        .onChange((checked: boolean): void => {
                          if (checked) {
                            this.pluginPicked.add(p.name);
                          } else {
                            this.pluginPicked.delete(p.name);
                          }
                          /* Set 变更不会自动触发重渲染，换引用 */
                          const next: Set<string> = new Set<string>(this.pluginPicked);
                          this.pluginPicked = next;
                        })
                      Column({ space: Sp.XS }) {
                        Text(p.name)
                          .fontSize(Fs.CAPTION)
                          .fontColor($r('sys.color.font_primary'))
                          .width('100%')
                        Text(p.spec)
                          .fontSize(Fs.CAPTION_XS)
                          .fontColor($r('sys.color.font_tertiary'))
                          .width('100%')
                      }
                      .layoutWeight(1)
                      .alignItems(HorizontalAlign.Start)
                    }
                    .width('100%')
                    .constraintSize({ minHeight: Sz.TOUCH_MIN })
                    .padding({ left: Sp.L, right: Sp.L })
                  }, (p: PluginSpec) => p.name)

                  SettingLine({
                    title: '安装选中插件',
                    subtitle: this.pluginInstallText,
                    showDivider: false
                  }) {
                    Button('安装')
                      .fontSize(Fs.SECONDARY)
                      .enabled(!this.busy && this.pluginPicked.size > 0)
                      .onClick((): void => {
                        this.installPlugins();
                      })
                  }
                }
              }

            Blank().height(Sp.XL)
          }
          /* 官方 options 容器的内边距：0 24 24（左右 24，底部 24，顶部 0） */
          .width('100%')
          .padding({ left: 24, right: 24, top: 0, bottom: 24 })
        }
        .layoutWeight(1)
        .width('100%')
        .scrollBar(BarState.Off)
      }
      /*
       * 面板本体：对齐官方设置面板的几何
       *   宽 800、高 min(800, 100vh - 48)、圆角 radius-panel、底色 bg-layer-2。
       * 官方源码实测（dsh-client-ui-settings-general）：
       *   .panel{width:800px;height:min(800px, calc(100vh - 2*24px));border-radius:var(--dsw-radius-panel)}
       */
      .width(800)
      .constraintSize({ maxWidth: '92%', maxHeight: '92%' })
      .height(this.panelHeight())
      .borderRadius($r('sys.float.corner_radius_level12'))
      .clip(true)
      .backgroundColor($r('sys.color.background_secondary'))
    }
    .width('100%')
    .height('100%')
  }

  /**
   * 面板高度：对齐官方设置的 `min(800px, 100vh - 48px)`。
   *
   * 【为什么算而不是写死】官方是相对视口算的；写死 800 在小窗口（自由窗口/手机）
   * 会超出屏幕底部。这里取同一个口径，窗口多小都能完整显示。
   */
  private panelHeight(): number {
    const H: number = this.viewportHeightVp;
    if (H <= 0) {
      return 800;
    }
    return Math.min(800, H - 48);
  }

  /** 待同步会话的展示文案。 */
  private syncScopeText(): string {
    const s: SyncScopeSummary | null = this.summary;
    if (s === null) {
      return '尚未统计';
    }
    if (s.sessionCount === 0) {
      return '暂无会话记录';
    }
    return `${s.sessionCount} 个会话 · 共 ${this.bytesText(s.totalBytes)}`;
  }

  private bytesText(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    if (bytes < 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
}
