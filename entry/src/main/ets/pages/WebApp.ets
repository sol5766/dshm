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
 * 【2026-09-21 品牌对齐官方】应用名定为 DSHM（dsh + HarmonyOS），对齐官方桌面版：
 * 左上角标识 = 官方鲸鱼（**官方 SVG 素材 `app.media.fish_logo` + `Image.fillColor` 着色**，
 * 路径逐字节取自 @deepseek-ai/dsh-client-ui-primitives 的 FISH_LOGO_PATH；见 FishMark 注释）；
 * 菜单两组并排——「DSHM」应用菜单（主页/刷新/关于版本）+「编辑」
 * 菜单（撤销/重做/剪切/复制/粘贴/删除/全选，与官方桌面版逐项看齐；窗口菜单仍不搬
 * ——平板无窗口管理概念）。启动画面用官方 logo_dark 资产（不用自绘）；应用安装名
 * 与关于对话框同改为 DSHM，关于版本直接显示当前运行的 dsh 核心版本。
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { webview } from '@kit.ArkWeb';
import { BusinessError } from '@kit.BasicServicesKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { picker, fileUri, fileShare } from '@kit.CoreFileKit';
import { common, ConfigurationConstant } from '@kit.AbilityKit';
// `PermissionRequestResult` / `Permissions` 是 AbilityKit 的**顶层**导出，
// 不在 `abilityAccessCtrl` 命名空间下（实测编译报错 "has no exported member"）。
import { abilityAccessCtrl } from '@kit.AbilityKit';
import type { PermissionRequestResult, Permissions } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { window } from '@kit.ArkUI';
import { Fs } from 'appstate';
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
import { copyText } from 'platform';
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
 * 把文本直接填入 dsh 输入框（execCommand insertText）。
 *
 * 【为什么用这个方法】我之前误判它"无效"，真机证据是**有效**：
 * 探针跑完后草稿里出现了 AAA1BBB2CCC3CCC3 —— 正是我依次插入的三个标记。
 * 误判原因：探针用 `el.innerText` 读回，而 Lexical 的内容不在 innerText 里。
 *
 * 【目标元素怎么选】页面可能有多个 contenteditable（含隐藏辅助元素）。
 * 选**可见、有尺寸、位置最靠下**的那个 —— dsh 的输入框在页面底部。
 * 插入后不做页内读回（不可靠），由 ArkTS 侧另行验证。
 */
const INSERT_TEXT_JS: string =
  '(function (text) {' +
  '  var sel = \'[contenteditable=""],[contenteditable="true"],textarea,[role="textbox"]\';' +
  '  var list = document.querySelectorAll(sel);' +
  '  if (list.length === 0) { return "no-editable"; }' +
  '  var target = null; var bestTop = -1;' +
  '  for (var i = 0; i < list.length; i++) {' +
  '    var e = list[i];' +
  '    var r = e.getBoundingClientRect();' +
  '    var st = window.getComputedStyle(e);' +
  '    if (st.visibility !== "visible" || st.display === "none" || r.width < 50 || r.height < 10) { continue; }' +
  '    if (r.top > bestTop) { bestTop = r.top; target = e; }' +
  '  }' +
  '  if (!target) { return "no-visible-target"; }' +
  '  target.focus();' +
  '  try {' +
  '    var s = window.getSelection(); s.removeAllRanges();' +
  '    var rg = document.createRange(); rg.selectNodeContents(target); rg.collapse(false); s.addRange(rg);' +
  '  } catch (e0) { return "caret:" + e0.message; }' +
  '  var ok = false;' +
  '  try { ok = document.execCommand("insertText", false, text); } catch (e1) { return "exec:" + e1.message; }' +
  '  return ok ? "ok" : "exec-false";' +
  '})';




/**
 * 桌面载体声明（2026-09-24 官方功能对齐）：官方 dsh 前端把**桌面壳专属功能**的
 * 注册门在 `globalThis.dshDesktop` 上（官方桌面 App 的 Electron 壳注入）。本应用
 * 是 ArkUI Web 壳，天然没有这个全局——后果是三处功能静默缺席（用户验收实测）：
 *   ① `dsh-client-ui-settings-account` 的 apply 首行 `if (!("dshDesktop" in
 *      globalThis)) return;`（lib/client.js:2217）——不注入则左下角账号菜单
 *      （settings.launcher → AccountMenu，含登录入口）、设置面板账号 section、
 *      登录对话框（SignInDialog）全部不注册，即"左下角设置少了登录界面"；
 *   ② `dsh-client-ui-settings-general` 的 DesktopUpdateSource 按
 *      `carrier?.protocolVersion === 1 ? carrier.updates : void 0` 取更新载体；
 *   ③ `dsh-client-ui-sidebar-browser` 的桌面浏览器 tab 载体同式可选链。
 * 注入 `{ protocolVersion: 1 }` 的边界：②③取不到 updates/browser 字段走 undefined
 * 安全降级（无更新指示、Web 内置 iframe 浏览器，均为官方 Web 形态）；另
 * `dsh-client-ui-settings-models` 的 API-key credentialOnboarding 以
 * `!("dshDesktop" in globalThis)` 为显示条件，注入后关闭——这正是官方桌面口径
 * （桌面版引导账号登录，不引导 API key）。登录链路端侧可达：OAuth 回调监听在
 * webServer（dsh-deepseek-account-platform 依赖 credentials+authorization，host
 * 均有），回调地址 127.0.0.1:3120 为设备本机，系统浏览器可及。
 */
const DESKTOP_CARRIER_JS: string =
  'if(typeof globalThis.dshDesktop==="undefined"){' +
  'globalThis.dshDesktop={protocolVersion:1};}';

