/**
 * 添加 Host / 授权 / 配对页（D1 §7.1，D3 §4「未配对」引导）。
 *
 * 三种添加方式（对应 D1 7.1.1）：
 *   ① 粘贴启动 URL（含 `?token=`）—— 最快路径，同时完成授权；
 *   ② 手输 host:port + token；
 *   ③ 局域网自动发现（P1；当前为入口 + 说明）。
 *
 * 安全提示是本页的**必要内容**而非装饰（D1 §6.4）：
 *   不绑定 0.0.0.0、不伪造 Host 头，跨设备访问应走加密隧道。
 */

import { Fs, HostRecord, Radius, Sp, Sz } from 'appstate';

@Component
export struct ConnectPane {
  @Prop hosts: HostRecord[] = [];
  @Prop address: string = '';
  @Prop token: string = '';
  @Prop busy: boolean = false;
  /** 最近一次操作的结论（成功或失败都要说明"可以做什么"） */
  @Prop resultText: string = '';
  @Prop resultOk: boolean = false;
  @Prop resultAdvice: string = '';
  /** 自动发现是否可用（Host 侧需运行搭桥服务，D1 §6.5） */
  @Prop discoveryAvailable: boolean = false;

  onAddressChange: (v: string) => void = () => {
  };
  onTokenChange: (v: string) => void = () => {
  };
  /** 认证并保存 */
  onSubmit: () => void = () => {
  };
  /*
   * E130/E144：`onSelectHost` / `onRemoveHost` 已删除。
   * 它们对应的「使用 / 移除」控件在 E130 就被移除了——本应用**只记一个 Host**，
   * "使用某一个 / 移除某一个"没有对应动作。留着这两个 prop 只会让下一个读代码的人
   * 以为存在多 Host 管理（而且扫描器会一直把它们报成"空实现"）。
   */
  onStartDiscovery: () => void = () => {
  };
  onOpenDiagnostics: () => void = () => {
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
        Text('远程 Host（可选）')
          .fontSize(Fs.TITLE_S)
          .fontWeight(FontWeight.Medium)
          .layoutWeight(1)
      }
      .width('100%')
      .height(Sz.TOUCH_MIN + 8)
      .padding({ left: Sp.S, right: Sp.M })

      Divider().color($r('sys.color.comp_divider'))

