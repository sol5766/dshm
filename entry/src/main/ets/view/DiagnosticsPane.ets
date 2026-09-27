/**
 * 连接诊断页（D1 G7 / §7.8）。
 *
 * 五项判定：端点 / TLS / 认证 / 协议 / Host，另加两项**兼容面自检**：
 *   - 版本判定结论（来自 dshcompat.checkVersion 的三态）
 *   - 当前注入的接口面（用于立刻发现「漏注入 dshcompat」这类装配故障）
 *
 * 每项失败都必须给出**可执行建议**（D3 §4 文案纪律）。
 */

import {
  DiagEntry,
  DiagReport,
  formatClock,
  Fs,
  Radius,
  Sp,
  Sz
} from 'appstate';

@Component
export struct DiagnosticsPane {
  @Prop report: DiagReport = {
    entries: [], healthy: false, generatedAt: 0, versionVerdict: '',
    versionMessage: '', versionAdvice: '', tableStats: '', surface: ''
  };
  @Prop running: boolean = false;
  /**
   * 判定项由宿主按**模式**裁剪后传入（D7 §3 第 4 项）。
   *
   * 为什么不直接用 `report.entries`：本地核心模式下 TLS 与 cookie 认证**不适用**
   * （回环 + `--skip-auth`），把它们列出来只会给诊断页添噪音。
   * 裁剪判据是 appstate 的纯函数 `filterDiagEntries`，本组件不自己判断。
   */
  @Prop entries: DiagEntry[] = [];
  /** 模式化标题与说明（本地核心 / 远程 Host / 未接线） */
  @Prop modeTitle: string = '连接诊断';
  @Prop modeHint: string = '';
  /** 是否允许展示协议旁路日志（默认关闭，D1 §7.8.3） */
  @Prop traceEnabled: boolean = false;
  @Prop traceLines: string[] = [];

  onRerun: () => void = () => {
  };
  onToggleTrace: (on: boolean) => void = () => {
  };
  onExportLog: () => void = () => {
  };
  onClearCache: () => void = () => {
  };
  /**
   * 打开**协议往返验证（POC-1）**（E96）。
   *
   * 【为什么放在这里】用户要求把「连接诊断」与「POC」整合成一个"本地调试"入口：
   * 诊断页给的是**结论**（哪一项没过），POC 给的是**逐步证据**（token→cookie→/api→WS）。
   * 从结论页一键下钻到证据页，才叫整合；否则用户还是要在两个入口之间来回走。
   */
  onOpenPoc: () => void = () => {
  };
  onBack: () => void = () => {
  };

