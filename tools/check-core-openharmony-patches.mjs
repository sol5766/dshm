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
 *   ① `patchResourceAddressArmor()`（tools/pack-core.mjs:2432-2540）
 *      ArkWeb 把未注册的 `dsh-resource:` 当 opaque URL（hostname === ""、authority 被并进
 *      path、query 被并进 path），三处 client 侧解析各打一个标记：
 *        · `DSHM_RESOURCE_ARMOR_PROTOCOL` → dsh-client-resources/lib/client.js（protocolOf）
 *        · `DSHM_RESOURCE_ARMOR_PATH`     → dsh-client-ui-sidebar-right/lib/client.js（pathOf）
 *        · `DSHM_RESOURCE_ARMOR_SUBAGENT` → dsh-client-ui-subagent/lib/client.js（parseSubagentChatAddress）
 *   ② `patchPdfMapCompat()`（tools/pack-core.mjs:2604-2637）
 *      `Map/WeakMap.getOrInsert(Computed)` 在 ArkWeb 上缺失 ⇒ PDF 预览挂。主线程 chunk 工厂
 *      （`factory: (require) => {`）注入一次，内联 pdf worker 的 Blob 分片数组最前面再注入一次
 *      （worker 是独立 realm，不继承主线程原型补丁）⇒ `DSHM_MAP_COMPAT` **总共恰好 2 处**。
 *   ③ `patchSubprocessOpenharmony()`（tools/pack-core.mjs:2639-2687）
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
 *   · `patchAppBootReadonlyStack()`（:2159-2212）→ `DSHM_READONLY_STACK_GUARD`
 *   · `patchFsLocalLink()`（:2227-2282）→ `DSHM_FS_LOCAL_SANDBOX`
 *   · `patchAttachmentLocalLink()`（:2297-2365）→ `DSHM_ATTACHMENT_SANDBOX`
 *
 * ---------------------------------------------------------------------------
 * 【2026-10-05 第二轮扩容：再纳入 6 个"只有打包期 `die()` 兜底"的打包步骤】
 * ---------------------------------------------------------------------------
 * 与上一轮同一类洞，但这 6 个的**产物形态不同**，判据形态随之不同（详见 ⑤ 段注释）：
 *   · `allowOriginList()`（tools/pack-core.mjs:1532-1581）→ `DSHM_ORIGIN_LIST`
 *     —— 多值 Origin 放行的**行为**另有 `tools/check-origin-fence.mjs` 钉着，**不**断言树内标记 ⇒ 不重复
 *   · `wrapSharp()`（:1603-1665）→ `0.0.0-dshm-dispatch`
 *   · `addSystemAddonPackage()`（:1753-1883）→ `0.1.2-dshm-shim`
 *     —— undici 垫片的**语义**另有 `tools/check-internal-undici.mjs` 钉着 ⇒ 不重复
 *   · `addOnDevicePreset()`（:1065-1092）→ **当前布局下它不复制任何东西**（产物 = 官方 shipping 集）
 *   · `addPlatformAliases()`（:1487-1502）→ 整目录复制的平台别名
 *   · `embedTreeInfo()` / `verifyTreeInfoContract()`（:2689-2763）→ 树根 `dshm-core.json`
 *
 * 【"生成物只做形状断言"到底指哪几处】本轮新判据里有两种"生成物"：
 *   · `dshm-core.json` 是**真生成物**：`builtAt` 是打包时刻的 `new Date().toISOString()`，
 *     `plugins`/`pluginTotals`/`nativePackages` 由 `inventoryOf(树)` 现算 ⇒ **绝不**逐字节或精确值断言，
 *     只判 存在 / JSON 可解析 / 字段名与类型 / 形状，以及**来自配方与代码常量的确定值**
 *     （coreVersion·platform·profile·overrides 取自 `hostcore/core-recipe.json`；builtAt·nodeFloor 只判形态）。
 *   · `node_modules/sharp/package.json` + `index.js` 与 `node-addon-system-linux-arm64/package.json`
 *     也是 pack-core 写的，但它们**不含时间戳/随机值**（内容逐字节确定）⇒ 可以逐字断言。
 *   区别只有一条：**内容会不会随打包时刻变化**。
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
 *   · 新造包型（`node-addon-system-linux-arm64`）：仓库里**没有**上游副本可逐字否掉
 *     （该平台包在 Windows 宿主的 npm 树里根本不存在），反向改判**产物形态** ——
 *     manifest 键集必须恰好是 pack-core 写的那 4 个、`bin/<libc>/system.node` 必须是占位而不是 ELF 真件。
 *   · 路径不得存在型（`wrapSharp()` 的真件 `lib/`、`addOnDevicePreset()` 的旧布局副本）：
 *     反向 = "某个路径**不得**出现"（`absent`），必要时带 guard（legacy 源在时 pack-core 本来就会复制 ⇒ 不算红）。
 *   · 树内互为副本型（`addPlatformAliases()` 的平台别名）：源也在树内 ⇒ 反向 = 别名目录与源目录
 *     **树内逐字节一致**（`treeMirrors`）＋"必须是真副本而不是 symlink/junction"（链接能让逐字节比对全绿）。
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
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync,
  writeFileSync,
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
    // pack-core.mjs:2443-2444 的 before（注入后必须整体消失）
    upstream: 'return parsed.hostname === "" ? void 0 : parsed.hostname.toLowerCase();',
    // pack-core.mjs:2454-2456 的 after 里的可判据片段
    patched: 'const armor = parsed.hostname === "" ? /^[a-z][a-z\\d+.-]*:\\/\\/([^/?#]*)/iu.exec(address) : null;',
  },
  {
    rel: 'dsh-client-ui-sidebar-right/lib/client.js',
    marker: 'DSHM_RESOURCE_ARMOR_PATH',
    name: '资源地址装甲 · sidebar-right pathOf() 剥掉被并进 path 的 authority',
    // pack-core.mjs:2473 的 before
    upstream: 'return new URL(address).pathname;',
    patched: 'if (parsed.hostname === "" && parsed.pathname.startsWith("//")) {',
  },
  {
    rel: 'dsh-client-ui-subagent/lib/client.js',
    marker: 'DSHM_RESOURCE_ARMOR_SUBAGENT',
    name: '资源地址装甲 · subagent parseSubagentChatAddress() 的 host/path/query 兜底',
    // pack-core.mjs:2512 的 before 里的判定（注入后改成用兜底出来的 host）
    upstream: 'url.hostname.toLowerCase() !== "subagentchat"',
    patched: 'const searchParams = new URLSearchParams(query);',
  },
];

// ② PDF：`DSHM_MAP_COMPAT` 恰好两处注入，且两处形态可区分
const PDF_REL = 'dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js';
const PDF_MARKER = 'DSHM_MAP_COMPAT';
// 主线程：MAP_COMPAT_SOURCE 每行加 `\t\t` 前缀（pack-core.mjs:2620-2621）⇒ 标记独占一行、前缀是真 tab
const PDF_MAIN_SITE_RE = /(^|\n)\t\t\/\* DSHM_MAP_COMPAT \*\//g;
// worker：同一份源码被 JSON.stringify 塞进 Blob 分片数组（pack-core.mjs:2626-2632）⇒ 标记被 `\n` 两个字面字符夹住
const PDF_WORKER_SITE = '\\n/* DSHM_MAP_COMPAT */\\n';
const PDF_FACTORY_ANCHOR = 'factory: (require) => {';
// 反向：注入后这个"裸 Blob 数组首元素"形态必须消失（pack-core.mjs:2626 的 blobAnchor 被整体替换）
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

/* ── 撤除守卫（coreVersion +dshm.6，2026-10-05）：已**撤除**的无效补丁不得复活 ──
 *
 * `DSHM_DOC_LOAD_DEDUP`（面板自持 AbortController + 同键在飞去重）曾由 pack-core 的
 * `dedupDocumentLoad()` 注入下面这个文件。它治的是**不存在的病**：`readBytes` 空响应的真根因是
 * 宿主 undici 垫片不认 `new Response(FormData)`（`hostcore/app/fetch-shim.js`，见 `docs/97`），
 * 且补丁里"失败后清去重键"一行落在 `if (started…) return` 之后是**死代码**。
 * ⇒ 用户决定整段撤除（pack-core 的注入函数与调用点已删；升 `coreVersion` 让端侧换树）。
 *
 * 为什么仍要在门禁里登记：撤除**只在"这次 pack-core 没打它"时有意义** —— 树是增量复用/可回退的，
 * 任何人把注入加回来、或拿旧树出包，仓库层都不会红。这里用与 `markers` 同一套机制的**期望 0 次**，
 * 外加"上游原文形态已恢复"的正向判据（注入会把这三行里的 `signal` 换成 `dshmSignal`）。
 */
