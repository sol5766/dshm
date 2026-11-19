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
 * 【2026-10-18 起】识别后端已换成 HarmonyOS Core Speech Kit（ArkTS 侧
 * `SystemSpeechRecognizer`），provider 不再下载/准备任何模型；
 * `dataRoot` 只剩“队列目录的父目录”这一个用途（协议未变）。
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
 *    ⇒ 现实现（`recognizeWithSystem`）把尾巴**补零到 640** 再送，不再丢弃
 *    （最多多 20ms 静音，比丢半个字好）；旧实现用 `slicePcmChunks` 直接丢尾巴。
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
import { SystemSpeechRecognizer } from './SystemSpeechRecognizer';
import type { SystemSpeechEvents } from './SystemSpeechRecognizer';
import {
  HMS_SAMPLE_RATE,
  HMS_CHUNK_BYTES,
  WAV_HEADER_BYTES,
  HMS_CHUNK_BYTES as CHUNK_BYTES
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
 * @param abilityCtx UIAbilityContext —— 探针要读 rawfile 语音样本；识别引擎本身不需要它。
 *        必须**由调用方显式传入**：本函数在 `EntryAbility.onCreate` 里被调，
 *        那个阶段 `getContext()` 拿不到可靠的 UIAbilityContext
 *        （它是给页面/组件用的 API，不是 Ability 生命周期里的通用取法）。
 * @returns 停止函数（目前仅用于测试；正式运行随进程存活）
 */
export function startHmsSpeechBridge(filesDir: string,
  abilityCtx?: common.UIAbilityContext): () => void {
  if (abilityCtx !== undefined) {
    bridgeAbilityCtx = abilityCtx;
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
    /* 探针优先于真实请求：探针是人工触发的诊断，队列里若有真实请求也先跑完探针
       （两者都要独占引擎，交叉跑只会互相干扰）。 */
    const probe: SpeechProbeRequest | undefined = probePending;
    if (probe !== undefined) {
      probePending = undefined;
      busy = true;
      writeHeartbeat(heartbeat, `probe start mode=${probe.mode} seconds=${probe.seconds}`);
      runSpeechProbe(filesDir, probe).then((): void => {
        busy = false;
        writeHeartbeat(heartbeat, 'probe done');
      }, (e: Object): void => {
        busy = false;
        writeHeartbeat(heartbeat, `probe error: ${String(e).slice(0, 160)}`);
      });
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

/* ── Task 1：长语音 Go/No-Go 探针（2026-10-18）────────────────────────────────
 *
 * 目的：在真机上回答"`recognizerMode: 'long'` 到底能不能持续出结果"。
 * 【为什么不用人对着麦克风说话】需要 10s / 30s / 5min 三段可复现样本，人声无法保证
 * 每次一致；改用**系统 TTS 离线合成中文 PCM**（16k/16bit/单声道），再按实时节奏喂给
 * 引擎 —— 音频内容、语速、停顿都可控，且完全自动，不需要任何交互页面。
 *
 * 触发：`aa start ... --ps dshProbe long --ps dshProbeSec 30`（EntryAbility 转成
 * 本模块的 `requestSpeechProbe`），由既有 200ms 轮询消费一次。
 * 产物：`files/diag-meeting-probe/probe-<mode>-<secs>s-<stamp>.log` 与 `.json`，
 *       含 onStart/onEvent/onResult/onComplete/onError 的毫秒时间线与最终文本。
 */
interface SpeechProbeRequest {
  mode: string;
  seconds: number;
}

let probePending: SpeechProbeRequest | undefined = undefined;

/**
 * 探针用的 UIAbilityContext（读 rawfile 里的离线语音样本）。
 *
 * 【为什么不在探针里临时取 context】ArkTS 的 `getContext()` 在 Ability 生命周期外
 * 拿不到可靠实例；`startHmsSpeechBridge` 本来就由 EntryAbility 显式传入，直接留一份。
 */
let bridgeAbilityCtx: common.UIAbilityContext | undefined = undefined;

/** 由 EntryAbility 在收到 `dshProbe` 启动参数时调用；同一时刻只保留最新一条。 */
export function requestSpeechProbe(mode: string, seconds: number): void {
  /*
   * 只认 long / short / dictation。
   *
   * 【为什么把 speak 下线（2026-10-19 用户反馈）】它是"设备外放 TTS 读 PROBE_TEXT"的自测模式，
   * 会把"今天我们讨论三个问题…"整段朗读出来；一旦某个启动参数里带着 dshProbe=speak，
   * 应用每次起来都会突然出声（用户原话"每次启动就开始播报…先去掉这个怪吓人的"）。
   * 自测已改用 rawfile 里的离线样本（`loadProbePcmFromRawfile`），完全静音 ⇒ 删掉出声那条路。
   * 未知模式一律忽略：绝不因为一个诊断参数让应用开口。
   */
  const normalized: string = mode === 'long' ? 'long' : (mode === 'dictation' ? 'dictation' : (mode === 'short' ? 'short' : ''));
  if (normalized.length === 0) {
    return;
  }
  probePending = {
    mode: normalized,
    seconds: Math.max(10, Math.min(300, Math.floor(seconds)))
  };
}

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

/** 处理一个请求：解 base64 → 剥 WAV 头 → 统计质量 → 系统识别 → 回写结果。 */
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
    asrLog(asrLogPath, `开始识别 pcm=${usePcm.length}B src=${source} audioMs=${metrics.durationMs}`);
    /*
     * 【识别后端：HarmonyOS Core Speech Kit（2026-10-18 起唯一后端）】
     * SenseVoice 的模型下载/预热/228MB 已随 hostcore/speech-provider 一并删除，
     * 端侧这里也不再创建它（否则"下载路径没了、代码还留着"只会制造静默坏分支）。
     *
     * 【为什么一律 long + 自动轮换，而不是方案里写的"≤55s 用 short"】
     * 真机实测（docs/194）：
     *   · short 在**第一次判停**时就收尾 —— 10s 音频只出 11 字，后面的句子全丢；
     *   · long 持续累计并按停顿切句，到 18.75s 由 appendPcm() 自动轮换、
     *     跨会话累积文本，整段录音（最长 120s）都能覆盖。
     * 听写用户一句话里带停顿是常态 ⇒ short 会静默丢字，不能用。
     */
    const text: string = await recognizeWithSystem(usePcm, asrLogPath);
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

/** 用系统语音识别把一段 PCM 转成文本（long + 自动轮换，见上方注释）。 */
async function recognizeWithSystem(pcm: Uint8Array, logPath: string): Promise<string> {
  const recognizer: SystemSpeechRecognizer =
    new SystemSpeechRecognizer('long', new BridgeSpeechEvents(logPath));
  /*
   * start() 抢不到 lease（会议模式正在录音）会抛"语音识别正被占用"。
   * 这条错误原样抛给 handleRequest ⇒ 走 .fail ⇒ provider 把它当人话显示，
   * 既不崩进程，也不会把用户听写静默丢掉。
   */
  await recognizer.start();
  try {
    /*
     * 按 640B 一块、20ms 节奏送（引擎只吃 640/1280 整块；实时节奏能避免灌爆内部缓冲）。
     * 尾块补零到 640 —— 旧实现用 slicePcmChunks 直接丢尾巴，最多丢 20ms 语音。
     */
    const usable: number = pcm.length - (pcm.length % CHUNK_BYTES);
    for (let off: number = 0; off < usable; off += CHUNK_BYTES) {
      await recognizer.appendPcm(pcm.subarray(off, off + CHUNK_BYTES));
      await sleep(20);
    }
    if (usable < pcm.length) {
      const tail: Uint8Array = new Uint8Array(CHUNK_BYTES);
      tail.set(pcm.subarray(usable), 0);
      await recognizer.appendPcm(tail);
    }
    // 120s 音频要几十次轮换，收尾预算给足；超时也会返回已定稿文本（不丢数据）
    const text: string = await recognizer.finish(30000);
    asrLog(logPath, `系统识别完成 written=${recognizer.writtenBytes()}B len=${text.length}`);
    return text;
  } finally {
    recognizer.release();
  }
}

/** 系统识别事件 → ASR 诊断文件（设备上没有 hilog 也不丢证据）。 */
class BridgeSpeechEvents implements SystemSpeechEvents {
  private readonly logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
  }

  onTranscript(live: string, text: string): void {
    asrLog(this.logPath, `onTranscript liveLen=${live.length} textLen=${text.length}`);
  }

  onState(state: string, detail: string): void {
    asrLog(this.logPath, `onState ${state} ${detail}`);
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

/* ────────────────────────────────────────────────────────────────────────────
 * Task 1 探针实现（长语音 Go/No-Go）
 *
 * 判据（见施工方案 Task 1）：
 *   · 10s / 30s / 5min 三段都有非空文本；
 *   · 5 分钟文本不是"只识别开头数秒"；
 *   · 自然停顿（1.2s 静音）后会话没有永久结束；
 *   · onComplete 在 12s 内到达，或超时后仍有可保存的定稿文本；
 *   · 同一进程没有多个活动引擎（SystemSpeechRecognizer 的 lease 保证）。
 *
 * 音频来源：系统 TTS 离线合成 → 16k/16bit/单声道 PCM。每合成一整段文本后插 1.2s
 * 静音，模拟自然停顿；按"20ms 送 640 字节"的实时节奏喂引擎，避免一次性灌入被丢弃。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 探针事件适配器（ArkTS 不允许把带方法字面量直接赋给接口 ⇒ 用类实现）。 */
class ProbeSpeechEvents implements SystemSpeechEvents {
  private readonly logLine: (text: string) => void;

  constructor(logLine: (text: string) => void) {
    this.logLine = logLine;
  }

  onTranscript(live: string, text: string): void {
    this.logLine(`onTranscript liveLen=${live.length} textLen=${text.length} live="${live.slice(0, 24)}"`);
  }

  onState(state: string, detail: string): void {
    this.logLine(`onState ${state} ${detail}`);
  }
}

/** 探针结果 JSON 的形状（ArkTS 禁止无类型对象字面量，必须显式声明）。 */
interface SpeechProbeJson {
  ok: boolean;
  stage: string;
  mode: string;
  seconds: number;
  error?: string;
  log: string;
  ttsBytes?: number;
  writtenBytes?: number;
  textLen?: number;
  text?: string;
  source?: string;
  id?: string;
}

/**
 * 读随包离线语音样本（`rawfile/probe-speech-16k.wav`）。
 *
 * 【为什么需要它 —— 2026-10-18 PC 真机首跑踩到】系统 TTS 的 `onData` 回调在这台
 * 2in1 上**一次都没有触发**（`onStart` 报 audioType=pcm/16000/16bit/ch=3、
 * `onComplete type=0 synthesis complete`，但 0 字节音频 —— 说明该实现只负责"合成并
 * 直接播放"，不提供 PCM 流）。继续用 TTS 会让探针喂进去的全是静音，"文本为空"就
 * 会被误读成"long 模式不行"。
 * ⇒ 改为：**随包放一段用桌面 SAPI（Microsoft Huihui）合成的 16k/mono/s16 中文语音**，
 *    探针直接读 rawfile 当声源；TTS 只作兜底。样本 58s，可循环 + 插静音凑任意时长。
 */
async function loadProbePcmFromRawfile(): Promise<Uint8Array> {
  const ctx: common.UIAbilityContext | undefined = bridgeAbilityCtx;
  if (ctx === undefined) {
    throw new Error('bridgeAbilityCtx 未就绪');
  }
  const raw: Uint8Array = await ctx.resourceManager.getRawFileContent('probe-speech-16k.wav');
  if (raw.length <= WAV_HEADER) {
    throw new Error(`样本过短 ${raw.length}B`);
  }
  if (!(raw[0] === 0x52 && raw[1] === 0x49 && raw[2] === 0x46 && raw[3] === 0x46)) {
    throw new Error('样本不是 RIFF/WAVE');
  }
  return raw.subarray(WAV_HEADER);
}

/** 探针日志（追加写，带毫秒相对时间）。 */
function probeLog(path: string, line: string): void {
  try {
    const f: fs.File = fs.openSync(path,
      fs.OpenMode.WRITE_ONLY | fs.OpenMode.CREATE | fs.OpenMode.APPEND);
    fs.writeSync(f.fd, line + '\n');
    fs.closeSync(f);
  } catch (e) {
    // 日志写失败不影响探针
  }
}

/** 探针结果 JSON（一次覆盖写，PC 侧直接 recv 后读字段即可）。 */
function writeProbeJson(path: string, payload: string): void {
  try {
    const f: fs.File = fs.openSync(path,
      fs.OpenMode.WRITE_ONLY | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
    fs.writeSync(f.fd, payload);
    fs.closeSync(f);
  } catch (e) {
    // 同日志
  }
}

/** Host 侧写给桥的请求 JSON（这里由探针模拟，字段与 provider 逐字一致）。 */
interface DictationPayload {
  audio: string;
  language: string;
}

/**
 * 听写链路端到端自检（Task 3 验收）：模拟 provider 写一个 6 秒 `.req`，
 * 然后等桥跑完 `handleRequest` 产出 `.done/.fail`。
 *
 * 【为什么要它】Web 麦克风按钮需要真人点击；而这条链路的关键是
 * 「base64 解码 → 剥 WAV 头 → 质量指标 → 系统识别 → 写结果」。
 * 探针自己造请求即可覆盖到，不必依赖 UI 自动化点击。
 */
async function runDictationProbe(filesDir: string, jsonPath: string,
  line: (s: string) => void): Promise<void> {
  const ctx: common.UIAbilityContext | undefined = bridgeAbilityCtx;
  if (ctx === undefined) {
    line('dictation: bridgeAbilityCtx 未就绪');
    return;
  }
  const wav: Uint8Array = await ctx.resourceManager.getRawFileContent('probe-speech-16k.wav');
  const dataBytes: number = 6 * 32000;
  if (wav.length < 44 + dataBytes) {
    line(`dictation: 样本过短 ${wav.length}B`);
    return;
  }
  const cut: Uint8Array = new Uint8Array(44 + dataBytes);
  cut.set(wav.subarray(0, 44), 0);
  cut.set(wav.subarray(44, 44 + dataBytes), 44);
  const view: DataView = new DataView(cut.buffer);
  view.setUint32(4, 36 + dataBytes, true);
  view.setUint32(40, dataBytes, true);
  const helper: util.Base64Helper = new util.Base64Helper();
  const payload: DictationPayload = { audio: helper.encodeToStringSync(cut), language: 'zh-CN' };
  const id: string = `probe-dict-${Date.now()}`;
  const queueDir: string = `${filesDir}/dsh/home/speech-to-text/hms-bridge`;
  const reqPath: string = `${queueDir}/${id}.req`;
  const tmpPath: string = `${queueDir}/${id}.tmp`;
  try {
    if (!fs.accessSync(queueDir)) {
      fs.mkdirSync(queueDir, true);
    }
    const f: fs.File = fs.openSync(tmpPath,
      fs.OpenMode.WRITE_ONLY | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
    fs.writeSync(f.fd, JSON.stringify(payload));
    fs.closeSync(f);
    fs.renameSync(tmpPath, reqPath);
  } catch (e) {
    line(`dictation: 写请求失败 ${(e as Error).message}`);
    return;
  }
  line(`dictation: 已写请求 id=${id} bytes=${cut.length}`);
  /*
   * 【必须立刻返回，不能在这里等 .done】本函数就跑在桥的轮询循环里（busy=true）。
   * 若在这里等 handleRequest 处理这个 .req，而 handleRequest 又要等轮询空闲
   * ⇒ 自己等自己，必然死锁（2026-10-18 真机首跑踩到：req 一直躺在队列里）。
   * 正确做法：只投递，立刻放开 busy；下一拍轮询自然处理，结果看 .done 与 ASR 日志。
   */
  const queued: SpeechProbeJson = {
    ok: true, stage: 'dictation-queued', mode: 'dictation', seconds: 6,
    id: id, error: '', log: ''
  };
  writeProbeJson(jsonPath, JSON.stringify(queued));
}


/** 跑一次探针：合成 → 实时喂 → finish → 落 log/json。 */
async function runSpeechProbe(filesDir: string, req: SpeechProbeRequest): Promise<void> {
  const dir: string = `${filesDir}/diag-meeting-probe`;
  try {
    if (!fs.accessSync(dir)) {
      fs.mkdirSync(dir, true);
    }
  } catch (e) {
    // 目录已存在
  }
  const stamp: string = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath: string = `${dir}/probe-${req.mode}-${req.seconds}s-${stamp}.log`;
  const jsonPath: string = `${dir}/probe-${req.mode}-${req.seconds}s-${stamp}.json`;
  const t0: number = Date.now();
  const line = (s: string): void => {
    probeLog(logPath, `${Date.now() - t0}ms ${s}`);
  };
  line(`probe start mode=${req.mode} seconds=${req.seconds}`);
  if (req.mode === 'dictation') {
    // 走真实听写链路：自己写 <id>.req（模拟 provider），由轮询 → handleRequest 处理
    await runDictationProbe(filesDir, jsonPath, line);
    return;
  }

  let pcm: Uint8Array = new Uint8Array(0);
  let source: string = '';
  try {
    pcm = await loadProbePcmFromRawfile();
    if (pcm.length > 0) {
      source = 'rawfile';
    }
  } catch (e) {
    line(`rawfile 不可用：${(e as Error).message}`);
  }
  if (pcm.length === 0) {
    // 【PC 真机 2026-10-18】rawfile 与 TTS 都没有声源 ⇒ 探针无效，必须单独判死，
    // 否则"文本为空"会被误读成"long 模式不行"。
    line('no audio：rawfile 没有产出 PCM（TTS 路径已下线）');
    const noAudio: SpeechProbeJson = {
      ok: false, stage: 'no-audio', mode: req.mode, seconds: req.seconds,
      error: '无可用声源（rawfile 缺失；TTS 合成路径已下线）', log: logPath
    };
    writeProbeJson(jsonPath, JSON.stringify(noAudio));
    return;
  }
  line(`audio source=${source} bytes=${pcm.length} audioMs=${Math.round(pcm.length / 32)}`);

  const recognizer: SystemSpeechRecognizer = new SystemSpeechRecognizer(
    req.mode === 'long' ? 'long' : 'short', new ProbeSpeechEvents(line));
  try {
    await recognizer.start();
  } catch (e) {
    line(`start failed: ${(e as Error).message}`);
    const startFail: SpeechProbeJson = {
      ok: false, stage: 'start', mode: req.mode, seconds: req.seconds,
      error: (e as Error).message, log: logPath
    };
    writeProbeJson(jsonPath, JSON.stringify(startFail));
    return;
  }
  line('engine started');

  /* 实时喂音频：640B/20ms ≈ 实时；每合成一轮（PROBE_TEXT 覆盖约 40s 语音）后插 1.2s 静音。 */
  const totalBytes: number = req.seconds * 32000;
  const silentChunk: Uint8Array = new Uint8Array(640);
  const pending: Uint8Array = new Uint8Array(640);
  let pendingLen: number = 0;
  let sent: number = 0;
  let pos: number = 0;
  let silenceLeft: number = 0;
  let progressAt: number = 0;
  const pushChunk = (src: Uint8Array): void => {
    let i: number = 0;
    while (i < src.length) {
      const take: number = Math.min(pending.length - pendingLen, src.length - i);
      pending.set(src.subarray(i, i + take), pendingLen);
      pendingLen += take;
      i += take;
      if (pendingLen === pending.length) {
        recognizer.writePcm(pending);
        sent += pending.length;
        pendingLen = 0;
      }
    }
  };
  while (sent < totalBytes) {
    if (recognizer.needsRotate()) {
      // 单会话 18.75s 上限：主动收尾换会话（见 SystemSpeechRecognizer.ROTATE_AT_BYTES）
      await recognizer.rotate();
    }
    if (silenceLeft > 0) {
      const take: number = Math.min(silentChunk.length, silenceLeft);
      pushChunk(silentChunk.subarray(0, take));
      silenceLeft -= take;
    } else {
      if (pos >= pcm.length) {
        pos = 0;
        silenceLeft = 38400; // 1.2s @16k/mono/s16
        line(`silence 1200ms at sent=${sent}B`);
        continue;
      }
      const take: number = Math.min(pcm.length - pos, 640);
      pushChunk(pcm.subarray(pos, pos + take));
      pos += take;
    }
    if (sent - progressAt >= 32000) {
      progressAt = sent;
      line(`progress sent=${sent}B written=${recognizer.writtenBytes()}B`);
    }
    await sleep(20);
  }
  if (pendingLen > 0) {
    // 尾块补零到 640 再送（引擎只吃 640/1280 的整块）
    for (let i: number = pendingLen; i < pending.length; i++) {
      pending[i] = 0;
    }
    recognizer.writePcm(pending);
    line(`tail padded ${pendingLen}->640`);
  }
  const text: string = await recognizer.finish(12000);
  line(`finish textLen=${text.length} written=${recognizer.writtenBytes()}B`);
  const done: SpeechProbeJson = {
    ok: text.length > 0,
    stage: 'done',
    mode: req.mode,
    seconds: req.seconds,
    ttsBytes: pcm.length,
    writtenBytes: recognizer.writtenBytes(),
    textLen: text.length,
    text: text,
    source: source,
    log: logPath
  };
  writeProbeJson(jsonPath, JSON.stringify(done));
  line('probe done');
}
