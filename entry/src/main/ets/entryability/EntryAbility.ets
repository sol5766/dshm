/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 应用唯一的 UIAbility：既承载主窗，也承载每一个会话窗（D1 §7.7.5 / §7.7.5b）。
 *
 * 实例模型（与 platform/window/WindowRegistry.ets 的文件头注释配套阅读）：
 *   module.json5 里 launchType = specified，配合 AppAbilityStage.onAcceptWant 的 key 方案，
 *   得到「一个会话一个实例、其余一切复用同一个主实例」。**所有实例同进程**，所以
 *   appstate 的模块级单例（连接池 / 会话状态机 / 待发队列）天然被所有窗口共享——
 *   这是 §7.7.5b 验收点「开 3 个窗口仍只有 1 条 mux 连接、1 条 $events」的实现基础。
 *   本文件因此**不做任何连接或会话状态**：窗口只是视图，这不是自律，而是分层的硬边界。
 *
 * 本文件负责四件事：
 *   1. 启动参数 → AppStorage（能力层与页面之间的约定交接通道，见 applyLaunchParams）；
 *   2. 窗口台账登记/注销（RuntimeSingleton 是「一个共享运行时而共享单例」的证据面，
 *      登记必须准确，宁可日志报警也不要漏登记）；
 *   3. 窗口记忆（仅主窗）：几何恢复与节流落盘；
 *   4. 窗口生命周期里**只清理本实例自己的东西**——关任一窗口不得影响其他窗口。
 */

