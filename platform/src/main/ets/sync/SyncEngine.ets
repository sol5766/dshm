/**
 * 云同步的状态中枢（**唯一真源**，供 UI 与同步逻辑共用）。
 *
 * ── 它管什么 ─────────────────────────────────────────────────────────
 * · **登录态**：华为账号 UnionID（脱敏展示用）与是否已登录；
 * · **同步开关**：用户是否允许上云；
 * · **待同步范围**：复用 `docs/301` 已完成的会话清单扫描（`SessionSyncScope`）；
 * · **诊断入口**：验证页的开关状态（由宿主页面监听）。
 *
 * ── 它**不**管什么（边界）───────────────────────────────────────────
 * · 不直接读写会话文件 —— 那属于同步执行器；
 * · 不持有授权码 / Access Token —— 登录回调里只取 UnionID，凭据不外传；
 * · 不落盘敏感信息 —— 登录态在内存（持久化需要先定威胁模型，见 docs/307 §6）。
 *
 * ── 为什么做成静态类 ─────────────────────────────────────────────────
 * 页面是 `Stack` 内组件、宿主在 `WebApp`；用静态状态让两侧读到同一份事实，
 * 不必在组件树里层层传参。这与本仓 `SessionHub.shared()` 的做法一致。
 *
 * @module sync/SyncEngine
 */
import { common } from '@kit.AbilityKit';
import { SyncTask } from './SyncTask';
import { fileIo as fs } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { buildManifest, SyncManifest } from '../system/SessionSyncScope';
import { maskUnionId } from '../system/HuaweiCloud';
import { initialProgress, TaskProgress } from './SyncModel';
import { mergePlans, planAttachments, planSessions, planSkills, PlanResult, workspaceIdOf } from './SyncPlanner';
import { runUpload, UploadReport, sha256OfFile } from './UploadRunner';
import {
  discoverImportCandidates, ImportCandidate, ImportReport, runImport, WorkspaceMapping
} from './ImportRunner';
import { discardUnregisteredAsset, enableCloudSync, openStore, reusableAsset, runCloudSync, statByKind, KindStat, SYNC_TABLE, stageAsset, upsertUnit } from './SyncStore';
import { relationalStore } from '@kit.ArkData';
import { SyncUnit, UnitKind, encodeMetadata, UNIT_METADATA_SCHEMA, deviceIdNow } from './SyncModel';
import { makeUnitId } from './SyncModel';
import { PluginManifest, PluginSpec, readPluginManifest, toInstallPayload } from './PluginManifest';
import { diffPlugins, PluginDiff, PluginRestoreReport, runPluginRestore } from './PluginRestore';

/** 待同步范围的概况（给 UI 显示，不暴露绝对路径）。 */
export interface SyncScopeSummary {
  sessionCount: number;
  totalBytes: number;
}

/** 同步引擎对外暴露的状态快照。 */
export interface SyncEngineState {
  signedIn: boolean;
  /**
   * 脱敏后的 UnionID（形如 `****abcd`）。
   *
   * 【2026-11-05 / docs/378】**只作诊断，不再上 UI**。用户反馈它"很像内部代号"，
   * 界面统一改读 `accountLabel`。保留字段是为了不破坏状态快照的向后兼容
   * （网页侧按"缺字段回退缺省"解析），也便于门禁继续钉住"原始 unionId 不外泄"。
   */
  maskedUnionId: string;
  /**
   * 用户自己认识的账号展示名（昵称 / 匿名手机号 / 匿名邮箱，已二次脱敏）。
   *
   * 由 `HuaweiCloud.fetchAccountDisplayName()` 在用户点「登录」后尽力读取；
   * 读不到时 `state()` 退回 `'已登录'`，**绝不退回 `****abcd`**。
   */
  accountLabel: string;
  enabled: boolean;
  /** 上次同步结果的一句话（未同步过为空串） */
  lastSyncText: string;
  /** 已安装的用户插件数（跨端同步的依据） */
  pluginCount: number;

