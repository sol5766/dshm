/**
 * 过程流里的**思考块**（P2-6 第二刀：从"回合渲染"里抽出的共用呈现）。
 *
 * ## 为什么单独成组件
 *
 * 思考块在**两处**出现，形状必须一致：
 *   · **轨迹视图**：思考是一条独立条目（`TrajectoryKind.REASONING`），直接列在时间线上；
 *   · **对话视图**：思考挂在回合的"过程分组"里（分组展开时才可见）。
 *
 * 抽出来之前，轨迹视图那条只能用宿主的一个 `@Builder` 画，而对话视图那条画在 `TurnView` 里
 * —— 两处各写一份必然走样（本仓反复出现的教训：`ToolCard` / `DeliverableCard` / `FileTreePane`
 * 都是同一个理由抽出来的）。现在两处**共用这一份**。
 *
 * ## 两条保留的语义
 *
 * 1. **折叠默认收起**：思考是"可看可不看"的过程信息，默认展开会把答案挤下去；
 * 2. **流式时标题变"思考中…"**：这是"模型正在想"的唯一界面信号（此时正文还没到）。
 *    已结束则给"已思考 N 秒"（`formatDuration`），拿不到时长就退回"思考过程"——
 *    不编一个看起来像读数的时间。
 *
 * ## 展开态是入参
 *
 * 与 `ToolCard` 同一条规矩：主区有「展开全部 / 收起全部」，那是**跨行**操作 ⇒
 * 展开集合的唯一真值在宿主（`TurnView` 或轨迹列表），本组件只吃 `expanded` 并上报 `onToggle`。
 */

import { Fs, Radius, Sp, TrajectoryItem, formatDuration } from 'appstate';
import { Border } from 'appstate';
import { MarkdownRenderer } from './MarkdownRenderer';

/** 思考块（默认收起；流式时标题为"思考中…"） */
@Component
export struct ReasoningRow {
  /** 要显示的思考条目 */
  @Prop item: TrajectoryItem;
  /** 是否已展开（唯一真值在宿主） */
  @Prop expanded: boolean = false;
  /** 点整块或标题都能开合 */
  onToggle: () => void = () => {
  };

  /** 标题：流式 > 有耗时 > 通用措辞（不编读数） */
  private title(): string {
    if (this.item.streaming) {
      return '思考中…';
    }
    if (this.item.elapsedMs > 0) {
      return `已思考 ${formatDuration(this.item.elapsedMs)}`;
    }
    return '思考过程';
  }

  build() {
    Column({ space: Sp.XS }) {
      Row({ space: Sp.S }) {
        SymbolGlyph($r('sys.symbol.lightbulb'))
          .fontSize(14)   // token-exempt: 行内图标尺寸（搬迁不改视觉；与 Fs.CAPTION 同值但语义不同）
          .fontColor([$r('sys.color.font_tertiary')])
        Text(this.title())
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .layoutWeight(1)
        Text(this.expanded ? '收起' : '展开')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.brand'))
      }
      .width('100%')

      if (this.expanded) {
        MarkdownRenderer({ text: this.item.body, muted: true })
      }
    }
    .width('100%')
    .padding(Sp.S)
    .borderRadius(Radius.S)
    .borderWidth(Border.HAIRLINE)
    .borderColor($r('sys.color.comp_divider'))
    .accessibilityText(`思考过程，${this.expanded ? '点击收起' : '点击展开'}`)
    .onClick(() => {
      this.onToggle();
    })
  }
}
