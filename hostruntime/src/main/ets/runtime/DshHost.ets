/**
 * 端侧核心的生命周期（DshHost）—— 把「核心版本仓库」与「运行时载体」合成一个可查询的状态。
 *
 * 它对外只给两样东西：
 *   - `status()`：现在处于什么状态、为什么、下一步是什么（**不含任何猜测值**）
 *   - `start()/stop()`：起停核心，失败时返回可读原因而不是抛异常给 UI
 *
 * 状态机的设计要点（对应核心页的阶段徽标）：
 *   未接线 (UNWIRED)  运行时载体还没接上 —— 这是当前的真实状态，不是错误
 *   未安装 (EMPTY)    载体有了，但一个核心版本都没装
 *   待启动 (IDLE)     已安装、未运行
 *   就绪   (READY)    已启动且健康检查通过
 *   解包中 / 启动中    瞬态，由操作设置
 *   降级 / 失败        由运行结果设置
 *
 * 分层：本层不依赖 appstate / UI；核心页的阶段由 appstate 的
 * `corePhaseOfHostState()` 映射（纯函数，可单测）。
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { ActivationDecision, ActivationAction, CoreHealth, CoreState, CoreVersionRecord } from '../core/Types';
import { CoreStore, CorePluginRow, CorePluginTotals, CoreTreeInfo, OpResult } from '../core/CoreStore';
import { newestVersion } from '../core/Naming';
import { BundledInstallResult, installBundledCores } from '../core/BundledCore';
import { UserPluginRow, clearUserRows, readUserRows, writeUserRows } from '../core/PluginRows';
import { HostHandle, NativeFact, RuntimePort, RuntimeProbe, RuntimeKind } from '../runtime/RuntimePort';

const DOMAIN: number = 0x0000;
const TAG: string = 'DSHM-DshHost';

/**
 * 入口脚本写进 `host-ready.json` 的**实测运行时事实**（E88）。
 *
 * 【为什么由宿主自己报】Node 版本、`process.platform/arch`、是否真的 jitless、
 * `node:zlib` 有没有 zstd、三个硬原生依赖能不能加载——这些只有宿主进程内部知道，
 * 而 ArkTS 侧的原生模块只暴露 `runtimeVersion/startHost/isHostRunning/stopHost`。
 * 于是核心页上那几项长期写着「未探测」：**那是对的**（不猜），但现在有了一份实测来源。
 */
interface HostReadyNative {
  name: string;
  ok: boolean;
  note: string;
}

interface HostReadyRuntime {
  nodeVersion: string;
  platform: string;
  jitless: boolean;
  zstd: boolean;
  listenAddress: string;
  natives: HostReadyNative[];
}

interface HostReadyFile {
  /** 入口脚本写下的本机启动链接（含 token） */
  url?: string;
  /** 入口脚本准备好的**可写工作区**（E98：建会话时传给 Host，避免默认工作区落在 `/`） */
  workspace?: string;
  runtime?: HostReadyRuntime;
}

/** 端侧 Host 的状态。字符串值与 appstate 的 CorePhase 一一对应（映射见 appstate）。 */
export enum HostState {
  UNWIRED = 'unwired',
  EMPTY = 'empty',
  EXTRACTING = 'extracting',
  IDLE = 'idle',
  STARTING = 'starting',
  READY = 'ready',
  DEGRADED = 'degraded',
  FAILED = 'failed',
}

/**
 * 插件清单的报告（核心页的插件分区用）。
 *
 * 【为什么带 version 和 note】清单是**某个已安装版本**的属性，不是全局事实。
 * 只给一个数组会让界面无法回答"这是哪一版的插件"。而 note 用来区分两件不同的事：
 * "这个核心包里没有清单"（早于清单内嵌的旧包）与"清单里插件为零"。
 */
export interface HostPluginReport {
  /** 清单来自哪个已安装版本；空串表示没有可用清单 */
  version: string;
  rows: CorePluginRow[];
  totals: CorePluginTotals;
  nativePackages: string[];
  /** 清单为空时说明原因；非空时为空串 */
  note: string;
}

