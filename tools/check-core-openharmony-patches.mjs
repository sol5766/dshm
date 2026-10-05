#!/usr/bin/env node
/*
 * 门禁：**随包核心树里的端侧注入型补丁必须真的在**（一条命令确认全量标记清单）
 *
 * ---------------------------------------------------------------------------
 * 为什么要有它（2026-10-05 审计）
 * ---------------------------------------------------------------------------
 * `tools/pack-core.mjs` 里有三组"端侧（鸿蒙）运行时补丁"，它们唯一的兜底是
 * **打包那一刻的 `die()`**：
 *
 *   ① `patchResourceAddressArmor()`（tools/pack-core.mjs:2427-2535）
 *      ArkWeb 把未注册的 `dsh-resource:` 当 opaque URL（hostname === ""、authority 被并进
 *      path、query 被并进 path），三处 client 侧解析各打一个标记：
 *        · `DSHM_RESOURCE_ARMOR_PROTOCOL` → dsh-client-resources/lib/client.js（protocolOf）
 *        · `DSHM_RESOURCE_ARMOR_PATH`     → dsh-client-ui-sidebar-right/lib/client.js（pathOf）
 *        · `DSHM_RESOURCE_ARMOR_SUBAGENT` → dsh-client-ui-subagent/lib/client.js（parseSubagentChatAddress）
 *   ② `patchPdfMapCompat()`（tools/pack-core.mjs:2599-2632）
 *      `Map/WeakMap.getOrInsert(Computed)` 在 ArkWeb 上缺失 ⇒ PDF 预览挂。主线程 chunk 工厂
 *      （`factory: (require) => {`）注入一次，内联 pdf worker 的 Blob 分片数组最前面再注入一次
 *      （worker 是独立 realm，不继承主线程原型补丁）⇒ `DSHM_MAP_COMPAT` **总共恰好 2 处**。
 *   ③ `patchSubprocessOpenharmony()`（tools/pack-core.mjs:2634-2682）
 *      终端巡检器在鸿蒙上"unsupported on platform openharmony" ⇒
 *        · `runner-launch-*.js` 的 createProcessInspector：`platform === "linux"` → 加 `|| "openharmony"`
 *        · `index.js` prepareShellActivity()：鸿蒙上跳过 shellActivity 注入
 *        · `index.js` inspectActivity()：idle 分支接受 `openharmony`
 *      三处各带 `DSHM_OPENHARMONY_SUBPROCESS`。
 *
 * 这三组补丁**只在"打包这一次"被校验**：`die()` 只在 pack-core 真的跑到那一步才有意义。
 * 一旦上游改版导致待替换片段漂移、或有人拿旧树/半成品树出包、或补丁被后来者改坏，
 * 仓库层没有任何独立门禁会红 —— 而同批的侧栏页签守卫有 `tools/check-sidebar-tab-id-guard.mjs`。
 * 本门禁把这个洞补上：**只读随包核心树**，逐条断言"标记在"且"上游反例已消失"。
 *
 * ---------------------------------------------------------------------------
 * 【2026-10-05 扩容：从"三处"到"全部注入标记"】
 * ---------------------------------------------------------------------------
 * 交付 ①②③ 时顺带把 `tools/pack-core.mjs` 里所有"只在打包那一刻 `die()`"的注入点
 * 筛了一遍，又找出 **10 个注入函数**（下方 ④ 段）。它们与 ①②③ 是同一类洞：
 * 兜底只在"这次 pack-core 真的跑到那一步"时才有意义 —— 拿旧树/半成品树出包、
 * 上游改版导致待替换片段漂移、补丁被后来者改坏，仓库层都不会红。本门禁一并管起来。
 *
 *   · `patchVoiceInputNativeCapture()`（tools/pack-core.mjs:421-566）→ `DSHM_NATIVE_CAPTURE`
 *   · `patchVoiceInputNoiseSuppression()`（:568-629）→ `DSHM_ECHO_CANCELLATION_OFF` / `DSHM_NOISE_SUPPRESSION_OFF`
 *   · `patchSensevoiceForHms()`（:725-795）→ `DSHM_HMS_PROVIDER`
 *   · `embedProfile()`（:797-805）+ `embedDshmToolPackages()`（:974-1042）→ `DSHM_PUBLIC_DOWNLOAD`
 *   · `patchLinkForSandbox()`（:1904-1983）→ `DSHM_LINK_SANDBOX`
 *   · `patchCredentialsOwnerCheck()`（:2003-2027）→ `DSHM_CREDENTIALS_MODE_EXEMPT`
 *   · `patchAgentPresetWorkflow()`（:2052-2129）→ `DSHM_WORKFLOW_DISABLED`
 *   · `patchAppBootReadonlyStack()`（:2154-2207）→ `DSHM_READONLY_STACK_GUARD`
 *   · `patchFsLocalLink()`（:2222-2277）→ `DSHM_FS_LOCAL_SANDBOX`
 *   · `patchAttachmentLocalLink()`（:2292-2360）→ `DSHM_ATTACHMENT_SANDBOX`
 *
 * 【反向判据的三种形态（要点）】注入分三类，反向（"上游原文已消失"）因此有三种写法，
 * 且**都不许泛化**：
 *   · 替换型（link/import/导出语句/link 发布块/约束项）：逐字否掉 `pack-core` 的
 *     `before` 常量 —— 必须连缩进与换行一起对上。同形语句在树里常有**无关副本**
 *     （例：`dsh-fs-local/lib/index.js` 里 `await rename(tempPath, absolutePath);` 有 3 处，
 *     泛化成"不许出现 rename"立刻恒红），所以一条泛化判据都不用。
 *   · 插入型（原生采集叠加段 / preset 的 `disabled: true` / app-boot 的 try 包裹）：
 *     没有"被替换的原文"，反向改判**上游未注入的形态不得残留** ——
 *     叠加段必须落在 factory 内且只有一份、preset 里 `workflow-ptc`/`tool-workflow`
 *     条目必须带 `disabled: true`、app-boot 的每条裸赋值必须被 try/catch 包住。
 *   · 整目录拷贝型（profile、自带插件包）：没有"上游原文"，反向改判
 *     **树内副本与仓库源逐字节一致**（陈旧残留、被手改、多出/少文件都会红）。
 *
 * 判据分两类，缺一不可：
 *   · 正向：标记字符串在（补丁确实注入过）。
 *   · 反向：**上游原文的反例不得残留**（否则说明"补丁被半途回退/重复注入"，
 *     而正向的标记还留着 —— 只看正向会漏掉这种情况，这就是 `--self-test` 里 M4 用例的存在理由）。
 *
 * 用法：
 *   node tools/check-core-openharmony-patches.mjs              # 门禁
 *   node tools/check-core-openharmony-patches.mjs --self-test  # 变异自检（临时副本，跑完即删）
 * 退出码：0 通过 / 1 有真实问题 / 3 环境不具备（核心树未就位，不是失败）
 */
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
/*
 * 【目录名跟随配方，不写死版本】同 tools/check-sidebar-tab-id-guard.mjs:35-39 的同一课：
 * 写死 `dsh-core-<版本>` 会在升核心时静默指向旧树。
 */
const RECIPE = JSON.parse(readFileSync(join(ROOT, 'hostcore', 'core-recipe.json'), 'utf8'));
const CORE = join(ROOT, 'dist', 'core', 'work', `dsh-core-${RECIPE.coreVersion}`,
  'node_modules', '@deepseek-ai');

const SELF_TEST = process.argv.includes('--self-test');

/* ───────────────────────── 判据表（字符串逐字取自 pack-core 的注入函数） ───────────────────────── */

// ① 资源地址装甲：三处落地文件
const ARMOR_SITES = [
  {
    rel: 'dsh-client-resources/lib/client.js',
    marker: 'DSHM_RESOURCE_ARMOR_PROTOCOL',
    name: '资源地址装甲 · client-resources protocolOf() 的 opaque-URL authority 兜底',
    // pack-core.mjs:2438-2439 的 before（注入后必须整体消失）
    upstream: 'return parsed.hostname === "" ? void 0 : parsed.hostname.toLowerCase();',
    // pack-core.mjs:2449-2451 的 after 里的可判据片段
    patched: 'const armor = parsed.hostname === "" ? /^[a-z][a-z\\d+.-]*:\\/\\/([^/?#]*)/iu.exec(address) : null;',
  },
  {
    rel: 'dsh-client-ui-sidebar-right/lib/client.js',
    marker: 'DSHM_RESOURCE_ARMOR_PATH',
    name: '资源地址装甲 · sidebar-right pathOf() 剥掉被并进 path 的 authority',
    // pack-core.mjs:2468 的 before
    upstream: 'return new URL(address).pathname;',
    patched: 'if (parsed.hostname === "" && parsed.pathname.startsWith("//")) {',
  },
  {
    rel: 'dsh-client-ui-subagent/lib/client.js',
    marker: 'DSHM_RESOURCE_ARMOR_SUBAGENT',
    name: '资源地址装甲 · subagent parseSubagentChatAddress() 的 host/path/query 兜底',
    // pack-core.mjs:2507 的 before 里的判定（注入后改成用兜底出来的 host）
    upstream: 'url.hostname.toLowerCase() !== "subagentchat"',
    patched: 'const searchParams = new URLSearchParams(query);',
  },
];