      Scroll() {
        Column({ space: Sp.M }) {
          this.urlCard()
          this.manualCard()
          this.discoveryCard()
          this.securityCard()
          this.existingCard()
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

  // ───────────── ① 粘贴启动 URL ─────────────

  @Builder
  urlCard() {
    Column({ space: Sp.S }) {
      Text('① 粘贴启动 URL（推荐）')
        .fontSize(Fs.SECONDARY)
        .fontWeight(FontWeight.Medium)
        .width('100%')
      Text('在 Host 上运行 dsh web 后，它会打印一行形如 http://127.0.0.1:3111/?token=xxxx 的地址。整段粘贴到这里即可同时完成地址配置与授权。')
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_tertiary'))
        .width('100%')

      TextInput({ text: this.address, placeholder: 'http://127.0.0.1:3111/?token=xxxx' })
        .onChange((v: string) => {
          this.onAddressChange(v);
        })
        .width('100%')
        .accessibilityText('Host 启动 URL')

      Button(this.busy ? '正在连接…' : '连接并授权')
        .width('100%')
        .enabled(!this.busy && this.address.trim().length > 0)
        .onClick(() => {
          this.onSubmit();
        })

      if (this.resultText.length > 0) {
        this.resultBlock()
      }
    }
    .width('100%')
    .padding(Sp.M)
    .borderRadius(Radius.M)
    .backgroundColor($r('sys.color.background_secondary'))
  }

  // ───────────── ② 手输地址 + token ─────────────

  @Builder
  manualCard() {
    Column({ space: Sp.S }) {
      Text('② 分别填写地址与 token')
        .fontSize(Fs.SECONDARY)
        .fontWeight(FontWeight.Medium)
        .width('100%')
      Text('适用于地址已单独保存、或 token 需要单独复制粘贴的情况。token 每个进程只生成一次，重启 Host 后需要重新获取。')
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_tertiary'))
        .width('100%')

      TextInput({ text: this.token, placeholder: 'token' })
        .onChange((v: string) => {
          this.onTokenChange(v);
        })
        .width('100%')
        .accessibilityText('访问 token')
    }
    .width('100%')
    .padding(Sp.M)
    .borderRadius(Radius.M)
    .backgroundColor($r('sys.color.background_secondary'))
  }

  @Builder
  resultBlock() {
    Column({ space: Sp.XS }) {
      Row({ space: Sp.S }) {
        SymbolGlyph(this.resultOk ? $r('sys.symbol.checkmark_circle') : $r('sys.symbol.xmark_circle'))
          .fontSize(16)
          .fontColor([this.resultOk ? $r('sys.color.confirm') : $r('sys.color.alert')])
        Text(this.resultText)
          .fontSize(Fs.CAPTION)
          .fontColor(this.resultOk ? $r('sys.color.confirm') : $r('sys.color.alert'))
          .layoutWeight(1)
      }
      .width('100%')

      if (this.resultAdvice.length > 0) {
        Text(this.resultAdvice)
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_secondary'))
          .width('100%')
      }

      if (!this.resultOk) {
        Text('打开连接诊断')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.brand'))
          .onClick(() => {
            this.onOpenDiagnostics();
          })
      }
    }
    .width('100%')
    .padding(Sp.S)
    .borderRadius(Radius.S)
    .backgroundColor($r('sys.color.background_primary'))
  }

  // ───────────── ③ 局域网发现 ─────────────

  @Builder
  discoveryCard() {
    Column({ space: Sp.S }) {
      Text('③ 局域网自动发现')
        .fontSize(Fs.SECONDARY)
        .fontWeight(FontWeight.Medium)
        .width('100%')
      Text(this.discoveryAvailable
        ? '在局域网内查找已启用搭桥服务的 Host，找到后一键配对。'
        : '需要 Host 侧运行搭桥服务（hostkit）才会广播可配对的 Host。当前未检测到可用发现源。')
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_tertiary'))
        .width('100%')

      Button(this.discoveryAvailable ? '开始发现' : '发现不可用')
        .width('100%')
        .enabled(this.discoveryAvailable && !this.busy)
        .onClick(() => {
          this.onStartDiscovery();
        })
    }
    .width('100%')
    .padding(Sp.M)
    .borderRadius(Radius.M)
    .backgroundColor($r('sys.color.background_secondary'))
  }

  // ───────────── 安全提示（本项目红线） ─────────────

  @Builder
  securityCard() {
    Column({ space: Sp.XS }) {
      Row({ space: Sp.S }) {
        SymbolGlyph($r('sys.symbol.exclamationmark_triangle'))
          .fontSize(16)
          .fontColor([$r('sys.color.warning')])
        Text('关于跨设备访问')
          .fontSize(Fs.SECONDARY)
          .fontWeight(FontWeight.Medium)
          .layoutWeight(1)
      }
      .width('100%')

      Text('dsh 默认只监听 loopback，并且会拒绝非 loopback 的 Host 头（返回 403）。本客户端不会通过「绑定 0.0.0.0」或「伪造 Host 头」来绕过这一限制。')
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_secondary'))
        .width('100%')

      Text('因此手机连 PC 时应使用加密隧道：隧道出口在 Host 的 loopback 上，安全语义与在本机使用一致。')
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_secondary'))
        .width('100%')

      Text('接入级别说明')
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_tertiary'))
        .width('100%')
      Text('L0 · 直连 loopback：Host 与客户端同机，无新增暴露面\nL1 · 加密隧道：局域网内配对后经隧道访问，未配对设备一律拒绝')
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_tertiary'))
        .width('100%')
    }
    .width('100%')
    .padding(Sp.M)
    .borderRadius(Radius.M)
    .backgroundColor($r('sys.color.background_secondary'))
  }

  // ───────────── 已配置的 Host ─────────────

  @Builder
  existingCard() {
    Column({ space: Sp.S }) {
      Text(`已配置 ${this.hosts.length} 个 Host`)
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_tertiary'))
        .width('100%')

      ForEach(this.hosts, (h: HostRecord) => {
        Row({ space: Sp.M }) {
          Circle({ width: 8, height: 8 })
            .fill(h.authorized ? $r('sys.color.confirm') : $r('sys.color.warning'))
          Column({ space: 2 }) {
            Text(h.name)
              .fontSize(Fs.SECONDARY)
              .width('100%')
            Text(`${h.authority} · ${h.level}`)
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.font_tertiary'))
              .width('100%')
          }
          .layoutWeight(1)
          /*
           * 【E130：这里原本是「使用」与「移除」两个**死按钮】**（父组件的实现是空的）。
           * 根因不是"没实现"，而是**承诺了不存在的能力**：DSHM 只记一个 Host
           * （`hosts` 由单一 `rememberedUrl` 投影而来），没有"多 Host 管理"这件事——
           * 所以"使用某一个"与"移除某一个"都没有对应动作。
           * 保留的是**真能做的事**：用当前地址重新接入（走同一条 `onSubmit` 通道）。
           */
          Text('重新接入')
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.brand'))
            .onClick(() => {
              this.onSubmit();
            })
        }
        .width('100%')
        .padding(Sp.M)
        .borderRadius(Radius.S)
        .backgroundColor($r('sys.color.background_primary'))
      }, (h: HostRecord) => h.id)

      if (this.hosts.length === 0) {
        Text('还没有配置任何 Host。用上面的任一方式添加后即可开始使用。')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')
          .padding(Sp.M)
          .borderRadius(Radius.S)
          .backgroundColor($r('sys.color.background_primary'))
      }
    }
    .width('100%')
    .padding(Sp.M)
    .borderRadius(Radius.M)
    .backgroundColor($r('sys.color.background_secondary'))
  }
}
