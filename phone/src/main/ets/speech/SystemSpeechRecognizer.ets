/**
 * 系统语音识别会话（HarmonyOS Core Speech Kit 的**单引擎**封装）。
 *
 * ── 为什么要单独一层 ──────────────────────────────────────────────────────────
 * `speechRecognizer.createEngine()` 在同一设备上的并发实例有限，且引擎本身是**有状态**
 * 的（startListening 之后必须按 onStart → writeAudio → finish 的顺序走）。真实场景里同时
 * 会有两条来路：
 *   · 普通听写：Host 把整段 WAV 写进队列，桥一次喂完；
 *   · 会议模式：麦克风实时出块，边录边送。
 * 两者绝不能各自 `createEngine()` —— 第二实例要么创建失败，要么把第一路的音频串过去。
 * ⇒ 模块级 lease（`speechEngineBusy`）保证**同一进程只有一个活动引擎**，抢不到 lease
 *   的调用方立刻拿到可读错误，由上层提示"语音识别正被占用"。
 *
 * ── 模式语义（真机实测过，不要想当然）────────────────────────────────────────
 * `extraParams.recognizerMode` 只有 `short` / `long` 两个值。历史真机读数（见
 * HmsSpeechBridge 里那段长注释）：`long` 在**短音频回放**路径上会让 VAD 事件（onEvent）
 * 一条都不出现、整段判无语音。这正是本方案 Task 1「长语音 Go/No-Go」要重新验证的点：
 * 会议模式需要的是"持续说话 + 自然停顿"下的长会话，与"把一段已经录好的短音频喂进去"
 * 不是同一个场景。结论出来之前，普通听写保持 `short`（默认值，不传该参数）。
 *
 * ── 为什么这里自带一份合并状态 ────────────────────────────────────────────────
 * `onResult` 给的是**累计文本**（当前分句从开头累计），不是增量。直接 `text += result`
 * 会把整句重复 N 遍。合并语义见本文件的 `updateSpeechTranscript`（原 appstate/Meeting 纯逻辑迁入）。
 *
 * @module SystemSpeechRecognizer
 */
import { speechRecognizer } from '@kit.CoreSpeechKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

/*
 * 转写文本合并（`SpeechTranscriptState` / `emptySpeechTranscript` /
 * `updateSpeechTranscript`）。
 *
 * 【为什么内联在这里】这套纯逻辑原在 `appstate/model/Meeting.ets`（会议模式专用文件）。
 * 2026-10-31 剥离会议模式时删掉了那个文件，但**语音识别仍然要用它**：
 * 引擎会在同一个分句上反复回调累计文本，不去重就会把整句重复 N 遍。
 * 它本质是"识别结果的文本合并"，与会议无一字关系 —— 故改名并搬到唯一使用点，
 * 比留一个只为它存在的 `Meeting.ets` 更诚实。
 */
export interface SpeechTranscriptState {
  /** 已定稿的正文（多句之间以单个换行分隔） */
  committed: string;
  /** 当前分句（引擎尚未定稿的部分；final 之后清空） */
  live: string;
  /** 合并后的完整文本（= appendSegment(committed, live) 的缓存，UI 每帧只读一个值） */
  text: string;
}

/** 空转写状态（每次返回新对象：调用方会持有并逐次替换，不能共享同一个引用） */
export function emptySpeechTranscript(): SpeechTranscriptState {
  const empty: SpeechTranscriptState = { committed: '', live: '', text: '' };
  return empty;
}

/**
 * 把一段文本并入已定稿文本。
 *
 * 【判据顺序不能换】三种情况互相包含，换序就会丢字或重复：
 *   1. `committed === incoming` 或 `committed.endsWith(incoming)`：引擎回放了
 *      已定稿的尾部 ⇒ 不追加（去重的唯一去处）；
 *   2. `incoming.startsWith(committed)`：这是**累计文本**，已经包含已定稿部分
 *      ⇒ 用更完整的 incoming 取代（不能换行追加，否则整段重复）；
 *   3. 其余视为新的一句 ⇒ 换行追加。
 *
 * 空串在开头就返回：`''.startsWith('')` 为真、`'x'.endsWith('')` 也为真，
 * 不先挡掉会让"空结果"把既有正文替换成空。
 */
function appendSegment(committed: string, incoming: string): string {
  if (incoming.length === 0) {
    return committed;
  }
  if (committed.length === 0) {
    return incoming;
  }
  if (committed === incoming || committed.endsWith(incoming)) {
    return committed;
  }
  if (incoming.startsWith(committed)) {
    return incoming;
  }
  return `${committed}\n${incoming}`;
}

