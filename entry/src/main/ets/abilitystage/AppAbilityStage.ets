/**
 * 模块级 AbilityStage：为 EntryAbility 的 **specified（指定实例）启动模式**提供接纳策略
 * （D1 §7.7.5 多窗口 / §7.7.5b「多窗口状态归属」）。
 *
 * 为什么必须有它（而不是让各调用方自己决定开几个窗）：
 *   module.json5 把 EntryAbility 的 launchType 设为 specified 之后，系统在每次 startAbility
 *   时都会先问本回调「这次启动应该落到哪个实例」。回调返回的字符串就是**实例 key**：
 *     key 已经存在 → 复用该实例（对它触发一次 onNewWant），key 是新的 → 新建一个实例。
 *   于是「到底开了几个窗口」这件事有了唯一的决策点。把它收敛到这里，是为了避免
 *   「桌面图标一条逻辑、通知点击另一条逻辑、深链第三条逻辑」各写各的 key 而互相打架。
 *
 * 为什么不用 `window.createWindow` 造子窗：见 platform/window/WindowRegistry.ets 的
 * 文件头注释（子窗生命周期挂在父窗上，且不是任务栏里独立的一条，做不到
 * 「关任一窗口不影响其他窗口」）。
 *
 * key 方案（只有两档，是刻意的）：
 *   1. `session:<sessionId>`——会话窗口按**会话 id** 分实例。这正是「同一会话重复打开
 *      只聚焦已有窗口」得以成立的根据：第二次打开携带同一个 sessionId，本回调返回同一个
 *      key，系统复用实例、只触发一次 onNewWant，绝不会冒出第二个窗口。
 *   2. `main`——其余一切（桌面图标点击、不带会话的通知、诊断、恢复）全部归到**唯一**
 *      主窗 key。桌面图标是可以被无限次点击的；若每次都给新 key，用户会看到窗口成串
 *      出现。收敛到一个 key 就是「启动器不会开出无限个窗口」的保证。
 *
 * 边界与取舍：
 *   - kind=session 但 sessionId 为空：**回退**到 `main`。这种 Want 语义上不成立（没有会话
 *     就没有会话窗），若为它单独造 key，一批坏的重复 Want 会持续造窗口直到撑爆任务栏；
 *     归并到主窗是此处唯一安全的兜底。
 *   - 本回调必须是**纯函数式**的：只读 want、不做 IO、不写全局状态。系统可能在任意时刻
 *     （甚至目标实例尚未创建完）调用它，任何副作用都会引入难以复现的时序问题。
 *   - 这里也**不**判断「实例是否真的还在」——那是系统的职责；本函数只声明期望的归属。
 *   - specified 实例与主实例**同进程**（官方《UIAbility 组件启动模式》），因此 appstate 的
 *     模块级单例连接池被所有窗口共享。这是 §7.7.5b 验收点「N 个窗口只有 1 条 mux 连接、
 *     1 条 $events」的实现基础：窗口变多不会变出第二条连接。
 *   - 本类与 HAP **一一对应**（整个模块只有一个 AbilityStage 实例），所以这里绝不能保存
 *     任何窗口级状态——窗口级状态属于 UIAbility 实例。分清这两层，是排查
 *     「改了 A 窗口却影响 B 窗口」时的第一条线索。
 */

import { AbilityStage, Want } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { parseWindowParams, WindowKind, WindowParams } from 'platform';
// 【为什么不再继承 web_engine 的 `WebAbilityStage`】那个基类的 onCreate 会
// `initNativeContext(libadapter.so)` —— `libadapter.so` 是**阶段一 Electron 通道**的桥接库。
// 阶段二不需要它，而它在模拟器（x86_64）上**根本不存在**（只有 arm64 预编译件），
// 于是基类里 `getNativeContext` 落到 undefined 上抛 TypeError，应用被 RuntimeError 终止。
// 端侧运行时的正确挂载点是 CMake 构建的 `libdshhost`（D6 E30/E31），与 nativeContext 无关。
// 连带把 entry 对 web_engine 的依赖整个去掉：Electron 那套（libelectron 181 MB 等）不再进包。

const DOMAIN: number = 0x0000;
const TAG: string = 'entry/abilitystage';

/** 主窗实例 key：唯一，收敛所有「非会话」启动 */
const KEY_MAIN: string = 'main';
/** 会话窗实例 key 前缀：其后拼会话 id */
const KEY_SESSION_PREFIX: string = 'session:';

export default class AppAbilityStage extends AbilityStage {
  onCreate(): void {
    // 基类（裸 AbilityStage）的 onCreate 是空实现；显式调用只为表明"这里没有隐藏前置条件"
    super.onCreate();
    hilog.info(DOMAIN, TAG, 'AbilityStage.onCreate 完成（无 Electron 桥接依赖）');
  }

  /**
   * 决定本次 specified 启动复用还是新建实例（返回值 = 实例 key）。
   *
   * 参数解析统一走 platform 的 `parseWindowParams`：窗口参数键名是**跨窗口契约**，
   * 若在这里手写 `want.parameters['dshSessionId']`，一旦契约改名就会出现
   * 「开窗方写 sessionId、读窗方读 sid」这类静默错配（多窗口问题里最难查的一类）。
   */
  onAcceptWant(want: Want): string {
    let key: string = KEY_MAIN;
    try {
      // want.parameters 允许为 undefined（系统重放/构造缺失），parseWindowParams 已做兜底
      const parsed: WindowParams = parseWindowParams(want.parameters);
      if (parsed.kind === WindowKind.SESSION && parsed.sessionId.length > 0) {
        key = `${KEY_SESSION_PREFIX}${parsed.sessionId}`;
      }
    } catch (err) {
      // 兜底理由：本回调抛异常会让整次启动**直接被拒**——用户点了图标却什么都没发生，
      // 且日志里只有一条栈。宁可回落到主窗 key，让应用至少还能起来。
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, '解析启动参数失败，回落到主窗 key：%{public}s', e.message);
      key = KEY_MAIN;
    }
    // 记一条决策日志：这是「开了 N 个窗口」的第一手证据，排查多窗口问题时先看它
    hilog.info(DOMAIN, TAG, 'onAcceptWant → 实例 key = %{public}s', key);
    return key;
  }
}
