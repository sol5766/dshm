/**
 * 设置 · 用量统计（docs/178 配套）：把桌面卡片用的同一份
 * `<filesDir>/dsh/home/card-state.json` 里的四档 token 用量显示在应用内。
 *
 * 为什么读文件而不是再发 RPC：卡片的数据源就是宿主写出的这份文件（Host 已按
 * session/event 的 assistant/message.usage 聚合好 today/last5h/last7d/last30d），
 * 应用内再走一条 RPC 只会多一条需要维护的通道。刷新按钮只重读文件，不发网络请求。
 */
import { common } from '@kit.AbilityKit';
import { Fs, Radius, Sp } from 'appstate';
import { CardState, emptyCardState, readCardState } from '../form/CardState';

/** token 数压缩显示：1234 → 1.2k，123456 → 12.3w。 */
function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) {
    return '0';
  }
  if (n >= 10000) {
    return (n / 10000).toFixed(1) + 'w';
  }
  if (n >= 1000) {
    return (n / 1000).toFixed(1) + 'k';
  }
  return String(Math.round(n));
}

@Component
export struct SettingsUsage {
  @State state: CardState = emptyCardState();

  aboutToAppear(): void {
    this.load();
  }

  private load(): void {
    try {
      const ctx = getContext() as common.UIAbilityContext;
      this.state = readCardState(ctx.filesDir);
    } catch (e) {
      this.state = emptyCardState();
    }
  }

  @Builder
  private usageRow(label: string, value: number) {
    Row() {
      Text(label)
        .fontSize(Fs.BODY)
        .fontColor($r('sys.color.font_primary'))
      Blank()
      Text(fmtTokens(value) + ' tokens')
        .fontSize(Fs.BODY)
        .fontColor($r('sys.color.font_secondary'))
    }
    .width('100%')
    .padding({ top: Sp.XS, bottom: Sp.XS })
  }

  build() {
    Column({ space: Sp.XS }) {
      Row() {
        Text('用量统计')
          .fontSize(Fs.BODY)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.font_primary'))
        Blank()
        Text('刷新')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.brand'))
          .onClick((): void => this.load())
      }
      .width('100%')

      Text('与桌面卡片同一数据源：模型账户的 token 用量（今天 / 近5小时 / 近7天 / 近30天）')
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_tertiary'))
        .width('100%')

      this.usageRow('今天', this.state.usage.today)
      this.usageRow('近 5 小时', this.state.usage.last5h)
      this.usageRow('近 7 天', this.state.usage.last7d)
      this.usageRow('近 30 天', this.state.usage.last30d)
    }
    .width('100%')
    .padding({ left: Sp.M, right: Sp.M, top: Sp.S, bottom: Sp.S })
    .borderRadius(Radius.M)
    .backgroundColor($r('sys.color.comp_background_list_card'))
  }
}
