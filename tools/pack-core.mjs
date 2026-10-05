#!/usr/bin/env node
/**
 * pack-core.mjs —— 把 dsh 核心树物化成 **鸿蒙（openharmony / arm64）** 形态并打包。
 *
 * 背景（见 docs/50-端侧核心运行架构.md §4/§6）：
 *   端侧自足运行 dsh 的第一个前提，是有一棵**能在设备上跑起来**的核心树。
 *   这棵树必须是鸿蒙平台形态（原生依赖是 ohos-aarch64 的 .node），而不是桌面形态。
 *
 * 本脚本做四件事，每一步都可独立复跑：
 *   ① 按 hostcore/core-recipe.json 物化：npm install --os=openharmony --cpu=arm64
 *      + overrides 把 node-pty / koffi / sharp 别名到 @ohos-ports 的鸿蒙移植版
 *   ② 裁剪：删掉非鸿蒙平台的二进制（koffi 一个包就自带 19 个平台）
 *   ③ 校验：必需原生产物必须在位；每个原生 ELF 必须带 .codesign
 *      （只有 .note.ohos.ident 不算已签名 —— 实测对照见 D6 §4.2 R4）
 *   ④ 打包：放入端侧 profile，产出 ustar tar.gz + 清单（含 sha256）
 *
 * 用法：
 *   node tools/pack-core.mjs                    # 全流程
 *   node tools/pack-core.mjs --skip-install     # 复用已有 node_modules（快速重打包）
 *   node tools/pack-core.mjs --work <dir> --out <dir>
 *
 * 注意：不修改任何上游文件；不联网取任何"额外"东西（npm 除外）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
  unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryOf } from './lib/core-inventory.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// ── 参数 ────────────────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const RECIPE_PATH = resolve(ROOT, arg('--recipe', 'hostcore/core-recipe.json'));
// 输出**不能**放根 `build/`：那是 HarmonyOS 构建自己的目录，`devecocli build` 会把它清掉
// （实测踩过：node_modules 被清空后 `--skip-install` 直接失败）。因此统一放 `dist/`。
const OUT_DIR = resolve(ROOT, arg('--out', 'dist/core'));
const WORK_ROOT = resolve(ROOT, arg('--work', 'dist/core/work'));
const SKIP_INSTALL = process.argv.includes('--skip-install');

const recipe = JSON.parse(readFileSync(RECIPE_PATH, 'utf8'));
const STAGE_NAME = `dsh-core-${recipe.coreVersion}`;
const STAGE = join(WORK_ROOT, STAGE_NAME);

const log = (...a) => console.log(...a);
const die = (msg) => { console.error(`\n[pack-core] ✗ ${msg}`); process.exit(1); };

/** 在 PATH 或给定目录里找一个可执行文件（Windows 上带 .exe 也认）。 */
function which(cmd) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, cmd + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** 找 OHOS NDK 的 llvm-readelf（用于读 ELF 段表判签名）。找不到只影响签名校验。 */
function findReadelf() {
  const sdkHomes = [
    process.env.DEVECO_SDK_HOME,
    process.env.OHOS_SDK_HOME,
    'D:\\Huawei\\DevEco Studio\\sdk',
    'C:\\Program Files\\Huawei\\DevEco Studio\\sdk',
  ].filter(Boolean);
  const rels = [
    ['default', 'openharmony', 'native', 'llvm', 'bin', 'llvm-readelf'],
    ['default', 'hms', 'native', 'llvm', 'bin', 'llvm-readelf'],
  ];
  for (const home of sdkHomes) {
    for (const rel of rels) {
      for (const ext of ['.exe', '']) {
        const p = join(home, ...rel) + ext;
        if (existsSync(p)) return p;
      }
    }
  }
  return which('llvm-readelf');
}

// ── ① 物化 ──────────────────────────────────────────────────────────────
function writeBundlePackageJson() {
  const pkg = {
    name: 'dshm-core-bundle',
    version: '0.0.0',
    private: true,
    description: `DSHM 端侧 dsh 核心树（${recipe.platform.os}/${recipe.platform.cpu}），由 tools/pack-core.mjs 生成。`,
    dependencies: { '@deepseek-ai/dsh': recipe.coreVersion },
    overrides: recipe.overrides,
  };
  writeFileSync(join(STAGE, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

function materialize() {
  log(`\n[pack-core] ① 物化 ${STAGE_NAME} → ${STAGE}`);
  mkdirSync(STAGE, { recursive: true });
  writeBundlePackageJson();
  if (SKIP_INSTALL) {
    if (!existsSync(join(STAGE, 'node_modules'))) die('--skip-install 但 node_modules 不存在');
    log('[pack-core]   跳过 npm install（--skip-install）');
    return;
  }
  const npm = which('npm');
  if (!npm) die('找不到 npm');
  const args = [
    'install',
    `--os=${recipe.platform.os}`,
    `--cpu=${recipe.platform.cpu}`,
    // 目标平台的原生模块 postinstall 在宿主上跑不了（也不该跑）
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
  ];
  log(`[pack-core]   ${npm} ${args.join(' ')}`);
  // stdio: inherit —— 5 分钟量级的安装，进度要看得到；也避免管道相关限制
  // shell:true 时路径含空格必须加引号（本机 npm 位于 "D:\Program Files\nodejs\npm.cmd"，
  // 不带引号会被 shell 拆词成 'D:\Program'）。用双引号包裹并转义内部双引号。
  const npmForShell = `"${npm.replace(/"/g, '\\"')}"`;
  const r = spawnSync(npmForShell, args, { cwd: STAGE, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) die(`npm install 失败（exit=${r.status}）`);
}

// ── ② 裁剪 ──────────────────────────────────────────────────────────────
function dirSize(p) {
  if (!existsSync(p)) return 0;
  let total = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) total += statSync(f).size;
    }
  };
  walk(p);
  return total;
}

/** 极简 glob：只支持 `**&#47;` 前缀与 `*` 通配，够本脚本用。 */
function matchGlob(relPath, pattern) {
  const norm = relPath.split(sep).join('/');
  const rx = new RegExp('^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*/g, '[^/]*') + '$');
  return rx.test(norm);
}

function listFilesRecursive(base, dir = base, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) listFilesRecursive(base, f, out);
    else if (e.isFile()) out.push(f);
  }
  return out;
}

