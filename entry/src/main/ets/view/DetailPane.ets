/**
 * 详情栏（Detail Pane）—— D3 §1 信息架构中「会话详情」的右侧分区。
 *
 * 分区：工具调用 / 子代理 / 交付物 / 目标 / 任务。
 * 每个分区都有**空态说明**（D3 §4 文案纪律：空态要说明"可以做什么"）。
 *
 * 数据由宿主注入（当前来自桩数据源）；分区标题与条数来自 appstate 的呈现契约。
 */

import {
  DetailSection,
  Fs,
  Radius,
  Sp,
  Sz
} from 'appstate';

@Component
export struct DetailPane {
  @Prop sections: DetailSection[] = [];
  /** 点击某一行（E130：把行文本交给宿主——先前的 (section,index) 让宿主拿不到文本，实现只能是空的） */
  onLineTap: (section: string, text: string) => void = () => {
  };

  @State collapsed: string[] = [];

  build() {
    Column() {
      List({ space: Sp.S }) {
        ForEach(this.sections, (section: DetailSection) => {
          ListItem() {
            this.sectionCard(section)
          }
        }, (section: DetailSection) => section.title)
      }
      .layoutWeight(1)
      .width('100%')
      .padding(Sp.M)
      .scrollBar(BarState.Auto)
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  sectionCard(section: DetailSection) {
    Column({ space: Sp.XS }) {
      Row({ space: Sp.S }) {
        SymbolGlyph(this.sectionSymbol(section.title))
          .fontSize(16)
          .fontColor([$r('sys.color.font_secondary')])
        Text(section.title)
          .fontSize(Fs.SECONDARY)
          .fontWeight(FontWeight.Medium)
          .layoutWeight(1)
        Text(`${section.count}`)
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .padding({ left: 6, right: 6, top: 1, bottom: 1 })
          .borderRadius(Radius.XS)
          .backgroundColor($r('sys.color.background_primary'))
        Text(this.isCollapsed(section.title) ? '展开' : '收起')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.brand'))
      }
      .width('100%')
      .height(Sz.TOUCH_MIN)
      .onClick(() => {
        this.toggle(section.title);
      })

      if (!this.isCollapsed(section.title)) {
        if (section.lines.length === 0) {
          Text(section.emptyHint)
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_tertiary'))
            .width('100%')
            .padding({ left: Sp.S, bottom: Sp.XS })
        } else {
          ForEach(section.lines, (line: string, index: number) => {
            Text(line)
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.font_secondary'))
              .maxLines(2)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')
              .padding({ left: Sp.S, right: Sp.S, top: Sp.XS, bottom: Sp.XS })
              .borderRadius(Radius.XS)
              .onClick(() => {
                // E130：这一行的**文本**直接给宿主（视图知道自己渲染了什么）
                this.onLineTap(section.title, line);
              })
          }, (line: string, index: number) => `${section.title}-${index}`)
        }
      }
    }
    .width('100%')
    .padding({ bottom: Sp.S })
    .borderRadius(Radius.M)
    .backgroundColor($r('sys.color.background_primary'))
  }

  private isCollapsed(title: string): boolean {
    return this.collapsed.indexOf(title) >= 0;
  }

  private toggle(title: string): void {
    const out: string[] = [];
    let found: boolean = false;
    for (let i = 0; i < this.collapsed.length; i++) {
      if (this.collapsed[i] === title) {
        found = true;
      } else {
        out.push(this.collapsed[i]);
      }
    }
    if (!found) {
      out.push(title);
    }
    this.collapsed = out;
  }

  private sectionSymbol(title: string): Resource {
    if (title === '工具调用') {
      return $r('sys.symbol.wrench_and_screwdriver');
    }
    if (title === '子代理') {
      return $r('sys.symbol.person_2');
    }
    if (title === '交付物') {
      return $r('sys.symbol.doc_text');
    }
    if (title === '目标') {
      return $r('sys.symbol.checkmark_circle');
    }
    return $r('sys.symbol.list_bullet');
  }
}
