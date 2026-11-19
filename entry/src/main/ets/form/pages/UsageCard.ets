/**
 * DSHM 桌面卡片（ArkTS 动态卡片，2026-10-17，docs/178）。
 *
 * 显示：当前会话（标题/状态/第几步）+ 账户余额（可用时）+ 四档 token 用量**条形图**
 * （今天 / 近5小时 / 近7天 / 近30天）。数据由 FormExtensionAbility 从 card-state.json 读取
 * 并通过 formBindingData 注入（key 与下方 @LocalStorageProp 一一对应，见 ../CardState.ets）。
 *
 * 视觉：白底（浅绿→白的极淡渐变）+ 青绿强调色 + 深色文字；不再用纯黑背景。
 * 更新：form_config 关闭系统定时刷新（updateEnabled=false）——**只在 DSHM 主应用运行时**
 * 由 CardStateWatcher 推送更新；应用不运行 ⇒ 卡片保持最后一次数据、完全停止更新。
 */
let storage: LocalStorage = new LocalStorage();

@Entry(storage)
@Component
struct UsageCard {
  @LocalStorageProp('sessionTitle') sessionTitle: string = '暂无会话';
  @LocalStorageProp('sessionId') sessionId: string = '';
  @LocalStorageProp('sessionStateText') sessionStateText: string = '空闲';
  @LocalStorageProp('sessionProgress') sessionProgress: string = '';
  @LocalStorageProp('useBalance') useBalance: boolean = false;
  @LocalStorageProp('balanceText') balanceText: string = '';
  @LocalStorageProp('usageToday') usageToday: string = '0';
  @LocalStorageProp('usage5h') usage5h: string = '0';
  @LocalStorageProp('usage7d') usage7d: string = '0';
  @LocalStorageProp('usage30d') usage30d: string = '0';
  @LocalStorageProp('updatedText') updatedText: string = '等待数据';

  /** 四档里的最大值（图表归一化基准；全 0 时按 1 防除零）。 */
  private usageMax(): number {
    return Math.max(this.usageNumber(this.usageToday), this.usageNumber(this.usage5h),
      this.usageNumber(this.usage7d), this.usageNumber(this.usage30d), 1);
  }

  /** 卡片数据跨进程是字符串；非法值按 0。 */
  private usageNumber(value: string): number {
    const n: number = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** 条形宽度：至少 4% 保证有数据的档位可见。 */
  private barWidth(value: number): string {
    if (!Number.isFinite(value) || value <= 0) {
      return '0%';
    }
    const pct: number = Math.min(100, Math.max(4, Math.round(value / this.usageMax() * 100)));
    return pct + '%';
  }

  /** token 数压缩显示：1234 → 1.2k，123456 → 12.3w。 */
  private fmt(value: number): string {
    if (!Number.isFinite(value) || value <= 0) {
      return '0';
    }
    if (value >= 10000) {
      return (value / 10000).toFixed(1) + 'w';
    }
    if (value >= 1000) {
      return (value / 1000).toFixed(1) + 'k';
    }
    return String(Math.round(value));
  }

  @Builder
  usageBar(label: string, value: number) {
    Row({ space: 6 }) {
      Text(label)
        .width(28)
        .fontSize(9)
        .fontColor('#6B7280')
      Stack({ alignContent: Alignment.Start }) {
        Row()
          .width('100%')
          .height(6)
          .borderRadius(3)
          .backgroundColor('#EEF2F1')
        Row()
          .width(this.barWidth(value))
          .height(6)
          .borderRadius(3)
          .backgroundColor('#2FB98A')
      }
      .layoutWeight(1)
      .height(6)
      Text(this.fmt(value))
        .width(40)
        .textAlign(TextAlign.End)
        .fontSize(9)
        .fontColor('#111827')
    }
    .width('100%')
    .height(14)
  }

  build() {
    Column({ space: 4 }) {
      Row() {
        Row()
          .width(4)
          .height(14)
          .borderRadius(2)
          .backgroundColor('#2FB98A')
        Text('DSHM')
          .fontSize(13)
          .fontWeight(FontWeight.Bold)
          .fontColor('#111827')
          .margin({ left: 6 })
        Blank()
        Text(this.sessionStateText)
          .fontSize(10)
          .fontColor(this.sessionStateText === '执行中' ? '#0E9F6E' : '#6B7280')
          .backgroundColor(this.sessionStateText === '执行中' ? '#E6F7F0' : '#F2F4F7')
          .borderRadius(8)
          .padding({ left: 6, right: 6, top: 1, bottom: 1 })
      }
      .width('100%')

      Row({ space: 6 }) {
        Text(this.sessionTitle)
          .fontSize(12)
          .fontColor('#1F2937')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        if (this.sessionProgress.length > 0) {
          Text(this.sessionProgress)
            .fontSize(9)
            .fontColor('#0E9F6E')
        }
      }
      .width('100%')

      if (this.useBalance) {
        Text(this.balanceText)
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .fontColor('#111827')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
      }

      Divider().color('#E5E7EB')

      this.usageBar('今日', this.usageNumber(this.usageToday))
      this.usageBar('5h', this.usageNumber(this.usage5h))
      this.usageBar('7天', this.usageNumber(this.usage7d))
      this.usageBar('30天', this.usageNumber(this.usage30d))

      Text(this.updatedText)
        .fontSize(9)
        .fontColor('#9CA3AF')
        .width('100%')
    }
    .width('100%')
    .height('100%')
    .padding(12)
    .borderRadius(16)
    .backgroundColor('#FFFFFF')
    .linearGradient({
      angle: 160,
      colors: [['#FFFFFF', 0.0], ['#F4FAF7', 1.0]]
    })
    .onClick(() => {
      postCardAction(this, {
        action: 'router',
        abilityName: 'EntryAbility',
        params: {
          dshAction: 'open-session',
          dshSessionId: this.sessionId,
          dshTitle: this.sessionTitle
        }
      });
    })
  }
}