// ② PDF：`DSHM_MAP_COMPAT` 恰好两处注入，且两处形态可区分
const PDF_REL = 'dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js';
const PDF_MARKER = 'DSHM_MAP_COMPAT';
// 主线程：MAP_COMPAT_SOURCE 每行加 `\t\t` 前缀（pack-core.mjs:2615-2617）⇒ 标记独占一行、前缀是真 tab
const PDF_MAIN_SITE_RE = /(^|\n)\t\t\/\* DSHM_MAP_COMPAT \*\//g;
// worker：同一份源码被 JSON.stringify 塞进 Blob 分片数组（pack-core.mjs:2621-2628）⇒ 标记被 `\n` 两个字面字符夹住
const PDF_WORKER_SITE = '\\n/* DSHM_MAP_COMPAT */\\n';
const PDF_FACTORY_ANCHOR = 'factory: (require) => {';
// 反向：注入后这个"裸 Blob 数组首元素"形态必须消失（pack-core.mjs:2621 的 blobAnchor 被整体替换）
const PDF_BARE_BLOB_ANCHOR = 'new Blob([_dsh_pdf_worker_default, ';

// ③ 终端：runner-launch-*.js + index.js
const SUBPROCESS_LIB = 'dsh-subprocess-local/lib';
const SUBPROCESS_MARKER = 'DSHM_OPENHARMONY_SUBPROCESS';
const INSPECTOR_PATCHED = 'if (platform === "linux" || platform === "openharmony" /* DSHM_OPENHARMONY_SUBPROCESS */) return new LinuxProcessInspector(arch, internals);';
const INSPECTOR_UPSTREAM = 'if (platform === "linux") return new LinuxProcessInspector(arch, internals);';
const SHELL_ACTIVITY_PATCHED = 'if (spec.shellActivity !== true || platform === "win32" || platform === "openharmony" /* DSHM_OPENHARMONY_SUBPROCESS */ || spec.argv.length !== 2 || spec.argv[1] !== "-i") return void 0;';
const SHELL_ACTIVITY_UPSTREAM = 'if (spec.shellActivity !== true || platform === "win32" || spec.argv.length !== 2 || spec.argv[1] !== "-i") return void 0;';
const IDLE_PATCHED = '(this.platform === "linux" || this.platform === "openharmony") /* DSHM_OPENHARMONY_SUBPROCESS */ && observed.complete === true && root === void 0';
const IDLE_UPSTREAM = 'this.platform === "linux" && observed.complete === true && root === void 0';

/* ═══════════ ④ 扩容（2026-10-05）：其余 10 个注入函数的清单门禁 ═══════════
 *
 * 站点（site）形状：
 *   { rel,                                  // 相对**核心树根**（不是 @deepseek-ai）
 *     markers: [[标记字符串, 期望出现次数]],   // 正向①：标记在，且次数精确
 *     forward: [[逐字片段, 说明]],            // 正向②：注入后应存在的形态（≥1 处）
 *     reverse: [[逐字上游原文, 说明]],        // 反向：替换型 —— 必须 0 处
 *     structural: (text) => [失败原因…] }     // 反向：插入型 —— 上游未注入形态不得残留
 * 组（group）形状：{ key, fn, note, sites: [...], present: [树内必须存在的文件],
 *                   mirrors: [[树内路径, 仓库源路径]] }（后两者可选）
 *
 * ⚠ `reverse` 里的字符串**逐字**抄自 `tools/pack-core.mjs` 的替换模板（含缩进/换行）；
 *   它们就是"被替换掉的上游原文"，因此**只能逐字否掉**，不许泛化成"某类语句不许出现"。
 */

/* 组 1/2 的目标文件（同一文件的三个注入函数共用） */
const VOICE_CLIENT = 'node_modules/@deepseek-ai/dsh-experimental-client-ui-voice-input/lib/client.js';
const SENSE_LIB = 'node_modules/@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/lib/index.js';
const SESSION_LIB = 'node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js';
const CRED_LIB = 'node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js';
const APP_BOOT_MAIN = 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js';
const APP_BOOT_WORKER = 'node_modules/@deepseek-ai/dsh-app-boot/lib/worker/profile-resolution-bootstrap.js';
const FS_LOCAL_LIB = 'node_modules/@deepseek-ai/dsh-fs-local/lib/index.js';
const ATTACH_LIB = 'node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js';
const PRESET_DIR = 'node_modules/@deepseek-ai/dsh-web-app/presets';
const PROFILE_DIR = 'profiles/ondevice';

/* ── 逐字抄自 pack-core 替换模板的"上游原文"（反向判据专用） ── */
// pack-core.mjs:1961 —— patchLinkForSandbox 的 import 行（注入后多了 access/rename ⇒ 此串必消失）
const SESSION_IMPORT_UPSTREAM = 'import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from "node:fs/promises";';
// pack-core.mjs:1964-1967 —— 两个 link 调用点
const SESSION_CALL_UPSTREAM_1 = '\t\tawait internals.fs.link(staged, currentPath);';
const SESSION_CALL_UPSTREAM_2 = '\t\t\tawait link(tmp, finalPath);';
// pack-core.mjs:1947 —— 旧形（无 access/rename 回退）的 helper 头：就地升级后必须消失
const SESSION_OLD_HELPER_HEAD = 'async function dshmPublishExclusive(fsImpl, from, to) {\n\tlet exists = true;\n\ttry {\n\t\tawait fsImpl.access(to);';
// pack-core.mjs:2016 —— 凭据检查的两行原文（**必须连行成对否掉**：单否第二行会命中豁免后那行 ⇒ 恒红）
const CREDENTIALS_UPSTREAM = '\tif (process.platform === "win32") return;\n\tif ((mode & GROUP_OTHER_BITS) === 0) return;';
// pack-core.mjs:2235-2239 —— fs-local 的 createIfAbsent 发布段原文
const FS_LOCAL_UPSTREAM = '\t\tif (createIfAbsent !== void 0) try {\n\t\t\tawait linkFile(tempPath, absolutePath);\n\t\t} catch (error) {\n\t\t\tawait throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);\n\t\t}';
// pack-core.mjs:2307 —— attachment-local 的 npm 导入行原文
const ATTACH_IMPORT_UPSTREAM = 'import { chmod, link, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";';
// pack-core.mjs:2315-2320 —— syncDirectory 的徒手 open/sync/close 原文
const ATTACH_SYNC_UPSTREAM = '\tconst handle = await open(path, constants.O_RDONLY);\n\ttry {\n\t\tawait handle.sync();\n\t} finally {\n\t\tawait handle.close();\n\t}';
// pack-core.mjs:2348 —— link 发布块原文（两处：source / staged.path），逐字复刻模板
const attachmentLinkBefore = (src) => '\t\ttry {\n\t\t\tawait link(' + src + ', target);\n\t\t} catch (error) {\n'
  + '\t\t\t/* v8 ignore next -- Private same-filesystem directories make EEXIST the only recoverable link race. */\n'
  + '\t\t\tif (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;\n'
  + '\t\t\tif (await digestFile(target) !== ' + (src === 'source' ? 'sha256' : 'staged.sha256')
  + ') throw new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");\n\t\t}';

/* ── 插入型补丁的反向判据（structural） ── */

/**
 * preset 的 `workflow-ptc` / `tool-workflow` 必须**每一条都带 `disabled: true`**。
 *
 * 这是 `patchAgentPresetWorkflow()` 的反向判据：上游形态是"条目启用"，
 * 注入的形态是"条目 + `disabled: true`"。判据按 `pack-core.mjs:2094-2103` 的同一套
 * 缩进规则找条目内的兄弟键 ⇒ 只看紧邻 `name:` 之后、同级或更浅缩进之前的那几行。
 */
