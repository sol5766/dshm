/**
 * 字符串资源的**取值**入口（E147）。
 *
 * 【为什么需要它】`Text('…')` 这类**渲染绑定**直接写 `$r('app.string.x')` 即可，
 * 系统按当前语言解析；但**运行时状态字符串**（`this.note = …` 这样的 string 字段）
 * 不行——ArkTS 不会把资源引用解析成文本。正确做法是经**资源管理器**取值。
 *
 * 【为什么放在 platform 而不是某个页面】状态文案会出现在多个视图里
 * （Index、SettingsPane、ConversationPane…）；实现只留一份，谁都别再写第二遍——
 * 否则迟早出现"某处取不到就返回 undefined、另一处抛异常"的不一致。
 *
 * 【取不到时不抛】资源缺失或上下文不可用时返回空串，由调用方决定回落到什么文案。
 * 文案取不到**不该让操作失败**——那是本末倒置。
 */
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0x0000;
const TAG: string = 'DSHM-I18N';

/**
 * 取本地化文本。
 *
 * @param context - UI 上下文（由视图层传入：本模块没有 UI，`getContext()` 在这里拿不到）
 * @param id - 资源引用（`$r('app.string.…')`）
 * @returns 当前语言下的文本；取不到时为空串（**不抛**）
 */
export function localized(context: common.Context, id: Resource): string {
  try {
    return context.resourceManager.getStringSync(id.id);
  } catch (e) {
    const err = e as Error;
    hilog.warn(DOMAIN, TAG, '取字符串资源失败（id=%{public}d）：%{public}s', id.id, err.message);
    return '';
  }
}

/**
 * 取本地化文本，取不到时用 `fallback` 兜底。
 *
 * 【为什么要有兜底版本】绝大多数状态文案"必须有话说"：空白会让人以为操作没发生。
 * 调用方给出与资源内容等价的回落文案即可（通常是中文原文）。
 */
export function localizedOr(context: common.Context, id: Resource, fallback: string): string {
  const text: string = localized(context, id);
  return text.length > 0 ? text : fallback;
}
