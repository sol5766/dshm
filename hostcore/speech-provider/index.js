/*
 * DSHM：HarmonyOS **系统语音识别**（Core Speech Kit）的 provider 实现。
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
 * ══ 2026-10-18：普通听写改用系统识别，**不再下载/准备模型** ═════════════
 * 识别本体搬到 ArkTS 侧：`entry/src/main/ets/speech/SystemSpeechRecognizer.ets`
 * 用 Core Speech Kit（`speechRecognizer`）做识别，由 `HmsSpeechBridge.ets` 从
 * 文件队列取出请求、调它、再写回结果。本 provider 因此**只负责协议**：
 *   · 不再 import `../speech-models/index.js`（那个 228MB SenseVoice 模型的
 *     在线下载器），也没有任何"模型目录检查 / 下载进度 / 启动期自动准备"；
 *   · 因此**刻意不提供 `preparation`** —— 系统识别没有"准备中/需下载"这类
 *     阶段可报。上游服务端 snapshot() 写的是
 *       `preparation: provider.preparation?.snapshot() ?? { phase: "ready" }`
 *       （`dsh-experimental-speech-to-text/lib/index.js:108`）
 *     ⇒ 不带 preparation 的 provider 被报成 ready，麦克风按钮即可用；
 *   · 设备上**已经存在**的旧模型目录（`$DSH_HOME/speech-to-text/sensevoice`）
 *     **不自动删除**：它属于用户数据，清理必须另行授权（方案 Task 4 第 8 条）。
 *
 * ══ 数据流（本文件负责最后一段）════════════════════════════════════════
 *   官方麦克风按钮（WebView）
 *     → MediaRecorder 录音 + OfflineAudioContext 重采样到 16k
 *     → encodeWave()（44 字节 canonical WAV 头）
 *     → base64 → RPC `speech/transcribe`
 *       → api-speech-to-text：`Buffer.from(base64)` + `validateWave()`
 *         → **本文件的 transcribe()**（跑在 Host/Node 进程）
 *           → 写文件队列 → ArkTS 侧 HmsSpeechBridge.ets
 *                          → `SystemSpeechRecognizer`（Core Speech Kit 短/长会话）
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
 *
 * ══ 协议不变（下游只认这三件）══════════════════════════════════════════
 *   `<id>.req`（本文件写）→ ArkTS 识别 → `<id>.done` / `<id>.fail`（ArkTS 写）
 * 诊断面同样不变：队列目录下的 `requests.log`，以及 ArkTS 侧落盘的
 * `last-audio.wav`（后者在本文件之外，见 `HmsSpeechBridge.ets` 里 `last-audio.wav` 的写入处）。
 */

import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

/*
 * 依赖注入声明（由 pack-core 以 `hmsProviderInject as inject` 导出）。
 *
 * 【为什么只注入 speechToText】识别改由 ArkTS 侧 Core Speech Kit 直接完成
 * （不起子进程、不加载模型），多余的 inject 会让插件等一个用不到的服务，
 * 徒增"未就绪"风险。
 */
const hmsProviderInject = ["speechToText"];