/** 状态快照。全部字段都是"事实或空值"，没有默认假值。 */
export interface HostStatus {
  state: HostState;
  /** 一句话原因/结论（用于核心页标题下方） */
  note: string;
  installed: string[];
  currentVersion: string;
  previousVersion: string;
  profile: string;
  probe: RuntimeProbe;
  /** 已启动时的句柄；未启动为空 */
  handle: HostHandle | null;
  /** 插件清单（来自树内元数据，打包时算好；端侧不重新遍历目录） */
  plugins: HostPluginReport;
}

/** 瞬态状态（正在解包 / 正在启动）：核心页据此显示"进行中"并禁用会冲突的动作。 */
export function hostStateIsTransient(state: HostState): boolean {
  return state === HostState.EXTRACTING || state === HostState.STARTING;
}

export interface HostStartResult {
  ok: boolean;
  note: string;
  handle: HostHandle | null;
}

export class DshHost {
  /** 端侧使用的 profile 名（与 hostcore/profile/<name> 一致） */
  static readonly PROFILE: string = 'ondevice';

  private readonly store: CoreStore;
  private readonly port: RuntimePort;
  private handle: HostHandle | null = null;
  private transient: HostState | null = null;
  private lastFailureNote: string = '';

  constructor(filesDir: string, port: RuntimePort) {
    this.store = new CoreStore(filesDir);
    this.port = port;
  }

  store_(): CoreStore {
    return this.store;
  }

  runtimeLabel(): string {
    return this.port.label();
  }

  /** 查状态。**先探测运行时**——没接线就如实说未接线，不看仓库里有没有版本。 */
  async status(): Promise<HostStatus> {
    const probed: RuntimeProbe = await this.port.probe();
    // E88：宿主在跑时，用他自己写下的实测事实补齐 probe 里"只有宿主知道"的几项
    const probe: RuntimeProbe = this.mergeRuntimeFacts(probed);
    const state: CoreState = this.store.readState();
    const installed: string[] = this.store.listInstalled();

    let phase: HostState;
    let note: string;

    if (this.transient !== null) {
      phase = this.transient;
      note = this.lastFailureNote.length > 0 ? this.lastFailureNote : '正在进行中';
    } else if (!probe.available) {
      phase = HostState.UNWIRED;
      note = probe.note.length > 0 ? probe.note : `运行时载体（${this.port.label()}）尚未接线`;
    } else if (installed.length === 0) {
      phase = HostState.EMPTY;
      note = '运行时已就绪，但还没有安装任何核心版本';
    } else if (this.handle !== null || this.port.isRunning()) {
      // 【为什么必须带上 `port.isRunning()`】`handle` 是**本实例**的记忆，而 Host 是
      // 进程级事实：页面每次刷新都会 new 一个 DshHost，用 handle 判断就会在
      // "端口已经在监听"的情况下报"未启动"（端侧实测症状：端口通了，页面说没有启动核心）。
      phase = HostState.READY;
      note = '核心已在运行';
    } else if (this.lastFailureNote.length > 0) {
      phase = HostState.FAILED;
      note = this.lastFailureNote;
    } else {
      phase = HostState.IDLE;
      note = '核心已安装但未启动';
    }

    return {
      state: phase,
      note: note,
      installed: installed,
      currentVersion: state.current,
      previousVersion: state.previous,
      profile: DshHost.PROFILE,
      probe: probe,
      handle: this.handle,
      plugins: this.plugins(),
    };
  }

