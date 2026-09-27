/**
 * 设置页「预设」分区（P4-5：从 `SettingsPane.build()` 的内联分支拆出的域组件）。
 *
 * ## 它拥有什么
 *
 * 官方 `settings-agent-presets` 这一页的两半：
 *   ① **预设名单卡片**（E161）：名字 / 说明 / id / 默认标记 / 随附或自定义，以及卡片动作；
 *   ② **`agent-*` 设置分区的编辑器**（E129）：让"新建会话用哪个预设"真的可改。
 *
 * ## 被保留下来的语义（都不是装饰）
 *
 * 1. **复制是创建自定义预设的唯一入口**（官方规则）⇒ **每张卡都有**「复制」，
 *    连随附只读预设也能被复制。
 * 2. **删除只对自定义预设开放**：`trust === 'system'` 是随附只读，
 *    连入口都不给（宿主也会拒绝）——而不是给一个点了必被拒的按钮。
 * 3. **删除走两步确认**（先「确认删除 / 取消」）——这是不可逆动作。
 * 4. **查看是只读查看器**（E173，官方对随附预设就是"在只读查看器里打开"）。
 * 5. **"预设没有可读文本"要说清楚**：宿主返回空串时说明可能的原因，不显示空白面板。
 * 6. **预设只在会话创建时固定** ⇒ 这里改的是**此后新建会话**的默认值，已存在的会话不受影响
 *    （这句话必须留在页面上，否则用户会以为改了当前会话）。
 *
 * ## 组件内状态（三个，都不上宿主）
 *
 * `confirmingId` / `viewedId` / `viewedContent` 都是**一次交互内的临时态**，
 * 关掉设置页就没有意义，所以不进 `NavigationState`（对照那些"刷新后应当恢复"的选中态）。
 *
 * ## 一处例外（如实记录）：查看动作直接调中枢
 *
 * 查看是**纯读取**、无副作用、也不改变其它页面状态；为它再往 `Index` 穿一层 prop
 * 只会增加耦合（与 `SettingsModels.providerCandidates()` 同一类例外）。
 * 写入类动作（复制 / 删除）仍走宿主回调，因为它们要影响"下一步做什么"（提示语落在宿主页上）。
 */

import {
  AgentPresetRow,
  Fs,
  Radius,
  SessionHub,
  SettingGroup,
  SettingItem,
  Sp,
  presetIsBundled
} from 'appstate';
import { SettingRow } from './SettingRow';

/** 设置页「预设」分区 */
@Component
export struct SettingsPresets {
  /** Agent 预设名单（E159/E160：`agentPresets/list` 实测形状；`trust === 'system'` = 随附只读） */
  @Prop presets: AgentPresetRow[] = [];
  /** 名单读取结论（非空必须显示：读不到 ≠ 没有预设） */
  @Prop note: string = '';
  /** **全部**设置分区（含被「通用」策展隐藏的 `agent-*`）——预设编辑器要从这里取 */
  @Prop allGroups: SettingGroup[] = [];
  /** 复制（官方唯一的创建入口；随附预设也能复制） */
  onCopy: (from: string, name: string) => void = () => {
  };
  /** 删除（宿主强制"随附预设不可写"，并把它的原话转达给用户） */
  onDelete: (id: string) => void = () => {
  };
  /** 设置项的三个写入口（`agent-*` 分区里会有开关/单选/文本项） */
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

  /** 已按过一次「删除」、等待确认的预设 id（两步确认） */
  @State confirmingId: string = '';
  /** 正在查看的预设 id（空 = 未查看） */
  @State viewedId: string = '';
  /** 只读查看器当前展示的预设内容（E173） */
  @State viewedContent: string = '';

