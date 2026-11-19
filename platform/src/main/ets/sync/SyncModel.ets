/**
 * 同步数据模型：统一 **unit** 与任务状态机（docs/313 §2、§9 批次 A）。
 *
 * ── 为什么统一成一张表 ─────────────────────────────────────────────────
 * 会话代际、附件、技能、插件清单、工作区索引，本质上都是
 * **「不可变内容 + 元数据」**。若每类各建一张表，就要各写一套上传/下载/校验，
 * 也就各自踩一遍 Asset 的坑（`size` 格式、NOT NULL、主键去重……见 docs/307）。
 * 统一为 `sync_units` 后：**一套搬运、一套校验、一套进度**。
 *
 * ── 表结构是**生产契约**，改动前先看这里 ───────────────────────────────
 * AGC 云侧「本地表名称」必须填 `sync_units`，字段逐字一致，`payload` 选 **Asset**，
 * 端侧去重主键填 `unit_id`。云侧实施后**列只能增不能改** ⇒ 这张表一次定死，
 * 将来扩展走 `metadata` 里的 JSON，不加列。
 *
 * ── 本模块的边界 ───────────────────────────────────────────────────────
 * 纯数据与状态机：**不碰文件系统、不碰 RDB、不联网**。
 * 这样它可以被离线门禁"真跑"，而不用起设备。
 *
 * @module sync/SyncModel
 */

/**
 * 同步单元类型。
 *
 * 【值为什么用短字符串】会写进云端 `kind` 列并被另一端的旧版本读到；
 * 短且稳定，避免"枚举顺序变了导致旧包误读"。
 */
export enum UnitKind {
  SESSION = 'session',
  ATTACHMENT = 'attachment',
  SKILL = 'skill',
  PLUGIN_MANIFEST = 'plugin_manifest',
  WORKSPACE = 'workspace'
}

/** `kind` 的字符串值是否合法（跨端读到未知类型时**不当成新类型**，而是报异常）。 */
export function isKnownKind(raw: string): boolean {
  const v: string = asText(raw);
  return v === UnitKind.SESSION || v === UnitKind.ATTACHMENT || v === UnitKind.SKILL
    || v === UnitKind.PLUGIN_MANIFEST || v === UnitKind.WORKSPACE;
}

/** 安全的字符串化（避免 undefined/null 进模板）。 */
function asText(v: Object | undefined | null): string {
  if (v === undefined || v === null) {
    return '';
  }
  return String(v);
}

// ───────────────────────── ① 单元 ─────────────────────────

/**
 * 一个同步单元的元数据（**不含**文件本体）。
 *
 * 文件本体在 `distributedFilesDir` 里，由 `payload` 这个 Asset 指过去。
 */
export interface SyncUnit {
  /** 全局稳定 ID；跨端去重主键，**禁止自增**（官方硬要求） */
  unitId: string;
  kind: UnitKind;
  /** 稳定工作区 ID（不是本机绝对路径） */
  workspaceId: string;
  /** 会话类记录的会话 ID；其它类型为空 */
  sessionId: string;
  /** 会话代际号；其它类型为 0 */
  version: number;
  /** 内容字节校验（小写十六进制） */
  sha256: string;
  /** 文件字节数 */
  bytes: number;
  /** 毫秒时间戳 */
  updatedAt: number;
  /** 有 schema 的小 JSON：显示名、原文件名、迁移代际等；**不放密钥、不放本机路径** */
  metadata: string;
  /*
   * 【2026-11-05 新增：把"设备 + 日期"显式建模】
   *
   * `unitId = kind/workspaceId/key` **不含设备**，`workspaceId` 又是项目路径的 FNV 哈希
   * （两台设备同一项目算出同一个值）⇒ 光靠旧字段分不出"哪台设备传的"；
   * `updatedAt` 是**内容修改时间**，不是上传时间，拿它当"日期"会把三天前的内容算成今天的快照。
   * 故显式记两列：本机稳定设备标识（型号+短哈希，**不用序列号**）与本次上传时间。
   */
  deviceId: string;
  uploadedAt: number;
}

