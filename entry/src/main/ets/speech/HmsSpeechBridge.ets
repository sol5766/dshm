/**
 * HMS 语音识别桥（ArkTS 侧）—— 把 Host 的识别请求转成 HMOS 系统语音识别。
 *
 * ── 为什么需要这座桥 ────────────────────────────────────────────────────
 * dsh 的语音 provider（`speechToText.register({ transcribe })`）跑在 **Host(Node)
 * 进程**里，而 HMOS 的 `speechRecognizer` 只在 **ArkTS 侧**可用
 * （`@kit.CoreSpeechKit` 是 ArkTS API）。两者之间没有直接调用通道，
 * 所以用**文件队列**当桥 —— 与项目既成的 `host-stop-request`、
 * `host-exit-mode`（EntryAbility）同一手法：可观察、失败留痕、无需改原生层。
 *
 * ── 协议 ────────────────────────────────────────────────────────────────
 * 目录：`$DSH_HOME/speech-to-text/hms-bridge/`
 *   · Host 写 `<id>.req` —— JSON `{ "audio": "<canonical WAV 的 base64>", "language": "zh-CN" }`
 *   · 本模块写 `<id>.done` —— JSON `{ "text": "识别结果" }`
 *   · 失败写 `<id>.fail` —— JSON `{ "error": "原因" }`
 * Host 侧对应实现见 `hostcore/speech-provider/index.js`。
 *
 * ── 为什么 `$DSH_HOME` 能推出来 ──────────────────────────────────────────
 * provider 的 `dataRoot` 配置是 `dshHomePath('speech-to-text', 'sensevoice')`
 * ⇒ `dataRoot = $DSH_HOME/speech-to-text/sensevoice`
 * ⇒ `$DSH_HOME = dirname(dirname(dataRoot))`。
 * 本模块侧则直接由 `filesDir` 拼：真机读数为
 * `$DSH_HOME = <filesDir>/dsh/home`（见 EntryAbility 的 host-exit-mode 路径）。
 * 两侧因此指向同一目录，且**都不需要新增配置项**。
 *
 * ── 已由真机验证的关键约束（写在最前面，避免重踩）────────────────────────
 * 1. **必须等 `onStart` 再 `writeAudio`**：接口签名是 `void`，看不出异步；
 *    不等就写会报 `1002200010 Write audio failed because the start listening is failed.`
 *    且 `onStart` 是在**报错之后**才到 ⇒ 整段音频被丢弃、识别返回空。
 * 2. **`onResult` 给的是累计文本**，不是增量片段 ⇒ 必须 merge 而非 `+=`，
 *    否则得到 "一一二一二三…" 这种重复串（真机踩过）。
 * 3. **`writeAudio` 只收 640 或 1280 字节**，而 WAV 数据长度不保证整除
 *    ⇒ `slicePcmChunks` 会切块并**丢弃不足一块的尾巴**（最多 639 字节 ≈ 20ms；
 *    整数秒录音的余数为 0，见 SpeechPcm 的门禁断言）。不足一块喂进去会被拒。
 * 4. **只支持 zh-CN**（`listLanguages()` 实测只返回 `["zh-CN"]`）。
 */

import { speechRecognizer } from '@kit.CoreSpeechKit';
// 方案 B：环形缓冲用 AudioCapturer 与 WebView 并行采集（见文件末尾 ring 区）
import { audio } from '@kit.AudioKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { common } from '@kit.AbilityKit';
import { SenseVoiceRecognizer } from './SenseVoiceRecognizer';
import {
  HMS_SAMPLE_RATE,
  HMS_CHUNK_BYTES,
  WAV_HEADER_BYTES,
  slicePcmChunks,
  mergeTranscript
} from 'appstate';

const DOMAIN: number = 0x0d5d;
const TAG: string = 'HdsmSpeechBridge';

/** 轮询间隔：500ms。识别是用户显式动作，这个延迟无感，又不至于空转太频繁。 */
const POLL_MS: number = 500;

/** 单次识别的总超时：20 秒（HMS 单会话上限 60 秒，留足余量）。 */
const RECOGNIZE_TIMEOUT_MS: number = 20000;

/**
 * 陈旧文件回收阈值。
 *
 * 【为什么是 10 分钟】它必须**大于**一次合法识别的最长耗时，否则会误删
 * 正在处理的请求。而 API 允许的录音最长 120 秒
 * （`api-speech-to-text` 的 `maxDurationSeconds` 默认 120），
 * ArkTS 按实时节奏送音频 ⇒ 送完约等于录音时长，再加引擎启动与收尾，
 * 最坏约 2.5 分钟。取 10 分钟留足余量，同时保证"卡死的队列"能在
 * 可接受时间内自愈。
 */
const STALE_MS: number = 600000;