  /* ── 账号卡字段（docs/313 §4.1a）────────────────────────────── */
  /**
   * 展示名。
   *
   * 【来源与降级】拿到 `profile` 授权才有昵称；没有授权时退回
   * "华为账号用户"，**不伪造**，也不显示 UnionID 原文。
   */
  displayName: string;
  /** 云服务一句话状态（已连接 / 待开启 / 未检测 / 异常） */
  cloudServiceText: string;
  /** 云服务状态徽标文案（短） */
  cloudServiceBadge: string;
  /** 云服务是否可用（决定徽标颜色） */
  cloudServiceOk: boolean;
}

export class SyncEngine {
  /** 登录态：UnionID 原文只在内存，展示时一律脱敏。 */
  private static unionId: string = '';
  /** 同步开关（用户会话级；默认关闭 —— 上云必须由用户主动开启）。 */
  private static enabled: boolean = false;
  /** 上次同步结果文案。 */
  private static lastSync: string = '';
  /** UI 事件监听器（登录请求 + 诊断路由）。 */
  /** 会话根目录（由宿主在启动时注入，避免本模块自己猜路径）。 */
  private static sessionsRoot: string = '';
  /** profile 目录（`$DSH_HOME/profiles/ondevice`，同样由宿主注入）。 */
  private static profileDir: string = '';
  /**
   * 昵称（**可选**）。
   *
   * 只有用户额外授权 `profile` scope 才有；没有就留空，展示层退回"华为账号用户"。
   * 不把"ID 登录"当成"拿到了用户资料"（docs/313 §4.1b）。
   */
  private static nickName: string = '';
  /**
   * 账号展示名（docs/378）：昵称 / 匿名手机号 / 匿名邮箱，已二次脱敏。
   * 只在内存、只在登录成功后写入；退出登录必须清空，防止串号显示。
   */
  private static accountLabel: string = '';
  /** 云服务状态（由实际检测写入；登录成功本身不算） */
  private static cloudText: string = '';
  private static cloudBadge: string = '';
  private static cloudOk: boolean = false;
  /** 是否正在跑同步任务（防重入）。 */
  private static running: boolean = false;
  private static task: SyncTask | undefined = undefined;
  private static generation: number = 0;

  static currentGeneration(): number {
    return SyncEngine.generation;
  }

  private static invalidateTask(): void {
    SyncEngine.generation++;
    SyncEngine.task?.cancel();
    SyncEngine.progress = initialProgress('upload');
    SyncEngine.progress.note = SyncEngine.running ? '任务已取消，正在等待在途系统调用结束' : '';
    SyncEngine.kindStat = [];
  }
  /** 当前任务进度（UI 轮询它）。 */
  private static progress: TaskProgress = initialProgress('upload');
  /** 工作区映射（workspaceId → 本机 projectKey）；未确认的不会导入 */
  /** 最近一次清单统计（概览用） */
  private static kindStat: KindStat[] = [];

  /** UI 首帧用的初始状态。 */
  static initialState(): SyncEngineState {
    return {
      signedIn: false,
      maskedUnionId: '',
      accountLabel: '',
      enabled: false,
      lastSyncText: '',
      pluginCount: 0,
      displayName: '华为账号用户',
      cloudServiceText: '尚未检测',
      cloudServiceBadge: '未检测',
      cloudServiceOk: false
    };
  }

  static state(): SyncEngineState {
    return {
      signedIn: SyncEngine.unionId.length > 0,
      maskedUnionId: maskUnionId(SyncEngine.unionId),
      /*
       * 已登录但没读到资料 ⇒ 说人话「已登录」，不拿 `****abcd` 冒充账号。
       * 这正是用户反馈「显示得很像内部代号」的根因（docs/378）。
       */
      accountLabel: SyncEngine.accountLabel.length > 0 ? SyncEngine.accountLabel : '已登录',
      enabled: SyncEngine.enabled,
      lastSyncText: SyncEngine.lastSync,
      pluginCount: SyncEngine.pluginCount(),
      displayName: SyncEngine.nickName.length > 0 ? SyncEngine.nickName : '华为账号用户',
      cloudServiceText: SyncEngine.cloudText.length > 0 ? SyncEngine.cloudText : '尚未检测',
      cloudServiceBadge: SyncEngine.cloudBadge.length > 0 ? SyncEngine.cloudBadge : '未检测',
      cloudServiceOk: SyncEngine.cloudOk
    };
  }

