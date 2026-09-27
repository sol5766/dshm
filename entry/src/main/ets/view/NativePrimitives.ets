/**
 * HarmonyOS 原生原语（P1.5）——视图层共用的最小构件。
 *
 * ## 为什么要有这一层
 *
 * 在它之前，"一个 chip"在各处被重写了 5 次：字号、内距、圆角、底色、选中色、
 * 无障碍文案每处一套。于是同一个概念在不同面板里长得不一样，而**改一次要改五处**。
 * 本层的目标不是"好看"，是**同一个概念只有一处实现**。
 *
 * ## 与 HarmonyTheme 的分工
 *
 * `HarmonyTheme` 只说"用哪个令牌"，本文件说"这个控件长什么样"。
 * 颜色/尺寸/圆角/动效一律取自 `HarmonyTheme`，**这里不出现裸数字**——
 * `tools/check-design-tokens.mjs` 会盯着这一点（棘轮：裸值只许变少）。
 *
 * ## 交互语义：触控与指针同一套
 *
 * 每个可点构件都做三件事：可点面积 ≥ 触控底线、有按压反馈、有无障碍文案。
 * 不在构件里写 `if (设备是手机)`——设备差异属于布局层（`LayoutController`）与输入层（P3）。
 */

import type { ShadowLevel } from 'appstate';
import {
  HarmonyBorder,
  HarmonyColor,
  HarmonyElevation,
  HarmonyIconSize,
  HarmonyMotion,
  HarmonyRadius,
  HarmonySpacing,
  HarmonyTouch,
  HarmonyType
} from 'appstate';

/**
 * 轻量标签/操作构件（官方 Web 叫 chip，鸿蒙侧就用原生观感表达）。
 *
 * 用途：工具行入口（@ 引用 / 命令 / 计划 / 权限 / 模型）、反馈类别、状态标签。
 */
@Component
export struct NativeChip {
  @Prop label: string = '';
  /** 选中态（品牌色文字 + 更实的底） */
  @Prop active: boolean = false;
  /** 语气：neutral | alert。只有"需要注意"的才用 alert，避免满屏彩色 */
  @Prop tone: string = 'neutral';
  /** 是否禁用（不可用时也**说明原因**由调用方给 accessibilityText） */
  @Prop disabled: boolean = false;
  /** 无障碍文案（缺省用 label；调用方应给出"点击会发生什么"） */
  @Prop a11y: string = '';
  /** 最宽（长模型名/长路径要截断，而不是把工具栏顶开） */
  @Prop maxWidth: number = 180;
  onTap: () => void = () => {
  };

  private textColor(): Resource {
    if (this.disabled) {
      return HarmonyColor.TEXT_TERTIARY;
    }
    if (this.active) {
      return HarmonyColor.BRAND;
    }
    if (this.tone === 'alert') {
      return HarmonyColor.ALERT;
    }
    return HarmonyColor.TEXT_SECONDARY;
  }

  build() {
    Text(this.label)
      .fontSize(HarmonyType.LABEL.size)
      .fontWeight(this.active ? 500 : 400)
      .fontColor(this.textColor())
      .maxLines(1)
      .textOverflow({ overflow: TextOverflow.Ellipsis })
      .constraintSize({ maxWidth: this.maxWidth })
      .padding({
        left: HarmonySpacing.CONTROL_INNER,
        right: HarmonySpacing.CONTROL_INNER,
        top: HarmonySpacing.INLINE,
        bottom: HarmonySpacing.INLINE
      })
      .borderRadius(HarmonyRadius.CHIP)
      .backgroundColor(this.active ? HarmonyColor.SURFACE_TERTIARY : HarmonyColor.SURFACE_RAISED)
      .animation({ duration: HarmonyMotion.STATE })
      // 触控底线：文字 chip 的高度由内距撑起，这里确保可点高度不缩水
      .constraintSize({ minHeight: HarmonyTouch.MIN_TARGET })
      .textAlign(TextAlign.Center)
      .accessibilityText(this.a11y.length > 0 ? this.a11y : this.label)
      .enabled(!this.disabled)
      .onClick(() => {
        if (!this.disabled) {
          this.onTap();
        }
      })
  }
}

/**
 * 区块标题（页内小节）。
 *
 * 【为什么要一个构件】此前各面板自己写 `.fontSize(Fs.BODY).fontWeight(Medium)`——
 * 值一样、名字不一样，于是没人能回答"小节标题到底是哪一档"。
 */