/** 诊断日志的轮转阈值：超过就整体重写（避免在用户设备上无限增长）。 */
const MAX_HEARTBEAT_BYTES: number = 65536;

/** canonical 16k 单声道 PCM16 WAV 的固定头长度（定义在 appstate，两侧共用）。 */
const WAV_HEADER: number = WAV_HEADER_BYTES;

/**
 * 启动桥的轮询（幂等：重复调用只挂一个）。
 *
 * @param filesDir 应用的 `context.filesDir`（真机上即 `.../haps/entry/files`）
 * @param abilityCtx UIAbilityContext —— SenseVoice 要用它的 resourceManager 读 rawfile 模型。
 *        必须**由调用方显式传入**：本函数在 `EntryAbility.onCreate` 里被调，
 *        那个阶段 `getContext()` 拿不到可靠的 UIAbilityContext
 *        （它是给页面/组件用的 API，不是 Ability 生命周期里的通用取法）。
 * @returns 停止函数（目前仅用于测试；正式运行随进程存活）
 */
export function startHmsSpeechBridge(filesDir: string,
  abilityCtx?: common.UIAbilityContext): () => void {
  /* 创建 SenseVoice 识别器（用 UIAbilityContext 以便 resourceManager 读 rawfile 模型）。 */
  if (svRecognizer === undefined && abilityCtx !== undefined) {
    try {
      svRecognizer = new SenseVoiceRecognizer(abilityCtx);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'SenseVoice 实例创建失败: %{public}s', (e as Error).message);
    }
  }
  if (bridgeStarted) {
    return () => void 0;
  }
  bridgeStarted = true;
  const queueDir: string = `${filesDir}/dsh/home/speech-to-text/hms-bridge`;
  try {
    if (!fs.accessSync(queueDir)) {
      fs.mkdirSync(queueDir, true);
    }
  } catch (e) {
    // 首次调用时目录不存在，mkdir 即可；失败则每轮轮询时重试
  }
  hilog.info(DOMAIN, TAG, 'HMS 语音桥已就绪，队列=%{public}s', queueDir);

  /*
   * 心跳文件：落在 filesDir 根（`hdc shell cat` 可读，不受 hilog 滚动影响）。
   * 它回答"桥是否真的在轮询"—— 与"有没有请求"是两件事，必须分开可观测。
   */
  const heartbeat: string = `${filesDir}/hms-speech-bridge-heartbeat`;
  writeHeartbeat(heartbeat, `started dir=${queueDir}`);

  /*
   * 【预热 SenseVoice】把 230MB 模型的加载从"用户点麦克风那一刻"挪到空闲时。
   *
   * 【为什么必须做】provider 侧单次识别有预算（TIMEOUT_MS=25s，
   * 见 hostcore/speech-provider/index.js 的 awaitResult）。若不预热，
   * **第一次**点麦克风要在这 25 秒内完成"读 230MB rawfile + 建 session
   * + 初始化 VAD"，超时对用户表现为"识别超时"—— 是必然发生，不是概率问题。
   *
   * 【为什么不 await】不能让模型加载挡住桥的启动（桥要立刻开始轮询，
   * 否则请求会堆在队列里）；warmUp 内部先让出一次控制权，
   * 再在后台完成加载。失败只记日志，真正的错误留到 recognize() 如实抛出。
   */
  if (svRecognizer !== undefined) {
    /*
     * 【模型改为在线下载后，预热必须**等模型到位再重试**】
     *
     * 旧形态下模型随包内置（rawfile），桥一启动就能预热成功。
     * 现在模型由 host 侧在启动后**异步下载**（首启约 228MB），
     * 而桥启动通常早于下载完成 ⇒ 只预热一次必然是"失败"，
     * 之后**再没有任何时机**触发预热 ⇒ 用户第一次点麦克风时
     * 要在 25 秒预算里同时完成"读 228MB + 建 session + 初始化 VAD"
     * —— 那正是这段注释开头说的"必然超时"。
     *
     * 修法：按间隔重试预热，直到成功或超过窗口。间隔 3 秒、
     * 窗口 5 分钟（覆盖首启下载的常见时长）；成功后停止。
     * 每次尝试都写心跳，便于真机核对。
     */
    const WARM_RETRY_MS: number = 3000;
    const WARM_WINDOW_MS: number = 5 * 60 * 1000;
    const warmT0: number = Date.now();
    let warmAttempts: number = 0;
    const tryWarmUp = (): void => {
      if (svRecognizer === undefined) {
        return;
      }
      /*
       * 【先用轻量的 modelsReady() 探路】模型文件不在时直接重试，
       * 不去构建 OfflineRecognizer —— 后者在文件缺失时会走一遍
       * 失败路径（读路径、建 session 的失败开销），没必要反复付。
       * `modelsReady()` 只做 stat（判存在与非空），代价可忽略。
       */
      if (!svRecognizer.modelsReady()) {
        warmAttempts++;
        writeHeartbeat(heartbeat, `预热等待：模型尚未下载完（第${warmAttempts}次探测）`);
        if (Date.now() - warmT0 < WARM_WINDOW_MS) {
          setTimeout(tryWarmUp, WARM_RETRY_MS);
        } else {
          writeHeartbeat(heartbeat, '预热放弃：模型在 5 分钟内未就绪');
        }
        return;
      }
      warmAttempts++;
      svRecognizer.warmUp().then((ok: boolean): void => {
        writeHeartbeat(heartbeat,
          `预热${ok ? '成功' : '失败'} 模型已就绪=${ok} 第${warmAttempts}次`);
        if (!ok && Date.now() - warmT0 < WARM_WINDOW_MS) {
          setTimeout(tryWarmUp, WARM_RETRY_MS);
        }
      }).catch((e: Error): void => {
        hilog.warn(DOMAIN, TAG, '预热异常: %{public}s', e.message);
        if (Date.now() - warmT0 < WARM_WINDOW_MS) {
          setTimeout(tryWarmUp, WARM_RETRY_MS);
        }
      });
    };
    tryWarmUp();
  }

  /*
   * 串行处理：一次只跑一个识别。
   * 【为什么不用并发】HMS 的 `createEngine` 在同一设备上实例数有限，且
   * 用户一次只会说一句话；串行还能让"上一单没清干净"不至于互相干扰。
   */
  let busy: boolean = false;
  const timer: number = setInterval((): void => {
    pollTicks++;
    // 每 20 次（约 10 秒）刷新一次心跳：证明轮询活在跑
    if (pollTicks % 20 === 0) {
      writeHeartbeat(heartbeat, `alive ticks=${pollTicks} busy=${busy} lastSeen=${lastSeenAt}`);
    }
    if (busy) {
      return;
    }
    const req: BridgeRequest | undefined = takeNextRequest(queueDir);
    if (req === undefined) {
      return;
    }
    lastSeenAt = Date.now();
    writeHeartbeat(heartbeat, `got request id=${req.id} ticks=${pollTicks}`);
    busy = true;
    handleRequest(queueDir, req, heartbeat).then((): void => {
      busy = false;
      /*
       * 【成功也要落心跳 —— 修掉一个诊断盲点】
       * 最初只在"收到请求/异常"时写心跳，成功时什么都不写。后果：
       * 事后看心跳**无法区分**"识别成功"与"请求根本没被处理"（两者都停在 `alive`）。
       * 这次能确认成功，靠的是恰好抓到那一瞬间的 `.wip` 加上界面草稿里的文字 ——
       * 那是运气，不是可复现的观测。桥的每次结果都必须留下痕迹。
       */
      writeHeartbeat(heartbeat, `done id=${req.id} ticks=${pollTicks} text=${lastResult.slice(0, 60)}`);
    }, (e: Object): void => {
      busy = false;
      hilog.error(DOMAIN, TAG, '识别处理异常：%{public}s', String(e));
      writeHeartbeat(heartbeat, `handle error: ${String(e).slice(0, 120)}`);
    });
  }, POLL_MS);

  if (timer < 0) {
    hilog.error(DOMAIN, TAG, '轮询器未能启动');
  }
  return (): void => {
    clearInterval(timer);
    bridgeStarted = false;
  };
}

