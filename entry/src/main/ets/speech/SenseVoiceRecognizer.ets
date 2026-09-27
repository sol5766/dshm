/*
 * SenseVoice 离线识别（sherpa-onnx 官方鸿蒙 HAR）。
 *
 * ══ 为什么用这个而不是 HMS ══
 * HMS 的 speechRecognizer 是**流式听写引擎**，单会话只处理开头 4~5 秒
 * （真机七轮实测：≤4.2s 全对、≥6s 近乎全灭，且 VAD 触发不可控）。
 * 而 SenseVoice 是**离线批处理模型**：一次给整段音频、一次出结果，
 * 没有端点检测截断问题 —— 这正是 dsh 官方识别服务用的模型。
 *
 * ══ 数据流 ══
 *   16k 单声道 PCM16
 *     → Silero VAD 切出语音段（可选，短音频可直接整段）
 *     → OfflineRecognizer 逐段 decode
 *     → 拼接文本
 *
 * ══ 依赖 ══
 *   sherpa_onnx（ohpm 官方 HAR，见 third_party/sherpa_onnx-1.13.3.har）
 *   模型放应用沙箱目录（由 host 侧在线下载，见 hostcore/speech-models）
 */
import { OfflineRecognizer, OfflineRecognizerConfig, OfflineStream, OfflineRecognizerResult,
  SileroVadConfig, TenVadConfig, SpeechSegment, Vad, VadConfig } from 'sherpa_onnx';
import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';

const DOMAIN: number = 0xD5D5;
const TAG: string = 'DshmSenseVoice';

/** 模型文件名（与 runtime/assets.json 的 name 一致；目录由 modelDir() 给出）。 */
/** SenseVoice 模型文件名（int8 量化版，239MB）。 */
const MODEL_FILE: string = 'model.int8.onnx';
/** 词表文件名。 */
const TOKENS_FILE: string = 'tokens.txt';
/** Silero VAD 模型文件名。 */
const VAD_FILE: string = 'silero_vad.onnx';

/**
 * SenseVoice 识别器（单例，避免每次识别都重新加载 239MB 模型）。
 *
 * 【为什么必须单例】模型加载耗时且有内存占用；
 * dsh 的识别是"用户显式动作 + 串行投递"，复用实例完全安全。
 */
export class SenseVoiceRecognizer {
  private recognizer: OfflineRecognizer | undefined = undefined;
  private vad: Vad | undefined = undefined;
  private readonly ctx: common.UIAbilityContext;

  constructor(ctx: common.UIAbilityContext) {
    this.ctx = ctx;
  }

