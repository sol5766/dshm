/**
 * 导入执行器：把云端拉回来的单元**安全地放回本机会话树**（docs/313 §6、批次 C）。
 *
 * ── 六道闸（缺一道都可能毁掉用户的会话）────────────────────────────────
 * ```text
 * ① 路径安全   目标路径必须在 sessionsRoot 之内，拒绝 `..` / 绝对路径注入
 * ② 完整性     字节数 + sha256 必须与记录一致；不一致直接拒绝
 * ③ 格式可读   会话代际文件名与 header 的 version/id 对得上
 * ④ 映射确认   工作区必须有用户确认过的映射（未确认 → 不进正式目录）
 * ⑤ 原子落位   先写 staging 临时文件，校验通过后 rename
 * ⑥ 可用性验收 落位后重新读一遍（大小 + 内容可读），失败则回滚
 * ```
 *
 * ── 为什么必须这么保守 ─────────────────────────────────────────────────
 * 会话是**用户不可再生**的资产。导入写错一次，可能把一个正在用的会话覆盖成
 * 云端旧版本 —— 这类事故在本工程里已经发生过（卸载丢数据，docs/AGENTS）。
 * 所以这里的默认动作是**拒绝**而不是"尽力而为"。
 *
 * ── 活跃会话保护 ───────────────────────────────────────────────────────
 * 目标文件已存在且内容不同时，**绝不覆盖**：标记为冲突交用户裁决。
 * 同内容（sha 一致）则幂等跳过。
 *
 * @module sync/ImportRunner
 */
import { common } from '@kit.AbilityKit';
import { SyncTask } from './SyncTask';
import { sha256OfFile } from '../system/FileDigest';
import { relationalStore } from '@kit.ArkData';
import { fileIo as fs } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { ImportStage, TaskProgress, UnitOutcome, initialProgress, isValidSha256, SyncUnit } from './SyncModel';
import { SYNC_TABLE, sleep } from './SyncStore';

/** 一条待导入记录（来自云端同步表）。 */
export interface ImportCandidate {
  unitId: string;
  kind: string;
  workspaceId: string;
  sessionId: string;
  version: number;
  sha256: string;
  bytes: number;
  /** 资产在本机的绝对路径（由 Asset.path 给出；Asset 未就绪则为空） */
  assetPath: string;
  /** 资产声明的字节数（Asset.size 字符串） */
  assetSize: string;
}

/**
 * 由基准条目派生一条结果。
 *
 * 【为什么写个函数】ArkTS 禁止对象展开（`arkts-no-spread`），
 * 而这里要派生十几次结果 —— 逐个手写字段既啰嗦又容易漏字段。
 */
function derive(base: ImportOutcome, outcome: UnitOutcome, reason: string,
  targetPath: string): ImportOutcome {
  return {
    unitId: base.unitId,
    sessionId: base.sessionId,
    version: base.version,
    outcome: outcome,
    reason: reason,
    targetPath: targetPath
  };
}

/** 单个候选的导入结果。 */
export interface ImportOutcome {
  unitId: string;
  sessionId: string;
  version: number;
  outcome: UnitOutcome;
  reason: string;
  /** 落位后的绝对路径（成功时） */
  targetPath: string;
}

/** 导入任务报告。 */
export interface ImportReport {
  ok: boolean;
  summary: string;
  outcomes: ImportOutcome[];
  progress: TaskProgress;
}

/** 工作区映射：workspaceId → 本机 projectKey（sessions 下的目录名）。 */
export interface WorkspaceMapping {
  workspaceId: string;
  projectKey: string;
}

/**
 * 计算会话代际的规范文件名（与上游 `sessionFormatLogFilename` 逐字一致）。
 *
 * ```text
 * v0      → session.jsonl.zstd
 * vN(N≥1) → session.vN.jsonl.zstd
 * ```
 *
 * 【为什么不能自己拍文件名】上游按文件名解析代际（`CANONICAL_LOG_FILENAME`）；
 * 名字不规范的文件会被当成"不是已提交代际"而**完全忽略** ——
 * 导入看似成功，实际会话根本不存在。
 */
