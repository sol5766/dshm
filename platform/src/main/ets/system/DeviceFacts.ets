/**
 * 设备与形态事实（只读）。
 *
 * 用途：
 *   1. 顶层断点（D3 §2.2「以窗口宽度为主断点」）之外，还需要**特征断点**：
 *      设备类型、折叠态、是否外接键盘/鼠标。这些事实由系统提供，UI 据此决定
 *      是否启用「快捷键提示」「拖拽投喂」等 2in1 专属能力。
 *   2. 诊断页展示「你以为我在什么设备上跑」——排查一多适配问题时的第一手信息。
 *
 * 只读、无副作用、不缓存策略判断。
 */

import { deviceInfo } from '@kit.BasicServicesKit';
import { display } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/device';

/** 形态族：把系统给出的 deviceType 归一成三种产品形态 */
export enum FormFactor {
  PHONE = 'phone',
  TABLET = 'tablet',
  DESKTOP = 'desktop',
  UNKNOWN = 'unknown'
}

/** 设备事实快照 */
export interface DeviceFacts {
  /** 系统原始 deviceType（phone / tablet / 2in1 / default / …） */
  rawType: string;
  /** 归一后的形态族 */
  form: FormFactor;
  brand: string;
  model: string;
  osFullName: string;
  /** 屏幕密度（px per vp） */
  density: number;
  /** 屏幕宽（vp，取默认显示设备） */
  screenWidthVp: number;
  screenHeightVp: number;
  /** 是否具备键鼠形态（2in1 / 桌面模式） */
  keyboardLikely: boolean;
}

/** 归一化：平板与 2in1 在 D3 中都属于「完整工作台」，但断点不同，故分开保留。 */
function formOf(raw: string): FormFactor {
  if (raw === 'phone') {
    return FormFactor.PHONE;
  }
  if (raw === 'tablet') {
    return FormFactor.TABLET;
  }
  if (raw === '2in1' || raw === '2in1_foldable' || raw === 'desktop') {
    return FormFactor.DESKTOP;
  }
  return FormFactor.UNKNOWN;
}

/** 采集设备事实。任何一项读取失败都降级为安全默认值，绝不抛异常。 */
export function readDeviceFacts(): DeviceFacts {
  const rawType: string = safeString(() => deviceInfo.deviceType, 'default');
  const form: FormFactor = formOf(rawType);

  let density: number = 1;
  let widthVp: number = 0;
  let heightVp: number = 0;
  try {
    const d: display.Display = display.getDefaultDisplaySync();
    density = d.densityPixels > 0 ? d.densityPixels : 1;
    widthVp = Math.round(d.width / density);
    heightVp = Math.round(d.height / density);
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, 'display read failed: %{public}s', e.message);
  }

  return {
    rawType: rawType,
    form: form,
    brand: safeString(() => deviceInfo.brand, ''),
    model: safeString(() => deviceInfo.marketName, ''),
    osFullName: safeString(() => deviceInfo.osFullName, ''),
    density: density,
    screenWidthVp: widthVp,
    screenHeightVp: heightVp,
    keyboardLikely: form === FormFactor.DESKTOP
  };
}

/**
 * 读取一个可能抛错的字符串属性。
 *
 * 抽出来的理由：`deviceInfo` 的多个属性在不同设备/权限下可能抛错，
 * 逐个 try-catch 会把采集函数写成一堆重复样板。
 */
function safeString(read: () => string, fallback: string): string {
  try {
    const v: string = read();
    return v === undefined || v === null ? fallback : v;
  } catch (err) {
    return fallback;
  }
}
