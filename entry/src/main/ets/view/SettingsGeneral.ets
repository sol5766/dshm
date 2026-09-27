/**
 * 设置 · 通用（P4-4：从 `SettingsPane` 拆出的第二个域组件）。
 *
 * ## 这一个域回答什么
 *
 * 官方 General 段的内容（矩阵 `settings-general` 行）：**用户面向的功能包设置**
 * （外观 / 语言 / 会话显示…）——由宿主按命名空间策展后传进来（白名单整组显示 +
 * "其他已修改项"归拢），以及**端侧的设备事实**（权限模式只读展示）。
 * 另外带上本地调试入口（连接诊断 + 协议往返验证，E96 合并）。
 *
 * ## 边界
 *
 *  · 设置分组与权限事实由宿主给；
 *  · 写入（改设置、恢复默认）由回调交回宿主 —— 组件不决定"写失败要不要提示"（回执由宿主统一显示）；
 *  · 行渲染复用 `SettingRow`（模型域也用同一份）。
 */

import { Fs, Radius, SettingGroup, SettingItem, Sp } from 'appstate';
import { SettingRow } from './SettingRow';


/**
 * 模型目录按提供方分组后的一组（E96）。
 *
 * 【为什么要有这个类型】官方 Models 页以"提供方"为单位组织（密钥、端点、模型清单都挂它上面）；
 * 拉平成一个模型列表就看不出"这个模型要用哪把密钥"。
 */

/** 访问模式的中文名（官方译名，取自 `dsh-client-ui-permission-presets` 的 README） */
function permissionModeLabel(value: string): string {
  if (value === 'read-only') {
    return '仅可查看';
  }
  if (value === 'workspace-write') {
    return '工作区内修改';
  }
  if (value === 'danger-full-access') {
    return '完全权限';
  }
  return value;
}

@Component
export struct SettingsGeneral {

  /** 通用段的设置分组（宿主已按官方口径策展：白名单整组 + 其他已修改项） */
  @Prop groups: SettingGroup[] = [];
  /** 当前权限模式（只读展示：官方在 General 里给新会话默认，本仓端点还不支持切换） */
  @Prop permissionCurrent: string = '';
  /** 宿主给出的可选集合（只读展示） */
  @Prop permissionOptions: string[] = [];

  /** 打开本地调试（连接诊断 + 协议往返验证） */
  onOpenDiagnostics: () => void = () => {
  };
  /** 以下五个转给 `SettingRow` */
  onToggleSetting: (key: string, value: boolean) => void = () => {
  };
  onPickChoice: (key: string, current: string) => void = () => {
  };
  onEditText: (item: SettingItem) => void = () => {
  };
  onEditStruct: (item: SettingItem) => void = () => {
  };
  onResetSetting: (key: string) => void = () => {
  };

  // 【ArkUI 约束】组件的 build() 只能有一个根节点 ⇒ 多段内容包进 Column
  build() {
    Column({ space: Sp.L }) {
          /*
           * 【权限模式：只读说明，不给假档位（E116）】
           *
           * 官方在这三个标签下提供可切换的预设（仅可查看 / 工作区内修改 / 完全权限），
           * 但端侧**实测**：启用 `dsh-permission-presets` 会让整棵插件树启动失败——
           * 它需要 `shell` 服务，而 shell 只能由 bash/pwsh 沙箱提供，两者在鸿蒙上没有对应物
           * （无法创建进程，E15）。官方规则也写明"宿主没有权限组合时，选择器与设置行都不显示"。
           *
           * 于是这里既**不隐藏**（用户明确问过这三档，藏起来等于让他以为没有这个概念），
           * 也**不给可点的假档位**：只读地说明当前生效的是什么、另外两档为什么不可选。
           */
          Column({ space: 2 }) {
            Row({ space: Sp.XS }) {
              Text('权限模式')
                .fontSize(Fs.BODY)
              Text(this.permissionCurrent.length > 0 ? '宿主报告' : '未报告')
                .fontSize(Fs.CAPTION)
                .fontColor($r('sys.color.font_tertiary'))
                .padding({ left: 6, right: 6, top: 1, bottom: 1 })
                .borderRadius(Radius.S)
                .backgroundColor($r('sys.color.background_primary'))
            }
            .width('100%')
            // E124：显示**宿主真正报告的**当前模式（此前这里是我写死的字符串）
            Text(this.permissionCurrent.length > 0
              ? `${permissionModeLabel(this.permissionCurrent)}（${this.permissionCurrent}）`
              : '宿主暂未报告当前访问模式')
              .fontSize(Fs.SECONDARY)
              .fontColor($r('sys.color.font_secondary'))
              .width('100%')
            if (this.permissionOptions.length > 0) {
              Text(`宿主给出的可选集合：${this.permissionOptions.map((v: string) => permissionModeLabel(v)).join(' / ')}`)
                .fontSize(Fs.CAPTION)
                .fontColor($r('sys.color.font_tertiary'))
                .width('100%')
            }
            Text('端侧暂不可切换：把这几档捆绑成可切换预设的插件需要 shell 服务，而鸿蒙不允许应用创建进程（E15）。这里显示的是宿主当前生效的访问模式。')
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.font_tertiary'))
              .width('100%')
          }
          .width('100%')
          .padding(Sp.M)
          .borderRadius(Radius.M)
          .backgroundColor($r('sys.color.background_secondary'))

          ForEach(this.groups, (group: SettingGroup) => {
            Column({ space: Sp.XS }) {
              Text(group.title)
                .fontSize(Fs.CAPTION)
                .fontColor($r('sys.color.font_tertiary'))
                .width('100%')
              ForEach(group.items, (item: SettingItem) => {
                SettingRow({
                    item: item,
                    onToggleSetting: (key: string, value: boolean) => {
                      this.onToggleSetting(key, value);
                    },
                    onPickChoice: (key: string, current: string) => {
                      this.onPickChoice(key, current);
                    },
                    onEditText: (it: SettingItem) => {
                      this.onEditText(it);
                    },
                    onEditStruct: (it: SettingItem) => {
                      this.onEditStruct(it);
                    },
                    onResetSetting: (key: string) => {
                      this.onResetSetting(key);
                    }
                  })
              }, (item: SettingItem) => item.key)
            }
            .width('100%')
          }, (group: SettingGroup) => group.title)

          this.diagnosticsEntry()
    }
    .width('100%')
  }

  @Builder
  diagnosticsEntry() {
    Row({ space: Sp.S }) {
      SymbolGlyph($r('sys.symbol.bell')).fontSize(16)   // token-exempt: 行内图标尺寸（搬迁不改视觉）
        .fontColor([$r('sys.color.brand')])
      Column({ space: 2 }) {
        // 原「连接诊断」与「POC 协议验证」合并（E96）：它们都在回答"这台设备上的核心通不通"，
        // 一个给结论、一个给逐步证据；进同一个页面就能从结论下钻到证据。
        Text('本地调试')
          .fontSize(Fs.BODY)
          .width('100%')
        Text('连接诊断（五项判定）+ 协议往返验证（token → cookie → /api → WS 逐步证据）')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')
      }
      .layoutWeight(1)
      Text('进入')
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.brand'))
    }
    .width('100%')
    .padding(Sp.M)
    .borderRadius(Radius.M)
    .backgroundColor($r('sys.color.background_secondary'))
    .onClick(() => {
      this.onOpenDiagnostics();


    })
  }
}
