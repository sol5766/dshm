/**
 * 同步存储层：`sync_units` 表 + Asset 资产搬运（docs/313 §2、§9 批次 B）。
 *
 * ── 表是**生产契约**，不要随手改 ───────────────────────────────────────
 * AGC 云侧「本地表名称」必须填 `sync_units`，字段逐字一致、`payload` 选 **Asset**、
 * 端侧去重主键填 `unit_id`。云侧实施后**列只能增不能改** ⇒ 扩展走 `metadata` 的 JSON。
 *
 * ── 两条硬约束（docs/307 官方口径，踩过）────────────────────────────────
 * 1. **字段一律不加 NOT NULL** —— 官方明说端云同步不接受 NOT NULL，违反时同步报
 *    `{"schedule":2,"code":1}`，且极难定位。
 * 2. **主键必须是全局唯一文本**（不能自增）—— 端云同步要求跨设备唯一。
 *
 * ── Asset 的 `size` 是契约 ─────────────────────────────────────────────
 * 官方强调 `Asset.size` 是端云同步判定"资产是否变更"的关键依据，
 * 必须全链路统一为**字节数、非负整数的字符串**。写成 `"7MB"` 会让同步判断失准。
 *
 * ── 边界 ───────────────────────────────────────────────────────────────
 * 本模块只管"表与资产"：建表、写行、读行、把文件搬进 `distributedFilesDir`。
 * **不认识**会话格式，也**不决定**同步什么（那是 SyncPlanner 的事）。
 *
 * @module sync/SyncStore
 */
import { relationalStore } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { BusinessError, deviceInfo } from '@kit.BasicServicesKit';
import { SyncUnit, UnitKind, setDeviceId } from './SyncModel';
import { SyncTask } from './SyncTask';
import { sha256OfFile } from '../system/FileDigest';

/** 生产表名（AGC「本地表名称」必须逐字一致）。 */
export const SYNC_TABLE: string = 'sync_units';

/**
 * 生产库名（= AGC 云侧**容器名**）。
 *
 * 沿用 AGC 上已建好的容器 `DSHM` —— 容器名与本地库名必须一致（官方要求）。
 */
export const SYNC_DB: string = 'DSHM.db';

/** 资产文件落点（`distributedFilesDir` 下的子目录，官方要求资产放分布式文件路径）。 */
export const ASSET_DIR: string = 'dshm-sync-assets';
const ownedSnapshots: Set<string> = new Set<string>();
/** Retained registered/ambiguous snapshots are never auto-deleted. Refuse growth at 512 MiB. */
export const ASSET_BUDGET_BYTES: number = 512 * 1024 * 1024;

function retainedAssetBytes(dir: string): number {
  let bytes: number = 0;
  const children: string[] = fs.listFileSync(dir);
  for (const name of children) {
    const child: string = `${dir}/${name}`;
    const stat: fs.Stat = fs.statSync(child);
    if (stat.isDirectory()) {
      bytes += retainedAssetBytes(child);
    } else {
      bytes += stat.size;
    }
  }
  return bytes;
}

/** Reuse only an already registered immutable path whose actual bytes still match. */
export async function reusableAsset(store: relationalStore.RdbStore, unitId: string,
  sha: string, task: SyncTask): Promise<relationalStore.Asset | undefined> {
  task.check();
  const rs = await store.querySql(`SELECT sha256, payload FROM ${SYNC_TABLE} WHERE unit_id = ?`, [unitId]);
  try {
    task.check();
    if (!(await rs.goToFirstRow())) { return undefined; }
    task.check();
    if (rs.getString(rs.getColumnIndex('sha256')) !== sha) { return undefined; }
    const asset: relationalStore.Asset = rs.getAsset(rs.getColumnIndex('payload'));
    // Only this implementation's immutable snapshot namespaces qualify for reuse.
    if (asset.path.indexOf(`/${ASSET_DIR}/snapshot-`) < 0) { return undefined; }
    const digest: string = await sha256OfFile(asset.path);
    task.check();
    return digest === sha && fs.statSync(asset.path).size === Number(asset.size) ? asset : undefined;
  } finally {
    await rs.close();
  }
}