  /**
   * 把入口脚本落盘的**实测事实**并进 probe（E88）。规则：**已有的读数优先**。
   *
   * 【为什么必须判 isRunning 才读文件】`host-ready.json` 是**上一次启动**留下的文件：
   * 宿主没在跑时读它，等于把上一版核心的事实当成现在的事实——那正是本项目一直在拆的
   * "看似有值、其实错位"的坑。所以：没在跑就原样返回 probe（那几项如实保持"未探测"）。
   *
   * 【为什么原生件读数也带进来】koffi / sharp / node-pty 能不能加载，是"端侧核心能不能
   * 真正干活"的硬前提（图片附件、进程类工具都系在这上面）。把它显示出来，
   * 比留一句"未探测"有用得多，也让"端侧能力边界"这件事在界面上可见。
   */
  private mergeRuntimeFacts(probe: RuntimeProbe): RuntimeProbe {
    if (!this.port.isRunning()) {
      return probe;
    }
    const raw: HostReadyRuntime | undefined = this.readHostReadyRuntime();
    if (raw === undefined) {
      return probe;
    }
    const natives: NativeFact[] = [];
    for (const n of raw.natives) {
      natives.push({ name: n.name, loaded: n.ok, note: n.note });
    }
    return {
      kind: probe.kind,
      available: probe.available,
      note: probe.note,
      // Node 版本以原生模块的读数为准：那是"被链接进来的运行时"本身，
      // 而文件里的 process.version 是同一个进程的自述，两者一致时无差别，冲突时前者更硬。
      nodeVersion: probe.nodeVersion.length > 0 ? probe.nodeVersion : raw.nodeVersion,
      platform: probe.platform.length > 0 ? probe.platform : raw.platform,
      zstd: probe.zstd === null ? raw.zstd : probe.zstd,
      jitless: probe.jitless === null ? raw.jitless : probe.jitless,
      natives: probe.natives.length > 0 ? probe.natives : natives,
      listenAddress: probe.listenAddress.length > 0 ? probe.listenAddress : raw.listenAddress,
    };
  }

  /** 读 `<home>/host-ready.json` 里的 runtime 段；任何异常都返回 undefined（不猜）。 */
  private readHostReadyRuntime(): HostReadyRuntime | undefined {
    try {
      const p: string = `${this.store.homeDir()}/host-ready.json`;
      if (!fs.accessSync(p)) {
        return undefined;
      }
      const parsed = JSON.parse(fs.readTextSync(p)) as HostReadyFile;
      if (parsed === null || parsed === undefined || parsed.runtime === undefined) {
        return undefined;
      }
      return parsed.runtime;
    } catch (e) {
      return undefined;
    }
  }

  /** profile 目录（用户行的落点；dsh 读取的用户 patch 层也在这一层）。 */
  private profileDir(): string {
    return `${this.store.homeDir()}/profiles/${DshHost.PROFILE}`;
  }

  /**
   * 已保存的**用户启停**（端侧「插件」页写的那份覆盖）。
   *
   * 【为什么不能让调用方自己拼路径】用户行文件与 dsh 的 profile 分层是同一份契约
   * （`<profile 目录>/cordis.patch.yml` 的追加段），路径知识只应存在于 hostruntime。
   */
  userPluginRows(): UserPluginRow[] {
    return readUserRows(this.profileDir());
  }

  /**
   * 设置某一行的启停（写用户行文件）。
   *
   * 【为什么返回的话里必须带"重启生效"】dsh 的插件树在**启动时**挂载：文件改了但进程没重启，
   * 界面上的状态与运行中的事实会不一致。与其含糊其辞，不如把这件事写在结果里，
   * 由界面直接显示。
   */
  setPluginDisabled(id: string, disabled: boolean): OpResult {
    if (id.length === 0) {
      return { ok: false, message: '行 id 为空，无法设置' };
    }
    const rows: UserPluginRow[] = readUserRows(this.profileDir());
    const next: UserPluginRow[] = [];
    let found: boolean = false;
    for (const row of rows) {
      if (row.id === id) {
        next.push({ id: row.id, disabled: disabled });
        found = true;
      } else {
        next.push(row);
      }
    }
    if (!found) {
      next.push({ id: id, disabled: disabled });
    }
    const written: OpResult = writeUserRows(this.profileDir(), next);
    if (!written.ok) {
      return written;
    }
    return { ok: true, message: `${id} 已${disabled ? '禁用' : '启用'}；重启核心后生效` };
  }

  /** 恢复默认：清空用户启停（核心种子里的启停不受影响）。 */
  resetPluginRows(): OpResult {
    return clearUserRows(this.profileDir());
  }

