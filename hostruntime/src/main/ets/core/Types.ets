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
 *  - 其余按 history 顺序（最新在前）保留 `keep` 个。
 * 返回的是**可以删**的版本号列表。
 */
export function evictionCandidates(state: CoreState, installed: string[], keep: number): string[] {
  const protectedVersions: string[] = [state.current, state.previous];
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
