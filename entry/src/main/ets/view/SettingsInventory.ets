/**
 * 设置 · 插件清单（P4-2：官方 `settings-plugin-inventory`，**只读**）。
 *
 * ## 为什么它是独立分区而不是插件段的子页签
 *
 * 官方把它作为独立分区；两者回答的问题、承担的风险都不同：
 *   · 插件段 = 我要改什么（写操作，会影响运行）；
 *   · 清单 = 这里到底有什么（查证用，带关键词过滤）。
 * 分开之后"看一眼清单"不必冒误触的风险（P4-1 已把分区拆开，本轮把呈现也拆成组件）。
 *
 * ## 过滤是组件自己的状态
 *
 * 关键词只影响这一页的显示，不是导航状态、也不该让宿主重绘整页 ⇒ 放在组件内的 `@State`。
 */

import { Fs, PluginItem, Radius, Sp } from 'appstate';

@Component
export struct SettingsInventory {
  /** 插件清单（宿主投影后传入；本组件只读） */
  @Prop plugins: PluginItem[] = [];

  /** 关键词（空 = 全部） */
  @State filter: string = '';

  /** 关键词过滤后的清单：名称或 entryId 命中即保留 */
  private filtered(): PluginItem[] {
    const q: string = this.filter.trim().toLowerCase();
    if (q.length === 0) {
      return this.plugins;
    }
    const out: PluginItem[] = [];
    for (let i = 0; i < this.plugins.length; i++) {
      const p: PluginItem = this.plugins[i];
      if (p.moduleName.toLowerCase().includes(q) || p.entryId.toLowerCase().includes(q)) {
        out.push(p);
      }
    }
    return out;
  }

  build() {
    // 【ArkUI 约束】组件的 build() 只能有一个根节点 ⇒ 多段内容包进 Column
    Column({ space: Sp.S }) {
      TextInput({ placeholder: '按名称或 entryId 过滤…' })
        .fontSize(Fs.SECONDARY)
        .height(40)   // token-exempt: 过滤输入框高度（与设置页其它输入一致，未收敛）
        .width('100%')
        .onChange((value: string) => {
          this.filter = value;
        })

      ForEach(this.filtered(), (p: PluginItem) => {
        Row({ space: Sp.M }) {
          Circle({ width: 8, height: 8 })   // token-exempt: 状态点几何（与插件行原样一致，搬迁不改视觉）
            .fill(p.phase === 'active' ? $r('sys.color.confirm') : $r('sys.color.font_tertiary'))
          Column({ space: 2 }) {
            Text(p.moduleName)
              .fontSize(Fs.SECONDARY)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')
            Text(`${p.entryId} · ${p.enabled ? '已启用' : '已禁用'}${p.phase.length > 0 ? ` · ${p.phase}` : ''}`)
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.font_tertiary'))
              .width('100%')
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          .layoutWeight(1)
          if (p.firstParty) {
            Text('第一方')
              .fontSize(Fs.CAPTION_XS)
              .fontColor($r('sys.color.font_tertiary'))
              .padding({ left: 5, right: 5 })   // token-exempt: 徽标药丸内边距
              .borderRadius(5)   // token-exempt: 徽标药丸圆角
              .backgroundColor($r('sys.color.background_primary'))
          }
        }
        .width('100%')
        .padding(Sp.M)
        .borderRadius(Radius.M)
        .backgroundColor($r('sys.color.background_secondary'))
      }, (p: PluginItem) => p.entryId)

      Text('只读清单：这里的行不可点击，改动请切到「配置」。')
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_tertiary'))
        .width('100%')
    }
    .width('100%')
  }
}