/** `metadata` 的 schema 号；改形状必须 +1，旧端读到未知版本要拒绝而不是硬解。 */
export const UNIT_METADATA_SCHEMA: number = 1;

/** `metadata` 解出来之后的可选字段（缺失即不认识，按空处理）。 */
export interface UnitMetadata {
  schema: number;
  /** 给人看的显示名（如会话标题、文件名） */
  displayName: string;
  /** 原文件名（导入时用来还原扩展名） */
  fileName: string;
  /** 会话格式代际（上游 v0..v4）；非会话类为 -1 */
  formatVersion: number;
}

/** 构造 metadata JSON（**只放白名单字段**，防止误把本机路径写进去）。 */
export function encodeMetadata(m: UnitMetadata): string {
  const obj: string =
    `{"schema":${UNIT_METADATA_SCHEMA}`
    + `,"displayName":${JSON.stringify(asText(m.displayName).slice(0, 120))}`
    + `,"fileName":${JSON.stringify(asText(m.fileName).slice(0, 120))}`
    + `,"formatVersion":${Number.isFinite(m.formatVersion) ? Math.trunc(m.formatVersion) : -1}}`;
  return obj;
}

/**
 * 解析 metadata。
 *
 * 【失败要能解释】返回 `null` 时调用方必须把该单元标成异常，**不能当成"没有元数据"继续导入** ——
 * 那会把一个结构不明的文件写进用户的会话目录。
 */
export function decodeMetadata(raw: string): UnitMetadata | null {
  const text: string = asText(raw);
  if (text.trim().length === 0) {
    return null;
  }
  let parsed: Record<string, Object> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, Object>;
  } catch (e) {
    return null;
  }
  if (parsed === null) {
    return null;
  }
  const schema: number = typeof parsed['schema'] === 'number' ? parsed['schema'] as number : -1;
  if (schema !== UNIT_METADATA_SCHEMA) {
    /* 未知 schema ⇒ 明确"不认识"，绝不猜字段含义 */
    return null;
  }
  const fv: number = typeof parsed['formatVersion'] === 'number'
    ? parsed['formatVersion'] as number : -1;
  return {
    schema: schema,
    displayName: asText(parsed['displayName']),
    fileName: asText(parsed['fileName']),
    formatVersion: fv
  };
}

// ───────────────────────── ② unitId 编解码 ─────────────────────────

/**
 * 生成稳定 unitId。
 *
 * 形态：`<kind>/<workspaceId>/<payload>`，例如
 * ```text
 * session/ws-a1b2/3f9c...v2      ← 会话代际
 * attachment/ws-a1b2/sha256:9af…
 * plugin_manifest/global/current
 * skill/global/ohos-shell
 * ```
 *
 * 【为什么要可读】跨端排障时能一眼看出"这是哪个工作区哪一类东西"，
 * 比纯 UUID 有用得多；而唯一性由 payload 段保证。
 *
 * 【为什么不用绝对路径】cwd 跨端不同，带进去就永久错位（docs/301 §6.1）。
 */
export function makeUnitId(kind: UnitKind, workspaceId: string, key: string): string {
  const ws: string = asText(workspaceId).trim().length > 0 ? asText(workspaceId).trim() : 'global';
  const k: string = asText(key).trim();
  return `${kind}/${ws}/${k}`;
}

/** 解析 unitId 的三段式；非法形态返回 null。 */
export interface ParsedUnitId {
  kind: string;
  workspaceId: string;
  key: string;
}

export function parseUnitId(raw: string): ParsedUnitId | null {
  const v: string = asText(raw);
  const first: number = v.indexOf('/');
  if (first <= 0) {
    return null;
  }
  const second: number = v.indexOf('/', first + 1);
  if (second <= first + 1) {
    return null;
  }
  const kind: string = v.slice(0, first);
  const ws: string = v.slice(first + 1, second);
  const key: string = v.slice(second + 1);
  if (key.length === 0) {
    return null;
  }
  return { kind: kind, workspaceId: ws, key: key };
}

