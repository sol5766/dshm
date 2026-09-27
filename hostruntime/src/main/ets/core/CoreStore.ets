/**
 * 端侧核心仓库（CoreStore）：把 tools/pack-core.mjs 产出的 zip 落成"可运行的某一版核心"，
 * 并维护"当前版本 / 上一版本"的状态与激活事务。
 *
 * 层级：`<filesDir>/dsh/`
 *   ├── cores/<version>/        已安装的核心树（内含 dshm-core.json 元数据）
 *   ├── cores/<version>.staging/  正在解包/校验，**未激活**（放在 cores 下是为了同文件系统 rename）
 *   ├── home/                   $DSH_HOME：会话/设置/凭据/工作区注册（**跨版本共享，唯一一份**）
 *   └── state.json              { current, previous, history }
 *
 * 纪律：
 *  1. 所有失败都返回 OpResult/Decision，**不抛异常给上层**（上层要能如实展示失败原因）；
 *  2. 任何"写 current"的动作都必须先过 Types.decideActivation 的健康检查判据；
 *  3. 解包失败/校验失败一律清掉 staging，绝不留半成品被误认为已安装；
 *  4. 永远不删 current 与 previous 对应的目录（见 Types.evictionCandidates）。
 *
 * 设计依据：docs/50-端侧核心运行架构.md §6.1。
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { zlib } from '@kit.BasicServicesKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { ActivationDecision, ActivationAction, CoreHealth, CoreState, CoreVersionRecord, decideActivation, decideRollback, emptyState, evictionCandidates, parseState, serializeState } from './Types';
import { TREE_INFO_FILE, isSafeVersion, topDirOf } from './Naming';

const TAG: string = 'DSHM-CoreStore';
const DOMAIN: number = 0x0000;

/**
 * 端侧 profile 名（必须与 `DshHost.PROFILE` 一致）。
 *
 * 这里单独定义是为了让**解包校验**能确认"树里带着可运行的 profile"；
 * 两处一旦漂移，`DshHost` 会在启动时找不到 profile 而报错，哨兵反而会先一步发现。
 */
const ON_DEVICE_PROFILE: string = 'ondevice';

export interface OpResult {
  ok: boolean;
  message: string;
}

function ok(message: string): OpResult {
  return { ok: true, message: message };
}

function fail(message: string): OpResult {
  return { ok: false, message: message };
}

/**
 * 树内清单里的一条插件行（打包器写入，判据见 `tools/lib/core-inventory.mjs`）。
 *
 * 【nativeKind 的判据是依赖闭包，不是"包里有 .node"】实测端侧核心的 6 个依赖原生的
 * 插件行**没有一个自带 .node**，它们全靠传递依赖摸到 koffi / node-pty / sharp。
 * 用"包内有没有 .node"当判据会把它们标成"纯 JS 可安装"，用户装完必然起不来。
 */
export interface CorePluginRow {
  id: string;
  name: string;
  bundle: string;
  disabled: boolean;
  /** `'PURE_JS' | 'NATIVE' | 'UNKNOWN'`（打包器取值，**不是** appstate 的枚举取值） */
  nativeKind: string;
  /** NATIVE 时非空：闭包内命中的原生包，用来向用户解释"为什么不能装" */
  nativeVia: string[];
}

export interface CorePluginTotals {
  pluginRows: number;
  pureJs: number;
  native: number;
  unknown: number;
  disabled: number;
}

/** 树内元数据（打包器写入 <top>/dshm-core.json）。字段全部按"可能缺失"处理。 */
export interface CoreTreeInfo {
  coreVersion: string;
  platform: string;
  profile: string;
  builtAt: string;
  /** 该版本要求的 Node 版本下限（来自配方）；空串表示未记录 */
  nodeFloor: string;
  /**
   * 打包时算好的插件清单。
   * **旧核心包没有这些字段**（清单是本轮才加进树里的），此时一律为空——
   * 空表示"这个包没带清单"，而不是"没有插件"，界面必须区分这两句话。
   */
  plugins: CorePluginRow[];
  pluginTotals: CorePluginTotals;
  nativePackages: string[];
}