// 【路径基准是 scope（`<tree>/node_modules/@deepseek-ai`），与 ①②③ 段一致；④⑤ 组才用树根相对】
const DEDUP_REL = 'dsh-client-ui-sidebar-documentpreview/lib/client.js';
// 注入标记 + 它引入的三个标识符（注入后各出现；撤除后必须 0 次）。`dshmLoadKey` 是 `dshmLoadKeyRef` 的前缀，故不单列。
const DEDUP_MARKERS = ['DSHM_DOC_LOAD_DEDUP', 'dshmLoadKeyRef', 'dshmAbortRef', 'dshmSignal'];
// 上游原文形态（撤除后必须恢复）：effect 的 started 早退行 + 三个加载调用点用 owner 的 `signal`。
// 这三条调用点**逐字**取自 pack-core 原 dedupDocumentLoad() 的 `callAnchors`（即"被 replace 掉的上游原文"）。
const DEDUP_UPSTREAM_RESTORED = [
  ['const started = current !== void 0;', 'effect 的 started 早退行（上游原文）'],
  ['if (mode === "text-pages") loadPage(tab.id, file, 1, signal, meta.value?.version);', '加载调用点①（上游形态：用 owner 的 signal）'],
  ['else if (mode === "bytes-complete") loadAll(tab.id, file, signal, meta.value?.version);', '加载调用点②（上游形态：整读用 owner 的 signal ⇒ 不再有面板自持 abort）'],
  ['else prepareRenderer(tab.id, signal, selected.id, meta.value?.version);', '加载调用点③（上游形态）'],
];

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
// pack-core.mjs:2240-2244 —— fs-local 的 createIfAbsent 发布段原文
const FS_LOCAL_UPSTREAM = '\t\tif (createIfAbsent !== void 0) try {\n\t\t\tawait linkFile(tempPath, absolutePath);\n\t\t} catch (error) {\n\t\t\tawait throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);\n\t\t}';
// pack-core.mjs:2312 —— attachment-local 的 npm 导入行原文
const ATTACH_IMPORT_UPSTREAM = 'import { chmod, link, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";';
// pack-core.mjs:2320-2325 —— syncDirectory 的徒手 open/sync/close 原文
const ATTACH_SYNC_UPSTREAM = '\tconst handle = await open(path, constants.O_RDONLY);\n\ttry {\n\t\tawait handle.sync();\n\t} finally {\n\t\tawait handle.close();\n\t}';
// pack-core.mjs:2353 —— link 发布块原文（两处：source / staged.path），逐字复刻模板
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

/* ═══════════ ⑤ 第二轮扩容（2026-10-05）：6 个"只有 die() 兜底"的打包步骤 ═══════════
 *
 * 路径一律**树根相对**（`node_modules/...`、`profiles/...`、`dshm-core.json`），
 * 与 ④ 段同一套取值规则（auditInjectedPatches 的 TREE）。
 *
 * 逐条说明"为什么判据长这样"：
 *   · `allowOriginList()`（pack-core.mjs:1532-1581）—— 替换式，有逐字上游原文。
 *   · `wrapSharp()`（:1603-1665）—— 替换式 + `renameSync`：两个产物都是 pack-core 写的
 *     **确定性**内容（无时间戳）⇒ manifest 可逐字断言；反向用"上游真件的 lib/ 不得出现在
 *     node_modules/sharp 下"（它只该在 sibling 包 sharp.impl/ 里）。
 *   · `addSystemAddonPackage()`（:1753-1883）—— 新造包 + 真占位文件：**没有上游原文**（见上），
 *     反向改判产物形态（manifest 键集 / 占位内容 / 不是 ELF）。
 *     —— **以代码为准**：同一函数还整份重写了 `node-addon-system/lib/flock.js`（:1810-1882），
 *     它同样只有 die() 兜底 ⇒ 一并纳入（反向 = 可执行代码里不得再有 `process.report`）。
 *   · `addOnDevicePreset()`（:1065-1092）—— **当前布局下不复制任何东西**（以代码为准，见该组 note），
 *     产物 = 官方 shipping 集 + "旧布局副本不得复活"。
 *   · `addPlatformAliases()`（:1487-1502）—— 整目录复制：反向 = 树内逐字节一致 + 必须是真副本。
 *   · `embedTreeInfo()` / `verifyTreeInfoContract()`（:2689-2763）—— `dshm-core.json` 是**生成物**
 *     ⇒ 只做形状断言（唯一例外：配方给定的确定字段 coreVersion/platform/profile/overrides，
 *     以及代码常量 nodeFloor 的**形态**；builtAt 只判 ISO-8601 形态、不判值）。
 */

// pack-core.mjs:1533-1535 —— allowOriginList() 的唯一目标文件
const CONN_LIB = 'node_modules/@deepseek-ai/dsh-client-connection/lib/index.js';
// pack-core.mjs:1553-1559 —— allowOriginList() 的 before：**整块 6 行**、含 tab 缩进，注入后必消失
const ORIGIN_UPSTREAM = '\tconst origin = header$1(request.headers, "origin");\n\tif (origin === void 0) return true;\n\ttry {\n\t\treturn new URL(origin).host === hostUrl.host;\n\t} catch {\n\t\treturn false;\n\t}';
// pack-core.mjs:1565 —— after 里的循环头（上游是整串 `new URL(origin).host === hostUrl.host`）
const ORIGIN_SPLIT = 'for (const rawOrigin of String(origin).split(",")) {';
// pack-core.mjs:1549 —— 旧标记：HDSH→DSHM 改名前的树会带它；pack-core 为增量重打包**仍认它**
// ⇒ 它在 = 这棵树是旧版 pack-core 打的（不是"补丁没打"，但也不是当前形态）。
const ORIGIN_MARKER_OLD = 'HDSH_ORIGIN_LIST';

// pack-core.mjs:1605/1611/1634 —— wrapSharp() 的两个产物（树根相对）
const SHARP_PKG = 'node_modules/sharp/package.json';
const SHARP_INDEX = 'node_modules/sharp/index.js';
// pack-core.mjs:1631 —— 调度器 manifest 全文（JSON.stringify 单行；**无时间戳 ⇒ 可逐字断言**）
const SHARP_PKG_JSON = '{"name":"sharp","version":"0.0.0-dshm-dispatch","main":"index.js","private":true}';
// pack-core.mjs:1647 —— 真件（sibling 包）的加载点
const SHARP_IMPL_REQUIRE = "require('sharp.impl')";
// pack-core.mjs:1623-1627 —— renameSync 之后真件的落点：manifest / 入口体 / 上游 lib 目录
const SHARP_IMPL_PKG = 'node_modules/sharp.impl/package.json';
const SHARP_IMPL_ENTRY = 'node_modules/sharp.impl/lib/index.js';
const SHARP_UPSTREAM_LIB = 'node_modules/sharp/lib';

// pack-core.mjs:1760-1797 —— addSystemAddonPackage() 的产物（树根相对）
const ADDON_DIR = 'node_modules/@deepseek-ai/node-addon-system-linux-arm64';
const ADDON_PKG = `${ADDON_DIR}/package.json`;
const ADDON_PLACEHOLDER_MUSL = `${ADDON_DIR}/bin/musl/system.node`;
const ADDON_PLACEHOLDER_GLIBC = `${ADDON_DIR}/bin/glibc/system.node`;
// pack-core.mjs:1810-1882 —— **同一个函数**还整份重写了 base 包的 flock.js（平台门 + 去掉 process.report）。
// 以代码为准：这也是 addSystemAddonPackage() 的真实产物，且同样只有打包期 die()（:1881）兜底 ⇒ 一并管。
const ADDON_FLOCK = 'node_modules/@deepseek-ai/node-addon-system/lib/flock.js';
// pack-core.mjs:1795 —— 占位内容（含结尾换行；`<abi>` 是模板字符串里的**字面量**，不是插值）
const ADDON_PLACEHOLDER_TEXT = 'DSHM placeholder: real binary is loaded from HAP libs/<abi>/libsystem.so\n';
// pack-core.mjs:1762 + 1777-1782 —— shim manifest 的版本标记，以及它**恰好**这 4 个键
const ADDON_MARKER = '0.1.2-dshm-shim';
const ADDON_MANIFEST_KEYS = ['description', 'name', 'private', 'version'];