  build() {
    Column() {
      Row({ space: Sp.S }) {
        Button() {
          SymbolGlyph($r('sys.symbol.chevron_left')).fontSize(18)
        }
        .buttonStyle(ButtonStyleMode.TEXTUAL)
        .onClick(() => {
          this.onBack();
        })
        Text(this.modeTitle)
          .fontSize(Fs.TITLE_S)
          .fontWeight(FontWeight.Medium)
          .layoutWeight(1)
        Button(this.running ? '诊断中…' : '重新诊断')
          .buttonStyle(ButtonStyleMode.NORMAL)
          .fontSize(Fs.CAPTION)
          .enabled(!this.running)
          .onClick(() => {
            this.onRerun();
          })
      }
      .width('100%')
      .height(Sz.TOUCH_MIN + 8)
      .padding({ left: Sp.S, right: Sp.M })

      Divider().color($r('sys.color.comp_divider'))

      Scroll() {
        Column({ space: Sp.M }) {
          this.summaryCard()
          this.entriesCard()
          this.compatCard()
          this.traceCard()
          this.actionsCard()
        }
        .width('100%')
        .padding(Sp.M)
      }
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.TopStart)
      .scrollBar(BarState.Auto)
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  summaryCard() {
    Row({ space: Sp.M }) {
      SymbolGlyph(this.report.healthy ? $r('sys.symbol.checkmark_circle') : $r('sys.symbol.exclamationmark_triangle'))
        .fontSize(28)
        .fontColor([this.report.healthy ? $r('sys.color.confirm') : $r('sys.color.alert')])
      Column({ space: 2 }) {
        Text(this.report.healthy ? '连接健康' : '连接存在问题')
          .fontSize(Fs.BODY)
          .fontWeight(FontWeight.Medium)
          .width('100%')
        Text(this.report.generatedAt > 0
          ? `生成于 ${formatClock(this.report.generatedAt)}`
          : '尚未诊断')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')
      }
      .layoutWeight(1)
    }
    .width('100%')
    .padding(Sp.M)
    .borderRadius(Radius.M)
    .backgroundColor($r('sys.color.background_secondary'))
  }

  @Builder
  entriesCard() {
    Column({ space: Sp.S }) {
      ForEach(this.entries, (entry: DiagEntry) => {
        Column({ space: Sp.XS }) {
          Row({ space: Sp.S }) {
            SymbolGlyph(entry.passed ? $r('sys.symbol.checkmark_circle') : $r('sys.symbol.xmark_circle'))
              .fontSize(16)
              .fontColor([entry.passed ? $r('sys.color.confirm') : $r('sys.color.alert')])
            Text(entry.name)
              .fontSize(Fs.SECONDARY)
              .fontWeight(FontWeight.Medium)
              .layoutWeight(1)
            Text(entry.passed ? '通过' : '未通过')
              .fontSize(Fs.CAPTION)
              .fontColor(entry.passed ? $r('sys.color.confirm') : $r('sys.color.alert'))
          }
          .width('100%')

          Text(entry.detail)
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_secondary'))
            .width('100%')

          if (!entry.passed && entry.advice.length > 0) {
            Row({ space: Sp.XS }) {
              Text('建议：')
                .fontSize(Fs.CAPTION)
                .fontColor($r('sys.color.brand'))
              Text(entry.advice)
                .fontSize(Fs.CAPTION)
                .fontColor($r('sys.color.font_secondary'))
                .layoutWeight(1)
            }
            .width('100%')
            .padding(Sp.S)
            .borderRadius(Radius.S)
            .backgroundColor($r('sys.color.background_primary'))
          }
        }
        .width('100%')
        .padding(Sp.M)
        .borderRadius(Radius.M)
        .backgroundColor($r('sys.color.background_secondary'))
      }, (entry: DiagEntry) => entry.name)

      if (this.entries.length === 0) {
        Text(this.modeHint.length > 0 ? this.modeHint : '点「重新诊断」开始五项判定。')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')
          .padding(Sp.M)
      }
    }
    .width('100%')
  }

  /** 兼容面自检（回答「上游升级是否影响了我们」） */
  @Builder
  compatCard() {
    Column({ space: Sp.XS }) {
      Text('兼容面自检')
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_tertiary'))
        .width('100%')

      Row({ space: Sp.S }) {
        Text('版本判定')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_secondary'))
          .layoutWeight(1)
        Text(this.verdictLabel())
          .fontSize(Fs.CAPTION)
          .fontColor(this.verdictColor())
      }
      .width('100%')

      Text(this.report.versionMessage)
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_secondary'))
        .width('100%')

      if (this.report.versionAdvice.length > 0) {
        Text(this.report.versionAdvice)
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.warning'))
          .width('100%')
      }

      Divider().color($r('sys.color.comp_divider'))

      Row({ space: Sp.S }) {
        Text('接口面')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_secondary'))
          .layoutWeight(1)
        Text(this.report.surface)
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .maxLines(1)
      }
      .width('100%')

      Row({ space: Sp.S }) {
        Text('端点上表')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_secondary'))
          .layoutWeight(1)
        Text(this.report.tableStats)
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
      }
      .width('100%')
    }
    .width('100%')
    .padding(Sp.M)
    .borderRadius(Radius.M)
    .backgroundColor($r('sys.color.background_secondary'))
  }

  private verdictLabel(): string {
    if (this.report.versionVerdict === 'supported') {
      return '受支持';
    }
    if (this.report.versionVerdict === 'unverified') {
      return '未验证';
    }
    if (this.report.versionVerdict === 'incompatible') {
      return '不兼容';
    }
    return '未知';
  }

  private verdictColor(): ResourceColor {
    if (this.report.versionVerdict === 'supported') {
      return $r('sys.color.confirm');
    }
    if (this.report.versionVerdict === 'unverified') {
      return $r('sys.color.warning');
    }
    if (this.report.versionVerdict === 'incompatible') {
      return $r('sys.color.alert');
    }
    return $r('sys.color.font_tertiary');
  }

  /** 协议旁路日志（默认关闭；只记录方法名与耗时，不含内容，D1 §7.8.3） */
  @Builder
  traceCard() {
    Column({ space: Sp.S }) {
      Row({ space: Sp.S }) {
        Column({ space: 2 }) {
          Text('协议旁路日志')
            .fontSize(Fs.SECONDARY)
            .width('100%')
          Text('只记录 RPC 方法名与耗时、WS 帧类型与大小，不含消息内容')
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_tertiary'))
            .width('100%')
        }
        .layoutWeight(1)
        Toggle({ type: ToggleType.Switch, isOn: this.traceEnabled })
          .onChange((on: boolean) => {
            this.onToggleTrace(on);
          })
      }
      .width('100%')

      if (this.traceEnabled) {
        Column({ space: 2 }) {
          if (this.traceLines.length === 0) {
            Text('暂无记录。触发一次会话操作后再回来查看。')
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.font_tertiary'))
              .width('100%')
          } else {
            ForEach(this.traceLines, (line: string, index: number) => {
              Text(line)
                .fontSize(Fs.CAPTION_XS)
                .fontFamily('monospace')
                .fontColor($r('sys.color.font_secondary'))
                .width('100%')
            }, (line: string, index: number) => `trace-${index}`)
          }
        }
        .width('100%')
        .padding(Sp.S)
        .borderRadius(Radius.S)
        .backgroundColor($r('sys.color.background_primary'))
        .constraintSize({ maxHeight: 200 })
      }
    }
    .width('100%')
    .padding(Sp.M)
    .borderRadius(Radius.M)
    .backgroundColor($r('sys.color.background_secondary'))
  }

  @Builder
  actionsCard() {
    Column({ space: Sp.S }) {
      Row({ space: Sp.S }) {
        Button('导出日志')
          .buttonStyle(ButtonStyleMode.NORMAL)
          .fontSize(Fs.CAPTION)
          .layoutWeight(1)
          .onClick(() => {
            this.onExportLog();
          })
        Button('清理离线缓存')
          .buttonStyle(ButtonStyleMode.NORMAL)
          .fontSize(Fs.CAPTION)
          .layoutWeight(1)
          .onClick(() => {
            this.onClearCache();
          })
        // 本地调试第二步：从"哪一项没过"下钻到"哪一步错了"（token→cookie→/api→WS 逐步证据）
        Button('协议往返验证')
          .buttonStyle(ButtonStyleMode.NORMAL)
          .fontSize(Fs.CAPTION)
          .layoutWeight(1)
          .onClick(() => {
            this.onOpenPoc();
          })
      }
      .width('100%')

      Text('导出日志已做脱敏处理：不含 token、cookie、设备密钥与消息内容（D1 §11.5 S4）。')
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_tertiary'))
        .width('100%')
    }
    .width('100%')
    .padding(Sp.M)
    .borderRadius(Radius.M)
    .backgroundColor($r('sys.color.background_secondary'))
  }
}
