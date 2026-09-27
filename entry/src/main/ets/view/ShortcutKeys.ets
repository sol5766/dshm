/**
 * 快捷键的**按键判定**（把 ArkUI 的按键事件翻成 `SHORTCUTS` 表里的规格 id）。
 *
 * ───────────────────────── 为什么需要这个文件 ─────────────────────────
 *   `appstate/ui/Shortcuts.ets` 里已经有一张完整、逐行核对过的 D3 §5.1 快捷键表，
 *   但 **`entry` 层从未接过它**：表在、门禁绿、功能不可达
 *   （`tools/audit-unused-exports.mjs` 把这类缺口列出来时，`SHORTCUTS` /
 *   `keyEventSpecs` / `keyboardShortcutSpecs` 一个都没有被 `entry` 引用）。
 *   本文件补上"按键 → 规格 id"这一段，`Index` 负责把 id 分发给真正的动作。
 *
 * ───────────────────────── 两条设计约束 ─────────────────────────
 *  1. **规格 id 只有一个来源**：本文件只产出 `SHORTCUTS` 表里的 id，绝不另建一份
 *     "动作枚举"。两份清单必然漂移，而漂移的表现是"某个快捷键按下去做的是另一件事"。
 *  2. **只做判定，不做动作**：判定是纯函数（可单测），动作留在持有状态的页面里。
 *
 * ───────────────────────── 为什么分成两条路 ─────────────────────────
 *   ArkUI 的两种绑定能力不同（`Shortcuts.ets` 的表里已按行标注）：
 *    - `keyboardShortcut`：只支持**单字符键 + 修饰键**与功能键；
 *    - `onKeyEvent`：能拿到 `KeyCode`，因此 `Esc` / `Enter` / 方向键只能走它。
 *   本文件负责第二条路；第一条路由 `Index` 用 `.keyboardShortcut(...)` 直接声明，
 *   修饰键匹配交给框架（比手写可靠）。
 */

import { KeyCode } from '@kit.InputKit';
import { findShortcut, keyboardShortcutSpecs } from 'appstate';
import type { ShortcutSpec } from 'appstate';

/** 一次按键判定结果 */
export interface ShortcutHit {
  /** `SHORTCUTS` 表里的规格 id；`''` 表示本次按键不构成快捷键 */
  id: string;
  /**
   * 方向（仅 `prev-next-message` 有意义）：`-1` 上一条 / `+1` 下一条 / `0` 不适用。
   *
   * 【为什么方向要单独给】规范把 `Alt+↑/↓` 放在**同一行同一行为**里（同一个规格 id），
   * 而两件事要做不同的动作。硬拆成两个 id 会让表与规范不再逐行对应——
   * 而那张表的逐行对应关系是它存在的全部意义。
   */
  delta: number;
}

/** 空结果（不构成快捷键） */
function miss(): ShortcutHit {
  return { id: '', delta: 0 };
}

/** 命中一个规格（顺带校验它确实在表里，防止本文件凭记忆写 id） */
function hit(id: string, delta: number): ShortcutHit {
  if (findShortcut(id) === undefined) {
    // 表里没有这个 id ⇒ 本文件与表已经漂移。宁可"没反应"，也不要分发给一个不存在的动作。
    return miss();
  }
  return { id: id, delta: delta };
}

/**
 * 判定一次按键事件。
 *
 * @param keyCode ArkUI `KeyEvent.keyCode`
 * @param shift   Shift 是否按下（`Enter` 靠它区分「发送」与「换行」）
 * @param alt     Alt 是否按下（`Alt+↑/↓` 靠它，且**必须**要求它按下）
 */
export function hitOfKeyEvent(keyCode: number, shift: boolean, alt: boolean): ShortcutHit {
  if (keyCode === KeyCode.KEYCODE_ESCAPE) {
    // Esc 不需要修饰键；带修饰键的 Esc 不当快捷键（避免吞掉将来可能的 Ctrl+Esc）
    return shift || alt ? miss() : hit('stop-turn', 0);
  }
  if (keyCode === KeyCode.KEYCODE_ENTER || keyCode === KeyCode.KEYCODE_NUMPAD_ENTER) {
    // Enter 语义（D3 第 7 行「发送 / 换行（可反转）」）：
    //   默认 Enter=发送、Shift+Enter=换行。**反转偏好尚未实现**，因此这里只走默认分支，
    //   不假装支持反转（`shift=true` 用 `delta=-1` 表达"换行"，由调用方决定不做动作）。
    return alt ? miss() : hit('send-message', shift ? -1 : 0);
  }
  if (alt && (keyCode === KeyCode.KEYCODE_DPAD_UP || keyCode === KeyCode.KEYCODE_DPAD_DOWN)) {
    return hit('prev-next-message', keyCode === KeyCode.KEYCODE_DPAD_UP ? -1 : 1);
  }
  if (keyCode === KeyCode.KEYCODE_F5) {
    // `F5` 在表里标的是 `functionKey`（本可走 `keyboardShortcut(FunctionKey.F5, [])`），
    // 这里一并走 `onKeyEvent`：`FunctionKey` 在 ArkUI enums 里的确切名字未能确认，
    // 而 `KeyCode.KEYCODE_F5` 是确定的。两条路只能选一条，选确定的那条。
    return shift || alt ? miss() : hit('reconnect', 0);
  }
  return miss();
}

/**
 * 走 `keyboardShortcut` 的规格（`Index` 据此声明绑定）。
 *
 * 直接复用表里的过滤结果，不在 UI 里再判断一遍"哪些能声明"——
 * 那种重复判断正是"表改了而绑定没改"的来源。
 */
export function declarativeSpecs(): ShortcutSpec[] {
  return keyboardShortcutSpecs();
}
