/**
 * 输入模态事实的合成（P3：四形态与输入模态）。
 *
 * ## 要修的真实缺陷
 *
 * `Index.ets` 此前把 `readDeviceFacts().keyboardLikely` **同时**当作 `hasPointer` 与
 * `hasKeyboard` 传下去。于是：
 *   · **手机插上鼠标**、**平板配触控笔** ⇒ `keyboardLikely` 为假 ⇒ hover 与右键全都不启用，
 *     而这两种设备**确实有指针**（官方 Web 在桌面浏览器上是有 hover 与右键的）
 *   · **2in1 拆掉键盘（平板态）** ⇒ `keyboardLikely` 仍为真 ⇒ 继续提示只有键盘才有的交互
 * 根因是"用一个综合事实代替两个事实"，而这两个事实在本仓是**各有消费点**的
 * （`InputPolicy.hoverEnabled` / `contextMenuGestures` 分别看 pointer 与 keyboard）。
 *
 * ## 三个来源与明确优先级
 *
 * | 优先级 | 来源 | 性质 | 何时起作用 |
 * |---|---|---|---|
 * | ① | **系统枚举的输入设备**（`platform/system/InputDevices`） | 真实事实，**可增可减**（拔掉鼠标就该降级） | 枚举成功时 |
 * | ② | **运行时事件证据**（悬停过 ⇒ 有指针） | 只增不减（一次证明即长期成立） | 枚举不可用、或热插拔事件丢失时兜底 |
 * | ③ | **设备形态猜测**（2in1/桌面模式 ⇒ 像键鼠形态） | 纯猜测，最弱 | 前两者都无信息时（与旧行为一致，保证不回归） |
 *
 * 这样"设备枚举失败"不会让功能比现在更差（退回形态猜测），而枚举成功时又比猜测准。
 *
 * ## 映射依据（不是我自己定的）
 *
 * 依据 SDK `@ohos.multimodalInput.inputDevice.d.ts` 里 `SourceType` 的**字符串联合**原样取值：
 * `'keyboard' | 'mouse' | 'touchpad' | 'touchscreen' | 'joystick' | 'trackball'`。
 *
 * | SourceType | 算键盘 | 算指针 | 为什么 |
 * |---|---|---|---|
 * | `keyboard` | ✅ | — | 物理/外接键盘 |
 * | `mouse` / `touchpad` / `trackball` | — | ✅ | 有"悬停"概念，能右键 |
 * | `touchscreen` | — | ❌ | **触控不是这里的"指针"**：它没有悬停、没有右键；它的次要操作入口是**长按**（`MenuGesture.LONG_PRESS`，触控下永远启用） |
 * | `joystick` | — | ❌ | 不能指向具体控件 |
 *
 * **未识别的取值一律算"两者都不是"**：SDK 以后新增一种输入源时，宁可不动 hover/右键，
 * 也不要凭想象把某个字符串当成指针——与本仓"宁可少分类"的一贯取舍一致。
 *
 * ## 为什么是纯函数
 *
 * "这些设备算不算键鼠""证据怎么合"是**判断**，不是采集；放这里之后可在本机直接测
 * （`tools/check-layout-fixtures.mjs`），平台层只负责把 SDK 的枚举结果取回来。
 */

import { InputModality } from './InputPolicy';

/* ───────────────── 来源取值（原样引用 SDK 的 SourceType 字符串） ───────────────── */

export const SOURCE_KEYBOARD: string = 'keyboard';
export const SOURCE_MOUSE: string = 'mouse';
export const SOURCE_TOUCHPAD: string = 'touchpad';
export const SOURCE_TRACKBALL: string = 'trackball';
export const SOURCE_TOUCHSCREEN: string = 'touchscreen';
export const SOURCE_JOYSTICK: string = 'joystick';

/** 该输入源能否提供键盘输入 */
export function sourceIsKeyboard(source: string): boolean {
  return source === SOURCE_KEYBOARD;
}

/**
 * 该输入源能否提供**指针**语义（悬停 + 右键）。
 *
 * 触控屏刻意不算：`touchscreen` 上不存在"悬停"，右键也不存在，它的入口是长按。
 * 把它算成指针会让触控设备绑上一个永远不触发的右键手势。
 */
export function sourceIsPointer(source: string): boolean {
  return source === SOURCE_MOUSE || source === SOURCE_TOUCHPAD || source === SOURCE_TRACKBALL;
}