  /** 读端侧已安装的用户插件数（不联网、不碰 node_modules）。 */
  static pluginCount(): number {
    if (SyncEngine.profileDir.length === 0) {
      return 0;
    }
    try {
      const m: PluginManifest = readPluginManifest(SyncEngine.profileDir);
      return m.plugins.length;
    } catch (e) {
      return 0;
    }
  }

  /**
   * 导出插件清单（同步到云端用）。
   *
   * 【为什么只导清单不导产物】`node_modules` 有 143 MB 且每端架构不同，
   * 而清单只有几 KB，端侧安装器本来就支持 `github:` / npm 版本两种 spec ⇒
   * 换端时按清单重装即可。
   */
  static exportPluginManifest(): string {
    if (SyncEngine.profileDir.length === 0) {
      return '';
    }
    try {
      const m: PluginManifest = readPluginManifest(SyncEngine.profileDir);
      return toInstallPayload(m);
    } catch (e) {
      return '';
    }
  }

  /** 列出本端的用户插件（设置页展示用）。 */
  static plugins(): PluginSpec[] {
    if (SyncEngine.profileDir.length === 0) {
      return [];
    }
    try {
      return readPluginManifest(SyncEngine.profileDir).plugins;
    } catch (e) {
      return [];
    }
  }

  /**
   * 宿主注入会话根目录（端侧是 `$DSH_HOME/sessions`）。
   *
   * 【为什么由宿主注入】本模块不该知道 DSH_HOME 怎么拼 —— 那是 `hostruntime` 的职责。
   */
  static attachSessionsRoot(root: string): void {
    if (SyncEngine.sessionsRoot !== String(root === undefined || root === null ? '' : root).trim()) {
      SyncEngine.invalidateTask();
    }
    SyncEngine.sessionsRoot = String(root === undefined || root === null ? '' : root).trim();
  }

  /** 宿主注入 profile 目录（插件清单的来源）。 */
  static attachProfileDir(dir: string): void {
    if (SyncEngine.profileDir !== String(dir === undefined || dir === null ? '' : dir).trim()) {
      SyncEngine.invalidateTask();
    }
    SyncEngine.profileDir = String(dir === undefined || dir === null ? '' : dir).trim();
  }

  /**
   * 采纳一次成功登录。
   *
   * @param unionId 官方登录回调里的 UnionID
   */
  static adoptLogin(unionId: string): void {
    SyncEngine.invalidateTask();
    SyncEngine.unionId = String(unionId === undefined || unionId === null ? '' : unionId).trim();
    /*
     * 【docs/378】换账号时旧账号的展示名必须立即作废，否则会短暂串号显示。
     * 展示名由登录后的独立异步调用回填，不在这里猜。
     */
    SyncEngine.accountLabel = '';
    SyncEngine.nickName = '';
    /*
     * 登录成功只确立"账号身份"，**不代表云服务已连接**。
     * 云服务状态初始化为"待开启"，等真实启用后再由 setCloudService 改写。
     */
    SyncEngine.cloudOk = false;
    SyncEngine.cloudText = '登录成功，云同步尚未开启';
    SyncEngine.cloudBadge = '待开启';
  }

  /**
   * 采纳可选的用户资料（`profile` 授权成功后调用）。
   *
   * @param nick 昵称；空串表示没有授权，展示层退回默认称谓
   */
  static adoptProfile(nick: string): void {
    SyncEngine.nickName = String(nick === undefined || nick === null ? '' : nick).trim().slice(0, 40);
  }

