/**
 * 设置 · 设备（P4-4：从 `SettingsPane` 拆出的第三个域组件）。
 *
 * ## 这一个域回答什么
 *
 * 本仓特有的设置段（官方没有对应分区，矩阵里以 `dshm-*` 与"设备事实"登记）：
 * **已记住的 Host 列表**（成对/撤销）与**关于本机**（版本、构建、平台等只读事实）。
 * 它与"通用"分开，是因为前者讲"这个应用怎么工作"，这里讲"这台设备/这条连接是什么"。
 *
 * ## 边界
 *
 * 数据（`about` / `hosts`）由宿主给；**成对与撤销是副作用**（要拿平台能力与中枢），
 * 由回调交回宿主。
 */
import { Fs, HostRecord, Radius, Sp } from 'appstate';
import type { AboutInfo } from 'appstate';

@Component
export struct SettingsDevice {

  /** 关于本机（只读事实） */
  @Prop about: AboutInfo;
  /** 已记住的 Host */
  @Prop hosts: HostRecord[] = [];

  /** 与某个 Host 成对（重新认证；不需要参数——宿主自己知道当前待成对的是哪一个） */
  onPairHost: () => void = () => {
  };
  /** 撤销某个 Host 的信任（只传 id：撤销是"删掉这条记录"，不需要整行） */
  onRevokeHost: (id: string) => void = () => {
  };

  // 【ArkUI 约束】组件的 build() 只能有一个根节点 ⇒ 多段内容包进 Column
  build() {
    Column({ space: Sp.L }) {
          Row({ space: Sp.S }) {
            Text('已配置 Host')
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.font_tertiary'))
              .layoutWeight(1)
            // 措辞刻意写全「远程」：端侧自足运行后，本机核心是默认路径，
            // 连别人的 Host 是**可选能力**，不是"添加 Host 才能用"（D7 §3）
            Text('远程 Host（可选）')
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.brand'))
              .onClick(() => {
                this.onPairHost();
              })
          }
          .width('100%')

          ForEach(this.hosts, (h: HostRecord) => {
            Column({ space: Sp.XS }) {
              Row({ space: Sp.S }) {
                Circle({ width: 8, height: 8 })
                  .fill(h.authorized ? $r('sys.color.confirm') : $r('sys.color.warning'))
                Text(h.name)
                  .fontSize(Fs.BODY)
                  .layoutWeight(1)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                Text(h.authorized ? '已授权' : '未授权')
                  .fontSize(Fs.CAPTION)
                  .fontColor(h.authorized ? $r('sys.color.confirm') : $r('sys.color.warning'))
              }
              .width('100%')

              Text(`${h.authority} · ${h.level}`)
                .fontSize(Fs.CAPTION)
                .fontColor($r('sys.color.font_secondary'))
                .width('100%')
              Text(`核心包版本 ${h.version.length > 0 ? h.version : '未知'}`)
                .fontSize(Fs.CAPTION)
                .fontColor($r('sys.color.font_tertiary'))
                .width('100%')

              if (!h.isLoopback) {
                Row({ space: Sp.L }) {
                  Text('忘记此 Host')
                    .fontSize(Fs.CAPTION)
                    .fontColor($r('sys.color.alert'))
                    .onClick(() => {
                      this.onRevokeHost(h.id);
                    })
                }
                .width('100%')
              }
            }
            .width('100%')
            .padding(Sp.M)
            .borderRadius(Radius.M)
            .backgroundColor($r('sys.color.background_secondary'))
          }, (h: HostRecord) => h.id)

          // 版本与兼容面信息（关于）
          Column({ space: Sp.XS }) {
            Text('关于')
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.font_tertiary'))
              .width('100%')
            this.aboutRow('客户端版本', this.about.appVersion)
            this.aboutRow('受支持的上游版本', this.about.supportedUpstream)
            this.aboutRow('兼容面上表', this.about.endpointStats)
            this.aboutRow('兼容面采集时间', this.about.compatCapturedAt)
          }
          .width('100%')
          .padding(Sp.M)
          .borderRadius(Radius.M)
          .backgroundColor($r('sys.color.background_secondary'))
    }
    .width('100%')
  }

  @Builder
  aboutRow(label: string, value: string) {
    Row({ space: Sp.S }) {
      Text(label)
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_secondary'))
        .layoutWeight(1)
      Text(value.length > 0 ? value : '—')
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_tertiary'))
        .maxLines(1)
        .constraintSize({ maxWidth: 200 })
    }
    .width('100%')
  }
}