/** 清单里的插件行 → 强类型行。逐字段校验：损坏的清单不能让整个核心状态读不出来。 */
function toPluginRows(raw: CorePluginRow[]): CorePluginRow[] {
  const out: CorePluginRow[] = [];
  if (!Array.isArray(raw)) {
    return out;
  }
  for (const r of raw) {
    if (r === null || r === undefined) {
      continue;
    }
    const id: string = typeof r.id === 'string' ? r.id : '';
    const name: string = typeof r.name === 'string' ? r.name : '';
    if (id.length === 0 && name.length === 0) {
      continue;
    }
    out.push({
      id: id,
      name: name,
      bundle: typeof r.bundle === 'string' ? r.bundle : '',
      disabled: r.disabled === true,
      nativeKind: typeof r.nativeKind === 'string' ? r.nativeKind : 'UNKNOWN',
      nativeVia: Array.isArray(r.nativeVia) ? r.nativeVia : [],
    });
  }
  return out;
}

function toTotals(raw: CorePluginTotals, rowCount: number): CorePluginTotals {
  if (raw === null || raw === undefined) {
    return { pluginRows: rowCount, pureJs: 0, native: 0, unknown: 0, disabled: 0 };
  }
  const num = (v: number): number => (typeof v === 'number' && v >= 0 ? v : 0);
  return {
    pluginRows: num(raw.pluginRows),
    pureJs: num(raw.pureJs),
    native: num(raw.native),
    unknown: num(raw.unknown),
    disabled: num(raw.disabled),
  };
}

export class CoreStore {
  private readonly filesDir: string;

  constructor(filesDir: string) {
    this.filesDir = filesDir;
  }

  // ── 路径 ──────────────────────────────────────────────────────────────
  baseDir(): string {
    return `${this.filesDir}/dsh`;
  }

  coresDir(): string {
    return `${this.baseDir()}/cores`;
  }

  coreDir(version: string): string {
    return `${this.coresDir()}/${version}`;
  }

  stagingDir(version: string): string {
    return `${this.coresDir()}/${version}.staging`;
  }

  /** $DSH_HOME：**跨版本共享的唯一一份用户数据**。 */
  homeDir(): string {
    return `${this.baseDir()}/home`;
  }

  statePath(): string {
    return `${this.baseDir()}/state.json`;
  }

  treeInfoPath(version: string): string {
    return `${this.coreDir(version)}/${TREE_INFO_FILE}`;
  }

  // ── 布局 ──────────────────────────────────────────────────────────────
  /**
   * 建立端侧核心目录（幂等）。
   *
   * 【为什么必须先判存在】OHOS 的 `fs.mkdirSync(path, true)` 与 Node 的
   * `recursive: true` **语义不同**：目标目录**已存在**时它会抛
   * `13900015 File exists`，而不是静默成功。实测症状（真机）：
   *     DSHM-AUTO 安装内置核心：installed=[] note=建立端侧核心目录失败：13900015 File exists
   *     DSHM-AUTO 启动 Host：ok=false   note=建立端侧核心目录失败：13900015 File exists
   * 而安装与启动**都会**调它（第 2 次起必然失败）——一个"幂等"的布局步骤不能这样。
   */
  ensureLayout(): OpResult {
    try {
      if (!fs.accessSync(this.coresDir())) {
        fs.mkdirSync(this.coresDir(), true);
      }
      if (!fs.accessSync(this.homeDir())) {
        fs.mkdirSync(this.homeDir(), true);
      }
      return ok(`布局就绪：${this.baseDir()}`);
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      return fail(`建立端侧核心目录失败：${err.code} ${err.message}`);
    }
  }

  // ── 状态 ──────────────────────────────────────────────────────────────
  readState(): CoreState {
    try {
      if (!fs.accessSync(this.statePath())) {
        return emptyState();
      }
      return parseState(fs.readTextSync(this.statePath()));
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      hilog.warn(DOMAIN, TAG, '读 state.json 失败，按"从未激活"处理：%{public}s', `${err.code} ${err.message}`);
      return emptyState();
    }
  }

