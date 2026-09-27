/**
 * 文件树（P3-3：从 `WorkspacePane` 抽出的**共用**呈现）。
 *
 * ## 为什么抽出来
 *
 * 「文件」是官方右栏的第一个面板（`ui-workspace` 的文件视图），而本仓这段树原先只长在
 * 工作区页签的第二列里。右栏与页签要的是**同一份**树（同一套展开/选中/交付物标记），
 * 抄一份必然走样 ⇒ 抽成组件，谁挂都行。
 *
 * ## 空态文案为什么由宿主给
 *
 * 「空」有好几种完全不同的原因，处置建议各不相同：
 *   · 还没选工作区 → 让他选；
 *   · 选了但该目录下没有会话 → 文件端点的作用域是**会话级**，得先在该目录建会话；
 *   · 列目录失败 → 让他去看诊断。
 * 写死一句「在 Host 侧确认目录可读」会把前两种误诊成第三种（用户按错方向去查）。
 * 故 `emptyTitle` / `emptyHint` 是**入参**，由宿主按当前事实给。
 */

import { FileNode, Fs, NodeKind, Radius, Sp, Sz, fileSummary, formatBytes } from 'appstate';

/**
 * 「文件」面板要用的全部东西。
 *
 * 【为什么打包成一个门面而不是 6 个 props】树、选中项、空态文案、两个回调是**同一件事**的六个面；
 * 分开传会让右栏的 props 面继续变胖，而且"少传一个"表现为**点不动**（静默失效）。
 */
export interface FileTreeFacade {
  tree: FileNode[];
  selectedPath: string;
  emptyTitle: string;
  emptyHint: string;
  onToggleDirectory: (path: string) => void;
  onOpenFile: (node: FileNode) => void;
}

@Component
export struct FileTreePane {
  /** 树与回调（宿主每次渲染重建，同 `AppShell` 的门面口径） */
  @Prop f: FileTreeFacade;

  build() {
    Column() {
      if (this.f.tree.length === 0) {
        Column({ space: Sp.S }) {
          SymbolGlyph($r('sys.symbol.folder')).fontSize(32)   // token-exempt: 空态插画尺寸，不属于排版层级
            .fontColor([$r('sys.color.font_tertiary')])
          Text(this.f.emptyTitle)
            .fontSize(Fs.SECONDARY)
            .fontColor($r('sys.color.font_secondary'))
          Text(this.f.emptyHint)
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_tertiary'))
            .textAlign(TextAlign.Center)
            .padding({ left: Sp.L, right: Sp.L })
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else {
        List() {
          ForEach(this.f.tree, (node: FileNode) => {
            ListItem() {
              this.treeRow(node, 0)
            }
            if (node.kind === NodeKind.DIRECTORY && node.loaded) {
              ForEach(node.children, (child: FileNode) => {
                ListItem() {
                  this.treeRow(child, 1)
                }
              }, (child: FileNode) => child.path)
            }
          }, (node: FileNode) => node.path)
        }
        .layoutWeight(1)
        .width('100%')
        .padding(Sp.S)
        .scrollBar(BarState.Auto)
      }
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  treeRow(node: FileNode, depth: number) {
    Row({ space: Sp.S }) {
      Text('　'.repeat(depth))
        .fontSize(Fs.CAPTION)
      SymbolGlyph(node.kind === NodeKind.DIRECTORY
        ? (node.loaded ? $r('sys.symbol.folder') : $r('sys.symbol.folder'))
        : $r('sys.symbol.doc_text'))
        .fontSize(14)   // token-exempt: 树行内图标的几何尺寸（与 HarmonyIconSize.STATUS 同档，未收敛）
        .fontColor([node.deliverable ? $r('sys.color.brand') : $r('sys.color.font_secondary')])

      Text(node.name)
        .fontSize(Fs.SECONDARY)
        .fontColor(this.f.selectedPath === node.path
          ? $r('sys.color.brand')
          : $r('sys.color.font_primary'))
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })

      if (node.deliverable) {
        Text('交付物')
          .fontSize(Fs.CAPTION_XS)
          .fontColor($r('sys.color.brand'))
          .padding({ left: 5, right: 5 })   // token-exempt: 徽标药丸的内边距
          .borderRadius(5)   // token-exempt: 徽标药丸圆角
          .backgroundColor($r('sys.color.background_secondary'))
      }

      Text(fileSummary(node, formatBytes))
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_tertiary'))
    }
    .width('100%')
    .height(Sz.TOUCH_MIN - 6)
    .padding({ left: Sp.S, right: Sp.S })
    .borderRadius(Radius.S)
    .backgroundColor(this.f.selectedPath === node.path
      ? $r('sys.color.background_secondary')
      : Color.Transparent)
    .onClick(() => {
      if (node.kind === NodeKind.DIRECTORY) {
        this.f.onToggleDirectory(node.path);
      } else {
        this.f.onOpenFile(node);
      }
    })
  }
}
