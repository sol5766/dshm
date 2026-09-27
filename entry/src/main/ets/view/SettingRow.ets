/**
 * 设置项的一行（P4-3：从 `SettingsPane` 抽出的**共用**呈现）。
 *
 * ## 为什么抽出来
 *
 * 它是设置页里最忙的一块：一行里可能带开关、单选、文本编辑、结构编辑、恢复默认，
 * 还要显示**当前值 + 来源（Host / 本机）**与"为什么改不了"的提示。
 * 通用段、预设段、以及（下一步要拆的）模型域的提供方卡片都用它 ⇒ 抄三份必然走样。
 *
 * ## 边界
 *
 * 行**不认识中枢**：能改什么、改了会怎样，全由宿主经 5 个回调决定；
 * 文案（标签 / 提示 / 当前值）由行自己算——它们只服务于这一行的显示（`labelOf` 走官方的中文措辞表）。
 */

import { Fs, Radius, SettingItem, SettingKind, SettingOrigin, Sp, splitSettingKey } from 'appstate';

/**
 * 选择项的显示文案：优先用选项自带的显示名，找不到就回退到取值本身。
 *
 * 上游实测**没有**枚举显示名（`const.value` 就是取值），所以 `label` 与
 * `value` 目前相同；但契约里两者是分开的，界面按「优先 label」渲染，
 * 将来上游补上显示名时不需要改这里。
 */
function choiceLabel(item: SettingItem): string {
  for (let i = 0; i < item.choices.length; i++) {
    if (item.choices[i].value === item.textValue) {
      return item.choices[i].label;
    }
  }
  return item.textValue.length > 0 ? item.textValue : '未设置';
}

/**
 * 设置项的**官方中文措辞**（E120）。
 *
 * 【为什么需要一张表】设置项的 label / 选项值是 **Host 给的**（真机上是英文：
 * `Preference` / `Font size` / `Busy enter` / `Transcript view`，选项 `system` / `compact`），
 * 而官方 web 显示的是它自己内嵌的中文文案。用户要求"设置-通用里默认中文、措辞与官方一致"，
 * 所以这里按 `命名空间.键` 覆盖成官方译名——文案取自官方客户端包内嵌的 locale 表
 * （`dsh-client-ui-theme/lib/client.js` 的 `"appearance.title": "外观"` 等，同一批还给了
 * 选项值「浅色/深色/跟随系统」「字号大小」「语言」「对话显示/标准/紧凑」）。
 * 覆盖不到的键**保持 Host 原文**：宁可显示英文，也不自创一个官方没有的说法。
 */
function officialSettingLabel(ns: string, key: string): string {
  if (ns === 'ui-theme' && key === 'preference') {
    return '外观';
  }
  if (ns === 'ui-theme' && key === 'fontSize') {
    return '字号大小';
  }
  if (ns === 'locale' && key === 'preference') {
    return '语言';
  }
  if (ns === 'ui-chat' && key === 'transcriptView') {
    return '对话显示';
  }
  if (ns === 'ui-conversation' && key === 'busyEnter') {
    return '回车键行为';
  }
  if (ns === 'ui-onboarding' && key === 'welcomeNoticeVersion') {
    return '欢迎提示版本';
  }
  /*
   * E155（用户反馈③）：**预设分区**此前直接显示宿主给的英文键，中文界面里很突兀。
   * 键名取自真机截图（`agent-default-model` / `agent-loop` / `agent-presets`）。
   */
  if (ns === 'agent-default-model' && key === 'provider') {
    return '提供方';
  }
  if (ns === 'agent-default-model' && key === 'model') {
    return '模型';
  }
  if (ns === 'agent-default-model' && key === 'reasoningEffort') {
    return '推理强度';
  }
  if (ns === 'agent-loop' && key === 'maxParallelToolCalls') {
    return '最大并行工具调用数';
  }
  if (ns === 'agent-presets' && key === 'default') {
    return '默认预设';
  }
  if (ns === 'subagent-model-selection' && key === 'enabled') {
    return '允许子代理选模型';
  }
  if (ns === 'subagent-model-selection' && key === 'allowedModels') {
    return '允许的模型';
  }
  return '';
}

/** 官方对**选项值**的中文措辞（取不到就返回空串，由调用方回落原值） */
function officialSettingValue(ns: string, key: string, value: string): string {
  if (ns === 'ui-theme' && key === 'preference') {
    if (value === 'light') {
      return '浅色';
    }
    if (value === 'dark') {
      return '深色';
    }
    if (value === 'system') {
      return '跟随系统';
    }
  }
  if (ns === 'ui-chat' && key === 'transcriptView') {
    if (value === 'normal') {
      return '标准';
    }
    if (value === 'compact') {
      return '紧凑';
    }
  }
  return '';
}

/** 官方对**说明文字**的中文措辞（同上，取不到返回空串） */
function officialSettingHint(ns: string, key: string): string {
  if (ns === 'ui-theme' && key === 'fontSize') {
    return '仅影响会话内容的字号';
  }
  if (ns === 'ui-chat' && key === 'transcriptView') {
    return '控制已完成轮次的过程内容';
  }
  return '';
}

@Component
export struct SettingRow {
  /** 要显示（并可能被修改）的设置项 */
  @Prop item: SettingItem;

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