  /**
   * 采纳账号展示名（docs/378）。
   *
   * 【为什么单独一个方法】展示名的来源是 `HuaweiCloud.fetchAccountDisplayName()`，
   * 与"昵称授权"是两件事：前者必然已二次脱敏、可直接上 UI；后者可能为空。
   * 失败时传空串 ⇒ `state()` 退回「已登录」，不会退回 `****abcd`。
   */
  static adoptAccountLabel(label: string): void {
    SyncEngine.accountLabel = String(label === undefined || label === null ? '' : label).trim().slice(0, 40);
  }

  /**
   * 记录云服务的**实测**状态（由同步链路的真实结果调用）。
   *
   * @param ok 是否可用
   * @param text 一句话说明
   * @param badge 短徽标
   */
  static setCloudService(ok: boolean, text: string, badge: string): void {
    SyncEngine.cloudOk = ok;
    SyncEngine.cloudText = String(text === undefined ? '' : text);
    SyncEngine.cloudBadge = String(badge === undefined ? '' : badge);
  }

  /** 退出登录：清内存态与开关（**不动本机会话数据**）。 */
  static signOut(): void {
    SyncEngine.invalidateTask();
    SyncEngine.unionId = '';
    SyncEngine.enabled = false;
    SyncEngine.lastSync = '';
    /* 资料与云服务状态都是**这个账号**的，退出必须一并清掉（防止串号显示） */
    SyncEngine.nickName = '';
    SyncEngine.accountLabel = '';
    SyncEngine.cloudOk = false;
    SyncEngine.cloudText = '';
    SyncEngine.cloudBadge = '';
  }

  /**
   * 设置同步开关。
   *
   * @returns '' 表示成功；非空为失败原因（给用户看）
   */
  static async setEnabled(on: boolean): Promise<string> {
    if (on && SyncEngine.unionId.length === 0) {
      return '请先登录华为账号';
    }
    SyncEngine.enabled = on;
    if (!on) {
      SyncEngine.invalidateTask();
      SyncEngine.lastSync = '已关闭';
      return '';
    }
    SyncEngine.lastSync = '等待首次同步';
    return '';
  }

  /** 统计待同步范围（读本地清单，不发网络请求）。 */
  static scopeSummary(): SyncScopeSummary | null {
    if (SyncEngine.sessionsRoot.length === 0) {
      return null;
    }
    try {
      const manifest: SyncManifest = buildManifest(SyncEngine.sessionsRoot);
      return { sessionCount: manifest.sessionCount, totalBytes: manifest.totalBytes };
    } catch (e) {
      return null;
    }
  }

  /**
   * 立即同步一次（**真实上传链路**，docs/313 批次 B）。
   *
   * 流程见 `UploadRunner`：扫描 → 搬 Asset → 写 sync_units → 云端同步 → 核对。
   * 结果如实写进 `lastSync` 与云服务状态，**不谎报成功**。
   *
   * @param ctx 应用上下文（由宿主传入，本模块不缓存 Context 以免泄漏）
   * @returns '' 表示成功；非空为失败原因
   */
  static async syncNow(ctx: common.Context): Promise<string> {
    if (!SyncEngine.enabled) {
      return '请先开启云同步';
    }
    if (SyncEngine.unionId.length === 0) {
      return '请先登录华为账号';
    }
    if (SyncEngine.sessionsRoot.length === 0) {
      return '同步目录未就绪';
    }
    if (SyncEngine.running) {
      return '已有同步任务在进行';
    }
    SyncEngine.running = true;
    const task: SyncTask = new SyncTask();
    SyncEngine.task = task;
    SyncEngine.progress = initialProgress('upload');
    SyncEngine.progress.note = '正在扫描本机数据…';
    SyncEngine.lastSync = '正在同步…';
    try {
      /*
       * 规划范围（docs/313 §1.1）：会话 + 附件 + 技能。
       * 插件清单在批次 D 接入（它不走文件搬运，走清单比对）。
       */
      const home: string = SyncEngine.homeOf(SyncEngine.sessionsRoot);
      const plan: PlanResult = mergePlans([
        planSessions(SyncEngine.sessionsRoot),
        planAttachments(`${home}/attachments`),
        planSkills(`${home}/skills`)
      ]);
      const report: UploadReport = await runUpload(ctx, plan, (p: TaskProgress) => {
        if (task.isCurrent()) { SyncEngine.progress = p; }
      }, task);
      task.check();
      /*
       * 插件清单单独上传（它不是文件搬运，是一份文本）：
       * 换设备时靠它把插件装回去（docs/313 §7）。失败不阻断整批同步，
       * 但要在结果里说清楚，不能让用户以为插件也备份好了。
       */
      const pluginNote: string = await SyncEngine.uploadPluginManifest(ctx, task);
      task.check();
      SyncEngine.lastSync = pluginNote.length > 0
        ? `${report.summary}（${pluginNote}）` : report.summary;
      /* 云服务状态按真实结果更新（不是"登录了就可用"） */
      if (report.cloudError.length > 0) {
        SyncEngine.setCloudService(false, report.cloudError, '异常');
      } else if (report.ok) {
        SyncEngine.setCloudService(true, '已连接，数据可同步到云端', '已连接');
      } else {
        SyncEngine.setCloudService(false, '部分项目未同步成功', '部分失败');
      }
      return report.ok ? '' : report.summary;
    } catch (e) {
      if (!task.isCurrent()) { return '同步任务已取消'; }
      const msg: string = e === undefined || e === null ? '未知错误' : String((e as BusinessError).message);
      SyncEngine.lastSync = `同步失败：${msg}`;
      SyncEngine.setCloudService(false, msg, '异常');
      return `同步失败：${msg}`;
    } finally {
      if (SyncEngine.task === task) {
        SyncEngine.running = false;
        SyncEngine.task = undefined;
      }
    }
  }

