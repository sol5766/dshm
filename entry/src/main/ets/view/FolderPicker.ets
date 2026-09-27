/**
 * 沙箱文件夹选择器（P2-9：从 `Index.ets` 抽出的第一个浮层组件，≈180 行）。
 *
 * ## 它拥有什么
 *
 * 一次"挑一个目录当工作区"的**全部状态与动作**：
 *   · 当前路径（`path`）、这一层的子目录（`dirs`）、提示（`note`）、开合（`open`）；
 *   · 读目录 / 进子目录 / 上一级 / 新建文件夹 / 选定（`list` / `goInto` / `goUp` / `create` / `choose`）。
 *
 * ## 为什么它该独立（而不是继续长在宿主里）
 *
 * 这段代码此前与**七个浮层**（详情 / 选择 / 凭据 / 文本设置 / 结构设置 / 文件夹 / 剪贴板）
 * 一起挤在 `Index.ets`（4480 行）里，而且它的状态（`folderOpen/folderPath/folderDirs/folderNote`）
 * 与"选择浮层"的一个入口共用 —— 读代码时很难看出"这块 UI 归谁"。
 * 抽出来之后：**谁的浮层谁持有状态**（这也是 E353 修完之后三个浮层各自自足的同一方向）。
 *
 * ## 打开它的两种入口（所以用控制器而不是 prop）
 *
 * ① 设置里的「工作区 → 选择文件夹」（选择浮层的一个选项）；
 * ② 沙箱选择器不可用时的**降级入口**（系统文件选择器异常 → 用沙箱内目录兜底）。
 * 两处都只是"叫它打开一次并带一句话说明为什么"，故用与 `TurnViewController` 同一个形状的
 * **控制器对象**：宿主持句柄、组件注册实现。真值（`open`）在组件内。
 *
 * ## 边界（留在宿主）
 *
 * · **`filesDirOf()`**：沙箱根来自 `UIAbilityContext`，那是**平台能力**（宿主才拿得到
 *   `getContext`），组件只吃一个字符串；
 * · **选定之后的副作用**（注册工作区 / 就地开会话 / 提示文案）在宿主：它要动中枢与导航。
 */

import { Fs, HarmonySpacing, Radius, Sp } from 'appstate';
import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';

/**
 * 打开沙箱文件夹选择器（宿主持句柄、组件注册实现）。
 *
 * 与 `TurnViewController` 同源：宿主在**别的浮层**里点一下就要唤起它，
 * 而"当前路径/子目录/提示"这些状态只有组件自己需要。
 */
export class FolderPickerController {
  private opener: (reason: string) => void = () => {
  };
  private closer: () => void = () => {
  };

  /** 由 `FolderPicker.aboutToAppear` 注册 */
  register(open: (reason: string) => void, close: () => void): void {
    this.opener = open;
    this.closer = close;
  }

  /** 打开（`reason` 会作为提示显示在选择器里——为什么突然弹出这一层） */
  open(reason: string): void {
    this.opener(reason);
  }

  /**
   * 关掉。
   *
   * 【为什么控制器上必须有"关"】原生 Sheet 的关闭路径（下拉 / 点遮罩 / 关闭按钮）
   * **不经过本组件**，而宿主的 `closeSheet()` 要"一处复位全部"⇒ 它只能调这个方法。
   * 少了它，原生关闭之后组件内的 `open` 仍是真值，浮层再也打不开
   * （本仓在 `bindContextMenu` 上踩过同一个坑：`onDisappear` 必须复位）。
   */
  close(): void {
    this.closer();
  }
}

/** 沙箱目录里的文件夹选择器（不申请公共存储权限，只能在应用沙箱内走） */
@Component
export struct FolderPicker {
  /** 沙箱根（宿主从 `UIAbilityContext.filesDir` 给；空串 = 拿不到 ⇒ 不打开） */
  @Prop sandboxRoot: string = '';
  /** 默认起点（宿主记的"上次用过的目录"；空串则用 `沙箱根/workspace`） */
  @Prop startDir: string = '';
  /** 控制器：宿主在别处唤起它 */
  @Prop controller: FolderPickerController;
  /** 选定一个目录（副作用在宿主：注册工作区 + 就地开会话 + 提示） */
  onChoose: (path: string) => void = () => {
  };
  /** 关掉（宿主据此判断"浮层是否开着"，返回键要用） */
  onClose: () => void = () => {
  };

  /** 选择器是否开着（**真值在这里**；宿主经 `onClose` 得知关闭） */
  @State open: boolean = false;
  /** 当前目录 */
  @State path: string = '';
  /** 当前目录下的子目录（已排序） */
  @State dirs: string[] = [];
  /** 提示 / 错误（空串不显示） */
  @State note: string = '';

  aboutToAppear(): void {
    this.controller.register((reason: string) => {
      this.reason = reason;
      this.openPicker();
    }, () => {
      this.close();
    });
  }

  /** 打开理由（只在本次打开期间有效；不放进 `@State`——它不参与渲染判断） */
  private reason: string = '';

  private root(): string {
    return this.sandboxRoot.length > 0 ? this.sandboxRoot : '';
  }