/** Only snapshots proved never submitted may be reclaimed by this process. */
export function discardUnregisteredAsset(asset: relationalStore.Asset): void {
  if (!ownedSnapshots.has(asset.path)) { return; }
  try {
    fs.unlinkSync(asset.path);
    fs.rmdirSync(asset.path.slice(0, asset.path.lastIndexOf('/')));
    ownedSnapshots.delete(asset.path);
  } catch (e) { /* retained for diagnosis; never expand cleanup beyond ownership */ }
}

/** 数据库实例与操作结果。 */
export interface StoreResult<T> {
  ok: boolean;
  error: string;
  value: T | null;
}

function fail<T>(msg: string): StoreResult<T> {
  return { ok: false, error: msg, value: null };
}

function okOf<T>(v: T): StoreResult<T> {
  return { ok: true, error: '', value: v };
}

function errText(e: Object): string {
  const be: BusinessError = e as BusinessError;
  if (be !== undefined && be.message !== undefined) {
    return `[${be.code}] ${be.message}`;
  }
  return String(e);
}

/**
 * 打开（并按需建表）同步库。
 *
 * 【为什么每次都要 DROP 重建表】——**不**。正式库绝不能重建：那会清掉用户已同步的记录，
 * 进而让端云同步把"本机没有"当成"删除"。
 * 这里只用 `CREATE TABLE IF NOT EXISTS`；表结构变更必须走迁移（列只能增）。
 */
/**
 * 进程内只保留**一个**同步库实例。
 *
 * 【为什么要单例（2026-11-03，云同步 CLOUD_DISABLED 排查结论之一）】
 * SDK `StoreConfig.name` 的原文：*"Creating two databases with the same name in the same process
 * is prohibited; otherwise, functions such as device-device sync, **device-cloud sync**, silent
 * access, and key backup may malfunction."*
 *
 * 而本文件原先的 `openStore()` 每次都被 `SyncEngine` / `UploadRunner` 直接调用（5 处以上），
 * 等于在**同一进程里反复对同名库调用 `getRdbStore`** —— 正是上面那句警告所说的场景。
 * 现在改为进程内缓存：第一次打开后复用，后续调用直接返回同一个实例。
 */
let storeCache: relationalStore.RdbStore | null = null;

/**
 * 读/建本机设备标识：`<files>/dshm-device-id`，内容形如 `MatePadPro13-3f2a9c1d`。
 *
 * 【为什么不用序列号/IMEI】那是设备唯一标识，属敏感信息，云同步只需要"能区分是哪台设备"，
 * 型号 + 一次性随机后缀就够，且不触碰任何系统标识接口（也就没有额外权限要求）。
 */
function ensureDeviceId(ctx: common.Context): void {
  try {
    const p: string = `${ctx.filesDir}/dshm-device-id`;
    if (fs.accessSync(p)) {
      const raw: string = fs.readTextSync(p).trim();
      if (raw.length > 0) {
        setDeviceId(raw);
        return;
      }
    }
    let model: string = 'DSHM';
    try {
      /* ArkTS 不允许把命名空间强转成 Record，只能直取属性 */
      const m: string = deviceInfo.productModel;
      if (m !== undefined && m.length > 0) {
        model = m.replace(/[^A-Za-z0-9]/g, '');
      }
    } catch (e) { /* 取不到型号就退回 DSHM */ }
    const suffix: string = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
    const id: string = `${model.slice(0, 20)}-${suffix.slice(0, 8)}`;
    /* @kit.CoreFileKit 的 fileIo 没有 writeFileSync，只能 open + writeSync + close */
    const file: fs.File = fs.openSync(p, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE);
    try {
      fs.writeSync(file.fd, id + '\n');
    } finally {
      fs.closeSync(file);
    }
    setDeviceId(id);
  } catch (e) {
    /* 建不出来就留 unknown：不阻塞同步，只是云端分不出设备 */
  }
}

