/**
 * 鸿蒙空间化（Spatial UI）材质能力探测与降级工具。
 *
 * 背景：HarmonyOS 6.1.0(23) 起提供 HDS 组件沉浸光感材质
 * （`hdsMaterial.MaterialType/MaterialLevel`），API 26.0.0 起提供 ArkUI
 * 通用组件的沉浸式系统材质（`uiMaterial.ImmersiveMaterial`）。
 *
 * 该能力的可用性有三层门槛，必须逐层探测，任一不满足即降级为传统模糊：
 *   1. 系统 API 版本：`deviceInfo.apiAvailable('26.0.0')`；
 *   2. 设备材质能力：`hdsMaterial.getSystemMaterialTypes()` 返回非空且包含
 *      `MaterialType.IMMERSIVE`；
 *   3. 调用设备形态：HDS 材质在 Phone/Tablet 可正常调用，PC/2in1 需先查询
 *      `getSystemMaterialTypes()`（见官方 SystemMaterialParams 设备行为差异说明）。
 *
 * 低算力设备上沉浸式材质会自动退化为「背景色 + 边框 + 阴影」实现，因此本类
 * 只需给出「可用 / 不可用」两态，具体档位交给系统自适应
 * （`MaterialLevel.ADAPTIVE`）。
 *
 * 官方文档：
 *   - `api/UI_Design_Kit_UI设计套件/ArkTS_API/hdsMaterial/hdsMaterial.md`
 *   - `api/ArkUI_方舟UI框架/ArkTS_API/UI界面/ohos_arkui_uiMaterial_系统材质_/`
 */
import { deviceInfo } from '@kit.BasicServicesKit';
import { hdsMaterial, SystemMaterialParams } from '@kit.UIDesignKit';
import { DshmLogger } from '../utils/Logger';

const TAG: string = 'ImmersiveMaterialUtil';

/** 沉浸光感可用的最低 SDK API 版本（ArkUI 通用材质 26.0.0 与 HDS 材质 23 的共同基线）。 */
const MIN_SDK_API_FOR_IMMERSIVE: number = 26;

/**
 * 沉浸光感能力探测结果。
 */
export interface ImmersiveCapability {
  /** 是否可用沉浸式系统材质。false 时调用方必须走传统模糊/纯色降级。 */
  usable: boolean;
  /** 设备支持的材质类型（探测失败时为空数组）。 */
  materialTypes: Array<hdsMaterial.MaterialType>;
  /** 不可用原因，便于日志与「运行环境」面板展示。 */
  reason: string;
}

/**
 * 探测沉浸光感能力。结果内部缓存，避免每次 build 都做跨进程调用。
 *
 * ⚠️ 实测踩坑（2026-09-12，编译期连续两次拦截）：
 * `deviceInfo.apiAvailable()` 在当前 DevEco SDK 的**编译期校验器**中仍只接受
 * 「1–25 的十进制整数」（报错 `11706013 The OpenHarmony api version must be
 * a decimal integer between 1 and 25`），即使 `.d.ts` 已声明 API 26+ 可用点分
 * 字符串（`'26.0.0'`）。即编译器比声明文件旧，点分形态**当前不可用**。
 *
 * 因此改用 `deviceInfo.sdkApiVersion`（数字，无编译期限制）直接做阈值比较——
 * 语义等价：`sdkApiVersion >= 26` 即表示设备具备 API 26 基线能力。
 */
export class ImmersiveMaterialUtil {
  private static cached: ImmersiveCapability | null = null;

  /** 探测（带缓存）设备沉浸光感能力。 */
  public static capability(): ImmersiveCapability {
    if (ImmersiveMaterialUtil.cached !== null) {
      return ImmersiveMaterialUtil.cached;
    }
    let result: ImmersiveCapability = {
      usable: false,
      materialTypes: [],
      reason: ''
    };
    try {
      const sdkApi: number = deviceInfo.sdkApiVersion;
      if (sdkApi < MIN_SDK_API_FOR_IMMERSIVE) {
        result.reason = '设备 SDK API ' + String(sdkApi) + ' 低于 ' + String(MIN_SDK_API_FOR_IMMERSIVE);
        ImmersiveMaterialUtil.cached = result;
        DshmLogger.info(TAG, '沉浸光感不可用：' + result.reason);
        return result;
      }
      const types: Array<hdsMaterial.MaterialType> = hdsMaterial.getSystemMaterialTypes();
      result.materialTypes = types;
      if (types.length === 0) {
        result.reason = '设备未返回任何材质类型';
      } else if (types.indexOf(hdsMaterial.MaterialType.IMMERSIVE) < 0) {
        result.reason = '设备不支持 IMMERSIVE 材质类型';
      } else {
        result.usable = true;
        result.reason = 'ok';
      }
    } catch (e) {
      result.reason = '探测异常: ' + String(e);
    }
    ImmersiveMaterialUtil.cached = result;
    DshmLogger.info(TAG, '沉浸光感能力: usable=' + String(result.usable)
      + ', types=' + String(result.materialTypes.length) + ', reason=' + result.reason);
    return result;
  }

  /** 快捷判断：沉浸光感是否可用。 */
  public static isUsable(): boolean {
    return ImmersiveMaterialUtil.capability().usable;
  }

  /**
   * 构造 HDS 组件（HdsNavigation 标题栏 / HdsTabs 悬浮页签）所需的
   * 材质参数。不可用时返回 undefined，交给组件使用默认模糊样式。
   */
  public static hdsMaterialEffect(): SystemMaterialParams | undefined {
    if (!ImmersiveMaterialUtil.isUsable()) {
      return undefined;
    }
    const params: SystemMaterialParams = {
      materialType: hdsMaterial.MaterialType.ADAPTIVE,
      materialLevel: hdsMaterial.MaterialLevel.ADAPTIVE
    };
    return params;
  }

  /** 供「运行环境」面板展示的一行描述。 */
  public static describe(): string {
    const cap: ImmersiveCapability = ImmersiveMaterialUtil.capability();
    if (cap.usable) {
      return '沉浸光感已启用（' + String(cap.materialTypes.length) + ' 种材质，系统自适应）';
    }
    return '沉浸光感不可用：' + cap.reason;
  }
}
