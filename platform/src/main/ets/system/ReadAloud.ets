/**
 * 原生朗读（2026-11-15）。
 *
 * 【为什么单独一层】朗读是**系统能力**，不是页面状态：Speech Kit 的 `TextReader`
 * 自带播放面板 / Minibar / 通知 / AVSession / 后台播放；Core Speech Kit 的
 * `textToSpeech` 是无面板的兜底。两套都要求「同一进程只初始化一次」的引擎语义，
 * 放在页面里会被重建/重复 init 打穿，因此收成平台层单例，两个壳共用。
 *
 * 【首选 TextReader，失败降级 textToSpeech】
 *   · TextReader 需要 `SystemCapability.AI.Component.TextReader`（phone/tablet 5.0.0、
 *     2in1 5.0.1 起），且 `init` 要求已声明的 `KEEP_BACKGROUND_RUNNING`；
 *   · 能力不存在 / init 失败 / start 失败 ⇒ 退回 textToSpeech（无面板、仅播报）。
 *   · 两套都只在本机离线合成（`online: 1`），回复文本不出设备。
 *
 * 【为什么不用 chat-demo 的流式 PCM】那是浏览器 WebAudio 路径；鸿蒙侧 TextReader
 * 已经负责合成、播放、暂停/继续、后台与播控，照搬只会多一层不可控状态。
 *
 * 【边界】文本由调用方负责（Web 侧已剥掉 Markdown 标记）；本模块只做长度保护：
 * textToSpeech 单次上限 10,000 字符，超长截断；TextReader 走单篇正文。
 */

import { TextReader } from '@kit.SpeechKit';
import { textToSpeech } from '@kit.CoreSpeechKit';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/readaloud';
/** textToSpeech.speak 的硬上限（文档：不超过 10,000 字符） */
const TTS_MAX_CHARS: number = 9800;

/**
 * 中文兜底音色（SDK 明示：13 = 凌晓珊女声，推荐值；0 也可用）。
 *
 * 【为什么不是"小艺"字面量】Core Speech Kit 的 `VoiceInfo.person` 没有名为"小艺"的
 * 枚举值（zh-CN 只有 13 女声 / 21 男声，男声需下载）。但系统朗读的默认音色就是
 * 小艺同款中文女声，13 是 SDK 的推荐值，因此把它作为"小艺音色"的等价默认。
 */
const XIAOYI_FALLBACK_PERSON: number = 13;

/** 音色探测结果缓存：一次启动只查一次，避免每次朗读都走一次 listVoices */
let xiaoyiPersonPromise: Promise<number> | null = null;

/**
 * 解析本机已安装的"小艺"音色编号。
 *
 * 策略（按优先级）：
 *   1. `listVoices` 返回的音色里 description 含「小艺」/「Xiaoyi」且 `status === 'INSTALLED'`
 *      ⇒ 用它的 `person`（设备真有这个音色时尊重设备）；
 *   2. 没有明确命名的小艺音色 ⇒ 用 13（SDK 推荐的中文女声，等价于系统默认朗读音色）。
 *
 * 【为什么不下载 21 男声】`downloadVoice` 会有网络与存储成本，朗读是系统能力，
 * 不该为了一个音色让首次朗读变慢或依赖网络。
 * 【失败安全】任何异常都回落到 13 —— 音色选择绝不能阻断朗读。
 */
function resolveXiaoyiPerson(): Promise<number> {
  if (xiaoyiPersonPromise !== null) {
    return xiaoyiPersonPromise;
  }
  xiaoyiPersonPromise = textToSpeech.listVoices({
    requestId: 'dshm-voices-' + Date.now().toString(),
    online: 1
  }).then((voices: Array<textToSpeech.VoiceInfo>): number => {
    for (const voice of voices) {
      const desc: string = voice.description === undefined ? '' : voice.description;
      const installed: boolean = voice.status === 'INSTALLED';
      if (installed && (desc.indexOf('小艺') >= 0 || desc.toLowerCase().indexOf('xiaoyi') >= 0)) {
        hilog.info(DOMAIN, TAG, '已选用小艺音色 person=%{public}d（%{public}s）', voice.person, desc);
        return voice.person;
      }
    }
    hilog.info(DOMAIN, TAG, '本机无显式「小艺」音色，使用 SDK 推荐中文女声 person=%{public}d',
      XIAOYI_FALLBACK_PERSON);
    return XIAOYI_FALLBACK_PERSON;
  }).catch((e: BusinessError): number => {
    hilog.warn(DOMAIN, TAG, '音色探测失败（回退推荐音色）：%{public}s', e.message);
    return XIAOYI_FALLBACK_PERSON;
  });
  return xiaoyiPersonPromise;
}

