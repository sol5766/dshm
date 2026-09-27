/**
 * Markdown 渲染（P2：会话正文的呈现）。
 *
 * 【为什么与模型分开】切块与行内标注是**纯字符串处理**（`appstate/model/Markdown`，
 * 由 `tools/check-layout-fixtures.mjs` 本机直接跑）；这里只管"画成什么样"——
 * 字号、行高、代码块底色、引用条的取色与间距。分开放的好处是：解析规则能被断言，
 * 而样式调整不会碰到规则。
 *
 * 【为什么每次文本变化都重解析】流式回复是**一次一次追加**的，没有"解析一次用到底"的时机；
 * 文本长度是消息级（几 KB），重解析代价远低于渲染本身。解析器本身对"半截标记"是安全的
 * （未闭合的围栏、未配对的 `*` 都原样保留），所以流式过程中界面不会闪。
 *
 * 【为什么用 `Text > Span` 而不是每段一个组件】行内强调必须**跟着文字流换行**
 * （`**很长的一段粗体**` 在窄栏里要正常折行）。ArkUI 里只有 `Text > Span` 能做到；
 * `Row` 拼小块会在每块之间断开，窄栏下会变成一列碎块。
 */

import { Border, Fs, Lh, MdBlock, MdBlockKind, MdSpan, Radius, SemanticColor, Sp, parseMarkdown, plainTextOf } from 'appstate';
import { openExternalUrl } from 'platform';
import hilog from '@ohos.hilog';

const DOMAIN: number = 0xD5A2;
const TAG: string = 'dshm/markdown';

@Component
export struct MarkdownRenderer {
  /**
   * 原始 Markdown 文本（由宿主给；变化即重解析）。
   *
   * 【为什么传原文而不是传解析结果】解析结果要经过宿主（`Index` 的投影/host 门面）才能进来，
   * 那会把"呈现细节"塞进状态层；传原文则宿主完全不必知道 Markdown 的存在。
   */
  @Prop @Watch('onTextChanged') text: string = '';
  /**
   * 次要语气（思考过程、过程说明用）：字号小一档、颜色降一级。
   *
   * 【为什么用入参而不是在调用点包一层样式】同一份 Markdown 在两处的差别只有"语气"，
   * 包一层等于把渲染逻辑抄两遍。
   */
  @Prop muted: boolean = false;

  @State blocks: MdBlock[] = [];

  aboutToAppear(): void {
    this.blocks = parseMarkdown(this.text);
  }

  onTextChanged(): void {
    this.blocks = parseMarkdown(this.text);
  }

  /** 标题字号（官方 Markdown 的层级感：标题比正文大，级别越高越大） */
  private headingSize(level: number): number {
    if (level <= 1) {
      return Fs.TITLE_L;
    }
    if (level === 2) {
      return Fs.TITLE_M;
    }
    return Fs.TITLE_S;
  }

  /** 正文基色：次要语气降一级（与 `muted` 对应） */
  private bodyColor(): Resource {
    return this.muted ? SemanticColor.TEXT_SECONDARY : SemanticColor.TEXT_PRIMARY;
  }

