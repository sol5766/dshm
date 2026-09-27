/**
 * 会话内搜索（D3 §5.1 的 `Ctrl/Cmd + F` 一行）。
 *
 * ───────────────────────── 为什么把匹配做成纯函数 ─────────────────────────
 *   搜索的"哪一条算命中"必须可单测：它决定了用户在一条长会话里能不能找到那句话，
 *   而**匹配规则写窄了（漏命中）与写宽了（噪声）在界面上都只是"好像没搜到"**，
 *   没有任何报错能提示规则有问题。把规则收成一个纯函数，就能用断言钉住它。
 *
 * ───────────────────────── 搜索哪些字段 ─────────────────────────
 *   只搜**用户能看到或与用户输入相关**的文本：正文（消息/思考）、工具名与参数、
 *   工具输出、交付物文件名、目标/任务标题与进度。刻意**不搜** id 之类的内部字段——
 *   它们搜出来用户也看不懂，只会让"结果数"这个读数变得不可信。
 *
 * 大小写：统一按不敏感比较（`toLowerCase`）。记忆点：**不要**用 `localeCompare`
 *   之类的区域相关比较——同一份数据在不同设备上给出不同命中集，是排查噩梦。
 */

import { TrajectoryItem } from './Trajectory';
import { ConversationAudience, conversationAudienceOf, Turn } from './Turns';

/** 命中的条目下标（升序） */
export function matchTrajectoryIndices(items: TrajectoryItem[], query: string): number[] {
  const out: number[] = [];
  const needle: string = query.trim().toLowerCase();
  if (needle.length === 0) {
    return out;
  }
  for (let i = 0; i < items.length; i++) {
    if (haystackOf(items[i]).indexOf(needle) >= 0) {
      out.push(i);
    }
  }
  return out;
}

/**
 * **对话视图**里的命中下标：只搜用户可见的那几类（P0-1 的绕过路径）。
 *
 * 【为什么必须单独一个入口】`matchTrajectoryIndices()` 搜的是**全部条目**，
 * 而其中包含内部事件——最要紧的是 `system/message`，它的 `body` 就是**完整的 agent 提示词**。
 * 于是"搜一个常见词"会在对话视图里给出命中数，却指着一条**根本不在对话里显示**的行；
 * 点"下一个"跳到那行的下标，在回合制列表里指向另一个回合（两套下标根本不是一回事）。
 * 提示词泄漏不只是"显示出来"这一种形态，**"能被搜到、能被计数"同样算泄漏**。
 *
 * 轨迹视图仍用 `matchTrajectoryIndices()`（那里内部事件本来就该可查——排查需要）。
 */
export function matchConversationIndices(items: TrajectoryItem[], query: string): number[] {
  const visible: TrajectoryItem[] = [];
  const origin: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (conversationAudienceOf(items[i]) !== ConversationAudience.HIDDEN) {
      visible.push(items[i]);
      origin.push(i);
    }
  }
  const local: number[] = matchTrajectoryIndices(visible, query);
  const out: number[] = [];
  for (let i = 0; i < local.length; i++) {
    out.push(origin[local[i]]);
  }
  return out;
}

/**
 * 条目下标 → **对话视图的行号**（回合序号）。
 *
 * 【为什么需要映射】对话视图的列表行是**回合**（`chatTurns()`），而命中集合是**条目**下标。
 * 直接把条目下标喂给 `scrollToIndex` 会滚到错误的行——"搜到了却跳错地方"，
 * 而且不会报错（只表现为"跳到别处了"）。找不到该条目所属回合时返回 -1（调用方不滚）。
 */
export function chatRowOfItemIndex(items: TrajectoryItem[], turns: Turn[], itemIndex: number): number {
  if (itemIndex < 0 || itemIndex >= items.length) {
    return -1;
  }
  const id: string = items[itemIndex].id;
  for (let i = 0; i < turns.length; i++) {
    const t: Turn = turns[i];
    if (t.user !== undefined && t.user.id === id) {
      return i;
    }
    for (let j = 0; j < t.answers.length; j++) {
      if (t.answers[j].id === id) {
        return i;
      }
    }
    for (let j = 0; j < t.notices.length; j++) {
      if (t.notices[j].id === id) {
        return i;
      }
    }
    for (let j = 0; j < t.process.length; j++) {
      if (t.process[j].id === id) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * 把一条轨迹拼成可搜索文本。
 *
 * 拼成一个字符串而不是逐字段比较：字段一多，逐字段的 `indexOf` 组合极易漏掉一个分支，
 * 而"某类内容永远搜不到"这种缺陷在界面上看不出来（只是"搜不到"）。
 * 用换行连接，避免两个字段首尾相接产生假命中（`...foo` + `bar...` → `foobar`）。
 */
function haystackOf(item: TrajectoryItem): string {
  return [
    item.body,
    item.toolName,
    item.toolArgs,
    item.toolOutput,
    item.fileName,
    item.title,
    item.progress,
    item.subagentName,
    item.model
  ].join('\n').toLowerCase();
}

/**
 * 在命中集合里前后移动，返回新的命中下标在**命中数组**里的位置。
 *
 * @param currentPos 当前位于命中数组的位置（-1 = 还没有选中任何命中）
 * @param total      命中总数
 * @param delta      -1 上一个 / +1 下一个
 *
 * 语义（三条都要对，否则用户会觉得"跳转坏了"）：
 *   - 没有命中 → 返回 -1；
 *   - 还没选中（-1）时向前**从末尾绕回**、向后**从开头开始**（连续按同一个方向一直是新命中）；
 *   - 到达两端时**环绕**而不是卡住（搜索框里连按"下一个"应该一直有效）。
 */
export function stepMatch(currentPos: number, total: number, delta: number): number {
  if (total <= 0 || delta === 0) {
    return -1;
  }
  if (currentPos < 0) {
    return delta > 0 ? 0 : total - 1;
  }
  const next: number = currentPos + (delta > 0 ? 1 : -1);
  if (next < 0) {
    return total - 1;
  }
  if (next >= total) {
    return 0;
  }
  return next;
}

/** 命中计数文案（`3/12`；无命中且有关键词时给 `0/0`）。 */
export function matchCounterText(currentPos: number, total: number): string {
  if (total <= 0) {
    return '0/0';
  }
  return `${currentPos < 0 ? 0 : currentPos + 1}/${total}`;
}