// pack-core.mjs:1084-1090 —— addOnDevicePreset() 的 legacy 兼容分支（只有 legacy 源在时才会复制）
const LEGACY_PRESET_STANDARD = 'node_modules/@deepseek-ai/dsh-agent-presets/presets/standard';
const LEGACY_PRESET_ONDEVICE = 'node_modules/@deepseek-ai/dsh-agent-presets/presets/ondevice';

// pack-core.mjs:1490-1492 —— addPlatformAliases() 的三条别名（**源与目标都在树内**）
const PLATFORM_ALIASES = [
  ['node_modules/koffi/build/koffi/linux_arm64', 'node_modules/koffi/build/koffi/openharmony_arm64',
    'koffi：linux_arm64 = openharmony_arm64 的真副本（koffi 加载器按 `platform_arch` 拼路径找它）'],
  ['node_modules/koffi/build/koffi/musl_arm64', 'node_modules/koffi/build/koffi/openharmony_arm64',
    'koffi：musl_arm64 = 同一份真件（两个 libc 变体目录都要在，上游换个判断分支也不会缺件）'],
  ['node_modules/node-pty/prebuilds/linux-arm64', 'node_modules/node-pty/prebuilds/openharmony-arm64',
    'node-pty：prebuilds/linux-arm64 = openharmony-arm64 的真副本'],
];

// pack-core.mjs:2689-2711 —— embedTreeInfo() 的产物（树根 `dshm-core.json`，TREE_INFO_FILE）
const TREE_INFO = 'dshm-core.json';
const TREE_INFO_TOTAL_KEYS = ['pluginRows', 'pureJs', 'native', 'unknown', 'disabled'];
// pack-core.mjs:2700 —— `new Date().toISOString()` 的**形态**（每次打包都不同 ⇒ 只判形态，不判值）
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** 键序无关的 JSON 序列化：用于与配方做**值**比较（不受书写顺序影响）。 */
function sortedJson(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(value[k])}`).join(',')}}`;
}

/**
 * `addSystemAddonPackage()` 的反向判据：manifest 必须是 pack-core 写的那个 shim，而不是 npm 装的真平台包。
 *
 * 为什么是"姿态"而不是"逐字否掉上游原文"：真平台包 `@deepseek-ai/node-addon-system-linux-arm64`
 * 是 `optionalDependencies`，在 Windows 宿主上**根本没装**，仓库里也没有它的副本
 * （`third_party/` 里只有 ripgrep/koffi 的 tgz）⇒ 拿不到可逐字否掉的原文。
 * 但真清单与 shim 的差别是**可判别的**：真清单带 `main`/`os`/`cpu`/`exports`/`files`/`types` …
 * 而 shim 恰好只有 4 个键。键集对不上 ⇒ 极可能是真包残留，而真 prebuilt 的 musl 变体
 * 只 `DT_NEEDED libc.so`（E43/E44），dlopen 后 napi 符号解析不到 ⇒ 会话锁直接坏。
 */
function systemAddonManifestStructural(text) {
  const fails = [];
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch (e) {
    return [`manifest 不可解析（${e.message}）—— pack-core 写的是 JSON.stringify 产物，不可解析说明被换成了别的东西`];
  }
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) return ['manifest 顶层不是对象'];
  const keys = Object.keys(pkg).sort();
  if (keys.join(',') !== ADDON_MANIFEST_KEYS.join(',')) {
    fails.push(`manifest 键集是 [${keys.join(', ')}]，规定恰好 [${ADDON_MANIFEST_KEYS.join(', ')}] —— `
      + '多出的键通常意味着 **npm 装的真平台包清单残留**（真清单带 main/os/cpu/exports），'
      + '那会让加载器走去 dlopen 真 prebuilt（musl 变体缺 napi 符号，E43/E44）');
  }
  if (pkg.version !== ADDON_MARKER) {
    fails.push(`manifest version=${JSON.stringify(pkg.version)}，规定 ${JSON.stringify(ADDON_MARKER)}（pack-core:1762 的幂等标记）`);
  }
  if (pkg.private !== true) fails.push('manifest 缺 private: true（shim 是私有包，不该被当官方包解析）');
  if (typeof pkg.name !== 'string' || !pkg.name.startsWith('@deepseek-ai/node-addon-system-linux-')) {
    fails.push(`manifest name=${JSON.stringify(pkg.name)} 不是 @deepseek-ai/node-addon-system-linux-<abi>（加载器 require.resolve 的就是这个名字）`);
  }
  return fails;
}

/**
 * `addSystemAddonPackage()` 的 `bin/<libc>/system.node` 判据：必须是 DSHM 占位，不能是 ELF 真件。
 *
 * 正向 = 内容逐字等于 pack-core:1795 的占位串（**确定性内容**，可以逐字比）；
 * 反向 = 不得以 `\x7fELF` 开头（真 prebuilt 残留）。两条都要：占位被换成任何别的东西
 * 都要红，而"别的 ELF"只靠"内容相等"也能红 —— 反过来"内容相等"却抓不到"文件根本不存在"
 * （不存在由 audit 的缺文件分支管）。
 */
function systemAddonPlaceholderStructural(text) {
  const fails = [];
  if (text !== ADDON_PLACEHOLDER_TEXT) {
    fails.push(`内容不是 pack-core:1795 写的占位（实际 ${JSON.stringify(text.slice(0, 90))}…）—— `
      + '占位被换掉/手改；真加载走入口脚本的 `.node` 重定向，占位只负责让 Module._findPath 的内部 stat 通过');
  }
  if (text.startsWith('\x7fELF')) {
    fails.push('是 ELF 原生件（真 prebuilt 残留）—— musl 变体只 DT_NEEDED libc.so，dlopen 后 napi 符号解析不到（E43/E44）');
  }
  return fails;
}

/**
 * `embedTreeInfo()` / `verifyTreeInfoContract()` 的判据：**生成物 ⇒ 只做形状断言**。
 *
 * 绝不判的东西：`builtAt` 的**值**（打包时刻时间戳）、`plugins`/`pluginTotals`/`nativePackages`
 * 的**具体内容**（由 `inventoryOf(树)` 现算，随树里装了什么变化）。
 * 判的东西：① verifyTreeInfoContract 的同一套字段名/类型契约（pack-core.mjs:2741-2758）；
 * ② 与 `hostcore/core-recipe.json` 一致的**确定**字段（coreVersion/platform/profile/overrides）；
 * ③ 内部一致性（pluginTotals.pluginRows === plugins.length、pureJs+native+unknown === pluginRows）；
 * ④ 形态：builtAt 是 ISO-8601、nodeFloor 是 x.y.z。
 */