  /**
   * 插件清单：取自**会被启动的那个版本**的树内元数据（选取规则与 start() 一致）。
   * 【为什么不聚合所有版本】清单回答的是"这一版装了什么"。把两个版本的插件混成一个列表，
   * 用户会以为设备上装着这一份合集——那是编造。
   * 【为什么端侧不自己扫】判据要沿依赖闭包走 518 个包 / 27000 余文件（实测规模）；
   * 而答案在打包那一刻就确定了，所以打包器算好写进树里，端侧只读一个小 JSON。
   */
  plugins(): HostPluginReport {
    const zero: CorePluginTotals = { pluginRows: 0, pureJs: 0, native: 0, unknown: 0, disabled: 0 };
    const installed: string[] = this.store.listInstalled();
    if (installed.length === 0) {
      return {
        version: '', rows: [], totals: zero, nativePackages: [],
        note: '还没有安装核心版本，因此没有插件清单',
      };
    }
    const state: CoreState = this.store.readState();
    // 【同 start()：不用 installed[0]】目录枚举顺序未定义；插件清单必须报告
    // **实际会启动的那棵树**（否则界面显示的插件清单与运行的不是同一棵树）。
    const target: string = state.current.length > 0 && installed.includes(state.current)
      ? state.current
      : newestVersion(installed);
    const info: CoreTreeInfo = this.store.readTreeInfo(target);
    if (info.plugins.length === 0) {
      return {
        version: target, rows: [], totals: info.pluginTotals, nativePackages: info.nativePackages,
        note: `核心 ${target} 的树内元数据不含插件清单（该包早于"清单随包内嵌"这一改动）；`
          + '重新安装一份较新的核心包即可显示。',
      };
    }
    /*
     * 把**用户启停**覆盖到清单上（E91）。
     *
     * 【为什么必须叠加】清单来自核心包（树内元数据），它只会说"这一版出厂时这一行是开还是关"；
     * 而用户刚在「插件」页改过的那一行，要**重启核心**才真正生效。如果不叠加，界面会显示
     * 出厂状态，用户会以为自己的改动没保存——那是界面在说谎。叠加之后，界面显示的是
     * "重启后会生效的状态"，与提示语（"重启核心后生效"）自洽。
     */
    const rows: CorePluginRow[] = info.plugins;
    const userRows: UserPluginRow[] = readUserRows(this.profileDir());
    if (userRows.length > 0) {
      const byId: Map<string, boolean> = new Map<string, boolean>();
      for (const userRow of userRows) {
        byId.set(userRow.id, userRow.disabled);
      }
      for (const row of rows) {
        const want: boolean | undefined = byId.get(row.id);
        if (want !== undefined) {
          row.disabled = want;
        }
      }
    }
    return {
      version: target,
      rows: rows,
      totals: info.pluginTotals,
      nativePackages: info.nativePackages,
      note: '',
    };
  }

  /**
   * 启动核心。
   * 目标版本的选取顺序：当前版本（若已安装）→ 第一个已安装版本。
   * **不做健康检查的臆测**：健康检查属于"起完之后能不能用"，由上层在拿到句柄后做。
   */
  async start(): Promise<HostStartResult> {
    /*
     * 【幂等：已经在跑就直接成功】原生层（`dshhost.cc`）只允许一个 Node 实例，重复启动会
     * 返回「运行时已经启动过」。那是**正确**的底层约束，但界面把它当失败横幅显示出来
     * （真机实测：核心页出现「启动失败：运行时已经启动过；同一进程只允许一个 Node 实例」），
     * 用户会以为核心坏了。而事实是"它本来就在跑"——这正是"启动"的期望结果。
     */
    if (this.port.isRunning()) {
      this.transient = null;
      this.lastFailureNote = '';
      return { ok: true, note: '核心已在运行', handle: this.handle };
    }
    const probe: RuntimeProbe = await this.port.probe();
    if (!probe.available) {
      const note: string = probe.note.length > 0 ? probe.note : '运行时载体尚未接线，无法启动核心';
      this.lastFailureNote = note;
      return { ok: false, note: note, handle: null };
    }
    const layout: OpResult = this.store.ensureLayout();
    if (!layout.ok) {
      this.lastFailureNote = layout.message;
      return { ok: false, note: layout.message, handle: null };
    }
    const installed: string[] = this.store.listInstalled();
    if (installed.length === 0) {
      const note: string = '还没有安装任何核心版本，无法启动';
      this.lastFailureNote = note;
      return { ok: false, note: note, handle: null };
    }
    const state: CoreState = this.store.readState();
    // 【为什么不是 installed[0]（2026-09-25 真机实证）】`listInstalled()` 返回的是
    // `fs.listFileSync()` 的**目录枚举顺序**，未定义。原先在"没有 state.current"时
    // 取 `installed[0]` ⇒ 启动哪棵树**碰运气**：真机上装了 rc.2 且解包成功，
    // 却仍启动 rc.1（枚举恰好把它排前面）。这解释了此前"升级后必须手工删旧树"的
    // 操作——那是**掩盖未定义行为**，不是设计。
    // ⇒ 语义明确为：有 current 且它还在 ⇒ 用它；否则 ⇒ 用**最新**的那棵。
    const target: string = state.current.length > 0 && installed.includes(state.current)
      ? state.current
      : newestVersion(installed);
    if (state.current.length > 0 && !installed.includes(state.current)) {
      hilog.warn(DOMAIN, TAG, 'state.current=%{public}s 已不在已安装列表，改用最新版 %{public}s',
        state.current, target);
    }

    this.transient = HostState.STARTING;
    this.lastFailureNote = '';
    this.clearStaleStopRequest();
    try {
      const handle: HostHandle = await this.port.start(
        this.store.coreDir(target), this.store.homeDir(), DshHost.PROFILE);
      this.handle = handle;
      this.transient = null;
      return { ok: true, note: `核心 ${target} 已启动`, handle: handle };
    } catch (e) {
      const err = e as Error;
      const note: string = `启动失败：${err.message}`;
      this.handle = null;
      this.transient = null;
      this.lastFailureNote = note;
      return { ok: false, note: note, handle: null };
    }
  }

