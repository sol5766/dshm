/**
 * 插件恢复执行器：把云端插件清单**装回本机**（docs/313 §7、批次 D）。
 *
 * ── 为什么插件不传 `node_modules` ──────────────────────────────────────
 * 装好的产物有 143 MB、含原生模块、绑定架构与 ABI ⇒ 跨端必坏（docs/309/310）。
 * 所以同步的是**清单**（包名 + 安装 spec，几 KB），到端走既有安装通道重装。
 *
 * ── 复用既有通道，不另造轮子 ───────────────────────────────────────────
 * ```text
 * install-queue/<id>.req   ← 本模块只负责**写这一行 spec**
 *       ↓ Host 轮询
 * dshm-installer.js installSpec()
 *       ↓
 * <id>.done / <id>.fail   ← 本模块轮询并汇总
 * ```
 * 完整性校验、依赖递归、bundle 登记、失败回执全部沿用既有实现。
 *
 * ── 三条纪律 ───────────────────────────────────────────────────────────
 * 1. **默认不自动装**：用户勾选后才装（首版口径，docs/313 §13 第 5 项）。
 * 2. **版本不同默认保留本机**：不静默把用户当前能跑的版本换掉。
 * 3. **装完不等于可用**：bundle 型插件要**重启应用**才挂载，UI 必须这么提示。
 *
 * @module sync/PluginRestore
 */
import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { PluginSpec } from './PluginManifest';
import { SyncTask } from './SyncTask';

/** 单个插件的安装状态。 */
export enum PluginInstallState {
  PENDING = 'pending',
  RUNNING = 'running',
  INSTALLED = 'installed',
  FAILED = 'failed',
  SKIPPED = 'skipped'
}

/** 一个插件的安装结果。 */
export interface PluginInstallOutcome {
  name: string;
  spec: string;
  state: PluginInstallState;
  /** 失败原因或说明（成功也写一句，便于核对） */
  reason: string;
}

/** 批量安装报告。 */
export interface PluginRestoreReport {
  ok: boolean;
  summary: string;
  outcomes: PluginInstallOutcome[];
  /** 是否需要重启才生效（bundle 型插件装上了就是 true） */
  needsRestart: boolean;
}

/** 插件对比结果：本机缺什么、哪些版本不同。 */
export interface PluginDiff {
  /** 本机没有、云端有的（可安装） */
  missing: PluginSpec[];
  /** 两端都有但 spec 不同（默认保留本机） */
  differing: PluginSpec[];
  /** 两端一致（无需动作） */
  same: PluginSpec[];
}

/**
 * 比较云端清单与本机清单。
 *
 * 【为什么 spec 不同只标记不覆盖】本机正在跑的版本是**已经验证能用的**；
 * 云端那份可能是另一台设备的组合。静默换版本等于替用户做决定，
 * 而插件组合直接影响应用能否启动（docs/310 §7.2）。
 */
export function diffPlugins(remote: PluginSpec[], local: PluginSpec[]): PluginDiff {
  const localMap: Map<string, string> = new Map<string, string>();
  for (let i: number = 0; i < local.length; i++) {
    localMap.set(local[i].name, local[i].spec);
  }
  const out: PluginDiff = { missing: [], differing: [], same: [] };
  for (let i: number = 0; i < remote.length; i++) {
    const r: PluginSpec = remote[i];
    const l: string | undefined = localMap.get(r.name);
    if (l === undefined) {
      out.missing.push(r);
    } else if (l === r.spec) {
      out.same.push(r);
    } else {
      out.differing.push(r);
    }
  }
  return out;
}

/** dependencies的值不是独立npm安装请求；Git来源则保留完整原文。 */
export function restoreInstallSpec(plugin: PluginSpec): string {
  const spec: string = plugin.spec.trim();
  if (spec.startsWith('github:') || spec.startsWith('git+') || spec.startsWith('git@') ||
    spec.startsWith('https:') || spec.startsWith('http:') ||
    (!spec.startsWith('npm:') && spec.indexOf('/') >= 0)) {
    return spec;
  }
  return `${plugin.name}@${spec}`;
}

/**
 * 安装一个插件（投递 .req 并等待回执）。
 *
 * @param queueDir `$DSH_HOME/install-queue`
 * @param spec 安装 spec 原文（`github:o/r#ref` 或版本号）
 * @param timeoutMs 等待上限（GitHub 源实测可达 113 s，见 installer 注释）
 */
