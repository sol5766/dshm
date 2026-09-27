/**
 * 设置页「技能」分区（P4-5：从 `SettingsPane.build()` 的内联分支拆出的域组件）。
 *
 * ## 它拥有什么
 *
 * 技能清单的**呈现**：读取结论（`note`）、清单卡片（名字 / 提供方 / 说明 / 适用）、
 * 以及"技能由谁提供、端侧只读"的说明行。
 *
 * ## 两条被刻意保留下来的语义
 *
 * 1. **读不到就说读不到**（E135）：`skills/list` 的回复外层键当年没有确证，数据层容忍三种形状；
 *    都不中时宿主把**真实顶层键**记进旁路日志、并把结论放进 `note`。
 *    这里**绝不把"没读出来"渲染成"没有技能"**——那会让人以为宿主没装技能。
 *    故 `note` 非空时**必须显示**，且此时不再补一句"宿主报告没有可用技能"。
 * 2. **端侧只读**：正文与安装都不在这里做（技能由宿主的技能提供方给出），
 *    所以卡片只有展示、没有任何写入入口——不摆点不动的按钮。
 *
 * ## 为什么只有两个入参
 *
 * 这一段没有任何写入动作，也没有组件内状态（无展开、无选中）⇒ 两个 `@Prop` 就是全部依赖。
 * 数据由宿主投影，组件不自己读中枢（对照 `SettingsPresets` 的例外说明）。
 */

import { Fs, Radius, SkillRow, Sp } from 'appstate';

/** 设置页「技能」分区 */
@Component
export struct SettingsSkills {
  /** 技能清单（宿主投影；空数组 + 非空 note = 没读出来，不是"没有"） */
  @Prop skills: SkillRow[] = [];
  /** 读取结论（E135：非空必须显示——旁路日志里的真实顶层键就写在这里） */
  @Prop note: string = '';

  build() {
    Column({ space: Sp.M }) {
      if (this.note.length > 0) {
        Text(this.note)
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_secondary'))
          .width('100%')
          .padding(Sp.M)
          .borderRadius(Radius.M)
          .backgroundColor($r('sys.color.background_secondary'))
      }
      if (this.skills.length === 0) {
        if (this.note.length === 0) {
          Text('宿主报告没有可用技能。')
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_tertiary'))
            .width('100%')
        }
      } else {
        ForEach(this.skills, (s: SkillRow) => {
          Column({ space: 2 }) {
            Row({ space: Sp.S }) {
              Text(s.name)
                .fontSize(Fs.SECONDARY)
                .fontWeight(FontWeight.Medium)
                .layoutWeight(1)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
              if (s.provider.length > 0) {
                Text(s.provider)
                  .fontSize(Fs.CAPTION)
                  .fontColor($r('sys.color.font_tertiary'))
              }
            }
            .width('100%')
            if (s.description.length > 0) {
              Text(s.description)
                .fontSize(Fs.CAPTION)
                .fontColor($r('sys.color.font_secondary'))
                .width('100%')
            }
            if (s.whenToUse.length > 0) {
              Text(`适用：${s.whenToUse}`)
                .fontSize(Fs.CAPTION)
                .fontColor($r('sys.color.font_tertiary'))
                .width('100%')
            }
          }
          .width('100%')
          .padding(Sp.M)
          .borderRadius(Radius.M)
          .backgroundColor($r('sys.color.background_secondary'))
        }, (s: SkillRow) => `${s.provider}/${s.name}`)
      }
      Text('技能由宿主的技能提供方给出（`dsh-skill` / `dsh-skill-filesystem`）；端侧只读展示，不在这里编辑技能正文。')
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_tertiary'))
        .width('100%')
    }
    .width('100%')
  }
}