  /**
   * 懒加载识别器与 VAD（首次调用时初始化，之后复用）。
   *
   * @returns 初始化是否成功
   */
  private ensureReady(): boolean {
    if (this.recognizer !== undefined) {
      return true;
    }
    try {
      /*
       * 【模型从沙箱**文件路径**加载，不传 resourceManager】
       *
       * 依据（sherpa-onnx 源码 harmony-os/SherpaOnnxHar/.../non-streaming-asr.cc）：
       *   use_resource_manager = (info.Length() === 2 && info[1] 非空)
       *   传了 ⇒ SherpaOnnxCreateOfflineRecognizerOHOS(config, mgr)  // 从 rawfile 读
       *   不传 ⇒ SherpaOnnxCreateOfflineRecognizer(config)          // 从文件系统读
       * 两条底层实现分别是 OfflineRecognizer(mgr, config) 与 OfflineRecognizer(config)。
       *
       * 模型改为在线下载后落在沙箱目录，故必须走**不传 mgr** 这条路径。
       * （另注：OHOS 版本在 mgr === nullptr 时也会回退到通用路径，是双保险。）
       */
      const dir: string = this.modelDir();

      /* ---- 识别器：SenseVoice ---- */
      const config: OfflineRecognizerConfig = new OfflineRecognizerConfig();
      config.modelConfig.senseVoice.model = `${dir}/${MODEL_FILE}`;
      config.modelConfig.tokens = `${dir}/${TOKENS_FILE}`;
      /*
       * language 留空 ⇒ 自动判别（SenseVoice 支持 zh/en/ja/ko/yue）。
       * useItn = true ⇒ 逆文本正则化（"一二三" → "123"），
       * 这对数字串场景更友好。
       */
      config.modelConfig.senseVoice.language = '';
      config.modelConfig.senseVoice.useItn = true;
      config.modelConfig.numThreads = 2;
      config.modelConfig.debug = false;
      this.recognizer = new OfflineRecognizer(config);
      hilog.info(DOMAIN, TAG, 'SenseVoice 识别器已加载（文件路径模式）');

      /* ---- VAD：Silero（用于长音频切分，短音频可不用）---- */
      const vadConfig: VadConfig = new VadConfig(
        new SileroVadConfig(`${dir}/${VAD_FILE}`, 0.5, 0.25, 0.5, 512, 20),
        new TenVadConfig('', 0.5, 0.25, 0.5, 256, 20),
        16000,
        false,
        1,
      );
      this.vad = new Vad(vadConfig, 60);
      hilog.info(DOMAIN, TAG, 'Silero VAD 已加载');
      return true;
    } catch (e) {
      const err = e as Error;
      hilog.error(DOMAIN, TAG, '识别器初始化失败: %{public}s', err.message);
      this.recognizer = undefined;
      this.vad = undefined;
      return false;
    }
  }

  /**
   * 模型目录（沙箱绝对路径），与 provider 侧 `dataRoot` 一致。
   *
   * provider 侧的推导（hostcore/speech-provider/index.js）：
   *   dataRoot = dshHomePath('speech-to-text', 'sensevoice')
   *           = $DSH_HOME/speech-to-text/sensevoice
   * 而 $DSH_HOME 在端侧就是 `<filesDir>/dsh/home`。
   *
   * @returns 模型目录绝对路径
   */
  private modelDir(): string {
    return `${this.ctx.filesDir}/dsh/home/speech-to-text/sensevoice`;
  }

  /**
   * 模型是否已就位（三个文件都在且非空）。
   *
   * 【为什么看大小而非只判存在】下载中断会留下 0 字节或截断的文件；
   * 只判存在会让"点麦克风就崩"变成"点了没反应"。
   *
   * @returns 是否齐备
   */
  modelsReady(): boolean {
    const dir: string = this.modelDir();
    const names: string[] = [MODEL_FILE, TOKENS_FILE, VAD_FILE];
    for (const n of names) {
      try {
        const st: fileIo.Stat = fileIo.statSync(`${dir}/${n}`);
        if (st.size <= 0) {
          return false;
        }
      } catch (e) {
        return false;
      }
    }
    return true;
  }