@Component
export struct NativeSectionTitle {
  @Prop text: string = '';
  /** 右侧次要说明（可选） */
  @Prop hint: string = '';

  build() {
    Row({ space: HarmonySpacing.INLINE }) {
      Text(this.text)
        .fontSize(HarmonyType.SUBTITLE.size)
        .fontWeight(HarmonyType.SUBTITLE.weight)
        .lineHeight(HarmonyType.SUBTITLE.lineHeight)
        .fontColor(HarmonyColor.TEXT_PRIMARY)
        .layoutWeight(1)
      if (this.hint.length > 0) {
        Text(this.hint)
          .fontSize(HarmonyType.CAPTION.size)
          .fontColor(HarmonyColor.TEXT_TERTIARY)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
    }
    .width('100%')
  }
}


/**
 * 半模态 Sheet 的统一参数（P1.5 的 NativeSheet）。
 *
 * 【为什么是"参数助手"而不是包装组件】ArkUI 的 Sheet 是**组件属性**（`.bindSheet(...)`），
 * 不是可以独立摆放的组件；而本项目在真机上踩过「`@BuilderParam` 注入父 Builder 导致 JS 崩溃」
 * （D4 记载，SettingsPane 因此改成直接传属性）。把 Sheet 包成一个需要注入 Builder 的组件，
 * 等于把那个已知的坑重新引入。统一**参数**（高度/拖拽条/关闭按钮/消失回调）同样能拿到
 * "全应用的 Sheet 观感一致"这份收益，且没有那个风险。
 *
 * 【消失回调为什么必填】`bindSheet(isShow, …)` 的 `isShow` 是**单向**的：用户下拉关闭或点关闭按钮时，
 * 组件内部并不会把调用方的状态改回去。不同步的话，调用方的 `show` 会永远停在 true，
 * 于是 **Sheet 再也打不开**（看起来像"点了没反应"）。所以这里强制要求传入状态复位回调。
 */
export function harmonySheetOptions(onGone: () => void, height: SheetSize = SheetSize.MEDIUM): SheetOptions {
  const options: SheetOptions = {
    height: height,
    dragBar: true,
    showClose: true,
    // 关闭路径统一在这里收敛：拖拽/关闭按钮/点击遮罩都会走到它
    shouldDismiss: (dismiss: SheetDismiss) => {
      onGone();
      dismiss.dismiss();
    }
  };
  return options;
}


/**
 * 原生卡片：会话里的"一类事件"（工具调用 / 子代理 / 交付物 / 目标 / 任务）统一用它表达。
 *
 * ## 为什么是**参数驱动**而不是"通用容器 + 内容注入"
 *
 * ArkUI 里给容器注入内容的常规做法是 `@BuilderParam`（尾随闭包）。但本项目在真机上踩过
 * 「`@BuilderParam` 注入父 Builder → 展开该区块时 JS 崩溃」（D4 记载，SettingsPane 因此改成直传属性）。
 * 在**没有真机可验**的阶段，把一个已知会崩的机制铺到会话主视图上是不负责任的。
 * 而这几类卡片的结构其实**高度同构**（图标 + 名称 + 状态 + 次要信息 + 摘要 + 可折叠结果），
 * 于是参数驱动反而得到更清晰的 API：调用方只说"是什么"，不再各写一遍内距/圆角/边框。
 *
 * ## 空间层级（而不是网页卡片堆叠）
 *
 * 鸿蒙侧的层次靠**材质与微阴影**表达，不靠"画一圈边框"。因此：
 *   · 常规/成功：无边框，仅一层浅底 + FLAT 阴影；
 *   · 运行中：品牌色做小面积强调（图标+状态字），并把阴影抬到 RAISED——"正在进行"靠**动势**而不是靠边框；
 *   · 失败/被拒：保留 alert 描边——这是**例外状态**，值得被一眼看到，边框在这里是有信息的。
 * 边框从"每张卡都画"变成"只在异常时出现"，卡片堆叠的噪声就降下来了。
 */
@Component
export struct NativeCard {
  /** 图标（系统符号；调用方按事件类型给） */
  @Prop iconSymbol: Resource = $r('sys.symbol.circle');
  /** 名称（工具名 / 子代理名 / 文件名） */
  @Prop title: string = '';
  /** 状态徽标文字（运行中 / 成功 / 失败 / 被拒…） */
  @Prop badge: string = '';
  /** 语气：neutral | running | success | failed | warning */
  @Prop tone: string = 'neutral';
  /** 次要信息（钟点 · 时长 / 大小 / 路径） */
  @Prop meta: string = '';
  /** 参数摘要（等宽单行，超出省略） */
  @Prop summary: string = '';
  /** 结果正文（已由调用方截断/预览；空串表示没有结果） */
  @Prop bodyText: string = '';
  /**
   * 逐行正文（改动对照用），与 `diffKinds` **按下标一一对应**。
   *
   * 【为什么单独一条通道】改动对照的价值一半在"哪些行加了、哪些行删了"，
   * 而这件事只有**颜色**能在手机上被一眼扫出来（只有 `+`/`-` 前缀很难读）。
   * 单串 `bodyText` 表达不了逐行颜色，故这里给一个可选的行数组；非空时优先于 `bodyText`。
   */
  @Prop diffLines: string[] = [];
  /** 每行的性质（`context` / `added` / `removed` / `skipped`），只用来取色 */
  @Prop diffKinds: string[] = [];
  /** 结果被截断时的提示（如「查看完整输出（共 N 字符）」） */
  @Prop bodyTruncatedHint: string = '';
  /** 折叠时显示的入口文案（如「▸ 查看结果」） */
  @Prop collapsedHint: string = '';
  /** 是否展开结果 */
  @Prop expanded: boolean = false;
  /** 进度百分比（0–100；负数 = 不显示进度条）——目标/任务卡用 */
  @Prop progress: number = -1;
  /** 无障碍的一段话（调用方给"这是什么、什么状态"） */
  @Prop a11y: string = '';