function treeInfoStructural(text) {
  const fails = [];
  let info;
  try {
    info = JSON.parse(text);
  } catch (e) {
    return [`dshm-core.json 不可解析（${e.message}）—— 端侧 CoreStore.readTreeInfo 会静默退化成`
      + '"未读取到插件清单"，而没有任何一处会告诉你是截断/拼写问题'];
  }
  if (info === null || typeof info !== 'object' || Array.isArray(info)) return ['dshm-core.json 顶层不是对象'];
  // ① 与 verifyTreeInfoContract() 的 wantString 同源（pack-core.mjs:2741）
  for (const k of ['coreVersion', 'platform', 'profile', 'builtAt', 'nodeFloor', 'producer']) {
    if (typeof info[k] !== 'string') {
      fails.push(`字段 ${k} 不是字符串（端侧按字符串读；verifyTreeInfoContract 的 wantString 同源）`);
    }
  }
  // ② 配方给定的确定值（不是生成物：hostcore/core-recipe.json 是唯一事实来源）
  if (typeof info.coreVersion === 'string' && info.coreVersion !== RECIPE.coreVersion) {
    fails.push(`coreVersion=${JSON.stringify(info.coreVersion)} ≠ 配方 ${JSON.stringify(RECIPE.coreVersion)}`
      + ' —— 树与配方不是同一版（拿旧树/半成品树出包的典型形态）');
  }
  const wantPlatform = `${RECIPE.platform.os}/${RECIPE.platform.cpu}`;
  if (typeof info.platform === 'string' && info.platform !== wantPlatform) {
    fails.push(`platform=${JSON.stringify(info.platform)} ≠ 配方 ${JSON.stringify(wantPlatform)}`);
  }
  if (typeof info.profile === 'string' && info.profile !== RECIPE.profile) {
    fails.push(`profile=${JSON.stringify(info.profile)} ≠ 配方 ${JSON.stringify(RECIPE.profile)}`);
  }
  if (info.overrides === null || typeof info.overrides !== 'object' || Array.isArray(info.overrides)) {
    fails.push('overrides 不是对象（端侧据此判断原生件是不是移植版）');
  } else if (sortedJson(info.overrides) !== sortedJson(RECIPE.overrides)) {
    fails.push(`overrides=${sortedJson(info.overrides)} ≠ 配方 ${sortedJson(RECIPE.overrides)}`);
  }
  // ③ 生成物的**形态**（值随打包时刻/上游变化 ⇒ 只判形态）
  if (typeof info.builtAt === 'string' && !ISO_TIMESTAMP_RE.test(info.builtAt)) {
    fails.push(`builtAt=${JSON.stringify(info.builtAt)} 不是 ISO-8601 形态（**只判形态不判值**：它是打包时刻的时间戳）`);
  }
  if (typeof info.nodeFloor === 'string' && !/^\d+\.\d+\.\d+$/.test(info.nodeFloor)) {
    fails.push(`nodeFloor=${JSON.stringify(info.nodeFloor)} 不是 x.y.z 形态`);
  }
  // ④ pluginTotals / plugins / nativePackages：类型契约 + 两条内部一致性
  const t = info.pluginTotals;
  if (t === null || typeof t !== 'object' || Array.isArray(t)) {
    fails.push('pluginTotals 不是对象');
  } else {
    for (const k of TREE_INFO_TOTAL_KEYS) {
      if (typeof t[k] !== 'number') fails.push(`pluginTotals.${k} 不是数字（verifyTreeInfoContract 的硬断言）`);
    }
  }
  if (!Array.isArray(info.plugins)) {
    fails.push('plugins 不是数组（端侧插件页的数据源）');
  } else {
    for (const [i, r] of info.plugins.entries()) {
      if (r === null || typeof r !== 'object' || Array.isArray(r)) { fails.push(`plugins[${i}] 不是对象`); continue; }
      for (const k of ['id', 'name', 'bundle', 'nativeKind']) {
        if (typeof r[k] !== 'string') fails.push(`plugins[${i}].${k} 不是字符串`);
      }
      if (typeof r.disabled !== 'boolean') fails.push(`plugins[${i}].disabled 不是布尔`);
      if (!Array.isArray(r.nativeVia)) fails.push(`plugins[${i}].nativeVia 不是数组`);
    }
    if (t !== null && typeof t === 'object' && !Array.isArray(t) && typeof t.pluginRows === 'number') {
      if (t.pluginRows !== info.plugins.length) {
        fails.push(`pluginTotals.pluginRows=${t.pluginRows} 与 plugins 长度 ${info.plugins.length} 不一致`
          + '（verifyTreeInfoContract 的硬断言）');
      }
      if (['pureJs', 'native', 'unknown'].every((k) => typeof t[k] === 'number')
        && t.pureJs + t.native + t.unknown !== t.pluginRows) {
        fails.push(`pluginTotals 分解和 ${t.pureJs}+${t.native}+${t.unknown}=`
          + `${t.pureJs + t.native + t.unknown} ≠ pluginRows=${t.pluginRows}（core-inventory 的三分类互斥且穷尽）`);
      }
    }
  }
  if (!Array.isArray(info.nativePackages)) {
    fails.push('nativePackages 不是数组');
  } else {
    for (const [i, n] of info.nativePackages.entries()) {
      if (typeof n !== 'string') fails.push(`nativePackages[${i}] 不是字符串（端侧据此把"含原生件"的插件标成不可运行时安装）`);
    }
  }
  return fails;
}

/**
 * `addSystemAddonPackage()` 的另一半产物：`node-addon-system/lib/flock.js` 的整份重写。
 *
 * pack-core 用**整份模板**覆盖它（不是替换片段）⇒ 拿不到"被替换的上游原文"，
 * 反向判据只能判**不变量**：可执行代码里不得再有 `process.report`。
 *
 * 【必须剥注释再判】pack-core 的模板注释里**故意**写着"**不要**用 process.report.getReport() 判 libc"，
 * 直接对全文计数会把"注释里提到它"当成"代码里还在用它" ⇒ 恒红（这正是本文件反复强调的"恒真的摆设判据"的镜像错误）。
 */
