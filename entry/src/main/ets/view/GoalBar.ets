/**
 * 长期目标栏（官方 `ui-goal` 的目标栏形态）。
 *
 * ## 为什么它没有 props
 *
 * 它直接读中枢快照（`SessionHub.shared().snapshot()`）——与"可添加提供方"是同一先例：
 * 打开面板时会重新渲染，届时读到最新值；少穿两层状态，也**不会出现"状态与中枢不一致"**。
 * 抽成组件之后这条性质不变：它自足，宿主只决定"放在哪"。
 *
 * ## 三种情况分得很清（不把"没读到"说成"没有目标"）
 *
 * | 中枢给的 | 显示 |
 * |---|---|
 * | 有目标文本 | 目标文本（次要色） |
 * | 中枢说没有（`goalNote` 非空，例如"该会话当前没有长期目标"） | 如实显示那句话 |
 * | 形状未识别/失败 | `未读取`（三级色）——**这是最要紧的一条**：把"读不到"说成"没有"会让用户以为目标丢了 |
 */

import { Fs, SessionHub, Sp } from 'appstate';

@Component
export struct GoalBar {
  build() {
    Row({ space: Sp.S }) {
      Text('长期目标')
        .fontSize(Fs.CAPTION)
        .layoutWeight(1)
      Text(SessionHub.shared().snapshot().goalText.length > 0
        ? SessionHub.shared().snapshot().goalText
        : (SessionHub.shared().snapshot().goalNote.length > 0
          ? SessionHub.shared().snapshot().goalNote
          : '未读取'))
        .fontSize(Fs.CAPTION)
        .fontColor(SessionHub.shared().snapshot().goalText.length > 0
          ? $r('sys.color.font_secondary')
          : $r('sys.color.font_tertiary'))
        .layoutWeight(2)
        .maxLines(3)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
  }
}
