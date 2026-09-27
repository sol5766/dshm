/**
 * 主区页头（P0：AppFrame 中间轨道的 chrome）。
 *
 * ## 为什么单独成组件
 *
 * 与 `SidebarShell` / `RightbarShell` 同族：主轨道的**页头**是它的职责，而不是宿主装配器的。
 * 它替代了原先 `Index.header()` 里那段直接读宿主状态的代码——原来它读 `stackPage` / `mode` /
 * `headerTitle()` 并直接写 `stackPage` 与 `detailOverlayOpen`，即"页头知道宿主的内部字段"。
 * 现在它只认自己的 props 与两个回调。
 *
 * ## 语义（照官方 ConversationHeader，不机械抄组件）
 *
 * | 位置 | 内容 |
 * |---|---|
 * | 左 | **返回**（只在有下钻页时出现——非下钻时不该有一个点了没反应的返回箭头） |
 * | 中 | 当前标题（会话标题 / 页名），单行省略 |
 * | 右 | **详情入口**（只在会话页且不是三栏时出现——三栏下详情是真右栏，不需要这个入口） |
 *
 * 【为什么两个条件都写在 props 里而不是组件内部判断】组件不该知道"三栏/双栏"这种几何事实，
 * 也不该知道"有没有下钻页"这种导航事实——那是宿主的判定（几何层 `ui/ShellTracks`、
 * 导航层 `activeMainPanelOf`）。组件只回答"这两个入口现在要不要出现"。
 */

import { Fs, HarmonyColor, HarmonyIconSize, HarmonyRadius, HarmonyType, Sp, Sz } from 'appstate';

@Component
export struct MainHeaderShell {
  /** 标题（会话标题或页名；由宿主给） */
  @Prop title: string = '';
  /** 是否显示返回（有下钻页时才有意义） */
  @Prop showBack: boolean = false;
  /** 是否显示详情入口（会话页 + 非三栏） */
  @Prop showDetailEntry: boolean = false;
  /**
   * 是否给"打开导航抽屉"的入口（仅单栏档位的根页）。
   *
   * 【为什么由宿主判定】"这条轨道上有没有可折叠的侧栏"是几何事实（`LayoutMode`），
   * 组件不该知道；组件只负责画一个按钮。
   */
  @Prop showNav: boolean = false;

  onBack: () => void = () => {
  };
  onOpenDetail: () => void = () => {
  };
  onOpenNav: () => void = () => {
  };

  build() {
    Row({ space: Sp.S }) {
      if (this.showNav) {
        Button() {
          // 用"列表"符号表达"另一条轨道在这里"——手机侧栏抽屉（官方同位置也是这个语义）
          SymbolGlyph($r('sys.symbol.list_bullet')).fontSize(HarmonyIconSize.NAV)
        }
        .buttonStyle(ButtonStyleMode.TEXTUAL)
        .accessibilityText('打开导航（工作区与会话列表）')
        .onClick(() => {
          this.onOpenNav();
        })
      }
      if (this.showBack) {
        Button() {
          SymbolGlyph($r('sys.symbol.chevron_left')).fontSize(HarmonyIconSize.NAV)
        }
        .buttonStyle(ButtonStyleMode.TEXTUAL)
        .accessibilityText('返回')
        .onClick(() => {
          this.onBack();
        })
      }
      Text(this.title)
        .fontSize(Fs.TITLE_L)
        .fontWeight(FontWeight.Bold)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)

      if (this.showDetailEntry) {
        Text('详情')
          .fontSize(HarmonyType.LABEL.size)
          .fontColor(HarmonyColor.BRAND)
          .padding({ left: Sp.S, right: Sp.S, top: Sp.XS, bottom: Sp.XS })
          .borderRadius(HarmonyRadius.CHIP)
          .backgroundColor(HarmonyColor.SURFACE_RAISED)
          .accessibilityText('打开详情面板（会话内容保持可见）')
          .onClick(() => {
            this.onOpenDetail();
          })
      }
    }
    .width('100%')
    .height(Sz.HEADER)
    .padding({ left: Sp.M, right: Sp.S })
  }
}