function prune() {
  const nm = join(STAGE, 'node_modules');
  log('\n[pack-core] ② 裁剪非鸿蒙二进制');
  let before = dirSize(nm);
  let removedBytes = 0;
  let removedCount = 0;

  for (const rule of recipe.prune ?? []) {
    if (rule.dir) {
      const target = join(nm, rule.dir);
      if (!existsSync(target)) continue;
      if (rule.remove) {
        removedBytes += dirSize(target);
        removedCount++;
        rmSync(target, { recursive: true, force: true });
        log(`[pack-core]   - ${rule.dir}/  （${rule.why ?? ''}）`);
      }
      if (rule.keepOnlyDirs) {
        for (const e of readdirSync(target, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          if (rule.keepOnlyDirs.includes(e.name)) continue;
          const p = join(target, e.name);
          removedBytes += dirSize(p);
          removedCount++;
          rmSync(p, { recursive: true, force: true });
        }
        log(`[pack-core]   - ${rule.dir}/{除 ${rule.keepOnlyDirs.join(', ')} 外}  （${rule.why ?? ''}）`);
      }
    }
    for (const pattern of rule.removeGlobs ?? []) {
      for (const f of listFilesRecursive(nm)) {
        const rel = f.slice(nm.length + 1);
        if (!matchGlob(rel, pattern)) continue;
        removedBytes += statSync(f).size;
        removedCount++;
        rmSync(f, { force: true });
      }
      log(`[pack-core]   - ${pattern}  （${rule.why ?? ''}）`);
    }
  }
  const after = dirSize(nm);
  log(`[pack-core]   删除 ${removedCount} 项 / ${(removedBytes / 1048576).toFixed(1)} MB；`
    + `node_modules ${(before / 1048576).toFixed(1)} MB → ${(after / 1048576).toFixed(1)} MB`);
}

// ── ③ 校验 ──────────────────────────────────────────────────────────────
function hasCodesign(readelf, file) {
  const out = execFileSync(readelf, ['-S', file], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return /\.codesign\b/.test(out);
}

/**
 * 构建期**自签名** ELF（2026-09-26 报告 3 ③ 的解法）。
 *
 * 【为什么需要】端侧 execve 对**第三方 ELF** 一律拒绝（签名域策略），与文件权限位、
 * 创建者、inode 都无关——真机决定性实验：
 *     exec 探测：… rg=denied，rg-real=denied，bash=ok
 * 其中 `rg-real` 是"把 rg 字节由宿主进程复制到 bin/（与可用的 busybox 同目录同创建者）"，
 * 结果仍 denied，推翻了"执行许可绑创建者"的旧假设。而 `bash` 能跑是因为它是
 * `#!/system/bin/sh` **脚本**——内核 exec 的是系统二进制 /system/bin/sh。
 * ⇒ 解锁 rg/git/python 真身的唯一路径是让 ELF 带**代码签名**。
 *
 * 【为什么用 selfSign 而不是完整证书链】`binary-sign-tool sign -selfSign 1` 走
 * SelfSignSignProvider：只加 `.codesign` 段并用描述符摘要当签名，
 * **跳过 .profile/.permission 段与证书链写入**，因此**不需要 keystore 密码**
 * （本机实测 exit 0、`code signature is self-sign`、`.codesign` 段 4096 字节）。
 * 这正是我们需要的：文件在应用私有沙箱内由本进程使用，不需要可分发性证明。
 *
 * 【在哪个阶段做】必须在 **verify() 之前**——verify 会检查 `.codesign` 并把缺失的
 * 列进 `unsigned`。签名后它对已签文件即为通过。
 *
 * 【幂等】已带 `.codesign` 的跳过（重复签名会反复追加段、体积增长且无意义）。
 * 【失败策略】工具或 JDK 缺失时**只告警不 die**：签名是"解锁被平台拒绝的能力"的
 * 增量步骤，不该让整条打包链（能产出可运行的核心树）失败。但会把清单如实标成
 * `signatureCheckSkipped`/`selfSignSkipped`，不在验收上撒谎。
 */
function selfSignNatives() {
  const nm = join(STAGE, 'node_modules');
  const tool = findBinarySignTool();
  if (tool === null) {
    log('[pack-core]   ⚠ 找不到 binary-sign-tool（或 JDK）：跳过自签名，rg/git 真身仍会被 execve 拒');
    return { attempted: 0, signed: 0, skipped: true };
  }
  const readelf = findReadelf();
  /*
   * 【为什么只签"要被 exec 的可执行件"，不碰 .node/.so】
   * 端侧两条不同的原生加载路径，要求不一样：
   *   · `.node`/`.so` 走 **dlopen**（koffi/sharp 即此路径，真机已验证可用）——
   *     它们**不需要** .codesign，重签反而有破坏已验证链路的风险；
   *   · 独立**可执行件**走 **execve**——这条才被签名域策略拒绝，也正是我们要解锁的
   *     （rg 是 fs-search 的 spawn 目标；git/python 真身在 toolchain 归档里，
   *      由 ensureToolchainWrappers 那条链处理，不在本函数范围）。
   * 故这里的目标集刻意很小：只列**真正要 exec 的**文件，最小化爆炸半径。
   */
  const targets = new Set();
  const rg = join(nm, '@vscode', 'ripgrep-linux-arm64', 'bin', 'rg');
  if (existsSync(rg)) targets.add(rg);

  let signed = 0;
  let attempted = 0;
  for (const f of targets) {
    if (!existsSync(f)) continue;
    if (readelf !== null) {
      let already = false;
      try { already = hasCodesign(readelf, f); } catch { already = false; }
      if (already) {
        log(`[pack-core]   自签名：${f.slice(nm.length + 1)} 已带 .codesign，跳过`);
        continue; // 幂等
      }
    }
    attempted += 1;
    const tmp = `${f}.dshm-selfsign`;
    try {
      execFileSync(tool.java, [
        '-jar', tool.jar, 'sign',
        '-mode', 'localSign',
        '-selfSign', '1',
        '-inFile', f,
        '-outFile', tmp,
        '-signAlg', 'SHA256withECDSA',
      ], { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
      if (statSync(tmp).size <= 0) throw new Error('输出为空');
      copyFileSync(tmp, f);
      signed += 1;
      log(`[pack-core]   自签名：${f.slice(nm.length + 1)} 已加 .codesign（selfSign）`);
    } catch (e) {
      log(`[pack-core]   ⚠ 自签名失败 ${f.slice(nm.length + 1)}：${String(e && e.message ? e.message : e).slice(0, 160)}`);
    } finally {
      try { rmSync(tmp, { force: true }); } catch { /* 清理失败无碍 */ }
    }
  }
  log(`[pack-core]   自签名（selfSign）：${signed}/${attempted} 个可执行件已签`
    + `${signed > 0 ? '（带 .codesign 段，端侧 execve 才可能放行）' : ''}`);
  return { attempted, signed, skipped: false };
}

/** 找 binary-sign-tool.jar 与可用的 java：找不到返回 null（签名是可选增量步骤）。 */
function findBinarySignTool() {
  const javaCandidates = [
    process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : '',
    'C:\\Program Files\\Huawei\\DevEco Studio\\jbr\\bin\\java.exe',
  ].filter((p) => p.length > 0 && existsSync(p));
  const jarCandidates = [
    process.env.OHOS_SDK_HOME
      ? join(process.env.OHOS_SDK_HOME, 'default', 'openharmony', 'toolchains', 'lib', 'binary-sign-tool.jar') : '',
    'C:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\lib\\binary-sign-tool.jar',
  ].filter((p) => p.length > 0 && existsSync(p));
  if (javaCandidates.length === 0 || jarCandidates.length === 0) {
    return null;
  }
  return { java: javaCandidates[0], jar: jarCandidates[0] };
}

function verify() {
  const nm = join(STAGE, 'node_modules');
  log('\n[pack-core] ③ 校验原生产物与签名');

  const missing = (recipe.requiredNative ?? []).filter((r) => !existsSync(join(nm, r)));
  if (missing.length > 0) die(`必需原生产物缺失：\n    ${missing.join('\n    ')}`);
  for (const r of recipe.requiredNative ?? []) log(`[pack-core]   ✓ 必需 ${r}`);

  const readelf = findReadelf();
  if (!readelf) {
    log('[pack-core]   ⚠ 找不到 llvm-readelf，跳过签名校验（这不是通过，只是没验）');
    return { signed: [], unsigned: [], skipped: true };
  }
  log(`[pack-core]   使用 ${readelf}`);

  // 必查：recipe.requiredNative + 所有 .node/.so
  const targets = new Set((recipe.requiredNative ?? []).map((r) => join(nm, r)));
  for (const f of listFilesRecursive(nm)) {
    if (/\.(node|so)(\.\d+)*$/.test(f)) targets.add(f);
  }
  const signed = [];
  const unsigned = [];
  for (const f of targets) {
    if (!existsSync(f)) continue;
    let ok = false;
    try { ok = hasCodesign(readelf, f); } catch { ok = false; }
    (ok ? signed : unsigned).push(f.slice(nm.length + 1));
  }
  for (const s of signed) log(`[pack-core]   ✓ .codesign ${s}`);
  if (unsigned.length > 0) {
    log(`[pack-core]   ⚠ 未检出 .codesign 的原生文件 ${unsigned.length} 个：`);
    for (const u of unsigned) log(`[pack-core]       ${u}`);
    log('[pack-core]   （.note.ohos.ident 单独出现不构成"已签名"的证据，见 D6 §4.2 R4）');
  }
  return { signed, unsigned, skipped: false };
}

// ── ④ 打包 ──────────────────────────────────────────────────────────────

/**
 * 关掉官方语音录音的**回声消除（AEC）**—— "识别率不对"的**根因修复**。
 *
 * 【真机证据链（这一版的结论已用对照实验坐实）】
 *   官方 UI 的 `getUserMedia` 带了通话场景的约束
 *   （`dsh-experimental-client-ui-voice-input/lib/client.js`）：
 *     audio: { echoCancellation: true, noiseSuppression: true }
 *
 *   **三条路径的唯一区分变量就是"那一刻 WebView 是否开着麦克风"**：
 *     | 路径                        | 并发 getUserMedia | 识别结果            |
 *     | 自检（ArkTS 直接采+识别）    | 无                | `12342234。` ✅     |
 *     | 无并发桥（采好后经桥识别）    | 无                | `一到三四号三四。` ✅ |
 *     | 桥 + ring（官方按钮触发）     | **有**            | `。` ❌            |
 *   ⇒ 只要 WebView 打开麦克风，识别就崩；不打开就正常。
 *
 * 【机制】AEC 需要"参考信号"来抵消回声，为此它会**改变整个麦克风通路的处理**。
 *   同进程内其它采集（包括 ArkTS 的 `AudioCapturer`）拿到的数据**同样被改变**
 *   ⇒ 这不是"我们采到的音频坏了"，而是"麦克风通路被 AEC 处理过了"。
 *
 * 【为什么它解释了之前所有失败的尝试】（这些弯路都记在 device-validation 批次二十四）
 *   · 频谱正常、强谐波、不削顶 —— AEC 输出仍像语音，但内容已失真
 *   · 关 `noiseSuppression` 无效 —— **AEC 是另一个开关**（当时只关了降噪，
 *     而且我给出的"高频被削"解释是**错的**：后续严谨 FFT 显示官方路径的高频
 *     反而比"能识别"那一路更多）
 *   · 绕开 MediaRecorder/Opus 编解码无效 —— AEC 在其**上游**
 *   · 改用 `AudioCapturer` 采音也失败 —— AEC 影响的是**麦克风通路本身**
 *   · 幅度差约 7.9 倍（peak 28345 vs 3595）—— AEC/AGC 介入的旁证
 *
 * 【代价（如实记录）】关掉 AEC 后，扬声器外放的声音可能被录进麦克风
 *   （自激/回声）。端侧场景是"用户对着设备说话"，这个代价可接受；
 *   若将来要支持"外放时也说话"，需要重新评估。
 *
 * 【与上一版的关系】上一版只关 `noiseSuppression` 并宣称那是根因 ——
 *   **那个结论是错的**（关掉后识别率毫无改善，补丁前后高频占比 2.85%→3.25%）。
 *   本版关 AEC，两处都改，并把错误解释一并纠正，避免后人被误导。
 */
/**
 * 让官方麦克风按钮改用**原生采集**（ArkTS AudioCapturer）。
 *
 * 【真机结论（对照实验坐实）】只要官方 `Recording.start()` 打开 getUserMedia，
 * 识别就崩；不并发它就正常：
 *   | 路径                    | 并发 getUserMedia | 识别            |
 *   | 自检（ArkTS 直采+识别）  | 无                | "12342234。" ✅  |
 *   | 无并发桥（采好再识别）   | 无                | "一到三四号三四。" ✅ |
 *   | 官方按钮                | **有**            | "。" ❌         |
 * 已排除 12 个假设（采样率/高频/降噪/AEC/编解码/时长/投喂路径/噪声化…）。
 *
 * 【改动最小化 + 做法】在 client.js **末尾追加**一段，覆盖
 * `Recording.prototype.start/stop` 只换**采集**；官方后续的
 * transcribe() → provider → HMS → 插入草稿**全部保留**。
 * 追加而非锚点替换：`Recording` 是模块级变量，同作用域可引用，
 * ⇒ 不依赖任何锚点，不会被上游格式变化打断。
 *
 * 【桥方法】WebApp.ets 的 __DSHM_BRIDGES__ 提供（均同步返回，采集在 ArkTS 后台）
 *   startNativeCapture(): string  —— 立即返回，异步启动 AudioCapturer
 *   nativeCaptureState(): string  —— JSON {phase,bytes,peak,ms}
 *   takeNativeCapture(): string   —— canonical WAV 的 base64（取走即重置）
 */
function patchVoiceInputNativeCapture() {
  const file = join(STAGE, 'node_modules', '@deepseek-ai',
    'dsh-experimental-client-ui-voice-input', 'lib', 'client.js');
  if (!existsSync(file)) {
    log('[pack-core]   语音输入 client.js 不存在，跳过原生采集补丁');
    return;
  }
  let text = readFileSync(file, 'utf8');
  const MARK = 'DSHM_NATIVE_CAPTURE';
  /*
   * 【为什么用版本号而不是"存在即跳过"】
   * 原来只要文件里含 MARK 就整段跳过。后来给注入段**新增了 amplitude 覆盖**
   * （频谱），而树里已有旧版注入 ⇒ 新版永远注入不进去，
   * 表现为"改了补丁但设备行为没变" —— 这类问题排查成本极高。
   *
   * 现在：版本一致才跳过；版本不同则**先删掉旧注入段**再注入新版
   * （不删会出现两份 start/stop 覆盖，后者包住前者，行为难预测）。
   */
  const MARK_VERSION = 'v3-permission-window';
  const VERSION_TAG = MARK + '@' + MARK_VERSION;
  if (text.includes(VERSION_TAG)) {
    log('[pack-core]   原生采集补丁已是 ' + MARK_VERSION + '，跳过');
    return;
  }
  if (text.includes(MARK)) {
    /* 移除旧注入段：从 MARK 所在注释起，到其后的 '})();' 结束 */
    const start = text.lastIndexOf('/*', text.indexOf(MARK));
    const endMark = text.indexOf('})();', text.indexOf(MARK));
    if (start < 0 || endMark < 0) {
      die('原生采集补丁：发现旧注入但无法定位其边界，请人工检查 client.js');
    }
    text = text.slice(0, start) + text.slice(endMark + '})();'.length);
    log('[pack-core]   已移除旧版原生采集注入，准备注入 ' + MARK_VERSION);
  }
  /* 必须确认 Recording 是模块级变量（否则追加的代码引用不到） */
  if (!/\bvar Recording = class/.test(text) && !/\bclass Recording\b/.test(text)) {
    die('原生采集补丁：client.js 里找不到模块级 Recording（树形态变了）');
  }
  /*
   * 追加的覆盖代码。
   * 【只用块注释】因为整段是**单行**（模板里用 \n 显式换行，见下），
   * 若写 `//` 会把后面整行注释掉 —— 这是我这几轮反复踩的坑。
   */
  const overlay = [
    '',
    '/* ' + VERSION_TAG + ': 让官方录音改用 ArkTS 原生采集 + 频谱电平（官方 getUserMedia 会破坏识别） */',
    '(function () {',
    '  const br = () => globalThis.__DSHM_BRIDGES__;',
    /*
     * 频谱数据源。
     *
     * 【为什么必须覆盖】官方 `amplitude()` 读的是 `this.analyser`
     * （`AudioContext.createAnalyser()` + `getFloatTimeDomainData`）。
     * 但原生采集覆盖了 `start()`，只创建 MediaRecorder 的那段被跳过 ⇒
     * `analyser` 从未创建 ⇒ `amplitude()` 恒返回 0 ⇒ 波形柱状图一直是静止的最小值
     * （用户可见现象：说话时没有频谱）。
     *
     * 【取什么值】ArkTS 侧 `nativeCaptureState()` 的 `rms` 字段 ——
     * 它是**最近一次音频回调**的均方根并以指数平滑，
     * 在**已有**的采样循环里顺带算出（不新增遍历）。
     *
     * 【为什么用 RMS 而不是峰值】官方按下式的 level 使用该值：
     *   height = 1 + Math.min(1, level * 5) * 17      // 18 = 满格
     * 官方 amplitude() 返回的正是 RMS。若改用峰值会顶格 ——
     * 真机实测平静说话 peak=21020、较大声=28311，即使除以 4 也已 14.6/18。
     * 而 RMS 与官方同口径（实测柱高 9.1 / 11.9），起伏清晰可见。
     */
    '  const origAmplitude = Recording.prototype.amplitude;',
    '  Recording.prototype.amplitude = function () {',
    '    try {',
    '      const b = br();',
    '      if (b && typeof b.nativeCaptureState === \'function\') {',
    '        const st = JSON.parse(b.nativeCaptureState());',
    '        if (st && st.phase === \'recording\') {',
    '          const v = typeof st.rms === \'number\' ? st.rms : 0;',
    '          return Math.min(1, v / 32768);',
    '        }',
    '      }',
    '    } catch (e) {',
    '      /* 取不到就回落到官方实现（例如未走原生采集时） */',
    '    }',
    '    return origAmplitude.call(this);',
    '  };',
    '  const origStart = Recording.prototype.start;',
    '  Recording.prototype.start = async function (onError) {',
    '    try {',
    '      const b = br();',
    '      if (!b || typeof b.startNativeCapture !== \'function\') {',
    '        return await origStart.call(this, onError);',
    '      }',
    '      this.lifetime.signal.throwIfAborted();',
    '      b.startNativeCapture();',
    '      const t0 = Date.now();',
    '      /* 等待窗口 15 秒：首次使用会弹系统麦克风授权框，',
    '       * 用户读完再点是**人的时间尺度**。原来的 3 秒会在用户还在看弹框时',
    '       * 就超时报 unavailable（现象：点一下没反应，再点才可能成功）。',
    '       * 授权只在首次发生，之后启动仍在百毫秒级返回。 */',
    '      while (Date.now() - t0 < 15000) {',
    '        let st = \'\';',
    '        try { st = b.nativeCaptureState(); } catch (e) {}',
    '        if (st.indexOf(\'"phase":"recording"\') >= 0) { return; }',
    '        if (st.indexOf(\'"phase":"error\') >= 0) { throw new RecordingError("interrupted"); }',
    '        await new Promise(function (r) { setTimeout(r, 50); });',
    '      }',
    '      throw new RecordingError("unavailable");',
    '    } catch (err) {',
    '      if (err instanceof RecordingError) { throw err; }',
    '      throw new RecordingError("unavailable");',
    '    }',
    '  };',
    '  const origStop = Recording.prototype.stop;',
    '  Recording.prototype.stop = async function (maxDurationSeconds) {',
    '    const b = br();',
    '    if (!b || typeof b.takeNativeCapture !== \'function\') {',
    '      return await origStop.call(this, maxDurationSeconds);',
    '    }',
    '    const b64 = b.takeNativeCapture();',
    '    if (!b64 || b64.length === 0) {',
    '      await this.dispose();',
    '      throw new RecordingError("empty");',
    '    }',
    '    const bin = atob(b64);',
    '    const out = new Uint8Array(bin.length);',
    '    for (let i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }',
    '    this.lifetime.signal.throwIfAborted();',
    '    return out;',
    '  };',
    '})();',
    '',
  ].join('\n');
  /*
   * 【必须插在 factory 内部】client.js 是 `window.__ModuleLoader__.load({ factory:
   * (require) => { ... return module.exports; } })` 的形式，`Recording` 定义在
   * factory 里。若把覆盖代码追加到**文件末尾**（factory 之外），`Recording`
   * 不在作用域 ⇒ 抛 ReferenceError ⇒ 覆盖不生效（真机表现：diag-native 永远为空）。
   * 所以插到 `return module.exports;` **之前**。
   */
  const exitAnchor = 'return module.exports;';
  const at = text.lastIndexOf(exitAnchor);
  if (at < 0) {
    die('原生采集补丁：未找到 "return module.exports;" —— 无法把覆盖代码放进 factory 内（树形态变了）');
  }
  const patched = text.slice(0, at) + overlay + text.slice(at);
  writeFileSync(file, patched, 'utf8');
  log('[pack-core]   官方麦克风按钮已改用原生采集（识别修复）');
}

function patchVoiceInputNoiseSuppression() {
  const file = join(STAGE, 'node_modules', '@deepseek-ai',
    'dsh-experimental-client-ui-voice-input', 'lib', 'client.js');
  if (!existsSync(file)) {
    log('[pack-core]   语音输入 client.js 不存在，跳过录音约束补丁');
    return;
  }
  let text = readFileSync(file, 'utf8');

  const MARK_AEC = 'DSHM_ECHO_CANCELLATION_OFF';
  const MARK_NS = 'DSHM_NOISE_SUPPRESSION_OFF';

  /*
   * ① 关 AEC —— 根因修复。
   * 锚点 `echoCancellation: true` 在本文件里只出现 1 次（已核实）。
   */
  if (!text.includes(MARK_AEC)) {
    const beforeAec = 'echoCancellation: true';
    if (!text.includes(beforeAec)) {
      die(`录音约束补丁：未找到 "${beforeAec}"（树形态变了，需重新核对 client.js）`);
    }
    text = text.replace(beforeAec,
      `echoCancellation: false /* ${MARK_AEC}：AEC 会改变整个麦克风通路的处理，`
      + `使同进程内其它采集（含 ArkTS AudioCapturer）拿到的音频内容失真 ⇒ `
      + `真机实测识别率崩（说 8 位数字只出"。"）。对照实验：不并发 getUserMedia 时识别正常。`
      + `代价：外放声音可能被录入。详见 docs/device-validation.md 批次二十四 */`);
    log('[pack-core]   已关闭官方录音的回声消除（AEC，识别率根因修复）');
  } else {
    log('[pack-core]   AEC 补丁已在，跳过');
  }

  /*
   * ② 同时关 noiseSuppression。
   *
   * 【为什么还留着这一步】它不是根因（关掉后识别率无改善，实测补丁前后
   * 高频占比 2.85%→3.25%），但对"用户对着设备说话"这个场景仍无害且有轻微收益。
   * 保留它是因为**新树里锚点仍是 true**（pack-core 每次都重新 materialize），
   * 需要一并处理；而不是因为它是修好识别的那一步。
   */
  if (!text.includes(MARK_NS)) {
    const beforeNs = 'noiseSuppression: true';
    if (text.includes(beforeNs)) {
      text = text.replace(beforeNs,
        `noiseSuppression: false /* ${MARK_NS}：ArkWeb 的噪声抑制是激进的频带滤波。`
        + `注：它**不是**识别率问题的根因（关掉后无改善）—— 根因是 AEC，见上一条。 */`);
      log('[pack-core]   已关闭官方录音的噪声抑制（非根因，顺带处理）');
    } else if (text.includes('noiseSuppression: false')) {
      // 已经被上一版补丁改过（带旧注释）⇒ 用新注释覆盖旧错误说明
      text = text.replace(/noiseSuppression: false \/\* DSHM_NOISE_SUPPRESSION_OFF：[\s\S]*?\*\//,
        `noiseSuppression: false /* ${MARK_NS}：ArkWeb 的噪声抑制是激进的频带滤波。`
        + `注：它**不是**识别率问题的根因（关掉后无改善，实测补丁前后高频占比 2.85%→3.25%）—— `
        + `根因是 AEC，见上一条。这里关掉它只是顺带去掉一层无益的处理。 */`);
      log('[pack-core]   已更新降噪补丁的旧注释（旧版把根因归错了）');
    } else {
      die('录音约束补丁：既没找到 noiseSuppression: true 也没找到 false，需核对 client.js');
    }
  } else {
    log('[pack-core]   降噪补丁已在，跳过');
  }

  writeFileSync(file, text, 'utf8');
}

/**
 * 把 SenseVoice 的识别实现替换为 **HMOS 系统语音识别**（DSHM 定制）。
 *
 * 【为什么替换而不是新增包】dsh loader 解析裸包名要经一张**由 bundle 依赖闭包
 * 构成的包表**。真机实测：新增的 `dsh-speech-to-text-stub` 报
 *   `failed to import`（不在任何闭包里）；
 * 而 `dsh-host-directory-picker-browse` 能解析，因为它 ⊂ `dsh-web-app`.dependencies。
 * 本包（sensevoice）已在 `dsh-experimental-voice-input-bundle` 闭包内、
 * profile 也已有它的行 ⇒ **改它无需任何新接线**。
 *
 * 【注入手法】把实现作为**相对 import**接进该包：
 *   ① 拷 hostcore/speech-provider/index.js → 该包 `lib/hms-provider.js`；
 *   ② 顶部加 `import { hmsApply, hmsProviderInject } from "./hms-provider.js"`
 *      （相对说明符按文件位置解析，不经 bare 包表 ⇒ 必然可用）；
 *   ③ 末尾导出改为把 `apply`/`inject` 换成 HMS 版。
 *   ⇒ 对 loader 而言插件形状不变，但 apply 已是 HMS 实现。
 */
/**
 * 校验注入后的语音 provider 语法（报告 P0 建议的门禁）。
 *
 * 【为什么必须做 —— 真实事故（2026-09-26）】
 *   推送的 hms-provider.js 里有**重复的顶层 `const SEG_ATTEMPTS`**
 *   （新加的 =2 与旧的 =3 并存）。作为 **ES Module** 这是 SyntaxError
 *   ⇒ 插件 `failed to import` ⇒ 语音服务退化到 stub
 *   ⇒ `preparation.phase` 不再是 ready ⇒ 官方 UI 判 usable=false
 *   ⇒ **点按钮直接跳设置页**（表现为"功能整个失效"）。
 *
 * 【为什么 `node --check` 拦不住】它默认按 CommonJS 解析，
 *   顶层重复 const 在 CJS 下不报错；必须按 **ESM** 解析才能复现。
 *
 * 【为什么接在这里】注入发生在 patchSensevoiceForHms 里，
 *   生成物（lib/hms-provider.js）才是真正被 import 的文件 ——
 *   必须校验**生成后的字节**，而不是源文件。
 *
 * @param providerPath 生成后的 provider 路径
 */
function validateSpeechProviderSyntax(providerPath) {
  if (!existsSync(providerPath)) {
    die(`语音语法门禁：生成物不存在 ${providerPath}`);
  }
  const src = readFileSync(providerPath, 'utf8');

  /* ① 按 ESM 解析（写成 .mjs 再 --check，这样 node 用 ESM 语义） */
  const tmp = join(tmpdir(), 'dshm-provider-syntax-check.mjs');
  writeFileSync(tmp, src, 'utf8');
  const syntax = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  try {
    unlinkSync(tmp);
  } catch (e) {
    /* 清理失败不影响结论 */
  }
  if (syntax.status !== 0) {
    const detail = String(syntax.stderr || '').split('\n').slice(0, 6).join(' | ');
    die(`语音语法门禁：ESM 解析失败（会导致插件 failed to import、按钮失效）：${detail}`);
  }

  /* ② 顶层重复声明 */
  const seen = new Map();
  const dups = [];
  src.split('\n').forEach((line, i) => {
    const m = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (!m) {
      return;
    }
    if (seen.has(m[1])) {
      dups.push(`${m[1]}（行 ${seen.get(m[1])} 与 ${i + 1}）`);
    } else {
      seen.set(m[1], i + 1);
    }
  });
  if (dups.length > 0) {
    die(`语音语法门禁：顶层重复声明（ESM 下是 SyntaxError）：${dups.join(', ')}`);
  }

  /* ③ 常量引用完整性（SEG_/WAV_ 前缀必须都有定义） */
  const defined = new Set();
  src.split('\n').forEach((line) => {
    const m = /^const ([A-Za-z_$][\w$]*)/.exec(line);
    if (m) {
      defined.add(m[1]);
    }
  });
  const missing = [];
  for (const m of src.matchAll(/\b((?:SEG|WAV)_[A-Z0-9_]+)\b/g)) {
    if (!defined.has(m[1]) && !missing.includes(m[1])) {
      missing.push(m[1]);
    }
  }
  if (missing.length > 0) {
    die(`语音语法门禁：引用了未定义的常量：${missing.join(', ')}`);
  }

  log(`[pack-core]   语音 provider 语法门禁通过（ESM 解析、无重复声明、常量完整）`);
}
function patchSensevoiceForHms() {
  const pkgDir = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-experimental-speech-to-text-sensevoice');
  const src = join(ROOT, 'hostcore', 'speech-provider', 'index.js');
  if (!existsSync(src)) {
    log('[pack-core]   语音 provider 源不存在，跳过：hostcore/speech-provider/index.js');
    return;
  }
  const target = join(pkgDir, 'lib', 'index.js');
  if (!existsSync(target)) {
    log('[pack-core]   未找到 sensevoice lib/index.js，跳过 HMS 替换');
    return;
  }

  // ① 把实现拷进该包（相对 import 的目标）
  const destImpl = join(pkgDir, 'lib', 'hms-provider.js');
  cpSync(src, destImpl, { force: true });

  /*
   * ①b 在线模型下载器（provider 以 `../speech-models/index.js` 引用）。
   *
   * 【为什么单独拷】hms-provider.js 落在 `<pkg>/lib/` 下，而源文件里的相对
   * 引用是 `../speech-models/index.js` ⇒ 解析到 `<pkg>/speech-models/index.js`。
   * 只拷 provider 而不拷它，运行时会 `Cannot find module`。
   *
   * 【缺了就报错而不是静默跳过】provider 无条件 import 它；缺失只会在端侧
   * 表现为"插件加载失败"，那时排查成本远高于打包期直接失败。
   */
  const srcModels = join(ROOT, 'hostcore', 'speech-models', 'index.js');
  if (!existsSync(srcModels)) {
    die('语音 provider 依赖在线下载器，但 hostcore/speech-models/index.js 不存在');
  }
  const destModels = join(pkgDir, 'speech-models', 'index.js');
  mkdirSync(dirname(destModels), { recursive: true });
  cpSync(srcModels, destModels, { force: true });
  log('[pack-core]   在线模型下载器已放入：@deepseek-ai/…-sensevoice/speech-models/index.js');

  // ② ③ 改写 index.js（幂等：以标记判断是否已改）
  const MARK = 'DSHM_HMS_PROVIDER';
  let text = readFileSync(target, 'utf8');
  /*
   * 【兼容改名前的旧标记】核心树里由**上一版 pack-core** 打过的是 `HDSH_HMS_PROVIDER`。
   * 只认新名 ⇒ 判成"没打过" ⇒ 继续往下走导出语句替换，
   * 而 `export { Config, apply, inject, name };` 早已被换成 `hmsApply` 形态
   * ⇒ `die('未找到 sensevoice 的导出语句')`（本轮实测发生过一次）。
   * 与其余 7 处同因同修。
   */
  if (text.includes(MARK) || text.includes('HDSH_HMS_PROVIDER')) {
    log('[pack-core]   HMS provider 替换已在，跳过');
    /*
     * 【幂等分支也必须校验】真实事故：注入发生在**上一次** pack-core，
     * 而这次走"已在，跳过" ⇒ 若只在写入后校验，这条路径就完全绕过了门禁，
     * 坏文件会被一路打进 zip。所以两条路径都要过同一道校验。
     *
     * 【校验的是 destImpl（hms-provider.js）】它才是被 import 的生成物；
     * 上面的 cpSync 每次都会用源文件覆盖它 ⇒ 源文件的语法错误会在这里暴露。
     */
    validateSpeechProviderSyntax(destImpl);
    return;
  }
  text = '/* ' + MARK + ' */\n' + text;
  text = 'import { hmsApply, hmsProviderInject } from "./hms-provider.js";\n' + text;
  const before = 'export { Config, apply, inject, name };';
  const after = 'export { Config, hmsApply as apply, hmsProviderInject as inject, name };';
  if (!text.includes(before)) {
    die('HMS provider 替换：未找到 sensevoice 的导出语句（' + before + '），树形态变了');
  }
  text = text.replace(before, after);
  writeFileSync(target, text, 'utf8');
  log('[pack-core]   HMS provider 已接入：@deepseek-ai/dsh-experimental-speech-to-text-sensevoice');
  validateSpeechProviderSyntax(target);
}

function embedProfile() {
  if (!recipe.profile) return;
  const src = join(ROOT, 'hostcore', 'profile', recipe.profile);
  if (!existsSync(src)) die(`profile 源目录不存在：${src}`);
  const dest = join(STAGE, 'profiles', recipe.profile);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, force: true });
  log(`\n[pack-core] ④ 端侧 profile 已放入 ${STAGE_NAME}/profiles/${recipe.profile}/`);
}

/**
 * DSHM **自带插件**包：源码在仓库 `hostcore/plugins/<dir>/`，打包时放进核心树
 * `node_modules/@deepseek-ai/<pkg>/`（不是往 `hostcore/app/` 丢一个裸 .js——
 * dsh loader 只认"包"：package.json + 入口）。
 *
 * 【为什么需要"声明成依赖"这一步】`@deepseek-ai/dsh-app-boot` 的运行时解析表
 * （`createRuntimeResolution` → `collectInstallationScopePackages`）**只收录依赖闭包
 * 里的包**：装了却没被任何 manifest 声明过的目录，loader 按名字找不到
 * （`routeUrl` → `routeScoped` 查不到条目 ⇒ 退化成 Node 原生解析 ⇒ failed to import）。
 * 三情形对照（`createRuntimeResolution`）给出的结果：
 *   · 只把包丢进核心树 node_modules 而不声明 ⇒ entries 里**没有**它，NOT RESOLVABLE；
 *   · 声明为 `@deepseek-ai/dsh-web-app` 的 dependency（它 ⊂ 安装锚点 `@deepseek-ai/dsh`
 *     的依赖闭包）⇒ entries 里**有**它（scope=installation），RESOLVED。
 * 这也正是 profile 的 cordis.patch.yml 里"browse/native 能解析，因为它 ⊂ dsh-web-app
 * 的 dependencies"那条既有笔记的同一机制（见该文件 :239-241）。
 *
 * 【为什么不改上游源码】只改**打进树里的那份 manifest**，不改上游仓库；而且这是
 * 打包层的常规手段（本文件已有 patchFsLocalLink / patchCredentialsOwnerCheck 等先例）。
 * 恢复条件：删掉下面的声明与调用即可（`hostcore/plugins/` 与 cordis.patch.yml 的
 * `insert:` 行是另外两处）。
 *
 * 【本清单是唯一真源，三处状态必须与它相等】`DSHM_PLUGIN_PACKAGES` 同时决定：
 *   ① `STAGE/node_modules/@deepseek-ai/` 下的 `dshm-*` 目录集合；
 *   ② `DSHM_PLUGIN_DECLARER` 的 `dependencies` 里 `@deepseek-ai/dshm-*` 键集合；
 *   ③ 最终产物里 `@deepseek-ai/dshm-*` 的条目集合。
 * `STAGE` 是**长期复用、从不重置**的暂存树，而本步的写入只按清单做事 ⇒ 如果只"按清单
 * 拷进去 + 往 dependencies 里加键"，清单里**移除**一项时旧目录与旧依赖行会原样留在树上，
 * 并被打进产物；门禁只看 `hostcore/` 源码与产物哈希，不看暂存树 ⇒ 该残留静默通过。
 * 因此本步在写入前做**对称清理**（删掉 scope 下所有清单外的 `dshm-*` 条目；声明者里
 * 先删掉全部 `@deepseek-ai/dshm-*` 键再按清单重写），写入后由
 * `assertDshmBelongingsConsistent()` 对 ①② 做集合断言，不等即 `die` 并打印两边差集。
 */
const DSHM_PLUGIN_PACKAGES = [
  // 模型可见的"文件改动"工具（remove / move / publish）：`ctx.fs` 契约里没有删除/
  // 移动/复制方法，端侧又没有可用的 shell（连 `cp` 都没有）⇒ 这三件事只能由自带工具
  // 提供。publish 的目标根取自 `DSHM_PUBLIC_DOWNLOAD`（ArkTS 认领到的用户可见目录），
  // 落盘复用去 chmod 的 `open('w')→write→close` 原语（见 cordis.patch.yml ⑦）。
  { name: '@deepseek-ai/dshm-tool-fs-remove', dir: 'dshm-tool-fs-remove' },
  // 默认工作区登记（见 cordis.patch.yml ⑧ 与插件头注）：把 ArkTS
  // 认领到的 `Download/<包名>/` 在启动期登记进工作区注册表，使官方 Web UI 的
  // `recentWorkspace()` 选中它 ⇒ "新建会话"默认落在用户可见目录，而不是历史 picker
  // 记忆值。**惰性**：没有 `DSHM_PUBLIC_DOWNLOAD` 时 apply() 直接返回。
  { name: '@deepseek-ai/dshm-workspace-claim', dir: 'dshm-workspace-claim' },
  // 去 chmod 的写入后端（见 cordis.patch.yml ⑩ 与插件头注）：
  // 上游 `@deepseek-ai/dsh-fs-local` 的 `writeFileAtomic()` 用 `chmod` 保护暂存目录/暂存
  // 文件，而鸿蒙 hmdfs 的用户可见公共目录（`Download/<包名>/`）不放行 chmod ⇒ 真机逐字
  // `EPERM: operation not permitted, chmod …tmpdir`，"agent 写工作区文件"必失败。
  // 本插件 `extends SandboxedFileSystem`，只重写 `writeText` / `editText` 的落盘一步
  // （`open('w')→write→close`，31 号探针记录的放行组合）；读/路径封闭/锁/版本守卫照旧
  // 继承上游。profile 里把 `fs-sandbox` 那一行停用、换成本插件。
  { name: '@deepseek-ai/dshm-fs-write-nonchmod', dir: 'dshm-fs-write-nonchmod' },
  // 侧栏 Office 文档预览改走系统预览窗（见 cordis.patch.yml ⑫ 与插件头注）：
  // 上游内置 office 实现（`@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js`
  // 的 `…/office`）的读取函数是恒 reject 的桩，只有 `remote.officeToPdf` 就绪才会换成真
  // 实现；而它的宿主提供者 `@deepseek-ai/libreoffice-kit` 在 openharmony-arm64 上结构性
  // 不可达（`resolveEngine()` 抛 `Unsupported LibreOfficeKit host: …`）⇒ 端侧开
  // doc/docx/ppt/pptx 只会看到「Office 预览不可用」+ 正文空转。
  // 本插件是**纯客户端**插件（host 半边是空 apply，照 `@deepseek-ai/dsh-client-ui-open-in-app`
  // 的做法）：`priority` 非 `builtin` ⇒ 一定赢 `candidates[0]`，把内置桩顶掉，改用
  // `loading:"bytes-complete"` + 正文面板/工具栏按钮调 ArkTS 桥 `openFilePreview` 弹系统预览窗。
  // **只认领 `doc/docx/ppt/pptx`**：`xls/xlsx/csv/tsv` 归内置 Excel（纯客户端实现，端侧正常）。
  { name: '@deepseek-ai/dshm-office-system-preview', dir: 'dshm-office-system-preview' },
  // PTC 运行时（同进程纯 JS 实现，2026-10-05）：
  //
  // 【为什么必须换掉官方实现】`@deepseek-ai/dsh-ptc-runtime-node` 有两条**结构性死路**：
  //   ① 用 `node:module` 的 `stripTypeScriptTypes`（SWC 的 **wasm** 版）剥离用户脚本的
  //      TS 类型 ⇒ `--jitless` 下必抛。2026-10-05 真机日志逐字可见：先
  //      `ExperimentalWarning: stripTypeScriptTypes …`（第一次调用），紧接着
  //      `code run failed (exception): WebAssembly is not defined` —— 失败发生在
  //      **解析/擦除那一刻**，所以空程序、非法语法、`tools.bash` 全都报同一条
  //      ⇒ PTC 模式 31 个工具全不可达。
  //   ② 它还要新起一个子 Node 进程（端侧 `spawn` 被拒 `EACCES`，且
  //      `process.execPath` 是 `/system/bin/appspawn`）。
  //
  // 【本插件做什么】按 `ctx.ptcRuntime` 缝（`@deepseek-ai/dsh-ptc-runtime`）重新实现：
  //   纯 JS 类型擦除（`lib/ts-strip.cjs` + vendor 的 `@babel/standalone` 单文件；
  //   仍是官方那套"包进 `async function __dsh_program__()` → 擦除 → 切壳"手法）
  //   + `node:vm` 同进程求值 + 宿主 binding 直连。
  //   契约面如实收窄：`sandboxMode` 返回 `undefined`（不做文件封闭）⇒ 消费者因此
  //   **不传** `sandboxPolicy`、也不要求结果带 `sandbox`（`dsh-tools/lib/types/ptc.js:74`）。
  //
  // 【接线在哪】`hostcore/profile/ondevice/cordis.patch.yml` ⑦：停用官方 `ptc-runtime` 行
  //   + `insert` 本插件（**不能直接改名**：`applyEntryPatches` 的 `name` 字段只作校验）。
  //   `workflow-ptc` / `tool-workflow` 仍禁用（另案，别顺手放开）。
  // 【恢复条件】官方若给出"无 wasm 的擦除 + 不 spawn"的实现，删掉本项与 profile ⑦ 那两行即可。
  { name: '@deepseek-ai/dshm-ptc-runtime-inproc', dir: 'dshm-ptc-runtime-inproc' },
];
/**
 * 承载自带插件依赖声明的上游包。
 *
 * 选它的依据（两条都成立才算数）：
 * ① 它必须在安装锚点 `@deepseek-ai/dsh` 的依赖闭包内（否则声明了也进不了解析表）；
 * ② 它必须是端侧 profile 实际启用的 bundle（`hostcore/profile/ondevice/package.json`
 *    的 `dsh.profile.bundles` 里就有它），这样"端侧真会用到的包"与"声明处"一致。
 */
const DSHM_PLUGIN_DECLARER = '@deepseek-ai/dsh-web-app';
/** 自带插件在核心树里的 scope 目录（相对 `STAGE`）。 */
const DSHM_PLUGIN_SCOPE_DIR = join('node_modules', '@deepseek-ai');
/** 树内自带插件的**目录名前缀**（对称清理与 ① 断言的匹配依据）。 */
const DSHM_PLUGIN_DIR_PREFIX = 'dshm-';
/** 自带插件的**包名前缀**（"先清后写"依赖声明与 ② 断言的匹配依据）。 */
const DSHM_PLUGIN_NAME_PREFIX = '@deepseek-ai/dshm-';

/** 列出核心树 `node_modules/@deepseek-ai/` 下所有 `dshm-*` 条目名（排序，含目录与文件）。 */
function listStagedDshmEntries() {
  const nm = join(STAGE, DSHM_PLUGIN_SCOPE_DIR);
  if (!existsSync(nm)) return [];
  return readdirSync(nm).filter((e) => e.startsWith(DSHM_PLUGIN_DIR_PREFIX)).sort();
}

/** 集合差集的可读描述：多出来的与缺失的分别列出（空集写"无"）。 */
function describeSetDiff(extra, missing) {
  return `多出 [${extra.length ? extra.join('、') : '无'}] / 缺失 [${missing.length ? missing.join('、') : '无'}]`;
}

/**
 * 回归锁：断言 ① 树内 `dshm-*` 集合 与 ② 声明者依赖里的 `@deepseek-ai/dshm-*` 键集合
 * **都恰好等于** `DSHM_PLUGIN_PACKAGES`（③ 产物集合由"打包读的就是这棵树"保证）。
 *
 * 两个集合都**从磁盘现读**（不复用内存中间变量），断言的对象因此是"将要进产物的字节"
 * 所对应的状态，而不是写入前的意图。任一不等即 `die`，并逐项打印清单/实际/差集与位置。
 */
function assertDshmBelongingsConsistent() {
  const wantDirs = DSHM_PLUGIN_PACKAGES.map((p) => p.dir).sort();
  const gotDirs = listStagedDshmEntries();
  const extraDirs = gotDirs.filter((d) => !wantDirs.includes(d));
  const missingDirs = wantDirs.filter((d) => !gotDirs.includes(d));
  if (extraDirs.length || missingDirs.length) {
    die(`自带插件目录集合与清单不一致：${describeSetDiff(extraDirs, missingDirs)}\n`
      + `  清单（${wantDirs.length}）：${wantDirs.join('、') || '（空）'}\n`
      + `  树内（${gotDirs.length}）：${gotDirs.join('、') || '（空）'}\n`
      + `  位置：${join(STAGE, DSHM_PLUGIN_SCOPE_DIR)}`);
  }

  const declarerPath = join(STAGE, 'node_modules', DSHM_PLUGIN_DECLARER, 'package.json');
  if (!existsSync(declarerPath)) die(`自带插件的声明处不存在：${declarerPath}`);
  const declDeps = JSON.parse(readFileSync(declarerPath, 'utf8')).dependencies ?? {};
  const gotNames = Object.keys(declDeps).filter((k) => k.startsWith(DSHM_PLUGIN_NAME_PREFIX)).sort();
  const wantNames = DSHM_PLUGIN_PACKAGES.map((p) => p.name).sort();
  const extraNames = gotNames.filter((n) => !wantNames.includes(n));
  const missingNames = wantNames.filter((n) => !gotNames.includes(n));
  if (extraNames.length || missingNames.length) {
    die(`自带插件依赖声明与清单不一致：${describeSetDiff(extraNames, missingNames)}\n`
      + `  清单（${wantNames.length}）：${wantNames.join('、') || '（空）'}\n`
      + `  声明（${gotNames.length}）：${gotNames.join('、') || '（空）'}\n`
      + `  位置：${declarerPath}`);
  }

  // 版本比对的"期望值"从**源码 manifest** 现读，不从 `added` 等内存变量借用
  // （`DSHM_PLUGIN_PACKAGES` 的条目只有 name/dir，没有 version）。
  const versionMismatch = DSHM_PLUGIN_PACKAGES
    .map((p) => {
      const srcManifest = join(ROOT, 'hostcore', 'plugins', p.dir, 'package.json');
      if (!existsSync(srcManifest)) return `${p.name}: 源码 manifest 不存在 ${srcManifest}`;
      const want = JSON.parse(readFileSync(srcManifest, 'utf8')).version;
      return declDeps[p.name] === want ? null : `${p.name}: 源码 ${want} ≠ 声明 ${declDeps[p.name]}`;
    })
    .filter(Boolean);
  if (versionMismatch.length) {
    die(`自带插件依赖版本与清单不一致：${versionMismatch.join('；')}\n  位置：${declarerPath}`);
  }

  log(`[pack-core]   回归锁 ✓ 树内 ${wantDirs.length} 个 dshm-* 目录与 `
    + `${DSHM_PLUGIN_DECLARER} 的 ${wantNames.length} 条 dshm-* 声明均等于清单`);
}

/** 把自带插件放进核心树，并让 loader 能按名字解析到它（见上方长注释）。 */
function embedDshmToolPackages() {
  log('\n[pack-core] ④b DSHM 自带插件包');
  const nm = join(STAGE, DSHM_PLUGIN_SCOPE_DIR);

  // ① 先验源码、算版本（此步不碰核心树）：任一项缺入口/manifest 或包名对不上即停。
  const added = [];
  for (const pkg of DSHM_PLUGIN_PACKAGES) {
    const src = join(ROOT, 'hostcore', 'plugins', pkg.dir);
    const entry = join(src, 'lib', 'index.js');
    if (!existsSync(entry)) die(`自带插件缺少入口：${entry}`);
    const manifestPath = join(src, 'package.json');
    if (!existsSync(manifestPath)) die(`自带插件缺少 manifest：${manifestPath}`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.name !== pkg.name) {
      die(`自带插件包名不一致：${manifestPath} 写的是 ${manifest.name}，打包清单写的是 ${pkg.name}`);
    }
    added.push({ dir: pkg.dir, name: pkg.name, version: manifest.version });
  }

  // ② 对称清理：删掉 scope 目录下**清单外**的 `dshm-*` 残留。
  // 只按 `dshm-` 前缀匹配，绝不触碰 scope 下的其它包（`dsh-*`、`@ohos-ports` 等）。
  const keep = new Set(added.map((p) => p.dir));
  const stale = listStagedDshmEntries().filter((e) => !keep.has(e));
  for (const name of stale) {
    rmSync(join(nm, name), { recursive: true, force: true });
    log(`[pack-core]   清理清单外的自带插件残留：node_modules/@deepseek-ai/${name}`);
  }
  log(stale.length
    ? `[pack-core]   已清理 ${stale.length} 项清单外残留`
    : '[pack-core]   无清单外的 dshm-* 残留（无需清理）');

  // ③ 落树：清单内每一项覆盖进核心树。
  for (const pkg of added) {
    const src = join(ROOT, 'hostcore', 'plugins', pkg.dir);
    const dest = join(nm, pkg.dir);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true, force: true });
    log(`[pack-core]   ${pkg.name} → node_modules/@deepseek-ai/${pkg.dir}/（入口 lib/index.js）`);
  }

  // ④ 依赖声明"先清后写"：先移除声明者里**全部** `@deepseek-ai/dshm-*` 键，再按清单
  // 依次写入当前项。清单里已移除的项由此从 manifest 中消失；声明者的其它依赖既不改值、
  // 也不改相对顺序（键写回的顺序仍按清单顺序追加在末尾）。
  // 【路径从 node_modules 起算】DSHM_PLUGIN_DECLARER 是**带 scope 的完整包名**
  // （`@deepseek-ai/dsh-web-app`），不能再拼一次 `@deepseek-ai`——否则路径成为
  // `node_modules/@deepseek-ai/@deepseek-ai/dsh-web-app`，被上面的存在性检查拦下。
  const declarerPath = join(STAGE, 'node_modules', DSHM_PLUGIN_DECLARER, 'package.json');
  if (!existsSync(declarerPath)) die(`自带插件的声明处不存在：${declarerPath}`);
  const declarerText = readFileSync(declarerPath, 'utf8');
  const declarer = JSON.parse(declarerText);
  declarer.dependencies = declarer.dependencies ?? {};
  for (const key of Object.keys(declarer.dependencies)) {
    if (key.startsWith(DSHM_PLUGIN_NAME_PREFIX)) delete declarer.dependencies[key];
  }
  for (const pkg of added) declarer.dependencies[pkg.name] = pkg.version;
  // 幂等：序列化结果与磁盘原文逐字节比较，相同则**不写**（沿用"内容不变则不写"的风格）。
  const declarerNext = JSON.stringify(declarer, null, 2) + '\n';
  if (declarerNext !== declarerText) {
    writeFileSync(declarerPath, declarerNext, 'utf8');
    log(`[pack-core]   已在 ${DSHM_PLUGIN_DECLARER} 的 dependencies 里重写自带插件声明（先清后写）：`
      + `${added.map((p) => p.name).join('、')}`);
    log('[pack-core]   （只影响打进树里的这份 manifest，不改上游仓库；依据见本函数上方注释）');
  } else {
    log(`[pack-core]   ${DSHM_PLUGIN_DECLARER} 的 dependencies 与清单逐字节一致（幂等跳过写入）`);
  }

  // ⑤ 回归锁：写入完成后的磁盘现状必须与清单完全一致，否则不进入打包。
  assertDshmBelongingsConsistent();
}

