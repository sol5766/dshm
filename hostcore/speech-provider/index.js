/*
 * DSHM：SenseVoice 端侧离线识别的 provider 实现（走 sherpa-onnx 官方鸿蒙 HAR）。
 *
 * 本文件由 `tools/pack-core.mjs` 的 patchSensevoiceForHms() 追加到
 * `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/lib/index.js` 里
 * （作为 `lib/hms-provider.js`），并把该文件的导出语句改成导出本文件的
 * `hmsApply` / `hmsProviderInject`（顶掉原来的 `apply` / `inject`）。
 *
 * ══ 为什么替换而不是新增一个插件包 ═══════════════════════════════════════
 * dsh 的 loader 解析裸包名要经过一张**由 bundle 依赖闭包构成的包表**。
 * 真机实测：新增的包不在任何闭包里 ⇒
 *   `speech-to-text-stub (@deepseek-ai/dsh-speech-to-text-stub): failed to import`
 * 对照：`@deepseek-ai/dsh-host-directory-picker-browse` 能解析，因为它 ⊂
 * `dsh-web-app`.dependencies。而本包已在 `dsh-experimental-voice-input-bundle`
 * 的闭包内、profile 也已有它的行 ⇒ **改它零新增接线**。
 * 详证见 docs/device-validation.md 批次二十三/二十四。
 *
 * ══ 为什么"不提供 preparation"就能让官方按钮变可点 ══════════════════════
 * 官方 UI 的门是
 *   `usable = readiness.connected && provider.preparation.phase ∈ {ready, standby, waking}`
 * 而服务端 snapshot() 写的是
 *   `preparation: provider.preparation?.snapshot() ?? { phase: "ready" }`
 * ⇒ **不带 preparation 的 provider 被报成 ready**，按钮即可用。
 * SenseVoice 恰恰因为鸿蒙不在其平台白名单（lib/index.js:201-207）而永远进不了
 * ready —— 这就是"点语音按钮只会跳设置"的根因。
 *
 * ══ 数据流（本文件负责最后一段）════════════════════════════════════════
 *   官方麦克风按钮（WebView）
 *     → MediaRecorder 录音 + OfflineAudioContext 重采样到 16k
 *     → encodeWave()（44 字节 canonical WAV 头）
 *     → base64 → RPC `speech/transcribe`
 *       → api-speech-to-text：`Buffer.from(base64)` + `validateWave()`
 *         → **本文件的 transcribe()**（跑在 Host/Node 进程）
 *           → 写文件队列 → ArkTS 侧 HmsSpeechBridge.ets
 *                          → `SenseVoiceRecognizer`（sherpa-onnx SenseVoice 离线模型）
 *           ← 读回识别文本
 *         ← 返回 { text }
 *       → 官方 UI 把 text 插进输入框草稿
 *
 * ══ 为什么用文件队列当桥 ═══════════════════════════════════════════════
 * `speechRecognizer` 是 **ArkTS API**，Node 进程调不到；而原生层
 * （dshhost.cc）只暴露 startHost/isHostRunning/stopHost，没有消息通道。
 * 项目既有同手法先例且已验证可用：`host-stop-request`、`host-exit-mode`
 * （见 EntryAbility.startRestartWatcher）、`install-queue`。
 * 两侧同 UID、同文件系统视图，所以文件队列是可靠且可诊断的。
 */

import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureAssets, missingAssets, ASSETS } from "../speech-models/index.js";

/*
 * 依赖注入声明（由 pack-core 以 `hmsProviderInject as inject` 导出）。
 *
 * 【为什么只注入 speechToText】SenseVoice 原本还注入 `subprocess`（它要起
 * sherpa-onnx 子进程）。端侧识别改由 ArkTS 侧 sherpa-onnx 直接完成（不起子进程），
 * 多余的 inject 会让插件等一个用不到的服务，徒增"未就绪"风险。
 */
const hmsProviderInject = ["speechToText"];