/** 把"所有设备的输入源"摊平成一个无重复列表（枚举结果多设备时用） */
export function flattenSources(perDevice: string[][]): string[] {
  const out: string[] = [];
  for (let i = 0; i < perDevice.length; i++) {
    const sources: string[] = perDevice[i];
    for (let j = 0; j < sources.length; j++) {
      const s: string = sources[j];
      if (out.indexOf(s) < 0) {
        out.push(s);
      }
    }
  }
  return out;
}

/** 由输入源列表得出模态事实（未知取值不参与判定） */
export function modalityFromSources(sources: string[]): InputModality {
  let hasKeyboard: boolean = false;
  let hasPointer: boolean = false;
  for (let i = 0; i < sources.length; i++) {
    if (sourceIsKeyboard(sources[i])) {
      hasKeyboard = true;
    }
    if (sourceIsPointer(sources[i])) {
      hasPointer = true;
    }
  }
  return { hasKeyboard: hasKeyboard, hasPointer: hasPointer };
}

/** 设备形态猜测：只有 2in1/桌面模式才"像"键鼠形态（笔记本有触控板，故指针也一起给） */
export function guessFromKeyboardForm(isKeyboardForm: boolean): InputModality {
  return { hasKeyboard: isKeyboardForm, hasPointer: isKeyboardForm };
}

/* ───────────────── 合成 ───────────────── */

/**
 * 合成所需的全部输入。
 *
 * `enumerated` 用 `null` 表示**枚举不可用**（API 失败、或平台层还没取到）——
 * 这与"枚举成功但没有键盘/鼠标"是**两件事**，必须区分：前者要退回猜测，后者是权威的"当前没有"。
 */
export interface ModalityEvidence {
  /** 系统枚举到的输入设备（null = 枚举不可用） */
  enumerated: InputModality | null;
  /** 运行时事件证据（悬停过 ⇒ 有指针；按过物理键 ⇒ 有键盘） */
  observed: InputModality;
  /** 设备形态猜测（最后的兜底） */
  formGuess: InputModality;
}

export function noModality(): InputModality {
  return { hasKeyboard: false, hasPointer: false };
}

/** 逐项取或（合并两组合法事实，例如"枚举到鼠标" + "悬停过"） */
export function unionModality(a: InputModality, b: InputModality): InputModality {
  return {
    hasKeyboard: a.hasKeyboard || b.hasKeyboard,
    hasPointer: a.hasPointer || b.hasPointer,
  };
}

/**
 * 按上面写的优先级合成最终事实。
 *
 * 事件证据**只增不减**：一次悬停就足以证明"这台设备上有指针"，之后即使鼠标被拔掉，
 * 留着 hover/右键语义也不会造成错误（它们只是不再触发）；而键盘证据同理。
 * 而**枚举结果是可以降级的**（拔掉鼠标后重新枚举就应回到"没有指针"）——两者性质不同，故分开处理。
 */
export function modalityOf(evidence: ModalityEvidence): InputModality {
  const base: InputModality = evidence.enumerated === null
    ? evidence.formGuess
    : evidence.enumerated;
  return unionModality(base, evidence.observed);
}

/**
 * 每个为真的标志**来自哪里**（诊断页/日志用）。
 *
 * 【为什么要能说出理由】这条链路上有"采集失败"和"真的没有设备"两种失败，
 * 而它们的现象完全一样（hover 不生效）。说不出理由时，只能到设备上猜。
 */
export function modalityTrace(evidence: ModalityEvidence): string[] {
  const out: string[] = [];
  const enumerated: InputModality | null = evidence.enumerated;
  const resolved: InputModality = modalityOf(evidence);
  if (enumerated === null) {
    out.push('设备枚举不可用，按形态猜测兜底');
  } else {
    out.push(enumerated.hasKeyboard || enumerated.hasPointer
      ? '设备枚举命中（系统报告的输入设备）'
      : '设备枚举成功：当前没有键鼠类输入设备');
  }
  if (evidence.observed.hasPointer && resolved.hasPointer) {
    out.push('观察到指针悬停');
  }
  if (evidence.observed.hasKeyboard && resolved.hasKeyboard) {
    out.push('观察到物理按键');
  }
  if (resolved.hasKeyboard && !resolved.hasPointer) {
    out.push('只有键盘：不启用 hover/右键');
  }
  if (resolved.hasPointer && !resolved.hasKeyboard) {
    out.push('只有指针：启用 hover/右键，但不提示快捷键');
  }
  return out;
}
