/**
 * 设置页（D1 §7.6 / D3 §1）。
 *
 * 五个页签：通用 / 模型 / 凭据 / 插件 / 设备。
 *
 * 规格要点：
 *   - 每个设置项都带**说明文字**（D3 §4 文案纪律：不能只有名字）；
 *   - 凭据**只呈现状态，绝不含明文值**（D1 §11.5 S3/S4）；
 *   - 插件页展示 cordis fiber 阶段与启用状态；
 *   - 设备页列出 Host、接入级别（L0/L1）与授权状态，并给出配对/吊销入口（D1 §6.4）。
 */

import {
  AboutInfo,
  AgentPresetRow,
  CredentialItem,
  emptyCoreView,
  Fs,
  HostRecord,
  ModelOption,
  ModelSelection,
  Radius,
  PluginItem,
  SettingGroup,
  SettingItem,
  SkillRow,
  Sp,
  Sz,
  settingsSectionLabelRes
} from 'appstate';
import type { CoreViewState, PanelDescriptor, PiAiProviderView } from 'appstate';
import { SettingRow } from './SettingRow';
import { SettingsInventory } from './SettingsInventory';
import { SettingsGeneral } from './SettingsGeneral';
import { SettingsDevice } from './SettingsDevice';
import { SettingsModels } from './SettingsModels';
import { SettingsPlugins } from './SettingsPlugins';
import { SettingsPresets } from './SettingsPresets';
import { SettingsSkills } from './SettingsSkills';
import { SettingsCore } from './SettingsCore';

/** 设置面板（E108/E110/E114/E120） */
@Component
export struct SettingsPane {
  /** 宿主报告的权限组合（E124；空串=未投影，界面不显示要切换的假档位） */
  @Prop permissionCurrent: string = '';
  @Prop permissionOptions: string[] = [];

  /** 插件分区子页签（E114：配置 / 列表） */
  /** 插件清单的过滤词（只作用于「列表」子页签） */

  @Prop groups: SettingGroup[] = [];
  @Prop credentials: CredentialItem[] = [];
  @Prop plugins: PluginItem[] = [];
  @Prop hosts: HostRecord[] = [];
  @Prop models: ModelOption[] = [];
  @Prop selection: ModelSelection = { provider: '', modelId: '', effort: '' };
  /** pi-ai 路由（官方 Models 页的"提供方"，含自定义模型 API 建的那些） */
  @Prop piAiProviders: PiAiProviderView[] = [];
  @Prop about: AboutInfo = {
    appVersion: '', supportedUpstream: '', compatCapturedAt: '', endpointStats: ''
  };
  /** 最近一次设置写入的结果回显（由页面注入；空串表示不显示） */
  @Prop writeNote: string = '';
  /**
   * 这条回执**属于哪个分区**（E347：空串 = 判不出来 ⇒ 照常显示）。
   *
   * 【为什么必须带域】写入回执原本是一个全局字符串，而它唯一的读取点在这里。
   * 于是"在通用改了外观、切到模型"会让那条回执还挂在模型页上方——看起来像模型页
   * 刚写出来的结果（失败回执更糟：像是**这一页**的操作被拒了）。界面不该这样撒谎。
   * 域由 key 的命名空间判定（`settingsDomainOfNs`，纯函数、有 fixture）；
   * 判不出来时**宁可显示**——隐藏一条用户正需要的失败回执，比多显示一条更糟。
   */
  @Prop writeDomain: string = '';
  /** 各命名空间的写状态（仅用于诊断显示 revision） */

