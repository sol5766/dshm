/**
 * 轨间拖拽把手（P0：AppFrame 的轨道之间，不属于任何一条轨道）。
 *
 * ## 为什么它是个独立组件而不是宿主的一个 builder
 *
 * 它是**两条轨道之间**的东西（左侧主内容 / 右侧栏），既不属于主区也不属于右栏——
 * 把它放在装配器里，装配器就还得知道"把手的命中区域要多宽""拖动时谁改宽度"。
 * 抽出来之后，AppFrame 的 chrome 全部各有其主（`SidebarShell` / `MainHeaderShell` /
 * `RightbarShell` / 本组件），装配器只剩"把谁放在哪"。
 *
 * ## 它的两条真实约束（都是先前踩出来的）
 *
 * 1. **视觉只有 12vp，命中区域按输入模态放宽**（触控 44 / 指针 24）：细线点不中是移动端
 *    最常见的"看起来能用、实际点不到"。`responseRegion` 只扩大命中、不改布局。
 * 2. **拖动策略不在组件里**：起点归一化、可用空间夹取、方向规则（左拖变宽）都在
 *    `LayoutController.dragDetailWidth` 的纯函数里（有断言）。组件只把 pan 偏移量交出去。
 */

import { Sz } from 'appstate';

@Component
export struct TrackResizer {
  /** 视觉宽度（默认 `Sz.DRAG_GRIP`；调用方一般不需要改） */
  @Prop gripWidthVp: number = Sz.DRAG_GRIP;
  /**
   * 命中区域宽度（触控 44 / 指针 24）。
   *
   * 【为什么由宿主给】它取决于**输入模态事实**（`Sz.TOUCH_MIN` / `Sz.POINTER_MIN` 的取舍），
   * 而那是宿主的判定；组件只把它映射成 `responseRegion`。
   */
  @Prop hitWidthVp: number = Sz.TOUCH_MIN;

    /*
   * 【命名注意】不能叫 `onDragStart` / `onDragEnd`：它们是 ArkUI `CustomComponent` 基类上的
   * 保留成员名，声明成同名的回调会被判"与基类不兼容"（编译器直接报 not assignable）。
   * 这里统一用 `onGrip*`：把手（grip）的语言，也避免与基类的拖拽生命周期撞名。
   */
  onGripStart: () => void = () => {
  };
  onGripUpdate: (deltaXVp: number) => void = () => {
  };
  onGripEnd: () => void = () => {
  };

  build() {
    Column() {
      Divider()
        .vertical(true)
        .color($r('sys.color.comp_divider'))
    }
    .width(this.gripWidthVp)
    .height('100%')
    .justifyContent(FlexAlign.Center)
    // 只扩大命中，不改布局：视觉仍是一条细线
    .responseRegion({ x: -(this.hitWidthVp - this.gripWidthVp) / 2, y: 0,
      width: this.hitWidthVp, height: '100%' })
    .accessibilityText('调整详情栏宽度')
    .gesture(
      PanGesture({ direction: PanDirection.Horizontal })
        .onActionStart(() => {
          this.onGripStart();
        })
        .onActionUpdate((event: GestureEvent) => {
          this.onGripUpdate(event.offsetX);
        })
        .onActionEnd(() => {
          this.onGripEnd();
        })
    )
  }
}
