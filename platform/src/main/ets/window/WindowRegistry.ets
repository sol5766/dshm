/**
 * 多窗口的**开启与路由参数**机制（D1 §7.7.5）。
 *
 * 窗口模型选择（关键决策，理由如下）：
 *   1. 不用 `window.createWindow` 造子窗——子窗生命周期挂在父窗上，「关任一窗口不影响
 *      其他窗口」（D1 §7.7.5b 验收点）就做不到；它也不是任务栏里独立的一条。
 *   2. 用 **specified 启动模式**的 UIAbility 实例：`AbilityStage.onAcceptWant` 按 key
 *      匹配实例，同一 key 复用（走 onNewWant），不同 key 新建。于是：
 *        - key = `main`：桌面图标、通知点击都回到**同一个**主窗，不会开出无限个窗口；
 *        - key = `session:<id>`：每个会话一个独立窗口，重复打开同一会话只聚焦已有窗口。
 *   3. specified 实例与主实例**同进程**（官方《UIAbility 组件启动模式》），
 *      因此 appstate 的模块级单例连接池被所有窗口共享——这是 §7.7.5b 的实现基础。
 *
 * 本文件只负责「怎么开」与「参数怎么传/怎么读」，不负责窗口内的界面。
 */

import { common, Want } from '@kit.AbilityKit';
import { display, window } from '@kit.ArkUI';
import { BusinessError, deviceInfo } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { FormFactor, readDeviceFacts, readFoldSnapshot } from '../system/DeviceFacts';
import type { FoldSnapshot } from '../system/DeviceFacts';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/window';

/** Want 参数键：窗口种类 */
export const PARAM_WINDOW_KIND: string = 'dshWindow';
/** Want 参数键：目标会话 id */
export const PARAM_SESSION_ID: string = 'dshSessionId';
/** Want 参数键：窗口标题（任务栏/最近任务里显示） */
export const PARAM_TITLE: string = 'dshTitle';
/** Want 参数键：通知点击带来的路由 JSON（与 appstate 的 NotifyRoute 同构） */
export const PARAM_ROUTE: string = 'dshRoute';
/**
 * Want 参数键：桌面快捷方式动作 id（来自 `shortcuts_config.json` 的 `wants.parameters`）。
 *
 * 【为什么平台层只透传不解释】动作 id 的语义属于产品面（`new-session` 等），
 * 由页面侧白名单消费（见 `Index.ets` 的 `applyLaunchAction`）。与 `PARAM_ROUTE` 同一纪律：
 * 参数键名是**跨窗口契约**，解析集中在 WindowRegistry 这一个文件，取值含义留给消费者。
 */
export const PARAM_ACTION: string = 'dshAction';

/** 窗口种类 */
export enum WindowKind {
  MAIN = 'main',
  SESSION = 'session'
}

/** 一个窗口实例的启动参数（解析后的强类型形态） */
export interface WindowParams {
  kind: WindowKind;
  sessionId: string;
  title: string;
  /** 通知路由 JSON（空串表示无）；解析归 appstate，避免 platform 认识产品页 */
  routeJson: string;
  /** 桌面快捷方式动作 id（空串表示无）；只透传，白名单在页面侧 */
  action: string;
}

/**
 * 从 Want 的 parameters 解析窗口参数。
 *
 * 为什么在这里解析而不是各 UIAbility 自己读：参数键名是**跨窗口契约**，
 * 一旦分散就会出现「开窗方写 sessionId、读窗方读 sid」这类静默错配。
 * 同时这里做了完整的缺省兜底——通知被系统重放、参数被截断都不能让窗口起不来。
 */
export function parseWindowParams(params: Record<string, Object> | undefined): WindowParams {
  const kindRaw: string = strOf(params, PARAM_WINDOW_KIND);
  return {
    kind: kindRaw === WindowKind.SESSION ? WindowKind.SESSION : WindowKind.MAIN,
    sessionId: strOf(params, PARAM_SESSION_ID),
    title: strOf(params, PARAM_TITLE),
    routeJson: strOf(params, PARAM_ROUTE),
    action: strOf(params, PARAM_ACTION)
  };
}

/** 安全取字符串参数：Want 参数值类型是 Object，必须显式收窄。 */
function strOf(params: Record<string, Object> | undefined, key: string): string {
  if (params === undefined) {
    return '';
  }
  const v: Object | undefined = params[key];
  if (v === undefined || v === null) {
    return '';
  }
  if (typeof v === 'string') {
    return v as string;
  }
  return '';
}