/** 模块级标志：主窗可能被复用重建，桥只挂一个。 */
let bridgeStarted: boolean = false;

/** 轮询计数：用于「桥是否真在跑」的可观测证据。 */
let pollTicks: number = 0;
/** 最近一次看到队列文件名的时间（毫秒），用于区分"无请求"与"桥没跑"。 */
let lastSeenAt: number = 0;
/** 最近一次识别的结果文本，供心跳留痕（区分"成功"与"没处理"）。 */
let lastResult: string = '';

/**
 * 追加一行到桥的诊断日志。
 *
 * 【为什么改成追加而不是覆盖 —— 修掉一个真实的观测缺陷】
 * 最初用 `TRUNC` 覆盖写，只保留"最后一行"。后果：`got request` / `done`
 * 这类关键事件在 10 秒内就被周期性的 `alive` 冲掉，事后只能看到
 * `alive ticks=320 lastSeen=...` —— 无法知道"那次请求成功了没有"。
 * 实测就吃了这个亏：确认识别成功靠的是**恰好抓到**一瞬间的 `.wip`
 * 加界面草稿，而不是日志里可复现的记录。改用 `APPEND` 后事件可回溯。
 *
 * 【为什么要截断】长期运行会无限增长（每 10 秒一行 ≈ 每天 8600 行）。
 * 超过 64KB 就整体重写，只留最后一次 `started` 之后的内容 —— 诊断够用，
 * 又不会在用户设备上无限占空间。
 */