export async function openStore(ctx: common.Context): Promise<StoreResult<relationalStore.RdbStore>> {
  if (storeCache !== null) {
    return okOf(storeCache);
  }
  const config: relationalStore.StoreConfig = {
    name: SYNC_DB,
    securityLevel: relationalStore.SecurityLevel.S1
  };
  let store: relationalStore.RdbStore | null = null;
  try {
    store = await relationalStore.getRdbStore(ctx, config);
  } catch (e) {
    return fail<relationalStore.RdbStore>(`打开同步库失败：${errText(e as Object)}`);
  }
  if (store === null) {
    return fail<relationalStore.RdbStore>('打开同步库失败：实例为空');
  }
  const ddl: string =
    `CREATE TABLE IF NOT EXISTS ${SYNC_TABLE} (` +
    'unit_id TEXT PRIMARY KEY, ' +
    'kind TEXT, ' +
    'workspace_id TEXT, ' +
    'session_id TEXT, ' +
    'version INTEGER, ' +
    'sha256 TEXT, ' +
    'bytes INTEGER, ' +
    'updated_at INTEGER, ' +
    'metadata TEXT, ' +
    'payload ASSET, ' +
    /*
     * 【2026-11-05 新增两列：把"设备 + 日期"显式建模】
     *
     * 起因（客户需求 + docs/374 §3）：现网要"上传后按设备+日期存、其他设备选设备+日期恢复"。
     * 但 `unit_id = kind/workspaceId/key` **不含设备**，`workspace_id` 又是项目路径的 FNV 哈希
     * （两台设备同一项目算出同一个值）⇒ 光靠旧列分不出"谁传的"；而 `updated_at` 是**内容修改时间**，
     * 不是上传时间，用它当"日期"会把三天前的内容算成今天的快照。
     *
     * 纪律：本表**只加列不改列**（旧设备仍能读自己的老行；新列对老行是 NULL）。
     * 云端对应 `device_id` / `uploaded_at` 两个字段（docs/374 §2.3）。
     */
    'device_id TEXT, ' +
    'uploaded_at INTEGER' +
    ')';
  try {
    await store.executeSql(ddl);
  } catch (e) {
    return fail<relationalStore.RdbStore>(`建表失败：${errText(e as Object)}`);
  }
  /*
   * 迁移：老库已存在时 `CREATE TABLE IF NOT EXISTS` 不会补列 ⇒ 逐列 `ALTER TABLE ADD COLUMN`。
   * 失败只可能是"列已存在"，属正常路径，不判红。
   */
  for (const column of ['device_id TEXT', 'uploaded_at INTEGER']) {
    try {
      await store.executeSql(`ALTER TABLE ${SYNC_TABLE} ADD COLUMN ${column}`);
    } catch (e) {
      /* 列已存在：忽略 */
    }
  }
  storeCache = store;
  ensureDeviceId(ctx);
  return okOf(store);
}

/**
 * 把一个文件搬进 `distributedFilesDir` 并构造 Asset 描述。
 *
 * 【为什么要复制而不是原地引用】官方要求资产文件本体位于**分布式文件路径**下，
 * 端云同步才会把它当资产上传。会话文件本身在 `files/` 下，不能直接当资产。
 *
 * @param ctx 应用上下文
 * @param srcPath 源文件绝对路径
 * @param assetName 资产文件名（会做安全化处理）
 * @returns 成功后 `value` 是 Asset 描述
 */
