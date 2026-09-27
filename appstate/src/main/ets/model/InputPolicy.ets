/**
 * 输入模态策略（P1 §7/P3：「让触控 + 鼠标 + 键盘成为同一套交互语义」）。
 *
 * ## 要解决的问题
 *
 * 同一个"次要操作"在不同设备上由不同手势唤起：
 *
 * ```
 * 触控：长按  → 上下文菜单        指针：右键 → 上下文菜单
 * 悬停：无                        悬停：hover 反馈
 * 键盘：快捷键（2in1/外接键盘）
 * ```
 *
 * 朴素做法是"给每种设备写一套功能"——于是同一个动作有三个入口、三份实现、三处可能不一致。
 * 本文件把差异收成**策略**：功能只有一个（`messageActionsOf`），**手势与提示**由这里决定。
 *
 * ## 为什么是纯函数、放在 appstate
 *
 * "有指针才启用 hover""有键盘才提示快捷键"这类判断是**决策**，不是渲染；
 * 放这里之后可以在本机直接测（`tools/check-layout-fixtures.mjs`），
 * 而视图只把结果映射到 ArkUI（`ResponseType` / `onHover`）。
 *
 * ## 与 `DeviceFacts` 的关系
 *
 * `platform/system/DeviceFacts.ets` 提供**事实**（`keyboardLikely` 等，需要系统 API）；
 * 本文件只做**策略**（给定事实，手势该怎么算），因此不依赖任何系统 API，可测。
 */

/** 输入模态事实（由平台层采集后传入；这里不认识 `deviceInfo`） */
export interface InputModality {
  /** 是否有物理/外接键盘 */
  hasKeyboard: boolean;
  /** 是否有指针设备（鼠标/触控笔） */
  hasPointer: boolean;
}

/** 能唤起上下文菜单的手势 */
export enum MenuGesture {
  LONG_PRESS = 'long-press',
  RIGHT_CLICK = 'right-click'
}

/**
 * 该模态下应当支持的手势。
 *
 * 【为什么触控也一定要有】长按是触控设备上**唯一**的"次要操作"入口——
 * 少了它就等于手机用户没有上下文菜单（官方 Web 在移动端同样以长按替代 hover/右键）。
 * 右键只在有指针时才绑定：没有指针时绑一个永远不会触发的手势，只是给系统多注册一个识别器。
 */
export function contextMenuGestures(input: InputModality): MenuGesture[] {
  const out: MenuGesture[] = [MenuGesture.LONG_PRESS];
  if (input.hasPointer) {
    out.push(MenuGesture.RIGHT_CLICK);
  }
  return out;
}

/** 是否启用悬停反馈（只有指针设备才有"悬停"这个概念） */
export function hoverEnabled(input: InputModality): boolean {
  return input.hasPointer;
}


/**
 * 上下文菜单里"怎么唤起它"的提示文案。
 *
 * 【为什么要提示】长按/右键都是**不可见**的入口——不写出来，用户永远不会发现。
 * 文案随模态变：有指针时两个手势都提，纯触控时只提长按。
 */
export function contextMenuHintLabel(input: InputModality): string {
  return input.hasPointer ? '长按或右键' : '长按';
}
