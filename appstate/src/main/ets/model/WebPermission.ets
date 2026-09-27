/**
 * Web 权限裁决的纯逻辑（可单测）。
 *
 * 【为什么单独成文件】这段判断原先内联在 `WebApp.ets` 的 `@Component` 里，
 * 而 `@Component` 无法被 `tools/check-layout-fixtures.mjs` 单测（它只编译纯 .ets）。
 * 2026-09-26 真机暴露的 bug 正是"内联逻辑没被任何门禁覆盖"：
 *   ArkWeb 的 `getOrigin()` 返回 `http://127.0.0.1:3120/`（**带结尾斜杠**），
 *   而原正则 `(:\d+)?$` 要求端口后立刻结束 ⇒ 判定为非回环 ⇒ 把自己应用的
 *   麦克风请求也拒了，现象是 `diag-mic-probe` 报 `NotAllowedError`。
 * 所以把判定提取成纯函数，并加入门禁断言（见 check-layout-fixtures.mjs）。
 *
 * 本文件零依赖（不 import 任何 ArkUI/HarmonyOS API），便于 tsc 单测。
 */

/**
 * 判断 Web 来源是否为"本机回环"。
 *
 * 【为什么要这道闸】只放行我们自己的 Host 页面（`http://127.0.0.1:<port>`），
 * 避免页面被换成外站后仍能开麦。
 *
 * 【为什么容忍结尾斜杠】实测 `getOrigin()` 给的是 `http://127.0.0.1:3120/`。
 * 按 URL 规范 origin 本应是 scheme://host:port（无路径），但 ArkWeb 实际带了 `/`。
 * 兼容两种写法（有无结尾斜杠）比赌哪一个更可靠。
 *
 * 【为什么不用 includes/startsWith 之类的宽松匹配】`http://127.0.0.1.evil.com`
 * 这类会骗过 `startsWith('http://127.0.0.1')`。所以用**锚定的完整正则**：
 * scheme 必须是 http/https、host 必须是三种回环写法之一、端口可有可无、
 * 结尾仅允许一个可选斜杠，之后不能再有任何字符。
 *
 * @param origin `PermissionRequest.getOrigin()` 的返回值
 * @returns 是回环来源则为 true
 */
export function isLoopbackOrigin(origin: string): boolean {
  if (origin === undefined || origin === null || origin.length === 0) {
    return false;
  }
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(origin);
}

/**
 * 裁决 Web 侧的受保护资源请求。
 *
 * 规则：**只放行「本机回环页面 + 只要麦克风」**这一种组合；
 * 其余（要摄像头/MIDI、或来源非回环、或同时要多项）一律拒绝。
 * 本应用是开发工具宿主，不需要摄像头与 MIDI。
 *
 * @param origin `getOrigin()`
 * @param requested `getAccessibleResource()`（如 ["TYPE_AUDIO_CAPTURE"]）
 * @returns 是否应当 grant
 */
export function shouldGrantWebPermission(origin: string, requested: string[]): boolean {
  const wantsAudio: boolean = requested !== undefined && requested !== null
    && requested.indexOf(AUDIO_CAPTURE_RESOURCE) >= 0;
  const onlyAudio: boolean = requested !== undefined && requested !== null
    && requested.length > 0 && requested.every((r: string) => r === AUDIO_CAPTURE_RESOURCE);
  return wantsAudio && onlyAudio && isLoopbackOrigin(origin);
}

/** ArkWeb `ProtectedResourceType.AUDIO_CAPTURE` 的字符串值（避免依赖 SDK 常量以便单测） */
export const AUDIO_CAPTURE_RESOURCE: string = 'TYPE_AUDIO_CAPTURE';
