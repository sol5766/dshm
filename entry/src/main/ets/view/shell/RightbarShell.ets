/**
 * 右栏外壳（P0：AppFrame 的第三条轨道）。
 *
 * ## 它拥有什么
 *
 * 右栏的**面板本体**：标题行 + 关闭入口 + 内容（`DetailPane` 的 sections）+ 自身宽度与底色。
 * 三种呈现都在它内部：
 *
 * | `DetailPresentation` | 呈现 | 由谁提供外壳 |
 * |---|---|---|
 * | `COLUMN` | 三栏下的真右栏（与主内容并排） | 本组件自带标题行与关闭按钮 |
 * | `SIDE_PANEL` | 双栏下的**侧边浅层面板**（压在内容右缘） | 同上（宽度由宿主的夹取规则给） |
 * | `OVERLAY` | 单栏下的半模态 Sheet | **Sheet 自带关闭**（拖拽条 / 点击外部），故这里不再画关闭按钮 |
 *
 * ## 为什么"呈现"由宿主给、不在这里判定
 *
 * 它属于**几何层**（`LayoutController.detailPresentation` / `ui/ShellTracks`），
 * 由窗口宽度与形态决定。外壳只把它映射成实际布局——这与侧栏的处理一致：
 * **信息架构不随设备变，只有几何与呈现变**。
 *
 * ## 边界（本步刻意不做）
 *
 * `PanelRegistry` 里的六个右栏候选面板（文件 / 轨迹 / 工具 / 子代理 / 交付物 / 预览）
 * 目前**还没有各自的视图**——右栏内容仍是"一份 sections"，由宿主投影好传进来。
 * **P3-1 已落地**：这里按 `selectedRightPanel`（`panelId`）分派，标题取 descriptor 的 `label`；
 * 而不是继续吃一份 sections）。
 */

import { DetailPresentation, DetailSection, Fs, HarmonyIconSize, HarmonySpacing, PANEL_RIGHT_DELIVERABLES, PANEL_RIGHT_DETAIL, PANEL_RIGHT_FILES, PANEL_RIGHT_PREVIEW, PANEL_RIGHT_SUBAGENT, PANEL_RIGHT_TOOL, PANEL_RIGHT_TRAJECTORY, Sp, Sz, presentTool, toolStateLabel } from 'appstate';
import type { FileNode, FilePreview, PanelDescriptor, SessionStatsInput, TrajectoryItem } from 'appstate';

import { DetailPane } from '../DetailPane';
import { FilePreviewPane } from '../FilePreviewPane';
import { DeliverableCard } from '../DeliverableCard';
import { FileTreePane } from '../FileTreePane';
import type { FileTreeFacade } from '../FileTreePane';
import { SubagentCard } from '../SubagentCard';
import { TimelineOverview } from '../TimelineOverview';
import { ToolCard } from '../ToolCard';
import { NativeChip } from '../NativePrimitives';

/**
 * 右侧内容的**门面**（P2-12）：真右栏与"详情浮层"两处挂载**共用这一份**。
 *
 * ## 为什么需要它（一个实测出来的漂移风险）
 *
 * `RightbarShell` 有**两个挂载点**：三栏的真右栏（`AppShell.detailColumn`）与
 * 「详情」浮层（`Index.detailSheet`）。此前两处**各自**把 16 个 props 拼一遍：
 *   · 真右栏那一份经 `Index` 的 AppShell 门面往上传（`rightPanelId` / `rightFiles` / …）；
 *   · 浮层那一份在 `Index` 里**内联重算**（`deliverablesOf(this.f.trajectoryItems)` 等）。
 *
 * 两处只要有一处漏改（例如新加一个面板的数据忘了给浮层），就会出现
 * **同一个面板在两种呈现下不一样**——而"两处各写一遍必然漂移"是本仓反复踩过的坑
 * （`ToolCard` / `DeliverableCard` / `FileTreePane` / `ReasoningRow` 都是因为这条才抽出来的）。
 *
 * ## 为什么用门面而不是"把 16 个 props 传两遍"
 *
 * 16 个值里有 8 个是**投影**（`deliverablesOf` / `itemsOfKind` …）、2 个是**回包**
 * （`onSelectPanel` / `onAttachFile`）。让每个挂载点自己拼，就等于让两处各自决定
 * "怎么投影、往哪儿转发" —— 那正是漂移的来源。门面把这两个决定**收在一处**，
 * 挂载点只提供**它自己那份**（`presentation` / `widthVp` / `sections` / `onClose`）。
 */