/**
 * 官方鲸鱼的 viewBox（用户单位）。
 *
 * 【2026-09-25 修正一个错误结论】此前这里有 "FISH_LOGO_INK_*" 一组常量，声称
 * "路径墨迹溢出了官方 viewBox（x∈[-0.2229,23.1738] …）"，并据此把 ArkUI 的 viewPort
 * 设成了那个更大的盒。**那个结论是错的**：它取的是**贝塞尔控制点**的包围盒，
 * 而控制点可以落在曲线**外面**。
 *
 * 实测（把每段 C 曲线离散成 400 个采样点再取极值）：
 *   真实紧包围盒 = x 0.0000 … 23.1600、y 0.0000 … 17.0434
 *   **恰好等于官方 viewBox 23.16 × 17.04**
 * 即墨迹**零溢出**，官方这个数就是准确的。之前用一个偏大 ~1%、且左右留白不等
 * （左 0.2229 / 右 0.0138）的视口，本身就是"歪"的一个来源。
 *
 * 【现在怎么用】鲸鱼改用官方 SVG 资源（`app.media.fish_logo`）+ `Image.fillColor`，
 * 等高比按这两个常量算。路径数据不再内联在本文件——它由
 * `_shot/gensvg.cjs` 从官方 primitives 包**逐字节复制**生成（手抄曾错 1 位：
 * `12.6435` 应为 `12.643`）。
 */
const FISH_LOGO_VIEWBOX_W: number = 23.16;
const FISH_LOGO_VIEWBOX_H: number = 17.04;


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

/** 探针周期：足够观察渲染收敛，又不至于刷日志 */
const PROBE_INTERVAL_MS: number = 10000;