/**
 * 打开（或聚焦）一个会话窗口。
 *
 * @returns 是否成功发起；失败不抛，调用方回退为「在当前窗口内打开会话」
 */
export async function openSessionWindow(context: common.UIAbilityContext,
  sessionId: string, title: string): Promise<boolean> {
  const params: Record<string, Object> = {};
  params[PARAM_WINDOW_KIND] = WindowKind.SESSION;
  params[PARAM_SESSION_ID] = sessionId;
  params[PARAM_TITLE] = title;
  return startSelf(context, params);
}

/**
 * 按通知路由打开（或聚焦）目标窗口。
 *
 * 通知点击统一走这里：它既能把用户带到正确会话，也能保证「同一会话永远只有一个窗口」。
 */
export async function openRoutedWindow(context: common.UIAbilityContext, routeJson: string,
  sessionId: string, title: string): Promise<boolean> {
  const params: Record<string, Object> = {};
  params[PARAM_ROUTE] = routeJson;
  if (sessionId.length > 0) {
    params[PARAM_WINDOW_KIND] = WindowKind.SESSION;
    params[PARAM_SESSION_ID] = sessionId;
    params[PARAM_TITLE] = title;
  } else {
    params[PARAM_WINDOW_KIND] = WindowKind.MAIN;
  }
  return startSelf(context, params);
}

/** 回到主窗（用于「关闭本会话窗口」后把用户带回主界面）。 */
export async function focusMainWindow(context: common.UIAbilityContext): Promise<boolean> {
  const params: Record<string, Object> = {};
  params[PARAM_WINDOW_KIND] = WindowKind.MAIN;
  return startSelf(context, params);
}

/** 以自身 Ability 为目标发起启动；specified 模式会按 AbilityStage 的 key 决定复用还是新建。 */
async function startSelf(context: common.UIAbilityContext,
  parameters: Record<string, Object>): Promise<boolean> {
  const want: Want = {
    bundleName: context.abilityInfo.bundleName,
    abilityName: context.abilityInfo.name,
    parameters: parameters
  };
  try {
    await context.startAbility(want);
    return true;
  } catch (err) {
    const e = err as BusinessError;
    // 16000082：实例正在启动中——等价于「已经在开了」，视为成功
    if (e.code === 16000082) {
      return true;
    }
    hilog.warn(DOMAIN, TAG, 'startAbility failed: %{public}s', e.message);
    return false;
  }
}

/**
 * 取当前窗口的系统 id（字符串化）。
 *
 * 存在理由：`RuntimeSingleton` 的窗口台账要按窗口 id 登记。
 * 各 API 对窗口 id 的类型不一致（WindowProperties.id 是 number），统一转成字符串再比较。
 */
export async function currentWindowId(): Promise<string> {
  try {
    const win: window.Window = await window.getLastWindow(getContext());
    return String(win.getWindowProperties().id);
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, 'getLastWindow failed: %{public}s', e.message);
    return '';
  }
}