export interface RightbarFacade {
  /** 当前面板 id（导航状态） */
  panelId: string;
  /** 当前面板名（注册表 label，宿主兜底） */
  panelLabel: string;
  /** 可用面板清单（注册表；切换器按它画） */
  panels: PanelDescriptor[];
  /** 预览中的文件（可能没有） */
  preview?: FilePreview;
  /** 文件树门面（与主区工作区页签同源） */
  files: FileTreeFacade;
  /** 已筛好的交付物条目（筛选是纯模型） */
  deliverables: TrajectoryItem[];
  /** 已筛好的子代理条目 */
  subagents: TrajectoryItem[];
  /** 已筛好的工具条目 */
  tools: TrajectoryItem[];
  /** 轨迹面板要的条目 */
  trajectoryItems: TrajectoryItem[];
  /** 时间总览要的统计 */
  stats: SessionStatsInput;
  /** 切面板（经注册表校验） */
  onSelectPanel: (panelId: string) => void;
  /** 把文件投喂到输入区 */
  onAttachFile: (node: FileNode) => void;
  /** 详情面板的行内复制 */
  onLineTap: (section: string, text: string) => void;
}


@Component
export struct RightbarShell {
  /** 呈现方式（由 `LayoutController.detailPresentation` 给；这里只映射布局） */
  @Prop presentation: DetailPresentation = DetailPresentation.COLUMN;
  /** 宽度（三栏 = 槽位宽度；侧边面板 = 夹取后的宽度；Sheet 忽略它） */
  @Prop widthVp: number = 0;
  /** 面板内容（宿主投影好的 sections） */
  /**
   * 右侧内容的门面（P2-12）：**两个挂载点共用这一份**。
   *
   * 【为什么是一个门面而不是十几个 prop】本组件有两个挂载点（三栏的真右栏与「详情」浮层），
   * 此前两处各拼一遍同样的十几个值 —— 只要一处漏改，同一个面板在两种呈现下就会不一样。
   * 门面把"怎么投影、往哪儿转发"收在一处；每个挂载点只提供**它自己那份**
   * （`presentation` / `widthVp` / `sections` / `onClose`）。
   */
  @Prop f: RightbarFacade;
  @Prop sections: DetailSection[] = [];
  /**
   * 当前该显示哪个右栏面板（`NavigationState.selectedRightPanel`）。
   *
   * 【P3-1：这个 prop 让右栏第一次**真的**按面板分派】此前它无条件渲染 `DetailPane`，
   * 于是 `selectedRightPanel` 在模型里躺了好几轮没有消费者（"通道有、没接"）。
   * 现在：可用面板由 `PanelRegistry` 决定（只有「详情」有内容），选择经注册表校验，
   * 视图只按 id 分派 —— 后续把某个候选面板的内容视图做出来，只需把它的 `available` 改成 true。
   */
  /** 当前面板的中文名（标题行用；来自 descriptor 的 `label`，找不到时由宿主兜底） */
  /**
   * 这条轨道上**可用**的面板清单（注册表给）。
   *
   * 【为什么由宿主给】"哪些面板可用"是注册表的判定（内容做了没有）；视图只按清单画切换器。
   * 只有一个可用面板时**不画切换器**——一行只有一个选项的按钮组是噪声。
   */
  /** 预览面板的内容（`undefined` = 空态"选择文件以预览"） */
  /** 「文件」面板的内容与回调（树 / 选中项 / 空态文案 / 两个回调，打包成一个门面） */
  /** 「交付物」面板的内容（宿主已按种类筛好；空数组 = 空态） */
  /** 「子代理」面板的内容（同上；筛选规则同为纯模型 `itemsOfKind`） */
  /** 「工具」面板的内容（同上） */
  /** 「轨迹」面板的内容：本会话的全部过程条目（总览自己算格子与比例） */
  /** 「轨迹」面板的会话统计（总览右上角那四项） */

