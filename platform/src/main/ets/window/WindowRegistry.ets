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