function presetWorkflowStructural(text) {
  const fails = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)- id: (workflow-ptc|tool-workflow)\s*$/.exec(lines[i]);
    if (m === null) continue;
    if (i + 1 >= lines.length || !/^\s+name:\s/.test(lines[i + 1])) {
      fails.push(`第 ${i + 1} 行的 ${m[2]} 之后没有 name: 行（上游 preset 结构已变，门禁需同步复核）`);
      continue;
    }
    const nameIndent = lines[i + 1].match(/^\s*/)[0].length;
    let disabled = false;
    for (let k = i + 2; k < lines.length; k += 1) {
      const l = lines[k];
      if (l.trim() === '') continue;
      const ind = l.match(/^\s*/)[0].length;
      if (ind < nameIndent) break;                        // 离开该条目
      if (ind === nameIndent && /^\s*- /.test(l)) break;  // 同级的另一行
      if (ind === nameIndent && /^\s+disabled:\s/.test(l)) { disabled = true; break; }
    }
    if (!disabled) {
      fails.push(`第 ${i + 1} 行的 ${m[2]} 未带 disabled: true（上游"启用"形态残留 ⇒ `
        + `端侧模型会拿到 jitless 下必崩的 PTC/workflow 工具）`);
    }
  }
  return fails;
}

/**
 * `dsh-app-boot` 的 `error.message = …` / `if (stack !== void 0) error.stack = …` 必须**逐条被
 * try/catch 包住**（上游形态 = 裸赋值）。
 *
 * 判据与 `patchAppBootReadonlyStack()` 的产物形状对齐：原语句缩进 +1 tab，前一行是
 * `<原缩进>try {`，后一行以 `<原缩进>} catch {` 开头。
 */
function appBootReadonlyStructural(text) {
  const fails = [];
  const lines = text.split('\n');
  const MESSAGE = /^\t*error\.message = .+;\s*$/;
  const STACK = /^\t*if \(stack !== void 0\) error\.stack = stack\.replace\(originalMessage, (?:message|error\.message)\);\s*$/;
  for (let i = 0; i < lines.length; i += 1) {
    if (!MESSAGE.test(lines[i]) && !STACK.test(lines[i])) continue;
    const parent = lines[i].match(/^\t*/)[0].slice(0, -1);
    const prev = lines[i - 1];
    const next = lines[i + 1] ?? '';
    if (prev !== `${parent}try {` || !next.startsWith(`${parent}} catch {`)) {
      fails.push(`第 ${i + 1} 行的裸赋值未被 try/catch 包住（上游原形态残留 ⇒ Node 24 的只读 `
        + `message/stack 会抛 TypeError 并顶替掉带 code 的原错误 ⇒ 下游 missingResource 失配）`);
    }
  }
  return fails;
}

/**
 * 原生采集叠加段的两条反向判据：
 *   ① 必须落在 module factory **内**（`return module.exports;` 之前）—— pack-core.mjs:551-557
 *      记着真实事故：追加到文件末尾 ⇒ `Recording` 不在作用域 ⇒ 覆盖静默失效；
 *   ② 只能有 **1 份** —— 两份 start/stop 覆盖会互相包裹，行为不可预测。
 */
function nativeCaptureStructural(text) {
  const fails = [];
  const iMark = text.lastIndexOf('DSHM_NATIVE_CAPTURE@');
  const iExit = text.lastIndexOf('return module.exports;');
  if (iMark < 0 || iExit < 0 || iMark > iExit) {
    fails.push('注入段不在 module factory 内（`return module.exports;` 之前）—— 2026-10 的历史事故形态：'
      + '追加到文件末尾会让 `Recording` 不在作用域、覆盖静默失效（真机 diag-native 永远为空）');
  }
  const n = countOf(text, 'const origStart = Recording.prototype.start;');
  if (n !== 1) fails.push(`覆盖段出现 ${n} 次（规定 1 次）—— 重复注入会出现两份 start/stop 覆盖`);
  return fails;
}