  /**
   * **预热**：把 230MB 模型的加载从"用户点麦克风那一刻"挪到空闲时。
   *
   * 【为什么必须有】`ensureReady()` 是懒加载，而 provider 侧单次识别有预算
   * （`TIMEOUT_MS=25000`，见 hostcore/speech-provider/index.js 的 awaitResult）。
   * 若不预热，**第一次**点麦克风要在这 25 秒里同时完成
   * "读 230MB rawfile + 建 onnxruntime session + 初始化 Silero VAD"，
   * 超时会让用户看到"识别超时"—— 而这是**必然发生**的，不是概率问题。
   *
   * 【为什么先让出一次】ArkTS 主线程上做长同步加载会卡住 UI
   * （项目已吃过同类亏，见 docs/70 E45 的 LIFECYCLE_TIMEOUT）。
   * 先 `await` 一次把控制权交回，让 UI 先完成首帧。
   *
   * 【失败不抛】预热失败只记日志：真正的错误留到 `recognize()` 里如实抛出，
   * 那时用户能看到原因，而不是在启动阶段静默失败。
   *
   * @returns 预热是否成功（调用方一般忽略）
   */
  async warmUp(): Promise<boolean> {
    if (this.recognizer !== undefined) {
      return true;
    }
    /* 先让出：避免在启动关键路径上做重型同步加载 */
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 0);
    });
    const t0: number = Date.now();
    const ok: boolean = this.ensureReady();
    hilog.info(DOMAIN, TAG, '预热 %{public}s，用时 %{public}dms',
      ok ? '成功' : '失败', Date.now() - t0);
    return ok;
  }

  /**
   * 识别一段 16k 单声道 PCM16。
   *
   * 【策略】优先用 VAD 切分后逐段识别（长音频更准）；
   *   若 VAD 不可用或没切出段，退化为整段识别。
   *   与 HMS 不同，这里**不做端点截断** —— SenseVoice 吃整段。
   *
   * @param pcm 16k 单声道 PCM16（小端）
   * @returns 识别文本（可能为空串）
   */
  async recognize(pcm: Uint8Array): Promise<string> {
    if (!this.ensureReady()) {
      throw new Error('SenseVoice 识别器不可用（模型未就位？）');
    }
    const recognizer = this.recognizer;
    if (recognizer === undefined) {
      throw new Error('SenseVoice 识别器不可用');
    }

    /* PCM16 → Float32（模型吃归一化浮点） */
    const samples: Float32Array = SenseVoiceRecognizer.toFloat32(pcm);
    if (samples.length === 0) {
      return '';
    }

    const vad = this.vad;
    const parts: string[] = [];

    if (vad !== undefined) {
      try {
        vad.reset();
        const windowSize: number = vad.config.sileroVad.windowSize;
        for (let i = 0; i < samples.length; i += windowSize) {
          const win: Float32Array = samples.subarray(i, Math.min(i + windowSize, samples.length));
          vad.acceptWaveform(win);
          if (i + windowSize >= samples.length) {
            vad.flush();
          }
          while (!vad.isEmpty()) {
            const seg: SpeechSegment = vad.front();
            /* 太短的段丢弃（<0.2s 多半是噪声） */
            if (seg.samples.length / 16000 >= 0.2) {
              const t: string = this.decodeOne(recognizer, seg.samples);
              if (t.length > 0) {
                parts.push(t);
              }
            }
            vad.pop();
          }
        }
      } catch (e) {
        const err = e as Error;
        hilog.warn(DOMAIN, TAG, 'VAD 切分失败，退化为整段识别: %{public}s', err.message);
        parts.length = 0;
      }
    }

    /* 兜底：VAD 没切出内容 ⇒ 整段识别 */
    if (parts.length === 0) {
      const t: string = this.decodeOne(recognizer, samples);
      if (t.length > 0) {
        parts.push(t);
      }
    }

    const text: string = parts.join('');
    hilog.info(DOMAIN, TAG, '识别完成: %{public}s', text.slice(0, 80));
    return text;
  }

  /**
   * 用识别器解一段音频。
   *
   * @param recognizer 识别器
   * @param samples 归一化浮点样本
   * @returns 该段文本
   */
  private decodeOne(recognizer: OfflineRecognizer, samples: Float32Array): string {
    const stream: OfflineStream = recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: 16000 });
    recognizer.decode(stream);
    const result: OfflineRecognizerResult = recognizer.getResult(stream);
    return result.text ?? '';
  }

  /**
   * PCM16 小端字节流 → 归一化 Float32。
   *
   * 【为什么除 32768】sherpa-onnx 的 acceptWaveform 吃 [-1,1] 的浮点。
   *
   * @param pcm PCM16 字节流
   * @returns 归一化样本
   */
  private static toFloat32(pcm: Uint8Array): Float32Array {
    const n: number = Math.floor(pcm.length / 2);
    const out: Float32Array = new Float32Array(n);
    const view: DataView = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let i = 0; i < n; i++) {
      out[i] = view.getInt16(i * 2, true) / 32768;
    }
    return out;
  }

  /** 释放资源（进程退出时调用；也可不调，随进程回收）。 */
  shutdown(): void {
    this.recognizer = undefined;
    this.vad = undefined;
  }
}