/**
 * 手持形态（手机 / 平板）：本窗口朝向**跟随屏幕旋转**（四向传感器跟随 + **受系统旋转锁定管辖**）。
 *
 * 【为什么需要横屏，但不钉死横屏】端侧界面是官方 Web 客户端（`pages/WebApp` 的 WebView），
 * 按桌面宽度排布：手机竖屏（1280 px / 3 ≈ 427 vp）连「设置」的两栏布局都放不下 —— 右侧内容
 * 被裁到屏幕外（2026-10-06 真机 dump：对话框宽 1113 px，而内部容器右缘已顶到 1280 px 屏边）；
 * 横屏宽度约翻倍（2832 px ≈ 944 vp），两栏放得下。但**钉死**横屏会丢掉竖屏手感（在手机上很
 * 别扭），而用户口径（2026-10-06）是：「首次安装初始化的时候横屏就可以完整设置了，然后平时
 * 用的时候可以竖屏，就跟随屏幕旋转」⇒ 把"能不能横过来"交给传感器，而**是否允许转交由系统旋转锁定决定**。
 *
 * 【为什么是 AUTO_ROTATION_RESTRICTED（=8）】SDK 原文（`@ohos.window.d.ts` 的 `Orientation`
 * 枚举）里 5 / 8 两个候选**方向集合完全相同**（竖 / 横 / 反向竖 / 反向横），差别只在谁管得着它：
 *   · `AUTO_ROTATION = 5`：「该旋转**不受**控制中心旋转开关管辖」；
 *   · `AUTO_ROTATION_RESTRICTED = 8`：「该旋转**受**控制中心旋转开关管辖」。
 * 选 8 —— 用户口径（2026-10-06，第二轮）：「手机、平板 屏幕旋转跟随系统旋转锁定，
 * **锁定的话就不能转，解锁就可以旋转**」。按 5 做过一版（无视锁定）：真机实测「开着旋转锁定
 * 照样能转」，与系统里其它应用的行为不一致，等于让「旋转锁定」这个开关在本应用上失效。
 * 代价是锁定时本应用保持竖屏 ⇒ 官方 Web 界面的两栏「设置」会重新被裁（见上一段）——
 * 这是用户主动选择的口径：想横过来就解锁，平时按系统开关走。
 * （另一候选 `AUTO_ROTATION_UNSPECIFIED = 12` 同样受开关管辖、方向集合「由系统决定」，
 * 但属 `SystemCapability.Window.SessionManager`、`@since 12`；本工程要的是明确语义，故选 8。
 * 对照：`LANDSCAPE = 2` 锁死单一方向，翻面会看到倒置界面。）
 *
 * 【为什么 2in1 / 桌面不设】PC 屏本来就是横屏，且窗口可自由缩放 —— 自绘顶栏三键与
 * 顶栏底色的接线回归（docs/99）都在那条路径上，显式改朝向收益为零却会动到已验证的行为。
 *
 * 【为什么在 onWindowStageCreate 里调】会话窗是**独立 EntryAbility 实例**（各有自己的
 * onWindowStageCreate）⇒ 一处调用等于所有窗口一起生效；`BackGroundAbility` 没有窗口，
 * 不受影响。
 *
 * 【API 26 的两条路径（2026-10-11 接入）】`targetSdkVersion` 抬到 `26.0.0` 后多了一个
 * **带回执**的版本：`setPreferredOrientationWithResult(orientation)` ⇒ `Promise<OrientationResult>`
 * （`executionResult: ORIENTATION_APPLIED / ORIENTATION_IGNORED / ORIENTATION_PENDING`）。
 * 选它是因为旧版 `setPreferredOrientation(...).then()` 的 promise **只表示"调用被受理"**，
 * 拿不到"策略到底生效了没有"——系统旋转锁定时平台会**受理但忽略**，此时旧路径照样打
 * "跟随屏幕旋转"，日志与事实相反（`docs/102` 的口径只能靠反推）。
 * 三条约束决定这里写成**双路径**而不是直接换掉：
 *   ① 该 API `@since 26.0.0` ⇒ 设备必须是 API ≥ 26（`deviceInfo.apiAvailable('26.0.0')` 守卫）；
 *      手持档里 API 24 的平板（本仓 `compatibleSdkVersion = 6.1.1(24)`）**装得上也必须能跑**；
 *   ② `deviceInfo.apiAvailable` **本身**就是 `@since 26.0.0` ⇒ 在 API 24 设备上该属性不存在，
 *      调用即 `TypeError` ⇒ 必须包在 try 里（返回 false = 走旧路径），不能只看返回值；
 *   ③ 该 API 声明 `@throws 801 / 1300002 / 1300003`（`Window.SessionManager`）⇒ 抛错时
 *      **回退到旧路径**，而不是让"跟屏"整体失效。
 * 两条路径最终设的都是同一个 `AUTO_ROTATION_RESTRICTED`，**PC/2in1 在上面就早退了**，
 * 本轮改动对它零影响。
 *
 * 失败只记日志：拿不到朝向不影响启动（降级为系统默认朝向）。
 */
export function followScreenRotationOnHandheld(windowStage: window.WindowStage): void {
  try {
    const form: FormFactor = readDeviceFacts().form;
    if (form !== FormFactor.PHONE && form !== FormFactor.TABLET) {
      return;
    }
    const win: window.Window = windowStage.getMainWindowSync();
    if (!orientationResultApiReady()) {
      applyPreferredOrientationLegacy(win, form);
      return;
    }
    win.setPreferredOrientationWithResult(window.Orientation.AUTO_ROTATION_RESTRICTED)
      .then((res: window.OrientationResult) => {
        logOrientationExecution(form, res.executionResult);
      })
      .catch((err: BusinessError) => {
        // 801（设备不支持该能力）/ 1300002（窗口状态异常）/ 1300003（窗口服务异常）
        // ⇒ 退回无回执路径，保住"能跟屏"这件事本身。
        hilog.warn(DOMAIN, TAG, '朝向结果 API 失败，回退无回执路径：%{public}s', err.message);
        applyPreferredOrientationLegacy(win, form);
      });
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, '设置跟随旋转异常（降级为系统默认朝向）：%{public}s', e.message);
  }
}