/**
 * 合并一次识别结果。
 *
 * @param previous 上一次的状态（首次传 `emptySpeechTranscript()`）
 * @param incoming 本次回调的完整文本（累计语义，不是增量片段）
 * @param isFinal 本次是否为该分句的最终结果
 * @returns 新状态；`incoming` 为空时**原样返回 previous**（不改引用，便于判"没变化"）
 */
export function updateSpeechTranscript(
  previous: SpeechTranscriptState,
  incoming: string,
  isFinal: boolean
): SpeechTranscriptState {
  if (incoming.length === 0) {
    /* 静音回调或 final 了空话：保留现状，用空串覆盖等于把已认出的字删掉 */
    return previous;
  }
  if (!isFinal) {
    const partial: SpeechTranscriptState = {
      committed: previous.committed,
      live: incoming,
      text: appendSegment(previous.committed, incoming)
    };
    return partial;
  }
  const committed: string = appendSegment(previous.committed, incoming);
  const finalState: SpeechTranscriptState = { committed: committed, live: '', text: committed };
  return finalState;
}



const DOMAIN: number = 0x0000;
const TAG: string = 'DSHM-Speech';

/** 认出模式：普通听写用 short；会议模式固定 long。 */
export type SystemSpeechMode = 'short' | 'long';

/**
 * 会话事件。
 *
 * @param live 当前分句（未定稿部分）
 * @param text 合并后的完整文本（已定稿 + 当前分句）
 */
export interface SystemSpeechEvents {
  onTranscript(live: string, text: string): void;
  onState(state: string, detail: string): void;
}

/** 进程内是否已有活动引擎（普通听写与会议模式互斥的唯一判据）。 */
let speechEngineBusy: boolean = false;

/**
 * 单个 long 会话的音频上限（字节）。
 *
 * 【真机实测 2026-10-18】`recognizerMode: 'long'` 能持续出结果，但**有硬上限**：
 * 送到 653,440 B（≈20.4 秒）时引擎报 `1002200003 Exceeded the maximum audio length
 * supported`，之后整段作废 —— 30 秒探针里后 10 秒一个字都没出。
 * ⇒ 会议模式必须**滚动会话**：接近上限就收尾（finish 拿定稿）再立刻开新会话，
 *    已定稿文本留在本类的 `state` 里跨会话累积。取 600,000 B（≈18.75s）留出余量，
 *    确保"检测到超限"永远发生在引擎自己报错之前。
 */
const ROTATE_AT_BYTES: number = 600000;

/** 给上层做"被占用"提示用（与 lease 同一真源）。 */
export function isSystemSpeechBusy(): boolean {
  return speechEngineBusy;
}

/**
 * 一次识别会话。**创建即不占资源**，真正占用发生在 `start()` 抢到 lease 之后。
 */
export class SystemSpeechRecognizer {
  private readonly mode: SystemSpeechMode;
  private readonly events: SystemSpeechEvents;
  private sessionId: string;
  private engine: speechRecognizer.SpeechRecognitionEngine | undefined = undefined;
  private started: boolean = false;
  private finished: boolean = false;
  private lastError: string = '';
  private state: SpeechTranscriptState = emptySpeechTranscript();
  /** 已送入引擎的音频字节数（诊断：0 说明"有请求没音频"而不是"引擎不行"）。 */
  private written: number = 0;

  constructor(mode: SystemSpeechMode, events: SystemSpeechEvents) {
    this.mode = mode;
    this.events = events;
    // sessionId 只允许字母/数字/下划线 ⇒ 不能带 '-' 以外的符号；时间戳 + 模式即可。
    this.sessionId = `dshm_${mode}_${Date.now()}`;
  }

  /** 当前合并文本（供 finish 超时后仍能拿到已定稿部分）。 */
  currentText(): string {
    return this.state.text;
  }

  /** 已送入引擎的音频字节数。 */
  writtenBytes(): number {
    return this.written;
  }

  /** 是否已经接近单会话上限（调用方应在下一块之前 `await rotate()`）。 */
  needsRotate(): boolean {
    return this.started && !this.finished && this.written >= ROTATE_AT_BYTES;
  }