const INJECTED_PATCHES = [
  /* ── ① 语音 · 原生采集（追加式） ── */
  {
    key: '语音原生采集',
    fn: 'patchVoiceInputNativeCapture()',
    note: 'pack-core.mjs:421-566；标记名与上表一致（DSHM_NATIVE_CAPTURE），但注入是**追加式**：'
      + '上游原文没有被替换，反向判据因此是"上游未注入形态不得残留"（见 nativeCaptureStructural）。',
    sites: [{
      rel: VOICE_CLIENT,
      markers: [['DSHM_NATIVE_CAPTURE', 1]],
      forward: [
        ['/* DSHM_NATIVE_CAPTURE@v3-permission-window: ', '注入段头（v3 版本标记；版本不符时 pack-core 会先删旧段）'],
        ['const origAmplitude = Recording.prototype.amplitude;', 'amplitude 覆盖（原生 RMS 频谱，否则波形柱恒为最小）'],
        ['const origStart = Recording.prototype.start;', 'start 覆盖（改用 startNativeCapture 桥）'],
        ['const origStop = Recording.prototype.stop;', 'stop 覆盖（取 takeNativeCapture 的 WAV）'],
        ['while (Date.now() - t0 < 15000) {', '15 秒首次授权等待窗口（3 秒会在用户看弹框时就超时）'],
        ['if (st.indexOf(\'"phase":"error\') >= 0) { throw new RecordingError("interrupted"); }', '原生采集错误相位 → RecordingError(interrupted)'],
      ],
      reverse: [],
      structural: nativeCaptureStructural,
    }],
  },

  /* ── ② 语音 · 录音约束（AEC / 降噪，替换式） ── */
  {
    key: '语音录音约束',
    fn: 'patchVoiceInputNoiseSuppression()',
    note: 'pack-core.mjs:568-629；两个标记都在（与上表一致）。反向判据 = 两个**被 replace 的锚点原文**，'
      + '实测上游各只出现 1 次、打补丁后 0 次（不是"任何 AEC 语句不许出现"）。',
    sites: [{
      rel: VOICE_CLIENT,
      markers: [['DSHM_ECHO_CANCELLATION_OFF', 1], ['DSHM_NOISE_SUPPRESSION_OFF', 1]],
      forward: [
        ['echoCancellation: false /* DSHM_ECHO_CANCELLATION_OFF', 'AEC 关闭（识别率崩的根因修复）'],
        ['noiseSuppression: false /* DSHM_NOISE_SUPPRESSION_OFF', '降噪关闭（非根因，顺带处理）'],
      ],
      reverse: [
        ['echoCancellation: true', 'pack-core.mjs:585 的 beforeAec（被 replace 掉的锚点原文）'],
        ['noiseSuppression: true', 'pack-core.mjs:608 的 beforeNs（被 replace 掉的锚点原文）'],
      ],
    }],
  },

  /* ── ③ 语音 · HMS provider（替换式 + 两个 cpSync 产物） ── */
  {
    key: 'HMS 语音 provider',
    fn: 'patchSensevoiceForHms()',
    note: 'pack-core.mjs:725-795；标记名与上表一致。除导出语句替换外还会 cpSync 两个文件进包，'
      + '一并断言存在且与仓库源逐字节一致（mirrors）。',
    sites: [{
      rel: SENSE_LIB,
      markers: [['DSHM_HMS_PROVIDER', 1]],
      forward: [
        ['import { hmsApply, hmsProviderInject } from "./hms-provider.js";', '顶部相对 import（不经 bare 包表 ⇒ 必然可解析）'],
        ['export { Config, hmsApply as apply, hmsProviderInject as inject, name };', '导出重写为 HMS 实现（插件形状不变）'],
      ],
      reverse: [
        ['export { Config, apply, inject, name };', 'pack-core.mjs:786 的 before（被 replace 掉的上游导出语句）'],
      ],
    }],
    present: [
      ['node_modules/@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/lib/hms-provider.js', '注入的实现本体'],
      ['node_modules/@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/speech-models/index.js', 'provider 无条件 import 的在线下载器'],
    ],
    mirrors: [
      ['node_modules/@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/lib/hms-provider.js', 'hostcore/speech-provider/index.js'],
      ['node_modules/@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/speech-models/index.js', 'hostcore/speech-models/index.js'],
    ],
  },

  /* ── ④ 端侧 profile（整目录拷贝） ── */
  {
    key: '端侧 profile',
    fn: 'embedProfile()',
    note: '**与上表不一致处**：上表把 `DSHM_PUBLIC_DOWNLOAD` 记在 `embedProfile()`（:797）。'
      + '核实结果：:797 的 embedProfile 只做 `cpSync(hostcore/profile/<name> → 树/profiles/<name>)`，'
      + '标记是**随 profile 目录被拷进去的注释**（3 处）；真正读该 env 的代码在 `embedDshmToolPackages()`'
      + '（:974）装的两个自带插件里 —— 因此拆成"端侧 profile"与"自带插件包"两组，两边都管。',
    sites: [{
      rel: `${PROFILE_DIR}/cordis.patch.yml`,
      markers: [['DSHM_PUBLIC_DOWNLOAD', 3]],
      forward: [
        ["- id: tool-fs-remove\n      name: '@deepseek-ai/dshm-tool-fs-remove'", '⑦ 删除/覆盖工具的自带插件 insert 行'],
        ["- id: dshm-workspace-claim\n      name: '@deepseek-ai/dshm-workspace-claim'", '⑧ 默认工作区登记的自带插件 insert 行'],
      ],
      reverse: [],
    }, {
      rel: `${PROFILE_DIR}/package.json`,
      markers: [],
      forward: [
        ['"name": "dshm-ondevice-profile"', 'profile manifest 名（端侧 dsh 按它找 profile）'],
        ['"@deepseek-ai/dsh-base"', 'bundle 顺序：dsh-base'],
        ['"@deepseek-ai/dsh-web-app"', 'bundle 顺序：dsh-web-app'],
      ],
      reverse: [],
    }],
    mirrors: [[PROFILE_DIR, 'hostcore/profile/ondevice']],
  },

  /* ── ⑤ DSHM 自带插件包（DSHM_PUBLIC_DOWNLOAD 的真正宿主） ── */
  {
    key: '自带插件包',
    fn: 'embedDshmToolPackages()',
    note: 'pack-core.mjs:974-1042；上表没列这一处（把它的标记记到了 embedProfile 名下）。'
      + '反向判据 = 树内 5 个 dshm-* 目录与 hostcore/plugins/<同名> 逐字节一致：'
      + 'cpSync(force) **不删**目标里多出的文件 ⇒ 陈旧残留/被手改只能靠这条抓。',
    sites: [{
      rel: 'node_modules/@deepseek-ai/dshm-workspace-claim/lib/index.js',
      markers: [['DSHM_PUBLIC_DOWNLOAD', 5]],
      forward: [['process.env.DSHM_PUBLIC_DOWNLOAD || ""', '默认工作区根只认 ArkTS 认领到的目录（没有就完全惰性）']],
      reverse: [],
    }, {
      rel: 'node_modules/@deepseek-ai/dshm-tool-fs-remove/lib/index.js',
      markers: [['DSHM_PUBLIC_DOWNLOAD', 5]],
      forward: [
        ['process.env.DSHM_PUBLIC_DOWNLOAD || ""', 'publish 的目标根'],
        ['publish: no user-visible download directory is available', 'env 为空时明确报错，而不是往代写目录落盘'],
      ],
      reverse: [],
    }],
    mirrors: [
      ['node_modules/@deepseek-ai/dshm-tool-fs-remove', 'hostcore/plugins/dshm-tool-fs-remove'],
      ['node_modules/@deepseek-ai/dshm-workspace-claim', 'hostcore/plugins/dshm-workspace-claim'],
      ['node_modules/@deepseek-ai/dshm-fs-write-nonchmod', 'hostcore/plugins/dshm-fs-write-nonchmod'],
      ['node_modules/@deepseek-ai/dshm-office-system-preview', 'hostcore/plugins/dshm-office-system-preview'],
      ['node_modules/@deepseek-ai/dshm-ptc-runtime-inproc', 'hostcore/plugins/dshm-ptc-runtime-inproc'],
    ],
  },

  /* ── ⑥ 会话日志 link → 存在性检查 + rename（替换式） ── */
  {
    key: '会话日志 link',
    fn: 'patchLinkForSandbox()',
    note: 'pack-core.mjs:1904-1983；标记名与上表一致。反向判据 4 条：import 行、两个调用点、'
      + '以及"旧形 helper 头"（缺 access/rename 回退的那一版会被就地升级，此头必消失）。',
    sites: [{
      rel: SESSION_LIB,
      markers: [['DSHM_LINK_SANDBOX', 1]],
      forward: [
        ['async function dshmPublishExclusive(fsImpl, from, to) {', '注入的等价发布 helper'],
        ['const renameFn = typeof fsImpl?.rename === "function" ? fsImpl.rename : rename;', 'E104 加固：句柄无 rename 时回退到模块导入（否则 2056 行路径 TypeError）'],
        ['await dshmPublishExclusive(internals.fs, staged, currentPath);', '调用点①（internals.fs 句柄）'],
        ['await dshmPublishExclusive({ access, rename }, tmp, finalPath);', '调用点②（显式 access/rename 句柄）'],
      ],
      reverse: [
        [SESSION_IMPORT_UPSTREAM, 'pack-core.mjs:1961 的 import 行（注入后多了 access/rename）'],
        [SESSION_CALL_UPSTREAM_1, 'pack-core.mjs:1964 的调用点①（上游 link 发布）'],
        [SESSION_CALL_UPSTREAM_2, 'pack-core.mjs:1966 的调用点②（上游 link 发布）'],
        [SESSION_OLD_HELPER_HEAD, 'pack-core.mjs:1947 的旧形 helper 头（无回退版，须已被升级掉）'],
      ],
    }],
  },

  /* ── ⑦ 凭据"仅属主可读"检查的鸿蒙豁免（替换式） ── */
  {
    key: '凭据 660 豁免',
    fn: 'patchCredentialsOwnerCheck()',
    note: 'pack-core.mjs:2003-2027；标记名与上表一致。',
    sites: [{
      rel: CRED_LIB,
      markers: [['DSHM_CREDENTIALS_MODE_EXEMPT', 1]],
      forward: [['\tif (process.env.DSHM_PLATFORM === "ohos") return;', '鸿蒙上豁免（hmfs 强制 660 ⇒ 该检查永远不可能通过）']],
      reverse: [[CREDENTIALS_UPSTREAM, 'pack-core.mjs:2016 的 before（两行必须**成对**否掉：'
        + '单否第二行会命中豁免后那一行 ⇒ 恒红）']],
    }],
  },

  /* ── ⑧ preset 里禁用 workflow-ptc / tool-workflow（插入式，4 个 preset 全查） ── */
  {
    key: 'preset 禁用 PTC',
    fn: 'patchAgentPresetWorkflow()',
    note: 'pack-core.mjs:2052-2129；标记名与上表一致。注意 **ptc.patch.yml 的 0 次是预期**'
      + '（上游本来就带 disabled: true ⇒ 走"已禁用"分支，不注入标记），minimal.patch.yml 干脆不声明这两个工具。',
    sites: [
      {
        rel: `${PRESET_DIR}/standard.patch.yml`,
        markers: [['DSHM_WORKFLOW_DISABLED', 2]],
        forward: [['# DSHM_WORKFLOW_DISABLED: jitless 无 WASM ⇒ PTC/工具必崩（见 tools/pack-core.mjs）', '注入的注释行（workflow-ptc + tool-workflow 各一条）']],
        reverse: [],
        structural: presetWorkflowStructural,
      },
      {
        rel: `${PRESET_DIR}/cordis.patch.yml`,
        markers: [['DSHM_WORKFLOW_DISABLED', 2]],
        forward: [['# DSHM_WORKFLOW_DISABLED: jitless 无 WASM ⇒ PTC/工具必崩（见 tools/pack-core.mjs）', '同上']],
        reverse: [],
        structural: presetWorkflowStructural,
      },
      {
        rel: `${PRESET_DIR}/ptc.patch.yml`,
        markers: [['DSHM_WORKFLOW_DISABLED', 0]],
        forward: [],
        reverse: [],
        structural: presetWorkflowStructural,
      },
      {
        rel: `${PRESET_DIR}/minimal.patch.yml`,
        markers: [['DSHM_WORKFLOW_DISABLED', 0]],
        forward: [],
        reverse: [],
        structural: presetWorkflowStructural,
      },
    ],
  },

  /* ── ⑨ app-boot 只读 stack/message（插入式，两份副本各 3 处） ── */
  {
    key: 'app-boot 只读保护',
    fn: 'patchAppBootReadonlyStack()',
    note: 'pack-core.mjs:2154-2207；标记名与上表一致（上表只写了一个文件，实际**两份副本都要改**）。'
      + '反向判据 = 每条裸赋值都必须被 try/catch 包住（上游形态 = 裸赋值）。',
    sites: [APP_BOOT_MAIN, APP_BOOT_WORKER].map((rel) => ({
      rel,
      markers: [['DSHM_READONLY_STACK_GUARD', 3]],
      forward: [['} catch { /* 只读属性：保留原 message/stack（code 仍在） */ }', '包裹用的 catch 分支（2 条 message + 1 条 stack ⇒ 3 处）']],
      reverse: [],
      structural: appBootReadonlyStructural,
    })),
  },

  /* ── ⑩ fs-local 的 createIfAbsent link → rename 回退（替换式） ── */
  {
    key: 'fs-local link',
    fn: 'patchFsLocalLink()',
    note: 'pack-core.mjs:2222-2277；标记名与上表一致。反向判据只有 1 条但**必须逐字**：'
      + '同文件另有 2 处 `await rename(tempPath, absolutePath);`（:586/:588，上游原有），'
      + '泛化成"不许出现 rename"会恒红。',
    sites: [{
      rel: FS_LOCAL_LIB,
      markers: [['DSHM_FS_LOCAL_SANDBOX', 1]],
      forward: [
        ['const linkUnsupported = code === "EPERM" || code === "EACCES"', '链接类错误判定（鸿蒙 EPERM/EACCES）'],
        ['code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV";', '链接类错误判定的其余码'],
      ],
      reverse: [[FS_LOCAL_UPSTREAM, 'pack-core.mjs:2235-2239 的 before（整段 5 行，含缩进）']],
    }],
  },

  /* ── ⑪ attachment-local：link → copyFile + 祖先 fsync 容错（替换式，4 条反向） ── */
  {
    key: 'attachment link',
    fn: 'patchAttachmentLocalLink()',
    note: 'pack-core.mjs:2292-2360；标记名与上表一致。反向 4 条：npm 导入行、syncDirectory 原段、'
      + '两个 link 发布块（导入行里本来就有 `link` 标识符 ⇒ 泛化判据恒红）。',
    sites: [{
      rel: ATTACH_LIB,
      markers: [['DSHM_ATTACHMENT_SANDBOX', 1]],
      forward: [
        ['import { chmod, copyFile, link, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";', '补上的 copyFile 导入'],
        ['await copyFile(source, target, constants.COPYFILE_EXCL);', '发布点①（source）改用 COPYFILE_EXCL'],
        ['await copyFile(staged.path, target, constants.COPYFILE_EXCL);', '发布点②（staged.path）'],
        ['handle = await open(path, constants.O_RDONLY);', 'syncDirectory 里改成可失败的 open'],
        ['if (error && (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOENT" || error.code === "ENOTDIR")) return;', '祖先目录不可达就跳过该级'],
      ],
      reverse: [
        [ATTACH_IMPORT_UPSTREAM, 'pack-core.mjs:2307 的 import 行原文'],
        [ATTACH_SYNC_UPSTREAM, 'pack-core.mjs:2315-2320 的 syncDirectory 原文'],
        [attachmentLinkBefore('source'), 'pack-core.mjs:2348 的 link 发布块原文（source）'],
        [attachmentLinkBefore('staged.path'), 'pack-core.mjs:2348 的 link 发布块原文（staged.path）'],
      ],
    }],
  },
];

