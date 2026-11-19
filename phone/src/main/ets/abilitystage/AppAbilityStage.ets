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

import { AbilityStage, appRecovery, application, Want } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { parseWindowParams, WindowKind, WindowParams } from 'platform';
// 【为什么不再继承 web_engine 的 `WebAbilityStage`】那个基类的 onCreate 会
// `initNativeContext(libadapter.so)`。本工程不需要它，而它在模拟器（x86_64）上
// **根本不存在**（只有 arm64 预编译件），
// 于是基类里 `getNativeContext` 落到 undefined 上抛 TypeError，应用被 RuntimeError 终止。
// 端侧运行时的正确挂载点是 CMake 构建的 `libdshhost`（D6 E30/E31），与 nativeContext 无关。
// 连带把 entry 对 web_engine 的依赖整个去掉，避免把无用的大体积桥接库打进包。

const DOMAIN: number = 0x0000;
const TAG: string = 'entry/abilitystage';

/** 主窗实例 key：唯一，收敛所有「非会话」启动 */
const KEY_MAIN: string = 'main';
/** 会话窗实例 key 前缀：其后拼会话 id */
const KEY_SESSION_PREFIX: string = 'session:';

/**
 * AppStorage 键：本次进程的「应用预加载类型」（`application.AppPreloadType` 的数值）。
 *
 * 供启动链上的其它环节读取（例如后面对"是否走更激进的前移初始化"做决策）。
 * 只在 `AppAbilityStage.onCreate` 里写一次；读不到（旧系统）时为 `UNSPECIFIED`。
 */
const KEY_APP_PRELOAD_TYPE: string = 'dshAppPreloadType';

/** 枚举 → 人话（只用于日志，便于真机一眼读数） */
function preloadTypeName(t: application.AppPreloadType): string {
  if (t === application.AppPreloadType.TYPE_CREATE_WINDOW_STAGE) {
    return '已预加载到窗口创建完成';
  }
  if (t === application.AppPreloadType.TYPE_CREATE_ABILITY_STAGE) {
    return '已预加载到 AbilityStage 创建完成';
  }
  if (t === application.AppPreloadType.TYPE_CREATE_PROCESS) {
    return '已预加载到进程创建完成';
  }
  return '未预加载';
}

/**
 * 把预加载类型记进 AppStorage（失败静默）。
 *
 * 【为什么单独包一层 try】`AppStorage` 是 ArkUI 的全局态，**在本工程的既有代码里
 * 从未在 AbilityStage 层用过**（其余调用点都在 EntryAbility 及之后，即 UI 上下文起来之后）。
 * 而 AbilityStage.onCreate 可能早于 ArkUI 运行时初始化 ⇒ 直接写有抛异常打死启动的风险。
 * 这条信息只用于后续"要不要前移初始化"的决策，**存不下也没关系**，绝不能因此起不来。
 */
function rememberAppPreloadType(t: application.AppPreloadType): void {
  try {
    AppStorage.setOrCreate<number>(KEY_APP_PRELOAD_TYPE, t as number);
  } catch (e) {
    const err = e as BusinessError;
    hilog.warn(DOMAIN, TAG, 'DSHM-PRELOAD 写入 AppStorage 失败（不影响启动）：%{public}s', err.message);
  }
}

/**
 * 读取本进程的预加载类型（失败一律回落 `UNSPECIFIED`）。
 *
 * 【为什么必须包 try】这是启动路径上**第一行**平台调用：设备若跑在 API 22 以下的
 * 系统上（本项目 target 26，但真机系统版本未必跟得上），`application.getAppPreloadType`
 * 可能不存在。抛异常会直接打死 AbilityStage ⇒ 应用起不来。
 * 「探针失败」绝不能升级成「启动失败」——这是本函数的唯一纪律。
 */
function probeAppPreloadType(): application.AppPreloadType {
  try {
    const t: application.AppPreloadType = application.getAppPreloadType();
    hilog.info(DOMAIN, TAG,
      'DSHM-PRELOAD 本进程预加载类型=%{public}d（%{public}s）',
      t as number, preloadTypeName(t));
    return t;
  } catch (e) {
    const err = e as BusinessError;
    hilog.warn(DOMAIN, TAG, 'DSHM-PRELOAD 读取预加载类型失败（按 UNSPECIFIED 处理）：%{public}s',
      err.message);
    return application.AppPreloadType.UNSPECIFIED;
  }
}