/**
 * 外观跟随桥（报告 5 §2.2）：把官方"设置→外观"的实际生效明暗**即时**告诉 ArkTS。
 *
 * 【为什么不能只靠 10s 探针】验收要求"外观切换 → 状态栏颜色**即时**跟随"。探针
 * 周期是 10s（PROBE_INTERVAL_MS），最坏要等 10 秒才变色，那不算即时。
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
 * （FILE_ACCESS_PERSIST；失败不影响本次选择，Host 访问用户目录实际依赖
 * CUSTOM_SANDBOX）→ runJavaScript 回调垫片把结果送回 H5 Promise。
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

class DshDirectoryPickerBridge {
  private readonly hostContext: () => common.Context | undefined;
  private readonly controller: () => webview.WebviewController;
  /** 单飞行守卫：系统选择器一次只能有一个；startPick 重入直接返回 'busy' */
  private picking: boolean = false;

  constructor(hostContext: () => common.Context | undefined,
    controller: () => webview.WebviewController) {
    this.hostContext = hostContext;
    this.controller = controller;
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
    const docPicker = new picker.DocumentViewPicker(ctx as common.UIAbilityContext);
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
    // 持久化目录授权：跨启动保留访问权。失败/超时只降级为「本次有效」，不阻断选择。
    // ⚠ 必须带超时：fileShare.persistPermission 在本机实测可能永不 settle
    //（疑似 file_access_service 对非系统应用不响应）——一旦挂起，结果永远
    // 回不到 H5，表现为「选完无反应」。而 Host（node）访问用户目录实际依赖
    // CUSTOM_SANDBOX/READ_WRITE_USER_FILE（已授权，directoryPicker/list 与
    // workspace/create 直测均 200），并不依赖这里的持久化授权。
    try {
      const policy: fileShare.PolicyInfo = {
        uri: uri,
        operationMode: fileShare.OperationMode.READ_MODE | fileShare.OperationMode.WRITE_MODE
      };
      const persist: Promise<void> = fileShare.persistPermission([policy]);
      const watchdog: Promise<void> = new Promise<void>((resolve) => {
        setTimeout((): void => {
          resolve();
        }, 3000);
      });
      await Promise.race([persist, watchdog]);
      this.writeDiagMarker('diag-persist-done', '');
      hilog.info(DOMAIN, TAG, '目录授权持久化完成（或超时跳过）');
    } catch (e) {
      const err = e as BusinessError;
      this.writeDiagMarker('diag-persist-skip', `code=${err.code}`);
      hilog.warn(DOMAIN, TAG, '目录授权持久化失败（不阻断）code=%{public}d msg=%{public}s', err.code, err.message);
    }
    const path: string = new fileUri.FileUri(uri).path;
    hilog.info(DOMAIN, TAG, '目录选择完成 path=%{public}s', path);
    this.dispatchResolve(id, path, '');
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

/** 顶栏高度（vp）：自绘标题栏（沿用 DSHM 桌面版尺寸）。 */
const TOP_BAR_HEIGHT: number = 38;

/**
 * 顶栏鲸鱼宽度（vp）。
 *
 * 【2026-09-25 演进】
 *   ① 原始 26vp（+右移 18.2vp）；
 *   ② 报告给官方规格 24vp + 居中，用户裁决「完全按报告」⇒ 改成 24vp；
 *   ③ 装机看效果后用户反馈「**有点大，小 15% 左右等比缩小就合适**」
 *      ⇒ 24 × 0.85 = **20.4vp**。
 *
 * 【为什么是 20.4 而不是整数】用户给的是**相对比例**（"小 15%"），按 24 的 85% 算即 20.4。
 * 取整到 0.1vp 便于与像素对齐核对（2x 屏 = 40.8px）；高度由 23.16:17.04 等比推出
 * （≈15.0vp），**不单独指定**，避免非等比拉伸。
 *
 * 【与官方 24vp 的关系】官方 `FishLogo` 默认 `size=24` 是**Web 侧**的尺寸；
 * 端侧顶栏是 38vp 高的自绘栏，视觉密度与 Web 侧不同，以用户实际观感为准。
 */
const FISH_MARK_SIZE: number = 20.4;
/**
 * 顶栏鲸鱼的光学垂直微调（vp）：官方 `.brandIdentity { transform: translateY(1px) }`。
 * 【为什么要它】墨迹重心略偏上，纯几何居中看起来会"浮起"；官方因此统一下移 1px。
 */
const FISH_MARK_OPTICAL_Y: number = 1;
/**
 * 品牌位与右侧文字/图标的间距（vp）：官方 `.brand { gap: 8px }`。
 * 【历史】此前是 10vp（DSHM 桌面版沿用值），按用户裁决 B 改为官方 8vp。
 */
const FISH_MARK_GAP: number = 8;

@Entry
@Component
struct WebApp {
  @StorageProp(KEY_HOST_LAUNCH_URL) @Watch('onLaunchUrlChanged') launchUrl: string = '';
  @State phase: WebPhase = WebPhase.BOOTING;
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
  private decorWin: window.Window | undefined = undefined;

  // ── 顶栏取色 ──
  // 【2026-09-26 演进】先按用户要求改黑底白字，再改回白底黑字；报告 5 §2.2 又要求
  // **跟随「设置→外观」**（官方对齐）。现在这三个值是"当前生效的配色"，由
  // applySystemBarTheme(mode) 按 light/dark 更新；初值取浅色（首屏与官方 boot
  // 的 `:root{color-scheme:light}` + `#fff` 一致，避免启动瞬间反色闪烁）。
  @State topBarBg: string = '#FFFFFF';
  @State topBarFg: string = '#0F1115';
  /**
   * 当前生效的明暗模式（'light' | 'dark'，空串=尚未确定）。
   *
   * 【为什么必须是 @State（报告 7 §4 的真根因）】此前它是普通 private 字段，而
   * `fishMarkColor()` 读它来决定鲸鱼色 ⇒ **改它不触发重渲染**，于是"状态栏变了、
   * 鲸鱼不变"（报告 7 观察到的现象）。顶栏底色 `topBarBg` 是 `@State` 所以跟着变，
   * 唯独鲸鱼不动——这正是"两个值一个响应式、一个不是"的典型症状。
   * 【为什么不直接复用 topBarBg 判明暗】语义不同：topBarBg 是"画什么底色"，
   * 这里是"当前主题是什么"。鲸鱼/三键等图形元素按主题取色，用专门的状态更清楚。
   */
  @State themeMode: string = '';
  /** 已应用到窗口的状态栏模式（幂等闸门；与 themeMode 分开是为了"设置失败可重试"） */
  private systemBarApplied: string = '';

  private controller: webview.WebviewController = new webview.WebviewController();
  /** DOM 探针定时器句柄；-1 = 未启动。跨阶段保留，aboutToDisappear 统一清理 */
  private probeTimerId: number = -1;
  /** 目录选择桥：见类头注释。构造即建（无副作用），getter 惰性取宿主上下文 */
  private dirPickerBridge: DshDirectoryPickerBridge =
    new DshDirectoryPickerBridge(() => this.getUIContext().getHostContext(), () => this.controller);
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
  };

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

  private startNativeCapture(): string {
    if (natPhase === 'recording') {
      return 'ok';
    }
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
        if (!granted) {
          natPhase = 'error:permission-denied';
          this.dirPickerBridge.writeDiagMarkerPublic('diag-native-error',
            '麦克风权限未授予，无法录音');
          return;
        }
        this.startNativeCaptureWithPermission();
      })
      .catch((e: BusinessError): void => {
        natPhase = 'error:' + e.code;
        this.dirPickerBridge.writeDiagMarkerPublic('diag-native-error',
          `权限检查异常 code=${e.code} msg=${e.message}`);
      });
    return 'ok';
  }

  /** 权限已确保后真正启动采集。 */
  private startNativeCaptureWithPermission(): void {
    audio.createAudioCapturer({
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
    } as audio.AudioCapturerOptions)
      .then(async (c: audio.AudioCapturer): Promise<void> => {
        natCap = c;
        c.on('readData', (buf: ArrayBuffer): void => {
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
        natPhase = 'recording';
        this.dirPickerBridge.writeDiagMarkerPublic('diag-native',
          '★ 官方按钮 → 原生采集已启动');
        hilog.info(DOMAIN, TAG, '原生听写：采集已启动');
      })
      .catch((e: BusinessError): void => {
        natCap = undefined;
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

  /** 取走采集结果（canonical WAV 的 base64，取走即重置）。 */
  /**
   * 延后停止并释放采集器（见 takeNativeCapture 的注释：javaScriptProxy 是同步契约）。
   *
   * @param cap 要释放的采集器
   */
  private stopAndReleaseLater(cap: audio.AudioCapturer): void {
    setTimeout((): void => {
      cap.stop().then((): void => {
        cap.release().catch(() => void 0);
      }, (): void => {
        cap.release().catch(() => void 0);
      });
    }, 300);
  }

  private takeNativeCapture(): string {
    const chunks: Uint8Array[] = natChunks;
    const total: number = natBytes;
    /*
     * 【必须在下面清零**之前**保存 peak】
     * 原实现把 `natPeak = 0` 放在前面，而诊断语句还要读它 ⇒ 永远报 peak=0，
     * 让人误判"录到的是静音"。真机证据：provider 侧收到同一份音频时 peak=28371。
     */
    const peak: number = natPeak;
    const cap: audio.AudioCapturer | undefined = natCap;
    natCap = undefined;
    natChunks = [];
    natBytes = 0;
    natPeak = 0;
    natRecent = 0;
    natRms = 0;
    natSumSq = 0;
    natSampleCount = 0;
    natPhase = 'idle';
    natStartedAt = 0;
    if (cap !== undefined) {
      /*
       * 【等停完再识别】已验证成功的「原生听写」用 `await c.stop(); await c.release();`；
       * 若不等释放就开始识别，采集与识别会争音频资源。
       * 但 javaScriptProxy 是**同步**契约（JS 侧要立即拿到 base64），故：
       * 先 off 回调（立即停收）→ 返回 → 延后停止并释放。
       */
      cap.off('readData');
      this.stopAndReleaseLater(cap);
    }
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
  /** javaScriptOnDocumentStart 注入清单：目录选择垫片 + 桌面载体 + 外观跟随（见各自注释） */
  private pickerShimScripts: Array<ScriptItem> = [
    { script: PICKER_SHIM_JS, scriptRules: ['*'] },
    { script: DESKTOP_CARRIER_JS, scriptRules: ['*'] },
    { script: THEME_SHIM_JS, scriptRules: ['*'] }
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
    // 覆盖「页面创建前 Host 已就绪」的时序：@StorageProp 初始化时就会拿到已发布的值
    if (this.launchUrl.length > 0) {
      this.enterLoading();
    }
    this.setupDecorAvoidance();
  }

  aboutToDisappear(): void {
    if (this.probeTimerId >= 0) {
      clearInterval(this.probeTimerId);
      this.probeTimerId = -1;
    }
    this.stopLoadTicker();
    this.clearAutoRetry();
    if (this.decorWin !== undefined) {
      try {
        this.decorWin.off('windowTitleButtonRectChange');
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
    }).catch((e: BusinessError) => {
      hilog.warn(DOMAIN, TAG, '取窗口失败，三键避让保持默认值：%{public}s', e.message);
    });
  }

  private applyDecorRect(rect: window.TitleButtonRect): void {
    this.decorPadRight = rect.width > 0 ? rect.width + 8 : 8;
  }

  /** 宿主重启后会带新 token 再次发布：Web 的 src 变化即触发重新加载 */
  private onLaunchUrlChanged(): void {
    if (this.launchUrl.length > 0) {
      this.enterLoading();
    }
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

  /** 自动重试的最大次数（超过后停在 ERROR，由用户手动点"重试"）。 */
  private static readonly AUTO_RETRY_MAX: number = 6;

  /**
   * 排入一次自动重试（指数退避）。
   *
   * 覆盖所有"时序性失败"：404（路由未就绪）、连接被拒（端口未监听）、
   * 401（宿主刚重启、token 换过）。这些在重试后都能自愈。
   */
  private scheduleAutoRetry(): void {
    if (this.autoRetryCount >= WebApp.AUTO_RETRY_MAX) {
      hilog.warn(DOMAIN, TAG, '自动重试已达上限（%{public}d 次），交给用户手动重试',
        this.autoRetryCount);
      return;
    }
    if (this.autoRetryTimer >= 0) {
      return; // 已排入，避免重复排
    }
    const delay: number = 600 * Math.pow(2, this.autoRetryCount);
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

  /** 系统返回键：优先走 web 内部后退栈，退无可退才交给系统（默认行为） */
  onBackPress(): boolean {
    try {
      if (this.controller.accessBackward()) {
        this.controller.backward();
        return true;
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '返回键处理异常：%{public}s', (e as Error).message);
    }
    return false;
  }











  /**
   * 探针回执 → 顶栏取色（2026-09-24："默认状态栏白底黑字"+跟随 dsh 主题翻转）。
   * result 是 runJavaScript 的序列化返回：探针表达式返回 JSON.stringify 字符串、
   * ArkWeb 回调再包一层 JSON 字符串——双层 parse。【容错】任何一步失败都保持
   * 现状（10s 探针周期重试），不影响渲染。
   */  private applyThemeFromProbe(result: string): void {
    try {
      let inner: Object = JSON.parse(result) as Object;
      if (typeof inner === 'string') {
        inner = JSON.parse(inner as string) as Object;
      }
      const report = inner as Record<string, Object>;
      const bg = report['gbg'] as string;
      if (bg === null || bg === undefined || bg.length === 0) {
        return; // 页面还没渲染出 body（启动早期）：保持默认
      }
      // rgb(r,g,b) / rgba(r,g,b,a) → 三个通道。官方 boot CSS 保证 body 背景非透明
      //（浅 #fff / 深 #151517）。
      const m = bg.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (m === null) {
        return;
      }
      const r = parseInt(m[1], 10);
      const gCh = parseInt(m[2], 10);
      const b = parseInt(m[3], 10);
      // 明暗判定：官方语义标记 body[data-ds-dark-theme] 优先；缺失时亮度兜底
      const darkAttr = report['gdk'] as boolean;
      const dark = darkAttr !== null && darkAttr !== undefined
        ? darkAttr
        : (0.299 * r + 0.587 * gCh + 0.114 * b) < 128;
      this.applyTopBarTheme(r, gCh, b, dark);
    } catch (e) {
      // 解析失败保持现状；下一轮探针重试
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
  private applySystemBarTheme(mode: string): void {
    if (this.systemBarApplied === mode) {
      return; // 幂等：同一个模式不重复设（web 侧已做过变化判断，这里是第二道闸）
    }
    this.systemBarApplied = mode;
    this.themeMode = mode; // @State：鲸鱼/三键等图形元素据此取色（见字段注释）
    const bg: string = mode === 'dark' ? '#151517' : '#FFFFFF';
    const lightIcon: boolean = mode === 'dark';
    const contentColor: string = mode === 'dark' ? '#FFFFFF' : '#0F1115';
    // 顶栏（自绘）也随之翻转：官方外观是浅色→白底黑字，深色→黑底白字。
    // 【注意】这与"顶栏恒定白底黑字"的旧口径不同：报告 5 要求的是**跟随外观**，
    // 故这里按 mode 同时更新自绘顶栏，保证状态栏与顶栏不会是两种观感。
    this.topBarBg = bg;
    this.topBarFg = contentColor;
    if (this.decorWin === undefined) {
      hilog.info(DOMAIN, TAG, '状态栏跟随外观：%{public}s（窗口未就绪，下次重试）', mode);
      return;
    }
    try {
      this.decorWin.setWindowSystemBarProperties({
        statusBarColor: bg,
        statusBarContentColor: contentColor,
        isStatusBarLightIcon: lightIcon
      });
      hilog.info(DOMAIN, TAG, '状态栏已跟随外观：%{public}s bg=%{public}s', mode, bg);
    } catch (e) {
      const err = e as BusinessError;
      hilog.warn(DOMAIN, TAG, '状态栏配色设置失败（全屏等场景属正常）code=%{public}d msg=%{public}s',
        err.code, err.message);
      this.systemBarApplied = ''; // 允许下次再试（例如窗口后来才就绪）
      return;
    }
    try {
      this.decorWin.setWindowBackgroundColor(bg);
    } catch (e) {
      // 窗口底色失败不影响状态栏本身；闪白风险由"下次成功时再设"覆盖
      hilog.debug(DOMAIN, TAG, '窗口底色设置失败（忽略）');
    }
  }

  /** 顶栏底色/文字色 + 三键 colorMode：**始终白底黑字**（2026-09-26 用户验收：
   * 深色底观感不佳，回到白底黑字；不随 dsh 主题翻转）。探针读出的 body 背景色/明暗
   * 只用于日志参考，不再决定顶栏配色；三键 colorMode 恒为 LIGHT（浅底深键），
   * 保证白底顶栏上三键可见。
   * 【2026-09-26 起改为"跟随外观"（报告 5 §2.2）】此前这里是"恒定白底黑字"。现在
   * 顶栏与状态栏一起跟随「设置→外观」：探针读到的明暗作为**兜底判据**（THEME_SHIM_JS
   * 是主通道，见其注释——它靠 MutationObserver/matchMedia 即时触发；探针每 10s 一轮，
   * 保证"桥万一没装上"也能最终收敛）。两者都调 applySystemBarTheme(mode)，靠它内部的
   * 幂等闸门去重，不会来回抖动。
   */
  private applyTopBarTheme(r: number, g: number, b: number, dark: boolean): void {
    const mode: string = dark ? 'dark' : 'light';
    hilog.info(DOMAIN, TAG, '外观（探针兜底）：page_bg=%{public}s dark=%{public}s → %{public}s',
      '#' + [r, g, b].map((v: number): string => v.toString(16).padStart(2, '0')).join(''),
      String(dark), mode);
    this.applySystemBarTheme(mode);
    // 三键跟随：浅底深键 / 深底浅键（与状态栏内容色同一套明暗）
    if (this.decorWin !== undefined) {
      try {
        this.decorWin.setDecorButtonStyle({
          colorMode: dark
            ? ConfigurationConstant.ColorMode.COLOR_MODE_DARK
            : ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT
        });
      } catch (e) {
        // 手机全屏（无窗口装饰）等场景：忽略
      }
    }
  }

  // ── 启动加载页品牌动效 ────────────────────────────────────────────────
  // mark 淡入（640ms Friction，延迟 80ms）→ 常驻呼吸（1800ms EaseInOut 往返，
  // 延迟 720ms）；进度条 220ms 一格、+3 循环。幂等：ticker 已在跑则只补动画。
  private startBrandAnimation(): void {
    animateTo({ duration: 640, curve: Curve.Friction, delay: 80 }, () => {
      this.brandOpacity = 1;
    });
    animateTo({
      duration: 1800,
      curve: Curve.EaseInOut,
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

  // ── 顶栏菜单动作 ──────────────────────────────────────────────────────
  // 【菜单结构（2026-09-21 品牌对齐）】「DSHM」应用菜单保留对 Host 壳层有意义的
  // 三个动作（主页/刷新/关于版本）；「编辑」菜单与官方桌面版逐项看齐
  //（撤销/重做/剪切/复制/粘贴/删除/全选）。「窗口」菜单仍不搬：平板端无窗口
  // 管理概念，最小化/关闭由系统手势承担。

  /** 回到 Host web UI 首页（整页重载带 token 的启动 URL）。 */
  private goHome(): void {
    if (this.launchUrl.length === 0 || this.phase === WebPhase.BOOTING) {
      return; // Web 未挂载（controller 不可用），点了就忽略
    }
    try {
      this.controller.loadUrl(this.launchUrl);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '主页导航失败：%{public}s', (e as Error).message);
    }
  }

  /** 刷新当前页面（等价浏览器刷新，保留 controller 与登录态）。 */
  private refreshView(): void {
    if (this.launchUrl.length === 0 || this.phase === WebPhase.BOOTING) {
      return;
    }
    try {
      this.controller.refresh();
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '刷新失败：%{public}s', (e as Error).message);
    }
  }

  /** 关于版本（2026-09-21 品牌对齐）：直接显示当前运行的 dsh 核心版本 + 壳层事实。 */
  private aboutVersions(): void {
    const endpoint: string = this.launchUrl.length > 0 ? this.baseOfLaunchUrl() : '（核心未就绪）';
    this.getUIContext().showAlertDialog({
      title: 'DSHM',
      message: `dsh 版本：${this.dshCoreVersion()}\n本地核心端点：${endpoint}\n页面阶段：${this.phase}`,
      confirm: {
        value: '知道了',
        action: (): void => {
          // 空实现即全部行为：AlertDialog 的确认按钮点击后自动关闭弹窗（dead-handlers 审计至此可止）
        }
      }
    });
  }

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
   * 编辑菜单动作统一入口：把 execCommand 派发给 web 里当前聚焦的可编辑目标。
   * 【机制】官方桌面（Electron）的编辑菜单操作 webContents；端侧等价物是
   * runJavaScript 派发 document.execCommand——撤销/重做/剪切/复制/删除/全选
   * 在 ArkWeb（chromium 内核）里均可用，作用于当前焦点元素；焦点不在可编辑区
   * 时命令静默无效（与桌面行为一致）。
   * 【粘贴为什么单独走】chromium 出于安全禁用 execCommand('paste')——桌面
   * Electron 的粘贴是主进程读系统剪贴板再写入 webContents；端侧等价物 =
   * 系统剪贴板（@ohos.pasteboard）读取后 execCommand('insertText') 注入。
   */
  private runEditCommand(cmd: string): void {
    if (this.phase === WebPhase.BOOTING) {
      return;
    }
    try {
      this.controller.runJavaScript(`document.execCommand('${cmd}')`);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '编辑命令 %{public}s 派发失败：%{public}s', cmd, (e as Error).message);
    }
  }

  /** 粘贴：读系统剪贴板 → 注入 web 当前焦点处（见 runEditCommand 的机制说明）。 */
  private pasteFromClipboard(): void {
    if (this.phase === WebPhase.BOOTING) {
      return;
    }
    try {
      const board: pasteboard.SystemPasteboard = pasteboard.getSystemPasteboard();
      board.getData().then((data: pasteboard.PasteData) => {
        const text: string | undefined = data.getPrimaryText();
        if (text === undefined || text.length === 0) {
          return; // 空剪贴板：与桌面「粘贴无内容」一致，静默
        }
        // JSON.stringify 把任意文本（引号/换行/反斜杠）编码成安全 JS 字面量
        const js: string = `document.execCommand('insertText', false, ${JSON.stringify(text)})`;
        this.controller.runJavaScript(js);
      }, (e: BusinessError) => {
        hilog.warn(DOMAIN, TAG, '剪贴板读取失败：code=%{public}d msg=%{public}s', e.code, e.message);
      });
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '粘贴异常：%{public}s', (e as Error).message);
    }
  }

  /** 「DSHM」应用菜单（bindMenu 数据）：主页/刷新/关于版本。 */
  private appMenu(): Array<MenuElement> {
    const items: Array<MenuElement> = [
      { value: '主页', action: (): void => {
        this.goHome();
      } },
      { value: '刷新', action: (): void => {
        this.refreshView();
      } },
      { value: '关于版本', action: (): void => {
        this.aboutVersions();
      } },
      /*
       * 语音可行性最小验证的入口（2026-09-26）。
       * 【为什么放菜单而不是自动跑】自检会弹系统麦克风授权框；语音默认关闭，
       * 不该让没用语音的人被打扰。放菜单 = 用户明确点才跑一次。
       * 【为什么需要它】官方语音 UI 的麦克风按钮被 provider 就绪状态门住
       */
      /*
       * 路线 A（HMS 系统语音识别）可行性自检（2026-09-26）。
       * 【为什么要先自检】设备声明了 SystemCapability.AI.SpeechRecognizer，但
       * "能力存在" ≠ "第三方应用能 createEngine"（可能因签名/商用限制抛 1002200001）。
       * 先只验链路（不接 UI、不需真实语音），失败也能立刻定位到具体阶段。
       * 【为什么独立于「麦克风自检」】后者验"WebView 能否拿到麦克风"（已通过）；
       * 本项验"ArkTS 侧能否驱动系统识别引擎"。两件事互不依赖。
       */
      /*
       * 路线 A **端到端**自检（2026-09-26）：真麦克风 → HMS → 文本。
       * 上一个自检用合成音只验"能不能驱动引擎"；本项验"能否真的把语音变成文字"，
       * 是路线 A 可行性的最终判据。点完有 4 秒说话窗口。
       */
      /*
       * 重放自检：把官方按钮那次录的音频原样再喂一遍 HMS。
       * 【为什么它最关键】它只改"投喂者"这一个变量、音频字节完全相同，
       * 从而把"音频坏了"与"投喂路径错了"分开 —— 见 runReplayProbe 注释。
       */
      /*
       * 截短重放自检：同一份音频按 3/4/5/6 秒分别喂 HMS，判定"时长"是否根因。
       * 【为什么要它】两条采音路径与录音时长完全共线，导致"路径差异"的
       * 归因从未被证实；本实验只改长度这一个变量 —— 见 runTruncateProbe 注释。
       */
      /*
       * 同时同源对照：一次点击，同一路麦克风用两条链各录一份（A=MediaRecorder
       * 复刻官方链，B=ScriptProcessor 直取 PCM），两份都喂 HMS。
       * 【为什么最关键】Windows 端正常、ArkWeb 端不正常 ⇒ 差异在 ArkWeb 的 web 采音实现。
       */
      /*
       * 关 AEC 对照：两路都 ScriptProcessor 直取（绕开编解码），只差
       * echoCancellation 一个开关。用来定"是不是 AEC 破坏了音频"。
       */
      /*
       * 路线 A 落地点的探针：能否把文本插入官方对话输入框。
       * 插入得进 ⇒ 原生录音 UI + HMS 的形态成立；插不进 ⇒ 需另做原生输入界面。
       */

      /*
       * 路线 A 的**自证**自检：系统 TTS 合成一句话 → 喂给 HMS 识别 → 比对文本。
       * 【为什么最关键】它不需要用户说话、不需要麦克风，就能回答
       * "HMS 识别真实语音能否出文本" —— 这是路线 A 值不值得做的唯一判据。
       */
    ];
    return items;
  }

  /** 「编辑」菜单（bindMenu 数据）：与官方 DSHM 桌面版编辑菜单逐项看齐。 */
  private editMenu(): Array<MenuElement> {
    const items: Array<MenuElement> = [
      { value: '撤销', action: (): void => {
        this.runEditCommand('undo');
      } },
      { value: '重做', action: (): void => {
        this.runEditCommand('redo');
      } },
      { value: '剪切', action: (): void => {
        this.runEditCommand('cut');
      } },
      { value: '复制', action: (): void => {
        this.runEditCommand('copy');
      } },
      { value: '粘贴', action: (): void => {
        this.pasteFromClipboard();
      } },
      { value: '删除', action: (): void => {
        this.runEditCommand('delete');
      } },
      { value: '全选', action: (): void => {
        this.runEditCommand('selectAll');
      } }
    ];
    return items;
  }

  /** 菜单标题项：点击弹出下拉菜单（bindMenu）。颜色取顶栏前景色（跟随外观）。 */
  @Builder
  MenuTitle(text: string, items: Array<MenuElement>) {
    Text(text)
      .fontSize(12) // token-exempt: DSHM 桌面版顶栏菜单的像素级复刻（D23），刻意不用 Harmony 令牌
      .fontColor(this.topBarFgNow()) // token-exempt: 顶栏前景色跟随外观（light/dark）
      .padding({ left: 5, right: 5, top: 1, bottom: 1 })
      .borderRadius(3) // token-exempt: DSHM 桌面版菜单 hover 圆角（D23）
      .bindMenu(items)
      .onClick(() => {
        // bindMenu 点击弹出；空实现让整个文本区可点
      })
  }

  /** 品牌标识动画属性：启动页大标识（官方 logo_dark）呼吸/淡入，顶栏小鲸鱼恒为静态。 */
  private markScale(animated: boolean): ScaleOptions {
    return animated ? { x: this.brandBreath, y: this.brandBreath } : { x: 1, y: 1 };
  }

  private markOpacity(animated: boolean): number {
    return animated ? this.brandOpacity : 1;
  }

  /**
   * 官方鲸鱼标识 —— **用官方 SVG 素材 + `Image.fillColor` 着色**（2026-09-25 用户决定）。
   *
   * 【为什么从"Shape 自绘"改成"SVG 资源 + Image"】
   * 用户反复报「歪」。用 `uitest dumpLayout` 拿到**权威组件盒**后定位到真因：
   *   组件盒 x[374..416] w=42px, y[390..421] h=31px（比例 1.355 ≈ 官方 1.359 ✓ 盒子是对的）
   *   盒内墨迹 x[374..398] w=25px, y[391..408] h=18px
   *   左留白 0px / 右留白 18px  ⇒ **鲸鱼贴在盒子左上角，只占 ~60%**
   * 即 `Shape.viewPort` 并没有把路径缩放进组件盒（1 用户单位 ≈ 1 物理像素地画在左上）。
   * 用官方 SVG + `Image` 后，**等比缩放由图片组件负责**（`objectFit`），
   * 不再依赖 `Shape.viewPort` 的缩放语义——这正是"用官方素材"能根治的原因。
   *
   * 【着色口径】`Image.fillColor` 对单色 SVG 是**整体重着色**（把非透明像素统一替换），
   * 等价于官方 Web 层的 `fill: currentColor`。色值由 `fishMarkColor()` 按主题给出。
   *
   * 【为什么不再需要"墨迹包围盒"】那是基于一个**错误前提**（"墨迹溢出官方 viewBox"）。
   * 实测：把路径曲线离散成 400 点/条采样后，真实紧包围盒 = x 0.0000 w 23.1600 h 17.0434，
   * **恰好等于官方 viewBox**（零溢出）。所以直接用官方 viewBox 即可。
   *
   * 【参数】size = 鲸鱼宽度（vp）；animated = 是否绑定呼吸/淡入动画。
   */
  @Builder
  FishMark(size: number, animated: boolean) {
    Image($r('app.media.fish_logo'))
      .width(size)
      .height(size * FISH_LOGO_VIEWBOX_H / FISH_LOGO_VIEWBOX_W)
      // 等比放进给定盒；盒的比例已按官方 23.16:17.04 算好，故 Contain 不会留边
      .objectFit(ImageFit.Contain)
      .fillColor(this.fishMarkColor()) // token-exempt: 鲸鱼色跟随外观（浅底深鲸/深底白鲸）
      .interpolation(ImageInterpolation.High) // 缩小渲染时抗锯齿更好（避免边缘模糊）
      // 【光学微调（报告 7 §4）】官方 `.brandIdentity { transform: translateY(1px) }`：
      // 鲸鱼墨迹重心略偏上，纯几何居中看起来会"浮"，官方因此下移 1px。
      .translate({ y: FISH_MARK_OPTICAL_Y })
      .scale(this.markScale(animated))
      .opacity(this.markOpacity(animated))
  }

  /**
   * 顶栏底色 / 前景色 / 鲸鱼色：**跟随「设置→外观」**（报告 5 §2.2）。
   *
   * 【为什么不直接返回常量】2026-09-26 先要求黑底白字、又要求回白底黑字，报告 5
   * 进一步要求**跟随外观**。现在三者都由 `topBarBg`（由 applySystemBarTheme 按
   * light/dark 更新）派生，保证顶栏与状态栏是同一套观感、不会一半白一半黑。
   * 【鲸鱼色为什么不复用 topBarFgNow】顶栏字用 #0F1115，而鲸鱼在深色底上要更亮的
   * 白（#FFFFFF）。两者语义不同（文字 vs 图形），故分开取。
   */
  private topBarBgNow(): string {
    return this.topBarBg;
  }

  private topBarFgNow(): string {
    return this.topBarFg;
  }

  /**
   * 顶栏鲸鱼填充色：跟随「设置→外观」（等价官方 Web 层的 `currentColor`）。
   *
   * 【读 @State themeMode 而不是 systemBarApplied】报告 7 §4 的根因就是"读到的是
   * 非响应式字段"——普通字段变更不会触发重渲染，于是鲸鱼色永远停在初值。
   * 【初值为什么是深色】themeMode 为空串（尚未确定）时按浅色主题处理：与官方 boot
   * 的 `:root{color-scheme:light}` + `#fff` 一致，避免启动瞬间反色。
   */
  private fishMarkColor(): string {
    return this.themeMode === 'dark' ? '#FFFFFF' : '#151517';
  }

  /**
   * 自绘顶栏：**官方鲸鱼标识** + 两组菜单（应用菜单/编辑菜单），配色跟随「设置→外观」。
   * 此前左上角的「DeepSeek Harness」文字字标已按用户要求替换为官方鲸鱼标识（FishMark）。
   *
   * 【三键对比度】三键 colorMode 随明暗切换（浅底深键 / 深底浅键），见 applyTopBarTheme。
   * 【为什么必须不透明实色】半透明底会让文字与图标对比度崩溃
   * （DSHM 2026-09-12 实测教训），深浅同理都必须实色。
   * 本顶栏顶到窗口第一行（setWindowDecorVisible 隐藏系统标题栏），
   * right 动态避让三键区。
   */
  @Builder
  TopBar() {
    Row() {
      /*
       * 【ArkUI 约束】@Builder 调用返回 void，不能链属性修饰 ⇒ margin/height 放外层容器。
       *
       * 【2026-09-25 用户裁决 B：完全按官方规格】此前是「26vp + 右移 18.2vp」，
       * 现按报告给的官方几何：
       *   宽 24vp（FishLogo 默认 size=24）、高按 23.16:17.04 等比（≈17.66vp）、
       *   与右侧文字的间距 8vp（官方 `.brand { gap: 8px }`）、**不额外右移**、
       *   品牌块内容高 24vp（官方 `.brand { height: 24px }`）、垂直居中。
       */
      Column() {
        this.FishMark(FISH_MARK_SIZE, false)
      }
      .height(FISH_MARK_SIZE)
      .justifyContent(FlexAlign.Center)
      .margin({ right: FISH_MARK_GAP })
      this.MenuTitle('应用', this.appMenu())
      this.MenuTitle('编辑', this.editMenu())
      Blank()
    }
    .width('100%')
    .height(TOP_BAR_HEIGHT)
    // right 动态避让自由窗口右上角三键（全屏模式退回 8vp 默认）
    .padding({ left: 10, right: this.decorPadRight })
    .backgroundColor(this.topBarBgNow()) // token-exempt: 顶栏底色跟随外观（light/dark）
    .alignItems(VerticalAlign.Center)
  }

  build() {
    Column() {
      this.TopBar()
      Stack() {
      // Web 放最底层：ERROR 时也不卸载（保持 controller 可用，重试走 refresh）
      if (this.phase !== WebPhase.BOOTING) {
        Web({ src: this.launchUrl, controller: this.controller })
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
            methodList: ['startPick', 'onThemeMode', 'startNativeCapture', 'nativeCaptureState', 'takeNativeCapture'],
            controller: this.controller
          })          // 官方 web UI 自己按 prefers-color-scheme 适配暗色：跟随系统、不强制反色
          .darkMode(WebDarkMode.Auto)
          .forceDarkAccess(false)
          .onPageBegin(() => {
            // 整页导航（含 303 后的落地）重新进入加载期；SPA 内部路由不受影响
            if (this.phase === WebPhase.READY) {
              this.phase = WebPhase.LOADING;
            }
          })
          .onPageEnd(() => {
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
          .onConsole((event?: OnConsoleEvent) => {
            if (event === undefined) {
              return false;
            }
            const msg: ConsoleMessage = event.message;
            hilog.info(DOMAIN, TAG, '[web] %{public}s:%{public}d %{public}s %{public}s',
              msg.getSource(), msg.getLineNumber(),
              msg.getMessageLevel(), msg.getMessage());
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
          .width('100%')
          .height('100%')
      }

      // 启动等待画面（BOOTING **与 LOADING**）：鲸鱼标识（透明底黑鲸，与 FISH_LOGO_PATH
      // 同源）淡入后进入常驻呼吸循环，线性进度条推进，直到就绪/失败。
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
            .color('#1c2430')
            .backgroundColor('#e4e7ec') // token-exempt: 启动页进度条底色（D23），与顶栏描边同值
            .margin({ top: 40 })
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
        .backgroundColor('#F3F7FB') // token-exempt: 品牌启动页底色（D23），像素级复刻
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
      }
      }
      .layoutWeight(1)
      .width('100%')
    }
    .width('100%')
    .height('100%')
  }
}