/** 桥的轮询间隔。 */
const POLL_MS = 100;
/** 单次识别的基础超时（短音频用这个；长音频按时长伸缩，见 awaitResult）。 */
const TIMEOUT_MS = 25000;
/**
 * canonical 16k 单声道 PCM16 WAV 的固定头长度。
 * 与 ArkTS 侧（appstate 的 `WAV_HEADER_BYTES`）是**同一个值**，
 * 定义处各写一份是因为两侧语言不同、无法共享模块；两边都有门禁断言钉住。
 */
const WAV_HEADER_BYTES = 44;
/** canonical WAV 每秒字节数（16000 采样 × 2 字节）。 */
const WAV_BYTES_PER_SECOND = 32000;
/** 判失败用的请求文件陈旧阈值。 */
const STALE_MS = 300000;


let hmsCallCount = 0;

/**
 * 把一行诊断追加到 `requests.log`（P2 观测性）。
 *
 * 【为什么必须单独落文件】报告实测：`ctx.logger` 的输出**没有进任何可读日志**
 * （`node-output.log` 与 `dshm-host.log` 里按 provider 名的计数都是 0），
 * 而心跳文件 64KB 就轮转 —— 今天已轮转两次，两次真机口述的现场都被吃掉。
 *
 * 【为什么不用 ctx.logger】它写到哪里由 app-boot 决定、在端侧不可读；
 * 直接写队列旁的固定文件最可靠，且 ArkTS 侧同样可读、可一起取证。
 *
 * 【为什么不轮转】诊断日志按请求追加，单次实验最多几十行；
 * 报告要求"不轮转或上限提到 1MB"，这里不轮转。
 *
 * @param queueDir 队列目录
 * @param line 要追加的一行（自动补时间戳与换行）
 */
