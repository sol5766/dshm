/**
 * Web 壳页：官方 apps/desktop 的鸿蒙等价物。
 *
 * 【为什么这么建】官方桌面（github.com/deepseek-ai/deepseek-harness apps/desktop）
 * 的界面**不是自绘的**：Electron 主进程起 dsh-desktop-host，拿到 ready 事件里的
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
 * 【2026-09-21 品牌对齐官方；2026-11-11 顶栏回归官方侧栏入口】应用名定为 DSHM
 * （dsh + HarmonyOS），对齐官方桌面版：
 * 左上角**不再自绘任何侧栏按钮** —— 官方客户端自己那颗「收起 / 打开侧边栏」恢复可见，
 * 点击即官方逻辑；收起态（56px 图标轨）由 SIDEBAR_SHIM_JS 把官方 opener 抬成常显
 * （官方默认只在鼠标移入时显形），全链路只有官方一颗按钮，不再有自绘浮动开关。
 * 顶栏只剩一颗三点菜单（「版本信息 / 开源组件声明」各项独立成页）；
 * 原「应用」（主页 / 刷新）与「编辑」菜单均已按用户要求整体删除。启动画面用品牌标 `logo_dark` 资产（由
 * `tools/make-icon.py` 生成，不自绘）；应用安装名
 * 与关于对话框同改为 DSHM，关于版本直接显示当前运行的 dsh 核心版本。
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { webview } from '@kit.ArkWeb';
import { BusinessError, deviceInfo } from '@kit.BasicServicesKit';
import { emitter } from '@kit.BasicServicesKit';
import { picker, fileUri } from '@kit.CoreFileKit';
import { common, ConfigurationConstant, bundleManager } from '@kit.AbilityKit';
// `PermissionRequestResult` / `Permissions` 是 AbilityKit 的**顶层**导出，
// 不在 `abilityAccessCtrl` 命名空间下（实测编译报错 "has no exported member"）。
import { abilityAccessCtrl } from '@kit.AbilityKit';
import type { PermissionRequestResult, Permissions } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { curves, router, window, uiMaterial, ComponentContent } from '@kit.ArkUI';
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
import { copyText, dialogMaterial, immersiveMaterialOf, StartupPhase, startupMarks } from 'platform';
// 【2026-10-03】"用户可见目录 + agent 可读写删"的两件设备能力（见
// platform/src/main/ets/system/FilePicker.ets 的注释，与
// dsh-移植研究/30-DSHM文件能力植入-侦察与设计.md §5.3）。
// 【不含权限申请】本路线**不申请任何权限**（权限零差异铁律 + ACL 白名单只有 5 条，
// 见 FilePicker.ets 顶部权限说明注释）⇒ 上一版的权限申请函数已整体删除。
import { PickOutcome, probePathWritable, publicDownloadFolder, folderSelectionAvailable, shouldAutoFallbackFolderPicker, isHandheldForm, isPhoneForm, isFoldableDevice, isFoldableSingleScreenNow, FormFactor, isPathWithin, readDeviceFacts, windowChromeFor, statusBarOwnedByApp, SYSTEM_BAR_HANDOFF_BG, installWebDownloadDelegate, ReadAloud, shareText } from 'platform';
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
import { AboutPanel } from '../view/AboutPanel';
// 碰一碰接收（2026-11-16，docs/418）：手机轻触本机屏幕 → Share Kit 沙箱接收 →
// base64 推进官方输入框。仅 PC 档（desktopForced）注册，平板不启用，手机端是发送方。
import { KnockShareReceiver, KnockFile } from '../system/KnockShareReceiver';
import { CloudSyncSettings } from 'platform';
/*
 * 云同步（2026-10-30，docs/320）：中枢已搬到 platform，与手机壳**共用一份**。
 * 本壳只保留"取上下文 → 挂目录"与"按判定去执行"这两件壳职责。
 */