  /**
   * 拉取 + 导入（**两段独立进度**，docs/313 §5.2 / §5.3）。
   *
   * 顺序严格分开：
   * ```text
   * ① 拉取：触发 SYNC_MODE_CLOUD_FIRST，让系统把云端记录与资产下载到本机
   * ② 导入：把已就绪的资产按六道闸落回会话树
   * ```
   * 「下载完成」不等于「导入完成」——两个进度分别上报，页面也分别显示。
   *
   * @param ctx 应用上下文
   * @param templates 可选：用户为云端工作区指定的本机 projectKey（未给则用同 ID 候选）
   */
  static async pullAndImport(ctx: common.Context): Promise<string> {
    if (SyncEngine.unionId.length === 0) {
      return '请先登录华为账号';
    }
    if (SyncEngine.sessionsRoot.length === 0) {
      return '同步目录未就绪';
    }
    if (SyncEngine.running) {
      return '已有同步任务在进行';
    }
    SyncEngine.running = true;
    const task: SyncTask = new SyncTask();
    SyncEngine.task = task;
    SyncEngine.progress = initialProgress('pull');
    try {
      const storeRes = await openStore(ctx);
      task.check();
      if (!storeRes.ok || storeRes.value === null) {
        return storeRes.error;
      }
      const store: relationalStore.RdbStore = storeRes.value;

      /* ── ① 拉取 ─────────────────────────────────────────────── */
      SyncEngine.progress.stage = 'discover';
      SyncEngine.progress.note = '正在从云端拉取…';
      const enable = await enableCloudSync(store);
      task.check();
      if (!enable.ok) {
        SyncEngine.setCloudService(false, enable.error, '异常');
        return enable.error;
      }
      const pullRes = await runCloudSync(store, relationalStore.SyncMode.SYNC_MODE_CLOUD_FIRST,
        (schedule: number, code: number) => {
          if (!task.isCurrent()) { return; }
          SyncEngine.progress.note = `云端拉取中（schedule=${schedule} code=${code}）`;
        }, 2500);
      task.check();
      if (!pullRes.ok) {
        SyncEngine.setCloudService(false, pullRes.error, '异常');
        return pullRes.error;
      }

      /* ── ② 导入 ─────────────────────────────────────────────── */
      SyncEngine.progress = initialProgress('import');
      SyncEngine.progress.note = '正在导入…';
      const mappings: WorkspaceMapping[] = SyncEngine.resolveMappings();
      const candidates: ImportCandidate[] = await discoverImportCandidates(store, mappings);
      task.check();
      const report: ImportReport = await runImport(ctx, SyncEngine.sessionsRoot, candidates,
        mappings, (p: TaskProgress) => {
          if (task.isCurrent()) { SyncEngine.progress = p; }
        }, task);
      task.check();
      SyncEngine.lastSync = report.summary;
      SyncEngine.setCloudService(report.ok, report.summary, report.ok ? '已连接' : '存在遗漏/失败');
      return report.ok ? '' : report.summary;
    } catch (e) {
      if (!task.isCurrent()) { return '同步任务已取消'; }
      const msg: string = e === undefined || e === null ? '未知错误' : String((e as BusinessError).message);
      SyncEngine.lastSync = `拉取/导入失败：${msg}`;
      return `拉取/导入失败：${msg}`;
    } finally {
      if (SyncEngine.task === task) {
        SyncEngine.running = false;
        SyncEngine.task = undefined;
      }
    }
  }