/** 朗读控制器（进程内单例；由页面的桥持有） */
export class ReadAloud {
  private textReaderReady: boolean = false;
  private textReaderInit: Promise<boolean> | null = null;
  private ttsEngine: textToSpeech.TextToSpeechEngine | null = null;
  private requestSeq: number = 0;

  /**
   * 开始朗读一段纯文本。
   *
   * @param context UIAbility 上下文（TextReader.init 与 textToSpeech 都需要）
   * @param text 已剥掉 Markdown 标记的正文
   * @returns `started` / `fallback` / `empty` / `unavailable`
   */
  start(context: common.UIAbilityContext, text: string): string {
    const clean: string = text.trim();
    if (clean.length === 0) {
      return 'empty';
    }
    this.stop();
    this.requestSeq++;
    const requestId: string = 'dshm-read-' + Date.now().toString() + '-' + this.requestSeq.toString();
    if (this.textReaderAvailable()) {
      this.startTextReader(context, clean, requestId);
      return 'started';
    }
    this.startFallback(clean, requestId);
    return 'fallback';
  }

  /** 停止当前朗读（TextReader.stop / TTS.stop 都是幂等的） */
  stop(): void {
    if (this.textReaderReady) {
      try {
        TextReader.stop().catch((e: BusinessError): void => {
          hilog.debug(DOMAIN, TAG, 'TextReader.stop 拒绝 code=%{public}d', e.code);
        });
      } catch (err) {
        hilog.debug(DOMAIN, TAG, 'TextReader.stop 不适用：%{public}s', (err as BusinessError).message);
      }
    }
    const engine: textToSpeech.TextToSpeechEngine | null = this.ttsEngine;
    if (engine !== null) {
      try {
        engine.stop();
      } catch (err) {
        hilog.debug(DOMAIN, TAG, 'TTS.stop 不适用：%{public}s', (err as BusinessError).message);
      }
    }
  }

  /** 页面销毁/Ability 退出时释放引擎资源（幂等） */
  release(): void {
    this.stop();
    if (this.textReaderReady) {
      try {
        TextReader.release().catch((e: BusinessError): void => {
          hilog.debug(DOMAIN, TAG, 'TextReader.release 拒绝 code=%{public}d', e.code);
        });
      } catch (err) {
        hilog.debug(DOMAIN, TAG, 'TextReader.release 不适用：%{public}s', (err as BusinessError).message);
      }
      this.textReaderReady = false;
    }
    this.textReaderInit = null;
    const engine: textToSpeech.TextToSpeechEngine | null = this.ttsEngine;
    if (engine !== null) {
      try {
        engine.shutdown();
      } catch (err) {
        hilog.debug(DOMAIN, TAG, 'TTS.shutdown 不适用：%{public}s', (err as BusinessError).message);
      }
      this.ttsEngine = null;
    }
  }

  /** 设备是否有 TextReader 系统能力（按 syscap 判定，不猜型号） */
  private textReaderAvailable(): boolean {
    try {
      return canIUse('SystemCapability.AI.Component.TextReader');
    } catch (err) {
      return false;
    }
  }

  /** 首次用到时才 init；并发调用共享同一个 Promise */
  private ensureTextReader(context: common.UIAbilityContext): Promise<boolean> {
    if (this.textReaderReady) {
      return Promise.resolve(true);
    }
    if (this.textReaderInit !== null) {
      return this.textReaderInit;
    }
    const params: TextReader.ReaderParam = {
      isVoiceBrandVisible: false,
      // 1 = 离线合成：回复文本不出设备
      online: 1,
      // entry/phone 都已声明 KEEP_BACKGROUND_RUNNING（权限面不变）
      keepBackgroundRunning: true,
      isMinibarNeeded: true
    };
    try {
      this.textReaderInit = TextReader.init(context, params).then((): boolean => {
        this.textReaderReady = true;
        hilog.info(DOMAIN, TAG, 'TextReader 已初始化');
        return true;
      }).catch((e: BusinessError): boolean => {
        hilog.warn(DOMAIN, TAG, 'TextReader.init 失败，降级 textToSpeech：%{public}s', e.message);
        this.textReaderInit = null;
        return false;
      });
    } catch (err) {
      hilog.warn(DOMAIN, TAG, 'TextReader.init 同步失败，降级 textToSpeech：%{public}s',
        (err as BusinessError).message);
      this.textReaderInit = null;
      return Promise.resolve(false);
    }
    return this.textReaderInit;
  }

