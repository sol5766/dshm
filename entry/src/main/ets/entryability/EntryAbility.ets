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

import { AbilityConstant, common, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { appRecovery } from '@kit.AbilityKit';
import fs from '@ohos.file.fs';
import dshhost from 'libdshhost.so';
import probe from 'libentryprobe.so';
import { DshHost, OpResult } from 'hostruntime';
import { NodeRuntime } from '../runtime/NodeRuntime';
// HMS 语音识别桥（ArkTS 侧）：轮询 Host 写的请求文件并调 speechRecognizer
import { startHmsSpeechBridge } from '../speech/HmsSpeechBridge';
// 系统托盘（PC 顶栏状态区）：关闭=切后台之后的**回程入口**，也是真正的退出路径
import { StatusBarTray } from '../system/StatusBarTray';
import { emitter } from '@kit.BasicServicesKit';
import { window } from '@kit.ArkUI';
import {
  applyThemeMode,
  EVENT_HOST_CONNECTED,
  EVENT_KEY_HOST_TOKEN,
  EVENT_KEY_HOST_URL,
  HostStore,
  KeepAlive,
  KEY_THEME_MODE,
  LocalPrefs,
  NotificationCenter,
  parseWindowParams,
  readDeviceFacts,
  registerWindow,
  relabelWindow,
  SecretLoadState,
  ThemeMode,
  unregisterWindow,
  WindowKind,
  WindowMemory,
  WindowParams
} from 'platform';
import type { NotificationDraft, RememberedHost, RememberedToken } from 'platform';
import { assertNoSensitiveContent, notificationFor, SessionHub } from 'appstate';
import type { NotifyHooks, NotifyInput } from 'appstate';

const DOMAIN = 0x0000;
/** 本文件新增日志的 tag；既有日志沿用 'testTag' 不动，避免无意义的 diff 噪音 */
const TAG: string = 'entry/ability';

/**
 * 冷启动监视器是否已挂（报告 4 ②）。
 *
 * 【为什么是模块级而不是实例字段】`launchType = specified` 下同一个 UIAbility 会被
 * 反复复用/重建（多窗），实例字段每建一次都会是 false ⇒ 挂出多个 1.5s 轮询、
 * 且可能对同一个 host-exit-mode 并发触发多次冷启动。模块级只挂一个。
 */
let restartWatcherStarted: boolean = false;

/** 窗口几何落盘的最小间隔（ms）。拖动窗口会以帧级频率触发几何变化，直写会打爆 preferences。 */
const GEOMETRY_SAVE_INTERVAL_MS: number = 500;

/**
 * 启动参数经 AppStorage 交给页面的键。
 *
 * 这是**跨 workstream 的契约**：键名一旦定下，能力层与页面两侧都不得各改各的。
 */
const KEY_LAUNCH_KIND: string = 'dshLaunchKind';
const KEY_LAUNCH_SESSION_ID: string = 'dshLaunchSessionId';
const KEY_LAUNCH_TITLE: string = 'dshLaunchTitle';
const KEY_LAUNCH_ROUTE_JSON: string = 'dshLaunchRouteJson';
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
  /** 本实例的主窗口对象；几何读写与监听释放都要用它 */
  private mainWindow: window.Window | undefined = undefined;
  /** 窗口记忆（preferences 句柄），onWindowStageCreate 时 attach */
  private memory: WindowMemory = new WindowMemory();
  /** Host 连接记忆（地址走 preferences、token 走加密存储），onWindowStageCreate 时 attach */
  private hostStore: HostStore = new HostStore();
  /**
   * 长时任务（后台保活）。
   *
   * 【为什么能力层必须持有并真正调用它】`platform/notify/KeepAlive.ets` 早就写好了
   * 申请/释放的完整实现，但**全仓无人调用**（只有 `platform/Index.ets` 的 re-export）。
   * 后果：应用退到后台后会被系统挂起，与 Host 的长连接随之中断 ——
   * 而「关闭窗口 = 切后台继续跑任务」这条诉求正建立在"后台仍活着"之上。
   * 没有它，`onPrepareToTerminate` 的最小化只是把窗口收起来，任务照样停。
   *
   * 申请时机：主窗窗口就绪后（此时 context 可用、且确认是主窗）。
   * 释放时机：`onDestroy`。申请失败只降级（日志警告），不阻断任何功能。
   */
  private keepAlive: KeepAlive = new KeepAlive();
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
   * 【为什么两个标记都要】`dshQuitRequested` 走 AppStorage，是**页面 → 能力层**的通道；
   * 本字段是**能力层内部**的一次性闩：`exitApp` 会被多处触发（托盘后台进程被系统结束等），
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
  /** 系统通知机制（能力层持有 context，故在此装配） */
  private notifier: NotificationCenter = new NotificationCenter();
  /** 本机偏好（主题模式等） */
  private prefs: LocalPrefs = new LocalPrefs();
  /** 通知授权是否已查过（只查/只弹一次） */
  private notifyChecked: boolean = false;
  private notifyReady: boolean = false;
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

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
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
     * 最小探针（见 CMakeLists.txt）：先回答"hvigor 自己用 CMake 构建的原生模块能否绑上"。
     * 这一问的答案决定下一步：能绑 ⇒ 手工放 .so 是根因，把 dshhost 改成 CMake 构建即可；
     * 不能绑 ⇒ 问题在这条导入链本身，与 .so 从哪来无关。
     */
    try {
      const hello: string = probe.hello();
      hilog.info(DOMAIN, TAG, 'DSHM-PROBE cmake 构建的原生模块可绑定，返回值=%{public}s', hello);
    } catch (err) {
      const e = err as BusinessError;
      let pk: string = '(无法枚举)';
      try {
        pk = JSON.stringify(Object.keys(probe as Object));
      } catch (inner) {
        pk = '(枚举抛错)';
      }
      hilog.error(DOMAIN, TAG, 'DSHM-PROBE cmake 模块绑定失败：%{public}s', e.message);
      hilog.error(DOMAIN, TAG, 'DSHM-PROBE 模块类型=%{public}s 导出键=%{public}s', typeof probe, pk);
    }
    /*
     * 阶段二的**运行时门**：直接问原生模块"链接进来的 Node 是哪个版本"。
     *
     * 为什么这就是门：只要 `runtimeVersion()` 返回非空，就同时证明了三件事——
     *   ① `libdshhost.so` 加载成功（NAPI 模块注册成功）；
     *   ② 它依赖的 `libnode.so.127` 在设备上**也**加载成功（否则动态链接就失败了）；
     *   ③ 我们自建的 Node 版本号可读。
     * 反过来，若这里报错或返回空，就说明运行时还不可用，**不能**往下声称 Host 能起。
     *
     * 位置刻意放在 onCreate 最前面：它要早于任何可能失败或退出的后续步骤，
     * 这样即使应用随后出问题，这条读数也已经进了 hilog（stdout 在设备上看不见，见 D6 E23）。
     */
    try {
      const v: string = dshhost.runtimeVersion();
      hilog.info(DOMAIN, TAG, 'DSHM-RUNTIME libnode 版本 = %{public}s', v.length > 0 ? v : '(空串)');
    } catch (err) {
      const e = err as BusinessError;
      // 把"模块到底长什么样"一起打出来：加载失败与"注册没被认到"是两回事，
      // 前者 import 就抛，后者会得到一个空模块（导出全是 undefined）——必须能区分。
      let keys: string = '(无法枚举)';
      try {
        keys = JSON.stringify(Object.keys(dshhost as Object));
      } catch (inner) {
        keys = '(枚举抛错)';
      }
      hilog.error(DOMAIN, TAG, 'DSHM-RUNTIME 调用原生模块失败：%{public}s', e.message);
      hilog.error(DOMAIN, TAG, 'DSHM-RUNTIME 模块类型=%{public}s 导出键=%{public}s',
        typeof dshhost, keys);
    }
    this.autoStartHostForDiagnosis();
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
    // 先于 onWindowStageCreate 发布：窗口标签与「是否主窗」的判断都依赖它
    this.applyLaunchParams(want);
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
      hilog.info(DOMAIN, TAG, 'DSHM-RESTART 收到整机冷启动请求，调用 appRecovery.restartApp()');
      try {
        appRecovery.restartApp();
      } catch (e) {
        const err = e as BusinessError;
        hilog.error(DOMAIN, TAG, 'DSHM-RESTART 冷启动失败：%{public}s（1 分钟内重复重启会被平台限流）', err.message);
      }
    }, 1500);
    // 与 Host 侧 poller 同为 unref 语义（ArkTS 无 unref：作为模块级计时器存活，随进程结束而止）
    if (timer < 0) {
      hilog.warn(DOMAIN, TAG, '冷启动监视器未能启动');
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
    // 入口脚本随包放在 resources/resfile/resources/app/main.js（见 coreHost 的注释）
    // 沙箱 HOME 用 filesDir：hdc 对 cacheDir 无读权限，而诊断日志要能被取回（见 NodeRuntime 注释）
    // 第 3 实参 = UIAbility 上下文（本类自身就是 UIAbility，`this.context` 即 UIAbilityContext）：
    // `NodeRuntime.start()` 要用它在 spawn 之前认领 `Download/<包名>/`（见 NodeRuntime 注释）。
    // 【为什么必须在这里传】本方法是**首启唯一实际执行的 Host 启动路径**：不传 ⇒ 认领被跳过、
    // `DSHM_PUBLIC_DOWNLOAD` 为空 ⇒ 默认工作区静默退回沙箱，用户可见存储上零足迹（40 轮真机实证）。
    const runtime = new NodeRuntime(`${ctx.resourceDir}/resources/app/main.js`, ctx.filesDir,
      this.context as common.UIAbilityContext);
    const host = new DshHost(ctx.filesDir, runtime);
    // 存成字段：退出流程要调 `host.stop()` 干净地停掉宿主（见 host 字段的说明）
    this.host = host;
    hilog.info(DOMAIN, TAG, 'DSHM-AUTO 开始：入口=%{public}s', `${ctx.resourceDir}/resources/app/main.js`);
    // 把三个目录的**真实字符串**打出来：入口脚本的诊断日志要落在一个我们能用 hdc 取回的
    // 目录里，而 `filesDir` / `cacheDir` 在设备上到底映射到哪条路径，靠猜已经错过一次。
    hilog.info(DOMAIN, TAG, 'DSHM-AUTO 目录：files=%{public}s cache=%{public}s temp=%{public}s resource=%{public}s',
      ctx.filesDir, ctx.cacheDir, ctx.tempDir, ctx.resourceDir);
    runtime.probe().then((p) => {
      hilog.info(DOMAIN, TAG, 'DSHM-AUTO 探测：available=%{public}s node=%{public}s note=%{public}s',
        p.available ? 'true' : 'false', p.nodeVersion, p.note);
      return host.installBundled(ctx.resourceDir, ctx.cacheDir);
    }).then((r) => {
      AppStorage.setOrCreate<boolean>(KEY_CORE_INSTALLING, false);
      hilog.info(DOMAIN, TAG, 'DSHM-AUTO 安装内置核心：installed=%{public}s failed=%{public}d note=%{public}s',
        JSON.stringify(r.installed), r.failed.length, r.note);
      return host.start();
    }).then((s) => {
      hilog.info(DOMAIN, TAG, 'DSHM-AUTO 启动 Host：ok=%{public}s url=%{public}s note=%{public}s',
        s.ok ? 'true' : 'false', s.handle === null ? '' : s.handle.url, s.note);
      if (s.ok && s.handle !== null) {
        this.adoptLocalHost(s.handle.url);
      }
    }).catch((e: Object) => {
      hilog.error(DOMAIN, TAG, 'DSHM-AUTO 异常：%{public}s', String(e));
    });
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
    AppStorage.setOrCreate<string>(KEY_HOST_URL, baseUrl);
    if (token.length > 0) {
      AppStorage.setOrCreate<string>(KEY_HOST_TOKEN, token);
      AppStorage.setOrCreate<string>(KEY_HOST_TOKEN_STATE, 'found');
      AppStorage.setOrCreate<boolean>(KEY_HOST_AUTOCONNECT, true);
    }
    // Web 壳页只认这个键：handleUrl 是本次进程拿到的完整启动 URL，token 必然有效
    AppStorage.setOrCreate<string>(KEY_HOST_LAUNCH_URL, handleUrl);
    this.persistConnectedHost(baseUrl, token);
    hilog.info(DOMAIN, TAG, 'DSHM-AUTO 已接入本端 Host：base=%{public}s tokenLen=%{public}d',
      baseUrl, token.length);
  }

  onDestroy(): void {
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

      /*
       * 【2026-10-05 补：任何终止路径都要把应用收干净】
       *
       * 症状：**任务栏右键「退出」不生效** —— 应用像是还在跑。
       *
       * 根因：主动退出只走 `exitApp()`（托盘右键「退出」/ 后台事件），它才会
       * 「停核心 → 摘托盘图标 → 通知托盘进程退出 → terminateSelf」。而**系统发起的终止**
       * （任务栏右键「退出」、系统清理）不经过 `exitApp()`，直接走到本回调：
       *   · 宿主（同进程 Node 线程）没人停 ⇒ 仍占着回环端口；
       *   · 托盘图标没人摘、托盘后台 Ability（**另一个进程**）没人通知 ⇒ 留下孤儿进程；
       * ⇒ 用户看到的正是"点了退出，应用还在"。
       *
       * 修法：把收尾补在**销毁路径**上。关闭窗口那条路（`onPrepareToTerminate` 拦成最小化）
       * 不会走到这里，所以"关闭 = 收进后台继续跑"的既有行为不受影响。
       * 顺序与 `exitApp()` 一致：先停核心（协作式、幂等，成本一次文件写入），再摘图标、再通知托盘。
       */
      if (!this.exiting) {
        this.exiting = true;
        AppStorage.setOrCreate<boolean>('dshQuitRequested', true);
        hilog.info(DOMAIN, TAG, '销毁路径收尾：停核心 + 摘托盘 + 通知托盘进程退出');
        try {
          StatusBarTray.remove(this.context);
        } catch (err) {
          hilog.warn(DOMAIN, TAG, '销毁路径摘托盘图标失败（继续）：%{public}s', (err as BusinessError).message);
        }
        try {
          StatusBarTray.publishExitRequest();
        } catch (err) {
          hilog.warn(DOMAIN, TAG, '销毁路径通知托盘进程失败（继续）：%{public}s', (err as BusinessError).message);
        }
        this.stopHostThenExit().catch((err: BusinessError) => {
          hilog.warn(DOMAIN, TAG, '销毁路径停核心异常（进程即将结束）：%{public}s', err.message);
        });
      }
    }
  }

  /**
   * 自由窗口（PC / 平板）上点右上角「关闭」时的拦截点。
   *
   * ## 为什么需要它
   *
   * 默认行为是**终止应用**：正在跑的任务与那条 Host 长连接会一起断掉。
   * 用户诉求（2026-09-27 实测反馈）：「关闭 = 切到后台继续跑，任务别丢；
   * 点任务栏图标能直接回来」。所以这里把「关闭」改成「最小化到后台」。
   *
   * ## 返回值语义（SDK 原文）
   *
   * `true` = **取消**终止；`false` = 继续终止。
   * 因此返回 `true`，并主动把主窗最小化 —— 顺序不能反：
   * 若先最小化再返回，系统仍会走完终止流程。
   *
   * ## 为什么必须声明 PREPARE_APP_TERMINATE 权限
   *
   * SDK：`@permission ohos.permission.PREPARE_APP_TERMINATE`。
   * 没有它这个回调**不会被调用**，而失败形态是「关闭照旧杀掉应用」——
   * 看起来像「这个功能没做」，而不像「权限没声明」。该权限在 SDK 权限表里是
   * `availableLevel: normal` + `grantMode: system_grant` ⇒ 安装即授予，无弹窗。
   *
   * ## 为什么不用 windowStageClose
   *
   * SDK 明确：**注册了 `windowStageClose` 监听时本回调不会执行**。
   * 两条路只能选一条，这里选本回调（有明确权限约束、返回值语义清楚）。
   * 本工程因此**刻意不注册**那个监听。
   *
   * ## 怎么真正退出（重要）
   *
   * 本回调让「关闭」永不终止应用 ⇒ 必须另有一条退出路径，否则用户被关在里面。
   * 那条路径是**系统托盘图标右键菜单里自带的「退出」**——真机实测（2026-09-29）它
   * **不经过本回调**，点下去主进程与 BackGroundAbility 进程一起消失，是可靠且用户熟悉的入口。
   * 我们因此**不再自建**「退出应用」菜单项（那会得到两个退出项），托盘右键只提供
   * 「打开应用」；应用内顶栏「DSHM」菜单也不再放退出项（见 pages/WebApp.ets 的 appMenu）。
   *
   * `exitApp` 仍保留，但只由**托盘后台进程被系统结束**这一异常路径触发：那时图标已随进程
   * 消失、主窗又没有回程入口，留着才真的成了"关不掉也回不去"。
   *
   * ## 为什么托盘没就绪就必须放行
   *
   * 拦截关闭的前提是「用户还有回程入口」。托盘图标没挂上时若仍拦截，用户会遇到
   * 「窗口收进后台、托盘里找不到、只能去系统设置强停」——比直接关掉糟得多。
   * 所以这里先问 `StatusBarTray.isReady()`，拿不到回程入口就放行。
   */
  onPrepareToTerminate(): boolean {
    // 用户显式要求退出（exitApp 置的标记）⇒ 放行，不拦截。
    //
    // 【为什么需要这道判断】本回调返回 true 就永不终止应用。若用户想真退出，
    // 必须有办法绕过去。SDK 说 `terminateSelf` 是"手动关闭"的正当路径，
    // 但为**不把能否退出押在对 SDK 的理解上**，这里再查一次显式标记：
    // 「退不出去」是比「多退一步」严重得多的失败形态。
    if (AppStorage.get<boolean>('dshQuitRequested') === true) {
      hilog.info(DOMAIN, TAG, '收到显式退出请求：放行终止');
      return false;
    }
    // 只拦主窗：会话窗（specified 实例）关闭**不应**牵动整个应用。
    // 复用同一实例的多窗场景下，关一个会话窗把整个应用最小化会很突兀。
    if (this.launchParams.kind !== WindowKind.MAIN) {
      return false;
    }
    /*
     * 托盘图标没挂上 ⇒ 放行，不拦截（理由见文档注释「为什么托盘没就绪就必须放行」）。
     *
     * 这条判断不是防御性代码，而是**这条功能的必要条件**：拦截关闭把窗口收进后台之后，
     * 用户唯一的回程入口就是托盘图标。图标没挂上（系统不支持
     * SystemCapability.PCService.StatusBarManager、图标资源缺失、接口限流…）时若仍拦截，
     * 用户会得到「窗口不见了、托盘里没有、只能去系统设置强停」——比直接关掉糟得多。
     */
    if (!StatusBarTray.isReady()) {
      hilog.warn(DOMAIN, TAG, '托盘图标未就绪，放行关闭以免窗口收起后无入口唤回');
      return false;
    }
    const win: window.Window | undefined = this.mainWindow;
    if (win === undefined) {
      // 拿不到窗口对象（时序异常）⇒ 不拦截，把决定权交回系统。
      // 这里刻意不"兜底成取消"：那时既没最小化、也没关闭，用户点关闭会毫无反应。
      hilog.warn(DOMAIN, TAG, '关闭请求到达时主窗不可用，按系统默认继续终止');
      return false;
    }
    hilog.info(DOMAIN, TAG, '收到关闭请求：改为最小化到后台（不终止应用，任务与连接保留）');
    win.minimize().catch((err: BusinessError) => {
      // 最小化失败（设备不支持自由窗口等）时**不装作成功**：
      // 此时已返回 true ⇒ 应用不会终止，窗口仍在屏上。
      // 用户可再点一次关闭，或用托盘图标右键菜单里系统自带的「退出」真正退出。
      hilog.warn(DOMAIN, TAG, '最小化到后台失败（应用未终止，窗口仍在）：%{public}s', err.message);
    });
    return true;
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
    if (this.windowId.length > 0) {
      // 会话被改名后再从通知点进来，任务栏/诊断页里的标签要跟上
      relabelWindow(this.windowId, this.ledgerLabel());
    }
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
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
    if (this.launchParams.kind === WindowKind.MAIN) {
      this.publishRememberedHost();
      // 通知也只在主窗注册：`SessionHub` 的钩子只有一个槽位，
      // 若每个窗口都注册，多窗口下会出现"发 N 条同样的通知"。
      this.setupNotifications();

      /*
       * 申请长时任务（后台保活）——这是「关闭窗口 = 切后台继续跑」能成立的**前提**。
       *
       * 不申请的话，应用退到后台会被系统挂起：与 Host 的那条长连接断掉、
       * 正在执行的任务也随之停摆。那样 `onPrepareToTerminate` 的最小化
       * 就只是"把窗口收起来"，任务照样丢 —— 与用户诉求相反。
       *
       * 只在主窗申请：与会话窗共享同一进程，一个长时任务就够；
       * 每个实例各申请一次会让引用计数虚高、且系统侧重复登记。
       */
      this.keepAlive.attach(this.context);
      this.keepAlive.acquire().then((active: boolean) => {
        if (active) {
          hilog.info(DOMAIN, TAG, '后台保活已就绪：关闭窗口后任务与连接继续');
        } else {
          // 申请失败属**降级**而非错误：回到前台时仍会补拉状态。
          // 如实记日志，不假装成功（用户若发现关窗后任务停了，这条日志是判据）。
          hilog.warn(DOMAIN, TAG, '后台保活未授予，关闭窗口可能中断任务（降级运行）');
        }
      }).catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, '后台保活申请异常（降级运行）：%{public}s', err.message);
      });

      // 托盘常驻图标：关闭切后台之后的**回程入口**，也是真正的退出路径（见 setupTray）
      this.setupTray();
    }

    // 主界面 = Web 壳页：官方 apps/desktop 的鸿蒙等价物（loadURL → Host web UI）。
    // Index/Poc1 保留在 main_pages 里（诊断/回退入口），不再是默认主页。
    windowStage.loadContent('pages/WebApp', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, 'testTag', 'Failed to load the content. Cause: %{public}s', JSON.stringify(err));
      } else {
        hilog.info(DOMAIN, 'testTag', 'Succeeded in loading the content.');
      }
      // 内容加载完成后再登记台账：台账是「窗口已可用」的证据面，登记过早会给出假阳性。
      // 加载失败也照常登记——台账要反映的是**窗口**，不是页面加载成功与否。
      this.afterWindowStageReady(windowStage);
    });
  }

  onWindowStageDestroy(): void {
    // Main window is destroyed, release UI related resources
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onWindowStageDestroy');

    // 只清理**本实例**的东西。这里刻意不触碰任何共享资源，也不遍历其他窗口——
    // 「关任一窗口不影响其他窗口与其连接」这条验收，正是靠这里的克制成立的。
    if (this.geometryTimer !== -1) {
      clearTimeout(this.geometryTimer);
      this.geometryTimer = -1;
    }
    this.unbindGeometry(this.mainWindow);
    this.mainWindow = undefined;
    if (this.windowId.length > 0) {
      unregisterWindow(this.windowId);
      hilog.info(DOMAIN, TAG, '窗口已注销 id=%{public}s', this.windowId);
      this.windowId = '';
    }
  }

  onForeground(): void {
    // Ability has brought to foreground
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onForeground');

    // 回到前台时确保主窗真的在屏上。
    //
    // 【为什么需要在 onForeground 里做】从托盘图标/Dock 唤回本应用时，系统只是把任务切到前台，
    // 并不一定撤销窗口的**最小化**状态：`onPrepareToTerminate` 那条路径把窗口 minimize 了，
    // 仅"回到前台"可能仍然是一个最小化窗口。这里补一次恢复，用户点图标才能真正看到界面。
    if (this.launchParams.kind === WindowKind.MAIN) {
      this.ensureWindowShown();
    }
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
  private ensureWindowShown(): void {
    const win: window.Window | undefined = this.mainWindow;
    if (win === undefined) {
      return;
    }
    // 取一个非空别名给异步回调用：ArkTS 不做跨回调的非空收窄
    const target: window.Window = win;
    target.restore().then(() => {
      hilog.info(DOMAIN, TAG, '主窗已恢复到前台');
    }).catch((restoreErr: BusinessError) => {
      hilog.debug(DOMAIN, TAG, 'restore 未生效（可能本就未最小化）：%{public}s', restoreErr.message);
      target.showWindow().catch((showErr: BusinessError) => {
        hilog.warn(DOMAIN, TAG, '唤回主窗失败：%{public}s', showErr.message);
      });
    });
  }

  /**
   * 挂托盘常驻图标并接线三条交互（仅主窗调用）。
   *
   * 失败必须**降级而不抛**：托盘是「关闭=切后台」的回程入口，挂不上只是回到旧行为
   * （点关闭照旧退出应用），不该连带影响启动。所以这里把失败收敛成
   * 「托盘未就绪」这一个可判定状态——`onPrepareToTerminate` 会读它并放行关闭。
   */
  private setupTray(): void {
    const ctx: common.UIAbilityContext = this.context;
    StatusBarTray.install(ctx).then(() => {
      hilog.info(DOMAIN, TAG, '托盘图标已就绪，关闭窗口后可从托盘唤回');
      // 顺序不能反：`NEW_PROCESS_ATTACH_TO_STATUS_BAR_ITEM` 的前提是"应用已有状态栏图标"
      setTimeout(() => {
        StatusBarTray.hold(ctx);
      }, 300);
    }).catch((err: BusinessError) => {
      hilog.warn(DOMAIN, TAG, '托盘图标初始化失败（降级：关闭仍会退出应用）：%{public}s', err.message);
    });

    // 左键唤回主窗：系统把任务切到前台 + onForeground 里补一次 restore
    StatusBarTray.onIconClick((clickType: string) => {
      if (clickType !== 'leftClick') {
        return;
      }
      hilog.info(DOMAIN, TAG, '托盘图标左键：唤回主窗');
      this.restoreMainWindow();
    });

    // 右键菜单「打开应用」：与左键同一条唤回路径
    // （真正的「退出」用系统自带的那一项，见 StatusBarTray 文件头）
    StatusBarTray.onRightMenuClick(() => {
      hilog.info(DOMAIN, TAG, '托盘右键「打开应用」：唤回主窗');
      this.restoreMainWindow();
    });

    // 托盘后台 Ability 被系统结束 ⇒ 图标很可能已随之消失，先让关闭不再被拦截（否则
    // 用户会关在门外），再走退出收尾，避免「主 Ability 已死、图标还在」的半死状态。
    StatusBarTray.subscribeBgTerminating(() => {
      StatusBarTray.markUnavailable();
      this.exitApp('托盘后台进程被系统结束');
    });
  }

  /** 把应用（连同最小化的主窗）唤到前台。托盘左键、托盘右键「打开应用」共用。 */
  private restoreMainWindow(): void {
    this.context.showAbility().catch((err: BusinessError) => {
      hilog.warn(DOMAIN, TAG, 'showAbility 唤回失败：%{public}s', err.message);
    });
  }

  /**
   * 真正退出应用：停核心 → 摘托盘图标 → 结束 Ability。
   *
   * 【为什么要先停核心】官方不保证 `terminateSelf()` 会清理应用自己拉起的 Node 线程。
   * 宿主是同进程线程（见 runtime/NodeRuntime.ets 文件头），进程真死时它自然一起死，
   * 但只要存在"进程没立刻死"的时序，残留的宿主就会占着回环端口，下次启动撞"端口已占用"。
   * 停一次是协作式且幂等的（`DshHost.stop()`），成本一个文件写入，收益是确定的下次启动。
   *
   * 【为什么先置 `dshQuitRequested`】`terminateSelf()` 若仍走 `onPrepareToTerminate`，
   * 回调见到标记会放行；若不走，标记也无害（进程即将结束）。两种 SDK 行为下都能退出。
   *
   * 【顺序】摘图标要在**还有前台窗口**时做（SDK：无前台窗口时 removeFromStatusBar 报
   * 1010710004）。本方法由托盘右键/后台事件触发时窗口恰好还在，所以先 remove 再 terminate。
   */
  private exitApp(reason: string): void {
    if (this.exiting) {
      return;
    }
    this.exiting = true;
    AppStorage.setOrCreate<boolean>('dshQuitRequested', true);
    hilog.info(DOMAIN, TAG, '开始退出应用：%{public}s', reason);

    this.stopHostThenExit().then(() => {
      StatusBarTray.remove(this.context);
      // 托盘后台 Ability 是**另一个进程**，terminateSelf 只结束本实例，不会连它一起收掉。
      // 不通知它自行退出，就会留下一个"图标已摘、进程还在"的孤儿。
      StatusBarTray.publishExitRequest();
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
      // 走到这里意味着 stopHostThenExit 自己抛了（理论上不该，它内部已兜底）
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
    const win: window.Window | undefined = this.mainWindowOf(windowStage);
    if (win === undefined) {
      return;
    }
    this.mainWindow = win;

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
    }

    // 只有主窗参与几何记忆：saveMainGeometry 固定写 'main.rect'，若让会话窗也监听，
    // 会话窗一挪动就会把主窗的几何覆盖掉（用户会看到主窗位置被「偷走」）。
    if (this.launchParams.kind !== WindowKind.MAIN) {
      return;
    }
    // ── 自由窗口标题栏沉浸（2026-09-21 品牌对齐）──────────────────────────
    // 官方文档（窗口沉浸式·自由窗口标题栏沉浸案例）：setWindowDecorVisible(false)
    // 隐藏系统标题栏的应用图标+应用名（也就消除了与新应用图标不同步的旧图），
    // 保留右上角三键（全屏/最小化/关闭），页面扩展至原标题栏区域；透明标题栏
    // 区域保留系统默认的「拖动移动窗口 / 双击最大化」能力——自绘 TopBar（鲸鱼
    // 标识 + DSHM/编辑菜单）因此成为窗口第一行，其空白处天然可拖动窗口
    // （华为浏览器 Tab 页签同款方案）。三键避让由 WebApp 顶栏动态处理
    // （getTitleButtonRect + windowTitleButtonRectChange 监听）。
    // 手机全屏模式没有窗口装饰：调用抛 801 属预期，吞掉即可（功能等价 no-op）。
    try {
      win.setWindowDecorVisible(false);
      // 【三键区高度（2026-09-24）】官方《自由窗口适配》5.1.3 的沉浸式方案是两步：
      // setWindowDecorVisible(false) 隐藏图标+应用名后，**必须再调 setWindowDecorHeight
      // 控制右上角三键区显示及显示高度**——只调前者时三键区高度不保证（MateBook 14
      // 控制右上角三键区显示及显示高度**——只调前者时三键区高度不保证（MateBook 14
      // 实测三键直接不可见，即用户报的"右上角三个按钮看不见"）。取 38 与自绘顶栏
      // TOP_BAR_HEIGHT 同值：三键叠在白底顶栏上（顶栏右侧 decorPadRight 已避让），
      // 白底衬托深色三键（2026-09-26 验收口径）。API 约束 [37,112]vp 整数，38 在界内。
      win.setWindowDecorHeight(38);
      // 【三键颜色（2026-09-26）】DecorButtonStyle.colorMode 不设时三键**自动匹配
      // 系统深浅色**（SDK @ohos.window.d.ts DecorButtonStyle 注释原文）：系统深色模式
      // 下三键画成浅色图标，叠在**恒白**的自绘 TopBar 上对比度归零——用户报"三个
      // 按钮看不见"。自绘顶栏白底黑字是**固定验收口径**（深色底观感不佳已回退），
      // 故强制 COLOR_MODE_LIGHT 让三键恒用浅色模式样式（深色图标），不再随系统翻转。
      win.setDecorButtonStyle({ colorMode: ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT });
      hilog.info(DOMAIN, TAG, '窗口装饰已隐藏且三键区高度=38、三键恒深色：自绘顶栏接管窗口第一行（自由窗口沉浸）');
    } catch (err) {
      hilog.info(DOMAIN, TAG, '窗口装饰隐藏不适用（全屏模式属正常）：%{public}s',
        (err as BusinessError).message);
    }
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
   * 已知代价（写下来，免得后来者以为它是免费的）：AppStorage 是**进程级**的，四个键名不带
   * 窗口标识，因此它承载的语义是「最近一次发布的启动参数」。正常情况下每个窗口在自己的
   * onCreate/onNewWant 里发布、紧接着自己的页面初始化时读取，时序自洽；但若两个窗口几乎
   * 同时启动（例如连续 startAbility 两个会话），后发布者会覆盖前者的值，理论上会出现
   * 「新窗口读到上一个窗口的会话」。真正无歧义的做法是**每窗一份**：把参数存进该窗口自己的
   * LocalStorage 并通过 `windowStage.loadContent(path, storage)` 注入，或把窗口 id 拼进键名。
   * 本层按约定只落这四个全局键（页面侧据此读取），故先把风险记在这里：一旦出现
   * 「新窗口显示的是上一个窗口的会话」这类反馈，就按上面的方向改成每窗一份，而不是加锁。
   */
  private applyLaunchParams(want: Want): void {
    const parsed: WindowParams = parseWindowParams(want.parameters);
    this.launchParams = parsed;
    AppStorage.setOrCreate<string>(KEY_LAUNCH_KIND, kindText(parsed.kind));
    AppStorage.setOrCreate<string>(KEY_LAUNCH_SESSION_ID, parsed.sessionId);
    AppStorage.setOrCreate<string>(KEY_LAUNCH_TITLE, parsed.title);
    AppStorage.setOrCreate<string>(KEY_LAUNCH_ROUTE_JSON, parsed.routeJson);
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
  private setupNotifications(): void {
    this.notifier.attach(this.context);
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
      this.notifier.publish(draft).then(() => {
      }).catch((_error: Object) => {
      });
    }).catch((_error: Object) => {
    });
  }

  /** 惰性申请授权（只查/只弹一次） */
  private async prepareNotify(): Promise<boolean> {
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
  }

  /** 解绑几何监听；必须传同一个函数引用，否则会留下悬空回调。 */
  private unbindGeometry(win: window.Window | undefined): void {
    if (win === undefined) {
      return;
    }
    try {
      win.off('windowSizeChange', this.onGeometryChanged);
      win.off('windowRectChange', this.onGeometryChanged);
    } catch (err) {
      const e = err as BusinessError;
      hilog.debug(DOMAIN, TAG, '解绑窗口几何监听失败：%{public}s', e.message);
    }
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