function logRequest(queueDir, line) {
  try {
    appendFileSync(join(queueDir, 'requests.log'),
      `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch (e) {
    /* 诊断失败绝不能影响识别 */
  }
}

/**
 * 注册 SenseVoice 端侧识别 provider（替换官方 SenseVoice 的 apply）。
 *
 * 【必须带 export】本文件被 `lib/index.js` 以
 * `import { hmsApply, hmsProviderInject } from "./hms-provider.js"` 引入，
 * 所以这两个名字**必须显式导出**。漏了会在 import 期报
 * `does not provide an export named 'hmsApply'`，让整个插件
 * `failed to import`，按钮依旧不可用。
 *
 * @param ctx - cordis 上下文（已注入 speechToText）
 * @param config - 本插件配置（沿用 SenseVoice 的 Config，含 providerId / dataRoot）
 */
export function hmsApply(ctx, config) {
  /*
   * 队列目录：由 `dataRoot` 推出，**不新增配置项**。
   * `dataRoot` 由 bundle 的 patch 设成 `dshHomePath('speech-to-text', 'sensevoice')`
   * ⇒ `dataRoot = $DSH_HOME/speech-to-text/sensevoice`
   * ⇒ `dirname(dataRoot) = $DSH_HOME/speech-to-text`
   * ⇒ 队列 = `$DSH_HOME/speech-to-text/hms-bridge`
   * ArkTS 侧用 `filesDir + '/dsh/home/speech-to-text/hms-bridge'`，两者一致
   * （真机读数：`$DSH_HOME = <filesDir>/dsh/home`）。
   */
  const queueDir = config.dataRoot === undefined
    ? undefined
    : join(dirname(config.dataRoot), "hms-bridge");
  if (queueDir !== undefined) {
    try {
      mkdirSync(queueDir, { recursive: true });
    } catch {
      // 建不出也继续：transcribe 时会再试并如实报错
    }
    ctx.logger.info("sensevoice bridge queue: %s", queueDir);
  } else {
    ctx.logger.warn("sensevoice bridge: config.dataRoot 未设置，无法定位队列目录");
  }

  /*
   * 模型目录：沿用 `dataRoot`（= `$DSH_HOME/speech-to-text/sensevoice`）。
   * 模型**不再随包内置**，改为首次使用时由本 provider 在线下载到这里；
   * ArkTS 侧按同一路径用绝对路径加载（sherpa-onnx 不传 resourceManager 时
   * 即从文件系统读，Linux/Windows/macOS 走的都是这条路径）。
   */
  const modelDir = config.dataRoot;

  ctx.effect(() => {
    const prep = createPreparation(modelDir, ctx);
    const unregister = ctx.speechToText.register({
      info: {
        id: config.providerId,
        name: 'SenseVoice 离线识别',
        /*
         * `location: 'host-local'`：识别在端侧本地完成，模型也存放在本地
         * （首次使用需下载一次）。语义上不是云端能力。
         */
        location: 'host-local',
        /*
         * 【声明 SenseVoice 的**真实**语言能力】
         * SenseVoice 模型（zh-en-ja-ko-yue-2024-07-17）支持的集合就是
         * `auto / zh / en / ja / ko / yue` —— 照实写。
         *
         * 【为什么同时钉死 profile 的 language】服务端 `selectedProvider()`
         * 会校验 `provider.info.languages.includes(language)`，
         * 而服务 config 的 `language` 默认是 `"auto"`。这里已包含 auto，
         * 但仍把 profile 钉成 zh-CN（见 cordis.patch.yml）：
         * 端侧主用中文，钉死可避免走 auto 判别带来的一次额外开销。
         *
         * 【为什么 ArkTS 侧 modelConfig.language 留空】留空 = auto，
         * 让模型自行判别（SenseVoice 的语言判别是模型内建的，不是额外开销）。
         */
        languages: ['zh-CN', 'en', 'ja', 'ko', 'yue', 'auto'],
      },
      /*
       * preparation：把"模型是否就绪 / 下载进度 / 失败原因"如实报给 UI。
       *
       * 【为什么现在必须提供】模型不再随包内置 ⇒ 首次使用前需要下载 228MB。
       * 若不报状态，UI 会认为 provider 一直可用，用户点麦克风后长时间无响应
       * 且无从得知原因。上游 UI 会读 preparation.snapshot().phase：
       *   downloading ⇒ 渲染进度条（用 completedBytes / totalBytes）
       *   failed      ⇒ 渲染失败提示（用 message 与 download.reason）
       *   unfinished  ⇒ 触发"需准备"引导
       */
      preparation: prep,
      /*
       * 【关键】**刻意不提供 preparation** ⇒ 服务报 phase=ready ⇒ 按钮可用。
       * 这不是漏写：SenseVoice 模型已随包内置在 rawfile 里，**无需任何下载**，
       * 所以没有"准备中/需下载"这类阶段可报。
       */
      transcribe: async (input, signal) => {
        hmsCallCount += 1;
        const n = hmsCallCount;
        const audio = input === undefined || input === null ? undefined : input.audio;
        if (audio === undefined || audio === null) {
          throw new Error('sensevoice: 请求里没有 audio');
        }
        if (queueDir === undefined) {
          throw new Error('sensevoice: 队列目录不可用（dataRoot 未配置）');
        }
        /*
         * 模型可能尚未下载（首次使用）。这里**等下载完成再投递**，
         * 而不是直接失败 —— 对用户来说"第一次慢一点"远好于"第一次报错"。
         * preparation 同时会把进度报给 UI。
         */
        const missing = missingAssets(modelDir);
        if (missing.length > 0) {
          ctx.logger.info('sensevoice: 模型缺失 %d 个，先下载再识别', missing.length);
          await ensureAssets(modelDir, (s) => prep.report(s), signal);
          ctx.logger.info('sensevoice: 模型就绪，继续识别');
        }
        const started = Date.now();
        const audioBuf = Buffer.from(audio);
        const audioBytes = audioBuf.length;
        const audioMs = Math.max(0, Math.round(((audioBytes - WAV_HEADER_BYTES) / WAV_BYTES_PER_SECOND) * 1000));

        /*
         * ===== 整段单次识别（回到成功过的方案）=====
         *
         * 【为什么不做分段】见本文件顶部的撤回说明：分段在五轮实测中
         * 从未救回一次长音频，还引入了 a2 投纯静音、碎片独立成段等缺陷。
         * 成功记录全部来自**整段单次**（11:09 / 11:15 / 12:33 / 12:49×3）。
         */
        const id = `req-${Date.now()}-${n}`;
        const reqPath = join(queueDir, `${id}.req`);
        const payload = JSON.stringify({
          audio: audioBuf.toString('base64'),
          language: input.language ?? 'zh-CN',
        });
        /*
         * 【先写 .tmp 再改名为 .req】ArkTS 侧一旦看到 .req 就会读取全文；
         * 若直接写 .req，可能被读到"写了一半"的内容（JSON 不完整 ⇒ 解析失败）。
         * 改名在同一文件系统内是原子的，读方要么看不到、要么看到完整的。
         */
        const tmpPath = join(queueDir, `${id}.tmp`);
        writeFileSync(tmpPath, payload, 'utf8');
        renameSync(tmpPath, reqPath);
        ctx.logger.info('sensevoice transcribe #%d whole audioBytes=%d audioMs=%d -> %s',
          n, audioBytes, audioMs, id);
        logRequest(queueDir, `transcribe #${n} whole audioMs=${audioMs} bytes=${audioBytes}`);
        const result = await awaitResult(queueDir, id, signal, audioMs);

        /*
         * P0-2：标点-only 判为失败。
         * 实测有 7/24 次引擎只返回一个「。」；官方 UI 只把空串当"没识别到"，
         * 标点会被插进草稿 —— 用户看到一个孤零零的句号，比明确报失败更糟。
         */
        if (isPunctuationOnly(result)) {
          throw new Error('sensevoice: 引擎未识别到内容（仅标点或空）');
        }

        ctx.logger.info('sensevoice transcribe #%d done in %dms: %s', n, Date.now() - started, result.slice(0, 80));
        logRequest(queueDir, `transcribe #${n} done ${Date.now() - started}ms -> ${JSON.stringify(result)}`);
        return { text: result, language: 'zh-CN' };
      },
    });
    /*
     * 启动后自动开始准备：模型缺失时立刻在后台下载。
     *
     * 【为什么不等用户点麦克风】那会让首次使用变成"点了之后长时间无响应"。
     * 启动就下，用户第一次点麦克风时通常已就绪；进度通过 preparation
     * 报给 UI，用户看到的是"正在下载"而不是干等。
     *
     * 【失败不中断启动】下载失败只把状态置为 failed（UI 显示原因），
     * 用户可稍后重试。
     */
    queueMicrotask(() => {
      /*
       * 【诊断】把模型目录相关的真实状态写到 queueDir 下的固定文件。
       * 目的：ctx.logger 的输出在端侧不进任何可读日志（项目已知问题），
       * 而 queueDir 已被 ArkTS 侧实证可写 ⇒ 用它当观测通道。
       */
      try {
        const lines = [
          'dataRoot=' + String(config.dataRoot),
          'dataRootType=' + (typeof config.dataRoot),
          'modelDir=' + String(modelDir),
          'queueDir=' + String(queueDir),
        ];
        try {
          if (modelDir !== undefined) {
            mkdirSync(modelDir, { recursive: true });
            lines.push('mkdir(modelDir)=ok');
            const missing = missingAssets(modelDir);
            lines.push('missing=' + missing.map((a) => a.name).join(','));
          } else {
            lines.push('mkdir skipped: modelDir undefined');
          }
        } catch (e) {
          lines.push('mkdir(modelDir) FAILED: ' + String(e && e.message ? e.message : e));
          lines.push('errCode=' + String(e && e.code ? e.code : '-'));
        }
        if (queueDir !== undefined) {
          writeFileSync(join(queueDir, 'model-dir-diag.txt'), lines.join('\n') + '\n', 'utf8');
        }
      } catch {
        /* 诊断本身失败不应影响启动 */
      }
      try {
        prep.prepare();
      } catch (e) {
        ctx.logger.warn('sensevoice 自动准备启动失败: %s', String(e && e.message ? e.message : e));
      }
    });
    return () => {
      unregister();
    };
  });
}


