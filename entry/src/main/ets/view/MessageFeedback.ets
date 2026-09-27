/**
 * 消息反馈面板（P2-3：Message Action 的第一块独立组件）。
 *
 * ## 为什么单独成组件
 *
 * 它此前长在 1700 行的 `ConversationPane` 里（`@Builder feedbackPanel` + 5 个 `@State`：
 * `fbFor/fbRating/fbCategory/fbNote/fbNote2`）。**表单态与消息列表态混在一个组件里**的代价是：
 * 每敲一个字（`note` 的 `onChange`）都会把整个会话列表重绘一遍——列表越长越明显；
 * 而且"这条消息的反馈表单"与"消息怎么排版"是两件事，不该共享状态作用域。
 * 拆出之后：**表单态归这里**，`ConversationPane` 只留"哪个消息的反馈面板开着"（`fbFor`）与回执（`fbNote2`）。
 *
 * ## 与宿主的边界
 *
 *  · 初值（已存的类别/说明）由宿主在**打开那一刻**给（`initialCategory`/`initialNote`）；
 *    之后编辑过程中的变化不再回灌（否则用户打字打到一半会被覆盖）。
 *  · 提交只报"用户选了什么"（`onSubmit(category, note)`）；**调中枢是宿主的副作用**——
 *    组件不认识 `SessionHub`，也不决定"成功要不要关面板"（那是宿主的策略，见
 *    `ConversationPane.submitFeedback`）。这条边界与 `WorkspaceBrowser` 同一口径。
 *  · 类别取值就是契约给出的那 7 个（`FEEDBACK_CATEGORIES`，不自己发明）。
 *    未选即"未分类"——契约里 `category` 可选，所以**不强迫分类**。
 */

import {
  FEEDBACK_CATEGORIES, Fs, Radius, Sp, Sz,
} from 'appstate';
import type { FeedbackCategory } from 'appstate';
import { NativeChip } from './NativePrimitives';

@Component
export struct MessageFeedback {
  /*
   * 【曾经有一个 `itemId` prop】它随"反馈面板"从宿主搬进来，但**搬过来之后没有一处读它**
   * （E350 的死代码门禁查出来的）：判定与回执都在父组件算好传入，这个 id 只是"跟着搬过来"。
   * 删掉而不是留个 `dead-exempt:`——它连调试价值都没有。
   */
  /** 打开那一刻的已存类别（''=未分类） */
  @Prop initialCategory: string = '';
  /** 打开那一刻的已存说明 */
  @Prop initialNote: string = '';
  /** 宿主回执（空串 = 不显示；失败原因原样透出，见宿主的 `feedbackNoticeText`） */
  @Prop notice: string = '';

  /** 提交：只报"用户选了什么"，调用中枢是宿主的副作用 */
  onSubmit: (category: string, note: string) => void = () => {
  };
  onCancel: () => void = () => {
  };

  @State category: string = '';
  @State note: string = '';

  aboutToAppear(): void {
    this.category = this.initialCategory;
    this.note = this.initialNote;
  }

  build() {
    Column({ space: Sp.XS }) {
      Text('为什么？可留空')
        .fontSize(Fs.CAPTION_XS)
        .fontColor($r('sys.color.font_tertiary'))
        .width('100%')

      Flex({ wrap: FlexWrap.Wrap }) {
        ForEach(FEEDBACK_CATEGORIES, (c: FeedbackCategory) => {
          Row() {
            NativeChip({
              label: c.label,
              active: this.category === c.id,
              a11y: `评价原因：${c.label}`,
              onTap: () => {
                // 再点一次取消选择 ⇒ 回到"未分类"（契约里 category 可选，不强迫分类）
                this.category = this.category === c.id ? '' : c.id;
              }
            })
          }
          .margin({ right: Sp.XS, bottom: Sp.XS })
        }, (c: FeedbackCategory) => c.id)
      }
      .width('100%')

      TextInput({ text: this.note, placeholder: '补充说明（可选）' })
        .fontSize(Fs.CAPTION)
        .height(Sz.TOUCH_MIN)
        .onChange((v: string) => {
          this.note = v;
        })

      if (this.notice.length > 0) {
        Text(this.notice)
          .fontSize(Fs.CAPTION_XS)
          .fontColor($r('sys.color.alert'))
          .width('100%')
      }

      Row({ space: Sp.L }) {
        Text('提交')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.brand'))
          .onClick(() => {
            this.onSubmit(this.category, this.note);
          })
        Text('取消')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .onClick(() => {
            this.onCancel();
          })
        Blank()
      }
      .width('100%')
    }
    .width('100%')
    .padding(Sp.S)
    .borderRadius(Radius.S)
    .backgroundColor($r('sys.color.background_secondary'))
    .accessibilityText('消息反馈：选择原因后可提交，也可留空')
  }
}
