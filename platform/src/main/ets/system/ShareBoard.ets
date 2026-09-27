/**
 * 系统分享面板机制封装（Share Kit）。
 *
 * 用途（D3 §5.2 长按消息 → 分享）：把会话内容或交付物交给系统分享面板，
 * 由用户选择目标应用。不自己造分享 UI——系统面板在手机/折叠/2in1 上有各自
 * 正确的形态（模态 / 对话框 / 悬浮窗锚点），自造会做不对。
 *
 * 内容纪律（D3 §6 同源）：分享内容由调用方决定；本文件不读取、不拼装会话内容。
 */

import { systemShare } from '@kit.ShareKit';
import { uniformTypeDescriptor as utd } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/share';

/** 一次分享请求的文本内容 */
export interface ShareText {
  content: string;
  title?: string;
  description?: string;
  /** 是否按超链接类型分享（内容为 URL 时设 true，系统会匹配浏览器等目标） */
  asLink?: boolean;
}

/**
 * 弹出系统分享面板分享文本。
 *
 * @param context UIAbility 上下文（2in1/平板下系统需要它决定面板以悬浮窗还是模态展示）
 * @param text 分享内容
 * @param anchorId 可选：面板锚点组件的 id（2in1 上让面板贴着触发它的按钮弹出）
 * @returns 面板是否成功拉起
 */
export async function shareText(context: common.UIAbilityContext, text: ShareText,
  anchorId?: string): Promise<boolean> {
  try {
    const record: systemShare.SharedRecord = {
      utd: text.asLink === true ? utd.UniformDataType.HYPERLINK : utd.UniformDataType.PLAIN_TEXT,
      content: text.content
    };
    if (text.title !== undefined) {
      record.title = text.title;
    }
    if (text.description !== undefined) {
      record.description = text.description;
    }
    const data: systemShare.SharedData = new systemShare.SharedData(record);
    const controller: systemShare.ShareController = new systemShare.ShareController(data);
    const options: systemShare.ShareControllerOptions = {
      selectionMode: systemShare.SelectionMode.SINGLE,
      previewMode: systemShare.SharePreviewMode.DEFAULT
    };
    if (anchorId !== undefined && anchorId.length > 0) {
      options.anchor = anchorId;
    }
    await controller.show(context, options);
    return true;
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, 'share panel failed: %{public}s', e.message);
    return false;
  }
}
