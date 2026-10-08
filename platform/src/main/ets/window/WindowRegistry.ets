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
import { window } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { FormFactor, readDeviceFacts } from '../system/DeviceFacts';

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
    routeJson: strOf(params, PARAM_ROUTE)
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
 * 失败只记日志：拿不到朝向不影响启动（降级为系统默认朝向）。
 */
export function followScreenRotationOnHandheld(windowStage: window.WindowStage): void {
  try {
    const form: FormFactor = readDeviceFacts().form;
    if (form !== FormFactor.PHONE && form !== FormFactor.TABLET) {
      return;
    }
    const win: window.Window = windowStage.getMainWindowSync();
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
