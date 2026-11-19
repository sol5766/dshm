/**
 * 上传执行器：把计划真正送上去（docs/313 §5.1、批次 B）。
 *
 * ── 五个阶段（**每一段都上报真实进度**）────────────────────────────────
 * ```text
 * SCAN       扫描本机，产出计划（单元数 + 本地字节）
 * STAGE_FILE 逐个把源文件搬进 distributedFilesDir，构造 Asset
 * WRITE_DB   逐个写 sync_units（先删后插 = 以本次为准）
 * CLOUD_SYNC 声明分布式表 + 触发同步，等进度码
 * VERIFY     读回统计，确认落库数量对得上
 * ```
 *
 * ── 三条纪律 ───────────────────────────────────────────────────────────
 * 1. **进度以单元数计**：SDK 的 `ProgressDetails` 只给
 *    `total/successful/failed/remained`，没有字节级接口。
 *    `preparedBytes` 只表示"本地已准备"，**不得**被 UI 当成"已上云百分比"。
 * 2. **失败不伪装成功**：任一单元失败都计入 `failed` 并保留原因；
 *    整批只有在 `failed === 0` 且云端同步 code=SUCCESS 时才报成功。
 * 3. **可中断**：每个单元独立 try/catch，一项失败不中断整批（否则用户永远传不完）。
 *
 * ── 与端云同步的关系 ───────────────────────────────────────────────────
 * 我们**不自己传文件**：只把 Asset 记录写进 `sync_units`，
 * 由系统的端云同步把资产上传。这也是 docs/307 确定的架构。
 *
 * @module sync/UploadRunner
 */
import { common } from '@kit.AbilityKit';
import { SyncTask } from './SyncTask';
import { relationalStore } from '@kit.ArkData';
import { BusinessError } from '@kit.BasicServicesKit';
import { sha256OfFile } from '../system/FileDigest';
import { TaskProgress, UnitMetadata, UNIT_METADATA_SCHEMA } from './SyncModel';
import { UploadStage, UnitOutcome, initialProgress, SyncUnit } from './SyncModel';
import { discardUnregisteredAsset, enableCloudSync, openStore, reusableAsset, runCloudSync, stageAsset, statByKind, StoreResult, upsertUnit } from './SyncStore';
import { PlanResult, UnitPlan } from './SyncPlanner';
import { encodeMetadata, UnitKind, deviceIdNow } from './SyncModel';

export { sha256OfFile } from '../system/FileDigest';

/** 进度回调（UI 订阅它刷新页面）。 */
export type ProgressSink = (p: TaskProgress) => void;

/** 单个单元的处理结果（用于清单页展示"哪一项失败了、为什么"）。 */
export interface UnitResult {
  unitId: string;
  displayName: string;
  outcome: UnitOutcome;
  reason: string;
  bytes: number;
}

/** 上传任务的最终报告。 */
export interface UploadReport {
  ok: boolean;
  /** 一句话结论（成功/部分失败/整体失败） */
  summary: string;
  progress: TaskProgress;
  results: UnitResult[];
  /** 云端同步阶段的错误（若有） */
  cloudError: string;
}

/**
 * 计算文件 sha256（小写十六进制）。
 *
 * 【为什么必须算】它是导入前的**完整性判据**，也是"两端是否一致"的唯一凭据。
 * 没有它，冲突判定与导入校验都失效。
 *
 * 【为什么用流式】会话代际可能到 7 MB 甚至更大；一次性读进内存既慢又占峰值。
 */

/**
 * 执行一次上传。
 *
 * @param ctx 应用上下文
 * @param plan 规划器产出的计划
 * @param sink 进度回调
 */
