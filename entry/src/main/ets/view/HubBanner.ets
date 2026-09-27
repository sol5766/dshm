/**
 * Host 连接横幅（断连/降级时出现）。
 *
 * ## 它拥有什么
 *
 * 连接态的**呈现与两个动作入口**：错误原因、`Host … · 连接 … · 逻辑流 …` 一行事实、
 * **重连**、**诊断**，以及协议旁路日志的尾部。
 *
 * ## 两条被保留下来的语义（不是装饰）
 *
 * 1. **重连只在确实可以重试时出现**：`idle` 是"还没配置过 Host"，此时该做的是"添加 Host"
 *    而不是重连——否则按钮点了必然失败。故按钮以 `phase === DEGRADED` 为条件。
 *    （D3 §4 把"手动重连"列为断连横幅的**必需**动作：自动重试有终点，
 *    没有手动入口时，用户在"Host 刚重启、网络刚恢复"这类可恢复场景下只能重启应用。）
 * 2. **保留协议旁路日志尾部**：把"连上了但列表为空"这类无法从界面区分的症状变成可读的原始轨迹（D3 §7.8）。
 *
 * ## 分工
 *
 * 与其它面板同一条纪律：**呈现归组件，判定与副作用归宿主**——
 * `phase` / 错误文本 / 事实行 / 日志尾部都是宿主给的事实；
 * "重连"直接调中枢（它本就是中枢自己的动作，没有宿主级状态牵连）；
 * "诊断"走宿主的 `onOpenDiagnostics`（那是一次导航）。
 */

import { Fs, HarmonyIconSize, HubPhase, SessionHub, Sp } from 'appstate';

@Component
export struct HubBanner {
  /** 错误原因（宿主投影好的文案） */
  @Prop errorText: string = '';
  /** 当前 Host 授权名（空串 = 未配置） */
  @Prop authority: string = '';
  /** 连接阶段（决定"重连"是否出现）；用枚举而不是 string —— 比较才不会被判"无重叠" */
  @Prop phase: HubPhase = HubPhase.IDLE;
  /** 逻辑流数量（事实行的一部分；宿主里是 number） */
  @Prop streams: number = 0;
  /** 协议旁路日志尾部（可为空数组） */
  @Prop traceTail: string[] = [];

  onOpenDiagnostics: () => void = () => {
  };

  build() {
    Column({ space: Sp.XS }) {
      Row({ space: Sp.S }) {
        SymbolGlyph($r('sys.symbol.exclamationmark_triangle'))
          .fontSize(HarmonyIconSize.STATUS)
          .fontColor([$r('sys.color.warning')])
        Column({ space: 2 }) {
          Text(this.errorText)
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_primary'))
            .width('100%')
          Text(`Host ${this.authority.length > 0 ? this.authority : '未配置'} · 连接 ${this.phase} · 逻辑流 ${this.streams}`)
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_tertiary'))
            .width('100%')
        }
        .layoutWeight(1)

        // 只在确实可以重试时显示（见文件头第 1 条）
        if (this.phase === HubPhase.DEGRADED) {
          Text('重连')
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.brand'))
            .onClick(() => {
              // 重连是中枢自己的动作，不牵扯宿主状态 ⇒ 不经宿主
              SessionHub.shared().reconnect();
            })
        }
        Text('诊断')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.brand'))
          .onClick(() => {
            this.onOpenDiagnostics();
          })
      }
      .width('100%')

      ForEach(this.traceTail, (line: string) => {
        Text(line)
          .fontSize(Fs.CAPTION_XS)
          .fontFamily('monospace')
          .fontColor($r('sys.color.font_tertiary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
      }, (line: string) => line)
    }
    .width('100%')
    .padding(Sp.S)
    .backgroundColor($r('sys.color.background_secondary'))
  }
}
