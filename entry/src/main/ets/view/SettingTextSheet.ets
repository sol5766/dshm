/**
 * 文本 / 数字设置项的编辑浮层（P2-10：从 `Index.ets` 抽出的第二个浮层组件）。
 *
 * ## 它拥有什么
 *
 * 一个"改一项 Host 设置"的**小表单**：标题、约束说明（`hint`）、上游键名、输入框、
 * 「取消 / 写入 Host」两个按钮、以及这一层自己的结果出口（`note`）。
 *
 * ## 边界：草稿与回执仍在宿主
 *
 * · **草稿**（`draft`）留在宿主：宿主用它判断"浮层是否开着"（`overlayState.settingDraftOpen`）
 *   与返回键优先级，而那是**宿主才是唯一知道**的导航事实；
 * · **回执**（`note`）与**归属**（`owner`）也留在宿主：`owner` 是三个浮层共用的
 *   归属标记（见 E353），由宿主统一认领/交还；
 * · **提交副作用**（校验、`settings/mutate`、成功才关面板）全在宿主。
 *
 * 组件只负责"这一层长什么样 + 用户改了什么"。这条边界与 `MessageRow` / `TurnView`
 * 一脉相承：**跨层的状态留在父组件，层内的呈现留在组件里**。
 */

import { Fs, Radius, SettingValueType, Sp } from 'appstate';
import type { SettingItem } from 'appstate';
import { HarmonySpacing } from 'appstate';
import type { EditorHints } from 'appstate';
import { textSettingEditorHints } from 'appstate';

/** 文本 / 数字设置项的编辑浮层 */
@Component
export struct SettingTextSheet {
  /**
   * 正在编辑的设置项（约束与当前值都从它来）。
   *
   * 【为什么可空】宿主只有在真的在编辑时才渲染本组件（`sheetKind()` 会先返回 'text'）。
   * 把"没在编辑"也做成必填会逼宿主造一个 20 个字段的占位项——那份占位值一旦
   * 与 `SettingItem` 的真实形状漂移（本仓已有 20 个字段），就是一个静默的坑。
   * 可空 + 早返回是诚实的写法：没有项可编，就什么都不画。
   */
  @Prop item: SettingItem | undefined = undefined;
  /** 标题里的显示名 */
  @Prop label: string = '';
  /** 用户正在编辑的文本（真值在宿主） */
  @Prop draft: string = '';
  /** 结果 / 进度文案（空串 = 不显示） */
  @Prop note: string = '';
  /** 这一层的回执是否属于自己（归属标记由宿主统一管，见 E353） */
  @Prop noteOwned: boolean = false;
  /** 写入进行中（按钮防重复提交） */
  @Prop busy: boolean = false;
  /** 输入变化（宿主落状态） */
  onDraftChange: (value: string) => void = () => {
  };
  /** 提交（校验与写入在宿主） */
  onSubmit: () => void = () => {
  };
  /** 关闭 */
  onClose: () => void = () => {
  };

  /** 约束说明与占位（判定在 `SettingEditors`，纯模型、有 fixture） */
  /**
   * 约束说明与占位（判定在 `SettingEditors`，纯模型、有 fixture）。
   *
   * 【为什么在这里调两次而不是缓存】ArkUI 的组件体每次渲染都会重跑，而 `@State` 缓存
   * 就得跟着 `item` 变化走（多一份要维护的同步）。两次纯函数调用的代价可以忽略，
   * 换来的是一处真值、零同步。
   */
  private hints(): EditorHints {
    const it: SettingItem = this.item as SettingItem;
    return textSettingEditorHints(
      it.valueType === SettingValueType.NUMBER,
      it.hasMin, it.minValue, it.hasMax, it.maxValue, it.stepValue, it.pattern, it.required,
      it.textValue);
  }

  build() {
    if (this.item !== undefined) {
      Column() {
        Column({ space: Sp.S }) {
            Text(`编辑「${this.label}」`)
            .fontSize(Fs.BODY)
            .width('100%')
          Text(this.hints().hint)
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_tertiary'))
            .width('100%')
          Text(`上游设置项 ${this.item.key}`)
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_tertiary'))
            .width('100%')

          TextInput({ placeholder: this.hints().placeholder, text: this.draft })
            .type(InputType.Normal)
            .width('100%')
            .onChange((v: string) => {
              this.onDraftChange(v);
            })

          Row({ space: Sp.S }) {
            Button('取消')
              .layoutWeight(1)
              .backgroundColor($r('sys.color.background_secondary'))
              .fontColor($r('sys.color.font_primary'))
              .onClick(() => {
                this.onClose();
              })
            Button('写入 Host')
              .layoutWeight(1)
              .enabled(this.draft.length > 0 && !this.busy)
              .onClick(() => {
                this.onSubmit();
              })
          }
          .width('100%')

          if (this.noteOwned && this.note.length > 0) {
            Text(this.note)
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.font_secondary'))
              .width('100%')
          }
        }
        .width('86%')
        .padding(Sp.L)
        .borderRadius(Radius.L)
        .backgroundColor($r('sys.color.background_secondary'))
      }
      .width('100%')
      .padding(HarmonySpacing.CONTAINER)
      }
    }
}
