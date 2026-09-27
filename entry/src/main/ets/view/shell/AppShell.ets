/**
 * AppFrame：三形态轨道布局 + 轨道 chrome —— P0 chrome 的最后一块。
 *
 * ## 这个组件拥有什么
 *
 * 「窗口宽度分成几条轨道、每条轨道怎么摆」是 **AppFrame** 的事，与「轨道里有什么」无关：
 *   · `buildSingle` / `buildDouble` / `buildTriple` —— 三形态的轨道拼装；
 *   · `header` —— 中间轨道的页头（内容归 `MainHeaderShell`，这里只给几何/导航事实）；
 *   · `navPanel` / `bottomTabs` —— 侧栏的两种 surface（并排轨道 / 底部标签；手机的抽屉走 `sidePanelSurface`）；
 *     **并排轨道的呈现不是常量**（rail ↔ panel 由用户决定）⇒ 只有 `navPanel` 一处算它（E366）；
 *   · `detailColumn` / `detailResizer` —— 右栏的 surface 与轨间把手；
 *   · `sidebarPresentation` / `headerTitle` —— 「哪条轨道该以什么形式出现」的判定。
 *
 * 【为什么 `bindSheet` 不在这里】浮层门户挂在**页面根**（`Index.build`）而不是某个轨道的根节点：
 * 原先它挂在单栏根 Column 上 ⇒ 双栏/三栏下模型选择/凭据/目录/整值编辑浮层**够不着**。
 * 门户与布局无关是官方 Web `App` 的语义（portal 在 App 根，不在某个 pane 里）。
 *
 * 【门面】同 `MainShell`：值型快照 + 写型 setter + 方法型闭包，宿主每次渲染重建。
 * 本束被写的宿主状态共 2 个（detailOverlayOpen, stackPage），已改写成 setter 调用（3 处）——
 * 普通属性会让赋值落进门面副本、宿主收不到（静默行为错误）。
 */

import { DetailPresentation, DetailSection, LayoutMode, MAIN_DIAGNOSTICS, StackPage, Sz, TrackPresentation, shellTracksOf, showsConversation, sidebarPresentationOf } from 'appstate';
import { copyText } from 'platform';

import type { FileNode, FilePreview, PanelDescriptor, SessionStatsInput, TrajectoryItem } from 'appstate';
import { MainHeaderShell } from './MainHeaderShell';
import { MainShell } from './MainShell';
import type { MainShellFacade } from './MainShell';
import type { RightbarFacade } from './RightbarShell';
import type { WorkspaceBrowserFacade } from '../WorkspaceBrowser';
import type { FileTreeFacade } from '../FileTreePane';
import { RightbarShell } from './RightbarShell';
import { SidebarShell } from './SidebarShell';
import { TrackResizer } from './TrackResizer';