  onToggle: () => void = () => {
  };

  private accent(): Resource {
    if (this.tone === 'failed') {
      return HarmonyColor.ALERT;
    }
    if (this.tone === 'warning') {
      return HarmonyColor.WARNING;
    }
    if (this.tone === 'success') {
      return HarmonyColor.CONFIRM;
    }
    if (this.tone === 'running') {
      return HarmonyColor.BRAND;
    }
    return HarmonyColor.TEXT_SECONDARY;
  }

  /**
   * 对照行的颜色：加行绿、减行红、上下文次色、折叠提示三级色。
   *
   * 语义色由系统给（`sys.color.confirm` / `sys.color.alert`），**不写死红绿**——
   * 否则深色模式与高对比模式下会不对。
   */
  private diffColorOf(index: number): Resource {
    const kind: string = index < this.diffKinds.length ? this.diffKinds[index] : 'context';
    if (kind === 'added') {
      return HarmonyColor.CONFIRM;
    }
    if (kind === 'removed') {
      return HarmonyColor.ALERT;
    }
    if (kind === 'skipped') {
      return HarmonyColor.TEXT_TERTIARY;
    }
    return HarmonyColor.TEXT_SECONDARY;
  }

  /** 只有"异常"才画描边（边框在这里是信息，不是装饰） */
  private borderRes(): Resource | undefined {
    if (this.tone === 'failed') {
      return HarmonyColor.ALERT;
    }
    return undefined;
  }

  private shadowOf(): ShadowLevel {
    if (this.tone === 'running') {
      return HarmonyElevation.RAISED;
    }
    return HarmonyElevation.FLAT;
  }

