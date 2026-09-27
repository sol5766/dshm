/**
 * 浮层的**结果出口归属**（P2-8，E353）：哪条回执属于哪个浮层。
 *
 * ## 为什么需要一条规则（一个真实的缺陷）
 *
 * 三个浮层（凭据 / 文本设置 / 结构设置）原先**共用**一个 `credentialNote` 与一个
 * `credentialBusy`。两条实测后果：
 *   1. **串浮层**：在凭据浮层里写入失败 → 关掉 → 打开「编辑文本设置」，
 *      那条**凭据的失败文案会出现在文本编辑浮层里**（用户会以为是文本设置写坏了）；
 *   2. **跨浮层置忙**：文本/结构浮层的按钮读的是凭据浮层的忙标志 ⇒ 凭据正在写时，
 *      另一边的按钮也会变灰。
 *
 * 这与设置页那条"回执没有归属域"（E347）**是同一个缺陷类**：一个全局字符串被多个域写、
 * 被多个界面读。修法也一样：**记下归属，只让主人显示它**。
 *
 * ## 判定放纯模型的理由
 *
 * 与 `SettingsDomains` / `SessionContext` 相同：规则要能被 fixture 直接执行。
 * 本文件零依赖。
 */

/** 浮层的三种"有结果出口"的种类（与本仓 `sheetKind()` 的取值同形） */
export const SHEET_NOTE_NONE: string = '';
export const SHEET_NOTE_CREDENTIAL: string = 'credential';
export const SHEET_NOTE_TEXT: string = 'text';
export const SHEET_NOTE_STRUCT: string = 'struct';

/**
 * 这条回执该不该在这个浮层里显示。
 *
 * 【判据只有一条】回执的**归属**必须等于当前浮层的种类。
 * 归属为空串（没人认领：刚关掉某个浮层、或还没写过）⇒ **一律不显示**——
 * 显示一条"不知道谁写的"错误比不显示更糟：用户会照着它去改一个无关的输入。
 *
 * 【为什么不做"谁先谁后"的时间比较】加时间戳只会引入第二个真值（时钟），
 * 而归属本身就是充分条件：写回执的地方一定知道自己是谁。
 */
export function sheetNoteVisible(owner: string, sheetKind: string): boolean {
  return owner.length > 0 && owner === sheetKind;
}

/**
 * 这条回执的文案该不该显示（归属对 + 文案非空）。
 *
 * 【为什么把"非空"也放进模型】界面上是同一处判断（`if (显示) { Text(note) }`）：
 * 把它留成两个条件会让调用点出现"两层 if"，而两处调用点各写一遍就会漂移。
 */
export function sheetNoteText(owner: string, sheetKind: string, note: string): string {
  return sheetNoteVisible(owner, sheetKind) ? note : '';
}