/**
 * 递归列出目录下所有文件的**相对路径**（POSIX 分隔符、排序）。
 * @param dir 目录绝对路径
 */
function listFilesUnder(dir) {
  const out = [];
  const walk = (d, prefix) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix === '' ? ent.name : `${prefix}/${ent.name}`;
      if (ent.isDirectory()) walk(join(d, ent.name), rel);
      else out.push(rel);
    }
  };
  walk(dir, '');
  return out.sort();
}

/**
 * 「整目录拷贝型」的反向判据：树内副本必须与仓库源**逐字节一致**（含"多出/缺文件"）。
 *
 * 为什么这算反向判据：`cpSync(force)` 只覆盖同名文件、**不删**目标里多出的文件，
 * 而 `STAGE` 是长期复用的暂存树 ⇒ 陈旧残留/被手改的文件会静默进产物。
 * @param treeDir 树内目录/文件的绝对路径
 * @param srcDir 仓库源目录/文件的绝对路径
 */
function diffTreeAgainstSource(treeDir, srcDir) {
  if (!existsSync(srcDir)) return [`仓库源不存在：${srcDir}`];
  if (!existsSync(treeDir)) return [`树内不存在：${treeDir}`];
  if (listFilesUnderSafe(srcDir) === null) {
    const a = readFileSync(treeDir);
    const b = readFileSync(srcDir);
    return a.equals(b) ? [] : [`${treeDir} 与仓库源逐字节不一致`];
  }
  const srcFiles = listFilesUnder(srcDir);
  const treeFiles = listFilesUnderSafe(treeDir) ?? [];
  const fails = [];
  for (const rel of srcFiles) {
    if (!treeFiles.includes(rel)) fails.push(`树内缺少 ${rel}（源里有）`);
  }
  for (const rel of treeFiles) {
    if (!srcFiles.includes(rel)) fails.push(`树内多出 ${rel}（源里没有 ⇒ 陈旧残留/手改）`);
  }
  for (const rel of srcFiles) {
    if (!treeFiles.includes(rel)) continue;
    const a = readFileSync(join(treeDir, ...rel.split('/')));
    const b = readFileSync(join(srcDir, ...rel.split('/')));
    if (!a.equals(b)) fails.push(`${rel} 与仓库源逐字节不一致（被手改或版本陈旧）`);
  }
  return fails;
}

/** `listFilesUnder` 的容错版：目标不是目录（或不存在）时返回 null。 */
function listFilesUnderSafe(dir) {
  try {
    return listFilesUnder(dir);
  } catch {
    return null;
  }
}

/**
 * ④ 的全部判据：逐组逐站点跑"标记次数 / 正向片段 / 反向原文 / 结构形态"，再跑 mirrors。
 * @param TREE 核心树根（`<tree>`，不是 `<tree>/node_modules/@deepseek-ai`）
 */
function auditInjectedPatches(TREE, ok, bad) {
  /*
   * 【换行归一】`pack-core` 的替换模板一律用 `\n`，但树里并非所有文件都是 LF
   * （实测 `profiles/ondevice/cordis.patch.yml` 是 CRLF，由 hostcore 源决定）。
   * 不归一就会让多行判据**恒不命中**：正向恒红（能看见），反向**恒绿**（看不见 ——
   * 正是"恒真的摆设判据"）。所以这里统一把 `\r\n` 折成 `\n` 再比对。
   * 逐字节一致性判据（mirrors）仍读原始字节，不受影响。
   */
  const readTree = (rel) => {
    const p = join(TREE, ...rel.split('/'));
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  };
  const shortOf = (rel) => rel.split('/').slice(-2).join('/');

  for (const group of INJECTED_PATCHES) {
    for (const site of group.sites) {
      const tag = `[${group.key}] ${group.fn} · ${shortOf(site.rel)}`;
      const text = readTree(site.rel);
      if (text === null) {
        bad(`${tag}：缺文件（核心树 ${site.rel} 不存在）`);
        continue;
      }
      for (const [marker, expect] of site.markers) {
        const n = countOf(text, marker);
        if (n === expect) ok(`${tag}：${marker} ×${n}`);
        else bad(`${tag}：${marker} 出现 ${n} 次，规定 ${expect} 次 —— ${group.fn} 没跑（或上游形态已变而补丁静默失效/重复注入）`);
      }
      for (const [lit, label] of site.forward) {
        const n = countOf(text, lit);
        if (n >= 1) ok(`${tag}：注入形态在（×${n}）—— ${label}`);
        else bad(`${tag}：找不到注入后的判据片段（${label}）—— ${JSON.stringify(lit.slice(0, 60))}… 补丁形态已变，门禁需同步复核`);
      }
      for (const [lit, label] of site.reverse) {
        const n = countOf(text, lit);
        if (n === 0) ok(`${tag}：上游原文已消失 —— ${label}`);
        else bad(`${tag}：**上游原文仍在 ×${n}** —— ${label}：${JSON.stringify(lit.slice(0, 70))}…（补丁被回退或被后续改动覆盖）`);
      }
      if (typeof site.structural === 'function') {
        const fails = site.structural(text);
        if (fails.length === 0) ok(`${tag}：上游未注入形态已消失（结构判据）`);
        for (const f of fails) bad(`${tag}：${f}`);
      }
    }
    for (const [rel, label] of group.present ?? []) {
      if (existsSync(join(TREE, ...rel.split('/')))) ok(`[${group.key}] ${group.fn}：${label}在（${rel}）`);
      else bad(`[${group.key}] ${group.fn}：缺 ${label} —— ${rel} 不存在（cpSync 步骤没跑）`);
    }
    for (const [treeRel, srcRel] of group.mirrors ?? []) {
      const fails = diffTreeAgainstSource(join(TREE, ...treeRel.split('/')), join(ROOT, ...srcRel.split('/')));
      if (fails.length === 0) ok(`[${group.key}] ${group.fn}：${treeRel} 与 ${srcRel} 逐字节一致（反向判据）`);
      else for (const f of fails) bad(`[${group.key}] ${group.fn}：树内副本与仓库源不一致 —— ${f}`);
    }
  }
}

