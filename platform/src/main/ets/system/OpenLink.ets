/**
 * 打开外部链接（P2：Markdown 正文里的 `[文字](链接)`）。
 *
 * 【为什么需要这一层】会话正文里的链接如果只是"染成品牌色 + 下划线"却不能点，
 * 那就是本仓最忌讳的**假入口**（看着能点、点了没反应）。而"点了复制链接"又是**语义降级**：
 * 用户点链接的意图是"去看那个页面"。
 *
 * 【为什么用 `openLink` 而不是自己拼 Want】`openLink` 是系统给出的"用默认方式打开链接"
 * 那一件事（浏览器 / 已注册的应用链接），不需要我们猜 action 与 entity；
 * `appLinkingOnly: false` 表示"没有应用能接管时就用浏览器打开"，这正是我们要的兜底。
 *
 * 【失败不抛】调用方拿 `false` 去给一句提示（"无法打开该链接"），
 * 而不是把一个未捕获的异常丢进渲染循环。
 */

import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/openlink';

/** 只放行 http/https：其它 scheme（file:、want:、javascript:…）一律拒绝 */
export function isOpenableUrl(url: string): boolean {
  const lower: string = url.trim().toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://');
}

/**
 * 用系统默认方式打开一个外部链接；返回是否成功。
 *
 * @param url 目标地址（非 http/https 会被直接拒绝）
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  if (!isOpenableUrl(url)) {
    hilog.warn(DOMAIN, TAG, 'rejected non-http url');
    return false;
  }
  try {
    const context = getContext() as common.UIAbilityContext;
    await context.openLink(url.trim(), { appLinkingOnly: false });
    return true;
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, 'openLink failed: %{public}s', e.message);
    return false;
  }
}