  /**
   * 滚动会话：收尾当前引擎 → 立刻换新引擎继续听。
   *
   * 【为什么不是"出错再重连"】等到 `onError 1002200003` 时，引擎已经把这一段判废，
   * 最后 1~2 秒的语音会丢；主动在 18.75s 收尾能拿到完整定稿。
   * `state` 是跨会话累积的（见类注释），轮换不改变已识别文本。
   */
  async rotate(): Promise<void> {
    if (!this.started || this.finished) {
      return;
    }
    this.events.onState('rotate', `at=${this.written}B session=${this.sessionId}`);
    try {
      this.engine?.finish(this.sessionId);
    } catch (e) {
      // 收尾调用失败也要继续换新会话，否则会议直接卡死
    }
    const deadline: number = Date.now() + 3000;
    while (!this.finished && Date.now() < deadline) {
      await sleep(50);
    }
    this.shutdownEngine();
    this.started = false;
    this.finished = false;
    this.written = 0;
    // 新会话必须换 sessionId（同 id 复用会被引擎当作"上一段还没结束"拒绝）
    this.sessionId = `dshm_${this.mode}_${Date.now()}`;
    await this.createAndStart();
    this.events.onState('rotated', `session=${this.sessionId}`);
  }

  /**
   * 创建引擎、挂监听、`startListening` 并等 `onStart`。
   *
   * 顺序不能换：先 `setListener` 再 `startListening`（否则首个 onStart 会丢），
   * 等 `onStart` 之后才允许 `writeAudio`（否则报 1002200010）。
   */
  async start(): Promise<void> {
    if (speechEngineBusy) {
      throw new Error('语音识别正被占用（会议模式或另一次听写进行中）');
    }
    speechEngineBusy = true;
    try {
      await this.createAndStart();
      this.events.onState('started', `mode=${this.mode} session=${this.sessionId}`);
    } catch (e) {
      // 任何失败都要把 lease 还回去，否则本进程再也起不了识别。
      this.release();
      throw e as Error;
    }
  }

  /**
   * 恢复（会议"暂停 → 继续"用）：`finish()` 已释放 lease 与引擎，这里重开会话。
   *
   * 与 `start()` 的差别只有"清掉上一次的终态"：`release()` 会把 `finished` 置真，
   * 而 `writePcm()` 见到 `finished` 就整块丢弃 ⇒ 必须显式复位，否则恢复后
   * 识别静默全空（这类"看起来在录、其实一个字不进"的坑只在真机上暴露过）。
   */
  async resume(): Promise<void> {
    if (this.engine !== undefined) {
      // 还在跑就不用重开（调用方可能连点两次"继续"）
      return;
    }
    this.finished = false;
    this.started = false;
    this.written = 0;
    this.sessionId = `dshm_${this.mode}_${Date.now()}`;
    await this.start();
  }

  /**
   * 送一块 PCM 并自动处理轮换（会议模式用它，而不是裸 `writePcm`）。
   *
   * 到 18.75s 上限前主动 `rotate()`（见 ROTATE_AT_BYTES），避免引擎自己报
   * `1002200003` 后把最后一段判废。
   */
  async appendPcm(chunk: Uint8Array): Promise<void> {
    if (this.needsRotate()) {
      await this.rotate();
    }
    this.writePcm(chunk);
  }

  /** 创建引擎 → 挂监听 → startListening → 等 onStart（start 与 rotate 共用）。 */
  private async createAndStart(): Promise<void> {
    /*
     * 只有 long 才写入 recognizerMode。
     * 【为什么 short 不显式传】默认值就是 short；显式写 `recognizerMode: 'short'`
     * 在老版本 SDK 上会走"未知模式"分支（offline 引擎只认默认与 long）。
     */
    const params: speechRecognizer.CreateEngineParams = {
      language: 'zh-CN',
      online: 1
    };
    if (this.mode === 'long') {
      const extra: Record<string, Object> = {};
      extra.locate = 'CN';
      extra.recognizerMode = 'long';
      params.extraParams = extra;
    } else {
      const extraShort: Record<string, Object> = {};
      extraShort.locate = 'CN';
      params.extraParams = extraShort;
    }
    this.engine = await speechRecognizer.createEngine(params);
    this.attachListener();
    this.engine.startListening({
      sessionId: this.sessionId,
      audioInfo: {
        audioType: 'pcm',
        sampleRate: 16000,
        soundChannel: 1,
        sampleBit: 16
      } as speechRecognizer.AudioInfo
    } as speechRecognizer.StartParams);
    const deadline: number = Date.now() + 3000;
    while (!this.started && Date.now() < deadline) {
      await sleep(20);
    }
    if (!this.started) {
      throw new Error('系统语音引擎未在 3 秒内进入 onStart');
    }
  }

  /** 关掉当前引擎（不释放 lease、不动 state）。 */
  private shutdownEngine(): void {
    const engine: speechRecognizer.SpeechRecognitionEngine | undefined = this.engine;
    this.engine = undefined;
    if (engine !== undefined) {
      try {
        engine.shutdown();
      } catch (e) {
        // shutdown 失败不改变结论
      }
    }
  }

