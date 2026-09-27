/**
 * 选项浮层（P2-11：从 `Index.ets` 抽出的第五个浮层组件）。
 *
 * ## 它拥有什么
 *
 * 一个**单选列表**：标题（选哪一项）、上游键名、可滚动的选项列表（当前项高亮 + 「当前」标记）、
 * 「取消」。选中即提交——**没有"确定"按钮**：单选列表里再按一次确认是多余的一道门。
 *
 * ## 为什么用原生 Sheet 的"表面"而不自造居中卡片
 *
 * 原生半模态 Sheet 自己就是表面（遮罩 / 圆角 / 拖拽由系统提供）⇒ 内容只保留
 * 标题 + 列表 + 取消。**此前**这里自造"居中卡片"，而模型目录可能很长：
 * 卡片里放不下就溢出（本仓 E191）。现在列表套 `Scroll`，半模态内可滚动
 * ——这才是原生 Sheet 的正确用法，也是"用系统控件表达层级"这条纪律的具体落点。
 *
 * ## 边界
 *
 * · **选项来源有两种**（Host 设置项的 `choices` 与端侧本机偏好的选项组），
 *   由宿主挑好后传进来；组件不知道它们从哪来；
 * · **提交副作用**（写 Host / 写本机偏好 / 提示文案）在宿主。
 */

import { SettingChoice, Sp } from 'appstate';
import { HarmonyColor, HarmonyRadius, HarmonySpacing, HarmonyType } from 'appstate';
import { NativeButton } from './NativePrimitives';

/** 选项浮层（单选，选中即提交） */
@Component
export struct ChoiceSheet {
  /** 标题里的项名 */
  @Prop label: string = '';
  /** 上游键名（显示用） */
  @Prop settingKey: string = '';
  /** 当前取值（用来高亮与标「当前」） */
  @Prop current: string = '';
  /** 选项（值 + 显示名） */
  @Prop choices: SettingChoice[] = [];
  /** 选中即提交（副作用在宿主） */
  onPick: (value: string) => void = () => {
  };
  /** 取消 */
  onCancel: () => void = () => {
  };

  build() {
    Column({ space: Sp.S }) {
      Text(`选择「${this.label}」`)
        .fontSize(HarmonyType.SUBTITLE.size)
        .fontColor(HarmonyColor.TEXT_PRIMARY)
        .width('100%')
      Text(`上游设置项 ${this.settingKey}`)
        .fontSize(HarmonyType.LABEL.size)
        .fontColor(HarmonyColor.TEXT_TERTIARY)
        .width('100%')
      Scroll() {
        Column({ space: Sp.XS }) {
          ForEach(this.choices, (choice: SettingChoice) => {
            Row({ space: HarmonySpacing.CONTROL_INNER }) {
              Text(choice.label)
                .fontSize(HarmonyType.CAPTION.size)
                .fontColor(choice.value === this.current
                  ? HarmonyColor.BRAND : HarmonyColor.TEXT_PRIMARY)
                .layoutWeight(1)
              if (choice.value === this.current) {
                Text('当前')
                  .fontSize(HarmonyType.LABEL.size)
                  .fontColor(HarmonyColor.BRAND)
              }
            }
            .width('100%')
            .padding(HarmonySpacing.CONTAINER)
            .borderRadius(HarmonyRadius.CONTROL)
            .backgroundColor(choice.value === this.current
              ? HarmonyColor.SURFACE_TERTIARY : HarmonyColor.SURFACE_RAISED)
            .onClick(() => {
              this.onPick(choice.value);
            })
          }, (choice: SettingChoice) => choice.value)
        }
        .width('100%')
      }
      .layoutWeight(1)
      .align(Alignment.Top)

      NativeButton({
        label: '取消',
        emphasis: 'tonal',
        tone: 'neutral',
        a11y: '取消选择',
        onTap: () => {
          this.onCancel();
        }
      })
    }
    .width('100%')
    .height('100%')
    .padding(HarmonySpacing.CONTAINER)
  }
}