  onToggleSetting: (key: string, value: boolean) => void = () => {
  };
  onPickChoice: (key: string, current: string) => void = () => {
  };
  /** 打开文本 / 数字设置项的编辑浮层 */
  onEditText: (item: SettingItem) => void = () => {
  };
  /** 打开结构化值（数组/对象）的整值编辑浮层 */
  onEditStruct: (item: SettingItem) => void = () => {
  };
  /**
   * 重置为**部署默认**（E114，对齐官方插件卡片的"重置"）。
   *
   * 只对"已覆盖"的项出现：没有覆盖过就没有可重置的东西，摆一个点了没反应的按钮更糟。
   * 实现走 `settings/unset`（上游语义：删掉用户层的这一项，值立刻回落到基线/默认）。
   */
  onResetSetting: (key: string) => void = () => {
  };
  /**
   * 选择**默认模型**（provider/model/effort 三个字段一起写 `agent-default-model`）。
   *
   * 【为什么是"默认"而不是"当前会话"】官方把"当前会话用哪个模型"放在会话输入区
   * （`session/selectModel`，按会话生效）；而**设置页**管的是"新会话默认用什么"，
   * 落在 `agent-default-model` 命名空间。两者都对齐官方：这里写默认，输入区切换单次会话。
   */
  onSelectModel: (provider: string, model: string, effort: string) => void = () => {
  };
  /** 凭据：发起交互式授权（D1 §7.6.3） */
  onAuthorizeCredential: (ref: string) => void = () => {
  };
  /** 编辑一个 pi-ai 路由（逐字段表单） */
  onEditProvider: (route: string) => void = () => {
  };
  /** 新建一个自定义模型 API 路由 */
  onAddProvider: () => void = () => {
  };
  /** 设备：发起配对 */
  onPairHost: () => void = () => {
  };
  /** 设备：吊销设备密钥 */
  onRevokeHost: (id: string) => void = () => {
  };
  /** 打开诊断页 */
  onOpenDiagnostics: () => void = () => {
  };

  /**
   * 当前分区（P4-1：**唯一真值在 `NavigationState.settingsSection`**，由宿主传进来）。
   *
   * 【为什么不再是视图里的 `@State tab`】设置分区是**导航状态**的一部分：从侧栏「设置」进来、
   * 从别处深链到某一分区、以及"返回"该回到哪一段，都要看它。视图自己存一份，
   * 等于让导航状态与显示内容两处各说一套。
   */
  @Prop section: string = 'settings.general';
  /** 可用分区清单（注册表给；切换器按它画，顺序也由它定） */
  @Prop sections: PanelDescriptor[] = [];
  /** 选一个分区（宿主经注册表校验后写进 `settingsSection`） */
  onSelectSection: (sectionId: string) => void = () => {
  };