/* ───────────────────────── 审计（scope = node_modules/@deepseek-ai 目录；可重定向到临时副本） ───────────────────────── */

const countOf = (text, needle) => text.split(needle).length - 1;
const countRe = (text, re) => (text.match(re) ?? []).length;

function audit(scope) {
  const notes = [];
  const fails = [];
  const ok = (msg) => notes.push(`ok    ${msg}`);
  const bad = (msg) => fails.push(msg);

  const read = (rel) => {
    const p = join(scope, ...rel.split('/'));
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf8');
  };
  /* ④ 段的判据按**核心树根**取路径（profile 不在 node_modules/@deepseek-ai 下）；
   * scope = <tree>/node_modules/@deepseek-ai ⇒ 上溯两级即树根（--self-test 的临时副本同构）。 */
  const TREE = join(scope, '..', '..');

  /* ── ① 资源地址装甲 ── */
  for (const site of ARMOR_SITES) {
    const text = read(site.rel);
    if (text === null) {
      bad(`${site.name}：缺文件 ${site.rel}`);
      continue;
    }
    const n = countOf(text, site.marker);
    if (n >= 1) ok(`${site.name}：${site.marker} ×${n}`);
    else bad(`${site.name}：${site.rel} 里没有 ${site.marker} —— pack-core 的资源地址补丁没跑（或上游实现已变而补丁静默失效）`);
    if (!text.includes(site.patched)) {
      bad(`${site.name}：找不到注入后的判据片段（${JSON.stringify(site.patched.slice(0, 60))}…）—— 补丁形态已变，门禁需同步复核`);
    }
    if (text.includes(site.upstream)) {
      bad(`${site.name}：**上游原文仍在**（${JSON.stringify(site.upstream.slice(0, 60))}…）—— 补丁被回退或被后续改动覆盖`);
    }
  }

  /* ── ② PDF Map 兼容：两处注入各一次 ── */
  {
    const text = read(PDF_REL);
    if (text === null) {
      bad(`PDF Map 兼容：缺文件 ${PDF_REL}`);
    } else {
      const total = countOf(text, PDF_MARKER);
      if (total === 2) ok(`PDF Map 兼容：${PDF_MARKER} 共 2 处（主线程 + 内联 worker 各一）`);
      else bad(`PDF Map 兼容：${PDF_REL} 里 ${PDF_MARKER} 出现 ${total} 次，规定 2 次 —— 两处注入至少少了一处（worker 少注入 ⇒ 端侧 PDF 仍然白屏）`);

      const mainSite = countRe(text, PDF_MAIN_SITE_RE);
      if (mainSite === 1) ok('PDF Map 兼容：主线程 chunk 工厂处 1 处（真换行 + tab 缩进形态）');
      else bad(`PDF Map 兼容：主线程 chunk 工厂处出现 ${mainSite} 次（规定 1 次）`);

      const workerSite = countOf(text, PDF_WORKER_SITE);
      if (workerSite === 1) ok('PDF Map 兼容：内联 pdf worker 的 Blob 字面量处 1 处（JSON 转义形态）');
      else bad(`PDF Map 兼容：内联 pdf worker 的 Blob 字面量处出现 ${workerSite} 次（规定 1 次）—— worker 是独立 realm，漏了它就是端侧 PDF 仍然白屏`);

      const factory = countOf(text, PDF_FACTORY_ANCHOR);
      if (factory === 1) ok(`PDF Map 兼容：chunk 工厂入口唯一（${JSON.stringify(PDF_FACTORY_ANCHOR)} ×1）`);
      else bad(`PDF Map 兼容：chunk 工厂入口 ${JSON.stringify(PDF_FACTORY_ANCHOR)} 出现 ${factory} 次（pack-core 的 die 要求恰好 1 次）`);

      const bareBlob = countOf(text, PDF_BARE_BLOB_ANCHOR);
      if (bareBlob === 0) ok('PDF Map 兼容：上游裸 Blob 锚点已消失（反向断言）');
      else bad(`PDF Map 兼容：上游裸锚点 ${JSON.stringify(PDF_BARE_BLOB_ANCHOR)} 仍在（×${bareBlob}）—— worker 处的注入被回退`);
    }
  }

  /* ── ③ 终端：runner-launch-*.js + index.js ── */
  {
    const libDir = join(scope, ...SUBPROCESS_LIB.split('/'));
    if (!existsSync(libDir)) {
      bad(`终端 openharmony 补丁：缺目录 ${SUBPROCESS_LIB}`);
    } else {
      const runners = readdirSync(libDir).filter((n) => /^runner-launch-.*\.js$/.test(n));
      if (runners.length === 0) {
        bad(`终端 openharmony 补丁：${SUBPROCESS_LIB} 下找不到 runner-launch-*.js（pack-core 的 die 条件之一）`);
      }
      for (const name of runners) {
        const text = readFileSync(join(libDir, name), 'utf8');
        const n = countOf(text, SUBPROCESS_MARKER);
        if (n >= 1) ok(`终端 openharmony 补丁 · ${name}：${SUBPROCESS_MARKER} ×${n}`);
        else bad(`终端 openharmony 补丁 · ${name}：没有 ${SUBPROCESS_MARKER} —— createProcessInspector 的 openharmony 分支没打上`);
        if (text.includes(INSPECTOR_PATCHED)) ok(`终端 openharmony 补丁 · ${name}：平台判定已含 openharmony（复用 LinuxProcessInspector）`);
        else bad(`终端 openharmony 补丁 · ${name}：找不到含 openharmony 的巡检器判定 —— 端侧会报 unsupported on platform openharmony`);
        // 反向：上游那条"裸 linux 判定"不得残留（注意：同文件另有 1 处无关的 `platform === "linux" &&`
        // 上游逻辑，所以这里只否掉**这一条完整语句**，不能泛化成"任何 linux 判定"）
        if (text.includes(INSPECTOR_UPSTREAM)) {
          bad(`终端 openharmony 补丁 · ${name}：上游裸判定 ${JSON.stringify(INSPECTOR_UPSTREAM)} 仍在 —— 补丁被回退`);
        }
      }

      const indexRel = `${SUBPROCESS_LIB}/index.js`;
      const text = read(indexRel);
      if (text === null) {
        bad(`终端 openharmony 补丁：缺文件 ${indexRel}`);
      } else {
        const n = countOf(text, SUBPROCESS_MARKER);
        if (n >= 2) ok(`终端 openharmony 补丁 · index.js：${SUBPROCESS_MARKER} ×${n}（shellActivity + idle 两处注入）`);
        else bad(`终端 openharmony 补丁 · index.js：${SUBPROCESS_MARKER} 只出现 ${n} 次，规定 2 次（shellActivity 跳过 + idle 分支）`);

        if (text.includes(SHELL_ACTIVITY_PATCHED)) ok('终端 openharmony 补丁 · index.js：prepareShellActivity() 已含 openharmony 短路');
        else bad('终端 openharmony 补丁 · index.js：prepareShellActivity() 没有 openharmony 短路 —— 鸿蒙上仍会注入 shellActivity');
        if (text.includes(IDLE_PATCHED)) ok('终端 openharmony 补丁 · index.js：inspectActivity() 的 idle 分支已含 openharmony');
        else bad('终端 openharmony 补丁 · index.js：inspectActivity() 的 idle 分支不含 openharmony');

        // 反向：三条上游原文都不得残留
        for (const [label, upstream] of [
          ['prepareShellActivity() 的裸判定', SHELL_ACTIVITY_UPSTREAM],
          ['inspectActivity() 的裸 linux 分支', IDLE_UPSTREAM],
          ['createProcessInspector() 的裸 linux 判定', INSPECTOR_UPSTREAM],
        ]) {
          if (text.includes(upstream)) {
            bad(`终端 openharmony 补丁 · index.js：上游原文仍在（${label}）—— ${JSON.stringify(upstream.slice(0, 70))}…`);
          }
        }
      }
    }
  }

  /* ── ④ 其余 10 个注入函数（清单门禁） ── */
  auditInjectedPatches(TREE, ok, bad);

  return { notes, fails };
}