/** 桥的轮询间隔。 */
const POLL_MS = 100;
/** 单次识别的基础超时（短音频用这个；长音频按时长伸缩，见 awaitResult）。 */
const TIMEOUT_MS = 25000;
/**
 * canonical 16k 单声道 PCM16 WAV 的固定头长度。
 * 与 ArkTS 侧（appstate 的 `WAV_HEADER_BYTES`）是**同一个值**，
 * 定义处各写一份是因为两侧语言不同、无法共享模块；两边都有门禁断言钉住
 * （hostcore 这份见 `tools/check-layout-fixtures.mjs`）。
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
 * 注册 HarmonyOS 系统语音识别 provider（替换官方 SenseVoice 的 apply）。
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
   *
   * 【为什么不改用别的目录名】`dataRoot` 是 bundle 给的值，路径口径一变
   * ArkTS 侧（HmsSpeechBridge）就得跟着变；队列目录名是**跨侧协议**，
   * 与"是否下载模型"无关 ⇒ 保留原样。
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
    ctx.logger.info("speech bridge queue: %s", queueDir);
  } else {
    ctx.logger.warn("speech bridge: config.dataRoot 未设置，无法定位队列目录");
  }

  ctx.effect(() => {
    const unregister = ctx.speechToText.register({
      info: {
        id: config.providerId,
        /*
         * 【显示名】用户在「设置 → 语音」里看到的就是它。识别由 HarmonyOS
         * Core Speech Kit 在端侧完成 ⇒ 照实写"系统语音识别"，不再自称 SenseVoice。
         */
        name: 'HarmonyOS 系统语音识别',
        /*
         * `location: 'host-local'`：识别在端侧本地完成（Core Speech Kit 的
         * 离线会话，`online: 1`，见 `entry/src/main/ets/speech/SystemSpeechRecognizer.ets`），
         * 音频不出设备。语义上不是云端能力。
         */
        location: 'host-local',
        /*
         * 【只声明 zh-CN】Core Speech Kit 当前只支持中文（真机
         * `listLanguages()` 只返回 `["zh-CN"]`）；而上游服务端
         * `selectedProvider()`（`dsh-experimental-speech-to-text/lib/index.js:135`）
         * 会校验 `provider.info.languages.includes(language)`，profile 的
         * `language` 已钉成 zh-CN（见 hostcore/profile/ondevice/cordis.patch.yml）。
         * 这里多写 en/ja/ko/yue/auto 只会让设置页给出**用不了**的选项。
         */
        languages: ['zh-CN'],
      },
      /*
       * 【关键】**刻意不提供 preparation** ⇒ 服务报 phase=ready ⇒ 按钮可用。
       * 系统识别没有任何"准备中/需下载"阶段，所以没有状态可报（上游
       * snapshot() 对缺省 preparation 直接写 `{ phase: "ready" }`）。
       */
      transcribe: async (input, signal) => {
        hmsCallCount += 1;
        const n = hmsCallCount;
        const audio = input === undefined || input === null ? undefined : input.audio;
        if (audio === undefined || audio === null) {
          throw new Error('speech: 请求里没有 audio');
        }
        if (queueDir === undefined) {
          throw new Error('speech: 队列目录不可用（dataRoot 未配置）');
        }
        const started = Date.now();
        const audioBuf = Buffer.from(audio);
        const audioBytes = audioBuf.length;
        const audioMs = Math.max(0, Math.round(((audioBytes - WAV_HEADER_BYTES) / WAV_BYTES_PER_SECOND) * 1000));

        /*
         * ===== 整段单次识别（长音频由 ArkTS 侧按 55 秒切 short/long 会话）=====
         *
         * 【为什么不在 Host 分段】见本文件顶部的撤回说明：分段在五轮实测中
         * 从未救回一次长音频，还引入了 a2 投纯静音、碎片独立成段等缺陷。
         * 成功记录全部来自**整段单次**（11:09 / 11:15 / 12:33 / 12:49×3）。
         * 长音频的"怎么切"由 ArkTS 侧的识别器决定，桥两侧协议保持不变。
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
        ctx.logger.info('speech transcribe #%d whole audioBytes=%d audioMs=%d -> %s',
          n, audioBytes, audioMs, id);
        logRequest(queueDir, `transcribe #${n} whole audioMs=${audioMs} bytes=${audioBytes}`);
        const result = await awaitResult(queueDir, id, signal, audioMs);

        /*
         * P0-2：标点-only 判为失败。
         * 实测有 7/24 次引擎只返回一个「。」；官方 UI 只把空串当"没识别到"，
         * 标点会被插进草稿 —— 用户看到一个孤零零的句号，比明确报失败更糟。
         */
        if (isPunctuationOnly(result)) {
          throw new Error('speech: 引擎未识别到内容（仅标点或空）');
        }

        ctx.logger.info('speech transcribe #%d done in %dms: %s', n, Date.now() - started, result.slice(0, 80));
        logRequest(queueDir, `transcribe #${n} done ${Date.now() - started}ms -> ${JSON.stringify(result)}`);
        return { text: result, language: 'zh-CN' };
      },
    });
    return () => {
      unregister();
    };
  });
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
 * 【为什么必须看 .fail】识别失败（引擎未起、音频过短、麦克风被占用等）必须
 * **如实抛出**，让官方 UI 显示"识别失败"而不是把空文本插进输入框 ——
 * 后者会让人以为识别真的返回了空结果。
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
      throw new Error('speech: aborted');
    }
    if (existsSync(donePath)) {
      const text = readJsonField(donePath, 'text');
      cleanup(queueDir, id);
      return text;
    }
    if (existsSync(failPath)) {
      const reason = readJsonField(failPath, 'error');
      cleanup(queueDir, id);
      throw new Error(`speech: ${reason.length > 0 ? reason : '识别失败'}`);
    }
    if (Date.now() > deadline) {
      // 超时：把请求清掉，避免 ArkTS 侧稍后处理一个已放弃的请求
      cleanup(queueDir, id);
      throw new Error(`speech: 识别超时（${Math.round(budget / 1000)}s，音频约 ${Math.round(audioMs / 1000)}s）`);
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