import {
  SyncEngine, SyncEngineState,
  SyncRoot, encodeCloudState, decideCloudAction, encodeCloudActionReply, CloudActionDecision,
  silentSignIn, SilentSignInKind, fetchAccountDisplayName,
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
/*
 * 【2026-11-07 云测遥测盲区】云调试的 hilog 抓取只收**默认域**（A00000 前缀）的应用行：
 * EntryAbility（domain=0x0000）的行全可见，本文件（0xD5D5）的行全不可见 —— 三份云测
 * 日志里 [web] / [dshm-sidebar] / DshWebApp 全 0 行即此因；本机无 hdc，落盘的
 * files/diag-web-console 也取不出来。诊断必须走的两条通道（onConsole 转发、页面版本
 * 锚点）改用默认域；其余 0xD5D5 调用不动（最小改动面）。
 */
const CLOUD_DOMAIN: number = 0x0000;

/**
 * API 23 兼容：`enableDefaultContextMenu` 从 API 24 才存在。
 * 属性不存在时直接链式调用会得到 `undefined is not callable`。
 */
class WebContextMenuCompat implements AttributeModifier<WebAttribute> {
  applyNormalAttribute(instance: WebAttribute): void {
    if (deviceInfo.sdkApiVersion >= 24
      && typeof instance.enableDefaultContextMenu === 'function') {
      instance.enableDefaultContextMenu(true);
    }
  }
}

const WEB_CONTEXT_MENU_COMPAT: WebContextMenuCompat = new WebContextMenuCompat();

/**
 * 沉浸光感·混合承载（2026-11-17）：网页右键/长按菜单的应用侧菜单项。
 * ArkTS 禁止无类型对象字面量（arkts-no-untyped-obj-literal），这里给出显式形状；
 * label 进 MenuItem.content，run 由 runWebMenuItem 统一收尾。
 */
interface WebContextMenuItem {
  label: string;
  run: () => void;
}

/**
 * WebContextMenuPanel 的入参。themeDark 显式定 WithTheme 深浅——
 * 2026-10-11 真机结论：SYSTEM 档实测仍给深色玻璃，必须显式指定。
 */
interface WebContextMenuPanelParams {
  items: WebContextMenuItem[];
  themeDark: boolean;
}

/**
 * 网页上下文菜单面板（全局 @Builder，wrapBuilder 包装后交给 openMenu 的
 * ComponentContent）。WithTheme 包 Menu：菜单文字跟随应用外观而非系统外观。
 */
@Builder
function WebContextMenuPanel(params: WebContextMenuPanelParams) {
  WithTheme({ colorMode: params.themeDark ? ThemeColorMode.DARK : ThemeColorMode.LIGHT }) {
    Menu() {
      ForEach(params.items, (item: WebContextMenuItem): void => {
        MenuItem({ content: item.label })
          .onClick((): void => {
            item.run();
          })
      }, (item: WebContextMenuItem): string => item.label)
    }
  }
}

/*
 * 【2026-11-11 移除 `MEETING_MODE_VISIBLE`】这个常量原来只被 `appMenu()` 用来摘掉
 * 「会议模式」菜单项。`appMenu()` 整体删除后它零读点 ⇒ 一并删除。
 * 会议功能本身（采集/识别/总结/英译/落盘）仍在代码里，只是没有任何入口挂载
 * （面板与胶囊都不渲染），要重新开放需要新增入口，而不是改一个布尔值。
 */
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
/** 本应用需要运行时申请的权限（目前只有语音输入的麦克风） */
const MIC_PERMISSION: Permissions = 'ohos.permission.MICROPHONE';













/**
 * 桌面载体声明（2026-09-24 官方功能对齐）：官方 dsh 前端把**桌面壳专属功能**的
 * 注册门在 `globalThis.dshDesktop` 上（官方桌面 App 的 Electron 壳注入）。本应用
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
 * 官方 Electron 壳靠主进程 `setWindowOpenHandler` + `shell.openExternal` 外开，
 * 但那是**壳外代码**：全 core 树 grep `setWindowOpenHandler|shell.openExternal`
 * 零命中，`dshDesktop` 契约里也只有 shortcuts/keyboard/updates/browser 四类能力，
 * **没有任何外开 API**。故 ArkUI 壳必须自己接：见下方 OPEN_LINK_SHIM_JS。
 */
const DESKTOP_CARRIER_JS: string =
  'if(typeof globalThis.dshDesktop==="undefined"){' +
  'globalThis.dshDesktop={protocolVersion:1};}';

/*
 * 【已删除：`FISH_LOGO_VIEWBOX_W/H`（原值 23.16 / 17.04）】2026-10-10 顶栏左上角从
 * 官方鲸鱼改成侧栏按钮（2026-11-11 该自绘按钮又整体删除，见 TopBar 注释），这两个
 * 常量随之**零读点** ⇒ 一并删除
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
 * wire bootstrap 执行，是 Electron preload 的等价物。
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
 * 与官方 Electron preload 契约一致（null 时前端 onCancel 静默收场）。
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
 * API，官方 Electron 壳的外开是**主进程代码**，本壳必须自己接。而 ArkWeb 默认
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
   * message 帧即可。与官方 Electron 壳「主进程订阅 account 流后开系统浏览器」同构。
   * 【2026-11-16 rc.3 形状适配】0.2.2-rc.3 起 `value` 改为
   * `{type:'credentials-changed'|…, state:AccountView}` 封套（消费方
   * dsh-client-ui-settings-account 的流循环取 `frame.value.state`），AccountView 挪进
   * `state`。不剥封套 ⇒ waiting-browser 扫不到 ⇒ 登录不跳浏览器（T134514 真机复现：
   * startSignIn rpc 200 但零外开、diag-openlink 不存在）。路径 1/1b 现两种形状都认。
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
      /* 【2026-11-16 rc.3 形状适配】0.2.2-rc.3 起账号流帧/RPC 结果不再是裸 AccountView，
         而是 {type:'credentials-changed'|…, state:AccountView} 封套（消费方
         dsh-client-ui-settings-account/src/client/index.ts 的流循环取 frame.value.state）。
         不剥封套 ⇒ waiting-browser 永远扫不到 ⇒ 登录不跳浏览器（T134514 真机复现：
         rpc 200 但无任何外开）。剥完继续走裸形状判据，rc.2 及之前的帧不受影响。 */
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
                /* rc.3 封套先剥（同 scanAccount 头部注释）：不剥的话账号帧会一直掉进
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
         * 【2026-10-28 修"链接不会跳转浏览器"】这里原本有一道只认新窗口锚点的判据
         * （取 target 属性、不是 _blank 就 return）⇒ 只接管"新窗口"锚点。
         * 官方正文里的 Markdown 链接（[文字](https://…)）渲染出来**不带** target
         * ⇒ 点下去交给 WebView 默认行为：既不跳系统浏览器，又可能把外部页（授权页更会
         * 按 204 空页）加载进应用自己的 WebView，把界面替掉。
         * 现在**所有 http(s) 锚点**都交出去；同源（应用自身）在上一条判据放行。
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
 * 侧栏入口：**官方客户端自己那颗「收起 / 呼出」按钮**（2026-09-09 起对齐官方）。
 *
 * 【为什么需要这个垫片】官方客户端的左上角不是装饰：那一刻的按钮就是侧栏开关
 * （`dsh-client-ui-sidebar` 的 `SidebarRoot` → `ctx.layout.toggleSidebar()`）。
 * 2026-10-10 到 2026-11-11 之间我们曾自绘一颗顶栏按钮、把官方那颗藏起来；
 * 2026-11-11 用户裁决反转：自绘按钮删除，官方按钮恢复可见，**点击就是官方逻辑**。
 * 垫片本身保留，负责三件端侧专属的事（见下），不再负责"替官方按钮接点击"。
 *
 * 它同时做三件"端侧专属"的事（2026-10-09 用户裁决）：
 *   §A 收起态 ⇒ 左侧**整列消失**（原话："收起的时候左边侧边栏应该是完全收起，
 *      那一竖排的预览按钮都没有的"）。官方默认只收到 56px 图标轨（那是桌面口径：
 *      轨道上还留着新会话 / 插件 / 历史 / 搜索等入口），与"完全收起"不符。
 *   §B 手持档 + 窄屏（<1024px）展开态 ⇒ 侧栏改成**覆盖式抽屉**。官方窄屏是
 *      "挤窄中间列"，在手机上中间列只剩 ~80px、标题竖成一条（真机截图实证）——
 *      这不是移动端该有的形态。
 *   §D 收起态入口 = **dsh 官方那颗 opener**（2026-11-11 用户裁决）。历史上这里补过一颗
 *      自绘浮动开关（⊞）：官方那颗在收起态默认只有鼠标悬停才显形，于是"补一颗常显的"。
 *      真机实测收起态是 56px 图标轨、官方 opener 就在轨首，两颗粒子叠在一起非常乱
 *      —— 用户明确要求删自绘、把官方那颗常显出来。现在：
 *        · 不再创建/注入任何自绘按钮；
 *        · 收起态用一条 CSS 把官方 opener 强制成常显（opacity / visibility / 指针事件，
 *          不改 display，避免把官方布局压坏）；
 *        · 点按仍走官方 toggle（clickToggle 程序化点击同一颗按钮），不引入第二套状态。
 *   §E 桌面档（PC / 2in1）**不隐藏**官方那颗按钮：壳侧顶栏入口已于 2026-11-11 删除，
 *      官方按钮就是唯一入口（隐藏它 = 侧栏再也叫不出来）。
 *
 * 【2026-11-07 平板口径·第六次收敛 / 用户裁决】平板**就是平板**：form=tablet 独立挂
 *   dshm-tablet 档，既不套手机（dshm-phone）也不套 PC（dshm-desktop）。前几轮叠加的
 *   「去掉按钮 / 复用 PC / 恒展开静态锚点 / 统一 handheld 后打补丁」全部作废（历史注记，非当前实现）。
 *   · 左栏默认常驻展开：§A/§B/§D 的手持档规则统一加 :not(.dshm-tablet) 让路 ⇒ 左栏
 *     始终占位、不压 0 宽、不做覆盖抽屉；几何全部交回官方 computeColumns。
 *   · 官方「DSHM」字标右侧按钮**保留可见**：它是唯一入口，点它只缩到官方 56px 图标轨
 *     （收起只是缩小、不消失），再点展开，按钮一直跟着左栏；不另造自绘按钮。
 *   · 默认展开、不自动收起：不保留任何 keep-open / auto-expand / 手动收起闩 / 点外收起
 *     状态机；不做启动补点或自愈。手机（phone）与 PC（desktop / pc-mode）分支一行不动。
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
 * 收起态那条「官方 opener 常显」规则只在这个状态下生效 —— 展开态本来就带着官方的
 * 「收起侧边栏」按钮，不需要再额外抬一颗出来。
 */
const SIDEBAR_STATE_ATTR: string = 'data-dshm-sidebar';
/**
 * 启动自愈：手持档（手机 / 折叠屏）+ 视口已足够宽 + 官方侧栏仍是收起态 ⇒ 自动点开一次。
 *
 * 【2026-11-07 平板口径】平板独立档不参与任何自愈 / 补点 / 意图闩；这里只服务手机 / 折叠屏。
 *
 * 【为什么是一次性 + 有时间窗】不能跟用户抢：只在启动后 **15 秒**内、视口 ≥ **900vp** 时试一次；
 * 用户自己收起后不会被强行展开（窗口早过 + autoTried 置真）。两个阈值以字面量写在
 * 垫片函数里（理由见 where 处注释：模板串插值会让桩环境与插值登记门禁判红）。
 */
const SIDEBAR_SHIM_JS: string = `(function () {
  if (globalThis.__DSHM_SIDEBAR__) { return; }
  /* 官方按钮的两个文案（zh 为准，en 兜底）。只用于"是不是它"与"现在什么态"。 */
  var COLLAPSE_LABELS = ['收起侧边栏', 'Collapse sidebar'];
  var OPEN_LABELS = ['打开侧边栏', 'Open sidebar'];
  /* 云同步入口的无障碍名（中英各一，与其它按钮同一约定）。 */
  /* 我们自己挂的钩子：CSS 只认这些名字，不认官方哈希类名（见头注 §C）。 */
  var FRAME_CLASS = 'dshm-frame';
  var COL_CLASS = 'dshm-sbcol';
  var NODRAG_CLASS = 'dshm-nodrag';
  /* 【2026-11-07 平板独立档】平板就是平板：form=tablet 额外挂这个独立档标记，
     既不套手机（dshm-phone）也不套 PC（dshm-desktop）。§A/§B 的手持档规则（收起压 0 宽 /
     覆盖式抽屉）用 :not(.dshm-tablet) 绕开平板 ⇒ 左栏默认常驻展开、
     收起只是缩到官方 56px 图标轨；官方按钮保留可见，是唯一的收起/展开入口。
     它只是 CSS 档位标记，不参与任何运行时「是否常驻 / 隐藏 / 可收起」判断。
     手机（phone / foldable）与 PC（desktop / pc-mode）分支一行不动。*/
  /* 直板手机专属标记（平板与折叠屏**都没有**它）：设置面板的手机化布局认这个类，
     不认 dshm-handheld。手持档内部再分一层的理由见 applyHandheld() 与 SETTINGS_SHIM_JS 的头注。 */
  var PHONE_CLASS = 'dshm-phone';
  var HANDHELD_CLASS = 'dshm-handheld';
  var DESKTOP_CLASS = 'dshm-desktop';
  var TABLET_CLASS = 'dshm-tablet';
  /* 【2026-10-18 PC 模式】手持形态跑在自由窗口（电脑模式）时的肯定式标记：
     桌面档布局 + 保留官方侧栏按钮 + 收起态补浮动按钮。见 EntryAbility 的 KEY_PC_MODE。 */
  var PC_CLASS = 'dshm-pc';
  var STATE_ATTR = '${SIDEBAR_STATE_ATTR}';
  /* 图标轨里那颗官方 toggle 是否真的可用（由 syncOpener 每拍写 1/0）：
     为 1 时把 frame leading 座位里重复的 [data-sidebar-opener] 收掉。 */
  var RAIL_OPENER_ATTR = 'data-dshm-rail-opener';
  var STYLE_ID = 'dshm-sidebar-style';
  var BACKDROP_ID = 'dshm-sidebar-backdrop';
  /*
   * 面板/浮层打开状态（写进 html 元素的 data 属性）。
   *
   * 【为什么要有它】2026-10-16 真机：设置面板（含插件的二级页）左上角的「返回上一层」/标题
   * 正好压在收起态那颗开关上 —— 面板是 body 上的 portal 全屏层。收起态现在显示的是
   * 官方 opener，面板打开时也一并把它藏掉，避免压住面板标题。
   * 判据与 BACK_SHIM 的 OVERLAY_SEL 同一组（口径统一：什么算"浮层"只有一处说法）。
   */
  var PANEL_ATTR = 'data-dshm-panel';
  /* 【2026-10-18 右侧栏】右侧栏（文件预览/终端/浏览器）打开时隐藏左上浮动按钮：
     手持档右栏是覆盖整屏的抽屉，左上角正是它的标题区。判据只用官方属性
     data-sidebar-right-open（展开才有）+ 非 aria-hidden。 */
  var RIGHT_ATTR = 'data-dshm-right';
  var PANEL_SEL = '[data-shortcut-modal],[role="dialog"],[role="menu"],[role="listbox"],section[data-desktop-onboarding]';
  /* 状态巡检周期（ms）：为什么用巡检而不是 MutationObserver，见 syncState()。 */
  var TICK_MS = 300;
  /*
   * 【失焦降频（2026-10-29，方案 A）】页面 hidden 时把巡检从 300ms 降到 1500ms：
   * 后台时这套 DOM 扫描 + 桥调用没有任何读者，全速跑只是白耗（docs/277：每秒
   * 200+ 次 DOM/桥操作）。保底 1500ms 而不是停摆 —— 本垫片承担"React 整段重建后
   * 的自愈"（docs/136/201），彻底停掉会让长会话后台重排后侧栏状态漂移无人纠正。
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
  /* 手持档判据只问原生桥（跨语言调用不便宜）；问到就记 key，同一结论不重复应用。
     【2026-10-18 PC 模式】必须可重入：首帧桥可能先答 handheld，紧接着 pcMode 变真。 */
  var handheldAsked = false;
  var appliedFormKey = '';
  /* 桌面档判据（PC / 2in1）。2026-11-11 起 §E 已撤销（官方按钮不再隐藏），
     这个变量只喂一次性诊断行，不参与任何 CSS / 行为判定。 */
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
  /* 折叠屏在单屏/双屏之间切换时要能摘掉形态类（平板档 / 直板机档）。
     【2026-11-12 用户裁决】判据只用原生桥 form / platformSingleScreen，不看视口宽度。 */
  function removeClass(el, cls) {
    if (el === null || el === undefined) { return; }
    var cur = el.getAttribute('class');
    if (cur === null) { return; }
    var kept = cur.split(/\s+/).filter(function (c) { return c.length > 0 && c !== cls; }).join(' ');
    el.setAttribute('class', kept);
  }
  /* 官方那颗按钮：先按 aria-label 文案找（契约面），再按 CSS Modules 的 _toggle 后缀兜底。 */
  function findToggle() {
    var buttons = document.querySelectorAll('button');
    /* 2026-11-06 0.2.2-rc.1：跳过常驻 opener（aria-label 恒「打开侧边栏」）。
       它若被当成状态按钮，stateOf() 永远读到 collapsed；tagLayout() 还会把
       dshm-sbcol 挂到顶栏那一格，导致侧栏几何整体错位。 */
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
   * 抽屉态下官方只保留顶栏 opener 一颗开关 ⇒ 点它等价于切换侧栏。
   * **只用于点击**，绝不参与状态判定（见 stateFromFrame）。
   */
  function findOpener() {
    try { return document.querySelector('button[data-sidebar-opener]'); } catch (e) { return null; }
  }
  /*
   * 【2026-11-11 收起态只留一颗按钮】
   * 官方在两处渲染"打开侧边栏"：
   *   ① 图标轨顶部那颗 rail toggle（class 带本地名后缀 _toggle，aria-label 取文案）；
   *   ② frame leading 座位里的 [data-sidebar-opener]（absolute，PC 在 left:88px，
   *      drawer 态在 left:12px）。
   * 平板档把侧栏列写死成 56px 轨后，两条同时可见 ⇒ 用户报的"平板有两个按钮"。
   *
   * 这里每拍判断轨内那颗**是否真的可用**（有盒子且没被 display / visibility /
   * opacity 藏掉）；可用就给 html 写 data-dshm-rail-opener="1"，CSS 据此把 leading
   * 那颗收掉。读不到轨内 toggle（比如 PC 宽窗口侧栏完全隐藏）就写 0，退回原样 ——
   * 那时 leading 那颗才是唯一入口，不能藏。
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
   * 官方 0.2.2 顶栏新增**常驻** [data-sidebar-opener]，aria-label 恒为「打开侧边栏」。
   * 旧版 findToggle() 会先命中它 ⇒ stateOf() 永远返回 collapsed ⇒ 平板侧栏几何整体错位
   * （真机现象：灰、点不动、按钮常驻）。
   *
   * 正解：读官方 frame 的结构化属性 data-sidebar-collapsed（收起才有、展开时移除）。
   * 属性名是 JSX 字符串字面量，压缩不改名；aria-label 只在 frame 未挂载时兜底。
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
   * 0.2.2 的 <768 抽屉形态：官方遮罩 z-index:70 / 侧栏列 z-index:71。
   * 这一档必须把几何与遮罩**交还官方**，否则我们低 z-index 的侧栏会被遮罩盖住
   * （看着"灰"）且点击被遮罩吃掉（点不到）。
   */
  function isDrawer() {
    try { return document.querySelector('[data-sidebar-drawer]') !== null; } catch (e) { return false; }
  }
  /*
   * 【2026-11-06 0.2.2-rc.1】官方在 drawer 态给 sidebarCol / CenterColumn / RightbarColumn /
   * bottomRow / leadingSeat 加 HTML inert ⇒ 整棵子树变灰且完全不可交互（设置面板、
   * DeepSeek 登录、插件入口、终端全部点不到）。1.1.7 的核心 inert 出现 0 次。
   * 几何已交还官方，但 inert 仍会让主区在抽屉展开时不可点 ⇒ 整页清掉，
   * 并用 MutationObserver 同帧压制官方重渲染回写。
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
    /* 【2026-11-07】平板档：官方一旦把 frame 标成抽屉，absolute 定位 / 遮罩 / 点外收起
       会整套生效（真机 18:05：点会话区空白处左栏就收、遮罩还盖住按钮）。每拍摘掉这个属性，
       让官方 CSS 退回三栏网格；几何与列行为由上面那组平板规则接管。
       【2026-11-18 竖屏修正】只有 ≥1024（官方非 narrow）才摘；<1024 反过来**补上**
       drawer 属性，让官方按抽屉浮层渲染 —— 写死 280 会把主列挤进左栏，见 ensureStyle 头注。 */
    if (tabletActive()) {
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
      /*
       * 2026-11-11（用户裁决）：官方那颗「收起 / 打开侧边栏」重新成为唯一入口，
       * 顶栏左上角的自绘按钮已删除。这里只负责清掉旧版本可能写下的内联藏值，
       * 绝不再主动 display:none —— 否则桌面档就没有任何可见的侧栏开关。
       */
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
       * 【2026-11-11 用户裁决：收起态那颗按钮必须一直看得见】
       *
       * 读了随包核心（dsh-client-ui-sidebar 0.2.2-rc.1）的 CSS 才看明白：
       *   .hHd-Xa_collapsed .hHd-Xa_toggle .hHd-Xa_panelIcon{display:none}
       *   .hHd-Xa_collapsed .hHd-Xa_toggle:hover .hHd-Xa_panelIcon{display:inline}
       *   .hHd-Xa_collapsed .hHd-Xa_toggle:hover .hHd-Xa_railMark{display:none}
       * 即收起态轨首那颗按钮**显示的是品牌标**，侧栏图标只在 hover 时交换出来 ——
       * 用户看到的就是"按钮没了，鼠标碰到才出现"。
       * 这里把交换结果**固化**：收起态常显侧栏图标（panelIcon）、常隐品牌标（railMark）。
       * 类名用 [class*="_panelIcon"] 这种本地名后缀匹配：CSS Modules 只给前缀加哈希，
       * 本地名保留（与本文件既有的 [class*="drawerMask"] 同一套兜底思路）。
       *
       * 另外 frame 的 leading 座位还会挂一颗 [data-sidebar-opener]（absolute，PC 在
       * left:88px）。平板档轨内 toggle 与它同时可见 ⇒ 用户报的"平板有两个按钮"。
       * syncOpener() 每拍判断轨内那颗是否真的可用，可用就写 data-dshm-rail-opener="1"，
       * 下面第三条把 leading 那颗收掉 —— 全页始终只有一颗官方按钮。
       */
      + 'html[' + STATE_ATTR + '="collapsed"] button[aria-label="打开侧边栏"] [class*="_panelIcon"],'
      + 'html[' + STATE_ATTR + '="collapsed"] button[aria-label="Open sidebar"] [class*="_panelIcon"]'
      + '{display:inline !important}'
      + 'html[' + STATE_ATTR + '="collapsed"] button[aria-label="打开侧边栏"] [class*="_railMark"],'
      + 'html[' + STATE_ATTR + '="collapsed"] button[aria-label="Open sidebar"] [class*="_railMark"]'
      + '{display:none !important}'
      + 'html[' + RAIL_OPENER_ATTR + '="1"] button[data-sidebar-opener]{display:none !important}'
      /* 【2026-11-21 竖屏侧栏按钮消失】官方 narrow（<1024）把收起态的 opener display:none，
         只改 opacity/visibility 救不回来 ⇒ 这里补 display。手机 / 平板 / 折叠屏单屏收起态都命中。 */
      + 'html[' + STATE_ATTR + '="collapsed"] button[data-sidebar-opener]{display:inline-flex !important;opacity:1 !important;visibility:visible !important;pointer-events:auto !important}'
      + 'html[' + STATE_ATTR + '="collapsed"][' + PANEL_ATTR + '="open"] button[data-sidebar-opener]{opacity:0 !important;pointer-events:none !important}'
      + 'html[' + RIGHT_ATTR + '="open"] button[data-sidebar-opener]{opacity:0 !important;pointer-events:none !important}'
      /* 【2026-11-07 第八次收敛：平板左栏"真常驻"】
         18:05 真机日志 + 截图证明官方在这台平板上仍按 **narrow / drawer** 渲染：侧栏是
         覆盖式浮层（position:absolute）、点会话区空白处就收、收起后列被压到 0。
         这里不再"全部交还官方"，改为平板档**自己掌控几何**（状态仍读官方的
         data-sidebar-collapsed，点按仍走官方 toggle ⇒ 不会出现 docs/385 §2 的两套状态）：
           ① 展开 280 / 收起 56，两条都写死；
           ② 侧栏列强制 in-flow（去掉 absolute/inset/transform/visibility）⇒ 不再是悬浮抽屉；
           ③ 抽屉遮罩不参与交互（JS 每拍还会摘掉 frame 上的 data-sidebar-drawer）；
           ④ 收起态的入口就是官方 opener（上面那条规则让它常显），不再补第二颗。

         【2026-11-18 竖屏 / 折叠屏展开修正：写死几何只在 ≥1024 生效】
         官方布局判据是 narrow = viewport < 1024、drawer = viewport < 768
         （dsh-client-ui-layout：collapsedWidth 在 drawer 时为 0、narrow 时为 56，
         真正 280 只在非 narrow 出现）。平板竖屏（典型 736–950vp）与折叠屏展开
         都落在 narrow 里：官方把侧栏列做成 absolute 抽屉、主列占据整幅网格。
         我们再无条件写死 280/56，主列就回流进第 1 轨、会话区压到左栏上
         （用户实测：所有平板 / 折叠屏展开时"会话区侵入左侧边栏、左栏显示不全"）。
         ⇒ 写死几何收进 ≥1024 的媒体查询；<1024 交给官方抽屉浮层
         （tagLayout 会补 data-sidebar-drawer），主区不被挤、左栏整幅显示。 */
      /* 【2026-11-21 平板竖向】收起态 56px 轨**任何宽度**都生效（原来包在 ≥1024 里，竖向 <1024
         时平板规则全不命中，只剩官方 narrow/drawer，官方又把 opener 藏了 ⇒ 竖屏无侧栏按钮）。
         展开态 280 仍只在 ≥1024 写死：<1024 交官方抽屉，避免主区被挤（保持 2026-11-18 结论）。 */
      + 'html.' + TABLET_CLASS + '[' + STATE_ATTR + '="collapsed"]:not([' + RIGHT_ATTR + '="open"]) .' + FRAME_CLASS
      + '{grid-template-columns:56px minmax(0,1fr) 0 !important}'
      + 'html.' + TABLET_CLASS + '[' + STATE_ATTR + '="collapsed"] .' + COL_CLASS
      + '{position:relative !important;top:auto !important;left:auto !important;right:auto !important;bottom:auto !important;'
      + 'transform:none !important;visibility:visible !important;z-index:auto !important;'
      + 'width:auto !important;max-width:none !important;box-shadow:none !important}'
      + '@media (min-width:1024px){'
      + 'html.' + TABLET_CLASS + '[' + STATE_ATTR + '="expanded"]:not([' + RIGHT_ATTR + '="open"]) .' + FRAME_CLASS
      + '{grid-template-columns:280px minmax(0,1fr) 0 !important}'
      + 'html.' + TABLET_CLASS + ' .' + COL_CLASS
      + '{position:relative !important;top:auto !important;left:auto !important;right:auto !important;bottom:auto !important;'
      + 'transform:none !important;visibility:visible !important;z-index:auto !important;'
      + 'width:auto !important;max-width:none !important;box-shadow:none !important}'
      + 'html.' + TABLET_CLASS + ' [class*="drawerMask"]{display:none !important;pointer-events:none !important}'
      + '}'
      /* 「收起 ⇒ 整列 0」只作用于手机 / 折叠屏单屏抽屉，平板独立档不套用。 */
      + 'html.' + HANDHELD_CLASS + ':not(.' + TABLET_CLASS + ')[' + STATE_ATTR + '="collapsed"] .' + FRAME_CLASS + ':not([data-sidebar-drawer])'
      + '{grid-template-columns:0 minmax(0,1fr) 0 !important}'
      /* frame 视口锚定：平板（handheld）也需要，旋转/分屏重排后不留下右侧白区。 */
      + 'html.' + HANDHELD_CLASS + ' .' + FRAME_CLASS
      + '{width:100% !important;max-width:100% !important;min-width:0 !important}'
      + '@media (min-width:768px) and (max-width:1023.98px){'
      + 'html.' + HANDHELD_CLASS + ':not(.' + TABLET_CLASS + ')[' + STATE_ATTR + '="expanded"] .' + FRAME_CLASS + '{grid-template-columns:0 minmax(0,1fr) 0 !important}'
      + 'html.' + HANDHELD_CLASS + ':not(.' + TABLET_CLASS + ')[' + STATE_ATTR + '="expanded"] .' + COL_CLASS + '{position:relative;z-index:80;width:280px;max-width:82vw;box-shadow:0 6px 28px rgba(0,0,0,0.4)}'
      + 'html.' + HANDHELD_CLASS + ':not(.' + TABLET_CLASS + ')[' + STATE_ATTR + '="expanded"] .' + NODRAG_CLASS + '{display:none !important}'
      + 'html.' + HANDHELD_CLASS + ':not(.' + TABLET_CLASS + ')[' + STATE_ATTR + '="expanded"] #' + BACKDROP_ID + '{display:block}'
      + '}';
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }
  /* 抽屉打开时"点空白处收起"的底座（只在 §B 形态可见，显隐由 CSS 管）。 */
  function ensureBackdrop() {
    /* 只在手机 / 折叠屏手持档创建：桌面档与平板独立档都不该存在任何
       "点空白收起"的遮罩与它那颗点击监听（平板左栏常驻、用官方按钮收起）。 */
    var cls = document.documentElement.getAttribute('class') || '';
    if (cls.indexOf(HANDHELD_CLASS) < 0 || cls.indexOf(TABLET_CLASS) >= 0) { return; }
    if (document.getElementById(BACKDROP_ID) !== null || document.body === null) { return; }
    var bd = document.createElement('div');
    bd.id = BACKDROP_ID;
    bd.addEventListener('click', function () {
      if (state() === 'expanded') { clickToggle(); }
    });
    document.body.appendChild(bd);
  }
  /* 手持档判据的**唯一真源**是原生桥（platformForm()，见 WebApp.bridges）；
     桥还没就位就下一拍再问。问到才决定要不要加 dshm-handheld（§B 的总开关）。
     【2026-11-07 平板口径·第二次修正】form=tablet **仍是平板**：进手持档、挂
     dshm-handheld（保住平板窗口壳 / 顶栏 / 自由窗口 / 分屏 / 页面适配），再额外挂静态
     TABLET_CLASS 让左栏常驻。绝不改判 dshm-desktop —— 那会把整机变成 PC 应用。
     phone / foldable 同样进手持档；phone 额外挂 dshm-phone。 */
  /*
   * 桥"就位探测"的退避（2026-10-29，docs/291 高频报错）：
   * 垫片由 javaScriptOnDocumentStart 注入（早于页面脚本），而 __DSHM_BRIDGES__ 由
   * .javaScriptProxy 属性注册 —— 两者不保证同一时刻就位。桥对象存在但方法尚未挂上时，
   * 每拍调用一次都会让 ArkWeb 打一条 native proxy object not found 报错
   * （真机实测可达每秒十余次、占日志六成）。这里给"探测失败"加指数退避：
   *   · 成功一次即清零，后续仍按 300ms 正常巡检；
   *   · 失败则 1s → 2s → 4s → 封顶 8s 再试，绝不对着尚未就位的桥每拍敲一次。
   * 这只改变**探测节奏**，不改变任何形态判定：桥一旦就位，下一拍即恢复全速。
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
    var pcm = false;
    try { pcm = typeof b.platformPcMode === 'function' ? b.platformPcMode() === true : false; } catch (e2) {
      /* 同上：抛异常 ⇒ 桥当前不可用 ⇒ 走退避，别每拍硬敲 */
      bridgeMiss = Math.min(bridgeMiss + 1, 4);
      bridgeRetryAt = now + Math.pow(2, bridgeMiss) * 500;
      return;
    }
    /* 【可重入（2026-10-18 PC 模式）】首帧桥可能先答 handheld（能力层窗口状态还没读到），
       紧接着 pcMode 变真 ⇒ 必须能把 dshm-handheld 摘下来，否则永远停在"无原生顶栏、
       也没有侧栏入口"的手持档。同一结论只应用一次（300ms 巡检每拍都会进来）。 */
    var key = form + (pcm ? '|pc' : '');
    if (key === appliedFormKey) {
      /* 官方/React 偶尔重写 <html> 的 class：只补平板独立档标记，不重跑整套形态切换。
         折叠屏双屏/三屏走桌面档，不补平板档。 */
      if (form === 'tablet') { addClass(document.documentElement, TABLET_CLASS); }
      return;
    }
    var first = !handheldAsked;
    appliedFormKey = key;
    handheldAsked = true;
    var htmlEl = document.documentElement;
    var cur = htmlEl.getAttribute('class');
    if (cur === null) { cur = ''; }
    if (form === 'phone' || form === 'tablet') {
      if (cur.indexOf(HANDHELD_CLASS) < 0) { addClass(htmlEl, HANDHELD_CLASS); }
      /* 平板就是平板：额外打独立档标记 dshm-tablet（无状态机、无收起判断）。
         【2026-11-12 用户裁决】折叠屏双屏/三屏（form=foldable）不进手持档 —— 它走下面
         的桌面档，跟 PC 打开一样：收起左侧栏由官方原生窄轨处理，不再套这里 56px 自绘轨
         （那套被判定为「不伦不类」）。平板档保持原样，不因折叠屏改动。 */
      if (form === 'tablet') { addClass(htmlEl, TABLET_CLASS); }
      else { removeClass(htmlEl, TABLET_CLASS); }
      isDesktop = false;
    }
    /* 非手持档 = PC / 2in1，挂一个**肯定式**标记（dshm-desktop）。为什么不能反过来
       写成“没有 dshm-handheld 就当桌面”：那个类是异步问桥之后才挂上的，问之前两者
       都没有，否定式会在手持档“桥还没答”的那一小段里误判成桌面（§E 于是提前生效）。 */
    else {
      if (cur.indexOf(HANDHELD_CLASS) >= 0) {
        /* 从手持档升级到 PC 模式：摘掉 dshm-handheld 与平板独立档标记（手持规则随之失效）。
           这是本垫片里唯一一处摘类，触发面只有 pcMode 翻转；手机/PC 行为不变。 */
        var kept = cur.split(/\s+/).filter(function (c) {
          return c.length > 0 && c !== HANDHELD_CLASS && c !== TABLET_CLASS;
        }).join(' ');
        htmlEl.setAttribute('class', kept);
        log('pc-mode: 摘掉 dshm-handheld（手持档 → 桌面档）');
      }
      isDesktop = true;
      if (cur.indexOf(DESKTOP_CLASS) < 0) { addClass(htmlEl, DESKTOP_CLASS); }
      if (pcm && cur.indexOf(PC_CLASS) < 0) { addClass(htmlEl, PC_CLASS); }
    }
    /* 直板机专属（见 PHONE_CLASS 的注释）。放在最后：与上面两支互不干扰。
       只有 form=phone（含折叠单屏）挂 dshm-phone；平板仍挂 dshm-handheld（另有独立档
       dshm-tablet）；折叠屏双屏/三屏与 PC / 2in1 走桌面档。非 phone 形态一律摘掉
       dshm-phone，避免单屏展开成双屏后仍残留手机档样式。 */
    if (form === 'phone') { addClass(htmlEl, PHONE_CLASS); }
    else { removeClass(htmlEl, PHONE_CLASS); }
    log('platform form = ' + form + (pcm ? ' (pc-mode)' : '') + (first ? '' : ' (reclassified)'));
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
  function syncState() { applyState(state(), '(poll)'); }
  /* 可见性判据：真有布局盒子、且没被 display / visibility / opacity 藏掉（与 BACK_SHIM 的 visible() 同款）。 */
  function panelElVisible(el) {
    if (el.getClientRects().length === 0) { return false; }
    var cs = window.getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }
  /* 现状：屏幕上有没有可见的面板/浮层（决定收起态要不要把 opener 暂时隐去）。 */
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
    /* 第二问：那条 CSS 规则到底能不能匹配上（首版只挂 CSS 时它没生效，必须判到底是
       ‘选择器不匹配’还是‘匹配了但被别的规则压住’）。 */
    var sel = 'html.' + DESKTOP_CLASS + ' .' + FRAME_CLASS + ' button[aria-label="' + COLLAPSE_LABELS[0] + '"]';
    var hit = 'n/a';
    var styleEl = 'n/a';
    var hasRule = 'n/a';
    var frameCls = 'n/a';
    try {
      var t = findToggle();
      hit = (t !== null && typeof t.matches === 'function') ? String(t.matches(sel)) : 'no-matches-api';
      var el = document.getElementById(STYLE_ID);
      styleEl = el === null ? 'null' : 'yes';
      hasRule = el === null ? 'n/a' : String(el.textContent.indexOf('html.' + DESKTOP_CLASS) >= 0);
      var fr = findFrame();
      frameCls = fr === null ? 'null' : String(fr.getAttribute('class'));
    } catch (e) { hit = 'err'; }
    log('diag2 matches=' + hit + ' styleEl=' + styleEl + ' hasRule=' + hasRule + ' frameClass=' + frameCls);
    log('diag desktop=' + isDesktop + ' htmlClass=' + JSON.stringify(document.documentElement.getAttribute('class'))
      + ' candidates=' + parts.length + ' :: ' + parts.join(' | '));
    /* 【云测取证（2026-11-07）】12s 快照：视口 / 抽屉 / 状态 / html 类。 */
    log('diag vw=' + Math.round(window.innerWidth || 0) + 'x' + Math.round(window.innerHeight || 0)
      + ' dpr=' + (window.devicePixelRatio || 0) + ' drawer=' + isDrawer() + ' state=' + state()
      + ' htmlClass=' + JSON.stringify(document.documentElement.getAttribute('class')));
  }
  /*
   * 启动自愈（阈值见下：只在前 15s、视口 ≥ 900 才试一次）：
   * 手持档 + 视口 ≥ 阈值 + 官方仍在收起态 ⇒ 程序化点开一次；只试一次。
   * 【2026-11-07 平板口径】平板不走这一支（它要"持续常驻 + 尊重用户收起"，
   * 见 ensureTabletExpanded）；这里只服务手机 / 折叠屏的"首启一次性点开"。
   *
   * 【为什么用字面量 15000 / 900 而不是插值常量】SIDEBAR_SHIM_JS 整段是模板字符串：
   * 这里写插值占位符会让桩环境把它当 JS 语法执行（Unexpected token），也会让
   * tools/check-sidebar-shim-css.mjs 判"未登记插值"。两个数只在垫片内用一次。
   */
  var autoBootAt = 0;
  var autoTried = false;
  /*
   * 【2026-11-07 平板常驻（docs/385 §3.2 / docs/386 B.3）】
   * 平板默认展开，且不能被官方"切面板 / 切会话 / 跨断点重排"时的那次自动收起顶掉；
   * 但**尊重用户**：用户亲手点官方「收起侧边栏」后停手，点开之后恢复常驻。
   *
   * 判据两层：
   *   · 状态：官方 frame 的 data-sidebar-collapsed（stateFromFrame，不看 aria-label）；
   *   · 意图：tabletWantsExpanded，**只由真人点击**改（isTrusted），程序化补点不动它。
   * 补点 800ms 一次（与官方过渡 --ds-transition-duration-slow 同量级）；视口 <768
   * 是官方抽屉形态，展开会盖住内容 ⇒ 与手机一致，不替用户拉开。
   */
  var tabletWantsExpanded = true;
  var tabletLastExpandAt = 0;
  var tabletExpandTries = 0;
  var tabletFirstExpandAt = 0;
  var tabletIntentBound = false;
  function bindTabletIntent() {
    if (tabletIntentBound || typeof document.addEventListener !== 'function') { return; }
    tabletIntentBound = true;
    document.addEventListener('click', function (ev) {
      if (ev === null || ev === undefined || ev.isTrusted !== true) { return; }
      var node = ev.target;
      while (node !== null && node !== undefined && node.tagName !== 'BUTTON') { node = node.parentElement; }
      if (node === null || node === undefined) { return; }
      var label = node.getAttribute('aria-label');
      if (label === null) { return; }
      if (has(COLLAPSE_LABELS, label)) { tabletWantsExpanded = false; log('tablet: 用户收起 ⇒ 停手'); }
      else if (has(OPEN_LABELS, label)) { tabletWantsExpanded = true; tabletExpandTries = 0; log('tablet: 用户展开 ⇒ 恢复常驻'); }
    }, true);
  }
  function tabletActive() {
    var cls = document.documentElement === null ? '' : (document.documentElement.getAttribute('class') || '');
    return cls.indexOf(TABLET_CLASS) >= 0;
  }
  function ensureTabletExpanded() {
    bindTabletIntent();
    if (ticks < 4 || !tabletActive() || !tabletWantsExpanded) { return; }
    /* 【2026-11-18】<1024 走官方抽屉浮层（见 ensureStyle / tagLayout）：
       抽屉默认收起、由官方 opener 呼出；这里再补点就等于每次启动都把浮层盖在主区上，
       所以补点只在官方非 narrow（≥1024，真·常驻 280）时做。 */
    if (Math.round(window.innerWidth || 0) < 1024) { return; }
    if (state() !== 'collapsed') { tabletExpandTries = 0; return; }
    var now = Date.now();
    /*
     * 【2026-11-10】补点收敛为"启动期一次性恢复"，不再长期抢状态。
     *
     * 旧实现最多补点 40 次、2s/5s 退避，等于把"用户收起"以外的所有收起都当异常，
     * 长期与官方/用户操作对点：用户明明收起了，几百毫秒后又被弹开，观感就是
     * "按钮自己乱动"，也会把 280px 列反复写来写去（与 dshm-frame 的列宽竞争同源）。
     * 现在只在前 8 秒、最多 5 次内把"首帧布局落定后丢失的展开意图"补回来；
     * 之后一律以官方状态 + 用户亲手点击为准。
     */
    var gap = 800;
    if (tabletExpandTries > 2) { gap = 2000; }
    if (now - tabletLastExpandAt < gap) { return; }
    if (tabletExpandTries >= 5) { return; }
    if (tabletFirstExpandAt === 0) { tabletFirstExpandAt = now; }
    if (now - tabletFirstExpandAt > 8000) { return; }
    tabletLastExpandAt = now;
    tabletExpandTries += 1;
    if (tabletExpandTries === 1) { log('tablet: 左栏被收起 ⇒ 补点展开（常驻 280）'); }
    clickToggle();
  }
  function maybeAutoExpand() {
    if (autoTried) { return; }
    if (autoBootAt === 0) { autoBootAt = Date.now(); return; }
    if (Date.now() - autoBootAt > 15000) { autoTried = true; return; }
    var cls = document.documentElement === null ? '' : (document.documentElement.getAttribute('class') || '');
    if (cls.indexOf(HANDHELD_CLASS) < 0 || cls.indexOf(TABLET_CLASS) >= 0) { return; }
    var w = Math.round(window.innerWidth || 0);
    if (w < 900) { return; }
    if (document.querySelector('[data-sidebar-collapsed]') === null) { autoTried = true; return; }
    var toggle = findToggle();
    if (toggle === null) { return; }
    autoTried = true;
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
      /* 2026-11-06 0.2.2-rc.1：抽屉展开时官方给主区/底栏/侧栏列挂 inert，
         整棵子树变灰且不可交互 ⇒ 每拍清一次 + Observer 同帧压制。 */
      watchInert();
      clearDrawerInert();
      syncState();
      syncOpener();
      maybeAutoExpand();
      ensureTabletExpanded();
      syncPanel();
      syncRight();
      if (ticks === 40) { diagToggle(); }
    } catch (e) { /* 单拍失败不致命：下一拍重来 */ }
  }
  var tries = 0;
  function clickToggle() {
    var el = findToggle();
    /* 抽屉态（<768）官方只留顶栏 opener 一颗开关 ⇒ 兜底用它。 */
    if (el === null) { el = findOpener(); }
    if (el === null) {
      if (tries < 40) {
        tries += 1;
        setTimeout(clickToggle, 150);
      }
      else { log('toggle button not found, frame=' + frameFlag()); }
      return;
    }
    tries = 0;
    var before = state();
    try {
      el.click();
    } catch (e) {
      log('click threw: ' + e);
      return;
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
  /* 【云测取证（2026-11-07）】垫片启动时的真实 CSS 视口与密度：平板左栏常驻展开的
     首帧状态看这一行即可。 */
  log('boot vw=' + Math.round(window.innerWidth || 0) + 'x' + Math.round(window.innerHeight || 0)
    + ' dpr=' + (window.devicePixelRatio || 0) + ' state=' + state() + ' frame=' + frameFlag());
})();`

/**
 * 设置面板的**直板手机**布局垫片（2026-10-10 用户裁决；2026-10-13 收窄到直板机）。
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
 * `html.dshm-phone .dshm-set-panel.dshm-set-ready` 开头 ⇒ 一条都不落地，页面回到官方
 * 原样。宁可"没适配"，也绝不改出个半拉子面板。
 *
 * 【只在**直板手机**档启用（2026-10-13 收窄）】判据是 `html.dshm-phone` —— 由 SIDEBAR_SHIM_JS
 * 从原生桥问到（唯一真源 platform.isPhoneForm()）。**平板与折叠屏刻意不在内**：它们宽度够，
 * 官方"左导航 + 右内容"本来就放得下，铺满 + 顶部横条反而白丢内容高度。用户原话："平板端其实
 * 设置的 UI 用 PC 端的，因为平板的宽度是足够的，只有手机端的才需要横过来"；随后追加："设置
 * 的 UI 手机只是直板机是横着的，折叠机也是 PC 竖着的 UI"。
 * 于是本垫片有三个"一个字节都不改"的档：平板、折叠屏、PC / 2in1 —— 它们都拿不到 `dshm-phone`。
 *
 * 【当前项为什么不用 JS 维护】官方那颗按钮自带 `aria-current="true"`（无障碍契约面），
 * 直接写进 CSS 选择器即可 —— 少一路 JS 状态，也就不会出现"CSS 里的选中态与官方漂开"。
 *
 * 【为什么也是 300ms 巡检】面板是 body 上的 portal，开关一次重建一次；导航项还会随插件
 * 增减而变。巡检比 MutationObserver 便宜也简单（与 SIDEBAR_SHIM_JS 同款取舍），且每一拍
 * 的写操作都是幂等的 addClass。
 */

/**
 * 液态玻璃皮肤（Web 层，2026-11-05，docs/359 一期）。
 *
 * 【为什么是"打标记 + 自己的 CSS"】与 SIDEBAR/SETTINGS 垫片同一套路：上游是 CSS Modules
 * 哈希类名（`._dialog_o6lrb_33` 这种每次构建都变），**不能**按官方类名写选择器。
 * 这里按**结构与角色**找三个面（侧栏 / 对话框 / 菜单），给它们挂
 * `data-dshm-glass="<面>"`，样式只认这个属性 ⇒ 上游换类名不会把我们写死。
 *
 * 【2026-11-11 用户裁决：顶栏与输入框退出皮肤】用户原话"为啥要改 web 的顶栏和会话
 * 输入框呢现在黑黑的，恢复 dsh 默认"。这两个面是 dsh 的视觉主体，壳侧不再打标：
 * 官方背景/圆角/边框原样生效。要恢复的沉浸感由侧栏与浮层承担。
 *
 * 【深浅跟着页面走，不跟系统】真机实测：系统深色 + dsh 浅色页面 ⇒ 白页面被套上
 * 深色玻璃。改为采样页面底色后写 `html[data-dshm-glass-dark]`，CSS 只认这个属性。
 *
 * 【只做"结构性玻璃"】正文、代码块、表格**不加**（滚动区每帧重采样，2in1 上会掉帧，
 * 长文可读性也会坏）。这是 docs/359 §3.2 的性能红线，不是省事。
 *
 * 【降级】`CSS.supports('backdrop-filter', ...)` 为假时整层退回实色（@supports 兜底），
 * 并把手持档的模糊半径降到 12px。探针把"支持/命中几个面/明暗"写进 files/diag-glass。
 *
 * 【开关】`window.dshmGlass.set('on'|'off'|'auto')`；持久化在 localStorage，默认 auto
 * （支持就开）。ArkTS 侧要强制关时给 html 加 `data-dshm-glass="off"` 即可。
 */
const GLASS_SKIN_JS: string = `(function () {
  if (globalThis.__DSHM_GLASS__) { return; }
  var STORE_KEY = 'dshm.glass.mode';
  var SUPPORT = false;
  try {
    SUPPORT = !!(window.CSS && CSS.supports && (CSS.supports('backdrop-filter', 'blur(1px)')
      || CSS.supports('-webkit-backdrop-filter', 'blur(1px)')));
  } catch (e) { SUPPORT = false; }

  var STYLE_ID = 'dshm-glass-style';
  var CSS_TEXT = [
    ':root {',
    '  --dshm-glass-blur: 18px;',
    '  --dshm-glass-sat: 180%;',
    '  --dshm-glass-bg: rgba(255,255,255,.62);',
    '  --dshm-glass-bg-solid: rgba(255,255,255,.96);',
    '  --dshm-glass-edge: rgba(255,255,255,.72);',
    '  --dshm-glass-shadow: 0 10px 40px rgba(16,24,40,.18);',
    '}',
    /*
     * 【2026-11-11 深浅改跟页面、不跟系统】原来用 @media (prefers-color-scheme: dark)，
     * 但 dsh 页面自己决定明暗：真机实测系统深色 + dsh 浅色页面 ⇒ 白页面被套上
     * rgba(28,34,46,.66) 的深色玻璃，顶栏/输入框直接变黑。改由脚本采样页面底色，
     * 把结论写在 html 的 data-dshm-glass-dark 上，样式只认这个属性。
     */
    'html[data-dshm-glass-dark="1"] {',
    '  --dshm-glass-bg: rgba(28,34,46,.66);',
    '  --dshm-glass-bg-solid: rgba(22,28,38,.96);',
    '  --dshm-glass-edge: rgba(255,255,255,.26);',
    '  --dshm-glass-shadow: 0 10px 40px rgba(0,0,0,.52);',
    '}',
    'html.dshm-phone { --dshm-glass-blur: 12px; }',
    'html[data-dshm-glass="on"] [data-dshm-glass] {',
    '  background: var(--dshm-glass-bg);',
    '  -webkit-backdrop-filter: blur(var(--dshm-glass-blur)) saturate(var(--dshm-glass-sat)) brightness(1.04);',
    '  backdrop-filter: blur(var(--dshm-glass-blur)) saturate(var(--dshm-glass-sat)) brightness(1.04);',
    '  box-shadow: inset 0 1px 0 var(--dshm-glass-edge), var(--dshm-glass-shadow);',
    '  transition: background .18s ease, box-shadow .18s ease;',
    '}',
    /*
     * 【2026-11-11 用户裁决：只保留侧栏 / 弹窗 / 菜单，顶栏与输入框恢复 dsh 默认】
     * 顶栏和 composer 是 dsh 自己的视觉主体，套玻璃等于改它的外观（还额外塞了
     * border-radius:18px，把官方输入框形状也改了）。这两个面不再打标，
     * 也就不会命中下面这组规则 —— 官方背景/圆角/边框原样生效。
     */
    'html[data-dshm-glass="on"] [data-dshm-glass="sidebar"] { border-right: 1px solid var(--dshm-glass-edge); }',
    'html[data-dshm-glass="on"] [data-dshm-glass="dialog"] {',
    '  border: 1px solid var(--dshm-glass-edge);',
    '  border-radius: 22px;',
    '  box-shadow: inset 0 1px 0 var(--dshm-glass-edge), var(--dshm-glass-shadow);',
    '}',
    'html[data-dshm-glass="on"] [data-dshm-glass="menu"] {',
    '  border: 1px solid var(--dshm-glass-edge);',
    '  border-radius: 14px;',
    '  box-shadow: inset 0 1px 0 var(--dshm-glass-edge), var(--dshm-glass-shadow);',
    '}',
    '@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {',
    '  html[data-dshm-glass="on"] [data-dshm-glass] {',
    '    background: var(--dshm-glass-bg-solid);',
    '    -webkit-backdrop-filter: none; backdrop-filter: none;',
    '  }',
    '}',
    '@media (prefers-reduced-motion: reduce) {',
    '  html[data-dshm-glass="on"] [data-dshm-glass] { transition: none; }',
    '}'
  ].join('\\n');

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) { return; }
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS_TEXT;
    (document.head || document.documentElement).appendChild(el);
  }

  function preferred() {
    try {
      var v = localStorage.getItem(STORE_KEY);
      if (v === 'on' || v === 'off' || v === 'auto') { return v; }
    } catch (e) { /* 隐私模式读不到：按 auto */ }
    return 'auto';
  }

  function effective() {
    var m = preferred();
    if (m === 'off') { return false; }
    if (m === 'on') { return true; }
    return SUPPORT;
  }

  /*
   * 三个面：侧栏 / 弹窗 / 菜单。
   * 顶栏与输入框（composer）**刻意不在这里** —— 2026-11-11 用户裁决，它们恢复 dsh
   * 默认外观；壳侧只负责侧栏与浮层的沉浸质感。
   */
  function findSidebar() { return document.querySelector('.dshm-sbcol'); }
  function findDialogs() {
    var nodes = document.querySelectorAll('[role="dialog"], [aria-modal="true"]');
    var dialogs = [];
    for (var i = 0; i < nodes.length; i++) {
      /* 2026-11-17 用户实测：平板上玻璃化的设置面板叠官方 24% 遮罩读作"浅黑覆盖"、
         与浅色标题栏割裂 ⇒ 设置面板的官方排除从 PC 桌面标记（11-14）扩到全形态；
         官方不透明面板（--dsw-alias-bg-layer-2）与遮罩 token 复位，玻璃只留侧栏与非设置弹层。 */
      if (nodes[i].closest('[data-shortcut-modal="settings"]') !== null) { continue; }
      dialogs.push(nodes[i]);
    }
    return dialogs;
  }
  function findMenus() { return document.querySelectorAll('[role="menu"], [role="listbox"]'); }

  var tagged = [];
  function clearStale() {
    for (var i = 0; i < tagged.length; i++) {
      var el = tagged[i];
      if (!el || !el.isConnected) { continue; }
      /* 只清我们自己挂的；节点换了归属也不影响 */
      if (el.getAttribute('data-dshm-glass-owner') === 'skin') { el.removeAttribute('data-dshm-glass'); }
    }
    tagged = [];
  }
  function mark(el, name) {
    if (!el || el.getAttribute('data-dshm-glass-owner') === 'native') { return; }
    el.setAttribute('data-dshm-glass', name);
    el.setAttribute('data-dshm-glass-owner', 'skin');
    tagged.push(el);
  }

  var counts = {};
  function tagSurfaces() {
    clearStale();
    counts = { sidebar: 0, dialog: 0, menu: 0 };
    var sb = findSidebar(); if (sb) { mark(sb, 'sidebar'); counts.sidebar = 1; }
    var ds = findDialogs();
    for (var i = 0; i < ds.length; i++) { mark(ds[i], 'dialog'); counts.dialog += 1; }
    var ms = findMenus();
    for (var j = 0; j < ms.length; j++) { mark(ms[j], 'menu'); counts.menu += 1; }
  }

  /*
   * 页面自己是深色吗？采样根节点/正文的底色亮度，**不看系统媒体查询**。
   * rgba(0,0,0,0)（透明）视为拿不到 ⇒ 继续往上试，全拿不到就按浅色。
   */
  function pageIsDark() {
    function lumOf(cs) {
      var m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(cs || '');
      if (!m) { return -1; }
      var a = /rgba\\([^)]*,\\s*([\\d.]+)\\s*\\)/.exec(cs || '');
      if (a && parseFloat(a[1]) === 0) { return -1; }
      return 0.299 * parseInt(m[1], 10) + 0.587 * parseInt(m[2], 10) + 0.114 * parseInt(m[3], 10);
    }
    try {
      var nodes = [document.body, document.documentElement];
      for (var i = 0; i < nodes.length; i++) {
        if (!nodes[i]) { continue; }
        var l = lumOf(getComputedStyle(nodes[i]).backgroundColor);
        if (l >= 0) { return l < 128; }
      }
    } catch (e) { /* 取样式失败：按浅色 */ }
    return false;
  }

  function apply() {
    var on = effective();
    document.documentElement.setAttribute('data-dshm-glass', on ? 'on' : 'off');
    document.documentElement.setAttribute('data-dshm-glass-dark', pageIsDark() ? '1' : '0');
    if (on) { tagSurfaces(); }
  }

  var lastReport = '';
  function report() {
    var detail = JSON.stringify({
      mode: preferred(), effective: effective(), support: SUPPORT, dark: pageIsDark(),
      counts: counts, phone: document.documentElement.classList.contains('dshm-phone'),
      at: new Date().toISOString()
    });
    /* 只在"支持情况/命中面/开关"变化时落盘，避免每拍写文件 */
    var key = detail.replace(/"at":"[^"]*"/, '');
    if (key === lastReport) { return; }
    lastReport = key;
    try { globalThis.__DSHM_BRIDGES__.writeGlassDiag(detail); } catch (e) { /* 桥没就绪：下一拍再试 */ }
  }

  function tick() { ensureStyle(); apply(); report(); }

  globalThis.dshmGlass = {
    set: function (mode) {
      try { localStorage.setItem(STORE_KEY, mode); } catch (e) { /* 忽略 */ }
      tick();
      return effective();
    },
    state: function () {
      return { mode: preferred(), effective: effective(), support: SUPPORT, counts: counts };
    }
  };

  ensureStyle();
  tick();
  setInterval(tick, 1500);
  try {
    var obs = new MutationObserver(function () { setTimeout(tick, 250); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* 观测失败：定时巡检仍在 */ }
  globalThis.__DSHM_GLASS__ = true;
})();
`;

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

const SETTINGS_SHIM_JS: string = `(function () {
  if (globalThis.__DSHM_SETTINGS__) { return; }
  /* 直板机总开关（SIDEBAR_SHIM_JS 挂上；本垫片只读它，不自己下判断）。
     平板 / 折叠屏 / PC / 2in1 都拿不到这个类 ⇒ 它们一律走官方竖排形态（见头注）。 */
  var PHONE_CLASS = 'dshm-phone';
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
  /* 【失焦停摆（2026-10-29，方案 A）】可见时才有意义；hidden 停摆、visible 恢复并当拍补跑。 */
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
  function phone() {
    var cur = document.documentElement.getAttribute('class');
    return cur !== null && cur.indexOf(PHONE_CLASS) >= 0;
  }
  /* 手机档布局：只注入一次。所有规则都以 .dshm-set-panel.dshm-set-ready 起头 ⇒
     结构没认全（没挂 ready）时整套规则一条都不生效。 */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID) !== null || document.head === null) { return; }
    var P = 'html.' + PHONE_CLASS + ' .' + PANEL_CLASS + '.' + READY_CLASS;
    var css = P + '{width:100vw;max-width:100vw;height:100%;max-height:100%;border-radius:0;flex-direction:column}'
      /* 覆盖层钉到视口：官方那层是「居中弹窗」的容器（.overlay），不改它的话面板高度会
         跟着内容长（height:100% 落在没有定高的父上）⇒ 整块面板能被拖动，顶部横条会被拖走。 */
      + 'html.' + PHONE_CLASS + ' .' + OVERLAY_CLASS + '{position:fixed;left:0;top:0;right:0;bottom:0;display:block;margin:0;padding:0;overflow:hidden}'
      /* 铺满就没有"外面"可点 ⇒ 遮罩无用（顺带省掉 backdrop-filter 的合成开销） */
      + 'html.' + PHONE_CLASS + ' .' + MASK_CLASS + '{display:none}'
      /* 侧栏列 → 顶部横条：宽度吃满、不再占一列。
         display:flex 必须**显式写死**：dshmarket 自带的窄屏 CSS 里有一条
         @media (max-width:560px){[role=dialog]:has([data-dsh-market-root])>nav{display:none}}
         —— 它判的就是"设置面板里嵌着市场"这件事，会把这条顶部横条整条藏掉（手机上再也切不了页签）。
         本选择器（html.dshm-phone .dshm-set-panel.dshm-set-ready>nav）比它高一档 ⇒ 写回 flex 即可。 */
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
    else { log('面板结构不符（nav/内容区命中 ' + hits + ' 个）⇒ 本次不启用手机档布局'); }
  }
  function tick() {
    try {
      if (!phone()) { return; }
      ensureStyle();
      tagPanel();
    } catch (e) { /* 单拍失败不致命：下一拍重来 */ }
  }
  /* 验收用读数：'ready'（手机档布局已生效）| 'raw'（面板在但结构没认全）| 'none'（没打开）。
     平板 / PC / 2in1 上本垫片一拍了都不拍（phone() 恒假）⇒ 永远回 'none'。 */
  globalThis.__DSHM_SETTINGS__ = {
    state: function () {
      var panel = document.querySelector(PANEL_SEL);
      if (panel === null) { return 'none'; }
      var cur = panel.getAttribute('class');
      return cur !== null && cur.indexOf(READY_CLASS) >= 0 ? 'ready' : 'raw';
    }
  };
  tick();
  /* 【方案 A】裸启动已由上面的失焦停摆块接管（TickTimer = setInterval…）⇒ 删除此行避免双跑。 */
  log('shim installed');
})();`

/**
 * 「首次运行的设置引导」手机档布局垫片（2026-10-16 用户报障：直板机得横过来才用得了）。
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
 * 【只在直板手机档启用】判据 `html.dshm-phone`（与设置面板垫片同源，唯一真源是原生桥）：
 * 平板 / 折叠屏 / PC / 2in1 一个字节都不改（平板宽度够，本轮不碰）。
 *
 * 【验收读数】`globalThis.__DSHM_ONB__.state()` ⇒ 'none'（没开着）| 'raw'（开着但结构没认全）
 * | 'ready:<step>'（手机档布局已生效，step = 当前引导步骤）。
 */
const ONBOARDING_SHIM_JS: string = `(function () {
  if (globalThis.__DSHM_ONB__) { return; }
  /* 直板机总开关（SIDEBAR_SHIM_JS 挂上；本垫片只读它，不自己下判断）。 */
  var PHONE_CLASS = 'dshm-phone';
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
  /* 【失焦停摆（2026-10-29，方案 A）】可见时才有意义；hidden 停摆、visible 恢复并当拍补跑。 */
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
    return cur !== null && cur.indexOf(PHONE_CLASS) >= 0;
  }
  /* 手机档布局：只注入一次。所有规则都以 .dshm-onb-page.dshm-onb-ready 起头 ⇒
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
      log('手机档布局已生效（step=' + step + '）');
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
  /* 【方案 A】裸启动已由上面的失焦停摆块接管（TickTimer = setInterval…）⇒ 删除此行避免双跑。 */
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
 * AI 生成内容标识（2026-11-10）。
 *
 * 【上架语义】模型输出必须在界面上**明确披露来源**，且这条披露必须由呈现层生成 ——
 * 不靠提示词让模型自己写，也不写进消息正文/模型上下文（写进去就会被下一轮当成
 * 用户可见事实再喂回模型，且历史消息会被污染）。
 *
 * 【位置（用户 2026-11-11 最终裁决）】**直接嵌进官方会话输入座位**（`[class*="composerSeat"]`）
 * 内，绝对定位到卡片工具栏那一行的空白带（`+` / 权限 / 模型选择器之间），随输入卡片一起
 * 出现、一起消失。
 *
 * 【为什么改成"真嵌"而不是 fixed 贴上去】11-11 白天两版都是"每拍读矩形 → fixed 定位"：
 * 判据靠"哪个编辑器最宽"，结果设置页 / 插件详情 / 文件预览里也会命中，标识挂到别的页面上
 * （用户两次截图复报）。根治办法是不再猜"当前是不是会话页"，而是**把节点挂进 composerSeat**：
 * 这个壳只由会话页渲染，页面切走它整个卸载，标识随之消失，不存在"判错"的余地。
 *
 * 【为什么每秒重读座位】侧栏展开/收起、右栏开关、窗口缩放都会改变卡片尺寸；React 重渲染
 * 也可能把外来子节点清掉。1s 一次补挂、失焦停摆，代价可忽略。
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

/**
 * 手持档视口回正脚本（2026-10-18，分屏旋转右侧空白）。
 *
 * 真机现场：窗口已恢复 460vp，但内容仍停在横屏分屏时的 313.5vp，右侧 146.5vp 为白。
 * 原生 Web 组件本身按 100% 布局，故最后一层兜底放在页面：
 *   · 把 html/body 的宽度重新锚到 100%；
 *   · 把 `dshm-frame` 的宽度从上游可能残留的像素值拉回当前视口；
 *   · 主动补发 resize / visualViewport.resize，让上游布局订阅者重算。
 * 只在 `dshm-handheld` 下执行，PC / 2in1 返回 off。
 */
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
      /*
       * 【2026-11-10 侧栏被压成 0 的写入源就是这里，已删】
       * 原来这里无条件把 gridTemplateColumns 写成三列 0 宽：只要平板挂
       * dshm-handheld（平板恒挂）、且键盘收起 / 页面 settle / 面积变化任一触发回正，
       * 用户展开着的 280px 侧栏就被压成 0 —— 与用户报告里 frame inline 的
       * 三列 0 宽完全吻合。
       *
       * 列宽只有一个所有者：官方 AppFrame（dist/core/.../dsh-client-ui-layout 的
       * computeColumns）。本脚本只负责"视口尺寸回正 + 补发 resize"，不再碰布局；
       * 历史上残留在 inline 上的列宽在这里清掉，让官方/CSS 重新接管。
       */
      if (frame.style.gridTemplateColumns) {
        frame.style.gridTemplateColumns = '';
      }
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
 * 碰一碰垫片（docs/418 §5.1）：接收 ArkTS 侧推来的 base64 载荷，在页面里还原成
 * File 并合成 document 级 `paste`，走官方 file intake（file-intake.ts 的 paste 路由，
 * 无 isTrusted 门槛）把文件送进输入框——上传、附件 chip、草稿全程官方逻辑。
 *
 * 【为什么是 paste 而不是直调 facade.addFiles】编程入口 facade.addFiles 是模块
 * 私有，无全局暴露（docs/418 §5.1）；而 document 级 paste 路由是官方自己挂的
 * 监听器，上游零改动。
 *
 * 【退路链】ClipboardEvent 构造（Chromium 系 ArkWeb 支持 init.clipboardData）→
 * 失败则 DragEvent('drop')（官方 drop-events.ts 同样无 isTrusted）→ 再失败留痕。
 * 上游若日后给 intake 加 isTrusted 校验，本链即失效——已在 docs/418 §6 挂升级
 * 回归清单，真机验收靠 emit 返回值 + [dshm-knock] console 转发定位。
 */
const KNOCK_SHIM_JS: string = `(function () {
  if (window.__DSHM_KNOCK__) { return; }
  function log(m) {
    try { console.info('[dshm-knock] ' + m); } catch (e) { /* 诊断不阻断 */ }
  }
  /* base64 → Uint8Array；atob 在 ArkWeb（Chromium 内核）可用。 */
  function toFile(p) {
    var bin;
    try { bin = atob(String(p.base64 || '')); }
    catch (e) { log('atob 失败（载荷损坏？）'); return null; }
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
    var name = String(p.name || 'knock-file');
    var mime = String(p.mime || 'application/octet-stream');
    try { return new File([bytes], name, { type: mime }); }
    catch (e) { return new Blob([bytes], { type: mime }); }
  }
  /* 合成 document 级 paste：ClipboardEvent 的 init.clipboardData 带 DataTransfer，
     官方 file-intake.ts 从 clipboardData.items 取 File 路由进输入框。
     返回值 = 官方是否**真的接住**：只有接住才 preventDefault（上游 file-intake.ts
     在 target === undefined 时直接 return，不 prevent）⇒ 用它区分 paste / unrouted。 */
  function dispatchPaste(file) {
    var dt = new DataTransfer();
    dt.items.add(file);
    var ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    if (!ev.clipboardData) { throw new Error('ClipboardEvent ctor 丢弃 clipboardData'); }
    document.dispatchEvent(ev);
    return ev.defaultPrevented === true;
  }
  /* 退路：官方 drop-events.ts 的 document 级 drop 监听（同样不校验 isTrusted）。 */
  function dispatchDrop(file) {
    var dt = new DataTransfer();
    dt.items.add(file);
    var ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    if (!ev.dataTransfer) { throw new Error('DragEvent ctor 丢弃 dataTransfer'); }
    document.dispatchEvent(ev);
    return ev.defaultPrevented === true;
  }
  function emitNow(file) {
    try { if (dispatchPaste(file)) { return 'paste'; } }
    catch (e) { log('paste 路不通：' + (e && e.message ? e.message : e)); }
    try { if (dispatchDrop(file)) { return 'drop'; } }
    catch (e) { log('drop 路不通：' + (e && e.message ? e.message : e)); }
    return 'unrouted';
  }
  /* 首页 / 新会话空态没有 composer，官方 intake 会静默丢弃 ⇒ 文件先留在 JS 队列，
     等输入座位出现（≤60s）再补投；超时丢弃并留痕。 */
  var deferred = [];
  var waitTimer = -1;
  var waitStart = 0;
  function composerReady() {
    return document.querySelector('[data-composer-seat],[data-composer-card],[class*="composerSeat"]') !== null;
  }
  function flushDeferred() {
    if (deferred.length === 0) {
      if (waitTimer >= 0) { clearInterval(waitTimer); waitTimer = -1; }
      return;
    }
    if (Date.now() - waitStart > 60000) {
      log('deferred 超时丢弃 n=' + deferred.length);
      deferred = [];
      clearInterval(waitTimer);
      waitTimer = -1;
      return;
    }
    if (!composerReady()) { return; }
    var arr = deferred;
    deferred = [];
    clearInterval(waitTimer);
    waitTimer = -1;
    for (var i = 0; i < arr.length; i++) { log('deferred 重投 -> ' + emitNow(arr[i])); }
  }
  function defer(file) {
    deferred.push(file);
    if (waitTimer < 0) {
      waitStart = Date.now();
      waitTimer = setInterval(flushDeferred, 500);
    }
    return 'deferred';
  }
  window.__DSHM_KNOCK__ = {
    emit: function (payload) {
      var file = toFile(payload);
      if (!file) { return 'bad-payload'; }
      var r = emitNow(file);
      if (r !== 'unrouted') { return r; }
      if (composerReady()) { return 'unrouted'; }
      return defer(file);
    }
  };
  log('shim ready');
})();`

/** 单个碰一碰文件的注入脚本：JSON 载荷 → shim.emit → 合成 paste → 官方 intake。 */
function buildKnockEmitScript(file: KnockFile): string {
  const payload: KnockFile = { name: file.name, mime: file.mime, size: file.size, base64: file.base64 };
  return `(function () {
  try {
    var api = window.__DSHM_KNOCK__;
    if (!api) {
      console.warn('[dshm-knock] shim 未注入（document-start 清单缺项？）');
      return 'no-shim';
    }
    return String(api.emit(${JSON.stringify(payload)}));
  } catch (e) {
    console.warn('[dshm-knock] emit 异常: ' + (e && e.message ? e.message : e));
    return 'error';
  }
})()`;
}

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
    const legacyHandheld: boolean = isHandheldForm() && deviceInfo.sdkApiVersion < 26;
    if (legacyHandheld || !folderSelectionAvailable()) {
      this.writeDiagMarker('diag-picker-capability-fallback',
        `legacy-handheld=${legacyHandheld ? 'true' : 'false'}; api=${deviceInfo.sdkApiVersion};`
          + ` syscap=${folderSelectionAvailable() ? 'true' : 'false'}`);
      try {
        const picked: WorkspaceBrowserPickResult = await this.openWorkspaceBrowser(ctx);
        this.dispatchResolve(id, picked.path, picked.error);
      } catch (err) {
        this.dispatchResolve(id, null, `内置工作区浏览器失败：${(err as Error).message}`);
      }
      return;
    }
    const docPicker = new picker.DocumentViewPicker(ctx as common.UIAbilityContext);
    // 【2026-10-03 更正】这里原本在拉起选择器**之前**先申请两条"公共目录路径级权限"。
    // **已删除**：本路线不申请任何权限（① 权限零差异铁律：新包必须与作者成品 HAP 的
    // 11 项 requestPermissions 逐项一致；② 用户 AGC profile 的 ACL 白名单只有 5 条，
    // 超出即 `grant request permissions failed`。理由与取证见 FilePicker.ets 顶部注释、
    // dsh-移植研究/30-DSHM文件能力植入-侦察与设计.md §4.2/§6.1）。
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
    // 持久化目录授权：跨启动保留访问权。失败/超时只降级为「本次有效」，不阻断选择。
    // 【2026-10-14 三端同一套】这里原本自己写一遍"带看门狗的 persistPermission"，而
    // **查证**（`checkPersistentPermission`）与**启动恢复**（`activatePermission`）都在
    // 别处 ⇒ PC 档"记了却没人启用"：重启后同一条路径照样
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
    // 【2026-10-14】② 这条链与启动恢复**三端都跑**：旧注释"2in1/PC 本来就读得到 picker
    // 目录、不需要持久授权"是 docs/30 时代的读数，在 8 条权限面下已不成立（PC 档现场
    // 读数与手持档逐字同构，见 docs/157）；PC 档另外多兜一层 `probePathWritable()`。
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
 * 顶栏高度（vp）：自绘标题栏。**只在 PC / 2in1 渲染**（手持档整条不渲染，见 build()）。
 * 【38 是桌面档的口径】当年对着 DSHM 桌面版像素复刻 —— 与改动前**逐字相同**。
 *
 * 【手持档为什么没有顶栏（2026-10-09 用户裁决）】原话："移动端 APP 是没有顶栏的，
 * 并且现在启动的时候左上角还有一个小鲸鱼，这个也不应该出现在移动端"。手机 / 平板
 * 整条顶栏（连同那颗按钮）都不渲染 ⇒ 页面铺满窗口；侧栏开关改由**页面内**那颗
 * 浮动按钮承担（垫片 SIDEBAR_SHIM_JS 里的 handheldFab），它只在收起态出现。
 */
const TOP_BAR_HEIGHT: number = 38;

/*
 * 【2026-11-16 用户裁决：保留系统三键、去掉系统图标与文字】
 * 与 EntryAbility.ets 的非手持分支成对：那边 setWindowDecorVisible(false)（图标+应用名消失、
 * 右上三键保留），这边恢复自绘 TopBar（三点菜单 + 拖动热区）。常量只留作回退开关。
 */
const SYSTEM_TITLE_BAR_MODE: boolean = false;

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
   * 【为什么是常量 24，而不是照搬系统三键区高度（2026-10-10 第二轮，用户实测"偏宽"）】
   * 第一版（docs/133 / docs/134）把让位量写成"系统三键区高度"（本机就是我们自己
   * `setWindowDecorHeight(38)` 的 38vp），平板真机实测**不再重叠、但两排按钮之间的空档偏宽**
   * （用户原话"三键和 web 右上角稍微有点宽了"）。
   * 算得出来的最小让位其实很小：三键在 38vp 的装饰条里**纵向居中** ⇒ 三键下缘距内容上缘
   * 约 19 + 7 = **26vp**；而官方 Web 壳那排按钮**天然就比内容上缘低约 18vp**（页面侧
   * `rect.h` 恒 0，按截图逐枚量测）⇒ 只要让 **8vp 量级**就能让开（不再相交）。取 24vp =
   * 最小需求的 3 倍：留够跨机型 / 跨朝向的余量，又比原来的 38vp 收掉约 37%。
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
   * 【PC/2in1 为什么**恒**为 0】那条路径上自绘顶栏本来就 `TOP_BAR_HEIGHT` 高、且占据三键区
   * ⇒ 让位必为 0 ⇒ 这里**直接返 0**，PC 行为逐字不变。
   *
   * 【为什么是一个纯函数】判据只有两个输入，与窗口 / 状态无关 —— 抽出来才能被门禁
   * `tools/check-decor-button-mode.mjs` 直接求值断言（含「PC 必须恒为 0」与常量的上下限）。
   */
const HANDHELD_DECOR_INSET_VP: number = 24;

function shouldShowAppTopBar(rawType: string, desktopForced: boolean, landscape: boolean): boolean {
  if (rawType === 'phone') {
    return false;
  }
  if (rawType === 'tablet') {
    /*
     * 2026-11-06（用户口径）：**普通平板不渲染自绘顶栏**（与手机一致的沉浸形态）。
     * Edge / ProMax / MateBook 同样上报 tablet，但已被设备事实强制 desktop ——
     * 它们走下一支的 `desktopForced ? landscape`，PC 顶栏与三键一个字节不动。
     */
    return desktopForced ? landscape : false;
  }
  if (desktopForced) {
    return landscape;
  }
  return true;
}

function initialAppTopBarLandscape(): boolean {
  const facts: DeviceFacts = readDeviceFacts();
  return facts.screenWidthVp > 0 && facts.screenHeightVp > 0
    && facts.screenWidthVp > facts.screenHeightVp;
}

function decorTopInsetVp(handheld: boolean, decorPresent: boolean, appTopBarVisible: boolean): number {
  if (!handheld || !decorPresent || appTopBarVisible) {
    return 0;
  }
  return HANDHELD_DECOR_INSET_VP;
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

@Entry
@Component
struct WebApp {
  @StorageProp(KEY_HOST_LAUNCH_URL) @Watch('onLaunchUrlChanged') launchUrl: string = '';
  @StorageProp(KEY_HOST_BOOT_ERROR) @Watch('onHostBootErrorChanged') hostBootError: string = '';
  @State @Watch('onPhaseChanged') phase: WebPhase = WebPhase.BOOTING;
  /** 启动页是否用深色：按系统当前深浅色，在 aboutToAppear 里定（web 主题上报前）。 */
  @State splashDark: boolean = false;
  /** ERROR 覆盖层展示的原因（不含任何凭据） */
  @State errorText: string = '';
  // ── 启动加载页品牌动效 ────────────────────────────────────────────────
  // brandOpacity 负责淡入，brandBreath 负责常驻呼吸缩放；拆成两个属性是为了
  // 让两段动画作用于不同属性，避免同一属性被并发动画抢占。
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
  // ── 自由窗口三键避让（2026-09-21 品牌对齐）────────────────────────────
  // setWindowDecorVisible(false) 后系统保留右上角三键（全屏/最小化/关闭），
  // TopBar 顶到窗口第一行时右侧必须让开三键区。TitleButtonRect 单位 vp
  //（SDK d.ts 明示），width<=0 = 无装饰（手机全屏）→ 用默认小 padding。
  @State decorPadRight: number = 8;
  /** 最近一次**有效**的三键避让读数（vp）。零读数时用它兜底，见 applyDecorRect。 */
  private decorPadRightLast: number = 8;
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
   * 状态栏通知点击携带的路由（`NotificationCenter.buildAgent` 写进 want.parameters.dshRoute，
   * `EntryAbility.applyLaunchParams` 解出后发布到这个键）。
   *
   * 【为什么必须有】2026-11-11 用户反馈"通知只能清除、点不进去对应会话"：
   * 能力层早就发了这个键，但**没有任何页面读它** —— 点通知的结果只是把应用拉到前台，
   * 停在上一屏。这里补上消费端：解析出 sessionId 后走既有的「直达会话」注入链路
   * （与桌面卡片 `dshAction=open-session` 同一条实现）。
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
   * 碰一碰接收器（仅 PC 档创建并注册；普通平板/手机不注册，docs/418 §5 范围裁定）。
   * 接收到的文件经 base64 注入合成 paste 走官方 file intake，进输入框不自动发送。
   */
  private knockReceiver: KnockShareReceiver | undefined = undefined;
  /**
   * 已落盘的让位读数（-1 = 还没落过）。
   *
   * 【为什么要它】真正的让位是渲染期现算的（`decorTopInsetNow()`），这里存的只是**读数**；
   * 而"0 也要留下一条证据"需要一个**没落过**的哨兵 —— 否则 PC 档（让位恒 0）永远
   * 一个字节都不写，事后没法证明 `applyDecorRect` 真跑过、且真的算出了 0。
   */
  private decorTopLogged: number = -1;
  /** 壳页创建时刻 + 是否已写过成功摘要（R10：每次启动都留一行耗时，不只记失败）。 */
  private bootStartedAt: number = Date.now();
  private bootSummaryWritten: boolean = false;
  private decorWin: window.Window | undefined = undefined;
  /** 系统原始设备类型：顶栏策略按 phone / tablet / PC 三分，不使用被 Edge 强制改写的 form。 */
  private rawDeviceType: string = readDeviceFacts().rawType;
  /** MatePad Edge / QXS-* 虽强制走 desktop，但顶栏仍随平板横竖屏显隐。 */
  private desktopForced: boolean = readDeviceFacts().desktopForced;
  /** 当前窗口横屏；首帧取默认显示屏，之后由 Web 实际面积更新。 */
  @State private landscape: boolean = initialAppTopBarLandscape();

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
  /**
   * PC 模式（手持形态 + 自由窗口）：由能力层 EntryAbility 发布（键 dshPcMode）。
   * 为真时 platformForm() 答 desktop，页面挂 dshm-pc（桌面档布局 + 浮动入口）。
   */
  @StorageProp('dshPcMode') private pcMode: boolean = false;
  /**
   * 能力层转发过来的「返回」请求（2026-11-07）。
   *
   * 【为什么要这条】端侧侧滑返回在部分机型上**不经过页面的 `onBackPress()`**，
   * 系统直接按"无应用消费"处理 ⇒ 切回桌面（真机：手势划一下就没了）。
   * 现在 `EntryAbility.onBackPressed()` 先接住并自增本键（返回 true = 不交给系统），
   * 页面收到后走与返回键**完全同一条链**（BACK_SHIM 的逐级消费）。
   */
  @StorageProp('dshBackTick') @Watch('onBackTickRequest') private backTick: number = 0;
  private backInFlight: boolean = false;

  /**
   * 本机是否**直板手机**形态（平板 / 折叠屏都不算）。判据即 platform 的 isPhoneForm()
   * （与 handheld 同源读设备事实；读不到时按非直板机处理 —— 平板 / 折叠屏 / 桌面走官方布局）。
   *
   * 【为什么还要单独一个字段】手持档共用 `dshm-handheld`，但**设置面板的手机化布局**只对
   * 直板机成立（官方"左导航 + 右内容"在平板 / 折叠屏展开后本来就放得下，改成顶部横条反而
   * 丢内容高度）。用户裁决（2026-10-13）："平板端其实设置的 UI 用 PC 端的……只有手机端的
   * 才需要横过来" + "设置的 UI 手机只是直板机是横着的，折叠机也是 PC 竖着的 UI"。
   * 它只用来**缩小**适配面：`platformForm()` 答 `phone` 才给页面挂 `dshm-phone`，
   * SETTINGS_SHIM_JS 认那个类；平板答 `tablet`、折叠屏答 `foldable`，设置面板一个字节都不改。
   */
  private phone: boolean = isPhoneForm();

  /**
   * 本机是否为折叠屏（判据即 platform 的 isFoldableDevice()；读不到折叠能力时按非折叠处理）。
   *
   * 【只管一件事】手持档内部再分一层的**读数**：折叠屏与平板一样进手持档（抽屉 / 朝向
   * 跟随 / 小白条沉浸照旧），但不挂 `dshm-phone` ⇒ 设置面板走官方竖排。它只在
   * `platformForm()` 里用来把"手持但非直板机"这一档如实答成 `foldable`（日志 / 真机自证），
   * 不参与判断"是不是手持档"（那是 handheld 的事）。
   */
  private foldable: boolean = isFoldableDevice();

  // ── 底部手势区沉浸（2026-10-09，见 build() 的 BOTTOM INSET）────────────────
  /**
   * 底部手势区（小白条所在）的避让高度，vp：Web 容器据此向下扩展进安全区（沉浸）。
   * 0 = 本档不扩展（PC/2in1，或系统当前没有底部手势区）⇒ 页面与窗口行为与改动前
   * **逐字相同**（expandSafeArea 收到空数组 = API 明文的无效果）。
   */
  @State bottomInsetVp: number = 0;
  /**
   * 顶部状态栏避让高度（vp）—— **平板沉浸式状态栏**（2026-11-04，用户需求）。
   *
   * 做法：窗口进入 layout-fullscreen（内容延伸到状态栏下方，见 EntryAbility 的
   * `enterTabletImmersive`），根容器按本值下移，于是状态栏区域露出的是应用自己的背景，
   * 视觉上就是"沉浸"；状态栏图标仍由系统绘制在最上层。
   * 0 = 本档不接管（PC / 手机各自有既定形态）⇒ 布局与改动前逐字相同。
   */
  @State topInsetVp: number = 0;
  /** 是否接管顶部状态栏：仅平板（entry 模块的手持档就是平板；手机走 phone 模块）。 */
  private topInsetArmed: boolean = false;
  /**
   * 是否允许接管底部手势区：**仅手持档**（与 isHandheldForm 的收口口径一致）。
   * 关掉它就等于整条功能不存在（PC 路径一个字都不动），读数失败时也用它收手。
   */
  private bottomInsetArmed: boolean = false;
  /** 已应用的底部避让高度（px）：幂等闸门，避免 avoidAreaChange 重复来时重排 */
  private bottomAvoidPx: number = -1;
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
  private lastWindowWidth: number = -1;
  private lastWindowHeight: number = -1;
  /** 软键盘是否占用底部区域；键盘期间禁止补发 resize，避免 xterm 反复重排 */
  private keyboardVisible: boolean = false;
  /** 主窗几何变化：与 EntryAbility 的几何记忆监听并存，只负责页面视口回正 */
  private onWindowGeometryChanged: () => void = (): void => {
    this.updateOrientationFromWindow(this.decorWin);
    this.scheduleViewportReconcile('window-geometry');
  };

  // ── 顶栏取色 ──
  // 【2026-09-26 演进】先按用户要求改黑底白字，再改回白底黑字；报告 5 §2.2 又要求
  // **跟随「设置→外观」**（官方对齐）。现在这个值是"当前生效的配色"，由
  // applySystemBarTheme(mode) 按 light/dark 更新；初值取浅色（首屏与官方 boot
  // 的 `:root{color-scheme:light}` + `#fff` 一致，避免启动瞬间反色闪烁）。
  // 【2026-11-16 沉浸】顶栏不再画自己的底色（TopBar 用 Color.Transparent，窗口底色由
  // setWindowBackgroundColor 统一提供）⇒ topBarBg 状态与 topBarBgNow() 随之退役（2026-11-17 清理）。
  @State topBarFg: string = '#0F1115';
  /*
   * 当前生效的明暗模式（'light' | 'dark'，空串=尚未确定）。
   * 必须是 @State：topBarFgNow() 与顶栏菜单文字据此取色，普通字段改它不触发重渲染
   * ⇒ 会"状态栏变了、图标不变"（报告 7 §4 的真根因，从基线原文恢复）。
   */
  @State themeMode: string = '';
  /**
   * 会议模式面板是否打开（Task 6）。
   * 【为什么是 @State】它直接决定 Stack 里是否渲染原生动浮层；菜单/快捷方式都只置它。
   */
  /** 「关于」浮层：两个独立入口（版本信息 / 开源组件声明），各自只显示一页。 */
  @State aboutOpen: boolean = false;
  /** 关于面板本次打开要显示的那一页：`version`（版本信息）/ `oss`（开源组件声明）。 */
  @State aboutTab: string = 'version';
  /** 顶栏三点菜单是否悬停（只用于补 hover 底色）。 */
  @State dotsHover: boolean = false;
  /** 云同步设置页（生产界面，2026-10-30） */
  @State cloudSyncOpen: boolean = false;
  /*
   * 「从顶栏菜单直接登录」的一次性信号：置真后传给 CloudSyncSettings，
   * 后者 aboutToAppear 时自动 showLoginPanel=true，并在拉起后**自行清零**。
   * 为什么用一次性信号而不是常驻状态：登录面板只在"用户刚点了菜单里的登录"
   * 这一个时刻该自动弹；若常驻为真，之后每次打开设置页都会莫名弹登录。
   */
  @State cloudSyncAutoLogin: boolean = false;
  /**
   * 云同步清单统计是否正在刷新（docs/319）。
   *
   * 同步桥只能同步返回，所以统计走"发起刷新 + 下次读状态时拿到上次结果"；
   * 这个标志只是**并发去重**（面板每秒轮询，不挡的话会叠出一串在途查询）。
   */
  private cloudStatsInFlight: boolean = false;
  /** 上一次清单统计的时间戳（`CLOUD_STATS_MIN_GAP_MS` 的判据）。 */
  private cloudStatsAt: number = 0;
  /** 拖动进行中（`startMoving()` 异步，避免连点重复调用 ⇒ SDK 1300001）。 */
  private windowDragBusy: boolean = false;
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
  private workspaceBrowserResolver: ((result: WorkspaceBrowserPickResult) => void) | undefined = undefined;

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
    roots.push({ label: '应用沙箱', path: `${ctx.filesDir}/workspace` });
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
      for (let i: number = 0; i < names.length; i++) {
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
    'onThemeMode': (mode: string): void => this.themeBridge.onThemeMode(mode)
    ,'startNativeCapture': (): string => this.startNativeCapture()
    ,'nativeCaptureState': (): string => this.nativeCaptureState()
    ,'takeNativeCapture': (): string => this.takeNativeCapture()
    ,'cancelNativeCapture': (generation: string): string => this.cancelNativeCapture(generation)
    ,'openExternal': (url: string, mode: string): void => this.openExternal(url, mode)
    ,'openFilePreview': (path: string): string => this.openFilePreview(path)
    ,'openFileLocation': (path: string): string => this.openFileLocation(path)
    /*
     * 玻璃皮肤的**降级探针**（2026-11-05）：注入的垫片把"支持/不支持、命中哪几个面"
     * 写进 `files/diag-glass`，真机一条 `cat` 就能判"没生效"是内核不支持、还是选择器没命中。
     */
    ,'writeGlassDiag': (detail: string): void => this.dirPickerBridge.writeDiagMarkerPublic('diag-glass', detail)
    /*
     * 形态读数（2026-10-09）：侧栏垫片用它决定要不要开"移动端抽屉"（SIDEBAR_SHIM_JS §B）。
     * 【为什么必须由原生回答】手持档判据只有一处真源（platform.isHandheldForm()，
     * 读设备事实、读不到时按非手持处理）；网页侧既拿不到设备类型，也不该自己猜
     * 屏幕宽度当形态。同步返回（javaScriptProxy 只支持同步），字符串比布尔值好扩展。
     * 【2026-10-13 扩成四档】phone / tablet / foldable / desktop —— 手持档内部再分一层，
     * 是因为设置面板的手机化布局**只对直板机**成立（用户裁决：平板与折叠屏用 PC 那套）。
     * 旧的两个取值仍成立：手持档（phone / tablet / foldable）答的都不是 'desktop'
     * ⇒ 桌面档判据、抽屉全不变；四档里只有 phone 额外拿 dshm-phone。
     * 【2026-11-07 平板口径】移除 `this.pcMode ? 'desktop'` 映射：平板无论全屏还是
     * 自由窗口，恒答 'tablet'（移动端手持档），不再切 PC 桌面档 —— 用户裁决「平板跟
     * 手机一样、不要跟 PC 对齐、移动端就移动端的样子」。能力层 pcMode 仍保留系统
     * 装饰（自由窗口四边缩放），与页面形态解耦；分屏/自由窗口能力由 module.json5
     * 的 supportWindowMode 声明。
     */
    ,'platformHandheld': (): boolean => this.handheld
    ,'platformForm': (): string => this.phone ? 'phone' : (!this.handheld ? 'desktop' : (this.foldable ? (isFoldableSingleScreenNow() ? 'phone' : 'foldable') : 'tablet'))
  ,'platformPcMode': (): boolean => this.pcMode === true
    ,'requestSystemBack': (): void => this.requestWebRootBack()
    /*
     * 云同步入口桥（2026-10-30，docs/315 方案 A）。
     *
     * 【为什么需要这个桥】顶栏「云同步」菜单只在 PC/平板存在（`shouldShowAppTopBar`
     * 对 phone 直接返回 false）；而官方账号菜单**三端都在**（左下角账号 → 设置/反馈/退出）。
     * 把入口注入那里，才能让手机端也有一个用户找得到的稳定位置。
     *
     * 【为什么是同步返回字符串】javaScriptProxy 只支持同步调用；'ok' 表示面板已置为显示，
     * 其余为拒绝原因（与其它桥保持同一契约）。
     */
    ,'openCloudSync': (): string => this.openCloudSyncPanel()
    /*
     * 云同步状态读数（2026-10-30，docs/319）。
     *
     * 【给谁用】云同步插件（`hostcore/plugins/dshm-cloud-sync`）在官方设置里注册的
     * 「云同步」分区。插件是 Web（React）代码，**拿不到 ArkTS 的 SyncEngine**，
     * 所以由本桥把状态序列化成 JSON 字符串给它。
     *
     * 【为什么返回字符串而不是对象】javaScriptProxy 只支持同步调用，返回值经
     * WebView 序列化；字符串是唯一在所有实现上都稳定往返的形态（对象在部分版本会丢字段）。
     */
    ,'cloudSyncState': (): string => this.cloudSyncStateJson()
    /*
     * 云同步动作入口（2026-10-30，docs/319 第二步）。
     *
     * 【为什么全部走一个方法】javaScriptProxy 只支持同步调用，而登录/上传/拉取都是
     * 异步长任务（登录要弹官方面板，上传要传十几 MB）。同步方法只能"受理并立即返回"，
     * 结果由插件轮询 `cloudSyncState()` 读到 —— 与仓里其它长任务的写法一致
     * （`startPick` 只回 'started'，完成态从会话里读）。
     *
     * 【为什么动作名是字符串而不是多个方法】每加一个方法就要改两处
     * （bridges 定义 + methodList），而 `check-bridge-methodlist` 守不住"漏加 methodList"
     * 以外的问题；一个入口 + 动作白名单，新增动作只改 ArkTS 内部，桥面不膨胀。
     *
     * 受理返回 `{ok, message}` 的 JSON；**被拒**（未登录、非法动作、正忙）也照样返回，
     * 让插件能如实显示原因，而不是静默无反应（docs/313 §12.3「不得假成功」）。
     */
    ,'cloudSyncAction': (action: string): string => this.cloudSyncAction(action)
    /*
     * 原生朗读（2026-11-15）：Web 侧只传**纯文本**，合成/播放/面板/后台全在 ArkTS。
     * 受理即返回（'started' / 'fallback' / 'empty'），真正的异步失败由平台层降级并记日志。
     */
    ,'readAloud': (text: string): string => this.startReadAloud(text)
    ,'stopReadAloud': (): void => this.readAloud.stop()
    /*
     * 系统分享（Share Kit）：与朗读同一枚动作条入口；分享内容由 Web 侧给纯文本，
     * 面板形态交给系统（手机模态 / 2in1 悬浮窗），不自绘。
     */
    ,'shareText': (text: string): string => this.sharePlainText(text)
  };

  /**
   * 打开华为账号 × 云盘 P0 验证面板（页内浮层）。
   */
  /**
   * 打开云同步面板（Web 侧注入的入口调用它，docs/315）。
   *
   * 与顶栏菜单走**同一条路径**（`attachSyncRoot` + `cloudSyncOpen`），
   * 保证两个入口打开的是同一个面板、同一份状态。
   */
  /**
   * 把同步状态序列化成 JSON（云同步插件读它）。
   *
   * 【口径只说一次】JSON 的形状与取值在 `platform` 的 `encodeCloudState()` 里 ——
   * 与手机壳**同一份实现**（docs/320）。壳这边只负责"先取上下文把目录挂上"。
   * 【会话根为什么每次现挂】`getContext(this)` 只在页面存活时可靠；挂载只是两个字符串
   * 赋值，重复调用无副作用，所以干脆每次取状态都挂一遍。
   */
  private cloudSyncStateJson(): string {
    this.attachSyncRoot();
    /* 清单统计（会话/附件/技能/插件）由同步表聚合，缓存在 SyncEngine；这里顺手刷一次 */
    this.refreshCloudStats();
    return encodeCloudState();
  }

  /**
   * 云同步动作入口（docs/319 第二步 / 320 共用判据）：**受理即返回**，结果由状态反映。
   *
   * 【判定不在这里写】受理/拒绝/文案全在 `platform` 的 `decideCloudAction()`（两个壳共用）。
   * 本方法只做"按判定去执行"：开面板、改开关、跑任务。
   *
   * @param action `login` / `signout` / `enable` / `disable` / `upload` / `pull` / `restore`
   * @returns `{"ok":true|false,"message":"…"}`；被拒时 message 是给用户看的原因
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
           * 与手机壳同一口径：静默授权不需要界面，旧写法（置 cloudSyncOpen）会整屏盖面板，
           * 与用户「直接在设置 UI 里面完成」的要求相悖。
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
          /*
           * 插件恢复要逐项勾选，官方 React 分区里没有现成的多选控件 ⇒
           * 落到原生面板的「插件」分组（那里有完整闭环）；登录已在手，不必再点登录。
           */
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

  /**
   * 原生朗读入口（2026-11-15）。
   *
   * 【为什么桥只收纯文本】Web 侧已把 Markdown 标记剥掉（`speechTextOf`），
   * ArkTS 侧不再解析 Markdown；合成/播放/面板/通知/后台都在平台层。
   */
  private startReadAloud(text: string): string {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    if (ctx === undefined) {
      return 'unavailable';
    }
    return this.readAloud.start(ctx, text);
  }

  /**
   * 系统分享入口（Share Kit，2026-11-15）。
   *
   * 【为什么是纯文本】动作条拿到的就是这条回答的正文；面板形态交给系统，
   * 本端不自绘分享 UI（手机模态 / 2in1 悬浮窗由系统决定）。
   */
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
   * 就地静默登录（docs/323，与手机壳同一实现口径）。
   *
   * 结果回流走 `cloudSyncState()`：成功后分区下一拍即为已登录态，不需要额外回执。
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
        systemMaterial: dialogMaterial(),
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
        this.cloudToast('已登录华为账号');
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
        this.cloudToast(result.reason);
      }
    }).catch((): void => {
      this.cloudToast('登录失败');
    });
  }

  /** 云同步用的轻量提示（本壳没有通用 toast，单独一个，避免与其它提示语义混用）。 */
  private cloudToast(message: string): void {
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
        try {
          this.getUIContext().getPromptAction().showToast({ message: reason, duration: 2500 });
        } catch (e) {
          /* 没有 UI 上下文就只留在状态里 */
        }
      }
    }).catch((e: BusinessError): void => {
      /* 状态里已记录：不做假成功处理 */
      const ignored: string = e.message;
      if (ignored.length === 0) {
        return;
      }
    });
  }

  /**
   * 刷新云同步清单统计（会话/附件/技能/插件在同步表里的真实记录数）。
   *
   * 【为什么是"立即触发 + 节流上报"，而不是 await】桥是**同步**契约
   * （javaScriptProxy 只支持同步调用），拿不到已经算完的异步结果。做法是：
   * 每次被读状态时就发起一次刷新（并发去重由本类的 `cloudStatsInFlight` 兜住），
   * **上一次算完的结果**在本次一并返回 —— 面板每秒轮询，最多一秒后就显示出来。
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
   * 跑一段同步任务（上传 / 拉取+导入）。
   *
   * 【结果落哪】`SyncEngine` 自己维护 `lastSync` / 云服务状态 / 进度，
   * 插件每秒读一次就知道结束了 —— 这里不需要另回执。
   * 失败原因既写进状态，也弹一条 toast（用户此刻可能没盯着面板）。
   */
  private runCloudTask(which: string): void {
    const generation: number = SyncEngine.currentGeneration();
    const ctx: common.Context = getContext(this) as common.Context;
    const task: Promise<string> = which === CLOUD_ACTION_UPLOAD
      ? SyncEngine.syncNow(ctx)
      : SyncEngine.pullAndImport(ctx);
    task.then((result: string): void => {
      if (generation !== SyncEngine.currentGeneration()) { return; }
      if (result.length === 0) {
        return;
      }
      try {
        this.getUIContext().getPromptAction().showToast({ message: result, duration: 3000 });
      } catch (e) {
        /* 没有 UI 上下文：状态里仍有原因 */
      }
    }).catch((e: BusinessError): void => {
      if (generation !== SyncEngine.currentGeneration()) { return; }
      try {
        this.getUIContext().getPromptAction().showToast({ message: `同步失败：${e.message}`, duration: 3000 });
      } catch (e2) {
        /* 同上 */
      }
    });
  }

  private openCloudSyncPanel(): string {
    try {
      this.attachSyncRoot();
      this.cloudSyncOpen = true;
      return 'ok';
    } catch (e) {
      return `fail:${e}`;
    }
  }
  /**
   * 把会话根目录注入同步中枢，让设置页能显示"待同步 N 个会话"。
   *
   * 【路径口径】端侧 dsh 的会话树在 `<filesDir>/dsh/home/sessions`
   * （与 Host 的 `$DSH_HOME/sessions` 同一处，见 docs/301 §1）。
   * 取不到上下文时**不猜**，留空串 —— 设置页会如实显示"尚未统计"。
   */
  /*
   * ── 云同步入口注入垫片（2026-10-30，docs/315 方案 A）───────────────────
   *
   * 【解决什么】顶栏「云同步」菜单只有 PC/平板有（`shouldShowAppTopBar` 对 phone
   * 返回 false），**手机端完全没有这个入口**。而官方左下角账号菜单（设置 / 意见反馈 /
   * 退出登录）三端都在 ⇒ 把「云同步」项注进去，三端都有稳定入口。
   *
   * 【注入策略：**跟随菜单出现**，不去猜它的开关】账号菜单是官方渲染的 `role="menu"`
   * 浮层，DOM 结构与出现时机都由官方控制。我们不去 hook 它的打开动作（那要依赖
   * 内部实现），而是低频巡检：**当页面上存在一个含已知菜单项的 menu 时，
   * 在它末尾补一项**（已在就跳过）。这样官方改版换了打开方式也不影响。
   *
   * 【为什么加"已知项"判据而不对任何 menu 都注入】页面上还有别的 role="menu"
   * （快捷键、右键菜单）；只对**含「设置」与「退出登录」**的那个菜单动手，
   * 才不会在无关浮层里冒出一个陌生项。
   *
   * 【幂等】用固定 id 判存在；重复巡检不会叠加。
   */
  private static readonly CLOUD_MENU_SHIM: string = `
(function () {
  if (window.__DSHM_CLOUD_MENU_SHIM__) { return; }
  window.__DSHM_CLOUD_MENU_SHIM__ = true;
  var ITEM_ID = 'dshm-cloud-sync-item';
  /* 账号菜单的"指纹"：同时出现这两个文案才认定是它（中文/英文各一套） */
  var MARK_A = ['设置', 'Settings'];
  var MARK_B = ['退出登录', 'Sign out', 'Log out'];
  function hasAny(text, list) {
    for (var i = 0; i < list.length; i++) {
      if (text.indexOf(list[i]) >= 0) { return true; }
    }
    return false;
  }
  function findAccountMenu() {
    if (document.body === null) { return null; }
    var menus = document.querySelectorAll('[role="menu"]');
    for (var i = 0; i < menus.length; i++) {
      var m = menus[i];
      if (m.id === ITEM_ID) { continue; }
      if (m.querySelector('#' + ITEM_ID) !== null) { return null; } /* 已注入 */
      var t = (m.textContent || '');
      if (hasAny(t, MARK_A) && hasAny(t, MARK_B)) { return m; }
    }
    return null;
  }
  function inject() {
    var menu = findAccountMenu();
    if (menu === null) { return; }
    var item = document.createElement('div');
    item.id = ITEM_ID;
    item.setAttribute('role', 'menuitem');
    item.setAttribute('tabindex', '-1');
    item.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;';
    /* 与官方项同样的内边距：直接复用相邻兄弟的 inline padding（拿不到就用 8px/12px） */
    try {
      var sib = menu.firstElementChild;
      if (sib !== null && sib !== item) {
        var cs = window.getComputedStyle(sib);
        if (cs && cs.paddingTop) {
          item.style.padding = cs.paddingTop + ' ' + cs.paddingRight + ' ' + cs.paddingBottom + ' ' + cs.paddingLeft;
          item.style.fontSize = cs.fontSize;
          item.style.borderRadius = cs.borderRadius;
        }
      }
    } catch (e) {}
    item.innerHTML = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true" focusable="false">'
      + '<path d="M8 3.5a3.5 3.5 0 0 1 3.42 2.75A2.75 2.75 0 0 1 11.5 11.5h-7A2.75 2.75 0 0 1 4.08 6.25A3.5 3.5 0 0 1 8 3.5Z"/>'
      + '</svg><span>云同步</span>';
    item.addEventListener('mouseenter', function () { item.style.background = 'rgba(127,127,127,0.12)'; });
    item.addEventListener('mouseleave', function () { item.style.background = 'transparent'; });
    item.addEventListener('click', function (ev) {
      if (ev && ev.stopPropagation) { ev.stopPropagation(); }
      if (ev && ev.preventDefault) { ev.preventDefault(); }
      /* 先关菜单（官方项点完也是这个观感），再开原生面板 */
      try {
        var dismiss = document.createElement('div');
        document.body.appendChild(dismiss);
        document.body.removeChild(dismiss);
        document.body.dispatchEvent(new Event('mousedown', { bubbles: true }));
        document.body.dispatchEvent(new Event('mouseup', { bubbles: true }));
      } catch (e) {}
      try {
        var b = window.__DSHM_BRIDGES__;
        if (b && typeof b.openCloudSync === 'function') { b.openCloudSync(); }
      } catch (e) {}
    });
    menu.appendChild(item);
  }
  /* 低频巡检：300ms 一次太密（菜单是交互才出现的），1s 足够且几乎无开销 */
  setInterval(inject, 1000);
  inject();
})();
`;

  private attachSyncRoot(): void {
    try {
      const ctx: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
      /* 路径口径在 platform 的 SyncRoot 里只写一次（与手机壳共用，docs/320） */
      SyncRoot.attach(ctx === undefined || ctx === null ? '' : ctx.filesDir);
    } catch (e) {
      /* 读不到就留空：设置页会显示"尚未统计"，不伪造数字 */
    }
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
   *                       不打扰用户（这是壳职责，与官方 Electron 壳行为一致）。
   *   · mode='confirm' —— 其余外链：先弹确认框，用户点「打开」才开。规范要求
   *                       外链必须二次确认，避免页面悄悄把用户带去第三方。
   *
   * 【为什么 URL 还要再校验一次】垫片里的 isHttpUrl 只是字符串前缀判断，是
   * 不可信输入（页面脚本可伪造桥调用）。这里用 platform 的 isOpenableUrl 复校，
   * 非 http(s) 一律拒绝 —— 绝不把 file:// 之类交给 openLink。
   */
  /**
   * 这次页内导航的目标是不是"应用之外"（外链）。
   *
   * 【判据】只把 `http(s)` 且**非本机回环**的目标当外链：应用自身页面由 Host 在
   * `127.0.0.1:<port>` 上提供（也见过 `localhost` 写法）；`about:` / `data:` / `blob:` /
   * `javascript:` 与一切非 http 协议（`resource://`、`file://`…）都放行 —— 那些是应用内部
   * 资源，拦了反而把界面弄坏。**纯判据**（只吃字符串），便于门禁直接断言。
   *
   * 【为什么不写正则字面量】ArkTS 对正则字面量的支持面比浏览器窄，这里一律用
   * `startsWith` + `substring` + `split`，与仓内其它端侧判据同一写法。
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
    /*
     * 【必须按**主机名精确**匹配，不能用前缀】审出来的真绕过（2026-10-29 复现）：
     * `startsWith('127.0.0.1')` 会把 `127.0.0.1.evil.com`、`localhost.attacker.net`
     * 当成"应用自身" ⇒ 外站被放行、在应用 WebView 里打开（正是本功能要消灭的现象）；
     * 另外 `127.0.0.1@evil.com` 这一形里 `@` 前是 userinfo、真正的主机是 evil.com，
     * 也必须按主机名判。故先剥掉 userinfo 与端口，再与白名单**全等**比较。
     */
    const authority: string = rest.split('/')[0];
    const hostPort: string = authority.split('@').pop() ?? authority;
    let host: string = hostPort;
    if (host.startsWith('[')) {
      /* IPv6 字面量：[::1]:3120 → [::1] */
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
           * 导致丢块 ⇒ VAD 失效 ⇒ 识别全灭（见 docs/device-validation.md）。
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
   * + 侧栏开关 + 设置面板手机档布局 + 市场预览列表列数 + 系统返回消费（见各自注释）。
   *
   * 【顺序无关】八个垫片各占一个 globalThis 键（`__DSH_DIRECTORY_PICKER__` /
   * `dshDesktop` / `__DSHM_OPEN_LINK_SHIM__` / `__DSHM_SIDEBAR__` /
   * `__DSHM_SETTINGS__` / `__DSHM_GRID__` / `__DSHM_BACK__`），互不读写彼此的初始化结果，
   * 只共用**同一个**同步桥对象
   * `__DSHM_BRIDGES__`（该对象由 `.javaScriptProxy` 注册，与注入顺序无先后依赖）。
   *
   * 【设置垫片为什么排在侧栏垫片后面】它**只读** `html.dshm-phone`（由侧栏垫片从原生桥
   * 问到后挂上；平板答 tablet ⇒ 不挂），自己不向原生桥要形态；排在后面只是让这个先后
   * 关系在清单里一眼可见 —— 实际不构成依赖：侧栏垫片的巡检会持续补挂该类，设置垫片
   * 每一拍都重读。
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
    { script: THEME_SHIM_JS, scriptRules: ['*'] },
    { script: OPEN_LINK_SHIM_JS, scriptRules: ['*'] },
    { script: SIDEBAR_SHIM_JS, scriptRules: ['*'] },
    /* 外壳玻璃（docs/359 一期）：排在侧栏垫片之后——它要认 .dshm-sbcol 这个钩子。 */
    { script: GLASS_SKIN_JS, scriptRules: ['*'] },
    /* AI 生成标识：同样认 .dshm-frame 的主列；排在侧栏/玻璃之后即可。 */
    { script: AI_DISCLOSURE_SHIM_JS, scriptRules: ['*'] },
  { script: COMPOSER_PIN_SHIM_JS, scriptRules: ['*'] },
    /* 移动端裸 Enter = 换行（2026-11-11）：见 MOBILE_ENTER_SHIM_JS 头注。 */
    { script: MOBILE_ENTER_SHIM_JS, scriptRules: ['*'] },
    { script: SETTINGS_SHIM_JS, scriptRules: ['*'] },
    { script: ONBOARDING_SHIM_JS, scriptRules: ['*'] },
      { script: BACK_SHIM_JS, scriptRules: ['*'] },
    /* 碰一碰接收（docs/418）：__DSHM_KNOCK__.emit 的页面侧落点。 */
    { script: KNOCK_SHIM_JS, scriptRules: ['*'] },
    /*
     * 【2026-11-03：云同步菜单项已下线（用户口径）】
     * 官方设置 UI 里已经由插件 `dshm-cloud-sync` 注册了「云同步」分区，账号菜单里这个
     * 注入项是重复入口（用户：「左下角设置入口的云同步那个按钮及功能可以去掉，
     * 因为已经集成进设置 UI 里面了」）。
     *
     * 处理方式：**不再注入**，但 `CLOUD_MENU_SHIM` 常量与 `openCloudSync` 桥**保留** ——
     *  · 常量留着是"先藏起来而不是删除"的同一纪律，
     *    万一要回滚只是把这一行加回来；
     *  · 桥留着是因为设置分区里的插件仍通过 `openCloudSync`/`encodeCloudState` 这些
     *    同一套动作与状态读数工作，删桥会连带打断设置 UI。
     * 若要恢复：把下面这行取消注释即可。
     */
    // { script: WebApp.CLOUD_MENU_SHIM, scriptRules: ['*'] },
  ];

  /**
   * 本会话是否已拿到麦克风权限（**内存态，不持久化**）。
   *
   * 用途只有一处：同一个页面生命周期内 Web 侧反复请求时，不必每次都弹系统框
   * （用户会看到反复弹窗）。真正的权威状态始终在系统那边——本字段只做
   * "已经问过且通过了"的快速路径，不拿它当作绕过系统的依据。
   */
  private micGranted: boolean = false;

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

  aboutToAppear(): void {
    this.nativeCaptureDisposed = false;
    // 启动页首帧就要定深浅：web 主题还没上报，只能读系统 colorMode（见 systemAppearance）。
    this.splashDark = this.systemAppearance() === 'dark';
    /*
     * ArkWeb 网页下载落地（2026-11-15）：官方 Web 的「下载 Session 日志」是
     * `<a download>`，没有委托时任务停在 PENDING、文件不落地。安装一次全局委托，
     * 由平台层先写缓存再弹系统保存框；失败只记 diag-download，不影响页面。
     */
    const downloadCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    if (downloadCtx !== undefined) {
      installWebDownloadDelegate(downloadCtx);
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
      /*
       * 平板沉浸式状态栏：entry 模块的手持档就是平板（手机走 phone 模块，见其自己的处理）。
       * 必须在首帧前 arm，否则 topInsetVp 读到 0 时这条整段不生效。
       */
      this.topInsetArmed = true;
    }
    this.dirPickerBridge.writeDiagMarkerPublic('diag-bottom-inset',
      `armed=${this.bottomInsetArmed}`);
    // 冷启动可能是从桌面快捷方式进来的（onCreate 带 dshAction；见 docs/172 §5.2）
    this.applyLaunchAction();
    // 冷启动也可能是点状态栏通知进来的（onCreate 带 dshRoute，见 applyLaunchRoute）
    this.applyLaunchRoute();
    /*
     * 沉浸光感能力探针（一次性，2026-11-17）：真机排障「菜单/弹窗为什么没有玻璃」。
     * isImmersiveMaterialSupported/getGlobalMaterialLevel 都是 API 26 起；
     * 低版本设备记 below26 即可（材质工厂本来就退回 undefined）。
     */
    try {
      if (deviceInfo.sdkApiVersion >= 26) {
        this.dirPickerBridge.writeDiagMarkerPublic('diag-material',
          `sdk=${deviceInfo.sdkApiVersion} supported=${uiMaterial.isImmersiveMaterialSupported()} `
          + `level=${uiMaterial.getGlobalMaterialLevel()}`);
      } else {
        this.dirPickerBridge.writeDiagMarkerPublic('diag-material', `sdk=${deviceInfo.sdkApiVersion} below26`);
      }
    } catch (e) {
      this.dirPickerBridge.writeDiagMarkerPublic('diag-material', `probe-error ${(e as Error).message}`);
    }
  }

  /**
   * 页面每次变为可见时消费一次快捷方式动作。
   *
   * 【为什么用 onPageShow 而不是 @Watch】与既有纪律一致（@StorageProp 的 @Watch 在本项目里
   * 不被信任）；"应用被快捷方式从后台拉起"这个时刻正是 onPageShow。
   */
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
   * 消费「点状态栏通知」携带的路由。
   *
   * 【消费即清空】与 `applyLaunchAction` 同一条纪律：不清则此后每次回到前台都会重新跳一次。
   * 【fail-closed】`parseNotifyRoute` 已校验 page 白名单，解析失败一律保持当前页面 ——
   * 通知参数可能是旧版本写下的，猜一个目标比不跳更糟。
   *
   * 页面未就绪时走 `dispatchWebAction` 的同一条挂起/补发路径（onPageEnd 补发）。
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

  /**
   * 启动碰一碰接收（仅 PC 档，desktopForced：PC / 2in1 / MatePad Edge / Pro Max）。
   *
   * 【范围裁定（用户 2026-11-16）】仅 PC 和手机端支持，平板暂不支持：普通平板的
   * desktopForced=false → 不注册；手机端是系统分享面板的发送方（dataReceive 只在
   * PC/2in1 屏幕侧触发），无需代码。注册失败（能力缺失/窗口未就绪）只留痕，不影响壳页。
   */
  private startKnockReceiver(): void {
    if (!this.desktopForced) {
      this.dirPickerBridge.writeDiagMarkerPublic('diag-knock', 'skip desktopForced=false');
      return;
    }
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    if (ctx === undefined) {
      this.dirPickerBridge.writeDiagMarkerPublic('diag-knock', 'skip ctx=undefined');
      hilog.warn(DOMAIN, TAG, '碰一碰：上下文不可得，跳过注册');
      return;
    }
    /*
     * 一窗一实例（docs/421 WP2）：windowId 取本页所在窗口（UIContext.getWindowId，
     * API 23 起可用），与 EntryAbility 建窗时用的 windowStage 主窗 id 是同一个，
     * 因此接管的是本窗口已 bootstrap 的接收器；会话窗（specified 实例）各取各的。
     * 旧写法读 AppStorage 的 dshMainWindowId（只有主窗发布）⇒ 会话窗拿不到自己的 id。
     */
    const winId: number = this.getUIContext().getWindowId() ?? -1;
    const receiver: KnockShareReceiver = KnockShareReceiver.acquire(ctx, winId);
    this.knockReceiver = receiver;
    receiver.setOnFiles((): void => {
      this.deliverKnockFiles();
    });
    receiver.setWriteDiag((detail: string): void => {
      // 注册/接收/投递全链落 filesDir/diag-knock（本机 hilog 对本应用不可读，见 diag-web-console 头注）
      this.dirPickerBridge.writeDiagMarkerPublic('diag-knock', detail);
    });
    receiver.start(winId).then((ok: boolean): void => {
      hilog.info(DOMAIN, TAG, '碰一碰接收注册%{public}s', ok ? '成功' : '未成（能力缺失，只留痕）');
    });
  }

  /**
   * 页面就绪即取走挂起文件并推进 Web 层；未就绪留在接收器里等 onPageEnd 补发。
   * （dataReceive 通知与 onPageEnd 两个入口共用本方法，幂等：队列为空即空跑。）
   */
  private deliverKnockFiles(): void {
    if (!this.webReady || this.knockReceiver === undefined) {
      return;
    }
    const files: Array<KnockFile> = this.knockReceiver.takePending();
    if (files.length === 0) {
      return;
    }
    hilog.info(DOMAIN, TAG, '碰一碰：投递 %{public}d 个文件', files.length);
    let delivered: number = 0;
    for (const file of files) {
      if (!this.pushKnockFile(file)) {
        break; // controller 未挂载：剩下回队等下次 onFiles/onPageEnd 补发，不丢
      }
      delivered += 1;
    }
    if (delivered < files.length) {
      const rest: Array<KnockFile> = files.slice(delivered);
      const back: number = this.knockReceiver.requeue(rest);
      this.dirPickerBridge.writeDiagMarkerPublic('diag-knock',
        `deliver中断 已投=${delivered} 回队=${back} 丢失=${rest.length - back}`);
    }
  }

  /**
   * 单文件注入：base64 载荷 → __DSHM_KNOCK__.emit → 合成 paste → 官方 intake。
   * 返回 false = runJavaScript 同步抛（controller 未挂载），调用方据此回队。
   */
  private pushKnockFile(file: KnockFile): boolean {
    try {
      this.controller.runJavaScript(buildKnockEmitScript(file), (err: BusinessError, result: string) => {
        if (err) {
          this.dirPickerBridge.writeDiagMarkerPublic('diag-knock', `inject err=${err.message}`);
          hilog.warn(DOMAIN, TAG, '碰一碰注入失败 err=%{public}s', err.message);
          return;
        }
        this.dirPickerBridge.writeDiagMarkerPublic('diag-knock', `inject name=${file.name} result=${result}`);
        hilog.info(DOMAIN, TAG, '碰一碰注入结果=%{public}s', result);
        if (result === 'unrouted' && this.knockReceiver !== undefined) {
          // 页面层没收下（无 composer / 上游拒收）：回队等下次补发，不静默丢
          this.knockReceiver.requeue([file]);
        }
      });
      return true;
    } catch (e) {
      this.dirPickerBridge.writeDiagMarkerPublic('diag-knock', `inject throw=${(e as BusinessError).message}`);
      // controller 未挂载会抛：deliverKnockFiles 已按 webReady 门控，此路几乎不可达
      hilog.warn(DOMAIN, TAG, '碰一碰注入异常（controller 未挂载？）');
      return false;
    }
  }

  aboutToDisappear(): void {
    this.nativeCaptureDisposed = true;
    this.cancelNativeCapture();
    this.readAloud.release();
    // 碰一碰：只摘本页钩子，不注销系统监听、不丢挂起队列（docs/421 WP1：
    // 窗口还在时页面重载不应让系统侧失去接收方；真正注销在 onWindowStageDestroy）
    if (this.knockReceiver !== undefined) {
      this.knockReceiver.detachPage();
      this.knockReceiver = undefined;
    }
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
      this.updateOrientationFromWindow(win);
      this.applyDecorRect(win.getTitleButtonRect());
      win.on('windowTitleButtonRectChange', (rect: window.TitleButtonRect) => {
        this.applyDecorRect(rect);
      });
      win.on('avoidAreaChange', this.bottomAvoidCb);
      win.on('windowSizeChange', this.onWindowGeometryChanged);
      win.on('windowRectChange', this.onWindowGeometryChanged);
      this.applyBottomAvoid(win);
      /* 平板沉浸：首帧前把顶部避让高度定下来（后续变化走 avoidAreaChange 同一监听）。 */
      if (this.topInsetArmed) {
        this.applyTopInset(this.readTopAvoidPx(win));
      }
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
   * 这里用多次延迟回正模拟同一效果（只在手持档生效，PC 逐字不动）。
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
    const landscape: boolean = width > height;
    if (!this.keyboardVisible && landscape !== this.landscape) {
      this.landscape = landscape;
      this.decorTopLogged = -1;
      this.writeDecorTopDiag(width, height, 'area-change');
    }
    if (this.keyboardVisible) {
      return;
    }
    this.scheduleViewportReconcile('web-area');
  }

  /**
   * 主窗几何是横竖屏的首选事实源。
   *
   * Web 面积事件只在 Web 组件挂载后触发；Host 启动失败、启动页阶段或页面切换时
   * Web 仍可能不存在。顶栏不能因此停在首帧方向，否则竖屏会继续露出一条桌面顶栏。
   */
  private updateOrientationFromWindow(win: window.Window | undefined): void {
    if (win === undefined) {
      return;
    }
    try {
      const rect: window.Rect = win.getWindowProperties().windowRect;
      const width: number = Number(rect.width);
      const height: number = Number(rect.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return;
      }
      if (width === this.lastWindowWidth && height === this.lastWindowHeight) {
        return;
      }
      this.lastWindowWidth = width;
      this.lastWindowHeight = height;
      const landscape: boolean = width > height;
      if (!this.keyboardVisible && landscape !== this.landscape) {
        this.landscape = landscape;
        this.decorTopLogged = -1;
        this.writeDecorTopDiag(width, height, 'window-geometry');
      }
    } catch (e) {
      hilog.debug(DOMAIN, TAG, '窗口几何读取失败，保留当前顶栏方向：%{public}s', (e as Error).message);
    }
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
    return decorTopInsetVp(this.handheld, this.decorKeysVisible, this.shouldShowTopBar());
  }

  private shouldShowTopBar(): boolean {
    if (SYSTEM_TITLE_BAR_MODE && !this.handheld) {
      return false;
    }
    return shouldShowAppTopBar(this.rawDeviceType, this.desktopForced, this.landscape);
  }

  private writeDecorTopDiag(width: number = this.lastWebAreaWidth,
    height: number = this.lastWebAreaHeight, source: string = ''): void {
    this.dirPickerBridge.writeDiagMarkerPublic('diag-decor-top',
      `handheld=${this.handheld} keys=${this.decorKeysVisible} ` +
        `show=${this.shouldShowTopBar()} rawType=${this.rawDeviceType} ` +
        `desktopForced=${this.desktopForced} landscape=${this.landscape} ` +
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
    /*
     * 【2026-11-10 零读数退化】本文件自己记过 MateBook14 的实测：
     * 「三键可见，但 getTitleButtonRect() 恒 0/0」。旧代码在 width<=0 时直接把
     * 右侧让位打回 8vp ⇒ 三键区被顶栏菜单盖住。
     * 现在的顺序：
     *   ① 读到宽度 ⇒ 用它（宽 + 8 间隙）；
     *   ② 读不到、但能力层说三键在 ⇒ 沿用上一次有效读数（不回到 8）；
     *   ③ 三键确认不在（全屏/隐藏成功）⇒ 8vp。
     * 只在"三键在 + 读数为零"时保留旧值，不会把隐藏三键后的空白一直留着。
     */
    if (rect.width > 0) {
      this.decorPadRight = rect.width + 8;
      this.decorPadRightLast = this.decorPadRight;
    } else if (this.decorKeysVisible && this.decorPadRightLast > 8) {
      this.decorPadRight = this.decorPadRightLast;
    } else {
      this.decorPadRight = 8;
    }
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
        `show=${this.shouldShowTopBar()} rawType=${this.rawDeviceType} ` +
        `desktopForced=${this.desktopForced} landscape=${this.landscape} ` +
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
      win.on('avoidAreaChange', this.bottomAvoidCb);
    } catch (e) {
      const err = e as BusinessError;
      this.dirPickerBridge.writeDiagMarkerPublic('diag-bottom-inset', `读数失败 ${err.message}`);
      hilog.warn(DOMAIN, TAG, '底部避让区读数失败（底部不沉浸）：%{public}s', err.message);
      this.bottomInsetArmed = false;
      this.bottomInsetVp = 0;
    }
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
  /**
   * 读顶部状态栏高度（px）。
   *
   * 【为什么用 TYPE_SYSTEM】状态栏属于系统避让区；真机上 TYPE_SYSTEM 的 topRect 就是状态栏高度
   * （底部那条注释里记过：同一类型的 bottomRect 在三键导航时才报数）。
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
   * 自由窗口 / 分屏：内容本来就不在状态栏下面，0 是合法读数 → 允许清零，
   * 否则会多出一条 39vp 的空白（docs/416 的自由窗口形态）。
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
      // 状态读不到（801/窗口未就绪）：按全屏处理，宁可保留让位也不让顶栏钻到状态栏下
      return true;
    }
  }

  /** 应用顶部避让（幂等：同值不重排）。 */
  private applyTopInset(px: number): void {
    if (!this.topInsetArmed) {
      return;
    }
    const rounded: number = Math.max(0, Math.round(px));
    /*
     * 【平板顶部让位不能被瞬态 0 清零（2026-11-15 回归修复）】
     *
     * 真机证据（MatePad Pro 13.2 / WEBW00，`diag-top-inset`）：
     *   `sysTop=78 → apply topPx=78 vp=39`，随后同一秒内又来一条 `apply topPx=0 vp=0`，
     * 顶栏因此反复上移到状态栏下面（按钮看得见、点不动）。
     *
     * 0 的来源是窗口装饰重建 / 状态栏重排时 `avoidAreaChange` 的瞬态读数，**不是**
     * "状态栏真的没有"：`enterTabletImmersive()` 已把主窗切到 layout-fullscreen，
     * 状态栏仍在（透明）并叠在页面之上，页面必须继续按 78px 让位。
     * 因此：已经拿到过非零值时，拒绝 0；从未拿到非零值（真正无状态栏）时才接受 0。
     *
     * PC / 2in1 的 `topInsetArmed=false`，上面第一条早退，逐字不受影响。
     */
    if (rounded === 0 && this.topInsetVp > 0 && this.shouldPreserveTopZero()) {
      this.dirPickerBridge.writeDiagMarkerPublic('diag-top-inset', 'skip topPx=0（保留上次非零）');
      return;
    }
    const vp: number = rounded > 0 ? px2vp(rounded) : 0;
    if (this.topInsetVp === vp) {
      return;
    }
    this.topInsetVp = vp;
    this.dirPickerBridge.writeDiagMarkerPublic('diag-top-inset',
      `apply topPx=${rounded} vp=${vp}`);
  }

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
    // 只有 SYSTEM 的 topRect 是顶部系统栏避让；导航指示器事件不得清零顶部。
    if (opt.type === window.AvoidAreaType.TYPE_SYSTEM && this.topInsetArmed) {
      this.applyTopInset(opt.area.topRect.height);
    }
    this.applyBottomInsetPx(this.readBottomAvoidPx(this.decorWin));
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
   * 【PC / 2in1 逐字不动】只有 handheld 走新链；桌面档仍是"有历史才后退，否则交系统"。
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
    /*
     * 【R10（2026-11-11）：每次启动都记一行耗时摘要】原来 `diag-host-boot` 只在失败时写，
     * 顺利启动反而没有读数 —— 统计 p95 / 定位"慢但没报错"的启动全靠猜。现在 READY 时
     * 写一行「成功：N s」，与失败那行同一个文件、同一个前缀，便于一键抓取对比。
     */
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
   * 本机是否平板形态（只认 TABLET，不含折叠屏 / PC）—— 与 `EntryAbility.isTabletDevice()`
   * 同一条判据。平板状态栏由我们铺透明做沉浸；读失败按 false（交还系统，保守方向）。
   */
  private isTabletForm(): boolean {
    try {
      return readDeviceFacts().form === FormFactor.TABLET;
    } catch (e) {
      return false;
    }
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
    this.topBarFg = chrome.content;
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
     * PC / 2in1 不进这条（`this.handheld` 为假 ⇒ 逐字不动）；状态读不到（801）⇒ 维持老行为。
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
        /*
         * 【平板：状态栏恒透明 = 真沉浸】（与 EntryAbility.reassertWindowChrome 同一条判据）
         *
         * 2026-11-23 用户报「启动画面跟了系统明暗，但进 App 后 App 内明暗与系统不一致时状态栏不沉浸」：
         * 启动期状态栏取的是系统色（splashChrome），进 App 后这里写的是**不透明**的 `barBg`（App 外观色）
         * ⇒ 页面已经 setWindowLayoutFullScreen 铺到状态栏下方，状态栏却被涂成另一条不透明色带。
         * 平板统一透明，让页面背景自己透上来；图标明暗仍跟随外观。手机 / PC 保持原样。
         */
        const tabletImmersive: boolean = this.isTabletForm();
        this.decorWin.setWindowSystemBarProperties({
          statusBarColor: tabletImmersive ? SYSTEM_BAR_HANDOFF_BG : barBg,
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
          splashUp ? '启动页' : '外观', mode, tabletImmersive ? SYSTEM_BAR_HANDOFF_BG : barBg);
      } catch (e) {
        const err = e as BusinessError;
        hilog.warn(DOMAIN, TAG, '状态栏配色设置失败（全屏等场景属正常）code=%{public}d msg=%{public}s',
          err.code, err.message);
        this.systemBarApplied = ''; // 允许下次再试（例如窗口后来才就绪）
        return;
      }
    }
    try {
      this.decorWin.setWindowBackgroundColor(barBg);
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
  // mark 淡入（640ms Friction，延迟 80ms）→ 常驻呼吸（1800ms EaseInOut 往返，
  // 延迟 720ms）；进度条 220ms 一格、+3 循环。幂等：ticker 已在跑则只补动画。
  private startBrandAnimation(): void {
    /*
     * 【2026-10-30 换标 + 动效改用物理弹簧（用户口径："开屏启动动画调用这个特性 curves.springMotion"）】
     *
     * 旧写法是"固定时长的补间"：淡入 `Curve.Friction` 640ms、呼吸 `Curve.EaseInOut` 1800ms 往复。
     * 补间的通病是**速度曲线与真实手感无关**：参数只能描述"多少毫秒走完"，描述不了
     * "被推了一下之后如何回弹"。`curves.springMotion(response, dampingFraction, overlapDuration)`
     * 是物理弹簧：`response` = 一次完整振荡的时长（秒）、`dampingFraction` = 阻尼比
     * （<1 会过冲、=1 临界、>1 逐渐逼近）。它**没有 duration 参数** —— SDK 原文：
     * "The spring animation curve is physics-based. Its duration depends on the springMotion
     *  parameters and the previous velocity, rather than the duration parameter"。
     *
     * 两处都用弹簧，各自取合适的参数：
     *   · 淡入：`response 0.42 / damping 0.86` —— 略欠阻尼，落定时有极轻的一下"弹到位"，
     *     而不是 EaseOut 那种"刹停"。delay 80ms 保留（让首帧先画出图，再开始动）。
     *   · 呼吸：`response 0.62 / damping 0.62` —— 明显地欠阻尼，往复时带一点惯性与过冲，
     *     观感是"活的"；`iterations:-1 + PlayMode.Alternate` 保留（常驻呼吸）。
     *     注意：弹簧曲线**不可归一化**（SDK 明写 interpolate 拿不到），所以它只用于
     *     真实动画；进度条那条**仍然是匀速线性**（见下面长注释：用户明确说过"冲"）。
     *
     * 为什么不用 `springCurve(velocity, mass, stiffness, damping)`：那是 7→9 的**废弃** API
     * （SDK 标 `@deprecated since 9, @useinstead springCurve`）。这里用的是 `springMotion`。
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

  // ── 顶栏菜单 ──────────────────────────────────────────────────────────
  // 【菜单结构（2026-11-11 用户裁决，第二次收口）】顶栏只保留**一颗三点菜单**：
  //   · 「⋯」—— 版本信息 / 开源组件声明
  // 「应用」菜单（主页 / 刷新）及其实现在同一轮整体删除：这两件事在 Web 里都已有
  // 官方入口（Back/Reload 走页面自身），壳侧再挂一份是重复入口；用户明确要求"删干净"。
  // 「编辑」菜单更早已删（Web 输入框自带系统上下文菜单）。
  // 「窗口」菜单仍不搬：平板端无窗口管理概念，最小化/关闭由系统手势承担。

  /*
   * 「关于版本」与「开源许可与版权」两个弹窗已由「关于」浮层承担（2026-10-28）：
   * 上架规范要求逐条列出**所有**第三方开源库与许可证，AlertDialog 的单段文本
   * 装不下（实测随包 624 个 npm 包 + 53 个原生库），故并入 AboutPanel。
   * 版本读数（dshCoreVersion）仍然由本页提供并传入面板。
   */
  /**
   * 当前运行的 dsh 版本：核心树目录名（<filesDir>/dsh/cores/<version>，与
   * CoreStore.coreDir 的布局一致）。排除 .staging 暂存；多版本并存时取字典序
   * 最新——设备实际只有一个版本目录。
   */
  private dshCoreVersion(): string {
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      const names: string[] = fileIo.listFileSync(`${ctx.filesDir}/dsh/cores`);
      const versions: string[] = [];
      for (const n of names) {
        if (!n.endsWith('.staging') && !n.startsWith('.')) {
          versions.push(n);
        }
      }
      if (versions.length === 0) {
        return '（核心树为空）';
      }
      versions.sort();
      return versions[versions.length - 1];
    } catch (e) {
      return '（未知）';
    }
  }

  /**
   * 自绘顶栏空白区 → 拖动整个窗口（2026-10-28：用户报"自动窗口下不能拖动"）。
   *
   * 【为什么必须自己接】我们把系统标题栏隐藏了（沉浸链），系统那条"拖标题栏移动窗口"
   * 的路就没了；而 SDK 明确写了：**关掉标题栏拖拽能力后，要用
   * `window.startMoving()` 在应用自己的热区里拖**。此前本文件从没调过它 ⇒
   * 自由窗口里抓顶栏拖不动。
   *
   * 【为什么绑在"空白区"而不是整条顶栏】整条绑定会让"按下按钮"也触发移动
   * （Down 就先起拖）。菜单与按钮之间的空白区（尾部 Blank）没有别的语义，正合适。
   *
   * 【调用时机的硬约束（SDK 原文）】只能在 `onTouch` 的 `TouchType.Down` 回调里调；
   * 也可以在 Down 之后的 Move 里调（避免"一按下就动"）。本实现走 Down。
   *
   * 【只对自由窗口生效】非自由窗口/能力受限时 SDK 抛 `1300004` / `801`，
   * 属预期 ⇒ 只记一行 info，不打扰用户也不上报为缺陷。
   */
  private beginWindowDrag(): void {
    if (this.windowDragBusy) {
      return;
    }
    this.windowDragBusy = true;
    try {
      window.getLastWindow(getContext(this)).then((win: window.Window) => {
        win.startMoving().catch((err: BusinessError) => {
          hilog.info(DOMAIN, TAG, '窗口拖动不适用（非自由窗口或能力受限）：code=%{public}d', err.code);
        }).finally(() => {
          this.windowDragBusy = false;
        });
      }).catch((err: BusinessError) => {
        this.windowDragBusy = false;
        hilog.warn(DOMAIN, TAG, '取窗口失败（拖动不可用）：%{public}s', err.message);
      });
    } catch (e) {
      this.windowDragBusy = false;
      hilog.warn(DOMAIN, TAG, '窗口拖动异常：%{public}s', (e as Error).message);
    }
  }

  /**
   * 「关于」菜单（bindMenu 数据）：版本信息 / 开源组件声明。
   *
   * 【2026-11-11 最终形态】顶栏只剩这一颗三点菜单 —— 「应用」菜单（主页 / 刷新）
   * 及其实现在同一轮整体删除。点开只有两个子项，各自打开关于面板的对应单页；
   * 两个入口共用同一套面板容器（见 AboutPanel 头注）。
   */
  private aboutMenu(): Array<MenuElement> {
    const items: Array<MenuElement> = [
      { value: '版本信息', action: (): void => {
        this.aboutTab = 'version';
        this.aboutOpen = true;
      } },
      { value: '开源组件声明', action: (): void => {
        this.aboutTab = 'oss';
        this.aboutOpen = true;
      } }
    ];
    return items;
  }

  /**
   * 顶栏菜单的选项：沉浸光感材质（`uiMaterial`，API 26 起）**能拿到就挂、拿不到就退回系统默认**。
   *
   * ⚠️ 必须兜住：`uiMaterial.ImmersiveStyle` 在**没实现该能力的设备上是 `undefined`**
   * （审核实测：2in1 上 `Cannot read property THICK of undefined` ⇒ WebApp 组件更新直接抛错、
   * 应用闪退循环）。这里做「设备 API ≥ 26 + try/catch」双重保护 —— 顶栏菜单只是装饰性能力，
   * 任何设备都不该因为它崩掉。取不到材质时返回 `undefined`，`bindMenu` 退回系统默认菜单样式，
   * 菜单功能完全不受影响。
   *
   * 【2026-11-11 材质调整】`THICK` → `THIN`：THICK 的底衬太实，和 DSHM 的沉浸顶栏
   * 打架；THIN 保留透光与模糊，弹层仍然清晰可读。
   */
  private menuMaterialOptions(): MenuOptions | undefined {
    if (deviceInfo.sdkApiVersion < 26) {
      return undefined;
    }
    try {
      const opts: MenuOptions = {
        systemMaterial: new uiMaterial.ImmersiveMaterial({ style: uiMaterial.ImmersiveStyle.THIN })
      };
      return opts;
    } catch (e) {
      return undefined;
    }
  }

  /** 网页上下文菜单挂起态：openMenu 之后、菜单消散之前。非 @State——不驱动 UI。 */
  private webMenuContent: ComponentContent<WebContextMenuPanelParams> | undefined = undefined;
  private webMenuResult: WebContextMenuResult | undefined = undefined;
  private webMenuClosed: boolean = true;

  /**
   * 收菜单（幂等）：告诉 ArkWeb「菜单已关」（closeContextMenu），网页恢复交互。
   * webMenuClosed 防「菜单项点击」与「onDisappear」双路径重入。
   */
  private dismissWebContextMenu(): void {
    if (this.webMenuClosed) {
      return;
    }
    this.webMenuClosed = true;
    const r: WebContextMenuResult | undefined = this.webMenuResult;
    this.webMenuResult = undefined;
    if (r !== undefined) {
      try {
        r.closeContextMenu();
      } catch (e) {
        // 收不了就交还系统兜底，装饰性路径不抛错
      }
    }
  }

  /** 释放菜单的 ComponentContent（幂等；只在菜单确定离场后调）。 */
  private disposeWebMenuContent(): void {
    const c: ComponentContent<WebContextMenuPanelParams> | undefined = this.webMenuContent;
    this.webMenuContent = undefined;
    if (c !== undefined) {
      try {
        c.dispose();
      } catch (e) {
        // 已释放
      }
    }
  }

  /**
   * 菜单项点击的统一收尾：ArkWeb 动作 → closeContextMenu → closeMenu → 后置动作。
   * 顺序依据 web.d.ts：result 里没有别的调用时须主动 closeContextMenu 收菜单；
   * 我们自己的 openMenu 菜单由 closeMenu 收，onDisappear 再做幂等清场。
   */
  private runWebMenuItem(label: string, action?: () => void, post?: () => void): void {
    this.dirPickerBridge.writeDiagMarkerPublic('diag-webmenu', `item ${label}`);
    if (action !== undefined) {
      try {
        action();
      } catch (e) {
        // 动作失败也照常收菜单
      }
    }
    this.dismissWebContextMenu();
    const c: ComponentContent<WebContextMenuPanelParams> | undefined = this.webMenuContent;
    if (c !== undefined) {
      try {
        this.getUIContext().getPromptAction().closeMenu(c);
      } catch (e) {
        // 菜单已在关闭中
      }
    }
    if (post !== undefined) {
      post();
    }
  }

  /**
   * 沉浸光感·混合承载（2026-11-17）：接管网页右键/长按菜单。
   *
   * 【为什么 return false 是万金油】任何拿不准的情形（事件缺参、坐标异常、
   * 空菜单项、构建异常）一律 return false ⇒ ArkWeb 弹系统默认菜单，现有功能
   * 零退化；自定义路径只覆盖我们能完整负责的部分。
   *
   * 【材质】菜单挂 THIN 非交互材质（对齐顶栏 menuMaterialOptions 先例）；材质参数
   * 只在 API≥26 求值——`uiMaterial.ImmersiveStyle` 在未实现设备上是 undefined，
   * 低版本设备提前求值会当场抛错（docs/196 闪退循环教训）。
   *
   * 【坐标】param.x()/y() 即触点（官方口径按 vp 用，diag 记原始值备验）；
   * anchorPosition 相对锚点（Stack 内 position(0,0)，与 Web 布局原点同点）左上角。
   */
  private handleWebContextMenuShow(event?: OnContextMenuShowEvent): boolean {
    try {
      if (event === undefined || event.param === undefined || event.result === undefined) {
        this.dirPickerBridge.writeDiagMarkerPublic('diag-webmenu', 'fallback no-event');
        return false;
      }
      const param: WebContextMenuParam = event.param;
      const result: WebContextMenuResult = event.result;
      const px: number = param.x();
      const py: number = param.y();
      if (px < 0 || py < 0) {
        this.dirPickerBridge.writeDiagMarkerPublic('diag-webmenu', `fallback coords x=${px} y=${py}`);
        return false;
      }
      const link: string = param.getLinkUrl();
      const selText: string = param.getSelectionText();
      const editable: boolean = param.isEditable();
      const flags: number = param.getEditStateFlags();
      const isImage: boolean = param.existsImageContents()
        || param.getMediaType() === ContextMenuMediaType.Image;
      const items: WebContextMenuItem[] = [];
      if (link.length > 0) {
        // 打开链接不二次确认：菜单点击即明确意图，与 onLoadIntercept 直开口径一致
        items.push({
          label: '打开链接',
          run: (): void => {
            this.runWebMenuItem('打开链接', undefined, (): void => {
              this.launchExternal(link);
            });
          }
        });
        items.push({
          label: '复制链接',
          run: (): void => {
            this.runWebMenuItem('复制链接', undefined, (): void => {
              copyText(link).then((): void => {
                // 复制成功无需打扰
              }, (e: Error): void => {
                this.dirPickerBridge.writeDiagMarkerPublic('diag-webmenu', `copy-link-fail ${e.message}`);
              });
            });
          }
        });
      }
      if (isImage) {
        items.push({
          label: '复制图片',
          run: (): void => {
            this.runWebMenuItem('复制图片', (): void => {
              result.copyImage();
            });
          }
        });
        // saveImage 是 API 24 起：API 23 设备上字段不存在，typeof 守卫
        if (typeof result.saveImage === 'function') {
          items.push({
            label: '保存图片',
            run: (): void => {
              this.runWebMenuItem('保存图片', (): void => {
                result.saveImage();
              });
            }
          });
        }
      }
      if (editable) {
        if ((flags & ContextMenuEditStateFlags.CAN_CUT) !== 0) {
          items.push({
            label: '剪切',
            run: (): void => {
              this.runWebMenuItem('剪切', (): void => {
                result.cut();
              });
            }
          });
        }
        if ((flags & ContextMenuEditStateFlags.CAN_COPY) !== 0) {
          items.push({
            label: '复制',
            run: (): void => {
              this.runWebMenuItem('复制', (): void => {
                result.copy();
              });
            }
          });
        }
        if ((flags & ContextMenuEditStateFlags.CAN_PASTE) !== 0) {
          items.push({
            label: '粘贴',
            run: (): void => {
              this.runWebMenuItem('粘贴', (): void => {
                result.paste();
              });
            }
          });
        }
        if ((flags & ContextMenuEditStateFlags.CAN_SELECT_ALL) !== 0) {
          items.push({
            label: '全选',
            run: (): void => {
              this.runWebMenuItem('全选', (): void => {
                result.selectAll();
              });
            }
          });
        }
      } else {
        if ((flags & ContextMenuEditStateFlags.CAN_COPY) !== 0 && selText.length > 0) {
          items.push({
            label: '复制',
            run: (): void => {
              this.runWebMenuItem('复制', (): void => {
                result.copy();
              });
            }
          });
        }
        if ((flags & ContextMenuEditStateFlags.CAN_SELECT_ALL) !== 0) {
          items.push({
            label: '全选',
            run: (): void => {
              this.runWebMenuItem('全选', (): void => {
                result.selectAll();
              });
            }
          });
        }
      }
      if (items.length === 0) {
        this.dirPickerBridge.writeDiagMarkerPublic('diag-webmenu',
          `fallback empty link=${link.length} sel=${selText.length} editable=${editable ? 1 : 0} flags=${flags}`);
        return false;
      }
      this.webMenuResult = result;
      this.webMenuClosed = false;
      const ui = this.getUIContext();
      const panelParams: WebContextMenuPanelParams = {
        items: items,
        themeDark: this.themeMode === 'dark'
      };
      const content: ComponentContent<WebContextMenuPanelParams> =
        new ComponentContent<WebContextMenuPanelParams>(ui, wrapBuilder(WebContextMenuPanel), panelParams);
      this.webMenuContent = content;
      // 材质参数只在 API≥26 求值（ImmersiveStyle 在未实现设备上是 undefined）
      let mat: uiMaterial.ImmersiveMaterial | undefined = undefined;
      if (deviceInfo.sdkApiVersion >= 26) {
        try {
          mat = immersiveMaterialOf(uiMaterial.ImmersiveStyle.THIN, false);
        } catch (e) {
          mat = undefined;
        }
      }
      const opts: MenuOptions = {
        anchorPosition: { x: px, y: py },
        onAppear: (): void => {
          this.dirPickerBridge.writeDiagMarkerPublic('diag-webmenu', 'appear');
        },
        onDisappear: (): void => {
          this.dirPickerBridge.writeDiagMarkerPublic('diag-webmenu', 'dismiss');
          this.dismissWebContextMenu();
          this.disposeWebMenuContent();
        }
      };
      if (mat !== undefined) {
        opts.systemMaterial = mat;
      }
      this.dirPickerBridge.writeDiagMarkerPublic('diag-webmenu',
        `show x=${px} y=${py} src=${param.getSourceType()} media=${param.getMediaType()} `
        + `link=${link.length > 0 ? 1 : 0} sel=${selText.length} editable=${editable ? 1 : 0} `
        + `flags=${flags} items=${items.length} mat=${mat !== undefined ? 1 : 0}`);
      ui.getPromptAction().openMenu(content, { id: 'dshm-web-menu-anchor' }, opts).then((): void => {
        this.dirPickerBridge.writeDiagMarkerPublic('diag-webmenu', 'open ok');
      }, (e: Error): void => {
        this.dirPickerBridge.writeDiagMarkerPublic('diag-webmenu', `open fail ${e.message}`);
        this.dismissWebContextMenu();
        this.disposeWebMenuContent();
      });
      return true;
    } catch (e) {
      // return false 路径不能调 closeContextMenu（系统默认菜单还要用 result）
      this.webMenuResult = undefined;
      this.disposeWebMenuContent();
      this.dirPickerBridge.writeDiagMarkerPublic('diag-webmenu', `fallback exception ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * 顶栏唯一入口：三个实心圆点，点击弹出「版本信息 / 开源组件声明」。
   *
   * 【为什么用点而不是文字（2026-11-11 用户裁决）】「应用」菜单删掉后顶栏只剩一个
   * 入口，再写「关于」两个字比图标更占地方；三点是桌面端"更多操作"的通用语汇。
   * 颜色取顶栏前景色（跟随外观）；hover 垫与官方图标按钮同值（`rgba(128,128,128,.18)`），
   * 这样它在浅底/深底顶栏上都与状态栏、右上三键是同一套观感。
   * 尺寸（2026-11-11 用户「再小一点」）：点 3vp、间距 2.5vp、盒高 22vp —— 比上一版
   * 各小 1vp，仍与官方图标按钮的 22~24 高度同一行对齐。
   */
  @Builder
  DotsMenu() {
    WithTheme({ colorMode: this.themeMode === 'dark' ? ThemeColorMode.DARK : ThemeColorMode.LIGHT }) {
      Row({ space: 2.5 }) {
        Circle().width(3).height(3).fill(this.topBarFgNow())
        Circle().width(3).height(3).fill(this.topBarFgNow())
        Circle().width(3).height(3).fill(this.topBarFgNow())
      }
      .height(22)
      .padding({ left: 7, right: 7 })
      .borderRadius(5) // token-exempt: 与官方图标按钮 hover 圆角一致
      .backgroundColor(this.dotsHover ? '#2E808080' : '#00000000') // token-exempt: 官方交互底色 rgba(128,128,128,0.18)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .onHover((isHover: boolean) => {
        this.dotsHover = isHover;
      })
      .bindMenu(this.aboutMenu(), this.menuMaterialOptions())
      .onClick(() => {
        // bindMenu 点击弹出；空实现让整个圆点区可点
      })
    }
  }

  /** 品牌标识动画属性：启动页大标识（logo_dark 品牌标）呼吸/淡入，顶栏按钮恒为静态。 */
  private markScale(animated: boolean): ScaleOptions {
    return animated ? { x: this.brandBreath, y: this.brandBreath } : { x: 1, y: 1 };
  }

  private markOpacity(animated: boolean): number {
    return animated ? this.brandOpacity : 1;
  }

  /**
   * 顶栏前景色：**跟随「设置→外观」**（报告 5 §2.2）。
   *
   * 【为什么不直接返回常量】2026-09-26 先要求黑底白字、又要求回白底黑字，报告 5
   * 进一步要求**跟随外观**。由 `topBarFg`（applySystemBarTheme 按 light/dark 更新）派生。
   * 【底色为什么没有对应取值函数】2026-11-16 沉浸起顶栏不画底色（Color.Transparent，
   * 窗口底色由 setWindowBackgroundColor 统一提供）⇒ topBarBgNow()/topBarBg 已退役。
   */
  private topBarFgNow(): string {
    return this.topBarFg;
  }

  /**
   * 自绘顶栏：**只有一颗三点菜单**（版本信息 / 开源组件声明），配色跟随「设置→外观」。
   *
   * 【2026-11-11 用户裁决】「应用」菜单（主页 / 刷新）整条删除，顶栏不再有第二个入口；
   * 原来左上角的自绘侧栏按钮也已删除（更早一轮），官方那颗恢复可见、点击走官方逻辑。
   * 收起态（56px 图标轨）由 SIDEBAR_SHIM_JS 把官方 opener 抬成常显，不再有自绘第二颗。
   *
   * 【渲染范围】PC / 2in1 恒显；Edge / ProMax / MateBook 随桌面档横竖屏显隐；
   * 手机与普通平板不渲染（与 2026-11-06 用户口径一致）。
   *
    * 【三键对比度】三键 colorMode 随明暗切换（浅底深键 / 深底浅键），见 applySystemBarTheme。
   * 【为什么必须不透明实色】半透明底会让文字与图标对比度崩溃
   * （DSHM 2026-09-12 实测教训），深浅同理都必须实色。
   * 本顶栏顶到窗口第一行（setWindowDecorVisible 隐藏系统标题栏），
   * right 动态避让三键区。
   */
  @Builder
  TopBar() {
    Row() {
      this.DotsMenu()
      /*
       * 2026-10-30（docs/317）：「云同步」不再做成顶栏第三个菜单 ——
       * 手持档整条顶栏不渲染，菜单在手机上根本不存在。入口统一收到**官方设置面板**里
       * 「云同步」分区由 `hostcore/plugins/dshm-cloud-sync` 经官方 settings.section 注册，
       * 不再额外注入第二颗 DOM 按钮（否则同屏出现两个「云同步」）。
       */
      /*
       * 顶栏尾部空白 = **窗口拖动热区**（2026-10-28）。此前这里只是一个 `Blank()`：
       * 系统标题栏被我们隐藏后，自由窗口里抓顶栏拖不动窗口（用户报的"不能拖动"）。
       * 绑在空白区而不是整条顶栏，是为了不让"按下按钮"也起拖。
       */
      Row()
        .layoutWeight(1)
        .height('100%')
        .onTouch((event: TouchEvent) => {
          if (event.type === TouchType.Down) {
            this.beginWindowDrag();
          }
        })
    }
    .width('100%')
    .height(TOP_BAR_HEIGHT)
    // right 动态避让自由窗口右上角三键（全屏模式退回 8vp 默认）
    .padding({ left: 10, right: this.decorPadRight })
    /*
     * 【2026-11-16 沉浸】顶栏不再画自己的底色：窗口底色已由 applySystemBarTheme 按
     * 同一份外观设为 chrome.bg，整条与页面上下同色 ⇒ 标题条与内容之间没有色带。
     */
    .backgroundColor(Color.Transparent)
    .alignItems(VerticalAlign.Center)
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
        .height(240) // token-exempt: 工作区浏览器目录列表固定高度
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

  build() {
    Column() {
      /*
       * ── 平板沉浸式状态栏（2026-11-04）──
       * 窗口已进入 layout-fullscreen（见 EntryAbility.enterTabletImmersive），内容延伸到状态栏
       * 下方；这里按顶部避让高度整体下移，于是状态栏区域露出的是本页背景（沉浸观感），
       * 状态栏图标由系统画在最上层。topInsetVp=0（PC/手机）时 padding 为 0，布局逐字不变。
       */
      /*
       * PC / 2in1 与普通平板显示自绘顶栏；手机不显示。普通平板沿用页面布局与安全区，
       * 顶栏与侧栏入口采用 PC 形态（入口接管）；**侧栏状态与几何交回官方**（2026-10-28 收口）。
       * Edge / ProMax 继续按原 desktopForced 策略。
       */
      if (this.shouldShowTopBar()) {
        this.TopBar()
      }
      Stack() {
      // Web 放最底层：ERROR 时也不卸载（保持 controller 可用，重试走 refresh）
      if (this.phase !== WebPhase.BOOTING) {
        Web({ src: this.launchUrl, controller: this.controller })
          .attributeModifier(WEB_CONTEXT_MENU_COMPAT)
          // 沉浸光感·混合承载（2026-11-17）：网页右键/长按菜单由应用侧接管，
          // openMenu 弹带 systemMaterial 的原生菜单（内容相关毛玻璃）。
          // 拿不准一律 return false 走系统默认，现有功能零退化。
          .onContextMenuShow((event?: OnContextMenuShowEvent): boolean => {
            return this.handleWebContextMenuShow(event);
          })
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .fileAccess(false)
          // ── 目录选择三段式（2026-09-21，见 PICKER_SHIM_JS 注释）──
          // 第 2 段之垫片：javaScriptOnDocumentStart 保证脚本先于页面任何
          // JS 执行（官方文档原文），即先于官方 wire bootstrap → 官方前端
          // native 面的 apply() 读 __DSH_DIRECTORY_PICKER__ 时垫片已就位。
          // ⚠ 验收信号：DOM 探针的 p/c/r 字段应为 "object"/"object"/"function"。
          .javaScriptOnDocumentStart(this.pickerShimScripts)
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
            /*
             * 【2026-10-29 性能修复：补上 platformPcMode】methodList 漏了它 ⇒ 原生侧不注册
             * 该方法的代理 ⇒ 侧栏垫片的 300ms tick 每拍调 b.platformPcMode() 都在
             * ArkWeb 侧打一条 "native proxy object not found, name:__DSHM_BRIDGES__"
             * —— 实测当前日志累计 **11500+ 行**（全链 263 MiB 的一半），每行还伴随
             * 5 行 OhGin 调度日志 ⇒ 持续 CPU + 文件写放大，正是"开久了打字顿挫"的
             * 直接贡献源之一。phone 模块的 methodList 一直有它（对照 phone:5540），
             * entry 侧是迁移遗漏。bridge 对象本体（'platformPcMode': …）一直在
             * bridges 里定义着，只是名单漏登记。
             */
            methodList: ['startPick', 'onThemeMode', 'startNativeCapture', 'nativeCaptureState', 'takeNativeCapture', 'cancelNativeCapture', 'openExternal', 'openFilePreview', 'openFileLocation', 'writeGlassDiag', 'platformHandheld', 'platformForm', 'platformPcMode', 'requestSystemBack', 'openCloudSync', 'cloudSyncState', 'cloudSyncAction', 'readAloud', 'stopReadAloud', 'shareText'],
            controller: this.controller
          })          // 官方 web UI 自己按 prefers-color-scheme 适配暗色：跟随系统、不强制反色
          .darkMode(WebDarkMode.Auto)
          .forceDarkAccess(false)
          .onPageBegin(() => {
            this.cancelNativeCapture();
            // 【顺序不可换】上一行必须是本回调的第一个动作（`check-native-capture-lifecycle`
            // 断言 `{\s*this.cancelNativeCapture();`），且紧跟的必须是 // 注释行
            //（同一门禁自测的 mutant 4 用它做锚点）。启动标记只能放在这之后。
            // S6：Web 开始导航（S5→S6 是"URL 已发布但 Web 尚未起导航"的间隔）
            startupMarks.mark('S6', StartupPhase.WEB, 'page_begin');
            // 整页导航（含 303 后的落地）重新进入加载期；SPA 内部路由不受影响
            if (this.phase === WebPhase.READY) {
              this.phase = WebPhase.LOADING;
            }
            // 新一轮加载：注入脚本要等 onPageEnd 才保证 DOM 在位（docs/172 §5.2）
            this.webReady = false;
            this.clearPostLoadSettle();
          })
          /*
           * 【2026-10-28 修"链接不会跳转浏览器"】垫片只能接住"用户点击的锚点"与 `window.open`；
           * 而壳层默认行为更硬：ArkWeb `multiWindowAccess=false` ⇒ 新窗口一律丢弃；
           * **普通锚点 / `location` 赋值 / 表单提交**则走**页内导航** ⇒ 外部页（授权页更会按
           * 204 空页）把应用自己的界面替掉 —— 两种都不是"跳系统浏览器"。
           * 本回调在**原生层**兜住所有导航：
           *   · 本机回环（应用自身页面 / SPA / 资源）⇒ 放行；
           *   · 其余 http(s) ⇒ 交系统浏览器 `openExternalUrl` 并**拦下页内导航**（返回 true）。
           * 与垫片互补：垫片给"点击即二次确认"的 UX，这里保证"无论怎么发起都不在应用内打开外链"。
           */
          .onLoadIntercept((event: OnLoadInterceptEvent): boolean => {
            try {
              const target: string = event.data.getRequestUrl();
              if (!this.isExternalNavigation(target)) {
                return false;
              }
              /*
               * 【必须区分主帧与子帧（2026-10-29 复审修）】`onLoadIntercept` 对**所有导航**
               * 触发，包括 iframe 的 src 加载 —— SDK 专门在 WebResourceRequest 上提供
               * isMainFrame() 就是为此。若不判，聊天内容里一个指向外部站点的 iframe 会让
               * 浏览器在**没有用户交互**的情况下自己弹出来。
               *   · 主帧外链 ⇒ 拦下并交系统浏览器（用户意图，如 location 赋值 / 未接住的点击）；
               *   · 子帧外链 ⇒ 同样**拦下**（外部页面不该被嵌进应用 WebView），但**不外开**
               *     ——没有人点它，弹浏览器只会吓到用户。
               */
              if (!event.data.isMainFrame()) {
                hilog.info(DOMAIN, TAG, '拦下子帧外链导航（不外开）：%{public}s', target);
                return true;
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
              const err = e as Error;
              hilog.warn(DOMAIN, TAG, 'onLoadIntercept 异常（放行本次导航）：%{public}s', err.message);
              return false;
            }
          })
          .onPageEnd(() => {
            /*
             * 【版本锚点（2026-11-07）】云测只能从日志侧取证：多轮并行出包后靠时间戳
             * 人工对版本不可靠。每次页面结束（含失败轮）都打一行 versionCode/versionName，
             * 任何日志窗口即可对版。走 CLOUD_DOMAIN（0xD5D5 在云测抓取里不可见）。
             */
            try {
              const bi: bundleManager.BundleInfo = bundleManager.getBundleInfoForSelfSync(
                bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
              hilog.info(CLOUD_DOMAIN, TAG, '[dshm-web] version=%{public}s (%{public}d)',
                bi.versionName, bi.versionCode);
            } catch (e) {
              const err = e as Error;
              hilog.warn(CLOUD_DOMAIN, TAG, '[dshm-web] version 读不到：%{public}s', err.message);
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
            this.phase = WebPhase.READY;
            // S7：首屏就绪（S0→S7 即用户感知的完整启动时长），并落一次汇总
            startupMarks.mark('S7', StartupPhase.READY, 'first_paint_ready');
            startupMarks.finish('ready');
            /*
             * 页面就绪：补发挂起的快捷方式动作（docs/172 §5.2）。
             * 「新建会话」按钮属于侧栏常驻 DOM，页面加载完成即可点；SPA 内部路由不影响它。
             */
            this.webReady = true;
            this.scheduleViewportReconcile('page-end');
            this.schedulePostLoadSettle();
            if (this.pendingLaunchAction.length > 0) {
              const pending: string = this.pendingLaunchAction;
              this.pendingLaunchAction = '';
              this.dispatchWebAction(pending);
            }
            /* 碰一碰：页面就绪，补发挂起的接收文件（docs/418） */
            this.deliverKnockFiles();
            /*
             * 碰一碰注册挂到页面就绪之后（docs/418 §6：首轮真机实测注册在页面就绪前
             * 14s，dataReceive 未触发——排除「系统在注册那一刻定格可接收窗口」这条）。
             * 幂等：receiver 已注册则 start() 空跑；此前失败则本轮重试。
             */
            this.startKnockReceiver();
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
          .onShowFileSelector((event?: OnShowFileSelectorEvent) => {
            if (event === undefined) {
              return false;
            }
            hilog.info(DOMAIN, TAG, 'onShowFileSelector 触发（ArkWeb 默认文件选择，input[type=file] 路径）');
            this.dirPickerBridge.writeDiagMarkerPublic('diag-file-selector');
            return false;
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
            hilog.info(CLOUD_DOMAIN, TAG, '[web] %{public}s:%{public}d %{public}s %{public}s',
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

      // 沉浸光感·混合承载（2026-11-17）：网页上下文菜单的定位锚。
      // openMenu 的 TargetInfo 按 id 寻址到这里；1x1 透明 + HitTestMode.None
      // ⇒ 不挡 Web 任何触点。position 相对父（Stack）内容区（common.d.ts
      // position 注释），与 Web 布局原点同点 ⇒ anchorPosition 直接吃
      // onContextMenuShow 的 param.x()/y()。
      Column()
        .width(1)
        .height(1)
        .position({ x: 0, y: 0 })
        .hitTestBehavior(HitTestMode.None)
        .id('dshm-web-menu-anchor')

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
            .backgroundColor(this.splashDark ? '#2A2A2E' : '#e4e7ec') // 启动页进度条：随手启动页深浅色
            .margin({ top: 40 })
          /*
           * 【2026-11-25 撤回首页骨架暗示（用户真机裁决）】
           *
           * 曾在此处加过「标题块 + 三个场景 pill + 输入框」的内容区占位（A2 的骨架暗示，
           * 见 docs/201 §11.1）。PC 端真机截图反馈：进度条下方这块灰色结构是**多余**的，
           * 启动环节不要它。
           *
           * 结论与边界：
           *   · 启动页恢复为「品牌标 + 线性进度条」两项，不加任何结构占位；
           *   · A2 的"窗口先带结构出现"在 DSHM 上**不成立**——启动页是纯 ArkUI 覆盖层，
           *     它下面此刻没有可对齐的真实布局，占位块只会被读成"多余的东西"；
           *   · 若以后再做，前提是 Web 组件已经带着真实首屏骨架（WorkBuddy 那条路），
           *     而不是在 ArkUI 启动页里画假结构。
           */
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
         * PC / 2in1 保持只扩底部（它们没有手机这种状态栏，一个字节不动）。
         */
        .expandSafeArea(
          this.handheld ? [SafeAreaType.SYSTEM] : this.bottomSafeAreaTypes(),
          this.handheld ? [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM] : this.bottomSafeAreaEdges())
        .onAppear(() => {
          this.startBrandAnimation();
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
        .expandSafeArea(this.bottomSafeAreaTypes(), this.bottomSafeAreaEdges())
      }
      if (this.workspaceBrowserOpen) {
        this.WorkspaceBrowserOverlay()
      }
      /*
       * 「关于」浮层：两个独立入口（版本信息 / 开源组件声明），由顶栏「关于」菜单直接定位，
       * 清单来自 rawfile/licenses/OSS-NOTICES.json（构建期由 tools/gen-oss-notices.mjs
       * 从**实际随包内容**生成），本面板只读不写。
       */
      if (this.aboutOpen) {
        AboutPanel({
          coreVersion: this.dshCoreVersion(),
          initialTab: this.aboutTab,
          onClose: (): void => {
            this.aboutOpen = false;
          }
        })
      }
      /*
       * 华为账号与云同步（2026-10-29，docs/299/300）。
       * 页内浮层，**不跳路由** —— 顶栏与 Web 都保持在场，关闭即收起。
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
       * 真机（PC/2in1，API 26）三轮实测把三件事钉死：
       *   ① `getFrameNodeById(...).commonAttribute` 这条路**写不动** ArkUI 节点：读数 `route=ok`，
       *      而声明期固定成绿色的对照块始终没变红 ⇒ 官方「只有自定义节点的属性可以修改」是真阻碍；
       *   ② 声明链 `.systemMaterial(...)` 才是唯一有效写法 —— 顶栏当场由纯白转半透明蓝；
       *   ③ 材质**能**盖在 ArkWeb 画布之上，但那只是「一层半透明色罩 + 模糊」：整块 Web 内容
       *      被染蓝、文字糊掉 ⇒ 不是内容相关毛玻璃，**不适合**做「全局沉浸光感」。
       * ⇒ 不铺开：本应用界面主体是 Web 画布，材质层只适合挂在自绘的 ArkUI 面上（如顶栏）。
       *
       * 【后续（同日）：顶栏菜单已按此结论落地 —— 见 @Builder DotsMenu 与 `docs/147` §13.5】
       * 用户复报「应用菜单并未跟随系统沉浸光感的强度」⇒ 在真机上补测四条形态：
       *   · 只把元数据从 `disable` 翻成 `enable`、菜单不挂 `systemMaterial` ⇒ 与 `disable` 档**逐像素相同**；
       *   · 菜单在**声明点**挂 `systemMaterial` 才会变玻璃；
       *   · 浅色系统下要给浅色玻璃，必须由 `WithTheme` 定深浅（`ThemeColorMode.SYSTEM` 实测仍给深色）；
       *   · `colorInvert: true` 会把菜单**自身条目文字**糊掉 ⇒ 不要跟着开。
       *
       * 【2026-11-17 落地：混合承载（方案①，`docs/419`）】按本结论纪律铺开到自绘面，不碰 Web 画布：
       *   · entry 4 处 `AlertDialog` 挂 `systemMaterial: dialogMaterial()`（THICK，platform Kit）；
       *   · Web 右键/长按菜单原生接管（`handleWebContextMenuShow`）：`openMenu` + THIN
       *     `immersiveMaterialOf`、`WithTheme` 定深浅、锚点 Stack 内 1×1 透明块（`position(0,0)`）；
       *   · Kit 包装函数在实参求值前先判 API≥26（`ImmersiveStyle` 在未实现设备上是 undefined）。
        */
      }
      .layoutWeight(1)
      .width('100%')
      /*
       * 三键区顶部让位（2026-10-10，MatePad Edge 报「右上角三键与右侧边栏按钮重叠」）：
       * 手持档不渲染自绘顶栏（见上），窗口标题栏那一条就**没人画**，而窗口仍在「自由窗口 +
       * 三键可见」的状态 ⇒ 官方 Web 壳自己那排顶部按钮（最右侧那颗「面板 / 预览」开关）
       * 正好落在系统三键底下。把整块 Web 内容按**固定让位量**（`HANDHELD_DECOR_INSET_VP`）压下去即解 —— 那些按钮是**页面
       * 自己的**，我们只能让位、不能挪它。
       * 【为什么 PC/2in1 不受影响】让位由纯函数 decorTopInsetVp 给出，非手持**恒为 0**
       * ⇒ 这条 padding 在 PC 上是 0；顶栏 2026-11-16 起不画底色（Color.Transparent），
       * 窗口底色由 applySystemBarTheme 的 setWindowBackgroundColor 统一为 chrome.bg
       * ⇒ PC 上即使露出也看不出差别。
       * 【为什么这里现算而不是读一个 @State 结论】三键可见性由能力层在 loadContent 回调里
       * 发布（页面首帧之后才有）—— 渲染期求值天然跟上，不必再往状态里存第二份结论。
       */
      .padding({ top: this.decorTopInsetNow() })
      // 底部手势区沉浸（docs/130）：Stack 是"把扩下去的额度接力给子组件"的那一环 ——
      // expandSafeArea 不向子组件传播，父容器的框不伸，子组件就还是被它框在安全区上沿。
      .expandSafeArea(this.bottomSafeAreaTypes(), this.bottomSafeAreaEdges())
    }
    .padding({ top: this.topInsetVp })
    .width('100%')
    .height('100%')
    .expandSafeArea(this.bottomSafeAreaTypes(), this.bottomSafeAreaEdges())
}
}