  private startTextReader(context: common.UIAbilityContext, text: string, requestId: string): void {
    this.ensureTextReader(context).then((ready: boolean): void => {
      if (!ready) {
        this.startFallback(text, requestId);
        return;
      }
      const title: TextReader.TextInfo = { text: 'DSHM 回答', isClickable: false };
      const info: TextReader.ReadInfo = {
        id: requestId,
        title: title,
        bodyInfo: text
      };
      const list: TextReader.ReadInfo[] = [info];
      const params: TextReader.StartParams = { startPercent: 0 };
      try {
        TextReader.start(list, requestId, params).catch((e: BusinessError): void => {
          hilog.warn(DOMAIN, TAG, 'TextReader.start 失败，降级 textToSpeech：%{public}s', e.message);
          this.startFallback(text, requestId);
        });
      } catch (err) {
        hilog.warn(DOMAIN, TAG, 'TextReader.start 同步失败，降级 textToSpeech：%{public}s',
          (err as BusinessError).message);
        this.startFallback(text, requestId);
      }
    });
  }

  /** 无面板兜底：Core Speech Kit 直接合成并播报（离线、中文） */
  private startFallback(text: string, requestId: string): void {
    const clipped: string = text.length > TTS_MAX_CHARS ? text.substring(0, TTS_MAX_CHARS) : text;
    if (this.ttsEngine !== null) {
      this.speakWithEngine(this.ttsEngine, clipped, requestId);
      return;
    }
    /*
     * 【先解析音色再建引擎】listVoices 是异步的，但只读一次并缓存（见 resolveXiaoyiPerson），
     * 首次朗读多一次本机查询（毫秒级），换来"设备有小艺音色就用小艺"；后续朗读零额外成本。
     * 任何一步失败都按 13 号推荐音色继续，不会因为音色问题而不出声。
     */
    try {
      resolveXiaoyiPerson().then((person: number): void => {
        const params: textToSpeech.CreateEngineParams = {
          language: 'zh-CN',
          person: person,
          online: 1
        };
        textToSpeech.createEngine(params).then((engine: textToSpeech.TextToSpeechEngine): void => {
          this.ttsEngine = engine;
          engine.setListener({
            onStart: (_requestId: string, _response: textToSpeech.StartResponse): void => {
            },
            onComplete: (_requestId: string, _response: textToSpeech.CompleteResponse): void => {
            },
            onStop: (_requestId: string, _response: textToSpeech.StopResponse): void => {
            },
            onError: (_requestId: string, errorCode: number, errorMessage: string): void => {
              hilog.warn(DOMAIN, TAG, 'TTS 错误 %{public}d：%{public}s', errorCode, errorMessage);
            }
          });
          this.speakWithEngine(engine, clipped, requestId);
        }).catch((e: BusinessError): void => {
          hilog.warn(DOMAIN, TAG, 'TTS 引擎创建失败：%{public}s', e.message);
        });
      }).catch((e: BusinessError): void => {
        hilog.warn(DOMAIN, TAG, '音色解析失败（不应发生）：%{public}s', e.message);
      });
    } catch (err) {
      hilog.warn(DOMAIN, TAG, 'TTS 引擎创建同步失败：%{public}s', (err as BusinessError).message);
    }
  }

  private speakWithEngine(engine: textToSpeech.TextToSpeechEngine, text: string, requestId: string): void {
    try {
      const params: textToSpeech.SpeakParams = { requestId: requestId };
      engine.speak(text, params);
    } catch (err) {
      hilog.warn(DOMAIN, TAG, 'TTS.speak 失败：%{public}s', (err as BusinessError).message);
    }
  }
}