/**
 * 创建 preparation 对象（模型是否就绪 / 下载进度 / 失败）。
 *
 * 【契约】上游服务端读 `preparation.snapshot()`，取其中的 `phase`：
 *   ready       —— 模型齐备，可用
 *   unprepared  —— 尚未准备（UI 会提示"需准备"）
 *   checking    —— 正在核对/准备
 *   downloading —— 正在下载（UI 渲染进度条，用 completedBytes / totalBytes）
 *   failed      —— 失败（UI 显示 message；download.reason 用于分类）
 * 另外支持 subscribe(cb) 让 UI 订阅变化、prepare() 触发准备、cancel() 取消。
 *
 * @param modelDir 模型目录（应用沙箱内的绝对路径）
 * @param ctx cordis 上下文
 * @returns preparation 对象
 */
function createPreparation(modelDir, ctx) {
  /** 当前状态。初始按"磁盘上是否已齐备"判定，避免无谓的重复下载。 */
  let state = { phase: 'unprepared' };
  let task;
  const listeners = new Set();

  const publish = (next) => {
    state = next;
    for (const cb of listeners) {
      try {
        cb();
      } catch {
        // 单个订阅者出错不应影响 provider
      }
    }
  };

  /** 先核对磁盘：三个资产齐备就是 ready。 */
  const inspect = () => {
    if (modelDir === undefined) {
      return { phase: 'failed', message: '未配置模型目录（dataRoot 缺失）' };
    }
    try {
      const need = missingAssets(modelDir);
      if (need.length === 0) {
        return { phase: 'ready' };
      }
      return { phase: 'unprepared' };
    } catch (e) {
      return { phase: 'failed', message: String(e && e.message ? e.message : e) };
    }
  };

  /** 启动（或复用）下载任务。 */
  const start = () => {
    if (task !== undefined) {
      return;
    }
    if (modelDir === undefined) {
      publish({ phase: 'failed', message: '未配置模型目录（dataRoot 缺失）' });
      return;
    }
    const need = missingAssets(modelDir);
    if (need.length === 0) {
      publish({ phase: 'ready' });
      return;
    }
    ctx.logger.info('sensevoice 模型缺失 %d 个，开始下载到 %s', need.length, modelDir);
    publish({ phase: 'checking', step: 'model' });
    task = ensureAssets(modelDir, (s) => publish(s), undefined)
      .then(() => {
        ctx.logger.info('sensevoice 模型下载完成');
        publish({ phase: 'ready' });
      })
      .catch((e) => {
        const message = String(e && e.message ? e.message : e);
        ctx.logger.error('sensevoice 模型下载失败: %s', message);
        publish({
          phase: 'failed',
          message,
          /*
           * reason 取值见上游 schema：network / storage / dns / timeout /
           * certificate / http / integrity / unknown。
           * 这里按错误信息粗分类 —— 比一律报 unknown 对用户更有用。
           */
          download: {
            resource: 'model.int8.onnx',
            source: 'gitcode.com',
            reason: /integrity|校验失败/.test(message) ? 'integrity'
              : /HTTP \d/.test(message) ? 'http'
                : /timeout|timed out/i.test(message) ? 'timeout'
                  : /ENOSPC|storage|空间/i.test(message) ? 'storage'
                    : 'network',
          },
        });
      })
      .finally(() => {
        task = undefined;
      });
  };

  /* 启动时先核对一次磁盘，让 UI 立刻拿到正确状态 */
  publish(inspect());

  return {
    snapshot: () => state,
    subscribe: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    /* 供 transcribe 路径直接汇报下载进度（与 start() 共用同一 publish） */
    report: (s) => publish(s),
    prepare: () => {
      start();
    },
    cancel: () => {
      /* 下载任务未持有可中断句柄（fetch 无 signal 传入），此处仅复位状态 */
      task = undefined;
      publish(inspect());
    },
  };
}


