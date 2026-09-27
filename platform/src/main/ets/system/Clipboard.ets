/**
 * 系统剪贴板机制封装。
 *
 * 用途（D3 §5.2 长按消息 / §7.8 导出诊断）：复制消息、复制代码块、复制诊断报告。
 * 只做「写文本 / 读文本」，不决定复制什么内容——那是 UI 的事。
 */

import { pasteboard } from '@kit.BasicServicesKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/clipboard';

/** 写入纯文本；返回是否成功（失败不抛，调用方可降级为提示「复制失败」）。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    const data: pasteboard.PasteData =
      pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text);
    await pasteboard.getSystemPasteboard().setData(data);
    return true;
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, 'setData failed: %{public}s', e.message);
    return false;
  }
}

/** 读取纯文本；无内容或失败时返回空串。 */
export async function readText(): Promise<string> {
  try {
    const board: pasteboard.SystemPasteboard = pasteboard.getSystemPasteboard();
    const data: pasteboard.PasteData = await board.getData();
    if (data.getPrimaryMimeType() !== pasteboard.MIMETYPE_TEXT_PLAIN
      && data.getPrimaryMimeType() !== pasteboard.MIMETYPE_TEXT_HTML) {
      // 非文本内容（图片等）不在此处处理：本应用不消费剪贴板里的二进制
      return '';
    }
    return data.getPrimaryText();
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, 'getData failed: %{public}s', e.message);
    return '';
  }
}

/** 清空剪贴板（诊断页「清理」动作；含凭据的复制之后应主动清理）。 */
export async function clearClipboard(): Promise<boolean> {
  try {
    await pasteboard.getSystemPasteboard().clearData();
    return true;
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, 'clearData failed: %{public}s', e.message);
    return false;
  }
}