function addonFlockStructural(text) {
  const fails = [];
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (code.includes('process.report')) {
    fails.push('可执行代码里仍有 process.report（上游的 libc 判定）—— 端侧实测它同步枚举 CPU 并逐个打开 '
      + 'sysfs cpufreq 做实时频率查询（55.8 s），正好落在会话写租约的热路径上（E388：冷启动后事件循环被挡 ~62 s）。'
      + 'pack-core 的模板已把它换成 /proc/self/maps 的一次便宜读取；这里先剥掉注释再判，'
      + '所以"注释里提到 process.report"是允许的（模板注释本来就在讲这个坑）');
  }
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
    note: 'pack-core.mjs:2159-2212；标记名与上表一致（上表只写了一个文件，实际**两份副本都要改**）。'
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
    note: 'pack-core.mjs:2227-2282；标记名与上表一致。反向判据只有 1 条但**必须逐字**：'
      + '同文件另有 2 处 `await rename(tempPath, absolutePath);`（:586/:588，上游原有），'
      + '泛化成"不许出现 rename"会恒红。',
    sites: [{
      rel: FS_LOCAL_LIB,
      markers: [['DSHM_FS_LOCAL_SANDBOX', 1]],
      forward: [
        ['const linkUnsupported = code === "EPERM" || code === "EACCES"', '链接类错误判定（鸿蒙 EPERM/EACCES）'],
        ['code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV";', '链接类错误判定的其余码'],
      ],
      reverse: [[FS_LOCAL_UPSTREAM, 'pack-core.mjs:2240-2244 的 before（整段 5 行，含缩进）']],
    }],
  },

  /* ── ⑪ attachment-local：link → copyFile + 祖先 fsync 容错（替换式，4 条反向） ── */
  {
    key: 'attachment link',
    fn: 'patchAttachmentLocalLink()',
    note: 'pack-core.mjs:2297-2365；标记名与上表一致。反向 4 条：npm 导入行、syncDirectory 原段、'
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
        [ATTACH_IMPORT_UPSTREAM, 'pack-core.mjs:2312 的 import 行原文'],
        [ATTACH_SYNC_UPSTREAM, 'pack-core.mjs:2320-2325 的 syncDirectory 原文'],
        [attachmentLinkBefore('source'), 'pack-core.mjs:2353 的 link 发布块原文（source）'],
        [attachmentLinkBefore('staged.path'), 'pack-core.mjs:2353 的 link 发布块原文（staged.path）'],
      ],
    }],
  },

  /* ── ⑫ Origin 列表放行（替换式：整块 6 行原文必须消失） ── */
  {
    key: 'Origin 列表',
    fn: 'allowOriginList()',
    note: 'pack-core.mjs:1532-1581；标记 `DSHM_ORIGIN_LIST`。'
      + '注意 `tools/check-origin-fence.mjs` 钉的是**行为**（多值 Origin 的放行语义），'
      + '**不**断言树内标记存在 ⇒ 两者不重复（一个管语义、一个管"这棵树里到底有没有这段改动"）。'
      + `反向判据两条：pack-core:1553-1559 的整块 before（6 行，含 tab 缩进）逐字否掉；`
      + `另否掉旧标记 ${ORIGIN_MARKER_OLD} —— 它是 HDSH→DSHM 改名前的形态，`
      + 'pack-core 为增量重打包**仍然认它**（见 :1540-1548 的教训注释）⇒ 它在 = 这棵树是旧版 pack-core 打的。',
    sites: [{
      rel: CONN_LIB,
      markers: [['DSHM_ORIGIN_LIST', 1], [ORIGIN_MARKER_OLD, 0]],
      forward: [
        [ORIGIN_SPLIT, '按逗号切分的多值 Origin 循环（上游是按**整串** `new URL(origin)` 解析）'],
        ['if (new URL(candidate).host === hostUrl.host) return true;', '任一项同源即放行（跨源项仍然不认 ⇒ 没放宽安全边界）'],
        ['/* 单个非法候选不足以否决整条请求，继续看下一项 */', '非法候选被吞掉继续看下一项（与上游 catch{return false} 正相反）'],
      ],
      reverse: [[ORIGIN_UPSTREAM, 'pack-core.mjs:1553-1559 的 before（整串同源判定，6 行含 tab 缩进）']],
    }],
  },

  /* ── ⑬ sharp 调度器（替换式 + 真件改名，两个产物都确定性） ── */
  {
    key: 'sharp 调度器',
    fn: 'wrapSharp()',
    note: 'pack-core.mjs:1603-1665；标记 = manifest 版本号 `0.0.0-dshm-dispatch`。'
      + '两个产物都由 pack-core 写出且**逐字节确定**（无时间戳/随机）⇒ manifest 可逐字断言、'
      + 'index.js 只断关键形态（否则等于把整份生成脚本抄进门禁）。'
      + '反向判据：上游真件的 `lib/` 只该出现在 sibling 包 `sharp.impl/` 下 —— '
      + '`node_modules/sharp/lib` 存在即说明 `renameSync` 没做（或只改了一半），'
      + '而调度器会 `require("sharp.impl")` 到不存在的东西（E79 的纯 stub 从未真正恢复图片能力）。',
    sites: [
      {
        rel: SHARP_PKG,
        markers: [['0.0.0-dshm-dispatch', 1]],
        forward: [[SHARP_PKG_JSON, '调度器 manifest 全文（pack-core:1631 的 JSON.stringify，逐字）']],
        reverse: [['"@ohos-ports/sharp"', '上游真件 manifest 的 name —— 它现在只该在 node_modules/sharp.impl/package.json 里']],
      },
      {
        rel: SHARP_INDEX,
        markers: [['dshmSharpLoadError', 2]],
        forward: [
          [SHARP_IMPL_REQUIRE, '真件（sibling 包）的加载点'],
          ['impl = function dshmSharpUnavailable() {', '加载失败时"会报错但能挂载"的降级桩（不是静默的假可用）'],
          ['impl.dshmSharpLoadError = reason;', '真实失败原因挂载点（入口脚本的运行时事实读它 ⇒ 界面显示真实结论）'],
          ['module.exports.default = impl;', 'default 导出（CJS/ESM 两种取法都能拿到同一份）'],
        ],
        reverse: [],
      },
    ],
    present: [
      [SHARP_IMPL_PKG, '真件包 manifest（renameSync 之后的 sibling 目录）'],
      [SHARP_IMPL_ENTRY, '真件 JS 入口体（证明整包被挪走，而不是只挪了 manifest）'],
    ],
    absent: [[SHARP_UPSTREAM_LIB,
      '上游真件的 lib/ 目录（只该存在于 node_modules/sharp.impl/lib；node_modules/sharp 下只该有 pack-core 写的 package.json + index.js）']],
  },

  /* ── ⑭ node-addon-system 平台包（新造包：没有上游原文可逐字否掉） ── */
  {
    key: 'system 平台包',
    fn: 'addSystemAddonPackage()',
    note: 'pack-core.mjs:1753-1883；标记 = manifest 版本 `0.1.2-dshm-shim`。'
      + '**以代码为准**：这个函数其实有 3 类产物 —— ① 占位平台包 manifest；'
      + '② 两个 `bin/<libc>/system.node` 占位；③ base 包 `node-addon-system/lib/flock.js` 的**整份重写**'
      + '（:1810-1882，die 在 :1881）。③ 没有独立门禁，因此本组连它一起管（见下第三个 site 的说明）。'
      + '注意 `tools/check-internal-undici.mjs` 覆盖的是 undici 垫片的**语义**，'
      + '与这个包的树副本无关 ⇒ 不重复。'
      + '这个平台包是 `optionalDependencies`，在 Windows 宿主的 npm 树里**根本不存在**，'
      + '仓库里也没有它的副本（third_party 只有 ripgrep/koffi 的 tgz）⇒ '
      + '**没有可逐字否掉的"上游原文"**，反向判据改判**产物形态**：'
      + `manifest 键集恰好 [${ADDON_MANIFEST_KEYS.join(', ')}]（真 npm 清单带 main/os/cpu/exports ⇒ 红）；`
      + '`bin/<libc>/system.node` 必须是 DSHM 占位而不是 ELF 真件。'
      + '占位文件本身就是"必须物理存在"的产物：Node 的模块解析走 Module._findPath 的**内部 stat**，'
      + '不经过被 hook 的 fs.existsSync。',
    sites: [
      {
        rel: ADDON_PKG,
        markers: [[ADDON_MARKER, 1]],
        forward: [
          ['"name": "@deepseek-ai/node-addon-system-linux-arm64"', '平台包名（加载器 require.resolve 的就是它）'],
          ['"private": true', '私有包：不是从 npm 装的真平台包'],
        ],
        reverse: [],
        structural: systemAddonManifestStructural,
      },
      {
        rel: ADDON_PLACEHOLDER_MUSL,
        markers: [['DSHM placeholder', 1]],
        forward: [[ADDON_PLACEHOLDER_TEXT, '占位内容（pack-core:1795；内容无关紧要，但文件必须物理存在）']],
        reverse: [],
        structural: systemAddonPlaceholderStructural,
      },
      {
        rel: ADDON_PLACEHOLDER_GLIBC,
        markers: [['DSHM placeholder', 1]],
        forward: [[ADDON_PLACEHOLDER_TEXT, '占位内容（同上；两个 libc 变体目录都放 ⇒ 上游换判断分支也不会缺件）']],
        reverse: [],
        structural: systemAddonPlaceholderStructural,
      },
      {
        /*
         * 以代码为准：`addSystemAddonPackage()`（pack-core.mjs:1753-1883）除了上面那个占位包，
         * 还会**整份重写** base 包的 `lib/flock.js`（:1810-1882，die 在 :1881）。
         * 它没有"待替换片段"（整份模板覆盖）⇒ 反向判据是**不变量**（不得再有可执行的 process.report）。
         */
        rel: ADDON_FLOCK,
        markers: [['DSHM 端侧修补', 2]],
        forward: [
          ["const platform = (platformRaw === 'win32' || platformRaw === 'darwin') ? platformRaw : 'linux';",
            '平台门：非 win/darwin 一律当 linux（鸿蒙上报 openharmony ⇒ 命中上面的 -linux-<abi> 占位包）'],
          ["let libc = 'musl';", 'libc 判定改成便宜的一次 /proc/self/maps 读取（E388 的 55.8 s 那个坑）'],
          ['filename = join(libc, filename);', '按 libc 选 bin/<libc>/system.node（两个目录映射同一份 libsystem.so）'],
          ['${platform}-${arch}/package.json', 'require.resolve 的目标仍是 …-linux-<arch>/package.json（与上面的占位包配套）'],
        ],
        reverse: [],
        structural: addonFlockStructural,
      },
    ],
  },

  /* ── ⑮ 端侧 preset（当前布局：**不复制**，直接复用官方 shipping 集） ── */
  {
    key: '端侧 preset',
    fn: 'addOnDevicePreset()',
    note: 'pack-core.mjs:1065-1092；**与待纳入清单的表述不一致（以代码为准）**：'
      + '当前布局下它**不往 `dsh-web-app/presets/` 插入任何东西** —— preset 早已改成 '
      + '`dsh-web-app/presets/*.patch.yml` 平铺（每份文件自己 insert 一个 `@deepseek-ai/dsh-agent-preset`），'
      + '函数只 `readdir` 后打一行日志（"端侧 agent preset 用官方 shipping 集（不复制）"）就返回；'
      + '真正往 preset 里插入内容的是 `patchAgentPresetWorkflow()`（本文件 ⑧ 组）。'
      + '所以这里断言的是**真实产物**：① shipping 集那 4 个 `.patch.yml` 都在'
      + '（端侧 agent preset 的实体就是它们；`profiles/ondevice` 注释里说的 `default: standard` 指的就是它）；'
      + '② 旧布局的复制产物 `dsh-agent-presets/presets/ondevice` 不得残留 —— '
      + '但 pack-core 只在 legacy 源存在时才复制它，所以这条判据带 guard：'
      + 'legacy 源也在时不判红（那是 pack-core 的兼容分支在正常工作，不是残留）。',
    sites: [],
    present: [
      [`${PRESET_DIR}/standard.patch.yml`, 'shipping 集 · standard（端侧 agent preset 的实体；profile 的 default: standard 指向它）'],
      [`${PRESET_DIR}/cordis.patch.yml`, 'shipping 集 · cordis（端侧默认 profile bundle 用的那份）'],
      [`${PRESET_DIR}/ptc.patch.yml`, 'shipping 集 · ptc'],
      [`${PRESET_DIR}/minimal.patch.yml`, 'shipping 集 · minimal'],
    ],
    absent: [[LEGACY_PRESET_ONDEVICE,
      '旧布局的端侧 preset 副本（dsh-agent-presets 已从核心树消失；它若复活说明有人在用旧布局重新出包）',
      LEGACY_PRESET_STANDARD]],
  },

  /* ── ⑯ 平台别名（整目录复制：必须与树内源逐字节一致，且必须是真副本） ── */
  {
    key: '平台别名',
    fn: 'addPlatformAliases()',
    note: 'pack-core.mjs:1487-1502；把 `@ohos-ports/*` 移植件放假件的 `openharmony_arm64` 目录'
      + '复制成**加载器会去找**的 `linux_arm64` / `musl_arm64`（koffi）与 `linux-arm64`（node-pty）—— '
      + '端侧自建 Node 的 `process.platform === "linux"` 而 `arch === "arm64"`，'
      + '文件明明在包里、加载器却说找不到（D6 E39）。'
      + '没有"上游原文"可否掉（是整目录复制），反向判据因此是两条：'
      + '① 别名目录与**树内**源目录逐字节一致（`cpSync(recursive)` 不删目标里多出的文件 ⇒ 陈旧残留/手改会红）；'
      + '② 别名必须是**真副本**而不是 symlink/junction —— 指向源目录的链接能让 ① 全绿，'
      + '而鸿蒙沙箱禁止 symlink（13900012 Permission denied）、HAP 也不携带链接 ⇒ 这两条必须分开判。',
    sites: [],
    treeMirrors: PLATFORM_ALIASES,
  },

  /* ── ⑰ 树内清单 dshm-core.json（**生成物** ⇒ 只做形状断言） ── */
  {
    key: '树内清单',
    fn: 'embedTreeInfo() / verifyTreeInfoContract()',
    note: `pack-core.mjs:2689-2763；产物 = 树根 \`${TREE_INFO}\`（TREE_INFO_FILE）。`
      + '**这是生成物**：`builtAt` 是 `new Date().toISOString()`（每次打包都不同）、'
      + '`plugins`/`pluginTotals`/`nativePackages` 由 `inventoryOf(树)` 现算 ⇒ '
      + '**不做逐字节/精确值断言**。判的是：'
      + '① 文件在且 JSON 可解析；② 端侧要读的字段名/类型齐全（与 verifyTreeInfoContract 同一套契约 —— '
      + '两端都是字符串键，任何一侧改名都不报错，只会静默退化成"未读取到插件清单"）；'
      + '③ 与 `hostcore/core-recipe.json` 一致的**确定**字段（coreVersion/platform/profile/overrides）；'
      + '④ 内部一致性（`pluginTotals.pluginRows === plugins.length`、`pureJs+native+unknown === pluginRows`）；'
      + '⑤ 形态 —— `builtAt` 只判 ISO-8601、`nodeFloor` 只判 x.y.z，**都不判值**。',
    sites: [{
      rel: TREE_INFO,
      markers: [['"pluginTotals"', 1], ['"nativePackages"', 1]],
      forward: [
        ['"producer": "tools/pack-core.mjs"', '生产者标记（换了出包脚本时能看出来）'],
        ['"pluginRows"', '插件行计数字段名（端侧 CoreStore.readTreeInfo 按字符串键取）'],
      ],
      reverse: [],
      structural: treeInfoStructural,
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

/** `lstatSync` 的容错版：目标不存在（或无法 lstat）时返回 null。注意必须用 lstat：stat 会跟穿链接。 */
function lstatOf(p) {
  try {
    return lstatSync(p);
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
      else bad(`[${group.key}] ${group.fn}：缺 ${label} —— ${rel} 不存在（对应打包步骤没跑，或上游形态已变）`);
    }
    /*
     * `absent`：**路径不得存在**型反向判据（第五轮扩容新增）。
     *   [rel, label] 或 [rel, label, guardRel] —— 带 guardRel 时，只有 guardRel 也不存在才判红：
     *   例如 `addOnDevicePreset()` 的 legacy 分支在"legacy 源存在"时**本来就会**复制出
     *   `presets/ondevice`，把它判红就是拿 pack-core 的正常行为当失败。
     */
    for (const [rel, label, guardRel] of group.absent ?? []) {
      const p = join(TREE, ...rel.split('/'));
      if (!existsSync(p)) {
        ok(`[${group.key}] ${group.fn}：${label}不存在（反向判据）`);
      } else if (guardRel !== undefined && existsSync(join(TREE, ...guardRel.split('/')))) {
        ok(`[${group.key}] ${group.fn}：${rel} 存在，但 legacy 源 ${guardRel} 也在 ⇒ `
          + 'pack-core 的兼容分支本来就会复制它，不算残留（guard 生效）');
      } else {
        bad(`[${group.key}] ${group.fn}：**${label}仍在** —— ${rel} 存在`
          + '（打包步骤没做到位，或旧树/半成品的残留被当成了产物）');
      }
    }
    for (const [treeRel, srcRel] of group.mirrors ?? []) {
      const fails = diffTreeAgainstSource(join(TREE, ...treeRel.split('/')), join(ROOT, ...srcRel.split('/')));
      if (fails.length === 0) ok(`[${group.key}] ${group.fn}：${treeRel} 与 ${srcRel} 逐字节一致（反向判据）`);
      else for (const f of fails) bad(`[${group.key}] ${group.fn}：树内副本与仓库源不一致 —— ${f}`);
    }
    /*
     * `treeMirrors`：**源也在树内**的逐字节比对（第五轮扩容新增；用于平台别名）。
     * 多加一条 lstat 判据：别名必须是真副本，不能是指向源目录的 symlink/junction ——
     * 后者能让逐字节比对**全绿**，而鸿蒙沙箱禁 symlink、HAP 也不携带链接。
     */
    for (const [treeRel, srcRel, label] of group.treeMirrors ?? []) {
      const dst = join(TREE, ...treeRel.split('/'));
      const fails = diffTreeAgainstSource(dst, join(TREE, ...srcRel.split('/')));
      const st = lstatOf(dst);
      if (st !== null && st.isSymbolicLink()) {
        fails.push(`${treeRel} 是指向别处的符号链接/junction —— 鸿蒙沙箱禁止 symlink`
          + '（13900012 Permission denied）且 HAP 不携带链接，必须是真副本');
      }
      if (fails.length === 0) {
        ok(`[${group.key}] ${group.fn}：${treeRel} ↔ 树内 ${srcRel} 逐字节一致且是真副本（反向判据）—— ${label}`);
      } else {
        for (const f of fails) bad(`[${group.key}] ${group.fn}：${treeRel} 与树内 ${srcRel} 不一致 —— ${f}`);
      }
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

  /* ── ④ 撤除守卫：已撤除的无效补丁 `DSHM_DOC_LOAD_DEDUP` 不得复活（+dshm.6） ── */
  {
    const text = read(DEDUP_REL);
    if (text === null) {
      bad(`撤除守卫：缺文件 ${DEDUP_REL}`);
    } else {
      for (const marker of DEDUP_MARKERS) {
        const n = countOf(text, marker);
        if (n === 0) ok(`撤除守卫：${marker} ×0（撤除后未复活）`);
        else {
          bad(`撤除守卫：${marker} 出现 ${n} 次 —— 无效补丁 DSHM_DOC_LOAD_DEDUP（面板自持 abort + 同键去重）`
            + '已在 coreVersion +dshm.6 撤除（真根因是宿主 undici 垫片，见 docs/97）；它复活会重新引入'
            + '"整读被面板自持控制器劫持 + 失败后清键的死代码"');
        }
      }
      for (const [lit, label] of DEDUP_UPSTREAM_RESTORED) {
        if (text.includes(lit)) ok(`撤除守卫：上游原文已恢复 —— ${label}`);
        else {
          bad(`撤除守卫：找不到恢复后的上游原文（${label}）—— ${JSON.stringify(lit.slice(0, 70))}… `
            + '撤除不干净（半截补丁：标记删了但调用点还指着 dshmSignal），或上游实现已变而门禁需同步复核');
        }
      }
    }
  }

  /* ── ⑤ 其余注入函数（清单门禁） ── */
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
  console.log('════════ 核心树端侧补丁门禁（19 处注入 + 1 处撤除守卫：资源地址装甲 · PDF Map · 终端 openharmony · 语音原生采集 · 录音约束 · HMS provider · profile/自带插件 · session link · 凭据 660 · preset workflow · app-boot 只读 stack · fs-local link · attachment link · Origin 列表 · sharp 调度器 · system 平台包 · 端侧 preset · 平台别名 · 树内清单 · 撤除守卫[DSHM_DOC_LOAD_DEDUP 不得复活]） ════════');
  console.log(`核心树：${CORE}`);
  for (const n of notes) console.log(n);
  if (fails.length > 0) {
    console.log('\n失败项：');
    for (const f of fails) console.log(`  FAIL  ${f}`);
    console.log(`\nRESULT: ${notes.length} passed, ${fails.length} failed`);
    process.exit(1);
  }
  console.log(`\nRESULT: ${notes.length} passed, 0 failed —— 19 处端侧注入补丁都在树里，且上游原文/未注入形态均已消失`
    + '；另有 1 处**撤除守卫**（`DSHM_DOC_LOAD_DEDUP` 已于 coreVersion +dshm.6 撤除 ⇒ 标记必须 0 处、上游原文形态必须已恢复）。'
    + '（树内清单 dshm-core.json 是生成物，只按形状判：存在 + 字段/类型 + 配方一致 + 内部一致）。');
}

/* ───────────────────────── --self-test：变异副本，证明门禁真的会红 ───────────────────────── */

// 自检要覆盖的落地文件（与 audit() 的判据一一对应）
const SELFTEST_FILES = [
  ...ARMOR_SITES.map((s) => s.rel),
  PDF_REL,
  `${SUBPROCESS_LIB}/index.js`,
  // 撤除守卫（④ 段）：它的判据也走 scope 相对读取 ⇒ 临时副本里必须有这个文件
  DEDUP_REL,
];

/* ④/⑤ 段的自检素材：**核心树根相对**路径（文件或目录；目录用于 mirrors / treeMirrors 的逐字节比对）。 */
const CORE_TREE = join(CORE, '..', '..');
const SELFTEST_TREE_ENTRIES = [...new Set([
  ...INJECTED_PATCHES.flatMap((g) => g.sites.map((s) => s.rel)),
  ...INJECTED_PATCHES.flatMap((g) => (g.present ?? []).map(([rel]) => rel)),
  ...INJECTED_PATCHES.flatMap((g) => (g.mirrors ?? []).map(([treeRel]) => treeRel)),
  // treeMirrors 的**源与目标都在树内** ⇒ 两侧都要有，否则临时树里的别名比对会因"源不存在"而假红
  ...INJECTED_PATCHES.flatMap((g) => (g.treeMirrors ?? []).flatMap(([treeRel, srcRel]) => [treeRel, srcRel])),
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

    const restore = new Map(); // path → 原始**字节**（Buffer：二进制件也要能原样还原）
    const mutate = (rel, fn) => {
      const p = join(scope, ...rel.split('/'));
      if (!restore.has(p)) restore.set(p, readFileSync(p));
      writeFileSync(p, fn(readFileSync(p, 'utf8')), 'utf8');
      return p;
    };
    const mutateTree = (rel, fn) => {
      const p = join(tmp, ...rel.split('/'));
      if (!restore.has(p)) restore.set(p, readFileSync(p));
      writeFileSync(p, fn(readFileSync(p, 'utf8')), 'utf8');
      return p;
    };
    /*
     * 二进制安全的变异：别名目录里有真 ELF（node-pty 的 pty.node / spawn-helper），
     * 走 `readFileSync(..., 'utf8')` 往返会把它们毁掉（临时树随后所有比对都会红 ⇒
     * 后续用例的红不能归因于它自己的变异）。这里按字节追加。
     */
    const mutateBytes = (rel, suffix) => {
      const p = join(tmp, ...rel.split('/'));
      if (!restore.has(p)) restore.set(p, readFileSync(p));
      writeFileSync(p, Buffer.concat([readFileSync(p), Buffer.from(suffix, 'utf8')]));
      return p;
    };
    const removed = []; // 被删掉的文件（present 用例用），连内容一起记，便于还原
    const removeTreeFile = (rel) => {
      const p = join(tmp, ...rel.split('/'));
      removed.push([p, readFileSync(p)]);
      rmSync(p);
      return p;
    };
    const created = []; // absent 用例**新造**出来的路径（反向判据的变异体），用完即删
    const restoreAll = () => {
      for (const [p, buf] of restore) writeFileSync(p, buf); // Buffer ⇒ 原字节；string ⇒ utf8
      restore.clear();
      for (const [p, buf] of removed) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, buf);
      }
      removed.length = 0;
      for (const p of created) rmSync(p, { recursive: true, force: true });
      created.length = 0;
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
      /* ── M9：撤除守卫（④ 段）—— 已撤除的无效补丁被重新注入 ⇒ 只该撤除守卫红 ── */
      {
        name: 'M9 已撤除的 DSHM_DOC_LOAD_DEDUP 被重新注入 → 撤除守卫红',
        run: () => mutate(DEDUP_REL,
          (t) => t + '\n/* DSHM_DOC_LOAD_DEDUP: 重新注入（自检变异体） */\nconst dshmAbortRef = (0, react.useRef)(null);\n'),
        expect: /撤除守卫/,
        only: /撤除守卫/,
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
    // (d) 打包产物：删掉文件 ⇒ 必须报缺（cpSync 的镜像产物、shipping 集、renameSync 的真件都在此列）
    for (const group of INJECTED_PATCHES) {
      for (const [rel, label] of group.present ?? []) {
        restoreAll();
        const p = removeTreeFile(rel);
        const res = audit(scope);
        const hit = res.fails.some((f) => f.includes(`缺 ${label}`));
        case_(`自检·删掉打包产物即红：[${group.key}] ${label}`, hit,
          `path=${p} fails=${res.fails.length}${res.fails.length ? ' :: ' + res.fails[0].slice(0, 110) : '（没红 —— 恒真的摆设）'}`);
      }
    }
    // (e) 逐字节比对（mirrors，源在仓库里）：改动副本 ⇒ 必须报不一致
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
    // (f) 路径不得存在（absent）：把"本该消失的路径"造出来 ⇒ 必须报它仍在
    for (const group of INJECTED_PATCHES) {
      for (const [rel, label] of group.absent ?? []) {
        restoreAll();
        const p = join(tmp, ...rel.split('/'));
        mkdirSync(p, { recursive: true });
        created.push(p);
        const res = audit(scope);
        const hit = res.fails.some((f) => f.includes(`**${label}仍在**`));
        case_(`自检·本该消失的路径复活即红：[${group.key}] ${label}`, hit,
          `path=${p} fails=${res.fails.length}${res.fails.length ? ' :: ' + res.fails[0].slice(0, 110) : '（没红 —— 恒真的摆设）'}`);
      }
    }
    // (g) 树内互为副本（treeMirrors，源也在树内 —— 平台别名）：改动别名里的文件 ⇒ 必须报不一致
    // 【必须按字节追加】别名里有真 ELF（node-pty 的 pty.node / spawn-helper），
    // 走 utf8 往返会把临时副本毁掉，后续用例的红就不能归因于它自己的变异了。
    for (const group of INJECTED_PATCHES) {
      for (const [treeRel, srcRel, label] of group.treeMirrors ?? []) {
        restoreAll();
        const under = listFilesUnderSafe(join(tmp, ...treeRel.split('/')));
        const target = under === null || under.length === 0 ? treeRel : `${treeRel}/${under[0]}`;
        mutateBytes(target, '\n/* 陈旧残留 */\n');
        const res = audit(scope);
        const hit = res.fails.some((f) => f.includes('与树内') && f.includes('不一致'));
        case_(`自检·别名目录被手改即红：[${group.key}] ${treeRel} ↔ 树内 ${srcRel}（${label.split('：')[0]}）`, hit,
          `rel=${target} fails=${res.fails.length}${res.fails.length ? ' :: ' + res.fails[0].slice(0, 110) : '（没红 —— 恒真的摆设）'}`);
      }
    }
    restoreAll();

    /* ═══ ⑤ 段新增判据的**定点变异** ═══
     * 上面 (a)-(g) 是按判据表自动生成的反例（标记/片段/产物/路径）。但**形状判据**（structural）
     * 不会被自动覆盖 —— 它只在别的判据被破坏时顺带触发。所以这里逐条把形状打坏，证明它会红：
     *   · `dshm-core.json`（生成物）5 条：内部一致性 2 条 + 类型 1 条 + 形态 1 条 + 配方不一致 1 条；
     *   · `addSystemAddonPackage()` 2 条：manifest 键集、占位不是 ELF；
     *   · 平台别名 1 条：别名目录里多出陈旧文件（cpSync 不删目标里多出的文件）。
     * 变异一律用 JSON.parse→改字段→JSON.stringify(info, null, 2) 的写法，**不写死任何数字**
     * （写死 `296` 之类的当前值会在树升级后变成恒绿的摆设）。
     */
    const shapeCases = [
      {
        name: '自检·树内清单 pluginRows 与 plugins 长度不一致 ⇒ 红（生成物：只判内部一致性，不判值）',
        run: () => mutateTree(TREE_INFO, (t) => {
          const info = JSON.parse(t);
          info.pluginTotals.pluginRows = info.plugins.length + 7;
          return JSON.stringify(info, null, 2) + '\n';
        }),
        expect: /pluginRows=\d+ 与 plugins 长度/,
      },
      {
        name: '自检·树内清单 pluginTotals 分解和不等于 pluginRows ⇒ 红',
        run: () => mutateTree(TREE_INFO, (t) => {
          const info = JSON.parse(t);
          info.pluginTotals.native += 1;
          return JSON.stringify(info, null, 2) + '\n';
        }),
        expect: /分解和/,
      },
      {
        name: '自检·树内清单 nodeFloor 变成数字（端侧按字符串读）⇒ 红',
        run: () => mutateTree(TREE_INFO, (t) => {
          const info = JSON.parse(t);
          info.nodeFloor = 22;
          return JSON.stringify(info, null, 2) + '\n';
        }),
        expect: /字段 nodeFloor 不是字符串/,
        only: /字段 nodeFloor 不是字符串/,
      },
      {
        name: '自检·树内清单 builtAt 不再是 ISO-8601 形态 ⇒ 红（**只判形态不判值**：时间戳每次打包都不同）',
        run: () => mutateTree(TREE_INFO, (t) => {
          const info = JSON.parse(t);
          info.builtAt = '2026-10-05';
          return JSON.stringify(info, null, 2) + '\n';
        }),
        expect: /不是 ISO-8601 形态/,
        only: /不是 ISO-8601 形态/,
      },
      {
        name: '自检·树内清单 profile 与 hostcore/core-recipe.json 不一致 ⇒ 红（树与配方不是同一版）',
        run: () => mutateTree(TREE_INFO, (t) => {
          const info = JSON.parse(t);
          info.profile = 'not-the-recipe-profile';
          return JSON.stringify(info, null, 2) + '\n';
        }),
        expect: /profile=.*≠ 配方/,
        only: /≠ 配方/,
      },
      {
        name: '自检·树内清单 nativePackages 不是数组 ⇒ 红',
        run: () => mutateTree(TREE_INFO, (t) => {
          const info = JSON.parse(t);
          info.nativePackages = 'oops';
          return JSON.stringify(info, null, 2) + '\n';
        }),
        expect: /nativePackages 不是数组/,
      },
      {
        name: '自检·system 平台包 manifest 多出一个真 npm 清单才有的键 ⇒ 红（键集判据）',
        run: () => mutateTree(ADDON_PKG,
          (t) => t.replace('"private": true', '"private": true,\n  "main": "index.js"')),
        expect: /manifest 键集是/,
        only: /manifest 键集是/,
      },
      {
        name: '自检·system 平台包的 bin/system.node 变成 ELF 真件 ⇒ 红（占位判据 + 非 ELF 反向判据）',
        run: () => mutateTree(ADDON_PLACEHOLDER_MUSL, () => '\x7fELF\x02\x01\x01\x00-prebuilt-residue'),
        expect: /是 ELF 原生件/,
      },
      {
        name: '自检·flock.js 的 libc 判定被换回可执行的 process.report ⇒ 红（注释里提到它不算，所以先剥注释）',
        run: () => mutateTree(ADDON_FLOCK, (t) => t.replace("let libc = 'musl';",
          "let libc = 'musl';\n        if (process.report && process.report.getReport) { libc = 'musl'; }")),
        expect: /可执行代码里仍有 process\.report/,
        only: /可执行代码里仍有 process\.report/,
      },
      {
        name: '自检·别名目录里多出陈旧文件 ⇒ 红（cpSync 不删目标里多出的文件）',
        run: () => {
          const p = join(tmp, ...PLATFORM_ALIASES[0][0].split('/'), 'stale-leftover.txt');
          writeFileSync(p, 'stale\n');
          created.push(p);
          return p;
        },
        expect: /树内多出 stale-leftover\.txt/,
      },
    ];
    for (const c of shapeCases) {
      restoreAll();
      const rel = c.run();
      const res = audit(scope);
      const hit = res.fails.some((f) => c.expect.test(f));
      const onlyOk = c.only === undefined || res.fails.every((f) => c.only.test(f));
      case_(c.name, res.fails.length > 0 && hit && onlyOk,
        `rel=${rel} fails=${res.fails.length}${res.fails.length ? ' :: ' + res.fails[0].slice(0, 130) : '（没红 —— 恒真的摆设）'}`);
    }

    /* (h) 平台别名必须是**真副本**而不是 symlink/junction：逐字节比对会全绿，只有 lstat 判据能抓。
     *     变异体用 Windows 的 junction（目录联接不需要管理员/开发者模式；真 symlink 会 EPERM）。
     *     清理必须 `rmSync(p, { force: true })`（**不带 recursive**）：带 recursive 有跟进目标
     *     把源目录也删掉的风险；删掉后用真树重建别名目录。 */
    {
      restoreAll();
      const [rel, srcRel] = PLATFORM_ALIASES[0];
      const p = join(tmp, ...rel.split('/'));
      let made = false;
      let why = '';
      try {
        rmSync(p, { recursive: true, force: true });
        symlinkSync(join(tmp, ...srcRel.split('/')), p, 'junction');
        made = true;
      } catch (e) {
        why = `本机无法创建 junction（${e.code}）：${String(e.message).slice(0, 80)}`;
      }
      const caseName = '自检·别名目录被换成 junction 即红（逐字节比对全绿，只有 lstat 判据能抓）';
      if (made) {
        const res = audit(scope);
        const hit = res.fails.some((f) => f.includes('符号链接/junction'));
        const only = res.fails.every((f) => f.includes('符号链接/junction'));
        case_(caseName, hit && only,
          `rel=${rel} fails=${res.fails.length} :: ${res.fails[0] ?? ''}`);
      } else {
        case_(caseName, false, why);
      }
      try { rmSync(p, { force: true }); } catch { /* 不存在就算了 */ }
      copyTreeEntry(tmp, rel);
      const after = audit(scope);
      case_('自检·junction 复原后基线重新全绿（证明上面那条红只可能来自 junction）',
        after.fails.length === 0,
        `fails=${after.fails.length}${after.fails.length ? ' :: ' + after.fails[0].slice(0, 130) : ''}`);
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