/**
 * 去掉标点与空白后是否有实际内容（P0-2）。
 *
 * 【为什么需要】实测有 7/24 次引擎只返回一个「。」。官方 UI 只把**空串**
 * 判为"没识别到"，标点-only 会被 `insertText` 当作正常结果填进草稿 ——
 * 用户看到一个孤零零的句号，比明确报"识别失败"更糟。
 *
 * @param text 引擎返回的文本
 * @returns true 表示"没有实际内容"（应判失败）
 */
function isPunctuationOnly(text) {
  if (typeof text !== 'string') {
    return true;
  }
  /* 全角/半角标点、空白、常见符号都视为"无内容" */
  const stripped = text.replace(/[\s\p{P}\p{S}]/gu, '');
  return stripped.length === 0;
}




/**
 * 等 ArkTS 侧写回结果。
 *
 * 【为什么轮询而不是监听】Node 侧没有"文件出现"的事件（`fs.watch` 在
 * openharmony 上行为未验证），而识别是用户显式动作、延迟不敏感 ⇒ 轮询更稳。
 *
 * 【为什么必须看 .fail】识别失败（引擎未起、音频过短等）必须**如实抛出**，
 * 让官方 UI 显示"识别失败"而不是把空文本插进输入框 —— 后者会让人以为
 * 识别真的返回了空结果。
 *
 * 【超时为什么要随音频长度伸缩 —— 审核时发现的一个真缺陷】
 * 原实现用固定 25 秒。但 ArkTS 侧是**按实时节奏送音频**的
 * （每 640B 睡 20ms ⇒ 送完耗时 ≈ 音频时长本身），而 API 允许的录音
 * 最长 120 秒（`api-speech-to-text` 的 `maxDurationSeconds` 默认 120）。
 * ⇒ 录 25 秒以上时 Host 必然先超时，而 ArkTS 还在正常处理
 *   ⇒ 用户说长句会得到"识别超时"，**这是必然发生的，不是概率问题**。
 * 改为「音频时长 + 固定余量」，让超时只用于兜住真的卡死。
 *
 * @returns 识别文本（可能为空串：真的没识别到内容）
 */