export function stageAsset(ctx: common.Context, srcPath: string,
  assetName: string): StoreResult<relationalStore.Asset> {
  const dir: string = `${ctx.distributedFilesDir}/${ASSET_DIR}`;
  let snapshot: string = '';
  let dst: string = '';
  try {
    if (!fs.accessSync(dir)) {
      fs.mkdirSync(dir, true);
    }
    const sourceBytes: number = fs.statSync(srcPath).size;
    if (retainedAssetBytes(dir) + sourceBytes > ASSET_BUDGET_BYTES) {
      return fail<relationalStore.Asset>('同步资产保留空间预算不足（512 MiB）；已登记资产可能仍被系统引用，不自动删除，请先减少同步范围');
    }
    const safe: string = String(assetName === undefined ? '' : assetName)
      .replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
    const name: string = safe.length > 0 ? safe : `asset-${Date.now()}.bin`;
    // 每次唯一拥有的不可变副本。登记后保留，不能假定insert已经快照。
    snapshot = fs.mkdtempSync(`${dir}/snapshot-XXXXXX`);
    dst = `${snapshot}/${name}`;
    fs.copyFileSync(srcPath, dst);
    const stat: fs.Stat = fs.statSync(dst);
    if (retainedAssetBytes(dir) > ASSET_BUDGET_BYTES) {
      throw new Error('复制期间源文件增长，资产超过512 MiB预算；本次未登记副本已拒绝');
    }
    const asset: relationalStore.Asset = {
      name: name,
      uri: 'file://' + dst,
      path: dst,
      createTime: String(Math.floor(stat.atime * 1000)),
      modifyTime: String(Math.floor(stat.mtime * 1000)),
      /* ★ 字节数、非负整数的字符串（官方契约） */
      size: String(Math.max(0, Math.floor(stat.size))),
      status: relationalStore.AssetStatus.ASSET_NORMAL
    };
    ownedSnapshots.add(dst);
    return okOf(asset);
  } catch (e) {
    if (dst.length > 0) {
      try { fs.unlinkSync(dst); } catch (cleanupError) { /* copy may not have created it */ }
    }
    if (snapshot.length > 0) {
      try { fs.rmdirSync(snapshot); } catch (cleanupError) { /* only owned empty directory */ }
    }
    return fail<relationalStore.Asset>(`暂存资产失败：${errText(e as Object)}`);
  }
}

/**
 * 写入一个同步单元（幂等 upsert）。
 *
 * 【为什么要先删同名行】`insert` 撞主键会失败；而端云同步关心的是**最终状态**，
 * 不是插入次数。先把旧行删掉再插，语义等于"以本次为准"。
 * 注意这**不会**让云端误判删除 —— 端云同步按 `unit_id` 收敛，同一事务内删+插等于更新。
 */
export async function upsertUnit(store: relationalStore.RdbStore,
  unit: SyncUnit, asset: relationalStore.Asset, task: SyncTask = new SyncTask()): Promise<StoreResult<boolean>> {
  try {
    task.check();
    const row: relationalStore.ValuesBucket = {
      'unit_id': unit.unitId,
      'kind': String(unit.kind),
      'workspace_id': unit.workspaceId,
      'session_id': unit.sessionId,
      'version': unit.version,
      'sha256': unit.sha256,
      'bytes': unit.bytes,
      'updated_at': unit.updatedAt,
      'metadata': unit.metadata,
      'device_id': unit.deviceId,
      'uploaded_at': unit.uploadedAt,
      'payload': asset
    };
    // 单条replace避免取消/insert失败发生在delete之后留下缺行。
    task.check();
    // Once submitted, failure may be ambiguous: retain immutable path conservatively.
    ownedSnapshots.delete(asset.path);
    await store.insert(SYNC_TABLE, row, relationalStore.ConflictResolution.ON_CONFLICT_REPLACE);
    return okOf(true);
  } catch (e) {
    return fail<boolean>(`写入单元失败：${errText(e as Object)}`);
  }
}