  build() {
    Column() {
      this.tabBar()
      Divider().color($r('sys.color.comp_divider'))

      // 写入结果回显：成功 / 冲突 / 被拒 / 本机偏好都走这里。
      // 不做乐观更新，所以这里是用户唯一能看到「Host 到底接受了没有」的地方。
      //
      // 【只在"这条回执属于当前分区"时显示】否则切分区会把上一段的回执带过来，
      // 看起来像当前分区刚写出来的结果（域判不出来时空串 ⇒ 照常显示，见 writeDomain）。
      if (this.writeNote.length > 0 && (this.writeDomain.length === 0 || this.writeDomain === this.section)) {
        Text(this.writeNote)
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_secondary'))
          .width('100%')
          .padding({ left: Sp.M, right: Sp.M, top: Sp.S, bottom: Sp.S })
          .backgroundColor($r('sys.color.background_secondary'))
      }

      Scroll() {
        Column({ space: Sp.L }) {
          if (this.section === 'settings.skills') {
            // 技能段归 SettingsSkills（P4-5 拆出的域组件）：它只吃清单 + 读取结论两个 prop，
            // 没有任何写入动作与组件内状态——「读不到就说读不到」的判定留在数据层（E135）。
            SettingsSkills({
              skills: this.skills,
              note: this.skillNote
            })
          } else if (this.section === 'settings.presets') {
            // 预设段归 SettingsPresets（P4-5 拆出的域组件）：两半（名单卡片 + agent-* 编辑器）、
            // 三个组件内临时态（两步确认 / 只读查看）与「查看」的中枢直读都随之搬走。
            SettingsPresets({
              presets: this.presets,
              note: this.presetNote,
              allGroups: this.allGroups,
              onCopy: (from: string, name: string) => {
                this.onPresetCopy(from, name);
              },
              onDelete: (id: string) => {
                this.onPresetDelete(id);
              },
              onToggleSetting: (key: string, value: boolean) => {
                this.onToggleSetting(key, value);
              },
              onPickChoice: (key: string, current: string) => {
                this.onPickChoice(key, current);
              },
              onEditText: (item: SettingItem) => {
                this.onEditText(item);
              },
              onEditStruct: (item: SettingItem) => {
                this.onEditStruct(item);
              },
              onResetSetting: (key: string) => {
                this.onResetSetting(key);
              }
            })
} else if (this.section === 'settings.core') {
            // 核心段归 SettingsCore（P4-6 拆出的域组件）：它包住 `CorePane` 并承载两块提示。
            // 不用 `@BuilderParam` 注入（E118：真机上点开这一分区会 JS 崩溃）——属性直传。
            SettingsCore({
              view: this.coreView,
              notice: this.coreNotice,
              pluginNotice: this.pluginNotice,
              onAction: (id: string) => {
                this.onCoreAction(id);
              },
              onSelectVersion: (version: string) => {
                this.onCoreSelectVersion(version);
              },
              onTogglePlugin: (id: string, disabled: boolean) => {
                this.onTogglePluginRow(id, disabled);
              },
              onResetPluginRows: () => {
                this.onResetPluginRowsAction();
              }
            })
          } else if (this.section === 'settings.general') {
            // 通用段归 SettingsGeneral（P4-4 拆出的域组件）
            SettingsGeneral({
              groups: this.groups,
              permissionCurrent: this.permissionCurrent,
              permissionOptions: this.permissionOptions,
              onOpenDiagnostics: () => {
                this.onOpenDiagnostics();
              },
              onToggleSetting: (key: string, value: boolean) => {
                this.onToggleSetting(key, value);
              },
              onPickChoice: (key: string, current: string) => {
                this.onPickChoice(key, current);
              },
              onEditText: (item: SettingItem) => {
                this.onEditText(item);
              },
              onEditStruct: (item: SettingItem) => {
                this.onEditStruct(item);
              },
              onResetSetting: (key: string) => {
                this.onResetSetting(key);
              }
            })
          } else if (this.section === 'settings.models') {
            // 模型域归 SettingsModels（P4-3b 拆出的域组件）
            SettingsModels({
              allGroups: this.allGroups,
              models: this.models,
              selection: this.selection,
              credentials: this.credentials,
              piAiProviders: this.piAiProviders,
              onEditProvider: (route: string) => {
                this.onEditProvider(route);
              },
              onAddProvider: () => {
                this.onAddProvider();
              },
              onSelectModel: (provider: string, model: string, effort: string) => {
                this.onSelectModel(provider, model, effort);
              },
              onAuthorizeCredential: (ref: string) => {
                this.onAuthorizeCredential(ref);
              },
              onToggleSetting: (key: string, value: boolean) => {
                this.onToggleSetting(key, value);
              },
              onPickChoice: (key: string, current: string) => {
                this.onPickChoice(key, current);
              },
              onEditText: (item: SettingItem) => {
                this.onEditText(item);
              },
              onEditStruct: (item: SettingItem) => {
                this.onEditStruct(item);
              },
              onResetSetting: (key: string) => {
                this.onResetSetting(key);
              }
            })
          } else if (this.section === 'settings.plugins') {
            this.pluginsTab()
          } else if (this.section === 'settings.plugin-inventory') {
            // 只读清单独立成分区（官方 `settings-plugin-inventory`）：它是"这家宿主装了什么"，
            // 与"哪些插件可以配置"是两件事（此前是插件段里的一个子页签）
            // 只读清单归 SettingsInventory（官方 settings-plugin-inventory）
            SettingsInventory({ plugins: this.plugins })
          } else {
            // 设备段归 SettingsDevice（P4-4 拆出的域组件）
            SettingsDevice({
              about: this.about,
              hosts: this.hosts,
              onPairHost: () => {
                this.onPairHost();
              },
              onRevokeHost: (id: string) => {
                this.onRevokeHost(id);
              }
            })
          }
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

  /**
   * 核心分区（E110/E118：原「核心」一级页签并入这里）。
   *
   * 【为什么不用 `@BuilderParam` 注入】原先由宿主注入一个 `@Builder`（`coreSlot`），
   * 真机上点开「核心」分区**直接 JS 崩溃**（`AppKilledReporter: reason: JsError`，
   * 23:57:10 的 `JS_ERROR…` faultlog），而只改这一处即可回避。
   * 改为把 `CorePane` 需要的 6 个属性直接传进来：数据流一眼能看完，
   * 也不再依赖"父 Builder 在子组件里被调用"这条容易踩坑的机制。
   */
  @Prop coreView: CoreViewState = emptyCoreView();
  /** 核心页顶部的一次性提示（宿主维护） */
  @Prop coreNotice: string = '';
  /** 插件行操作的结果提示（核心页里的插件分区会显示） */
  @Prop pluginNotice: string = '';
  onCoreAction: (id: string) => void = () => {
  };
  onCoreSelectVersion: (version: string) => void = () => {
  };
  onTogglePluginRow: (id: string, disabled: boolean) => void = () => {
  };
  onResetPluginRowsAction: () => void = () => {
  };

  @Builder
  tabBar() {
    Scroll() {
      Row({ space: Sp.S }) {
        /*
         * 分区清单来自注册表（`settingsSections`，官方四段在前、本仓特有四项在后）。
         * 文案走 `settingsSectionLabelRes`（跟随系统语言），与侧栏入口同一套做法。
         */
        ForEach(this.sections, (d: PanelDescriptor) => {
          this.tabChip(d.id, settingsSectionLabelRes(d.id))
        }, (d: PanelDescriptor) => d.id)
      }
      .padding({ left: Sp.M, right: Sp.M })
    }
    .scrollable(ScrollDirection.Horizontal)
    .scrollBar(BarState.Off)
    .width('100%')
    .height(Sz.TOUCH_MIN)
  }

  @Builder
  tabChip(key: string, label: ResourceStr) {
    Text(label)
      .fontSize(Fs.SECONDARY)
      .fontColor(this.section === key ? Color.White : $r('sys.color.font_secondary'))
      .padding({ left: Sp.M, right: Sp.M, top: Sp.S, bottom: Sp.S })
      .borderRadius(Radius.L)
      .backgroundColor(this.section === key ? $r('sys.color.brand') : $r('sys.color.background_secondary'))
      .onClick(() => {
        this.onSelectSection(key);
      })
  }

  /*
   * 【曾经的 `settingRow` 薄包装已删除】P4-3 抽 `SettingRow` 组件时，宿主留了它把 5 个回调转过去
   * （当时通用段与预设段有多个调用点）。P4-5 把那两段搬进 `SettingsSkills`/`SettingsPresets` 之后，
   * **它一个调用点都没有了**——而它的文档还写着"多个调用点"，读者会以为这里还在用。
   * 由 E350 的死代码门禁查出并删除；`SettingRow` 的导入也随之摘掉。
   */
  // ───────────── 通用 ─────────────


  /** 行的显示名：有官方中文措辞就用它，否则保持 Host 原文（E120） */

  /** 行的说明：官方有 description 就用官方的（如「仅影响会话内容的字号」），否则用 Host 给的 */

  /** 选项值的显示：官方译名优先（浅色/深色/跟随系统、标准/紧凑），否则回落既有标签 */



  // ───────────── 模型 ─────────────

  /**
   * **全部**设置分区（含被「通用」策展隐藏的 `llm-*` 等）。
   *
   * 官方 Models 页的编辑卡片直接读写提供方的设置分区（`baseURL`、模型目录…），
   * 所以模型页必须能看到这些分区；「通用」页继续用策展后的 `groups`（见 E114）。
   * 预设段（`SettingsPresets`）吃的是同一份"全部"——`agent-*` 分区同样不在策展结果里。
   */
  @Prop allGroups: SettingGroup[] = [];
  /** 技能清单（E135）与读取结论：结论非空必须显示，不假装"没有技能" */
  @Prop skills: SkillRow[] = [];
  @Prop skillNote: string = '';
  /**
   * Agent 预设名单（E159/E160：`agentPresets/list` 实测形状）。
   *
   * 语义：预设 = **一个会话的 Agent 所运行的插件组装**（工具/提示词/能力）。
   * `name` / `description` 由**预设自带**（真机上就是中文），我们不自编文案；
   * `trust === 'system'` 是**随附只读**预设（官方不给复制/删除）。
   */
  @Prop presets: AgentPresetRow[] = [];
  @Prop presetNote: string = '';
  /**
   * 预设动作（E170）。**复制**是官方唯一的创建入口；**删除**只对自定义预设开放，
   * 且"随附预设不可写"由**宿主**强制（我们只是把它的原话转达给用户）。
   *
   * 三个临时态（两步确认 / 只读查看的 id 与内容）**不在本组件**：它们随预设段
   * 一起归 `SettingsPresets`（P4-5）——一次交互内的临时态不该跨段落存活。
   */
  onPresetCopy: (from: string, name: string) => void = () => {
  };
  onPresetDelete: (id: string) => void = () => {
  };

  /** 提供方 → 适配器默认凭据引用（官方派生规则 `<ROUTE>_API_KEY`，见 E106） */

  /**
   * 未被任何提供方卡片覆盖的凭据引用（E157：模型页去重的关键）。
   *
   * 提供方卡片用 `<ROUTE>_API_KEY` 这一个引用；宿主还会报告别的引用
   * （例如设置命名空间里声明的槽位）。把前者已覆盖的过滤掉，
   * 用户就不会看到"同一把密钥填两次"，同时**没有任何引用被隐藏**。
   */

  /**
   * 密钥状态点的颜色语义（官方：**只有确认已配置才是绿**，**只有确认缺失才是红**，
   * 其余一律"未知"——不把未知渲染成任一种结论）。
   */

  /** 提供方的设置分区（先试 `llm-<提供方首段>`，再退到通用 pi-ai 分区；找不到就返回 undefined，不猜） */
  /**
   * 目录里**尚未配置**的提供方（E181）。
   *
   * 【为什么读中枢快照而不是再加一个 prop】目录是"静态事实"，由进入设置页时触发读取
   * （`Index.selectTab` → `refreshProviderCatalog()`），读取后中枢通知、本组件随之重建；
   * 为它单独再穿一层 prop 只增加耦合，不会带来额外正确性。
   * 【已配置怎么判定】`providerGroups()` 是"宿主设置里已出现的提供方" ⇒ 从目录里减掉它们。
   */
  /**
   * 候选提供方（E211）：在 `providerCandidates()` 之上套一层**搜索过滤**。
   *
   * 对齐官方 `candidateSearch`（其候选区带搜索框与工具栏）。纯前端过滤、不涉端点；
   * 大小写不敏感，空词返回全部。
   */




  // 模型段的判定与呈现（提供方卡片 / 凭据派生 / 模型目录分组 / 推理强度选择）已归
  // `SettingsModels`（P4-3b）；本组件只留"这一段由谁渲染"的分派。

  // ───────────── 凭据 ─────────────


  /** 凭据项的说明文字 */

  // ───────────── 插件 ─────────────

  /**
   * 单个插件的可安装性行。
   *
   * 目前**恒为 UNKNOWN**：上游 `pluginInventory.list` 不提供"是否含原生模块"这一信息。
   * 这是**记录事实**而不是偷懒——等能读到插件包清单（package.json / 是否存在 .node）后，
   * 再把真实取值传进来即可，界面与契约都不用改。
   */

  /**
   * 插件分区（E114 对齐官方：官方在这里分**配置**与**列表**两个子页签）。
   *
   * 【为什么分】两者回答的问题不同、风险也不同：
   *   - **配置**：我要改什么（启停 + 恢复部署默认）——写操作，改动会影响运行；
   *   - **列表**：这里到底有什么（只读清单 + 过滤）——查证用，152 行时不加过滤根本找不到东西。
   * 官方把只读清单单独成页，正是为了让"看一眼清单"不必冒误触的风险。
   */
  @Builder
  pluginsTab() {
    /*
     * 摘要行与卡片都归 `SettingsPlugins`。
     *
     * 【顺带修掉的一处重复】此前这里画了一行摘要、组件里又画了一行（同一句话出现两次）——
     * 抽取组件时才发现：**"这段内容到底归谁"写清楚之后，重复自己就露出来了**。
     */
    SettingsPlugins({ plugins: this.plugins })
  }

  /** 只读清单 + 关键词过滤（官方"插件列表"标签页的语义） */

  /** 关键词过滤后的插件清单（空关键词 = 全部） */


  // ───────────── 设备 ─────────────


}