  /**
   * 送一块 PCM（16k / 单声道 / S16LE）。
   *
   * @param chunk 640 或 1280 字节；其它长度按"取前 640 的整数倍"送，尾块由调用方在结束时补齐。
   */
  writePcm(chunk: Uint8Array): void {
    if (!this.started || this.finished || this.engine === undefined) {
      return;
    }
    if (chunk.length === 0) {
      return;
    }
    /*
     * 【必须拷贝成"恰好这一块"的独立数组 —— 2026-10-18 真机踩到】
     * 直接送 `pcm.subarray(off, off+640)` 会被引擎当成**整个底层 ArrayBuffer**
     * （忽略 byteOffset/byteLength）来读：听写链路于是喂进去一堆错位字节，
     * 表现是 `onResult` 全空、`len=0`，而同一段音频在探针里（每次新建 640 数组）
     * 识别完全正常。拷贝一次 640B 的代价可以忽略，换来的是"送什么就识别什么"。
     */
    const len: number = chunk.length > 1280 ? 1280 : chunk.length;
    const send: Uint8Array = new Uint8Array(len);
    send.set(chunk.subarray(0, len));
    try {
      this.engine.writeAudio(this.sessionId, send);
      this.written += send.length;
    } catch (e) {
      const err = e as BusinessError;
      this.lastError = `writeAudio 失败 code=${err.code} ${err.message}`;
      hilog.warn(DOMAIN, TAG, '%{public}s', this.lastError);
    }
  }

  /**
   * 结束并等待定稿。
   *
   * @param timeoutMs 等 onComplete/onError 的上限；超时返回**已收到的**文本（不丢数据）。
   */
  async finish(timeoutMs: number = 12000): Promise<string> {
    if (this.engine === undefined) {
      this.release();
      return this.state.text;
    }
    try {
      this.engine.finish(this.sessionId);
    } catch (e) {
      const err = e as BusinessError;
      hilog.warn(DOMAIN, TAG, 'finish 调用失败 code=%{public}d', err.code);
    }
    const deadline: number = Date.now() + Math.max(1000, timeoutMs);
    while (!this.finished && Date.now() < deadline) {
      await sleep(50);
    }
    const text: string = this.state.text;
    this.events.onState(this.finished ? 'complete' : 'finish-timeout',
      `len=${text.length} written=${this.written}${this.lastError.length > 0 ? ' err=' + this.lastError : ''}`);
    this.release();
    return text;
  }

  /** 取消（会议"关闭并放弃"路径）：cancel + shutdown + 释放 lease。 */
  cancel(): void {
    try {
      if (this.engine !== undefined && this.started) {
        this.engine.cancel(this.sessionId);
      }
    } catch (e) {
      // 取消路径不求成功，只求释放
    }
    this.release();
  }

  /** 释放引擎与 lease（幂等）。 */
  release(): void {
    const engine: speechRecognizer.SpeechRecognitionEngine | undefined = this.engine;
    this.engine = undefined;
    this.started = false;
    this.finished = true;
    if (engine !== undefined) {
      try {
        engine.shutdown();
      } catch (e) {
        // shutdown 失败不改变结论：本进程不再引用它
      }
    }
    speechEngineBusy = false;
  }

  /** 挂五个回调；缺 onEvent 会让引擎不启用 VAD（历史真机教训）。 */
  private attachListener(): void {
    const engine: speechRecognizer.SpeechRecognitionEngine | undefined = this.engine;
    if (engine === undefined) {
      return;
    }
    engine.setListener({
      onStart: (sid: string, msg: string): void => {
        this.started = true;
        this.events.onState('onStart', msg);
      },
      onEvent: (sid: string, code: number, msg: string): void => {
        this.events.onState('onEvent', `code=${code} ${msg}`);
      },
      onResult: (sid: string, result: speechRecognizer.SpeechRecognitionResult): void => {
        this.state = updateSpeechTranscript(this.state, result.result, result.isFinal === true);
        this.events.onTranscript(this.state.live, this.state.text);
      },
      onComplete: (sid: string, msg: string): void => {
        this.finished = true;
        this.events.onState('onComplete', msg);
      },
      onError: (sid: string, code: number, msg: string): void => {
        this.finished = true;
        this.lastError = `onError code=${code} ${msg}`;
        this.events.onState('onError', this.lastError);
      }
    } as speechRecognizer.RecognitionListener);
  }
}

/** 极简 sleep（ArkTS 无内置 promise 版）。 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve: () => void): void => {
    setTimeout(resolve, ms);
  });
}