import { AbilityConstant, bundleManager, common, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { BusinessError, deviceInfo } from '@kit.BasicServicesKit';
import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { commonEventManager } from '@kit.BasicServicesKit';
import { appRecovery } from '@kit.AbilityKit';
import { process } from '@kit.ArkTS';
import { http } from '@kit.NetworkKit';
import fs from '@ohos.file.fs';

import { DshHost, NodeRuntime, probeNativeBindings, resolveHostDataDir, resolveHostModulePaths } from 'hostruntime';
import { preverifyBundledCore } from 'hostruntime';
import type { BundledCoreVerification, HostModulePaths, HostStartResult, OpResult } from 'hostruntime';
// HMS 语音识别桥（ArkTS 侧）：轮询 Host 写的请求文件并调 speechRecognizer
import { startHmsSpeechBridge, requestSpeechProbe } from '../speech/HmsSpeechBridge';
// 外开桥（ArkTS 侧）：轮询 Host 写的请求文件并调 openLink —— browser 工具在浏览器未启动时
// 经它拉起浏览器（与登录"外开授权页"同一条系统路径，见 ../system/OpenLinkBridge.ets 头注）
import { startOpenLinkBridge } from '../system/OpenLinkBridge';
import { DESKTOP_PROGRESSIVE_STARTUP, DesktopHostStartupStage, KEY_DESKTOP_HOST_STARTUP,
  DESKTOP_WORKBENCH_PAINTED_EVENT, StartupFrameCallback } from '../common/DesktopStartup';
// 桌面卡片推送器（docs/178）：轮询宿主写出的 card-state.json → formProvider.updateForm
import { startCardStateWatcher } from '../system/CardStateWatcher';
// 系统托盘（PC 顶栏 / 托盘区状态图标）：运行时挂图标 + 左键唤回主窗（退出用系统自带菜单项）
import { StatusBarTray } from '../system/StatusBarTray';
import { KnockShareReceiver } from '../system/KnockShareReceiver';
import { emitter } from '@kit.BasicServicesKit';
import { window } from '@kit.ArkUI';
import {
  applyThemeMode,
  EVENT_HOST_CONNECTED,
  EVENT_KEY_HOST_TOKEN,
  EVENT_KEY_HOST_URL,
  followScreenRotationOnHandheld,
  applyFoldableOrientation,
  releaseFoldableOrientation,
  HostStore,
  isHandheldForm,
  FormFactor,
  KeepAlive,
  KEY_THEME_MODE,
  LocalPrefs,
  NotificationCenter,
  parseWindowParams,
  readDeviceFacts,
  registerWindow,
  relabelWindow,
  restoreFolderGrants,
  SecretLoadState,
  ThemeMode,
  unregisterWindow,
  windowCount,
  WindowKind,
  WindowMemory,
  WindowParams,
  windowChromeFor,
  statusBarOwnedByApp,
  SYSTEM_BAR_HANDOFF_BG,
  StartupPhase,
  startupMarks,
} from 'platform';
import type { NotificationDraft, RememberedHost, RememberedToken } from 'platform';
import { assertNoSensitiveContent, notificationFor, SessionHub } from 'appstate';
import type { NotifyHooks, NotifyInput } from 'appstate';


const DOMAIN = 0x0000;
/** 本文件新增日志的 tag；既有日志沿用 'testTag' 不动，避免无意义的 diff 噪音 */
const TAG: string = 'entry/ability';

/**
 * 当前是否为**普通平板**形态（手机 / 折叠屏 / PC / 2in1 都不算）。
 *
 * 只给「平板沉浸式状态栏」用：手机在 phone 壳里有自己的状态栏策略，PC/2in1 由
 * 自绘顶栏 + 系统三键负责，两者都不许被这条改动碰到。读失败按 false（保守方向）。
 */
function isTabletDevice(): boolean {
  try {
    return readDeviceFacts().form === FormFactor.TABLET;
  } catch (e) {
    return false;
  }
}

/** 本应用身份：整机冷启动的 Want 要用它构造，与 AppScope/app.json5 保持一致（同 StatusBarTray 的写法） */
const BUNDLE_NAME: string = 'com.dshm.dshclient';
/** 整机冷启动后要拉起的 ability（见 module.json5 的 abilities 段） */
const ENTRY_ABILITY_NAME: string = 'EntryAbility';
/** DeepSeek 账号授权完成页回到原生客户端的固定 URI。 */
const AUTH_RETURN_URI: string = 'dsh://open';
/**
 * 「整机冷启动」的兜底等待窗口（ms）。
 *
 * 【为什么需要这个兜底】就算把平台的前置开关补上（见 AppAbilityStage.onCreate），
 * appRecovery.restartApp() 仍有三条**静默什么都不做**的路：
 *   ① 没调过 enableAppRecovery() ⇒ 平台内部直接 return false（不抛异常）——已补开关；
 *   ② 1 分钟限流：两次重启间隔 ≤ 1 分钟 ⇒ 只退出不重启；
 *   ③ 调用时**没有前台 ability** ⇒ 平台谁也不起。
 * 无论哪条，都不能把 App 留在「Host 已死、界面全灰」的死态。超过这个窗口进程还在，
 * 就走已验证的干净退出（exitApp），用户重开一次即生效。冷启动真生效时进程直接消失，
 * 这个定时器永远没机会触发。
 * 【为什么是 5 s 而不是 3 s】要给平台「杀进程 → 拉起新实例」留出余量，
 * 免得我们的兜底退出与它抢同一个进程。
 */
const RESTART_FALLBACK_MS: number = 5000;

/**
 * 冷启动监视器是否已挂（报告 4 ②）。
 *
 * 【为什么是模块级而不是实例字段】`launchType = specified` 下同一个 UIAbility 会被
 * 反复复用/重建（多窗），实例字段每建一次都会是 false ⇒ 挂出多个 1.5s 轮询、
 * 且可能对同一个 host-exit-mode 并发触发多次冷启动。模块级只挂一个。
 */
let restartWatcherStarted: boolean = false;

/**
 * ArkWeb 引擎是否已预热（2026-11-15 冷启动优化）。
 *
 * 【为什么是模块级】`initializeWebEngine()` 是**全局静态**能力，SDK 明文：
 * "takes effect globally and needs to be called only once in an application lifecycle"。
 * 本应用在 `launchType = specified` 下有多个 UIAbility 实例（会话窗），实例字段会让
 * 每个窗各调一次 —— 真正的热路径只需要第一次。
 */
let webEngineWarmed: boolean = false;

/** 窗口几何落盘的最小间隔（ms）。拖动窗口会以帧级频率触发几何变化，直写会打爆 preferences。 */
const GEOMETRY_SAVE_INTERVAL_MS: number = 500;

/**
 * 宿主启动链（取核心 → 起 Host）在**首帧之后**延迟多久再跑（毫秒）。
 *
 * 【为什么要有这个延迟】`loadContent` 的回调只保证"页面树建好了"，首帧渲染提交还在其后
 * 一两帧里；而这条链的第一跳 `runtime.probe()` 之后紧接着就是建树/解包的**同步段**，
 * 一旦抢在首帧前执行，AGC 的「启动加载完成快」就会被拖长（`docs/146` 实测 9039 ms / 目标 4000 ms）。
 *
 * 【2026-11-15：400 → 32 ms】400 ms 是旧机型上"首帧 + 余量"的经验值，`loadContent` 回调本身
 * 已经是首帧提交之后的证据点（实测 PC Beta：`Succeeded in loading the content` 到
 * `loadContent 回调到达` 在同一毫秒）。再压 368 ms 只是让用户更早看到宿主开始启动，
 * 排序（首帧 → 宿主链）不变，真正的同步段仍排在首帧之后。与 phone 壳的 32 ms 对齐。
 */
const HOST_START_DELAY_AFTER_FIRST_FRAME_MS: number = 32;

/**
 * 启动参数经 AppStorage 交给页面的键。
 *
 * 这是**跨 workstream 的契约**：键名一旦定下，能力层与页面两侧都不得各改各的。
 */
const KEY_LAUNCH_KIND: string = 'dshLaunchKind';
const KEY_LAUNCH_SESSION_ID: string = 'dshLaunchSessionId';
const KEY_LAUNCH_TITLE: string = 'dshLaunchTitle';
const KEY_LAUNCH_ROUTE_JSON: string = 'dshLaunchRouteJson';
/** 桌面快捷方式动作 id（`shortcuts_config.json` → want.parameters `dshAction`） */
const KEY_LAUNCH_ACTION: string = 'dshLaunchAction';
/**
 * 主窗 id 经 AppStorage 交给页面的键（仅 MAIN 分支发布，见 afterWindowStageReady）。
 *
 * 页面侧拿不到 windowStage（getMainWindowSync 是 WindowStage 的方法），只能
 * `window.getLastWindow(ctx)`（极端时序下可能拿到别的窗口）；碰一碰等以 windowId
 * 注册的系统能力（docs/418）需要「主窗 id vs getLastWindow id」对比来排除拿错窗口。
 */
const KEY_MAIN_WINDOW_ID: string = 'dshMainWindowId';
/**
 * 「由启动参数直接提供 Host」的两个键（`aa start --ps dshHost … --ps dshToken …`）。
 *
 * 用途：**开发期与自动化验收不需要手填地址与令牌**。
 * `tools/dev-host.mjs` 在自己这里起 dsh 核心（本项目持有该进程），
 * 拿到它打印的地址与令牌后随 `aa start` 一起传进来。
 */
const KEY_LAUNCH_HOST: string = 'dshHost';
const KEY_LAUNCH_TOKEN: string = 'dshToken';
/** 本机偏好「主题模式」经 AppStorage 交给页面的键（页面据此渲染当前值并写回） */
const KEY_THEME_APPLIED: string = 'dshThemeApplied';
/**
 * 「上次连上的 Host」经 AppStorage 交给页面的键。
 *
 * 为什么走这条通道而不是让页面自己去读存储：`HostStore` 需要
 * `UIAbilityContext` 才能打开偏好库，而页面拿不到 context；
 * 能力层本来就持有 context，顺手读完再交给页面是唯一不需要页面持有 context 的做法。
 *
 * 三个键对应三种**不同的**处置，不能合成一个字符串：
 *   - `HOST_URL` 非空 → 可以自动重连；
 *   - `HOST_TOKEN_STATE` = `'absent'` → 首次使用，提示粘贴 token；
 *   - `HOST_TOKEN_STATE` = `'unavailable'` → **有记录但读不到**（锁屏策略/系统故障），
 *     此时提示「重新粘贴 token」是错的——token 还在，只是这次读不出来。
 *     D3 §4 要求文案指出「发生了什么 + 可以做什么」，这两种情况的可做之事不同。
 */
const KEY_HOST_URL: string = 'dshLastHostUrl';
/** 内置核心正在解包（跨实例广播，见 autoStartHostForDiagnosis 的说明） */
const KEY_CORE_INSTALLING: string = 'dshm.core.installing';
const KEY_HOST_TOKEN: string = 'dshLastHostToken';
const KEY_HOST_TOKEN_STATE: string = 'dshLastHostTokenState';
const KEY_HOST_AUTOCONNECT: string = 'dshHostAutoConnect';
/**
 * Web 壳页（pages/WebApp）要加载的**完整**启动 URL（含 token）。
 *
 * 【为什么与上面那组键分开】dshLastHost* 是「记住的 Host」语义，token 对**本次进程**
 * 可能是旧的（dsh 每次启动换 token）；而本键只在「本次 Host 启动成功」
 * （adoptLocalHost，由 host.start() 的 then 触发）或「启动参数显式给出」
 * （applyHostLaunchParams）后才发布——消费方拿到的 token 一定有效，
 * 不需要 401 重试循环去猜时机。
 */
const KEY_HOST_LAUNCH_URL: string = 'dshHostLaunchUrl';
const KEY_HOST_BOOT_ERROR: string = 'dshHostBootError';
/**
 * 无 token 启动 URL 的**补票窗口**（2026-10-14 冷启动 401 的兜底）。
 *
 * 【为什么需要】`NodeRuntime.start()` 已经把 host-ready.json 的等待预算放宽到 15 s
 * （见那边的 AUTH_URL_RETRY），正常情况下 token 一定跟着句柄一起来。但那条链一旦
 * 真的超时，句柄里就只有**无 token** 的基址；把它当启动 URL 发布出去，Web 壳页
 * 会一直对着同一个无 token 地址重试，Host 的 browser-trust fence 恒定回 401
 * （用户看到的「host 拒绝了本次令牌 401」）。所以这里再补一层：**没 token 就不发布
 * 启动 URL**，按一拍一秒重读 host-ready.json（pid 守卫只认本次进程），读到再走正常发布。
 * 窗口取 15 s × 1 s：覆盖"文件落盘比预期更慢"的尾部；用尽才退回旧的降级行为。
 */
const TOKEN_REFILL_RETRY: number = 15;
const TOKEN_REFILL_INTERVAL_MS: number = 1000;
/**
 * 宿主启动的**恢复窗口**（2026-11-10，冷启动误报「连不上核心」的直接修复）。
 *
 * 【事故】`NodeRuntime.start()` 的端口预算到点抛错时，宿主进程其实**还在启动**
 * （日志：报错后约 6 秒 `SERVER-LISTENING` 才出现，然后 `DSHM_READY`）。
 * 旧实现把这个中间态当成终局失败发布到 `KEY_HOST_BOOT_ERROR`，Web 壳页随即
 * `clearAutoRetry()` + 永久 ERROR —— 一次"慢"变成了"坏了"。
 *
 * 【口径】失败分两种，处置必须不同：
 *   · 宿主线程**已退出** ⇒ 真失败，立刻发布（再等也没有结果）；
 *   · 宿主**仍在跑**、只是还没应答 ⇒ 只是没到，继续等（不发布错误）。
 * 重试窗口取 180 s：比 `READY_TIMEOUT_COLD_MS`（120 s）再宽一档，覆盖"预算刚过、
 * 宿主接着就绪"的尾部；到期仍没接上才如实发布失败。
 */
const HOST_BOOT_RECOVERY_MS: number = 180000;
/** 恢复期重试间隔：宿主就绪是秒级事件，3 s 既能跟上又不刷日志。 */
const HOST_BOOT_RETRY_INTERVAL_MS: number = 3000;
/**
 * 「窗口装饰里的三键（全屏 / 最小化 / 关闭）到底在不在」经 AppStorage 交给页面的键。
 *
 * 【为什么需要这个事实（2026-10-10，MatePad Edge 报「右上角三键与右侧边栏按钮重叠」）】
 * 手持档**不渲染自绘顶栏** ⇒ 窗口标题栏那 38vp 就没人画，而窗口仍在「自由窗口 + 三键可见」
 * 的状态，于是官方 Web 壳自己那排顶部按钮（最右侧那颗「面板 / 预览」）正好落在三键底下。
 * 页面得据此把整块 Web 内容按三键区高度下移。
 *
 * 【为什么不让页面自己去问系统】`getTitleButtonRect()` **不可靠**：MateBook 14 上三键
 * 明明可见，它却返回 width=0 / height=0（页面侧 `diag-decor-top` 原文
 * `handheld=false rect.w=0 rect.h=0 inset=0`）⇒ 拿它当"有没有三键"的判据必然漏判。
 *
 * 【2026-10-10 第二轮修：判据只能落在 setWindowDecorVisible(false) 的成败上】
 * 原实现把 `setWindowDecorVisible(false)` 与随后的 `setWindowDecorHeight(38)` /
 * `setDecorButtonStyle(...)` 塞进**同一个 try**，并推论"这一串调用成功 ⟺ 自由窗口 ⟺ 三键在"。
 * 真机（MatePad Edge **平板自由窗口**）证明这条推论**错了**：标题栏确实已隐藏（Web 内容顶到
 * 窗口第一行、系统三键浮在内容之上 —— 即"沉浸"已生效），但紧随其后的 `setWindowDecorHeight`
 * 抛 **801 Capability not supported**（SDK 明文：能力受限的设备上不支持该 API）⇒ 整串落进
 * catch ⇒ 这里发布 `false` ⇒ 页面让位 0 ⇒ 重叠照旧。真机读数 `diag-decor-top` 原文：
 * `2026-10-10T03:56:49.133Z handheld=true keys=false rect.w=0 rect.h=0 inset=0`。
 * ⇒ 现在**只有 `setWindowDecorVisible(false)` 的成败决定"标题栏是否已沉浸"**，再与窗口状态
 * 一起交给纯函数 `decorPresentOf()`；后两个调用降级为**各自独立的可选步骤**（各自吞自己的 801）。
 */
const KEY_DECOR_KEYS_VISIBLE: string = 'dshDecorKeysVisible';
const KEY_DECOR_STYLE_WRITABLE: string = 'dshDecorStyleWritable';
const KEY_DECOR_STYLE_WINDOW_ID: string = 'dshDecorStyleWindowId';
/**
 * 【2026-10-18 内测复报：2in1 / 平板的 PC 模式】
 *
 * 手持形态（手机 / 平板）跑在**自由窗口**里时（MatePad Pro MRO-W00「电脑模式」实测），
 * 设备仍报 `form=tablet` ⇒ 页面按手持档渲染（不画自绘顶栏 ⇒ 左上没有侧栏入口），
 * 而 `afterWindowStageReady` 又无条件 `setWindowDecorVisible(false)` ⇒ 系统标题栏与
 * **四边缩放边框**一起消失，只剩左右下角拖拽点（内测原话"只能从左下、右下调节窗口大小"）。
 *
 * 本键 = "手持形态 + 自由窗口（FLOATING）"。语义：
 *   · 能力层：**不隐藏**系统装饰（保住标题栏的四边缩放），也不隐藏三键；
 *   · 页面侧：`platformForm()` 返回 `desktop` 并挂 `dshm-pc` ⇒ 桌面档布局（侧栏常驻），
 *     收起态由页面里的浮动 ⊞ 提供入口（见 SIDEBAR_SHIM_JS 的 §D）。
 * 读不到窗口状态（801）时按原行为（隐藏装饰）处理 —— 宁可沉浸，也不要把桌面档误开。
 */
const KEY_PC_MODE: string = 'dshPcMode';
/** 「返回」请求计数器：能力层 -> 页面（页面 @Watch 后走 BACK_SHIM 的逐级消费）。 */
const KEY_BACK_TICK: string = 'dshBackTick';

/**
 * 当前生效外观（`'light' | 'dark'`）—— 由**页面**在 `applySystemBarTheme` 里发布，
 * 能力层读它给三键配色取权威（见 `reassertDecorButtons`）。与 `KEY_DECOR_KEYS_VISIBLE`
 * 同款约定：两侧各写一份字面量，门禁 `check-decor-button-mode` 钉**同名同值**。
 */
const KEY_APPEARANCE_MODE: string = 'dshAppearanceMode';

/**
 * 窗口状态码 → 短名（只用于 `files/diag-decor-caps` 的自证行）。
 *
 * 【为什么要它】2026-10-10 那份平板「按钮反色」诊断报告里，刷新行只记 `FLOATING` / `other`
 * 两个词 —— "那个 other 到底是 MAXIMIZE 还是 SPLIT_SCREEN"无从判断（枚举口径：
 * 0=UNDEFINED、1=FULL_SCREEN、2=MAXIMIZE、3=MINIMIZE、4=FLOATING、5=SPLIT_SCREEN），
 * 报告只能停在猜测上。
 */
function windowStatusName(st: window.WindowStatusType): string {
  switch (st) {
    case window.WindowStatusType.UNDEFINED: return 'UNDEFINED';
    case window.WindowStatusType.FULL_SCREEN: return 'FULL_SCREEN';
    case window.WindowStatusType.MAXIMIZE: return 'MAXIMIZE';
    case window.WindowStatusType.MINIMIZE: return 'MINIMIZE';
    case window.WindowStatusType.FLOATING: return 'FLOATING';
    case window.WindowStatusType.SPLIT_SCREEN: return 'SPLIT_SCREEN';
    default: return 'OTHER';
  }
}
/**
 * 装饰探测的**落盘取证**（`files/diag-decor-caps`，追加写）。
 *
 * 【为什么必须落盘】本机 ArkTS 侧 hilog 读不到（`docs/50` E385：同域清缓冲后恒 0 行）⇒
 * "到底哪个调用抛了什么码"在真机上无从取证，只能靠截图反推 —— 2026-10-10 第一轮就是这么被
 * 打回来的。把这一串调用的逐项结果写成一行，装机后 `hdc shell cat` 即可自证。写失败静默
 * （诊断不碰业务路径）。
 */
function writeDecorCapsDiag(filesDir: string, line: string): void {
  try {
    const p: string = `${filesDir}/diag-decor-caps`;
    const f: fs.File = fs.openSync(p,
      fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.APPEND);
    fs.writeSync(f.fd, `${new Date().toISOString()} ${line}\n`);
    fs.closeSync(f);
  } catch (e) {
    hilog.warn(DOMAIN, TAG, '装饰诊断写入失败：%{public}s', (e as Error).message);
  }
}

/**
 * 「PC 档关闭到托盘」链路的追加诊断（与 writeDecorCapsDiag 同一套写法；写失败静默）。
 *
 * 落点 `filesDir/diag-window-close`。为什么另开一个文件：这条链路在真机上要回答的是
 * 「`windowWillClose`（标题栏关闭按钮）与 `onPrepareToTerminate`（系统发起的终止）到底谁被触发」
 * —— 只有两侧各留一行才读得出来；混进 `diag-decor-caps` 会把装饰读数搅成噪声。
 * 装机后 `hdc shell cat <filesDir>/diag-window-close` 即可自证。
 */
function writeWindowCloseDiag(filesDir: string, line: string): void {
  try {
    const p: string = `${filesDir}/diag-window-close`;
    const f: fs.File = fs.openSync(p,
      fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.APPEND);
    fs.writeSync(f.fd, `${new Date().toISOString()} ${line}\n`);
    fs.closeSync(f);
  } catch (e) {
    hilog.warn(DOMAIN, TAG, '关闭诊断写入失败：%{public}s', (e as Error).message);
  }
}

/**
 * 给 Host 侧 VM 生命周期闸门写一份**同 pid**的前后台状态。
 *
 * 【为什么需要落文件】QEMU 在 worker 线程里做原生 abort 时，JS 完全 catch 不到；
 * 2026-10-17 APMS 1.1.3 的首例 `tcg_region_init` 崩溃发生在 `foreground=false`，
 * 与延迟静默预热的时间窗重合。Host 是同一进程里的 Node 线程，但拿不到 UIAbility
 * 生命周期，所以主窗只在这里覆写一行 JSON，vm.js 在冷启动前读取并 fail-closed。
 *
 * 只由主窗写：会话窗的前后台变化不代表整个应用的前后台状态。
 */
function writeAppLifecycle(filesDir: string, foreground: boolean, source: string): void {
  try {
    const dir: string = `${filesDir}/dsh/home`;
    if (!fs.accessSync(dir)) {
      fs.mkdirSync(dir, true);
    }
    const path: string = `${dir}/app-lifecycle.json`;
    const text: string = JSON.stringify({
      pid: process.pid,
      foreground,
      source,
      updatedAt: new Date().toISOString()
    });
    const f: fs.File = fs.openSync(path,
      fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(f.fd, text);
    } finally {
      fs.closeSync(f);
    }
  } catch (e) {
    hilog.warn(DOMAIN, TAG, '应用生命周期状态写入失败（VM 将按状态未知处理）：%{public}s',
      (e as Error).message);
  }
}

/**
 * 内存诊断的落盘点（`files/diag-mem`，追加写）。**写失败一律静默**。
 *
 * 【为什么要独立一个文件】2026-10-19 MatePad Edge 现场：应用启动 78 秒后系统 PSI、
 * 随后 97 条 LowMemoryKill / OomKiller / SwapFull。现有日志只有 host 侧读数、
 * 没有"应用自己收到了哪一档内存压力"，于是无法区分"系统全局紧"与"我们涨太快"。
 * 本文件每次 `onMemoryLevel` 一行（时间 + 档位 + 触发的动作），下一次复现能直接判读。
 */
function writeMemDiag(filesDir: string, line: string): void {
  try {
    const p: string = `${filesDir}/diag-mem`;
    const f: fs.File = fs.openSync(p,
      fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.APPEND);
    try {
      fs.writeSync(f.fd, `${new Date().toISOString()} ${line}\n`);
    } finally {
      fs.closeSync(f);
    }
  } catch (e) {
    /* 诊断失败不影响主流程 */
  }
}

/**
 * 落"曾经进入过内存危急档"的持久标记（`files/diag-mem-critical`）。
 *
 * 【为什么持久化】下一次冷启动时 Host 侧要在**插件加载之前**决定是否还做后台预热；
 * 进程内的 AppStorage 跨不过重启，只能落文件。Host 会读同一个路径（`DSHM_HOME/..`）。
 */
function markMemCritical(filesDir: string, reason: string): void {
  try {
    const f: fs.File = fs.openSync(`${filesDir}/diag-mem-critical`,
      fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(f.fd, `${new Date().toISOString()} ${reason}\n`);
    } finally {
      fs.closeSync(f);
    }
  } catch (e) {
    /* 写不进去不影响任何功能面 */
  }
}

/**
 * "系统三键此刻是否浮在窗口内容之上（因此页面必须让位）" 的**纯函数判据**。
 *
 * 四个输入各有明确语义，互不替代：
 *   · `decorHiddenOk` —— `setWindowDecorVisible(false)` 成功。**标题栏还留着时不必让位**：
 *     系统会自己占住那一条，内容从标题栏下方开始，压根不会重叠。（真机实测：手机是
 *     `visible=ok` + `FULL_SCREEN` ⇒ 由下面的状态判据给出 false；这条分支留给「调用真的失败」的形态。）
 *   · `titleButtonsHiddenOk` —— 手机 / 平板已用 `setWindowTitleButtonVisible(false,false,false)`
 *     明确隐藏系统三键。此时页面绝不需要让位，窗口状态读数不得覆盖这个结论。
 *   · `statusFloating` —— 窗口状态，`true` = 自由窗口（`WindowStatusType.FLOATING`）。
 *     **状态可读时它是唯一权威**：真机实证（MatePad Edge 同应用三张截图）**最大化态右上角
 *     没有系统按钮**（只有应用自己的两枚图标），只有自由窗口才浮出系统三键 ⇒ 最大化 / 全屏
 *     一律不让位（否则白白空出一条 38vp 的底色带）。
 *   · `decorHeightVp` —— `getWindowDecorHeight()` 的读数。**只在状态读不到（801）时**当保守
 *     兜底用：> 0 = 系统确实还画着一条装饰带 ⇒ 宁肯多让一条（页面按常量让位）也不让按钮被压住。
 *
 * 【为什么抽成纯函数】与 `decorTopInsetVp` 同一理由：抽出来才能被门禁
 * `tools/check-decor-button-mode.mjs` 直接求值断言（含"标题栏没隐藏 ⇒ 恒 false"与
 * "最大化态不让位"的负例）。
 */
function decorPresentOf(decorHiddenOk: boolean, titleButtonsHiddenOk: boolean, decorHeightVp: number,
  statusFloating: boolean | undefined): boolean {
  if (!decorHiddenOk) {
    return false;
  }
  if (titleButtonsHiddenOk) {
    return false;
  }
  if (statusFloating !== undefined) {
    return statusFloating;
  }
  return decorHeightVp > 0;
}

/**
 * 读窗口状态（`window.WindowStatusType` 的数字值），读不到（801 / 窗口未就绪）回 `undefined`。
 *
 * 【谁在用】`reassertWindowChrome()` 判"状态栏该不该由我们设"：手持档里只有
 * `FULL_SCREEN(1)` / `MAXIMIZE(2)` 才由我们设，其余（后台 MINIMIZE / 自由窗口 FLOATING /
 * 分屏 SPLIT_SCREEN）一律交还系统 —— 判据本体是 `platform` 的纯函数 `statusBarOwnedByApp`。
 */
function shouldRestoreFreeDecor(freeMode: boolean | undefined, status: window.WindowStatusType | undefined,
  foreground: boolean): boolean {
  return foreground && freeMode === true
    && (status === window.WindowStatusType.FLOATING || status === window.WindowStatusType.MAXIMIZE);
}

function readWindowStatusOf(win: window.Window): number | undefined {
  try {
    return win.getWindowStatus();
  } catch (e) {
    return undefined;
  }
}

/**
 * 页面 → 能力层：报告「刚刚连上了哪个 Host」的进程内事件。
 *
 * 【为什么用 emitter 而不是 AppStorage 订阅】`AppStorage` 没有变更订阅接口
 * （只有 `link`/`prop` 这类声明式双向绑定，能力层用不上）。而这条通路的语义本就是
 * 「一次通知」，不是「一份需要被订阅的状态」——事件总线才是对的工具。
 *
 * 【为什么不让页面直接调 `HostStore`】
 *   1. 页面拿不到 `UIAbilityContext`，而 `HostStore` 需要它才能打开偏好库；
 *   2. **零 UI 依赖**是本工程的架构纪律（`appstate` / `platform` 都不认识 UI），
 *      让页面直接碰平台存储会把存储细节漏进视图层。
 *   页面只报告「连上了哪个 Host」这个**事实**，由能力层决定怎么记。
 *
 * 事件 id 与载荷键来自 `platform`（唯一的契约定义处，见那里为何不能各写一份）。
 */

export default class EntryAbility extends UIAbility {
  /**
   * 本实例的启动参数（onCreate/onNewWant 时刷新）。
   *
   * 初值取「无参数」的解析结果而不是留 undefined：窗口形态在 onCreate 之前就需要被引用
   * （标签、是否恢复几何），给一个安全默认值可以省掉每一个使用点的判空。
   */
  private launchParams: WindowParams = parseWindowParams(undefined);
  /** 本实例窗口的系统 id（字符串化）。空串 = 尚未取到（此时不登记台账）。 */
  private windowId: string = '';
  /** 碰一碰接收绑定的窗口 id（-1 = 本实例未登记；onWindowStageDestroy 用它释放）。 */
  private knockWindowId: number = -1;
  /** 本实例的主窗口对象；几何读写与监听释放都要用它 */
  private mainWindow: window.Window | undefined = undefined;
  /** dsh-pet 桌面宿主只启动一次；插件未装时 PetAbility 会因页面 404 自行退出。 */
  private petStarted: boolean = false;
  private petWatchTimer: number = -1;
  private petQueryBusy: boolean = false;
  private petHttp: http.HttpRequest = http.createHttp();
  private pendingAuthReturnWant: Want | undefined = undefined;
  /** 窗口记忆（preferences 句柄），onWindowStageCreate 时 attach */
  private memory: WindowMemory = new WindowMemory();
  /** Host 连接记忆（地址走 preferences、token 走加密存储），onWindowStageCreate 时 attach */
  private hostStore: HostStore = new HostStore();
  /**
   * 长时任务（后台保活）。
   *
   * 【为什么能力层必须持有并真正调用它】`platform/notify/KeepAlive.ets` 早就写好了
   * 申请/释放的完整实现，但**全仓无人调用**（只有 `platform/Index.ets` 的 re-export）。
   * 后果：应用退到后台（最小化 / 切到别的应用 / 关掉主窗但会话窗仍开着）后会被系统挂起，
   * 与 Host 的长连接随之中断，正在跑的任务也停摆。
   * 注：PC/2in1 档三键「关闭」已改成**收进后台**（`handleWindowWillClose`），正是"窗口不可见
   * 而进程必须活着"的典型场景；手持档三键「关闭」仍是官方行为 = 退出应用，长时任务服务的是
   * 「窗口还在、只是不可见」的那些场景。
   *
   * 申请时机：主窗窗口就绪后（此时 context 可用、且确认是主窗）。
   * 释放时机：`onDestroy`。申请失败只降级（日志警告），不阻断任何功能。
   */
  private keepAlive: KeepAlive = new KeepAlive();
  /** 屏幕亮灭监听是否已注册（只注册一次）。 */
  private screenWatcherReady: boolean = false;
  /** 屏幕亮灭订阅句柄（保持引用，注销时要用）。 */
  private screenSubscriber: commonEventManager.CommonEventSubscriber | undefined = undefined;
  /**
   * 手持档的"这轮后台已经申请过保活"标记（见 `maybeAcquireHandheldKeepAlive()`）。
   *
   * 【为什么要单独一个布尔】`KeepAlive` 内部是**引用计数**（多窗口共用一份任务）——
   * 手持档的 `onBackground` / `onForeground` 会反复进出，用引用计数会出现"进两次后台 refs=2、
   * 回一次前台 refs=1 ⇒ 任务不释放、通知不消失"。这里用显式的"这轮已持有"保证一一对应。
   */
  private handheldKeepAliveHeld: boolean = false;
  /**
   * PC/2in1 启动时申请失败后，熄屏前只补申请一次（避免每次熄屏都把 refs 越加越高）。
   * 桌面档的保活是应用级常驻，成功一次就够。
   */
  private desktopKeepAliveRetried: boolean = false;
  /** 任务状态轮询定时器（任务完成通知的触发源，见 startTaskWatch）。 */
  private taskWatchTimer: number = -1;
  /** 已发布的"进度通知"对应哪个 taskId（空串=没有）。 */
  private progressTaskId: string = '';
  /**
   * 已经处理过的那次"任务结束"（键 = `taskId|at`）。
   *
   * 【为什么不再用 seq（2026-11-04 复测四）】`seq` 是 **Host 进程内**的计数器：应用重启后
   * 从 1 重新数，而 ArkTS 侧的 `lastSeq` 还停在旧值（实测 10）⇒ `seq > lastSeq` 永远为假
   * ⇒ **重启后第一次完成不会发通知**（日志里正是 `seq=1 … lastSeq=10`）。
   * `at`（ISO 时间戳）由 Host 每次写盘生成，单调且跨重启唯一，用它做键最稳。
   */
  private lastDoneKey: string = '';
  /** 首轮轮询：只记录基线，不回放历史任务（避免装完包立刻弹一条旧通知）。 */
  private taskWatchPrimed: boolean = false;
  /**
   * 手持档保活的**代次**（2026-10-29 修晚到 acquire 竞态，与 phone 同款机制）。
   *
   * 【竞态现场】后台 `busy=true` ⇒ `acquire()` 挂起 → 用户立刻回前台 ⇒
   * `releaseHandheldKeepAlive()` 看到 `held=true` 就 release 并把 held 置 false
   * （此时 refs 归零、任务本就没起来）；随后**晚到的 acquire 成功返回** ⇒
   * `KeepAlive` 内部 `active` 已被置真，而旧的 `.then` 只打一行日志 ⇒
   * **前台残留一条长时任务与通知**，直到下次进后台才可能被回收。
   *
   * 【判据】每次回前台（`releaseHandheldKeepAlive`）代次 +1；`.then` 里若看到
   * "代次变了"或"已经回到前台"，就必须 `release()` 把那一次申请退掉。
   * 这不是可选的保险：`release` 与 `acquire` 的先后由系统回调时序决定，应用层只能事后对账。
   */
  private keepAliveGeneration: number = 0;
  /** 手持档是否处于"已进后台"（晚到 acquire 的第二次判据；onForeground 置假）。 */
  private appBackgrounded: boolean = false;
  /**
   * 屏幕是否已熄灭（2026-11-08）。
   * 熄屏不一定触发 `onBackground`，但语义上等同"应用不可见"；熄屏时申请的保活
   * 不能在晚到检查里被当成"回前台作废" —— 判据必须并列 `appBackgrounded || screenOffed`。
   */
  private screenOffed: boolean = false;
  /** 宿主启动链是否已经排过（多窗口 / 多 stage 只会走到一次，见 `scheduleHostStartAfterFirstFrame()`）。 */
  private hostStartScheduled: boolean = false;
  private bundledCoreVerification: Promise<BundledCoreVerification | undefined> | undefined = undefined;
  /**
   * 目录授权恢复的完成信号。
   *
   * 工作区注册表在宿主启动时按 session header 的 cwd 做 realpath；授权尚未
   * activatePermission 时，用户目录返回的是 EPERM，不是 ENOENT。若宿主先起来，
   * 工作区会把这段时间解析不到的会话当成"不在成员里"，造成升级后看起来丢会话。
   * 所以首帧可以先画，但宿主启动链必须等这份恢复结束。
   */
  private folderGrantsReady: Promise<string> = Promise.resolve('尚未开始目录授权恢复');
  /**
   * 本次启动**自起**的本地核心（`autoStartHostForDiagnosis` 里创建）。
   *
   * 【为什么必须是字段而不是局部 const】退出时要先把核心停掉再结束应用：
   * 直接 `terminateSelf` 不保证回收应用自己起的 Node 线程，残留会占着回环端口，
   * 下次启动可能撞上「端口已占用」。停止入口是 `DshHost.stop()`（协作式：
   * 写 host-stop-request → 等 Node 线程退出），只有持有实例才调得到。
   */
  private host: DshHost | undefined = undefined;
  /**
   * 用户已请求「真正退出应用」。
   *
   * 这是一次性闩：`exitApp` 会被多处触发（托盘后台进程被系统结束等），
   * 没有它就会并发走两遍「停核心 → 摘图标 → terminateSelf」。
   */
  private exiting: boolean = false;
  /**
   * 本次启动是否由启动参数直接提供了 Host。
   *
   * 存在的理由：`publishRememberedHost()` 是**异步**读存储的，可能晚于
   * `applyLaunchParams` 完成。若不做标记，它读到的旧记录会**覆盖**刚由启动参数
   * 送进来的地址/令牌——症状是「用启动参数连上了，几秒后又跳回上一个 Host」。
   */
  private launchHostProvided: boolean = false;
  /**
   * 补票轮询是否在跑（见 `refillLocalHostToken`）。
   * `adoptLocalHost` 可能被多路径调用（重复 start 等），没有这个闩会排多条定时器，
   * 最后在同一个窗口里对 KEY_HOST_LAUNCH_URL 反复赋值。
   */
  private tokenRefillActive: boolean = false;
  /** 系统通知机制（能力层持有 context，故在此装配） */
  private notifier: NotificationCenter = new NotificationCenter();
  /** 本机偏好（主题模式等） */
  private prefs: LocalPrefs = new LocalPrefs();
  /** 通知授权是否已查过（只查/只弹一次） */
  private notifyChecked: boolean = false;
  private notifyReady: boolean = false;
  private shareDesktopNotifyPreparation: boolean = false;
  private desktopNotifyPreflight?: Promise<boolean>;
  /** 窗口记忆就绪信号。几何恢复必须等它，否则会在 store 尚未打开时静默跳过。 */
  private memoryReady: Promise<void> = Promise.resolve();
  /** 节流定时器 id；-1 表示当前无待执行的落盘任务 */
  private geometryTimer: number = -1;
  /** 上一次几何落盘的时间戳 */
  private lastGeometrySaveAt: number = 0;
  /**
   * 几何变化回调。
   * 存成字段（而不是每次现写一个 lambda）是因为 `off()` 必须拿到**同一个函数引用**，
   * 否则解绑会静默失败、留下悬空回调。
   */
  private onGeometryChanged: () => void = () => {
    this.scheduleGeometrySave();
  };

  /**
   * 三键区能力（可见性 / 高度 / 窗口状态）的**本实例记忆**。
   *
   * 【为什么要在实例里留一份】`refreshDecorCaps()` 会被 `windowStatusChange` 触发多次，
   * 而 `getWindowDecorHeight()` / `getWindowStatus()` 在能力受限设备上会抛 801
   * （平板自由窗口实证）—— 那一下必须**沿用上一次读数**而不是归零，否则窗口状态切换的
   * 瞬间让位会闪一下（内容跳上跳下）。这三个值就是"上一次读数"（`decorFloating` 的
   * `undefined` = 还没读到过）。
   */
  private decorHiddenOk: boolean = false;
  /** 手持形态是否跑在自由窗口（PC 模式）；见 `KEY_PC_MODE` 注释。 */
  private pcMode: boolean = false;
  /** 手持档是否已成功隐藏系统三键（PC / 2in1 恒 false）。 */
  private decorButtonsHidden: boolean = false;
  private decorHeightVp: number = 0;
  private decorFloating: boolean | undefined = undefined;
  /**
   * 上一次**落盘**的读数（`decorStatusRaw` = `diag-decor-caps` 里 status= 那一段、
   * `decorStyleRaw` = 三键配色那一步的结果）与上一次**发布**的让位结论。
   * 【为什么要记】同一次窗口状态变更会在**同一毫秒**里连来 3 次 `windowStatusChange`
   * （真机 `diag-decor-caps` 原文 07:30:59.165 ×2 + .166 ×1）⇒ 每次都发布会让内嵌 Web 容器的
   * `padding` 反复重排、并把诊断文件刷成噪声。三者**全都没变**才跳过（第一次刷新时
   * `decorPublished` 是 undefined ⇒ 必然发布，不会吃掉首帧结论）。
   */
  private decorStatusRaw: string = '';
  private decorStyleRaw: string = '';
  private decorPublished: boolean | undefined = undefined;
  private decorContentReady: boolean = false;
  private decorStyleWritable: boolean = false;
  private decorStyleWindowId: string = '';
  private decorForeground: boolean = false;
  private decorStage: window.WindowStage | undefined = undefined;
  private freeWindowMode: boolean | undefined = undefined;
  private freeWindowStatus: window.WindowStatusType | undefined = undefined;
  private freeDecorShown: boolean = false;
  private freeButtonsShown: boolean = false;
  private onFreeWindowModeChanged: ((enabled: boolean) => void) | undefined = undefined;
  /**
   * 窗口状态变化回调（自由窗口 ↔ 最大化 / 全屏时系统三键会跟着出现 / 消失）。
   * 与 `onGeometryChanged` 同理存成字段：`off()` 必须拿到**同一个函数引用**，
   * 否则解绑会静默失败、留下悬空回调。
   */
  private onDecorStatusChanged: ((status: window.WindowStatusType) => void) | undefined = undefined;

  /**
   * 标题栏「关闭」按钮的**拦截**回调（只有 PC/2in1 档、且只在主窗上挂）。
   *
   * 【为什么不用 `onPrepareToTerminate` 当判别器】SDK 对它的原文把触发面写成
   * "clicks the close button … **or exits from the dock or system tray**" ⇒ 它**分不开**
   * 「三键关闭」与「托盘 / 任务栏退出」这两件事，而本应用恰恰要区分：三键关闭 ⇒ 收进后台，
   * 托盘 / 任务栏退出 ⇒ 真退出（那条链还要摘托盘图标，见 `finalizeBeforeExit`）。
   * `windowWillClose`（API 15 起）的 SDK 原文把触发面收窄到**只有系统标题栏那个关闭按钮**
   * （"triggered only when the user clicks the close button in the system-provided title bar
   * to close the window. It is not triggered when the window is closed in other ways."）
   * ⇒ 正好当这个判别器。它**不在** `UIAbility.onPrepareToTerminate` 注释里列出的
   * "本回调不会执行"的三个条件里（那三条点名的是 `windowStageClose` / `onPrepareToTerminateAsync` /
   * `AbilityStage.onPrepareTermination*`）⇒ 两个回调可以共存，实测判据见 `writeWindowCloseDiag`
   * 落的 `diag-window-close`（两侧各一行）。
   *
   * 【为什么 resolve(true) 之前必须先把窗口收起】`resolve(true)` 只表示"别关这一个窗"，
   * 系统**不会**替我们把它藏起来；不主动最小化就会出现"点了关闭没反应"。
   * 回调是异步的（SDK："The callback function in this API is executed asynchronously"，
   * 且要求返回 `Promise<boolean>`）⇒ 系统等的是那个 Promise 落定，先最小化再 resolve 正好。
   *
   * 【存成字段】与 `onGeometryChanged` / `onDecorStatusChanged` 同理：`off()` 必须拿到
   * **同一个函数引用**，否则解绑会静默失败、留下悬空回调（解绑在 `unbindGeometry`）。
   * 【为什么是无参箭头函数】SDK 的形参类型是 `Callback<void, Promise<boolean>>`，而该声明所在文件
   * 自己定义的是 `declare interface Callback<T, V = void> { (data: T): V }` ⇒ 一个无参、
   * 返回 `Promise<boolean>` 的函数就是它的合法实参（本文件把 `onGeometryChanged: () => void`
   * 传给 `Callback<Size>` 的 `windowSizeChange` 也是同一条规则）。
   */
  private onWindowWillClose: () => Promise<boolean> = (): Promise<boolean> => {
    return this.handleWindowWillClose('windowWillClose');
  };

  private deferBundledEviction: boolean = false;

  private readonly onDesktopWorkbenchPainted: () => void = (): void => {
    const host: DshHost | undefined = this.host;
    if (this.deferBundledEviction && host !== undefined) {
      this.deferBundledEviction = false;
      host.scheduleRetiredCoreCleanup();
    }
  };

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    /*
     * 启动分段标记 S0（docs/201 §3-P2 / §6-A1）。
     * 【为什么是第一行】这里是"能力入口"，之后的每一段都要相对它计时；
     * 埋点自身只做一次 mkdir + 一次拼路径，失败静默，不会影响启动。
     */
    startupMarks.init(this.context.filesDir);
    startupMarks.mark('S0', StartupPhase.PROCESS, 'onCreate_enter',
      `kind=${launchParam.launchReason}`);
    this.context.eventHub.on(DESKTOP_WORKBENCH_PAINTED_EVENT, this.onDesktopWorkbenchPainted);
    if (typeof want.uri === 'string' && want.uri.trim().toLowerCase() === AUTH_RETURN_URI) {
      this.pendingAuthReturnWant = want;
    }
    /*
     * 2026-10-19 MatePad Edge 内存风暴的**第一道收口**：把 ArkWeb 切成单渲染进程.
     * 必须在任何 Web 组件创建之前调用（静态配置，后调不保证生效），故放在 onCreate 首行。
     * 失败只降级（打 diag-mem），不阻断启动。
     */
    this.applyWebMemoryProfile();
    /**
     * 主题模式从**本机偏好**读（D3 §8：「设置可覆盖」系统主题）。
     *
     * 此前这里无条件 `COLOR_MODE_NOT_SET`（= 跟随系统），也就是"覆盖"这一半从来不存在。
     * 读取是异步的（preferences），因此先用"跟随系统"起步，读到之后再改正——
     * 反过来（先等存储再设）会让启动多一次阻塞，而主题本来就是可以稍后生效的。
     * 依据 D1 §7.6.5 的判据（系统切换主题 1 秒内生效），这次修正必须在 1 秒内完成。
     */
    try {
      this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
    } catch (err) {
      hilog.error(DOMAIN, 'testTag', 'Failed to set colorMode. Cause: %{public}s', JSON.stringify(err));
    }
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onCreate');
    /*
     * 原生绑定与 Node 版本由共享 hostruntime HSP 统一探测。两条读数都来自同一个
     * 原生库域；HAP 不再各自 import libdshhost.so，避免产品壳与 HSP 出现两套句柄。
     */
    /*
     * 【2026-11-25 启动优化（docs/201 §6-B3）】原生绑定探测**只用于日志**（DSHM-PROBE /
     * DSHM-RUNTIME），不参与任何首帧或启动决策 ⇒ 从 onCreate 同步段挪到下一个宏任务，
     * 避免 `dlopen` + 原生方法调用与首帧抢同一个 ArkTS 线程。
     * 与 `warmWebEngineOnce()` 同一手法：诊断类工作一律让位于「先出首帧」。
     */
    setTimeout((): void => {
      const nativeProbe = probeNativeBindings();
      if (nativeProbe.probeOk) {
        hilog.info(DOMAIN, TAG, 'DSHM-PROBE cmake 构建的原生模块可绑定，返回值=%{public}s',
          nativeProbe.probeValue);
      } else {
        hilog.error(DOMAIN, TAG, 'DSHM-PROBE cmake 模块绑定失败：%{public}s',
          nativeProbe.probeError.length > 0 ? nativeProbe.probeError : '(空错误)');
      }
      if (nativeProbe.runtimeVersion.length > 0) {
        hilog.info(DOMAIN, TAG, 'DSHM-RUNTIME libnode 版本 = %{public}s', nativeProbe.runtimeVersion);
      } else {
        hilog.error(DOMAIN, TAG, 'DSHM-RUNTIME 调用原生模块失败：%{public}s',
          nativeProbe.runtimeError.length > 0 ? nativeProbe.runtimeError : '(空错误)');
      }
    }, 0);
    /*
     * 【2026-10-06 落成；2026-10-14 更正为**三端**】目录授权**跨启动恢复**
     * （"侧边栏工作区文件"重启后还能不能读的关键）。
     *
     * 现象：picker 给的目录授权是**进程级临时**的 —— 用户选完目录当场
     * `workspaceFiles/list` 能列出内容，进程一重启同一条调用就报
     * `cannot list "…": permission denied`，文件页整页读不出来
     * （手持档原始读数见 docs/105；PC 档同构读数见 docs/157）。
     * 平台给的两步是 `persistPermission`（选完记下来）+ `activatePermission`（重启启用回来），
     * 本仓此前只做了第一步 ⇒ 记了却没人启用。这里在启动时补第二步。
     *
     * 【为什么放在最前】它必须在**宿主服务文件页之前**完成；而排在后面的宿主启动还要
     * probe → 解包核心 → spawn（秒级到十秒级），用户点开文件页时这份恢复早已到位。
     * 【为什么三端都做，不再只对手持档】旧注释写"2in1/PC 上宿主本来就读得到 picker 目录
     * （docs/30 实测），不需要这条恢复"——那条读数在 **8 条权限面**下已不成立：PC 档
     * `aa force-stop` 后重启，同一目录 `os.listdir` 报 `Errno 1 Operation not permitted`
     * （现场读数见 docs/157，与手持档 docs/105 逐字同构）。这条恢复对**已登记**的授权
     * 逐个 `activatePermission`，没有登记的目录直接跳过 ⇒ 对 PC 档是幂等的、无副作用。
     */
    this.folderGrantsReady = restoreFolderGrants(this.context).then((summary: string) => {
      hilog.info(DOMAIN, TAG, 'DSHM-GRANT 目录授权启动恢复：%{public}s', summary);
      return summary;
    }).catch((err: BusinessError) => {
      hilog.warn(DOMAIN, TAG,
        'DSHM-GRANT 目录授权启动恢复异常（降级：用户自选目录可能读不到）：%{public}s', err.message);
      return `恢复异常：${err.message}`;
    });
    /*
     * 【2026-10-16：宿主启动链**不再在 onCreate 里跑**】
     *
     * 原实现在这里直接 `autoStartHostForDiagnosis()`：probe → 解包内置核心（95 MB / 4 万条目）
     * → `host.start()`。这些活的同步段（文档 `docs/146` 实测：`LOOP-GAP 1680 ms` + 同步调用
     * 1037 ms，主要在建树模块加载）与**首帧**抢同一个 ArkTS 线程 ⇒ AGC「启动加载完成快」
     * 读到 9039 ms（目标 4000 ms）。
     *
     * 官方《应用冷启动时延优化》把冷启动定义成"点击图标 → **首页首帧渲染完成**"，并明确
     * "ArkTS 单线程 EventLoop：异步调用会被同步逻辑挤到 UI 绘制之后" ⇒ 正确做法是
     * **先让首帧出来，再启动重活**。新的触发点在 `onWindowStageCreate()` 的 `loadContent`
     * 回调之后（见 `HOST_START_DELAY_AFTER_FIRST_FRAME_MS` 的注释）。
     */
    // 【报告 4 ②】整机冷启动通道：轮询 host-exit-mode（与 Host 的 host-stop-request 对称）
    this.startRestartWatcher();
    /*
     * HMS 语音识别桥（ArkTS 侧）。与上面的 restart watcher 同一手法：
     * Host（Node 进程）写请求文件，本侧轮询并执行**只有 ArkTS 才能做**的事
     * —— 调 `speechRecognizer`（HMOS 系统语音识别）。
     *
     * 【为什么必须常驻】`speechRecognizer` 是 ArkTS API，Node 进程调不到；
     * 而原生层（dshhost.cc）只暴露 startHost/isHostRunning/stopHost，
     * 没有消息通道。所以用文件队列当桥（项目既有先例且已验证：
     * host-stop-request / host-exit-mode / install-queue；两侧同 UID、
     * 同文件系统视图）。Host 侧的 provider 是**被动等**请求的：桥没起来
     * ⇒ `.req` 无人处理 ⇒ 识别超时。语音按钮是用户随时可能点的动作，
     * 所以桥必须常驻，不能等到点按钮才起。
     */
    startHmsSpeechBridge(this.context.filesDir, this.context);
    /* Task 1 探针：`aa start ... --ps dshProbe long --ps dshProbeSec 30`（人工诊断用） */
    this.handleSpeechProbeWant(want);
    /*
     * 外开桥（2026-10-17）：Host 侧 browser 工具在"浏览器还没启动"时写请求文件，
     * 本侧轮询并调 `openLink` 把浏览器拉起来（与语音桥同一个文件队列范式；
     * 必须在此常驻启动 —— 请求随时可能来）。context 显式传入，理由见桥文件头注。
     */
    startOpenLinkBridge(this.context.filesDir, this.context);
    // 桌面卡片推送器：只主窗挂一个（模块级守卫），没添加卡片时不做任何读取。
    if (this.launchParams.kind === WindowKind.MAIN) {
      startCardStateWatcher(this.context.filesDir);
    }
    // 先于 onWindowStageCreate 发布：窗口标签与「是否主窗」的判断都依赖它
    this.applyLaunchParams(want);
    if (this.launchParams.kind === WindowKind.MAIN) {
      if (DESKTOP_PROGRESSIVE_STARTUP && readDeviceFacts().desktopForced && !this.launchHostProvided) {
        this.bundledCoreVerification = resolveHostModulePaths(this.context)
          .then((paths: HostModulePaths) => {
            let installation: string = '';
            try {
              const bundle: bundleManager.BundleInfo =
                bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
              if (bundle.installTime > 0 && bundle.updateTime > 0) {
                installation = JSON.stringify([bundle.name, bundle.installTime, bundle.updateTime]);
              }
            } catch (e) {
              // 取不到安装信息时，由核心校验走完整 SHA-256。
            }
            return preverifyBundledCore(paths.resourceDir,
              this.context.cacheDir + '/dshm-bundled-core-identity-v1.txt', installation);
          })
          .catch((): undefined => undefined);
      }
      // 部分 PC/2in1 形态没有把 onForeground 排在本回调之后；这里先落一次，
      // 保证 host 延迟启动时 vm.js 一定能读到同 pid 的前台状态。
      writeAppLifecycle(this.context.filesDir, true, 'onCreate');
    }
    // S1：静态配置（ArkWeb 内存档位 / 主题模式）、启动参数、前台态均已就绪。
    // 之后的一切（prefs 读取、宿主启动）都不再阻塞首帧。
    startupMarks.mark('S1', StartupPhase.ABILITY, 'launch_params_published');
    this.prefs.attach(this.context).then(async () => {
      const mode: ThemeMode = await this.prefs.loadThemeMode();
      // 应用**并如实记录是否成功**：失败时页面会把这个事实说出来（见 Index 的主题写回路径），
      // 而不是让用户以为"设置生效了、只是看起来没变"。
      AppStorage.setOrCreate<boolean>(KEY_THEME_APPLIED, applyThemeMode(this.context, mode));
      // 界面据此渲染「本机偏好」分组里的当前值
      AppStorage.setOrCreate<string>(KEY_THEME_MODE, mode as string);
    }).catch((_error: Object) => {
      // attach 内部已兜底（失败时 store = undefined，读取返回 SYSTEM）
    });
  }

  /**
   * 整机冷启动通道（报告 4 ②，2026-09-26）。
   *
   * 【要解决什么】dsh 的"重启"（市场重启按钮 → `ctx.appExit`）语义是**整机冷启动**：
   * 完全退出 App 再拉起。它原本靠 `spawn(process.execPath, ['-e', RELAUNCH_HELPER])`
   * 等父进程退出后拉新实例——端侧 `process.execPath` 是 `/system/bin/appspawn`，
   * 那条路必然失败（Host 侧已把该形态转成"写 host-exit-mode=app-restart 后关闭"）。
   *
   * 【为什么由 ArkTS 做冷启动】"重新拉起应用"是 **Ability 层**的能力，Host（跑在
   * 进程内的 Node 线程）做不到自己重启整个应用。Host 负责把**意图**写清楚
   * （`$DSH_HOME/host-exit-mode = app-restart`），本函数负责读它并执行冷启动。
   *
   * 【为什么用 appRecovery.restartApp()】官方 API：重启当前进程并启动首个 ability
   * （SDK `@ohos.app.ability.appRecovery.d.ts`，since 9）。比"terminateSelf + startAbility"
   * 更贴合语义——我们要的就是"进程级重来"，而不是"关掉这个窗口再开一个"。
   * 注意其**限流**：两次重启间隔须 > 1 分钟，1 分钟内重复调用会"退出但不重启"
   * （SDK 原文）。这是平台行为，我们如实记录日志，不假装成功。
   *
   * 【为什么用轮询而不是回调】Host 是被 `node` 线程停掉的，ArkTS 侧没有它的退出回调；
   * 与 `host-stop-request` 那套"文件当落点"的既有做法保持一致（可观察、失败留痕）。
   *
   * 【为什么只在主窗跑】多窗（specified 实例）各自 onCreate 都会进来 ⇒ 会重复触发
   * 冷启动。用模块级标志 + 仅主窗注册，既避免打架，也让"谁触发了重启"在日志里唯一。
   */
  private startRestartWatcher(): void {
    if (this.launchParams.kind !== WindowKind.MAIN) {
      return;
    }
    if (restartWatcherStarted) {
      return; // 模块级：主窗可能被复用重建，只挂一个
    }
    restartWatcherStarted = true;
    const exitModePath: string = `${this.context.filesDir}/dsh/home/host-exit-mode`;
    hilog.info(DOMAIN, TAG, '冷启动通道已就绪，监视 %{public}s', exitModePath);
    const timer: number = setInterval(() => {
      let mode: string = '';
      try {
        if (!fs.accessSync(exitModePath)) {
          return; // 文件不在：一切正常
        }
        mode = fs.readTextSync(exitModePath).trim();
      } catch (e) {
        return; // 读失败下轮再试
      }
      if (mode !== 'app-restart') {
        // 其它取值（未来的模式）暂不处理，但清掉标记避免反复命中
        try { fs.unlinkSync(exitModePath); } catch (e) { /* 下轮再试 */ }
        hilog.info(DOMAIN, TAG, 'host-exit-mode=%{public}s：非 app-restart，忽略', mode);
        return;
      }
      // 先清标记再冷启动：否则新实例起来立刻又命中，变成重启风暴。
      try {
        fs.unlinkSync(exitModePath);
      } catch (e) {
        hilog.warn(DOMAIN, TAG, '清 host-exit-mode 失败（可能反复重启）：%{public}s', String(e));
      }
      hilog.info(DOMAIN, TAG, 'DSHM-RESTART 收到整机冷启动请求，转入整机冷启动');
      this.restartWholeApp();
    }, 1500);
    // 与 Host 侧 poller 同为 unref 语义（ArkTS 无 unref：作为模块级计时器存活，随进程结束而止）
    if (timer < 0) {
      hilog.warn(DOMAIN, TAG, '冷启动监视器未能启动');
    }
  }

  /**
   * 整机冷启动（插件/皮肤市场「重启后生效」的落点）。
   *
   * 【为什么不能只调 restartApp()（2026-10-09 真机实证）】原先的实现只有那一行。真机读数：
   * 「DSHM-RESTART 收到整机冷启动请求，调用 appRecovery.restartApp()」打出来了、**之后一行都没有**
   * （没有异常、没有报错），进程 pid 与 host-ready.json 的 pid/startedAt 全不变 —— 重启
   * **静默地什么也没发生**。而 Host 那边已经干净退出了（process.exit(0)，host-exit-mode 也写了）
   * ⇒ App 停在「连接已断开」的死态。皮肤装完点「使用」就落在这里，是本档最重的一处缺陷。
   *
   * 【真根因（对照平台源码后定案）】restartApp() 的前置条件是**先调过 enableAppRecovery()**：
   * OpenHarmony 的 AppRecovery::ScheduleRecoverApp() 在 isEnable_ 为假时直接 return false
   * （静默、不抛），而 isEnable_ 只由 EnableAppRecovery() 置真 ⇒ 那一行等于没写。
   * 开关已补在 AppAbilityStage.onCreate（见那里的长注释：为什么用 RESTART_WHEN_JS_CRASH、
   * 为什么放 AbilityStage 而不是本文件）。
   *
   * 【为什么必须整机冷启动，不能「同进程重起 Host」】原生引导层确实会在 node::Start 返回后
   * 复位 g_started（E119），所以"停掉再起"在原生层是允许的；但手持档还有一条更硬的约束：
   * **同一进程只能初始化一次 QEMU**（docs/119）⇒ 同进程重起的 Host 起不回 guest 虚拟机
   * bash 通道；再加上 WebView 侧的端口/令牌也要重新落地。整机冷启动是这里唯一正确的语义。
   *
   * 【平台口径（SDK @ohos.app.ability.appRecovery.d.ts）】restartApp() 重启当前进程并拉起
   * 「第一个 ability」，而**选哪个 ability** 有两条规则：
   *   · 没调过 setRestartWant ⇒ 只认「前台且**支持恢复**（enableAppRecovery）」的 ability，
   *     一个都没有时**谁也不起**；
   *   · 调过 setRestartWant ⇒ 就起指定的那个（本条优先）。
   * 开关已在 AppAbilityStage.onCreate 打开（因此上面的第一条规则也成立），这里再补
   * setRestartWant，把「起哪个」这件事变确定——两条规则里调过 setRestartWant 的那条优先。
   *
   * 【为什么还要兜底退出】就算开关补上了，restartApp() 仍有三条不生效的路（限流 / 无前台
   * ability / 平台侧失败），而且它**连失败都不抛**。无论哪种，都**不能把 App 留在宿主已死、
   * 界面全灰的死态**：窗口过去后进程还在 ⇒ 重启没生效 ⇒ 走已验证的干净退出
   * （exitApp：摘托盘 → 通知托盘进程 → 停核心 → terminateSelf），用户重开一次即生效。
   * 冷启动真的生效时进程直接消失，这个定时器永远没机会触发。
   */
  private restartWholeApp(): void {
    try {
      const want: Want = { bundleName: BUNDLE_NAME, abilityName: ENTRY_ABILITY_NAME };
      appRecovery.setRestartWant(want);
      hilog.info(DOMAIN, TAG, 'DSHM-RESTART 已指定重启目标：%{public}s/%{public}s',
        BUNDLE_NAME, ENTRY_ABILITY_NAME);
    } catch (e) {
      const err = e as BusinessError;
      hilog.warn(DOMAIN, TAG, 'DSHM-RESTART setRestartWant 失败（仍继续尝试重启）：%{public}s', err.message);
    }
    let requested: boolean = false;
    try {
      appRecovery.restartApp();
      requested = true;
      hilog.info(DOMAIN, TAG, 'DSHM-RESTART 已请求整机冷启动（进程应被平台重启）');
    } catch (e) {
      const err = e as BusinessError;
      hilog.error(DOMAIN, TAG, 'DSHM-RESTART 冷启动调用失败：%{public}s', err.message);
    }
    const fallback: number = setTimeout(() => {
      hilog.error(DOMAIN, TAG,
        'DSHM-RESTART 冷启动未生效（%{public}d ms 后进程仍在，调用已发出=%{public}s），退回干净退出以免停在死态',
        RESTART_FALLBACK_MS, requested ? 'true' : 'false');
      this.exitApp('整机冷启动未生效（兜底退出）');
    }, RESTART_FALLBACK_MS);
    if (fallback < 0) {
      hilog.warn(DOMAIN, TAG, 'DSHM-RESTART 兜底定时器未能启动');
    }
  }

  /**
   * 诊断用：不问 UI，直接把「安装内置核心 → 启动 Host」跑一遍并记录每一步结果。
   *
   * 【为什么把它放在 onCreate 而不是等用户点按钮】设备上的点击我无法自动化，
   * 而这一步要回答的是目标里"dsh web 最小可用"这半道门——必须有真机读数。
   * 它与核心页上的动作走的是**同一套实现**（`DshHost.installBundled` / `start` 与
   * `NodeRuntime`），所以这里跑通的路径就是用户在界面上按按钮的路径，不是另一条捷径。
   *
   * 【为什么每一步都打日志且不吞异常】`start()` 失败的原因（端口没应答 / 环境变量条数
   * 不对 / Node 线程已退出）只有这几种，全部来自真实状态；写清楚才能判断卡在哪一环。
   */
  private autoStartHostForDiagnosis(): void {
    const ctx = this.context;
    /*
     * 【首启阶段必须让界面看得见（E99）】内置核心的解包是**几十秒级**的操作（66 MB zip /
     * 2.5 万个文件），而它发生在一个**与页面不同的 `DshHost` 实例**里（这里一个，Index 里一个），
     * 所以 `installBundled` 设的 `transient = EXTRACTING` 页面根本看不到。
     * 结果是首启时会话页显示「还没有安装核心」——**事实正相反**，它正在解包。
     * 用一个 AppStorage 标志把这个阶段跨实例广播出去。
     */
    AppStorage.setOrCreate<boolean>(KEY_CORE_INSTALLING, true);
    AppStorage.setOrCreate<string>(KEY_HOST_BOOT_ERROR, '');
    // 入口脚本随包放在 resources/resfile/resources/app/main.js（见 coreHost 的注释）
    // 沙箱 HOME 用 filesDir：hdc 对 cacheDir 无读权限，而诊断日志要能被取回（见 NodeRuntime 注释）
    // 第 3 实参 = UIAbility 上下文（本类自身就是 UIAbility，`this.context` 即 UIAbilityContext）：
    // `NodeRuntime.start()` 要用它在 spawn 之前认领 `Download/<包名>/`（见 NodeRuntime 注释）。
    // 【为什么必须在这里传】本方法是**首启唯一实际执行的 Host 启动路径**：不传 ⇒ 认领被跳过、
    // `DSHM_PUBLIC_DOWNLOAD` 为空 ⇒ 默认工作区静默退回沙箱，用户可见存储上零足迹（40 轮真机实证）。
/*
 * 【数据根（2026-11-07）】桌面形态统一落 `<主入口模块>/files`：端侧只把主入口模块的数据目录
 * 挂进可加载命名空间，`pc` 壳自己的 `haps/pc/files` 里 `dlopen` 一律被拒
 * （终端 node-pty 的 pty.node 就是这么失败的）。详见 hostruntime 的 resolveHostDataDir()。
 */
const dataDir: string = resolveHostDataDir(ctx.filesDir, !isHandheldForm());
    const runtime = new NodeRuntime('', dataDir, this.context as common.UIAbilityContext);
    const facts = readDeviceFacts();
    const reportDesktopStartup: boolean = DESKTOP_PROGRESSIVE_STARTUP && facts.desktopForced &&
      this.launchParams.kind === WindowKind.MAIN && !this.launchHostProvided;
    this.deferBundledEviction = reportDesktopStartup && facts.rawType === 'tablet' && !runtime.isRunning();
    if (reportDesktopStartup) {
      AppStorage.setOrCreate<number>(KEY_DESKTOP_HOST_STARTUP, DesktopHostStartupStage.CheckingCore);
      runtime.setStartupListeningCallback((): void => {
        AppStorage.setOrCreate<number>(KEY_DESKTOP_HOST_STARTUP, DesktopHostStartupStage.PortListening);
      });
    }
    const host = new DshHost(dataDir, runtime);
    // 存成字段：退出流程要调 `host.stop()` 干净地停掉宿主（见 host 字段的说明）
    this.host = host;
    hilog.warn(DOMAIN, TAG, 'DSHM-AUTO 开始：公共核心资源将由 hostruntime HSP 解析');
    // 把三个目录的**真实字符串**打出来：入口脚本的诊断日志要落在一个我们能用 hdc 取回的
    // 目录里，而 `filesDir` / `cacheDir` 在设备上到底映射到哪条路径，靠猜已经错过一次。
    hilog.info(DOMAIN, TAG, 'DSHM-AUTO 目录：files=%{public}s cache=%{public}s temp=%{public}s resource=%{public}s',
      dataDir, ctx.cacheDir, ctx.tempDir, ctx.resourceDir);
    runtime.probe().then((p) => {
      hilog.warn(DOMAIN, TAG, 'DSHM-AUTO 探测：available=%{public}s node=%{public}s note=%{public}s',
        p.available ? 'true' : 'false', p.nodeVersion, p.note);
      if (!p.available) {
        throw new Error(`核心运行时不可用：${p.note}`);
      }
      return resolveHostModulePaths(this.context)
        .then((paths: HostModulePaths) => {
          const verification = this.bundledCoreVerification;
          this.bundledCoreVerification = undefined;
          return host.installBundled(paths.resourceDir, ctx.cacheDir, verification, this.deferBundledEviction);
        });
    }).then((r) => {
      AppStorage.setOrCreate<boolean>(KEY_CORE_INSTALLING, false);
      hilog.warn(DOMAIN, TAG, 'DSHM-AUTO 安装内置核心：installed=%{public}s failed=%{public}d note=%{public}s',
        JSON.stringify(r.installed), r.failed.length, r.note);
      if (reportDesktopStartup && r.failed.length === 0) {
        AppStorage.setOrCreate<number>(KEY_DESKTOP_HOST_STARTUP, DesktopHostStartupStage.StartingHost);
      }
      return this.startHostWithRecovery(host, runtime);
    }).then((s: HostStartResult) => {
      hilog.warn(DOMAIN, TAG, 'DSHM-AUTO 启动 Host：ok=%{public}s url=%{public}s note=%{public}s',
        s.ok ? 'true' : 'false', s.handle === null ? '' : s.handle.url, s.note);
      if (s.ok && s.handle !== null) {
        AppStorage.setOrCreate<string>(KEY_HOST_BOOT_ERROR, '');
        this.adoptLocalHost(s.handle.url);
      } else {
        const message: string = s.note.length > 0 ? s.note : '核心启动失败：未返回可用 Host';
        AppStorage.setOrCreate<string>(KEY_HOST_BOOT_ERROR, message);
        hilog.error(DOMAIN, TAG, 'DSHM-AUTO 失败已发布到页面：%{public}s', message);
      }
    }).catch((e: Object) => {
      AppStorage.setOrCreate<boolean>(KEY_CORE_INSTALLING, false);
      const detail: string = e instanceof Error ? e.message : String(e);
      const message: string = detail.startsWith('核心') ? detail : `核心启动失败：${detail}`;
      AppStorage.setOrCreate<string>(KEY_HOST_BOOT_ERROR, message);
      hilog.error(DOMAIN, TAG, 'DSHM-AUTO 异常：%{public}s', message);
    });
  }

  /**
   * 启动宿主；**宿主仍在跑就继续等**，只有它真的退出/超窗才把失败交给上层。
   *
   * 【为什么不能一次 `host.start()` 定生死】`NodeRuntime.start()` 的端口预算到点时，
   * 宿主往往只是"还没起完"（真机读数：报错后约 6 秒才 `SERVER-LISTENING`）。旧实现
   * 把这一次超时直接发布成 `KEY_HOST_BOOT_ERROR`，Web 壳页随即进入永久 ERROR ——
   * 用户看到的就是「启动核心失败，连不上核心」，而核心其实马上就好了。
   *
   * 【判据】`runtime.isRunning()` 是进程级事实（问引导层的 `isHostRunning()`）：
   *   · false ⇒ 宿主线程已经没了，重试无意义，原样返回失败；
   *   · true  ⇒ 只是慢，继续等（每次重试都会重新尝试从 host-ready.json 取回地址，
   *             见 `DshHost.start()` 的"在跑但没句柄"分支）。
   * 每轮都打一条 hilog：事后能从日志看出"到底等了几轮、最后是谁先放弃"。
   */
  private startHostWithRecovery(host: DshHost, runtime: NodeRuntime): Promise<HostStartResult> {
    const deadline: number = Date.now() + HOST_BOOT_RECOVERY_MS;
    const attempt = (round: number): Promise<HostStartResult> => {
      return host.start().then((s: HostStartResult): Promise<HostStartResult> => {
        if (s.ok && s.handle !== null) {
          if (round > 1) {
            hilog.warn(DOMAIN, TAG, 'DSHM-AUTO 第 %{public}d 轮重试后拿到可用 Host（%{public}s）',
              round, s.note);
          }
          return Promise.resolve(s);
        }
        const alive: boolean = runtime.isRunning();
        if (!alive) {
          hilog.error(DOMAIN, TAG, 'DSHM-AUTO 第 %{public}d 轮失败且宿主线程已退出，不再重试：%{public}s',
            round, s.note);
          return Promise.resolve(s);
        }
        if (Date.now() >= deadline) {
          hilog.error(DOMAIN, TAG,
            'DSHM-AUTO 第 %{public}d 轮仍未就绪，恢复窗口 %{public}d ms 已用尽：%{public}s',
            round, HOST_BOOT_RECOVERY_MS, s.note);
          return Promise.resolve(s);
        }
        hilog.warn(DOMAIN, TAG,
          'DSHM-AUTO 第 %{public}d 轮未就绪，但宿主仍在运行 ⇒ 等 %{public}d ms 后重试：%{public}s',
          round, HOST_BOOT_RETRY_INTERVAL_MS, s.note);
        return new Promise<void>((resolve: () => void) => {
          setTimeout(() => {
            resolve();
          }, HOST_BOOT_RETRY_INTERVAL_MS);
        }).then((): Promise<HostStartResult> => attempt(round + 1));
      });
    };
    return attempt(1);
  }

  /**
   * 把**本端自起 Host** 的地址接给客户端（含 token）。
   *
   * 【为什么需要这一步】端侧 Host 的地址只有两个来源：
   *   ① 用户粘贴/深链传入（`applyHostLaunchParams`）；
   *   ② 本端自己起的 Host —— dsh 会把**带 token 的**地址打到 stdout，入口脚本抓下来写成
   *      `host-ready.json`，`NodeRuntime.start()` 读出后放进句柄的 `url`。
   * 只有把 ② 也发布出去，界面才会真的连上本端 Host；否则页面拿着空 token 发请求，
   * Host 一律回 401（browser-trust fence），表现就是"端口通了但界面没有会话"。
   *
   * 启动参数给的 Host 优先级更高：那种情况下**不覆盖**用户明确指定的目标。
   */
  private adoptLocalHost(handleUrl: string): void {
    if (this.launchHostProvided) {
      hilog.info(DOMAIN, TAG, '本端 Host 已起，但启动参数指定了别的 Host：不覆盖');
      return;
    }
    if (handleUrl.length === 0) {
      return;
    }
    let baseUrl: string = this.stripTokenQuery(handleUrl);
    // 去掉结尾斜杠：`stripTokenQuery` 只切 `?`/`#`，会把 `…:3120/` 原样留下；
    // 而客户端 `parseTarget` 期望的是 `scheme://authority`（无路径）。
    // 实测（E56）：带尾斜杠时 `SessionHub.configure` 静默返回 false ⇒ **既不发请求也不报错**，
    // 外面只能看到"端口通了但界面没连上"，极难定位。
    while (baseUrl.endsWith('/')) {
      baseUrl = baseUrl.substring(0, baseUrl.length - 1);
    }
    const cutToken: number = handleUrl.indexOf('token=');
    const token: string = cutToken >= 0 ? handleUrl.substring(cutToken + 'token='.length) : '';
    if (baseUrl.length === 0) {
      return;
    }
    /*
     * 【无 token ⇒ 先不发布启动 URL（2026-10-14 冷启动 401）】
     *
     * 发布无 token 的地址 = Web 壳页加载它 ⇒ browser-trust fence 恒回 401，
     * 且页面的自动重试对着**同一个**无 token 地址打 ⇒ 永远 401（真机实测
     * diag-web-load 连打 7 次）。这里的处置是把"等 token"从 NodeRuntime 的
     * 单点等待延续到发布端：不发布，等补票轮询读到本次进程的那份文件再发布；
     * Web 壳页此时停在启动页（launchUrl 为空是 BOOTING 的正常输入），
     * 补票成功后经 @Watch 自动进入加载 —— 用户全程只看一次冷启动。
     */
    if (token.length === 0) {
      hilog.warn(DOMAIN, TAG,
        '本端 Host 地址里没有 token（host-ready.json 尚未落盘）：不发布启动 URL，改走补票轮询');
      AppStorage.setOrCreate<string>(KEY_HOST_URL, baseUrl);
      AppStorage.setOrCreate<string>(KEY_HOST_TOKEN_STATE, 'pending');
      if (!this.tokenRefillActive) {
        this.tokenRefillActive = true;
        this.refillLocalHostToken(baseUrl, TOKEN_REFILL_RETRY);
      }
      return;
    }
    AppStorage.setOrCreate<string>(KEY_HOST_URL, baseUrl);
    AppStorage.setOrCreate<string>(KEY_HOST_TOKEN, token);
    AppStorage.setOrCreate<string>(KEY_HOST_TOKEN_STATE, 'found');
    AppStorage.setOrCreate<boolean>(KEY_HOST_AUTOCONNECT, true);
    // Web 壳页只认这个键：handleUrl 是本次进程拿到的完整启动 URL，token 必然有效
    AppStorage.setOrCreate<string>(KEY_HOST_LAUNCH_URL, handleUrl);
    // S5：宿主就绪且启动 URL 已发布 —— 从这里开始才是 Web 的加载成本
    startupMarks.mark('S5', StartupPhase.HOST, 'host_ready_url_published',
      `tokenLen=${token.length}`);
    this.persistConnectedHost(baseUrl, token);
    hilog.info(DOMAIN, TAG, 'DSHM-AUTO 已接入本端 Host：base=%{public}s tokenLen=%{public}d',
      baseUrl, token.length);
  }

  /**
   * 补票轮询：按一拍重读本端 host-ready.json，读到带 token 的链接就回到正常发布路径。
   *
   * 用尽预算时**退回旧的降级行为**（发布无 token 基址）：那时 Host 多半真的坏了，
   * 让页面如实报 401 比永远停在启动页更能说明问题（且保留手动重试入口）。
   */
  private refillLocalHostToken(baseUrl: string, remain: number): void {
    if (this.launchHostProvided) {
      this.tokenRefillActive = false;
      return;
    }
    const url: string = this.readLocalHostReadyUrl();
    if (url.length > 0 && url.includes('token=')) {
      this.tokenRefillActive = false;
      hilog.info(DOMAIN, TAG, '补票成功：host-ready.json 已补上本次进程的 token（第 %{public}d 拍）',
        TOKEN_REFILL_RETRY - remain + 1);
      this.adoptLocalHost(url);
      return;
    }
    if (remain <= 0) {
      this.tokenRefillActive = false;
      hilog.warn(DOMAIN, TAG,
        '补票窗口用尽（%{public}d ms）：退回无 token 基址，页面将如实报 401',
        TOKEN_REFILL_RETRY * TOKEN_REFILL_INTERVAL_MS);
      AppStorage.setOrCreate<string>(KEY_HOST_LAUNCH_URL, baseUrl);
      this.persistConnectedHost(baseUrl, '');
      return;
    }
    setTimeout((): void => {
      this.refillLocalHostToken(baseUrl, remain - 1);
    }, TOKEN_REFILL_INTERVAL_MS);
  }

  /**
   * 读本端 `host-ready.json` 的完整启动链接（含 token），**只认本次进程写下的那份**。
   *
   * pid 守卫与 `NodeRuntime.readAuthUrl` 同源：dsh 每次启动换 token，文件里若是上一次
   * 进程留下的（pid 不符），拿去只会换来 401。读不到一律返回空串，不猜。
   */
  private readLocalHostReadyUrl(): string {
    try {
      const path: string = `${this.context.filesDir}/dsh/home/host-ready.json`;
      if (!fs.accessSync(path)) {
        return '';
      }
      const parsed = JSON.parse(fs.readTextSync(path)) as Record<string, string>;
      const url: string = typeof parsed.url === 'string' ? parsed.url : '';
      if (url.length === 0 || `${parsed.pid}` !== `${process.pid}`) {
        return '';
      }
      return url;
    } catch (e) {
      const err = e as BusinessError;
      hilog.warn(DOMAIN, TAG, '读 host-ready.json 失败（补票窗口继续）：%{public}s', err.message);
      return '';
    }
  }

  onDestroy(): void {
    this.context.eventHub.off(DESKTOP_WORKBENCH_PAINTED_EVENT, this.onDesktopWorkbenchPainted);
    this.stopTaskWatch();
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onDestroy');
    /*
     * 释放长时任务。
     *
     * 【为什么必须在这里释放】长时任务若泄漏（申请了不释放），系统会一直认为
     * 本应用在做后台数据传输，既耗电、也可能被系统/审核侧判定为滥用。
     * `forceRelease` 而非 `release`：销毁是终局，不必再走引用计数——计数若因
     * 某条异常路径偏高，用 release 会留下一个永不释放的任务。
     *
     * 只在主窗释放：申请也只在主窗做（见 onWindowStageCreate），两者对称。
     */
    if (this.launchParams.kind === WindowKind.MAIN) {
      this.keepAlive.forceRelease().catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, '释放后台保活失败（任务可能残留）：%{public}s', err.message);
      });
    }
  }


  /**
   * Web 渲染内存档位（2026-10-19 MatePad Edge 内存风暴后的收口）。
   *
   * 【现场】应用启动后约 78 秒系统首次 PSI，随后 97 条 LowMemoryKill/OomKiller/SwapFull。
   * 启动期快照里 ArkWeb 是"主进程 + **2 个** :render"；多渲染进程模式下每个 Web 组件
   * 各起一个渲染子进程，常驻内存与 GPU 资源都翻倍。
   *
   * 【本档只做一件事】把 ArkWeb 切到**单渲染进程**（`RenderProcessMode.SINGLE`）。
   * 本应用只有一两个 Web 组件、没有渲染隔离需求，单进程可少一个 :render 的常驻与重复
   * GPU 资源。API 12 起可用，低版本直接跳过（不阻断启动）。
   *
   * 【为什么必须在 Web 创建之前】该 API 是静态配置，Web 组件初始化后再调不保证生效。
   * 故调用点放在 `onCreate` 最前面（早于任何页面/窗口创建）。
   */
  private applyWebMemoryProfile(): void {
    try {
      const api: number = deviceInfo.sdkApiVersion;
      if (api >= 12) {
        webview.WebviewController.setRenderProcessMode(webview.RenderProcessMode.SINGLE);
        hilog.info(DOMAIN, TAG, 'Web 渲染进程模式 = 单进程（sdkApi=%{public}d）', api);
        writeMemDiag(this.context.filesDir, `web-render-mode=single api=${api}`);
      } else {
        writeMemDiag(this.context.filesDir, `web-render-mode=skip api=${api}`);
      }
    } catch (e) {
      const err = e as BusinessError;
      hilog.warn(DOMAIN, TAG, 'Web 渲染进程模式设置失败（保持默认）：%{public}s', err.message);
      writeMemDiag(this.context.filesDir, `web-render-mode=fail ${err.message}`);
    }
  }

  /**
   * 系统内存压力回调（UIAbility 生命周期，API 9 起）。
   *
   * 【为什么要接它】2026-10-19 的 MatePad Edge 现场只有系统侧 PSI/LowMemoryKill 记录，
   * 应用侧不知道"自己收到过哪一档压力"，也就无法区分"系统全局紧"与"我们涨太快"。
   * 现在每次回调都落 `files/diag-mem`（时间 + 档位），危急档再落持久标记
   * `files/diag-mem-critical` —— 下一次冷启动 Host 读到它就**关掉后台预热**。
   *
   * 【为什么调 trimMemoryByPressureLevel】API 14 起 ArkWeb 提供按压力档释放内核缓存的
   * 入口；它比"等系统来杀"早一步，且只释放 Web 内核可回收缓存，不影响页面状态。
   */
  onMemoryLevel(level: AbilityConstant.MemoryLevel): void {
    const critical: boolean = level === AbilityConstant.MemoryLevel.MEMORY_LEVEL_CRITICAL;
    const low: boolean = level === AbilityConstant.MemoryLevel.MEMORY_LEVEL_LOW;
    const name: string = critical ? 'critical' : (low ? 'low' : 'moderate');
    hilog.warn(DOMAIN, TAG, '系统内存压力= %{public}s（level=%{public}d）', name, level as number);
    writeMemDiag(this.context.filesDir, `onMemoryLevel=${name} level=${level as number}`);
    try {
      if (deviceInfo.sdkApiVersion >= 14) {
        const pl: webview.PressureLevel = critical
          ? webview.PressureLevel.MEMORY_PRESSURE_LEVEL_CRITICAL
          : webview.PressureLevel.MEMORY_PRESSURE_LEVEL_MODERATE;
        webview.WebviewController.trimMemoryByPressureLevel(pl);
        writeMemDiag(this.context.filesDir, `trim=${critical ? 'critical' : 'moderate'}`);
      }
    } catch (e) {
      const err = e as BusinessError;
      hilog.warn(DOMAIN, TAG, 'ArkWeb 内存回收调用失败：%{public}s', err.message);
      writeMemDiag(this.context.filesDir, `trim-fail ${err.message}`);
    }
    if (critical) {
      markMemCritical(this.context.filesDir, 'onMemoryLevel=critical');
    }
  }


  /**
   * specified 模式**复用**已有实例时的入口——「第二次打开同一会话只聚焦、不新开」的落点。
   *
   * 复用实例时页面不会重建，只有 AppStorage 这条通道能把新路由/新标题送进已有窗口，
   * 所以这里必须重新发布一次启动参数。
   */
  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onNewWant（复用已有实例）');
    this.applyLaunchParams(want);
    this.handleSpeechProbeWant(want);
    this.handleAuthReturnWant(want);
    if (this.windowId.length > 0) {
      // 会话被改名后再从通知点进来，任务栏/诊断页里的标签要跟上
      relabelWindow(this.windowId, this.ledgerLabel());
    }
  }

  /**
   * 账号授权完成页的 `dsh://open` 回跳。
   *
   * 官方页面在 desktop 模式下既会自动跳该 URI，也会把它挂在「返回 DeepSeek
   * Harness」按钮上。系统随后用 viewData 启动本 Ability；主实例通常是复用路径
   * （onNewWant），但窗口可能仍处于后台，所以这里显式 restore/show 一次。
   */
  private handleAuthReturnWant(want: Want): void {
    const uri: string = typeof want.uri === 'string' ? want.uri.trim().toLowerCase() : '';
    if (uri !== AUTH_RETURN_URI || this.launchParams.kind !== WindowKind.MAIN) {
      return;
    }
    hilog.info(DOMAIN, TAG, '账号授权完成：收到 dsh://open，唤回主窗');
    if (this.mainWindow === undefined) {
      this.pendingAuthReturnWant = want;
      return;
    }
    this.ensureWindowShown();
  }

  /**
   * Task 1 长语音探针的启动参数入口（2026-10-18，人工诊断用）。
   *
   * 触发：`hdc shell aa start -b com.dshm.dshclient -a EntryAbility --ps dshProbe long --ps dshProbeSec 30`
   * 语义：只把参数转发给语音桥（探针在桥的轮询里跑），**不 await、不阻塞**生命周期；
   *       同一时刻只保留最新一条请求。真人不会用到，仅用于 Go/No-Go 取证。
   */
  private handleSpeechProbeWant(want: Want): void {
    const params: Record<string, Object> | undefined = want.parameters;
    if (params === undefined) {
      return;
    }
    const rawMode: Object | undefined = params['dshProbe'];
    if (rawMode === undefined) {
      return;
    }
    const mode: string = String(rawMode);
    const rawSecs: Object | undefined = params['dshProbeSec'];
    const parsed: number = rawSecs === undefined ? 30 : Number(String(rawSecs));
    const seconds: number = parsed > 0 ? parsed : 30;
    requestSpeechProbe(mode, seconds);
    hilog.info(DOMAIN, TAG, '语音探针请求：mode=%{public}s seconds=%{public}d', mode, seconds);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    // S2：窗口阶段建立（此后 loadContent → 首帧 → 宿主链，三段可分别计时）
    startupMarks.mark('S2', StartupPhase.WINDOW, 'window_stage_create');
    // Main window is created, set main page for this ability
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onWindowStageCreate');

    // 不把生命周期方法改成 async：系统按「回调返回」判断阶段完成，async 会让它就绪判定
    // 与实际就绪错位；且 ArkTS 会对浮动 Promise 报警。改为记下 Promise，需要时再续接。
    this.memoryReady = this.memory.attach(this.context);
    this.memoryReady.then(() => {
      hilog.info(DOMAIN, TAG, '窗口记忆已就绪（preferences）');
    }).catch((_error: Object) => {
      // attach 内部已兜底（失败时 store = undefined），这里只防御意外；不影响任何功能
      hilog.warn(DOMAIN, TAG, '窗口记忆 attach 异常，几何记忆降级');
    });

    // Host 连接记忆：只在**主窗**上做自动重连的读取与发布。
    // 会话窗（specified 启动、key = session:<id>）是「打开某个会话」，不是「启动应用」，
    // 让它也去自动重连会造成多窗口同时发起认证竞争——而连接池本来就该是单例，
    // 主窗做完之后其它窗口直接复用即可。
    /* 碰一碰接收：每个窗口建窗即注册（docs/421 WP2：会话窗是独立实例，
       原写法只在 MAIN 分支调用 ⇒ 会话窗完全没注册）。PC 档门控在函数内部。 */
    const desktopForced: boolean = readDeviceFacts().desktopForced;
    this.bootstrapKnockReceiver(windowStage, desktopForced);
    const deferNotify: boolean = DESKTOP_PROGRESSIVE_STARTUP && desktopForced &&
      this.launchParams.kind === WindowKind.MAIN;
    let logTaskWatchStart: boolean = false;
    if (this.launchParams.kind === WindowKind.MAIN) {
      // 主窗 stage 已就绪：`dsh/home` 此时必已可写，再写一次作为 onForeground 的兜底。
      writeAppLifecycle(this.context.filesDir, true, 'onWindowStageCreate');
      this.publishRememberedHost();
      // 通知也只在主窗注册：`SessionHub` 的钩子只有一个槽位，
      // 若每个窗口都注册，多窗口下会出现"发 N 条同样的通知"。
      this.shareDesktopNotifyPreparation = deferNotify;
      this.setupNotifications();
      logTaskWatchStart = this.startTaskWatch(deferNotify);
      if (!deferNotify) {
        this.preflightNotifications();
      }
      /* 【2026-11-07 时序修正】沉浸链必须等 mainWindow 落定后再跑：
         原先在这里调用时 `this.mainWindow` 还是 undefined ⇒ enterTabletImmersive 直接 return，
         真机日志里从来没有「平板沉浸」那一行 ⇒ 状态栏一直不沉浸。改到 afterWindowStageReady。 */
      this.setupScreenWatcher();

      /*
       * 申请长时任务（后台保活）：窗口**还在、只是不可见**时（最小化 / 切到别的应用 /
       * 只关了会话窗而主窗仍在后台）不让系统挂起本进程 —— 与 Host 的那条长连接与正在跑的
       * 任务都要靠它活着。分档（2026-10-13）：PC/2in1 档三键「关闭」已收进后台（`handleWindowWillClose`：
       * 只把主窗最小化、不终止进程）⇒ 正是这条保活要服务的形态；手持档三键「关闭」仍是
       * 官方行为 = 退出应用，那种情况下进程整体结束，不需要这条保活。
       *
       * 只在主窗申请：与会话窗共享同一进程，一个长时任务就够；
       * 每个实例各申请一次会让引用计数虚高、且系统侧重复登记。
       */
      this.keepAlive.attach(this.context);
      /*
       * 【2026-10-16：长时任务按**平台 + 时机**分开申请】
       *
       * · PC / 2in1 —— 仍在启动时申请：三键「关闭」是"收进后台"（`handleWindowWillClose`），
       *   窗口不可见而进程必须活着，正是这条保活要服务的形态。
       * · 手持档（手机 / 平板）—— **改到 `onBackground` 申请、`onForeground` 释放**：
       *   官方《长时任务(ArkTS)》明文建议"如果应用在前台时不希望存在长时任务通知，
       *   建议把申请推迟到 onBackground"；且只在**真有在跑的任务 / 待决事项**时才申请
       *   （`maybeAcquireHandheldKeepAlive()`），空闲切后台**完全不弹**那条
       *   「正在运行数据传输任务」——用户 2026-10-16 报"很吓人"的就是它。
       */
      if (!isHandheldForm()) {
        /*
         * PC / 2in1 的后台主体是 Agent / 模型计算，不是上传下载。
         * DATA_TRANSFER 首次进度超过 10 分钟未更新会被系统取消（官方硬约束）；
         * TASK_KEEPING 才是这一档的计算型长时任务。平台判定不支持时，
         * KeepAlive 内部会降级回 DATA_TRANSFER。
         */
        this.keepAlive.acquireTaskKeeping().then((active: boolean) => {
          if (active) {
            hilog.info(DOMAIN, TAG, '后台保活已就绪：PC/2in1 优先使用 TASK_KEEPING');
          } else {
            // 申请失败属**降级**而非错误：回到前台时仍会补拉状态。
            // 如实记日志，不假装成功（用户若发现切后台后任务停了，这条日志是判据）。
            hilog.warn(DOMAIN, TAG, '后台保活未授予，窗口不可见时任务可能中断（降级运行）');
          }
        }).catch((err: BusinessError) => {
          hilog.warn(DOMAIN, TAG, '后台保活申请异常（降级运行）：%{public}s', err.message);
        });
      } else {
        hilog.info(DOMAIN, TAG, '手持档：长时任务改到 onBackground 按需申请（前台不申请 ⇒ 无通知）');
      }

      // 托盘常驻图标：运行时挂上，左键唤回主窗（见 setupTray；退出用系统自带菜单项）
      this.setupTray();
    }

    // 主界面 = Web 壳页：官方 apps/desktop 的鸿蒙等价物（loadURL → Host web UI）。
    // Index/Poc1 保留在 main_pages 里（诊断/回退入口），不再是默认主页。
    // 手持形态（手机/平板）先接上「跟随屏幕旋转」再载入 Web 壳页：官方 Web 界面按桌面宽度排布，
    // 竖屏放不下两栏（2026-10-06 手机真机：设置对话框宽 1113 px，右侧内容被裁到屏外），
    // 横过来才完整；朝向交给传感器**且受系统旋转锁定管辖**（口径：锁定不转、解锁才转）。判据与理由见
    // platform 的 followScreenRotationOnHandheld；非手持形态（2in1/桌面）此处为空操作。
    followScreenRotationOnHandheld(windowStage);
    /*
     * 折叠屏再叠一层（2026-10-28，用户口径"折叠屏单屏显示时设置 UI 要竖屏"）：
     * 单屏（物理折叠 或 宽度 <600vp）⇒ 锁竖屏；展开 ⇒ 上面那条跟屏策略继续管。
     * **非折叠屏本调用直接早退**，手机/平板/PC 的既有行为一个字节不变。
     * 折叠/展开是运行期变化，函数内部订阅了 foldDisplayModeChange + foldStatusChange 并去抖重算。
     *
     * 【只认主窗（2026-10-29 复审修）】折叠朝向的持有者（foldWin）与事件重算都必须
     * 落在**主窗**上：本应用存在非 MAIN 的 UIAbility 实例（会议窗 / spec 窗等，见
     * WindowKind 的其它分支）。无守卫时，子窗创建会覆盖 foldWin、并对**子窗口**锁竖屏
     * ——之后折叠重算也作用于那个子窗，主窗朝向反而没人管。
     */
    if (this.launchParams.kind === WindowKind.MAIN) {
      applyFoldableOrientation(windowStage);
    }
    this.revokeDecorStyle();
    this.decorStage = windowStage;
    this.decorContentReady = false;
    // 每个 WindowStage 各有一份，后开的会话窗不会覆盖主窗的启动角色。
    const pageStorage: LocalStorage = new LocalStorage();
    pageStorage.setOrCreate<boolean>('dshStartupMainWindow', this.launchParams.kind === WindowKind.MAIN);
    windowStage.loadContent('pages/WebApp', pageStorage, (err) => {
      if (this.decorStage !== windowStage) {
        return;
      }
      this.decorContentReady = !err.code;
      if (err.code) {
        hilog.error(DOMAIN, 'testTag', 'Failed to load the content. Cause: %{public}s', JSON.stringify(err));
      } else {
        hilog.info(DOMAIN, 'testTag', 'Succeeded in loading the content.');
      }
      // 内容加载完成后再登记台账：台账是「窗口已可用」的证据面，登记过早会给出假阳性。
      // 加载失败也照常登记——台账要反映的是**窗口**，不是页面加载成功与否。
      this.afterWindowStageReady(windowStage);
      /* 【启动链埋点 2026-11-01】W 级：info 在端侧导出的日志里看不到（实证：本应用 0 条 I 级）。
       * 这一行是「页面树建好、准备调度宿主链」的证据点；没有它 ⇒ 连 loadContent 回调都没到。 */
      hilog.warn(DOMAIN, TAG, 'DSHM-TRACE loadContent 回调到达，准备调度宿主链');
      // S3：页面树已建好（首帧提交紧随其后）。这是"感知启动"的真实起点。
      startupMarks.mark('S3', StartupPhase.FIRST_FRAME, 'load_content_callback',
        err.code ? 'load-failed' : 'ok');
      // 首帧之后再拉宿主（见 HOST_START_DELAY_AFTER_FIRST_FRAME_MS 与 onCreate 里的注释）
      this.scheduleHostStartAfterFirstFrame(err.code ? 0 : HOST_START_DELAY_AFTER_FIRST_FRAME_MS);
      if (deferNotify) {
        this.scheduleDesktopNotifyPreflight(windowStage, !err.code, logTaskWatchStart);
      }
    });
  }

  /**
   * 把"取核心 + 起 Host"排到首帧之后（一次性）。
   *
   * 【为什么不在 onCreate 直接跑】见 `onCreate` 里那段注释：同步段会和首帧抢 ArkTS 线程，
   * 直接把 AGC 的启动时延指标顶穿。
   * 【为什么是一次性】同一个 Ability 实例可能多次走到 `onWindowStageCreate`（重建）；重复调度
   * 会让 `installBundled` 与 `host.start()` 排队跑第二遍（前者幂等但贵，后者会撞端口）。
   * 会话窗是**独立实例**，各自调度一次 —— 与改动前的 onCreate 口径逐字一致（`DshHost.start()`
   * 自己有 `isRunning()` 早退，第二份只会认领已存在的宿主，不会起第二个进程）。
   * 【失败兜底】`loadContent` 报错时按 0 延迟立刻跑 —— 页面已经不可用，此时优先把宿主拉起来。
   */
  /**
   * 按需启动 superagent（第二进程）。
   *
   * 【用户口径（2026-11-03）】共存 + 按需 + 非必选：
   *   · **共存**：superagent 有自己的进程（`:superagent`）与端口（3082），
   *     与工作宿主（3121/ondevice）同时在线，互不影响；
   *   · **按需**：只有存在 `start-superagent.request` 才拉起，绝不自启动；
   *   · **非必选**：没装 superagent 的用户完全不受影响 —— 两个前提任一不满足就什么都不做：
   *       ① 标记文件存在；② `<filesDir>/dsh/home/profiles/superagent` 目录存在
   *          （该目录由 `dsh superagent --from-default-profile` 创建，等于"用户确实装过"）。
   * 标记一次性消费（读完即删），失败只记日志，不影响主流程。
   */
  private startSuperagentIfRequested(): void {
    /*
     * 【2026-11-03（docs/354 §2.5）：失败不再静默】
     *
     * 事实：标记被消费、进程没起、日志一行没有 —— 因为 `startAbility` 失败（10104001
     * "ability not exist"，当时清单没注册）被 catch 后只打了一条 hilog，而标记已先删除。
     *
     * 现在的顺序：
     *   ① 有标记才继续（否则什么都不做 —— 非必选）
     *   ② profile 目录必须存在（用户确实部署过）
     *   ③ **先 startAbility，成功后才删标记**；失败则保留标记 + 落 `diag-superagent-start`
     */
    const dir = this.context.filesDir;
    const marker = `${dir}/start-superagent.request`;
    const diagFile = `${dir}/diag-superagent-start`;
    try {
      if (!fs.accessSync(marker)) {
        return;
      }
    } catch (e) {
      return;
    }
    const profileDir = `${dir}/dsh/home/profiles/superagent`;
    let installed = false;
    try {
      installed = fs.accessSync(profileDir);
    } catch (e) {
      installed = false;
    }
    if (!installed) {
      hilog.warn(DOMAIN, TAG,
        'superagent：收到启动请求，但 %{public}s 不存在 ⇒ 视为未安装，不启动（非必选）', profileDir);
      try {
        fs.unlinkSync(marker);
      } catch (e) { /* 忽略 */ }
      return;
    }
    const want: Want = {
      bundleName: this.context.applicationInfo.name,
      abilityName: 'SuperagentAbility',
    };
    hilog.warn(DOMAIN, TAG, 'superagent：拉起 %{public}s（端口 3082）', want.abilityName as string);
    this.context.startAbility(want).then(() => {
      hilog.warn(DOMAIN, TAG, 'superagent：startAbility 已受理 ⇒ 清理标记');
      try {
        fs.unlinkSync(marker);
      } catch (e) { /* 忽略 */ }
    }).catch((e: BusinessError) => {
      /* 保留标记（下次重启会再试），并把错误码与 want 落盘，现场可直接 grep */
      const diag = `{"at":"${new Date().toISOString()}","code":${e.code},"message":${JSON.stringify(e.message)},`
        + `"abilityName":"${want.abilityName as string}","bundleName":"${want.bundleName as string}"}`;
      try {
        const f: fs.File = fs.openSync(diagFile,
          fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
        fs.writeSync(f.fd, diag);
        fs.closeSync(f);
      } catch (e2) { /* 诊断写不进去也不能影响主流程 */ }
      hilog.error(DOMAIN, TAG,
        'superagent：startAbility 失败（%{public}d）%{public}s ⇒ 已写 %{public}s，标记保留',
        e.code, e.message, diagFile);
    });
  }

  /**
   * 预热 ArkWeb 引擎（全局一次，与宿主启动并行）。
   *
   * 【为什么要单独一个方法】`initializeWebEngine()` 是静态全局能力，必须在 UI 线程调用；
   * 抽出来配合模块级 `webEngineWarmed` 守卫，保证多窗口（specified 实例）下只调一次。
   * 任何异常都只记日志：引擎装载失败时 Web 组件首次挂载会自建引擎，功能不受影响。
   */
  private warmWebEngineOnce(): void {
    if (webEngineWarmed) {
      return;
    }
    webEngineWarmed = true;
    const t0: number = Date.now();
    try {
      webview.WebviewController.initializeWebEngine();
      hilog.warn(DOMAIN, TAG, 'DSHM-TRACE ArkWeb 引擎预热完成（%{public}d ms，与宿主启动并行）',
        Date.now() - t0);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'ArkWeb 引擎预热失败（降级：Web 组件首挂时自建）：%{public}s',
        (e as Error).message);
    }
  }

  private scheduleHostStartAfterFirstFrame(delayMs: number): void {
    if (this.hostStartScheduled) {
      return;
    }
    this.hostStartScheduled = true;
    setTimeout(async (): Promise<void> => {
      hilog.warn(DOMAIN, TAG, '首帧后启动宿主链（延迟 %{public}d ms）', delayMs);
      // S4：宿主链开始（S4→S5 就是"起核心 + 起 Node"的真实成本）
      startupMarks.mark('S4', StartupPhase.HOST, 'host_chain_scheduled', `delay=${delayMs}ms`);
      /*
       * 【启动链埋点 2026-11-01】3 秒心跳：区分"卡住"与"只是慢"。
       * 下面这个 await（目录授权）在启动页盖着的时候跑；不 resolve 就到不了 startHost。
       * 等待期间每 3 秒一行 W，抓一次日志即可看出停在哪一段、等了多久。进入 Host 链前 clear。
       */
      const waitedFrom: number = Date.now();
      const ticker: number = setInterval(() => {
        hilog.warn(DOMAIN, TAG, 'DSHM-TRACE 宿主链仍在前置等待（已等 %{public}d ms）',
          Date.now() - waitedFrom);
      }, 3000);
      let grants: string;
      try {
        grants = await this.folderGrantsReady;
        hilog.warn(DOMAIN, TAG, '宿主启动前确认目录授权：%{public}s', grants);
      } finally {
        clearInterval(ticker);
      }
      this.autoStartHostForDiagnosis();
      // 桌面主窗由预挂 Web 初始化引擎。其他窗口先让宿主启动链继续，再同步预热。
      if (!DESKTOP_PROGRESSIVE_STARTUP || !readDeviceFacts().desktopForced ||
        this.launchParams.kind !== WindowKind.MAIN) {
        setTimeout((): void => {
          this.warmWebEngineOnce();
        }, 0);
      }
      /*
       * ── superagent 的**手动**起停（2026-11-02，docs/346 §4 方案 A）────────────
       * 官方要求它跑在独立 profile / 独立端口 / 能独立重启；端侧只有"第二进程"能做到，
       * 所以它是 `module.json5` 里带 `"process": "superagent"` 的独立 ability。
       * 这里用**标记文件**做手动触发（用户口径：不自动启，避免常驻多占内存）：
       *   创建 `<公共下载目录>/start-superagent.request` ⇒ 下次启动宿主时拉起它
       * 启动后立刻删标记：不重入、不留副作用。失败只记日志，绝不影响主宿主。
       */
      this.startSuperagentIfRequested();
    }, delayMs);
  }

  /**
   * 碰一碰接收引导（2026-11-17，对照 WorkBuddy 逆向文档）：主窗建窗即注册。
   *
   * 【为什么提前】原实现等 Web 页面就绪（onPageEnd）才注册，页面起来前系统侧无接收方；
   * WorkBuddy 在应用窗口就绪即调用 startKnockReceive，官方示例亦在 aboutToAppear 注册。
   *
   * 【为什么用主窗 id】注册必须绑定「被碰的那个窗口」；主窗用 windowStage 的真实 id
   * （比 getLastWindow 确定，多窗下 getLastWindow 可能拿到会话窗）。
   *
   * 【失败兜底】注册异常只留痕不抛：接收器内部按 1/2/4/8s 退避重试，且不影响任何既有功能。
   */
  private bootstrapKnockReceiver(windowStage: window.WindowStage, desktopForced: boolean): void {
    try {
      if (!desktopForced) {
        return;
      }
      const mainWindow: window.Window = windowStage.getMainWindowSync();
      const windowId: number = mainWindow.getWindowProperties().id;
      this.knockWindowId = windowId;
      KnockShareReceiver.bootstrap(this.context, windowId);
      hilog.info(DOMAIN, TAG, '碰一碰：建窗即注册 windowId=%{public}d', windowId);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '碰一碰：建窗注册异常 %{public}s', JSON.stringify(e));
    }
  }

  onWindowStageDestroy(): void {
    this.revokeDecorStyle();
    // Main window is destroyed, release UI related resources
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onWindowStageDestroy');

    // 只清理**本实例**的东西。这里刻意不触碰任何共享资源，也不遍历其他窗口——
    // 「关任一窗口不影响其他窗口与其连接」这条验收，正是靠这里的克制成立的。
    if (this.geometryTimer !== -1) {
      clearTimeout(this.geometryTimer);
      this.geometryTimer = -1;
    }
    // 折叠事件解绑（幂等；非折叠屏本调用是空操作）。不解绑会在多窗口场景里重复订阅。
    // 【同样只认主窗（2026-10-29）】子窗先销毁时若在此解绑，会把仍活着的主窗的
    // 折叠监听一并拆掉（onWindowStageCreate 不会重跑 ⇒ 主窗从此失去折叠感知）。
    if (this.launchParams.kind === WindowKind.MAIN) {
      releaseFoldableOrientation();
    }
    // 碰一碰：窗口销毁才注销（docs/421 WP1；页面销毁只 detachPage）
    if (this.knockWindowId >= 0) {
      KnockShareReceiver.release(this.knockWindowId);
      hilog.info(DOMAIN, TAG, '碰一碰：窗口销毁释放 windowId=%{public}d', this.knockWindowId);
      this.knockWindowId = -1;
    }
    this.decorContentReady = false;
    this.decorStage = undefined;
    this.unbindGeometry(this.mainWindow);
    this.mainWindow = undefined;
    if (this.windowId.length > 0) {
      unregisterWindow(this.windowId);
      hilog.info(DOMAIN, TAG, '窗口已注销 id=%{public}s', this.windowId);
      this.windowId = '';
    }
  }

  /**
   * 系统发起的关闭（**PC/2in1 档**：任务栏右键「退出」/ 托盘右键里系统自带的「退出」；
   * **手持档**：窗口右上角「关闭」/ 任务栏退出 / 托盘退出）的钩子，也是整条退出链上
   * **唯一能可靠摘掉托盘图标**的时机。
   *
   * 【分档语义（2026-10-13）】
   *   · 手持档（手机 / 平板）：返回 `false` = 继续终止 ⇒ **鸿蒙默认的退出语义**，
   *     本应用不改它：「关闭」就是退出。
   *   · PC/2in1 档：标题栏那个「关闭」已被 `windowWillClose` 拦成"收进后台"
   *     （见 `handleWindowWillClose`），**不**走这里；走到这里的是托盘 / 任务栏那条
   *     **真退出**（同样返回 `false` 继续终止，只借这个时机补收尾：摘图标 / 通知托盘进程 / 停核心）。
   *
   * 【SDK 原文】"Triggered by the system just before the UIAbility is about to close (for example,
   * when the user clicks the close button in the top-right corner of the application window or
   * exits from the dock or system tray)"，需 `ohos.permission.PREPARE_APP_TERMINATE`
   * （module.json5 已声明）。SDK 列出的三个"本回调不会被调用"的条件本工程都不满足：
   * 没实现 `onPrepareToTerminateAsync`、`AppAbilityStage` 没实现 `onPrepareTermination*`、
   * 也没注册 `windowStageClose` 监听。
   *
   * 【为什么非得在这里做】`removeFromStatusBar` 的 SDK 前置是"有前台窗口"（无则
   * 1010710004），而本回调在窗口被销毁**之前**触发。系统直接结束进程的那类退出不经过它，
   * 那种情况只能靠下次 `install()` 的"先摘残留"兜底（force-stop 也一样）。
   *
   * 【只认最后一个窗口】会话窗（specified 实例）关闭不该牵动整个应用；还有别的窗口活着时
   * 应用没退，托盘图标要留着当回程入口。
   */
  onPrepareToTerminate(): boolean {
    if (this.launchParams.kind !== WindowKind.MAIN || windowCount() > 1) {
      return false;
    }
    if (this.exiting) {
      return false;
    }
    this.exiting = true;
    // 探针：这一行与 `diag-window-close` 里的「windowWillClose 拦截成功」一起回答
    // 「两个回调能不能共存」（见 onWindowWillClose 的注释）：PC 档点三键关闭时若**只有**
    // 拦截那一行而没有本行，说明平台取消关闭后**没有**再走终止链（期望形态）；
    // 两行都在则说明本回调仍被触发，需要在文档 §真机待验 里按回退方案处置。
    // 只写诊断文件，不碰业务路径；顺序（先置 exiting 再落盘）不可动。
    writeWindowCloseDiag(this.context.filesDir,
      `onPrepareToTerminate 到达（本次仍按系统默认退出）：main=${this.launchParams.kind === WindowKind.MAIN}`);
    // 不 await：系统按本回调的返回值决定是否继续终止，回调必须立刻返回。
    // 收尾里 `host.stop()` 的"停止请求"文件是**同步**写下的（见 DshHost.stop），
    // 所以即使进程随后就被结束，宿主也已经收到停止请求。
    this.finalizeBeforeExit('系统关闭主窗（最后一个窗口）').catch((err: BusinessError) => {
      hilog.warn(DOMAIN, TAG, '系统关闭路径收尾异常（进程即将结束）：%{public}s', err.message);
    });
    return false;
  }

  /**
   * 返回（实体键 / 侧滑手势）—— 2026-11-07。
   *
   * 【为什么能力层也要接】真机：平板/手机侧滑返回**没有经过页面的 `onBackPress()`**，
   * 系统按"无人消费"处理 ⇒ 直接切回桌面（用户报"左右滑就回桌面了"）。
   * 这里对**手持档**一律接住（返回 true），把"这一记返回该关掉什么"交给页面：
   * 页面收到 `dshBackTick` 后执行 BACK_SHIM 的逐级消费（浮层 → 右栏 → 抽屉 → 面板首页），
   * 真的没有可关的层时才由页面调 `minimizeToBackground()` 补上系统默认。
   * PC / 2in1（`!isHandheldForm()`）不接，逐字保持原行为。
   */
  onBackPressed(): boolean {
    if (!isHandheldForm()) {
      return false;
    }
    const tick: number = AppStorage.get<number>(KEY_BACK_TICK) ?? 0;
    AppStorage.setOrCreate<number>(KEY_BACK_TICK, tick + 1);
    return true;
  }

  onForeground(): void {
    // Ability has brought to foreground
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onForeground');
    /*
     * 【先置前台、再释放】晚到 acquire 的第二个判据就是它（见 releaseHandheldKeepAlive 头注）。
     * 顺序不能反：先 release 再置假的话，中间窗口里晚到的 `.then` 仍会看到"还在后台"。
     */
    this.revokeDecorStyle();
    this.appBackgrounded = false;
    this.decorForeground = true;
    this.refreshDecorCaps(this.mainWindow);
    if (this.launchParams.kind === WindowKind.MAIN) {
      writeAppLifecycle(this.context.filesDir, true, 'onForeground');
    }

    /*
     * 【手持档：回前台就释放长时任务】通知的生命周期与任务绑定（官方《长时任务(ArkTS)》）
     * ⇒ 释放即撤掉那条「正在运行数据传输任务」；同时清掉"用户停过"的标志，
     * 让**下一个**后台周期可以重新按需申请（官方接入规范只禁止"立即再申请"）。
     */
    this.keepAlive.noteForeground();
    this.keepAlive.noteBackground(false);
    /*
     * 【回前台重置授权缓存（2026-11-04）】`prepareNotify()` 只查一次并缓存结论；用户很可能
     * 就是在"发现没通知"之后才去设置里打开的。不重置的话，本次进程内永远认为"没授权"。
     */
    this.notifyChecked = false;
    this.desktopNotifyPreflight = undefined;
    this.releaseHandheldKeepAlive();
    /* 回前台重置"熄屏补申请只试一次"的标志：下一个前台周期允许再补一次。 */
    this.desktopKeepAliveRetried = false;
    // 回前台也收敛一次：切换外观 → 回前台这条路上，页面那条链可能还没跑完
    this.reassertWindowChrome('foreground');

    // 回到前台时确保主窗真的在屏上。
    //
    // 【为什么需要在 onForeground 里做】从托盘图标 / Dock / 任务栏唤回本应用时，系统只是把任务
    // 切到前台，并不一定撤销窗口的**最小化**状态（用户可能自己最小化过，或窗口停在别的虚拟桌面）。
    // 这里补一次恢复，点图标才真的看得到界面。
    if (this.launchParams.kind === WindowKind.MAIN) {
      this.ensureWindowShown();
    }
  }

  /**
   * 手持档进后台：**只有真有活干**才申请长时任务（没有就不申请 ⇒ 不弹那条通知）。
   *
   * 【判据取哪】`SessionHub.snapshot()` 的 `running`（有一轮对话在跑）与 `pending`（有待决的
   * 审批 / 提问）——它们是"应用不在前台也必须活着"的唯一两类事。两者都空就是纯浏览/闲置，
   * 系统冻结本进程不影响任何在途结果（回前台会自动补拉状态，见 `adoptLocalHost` / 重连链）。
   *
   * 【为什么放在 onBackground 而不是 onCreate】官方明文建议；且用户在 2026-10-16 明确反馈
   * 常驻通知"很吓人"。
   */
  /**
   * 任务状态轮询（2026-11-04，任务完成通知/提示音的主链路）。
   *
   * 【为什么轮询文件、而不是听 WebView 事件】用户需求是「**不论 App 在前台还是后台**」。
   * WebView 的 turn 事件在后台会被节流/挂起，实测结果就是"完全没有通知"。
   * 宿主（Host）对前后台无感，它把 turn 生命周期写进 `task-state.json`；
   * ArkTS 每 5 s 读一次即可，恢复前台时也能补齐（不丢事件）。
   *
   * 【两条动作】
   *   · `active=true` 且 taskId 变了 ⇒ 发"任务进行中"进度通知（静默、ongoing）
   *   · `seq` 变新（一次新的结束）⇒ 撤进度 → 发"任务完成"（新 ID + 带声音渠道）
   *     → 发布失败才播随包提示音兜底
   */
  private startTaskWatch(deferDiagnostic: boolean): boolean {
    if (this.taskWatchTimer !== -1) {
      return false;
    }
    this.taskWatchTimer = setInterval((): void => {
      this.pollTaskState();
    }, 5000);
    if (!deferDiagnostic) {
      this.diagTaskWatch(`watch started filesDir=${this.context.filesDir}`);
    }
    hilog.info(DOMAIN, TAG, '任务状态轮询已启动（5 s；源 task-state.json）');
    return deferDiagnostic;
  }

  private stopTaskWatch(): void {
    if (this.taskWatchTimer !== -1) {
      clearInterval(this.taskWatchTimer);
      this.taskWatchTimer = -1;
    }
  }

  /**
   * 轮询诊断（独立于通知权限，2026-11-04 复测反馈"连 diag-notify 都没有"）。
   *
   * 【为什么必须另开一个文件】`diag-notify` 只在**真的走到 publish** 时才写；一旦
   * 权限检查失败或 `task-state.json` 不存在，整条链静默 ⇒ 现场无法区分
   * "轮询没跑 / 文件没写 / 权限没开 / 发布失败" 四种情况。这个文件每次轮询都记一行事实。
   */
  private diagTaskWatch(line: string): void {
    try {
      const p: string = `${this.context.filesDir}/diag-taskwatch`;
      const f: fs.File = fs.openSync(p, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.APPEND);
      try {
        fs.writeSync(f.fd, `${new Date().toISOString()} ${line}\n`);
      } finally {
        fs.closeSync(f);
      }
    } catch (e) {
      /* 诊断失败不影响任务 */
    }
  }

  private pollTaskState(): void {
    let text: string = '';
    try {
      /*
       * 【路径必须与 Host 一致（2026-11-04 复测三）】
       * Host 写的是 `$DSH_HOME/task-state.json`，而 `DSH_HOME` 在端侧恒为
       * `<filesDir>/dsh/home`（见 hostcore/app/main.js 的 HOME_DIR）。
       * 上一版这里写成了 `<filesDir>/task-state.json` —— 两个目录，永远读不到，
       * 表现为"轮询在跑、文件不存在"。同目录下 `card-state.json` 证明这条路径是对的。
       */
      const p: string = `${this.context.filesDir}/dsh/home/task-state.json`;
      if (!fs.accessSync(p)) {
        this.diagTaskWatch(`poll: 读不到 ${p}（Host 还没写 / turn 事件没到？）`);
        return;
      }
      text = fs.readTextSync(p);
    } catch (e) {
      this.diagTaskWatch(`poll: 读 task-state.json 失败 ${(e as Error).message}`);
      return;
    }
    let rec: Record<string, Object> = {};
    try {
      rec = JSON.parse(text) as Record<string, Object>;
    } catch (e) {
      return;
    }
    const active: boolean = rec.active === true;
    const taskId: string = String(rec.taskId ?? '');
    /*
     * 【2026-11-11 点击直达】task-state.json 本来就带 sessionId（hostcore 写入），
     * 但这里从没读过它 ⇒ 完成/进度通知挂不上路由，点击只能把应用拉到前台。
     */
    const taskSessionId: string = String(rec.sessionId ?? '');
    const title: string = String(rec.title ?? '').length > 0 ? String(rec.title) : 'DSHM 任务';
    const state: string = String(rec.state ?? '');
    const seq: number = Number(rec.seq);
    if (!Number.isFinite(seq)) {
      return;
    }
    const at: string = String(rec.at ?? '');
    const doneKey: string = `${taskId}|${at}`;
    const turn: number = Number(rec.turn);
    const durationMs: number = Number(rec.durationMs);
    /* "第 N 轮" + 耗时：让同一会话里反复跑的任务在通知栏可区分（用户反馈"内容都一样"）。 */
    const turnLabel: string = Number.isFinite(turn) && turn > 0 ? `第 ${turn} 轮` : '';
    const secs: number = Number.isFinite(durationMs) && durationMs > 0
      ? Math.max(1, Math.round(durationMs / 1000)) : 0;
    /* 首轮只对齐基线：装包后的第一次轮询不该把"上一个已完成任务"再弹一遍。 */
    if (!this.taskWatchPrimed) {
      this.taskWatchPrimed = true;
      this.lastDoneKey = active ? '' : doneKey;
      /*
       * 【基线不能吞掉"正在跑的任务"（2026-11-04 复测三）】旧写法在 active=true 时把
       * `progressTaskId` 直接设成本次 taskId，导致下一拍判定"taskId 没变" ⇒ **进度通知永远不发**
       * （复测里只看到了 completion）。置空后，下一拍就会为该任务发一次进度通知。
       */
      this.progressTaskId = '';
      this.diagTaskWatch(`primed: active=${active} taskId=${taskId} seq=${seq} state=${state} at=${at}`);
      return;
    }
    this.diagTaskWatch(`poll: active=${active} taskId=${taskId} seq=${seq} state=${state}`
      + ` lastDoneKey=${this.lastDoneKey.length > 0 ? 'set' : 'empty'}`
      + ` progressTaskId=${this.progressTaskId}`);
    /* ① 任务开始：发进度通知（同一 taskId 只发一次） */
    if (active && taskId.length > 0 && taskId !== this.progressTaskId) {
      this.progressTaskId = taskId;
      /*
       * 【不再"权限不就绪就 return"（2026-11-04 复测二的教训）】
       * 旧写法在 `ensureNotifyReady()` 假时直接返回，**一条日志都不留**，
       * 于是现场看到的是"什么都没有"，无法区分权限/渠道/发布哪个环节。
       * 现在：照常尝试申请，然后把发布交给 NotificationCenter —— 它内部会在
       * `enabled=false` 时写 `progress SKIP …`、失败时写 `completion FAIL code=…`。
       */
      this.ensureNotifyReady().then((_ok: boolean) => {
        const progressText: string = turnLabel.length > 0
          ? `${title} · ${turnLabel} · 正在执行` : `${title} · 正在执行`;
        this.notifier.publishProgress(taskId, 'DSHM 任务进行中', progressText, taskSessionId).then((pid: number) => {
          this.diagTaskWatch(`publishProgress → id=${pid}`);
        }).catch((_e: Object) => {
        });
      }).catch((_e: Object) => {
      });
      return;
    }
    /* ② 任务结束：seq 变新 ⇒ 完成通知 + 兜底提示音 */
    if (!active && doneKey !== this.lastDoneKey) {
      this.lastDoneKey = doneKey;
      this.progressTaskId = '';
      const failed: boolean = state === 'error';
      this.ensureNotifyReady().then((_ok: boolean) => {
        const head: string = failed ? '任务失败' : '任务完成';
        const titleLine: string = turnLabel.length > 0 ? `${head} · ${turnLabel}` : head;
        const tail: string = secs > 0 ? `已完成 · 耗时 ${secs} 秒` : (failed ? '执行失败' : '已完成');
        const body: string = `${title} · ${tail}`;
        this.notifier.publishCompletion(taskId.length > 0 ? taskId : 'task', titleLine,
          body, failed, taskSessionId).then((id: number) => {
          this.diagTaskWatch(`publishCompletion → id=${id} failed=${failed}`);
          /*
           * 【2026-11-05 口径：提示音一律走**系统**提示音，不用随包音频】
           *
           * 依据：系统通知的提示音由**渠道（slot）**决定，用户在「设置 → 通知 → 本应用」里
           * 可以单独换铃声或静音；这是抖音/微信这类应用的通行做法 —— 应用只发通知，
           * 声音的所有权交给系统。应用自己额外播一份音频会：
           *   ① 与系统通知音**双响**；
           *   ② 绕过用户的静音选择（用户静音了应用，却仍被随包音频打扰）；
           *   ③ 三端表现不一致（本文件此前"通知发不出才播"、phone 端"无条件播"）。
           * 因此这里**不再播放随包音频**，只落一行诊断，便于下轮取证"通知到底发没发出去"。
           * 渠道静音时由 `NotificationCenter.ensureSlots()` 重建渠道 / 改走 SOCIAL_COMMUNICATION
           * 保证系统提示音响得起来（见该文件「重建后仍静音」分支）。
           */
          if (id <= 0) {
            this.diagTaskWatch('done-sound: 通知未发出 ⇒ 无提示音（随包音频已按口径停用）');
          } else {
            this.diagTaskWatch(`done-sound: 由系统通知渠道音负责 id=${id}`);
          }
        }).catch((_e: Object) => {
        });
      }).catch((_e: Object) => {
      });
    }
  }

  /** 通知就绪（授权 + 渠道）；失败不抛，交给调用方决定降级。 */
  private async ensureNotifyReady(): Promise<boolean> {
    try {
      return await this.prepareNotify();
    } catch (e) {
      return false;
    }
  }

  /**
   * 读 Host 写的「还有多少活要干」快照（`<filesDir>/workload.json`）。
   *
   * 【为什么必须有它（2026-11-03，平板后台任务真机反馈）】原有的忙判据全部来自
   * **界面投影**（SessionHub 的 running/pending/streams/outbox）。而"熄屏那一刻"界面投影
   * 常常是 idle 或晚一拍，于是被判成"无诉求" ⇒ 不申请长时任务 ⇒ 进程被冻结、
   * agent turn 与后台 job 一并中断。这条路径把 Host 侧的**在途事实**直接读进来：
   *   refs = (会话在跑 ? 1 : 0) + 在途安装数（`install-queue/*.req`）
   * （Host 侧写入点见 `hostcore/app/main.js` 的内存看门狗 tick，10 s 一次。）
   *
   * 读不到就当 0 —— 不因此判定"忙/闲"，交给其余四个判据决定。
   */
  private workloadRefs(): number {
    try {
      const p: string = `${this.context.filesDir}/dsh/home/workload.json`;
      if (!fs.accessSync(p)) {
        return 0;
      }
      const text: string = fs.readTextSync(p);
      const parsed: Record<string, Object> = JSON.parse(text) as Record<string, Object>;
      const refs: number = Number(parsed.refs);
      return Number.isFinite(refs) && refs > 0 ? refs : 0;
    } catch (e) {
      return 0;
    }
  }

  /**
   * 读「还有没有等触发的定时任务」（Host 写在 `workload.json` 的 `scheduledTasks`）。
   *
   * 熄屏时没有运行中的 turn、也没有安装队列，旧判据会算成"没事" ⇒ 不申请长时任务
   * ⇒ 进程被冻结 ⇒ 到点的调度要等亮屏补跑。`refs` 已由 Host 计入调度（`+1`），
   * 这里再单独读一次是为了诊断行能写清"有几条、下一条什么时候"。
   */
  private workloadSchedules(): number {
    try {
      const p: string = `${this.context.filesDir}/dsh/home/workload.json`;
      if (!fs.accessSync(p)) {
        return 0;
      }
      const parsed: Record<string, Object> = JSON.parse(fs.readTextSync(p)) as Record<string, Object>;
      const count: number = Number(parsed.scheduledTasks);
      return Number.isFinite(count) && count > 0 ? count : 0;
    } catch (e) {
      return 0;
    }
  }

  /** 下一条定时任务的 UTC 时刻（仅诊断用；读不到写 `-`）。 */
  private workloadNextSchedule(): string {
    try {
      const p: string = `${this.context.filesDir}/dsh/home/workload.json`;
      if (!fs.accessSync(p)) {
        return '-';
      }
      const parsed: Record<string, Object> = JSON.parse(fs.readTextSync(p)) as Record<string, Object>;
      const next: string = String(parsed.nextScheduleAt);
      return next.length > 0 && next !== 'null' && next !== 'undefined' ? next : '-';
    } catch (e) {
      return '-';
    }
  }

  /** 屏幕熄灭前的保活补齐：手机 / 平板走按需申请，PC/2in1 补一次失败重试。 */
  private maybeAcquireBeforeScreenOff(): void {
    this.maybeAcquireHandheldKeepAlive();
    if (isHandheldForm() || this.keepAlive.facts().active || this.desktopKeepAliveRetried) {
      return;
    }
    if (this.workloadSchedules() <= 0 && this.workloadRefs() <= 0) {
      return;
    }
    this.desktopKeepAliveRetried = true;
    this.keepAlive.acquireTaskKeeping().then((active: boolean) => {
      if (!active) {
        hilog.warn(DOMAIN, TAG, '熄屏前补申请保活未授予（降级运行）');
      }
    }).catch((err: BusinessError) => {
      hilog.warn(DOMAIN, TAG, '熄屏前补申请保活异常（降级运行）：%{public}s', err.message);
    });
  }

  private maybeAcquireHandheldKeepAlive(): void {
    if (!isHandheldForm() || this.handheldKeepAliveHeld) {
      return;
    }
    let busy: boolean = false;
    let needNote: string = '';
    try {
      const snap = SessionHub.shared().snapshot();
      /*
       * 【2026-10-28 扩宽判据（内测反馈"熄屏就断"）】原来只看 `running` 与 `pending` ——
       * 那是**界面投影**：Host 侧明明还在跑模型 / 还有待发队列，投影却可能仍是 idle（或晚一拍）
       * ⇒ 熄屏那一刻被判成"没事" ⇒ 不申请长时任务 ⇒ 进程被冻。
       * 现在把三个**在途事实**一起算：
       *   · `activeStreams` —— 控制流 + follow 逻辑流还开着（Host 正在推事件）；
       *   · `outbox`        —— 还有待发队列；
       * 加上原有的 `running` / `pending`。四项读数落 diag-keepalive，真机反馈可逐项对账。
       */
      /*
       * 【并入 Host 侧在途事实（2026-11-03）】`workload.json` 的 refs 含"agent turn 在跑"
       * 与"在途安装"——它们与界面投影无关，熄屏那一刻也照样是真的 ⇒ 不会再被判成"无诉求"。
       */
      const refs: number = this.workloadRefs();
      const schedules: number = this.workloadSchedules();
      busy = snap.running === true || snap.pending.length > 0
        || snap.activeStreams > 0 || snap.outbox > 0 || refs > 0 || schedules > 0;
      needNote = `running=${snap.running === true} pending=${snap.pending.length}`
        + ` streams=${snap.activeStreams} outbox=${snap.outbox} workloadRefs=${refs}`
        + ` schedules=${schedules} next=${this.workloadNextSchedule()}`;
    } catch (e) {
      // 读不到就按"有事"处理：宁可多弹一次通知，也不要让在跑的任务被冻死
      busy = true;
      needNote = `snapshot 读取失败：${(e as Error).message}`;
      hilog.warn(DOMAIN, TAG, '读会话状态失败，按"有事"申请保活：%{public}s', (e as Error).message);
    }
    /* 告诉 KeepAlive「本后台周期我们想保活」——它是"被系统取消后要不要续期"的唯一判据。 */
    this.keepAlive.noteBackground(busy);
    this.keepAlive.recordNeed(`${needNote} ⇒ busy=${busy}`);
    if (!busy) {
      hilog.info(DOMAIN, TAG, '手持档进后台：当前没有在跑的任务 / 待决事项 ⇒ 不申请保活（无通知）');
      return;
    }
    this.handheldKeepAliveHeld = true;
    /*
     * 【晚到结果必须对账（2026-10-29）】申请本身是异步的；用户可能在这期间回到前台。
     * 回前台时 `releaseHandheldKeepAlive()` 会把代次 +1 并 release —— 但那次 release 发生时
     * `KeepAlive.refs` 里还没有这一次 acquire（它尚未完成），所以它退不掉本次申请。
     * 于是这里在成功返回后**再看一眼代次与前后台**：任一变了就立刻 release 掉，
     * 绝不把"前台残留长时任务/通知"留给下一轮后台回收。
     */
    const generation: number = this.keepAliveGeneration;
    /*
     * 【平板 / PC 走 TASK_KEEPING（2026-11-03，测试用户反馈"平板端无法后台任务"）】
     * DATA_TRANSFER 有官方硬约束：首次进度超过 10 分钟未更新会被系统**取消**长时任务，
     * 随后进程进入冻结 —— 长 agent turn / 长安装正是这么被打断的（MatePad Edge 真机日志
     * 已抓到该取消）。计算型 TASK_KEEPING 没有这条约束（`backgroundModes` 里已声明
     * `taskKeeping`，权限面不变）。设备不支持时 `acquireTaskKeeping()` 自己会降级回
     * DATA_TRANSFER（见 KeepAlive.acquireTaskKeeping 的实现注释）。
     */
    this.keepAlive.acquireTaskKeeping().then((active: boolean) => {
      if (!active) {
        this.handheldKeepAliveHeld = false;
        hilog.warn(DOMAIN, TAG, '手持档后台保活未授予（降级：任务可能被冻结，回前台补拉）');
        return;
      }
      if ((!this.appBackgrounded && !this.screenOffed) || generation !== this.keepAliveGeneration) {
        this.handheldKeepAliveHeld = false;
        hilog.info(DOMAIN, TAG, '晚到的后台保活已被回前台作废 ⇒ 立即回收（代次 %{public}d→%{public}d）',
          generation, this.keepAliveGeneration);
        this.keepAlive.release().catch((err: BusinessError) => {
          hilog.warn(DOMAIN, TAG, '晚到长时任务回收失败：%{public}s', err.message);
        });
        return;
      }
      hilog.info(DOMAIN, TAG, '手持档后台保活已就绪（有在跑的任务 / 待决事项）');
    }).catch((err: BusinessError) => {
      this.handheldKeepAliveHeld = false;
      hilog.warn(DOMAIN, TAG, '手持档后台保活申请异常（降级运行）：%{public}s', err.message);
    });
  }

  /** 手持档回前台：释放这轮后台保活（与 `maybeAcquireHandheldKeepAlive()` 一一对应）。 */
  private releaseHandheldKeepAlive(): void {
    /*
     * 【先递增代次，再判断 held】顺序不能反：即使此刻 `held=false`（申请还在路上），
     * 也要让那个晚到的 `.then` 看到"代次变了"从而回收自己。反过来的话，
     * 这条提前 return 会把唯一的作废信号吞掉，竞态就落回"前台残留任务"。
     */
    this.keepAliveGeneration++;
    if (!this.handheldKeepAliveHeld) {
      return;
    }
    this.handheldKeepAliveHeld = false;
    this.keepAlive.release().then(() => {
      hilog.info(DOMAIN, TAG, '手持档回前台：长时任务已释放（通知随之消失）');
    }).catch((err: BusinessError) => {
      hilog.warn(DOMAIN, TAG, '手持档释放长时任务异常：%{public}s', err.message);
    });
  }

  /**
   * 注册屏幕亮灭监听（2026-10-31，docs/326）。
   *
   * 【为什么必须监听屏幕】手持档的长时任务是 `DATA_TRANSFER`，官方契约是
   * "首次进度后 **10 分钟**没有更新即被系统取消"。而我们的续期靠 `setTimeout`，
   * **熄屏后 JS 定时器被系统冻结** ⇒ "被取消后再续期"这条路径在熄屏场景天然失效，
   * 用户看到的就是"熄屏后任务就不执行了"。
   *
   * 唯一可靠的做法是在**屏幕即将熄灭时主动把长时任务重申请一次**，
   * 让系统的 600s 无进度计时归零（见 `KeepAlive.noteScreenState`）。
   *
   * 失败只记日志：拿不到公共事件（老设备/权限）时降级为原来的行为，不影响其它功能。
   */
  private setupScreenWatcher(): void {
    if (this.screenWatcherReady) {
      return;
    }
    this.screenWatcherReady = true;
    const subscribe: commonEventManager.CommonEventSubscriber | undefined =
      commonEventManager.createSubscriberSync({
        events: [commonEventManager.Support.COMMON_EVENT_SCREEN_OFF,
          commonEventManager.Support.COMMON_EVENT_SCREEN_ON]
      });
    if (subscribe === undefined) {
      hilog.warn(DOMAIN, TAG, '屏幕监听订阅创建失败（降级：熄屏后不主动续期）');
      return;
    }
    this.screenSubscriber = subscribe;
    try {
      commonEventManager.subscribe(subscribe, (err: BusinessError, data: commonEventManager.CommonEventData) => {
        if (err) {
          hilog.warn(DOMAIN, TAG, '屏幕事件回调异常：%{public}s', err.message);
          return;
        }
        const off: boolean = data.event === commonEventManager.Support.COMMON_EVENT_SCREEN_OFF;
        hilog.info(DOMAIN, TAG, '屏幕事件：%{public}s ⇒ 校准长时任务',
          off ? '熄灭' : '点亮');
        /*
         * 【2026-11-08 熄屏任务被冻结】熄屏不一定会触发 onBackground（用户在前台直接锁屏），
         * 旧链只在 onBackground 里按需申请 ⇒ 熄屏时 refs=0 就直接跳过。
         * 这里在熄屏事件上补一次判据（有活跃定时任务 / 在跑 turn 才申请，空闲不弹通知），
         * 保证"等定时触发"也被算成保活诉求。
         */
        if (off) {
          this.screenOffed = true;
          this.maybeAcquireBeforeScreenOff();
        } else {
          this.screenOffed = false;
          if (!this.appBackgrounded && isHandheldForm()) {
            /* 亮屏且仍在前台：收起熄屏时临时申请的长时任务（回到无通知的前台状态）。 */
            this.releaseHandheldKeepAlive();
          }
        }
        this.keepAlive.noteScreenState(off, true).then(() => {
        }).catch((e: BusinessError) => {
          hilog.warn(DOMAIN, TAG, '屏幕校准长时任务失败：%{public}s', e.message);
        });
      });
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, '屏幕监听订阅失败：%{public}s', e.message);
    }
  }

  onBackground(): void {
    this.revokeDecorStyle();
    this.decorForeground = false;
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onBackground');
    this.appBackgrounded = true;
    if (this.launchParams.kind === WindowKind.MAIN) {
      writeAppLifecycle(this.context.filesDir, false, 'onBackground');
    }
    // 任务卡片取的是"切后台那一刻"的窗口快照 ⇒ 先按当前外观把三件套收敛一次（见方法注释）
    /* 第二个参数 false = "正在离开前台"：手持档在这条链上一律不碰系统状态栏（见函数头注）。 */
    this.reassertWindowChrome('background', false);
    this.maybeAcquireHandheldKeepAlive();
  }

  /**
   * 确保主窗在前台可见（从托盘/Dock 唤回时调用）。
   *
   * 优先 `restore()`：SDK 明确它"把主窗从最小化恢复到前台，回到最小化前的位置与尺寸"，
   * 且**仅对主窗有效**——正好是本函数的场景。`showWindow()` 只保证窗口可见，
   * 对已被最小化（WindowStatusType.MINIMIZE）的窗口不必然恢复。
   *
   * 两者都失败时只记日志：此时窗口仍是用户自己的状态，不会比"唤不回来"更糟。
   */
  /** 轮询 dsh-pet 配置：只有存在 desktop/both 宠物才启动桌面宿主，避免无宠时多出黑框。 */
  private startPetWatcher(): void {
    if (isHandheldForm() || this.petWatchTimer >= 0) {
      return;
    }
    this.pollPetConfig();
    this.petWatchTimer = setInterval((): void => {
      this.pollPetConfig();
    }, 2000);
  }

  private pollPetConfig(): void {
    if (this.petQueryBusy) {
      return;
    }
    const base: string = AppStorage.get<string>('dshLastHostUrl') ?? '';
    const token: string = AppStorage.get<string>('dshLastHostToken') ?? '';
    if (base.length === 0) {
      return;
    }
    this.petQueryBusy = true;
    const origin: string = base.endsWith('/') ? base.substring(0, base.length - 1) : base;
    const url: string = origin + '/dsh-pet-7340/config'
      + (token.length > 0 ? '?token=' + encodeURIComponent(token) : '');
    this.petHttp.request(url, {
      method: http.RequestMethod.GET,
      connectTimeout: 3000,
      readTimeout: 3000,
      expectDataType: http.HttpDataType.STRING
    }).then((resp: http.HttpResponse): void => {
      this.petQueryBusy = false;
      const body: string = String(resp.result ?? '');
      const hasDesktop: boolean = resp.responseCode === 200
        && /"display"\s*:\s*"(desktop|both)"/.test(body);
      if (hasDesktop && !this.petStarted) {
        // 注意：不要在这里先置 petStarted——startPetAbility 自带同一守卫，
        // 先置 true 会让它直接 return，PetAbility 永远起不来。
        this.startPetAbility();
      } else if (!hasDesktop && this.petStarted) {
        // PetAbility 自己也会轮询并在无桌面宠物时退出；这里复位，便于用户再次开启。
        this.petStarted = false;
      }
    }).catch((_e: BusinessError): void => {
      this.petQueryBusy = false;
    });
  }

  /** 启动 dsh-pet 桌面宿主 Ability（仅 PC/2in1）。 */
  private startPetAbility(): void {
    if (this.petStarted || isHandheldForm()) {
      return;
    }
    this.petStarted = true;
    try {
      const want: Want = {
        bundleName: this.context.abilityInfo.bundleName,
        abilityName: 'PetAbility',
        moduleName: 'entry'
      };
      this.context.startAbility(want).then((): void => {
        hilog.info(DOMAIN, TAG, 'dsh-pet 桌面宿主已启动');
      }).catch((e: BusinessError): void => {
        hilog.warn(DOMAIN, TAG, 'dsh-pet 桌面宿主启动失败：%{public}d %{public}s', e.code, e.message);
      });
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'dsh-pet 桌面宿主启动异常');
    }
  }

  private ensureWindowShown(): void {
    const win: window.Window | undefined = this.mainWindow;
    if (win === undefined) {
      return;
    }
    // 取一个非空别名给异步回调用：ArkTS 不做跨回调的非空收窄
    const target: window.Window = win;
    /*
     * 【2026-11-23 亮屏顶窗修复】原实现无条件 `restore()`，失败后兜底 `showWindow()`。
     * 亮屏时系统会把任务回一次前台（onForeground），平板/未最小化的窗口 `restore()` 往往失败，
     * 于是每次都走 `showWindow()` 把窗口顶到最前 —— 用户看到的就是「一亮屏 DSHM 自己跳到前台」。
     *
     * 现在先读窗口真实状态：**只有 MINIMIZE 才恢复**，未最小化时什么都不做；
     * 不再兜底 `showWindow()`（它会把未最小化的窗口也顶到最前，正是故障来源）。
     *
     * `getWindowStatus()` 是**同步** API（@since 12，直接返回 `WindowStatusType`，
     * 读不到抛 801/1300002）—— 不是 Promise，不能 `.then`；用 try/catch 包住，
     * 读失败按「不动作」处理（与本文件 `readWindowStatusOf` 的用法同口径）。
     */
    let status: window.WindowStatusType;
    try {
      status = target.getWindowStatus();
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      hilog.debug(DOMAIN, TAG, 'getWindowStatus 失败（不恢复窗口）：%{public}s', err.message);
      return;
    }
    if (status !== window.WindowStatusType.MINIMIZE) {
      return;
    }
    target.restore().then(() => {
      hilog.info(DOMAIN, TAG, '主窗已从最小化恢复');
    }).catch((restoreErr: BusinessError) => {
      hilog.debug(DOMAIN, TAG, 'restore 未生效：%{public}s', restoreErr.message);
    });
  }

  /**
   * 点标题栏「关闭」时的处理：**PC/2in1 档**把窗口收进后台（任务、连接与托盘图标都留着），
   * 其余分档按系统默认继续关窗。返回值就是「关不关」：`true` = 不关（见 `onWindowWillClose`）。
   *
   * 【为什么必须留回程入口】拦了关闭却不给回来的路，用户会得到"窗口不见了、也找不到入口"，
   * 比直接关掉糟得多。PC 档有两条回程：① 托盘图标左键（`setupTray` 的 `onIconClick`
   * → `restoreMainWindow`）；② 任务栏 / Dock 里的本应用图标（进程仍活着 ⇒ 图标还在，
   * 点它走 `onForeground` → `ensureWindowShown`）。两条都**独立于**托盘图标是否挂上成立，
   * 故这里不拿托盘状态做前置判据（2026-10-05 那版曾因"托盘图标残留"整段撤除，撤的是
   * 残留问题，不是这条判据本身；本轮托盘残留已由 `StatusBarTray.remove()` 修掉）。
   *
   * 【为什么不走 `finalizeBeforeExit`】收进后台 = 应用继续运行 ⇒ 摘图标 / 停核心 / 通知
   * 托盘进程这三件收尾**一件都不能做**（见 `finalizeBeforeExit` 的注释）。
   *
   * 【最小化失败为什么返回 false】不装作成功：返回 false 让系统按默认关掉，
   * 避免出现"窗口还在、点关闭没反应"的死界面。
   */
  private handleWindowWillClose(source: string): Promise<boolean> {
    // 手持档一个字节不改：手机 / 平板的「关闭」仍是系统官方行为 = 退出应用（见 onPrepareToTerminate）。
    if (isHandheldForm()) {
      return Promise.resolve(false);
    }
    // 已经在走退出流程（托盘右键退出 / 任务栏退出）：这时候的关闭要放行，否则会把退出链卡住。
    if (this.exiting) {
      return Promise.resolve(false);
    }
    // 只拦主窗：会话窗关闭不该让整个应用躲进后台（与 onPrepareToTerminate 同一条判据）。
    if (this.launchParams.kind !== WindowKind.MAIN) {
      return Promise.resolve(false);
    }
    const win: window.Window | undefined = this.mainWindow;
    if (win === undefined) {
      // 拿不到窗口对象 ⇒ 既没法最小化也没法收起，交回系统（按默认关窗）。
      writeWindowCloseDiag(this.context.filesDir, `${source} 主窗不可用：按系统默认继续关窗`);
      return Promise.resolve(false);
    }
    // 取一个非空别名给异步回调用：ArkTS 不做跨回调的非空收窄
    const target: window.Window = win;
    writeWindowCloseDiag(this.context.filesDir, `${source} 拦截成功：最小化到后台（不终止应用）`);
    return target.minimize().then((): boolean => {
      hilog.info(DOMAIN, TAG, '关闭请求已改为最小化到后台（任务与连接保留）');
      return true;
    }).catch((err: BusinessError): boolean => {
      hilog.warn(DOMAIN, TAG, '最小化失败，按系统默认关窗：%{public}s', err.message);
      writeWindowCloseDiag(this.context.filesDir, `${source} 最小化失败：${err.code} ${err.message}`);
      return false;
    });
  }

  /**
   * 挂托盘常驻图标并接线（仅主窗调用）。
   *
   * 失败**降级而不抛**：图标挂不上只等于少一个「左键唤回」入口，不该连带影响启动。
   * （拦截三键关闭的判据是 `windowWillClose`，与托盘状态无关；托盘在此的职责是
   * "窗口收进后台后把用户唤回来"的回程入口 + 后台保活。）
   *
   * 【手持档（手机/平板）整段早退 —— 2026-10-14】托盘存在的全部理由都只对 PC/2in1 成立：
   *   ① 图标 + 左键唤回的**回程**入口 —— 手持档三键「关闭」是系统官方行为 = 退出应用
   *      （`handleWindowWillClose` 手持档第一行就 `return false`），没有"收进后台"这个状态，
   *      自然不需要回程；② 贴住图标的**后台 Ability 进程**（`hold`）—— 手持档的后台保活由
   *      `KeepAlive` 长时任务统一承担（见上面 `keepAlive.acquire()`），多一个进程只多一份
   *      常驻内存与一个用户会在进程列表里看到的第二进程。
   * 真机实证（手机 62T0225B18039433，`files/diag-tray`）：手持档上 `addToStatusBar` 每次都
   * **成功**（08:50～13:14 约 50 行 `install ok`）⇒ `hold` 的 300ms 延时回调必然被发出 ⇒
   * 应用会在手持档上反复尝试拉一个自己不需要的独立进程。这是本仓唯一一处能创造出"第二个
   * DSHM 进程"的调用面（全仓 `processMode` 仅此一用），故在分档处一次收口。
   * 判据由 `StatusBarTray.applicable()` 给（与 `bindGeometry` / `unbindGeometry` 等处的分档
   * 写法同源：只有 `isHandheldForm()`，PHONE / TABLET 为真），PC/2in1 档行为**一个字节不变**；
   * 该判据在返回 false 时还会做**一次性摘残留**（老版本挂过 / 异常退出留下的注册得有人摘）。
   * 「跳过」这件事会落进 `files/diag-tray`（与托盘自己的事件同一份文件）⇒ 事后一份文件就能
   * 区分「这一档压根没挂」与「尝试挂了但失败」。
   */
  private setupTray(): void {
    const ctx: common.UIAbilityContext = this.context;
    if (!StatusBarTray.applicable(ctx)) {
      hilog.info(DOMAIN, TAG, '手持档不挂托盘（无三键关闭收后台的回程需求，后台保活走 KeepAlive 长时任务）');
      return;
    }
    StatusBarTray.install(ctx).then(() => {
      hilog.info(DOMAIN, TAG, '托盘图标已就绪，左键可唤回主窗');
      // 顺序不能反：`NEW_PROCESS_ATTACH_TO_STATUS_BAR_ITEM` 的前提是"应用已有状态栏图标"
      setTimeout(() => {
        StatusBarTray.hold(ctx);
      }, 300);
    }).catch((err: BusinessError) => {
      hilog.warn(DOMAIN, TAG, '托盘图标初始化失败（降级：少一个唤回入口）：%{public}s', err.message);
    });

    // 左键唤回主窗：系统把任务切到前台 + onForeground 里补一次 restore
    StatusBarTray.onIconClick((clickType: string) => {
      if (clickType !== 'leftClick') {
        return;
      }
      hilog.info(DOMAIN, TAG, '托盘图标左键：唤回主窗');
      this.restoreMainWindow();
    });

    // 托盘后台 Ability 被系统结束 ⇒ 图标很可能已随之消失，走退出收尾，避免
    // 「主 Ability 已死、图标还在」的半死状态。
    // 【不要在这里先 markUnavailable】那会把 `installed` 提前清零，使 exitApp 里的
    // `remove()` 首行早退（一次系统调用都不发）—— 图标到底还在不在，交给 `remove()` 自己判：
    // 它无论成败都会把 `installed` 归零（见 StatusBarTray.remove）。
    StatusBarTray.subscribeBgTerminating(() => {
      this.exitApp('托盘后台进程被系统结束');
    });
  }

  /** 把应用（连同最小化的主窗）唤到前台。托盘左键用。 */
  private restoreMainWindow(): void {
    this.context.showAbility().catch((err: BusinessError) => {
      hilog.warn(DOMAIN, TAG, 'showAbility 唤回失败：%{public}s', err.message);
    });
  }

  /**
   * 退出前的收尾（幂等）：摘托盘图标 → 通知托盘进程退出 → 停核心。
   *
   * 【顺序不能反】摘图标要趁**还有窗口**（SDK：无前台窗口时 `removeFromStatusBar` 报
   * 1010710004），而 `stopHostThenExit()` 是不定长等待 ⇒ 必须排在它前面。
   * 2026-10-05→06 的写法把 `remove` 放在 `stopHostThenExit()` **之后**，等它回来窗口
   * 往往已经不在了 ⇒ 摘图标失败、图标残留。
   *
   * 【为什么要停核心】官方不保证 `terminateSelf()` 会清理应用自己拉起的 Node 线程。
   * 宿主是同进程线程（见 runtime/NodeRuntime.ets 文件头），进程真死时它自然一起死，
   * 但只要存在"进程没立刻死"的时序，残留的宿主就会占着回环端口，下次启动撞"端口已占用"。
   * 停一次是协作式且幂等的（`DshHost.stop()`），成本一个文件写入，收益是确定的下次启动。
   */
  private finalizeBeforeExit(reason: string): Promise<void> {
    hilog.info(DOMAIN, TAG, '退出收尾（摘托盘 → 通知托盘进程 → 停核心）：%{public}s', reason);
    StatusBarTray.remove(this.context);
    // 托盘后台 Ability 是**另一个进程**，terminateSelf 只结束本实例，不会连它一起收掉。
    // 不通知它自行退出，就会留下一个"图标已摘、进程还在"的孤儿。
    StatusBarTray.publishExitRequest();
    return this.stopHostThenExit();
  }

  /**
   * 真正退出应用：收尾（摘托盘 → 通知托盘进程 → 停核心）→ 结束 Ability。
   *
   * 触发点：**托盘后台进程被系统结束**（`subscribeBgTerminating`）。
   * 系统发起的关闭走 `onPrepareToTerminate`（同样调用 `finalizeBeforeExit`，但终止由系统做，
   * 见该方法的注释）。
   */
  private exitApp(reason: string): void {
    if (this.exiting) {
      return;
    }
    this.exiting = true;
    hilog.info(DOMAIN, TAG, '开始退出应用：%{public}s', reason);

    this.finalizeBeforeExit(reason).then(() => {
      return StatusBarTray.delayBeforeTerminate();
    }).then(() => {
      this.context.terminateSelf().then(() => {
        hilog.info(DOMAIN, TAG, '已退出应用：%{public}s', reason);
      }).catch((err: BusinessError) => {
        // 退不出去比多退一步严重得多：如实报错，并允许用户再试一次
        this.exiting = false;
        hilog.error(DOMAIN, TAG, 'terminateSelf 失败：%{public}s', err.message);
      });
    }).catch((err: BusinessError) => {
      // 走到这里意味着收尾自己抛了（理论上不该，stopHostThenExit 内部已兜底）
      this.exiting = false;
      hilog.error(DOMAIN, TAG, '退出流程异常：%{public}s', err.message);
    });
  }

  /** 停明确宿主；超时或失败都**继续**退出（否则用户点了退出却出不去）。 */
  private stopHostThenExit(): Promise<void> {
    const host: DshHost | undefined = this.host;
    if (host === undefined) {
      return Promise.resolve();
    }
return host.stop('EntryAbility.stopHostThenExit：应用退出流程').then((res: OpResult) => {
      if (res.ok) {
        hilog.info(DOMAIN, TAG, '核心已停止：%{public}s', res.message);
      } else {
        hilog.warn(DOMAIN, TAG, '停止核心失败（仍继续退出）：%{public}s', res.message);
      }
    }).catch((err: BusinessError) => {
      hilog.warn(DOMAIN, TAG, '停止核心异常（仍继续退出）：%{public}s', err.message);
    });
  }

  /**
   * 窗口就绪后的收尾：登记台账 →（仅主窗）恢复几何 → 监听几何变化。
   *
   * 顺序有讲究：几何恢复依赖 preferences，故挂在 memoryReady 之后而不是直接调用，
   * 否则会因为 store 尚未打开而被 restoreMainGeometry 静默跳过（表现为「记忆失效」）。
   */
  private afterWindowStageReady(windowStage: window.WindowStage): void {
    this.revokeDecorStyle();
    const win: window.Window | undefined = this.mainWindowOf(windowStage);
    if (win === undefined) {
      return;
    }
    this.mainWindow = win;
    if (this.launchParams.kind === WindowKind.MAIN) {
      const pendingAuthReturnWant: Want | undefined = this.pendingAuthReturnWant;
      this.pendingAuthReturnWant = undefined;
      if (pendingAuthReturnWant !== undefined) {
        this.handleAuthReturnWant(pendingAuthReturnWant);
      }
    }

    let windowId: string = '';
    try {
      // 直接用手上的 windowStage 取窗口 id，而不是 platform 的 currentWindowId()：
      // 后者要再走一次 getLastWindow，既多一次系统调用，也可能在极端时序下拿到别的窗口。
      windowId = String(win.getWindowProperties().id);
    } catch (err) {
      const e = err as BusinessError;
      hilog.error(DOMAIN, TAG, '读取窗口 id 失败，本次不登记台账：%{public}s', e.message);
    }
    if (windowId.length > 0) {
      this.windowId = windowId;
      registerWindow(windowId, this.ledgerLabel(), readDeviceFacts().form);
      hilog.info(DOMAIN, TAG, '窗口已登记 id=%{public}s label=%{public}s', windowId, this.ledgerLabel());
      if (this.launchParams.kind === WindowKind.MAIN) {
        // 主窗 id 发布给页面（仅 MAIN 分支；会话窗实例不得覆盖，见 KEY_MAIN_WINDOW_ID 注）
        AppStorage.setOrCreate<string>(KEY_MAIN_WINDOW_ID, windowId);
      }
    }

    // 只有主窗参与几何记忆：saveMainGeometry 固定写 'main.rect'，若让会话窗也监听，
    // 会话窗一挪动就会把主窗的几何覆盖掉（用户会看到主窗位置被「偷走」）。
    if (this.launchParams.kind !== WindowKind.MAIN) {
      return;
    }
    /* dsh-pet 桌面宿主：仅 PC/2in1；按 /dsh-pet-7340/config 的 display 决定是否启动。 */
    this.startPetWatcher();
    /* 【2026-11-07】主窗已就绪：平板沉浸式状态栏在这之后才真正能设（见 onWindowStageCreate 的时序注）。 */
    this.enterTabletImmersive();
    // ── 自由窗口标题栏沉浸（2026-09-21 品牌对齐）──────────────────────────
    // 官方文档（窗口沉浸式·自由窗口标题栏沉浸案例）：setWindowDecorVisible(false)
    // 隐藏系统标题栏的应用图标+应用名（也就消除了与新应用图标不同步的旧图），
    // 保留右上角三键（全屏/最小化/关闭），页面扩展至原标题栏区域；透明标题栏
    // 区域保留系统默认的「拖动移动窗口 / 双击最大化」能力——自绘 TopBar（鲸鱼
    // 标识 + DSHM/编辑菜单）因此成为窗口第一行，其空白处天然可拖动窗口
    // （华为浏览器 Tab 页签同款方案）。三键避让由 WebApp 顶栏动态处理
    // （getTitleButtonRect + windowTitleButtonRectChange 监听）。
    // 【手机上的实际形态（2026-10-10 r9 真机实测 —— 与旧注释不同）】三条调用各自的结果是
    // `visible=ok / set=ok / style=err`，`getWindowDecorHeight()=0`，`getWindowStatus()=FULL_SCREEN(1)`
    // ⇒ `present=false`（全屏没有三键 ⇒ 不让位，与 r8 的可见行为一致）。旧注释写「手机全屏抛 801、
    // 吞掉即可」是**不准的**：手机上真正失败的是 `setDecorButtonStyle`，而 r8 之前把它和前面两条
    // 绑在同一个 try 里 ⇒ 那串的结论被它带走、发布 false —— 也就是「结果对、原因错」。
    //
    // 【2026-10-10 第二轮：三个调用必须各自独立捕获（MatePad Edge 平板自由窗口实证）】
    // 原实现把三行塞进同一个 try，并推论「这一串调用成功 ⟺ 自由窗口 ⟺ 三键在」。真机证明
    // 这条推论**错了**：标题栏确实已隐藏（Web 内容顶到窗口第一行、系统三键浮在内容之上
    // = 沉浸已生效），但紧随的 setWindowDecorHeight 抛 801 Capability not supported
    // （SDK 明文：能力受限设备不支持）⇒ 整串落进 catch ⇒ 发布 false ⇒ 页面让位 0 ⇒ 重叠
    // 照旧。真机原始读数 `diag-decor-top`：
    // `2026-10-10T03:56:49.133Z handheld=true keys=false rect.w=0 rect.h=0 inset=0`。
    // ⇒ 改法：**只有 setWindowDecorVisible(false) 的成败决定"标题栏是否已沉浸"**（它是这条
    // 沉浸链真正的那一跳），后两个降级为各自独立的**可选**步骤，各吞各的 801。
    // 【2026-10-18 PC 模式】手持形态 + 自由窗口 ⇒ 保留系统装饰（见 KEY_PC_MODE 注释）：
    // 只有保住标题栏，系统才会给四边的缩放边框；否则只剩左右下角拖拽点。
    /* 【2026-11-12 恢复：手持形态 + 自由窗口 ⇒ 保留系统装饰（撤销 11-07 的恒 false）】
     *
     * 【为什么必须撤销（真机取证，docs/416）】11-07 把这里改成恒 false，只登记了一个代价
     * ——「自由窗口不再有四边缩放边框」。漏登记的第二个代价是：**系统标题栏同时是平板的
     * 分屏唯一入口**（三键菜单里的「分屏」，或把窗口拖到屏幕边缘），而自绘顶栏没有实现
     * startMoving()，所以拖拽也一并消失。真机读数：`diag-decor-top handheld=true
     * rawType=tablet show=false`、`diag-decor-caps present=false status=1:FULL_SCREEN`，
     * 窗口状态历史里从未出现 SPLIT_SCREEN —— 用户点不到任何入口，不是点了没反应。
     *
     * 而且它是个自锁环：没有装饰 ⇒ 进不了 FLOATING ⇒ 下面 refreshDecorCaps 里那段
     * 「进入自由窗口恢复装饰」永远没有机会执行，一进来就锁死在全屏无装饰状态。
     *
     * 现在的取舍（用户 2026-11-12 裁决「A」）：**自由窗口 / 分屏里保留系统标题栏与三键**，
     * 换来分屏与拖拽；全屏（含手机全屏）仍然隐藏装饰、保持沉浸。手机与 PC/2in1 的
     * 装饰策略不变（PC 档 isHandheldForm() 为假，本来就不走这一段）。 */
    /* 【2026-11-19 修复 A：撤销 11-12 留下的"手持档早分支"】
     *
     * 11-12 落地 docs/416 时，这里多出一个 `if (isHandheldForm()) { …只设 pcMode… } else { …原链… }`
     * 的包裹：手持档（平板）只写 `pcMode` 与 `publishDecorKeysVisible(false)` 就结束，
     * `setWindowDecorVisible(true)`（FLOATING 恢复装饰）、`setWindowTitleButtonVisible`、
     * `decorPresentOf`、`writeDecorCapsDiag`、`reassertWindowChrome` **一次都执行不到**。
     * 真机读数因此恒为 `decor=skip buttons=skip show=false`（与用户 2026-11-19 的探针一致）。
     *
     * 现在统一走下面这条完整链：`pcMode = 手持 && FLOATING`（PC 档 isHandheldForm() 为假
     * ⇒ 恒 false，行为逐字不变）。全屏仍隐藏装饰保持沉浸；自由窗口/分屏才把系统标题栏与
     * 三键拉回来，分屏与拖拽入口随之恢复。 */
    let statusPre: window.WindowStatusType | undefined = undefined;
    try {
      statusPre = win.getWindowStatus();
    } catch (err) {
      statusPre = undefined;
      hilog.info(DOMAIN, TAG, '启动读窗口状态失败（沿用全屏假设）：%{public}s', (err as BusinessError).message);
    }
    const pcMode: boolean = isHandheldForm() && statusPre === window.WindowStatusType.FLOATING;
    this.pcMode = pcMode;
    AppStorage.setOrCreate<boolean>(KEY_PC_MODE, pcMode);
    let decorHiddenOk: boolean = false;
    let decorVisibleRaw: string = '';
    if (pcMode) {
      /* 自由窗口：显式把系统装饰拉回来（含右上角三键），分屏/拖拽才有入口。 */
      try {
        win.setWindowDecorVisible(true);
        decorVisibleRaw = 'keep-pc';
        hilog.info(DOMAIN, TAG, '自由窗口：保留系统标题栏（分屏与拖拽入口）');
      } catch (err) {
        decorVisibleRaw = `err=${(err as BusinessError).code}`;
      }
    } else {
      /* 【2026-11-16 用户裁决：保留系统三键、去掉图标与文字（=隐藏装饰），
       * 标题栏内容改由自绘 TopBar 承担（三点菜单 + 拖动热区），并要求与页面同色沉浸。 */
      try {
        win.setWindowDecorVisible(false);
        decorHiddenOk = true;
        hilog.info(DOMAIN, TAG, '窗口标题栏已隐藏：内容接管原标题栏区域（沉浸第一步）');
      } catch (err) {
        const e = err as BusinessError;
        decorVisibleRaw = `err=${e.code}`;
        hilog.info(DOMAIN, TAG, '窗口装饰隐藏不适用（全屏模式属正常）：%{public}s', e.message);
      }
    }
    const titleButtonRaw: string = pcMode ? this.showTitleButtons(win) : this.hideHandheldTitleButtons(win);
    const decorButtonsHiddenOk: boolean = titleButtonRaw === 'ok';
    // 【三键区高度（2026-09-24）】官方《自由窗口适配》5.1.3 的沉浸式方案是两步：
    // setWindowDecorVisible(false) 隐藏图标+应用名后，**必须再调 setWindowDecorHeight
    // 控制右上角三键区显示及显示高度**——只调前者时三键区高度不保证（MateBook 14
    // 实测三键直接不可见，即用户报的"右上角三个按钮看不见"）。取 38 与自绘顶栏
    // TOP_BAR_HEIGHT 同值：三键叠在白底顶栏上（顶栏右侧 decorPadRight 已避让），
    // 白底衬托深色三键（2026-09-26 验收口径）。API 约束 [37,112]vp 整数，38 在界内。
    // 【为什么它现在是"可选步骤"】平板自由窗口上这一行抛 801（真机实证，见上）⇒ 失败
    // **不得**影响"三键在不在"的结论；它只决定"高度取哪个值"这一偏好。
    let decorSetRaw: string = 'skip';
    try {
      win.setWindowDecorHeight(38);
      decorSetRaw = 'ok';
    } catch (err) {
      const e = err as BusinessError;
      decorSetRaw = `err=${e.code}`;
      hilog.info(DOMAIN, TAG, '三键区高度不可设（能力受限设备属正常）：%{public}s', e.message);
    }
    // 【三键区高度（2026-10-10）】读一次 `getWindowDecorHeight()`（整数 vp [37,112]）：它是
    // `decorPresentOf` 在**窗口状态读不到（801）时**的保守兜底（高度 > 0 ⇒ 系统确实还画着一条
    // 装饰带），并逐项落在 `files/diag-decor-caps` 自证里。
    // 【第二轮起它不再经 AppStorage 交给页面】页面的让位量已定成常量（见 WebApp 的
    // `HANDHELD_DECOR_INSET_VP`）⇒ `dshDecorHeightVp` 这条通道整条撤掉（没人消费的通道 = E346b）。
    // 手机是"写成功但读回 0"这一路（真机 `set=ok get=H=0`，见 docs/134 §5）。
    let decorHeightVp: number = 0;
    let decorGetRaw: string = 'skip';
    try {
      decorHeightVp = win.getWindowDecorHeight();
      decorGetRaw = `H=${decorHeightVp}`;
    } catch (err) {
      const e = err as BusinessError;
      decorGetRaw = `err=${e.code}`;
    }
    // 【三键颜色（2026-09-26 立，2026-10-05 / 2026-10-10 两轮加固）】DecorButtonStyle.colorMode
    // 不设时三键**自动匹配系统深浅色**（SDK @ohos.window.d.ts DecorButtonStyle 注释原文）：
    // 系统深色模式下三键画成浅色图标，叠在浅色自绘顶栏上对比度归零 —— 用户报"三个按钮看不见"。
    // 自 2026-09-26 起自绘顶栏**跟随外观**（`applySystemBarTheme`：light→#FFFFFF / dark→#151517），
    // 所以三键必须跟着**同一个**外观走。这条路径原先写死 `COLOR_MODE_LIGHT`（给当年"恒白底顶栏"
    // 配的）—— 那正是 2026-10-05「深色外观下黑底黑键」回归的来源，也是 2026-10-10 平板
    // 「按钮反色」报告里唯一可归因到我们代码的那一半。现在收进 `reassertDecorButtons()`：
    // **本文件只有那一处**设三键配色，启动与状态刷新共用，权威取页面发布的 `KEY_APPEARANCE_MODE`。
    // 纯外观 ⇒ 失败只记不降级（**手机真机实测就是 `style=err`**；平板自由窗口上它同样可能抛 801）。
    const decorStyleRaw: string = this.reassertDecorButtons(win);
    // 【判据：窗口状态】真机实证（MatePad Edge 同应用三张截图）：**最大化态右上角没有
    // 系统按钮**（只有应用自己的两枚图标），只有**自由窗口**才浮出系统三键 ⇒ 状态可读时它是
    // 唯一权威；读不到（801）才退回"装饰高度 > 0"的保守推测（见 decorPresentOf 的注释）。
    let statusFloating: boolean | undefined = undefined;
    let statusRaw: string = 'unknown';
    try {
      const st: window.WindowStatusType = win.getWindowStatus();
      statusFloating = st === window.WindowStatusType.FLOATING;
      statusRaw = `${String(st)}:${windowStatusName(st)}`;
      this.decorStatusRaw = statusRaw;
    } catch (err) {
      statusRaw = `err=${(err as BusinessError).code}`;
    }
    // 发布结论：**"标题栏已隐藏" 且 "三键确实占位"** 才算三键在（纯函数，见其注释）。
    // 这一条必须**显式发布**（真或假都发）：AppStorage 是进程级的，会话窗或上一次发布会把
    // 旧结论留在仓里，不写就会留下上一次的结论。
    const decorPresent: boolean = decorPresentOf(
      decorHiddenOk, decorButtonsHiddenOk, decorHeightVp, statusFloating);
    this.publishDecorKeysVisible(decorPresent);
    this.decorHiddenOk = decorHiddenOk;
    this.decorButtonsHidden = decorButtonsHiddenOk;
    this.decorHeightVp = decorHeightVp;
    this.decorFloating = statusFloating;
    this.decorStyleRaw = decorStyleRaw;
    this.decorPublished = decorPresent;
    /*
     * 窗口形态变了 ⇒ 状态栏归属重判一次（自由窗口交还系统 / 回到全屏补设）。
     * 与页面侧 `onDecorKeysVisibleChanged` 是**同一件事的两条入口**：那条由 `@StorageProp` 触发，
     * 这条由能力层自己的刷新链触发；两边都幂等，谁先到都不会打架。
     */
    this.reassertWindowChrome('decor-caps');
    writeDecorCapsDiag(this.context.filesDir,
      `pc=${pcMode ? 'yes' : 'no'} visible=${decorVisibleRaw.length > 0 ? decorVisibleRaw : 'ok'} buttons=${titleButtonRaw} ` +
        `set=${decorSetRaw} get=${decorGetRaw} ` +
        `style=${decorStyleRaw} mode=${this.appearanceMode()} status=${statusRaw} -> present=${decorPresent} ` +
        /* sb= 状态栏归属（2026-10-16）：app = 由我们设；system = 交还系统（手持档非全屏 / 离开前台）。
           平板那边只要把这行发回来，就能证明"白条"那半是不是走到这条分支上了（见 docs/168）。 */
        `sb=${statusBarOwnedByApp(isHandheldForm(), readWindowStatusOf(win)) ? 'app' : 'system'}`);
    hilog.info(DOMAIN, TAG,
      '窗口装饰探测：visible=%{public}s height=%{public}d status=%{public}s ⇒ 三键在=%{public}s',
      decorVisibleRaw.length > 0 ? decorVisibleRaw : 'ok', decorHeightVp, statusRaw,
      decorPresent ? 'yes' : 'no');
    this.memoryReady.then((): Promise<boolean> => {
      return this.memory.restoreMainGeometry(win);
    }).then((restored: boolean) => {
      if (restored) {
        hilog.info(DOMAIN, TAG, '已恢复主窗几何');
      }
    }).catch((_error: Object) => {
      // restoreMainGeometry 内部已吞掉全部异常，这里是纯防御
      hilog.debug(DOMAIN, TAG, '主窗几何恢复异常（已忽略）');
    });
    this.bindGeometry(win);

    // ── PC 档：标题栏「关闭」= 收进后台（2026-10-13 用户需求）────────────────────────
    // 挂点选在主窗分支的末尾（windowId 已登记、装饰探测已完成、几何监听已就位）：关闭按钮
    // 要能工作，前提是窗口已经被登记过（`getWindowProperties().id` 可读）。
    // 【手持档一个字节不动】手机 / 平板仍是"关闭 = 退出"（`handleWindowWillClose` 首行早退）。
    // 【为什么是 windowWillClose】只有它能把触发面收窄到"标题栏关闭按钮"，
    // 从而与托盘 / 任务栏那条真退出链分开 —— 详见 onWindowWillClose 的注释。
    if (!isHandheldForm()) {
      try {
        win.on('windowWillClose', this.onWindowWillClose);
        writeWindowCloseDiag(this.context.filesDir, 'windowWillClose 监听已挂上（PC 档）');
      } catch (err) {
        // 挂不上只等于"关闭仍按系统默认 = 退出"，不该阻断窗口创建；
        // 但这是本功能的唯一开关，必须留痕，否则真机上只会看到"点了关闭还是退出"。
        const e = err as BusinessError;
        writeWindowCloseDiag(this.context.filesDir, `windowWillClose 挂载失败：${e.code} ${e.message}`);
        hilog.warn(DOMAIN, TAG,
          'windowWillClose 监听挂载失败（关闭将按系统默认 = 退出）：%{public}s', e.message);
      }
    }
  }

  /** 取本阶段的窗口；失败返回 undefined（窗口尚未创建/已被销毁都是正常时序）。 */
  private mainWindowOf(windowStage: window.WindowStage): window.Window | undefined {
    try {
      return windowStage.getMainWindowSync();
    } catch (err) {
      const e = err as BusinessError;
      hilog.error(DOMAIN, TAG, '获取窗口失败：%{public}s', e.message);
      return undefined;
    }
  }

  /**
   * 把启动参数发布到 AppStorage——能力层与页面之间的**约定交接通道**。
   *
   * 为什么是 AppStorage：页面由 `loadContent` 内部实例化，能力层拿不到它的入口，无法直接
   * 传构造参数；而 AppStorage 是能力层与页面天然共享的键值仓，页面用
   * `@StorageProp('dshLaunchKind')` 之类即可声明式订阅，参数变化自动刷新。
   *
   * 为什么值一律是**字符串**：跨这条边界传对象字面量或枚举会同时撞上 ArkTS 的类型检查与
   * 取值后的窄化两重麻烦（枚举存进去取出来只剩 string，再 `as` 强转属于自欺）。
   * 统一降级为字符串后，边界上没有任何隐式转换，页面用 platform 侧的常量/枚举自行比对，
   * 路由 JSON 也由页面自己按需解析。
   *
   * 为什么 onCreate 与 onNewWant 都要发布：复用实例时页面**不会重建**，
   * 这条通道是唯一能把新路由送进已有窗口的路径。
   *
   * 已知代价（写下来，免得后来者以为它是免费的）：AppStorage 是**进程级**的，五个键名不带
   * 窗口标识，因此它承载的语义是「最近一次发布的启动参数」。正常情况下每个窗口在自己的
   * onCreate/onNewWant 里发布、紧接着自己的页面初始化时读取，时序自洽；但若两个窗口几乎
   * 同时启动（例如连续 startAbility 两个会话），后发布者会覆盖前者的值，理论上会出现
   * 「新窗口读到上一个窗口的会话」。真正无歧义的做法是**每窗一份**：把参数存进该窗口自己的
   * LocalStorage 并通过 `windowStage.loadContent(path, storage)` 注入，或把窗口 id 拼进键名。
   * 本层按约定只落这五个全局键（页面侧据此读取），故先把风险记在这里：一旦出现
   * 「新窗口显示的是上一个窗口的会话」这类反馈，就按上面的方向改成每窗一份，而不是加锁。
   */
  private applyLaunchParams(want: Want): void {
    const parsed: WindowParams = parseWindowParams(want.parameters);
    this.launchParams = parsed;
    // 真机判据（docs/172）：搜 DSHM-LAUNCH 可见参数是否解析出来（含 action 取值）
    hilog.info(DOMAIN, TAG, 'DSHM-LAUNCH 参数解析 kind=%{public}s sessionId=%{public}s action=%{public}s',
      kindText(parsed.kind), parsed.sessionId.length > 0 ? '(有)' : '(无)',
      parsed.action.length > 0 ? parsed.action : '(无)');
    AppStorage.setOrCreate<string>(KEY_LAUNCH_KIND, kindText(parsed.kind));
    AppStorage.setOrCreate<string>(KEY_LAUNCH_SESSION_ID, parsed.sessionId);
    AppStorage.setOrCreate<string>(KEY_LAUNCH_TITLE, parsed.title);
    AppStorage.setOrCreate<string>(KEY_LAUNCH_ROUTE_JSON, parsed.routeJson);
    AppStorage.setOrCreate<string>(KEY_LAUNCH_ACTION, parsed.action);
    this.applyHostLaunchParams(want.parameters);
  }

  /**
   * 从启动参数里取「本次要连的 Host」——**开发期零手填**的入口。
   *
   * 【为什么需要它】dsh 是 Host/Client 分离的：客户端必须知道一个地址和一个令牌。
   * 手工在界面上粘贴 `http://…/?token=…` 每换一次 Host（重启、换端口、换机器）
   * 就要重复一次，而**这些东西本来就在启动它的人手里**。
   * `tools/dev-host.mjs` 起核心后把这两项通过
   * `aa start --ps dshHost <url> --ps dshToken <token>` 直接带进来，
   * 客户端因此不需要任何手工输入。
   *
   * 【为什么还要落盘】启动参数只在这一次启动有效。把它交给 `persistConnectedHost`
   * 之后，下次冷启动会走已有的「记住上次 Host」自动重连路径——
   * 否则用户每启动一次应用都要重新提供一次地址。
   *
   * 【为什么不校验 token 形态】token 是 Host 生成的**不透明**字符串（长度/字符集都可能变），
   * 客户端只做「非空」判断；任何形态校验都可能在 Host 升级后误拒一个合法令牌。
   */
  private applyHostLaunchParams(params: Record<string, Object> | undefined): void {
    if (params === undefined) {
      return;
    }
    const rawUrl: Object | undefined = params[KEY_LAUNCH_HOST];
    const rawToken: Object | undefined = params[KEY_LAUNCH_TOKEN];
    if (typeof rawUrl !== 'string' || typeof rawToken !== 'string') {
      return;
    }
    const url: string = this.stripTokenQuery(rawUrl as string);
    const token: string = rawToken as string;
    if (url.length === 0 || token.length === 0) {
      return;
    }
    this.launchHostProvided = true;
    AppStorage.setOrCreate<string>(KEY_HOST_URL, url);
    AppStorage.setOrCreate<string>(KEY_HOST_TOKEN, token);
    AppStorage.setOrCreate<string>(KEY_HOST_TOKEN_STATE, 'found');
    AppStorage.setOrCreate<boolean>(KEY_HOST_AUTOCONNECT, true);
    // 外部指定 Host 的场景同样发布完整启动 URL：去尾斜杠后拼 token，
    // Web 壳页对「本端自起 / 外部指定」无差别消费（Host 的 303+set-cookie 鉴权一致）
    let externalBase: string = url;
    while (externalBase.endsWith('/')) {
      externalBase = externalBase.substring(0, externalBase.length - 1);
    }
    AppStorage.setOrCreate<string>(KEY_HOST_LAUNCH_URL, `${externalBase}/?token=${token}`);
    // 落盘：地址进 preferences、token 进加密存储（与界面粘贴那条路径共用同一实现）
    this.persistConnectedHost(url, token);
    hilog.info(DOMAIN, TAG, '启动参数提供了 Host=%{public}s（已发布并落盘）', url);
  }

  /** 去掉 URL 上的 `?token=…`（令牌只经 `KEY_HOST_TOKEN` 传递，绝不留在 URL 里）。 */
  private stripTokenQuery(url: string): string {
    const cut: number = url.search(/[?#]/);
    return (cut >= 0 ? url.substring(0, cut) : url).trim();
  }

  /**
   * 把「发生了什么」接到「发一条系统通知」上（D3 §6）。
   *
   * 【为什么这段接线放在能力层，而不是 `appstate`】发通知需要 `UIAbilityContext`
   *   （授权申请、渠道创建都要它），只有能力层持有。策略（正文怎么写、什么优先级、
   *   去重键是什么）仍然在 `appstate/model/Notify.ets`；能力层只做两件事：
   *   把中枢的事件转成 `notificationFor()` 的入参，以及调用平台机制发布/撤回。
   *
   * 【为什么授权不在启动时就申请】首启就弹权限框，对一个用户可能一直用不到的功能
   *   是打扰。这里改为**第一次真的要发通知时**才申请（`prepareNotify` 里做一次并记住结果）——
   *   拒绝也只是降级：待决项在应用内照旧可见（`NotificationCenter` 的契约）。
   */
  /**
   * 平板沉浸式状态栏（2026-11-04，用户需求）。
   *
   * 【做什么】把主窗切到 **layout-fullscreen**（内容延伸到状态栏下方），并把状态栏底色设为透明、
   * 图标颜色跟随外观。这样页面背景铺到状态栏区域，视觉上就是"沉浸"；
   * 页面侧再按顶部避让高度下移（见 WebApp 的 `topInsetVp`），文字不会被状态栏压住。
   *
   * 【为什么只对平板】`entry` 模块覆盖 PC/2in1 + 平板：PC 有自绘窗口装饰，改 fullscreen 会破坏
   * 三键与拖拽区；手机走 `phone` 模块，有自己的手持形态。所以用 `isHandheldForm()` 收口。
   *
   * 【失败只降级】任何一步失败都只记日志：最坏情况就是"没有沉浸"，不会影响窗口可用性。
   */
  private enterTabletImmersive(): void {
    if (!isHandheldForm()) {
      return;
    }
    const win: window.Window | undefined = this.mainWindow;
    if (win === undefined) {
      return;
    }
    const target: window.Window = win;
    /*
     * 【图标明暗跟随当前外观】原先写死 `isStatusBarLightIcon: false`（深色图标）——
     * 深色系统/深色启动页上就是「深图标压深底」，看起来像状态栏没跟过来。
     * 启动期页面还没上报，`appearanceMode()` 会回落到系统 colorMode（与启动页同源）。
     */
    const chrome = windowChromeFor(this.appearanceMode());
    target.setWindowLayoutFullScreen(true).then(() => {
      hilog.info(DOMAIN, TAG, '平板沉浸：layout-fullscreen 已开启');
      const props: window.SystemBarProperties = {
        statusBarColor: '#00000000',
        isStatusBarLightIcon: chrome.lightIcon
      };
      return target.setWindowSystemBarProperties(props);
    }).then(() => {
      hilog.info(DOMAIN, TAG, '平板沉浸：状态栏已透明');
    }).catch((e: BusinessError) => {
      hilog.warn(DOMAIN, TAG, '平板沉浸设置失败（降级为普通布局）：%{public}s', e.message);
    });
  }

  private setupNotifications(): void {
    this.notifier.attach(this.context);
    /*
     * 【2026-11-05 起不再装配随包提示音】用户口径：提示音一律走系统提示音。
     * 声音所有权交给系统通知渠道（用户可在系统设置里单独改铃声/静音），
     * 因此这里不再 `doneSound.attach()`。`DoneSound` 模块保留但**零引用**，
     * 由 `tools/check-done-sound-system.mjs` 钉住"三端都不得调用"。
     */
    const hooks: NotifyHooks = {
      onPending: (input: NotifyInput) => {
        this.publishNotice(input);
      },
      onPendingResolved: (keys: string[]) => {
        for (let i = 0; i < keys.length; i++) {
          this.notifier.withdraw(keys[i]).then(() => {
          }).catch((_error: Object) => {
          });
        }
      },
      onTurn: (input: NotifyInput) => {
        this.publishNotice(input);
      }
    };
    SessionHub.shared().setNotifyHooks(hooks);
  }

  private scheduleDesktopNotifyPreflight(stage: window.WindowStage, contentLoaded: boolean,
    logTaskWatchStart: boolean): void {
    let completed: boolean = false;
    let timeout: number = -1;
    const run = (): void => {
      if (completed) {
        return;
      }
      completed = true;
      if (timeout !== -1) {
        clearTimeout(timeout);
      }
      if (this.decorStage !== stage || this.exiting || this.taskWatchTimer === -1) {
        return;
      }
      if (logTaskWatchStart) {
        this.diagTaskWatch(`watch started filesDir=${this.context.filesDir}`);
      }
      this.preflightNotifications();
    };
    if (!contentLoaded) {
      run();
      return;
    }
    // 窗口隐藏或没有空闲帧时，仍须完成本次启动的授权预检。
    timeout = setTimeout(run, 250);
    try {
      stage.getMainWindowSync().getUIContext().postFrameCallback(new StartupFrameCallback(run));
    } catch (err) {
      run();
    }
  }

  private preflightNotifications(): void {
    /*
     * 【启动就申请一次通知授权（2026-11-04 复测）】此前授权是"真要发通知时才申请"（惰性），
     * 而通知链路一断就永远走不到那一步 ⇒ 用户**从没见过授权弹窗**，应用也就不出现在
     * 「设置 → 通知」列表里（系统只在应用发布过通知后才登记）。
     * 这里改为启动时申请一次：弹窗只在首次出现，用户拒绝也不会反复骚扰。
     */
    this.prepareNotify().then((ready: boolean) => {
      hilog.info(DOMAIN, TAG, '通知授权预检：%{public}s', ready ? '已允许' : '未允许（可在设置里开启）');
    }).catch((_e: Object) => {
    });
  }

  /** 申请一次授权并发布；失败或未授权时**什么都不做**（不是错误） */
  private publishNotice(input: NotifyInput): void {
    this.prepareNotify().then((ok: boolean) => {
      if (!ok) {
        return;
      }
      const draft: NotificationDraft = notificationFor(input);
      if (assertNoSensitiveContent(draft)) {
        // 内容纪律自检不过就不发：宁可少一条通知，也不把可能含凭据/正文的文本送上锁屏。
        hilog.warn(DOMAIN, TAG, '通知内容未通过纪律自检，已丢弃（kind=%{public}s）', input.kind as string);
        return;
      }
      const isDone: boolean = (input.kind as string) === 'turn-done'
        || (input.kind as string) === 'task-done';
      /*
       * 【顺序：先停长时任务，再发完成通知（工程师方案二 §后台任务）】
       * 长时任务在跑时系统会把它与"常驻通知"绑定；此时再发完成通知，提醒容易被吞掉。
       * 官方建议"任务结束 → 停止长时任务 → 再发完成通知"。这里对完成类先 release
       * （前台时 release 是无害的空操作），发布成功与否都不影响主流程。
       */
      const releaseFirst: Promise<void> = isDone
        ? this.keepAlive.release().catch((_e: BusinessError) => { })
        : Promise.resolve();
      releaseFirst.then(() => {
        this.notifier.publish(draft).then((id: number) => {
          /*
           * 【2026-11-05 口径】提示音一律走系统提示音，**不再播随包音频**。
           * 这里只留证据：id=0 说明通知没发出去（未授权 / 系统拒发），此时本就该没声音，
           * 用户可在系统设置里放开通知后自然恢复；不再用随包音频"兜底"——
           * 那会绕过用户的静音选择，也与手机端行为不一致（详见 publishCompletion 处注释）。
           */
          if (isDone) {
            this.diagTaskWatch(`done-sound(publish): ${id === 0 ? '通知未发出 ⇒ 无提示音' : `系统渠道音负责 id=${id}`}`);
          }
        }).catch((_error: Object) => {
        });
      }).catch((_e: Object) => {
      });
    }).catch((_error: Object) => {
    });
  }

  /** 惰性申请授权（只查/只弹一次） */
  private prepareNotify(): Promise<boolean> {
    if (!this.shareDesktopNotifyPreparation) {
      return this.readNotifyReadiness();
    }
    // 授权预检和真实事件谁先到都共享完整的授权、渠道准备结果。回前台后重新查。
    if (this.desktopNotifyPreflight === undefined) {
      this.desktopNotifyPreflight = this.readNotifyReadiness();
    }
    return this.desktopNotifyPreflight;
  }

  private async readNotifyReadiness(): Promise<boolean> {
    if (this.notifyChecked) {
      return this.notifyReady;
    }
    this.notifyChecked = true;
    this.notifyReady = await this.notifier.ensureEnabled();
    if (this.notifyReady) {
      await this.notifier.ensureSlots();
    }
    return this.notifyReady;
  }

  /**
   * 读取「上次连上的 Host」并发布给页面，供自动重连使用。
   *
   * 【为什么必须先发布 `autoConnect = false`】页面可能比这次异步读取更早就绪。
   * 若只发布最终结果，页面在「还没读到」的那一刻会看到空 URL，从而显示
   * 「请添加 Host」——用户明明上次连过，却被告知没有记录。
   * 因此先立一个明确的「尚未就绪」标志，页面据此**等待**而不是**下结论**。
   *
   * 【为什么 token 读不到时不自动重连】读不到只有两种可能：本次使用（没记录）
   * 或存储系统暂时不可用。后者的正确处置是**让用户看到真实原因**，
   * 而不是拿空 token 去认证——那会得到 401，而 401 的文案会把用户引向
   * 「token 无效」，与真实原因（读不出来）不符。
   */
  private publishRememberedHost(): void {
    /**
     * 【为什么由启动参数提供 Host 时不能清空这两个键】
     *   生命周期顺序是 `onCreate`（`applyLaunchParams` 发布启动参数）→
     *   `onWindowStageCreate`（本函数）。两者用的是**同一批 AppStorage 键**，
     *   因此这里无条件的「先立一个空的未就绪值」会把刚带进来的地址与令牌直接抹掉——
     *   实测症状正是「用 `--ps dshHost/dshToken` 启动，界面却说『未配置 Host 地址』」。
     *   这类"两条写入路径争同一个键"的顺序缺陷不会报错，只会让功能悄悄不生效。
     */
    if (!this.launchHostProvided) {
      AppStorage.setOrCreate<string>(KEY_HOST_URL, '');
      AppStorage.setOrCreate<string>(KEY_HOST_TOKEN, '');
      AppStorage.setOrCreate<string>(KEY_HOST_TOKEN_STATE, 'pending');
      AppStorage.setOrCreate<boolean>(KEY_HOST_AUTOCONNECT, false);
    }

    // 页面连上之后会发事件报告「刚连上的 Host」，这里订阅并落盘
    // （地址走 preferences，token 走加密存储）。
    emitter.on({ eventId: EVENT_HOST_CONNECTED }, (data: emitter.EventData) => {
      const payload: Record<string, Object> = (data.data ?? {}) as Record<string, Object>;
      const url: string = typeof payload[EVENT_KEY_HOST_URL] === 'string'
        ? payload[EVENT_KEY_HOST_URL] as string : '';
      const token: string = typeof payload[EVENT_KEY_HOST_TOKEN] === 'string'
        ? payload[EVENT_KEY_HOST_TOKEN] as string : '';
      this.persistConnectedHost(url, token);
    });

    const ready: Promise<void> = this.hostStore.attach(this.context);
    ready.then(async () => {
      if (this.launchHostProvided) {
        // 启动参数已经给出本次要连的 Host，且已落盘；这里**不能**再用旧记录覆盖它
        hilog.info(DOMAIN, TAG, '跳过「记住的 Host」读取：本次由启动参数提供');
        return;
      }
      const host: RememberedHost | undefined = await this.hostStore.loadHost();
      if (host === undefined) {
        AppStorage.setOrCreate<string>(KEY_HOST_TOKEN_STATE, 'absent');
        return;
      }
      // 【修复早期版本留下的明文凭据】早期版本把用户粘贴的整串启动 URL
      // （含 `?token=…`）当成 baseUrl 存进了明文 preferences。这里在读取时
      // 剥掉 query 并回写，避免那份明文一直留在设备上。
      // 剥掉之后 token 需要重新建立（旧记录的 token 没进加密存储），
      // 因此这次会走到「没有可用的访问令牌」分支，请用户重贴一次——
      // 这是**有意的**：宁可让用户重贴一次，也不留一份明文凭据在设备上。
      const cut: number = host.baseUrl.search(/[?#]/);
      if (cut >= 0) {
        const sanitized: string = host.baseUrl.substring(0, cut);
        hilog.warn(DOMAIN, TAG, '检测到旧版明文 URL 记录，已剥离凭据并回写');
        await this.hostStore.saveHost(sanitized, host.lastSessionId);
        AppStorage.setOrCreate<string>(KEY_HOST_URL, sanitized);
        AppStorage.setOrCreate<string>(KEY_HOST_TOKEN_STATE, 'absent');
        return;
      }
      const token: RememberedToken = await this.hostStore.loadToken(host.baseUrl);
      AppStorage.setOrCreate<string>(KEY_HOST_URL, host.baseUrl);
      AppStorage.setOrCreate<string>(KEY_HOST_TOKEN_STATE, token.state as string);
      if (token.state === SecretLoadState.FOUND) {
        AppStorage.setOrCreate<string>(KEY_HOST_TOKEN, token.value);
        AppStorage.setOrCreate<boolean>(KEY_HOST_AUTOCONNECT, true);
      }
      hilog.info(DOMAIN, TAG, '记住的 Host=%{public}s token 状态=%{public}s',
        host.baseUrl, token.state as string);
    }).catch((_error: Object) => {
      // attach 内部已兜底；这里只把状态标成「读不到」，页面会给出对应文案
      AppStorage.setOrCreate<string>(KEY_HOST_TOKEN_STATE, 'unavailable');
      hilog.warn(DOMAIN, TAG, 'Host 连接记忆读取异常，本次不自动重连');
    });
  }

  /** 把页面报告的「刚连上的 Host」落盘（地址明文、token 加密） */
  private persistConnectedHost(url: string, token: string): void {
    if (url.length === 0) {
      return;
    }
    this.hostStore.saveHost(url, '').then(() => {
      if (token.length > 0) {
        return this.hostStore.saveToken(url, token);
      }
      return false;
    }).then((saved: boolean) => {
      // token 保存失败**不是**连接失败：只影响「下次能否自动重连」。
      // 如实记日志，不弹错误——用户这次已经连上了，报错只会制造困惑。
      hilog.info(DOMAIN, TAG, 'Host 已记住 url=%{public}s tokenLen=%{public}d tokenSaved=%{public}s',
        url, token.length, saved ? 'true' : 'false');
    }).catch((_error: Object) => {
      hilog.warn(DOMAIN, TAG, 'Host 落盘异常（不影响本次连接）');
    });
  }

  /** 台账标签：主窗固定；会话窗带标题，方便在诊断页与任务栏之间对号入座。 */
  private ledgerLabel(): string {
    const p: WindowParams = this.launchParams;
    if (p.kind === WindowKind.SESSION) {
      const shown: string = p.title.length > 0 ? p.title : p.sessionId;
      return shown.length > 0 ? `会话窗：${shown}` : '会话窗';
    }
    return '主窗';
  }

  /** 注册几何监听（仅主窗调用）。监听失败只降级为「不记忆几何」，不阻断窗口创建。 */
  private bindGeometry(win: window.Window): void {
    try {
      win.on('windowSizeChange', this.onGeometryChanged);
      win.on('windowRectChange', this.onGeometryChanged);
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, '注册窗口几何监听失败，几何记忆降级：%{public}s', e.message);
    }
    // 三键让位的**动态跟随**只挂手持档：PC/2in1 的让位恒为 0（见 WebApp 的
    // decorTopInsetVp 注释），多挂一个监听毫无收益、还会动到 PC 档行为 ⇒ 硬收口。
    if (!isHandheldForm()) {
      return;
    }
    try {
      this.onDecorStatusChanged = (_status: window.WindowStatusType): void => {
        this.refreshDecorCaps(win);
      };
      win.on('windowStatusDidChange', this.onDecorStatusChanged);
    } catch (err) {
      const e = err as BusinessError;
      writeDecorCapsDiag(this.context.filesDir, `statusWatch err=${e.code} ${e.message}`);
      hilog.warn(DOMAIN, TAG,
        '三键让位跟随（windowStatusChange）未挂上，让位保持启动时的结论：%{public}s', e.message);
    }
    try {
      this.onFreeWindowModeChanged = (enabled: boolean): void => {
        if (this.mainWindow !== win) {
          return;
        }
        this.freeWindowMode = enabled;
        this.refreshDecorCaps(win, false);
      };
      win.on('freeWindowModeChange', this.onFreeWindowModeChanged);
    } catch (err) {
      writeDecorCapsDiag(this.context.filesDir, `freeWatch error=${String(err)}`);
    }
    this.refreshDecorCaps(win);
  }

  /** 解绑几何监听；必须传同一个函数引用，否则会留下悬空回调。 */
  private unbindGeometry(win: window.Window | undefined): void {
    if (win === undefined) {
      return;
    }
    if (isHandheldForm()) {
      try {
        if (this.onFreeWindowModeChanged !== undefined) {
          win.off('freeWindowModeChange', this.onFreeWindowModeChanged);
        }
      } catch (err) {
        writeDecorCapsDiag(this.context.filesDir, `freeOff error=${String(err)}`);
      }
      try {
        if (this.onDecorStatusChanged !== undefined) {
          win.off('windowStatusDidChange', this.onDecorStatusChanged);
        }
      } catch (err) {
        writeDecorCapsDiag(this.context.filesDir, `statusOff error=${String(err)}`);
      }
      this.onFreeWindowModeChanged = undefined;
      this.onDecorStatusChanged = undefined;
      this.freeWindowMode = undefined;
      this.freeWindowStatus = undefined;
      this.freeDecorShown = false;
      this.freeButtonsShown = false;
    }
    try {
      win.off('windowSizeChange', this.onGeometryChanged);
      win.off('windowRectChange', this.onGeometryChanged);
      if (!isHandheldForm()) {
        // 与挂载对称：PC/2in1 档挂的是 windowWillClose（关闭 = 收进后台），
        // 手持档从不挂它，故只在非手持档解绑。
        win.off('windowWillClose', this.onWindowWillClose);
      }
    } catch (err) {
      const e = err as BusinessError;
      hilog.debug(DOMAIN, TAG, '解绑窗口几何监听失败：%{public}s', e.message);
    }
  }

  /**
   * 重算「系统三键此刻是否浮在内容上」并发布，同时按当前外观**重放三键配色**
   * （**只有手持档**会走到这里）。
   *
   * 【判据为什么与启动时完全同源】复用同一个纯函数 `decorPresentOf`，`decorHiddenOk` 用本
   * 实例记下的那次调用事实 —— 能挂上监听说明启动时 `setWindowDecorVisible(false)` 已成功
   * （标题栏已沉浸）；状态变化改的是"三键在不在"，不是"标题栏有没有隐藏"。
   * 【读失败为什么沿用旧值】801 是能力受限的正常回应（平板自由窗口实证）；归零会让让位在
   * 切换瞬间闪一下。真值与上次同量级 ⇒ 沿用最稳（见 decorHeightVp / decorFloating 的字段注释）。
   * 【为什么要在这里重放三键配色】见 `reassertDecorButtons` 的注释：装饰态会被平台重建/丢弃，
   * 只在主题变化时设一次的话，丢了就再也补不回来（深色顶栏 + 深色图标 = "按钮反色"）。
   */
  private revokeDecorStyle(): void {
    this.decorStyleWritable = false;
    if (isHandheldForm() && this.launchParams.kind === WindowKind.MAIN
      && this.decorStyleWindowId !== ''
      && AppStorage.get<string>(KEY_DECOR_STYLE_WINDOW_ID) === this.decorStyleWindowId) {
      AppStorage.setOrCreate<boolean>(KEY_DECOR_STYLE_WRITABLE, false);
    }
  }

  private publishDecorKeysVisible(value: boolean): void {
    if (isHandheldForm() && this.launchParams.kind === WindowKind.MAIN) {
      this.revokeDecorStyle();
    }
    AppStorage.setOrCreate<boolean>(KEY_DECOR_KEYS_VISIBLE, value);
  }

  private refreshDecorCaps(win: window.Window | undefined, readEnvironment: boolean = true): void {
    if (win !== this.mainWindow) {
      return;
    }
    this.revokeDecorStyle();
    if (!isHandheldForm() || win === undefined || !this.decorContentReady
      || this.launchParams.kind !== WindowKind.MAIN) {
      return;
    }
    if (readEnvironment) {
      try {
        this.freeWindowMode = win.isInFreeWindowMode();
      } catch (err) {
        this.freeWindowMode = undefined;
      }
    }
    try {
      this.freeWindowStatus = win.getWindowStatus();
      this.decorFloating = this.freeWindowStatus === window.WindowStatusType.FLOATING;
    } catch (err) {
      this.freeWindowStatus = undefined;
    }
    const pcModeNow: boolean = this.decorFloating === true;
    if (pcModeNow !== this.pcMode) {
      this.pcMode = pcModeNow;
      AppStorage.setOrCreate<boolean>(KEY_PC_MODE, pcModeNow);
    }
    this.freeDecorShown = false;
    this.freeButtonsShown = false;
    const restore: boolean = shouldRestoreFreeDecor(this.freeWindowMode, this.freeWindowStatus,
      this.decorForeground && !this.appBackgrounded);
    if (restore) {
      try {
        const id: string = String(win.getWindowProperties().id);
        this.decorStyleWindowId = id;
        AppStorage.setOrCreate<string>(KEY_DECOR_STYLE_WINDOW_ID, id);
        this.decorStyleWritable = true;
        AppStorage.setOrCreate<boolean>(KEY_DECOR_STYLE_WRITABLE, true);
        this.reassertDecorButtons(win);
      } catch (err) {
        this.revokeDecorStyle();
      }
    }
    let decorResult: string = 'skip';
    let buttonsResult: string = 'skip';
    if (restore) {
      try {
        win.setWindowDecorVisible(true);
        this.freeDecorShown = true;
        decorResult = 'ok';
      } catch (err) {
        decorResult = `error=${String(err)}`;
      }
      try {
        win.setWindowTitleButtonVisible(true, true, true);
        this.freeButtonsShown = true;
        buttonsResult = 'ok';
      } catch (err) {
        buttonsResult = `error=${String(err)}`;
      }
    }
    writeDecorCapsDiag(this.context.filesDir,
      `free=${String(this.freeWindowMode)} status=${String(this.freeWindowStatus)} ` +
      `foreground=${this.decorForeground && !this.appBackgrounded} desired=${restore ? 'restore' : 'system'} ` +
      `decor=${decorResult} buttons=${buttonsResult} ` +
      `decorCallOk=${this.freeDecorShown} buttonsCallOk=${this.freeButtonsShown}`);
    if (this.decorForeground && !this.appBackgrounded) {
      this.reassertWindowChrome('decor-status');
    }
  }

  /**
   * 当前生效外观（`'light' | 'dark'`）—— **跨层唯一权威**：页面在 `applySystemBarTheme` 里
   * 用同名同值的键发布（门禁 `check-decor-button-mode` 钉住两侧字面量相等）。
   * 页面还没加载/还没上报 ⇒ 取不到 ⇒ 浅色：与官方 boot 的 `:root{color-scheme:light}`
   * 以及页面侧顶栏初值 `#FFFFFF` 一致（启动瞬间不会"反色闪烁"）。
   */
  private appearanceMode(): string {
    const v: string | undefined = AppStorage.get<string>(KEY_APPEARANCE_MODE);
    if (v === 'dark' || v === 'light') {
      return v;
    }
    /*
     * 【2026-11-21 启动白底修复】页面还没上报（冷启动首帧）时不再默认浅色，改按
     * **系统当前深浅色**取 —— 否则深色系统下建窗就是白底，首帧后才变深，用户看到白闪。
     * 应用 `setColorMode(NOT_SET)` 时这里读到的就是系统值；用户固定外观时读到的是应用值，
     * 两种都等于「当前实际显示」，与 `startWindowBackground` 的资源解析同源。
     */
    try {
      return this.context.config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK
        ? 'dark'
        : 'light';
    } catch (e) {
      return 'light';
    }
  }

  /**
   * 按**当前生效外观**重设三键（全屏/最小化/关闭）配色 —— 本文件**唯一**一处 `setDecorButtonStyle`。
   *
   * 【为什么是"重设"而不是"设一次"】三键是**系统画的**装饰，配色属于窗口装饰态。2026-10-10
   * 平板真机 `diag-decor-caps` 显示窗口状态在 `FLOATING` / 其它之间来回切、且同一次变更会在
   * **同一毫秒**里连出 3 条刷新 ⇒ 装饰态一旦被平台重建或丢弃，"只在主题变化时设一次"的写法
   * 就再也补不回来 —— 深色外观下自绘顶栏是 `#151517`、三键却退回深色图标 = **黑底黑键**，
   * 用户看到的就是"按钮反色 / 三个按钮看不见"。重设幂等且廉价，故**启动与每次窗口状态变化
   * 都调一遍**（这一条同时兜住"启动那次调用失败后永远不再补"）。
   *
   * 【权威唯一】配色取自页面发布的外观，**不在这里写死 LIGHT** —— 写死过一次，
   * 2026-10-05 的「深色外观下黑底黑键」就是那么来的（见调用点的注释）。
   * 【返回值】`ok` / `err=<code>`，供 `diag-decor-caps` 的自证行使用：手机全屏、平板某些
   * 窗口态抛 801 是**正常回应**，只记不降级。
   */
  private reassertDecorButtons(win: window.Window): string {
    if (isHandheldForm() && (!this.decorStyleWritable || win !== this.mainWindow
      || !this.decorContentReady || !this.decorForeground || this.appBackgrounded
      || this.launchParams.kind !== WindowKind.MAIN
      || !shouldRestoreFreeDecor(this.freeWindowMode, this.freeWindowStatus, true))) {
      return 'system-owned';
    }
    const mode: string = this.appearanceMode();
    /* 【2026-11-19 平板系统标题栏「淡化」】收进本文件**唯一**一处 setDecorButtonStyle：
     * 平板手持档把三键缩小（背景 24vp / 间距 8vp / 贴右 12vp），降低标题栏存在感；
     * PC / 2in1 保持默认尺寸。**只改按钮样式，不改可见性** ⇒ 四边缩放与分屏入口不受影响。
     * 真正的"标题栏背景透明"无公开 API（SDK 仅 setWindowDecorVisible 整体隐藏），
     * 若需更彻底需改可见性（会失去四边缩放），属产品取舍，另行确认。 */
    const style: window.DecorButtonStyle = {
      colorMode: mode === 'dark'
        ? ConfigurationConstant.ColorMode.COLOR_MODE_DARK
        : ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT
    };
    if (isHandheldForm()) {
      style.buttonBackgroundSize = 24;
      style.spacingBetweenButtons = 8;
      style.closeButtonRightMargin = 12;
    }
    try {
      win.setDecorButtonStyle(style);
      return 'ok';
    } catch (err) {
      hilog.info(DOMAIN, TAG, '三键配色设置不适用（全屏 / 能力受限属正常）：%{public}s',
        (err as BusinessError).message);
      return `err=${(err as BusinessError).code}`;
    }
  }

  /**
   * 手机 / 平板统一不要系统标题栏三键，PC / 2in1 原样保留。
   *
   * `setWindowDecorVisible(false)` 只接管标题区域，并不保证隐藏右上角三键；
   * 平板自由窗口尺寸变化时，三键会与 Web 侧栏顶部按钮重叠。这里使用官方
   * `setWindowTitleButtonVisible(false,false,false)`（API 14+）明确隐藏三键。
   *
   * 能力受限设备返回 `err=<code>`，调用方仍保留既有 24vp 顶部让位兜底；
   * 不能把“隐藏失败”伪装成“没有按钮”。
   */
  private hideHandheldTitleButtons(win: window.Window): string {
    if (!isHandheldForm()) {
      return 'desktop-skip';
    }
    try {
      win.setWindowTitleButtonVisible(false, false, false);
      return 'ok';
    } catch (err) {
      const e = err as BusinessError;
      hilog.info(DOMAIN, TAG, '系统三键隐藏不适用（能力受限属正常）：%{public}s', e.message);
      return `err=${e.code}`;
    }
  }

  /**
   * 自由窗口档：把系统右上角三键显式拉回来。
   *
   * 分屏入口就在这组三键的菜单里；隐藏了就等于把入口抹掉（docs/416 的真机取证）。
   * 能力受限设备可能返回 err，调用方只记诊断、不降级（此时至少还有窗口边缘拖拽）。
   */
  private showTitleButtons(win: window.Window): string {
    try {
      win.setWindowTitleButtonVisible(true, true, true);
      return 'pc-shown';
    } catch (err) {
      hilog.info(DOMAIN, TAG, '恢复系统三键不适用：%{public}s', (err as BusinessError).message);
      return `err=${(err as BusinessError).code}`;
    }
  }

  /**
   * 按**当前生效外观**把窗口外观三件（状态栏配色 / 窗口底色 / 三键配色）再收敛一次。
   *
   * 【为什么要在前后台边界上做】任务卡片用的是**窗口快照**：用户"切浅色 → 立刻切后台"时，
   * 页面那条链（web 观测 → 桥 → `applySystemBarTheme`）可能还没跑完，快照就会带着上一套底色
   * （2026-10-16 用户报"浅色模式下 APP 卡片顶栏可能是黑色"）。取色与页面同一份
   * （`platform` 的 `windowChromeFor`），所以重放不会两处打架；失败只记日志
   * （全屏 / 受限窗口回 801 属正常）。
   */
  private reassertWindowChrome(why: string, foreground: boolean = true): void {
    const win: window.Window | undefined = this.mainWindow;
    if (win === undefined) {
      return;
    }
    const chrome = windowChromeFor(this.appearanceMode());
    /*
     * 【手持档自由窗口：状态栏交还系统】（2026-10-16 平板实测，与页面侧 applySystemBarTheme 同一条判据）
     *
     * 平板真机：同一台 MatePad Pro 12.2 上，QQ 的自由窗口 → 系统状态栏跟着桌面（深色），
     * 我们的自由窗口 → 整条被涂成 `#FFFFFF`（浅色外观）。SDK 明文写着这套属性**只在全屏 /
     * 最大化态生效**（`setWindowSystemBarProperties` 的 "does not take effect … non-full-screen …"）
     * ⇒ 我们只在"窗口真的占满屏幕"时才设。判据 = 窗口当前状态（`statusBarOwnedByApp`）：
     * 手持档里只有 `FULL_SCREEN(1)` / `MAXIMIZE(2)` 由我们设；`MINIMIZE(3)` 后台（**用户报的
     * 第二种形态就是它**：切后台那一拍的重放也会去涂系统状态栏）、`FLOATING(4)` 自由窗口、
     * `SPLIT_SCREEN(5)` 分屏一律交还系统。PC / 2in1 不进这条（`isHandheldForm()` 为假 ⇒ 逐字不动）；
     * 状态读不到（801）⇒ 维持老行为（照旧设）。
     *
     * 【第二批真机读数（2026-10-16，手机 45880）】`onBackground` 那一刻窗口状态**还是
     * `FULL_SCREEN`**（MINIMIZE 是随后才发生的）⇒ 只看状态判不出"我正在离开前台"。
     * 而"离开前台还去写系统状态栏"正是用户报的第二种形态 ⇒ 该路径按**语义**判：
     * `foreground === false`（`onBackground` 传进来的）时手持档一律不写；
     * `onForeground` / 窗口状态变化两条链仍按状态判（回到前台立刻补上）。
     */
    const handheld: boolean = isHandheldForm();
    const tabletImmersive: boolean = isTabletDevice();
    const winStatus: number | undefined = readWindowStatusOf(win);
    const ownStatusBar: boolean = statusBarOwnedByApp(handheld, winStatus) && (!handheld || foreground);
    if (!ownStatusBar) {
      /*
       * 【交还要**显式**做：底色置透明】（2026-10-16 用户第二次报障：多任务视图状态栏还是 `#151517`）
       *
       * 这套属性是窗口级一次写入、谁最后写谁说话。"切后台 / 自由窗口时什么都不做"只是**不覆盖** ⇒
       * 前台的深色底会一直留在系统状态栏上（多任务视图里就是"一条黑"）。所以这里把底色写成全透明，
       * 露出桌面 / 壁纸 / 多任务背景；**不动图标色**（那块背景不是我们的，正常路径里系统会自己重画）。
       * 详见 `platform/.../WindowChrome.ets` 的 `SYSTEM_BAR_HANDOFF_BG` 注释。
       */
      try {
        win.setWindowSystemBarProperties({ statusBarColor: SYSTEM_BAR_HANDOFF_BG })
          .catch((e: BusinessError): void => {
            hilog.debug(DOMAIN, TAG, '窗口外观重放（%{public}s）：交还底色的异步拒绝 code=%{public}d',
              why, e.code);
          });
        hilog.info(DOMAIN, TAG,
          '窗口外观重放（%{public}s）：手持档 %{public}s ⇒ 状态栏交还系统（底色置透明）', why,
          foreground
            ? ('非全屏 status=' + (winStatus === undefined ? 'unknown' : String(winStatus)))
            : '离开前台');
      } catch (e) {
        hilog.debug(DOMAIN, TAG, '窗口外观重放（%{public}s）：交还底色失败（忽略）', why);
      }
    } else {
      try {
        /*
         * 【平板：状态栏恒透明 = 真沉浸（2026-11-07 用户真机截图）】
         * 页面已由 `setWindowLayoutFullScreen(true)` 铺到状态栏下方，再把状态栏涂成
         * 不透明底色（chrome.bg）就会在顶部留下一条与页面不同色的带子（截图里的黑条）。
         * 平板一律透明，让页面背景自己透上来；图标明暗仍跟随外观。手机 / PC 不动。
         */
        win.setWindowSystemBarProperties({
          statusBarColor: tabletImmersive ? SYSTEM_BAR_HANDOFF_BG : chrome.bg,
          statusBarContentColor: chrome.content,
          isStatusBarLightIcon: chrome.lightIcon
        }).catch((e: BusinessError): void => {
          // 这套 API 返回 Promise：同步 try/catch 抓不到异步拒绝（801 / 1300002 都很常见）。
          hilog.debug(DOMAIN, TAG, '窗口外观重放（%{public}s）：状态栏属性异步拒绝 code=%{public}d：%{public}s',
            why, e.code, e.message);
        });
      } catch (e) {
        hilog.debug(DOMAIN, TAG, '窗口外观重放（%{public}s）：状态栏属性不适用：%{public}s',
          why, (e as BusinessError).message);
      }
    }
    try {
      win.setWindowBackgroundColor(chrome.bg);
    } catch (e) {
      hilog.debug(DOMAIN, TAG, '窗口外观重放（%{public}s）：窗口底色失败', why);
    }
    this.reassertDecorButtons(win);
  }

  /**
   * 几何变化节流：首次变化立即落盘，其后 500 ms 内的连续变化合并为一次**尾部**写入。
   *
   * 取舍：为什么保留尾部写入而不是只做「每 500 ms 采样一次」——用户拖动结束的那一次位置
   * 才是他真正想要的；若在拖动途中写下一个中间值就收工，进程随后被杀就会丢掉终点位置。
   * 立即写 + 合并尾部，两者都拿到了，代价只是一个最多 500 ms 的定时器。
   */
  private scheduleGeometrySave(): void {
    const now: number = Date.now();
    const elapsed: number = now - this.lastGeometrySaveAt;
    if (elapsed >= GEOMETRY_SAVE_INTERVAL_MS) {
      this.lastGeometrySaveAt = now;
      this.saveGeometryNow();
      return;
    }
    if (this.geometryTimer !== -1) {
      return;
    }
    this.geometryTimer = setTimeout(() => {
      this.geometryTimer = -1;
      this.lastGeometrySaveAt = Date.now();
      this.saveGeometryNow();
    }, GEOMETRY_SAVE_INTERVAL_MS - elapsed);
  }

  private saveGeometryNow(): void {
    const win: window.Window | undefined = this.mainWindow;
    if (win === undefined) {
      return;
    }
    this.memory.saveMainGeometry(win).then(() => {
      // 落盘成功无需处理：几何记忆不是关键路径，成功与否都不影响用户可见行为
    }).catch((_error: Object) => {
      hilog.debug(DOMAIN, TAG, '主窗几何落盘失败（已忽略）');
    });
  }
}

/**
 * 枚举 → 字符串。
 *
 * 单独抽出来的理由：`WindowKind` 是字符串枚举，但把它直接赋给 `string` 在 ArkTS 里
 * 依赖枚举的隐式兼容；显式转换让「AppStorage 里到底存的什么字面量」一目了然，
 * 也避免将来枚举值改动时静默改变跨层契约。
 */
function kindText(kind: WindowKind): string {
  return kind === WindowKind.SESSION ? 'session' : 'main';
}
