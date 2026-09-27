/**
 * 诊断报告的**空态**（不是「演示数据」）。
 *
 * 【为什么必须有这个函数而不是让调用方写 `{}`】
 * ArkTS 禁止无法对应到已声明类型的对象字面量（`arkts-no-obj-literals`），
 * 所以空值必须由**显式标注返回类型**的工厂产出。集中于一处也让
 * 「什么算空报告」只有一种定义。
 *
 * 【为什么空报告的每一项都要说实话】
 *   旧实现这里是 `stubDiagnostics()`：五项全绿、`home=D:/work`、
 *   「Host 版本 0.1.2-rc.1 在受支持矩阵内」——**全部编造**。
 *   诊断页的唯一用途就是「出问题时告诉我哪里不对」，
 *   一份编造的全绿报告会把用户引向完全错误的方向。
 *   因此空报告必须是：未运行、无条目、不健康、版本未知。
 */

import { DiagReport } from './Settings';
import type { DiagEntry } from './Settings';
import { SURFACE, tableStats } from 'dshcompat';
import type { TableStats } from 'dshcompat';

/**
 * 诊断的**模式**（D7 §3 第 4 项）。
 *
 * 【为什么要有模式，而不是把所有判定项一律显示】
 * 原实现把「端点 / TLS / 认证 / 协议 / Host」五项无差别列出来。端侧自足之后，
 * 其中两项（TLS、认证）**只对远程 Host 有意义**：本机核心走 `127.0.0.1` + `--skip-auth`，
 * 既没有 TLS 也没有 cookie 交换。把它们显示出来并标成"不适用"，等于在诊断页里
 * 制造噪音——而诊断页的用途恰恰是"出问题时告诉我哪里不对"，噪音会直接降低它的信噪比。
 */
export enum DiagMode {
  /** 本机核心在跑：只显示对回环有价值的判定项 */
  LOCAL_CORE = 'local-core',
  /** 连的是远程 Host：五项全显示 */
  REMOTE_HOST = 'remote-host',
  /** 运行时还没接线：没有可诊断的对象 */
  UNWIRED = 'unwired',
}

/** 只对远程 Host 有意义的判定项名（本地核心模式下必须隐藏） */
const REMOTE_ONLY: string[] = ['TLS', '认证'];

export function diagModeOf(localCoreReady: boolean, remoteHostConfigured: boolean): DiagMode {
  if (localCoreReady) {
    return DiagMode.LOCAL_CORE;
  }
  if (remoteHostConfigured) {
    return DiagMode.REMOTE_HOST;
  }
  return DiagMode.UNWIRED;
}

export function diagTitleOf(mode: DiagMode): string {
  if (mode === DiagMode.LOCAL_CORE) {
    return '本机核心诊断';
  }
  if (mode === DiagMode.REMOTE_HOST) {
    return '远程 Host 诊断';
  }
  return '连接诊断';
}

export function diagHintOf(mode: DiagMode): string {
  if (mode === DiagMode.LOCAL_CORE) {
    return '本机核心走回环地址、不启用 TLS 与 cookie 认证，因此这两项不在此列出。';
  }
  if (mode === DiagMode.REMOTE_HOST) {
    return '远程 Host 需要 TLS 与认证判定，五项全部列出。';
  }
  return '运行时尚未接线，暂时没有可诊断的对象；到「核心」页可以看到运行时与版本的真实状态。';
}

/**
 * 按模式裁剪判定项。
 * 纯函数：不依赖设备与网络，可单测——"哪种模式下该显示哪几项"是要被审视的判据，
 * 不该散在视图里。
 */
export function filterDiagEntries(mode: DiagMode, entries: DiagEntry[]): DiagEntry[] {
  if (mode === DiagMode.REMOTE_HOST) {
    return entries;
  }
  if (mode === DiagMode.UNWIRED) {
    return [];
  }
  const out: DiagEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (!REMOTE_ONLY.includes(entries[i].name)) {
      out.push(entries[i]);
    }
  }
  return out;
}

/** 尚未运行诊断时的报告（`generatedAt = 0` 表示「从未生成」） */
export function emptyDiagReport(): DiagReport {
  const stats: TableStats = tableStats();
  return {
    entries: [],
    healthy: false,
    generatedAt: 0,
    versionVerdict: 'unverified',
    versionMessage: '尚未运行诊断',
    versionAdvice: '点击「运行诊断」后会实际探测端点、认证、协议与 Host 信息。',
    tableStats: `${stats.endpoints} 个端点 / ${stats.streamEndpoints} 个流式 / ${stats.capabilities} 个能力`,
    // 接口面从载体常量派生：写死字符串会在上游改路径后继续展示旧路径，
    // 而「接口面」这一行正是用来判断「是不是漏注入/走错路由」的。
    surface: `${SURFACE.apiChannel} · ${SURFACE.muxPath} · ${SURFACE.eventsEndpoint}`
  };
}