  /**
   * **切换到某个已安装版本**（E92）：停当前 → 起候选做健康检查 → 通过才激活。
   *
   * 【为什么健康检查只能是"真的起一次"】`Types.decideActivation` 明确要求健康检查为
   * PASS，宁可停在旧版本也不把没验证过的核心设为当前。端侧不存在"静态检查就能证明
   * 这份核心能跑"的手段（原生件、profile 行、Node 版本都只有起来才知道），
   * 所以这里就把候选起一次、确认端口应答——**这就是健康检查**。
   *
   * 【失败路径为什么必须把旧版本起回来】切换失败后如果什么都不做，用户面对的是一台
   * "核心不跑了、界面说切换失败"的设备。停掉候选、把旧版本起回来，才叫"没切换成功
   * 但设备仍可用"。这条路径的每一步都写进返回文案，不吞掉任何原因。
   */
  async switchTo(version: string): Promise<OpResult> {
    const installed: string[] = this.store.listInstalled();
    if (!installed.includes(version)) {
      return { ok: false, message: `版本 ${version} 不在已安装列表里（${installed.length > 0 ? installed.join('、') : '空'}）` };
    }
    /*
     * 【E151：端侧切换改为"安排激活 + 重启应用生效"】
     *
     * 真机取证（E149）：`switchTo` 的健康检查是"把候选**真起一次**"，而同一进程内第二次
     * `node::Start` 会让进程 **SIGABRT**（libnode 在一个应用进程里只被设计为启动一次）。
     * 而激活本身只是 `store.activate()` **写状态** ⇒ 没必要在本进程里起候选：
     * 这里记录激活并明确告知"完全退出应用后重新打开生效"。
     * 下次启动时入口脚本读到的 `current` 就是新版本——与"切换成功"等价，
     * 只是把"重启"交给用户，而不是让应用崩掉。
     *
     * 宿主**未运行**时仍走原路径（那时"起一次"是本进程的第一次启动，不会崩）。
     */
    if (this.port.isRunning()) {
      const before: string = this.store.readState().current;
      if (before === version) {
        return { ok: true, message: `当前已是 ${version}，无需切换。` };
      }
      const decision: ActivationDecision = this.store.activate(version, CoreHealth.PASS,
        '端侧：同进程二次启动 Node 会崩，改为重启应用生效（E151）');
      if (decision.action === ActivationAction.REFUSE) {
        return { ok: false, message: `拒绝激活 ${version}：${decision.reason}` };
      }
      return {
        ok: true,
        message: `已安排切换到 ${version}（当前 ${before}）：请完全退出应用后重新打开，新版本即生效。`
      };
    }
const wasRunning: boolean = this.handle !== null || this.port.isRunning();
if (wasRunning) {
const stopped: OpResult = await this.stop('DshHost.switchCore：切换前停当前核心');
if (!stopped.ok) {
return { ok: false, message: `切换前必须停下当前核心，但停止失败：${stopped.message}` };
      }
      /*
       * 【必须确认它真的退了（E99）】原生层只允许一个 Node 实例；若上一个实例还在退出过程中，
       * 直接起候选会撞「运行时已经启动过」。这里如实等一次，等到就继续，等不到就**明确告诉
       * 用户稍后重试**，而不是把一个底层限制当作"切换失败"抛出去。
       */
      if (this.port.isRunning()) {
        return {
          ok: false,
          message: '上一个核心实例还在退出（原生层同一进程只允许一个 Node 实例），'
            + '请稍等几秒后重试切换。'
        };
      }
    }
    const currentBefore: string = this.store.readState().current;
    this.transient = HostState.STARTING;
    let candidate: HostHandle | null = null;
    let failure: string = '';
    try {
      candidate = await this.port.start(this.store.coreDir(version), this.store.homeDir(), DshHost.PROFILE);
      this.handle = candidate;
    } catch (e) {
      failure = (e as Error).message;
    }
    this.transient = null;

    if (candidate !== null) {
      const decision: ActivationDecision =
        this.store.activate(version, CoreHealth.PASS, '端侧已实起一次并确认端口应答');
      if (decision.action !== ActivationAction.REFUSE) {
        this.lastFailureNote = '';
        return { ok: true, message: `已切换到 ${version} 并已在运行（${decision.reason}）` };
      }
// 极少见：起得来但激活被拒（例如状态写盘失败）。此时**必须**把候选停下，
// 否则会出现"在跑的不是 current"这种自相矛盾的状态。
await this.stop('DshHost.switchCore：激活被拒后收掉候选');
      return { ok: false, message: `拒绝激活 ${version}：${decision.reason}` };
    }

    this.lastFailureNote = `候选 ${version} 启动失败：${failure}`;
    if (wasRunning && currentBefore.length > 0 && installed.includes(currentBefore)) {
      try {
        this.handle = await this.port.start(this.store.coreDir(currentBefore), this.store.homeDir(), DshHost.PROFILE);
        return { ok: false, message: `切换失败（${failure}）；已把 ${currentBefore} 起回来，当前仍是 ${currentBefore}` };
      } catch (e) {
        this.handle = null;
        return { ok: false, message: `切换失败（${failure}），且旧版本 ${currentBefore} 也起不来：${(e as Error).message}` };
      }
    }
    this.handle = null;
    return { ok: false, message: `切换失败：${failure}（未激活新版本，也没有可自动恢复的运行中版本）` };
  }

