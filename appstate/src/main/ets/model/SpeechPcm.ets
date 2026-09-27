/**
 * PCM 音频工具（纯逻辑，可单测）。
 *
 * 【为什么单独成文件】路线 A（HMS 系统语音识别）对音频格式有**硬约束**：
 *   · `AudioInfo.sampleRate` **只支持 16000**（@hms.ai.speechRecognizer.d.ts:397-403）；
 *   · `writeAudio` 的 audio 长度**只能是 640 或 1280 字节**（:120-123）；
 *   · `audioType` 只支持 `pcm`、`soundChannel` 只支持 1、`sampleBit` 只支持 16。
 * 而真机麦克风**实测是 48000 Hz**（见 `diag-mic-probe` 的 `sampleRate:48000`），
 * 所以必须重采样 48k → 16k，并按 640 字节切片。
 *
 * 这些换算全是纯数学、零依赖，抽出来可被 `check-layout-fixtures.mjs` 覆盖 ——
 * 否则"采样率写错/切片越界"这类错误只能靠真机听结果，代价太高。
 */

/** HMS 语音识别唯一支持的采样率（写错会被 401 参数校验拒绝） */
export const HMS_SAMPLE_RATE: number = 16000;
/** 16 位 = 每样本 2 字节 */
export const BYTES_PER_SAMPLE: number = 2;
/** `writeAudio` 只接受这两种长度（写别的会报 401 / 越界） */
export const HMS_CHUNK_BYTES: number = 640;
export const HMS_CHUNK_BYTES_ALT: number = 1280;
/** 单次识别最大音频时长（文档：60000 ms） */
export const HMS_MAX_AUDIO_MS: number = 60000;

/**
 * canonical PCM16 WAV 的固定头长度。
 *
 * 【为什么是常量而不是散落的字面量 44】这个值被**两侧**同时依赖：
 *   · Host 侧算音频时长：`(bytes - 44) / 32000`
 *   · ArkTS 侧剥头后喂 HMS：`wav.subarray(44)`
 * 两处若各写各的，一旦上游改了头长度就会**一边对一边错**，
 * 而症状是"识别结果莫名变差"，很难查。所以在这里定义一次。
 *
 * 依据（上游逐字核实）：`dsh-experimental-client-ui-voice-input` 的
 * `encodeWave()` —— RIFF(4) + size(4) + WAVE(4) + "fmt "(4) + 16(4) +
 * audioFormat(2) + channels(2) + sampleRate(4) + byteRate(4) +
 * blockAlign(2) + bitsPerSample(2) + "data"(4) + dataSize(4) = 44。
 */
export const WAV_HEADER_BYTES: number = 44;

/** canonical WAV 的每秒字节数（16k 单声道 16bit = 16000 × 2）。 */
export const WAV_BYTES_PER_SECOND: number = 32000;

/**
 * 校验"一块音频"是否符合 HMS 的 `writeAudio` 约束。
 *
 * 【为什么要显式校验】文档写明"只能 640 或 1280 字节"。若把任意长度丢进去，
 * 在真机上表现为识别无结果或报 401，而错误信息不会告诉你"是因为块大小"。
 * 提前拦下来能把这类问题变成一条明确的日志。
 */
export function isValidAudioChunk(byteLength: number): boolean {
  return byteLength === HMS_CHUNK_BYTES || byteLength === HMS_CHUNK_BYTES_ALT;
}

/**
 * 把 16 位单声道 PCM 按 `chunkBytes` 切成若干块。
 *
 * 【为什么需要】`writeAudio` 只收定长块（640 或 1280 字节），
 * 调用方需要按固定节奏逐块喂。
 *
 * 【尾巴为什么丢弃 —— 实测代价，不是随手省略】
 * 16k 单声道 16bit ⇒ 32000 字节/秒，而 640 字节 = 20ms。
 * 常见的整数秒录音（1/3/5/10/60 秒）字节数都是 640 的整数倍，
 * **余数为 0**（已由门禁断言钉住）；只有非整数秒才会有余数，
 * 最多丢 639 字节 ≈ 末尾 20ms —— 不到一个音素尾巴的量级。
 * 而不足一块的数据喂进 `writeAudio` 会被拒（400），所以丢弃比报错好。
 *
 * @param pcm 完整的 16 位单声道 PCM
 * @param chunkBytes 每块字节数（应为 640 或 1280）
 * @returns 切好的块；输入为空或块大小非法时返回空数组
 */