/**
 * 在**打包之前**把构建元数据写进树里（`<top>/dshm-core.json`）。
 *
 * 为什么不能只留在外层清单里：外层清单在容器**外面**，端侧解包完只有树本身。
 * 端侧要能回答"我装的这版是什么、哪个 profile、平台对不对"，就必须把答案放进树里。
 * 因此这里只写不依赖产物哈希的字段——容器的 sha256 仍然只在外层清单（否则自指）。
 */
/**
 * 生成**端侧 agent preset**：`presets/ondevice/`（复制 `standard`）。
 *
 * 【2026-09-21 更新】复制后**不再改任何工具行**：standard 的 `!!js` 条件在端侧
 * （dshhost 自建 Node 上 `process.platform === 'linux'`）自然给出正确结果——
 * `tool-bash` 启用（`disabled: process.platform === 'win32'` ⇒ false）、
 * `tool-pwsh` 禁用（`disabled: process.platform !== 'win32'` ⇒ true）。
 *
 * 【历史】早期版本按 E15（"鸿蒙不支持进程创建"）把 bash/pwsh/fs-search 三行
 * 全部强制 `disabled: true`。E15 已被后续真机实测推翻——dshhost 的 spawn 能力
 * 打通后 busybox/node 子进程全链路可用（probe-bash-5、D26 的 127 输出都是
 * spawn 真实工作的证据）；fs-search 的 spawn 目标 ripgrep 也已随树注入
 * （见 ensureRipgrepPlatformPackage）。三行因此回归 standard 的原始条件。
 */
function addOnDevicePreset() {
  /*
   * 【2026-09-26 修正】这里原本找 `dsh-agent-presets/presets/standard/`，但该布局
   * **在当前核心树里不存在**（preset 已改为 `dsh-web-app/presets/*.patch.yml` 平铺，
   * 每个文件 insert 一个 `@deepseek-ai/dsh-agent-preset` 声明）。于是本函数一直走
   * "未找到 standard preset，跳过"分支——端侧从来没有 `ondevice` preset，而 profile
   * 里那行 `- id: agent-presets / default: ondevice` 又指向不存在的 id 被静默跳过，
   * 实际生效的一直是官方的 `standard`。既然 `standard` 在端侧语义已正确（见 profile
   * 注释），端侧无需另造 preset，这里如实报告"用官方 standard、不复制"即可。
   * 保留本函数是为了让"曾经有过 ondevice preset"这段历史与检查点可见。
   */
  const presets = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets');
  if (!existsSync(presets)) {
    log('[pack-core]   ⚠ 未找到 dsh-web-app/presets，跳过端侧 preset 检查');
    return;
  }
  const shipped = readdirSync(presets).filter((n) => n.endsWith('.patch.yml')).sort();
  log(`[pack-core]   端侧 agent preset 用官方 shipping 集（不复制）：${shipped.join('、')}`);
  // 兼容旧布局：若将来又出现 dsh-agent-presets/presets/standard，仍做复制。
  const legacy = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard');
  if (!existsSync(legacy)) {
    return;
  }
  const to = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'ondevice');
  rmSync(to, { recursive: true, force: true });
  cpSync(legacy, to, { recursive: true });
  log('[pack-core]   （旧布局兼容）已生成 presets/ondevice');
}

/**
 * 注入 `@vscode/ripgrep-linux-arm64` 平台包（端侧 fs-search 的 spawn 目标）。
 *
 * 【为什么需要】`dsh-tool-fs-search` 通过 `@vscode/ripgrep` 的 `rgPath` 解析二进制：
 * `require.resolve("@vscode/ripgrep-linux-arm64/bin/rg")`。npm 在 Windows 宿主上
 * 装树时 optionalDependencies 只装当前平台（win32-x64），设备上因此
 * `Could not find @vscode/ripgrep-linux-arm64` ⇒ 首次搜索即 SEARCH_FAILED。
 * 与 addSystemAddonPackage 是同一类"平台包补齐"，只是这次放的是**真二进制**
 * （rg 是静态链接的独立 ELF，无 DT_NEEDED、不需要重定向进 HAP libs）。
 *
 * 【来源】`npm pack @vscode/ripgrep-linux-arm64@1.18.0`（与树里 @vscode/ripgrep
 * 1.18.0 的 optionalDependencies 版本严格一致）。tgz 缓存在 third_party/ripgrep/，
 * 缺失时自动 npm pack（本脚本唯一联网渠道就是 npm，与 ① 物化一致）。
 */