/* ───────────────────────── 正常门禁 ───────────────────────── */

function runGuard() {
  if (!existsSync(CORE)) {
    console.error(`前置条件缺失（exit 3，不算失败）：核心树未就位 —— ${CORE} 不存在。`);
    console.error('先跑 `node tools/pack-core.mjs --skip-install` 生成核心工作树，再跑本门禁。');
    process.exit(3);
  }
  const { notes, fails } = audit(CORE);
  console.log('════════ 核心树端侧补丁门禁（13 处注入：资源地址装甲 · PDF Map · 终端 openharmony · 语音原生采集 · 录音约束 · HMS provider · profile/自带插件 · session link · 凭据 660 · preset workflow · app-boot 只读 stack · fs-local link · attachment link） ════════');
  console.log(`核心树：${CORE}`);
  for (const n of notes) console.log(n);
  if (fails.length > 0) {
    console.log('\n失败项：');
    for (const f of fails) console.log(`  FAIL  ${f}`);
    console.log(`\nRESULT: ${notes.length} passed, ${fails.length} failed`);
    process.exit(1);
  }
  console.log(`\nRESULT: ${notes.length} passed, 0 failed —— 13 处端侧注入补丁都在树里，且上游原文/未注入形态均已消失。`);
}

/* ───────────────────────── --self-test：变异副本，证明门禁真的会红 ───────────────────────── */

// 自检要覆盖的落地文件（与 audit() 的判据一一对应）
const SELFTEST_FILES = [
  ...ARMOR_SITES.map((s) => s.rel),
  PDF_REL,
  `${SUBPROCESS_LIB}/index.js`,
];

/* ④ 段的自检素材：**核心树根相对**路径（文件或目录；目录用于 mirrors 的逐字节比对）。 */
const CORE_TREE = join(CORE, '..', '..');
const SELFTEST_TREE_ENTRIES = [...new Set([
  ...INJECTED_PATCHES.flatMap((g) => g.sites.map((s) => s.rel)),
  ...INJECTED_PATCHES.flatMap((g) => (g.present ?? []).map(([rel]) => rel)),
  ...INJECTED_PATCHES.flatMap((g) => (g.mirrors ?? []).map(([treeRel]) => treeRel)),
])];

function copyInto(scope, rel) {
  const src = join(CORE, ...rel.split('/'));
  const dst = join(scope, ...rel.split('/'));
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, readFileSync(src));
  return dst;
}

/** 把真核心树里的**文件或目录**整份拷进自检临时树（目录递归；④ 段的判据按树根取路径）。 */
function copyTreeEntry(treeRoot, rel) {
  const src = join(CORE_TREE, ...rel.split('/'));
  const dst = join(treeRoot, ...rel.split('/'));
  const files = listFilesUnderSafe(src);
  if (files === null) {
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, readFileSync(src));
    return;
  }
  for (const f of files) {
    const d = join(dst, ...f.split('/'));
    mkdirSync(dirname(d), { recursive: true });
    writeFileSync(d, readFileSync(join(src, ...f.split('/'))));
  }
}

