/**
 * 系统输入设备采集（P3：输入模态的**真实事实**来源）。
 *
 * ## 为什么不再靠形态猜
 *
 * 此前"有没有指针"是从设备形态推的（`keyboardLikely`：2in1/桌面模式 ⇒ 像键鼠）。
 * 那会在两个方向上判错：手机插鼠标 / 平板配触控笔画不出 hover 与右键；2in1 拆掉键盘
 * 仍被当成有键盘。系统的 multimodalInput 能**直接枚举输入设备**，没有理由继续猜。
 *
 * ## 依据（SDK 事实，不是推测）
 *
 * `@ohos.multimodalInput.inputDevice.d.ts`：
 *   · `getDeviceList(): Promise<Array<number>>`（`@since 9`，**无 `@permission`**）
 *   · `getDeviceInfoSync(deviceId): InputDeviceData`（`@since 10`，**无 `@permission`**）
 *   · `InputDeviceData.sources: Array<SourceType>`，而 `SourceType` 是字符串联合：
 *     `'keyboard' | 'mouse' | 'touchpad' | 'touchscreen' | 'joystick' | 'trackball'`
 *   · `on('change', listener)` / `off('change', listener)`：设备热插拔（`@since 9`）
 *
 * 所以"有哪些输入源"是**读得出来的字符串列表**，判定规则全部落在纯模型
 * `appstate/model/InputFacts`（可在本机直接测）；本文件只负责取回来。
 *
 * ## 失败不假装成功
 *
 * 取不到时返回 `null`（而不是空数组）——"枚举不可用"与"枚举成功但没有键鼠"是两件事，
 * 前者要退回形态猜测，后者是权威结论。这个区分由纯模型消费（`ModalityEvidence.enumerated`）。
 */

import inputDevice from '@ohos.multimodalInput.inputDevice';
import { BusinessError } from '@ohos.base';

/**
 * 一次采集的结果：**每台设备**的输入源列表；`null` = 枚举不可用（与"没有设备"区分开）。
 *
 * 【为什么按设备分组返回、而不是在这里摊平】摊平与判定规则属于纯模型
 * （`appstate/model/InputFacts`，可在本机直接测）。更重要的是**架构边界**：
 * `platform` 在 `appstate` 之下，不许反向依赖——第一版我在这里 `import ... from 'appstate'`，
 * 编译器直接判 `Cannot find module 'appstate'`，这条边界是被工具守住的。
 */
export type InputSourceReading = string[][] | null;

/**
 * 读取当前所有输入设备的输入源（按设备分组）。
 *
 * 用 `getDeviceInfoSync` 逐个取：设备数量是个位数，同步取比串行 await 更简单，
 * 也避免在启动路径上引入多段异步状态。
 */
export async function readInputSources(): Promise<InputSourceReading> {
  try {
    const ids: number[] = await inputDevice.getDeviceList();
    const perDevice: string[][] = [];
    for (let i = 0; i < ids.length; i++) {
      try {
        const info = inputDevice.getDeviceInfoSync(ids[i]);
        const sources: string[] = info.sources as string[];
        if (sources !== undefined && sources !== null && sources.length > 0) {
          perDevice.push(sources);
        }
      } catch (e) {
        // 单个设备取不到（中途拔出）不该让整次采集失败
        const err = e as BusinessError;
        console.warn(`[DSHM-Input] 设备 ${ids[i]} 信息读取失败：${err.code} ${err.message}`);
      }
    }
    return perDevice;
  } catch (e) {
    const err = e as BusinessError;
    console.warn(`[DSHM-Input] 输入设备枚举不可用：${err.code} ${err.message}`);
    return null;
  }
}

/**
 * 监听设备热插拔，变化时重新采集。
 *
 * 【为什么需要它】枚举只在启动时做一次的话，运行中插上鼠标不会生效——
 * 而这恰恰是"手机/平板当工作台用"的常见动作。
 *
 * @returns 取消监听的函数（页面销毁时调用；`off` 不传 listener 会清掉所有监听，
 *          这里刻意传同一个 listener，避免误伤别的模块注册的回调）
 */
export function watchInputSources(onChange: (sources: InputSourceReading) => void): () => void {
  const listener = (_event: object): void => {
    readInputSources().then((sources: InputSourceReading) => {
      onChange(sources);
    });
  };
  try {
    inputDevice.on('change', listener);
  } catch (e) {
    const err = e as BusinessError;
    console.warn(`[DSHM-Input] 无法监听设备热插拔：${err.code} ${err.message}`);
    return () => {
    };
  }
  return () => {
    try {
      inputDevice.off('change', listener);
    } catch (e) {
      const err = e as BusinessError;
      console.warn(`[DSHM-Input] 取消设备监听失败：${err.code} ${err.message}`);
    }
  };
}
