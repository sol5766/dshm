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
export { hapticTap } from './system/Haptic';
export { isOpenableUrl, openExternalUrl } from './system/OpenLink';
// ArkWeb 网页下载落地（Session 日志 / 工作区文件）：见 system/WebDownloads.ets
export { installWebDownloadDelegate, safeDownloadName } from './system/WebDownloads';
// 原生朗读（TextReader 优先，textToSpeech 兜底）：见 system/ReadAloud.ets
export { ReadAloud } from './system/ReadAloud';
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
export {
  FormFactor,
  readDeviceFacts,
  readFamilyModel,
  isFoldableDevice,
  isDesktopPcSeries,
  isDesktopPcSeriesFull,
  // 【2026-10-28】折叠屏适配：宽度断点（单列/双列/多列）+ 单屏形态判定 + 现场快照。
  // 判据用"物理折叠态 + 宽度"，**不**用 FoldDisplayMode（SDK 注释写明内外屏对应哪个 mode
  // 随机型不同）。调用点：WebApp 的 platformForm()（单屏 ⇒ 答 phone ⇒ 设置面板手机化）、
  // WindowRegistry 的 applyFoldableOrientation（单屏 ⇒ 锁竖屏）。
  FOLD_BREAKPOINT_COMPACT_VP,
  FOLD_BREAKPOINT_MEDIUM_VP,
  foldLayoutTierOf,
  isSingleScreenFoldState,
  isFoldableSingleScreenNow,
  // 【兼容入口】手机模块的 platformSingleScreen 用它；语义已升级为"折叠态 ∪ 窄窗"。
  isFoldableSingleScreen,
  readFoldSnapshot
} from './system/DeviceFacts';
export type { FoldLayoutTier, FoldSnapshot } from './system/DeviceFacts';
export { WindowChrome, windowChromeFor, statusBarOwnedByApp, SYSTEM_BAR_HANDOFF_BG } from './system/WindowChrome';
export type { DeviceFacts } from './system/DeviceFacts';

// ── 沉浸光感材质工具（API 26 uiMaterial；docs/280 步①② 的共享单源）──
export { immersiveMaterialOf, dialogMaterial, shellMaterial, controlMaterial } from './ui/ImmersiveMaterialKit';

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
  folderSelectionAvailable,
  isFolderPickerCancelCode,
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
  requestPublicDirectoryPermission,
  shouldAutoFallbackFolderPicker,
  // 【2026-10-06】手持档的采纳判据（手机/平板：picker 给的目录授权**只活一次进程** ⇒ 还要过
  // "持久授权"这道闸；2in1/PC 不受影响）。理由与真机原始读数见 FilePicker.ets 的 isHandheldForm()。
  isHandheldForm,
  // 【2026-10-13】手机形态（平板不算）—— 只用来**缩小**适配面：设置面板的手机化布局是
  // 手机专属，平板宽度够 ⇒ 走官方桌面形态（用户裁决见 FilePicker.ets 的 isPhoneForm()）。
  isPhoneForm,
  isPathWithin,
  // 【2026-10-03】包名的唯一来源（`Download/<包名>/` 的那一段）。**不是路径来源**：
  // 默认工作区路径的唯一来源是上面 `claimPublicDownloadFolder()` 的返回值，经
  // `buildHostEnv()` 的 `DSHM_PUBLIC_DOWNLOAD` 在 spawn 前交给 Host。包名只用于
  // `NodeRuntime` 的一行诊断日志（核对认领到的目录末段是不是本应用）。
  readBundleName,
  // 【2026-10-15】客户端版本的唯一来源（`<versionName> (<versionCode>)`）。「关于」页
  // 曾经写死 `'1.1.0 (1010000)'` 而包已到 1.1.2 —— 上架自检的 P0，见 docs/163。
  readAppVersionText
} from './system/FilePicker';
export type { PickedFile, PickedFolder } from './system/FilePicker';
// 【2026-10-06】目录授权的**持久化与跨启动恢复**（`persistPermission` 记下来 +
// 启动 `activatePermission` 启用回来）。手持档"侧边栏工作区文件"选完当场能读、重启后也能读
// 靠的就是这一对；判据与真机原始读数见 docs/105。
export { rememberFolderGrant, restoreFolderGrants, storedGrants } from './system/FolderGrants';
export type { FolderGrant, GrantOutcome } from './system/FolderGrants';
// 【2026-10-29，docs/298 P0】华为账号（Account Kit）与云盘（Drive Kit / CloudFoundationKit）
// 的**能力封装**。只给机制：能力探测、缓存暂存、上传/下载/列目录/删除、登录按钮参数。
// **不含策略**：什么时候登录、同步哪些会话、冲突怎么处理，全在装配层。
// 2026-10-30 清理：旧 cloudStorage（开发者云存储）包装整体移除 ——
// 那条路线需要 AGC 建 bucket，已在 docs/307 决策放弃，改走 Asset 端云同步。
// 这里只保留账号侧仍被生产使用的能力；2026-10-31 起新增**静默登录**（docs/322 方案 C：
// 不再弹官方 LoginPanel，`forceLogin=false` 直接取 UnionID）。
export {
  huaweiAccountCapability,
  maskUnionId,
  deviceSummary,
  silentSignIn,
  SilentSignInKind,
  // docs/378：账号展示名（profile scope，端侧读取，无需申请账号权限）
  fetchAccountDisplayName,
  maskAccountLabel
} from './system/HuaweiCloud';
export type { Capability, SilentSignInResult, AccountDisplayNameResult } from './system/HuaweiCloud';
// 【2026-10-29，docs/298 P2】会话同步的**本地清单与打包**（纯离线）。
// 只扫描 `$DSH_HOME/sessions` 产出清单：排除面显式（cache/cores/临时文件）、
// 代际版本按上游 `CANONICAL_LOG_FILENAME` 同款判据解析、输出顺序稳定（可 diff）。
// **不联网、不写入任何会话文件** —— 恢复（P4）是另一层的事。
export {
  buildManifest,
  generationVersionOf,
  isExcludedName,
  MANIFEST_SCHEMA,
  relativePathOf,
  toManifestJson
} from './system/SessionSyncScope';
export type { ManifestJson, SessionEntry, SessionGeneration, SyncManifest } from './system/SessionSyncScope';
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
  openFileLocation,
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
  PARAM_ACTION,
  PARAM_ROUTE,
  PARAM_SESSION_ID,
  PARAM_TITLE,
  PARAM_WINDOW_KIND,
  followScreenRotationOnHandheld,
  // 【2026-10-28】折叠屏朝向：单屏锁竖屏 / 展开跟屏（订阅 foldDisplayModeChange + foldStatusChange，去抖重算）；
  // 非折叠屏早退，既有行为不变。见 WindowRegistry 里的策略说明。
  applyFoldableOrientation,
  releaseFoldableOrientation,
  WindowKind
} from './window/WindowRegistry';
export type { WindowParams } from './window/WindowRegistry';
export { defaultLayoutState, WindowMemory } from './window/WindowMemory';
export type { WindowLayoutState, WindowRect } from './window/WindowMemory';