  private writeState(state: CoreState): OpResult {
    try {
      const file: fs.File = fs.openSync(this.statePath(), fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      try {
        fs.writeSync(file.fd, serializeState(state));
      } finally {
        fs.closeSync(file);
      }
      return ok('state.json 已写入');
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      return fail(`写 state.json 失败：${err.code} ${err.message}`);
    }
  }

  // ── 已安装版本 ────────────────────────────────────────────────────────
  /** 列出已安装版本。`.staging` 与 `.tmp` 后缀的目录**不算**已安装。 */
  listInstalled(): string[] {
    const out: string[] = [];
    try {
      if (!fs.accessSync(this.coresDir())) {
        return out;
      }
      const names: string[] = fs.listFileSync(this.coresDir());
      for (const name of names) {
        if (name.endsWith('.staging') || name.endsWith('.tmp')) {
          continue;
        }
        if (!isSafeVersion(name)) {
          continue;
        }
        if (!fs.statSync(this.coreDir(name)).isDirectory()) {
          continue;
        }
        out.push(name);
      }
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      hilog.warn(DOMAIN, TAG, '列已安装版本失败：%{public}s', `${err.code} ${err.message}`);
    }
    return out;
  }

  /**
   * 读树内元数据。
   *
   * 【为什么这里要认得"没有清单"】插件清单是本轮才由打包器写进树里的，
   * 设备上可能还装着上一版（没有该字段）的核心包。此时返回空清单——
   * 空清单 ≠ "没有插件"，界面必须把"这个包没带清单"与"插件为零"分开说。
   */
  readTreeInfo(version: string): CoreTreeInfo {
    const empty: CoreTreeInfo = {
      coreVersion: version,
      platform: '',
      profile: '',
      builtAt: '',
      nodeFloor: '',
      plugins: [],
      pluginTotals: { pluginRows: 0, pureJs: 0, native: 0, unknown: 0, disabled: 0 },
      nativePackages: [],
    };
    try {
      if (!fs.accessSync(this.treeInfoPath(version))) {
        return empty;
      }
      const raw = JSON.parse(fs.readTextSync(this.treeInfoPath(version))) as CoreTreeInfo;
      if (raw === null || raw === undefined) {
        return empty;
      }
      const plugins: CorePluginRow[] = toPluginRows(raw.plugins);
      return {
        coreVersion: typeof raw.coreVersion === 'string' ? raw.coreVersion : version,
        platform: typeof raw.platform === 'string' ? raw.platform : '',
        profile: typeof raw.profile === 'string' ? raw.profile : '',
        builtAt: typeof raw.builtAt === 'string' ? raw.builtAt : '',
        nodeFloor: typeof raw.nodeFloor === 'string' ? raw.nodeFloor : '',
        plugins: plugins,
        pluginTotals: toTotals(raw.pluginTotals, plugins.length),
        nativePackages: Array.isArray(raw.nativePackages) ? raw.nativePackages : [],
      };
    } catch (e) {
      return empty;
    }
  }

  /**
   * 已安装版本的展示记录。
   * 健康状态取自 state.json 的历史（当前版本视为 pass；其余按 unknown 处理——
   * **不编造**"曾经健康"这种无法验证的结论）。
   */
  installedRecords(): CoreVersionRecord[] {
    const state: CoreState = this.readState();
    const out: CoreVersionRecord[] = [];
    for (const v of this.listInstalled()) {
      const info: CoreTreeInfo = this.readTreeInfo(v);
      out.push({
        version: v,
        installedAt: info.builtAt,
        health: v === state.current ? CoreHealth.PASS : CoreHealth.UNKNOWN,
        healthNote: v === state.current ? '当前版本' : '',
        sha256: '',
      });
    }
    return out;
  }

  // ── 解包（stage）──────────────────────────────────────────────────────
  /**
   * 把容器解包并落成 `cores/<version>`。
   * 注意：本方法**只负责让它"存在且看起来完整"**，健康检查由调用方做，
   * 通过后才调用 activate()。这样"装上了"与"敢用它"是两件事。
   */
  async stageFromZip(zipPath: string, version: string): Promise<OpResult> {
    if (!isSafeVersion(version)) {
      return fail(`版本号不可用作目录名：${version}`);
    }
    const layout: OpResult = this.ensureLayout();
    if (!layout.ok) {
      return layout;
    }
    const staging: string = this.stagingDir(version);
    const target: string = this.coreDir(version);
    const inner: string = `${staging}/${topDirOf(version)}`;

    try {
      if (fs.accessSync(staging)) {
        // 残留的 staging 可能是上次失败留下的**完整树**：同样只能异步删（E47）
        await fs.rmdir(staging);
      }
      fs.mkdirSync(staging, true);
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      return fail(`准备 staging 目录失败：${err.code} ${err.message}`);
    }

    try {
      // 解压目标是**已存在的目录**（系统 API 要求），容器内的顶层目录会被创建在其下
      await zlib.decompressFile(zipPath, staging);
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      await this.dropStaging(staging);
      return fail(`解压失败：${err.code} ${err.message}`);
    }

    // 校验：顶层目录与元数据必须都在（否则这不是我们的容器，或解包不完整）
    try {
      if (!fs.accessSync(inner)) {
        await this.dropStaging(staging);
        return fail(`容器内缺少顶层目录 ${topDirOf(version)}`);
      }
      if (!fs.accessSync(`${inner}/${TREE_INFO_FILE}`)) {
        await this.dropStaging(staging);
        return fail(`容器内缺少元数据 ${TREE_INFO_FILE}`);
      }
      // 关键件哨兵：解压"成功"不等于树是完整的（E87）
      const sentinels: OpResult = this.verifyStagedTree(inner);
      if (!sentinels.ok) {
        await this.dropStaging(staging);
        return sentinels;
      }
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      await this.dropStaging(staging);
      return fail(`校验 staging 失败：${err.code} ${err.message}`);
    }

    // 落位：目标已存在时，只有"它不是当前运行版本"才允许替换
    const state: CoreState = this.readState();
    try {
      if (fs.accessSync(target)) {
        if (state.current === version) {
          await this.dropStaging(staging);
          return fail(`版本 ${version} 正在使用中，拒绝覆盖（请先切到别的版本）`);
        }
        // 旧树同样是"几万个文件"级别：异步删，别锁主线程（E47）
        await fs.rmdir(target);
      }
      fs.renameSync(inner, target);
      await fs.rmdir(staging);
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      await this.dropStaging(staging);
      return fail(`落位到 ${target} 失败：${err.code} ${err.message}`);
    }
    return ok(`已落位 ${version}`);
  }

  /**
   * 解包后的**关键件哨兵**校验（E87）：几件"缺了宿主必然起不来"的东西。
   *
   * 【为什么需要它，而不是"解压成功就算成功"】
   * `@ohos.zlib.decompressFile` 会校验每个条目的 CRC，所以"截断的 zip"通常在那一步就失败。
   * 但"解压成功、树却不对"仍有真实可能：容器不是我们的、打包时漏了某类文件、
   * 或磁盘空间不足时提前返回。这类失败的症状是最难查的一种——**装上了、也激活了，
   * 直到启动时才以"某个插件加载失败"的形态出现**，而用户看到的是"核心已安装却起不来"。
   *
   * 【为什么只挑几件，不做全树计数】全树 2.5 万个文件的遍历正是端侧要避免的事
   * （E45/E47 都是"同步大目录操作把 ArkUI 主线程锁死"）。哨兵只做几次 accessSync，
   * 代价可忽略，而它拦下的正是"树不完整"这一类。
   */
  private verifyStagedTree(inner: string): OpResult {
    let info: CoreTreeInfo;
    try {
      info = JSON.parse(fs.readTextSync(`${inner}/${TREE_INFO_FILE}`)) as CoreTreeInfo;
    } catch (e) {
      return fail(`树内元数据 ${TREE_INFO_FILE} 无法解析（容器不完整或不是我们的树）`);
    }
    if (info === null || info === undefined
      || typeof info.coreVersion !== 'string' || info.coreVersion.length === 0) {
      return fail(`树内元数据缺少 coreVersion`);
    }
    // 哨兵 1：宿主本体（profile-boot / dsh CLI 都在这个包里）
    if (!fs.accessSync(`${inner}/node_modules/@deepseek-ai/dsh/package.json`)) {
      return fail(`解包结果缺少宿主包 @deepseek-ai/dsh`);
    }
    // 哨兵 2：原生件 koffi（装错平台/漏拷时立刻暴露，而不是等模型跑第一转时才发现）
    let koffiFound: boolean = false;
    for (const abi of ['openharmony_arm64', 'linux_arm64']) {
      if (fs.accessSync(`${inner}/node_modules/koffi/build/koffi/${abi}/koffi.node`)) {
        koffiFound = true;
      }
    }
    if (!koffiFound) {
      return fail(`解包结果缺少原生件 koffi.node（abis 里一个都没有）`);
    }
    // 哨兵 3：端侧 profile（没有它 Host 起不到 webServer，见 D6 §5.3）
    if (!fs.accessSync(`${inner}/profiles/${ON_DEVICE_PROFILE}/cordis.patch.yml`)) {
      return fail(`解包结果缺少端侧 profile profiles/${ON_DEVICE_PROFILE}/cordis.patch.yml`);
    }
    return ok('关键件哨兵齐备');
  }

  private async dropStaging(staging: string): Promise<void> {
    try {
      if (fs.accessSync(staging)) {
        await fs.rmdir(staging);
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '清理 staging 失败（残留目录不会被当作已安装版本）');
    }
  }

  // ── 激活事务 ──────────────────────────────────────────────────────────
  /**
   * 激活：**只有健康检查为 PASS 才会写 current**（判据在 Types.decideActivation，可单测）。
   * 返回决策本身，调用方据此决定是否重启核心。
   */
  activate(candidate: string, health: string, note: string): ActivationDecision {
    const state: CoreState = this.readState();
    const decision: ActivationDecision = decideActivation(state, candidate, health, note);
    if (decision.action === ActivationAction.REFUSE) {
      hilog.warn(DOMAIN, TAG, '拒绝激活 %{public}s：%{public}s', candidate, decision.reason);
      return decision;
    }
    if (decision.next.current === state.current && decision.next.previous === state.previous) {
      return decision; // 幂等，不必写盘
    }
    const w: OpResult = this.writeState(decision.next);
    if (!w.ok) {
      return { action: ActivationAction.REFUSE, reason: `状态写入失败，保持原版本：${w.message}`, next: state };
    }
    return decision;
  }

  /** 回滚：当前版本启动失败时调用（判据在 Types.decideRollback，可单测）。 */
  rollback(): ActivationDecision {
    const state: CoreState = this.readState();
    const decision: ActivationDecision = decideRollback(state, this.listInstalled());
    if (decision.action === ActivationAction.REFUSE) {
      return decision;
    }
    const w: OpResult = this.writeState(decision.next);
    if (!w.ok) {
      return { action: ActivationAction.REFUSE, reason: `状态写入失败，保持原版本：${w.message}`, next: state };
    }
    return decision;
  }

  /** 清理旧版本；返回真正被删掉的版本号（current/previous 永不删）。 */
  async evict(keep: number): Promise<string[]> {
    const state: CoreState = this.readState();
    const removed: string[] = [];
    for (const v of evictionCandidates(state, this.listInstalled(), keep)) {
      try {
        // 一棵核心树是几万个文件：必须走异步删，否则会锁住 ArkUI 主线程（E47）
        await fs.rmdir(this.coreDir(v));
        removed.push(v);
      } catch (e) {
        const err: BusinessError = e as BusinessError;
        hilog.warn(DOMAIN, TAG, '删除旧版本 %{public}s 失败：%{public}s', v, `${err.code} ${err.message}`);
      }
    }
    return removed;
  }
}
