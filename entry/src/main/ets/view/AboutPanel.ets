/**
 * 「关于」面板（顶栏「关于」菜单 → 版本信息 / 开源组件声明）。
 *
 * ── 它显示什么（上架规范口径）──────────────────────────────────────────────
 *   入口一「版本信息」：应用版本 / 包名 / 构建模式 / dsh 核心版本、上游归属、技术支持；
 *   入口二「开源组件声明」：**库名称 - 许可证版本** 的逐条清单（随包运行时与工具、
 *      随包原生共享库、ohpm 依赖、核心树 npm 依赖）与许可证分布，以及 GPL/LGPL/MPL
 *      系列组件的源码获取地址、上游与本地版权。
 *
 * ── 数据从哪来（**不许手抄**）─────────────────────────────────────────────
 * `rawfile/licenses/OSS-NOTICES.json`，由 `tools/gen-oss-notices.mjs` 从
 * **实际随包内容**生成（核心树 npm 包根 + ohpm + 逐条验存在的随包件 +
 * 源码侧与**已出包件**两处原生库的并集），并对"没登记许可证的随包库"直接判失败。
 * 所以这份清单不会漂移成"及其依赖"这种模糊描述。
 *
 * ── 为什么是两个入口、清单为什么分组 ──────────────────────────────────────
 * 2026-11-11 用户要求：`关于` 从「应用」菜单拎出来独立成菜单（版本信息 / 开源组件声明
 * 两个子项），且"DSH 相关组件精简一点，太多了"。同日再次裁决：两个子项**各自单页**，
 * 面板内不再做页签并列 —— 点哪个入口就只显示那一页（`initialTab` 只读）。
 * npm 662 条里 340 条是 `@deepseek-ai/*` ⇒ 真正的第三方库被淹没。上游核心组件
 * 单独成组、默认收起（可展开、可逐条核对），其余第三方仍平铺。
 * 合规口径不变：**所有**第三方库仍完整列出，只是默认收起一组。
 *
 * ── 视觉口径（2026-11-11 第三次收口：两个入口必须"是同一个面板"）──────
 * 宽度 / 高度 / 圆角 / 阴影 / 底色两页完全一致（92% × 72%，最宽 560vp）。
 * 底色 = `#F7FFFFFF`（96% 白）+ `backdropBlur(12)`：
 *   · **不用** `backgroundBlurStyle` —— 它按系统 colorMode 取材质色，深色系统下会把
 *     整面板染成深灰（用户两次反馈的"黑黑的"就是这个）；
 *   · **不用** `sys.color.*` —— 本应用 `setColorMode(COLOR_MODE_NOT_SET)` 跟随系统，
 *     深色系统下 `background_primary` 就是深灰，同样会变黑。
 *   `backdropBlur` 只做纯高斯模糊、不掺主题色，卡片颜色由这里的常量决定
 *   ⇒ 深浅系统下都是同一张与 Web 白底一致的浅色卡片。
 *   模糊半径取 12：面板外面那层"点空白关闭"的遮罩已改为**全透明**（用户 2026-11-11
 *   要求"背景不要做其他的变化"），不再有 30% 黑可吸，圆角暗角问题从根上消失；
 *   12px 仍保留一点透光，配 1px 白描边压住边缘。
 * 内容一律靠左上：`Scroll.align(Alignment.TopStart)`（默认是 Center，内容短时会居中）
 * + `Column.alignItems(Start)`；版本页内容少，下方留白，不单独缩小整卡。
 *
 * @module AboutPanel
 */
