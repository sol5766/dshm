/**
 * Web 壳页：官方 apps/desktop 的鸿蒙等价物。
 *
 * 【为什么这么建】官方桌面（github.com/deepseek-ai/deepseek-harness apps/desktop）
 * 的界面**不是自绘的**：桌面壳主进程起 dsh-desktop-host，拿到 ready 事件里的
 * authenticatedUrl 后 `BrowserWindow.loadURL` 加载 Host 服务的 web 前端
 * （dsh-web-app）。renderer/ 只放更新对话框等辅助窗口。
 * 鸿蒙侧等价物：EntryAbility 起 Host（NodeRuntime，onCreate 即跑）→ 把带 token
 * 的完整启动 URL 发布到 AppStorage（`dshHostLaunchUrl`，见 adoptLocalHost /
 * applyHostLaunchParams）→ 本页用 Web 组件加载它。Host 的 303 + set-cookie
 * 鉴权与官方 web-document.ts 的 authenticateWebHost 期望完全一致，ArkWeb 的
 * cookie 管理会自动跟随，无需任何手工换票。
 *
 * 【为什么只认 dshHostLaunchUrl，不认 dshLastHost* 那组键】旧键是「记住的 Host」
 * 语义，token 对**本次进程**可能是旧的（dsh 每次启动换 token）；而本键只在
 * 「本次启动成功」（host.start() 的 then，或启动参数带进来）后才发布，
 * 拿到的 token 一定有效。
 *
 * 【阶段机】BOOTING（等 Host，覆盖首启解包 30–60s 的窗口）→ LOADING → READY；
 * 主资源失败/401 → ERROR（覆盖层 + 重试，Web 保持挂载以便 refresh）。
 *
 * 【2026-09-21 品牌对齐官方；2026-11-11 侧栏入口回归官方】应用名定为 DSHM
 * （dsh + HarmonyOS），对齐官方桌面版：
 * 手机壳是**全屏 WebView**（不画原生顶栏、也没有「应用 / 关于 / 编辑」菜单）——
 * 侧栏开关就是官方客户端自己那颗按钮。2026-11-11 起**不再自绘任何 ⊞**：
 * 收起 / 小窗态把官方 opener 强制常显（`syncOpener()` + CSS），全链路只有官方一颗。
 * 启动画面用品牌标 `logo_dark` 资产（由 `tools/make-icon.py` 生成，不自绘）；
 * 应用安装名与关于对话框同改为 DSHM，关于版本直接显示当前运行的 dsh 核心版本。
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { webview } from '@kit.ArkWeb';
import { BusinessError, deviceInfo } from '@kit.BasicServicesKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { emitter } from '@kit.BasicServicesKit';
import { picker, fileUri } from '@kit.CoreFileKit';
import { common, ConfigurationConstant } from '@kit.AbilityKit';
// `PermissionRequestResult` / `Permissions` 是 AbilityKit 的**顶层**导出，
// 不在 `abilityAccessCtrl` 命名空间下（实测编译报错 "has no exported member"）。
import { abilityAccessCtrl } from '@kit.AbilityKit';
import type { PermissionRequestResult, Permissions } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { curves, window, FrameCallback } from '@kit.ArkUI';
import { Fs, HarmonySpacing, Radius, Sp, parseNotifyRoute } from 'appstate';
import { BRAND_SHIM_JS } from 'dshcompat';
// Web 权限裁决的纯逻辑（真机 bug 修复：getOrigin() 带结尾斜杠）
import { isLoopbackOrigin, shouldGrantWebPermission } from 'appstate';
// 语音音频换算（路线 A）：HMS 只收 16k/单声道/16位，且 writeAudio 只收 640/1280 字节
import { HMS_SAMPLE_RATE, HMS_CHUNK_BYTES, makeTonePcm16, slicePcmChunks, resamplePcm16, pcmDurationMs, mergeTranscript, isNearSilence } from 'appstate';
// HMS 系统语音识别（路线 A）。@kit.CoreSpeechKit 同时导出 speechRecognizer 与 textToSpeech
import { speechRecognizer, textToSpeech } from '@kit.CoreSpeechKit';
// 音频采集（路线 A 端到端自检：以 16000 Hz 直接采麦克风喂给 HMS）
import { audio } from '@kit.AudioKit';
import { util } from '@kit.ArkTS';
// 听写→剪贴板：把识别文本写进系统剪贴板，供用户长按黏贴
import { copyText, hapticTap , dialogMaterial, ScanSaveKind, persistScanResults, scanUris } from 'platform';
// 会话区「加号」：Vision Kit 文档扫描 / 表格提取（DocScan 能力不可用时走系统文件选择器）
import { DocumentScanner, DocumentScannerConfig, DocType, SaveOption } from '@kit.VisionKit';
// 【2026-10-03】"用户可见目录 + agent 可读写删"的两件设备能力（见
// platform/src/main/ets/system/FilePicker.ets 的注释，与
// dsh-移植研究/30-DSHM文件能力植入-侦察与设计.md §5.3）。
// 【不含权限申请】本路线**不申请任何权限**（权限零差异铁律 + ACL 白名单只有 5 条，
// 见 FilePicker.ets 顶部权限说明注释）⇒ 上一版的权限申请函数已整体删除。
import { PickOutcome, probePathWritable, publicDownloadFolder, requestPublicDirectoryPermission, folderSelectionAvailable, shouldAutoFallbackFolderPicker, isHandheldForm, isPhoneForm, isFoldableDevice, isFoldableSingleScreen, isPathWithin, readDeviceFacts, windowChromeFor, statusBarOwnedByApp, SYSTEM_BAR_HANDOFF_BG, installWebDownloadDelegate, ReadAloud, shareText } from 'platform';
import type { DeviceFacts } from 'platform';
// 目录授权的持久化与跨启动恢复（手持档"选完能读、重启也能读"的唯一开关，见 docs/105）
import { rememberFolderGrant } from 'platform';
import type { GrantOutcome } from 'platform';
import { EVENT_PICKER_SUBSTITUTED, EVENT_KEY_PICKER_REASON, EVENT_KEY_PICKER_PATH } from 'platform';
import type { PickedFolder } from 'platform';
// 外链外开（2026-09-28，修「设置→登录」点不动）：见 OPEN_LINK_SHIM_JS。
// isOpenableUrl 做 http/https 白名单；openExternalUrl 内部走 context.openLink。
import { isOpenableUrl, openExternalUrl } from 'platform';
// 【2026-10-04】系统原生预览（PreviewKit）：Office 全族/pdf/图片/音视频。
// 上游的 Office 预览要过 LibreOffice 引擎转换，而 `libreoffice-kit` 在本平台
// 直接 `Unsupported LibreOfficeKit host`（WASM 回退在 `--jitless` 下必死）
// ⇒ 引擎路线结构性不可达，设备自带预览服务是唯一落点（也是"原生体验"的落点）。
// 见 platform/src/main/ets/system/FilePreview.ets。
import { mimeTypeForName, openFileLocation as openFileLocationPicker, openSystemPreview, uriFromPath } from 'platform';
/*
 * 云同步（2026-10-30，docs/320）：接口在官方设置面板里，由网页插件渲染；
 * 登录/开关/上传/拉取/导入全部由**这一份**中枢（platform）执行 ——
 * 与 PC / 平板壳共用同一份实现与同一套判定，不存在"平板有、手机没有"。
 */
import { CloudSyncSettings } from 'platform';
import {
  SyncEngine, SyncEngineState, SyncRoot, encodeCloudState, decideCloudAction, encodeCloudActionReply,
  CloudActionDecision, silentSignIn, SilentSignInKind, fetchAccountDisplayName,
  CLOUD_ACTION_LOGIN, CLOUD_ACTION_SIGNOUT, CLOUD_ACTION_UPLOAD, CLOUD_ACTION_PULL, CLOUD_ACTION_ENABLE,
  CLOUD_ACTION_DISABLE, CLOUD_ACTION_RESTORE
} from 'platform';
// 方案 B：在 WebView 请求麦克风的时刻同步启动 ArkTS 侧环形采集。
// 依据：真机实测官方那路（getUserMedia→MediaRecorder→重采样）音频识别不准，
// 而同设备 AudioCapturer 直采总是正确 ⇒ provider 优先用这一路。

/**
 * 原生听写（供官方麦克风按钮调用）的模块级状态。
 *
 * 【为什么放模块级而非 @State】桥方法由 WebView **同步**调用，需在任意时刻读写；
 * @State 会触发 UI 重渲染，且跨方法共享不便。
 */
let natCap: audio.AudioCapturer | undefined = undefined;
let natGeneration: number = 0;
let natWork: Promise<void> = Promise.resolve();
let natChunks: Uint8Array[] = [];
let natBytes: number = 0;
let natPhase: string = 'idle';
let natPeak: number = 0;
/*
 * 最近一次回调的电平峰值（0~32767）—— 诊断用。
 * 与 natPeak（累计峰值，只增不减）分开：累计值会让柱状图一直顶格。
 */
let natRecent: number = 0;
/*
 * 频谱用的均方根电平（0~32767，带指数平滑）。
 * 官方波形按 RMS 使用该值，故与它口径一致。
 */
let natRms: number = 0;
/* 平方和与样本数：用于按批次算 RMS（在既有采样循环里累加，不新增遍历）。 */
let natSumSq: number = 0;
let natSampleCount: number = 0;
let natStartedAt: number = 0;

/** 把裸 PCM 包成 canonical 16k 单声道 PCM16 WAV（官方 Recording.stop 直接用）。 */
function natPcmToWav(pcm: Uint8Array): Uint8Array {
  const out: Uint8Array = new Uint8Array(44 + pcm.length);
  const v: DataView = new DataView(out.buffer);
  const put = (at: number, s: string): void => {
    for (let k = 0; k < s.length; k++) {
      out[at + k] = s.charCodeAt(k);
    }
  };
  put(0, 'RIFF');
  v.setUint32(4, out.length - 8, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, HMS_SAMPLE_RATE, true);
  v.setUint32(28, HMS_SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  put(36, 'data');
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/**
 * `recognizerMode` 的候选写法（A/B 探针用）。
 *
 * 【为什么需要接口】ArkTS 禁止无类型对象字面量
 * （`arkts-no-untyped-obj-literal`），而 `CreateEngineParams.extraParams`
 * 的文档类型是 `Object` —— 得给它一个显式形状。
 */
interface DshmRecognizerModeVariant {
  mode?: string;
  type?: string;
}
const DOMAIN: number = 0xD5D5;
const TAG: string = 'DshWebApp';

/** 云同步清单统计的最小刷新间隔（ms）：见 refreshCloudStats 的注释。 */
const CLOUD_STATS_MIN_GAP_MS: number = 3000;


/**
 * `files/diag-web-console` 的单次冷启动行数上限。
 *
 * 【为什么要有上限】网页端启动期 console 可达数千行（各类插件注册、资源探测、
 * 警告刷屏），而排查真正要看的那几行（例：右侧栏占位失败时的 `already registered`）
 * 会被淹没；且该文件在 `files/` 里，无限追加会持续占盘。取 4000 是实测折中：
 * 足以覆盖一次冷启动的全部启动期输出，又能让文件停在几百 KB 量级。
 */
const CONSOLE_SINK_LINE_CAP: number = 4000;

/**
 * `abilityAccessCtrl` 里"已授权"的取值。
 *
 * 【为什么写成常量而不是 import 枚举】`GrantStatus.PERMISSION_GRANTED` 是
 * ACL 的枚举，而 `requestPermissionsFromUser` 的返回里 `authResults` 是
 * **number[]**（原始码：0=已授权，-1=未授权）。写死 0 会让读的人以为它和
 * 枚举无关，所以这里给它一个名字并注明出处。
 */
const GRANTED_CODE: number = 0;
/** 运行时申请：语音输入 / 会议录音。 */
const MIC_PERMISSION: Permissions = 'ohos.permission.MICROPHONE';
/** 运行时申请：用户主动点击“编辑 → 粘贴”时读取系统剪贴板。 */
const PASTE_PERMISSION: Permissions = 'ohos.permission.READ_PASTEBOARD';













/**
 * 上游 Web 能力载体声明（2026-09-24 官方功能对齐）：官方 dsh 前端把账号、更新等
 * 可选能力注册在 `globalThis.dshDesktop` 上。本应用
 * 是 ArkUI Web 壳，天然没有这个全局——后果是三处功能静默缺席（用户验收实测）：
 *   ① `dsh-client-ui-settings-account` 的 apply 首行 `if (!("dshDesktop" in
 *      globalThis)) return;`（lib/client.js:4109；原文误记为 :2217，2026-09-28 以
 *      具体文件复核更正——core 树内检索必须 `Select-String -Path <具体文件>`，
 *      `Get-ChildItem -Include` 会漏检）——不注入则左下角账号菜单
 *      （settings.launcher → AccountMenu，含登录入口）、设置面板账号 section、
 *      登录对话框（SignInDialog）全部不注册，即"左下角设置少了登录界面"；
 *   ② `dsh-client-ui-settings-general` 的 DesktopUpdateSource 按
 *      `carrier?.protocolVersion === 1 ? carrier.updates : void 0` 取更新载体；
 *   ③ `dsh-client-ui-sidebar-browser` 的桌面浏览器 tab 载体同式可选链。
 * 注入 `{ protocolVersion: 1 }` 的边界：②③取不到 updates/browser 字段走 undefined
 * 安全降级（无更新指示、Web 内置 iframe 浏览器，均为官方 Web 形态）；另
 * `dsh-client-ui-settings-models` 的 API-key credentialOnboarding 以
 * `!("dshDesktop" in globalThis)` 为显示条件，注入后关闭——这正是官方桌面口径
 * （桌面版引导账号登录，不引导 API key）。
 *
 * 【登录只能在系统浏览器里完成，本文件必须自己实现"外开"（2026-09-28）】
 * 此前这里写过「登录链路端侧可达：…系统浏览器可及」——那句话只证明了 OAuth 回调
 * 地址（127.0.0.1:3120）在设备本机可达，**完全没有证明"有人会去拉起浏览器"**，
 * 属误导，已删。实际链路：
 *   ① H5 点「登录」→ 一元 `account/startSignIn(client, callbackOrigin,"desktop")`
 *      → host 建 attempt（`dsh-deepseek-account-platform/lib/index.js:797-856`）；
 *   ② authorizeUrl 只在 `account/watch` 流里出现：`update()`（`:933-940`）每次
 *      都会剥掉 authorizeUrl，只有 `:1012 update(attempt,{phase:"waiting-browser",
 *      authorizeUrl,…})` 那一次带上，经 `changed()`（`:890-912`）推给 watch 订阅者；
 *   ③ 该 URL 是**公开 https**（`https://platform.deepseek.com/dsh/authorize?...`），
 *      授权完成走 loopback 回调；且 `loginSource="desktop"` 时 callback 只回
 *      **HTTP 204**（`:834-840`，仅 `login_source=web` 才回关页 HTML）⇒ **绝不能在
 *      本 WebView 内打开**，否则应用页面被 204 空页替换。
 * 官方桌面壳靠主进程 `setWindowOpenHandler` + `shell.openExternal` 外开，
 * 但那是**壳外代码**：全 core 树 grep `setWindowOpenHandler|shell.openExternal`
 * 零命中，`dshDesktop` 契约里也只有 shortcuts/keyboard/updates/browser 四类能力，
 * **没有任何外开 API**。故 ArkUI 壳必须自己接：见下方 OPEN_LINK_SHIM_JS。
 */
const DESKTOP_CARRIER_JS: string =
  'if(typeof globalThis.dshDesktop==="undefined"){' +
  'globalThis.dshDesktop={protocolVersion:1};}';

/*
 * 【已删除：`FISH_LOGO_VIEWBOX_W/H`（原值 23.16 / 17.04）】2026-10-10 顶栏左上角从
 * 移动端侧栏按钮由 Web 垫片提供，壳侧不再保留顶栏图标素材
 * （图标是正方形，不再需要按官方 viewBox 算高度比）。
 * 它们守的那条教训仍然成立、也仍然值得留着：**贝塞尔控制点的包围盒 ≠ 曲线墨迹的
 * 包围盒**（控制点可以落在曲线外侧）。当年据此以为"墨迹溢出了官方 viewBox"，把一个
 * 偏大 ~1%、左右留白不等的盒设成 ArkUI 的 viewPort —— 那本身就是"图形看起来歪"的
 * 一个来源。实测（每段 C 曲线离散 400 点）真实紧包围盒 = 23.1600 × 17.0434，
 * **恰好等于官方 viewBox**（零溢出）。
 */


/**
 * 目录选择垫片：经 javaScriptOnDocumentStart 注入，官方文档保证
 * "The script runs before any JavaScript code of the page"——即先于官方
 * wire bootstrap 执行，是 桌面壳 preload 的等价物。
 *
 * 【为什么需要垫片】官方 FAQ 定论：javaScriptProxy 仅支持同步调用，
 * 「异步调用无法获取执行结果」——asyncMethodList 暴露的 async pick()
 * 实测（diag-pick-called 文件证明被调、选择器弹出、选完）resolve 值
 * 永远回不到 H5，await 永远 pending。而官方前端 native 面的契约固定为
 * __DSH_DIRECTORY_PICKER__.pick(): Promise<string|null>，前端代码不可改。
 *
 * 【三段式】
 * 1) 本垫片（文档开始时执行）：定义 __DSH_DIRECTORY_PICKER__.pick()，
 *    内部调 javaScriptProxy 同步桥 __DSHM_BRIDGES__.startPick(id)
 *    （同步调用能拿到返回值），把同步通道包装成真 Promise；
 * 2) ArkTS 侧拉起 DocumentViewPicker，选完把结果通过
 * 3) controller.runJavaScript 回调本垫片的
 *    __DSH_DIR_PICKER_RESOLVE__(id, {path, error})，resolve 掉 H5 Promise。
 *
 * 【语义】path 字符串 = 选中目录；null = 用户取消；error 非空 = reject——
 * 与官方 桌面壳 preload 契约一致（null 时前端 onCancel 静默收场）。
 * 【兜底】120s 超时防挂死；startPick 返回非 'ok'（busy/noctx）→ resolve(null)。
 */
/*
 * ── 桥接契约层（2026-11-16，参考社区 electron-arkts-bridge-kit 的 callSync/callAsync 契约）──
 *
 * 【解决什么】现有 `__DSHM_BRIDGES__` 是 javaScriptProxy 直出：返回什么各写各的、没有统一
 * 错误结构、没有超时、异步路径各自维护 pending（picker 自己一份）。新增桥只能照抄旧形态，
 * 迟早出现"有的返回布尔、有的返回字符串、有的抛异常、有的静默"。
 *
 * 【契约】（与社区套件同构，便于对照）
 *   dshmBridge.call(name, argsJson)          → 同步，返回 JSON 字符串信封
 *   dshmBridge.callAsync(name, argsJson, {timeoutMs})
 *                                            → Promise<JSON 字符串信封>
 *   dshmBridge.complete(id, ok, data, msg)   → 原生侧完成一个异步操作（幂等）
 *   信封：{"code":0|1,"data":"...","msg":"..."}，code=0 成功；data/msg 恒为字符串。
 *
 * 【语义】
 *   · 未知路由 / 桥未就位 / 参数不是 JSON 数组 / 业务抛错 ⇒ code=1，不向页面抛异常。
 *   · callAsync 对普通同步路由是"立即完成"；对登记过的异步路由（当前 pickDirectory）
 *     先建 pending，再由完成方调 complete；同一 id 只有第一次完成生效，迟到/重复回调忽略。
 *   · 超时只结束等待，不取消业务（与社区套件同一口径）；默认 15s，单次可配 1—300000ms；
 *     pickDirectory 默认 125s（略大于 picker 自身 120s，避免抢在它之前误判超时）。
 *   · 参数统一走 JSON 数组字符串（如 `["https://example.com","confirm"]`），方法名必须
 *     是 `__DSHM_BRIDGES__` 上真实存在的函数，否则拒绝 —— 不提供 eval/动态执行口。
 */
const BRIDGE_CONTRACT_JS: string = `(function () {
  if (globalThis.__DSHM_BRIDGE_CONTRACT__) { return; }
  var DEFAULT_TIMEOUT_MS = 15000;
  var MAX_TIMEOUT_MS = 300000;
  var ROUTE_TIMEOUTS = { pickDirectory: 125000 };
  var pending = {};
  var seq = 0;
  /*
   * 【同源闸门】本垫片由 javaScriptOnDocumentStart 注入，scriptRules 为 '*'——
   * 若 ArkWeb 把它注入到子 frame（例如侧栏浏览器 tab 的远端页面），那些页面同样能
   * 看到全局对象。桥本身（javaScriptProxy）是否也进入子 frame 未在 SDK 文档中明确，
   * 所以这里**按最坏情况**设闸：以本 document 的 origin 为唯一允许值，调用时现读；
   * 不一致即拒绝（code=1, msg='origin-denied'）。主页面正常同源调用零影响。
   */
  var APP_ORIGIN = '';
  try { APP_ORIGIN = String(globalThis.location && globalThis.location.origin || ''); } catch (e) { APP_ORIGIN = ''; }
  function originAllowed() {
    if (APP_ORIGIN.length === 0) { return false; }
    try { return String(globalThis.location && globalThis.location.origin || '') === APP_ORIGIN; } catch (e) { return false; }
  }

  function text(v) {
    if (v === null || v === undefined) { return ''; }
    return typeof v === 'string' ? v : String(v);
  }
  function errorText(e) {
    var s = e && e.message ? String(e.message) : String(e);
    return s.length > 200 ? s.slice(0, 200) : s;
  }
  function envelope(code, data, msg) {
    return JSON.stringify({ code: code, data: text(data), msg: text(msg) });
  }
  function bridgeObject() {
    var b = globalThis.__DSHM_BRIDGES__;
    return b && typeof b === 'object' ? b : null;
  }
  function parseArgs(argsJson) {
    if (argsJson === undefined || argsJson === null || argsJson === '') { return []; }
    if (typeof argsJson !== 'string') { return null; }
    try {
      var v = JSON.parse(argsJson);
      return Array.isArray(v) ? v : null;
    } catch (e) { return null; }
  }
  function callSync(name, argsJson) {
    if (typeof name !== 'string' || name.length === 0) { return envelope(1, '', 'invalid-name'); }
    if (!originAllowed()) { return envelope(1, '', 'origin-denied'); }
    var args = parseArgs(argsJson);
    if (args === null) { return envelope(1, '', 'invalid-args'); }
    var b = bridgeObject();
    if (b === null) { return envelope(1, '', 'bridge-unavailable'); }
    if (typeof b[name] !== 'function') { return envelope(1, '', 'unknown-route:' + name); }
    try {
      var out = b[name].apply(b, args);
      return envelope(0, out, 'ok');
    } catch (e) {
      return envelope(1, '', errorText(e));
    }
  }
  function normalizeTimeout(value, name) {
    var n = Number(value);
    if (!isFinite(n) || n < 1) { n = ROUTE_TIMEOUTS[name] || DEFAULT_TIMEOUT_MS; }
    n = Math.floor(n);
    return n > MAX_TIMEOUT_MS ? MAX_TIMEOUT_MS : n;
  }
  function complete(id, ok, data, msg) {
    var entry = pending[id];
    if (!entry) { return false; }
    delete pending[id];
    clearTimeout(entry.timer);
    entry.resolve(envelope(ok ? 0 : 1, data, msg));
    return true;
  }
  function beginPending(name, timeoutMs) {
    seq += 1;
    var id = 'c' + seq + '_' + Date.now().toString(36);
    var promise = new Promise(function (resolve) {
      pending[id] = {
        name: name,
        resolve: resolve,
        timer: setTimeout(function () {
          if (!pending[id]) { return; }
          delete pending[id];
          resolve(envelope(1, '', 'timeout'));
        }, timeoutMs)
      };
    });
    return { id: id, promise: promise };
  }
  var asyncRoutes = {
    pickDirectory: function (id) {
      var picker = globalThis.__DSH_DIRECTORY_PICKER__;
      if (!picker || typeof picker.pick !== 'function') {
        complete(id, false, '', 'picker-unavailable');
        return;
      }
      var p = null;
      try { p = picker.pick(); } catch (e) { complete(id, false, '', errorText(e)); return; }
      if (!p || typeof p.then !== 'function') {
        complete(id, false, '', 'invalid-picker-result');
        return;
      }
      p.then(function (path) {
        var cancelled = path === null || path === undefined;
        complete(id, true, cancelled ? 'null' : path, cancelled ? 'cancelled' : 'ok');
      }, function (e) {
        complete(id, false, '', errorText(e));
      });
    }
  };
  function callAsync(name, argsJson, options) {
    if (typeof name !== 'string' || name.length === 0) {
      return Promise.resolve(envelope(1, '', 'invalid-name'));
    }
    if (!originAllowed()) { return Promise.resolve(envelope(1, '', 'origin-denied')); }
    var args = parseArgs(argsJson);
    if (args === null) { return Promise.resolve(envelope(1, '', 'invalid-args')); }
    if (Object.prototype.hasOwnProperty.call(asyncRoutes, name)) {
      var slot = beginPending(name, normalizeTimeout(options && options.timeoutMs, name));
      try {
        asyncRoutes[name](slot.id, args);
      } catch (e) {
        complete(slot.id, false, '', errorText(e));
      }
      return slot.promise;
    }
    return Promise.resolve(callSync(name, argsJson));
  }
  var api = {
    call: callSync,
    callAsync: callAsync,
    complete: complete,
    pendingCount: function () { return Object.keys(pending).length; },
    pendingIds: function () { return Object.keys(pending); }
  };
  globalThis.dshmBridge = api;
  globalThis.__DSHM_BRIDGE_CONTRACT__ = api;
})();`;

const PICKER_SHIM_JS: string = `(function () {
  var pending = {};
  globalThis.__DSH_DIR_PICKER_RESOLVE__ = function (id, result) {
    var entry = pending[id];
    if (!entry) { return; }
    delete pending[id];
    clearTimeout(entry.timer);
    if (result && result.error) {
      entry.reject(new Error(result.error));
    } else {
      entry.resolve(typeof result.path === 'string' ? result.path : null);
    }
  };
  globalThis.__DSH_DIRECTORY_PICKER__ = {
    pick: function () {
      return new Promise(function (resolve, reject) {
        // 【2026-09-25 修复】桥已合并到 __DSHM_BRIDGES__（同组件只能注册一个
        // javaScriptProxy，见其调用处注释）。这里从聚合对象取 startPick。
        var bridges = globalThis.__DSHM_BRIDGES__;
        var native = bridges && typeof bridges.startPick === 'function' ? bridges : null;
        if (!native) {
          resolve(null);
          return;
        }
        var id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        var entry = { resolve: resolve, reject: reject, timer: 0 };
        entry.timer = setTimeout(function () {
          delete pending[id];
          resolve(null);
        }, 120000);
        pending[id] = entry;
        var started = '';
        try {
          started = native.startPick(id);
        } catch (e) {
          delete pending[id];
          clearTimeout(entry.timer);
          reject(e);
          return;
        }
        if (started !== 'ok') {
          delete pending[id];
          clearTimeout(entry.timer);
          resolve(null);
        }
      });
    }
  };
})();`;

/**
 * 外观跟随桥（报告 5 §2.2）：把官方"设置→外观"的实际生效明暗**即时**告诉 ArkTS。
 *
 * 【官方锚点（报告 §2.2 已给出，这里照用）】`dsh-client-ui-theme` 把偏好
 * `preference ∈ {light, dark, system}` 持久化在 host 用户设置，并在首屏注入：
 *   · light  → `:root{color-scheme:light}` + body 背景 #fff
 *   · dark   → `:root{color-scheme:dark}`  + body 背景 #151517
 *   · system → `@media (prefers-color-scheme: dark)` 落到上面两者之一
 * 因此 **`getComputedStyle(documentElement).colorScheme` 就是"当前实际生效"的答案**
 * ——比 body 背景色更权威（皮肤可能改 body 底色，但 color-scheme 是浏览器级语义）。
 *
 * 【两条触发路径，缺一不可】
 *   ① `matchMedia('(prefers-color-scheme: dark)')` 的 change：system 偏好下用户在
 *      **系统设置**里切深浅时触发；
 *   ② `MutationObserver(documentElement)` 的 attributes：应用内「设置→外观」切换时，
 *      ui-theme 改的是 `:root` 的样式/属性（不一定伴随系统级 media 变化）。
 * 【为什么还要一个初始上报】页面首次渲染完成时 color-scheme 可能还没写（boot 脚本
 * 稍后注入）⇒ 用 MutationObserver + 一次 setTimeout 兜首次。
 *
 * 【回传口径】只回一个字符串：'light' | 'dark'（解析自 color-scheme；取不到时用
 * matchMedia 兜底，再取不到就不回传——调用方保持现状）。**不回原始偏好**
 * （light/dark/system）——那需要读 host 设置；状态栏只关心"现在该是深还是浅"。
 */
const THEME_SHIM_JS: string = `(function () {
  if (globalThis.__DSHM_THEME_SHIM__) { return; }
  globalThis.__DSHM_THEME_SHIM__ = true;
  function resolve() {
    var scheme = '';
    try {
      scheme = (getComputedStyle(document.documentElement).colorScheme || '').toLowerCase();
    } catch (e) { scheme = ''; }
    if (scheme.indexOf('dark') >= 0) { return 'dark'; }
    if (scheme.indexOf('light') >= 0) { return 'light'; }
    // color-scheme 还没写（boot 早期）或写了 unprefixed：用浏览器判定兜底
    try {
      if (matchMedia('(prefers-color-scheme: dark)').matches) { return 'dark'; }
    } catch (e) { /* 无 matchMedia：交给调用方保持现状 */ }
    return '';
  }
  var last = '';
  function report() {
    var mode = resolve();
    /*
     * 【两道判据，各自解决一件事】
     *   ① mode === ''：boot 早期 color-scheme 还没写、matchMedia 也判不出 ⇒ **不上报**，
     *      由调用方保持现状（绝不用"猜的"值去改状态栏）。
     *   ② mode === last：**幂等去重**。这是主闸门——两条初始 setTimeout（60ms/1200ms）
     *      与 MutationObserver 可能对同一状态各触发一次，重复回调只会白刷 ArkTS 侧日志。
     * 只按 last 判即可：首个定时器若因 color-scheme 未写入而返回 ''（被①拦下），
     * last 仍是 ''，第二个定时器自然会补报——不需要额外的 force 参数。
     */
    if (mode === '') { return; }
    if (mode === last) { return; }
    last = mode;
    try {
      // 【2026-09-25 修复】桥已合并到 __DSHM_BRIDGES__（同组件只能注册一个
      // javaScriptProxy；原来这里读的 __DSHM_THEME_NATIVE__ 在双桥并存时被覆盖，
      // 实测交换顺序后它恰好变成 undefined）。改为从聚合对象取 onThemeMode。
      var bridges = globalThis.__DSHM_BRIDGES__;
      if (bridges && typeof bridges.onThemeMode === 'function') { bridges.onThemeMode(mode); }
    } catch (e) { /* 桥未就位：忽略，下一轮再报 */ }
  }
  try {
    var mq = matchMedia('(prefers-color-scheme: dark)');
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', function () { report(); });
    } else if (typeof mq.addListener === 'function') {
      mq.addListener(function () { report(); });
    }
  } catch (e) { /* 无 matchMedia：只靠 MutationObserver */ }
  try {
    new MutationObserver(function () { report(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-ds-dark-theme'] });
  } catch (e) { /* 无 MutationObserver：至少还有首次上报 */ }
  // 首次上报（boot 脚本写入 color-scheme 的时机不定，故补两次）
  setTimeout(function () { report(); }, 60);
  setTimeout(function () { report(); }, 1200);
  document.addEventListener('DOMContentLoaded', function () { report(); });
})();`;

/**
 * 外链外开垫片（2026-09-28，修 m00001「设置→登录点不动」）。
 *
 * 【问题】鸿蒙端「设置 → 登录」点下去什么都没发生：不弹浏览器、不弹框、无报错。
 * 根因不在 ArkTS 侧 —— 全 core 树 grep `setWindowOpenHandler|shell.openExternal`
 * 零命中，`dshDesktop` 契约（shortcuts/keyboard/updates/browser）里也没有任何外开
 * API，官方桌面壳的外开是**主进程代码**，本壳必须自己接。而 ArkWeb 默认
 * `multiWindowAccess=false`，`window.open` / `target="_blank"` 一律被丢弃。
 *
 * 【为什么不能只拦 target="_blank"】登录态下确实有唯一一处授权页锚点
 * （`dsh-client-ui-settings-account/lib/client.js:2435-2451` 的 AccountSection
 * `<a target="_blank">`），但 AccountSection 只在 `settings.section` 注册
 * （`:4397-4419`，条件 `snapshot.view?.status === "credential-stored"`）——**未登录
 * 时它根本不存在**。登录路径上能点的只有 SignInDialog（`:989-1107`），而那个弹窗
 * 里**没有任何 href、也没有 window.open**，只有「复制链接」。所以还必须主动把
 * authorizeUrl 送到系统浏览器，故本垫片有两条独立路径：
 *
 * 【路径 1：account/watch 流（自动外开，无确认）】authorizeUrl 只出现在 watch 流里
 * ——host `dsh-deepseek-account-platform/lib/index.js:933-940` 的 `update()` 每次都会
 * 剥掉 authorizeUrl，只有 `:1012 update(attempt,{phase:"waiting-browser",
 * authorizeUrl,…})` 那一次带上，经 `changed()`（`:890-912`）推给订阅者。
 * 该流是 `new WebSocket(...)`（`dsh-api-gateway/lib/client.js:507`，帧格式
 * `{type:'item',streamId,value}`，`value` 即整份 AccountView）⇒ 包一层构造器读
 * message 帧即可。与官方桌面壳「主进程订阅 account 流后开系统浏览器」同构。
 *
 * 【路径 2：用户点击的外链（二次确认）】`a[target="_blank"]`（用量/充值等）与
 * `window.open`（`dsh-client-ui-settings-account/lib/client.js:4265` 的
 * 「联系我们」）。这些不是壳职责，按规范先弹确认再开。
 *
 * 【判据】`/dsh/authorize`、`/oauth/authorize` 视为授权页 → 自动外开；其余 http(s)
 * 一律确认。登录用 204 收尾（host `:834-840`，仅 `login_source=web` 才回关页 HTML）
 * ⇒ 授权页**绝不能**在本 WebView 内打开，否则应用页面被 204 空页替换。
 *
 * 【也 tap 一元 account/* 响应】`dsh-client-connection/lib/client.js:1210` 的
 * `send = doFetch ?? globalThis.fetch`，account 端点走 `globalThis.fetch`；响应体是
 * `{type:"server-response",rpcId,result}`，`result` 同样是 AccountView。作为路径 1
 * 的兜底（若 startSignIn 的一元响应已带 authorizeUrl，就不用等 watch 帧）。
 * 必须 `response.clone()`：原 body 要原样交回调用方。
 *
 * 【同步桥契约】本垫片调 `__DSHM_BRIDGES__.openExternal(url, mode)`，
 * mode='auto' 直接开、mode='confirm' 交 ArkTS 弹确认框。桥是同步的（javaScriptProxy
 * 只支持同步），所以垫片拿不到「浏览器有没有真的起来」——那由 ArkTS 侧兜底
 * （失败弹提示，见 WebApp.launchExternal）。但**投递本身**返回布尔值：桥还没就位
 * 时投不出去，调用方据此决定「排队重试」还是「放行本次点击」。
 */
const OPEN_LINK_SHIM_JS: string = `(function () {
  if (globalThis.__DSHM_OPEN_LINK_SHIM__) { return; }
  globalThis.__DSHM_OPEN_LINK_SHIM__ = true;

  /* 诊断：把"何时看到 waiting-browser / 何时把外开交出去 / 何时发 RPC"写进
     files/diag-web-console（ArkTS 的 .onConsole 落盘自带 ISO 时间戳）。
     这样"点击 → 拿到授权 URL → 打开浏览器"每一跳都能与宿主侧 IN-REQ/IN-DONE 对齐，
     不必再靠没有时间戳的 ArkWeb 行序去猜。 */
  function log(msg) {
    try { console.info('[dshm-link] ' + msg); } catch (e) { /* 无 console：忽略 */ }
  }
  log('shim installed');

  /* 已自动外开过的 URL：watch 流会重复推送同一 attempt，只开一次 */
  var opened = {};
  /* 诊断用：已记录的"非账号"item 帧数量（只记前 20 条，避免刷屏） */
  var itemFrames = 0;
  /* 诊断用：已记录的"非账号"fetch 条数（只记前 300 条，覆盖启动爆发 + 开设置 + 点登录） */
  var fetchLogged = 0;

  function bridges() {
    var b = globalThis.__DSHM_BRIDGES__;
    return b && typeof b.openExternal === 'function' ? b : null;
  }

  function isHttpUrl(url) {
    return typeof url === 'string' &&
      (url.slice(0, 8) === 'https://' || url.slice(0, 7) === 'http://');
  }

  function isAuthorizeUrl(url) {
    return url.indexOf('/dsh/authorize') >= 0 || url.indexOf('/oauth/authorize') >= 0;
  }

  /* 应用自身页面（Host 走本机回环）⇒ 不是外链，必须放行给 WebView。
     没有这条，下面的"接管所有 http(s) 锚点"会把应用自己的导航也拦成外开。 */
  function isSameOriginAsApp(url) {
    try {
      var here = globalThis.location && globalThis.location.origin
        ? String(globalThis.location.origin) : '';
      if (here.length === 0) { return false; }
      return url === here || url.indexOf(here + '/') === 0;
    } catch (e) { return false; }
  }

  /* 桥没就位时**不能丢掉这次外开**：桥的注册与文档开始垫片的先后关系在真机上
     有过反复（见 .javaScriptProxy 处注释），而授权页只在 waiting-browser 那一刻
     推一次，错过就得让用户手动复制链接。故对自动外开加一道 15s 有界重试。 */
  var pendingAuto = [];
  var pumpTimer = 0;
  var pumpUntil = 0;

  /* 同步投递一次外开请求。返回 false = 桥还没就位（调用方决定要不要排队重试）。 */
  function out(url, auto) {
    if (!isHttpUrl(url)) { return false; }
    var u = url.trim();
    var b = bridges();
    if (!b) { return false; }
    if (!auto) {
      try { b.openExternal(u, 'confirm'); log('deliver confirm ' + u); } catch (e) { /* 桥异常：忽略 */ }
      return true;
    }
    if (opened[u]) { return true; }
    /* 只有投递成功才记账：桥抛异常说明这次没送出去，必须留给重试 */
    try { b.openExternal(u, 'auto'); } catch (e) { return false; }
    opened[u] = true;
    log('deliver auto ' + u);
    return true;
  }

  function armPump() {
    if (pumpTimer !== 0 || Date.now() > pumpUntil) { return; }
    pumpTimer = setTimeout(function () {
      pumpTimer = 0;
      var rest = [];
      for (var i = 0; i < pendingAuto.length; i++) {
        if (!out(pendingAuto[i], true)) { rest.push(pendingAuto[i]); }
      }
      pendingAuto = rest;
      if (pendingAuto.length > 0) { armPump(); }
    }, 250);
  }

  function autoOpen(url) {
    if (!isHttpUrl(url)) { return; }
    var u = url.trim();
    if (out(u, true)) { return; }
    /* watch 流会重复推送同一份 AccountView，去重，别把队列撑成一串重复项 */
    if (pendingAuto.indexOf(u) >= 0) { return; }
    log('bridge not ready, queued ' + u);
    /* 重试窗口从第一次投递失败起算；窗口内每次失败都续上，超时才放手 */
    if (Date.now() > pumpUntil) { pumpUntil = Date.now() + 15000; }
    pendingAuto.push(u);
    armPump();
  }

  function scanAccount(view) {
    try {
      if (!view || typeof view !== 'object') { return; }
      /* 【2026-11-19 与 entry 对齐：rc.3 起的账号封套】
         0.2.2-rc.3 起账号流帧 / 一元 RPC 结果不再是裸 AccountView，而是
         {type:'credentials-changed'|…, state:AccountView} 这类封套。不剥封套 ⇒ 永远扫不到
         attempt.phase === 'waiting-browser' ⇒ **手机端点登录不跳浏览器**
         （平板 / PC 已修，手机壳漏了同一处）。 */
      if (view.attempt === undefined && view.status === undefined
        && typeof view.state === 'object' && view.state !== null) {
        view = view.state;
      }
      var attempt = view.attempt;
      if (!attempt || typeof attempt !== 'object') { return; }
      if (attempt.phase !== 'waiting-browser') { return; }
      log('waiting-browser authorizeUrl=' + (typeof attempt.authorizeUrl === 'string' ? 'yes' : 'no'));
      if (typeof attempt.authorizeUrl === 'string') { autoOpen(attempt.authorizeUrl); }
    } catch (e) { /* 形状不符：忽略 */ }
  }

  /* ---- 路径 1：account/watch（WebSocket message 帧）---- */
  try {
    var NativeWS = globalThis.WebSocket;
    if (typeof NativeWS === 'function') {
      var WrappedWS = function (url, protocols) {
        var socket = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
        try {
          socket.addEventListener('message', function (event) {
            try {
              if (typeof event.data !== 'string') { return; }
              var frame = JSON.parse(event.data);
              if (frame && frame.type === 'item') {
                /* 诊断：先如实记下帧形状（判据一行没改）。既能确认自动外开走的是哪条
                   路径，也能在"扫不到账号状态"时看出 item 的 value 到底长什么样。 */
                var v = frame.value;
                /* rc.3 封套先剥（同 scanAccount 头注）：不剥的话账号帧会一直掉进
                   下面的 keys= 计数分支，永远看不到 attempt=/url= 诊断行。 */
                if (v && typeof v === 'object' && v.attempt === undefined && v.status === undefined
                  && typeof v.state === 'object' && v.state !== null) {
                  v = v.state;
                }
                if (v && typeof v === 'object' && (v.attempt !== undefined || v.status !== undefined)) {
                  log('ws item attempt=' + (v.attempt && v.attempt.phase ? v.attempt.phase : '-') +
                    ' url=' + (v.attempt && typeof v.attempt.authorizeUrl === 'string' ? 'yes' : 'no'));
                } else if (itemFrames < 20) {
                  itemFrames++;
                  log('ws item #' + itemFrames + ' keys=' + (v && typeof v === 'object' ? Object.keys(v).join(',') : typeof v));
                }
                scanAccount(v);
              }
            } catch (e) { /* 非 JSON 帧：忽略 */ }
          });
        } catch (e) { /* 不支持 addEventListener：退化为不监听这条流 */ }
        /* 诊断：账号状态走的是 mux WebSocket（/api/remote.mux）。如果浏览器迟迟不开，
           先要排除"mux 直到 boot+70s 才 open"这条解释 —— 那和账号插件本身无关。
           也顺带记下重连/断开时刻，用来核对心跳回收窗口。 */
        try {
          socket.addEventListener('open', function () { log('ws open ' + String(url).slice(0, 90)); });
          socket.addEventListener('close', function (ev) { log('ws close code=' + (ev && ev.code) + ' ' + String(url).slice(0, 90)); });
          socket.addEventListener('error', function () { log('ws error ' + String(url).slice(0, 90)); });
        } catch (e) { /* 不支持 addEventListener：忽略 */ }
        return socket;
      };
      WrappedWS.prototype = NativeWS.prototype;
      try {
        var names = Object.getOwnPropertyNames(NativeWS);
        for (var i = 0; i < names.length; i++) {
          var key = names[i];
          if (key === 'prototype' || key === 'length' || key === 'name' ||
              key === 'caller' || key === 'arguments') { continue; }
          WrappedWS[key] = NativeWS[key];
        }
      } catch (e) { /* 静态量拷贝失败：下面用规范常量兜底 */ }
      /* CONNECTING/OPEN/CLOSING/CLOSED 是 WebSocket 规范固定值，不依赖宿主实现，
         显式补上即可。gateway 用裸 WebSocket.OPEN 比较 readyState（client.js:555），
         缺了它整条连接都建不起来。 */
      if (typeof WrappedWS.CONNECTING !== 'number') { WrappedWS.CONNECTING = 0; }
      if (typeof WrappedWS.OPEN !== 'number') { WrappedWS.OPEN = 1; }
      if (typeof WrappedWS.CLOSING !== 'number') { WrappedWS.CLOSING = 2; }
      if (typeof WrappedWS.CLOSED !== 'number') { WrappedWS.CLOSED = 3; }
      globalThis.WebSocket = WrappedWS;
      /* 连常量都补不上（构造器被冻结之类）就宁可退回原构造器：宁可丢自动外开，
         也不能把整条 account/events 流弄坏 */
      if (typeof WrappedWS.OPEN !== 'number') { globalThis.WebSocket = NativeWS; }
    }
  } catch (e) { /* WebSocket 不可写：只剩下面两条路径 */ }

  /* ---- 路径 1b：一元 account/* 响应（fetch 兜底）---- */
  try {
    var nativeFetch = globalThis.fetch;
    if (typeof nativeFetch === 'function') {
      globalThis.fetch = function (input, init) {
        var url = '';
        try {
          url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
        } catch (e) { /* 取不到 URL：按非 account 处理 */ }
        var pending = nativeFetch.call(globalThis, input, init);
        var isAccount = url.indexOf('account/') >= 0;
        /* 诊断：账号链路之外的请求也记前 300 条"发起 → 完成"耗时。
           用途：把"启动后慢"拆成两半 —— 页面 JS 迟迟发不出 fetch（被挡住），
           还是发出去了宿主/网络回得慢。一次冷启动的爆发约 30 条，300 条足够覆盖
           「启动 + 打开设置 + 点登录」三段，又不会把 diag-web-console 刷爆。 */
        var watched = isAccount || fetchLogged < 300;
        if (watched && !isAccount) { fetchLogged++; }
        if (!watched) { return pending; }
        var rpcStartedAt = Date.now();
        log((isAccount ? 'rpc start ' : 'fetch start ') + url.slice(0, 120));
        return pending.then(function (response) {
          log((isAccount ? 'rpc done status=' : 'fetch done status=') +
            (response && response.status) + ' ms=' + (Date.now() - rpcStartedAt) +
            (isAccount ? '' : ' ' + url.slice(0, 80)));
          try {
            if (isAccount && response && typeof response.clone === 'function') {
              response.clone().json().then(function (body) {
                scanAccount(body && body.result ? body.result : body);
              }, function () { /* 非 JSON 响应：忽略 */ });
            }
          } catch (e) { /* clone 失败：忽略，原响应照常返回 */ }
          return response;
        }, function (err) {
          log((isAccount ? 'rpc fail' : 'fetch fail') + ' ms=' + (Date.now() - rpcStartedAt) +
            ' ' + url.slice(0, 80));
          throw err;
        });
      };
    }
  } catch (e) { /* fetch 不可写：只剩路径 2 */ }

  /* ---- 路径 2：用户点击的外链 ---- */
  try {
    document.addEventListener('click', function (ev) {
      try {
        var node = ev.target;
        var anchor = null;
        while (node && node !== document) {
          if (node.tagName && String(node.tagName).toLowerCase() === 'a') { anchor = node; break; }
          node = node.parentNode;
        }
        if (!anchor) { return; }
        var href = anchor.href;
        if (!isHttpUrl(href)) { return; }
        /*
         * 【2026-11-19 与 entry 对齐（docs/275 同款缺陷）】原有判据只认 target 为 _blank
         * 的锚点 ⇒ 官方正文里的 Markdown 链接（渲染出来不带 target）与设置面板里的普通
         * 锚点都掉回 WebView 默认行为：既不跳浏览器，还可能把外部页（授权页按 204 空页）
         * 加载进应用自己的 WebView，把界面替掉。
         * 现在**所有 http(s) 锚点**都交出去；同源（应用自身）放行给 WebView。
         */
        if (isSameOriginAsApp(href)) { return; }
        /* 只有真正投出去了才 preventDefault：桥未就位时放行，交由 WebView 默认行为
           （仍是丢弃，与改动前一致），绝不制造新的「点了没反应」。
           不 stopPropagation —— 页面前端自己挂在 <a> 上的回调照旧该跑，我们在捕获
           阶段只做「顺带把 URL 交给系统」，不该改变页面的行为。 */
        if (out(href, isAuthorizeUrl(href))) {
          ev.preventDefault();
        }
      } catch (e) { /* 拦截失败：交给 WebView 默认行为（仍是丢弃，不劣化） */ }
    }, true);
  } catch (e) { /* 无 document：忽略 */ }

  /* window.open（官方的「联系我们」；授权页若用这条也一并接住） */
  try {
    var nativeOpen = globalThis.open;
    if (typeof nativeOpen === 'function') {
      globalThis.open = function (url) {
        if (isHttpUrl(url)) {
          out(url, isAuthorizeUrl(url));
          return null;
        }
        return nativeOpen.apply(globalThis, arguments);
      };
    }
  } catch (e) { /* open 不可写：忽略 */ }
})();`;

/**
 * 顶栏左上角那颗按钮 = 官方客户端的「侧栏收起 / 呼出」（2026-10-09 对齐官方）。
 *
 * 【为什么需要这个垫片】官方客户端的左上角不是装饰：那一刻的按钮就是侧栏开关
 * （`dsh-client-ui-sidebar` 的 `SidebarRoot` → `ctx.layout.toggleSidebar()`）。
 * 我们的自绘顶栏起初把那颗图形只当**图标**用（点不动；2026-10-10 起图形本身也换成
 * 官方的面板图标，原生顶栏已被移除，本垫片只服务页面内左/右入口：
 * 原生顶栏一按，就去点**网页里官方那颗按钮**，此后折叠/展开交给官方
 * `dsh-client-ui-layout`，壳侧不发明第二套折叠逻辑。
 *
 * 它同时做三件"端侧专属"的事（2026-10-09 用户裁决）：
 *   §A 收起态 ⇒ 左侧**整列消失**（原话："收起的时候左边侧边栏应该是完全收起，
 *      那一竖排的预览按钮都没有的"）。官方默认只收到 56px 图标轨（那是桌面口径：
 *      轨道上还留着新会话 / 插件 / 历史 / 搜索等入口），与"完全收起"不符。
 *   §B 手持档 + 窄屏（<1024px）展开态 ⇒ 侧栏改成**覆盖式抽屉**。官方窄屏是
 *      "挤窄中间列"，在手机上中间列只剩 ~80px、标题竖成一条（真机截图实证）——
 *      这不是移动端该有的形态。
 *   §D compact 手机/折叠单屏左栏收起 ⇒ 页面内补一颗浮动备份开关（handheldFab）。原生
 *      顶栏在手持档整条不渲染（"移动端 APP 是没有顶栏的"），而官方那颗按钮长在侧栏
 *      列里 —— 列被 §A 压成 0 宽后它自己也点不到了。没有 §D，手持档就**再也叫不出
 *      侧栏**（宁可多一颗看得见的按钮，也不能让功能消失）。
 * 两件事都只靠**我们自己挂的类名 / 属性**（`dshm-frame` / `dshm-sbcol` /
 * `data-dshm-sidebar`）落地，不认官方任何哈希类名，见 §C。
 *
 * 【为什么是"点 DOM"而不是调官方 API】官方没有把 `toggleSidebar` 暴露出来：
 * `ctx.layout` 只在插件进程内可见，Web 侧也没有挂 `globalThis` 的入口。
 * 那颗按钮则是**稳定的可寻址目标**：`aria-label` 取官方文案
 * （`toggle.collapse` = 「收起侧边栏」/ `toggle.open` = 「打开侧边栏」；
 * en 为 "Collapse sidebar" / "Open sidebar"，见 sidebar 包的 locales），
 * 而它**同时就是状态** —— 展开态显示「收起侧边栏」、收起态显示「打开侧边栏」
 * ⇒ 一个属性同时回答"点哪里"和"现在是什么态"。
 *
 * 【为什么不认官方类名 / 属性名】官方类名是 CSS Modules 哈希（`hHd-Xa_toggle`），
 * 且 `dsh-web-frontend` 的压缩产物连属性名都被改写：同一个 darwin 判定在未压缩
 * 产物里写作 `documentElement.dataset.platform`（属性 `data-platform`），在压缩
 * 产物里写作 `documentElement.ln === 'darwin'` ⇒ **属性名会变**。故本垫片只依赖
 * `aria-label` 这个无障碍契约面（`_toggle` 类名后缀仅作兜底，不是主判据）；
 * 与结构相关的定位只用 `data-shell-overlay`（JSX 字符串字面量，压缩不改名）。
 *
 * 【失效即回退】`state()` 在找不到按钮时返回 `'unknown'`，此时**不写**状态属性
 * ⇒ §A/§B 的 CSS 一条都不生效，页面回到官方原样（图标轨还在）——宁可"没适配"，
 * 也绝不制造"侧栏彻底叫不出来"。
 *
 * 【有界重试】点击是**一次性**用户动作，页面还没挂载时不能丢：找不到按钮就每
 * 150ms 重试一次、最多 6s（覆盖首启解包后的首屏），超时才记一行诊断。
 *
 * 【自检落盘】点击后 260ms 回读状态（React 重渲染是异步的），把 "before → after"
 * 写成一行 `[dshm-sidebar] …`。这条经 `.onConsole` 落进 `files/diag-web-console`，
 * 真机上"到底点没点到、翻没翻过去"以此为准，不靠肉眼。
 */
/**
 * 侧栏状态属性名（`collapsed` / `expanded`，由 SIDEBAR_SHIM_JS 巡检时写在 `<html>` 上）。
 *
 * 【为什么连这个也要提出来共用】官方 opener 的**常显**、图标交换的固化、以及面板 / 右栏
 * 打开时的临时隐去，都必须判同一个状态事实（本属性）—— 各判一套必然漂移。
 */
const SIDEBAR_STATE_ATTR: string = 'data-dshm-sidebar';
/**
 * 启动自愈：平板 / PC / 2in1 + 官方侧栏仍是收起态 ⇒ 自动点开一次（2026-10-19，
 * 2026-10-24 扩到竖屏平板与云调试选中 2in1 HAP 的机器）。
 *
 * 【要解决什么】MatePad Pro（MRO-W00 / API 24）首次启动：侧栏缺失、界面居中，
 * **点右上角按钮后恢复**（内测 2026-10-18 日志包）。hilog 显示 Web 创建早于窗口几何
 * 落定（`resize for emulator early failed`），上游按窄视口算了一次布局，之后不再重算。
 * 我们不等用户点：页面就绪后若"宽视口 + 收起态"同时成立，就程序化点一次官方 toggle。
 *
 * 【为什么是一次性 + 有时间窗】不能跟用户抢：官方侧栏第一次真正挂载后 **15 秒**内
 * 只试一次。平板（含竖屏）与 PC/2in1 默认展开；手机与折叠屏单屏在窄视口下不抢开。
 * 时间窗**不能从 shim 安装时起算**：2026-10-24 的两份云调试日志里，官方侧栏常晚于
 * NWeb 创建才挂载，若页面尚未挂载就把 autoTried 锁死，后续侧栏仍会缺失。两个阈值以
 * 字面量写在垫片函数里（模板串插值会让桩环境与插值登记门禁判红）。
 */
const SIDEBAR_SHIM_JS: string = `(function () {
  if (globalThis.__DSHM_SIDEBAR__) { return; }
  /* 官方按钮的两个文案（zh 为准，en 兜底）。只用于"是不是它"与"现在什么态"。 */
  var COLLAPSE_LABELS = ['收起侧边栏', 'Collapse sidebar'];
  var OPEN_LABELS = ['打开侧边栏', 'Open sidebar'];
  /* 我们自己挂的钩子：CSS 只认这些名字，不认官方哈希类名（见头注 §C）。 */
  var FRAME_CLASS = 'dshm-frame';
  var COL_CLASS = 'dshm-sbcol';
  var NODRAG_CLASS = 'dshm-nodrag';
  var HANDHELD_CLASS = 'dshm-handheld';
  var DESKTOP_CLASS = 'dshm-desktop';
  /* 平板自由窗口 / Edge 桌面模式：保留官方侧栏按钮，收起态强制它常显。 */
  var PC_CLASS = 'dshm-pc';
  /* 设置横置：直板手机或折叠屏折叠态。 */
  var COMPACT_CLASS = 'dshm-compact';
  /* 首次登录引导：仅直板手机。 */
  var PHONE_CLASS = 'dshm-phone';
  /*
   * 平板标记（2026-11-06 起平板改走手机壳，见 docs/381）。
   *
   * 平板在手机壳里的诉求与手机**不同**：左侧栏要像 PC 那样**常驻**，不做抽屉、
   * 不自动隐藏。判据来自原生桥 platformForm === 'tablet'（与 dshm-phone 互斥）。
   */
  var TABLET_CLASS = 'dshm-tablet';
  /* 折叠屏形态标记：桥不可用时由窄视口兜底判断单屏。 */
  var FOLDABLE_CLASS = 'dshm-form-foldable';
  var STATE_ATTR = '${SIDEBAR_STATE_ATTR}';
  var STYLE_ID = 'dshm-sidebar-style';
  var BACKDROP_ID = 'dshm-sidebar-backdrop';
  /* 轨内官方 opener 可用标记（1 = 图标轨里那颗真的可见）。见 syncOpener()。 */
  var RAIL_OPENER_ATTR = 'data-dshm-rail-opener';
  /*
   * 面板/浮层打开状态（写进 html 元素的 data 属性，供诊断与 CSS 消费）。
   *
   * 【谁在用】面板打开时临时隐去官方 opener（那条 CSS 认本属性），避免它与面板标题重叠；
   * 判据与 BACK_SHIM 的 OVERLAY_SEL 同一组（口径统一：什么算"浮层"只有一处说法）。
   */
  var PANEL_ATTR = 'data-dshm-panel';
  /* 【2026-10-18 右侧栏】手机/折叠单屏打开右栏时为覆盖式抽屉，必须隐藏左侧入口。
     判据只用官方属性 data-sidebar-right-open（展开才有）+ 非 aria-hidden。 */
  var RIGHT_ATTR = 'data-dshm-right';
  var PANEL_SEL = '[data-shortcut-modal],[role="dialog"],[role="menu"],[role="listbox"],section[data-desktop-onboarding]';
  /* 状态巡检周期（ms）：为什么用巡检而不是 MutationObserver，见 syncState()。 */
  var TICK_MS = 300;
  /*
   * 【失焦降频（2026-10-29，方案 A，与 entry 同步）】页面 hidden 时 300ms→1500ms：
   * 后台巡检没有读者，白耗 CPU/IO（docs/277）。保底不停摆——侧栏自愈链仍要活着。
   */
  var TICK_BG_MS = 1500;
  var pageVisible = !(document.visibilityState === 'hidden');
  var tickTimer = 0;
  function armTick() {
    if (tickTimer !== 0) { clearInterval(tickTimer); }
    tickTimer = setInterval(tick, pageVisible ? TICK_MS : TICK_BG_MS);
  }
  document.addEventListener('visibilitychange', function () {
    var nowVisible = !(document.visibilityState === 'hidden');
    if (nowVisible === pageVisible) { return; }
    pageVisible = nowVisible;
    armTick();
    if (nowVisible) { tick(); }
  });
  var lastState = '';
  var lastPanel = '';
  var lastRight = '';
  var manualTabletCollapsed = false;
  /*
   * 平板左栏的"我们的意图"（2026-11-06 用户第五次口径，docs/383）。
   *
   * 平板面积够 ⇒ **默认一直展开**，且不跟随官方 narrow 判定：官方在小于 1024 时把
   * narrowExpanded 初始化为 false，还会在 selectPanel / setViewportWidth / setRightbar
   * 三处强行打回 false —— 跟着它走就永远是"会自动收起"。
   * 所以平板档只认这个变量：初值 true，**只有用户点左上角那颗按钮才会翻转**。
   */
  var tabletWantsExpanded = true;
  var programmaticToggleClick = false;
  var lastTabletKeepOpenAt = 0;
  /*
   * 启动静默期（docs/333）：本垫片开始执行后 8 秒内**不碰官方 toggle**。
   * 真机 ERR_WS_UPGRADE(-173)：点按钮会打断首帧的 WebSocket 握手 ⇒ 连接失败。
   */
  /*
   * 【为什么是 20 秒】真机时序（entry 16:48 日志）：
   *   16:47:42 InitializeCef → 16:47:52 首帧 SwapBuffers → 16:47:58 首次 WS 握手，
   *   而握手失败后官方退避重试还要若干秒。8 秒的静默期会在握手**之前**就结束，
   *   等于没保护。20 秒覆盖"首帧 + 首次连接 + 首次退避重试"的完整窗口。
   * 【提前结束】一旦观察到官方连接成功（data-phase=connected），静默期立刻结束
   * （见 connectionSettledOnce）—— 正常机型不会白等 20 秒。
   */
  var STARTUP_QUIET_MS = 20000;
  var bootQuietUntil = Date.now() + STARTUP_QUIET_MS;
  /* 手持档判据只问原生桥（跨语言调用不便宜）；问到就记 key，同一结论不重复应用。
     同一结论只应用一次（300ms 巡检每拍都会进来）。 */
  var handheldAsked = false;
  var appliedFormKey = '';
  var lastCompact = false;
  var isDesktop = false;
  /* 一次性诊断（跑过就置真，一个页面只打一行）。 */
  var diagDone = false;
  /* 巡检拍数（0.3s 一拍）：诊断要等官方自己写完 <html> 的属性再读数。 */
  var ticks = 0;
  function log(msg) {
    try { console.info('[dshm-sidebar] ' + msg); } catch (e) { /* 无 console：忽略 */ }
  }
  function has(list, v) {
    for (var i = 0; i < list.length; i++) { if (list[i] === v) { return true; } }
    return false;
  }
  function addClass(el, cls) {
    if (el === null || el === undefined) { return; }
    var cur = el.getAttribute('class');
    if (cur === null) { cur = ''; }
    if (cur.indexOf(cls) >= 0) { return; }
    el.setAttribute('class', cur === '' ? cls : cur + ' ' + cls);
  }
  function setFlag(el, cls, on) {
    if (el === null || el === undefined) { return; }
    var cur = el.getAttribute('class');
    if (cur === null) { cur = ''; }
    var parts = cur.split(/\\s+/).filter(function (c) { return c.length > 0 && c !== cls; });
    if (on) { parts.push(cls); }
    el.setAttribute('class', parts.join(' '));
  }
  /* 折叠屏展开成平板形态时，同样只尊重用户亲手收起。 */
  document.addEventListener('click', function (ev) {
    if (programmaticToggleClick) { return; }
    var node = ev.target;
    while (node !== null && node !== document) {
      if (node.tagName === 'BUTTON') {
        var label = node.getAttribute('aria-label');
        /*
         * 平板档（2026-11-06，docs/384）：官方那颗（DSHM 字标右边）是展开态唯一的收起入口。
         * 用户点它 = 明确意图 ⇒ 既要记 manualTabletCollapsed，也要同步 tabletWantsExpanded，
         * 否则 syncState 会按旧意图把状态顶回去（表现为"点了没反应"）。
         */
        var onTablet = isTabletForm();
        if (has(COLLAPSE_LABELS, label)) {
          manualTabletCollapsed = true;
          if (onTablet) { tabletWantsExpanded = false; applyState('collapsed', '(tablet user)'); }
          return;
        }
        if (has(OPEN_LABELS, label)) {
          manualTabletCollapsed = false;
          if (onTablet) { tabletWantsExpanded = true; applyState('expanded', '(tablet user)'); }
          return;
        }
      }
      node = node.parentNode;
    }
  }, true);
  /* 官方那颗按钮：先按 aria-label 文案找（契约面），再按 CSS Modules 的 _toggle 后缀兜底。 */
  function findToggle() {
    var buttons = document.querySelectorAll('button');
    /* 2026-11-06 核心 0.2.2-rc.1 兼容：官方顶栏新增常驻的 data-sidebar-opener，
       它的 aria-label 恒为「打开侧边栏」。若把它当成状态按钮，state() 会永远读到
       collapsed，且 tagLayout() 会把 dshm-sbcol 挂到顶栏列而不是侧栏列。
       1.1.7（0.2.1-rc.5）没有这颗按钮，跳过它即恢复旧行为。 */
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].hasAttribute('data-sidebar-opener')) { continue; }
      var label = buttons[i].getAttribute('aria-label');
      if (label !== null && (has(COLLAPSE_LABELS, label) || has(OPEN_LABELS, label))) { return buttons[i]; }
    }
    for (var j = 0; j < buttons.length; j++) {
      if (buttons[j].hasAttribute('data-sidebar-opener')) { continue; }
      var cls = buttons[j].getAttribute('class');
      if (cls !== null && cls.indexOf('_toggle') >= 0) { return buttons[j]; }
    }
    return null;
  }
  /*
   * 抽屉态下官方把侧栏里那颗 toggle 收进了顶栏，[data-sidebar-opener] 就是唯一开关
   * ⇒ 点它等价于切换侧栏。**只用于点击**，绝不参与状态判定（见 stateFromFrame）。
   */
  function findOpener() {
    try { return document.querySelector('button[data-sidebar-opener]'); } catch (e) { return null; }
  }
  /*
   * 【2026-11-11 收起/小窗态只留一颗按钮】
   * 官方在两处渲染"打开侧边栏"：
   *   ① 图标轨顶部那颗 rail toggle（class 带本地名后缀 _toggle）；
   *   ② frame leading 座位里的 [data-sidebar-opener]（absolute；PC left:88px、drawer left:12px）。
   * 手机小窗 / 折叠单屏 / 平板把列压成 56px 轨后两条同时可见 ⇒ 用户报的"左上角两个按钮"。
   *
   * 每拍判断轨内那颗**是否真的可用**（有盒子且没被 display / visibility / opacity 藏掉）；
   * 可用就写 data-dshm-rail-opener="1"，CSS 据此收掉 leading 那颗。读不到轨内 toggle
   * （侧栏完全隐藏）就写 0 退回原样 —— 那时 leading 那颗才是唯一入口。
   */
  function railToggle() {
    var list = document.querySelectorAll('button');
    var i = 0;
    for (i = 0; i < list.length; i++) {
      if (list[i].hasAttribute('data-sidebar-opener')) { continue; }
      var label = list[i].getAttribute('aria-label');
      if (label !== null && (has(OPEN_LABELS, label) || has(COLLAPSE_LABELS, label))) { return list[i]; }
    }
    for (i = 0; i < list.length; i++) {
      if (list[i].hasAttribute('data-sidebar-opener')) { continue; }
      var cls = list[i].getAttribute('class');
      if (cls !== null && cls.indexOf('_toggle') >= 0) { return list[i]; }
    }
    return null;
  }
  /*
   * 命中测试：getBoundingClientRect / getClientRects 都**不扣祖先的 overflow 裁剪**，
   * 收起态侧栏列被压成 0 宽、抽屉态整列被平移出屏时，轨内那颗按钮的盒子依然"看着正常"。
   * 只判宽高会把点不到的那颗当成可用、进而把唯一入口藏掉 ⇒ 用 elementFromPoint 实测。
   */
  function hitTest(el) {
    try {
      var r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) { return false; }
      var x = r.left + r.width / 2;
      var y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x >= (window.innerWidth || 0) || y >= (window.innerHeight || 0)) { return false; }
      var hit = document.elementFromPoint(x, y);
      if (hit === null) { return false; }
      return hit === el || el.contains(hit);
    } catch (e) { return false; }
  }
  function syncOpener() {
    var usable = false;
    var el = railToggle();
    if (el !== null) {
      try {
        var cs = window.getComputedStyle(el);
        usable = cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0'
          && hitTest(el);
      } catch (e) { usable = false; }
    }
    var want = usable ? '1' : '0';
    if (document.documentElement.getAttribute(RAIL_OPENER_ATTR) !== want) {
      document.documentElement.setAttribute(RAIL_OPENER_ATTR, want);
    }
  }
  /* 状态 = 按钮自己说的；unknown = 页面还没挂载（此时不下判断）。 */
  function stateOf(el) {
    if (el === null) { return 'unknown'; }
    var label = el.getAttribute('aria-label');
    if (has(OPEN_LABELS, label)) { return 'collapsed'; }
    if (has(COLLAPSE_LABELS, label)) { return 'expanded'; }
    return 'unknown';
  }
  /*
   * 【2026-11-06 核心 0.2.2-rc.1 兼容：状态一律以官方 frame 为准】
   *
   * 官方 0.2.2 在顶栏新增了**常驻**的 [data-sidebar-opener]，它的 aria-label 恒为
   * 「打开侧边栏」——不再随展开态改文案。只要它还在 DOM 里，任何"读按钮文案"的状态机
   * 都会永远读到 collapsed：ensureTabletExpanded 于是每 800ms 点一次、按钮常驻、
   * 侧栏几何整体错位（真机现象：平板侧栏灰、点不动、抖动）。
   *
   * 官方 frame 上本来就有结构化状态：data-sidebar-collapsed（收起时存在、展开时被移除）。
   * 这两个属性名是 JSX 字符串字面量，**压缩构建不改名**，比 aria-label 稳得多 ⇒
   * 以它为准，aria-label 只在 frame 还没挂载时兜底。
   */
  function stateFromFrame() {
    var frame = findFrame();
    if (frame === null) { return 'unknown'; }
    return frame.hasAttribute('data-sidebar-collapsed') ? 'collapsed' : 'expanded';
  }
  function state() {
    var st = stateFromFrame();
    return st === 'unknown' ? stateOf(findToggle()) : st;
  }
  /*
   * 0.2.2 起官方把 <768 切成"抽屉"形态（frame[data-sidebar-drawer] + 官方 drawerMask）。
   * 这一档的几何与遮罩**必须交还官方**：官方遮罩 z-index:70、侧栏列 z-index:71，
   * 而我们旧覆盖式几何只给到 40 ⇒ 整条侧栏被官方遮罩盖住（看着"灰"）
   * 且 pointer-events 被遮罩吃掉（点不到），0.2.1 没有这层遮罩所以当年是对的。
   */
  function isDrawer() {
    try { return document.querySelector('[data-sidebar-drawer]') !== null; } catch (e) { return false; }
  }
  /* 交叉读数：只进诊断行、不参与判定。 */
  function frameFlag() {
    try {
      return document.querySelector('[data-sidebar-collapsed]') !== null ? 'collapsed' : 'expanded';
    } catch (e) { return 'unknown'; }
  }
  /* frame = 三列布局的根。用官方的 data-shell-overlay（覆盖层的父）定位：它是 JSX 里的
     字符串字面量，压缩构建不改名，与"官方类名"无关。 */
  function findFrame() {
    var overlay = document.querySelector('[data-shell-overlay]');
    if (overlay !== null && overlay.parentElement !== null) { return overlay.parentElement; }
    return document.querySelector('[data-sidebar-collapsed]');
  }
  /* §C 给 frame 与侧栏列挂上我们自己的类名（CSS 只认它们）。 */
  function tagLayout() {
    var frame = findFrame();
    if (frame === null) { return; }
    addClass(frame, FRAME_CLASS);
    /* 【2026-11-07】平板档 / 折叠屏展开：官方若标成抽屉，absolute + 遮罩 + 点外收起
       会整套生效（真机：点会话区空白处左栏就收）。每拍摘掉，退回三栏网格。
       【2026-11-18 竖屏修正】只有 ≥1024（官方非 narrow）才摘；<1024 反过来**补上**
       drawer 属性，让官方按抽屉浮层渲染 —— 写死 280 会把主列挤进左栏。 */
    if (isTabletForm()) {
      try {
        if (Math.round(window.innerWidth || 0) >= 1024) {
          if (frame.hasAttribute('data-sidebar-drawer')) { frame.removeAttribute('data-sidebar-drawer'); }
        } else if (!frame.hasAttribute('data-sidebar-drawer')) {
          frame.setAttribute('data-sidebar-drawer', 'true');
        }
      } catch (e) { /* 忽略 */ }
    }
    var toggle = findToggle();
    if (toggle !== null) {
      /* 2026-11-11：与 entry 壳同步 —— 官方侧栏按钮是唯一入口，
         这里只清历史内联藏值，绝不再主动 display:none。 */
      if (toggle.style.display === 'none') {
        try { toggle.style.display = ''; } catch (e) { /* 忽略 */ }
      }
      var node = toggle;
      while (node !== null && node.parentElement !== frame) { node = node.parentElement; }
      addClass(node, COL_CLASS);
    }
    /* 拖拽分隔条：收起（整列消失）/ 抽屉（宽度固定）两种形态下拖它只会让人困惑
       ⇒ 按语义（computed cursor = col-resize）找出来，在 CSS 里藏掉。 */
    var kids = frame.children;
    for (var i = 0; i < kids.length; i++) {
      try {
        if (window.getComputedStyle(kids[i]).cursor === 'col-resize') { addClass(kids[i], NODRAG_CLASS); }
      } catch (e) { /* 计算样式不可用：跳过这一拍 */ }
    }
  }
  /*
   * 2026-11-06 第二轮（用户真机复报后订正）：官方 AppFrame 在 drawer 态给
   * sidebarCol / CenterColumn / RightbarColumn / bottomRow / leadingSeat **全部**加 HTML inert。
   * inert 会让整棵子树变灰且完全不可交互 ⇒ 设置面板、DeepSeek 账号登录、插件入口、
   * 终端（都挂在主区或浮层里）一起点不到。上一轮只清侧栏列的判断是错的：
   * 保留官方「背景不可点」语义的代价是整台手机都没法用，而 1.1.7 的核心根本没有 inert。
   * 故手机档必须**整体清掉页面内所有 inert**，恢复 1.1.7 的可交互行为。
   *
   * 官方每次 React 重渲染都会把 inert 写回来 ⇒ 双保险：
   * ① 300ms 巡检兜底；② MutationObserver 在属性被写回的同一帧立刻移除，
   * 避免"点下去的那一瞬刚好撞上 inert"。回调里先判 hasAttribute 再移除，
   * 移除后不再触发移除动作 ⇒ 不会自激循环。
   */
  function clearDrawerInert() {
    var nodes = document.querySelectorAll('[inert]');
    for (var i = 0; i < nodes.length; i += 1) {
      try { nodes[i].removeAttribute('inert'); } catch (e) { /* 单节点失败不影响其余 */ }
    }
  }
  var inertObserver = null;
  function watchInert() {
    if (inertObserver !== null || typeof MutationObserver === 'undefined'
      || document.documentElement === null) { return; }
    try {
      inertObserver = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i += 1) {
          var el = records[i].target;
          if (el !== null && el.hasAttribute && el.hasAttribute('inert')) {
            try { el.removeAttribute('inert'); } catch (e) { /* 忽略 */ }
          }
        }
      });
      inertObserver.observe(document.documentElement, {
        subtree: true, attributes: true, attributeFilter: ['inert']
      });
    } catch (e) { inertObserver = null; }
  }
  /* §A/§B 的样式表：只注入一次。 */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID) !== null || document.head === null) { return; }
    /*
     * 【§A 为什么只压轨道宽度、不用 display:none（2026-10-09 真机踩到）】
     * display:none 会让该元素**退出网格自动排布**，于是后面的子项整体前移一格：
     * 中间列被放进第一根轨道（宽 0）⇒ **整屏黑**（真机现象：收起后什么都看不见）。
     * 压轨道到 0 宽则排布不变：侧栏列仍在第 1 格（被自身的 overflow:hidden 裁空），
     * 中间列仍在第 2 格、拿到全部宽度。
     * 【§B 同理不能用 position:absolute】绝对定位同样退出流 ⇒ 同样前移一格。
     * 改成 position:relative + z-index:80（仍在第 1 格、仍满高；2026-11-06 从 40 抬到 80，
     * 因为官方 0.2.2 的 drawerMask 是 70），宽度由元素盒给出
     * ⇒ 它横向溢出 0 宽的轨道盖在中间列之上；中间列因为轨道已归零而拿到整幅宽度。
     */
    var css = '#' + BACKDROP_ID + '{display:none;position:fixed;left:0;top:0;right:0;bottom:0;z-index:35;background:rgba(0,0,0,0.38)}'
      /*
       * 【2026-11-11 收起/小窗态只留一颗官方按钮】
       * 读随包核心（dsh-client-ui-sidebar 0.2.2-rc.1）确认：收起态 .…_collapsed .…_toggle
       * 显示的是品牌标 railMark，侧栏图标 panelIcon 被 display:none、只在 :hover 交换出来。
       * 这里把交换结果固化：收起态常显 panelIcon、常隐 railMark。
       * 类名用 [class*="_panelIcon"] 这类本地名后缀匹配（CSS Modules 只哈希前缀）。
       *
       * 另外 frame leading 座位还挂一颗 [data-sidebar-opener]（absolute）。小窗 / 折叠单屏 /
       * 平板把列压成窄轨后两条同时可见 ⇒ 用户报的"左上角两个按钮"。syncOpener() 每拍判断
       * 轨内那颗是否真的可用，可用就写 data-dshm-rail-opener="1"，下面把它收掉。
       */
      + 'html[' + STATE_ATTR + '="collapsed"] button[aria-label="打开侧边栏"] [class*="_panelIcon"],'
      + 'html[' + STATE_ATTR + '="collapsed"] button[aria-label="Open sidebar"] [class*="_panelIcon"]'
      + '{display:inline !important}'
      + 'html[' + STATE_ATTR + '="collapsed"] button[aria-label="打开侧边栏"] [class*="_railMark"],'
      + 'html[' + STATE_ATTR + '="collapsed"] button[aria-label="Open sidebar"] [class*="_railMark"]'
      + '{display:none !important}'
      + 'html[' + RAIL_OPENER_ATTR + '="1"] button[data-sidebar-opener]{display:none !important}'
      + 'html[' + STATE_ATTR + '="collapsed"] button[data-sidebar-opener]{opacity:1 !important;visibility:visible !important;pointer-events:auto !important}'
      + 'html[' + STATE_ATTR + '="collapsed"][' + PANEL_ATTR + '="open"] button[data-sidebar-opener]{opacity:0 !important;pointer-events:none !important}'
      + 'html[' + RIGHT_ATTR + '="open"] button[data-sidebar-opener]{opacity:0 !important;pointer-events:none !important}'
      /* 平板档 / 折叠屏展开：左栏真常驻（展开 280 / 收起 56），状态仍读官方 data-sidebar-collapsed。
         【2026-11-18 竖屏修正】官方 narrow = viewport < 1024（drawer < 768）时把侧栏列做成
         absolute 抽屉、主列吃整幅网格；无条件写死 280 会让主列回流到第 1 轨、会话区压到左栏上
         （用户实测：平板竖屏 / 折叠屏展开时"会话区侵入左侧边栏、左栏显示不全"）。
         ⇒ 写死几何只在 ≥1024 生效；<1024 交还官方抽屉浮层（tagLayout 会补 drawer 属性）。 */
      + '@media (min-width:1024px){'
      + 'html.' + TABLET_CLASS + '[' + STATE_ATTR + '="expanded"]:not([' + RIGHT_ATTR + '="open"]) .' + FRAME_CLASS
      + '{grid-template-columns:280px minmax(0,1fr) 0 !important}'
      + 'html.' + TABLET_CLASS + '[' + STATE_ATTR + '="collapsed"]:not([' + RIGHT_ATTR + '="open"]) .' + FRAME_CLASS
      + '{grid-template-columns:56px minmax(0,1fr) 0 !important}'
      + 'html.' + TABLET_CLASS + ' .' + COL_CLASS
      + '{position:relative !important;top:auto !important;left:auto !important;right:auto !important;bottom:auto !important;'
      + 'transform:none !important;visibility:visible !important;z-index:auto !important;'
      + 'width:auto !important;max-width:none !important;box-shadow:none !important}'
      + 'html.' + TABLET_CLASS + ' [class*="drawerMask"]{display:none !important;pointer-events:none !important}'
      + '}'
      /* 收起 ⇒ 左列 0 宽：只作用于手机 / 折叠单屏与 PC 档；平板是 56px 轨。
         COMPACT 那条必须带 :not(.dshm-tablet)：两个类在形态切换的首拍可能同时存在，
         而 :not() 会抬高特异性、压过上面的 56px 轨。 */
      + 'html.' + PC_CLASS + '[' + STATE_ATTR + '="collapsed"] .' + FRAME_CLASS + ':not([data-sidebar-drawer])'
      + ',html.' + COMPACT_CLASS + ':not(.' + TABLET_CLASS + ')[' + STATE_ATTR + '="collapsed"] .' + FRAME_CLASS + ':not([data-sidebar-drawer])'
      + '{grid-template-columns:0 minmax(0,1fr) 0 !important}'
      /* frame 的网格列已归零，但自身宽度仍可能来自横屏分屏时的像素缓存。
         锚定到当前视口宽度，旋转/分屏重排后不留下右侧白区。 */
      + 'html.' + HANDHELD_CLASS + ' .' + FRAME_CLASS
      + '{width:100% !important;max-width:100% !important;min-width:0 !important}'
      + '@media (min-width:768px) and (max-width:1023.98px){'
      + 'html.' + COMPACT_CLASS + ':not(.' + TABLET_CLASS + ')[' + STATE_ATTR + '="expanded"] .' + FRAME_CLASS + '{grid-template-columns:0 minmax(0,1fr) 0 !important}'
      + 'html.' + COMPACT_CLASS + ':not(.' + TABLET_CLASS + ')[' + STATE_ATTR + '="expanded"] .' + COL_CLASS + '{position:relative;z-index:80;width:280px;max-width:82vw;box-shadow:0 6px 28px rgba(0,0,0,0.4)}'
      + 'html.' + COMPACT_CLASS + ':not(.' + TABLET_CLASS + ')[' + STATE_ATTR + '="expanded"] .' + NODRAG_CLASS + '{display:none !important}'
      + 'html.' + COMPACT_CLASS + ':not(.' + TABLET_CLASS + ')[' + STATE_ATTR + '="expanded"] #' + BACKDROP_ID + '{display:block}'
      + '}';
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }
  /* 抽屉打开时"点空白处收起"的底座（只在 §B 形态可见，显隐由 CSS 管）。 */
  function ensureBackdrop() {
    if (document.getElementById(BACKDROP_ID) !== null || document.body === null) { return; }
    var bd = document.createElement('div');
    bd.id = BACKDROP_ID;
    bd.addEventListener('click', function () {
      if (state() === 'expanded') { clickToggle(); }
    });
    document.body.appendChild(bd);
  }
  /* 移动 UI 判据来自原生桥：platformForm 决定手持总开关；platformSingleScreen
     决定设置是否用窄屏横置；phone 只在直板机为真，用于首次登录引导。桥每 300ms 重读，
     折叠/展开、旋转都能在页面打开期间切换版式。 */
  /*
   * 桥"就位探测"的退避（2026-10-29，docs/291 高频报错；与 entry 同款）：
   * 垫片由 javaScriptOnDocumentStart 注入，__DSHM_BRIDGES__ 由 .javaScriptProxy
   * 属性注册 —— 桥对象存在但方法尚未挂上时，每拍调用都会让 ArkWeb 打一条
   * native proxy object not found 报错。失败按 1s→2s→4s→8s 退避，成功即清零。
   * 只改探测节奏，不改变任何形态判定。
   */
  var bridgeMiss = 0;
  var bridgeRetryAt = 0;
  function applyHandheld() {
    var now = Date.now();
    if (now < bridgeRetryAt) { return; }
    var b = globalThis.__DSHM_BRIDGES__;
    if (b === null || b === undefined || typeof b.platformForm !== 'function') {
      bridgeMiss = Math.min(bridgeMiss + 1, 4);
      bridgeRetryAt = now + Math.pow(2, bridgeMiss) * 500;
      return;
    }
    bridgeMiss = 0;
    bridgeRetryAt = 0;
    var form = '';
    /*
     * 【调用抛异常 ≡ 桥不可用（2026-10-29，docs/294 §5.1 线索 permission map is empty）】
     * 真机线索是 CheckIsInJsPermission: permission map is empty or no object_id(1) key
     * ⇒ 桥对象**存在**、方法在 methodList 里，但**每次调用都抛**。原来的
     * catch (e) { return; } 只"这一拍不做事"，下一拍照样再调 —— 于是每 300ms 一拍
     * 全变成 ArkWeb 侧的 native proxy object not found 日志（复测 420 次/分钟即此）。
     * 现在把它并进同一套退避：抛异常就是"桥当前不可用"，指数退避后再试。
     */
    try { form = b.platformForm(); } catch (e) {
      bridgeMiss = Math.min(bridgeMiss + 1, 4);
      bridgeRetryAt = now + Math.pow(2, bridgeMiss) * 500;
      return;
    }
    if (typeof form !== 'string' || form.length === 0) { return; }
    var phone = form === 'phone';
    var foldable = form === 'foldable';
    var compact = phone;
    if (!compact) {
      try { compact = typeof b.platformSingleScreen === 'function' ? b.platformSingleScreen() === true : false; } catch (e3) { compact = false; }
    }
    var pcm = false;
    try { pcm = typeof b.platformPcMode === 'function' ? b.platformPcMode() === true : false; } catch (e2) {
      /* 同上：抛异常 ⇒ 桥当前不可用 ⇒ 走退避，别每拍硬敲 */
      bridgeMiss = Math.min(bridgeMiss + 1, 4);
      bridgeRetryAt = now + Math.pow(2, bridgeMiss) * 500;
      return;
    }
    /* 【2026-11-12 用户裁决】折叠屏双屏/三屏（原生桥答 foldable 且非单屏）跟 PC 打开
       一样：归入桌面档 dshm-desktop，收起左侧栏由官方原生窄轨处理；折叠单屏仍走直板机。
       判据只用原生桥 form / platformSingleScreen / platformPcMode，不看视口宽度。 */
    var desktop = form === 'desktop' || pcm || (foldable && !compact);
    var key = form + (compact ? '|compact' : '') + (phone ? '|phone' : '') + (desktop ? '|desktop' : '');
    if (key === appliedFormKey) { return; }
    var first = !handheldAsked;
    appliedFormKey = key;
    handheldAsked = true;
    var htmlEl = document.documentElement;
    setFlag(htmlEl, HANDHELD_CLASS, !desktop);
    setFlag(htmlEl, DESKTOP_CLASS, desktop);
    /* 移动壳没有原生顶栏：Edge（form=desktop）与平板自由窗口都保留官方 toggle，
       并在收起态使用页面内浮动入口，否则侧栏会失去全部入口。 */
    setFlag(htmlEl, PC_CLASS, desktop && !(foldable && !compact));
    setFlag(htmlEl, COMPACT_CLASS, !desktop && compact);
    setFlag(htmlEl, PHONE_CLASS, !desktop && phone);
    /*
     * 平板独立档（2026-11-06 用户口径，保持不动）：只有 form=tablet 挂 dshm-tablet。
     * 折叠屏双屏/三屏已归入上面的桌面档，折叠单屏走直板机 —— 都不再挂平板自绘 56px 轨。
     * 判据只用原生桥给出的 form / singleScreen，不看视口宽度（2026-11-12 用户裁决）。
     */
    setFlag(htmlEl, TABLET_CLASS, !desktop && !phone && form === 'tablet');
    setFlag(htmlEl, FOLDABLE_CLASS, foldable);
    /* 折叠屏从外屏展开成平板格局时重新给一次默认展开机会；折叠回单屏则继续跳开。 */
    if (lastCompact && !compact) {
      autoTried = false;
      autoBootAt = 0;
    }
    lastCompact = compact;
    isDesktop = desktop;
    log('platform form = ' + form + ' compact=' + compact + ' phone=' + phone
      + ' desktop=' + desktop
      + (first ? '' : ' (reclassified)'));
  }
  /* 【为什么是 300ms 巡检而不是 MutationObserver】状态只有一个来源（按钮的 aria-label），
     而那颗按钮所在的 React 子树会在会话/面板切换时整段重建（观察者会随节点被换掉而失效，
     还得自己 re-arm）；一次 querySelectorAll('button') 的代价远小于"漏一次状态"的代价。 */
  function applyState(st, why) {
    if (st === 'unknown' || st === lastState) { return; }
    lastState = st;
    document.documentElement.setAttribute(STATE_ATTR, st);
    /* 几何诊断：每次状态变化记一行"生效后的三列轨道宽度"。§A/§B 的 CSS 到底有没有
       落到布局上，看这一行即可（读的是 computed，不是我们自己写的规则）。
       【why 为什么必须有（2026-10-10 加）】状态有两条来路：300ms 巡检（poll）与点击
       当场应用（tap）。诊断行不区分它们的话，"到底是巡检跟上的、还是当场应用的"就
       看不出来 —— 而这正是下面 clickToggle 里那段"快速对账"是否生效的唯一判据。 */
    var frame = findFrame();
    var grid = 'n/a';
    try { grid = frame === null ? 'n/a' : window.getComputedStyle(frame).gridTemplateColumns; } catch (e) { grid = 'err'; }
    log('state ' + st + ', grid=' + grid + (why === undefined ? '' : ' ' + why));
  }
  /* 当前是不是平板档（dshm-tablet 由 applyHandheld 按 platformForm 挂/摘）。 */
  function isTabletForm() {
    try {
      var cur = document.documentElement.getAttribute('class');
      return cur !== null && cur.indexOf(TABLET_CLASS) >= 0;
    } catch (e) { return false; }
  }
  function syncState() {
    /*
     * 2026-11-06（docs/385）：几何已交还官方 ⇒ 平板档**跟随官方状态**（56px 轨 / 280）。
     * 我们只保留"意图"用于补点（见 ensureTabletExpanded），不再覆盖状态。
     */
    applyState(state(), isTabletForm() ? '(poll tablet)' : '(poll)');
  }
  /* 可见性判据：真有布局盒子、且没被 display / visibility / opacity 藏掉（与 BACK_SHIM 的 visible() 同款）。 */
  function panelElVisible(el) {
    if (el.getClientRects().length === 0) { return false; }
    var cs = window.getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }
  /* 现状：屏幕上有没有可见的面板/浮层（决定官方 opener 临时藏不藏）。 */
  function panelOpen() {
    var list = document.querySelectorAll(PANEL_SEL);
    for (var i = 0; i < list.length; i += 1) {
      if (panelElVisible(list[i])) { return true; }
    }
    return false;
  }
  function syncPanel() {
    var want = panelOpen() ? 'open' : 'closed';
    if (want === lastPanel) { return; }
    lastPanel = want;
    document.documentElement.setAttribute(PANEL_ATTR, want);
    log('panel ' + want);
  }
  /* 右侧栏是否打开（2026-10-18）：官方契约是 data-sidebar-right-open = 展开时才有的属性，
     关闭时移除，且关闭态面板带 aria-hidden=true。只认属性 + 非 aria-hidden + 真有盒子；
     读不到任何证据一律按关闭（fail-open：宁可显示入口，也不能把入口藏死）。 */
  function rightPanelOpen() {
    var list = document.querySelectorAll('[data-sidebar-right-open]');
    for (var i = 0; i < list.length; i += 1) {
      var el = list[i];
      if (el.getAttribute('data-sidebar-right-open') === null) { continue; }
      if (el.getAttribute('aria-hidden') === 'true') { continue; }
      if (panelElVisible(el)) { return true; }
    }
    return false;
  }
  function rightSig() {
    var panel = document.querySelector('[data-sidebar-right-panel]');
    var mode = panel === null ? 'none' : String(panel.getAttribute('data-sidebar-right-panel'));
    var opened = document.querySelector('[data-sidebar-right-open]') !== null;
    var hidden = panel !== null && panel.getAttribute('aria-hidden') === 'true';
    return 'attr=' + (opened ? 'open' : '-') + ' mode=' + mode + (hidden ? ' aria-hidden' : '');
  }
  function syncRight() {
    var want = rightPanelOpen() ? 'open' : 'closed';
    if (want === lastRight) { return; }
    lastRight = want;
    document.documentElement.setAttribute(RIGHT_ATTR, want);
    log('right panel ' + want + ' (' + rightSig() + ')');
  }
  /* 【一次性诊断（§E，2026-10-10）】回答三类问题：html 上的类还在不在、页面上到底有几颗
     带这个 aria-label 的按钮（各自的盒子与 computed display）、以及那条 CSS 规则**到底
     能不能匹配上**（matches / styleEl / hasRule）。一个页面各打一行（ticks===40 ≈ 12s，
     足以等官方把类写完）。
     【它的战果】真机首跑就是靠这两行把“没生效”钉成“选择器命中了、规则文本也在，只是落点
     错了”，再用“把注入的 CSS 拿出来数括号”定了根因（见 tagLayout 里那段）。别删。 */
  function diagToggle() {
    if (diagDone) { return; }
    diagDone = true;
    var parts = [];
    var all = document.querySelectorAll('button');
    for (var i = 0; i < all.length; i++) {
      var lab = all[i].getAttribute('aria-label');
      if (lab === null || (!has(COLLAPSE_LABELS, lab) && !has(OPEN_LABELS, lab))) { continue; }
      var box = 'n/a';
      var disp = 'n/a';
      try {
        var r = all[i].getBoundingClientRect();
        box = Math.round(r.width) + 'x' + Math.round(r.height);
        disp = window.getComputedStyle(all[i]).display;
      } catch (e) { box = 'err'; disp = 'err'; }
      parts.push(lab + ' box=' + box + ' display=' + disp
        + ' inline=' + (all[i].style.display === '' ? '-' : all[i].style.display)
        + ' id=' + (all[i].id === '' ? '-' : all[i].id));
    }
    log('diag htmlClass=' + JSON.stringify(document.documentElement.getAttribute('class'))
      + ' drawer=' + (isDrawer() ? 'yes' : 'no') + ' geoState=' + state()
      + ' candidates=' + parts.length + ' :: ' + parts.join(' | '));
  }
  /*
   * 启动自愈（阈值见本函数注释：官方侧栏首次挂载后前 15s、视口 ≥ 900 才试一次）：
   * 手持档 + 视口 ≥ 阈值 + 官方仍在收起态 ⇒ 程序化点开一次；只试一次。
   *
   * 【不能把“还找不到侧栏”当成“无需自愈”】2026-10-24 MatePad Mini/API 24 首启：
   * NWeb 已经创建，但官方 React 侧栏尚未挂载；旧实现此时把 autoTried 永久置真，
   * 之后真实侧栏以收起态出现也再没机会恢复。等待官方 toggle 和明确状态都出现后，
   * 才开始 15 秒时间窗并只尝试一次。
   *
   * 【为什么用字面量 15000 / 900 而不是插值常量】SIDEBAR_SHIM_JS 整段是模板字符串：
   * 这里写插值占位符会让桩环境把它当 JS 语法执行（Unexpected token），也会让
   * tools/check-sidebar-shim-css.mjs 判"未登记插值"。两个数只在垫片内用一次。
   */
  var autoBootAt = 0;
  var autoTried = false;
  function ensureTabletExpanded() {
    var cls = document.documentElement === null ? '' : (document.documentElement.getAttribute('class') || '');
    /*
     * ⚠️ 2026-10-31（docs/333）**启动静默期** —— 修的是"三端左下角连接失败"的真因。
     *
     * 真机日志：IN-UPGRADE GET /api/remote.mux upgrade=websocket
     *           URLRequestCanceled error:ERR_WS_UPGRADE(-173)   ← 握手被**取消**
     *
     * 机制：页面刚加载时官方侧栏还没进入"展开"态（React 首帧顺序），本函数判定
     * "它是收起态" ⇒ 每 800ms 点一次官方 toggle ⇒ 触发整页重渲染/重排 ⇒ **打断
     * 正在握手的 WebSocket** ⇒ official 连接状态机落 disconnected ⇒ 左下角
     * 「连接异常，刷新重试」。
     *
     * 为什么"剥离会议后才出现"：此前 entry 壳没有这个 keep-open（只有 phone 有）；
     * docs/332 为修平板侧栏把它同步进 entry ⇒ 三端同时开始"每拍点按钮"。
     *
     * 修法：垫片启动后 8 秒内完全不碰 toggle，让连接先建立、官方首帧先稳定。
     */
    /*
     * 启动静默期：手机/平板都靠它保护首帧的 WebSocket 握手（docs/333）。
     * 平板额外放宽到 3s：它要求"进去就是展开的"，等 20s 用户早就以为坏了；
     * 3s 足够让首帧与首次连接起来，又不会明显拖延。
     */
    var quietUntil = isTabletForm() ? (bootQuietUntil - STARTUP_QUIET_MS + 3000) : bootQuietUntil;
    if (Date.now() < quietUntil) { return; }
    if (cls.indexOf(HANDHELD_CLASS) < 0) { return; }
    /* 平板优先：平板可能是 compact（单屏/折叠单屏判定），但它的左栏要一直展开。 */
    if (!isTabletForm() && (cls.indexOf(COMPACT_CLASS) >= 0 || cls.indexOf(PC_CLASS) >= 0)) { return; }
    /*
     * 2026-11-06（第五次口径）：**我们的意图是唯一真源**。
     * 只有"用户没主动收起（tabletWantsExpanded）且官方那边确实是收起态"时才去对齐一次，
     * 让 React 渲染出全宽侧栏内容（几何本身由我们自己的 data 属性 + CSS 保证）。
     */
    if (!tabletWantsExpanded || manualTabletCollapsed) { return; }
    if (state() !== 'collapsed') { return; }
    /* 【2026-11-18】<1024 走官方抽屉浮层（见 ensureStyle / tagLayout）：
       抽屉默认收起、由官方 opener 呼出；这里若继续每 800ms 补点，浮层会反复盖住主区、
       用户也关不掉 ⇒ 补点只在官方非 narrow（≥1024，真·常驻 280）时做。 */
    if (Math.round(window.innerWidth || 0) < 1024) { return; }
    var now = Date.now();
    if (lastTabletKeepOpenAt !== 0 && now - lastTabletKeepOpenAt < 800) { return; }
    lastTabletKeepOpenAt = now;
    log('tablet keep-open: 非用户收起 ⇒ 恢复左栏');
    clickToggle();
  }
  function maybeAutoExpand() {
    if (autoTried) { return; }
    var cls = document.documentElement === null ? '' : (document.documentElement.getAttribute('class') || '');
    var isHandheldNow = cls.indexOf(HANDHELD_CLASS) >= 0;
    var isPcNow = cls.indexOf(PC_CLASS) >= 0;
    if (!isHandheldNow && !isPcNow) { return; }
    var w = Math.round(window.innerWidth || 0);
    var h = Math.round(window.innerHeight || 0);
    /* 直板机 / 折叠单屏仍不抢开。 */
    if (cls.indexOf(COMPACT_CLASS) >= 0 && w < 900) { return; }
    var toggle = findToggle();
    if (toggle === null) { return; }
    var st = state();
    if (st === 'unknown') { return; }
    if (autoBootAt === 0) { autoBootAt = Date.now(); return; }
    if (Date.now() - autoBootAt > 15000) { autoTried = true; return; }
    autoTried = true;
    if (st !== 'collapsed') { return; }
    log('auto-expand: w=' + w + ' 仍是收起态 ⇒ 自动点开（一次性）');
    clickToggle();
  }

  function tick() {
    try {
      ticks += 1;
      applyHandheld();
      ensureStyle();
      ensureBackdrop();
      tagLayout();
      watchInert();
      clearDrawerInert();
      syncState();
      syncOpener();
      ensureTabletExpanded();
      maybeAutoExpand();
      syncPanel();
      syncRight();
      if (ticks === 40) { diagToggle(); }
    } catch (e) { /* 单拍失败不致命：下一拍重来 */ }
  }
  var tries = 0;
  function clickToggle() {
    var el = findToggle();
    /* 抽屉态（<768）官方只留顶栏 opener 一颗开关，侧栏内那颗已不存在 ⇒ 兜底用它。 */
    if (el === null) { el = findOpener(); }
    if (el === null) {
      if (tries < 40) { tries += 1; setTimeout(clickToggle, 150); }
      else { log('toggle button not found, frame=' + frameFlag()); }
      return;
    }
    tries = 0;
    var before = state();
    try {
      programmaticToggleClick = true;
      el.click();
    } catch (e) {
      log('click threw: ' + e);
      return;
    } finally {
      programmaticToggleClick = false;
    }
    /*
     * 【点击当场应用状态（2026-10-10 修"手动点击这个按钮过渡有点卡"）】
     * §A/§B 的 CSS 全部挂在 html[data-dshm-sidebar=…] 上，而那个属性此前**只**由
     * 300ms 巡检（tick）写 ⇒ 点下去到"布局真的开始收起"之间有一段 0~300ms 的**纯等待**：
     * 官方自己那段 grid-template-columns 过渡（--ds-transition-duration-slow）已经
     * 跑掉一截，我们的覆盖值才到位 ⇒ 表现为"两段式"，整体发卡。
     * 两步修法：
     *   ① 乐观应用：这颗按钮就是 toggle，点一下必然翻转 ⇒ 先用 before 的反值把属性
     *      写下去，布局与官方动画**同一帧**起步；
     *   ② 快速对账：每 20ms 读一次真值，**一旦按钮自己翻了就采纳真值并停**（不拿还没
     *      重渲染的旧读数去"纠正"乐观值 —— 那会把刚修掉的延迟又放回来）；到 500ms 仍
     *      没翻（官方禁用/拒绝），调用一次 syncState() 把乐观值纠正回来。
     * 300ms 巡检保留不动：它仍是"页面整段重建后自愈"的那条兜底链。
     */
    applyState(before === 'expanded' ? 'collapsed'
      : (before === 'collapsed' ? 'expanded' : 'unknown'), '(tap 乐观)');
    var waited = 0;
    (function fast() {
      var st = stateOf(findToggle());
      if (st !== 'unknown' && st !== before) { applyState(st, '(tap 对账)'); return; }
      waited += 1;
      if (waited < 25) { setTimeout(fast, 20); } else { syncState(); }
    })();
    /* React 重渲染是异步的：隔一拍再回读，否则读到的还是旧状态。 */
    setTimeout(function () { log('toggle ' + before + ' -> ' + stateOf(findToggle()) + ', frame=' + frameFlag()); }, 260);
  }
  globalThis.__DSHM_SIDEBAR__ = {
    /* 原生顶栏那颗按钮按一下走这里；重试也在垫片里，桥不承担。 */
    toggle: function () { clickToggle(); return true; },
    /* 验收 / 诊断读数：'collapsed' | 'expanded' | 'unknown' */
    state: function () { return state(); }
  };
  tick();
  armTick();
  log('shim installed');
})();`

/**
 * 设置面板的**移动端统一**布局垫片（2026-10-10 用户裁决；2026-10-22 手机/折叠/平板统一）。
 *
 * 【要解决的事】官方「设置」是**桌面形态**：800px 宽的居中弹窗，左边一条 188px 的竖向
 * 导航列，右边才是内容。放到手机上（竖屏 ~366 CSS px、横屏 ~809）就成了"导航列吃掉一
 * 半宽度、内容只剩一条"（横屏尤其难用）。用户原话：
 *   · "打开设置全盘展示"              ⇒ 面板铺满视口，不再是一个居中弹窗；
 *   · "设置菜单项目放在 UI 顶部横置"   ⇒ 188px 竖向导航改成**顶部横向 tab 条**；
 *   · "点击每项在上方展示和修改"       ⇒ 选中项的内容占满剩下那块整区域；
 *   · "适配各种手机屏幕尺寸"           ⇒ 横条**横向可滚**（放不下就滑），不折行、不挤压。
 *
 * 【为什么是"打标记 + 自己的 CSS"而不是改官方源码】与 SIDEBAR_SHIM_JS 同一套路：
 * 官方类名是 CSS Modules 哈希（`VOzbGW_nav` 之类），换版本就变。本垫片只认两类**稳定
 * 锚点**：
 *   ① `[data-shortcut-modal="settings"]` —— 面板自己的 JSX **字符串字面量**（压缩不改名，
 *      与 `[data-shell-overlay]` 同源）；
 *   ② 结构关系 —— 面板的 `nav` 子元素（里面依次是标题槽与导航列表）与另一个 `div`
 *      （内容区，里面依次是 header 与 options）。全靠 DOM 关系推出来，**不写死一个官方
 *      类名**。推出来的节点各挂一个 `dshm-set-*` 类，CSS 只认这些类。
 *
 * 【失效即回退（fail-closed）】结构对不上就不挂 `dshm-set-ready`，而**所有**规则都以
 * `html.dshm-compact .dshm-set-panel.dshm-set-ready` 开头 ⇒ 一条都不落地，页面回到官方
 * 原样。宁可"没适配"，也绝不改出个半拉子面板。
 *
 * 【只在单屏窄形态启用】判据是 `html.dshm-compact`：直板手机，或折叠屏处于
 * `FOLD_STATUS_FOLDED` 单屏折叠态。折叠屏展开、半折叠、平板和桌面形态调试环境都保留
 * 官方原生竖排设置。
 *
 * 【当前项为什么不用 JS 维护】官方那颗按钮自带 `aria-current="true"`（无障碍契约面），
 * 直接写进 CSS 选择器即可 —— 少一路 JS 状态，也就不会出现"CSS 里的选中态与官方漂开"。
 *
 * 【为什么也是 300ms 巡检】面板是 body 上的 portal，开关一次重建一次；导航项还会随插件
 * 增减而变。巡检比 MutationObserver 便宜也简单（与 SIDEBAR_SHIM_JS 同款取舍），且每一拍
 * 的写操作都是幂等的 addClass。
 */

/**
 * 移动端裸 Enter = 换行（2026-11-11，用户裁决："换行就是换行，发送是 dsh 的按钮"）。
 *
 * 【问题】官方会话输入框把**裸 Enter** 绑成发送（`dsh-client-ui-conversation` 的
 * KEY_ENTER 处理器：event.shiftKey !== true ⇒ handlers.submit()）。手机 / 平板软键盘的
 * 换行键发的正是裸 Enter ⇒ 用户想换行，消息直接被发出去。
 *
 * 【修法】不改官方包、不碰发送按钮，只在**移动形态**把裸 Enter 转成官方自己的
 * Shift+Enter 语义：捕获阶段拦下原事件，再向同一目标补发一颗 shiftKey=true 的 keydown。
 * 官方处理器见到 shiftKey 立刻 `return false`，由 Lexical 内置 KEY_ENTER 命令插入换行
 * —— 与用户真按 Shift+Enter 走完全同一条路径（不伪造 DOM、不 execCommand、不猜编辑器 API）。
 *
 * 【五条边界，缺一条就会误伤】
 *   ① 只在 `html.dshm-handheld`（手机 / 平板 / 折叠）生效；PC / 2in1 桌面形态保持官方
 *      「Enter 发送」，一行都不改。
 *   ② 输入法组字中（`isComposing` / keyCode 229）不拦 —— 选词的确认回车必须交回输入法。
 *   ③ 带任何修饰键（Shift / Ctrl / Alt / Meta）不拦 —— 官方 Ctrl+Enter「互补发送」照旧。
 *   ④ 命令菜单 / @ 引用 / 斜杠菜单 / 工作区菜单等**任何可见弹层**在场时不拦 —— 那里
 *      Enter 是"选中"，抢走它会让菜单只能用鼠标点。
 *   ⑤ 只认会话输入座位里的 Lexical 编辑器（`composerSeat` + `data-lexical-editor`），
 *      设置页搜索框、插件表单、终端输入一律不碰。
 */
const MOBILE_ENTER_SHIM_JS: string = `(function () {
  if (globalThis.__DSHM_ENTER__) { return; }
  globalThis.__DSHM_ENTER__ = true;
  /* 诊断：真机可读 window.__DSHM_ENTER_STATS__ 看拦截/跳过原因，不影响行为。 */
  var stats = { seen: 0, forwarded: 0, reason: '' };
  globalThis.__DSHM_ENTER_STATS__ = stats;
  /* 形态判据来自 SIDEBAR_SHIM_JS 写在 <html> 上的类；每拍现读，旋转 / 折叠后立刻跟随。 */
  function mobileForm() {
    var cur = document.documentElement === null ? null : document.documentElement.getAttribute('class');
    return cur !== null && cur !== undefined && cur.indexOf('dshm-handheld') >= 0;
  }
  /* 任何可见弹层在场 ⇒ Enter 属于弹层（选中 / 关闭），原样交回官方。
     【2026-11-12】弹层自身若包含当前焦点（例如输入框在弹层里），不能因此拦住会话输入；
     aria-hidden="true" 的离屏层也不算。 */
  function menuOpen(target) {
    try {
      var list = document.querySelectorAll('[role="listbox"],[role="menu"],[role="dialog"],[aria-haspopup][aria-expanded="true"]');
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (el.getAttribute('aria-hidden') === 'true') { continue; }
        if (target !== null && target !== undefined && typeof el.contains === 'function' && el.contains(target)) { continue; }
        var r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { return true; }
      }
    } catch (e) { /* 读数失败按"没弹层"处理：宁可换行，也不把输入吞掉 */ }
    return false;
  }
  /*
   * 【2026-11-12 放宽】不再强制 data-lexical-editor：部分机型/输入法下焦点落在
   * contenteditable 子节点、甚至用 textarea 承接输入，旧判据会整段跳过 ⇒ 裸 Enter 仍发送。
   * 边界仍由 composerSeat 保证：座位外的搜索框 / 插件表单 / 终端一律不碰。
   */
  function inComposer(target) {
    if (target === null || target === undefined || typeof target.closest !== 'function') { return false; }
    if (target.closest('[data-composer-seat],[class*="composerSeat"]') === null) { return false; }
    if (target.closest('[data-lexical-editor="true"]') !== null) { return true; }
    var el = target;
    while (el !== null && el !== undefined) {
      if (el.isContentEditable === true) { return true; }
      if (el.tagName === 'TEXTAREA') { return true; }
      el = el.parentElement;
    }
    return false;
  }
  function onKeyDown(ev) {
    /* 软键盘可能只给 keyCode=13（key 为 Unidentified），三种形态都认。 */
    stats.seen += 1;
    if (ev.key !== 'Enter' && ev.code !== 'Enter' && ev.keyCode !== 13) { stats.reason = 'not-enter'; return; }
    if (ev.isComposing === true || ev.keyCode === 229) { stats.reason = 'composing'; return; }
    if (ev.shiftKey === true || ev.ctrlKey === true || ev.altKey === true || ev.metaKey === true) { stats.reason = 'modifier'; return; }
    if (!mobileForm()) { stats.reason = 'not-handheld'; return; }
    if (menuOpen(ev.target)) { stats.reason = 'menu-open'; return; }
    if (!inComposer(ev.target)) { stats.reason = 'outside-composer'; return; }
    /* 原事件必须彻底拦死：官方快捷键服务与 composer 都挂在 window / document 上，
       只用 stopPropagation 的话同节点上后注册的监听仍会看到裸 Enter 并发送。 */
    ev.preventDefault();
    ev.stopImmediatePropagation();
    var clone = null;
    try {
      clone = new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', shiftKey: true,
        bubbles: true, cancelable: true, composed: true
      });
    } catch (e) { clone = null; }
    if (clone === null) { return; }
    ev.target.dispatchEvent(clone);
    stats.forwarded += 1;
    stats.reason = 'forwarded';
  }
  window.addEventListener('keydown', onKeyDown, true);
})();`

/**
 * 市场 681px 卡片分桶兼容垫片；它不是整页缩窄根因已经闭环的证据。
 * 保留原 compact FakeMQL 兼容策略，仅修查询转义；不改 CSS、列数或祖先宽度。
 * FakeMQL 不派 change，既有对象不追踪形态切换；此轮不扩张媒体查询事件框架。
 * 带空格查询必须在外层模板求值后仍能归一化；门禁执行 cooked 脚本验证。
 * 市场可见时低频、有界地采样布局与真实查询，供真机定位缩放及容器收缩。
 */
const MARKET_WIDE_SHIM_JS: string = `(function () {
  if (globalThis.__DSHM_MARKET_WIDE__) { return; }
  globalThis.__DSHM_MARKET_WIDE__ = true;
  var GATE_QUERY = '(min-width:681px)';
  function log(msg) {
    try { console.info('[dshm-market-wide] ' + msg); } catch (e) { /* 无 console：忽略 */ }
  }
  function compact() {
    var cur = document.documentElement.getAttribute('class');
    return cur !== null && cur !== undefined && cur.indexOf('dshm-compact') >= 0;
  }
  function norm(q) {
    return String(q === null || q === undefined ? '' : q).replace(/\\s+/g, '').toLowerCase();
  }
  var queryReads = [];
  function FakeMediaQueryList(query) {
    this.media = query;
    this.matches = true;
    this.onchange = null;
  }
  /* 保持原有不派 change 的行为，避免混合原生事件与覆写值后相互矛盾。 */
  FakeMediaQueryList.prototype.addListener = function () { };
  FakeMediaQueryList.prototype.removeListener = function () { };
  FakeMediaQueryList.prototype.addEventListener = function () { };
  FakeMediaQueryList.prototype.removeEventListener = function () { };
  FakeMediaQueryList.prototype.dispatchEvent = function () { return false; };
  function patch() {
    if (typeof window.matchMedia !== 'function' || window.__DSHM_MARKET_WIDE_PATCHED__ === true) { return; }
    var orig = window.matchMedia;
    var wrapped = function (q) {
      var forced = false;
      try { forced = norm(q) === GATE_QUERY && compact(); } catch (e) { /* 判定失败走原实现。 */ }
      var mql = forced ? new FakeMediaQueryList(q) : orig.call(window, q);
      if (queryReads.length < 8 || norm(q) === GATE_QUERY) {
        if (queryReads.length >= 8) { queryReads.shift(); }
        queryReads.push({ query: String(q).slice(0, 160), matches: mql.matches, forced: forced });
      }
      return mql;
    };
    window.matchMedia = wrapped;
    window.__DSHM_MARKET_WIDE_PATCHED__ = true;
    log('installed gate=' + GATE_QUERY);
  }
  patch();
  var diagTimer = 0;
  var diagTotal = 0;
  var diagRoot = null;
  var diagPerOpen = 0;
  function geometry(el) {
    if (!el) { return null; }
    var r = el.getBoundingClientRect();
    var cs = window.getComputedStyle(el);
    return { tag: el.tagName, cls: String(el.getAttribute('class') || '').slice(0, 240),
      width: r.width, height: r.height, x: r.x, y: r.y,
      clientWidth: el.clientWidth, scrollWidth: el.scrollWidth,
      display: cs.display, position: cs.position, overflow: cs.overflow,
      grid: cs.gridTemplateColumns, transform: cs.transform };
  }
  function diagnose() {
    if (document.visibilityState === 'hidden') { return; }
    try {
      var roots = document.querySelectorAll('[data-dsh-market-root]');
      var root = null;
      for (var i = 0; i < roots.length; i++) {
        var r = roots[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && window.getComputedStyle(roots[i]).visibility !== 'hidden') {
          root = roots[i]; break;
        }
      }
      if (root !== diagRoot) { diagRoot = root; diagPerOpen = 0; }
      if (!root || diagPerOpen >= 3) { return; }
      diagPerOpen += 1;
      diagTotal += 1;
      var chain = [];
      var p = root;
      for (var depth = 0; p && depth < 10; depth++, p = p.parentElement) { chain.push(geometry(p)); }
      var viewport = window.visualViewport;
      var html = document.documentElement;
      log('layout ' + JSON.stringify({ sample: diagTotal, innerWidth: window.innerWidth,
        clientWidth: html.clientWidth, scrollWidth: html.scrollWidth, htmlClass: html.getAttribute('class'),
        viewportWidth: viewport ? viewport.width : null, scale: viewport ? viewport.scale : null,
        queries: queryReads, gateMatches: window.matchMedia('(min-width: 681px)').matches,
        frame: geometry(document.querySelector('[class*="_frame"]:has([data-rightbar-col])')),
        center: geometry(document.querySelector('[class*="_centerCol"]')),
        rightbar: geometry(document.querySelector('[data-rightbar-col]')),
        dialog: geometry(root.closest('[role="dialog"]')), chain: chain }));
      if (diagTotal >= 12) { clearInterval(diagTimer); diagTimer = 0; }
    } catch (e) { /* 诊断不干预官方页面。 */ }
  }
  /* 每次打开最多三次、每文档最多十二次；不记录正文、URL 或认证信息。 */
  diagTimer = setInterval(diagnose, 2000);
})();`

const SETTINGS_SHIM_JS: string = `(function () {
  if (globalThis.__DSHM_SETTINGS__) { return; }
  /* 单屏窄形态开关（SIDEBAR_SHIM_JS 挂上）：直板手机或折叠屏折叠态。 */
  var COMPACT_CLASS = 'dshm-compact';
  var PHONE_CLASS = 'dshm-phone';
  var HANDHELD_CLASS = 'dshm-handheld';
  var FOLDABLE_CLASS = 'dshm-form-foldable';
  /* 面板锚点：官方 JSX 里的字符串字面量，压缩不改名。 */
  var PANEL_SEL = '[data-shortcut-modal="settings"]';
  var PANEL_CLASS = 'dshm-set-panel';
  var READY_CLASS = 'dshm-set-ready';
  var MASK_CLASS = 'dshm-set-mask';
  var OVERLAY_CLASS = 'dshm-set-overlay';
  var NAV_CLASS = 'dshm-set-nav';
  var NAVTITLE_CLASS = 'dshm-set-navtitle';
  var NAVLIST_CLASS = 'dshm-set-navlist';
  var CELL_CLASS = 'dshm-set-cell';
  var CONTENT_CLASS = 'dshm-set-content';
  var HEADER_CLASS = 'dshm-set-header';
  var OPTIONS_CLASS = 'dshm-set-options';
  var STYLE_ID = 'dshm-settings-style';
  /* 巡检周期（ms）：见头注末段。 */
  var TICK_MS = 300;
  /* 【失焦停摆（2026-10-29，方案 A，与 entry 同步）】hidden 停摆、visible 恢复并当拍补跑。 */
  var settingsTickTimer = setInterval(tick, TICK_MS);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      if (settingsTickTimer !== 0) { clearInterval(settingsTickTimer); settingsTickTimer = 0; }
      return;
    }
    if (settingsTickTimer === 0) { settingsTickTimer = setInterval(tick, TICK_MS); }
    tick();
  });
  function log(msg) {
    try { console.info('[dshm-settings] ' + msg); } catch (e) { /* 无 console：忽略 */ }
  }
  function addClass(el, cls) {
    if (el === null || el === undefined) { return; }
    var cur = el.getAttribute('class');
    if (cur === null) { cur = ''; }
    if (cur.indexOf(cls) >= 0) { return; }
    el.setAttribute('class', cur === '' ? cls : cur + ' ' + cls);
  }
  function tagName(el) {
    return el.tagName === null || el.tagName === undefined ? '' : el.tagName.toLowerCase();
  }
  function compact() {
    var cur = document.documentElement.getAttribute('class');
    if (cur === null) { return false; }
    if (cur.indexOf(COMPACT_CLASS) >= 0 || cur.indexOf(PHONE_CLASS) >= 0) { return true; }
    var w = Math.round(window.innerWidth || 0);
    var h = Math.round(window.innerHeight || 0);
    /* Pura 等预览窗口底层仍报桌面形态，但实际是窄而高的单屏手机窗口，必须走横置设置。 */
    if (cur.indexOf(HANDHELD_CLASS) >= 0 && w > 0 && w < 600 && h > w * 1.35) { return true; }
    /* 折叠屏外屏同样可按窄视口兜底；展开内屏不会命中。 */
    return cur.indexOf(FOLDABLE_CLASS) >= 0 && w > 0 && w < 600;
  }
  /* 移动端布局：只注入一次。所有规则都以 .dshm-set-panel.dshm-set-ready 起头 ⇒
     结构没认全（没挂 ready）时整套规则一条都不生效。 */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID) !== null || document.head === null) { return; }
    var P = 'html.' + COMPACT_CLASS + ' .' + PANEL_CLASS + '.' + READY_CLASS;
    var css = P + '{width:100vw;max-width:100vw;height:100%;max-height:100%;border-radius:0;flex-direction:column}'
      /* 覆盖层钉到视口：官方那层是「居中弹窗」的容器（.overlay），不改它的话面板高度会
         跟着内容长（height:100% 落在没有定高的父上）⇒ 整块面板能被拖动，顶部横条会被拖走。 */
      + 'html.' + COMPACT_CLASS + ' .' + OVERLAY_CLASS + '{position:fixed;left:0;top:0;right:0;bottom:0;display:block;margin:0;padding:0;overflow:hidden}'
      /* 铺满就没有"外面"可点 ⇒ 遮罩无用（顺带省掉 backdrop-filter 的合成开销） */
      + 'html.' + COMPACT_CLASS + ' .' + MASK_CLASS + '{display:none}'
      /* 侧栏列 → 顶部横条：宽度吃满、不再占一列。
         display:flex 必须**显式写死**：dshmarket 自带的窄屏 CSS 里有一条
         @media (max-width:560px){[role=dialog]:has([data-dsh-market-root])>nav{display:none}}
         —— 它判的就是"设置面板里嵌着市场"这件事，会把这条顶部横条整条藏掉（手机上再也切不了页签）。
         本选择器（html.dshm-compact .dshm-set-panel.dshm-set-ready>nav）比它高一档 ⇒ 写回 flex 即可。 */
      /* 顶部横条本体的那条规则：**必须无条件**（见上一条注释 —— 它管的是 display，
         是拿来压 dshmarket 那条 display:none 的；一旦收进任何作用域，那层反制就可能失效）。 */
      + P + '>.' + NAV_CLASS + '{display:flex;width:100%;flex:none;flex-direction:column;gap:0;padding:0;border-bottom:.5px solid var(--dsw-alias-border-l3)}'
      + P + ' .' + NAVTITLE_CLASS + '{padding:10px 14px 0;font-size:15px}'
      + P + ' .' + NAVLIST_CLASS + '{flex-direction:row;gap:6px;overflow-x:auto;overflow-y:hidden;padding:8px 12px 10px;scrollbar-width:none}'
      + P + ' .' + NAVLIST_CLASS + '::-webkit-scrollbar{display:none}'
      /* 导航项：胶囊、定宽不收缩 ⇒ 放不下就横向滑，不折行也不挤压 */
      + P + ' .' + CELL_CLASS + '{flex:none;height:34px;padding:0 14px;gap:6px;border-radius:999px;font-size:13px}'
      + P + ' .' + CELL_CLASS + '[aria-current="true"]{background:var(--dsw-specific-sidebar-nav-item-active)}'
      + P + '>.' + CONTENT_CLASS + '{flex:1;min-height:0}'
      + P + ' .' + HEADER_CLASS + '{height:auto;align-items:center;padding:6px 12px 0}'
      /* 底部留厚一点：手持档 Web 会扩进小白条区（docs/130） */
      + P + ' .' + OPTIONS_CLASS + '{padding:0 12px 32px}';
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }
  /* 认面板结构：nav + 内容区各一个 ⇒ 两个都命中才挂 ready（见头注 fail-closed）。 */
  function tagPanel() {
    var panel = document.querySelector(PANEL_SEL);
    if (panel === null) { return; }
    addClass(panel, PANEL_CLASS);
    /* 面板的父就是官方那层覆盖层（portal 的直接父）：一并认出来，见 ensureStyle 里的钉法。 */
    addClass(panel.parentElement, OVERLAY_CLASS);
    var mask = panel.previousElementSibling;
    if (mask !== null && mask.getAttribute('aria-hidden') === 'true') { addClass(mask, MASK_CLASS); }
    var kids = panel.children;
    var hits = 0;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      var name = tagName(el);
      if (name === 'nav') {
        addClass(el, NAV_CLASS);
        var nk = el.children;
        for (var j = 0; j < nk.length; j++) {
          if (tagName(nk[j]) === 'div') { addClass(nk[j], j === 0 ? NAVTITLE_CLASS : NAVLIST_CLASS); }
        }
        var cells = el.querySelectorAll('button');
        for (var k = 0; k < cells.length; k++) { addClass(cells[k], CELL_CLASS); }
        hits = hits + 1;
      } else if (name === 'div') {
        addClass(el, CONTENT_CLASS);
        var ck = el.children;
        for (var m = 0; m < ck.length; m++) {
          if (tagName(ck[m]) === 'div') { addClass(ck[m], m === 0 ? HEADER_CLASS : OPTIONS_CLASS); }
        }
        hits = hits + 1;
      }
    }
    if (hits === 2) { addClass(panel, READY_CLASS); }
    else { log('面板结构不符（nav/内容区命中 ' + hits + ' 个）⇒ 本次不启用移动端布局'); }
  }
  function tick() {
    try {
      if (!compact()) { return; }
      ensureStyle();
      tagPanel();
    } catch (e) { /* 单拍失败不致命：下一拍重来 */ }
  }
  /* 验收用读数：'ready'（单屏横置已生效）| 'raw'（面板在但结构没认全）| 'none'（没打开）。 */
  globalThis.__DSHM_SETTINGS__ = {
    state: function () {
      var panel = document.querySelector(PANEL_SEL);
      if (panel === null) { return 'none'; }
      var cur = panel.getAttribute('class');
      return cur !== null && cur.indexOf(READY_CLASS) >= 0 ? 'ready' : 'raw';
    }
  };
  tick();
  /* 【方案 A】裸启动已由上面的失焦停摆块接管 ⇒ 删除避免双跑。 */
  log('shim installed');
})();`

/**
 * 「首次运行的设置引导」直板手机布局垫片（2026-10-16 用户报障；2026-10-22 收窄）。
 *
 * 【要解决什么】登录 DeepSeek 账号后的首次引导（`dsh-client-ui-settings-account` 的
 * DesktopOnboarding，四步：welcome → purpose → process → credit）是**桌面版式**：
 *   · 内容块 `position:absolute; top:50%; left:50%; transform:translate(-50%,-50%)`；
 *   · 欢迎页文案固定 520px 宽、插图固定 1247×822 且绝对定位在 `left:min(41.667vw+112.5px,712.5px)`；
 *   · 用途卡 2 列、流程卡 3 列（`repeat(2|3,minmax(0,1fr))`，卡内 padding 48.5/32.5px、最小高 222px）；
 *   · 主按钮 `position:absolute; top:100%; margin-top:100px`；credit 步是 594+400 两列。
 * 直板机竖屏（≈366 CSS px）下这些宽度全部溢出 ⇒ 用不了（用户原话"解决方案是横屏过来"）。
 * 上游最窄只做到 `@media (width<=1100px)`，**没有手机档**，只能由垫片补。
 *
 * 【为什么是"打标记 + 自己的 CSS"】与 SIDEBAR_SHIM_JS / SETTINGS_SHIM_JS 同一套路，
 * 且**一个哈希类名都不写** —— 只认官方 JSX 里的两个稳定锚点：
 *   ① `section[data-desktop-onboarding]`（步骤值是字面量 welcome|purpose|process|credit）；
 *   ② 覆盖层根下的 `[data-window-drag="true"]`（body portal 内那颗拖拽带，字面量）。
 * 结构对不上就不挂 ready，CSS 一条都不生效（fail-closed ⇒ 页面退回官方桌面版式）。
 *
 * 【只在直板手机启用】判据 `html.dshm-phone`。折叠屏、平板和桌面形态调试环境不改官方引导版式。
 *
 * 【验收读数】`globalThis.__DSHM_ONB__.state()` ⇒ 'none'（没开着）| 'raw'（开着但结构没认全）
 * | 'ready:<step>'（移动端布局已生效，step = 当前引导步骤）。
 */
const ONBOARDING_SHIM_JS: string = `(function () {
  if (globalThis.__DSHM_ONB__) { return; }
  /* 直板手机开关（SIDEBAR_SHIM_JS 挂上）：折叠屏与平板都不挂。 */
  var PHONE_CLASS = 'dshm-phone';
  var HANDHELD_CLASS = 'dshm-handheld';
  var FOLDABLE_CLASS = 'dshm-form-foldable';
  /* 官方 JSX 字符串字面量：步骤 section 与它自带的拖拽带（压缩不改名）。 */
  var PAGE_SEL = 'section[data-desktop-onboarding]';
  var DRAG_SEL = '[data-window-drag="true"]';
  var ROOT_CLASS = 'dshm-onb-root';
  var STAGE_CLASS = 'dshm-onb-stage';
  var PAGE_CLASS = 'dshm-onb-page';
  var CONTENT_CLASS = 'dshm-onb-content';
  var READY_CLASS = 'dshm-onb-ready';
  var STYLE_ID = 'dshm-onboarding-style';
  var TICK_MS = 300;
  /* 【失焦停摆（2026-10-29，方案 A，与 entry 同步）】hidden 停摆、visible 恢复并当拍补跑。 */
  var onbTickTimer = setInterval(tick, TICK_MS);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      if (onbTickTimer !== 0) { clearInterval(onbTickTimer); onbTickTimer = 0; }
      return;
    }
    if (onbTickTimer === 0) { onbTickTimer = setInterval(tick, TICK_MS); }
    tick();
  });
  var lastStep = '';
  function log(msg) {
    try { console.info('[dshm-onb] ' + msg); } catch (e) { /* 无 console：忽略 */ }
  }
  function addClass(el, cls) {
    if (el === null || el === undefined) { return; }
    var cur = el.getAttribute('class');
    if (cur === null) { cur = ''; }
    if (cur.indexOf(cls) >= 0) { return; }
    el.setAttribute('class', cur === '' ? cls : cur + ' ' + cls);
  }
  function tagName(el) {
    return el.tagName === null || el.tagName === undefined ? '' : el.tagName.toLowerCase();
  }
  function phone() {
    var cur = document.documentElement.getAttribute('class');
    if (cur === null) { return false; }
    if (cur.indexOf(PHONE_CLASS) >= 0) { return true; }
    /* 预览窗口底层可能是桌面形态；窄而高且非折叠屏时按直板机引导处理。 */
    var w = Math.round(window.innerWidth || 0);
    var h = Math.round(window.innerHeight || 0);
    return cur.indexOf(HANDHELD_CLASS) >= 0 && cur.indexOf(FOLDABLE_CLASS) < 0
      && w > 0 && w < 600 && h > w * 1.35;
  }
  /* 移动端布局：只注入一次。所有规则都以 .dshm-onb-page.dshm-onb-ready 起头 ⇒
     结构没认全（没挂 ready）时整套规则一条都不生效。 */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID) !== null || document.head === null) { return; }
    var P = 'html.' + PHONE_CLASS + ' .' + PAGE_CLASS + '.' + READY_CLASS;
    /* box-sizing:border-box 必须写：官方 .page 是 width:100%，而 padding 落在 content-box 上
       会把整页右溢 2×18px（2026-10-16 真机首跑实测：文案与按钮右边被切掉 18px）。 */
    var css = P + '{box-sizing:border-box;height:auto;min-height:100%;overflow:visible;padding:18px 18px calc(32px + env(safe-area-inset-bottom,0px))}'
      /* 覆盖层顶部让出状态栏（手持档是沉浸式，overlay 钉在 inset:0）。 */
      + 'html.' + PHONE_CLASS + ' .' + ROOT_CLASS + '{padding-top:env(safe-area-inset-top,0px)}'
      /* stage 原本是 flex + justify-content:center + overflow:auto —— 居中配溢出会把顶部
         内容顶出可视区（滚不到）⇒ 改成"顶部对齐 + 纵向滚动"。 */
      + 'html.' + PHONE_CLASS + ' .' + STAGE_CLASS + '{display:block;overflow-y:auto;overflow-x:hidden}'
      /* 内容块：绝对居中 → 常态流式铺满（四步共用同一个 .content 包裹层）。 */
      + P + ' .' + CONTENT_CLASS + '{position:static;top:auto;left:auto;transform:none;width:100%;max-width:none;display:flex;flex-direction:column;gap:16px}'
      /* 文案块（非插图子树）：去掉 520px 固定宽与绝对定位。 */
      + P + ' .' + CONTENT_CLASS + '>div:not([aria-hidden="true"]){position:static;top:auto;left:auto;transform:none;width:100%;max-width:none;text-align:left}'
      /* 插图：从"1247px / 1331px 两层绝对定位大图"改成"置顶、按容器宽度缩放"。
         只认"内容块的第一层 + 它内嵌的插图壳"两层（官方 OnboardingIllustration 的固定结构），
         刻意不用宽泛的 [aria-hidden] —— 卡片的图标条也挂 aria-hidden，别误伤。 */
      + P + ' .' + CONTENT_CLASS + '>div[aria-hidden="true"],'
      + P + ' .' + CONTENT_CLASS + '>div[aria-hidden="true"]>div[aria-hidden="true"]{position:static;top:auto;left:auto;width:100%;height:auto;max-width:none;order:-1}'
      + P + ' .' + CONTENT_CLASS + '>div[aria-hidden="true"] img{position:static;top:auto;left:auto;width:100%;max-width:100%;height:auto;margin:0 auto;display:block}'
      /* 卡片格：用途 2 列 / 流程 3 列 → 一律单列（选中的是 div.card，流程是 button[role=radio]）。 */
      + P + ' .' + CONTENT_CLASS + '>div:has(>div+div),'
      + P + ' .' + CONTENT_CLASS + '>[role="radiogroup"]{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;min-height:0}'
      + P + ' .' + CONTENT_CLASS + '>div:has(>div+div)>div,'
      + P + ' .' + CONTENT_CLASS + '>[role="radiogroup"]>button{min-height:0;padding:16px;border-radius:16px}'
      /* 主按钮：从"绝对定位挂在内容下方 100px"回到正常流（welcome 的 CTA 也一并收成整行）。 */
      + P + '[data-desktop-onboarding="purpose"] .' + CONTENT_CLASS + '>div:has(>button),'
      + P + '[data-desktop-onboarding="process"] .' + CONTENT_CLASS + '>div:has(>button){position:static;margin-top:24px;width:100%}'
      + P + ' .' + CONTENT_CLASS + ' button{max-width:none}'
      + P + ' .' + CONTENT_CLASS + '>div>button{width:100%;margin-top:24px}'
      /* credit 的"去充值 / 下一步"：横排 → 竖排整行。 */
      + P + ' .' + CONTENT_CLASS + '>div>div:has(>button+button){flex-direction:column;gap:12px;margin-top:24px}'
      + P + ' .' + CONTENT_CLASS + '>div>div:has(>button+button)>button{width:100%}'
      /* 字号：桌面 28/16 → 手机 22/14（行高同步收）。 */
      + P + ' h1{font-size:22px;line-height:32px}'
      + P + ' h2{font-size:16px;line-height:24px}'
      + P + ' p{margin-top:12px;font-size:14px;line-height:22px}'
      + P + ' .' + CONTENT_CLASS + '>div:has(>div+div)>div p,'
      + P + ' .' + CONTENT_CLASS + '>[role="radiogroup"]>button p{margin-top:8px;font-size:13px;line-height:20px}'
      /* 底部导航（<footer>，第二步起才有：上一步 / 跳过）与保存失败提示：跟着内容走，不再钉死绝对定位。 */
      + P + ' footer{position:static;transform:none;width:100%;margin-top:24px;padding-top:16px;border-top:.5px solid var(--dsw-alias-border-l3);justify-content:space-between}'
      + P + ' [role="alert"]{position:static;transform:none;margin-top:16px;left:auto;bottom:auto}';
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }
  /* 认引导结构：只认「body portal > 拖拽带 + stage > section」这一形态；
     stage / 内容块有一个认不出就只挂 raw、不挂 ready（见头注 fail-closed）。 */
  function tag() {
    var page = document.querySelector(PAGE_SEL);
    if (page === null) { return; }
    var step = page.getAttribute('data-desktop-onboarding');
    var stage = page.parentElement;
    var root = stage === null ? null : stage.parentElement;
    if (root === null || root === undefined || root.parentElement !== document.body) {
      log('结构不符：引导 section 不在 body portal 里 ⇒ 本次不改版式');
      return;
    }
    if (root.querySelectorAll(':scope > ' + DRAG_SEL).length !== 1) {
      log('结构不符：覆盖层里认不出拖拽带 ⇒ 本次不改版式');
      return;
    }
    var content = null;
    var kids = page.children;
    for (var i = 0; i < kids.length; i += 1) {
      if (tagName(kids[i]) === 'div') { content = kids[i]; break; }
    }
    if (content === null) {
      log('结构不符：引导页里没有内容块 ⇒ 本次不改版式');
      return;
    }
    addClass(root, ROOT_CLASS);
    addClass(stage, STAGE_CLASS);
    addClass(page, PAGE_CLASS);
    addClass(content, CONTENT_CLASS);
    addClass(page, READY_CLASS);
    if (step !== lastStep) {
      lastStep = step;
      log('直板机引导布局已生效（step=' + step + '）');
    }
  }
  function tick() {
    try {
      if (!phone()) { return; }
      ensureStyle();
      tag();
    } catch (e) { /* 单拍失败不致命：下一拍重来 */ }
  }
  globalThis.__DSHM_ONB__ = {
    state: function () {
      var page = document.querySelector(PAGE_SEL);
      if (page === null) { return 'none'; }
      var cur = page.getAttribute('class');
      var ready = cur !== null && cur.indexOf(READY_CLASS) >= 0;
      var step = page.getAttribute('data-desktop-onboarding');
      return ready ? 'ready:' + step : 'raw';
    }
  };
  tick();
  /* 【方案 A】裸启动已由上面的失焦停摆块接管 ⇒ 删除避免双跑。 */
  log('shim installed');
})();`

/**
 * 【已停用（2026-11-12，用户口径：界面跟随 dsh 官方设置）】
 *
 * 这里原本是"手持档市场列表强制 2/3/4 列"的垫片：它把 dshmarket 的
 * `matchMedia('(min-width:681px)')` 闸恒置真，并把自己写的窄屏 `@media` 规则
 * 按元素宽度改写成 `repeat(N, minmax(0,1fr))`。
 *
 * 真机后果（手机 / 360vp）：插件市场被强制排成 2 列，每列只剩 ~180px，
 * 「插件」页与市场内容整体被压成细长一条，且从侧栏进入时「左右缩小」明显；
 * 同一入口从「设置」进入时容器更宽反而正常 —— 正是列数按宽度分档造成的割裂。
 *
 * 现在一律交还 dsh 官方响应式布局（窄屏单列），本仓不再改写任何市场列数。
 * 保留此说明便于回溯；若要恢复，需先给出"官方布局在窄屏确实不可用"的证据。
 */

/**
 * 手持档视口回正脚本（2026-10-18，分屏旋转右侧空白）。
 *
 * 真机现场：窗口已恢复 460vp，但内容仍停在横屏分屏时的 313.5vp，右侧 146.5vp 为白。
 * 原生 Web 组件本身按 100% 布局，故最后一层兜底放在页面：
 *   · 把 html/body 的宽度重新锚到 100%；
 *   · 把 `dshm-frame` 的宽度从上游可能残留的像素值拉回当前视口；
 *   · 主动补发 resize / visualViewport.resize，让上游布局订阅者重算。
 * 只在 `dshm-handheld` 下执行，桌面形态 返回 off。
 */
/**
 * AI 生成内容标识（2026-11-10，与 entry 同源）。
 *
 * 上架要求：模型生成内容必须由**呈现层**明确披露来源，不能让模型自己写进正文，
 * 也不写进消息报文/模型上下文。
 *
 * 位置按用户 2026-11-11 最终裁决：**直接嵌进官方会话输入座位**（`composerSeat`），
 * 绝对定位到卡片工具栏那一带的空白。座位只由会话页渲染 ⇒ 切到设置 / 插件 / 文件预览
 * 时它整个卸载，标识跟着消失，不存在"标识跑到其他页面"的问题。详见 entry 侧同段说明。
 */
/**
 * 会话输入框「钉底」修正（2026-11-12，用户平板复现：输入框跟着消息一起滚出屏幕）。
 *
 * 用户实测 sticky 覆盖有效；具体滚动容器与合成条件仍需真机确认，不泛化为内核根因。
 * 仅对可见、所属容器内有可见会话滚动区的主会话座位应用钉底规则；
 * 排除右栏、dialog、global-panel、hero 等其它页面，离开条件即移除类。
 * documentStart 时 head 可能为空，因此每拍幂等补挂样式，不改官方其它布局。
 */
const COMPOSER_PIN_SHIM_JS: string = `(function () {
  if (globalThis.__DSHM_COMPOSER_PIN__) { return; }
  globalThis.__DSHM_COMPOSER_PIN__ = true;
  var STYLE_ID = 'dshm-composer-pin-style';
  var PIN_CLASS = 'dshm-seat-pin';
  var TICK_MS = 500;
  var timer = 0;
  var logged = false;
  function log(msg) {
    try { console.info('[dshm-composer-pin] ' + msg); } catch (e) { /* 无 console：忽略 */ }
  }
  function ensureStyle() {
    if (document.getElementById(STYLE_ID) !== null || document.head === null) { return; }
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = '.' + PIN_CLASS + '{position:sticky !important;bottom:0 !important;'
      + 'top:auto !important;left:auto !important;right:auto !important;'
      + 'will-change:auto !important}';
    document.head.appendChild(style);
  }
  function visible(el) {
    if (!el) { return false; }
    var r = el.getBoundingClientRect();
    var cs = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.display !== 'none'
      && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }
  function mainConversationSeat(el) {
    try {
      if (!visible(el)) { return false; }
      if (el.closest('[data-rightbar-col],[data-global-panel],[data-shell-overlay],[data-sidebar-mask],[role="dialog"],[class*="composerHero"]') !== null) { return false; }
      /* 不从 document 借用其它会话：只认座位直属容器内的正文滚动区。 */
      var parent = el.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) { return false; }
      var scrolls = parent.getAttribute('data-conversation-scroll') !== null
        ? [parent] : parent.querySelectorAll('[data-conversation-scroll]');
      for (var n = 0; n < scrolls.length; n++) {
        if (visible(scrolls[n]) && scrolls[n].closest('[data-rightbar-col],[data-global-panel],[role="dialog"]') === null) { return true; }
      }
    } catch (e) { /* 未识别的结构保留官方布局。 */ }
    return false;
  }
  function tick() {
    ensureStyle();
    var list = document.querySelectorAll('[data-composer-seat]');
    var pinned = 0;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var want = mainConversationSeat(el);
      try {
        if (want) {
          el.classList.add(PIN_CLASS);
          pinned += 1;
        } else {
          el.classList.remove(PIN_CLASS);
        }
      } catch (e) { /* 单节点失败不影响其余 */ }
    }
    if (pinned > 0 && !logged) {
      logged = true;
      log('pinned seats=' + pinned);
    }
  }
  ensureStyle();
  timer = setInterval(tick, TICK_MS);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      if (timer !== 0) { clearInterval(timer); timer = 0; }
      return;
    }
    if (timer === 0) { timer = setInterval(tick, TICK_MS); }
    tick();
  });
  tick();
  log('installed');
})();`

const AI_DISCLOSURE_SHIM_JS: string = `(function () {
  if (globalThis.__DSHM_AI_DISCLOSURE__) { return; }
  var ID = 'dshm-ai-disclosure';
  var TEXT = '（内容由AI生成）';
  var TICK_MS = 1000;
  var nodes = new Map();
  var sheet = null;
  var timer = 0;
  var pending = 0;
  var observer = null;
  var stopped = false;
  function log(msg) {
    try { console.info('[dshm-ai] ' + msg); } catch (e) { /* 无 console：忽略 */ }
  }
  function ensure(key) {
    var found = nodes.get(key);
    if (found) { return found; }
    found = document.createElement('span');
    found.id = ID + '-' + encodeURIComponent(key);
    found.setAttribute('data-dshm-ai-disclosure', key);
    found.setAttribute('role', 'note');
    found.setAttribute('aria-label', TEXT);
    found.style.cssText = 'display:block;flex:none;font-size:11px;line-height:16px;opacity:0.62;margin-top:-12px;pointer-events:none;user-select:none';
    nodes.set(key, found);
    return found;
  }
  function inSidePanel(el) {
    var p = el;
    while (p !== null && p !== undefined && p !== document.body) {
      try {
        if (p.getAttribute('data-rightbar-col') !== null) { return true; }
        if (p.getAttribute('data-global-panel') !== null) { return true; }
        if (p.getAttribute('data-shell-overlay') !== null) { return true; }
        if (p.getAttribute('data-sidebar-mask') !== null) { return true; }
        if (p.getAttribute('role') === 'dialog') { return true; }
      } catch (e) { /* 非元素节点：忽略 */ }
      p = p.parentElement;
    }
    return false;
  }
  function inConversationBody(el) {
    var content = el;
    if (content === null) { return false; }
    var session = content.getAttribute('data-conversation-session');
    if (session === null || session.trim() === '') { return false; }
    var root = content.parentElement;
    var phase = content.getAttribute('data-content-phase');
    if (root === null || phase !== 'active') { return false; }
    if (root.getAttribute('data-phase') !== phase) { return false; }
    if (root.closest('[data-conversation-content]') !== null) { return false; }
    var header = root.firstElementChild;
    if (header === null || header.tagName !== 'DIV' || header.getAttribute('data-slot') !== 'conversation.header' || header.nextElementSibling !== content) { return false; }
    header = header.firstElementChild;
    if (header === null || header.tagName !== 'HEADER' || header.nextElementSibling !== null) { return false; }
    if (header.querySelector('[data-conversation-header-leading]') === null) { return false; }
    var conversationSlot = root.parentElement;
    if (conversationSlot === null || conversationSlot.tagName !== 'DIV' || conversationSlot.getAttribute('data-slot') !== 'main.conversation' || conversationSlot.firstElementChild !== root || root.nextElementSibling !== null) { return false; }
    var mainSlot = conversationSlot.parentElement;
    if (mainSlot === null || mainSlot.tagName !== 'DIV' || mainSlot.getAttribute('data-slot') !== 'main' || mainSlot.firstElementChild !== conversationSlot || conversationSlot.nextElementSibling !== null) { return false; }
    var panel = mainSlot.parentElement;
    var center = panel === null ? null : panel.parentElement;
    var rightbar = center === null ? null : center.nextElementSibling;
    if (panel === null || panel.firstElementChild !== mainSlot || mainSlot.nextElementSibling !== null) { return false; }
    if (center === null || center.firstElementChild !== panel || panel.nextElementSibling !== null) { return false; }
    if (rightbar === null || !rightbar.matches('[data-rightbar-col]')) { return false; }
    return true;
  }
  function visible(el) {
    if (!el.isConnected) { return false; }
    for (var p = el; p !== null; p = p.parentElement) {
      if (p.hasAttribute('hidden') || p.hasAttribute('inert') || p.getAttribute('aria-hidden') === 'true') { return false; }
      var cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.opacity === '0') { return false; }
    }
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function mainHost() {
    var list = document.querySelectorAll('[data-conversation-content]');
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (inSidePanel(el)) { continue; }
      if (!inConversationBody(el)) { continue; }
      if (!visible(el)) { continue; }
      if (best !== null) { return null; }
      best = el;
    }
    return best;
  }
  function detach(el) {
    if (el.parentNode !== null) { el.parentNode.removeChild(el); }
  }
  function suppressed() {
    var root = document.documentElement;
    if (root === null) { return true; }
    if (root.getAttribute('data-dshm-panel') === 'open') { return true; }
    var list = document.querySelectorAll('[role="dialog"],[aria-modal="true"],[data-shortcut-modal],[data-global-panel]');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (visible(el)) { return true; }
    }
    return false;
  }
  function place() {
    var host = suppressed() ? null : mainHost();
    var wanted = new Map();
    if (host !== null) {
      var tails = host.querySelectorAll('[data-turn-tail]');
      var session = host.getAttribute('data-conversation-session');
      for (var i = 0; i < tails.length; i++) {
        var tail = tails[i];
        var row = tail.closest('[data-chat-node-key]');
        var flow = tail.closest('[data-chat-flow]');
        var scroll = tail.closest('[data-conversation-scroll]');
        var turn = tail.getAttribute('data-turn-tail');
        if (!row || !flow || !scroll || !turn || !row.getAttribute('data-chat-node-key')) { continue; }
        if (tail.getAttribute('data-actions-reveal') === null || row.getAttribute('data-chat-flow-kind') !== 'turn-tail') { continue; }
        if (row.getAttribute('data-chat-turn') !== turn || row.closest('[data-chat-flow]') !== flow) { continue; }
        if (tail.closest('[data-conversation-content]') !== host || scroll.closest('[data-conversation-content]') !== host) { continue; }
        if (inSidePanel(tail) || !visible(tail)) { continue; }
        var key = JSON.stringify([session, turn]);
        if (wanted.has(key)) { wanted.set(key, null); } else { wanted.set(key, tail); }
      }
    }
    nodes.forEach(function (el, key) {
      if (!wanted.get(key)) { detach(el); nodes.delete(key); }
    });
    wanted.forEach(function (tail, key) {
      if (tail === null) { return; }
      var el = ensure(key);
      if (el.parentNode !== tail || el.nextElementSibling !== null) { tail.appendChild(el); }
    });
    if (nodes.size && (sheet === null || !sheet.isConnected)) {
      sheet = document.createElement('style');
      sheet.textContent = '[data-dshm-ai-disclosure]::after{content:"' + TEXT + '"}';
      document.documentElement.appendChild(sheet);
    }
    if (!nodes.size && sheet !== null) { detach(sheet); sheet = null; }
  }
  function tick() {
    if (stopped || document.visibilityState === 'hidden') { return; }
    if (observer !== null) { observer.disconnect(); }
    try { place(); } catch (e) { nodes.forEach(detach); nodes.clear(); }
    if (observer !== null && document.documentElement !== null) {
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['data-conversation-session', 'data-content-phase', 'data-phase', 'data-conversation-content',
          'data-conversation-scroll', 'data-composer-seat', 'data-conversation-header-leading', 'data-rightbar-col',
          'data-slot', 'data-global-panel', 'data-shell-overlay', 'data-sidebar-mask', 'data-dshm-panel', 'role',
          'data-turn-tail', 'data-chat-node-key', 'data-chat-flow-kind', 'data-chat-turn', 'data-actions-reveal',
          'aria-modal', 'data-shortcut-modal', 'hidden', 'inert', 'aria-hidden', 'class', 'style'] });
    }
  }
  function schedule() {
    if (stopped || document.visibilityState === 'hidden' || pending !== 0) { return; }
    pending = setTimeout(function () { pending = 0; tick(); }, 0);
  }
  function pause() {
    if (observer !== null) { observer.disconnect(); }
    if (timer !== 0) { clearInterval(timer); timer = 0; }
    if (pending !== 0) { clearTimeout(pending); pending = 0; }
    nodes.forEach(detach); nodes.clear();
    if (sheet !== null) { detach(sheet); sheet = null; }
  }
  function resume() {
    if (stopped || document.visibilityState === 'hidden') { return; }
    if (observer === null) { observer = new MutationObserver(schedule); }
    if (timer === 0) { timer = setInterval(schedule, TICK_MS); }
    tick();
  }
  function visibility() {
    if (document.visibilityState === 'hidden') { pause(); } else { resume(); }
  }
  function unload() {
    stopped = true;
    pause();
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('pagehide', pause);
    window.removeEventListener('pageshow', resume);
    window.removeEventListener('unload', unload);
  }
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('resize', schedule);
  window.addEventListener('pagehide', pause);
  window.addEventListener('pageshow', resume);
  window.addEventListener('unload', unload);
  resume();
  globalThis.__DSHM_AI_DISCLOSURE__ = { refresh: tick };
  log('installed');
})();`

const VIEWPORT_RECONCILE_SCRIPT: string = `(function () {
  try {
    var root = document.documentElement;
    var cls = root === null ? '' : (root.getAttribute('class') || '');
    if (cls.indexOf('dshm-handheld') < 0) { return 'off'; }
    var body = document.body;
    var vw = Math.round((root && root.clientWidth) || window.innerWidth || 0);
    var vh = Math.round((root && root.clientHeight) || window.innerHeight || 0);
    if (root !== null) {
      root.style.width = '100%';
      root.style.maxWidth = '100%';
    }
    if (body !== null && body !== undefined) {
      body.style.width = '100%';
      body.style.maxWidth = '100%';
      body.style.overflowX = 'hidden';
    }
    var frame = document.querySelector('.dshm-frame');
    var before = -1;
    if (frame !== null) {
      try { before = Math.round(frame.getBoundingClientRect().width); } catch (e) { before = -1; }
      frame.style.width = '100%';
      frame.style.maxWidth = '100%';
      frame.style.minWidth = '0';
    }
    try { window.dispatchEvent(new Event('resize')); } catch (e) { /* 无 Event：忽略 */ }
    if (window.visualViewport) {
      try { window.visualViewport.dispatchEvent(new Event('resize')); } catch (e) { /* 忽略 */ }
    }
    var after = frame === null ? -1 : Math.round(frame.getBoundingClientRect().width);
    return 'vw=' + vw + ' vh=' + vh + ' frame=' + before + '->' + after;
  } catch (e) {
    return 'err:' + (e && e.message ? e.message : String(e));
  }
})();`;

/** 软键盘状态标记：终端注入层据此暂停 ResizeObserver → fit → PTY SIGWINCH 链。 */
const KEYBOARD_OPEN_SCRIPT: string =
  "(function(){document.documentElement.classList.add('dshm-keyboard-open');return 'keyboard-open';})();";
const KEYBOARD_CLOSE_SCRIPT: string =
  "(function(){document.documentElement.classList.remove('dshm-keyboard-open');return 'keyboard-closed';})();";

/**
 * 手持档「系统返回」的消费垫片（2026-10-10 用户报障）。
 *
 * 【要解决的事】手机 / 平板从屏幕左 / 右边缘划一下（= 系统返回）**直接回到桌面**。
 * 根因是"没有人消费这记返回"：官方 web 前端是纯 SPA 且**从不碰 history**
 * （全仓 grep：pushState 0 处、replaceState 0 处）⇒ Web 自己的后退栈恒空
 * ⇒ WebApp.onBackPress() 里的 controller.accessBackward() 恒假 ⇒ 返回落到系统默认
 * （把应用最小化回桌面）。也就是说：**开着设置面板 / 市场 / 抽屉时划返回，也一样直接退出。**
 *
 * 【修法】把"这一记返回该关掉什么"交给网页回答（原生侧见 WebApp.consumeWebBack()）：
 *   ① 顶层浮层 —— 官方与插件都用 react-aria 的 Overlay 栈，落点属性各不同
 *      （设置面板 data-shortcut-modal，菜单 / 对话框 role=menu|dialog）。关它走
 *      **官方自己的关法**：朝浮层内的自动聚焦点派发一个 Escape —— react-aria 在
 *      document 上听 Escape 并调顶层 close()，与真人按 Esc 等价，也不用猜关闭按钮长什么样。
 *   ② 移动端抽屉（SIDEBAR_SHIM_JS 的 expanded）—— 直接 toggle 收起。
 *
 * 【为什么由网页回答而不是原生猜】"现在有没有可关的浮层"只有 DOM 知道；原生只能靠镜像
 * 状态，而镜像必然滞后于"刚点开又立刻划返回"这种时序。
 *
 * 每次消费往 files/diag-web-console 写一行 [dshm-back] consume: …。
 */
/**
 * 桌面快捷方式 →「新建会话」注入脚本（docs/172 §5.2）。
 *
 * 【通道】`shortcuts_config.json` 的 `dshAction=new-session` → EntryAbility 发布
 * `dshLaunchAction` → 本页 `applyLaunchAction()` 消费 → 这里注入 Web 层执行。
 *
 * 【为什么是 DOM 点击】前端侧栏（`dsh-client-ui-sidebar`）的「新建会话」按钮锚点是官方
 * i18n 文案（`aria-label = t("session.new.label")`：中文「新建会话」/ 英文「New session」），
 * 这是跨版本稳定的官方面；类名是构建期哈希（`hHd-Xa_…`）不可用。前端确有 `session.new`
 * 快捷键且其 keydown 处理不检查 `isTrusted`（合成事件可用），但其默认绑定取决于用户目录
 * ⇒ 点击按钮的语义更直白、不依赖绑定存在。
 *
 * 【fail-closed】找不到按钮返回 'button-not-found'（不猜、不误点）；异常吞进返回值，
 * 绝不把 Web 层异常抛回原生。
 */
const NEW_SESSION_SCRIPT: string = `(function () {
  try {
    var labels = ['新建会话', 'New session'];
    var buttons = document.querySelectorAll('button[aria-label]');
    for (var i = 0; i < buttons.length; i++) {
      var label = buttons[i].getAttribute('aria-label') || '';
      if (labels.indexOf(label) >= 0) {
        buttons[i].click();
        return 'clicked:' + label;
      }
    }
    return 'button-not-found';
  } catch (e) {
    return 'error:' + (e && e.message ? e.message : String(e));
  }
})()`;
/**
 * 卡片点击 →「直达当前会话」注入脚本（docs/178 第三轮增强）。
 *
 * 【判据】优先用 `[data-session-id]`（若前端暴露）；否则在侧栏/导航的可点击项里找
 * **标题逐字相等**且可见的元素。找不到返回 `session-not-found`（fail-closed，不乱点）。
 * 标题/ID 由卡片通过 router want 传入（`dshAction=open-session`）。
 */
function buildOpenSessionScript(title: string, sessionId: string): string {
  return `(function () {
  try {
    var wantTitle = ${JSON.stringify(title)};
    var wantId = ${JSON.stringify(sessionId)};
    var handheld = document.documentElement.getAttribute('class')?.indexOf('dshm-handheld') >= 0;
    function log(m) {
      try { console.info('[dshm-open-session] ' + m); } catch (e) { /* 诊断不阻断 */ }
    }
    function visible(el) {
      if (!el || el.getClientRects().length === 0) { return false; }
      var cs = window.getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
    }
    function sidebar() { return globalThis.__DSHM_SIDEBAR__; }
    function closeDrawer() {
      var sb = sidebar();
      if (handheld && sb && typeof sb.state === 'function' && sb.state() === 'expanded') {
        setTimeout(function () { sb.toggle(); }, 350);
      }
    }
    function clickRow(row) {
      try {
        row.click();
        closeDrawer();
        return true;
      } catch (e) {
        return false;
      }
    }
    function rowById() {
      if (wantId.length === 0) { return null; }
      var key = 'session:' + wantId;
      var rows = document.querySelectorAll('[data-row-key]');
      for (var i = 0; i < rows.length; i++) {
        var actual = String(rows[i].getAttribute('data-row-key') || '');
        if ((actual === key || actual.indexOf(wantId) >= 0) && visible(rows[i])) { return rows[i]; }
      }
      return null;
    }
    function rowsByTitle() {
      var out = [];
      if (wantTitle.length === 0) { return out; }
      var rows = document.querySelectorAll('[data-row-key^="session:"]');
      for (var i = 0; i < rows.length; i++) {
        var t = (rows[i].getAttribute('aria-label') || rows[i].textContent || '').trim();
        if (t.indexOf(wantTitle) >= 0 && visible(rows[i])) { out.push(rows[i]); }
      }
      if (out.length === 0) {
        var all = document.querySelectorAll('[role="treeitem"]');
        for (var j = 0; j < all.length; j++) {
          var tt = (all[j].getAttribute('aria-label') || all[j].textContent || '').trim();
          if (tt.indexOf(wantTitle) >= 0 && visible(all[j])) { out.push(all[j]); }
        }
      }
      return out;
    }
    var exact = rowById();
    log('initial rowByKey=' + (exact === null ? 'none' : String(exact.getAttribute('data-row-key'))));
    if (exact !== null && clickRow(exact)) { return 'clicked-row-key'; }
    var byTitle = rowsByTitle();
    log('initial byTitle=' + byTitle.length);
    if (byTitle.length > 0 && clickRow(byTitle[0])) { return 'clicked-title'; }
    var sb = sidebar();
    if (handheld && sb && typeof sb.toggle === 'function'
      && typeof sb.state === 'function' && sb.state() !== 'expanded') {
      sb.toggle();
      var tries = 0;
      (function retry() {
        var row = rowById();
        log('retry ' + tries + ' rowByKey=' + (row === null ? 'none' : String(row.getAttribute('data-row-key'))));
        if (row === null) {
          var titleRows = rowsByTitle();
          log('retry ' + tries + ' byTitle=' + titleRows.length);
          row = titleRows.length > 0 ? titleRows[0] : null;
        }
        if (row !== null) {
          log('retry click=' + clickRow(row));
          return;
        }
        tries += 1;
        if (tries < 20) { setTimeout(retry, 150); }
      })();
      return 'opening-drawer';
    }
    if (wantId.length > 0) {
      var byId = document.querySelectorAll('[data-session-id]');
      for (var i = 0; i < byId.length; i++) {
        if (byId[i].getAttribute('data-session-id') === wantId && visible(byId[i])
          && clickRow(byId[i])) { return 'clicked-id'; }
      }
    }
    return 'session-not-found';
  } catch (e) {
    return 'error:' + (e && e.message ? e.message : String(e));
  }
})()`;
}
const BACK_SHIM_JS: string = `(function () {
  if (globalThis.__DSHM_BACK__) { return; }
  /* 可见浮层的落点：官方设置面板 + react-aria 的 dialog / menu / listbox。 */
  var OVERLAY_SEL = '[data-shortcut-modal],[role="dialog"],[role="menu"],[role="listbox"]';
  /* 右侧栏（文件预览 / 终端 / 浏览器）的稳定属性（dsh-client-ui-sidebar-right 源码）：
     展开态才有 data-sidebar-right-open，关闭态移除并给 aria-hidden=true。
     【2026-10-18 用户复报】右侧栏开着时右缘内划直接回桌面 —— 它既不是 OVERLAY_SEL 里的
     dialog，也不进 Web 历史，更不是左侧抽屉 ⇒ 旧分支全不认，返回只能落到"最小化回桌面"。 */
  var RIGHT_OPEN_SEL = '[data-sidebar-right-open]';
  /* Escape 之后多久回查"顶层浮层是否换人"（官方关面板是同步卸载，够用且不拖慢手感）。 */
  var VERIFY_MS = 320;
  function log(msg) {
    try { console.info('[dshm-back] ' + msg); } catch (e) { /* 无 console：忽略 */ }
  }
  function handheld() {
    try {
      var br = globalThis.__DSHM_BRIDGES__;
      /* Back follows hardware, not floating-window desktop styling. */
      if (br && typeof br.platformHandheld === 'function') { return br.platformHandheld() === true; }
      if (br && typeof br.platformForm === 'function') {
        var form = br.platformForm();
        if (form === 'desktop') { return false; }
        if (form === 'phone' || form === 'tablet' || form === 'foldable') { return true; }
      }
    } catch (e) { log('handheld bridge failed: ' + e); }
    var classes = document.documentElement.classList;
    return classes.contains('dshm-form-foldable') && !classes.contains('dshm-pc');
  }
  /* 可见 = 真有布局盒子、且没被 display / visibility / opacity 藏掉。
     关掉的浮层官方直接卸载，但插件可能留一个 display:none 的壳，所以必须真判。 */
  function visible(el) {
    if (el.getClientRects().length === 0) { return false; }
    var cs = window.getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }
  /* 顶层浮层 = DOM 里最后一个可见的那层（后开的在后面，与 react-aria 认顶层同序）。 */
  function topOverlay() {
    var list = document.querySelectorAll(OVERLAY_SEL);
    var found = null;
    for (var i = 0; i < list.length; i++) {
      if (visible(list[i]) && list[i].getAttribute('data-shortcut-modal') !== 'sidebar') { found = list[i]; }
    }
    return found;
  }
  /* 可见浮层个数（诊断用：和 describe 一起回答"到底有几层、顶层是谁"）。 */
  function countOverlays() {
    var list = document.querySelectorAll(OVERLAY_SEL);
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      if (visible(list[i])) { n = n + 1; }
    }
    return n;
  }
  /* 浮层身份（诊断用）：标签 + 官方的稳定属性 + 类名首段。
     没有它就只能看到"consume: overlay"这种无从追问的行。 */
  function describe(el) {
    if (el === null) { return 'none'; }
    var tag = el.tagName === null || el.tagName === undefined ? '?' : el.tagName.toLowerCase();
    var mark = el.getAttribute('data-shortcut-modal');
    if (mark !== null) { tag = tag + '[shortcut=' + mark + ']'; }
    var role = el.getAttribute('role');
    if (role !== null) { tag = tag + '[role=' + role + ']'; }
    var cls = el.getAttribute('class');
    if (cls !== null && cls.length > 0) { tag = tag + '.' + cls.split(' ')[0].slice(0, 28); }
    return tag;
  }
  function sidebar() { return globalThis.__DSHM_SIDEBAR__; }
  function drawerOpen() {
    var sb = sidebar();
    return sb !== undefined && sb !== null && typeof sb.state === 'function'
      && sb.state() === 'expanded';
  }
  /*
   * 面板内部的「返回上一层」（2026-10-16 用户报"进插件二级页后侧滑直接回桌面"）。
   *
   * 【为什么认文案】web 客户端的插件管理器二级页用一颗带「返回插件」/「Back to plugins」
   * 文案的按钮回到列表（dsh-client-ui-plugin-manager 的 backToList）—— 它既是可点的
   * 真实按钮，又是**跨版本稳定**的锚点；而面板整体不进 Web 历史（accessBackward() 为假），
   * 也不在 OVERLAY_SEL 里 ⇒ 没有这条分支时，返回只能落到"最小化回桌面"。
   * 【为什么排在浮层之前】二级页本身就在设置面板这个 modal 里；先走浮层分支会把**整个面板**
   * 关掉（Escape），而用户要的是"回上一层"。
   */
  var PANEL_BACK_LABELS = ['返回插件', 'Back to plugins'];
  function panelBackButton() {
    var scope = document.querySelector('[data-global-panel]');
    if (scope === null) { return null; }
    var detail = scope.querySelector('[data-plugin-row-detail],[data-plugin-detail],[data-plugin-item-detail]');
    var nodes = (detail === null ? scope : detail).querySelectorAll('[data-window-drag] > button[aria-label]');
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      if (!visible(el)) { continue; }
      var aria = el.getAttribute('aria-label');
      var text = aria !== null && aria.length > 0 ? aria : (el.textContent === null ? '' : el.textContent);
      for (var k = 0; k < PANEL_BACK_LABELS.length; k += 1) {
        if (text === PANEL_BACK_LABELS[k] || (detail !== null && (text.indexOf('返回 ') === 0 || text.indexOf('Back to ') === 0))) { return el; }
      }
    }
    return null;
  }
  function consumePanelBack() {
    var btn = panelBackButton();
    if (btn === null) { return false; }
    try {
      btn.click();
    } catch (e) {
      log('panel back click threw: ' + e);
      return true;
    }
    log('consume: panel-back ' + describe(btn));
    return true;
  }
  /* 可见的右侧栏面板（展开态属性 + 非 aria-hidden + 真有盒子）。 */
  function rightPanelVisible() {
    var list = document.querySelectorAll(RIGHT_OPEN_SEL);
    for (var i = 0; i < list.length; i += 1) {
      var el = list[i];
      if (el.getAttribute('aria-hidden') === 'true') { continue; }
      if (visible(el)) { return el; }
    }
    /* 兜底（2026-10-18 真机首测）：个别形态把 data-sidebar-right-open 挂在零尺寸包装层上，
       真正可见的是 [data-sidebar-right-panel]（模式值 push/fullscreen）。
       判据仍是"可见 + 真有宽高"，绝不用模式值本身当开关。 */
    var panel = document.querySelector('[data-sidebar-right-panel]');
    if (panel !== null && panel.getAttribute('aria-hidden') !== 'true' && visible(panel)) {
      var rect = panel.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) { return panel; }
    }
    return null;
  }
  /* 诊断：一句话列出所有右栏候选的几何/属性（只在"没认出右栏"时打一行）。 */
  function rightPanelCandidates() {
    var parts = [];
    var list = document.querySelectorAll(RIGHT_OPEN_SEL);
    for (var i = 0; i < list.length; i += 1) {
      var el = list[i];
      var r = el.getBoundingClientRect();
      parts.push(describe(el) + ' rect=' + Math.round(r.width) + 'x' + Math.round(r.height)
        + ' aria-hidden=' + el.getAttribute('aria-hidden'));
    }
    var panel = document.querySelector('[data-sidebar-right-panel]');
    if (panel !== null) {
      var r2 = panel.getBoundingClientRect();
      parts.push('panel mode=' + panel.getAttribute('data-sidebar-right-panel')
        + ' rect=' + Math.round(r2.width) + 'x' + Math.round(r2.height)
        + ' aria-hidden=' + panel.getAttribute('aria-hidden'));
    }
    return parts.length === 0 ? '(no candidates)' : parts.join(' | ');
  }
  /* 右侧栏自己的"收起"按钮（官方 aria-label = chrome.collapseAria，属性 data-sidebar-right-toggle）。 */
  function rightPanelToggle(panel) {
    var local = panel.querySelector('[data-sidebar-right-toggle]');
    if (local !== null && visible(local)) { return local; }
    var all = document.querySelectorAll('[data-sidebar-right-toggle]');
    for (var i = 0; i < all.length; i += 1) {
      if (visible(all[i])) { return all[i]; }
    }
    return null;
  }
  /*
   * 右侧栏 → 回会话区（2026-10-18 用户复报"点开右侧边栏时手势直接回桌面"）。
   *
   * 【为什么点官方收起按钮】右侧栏的关闭是官方状态机里的 toggleExpanded(sessionId)，
   * 那颗按钮带稳定属性 data-sidebar-right-toggle（不认压缩类名）；程序化点击与真人点
   * 同一条路径，且不碰任何数据。
   * 【为什么失败只补 Escape、绝不最小化】这里的语义是"关掉右栏、留会话区"；
   * 若收起按钮没生效就去请求系统返回，用户会被直接丢回桌面（正是本次复报的现象）。
   */
  function consumeRightPanel() {
    var panel = rightPanelVisible();
    if (panel === null) {
      /* 只在"这一次返回"打一行，便于真机定位"为什么没认出右栏"（含几何，不刷屏）。 */
      log('right: none (' + rightPanelCandidates() + ')');
      return false;
    }
    var btn = rightPanelToggle(panel);
    if (btn === null) {
      log('right-panel retained: no collapse button');
      return true;
    }
    try {
      btn.click();
    } catch (e) {
      log('right-panel click threw: ' + e);
      return true;
    }
    log('consume: right-panel ' + describe(panel));
    setTimeout(function () {
      var again = rightPanelVisible();
      if (again !== null) {
        log('right-panel retained: collapse did not close');
      }
    }, VERIFY_MS);
    return true;
  }
  /*
   * 「主面板（插件 / 自动化任务 / …）→ 回到会话（DSH 主页）」（2026-10-16 用户报障第二轮）。
   *
   * 【现场】用户进插件页后右缘内划，垫片裁决是 none ⇒ 落回"最小化到桌面"。真因：插件页在上游是
   * main 槽的主面板（dsh-client-ui-plugin-manager 的 slots.register({name:'main', key:PANEL_ID})），
   * 既不是 [data-shortcut-modal] 浮层、也不进 Web 历史 ⇒ 既有三条分支全不认。
   *
   * 【回主页的官方路径是什么】ctx.layout.selectPanel(null) = "return to the Conversation"
   * （dsh-client-ui-layout 的 selectPanel() 注释与 panelId !== null 判据）。那个 API 没挂到
   * globalThis，但它在 DOM 上有一个**稳定入口**：侧栏里的会话行
   * （data-row-key="session:<id>" + role="treeitem"），点击它就走
   * onOpen(id) → 选中该会话 → selectPanel(null) 回会话视图（不会新建会话、不动任何数据）。
   * ⚠️ 主面板激活时**没有任何**会话行带 aria-selected="true"（选中的是 panel row）⇒
   * 优先取选中行、取不到就退化取第一条可见行（那份列表按"最近更新"排序，第一条 = 刚待过的会话）。
   *
   * 【激活判据】主面板激活时，侧栏那一行 panel row 带 aria-current="page"
   * （dsh-client-ui-sidebar 的 PanelRow）——用它判断"现在确实停在一个主面板上"。
   */
  function activeMainPanel() {
    return document.querySelector('[data-global-panel]');
  }
  function conversationRootVisible() {
    if (activeMainPanel() !== null) { return false; }
    var editors = document.querySelectorAll('[data-lexical-editor="true"]');
    for (var i = 0; i < editors.length; i += 1) {
      if (visible(editors[i])) { return true; }
    }
    return false;
  }
  function sessionRow() {
    var picked = document.querySelectorAll('[data-row-key^="session:"][aria-selected="true"]');
    for (var i = 0; i < picked.length; i += 1) {
      if (visible(picked[i])) { return picked[i]; }
    }
    /* 见头注：停下主面板时选中态在 panel row 上，会话列表整列没有 aria-selected ⇒ 退化取第一条可见行。 */
    var any = document.querySelectorAll('[data-row-key^="session:"]');
    for (var j = 0; j < any.length; j += 1) {
      if (visible(any[j])) { return any[j]; }
    }
    return null;
  }
  function consumeMainPanelHome() {
    if (activeMainPanel() === null) { return false; }
    var row = sessionRow();
    if (row === null) {
      /*
       * 【为什么会话行可能不在 DOM 里】侧栏收起时那份列表是**虚拟列表**（dsh-client-ui-workspace
       * 的 VirtualRows 只渲染视口内的行）⇒ 收起态查不到任何 data-row-key="session:" 的行。
       * 官方唯一的"回会话"入口又是选中一条会话行（见函数头注）⇒ 只能两步走：
       * 先展开抽屉，等会话行渲染出来，点它（= 选中该会话 ⇒ selectPanel(null) 回会话），
       * 再把抽屉收回（官方只在按钮 / 快捷键上 toggle，不会自己收）。
       */
      var sb = sidebar();
      if (sb === undefined || sb === null || typeof sb.toggle !== 'function') {
        log('consume: main panel retained; sidebar bridge missing');
        return true;
      }
      log('consume: home via drawer (session rows are virtualized while collapsed)');
      backBusy = true;
      try {
        if (!drawerOpen()) { sb.toggle(); }
      } catch (e) {
        backBusy = false;
        return true;
      }
      var tries = 0;
      var attempt = function () {
        try {
        var target = sessionRow();
        if (target === null) {
          /* 抽屉展开动画 + 虚拟列表首帧渲染在低端机上不止 1.2s（真机实测第一轮就是死在这），
             给到 ≈2.4s；仍没等到就把抽屉留着（至少停在"能看见会话列表"的半程，不再一路沉到桌面）。 */
          if (tries < 16) { tries += 1; setTimeout(attempt, 150); }
           else { backBusy = false; log('consume: home aborted (session row never appeared; drawer left open)'); }
          return;
        }
          target.click();
        } catch (e) {
          log('session row click threw: ' + e);
          backBusy = false;
          return;
        }
        log('consume: home ' + describe(target));
        /* 点完会话把抽屉收回：抽屉留在展开态等于"回了一半"，用户还得再划一次。 */
        setTimeout(function () {
          try {
          if (drawerOpen()) {
            var again = sidebar();
            if (again !== undefined && again !== null && typeof again.toggle === 'function') { again.toggle(); }
          }
          } catch (e) {
            log('drawer close threw: ' + e);
          } finally {
            backBusy = false;
          }
        }, 400);
      };
      setTimeout(attempt, 150);
      return true;
    }
    try {
      row.click();
    } catch (e) {
      log('session row click threw: ' + e);
      return true;
    }
    log('consume: home ' + describe(row));
    return true;
  }
  /* 派发点取浮层内的自动聚焦点（官方开面板时就把焦点放那儿）：与真人按 Esc 同路径，
     也不会把 Esc 误交给别处。 */
  function sendEscape(el) {
    var target = el.querySelector('[data-modal-autofocus]');
    if (target === null) { target = el; }
    try {
      var ev = new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', bubbles: true, cancelable: true, composed: true
      });
      /* keyCode / which 是只读遗留属性，构造参数喂不进去 ⇒ 显式补上（老式判据只认它）。 */
      try {
        Object.defineProperty(ev, 'keyCode', { get: function () { return 27; } });
        Object.defineProperty(ev, 'which', { get: function () { return 27; } });
      } catch (e2) { /* 补不上不致命：主判据读 ev.key */ }
      target.dispatchEvent(ev);
    } catch (e3) {
      log('escape threw: ' + e3);
    }
  }
  function consume() {
    if (!handheld()) { return 'off'; }
    if (backBusy) { return 'duplicate'; }
    /* 右侧栏优先于浮层/抽屉：它是会话区之上最外面那层（右缘内划应先收起它）。 */
    var ov = topOverlay();
    if (ov !== null) {
      sendEscape(ov);
      log('consume: overlay ' + describe(ov) + ' (visible overlays=' + countOverlays() + ')');
      setTimeout(function () {
        var now = topOverlay();
        if (now === null || now !== ov) { log('consume: overlay closed -> ' + describe(now)); return; }
        log('overlay not closed; retained internal layer');
      }, VERIFY_MS);
      return 'overlay';
    }
    if (consumeRightPanel()) { return 'right'; }
    if (drawerOpen()) {
      sidebar().toggle();
      log('consume: drawer');
      return 'drawer';
    }
    if (consumePanelBack()) { return 'panel'; }
    /* 主面板（插件 / 自动化任务 …）→ 回会话；排在抽屉之后：抽屉开着时它才是"最上面那层"。 */
    if (consumeMainPanelHome()) { return 'home'; }
    if (activeMainPanel() !== null) { log('main panel retained'); return 'blocked'; }
    return conversationRootVisible() ? 'none' : 'blocked';
  }
  var backBusy = false;
  globalThis.__DSHM_BACK__ = {
    consume: consume,
    /* 验收读数：这一拍"返回"会消费掉什么（只读，不产生副作用）。 */
    state: function () {
      if (!handheld()) { return 'off'; }
      if (backBusy) { return 'blocked'; }
      if (topOverlay() !== null) { return 'overlay'; }
      if (rightPanelVisible() !== null) { return 'right'; }
      if (drawerOpen()) { return 'drawer'; }
      if (panelBackButton() !== null) { return 'panel'; }
      if (activeMainPanel() !== null) { return 'home'; }
      return conversationRootVisible() ? 'none' : 'blocked';
    }
  };
  log('shim installed');
})();`

/**
 * 外观跟随桥（ArkTS 端，报告 5 §2.2）。
 *
 * web 侧 THEME_SHIM_JS 观测到实际生效的明暗变化后，同步调用本对象的
 * `onThemeMode('light'|'dark')`（javaScriptProxy 只支持同步调用，这里正好够用：
 * 回传一个字符串、不需要返回值）。本对象再把结果交给页面去设状态栏配色。
 *
 * 【为什么把 window 的获取放在这里而不是页面里】状态栏属性要设在**主窗**上，而
 * 页面拿窗口有两条路：`window.getLastWindow(ctx)`（异步）或在 setupDecorAvoidance
 * 里已经拿到的那个 `decorWin`。后者在自由窗口沉浸那套里已经就位且已监听三键变化，
 * 复用它既省一次查询，也保证"三键避让"与"状态栏配色"作用在**同一个窗口对象**上。
 */
class DshThemeBridge {
  private apply: (mode: string) => void;

  constructor(apply: (mode: string) => void) {
    this.apply = apply;
  }

  /**
   * @param mode 'light' | 'dark'（web 侧已解析成"实际生效"的明暗）
   * 非法值直接忽略——不让 web 侧的一个笔误把窗口配色改坏。
   */
  onThemeMode(mode: string): void {
    if (mode === 'light' || mode === 'dark') {
      this.apply(mode);
    }
  }
}

/**
 * 目录选择桥（三段式第 1、3 段）：见 PICKER_SHIM_JS 的三段式说明。
 *
 * 【实现】同步 startPick(id)（javaScriptProxy methodList 注册，同步调用能
 * 拿到返回值）→ 异步拉起系统目录选择器 DocumentViewPicker（FOLDER 模式）
 * → uri 转路径（FileUri.path，如 file://docs/storage/Users/currentUser/Foo
 * → /storage/Users/currentUser/Foo）→ best-effort 持久化目录授权
 * （FILE_ACCESS_PERSIST；失败不影响本次选择。**注意**：Host 访问用户目录
 * **不**依赖任何受限 ACL —— 那句是错的，见下方 2026-10-03 的更正；
 * 本包权限面已由用户定死为 8 条，见 module.json5 的"权限面铁律"）→ runJavaScript
 * 回调垫片把结果送回 H5 Promise。
 *
 * 【诊断纪律】hilog 在本机有丢日志前科（DSHM bug-log 2026-09-14；本项目
 * 2026-09-21 实证：pick() 的 hilog 一条没出现，但 filesDir/diag-pick-called
 * 文件存在）——链路每个阶段都以**追加模式**写文件标记（带 ISO 时间戳），
 * 事后以文件为准，不依赖 hilog。
 */
interface PickResult {
  /** 选中的目录路径；null = 用户取消 */
  path: string | null;
  /** 非空 = 真实错误（reject 语义）；'' = 无错误 */
  error: string;
}

/** API 23–25 手持端的内置工作区浏览器结果；path=null 表示用户取消。 */
interface WorkspaceBrowserPickResult {
  path: string | null;
  error: string;
}

/** 内置工作区浏览器的根节点（只列应用当前确实可读写的范围）。 */
interface WorkspaceBrowserRoot {
  label: string;
  path: string;
}

class DshDirectoryPickerBridge {
  private readonly hostContext: () => common.Context | undefined;
  private readonly controller: () => webview.WebviewController;
  private readonly openWorkspaceBrowser: (ctx: common.Context) => Promise<WorkspaceBrowserPickResult>;
  /** 单飞行守卫：系统选择器一次只能有一个；startPick 重入直接返回 'busy' */
  private picking: boolean = false;
  /** `diag-web-console` 是否已在本次冷启动写过首行（决定 TRUNC 还是 APPEND） */
  private consoleSinkOpened: boolean = false;
  /** 本次冷启动已落盘的 console 行数（与 `CONSOLE_SINK_LINE_CAP` 比较） */
  private consoleSinkLines: number = 0;

  constructor(hostContext: () => common.Context | undefined,
    controller: () => webview.WebviewController,
    openWorkspaceBrowser: (ctx: common.Context) => Promise<WorkspaceBrowserPickResult>) {
    this.hostContext = hostContext;
    this.controller = controller;
    this.openWorkspaceBrowser = openWorkspaceBrowser;
  }

  /**
   * 诊断标记：在 filesDir 追加一行「ISO 时间戳 + 详情」。追加而非覆盖：
   * 多次事件按序累积，既能证明发生过，又能看到时间线。写失败静默
   * （诊断辅助，不碰业务路径）。
   */
  private writeDiagMarker(name: string, detail: string): void {
    try {
      const ctx = this.hostContext();
      if (ctx === undefined) {
        return;
      }
      const p: string = `${ctx.filesDir}/${name}`;
      const file: fileIo.File = fileIo.openSync(p,
        fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.APPEND);
      fileIo.writeSync(file.fd, `${new Date().toISOString()} ${detail}\n`);
      fileIo.closeSync(file);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '诊断标记写入失败：%{public}s', (e as Error).message);
    }
  }

  /** 诊断标记的公开包装：供 WebApp 组件的 onShowFileSelector / 权限回调留痕用。 */
  writeDiagMarkerPublic(name: string, detail: string = ''): void {
    this.writeDiagMarker(name, detail);
  }

  /**
   * 【Web 侧 console 的文件落点】`files/diag-web-console`
   *
   * 【为什么需要】`.onConsole` 原本只把 console 转发到 hilog。但本机 hilog 对
   * 本应用的 ArkTS 输出**不可读**：`hilog -x -D 0xd5d5` / `-T DshWebApp` 在
   * 清缓冲 + 冷启动后恒为 0 行（连常规行都没有），而同一时刻
   * `hilog -x | grep -i dshm` 有数千行 ⇒ 不是"DshWebApp 没打日志"，是这条通道
   * 的 output 到不了可读缓冲。于是"网页端到底报了什么错"在真机上无从取证，
   * 而网页端的错误恰恰是本端绝大多数界面问题的第一现场（例：右侧栏 `files`
   * 页签被占位后文件树空白，网页端会刷 `already registered`，本端却看不到）。
   *
   * 【做法】与既有 `writeDiagMarker` 同一套（filesDir + 追加 + 写失败静默），
   * 但有三点不同，都是为"console 是高频流"这一事实：
   *   1. **每次冷启动截断**（首次写入用 TRUNC，之后 APPEND）——只保留本次运行，
   *      否则跨次启动混在一起根本读不出时序；
   *   2. **行数上限**（见 `CONSOLE_SINK_LINE_CAP`）——启动期 console 可达数千行，
   *      无限追加会撑大 files 目录且淹没真正要看的那几行；到顶再写一行哨兵后停写；
   *   3. **一条 console 压成一行**（换行替换成字面 `\n`）+ 单条长度截断，保证
   *      "一行一条记录"，`grep` 才有意义。
   *
   * 【不是替身】hilog 那一路照旧保留：hilog 在别的机器/别的版本上仍可能是通的，
   * 文件只是**并行**的兜底通道。返回 false 保留 ArkWeb 默认行为不变。
   *
   * @param level console 级别数值（MessageLevel：1 Debug / 2 Info / 3 Warn / 4 Error）
   * @param source 源文件路径（`msg.getSourceId()`；**不是** `getSource()`——后者返回
   *               `ConsoleMessageSource` 枚举（XML/JAVASCRIPT/NETWORK/CONSOLE），
   *               是"这条消息哪来的"分类，不是文件位置）
   * @param line 源文件行号（`msg.getLineNumber()`）
   * @param message console 文本（`msg.getMessage()`）
   */
  writeConsoleLine(level: number, source: string, line: number, message: string): void {
    try {
      const ctx = this.hostContext();
      if (ctx === undefined) {
        return;
      }
      if (this.consoleSinkLines >= CONSOLE_SINK_LINE_CAP) {
        return;
      }
      /*
       * 【为什么先做类型收敛】真机首轮实测：本方法一行都没落盘，文件压根没被创建。
       * 而 `flat` 是在 `openSync` **之前**算的 ⇒ 只要 `message` 不是字符串
       * （`ConsoleMessage.getMessage()` 对某些来源可能给到空/未定义），
       * `.split` 就会在建文件前抛，整个方法被 catch 吃掉，现象正是"文件不存在"。
       * 宁可把这一层收敛写死，也不要让整条诊断通道被单条异常消息带走。
       */
      const raw: string = typeof message === 'string' ? message : `${message}`;
      const src: string = typeof source === 'string' ? source : '';
      const ln: number = typeof line === 'number' ? line : 0;
      const lv: number = typeof level === 'number' ? level : 0;
      const flat: string = raw.split('\n').join('\\n');
      const body: string = flat.length > 2000 ? `${flat.substring(0, 2000)}…[单条已截断]` : flat;
      const p: string = `${ctx.filesDir}/diag-web-console`;
      const mode: number = this.consoleSinkOpened
        ? (fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.APPEND)
        : (fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.TRUNC);
      const file: fileIo.File = fileIo.openSync(p, mode);
      if (!this.consoleSinkOpened) {
        this.consoleSinkOpened = true;
        fileIo.writeSync(file.fd,
          `${new Date().toISOString()} === diag-web-console 本次冷启动开始（上限 ${CONSOLE_SINK_LINE_CAP} 行）===\n`);
      }
      this.consoleSinkLines += 1;
      fileIo.writeSync(file.fd, `${new Date().toISOString()} L${lv} ${src}:${ln} ${body}\n`);
      if (this.consoleSinkLines >= CONSOLE_SINK_LINE_CAP) {
        fileIo.writeSync(file.fd,
          `${new Date().toISOString()} === 已达 ${CONSOLE_SINK_LINE_CAP} 行上限，后续 console 不再落盘 ===\n`);
      }
      fileIo.closeSync(file);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'console 落盘失败：%{public}s', (e as Error).message);
    }
  }


  /**
   * 同步入口（methodList 注册）：web 垫片调它启动选择流程，立即返回状态。
   * 返回 'ok' = 已受理（结果稍后经 __DSH_DIR_PICKER_RESOLVE__ 回传）；
   * 'busy'/'noctx' = 受理失败（垫片把非 'ok' 一律 resolve(null) 收场）。
   */
  startPick(id: string): string {
    this.writeDiagMarker('diag-pick-called', `id=${id}`);
    hilog.info(DOMAIN, TAG, '目录选择：startPick(id=%{public}s)', id);
    if (this.picking) {
      hilog.warn(DOMAIN, TAG, '目录选择：已有进行中的选择，忽略重入');
      return 'busy';
    }
    const ctx = this.hostContext();
    if (ctx === undefined) {
      hilog.warn(DOMAIN, TAG, '目录选择失败：宿主上下文不可用');
      return 'noctx';
    }
    this.picking = true;
    // 异步主体 fire-and-forget：无论成败都要复位单飞行守卫
    this.doPick(id).then((): void => {
      this.picking = false;
    }, (): void => {
      this.picking = false;
    });
    return 'ok';
  }

  /** 异步主体：拉起系统选择器 → 持久化授权（限时）→ 回传结果 */
  private async doPick(id: string): Promise<void> {
    const ctx = this.hostContext();
    if (ctx === undefined) {
      this.dispatchResolve(id, null, 'host context unavailable');
      return;
    }
    /*
     * 不能只信 `canIUse(FolderSelection)`：`06_46_21` / `07_14_04` 的 API 23–24
     * 云调试实测里，系统能力位可能报可用，但 FOLDER 选择实际不支持，随后又静默
     * 落到专属下载目录。手持端 API < 26 按平台能力表直接进入应用内目录浏览器。
     */
    const legacyHandheld: boolean = isHandheldForm() && deviceInfo.sdkApiVersion < 26;
    if (legacyHandheld || !folderSelectionAvailable()) {
      this.writeDiagMarker('diag-picker-capability-fallback',
        `legacy-handheld=${legacyHandheld ? 'true' : 'false'}; api=${deviceInfo.sdkApiVersion};`
          + ` syscap=${folderSelectionAvailable() ? 'true' : 'false'}`);
      try {
        const picked: WorkspaceBrowserPickResult = await this.openWorkspaceBrowser(ctx);
        this.dispatchResolve(id, picked.path, picked.error);
      } catch (err) {
        const e = err as Error;
        this.dispatchResolve(id, null, `内置工作区浏览器失败：${e.message}`);
      }
      return;
    }
    const docPicker = new picker.DocumentViewPicker(ctx as common.UIAbilityContext);
    // 这里不为目录选择额外申请权限：移动版权限面有独立的 7 条白名单，
    // 用户目录访问走系统 picker + FILE_ACCESS_PERSIST；超出的受限条目会让整包
    // 按 `PERMISSION_ACL_RULE` 拒装。理由与取证见 FilePicker.ets 顶部注释。
    // 拿不到路径级写权不再靠"申请"解决，而是靠下面的**探写 + DOWNLOAD 模式兜底**。
    const options = new picker.DocumentSelectOptions();
    options.selectMode = picker.DocumentSelectMode.FOLDER;
    options.maxSelectNumber = 1;
    let uris: Array<string> = [];
    try {
      hilog.info(DOMAIN, TAG, '目录选择：拉起系统选择器（select）');
      uris = await docPicker.select(options);
    } catch (e) {
      const err = e as BusinessError;
      // 真实错误 → 垫片 reject（官方契约：前端 onError 路径）
      this.writeDiagMarker('diag-select-error', `code=${err.code} ${err.message}`);
      hilog.warn(DOMAIN, TAG, '目录选择异常 code=%{public}d msg=%{public}s', err.code, err.message);
      /*
       * 能力预检在部分 Kirin ROM 上会为真，但 select() 随后返回 801 / 202 或厂商
       * 自定义错误。手持档除用户取消外都归为同一种能力失败，直接切到现有默认
       * 工作区；不发替代事件、不弹目录浮层，避免把内部错误变成用户操作任务。
       */
      if (shouldAutoFallbackFolderPicker(err.code, isHandheldForm())) {
        await this.resolvePublicWorkspace(ctx, id,
          `select-error code=${err.code} message=${err.message}`);
        return;
      }
      this.dispatchResolve(id, null, `select failed: ${err.code} ${err.message}`);
      return;
    }
    this.writeDiagMarker('diag-select-returned', `count=${uris.length}`);
    hilog.info(DOMAIN, TAG, '目录选择：select 返回 %{public}d 个结果', uris.length);
    if (uris.length === 0) {
      // 空结果 = 用户取消 → resolve(null)（官方契约：前端静默收场）
      this.dispatchResolve(id, null, '');
      return;
    }
    const uri: string = uris[0];
    const path: string = new fileUri.FileUri(uri).path;
    // 平板选中 Documents/Download/Desktop 时按需申请对应 user_grant；手机形态跳过。
    await requestPublicDirectoryPermission(ctx as common.Context, path);
    // 持久化目录授权：跨启动保留访问权。失败/超时只降级为「本次有效」，不阻断选择。
    // 【2026-10-14 所有移动形态同一套】这里原本自己写一遍"带看门狗的 persistPermission"，而
    // **查证**（`checkPersistentPermission`）与**启动恢复**（`activatePermission`）都在
    // 别处 ⇒ 曾出现"记了却没人启用"：重启后同一条路径照样
    // `Errno 1 Operation not permitted`（现场读数见 docs/157）。现在收口到
    // `rememberFolderGrant()`（登记 + persist + check，每步带看门狗；
    // `persistPermission` 在本机实测有"永不 settle"前科，一旦挂起结果永远回不到 H5，
    // 表现为「选完无反应」⇒ 必须限时）。
    // 【2026-10-03 更正】原文还写着"Host（node）访问用户目录实际依赖某两条受限权限
    // （已授权）"——**这句是错的**：那类"开放权限"都是**受限条目**
    // （system_basic，需 AGC 审批 + Profile 关联 ACL），本项目走离线零 AGC 配额的
    // 本地签名链 ⇒ 真机上等于没声明。Host 能"读"不是因为它们，而"写/删"正是
    // 因此失败——这就是用户看到的"只能读、写只进沙箱、bash rm 也删不掉"的根因。
    //（这类条目一度被从源码撤掉又加回，2026-10-14 用户已明令**永久删除**：本包权限面
    //  固定 8 条，源码 / 包体 / 文档都不再出现，见 module.json5 的"权限面铁律"。）
    // 取证与判据见 dsh-移植研究/30-DSHM文件能力植入-侦察与设计.md §3.1/§4.1。
    // 【2026-10-03 新增】探写 + 兜底：把"用户可见 + agent 可读写删"从愿望变成判据。
    // 【为什么在 ArkTS 侧做而不是写一个 cordis 插件】Host 的文件/命令能力全是
    // **纯 POSIX/node 路径**（`dsh-fs-local` 只 import node:fs；`dsh-bash-local` 直接
    // spawn，二者自身不做任何路径转换或沙箱判断），新插件跑在同一进程、同一 token 下
    // ⇒ 受**同一份 OS 授权**约束，在 JS 层补不出权限。**只能在拿到授权的那一层换路径。**
    // 详见 30 号文档 §2.2/§5.2。
    // 【2026-10-06 晚 更正：判据从"宿主验过的目录"改成"授权能不能跨重启"】
    // 同日下午那版依据的是"宿主读不到 picker 目录"——**读数是真的、结论错了**：picker 给的
    // 授权只活一次进程（选完当场宿主能列出该目录的内容，重启后同一条调用报
    // `cannot list …: permission denied`；两次原始读数与完整时间线见 docs/105）。
    // 判据因此分两类：① 本应用**按包名归属**的公共目录内（跨重启有效，官方 FAQ 口径）；
    // ② 用户自己的目录 + 这一次的持久授权**已确认生效**（重启后由 restoreFolderGrants() 启用）。
    // 【2026-10-14】② 这条链与启动恢复对手机、平板和桌面模式都运行；
    // 桌面模式另外多兜一层 `probePathWritable()`。
    const handheld: boolean = isHandheldForm();
    const claimed: PickedFolder | undefined = handheld ? await publicDownloadFolder(ctx) : undefined;
    const owned: boolean = claimed !== undefined && claimed.outcome === PickOutcome.PICKED
      && isPathWithin(path, claimed.path);
    const granted: GrantOutcome = await rememberFolderGrant(ctx, uri, path);
    // 两个 diag 标记的**名字不动**（现场排查一直在用）；判据换成内容：登记+persist+check 的读数
    this.writeDiagMarker(granted.persisted ? 'diag-persist-done' : 'diag-persist-skip', granted.note);
    hilog.info(DOMAIN, TAG, '目录授权：persisted=%{public}s %{public}s',
      granted.persisted ? 'true' : 'false', granted.note);
    // 【判据为什么是"或"而不是"与"】`persisted` 回答的是"重启后还认不认"，探写回答的是
    // "现在能不能写"：两者都会在**正常**情况下为真，也都会在**正常**的边界下为假
    //（check 看门狗超时 ≠ 授权没建起来；只读目录 ≠ 这条路径不可用）。任一为真即采纳；
    // 两者皆假才判"这条路径重启后读不到"——那是**如实的**，此时才回落并说明原因。
    const acceptable: boolean = handheld ? (owned || granted.persisted)
      : (granted.persisted || probePathWritable(path));
    if (!acceptable) {
      this.writeDiagMarker('diag-picker-public-fallback',
        `from=${path} handheld=${handheld ? 'true' : 'false'} granted=${granted.note}`);
      const pub: PickedFolder = claimed !== undefined ? claimed : await publicDownloadFolder(ctx);
      if (pub.outcome === PickOutcome.PICKED && pub.path.length > 0) {
        hilog.warn(DOMAIN, TAG, '所选目录不可写，已改用应用公共目录 path=%{public}s', pub.path);
        this.writeDiagMarker('diag-picker-public-path', `to=${pub.path}`);
        // 【GitHub #3 的 R3：换路径必须让用户知道】"用户选了 A、实际工作区是 B" 这件事
        // 发生在 Web 侧，而用户可见的提示位在壳层（`Index`）⇒ 走进程内事件契约
        // （`platform/system/HostEvents.ets` 是事件 id 与载荷键的**唯一定义处**）。
        // 壳层收到后打开自己的目录浮层、把原因写在其顶部（壳里没有 toast 通道，
        // 见 `platform/notify` 的分层说明）。此前这里只落 diag 标记 ⇒ 用户完全看不到。
        const pickerPayload: Record<string, Object> = {};
        pickerPayload[EVENT_KEY_PICKER_REASON] =
          handheld
            ? `所选目录（${path}）没能建立跨启动的目录授权（${granted.note}）：手机/平板上选择器给的授权只对本次运行有效，重启后宿主会读不到它；已改用本应用在系统下载目录下的专属目录`
            : `所选目录（${path}）没能建立跨启动的目录授权（${granted.note}），且宿主现在也写不进它；已改用本应用在系统下载目录下的专属目录`;
        pickerPayload[EVENT_KEY_PICKER_PATH] = pub.path;
        emitter.emit({ eventId: EVENT_PICKER_SUBSTITUTED }, { data: pickerPayload });
        this.dispatchResolve(id, pub.path, '');
        return;
      }
      this.writeDiagMarker('diag-picker-public-unavailable', `reason=${pub.reason}`);
      hilog.warn(DOMAIN, TAG, '公共目录兜底不可用：%{public}s', pub.reason);
    }
    hilog.info(DOMAIN, TAG, '目录选择完成 path=%{public}s', path);
    this.dispatchResolve(id, path, '');
  }

  /**
   * 手持档选择器不可用时，直接认领 Download/<bundle> 并回传路径。
   *
   * 这条路径是既有工作区的“自愈”，不是一次新的用户选择：只有真实失败才回传错误，
   * 成功时 reason 永远为空，不触发 Index 的目录浮层，也不要求用户再选一次。
   */
  private async resolvePublicWorkspace(
    ctx: common.Context, id: string, detail: string): Promise<void> {
    this.writeDiagMarker('diag-picker-auto-fallback', detail);
    const pub: PickedFolder = await publicDownloadFolder(ctx);
    if (pub.outcome === PickOutcome.PICKED && pub.path.length > 0) {
      this.dispatchResolve(id, pub.path, '');
      return;
    }
    this.writeDiagMarker('diag-picker-auto-fallback-failed', `reason=${pub.reason}`);
    this.dispatchResolve(id, null, `默认工作区无法建立：${pub.reason}`);
  }

  /**
   * 三段式第 3 段：把结果经 runJavaScript 送回 web 垫片的 Promise。
   * result 用 JSON.stringify 编码成安全的 JS 字面量（路径可含任意字符）。
   */
  private dispatchResolve(id: string, path: string | null, errText: string): void {
    const result: PickResult = { path: path, error: errText };
    const js: string =
      `globalThis.__DSH_DIR_PICKER_RESOLVE__(${JSON.stringify(id)},${JSON.stringify(result)})`;
    if (path !== null) {
      this.writeDiagMarker('diag-resolve-dispatched', `path=${path}`);
    } else if (errText !== '') {
      this.writeDiagMarker('diag-resolve-dispatched', `error=${errText}`);
    } else {
      this.writeDiagMarker('diag-resolve-dispatched', 'cancelled');
    }
    try {
      this.controller().runJavaScript(js, (err: BusinessError, _result: string) => {
        if (err) {
          this.writeDiagMarker('diag-dispatch-error', err.message);
          hilog.warn(DOMAIN, TAG, '结果回传失败：%{public}s', err.message);
        }
      });
    } catch (e) {
      this.writeDiagMarker('diag-dispatch-error', (e as Error).message);
      hilog.warn(DOMAIN, TAG, '结果回传异常：%{public}s', (e as Error).message);
    }
  }
}

/** EntryAbility 发布的完整启动 URL（含 token）：本端自起或启动参数，见文件头 */
const KEY_HOST_LAUNCH_URL: string = 'dshHostLaunchUrl';
const KEY_HOST_BOOT_ERROR: string = 'dshHostBootError';
/** 【与 PC 壳对齐（2026-11-26）：Web 预挂】预挂期 ArkWeb 承载的空页（entry 壳同名常量） */
const STARTUP_BLANK_URL: string = 'about:blank';

/** EntryAbility 发布的三键可见性（自由窗口 ⟺ 三键在）：与能力层**同名同值**的约定键 */
const KEY_DECOR_KEYS_VISIBLE: string = 'dshDecorKeysVisible';
const KEY_DECOR_STYLE_WRITABLE: string = 'dshDecorStyleWritable';
const KEY_DECOR_STYLE_WINDOW_ID: string = 'dshDecorStyleWindowId';

/**
 * 当前生效外观（`'light' | 'dark'`）—— **跨层唯一权威**：页面发布、能力层读它重放三键配色。
 * 与 `KEY_DECOR_KEYS_VISIBLE` 同款约定：两侧各写一份字面量，门禁 `check-decor-button-mode`
 * 钉住两边**同名同值**（漂移了不会报错，只会静默失效）。
 */
const KEY_APPEARANCE_MODE: string = 'dshAppearanceMode';

/** 页面阶段 */
enum WebPhase {
  /** 等待 Host 就绪（本端核心解包/启动中） */
  BOOTING = 'BOOTING',
  /** Web 组件已开始加载 Host web UI */
  LOADING = 'LOADING',
  /** 首页渲染完成，官方 web UI 已接管 */
  READY = 'READY',
  /** 主资源加载失败或 Host 鉴权拒绝（覆盖层 + 重试） */
  ERROR = 'ERROR'
}

/**
 * 顶栏高度（vp）：历史自绘标题栏常量。移动工程（2026-10-22 起）**任何设备形态都不渲染**
 * 自绘顶栏；保留常量只给三键让位的上界门禁使用。
 *
 * 侧栏开关一律用官方自己那颗（图标轨顶部 / frame leading 座位），壳侧不再自绘；
 * 右侧栏自己的官方按钮始终保留。
 */
const TOP_BAR_HEIGHT: number = 38;

  /**
   * 「系统三键区」在**纵向**上要多少让位（vp，**手持档专用常量**）——只有「手持档 + 三键真的在」才让位。
   *
   * 【为什么要它（2026-10-10，MatePad Edge 用户报「右上角三键与右侧边栏按钮重叠」）】
   * 手持档**不渲染自绘顶栏**（见 `TOP_BAR_HEIGHT` 的手持档口径），而窗口仍处于
   * 「自由窗口 + 三键可见」的状态 —— `EntryAbility` 的 `setWindowDecorVisible(false)` +
   * `setWindowDecorHeight(38)` 在**所有档**都会试（全屏才抛 801）。于是窗口标题栏那一条
   * **没人画**，官方 Web 壳自己那排顶部按钮（最右侧那颗「面板 / 预览」开关）正好落在三键
   * 底下。整块 Web 内容按这个量下移即解（它自己那排按钮跟着让开）。
   *
   * 【为什么现在取常量 36（2026-10-22 用户复报三键与左右侧栏按钮重叠）】
   * 第一版（docs/133 / docs/134）把让位量写成"系统三键区高度"（本机就是我们自己
   * `setWindowDecorHeight(38)` 的 38vp），平板真机实测**不再重叠、但两排按钮之间的空档偏宽**
   * （用户原话"三键和 web 右上角稍微有点宽了"）。
   * 早先取 24vp 仍有残余重叠。当前把整条 Web 内容（左右两侧栏按钮随之下移）统一抬到
   * 36vp：覆盖系统三键与 Web 顶排按钮的实际相交区，同时仍小于 38vp 的系统标题栏高度，
   * 避免多留一条明显空白。
   * 【上下限由门禁钉住】`tools/check-decor-button-mode.mjs` 断言本常量 `>= 12`（盖住实测的
   * 8vp 重叠，留 4vp 余量）且 `< TOP_BAR_HEIGHT`（否则等于退回"太宽"那一版）。
   *
   * 【三键"在不在"为什么不用 `getTitleButtonRect()` 判】真机实测（MateBook 14，`diag-decor-top`
   * 原文 `handheld=false rect.w=0 rect.h=0 inset=0`）：**三键明明可见，rect 却是 0** ⇒ 它不能
   * 当判据。改用 `EntryAbility` 那边的**调用事实**（成功 ⟺ 自由窗口 ⟺ 三键在），经 AppStorage
   * 交过来（`decorKeysVisible`）。
   *
   * 【为什么不再消费系统读数（第二轮收窄）】让位量既然定成常量，原先"页面 rect 读数 → 能力层
   * `getWindowDecorHeight()` 经 `dshDecorHeightVp` 交过来 → `TOP_BAR_HEIGHT` 兜底"那条**三级取用**
   * 对让位就没有读者了 ⇒ **整条 AppStorage 通道撤掉**（能力层自己仍然读 `getWindowDecorHeight()`：
   * `decorPresentOf` 在窗口状态读不到时要用它当兜底，逐项自证也仍落在 `files/diag-decor-caps`）。
   * 留一条只有诊断用途的 AppStorage 通道，等于"忠实转发一个没人要的字段"（本仓 E346b 那种坑）。
   *
   * 【纯函数保留 handheld 入参】页面实际调用对移动工程恒传 `true`，所以桌面形态调试环境
   * 即使上报桌面形态 也执行同一让位；纯函数仍保留 `false -> 0` 便于离线门禁验证边界。
   *
   * 【为什么是一个纯函数】判据只有两个输入，与窗口 / 状态无关 —— 抽出来才能被门禁
   * `tools/check-decor-button-mode.mjs` 直接求值断言（含「桌面形态必须恒为 0」与常量的上下限）。
   */
const HANDHELD_DECOR_INSET_VP: number = 36;

function decorTopInsetVp(decorPresent: boolean): number {
  return decorPresent ? HANDHELD_DECOR_INSET_VP : 0;
}

/**
 * 启动页底色 —— **跟随系统深浅色**（2026-11-21 起）。
 *
 * 【历史】2026-10-16 曾固定取白 `#FFFFFF`：当时真机（手机 `62T0225B18039433`）观察到启动期系统把
 * 状态栏那一条固定画成白色，为消除「状态栏白 / 启动页浅灰」的硬台阶，反过来让启动页也取白。
 *
 * 【现在】启动视图改用资源 `app.color.start_window_background`（base `#FFFFFF` / dark `#151517`，
 * 与 `module.json5` 的 `startWindowBackground` 同一份 ⇒ 系统启动窗与页面首帧零色差）；启动期
 * 状态栏/窗口底色改用 `windowChromeFor(this.systemAppearance())`。深色系统下从首帧起就是深底
 * 浅图标，不再「先白后深」。
 */

/**
 * 会话区「加号」扫描入口垫片（2026-11-25）。
 *
 * 【为什么需要】加号的第一层菜单是**网页自己的 React UI**，原生层看不到 DOM 结构，
 * `onShowFileSelector` 只在第二层「选择文件」时才触发。实测用户反馈：加号菜单里
 * 没有扫描/表格选项 —— 所以必须在网页 DOM 里注入两个按钮。
 *
 * 【做法】找到加号按钮（aria-label 含「添加文件」/ `input.commands`），在它旁边插
 * 「扫描文档」「提取表格」两个按钮。点击时先调原生桥 `startScan(mode)` 打标，
 * 再同步 `input[type=file].click()` —— 必须在用户手势内触发，否则 ArkWeb 会拦截
 * 程序化 click。原生侧在 `onShowFileSelector` 看到标记后直接起 DocumentScanner，
 * 不再弹中间动作面板。
 *
 * 【失败策略】找不到加号或 input 时静默不注入；原生能力不可用时 startScan 会回退到
 * 系统选择器。任何异常都不影响网页自身功能。
 */
const SCAN_SHIM_JS: string = `
(function () {
  function findPlus() {
    var buttons = document.querySelectorAll('button,[role=button]');
    for (var i = 0; i < buttons.length; i++) {
      var label = (buttons[i].getAttribute('aria-label') || '') + ' ' + (buttons[i].title || '');
      if (label.indexOf('添加文件') >= 0 || label.indexOf('input.commands') >= 0 ||
          label.indexOf('attach') >= 0 || label.indexOf('附件') >= 0) {
        return buttons[i];
      }
    }
    return null;
  }
  /* 文档 / 表格的线性图标，currentColor 跟随网页主题 */
  function iconSvg(kind) {
    if (kind === 1) {
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
        + '<rect x="3" y="3" width="18" height="18" rx="2"/>'
        + '<line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/>'
        + '<line x1="9" y1="3" x2="9" y2="21"/></svg>';
    }
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>'
      + '<polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/>'
      + '<line x1="8" y1="17" x2="16" y2="17"/></svg>';
  }
  function makeButton(id, title, mode) {
    var btn = document.createElement('button');
    btn.id = id;
    btn.type = 'button';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = iconSvg(mode);
    /* 无边框、无背景，由 16px 图标本身决定视觉尺寸，与输入区其他工具图标统一 */
    btn.style.cssText = 'margin:0 2px;padding:2px;border:0;background:transparent;'
      + 'display:inline-flex;align-items:center;justify-content:center;'
      + 'width:20px;height:20px;box-sizing:border-box;cursor:pointer;color:inherit;';
    btn.addEventListener('click', function () {
      try {
        var bridges = window.__DSHM_BRIDGES__;
        if (bridges && typeof bridges.startScan === 'function') { bridges.startScan(mode); }
        var input = document.querySelector('input[type=file]');
        if (!input) {
          input = document.createElement('input');
          input.type = 'file';
          input.style.display = 'none';
          document.body.appendChild(input);
        }
        input.value = '';
        input.click();
      } catch (e) { /* 垫片失败不影响网页自身交互 */ }
    });
    return btn;
  }
  /*
   * 【持续守护】新窗口 / 切换会话会导致网页 SPA 重新渲染，之前插入的按钮被清掉。
   * 用 MutationObserver 监听 DOM 变化，按钮不在就重新插入；再配一个低频定时轮询兜底。
   */
  function ensureButtons() {
    var plus = findPlus();
    if (!plus || !plus.parentElement) { return; }
    var host = plus.parentElement;
    if (host.querySelector('#dshm-scan-doc')) { return; }
    host.insertBefore(makeButton('dshm-scan-doc', '扫描文档', 0), plus.nextSibling);
    host.insertBefore(makeButton('dshm-scan-sheet', '提取表格', 1), plus.nextSibling);
  }
  function start() {
    ensureButtons();
    var observer = new MutationObserver(function () { ensureButtons(); });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    setInterval(ensureButtons, 1500);
  }
  if (document.readyState !== 'loading') { start(); }
  else { document.addEventListener('DOMContentLoaded', start); }
})();
`;

/*
 * 【与 PC 壳对齐（2026-11-26）：Web 预挂】预挂 ArkWeb 的时点选择器：等一帧再挂，
 * 保证品牌动画首帧先提交（首帧保持轻量），Web 冷建排在其后。
 * entry 壳的同名类在 common/DesktopStartup.ets（StartupFrameCallback）；
 * 手机壳没有该模块，这里放一个等价的最小实现。
 */
class StartupWebFrameCallback extends FrameCallback {
  private readonly afterFrame: () => void;

  constructor(afterFrame: () => void) {
    super();
    this.afterFrame = afterFrame;
  }

  onIdle(_timeLeftInNano: number): void {
    this.afterFrame();
  }
}

@Entry
@Component
struct WebApp {
  @StorageProp(KEY_HOST_LAUNCH_URL) @Watch('onLaunchUrlChanged') launchUrl: string = '';
  @StorageProp(KEY_HOST_BOOT_ERROR) @Watch('onHostBootErrorChanged') hostBootError: string = '';
  @State @Watch('onPhaseChanged') phase: WebPhase = WebPhase.BOOTING;
  /** 启动页是否用深色：按系统当前深浅色，在 aboutToAppear 里定（web 主题上报前）。 */
  @State splashDark: boolean = false;
  /*
   * 【与 PC 壳对齐（2026-11-26）：Web 预挂】BOOTING 期就把 ArkWeb 以 about:blank
   * 预先挂载（document-start 垫片全部照常注册），宿主发布 launchUrl 后经
   * loadPreparedHostPage 用已附着的控制器直接导航 —— 把「ArkWeb 冷建 + 渲染
   * 进程孵化」从 URL 到达的关键路径挪进品牌动画的等待期。字段语义与 entry 壳
   * 同名字段一一对应。
   */
  @State private startupWebPrepared: boolean = false;
  private startupPageActive: boolean = false;
  private startupDocumentScripts: Array<ScriptItem> = [];
  private startupControllerAttached: boolean = false;
  private preparedLaunchUrl: string = '';
  /** ERROR 覆盖层展示的原因（不含任何凭据） */
  /**
   * 云同步面板是否显示（docs/320）。
   *
   * 网页侧的「设置 → 云同步」分区点「登录」或「从云端恢复插件」时才需要它：
   * 官方 `LoginPanel` 只能渲染在原生页面里（SDK 原文），插件恢复要逐项勾选 ——
   * 这两件事都得落到这个原生面板上，其余动作（开关/上传/拉取/退出）在分区里直接完成。
   */
  @State cloudSyncOpen: boolean = false;
  /** 打开面板时是否**落地即弹**官方登录面板（一次性；由 CloudSyncSettings 自己消费并清零）。 */
  @State cloudSyncAutoLogin: boolean = false;
  /** 云同步清单统计是否在刷新（同步桥 + 异步统计的并发去重，见 refreshCloudStats）。 */
  private cloudStatsInFlight: boolean = false;
  /** 上一次清单统计的时间戳（`CLOUD_STATS_MIN_GAP_MS` 的判据）。 */
  private cloudStatsAt: number = 0;
  @State errorText: string = '';
  // ── 会话区加号：文档扫描 / 表格提取（2026-11-25）──────────────────────
  /** -1 = 不显示扫描组件；0 = 文档扫描；1 = 表格提取 */
  @State scanDocType: number = -1;
  /** 被拦截的 ArkWeb 文件选择事件：扫描完成后用它把沙箱 URI 回传网页 */
  private pendingFileSelector: OnShowFileSelectorEvent | undefined = undefined;
  /** 垫片按钮点「扫描文档/提取表格」时预埋的模式；>=0 表示直接起扫描 */
  private pendingScanMode: number = -1;
  // ── 启动加载页品牌动效 ────────────────────────────────────────────────
  // 两个属性分工与 PC / 平板壳一致（docs/320）：brandOpacity 负责淡入、
  // brandBreath 负责常驻呼吸缩放。手机壳原先只有呼吸、没有淡入 —— 换标后两端
  // 用同一份 `curves.springMotion` 口径，若缺这一项，"同一段动画在两台设备上手感不同"。
  @State brandOpacity: number = 0;
  @State brandBreath: number = 1;
  /** 启动加载页底部线性进度条（0→100 循环）：启动阶段无精确进度可报，
   * 用循环驱动的进度条表达「正在加载」，而不是转圈或倒计时文案。 */
  @State progressValue: number = 0;
  private loadTicker: number = -1;
  /** 启动页进度条的计时起点（按经过时间推进，见 startBrandAnimation 的注释）。 */
  private loadStartedAt: number = 0;
  /**
   * 是否处于"收尾补到 100%"阶段，以及该阶段的起点。
   *
   * 【为什么需要】就绪时进度约在 80%，若直接 `= 100` 会"突然冲一下"。
   * 收尾用一个短缓出动画补完（见 finishProgress()），这三个字段记录它的状态。
   */
  private progressFinishing: boolean = false;
  private progressFinishFrom: number = 0;
  private progressFinishAt: number = 0;
  /** 收尾补完的时长（ms）：够看清"走完"，又不拖慢进主界面。 */
  private static readonly PROGRESS_FINISH_MS: number = 380;
  /**
   * 进度条**匀速主段**的速度（%/秒）。
   *
   * 【怎么定的】按实测冷启动 ~8 秒标定：想让 8 秒时到达 ~92%，
   * 则速率 ≈ 92 / 8 ≈ 11.5 %/s。
   * 【为什么不用指数曲线】指数（含前一版的 τ=3.2s）开头 28%/s、末段 2.3%/s，
   * 相差 12 倍 —— 主观就是"一上来冲出去"。用户两次反馈"冲"都出在这里。
   */
  private static readonly PROGRESS_RATE: number = 11.5;
  /** 匀速段的终点（%）。之后转入极慢爬升。 */
  private static readonly PROGRESS_CREEP_AT: number = 92;
  /** 慢爬速度（%/s）：只用来表达"还在动"，不追求速度。 */
  private static readonly PROGRESS_CREEP_RATE: number = 0.3;
  /** 自走上限（%）：**永不自走到 100%**，100% 只由"真的就绪"宣告。 */
  private static readonly PROGRESS_CEIL: number = 98;
  /**
   * **是否曾经就绪过**（用来区分"首次加载"与"应用内后续导航"）。
   *
   * 【为什么必须有它】启动页条件含 `LOADING` 是为了盖住首次加载的白屏窗口；
   * 但 `onPageBegin` 在**整页导航**（如 303 落地、点链接跳转）时也会把
   * `READY` 打回 `LOADING`。若只看 phase，应用内每次整页跳转都会**闪一下启动页**
   * —— 那是明显的回归。
   * 规则：**只有从未就绪过**时才把启动页盖在 LOADING 上。
   */
  private everReady: boolean = false;
  /*
   * 自动重试（白屏自愈）。见 fail() 的注释：
   * 首启解包后宿主需 6～7 秒才可用，而 WebView 可能抢先加载 ⇒ 404。
   * 原来进 ERROR 就不再动，表现为"打开就是白屏，只能手动重试"。
   */
  private autoRetryTimer: number = -1;
  private autoRetryCount: number = 0;
  /**
   * 本轮加载是否已判失败。
   *
   * 【为什么需要它】`onPageEnd` 在失败时**也会触发**（加载的是错误页），
   * 且只比 fail() 晚约 10ms。没有这个标志时 onPageEnd 会把 ERROR 覆盖成 READY，
   * 用户既看不到原因、自动重试也被取消 —— 表现就是**白屏**。
   */
  private loadFailed: boolean = false;
  /**
   * 三键区高度的**页面侧读数**（vp，0 = 系统没报）：`getTitleButtonRect().height`，在本机恒 0
   * （真机 `diag-decor-top` 原文 `rect.w=0 rect.h=0`，见 `decorTopInsetVp` 的注释）。
   *
   * 【第二轮起它只是一条诊断读数】让位量已定成常量 `HANDHELD_DECOR_INSET_VP`，不再由高度
   * 决定 ⇒ 这个数字只进 `diag-decor-top` 的 `rect.last=`，用来事后判断"页面侧到底读到过多少"。
   * 【为什么仍是 @State】它是 `onDecorKeysVisibleChanged` 落盘时读的值，且要能被重渲染带走。
   */
  @State decorRectHeightVp: number = 0;
  /**
   * 三键（全屏 / 最小化 / 关闭）是否真的在 —— 由 `EntryAbility` 那条 AppStorage 通道给
   * （`setWindowDecorVisible(false)` 成功 ⟺ 自由窗口 ⟺ 三键在；全屏抛 801 ⇒ false）。
   *
   * 【为什么不信 `getTitleButtonRect()`】真机实测（MateBook 14，页面侧 `diag-decor-top`
   * 原文 `handheld=false rect.w=0 rect.h=0 inset=0`）：**三键明明可见、rect 却全是 0**
   * ⇒ 拿它当"有没有三键"的判据必然漏判，故改用能力层那条**调用事实**。
   * 【为什么是 @StorageProp 而不是构造期读一次】发布时机在 `loadContent` 回调里
   * （`afterWindowStageReady`）⇒ 页面首帧时仓里可能还是空的，必须能在首帧之后跟上。
   * 【为什么还要 @Watch（2026-10-10 第二轮代码审核发现）】渲染会自己跟上，但**落盘证据**只挂在
   * `applyDecorRect` 上，而它只在"三键区读数变了"时才写；真机上 `getTitleButtonRect()` 恒 0/0
   * ⇒ 不补一条，`diag-decor-top` 会永远停在能力层发布**之前**那一刻的 `keys=false`，看起来像
   * "让位没生效"（docs/133 那轮就是这么被误判的）。
   */
  @StorageProp(KEY_DECOR_KEYS_VISIBLE) @Watch('onDecorKeysVisibleChanged') decorKeysVisible: boolean = false;
  @StorageProp(KEY_DECOR_STYLE_WRITABLE) private decorStyleWritable: boolean = false;
  @StorageProp(KEY_DECOR_STYLE_WINDOW_ID) private decorStyleWindowId: string = '';
  /**
   * 桌面快捷方式动作（`shortcuts_config.json` → want.parameters `dshAction`）。
   *
   * 【通道】与 `dshLaunchRouteJson`（通知路由）同构：能力层 `applyLaunchParams` 发布 →
   * 本页消费。生产入口是**本页（Web 壳）**，Index 原生壳是休眠代码（见 docs/172 §5.2）。
   *
   * 【安全边界】EntryAbility 是 exported（launcher 入口），任何应用都能构造这个参数 ⇒
   * 消费侧白名单 fail-closed（见 `applyLaunchAction`），未知 id 一律忽略。
   */
  @StorageProp('dshLaunchAction') @Watch('onLaunchActionChanged') launchAction: string = '';
  /**
   * 状态栏通知点击携带的路由（能力层 applyLaunchParams 从 want.parameters.dshRoute 解出后发布）。
   *
   * 【为什么必须有】用户反馈"通知只能清除、点不进去对应会话"：能力层发了这个键，
   * 但页面没人读 —— 点通知只把应用拉到前台。这里补上消费端，走既有的直达会话注入链路。
   */
  @StorageProp('dshLaunchRouteJson') @Watch('onLaunchRouteChanged') launchRouteJson: string = '';
  /** Web 页面是否已就绪（onPageEnd 置 true、onPageBegin 置 false） */
  private webReady: boolean = false;
  /** 页面未就绪时挂起的动作 id（至多一个，新值覆盖旧值） */
  private pendingLaunchAction: string = '';
  /** 卡片「直达会话」的载荷（与 pendingLaunchAction 一起挂起/补发） */
  private pendingOpenSessionId: string = '';
  private pendingOpenSessionTitle: string = '';
  /**
   * 已落盘的让位读数（-1 = 还没落过）。
   *
   * 【为什么要它】真正的让位是渲染期现算的（`decorTopInsetNow()`），这里存的只是**读数**；
   * 而"0 也要留下一条证据"需要一个**没落过**的哨兵 —— 否则 桌面形态（让位恒 0）永远
   * 一个字节都不写，事后没法证明 `applyDecorRect` 真跑过、且真的算出了 0。
   */
  private decorTopLogged: number = -1;
  /** 壳页创建时刻 + 是否已写过成功摘要（与 entry 壳同一口径，见那边 R10 注释）。 */
  private bootStartedAt: number = Date.now();
  private bootSummaryWritten: boolean = false;
  private decorWin: window.Window | undefined = undefined;
  /**
   * 本机是否手持形态（手机 / 平板）。判据即 platform 的 isHandheldForm()
   * （读设备事实；读不到时**按非手持**处理，保守方向 —— 宁可少收口，也不误伤桌面）。
   *
   * 【为什么在字段初始化时取，而不是 build() 里现调】顶栏"整条渲染 / 整条不渲染"由它
   * 决定，而 `build()` 里的条件渲染必须在**首帧**就拿到正确值，否则手持档会先闪一下
   * 桌面顶栏。isHandheldForm() 是同步读（带 try/catch），构造期调用与 aboutToAppear
   * 里调用等价。
   * 【它还是页面侧的唯一判据源】桥方法 `platformForm()` 就是它的镜像（见 bridges），
   * 垫片据此决定要不要给 `<html>` 挂 `dshm-handheld`（手持档整套适配的总开关）。
   */
  private handheld: boolean = isHandheldForm();
  /** 平板自由窗口的 PC 模式；由 EntryAbility 发布，Edge 还会因 handheld=false 直接进入 desktop。 */
  @StorageProp('dshPcMode') private pcMode: boolean = false;
  /**
   * 能力层转发的「返回」请求（2026-11-07）：手机壳与平板同款。
   * 侧滑在部分机型不经过页面 `onBackPress()` ⇒ 系统直接回桌面；能力层先接住再转给这里。
   */
  @StorageProp('dshBackTick') @Watch('onBackTickRequest') private backTick: number = 0;
  private backInFlight: boolean = false;

  /**
   * 本机是否**直板手机**形态（平板 / 折叠屏都不算）。判据是 platform 的 isPhoneForm()。
   * 直板手机同时启用设置横置与首次登录引导；折叠屏只在折叠态启用设置横置，登录引导保持官方。
   */
  private phone: boolean = isPhoneForm();

  /**
   * 本机是否为折叠屏（判据即 platform 的 isFoldableDevice()；读不到折叠能力时按非折叠处理）。
   *
   * 折叠屏与手机 / 平板共用同一套移动 UI；这里保留读数只为 `platformForm()` 日志和真机
   * 自证能区分三档设备，不再据此切换到另一套版式。
   */
  private foldable: boolean = isFoldableDevice();

  // ── 底部手势区沉浸（2026-10-09，见 build() 的 BOTTOM INSET）────────────────
  /**
   * 底部手势区（小白条所在）的避让高度，vp：Web 容器据此向下扩展进安全区（沉浸）。
   * 0 = 本档不扩展（桌面形态，或系统当前没有底部手势区）⇒ 页面与窗口行为与改动前
   * **逐字相同**（expandSafeArea 收到空数组 = API 明文的无效果）。
   */
  @State bottomInsetVp: number = 0;
  /**
   * 是否允许接管底部手势区：**仅手持档**（与 isHandheldForm 的收口口径一致）。
   * 关掉它就等于整条功能不存在（桌面形态路径一个字都不动），读数失败时也用它收手。
   */
  private bottomInsetArmed: boolean = false;
  /** 已应用的底部避让高度（px）：幂等闸门，避免 avoidAreaChange 重复来时重排 */
  private bottomAvoidPx: number = -1;
  /**
   * 顶部状态栏高度（vp）：窗口已 layout-fullscreen（见 EntryAbility.enterHandheldImmersive），
   * 页面内容据此下移，避免被状态栏压住；根容器的底色仍铺满到状态栏下方（= 沉浸）。
   */
  @State topInsetVp: number = 0;
  /** 已应用的顶部避让高度（px）：幂等闸门 */
  private topAvoidPx: number = -1;
  /** 本页注册的底部避让回调（aboutToDisappear 用它精确 off，不动别的监听者） */
  private bottomAvoidCb: (opt: window.AvoidAreaOptions) => void =
    (opt: window.AvoidAreaOptions): void => {
      this.onBottomAvoidChanged(opt);
    };
  /** 分屏/旋转的视口回正定时器；-1 = 无待执行 */
  private viewportReconcileTimer: number = -1;
  /** 页面就绪后的"几何落定"复检计时器（启动期 NWeb 尺寸可能早于窗口几何；见 schedulePostLoadSettle）。 */
  private postLoadSettleTimers: number[] = [];
  /** 同一轮几何变化最多补发三次（0 / 120 / 240 ms），覆盖 ArkWeb 合成层滞后 */
  private viewportReconcileAttempts: number = 0;
  /** Web 组件最近一次实际面积（vp）；同值不触发回正 */
  private lastWebAreaWidth: number = -1;
  private lastWebAreaHeight: number = -1;
  /** 软键盘是否占用底部区域；键盘期间禁止补发 resize，避免 xterm 反复重排 */
  private keyboardVisible: boolean = false;
  /** 主窗几何变化：与 EntryAbility 的几何记忆监听并存，只负责页面视口回正 */
  private onWindowGeometryChanged: () => void = (): void => {
    this.scheduleViewportReconcile('window-geometry');
  };

  // ── 窗口外观取色 ──
  @State windowBg: string = '#FFFFFF';
  /** 首页**实际**背景色（onPageEnd 采样）；非空时优先于 windowChromeFor 的固定色。 */
  @State pageBg: string = '';
  /**
   * 当前生效的明暗模式（'light' | 'dark'，空串=尚未确定）。
   *
   * 【为什么必须是 @State（报告 7 §4 的真根因）】此前它是普通 private 字段，而
   * 窗口外观和三键配色读它 ⇒ **改它不触发重渲染**，于是"状态栏变了、
   * 图标不变"（报告 7 观察到的现象）。顶栏底色 `windowBg` 是 `@State` 所以跟着变，
   * 唯独图标不动——这正是"两个值一个响应式、一个不是"的典型症状。
   * 【为什么不直接复用 windowBg 判明暗】语义不同：windowBg 是"画什么底色"，
   * 这里是"当前主题是什么"。图标/三键等图形元素按主题取色，用专门的状态更清楚。
   */
  @State themeMode: string = '';
  /**
   * 会议模式面板是否打开（Task 6）。
   * 【为什么是 @State】它直接决定 Stack 里是否渲染原生动浮层；菜单/快捷方式都只置它。
   */
  /** 会议面板是否最小化为悬浮胶囊（面板不卸载，会议继续）。 */
  /** 胶囊上的时长（由面板 onTick 回传，面板隐藏时也在跑）。 */
  /** 已应用到窗口的状态栏模式（幂等闸门；与 themeMode 分开是为了"设置失败可重试"） */
  private systemBarApplied: string = '';

  private controller: webview.WebviewController = new webview.WebviewController();
  /** `.onConsole` 实际被触发的次数（与落盘行数分开记，用于区分"回调没来"和"落盘失败"） */
  private consoleCbCount: number = 0;
  /** 目录选择桥：见类头注释。构造即建（无副作用），getter 惰性取宿主上下文 */
  private dirPickerBridge: DshDirectoryPickerBridge =
    new DshDirectoryPickerBridge(
      () => this.getUIContext().getHostContext(),
      () => this.controller,
      (ctx: common.Context): Promise<WorkspaceBrowserPickResult> => this.requestWorkspaceBrowser(ctx));

  /** API 23–25 内置工作区浏览器：打开状态与当前浏览位置。 */
  @State workspaceBrowserOpen: boolean = false;
  @State workspaceBrowserRoots: WorkspaceBrowserRoot[] = [];
  @State workspaceBrowserRootIndex: number = 0;
  @State workspaceBrowserPath: string = '';
  @State workspaceBrowserDirs: string[] = [];
  @State workspaceBrowserNote: string = '';
  /** 等待内置浏览器把结果回传给 Web 侧 pick()；生命周期与浮层一一对应。 */
  private workspaceBrowserResolver: ((result: WorkspaceBrowserPickResult) => void) | undefined = undefined;

  /**
   * API 23–25 的系统能力表里没有 FolderSelection，任意用户目录选择不可用。
   * 这里不再静默改用默认目录，而是展示应用确实可读写的两个根：
   * 应用专属 Download/<package> 与沙箱 workspace。用户可继续下钻、新建并确认。
   */
  private async requestWorkspaceBrowser(ctx: common.Context): Promise<WorkspaceBrowserPickResult> {
    const roots: WorkspaceBrowserRoot[] = [];
    let note: string = '';
    try {
      const pub: PickedFolder = await publicDownloadFolder(ctx);
      if (pub.outcome === PickOutcome.PICKED && pub.path.length > 0) {
        roots.push({ label: '应用下载目录', path: pub.path });
      } else {
        note = `应用下载目录不可用：${pub.reason}`;
      }
    } catch (err) {
      note = `应用下载目录不可用：${(err as Error).message}`;
    }
    const sandbox: string = `${ctx.filesDir}/workspace`;
    roots.push({ label: '应用沙箱', path: sandbox });
    this.workspaceBrowserRoots = roots;
    this.workspaceBrowserRootIndex = 0;
    this.workspaceBrowserPath = roots[0].path;
    this.workspaceBrowserNote = note;
    this.workspaceBrowserOpen = true;
    this.workspaceBrowserList();
    this.dirPickerBridge.writeDiagMarkerPublic('diag-workspace-browser-open',
      `api=${deviceInfo.sdkApiVersion} roots=${roots.length}`);
    return await new Promise<WorkspaceBrowserPickResult>(
      (resolve: (result: WorkspaceBrowserPickResult) => void): void => {
        this.workspaceBrowserResolver = resolve;
      });
  }

  private workspaceBrowserList(): void {
    try {
      if (!fileIo.accessSync(this.workspaceBrowserPath)) {
        fileIo.mkdirSync(this.workspaceBrowserPath);
      }
      const names: string[] = fileIo.listFileSync(this.workspaceBrowserPath);
      const dirs: string[] = [];
      for (let i = 0; i < names.length; i++) {
        const name: string = names[i];
        try {
          if (fileIo.statSync(`${this.workspaceBrowserPath}/${name}`).isDirectory()) {
            dirs.push(name);
          }
        } catch (err) {
          // 单个条目不可读不阻断整层浏览。
        }
      }
      dirs.sort();
      this.workspaceBrowserDirs = dirs;
    } catch (err) {
      this.workspaceBrowserDirs = [];
      this.workspaceBrowserNote = `读取目录失败：${(err as Error).message}`;
    }
  }

  private workspaceBrowserSwitchRoot(index: number): void {
    if (index < 0 || index >= this.workspaceBrowserRoots.length) {
      return;
    }
    this.workspaceBrowserRootIndex = index;
    this.workspaceBrowserPath = this.workspaceBrowserRoots[index].path;
    this.workspaceBrowserNote = '';
    this.workspaceBrowserList();
  }

  private workspaceBrowserEnter(name: string): void {
    this.workspaceBrowserPath = `${this.workspaceBrowserPath}/${name}`;
    this.workspaceBrowserNote = '';
    this.workspaceBrowserList();
  }

  private workspaceBrowserUp(): void {
    if (this.workspaceBrowserRootIndex < 0
      || this.workspaceBrowserRootIndex >= this.workspaceBrowserRoots.length) {
      return;
    }
    const root: string = this.workspaceBrowserRoots[this.workspaceBrowserRootIndex].path;
    if (this.workspaceBrowserPath === root) {
      this.workspaceBrowserNote = '已经在当前可访问范围的根目录。';
      return;
    }
    const cut: number = this.workspaceBrowserPath.lastIndexOf('/');
    this.workspaceBrowserPath = cut <= root.length ? root : this.workspaceBrowserPath.substring(0, cut);
    this.workspaceBrowserNote = '';
    this.workspaceBrowserList();
  }

  private workspaceBrowserCreate(): void {
    const now: Date = new Date();
    const stamp: string = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
      + `${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}`
      + `${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const path: string = `${this.workspaceBrowserPath}/工作区-${stamp}`;
    try {
      fileIo.mkdirSync(path);
      this.workspaceBrowserPath = path;
      this.workspaceBrowserNote = '';
      this.workspaceBrowserList();
    } catch (err) {
      this.workspaceBrowserNote = `新建目录失败：${(err as Error).message}`;
    }
  }

  private closeWorkspaceBrowser(result: WorkspaceBrowserPickResult): void {
    this.workspaceBrowserOpen = false;
    this.workspaceBrowserDirs = [];
    this.workspaceBrowserNote = '';
    this.dirPickerBridge.writeDiagMarkerPublic(
      result.path === null ? 'diag-workspace-browser-cancel' : 'diag-workspace-browser-choice',
      result.path === null ? result.error : result.path);
    const resolve: ((value: WorkspaceBrowserPickResult) => void) | undefined = this.workspaceBrowserResolver;
    this.workspaceBrowserResolver = undefined;
    if (resolve !== undefined) {
      resolve(result);
    }
  }
  /** 原生朗读（TextReader 优先 / textToSpeech 兜底；两壳共用平台层实现） */
  private readAloud: ReadAloud = new ReadAloud();
  /** 外观跟随桥（报告 5 §2.2）：web 侧观测到明暗变化 → 同步回调这里 */
  private themeBridge: DshThemeBridge = new DshThemeBridge((mode: string): void => {
    this.applySystemBarTheme(mode);
  });
  /**
   * 桥聚合体（2026-09-25）：把多个桥合成**一次** javaScriptProxy 注册。
   *
   * 【为什么必须聚合】WebAttribute.javaScriptProxy 只有单对象重载，链式调用两次
   * 时后者覆盖前者 —— 实测交换顺序后可见性精确对调（见 .javaScriptProxy 处注释）。
   * 所以每多一个桥，就必须并入这一个对象，而不是再加一次链式调用。
   *
   * 【新增桥的方法】在下面加一个方法，并把方法名加进 methodList。
   */
  private bridges: Record<string, Function> = {
    'startPick': (id: string): string => this.dirPickerBridge.startPick(id),
            // 网页垫片「扫描文档/提取表格」入口：只打标，input.click 在网页侧同步发起
            'startScan': (mode: number): string => {
              this.pendingScanMode = mode;
              hilog.info(DOMAIN, TAG, '网页垫片请求扫描 mode=%{public}d', mode);
              return 'ok';
            },
    'onThemeMode': (mode: string): void => this.themeBridge.onThemeMode(mode)
    ,'startNativeCapture': (): string => this.startNativeCapture()
    ,'nativeCaptureState': (): string => this.nativeCaptureState()
    ,'takeNativeCapture': (): string => this.takeNativeCapture()
    ,'cancelNativeCapture': (generation: string): string => this.cancelNativeCapture(generation)
    ,'openExternal': (url: string, mode: string): void => this.openExternal(url, mode)
    ,'openFilePreview': (path: string): string => this.openFilePreview(path)
    ,'openFileLocation': (path: string): string => this.openFileLocation(path)
    /*
     * 形态读数（2026-10-09）：侧栏垫片用它决定要不要开"移动端抽屉"（SIDEBAR_SHIM_JS §B）。
     * 【为什么必须由原生回答】手持档判据只有一处真源（platform.isHandheldForm()，
     * 读设备事实、读不到时按非手持处理）；网页侧既拿不到设备类型，也不该自己猜
     * 屏幕宽度当形态。同步返回（javaScriptProxy 只支持同步），字符串比布尔值好扩展。
     * 【移动工程口径】只回答 phone / tablet / foldable；即使调试设备上报桌面形态，也回到 tablet。
     * 设置与登录引导是否启用移动改写，再由 platformSingleScreen / phone 单独裁决。
     */
    /*
     * 本工程只发布移动壳层。即使调试设备上报桌面形态，也按 tablet 加载无顶栏、左右侧栏入口；
     * 设置面板另由 platformSingleScreen 决定横置或官方竖排。
     */
    ,'platformHandheld': (): boolean => this.handheld
    ,'platformForm': (): string => this.pcMode || !this.handheld
      ? 'desktop'
      : (this.phone ? 'phone' : (this.foldable ? 'foldable' : 'tablet'))
    ,'platformPcMode': (): boolean => this.pcMode === true
    /* 设置横置 / 登录引导共用的“当前只有一块可用屏”判据。 */
    ,'platformSingleScreen': (): boolean => this.phone || isFoldableSingleScreen()
    ,'requestSystemBack': (): void => this.requestWebRootBack()
    /*
     * 云同步状态读数（docs/320）：「设置 → 云同步」分区每秒读一次。
     * 拼 JSON 的口径在 platform 的 `encodeCloudState()` —— 与 PC / 平板壳**逐字同一份**。
     */
    ,'cloudSyncState': (): string => this.cloudSyncStateJson()
    /*
     * 云同步动作入口（docs/320）：**受理即返回**，长任务的结果由下一次 `cloudSyncState()` 反映。
     * 受理/拒绝/文案全在 `decideCloudAction()`（两个壳共用），这里只按判定去执行。
     */
    ,'cloudSyncAction': (action: string): string => this.cloudSyncAction(action)
    /* 原生朗读（2026-11-15）：Web 侧只传纯文本，合成/播放/面板/后台全在 ArkTS。 */
    ,'readAloud': (text: string): string => this.startReadAloud(text)
    ,'stopReadAloud': (): void => this.readAloud.stop()
    /* 系统分享（Share Kit）：面板形态交给系统，不自绘。 */
    ,'shareText': (text: string): string => this.sharePlainText(text)
  };

  /**
   * 把会话根目录挂到同步中枢（docs/320）。
   *
   * 【路径口径只写一次】在 platform 的 `SyncRoot` 里（与 PC / 平板壳共用）——
   * 拼错一层不会报错，只会让分区显示"0 个会话"，所以不在这里重写一遍。
   */
  private attachSyncRoot(): void {
    try {
      const ctx: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
      SyncRoot.attach(ctx === undefined || ctx === null ? '' : ctx.filesDir);
    } catch (e) {
      /* 读不到就留空：分区会显示"尚未统计"，不伪造数字 */
    }
  }

  /** 同步状态 JSON（桥 `cloudSyncState`）。 */
  private cloudSyncStateJson(): string {
    this.attachSyncRoot();
    this.refreshCloudStats();
    return encodeCloudState();
  }

  /**
   * 同步动作（桥 `cloudSyncAction`）：按共用判定分派。
   *
   * 【登录为什么不在这里弹 LoginPanel】`startAbility` 拉起承载页（`pages/WebApp`）并带上
   * `autoLogin` 参数，由那个实例在 `aboutToAppear` 里把面板与登录一起打开 ——
   * 与"在手背上再叠一层面板"相比，这条路的生命周期最干净（关掉就整个收回）。
   *
   * @param action 网页侧发来的动作名
   * @returns `{"ok":…,"message":"…"}`
   */
  private cloudSyncAction(action: string): string {
    try {
      this.attachSyncRoot();
      const st: SyncEngineState = SyncEngine.state();
      const decision: CloudActionDecision = decideCloudAction(action,
        { signedIn: st.signedIn, enabled: st.enabled, running: SyncEngine.isRunning() });
      if (!decision.ok) {
        return encodeCloudActionReply(decision);
      }
      switch (action) {
        case CLOUD_ACTION_LOGIN:
          /*
           * 【2026-10-31 修复（docs/323）】**就地静默登录，不打开任何面板**。
           *
           * 旧实现在这里置 `cloudSyncOpen = true`，于是点一下登录就整屏盖上
           * `CloudSyncSettings`（800×min(800,vh-48) + 遮罩），再在面板里静默登录 ——
           * 用户看到的仍是"跳了个二级菜单"，正是他明确要求去掉的割裂（docs/322 §7）。
           * 静默授权本来就**不需要界面**：直接调、成功后由状态回流驱动分区刷新。
           */
          this.confirmCloudLogin();
          break;
        case CLOUD_ACTION_SIGNOUT:
          SyncEngine.signOut();
          this.cloudSyncAutoLogin = false;
          break;
        case CLOUD_ACTION_ENABLE:
        case CLOUD_ACTION_DISABLE:
          this.applyCloudEnabled(action === CLOUD_ACTION_ENABLE);
          break;
        case CLOUD_ACTION_UPLOAD:
        case CLOUD_ACTION_PULL:
          this.runCloudTask(action);
          break;
        case CLOUD_ACTION_RESTORE:
          /* 逐项勾选在原生面板里做（官方分区没有多选控件） */
          this.cloudSyncAutoLogin = false;
          this.cloudSyncOpen = true;
          break;
        default:
          break;
      }
      return encodeCloudActionReply(decision);
    } catch (e) {
      const msg: string = e === undefined || e === null ? '未知错误' : String((e as BusinessError).message);
      return JSON.stringify({ ok: false, message: '执行失败：' + msg });
    }
  }

  /** 原生朗读入口（2026-11-15）：Web 侧已剥掉 Markdown，ArkTS 只做合成/播放。 */
  private startReadAloud(text: string): string {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    if (ctx === undefined) {
      return 'unavailable';
    }
    return this.readAloud.start(ctx, text);
  }

  /** 系统分享入口（Share Kit，2026-11-15）：纯文本交给系统面板。 */
  private sharePlainText(text: string): string {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    if (ctx === undefined || text.trim().length === 0) {
      return 'unavailable';
    }
    shareText(ctx, { content: text, title: 'DSHM 回答' }).then((ok: boolean): void => {
      hilog.info(DOMAIN, TAG, '系统分享面板：%{public}s', ok ? '已拉起' : '未拉起');
    }).catch((err: BusinessError): void => {
      hilog.warn(DOMAIN, TAG, '系统分享失败：%{public}s', err.message);
    });
    return 'started';
  }

  /**
   * 就地静默登录（docs/323）。
   *
   * 【为什么不用面板】`silentSignIn()` 是纯进程内调用，零界面。旧实现把它塞进
   * `CloudSyncSettings.aboutToAppear`，导致"点登录 → 先整屏盖一块原生面板 → 再登录"，
   * 与用户「直接在设置 UI 里面完成」的要求相悖。
   *
   * 【结果怎么回到界面】`cloudSyncState()` 是网页分区每秒轮询的状态源：
   * 登录成功只需 `SyncEngine.adoptLogin()`，分区下一拍就变成已登录态，不需要额外回执。
   * 失败则 toast 一条（分区里此刻没有 notice 位，用户可能正看着设置页）。
   */
  /**
   * 登录前的二次确认（2026-10-31 用户口径）：
   * 「云同步里面账户登录还是弹出确认一下，界面与设置 UI 一致」。
   *
   * 【为什么要确认】静默登录会**直接读取本机华为账号的 UnionID**，这是账号级信息，
   * 不打招呼就拿走不合适；先问一句，用户随时可以反悔。
   *
   * 【为什么用 showAlertDialog 而不是自绘】它由系统渲染，主题、圆角、按钮排布与本机
   * 其它系统弹窗完全一致 —— "界面与设置 UI 一致"靠它最稳，不必自己描一套。
   *
   * 【2026-11-05 / docs/378 文案订正】旧文案承诺「不会获取头像、昵称等资料」，
   * 但用户要求登录成功后显示自己认识的账号（手机号/邮箱而非 `****abcd`）。
   * 现在确实会再请求一次 account profile 授权 ⇒ **必须如实告知**，不能留旧承诺。
   */
  private confirmCloudLogin(): void {
    try {
      this.getUIContext().showAlertDialog({
        title: '登录华为账号',
        message: '登录后可把会话、附件与插件清单同步到华为账号。'
          + '继续后将使用华为账号登录以确定同步归属；若尚未登录，系统会打开华为账号登录/授权页面，'
          + '完成后返回本应用。应用还会请求 profile 授权以显示昵称或脱敏手机号/邮箱；可以取消，取消后不会登录。',
        autoCancel: true,
        primaryButton: {
          value: '取消',
          action: (): void => {
            /* 取消：什么都不做（弹窗自动关闭） */
          }
        },
        secondaryButton: {
          value: '登录',
          action: (): void => {
            this.runSilentLogin();
          }
        }
      });
    } catch (e) {
      /* 弹不出确认框时不静默登录：宁可这次不登录，也不绕过用户确认 */
    }
  }

  private runSilentLogin(): void {
    const ctx: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    silentSignIn(ctx).then((result): void => {
      if (result.kind === SilentSignInKind.CANCELED) {
        return;
      }
      if (result.kind === SilentSignInKind.OK) {
        SyncEngine.adoptLogin(result.unionId);
        this.toast('已登录华为账号');
        /*
         * docs/378：登录成功后**尽力**读取账号展示名（昵称 / 匿名手机号 / 匿名邮箱）。
         * 这是独立的一步：拒绝授权、设备不支持、Client ID 未生效都不影响已登录态，
         * 账号卡会退回「已登录」，绝不退回显示 `****abcd`。
         */
        fetchAccountDisplayName(ctx).then((profile): void => {
          if (profile.ok) {
            SyncEngine.adoptAccountLabel(profile.label);
          }
        }).catch((): void => {
          /* 资料读取失败不弹提示、不阻断同步：保持「已登录」即可 */
        });
      } else {
        this.toast(result.reason);
      }
    }).catch((): void => {
      this.toast('登录失败');
    });
  }

  /** 轻量提示（失败原因不能只写进状态：用户此刻可能没盯着面板）。 */
  private toast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: message, duration: 2500 });
    } catch (e) {
      /* 没有 UI 上下文：状态里仍有原因 */
    }
  }

  /** 开关落地（异步，不阻塞桥）。 */
  private applyCloudEnabled(on: boolean): void {
    SyncEngine.setEnabled(on).then((reason: string): void => {
      if (reason.length > 0) {
        this.toast(reason);
      }
    }).catch((): void => {
      /* 状态里已记录，不做假成功 */
    });
  }

  /**
   * 跑一段同步任务（上传 / 拉取+导入）。
   *
   * 结果由 `SyncEngine` 写进状态（`lastSync` / 云服务 / 进度），分区每秒读一次就会看到；
   * 失败原因额外 toast 一条，避免"用户走开了就不知道发生了什么"。
   */
  private runCloudTask(which: string): void {
    const generation: number = SyncEngine.currentGeneration();
    const ctx: common.Context = getContext(this) as common.Context;
    const task: Promise<string> = which === CLOUD_ACTION_UPLOAD
      ? SyncEngine.syncNow(ctx)
      : SyncEngine.pullAndImport(ctx);
    task.then((result: string): void => {
      if (generation !== SyncEngine.currentGeneration()) { return; }
      if (result.length > 0) {
        this.toast(result);
      }
    }).catch((e: BusinessError): void => {
      if (generation !== SyncEngine.currentGeneration()) { return; }
      this.toast(`同步失败：${e === undefined || e === null ? '未知错误' : e.message}`);
    });
  }

  /**
   * 刷新同步清单统计（会话/附件/技能/插件在同步表里的真实记录数）。
   *
   * 桥是同步契约、拿不到异步结果 ⇒ "发起刷新 + 下次读状态时拿到上次结果"，
   * 面板每秒轮询，最多一秒后显示；并发去重避免叠出一串在途查询。
   */
  private refreshCloudStats(): void {
    if (this.cloudStatsInFlight) {
      return;
    }
    /*
     * 【时间节流（2026-10-31 docs/322）】只做并发去重不够：面板轮询会让
     * "上一查刚结束、下一次又发" —— 实测在长任务期间形成连续的 RDB 查询。
     * 加一个最小间隔：`cloudStatsMinGapMs` 内直接跳过，返回**上一次**的结果
     * （面板显示的是缓存值，语义不变，最多旧这么多毫秒）。
     */
    const now: number = Date.now();
    if (now - this.cloudStatsAt < CLOUD_STATS_MIN_GAP_MS) {
      return;
    }
    this.cloudStatsAt = now;
    this.cloudStatsInFlight = true;
    const ctx: common.Context = getContext(this) as common.Context;
    SyncEngine.refreshStat(ctx).then((): void => {
      this.cloudStatsInFlight = false;
    }).catch((): void => {
      this.cloudStatsInFlight = false;
    });
  }

  /**
   * 外开入口（OPEN_LINK_SHIM_JS 的同步桥目标，2026-09-28）。
   *
   * 【为什么是同步返回 void】javaScriptProxy 只支持同步调用；外开本身是异步的
   * （`context.openLink` 返回 Promise），但调用方（垫片）不需要结果，故这里
   * fire-and-forget，与 startPick 的既有范式一致。
   *
   * 【两种模式】
   *   · mode='auto'    —— 登录授权页专用：垫片已判定是 `/dsh/authorize`，直接开，
   *                       不打扰用户（这是壳职责，与官方桌面壳行为一致）。
   *   · mode='confirm' —— 其余外链：先弹确认框，用户点「打开」才开。规范要求
   *                       外链必须二次确认，避免页面悄悄把用户带去第三方。
   *
   * 【为什么 URL 还要再校验一次】垫片里的 isHttpUrl 只是字符串前缀判断，是
   * 不可信输入（页面脚本可伪造桥调用）。这里用 platform 的 isOpenableUrl 复校，
   * 非 http(s) 一律拒绝 —— 绝不把 file:// 之类交给 openLink。
   */
  private openExternal(url: string, mode: string): void {
    const target: string = typeof url === 'string' ? url.trim() : '';
    if (target.length === 0) {
      return;
    }
    this.dirPickerBridge.writeDiagMarkerPublic('diag-openlink',
      `${mode === 'confirm' ? 'confirm' : 'auto'} ${target}`);
    hilog.info(DOMAIN, TAG, '外开请求 mode=%{public}s url=%{public}s', mode, target);
    if (!isOpenableUrl(target)) {
      hilog.warn(DOMAIN, TAG, '外开被拒（非 http/https）：%{public}s', target);
      return;
    }
    if (mode === 'confirm') {
      this.confirmOpenExternal(target);
      return;
    }
    this.launchExternal(target);
  }

  /** 弹二次确认框；确认后才 openLink。取消则什么都不做。 */
  private confirmOpenExternal(url: string): void {
    this.getUIContext().showAlertDialog({
      title: '打开外部浏览器？',
      message: url,
      autoCancel: true,
      systemMaterial: dialogMaterial(),
      primaryButton: {
        value: '取消',
        action: (): void => {
          // 空实现即全部行为：取消按钮点击后自动关闭弹窗
        }
      },
      secondaryButton: {
        value: '打开',
        action: (): void => {
          this.launchExternal(url);
        }
      }
    });
  }

  /**
   * 真正把 URL 交给系统（`context.openLink`，见 platform/system/OpenLink.ets）。
   *
   * 【失败必须让用户看见】真机上 openLink 可能因为没有可用浏览器/应用而 reject。
   * 静默失败的后果就是本次要修的那个 bug 的翻版（点了没反应），故失败弹提示；
   * 成功只记日志（不打扰）。
   */
  /**
   * 这次页内导航的目标是不是"应用之外"（与 entry 同源判据）。
   *
   * 【为什么手机也要有】此前 phone 没有 onLoadIntercept：普通锚点 / `location` 赋值
   * 会直接在本 WebView 里把应用界面替换成外部站点（只有 target=_blank 与 window.open
   * 被垫片接住）。判据复制自 entry（主机名全等白名单，先剥 userinfo，防
   * `127.0.0.1.evil.com` / `127.0.0.1@evil.com` 绕过）。
   */
  private isExternalNavigation(url: string): boolean {
    const u: string = typeof url === 'string' ? url.trim().toLowerCase() : '';
    if (u.length === 0) {
      return false;
    }
    let rest: string = '';
    if (u.startsWith('https://')) {
      rest = u.substring(8);
    } else if (u.startsWith('http://')) {
      rest = u.substring(7);
    } else {
      return false;
    }
    const authority: string = rest.split('/')[0];
    const hostPort: string = authority.split('@').pop() ?? authority;
    let host: string = hostPort;
    if (host.startsWith('[')) {
      const close: number = host.indexOf(']');
      host = close > 0 ? host.substring(0, close + 1) : host;
    } else {
      const colon: number = host.indexOf(':');
      if (colon >= 0) {
        host = host.substring(0, colon);
      }
    }
    if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') {
      return false;
    }
    return true;
  }

  private launchExternal(url: string): void {
    openExternalUrl(url).then((ok: boolean): void => {
      if (!ok) {
        this.dirPickerBridge.writeDiagMarkerPublic('diag-openlink', `failed ${url}`);
        this.getUIContext().showAlertDialog({
          title: '无法打开外部浏览器',
          message: `系统未受理该链接，请确认已安装浏览器。\n\n${url}`,
          systemMaterial: dialogMaterial(),
          confirm: {
            value: '知道了',
            action: (): void => {
              // 空实现即全部行为：确认后自动关闭弹窗
            }
          }
        });
      }
    }, (e: Error): void => {
      // openExternalUrl 内部已 catch，走到这里说明是意料外的异常：同样留痕
      this.dirPickerBridge.writeDiagMarkerPublic('diag-openlink', `error ${e.message}`);
      hilog.warn(DOMAIN, TAG, '外开异常：%{public}s', e.message);
    });
  }

  /**
   * 系统原生预览入口（OPEN_OFFICE_SHIM_JS 的同步桥目标，2026-10-04）。
   *
   * 【为什么同步返回字符串】javaScriptProxy 只支持同步调用，而 openPreview 是异步的。
   * 与 `openExternal` 同范式：这里 fire-and-forget，同步把**受理状态**回给调用方
   * （`'ok'` 已投递 / `'nouri'` 路径转 URI 失败 / `'empty'` 空路径），真正的成败由
   * 异步回调写诊断落盘 + hilog。
   *
   * 【为什么路径要再校验】桥参数是不可信输入（页面脚本可伪造调用）。这里不信任
   * 任何前缀，只做"非空 + 能转成 URI"两道；**是否允许访问该路径由系统裁决**
   * （d.ts 前置条件逐字：调用方须保证 URI 支持委托访问），我们不自己造白名单——
   * 造了也拦不住真越权，只会让合法路径被误拒。
   */
  private openFilePreview(path: string): string {
    const target: string = typeof path === 'string' ? path.trim() : '';
    if (target.length === 0) {
      hilog.warn(DOMAIN, TAG, '系统预览被拒（空路径）');
      return 'empty';
    }
    this.dirPickerBridge.writeDiagMarkerPublic('diag-file-preview', `request ${target}`);
    const uri: string = uriFromPath(target);
    if (uri.length === 0) {
      this.dirPickerBridge.writeDiagMarkerPublic('diag-file-preview', `nouri ${target}`);
      hilog.warn(DOMAIN, TAG, '系统预览：路径转 URI 失败 %{public}s', target);
      return 'nouri';
    }
    this.launchSystemPreview(target, uri);
    return 'ok';
  }

  /** 在系统文件管理界面中定位到当前预览文件；实现契约见 platform/FilePreview.ets。 */
  private openFileLocation(path: string): string {
    const target: string = typeof path === 'string' ? path.trim() : '';
    const ctx = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return 'context';
    }
    const status: string = openFileLocationPicker(ctx as common.Context, target);
    this.dirPickerBridge.writeDiagMarkerPublic('diag-file-location', `${status} ${target}`);
    return status;
  }

  /**
   * 真正调 PreviewKit（见 platform/system/FilePreview.ets）。
   *
   * 【失败必须让用户看见】真机上 openPreview 可能因 syscap 缺失（手机/平板）、
   * URI 无委托访问、同 1 秒内重复调用而失败。静默失败就是本次要修的那个 bug 的
   * 翻版（点了没反应）⇒ 失败一定弹提示 + 写 `diag-file-preview`。
   */
  private launchSystemPreview(path: string, uri: string): void {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const leaf: string = path.substring(path.lastIndexOf('/') + 1);
    const mime: string = mimeTypeForName(leaf);
    openSystemPreview(ctx, uri, leaf, mime).then((ok: boolean): void => {
      if (ok) {
        this.dirPickerBridge.writeDiagMarkerPublic('diag-file-preview', `ok ${uri}`);
        hilog.info(DOMAIN, TAG, '系统预览已弹出：%{public}s', leaf);
        return;
      }
      this.dirPickerBridge.writeDiagMarkerPublic('diag-file-preview', `failed ${uri}`);
      this.getUIContext().showAlertDialog({
        title: '系统预览未受理',
        message: `系统未能打开这个文件的预览窗。\n\n${leaf}`,
        systemMaterial: dialogMaterial(),
        confirm: {
          value: '知道了',
          action: (): void => {
            // 空实现即全部行为：确认后自动关闭弹窗
          }
        }
      });
    }, (e: Error): void => {
      this.dirPickerBridge.writeDiagMarkerPublic('diag-file-preview', `error ${e.message}`);
      hilog.warn(DOMAIN, TAG, '系统预览异常：%{public}s', e.message);
    });
  }

  /**
   * 主动申请麦克风权限（不依赖 Web 侧的 getUserMedia 触发）。
   *
   * 【为什么必须主动申请】官方流程是「Web 侧 getUserMedia → 触发
   * onPermissionRequest → 我们调 requestPermissionsFromUser」。
   * 但原生采集覆盖**绕过了 getUserMedia**（直接调 createAudioCapturer），
   * 那条申请路径永远不会被走到 ⇒ 全新安装首次点击时权限从未授予
   * ⇒ `createAudioCapturer` 失败 ⇒ 界面显示「录音中断，请重试」。
   *
   * 【真机证据】测试包 micverify 能录音，是因为它早前已授权；
   * 正式包 dshclient 是全新安装（换了签名），权限从未申请过。
   *
   * @returns 是否已获授权
   */
  /** 在用户主动点击粘贴时申请剪贴板纯文本读取权限。 */
  private async ensurePastePermission(): Promise<boolean> {
    if (this.pasteGranted) {
      return true;
    }
    const ctx = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return false;
    }
    try {
      const atManager = abilityAccessCtrl.createAtManager();
      const result: PermissionRequestResult =
        await atManager.requestPermissionsFromUser(ctx as common.Context, [PASTE_PERMISSION]);
      const granted: boolean = result.authResults.length > 0 && result.authResults[0] === GRANTED_CODE;
      this.pasteGranted = granted;
      this.dirPickerBridge.writeDiagMarkerPublic('diag-paste-permission',
        `ensurePastePermission granted=${granted} results=${JSON.stringify(result.authResults)}`);
      return granted;
    } catch (e) {
      const err = e as BusinessError;
      this.dirPickerBridge.writeDiagMarkerPublic('diag-paste-permission',
        `ensurePastePermission 抛错 code=${err.code} msg=${err.message}`);
      return false;
    }
  }

  private async ensureMicPermission(): Promise<boolean> {
    const ctx = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return false;
    }
    try {
      const atManager = abilityAccessCtrl.createAtManager();
      const result: PermissionRequestResult =
        await atManager.requestPermissionsFromUser(ctx as common.Context, [MIC_PERMISSION]);
      const granted: boolean = result.authResults.length > 0 && result.authResults[0] === GRANTED_CODE;
      this.micGranted = granted;
      this.dirPickerBridge.writeDiagMarkerPublic('diag-mic-permission',
        `ensureMicPermission granted=${granted} results=${JSON.stringify(result.authResults)}`);
      return granted;
    } catch (e) {
      const err = e as BusinessError;
      this.dirPickerBridge.writeDiagMarkerPublic('diag-mic-permission',
        `ensureMicPermission 抛错 code=${err.code} msg=${err.message}`);
      return false;
    }
  }

  private nativeCaptureGeneration: number = -1;
  private nativeCaptureDisposed: boolean = false;

  private startNativeCapture(): string {
    if (this.nativeCaptureDisposed) {
      return '';
    }
    if (this.nativeCaptureGeneration === natGeneration &&
      (natPhase === 'recording' || natPhase === 'starting')) {
      return String(natGeneration);
    }
    this.cancelNativeCapture();
    const generation: number = ++natGeneration;
    this.nativeCaptureGeneration = generation;
    natChunks = [];
    natBytes = 0;
    natPeak = 0;
    natRecent = 0;
    natRms = 0;
    natSumSq = 0;
    natSampleCount = 0;
    natPhase = 'starting';
    natStartedAt = Date.now();
    /*
     * 【先确保权限再开采集】若权限未授予就调 createAudioCapturer，
     * 会失败并被上层显示成「录音中断，请重试」—— 用户无从知道真实原因。
     * 这里先异步申请（首次会弹系统授权框），授权后再启动采集。
     * JS 侧的等待窗口已放宽以覆盖"用户点授权框"的耗时。
     */
    this.ensureMicPermission()
      .then((granted: boolean): void => {
        if (generation !== natGeneration) {
          return;
        }
        if (!granted) {
          natPhase = 'error:permission-denied';
          this.dirPickerBridge.writeDiagMarkerPublic('diag-native-error',
            '麦克风权限未授予，无法录音');
          return;
        }
        natWork = natWork.then(async (): Promise<void> => {
          if (generation === natGeneration) {
            await this.startNativeCaptureWithPermission(generation);
          }
        });
      })
      .catch((e: BusinessError): void => {
        if (generation !== natGeneration) {
          return;
        }
        natPhase = 'error:' + e.code;
        this.dirPickerBridge.writeDiagMarkerPublic('diag-native-error',
          `权限检查异常 code=${e.code} msg=${e.message}`);
      });
    return String(generation);
  }

  /** 权限已确保后真正启动采集。 */
  private startNativeCaptureWithPermission(generation: number): Promise<void> {
    return Promise.resolve().then((): Promise<audio.AudioCapturer> => audio.createAudioCapturer({
      streamInfo: {
        samplingRate: audio.AudioSamplingRate.SAMPLE_RATE_16000,
        channels: audio.AudioChannel.CHANNEL_1,
        sampleFormat: audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE,
        encodingType: audio.AudioEncodingType.ENCODING_TYPE_RAW
      },
      capturerInfo: {
        source: audio.SourceType.SOURCE_TYPE_MIC,
        capturerFlags: 0
      }
    } as audio.AudioCapturerOptions))
      .then(async (c: audio.AudioCapturer): Promise<void> => {
        if (generation !== natGeneration) {
          await this.releaseNativeCapture(c);
          return;
        }
        natCap = c;
        c.on('readData', (buf: ArrayBuffer): void => {
          if (generation !== natGeneration || natCap !== c) {
            return;
          }
          /* 必须拷贝：采集器复用 ArrayBuffer（真机踩过） */
          const v: Uint8Array = new Uint8Array(buf);
          const cp: Uint8Array = new Uint8Array(v.length);
          cp.set(v);
          natChunks.push(cp);
          natBytes += cp.length;
          /*
           * 电平统计（每 8 样本取 1），供**频谱显示**与诊断使用。
           *
           * 【为什么复用同一个循环】曾在实时回调里额外加逐样本计算，
           * 导致丢块 ⇒ VAD 失效 ⇒ 识别全灭（见 docs/70-鸿蒙移植踩坑与修复总览.md）。
           * 这里只在**原有**循环里顺带累加，不新增遍历。
           *
           * 三个量各司其职：
           *   natPeak  —— 本次录音的**累计**峰值，用于"是否录到声音"诊断
           *   natRecent—— **最近一次回调**的峰值（累计值只增不减，柱状图会一直顶格）
           *   natSumSq / natSampleCount —— 平方和与样本数，用于算 RMS
           *
           * 【频谱为什么用 RMS 而非峰值】官方波形把该值当 RMS 用
           * （height = 1 + min(1, level * 5) * 17）。用峰值会顶格：
           * 实测平静说话 peak=21020、较大声 28311 ⇒ peak/4 时前者已达 14.6/18。
           * 而 RMS 与官方一致（实测 9.1 / 11.9），起伏可见。
           */
          const dv: DataView = new DataView(cp.buffer, cp.byteOffset, cp.byteLength);
          const n: number = Math.floor(cp.length / 2);
          let localMax: number = 0;
          for (let k = 0; k < n; k += 8) {
            const s: number = Math.abs(dv.getInt16(k * 2, true));
            if (s > natPeak) {
              natPeak = s;
            }
            if (s > localMax) {
              localMax = s;
            }
            natSumSq += s * s;
            natSampleCount += 1;
          }
          natRecent = localMax;
          /*
           * 用**本批**均方根做指数平滑：既随音量起伏，又不会一帧一跳。
           * 若用整段累计，音量降下来后数值不跌（柱状图卡在高位）。
           */
          const batchRms: number = Math.sqrt(natSumSq / Math.max(1, natSampleCount));
          natRms = natRms === 0 ? batchRms : (natRms * 0.6 + batchRms * 0.4);
          natSumSq = 0;
          natSampleCount = 0;
        });
        await c.start();
        if (generation !== natGeneration) {
          return;
        }
        natPhase = 'recording';
        this.dirPickerBridge.writeDiagMarkerPublic('diag-native',
          '★ 官方按钮 → 原生采集已启动');
        hilog.info(DOMAIN, TAG, '原生听写：采集已启动');
      })
      .catch((e: BusinessError): void => {
        if (generation !== natGeneration) {
          return;
        }
        this.cancelNativeCapture();
        natPhase = 'error:' + e.code;
        hilog.error(DOMAIN, TAG, '原生听写：启动失败 %{public}s', e.message);
        /*
         * 【为什么写文件而不只打日志】本机 hilog 有丢日志前科（见
         * docs/70 与 pick() 的同类处置）：真机排查时"日志没出现"无法区分
         * "没执行"和"日志丢了"。文件是可靠的观测通道。
         */
        this.dirPickerBridge.writeDiagMarkerPublic('diag-native-error',
          `startNativeCapture 失败 code=${e.code} msg=${e.message}`);
      });
  }

  /** 采集状态（供 JS 轮询）。 */

  private nativeCaptureState(): string {
    const ms: number = natStartedAt > 0 ? Date.now() - natStartedAt : 0;
    /* rms 供频谱用；peak / recent 保留供诊断（是否录到声音、电平峰值） */
    return JSON.stringify({ phase: natPhase, bytes: natBytes, peak: natPeak,
      recent: natRecent, rms: natRms, ms: ms });
  }

  private async releaseNativeCapture(cap: audio.AudioCapturer): Promise<void> {
    try {
      await cap.stop();
    } catch (e) {
    } finally {
      try {
        await cap.release();
      } catch (e) {
      }
    }
  }

  private cancelNativeCapture(generation: string = ''): string {
    if (this.nativeCaptureGeneration !== natGeneration ||
      (generation !== '' && generation !== String(natGeneration))) {
      return '';
    }
    ++natGeneration;
    const cap: audio.AudioCapturer | undefined = natCap;
    natCap = undefined;
    natPhase = 'idle';
    natChunks = [];
    natBytes = 0;
    natPeak = 0;
    natRecent = 0;
    natRms = 0;
    natSumSq = 0;
    natSampleCount = 0;
    natStartedAt = 0;
    if (cap !== undefined) {
      try {
        cap.off('readData');
      } catch (e) {
      }
      natWork = natWork.then((): Promise<void> => this.releaseNativeCapture(cap));
    }
    return '';
  }

  private takeNativeCapture(): string {
    if (this.nativeCaptureGeneration !== natGeneration || natPhase !== 'recording') {
      this.cancelNativeCapture();
      return '';
    }
    const chunks: Uint8Array[] = natChunks;
    const total: number = natBytes;
    /*
     * 【必须在下面清零**之前**保存 peak】
     * 原实现把 `natPeak = 0` 放在前面，而诊断语句还要读它 ⇒ 永远报 peak=0，
     * 让人误判"录到的是静音"。真机证据：provider 侧收到同一份音频时 peak=28371。
     */
    const peak: number = natPeak;
    this.cancelNativeCapture();
    if (total === 0) {
      return '';
    }
    const pcm: Uint8Array = new Uint8Array(total);
    let off: number = 0;
    for (const c of chunks) {
      pcm.set(c, off);
      off += c.length;
    }
    this.dirPickerBridge.writeDiagMarkerPublic('diag-native',
      `★ 取走 ${total} 字节（${Math.round((total / 2) * 1000 / HMS_SAMPLE_RATE)}ms，peak=${peak}）`);
    const wav: Uint8Array = natPcmToWav(pcm);
    /*
     * 【落盘官方按钮那次的音频】这是唯一能定论"识别为空是音频问题还是别的问题"的办法：
     * 把这份 WAV 取回 PC 做频谱/时长分析，并与「原生听写」那次成功的音频对比。
     * 两者用的是**同一套采集与识别代码**，唯一差异是触发者（官方按钮 vs 我的菜单）。
     */
    try {
      const ctx: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
      const f: fileIo.File = fileIo.openSync(`${ctx.filesDir}/native-btn-audio.wav`,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      fileIo.writeSync(f.fd, wav.buffer as ArrayBuffer);
      fileIo.closeSync(f);
      this.dirPickerBridge.writeDiagMarkerPublic('diag-native',
        `已落盘 native-btn-audio.wav ${wav.length} 字节`);
    } catch (e) {
      this.dirPickerBridge.writeDiagMarkerPublic('diag-native',
        `落盘失败：${(e as Error).message}`);
    }
    const b64: string = new util.Base64Helper().encodeToStringSync(wav);
    hilog.info(DOMAIN, TAG, '原生听写：取走 %{public}d 字节（base64 %{public}d）', wav.length, b64.length);
    return b64;
  }

  /**
   * javaScriptOnDocumentStart 注入清单：目录选择垫片 + 桌面载体 + 外观跟随 + 外链外开
   * + 侧栏开关 + 设置面板移动端统一布局 + 市场预览列表列数 + 系统返回消费（见各自注释）。
   *
   * 【顺序无关】八个垫片各占一个 globalThis 键（`__DSH_DIRECTORY_PICKER__` /
   * `dshDesktop` / `__DSHM_OPEN_LINK_SHIM__` / `__DSHM_SIDEBAR__` /
   * `__DSHM_SETTINGS__` / `__DSHM_GRID__` / `__DSHM_BACK__`），互不读写彼此的初始化结果，
   * 只共用**同一个**同步桥对象
   * `__DSHM_BRIDGES__`（该对象由 `.javaScriptProxy` 注册，与注入顺序无先后依赖）。
   *
   * 【设置 / 引导垫片为什么排在侧栏垫片后面】它们只读 `html.dshm-compact` / `html.dshm-phone`
   * （由侧栏垫片从原生桥问到后挂上），自己不向原生桥要形态。
   *
   * 【列数垫片为什么排在这里】它同样只读 `html.dshm-handheld`，但会**包住**
   * window.matchMedia：包装本身没有先后要求（内层每次调用都重读判据），这样排只是让
   * "先立判据、再用判据"这个顺序在清单里读得出来。
   *
   * 【返回垫片排在最后】它读的是**别人的成品**（`html.dshm-handheld`、`__DSHM_SIDEBAR__`），
   * 且只在"用户划了返回"那一刻才读 —— 排在最后同样只是把依赖关系写清楚，不构成时序依赖。
   */
  private pickerShimScripts: Array<ScriptItem> = [
    /* 桥接契约层（2026-11-16）：必须最先注入，供后续垫片/页面统一调用。 */
    { script: BRIDGE_CONTRACT_JS, scriptRules: ['*'] },
    { script: PICKER_SHIM_JS, scriptRules: ['*'] },
    { script: DESKTOP_CARRIER_JS, scriptRules: ['*'] },
    { script: BRAND_SHIM_JS, scriptRules: ['*'] },
    // 会话区「加号」扫描入口（2026-11-25）：在网页 DOM 里注入两个扫描按钮
    { script: SCAN_SHIM_JS, scriptRules: ['*'] },
    { script: THEME_SHIM_JS, scriptRules: ['*'] },
    { script: OPEN_LINK_SHIM_JS, scriptRules: ['*'] },
    { script: SIDEBAR_SHIM_JS, scriptRules: ['*'] },
    /* AI 生成标识（2026-11-10）：与 entry 同源，见 AI_DISCLOSURE_SHIM_JS 头注。 */
    { script: AI_DISCLOSURE_SHIM_JS, scriptRules: ['*'] },
  { script: COMPOSER_PIN_SHIM_JS, scriptRules: ['*'] },
    /* 移动端裸 Enter = 换行（2026-11-11）：见 MOBILE_ENTER_SHIM_JS 头注。 */
    { script: MOBILE_ENTER_SHIM_JS, scriptRules: ['*'] },
    { script: MARKET_WIDE_SHIM_JS, scriptRules: ['*'] },
  { script: SETTINGS_SHIM_JS, scriptRules: ['*'] },
    { script: ONBOARDING_SHIM_JS, scriptRules: ['*'] },
      { script: BACK_SHIM_JS, scriptRules: ['*'] }
  ];

  /**
   * 本会话是否已拿到麦克风权限（**内存态，不持久化**）。
   *
   * 用途只有一处：同一个页面生命周期内 Web 侧反复请求时，不必每次都弹系统框
   * （用户会看到反复弹窗）。真正的权威状态始终在系统那边——本字段只做
   * "已经问过且通过了"的快速路径，不拿它当作绕过系统的依据。
   */
  private micGranted: boolean = false;

  /** 本会话是否已拿到剪贴板读取权限（只做系统授权后的快速路径，不替代系统状态）。 */
  private pasteGranted: boolean = false;

  /**
   * Web 文本菜单兜底：所有 input / textarea / contenteditable 的长按菜单都必须有“粘贴”。
   * 系统菜单在部分移动设备上只给自动填充；这里缺项补 PASTE，点击统一走原生剪贴板注入。
   */
  private webEditMenuOptions: EditMenuOptions = {
    onCreateMenu: (menuItems: Array<TextMenuItem>): Array<TextMenuItem> => {
      let hasPaste: boolean = false;
      for (let i: number = 0; i < menuItems.length; i++) {
        if (menuItems[i].id.equals(TextMenuItemId.PASTE)) {
          hasPaste = true;
        }
      }
      if (!hasPaste) {
        menuItems.push({
          content: $r('app.string.action_paste'),
          id: TextMenuItemId.PASTE
        });
      }
      return menuItems;
    },
    onMenuItemClick: (menuItem: TextMenuItem, _range: TextRange): boolean => {
      if (!menuItem.id.equals(TextMenuItemId.PASTE)) {
        return false;
      }
      this.pasteFromClipboard();
      return true;
    }
  };

  /**
   * 上一次已落盘的麦克风自检结果（JSON 文本）。
   * 用途：10s 一轮的 DOM 探针会反复读到同一个 `mp`，靠它去重，只写一次。
   */
  private lastMicProbe: string = '';

  /**
   * HMS 语音识别自检的中间状态（仅用于日志/诊断，不参与渲染逻辑）。
   * 放这里是为了让多个回调共享同一份结果。
   */
  private hmsEngineInfo: string = '';
  private hmsTranscript: string = '';

  /** 端到端自检（真麦克风 → HMS → 文本）的中间状态 */
  private hmsE2eTranscript: string = '';
  private hmsE2eDetail: string = '';

  private glassCapabilityDeclared: boolean = false;

  aboutToAppear(): void {
    this.startupPageActive = true;
    this.nativeCaptureDisposed = false;
    // 启动页首帧就要定深浅：web 主题还没上报，只能读系统 colorMode（见 systemAppearance）。
    this.splashDark = this.systemAppearance() === 'dark';
    /*
     * 【JD-033 修复】启动页阶段（BOOTING，宿主启动 7–9s）根容器/Stack 的底色就是状态栏那一条的
     * 实际来源；此前 `windowBg` 默认 #FFFFFF，且 applySystemBarTheme 只在阶段/外观变化时触发，
     * 于是深色系统下启动页 logo 可见期间状态栏仍是白条，直到 web 就绪才变深。
     * 首帧前先按系统深浅色初始化根容器底色，与启动页 `start_window_background` 同源。
     */
    this.windowBg = windowChromeFor(this.systemAppearance()).bg;
    /*
     * ArkWeb 网页下载落地（2026-11-15）：官方 Web 的「下载 Session 日志」是
     * `<a download>`，没有委托时任务停在 PENDING、文件不落地。安装一次全局委托，
     * 由平台层先写缓存再弹系统保存框；失败只记 diag-download，不影响页面。
     */
    const downloadCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    if (downloadCtx !== undefined) {
      installWebDownloadDelegate(downloadCtx);
    }
    if (!this.glassCapabilityDeclared) {
      this.glassCapabilityDeclared = true;
      this.dirPickerBridge.writeDiagMarkerPublic('diag-glass',
        '{"module":"phone","implemented":false,"effective":false,"reason":"phone-shell-no-glass-skin","cssSupport":null}');
    }
    // 覆盖「页面创建前 Host 已就绪」的时序：@StorageProp 初始化时就会拿到已发布的值
    if (this.launchUrl.length > 0) {
      this.enterLoading();
    }
    if (this.hostBootError.length > 0) {
      this.onHostBootErrorChanged();
    }
    this.setupDecorAvoidance();
    /*
     * 底部手势区沉浸（docs/130）：只在手持档接管，且必须在**首帧布局之前**定下来 ——
     * bottomInsetVp 是 build() 里那几处 expandSafeArea 的入参，读到 0 就整条不生效。
     */
    if (isHandheldForm()) {
      this.bottomInsetArmed = true;
    }
    this.dirPickerBridge.writeDiagMarkerPublic('diag-bottom-inset',
      `armed=${this.bottomInsetArmed}`);
    // 冷启动可能是从桌面快捷方式进来的（onCreate 带 dshAction；见 docs/172 §5.2）
    this.applyLaunchAction();
    // 冷启动也可能是点状态栏通知进来的（onCreate 带 dshRoute）
    this.applyLaunchRoute();
  }

  onPageShow(): void {
    this.applyLaunchAction();
    this.applyLaunchRoute();
  }
  /**
   * 值变化即消费（第三条消费点，覆盖"前台热启动"）。
   *
   * 【为什么要它】应用已在前台可见时，外部 startAbility（含桌面快捷方式）走
   * EntryAbility.onNewWant → 发布新值，但 **onPageShow 不会触发**（页面没离开过可见态）、
   * aboutToAppear 早已跑过 ⇒ 只有值变化回调能接住。真机判据（2026-10-16 实测）：
   * 热启动日志里 `DSHM-LAUNCH 参数解析 action=…` 与页面侧 `DSHM-ACTION 检查动作 …`
   * 成对出现（补这条之前只有前者）。
   * 三层（aboutToAppear / onPageShow / @Watch）都走同一个 `applyLaunchAction`，
   * 消费即清空 ⇒ 幂等，重复触发无副作用。
   * 同类先例：`onLaunchUrlChanged` / `onDecorKeysVisibleChanged` 均为 @StorageProp+@Watch。
   */
  private onLaunchActionChanged(): void {
    this.applyLaunchAction();
  }

  /** 值变化即消费通知路由（前台热启动点通知时 onPageShow 不会触发，靠这条接住）。 */
  private onLaunchRouteChanged(): void {
    this.applyLaunchRoute();
  }

  /**
   * 消费「点状态栏通知」携带的路由（消费即清空 + 白名单 fail-closed）。
   * 解析出 sessionId 后走与桌面卡片 `open-session` 完全相同的注入链路。
   */
  private applyLaunchRoute(): void {
    const json: string = this.launchRouteJson;
    if (json.length === 0) {
      return;
    }
    AppStorage.setOrCreate<string>('dshLaunchRouteJson', '');
    const route = parseNotifyRoute(json);
    if (route === undefined) {
      hilog.warn(DOMAIN, TAG, 'DSHM-ROUTE 路由无法解析，保持当前页面');
      return;
    }
    const sid: string = route.sessionId === undefined ? '' : route.sessionId;
    hilog.info(DOMAIN, TAG, 'DSHM-ROUTE 消费路由 page=%{public}s sid=%{public}s',
      route.page, sid.length > 0 ? '(有)' : '(无)');
    if (sid.length === 0) {
      return;
    }
    this.pendingOpenSessionId = sid;
    this.pendingOpenSessionTitle = '';
    this.dispatchWebAction('open-session');
  }

  /**
   * 消费桌面快捷方式动作（消费即清空 + 白名单 fail-closed）。
   *
   * 【为什么消费后要清掉】不清掉则此后每次回到前台都会重复执行一次
   * （"我只是切回来，它却突然开了个新会话"）。
   */
  private applyLaunchAction(): void {
    const id: string = this.launchAction;
    // 真机判据（docs/172）：每次检查都留痕（空也打），用于区分"没被调用"与"读到空值"
    hilog.info(DOMAIN, TAG, 'DSHM-ACTION 检查动作 id=%{public}s', id.length > 0 ? id : '(空)');
    this.dirPickerBridge.writeDiagMarkerPublic('diag-launch-action', `id=${id.length > 0 ? id : '(空)'}`);
    if (id.length === 0) {
      return;
    }
    AppStorage.setOrCreate<string>('dshLaunchAction', '');
    if (id === 'open-session') {
      const sid: string = AppStorage.get<string>('dshLaunchSessionId') ?? '';
      const title: string = AppStorage.get<string>('dshLaunchTitle') ?? '';
      AppStorage.setOrCreate<string>('dshLaunchSessionId', '');
      AppStorage.setOrCreate<string>('dshLaunchTitle', '');
      this.pendingOpenSessionId = sid;
      this.pendingOpenSessionTitle = title;
      this.dispatchWebAction(id);
      return;
    }
    if (id !== 'new-session') {
      hilog.warn(DOMAIN, TAG, 'DSHM-ACTION 忽略白名单外动作 id=%{public}s', id);
      return;
    }
    this.dispatchWebAction(id);
  }

  /** 把动作注入 Web 层；页面未就绪先挂起（onPageEnd 时补发）。 */
  private dispatchWebAction(id: string): void {
    if (!this.webReady) {
      this.pendingLaunchAction = id;
      hilog.info(DOMAIN, TAG, 'DSHM-ACTION 页面未就绪，挂起 id=%{public}s', id);
      return;
    }
    if (id === 'open-session') {
      this.runOpenSessionAction(this.pendingOpenSessionId, this.pendingOpenSessionTitle);
      return;
    }
    this.runNewSessionAction();
  }

  /** 注入「直达会话」脚本（卡片点击用；失败 fail-closed 只留痕）。 */
  private runOpenSessionAction(sessionId: string, title: string): void {
    hilog.info(DOMAIN, TAG, 'DSHM-ACTION 注入直达会话脚本 sid=%{public}s title=%{public}s',
      sessionId.length > 0 ? '(有)' : '(无)', title.slice(0, 40));
    try {
      this.controller.runJavaScript(buildOpenSessionScript(title, sessionId),
        (err: BusinessError, result: string) => {
          if (err) {
            hilog.warn(DOMAIN, TAG, 'DSHM-ACTION 直达会话注入失败 err=%{public}s', err.message);
            return;
          }
          hilog.info(DOMAIN, TAG, 'DSHM-ACTION 直达会话注入结果=%{public}s', result);
        });
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'DSHM-ACTION 直达会话注入异常（controller 未挂载？）');
    }
  }

  /** 注入「新建会话」点击脚本（真机判据：hilog 搜 DSHM-ACTION）。 */
  private runNewSessionAction(): void {
    hilog.info(DOMAIN, TAG, 'DSHM-ACTION 注入新建会话脚本');
    try {
      this.controller.runJavaScript(NEW_SESSION_SCRIPT, (err: BusinessError, result: string) => {
        if (err) {
          hilog.warn(DOMAIN, TAG, 'DSHM-ACTION 注入失败 err=%{public}s', err.message);
          return;
        }
        hilog.info(DOMAIN, TAG, 'DSHM-ACTION 注入结果=%{public}s', result);
      });
    } catch (e) {
      // controller 未挂载（BOOTING / ERROR 期）会抛——与既有 runJavaScript 调用同一纪律
      hilog.warn(DOMAIN, TAG, 'DSHM-ACTION 注入异常（controller 未挂载？）');
    }
  }

  aboutToDisappear(): void {
    this.nativeCaptureDisposed = true;
    this.cancelNativeCapture();
    this.startupPageActive = false;
    this.readAloud.release();
    this.stopLoadTicker();
    this.clearAutoRetry();
    if (this.viewportReconcileTimer >= 0) {
      clearTimeout(this.viewportReconcileTimer);
      this.viewportReconcileTimer = -1;
    }
    this.clearPostLoadSettle();
    if (this.decorWin !== undefined) {
      try {
        this.decorWin.off('windowTitleButtonRectChange');
        this.decorWin.off('avoidAreaChange', this.bottomAvoidCb);
        this.decorWin.off('windowSizeChange', this.onWindowGeometryChanged);
        this.decorWin.off('windowRectChange', this.onWindowGeometryChanged);
      } catch (e) {
        // 窗口已销毁等时序性异常：忽略
      }
      this.decorWin = undefined;
    }
  }

  /**
   * 三键避让（自由窗口标题栏沉浸的配套）：读一次三键区尺寸并监听变化。
   * 三键区几乎总贴窗口右边缘，避让宽度 ≈ 三键宽 + 8vp 间隙；
   * 全屏/无装饰时 width 为 0 → 保持默认 8vp。
   */
  private setupDecorAvoidance(): void {
    const ctx = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return;
    }
    window.getLastWindow(ctx).then((win: window.Window) => {
      this.decorWin = win;
      this.applyDecorRect(win.getTitleButtonRect());
      win.on('windowTitleButtonRectChange', (rect: window.TitleButtonRect) => {
        this.applyDecorRect(rect);
      });
      win.on('windowSizeChange', this.onWindowGeometryChanged);
      win.on('windowRectChange', this.onWindowGeometryChanged);
      this.applyBottomAvoid(win);
    }).catch((e: BusinessError) => {
      this.dirPickerBridge.writeDiagMarkerPublic('diag-bottom-inset', `取窗口失败 ${e.message}`);
      hilog.warn(DOMAIN, TAG, '取窗口失败，三键避让保持默认值：%{public}s', e.message);
    });
  }

  /**
   * 页面就绪后按 0.9s / 2.0s / 4.0s 再回正三次视口（2026-10-19 侧栏缺失）。
   *
   * 【为什么 onPageEnd 那一次不够】真机日志（MatePad Pro MRO-W00 / API 24）：NWeb 在窗口几何
   * 落定前就创建（`resize for emulator early failed`），`onPageEnd` 当刻 DOM 可能还没完成首帧
   * 布局，300ms 的三连发全部打在"页面还在长"的阶段；上游随后按窄视口做了布局且不再重算。
   * 用户"点一下右上角按钮"之所以能修，是因为那一下触发了真实几何变化。
   * 这里用多次延迟回正模拟同一效果（只在手持档生效，桌面形态逐字不动）。
   */
  private schedulePostLoadSettle(): void {
    this.clearPostLoadSettle();
    if (!this.handheld) {
      return;
    }
    const delays: number[] = [900, 2000, 4000];
    for (let i: number = 0; i < delays.length; i++) {
      const handle: number = setTimeout((): void => {
        this.scheduleViewportReconcile('page-end-settle-' + String(delays[i]));
      }, delays[i]);
      this.postLoadSettleTimers.push(handle);
    }
  }

  /** 清掉页面就绪复检计时器（幂等；页面重载/页面销毁都调用）。 */
  private clearPostLoadSettle(): void {
    for (let i: number = 0; i < this.postLoadSettleTimers.length; i++) {
      clearTimeout(this.postLoadSettleTimers[i]);
    }
    this.postLoadSettleTimers = [];
  }

  /**
   * Web 组件实际面积变化：仅在宽/高真的变了时触发回正。
   * 分屏旋转里原生窗口与 Web 面积会连续变多次，这里只做去重，定时器负责合并。
   */
  private onWebAreaChanged(newValue: Area): void {
    const width: number = Number(newValue.width);
    const height: number = Number(newValue.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return;
    }
    if (width === this.lastWebAreaWidth && height === this.lastWebAreaHeight) {
      return;
    }
    this.lastWebAreaWidth = width;
    this.lastWebAreaHeight = height;
    this.writeDecorTopDiag(width, height, 'area-change');
    if (this.keyboardVisible) {
      return;
    }
    this.scheduleViewportReconcile('web-area');
  }

  /** 合并几何事件，并在 0 / 120 / 240 ms 各补一次 resize（覆盖 ArkWeb 合成层滞后）。 */
  private scheduleViewportReconcile(reason: string): void {
    if (!this.handheld || !this.webReady || this.keyboardVisible) {
      return;
    }
    if (this.viewportReconcileTimer >= 0) {
      clearTimeout(this.viewportReconcileTimer);
      this.viewportReconcileTimer = -1;
    }
    this.viewportReconcileAttempts = 0;
    this.runViewportReconcile(reason);
  }

  private runViewportReconcile(reason: string): void {
    if (!this.handheld || !this.webReady || this.keyboardVisible) {
      this.viewportReconcileTimer = -1;
      return;
    }
    this.viewportReconcileAttempts += 1;
    try {
      this.controller.runJavaScript(VIEWPORT_RECONCILE_SCRIPT,
        (err: BusinessError, result: string) => {
          if (err) {
            hilog.debug(DOMAIN, TAG, '视口回正注入失败（%{public}s）：%{public}s', reason, err.message);
            return;
          }
          if (this.viewportReconcileAttempts === 1) {
            hilog.info(DOMAIN, TAG, '视口回正（%{public}s）：%{public}s', reason, result);
          }
        });
    } catch (e) {
      hilog.debug(DOMAIN, TAG, '视口回正脚本异常（%{public}s）', reason);
    }
    if (this.viewportReconcileAttempts < 3) {
      this.viewportReconcileTimer = setTimeout((): void => {
        this.runViewportReconcile(reason);
      }, 120);
    } else {
      this.viewportReconcileTimer = -1;
    }
  }

  /** 将软键盘状态同步到页面，供终端 ResizeObserver 在键盘期暂停 fit/resize。 */
  private applyWebKeyboardState(visible: boolean): void {
    if (!this.webReady) {
      return;
    }
    try {
      this.controller.runJavaScript(visible ? KEYBOARD_OPEN_SCRIPT : KEYBOARD_CLOSE_SCRIPT,
        (err: BusinessError, result: string) => {
          if (err) {
            hilog.debug(DOMAIN, TAG, '软键盘状态注入失败：%{public}s', err.message);
          } else {
            hilog.debug(DOMAIN, TAG, '软键盘状态注入：%{public}s', result);
          }
        });
    } catch (e) {
      hilog.debug(DOMAIN, TAG, '软键盘状态脚本异常');
    }
  }

  /**
   * 当前该让多少（vp）—— **渲染期求值**：`decorKeysVisible` 是能力层后发布的，
   * 走 @Watch 把结论存进状态也能跟上，但那样会有"两份口径"；直接算就没有。
   * （本类确实有一个 `onDecorKeysVisibleChanged` 的 @Watch，但它**只落诊断、不存结论**。）
   *
   * 【第二轮起不再看高度】让位量是常量（`HANDHELD_DECOR_INSET_VP`），与"系统怎么量"无关
   * ⇒ 这里只剩「谁需要让位 + 有没有三键」两个输入。
   */
  private decorTopInsetNow(): number {
    return decorTopInsetVp(this.decorKeysVisible);
  }

  private writeDecorTopDiag(width: number = this.lastWebAreaWidth,
    height: number = this.lastWebAreaHeight, source: string = ''): void {
    this.dirPickerBridge.writeDiagMarkerPublic('diag-decor-top',
      `handheld=${this.handheld} keys=${this.decorKeysVisible} ` +
        `w=${width} h=${height} inset=${this.decorTopInsetNow()} source=${source}`);
  }

  /**
   * 读窗口状态（`window.WindowStatusType` 的数字值），读不到回 `undefined`。
   *
   * 【为什么值得单独一个函数】"状态栏该不该由我们设"要看**窗口当前是不是前台且占满屏幕**
   * （判据见 `platform` 的 `statusBarOwnedByApp`）：自由窗口 / 分屏 / 后台（MINIMIZE）下
   * 设它只会把系统状态栏涂成我们的颜色（2026-10-16 平板实测：QQ 是深色、我们是一条白）。
   * `getWindowStatus()` 在能力受限设备上会抛 801 ⇒ 这里吞掉并回 `undefined`，
   * 让调用方按"信息不足 ⇒ 维持老行为"处理（那正是收窄前一直以来的行为）。
   */
  private readWindowStatus(): number | undefined {
    if (this.decorWin === undefined) {
      return undefined;
    }
    try {
      return this.decorWin.getWindowStatus();
    } catch (e) {
      return undefined;
    }
  }

  private applyDecorRect(rect: window.TitleButtonRect): void {
    // 只存**页面侧读数**（第二轮起让位量是常量，结论不再由它决定）——它只进诊断行。
    this.decorRectHeightVp = rect.height > 0 ? rect.height : 0;
    const topInset: number = this.decorTopInsetNow();
    if (this.decorTopLogged !== topInset) {
      this.decorTopLogged = topInset;
      // 落一条**可回读**的读数：真机上「三键在不在、让位算成多少」只能靠它
      // （hilog 环形缓冲只有几秒，判不了启动那一刻的事，见 docs/50 的 E385）。
      this.writeDecorTopDiag(this.lastWebAreaWidth, this.lastWebAreaHeight,
        `title-rect=${rect.width}x${rect.height}`);
    }
  }

  /**
   * 三键可见性（能力层发布）**变化**时补一条读数 —— **只写诊断，不碰渲染**。
   *
   * 【为什么必须有它】让位结论是渲染期现算的（`decorTopInsetNow()`），`@StorageProp` 一变界面自己
   * 就跟上了；但**落盘证据**只挂在 `applyDecorRect` 上，而它只在"三键区读数变了"时才写。真机上
   * 手机 / 平板的 `getTitleButtonRect()` **恒 0/0**（读数永远不变）⇒ 补这一条之前，`diag-decor-top`
   * 会永远停在能力层发布**之前**那一刻的 `keys=false`，让真机复验看起来像"让位没生效"。
   * 【为什么同步 `decorTopLogged`】刚落的这条就是当前值 ⇒ 哨兵跟着更新，避免与 `applyDecorRect`
   * 落出两条同值读数（哨兵本义就是"已经落过这个值"）。
   */
  private onDecorKeysVisibleChanged(): void {
    const inset: number = this.decorTopInsetNow();
    this.decorTopLogged = inset;
    this.dirPickerBridge.writeDiagMarkerPublic('diag-decor-top',
      `handheld=${this.handheld} keys=${this.decorKeysVisible} ` +
        `w=${this.lastWebAreaWidth} h=${this.lastWebAreaHeight} inset=${inset} ` +
        `source=keys-change rect.last=${this.decorRectHeightVp}`);
    /*
     * 窗口形态变化 ⇒ 状态栏归属要**重判**：自由窗口（三键在）交还系统、回到全屏再补设
     * （见 applySystemBarTheme 里那段注释）。幂等闸门先复位，否则"外观没变"会把这次重判挡掉。
     */
    this.systemBarApplied = '';
    this.applySystemBarTheme(this.themeMode);
  }

  /**
   * 底部手势区（小白条）避让读数 + 变化订阅。
   *
   * 【为什么读系统读数而不是写死】那条手势区的高度由系统决定（本机实测 98px；三键导航、
   * 旋转、折叠形态下都不同）。它就是根容器/Stack/Web 向下扩多少（= 沉浸）的唯一入参，写死就会
   * 在别的形态下多扩或少扩。docs/187 起只有根容器/Stack/覆盖层向下扩；Web 内容框
   * 止于系统安全区上沿，固定在使用统计栏不会再压在小白条下面。
   *
   * 【为什么两个类型都读】底部那一条在不同导航方式下报在不同类型上：手势导航是
   * TYPE_NAVIGATION_INDICATOR（本机就是它报 98）、三键导航是 TYPE_SYSTEM。故走
   * readBottomAvoidPx 的"取较大者"。键盘继续走 ArkWeb 默认避让，本页不接管。
   */
  private applyBottomAvoid(win: window.Window): void {
    if (!this.bottomInsetArmed) {
      return;
    }
    try {
      this.applyBottomInsetPx(this.readBottomAvoidPx(win));
      this.applyTopInsetPx(this.readTopAvoidPx(win));
      win.on('avoidAreaChange', this.bottomAvoidCb);
    } catch (e) {
      const err = e as BusinessError;
      this.dirPickerBridge.writeDiagMarkerPublic('diag-bottom-inset', `读数失败 ${err.message}`);
      hilog.warn(DOMAIN, TAG, '底部避让区读数失败（底部不沉浸）：%{public}s', err.message);
      this.bottomInsetArmed = false;
      this.bottomInsetVp = 0;
      this.topInsetVp = 0;
    }
  }

  /**
   * 读顶部状态栏高度（px）。
   *
   * 【为什么用 TYPE_SYSTEM】状态栏属于系统避让区；真机上 TYPE_SYSTEM 的 topRect 就是状态栏高度
   * （与 entry 同源读数，见 docs/391 §4）。
   */
  private readTopAvoidPx(win: window.Window): number {
    let sys: number = 0;
    try {
      sys = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM).topRect.height;
    } catch (e) {
      sys = 0;
    }
    this.dirPickerBridge.writeDiagMarkerPublic('diag-top-inset', `sysTop=${sys}`);
    return sys;
  }

  /**
   * 这一次的 SYSTEM top=0 是不是「瞬态」？
   *
   * 全屏 / 最大化：状态栏仍在（layout-fullscreen 只是让内容铺到它下面），
   * `avoidAreaChange` 的 0 是窗口装饰重建时的瞬态读数 → 保留上次非零。
   * 自由窗口 / 分屏：内容本来就不在状态栏下面，0 是合法读数 → 允许清零。
   */
  private shouldPreserveTopZero(): boolean {
    if (this.decorWin === undefined) {
      return true;
    }
    try {
      const status: window.WindowStatusType = this.decorWin.getWindowStatus();
      return status !== window.WindowStatusType.FLOATING
        && status !== window.WindowStatusType.SPLIT_SCREEN;
    } catch (err) {
      return true;
    }
  }

  /** 应用顶部避让（幂等：同值不重排）。 */
  private applyTopInsetPx(px: number): void {
    const rounded: number = px > 0 ? Math.round(px) : 0;
    if (rounded === 0 && this.topInsetVp > 0 && this.shouldPreserveTopZero()) {
      this.dirPickerBridge.writeDiagMarkerPublic('diag-top-inset', 'skip topPx=0（保留上次非零）');
      return;
    }
    if (rounded === this.topAvoidPx) {
      return;
    }
    this.topAvoidPx = rounded;
    this.topInsetVp = rounded > 0 ? px2vp(rounded) : 0;
    this.dirPickerBridge.writeDiagMarkerPublic('diag-top-inset',
      `apply topPx=${rounded} vp=${this.topInsetVp}`);
  }

  /**
   * 底部避让高度（px）：两个候选类型**取较大者**。
   *
   *   · TYPE_SYSTEM（0）—— 枚举注释写的是"状态栏 + 三键导航条"；
   *   · TYPE_NAVIGATION_INDICATOR（4）—— "底部导航条"（注释另有一句"OpenHarmony 设备不支持"，
   *     而 HarmonyOS 上恰恰是手势小白条所在的那一条）。
   *
   * 【为什么不写死一个】真机上到底哪个类型在报数，靠**读数**定，不靠注释猜：本机实测
   * TYPE_SYSTEM 报 0、TYPE_NAVIGATION_INDICATOR 报 98（读数见 diag-bottom-inset 与 docs/130 §4）。
   * 取较大者对两种导航方式都成立（三键导航时是 TYPE_SYSTEM 在报）。
   */
  private readBottomAvoidPx(win: window.Window): number {
    let sys: number = 0;
    let ind: number = 0;
    try {
      sys = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM).bottomRect.height;
    } catch (e) {
      sys = 0;
    }
    try {
      ind = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR).bottomRect.height;
    } catch (e) {
      ind = 0;
    }
    this.dirPickerBridge.writeDiagMarkerPublic('diag-bottom-inset',
      `sysBottom=${sys} indicatorBottom=${ind}`);
    return sys > ind ? sys : ind;
  }

  private onBottomAvoidChanged(opt: window.AvoidAreaOptions): void {
    if (opt === undefined || this.decorWin === undefined) {
      return;
    }
    if (opt.type === window.AvoidAreaType.TYPE_KEYBOARD) {
      const visible: boolean = opt.area.bottomRect.height > 0;
      if (visible === this.keyboardVisible) {
        return;
      }
      this.keyboardVisible = visible;
      this.applyWebKeyboardState(visible);
      if (visible && this.viewportReconcileTimer >= 0) {
        clearTimeout(this.viewportReconcileTimer);
        this.viewportReconcileTimer = -1;
        this.viewportReconcileAttempts = 0;
      }
      this.dirPickerBridge.writeDiagMarkerPublic('diag-bottom-inset',
        `keyboard=${visible ? 'shown' : 'hidden'}`);
      if (!visible) {
        this.scheduleViewportReconcile('keyboard-hidden');
      }
      return;
    }
    // 只认系统导航区；键盘继续走 ArkWeb 默认避让，挖孔等类型不接管。
    if (opt.type !== window.AvoidAreaType.TYPE_SYSTEM
      && opt.type !== window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR) {
      return;
    }
    this.applyBottomInsetPx(this.readBottomAvoidPx(this.decorWin));
    /* 状态栏高度也随系统条变化（旋转 / 折叠 / 导航方式），同一拍重读。 */
    this.applyTopInsetPx(this.readTopAvoidPx(this.decorWin));
  }

  /**
   * 落地底部避让高度（px → vp）。幂等：同值不重排、不重取样。
   * 避让变化意味着形态/系统条变了 ⇒ 让页面按新视口重新取样一次。
   */
  private applyBottomInsetPx(px: number): void {
    const rounded: number = px > 0 ? Math.round(px) : 0;
    if (rounded === this.bottomAvoidPx) {
      return;
    }
    this.bottomAvoidPx = rounded;
    this.bottomInsetVp = rounded > 0 ? px2vp(rounded) : 0;
    this.dirPickerBridge.writeDiagMarkerPublic('diag-bottom-inset',
      `apply bottomPx=${rounded} vp=${this.bottomInsetVp}`);
    hilog.info(DOMAIN, TAG, '底部手势区避让：%{public}dpx（%{public}s）',
      rounded, this.bottomInsetVp > 0 ? '沉浸扩展' : '不接管');
  }

  /** 宿主重启后会带新 token 再次发布：Web 的 src 变化即触发重新加载 */
  private onLaunchUrlChanged(): void {
    if (this.launchUrl.length > 0) {
      this.enterLoading();
      this.loadPreparedHostPage();
    } else {
      this.preparedLaunchUrl = '';
    }
  }

  /**
   * 核心启动是 Web 壳的前置条件。EntryAbility 明确报告不可用时直接进入 ERROR，
   * 不能等 Web 组件（尚未挂载）的加载失败重试链，否则页面会永久停在启动页。
   */
  private onHostBootErrorChanged(): void {
    if (this.hostBootError.length === 0) {
      return;
    }
    this.clearAutoRetry();
    this.loadFailed = true;
    this.errorText = this.hostBootError;
    this.phase = WebPhase.ERROR;
    this.dirPickerBridge.writeDiagMarkerPublic('diag-host-boot', `失败：${this.hostBootError}`);
    hilog.error(DOMAIN, TAG, '核心启动失败，Web 壳进入 ERROR：%{public}s', this.hostBootError);
  }

  private enterLoading(): void {
    /*
     * 【不要在这里 stopLoadTicker()】
     *
     * 踩过的坑（"进度条突然冲一下"，2026-09-27）：原实现在这里杀掉进度表，
     * 理由是"离开 BOOTING 就不该再走条"。但启动页现在**同时挂在 LOADING 上**
     * （为了盖住白屏，见 build() 的注释），于是形成矛盾：
     *   enterLoading() → 杀掉表 ⇒ 进度条**冻住**
     *   就绪 onPageEnd → `progressValue = 100` ⇒ **一次性跳到 100%**
     * 用户看到的就是"停在某个位置不动，然后突然冲一下"。
     *
     * 正确做法：进度表由 `startBrandAnimation` 启动，**只由"真的就绪/失败"停止**
     * （判据写在 ticker 内部：READY/ERROR 才停）。这样进度条在整个启动页可见期间
     * 都在按时间平滑推进，就绪时自然是"从 8x% 补到 100%"而不是从冻结值猛跳。
     */
    this.phase = WebPhase.LOADING;
    /* 新一轮加载开始：清掉上一轮的失败标记，否则 onPageEnd 会一直被拦住 */
    this.loadFailed = false;
    this.errorText = '';
    // 日志纪律：不打 token（D1 §11.5 S4），只打 authority 部分
    hilog.info(DOMAIN, TAG, '加载 Host web UI：base=%{public}s', this.baseOfLaunchUrl());
  }

  private baseOfLaunchUrl(): string {
    const cut: number = this.launchUrl.indexOf('?');
    return cut > 0 ? this.launchUrl.substring(0, cut) : this.launchUrl;
  }

  /*
   * 【与 PC 壳对齐（2026-11-26）：Web 预挂】时序：品牌动画覆盖层出现（onAppear）
   * → 等一帧（StartupWebFrameCallback）→ 仍处 BOOTING 且宿主未发布 URL ⇒
   * 置 startupWebPrepared，build() 随即把 about:blank 的 Web 挂上。垫片脚本逐条
   * 包一层 `location.href 以 about:blank 开头则不执行` 的护栏：空页不跑垫片
   * （白白污染 about:blank 的 DOM），loadUrl 导航到真实页面时照常生效。
   */
  private preparePhoneWebAfterFrame(): void {
    const prepare = (): void => {
      if (!this.startupPageActive || this.phase !== WebPhase.BOOTING || this.launchUrl.length > 0) {
        return;
      }
      this.startupDocumentScripts = this.pickerShimScripts.map((item: ScriptItem): ScriptItem => {
        return {
          script: "if (location.href.indexOf('about:blank') !== 0) {\n" + item.script + "\n}",
          scriptRules: item.scriptRules
        };
      });
      this.startupWebPrepared = true;
      hilog.info(DOMAIN, TAG, 'DSHM-TRACE 预挂 ArkWeb（about:blank）就绪');
    };
    this.getUIContext().postFrameCallback(new StartupWebFrameCallback((): void => {
      if (this.startupPageActive) {
        prepare();
      }
    }));
  }

  /*
   * 【应用帧守卫（2026-11-26 修侧栏浏览器）】onLoadIntercept 放行子帧外链后，
   * 侧栏浏览器用 <iframe> 嵌外部页面；ArkWeb 的 scriptRules 只按 URL 匹配、
   * 不分主帧/子帧 ⇒ scriptRules:'*' 的垫片会跟着注入被浏览的网页（WS/fetch
   * 包装器、链接点击劫持、CSS/DOM 注入全是污染）。每条垫片先包这层守卫：
   * 回环域名（应用自身页面，与 isExternalNavigation 同一判据族）才执行，
   * 其余（外部 iframe、about:blank —— 预挂期本就不跑垫片）整段早退。
   * 垫片间通信全走显式 globalThis/window 键（见 pickerShimScripts 头注），
   * 包进 IIFE 不改变跨脚本可见性；runJavaScript 的一次性片段不经此路。
   */
  private appFrameGuard(script: string): string {
    return '(function () {\n' +
      '  var hn = \'\';\n' +
      '  try {\n' +
      '    hn = globalThis.location && globalThis.location.hostname\n' +
      '      ? String(globalThis.location.hostname) : \'\';\n' +
      '  } catch (e) { hn = \'\'; }\n' +
      '  if (hn !== \'127.0.0.1\' && hn !== \'localhost\' && hn !== \'[::1]\') { return; }\n' +
      script + '\n' +
      '})();';
  }

  /** 预挂后 document-start 走包裹版清单；未预挂（宿主先于页面就绪等）走原清单。 */
  private webDocumentStartScripts(): Array<ScriptItem> {
    /* 【应用帧守卫】所有注入路径统一在此包一层（见 appFrameGuard 头注）。 */
    const wrap = (items: Array<ScriptItem>): Array<ScriptItem> => {
      return items.map((item: ScriptItem): ScriptItem => {
        return { script: this.appFrameGuard(item.script), scriptRules: item.scriptRules };
      });
    };
    if (this.startupWebPrepared) {
      return wrap(this.startupDocumentScripts);
    }
    return wrap(this.pickerShimScripts);
  }

  /** 预挂期的 about:blank 导航不算「整页加载」：阶段机/就绪标记全程绕过。 */
  private isStartupBlankNavigation(url: string): boolean {
    return this.startupWebPrepared && (this.launchUrl.length === 0 || url === STARTUP_BLANK_URL);
  }

  /** 预挂版导航：URL 与控制器都就位时直接 loadUrl，绕过 Web 组件冷建。 */
  private loadPreparedHostPage(): boolean {
    if (!this.startupPageActive || !this.startupWebPrepared || !this.startupControllerAttached ||
      this.launchUrl.length === 0 || this.launchUrl === this.preparedLaunchUrl) {
      return false;
    }
    const url: string = this.launchUrl;
    try {
      this.controller.loadUrl(url);
      this.preparedLaunchUrl = url;
    } catch (e) {
      this.fail('未能打开本地核心页面');
    }
    return true;
  }

  /**
   * 标记加载失败，并**排入自动重试**。
   *
   * 【为什么必须自动重试 —— 白屏的真实成因】
   * 宿主的就绪链是 `BOOT_60`（端口可连）→ `BOOT_65`（写 host-ready.json）
   * → `BOOT_70`（路由可用），**首启解包后这段要 6～7 秒**（真机实测 +6610ms）。
   * 而 WebView 的 `src` 直接绑定 `launchUrl`，只要这个值在宿主真正可用之前
   * 被置上，页面就会在"端口刚监听、路由还没挂"的窗口里发起请求 ⇒
   * 拿回 **HTTP 404**（`is_error_page=1`, `net_error=-379`）⇒ 原来直接进 ERROR 态
   * 并**永远停在那里**（只有手动点"重试"才能恢复）。
   *
   * 其他人遇到的"打开就是白屏"即此：不是崩溃，是**一次竞态后再无自愈**。
   * 修法不是消除竞态（宿主启动耗时可长可短，消除不了），而是**让页面会自己重试**。
   *
   * 【为什么用递增退避】宿主启动是秒级且不可预测；固定间隔会在宿主还没起来时
   * 空转多次。退避（0.6s → 1.2s → 2.4s → …）能在头几秒快速跟上，
   * 又不至于一直高频重试。
   *
   * @param message 展示给用户的原因（不含凭据）
   */
  private fail(message: string): void {
    this.loadFailed = true;
    this.errorText = message;
    hilog.warn(DOMAIN, TAG, 'web UI 加载失败：%{public}s', message);
    /*
     * 【为什么同时写文件】本机 hilog 有丢日志前科（项目多处记录）：
     * "日志没出现"无法区分"没执行"和"日志丢了"。排查白屏这类时序问题时，
     * 可靠的观测通道是文件（diag 标记，追加模式）。
     */
    this.dirPickerBridge.writeDiagMarkerPublic('diag-web-load',
      `失败：${message}（已排第 ${this.autoRetryCount + 1} 次自动重试）`);

    /*
     * 【关键：首次加载失败时**不要立刻**弹错误页】
     *
     * 真机实测：宿主冷启动要 6～11 秒（`BOOT_60_HTTP_BIND` 实测 +6885ms / +10703ms），
     * 而 WebView 在这个窗口里发起首次请求必然拿 404。
     * 原实现 `fail()` 里立刻 `phase = ERROR` ⇒ 用户**先看到一次**
     * 「无法连接本地核心 / Host 返回 HTTP 404」，约 600ms 后自愈又跳走。
     * 这正是"启动报错，然后又进去了"的直接原因 —— 自愈本身没问题，
     * 但**把一次内部重试暴露给了用户**。
     *
     * 处置：**只要还有自动重试预算，就留在 LOADING（继续显示启动页）**，
     * 不切到 ERROR。只有重试全部用尽（真失败）才展示错误页与「重试」按钮。
     * 这样正常冷启动全程只见启动页 → 直接就绪，用户感知不到中间那次 404。
     */
    if (this.autoRetryCount < WebApp.AUTO_RETRY_MAX) {
      hilog.info(DOMAIN, TAG,
        '首次加载未就绪（%{public}s），仍有重试预算 ⇒ 保持启动页，不展示错误页', message);
      this.phase = WebPhase.LOADING;
      // 写文件取证：本机 hilog 会丢日志，用文件才能确认这条分支真的走到了
      this.dirPickerBridge.writeDiagMarkerPublic('diag-web-load',
        `  ↳ 保持启动页（未向用户展示错误页），重试预算剩 ${WebApp.AUTO_RETRY_MAX - this.autoRetryCount} 次`);
      this.scheduleAutoRetry();
      return;
    }

    /* 重试预算用尽：这才让用户看到原因与手动重试入口 */
    this.phase = WebPhase.ERROR;
  }

  /**
   * 自动重试的最大次数（超过后停在 ERROR，由用户手动点"重试"）。
   *
   * ⚠️ 2026-10-31（docs/325）：**6 次 × 指数退避 = 37.8 秒**，而首次安装要解包
   * 330MB 的核心树，真机上远超这个窗口 —— 预算用尽后就切 ERROR，
   * 用户看到的就是"卡住进不去，杀掉重来才行"（重来那次树已解好，所以能进）。
   *
   * 现在两处改动配合：
   *   ① 本值提到 30（累计退避上限见 `AUTO_RETRY_DELAY_CAP_MS`，总等待≈2 分钟）；
   *   ② 退避加**上限**，避免 600·2^29 变成天文数字；
   *   ③ 且"宿主可能还在解包"这一判断见 `isProbablyUnpacking()` —— 那种情况下
   *      重试**不消耗预算**、一直守在启动页。
   */
  private static readonly AUTO_RETRY_MAX: number = 30;

  /**
   * 退避间隔上限（毫秒）。
   *
   * 没有上限时 `600 * 2^29` 是 89 小时 —— 那已经不是"重试"而是"永远不再试"。
   * 3 秒足够让宿主推进，也不会让用户觉得按钮失灵。
   */
  private static readonly AUTO_RETRY_DELAY_CAP_MS: number = 3000;

  /**
   * 排入一次自动重试（指数退避）。
   *
   * 覆盖所有"时序性失败"：404（路由未就绪）、连接被拒（端口未监听）、
   * 401（宿主刚重启、token 换过）。这些在重试后都能自愈。
   */
  private scheduleAutoRetry(): void {
    /*
     * 【首启解包期不计预算（docs/325）】宿主还没发布 launchUrl（说明它正在解包
     * 330MB 核心树 / 起 HTTP 服务）时，这不是"失败"，只是"还没好"。
     * 这时若按次数烧预算，用户就会经历"等 38 秒 → 错误页 → 杀掉重开"。
     */
    if (this.launchUrl.length === 0) {
      hilog.info(DOMAIN, TAG, '宿主尚未就绪（可能在解包核心树），本轮不消耗重试预算');
      this.autoRetryTimer = setTimeout(() => {
        this.autoRetryTimer = -1;
        this.retry();
      }, 1500);
      return;
    }
    if (this.autoRetryCount >= WebApp.AUTO_RETRY_MAX) {
      hilog.warn(DOMAIN, TAG, '自动重试已达上限（%{public}d 次），交给用户手动重试',
        this.autoRetryCount);
      return;
    }
    if (this.autoRetryTimer >= 0) {
      return; // 已排入，避免重复排
    }
    // 指数退避 + 上限（见 AUTO_RETRY_DELAY_CAP_MS 的注释）
    const backoff: number = 600 * Math.pow(2, Math.min(this.autoRetryCount, 8));
    const delay: number = Math.min(backoff, WebApp.AUTO_RETRY_DELAY_CAP_MS);
    this.autoRetryCount += 1;
    hilog.info(DOMAIN, TAG, '第 %{public}d 次自动重试将在 %{public}dms 后进行',
      this.autoRetryCount, delay);
    this.dirPickerBridge.writeDiagMarkerPublic('diag-web-load',
      `第 ${this.autoRetryCount} 次自动重试，延迟 ${delay}ms`);
    this.autoRetryTimer = setTimeout((): void => {
      this.autoRetryTimer = -1;
      /*
       * 【为什么直接调 retry 而不是 refresh】retry 已处理"launchUrl 仍为空"的情形
       * （退回 BOOTING 等宿主就绪），而 refresh 会对着空 URL 空转。
       */
      this.retry();
    }, delay);
  }

  private clearAutoRetry(): void {
    if (this.autoRetryTimer >= 0) {
      clearTimeout(this.autoRetryTimer);
      this.autoRetryTimer = -1;
    }
  }

  /**
   * Web 组件请求受保护资源（麦克风等）时的裁决。
   *
   * 【为什么必须实现它】官方语音 UI 的录音走浏览器
   * `navigator.mediaDevices.getUserMedia`，而**录音发生在内嵌 Web 组件里**
   * （`dsh-experimental-client-ui-voice-input` 的 `lib/client.js` 用
   * `navigator.mediaDevices` + `MediaRecorder`）。ArkWeb 默认**不授权**，
   * 页面侧只会拿到 `NotAllowedError`——用户看到的是"点了麦克风没反应"。
   * 必须在 `Web()` 上挂本回调并显式 `grant(...)`。
   *
   * 【与清单权限的分工：两者缺一不可】
   *   · `module.json5` 声明 `ohos.permission.MICROPHONE` ⇒ 系统层有该权限；
   *   · 本回调 `grant(AUDIO_CAPTURE)` ⇒ Web 内核允许页面访问麦克风。
   * 只做前者：WebView 仍拒绝；只做后者：系统层拿不到设备。
   *
   * 【为什么只放行麦克风、且只放行回环来源】本应用是开发工具宿主，
   * 不需要摄像头/MIDI。白名单比"一律 grant 页面要的一切"安全；同时要求
   * 来源是回环地址（我们自己的 Host 页面），避免页面被换成外站后仍能开麦。
   *
   * 【验收信号】每次调用都落一条 `diag-web-permission`（filesDir，追加），
   * 记录来源/请求资源/裁决——"麦克风走到哪一步"因此有硬证据可查，
   * 而不是靠界面现象猜。
   */
  private handleWebPermissionRequest(event?: OnPermissionRequestEvent): void {
    if (event === undefined || event.request === undefined) {
      return;
    }
    const req: PermissionRequest = event.request;
    let origin: string = '';
    let requested: string[] = [];
    try {
      origin = req.getOrigin();
      requested = req.getAccessibleResource();
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '权限请求读取失败：%{public}s', (e as Error).message);
      try {
        req.deny();
      } catch (ignored) {
        // deny 都失败就只能作罢：Web 侧按"未授权"处理
      }
      return;
    }

    const wantsAudio: boolean = requested.indexOf(ProtectedResourceType.AUDIO_CAPTURE) >= 0;
    /*
     * 回环判定 + "只要麦克风"判定委托给纯函数 `shouldGrantWebPermission`
     * （见 appstate/src/main/ets/model/WebPermission.ets）。
     *
     * 【为什么抽出去】这段逻辑原先内联在 @Component 里，**没有任何门禁覆盖**；
     * 2026-09-26 真机因此暴露 bug：ArkWeb 的 `getOrigin()` 返回带结尾斜杠的
     * `http://127.0.0.1:3120/`，而当时正则要求端口后立刻结束 ⇒ 判成非回环 ⇒
     * 把本应用自己的麦克风请求也 DENY（现象：diag-mic-probe 报 NotAllowedError，
     * diag-web-permission 记 `loopback=false => DENY (not-mic-or-not-loopback)`）。
     * 抽成纯函数后由 check-layout-fixtures.mjs 覆盖，同类回归不会再溜过去。
     */
    const loopback: boolean = isLoopbackOrigin(origin);

    if (!shouldGrantWebPermission(origin, requested)) {
      req.deny();
      this.logWebPermission(origin, requested, wantsAudio, loopback, false,
        loopback ? 'not-audio-only' : 'not-loopback');
      return;
    }

    /*
     * `ohos.permission.MICROPHONE` 是 **user_grant**：清单里声明只让应用"有资格要"，
     * 真正拿到必须走运行时弹窗。所以这里按需申请一次——**懒申请**而不是启动就弹，
     * 免得没用语音的人也被弹一个权限框。
     *
     * 申请是异步的，`req.grant()/deny()` 可以稍后调用（请求对象在那之前保持有效）。
     */
    if (this.micGranted) {
      req.grant([ProtectedResourceType.AUDIO_CAPTURE]);
      this.logWebPermission(origin, requested, wantsAudio, loopback, true, 'already-granted');
      return;
    }
    this.requestMicThenAnswer(req, origin, requested, wantsAudio, loopback);
  }

  /**
   * 申请麦克风权限，然后据此回答 Web 侧的请求。
   *
   * 【为什么要先问系统、再回答 Web】两者是**两道独立闸门**：
   * 系统权限没给，就算 Web 内核放行，底层仍拿不到音频设备（表现为录音静默失败）。
   * 先问系统、拿到结果再回答 Web，用户在页面上看到的失败原因才是真的。
   */
  private requestMicThenAnswer(req: PermissionRequest, origin: string, requested: string[],
    wantsAudio: boolean, loopback: boolean): void {
    const ctx = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      req.deny();
      this.logWebPermission(origin, requested, wantsAudio, loopback, false, 'no-host-context');
      return;
    }
    try {
      const atManager = abilityAccessCtrl.createAtManager();
      atManager.requestPermissionsFromUser(ctx as common.Context, [MIC_PERMISSION])
        .then((result: PermissionRequestResult) => {
          const granted: boolean =
            result.authResults.length > 0 && result.authResults[0] === GRANTED_CODE;
          this.micGranted = granted;
          if (granted) {
            req.grant([ProtectedResourceType.AUDIO_CAPTURE]);
          } else {
            req.deny();
          }
          this.logWebPermission(origin, requested, wantsAudio, loopback, granted,
            granted ? 'user-granted' : 'user-denied');
        })
        .catch((e: BusinessError) => {
          req.deny();
          this.logWebPermission(origin, requested, wantsAudio, loopback, false,
            `request-failed:${e.code}`);
        });
    } catch (e) {
      req.deny();
      this.logWebPermission(origin, requested, wantsAudio, loopback, false,
        `throw:${(e as Error).message}`);
    }
  }

  /** 权限裁决的取证（追加到 filesDir，供真机核对"走到哪一步"） */
  private logWebPermission(origin: string, requested: string[], wantsAudio: boolean,
    loopback: boolean, granted: boolean, why: string): void {
    this.dirPickerBridge.writeDiagMarkerPublic('diag-web-permission',
      `origin=${origin} requested=${requested.join(',')} audio=${wantsAudio} loopback=${loopback}`
      + ` => ${granted ? 'GRANT' : 'DENY'} (${why})`);
    hilog.info(DOMAIN, TAG,
      'Web 权限请求：origin=%{public}s 请求=[%{public}s] => %{public}s（%{public}s）',
      origin, requested.join(','), granted ? 'GRANT' : 'DENY', why);
  }

  private retry(): void {
    this.clearAutoRetry();
    this.loadFailed = false;
    if (this.hostBootError.length > 0) {
      this.phase = WebPhase.ERROR;
      this.errorText = this.hostBootError;
      return;
    }
    if (this.launchUrl.length === 0) {
      // 没有可用 URL 时回到等待：Host 可能还在启动，就绪后会经 @Watch 回来
      this.phase = WebPhase.BOOTING;
      this.errorText = '';
      // 【为什么也要排重试】launchUrl 为空的成因也是时序：EntryAbility 尚未发布。
      // 只被动等 @Watch 会漏掉"发布已发生过、但当时页面还没创建"的组合。
      this.scheduleAutoRetry();
      return;
    }
    this.phase = WebPhase.LOADING;
    this.errorText = '';
    if (this.loadPreparedHostPage()) {
      return;
    }
    try {
      this.controller.refresh();
    } catch (e) {
      // controller 未挂载等意外：如实记录，等下次 launchUrl 变化兜底
      hilog.warn(DOMAIN, TAG, 'refresh 重试失败：%{public}s', (e as Error).message);
    }
  }

  /**
   * 系统返回键 / 返回手势。
   *
   * 【为什么必须异步接线】onBackPress() 是同步契约（要立刻回 true/false），而"网页里
   * 现在有没有可关的浮层"只有 DOM 知道（runJavaScript 是异步的）⇒ 先**同步吞下**这记返回，
   *
   * 【桌面形态 逐字不动】只有 handheld 走新链；桌面档仍是"有历史才后退，否则交系统"。
   */
  onBackPress(): boolean {
    if (this.handheld) {
      this.onBackTickRequest();
      return true;
    }
    try {
      if (this.controller.accessBackward()) {
        this.controller.backward();
        return true;
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '返回键：web 后退栈不可用（%{public}s）', (e as Error).message);
    }
    if (!this.handheld) {
      return false;
    }
    this.consumeWebBack();
    return true;
  }

  private backFallbackTimer: number = -1;
  /** 本次返回是否已经有结论（兜底与回调只允许一个把动作做完） */
  private backSettled: boolean = false;
  private backRequestId: number = 0;

  private requestWebRootBack(): void {
    if (!this.handheld || this.backInFlight) { return; }
    this.consumeWebBack(true);
  }

  private onBackTickRequest(): void {
    if (!this.handheld || this.backInFlight) {
      return;
    }
    this.consumeWebBack();
  }

  private consumeWebBack(rootOnly: boolean = false): void {
    if (this.backInFlight) { return; }
    this.backInFlight = true;
    if (this.backFallbackTimer >= 0) { clearTimeout(this.backFallbackTimer); }
    const requestId: number = ++this.backRequestId;
    this.backSettled = false;
    this.backFallbackTimer = setTimeout((): void => {
      if (requestId === this.backRequestId) { this.finishWebBack('absent'); }
    }, 1200);
    try {
      this.controller.runJavaScript(
        rootOnly
          ? '(globalThis.__DSHM_BACK__ ? globalThis.__DSHM_BACK__.state() : "absent")'
          : '(globalThis.__DSHM_BACK__ ? globalThis.__DSHM_BACK__.consume() : "absent")',
        (err: BusinessError, result: string) => {
          if (requestId !== this.backRequestId) { return; }
          this.finishWebBack(err ? 'absent' : this.readWebVerdict(result));
        });
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '返回派发异常：%{public}s', String(e));
      this.finishWebBack('absent');
      return;
    }
  }

  private finishWebBack(verdict: string): void {
    if (this.backSettled) { return; }
    this.backSettled = true;
    const requestId: number = this.backRequestId;
    setTimeout((): void => {
      if (requestId === this.backRequestId) { this.backInFlight = false; }
    }, 0);
    if (this.backFallbackTimer >= 0) {
      clearTimeout(this.backFallbackTimer);
      this.backFallbackTimer = -1;
    }
    this.dirPickerBridge.writeDiagMarkerPublic('diag-web-back', verdict);
    if (verdict === 'overlay' || verdict === 'drawer' || verdict === 'panel' || verdict === 'home'
      || verdict === 'right') {
      hilog.info(DOMAIN, TAG, '手持档返回：已由网页消费（%{public}s）', verdict);
      return;
    }
    hilog.info(DOMAIN, TAG, '手持档返回：网页侧无可关的层（%{public}s）⇒ 走系统默认', verdict);
    if (verdict === 'none') { this.minimizeToBackground(); }
    else { hilog.warn(DOMAIN, TAG, '返回未确认会话根，保留当前层：%{public}s', verdict); }
  }

  /**
   * runJavaScript 的返回是**序列化字符串**（本例是 JSON 里的一个字符串字面量，带引号）。
   */
  private readWebVerdict(raw: string): string {
    let v: string = typeof raw === 'string' ? raw.trim() : '';
    if (v.length >= 2 && v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') {
      v = v.substring(1, v.length - 1);
    }
    return (v === 'overlay' || v === 'drawer' || v === 'panel' || v === 'home'
      || v === 'right' || v === 'none' || v === 'off' || v === 'duplicate' || v === 'blocked') ? v : 'absent';
  }

  /**
   * 【为什么不是 terminateSelf】手持档在根视图上按返回，系统默认就是"最小化"而不是"退出
   * 应用"；真退出另有「DSHM 菜单 → 退出应用」那条链（摘托盘 + 停核心，见 EntryAbility.exitApp）。
   * 【只在手机 / 平板调用】SDK 注明非手机 / 平板 / 穿戴 / TV 会回 16000061，故只在手持档走。
   */
  private minimizeToBackground(): void {
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      ctx.moveAbilityToBackground()
        .then((): void => { hilog.info(DOMAIN, TAG, '返回：已最小化到后台'); })
        .catch((err: BusinessError): void => {
          hilog.warn(DOMAIN, TAG, '返回：最小化失败（%{public}s）', err.message);
        });
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '返回：最小化异常（%{public}s）', (e as Error).message);
    }
  }













  /**
   * 页面阶段变化 ⇒ 窗口外观（状态栏 / 窗口底色）**重判一次**。
   *
   * 【为什么必须有它（2026-10-16 用户报"启动的时候 APP 区跟状态栏就不是一个色"）】
   * 启动期那格颜色取的是**启动页色**（按系统深浅色），首帧之后要切成应用外观色；
   * 而 `applySystemBarTheme` 的幂等闸门只认"外观" ⇒ 阶段变了它自己不会重跑（闸门会挡住）。
   * 这里先把闸门清掉再重放：启动页 → 应用界面这一跳，状态栏与窗口底色跟着换色，全程同色。
   */
  private onPhaseChanged(): void {
    this.systemBarApplied = '';
    this.applySystemBarTheme(this.themeMode);
    /* R10（2026-11-11）：每次启动都留一行耗时（口径与 entry 壳一致）。 */
    if (this.phase === WebPhase.READY && !this.bootSummaryWritten) {
      this.bootSummaryWritten = true;
      const sec: string = ((Date.now() - this.bootStartedAt) / 1000).toFixed(1);
      this.dirPickerBridge.writeDiagMarkerPublic('diag-host-boot', `成功：${sec}s（BOOTING→READY）`);
    }
  }

  /**
   * 状态栏（+ 窗口底色）跟随「设置→外观」（报告 5 §2.2）。
   *
   * 【要跟随什么】官方 ui-theme 把偏好持久化为 light/dark/system，并在首屏把**实际
   * 生效**的明暗写进 `:root{color-scheme}`。web 侧的 THEME_SHIM_JS 已把它解析成
   * 'light' | 'dark' 回传，这里只做映射（不再自己判断 system —— 那是浏览器的活）：
   *   light → 状态栏底 #FFFFFF、内容深色（isStatusBarLightIcon=false）
   *   dark  → 状态栏底 #151517、内容浅色（isStatusBarLightIcon=true）
   *
   * 【为什么同时设窗口底色】切换瞬间状态栏与 Web 内容区之间会经过一帧窗口底色；
   * 若两者不同就会"闪白"（报告 §2.2 明确要求避免）。设成同一个色即消除。
   *
   * 【失败只记日志】窗口可能尚未创建、或设备处于全屏（无状态栏）——那属正常时序，
   * 不该影响任何其他功能。同时保留**上一次成功的值**，避免抖动式重试。
   */
  /**
   * 系统当前深浅色（`'light' | 'dark'`）—— 启动页在 web 主题上报前就要取色，此时 `themeMode`
   * 还是初值，不能用；直接读 UIAbility 的 `Configuration.colorMode`。应用 `setColorMode(NOT_SET)`
   * 时它是系统值，用户固定外观时它是应用值，两种都等于「当前实际显示」，与
   * `startWindowBackground` 的资源解析同源。
   */
  private systemAppearance(): string {
    try {
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      if (ctx !== undefined
        && ctx.config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK) {
        return 'dark';
      }
    } catch (e) {
      // 取不到按浅色（与官方 boot 的 color-scheme:light 一致）
    }
    return 'light';
  }

  /**
   * 采样网页**实际背景色**，用它填状态栏那条（2026-11-21 移动端沉浸修复）。
   *
   * 状态栏透明（layout-fullscreen + SYSTEM_BAR_HANDOFF_BG）后，露出的就是窗口/根容器底色。
   * 之前取固定的 `windowChromeFor` 色（深 `#151517` / 浅 `#FFFFFF`）⇒ 与官方 Web 自己的背景
   * 有色差，深色下表现为状态栏一条与页面割裂的色带。改为读首页真实背景：状态栏与页面天然同色。
   */
  private samplePageBackground(): void {
    if (this.decorWin === undefined) {
      return;
    }
    const js: string = '(function(){try{'
      + 'function bg(el){var c="";try{c=getComputedStyle(el).backgroundColor||"";}catch(e){return "";}'
      + 'if(!c||c==="transparent"||c==="rgba(0, 0, 0, 0)"){return "";}return c;}'
      + 'return bg(document.body)||bg(document.documentElement)||"";}catch(e){return "";}})()';
    try {
      this.controller.runJavaScript(js, (err: BusinessError, result: string) => {
        if (err) {
          return;
        }
        this.applyPageBackground(typeof result === 'string' ? result : '');
      });
    } catch (e) {
      // controller 未挂载：下一轮 onPageEnd 再采
    }
  }

  /** 把 `rgb()/rgba()` 采样结果落到窗口/根容器底色；透明色不采纳。 */
  private applyPageBackground(css: string): void {
    const m: RegExpExecArray | null =
      /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(css);
    if (m === null) {
      return;
    }
    const alpha: number = m[4] === undefined ? 1 : Number(m[4]);
    if (!(alpha >= 0.5)) {
      return;
    }
    const hex2 = (v: string): string => {
      const h: string = Number(v).toString(16).toUpperCase();
      return h.length < 2 ? '0' + h : h;
    };
    const hex: string = '#' + hex2(m[1]) + hex2(m[2]) + hex2(m[3]);
    if (this.pageBg === hex) {
      return;
    }
    this.pageBg = hex;
    this.windowBg = hex;
    const win: window.Window | undefined = this.decorWin;
    if (win !== undefined) {
      try {
        win.setWindowBackgroundColor(hex);
      } catch (e) {
        // 窗口未就绪：忽略
      }
    }
    hilog.info(DOMAIN, TAG, '页面背景采样：%{public}s（状态栏随之同色）', hex);
  }

  private applySystemBarTheme(mode: string): void {
    // 【2026-10-10 加固：先发布外观 + 重设三键，再吃幂等闸门】
    // ① 发布：能力层在窗口状态变化时要按"当前外观"重放三键配色，而它拿不到页面的 @State
    //    ⇒ 必须有这条跨层约定键（口径与 KEY_DECOR_KEYS_VISIBLE 同）。
    // ② 重设三键：闸门只挡"状态栏属性 / 窗口底色"（重复设没有意义），**不挡三键** —— 三键配色
    //    属于窗口装饰态，平台可能丢弃；被闸门挡住就再没机会补上（2026-10-05「深色外观下黑底黑键」
    //    那次回归的另一半根因）。顺带修掉"窗口未就绪那次调用丢了、同模式的后续通知不重设"的空窗。
    AppStorage.setOrCreate<string>(KEY_APPEARANCE_MODE, mode);
    this.applyDecorButtonMode(mode);
    if (this.systemBarApplied === mode) {
      return; // 幂等：同一个模式不重复设（web 侧已做过变化判断，这里是第二道闸）
    }
    this.systemBarApplied = mode;
    this.themeMode = mode; // @State：图标/三键等图形元素据此取色（见字段注释）
    // 取色只有一份真源（平台侧 windowChromeFor）：能力层在切后台时的"再收敛一次"用同一份，
    // 见 platform/.../WindowChrome.ets 与 docs/166 §2 的竞态说明。
    const chrome = windowChromeFor(mode);
    /*
     * 【启动期取色：状态栏 / 窗口底色跟启动页同色】（2026-10-16 用户报"启动的时候 APP 区跟状态栏就不是一个色"）
     *
     * 启动期原本有三处浅色各说各话：`startWindowBackground = #FFFFFF`（首帧窗口底色）、启动视图自己画的
     * `#F3F7FB`、窗口外观的浅色也是 `#FFFFFF` ⇒ 用户看到"状态栏一条纯白 + 底下 `#F3F6FB` 的启动页"。
     * 现在三处统一取「启动页色」（`start_window_background` 资源 与 `windowChromeFor(系统色)` 同源）：
     * splash 还没让位（BOOTING，或首次 LOADING）时状态栏与窗口底色都用它；首帧之后按外观切换。
     * **只换"我们拥有的那格颜色"** —— 是否拥有仍由下面的 `statusBarOwnedByApp` 判（自由窗口下照样交还系统）。
     */
    const splashUp: boolean = this.phase === WebPhase.BOOTING
      || (this.phase === WebPhase.LOADING && !this.everReady);
    /*
     * 【2026-11-21 启动背景跟随系统】启动页不再恒为白：按系统当前深浅色取同一份窗口色
     * （`windowChromeFor`），与窗口底色/启动视图同源，深色系统下从首帧起就是深底浅图标。
     */
    const splashChrome = windowChromeFor(this.systemAppearance());
    const barBg: string = splashUp ? splashChrome.bg : chrome.bg;
    const lightIcon: boolean = splashUp ? splashChrome.lightIcon : chrome.lightIcon;
    const contentColor: string = splashUp ? splashChrome.content : chrome.content;
    // 顶栏（自绘）也随之翻转：官方外观是浅色→白底黑字，深色→黑底白字。
    // 【注意】这与"顶栏恒定白底黑字"的旧口径不同：报告 5 要求的是**跟随外观**，
    // 故这里按 mode 同时更新自绘顶栏，保证状态栏与顶栏不会是两种观感。
    // 【顶栏不取启动页色】它只在应用界面里出现 ⇒ 始终按外观取色，否则"启动页让位"那一刻顶栏会慢一拍。
    // 页面已采样到真实背景时以它为准：状态栏与页面同色（深色下不再出现割裂色带）。
    this.windowBg = this.pageBg.length > 0 ? this.pageBg : chrome.bg;
    // 【2026-10-05 回归修复】三键配色必须与顶栏底色**同一拍**设置。
    // 见 applyDecorButtonMode 的完整注释：漏了这一步 ⇒ 深色外观下"黑底黑键、三键看不见"。
    this.applyDecorButtonMode(mode);
    if (this.decorWin === undefined) {
      hilog.info(DOMAIN, TAG, '状态栏跟随外观：%{public}s（窗口未就绪，下次重试）', mode);
      // 别把幂等闸门锁在"未真正应用"的状态上：清掉它，窗口就绪后的下一次调用才会补齐
      // （与下面 catch 里失败时清闸门的处理保持一致）。
      this.systemBarApplied = '';
      return;
    }
    /*
     * 【手持档自由窗口：状态栏交还系统、一个字段都不设】（2026-10-16 平板实测）
     *
     * 证据：同一台 MatePad Pro 12.2（鸿蒙 6.1）上，QQ 的自由窗口 → 系统状态栏是深色（跟着桌面），
     * 我们的自由窗口 → 整条被涂成浅色的 `#FFFFFF`（浅色外观）⇒ 截图里"顶栏一条白"。
     * SDK 原文（`@ohos.window.d.ts` 的 `setWindowSystemBarProperties`）："The setting does not take
     * effect when the main window is in non-full-screen or non-maximized mode (such as floating windows
     * or split-screen mode)." —— 按契约这条属性**只在全屏 / 最大化态生效**，自由窗口下该由系统按
     * 桌面 / 分屏背景自己画。真机上它却把系统状态栏涂了色 ⇒ 我们只在"窗口真的占满屏幕"时才设。
     *
     * 判据是**窗口当前状态**（`platform` 的纯函数 `statusBarOwnedByApp`）：手持档里只有
     * `FULL_SCREEN(1)` / `MAXIMIZE(2)` 才由我们设；`FLOATING(4)` 自由窗口、`SPLIT_SCREEN(5)` 分屏、
     * `MINIMIZE(3)` 后台一律**交还系统**（用户报的两种形态正好各占一条：自由窗口 + 切后台）。
     * 桌面形态 不进这条（`this.handheld` 为假 ⇒ 逐字不动）；状态读不到（801）⇒ 维持老行为。
     *
     * 【为什么不锁幂等闸门】形态是**会变**的（用户可最大化 / 还原）：跳过时把 `systemBarApplied`
     * 清掉，回到全屏时（三键消失 → `onDecorKeysVisibleChanged`）才能立刻补设。
     */
    const winStatus: number | undefined = this.readWindowStatus();
    if (!statusBarOwnedByApp(this.handheld, winStatus)) {
      this.systemBarApplied = '';
      /*
       * 【交还要**显式**做：底色置透明】（2026-10-16 用户第二次报障：多任务视图状态栏是 `#151517"`）
       *
       * 这套属性是窗口级的一次写入，谁最后写谁说话。"切后台时什么都不做"只是不覆盖 ⇒ 前台的
       * `#151517` 会留在系统状态栏上，直到别的应用去写。所以这里把底色写成**全透明**
       * （`SYSTEM_BAR_HANDOFF_BG`），露出桌面 / 壁纸 / 多任务背景；**不动图标色**（那块背景不是我们的，
       * 实测正常路径里系统/启动器会自己重画状态栏）。详见 platform/.../WindowChrome.ets 的常量注释。
       */
      try {
        this.decorWin.setWindowSystemBarProperties({ statusBarColor: SYSTEM_BAR_HANDOFF_BG })
          .catch((e: BusinessError): void => {
            hilog.debug(DOMAIN, TAG, '交还状态栏底色的异步拒绝 code=%{public}d：%{public}s', e.code, e.message);
          });
        hilog.info(DOMAIN, TAG,
          '状态栏交还系统：%{public}s —— 手持档非全屏（status=%{public}s）⇒ 底色置透明', mode,
          winStatus === undefined ? 'unknown' : String(winStatus));
      } catch (e) {
        hilog.debug(DOMAIN, TAG, '交还状态栏底色失败（忽略）：%{public}s', (e as BusinessError).message);
      }
    } else {
      try {
        this.decorWin.setWindowSystemBarProperties({
          /* 手持档已 layout-fullscreen（EntryAbility.enterHandheldImmersive）：底色透明，
             让根容器自己的底色/页面铺到状态栏下方；图标明暗仍按外观设。 */
          statusBarColor: this.handheld ? SYSTEM_BAR_HANDOFF_BG : barBg,
          statusBarContentColor: contentColor,
          isStatusBarLightIcon: lightIcon
        }).catch((e: BusinessError): void => {
          // 这套 API 返回 Promise（`@ohos.window.d.ts` @since 9）：同步 try/catch 抓不到异步拒绝，
          // 补一条 catch，否则 801 / 1300002 只会变成一个无人处理的 rejection。
          hilog.warn(DOMAIN, TAG, '状态栏配色设置失败（异步，全屏等场景属正常）code=%{public}d msg=%{public}s',
            e.code, e.message);
          this.systemBarApplied = ''; // 允许下次再试（例如窗口后来才就绪）
        });
        hilog.info(DOMAIN, TAG, '状态栏已跟随%{public}s：%{public}s bg=%{public}s',
          splashUp ? '启动页' : '外观', mode, barBg);
      } catch (e) {
        const err = e as BusinessError;
        hilog.warn(DOMAIN, TAG, '状态栏配色设置失败（全屏等场景属正常）code=%{public}d msg=%{public}s',
          err.code, err.message);
        this.systemBarApplied = ''; // 允许下次再试（例如窗口后来才就绪）
        return;
      }
    }
    try {
      this.decorWin.setWindowBackgroundColor(this.windowBg);
    } catch (e) {
      // 窗口底色失败不影响状态栏本身；闪白风险由"下次成功时再设"覆盖
      hilog.debug(DOMAIN, TAG, '窗口底色设置失败（忽略）');
    }
  }

  /** 顶栏底色/文字色 + 三键 colorMode 跟随「设置→外观」。
   * 【2026-09-26 起改为"跟随外观"（报告 5 §2.2）】此前这里是"恒定白底黑字"。现在
   * 顶栏与状态栏一起跟随「设置→外观」。THEME_SHIM_JS 通过
   * MutationObserver/matchMedia 即时通知 applySystemBarTheme(mode)。
   */
  /**
   * 三键（全屏/最小化/关闭）配色跟随**顶栏底色**。
   *
   * 【为什么必须单独成方法（2026-10-05 真机回归，用户报"右上角三个按钮消失、只剩一个关闭"）】
   * 自绘顶栏自 2026-09-26 起**跟随外观**：深色外观下顶栏是 `#151517`。而三键的颜色模式
   * 原先只在两处被设置：
   *   ① `EntryAbility` 创建窗口时**强制** `COLOR_MODE_LIGHT`（深色图标——那是给当年
   *      "恒白底顶栏"配的）；
   *   ② 页面主题桥的 `applySystemBarTheme`。
   * 现在主通道与窗口装饰更新同一拍执行，三键不会脱离顶栏外观。
   *
   * ⇒ 结论：三键配色收进**同一个** `applySystemBarTheme`——顶栏是什么底色，三键就用配套明暗。
   * 全屏/无装饰场景该调用会抛，吞掉即可（功能等价 no-op）。
   */
  private applyDecorButtonMode(mode: string): void {
    if (this.decorWin === undefined) {
      return;
    }
    if (this.handheld) {
      if (!this.decorStyleWritable) {
        return;
      }
      try {
        if (String(this.decorWin.getWindowProperties().id) !== this.decorStyleWindowId) {
          return;
        }
      } catch (e) {
        return;
      }
    }
    try {
      this.decorWin.setDecorButtonStyle({
        colorMode: mode === 'dark'
          ? ConfigurationConstant.ColorMode.COLOR_MODE_DARK
          : ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT
      });
    } catch (e) {
      // 手机全屏（无窗口装饰）等场景：忽略
    }
  }


  // ── 启动加载页品牌动效 ────────────────────────────────────────────────
  // logo 与进度条首帧直接一起出现 → logo 常驻呼吸（1800ms EaseInOut 往返，
  // 延迟 720ms）。幂等：ticker 已在跑则只补动画。
  private startBrandAnimation(): void {
    /*
     * 【2026-10-30 换标 + 动效改用物理弹簧（用户口径："开屏启动动画调用这个特性 curves.springMotion"）】
     * 与 PC / 平板壳**同一份口径**（两端表现必须一致，否则同一个应用在两台设备上"手感不同"）：
     *   · 淡入 `springMotion(0.42, 0.86)`：略欠阻尼，落定有极轻一下；
     *   · 呼吸 `springMotion(0.62, 0.62)`：明显欠阻尼，往复带惯性与过冲。
     * 弹簧**没有 duration 参数**（SDK：时长由参数与上一帧速度决定）——
     * 进度条那条仍是匀速线性，不吃弹簧（见下面长注释）。
     */
    animateTo({ curve: curves.springMotion(0.42, 0.86), delay: 80 }, () => {
      this.brandOpacity = 1;
    });
    animateTo({
      curve: curves.springMotion(0.62, 0.62),
      iterations: -1,
      playMode: PlayMode.Alternate,
      delay: 720,
    }, () => {
      this.brandBreath = 1.09;
    });
    if (this.loadTicker === -1) {
      this.progressValue = 0;
      this.progressFinishing = false;
      /*
       * 【进度条为什么要"时间驱动"而不是"事件驱动"】
       * 宿主启动耗时**不可预知**：正常约 8 秒（主体是 dsh 的插件初始化），
       * 首启解包核心树时可达 30–60 秒。没有任何可读的真实进度源
       * （`BOOT_xx` 只在宿主 stdout，ArkTS 读不到中间值）。
       *
       * ── 曲线：**匀速直线**，不是指数衰减 ──
       *
       * 前两版都用指数 `90·(1−e^(−t/τ))`，用户两次反馈"冲"。实测速度分布是关键：
       *     τ=3.2s ⇒ t=0s 时 **28.1 %/s**，t=8s 时 **2.3 %/s** —— **相差 12 倍**。
       * 也就是"开头猛冲、后面几乎不动"，主观感受就是"一上来就窜出去"。
       * 指数曲线天然不匀速，**再怎么调 τ 也治不好"冲"**（调小 τ 更冲）。
       *
       * 改成**匀速主段 + 极慢收尾**（按实测 ~8 秒启动标定）：
       *   · 主段 PROGRESS_RATE %/s（≈11.5）匀速推进到 ~92%
       *   · 之后以 0.3 %/s 慢爬，上限 98%（**永不自走到 100%**）
       *   · 100% 只由"真的就绪"宣告（见 finishProgress）
       * 好处：① 从 0 开始就是稳定速度，**没有起步冲刺**；
       *       ② 8 秒时已达 ~92%，收尾只差 ~8 个点 ⇒ 结束时不"冲"；
       *       ③ 首启 60 秒时也只是慢爬到 98% 停住，不会跑满一圈重来。
       *
       * ── 另外两个为"丝滑"做的决定 ──
       * ① **不取整**。`Math.floor` 会让整数位连续多拍不变（看着像卡住），
       *    攒够再跳一格 —— 那也是"冲"的一部分。`Progress.value` 接受浮点。
       * ② **节拍 40ms（25fps）**。8fps 无论曲线多平滑都能看出"一格一格"。
       */
      this.loadStartedAt = Date.now();
      this.loadTicker = setInterval((): void => {
        /* ── 收尾阶段：从当前值平滑补到 100%（而不是"一把设 100"）── */
        if (this.progressFinishing) {
          const ft: number = (Date.now() - this.progressFinishAt) / WebApp.PROGRESS_FINISH_MS;
          if (ft >= 1) {
            this.progressValue = 100;
            this.progressFinishing = false;
            this.stopLoadTicker();
            return;
          }
          /* ease-out cubic：起步快、结尾缓，收得干净不突兀 */
          const fe: number = 1 - Math.pow(1 - ft, 3);
          this.progressValue = this.progressFinishFrom + (100 - this.progressFinishFrom) * fe;
          return;
        }

        /* ── 常规阶段：匀速推进 ── */
        if (this.phase === WebPhase.READY || this.phase === WebPhase.ERROR) {
          this.stopLoadTicker();
          return;
        }
        const elapsed: number = Date.now() - this.loadStartedAt;
        const straight: number = (elapsed / 1000) * WebApp.PROGRESS_RATE;
        if (straight <= WebApp.PROGRESS_CREEP_AT) {
          this.progressValue = straight;
        } else {
          /* 过了拐点：以极慢速度继续爬，上限 98% */
          const tAtCreep: number = (WebApp.PROGRESS_CREEP_AT / WebApp.PROGRESS_RATE) * 1000;
          const creep: number = ((elapsed - tAtCreep) / 1000) * WebApp.PROGRESS_CREEP_RATE;
          this.progressValue = Math.min(WebApp.PROGRESS_CEIL, WebApp.PROGRESS_CREEP_AT + creep);
        }
      }, 40);
    }
  }

  /**
   * 就绪时把进度条**平滑**补到 100%，然后停表。
   *
   * 【为什么不能直接 `progressValue = 100`】实测就绪时进度约在 80% 左右，
   * 一把设 100 就是"突然冲一下"。这里改用 ~380ms 的缓出曲线补完，
   * 让"完成"这件事看得见、又不突兀。
   */
  private finishProgress(): void {
    if (this.loadTicker < 0) {
      /* 表没在跑（例如极快的启动、splash 还没触发动画）⇒ 直接到位即可 */
      this.progressValue = 100;
      return;
    }
    this.progressFinishFrom = this.progressValue;
    this.progressFinishAt = Date.now();
    this.progressFinishing = true;
  }

  private stopLoadTicker(): void {
    if (this.loadTicker >= 0) {
      clearInterval(this.loadTicker);
      this.loadTicker = -1;
    }
  }

  /** 粘贴：先完成运行时授权，再读系统剪贴板 → 注入 web 当前焦点处。 */
  private async pasteFromClipboard(): Promise<void> {
    if (this.phase === WebPhase.BOOTING) {
      return;
    }
    const granted: boolean = await this.ensurePastePermission();
    if (!granted) {
      hilog.warn(DOMAIN, TAG, '剪贴板读取权限未授予，忽略本次粘贴');
      return;
    }
    try {
      const board: pasteboard.SystemPasteboard = pasteboard.getSystemPasteboard();
      const data: pasteboard.PasteData = await board.getData();
      const text: string | undefined = data.getPrimaryText();
      if (text === undefined || text.length === 0) {
        return; // 空剪贴板：与桌面「粘贴无内容」一致，静默
      }
      // JSON.stringify 把任意文本（引号/换行/反斜杠）编码成安全 JS 字面量
      const js: string = `document.execCommand('insertText', false, ${JSON.stringify(text)})`;
      this.controller.runJavaScript(js);
      await hapticTap();
    } catch (e) {
      const err = e as BusinessError;
      hilog.warn(DOMAIN, TAG, '剪贴板读取失败：code=%{public}d msg=%{public}s', err.code, err.message);
    }
  }

  /** 品牌标识动画属性：启动页大标识（logo_dark 品牌标）呼吸/淡入，顶栏按钮恒为静态。 */
  private markScale(animated: boolean): ScaleOptions {
    return animated ? { x: this.brandBreath, y: this.brandBreath } : { x: 1, y: 1 };
  }

  /** 品牌标识的不透明度（与 PC / 平板壳同一套：动画态读状态、静态态恒 1）。 */
  private markOpacity(animated: boolean): number {
    return animated ? this.brandOpacity : 1;
  }

  /** Web 容器扩展进哪些非安全区：只有真的接管底部时才扩展（空数组 = 不扩展，API 明文无效果） */
  private bottomSafeAreaTypes(): Array<SafeAreaType> {
    return this.bottomInsetVp > 0 ? [SafeAreaType.SYSTEM] : [];
  }

  private bottomSafeAreaEdges(): Array<SafeAreaEdge> {
    return this.bottomInsetVp > 0 ? [SafeAreaEdge.BOTTOM] : [];
  }

  @Builder
  WorkspaceBrowserOverlay() {
    Column() {
      Column({ space: Sp.S }) {
        Text('选择工作区')
          .fontSize(Fs.TITLE_M)
          .fontWeight(FontWeight.Bold)
          .width('100%')
        Text(`当前系统 API ${deviceInfo.sdkApiVersion} 不提供任意文件夹选择能力。`
          + '下面是本应用实际可读写的目录范围，可进入子目录或新建目录后选定。')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')

        Row({ space: Sp.XS }) {
          ForEach(this.workspaceBrowserRoots, (root: WorkspaceBrowserRoot, index: number) => {
            Button(root.label)
              .fontSize(Fs.CAPTION)
              .backgroundColor(index === this.workspaceBrowserRootIndex
                ? $r('sys.color.background_primary') : $r('sys.color.background_secondary'))
              .fontColor(index === this.workspaceBrowserRootIndex
                ? $r('sys.color.brand') : $r('sys.color.font_secondary'))
              .onClick(() => {
                this.workspaceBrowserSwitchRoot(index);
              })
          }, (root: WorkspaceBrowserRoot) => root.path)
        }
        .width('100%')

        Text(this.workspaceBrowserPath)
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_secondary'))
          .width('100%')
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })

        Scroll() {
          Column({ space: Sp.XS }) {
            if (this.workspaceBrowserDirs.length === 0) {
              Text('（这一层没有子目录）')
                .fontSize(Fs.CAPTION)
                .fontColor($r('sys.color.font_tertiary'))
                .width('100%')
            }
            ForEach(this.workspaceBrowserDirs, (name: string) => {
              Row({ space: Sp.S }) {
                SymbolGlyph($r('sys.symbol.folder'))
                  .fontSize(16) // token-exempt: 目录行图标尺寸
                  .fontColor([$r('sys.color.brand')])
                Text(name)
                  .fontSize(Fs.SECONDARY)
                  .layoutWeight(1)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                SymbolGlyph($r('sys.symbol.chevron_right'))
                  .fontSize(14) // token-exempt: 目录行箭头尺寸
                  .fontColor([$r('sys.color.font_tertiary')])
              }
              .width('100%')
              .padding(Sp.S)
              .borderRadius(Radius.S)
              .backgroundColor($r('sys.color.background_primary'))
              .onClick(() => {
                this.workspaceBrowserEnter(name);
              })
            }, (name: string) => name)
          }
          .width('100%')
        }
        .height(240)
        .width('100%')

        if (this.workspaceBrowserNote.length > 0) {
          Text(this.workspaceBrowserNote)
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.warning'))
            .width('100%')
        }

        Row({ space: Sp.S }) {
          Button('上一级')
            .layoutWeight(1)
            .backgroundColor($r('sys.color.background_primary'))
            .fontColor($r('sys.color.font_primary'))
            .onClick(() => {
              this.workspaceBrowserUp();
            })
          Button('新建目录')
            .layoutWeight(1)
            .backgroundColor($r('sys.color.background_primary'))
            .fontColor($r('sys.color.font_primary'))
            .onClick(() => {
              this.workspaceBrowserCreate();
            })
        }
        .width('100%')

        Row({ space: Sp.S }) {
          Button('取消')
            .layoutWeight(1)
            .backgroundColor($r('sys.color.background_secondary'))
            .fontColor($r('sys.color.font_primary'))
            .onClick(() => {
              this.closeWorkspaceBrowser({ path: null, error: '' });
            })
          Button('就选这个目录')
            .layoutWeight(1)
            .onClick(() => {
              this.closeWorkspaceBrowser({ path: this.workspaceBrowserPath, error: '' });
            })
        }
        .width('100%')
      }
      .width('100%')
      .padding(Sp.L)
      .borderRadius(Radius.L)
      .backgroundColor($r('sys.color.background_secondary'))
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .padding(HarmonySpacing.CONTAINER)
    .backgroundColor('#66000000') // token-exempt: 原生模态遮罩
  }

  /** 扫描配置：文档 → JPG/PDF；表格 → EXCEL */
  private scanConfig(): DocumentScannerConfig {
    const config: DocumentScannerConfig = new DocumentScannerConfig();
    if (this.scanDocType === 1) {
      config.supportType = [DocType.SHEET];
      config.saveOptions = [SaveOption.EXCEL];
    } else {
      config.supportType = [DocType.DOC];
      config.saveOptions = [SaveOption.JPG, SaveOption.PDF];
    }
    config.maxShotCount = 10;
    return config;
  }

  /**
   * 扫描回调：临时 URI 复制进沙箱，再通过被拦截的 file selector 回传网页。
   * 这是 14:30 那版真机生成 XLSX 的链路（handleFileList）。
   */
  private handleScanResult(code: number, saveType: SaveOption, uris: string[]): void {
    this.scanDocType = -1;
    const event: OnShowFileSelectorEvent | undefined = this.pendingFileSelector;
    this.pendingFileSelector = undefined;
    if (event === undefined) {
      hilog.warn(DOMAIN, TAG, '扫描完成但无 file selector 事件，无法回传网页');
      return;
    }
    if (code !== 200 || uris.length === 0) {
      hilog.info(DOMAIN, TAG, '扫描取消 / 失败 code=%{public}d，回传空列表', code);
      event.result.handleFileList([]);
      return;
    }
    const ctx: common.UIAbilityContext = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const kind: ScanSaveKind = saveType === SaveOption.EXCEL ? ScanSaveKind.EXCEL
      : (saveType === SaveOption.PDF ? ScanSaveKind.PDF : ScanSaveKind.JPG);
    const files = persistScanResults(uris, kind, ctx.filesDir);
    hilog.info(DOMAIN, TAG, '扫描完成：%{public}d 件，回传网页', files.length);
    event.result.handleFileList(scanUris(files));
  }

  build() {
    Column() {
      Stack() {
      // Web 放最底层：ERROR 时也不卸载（保持 controller 可用，重试走 refresh）
      if (this.phase !== WebPhase.BOOTING || this.startupWebPrepared) {
        Web({
          // 【Web 预挂（2026-11-26，与 PC 壳对齐）】预挂后 src 冻结在 about:blank，
          // 之后一切导航都走已附着控制器的 loadUrl —— Web 组件不再因 src 变化重建。
          src: this.startupWebPrepared ? STARTUP_BLANK_URL : this.launchUrl,
          controller: this.controller
        })
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .fileAccess(false)
          // ── 目录选择三段式（2026-09-21，见 PICKER_SHIM_JS 注释）──
          // 第 2 段之垫片：javaScriptOnDocumentStart 保证脚本先于页面任何
          // JS 执行（官方文档原文），即先于官方 wire bootstrap → 官方前端
          // native 面的 apply() 读 __DSH_DIRECTORY_PICKER__ 时垫片已就位。
          // ⚠ 验收信号：DOM 探针的 p/c/r 字段应为 "object"/"object"/"function"。
          // 【Web 预挂（2026-11-26）】预挂期走包裹版清单（about:blank 不跑垫片），
          // 未预挂走原清单 —— 判据见 webDocumentStartScripts()。
          .javaScriptOnDocumentStart(this.webDocumentStartScripts())
          // 第 1 段之同步桥：javaScriptProxy 只暴露**同步**方法 startPick
          //（官方 FAQ 定论：javaScriptProxy 仅支持同步调用，异步方法无法把
          // 结果回传 H5——asyncMethodList 路线实测死路，diag-pick-called
          // 文件证明 pick() 被调但 await 永远 pending）。
          //
          // ⚠ 只用属性形式，禁止在 onControllerAttached 里用
          // controller.registerJavaScriptProxy 重复注册：实测（2026-09-21）后者会先
          // RemoveNamedObjectInternal 移除属性注册的对象、再把新对象推迟到
          // “下次页面加载”才生效——结果是页面 stub 还在（typeof "object"）但
          // native 端已除名，native 面调 pick() 时 hilog 报
          // "native proxy object not found, name:__DSH_DIRECTORY_PICKER__"。
          // ── 桥注入（2026-09-25 修复：合并为一次调用）──
          // 【根因·已实验坐实】同一 Web 组件上链式写两次 `.javaScriptProxy({...})`，
          // **只有最后一个生效**。判据来自真机 DOM 探针（临时脚本已清理，结论留此）：
          //     原顺序（选择桥在前）：c(__DSH_DIR_PICKER_NATIVE__)=undefined
          //                           tc(__DSHM_THEME_NATIVE__)   =object
          //     交换顺序后          ：c=object、tc=undefined   ← **精确对调**
          // 交换一次顺序即可定性，故不保留临时探针字段。
          // 且 SDK 的 WebAttribute 只声明 `javaScriptProxy(javaScriptProxy: JavaScriptProxy)`，
          // **没有数组重载**（`JavaScriptProxy[]` 在 web.d.ts 里零处）⇒ 多次调用非受支持用法。
          //
          // 【后果有多严重】选择桥丢失后，垫片 pick() 里 `native` 为 undefined，
          // 走 `resolve(null)` 静默收场 ⇒ 点「添加工作区」**毫无反应、无报错**，
          // 正是用户看到的现象。（外观桥丢失则表现为状态栏不跟随主题。）
          //
          // 【修法】两桥合并为一个对象、一次注册；方法名各自保留。
          .javaScriptProxy({
            object: this.bridges,
            name: '__DSHM_BRIDGES__',
            methodList: ['startPick', 'startScan', 'onThemeMode', 'startNativeCapture', 'nativeCaptureState', 'takeNativeCapture', 'cancelNativeCapture', 'openExternal', 'openFilePreview', 'openFileLocation', 'platformHandheld', 'platformForm', 'platformPcMode', 'platformSingleScreen', 'requestSystemBack', 'cloudSyncState', 'cloudSyncAction', 'readAloud', 'stopReadAloud', 'shareText'],
            controller: this.controller
          })
          .editMenuOptions(this.webEditMenuOptions)
          // 官方 web UI 自己按 prefers-color-scheme 适配暗色：跟随系统、不强制反色
          .darkMode(WebDarkMode.Auto)
          .forceDarkAccess(false)
          // 【Web 预挂（2026-11-26）】控制器附着即记位并尝试导航：覆盖「URL 先到、
          // 控制器后附」的竞态（另一头在 onLaunchUrlChanged，两处都调 loadPreparedHostPage）。
          .onControllerAttached(() => {
            this.startupControllerAttached = true;
            this.loadPreparedHostPage();
          })
          .onPageBegin((event: OnPageBeginEvent) => {
            this.cancelNativeCapture();
            // 【Web 预挂】about:blank 的导航不进阶段机（不算加载开始）
            if (this.isStartupBlankNavigation(event.url)) {
              return;
            }
            // 整页导航（含 303 后的落地）重新进入加载期；SPA 内部路由不受影响
            if (this.phase === WebPhase.READY) {
              this.phase = WebPhase.LOADING;
            }
            // 新一轮加载：注入脚本要等 onPageEnd 才保证 DOM 在位（docs/172 §5.2）
            this.webReady = false;
            this.clearPostLoadSettle();
          })
          /*
           * 【2026-11-16 与 entry 对齐：主帧外链交系统浏览器】
           * 【2026-11-26 与 entry 同步：子帧外链放行】侧栏浏览器 tab 用
           * <iframe src=远端> 内嵌网页（dsh-client-ui-sidebar-browser），
           * 原先子帧整类拦下 ⇒ 手机侧栏浏览器永远空白。放行不触发外开。
           * 判据与 entry 完全相同（见其 onLoadIntercept 块注释）。
           */
          .onLoadIntercept((event: OnLoadInterceptEvent): boolean => {
            try {
              const target: string = event.data.getRequestUrl();
              if (!this.isExternalNavigation(target)) {
                return false;
              }
              if (!event.data.isMainFrame()) {
                hilog.info(DOMAIN, TAG, '放行子帧外链导航（侧栏浏览器 iframe）：%{public}s', target);
                return false;
              }
              hilog.info(DOMAIN, TAG, '拦下页内导航并交系统浏览器：%{public}s', target);
              this.dirPickerBridge.writeDiagMarkerPublic('diag-openlink', `nav ${target}`);
              openExternalUrl(target).then((ok: boolean): void => {
                if (!ok) {
                  hilog.warn(DOMAIN, TAG, '外链打开失败（系统无可用浏览器？）：%{public}s', target);
                }
              });
              return true;
            } catch (e) {
              hilog.warn(DOMAIN, TAG, 'onLoadIntercept 异常（放行本次导航）：%{public}s', (e as Error).message);
              return false;
            }
          })
          .onPageEnd((event: OnPageEndEvent) => {
            // 【Web 预挂】about:blank 的加载结束不进阶段机（不算就绪）
            if (this.isStartupBlankNavigation(event.url)) {
              return;
            }
            /*
             * 【必须判 loadFailed，不能无条件置 READY】
             * 真机日志显示两者**只差 10ms**、且顺序是"先 404 后 onPageEnd"：
             *   47.144 web UI 加载失败：Host 返回 HTTP 404   ← fail() 置 ERROR 并排重试
             *   47.154 web UI 页面渲染完成（phase=READY）    ← 原实现无条件覆盖成 READY
             * 于是：① ERROR 被瞬间抹掉，用户看到的是 ArkWeb 自己的 404 错误页（**白屏**）；
             *       ② 若这里再清重试，刚排上的自愈也会被取消。
             * 所以失败标记优先：加载出错时 onPageEnd 不得改写阶段、也不得清重试。
             */
            if (this.loadFailed) {
              hilog.warn(DOMAIN, TAG, '页面结束但本轮已判失败（%{public}s），保持 ERROR 并等自动重试',
                this.errorText);
              return;
            }
            /*
             * 【Web 预挂】首次就绪时把 about:blank 从后退栈里清掉：
             * 否则手持档返回手势（accessBackward）会退回空白页。
             */
            if (this.startupWebPrepared && !this.everReady) {
              try {
                this.controller.clearHistory();
              } catch (e) {
                hilog.warn(DOMAIN, TAG, 'DSHM-TRACE ArkWeb 启动历史清理失败');
              }
            }
            this.phase = WebPhase.READY;
            /*
             * 页面就绪：补发挂起的快捷方式动作（docs/172 §5.2）。
             * 「新建会话」按钮属于侧栏常驻 DOM，页面加载完成即可点；SPA 内部路由不影响它。
             */
            this.webReady = true;
            // 采样真实背景色（状态栏透明后露出的就是它）；样式可能稍晚稳定，400ms 再采一次（幂等）。
            this.samplePageBackground();
            setTimeout((): void => {
              this.samplePageBackground();
            }, 400);
            this.scheduleViewportReconcile('page-end');
            this.schedulePostLoadSettle();
            if (this.pendingLaunchAction.length > 0) {
              const pending: string = this.pendingLaunchAction;
              this.pendingLaunchAction = '';
              this.dispatchWebAction(pending);
            }
            /* 记下"曾经就绪"：此后应用内整页导航不再闪启动页 */
            this.everReady = true;
            /*
             * 【收尾要平滑，不能一把设 100】
             * 直接 `progressValue = 100` 会从当前值（实测约 80%）**瞬间跳上去**，
             * 与"突然冲一下"是同一个观感问题。
             * 改成让 ticker 自己用一段短动画补到 100%，再停表 —— 见 finishProgress()。
             */
            this.finishProgress();
            /* 清掉重试计时器并复位计数，下次失败重新有完整预算 */
            this.clearAutoRetry();
            this.autoRetryCount = 0;
            hilog.info(DOMAIN, TAG, 'web UI 页面渲染完成（phase=READY）');
            this.dirPickerBridge.writeDiagMarkerPublic('diag-web-load', '成功：页面已就绪（200）');
          })
          /*
           * 语音输入（实验）：Web 页面请求麦克风时必须显式放行。
           * ArkWeb 不挂本回调 = 一律拒绝，官方语音 UI 点麦克风只会拿到
           * NotAllowedError（表现为"点了没反应"）。裁决与取证见
           * handleWebPermissionRequest 的注释。
           */
          .onPermissionRequest((event?: OnPermissionRequestEvent) => {
            this.handleWebPermissionRequest(event);
          })
          // web 侧 console 全量转发到 hilog：官方 web UI 的启动/运行错误
          // （__ModuleLoader__ boot 失败、API 调用异常等）在 ArkTS 层不可见，
          // 这里是等价于官方 DevTools console 的诊断通道。返回 false 保留默认行为。
          // H5 input[type=file] 的文件选择回调：官方 web UI 的附件上传等会走到
          // 这里。2026-09-21 排查「选完无反应」时也是判定「用户看到的目录选择
          // 是 ArkWeb 默认选择器（input 触发）还是我们的 DocumentViewPicker」的
          // 决定性信号——默认实现也弹系统选择器，肉眼难分辨，靠本回调留痕。
          // 返回 false 走 ArkWeb 默认行为（弹默认选择器），不改变现有交互。
          .onShowFileSelector((event?: OnShowFileSelectorEvent): boolean => {
            if (event === undefined) {
              return false;
            }
            hilog.info(DOMAIN, TAG, 'onShowFileSelector 触发（会话区扫描 / input[type=file]）');
            this.dirPickerBridge.writeDiagMarkerPublic('diag-file-selector');
            if (!canIUse('SystemCapability.AI.Component.DocScan')) {
              hilog.info(DOMAIN, TAG, '本机无 DocScan 能力，沿用系统文件选择器');
              this.pendingScanMode = -1;
              return false;
            }
            this.pendingFileSelector = event;
            if (this.pendingScanMode >= 0) {
              this.scanDocType = this.pendingScanMode;
              this.pendingScanMode = -1;
              hilog.info(DOMAIN, TAG, '扫描请求：启动 DocumentScanner');
            } else {
              hilog.info(DOMAIN, TAG, '普通文件选择：沿用系统文件选择器');
              this.pendingFileSelector = undefined;
              return false;
            }
            return true;
          })
          // web 侧 console 全量转发到 hilog：官方 web UI 的启动/运行错误
          // （__ModuleLoader__ boot 失败、API 调用异常等）在 ArkTS 层不可见，
          // 这里是等价于官方 DevTools console 的诊断通道。返回 false 保留默认行为。
          // 2026-10-03 补：hilog 这一路在真机上不可读（见 writeConsoleLine 的注释），
          // 故同时落一份到 files/diag-web-console，两者并行、互不替代。
          .onConsole((event?: OnConsoleEvent) => {
            if (event === undefined) {
              return false;
            }
            const msg: ConsoleMessage = event.message;
            /*
             * 【为什么先写这一笔，且不碰 msg 任何属性】2026-10-03 真机实测：
             * 加了 sink 之后 `files/diag-web-console` 与 `diag-web-console-cb`
             * **都没被创建**。要区分两种可能——
             *   (a) `.onConsole` 压根没被调用；
             *   (b) 回调来了，但取 `msg.getMessageLevel()` 之类就抛，整段挂掉。
             * 故这里**先**不取任何属性、只走已验证可用的 `writeDiagMarkerPublic`
             * （`diag-web-load` 一直在正常追加）记一笔。若本文件始终不出现，
             * 即可断定是 (a)：本机 ArkWeb 不把 console 投递给 `.onConsole`。
             */
            this.consoleCbCount += 1;
            if (this.consoleCbCount <= 3) {
              this.dirPickerBridge.writeDiagMarkerPublic('diag-web-console-cb',
                `第 ${this.consoleCbCount} 次 onConsole 回调`);
            }
            hilog.info(DOMAIN, TAG, '[web] %{public}s:%{public}d %{public}s %{public}s',
              msg.getSource(), msg.getLineNumber(),
              msg.getMessageLevel(), msg.getMessage());
            this.dirPickerBridge.writeConsoleLine(msg.getMessageLevel(), msg.getSourceId(),
              msg.getLineNumber(), msg.getMessage());
            return false;
          })
          .onErrorReceive((event?: OnErrorReceiveEvent) => {
            if (event === undefined || !event.request.isMainFrame()) {
              return;
            }
            this.fail(`主资源加载失败：${event.error.getErrorInfo()}`);
          })
          .onHttpErrorReceive((event?: OnHttpErrorReceiveEvent) => {
            if (event === undefined || !event.request.isMainFrame()) {
              return;
            }
            const code: number = event.response.getResponseCode();
            if (code === 401) {
              this.fail('Host 拒绝了本次令牌（401）：核心可能已重启，请重试。');
            } else {
              this.fail(`Host 返回 HTTP ${code}`);
            }
          })
          .onAreaChange((_oldValue: Area, newValue: Area) => {
            this.onWebAreaChanged(newValue);
          })
          .width('100%')
          .height('100%')
          /*
           * 底部手势区（docs/130 → docs/187）：Web **不再**向下扩进系统安全区。
           * 根容器与 Stack 仍各自 expandSafeArea 并画满主题底色；Web 止于安全区上沿，
           * 因而 Web 壳的固定使用统计栏整体上移，与小白条彻底分开。
           * 这推翻了 docs/130 “Web 自身也要扩”的旧取舍：新版 Web 底栏是固定定位，
           * 页面侧 env(safe-area-inset-bottom) 已无法单独兜住它。
           */
      }

      // 启动等待画面（BOOTING **与 LOADING**）：品牌标（透明底 logo_dark）淡入后进入
      // 常驻呼吸循环，线性进度条推进，直到就绪/失败。
      //
      // ─────────────── 为什么 LOADING 也要盖启动页（白屏根因，2026-09-27）───────────────
      // 原实现只给 `BOOTING` 盖启动页。而阶段流转是：
      //     BOOTING（显示启动页）→ launchUrl 就绪 → enterLoading() → LOADING → 200 就绪
      // `LOADING` **没有任何覆盖层** ⇒ 这一阶段直接露出底层 Web 组件：
      // 页面此时要么还没渲染完（空白），要么正显示上面那次 404 的错误页。
      // 用户看到的就是"启动页过后有 2 秒左右白屏"。
      //
      // 真机读数（宿主侧 + WebView 侧对齐）：
      //     +0ms      BOOT_00_NODE_START
      //     +393ms    BOOT_40_PROFILE_BOOT      ← dsh 开始加载插件
      //     +7582ms   BOOT_65_AUTH_URL          ← 7.2 秒全花在插件初始化
      //     +7613ms   BOOT_60_HTTP_BIND
      //     之后 enterLoading() → LOADING ⇒ **白屏窗口** ⇒ 200
      // 修法：把启动页挂在 `BOOTING || LOADING` 上 —— 它本来就该覆盖"还没就绪"的全程。
      // 顺带把首屏体验统一：用户从启动到可用只看到同一个品牌页，不再有白屏跳变。
      if (this.phase === WebPhase.BOOTING
        || (this.phase === WebPhase.LOADING && !this.everReady)) {
        Column() {
          /*
           * logo 与进度条同组、首帧直接可见。此前 logo 有 80ms 延迟 + 640ms
           * 淡入；即使后来把整组 opacity 绑在一起，0% 时的浅灰进度轨道在白底
           * 淡入中仍会明显晚于深色 logo 被看见。因此这里不再做透明淡入。
           */
          Column() {
            Image($r('app.media.logo_dark'))
              .width(92)
              .height(92)
              .objectFit(ImageFit.Contain)
              .scale(this.markScale(true))
              .opacity(this.markOpacity(true))
            Progress({ value: this.progressValue, total: 100, type: ProgressType.Linear })
              .width(200)
              .height(6)
              .color(this.splashDark ? '#FFFFFF' : '#1c2430')
              .backgroundColor(this.splashDark ? '#2A2A2E' : '#e4e7ec') // 启动页进度条：随启动页深浅色
              .margin({ top: 40 })
          }
          .alignItems(HorizontalAlign.Center)
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
        .backgroundColor($r('app.color.start_window_background')) // 启动页底色：随系统深浅色（与 module.json5 的 startWindowBackground 同源）
        /*
         * 【启动页要真正"沉浸"进状态栏那一条】（2026-10-16 用户报"启动的时候 APP 区跟状态栏就不是一个色"）
         *
         * 真机实测（手机 62T0225B18039433）：启动期系统会把状态栏那一条画成**白**（我们写的
         * `statusBarColor=#F3F7FB` 在这一阶段不被采用 —— 截图逐点取色：状态栏 `#FFFFFF`、
         * 启动页 `#F3F6FB`，两者之间有硬台阶）。而 `expandSafeArea` **不向子组件传播**（见 docs/130），
         * 启动视图原先只扩了 bottom ⇒ 顶部那一条是"别人的"。
         * ⇒ 手持档把启动视图**同时扩进 top+bottom**：状态栏那一条改由我们自己的底色画（与启动页同色），
         * 系统只负责在上面画图标（`isStatusBarLightIcon=false` ⇒ 深色图标，配浅底）。
         * 桌面形态 保持只扩底部（它们没有手机这种状态栏，一个字节不动）。
         */
        .expandSafeArea(
          this.handheld ? [SafeAreaType.SYSTEM] : this.bottomSafeAreaTypes(),
          this.handheld ? [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM] : this.bottomSafeAreaEdges())
        .onAppear(() => {
          this.startBrandAnimation();
          // 【Web 预挂（2026-11-26，与 PC 壳对齐）】品牌动画出现即排预挂：
          // 等一帧（首帧保持轻量）后在 BOOTING 期把 about:blank 的 Web 挂上。
          this.preparePhoneWebAfterFrame();
        })
      }

      // ── Vision Kit 文档扫描 / 表格提取（由输入框旁按钮触发，2026-11-25）──
      // 扫描结果经 file selector 回传网页，作为附件进入会话区。
      if (this.scanDocType >= 0) {
        DocumentScanner({
          scannerConfig: this.scanConfig(),
          onResult: (code: number, saveType: SaveOption, uris: string[]): void => {
            this.handleScanResult(code, saveType, uris);
          }
        })
      }

      // 错误覆盖层（ERROR）：盖在 Web 之上，保留重试入口
      if (this.phase === WebPhase.ERROR) {
        Column({ space: 14 }) {
          Text('无法连接本地核心')
            .fontSize(Fs.TITLE_M)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('sys.color.font_primary'))
          Text(this.errorText)
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_tertiary'))
            .textAlign(TextAlign.Center)
          Button('重试')
            .onClick(() => {
              this.retry();
            })
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .padding(24)
        .backgroundColor($r('sys.color.background_primary'))
        .expandSafeArea(
          this.handheld ? [SafeAreaType.SYSTEM] : this.bottomSafeAreaTypes(),
          this.handheld ? [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM] : this.bottomSafeAreaEdges())
      }
      if (this.workspaceBrowserOpen) {
        this.WorkspaceBrowserOverlay()
      }
      /*
       * 华为账号与云同步（2026-10-29，docs/299/300）。
       * 页内浮层，**不跳路由** —— 顶栏与 Web 都保持在场，关闭即收起。
       *
       * 【2026-10-31 恢复（docs/328）】剥离会议模式时，删「会议浮层 + 胶囊」那段的
       * 收尾标记与这段的结尾长得一样，正则多吃了一段，把云同步面板的**渲染挂载**
       * 一并删掉了（动作分支与 import 都还在）。门禁 `check-cloud-sync-plugin`
       * 的「原生壳必须有 CloudSyncSettings({」当场判红 —— 这条判据救了一次。
       */
      /* 云同步设置页（生产界面） */
      if (this.cloudSyncOpen) {
        CloudSyncSettings({
          autoLogin: this.cloudSyncAutoLogin,
          onClose: (): void => {
            this.cloudSyncOpen = false;
            this.cloudSyncAutoLogin = false;
          }
        })
      }

      /*
       * 【沉浸光感（ohos.arkui.UIMaterial，API 26）最小试探结论 —— 2026-10-11，未采用】
       * 真机（桌面形态，API 26）三轮实测把三件事钉死：
       *   ① `getFrameNodeById(...).commonAttribute` 这条路**写不动** ArkUI 节点：读数 `route=ok`，
       *      而声明期固定成绿色的对照块始终没变红 ⇒ 官方「只有自定义节点的属性可以修改」是真阻碍；
       *   ② 声明链 `.systemMaterial(...)` 才是唯一有效写法 —— 顶栏当场由纯白转半透明蓝；
       *   ③ 材质**能**盖在 ArkWeb 画布之上，但那只是「一层半透明色罩 + 模糊」：整块 Web 内容
       *      被染蓝、文字糊掉 ⇒ 不是内容相关毛玻璃，**不适合**做「全局沉浸光感」。
       * ⇒ 不铺开：本应用界面主体是 Web 画布，材质层只适合挂在自绘的 ArkUI 面上（如顶栏）。
       *
       * 【后续（同日）：壳侧不再挂 ArkUI 菜单，Web 输入菜单由 editMenuOptions 提供】
       * 用户复报「应用菜单并未跟随系统沉浸光感的强度」⇒ 在真机上补测四条形态：
       *   · 只把元数据从 `disable` 翻成 `enable`、菜单不挂 `systemMaterial` ⇒ 与 `disable` 档**逐像素相同**；
       *   · 菜单在**声明点**挂 `systemMaterial` 才会变玻璃；
       *   · 浅色系统下要给浅色玻璃，必须由 `WithTheme` 定深浅（`ThemeColorMode.SYSTEM` 实测仍给深色）；
       *   · `colorInvert: true` 会把菜单**自身条目文字**糊掉 ⇒ 不要跟着开。
        */
      }
      .layoutWeight(1)
      .width('100%')
      /*
       * 三键区顶部让位（2026-10-10，MatePad Edge 报「右上角三键与右侧边栏按钮重叠」）：
       * 移动端没有自绘顶栏，窗口标题栏那一条**没人画**，而窗口仍在「自由窗口 +
       * 三键可见」的状态 ⇒ 官方 Web 壳自己那排顶部按钮（最右侧那颗「面板 / 预览」开关）
       * 正好落在系统三键底下。把整块 Web 内容按**固定让位量**（`HANDHELD_DECOR_INSET_VP`）压下去即解 —— 那些按钮是**页面
       * 自己的**，我们只能让位、不能挪它。
       * 让位量由纯函数 decorTopInsetVp(decorKeysVisible) 给出；底色取 windowBgNow()，与窗口底色（applySystemBarTheme
       * 的 setWindowBackgroundColor）同值 ⇒ 桌面形态设备上即使露出也看不出差别。
       * 【为什么这里现算而不是读一个 @State 结论】三键可见性由能力层在 loadContent 回调里
       * 发布（页面首帧之后才有）—— 渲染期求值天然跟上，不必再往状态里存第二份结论。
       */
      /* 顶部让位 = 三键区（自由窗口）+ 状态栏（layout-fullscreen 后的沉浸让位）。
         两者互斥：全屏时 decorTopInsetNow()=0，自由窗口时 topInsetVp=0。 */
      .padding({ top: this.decorTopInsetNow() + this.topInsetVp })
      // 底部手势区沉浸（docs/130）：Stack 是"把扩下去的额度接力给子组件"的那一环 ——
      // expandSafeArea 不向子组件传播，父容器的框不伸，子组件就还是被它框在安全区上沿。
      .expandSafeArea(
        this.handheld ? [SafeAreaType.SYSTEM] : this.bottomSafeAreaTypes(),
        this.handheld ? [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM] : this.bottomSafeAreaEdges())
    }
    .width('100%')
    .height('100%')
    // 让位那一条的底色：与自绘顶栏同源（手持档没有顶栏，这条就是"顶栏"的替身）。
    .backgroundColor(this.windowBg)

    /*
     * 底部手势区沉浸（2026-10-09，docs/130）：把根容器向下扩进「系统安全区」的底边，
     * 让 Web 铺到屏幕最底 —— 侧栏/主区自己的底色于是自然盖住小白条那一带（原生应用观感）。
     *
     * 【只在手持档、且底部真有避让区时扩】桌面形态 上 bottomInsetVp 恒为 0 ⇒ 两个数组都是空
     * ⇒ 与改动前逐字相同（API 明文：expandSafeArea([],[]) 无效果）。
     * 【为什么能向下扩】按百分比（100%）定尺寸 —— SDK 明文：设了固定宽高就只能扩 TOP/START
     * 且尺寸不变，按百分比定尺寸才可向下扩。
     * 【只挂它不够】实测：只挂根容器时 Stack/Web 的框仍停在安全区上沿（y2=2734）。SDK 明文
     * expandSafeArea **不向子组件传播** ⇒ 要扩的一整条链（根容器 / Stack / Web / 两个覆盖层）
     * 各自挂自己的那一份（见那几处）。
     * 【2026-10-18 更新（docs/187）】新版 Web 壳底部的使用统计栏是固定定位，页面自己的
     * env(safe-area-inset-bottom) 不再足以避开系统小白条。因此 Web 自身不再向下扩：
     * root / Stack / 覆盖层仍扩进安全区并画满主题底色，Web 内容框止于安全区上沿。
     * 这样固定底栏整体上移，小白条只覆盖原生底色带，不再盖住使用统计。
     */
    .expandSafeArea(
      this.handheld ? [SafeAreaType.SYSTEM] : this.bottomSafeAreaTypes(),
      this.handheld ? [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM] : this.bottomSafeAreaEdges())
  }
}
