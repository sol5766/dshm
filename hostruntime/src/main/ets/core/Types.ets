/**
 * 端侧核心版本管理的**纯逻辑**（无 IO、无 UI）。
 *
 * 为什么把纯逻辑单独放：激活事务里最容易出错的是**状态迁移与回滚判据**，
 * 而不是文件操作。把它们做成纯函数后，可以在没有设备、没有文件系统的前提下
 * 用单测把"坏版本必须回滚""current 不许被清空""previous 永远保留"这些不变式钉死。
 *
 * 设计依据见 docs/50-端侧核心运行架构.md §6.1（stage → verify → health → activate → rollback）。
 */

/** 候选版本的健康检查结果。 */
import { newestVersion } from './Naming';

export enum CoreHealth {
  UNKNOWN = 'unknown',
  PASS = 'pass',
  FAIL = 'fail',
}

/** 一个已安装的核心版本。 */
export interface CoreVersionRecord {
  version: string;
  installedAt: string;
  health: string;
  healthNote: string;
  /** 分发容器的 sha256（清单里带出来；空串表示未记录） */
  sha256: string;
}

/**
 * 核心仓库的状态（落在 <files>/dsh/state.json）。
 *
 * 不变式：
 *  1. `current` 要么是空串（从未激活过），要么必须是 `installed` 里的一个版本；
 *  2. `previous` 只有在成功激活过至少两次之后才非空，且**永远保留**（回滚目标）；
 *  3. `history` 是最新在前的版本列表，只做展示与清理决策，不参与正确性。
 */
export interface CoreState {
  current: string;
  previous: string;
  history: string[];
}

export function emptyState(): CoreState {
  return { current: '', previous: '', history: [] };
}

/** 宽容解析 state.json：坏文件不应让应用起不来，只当作"从未激活过"。 */
export function parseState(text: string): CoreState {
  if (text.length === 0) {
    return emptyState();
  }
  try {
    const raw: CoreState = JSON.parse(text) as CoreState;
    const current: string = typeof raw.current === 'string' ? raw.current : '';
    const previous: string = typeof raw.previous === 'string' ? raw.previous : '';
    const history: string[] = Array.isArray(raw.history) ? raw.history : [];
    return { current: current, previous: previous, history: history };
  } catch (e) {
    return emptyState();
  }
}

export function serializeState(s: CoreState): string {
  return JSON.stringify(s, null, 2);
}

/** 激活事务的决策结果。 */
export enum ActivationAction {
  /** 写到 current 并重启核心 */
  ACTIVATE = 'activate',
  /** 候选不健康：保持 current 不变，记录失败 */
  REFUSE = 'refuse',
  /** 重启失败：回滚到 previous */
  ROLLBACK = 'rollback',
}

export interface ActivationDecision {
  action: ActivationAction;
  reason: string;
  next: CoreState;
}

/**
 * 决定"能不能把候选版本设为 current"。
 *
 * 判据（顺序即优先级）：
 *  1. 候选版本号为空 → 拒绝（避免 current 被清空）；
 *  2. 健康检查不是 PASS → 拒绝。**注意：这条不接受"未知"**——
 *     端侧宁可停在旧版本，也不要把一个没验证过的核心设为当前；
 *  3. 候选已经就是 current → 视为激活（幂等，不产生新的 previous）；
 *  4. 否则激活：previous = 旧 current，history 去重后置顶。
 */
export function decideActivation(state: CoreState, candidate: string, health: string, note: string): ActivationDecision {
  if (candidate.length === 0) {
    return { action: ActivationAction.REFUSE, reason: '候选版本号为空', next: state };
  }
  if (health !== CoreHealth.PASS) {
    return { action: ActivationAction.REFUSE, reason: `健康检查未通过（${health}）：${note}`, next: state };
  }
  if (state.current === candidate) {
    return { action: ActivationAction.ACTIVATE, reason: '候选已是当前版本（幂等）', next: state };
  }
  const history: string[] = [candidate];
  for (const v of state.history) {
    if (v !== candidate) {
      history.push(v);
    }
  }
  const next: CoreState = {
    current: candidate,
    previous: state.current.length > 0 ? state.current : state.previous,
    history: history,
  };
  return { action: ActivationAction.ACTIVATE, reason: '健康检查通过，切为当前版本', next: next };
}

/**
 * 回滚决策（重启当前版本失败时调用）。
 *
 * 判据：只有当 previous 非空且与 current 不同、且 previous 仍是已安装目录时才允许回滚；
 * 否则**不做任何写入**（宁可保持原状并如实报错，也不要写一个指向不存在版本的状态）。
 */
export function decideRollback(state: CoreState, installed: string[]): ActivationDecision {
  const prev: string = state.previous;
  if (prev.length === 0) {
    return { action: ActivationAction.REFUSE, reason: '没有可回滚的上一版本', next: state };
  }
  if (prev === state.current) {
    return { action: ActivationAction.REFUSE, reason: '上一版本与当前版本相同', next: state };
  }
  if (!installed.includes(prev)) {
    return { action: ActivationAction.REFUSE, reason: `上一版本目录已不存在：${prev}`, next: state };
  }
  const next: CoreState = {
    current: prev,
    previous: state.current,
    history: state.history,
  };
  return { action: ActivationAction.ROLLBACK, reason: `当前版本启动失败，回滚到 ${prev}`, next: next };
}

/**
 * 清理决策：该删哪些旧版本。
 *
 * 规则（安全优先，宁可少删）：
 *  - 永不删 current、永不删 previous；
 *  - 永不删 **会真正被启动的那棵树**（current 缺失/已不在时 = `newestVersion(installed)`，见下）；
 *  - `keepExtra` 里点名保护的（调用方"刚装进来的那一版"，见 BundledCore）同样不删；
 *  - 其余按 history 顺序（最新在前）保留 `keep` 个。
 * 返回的是**可以删**的版本号列表。
 *
 * 【2026-10-08 真机补上的第二、三条 —— 原判据里有个致命假设】
 * 原判据只保护 current/previous，隐含假设"一定激活过"。而真机上 `state.json`
 * **可以不存在**（首启只解包、从未激活：实测设备上 **15 棵树并存**、`state.current` 为空），
 * 那种状态下 `DshHost.start()` 取的是 `newestVersion(installed)`
 * （见 start() 注释："有 current 且它还在 ⇒ 用它；否则用**最新**的那棵"）。
 * ⇒ 按原判据算，**正在跑的那棵树**也在"可删"名单里；真删下去就是把自己脚下的地板拆掉
 * （下一次启动会落到"还没有安装任何核心版本、无法启动"）。
 * 所以"清理"与"谁在跑"必须用**同一个**答案 —— 这条不变量就写在这里。
 */
export function evictionCandidates(state: CoreState, installed: string[], keep: number,
  keepExtra: string[] = []): string[] {
  const protectedVersions: string[] = [state.current, state.previous];
  for (const extra of keepExtra) {
    if (!protectedVersions.includes(extra)) {
      protectedVersions.push(extra);
    }
  }
  if (!installed.includes(state.current)) {
    const live: string = newestVersion(installed);
    if (live.length > 0 && !protectedVersions.includes(live)) {
      protectedVersions.push(live);
    }
  }
  const keepSet: string[] = [];
  for (const v of state.history) {
    if (keepSet.length >= keep) {
      break;
    }
    if (!keepSet.includes(v)) {
      keepSet.push(v);
    }
  }
  const out: string[] = [];
  for (const v of installed) {
    if (protectedVersions.includes(v)) {
      continue;
    }
    if (keepSet.includes(v)) {
      continue;
    }
    out.push(v);
  }
  return out;
}
