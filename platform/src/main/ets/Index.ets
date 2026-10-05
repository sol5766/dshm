/**
 * HAR 模块对外入口：设备能力层。
 *
 * 分层纪律（与 `connection` / `dshcompat` / `appstate` 同一套）：
 *   本模块只提供**机制**——把 HarmonyOS 的系统能力（通知、长时任务、剪贴板、分享、
 *   窗口与形态、运行时身份）包装成中性、可注入、可降级的接口。
 *   它**不认识** DSH 上游（无端点、无事件名），也**不含产品策略**（不知道什么该通知）。
 *   策略在 `appstate`，装配在 `entry`。
 *
 * 这样分层的收益：
 *   上游升级时不碰本模块；换平台（如未来做其他 OS）时只换本模块；
 *   单元测试可在无设备环境下覆盖策略，而不必 mock 系统 API。
 */

// ── 通知 ──
export { NotificationCenter, priorityAllowsBypassDnd, stableId } from './notify/NotificationCenter';
export { NotifyPriority, NotifySlot } from './notify/NotifyTypes';
export type { NotificationDraft, NotifyFacts, NotifyRoute } from './notify/NotifyTypes';

// ── 后台保活 ──
export { KeepAlive } from './notify/KeepAlive';
export type { KeepAliveFacts } from './notify/KeepAlive';

// ── 系统能力 ──
export { clearClipboard, copyText, readText } from './system/Clipboard';
export { isOpenableUrl, openExternalUrl } from './system/OpenLink';
export { shareText } from './system/ShareBoard';
export type { ShareText } from './system/ShareBoard';
export { SecretLoadState, SecretStore } from './system/SecretStore';
export type { SecretLoadResult } from './system/SecretStore';
export { HostStore } from './system/HostStore';
export type { RememberedHost, RememberedToken } from './system/HostStore';
export {
  EVENT_HOST_CONNECTED,
  EVENT_KEY_HOST_TOKEN,
  EVENT_KEY_HOST_URL,
  EVENT_PICKER_SUBSTITUTED,
  EVENT_KEY_PICKER_REASON,
  EVENT_KEY_PICKER_PATH
} from './system/HostEvents';
export { FormFactor, readDeviceFacts } from './system/DeviceFacts';
export type { DeviceFacts } from './system/DeviceFacts';

// ── 输入设备采集（P3：输入模态的**真实事实**来源；SDK 枚举，不靠形态猜） ──
export { readInputSources, watchInputSources } from './system/InputDevices';
export type { InputSourceReading } from './system/InputDevices';
export {
  applyThemeMode,
  colorModeOf,
  KEY_THEME_MODE,
  LocalPrefs,
  ThemeMode,
  themeModeOf
} from './system/LocalPrefs';
export {
  // 【2026-10-03】启动期**幂等认领**本应用在公共 Download 下的专属目录
  //（DOWNLOAD 模式、无 UI、每次启动重认一次）。结果经 `buildHostEnv()` 的
  // `DSHM_PUBLIC_DOWNLOAD` 在 spawn 前交给 Host，Host 只做"消费 + 验证"、不再 mkdir。
  claimPublicDownloadFolder,
  MAX_ATTACHMENT_BYTES,
  PickOutcome,
  pickDocument,
  pickFolder,
  // 【2026-10-03】"用户可见目录 + agent 可读写删"用到的两件设备能力
  // （见 dsh-移植研究/30-DSHM文件能力植入-侦察与设计.md）。
  // **不导出权限申请**：本路线不申请任何权限（权限零差异铁律 + ACL 白名单只有 5 条），
  // 上一版的权限申请函数已随 module.json5 的两条声明一并删除。
  probePathWritable,
  publicDownloadFolder,
  // 【2026-10-03】包名的唯一来源（`Download/<包名>/` 的那一段）。**不是路径来源**：
  // 默认工作区路径的唯一来源是上面 `claimPublicDownloadFolder()` 的返回值，经
  // `buildHostEnv()` 的 `DSHM_PUBLIC_DOWNLOAD` 在 spawn 前交给 Host。包名只用于
  // `NodeRuntime` 的一行诊断日志（核对认领到的目录末段是不是本应用）。
  readBundleName
} from './system/FilePicker';
export type { PickedFile, PickedFolder } from './system/FilePicker';
// 【2026-10-04】系统原生文件预览（PreviewKit）。只为**非文本**文件（Office 全族、
// pdf、图片、音视频）提供机制：路径→URI、后缀→MIME、可用性、开/关系统预览窗。
// 上游的 Office 预览走 LibreOffice 引擎转换，而 `libreoffice-kit` 在本平台直接
// `Unsupported LibreOfficeKit host`（WASM 回退在 `--jitless` 下必死）⇒ 引擎路线
// 结构性不可达，设备自带能力是唯一落点，也是"原生体验"的落点。
// **本模块不含策略**：什么时候弹窗、点不点确定，全在装配层。
export {
  canPreviewFile,
  closeSystemPreview,
  isPreviewDisplayed,
  isSystemPreviewableName,
  mimeTypeForName,
  openSystemPreview,
  SYSTEM_PREVIEW_SUFFIXES,
  uriFromPath
} from './system/FilePreview';
/** E147：字符串资源取值入口（状态字符串不能用 `$r`，须经此函数） */
export { localized, localizedOr } from './system/Strings';

// ── 窗口与形态 ──
export {
  currentWindowId,
  focusMainWindow,
  openRoutedWindow,
  openSessionWindow,
  parseWindowParams,
  PARAM_ROUTE,
  PARAM_SESSION_ID,
  PARAM_TITLE,
  PARAM_WINDOW_KIND,
  WindowKind
} from './window/WindowRegistry';
export type { WindowParams } from './window/WindowRegistry';
export { defaultLayoutState, WindowMemory } from './window/WindowMemory';
export type { WindowLayoutState, WindowRect } from './window/WindowMemory';

// ── 运行时身份与窗口台账（D1 §7.7.5b 的可观测证据面） ──
export { registerWindow, relabelWindow, runtimeFacts, runtimeId, unregisterWindow, windowCount } from './runtime/RuntimeSingleton';
export type { RuntimeFacts, WindowLedgerEntry } from './runtime/RuntimeSingleton';