export default class AppAbilityStage extends AbilityStage {
  onCreate(): void {
    /*
     * 应用预加载（App Preload）探针 —— 与 entry 端逐字同义，说明见
     * `entry/src/main/ets/abilitystage/AppAbilityStage.ets` 的同名注释。
     * 只读一次枚举 + 打一行日志，**不改变任何启动行为**。
     */
    // 基类（裸 AbilityStage）的 onCreate 是空实现；显式调用只为表明"这里没有隐藏前置条件"
    super.onCreate();
    rememberAppPreloadType(probeAppPreloadType());
    /*
     * 【整机冷启动的前置开关】皮肤/插件市场「重启后生效」那条链的**唯一开关**（2026-10-09 真机实证）。
     *
     * 症状：appRecovery.restartApp() 调用成功、无异常、日志打完就没有下文，进程 pid 不变，
     * App 停在「连接已断开」的死态（Host 早已 process.exit(0) 退出），用户装完皮肤点「使用」
     * 必然落到这里。**根因不是调用姿势，而是平台的前置条件没满足**：OpenHarmony 实现
     * frameworks/native/ability/native/recovery/app_recovery.cpp：
     *     bool AppRecovery::ScheduleRecoverApp(StateReason reason) {
     *         if (!ShouldRecoverApp(reason)) return false;
     *         if (!isEnable_) {
     *             if (GetParameter("const.dfx.sub_health_recovery.enable","") == "true") { ...; return true; }
     *             return false;      // 没开恢复：静默 return false（JS 侧得到 undefined，不抛）
     *         }
     *         ...
     *     }
     * 而 isEnable_ **只**由 EnableAppRecovery() 置真 ⇒ 本应用此前从未调用它，
     * 有没有 setRestartWant 都一样，restartApp() 都是那个静默 return false。
     *
     * 【为什么放在 AbilityStage.onCreate 而不是 EntryAbility.onCreate】平台的 ability 恢复记录
     * 是在 **ability 创建时**（AppRecovery::AddAbility）按当时的 flag 快照建的，而 AbilityStage.onCreate
     * 早于任何 ability 创建 ⇒ 这里开的档才对能力生效（同一份实现里 useAppSettedValue_ 就是为
     * 「应用自己设过值」准备的）。本类与 HAP 一一对应，只跑一次。
     *
     * 【为什么是 RESTART_WHEN_JS_CRASH，而不是 ALWAYS_RESTART / NO_RESTART】
     *   · NO_RESTART 会让 ShouldRecoverApp() 直接 return false ⇒ 连**手动** restartApp 也一起失效
     *     （同一份实现的第一行判断）⇒ 不能用；
     *   · 手动路径（StateReason::DEVELOPER_REQUEST）在**任何**非 NO_RESTART 档下都返回 true ⇒ 取最窄的
     *     那档即可：只把「JS 崩溃自动拉起」这一种崩溃语义带进来，不额外打开 APP_FREEZE / CPP_CRASH。
     *
     * 【已知平台限制（写在这里省得下次再撞）】restartApp() 有 1 分钟限流：两次调用间隔 ≤ 1 分钟时
     * **只退出不重启**；另外 DoRecoverApp() 只对**处于前台**的 ability 生效 ⇒ 后台时调用同样不重启。
     * 两条都由 EntryAbility 侧的兜底退出接住（不留死态）。
     */
    try {
      appRecovery.enableAppRecovery(appRecovery.RestartFlag.RESTART_WHEN_JS_CRASH,
        appRecovery.SaveOccasionFlag.SAVE_WHEN_ERROR, appRecovery.SaveModeFlag.SAVE_WITH_FILE);
      hilog.info(DOMAIN, TAG, 'DSHM-RESTART 已开启应用恢复（restartApp 生效的前置条件）');
    } catch (err) {
      const e = err as BusinessError;
      hilog.error(DOMAIN, TAG, 'DSHM-RESTART 开启应用恢复失败（整机冷启动会退化为兜底退出）：%{public}s',
        e.message);
    }
    hilog.info(DOMAIN, TAG, 'AbilityStage.onCreate 完成（无 web_engine 桥接依赖）');
  }

  /**
   * 决定本次 specified 启动复用还是新建实例（返回值 = 实例 key）。
   *
   * 参数解析统一走 platform 的 `parseWindowParams`：窗口参数键名是**跨窗口契约**，
   * 若在这里手写 `want.parameters['dshSessionId']`，一旦契约改名就会出现
   * 「开窗方写 sessionId、读窗方读 sid」这类静默错配（多窗口问题里最难查的一类）。
   */
  onAcceptWant(want: Want): string {
    return this.resolveInstanceKey(want);
  }

  /**
   * 决定本次 launched-with-`specified` 启动的实例 key（**唯一判定点**）。
   *
   * 【为什么同步/异步两个回调共用这一个函数】两者是同一件事的两种调用形态，
   * 判定逻辑分两份就会漂移（一个改了另一个没改 ⇒ 同一次启动走不同 key）。
   */
  private resolveInstanceKey(want: Want): string {
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
    return key;
  }

  /**
   * 异步版实例 key（docs/322 首启修复）。
   *
   * 【为什么必须有它 —— 真机日志实证】手机首启偶发"点了图标进不去，杀进程再点才行"，
   * 日志里每次启动都有这一行：
   *   `AppKit: [JAS935]get 'onAcceptWantAsync' object failed`
   * SDK 原文（`AbilityStage.d.ts`）：**API 20 起，只要实现了 `onAcceptWantAsync`，
   * 就不会再触发同步的 `onAcceptWant`**；反之系统会先找异步版、找不到才回落。
   * 只实现同步版时，这条回落路径在"进程刚被杀 / 首次安装"的冷启时刻并不总能走通
   * （沙箱/AbilityStage 尚未就绪），于是启动被搁置 —— 杀掉进程后再点才恢复正常。
   *
   * ⇒ 两个都实现：异步版走同一判定函数，系统不再打 JAS935，也不再走那条回落。
   * 【失败语义】这里**绝不 reject**：reject 等于"拒绝本次启动"，
   * 表现为点了图标毫无反应；解析异常已在 `resolveInstanceKey` 内兜底为主窗 key。
   */
  async onAcceptWantAsync(want: Want): Promise<string> {
    const key: string = this.resolveInstanceKey(want);
    // 第一手证据：与同步版同一条日志文案，排查多窗口/首启时先看它
    hilog.info(DOMAIN, TAG, 'onAcceptWantAsync → 实例 key = %{public}s', key);
    return key;
  }
}