  /**
   * **回滚到上一版本**（E92）：停 → `rollback()`（判据在 `Types.decideRollback`）→ 起回滚后的版本。
   *
   * 【为什么不能只改状态】早先的实现只调 `rollback()` 写状态就完事，提示语还写着
   * "核心并未随之重启"——那是运行时还没接线时的旧事实。现在运行时是通的，
   * 只改状态会让界面显示的版本与**正在跑的**版本不一致：那种不一致比回滚失败更难查。
   */
  async rollbackTo(): Promise<OpResult> {
    /*
     * 【E152：与 switchTo 同一处置】回滚同样是"停旧 + 起新"，而端侧同一进程内第二次
     * `node::Start` 会 SIGABRT（E149/E151）。`store.rollback()` 只是**写状态** ⇒
     * 宿主在跑时不起候选，改为"**安排回滚 + 重启应用生效**"。
     * 宿主未运行（本次进程尚未启动 Node）时仍走原路径——那时起一次不会崩。
     */
    if (this.port.isRunning()) {
      const pendingDecision: ActivationDecision = this.store.rollback();
      if (pendingDecision.action === ActivationAction.REFUSE) {
        return { ok: false, message: `未回滚：${pendingDecision.reason}` };
      }
      return {
        ok: true,
        message: `已安排回滚到 ${pendingDecision.next.current}（退回的版本：${pendingDecision.next.previous}）：`
          + '请完全退出应用后重新打开，新版本即生效。'
      };
    }
const wasRunning: boolean = this.handle !== null || this.port.isRunning();
if (wasRunning) {
const stopped: OpResult = await this.stop('DshHost.rollbackTo：回滚前停当前核心');
if (!stopped.ok) {
return { ok: false, message: `回滚前停止当前核心失败：${stopped.message}` };
      }
      if (this.port.isRunning()) {
        return { ok: false, message: '上一个核心实例还在退出，请稍等几秒后重试回滚。' };
      }
    }
    const decision: ActivationDecision = this.store.rollback();
    if (decision.action === ActivationAction.REFUSE) {
      return { ok: false, message: `未回滚：${decision.reason}` };
    }
    const target: string = decision.next.current;
    this.transient = HostState.STARTING;
    try {
      this.handle = await this.port.start(this.store.coreDir(target), this.store.homeDir(), DshHost.PROFILE);
      this.transient = null;
      this.lastFailureNote = '';
      return { ok: true, message: `已回滚到 ${target} 并已在运行（退回的版本：${decision.next.previous}）` };
    } catch (e) {
      this.transient = null;
      this.handle = null;
      this.lastFailureNote = `回滚后启动 ${target} 失败：${(e as Error).message}`;
      return { ok: false, message: this.lastFailureNote };
    }
  }