function ensureRipgrepPlatformPackage() {
  const cacheDir = join(ROOT, 'third_party', 'ripgrep');
  mkdirSync(cacheDir, { recursive: true });
  const tgz = join(cacheDir, 'vscode-ripgrep-linux-arm64-1.18.0.tgz');
  if (!existsSync(tgz)) {
    const npm = which('npm');
    if (!npm) die('ripgrep 平台包缺失且找不到 npm（手动执行：npm pack @vscode/ripgrep-linux-arm64@1.18.0）');
    log('[pack-core]   npm pack @vscode/ripgrep-linux-arm64@1.18.0 …');
    const r = spawnSync(`"${npm.replace(/"/g, '\\"')}"`,
      ['pack', '@vscode/ripgrep-linux-arm64@1.18.0', '--pack-destination', cacheDir],
      { stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0 || !existsSync(tgz)) die('npm pack ripgrep 平台包失败');
  }
  const tmp = join(WORK_ROOT, '.rg-tmp');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const tar = which('tar');
  if (!tar) die('ripgrep 平台包注入：找不到 tar');
  const r2 = spawnSync(tar, ['-xzf', tgz, '-C', tmp], { stdio: 'inherit' });
  if (r2.status !== 0) die('ripgrep tgz 解包失败');
  const srcPkg = join(tmp, 'package');
  const rgBin = join(srcPkg, 'bin', 'rg');
  if (!existsSync(rgBin)) die('ripgrep 平台包里缺 bin/rg（tgz 结构变化）');
  // ELF aarch64 校验（e_machine=0xB7，little-endian 在 [18..19]）；rg 官方构建为
  // 静态链接（无 PT_INTERP / DT_NEEDED），这里至少把架构钉死，防止缓存串包。
  const head = readFileSync(rgBin).subarray(0, 20);
  if (head[0] !== 0x7f || head[1] !== 0x45 || head[18] !== 0xb7 || head[19] !== 0x00) {
    die('bin/rg 不是 ELF aarch64（缓存可能被污染）');
  }
  const dst = join(STAGE, 'node_modules', '@vscode', 'ripgrep-linux-arm64');
  const rgSizeMb = (statSync(rgBin).size / 1048576).toFixed(1);
  rmSync(dst, { recursive: true, force: true });
  cpSync(srcPkg, dst, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
  log('[pack-core]   ripgrep 平台包已注入：@vscode/ripgrep-linux-arm64/bin/rg'
    + `（${rgSizeMb} MB 静态 ELF，fs-search 的 spawn 目标）`);
}

/**
 * fs-search 搜索降级：rg → 系统 find/grep（鸿蒙 execve 白名单内的 toybox applet）。
 *
 * 【为什么】真机实证（exec 探测 rg=denied）：debug 签名域下 execve 对第三方 ELF 全禁。
 * rg 平台包虽然注入了（ensureRipgrepPlatformPackage），spawn 直接被拒 → glob/grep
 * 工具恒 SEARCH_FAILED。这是 agent 四命令验收链（read/edit/bash 之后）最后一个实质缺口。
 * 系统 /system/bin/{find,grep} 是 execve 白名单成员（busybox 探测同源实证）。
 *
 * 【怎么做】对 dsh-tool-fs-search/lib/index.js 做三段文本 patch（锚点取自
 * 0.1.6-alpha.2 原文，与 DSHM apply-dsh-ohos-adapt.sh 的 fs-search patch 同源）：
 *   1. resolveRgPath 尾锚点后注入降级 helpers（探测/参数转换/输出转换）；
 *   2. runRipgrep spawn 段：rg 解析失败 **或 exec 探测失败** 时改用 find/grep argv
 *      ——后者是本项目特有：rg 包在而 execve 被拒，DSHM 只覆盖"包缺失"场景；
 *   3. 输出段：grep 降级时把 `path:line:content` 文本转成 rg --json 风格 NDJSON。
 *
 * 【纪律】每段锚点未命中立即 die——静默失败 = 装了没打补丁的旧树而不自知
 * （同 D6 E47 "内置核心已全部安装过" 教训）。幂等：helpers 已在则跳过。
 *
 * 【依赖边界】注入的 helpers 只能用目标文件已 import 的标识符：existsSync（node:fs）、
 * parse（node:path）。DSHM 底本里的 statSync/basename 在此文件未 import，已分别
 * 改写为 existsSync / parse(x).base —— 否则加载即 ReferenceError。
 */
function patchFsSearchFallback() {
  const file = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-tool-fs-search', 'lib', 'index.js');
  if (!existsSync(file)) die('fs-search 降级 patch：找不到 dsh-tool-fs-search/lib/index.js（树形态变了）');
  let t = readFileSync(file, 'utf8');

  // 【为什么不再"见到函数名就跳过"（2026-10-05 修）】
  // 旧守卫是 `if (t.includes('function buildFallbackArgv')) 跳过` ⇒ **注入块的实现一旦要升级就
  // 永远升不上去**：本次修 `glob` 目录锚定（真机 P1）时，pack-core 打印"已在，跳过"，树里留的
  // 还是旧实现，而门禁读到旧行为报 16 条红 —— 差点被误判成"门禁写错了"。
  // 现在改成**可重入重打**：把**未打补丁的原文**存一份在树外（`dist/core/work/.pack-core-pristine/`），
  // 每次打包都从 pristine 重新注入。
  // 安全性：只有当树里那份**确实等于我们上次打出来的结果**（哈希相符）时才用 pristine 覆盖它；
  // 若哈希不符（上游升级、或有人手改过），就把当前内容当作新的原文另存 —— 绝不用旧 pristine
  // 把上游更新**降级**掉（那是比"补丁没升级"更坏的静默事故）。
  const pristineDir = join(dirname(STAGE), '.pack-core-pristine');
  const pristineFile = join(pristineDir, 'dsh-tool-fs-search-index.js');
  const pristineMeta = join(pristineDir, 'dsh-tool-fs-search-index.meta.json');
  const sha256 = (text) => createHash('sha256').update(text).digest('hex');
  let base = t;
  let reusedPristine = false;
  if (existsSync(pristineFile) && existsSync(pristineMeta)) {
    let recorded = '';
    try { recorded = JSON.parse(readFileSync(pristineMeta, 'utf8')).patchedSha256 ?? ''; } catch { recorded = ''; }
    if (recorded !== '' && sha256(t) === recorded) {
      base = readFileSync(pristineFile, 'utf8');
      reusedPristine = true;
      log('[pack-core]   fs-search 降级 patch：树里那份=上次打出的结果 ⇒ 回到 pristine 原文重打（可重入）');
    } else {
      log('[pack-core]   fs-search 降级 patch：树里那份与记录不符（上游更新/手改？）⇒ 以当前内容为新的原文');
    }
  }
  if (!reusedPristine) {
    mkdirSync(pristineDir, { recursive: true });
    writeFileSync(pristineFile, base);
  }
  t = base;
  if (t.includes('function buildFallbackArgv')) {
    die('fs-search 降级 patch：pristine 原文里竟然已有注入块 —— pristine 记录不自洽，人工核对');
  }

  const helpers = `// ── 鸿蒙适配（pack-core 注入）：rg 不可 exec 时的 find/grep 降级 ──
// debug 签名域 execve 拒绝第三方 ELF（真机实证 rg=denied），系统 find/grep
// （toybox applet）在白名单内可 exec。探测结果进程内记忆：一次失败 spawn 的代价。
let rgExecOk = null;
async function rgExecutable(ctx, rgPath, signal) {
	if (rgExecOk !== null) return rgExecOk;
	try {
		const probe = ctx.subprocess.spawn({
			argv: [rgPath, "--version"],
			cwd: process.cwd(),
			stdio: { stdin: "ignore", stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
			graceMs: 1000,
			signal
		});
		const outcome = await probe.done;
		rgExecOk = outcome.exitCode === 0;
	} catch (error) {
		// abort 竞态不记忆：按"可用"放行，让主路径的 abort 检查报 SEARCH_ABORTED
		if (signal && signal.aborted) return true;
		rgExecOk = false;
	}
	return rgExecOk;
}
/** 探测系统可 exec 的 find/grep（hnp GNU 工具链或 /system/bin）。空串 = 不可降级。 */
function probeSystemTool(binNames) {
	for (const name of binNames) {
		for (const c of ["/data/service/hnp/bin/" + name, "/system/bin/" + name, "/system/bin/toybox"]) {
			if (existsSync(c)) return c;
		}
	}
	return "";
}
/** 递归展开 shell 花括号（\`*.{sh,txt}\` → ["*.sh","*.txt"]）：rg 支持而 find -name 不展开。 */
function expandBraces(pattern) {
	const match = pattern.match(/^(.*?)\\{([^{}]*)\\}(.*)$/);
	if (match === null) return [pattern];
	const prefix = match[1], alternatives = match[2], suffix = match[3];
	const out = [];
	for (const alt of alternatives.split(",")) {
		for (const expanded of expandBraces(prefix + alt.trim() + suffix)) out.push(expanded);
	}
	return out;
}
/** 段里是否含 glob 元字符（不用正则，避免模板串转义地狱）。 */
function hasGlobMeta(segment) {
	return segment.includes("*") || segment.includes("?") || segment.includes("[") || segment.includes("{");
}
/**
 * glob 模式的"最长字面目录前缀 + 剩余段"拆分（降级路径专用；**纯函数**便于门禁直接提纯测）。
 *
 * 【为什么需要它（2026-10-05 真机缺陷）】原实现一律**取 glob 的末段**做 -name、丢掉目录前缀：
 *   _tool_probe/*      →  find <root> -type f -name '*'
 *   _tool_probe/*.txt  →  find <root> -type f -name '*.txt'
 * 于是退化成"任意深度的 basename 匹配"：真机在 13111 个文件的树里 _tool_probe/* 命中 13111
 * （应为 1）、_tool_probe/*.txt 命中全局 8 条。末段带字面前缀（dir/hello.ext）时恰好看着正常，
 * 所以这条缺陷能长期潜伏。
 */
function splitGlobAnchor(globPattern) {
	const normalized = globPattern.replace(/^\\.\\//, "");
	const segs = normalized.split("/").filter((s) => s !== "" && s !== ".");
	if (segs.length === 0) return { dir: "", rest: ["*"] };
	let literal = 0;
	// 最后一段永不并入前缀（它是 -name 的匹配对象）
	while (literal < segs.length - 1 && !hasGlobMeta(segs[literal])) literal++;
	return { dir: segs.slice(0, literal).join("/"), rest: segs.slice(literal) };
}
/** 降级 argv：把 rg 参数转成系统 find/grep 参数；返回空数组表示无法降级。 */
function buildFallbackArgv(toolName, argv) {
	let root = ".";
	let pattern = "";
	let globPattern = "";
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") {
			root = argv[i + 1] ?? ".";
			break;
		}
		if (a.startsWith("--regexp=")) pattern = a.slice("--regexp=".length);
		else if (a.startsWith("--glob=")) {
			// fs-search 的 negation 实际形态是 \`--glob=!**/name\`（值带 ! 前缀；
			// DSHM 底本的 "--glob!" 分支永不命中）。系统 find/grep 无对应语义，忽略。
			const g = a.slice("--glob=".length);
			if (globPattern === "" && !g.startsWith("!")) globPattern = g;
		}
	}
	if (toolName === "glob") {
		const findPath = probeSystemTool(["find"]);
		if (findPath === "") return [];
		const args = [findPath];
		// toybox 用 argv[1] 分发 applet（argv[0]=toybox 时需显式 applet 名）
		if (parse(findPath).base === "toybox") args.push("find");
		if (globPattern === "") return args.concat([root, "-type", "f"]);
		// 见 splitGlobAnchor 的注释：**目录前缀必须并入 find 的起点**，不能再被 pop 掉。
		const specs = expandBraces(globPattern).map((one) => splitGlobAnchor(one));
		// 可精确表达的条件：① 所有展开共享同一个起点目录；② 除末段外没有别的通配段
		//   （** 段例外 —— 它等价于"不限深度"，去掉 -maxdepth 即可）。
		const sameStart = specs.every((one) => one.dir === specs[0].dir);
		const middleOk = specs.every((one) => !one.rest.slice(0, -1).some((x) => x !== "**" && hasGlobMeta(x)));
		if (sameStart && middleOk) {
			const dir = specs[0].dir;
			const rest = specs[0].rest;
			const names = [];
			for (const one of specs) {
				for (const n of expandBraces(one.rest[one.rest.length - 1])) names.push(n);
			}
			const startDir = dir === "" ? root : root.replace(/\\/+$/, "") + "/" + dir;
			args.push(startDir, "-type", "f");
			// 有 ** 段、或"末段不含 /"（dir 为空 ⇒ 与 rg --glob 的任意深度语义一致）⇒ 不加 -maxdepth。
			// 端侧 toybox find 实测支持 -maxdepth（-maxdepth 1 只列一层）。
			const anyDepth = dir === "" || specs.some((one) => one.rest.some((x) => x.includes("**")));
			if (!anyDepth) args.push("-maxdepth", String(rest.length));
			if (names.length > 1) {
				args.push("(");
				names.forEach((n, idx) => {
					if (idx > 0) args.push("-o");
					args.push("-name", n);
				});
				args.push(")");
			} else {
				args.push("-name", names[0]);
			}
			return args;
		}
		// 近似形：中间段带通配（a/*/b.txt）或多个花括号展开（各自起点不同）⇒ 用 -path 锚定。
		// 注意 POSIX fnmatch 的 * **跨 /**（端侧实测：-path '*/dir/*' 同时命中深层文件），
		// 所以 -path 只能"锚定目录"，做不到 rg 那样精确限深；但仍远严于"退化成全树 basename"。
		args.push(root, "-type", "f", "(");
		specs.forEach(({ dir, rest }, idx) => {
			if (idx > 0) args.push("-o");
			const rel = (dir === "" ? [] : [dir]).concat(rest).join("/").split("**").join("*");
			args.push("-path", "*/" + rel);
		});
		args.push(")");
		return args;
	}
	const grepPath = probeSystemTool(["grep"]);
	if (grepPath === "") return [];
	const args = [grepPath];
	if (parse(grepPath).base === "toybox") args.push("grep");
	// rg 查询语法是 PCRE2；系统 grep 用 ERE 保留 |、()、+、? 的语义。
	// 必须 -H：单文件参数时 grep 默认不打印文件名前缀，下游按 path:line:content
	// 解析会整行丢弃 → 单文件恒 "No matches found"（DSHM 2026-09-16 实测教训）。
	let searchRoot = root;
	let include = "";
	if (globPattern !== "") {
		// 目录锚定（2026-10-05：与 glob 同一类缺陷）——原实现一律只取末段做 --include
		// ⇒ dir/*.ts 会搜**全树**。系统 grep 没有 rg 的路径 glob，但它的**搜索根**就是
		// 目录约束：前缀是字面目录时直接把根换过去（dir/**/*.ts 先去掉 **/ 再判）。
		const anchor = splitGlobAnchor(globPattern.split("**/").join(""));
		if (anchor.dir !== "") searchRoot = root.replace(/\\/+$/, "") + "/" + anchor.dir;
		include = anchor.rest.length > 0 ? anchor.rest[anchor.rest.length - 1] : "*";
	}
	args.push("-Hrn", "-E", "-e", pattern, searchRoot);
	if (include !== "") args.push("--include=" + include);
	return args;
}
/** 把系统 grep 文本输出（path:line:content）转成 rg --json 风格 NDJSON。 */
function grepTextToNdjson(stdout) {
	const text = Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout);
	const lines = [];
	for (const rawLine of text.split("\\n")) {
		if (rawLine.length === 0) continue;
		const first = rawLine.indexOf(":");
		if (first <= 0) continue;
		const second = rawLine.indexOf(":", first + 1);
		if (second <= first + 1) continue;
		const path = rawLine.slice(0, first);
		const lineNum = Number(rawLine.slice(first + 1, second));
		const content = rawLine.slice(second + 1);
		if (!Number.isInteger(lineNum) || lineNum < 1) continue;
		lines.push(JSON.stringify({
			type: "match",
			data: {
				path: { text: path },
				line_number: lineNum,
				lines: { text: content }
			}
		}));
	}
	return lines.join("\\n") + (lines.length > 0 ? "\\n" : "");
}`;

  // 1) helpers 注入：resolveRgPath 尾锚点（文件内唯一，rg -c 验证）
  const tailAnchor = '\treturn rgPathPromise;\n}';
  if (!t.includes(tailAnchor)) die('fs-search 降级 patch：tail anchor 未命中（resolveRgPath 形态变了）');
  t = t.replace(tailAnchor, tailAnchor + '\n' + helpers);

  // 2) spawn 段：rg 解析失败或 exec 探测失败 → find/grep argv
  const oldSpawn = `\tconst workdir = exec.agent?.session.header.cwd ?? process.cwd();
\tlet handle;
\ttry {
\t\thandle = ctx.subprocess.spawn({
\t\t\targv: [
\t\t\t\tawait resolveRgPath(),
\t\t\t\t"--no-config",
\t\t\t\t...argv
\t\t\t],`;
  const newSpawn = `\tconst workdir = exec.agent?.session.header.cwd ?? process.cwd();
\t// 鸿蒙适配：rg 解析失败（平台包缺失）或 exec 探测失败（execve 被拒）→ 系统 find/grep
\tlet rgPath;
\ttry {
\t\trgPath = await resolveRgPath();
\t} catch (error) {
\t\trgPath = "";
\t}
\tif (rgPath !== "" && !(await rgExecutable(ctx, rgPath, exec.signal))) rgPath = "";
\tlet spawnArgv;
\tlet fallbackGrep = false;
\tif (rgPath !== "") {
\t\tspawnArgv = [rgPath, "--no-config", ...argv];
\t} else {
\t\tconst fb = buildFallbackArgv(toolName, argv);
\t\tif (fb.length === 0) throw new SearchError(\`\${toolName} could not start its search command (ripgrep launch failed)\`, "SEARCH_FAILED");
\t\tspawnArgv = fb;
\t\tfallbackGrep = toolName === "grep";
\t}
\tlet handle;
\ttry {
\t\thandle = ctx.subprocess.spawn({
\t\t\targv: spawnArgv,`;
  if (!t.includes(oldSpawn)) die('fs-search 降级 patch：spawn 段锚点未命中（runRipgrep 形态变了）');
  t = t.replace(oldSpawn, newSpawn);

  // 3) 输出段：grep 降级文本 → NDJSON（保持 {text, lossy} 收集器形状，只换 text）
  const oldOut = `\tconst stdout = handle.collected.stdout?.readFrom(0);
\tconst stderr = handle.collected.stderr?.readFrom(0);
\tif (stdout === void 0 || stderr === void 0) throw new SearchError(\`\${toolName} search command produced no collected output streams\`, "SEARCH_FAILED");`;
  const newOut = `\tconst stdoutRaw = handle.collected.stdout?.readFrom(0);
\tconst stderr = handle.collected.stderr?.readFrom(0);
\tif (stdoutRaw === void 0 || stderr === void 0) throw new SearchError(\`\${toolName} search command produced no collected output streams\`, "SEARCH_FAILED");
\t// 鸿蒙适配：readFrom(0) 返回 {text, lossy} 收集器对象。必须保持形状、只替换 text，
\t// completeStdout 才能读到 .lossy/.text；否则 "[object Object]" → 空 NDJSON → 崩。
\tconst stdout = fallbackGrep
\t\t? { ...stdoutRaw, text: grepTextToNdjson(stdoutRaw.text ?? "") }
\t\t: stdoutRaw;`;
  if (!t.includes(oldOut)) die('fs-search 降级 patch：输出段锚点未命中（collected 形态变了）');
  t = t.replace(oldOut, newOut);

  // 【为什么在这里自检（2026-10-05 一天内连踩两次）】上面三段注入都是**模板串**，而模板串有三条暗礁：
  //   ① 反斜杠要写两个（正则里的 `\/` 会被吃成一个裸 `/`，注入后是语法错的 `//+$/`）；
  //   ② 反引号与 `${` 要转义（否则被当模板定界/插值）；
  //   ③ **块注释里出现 `*/` 会提前终止注释**（今天就是写了 `"**/"` 这个字面量把 JSDoc 截断的）。
  // 写错任意一个字符，注入进树里的就是**语法坏的 JS**；而 pack-core 只做文本替换、不解析 ⇒
  // 要等几分钟打包完、由门禁才发现（今天两次都是这样）。
  // 判据必须是**整文件**解析：spawn/输出两段是**片段**（含被锚点拆开的 `try{…}` 与 `await`），
  // 拆开单独解析必然假阳性（实测两种）。故写临时 .mjs 文件、用 `node --check` 做完整 ESM 解析。
  const syntaxProbe = join(tmpdir(), `dshm-fs-search-probe-${process.pid}.mjs`);
  writeFileSync(syntaxProbe, t);
  const probeRun = spawnSync(process.execPath, ['--check', syntaxProbe], { encoding: 'utf8' });
  try { unlinkSync(syntaxProbe); } catch { /* 临时文件删不掉不影响结论 */ }
  if (probeRun.status !== 0) {
    const detail = String(probeRun.stderr || '').split('\n').filter((line) => line.trim() !== '').slice(0, 6).join(' | ');
    die(`fs-search 降级 patch：注入后**全文语法不自洽** —— ${detail}\n`
      + '  多半是模板串转义写错：反斜杠要写两个（\\ → \\\\）、反引号与 ${ 要转义、块注释里不能出现注释终止符');
  }

  writeFileSync(file, t);
  writeFileSync(pristineMeta, JSON.stringify({
    note: 'pristine = 未打补丁的 dsh-tool-fs-search/lib/index.js；patchedSha256 = 上次注入后的哈希（用于下次判断能否安全从 pristine 重打）',
    pristineSha256: sha256(base),
    patchedSha256: sha256(t),
    at: new Date().toISOString(),
  }, null, 2));
  log('[pack-core]   fs-search 降级 patch：rg exec 探测 + find/grep fallback + NDJSON 转换已注入');
}

/**
 * 平台别名：让原生包的**加载器**能按它算出来的目录名找到原生件。
 *
 * 【为什么需要】实测真机（D6 E39）：我们自建的 Node 在设备上 `process.platform === 'linux'`
 * （与 E22 同源：gyp 的 `OS` 是 linux，Node 就按 linux 编译），而 `arch === 'arm64'`。
 * 但 `@ohos-ports/*` 移植件把它们的产品放在 **`openharmony_arm64`** 这类目录下
 * （koffi 的加载器按 `process.platform + '_' + process.arch` 拼路径，见
 * node_modules/koffi/index.js:468-499，所以它会去找 `build/koffi/linux_arm64/koffi.node`）。
 * 结果就是：文件明明在包里，加载器却说 "Cannot find the native Koffi module"。
 *
 * 【为什么是复制而不是符号链接】鸿蒙沙箱**禁止符号链接**（实测 `13900012 Permission denied`），
 * 而且 HAP 也不能携带符号链接。所以只能复制——代价是每个原生件多占一份体积。
 */
function addPlatformAliases() {
  const nm = join(STAGE, 'node_modules');
  const aliases = [
    ['koffi/build/koffi/openharmony_arm64', 'koffi/build/koffi/linux_arm64'],
    ['koffi/build/koffi/openharmony_arm64', 'koffi/build/koffi/musl_arm64'],
    ['node-pty/prebuilds/openharmony-arm64', 'node-pty/prebuilds/linux-arm64'],
  ];
  for (const [from, to] of aliases) {
    const src = join(nm, from);
    const dst = join(nm, to);
    if (!existsSync(src)) continue;
    if (existsSync(dst)) continue;
    cpSync(src, dst, { recursive: true });
    log(`[pack-core]   平台别名 ${from} → ${to}`);
  }
}

/**
 * 让 `/api` 的 Origin 栅栏接受**逗号分隔的 Origin 列表**（E81）。
 *
 * ─────────────────────── 为什么必须改这一处 ───────────────────────
 * dsh 的 `isTrustedApiRequest()` 只做一件事：带了 `Origin` 就必须与 `Host` 同源，
 * 否则 403。它按**整串**解析，于是 `new URL(整串).host` 必须恰好等于 `hostUrl.host`。
 *
 * 鸿蒙的 WebSocket 客户端（netstack → libwebsockets）有两条我们控制不了的行为：
 *   1. 它**一定会**自己附一个 `Origin`，并且是按 URL 推导时**丢掉端口**的形态
 *      （`ws://127.0.0.1:3120` → `Origin: http://127.0.0.1`）；
 *   2. 调用方在 `WebSocketRequestOptions.header` 里再给一个 `origin` 时，它**追加**
 *      而不是替换，于是线上值是 `http://127.0.0.1, ws://127.0.0.1:3120`。
 *
 * 真机读数（E81，`IN-UPGRADE` 服务端侧原始日志）：
 *   IN-UPGRADE GET /api/remote.mux conn=Upgrade upgrade=websocket key=yes ver=13
 *              cookie=224B origin=http://127.0.0.1, ws://127.0.0.1:3120
 * 这个值永远不可能等于 `127.0.0.1:3120`，所以**每一次** WS 升级都被判 403；
 * 而 ArkTS 客户端把这个失败报成 `error code=200`（"升级响应不是 101"），
 * 让人长期以为"链路是好的、只是握手后掉了"。
 *
 * ─────────────────────── 改动的语义边界 ───────────────────────
 * 仍然是「不得跨源」：只有当**某一项**与 Host 同源时才放行，跨源项一律不认。
 * 也就是说，这补的不是安全策略的洞，而是**多值形态**带来的误判——
 * 浏览器（单值 Origin）行为完全不变；纯原生客户端从"必被拒"变成"可同源"。
 *
 * 上游若改了这段实现，这里会**报错退出**而不是静默跳过：悄悄发出一个
 * "WS 永远连不上"的包，比打包失败难查得多。
 */
function allowOriginList() {
  const target = join(
    STAGE, 'node_modules', '@deepseek-ai', 'dsh-client-connection', 'lib', 'index.js',
  );
  if (!existsSync(target)) {
    die(`Origin 栅栏补丁：找不到 ${target}`);
  }
  let text = readFileSync(target, 'utf8');
  /*
   * 【幂等判定必须接受**旧标记**】原为 `includes('HDSH_ORIGIN_LIST')`；
   * HDSH→DSHM 改名后，核心树里由**上一版 pack-core** 打过的补丁仍带旧标记
   * ⇒ 只认新标记会判成"未打过"，于是重跑替换，而待替换片段已被换掉
   * ⇒ `die('上游实现已变化')`，整个打包中断。
   *
   * 教训与 E-SV14 同类：**改标记名时必须同时认旧名**，否则老树无法增量重打包。
   * 两处字面量都保留，直到核心树重建过一次（pack-core 会从上游重新解包）。
   */
  if (text.includes('DSHM_ORIGIN_LIST') || text.includes('HDSH_ORIGIN_LIST')) {
    log('[pack-core]   Origin 栅栏补丁已存在（跳过）');
    return;
  }
  const before = `\tconst origin = header$1(request.headers, "origin");
\tif (origin === void 0) return true;
\ttry {
\t\treturn new URL(origin).host === hostUrl.host;
\t} catch {
\t\treturn false;
\t}`;
  const after = `\tconst origin = header$1(request.headers, "origin");
\tif (origin === void 0) return true;
\t/* DSHM_ORIGIN_LIST: 多值 Origin（鸿蒙客户端 libwebsockets 附加的无端口 Origin +
\t * 调用方注入值）只要**任一项**同源即通过。原实现按整串解析，导致每一次端侧 WS 升级
\t * 都被判 403。详见 tools/pack-core.mjs 的 allowOriginList()。 */
\tfor (const rawOrigin of String(origin).split(",")) {
\t\tconst candidate = rawOrigin.trim();
\t\tif (candidate.length === 0) continue;
\t\ttry {
\t\t\tif (new URL(candidate).host === hostUrl.host) return true;
\t\t} catch {
\t\t\t/* 单个非法候选不足以否决整条请求，继续看下一项 */
\t\t}
\t}
\treturn false;`;
  if (!text.includes(before)) {
    die('Origin 栅栏补丁：上游实现已变化（未找到待替换片段），拒绝静默跳过');
  }
  text = text.replace(before, after);
  writeFileSync(target, text, 'utf8');
  log('[pack-core]   Origin 栅栏补丁：已允许逗号分隔的 Origin 列表');
}

/**
 * 把 sharp 换成**调度器 + 真件**（E93），取代原来的"纯 stub"（E79）。
 *
 * ─────────────────────────── 为什么不能只有 stub ───────────────────────────
 * E79 的 stub 让 `dsh-attachment-local` 能挂载（整条 attachments 服务链成立），
 * 代价是**图片附件在使用时报错**。那在当时是唯一诚实的降级——libvips 那 46 个库还没进 HAP。
 * 现在 `tools/collect-libvips.mjs` 已把真件搬进来（并把 sharp 原生件的 RPATH 改成 `$ORIGIN`、
 * 依赖闭包静态校验 PASS），所以"能不能用真件"应当由**运行时**决定，而不是构建期一刀切。
 *
 * ─────────────────── 为什么用调度器而不是直接放真件 ───────────────────
 * 真件是**鸿蒙 arm64** 原生件：设备上能加载，开发机（Windows）上必然失败；而开发机要跑
 * **同一棵核心树**做本地回归（三个 check 工具全靠它）。直接放真件会让本地 boot fail-loud。
 * 调度器把两种情形都照顾到：
 *   · 真件加载成功 → 用它（端侧正常路径，图片附件真的可用）；
 *   · 真件加载失败 → 退回"会报错但能挂载"的 stub，并把**真实原因**挂在
 *     `dshmSharpLoadError` 上——入口脚本的运行时事实（E88）会读它，于是界面显示的是
 *     真实结论，而不是假的"可用"，也不是含糊的"未探测"。
 *
 * 【幂等】以 package.json 的版本号 `0.0.0-dshm-dispatch` 为标记。
 */
function wrapSharp() {
  const nm = join(STAGE, 'node_modules');
  const sharpDir = join(nm, 'sharp');
  const implDir = join(nm, 'sharp.impl');
  if (!existsSync(sharpDir)) {
    log('[pack-core]   sharp 不在树里（跳过调度器）');
    return;
  }
  const pkgFile = join(sharpDir, 'package.json');
  if (existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
      if (pkg.version === '0.0.0-dshm-dispatch') {
        log('[pack-core]   sharp 调度器已存在（跳过）');
        return;
      }
    } catch {
      die('sharp 调度器：现有 sharp/package.json 不可解析，拒绝盲目覆盖');
    }
  }
  // 真件挪成 sibling 包：调度器用 require('sharp.impl') 引它，包内相对路径不受影响
  if (existsSync(implDir)) {
    rmSync(implDir, { recursive: true, force: true });
  }
  renameSync(sharpDir, implDir);
  mkdirSync(sharpDir, { recursive: true });
  writeFileSync(
    pkgFile,
    JSON.stringify({ name: 'sharp', version: '0.0.0-dshm-dispatch', main: 'index.js', private: true }) + '\n',
    'utf8',
  );
  writeFileSync(
    join(sharpDir, 'index.js'),
    [
      '/* DSHM 端侧 sharp 调度器（E93）：真件优先；加载失败时退回"会报错但能挂载"的 stub。',
      ' *',
      ' * 为什么不是纯 stub：真件（libvips 全套，见 tools/collect-libvips.mjs）已随包发出，',
      ' * 端侧的图片附件应当真的可用。',
      ' * 为什么不是直接放真件：它是鸿蒙 arm64 原生件，开发机上必然加载失败，而开发机要跑同一棵树。',
      ' * 失败原因挂在 dshmSharpLoadError 上，由入口脚本的运行时事实如实上报（不假装可用）。',
      ' * 本文件由 tools/pack-core.mjs 的 wrapSharp() 生成，不要手改。 */',
      'let impl;',
      "let loadError = '';",
      'try {',
      "  impl = require('sharp.impl');",
      '} catch (e) {',
      "  loadError = e && e.message ? String(e.message) : String(e);",
      '}',
      'if (impl === undefined || impl === null) {',
      "  const reason = loadError.length > 0 ? loadError : '未知原因';",
      '  impl = function dshmSharpUnavailable() {',
      "    throw new Error('sharp 不可用：真件加载失败（' + reason + '）——图片附件依赖随包提供的 libvips 全套库');",
      '  };',
      '  impl.dshmSharpLoadError = reason;',
      '}',
      'module.exports = impl;',
      'module.exports.default = impl;',
      '',
    ].join('\n'),
    'utf8',
  );
  log('[pack-core]   sharp 调度器：真件在 node_modules/sharp.impl（加载失败时如实降级）');
}

/**
 * 把树里的 koffi JS 层换成 3.2.1（与 HAP 里自编的 libkoffi.so 同版本）。
 *
 * 【真机根因】入口脚本的原生重定向把 `build/koffi/openharmony_arm64/koffi.node`
 * 改写到 HAP 的 `libs/arm64/libkoffi.so`（entry 的 CMakeLists 用 third_party/koffi
 * 自编的 **3.2.1**，DT_NEEDED 带上 libnode）。而 recipe.overrides 装进树的是
 * `@ohos-ports/koffi@2.16.2-beta.0`——它的 index.js 校验
 * `native.version !== pkg.version` ⇒ 真机报
 *   `Mismatched native Koffi modules`
 * （host-ready.json 的 natives 探针，dlopen 本身是**成功**的）。JS 层与原生层
 * 必须同源同版本，所以这里把包的 JS 部分整体换成 third_party 里的 3.2.1
 * （`node tools/fetch-koffi.mjs` 下载的上游 npm 包）。
 *
 * 【为什么还要占位 .node】koffi 的 init() 在 native 为 null 时按
 * `${root}/koffi/build/koffi/${triplet}/koffi.node` 找文件：`fs.existsSync` 这关
 * 有入口脚本的 hook 兜着，但 `require` 的路径解析走 `Module._findPath` 的**内部
 * stat**（E103 同一课），占位文件必须物理存在。真加载一定被原生重定向接管，
 * 所以内容无关紧要（与 addSystemAddonPackage 的占位同一做法）。
 *
 * 【为什么 3.2.1 没有 openharmony case 也没关系】它的 init() 有文件探测回退
 * （roots × triplets × 5 个模式），`node_modules/koffi/build/koffi/openharmony_arm64/
 * koffi.node` 正是第一候选；加载后 `native.version(3.2.1) === pkg.version(3.2.1)`
 * 校验通过。2.x 时代的 struct.size 缺陷（E47）也随之消失。
 */
function replaceKoffiJs() {
  const src = join(ROOT, 'third_party', 'koffi', 'package');
  const dst = join(STAGE, 'node_modules', 'koffi');
  const dstPkgFile = join(dst, 'package.json');
  if (existsSync(dstPkgFile)) {
    try {
      const dstPkg = JSON.parse(readFileSync(dstPkgFile, 'utf8'));
      if (dstPkg.version === '3.2.1' && dstPkg.name === 'koffi'
        && existsSync(join(dst, 'src', 'koffi', 'index.cjs'))) {
        log('[pack-core]   koffi JS 层已是 3.2.1（跳过）');
        return;
      }
    } catch {
      die('koffi JS 层替换：现有 koffi/package.json 不可解析，拒绝盲目覆盖');
    }
  }
  const srcIndex = join(src, 'index.cjs');
  if (!existsSync(srcIndex)) {
    die(`koffi JS 层替换：缺 ${srcIndex}（先跑 node tools/fetch-koffi.mjs）`);
  }
  if (!existsSync(join(src, 'src', 'koffi', 'index.cjs'))) {
    die('koffi JS 层替换：third_party/koffi/package 缺 src/koffi/index.cjs（包不完整，重跑 fetch-koffi）');
  }
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  // exports 的 import/require 两个条件都可能被走（dsh 树里既有 await import("koffi")
  // 也有 createLazyRequire），ESM/CJS 两套入口都带上；types 供开发机侧类型检查。
  // src/ 两层是入口的真实依赖：index.cjs → src/koffi/index.cjs（esbuild bundle）
  // → src/koffi/src/{static,trampolines}.cjs。只拷 JS，不带 C++/doc/vendor。
  for (const f of ['package.json', 'index.js', 'index.cjs', 'index.d.ts', 'indirect.js', 'indirect.cjs']) {
    copyFileSync(join(src, f), join(dst, f));
  }
  mkdirSync(join(dst, 'src', 'koffi', 'src'), { recursive: true });
  for (const f of [
    join('src', 'koffi', 'index.js'), join('src', 'koffi', 'index.cjs'),
    join('src', 'koffi', 'indirect.js'), join('src', 'koffi', 'indirect.cjs'),
    join('src', 'koffi', 'src', 'static.js'), join('src', 'koffi', 'src', 'static.cjs'),
    join('src', 'koffi', 'src', 'trampolines.cjs'),
  ]) {
    copyFileSync(join(src, f), join(dst, f));
  }
  const placeholderDir = join(dst, 'build', 'koffi', 'openharmony_arm64');
  mkdirSync(placeholderDir, { recursive: true });
  writeFileSync(join(placeholderDir, 'koffi.node'),
    'DSHM placeholder: real binary is loaded from HAP libs/arm64/libkoffi.so (3.2.1, self-built)\n', 'utf8');
  log('[pack-core]   koffi JS 层 → 3.2.1（含 src/ 依赖闭包；对齐 HAP 自编 libkoffi.so；含加载占位 .node）');
}

/**
 * 补齐 `@deepseek-ai/node-addon-system-<platform>-<arch>` 平台包（E103）。
 *
 * 【为什么需要】`dsh-session-persistence-jsonl` 通过
 * `@deepseek-ai/node-addon-system/flock` 给会话日志加排他锁，而那个加载器会
 * `require.resolve('@deepseek-ai/node-addon-system-linux-arm64/package.json')`。
 * npm 在 Windows 上装树时**不会**装这个平台包（optionalDependencies 只装当前平台），
 * 设备上因此报 `Cannot find module …`（真机实测，agent 一轮直接失败）。
 *
 * 这里只补**清单文件**：真正的 `.node` 由 CMake 自建为 `libsystem.so` 进 HAP libs，
 * 入口脚本的原生库重定向会把 `bin/musl/system.node` 映射过去（`lib<stem>.so` 约定）。
 * 放清单而不放 prebuilt，是因为 prebuilt 的 musl 变体只 `DT_NEEDED libc.so`，
 * dlopen 后 napi 符号解析不到（E43/E44 同一个坑）。
 */
function addSystemAddonPackage() {
  const nm = join(STAGE, 'node_modules', '@deepseek-ai');
  if (!existsSync(join(nm, 'node-addon-system'))) {
    log('[pack-core]   node-addon-system 不在树里（跳过平台包）');
    return;
  }
  const abi = recipe.platform.cpu === 'x64' ? 'x64' : 'arm64';
  const target = join(nm, `node-addon-system-linux-${abi}`);
  const pkgFile = join(target, 'package.json');
  const marker = '0.1.2-dshm-shim';
  let needManifest = true;
  if (existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
      if (pkg.version === marker) {
        needManifest = false;
      }
    } catch {
      die('node-addon-system 平台包：现有 package.json 不可解析，拒绝覆盖');
    }
  }
  mkdirSync(join(target, 'bin', 'musl'), { recursive: true });
  mkdirSync(join(target, 'bin', 'glibc'), { recursive: true });
  if (needManifest) {
    writeFileSync(pkgFile, JSON.stringify({
      name: `@deepseek-ai/node-addon-system-linux-${abi}`,
      version: marker,
      description: 'DSHM 端侧 shim：真正的 system.node 由 CMake 自建为 libsystem.so（见 pack-core.addSystemAddonPackage）',
      private: true,
    }, null, 2) + '\n', 'utf8');
  }
  /*
   * 【为什么这里要放**占位文件**】Node 的模块解析走的是**内部 stat**（`Module._findPath`），
   * 不是我们 hook 过的 `fs.existsSync` ⇒ 目标路径**必须物理存在**，否则在 `.node` 扩展处理器
   * 被调用之前就抛 `Cannot find module …/bin/musl/system.node`（真机实测：agent 轮次直接失败，
   * 用户看到的是"发消息后没反应"）。
   * 文件内容无所谓：真正加载时一定经过我们 hook 的 `Module._extensions['.node']`，
   * 那里会把路径改写成 HAP 里的 `libs/<abi>/libsystem.so`（与 koffi/sharp 同一条机制）。
   * 两个 libc 变体都放，是因为上游加载器按 `process.report.header.glibcVersionRuntime` 选目录——
   * 那一句我们已经摘掉了（E388，见下），现在按 `/proc/self/maps` 判；两个目录映射到同一份
   * `libsystem.so`，所以放两份只是保证上游判断逻辑无论怎么改都不会缺件。
   */
  const placeholder = 'DSHM placeholder: real binary is loaded from HAP libs/<abi>/libsystem.so\n';
  writeFileSync(join(target, 'bin', 'musl', 'system.node'), placeholder, 'utf8');
  writeFileSync(join(target, 'bin', 'glibc', 'system.node'), placeholder, 'utf8');
  log(`[pack-core]   node-addon-system 平台包已补：linux-${abi}（占位 .node + HAP libs 的 libsystem.so）`);
  /*
   * DSHM 端侧修补：会话联动丢的是 flock 入口被"平台门"卡死。
   * `ja/deepseek-ai/dsh-session-persistence-jsonl` 通过 `node-addon-system/flock` 的
   * `tryLockExclusive(fd)` 给会话日志加排他锁。而原版 `lib/flock.js` 的 `loadBinding()`
   * 只在 `process.platform ∈ {linux,darwin}` 时加载；OpenHarmony 上报的是 `openharmony` ⇒
   * 直接抛 `flock is not supported on openharmony-arm64` —— 会话恢复（急性发消息/恢复会话）
   * 因此失败，表现为"无法对话/恢复会话失败"（真机实测日志）。
   * 修复：把非 win/darwin 一律视作 linux，命中已经由上面补好的
   * `node-addon-system-linux-${abi}` 平台占位包（.node 加载器重定向到 HAP 的 libsystem.so）。
   * 这个文件每次 pack 都会按此重写，保证干净重建也会带上。
   */
  const flockJs = join(nm, 'node-addon-system', 'lib', 'flock.js');
  const flockPatched = `/** Lazy POSIX flock entry; importing it does not load a native addon. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getSystemErrorName } from 'node:util';
let binding;
function loadBinding() {
    if (binding)
        return binding;
    const { platform: platformRaw, arch } = process;
    /*
     * DSHM 端侧修补：OpenHarmony 上 process.platform 报的是 openharmony（或 ohos/鸿蒙名），
     * 而非 linux ⇒ 原判断（只认 linux/darwin）在这里直接抛并让会话恢复失败。真正的原生锁
     * 已由 CMake 自建为 libsystem.so 并经 node-addon-system-linux-\${arch} 占位包加载（E103）。
     * 这里把非 win/darwin 一律视作 linux（openharmony/android/linux 皆是），命中 linux 平台包。
     */
    const platform = (platformRaw === 'win32' || platformRaw === 'darwin') ? platformRaw : 'linux';
    if (platform !== 'linux' && platform !== 'darwin') {
        throw Object.assign(new Error(\`flock is not supported on \${platformRaw}-\${arch}\`), {
            code: 'ERR_FLOCK_UNSUPPORTED_PLATFORM',
            syscall: 'flock',
        });
    }
    let filename = 'system.node';
    if (platform === 'linux') {
        /*
         * DSHM 端侧修补（E388）：**不要**用 process.report.getReport() 判 libc。
         * 它是"全进程诊断报告"——端侧实测耗时 55.8 s（会枚举 CPU 并逐个打开 sysfs
         * cpufreq 做实时频率查询），而且是**同步**调用，正好落在会话写租约
         * （SessionWriteLease.acquire → tryLockExclusive）的热路径上 ⇒ 冷启动后
         * 事件循环被挡 ~62 s，期间登录/模型选择/插件市场/预览全部无响应（真机
         * .cpuprofile：61,621 个样本里 55,829 个（90.6%）在这条链上）。
         * 两个 libc 变体本来都是同一份占位文件、由 .node 处理器重定向到 HAP
         * libs/<abi>/libsystem.so，判 glibc/musl 不影响加载，所以只做一次便宜的
         * 判断（/proc/self/maps，node-addon-native-custom-loader 同款），判不出来
         * 就按 musl（OpenHarmony 就是 musl）。
         */
        let libc = 'musl';
        try {
            if (/\\/libc\\.so\\.6|\\/libc-2\\.\\d+\\.so/.test(readFileSync('/proc/self/maps', 'utf8'))) {
                libc = 'glibc';
            }
        } catch {
            /* 读不到 maps 就走 musl 默认 */
        }
        filename = join(libc, filename);
    }
    const require = createRequire(import.meta.url);
    const manifest = require.resolve(\`@deepseek-ai/node-addon-system-\${platform}-\${arch}/package.json\`);
    binding = require(join(dirname(manifest), 'bin', filename));
    return binding;
}
export async function tryLockExclusive(fd) {
    const errno = await new Promise((resolve) => {
        loadBinding().tryLock(fd, resolve);
    });
    if (errno === 0)
        return;
    const code = getSystemErrorName(-errno);
    throw Object.assign(new Error(\`\${code}: flock failed\`), {
        code,
        errno,
        syscall: 'flock',
    });
}
`;
  if (existsSync(flockJs)) {
    writeFileSync(flockJs, flockPatched, 'utf8');
    log(`[pack-core]   node-addon-system/lib/flock.js 已补平台门（openharmony/home → linux 平台包）`);
  } else {
    die('node-addon-system/lib/flock.js 未找到，无法补平台门');
  }
}