function writeHeartbeat(path: string, detail: string): void {
  const line: string = `${new Date().toISOString()} ${detail}\n`;
  try {
    // 先看大小，超限就重写（重写时带上当前这行，避免丢事件）
    let size: number = 0;
    try {
      size = fs.statSync(path).size;
    } catch (e) {
      size = 0;   // 文件还不存在
    }
    if (size > MAX_HEARTBEAT_BYTES) {
      const f: fs.File = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      fs.writeSync(f.fd, `--- 日志超过 ${MAX_HEARTBEAT_BYTES}B，已轮转 ---\n${line}`);
      fs.closeSync(f);
      return;
    }
    const f: fs.File = fs.openSync(path, fs.OpenMode.WRITE_ONLY | fs.OpenMode.CREATE | fs.OpenMode.APPEND);
    fs.writeSync(f.fd, line);
    fs.closeSync(f);
  } catch (e) {
    // 诊断失败不影响主流程
  }
}

interface BridgeRequest {
  id: string;
  /** 处理中改名后的路径（`.wip`），处理完在 finally 里删掉 */
  wipPath: string;
  audioBase64: string;
}

/** Host 写的请求 JSON 的形状。 */
interface BridgeRequestPayload {
  audio: string;
  language?: string;
}

/** 音频质量指标（用于区分"音频坏了"与"引擎不行"）。 */
interface AudioMetrics {
  /** 时长（毫秒），按 16k 单声道 16bit 折算 */
  durationMs: number;
  /** 峰值幅度（0~32767） */
  peak: number;
  /** 均方根幅度 */
  rms: number;
  /** 静音样本占比（|样本| < 200 视为静音） */
  silenceRatio: number;
  /** 每秒零穿越次数（有效语音通常 500~3500；>4000 多为噪声） */
  zcrPerSec: number;
  /** 削顶样本占比（|样本| > 32000 视为削顶） */
  clipRatio: number;
}

/**
 * 统计一段 16 位单声道 PCM 的质量指标。
 *
 * 【为什么要这组指标】"识别率不对"有两种完全不同的原因，处理方式相反：
 *   · 音频坏了（采音/重采样问题）⇒ 改采音代码
 *   · 引擎能力不足 ⇒ 只能换识别方案
 * 凭感觉猜会改错东西。这组指标能把二者分开，且只需一次真机测试。
 */
function analyzePcm(pcm: Uint8Array): AudioMetrics {
  const samples: number = Math.floor(pcm.length / 2);
  if (samples === 0) {
    return { durationMs: 0, peak: 0, rms: 0, silenceRatio: 1, zcrPerSec: 0, clipRatio: 0 };
  }
  const view: DataView = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let peak: number = 0;
  let sumSq: number = 0;
  let silent: number = 0;
  let clipped: number = 0;
  let crossings: number = 0;
  let prev: number = view.getInt16(0, true);

  for (let i = 0; i < samples; i++) {
    const s: number = view.getInt16(i * 2, true);
    const a: number = s < 0 ? -s : s;
    if (a > peak) {
      peak = a;
    }
    sumSq += s * s;
    if (a < SILENCE_THRESHOLD) {
      silent++;
    }
    if (a > CLIP_THRESHOLD) {
      clipped++;
    }
    // 过零：符号变化即一次（忽略 0，避免抖动重复计数）
    if (i > 0 && ((prev < 0 && s >= 0) || (prev >= 0 && s < 0))) {
      crossings++;
    }
    prev = s;
  }

  const durationMs: number = Math.floor((samples * 1000) / HMS_SAMPLE_RATE);
  return {
    durationMs,
    peak,
    rms: Math.floor(Math.sqrt(sumSq / samples)),
    silenceRatio: silent / samples,
    zcrPerSec: durationMs > 0 ? Math.floor((crossings * 1000) / durationMs) : 0,
    clipRatio: clipped / samples,
  };
}

/** 静音判定阈值（16 位满量程 32767 的约 0.6%）。 */
const SILENCE_THRESHOLD: number = 200;
/** 削顶判定阈值（留约 2% 余量）。 */
const CLIP_THRESHOLD: number = 32000;

/**
 * 取下一个待处理请求（并按"取走即改名"避免重复处理）。
 *
 * 【为什么要改名而不是立即删除】若在读取后、处理前崩溃，`.req` 已删 ⇒ 请求
 * 永久丢失且 Host 端只会超时。改名成 `.wip` 让"处理中"可观察，失败时
 * 还能从 `.wip` 恢复排查线索（与 install-queue 的"取走即删"略有不同：
 * 那边的写入方是假壳、会自己超时退出；这边写入方是 Host 的 transcribe 调用，
 * 必须保证"要么拿到结果、要么明确失败"）。
 */