// ── 运行时身份与窗口台账（D1 §7.7.5b 的可观测证据面） ──
export { registerWindow, relabelWindow, runtimeFacts, runtimeId, unregisterWindow, windowCount } from './runtime/RuntimeSingleton';
export type { RuntimeFacts, WindowLedgerEntry } from './runtime/RuntimeSingleton';

// ── 云同步（2026-10-30，docs/319/320：入口是官方设置里的「云同步」分区，
//    数据与动作在两个原生壳（entry / phone）之间**共用一份**）─────────────────
//
// 【为什么在 platform 而不在 entry】`entry`（PC/平板）与 `phone`（手机）是两个 HAP，
// 各自有自己的 `pages/WebApp.ets`。同步中枢（`SyncEngine` + 落盘/上传/导入/插件恢复）
// 原先住在 entry 私有目录里 ⇒ 手机壳根本没有这套能力，表现就是"平板上设置里有云同步、
// 手机上连分区都不出现"。搬到 platform（两个 HAP 都依赖它）之后，同一份实现给两个壳用，
// 判据（`SyncActions`）与快照口径（`SyncState`）也都只有一处，不可能漂移。
export { SyncEngine } from './sync/SyncEngine';
export type { SyncEngineState, SyncScopeSummary } from './sync/SyncEngine';
export { initialProgress, progressRatio, makeUnitId, encodeMetadata, UNIT_METADATA_SCHEMA, UnitKind } from './sync/SyncModel';
export type { TaskProgress, SyncUnit } from './sync/SyncModel';
export { openStore, statByKind, SYNC_TABLE, enableCloudSync, runCloudSync, stageAsset, upsertUnit } from './sync/SyncStore';
export type { KindStat } from './sync/SyncStore';
export { planSessions, planAttachments, planSkills, mergePlans, workspaceIdOf } from './sync/SyncPlanner';
export type { PlanResult } from './sync/SyncPlanner';
export { runUpload } from './sync/UploadRunner';
export { sha256OfFile } from './system/FileDigest';
export type { UploadReport } from './sync/UploadRunner';
export { runImport, discoverImportCandidates } from './sync/ImportRunner';
export type { ImportCandidate, ImportReport, WorkspaceMapping } from './sync/ImportRunner';
export { readPluginManifest, toInstallPayload, specKind, isBundledPackage } from './sync/PluginManifest';
export type { PluginManifest, PluginSpec } from './sync/PluginManifest';
export { diffPlugins, runPluginRestore } from './sync/PluginRestore';
export type { PluginDiff, PluginRestoreReport } from './sync/PluginRestore';
export {
  CLOUD_ACTION_LOGIN,
  CLOUD_ACTION_SIGNOUT,
  CLOUD_ACTION_ENABLE,
  CLOUD_ACTION_DISABLE,
  CLOUD_ACTION_UPLOAD,
  CLOUD_ACTION_PULL,
  CLOUD_ACTION_RESTORE,
  CloudActionCode,
  decideCloudAction,
  encodeCloudActionReply
} from './sync/SyncActions';
export type { CloudActionDecision, CloudActionFacts } from './sync/SyncActions';
export { SyncRoot, encodeCloudState, encodePlugins, encodeUnits, cloudScopeReady } from './sync/SyncState';
// 云同步的原生面板（官方 LoginPanel 只能渲染在页面里；两个壳共用同一份界面）
export { CloudSyncSettings } from './view/CloudSyncSettings';
// 设计令牌（尺度原语：Sp / Radius / Border / Fs / Lh / Dur / Sz / Breakpoint / SemanticColor）。
// 2026-10-30 从 appstate 搬到本层（docs/320）：platform 不能反向依赖 appstate，
// 而云同步的共享面板在 platform 里要用这些令牌。appstate 侧仍以 `appstate/ui/Tokens.ets`
// 再导出，既有调用点不受影响 —— 令牌只有这一份。
export { Border, Breakpoint, Dur, Fs, Lh, Radius, SemanticColor, Sp, Sz } from './ui/Tokens';