export function slicePcmChunks(pcm: Uint8Array, chunkBytes: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  if (pcm === undefined || pcm === null || pcm.length === 0) {
    return out;
  }
  if (!isValidAudioChunk(chunkBytes)) {
    return out;
  }
  const whole: number = Math.floor(pcm.length / chunkBytes);
  for (let i = 0; i < whole; i++) {
    out.push(pcm.subarray(i * chunkBytes, (i + 1) * chunkBytes));
  }
  return out;
}

/**
 * 把 16 位单声道 PCM 从 `srcRate` 重采样到 `dstRate`（线性插值）。
 *
 * 【为什么用线性插值而不是直接抽取】48k → 16k 恰好是 3:1，直接每 3 个取 1 个也能用，
 * 但那等于无滤波下采样，高频会混叠进人声频段、伤识别率。线性插值是最小代价的改进，
 * 且实现简单、无依赖（不需要傅里叶/滤波器设计）。
 *
 * 【返回 Uint8Array】输入输出都是"16 位小端、单声道"的字节流，与 HMS 的 `pcm` 一致。
 *   · 读写样本用 little-endian（与 WAV/PCM 约定一致）；
 *   · 负样本要用符号位还原（`int16` 才有负值；写成无符号会让声音削顶失真）。
 *
 * @param pcm 16 位单声道 PCM 字节流
 * @param srcRate 原采样率（如 48000）
 * @param dstRate 目标采样率（如 16000）
 * @returns 重采样后的字节流；参数非法或输入为空时返回空
 */
export function resamplePcm16(pcm: Uint8Array, srcRate: number, dstRate: number): Uint8Array {
  if (pcm === undefined || pcm === null || pcm.length < BYTES_PER_SAMPLE) {
    return new Uint8Array(0);
  }
  if (srcRate <= 0 || dstRate <= 0) {
    return new Uint8Array(0);
  }
  if (srcRate === dstRate) {
    return pcm;
  }

  const srcSamples: number = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  if (srcSamples === 0) {
    return new Uint8Array(0);
  }
  const outSamples: number = Math.floor(srcSamples * dstRate / srcRate);
  if (outSamples <= 0) {
    return new Uint8Array(0);
  }

  const out: Uint8Array = new Uint8Array(outSamples * BYTES_PER_SAMPLE);
  const ratio: number = srcRate / dstRate;   // 每个输出样本对应多少输入样本
  const view: DataView = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const outView: DataView = new DataView(out.buffer);

  for (let i = 0; i < outSamples; i++) {
    const pos: number = i * ratio;
    const i0: number = Math.floor(pos);
    const i1: number = i0 + 1 < srcSamples ? i0 + 1 : i0;
    const frac: number = pos - i0;

    const s0: number = view.getInt16(i0 * BYTES_PER_SAMPLE, true);
    const s1: number = view.getInt16(i1 * BYTES_PER_SAMPLE, true);
    let v: number = s0 + (s1 - s0) * frac;

    // 夹取到 int16 范围，避免插值越界（理论上不会，但显式保证不会写出坏值）
    if (v > 32767) {
      v = 32767;
    } else if (v < -32768) {
      v = -32768;
    }
    outView.setInt16(i * BYTES_PER_SAMPLE, Math.round(v), true);
  }
  return out;
}

/**
 * 把"累计型"识别回调合并成最终文本。
 *
 * 【为什么需要这个函数】HMS 的 `onResult` **每次给的都是从头累计的完整文本**，
 * 不是增量片段。真机实测（2026-09-26，说「一二三四五」）：
 *
 * ```
 * onResult isFinal=false text="一"
 * onResult isFinal=false text="一二"
 * onResult isFinal=false text="一二三"
 * onResult isFinal=false text="一二三四"
 * onResult isFinal=false text="一二三四五"
 * onResult isFinal=true  text="12345。"
 * ```
 *
 * 天真写法 `acc += result.text` 会把累计文本再叠一遍，得到
 * `"一一二一二三一二三四一二三四五12345。"` —— 正是首次实现的真实错误。
 *
 * 正确语义是**取最新一次**（它已包含全部先前内容）。本函数据此实现，
 * 并优先采信 `isFinal`/`isLast` 的那一条（它是最终定稿）。
 *
 * @param previous 之前已采纳的文本
 * @param incoming 本次回调的 text
 * @param isFinal 本次是否为该分句的最终结果
 * @param isLast 本次是否为整段话的最后一句
 * @returns 应当采纳的文本
 */