  /** `agent-*` 设置分区（E129：Agent 预设相关，官方在设置里有专门分区） */
  private agentGroups(): SettingGroup[] {
    const out: SettingGroup[] = [];
    for (let i = 0; i < this.allGroups.length; i++) {
      const g: SettingGroup = this.allGroups[i];
      if (g.title.startsWith('agent-')) {
        out.push(g);
      }
    }
    return out;
  }

  /**
   * 只读查看器要显示的内容。
   *
   * 【为什么把 Promise 留在组件里】它只写组件自己的 `viewedContent`，
   * 失败信息也只对这一次查看有意义 ⇒ 让它出组件反而要往上传错误分支。
   */
  private readPreset(id: string): void {
    this.viewedId = id;
    this.viewedContent = '正在读取…';
    SessionHub.shared().readAgentPreset(id).then((text: string) => {
      this.viewedContent = text.length > 0
        ? text
        : '宿主没有返回内容（可能该预设没有可读的组装文本，或读取被拒）。';
    }).catch((e: Object) => {
      this.viewedContent = `读取失败：${(e as Error).message}`;
    });
  }

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
      if (this.presets.length > 0) {
        Text('Agent 预设')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')
        ForEach(this.presets, (p: AgentPresetRow) => {
          this.presetCard(p)
        }, (p: AgentPresetRow) => p.id)
        Text('预设是"这个会话的 Agent 跑哪些插件"的组装；会话创建时固定，改默认只影响此后新建的会话。复制 / 打开位置 / 删除待接线（形状需先探针确证）。')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')
      }
      if (this.agentGroups().length === 0) {
        Text('宿主没有暴露 agent-* 设置分区（端侧只显示它确实报告的东西）。')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')
      } else {
        ForEach(this.agentGroups(), (group: SettingGroup) => {
          this.agentGroup(group)
        }, (group: SettingGroup) => group.title)
      }
      Text('预设**在会话创建时固定**（官方原话），所以这里设置的是**此后新建会话**用的默认值；已存在的会话不受影响。')
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_tertiary'))
        .width('100%')
    }
    .width('100%')
  }

  /** 一张预设卡：名字 / 默认标记 / 随附或自定义 / 说明 / id / 三个动作 */
  @Builder
  presetCard(p: AgentPresetRow) {
    Column({ space: 2 }) {
      Row({ space: Sp.S }) {
        Text(p.name.length > 0 ? p.name : p.id)
          .fontSize(Fs.BODY)
          .fontWeight(FontWeight.Medium)
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        if (p.isDefault) {
          Text('默认')
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.brand'))
        }
        Text(presetIsBundled(p) ? '随附' : '自定义')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
      }
      .width('100%')
      if (p.description.length > 0) {
        Text(p.description)
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_secondary'))
          .width('100%')
      }
      Text(p.id)
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_tertiary'))
        .width('100%')
      Row({ space: Sp.M }) {
        Text('复制')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.brand'))
          .onClick(() => {
            this.onCopy(p.id, p.name);
          })
        Text(this.viewedId === p.id ? '收起内容' : '查看')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.brand'))
          .onClick(() => {
            if (this.viewedId === p.id) {
              this.viewedId = '';
              this.viewedContent = '';
              return;
            }
            this.readPreset(p.id);
          })
        if (!presetIsBundled(p)) {
          Text(this.confirmingId === p.id ? '确认删除' : '删除')
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.alert'))
            .onClick(() => {
              if (this.confirmingId === p.id) {
                this.confirmingId = '';
                this.onDelete(p.id);
              } else {
                this.confirmingId = p.id;
              }
            })
          if (this.confirmingId === p.id) {
            Text('取消')
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.font_tertiary'))
              .onClick(() => {
                this.confirmingId = '';
              })
          }
        }
      }
      .width('100%')
      if (this.viewedId === p.id) {
        Text(this.viewedContent)
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_secondary'))
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
  }

  /** 一个 `agent-*` 分区（组标题 + 组内设置项） */
  @Builder
  agentGroup(group: SettingGroup) {
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
  }
}
