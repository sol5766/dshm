/**
 * 启动分段标记（对照 WorkBuddy 的 A–F 六阶段，见 `docs/201-WorkBuddy启动加载顺序拆解与借鉴.md` §3-P2）。
 *
 * 【为什么要有它】启动慢但不知道慢在哪一段，任何优化都无法验收。本模块只做一件**极轻**的事：
 * 在启动关键点各打一条带双时间戳（相对本进程 + 绝对 epoch）的标记，追加写 JSONL，
 * 同时打一条 W 级 hilog（端侧日志只保留 W 及以上，见 EntryAbility 的 DSHM-TRACE 注释）。
 *
 * 【为什么不做成通用日志框架】它必须能在 `onCreate` 第一行、任何依赖初始化之前工作：
 * 不依赖 AppStorage、不依赖 preferences、不依赖 Host。因此只用 `fileIo` + `hilog` 两个系统能力，
 * 且所有失败静默——**埋点绝不允许影响启动**。
 *
 * 【阶段口径】与 WorkBuddy 对齐但按鸿蒙实际命名：
 *   S0 进程/能力入口 → S1 静态配置完成 → S2 窗口阶段就绪 → S3 首帧（loadContent 回调）
 *   → S4 宿主链调度 → S5 宿主就绪（URL 已发布）→ S6 Web 页面加载 → S7 首屏可交互。
 *
 * 【幂等】同一 id 只记第一次（WorkBuddy 的 C8 重复打点就是缺这一层，见 §4.4）。
 *
 * 【summary 时机】只在 `finish()`（S7 或失败终态）写，不在流早期 flush——WorkBuddy 的
 * summary 早 flush 导致 `phases` 为空，是明确的反例。
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { process } from '@kit.ArkTS';

const DOMAIN: number = 0x0000;
const TAG: string = 'DSHM-STARTUP';

/** 启动阶段。字符串值与 JSONL 里的 `phase` 字段一致，便于直接筛。 */
export enum StartupPhase {
  PROCESS = 'S_process',
  ABILITY = 'S_ability',
  WINDOW = 'S_window',
  FIRST_FRAME = 'S_first_frame',
  HOST = 'S_host',
  WEB = 'S_web',
  READY = 'S_ready'
}

/** 单条标记。字段刻意少而稳定：够还原时间轴即可，不塞业务数据。 */
interface StartupMarkLine {
  id: string;
  phase: string;
  key: string;
  proc: string;
  pid: number;
  /** 相对本次启动 origin 的毫秒数（浮点，不取整——取整会让连续多拍看起来像卡住） */
  ts: number;
  /** 绝对时间，用于与 hilog / 其它进程日志对齐 */
  epochMs: number;
  boot: string;
  extra: string;
}

/** 汇总行：带各段耗时，避免事后自己算。 */
interface StartupSummaryLine {
  id: string;
  phase: string;
  key: string;
  proc: string;
  pid: number;
  ts: number;
  epochMs: number;
  boot: string;
  extra: string;
  totalMs: number;
  spans: string;
}

/** 汇总时的固定输出顺序（与阶段口径一致）。 */
const PHASE_ORDER: string[] = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'];

class StartupRecorder {
  private originMs: number = 0;
  private bootId: string = '';
  private filePath: string = '';
  private seen: Set<string> = new Set<string>();
  private firstTs: Map<string, number> = new Map<string, number>();
  private lastMs: number = 0;
  private finished: boolean = false;
  private writeFailed: boolean = false;

  /**
   * 绑定日志目录。必须在第一个 `mark()` 之前调用；重复调用无副作用（幂等）。
   *
   * @param filesDir 应用 `filesDir`（沙箱内、hdc 可取回；cacheDir 对 hdc 不可读）
   */
  init(filesDir: string): void {
    if (this.originMs > 0) {
      return;
    }
    this.originMs = Date.now();
    this.lastMs = 0;
    this.bootId = `${this.originMs.toString(36)}-${Math.floor(Math.random() * 1000000).toString(36)}`;
    if (filesDir.length === 0) {
      return;
    }
    try {
      const dir: string = `${filesDir}/dsh/logs/startup`;
      if (!fs.accessSync(dir)) {
        fs.mkdirSync(dir, true);
      }
      this.filePath = `${dir}/${this.originMs}-${process.pid}.jsonl`;
    } catch (err) {
      // 目录建不出来只降级为「仅 hilog」，不影响启动
      this.writeFailed = true;
      hilog.warn(DOMAIN, TAG, 'DSHM-STARTUP 日志目录不可用（降级为仅 hilog）：%{public}s',
        JSON.stringify(err));
    }
  }

