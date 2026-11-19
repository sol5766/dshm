/**
 * 云同步设置分区的**数据面**：状态快照的序列化 + 会话根目录的解析。
 *
 * ── 为什么在 platform 里（2026-10-30，docs/320）────────────────────────
 * `entry`（PC / 平板）与 `phone`（手机）是**两个原生壳**，而「设置 → 云同步」
 * 分区是同一份网页插件，从 `__DSHM_BRIDGES__.cloudSyncState()` 读状态、
 * 从 `cloudSyncAction(action)` 发动作。两个壳若各拼一份 JSON，字段名/口径
 * 只要有一处不同，表现就是"平板上有数、手机上一片空白"——这类漂移在
 * 编译期完全看不出来（两边都是合法的字符串）。
 *
 * ⇒ 把**快照的形状与取值口径**收到这里一处：
 *   · `SyncRoot`：两个壳共用的"注入会话根 / profile 目录"逻辑；
 *   · `encodeCloudState()`：把 `SyncEngine` 的当前状态拼成插件认的 JSON。
 *
 * ── 边界 ───────────────────────────────────────────────────────────────
 * 只读状态、只拼字符串：不发网络请求、不跑同步、不碰 UI。
 *
 * @module sync/SyncState
 */
import { buildManifest, SyncManifest } from '../system/SessionSyncScope';
import { maskUnionId } from '../system/HuaweiCloud';
import { readPluginManifest, PluginManifest, PluginSpec, specKind } from './PluginManifest';
import { KindStat } from './SyncStore';
import { SyncEngine, SyncEngineState, SyncScopeSummary } from './SyncEngine';
import { TaskProgress } from './SyncModel';

/**
 * 两个原生壳共用的根目录注入。
 *
 * 【为什么要抽出这个"壳侧的小事"】它决定分区里"会话 N 个 / 插件 M 个"读的是哪棵目录树。
 * 拼错一段（少一层 `dsh/home`、多一个 `profiles/ondevice`）不会报错，只会显示 0。
 * ⇒ 路径口径只写一次，两个壳都调它。
 */
export class SyncRoot {
  /**
   * 用应用上下文里的 filesDir 挂上同步目录树。
   *
   * @param filesDir 宿主页面拿到的 `context.filesDir`（空串表示上下文还没就绪）
   */
  static attach(filesDir: string): void {
    const base: string = String(filesDir === undefined || filesDir === null ? '' : filesDir).trim();
    if (base.length === 0) {
      /* 上下文未就绪：不猜路径，留给下一次（面板每秒读一次状态，会再来） */
      return;
    }
    SyncEngine.attachSessionsRoot(`${base}/dsh/home/sessions`);
    /* 插件清单来源：profiles/ondevice/package.json（docs/310） */
    SyncEngine.attachProfileDir(`${base}/dsh/home/profiles/ondevice`);
  }
}

/**
 * 把当前同步状态序列化成插件认的 JSON（桥 `cloudSyncState()` 的返回值）。
 *
 * 字段口径见 `docs/319` §3；**新增字段只增不改**（网页侧按"缺字段就回退缺省"解析，
 * 老插件配新壳不会崩）。
 *
 * @returns JSON 字符串；读状态时抛错则回 `{"ready":false}`（插件显示"尚未就绪"）
 */
export function encodeCloudState(): string {
  try {
    const st: SyncEngineState = SyncEngine.state();
    const scope: SyncScopeSummary | null = SyncEngine.scopeSummary();
    const sessions: number = scope === null ? 0 : scope.sessionCount;
    const bytes: number = scope === null ? 0 : scope.totalBytes;
    const prog: TaskProgress = SyncEngine.currentProgress();
    const progress: string = '{"task":' + JSON.stringify(prog.task)
      + ',"stage":' + JSON.stringify(prog.stage)
      + ',"total":' + prog.total
      + ',"succeeded":' + prog.succeeded
      + ',"failed":' + prog.failed
      + ',"skipped":' + prog.skipped
      + ',"preparedBytes":' + prog.preparedBytes
      + ',"note":' + JSON.stringify(prog.note)
      + ',"finished":' + prog.finished + '}';
    return '{'
      + `"ready":true`
      + `,"signedIn":${st.signedIn}`
      + `,"maskedUnionId":${JSON.stringify(st.maskedUnionId)}`
      /* docs/378：UI 改读 accountLabel（昵称 / 匿名手机号 / 匿名邮箱），不再用 ****abcd */
      + `,"accountLabel":${JSON.stringify(st.accountLabel)}`
      + `,"displayName":${JSON.stringify(st.displayName)}`
      + `,"cloudText":${JSON.stringify(st.cloudServiceText)}`
      + `,"cloudOk":${st.cloudServiceOk}`
      + `,"cloudBadge":${JSON.stringify(st.cloudServiceBadge)}`
      + `,"enabled":${st.enabled}`
      + `,"lastSyncText":${JSON.stringify(st.lastSyncText)}`
      + `,"pendingSessions":${sessions}`
      + `,"pendingBytes":${bytes}`
      + `,"pluginCount":${st.pluginCount}`
      + `,"plugins":${encodePlugins()}`
      + `,"units":${encodeUnits()}`
      + `,"busy":${SyncEngine.isRunning()}`
      + `,"progress":${progress}`
      + '}';
  } catch (e) {
    return '{"ready":false}';
  }
}

/**
 * 本机用户插件清单（分区里显示"同步哪些插件"）。
 *
 * 只给 `name` / `spec` / `kind`：`node_modules` 与版本树不上网页、也不进云端（docs/313 §7）。
 * 超过 8 个只列前 8 个 —— 分区是概览，完整列表在原生面板里。
 */
export function encodePlugins(): string {
  try {
    const list: PluginSpec[] = SyncEngine.plugins();
    const out: string[] = [];
    const n: number = Math.min(list.length, 8);
    for (let i: number = 0; i < n; i++) {
      out.push('{"name":' + JSON.stringify(list[i].name)
        + ',"spec":' + JSON.stringify(list[i].spec)
        /* spec 形态（npm / git / local / alias）来自上游同一个分类函数，界面据此给文案 */
        + ',"kind":' + JSON.stringify(specKind(list[i].spec)) + '}');
    }
    return '[' + out.join(',') + ']';
  } catch (e) {
    return '[]';
  }
}

/** 同步表里各类型内容的记录数（会话/附件/技能/插件清单）。 */
export function encodeUnits(): string {
  const parts: string[] = [];
  const stats: KindStat[] = SyncEngine.stats();
  for (let i: number = 0; i < stats.length; i++) {
    parts.push('"' + stats[i].kind + '":{"count":' + stats[i].count + ',"bytes":' + stats[i].bytes + '}');
  }
  return '{' + parts.join(',') + '}';
}

/** 会话根目录是否已就绪（壳分派动作前用它给"同步目录未就绪"这种早退留余地）。 */
export function cloudScopeReady(): boolean {
  return SyncEngine.scopeSummary() !== null;
}

/** 重新导出的两个上游读取器（壳里要用它们做清单比对，避免各处再拼路径）。 */
export { buildManifest, maskUnionId, readPluginManifest };
export type { SyncManifest, PluginManifest };