/** 本机已有的单元 ID 集合（用于增量判断，避免重复搬运）。 */
export async function loadUnitIndex(store: relationalStore.RdbStore): Promise<StoreResult<Map<string, string>>> {
  const idx: Map<string, string> = new Map<string, string>();
  try {
    const rs = await store.querySql(`SELECT unit_id, sha256 FROM ${SYNC_TABLE}`);
    try {
      while (await rs.goToNextRow()) {
        /* 读字符串列：用 getString 而非默认类型，避免长文本被截断（会话名可能很长） */
        const id: string = rs.getString(rs.getColumnIndex('unit_id'));
        const sha: string = rs.getString(rs.getColumnIndex('sha256'));
        idx.set(id, sha);
      }
    } finally {
      await rs.close();
    }
    return okOf(idx);
  } catch (e) {
    return fail<Map<string, string>>(`读取单元索引失败：${errText(e as Object)}`);
  }
}

/**
 * 声明云端分布式表并开启自动同步。
 *
 * 【为什么每次同步前都要调一次】`setDistributedTables` 是**会话级**的：
 * 应用重启后需要重新声明，否则 `cloudSync` 会报 `DISTRIBUTED_TABLE_NOT_SET(4)`。
 */
export async function enableCloudSync(store: relationalStore.RdbStore): Promise<StoreResult<boolean>> {
  try {
    const config: relationalStore.DistributedConfig = { autoSync: true };
    await store.setDistributedTables([SYNC_TABLE],
      relationalStore.DistributedType.DISTRIBUTED_CLOUD, config);
    return okOf(true);
  } catch (e) {
    const be: BusinessError = e as BusinessError;
    const hint: string = (be !== undefined && be.code === 801)
      ? '（设备不支持端云同步）'
      : ((be !== undefined && be.code >= 14800000) ? '（多为 AGC 云侧未配置或字段不一致）' : '');
    return fail<boolean>(`声明云端分布式表失败：${errText(e as Object)}${hint}`);
  }
}

/**
 * 触发一次同步并等待进度回调给出结论。
 *
 * 【为什么不能只看 `cloudSync` 的 resolve】官方口径：resolve 只表示**请求被受理**；
 * 真正的结果在 `ProgressDetails.code` 里。所以这里等回调、以最后一次 code 为准。
 *
 * @param mode `SYNC_MODE_NATIVE_FIRST`（端→云）或 `SYNC_MODE_CLOUD_FIRST`（云→端）
 */
export async function runCloudSync(store: relationalStore.RdbStore,
  mode: relationalStore.SyncMode, onProgress: (schedule: number, code: number) => void,
  waitMs: number): Promise<StoreResult<boolean>> {
  let lastCode: number = -1;
  let lastSchedule: number = -1;
  try {
    await store.cloudSync(mode, [SYNC_TABLE], (p: relationalStore.ProgressDetails) => {
      lastCode = p.code;
      lastSchedule = p.schedule;
      onProgress(lastSchedule, lastCode);
    });
  } catch (e) {
    return fail<boolean>(`cloudSync 调用失败：${errText(e as Object)}`);
  }
  /* 给进度回调留出到达余量（Promise resolve 不保证回调已全部到齐） */
  await sleep(waitMs);
  if (lastCode === 0) {
    return okOf(true);
  }
  if (lastCode < 0) {
    return fail<boolean>('未收到同步进度回调（无法确认结果）');
  }
  /*
   * 【CLOUD_DISABLED 的可操作提示（2026-11-06 按正式包口径重写）】
   * code=3 官方原文 "The cloud is unavailable."。这段只会出现在 AGC 正式/邀请测试包里，
   * 故**不再出现任何 beta 身份或另一套包名** —— 正式包里带 beta 包名会让用户误判装错包。
   * 排序按排查成本：设备侧 → AGC 开关 → 云侧容器/表/字段契约（官方要求逐字一致）。
   * 现网 AGC 配置为「数据类型 syncdshm、10 字段（含 workspace）」，与本地
   * `DSHM.db / sync_units / 12 列` 不符，见 ③④；这几项只能在 AGC 控制台改。
   */
  const hint: string = lastCode === 3
    ? '（端云同步不可用：①确认已登录华为账号、系统设置里云空间已开启、本应用同步开关已打开；'
      + '②AGC 已为 com.dshm.dshclient 开启云空间服务并启用端云同步；'
      + '③AGC 云空间：容器 DSHM；数据类型名称用合法字母数字（如 dshmsyncunits），'
      + '「本地表名称」必须填 sync_units；'
      + '④字段须与本地 12 列逐字一致：workspace 改为 workspace_id，并补 kind、metadata；'
      + '⑤配置改动后须「实施变更到生产环境」，并退出华为账号重新登录再复测）'
    : '';
  return fail<boolean>(`云端同步未成功：code=${syncCodeName(lastCode)} schedule=${lastSchedule}${hint}`);
}