  /**
   * 工具面板里**被用户手动展开过**的条目 id。
   *
   * 【为什么这里可以有本地状态】主区的"展开全部/收起全部"只管主区那份列表；
   * 右栏面板的展开属于面板自己的交互状态，放在它自己身上比往宿主再串一条数组更诚实
   * （卡片的 `expanded` 仍是入参 —— 组件本身不持状态，见 `ToolCard` 的说明）。
   */
  @State toolExpanded: string[] = [];
  /** 「轨迹」总览在右栏里聚焦的格子（右栏**不滚动主列表**，故只高亮不跳转） */
  @State timelineFocused: string = '';
  /** 「轨迹」总览是否正在拖动（受控项：拖动期间暂停"列表 → 条"，与主区同一判据） */
  @State timelineDragging: boolean = false;

  /** 切换右栏面板（宿主经注册表校验后落到 `selectedRightPanel`） */
  /** 「投喂」预览中的文件（副作用归宿主） */

  onClose: () => void = () => {
  };

  /**
   * 交付物面板的内容：一张张 `DeliverableCard`（与会话过程流共用同一份卡）。
   *
   * 【空态为什么必然存在】"本次会话还没有交付物"是常态而非异常（不可能靠 `available` 关掉面板：
   * 注册表在启动时建一次，而交付物是随会话变化的）。所以这里给一句如实的空态，
   * 而不是"面板可点、点进去空空如也"。
   */
  @Builder
  deliverablesBody() {
    if (this.f.deliverables.length === 0) {
      Column({ space: Sp.S }) {
        Text('本次会话还没有交付物')
          .fontSize(Fs.SECONDARY)
          .fontColor($r('sys.color.font_secondary'))
        Text('助手产出文件时，会在这里列出')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .textAlign(TextAlign.Center)
      }
      .width('100%')
      .layoutWeight(1)
      .justifyContent(FlexAlign.Center)
      .padding(Sp.M)
    } else {
      List({ space: Sp.S }) {
        ForEach(this.f.deliverables, (item: TrajectoryItem) => {
          ListItem() {
            DeliverableCard({ item: item })
          }
        }, (item: TrajectoryItem) => item.id)
      }
      .width('100%')
      .layoutWeight(1)
      .padding(Sp.S)
      .scrollBar(BarState.Auto)
    }
  }

  /** 子代理面板的内容：一张张 `SubagentCard`（与过程流共用同一份卡） */
  @Builder
  subagentsBody() {
    if (this.f.subagents.length === 0) {
      Column({ space: Sp.S }) {
        Text('本次会话还没有子代理')
          .fontSize(Fs.SECONDARY)
          .fontColor($r('sys.color.font_secondary'))
        Text('助手派生子代理时，会在这里列出')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .textAlign(TextAlign.Center)
      }
      .width('100%')
      .layoutWeight(1)
      .justifyContent(FlexAlign.Center)
      .padding(Sp.M)
    } else {
      List({ space: Sp.S }) {
        ForEach(this.f.subagents, (item: TrajectoryItem) => {
          ListItem() {
            SubagentCard({ item: item })
          }
        }, (item: TrajectoryItem) => item.id)
      }
      .width('100%')
      .layoutWeight(1)
      .padding(Sp.S)
      .scrollBar(BarState.Auto)
    }
  }

  /** 工具面板的内容：一张张 `ToolCard`（与过程流共用同一份卡；展开态见 `toolExpanded` 的说明） */
  @Builder
  toolsBody() {
    if (this.f.tools.length === 0) {
      Column({ space: Sp.S }) {
        Text('本次会话还没有工具调用')
          .fontSize(Fs.SECONDARY)
          .fontColor($r('sys.color.font_secondary'))
        Text('助手调用工具时，会在这里列出参数与改动')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .textAlign(TextAlign.Center)
      }
      .width('100%')
      .layoutWeight(1)
      .justifyContent(FlexAlign.Center)
      .padding(Sp.M)
    } else {
      List({ space: Sp.S }) {
        ForEach(this.f.tools, (item: TrajectoryItem) => {
          ListItem() {
            ToolCard({
              item: item,
              // 与主区同一套判据：手动展开过，或模型说这类工具默认展开
              expanded: this.toolExpanded.indexOf(item.id) >= 0
                || presentTool(item, toolStateLabel(item.toolState)).defaultExpanded,
              onToggle: () => {
                this.toggleTool(item.id);
              }
            })
          }
        }, (item: TrajectoryItem) => item.id)
      }
      .width('100%')
      .layoutWeight(1)
      .padding(Sp.S)
      .scrollBar(BarState.Auto)
    }
  }