/**
 * 让会话日志的**排他发布**在鸿蒙沙箱里可用（E104）。
 *
 * 【真机根因】`dsh-session-persistence-jsonl` 用 `link(2)` 把写好的临时文件"排他发布"成
 * 正式日志（`link` 天生带 EEXIST 语义），而鸿蒙应用沙箱**禁止 link**：
 *
 *     EACCES: permission denied, link '…/sessions/--…--/session-…/session.v3.jsonl.zstd.2112db587c…'
 *
 * 后果正是用户看到的「发消息后没反应、详情里数量也不变」——每写一次日志就失败一次，
 * 会话状态根本无法落盘。这与符号链接禁令（E46）是同一类沙箱约束。
 *
 * 【等价改写】"存在性检查 + rename"：rename 在同一文件系统上是**原子**的，
 * 因此"目标不存在时改名过去"与"link 且不带 O_EXCL 冲突"在语义上一致。
 * 唯一弱化之处是极端 TOCTOU 窗口内可能覆盖同名的刚出现文件——而两个调用点在发布前
 * 都已经检查过目标（`rejectExistingLog` / `inspectExpectedCurrent`），所以按等价处理。
 *
 * 上游若改了这两段，这里**报错退出**，不静默跳过（悄悄发出一个"会话永远写不进去"的包，
 * 比打包失败难查得多）。
 */
