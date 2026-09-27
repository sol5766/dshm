/**
 * 设置页「核心」分区（P4-6：从 `SettingsPane.build()` 的内联分支拆出的域组件）。
 *
 * ## 它拥有什么
 *
 * 官方「核心」那一页的内容：版本切换 / 回滚、运行时事实、插件行启停，
 * 以及两块**结果提示**——核心操作的一次性提示（`notice`）和插件区的结果提示（`pluginNotice`）。
 *
 * ## 为什么这一层还要有（不直接把 `CorePane` 挂在设置页上）
 *
 * `CorePane` 是**核心能力本身**的呈现（它也被诊断/其它入口需要），而"核心提示条"
 * 属于**设置页这一段的排版**：提示要贴在内容上方、用设置页的语义色与间距。
 * 两者职责不同 ⇒ 这一层是"设置分区的外壳"，不是 `CorePane` 的复制。
 *
 * ## 一条历史教训仍然留在这里（E118）
 *
 * 这一段曾经由宿主用 `@BuilderParam` 注入 `coreSlot`，真机上点开「核心」分区**直接 JS 崩溃**
 * （`AppKillReporter: reason: JsError`）。现在改成**显式属性**：`CorePane` 需要的 5 个回调与
 * 3 个事实全走 props，数据流一眼能看完，也不依赖"父 Builder 在子组件里被调用"这条易踩坑的机制。
 * 所以这个组件**不是多余的转发层**——它是那次崩溃的修复形态。
 */

import { CoreViewState, emptyCoreView, Fs, Radius, Sp } from 'appstate';
import { CorePane } from './CorePane';

/** 设置页「核心」分区 */
@Component
export struct SettingsCore {
  /** 核心页的呈现模型（状态 / 事实 / 版本 / 插件行） */
  @Prop view: CoreViewState = emptyCoreView();
  /** 核心操作的一次性提示（宿主维护；空串不占位置） */
  @Prop notice: string = '';
  /** 插件行操作的结果提示（`CorePane` 内部会显示，这里只转达） */
  @Prop pluginNotice: string = '';
  /** 核心动作（未实现的动作由宿主给出如实提示，不在这里编造） */
  onAction: (id: string) => void = () => {
  };
  /** 选一个版本作为切换目标 */
  onSelectVersion: (version: string) => void = () => {
  };
  /** 启停某一行（端侧只能启停随核心包发版的行，见 `CorePane` 的说明） */
  onTogglePlugin: (id: string, disabled: boolean) => void = () => {
  };
  /** 恢复默认：清空用户启停 */
  onResetPluginRows: () => void = () => {
  };

  build() {
    Column({ space: Sp.S }) {
      if (this.notice.length > 0) {
        Text(this.notice)
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_secondary'))
          .width('100%')
          .padding(Sp.S)
          .borderRadius(Radius.S)
          .backgroundColor($r('sys.color.background_secondary'))
      }
      CorePane({
        view: this.view,
        onAction: (id: string) => {
          this.onAction(id);
        },
        onSelectVersion: (version: string) => {
          this.onSelectVersion(version);
        },
        onTogglePlugin: (id: string, disabled: boolean) => {
          this.onTogglePlugin(id, disabled);
        },
        onResetPluginRows: () => {
          this.onResetPluginRows();
        },
        pluginNotice: this.pluginNotice
      })
    }
    .width('100%')
  }
}