  build() {
    Column({ space: HarmonySpacing.INLINE }) {
      Row({ space: HarmonySpacing.CONTROL_INNER }) {
        SymbolGlyph(this.iconSymbol)
          .fontSize(HarmonyIconSize.INLINE)
          .fontColor([this.accent()])
        Text(this.title)
          .fontSize(HarmonyType.CAPTION.size)
          .fontWeight(HarmonyType.CAPTION.weight + 100)
          .fontColor(HarmonyColor.TEXT_PRIMARY)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        if (this.badge.length > 0) {
          Text(this.badge)
            .fontSize(HarmonyType.LABEL.size)
            .fontColor(this.accent())
        }
        if (this.meta.length > 0) {
          Text(this.meta)
            .fontSize(HarmonyType.LABEL.size)
            .fontColor(HarmonyColor.TEXT_TERTIARY)
            .maxLines(1)
        }
      }
      .width('100%')

      if (this.progress >= 0) {
        Progress({ value: this.progress, total: 100, type: ProgressType.Linear })
          .width('100%')
      }

      if (this.summary.length > 0) {
        Text(this.summary)
          .fontSize(HarmonyType.LABEL.size)
          .fontFamily('monospace')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
      }

      if (this.diffLines.length > 0 || this.bodyText.length > 0) {
        if (this.expanded) {
          Column({ space: HarmonySpacing.INLINE }) {
            if (this.diffLines.length > 0) {
              Column({ space: 0 }) {
                ForEach(this.diffLines, (line: string, index: number) => {
                  Text(line)
                    .fontSize(HarmonyType.LABEL.size)
                    .fontFamily('monospace')
                    .fontColor(this.diffColorOf(index))
                    .width('100%')
                    .textAlign(TextAlign.Start)
                    .copyOption(CopyOptions.LocalDevice)
                }, (line: string, index: number) => `${index}:${line}`)
              }
              .width('100%')
            } else {
              Text(this.bodyText)
                .fontSize(HarmonyType.LABEL.size)
                .fontFamily('monospace')
                .width('100%')
                .textAlign(TextAlign.Start)
                .copyOption(CopyOptions.LocalDevice)
            }
            if (this.bodyTruncatedHint.length > 0) {
              Text(this.bodyTruncatedHint)
                .fontSize(HarmonyType.LABEL.size)
                .fontColor(HarmonyColor.BRAND)
            }
          }
          .width('100%')
          .padding(HarmonySpacing.CONTROL_INNER)
          .borderRadius(HarmonyRadius.CONTROL)
          .backgroundColor(HarmonyColor.SURFACE)
        } else if (this.collapsedHint.length > 0) {
          Text(this.collapsedHint)
            .fontSize(HarmonyType.LABEL.size)
            .fontColor(HarmonyColor.BRAND)
            .onClick(() => {
              this.onToggle();
            })
        }
      }
    }
    .width('100%')
    .padding(HarmonySpacing.CONTAINER)
    .borderRadius(HarmonyRadius.SURFACE)
    .backgroundColor(HarmonyColor.SURFACE_RAISED)
    .borderWidth(this.borderRes() === undefined ? 0 : HarmonyBorder.HAIRLINE)
    .borderColor(this.borderRes() === undefined ? HarmonyColor.SURFACE_RAISED : this.borderRes())
    .shadow({
      radius: this.shadowOf().radius,
      color: HarmonyColor.SURFACE,
      offsetY: this.shadowOf().offsetY
    })
    .animation({ duration: HarmonyMotion.TRANSITION })
    .accessibilityText(this.a11y.length > 0 ? this.a11y : `${this.title}，${this.badge}`)
  }
}


/**
 * 原生按钮（P1.5）。
 *
 * ## 四档强调（emphasis）与四种语气（tone）
 *
 * 强调决定"这个动作有多重"，语气决定"它是哪一类"。两者分开，是因为
 * "主要动作"与"危险动作"是两个独立维度——危险的主选（如审批里的「拒绝」）本该
 * **既是主要、又是危险**，把它们合成一个枚举就表达不了这个组合（D3 §3.4 的
 * "危险动作把主按钮权重反转"正是这种组合）。
 *
 *   emphasis: solid（实底）> tonal（浅底）> outline（描边）> text（纯文字）
 *   tone:     brand | danger | warning | success | neutral
 *
 * 【为什么用 `Button({type, stateEffect}) { … }` 而不是自定义 Row】按压实效、焦点框、
 * 键盘可达性由 ArkUI 的 Button 提供；自己拿 Row 拼一个"看起来像按钮"的东西，
 * 就得把这些系统行为逐个补回来，而且必然补不全（键盘用户第一个受影响）。
 */
@Component
export struct NativeButton {
  @Prop label: string = '';
  /** 可选图标（与 label 二选一或同时给） */
  @Prop iconSymbol: Resource = $r('sys.symbol.circle');
  @Prop showIcon: boolean = false;
  /** 强调：solid | tonal | outline | text */
  @Prop emphasis: string = 'solid';
  /** 语气：brand | danger | warning | success | neutral */
  @Prop tone: string = 'brand';
  @Prop disabled: boolean = false;
  @Prop a11y: string = '';
  /** 是否为方形图标按钮（如发送键：图标居中、不给文字） */
  @Prop square: boolean = false;
  @Prop iconSize: number = HarmonyIconSize.INLINE;

  onTap: () => void = () => {
  };

  private toneColor(): Resource {
    if (this.tone === 'danger') {
      return HarmonyColor.ALERT;
    }
    if (this.tone === 'warning') {
      return HarmonyColor.WARNING;
    }
    if (this.tone === 'success') {
      return HarmonyColor.CONFIRM;
    }
    if (this.tone === 'neutral') {
      return HarmonyColor.TEXT_SECONDARY;
    }
    return HarmonyColor.BRAND;
  }