export async function installOne(queueDir: string, spec: string,
  timeoutMs: number, task: SyncTask = new SyncTask()): Promise<PluginInstallOutcome> {
  task.check();
  const outcome: PluginInstallOutcome = {
    name: spec, spec: spec, state: PluginInstallState.PENDING, reason: ''
  };
  try {
    if (!fs.accessSync(queueDir)) {
      fs.mkdirSync(queueDir, true);
    }
  } catch (e) {
    outcome.state = PluginInstallState.FAILED;
    outcome.reason = '创建安装队列目录失败';
    return outcome;
  }
  const base: string = `sync-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const reqPath: string = `${queueDir}/${base}.req`;
  try {
    const f: fs.File = fs.openSync(reqPath,
      fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(f.fd, spec);
    } finally {
      fs.closeSync(f);
    }
  } catch (e) {
    outcome.state = PluginInstallState.FAILED;
    outcome.reason = '写入安装请求失败';
    return outcome;
  }

  outcome.state = PluginInstallState.RUNNING;
  const startedAt: number = Date.now();
  /* 轮询回执：Host 单线程安装，一个包可能要等一两分钟 */
  while (Date.now() - startedAt < timeoutMs) {
    task.check();
    const done: string = `${queueDir}/${base}.done`;
    const fail: string = `${queueDir}/${base}.fail`;
    try {
      const text: string = fs.readTextSync(done);
      removeQuietly(done);
      outcome.state = PluginInstallState.INSTALLED;
      outcome.reason = describeReceipt(text);
      return outcome;
    } catch (e) {
      /* 还没有 .done，看 .fail */
    }
    try {
      const text: string = fs.readTextSync(fail);
      removeQuietly(fail);
      outcome.state = PluginInstallState.FAILED;
      outcome.reason = describeReceipt(text);
      return outcome;
    } catch (e) {
      /* 都还没有，继续等 */
    }
    await sleep(1200);
  }
  outcome.state = PluginInstallState.FAILED;
  outcome.reason = '等待安装结果超时';
  return outcome;
}

/**
 * 批量安装（用户勾选的那些）。
 *
 * 逐个串行：Host 侧本身就是一次装一个（并发会踩 `node_modules`）。
 */
export async function runPluginRestore(ctx: common.Context, specs: PluginSpec[],
  onProgress: (done: number, total: number, current: string) => void,
  task: SyncTask = new SyncTask()): Promise<PluginRestoreReport> {
  task.check();
  const queueDir: string = `${ctx.filesDir}/dsh/home/install-queue`;
  const outcomes: PluginInstallOutcome[] = [];
  /* GitHub 源实测慢到 113 s，给 4 分钟余量；npm 源通常几秒 */
  const PER_ITEM_TIMEOUT: number = 240 * 1000;

  for (let i: number = 0; i < specs.length; i++) {
    task.check();
    const s: PluginSpec = specs[i];
    onProgress(i, specs.length, s.name);
    const r: PluginInstallOutcome = await installOne(queueDir, restoreInstallSpec(s), PER_ITEM_TIMEOUT, task);
    task.check();
    r.name = s.name;
    outcomes.push(r);
  }
  onProgress(specs.length, specs.length, '');

  let okCount: number = 0;
  let failCount: number = 0;
  for (let i: number = 0; i < outcomes.length; i++) {
    if (outcomes[i].state === PluginInstallState.INSTALLED) {
      okCount += 1;
    } else {
      failCount += 1;
    }
  }
  const summary: string = specs.length === 0
    ? '没有需要安装的插件'
    : (failCount === 0 ? `已安装 ${okCount} 个插件` : `安装完成：成功 ${okCount}、失败 ${failCount}`);
  return {
    ok: failCount === 0,
    summary: summary,
    outcomes: outcomes,
    /* 装上了就要重启才挂载 —— 不能对用户说"已可用" */
    needsRestart: okCount > 0
  };
}

/** 从回执 JSON 里取一句人话。 */
function describeReceipt(text: string): string {
  const t: string = String(text === undefined ? '' : text).trim();
  if (t.length === 0) {
    return '已安装';
  }
  /* 回执是 JSON；取 error 或 note 字段，取不到就截断原文 */
  const errMatch: RegExpMatchArray | null = t.match(/"error"\s*:\s*"([^"]*)"/);
  if (errMatch !== null && errMatch[1].length > 0) {
    return errMatch[1].slice(0, 160);
  }
  const noteMatch: RegExpMatchArray | null = t.match(/"note"\s*:\s*"([^"]*)"/);
  if (noteMatch !== null && noteMatch[1].length > 0) {
    return noteMatch[1].slice(0, 160);
  }
  if (t.indexOf('"ok":true') >= 0) {
    return '已安装';
  }
  return t.slice(0, 160);
}

function removeQuietly(path: string): void {
  try {
    fs.unlinkSync(path);
  } catch (e) {
    /* 删不掉不影响结论：Host 侧 1h 后会清理陈旧回执 */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve: () => void) => {
    setTimeout(() => resolve(), ms);
  });
}