export function canonicalSessionFileName(version: number): string {
  const v: number = Number.isFinite(version) ? Math.trunc(version) : 0;
  if (v <= 0) {
    return 'session.jsonl.zstd';
  }
  return `session.v${v}.jsonl.zstd`;
}

/**
 * 判断相对路径是否安全（防目录穿越）。
 *
 * 规则：不允许绝对路径、不允许任何 `..` 段、不允许空段。
 */
export function isSafeRelativePath(rel: string): boolean {
  const r: string = String(rel === undefined || rel === null ? '' : rel);
  if (r.length === 0) {
    return false;
  }
  if (r.startsWith('/')) {
    return false;
  }
  const parts: string[] = r.split('/');
  for (let i: number = 0; i < parts.length; i++) {
    const p: string = parts[i];
    if (p.length === 0 || p === '.' || p === '..') {
      return false;
    }
    /* 反斜杠在部分文件系统上是分隔符，单独一段里出现也拒绝 */
    if (p.indexOf('\\') >= 0) {
      return false;
    }
  }
  return true;
}

/**
 * 从同步表读出**云端有、本机待导入**的候选（批次 C 的"发现"阶段）。
 *
 * 【为什么只取 kind=session】附件/技能是内容寻址的，落位规则更简单；
 * 首版先把会话导入做对（它是用户最不可再生的资产），其余随批次 E 扩展。
 */
export async function discoverImportCandidates(store: relationalStore.RdbStore,
  knownWorkspaces: WorkspaceMapping[]): Promise<ImportCandidate[]> {
  const out: ImportCandidate[] = [];
  const rs = await store.querySql(
    `SELECT unit_id, kind, workspace_id, session_id, version, sha256, bytes, payload `
    + `FROM ${SYNC_TABLE} WHERE kind = 'session'`);
  try {
    while (await rs.goToNextRow()) {
      const ws: string = rs.getString(rs.getColumnIndex('workspace_id'));
      /* 未映射也进入结果统计；runImport映射闸拒绝写入未知目录。 */
      let assetPath: string = '';
      let assetSize: string = '';
      try {
        const asset: relationalStore.Asset = rs.getAsset(rs.getColumnIndex('payload'));
        assetPath = asset.path === undefined ? '' : String(asset.path);
        assetSize = asset.size === undefined ? '' : String(asset.size);
      } catch (e) {
        /* Asset 读不到时保留空值，由导入闸②判失败并给出原因 */
        assetPath = '';
      }
      out.push({
        unitId: rs.getString(rs.getColumnIndex('unit_id')),
        kind: 'session',
        workspaceId: ws,
        sessionId: rs.getString(rs.getColumnIndex('session_id')),
        version: rs.getLong(rs.getColumnIndex('version')),
        sha256: rs.getString(rs.getColumnIndex('sha256')),
        bytes: rs.getLong(rs.getColumnIndex('bytes')),
        assetPath: assetPath,
        assetSize: assetSize
      });
    }
  } finally {
    await rs.close();
  }
  return out;
}

/**
 * 执行导入。
 *
 * @param ctx 应用上下文
 * @param sessionsRoot 本机会话根（`$DSH_HOME/sessions`）
 * @param candidates 候选单元
 * @param mappings workspaceId → projectKey
 * @param sink 进度回调
 */