export interface AppShellFacade {
  activePanel: () => string;
  appName: string;
  /** 工作区→会话浏览器（侧栏 PANEL 呈现里用；其余呈现不接受它） */
  browser: WorkspaceBrowserFacade;
  /**
   * 当前高亮的侧栏席位 id（空串 = 不高亮任何一项）。
   *
   * 【为什么由宿主给】"哪一项算选中"取决于**选中的主区面板**（`sidebarPanelOfMainPanel`）——
   * 视图不该自己拼这条线索（会话/诊断/连接没有侧栏席位的那件事，只该写在模型里一处）。
   */
  selectedSidebarPanel: string;
  /**
   * 侧栏是否展开（P2-15）。
   *
   * 【为什么是布尔而不是三态】"没存过时用什么"已经由宿主按**形态**判完
   * （`sidebarExpandedForMode`：双栏默认 rail、三栏默认 panel）——视图只读生效值。
   */
  sidebarExpanded: boolean;
  /**
   * 侧栏**轨道**宽度（P5-2）：跟随实际呈现（panel 240 / rail 56 / 浮层 0）。
   *
   * 【为什么不能再用布局决策里的 nav 宽度】那是**形态默认**：三栏收起侧栏之后
   * 决策仍是 240vp，于是"腾出宽度"只发生在呈现上、没发生在几何上。判定收在
   * `sidebarTrackWidthOf`（纯函数，有 fixture），这里只读结论。
   */
  sidebarTrackWidthVp: () => number;
  /** 收起 / 展开侧栏 */
  onToggleSidebarExpanded: () => void;
  /** 选中某个侧栏席位（宿主翻译成"切到哪个主区面板"，并经注册表校验） */
  onSelectSidebarPanel: (panelId: string) => void;
  /** 新建会话（侧栏一级入口；与 Ctrl+N 走同一条路） */
  onNewSession: () => void;
  /** 手机侧栏抽屉是否打开（单栏档位；模型 `NavigationState.mobileDrawer` 是唯一真值） */
  mobileDrawerOpen: boolean;
  /** 打开手机侧栏抽屉（页头的导航入口） */
  onOpenDrawer: () => void;
  /** 收起手机侧栏抽屉（点抽屉外部 / 选了入口 / 返回键） */
  onCloseDrawer: () => void;
  /**
   * 右栏内容的门面（P2-12）：**详情浮层用同一份**。
   *
   * 【为什么收成一个】`RightbarShell` 有两个挂载点（这里的三栏真右栏、`Index` 的详情浮层）。
   * 此前本门面透传十来个 `right*` 值，而浮层那一份在页面根**内联重算** ——
   * 只要一处漏改，同一个面板在两种呈现下就会不一样。现在两处都吃同一个 `RightbarFacade`。
   */
  rightbar: RightbarFacade;
  /** 当前面板的中文名（页头标题用；由注册表的 label 给） */
  panelLabel: string;
  beginDetailDrag: () => void;
  closeDetail: () => void;
  detailOpen: boolean;
  detailOverlayOpen: boolean;
  setDetailOverlayOpen: (value: boolean) => void;
  detailPresentationNow: () => DetailPresentation;
  detailSections: DetailSection[];
  detailWidthVp: () => number;
  endDetailDrag: () => void;
  gripHitWidth: () => number;
  mainShell: MainShellFacade;
  mode: LayoutMode;
  openDiagnostics: () => void;
  pendingBadge: string;
  selectedSessionTitle: string;
  showsConversation: () => boolean;
  sidePanelWidthVp: () => number;
  stackPage: StackPage;
  setStackPage: (value: StackPage) => void;
  updateDetailDrag: (deltaXVp: number) => void;
}

@Component
export struct AppShell {

  /** 轨道所需能力的门面（**每次渲染重建**） */

  @Prop f: AppShellFacade;

  @Builder
  buildSingle() {
    /*
     * 单栏（手机）：侧栏在官方就是**盖在页面上的一层**（抽屉），不是底部标签栏 ——
     * 所以这里用 `Stack` 把页面与抽屉叠起来。底部标签栏**暂时保留**（过渡呈现）：
     * 抽屉是**新增**的导航面，本轮不夺走任何既有入口（取舍说明见 `docs/50` E306）。
     */
    Stack({ alignContent: Alignment.TopStart }) {
      Column() {
        this.header()
        Divider().color($r('sys.color.comp_divider'))
        Column() {
          MainShell({ f: this.f.mainShell, compact: true })
        }
        .layoutWeight(1)
        .width('100%')
        if (this.f.stackPage === StackPage.MAIN) {
          this.bottomTabs()
        }
      }
      .width('100%')
      .height('100%')

      if (this.f.mobileDrawerOpen) {
        // 透明点击层承担"点抽屉外收起"：本仓规矩是**遮罩由原生 Sheet 提供、不手写颜色**
        // （手写 rgba 会绕过设计令牌与深色模式）——与 `buildDouble` 的侧边浅层面板同款处理。
        Column()
          .width('100%')
          .height('100%')
          .onClick(() => {
            this.f.onCloseDrawer();
          })
        this.sidePanelSurface(TrackPresentation.PANEL, Sz.NAV_PANEL)
      }
    }
    .width('100%')
    .height('100%')
  }

  private headerTitle(): string {
    if (this.f.stackPage === StackPage.CONVERSATION) {
      return this.f.selectedSessionTitle.length > 0 ? this.f.selectedSessionTitle : '会话';
    }
    if (this.f.activePanel() === MAIN_DIAGNOSTICS) {
      return '连接诊断';
    }
    if (this.f.stackPage === StackPage.CONNECT) {
      // 新架构下"连接一台远程 Host"是**可选能力**（D7 §3 第 1 项），
      // 因此标题不再叫"添加 Host"——那会让用户以为这是必经步骤。
      return '远程 Host（可选）';
    }
    return this.f.panelLabel.length > 0 ? this.f.panelLabel : this.f.appName;
  }

