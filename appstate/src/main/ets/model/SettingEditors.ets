/**
 * 两个设置编辑浮层的**输入提示**（P2-10）：把"这一项该怎么填"的判定从视图里搬出来。
 *
 * ## 为什么值得单独一个文件
 *
 * 文本/数字浮层与结构（JSON）浮层各有一段"把服务端约束讲清楚"的逻辑：
 * 类型、范围、步长、正则、必填，以及"当前值是什么"。这段逻辑此前写在 `Index.ets`
 * （4480 行的宿主）里，**没有任何断言**——而它恰恰是用户填错时唯一的提示来源。
 *
 * 与 `SettingsDomains` / `SessionContext` / `Sheets` 同一条理由：判定要能被 fixture
 * 直接执行。本文件零依赖（只吃 `@Prop` 传进来的字符串字段，不 import 任何模块）。
 *
 * ## 两条纪律（都在注释里写死）
 *
 * 1. **不编默认值**：拿不到 `hasMin` / `hasMax` 就不写"范围 0 – ∞"，
 *    而是写"不限"——因为"不限"是 Host 没给约束，而不是"约束是无穷大"。
 * 2. **提示在输入**之前**讲清楚**：错误文案（"不符合 schema"）是给开发者看的，
 *    而用户需要在打字前就知道"这里要一个数字、不能大于 17"。
 */

/**
 * 设置的输入提示与占位（纯数据，视图只负责画）。
 *
 * 【为什么合成一个结构而不是两个函数】两者来自**同一个** `SettingItem` 的同一批字段，
 * 分成两次调用会让"读哪几个字段"散在两处；合成一处之后调用点只有一行。
 */
export interface EditorHints {
  /** 约束说明（"请输入数字；范围 1 – 4096；必填"） */
  hint: string;
  /** 输入框占位（"当前：256000" / "当前未设置"） */
  placeholder: string;
}

/**
 * 文本 / 数字设置项的提示。
 *
 * 参数逐个给（而不是传 `SettingItem`）：这里要做到零依赖，而 `SettingItem` 住在
 * `model/Settings`（依赖 `connection`）——传字段之后本模块可以独立被 fixture 执行。
 */
export function textSettingEditorHints(isNumber: boolean, hasMin: boolean, minValue: number,
  hasMax: boolean, maxValue: number, stepValue: number, pattern: string, required: boolean,
  currentValue: string): EditorHints {
  const parts: string[] = [];
  if (isNumber) {
    parts.push('请输入数字');
    if (hasMin || hasMax) {
      const lo: string = hasMin ? `${minValue}` : '不限';
      const hi: string = hasMax ? `${maxValue}` : '不限';
      parts.push(`范围 ${lo} – ${hi}`);
    }
    if (stepValue > 1) {
      parts.push(`须为 ${stepValue} 的整数倍`);
    }
  } else {
    parts.push('请输入文本');
    if (pattern.length > 0) {
      parts.push(`须匹配 ${pattern}`);
    }
  }
  if (required) {
    parts.push('必填');
  }
  return {
    hint: parts.join('；'),
    placeholder: placeholderOf(currentValue)
  };
}

/**
 * 结构（JSON）值的提示。
 *
 * 【与文本项共用同一句占位】"当前是 X" 与 "当前未设置" 对两种编辑器含义相同
 * ⇒ 抽成 `placeholderOf`，避免两处各写一份文案（这正是"共用呈现"的最小形态）。
 */
export function structSettingEditorHints(currentValue: string): EditorHints {
  return { hint: '', placeholder: placeholderOf(currentValue) };
}

/** "当前值"那一句（空值说"未设置"，不显示空白） */
export function placeholderOf(currentValue: string): string {
  return currentValue.length > 0 ? `当前：${currentValue}` : '当前未设置';
}