/**
 * 本设备是否具备「带执行结果的偏好朝向」API（`@since 26.0.0`）。
 *
 * `deviceInfo.apiAvailable` **自己**也是 `@since 26.0.0` ⇒ 在 API 24 设备上它是 `undefined`，
 * 直接调用会 `TypeError`。因此这里返回的是"能不能用"而不是"版本够不够"：
 * 调用失败一律当 false（走旧路径），绝不把守卫写成会抛的形态。
 */
function orientationResultApiReady(): boolean {
  try {
    return deviceInfo.apiAvailable('26.0.0');
  } catch (err) {
    return false;
  }
}

/**
 * 把回执的三种取值翻成日志口径。
 *
 * `ORIENTATION_IGNORED` 是**正常路径而不是错误**：系统旋转锁定开启（或设备不支持传感器旋转）时，
 * 平台受理调用但忽略策略 —— 这正是 `docs/102` 与用户口径「锁定就不转、解锁才转」在系统侧的
 * 落点。旧路径拿不到这个区分，所以只能笼统记"跟随屏幕旋转"；这里把它如实分开记。
 */
function logOrientationExecution(form: FormFactor, result: window.OrientationExecutionResult): void {
  if (result === window.OrientationExecutionResult.ORIENTATION_APPLIED) {
    hilog.info(DOMAIN, TAG, '手持形态（%{public}s）：朝向跟随屏幕旋转已生效（受系统旋转锁定管辖）', form);
    return;
  }
  if (result === window.OrientationExecutionResult.ORIENTATION_IGNORED) {
    hilog.info(DOMAIN, TAG,
      '手持形态（%{public}s）：朝向策略被系统忽略（系统旋转锁定开启或不支持传感器旋转）', form);
    return;
  }
  hilog.info(DOMAIN, TAG, '手持形态（%{public}s）：朝向策略待生效（PENDING）', form);
}

/**
 * 无回执的旧路径（设备 API < 26，或结果 API 抛错时的回退臂）。
 *
 * 异步失败与同步失败都只记日志：拿不到朝向不影响启动（降级为系统默认朝向）。
 */
function applyPreferredOrientationLegacy(win: window.Window, form: FormFactor): void {
  try {
    win.setPreferredOrientation(window.Orientation.AUTO_ROTATION_RESTRICTED).then(() => {
      hilog.info(DOMAIN, TAG, '手持形态（%{public}s）：朝向跟随屏幕旋转（受系统旋转锁定管辖）', form);
    }).catch((err: BusinessError) => {
      hilog.warn(DOMAIN, TAG, '设置跟随旋转失败（降级为系统默认朝向）：%{public}s', err.message);
    });
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, '设置跟随旋转异常（降级为系统默认朝向）：%{public}s', e.message);
  }
}

/* ── 折叠屏朝向（2026-10-28，用户口径："折叠屏单屏显示时设置 UI 要竖屏"）────────────
 *
 * 策略（与 `followScreenRotationOnHandheld` 并存，互不覆盖）：
 *   · **非折叠屏**：本函数直接早退 ⇒ 既有行为（手机/平板跟屏、PC 早退）**一个字节不变**；
 *   · 折叠屏**单屏**（物理折叠 或 宽度 < 600vp）：锁 `PORTRAIT`；
 *   · 折叠屏**展开**：`AUTO_ROTATION_RESTRICTED`（= 原先那条跟屏策略，受系统旋转锁定管辖）。
 *
 * 【为什么要订阅事件】折叠/展开是**运行期**变化：不订阅就只在启动那一刻算一次，
 * 展开后仍锁着竖屏（或折叠后仍可横过来）—— 正是用户报的那个毛病的两种表现。
 * 订阅 `foldDisplayModeChange`（优先，反映"当前渲染在哪块屏"）与 `foldStatusChange`（物理态兜底）。
 *
 * 【为什么重算要去抖】折叠过程中两个事件会连着来好几拍，逐拍设朝向既无意义、也可能与系统
 * 展开动画打架；150ms 合并成一拍（与页面侧 300ms 巡检同一思路，只求"最终态正确"）。
 */
const FOLD_REAPPLY_DEBOUNCE_MS: number = 150;