async function awaitResult(queueDir, id, signal, audioMs) {
  const donePath = join(queueDir, `${id}.done`);
  const failPath = join(queueDir, `${id}.fail`);
  const budget = Math.max(TIMEOUT_MS, audioMs + 15000);
  const deadline = Date.now() + budget;

  for (;;) {
    if (signal !== undefined && signal !== null && signal.aborted) {
      cleanup(queueDir, id);
      throw new Error('sensevoice: aborted');
    }
    if (existsSync(donePath)) {
      const text = readJsonField(donePath, 'text');
      cleanup(queueDir, id);
      return text;
    }
    if (existsSync(failPath)) {
      const reason = readJsonField(failPath, 'error');
      cleanup(queueDir, id);
      throw new Error(`sensevoice: ${reason.length > 0 ? reason : '识别失败'}`);
    }
    if (Date.now() > deadline) {
      // 超时：把请求清掉，避免 ArkTS 侧稍后处理一个已放弃的请求
      cleanup(queueDir, id);
      throw new Error(`sensevoice: 识别超时（${Math.round(budget / 1000)}s，音频约 ${Math.round(audioMs / 1000)}s）`);
    }
    await sleep(POLL_MS);
  }
}

/** 读结果 JSON 的某个字段；读不动就返回空串（由调用方按上下文决定语义）。 */
function readJsonField(path, field) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const v = parsed === null || parsed === undefined ? undefined : parsed[field];
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

/** 清掉本次请求的所有残留文件（.req/.tmp/.wip/.done/.fail）。 */
function cleanup(queueDir, id) {
  for (const suffix of ['.req', '.tmp', '.wip', '.done', '.fail']) {
    const p = join(queueDir, `${id}${suffix}`);
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // 忽略：桥的陈旧回收会兜底
    }
  }
}

/** 极简 sleep。 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export { hmsProviderInject };