/** 进度码转可读名（官方 ProgressCode 全集）。 */
export function syncCodeName(code: number): string {
  switch (code) {
    case 0: return 'SUCCESS';
    case 1: return 'UNKNOWN_ERROR';
    case 2: return 'NETWORK_ERROR';
    case 3: return 'CLOUD_DISABLED';
    case 4: return 'LOCKED_BY_OTHERS';
    case 5: return 'RECORD_LIMIT_EXCEEDED';
    case 6: return 'NO_SPACE_FOR_ASSET';
    case 7: return 'BLOCKED_BY_NETWORK_STRATEGY';
    case 8: return 'STOP_CLOUD_SYNC';
    default: return `code-${code}`;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve: () => void) => {
    setTimeout(() => resolve(), ms);
  });
}

/** 从表里按 kind 统计（清单页与概览用）。 */
export interface KindStat {
  kind: string;
  count: number;
  bytes: number;
}

export async function statByKind(store: relationalStore.RdbStore): Promise<StoreResult<KindStat[]>> {
  const out: KindStat[] = [];
  try {
    const rs = await store.querySql(
      `SELECT kind, COUNT(*) AS n, SUM(bytes) AS b FROM ${SYNC_TABLE} GROUP BY kind`);
    try {
      while (await rs.goToNextRow()) {
        out.push({
          kind: rs.getString(rs.getColumnIndex('kind')),
          count: rs.getLong(rs.getColumnIndex('n')),
          bytes: rs.getLong(rs.getColumnIndex('b'))
        });
      }
    } finally {
      await rs.close();
    }
    return okOf(out);
  } catch (e) {
    return fail<KindStat[]>(`统计失败：${errText(e as Object)}`);
  }
}

/** 把一个 kind 的全部单元读出来（清单页展示；不取 Asset 本体）。 */
export async function listUnits(store: relationalStore.RdbStore,
  kind: UnitKind): Promise<StoreResult<SyncUnit[]>> {
  const out: SyncUnit[] = [];
  try {
    const rs = await store.querySql(
      `SELECT unit_id, kind, workspace_id, session_id, version, sha256, bytes, updated_at, metadata `
      + `FROM ${SYNC_TABLE} WHERE kind = '${String(kind)}' ORDER BY updated_at DESC`);
    try {
      while (await rs.goToNextRow()) {
        out.push({
          unitId: rs.getString(rs.getColumnIndex('unit_id')),
          kind: kind,
          workspaceId: rs.getString(rs.getColumnIndex('workspace_id')),
          sessionId: rs.getString(rs.getColumnIndex('session_id')),
          version: rs.getLong(rs.getColumnIndex('version')),
          sha256: rs.getString(rs.getColumnIndex('sha256')),
          bytes: rs.getLong(rs.getColumnIndex('bytes')),
          updatedAt: rs.getLong(rs.getColumnIndex('updated_at')),
          metadata: rs.getString(rs.getColumnIndex('metadata')),
          deviceId: rs.getString(rs.getColumnIndex('device_id')),
          uploadedAt: rs.getLong(rs.getColumnIndex('uploaded_at'))
        });
      }
    } finally {
      await rs.close();
    }
    return okOf(out);
  } catch (e) {
    return fail<SyncUnit[]>(`读取清单失败：${errText(e as Object)}`);
  }
}