let foldWin: window.Window | null = null;
let foldListenersReady: boolean = false;
let foldReapplyTimer: number = -1;

/** 按当前折叠现场设置朝向。单屏 ⇒ 竖屏；展开 ⇒ 跟屏。失败只记日志（不阻断启动）。 */
function applyFoldOrientation(win: window.Window, snap: FoldSnapshot): void {
  const target: window.Orientation = snap.singleScreen
    ? window.Orientation.PORTRAIT
    : window.Orientation.AUTO_ROTATION_RESTRICTED;
  const label: string = snap.singleScreen ? '单屏（锁竖屏）' : '展开（跟随屏幕旋转）';
  try {
    if (!orientationResultApiReady()) {
      win.setPreferredOrientation(target).then(() => {
        hilog.info(DOMAIN, TAG, '折叠屏朝向：%{public}s / mode=%{public}d / 宽=%{public}d vp', label,
          snap.displayMode, Math.round(snap.widthVp));
      }).catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, '折叠屏朝向设置失败（降级系统默认）：%{public}s', err.message);
      });
      return;
    }
    win.setPreferredOrientationWithResult(target).then((res: window.OrientationResult) => {
      hilog.info(DOMAIN, TAG, '折叠屏朝向：%{public}s / mode=%{public}d / 宽=%{public}d vp / 执行=%{public}d',
        label, snap.displayMode, Math.round(snap.widthVp), res.executionResult);
    }).catch((err: BusinessError) => {
      hilog.warn(DOMAIN, TAG, '折叠屏朝向（回执路径）失败，回退无回执路径：%{public}s', err.message);
      try {
        win.setPreferredOrientation(target);
      } catch (e2) {
        const e3 = e2 as BusinessError;
        hilog.warn(DOMAIN, TAG, '折叠屏朝向降级失败：%{public}s', e3.message);
      }
    });
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, '折叠屏朝向异常（降级系统默认）：%{public}s', e.message);
  }
}

/** 合并同一轮折叠里的多拍事件。 */
function scheduleFoldReapply(): void {
  if (foldReapplyTimer >= 0) {
    clearTimeout(foldReapplyTimer);
  }
  foldReapplyTimer = setTimeout(() => {
    foldReapplyTimer = -1;
    const win = foldWin;
    if (win === null) {
      return;
    }
    applyFoldOrientation(win, readFoldSnapshot());
  }, FOLD_REAPPLY_DEBOUNCE_MS);
}

/** 只注册一次；老系统没有这些事件时降级为"不感知折叠变化"，不影响启动。 */
function installFoldListeners(): void {
  if (foldListenersReady) {
    return;
  }
  try {
    display.on('foldDisplayModeChange', (mode: display.FoldDisplayMode) => {
      hilog.info(DOMAIN, TAG, 'foldDisplayModeChange → %{public}d', mode);
      scheduleFoldReapply();
    });
    display.on('foldStatusChange', (status: display.FoldStatus) => {
      hilog.info(DOMAIN, TAG, 'foldStatusChange → %{public}d', status);
      scheduleFoldReapply();
    });
    foldListenersReady = true;
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, '折叠事件订阅失败（降级为启动期一次性判定）：%{public}s', e.message);
  }
}

/**
 * 折叠屏朝向入口（`EntryAbility.onWindowStageCreate` 调用，紧随 `followScreenRotationOnHandheld`）。
 * **非折叠屏在这里一个字节都不动**（早退）。
 */
export function applyFoldableOrientation(windowStage: window.WindowStage): void {
  let snap: FoldSnapshot;
  try {
    snap = readFoldSnapshot();
  } catch (err) {
    return;
  }
  if (!snap.foldable) {
    return;
  }
  try {
    foldWin = windowStage.getMainWindowSync();
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, '折叠屏取主窗失败（不设朝向）：%{public}s', e.message);
    return;
  }
  applyFoldOrientation(foldWin, snap);
  installFoldListeners();
}

/** 窗口销毁时解绑（幂等）。 */
export function releaseFoldableOrientation(): void {
  if (foldReapplyTimer >= 0) {
    clearTimeout(foldReapplyTimer);
    foldReapplyTimer = -1;
  }
  if (!foldListenersReady) {
    foldWin = null;
    return;
  }
  try {
    display.off('foldDisplayModeChange');
    display.off('foldStatusChange');
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, '折叠事件解绑失败：%{public}s', e.message);
  }
  foldListenersReady = false;
  foldWin = null;
}