  /** 展开/收起一张工具卡（与主区 `toggle(id)` 同一语义：在集合里加/删） */
  private toggleTool(id: string): void {
    const out: string[] = [];
    let found: boolean = false;
    for (let i = 0; i < this.toolExpanded.length; i++) {
      if (this.toolExpanded[i] === id) {
        found = true;
      } else {
        out.push(this.toolExpanded[i]);
      }
    }
    if (!found) {
      out.push(id);
    }
    this.toolExpanded = out;
  }

  /**
   * 轨迹面板：**只放时间总览**（见 `PanelRegistry` 里这一项的说明）。
   *
   * 【为什么不在右栏放全量台账】那是主区「轨迹视图」的职责；320vp 里照抄一遍，
   * 既看不清也没必要。这里给的是"这次会话的时间分布 + 聚焦那一格的详情"。
   *
   * 【为什么右栏聚焦不滚列表】主区此刻可能根本不在轨迹视图（用户在对话视图里），
   * 这时"跳过去"会把人从正在读的内容上拽走。故右栏只高亮 + 显示详情行。
   */
  @Builder
  trajectoryBody() {
    if (this.f.trajectoryItems.length === 0) {
      Column({ space: Sp.S }) {
        Text('本次会话还没有过程数据')
          .fontSize(Fs.SECONDARY)
          .fontColor($r('sys.color.font_secondary'))
        Text('助手开始工作后，这里会给出时间分布')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .textAlign(TextAlign.Center)
      }
      .width('100%')
      .layoutWeight(1)
      .justifyContent(FlexAlign.Center)
      .padding(Sp.M)
    } else {
      Column() {
        TimelineOverview({
          items: this.f.trajectoryItems,
          stats: this.f.stats,
          focusedCellId: this.timelineFocused,
          dragging: this.timelineDragging,
          onFocusCell: (cellId: string) => {
            this.timelineFocused = cellId;
          },
          /*
           * 【轨迹总览的 onCommit：本面板**有意**不滚动】
           *
           * `TimelineOverview` 在松手/点击落定时调 `onCommit()`，语义是"落定后滚列表"。
           * 主区（`ConversationPane`）接的是 `scrollToFocusedCell()`；而**右栏这里只高亮**，
           * 不滚任何东西 —— 依据是本组件 `timelineFocused` 的既有说明：
           * "右栏**不滚动主列表**，故只高亮不跳转"（见上方 @State 注释）。
           *
           * 为什么不干脆从 `TimelineOverview` 删掉这个回调：它是**必填 prop**（不传编译不过），
           * 且主区确实需要它。因此右栏传一个写明理由的空实现，而不是留裸 `() => {}`
           * （裸空体会被死按钮扫描门禁报出来，也会让读者以为漏接线）。
           */
          onCommit: () => {
            // 故意为空：右栏只高亮、不滚动主列表（见上）
          },
          onDragChange: (dragging: boolean) => {
            this.timelineDragging = dragging;
          }
        })
      }
      .width('100%')
      .padding({ top: Sp.S })
    }
  }

  /**
   * 面板切换器（P2-13）：**两种呈现共用一份**。
   *
   * 【为什么现在必须共用】此前它只画在 `framedBody`（真右栏 / 侧边浅层面板）里，
   * 而**单栏的详情 Sheet** 那一份（`sheetBody`）没有它 ⇒ 手机用户打开详情后
   * **无法切到文件 / 预览 / 工具 / 子代理 / 交付物 / 轨迹**：要么先关掉再想别的办法，
   * 要么根本不知道还有别的面板。本仓已登记为 P3 缺口之一。
   *
   * 【为什么 ≥2 个可用面板才出现】只有一个面板时，一行只有一个选项的按钮组是噪声。
   */
  @Builder
  panelSwitcher() {
    if (this.f.panels.length > 1) {
      Row({ space: Sp.XS }) {
        ForEach(this.f.panels, (d: PanelDescriptor) => {
          NativeChip({
            label: d.label,
            active: d.id === this.f.panelId,
            a11y: `右栏面板：${d.label}`,
            onTap: () => {
              this.f.onSelectPanel(d.id);
            }
          })
        }, (d: PanelDescriptor) => d.id)
      }
    }
  }