function patchLinkForSandbox() {
  const target = join(
    STAGE, 'node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl', 'lib', 'index.js',
  );
  if (!existsSync(target)) {
    die(`link 沙箱补丁：找不到 ${target}`);
  }
  let text = readFileSync(target, 'utf8');
  const helper = `/**
 * DSHM_LINK_SANDBOX: 鸿蒙沙箱禁止 link(2)（EACCES），用"存在性检查 + rename"做等价发布。
 * rename 在同一文件系统上是原子的；目标已存在时按 EEXIST 抛错，保持调用方的分支语义。
 * @param fsImpl - 提供 access/rename 的 fs/promises 句柄；缺失时回退到模块导入的 access/rename
 * @param from - 已写好并 fsync 过的临时文件
 * @param to - 目标路径（必须尚不存在）
 */
async function dshmPublishExclusive(fsImpl, from, to) {
	/*
	 * 【E104 加固】两个调用点传进来的句柄形状不同：
	 *   · 3164 行传 \`{ access, rename }\`（显式给了两个函数）
	 *   · 2056 行传 \`internals.fs\`（= defaultFileSystem，只有 open/readFile/readdir/stat/lstat/link/rm，
	 *     **既没有 access 也没有 rename**）
	 * 于是原来直接 \`fsImpl.rename(...)\` 会在 2056 这条路径上抛
	 * \`TypeError: fsImpl.rename is not a function\` ⇒ 会话日志发布失败 ⇒
	 * 读到半截日志 ⇒ \`SessionPersistenceCorruptionError\`（用户看到"无法对话/会话损坏"）。
	 * 这里对缺失的方法回退到模块顶层从 node:fs/promises 导入的 access/rename（同一实现）。
	 */
	const accessFn = typeof fsImpl?.access === "function" ? fsImpl.access : access;
	const renameFn = typeof fsImpl?.rename === "function" ? fsImpl.rename : rename;
	let exists = true;
	try {
		await accessFn(to);
	} catch {
		exists = false;
	}
	if (exists) {
		const error = new Error(\`EEXIST: file already exists, link '\${from}' -> '\${to}'\`);
		error.code = "EEXIST";
		throw error;
	}
	await renameFn(from, to);
}
`;
  // 已打过洞但仍是旧形（无回退）时，就地升级，避免"已存在即跳过"把 bug 留下。
  const oldHelperHead = 'async function dshmPublishExclusive(fsImpl, from, to) {\n\tlet exists = true;\n\ttry {\n\t\tawait fsImpl.access(to);';
  /* 兼容改名前的旧标记，见 allowOriginList 的同类说明 */
  if (text.includes('DSHM_LINK_SANDBOX') || text.includes('HDSH_LINK_SANDBOX')) {
    if (text.includes(oldHelperHead)) {
      const start = text.indexOf('/**\n * DSHM_LINK_SANDBOX');
      const end = text.indexOf('\n}\n', text.indexOf('await fsImpl.rename(from, to);', start)) + 3;
      text = text.slice(0, start) + helper + text.slice(end);
      writeFileSync(target, text, 'utf8');
      log('[pack-core]   link 沙箱补丁：已存在但为旧形，已升级为 access/rename 回退版');
      return;
    }
    log('[pack-core]   link 沙箱补丁已存在（跳过）');
    return;
  }
  const importBefore = 'import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from "node:fs/promises";';
  const importAfter = 'import { access, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, truncate } from "node:fs/promises";';
  const callSites = [
    ['\t\tawait internals.fs.link(staged, currentPath);',
      '\t\tawait dshmPublishExclusive(internals.fs, staged, currentPath);'],
    ['\t\t\tawait link(tmp, finalPath);',
      '\t\t\tawait dshmPublishExclusive({ access, rename }, tmp, finalPath);'],
  ];
  if (!text.includes(importBefore)) {
    die('link 沙箱补丁：上游 import 行已变化（未找到待替换片段），拒绝静默跳过');
  }
  for (const [before] of callSites) {
    if (!text.includes(before)) {
      die(`link 沙箱补丁：未找到调用点 ${JSON.stringify(before.trim())}，拒绝静默跳过`);
    }
  }
  text = text.replace(importBefore, `${importAfter}\n${helper}`);
  for (const [before, after] of callSites) {
    text = text.replace(before, after);
  }
  writeFileSync(target, text, 'utf8');
  log('[pack-core]   link 沙箱补丁：会话日志改用「存在性检查 + rename」发布');
}

/**
 * 凭据文件"仅属主可读"检查的**鸿蒙平台豁免**（E127）。
 *
 * 【上游行为】`dsh-credentials-local/lib/index.js` 的 `assertOwnerOnly()` 读文件 mode，
 * 属组/其他位非零即抛 `… is readable beyond its owner (mode 660); run "chmod 600 …"`。
 * 这在桌面 POSIX 上是合理防护。
 *
 * 【为什么必须豁免】hmfs 会把文件权限**强制成 660**，`chmod 600` 无效
 * （社区移植版 `@ohos-ports/deepseek-ai-dsh` 的补丁清单也记着同一条）。
 * 该检查在端侧**永远不可能通过**，只会把"凭据确实写进去了"判成读取失败——
 * 用户看到的是"填了密钥，模型仍说没有密钥"。
 *
 * 【为什么这是豁免而不是放宽安全】端侧凭据位于**应用私有沙箱**，其它应用本就进不来；
 * 这条检查在端侧不提供任何额外保护，只提供假失败。豁免条件用入口脚本自己设的
 * `DSHM_PLATFORM === 'ohos'`（`hostcore/app/main.js`），桌面/CI 上该变量不存在 ⇒ 检查照旧生效。
 *
 * 上游若改了这段，这里**报错退出**：静默发一个"凭据读不出来"的包，比打包失败难查得多。
 */
function patchCredentialsOwnerCheck() {
  const target = join(
    STAGE, 'node_modules', '@deepseek-ai', 'dsh-credentials-local', 'lib', 'index.js',
  );
  if (!existsSync(target)) {
    die(`凭据权限补丁：找不到 ${target}`);
  }
  let text = readFileSync(target, 'utf8');
  /* 兼容改名前的旧标记，见 allowOriginList 的同类说明 */
  if (text.includes('DSHM_CREDENTIALS_MODE_EXEMPT') || text.includes('HDSH_CREDENTIALS_MODE_EXEMPT')) {
    log('[pack-core]   凭据权限补丁已存在（跳过）');
    return;
  }
  const before = '\tif (process.platform === "win32") return;\n\tif ((mode & GROUP_OTHER_BITS) === 0) return;';
  const after = '\tif (process.platform === "win32") return;\n'
    + '\t/* DSHM_CREDENTIALS_MODE_EXEMPT: hmfs 强制 660 ⇒ 该检查在鸿蒙永远不可能通过（E127）。\n'
    + '\t   端侧凭据在应用私有沙箱内，其它应用本就进不来；豁免只去掉假失败，不放宽真实保护。 */\n'
    + '\tif (process.env.DSHM_PLATFORM === "ohos") return;\n'
    + '\tif ((mode & GROUP_OTHER_BITS) === 0) return;';
  if (!text.includes(before)) {
    die('凭据权限补丁：上游 `assertOwnerOnly` 实现已变化（未找到待替换片段），拒绝静默跳过');
  }
  writeFileSync(target, text.replace(before, after), 'utf8');
  log('[pack-core]   凭据权限补丁：鸿蒙上豁免"仅属主可读"检查（hmfs 强制 660）');
}

/**
 * 端侧禁用 **workflow / PTC** 工具（P1-1，2026-09-26）。
 *
 * 【为什么必须改 agent preset 而不是 profile 的 patch 行】模型的**工具清单**由
 * agent preset 决定（`dsh-web-app/presets/*.patch.yml` 的 `config.plugins`）。
 * 官方把 `workflow-ptc` / `tool-workflow` 声明了 4 处：dsh-base（host 面，启用）
 * 与各 preset 的 `delegation` 组内（模型可见）。profile 里写
 * `- id: workflow-ptc / disabled: true` 只命中 host 面那一行——preset 的副本在
 * `cordis:group` 的 isolate 作用域里，按 id 查不到 → applyEntryPatches
 * "entry not found" 静默跳过（真机取证：composition 后模型仍拿到这个必崩工具）。
 * 故在**打包层**直接给 preset 文件里的这两行加 `disabled: true`。
 *
 * 【为什么端侧必崩】`@deepseek-ai/dsh-ptc-runtime-node` 的执行入口调
 * `node:module` 的 `stripTypeScriptTypes`（剥离用户脚本的 TS 类型），该 API 在
 * `--jitless` 下抛
 *   `WebAssembly is not supported in this environment, but is required for TypeScript`
 * （Node v24.14.1 `--jitless` 逐字复现；端侧 BOOT_00 报 jitless=true）。它还要
 * `spawn` 一个子 Node 进程，那条链在端侧同样受进程创建限制。两处都无解 ⇒
 * 按官方"禁掉必然失败的工具"的纪律，从工具清单里摘掉。
 *
 * 上游若改了 preset 结构（行改名/换文件），这里**报错退出**而不是静默跳过——
 * 静默跳过的后果是模型拿到一个必崩工具，比打包失败难查得多。
 */
function patchAgentPresetWorkflow() {
  const dir = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets');
  if (!existsSync(dir)) {
    die(`agent preset 补丁：找不到 ${dir}`);
  }
  const files = readdirSync(dir).filter((n) => n.endsWith('.patch.yml')).sort();
  if (files.length === 0) {
    die('agent preset 补丁：presets 目录下没有 *.patch.yml');
  }
  const MARK = 'DSHM_WORKFLOW_DISABLED';
  let touched = 0;
  let alreadyDone = 0;
  for (const name of files) {
    const file = join(dir, name);
    let text = readFileSync(file, 'utf8');
    /*
     * 【兼容改名前的旧标记】核心树里由上一版 pack-core 打过的是 `HDSH_WORKFLOW_DISABLED`。
     * 若只认新名，会判成"没打过" ⇒ 走下面的插入逻辑，而 `already` 判重发现
     * `disabled: true` 已在 ⇒ 既不计数 touched 也不计数 alreadyDone ⇒ 最终 die
     * （实测发生）。与 allowOriginList / 其余 5 处同因同修。
     */
    if (text.includes(MARK) || text.includes(MARK.replace('DSHM_', 'HDSH_'))) {
      alreadyDone += 1;
      continue; // 已打过（幂等：重复 pack 不该报错，见下方 touched/alreadyDone 判定）
    }
    let changed = false;
    const lines = text.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      out.push(line);
      const m = /^(\s*)- id: (workflow-ptc|tool-workflow)\s*$/.exec(line);
      if (m === null) {
        continue;
      }
      // 紧随其后应有一行 `name: …`；在其后插入 disabled（缩进 = id 的缩进 + 2）。
      if (i + 1 >= lines.length || !/^\s+name:\s/.test(lines[i + 1])) {
        continue;
      }
      // 【必须查重】有些 preset（如 ptc）这两行**本来就带** `disabled: true`——
      // 无条件插入会造出重复键（YAML "Map keys must be unique"，整份 preset 解析失败）。
      // 只看紧随 name 之后、直到同级或更浅缩进的兄弟键之前的那几行。
      const nameIndent = lines[i + 1].match(/^\s*/)[0].length;
      let already = false;
      for (let k = i + 2; k < lines.length; k += 1) {
        const l = lines[k];
        if (l.trim() === '') continue;
        const ind = l.match(/^\s*/)[0].length;
        if (ind < nameIndent) break;               // 离开该条目
        if (ind === nameIndent && /^\s*- /.test(l)) break; // 同级的另一键/行
        if (ind === nameIndent && /^\s+disabled:\s/.test(l)) { already = true; break; }
      }
      if (already) {
        out.push(lines[i + 1]);
        i += 1;
        continue;
      }
      out.push(lines[i + 1]);
      const indent = `${m[1]}  `;
      out.push(`${indent}# ${MARK}: jitless 无 WASM ⇒ PTC/工具必崩（见 tools/pack-core.mjs）`);
      out.push(`${indent}disabled: true`);
      i += 1; // name 行已消费
      changed = true;
    }
    if (changed) {
      writeFileSync(file, out.join('\n'), 'utf8');
      log(`[pack-core]   agent preset 补丁：${name} 已禁用 workflow-ptc / tool-workflow`);
      touched += 1;
    }
  }
  if (touched === 0 && alreadyDone === 0) {
    // 既没改到、也没有已打标记的文件 ⇒ 上游 preset 结构变了：报错而不是静默通过。
    die('agent preset 补丁：没有任何 preset 文件被改到（上游结构变化？），拒绝静默跳过');
  }
  if (alreadyDone > 0) {
    log(`[pack-core]   agent preset 补丁：${alreadyDone} 个文件已带标记（幂等跳过）`);
  }
}

/**
 * `dsh-app-boot` 的 **stack/message 只读保护**（报告 4 ①，2026-09-26）。
 *
 * 【现象】语音输入等 UI 位置报"包元信息错误"（红字）。根因不在语音，而在错误改写：
 * Node 24 的解析器错误（`ERR_PACKAGE_PATH_NOT_EXPORTED` / `ERR_MODULE_NOT_FOUND`）
 * 其 `error.message` / `error.stack` 可能是**只读访问器**，而 `dsh-app-boot` 在
 * 改写路径后**裸赋值**：
 *     error.message = message;                       // ← 抛 TypeError（严格模式）
 *     if (stack !== void 0) error.stack = stack...;  // ← 同上
 * 一旦抛出，原本携带 `code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'` 的错误被**顶替**成一个
 * 没有 code 的 TypeError ⇒ 下游 `missingResource()`（靠 code 命中）失配 ⇒ 该包被判
 * "元信息不可读" ⇒ UI 显示"包元信息错误"。
 *
 * 【改法】赋值包进 try/catch（与上游在浏览器 worker 上的处理一致）。目的不是让赋值
 * 成功，而是**保住原错误对象**：即使 message/stack 改不动，`code` 仍然在，下游照常
 * 走到"元信息回退 name/description"的正常分支。
 *
 * 【为什么放在打包层】core 树跨重置存活（HAP 不重建它），与 fs-local/attachment-local
 * 等补丁同一机制；且这 4 处是**上游同一段逻辑的两份副本**（lib/index.js +
 * lib/worker/profile-resolution-bootstrap.js），必须在两处都改，否则 worker 侧照崩。
 *
 * 上游若改了这段，**报错退出**——静默跳过的后果是"红字照旧"，比打包失败难查。
 */
function patchAppBootReadonlyStack() {
  const rels = [
    ['dsh-app-boot', 'lib', 'index.js'],
    ['dsh-app-boot', 'lib', 'worker', 'profile-resolution-bootstrap.js'],
  ];
  let touched = 0;
  for (const rel of rels) {
    const target = join(STAGE, 'node_modules', '@deepseek-ai', ...rel);
    if (!existsSync(target)) {
      die(`app-boot 只读保护补丁：找不到 ${target}`);
    }
    let text = readFileSync(target, 'utf8');
    /* 兼容改名前的旧标记，见 allowOriginList 的同类说明 */
  if (text.includes('DSHM_READONLY_STACK_GUARD') || text.includes('HDSH_READONLY_STACK_GUARD')) {
      continue; // 已打过（幂等）
    }
    /*
     * 两种赋值形态，各自成对出现（先 message 后 stack）：
     *   A: error.message = message;                       → stack.replace(originalMessage, message)
     *   B: error.message = originalMessage.replace(...);  → stack.replace(originalMessage, error.message)
     * 用逐行的最小替换，避免跨块正则的脆弱性。
     */
    const lines = text.split('\n');
    const out = [];
    let localFixed = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const isMessageAssign = /^\t*error\.message = .+;\s*$/.test(line);
      const isStackAssign = /^\t*if \(stack !== void 0\) error\.stack = stack\.replace\(originalMessage, (message|error\.message)\);\s*$/.test(line);
      if (!isMessageAssign && !isStackAssign) {
        out.push(line);
        continue;
      }
      const indent = line.match(/^\t*/)[0];
      // 把该语句原样包进 try/catch（单行 → 多行）；语句本身一字不动，避免表达式改写出错。
      out.push(`${indent}/* DSHM_READONLY_STACK_GUARD: Node 24 解析器错误的 message/stack 可能是只读访问器，`);
      out.push(`${indent}   裸赋值会抛 TypeError 并顶替掉带 code 的原错误（→ 下游 missingResource 失配）。`);
      out.push(`${indent}   包一层 try/catch 只为保住原错误对象；改不动就保持原样。 */`);
      out.push(`${indent}try {`);
      out.push(`${indent}\t${line.trim()}`);
      out.push(`${indent}} catch { /* 只读属性：保留原 message/stack（code 仍在） */ }`);
      localFixed += 1;
    }
    if (localFixed === 0) {
      die(`app-boot 只读保护补丁：${rel.join('/')} 里没找到待保护的赋值（上游结构变化？），拒绝静默跳过`);
    }
    writeFileSync(target, out.join('\n'), 'utf8');
    log(`[pack-core]   app-boot 只读保护：${rel.join('/')} 已包 ${localFixed} 处赋值`);
    touched += 1;
  }
  if (touched === 0) {
    log('[pack-core]   app-boot 只读保护补丁已存在（跳过）');
  }
}

/**
 * `dsh-fs-local` 的**硬链接禁令**包容（P1，2026-09-26）。
 *
 * 【上游行为】`writeFileAtomic(createIfAbsent=…)` 用 `link(2)` 做 no-clobber 发布
 * （目标已存在 ⇒ EEXIST，原子且不覆盖）。
 *
 * 【为什么必须补】鸿蒙沙箱**禁硬链接**（EPERM/EACCES）⇒ "模型在工作区新建文件"
 * 整条链路失败（真机 `write` 工具报 `EPERM link`）。这条在核心树里改一次即可跨
 * 重置存活（HAP 不会重建 core 树），所以放到打包层而不是运行时。
 *
 * 【等价改写】link 类错误且目标**确实不存在** ⇒ 改用 `rename` 发布（同文件系统原子，
 * 目标不存在时语义等价）。目标已存在（EEXIST）仍按原逻辑抛错，不静默覆盖。
 */
function patchFsLocalLink() {
  const target = join(
    STAGE, 'node_modules', '@deepseek-ai', 'dsh-fs-local', 'lib', 'index.js',
  );
  if (!existsSync(target)) {
    die(`fs-local 补丁：找不到 ${target}`);
  }
  let text = readFileSync(target, 'utf8');
  /* 兼容改名前的旧标记，见 allowOriginList 的同类说明 */
  if (text.includes('DSHM_FS_LOCAL_SANDBOX') || text.includes('HDSH_FS_LOCAL_SANDBOX')) {
    log('[pack-core]   fs-local 补丁已存在（跳过）');
    return;
  }
  const before = `\t\tif (createIfAbsent !== void 0) try {
\t\t\tawait linkFile(tempPath, absolutePath);
\t\t} catch (error) {
\t\t\tawait throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);
\t\t}`;
  const after = `\t\tif (createIfAbsent !== void 0) {
\t\t\t/*
\t\t\t * 【DSHM 端侧补丁 2026-09-26（DSHM_FS_LOCAL_SANDBOX）】原为 link(tempPath, absolutePath)
\t\t\t * 做 no-clobber 发布（目标已存在则 EEXIST）。鸿蒙沙箱**禁硬链接**（EPERM/EACCES），
\t\t\t * 于是"模型在工作区新建文件"整条失败（真机实证：write 工具报 EPERM link）。
\t\t\t * 回退策略：链接类错误且目标**确实不存在**时，改用 rename 发布——同一文件系统上
\t\t\t * rename 是原子的，且此刻目标不存在，语义等价（no-clobber 的保证由前置检查维持）。
\t\t\t * 目标已存在（EEXIST）仍按原逻辑抛"已存在"，不静默覆盖。
\t\t\t */
\t\t\ttry {
\t\t\t\tawait linkFile(tempPath, absolutePath);
\t\t\t} catch (error) {
\t\t\t\tconst code = error && error.code;
\t\t\t\tconst linkUnsupported = code === "EPERM" || code === "EACCES"
\t\t\t\t\t|| code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV";
\t\t\t\tif (!linkUnsupported) {
\t\t\t\t\tawait throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);
\t\t\t\t} else {
\t\t\t\t\tlet exists = true;
\t\t\t\t\ttry {
\t\t\t\t\t\tawait inspectPublicationTarget(absolutePath);
\t\t\t\t\t} catch (_absent) {
\t\t\t\t\t\texists = false;
\t\t\t\t\t}
\t\t\t\t\tif (exists) {
\t\t\t\t\t\tawait throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);
\t\t\t\t\t} else {
\t\t\t\t\t\tawait rename(tempPath, absolutePath);
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}`;
  if (!text.includes(before)) {
    die('fs-local 补丁：上游 writeFileAtomic 的 createIfAbsent 发布段已变化（未找到待替换片段），拒绝静默跳过');
  }
  writeFileSync(target, text.replace(before, after), 'utf8');
  log('[pack-core]   fs-local 补丁：createIfAbsent 发布 link→rename 回退（鸿蒙禁硬链接）');
}