  /**
   * 打一条标记。未 `init()` 时只打 hilog（调用方可能在任何时机调用）。
   *
   * @param id    固定短 id（S0–S7），同时作为幂等键
   * @param phase 阶段枚举
   * @param key   可读的事件名（英文短横线风格，与项目 hilog 习惯一致）
   * @param extra 可选补充（计数、路径、原因），不要放凭据
   */
  mark(id: string, phase: StartupPhase, key: string, extra: string = ''): void {
    if (this.seen.has(id)) {
      return;
    }
    this.seen.add(id);
    const now: number = Date.now();
    const ts: number = this.originMs > 0 ? now - this.originMs : 0;
    const delta: number = ts - this.lastMs;
    this.lastMs = ts;
    this.firstTs.set(id, ts);
    hilog.warn(DOMAIN, TAG, 'DSHM-STARTUP %{public}s +%{public}dms (Δ%{public}dms) %{public}s%{public}s',
      id, ts, delta, key, extra.length > 0 ? ` ${extra}` : '');
    if (this.filePath.length === 0 || this.writeFailed) {
      return;
    }
    const line: StartupMarkLine = {
      id: id,
      phase: String(phase),
      key: key,
      proc: 'arkts',
      pid: process.pid,
      ts: ts,
      epochMs: now,
      boot: this.bootId,
      extra: extra
    };
    this.writeLine(JSON.stringify(line));
  }

  /**
   * 写汇总并落盘。只在终态调用一次（S7 就绪，或明确失败）。
   *
   * 【为什么不早写】早期写会把后续标记排除在外，得到 `phases` 为空的假汇总
   * （WorkBuddy 实测缺陷，见 docs/201 §4.4）。
   */
  finish(reason: string): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    const now: number = Date.now();
    const ts: number = this.originMs > 0 ? now - this.originMs : 0;
    let spans: string = '';
    let prev: number = -1;
    for (const id of PHASE_ORDER) {
      const at: number | undefined = this.firstTs.get(id);
      if (at === undefined) {
        continue;
      }
      if (prev >= 0) {
        spans += `${spans.length > 0 ? ';' : ''}${id}:${Math.round(at - prev)}`;
      }
      prev = at;
    }
    hilog.warn(DOMAIN, TAG, 'DSHM-STARTUP finish total=%{public}dms reason=%{public}s spans=%{public}s',
      ts, reason, spans);
    if (this.filePath.length === 0 || this.writeFailed) {
      return;
    }
    const summary: StartupSummaryLine = {
      id: 'SUMMARY',
      phase: 'S_summary',
      key: reason,
      proc: 'arkts',
      pid: process.pid,
      ts: ts,
      epochMs: now,
      boot: this.bootId,
      extra: '',
      totalMs: ts,
      spans: spans
    };
    this.writeLine(JSON.stringify(summary));
  }

  /** 本次启动的 bootId（用于把同一进程的多条日志串起来）。 */
  id(): string {
    return this.bootId;
  }

  private writeLine(line: string): void {
    try {
      const file: fs.File = fs.openSync(this.filePath,
        fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.APPEND);
      try {
        fs.writeSync(file.fd, line + '\n');
      } finally {
        fs.closeSync(file);
      }
    } catch (err) {
      // 只失败一次就停写，避免每条标记都抛一次
      this.writeFailed = true;
      hilog.warn(DOMAIN, TAG, 'DSHM-STARTUP 写盘失败（转仅 hilog）：%{public}s', JSON.stringify(err));
    }
  }
}

/** 进程内单例。启动埋点天然只有一个时间轴。 */
export const startupMarks: StartupRecorder = new StartupRecorder();
