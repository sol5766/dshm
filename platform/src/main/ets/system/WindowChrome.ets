/**
 * 窗口外观取色的**唯一一份**真源（状态栏底色/前景色 + 窗口底色 + 状态栏图标明暗）。
 *
 * 【为什么要有这个文件（2026-10-16，用户报"浅色模式切后台，APP 卡片顶栏可能是黑色"）】
 * 取色原先散在两处：页面 `WebApp.applySystemBarTheme()`（跟随 web 侧观测到的外观）与
 * 能力层 `EntryAbility.reassertDecorButtons()`（只重设三键配色）。任务卡片用的是**窗口快照**，
 * 而"切后台那一刻"没有任何一处会把三样东西按当前外观**再收敛一次** ⇒ 只要外观刚切过、
 * 页面那条链还没跑完（或窗口装饰态被平台重建），快照就可能带着上一套（深色）底色。
 * 抽成纯函数之后：能力层在 `onBackground` 里也能按同一份取色重放，不必抄字面量。
 *
 * 【口径】与本仓 2026-09-26 起的自绘顶栏一致：深色 → `#151517` + 白字/浅色图标；
 * 浅色 → `#FFFFFF` + `#0F1115` 深字/深色图标。非 `'dark'` 一律按浅色（未知模式不吃深色）。
 */
export interface WindowChrome {
  /** 状态栏 / 窗口底色 */
  bg: string;
  /** 状态栏前景（时间、图标旁的文字色） */
  content: string;
  /** 状态栏图标是否用浅色（深底上用浅图标） */
  lightIcon: boolean;
}

export function windowChromeFor(mode: string): WindowChrome {
  if (mode === 'dark') {
    return { bg: '#151517', content: '#FFFFFF', lightIcon: true };
  }
  return { bg: '#FFFFFF', content: '#0F1115', lightIcon: false };
}

/**
 * **状态栏属性该不该由我们接管** —— 纯函数（2026-10-16 平板实测后的收窄）。
 *
 * 【为什么需要收窄】`setWindowSystemBarProperties` 的 SDK 原文（`@ohos.window.d.ts` @since 9）：
 * "The setting does not take effect when the main window is in non-full-screen or non-maximized mode
 * (such as floating windows or split-screen mode)." —— 也就是这套属性**只对"前台且占满屏幕"的窗口
 * 有意义**。可真机（MatePad Pro 12.2 / 鸿蒙 6.1）上它并不守约：同一台设备上，QQ 的自由窗口 →
 * 系统状态栏跟着桌面（深色），我们的自由窗口 → 整条被涂成 `#FFFFFF`（浅色外观）；应用切到后台
 * 那一刻的"重放"同样会去涂系统状态栏。用户看到的就是"平板/后台时顶栏一条白"。
 *
 * 【判据】只有 `handheld === true`（手机 / 平板 / 折叠屏）才收窄 —— PC / 2in1 **逐字不动**；
 * 手持档里只有 `FULL_SCREEN(1)` / `MAXIMIZE(2)` 才由我们设，其余（`MINIMIZE(3)` 后台、
 * `FLOATING(4)` 自由窗口、`SPLIT_SCREEN(5)` 分屏、`UNDEFINED(0)`）一律**交还系统**，
 * 由系统按桌面 / 分屏背景自己画（与其它应用一致）。状态读不到（801）时返回 `true`，
 * 即维持"照旧设"的老行为 —— 宁可维持现状，也不在信息不足时把状态栏丢掉。
 *
 * 【为什么是纯函数】判据只有两个输入，抽出来才能被门禁 `tools/check-decor-button-mode.mjs`
 * 直接求值断言（含"PC 恒 true"与"手持档后台/自由窗口必须 false"的负例）。数字是
 * `window.WindowStatusType` 的字面量（纯函数里不能引用枚举对象，否则门禁求值不到）。
 */
export function statusBarOwnedByApp(handheld: boolean, windowStatus: number | undefined): boolean {
  if (!handheld) {
    return true;
  }
  if (windowStatus === undefined) {
    return true;
  }
  return windowStatus === 1 /* FULL_SCREEN */ || windowStatus === 2 /* MAXIMIZE */;
}

/**
 * **交还系统**时用的状态栏底色：**全透明**（`#00000000`）。
 *
 * 【为什么"什么都不做"不够（2026-10-16 用户第二次报障）】用户给的两张图里，多任务视图（后台任务）
 * 的状态栏是 `#151517` —— 那正是本仓深色外观的状态栏色，而它下面的壁纸是 `#321B69`。
 * 机理：这套属性是**窗口级别的一次写入**，谁最后写谁说话；我们"切后台时不写"只是**不覆盖**，
 * 前台的 `#151517` 会一直留在系统状态栏上，直到别的应用去写。所以"交还"必须**显式**交还：
 * 把底色写成全透明 ⇒ 露出桌面 / 壁纸 / 多任务背景（与其它应用的沉浸表现一致）。
 *
 * 【为什么不动图标颜色】图标的深浅由"当前背景"决定，而交还之后那块背景不是我们的（壁纸/多任务），
 * 我们无从得知；实测（手机 62T0225B18039433）正常的"APP → 多任务"路径里，系统/启动器会**自己**
 * 重画状态栏（透明 + 深色图标）⇒ 我们只负责把**底色**让出去，图标交给它。因此这里只改 `statusBarColor`，
 * 不传 `statusBarContentColor` / `isStatusBarLightIcon`（保持上一次的值，且系统重画时会被一并接管）。
 */
export const SYSTEM_BAR_HANDOFF_BG: string = '#00000000';
