/**
 * 轻触反馈：只用于用户已经完成的本地动作（复制、粘贴、会议开始/结束）。
 *
 * 【为什么放在 platform】振动是设备能力而不是产品策略；调用方只表达“这里需要一次轻反馈”，
 * 具体效果与失败降级由本模块收口。
 *
 * 【为什么失败必须静默】无马达、系统关闭触感或设备不支持时，振动失败不应影响复制、粘贴
 * 或录音本身。该权限是 normal / system_grant，不弹运行时授权框。
 */
import { vibrator } from '@kit.SensorServiceKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/haptic';

/** 一次轻柔触感反馈；不抛异常、不阻塞调用方。 */
export async function hapticTap(): Promise<void> {
  try {
    const effect: vibrator.VibratePreset = {
      type: 'preset',
      effectId: vibrator.HapticFeedback.EFFECT_SOFT
    };
    await vibrator.startVibration(effect, { usage: 'touch' });
  } catch (err) {
    const e = err as BusinessError;
    hilog.debug(DOMAIN, TAG, '轻触反馈不可用：code=%{public}d msg=%{public}s', e.code, e.message);
  }
}