  /**
   * 入口脚本刚写下的**本机启动链接**（含 token），用于核心重启后重新接入。
   *
   * 【为什么需要它】切换/回滚都会重启宿主，而 dsh **每个进程重新生成启动 token**
   * （cookie 也是绑进程的）：旧 token 立刻作废。不重新取一次，界面会停在"刚切完就掉线"，
   * 看上去像切换把连接弄坏了。取不到就返回空串——由调用方如实提示，不猜。
   */
  localHostReadyUrl(): string {
    try {
      const p: string = `${this.store.homeDir()}/host-ready.json`;
      if (!fs.accessSync(p)) {
        return '';
      }
      const parsed = JSON.parse(fs.readTextSync(p)) as HostReadyFile;
      const url: string | undefined = parsed.url;
      return typeof url === 'string' ? url : '';
    } catch (e) {
      return '';
    }
  }

  /**
   * 入口脚本准备好的**可写工作区**（E98）。
   *
   * 【为什么必须有】真机上建出来的会话 `cwd` 是 `/`（宿主进程的工作目录继承自应用进程），
   * 于是 `session/follow` 折叠工作区投影时抛 `…reading 'kind'`（用户看到的「轨迹流失败」），
   * `workspaceFiles/list` 也必然失败（`cannot list`）。客户端建会话时把这个沙箱目录显式传下去
   * 即可绕开。取不到就返回空串——那时**不传 `cwd`**（回到 Host 默认行为），不猜一个路径。
   */
  localHostWorkspace(): string {
    try {
      const p: string = `${this.store.homeDir()}/host-ready.json`;
      if (!fs.accessSync(p)) {
        return '';
      }
      const parsed = JSON.parse(fs.readTextSync(p)) as HostReadyFile;
      const ws: string | undefined = parsed.workspace;
      return typeof ws === 'string' ? ws : '';
    } catch (e) {
      return '';
    }
  }

  /**
   * 清掉**上一次退出遗留**的 `host-stop-request`（只在起核心之前调用）。
   *
   * 【为什么必须在起核心之前清】宿主启动时会挂一条 1.5 s 巡检（`hostcore/app/main.js`
   * 的停止通道）：**看到这个文件就当场关闭自己**。而应用退出是「写请求 → 进程被系统结束」，
   * 宿主常常来不及在 1.5 s 内消费掉它 —— 2026-10-06 真机实测：请求写于 `02:32:59.930`，
   * 下一次启动的宿主在 `02:33:39.806` 才读到它并立刻退出（`!! process.exit(0)：停止路径放行`）
   * ⇒ 表现为「应用刚起来核心就没了」，而且没有任何报错。
   *
   * 【为什么可以无条件清】停止请求只可能由**上一次**的生命写：走到这里时本次宿主还没起来，
   * 不存在「有人正在等我停」的语义；留着它唯一的效果就是让本次启动自杀。
   * 失败不抛：清不掉也不该挡住启动（宿主那边还有 1.5 s 巡检兜底）。
   */
  private clearStaleStopRequest(): void {
    const p: string = `${this.store.homeDir()}/host-stop-request`;
    try {
      if (!fs.accessSync(p)) {
        return;
      }
      fs.unlinkSync(p);
      hilog.warn(DOMAIN, TAG, '已清掉上次退出遗留的停止请求（不清会让本次启动被它当场关停）：%{public}s', p);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '清理遗留停止请求失败（继续启动）：%{public}s', (e as BusinessError).message);
    }
  }

