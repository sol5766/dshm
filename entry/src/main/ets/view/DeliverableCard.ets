/**
 * 交付物卡片（P3-4：从 `ConversationPane` 抽出的**共用**呈现）。
 *
 * ## 为什么抽出来
 *
 * 交付物有两个"家"：会话过程流里的一张卡（官方在过程里也显示），以及**右栏的「交付物」面板**
 * （官方右栏的候选之一）。两处要的是同一张卡（图标 / 文件名 / 大小 / 动作行），抄一份必然走样。
 *
 * ## 边界
 *
 * 卡片**不认识中枢**：它只是一张卡。动作行里的「保存 / 分享」是**可见但禁用**的，
 * 原因是平台能力缺口（`platform` 只有分享**文本**、没有"另存为"）——理由写在无障碍文案里，
 * 读屏用户点不到也知道为什么（假入口是本项目明令禁止的形态）。
 */

import { Fs, Radius, Sp, TrajectoryItem, formatBytes } from 'appstate';
import { NativeActionBar } from './NativePrimitives';
import type { NativeAction } from './NativePrimitives';

@Component
export struct DeliverableCard {
  /** 要显示的交付物条目 */
  @Prop item: TrajectoryItem;

  build() {
    // 【ArkUI 约束】组件的 `build()` 只能有一个根节点（`@Builder` 可以多个）⇒ 两行包进 Column
    Column({ space: Sp.XS }) {
      Row({ space: Sp.M }) {
      SymbolGlyph($r('sys.symbol.doc_text'))
        .fontSize(20)   // token-exempt: 卡片图标尺寸（搬迁不改视觉；与 Fs.TITLE_L 同值但语义不同）
        .fontColor([$r('sys.color.brand')])
      Column({ space: 2 }) {
        Text(this.item.fileName)
          .fontSize(Fs.SECONDARY)
          .fontWeight(FontWeight.Medium)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        Text(formatBytes(this.item.fileSize))
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')
      }
      .layoutWeight(1)
    }
    .width('100%')
    .padding(Sp.M)
    .borderRadius(Radius.M)
    .backgroundColor($r('sys.color.background_secondary'))
    .accessibilityText(`交付物 ${this.item.fileName}`)
      // 动作行统一交给原语：间距/换行/语气只实现一次（此前是两个手写 Text）
      Row() {
        NativeActionBar({
          actions: this.fileActions(this.item)
        })
      }
      .width('100%')
    }
    .width('100%')
  }

  private fileActions(item: TrajectoryItem): NativeAction[] {
    const out: NativeAction[] = [];
    /*
     * 【为什么这两个动作是"可见但禁用"，而不是可点】
     *
     * 它们此前是**两个不可点的 Text 标签**（看着像入口、点了没反应）——那正是本项目禁止的假入口形态。
     * 本轮查清了平台能力后确认：`platform` 只提供 `shareText`（**文本**，不是文件本体）
     * 与 `pickFolder/pickDocument`（选择，不是保存），**没有"另存为"** ⇒ 现在**无法**把
     * "保存 / 分享文件"做成真动作。
     *
     * 因此按纪律改成：动作**留在原位**（用户能看见这条卡具备这些能力）、
     * 但**禁用**并把原因写在无障碍文案里（读屏用户点不到也知道为什么）。
     * 真接线要等文件保存/分享能力就位——缺口已登记在矩阵 `deliverables` 行。
     */
    out.push({
      id: 'save',
      label: '保存',
      disabled: true,
      a11y: '保存到本地：尚未接线（当前平台未提供文件保存能力）'
    });
    out.push({
      id: 'share',
      label: '分享',
      disabled: true,
      a11y: '分享文件：尚未接线（当前平台只支持分享文本，不支持文件本体）'
    });
    return out;
  }
}