  @Builder
  header() {
    // 主区页头归 MainHeaderShell 所有（P0：中间轨道的 chrome）；这里只把**导航与几何事实**
    // 换算成"两个入口要不要出现"（组件不该知道 stackPage/mode 这类事实）。
    MainHeaderShell({
      title: this.headerTitle(),
      showBack: this.f.stackPage !== StackPage.MAIN,
      // 手机才有抽屉；且只在**根页**给这个入口（有返回键时左侧只留一个按钮，不让用户猜）
      showNav: this.f.mode === LayoutMode.SINGLE && this.f.stackPage === StackPage.MAIN,
      showDetailEntry: this.f.stackPage === StackPage.CONVERSATION && this.f.mode !== LayoutMode.TRIPLE,
      onBack: () => {
        this.f.setStackPage(StackPage.MAIN);
      },
      onOpenDetail: () => {
        this.f.setDetailOverlayOpen(true);
      },
      onOpenNav: () => {
        this.f.onOpenDrawer();
      }
    })
  }

  @Builder
  bottomTabs() {
    // 侧栏内容归 SidebarShell 所有（P0：AppFrame 第一条轨道）；这里只给这条轨道的 surface。
    Column() {

      SidebarShell({
        brand: this.f.appName,
        browser: this.f.browser,
        selectedPanelId: this.f.selectedSidebarPanel,
        pendingBadge: this.f.pendingBadge,
        presentation: TrackPresentation.OVERLAY,
        onSelectPanel: (panelId: string) => {
          this.f.onSelectSidebarPanel(panelId);
        },
        onNewSession: () => {
          this.f.onNewSession();
        },
        onOpenDiagnostics: () => {
          this.f.openDiagnostics();
        },
        showExpandToggle: this.f.mode !== LayoutMode.SINGLE,
        onToggleExpanded: () => {
          this.f.onToggleSidebarExpanded();
        }
      })
    }
    .width('100%')
    .backgroundColor($r('sys.color.background_secondary'))
  }

  @Builder
  buildDouble() {

    Stack({ alignContent: Alignment.TopEnd }) {

      Row() {
        /*
         * 【为什么这里必须调 navPanel 而不是自己画一条 rail】双栏的侧栏呈现**不是常量**：
         * 默认是 rail（`shellTracksOf(DOUBLE).sidebar`），但用户可以展开成完整面板（P2-15）。
         * 这里曾经写死 `presentation: TrackPresentation.RAIL` ⇒ 点「展开侧栏」什么都不发生
         * （偏好变了、判定也变了，只有这一个调用点没问判定）——**死按钮**，且 D19 第 2 条
         * 在真机上必然失败。两份 surface 也必然走样，故只留 `sidePanelSurface` 一份。
         */
        this.navPanel()
        Divider().vertical(true).color($r('sys.color.comp_divider'))
        Column() {
          this.header()
          Divider().color($r('sys.color.comp_divider'))
          Column() {
            MainShell({ f: this.f.mainShell, compact: true })
          }
          .layoutWeight(1)
          .width('100%')
        }
        .layoutWeight(1)
        .height('100%')
      }
      .width('100%')
      .height('100%')
      /**
       * 详情的**侧边浅层面板**（P3 §12）。
       *
       * 【为什么不是半模态 Sheet】600–839vp 放不下"列表 + 真右栏"，但足够宽到让详情与列表
       * **同时可见**；用 Sheet 会把列表整个盖住，"边看列表边看详情"这件事就没了。
       *
       * 【为什么没有遮罩】本仓的规矩是"遮罩由原生 Sheet 提供、不手写颜色"（手写 rgba 会绕过
       * 设计令牌与深色模式）。故这里用一层**透明**点击层承担"点面板外关闭"，
       * 靠遮罩表达层级这件事留给真正需要模态的场合。
       */
      if (this.f.detailOverlayOpen && this.f.showsConversation()
        && this.f.detailPresentationNow() === DetailPresentation.SIDE_PANEL) {
        Column()
          .width('100%')
          .height('100%')
          .onClick(() => {
            this.f.setDetailOverlayOpen(false);
          })
        this.detailColumn(this.f.sidePanelWidthVp())
      }
    }
    .width('100%')
    .height('100%')
  }

