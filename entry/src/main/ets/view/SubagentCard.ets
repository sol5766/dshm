/**
 * 子代理卡（P3-5：从 `ConversationPane` 抽出的**共用**呈现）。
 *
 * ## 为什么抽出来
 *
 * 子代理有两个"家"：会话过程流里的一张卡，以及**右栏的「子代理」面板**（官方右栏的候选之一）。
 * 两处要的是同一张卡 ⇒ 抽成组件（与 `DeliverableCard` / `FilePreviewPane` / `FileTreePane` 同一口径）。
 *
 * ## 为什么它只吃 `item`（连"钟点"都自己算）
 *
 * 宿主 `ConversationPane` 里有个私有 `clockOf(ms)`，它其实是
 * 「`ms <= 0` 时给空串，否则 `formatClock(ms)`」——而 `formatClock` 本来就是模型里的纯函数。
 * 组件要的是同一个结果，于是直接写 `item.at > 0` 这一个判据 + 模型函数，
 * **不再往组件里塞一个 `meta` 字符串**（少一个 prop，也少一处"两边格式可能不一致"）。
 */

import { TrajectoryItem, formatClock, formatDuration } from 'appstate';
import { NativeCard } from './NativePrimitives';

@Component
export struct SubagentCard {
  /** 要显示的子代理条目 */
  @Prop item: TrajectoryItem;

  build() {
    NativeCard({
      iconSymbol: $r('sys.symbol.person_2'),
      title: `子代理 ${this.item.subagentName}`,
      tone: 'brand',
      meta: this.item.elapsedMs > 0
        ? (this.item.at > 0
          ? `${formatClock(this.item.at)} · ${formatDuration(this.item.elapsedMs)}`
          : formatDuration(this.item.elapsedMs))
        : '',
      bodyText: this.item.body,
      expanded: true,
      a11y: `子代理 ${this.item.subagentName}`
    })
  }
}