// ───────────────────────── ③ 任务与进度 ─────────────────────────

/**
 * 三类任务的阶段（docs/313 §5：上传、拉取、导入**分开显示**）。
 *
 * 【为什么用三个枚举而不是一个】它们的阶段语义完全不同，合成一个会让 UI
 * 出现"下载 80% 却显示同步完成"这类假进度 —— 这是规划里明确禁止的。
 */
export enum UploadStage {
  SCAN = 'scan',
  STAGE_FILE = 'stage_file',
  WRITE_DB = 'write_db',
  CLOUD_SYNC = 'cloud_sync',
  VERIFY = 'verify',
  DONE = 'done'
}

export enum PullStage {
  DISCOVER = 'discover',
  FETCH_META = 'fetch_meta',
  FETCH_ASSET = 'fetch_asset',
  READY = 'ready',
  DONE = 'done'
}

export enum ImportStage {
  VERIFY = 'verify',
  MAP_WORKSPACE = 'map_workspace',
  STAGE = 'stage',
  COMMIT = 'commit',
  VERIFY_USABLE = 'verify_usable',
  DONE = 'done'
}

/** 单个单元的终态。 */
export enum UnitOutcome {
  PENDING = 'pending',
  OK = 'ok',
  SKIPPED = 'skipped',
  FAILED = 'failed'
}

/**
 * 一次任务的进度快照（**所有进度显示的唯一数据源**）。
 *
 * 【计数口径】`total/succeeded/failed/skipped` 均以**单元数**计。
 * 云端传输没有字节级接口（`ProgressDetails.details` 只给
 * `total/successful/failed/remained`），所以页面不得把 `preparedBytes`
 * 包装成"云端百分比"。
 */
export interface TaskProgress {
  /** 任务类型：'upload' / 'pull' / 'import' */
  task: string;
  /** 当前阶段（三种任务的枚举值之一） */
  stage: string;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  /** 当前正在处理的单元 ID（可空） */
  currentUnitId: string;
  /** 当前阶段的一句话说明（给用户看，例如"正在校验附件 3/12"） */
  note: string;
  /** 已准备的本地字节数（**仅用于本地阶段**，不代表已上云） */
  preparedBytes: number;
  /** 是否已结束 */
  finished: boolean;
}

/** 新任务的初始进度。 */
export function initialProgress(task: string): TaskProgress {
  return {
    task: task,
    stage: '',
    total: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    currentUnitId: '',
    note: '',
    preparedBytes: 0,
    finished: false
  };
}

/**
 * 计算"已处理/总数"的完成比例（0..1）。
 *
 * 【为什么是 processed 而不是 succeeded】失败与跳过也是**已处理**，
 * 否则失败一项会让进度条永远停在 99%，用户以为卡死。
 */
export function progressRatio(p: TaskProgress): number {
  const processed: number = p.succeeded + p.failed + p.skipped;
  if (p.total <= 0) {
    return 0;
  }
  const r: number = processed / p.total;
  return r < 0 ? 0 : (r > 1 ? 1 : r);
}

/** 是否还有未处理项。 */
export function hasRemaining(p: TaskProgress): boolean {
  return (p.succeeded + p.failed + p.skipped) < p.total;
}

// ───────────────────────── ④ 动作计划（纯函数，可门禁）─────────────────────────

/**
 * 一个同步单元在**本机 vs 云端**下的动作。
 *
 * 这是 docs/313 §3.2 冲突规则的**唯一实现**：UI 列表与执行器都读它，
 * 不允许各自再判一遍（两份判据必然走样）。
 */