export function mergeTranscript(previous: string, incoming: string, isFinal: boolean, isLast: boolean): string {
  if (incoming === undefined || incoming === null || incoming.length === 0) {
    return previous === undefined || previous === null ? '' : previous;
  }
  if (previous === undefined || previous === null || previous.length === 0) {
    return incoming;
  }
  // 最终/最后一条直接定稿
  if (isFinal || isLast) {
    return incoming;
  }
  /*
   * 仍取"更长的那条"作为兜底：正常情况 incoming 是累计的（≥ previous）；
   * 若引擎在某个分句后**重置**了累计（新一轮识别从短文本开始），
   * incoming 会短于 previous —— 那时应当**追加**而不是丢弃，
   * 否则后一句会被前一句吃掉（多分句场景的典型错误）。
   */
  if (incoming.length >= previous.length) {
    return incoming;
  }
  return previous + incoming;
}

/**
 * 判断一段 16 位 PCM 是否接近静音。
 *
 * 【为什么要这个判据】用 TTS 做"声学往返"自检时，实测 TTS 在鸿蒙上
 * `onComplete` 74ms 就返回、`onData` 一次不触发（它是**播放**接口），
 * 麦克风实际录到静音（`peak=0`）。此时 ASR 返回空文本是**正确行为**，
 * 若没有静音判别，就会把"没声音"误判成"ASR 不可用" ——
 * 这类归因错误会让人去改本来没坏的东西。
 *
 * 阈值取 200：16 位满量程 32767，200 约为 0.6% —— 低于此基本可判为静音/极低噪。
 *
 * @param peakAmplitude `peakAmplitude()` 的结果
 */
export function isNearSilence(peakAmplitude: number): boolean {
  return peakAmplitude < 200;
}

/**
 * 估算 PCM 的时长（毫秒），用于对照 HMS 的 60s 上限。
 *
 * @param pcm 16 位单声道 PCM
 * @param sampleRate 采样率
 */
export function pcmDurationMs(pcm: Uint8Array, sampleRate: number): number {
  if (pcm === undefined || pcm === null || sampleRate <= 0) {
    return 0;
  }
  const samples: number = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  return Math.floor(samples * 1000 / sampleRate);
}

/**
 * 生成一段 16 位单声道 PCM 正弦波（用于**自检**：验证引擎能跑通链路）。
 *
 * 【为什么要造音频】`createEngine` 能否成功、`startListening`/`writeAudio`/`finish`
 * 是否按序回调，这些**不需要真实语音**就能验证。喂一段确定的波形（而非真实录音）
 * 让自检完全离线、可重复，且不依赖麦克风是否可用。
 * 识别结果对纯音应为空/无意义——这正是预期：本自检验证的是**链路**，不是识别率。
 *
 * @param ms 时长（毫秒）
 * @param sampleRate 采样率（HMS 要求 16000）
 * @param freqHz 正弦频率
 */
export function makeTonePcm16(ms: number, sampleRate: number, freqHz: number): Uint8Array {
  if (ms <= 0 || sampleRate <= 0) {
    return new Uint8Array(0);
  }
  const samples: number = Math.floor(sampleRate * ms / 1000);
  const out: Uint8Array = new Uint8Array(samples * BYTES_PER_SAMPLE);
  const view: DataView = new DataView(out.buffer);
  const twoPiF: number = 2 * Math.PI * freqHz;
  for (let i = 0; i < samples; i++) {
    const t: number = i / sampleRate;
    // 幅度取 1/4 满量程：足够非零，又不会削顶
    const v: number = Math.round(8192 * Math.sin(twoPiF * t));
    view.setInt16(i * BYTES_PER_SAMPLE, v, true);
  }
  return out;
}