export async function runUpload(ctx: common.Context, plan: PlanResult,
  sink: ProgressSink, task: SyncTask = new SyncTask()): Promise<UploadReport> {
  task.check();
  const progress: TaskProgress = initialProgress('upload');
  progress.stage = UploadStage.SCAN;
  progress.total = plan.plans.length;
  progress.note = `共 ${plan.plans.length} 项待同步`;
  for (let i: number = 0; i < plan.plans.length; i++) {
    progress.preparedBytes += plan.plans[i].bytes;
  }
  sink(copyOf(progress));

  const results: UnitResult[] = [];
  const storeRes = await openStore(ctx);
  task.check();
  if (!storeRes.ok || storeRes.value === null) {
    progress.stage = UploadStage.DONE;
    progress.finished = true;
    progress.note = storeRes.error;
    sink(copyOf(progress));
    return { ok: false, summary: `打开同步库失败：${storeRes.error}`, progress: progress, results: [], cloudError: '' };
  }
  const store: relationalStore.RdbStore = storeRes.value;

  /* ── STAGE_FILE + WRITE_DB：逐单元搬运与落库 ───────────────────── */
  progress.stage = UploadStage.STAGE_FILE;
  for (let i: number = 0; i < plan.plans.length; i++) {
    const p: UnitPlan = plan.plans[i];
    task.check();
    progress.currentUnitId = p.unitId;
    progress.note = `准备 ${i + 1}/${plan.plans.length}：${p.displayName}`;
    sink(copyOf(progress));

    let sha: string = '';
    // Repeated unchanged units reuse a byte-verified immutable registered path.
    try {
      const sourceSha: string = await sha256OfFile(p.sourcePath);
      task.check();
      const reused: relationalStore.Asset | undefined = await reusableAsset(store, p.unitId, sourceSha, task);
      task.check();
      if (reused !== undefined) {
        results.push({ unitId: p.unitId, displayName: p.displayName,
          outcome: UnitOutcome.SKIPPED, reason: '内容未变，复用已登记不可变资产', bytes: Number(reused.size) });
        progress.skipped += 1;
        sink(copyOf(progress));
        continue;
      }
    } catch (e) {
      task.check();
      // Unknown previous asset is not reused; stage and verify a new owned snapshot.
    }
    const assetRes = stageAsset(ctx, p.sourcePath, p.unitId);
    if (!assetRes.ok || assetRes.value === null) {
      results.push({ unitId: p.unitId, displayName: p.displayName,
        outcome: UnitOutcome.FAILED, reason: assetRes.error, bytes: p.bytes });
      progress.failed += 1;
      sink(copyOf(progress));
      continue;
    }
    try {
      sha = await sha256OfFile(assetRes.value.path);
      task.check();
    } catch (e) {
      discardUnregisteredAsset(assetRes.value);
      task.check();
      results.push({ unitId: p.unitId, displayName: p.displayName,
        outcome: UnitOutcome.FAILED, reason: `计算校验值失败：${errText(e as Object)}`, bytes: p.bytes });
      progress.failed += 1;
      sink(copyOf(progress));
      continue;
    }


    progress.stage = UploadStage.WRITE_DB;
    const meta: UnitMetadata = {
      schema: UNIT_METADATA_SCHEMA,
      displayName: p.displayName,
      fileName: p.assetName,
      formatVersion: p.kind === UnitKind.SESSION ? p.version : -1
    };
    const unit: SyncUnit = {
      unitId: p.unitId,
      kind: p.kind,
      workspaceId: p.workspaceId,
      sessionId: p.sessionId,
      version: p.version,
      sha256: sha,
      bytes: Number(assetRes.value.size),
      updatedAt: Date.now(),
      metadata: encodeMetadata(meta),
      /* 设备 + 上传时间：云端按这两列做「设备 ▸ 日期」列表（docs/374 §3） */
      deviceId: deviceIdNow(),
      uploadedAt: Date.now()
    };
    let up: StoreResult<boolean>;
    try {
      up = await upsertUnit(store, unit, assetRes.value, task);
      task.check();
    } finally {
      discardUnregisteredAsset(assetRes.value);
    }
    if (!up.ok) {
      results.push({ unitId: p.unitId, displayName: p.displayName,
        outcome: UnitOutcome.FAILED, reason: up.error, bytes: p.bytes });
      progress.failed += 1;
      sink(copyOf(progress));
      continue;
    }
    results.push({ unitId: p.unitId, displayName: p.displayName,
      outcome: UnitOutcome.OK, reason: '', bytes: p.bytes });
    progress.succeeded += 1;
    sink(copyOf(progress));
  }

  /* ── CLOUD_SYNC：声明 + 触发，等云端给结论 ─────────────────────── */
  task.check();
  let cloudError: string = '';
  if (progress.succeeded > 0 || progress.skipped > 0) {
    progress.stage = UploadStage.CLOUD_SYNC;
    progress.note = '正在同步到云端…';
    progress.currentUnitId = '';
    sink(copyOf(progress));

    const enable = await enableCloudSync(store);
    task.check();
    if (!enable.ok) {
      cloudError = enable.error;
    } else {
      const syncRes = await runCloudSync(store, relationalStore.SyncMode.SYNC_MODE_NATIVE_FIRST,
        (schedule: number, code: number) => {
          if (!task.isCurrent()) { return; }
          progress.note = `云端同步中（schedule=${schedule} code=${code}）`;
          sink(copyOf(progress));
        }, 1500);
      task.check();
      if (!syncRes.ok) {
        cloudError = syncRes.error;
      }
    }
  }

  /* ── VERIFY：读回落库统计，确认数量一致 ─────────────────────────── */
  task.check();
  progress.stage = UploadStage.VERIFY;
  progress.note = '正在核对落库结果…';
  sink(copyOf(progress));
  let verified: string = '';
  const stat = await statByKind(store);
  task.check();
  if (stat.ok && stat.value !== null) {
    let total: number = 0;
    for (let i: number = 0; i < stat.value.length; i++) {
      total += stat.value[i].count;
    }
    verified = `同步表共 ${total} 项`;
  } else {
    verified = '统计失败';
  }

  progress.stage = UploadStage.DONE;
  progress.finished = true;
  const failedCount: number = progress.failed;
  const okAll: boolean = failedCount === 0 && cloudError.length === 0;
  progress.note = okAll
    ? `完成：${progress.succeeded} 项，${verified}`
    : `完成：成功 ${progress.succeeded}、失败 ${failedCount}${cloudError.length > 0 ? '、云端：' + cloudError : ''}`;
  sink(copyOf(progress));

  const summary: string = okAll
    ? `已同步 ${progress.succeeded} 项（${verified}）`
    : (failedCount > 0
      ? `${progress.succeeded} 项成功、${failedCount} 项失败`
      : `本地已写入 ${progress.succeeded} 项，但云端同步未成功：${cloudError}`);

  return {
    ok: okAll,
    summary: summary,
    progress: progress,
    results: results,
    cloudError: cloudError
  };
}

/** 拷贝一份进度（避免 UI 持有同一个可变对象）。 */
function copyOf(p: TaskProgress): TaskProgress {
  return {
    task: p.task,
    stage: p.stage,
    total: p.total,
    succeeded: p.succeeded,
    failed: p.failed,
    skipped: p.skipped,
    currentUnitId: p.currentUnitId,
    note: p.note,
    preparedBytes: p.preparedBytes,
    finished: p.finished
  };
}

function errText(e: Object): string {
  const be: BusinessError = e as BusinessError;
  if (be !== undefined && be.message !== undefined) {
    return `[${be.code}] ${be.message}`;
  }
  return String(e);
}