  build() {
    Row({ space: Sp.M }) {
      Column({ space: 2 }) {
        Row({ space: Sp.XS }) {
          Text(this.labelOf(this.item))
            .fontSize(Fs.BODY)
          // 【来源标记是必需信息，不是装饰】本客户端的通知 / 离线缓存等偏好
          // 在上游根本没有对应命名空间；不标出来，用户会以为改它也会影响 Host。
          if (this.item.origin === SettingOrigin.LOCAL) {
            Text('本机')
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.font_tertiary'))
              .padding({ left: 6, right: 6, top: 1, bottom: 1 })
              .borderRadius(Radius.S)
              .backgroundColor($r('sys.color.background_primary'))
          }
          // 实测 value 是「默认 → 基线 → 用户层」三层合并的结果，
          // 只看 value 无法区分「继承默认」与「用户设成了同一个值」。
          // E114 对齐官方：官方在这一行标明"用户覆盖过哪些值"，并允许**重置为部署默认**。
          if (this.item.userSet) {
            Text($r('app.string.badge_overridden'))
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.brand'))
              .padding({ left: 6, right: 6, top: 1, bottom: 1 })
              .borderRadius(Radius.S)
              .backgroundColor($r('sys.color.background_primary'))
          } else {
            Text($r('app.string.badge_default'))
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.font_tertiary'))
              .padding({ left: 6, right: 6, top: 1, bottom: 1 })
              .borderRadius(Radius.S)
              .backgroundColor($r('sys.color.background_primary'))
          }
        }
        .width('100%')

        Text(this.hintOf(this.item))
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')

        // `applies: 'restart'` 的命名空间改完需要重启 Host 才生效。
        // 不提示就是骗用户「已经生效了」。
        if (!this.item.appliesLive) {
          Text('需重启 Host 后生效')
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.warning'))
            .width('100%')
        }

        // 不可编辑的原因必须说清楚，而且**两种原因文案不同**：
        //   - Host 不接受写 → 是权限/来源问题，用户无从改变；
        //   - 本客户端还没做该形态的编辑器 → 是我们的功能缺口，不是 Host 的限制。
        // 把后者写成前者会误导用户去 Host 上找权限开关。
        if (this.item.readOnly) {
          Text(this.item.hostWritable ? '此形态暂不支持在本客户端编辑（只读展示）' : 'Host 不接受对此项写入')
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_tertiary'))
            .width('100%')
        }
      }
      .layoutWeight(1)

      // 重置为部署默认（只对"已覆盖"的项出现，见 `onResetSetting` 的说明）
      if (this.item.userSet && this.item.hostWritable && !this.item.readOnly) {
        Text($r('app.string.action_reset'))
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.brand'))
          .onClick(() => {
            this.onResetSetting(this.item.key);
          })
      }

      if (this.item.kind === SettingKind.TOGGLE) {
        Toggle({ type: ToggleType.Switch, isOn: this.item.boolValue })
          .enabled(!this.item.readOnly)
          .onChange((on: boolean) => {
            this.onToggleSetting(this.item.key, on);
          })
      } else if (this.item.kind === SettingKind.CHOICE) {
        Text(this.valueLabelOf(this.item))
          .fontSize(Fs.SECONDARY)
          .fontColor(this.item.readOnly ? $r('sys.color.font_tertiary') : $r('sys.color.brand'))
          .onClick(() => {
            if (!this.item.readOnly) {
              this.onPickChoice(this.item.key, this.item.textValue);
            }
          })
      } else if (this.item.kind === SettingKind.STRUCT) {
        // 结构化值（数组 / 嵌套对象 / 复杂 union）：整值编辑。
        // 与 TEXT 一样**必须可点**——不可点的控件等于没有这个功能。
        Text(this.item.textValue)
          .fontSize(Fs.SECONDARY)
          .fontColor(this.item.readOnly ? ('sys.color.font_tertiary') : ('sys.color.brand'))
          .maxLines(1)
          .constraintSize({ maxWidth: 160 })
          .onClick(() => {
            if (!this.item.readOnly) {
              this.onEditStruct(this.item);
            }
          })
      } else {
        // TEXT（字符串 / 数字）：**必须可点**才有编辑入口。
        // 曾经这里只是一个带 `.maxLines(1)` 的静态 `Text`——数据与 kind 都对，
        // 但没有任何点击处理，于是「文本/数字项可编辑」这件事**只存在于代码里**，
        // 界面上看不出可以点（UI 导出里该节点没有 clickable 标记）。
        // 一个不可点的控件等于没有这个功能。
        Text(this.item.textValue.length > 0 ? this.item.textValue : '未设置')
          .fontSize(Fs.SECONDARY)
          .fontColor(this.item.readOnly ? $r('sys.color.font_tertiary') : $r('sys.color.brand'))
          .maxLines(1)
          .constraintSize({ maxWidth: 160 })
          .onClick(() => {
            if (!this.item.readOnly) {
              this.onEditText(this.item);
            }
          })
      }
    }
    .width('100%')
    .padding(Sp.M)
    .borderRadius(Radius.M)
    .backgroundColor($r('sys.color.background_secondary'))
    .accessibilityText(`${this.item.label}。${this.item.hint}`)
  }

  private labelOf(item: SettingItem): string {
    const parts = splitSettingKey(item.key);
    if (parts === undefined) {
      return item.label;
    }
    const official: string = officialSettingLabel(parts.ns, parts.fieldPath);
    return official.length > 0 ? official : item.label;
  }

  private hintOf(item: SettingItem): string {
    const parts = splitSettingKey(item.key);
    if (parts !== undefined) {
      const official: string = officialSettingHint(parts.ns, parts.fieldPath);
      if (official.length > 0) {
        return `${official} · ${item.hint}`;
      }
    }
    return item.hint;
  }

  private valueLabelOf(item: SettingItem): string {
    const parts = splitSettingKey(item.key);
    if (parts !== undefined) {
      const official: string = officialSettingValue(parts.ns, parts.fieldPath, item.textValue);
      if (official.length > 0) {
        return official;
      }
    }
    return choiceLabel(item);
  }
}
