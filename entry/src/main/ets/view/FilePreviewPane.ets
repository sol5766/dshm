/**
 * 文件预览（P3-2：从 `WorkspacePane` 抽出的**共用**呈现）。
 *
 * ## 为什么抽出来
 *
 * 这段呈现（空态 / 头部「投喂」/ 正文：代码等宽、Markdown、过大与二进制两档空态）原先只长在
 * `WorkspacePane` 的第三列里。官方 Web 的**右栏**也有「预览」面板（`ui-workspace` 的预览视图），
 * 而右栏与工作区页签**要的是同一份呈现**——抄一份必然走样（改了一处忘了另一处）。
 * 故抽成组件：谁挂都行，内容只有一份。
 *
 * ## 边界
 *
 *  · `preview` 为 `undefined` 时是**空态**（"选择文件以预览"）——空态也归组件，
 *    否则每个挂载点都要重复判一次"有没有预览"。
 *  · 「投喂」（把预览的文件加进输入区）是**副作用**：组件只报"要投喂这个节点"（`onAttachFile`），
 *    调中枢由宿主做（与 `WorkspaceBrowser` / `MessageFeedback` 同一口径）。
 */

import { FileNode, FilePreview, Fs, NodeKind, PreviewKind, Sp, formatBytes } from 'appstate';

@Component
export struct FilePreviewPane {
  /** 当前预览的文件（`undefined` = 显示空态） */
  @Prop preview?: FilePreview;
  /** 「投喂」：把这个节点加进输入区（副作用归宿主） */
  onAttachFile: (node: FileNode) => void = () => {
  };

  build() {
    Column() {
      if (this.preview === undefined) {
        Column({ space: Sp.S }) {
          SymbolGlyph($r('sys.symbol.doc_text')).fontSize(32)   // token-exempt: 空态插画尺寸，不属于排版层级
            .fontColor([$r('sys.color.font_tertiary')])
          Text('选择文件以预览')
            .fontSize(Fs.SECONDARY)
            .fontColor($r('sys.color.font_secondary'))
          Text('支持文本、代码、Markdown 与图片')
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_tertiary'))
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else {
        this.previewHeader()
        Divider().color($r('sys.color.comp_divider'))
        this.previewBody()
      }
    }
    .width('100%')
    .height('100%')

  }

  @Builder
  previewHeader() {
    Column({ space: Sp.XS }) {
      Row({ space: Sp.S }) {
        Text(this.preview!.name)
          .fontSize(Fs.SECONDARY)
          .fontWeight(FontWeight.Medium)
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text('投喂')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.brand'))
          .onClick(() => {
            this.onAttachFile(this.previewAsNode());
          })
      }
      .width('100%')
      Text(this.previewMeta())
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_tertiary'))
        .maxLines(2)
        .width('100%')
    }
    .width('100%')
    .padding(Sp.M)
  }

  @Builder
  previewBody() {
    if (this.preview!.kind === PreviewKind.TOO_LARGE) {
      Column({ space: Sp.S }) {
        SymbolGlyph($r('sys.symbol.exclamationmark_triangle')).fontSize(28)   // token-exempt: 空态插画尺寸，不属于排版层级
          .fontColor([$r('sys.color.warning')])
        Text('文件过大，未在端侧预览')
          .fontSize(Fs.SECONDARY)
        Text(`大小 ${formatBytes(this.preview!.size)}，超过端侧预览上限。可在 Host 侧用工具读取。`)
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .textAlign(TextAlign.Center)
          .padding({ left: Sp.L, right: Sp.L })
      }
      .width('100%')
      .layoutWeight(1)
      .justifyContent(FlexAlign.Center)
    } else if (this.preview!.kind === PreviewKind.BINARY) {
      Column({ space: Sp.S }) {
        SymbolGlyph($r('sys.symbol.doc_text')).fontSize(28)   // token-exempt: 空态插画尺寸，不属于排版层级
          .fontColor([$r('sys.color.font_tertiary')])
        Text('二进制文件，无文本预览')
          .fontSize(Fs.SECONDARY)
          .fontColor($r('sys.color.font_secondary'))
      }
      .width('100%')
      .layoutWeight(1)
      .justifyContent(FlexAlign.Center)
    } else {
      Scroll() {
        Column({ space: Sp.S }) {
          if (this.preview!.truncated) {
            Text(`仅显示前 ${formatBytes(this.preview!.text.length)}（原文件 ${formatBytes(this.preview!.size)}）`)
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.warning'))
              .width('100%')
          }
          Text(this.preview!.text)
            .fontSize(this.preview!.kind === PreviewKind.CODE ? Fs.CAPTION : Fs.SECONDARY)
            .fontFamily(this.preview!.kind === PreviewKind.CODE ? 'monospace' : '')
            .width('100%')
            .textAlign(TextAlign.Start)
        }
        .width('100%')
        .padding(Sp.M)
      }
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.TopStart)
      .scrollBar(BarState.Auto)
    }
  }

  private previewMeta(): string {
    const p: FilePreview = this.preview!;
    const kindText: string = p.kind === PreviewKind.CODE
      ? `代码 · ${p.language}`
      : (p.kind === PreviewKind.MARKDOWN ? 'Markdown' : (p.kind === PreviewKind.IMAGE ? '图片' : '文本'));
    const sizeText: string = formatBytes(p.size);
    return sizeText.length > 0 ? `${kindText} · ${sizeText}` : kindText;
  }

  private previewAsNode(): FileNode {
    return {
      name: this.preview!.name,
      path: this.preview!.path,
      kind: NodeKind.FILE,
      size: this.preview!.size,
      modifiedAt: 0,
      loaded: true,
      children: [],
      deliverable: false
    };
  }
}
