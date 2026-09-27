/**
 * 本会话模型选择（官方 `dsh-client-ui-model-selection` 的形态，写 `session/selectModel`）。
 *
 * ## 它拥有什么 / 宿主保留什么
 *
 * | 谁 | 负责 |
 * |---|---|
 * | 本组件 | 呈现：标题、未选会话时的如实说明、可选模型列表与当前选中态 |
 * | 宿主 | 动作：选中后要**关掉面板**、调用中枢 `selectSessionModel`、把回执/失败写进提示 |
 *
 * 【为什么动作不在这里】"选中模型"会牵扯面板开关与宿主级提示（`settingWriteNote`），
 * 那是**导航与宿主状态**，不是这个列表框的事。组件只把"选哪一个"交出去（`onPick`），
 * 与 `MainHeaderShell` 把 `showBack`/`showDetailEntry` 交出去是同一条纪律：
 * **呈现归组件，判定与副作用归宿主**。
 *
 * ## 一条如实说明的语义（保留自原实现）
 *
 * 未选会话时**不显示模型列表**，而是说明原因——`session/selectModel` 需要会话作用域，
 * 列一张点了没反应的模型表比不列更糟。
 */

import { Fs, ModelOption, Radius, Sp } from 'appstate';

@Component
export struct SessionModelPicker {
  /** 当前会话 id（空串 = 未选会话） */
  @Prop sessionId: string = '';
  /** 宿主投影好的可选模型 */
  @Prop models: ModelOption[] = [];
  /** 当前选中的模型 id（用于高亮） */
  @Prop currentModelId: string = '';

  onPick: (option: ModelOption) => void = () => {
  };

  build() {
    Column({ space: Sp.XS }) {
      Text('本会话的模型')
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_tertiary'))
        .width('100%')
      if (this.sessionId.length === 0) {
        Text('请先在工作区里选中一个会话，再切换模型。')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')
      } else {
        ForEach(this.models, (m: ModelOption) => {
          Row({ space: Sp.S }) {
            Text(m.modelId)
              .fontSize(Fs.CAPTION)
              .layoutWeight(1)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
            Text(m.provider)
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.font_tertiary'))
          }
          .width('100%')
          .padding(Sp.S)
          .borderRadius(Radius.S)
          .backgroundColor(this.currentModelId === m.modelId
            ? $r('sys.color.background_secondary')
            : $r('sys.color.background_primary'))
          .onClick(() => {
            this.onPick(m);
          })
        }, (m: ModelOption) => m.provider + '/' + m.modelId)
      }
    }
    .width('100%')
  }
}