export async function runImport(ctx: common.Context, sessionsRoot: string,
  candidates: ImportCandidate[], mappings: WorkspaceMapping[],
  sink: (p: TaskProgress) => void, task: SyncTask = new SyncTask()): Promise<ImportReport> {
  task.check();
  const progress: TaskProgress = initialProgress('import');
  progress.stage = ImportStage.VERIFY;
  progress.total = candidates.length;
  progress.note = candidates.length === 0 ? '没有需要导入的内容' : `待导入 ${candidates.length} 项`;
  sink(copyOf(progress));

  const byWs: Map<string, string> = new Map<string, string>();
  for (let i: number = 0; i < mappings.length; i++) {
    byWs.set(mappings[i].workspaceId, mappings[i].projectKey);
  }

  const outcomes: ImportOutcome[] = [];
  let unmapped: number = 0;
  const root: string = String(sessionsRoot === undefined ? '' : sessionsRoot).trim();

  for (let i: number = 0; i < candidates.length; i++) {
    task.check();
    const c: ImportCandidate = candidates[i];
    progress.currentUnitId = c.unitId;
    progress.note = `校验 ${i + 1}/${candidates.length}：${c.sessionId} v${c.version}`;
    sink(copyOf(progress));

    const base: ImportOutcome = {
      unitId: c.unitId, sessionId: c.sessionId, version: c.version,
      outcome: UnitOutcome.FAILED, reason: '', targetPath: ''
    };

    /* ① 映射：没确认过的工作区一律不落盘 */
    const pk: string | undefined = byWs.get(c.workspaceId);
    if (pk === undefined || pk.length === 0) {
      outcomes.push(derive(base, UnitOutcome.FAILED, '工作区未映射（需先确认）', ''));
      unmapped++;
      progress.failed += 1;
      sink(copyOf(progress));
      continue;
    }
    if (!isSafeRelativePath(pk) || !isSafeRelativePath(c.sessionId)) {
      outcomes.push(derive(base, UnitOutcome.FAILED, '路径不安全（含非法段）', ''));
      progress.failed += 1;
      sink(copyOf(progress));
      continue;
    }

    /* ② 完整性：sha 形态 + 资产字节数 */
    if (!isValidSha256(c.sha256)) {
      outcomes.push(derive(base, UnitOutcome.FAILED, '记录缺少有效校验值', ''));
      progress.failed += 1;
      sink(copyOf(progress));
      continue;
    }
    if (c.assetPath.length === 0) {
      outcomes.push(derive(base, UnitOutcome.FAILED, '资产尚未就绪（未从云端下载）', ''));
      progress.failed += 1;
      sink(copyOf(progress));
      continue;
    }
    let assetStat: fs.Stat | null = null;
    try {
      assetStat = fs.statSync(c.assetPath);
    } catch (e) {
      outcomes.push(derive(base, UnitOutcome.FAILED, `资产不可读：${errText(e as Object)}`, ''));
      progress.failed += 1;
      sink(copyOf(progress));
      continue;
    }
    if (assetStat.size !== c.bytes) {
      outcomes.push(derive(base, UnitOutcome.FAILED, `资产字节数不符（期望 ${c.bytes}，实际 ${assetStat.size}）`, ''));
      progress.failed += 1;
      sink(copyOf(progress));
      continue;
    }

    /* ③ 目标路径与活跃保护 */
    const dir: string = `${root}/${pk}/${c.sessionId}`;
    const fileName: string = canonicalSessionFileName(c.version);
    const target: string = `${dir}/${fileName}`;
    if (fs.accessSync(target)) {
      /* 已存在：同内容幂等跳过，不同内容绝不覆盖 */
      let same: boolean = false;
      try {
        same = fs.statSync(target).size === c.bytes &&
          (await sha256OfFile(target)) === c.sha256.toLowerCase();
        task.check();
      } catch (e) {
        task.check();
        same = false;
      }
      if (same) {
        outcomes.push(derive(base, UnitOutcome.SKIPPED, '本机已存在同摘要文件', target));
        progress.skipped += 1;
      } else {
        outcomes.push(derive(base, UnitOutcome.FAILED, '本机已有内容不同的会话文件（不覆盖）', target));
        progress.failed += 1;
      }
      sink(copyOf(progress));
      continue;
    }

    /* ⑤ 原子落位：staging → rename */
    progress.stage = ImportStage.STAGE;
    progress.note = `落位 ${i + 1}/${candidates.length}：${fileName}`;
    sink(copyOf(progress));
    const staging: string = `${ctx.cacheDir}/dshm-import-staging`;
    let tmpPath: string = '';
    try {
      if (!fs.accessSync(staging)) {
        fs.mkdirSync(staging, true);
      }
      if (!fs.accessSync(dir)) {
        fs.mkdirSync(dir, true);
      }
      tmpPath = `${staging}/${c.sessionId}-v${c.version}-${Date.now()}-${Math.floor(Math.random() * 1000000)}.tmp`;
      if (fs.accessSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
      fs.copyFileSync(c.assetPath, tmpPath);
      /* 复制后复验字节数：跨文件系统复制也可能因空间不足截断 */
      if (fs.statSync(tmpPath).size !== c.bytes) {
        throw new Error('暂存副本字节数不符');
      }
      if ((await sha256OfFile(tmpPath)) !== c.sha256.toLowerCase()) {
        throw new Error('暂存副本SHA256不符');
      }
      task.check();
      if (fs.accessSync(target)) {
        throw new Error('校验期间本机出现目标文件（不覆盖）');
      }
      progress.stage = ImportStage.COMMIT;
      fs.renameSync(tmpPath, target);
      tmpPath = '';
    } catch (e) {
      if (tmpPath.length > 0) {
        try {
          fs.unlinkSync(tmpPath);
        } catch (e2) {
          /* 清理失败不掩盖原错误 */
        }
      }
      outcomes.push(derive(base, UnitOutcome.FAILED, `落位失败：${errText(e as Object)}`, ''));
      task.check();
      progress.failed += 1;
      sink(copyOf(progress));
      continue;
    }

    /* ⑥ 可用性验收：重新读一遍，确认文件在、大小对 */
    progress.stage = ImportStage.VERIFY_USABLE;
    sink(copyOf(progress));
    let usable: boolean = false;
    let why: string = '';
    try {
      if (!fs.accessSync(target)) {
        why = '落位后文件不存在';
      } else {
        const st: fs.Stat = fs.statSync(target);
        if (st.size !== c.bytes) {
          why = `验收字节数不符（${st.size} vs ${c.bytes}）`;
        } else {
          /* 真读一次头部字节，确认文件可打开（不是零长占位） */
          const f: fs.File = fs.openSync(target, fs.OpenMode.READ_ONLY);
          try {
            const buf: ArrayBuffer = new ArrayBuffer(64);
            const n: number = fs.readSync(f.fd, buf, { length: 64 });
            usable = n > 0;
            if (!usable) {
              why = '文件可打开但读不到内容';
            }
          } finally {
            fs.closeSync(f);
          }
        }
      }
    } catch (e) {
      why = `验收异常：${errText(e as Object)}`;
    }
    if (usable) {
      outcomes.push(derive(base, UnitOutcome.OK, '', target));
      progress.succeeded += 1;
    } else {
      /* 验收失败要回滚，不能留一个"看起来导入了但打不开"的文件 */
      try {
        fs.unlinkSync(target);
      } catch (e) {
        why += '（回滚失败，请手动检查）';
      }
      outcomes.push(derive(base, UnitOutcome.FAILED, why, target));
      progress.failed += 1;
    }
    sink(copyOf(progress));
  }

  progress.stage = ImportStage.DONE;
  task.check();
  progress.finished = true;
  progress.currentUnitId = '';
  const failedCount: number = progress.failed;
  progress.note = failedCount === 0
    ? `导入完成：${progress.succeeded} 项可用`
    : `导入完成：成功 ${progress.succeeded}、失败 ${failedCount}（其中 ${unmapped} 项工作区未映射，未写入未知目录）`;
  sink(copyOf(progress));

  return {
    ok: failedCount === 0,
    summary: progress.note,
    outcomes: outcomes,
    progress: progress
  };
}

function copyOf(p: TaskProgress): TaskProgress {
  return {
    task: p.task, stage: p.stage, total: p.total, succeeded: p.succeeded,
    failed: p.failed, skipped: p.skipped, currentUnitId: p.currentUnitId,
    note: p.note, preparedBytes: p.preparedBytes, finished: p.finished
  };
}

function errText(e: Object): string {
  const be: BusinessError = e as BusinessError;
  if (be !== undefined && be.message !== undefined) {
    return `[${be.code}] ${be.message}`;
  }
  return String(e);
}