function takeNextRequest(queueDir: string): BridgeRequest | undefined {
  let names: string[];
  try {
    names = fs.listFileSync(queueDir);
  } catch (e) {
    return undefined;
  }
  // 顺带清理陈旧的 .wip / .done / .fail（写入方已死的残留）
  reapStale(queueDir, names);

  const reqs: string[] = names.filter((n: string): boolean => n.endsWith('.req')).sort();
  if (reqs.length === 0) {
    return undefined;
  }
  const name: string = reqs[0];
  const id: string = name.slice(0, -4);
  const reqPath: string = `${queueDir}/${name}`;
  let payload: string;
  try {
    payload = fs.readTextSync(reqPath);
  } catch (e) {
    return undefined; // 下轮再试
  }
  // 内容还没写完（Host 先建文件再写）⇒ 等下一轮
  if (payload.length === 0 || !payload.endsWith('}')) {
    return undefined;
  }
  const wipPath: string = `${queueDir}/${id}.wip`;
  try {
    fs.renameSync(reqPath, wipPath);
  } catch (e) {
    return undefined;
  }
  let audio: string = '';
  try {
    const parsed: BridgeRequestPayload = JSON.parse(payload) as BridgeRequestPayload;
    audio = parsed.audio;
  } catch (e) {
    writeResult(queueDir, id, true, `请求 JSON 解析失败：${(e as Error).message}`);
    return undefined;
  }
  if (audio === undefined || audio === null || audio.length === 0) {
    writeResult(queueDir, id, true, '请求里没有 audio 字段');
    return undefined;
  }
  return { id, wipPath, audioBase64: audio };
}

/** 清理陈旧中间文件（写入方已死的残留）。 */
function reapStale(queueDir: string, names: string[]): void {
  const now: number = Date.now();
  for (const n of names) {
    /*
     * 【必须包含 .req —— 这是审核时发现的一个真缺陷】
     * 原实现只清 `.wip/.done/.fail`，**不清 `.req`**。后果：
     * `takeNextRequest` 每轮取 `reqs.sort()[0]`；若那个 .req 内容不完整
     * （不以 `}` 结尾 —— Host 的"先写 .tmp 再改名"已尽量避免，但
     *  崩溃/断电/磁盘满仍可能留下半截文件），它会**每轮都返回 undefined**，
     * 而该 .req 既不满足新鲜度检查也不会被删 ⇒ **整个队列被永久堵死**，
     * 直到应用重启。用户表现是"语音按钮再也不动"。
     * 补上 .req 的陈旧回收即可自愈（5 分钟后自动放行）。
     */
    if (!(n.endsWith('.req') || n.endsWith('.wip') || n.endsWith('.done') || n.endsWith('.fail'))) {
      continue;
    }
    const p: string = `${queueDir}/${n}`;
    try {
      const st: fs.Stat = fs.statSync(p);
      if (now - st.mtime * 1000 > STALE_MS) {
        hilog.warn(DOMAIN, TAG, '回收陈旧文件：%{public}s', n);
        fs.unlinkSync(p);
      }
    } catch (e) {
      // 忽略：下轮再试
    }
  }
}

/** 处理一个请求：解 base64 → 剥 WAV 头 → 统计质量 → 喂 HMS → 回写结果。 */
/**
 * SenseVoice 识别器单例（有状态：持有 230MB 模型，必须复用）。
 *
 * 【为什么放模块级】`recognize(pcm)` 是无状态函数，而模型实例必须单例；
 * 由 `startHmsSpeechBridge` 创建、经参数传给 handleRequest。
 */
let svRecognizer: SenseVoiceRecognizer | undefined = undefined;