import { Sp, Fs } from 'appstate';
import { bundleManager, common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { util } from '@kit.ArkTS';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'DSHM-ABOUT';

/** 组件行（npm / ohpm / 原生库共用）。 */
interface OssRow {
  name: string;
  version: string;
  license: string;
}

@Component
export struct AboutPanel {
  /** 当前运行的 dsh 核心版本（父组件从 cores 目录读到）。 */
  @Prop coreVersion: string = '';
  /** 打开时定位的页签：`version`（版本信息）/ `oss`（开源组件声明）。 */
  @Prop initialTab: string = 'version';
  /** 关闭回调（父组件把 `aboutOpen` 置假）。 */
  onClose: () => void = (): void => {
  };

  /** 上游核心组件（`@deepseek-ai/*`）是否展开 —— 默认收起，避免 340 行把页面压满。 */
  @State private upstreamExpanded: boolean = false;

  @State private ready: boolean = false;
  /* 版本三项由本组件自读（`bundleManager.getBundleInfoForSelfSync`）——
     与 `platform/readAppVersionText()` 同一个来源，读不到就显示 `—`。 */
  @State private appVersion: string = '';
  @State private bundleName: string = '';
  @State private buildMode: string = '';
  @State private loadError: string = '';
  @State private generatedAt: string = '';
  @State private upstreamLine: string = '';
  @State private summaryRows: string[] = [];
  @State private runtimeRows: string[] = [];
  @State private nativeRows: string[] = [];
  @State private ohpmRows: string[] = [];
  @State private npmRows: string[] = [];
  /** `@deepseek-ai/*`（随 dsh 核心分发的上游组件）单独成组，默认收起。 */
  @State private upstreamRows: string[] = [];
  @State private copyleftRows: string[] = [];
  @State private selfLibsLine: string = '';
  @State private supportRows: string[] = [];

  aboutToAppear(): void {
    this.loadNotices();
  }

  /**
   * 读并解析声明文件。**读不到就如实显示错误**，绝不退回"看起来正常"的空清单 ——
   * 合规页面出现空白清单比报错更危险（会被当成"本应用未使用第三方库"）。
   */
  private loadNotices(): void {
    try {
      /* 版本信息：与 `platform/readAppVersionText()` 同源（bundleManager），读不到就留空显示 `—`。 */
      try {
        const info: bundleManager.BundleInfo = bundleManager.getBundleInfoForSelfSync(
          bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
        this.appVersion = `${info.versionName} (${info.versionCode})`;
        this.bundleName = info.name;
        this.buildMode = info.appInfo.debug ? 'debug（调试）' : 'release（发布）';
      } catch (infoErr) {
        const ie = infoErr as BusinessError;
        hilog.warn(DOMAIN, TAG, '读包信息失败：code=%{public}d msg=%{public}s', ie.code, ie.message);
      }
      const ctx = getContext(this) as common.UIAbilityContext;
      const bytes: Uint8Array = ctx.resourceManager.getRawFileContentSync('licenses/OSS-NOTICES.json');
      const text: string = util.TextDecoder.create('utf-8').decodeToString(bytes);
      const root = JSON.parse(text) as Record<string, Object>;

      const gen = root['generatedAt'] as string;
      this.generatedAt = gen !== null && gen !== undefined ? gen : '';

      const up = root['upstream'] as Record<string, Object>;
      if (up !== null && up !== undefined) {
        const upName = up['name'] as string;
        const upLic = up['license'] as string;
        const upCopy = up['copyright'] as string;
        const upSrc = up['source'] as string;
        this.upstreamLine = `${upName}（${upLic}，${upCopy}）\n上游源码：${upSrc}`;
      }

      const selfLibs = root['selfLibs'] as Object[];
      if (selfLibs !== null && selfLibs !== undefined && selfLibs.length > 0) {
        const names: string[] = [];
        for (let i = 0; i < selfLibs.length; i++) {
          names.push(selfLibs[i] as string);
        }
        this.selfLibsLine = `DSHM自有原生件（不计入第三方）：${names.join('、')}`;
      }

      const summary = root['summary'] as Object[];
      if (summary !== null && summary !== undefined) {
        const rows: string[] = [];
        for (let i = 0; i < summary.length; i++) {
          const s = summary[i] as Record<string, Object>;
          const lic = s['license'] as string;
          const cnt = s['count'] as number;
          rows.push(`${lic}：${cnt} 个`);
        }
        this.summaryRows = rows;
      }

      this.runtimeRows = this.rowsOf(root['runtimes'], true);
      this.nativeRows = this.rowsOf(root['nativeLibs'], false);
      this.ohpmRows = this.rowsOf(root['ohpm'], true);
      this.splitNpm(root['npm']);

      const copyleft = root['copyleft'] as Object[];
      if (copyleft !== null && copyleft !== undefined) {
        const rows: string[] = [];
        const seen: string[] = [];
        for (let i = 0; i < copyleft.length; i++) {
          const c = copyleft[i] as Record<string, Object>;
          const name = c['name'] as string;
          const lic = c['license'] as string;
          const src = c['source'] as string;
          const note = c['note'] as string;
          if (src === null || src === undefined || src.length === 0) {
            continue; // 没有源码地址的不放进"源码获取"一节（它们仍在组件清单里）
          }
          const key = `${name}|${src}`;
          if (seen.includes(key)) {
            continue;
          }
          seen.push(key);
          rows.push(`${name} —— ${lic}\n    源码：${src}${note !== null && note !== undefined && note.length > 0 ? `（${note}）` : ''}`);
        }
        this.copyleftRows = rows;
      }

      const support = root['support'] as Record<string, Object>;
      if (support !== null && support !== undefined) {
        const fb = support['feedback'] as string;
        const docs = support['docs'] as string;
        const pv = support['privacy'] as string;
        const rows: string[] = [];
        if (fb !== null && fb !== undefined && fb.length > 0) {
          rows.push(`问题反馈：${fb}`);
        }
        if (docs !== null && docs !== undefined && docs.length > 0) {
          rows.push(`官方文档：${docs}`);
        }
        if (pv !== null && pv !== undefined && pv.length > 0) {
          rows.push(`隐私政策：${pv}`);
        }
        this.supportRows = rows;
      }

      this.ready = true;
      hilog.info(DOMAIN, TAG, '开源声明已载入：npm %{public}d / 原生库 %{public}d / 运行时 %{public}d',
        this.npmRows.length, this.nativeRows.length, this.runtimeRows.length);
    } catch (err) {
      const e = err as BusinessError;
      this.loadError = `开源声明读取失败：${e.message}`;
      hilog.error(DOMAIN, TAG, '开源声明读取失败：code=%{public}d msg=%{public}s', e.code, e.message);
    }
  }

  /** 把 JSON 数组转成 "名称 版本 - 许可证" 行（`withVersion=false` 时名称取 `project`）。 */
  private rowsOf(raw: Object, withVersion: boolean): string[] {
    const rows: string[] = [];
    const arr = raw as Object[];
    if (arr === null || arr === undefined) {
      return rows;
    }
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i] as Record<string, Object>;
      const name = (withVersion ? item['name'] : item['project']) as string;
      const ver = withVersion ? (item['version'] as string) : (item['file'] as string);
      const lic = item['license'] as string;
      const shownName = name !== null && name !== undefined ? name : '（未知）';
      const shownVer = ver !== null && ver !== undefined && ver.length > 0 ? ` ${ver}` : '';
      rows.push(`${shownName}${shownVer} - ${lic}`);
    }
    return rows;
  }

  /**
   * 把 npm 清单拆成「上游核心组件」与「其余第三方」两组。
   *
   * 【为什么要拆（2026-11-11 用户要求"DSH 相关组件精简一点，太多了"）】随包 npm 662 条，
   * 其中 `@deepseek-ai/*` 占 340 条 —— 全部随 dsh 核心分发、许可证高度同质，平铺会把
   * 其余 322 条第三方库淹掉。分组后默认收起，**信息一条不删**，点开仍可逐条核对。
   */
  private splitNpm(raw: Object): void {
    const upstream: string[] = [];
    const rest: string[] = [];
    const arr = raw as Object[];
    if (arr !== null && arr !== undefined) {
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i] as Record<string, Object>;
        const name = item['name'] as string;
        const ver = item['version'] as string;
        const lic = item['license'] as string;
        const shownName = name !== null && name !== undefined ? name : '（未知）';
        const shownVer = ver !== null && ver !== undefined && ver.length > 0 ? ` ${ver}` : '';
        const row = `${shownName}${shownVer} - ${lic}`;
        if (shownName.startsWith('@deepseek-ai/')) {
          upstream.push(row);
        } else {
          rest.push(row);
        }
      }
    }
    this.upstreamRows = upstream;
    this.npmRows = rest;
  }

  @Builder
  private SectionTitle(title: string, subtitle: string) {
    Column({ space: 2 }) {
      Text(title)
        .fontSize(Fs.TITLE_S) /* was 15 */
        .fontWeight(FontWeight.Bold)
        .fontColor('#FF1A1A1A')  // token-exempt: 关于面板固定浅色（与 Web 白底统一，不跟系统深浅）
        .width('100%')
      if (subtitle.length > 0) {
        Text(subtitle)
          .fontSize(11)  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
          .fontColor('#FF666666')  // token-exempt: 关于面板固定浅色（与 Web 白底统一，不跟系统深浅）
          .width('100%')
      }
    }
    .width('100%')
    .padding({ top: 14, bottom: 6 })  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
  }

  @Builder
  private KeyValueRow(label: string, value: string) {
    Row({ space: 10 }) {
      Text(label)
        .fontSize(Fs.CAPTION) /* was 12 */
        .fontColor('#FF666666')  // token-exempt: 关于面板固定浅色（与 Web 白底统一，不跟系统深浅）
        .width(96)
      Text(value.length > 0 ? value : '—')
        .fontSize(Fs.CAPTION) /* was 12 */
        .fontColor('#FF1A1A1A')  // token-exempt: 关于面板固定浅色（与 Web 白底统一，不跟系统深浅）
        .layoutWeight(1)
    }
    .width('100%')
    .padding({ top: 3, bottom: 3 })  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
  }

  @Builder
  private NumberedList(rows: string[]) {
    Column({ space: 2 }) {
      ForEach(rows, (row: string, index: number) => {
        Text(`${index + 1}. ${row}`)
          .fontSize(11)  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
          .fontColor('#FF1A1A1A')  // token-exempt: 关于面板固定浅色（与 Web 白底统一，不跟系统深浅）
          .width('100%')
          .textAlign(TextAlign.Start)
      }, (row: string, index: number) => `${index}-${row}`)
    }
    .width('100%')
  }

  @Builder
  private PlainList(rows: string[]) {
    Column({ space: 4 }) {
      ForEach(rows, (row: string, index: number) => {
        Text(row)
          .fontSize(11)  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
          .fontColor('#FF1A1A1A')  // token-exempt: 关于面板固定浅色（与 Web 白底统一，不跟系统深浅）
          .width('100%')
          .textAlign(TextAlign.Start)
      }, (row: string, index: number) => `${index}-${row}`)
    }
    .width('100%')
  }

  build() {
    Stack() {
      /*
       * 遮罩：**完全透明**，只用来接"点外面关闭"。
       * 【2026-11-11 用户反馈「子菜单呼出后 web 背景就有点黑，背景不要做其他的变化」】
       * 原来是 30% 黑（#4D000000），整块 Web 被压暗一档；现在不压暗、不加模糊，
       * 背景保持原样，面板靠自身 96% 白 + 1px 描边 + 阴影区分层级。
       */
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor('#00000000')  // token-exempt: 遮罩透明 —— 只接点击，不改变背景观感
        .onClick((): void => {
          this.onClose();
        })
      Column() {
        // 顶栏：标题 + 关闭
        Row() {
          Text('关于')
            .fontSize(17)  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
            .fontWeight(FontWeight.Bold)
            .fontColor('#FF1A1A1A')  // token-exempt: 关于面板固定浅色（与 Web 白底统一，不跟系统深浅）
            .layoutWeight(1)
          Button('关闭')
            .fontSize(13)  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
            .height(30)
            .backgroundColor('#FFF0F0F0')  // token-exempt: 关于面板固定浅色（与 Web 白底统一，不跟系统深浅）
            .fontColor('#FF1A1A1A')  // token-exempt: 关于面板固定浅色（与 Web 白底统一，不跟系统深浅）
            .onClick((): void => {
              this.onClose();
            })
        }
        .width('100%')
        .padding({ left: Sp.L, right: Sp.L, top: Sp.M, bottom: 10 })  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）

        Divider().color('#FFE6E6E6')  // token-exempt: 关于面板固定浅色（与 Web 白底统一，不跟系统深浅）

        if (this.loadError.length > 0) {
          Text(this.loadError)
            .fontSize(Fs.CAPTION) /* was 12 */
            .fontColor('#FFCC3333')  // token-exempt: 关于面板固定浅色（与 Web 白底统一，不跟系统深浅）
            .width('100%')
            .padding(12)
        }

        Scroll() {
          Column() {
            if (this.initialTab === 'version') {
              this.SectionTitle('版本信息', '')
              this.KeyValueRow('应用', 'DSHM（HarmonyOS 客户端）')
              this.KeyValueRow('应用版本', this.appVersion)
              this.KeyValueRow('包名', this.bundleName)
              this.KeyValueRow('构建模式', this.buildMode)
              this.KeyValueRow('dsh 核心版本', this.coreVersion)
              if (this.upstreamLine.length > 0) {
                Text(this.upstreamLine)
                  .fontSize(11)  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
                  .fontColor('#FF666666')  // token-exempt: 关于面板固定浅色（与 Web 白底统一，不跟系统深浅）
                  .width('100%')
                  .padding({ top: Sp.XS })
              }

              this.SectionTitle('技术支持', '')
              this.PlainList(this.supportRows)

              /*
               * 【措辞必须避让品牌红线】本仓 `check-brand-surface` 规定**用户可见文案**不得出现
               * 上游产品名（那属于上游，不是我们的品牌面）。商标归属声明
               * **照旧成立**，只是改为"相关名称与标识"来引述，法务含义不减。
               */
              Text('上游相关名称与标识归其权利人所有；MIT 许可只授予版权权利，'
                + '不授予商标、服务标记、标识、背书或官方隶属关系。DSHM与 DeepSeek 不存在隶属、授权、代理、'
                + '背书或其他特定关系。')
                .fontSize(11)  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
                .fontColor('#FF666666')  // token-exempt: 关于面板固定浅色（与 Web 白底统一，不跟系统深浅）
                .width('100%')
                .padding({ top: 10, bottom: 18 })  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
            } else {
              this.SectionTitle('开源组件声明',
                '逐条列出随包第三方开源库与其许可证；本页清单由构建期脚本从实际随包内容生成')
              if (this.summaryRows.length > 0) {
                Text('许可证分布（核心树 npm 依赖）')
                  .fontSize(Fs.CAPTION) /* was 12 */
                  .fontWeight(FontWeight.Medium)
                  .width('100%')
                  .padding({ top: Sp.XS, bottom: 2 })  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
                this.PlainList(this.summaryRows)
              }
              Text(`随包运行时与工具（${this.runtimeRows.length} 项）`)
                .fontSize(Fs.CAPTION) /* was 12 */
                .fontWeight(FontWeight.Medium)
                .width('100%')
                .padding({ top: Sp.S, bottom: 2 })  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
              this.NumberedList(this.runtimeRows)
              Text(`随包原生共享库（${this.nativeRows.length} 个第三方库）`)
                .fontSize(Fs.CAPTION) /* was 12 */
                .fontWeight(FontWeight.Medium)
                .width('100%')
                .padding({ top: Sp.S, bottom: 2 })  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
              this.NumberedList(this.nativeRows)
              if (this.selfLibsLine.length > 0) {
                Text(this.selfLibsLine)
                  .fontSize(11)  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
                  .fontColor('#FF666666')  // token-exempt: 关于面板固定浅色（与 Web 白底统一，不跟系统深浅）
                  .width('100%')
                  .padding({ top: Sp.XS })
              }
              Text(`HarmonyOS 侧依赖（ohpm，${this.ohpmRows.length} 项）`)
                .fontSize(Fs.CAPTION) /* was 12 */
                .fontWeight(FontWeight.Medium)
                .width('100%')
                .padding({ top: Sp.S, bottom: 2 })  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
              this.NumberedList(this.ohpmRows)

              /*
               * 【上游核心组件默认收起（2026-11-11）】`@deepseek-ai/*` 占 npm 清单 340 条，
               * 全部随 dsh 核心分发；平铺会把它下面 322 条真正的第三方库淹掉。
               * 收起只是降噪，点开仍逐条可核对，信息没有删除。
               */
              Row() {
                Text(`上游核心组件（${this.upstreamRows.length} 项，随 dsh 核心分发）`)
                  .fontSize(Fs.CAPTION) /* was 12 */
                  .fontWeight(FontWeight.Medium)
                  .fontColor('#FF1A1A1A')  // token-exempt: 关于面板固定浅色（与 Web 白底统一，不跟系统深浅）
                Blank()
                Text(this.upstreamExpanded ? '收起' : '展开')
                  .fontSize(11)  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
                  .fontColor('#FF666666')  // token-exempt: 关于面板固定浅色（与 Web 白底统一，不跟系统深浅）
              }
              .width('100%')
              .padding({ top: Sp.S, bottom: 2 })  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
              .onClick((): void => {
                this.upstreamExpanded = !this.upstreamExpanded;
              })
              if (this.upstreamExpanded) {
                this.NumberedList(this.upstreamRows)
              }

              Text(`其余第三方 npm 依赖（${this.npmRows.length} 个包）`)
                .fontSize(Fs.CAPTION) /* was 12 */
                .fontWeight(FontWeight.Medium)
                .width('100%')
                .padding({ top: Sp.S, bottom: 2 })  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
              this.NumberedList(this.npmRows)
              Text('以上为随包全部第三方开源组件；本应用未使用上述清单之外的第三方开源库。')
                .fontSize(11)  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
                .fontColor('#FF666666')  // token-exempt: 关于面板固定浅色（与 Web 白底统一，不跟系统深浅）
                .width('100%')
                .padding({ top: Sp.S })

              this.SectionTitle('源码与版权信息',
                '采用 GPL / LGPL / MPL 等需要提供源码的组件，逐一列明上游获取地址')
              /*
               * 【必须同时保留上游版权与本地修改版权（2026-10-29 审核补）】漏掉上游那句等于
               * 抹掉 MIT 要求的版权归属（`check-brand-surface` 的「关于页保留上游版权归属」正是守这条）。
               */
              Text('上游项目：MIT License，Copyright (c) 2026 DeepSeek')
                .fontSize(11)  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
                .width('100%')
              Text('DSHM应用与鸿蒙适配：MIT License，Copyright (c) 2026 sol')
                .fontSize(11)  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
                .width('100%')
              this.PlainList(this.copyleftRows)

              if (this.generatedAt.length > 0) {
                Text(`声明生成时间：${this.generatedAt}`)
                  .fontSize(10)  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
                  .fontColor('#FF999999')  // token-exempt: 关于面板固定浅色（与 Web 白底统一，不跟系统深浅）
                  .width('100%')
                  .padding({ top: Sp.S, bottom: 20 })  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
              }
            }
          }
          .width('100%')
          .padding({ left: Sp.L, right: Sp.L, top: Sp.S })
          .alignItems(HorizontalAlign.Start)
        }
        /*
         * 【必须显式 TopStart】Scroll 的 align 默认是 Center —— 内容比面板短时（版本页
         * 就是这样）整块内容会垂直居中，看起来"没有左上对齐"。用户 2026-11-11 反馈
         * 的正是这个。强制顶部 + 左侧对齐后，内容少就贴左上，下方留白。
         */
        .align(Alignment.TopStart)
        .layoutWeight(1)
        .scrollBar(BarState.Auto)
      }
      /*
       * 【2026-11-11 用户裁决（第二次）：两个入口必须"看起来是同一个面板"】
       * 宽度、高度、圆角、阴影、底色全部统一 —— 不再按页签给不同尺寸；版本页内容少，
       * 内容靠左上排，下方留白即可。
       *
       * 底色 = 96% 白 + 轻模糊（`backdropBlur(12)`），**不用** `backgroundBlurStyle`：
       * 后者的材质色由系统 colorMode 决定，深色系统下会把整面板染成深灰（真机就是
       * 这个"黑黑的"）。`backdropBlur` 只做模糊、不掺主题色。
       *
       * 【为什么模糊半径是 12】面板外的"点空白关闭"遮罩已改为全透明，不再有 30% 黑
       * 可被圆角采样（那正是旧版"左右上角发黑"的成因）；12px 只留轻透光。
       */
      .width('92%')
      .height('72%')
      .constraintSize({ maxWidth: 560 })
      .borderRadius(22)  // token-exempt: 关于页紧随官方信息面板的排版密度，无对应 token（颜色无 token 体系）
      .backgroundColor('#F7FFFFFF')  // token-exempt: 关于面板固定浅色（与 Web 白底统一，不跟系统深浅）
      .backdropBlur(12)
      .border({ width: 1, color: '#80FFFFFF' })  // token-exempt: 压住模糊在圆角处的暗边
      .shadow({ radius: 28, color: '#33000000', offsetY: 10 })
      .clip(true)
    }
    .width('100%')
    .height('100%')
  }
}