function selfTest() {
  if (!existsSync(CORE)) {
    console.error(`前置条件缺失（exit 3）：自检需要真核心树作基线 —— ${CORE} 不存在。`);
    process.exit(3);
  }
  const tmp = mkdtempSync(join(tmpdir(), 'dshm-core-openharmony-patches-selftest-'));
  const scope = join(tmp, 'node_modules', '@deepseek-ai');
  let failures = 0;
  let caseCount = 0;
  const case_ = (name, pass, detail) => {
    caseCount += 1;
    if (!pass) failures += 1;
    console.log(`${pass ? 'ok  ' : 'FAIL'}：${name}（${detail}）`);
  };

  try {
    for (const rel of SELFTEST_FILES) copyInto(scope, rel);
    // subprocess-local 的 runner-launch-*.js 文件名是哈希，按真树复制（注意 lib/ 下还有 types/ 子目录）
    const libDir = join(CORE, ...SUBPROCESS_LIB.split('/'));
    for (const ent of readdirSync(libDir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      const rel = `${SUBPROCESS_LIB}/${ent.name}`;
      if (!SELFTEST_FILES.includes(rel)) copyInto(scope, rel);
    }
    // ④ 段：按树根相对路径整份复制（含 mirrors 的目录 ⇒ 临时树与真树同构）
    for (const rel of SELFTEST_TREE_ENTRIES) copyTreeEntry(tmp, rel);

    // 基线：未变异的副本必须全绿 —— 否则"变异后变红"不能归因于变异
    const base = audit(scope);
    case_('基线：未变异的临时副本全绿（证明变异才是变红的原因）',
      base.fails.length === 0, `fails=${base.fails.length}${base.fails.length ? ' :: ' + base.fails[0] : ''}`);

    const restore = new Map(); // path → 原始字节
    const mutate = (rel, fn) => {
      const p = join(scope, ...rel.split('/'));
      if (!restore.has(p)) restore.set(p, readFileSync(p, 'utf8'));
      writeFileSync(p, fn(readFileSync(p, 'utf8')), 'utf8');
      return p;
    };
    const mutateTree = (rel, fn) => {
      const p = join(tmp, ...rel.split('/'));
      if (!restore.has(p)) restore.set(p, readFileSync(p, 'utf8'));
      writeFileSync(p, fn(readFileSync(p, 'utf8')), 'utf8');
      return p;
    };
    const removed = []; // 被删掉的文件（present 用例用），连内容一起记，便于还原
    const removeTreeFile = (rel) => {
      const p = join(tmp, ...rel.split('/'));
      removed.push([p, readFileSync(p)]);
      rmSync(p);
      return p;
    };
    const restoreAll = () => {
      for (const [p, text] of restore) writeFileSync(p, text, 'utf8');
      restore.clear();
      for (const [p, buf] of removed) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, buf);
      }
      removed.length = 0;
    };

    // 变异体：每个用例 mutate(scope) 后必须让 audit() 变红，且失败里含期望关键词。
    // 【注意变异要真的把标记"改没"】不能改成 `原标记 + "_X"` —— 那是原标记的超串，
    // 计数类判据照样命中，用例会变成假绿。
    const mutantRunner = () => readdirSync(libDir).filter((n) => /^runner-launch-.*\.js$/.test(n))[0];
    const handCases = [
      {
        name: 'M1 资源装甲标记（client-resources）被改名 → ①红',
        run: () => mutate(ARMOR_SITES[0].rel,
          (t) => t.replace('DSHM_RESOURCE_ARMOR_PROTOCOL', 'DSHM_RESOURCE_ARMOR_PR0TOCOL')),
        expect: /client-resources/,
      },
      {
        name: 'M2 侧栏装甲标记被改名 → ①红',
        run: () => mutate(ARMOR_SITES[1].rel,
          (t) => t.replace('DSHM_RESOURCE_ARMOR_PATH', 'DSHM_RESOURCE_ARMOR_P4TH')),
        expect: /sidebar-right/,
      },
      {
        name: 'M3 pdf worker 那处注入被抹掉（总数 2→1）→ ②红',
        run: () => mutate(PDF_REL,
          (t) => t.replace('\\n/* DSHM_MAP_COMPAT */\\n', '\\n/* DSHM_MAP_C0MPAT */\\n')),
        expect: /出现 1 次，规定 2 次|Blob 字面量处出现 0 次/,
      },
      {
        name: 'M4 runner-launch 补丁被整体回退（标记与 openharmony 判定一起没）→ ③红',
        run: () => {
          const rel = `${SUBPROCESS_LIB}/${mutantRunner()}`;
          mutate(rel, (t) => t
            .replace(INSPECTOR_PATCHED, INSPECTOR_UPSTREAM)
            .replace(/\s*\/\* DSHM_OPENHARMONY_SUBPROCESS \*\//g, ''));
          return rel;
        },
        expect: /没有 DSHM_OPENHARMONY_SUBPROCESS|找不到含 openharmony 的巡检器判定/,
      },
      {
        name: 'M5 **只**把上游裸判定塞回去（标记仍在）→ 反向断言单独红',
        run: () => {
          const rel = `${SUBPROCESS_LIB}/${mutantRunner()}`;
          mutate(rel, (t) => t + '\n' + INSPECTOR_UPSTREAM + '\n');
          return rel;
        },
        expect: /上游裸判定/,
        // 这一条是"反向断言不是摆设"的证据：正向标记全在，只有反例残留
        expectMarkerStillOk: true,
      },
      /* ── M6-M8：④ 段「插入型」补丁的结构反向判据 —— 只把"上游未注入形态"塞回去，
       *          所有正向标记与片段判据一个都没动（`only` 断言失败项**全部**来自结构判据） ── */
      {
        name: 'M6 原生采集叠加段被移到 module factory **之外**（标记与片段全在）→ 结构反向单独红',
        run: () => mutateTree(VOICE_CLIENT, (t) => {
          const start = t.indexOf('/* DSHM_NATIVE_CAPTURE@');
          const end = t.indexOf('})();', start) + '})();'.length;
          return t.slice(0, start) + t.slice(end) + '\n' + t.slice(start, end);
        }),
        expect: /注入段不在 module factory 内/,
        only: /注入段不在 module factory 内/,
      },
      {
        name: 'M7 preset 里 workflow-ptc 被"取消禁用"（注释与标记全在）→ 结构反向单独红',
        run: () => mutateTree(`${PRESET_DIR}/standard.patch.yml`,
          (t) => t.replace(/(# DSHM_WORKFLOW_DISABLED:[^\n]*\n *)(disabled: true)/g, '$1enabled: true')),
        expect: /workflow-ptc 未带 disabled: true/,
        only: /未带 disabled: true/,
      },
      {
        name: 'M8 app-boot 多出一处裸赋值（3 处标记一个没少）→ 结构反向单独红',
        run: () => mutateTree(APP_BOOT_MAIN,
          (t) => t + '\nfunction dshmProbe(error, message) {\n\terror.message = message;\n}\n'),
        expect: /裸赋值未被 try\/catch 包住/,
        only: /裸赋值未被 try\/catch 包住/,
      },
    ];

    for (const c of handCases) {
      restoreAll();
      const rel = c.run();
      const res = audit(scope);
      const hit = res.fails.some((f) => c.expect.test(f));
      const onlyOk = c.only === undefined || res.fails.every((f) => c.only.test(f));
      case_(c.name, res.fails.length > 0 && hit && onlyOk,
        `rel=${rel} fails=${res.fails.length}${res.fails.length ? ' :: ' + res.fails[0].slice(0, 110) : '（没红 —— 该判据是恒真的摆设）'}`);
      if (c.expectMarkerStillOk) {
        const markerNotes = res.notes.filter((n) => n.includes('DSHM_OPENHARMONY_SUBPROCESS'));
        case_('M5 前提复核：M5 之后正向标记断言仍为 ok（所以这次红只可能来自反向断言）',
          markerNotes.length >= 2, `markerNotes=${markerNotes.length}`);
      }
    }

    /* ═══ ④ 段的系统性反恒真自检 ═══
     * 逐条把判据"打回上游形态"，证明**每一条**都能单独红。这比手写几条样例更硬：
     * 任何一条恒真的摆设判据（写错、写空、与树里的换行/缩进对不上）都会在这里暴露。
     */
    // (a) 反向判据（替换型）：只把该条上游原文塞回树内副本，其余一个字节不动 ⇒ 只该它红
    for (const group of INJECTED_PATCHES) {
      for (const site of group.sites) {
        for (const [lit, label] of site.reverse) {
          restoreAll();
          mutateTree(site.rel, (t) => t + '\n' + lit + '\n');
          const res = audit(scope);
          const probe = JSON.stringify(lit.slice(0, 70));
          const hit = res.fails.some((f) => f.includes('上游原文仍在') && f.includes(probe));
          const onlyReverse = res.fails.length > 0 && res.fails.every((f) => f.includes('上游原文仍在'));
          case_(`自检·只塞回上游原文即红：[${group.key}] ${label.split('：')[0]}`, hit && onlyReverse,
            `fails=${res.fails.length}${res.fails.length ? ' :: ' + res.fails[0].slice(0, 110) : '（没红 —— 恒真的摆设）'}`);
        }
      }
    }
    // (b) 标记次数判据：改名（期望 >0）或插入一行（期望 =0）⇒ 计数必须红
    for (const group of INJECTED_PATCHES) {
      for (const site of group.sites) {
        for (const [marker, expect] of site.markers) {
          restoreAll();
          if (expect === 0) mutateTree(site.rel, (t) => t + `\n# ${marker}\n`);
          else mutateTree(site.rel, (t) => t.replace(marker, `${marker.slice(0, -1)}0`));
          const res = audit(scope);
          const hit = res.fails.some((f) => f.includes(marker) && f.includes(`规定 ${expect} 次`));
          case_(`自检·标记计数会红：[${group.key}] ${marker} 期望 ×${expect}`, hit,
            `fails=${res.fails.length}${res.fails.length ? ' :: ' + res.fails[0].slice(0, 110) : '（没红 —— 恒真的摆设）'}`);
        }
      }
    }
    // (c) 正向片段：逐条从树里抠掉 ⇒ 必须报"找不到注入后的判据片段"
    // 【必须抠掉**全部**出现】只 replace 第一处会出现假绿（例：preset 的注释行有 2 条、
    // app-boot 的 catch 行有 3 处，剩余的那几条照样让"≥1 处"的正向判据成立）。
    // 【换行要两种都抠】profile 的源文件是 CRLF（见 auditInjectedPatches 的归一说明）。
    const withoutAll = (t, lit) => t.split(lit).join('').split(lit.replace(/\n/g, '\r\n')).join('');
    for (const group of INJECTED_PATCHES) {
      for (const site of group.sites) {
        for (const [lit, label] of site.forward) {
          restoreAll();
          mutateTree(site.rel, (t) => withoutAll(t, lit));
          const res = audit(scope);
          const hit = res.fails.some((f) => f.includes('找不到注入后的判据片段') && f.includes(JSON.stringify(lit.slice(0, 60))));
          case_(`自检·抠掉注入片段即红：[${group.key}] ${label.split('（')[0]}`, hit,
            `fails=${res.fails.length}${res.fails.length ? ' :: ' + res.fails[0].slice(0, 110) : '（没红 —— 恒真的摆设）'}`);
        }
      }
    }
    // (d) cpSync 产物：删掉文件 ⇒ 必须报缺
    for (const group of INJECTED_PATCHES) {
      for (const [rel, label] of group.present ?? []) {
        restoreAll();
        const p = removeTreeFile(rel);
        const res = audit(scope);
        const hit = res.fails.some((f) => f.includes(`缺 ${label}`));
        case_(`自检·删掉 cpSync 产物即红：[${group.key}] ${label}`, hit,
          `path=${p} fails=${res.fails.length}${res.fails.length ? ' :: ' + res.fails[0].slice(0, 110) : '（没红 —— 恒真的摆设）'}`);
      }
    }
    // (e) 逐字节比对（mirrors）：改动副本 ⇒ 必须报不一致
    for (const group of INJECTED_PATCHES) {
      for (const [treeRel, srcRel] of group.mirrors ?? []) {
        restoreAll();
        const under = listFilesUnderSafe(join(tmp, ...treeRel.split('/')));
        const target = under === null || under.length === 0 ? treeRel : `${treeRel}/${under[0]}`;
        mutateTree(target, (t) => t + '\n/* 陈旧残留 */\n');
        const res = audit(scope);
        const hit = res.fails.some((f) => f.includes('树内副本与仓库源不一致'));
        case_(`自检·树内副本被改即红：[${group.key}] ${treeRel} ↔ ${srcRel}`, hit,
          `rel=${target} fails=${res.fails.length}${res.fails.length ? ' :: ' + res.fails[0].slice(0, 110) : '（没红 —— 恒真的摆设）'}`);
      }
    }
    restoreAll();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  case_('变异件已删除（不留在树里、也不留在临时目录）', !existsSync(tmp), `tmp=${tmp} exists=${existsSync(tmp)}`);

  console.log(`\nRESULT: self-test ${failures === 0 ? 'PASS' : 'FAIL'}（用例 ${caseCount}，不合格 ${failures}）`);
  process.exit(failures === 0 ? 0 : 1);
}

if (SELF_TEST) selfTest();
else runGuard();