  /**
   * 解析工作区映射。
   *
   * 【首版策略】用"本机 sessions 目录里真实存在的工作区"作为候选集：
   * 只有**本机确实有这个工作区**才允许往它下面写，
   * 这等价于"用户已经有了这个工作区"，避免凭空建目录（docs/313 §3.1）。
   */
  private static resolveMappings(): WorkspaceMapping[] {
    const out: WorkspaceMapping[] = [];
    let keys: string[] = [];
    try {
      keys = fs.listFileSync(SyncEngine.sessionsRoot);
    } catch (e) {
      return out;
    }
    for (let i: number = 0; i < keys.length; i++) {
      const k: string = keys[i];
      if (!k.startsWith('--') || !k.endsWith('--')) {
        continue;
      }
      out.push({ workspaceId: workspaceIdOf(k), projectKey: k });
    }
    return out;
  }

  /** 刷新清单统计（设置页概览与清单页用）。 */
  static async refreshStat(ctx: common.Context): Promise<void> {
    const generation: number = SyncEngine.generation;
    const storeRes = await openStore(ctx);
    if (generation !== SyncEngine.generation) { return; }
    if (!storeRes.ok || storeRes.value === null) {
      return;
    }
    const st = await statByKind(storeRes.value);
    if (generation !== SyncEngine.generation) { return; }
    if (st.ok && st.value !== null) {
      SyncEngine.kindStat = st.value;
    }
  }

  /** 读最近一次清单统计（同步返回，UI 直接用）。 */
  static stats(): KindStat[] {
    return SyncEngine.kindStat;
  }