  build() {
    Column({ space: Sp.S }) {
      ForEach(this.blocks, (b: MdBlock, index: number) => {
        this.blockView(b)
      }, (b: MdBlock, index: number) => `${index}:${b.kind}:${b.text.length}`)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  blockView(b: MdBlock) {
    if (b.kind === MdBlockKind.HEADING) {
      this.inlineText(b, this.headingSize(b.level), FontWeight.Bold)
    } else if (b.kind === MdBlockKind.CODE) {
      this.codeBlock(b)
    } else if (b.kind === MdBlockKind.LIST_ITEM) {
      this.listRow(b)
    } else if (b.kind === MdBlockKind.QUOTE) {
      this.quoteBlock(b)
    } else if (b.kind === MdBlockKind.RULE) {
      Divider().color(SemanticColor.DIVIDER).width('100%')
    } else {
      this.inlineText(b, Fs.BODY, FontWeight.Normal)
    }
  }

  /**
   * 一行行内文本（`Text > Span`）。
   *
   * 【`Span` 上只放"文字属性"】字号/字重/斜体/删除线/颜色都在 `Span` 上；
   * 段落级的行高与宽度在 `Text` 上。这样换行由文字流自己决定，不需要任何布局技巧。
   */
  @Builder
  inlineText(b: MdBlock, size: number, weight: FontWeight) {
    Text() {
      ForEach(b.spans, (sp: MdSpan) => {
        Span(sp.text)
          .fontSize(size)
          .fontWeight(sp.bold ? FontWeight.Bold : weight)
          .fontStyle(sp.italic ? FontStyle.Italic : FontStyle.Normal)
          .fontColor(sp.code ? SemanticColor.BRAND
            : (sp.href.length > 0 ? SemanticColor.BRAND : this.bodyColor()))
          .decoration({
            type: sp.strike ? TextDecorationType.LineThrough
              : (sp.href.length > 0 ? TextDecorationType.Underline : TextDecorationType.None),
            color: sp.href.length > 0 ? SemanticColor.BRAND : this.bodyColor()
          })
          .fontFamily(sp.code ? 'monospace' : '')
          .onClick(() => {
            if (sp.href.length > 0) {
              this.openLink(sp.href);
            }
          })
      })
    }
    .fontSize(size)
    .lineHeight(size * Lh.BODY)
    .width('100%')
    .textAlign(TextAlign.Start)
    .copyOption(CopyOptions.LocalDevice)
  }

  /**
   * 围栏代码块。
   *
   * 【未闭合时给出光标（`closed === false`）】流式生成时围栏常常还没收尾。
   * 这里不改变样式（避免"闭合那一刻画面跳一下"），只在末尾加一个光标——
   * 与正文的流式光标是同一个约定。
   */
  @Builder
  codeBlock(b: MdBlock) {
    Column({ space: Sp.XS }) {
      if (b.lang.length > 0) {
        Text(b.lang)
          .fontSize(Fs.CAPTION_XS)
          .fontColor(SemanticColor.TEXT_TERTIARY)
      }
      Text(b.closed ? b.text : b.text + ' ▌')
        .fontSize(Fs.SECONDARY)
        .fontFamily('monospace')
        .fontColor(this.bodyColor())
        .width('100%')
        .textAlign(TextAlign.Start)
        .copyOption(CopyOptions.LocalDevice)
    }
    .width('100%')
    .padding(Sp.S)
    .borderRadius(Radius.S)
    .backgroundColor(SemanticColor.BG_SECONDARY)
    .borderWidth(Border.HAIRLINE)
    .borderColor(SemanticColor.DIVIDER)
  }

  /** 列表项：标记 + 内容（标记固定宽度，多行内容左对齐成一列） */
  @Builder
  listRow(b: MdBlock) {
    Row({ space: Sp.S }) {
      Text(b.marker)
        .fontSize(Fs.BODY)
        .fontColor(SemanticColor.BRAND)
        .textAlign(TextAlign.End)
        .width(Sp.XL)
      Column() {
        this.inlineText(b, Fs.BODY, FontWeight.Normal)
      }
      .layoutWeight(1)
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
  }

  /** 引用：左侧一条品牌色竖条 + 内容降一级语气 */
  @Builder
  quoteBlock(b: MdBlock) {
    Row({ space: Sp.S }) {
      Column()
        .width(Border.HAIRLINE * 3)
        .height('100%')
        .backgroundColor(SemanticColor.BRAND)
      Column() {
        Text(this.spansText(b.spans))
          .fontSize(Fs.SECONDARY)
          .fontColor(SemanticColor.TEXT_SECONDARY)
          .width('100%')
          .textAlign(TextAlign.Start)
          .copyOption(CopyOptions.LocalDevice)
      }
      .layoutWeight(1)
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
    .padding({ left: Sp.S })
  }

  /** 片段拼成纯文本（引用块按整段渲染：引用里再分行会显得碎） */
  private spansText(spans: MdSpan[]): string {
    let out: string = '';
    for (let i = 0; i < spans.length; i++) {
      out += spans[i].text;
    }
    return out;
  }

  /**
   * 打开链接。
   *
   * 【为什么失败要说话】点链接的意图是"去看那个页面"；打不开却毫无反应，
   * 用户只会以为是应用卡了。这里用 hilog 留痕（端侧没有 toast 通道，见 `platform/notify` 的说明），
   * 不伪造成功。
   */
  private openLink(href: string): void {
    openExternalUrl(href).then((ok: boolean) => {
      if (!ok) {
        hilog.warn(DOMAIN, TAG, 'open link failed');
      }
    }).catch((e: Object) => {
      hilog.warn(DOMAIN, TAG, 'open link threw: %{public}s', (e as Error).message);
    });
  }

  /** 无障碍/复制的降级文本（去掉标记，只留内容） */
  plainText(): string {
    return plainTextOf(this.blocks);
  }
}