  /** 并排（真右栏）与侧边浅层面板共用一套带标题行的形态 */
  @Builder
  framedBody() {
    Column() {
      Row({ space: Sp.S }) {
        Text(this.f.panelLabel)
          .fontSize(Fs.SECONDARY)
          .fontWeight(FontWeight.Medium)
          .layoutWeight(1)
        this.panelSwitcher()
        Button() {
          SymbolGlyph($r('sys.symbol.xmark')).fontSize(HarmonyIconSize.INLINE)
        }
        .buttonStyle(ButtonStyleMode.TEXTUAL)
        .accessibilityText(`关闭${this.f.panelLabel}面板`)
        .onClick(() => {
          this.onClose();
        })
      }
      .width('100%')
      .height(Sz.TOUCH_MIN)
      .padding({ left: Sp.M, right: Sp.S })

      Divider().color($r('sys.color.comp_divider'))

      // 按面板 id 分派：内容视图做了的候选才会 available（其余选不进来）
      if (this.f.panelId === PANEL_RIGHT_DETAIL) {
        DetailPane({
          sections: this.sections,
          onLineTap: (section: string, text: string) => {
            this.f.onLineTap(section, text);
          }
        })
      } else if (this.f.panelId === PANEL_RIGHT_TRAJECTORY) {
        this.trajectoryBody()
      } else if (this.f.panelId === PANEL_RIGHT_TOOL) {
        this.toolsBody()
      } else if (this.f.panelId === PANEL_RIGHT_SUBAGENT) {
        this.subagentsBody()
      } else if (this.f.panelId === PANEL_RIGHT_DELIVERABLES) {
        this.deliverablesBody()
      } else if (this.f.panelId === PANEL_RIGHT_FILES) {
        // 与工作区页签的文件树**同一份**呈现（FileTreePane）
        FileTreePane({ f: this.f.files })
      } else if (this.f.panelId === PANEL_RIGHT_PREVIEW) {
        // 与工作区页签的预览**同一份**呈现（FilePreviewPane）
        FilePreviewPane({
          preview: this.f.preview,
          onAttachFile: (node: FileNode) => {
            this.f.onAttachFile(node);
          }
        })
      }
    }
    .width(this.widthVp)
    .height('100%')
    .backgroundColor($r('sys.color.background_secondary'))
  }

  /** 单栏：Sheet 内容（关闭由原生 Sheet 提供，标题用区块标题而不是自造一行） */
  @Builder
  sheetBody() {
    Column({ space: HarmonySpacing.CONTAINER }) {
      // 单栏 Sheet：**切换器顶在内容之上**（它就是这一层的标题）。
      // 此前这里是一行「面板名 + 固定提示『工具 / 子代理 / 交付物 / 目标 / 任务』」——
      // 那句提示对文件/预览/详情三个面板是**错的措辞**（界面不撒谎），而且它也没告诉用户
      // "还能切到别的面板"。切换器的当前项高亮同时承担了"我在看哪个面板"。
      this.panelSwitcher()
      if (this.f.panelId === PANEL_RIGHT_DETAIL) {
        DetailPane({
          sections: this.sections,
          onLineTap: (section: string, text: string) => {
            this.f.onLineTap(section, text);
          }
        })
      } else if (this.f.panelId === PANEL_RIGHT_TRAJECTORY) {
        this.trajectoryBody()
      } else if (this.f.panelId === PANEL_RIGHT_TOOL) {
        this.toolsBody()
      } else if (this.f.panelId === PANEL_RIGHT_SUBAGENT) {
        this.subagentsBody()
      } else if (this.f.panelId === PANEL_RIGHT_DELIVERABLES) {
        this.deliverablesBody()
      } else if (this.f.panelId === PANEL_RIGHT_FILES) {
        // 与工作区页签的文件树**同一份**呈现（FileTreePane）
        FileTreePane({ f: this.f.files })
      } else if (this.f.panelId === PANEL_RIGHT_PREVIEW) {
        FilePreviewPane({
          preview: this.f.preview,
          onAttachFile: (node: FileNode) => {
            this.f.onAttachFile(node);
          }
        })
      }
    }
    .width('100%')
    .height('100%')
    .padding(HarmonySpacing.CONTAINER)
  }

  build() {
    if (this.presentation === DetailPresentation.OVERLAY) {
      this.sheetBody()
    } else {
      this.framedBody()
    }
  }
}