/**
 * `dsh-attachment-local` 的**硬链接禁令 + 祖先 fsync 容错**（P1，2026-09-26）。
 *
 * 【两处上游行为，都在鸿蒙上必然失败】
 *   ① `publishImmutableObject` / `publishStagedObject` 用 `link(2)` 发布附件 ⇒ 禁硬链接，失败；
 *   ② `syncDirectory()` 从 DSH_HOME 逐级往上 fsync，最终 open `/data/storage/el2`
 *      （root:root 0711）⇒ EACCES，整条附件保存失败（真机 `read_image` 报
 *      `EACCES: open '/data/storage/el2'`）。
 *
 * 【等价改写】① link → `copyFile(…, COPYFILE_EXCL)`（同样"目标存在即失败"的 exclusive
 * 语义，且不依赖硬链接；EEXIST 分支保持原样）；② 祖先目录打不开/不能 fsync 时跳过该级
 * ——那是沙箱不可达区域，其 durability 不由我们负责。
 */
function patchAttachmentLocalLink() {
  const target = join(
    STAGE, 'node_modules', '@deepseek-ai', 'dsh-attachment-local', 'lib', 'index.js',
  );
  if (!existsSync(target)) {
    die(`attachment-local 补丁：找不到 ${target}`);
  }
  let text = readFileSync(target, 'utf8');
  /* 兼容改名前的旧标记，见 allowOriginList 的同类说明 */
  if (text.includes('DSHM_ATTACHMENT_SANDBOX') || text.includes('HDSH_ATTACHMENT_SANDBOX')) {
    log('[pack-core]   attachment-local 补丁已存在（跳过）');
    return;
  }

  // ① 补 copyFile 导入（原导入里没有它）。
  const importBefore = 'import { chmod, link, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";';
  const importAfter = 'import { chmod, copyFile, link, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";';
  if (!text.includes(importBefore)) {
    die('attachment-local 补丁：npm 导入行已变化（未找到待替换片段），拒绝静默跳过');
  }
  text = text.replace(importBefore, importAfter);

  // ② syncDirectory 的祖先 fsync 容错。
  const syncBefore = `\tconst handle = await open(path, constants.O_RDONLY);
\ttry {
\t\tawait handle.sync();
\t} finally {
\t\tawait handle.close();
\t}`;
  const syncAfter = `\t/*
\t * 【DSHM 端侧补丁 2026-09-26（DSHM_ATTACHMENT_SANDBOX）】鸿蒙沙箱里从 DSH_HOME
\t * 往上 fsync 到 /data/storage/el2（root:root 0711）会 open EACCES，整条附件保存
\t * 直接失败（真机实证：read_image 报 \`EACCES: open '/data/storage/el2'\`）。
\t * 该级祖先属沙箱**不可达区域**，durability 也不由我们负责 ⇒ 打不开就跳过这一级，
\t * 其余可 fsync 的层级照常。这是"尽力而为的持久化"而非正确性判据。
\t */
\tlet handle;
\ttry {
\t\thandle = await open(path, constants.O_RDONLY);
\t} catch (error) {
\t\tif (error && (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOENT" || error.code === "ENOTDIR")) return;
\t\tthrow error;
\t}
\ttry {
\t\tawait handle.sync();
\t} catch (error) {
\t\tif (!(error && (error.code === "EACCES" || error.code === "EPERM" || error.code === "EINVAL" || error.code === "ENOTSUP" || error.code === "EOPNOTSUPP"))) throw error;
\t} finally {
\t\tawait handle.close();
\t}`;
  if (!text.includes(syncBefore)) {
    die('attachment-local 补丁：syncDirectory 实现已变化（未找到待替换片段），拒绝静默跳过');
  }
  text = text.replace(syncBefore, syncAfter);

  // ③ 两处 link 发布 → copyFile(COPYFILE_EXCL)。
  const linkBefore = (src) => `\t\ttry {\n\t\t\tawait link(${src}, target);\n\t\t} catch (error) {\n\t\t\t/* v8 ignore next -- Private same-filesystem directories make EEXIST the only recoverable link race. */\n\t\t\tif (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;\n\t\t\tif (await digestFile(target) !== ${src === 'source' ? 'sha256' : 'staged.sha256'}) throw new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");\n\t\t}`;
  const linkAfter = (src, digest) => `\t\ttry {\n\t\t\t/* 【DSHM 端侧补丁 2026-09-26】沙箱禁硬链接：link → copyFile(COPYFILE_EXCL)。\n\t\t\t * COPYFILE_EXCL 提供同样的"目标已存在即失败"语义，EEXIST 分支保持原样。 */\n\t\t\tawait copyFile(${src}, target, constants.COPYFILE_EXCL);\n\t\t} catch (error) {\n\t\t\t/* v8 ignore next -- Private same-filesystem directories make EEXIST the only recoverable link race. */\n\t\t\tif (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;\n\t\t\tif (await digestFile(target) !== ${digest}) throw new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");\n\t\t}`;
  for (const [src, digest] of [['source', 'sha256'], ['staged.path', 'staged.sha256']]) {
    const b = linkBefore(src);
    if (!text.includes(b)) {
      die(`attachment-local 补丁：未找到 link(${src}) 发布点，拒绝静默跳过`);
    }
    text = text.replace(b, linkAfter(src, digest));
  }

  writeFileSync(target, text, 'utf8');
  log('[pack-core]   attachment-local 补丁：link→copyFile + 祖先 fsync 容错（鸿蒙沙箱）');
}

// ── ⑤ 鸿蒙前端兼容补丁（对齐 GitCode issue #1 / #2）───────────────────────
/*
 * 【这一组解决什么】
 *   1) `dsh-resource://` 地址解析。三个上游前端 bundle 都是 `new URL(address)` 之后读
 *      `.hostname` / `.pathname`。ArkWeb 把**未注册 scheme** 当 opaque URL：
 *        Chromium / Node  : new URL("dsh-resource://file/session/s1/a.md")
 *                           → hostname === "file", pathname === "/session/s1/a.md"
 *        ArkWeb           : hostname === "",       pathname === "//file/session/s1/a.md"
 *      后果三条：资源协议解析直接 return void 0（侧边栏文件预览报"文件资源服务不可用"）、
 *      basename 模式匹配全灭、子会话链接打不开。修法 = hostname 为空时用正则从**原始
 *      地址**取回 authority / path / query（8 组真实样例实测与 Chromium 语义逐字一致），
 *      再走原有判定，不改上游判定逻辑本身。
 *   2) pdfjs 的 `Map.prototype.getOrInsert(Computed)`。`pdfjs-dist@6.3.289` 在
 *      `client.pdf.js` 里用了 40 处，ArkWeb 7.0.0.105 的 V8 没实现 ⇒ PDF 预览直接
 *      TypeError。修法 = 给 `Map` / `WeakMap` 原型各补两个方法，**只在缺失时安装**
 *      （有原生实现就 no-op，不会覆盖未来版本）。该 chunk 的主线程代码与它内联启动的
 *      pdf worker 是**两个 realm**（worker 由 Blob URL 起，不继承页面启动期注入）⇒ 两处各装一次。
 *   3) `dsh-subprocess-local` 的平台判定。`createProcessInspector()` 用
 *      `platform === "linux"` 枚举，openharmony 落到末尾 `throw`（真机报错原文：
 *      `subprocess-local: terminal inspection is unsupported on platform openharmony`）。
 *      鸿蒙 /proc 与 Linux 同构（readdir(/proc)、/proc/<pid>/stat 的 tpgid/starttime、
 *      /proc/<pid>/fd/0 均可用；/proc/<pid>/task/<tid>/syscall 缺失但上游本就 try/catch
 *      降级）⇒ 直接复用 `LinuxProcessInspector`。同时把 shellActivity 注入在鸿蒙上关掉：
 *      它给 bash 注入 `--rcfile`、给 zsh 注入 `ZDOTDIR` + `add-zle-hook-widget`，
 *      端侧 zsh 不认那套 bash 语义。`selectContainmentMode` / `fallbackOwner` **不动**
 *      （linux-scope 探测在鸿蒙本就失败、走既有 fallback 降级，属正确行为）。
 * 【纪律】与上面所有 patch 一致：不改上游源码，只改打包产物；找不到待替换片段就 die。
 */

/** `Map` / `WeakMap` 的 `getOrInsert(Computed)` 兜底源码（缺失时才安装）。 */
const MAP_COMPAT_SOURCE = `(function () {
	function install(proto, name, impl) {
		if (typeof proto[name] === "function") return;
		Object.defineProperty(proto, name, { configurable: true, writable: true, enumerable: false, value: impl });
	}
	install(Map.prototype, "getOrInsert", function (key, value) {
		const current = this.get(key);
		if (current !== void 0) return current;
		this.set(key, value);
		return value;
	});
	install(Map.prototype, "getOrInsertComputed", function (key, compute) {
		const current = this.get(key);
		if (current !== void 0) return current;
		const value = compute(key);
		this.set(key, value);
		return value;
	});
	install(WeakMap.prototype, "getOrInsert", function (key, value) {
		const current = this.get(key);
		if (current !== void 0) return current;
		this.set(key, value);
		return value;
	});
	install(WeakMap.prototype, "getOrInsertComputed", function (key, compute) {
		const current = this.get(key);
		if (current !== void 0) return current;
		const value = compute(key);
		this.set(key, value);
		return value;
	});
})();
/* DSHM_MAP_COMPAT */
`;

function patchResourceAddressArmor() {
  const scope = join(STAGE, 'node_modules', '@deepseek-ai');

  // ① dsh-client-resources：protocolOf() 的 hostname 兜底。
  {
    const target = join(scope, 'dsh-client-resources', 'lib', 'client.js');
    if (!existsSync(target)) die(`资源地址补丁：找不到 ${target}`);
    let text = readFileSync(target, 'utf8');
    if (text.includes('DSHM_RESOURCE_ARMOR_PROTOCOL')) {
      log('[pack-core]   资源地址补丁（client-resources.protocolOf）已存在（跳过）');
    } else {
      const before = '\t\t\tif (parsed.protocol !== `dsh-resource:`) return void 0;\n'
        + '\t\t\treturn parsed.hostname === "" ? void 0 : parsed.hostname.toLowerCase();\n';
      if (!text.includes(before)) {
        die('资源地址补丁：client-resources 的 protocolOf() 实现已变化（未找到待替换片段），拒绝静默跳过');
      }
      const after = '\t\t\tif (parsed.protocol !== `dsh-resource:`) return void 0;\n'
        + '\t\t\t/*\n'
        + '\t\t\t * 【DSHM 鸿蒙补丁 DSHM_RESOURCE_ARMOR_PROTOCOL】ArkWeb 把未注册的 `dsh-resource:` 当 opaque URL：\n'
        + '\t\t\t * 这里 hostname === ""（Chromium/Node 下是 "file"），原样返回就会让整条资源协议解析失败。\n'
        + '\t\t\t * hostname 为空时用正则从原始地址取回 authority，语义与 Chromium 一致。\n'
        + '\t\t\t */\n'
        + '\t\t\tconst armor = parsed.hostname === "" ? /^[a-z][a-z\\d+.-]*:\\/\\/([^/?#]*)/iu.exec(address) : null;\n'
        + '\t\t\tconst host = armor === null ? parsed.hostname : armor[1];\n'
        + '\t\t\treturn host === "" ? void 0 : host.toLowerCase();\n';
      text = text.replace(before, after);
      writeFileSync(target, text, 'utf8');
      log('[pack-core]   资源地址补丁：client-resources protocolOf() 加 opaque-URL authority 兜底');
    }
  }

  // ② dsh-client-ui-sidebar-right：pathOf() 剥掉被并进 path 的 authority。
  {
    const target = join(scope, 'dsh-client-ui-sidebar-right', 'lib', 'client.js');
    if (!existsSync(target)) die(`资源地址补丁：找不到 ${target}`);
    let text = readFileSync(target, 'utf8');
    if (text.includes('DSHM_RESOURCE_ARMOR_PATH')) {
      log('[pack-core]   资源地址补丁（sidebar-right.pathOf）已存在（跳过）');
    } else {
      const before = '\t\tfunction pathOf(address) {\n'
        + '\t\t\ttry {\n'
        + '\t\t\t\treturn new URL(address).pathname;\n'
        + '\t\t\t} catch {\n'
        + '\t\t\t\treturn;\n'
        + '\t\t\t}\n'
        + '\t\t}\n';
      if (!text.includes(before)) {
        die('资源地址补丁：sidebar-right 的 pathOf() 实现已变化（未找到待替换片段），拒绝静默跳过');
      }
      const after = '\t\tfunction pathOf(address) {\n'
        + '\t\t\ttry {\n'
        + '\t\t\t\tconst parsed = new URL(address);\n'
        + '\t\t\t\t/*\n'
        + '\t\t\t\t * 【DSHM 鸿蒙补丁 DSHM_RESOURCE_ARMOR_PATH】ArkWeb 下 `dsh-resource://file/...` 的 pathname 是\n'
        + '\t\t\t\t * `//file/...`（authority 被并进 path），basename 模式匹配会全灭。用正则从原始地址取回\n'
        + '\t\t\t\t * authority 之后的 path，语义与 Chromium 一致。\n'
        + '\t\t\t\t */\n'
        + '\t\t\t\tif (parsed.hostname === "" && parsed.pathname.startsWith("//")) {\n'
        + '\t\t\t\t\tconst armor = /^[a-z][a-z\\d+.-]*:\\/\\/([^/?#]*)([^?#]*)/iu.exec(address);\n'
        + '\t\t\t\t\tif (armor !== null) return armor[2];\n'
        + '\t\t\t\t}\n'
        + '\t\t\t\treturn parsed.pathname;\n'
        + '\t\t\t} catch {\n'
        + '\t\t\t\treturn;\n'
        + '\t\t\t}\n'
        + '\t\t}\n';
      text = text.replace(before, after);
      writeFileSync(target, text, 'utf8');
      log('[pack-core]   资源地址补丁：sidebar-right pathOf() 剥掉被并进 path 的 authority');
    }
  }

  // ③ dsh-client-ui-subagent：parseSubagentChatAddress() 的 host / path / query 兜底。
  {
    const target = join(scope, 'dsh-client-ui-subagent', 'lib', 'client.js');
    if (!existsSync(target)) die(`资源地址补丁：找不到 ${target}`);
    let text = readFileSync(target, 'utf8');
    if (text.includes('DSHM_RESOURCE_ARMOR_SUBAGENT')) {
      log('[pack-core]   资源地址补丁（subagent.parseSubagentChatAddress）已存在（跳过）');
    } else {
      const before = '\t\t\tif (url.protocol !== "dsh-resource:" || url.hostname.toLowerCase() !== "subagentchat") return void 0;\n'
        + '\t\t\tconst parts = url.pathname.split("/").filter(Boolean);\n'
        + '\t\t\tif (parts.length !== 2 || parts[0] !== "session") return void 0;\n'
        + '\t\t\tconst parentSessionId = url.searchParams.get("parent");\n'
        + '\t\t\tconst mode = url.searchParams.get("mode");\n';
      if (!text.includes(before)) {
        die('资源地址补丁：subagent 的 parseSubagentChatAddress() 实现已变化（未找到待替换片段），拒绝静默跳过');
      }
      const after = '\t\t\t/*\n'
        + '\t\t\t * 【DSHM 鸿蒙补丁 DSHM_RESOURCE_ARMOR_SUBAGENT】ArkWeb 下 `dsh-resource://subagentchat/...` 的\n'
        + '\t\t\t * hostname === ""（判定直接失败），且 query 可能被并进 path ⇒ searchParams 取不到\n'
        + '\t\t\t * parent / mode。这里用正则从原始地址取回 authority / path / query，再走原有判定与白名单。\n'
        + '\t\t\t */\n'
        + '\t\t\tconst armor = url.hostname === "" ? /^[a-z][a-z\\d+.-]*:\\/\\/([^/?#]*)([^?#]*)(\\?[^#]*)?/iu.exec(value) : null;\n'
        + '\t\t\tconst host = armor === null ? url.hostname : armor[1];\n'
        + '\t\t\tconst pathname = armor === null ? url.pathname : armor[2];\n'
        + '\t\t\tconst query = armor === null ? url.search : armor[3] === void 0 ? "" : armor[3];\n'
        + '\t\t\tif (url.protocol !== "dsh-resource:" || host.toLowerCase() !== "subagentchat") return void 0;\n'
        + '\t\t\tconst parts = pathname.split("/").filter(Boolean);\n'
        + '\t\t\tif (parts.length !== 2 || parts[0] !== "session") return void 0;\n'
        + '\t\t\tconst searchParams = new URLSearchParams(query);\n'
        + '\t\t\tconst parentSessionId = searchParams.get("parent");\n'
        + '\t\t\tconst mode = searchParams.get("mode");\n';
      text = text.replace(before, after);
      writeFileSync(target, text, 'utf8');
      log('[pack-core]   资源地址补丁：subagent parseSubagentChatAddress() 加 opaque-URL 兜底');
    }
  }
}

/*
 * 【N4 侧栏页签 id 泄漏】`SidebarRightTabRegistry.register()` 的取号不是原子的。
 *
 * 上游实现：
 *     const dispose = this.ctx.effect(() => {
 *       this.ids.add(id);                  // ← 取号
 *       const slot = this.enter(kind, entry);
 *       this.refresh();
 *       return () => { this.ids.delete(id); … };
 *     }, …);
 *
 * cordis 的 `effect()` 只在 **setup 成功返回**后才把清理函数收进 disposables
 * （`@deepseek-ai/cordis/lib/index.js:1249-1263`：`try { task = this._execute(runner) }`
 * 抛错分支只做 `finalizeDisposal(dispose)`，也就是"已经收集到的"清理项）。因此
 * `this.ids.add(id)` 之后、那个 `return () => {…}` 之前若发生异常（`enter()` 或
 * `refresh()` → `notifySubscribers()` 里任一订阅者抛），**id 就永久留在 `this.ids`
 * 里**，且没有任何 disposer 能再释放它。
 *
 * 后果正好是 N4：`dsh-better-sidebar` 每次 sync 都用同一 id 重试接管 `files`
 * 页签，于是恒抛 `sidebarRight: tab type id "…" is already registered`，页签再也
 * 立不起来，文件树落到宿主空态；只有刷新整个页面才恢复。（该插件 `sync()` 的
 * 清理循环显式跳过 `FILES_KIND`，所以它自己永远不会清掉这条失败记录。）
 *
 * 修法：把"取号 + 入座 + 通知"做成**原子**——任一步抛错就按原样退回。这样重试
 * 永远是干净的，页签最坏也只是晚一帧立起来，不会永久占死。
 * （与 TODO §N4 修复建议③「平台侧＝对 slot id 做一次强制释放/重注册」同向，
 *   但更小：只在异常路径上回滚，不改变成功路径的任何语义。）
 */
function patchSidebarTabIdLeak() {
  const target = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar-right', 'lib', 'client.js');
  if (!existsSync(target)) die(`侧栏页签守卫补丁：找不到 ${target}`);
  let text = readFileSync(target, 'utf8');
  if (text.includes('DSHM_TAB_ID_GUARD')) {
    log('[pack-core]   侧栏页签守卫补丁（sidebarRight.tabs.register 取号回滚）已存在（跳过）');
    return;
  }
  const before = '\t\t\t\tconst dispose = this.ctx.effect(() => {\n'
    + '\t\t\t\t\tthis.ids.add(id);\n'
    + '\t\t\t\t\tconst slot = this.enter(kind, entry);\n'
    + '\t\t\t\t\tthis.refresh();\n'
    + '\t\t\t\t\treturn () => {\n';
  if (!text.includes(before)) {
    die('侧栏页签守卫补丁：sidebar-right 的 register() 实现已变化（未找到待替换片段），拒绝静默跳过');
  }
  const after = '\t\t\t\tconst dispose = this.ctx.effect(() => {\n'
    + '\t\t\t\t\t/* DSHM_TAB_ID_GUARD：取号与入座必须原子，否则异常路径会把 id 永久占死 */\n'
    + '\t\t\t\t\tthis.ids.add(id);\n'
    + '\t\t\t\t\tlet slot;\n'
    + '\t\t\t\t\ttry {\n'
    + '\t\t\t\t\t\tslot = this.enter(kind, entry);\n'
    + '\t\t\t\t\t\tthis.refresh();\n'
    + '\t\t\t\t\t} catch (reason) {\n'
    + '\t\t\t\t\t\tthis.ids.delete(id);\n'
    + '\t\t\t\t\t\tif (slot !== void 0) this.leave(kind, slot, entry);\n'
    + '\t\t\t\t\t\tthrow reason;\n'
    + '\t\t\t\t\t}\n'
    + '\t\t\t\t\treturn () => {\n';
  text = text.replace(before, after);
  writeFileSync(target, text, 'utf8');
  log('[pack-core]   侧栏页签守卫补丁：sidebarRight.tabs.register() 取号失败回滚');
}