  /**
   * 侧栏这条轨道这次用哪种呈现（P2-15）。
   *
   * 形态给**默认**，用户的"展开 / 收起"给**偏好** —— 判定在 `sidebarPresentationOf`
   * （纯函数、有 fixture）。单栏一律浮层（那个档位没有"展开的侧栏"）。
   */
  private sidebarPresentation(): TrackPresentation {
    return sidebarPresentationOf(this.f.mode, this.f.sidebarExpanded);
  }

  @Builder
  buildTriple() {

    Row() {
      this.navPanel()
      Divider().vertical(true).color($r('sys.color.comp_divider'))
      Column() {
        this.header()
        Divider().color($r('sys.color.comp_divider'))
        Column() {
          MainShell({ f: this.f.mainShell, compact: false })
        }
        .layoutWeight(1)
        .width('100%')
      }
      .layoutWeight(1)
      .height('100%')
      if (this.f.detailOpen && this.f.showsConversation()) {
        // 拖拽把手替代原来那条纯分隔线：它既是分隔（视觉上仍是一条细线），
        // 又是"调整栏宽"的唯一入口（此前模型里那条 desired 路径没有 UI 去产生宽度）。
        this.detailResizer()
        this.detailColumn(this.f.detailWidthVp())
      }
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  navPanel() {
    // 侧栏内容归 SidebarShell 所有（P0：AppFrame 第一条轨道）；这里只给**这条轨道的 surface**。
    this.sidePanelSurface(this.sidebarPresentation(), this.f.sidebarTrackWidthVp())
  }

  /**
   * 侧栏这条轨道的 surface（宽度 + 底色 + 挂载点）。
   *
   * 【为什么抽出来】同一份 surface 出现在两处：桌面/平板的固定轨道（`navPanel`）与
   * 手机的**抽屉**（`buildSingle`）。两处差别只有"呈现方式"与"宽度"，内容与回调完全一样——
   * 写两遍必然走样。
   */
  @Builder
  sidePanelSurface(presentation: TrackPresentation, widthVp: number) {
    Column() {
      SidebarShell({
        brand: this.f.appName,
        browser: this.f.browser,
        selectedPanelId: this.f.selectedSidebarPanel,
        pendingBadge: this.f.pendingBadge,
        presentation: presentation,
        onSelectPanel: (panelId: string) => {
          this.f.onSelectSidebarPanel(panelId);
        },
        onNewSession: () => {
          this.f.onNewSession();
        },
        onOpenDiagnostics: () => {
          this.f.openDiagnostics();
        },
        showExpandToggle: this.f.mode !== LayoutMode.SINGLE,
        onToggleExpanded: () => {
          this.f.onToggleSidebarExpanded();
        }
      })
    }
    .width(widthVp)
    .height('100%')
    .backgroundColor($r('sys.color.background_secondary'))
  }

  @Builder
  detailResizer() {
    // 轨间把手归 TrackResizer 所有（它不属于任何一条轨道）；宿主只把**输入模态决定的目标尺寸**
    // 与三个拖动回调交出去——拖动策略（起点归一化 / 可用空间夹取 / 左拖变宽）在纯模型里。
    TrackResizer({
      hitWidthVp: this.f.gripHitWidth(),
      onGripStart: () => {
        this.f.beginDetailDrag();
      },
      onGripUpdate: (deltaXVp: number) => {
        this.f.updateDetailDrag(deltaXVp);
      },
      onGripEnd: () => {
        this.f.endDetailDrag();
      }
    })
  }

  @Builder
  detailColumn(widthVp: number) {
    // 右栏面板本体归 RightbarShell 所有（P0：第三条轨道）；这里只给"这条轨道怎么出现"。
    RightbarShell({
      presentation: DetailPresentation.COLUMN,
      widthVp: widthVp,
      f: this.f.rightbar,
      sections: this.f.detailSections,
      onClose: () => {
        this.f.closeDetail();
      }
    })
  }

  build() {
    // 「哪个形态显示哪几条轨道」是 AppFrame 唯一的判定；轨道里的内容一律由各 shell 组件负责。
    if (this.f.mode === LayoutMode.SINGLE) {
      this.buildSingle()
    } else if (this.f.mode === LayoutMode.DOUBLE) {
      this.buildDouble()
    } else {
      this.buildTriple()
    }
  }
}
