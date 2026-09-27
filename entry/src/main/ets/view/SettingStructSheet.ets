/**
 * 结构化设置（数组 / 对象）的**整值**编辑浮层（P2-10：从 `Index.ets` 抽出的第三个浮层组件）。
 *
 * ## 它拥有什么
 *
 * 一个多行 JSON 编辑器：标题、三条说明（逐键合并 / 不提供删键入口 / 上游键名）、
 * 「恢复为当前值 / 取消」、「写入 Host」、「恢复默认（移除这里的设置）」（只对**已被用户覆盖**的项出现）
 * 以及这一层的结果出口（`note`）。
 *
 * ## 四条设计取舍（原文保留在组件旁，改代码前先读）
 *
 * 1. **多行 `TextArea`**：实测 `llm-deepseek.models` 的 JSON 约 820 字符、`providers` 更大；
 *    单行输入框在这里不可用。
 * 2. **打开时美化（缩进 2 空格）**，写回时用紧凑形式：人读写需要缩进，而对 Host 来说空白无意义
 *    ——紧凑形式也能让「值是否变化」的比较不受无关空白干扰。
 * 3. **「恢复为当前值」按钮**：整值编辑最容易出的事故是改坏一个大 JSON 又退不回去。
 * 4. **「恢复默认」必须叫"默认"不叫"清空"**：`unset` 的语义是**回落 schema 默认**，
 *    而"把值设为 null"是另一回事（`null` 在若干 schema 里是合法取值）。两者混为一谈
 *    会让用户以为自己清空了、实际只是回到默认（或反过来）。
 *
 * ## 边界：草稿、回执、写入全在宿主
 *
 * 与 `SettingTextSheet` 相同：草稿留在宿主（它用它判断"浮层是否开着"与返回键优先级）、
 * 回执归属由宿主统一认领（E353）、`settings/mutate` 与 `unset` 都是宿主的副作用。
 */

import { Fs, HarmonySpacing, Radius, Sp } from 'appstate';
import type { SettingItem } from 'appstate';

/** 结构化设置项的整值编辑浮层 */
@Component
export struct SettingStructSheet {
  /** 正在编辑的设置项（`userSet` 决定要不要给"恢复默认"入口） */
  @Prop item: SettingItem;
  /** 标题里的显示名 */
  @Prop label: string = '';
  /** 上游键名（显示用） */
  @Prop settingKey: string = '';
  /** 用户正在编辑的 JSON 文本（真值在宿主） */
  @Prop draft: string = '';
  /** 结果 / 进度文案（空串 = 不显示） */
  @Prop note: string = '';
  /** 这一层的回执是否属于自己（归属标记由宿主统一管，见 E353） */
  @Prop noteOwned: boolean = false;
  /** 写入 / 恢复默认进行中（按钮防重复提交） */
  @Prop busy: boolean = false;
  /** 输入变化（宿主落状态） */
  onDraftChange: (value: string) => void = () => {
  };
  /** 恢复为进入编辑器时的值（宿主从 `item.rawJson` 重新美化） */
  onRestore: () => void = () => {
  };
  /** 提交整值（校验与写入在宿主） */
  onSubmit: () => void = () => {
  };
  /** 恢复默认（`unset`：移除用户层取值，回落 schema 默认） */
  onUnset: () => void = () => {
  };
  /** 关闭 */
  onClose: () => void = () => {
  };

  build() {
    Column() {
      Column({ space: Sp.S }) {
        Text(`编辑「${this.label}」`)
          .fontSize(Fs.BODY)
          .width('100%')
        Text('写回是**逐键合并**：这里没提到的键会保留 Host 上已有的值，不会被删除。')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')
        Text('本客户端暂不提供「删除某个键」的入口（那需要 unset 操作；实测顶层与嵌套路径都可用）。')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')
        Text(`上游设置项 ${this.settingKey}`)
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')

        TextArea({ placeholder: 'JSON', text: this.draft })
          .width('100%')
          .height(320)
          .onChange((v: string) => {
            this.onDraftChange(v);
          })

        Row({ space: Sp.S }) {
          Button('恢复为当前值')
            .layoutWeight(1)
            .backgroundColor($r('sys.color.background_secondary'))
            .fontColor($r('sys.color.font_primary'))
            .onClick(() => {
              this.onRestore();
            })
          Button('取消')
            .layoutWeight(1)
            .backgroundColor($r('sys.color.background_secondary'))
            .fontColor($r('sys.color.font_primary'))
            .onClick(() => {
              this.onClose();
            })
        }
        .width('100%')

        Button('写入 Host')
          .width('100%')
          .enabled(this.draft.length > 0 && !this.busy)
          .onClick(() => {
            this.onSubmit();
          })

        // 只有**已被用户覆盖**的项才显示这个入口：对继承默认的项执行 unset 是无操作，
        // 给它一个按钮等于让用户白点一次。
        if (this.item.userSet) {
          Button('恢复默认（移除这里的设置）')
            .width('100%')
            .enabled(!this.busy)
            .backgroundColor($r('sys.color.background_secondary'))
            .fontColor($r('sys.color.warning'))
            .onClick(() => {
              this.onUnset();
            })
        }

        if (this.noteOwned && this.note.length > 0) {
          Text(this.note)
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_secondary'))
            .width('100%')
        }
      }
      .width('100%')
      .padding(Sp.L)
      .borderRadius(Radius.L)
      .backgroundColor($r('sys.color.background_secondary'))
    }
    .width('100%')
    .padding(HarmonySpacing.CONTAINER)
  }
}
