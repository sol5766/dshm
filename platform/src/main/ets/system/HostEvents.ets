/**
 * 能力层 ↔ 页面之间的进程内事件契约（本文件是**唯一**定义处）。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 为什么需要这么一条通道
 *   页面与 UIAbility 之间没有直接引用：页面由 `windowStage.loadContent` 内部实例化，
 *   能力层拿不到它的对象，页面也拿不到 ability 实例。两者只能通过进程级的公共设施通信。
 *
 * 【为什么不是 AppStorage】`AppStorage` 是**状态**（有值、可被声明式订阅），
 * 但它没有命令式的变更通知接口；而「刚刚连上了一个 Host」是一次**通知**，
 * 不是一份需要持续持有的状态。把一次性通知塞进状态仓会让读到的时机与语义都变模糊
 * （页面重进时会把历史通知再读一遍）。
 *
 * 【为什么键定义在 platform 而不是各写一份】事件 id 与载荷键是**跨层契约**。
 * 两边各写一份数字 id 的后果是：改了一边、另一边不报错，只是**永远收不到通知**——
 * 而且不会有任何日志，因为发送方认为它发出去了。
 * 因此 id 与键都放在这里，两侧 `import` 同一份常量。
 * ────────────────────────────────────────────────────────────────────────
 */

/**
 * 「已连上某个 Host」的事件 id。
 *
 * 取一个不会与系统或其它库冲突的值（DSH 的固定前缀 `0xD5A1`）。
 */
export const EVENT_HOST_CONNECTED: number = 0xD5A1;

/** 事件载荷：Host 的地址（不含 token，形如 `http://127.0.0.1:3111`） */
export const EVENT_KEY_HOST_URL: string = 'url';
/**
 * 事件载荷：访问 token。
 *
 * 说明：它经过进程内的事件总线传到能力层，能力层立刻写入加密存储（`SecretStore`）。
 * 事件总线不落盘，这条路径上没有明文文件产生。
 */
export const EVENT_KEY_HOST_TOKEN: string = 'token';

/**
 * 「目录选择器已改用应用公共目录」的事件 id。
 *
 * 【为什么需要这条通道】用户在 Web 端选了一个**公共目录**（如 `Documents`）时，node（Host）侧
 * 不一定可写 —— picker 的 URI 授权**不跨进程**（详见 GitHub issue #3）。`WebApp` 会探写，
 * 失败就改用应用自己认领的 `Download/<包名>/`。**"换路径"这件事必须让用户知道**
 * （issue #3 的 R3 原文："UI 显示已授权、产出为零、无提示"），而换路径发生在 `WebApp`（Web 侧）、
 * 提示要由壳层（`Index`）显示 ⇒ 走这条进程内通道（与 `EVENT_HOST_CONNECTED` 同一套机制）。
 *
 * 载荷：`EVENT_KEY_PICKER_REASON`（为什么换）+ `EVENT_KEY_PICKER_PATH`（换成了哪个路径）。
 */
export const EVENT_PICKER_SUBSTITUTED: number = 0xD5A2;

/** 事件载荷：换路径的原因（一句给人看的中文说明） */
export const EVENT_KEY_PICKER_REASON: string = 'reason';
/** 事件载荷：换成的最终路径（应用公共目录的绝对路径；拿不到时为空串） */
export const EVENT_KEY_PICKER_PATH: string = 'path';
