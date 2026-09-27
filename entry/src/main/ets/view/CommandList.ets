/**
 * 命令列表（官方 `dsh-client-ui-commands` 的形态）。
 *
 * ## 谁拥有什么
 *
 * | 谁 | 负责 |
 * |---|---|
 * | 本组件 | 呈现：无命令时的**如实说明**、命令行的名字与副标题、可点状态 |
 * | 宿主 | 动作：执行命令（关面板 → `hub.executeCommand` → 把回执/失败写进提示） |
 *
 * 与 `SessionModelPicker` 同一条纪律：**呈现归组件，判定与副作用归宿主**。
 *
 * ## 两种"没有命令"要分开说
 *
 * 原实现（保留）刻意分成两句：未选会话时说"命令取决于具体会话"，已选会话但宿主没报告时
 * 说"宿主没有报告该会话可用的命令（或尚未读取）"。
 * **不把"还没读到"说成"这个会话没有命令"**——那是让人们去排查一个不存在的权限问题。
 */

import { CommandCandidate, Fs, Radius, Sp } from 'appstate';

@Component
export struct CommandList {
  /** 当前会话 id（空串 = 未选会话） */
  @Prop sessionId: string = '';
  /** 宿主报告的可执行命令 */
  @Prop commands: CommandCandidate[] = [];

  onRun: (command: CommandCandidate) => void = () => {
  };

  build() {
    Column({ space: Sp.XS }) {
      if (this.commands.length === 0) {
        Text(this.sessionId.length === 0
          ? '命令取决于具体会话：请先在工作区里选中一个会话。'
          : '宿主没有报告该会话可用的命令（或尚未读取）。')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')
      } else {
        ForEach(this.commands, (c: CommandCandidate) => {
          Column({ space: 2 }) {
            Text(c.name)
              .fontSize(Fs.SECONDARY)
              .width('100%')
            if (c.detail.length > 0 || c.args.length > 0) {
              Text(c.detail.length > 0 ? c.detail : c.args)
                .fontSize(Fs.CAPTION)
                .fontColor($r('sys.color.font_tertiary'))
                .width('100%')
            }
          }
          .width('100%')
          .padding(Sp.M)
          .borderRadius(Radius.S)
          .backgroundColor($r('sys.color.background_secondary'))
          .onClick(() => {
            this.onRun(c);
          })
        }, (c: CommandCandidate) => c.name)
      }
    }
    .width('100%')
  }
}