  private backgroundRes(): Resource {
    if (this.disabled) {
      return HarmonyColor.SURFACE_TERTIARY;
    }
    if (this.emphasis === 'solid') {
      return this.toneColor();
    }
    if (this.emphasis === 'tonal') {
      return HarmonyColor.SURFACE_TERTIARY;
    }
    if (this.emphasis === 'outline') {
      return HarmonyColor.SURFACE_RAISED;
    }
    return HarmonyColor.SURFACE_RAISED;
  }

  /** 实底上必须用"底色之上"的前景色（系统语义；此前发送键写死 Color.White） */
  private foregroundRes(): Resource {
    if (this.disabled) {
      return HarmonyColor.TEXT_TERTIARY;
    }
    if (this.emphasis === 'solid') {
      return this.showIcon && this.label.length === 0 ? HarmonyColor.ON_BRAND_ICON : HarmonyColor.ON_BRAND_TEXT;
    }
    return this.toneColor();
  }

  build() {
    Button({ type: ButtonType.Normal, stateEffect: !this.disabled }) {
      Row({ space: HarmonySpacing.INLINE }) {
        if (this.showIcon) {
          SymbolGlyph(this.iconSymbol)
            .fontSize(this.iconSize)
            .fontColor([this.foregroundRes()])
        }
        if (this.label.length > 0) {
          Text(this.label)
            .fontSize(HarmonyType.LABEL.size)
            .fontWeight(500)
            .fontColor(this.foregroundRes())
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
      }
    }
    // 方形（图标按钮）固定正方；否则交给内容自适应（`'auto'` 是 SDK 文档支持的取值）
    .width(this.square ? HarmonyTouch.MIN_TARGET : 'auto')
    .height(this.square ? HarmonyTouch.MIN_TARGET : HarmonyTouch.MIN_TARGET)
    .padding(this.square ? 0 : {
      left: HarmonySpacing.SECTION,
      right: HarmonySpacing.SECTION
    })
    .backgroundColor(this.backgroundRes())
    .borderRadius(HarmonyRadius.CONTROL)
    .borderWidth(this.emphasis === 'outline' ? HarmonyBorder.HAIRLINE : 0)
    .borderColor(this.toneColor())
    .enabled(!this.disabled)
    .accessibilityText(this.a11y.length > 0 ? this.a11y : this.label)
    .onClick(() => {
      if (!this.disabled) {
        this.onTap();
      }
    })
  }
}

/** 动作条里的一项 */
export interface NativeAction {
  /** 稳定键（用于 ForEach 与回传） */
  id: string;
  label: string;
  /** 选中态（如已评的"有帮助"） */
  active?: boolean;
  /** 语气：neutral | alert */
  tone?: string;
  disabled?: boolean;
  a11y?: string;
}

/**
 * 动作条（P1.5）：把"一行操作"从各处的 Row+若干 Text 收成一处。
 *
 * 【为什么用数据数组而不是若干子组件】动作条的内容（复制/评价/撤回、保存/分享…）
 * 是**可枚举的一行按钮**，用数组表达后：间距、换行、禁用与选中样式只实现一次；
 * 而且"这一行到底有哪些动作"变成了可读的数据（review 时一眼看得完）。
 * 不用 `@BuilderParam` 的理由与 `NativeCard` 同：本项目真机上踩过它的崩溃（D4 记载）。
 */
@Component
export struct NativeActionBar {
  @Prop actions: NativeAction[] = [];
  /** 是否把动作推到左侧并留出弹性空间（右侧放别的） */
  @Prop leading: boolean = true;
  onAction: (id: string) => void = () => {
  };

  build() {
    Flex({ wrap: FlexWrap.Wrap, justifyContent: this.leading ? FlexAlign.Start : FlexAlign.End }) {
      ForEach(this.actions, (a: NativeAction) => {
        Row() {
          NativeChip({
            label: a.label,
            active: a.active === true,
            tone: a.tone === undefined ? 'neutral' : a.tone,
            disabled: a.disabled === true,
            a11y: a.a11y === undefined ? a.label : a.a11y,
            onTap: () => {
              this.onAction(a.id);
            }
          })
        }
        .margin({ right: HarmonySpacing.INLINE, bottom: HarmonySpacing.INLINE })
      }, (a: NativeAction) => a.id)
    }
    .width('100%')
  }
}
