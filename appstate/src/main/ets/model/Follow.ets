/**
 * 贴底跟随模型（P1 §8：「sticky-follow 独立管理」）。
 *
 * ## 为什么需要它
 *
 * §8 明确要求 sticky-follow **独立管理**。此前它是散在视图里的三处判断：
 *   · `onVisibleRange` 用**几何比较**（可见区间末尾 vs 最后一行）直接赋 `stickToBottom`；
 *   · `onItemsChanged` 读它决定要不要跳到底；
 *   · 定时器读它决定要不要续跑。
 * 三处都合理，但**缺了两种"意图"信号**，于是有两个真实缺陷：
 *
 *   1. **切会话不重置跟随**：在会话 A 上翻过历史（跟随=false）之后切到会话 B，
 *      新会话打开时**不在底部**——用户看到的是 B 的中间某处。切换会话的意图显然是"看最新"。
 *   2. **发送消息不重新跟随**：用户上翻看历史后写一条消息发出去，跟随仍是 false ⇒
 *      回答可能在他看不到的地方出现。
 *
 * 这两个都不是几何问题，是**意图**问题。把它们显式建模成信号（而不是让几何判断顺带管意图），
 * 就是"独立管理"的实际含义。
 *
 * ## 为什么放在 appstate 且是纯函数
 *
 * 转移规则（什么信号把跟随打开、什么关掉）是**判断**，不是渲染。
 * 放这里之后 `tools/check-layout-fixtures.mjs` 能在本机直接执行它们（无需真机）。
 */

/** 影响"是否贴底跟随"的信号 */
export enum FollowSignal {
  /** 用户滚到 / 停在底部 */
  AT_BOTTOM = 'at-bottom',
  /** 用户上翻离开了底部 */
  SCROLLED_AWAY = 'scrolled-away',
  /** 切换会话：新会话应当从最新一条开始看 */
  SESSION_CHANGED = 'session-changed',
  /** 用户发了消息：他在等回答，自然要跟随 */
  USER_SENT = 'user-sent'
}

/**
 * 按信号推进跟随状态。
 *
 * 规则刻意简单到可以一眼看完——跟随状态只有"跟随/不跟随"两态，
 * 复杂化（比如"短暂暂停后恢复"）会让体感变得不可预测。
 */
export function nextFollowing(prev: boolean, signal: FollowSignal): boolean {
  if (signal === FollowSignal.SCROLLED_AWAY) {
    return false;
  }
  // 其余三种都是"想看到最新"的意图，一律打开
  return true;
}

/**
 * 贴底定时器是否该跑。
 *
 * 【为什么需要定时器】流式输出时**条目数不变而正文在长**，只靠"条目数变化"的事件会停在半截
 * （E113 的实测结论）。所以内容变化之外还需要一个周期性的贴底动作。
 * 只在"跟随中 且 会话在跑"时跑：用户上翻就立刻停，不然界面会跟他抢滚动条。
 */
export function followTimerShouldRun(following: boolean, running: boolean): boolean {
  return following && running;
}

/** 新条目到达时是否要跳到底（跟随中才跳；否则会把正在读历史的用户拽走） */
export function shouldJumpOnNewItems(following: boolean): boolean {
  return following;
}