export enum UnitAction {
  /* 本机有、云端无 ⇒ 上传 */
  UPLOAD = 'upload',
  /* 云端有、本机无 ⇒ 可拉取导入 */
  PULL = 'pull',
  /* 两端都有且 sha256 一致 ⇒ 跳过 */
  SKIP = 'skip',
  /* 两端都有但 sha256 不同 ⇒ 异常，**不覆盖**，交用户决定 */
  CONFLICT = 'conflict',
  /* 云端有但本机该会话正在使用 ⇒ 暂不导入 */
  DEFER = 'defer'
}

/**
 * 判定一个单元该做什么。
 *
 * @param localSha 本机内容的 sha256；没有则空串
 * @param remoteSha 云端内容的 sha256；没有则空串
 * @param inUse 该单元对应的本机会话是否正在使用/写入
 */
export function decideAction(localSha: string, remoteSha: string, inUse: boolean): UnitAction {
  const l: string = asText(localSha).trim().toLowerCase();
  const r: string = asText(remoteSha).trim().toLowerCase();
  if (l.length === 0 && r.length === 0) {
    return UnitAction.SKIP;
  }
  if (l.length > 0 && r.length === 0) {
    return UnitAction.UPLOAD;
  }
  if (l.length === 0 && r.length > 0) {
    /* 云端有新内容：正在使用的会话不抢，进"待导入" */
    return inUse ? UnitAction.DEFER : UnitAction.PULL;
  }
  if (l === r) {
    return UnitAction.SKIP;
  }
  /* 同 ID 不同内容：不猜谁对，标冲突 */
  return UnitAction.CONFLICT;
}

/** 动作是否能自动执行（不需要用户先裁决）。 */
export function isAutomatic(action: UnitAction): boolean {
  return action === UnitAction.UPLOAD || action === UnitAction.PULL || action === UnitAction.SKIP;
}

/** 动作的中文说明（UI 与日志共用一张表，避免两处措辞不一致）。 */
export function actionLabel(action: UnitAction): string {
  switch (action) {
    case UnitAction.UPLOAD: return '待上传';
    case UnitAction.PULL: return '可拉取';
    case UnitAction.SKIP: return '已同步';
    case UnitAction.CONFLICT: return '内容冲突';
    case UnitAction.DEFER: return '待导入（会话使用中）';
    default: return '未知';
  }
}

// ───────────────────────── ⑤ sha256 ─────────────────────────

/**
 * 校验 sha256 文本是否像样（64 位小写十六进制）。
 *
 * 【为什么要校验它】它是**导入前的完整性判据**。若云端给了一个空串或畸形值，
 * 绝不能当成"通过"——空 sha 等于关掉了完整性闸门。
 */
export function isValidSha256(raw: string): boolean {
  const v: string = asText(raw).trim();
  if (v.length !== 64) {
    return false;
  }
  for (let i: number = 0; i < v.length; i++) {
    const c: string = v.charAt(i);
    const lower: string = c.toLowerCase();
    if (!((lower >= '0' && lower <= '9') || (lower >= 'a' && lower <= 'f'))) {
      return false;
    }
  }
  return true;
}

/**
 * 本机设备标识（**型号 + 短随机串**，绝不用序列号/IMEI）。
 *
 * 【为什么要单独存一份】`unitId` 不含设备、`workspaceId` 是项目路径哈希（跨设备同值），
 * 所以"哪个设备传的"必须自带。这里做成模块级缓存：由 `SyncStore.openStore()` 在拿到
 * `ctx.filesDir` 时读/建 `<files>/dshm-device-id` 并写入，业务代码只取不算。
 */
let DEVICE_ID_CACHE: string = '';

/** 由 `SyncStore.openStore()` 调用；幂等。 */
export function setDeviceId(id: string): void {
  const v: string = String(id === undefined || id === null ? '' : id).trim();
  if (v.length > 0) {
    DEVICE_ID_CACHE = v;
  }
}

/** 当前设备标识；尚未初始化时返回 `unknown`（不会崩，但云端会显示 unknown）。 */
export function deviceIdNow(): string {
  return DEVICE_ID_CACHE.length > 0 ? DEVICE_ID_CACHE : 'unknown';
}