  private openPicker(): void {
    const root: string = this.root();
    if (root.length === 0) {
      // 拿不到沙箱根就不打开：进去只会看到一个空列表（"点了没反应"更糟）
      this.note = '拿不到应用沙箱目录，无法选择文件夹。';
      this.onClose();
      return;
    }
    this.path = this.startDir.length > 0 ? this.startDir : `${root}/workspace`;
    this.note = this.reason;
    this.open = true;
    this.list();
  }

  /** 读当前目录（不存在就建出来：第一次进来时 `workspace` 往往还不存在） */
  private list(): void {
    try {
      if (!fs.accessSync(this.path)) {
        fs.mkdirSync(this.path);
      }
      const names: string[] = fs.listFileSync(this.path);
      const out: string[] = [];
      for (const name of names) {
        try {
          if (fs.statSync(`${this.path}/${name}`).isDirectory()) {
            out.push(name);
          }
        } catch (e) {
          // 单个条目读不到不该让整页失败：跳过它
        }
      }
      out.sort();
      this.dirs = out;
      this.note = '';
    } catch (e) {
      const err = e as Error;
      this.dirs = [];
      this.note = `读目录失败：${err.message}`;
    }
  }

  private goInto(name: string): void {
    this.path = `${this.path}/${name}`;
    this.list();
  }

  /** 上一级；到沙箱根就不再往上（走到沙箱外会读到不可读区域——没有公共存储权限） */
  private goUp(): void {
    const root: string = this.root();
    if (root.length === 0) {
      return;
    }
    if (this.path === root || this.path.length <= root.length) {
      this.note = '已经在沙箱根目录（不能走到沙箱外：没有公共存储权限）。';
      return;
    }
    const cut: number = this.path.lastIndexOf('/');
    this.path = cut <= root.length ? root : this.path.substring(0, cut);
    this.list();
  }

  /** 新建子目录并进入（不弹输入框：端侧输入成本高，名字只是为了区分） */
  private create(): void {
    const now: Date = new Date();
    const name: string = `文件夹-${now.getHours()}${now.getMinutes()}${now.getSeconds()}`;
    try {
      fs.mkdirSync(`${this.path}/${name}`);
      this.goInto(name);
    } catch (e) {
      const err = e as Error;
      this.note = `新建文件夹失败：${err.message}`;
    }
  }

  private close(): void {
    this.open = false;
    this.dirs = [];
    this.note = '';
    this.onClose();
  }

  build() {
    if (this.open) {
      Column() {
        Column({ space: Sp.S }) {
          Text('选择工作区文件夹')
            .fontSize(Fs.BODY)
            .width('100%')
          Text('范围是应用的沙箱目录（未申请公共存储权限）：可以进入子目录、新建文件夹、挑一个作为工作区；选定后会在这里开一个新会话。')
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_tertiary'))
            .width('100%')
          Text(this.path)
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_secondary'))
            .width('100%')
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })

          Scroll() {
            Column({ space: Sp.XS }) {
              if (this.dirs.length === 0) {
                Text('（这一层没有子目录）')
                  .fontSize(Fs.CAPTION)
                  .fontColor($r('sys.color.font_tertiary'))
                  .width('100%')
              }
              ForEach(this.dirs, (name: string) => {
                Row({ space: Sp.S }) {
                  SymbolGlyph($r('sys.symbol.folder')).fontSize(16)   // token-exempt: 列表行内图标尺寸（搬迁不改视觉）
                    .fontColor([$r('sys.color.brand')])
                  Text(name)
                    .fontSize(Fs.SECONDARY)
                    .layoutWeight(1)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                  SymbolGlyph($r('sys.symbol.chevron_right')).fontSize(14)   // token-exempt: 行内箭头尺寸（搬迁不改视觉）
                    .fontColor([$r('sys.color.font_tertiary')])
                }
                .width('100%')
                .padding(Sp.S)
                .borderRadius(Radius.S)
                .backgroundColor($r('sys.color.background_primary'))
                .onClick(() => {
                  this.goInto(name);
                })
              }, (name: string) => name)
            }
            .width('100%')
          }
          .height(220)
          .width('100%')

          if (this.note.length > 0) {
            Text(this.note)
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.warning'))
              .width('100%')
          }

          Row({ space: Sp.S }) {
            Button('上一级')
              .layoutWeight(1)
              .backgroundColor($r('sys.color.background_primary'))
              .fontColor($r('sys.color.font_primary'))
              .onClick(() => {
                this.goUp();
              })
            Button('新建文件夹')
              .layoutWeight(1)
              .backgroundColor($r('sys.color.background_primary'))
              .fontColor($r('sys.color.font_primary'))
              .onClick(() => {
                this.create();
              })
          }
          .width('100%')

          Row({ space: Sp.S }) {
            Button('取消')
              .layoutWeight(1)
              .backgroundColor($r('sys.color.background_secondary'))
              .fontColor($r('sys.color.font_primary'))
              .onClick(() => {
                this.close();
              })
            Button('就选这个文件夹')
              .layoutWeight(1)
              .onClick(() => {
                const chosen: string = this.path;
                this.close();
                this.onChoose(chosen);
              })
          }
          .width('100%')
        }
        .width('100%')
        .padding(Sp.L)
        .borderRadius(Radius.L)
        .backgroundColor($r('sys.color.background_secondary'))
      }
      .width('100%')
      .padding(HarmonySpacing.CONTAINER)
    }
  }
}