async function handleRequest(queueDir: string, req: BridgeRequest, heartbeatPath: string): Promise<void> {
  const t0: number = Date.now();
  try {
    const wav: Uint8Array = decodeBase64(req.audioBase64);
    /*
     * 剥掉 44 字节 canonical WAV 头，得到裸 PCM。
     * 头的布局已由上游逐字核实（ui-voice-input 的 encodeWave）：RIFF/WAVE/fmt(16)/
     * data，16kHz、单声道、16bit ⇒ 数据从第 44 字节起。
     * 【为什么在这里剥而不是让 HMS 吃 WAV】HMS 的 audioInfo 只接受裸 pcm。
     */
    if (wav.length <= WAV_HEADER) {
      writeResult(queueDir, req.id, true, `音频过短（${wav.length} 字节，连 WAV 头都不够）`);
      return;
    }
    const pcm: Uint8Array = wav.subarray(WAV_HEADER);

    /*
     * 【已移除 ring 优先逻辑】曾让此处优先用环形缓冲的音频，但它抢在
     * 「官方按钮 → client.js 覆盖 → 原生桥采集」之前换掉音频，掩盖了真正的通路
     * （表现为日志出现"改用环形音频"、而原生桥的 diag-native 永远为空）。
     * 现在直接使用官方传进来的音频 —— 那正是 client.js 覆盖后由原生桥采集的 WAV。
     */
    const usePcm: Uint8Array = pcm;
    const source: string = 'bridge';

    /*
     * 【音频质量测量 —— 定位"识别率不对"的根因】
     *
     * 背景（真机实测）：批次二十二用 AudioCapturer 直接 16k 采音，
     * 用户说「一二三四五六七」⇒ 识别 "1234567。"（**全对**）⇒ HMS 引擎本身是准的。
     * 而官方按钮这条路径多了一层 ArkWeb 内的
     * 「MediaRecorder(webm/opus) → decodeAudioData → OfflineAudioContext 重采样」，
     * 实测用户说「12342234」（8 位数字）只识别出一个「。」
     * ⇒ 问题极可能在这层，而不在引擎。
     *
     * 下面这组指标能把"音频坏了"与"引擎不行"分开：
     *   · peak 极低            ⇒ 音量太小 / 采到静音
     *   · peak 贴近满量程       ⇒ 削顶失真（波形被切平，识别会崩）
     *   · rms/peak 比值过低     ⇒ 大部分是静音，只有少量尖峰（噪声或断裂）
     *   · 零穿越率异常高(>4000) ⇒ 高频噪声，不是有效语音
     *   · 时长与录音不符        ⇒ 重采样把音频拉伸/截断
     */
    const metrics: AudioMetrics = analyzePcm(usePcm);
    const audioLine: string =
      `audio src=${source} pcm=${usePcm.length}B ms=${metrics.durationMs} peak=${metrics.peak} rms=${metrics.rms}`
      + ` silence=${(metrics.silenceRatio * 100).toFixed(0)}% zcr=${metrics.zcrPerSec}`
      + ` clipped=${(metrics.clipRatio * 100).toFixed(1)}%`;
    hilog.info(DOMAIN, TAG, '收到识别请求 id=%{public}s %{public}s', req.id, audioLine);
    writeHeartbeat(heartbeatPath, `${audioLine} id=${req.id}`);

    /*
     * 把原始 WAV 落盘供 PC 侧分析（WAV 里的头能直接读出采样率/声道/位深，
     * 这是判断"重采样是否真的产出 16k"最硬的证据）。
     * 只保留最近一次，避免在用户设备上堆积。
     * 用 openSync/writeSync（ArkTS 的 fileIo **没有** writeFileSync）。
     */
    try {
      const df: fs.File = fs.openSync(`${queueDir}/last-audio.wav`,
        fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      fs.writeSync(df.fd, wav.buffer as ArrayBuffer);
      fs.closeSync(df);
    } catch (e) {
      // 诊断用，失败不影响识别
    }

    const asrLogPath: string = heartbeatPath + '-asr';
    asrLog(asrLogPath, `开始识别 pcm=${usePcm.length}B src=${source}`);
    /*
     * 【识别后端：SenseVoice 优先】
     * SenseVoice 是离线批处理模型，没有 HMS 那种"单会话只吃 4~5s"的
     * VAD 截断问题（真机七轮实测：HMS ≥6s 近乎全灭）。
     */
    let text: string = '';
    if (svRecognizer !== undefined) {
      asrLog(asrLogPath, `改用 SenseVoice pcm=${usePcm.length}B`);
      text = await svRecognizer.recognize(usePcm);
    } else {
      asrLog(asrLogPath, `SenseVoice 不可用，回退 HMS pcm=${usePcm.length}B`);
      text = await recognize(usePcm, asrLogPath);
    }
    lastResult = text;
    writeResult(queueDir, req.id, false, text);
    hilog.info(DOMAIN, TAG, '识别完成 id=%{public}s 用时=%{public}dms 文本=%{public}s',
      req.id, Date.now() - t0, text);
  } catch (e) {
    const err = e as BusinessError;
    lastResult = '';
    const reason: string = err.message ?? String(e);
    writeResult(queueDir, req.id, true, reason);
    hilog.error(DOMAIN, TAG, '识别失败 id=%{public}s 用时=%{public}dms 原因=%{public}s',
      req.id, Date.now() - t0, reason);
  } finally {
    try {
      fs.unlinkSync(req.wipPath);
    } catch (e) {
      // 忽略：陈旧回收会兜底
    }
  }
}

/**
 * 把 16k 单声道 PCM 喂给 HMS 并从累计回调里合并出最终文本。
 *
 * 真机踩过的三个坑都在这里体现（见文件头注释）：
 *   · 等 `onStart` 再 `writeAudio`；
 *   · `onResult` 是累计文本 ⇒ 用 `mergeTranscript`；
 *   · 只按 640 字节切片送（余数由 slicePcmChunks 丢弃，代价见其注释）。
 */
/**
 * 把 ASR 每一步写进可读文件。
 *
 * 【为什么必须落文件】此前 done text= 为空却查不出原因：onResult 没日志、
 * onError 只打 hilog（设备上抓不到）、超时也静默返回空。
 * 无法区分"引擎报错"、"没出结果"、"超时"⇒ 先补观测。
 */
function asrLog(path: string, line: string): void {
  if (path.length === 0) {
    return;
  }
  try {
    const f: fs.File = fs.openSync(path,
      fs.OpenMode.WRITE_ONLY | fs.OpenMode.CREATE | fs.OpenMode.APPEND);
    fs.writeSync(f.fd, `${new Date().toISOString()} ${line}\n`);
    fs.closeSync(f);
  } catch (e) {
    // 日志失败不影响识别
  }
}

async function recognize(pcm: Uint8Array, logPath: string): Promise<string> {
  let engine: speechRecognizer.SpeechRecognitionEngine | undefined = undefined;
  let transcript: string = '';
  let started: boolean = false;
  let finished: boolean = false;
  const sessionId: string = `dshm-bridge-${Date.now()}`;

  try {
    engine = await speechRecognizer.createEngine({
      language: 'zh-CN',
      online: 1
      /*
       * 【不要设 recognizerMode 为 long —— 它会让引擎的 VAD 失效】
       *
       * 已由真机数据证实（同一份音频、同一套代码，唯一变化就是这个参数）：
       *
       *   | 时间   | recognizerMode | onEvent（VAD 事件）       | 结果            |
       *   |--------|----------------|--------------------------|-----------------|
       *   | 11:09  | 未设（默认）   | —                        | "234。" ✓       |
       *   | 11:15  | 未设（默认）   | —                        | "子234。" ✓     |
       *   | 11:20  | ★ 改成 long    | ★ 一条都没有             | —               |
       *   | 11:21+ | long           | ★ 一条都没有             | 连续 5 次空 ✗   |
       *   | 12:33  | ★ 移除回默认   | ★ speech started/stopped | "12342234。" ✓  |
       *
       * 【机制】onEvent 是 HMS 报告 VAD（语音活动检测）事件的回调。
       * 设 long 期间 onEvent **一条都不出现** ⇒ 引擎的 VAD 没有工作
       * ⇒ 引擎无法判断"哪里有语音" ⇒ 整段被判无语音（输出空，或只出一个句号）。
       * 移除该参数后 onEvent code=1 speech started / code=3 speech stopped
       * 立刻出现，识别随即完全正确。
       *
       * 【排错代价记录】这个参数让我误判方向很久，因为它"看起来无害"：
       * 文档（@hms.ai.speechRecognizer.d.ts:288-291）只列了 short/long 可选、
       * **未说明 long 的语义**。期间我怀疑过音频、采样率、传输链、调用路径、
       * 采集时序，全部被实测排除（音频频谱正常、sha256 传输一致、
       * A/B 两条识别路径结果完全相同）。真正的分界点只有这一个参数。
       * ⇒ 教训：改动能回退时，**先回退再继续排查**。
       */
    } as speechRecognizer.CreateEngineParams);

    engine.setListener({
      onStart: (sid: string, msg: string): void => {
        started = true;
      },
      /*
       * onEvent：HMS 通过它报告 VAD 事件（speech started / stopped）。
       *
       * 【这是 SDK 定义的 5 个回调之一】见 @hms.ai.speechRecognizer.d.ts:217
       * （RecognitionListener: onStart / onEvent / onResult / onComplete / onError）。
       * **不是可选的诊断代码** —— 清理时我曾误删它，导致识别全部为空。
       *
       * 【为什么关键】若不注册此回调，引擎可能不启用 VAD ⇒ 无法判定"哪里有语音"
       * ⇒ 整段被判无语音，表现为连续的空白 isFinal。
       */
      onEvent: (sid: string, code: number, msg: string): void => {
        asrLog(logPath, `onEvent code=${code} msg=${msg}`);
      },
      onResult: (sid: string, result: speechRecognizer.SpeechRecognitionResult): void => {
        // 累计文本：必须 merge，不能 +=
        transcript = mergeTranscript(transcript, result.result, result.isFinal, result.isLast);
        asrLog(logPath, `onResult raw="${result.result}" isFinal=${result.isFinal} isLast=${result.isLast} mergedLen=${transcript.length}`);
      },
      onComplete: (sid: string, msg: string): void => {
        finished = true;
      },
      onError: (sid: string, code: number, msg: string): void => {
        finished = true;
        asrLog(logPath, `★ onError code=${code} msg=${msg}`);
        hilog.warn(DOMAIN, TAG, 'HMS onError code=%{public}d msg=%{public}s', code, msg);
      }
    } as speechRecognizer.RecognitionListener);

    engine.startListening({
      sessionId: sessionId,
      audioInfo: {
        audioType: 'pcm',
        sampleRate: HMS_SAMPLE_RATE,
        soundChannel: 1,
        sampleBit: 16
      } as speechRecognizer.AudioInfo
    } as speechRecognizer.StartParams);

    // ① 等 onStart（实测 ~200ms 内到）。不等就 writeAudio 会报 1002200010。
    const startDeadline: number = Date.now() + 2000;
    while (!started && Date.now() < startDeadline) {
      await sleep(20);
    }
    if (!started) {
      throw new Error('HMS 引擎未在 2 秒内进入 onStart（无法送音频）');
    }

    // ② 按 640 字节切片送，且不丢余数
    const chunks: Uint8Array[] = slicePcmChunks(pcm, HMS_CHUNK_BYTES);
    for (const chunk of chunks) {
      // 识别已结束就不再送（否则报 1002200010，且真实集成时会白耗 CPU）
      if (finished) {
        break;
      }
      engine.writeAudio(sessionId, chunk);
      // 640B = 20ms 音频；按实时节奏送，过快可能被丢弃
      await sleep(20);
    }
    engine.finish(sessionId);

    // ③ 等最终结果（onComplete / onError 会置 finished）
    const deadline: number = Date.now() + RECOGNIZE_TIMEOUT_MS;
    while (!finished && Date.now() < deadline) {
      await sleep(50);
    }
    asrLog(logPath, `结束 finished=${finished} len=${transcript.length}${finished ? '' : '（超时）'}`);
    return transcript;
  } finally {
    if (engine !== undefined) {
      try {
        engine.shutdown();
      } catch (e) {
        // 忽略
      }
    }
  }
}

/** 把结果写成 `<id>.done` / `<id>.fail`（原子性：先写 .tmp 再改名）。 */
function writeResult(queueDir: string, id: string, failed: boolean, detail: string): void {
  const suffix: string = failed ? '.fail' : '.done';
  const payload: string = failed
    ? JSON.stringify({ error: detail })
    : JSON.stringify({ text: detail });
  const tmp: string = `${queueDir}/${id}.tmp`;
  const dest: string = `${queueDir}/${id}${suffix}`;
  try {
    const f: fs.File = fs.openSync(tmp, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
    fs.writeSync(f.fd, payload);
    fs.closeSync(f);
    /*
     * 先写 .tmp 再改名：Host 侧一旦看到 .done/.fail 就会读全文，
     * 若直接写目标名，可能读到写了一半的内容（改成短文件后概率低但不为零）。
     */
    fs.renameSync(tmp, dest);
  } catch (e) {
    hilog.error(DOMAIN, TAG, '写结果失败 %{public}s：%{public}s', dest, String(e));
  }
}

/** base64 → 字节（用 util.Base64Helper，避免手写解码器）。 */
function decodeBase64(text: string): Uint8Array {
  const helper: util.Base64Helper = new util.Base64Helper();
  return helper.decodeSync(text);
}

/** 极简 sleep（ArkTS 无内置 promise 版 sleep）。 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve: () => void): void => {
    setTimeout(resolve, ms);
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * 环形缓冲采集（方案 B）：与 WebView 的 getUserMedia **并行**采一路 16k PCM。
 *
 * 【为什么】官方按钮的音频链（getUserMedia→MediaRecorder→重采样）产出的音频
 * 识别不准（真机实测：说「12342234」只得「。」），而同设备的 AudioCapturer
 * 直采总是识别正确。官方 UI 的"按钮/录音/插入"都可用，坏的只有音频 ⇒
 * 让 provider 忽略 WebView 传来的音频，改用这一路。
 *
 * 【时序】ArkWeb 在页面调 getUserMedia 时会触发 onPermissionRequest；
 * 那一刻正是官方开始录音，于是这里同步启动采集。transcribe() 到达时
 * （= 用户点停止）取缓冲里的音频。
 *
 * 【唯一未知数】AudioCapturer 与 getUserMedia 能否同时持有麦克风。
 * 结果写进心跳：bytes>0 即可并行；为 0 说明独占，需退化为"停止后再录"。
 * ──────────────────────────────────────────────────────────────────────── */

/** 环形缓冲：最多保留 30 秒（30 × 32000 字节）。 */
const RING_MAX_BYTES: number = 30 * 32000;