/**
 * 停止核心（幂等）。
 *
 * 【诊断（E88）】`reason` 是**调用方的签名**，会被写进 `host-stop-request` 的内容里。
 * 宿主轮询到该文件时把内容拼进日志（见 `hostcore/app/main.js` 的停止通道），于是
 * 「哪条 ArkTS 路径按了停止键」在事后拉回的 `dshm-host.log` 里直接可读——
 * 这是「宿主自己干净退出（code=0）」三次现场里唯一缺失的读数。默认空串，不改变行为。
 */
async stop(reason: string = ''): Promise<OpResult> {
    /*
     * 协作式停止（E90）：先把"停止请求"落到 `$DSH_HOME`，再等运行时真的退出。
     *
     * 【为什么由这里写文件】`$DSH_HOME` 的布局是 CoreStore 的知识（`homeDir()`），
     * 机制层（NodeRuntime）不该重复这份知识；它只负责"等原生层确认 Node 结束了"。
     * 【失败时必须把文件清掉】留着请求文件会让**下一次启动**的宿主刚起来就自杀——
     * 那会变成一个"应用再也起不来、且没有任何报错"的故障，比停止失败本身糟得多。
     */
    const requestPath: string = `${this.store.homeDir()}/host-stop-request`;
    let wrote: boolean = false;
    try {
      const f: fs.File = fs.openSync(requestPath,
        fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
      try {
fs.writeSync(f.fd, `${Date.now()} ${reason}\n`);
      } finally {
        fs.closeSync(f);
      }
      wrote = true;
    } catch (e) {
      const err = e as BusinessError;
      hilog.warn(DOMAIN, TAG, '写停止请求失败（将继续尝试等待）：%{public}s', err.message);
    }
    try {
      await this.port.stop();
      this.handle = null;
      this.transient = null;
      this.lastFailureNote = '';
      return { ok: true, message: '核心已停止' };
    } catch (e) {
      const err = e as Error;
      if (wrote) {
        try {
          if (fs.accessSync(requestPath)) {
            fs.unlinkSync(requestPath);
          }
        } catch (e2) {
          // 清不掉也要留下痕迹：下一次启动前 `recoverOrphanLocks` 那类巡检可以考虑它
          hilog.warn(DOMAIN, TAG, '清理停止请求失败，请留意下次启动行为');
        }
      }
      this.lastFailureNote = `停止失败：${err.message}`;
      return { ok: false, message: this.lastFailureNote };
    }
  }

  /** 已安装版本的展示记录（转发仓库；核心页的"核心版本"分区用它）。 */
  records(): CoreVersionRecord[] {
    return this.store.installedRecords();
  }

  /**
   * 安装**随应用内置**的核心包（首启解包；幂等）。
   *
   * 与 start() 的关键区别：这一步**不需要运行时载体**——它只是把 zip 解包落位。
   * 因此运行时还没接线时也应当允许用户先装好（核心页据此把"安装内置核心"设为可用）。
   */
  async installBundled(resourceDir: string, workDir: string): Promise<BundledInstallResult> {
    this.transient = HostState.EXTRACTING;
    this.lastFailureNote = '';
    try {
      const result: BundledInstallResult = await installBundledCores(resourceDir, workDir, this.store);
      if (result.failed.length > 0) {
        this.lastFailureNote = result.note;
      }
      return result;
    } catch (e) {
      const err = e as Error;
      const note: string = `安装内置核心失败：${err.message}`;
      this.lastFailureNote = note;
      return { installed: [], skipped: [], failed: [note], note: note };
    } finally {
      this.transient = null;
    }
  }
}