  /**
   * 上传插件清单（批次 D：让另一台设备能把插件装回去）。
   *
   * 清单是几 KB 文本，写成 Asset 挂在一个固定 `unit_id` 上：
   * 每次上传覆盖同一条，云端永远只保留"当前清单"。
   *
   * @returns '' 表示成功或无插件；非空为提示语（附在同步结论后面）
   */
  private static async uploadPluginManifest(ctx: common.Context, task: SyncTask): Promise<string> {
    task.check();
    if (SyncEngine.profileDir.length === 0) {
      return '';
    }
    let json: string = '';
    try {
      json = SyncEngine.exportPluginManifest();
    } catch (e) {
      json = '';
    }
    if (json.length === 0) {
      return '';
    }
    const storeRes = await openStore(ctx);
    task.check();
    if (!storeRes.ok || storeRes.value === null) {
      return '插件清单未上传（同步库不可用）';
    }
    /* 先落一个临时文件，再按 Asset 规范搬进 distributedFilesDir */
    const tmpDir: string = `${ctx.cacheDir}/dshm-plugin-manifest`;
    let snapshot: relationalStore.Asset | undefined = undefined;
    try {
      if (!fs.accessSync(tmpDir)) {
        fs.mkdirSync(tmpDir, true);
      }
      const tmp: string = `${tmpDir}/plugins.json`;
      if (fs.accessSync(tmp)) {
        fs.unlinkSync(tmp);
      }
      const f: fs.File = fs.openSync(tmp,
        fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
      try {
        fs.writeSync(f.fd, json);
      } finally {
        fs.closeSync(f);
      }
      const sourceSha: string = await sha256OfFile(tmp);
      task.check();
      const previous: relationalStore.Asset | undefined = await reusableAsset(storeRes.value,
        makeUnitId(UnitKind.PLUGIN_MANIFEST, 'global', 'current'), sourceSha, task);
      task.check();
      if (previous !== undefined) { return ''; }
      const assetRes = stageAsset(ctx, tmp, 'plugin-manifest.json');
      if (!assetRes.ok || assetRes.value === null) {
        return '插件清单未上传';
      }
      snapshot = assetRes.value;
      const sha: string = await sha256OfFile(assetRes.value.path);
      task.check();
      const unit: SyncUnit = {
        unitId: makeUnitId(UnitKind.PLUGIN_MANIFEST, 'global', 'current'),
        kind: UnitKind.PLUGIN_MANIFEST,
        workspaceId: 'global',
        sessionId: '',
        version: 0,
        sha256: sha,
        bytes: Number(assetRes.value.size),
        updatedAt: Date.now(),
        deviceId: deviceIdNow(),
        uploadedAt: Date.now(),
        metadata: encodeMetadata({
          schema: UNIT_METADATA_SCHEMA,
          displayName: '插件清单',
          fileName: 'plugin-manifest.json',
          formatVersion: -1
        })
      };
      const up = await upsertUnit(storeRes.value, unit, assetRes.value, task);
      task.check();
      return up.ok ? '' : '插件清单未上传';
    } catch (e) {
      return '插件清单未上传';
    } finally {
      if (snapshot !== undefined) { discardUnregisteredAsset(snapshot); }
    }
  }

  /**
   * 读云端插件清单原文（批次 D）。
   *
   * 【从哪里读】同步表里 `kind = 'plugin_manifest'` 那条单元的 Asset 文件内容。
   * 读不到就返回空串 —— 调用方据此如实显示"云端没有清单"，
   * 而不是伪造一份空清单让用户以为"已同步"。
   */
  static async readRemotePluginManifest(ctx: common.Context): Promise<string> {
    const storeRes = await openStore(ctx);
    if (!storeRes.ok || storeRes.value === null) {
      return '';
    }
    try {
      const rs = await storeRes.value.querySql(
        `SELECT payload FROM ${SYNC_TABLE} WHERE kind = 'plugin_manifest' LIMIT 1`);
      try {
        if (!(await rs.goToFirstRow())) {
          return '';
        }
        const asset: relationalStore.Asset = rs.getAsset(rs.getColumnIndex('payload'));
        const path: string = asset.path === undefined ? '' : String(asset.path);
        if (path.length === 0 || !fs.accessSync(path)) {
          return '';
        }
        return fs.readTextSync(path);
      } finally {
        await rs.close();
      }
    } catch (e) {
      return '';
    }
  }

  /**
   * 比较**云端插件清单**与**本机清单**（批次 D）。
   *
   * 云端清单来自同步表里的 `plugin_manifest` 单元；本机清单直接读 profile。
   * @returns 缺失 / 版本不同 / 一致 三组
   */
  static async pluginDiff(ctx: common.Context, remoteJson: string): Promise<PluginDiff> {
    const remote: PluginSpec[] = parseManifestPlugins(remoteJson);
    const local: PluginSpec[] = SyncEngine.profileDir.length > 0
      ? readPluginManifest(SyncEngine.profileDir).plugins : [];
    return diffPlugins(remote, local);
  }

  /**
   * 按用户勾选安装插件（批次 D）。
   *
   * 【默认不自动装】插件组合直接影响应用能否启动；不替用户做决定（docs/313 §13）。
   */
  static async restorePlugins(ctx: common.Context, specs: PluginSpec[]): Promise<PluginRestoreReport> {
    if (SyncEngine.running || SyncEngine.unionId.length === 0) {
      return { ok: false, summary: '未登录或已有同步任务在进行', outcomes: [], needsRestart: false };
    }
    if (specs.length === 0) {
      return { ok: true, summary: '没有选择要安装的插件', outcomes: [], needsRestart: false };
    }
    SyncEngine.running = true;
    const task: SyncTask = new SyncTask();
    SyncEngine.task = task;
    try {
    SyncEngine.progress = initialProgress('plugins');
    SyncEngine.progress.total = specs.length;
    SyncEngine.progress.note = '正在安装插件…';
    const report: PluginRestoreReport = await runPluginRestore(ctx, specs,
      (done: number, total: number, current: string) => {
        if (!task.isCurrent()) { return; }
        SyncEngine.progress.succeeded = done;
        SyncEngine.progress.total = total;
        SyncEngine.progress.note = current.length > 0
          ? `正在安装 ${done + 1}/${total}：${current}` : '安装完成';
      }, task);
    task.check();
    SyncEngine.progress.finished = true;
    SyncEngine.progress.note = report.summary;
    SyncEngine.lastSync = report.summary;
    return report;
    } catch (e) {
      return { ok: false, summary: task.isCurrent() ? '插件恢复失败' : '同步任务已取消', outcomes: [], needsRestart: false };
    } finally {
      if (SyncEngine.task === task) {
        SyncEngine.running = false;
        SyncEngine.task = undefined;
      }
    }
  }

  /**
   * 由会话根反推 `$DSH_HOME`。
   *
   * 【为什么不另外让宿主注入一个】`sessionsRoot` 已经是 `<home>/sessions`，
   * 反推一次比多一个可忘传的参数更可靠（少一个会不同步的字段）。
   */
  private static homeOf(sessionsRoot: string): string {
    const suffix: string = '/sessions';
    const r: string = String(sessionsRoot);
    if (r.endsWith(suffix)) {
      return r.slice(0, r.length - suffix.length);
    }
    /* 形态不符就退回父目录：宁可多扫一层，也不要拿空串去拼路径 */
    const i: number = r.lastIndexOf('/');
    return i > 0 ? r.slice(0, i) : r;
  }

  /** 当前同步任务的进度快照（UI 读它显示进度条）。 */
  static currentProgress(): TaskProgress {
    return SyncEngine.progress;
  }

  /** 是否正在同步。 */
  static isRunning(): boolean {
    return SyncEngine.running;
  }

  /*
   * 2026-10-30 生产清理：诊断路由已随验证页一并移除（docs/313 批次 A）。
   *
   * 2026-10-31 再清理（docs/323）：`onUi()` / `requestLogin()` / `SyncUiListener`
   * 一并删除 —— 它们是 `LoginPanel` 时代的"菜单请求拉起登录面板"通道。
   * 登录改静默授权后，这条链**全仓零调用方**（只有定义与导出），
   * 留着只会让人以为"菜单还能拉登录面板"。
   */
}

/**
 * 从云端清单 JSON 里取插件数组。
 *
 * 【为什么要独立解析】云端存的是 `{"schema":N,"plugins":[{name,spec}]}`；
 * 结构坏了必须返回空数组并让上层判"清单不可用"，**不能猜**。
 */
function parseManifestPlugins(json: string): PluginSpec[] {
  const out: PluginSpec[] = [];
  const text: string = String(json === undefined || json === null ? '' : json).trim();
  if (text.length === 0) {
    return out;
  }
  let root: Record<string, Object> | null = null;
  try {
    root = JSON.parse(text) as Record<string, Object>;
  } catch (e) {
    return out;
  }
  if (root === null) {
    return out;
  }
  const arr: Object | undefined = root['plugins'];
  if (arr === undefined || arr === null) {
    return out;
  }
  const list: Object[] = arr as Object[];
  for (let i: number = 0; i < list.length; i++) {
    const item: Record<string, Object> = list[i] as Record<string, Object>;
    const name: string = item['name'] === undefined ? '' : String(item['name']);
    const spec: string = item['spec'] === undefined ? '' : String(item['spec']);
    if (name.length > 0 && spec.length > 0) {
      out.push({ name: name, spec: spec });
    }
  }
  return out;
}