function patchPdfMapCompat() {
  const target = join(
    STAGE, 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar-documentpreview', 'lib', 'client.pdf.js',
  );
  if (!existsSync(target)) die(`pdf 兼容补丁：找不到 ${target}`);
  let text = readFileSync(target, 'utf8');
  if (text.includes('DSHM_MAP_COMPAT')) {
    log('[pack-core]   pdf 兼容补丁已存在（跳过）');
    return;
  }

  // ① 主线程：chunk 工厂开头装一次（该 chunk 是懒加载，装在这里就不受注入时机影响）。
  const factoryAnchor = 'factory: (require) => {';
  if ((text.split(factoryAnchor).length - 1) !== 1) {
    die('pdf 兼容补丁：chunk 工厂入口不唯一（未找到 factory 行），拒绝静默跳过');
  }
  const indented = MAP_COMPAT_SOURCE.replace(/\n+$/, '')
    .split('\n').map((line) => (line === '' ? line : '\t\t' + line)).join('\n');
  text = text.replace(factoryAnchor, factoryAnchor + '\n' + indented);

  // ② pdf worker：worker 由 Blob URL 起，独立 realm，不继承页面/主线程的原型补丁 ⇒
  //    在 Blob 分片数组**最前面**插一段同样源码的字符串字面量（JSON.stringify 保证转义正确）。
  const blobAnchor = 'new Blob([_dsh_pdf_worker_default, ';
  if ((text.split(blobAnchor).length - 1) !== 1) {
    die('pdf 兼容补丁：内联 pdf worker 的 Blob 构造不唯一（未找到待替换片段），拒绝静默跳过');
  }
  text = text.replace(
    blobAnchor,
    'new Blob([' + JSON.stringify(MAP_COMPAT_SOURCE) + ', _dsh_pdf_worker_default, ',
  );

  writeFileSync(target, text, 'utf8');
  log('[pack-core]   pdf 兼容补丁：Map/WeakMap.getOrInsert(Computed) 缺失兜底（主线程 + 内联 worker 各一处）');
}

function patchSubprocessOpenharmony() {
  const dir = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-subprocess-local', 'lib');

  // ① 终端巡检器的平台判定（真机报错原文：terminal inspection is unsupported on platform openharmony）。
  const runners = existsSync(dir) ? readdirSync(dir).filter((n) => /^runner-launch-.*\.js$/.test(n)) : [];
  if (runners.length === 0) die(`subprocess-local 补丁：在 ${dir} 找不到 runner-launch-*.js`);
  for (const name of runners) {
    const target = join(dir, name);
    let text = readFileSync(target, 'utf8');
    if (text.includes('DSHM_OPENHARMONY_SUBPROCESS')) {
      log(`[pack-core]   subprocess-local 补丁（${name}）已存在（跳过）`);
      continue;
    }
    const before = '\tif (platform === "linux") return new LinuxProcessInspector(arch, internals);';
    if (!text.includes(before)) {
      die(`subprocess-local 补丁：${name} 的 createProcessInspector() 实现已变化（未找到待替换片段），拒绝静默跳过`);
    }
    const after = '\tif (platform === "linux" || platform === "openharmony" /* DSHM_OPENHARMONY_SUBPROCESS */) return new LinuxProcessInspector(arch, internals);';
    writeFileSync(target, text.replace(before, after), 'utf8');
    log(`[pack-core]   subprocess-local 补丁：${name} 的终端巡检器接受 openharmony（复用 LinuxProcessInspector）`);
  }

  // ②③ index.js：关掉鸿蒙上的 shellActivity 注入 + idle 分支接受 openharmony。
  const indexTarget = join(dir, 'index.js');
  if (!existsSync(indexTarget)) die(`subprocess-local 补丁：找不到 ${indexTarget}`);
  let text = readFileSync(indexTarget, 'utf8');
  if (text.includes('DSHM_OPENHARMONY_SUBPROCESS')) {
    log('[pack-core]   subprocess-local 补丁（index.js）已存在（跳过）');
    return;
  }
  const activityBefore = '\tif (spec.shellActivity !== true || platform === "win32" || spec.argv.length !== 2 || spec.argv[1] !== "-i") return void 0;';
  if (!text.includes(activityBefore)) {
    die('subprocess-local 补丁：prepareShellActivity() 首行已变化（未找到待替换片段），拒绝静默跳过');
  }
  text = text.replace(
    activityBefore,
    '\tif (spec.shellActivity !== true || platform === "win32" || platform === "openharmony" /* DSHM_OPENHARMONY_SUBPROCESS */ || spec.argv.length !== 2 || spec.argv[1] !== "-i") return void 0;',
  );
  const idleBefore = 'this.platform === "linux" && observed.complete === true && root === void 0';
  if (!text.includes(idleBefore)) {
    die('subprocess-local 补丁：inspectActivity() 的 linux 分支已变化（未找到待替换片段），拒绝静默跳过');
  }
  text = text.replace(
    idleBefore,
    '(this.platform === "linux" || this.platform === "openharmony") /* DSHM_OPENHARMONY_SUBPROCESS */ && observed.complete === true && root === void 0',
  );
  writeFileSync(indexTarget, text, 'utf8');
  log('[pack-core]   subprocess-local 补丁：index.js 跳过鸿蒙的 shellActivity 注入 + idle 分支接受 openharmony');
}

function embedTreeInfo() {
  // 插件与原生模块清单：**在构建期算一次**，写进树里给端侧读。
  // 【为什么不在端侧现算】端侧要算同一件事，得在 27250 个文件 / 4000 个目录上递归
  // （实测规模），那是一秒级的目录遍历 + 一堆错误分支，纯风险。而这件事的答案在**打包这一刻
  // 就已经确定**，且能在一台能跑 Node 的机器上核对。端侧只需读一个小 JSON。
  // 【判据】见 tools/lib/core-inventory.mjs 头注释：看依赖闭包，不看包内有没有 .node。
  const inv = inventoryOf(join(STAGE, 'node_modules'));
  const info = {
    coreVersion: recipe.coreVersion,
    platform: `${recipe.platform.os}/${recipe.platform.cpu}`,
    profile: recipe.profile,
    builtAt: new Date().toISOString(),
    // dsh 的两条硬约束的交集：OHOS 支持 >= 22.17.0，会话持久化 zstd 需要 >= 22.15
    nodeFloor: '22.17.0',
    overrides: recipe.overrides,
    producer: 'tools/pack-core.mjs',
    // 端侧插件页的数据源。nativeKind ∈ PURE_JS | NATIVE | UNKNOWN
    // （NATIVE＝依赖闭包内含 .node，**不能**运行时安装，只能随应用发版）
    plugins: inv.plugins,
    pluginTotals: inv.totals,
    nativePackages: inv.nativePackages,
  };
  writeFileSync(join(STAGE, TREE_INFO_FILE), JSON.stringify(info, null, 2) + '\n', 'utf8');
  log(`[pack-core]   树内元数据 ${TREE_INFO_FILE} 已写入（端侧解包后据此识别版本、profile 与插件清单）`);
  log(
    `[pack-core]   插件 ${inv.totals.pluginRows} 行：纯 JS ${inv.totals.pureJs} / 依赖原生 ${inv.totals.native}` +
      ` / 待确认 ${inv.totals.unknown}（默认禁用 ${inv.totals.disabled}）；含原生模块的包 ${inv.nativePackages.length} 个`,
  );
  if (inv.totals.unknown > 0) {
    log(`[pack-core]   ⚠ 有 ${inv.totals.unknown} 行无法判定可安装性——端侧会显示为「待确认」，请查 core-inventory 的解析`);
  }
  return inv;
}
const TREE_INFO_FILE = 'dshm-core.json';

/**
 * 把写好的树内清单**读回来**逐字段核对，不符就让打包失败。
 *
 * 【为什么值得一个硬断言】这份 JSON 的消费者是 ArkTS 侧的 `CoreStore.readTreeInfo()`
 * （`hostruntime/src/main/ets/core/CoreStore.ets`），它按字段名逐个取。
 * 两端都是字符串键：**任何一侧改名都不会报错**，只会静默退化成"读不到清单"，
 * 于是核心页永远显示"未读取到插件清单"，而没有任何一处会告诉你是拼写问题。
 * 所以这里把契约钉在唯一的产出口上：字段名/类型不对就不许出厂。
 */
function verifyTreeInfoContract() {
  const p = join(STAGE, TREE_INFO_FILE);
  let raw;
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    die(`树内清单不可解析：${p}（${e.message}）`);
  }
  const wantString = ['coreVersion', 'platform', 'profile', 'builtAt', 'nodeFloor'];
  for (const k of wantString) {
    if (typeof raw[k] !== 'string') die(`树内清单字段 ${k} 不是字符串（端侧按字符串读）`);
  }
  if (!Array.isArray(raw.plugins)) die('树内清单缺少 plugins 数组（端侧插件页的数据源）');
  if (!Array.isArray(raw.nativePackages)) die('树内清单缺少 nativePackages 数组');
  const t = raw.pluginTotals;
  if (t === null || typeof t !== 'object') die('树内清单缺少 pluginTotals 对象');
  for (const k of ['pluginRows', 'pureJs', 'native', 'unknown', 'disabled']) {
    if (typeof t[k] !== 'number') die(`pluginTotals.${k} 不是数字`);
  }
  for (const [i, r] of raw.plugins.entries()) {
    for (const k of ['id', 'name', 'bundle', 'nativeKind']) {
      if (typeof r[k] !== 'string') die(`plugins[${i}].${k} 不是字符串`);
    }
    if (typeof r.disabled !== 'boolean') die(`plugins[${i}].disabled 不是布尔`);
    if (!Array.isArray(r.nativeVia)) die(`plugins[${i}].nativeVia 不是数组`);
  }
  if (t.pluginRows !== raw.plugins.length) {
    die(`pluginTotals.pluginRows=${t.pluginRows} 与 plugins 长度 ${raw.plugins.length} 不一致`);
  }
  log(`[pack-core]   树内清单契约核对通过（端侧 CoreStore.readTreeInfo 按这些字段读）`);
}

function sha256(file) {
  const h = createHash('sha256');
  h.update(readFileSync(file));
  return h.digest('hex');
}

// ── 最小 ZIP 写入器（deflate，无 zip64）───────────────────────────────────
// 为什么是 zip 而不是 tar.gz：**鸿蒙侧只有 zip 解压 API**（`@ohos.zlib.decompressFile`），
// 没有 tar/gzip 的等价物。用 tar.gz 就得在 ArkTS 里手写 tar 解析 + gzip 解压，
// 那是纯粹的额外风险与代码量；用 zip 则端侧只调一个系统 API。
// 规模核对：25000 余条目 < 65535，解包约 120 MB < 4 GB ⇒ 不需要 zip64。
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// 固定时间戳 ⇒ 同一份输入产出逐字节相同的包，便于比对与审计
const DOS_TIME = (12 << 11);
const DOS_DATE = (((2026 - 1980) << 9) | (1 << 5) | 1);

function writeZip(zipPath, baseDir, topName) {
  const fd = openSync(zipPath, 'w');
  const central = [];
  let offset = 0;
  let count = 0;
  let rawBytes = 0;
  let compBytes = 0;

  const put = (buf) => { writeSync(fd, buf); offset += buf.length; };

  const localHeader = (name, method, crc, comp, uncomp) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);          // version needed
    h.writeUInt16LE(0, 6);           // flags
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(DOS_TIME, 10);
    h.writeUInt16LE(DOS_DATE, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(comp, 18);
    h.writeUInt32LE(uncomp, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(0, 28);          // extra len
    return Buffer.concat([h, nameBuf]);
  };

  const addEntry = (name, data, isDir) => {
    const comp = isDir ? Buffer.alloc(0) : deflateRawSync(data, { level: 6 });
    const crc = isDir ? 0 : crc32(data);
    const uncomp = isDir ? 0 : data.length;
    const method = isDir ? 0 : 8;
    if (!isDir) {
      rawBytes += uncomp;
      compBytes += comp.length;
    }
    const start = offset;
    put(localHeader(name, method, crc, comp.length, uncomp));
    if (!isDir) put(comp);
    central.push({
      name, method, crc, comp: comp.length, uncomp, offset: start,
      external: isDir ? 0x10 : 0,
    });
    count++;
  };

  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        addEntry(`${topName}/${r}/`, Buffer.alloc(0), true);
        walk(full, r);
      } else if (e.isFile()) {
        addEntry(`${topName}/${r}`, readFileSync(full), false);
      }
    }
  };

  // 顶层目录自身的条目
  addEntry(`${topName}/`, Buffer.alloc(0), true);
  walk(baseDir, '');

  const cdStart = offset;
  for (const c of central) {
    const nameBuf = Buffer.from(c.name, 'utf8');
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4);          // version made by
    h.writeUInt16LE(20, 6);          // version needed
    h.writeUInt16LE(0, 8);
    h.writeUInt16LE(c.method, 10);
    h.writeUInt16LE(DOS_TIME, 12);
    h.writeUInt16LE(DOS_DATE, 14);
    h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(c.comp, 20);
    h.writeUInt32LE(c.uncomp, 24);
    h.writeUInt16LE(nameBuf.length, 28);
    h.writeUInt16LE(0, 30);          // extra
    h.writeUInt16LE(0, 32);          // comment
    h.writeUInt16LE(0, 34);          // disk
    h.writeUInt16LE(0, 36);          // internal attrs
    h.writeUInt32LE(c.external, 38);
    h.writeUInt32LE(c.offset, 42);
    put(Buffer.concat([h, nameBuf]));
  }
  const cdSize = offset - cdStart;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  put(eocd);

  closeSync(fd);
  return { count, rawBytes, compBytes, bytes: offset };
}

function pack() {
  log('\n[pack-core] ⑤ 打包（zip：鸿蒙侧只有 @ohos.zlib.decompressFile 可用）');
  mkdirSync(OUT_DIR, { recursive: true });
  const base = `${STAGE_NAME}-${recipe.platform.os}-${recipe.platform.cpu}`;
  const zipPath = join(OUT_DIR, `${base}.zip`);
  const z = writeZip(zipPath, STAGE, STAGE_NAME);
  log(`[pack-core]   ${zipPath}`);
  log(`[pack-core]   ${z.count} 条目 / 原始 ${(z.rawBytes / 1048576).toFixed(1)} MB → `
    + `压缩后 ${(z.compBytes / 1048576).toFixed(1)} MB / 整包 ${(z.bytes / 1048576).toFixed(1)} MB`);

  let tarPath = null;
  if (process.argv.includes('--also-tar')) {
    const tar = which('tar');
    if (tar) {
      // 相对文件名 + --force-local：Git 的 tar 会把 "D:\..." 当成远程主机（实测踩过）
      const name = `${base}.tar.gz`;
      const r = spawnSync(tar, ['-czf', name, '--force-local', '--format=ustar', '-C', WORK_ROOT, STAGE_NAME],
        { stdio: 'inherit', cwd: OUT_DIR });
      if (r.status === 0) { tarPath = join(OUT_DIR, name); log(`[pack-core]   另存 ${name}`); }
      else log('[pack-core]   ⚠ tar 失败（非致命，zip 已产出）');
    }
  }

  // 随应用分发：放进 entry 的 resfile（**不是 rawfile**，见 hostruntime/core/BundledCore.ets 的说明：
  // resfile 安装后解压到沙箱、可按真实路径只读访问；rawfile 的 fd 不是文件系统 fd，copyFile 会拷坏）
  if (process.argv.includes('--place-in-app')) {
    const resDir = join(ROOT, 'entry', 'src', 'main', 'resources', 'resfile');
    mkdirSync(resDir, { recursive: true });
    const dest = join(resDir, `${base}.zip`);
    cpSync(zipPath, dest, { force: true });
    log(`[pack-core]   已放入应用内置资源：entry/src/main/resources/resfile/${base}.zip`);
    log('[pack-core]   注意：该文件已在 .gitignore 中（体积大，不进版本库）');
  }

  return { zipPath, bytes: z.bytes, entries: z.count, tarPath };
}

function writeManifest(extra) {
  const nm = join(STAGE, 'node_modules');
  let fileCount = 0;
  for (const f of listFilesRecursive(nm)) { void f; fileCount++; }
  const corePkg = JSON.parse(readFileSync(join(nm, '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
  const manifest = {
    generatedAt: new Date().toISOString(),
    recipe: RECIPE_PATH.slice(ROOT.length + 1).split(sep).join('/'),
    coreVersion: recipe.coreVersion,
    coreVersionInstalled: corePkg.version,
    platform: recipe.platform,
    overrides: recipe.overrides,
    profile: recipe.profile,
    nodeModules: {
      fileCount,
      unpackedBytes: dirSize(nm),
    },
    package: extra.zipPath ? {
      format: 'zip',
      file: extra.zipPath.slice(ROOT.length + 1).split(sep).join('/'),
      bytes: extra.bytes,
      entries: extra.entries,
      sha256: sha256(extra.zipPath),
      topDir: STAGE_NAME,
      extractWith: '@ohos.zlib.decompressFile',
    } : null,
    tarGz: extra.tarPath ? {
      file: extra.tarPath.slice(ROOT.length + 1).split(sep).join('/'),
      sha256: sha256(extra.tarPath),
    } : null,
    native: {
      signed: extra.signed ?? [],
      unsigned: extra.unsigned ?? [],
      signatureCheckSkipped: extra.skipped ?? false,
      // 【报告 3 ③】构建期自签名（selfSign）的执行情况，如实记录：
      // attempted=本次尝试签的数量，signed=成功数，skipped=工具缺失未尝试。
      selfSign: extra.selfSign ?? null,
    },
  };
  const manifestPath = join(OUT_DIR, `${STAGE_NAME}.manifest.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  log(`[pack-core] 清单 ${manifestPath}`);
  return manifest;
}

// ── 主流程 ──────────────────────────────────────────────────────────────
log(`[pack-core] 配方 ${RECIPE_PATH}`);
log(`[pack-core] 核心 ${recipe.coreVersion} @ ${recipe.platform.os}/${recipe.platform.cpu}`);
log(`[pack-core] 宿主 Node ${process.version} / ${process.platform}`);

materialize();
prune();
replaceKoffiJs();
const sig = verify();
addPlatformAliases();
allowOriginList();
wrapSharp();
addSystemAddonPackage();
patchLinkForSandbox();
patchCredentialsOwnerCheck();
patchAppBootReadonlyStack();
patchAgentPresetWorkflow();
patchFsLocalLink();
patchAttachmentLocalLink();
/*
 * 【⑤ 鸿蒙前端/平台兼容补丁】对应 GitCode issue #1（侧边栏资源预览不可用、PDF 预览
 * 报错）与 #2（侧边栏终端 openharmony 被判为不支持），以及 N4（侧栏 files 页签被
 * 占位、文件树空态）。四个都只改前端 bundle 与 subprocess-local 的 `.js`，**不含原生
 * 二进制**，因此与下面的自签名顺序无关；放在这里是为了与其它 patch 函数聚在一起
 * （自签名仍必须紧邻 pack() 之前，见下方注释）。
 * 找不到待替换片段会 die，不会静默跳过 —— 上游升级后这里会立刻暴露，而不是悄悄失效。
 */
patchResourceAddressArmor();
patchPdfMapCompat();
patchSubprocessOpenharmony();
patchSidebarTabIdLeak();
ensureRipgrepPlatformPackage();
patchFsSearchFallback();
addOnDevicePreset();
/*
 * 【顺序：先落树，再写树内清单】注意**不要把这两步的因果说反**。
 * `dshm-core.json` 的 plugins 数组由 `inventoryOf(node_modules)` 现算，而
 * `inventoryOf` → `pluginRowsOf()` **只扫** `BUNDLES = ['@deepseek-ai/dsh-base',
 * '@deepseek-ai/dsh-web-app']` 两个 bundle 的 `dsh.bundle.patch` 行
 * （`tools/lib/core-inventory.mjs:24` 与 `:201-238`），**不扫 profile 的
 * `cordis.patch.yml`**。本插件的行在 profile（`hostcore/profile/ondevice/cordis.patch.yml`
 * 的 `insert:`）里 ⇒ 它**能加载**，但**不会**因为"落到树上"而出现在 `dshm-core.json`
 * 的 plugins 数组里 —— "要出现在端侧'插件'页就必须先落到树上"这条因果**不成立**。
 * 先落树仍然必要：loader 要能按包名解析到它（`dsh-web-app` 的 dependencies 里也由
 * 本步声明）；只是这与 plugins 数组无关。
 */
embedDshmToolPackages();
embedTreeInfo();
verifyTreeInfoContract();
patchSensevoiceForHms();
patchVoiceInputNoiseSuppression();
patchVoiceInputNativeCapture();
embedProfile();
/*
 * 【报告 3 ③】构建期自签名**必须放在最后、pack() 之前**。
 * 踩过的坑：最初放在 replaceKoffiJs() 之后，结果签名被后续的
 * `ensureRipgrepPlatformPackage()`（它会把 rg 重新拷进树）覆盖掉——磁盘上的 rg
 * 又变回未签名。签名对象是"最终要进 zip 的字节"，所以任何会重写这些文件的步骤
 * 都必须排在它前面。放在这里同时保证 verify() 的结果不受影响（verify 只做校验，
 * 其 unsigned 清单本来就是"构建期未签"的如实记录，不因自签名而改变）。
 */
const selfSign = selfSignNatives();
/*
 * 【打包前的最后一道回归锁】`embedDshmToolPackages()` 末尾已断言过一次；这里在
 * `pack()` 之前**再断言一次**，锁的是"即将被 zip 读走的那棵树"。中间的
 * embedProfile / selfSignNatives 都不碰 `@deepseek-ai/dshm-*`，重跑是为了让
 * "产物集合 == 清单"这件事由打包点自己负责，而不是依赖上游步骤的既有行为。
 */
assertDshmBelongingsConsistent();
const packed = pack();
const manifest = writeManifest({ ...packed, ...sig, selfSign });

log('\n[pack-core] ✓ 完成');
log(`  核心版本   ${manifest.coreVersionInstalled}`);
log(`  解包体积   ${(manifest.nodeModules.unpackedBytes / 1048576).toFixed(1)} MB / ${manifest.nodeModules.fileCount} 文件`);
log(`  分发包     ${manifest.package.file}  ${(manifest.package.bytes / 1048576).toFixed(1)} MB / ${manifest.package.entries} 条目`);
log(`  sha256     ${manifest.package.sha256}`);
log(`  签名       ${manifest.native.signatureCheckSkipped ? '未校验' : `${manifest.native.signed.length} 通过 / ${manifest.native.unsigned.length} 未检出`}`);
