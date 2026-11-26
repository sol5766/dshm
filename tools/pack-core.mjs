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
import { patchManagerLifecycle } from './lib/manager-lifecycle.mjs';
import { prepareZodLocales } from './lib/zod-locales.mjs';
import { isBundledZodBenchmarks, prepareZodFactories } from './lib/zod-factories-startup.mjs';
import { bundledDevelopmentFiles, bundledEmptyDevelopmentDirectories } from './lib/bundled-development-files.mjs';
import { deferPluginSubprocessImports } from './lib/plugin-startup.mjs';
import { patchRuntimeScopeStartup } from './lib/runtime-scope-startup.mjs';
import { deferProfilePluginImports } from './lib/profile-plugin-startup.mjs';
import { patchCredentialsLocalStartup } from './lib/credentials-local-startup.mjs';
import { useScheduleOutputPrecompile } from './lib/schedule-tool-startup.mjs';
import { patchHmrObserveStartup } from './lib/hmr-observe-startup.mjs';
import { patchHmrStartupSnapshot } from './lib/hmr-startup-snapshot.mjs';
import { patchWorkbenchStartupMode } from './lib/workbench-startup-mode.mjs';
import { patchWorkbenchStartup } from './lib/workbench-startup.mjs';
import { patchSettingsStartup } from './lib/settings-startup.mjs';
import { patchSettingsController } from './lib/settings-controller.mjs';
import { patchCordisStartup } from './lib/cordis-startup.mjs';
import { patchPostStartupImports } from './lib/post-startup-imports.mjs';
import { patchOpenInAppReveal } from './lib/open-in-app-reveal.mjs';
/*
 * 【语法检查子进程的启动标志（2026-10-31）】检测用的 `node --check` 是**子进程**，
 * 不继承父进程的 `--jitless`。而本机（HarmonyOS 端侧）内核拒绝 JIT 所需的
 * `mmap(RWX)`/`mprotect(RX)` ⇒ V8 默认启动直接 `Fatal error ... 12 == (*__errno_location())`
 * （12 = ENOMEM），于是**语法校验全部假红**，报错内容还是 V8 崩溃文本，极易被误判为
 * "补丁注入坏了"（2026-10-31 实测就误判过一次）。这里统一带上 --jitless；
 * `--check` 只做解析、不需要 JIT，结果与带 JIT 时逐字一致。
 */
const SYNTAX_CHECK_FLAGS = ['--jitless'];
import { createHash } from 'node:crypto';
import {
  closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
  unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { deflateRawSync } from 'node:zlib';

/**
 * 可复现的构建时刻（docs/334）。
 *
 * `SOURCE_DATE_EPOCH` 优先（[reproducible-builds.org](https://reproducible-builds.org/docs/source-date-epoch/) 的标准做法），
 * 否则取 `hostcore/core-recipe.json` 的 mtime —— 配方随核心版本变化，
 * 因此"同一配方 ⇒ 同一时刻 ⇒ 同一分发包 sha256"。
 */
function reproducibleStamp() {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (typeof epoch === 'string' && /^\d+$/.test(epoch)) {
    return new Date(Number(epoch) * 1000).toISOString();
  }
  try {
    return new Date(statSync('hostcore/core-recipe.json').mtimeMs).toISOString();
  } catch {
    /* 配方读不到时退回打包时刻并如实标注，不假装可复现 */
    return new Date().toISOString();
  }
}
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryOf } from './lib/core-inventory.mjs';
import { devecoPath, devecoSdkHomeCandidates } from './lib/deveco-home.mjs';

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
/*
 * `--place-in-app`：把本次产出的核心容器**拷进 entry 的 resfile**。
 *
 * 【为什么必须有它】AGENTS.md「出包与核心树的三个坑」第 1 条：只跑裸 pack-core 时
 * 新包留在 `dist/core/`，HAP 里带的还是**旧容器** ⇒ 所有核心侧改动全部不生效，
 * 而链上自检只看设备树目录名，一路绿灯。
 *
 * 【为什么这次要补回来】docs/334 复核时发现本仓库的 `pack-core.mjs` **根本没有这个开关**
 * （`--place-in-app` 传了也被静默忽略），于是 resfile 里的容器一直是上一次
 * `assembleApp` 留下的旧文件 —— `check-resfile-core-zip` 会如实判红
 * （"安装包里带的不是你刚打的树"），这正是它的价值。
 *
 * 【只增不删 → 由本函数自己清理】resfile 只允许 1 份容器（多份会把 HAP 顶到 491 MiB）。
 */
const PLACE_IN_APP = process.argv.includes('--place-in-app');
/*
 * 【目标目录是 **hostruntime** 的 resfile，不是 entry 的】
 *
 * 实测（docs/334）：先按 entry 放置 ⇒ `entry-default.hap` 从 66 MB 涨到 **161 MB**
 * （整个 .app 507 MB → 607 MB）。因为核心容器由**共享 HSP `hostruntime`** 承载，
 * entry / phone 两个 HAP 都不该带它。放在 entry 等于凭空多打包 95 MB，
 * 而 hostruntime 里那份才是运行时真正读的。
 */
const RESFILE_DIR = resolve(ROOT, 'hostruntime/src/main/resources/resfile');
const FORCE_INSTALL = process.argv.includes("--force-install");

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
  // 【2026-10-10 改】不再写死安装根：DevEco 从 `C:\Program Files\Huawei\DevEco Studio` 搬到
  // `D:\Program Files\Huawei\DevEco Studio` 之后，写死路径的脚本整片失效。解析口见
  // tools/lib/deveco-home.mjs（`DEVECO_SDK_HOME` / `OHOS_SDK_HOME` → `<DevEco 安装根>/sdk`）。
  const sdkHomes = devecoSdkHomeCandidates().filter(Boolean);
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

/**
 * 复用上一代核心树的 `package-lock.json`（让**依赖闭包可复现**）。
 *
 * 【为什么需要（2026-10-16 实测）】新鲜 STAGE 没有锁 ⇒ `npm install` 按 ranges 取"当时最新"：
 * 同一份 recipe、隔一天重跑，`@earendil-works/pi-ai` / `pi-telemetry` 就从 1.2.0 漂到 1.3.0
 * （两者差 1 个文件：1.3.0 不再导出 `utils/assistant-message-frame.js`）。闭包变化没人评审、
 * 也没跑过门禁，却直接进了产物 —— 这就是"两次出包内容不一样"的来源，且与 `docs/131` 那种
 * "闭包 +15/−6 逐条登记"的纪律相悖。
 * 做法：本版 STAGE 没有锁时，从**其它 `dsh-core-*` 目录**里取**最新**的一份锁拷进来，
 * `npm install` 以它为准（只解析真正不满足的边）⇒ 闭包默认稳定；升级某个依赖是一个**显式动作**
 * （更新那份锁 / 改 recipe），不再是 rebuild 的副作用。
 * 首次使用（work 目录被清过）没有可复用的锁时只打印一行提示，按老行为由 npm 解析。
 */
function reusePreviousLockfile() {
  const lockPath = join(STAGE, 'package-lock.json');
  if (existsSync(lockPath)) {
    log('[pack-core]   闭包：本版已有 package-lock.json，按它解析');
    return;
  }
  if (!existsSync(WORK_ROOT)) return;
  const candidates = readdirSync(WORK_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('dsh-core-') && e.name !== STAGE_NAME)
    .map((e) => ({ name: e.name, lock: join(WORK_ROOT, e.name, 'package-lock.json') }))
    .filter((c) => existsSync(c.lock))
    .sort((a, b) => statSync(b.lock).mtimeMs - statSync(a.lock).mtimeMs);
  if (candidates.length === 0) {
    log('[pack-core]   ⚠ 没有可复用的 package-lock.json（首个版本或 work 目录被清过）'
      + '⇒ 本次依赖闭包由 npm 现场解析');
    return;
  }
  copyFileSync(candidates[0].lock, lockPath);
  log(`[pack-core]   闭包：复用 ${candidates[0].name} 的 package-lock.json`
    + '（依赖默认不漂；要升级依赖请显式更新这份锁）');
}

function materialize() {
  log(`\n[pack-core] ① 物化 ${STAGE_NAME} → ${STAGE}`);
  mkdirSync(STAGE, { recursive: true });
  writeBundlePackageJson();
  reusePreviousLockfile();
  /*
   * 【2026-10-29 修：复用暂存树前必须证明"它就是本配方的那一版"】
   *
   * 原写法是"只要 `node_modules/@deepseek-ai/dsh` 与 `package-lock.json` 都在就复用"，
   * 之后 `writeManifest()` 只把 `recipe.coreVersion` 与**实际安装版本**分别记进清单、
   * **不断言两者相等**。三条真实的踩坑路径都会经过这里：
   *   · 同版本目录被手工升过 `@deepseek-ai/dsh`（或系统把暂存树弄脏）；
   *   · 配方回退（`coreVersion` 降回旧值）而目录名相同；
   *   · `--work` 指到了别的树的目录。
   * 结果都是"旧核心被打上当前版本的标签出包"，而链上所有自检只看目录名，一路绿灯。
   *
   * 现在：复用之前先读 `@deepseek-ai/dsh/package.json` 的 version，与 `recipe.coreVersion`
   * 的**上游部分**严格相等才复用；不等就明确报错并给出 --force-install 的处置建议，
   * 绝不静默复用。这一条与 `assertStagedCoreVersion()`（打包前再断言一次）成对，
   * 见 `writeManifest` 调用点。
   */
  const stagedCorePkg = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  const canReuse = !FORCE_INSTALL && existsSync(stagedCorePkg) && existsSync(join(STAGE, 'package-lock.json'));
  if (canReuse) {
    let installed = '';
    try {
      installed = JSON.parse(readFileSync(stagedCorePkg, 'utf8')).version || '';
    } catch (e) {
      installed = '';
    }
    /*
     * 【2026-10-30 修：比较的是"上游版本"，不是"整串配方版本"】
     *
     * `recipe.coreVersion` 是 `0.2.1-rc.4+dshm.97` —— 其中 `+dshm.<n>` 是 semver 的
     * **build metadata**（AGENTS.md「coreVersion 命名口径」明写：不参与优先级比较，
     * 纯粹给人读、用来让端侧目录名一眼看出跑的是哪一版）。而 npm 装出来的
     * `@deepseek-ai/dsh` 的 version 是**上游版本号** `0.2.1-rc.4`，`+dshm.<n>` 根本
     * 不在包清单里。旧写法拿整串与它比 ⇒ 两者**永远不等** ⇒ 每个新目录第一次能装、
     * 第二次起一律 die（实测 2026-10-30：`+dshm.97` 复用直接被拒，本机再也出不了包）。
     *
     * 现在的判据：① 上游版本必须相等（防"旧核心被打上新版本标签"）；
     * ② 暂存树清单里记的 `coreVersion` 若与本配方**不同**，就重新物化（见下方 return 前）
     * —— 那正是"+dshm.98 的内容还套着 +dshm.97 的标签"这件事的判据。
     */
    const upstreamOf = (v) => String(v || '').split('+')[0];
    if (upstreamOf(installed) !== upstreamOf(recipe.coreVersion)) {
      die(`暂存核心的上游版本与本配方不一致：${STAGE} 里装的是 ${installed || '(读不到)'}，`
        + `配方要的是 ${recipe.coreVersion}。`
        + '拒绝复用（旧核心被打上新版本标签出包的根因，见本函数上方注释）。'
        + '处置：加 --force-install 重装闭包，或核对 --work 是否指错了目录');
    }
    let stagedLabel = '';
    try {
      stagedLabel = JSON.parse(readFileSync(join(STAGE, 'dshm-core.json'), 'utf8')).coreVersion || '';
    } catch (e) {
      stagedLabel = '';
    }
    if (stagedLabel === recipe.coreVersion) {
      log(`[pack-core]   reuse installed closure（${installed} = 上游版本；标签 ${stagedLabel} 与配方一致）`);
      return;
    }
    /*
     * 标签不同（例如配方从 +dshm.97 升到 +dshm.98）⇒ **包清单不需要重装**，
     * 但后面的插件放入 / profile 放入 / 补丁注入 / 清单重写**必须照常跑** ——
     * 这正是新版本内容进入产物的那几步。所以这里既不 return 也不走 npm install，
     * 直接落到"跳过安装"的出口。
     */
    log(`[pack-core]   暂存树标签是 ${stagedLabel || '(无清单)'}，配方是 ${recipe.coreVersion}`
      + ' ⇒ 包清单复用（不重装），后续插件/profile/补丁/清单照常重新生成');
    return;
  }
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
  /*
   * 【引号必须跟着 shell 一起用 —— 2026-10-28 再次修复（docs/258 §4.1 的老缺陷又在了）】
   *
   * 旧写法**无条件**给路径加双引号：
   *   const npmForShell = `"${npm}"`; spawnSync(npmForShell, …, { shell: process.platform === 'win32' })
   * Windows 上（shell:true）这是对的（`D:\Program Files\nodejs\npm.cmd` 不加引号会被拆词）；
   * 但 POSIX 上 `shell:false` ⇒ spawn 直接 exec，于是去找一个**名字里带双引号**的可执行文件
   * ⇒ ENOENT，`status` 为 `null`，报错只剩一行 `exit=null`，完全看不出是引号问题。
   * 实测后果：清掉 `dist/core/work/<ver>` 后**再也物化不出核心树**（2026-10-28 复现）。
   * 修法：引号与 `shell` 同进同退；并把 `r.error` 一并打进报错（`exit=null` 多半是没起来）。
   */
  const useShell = process.platform === 'win32';
  const npmForShell = useShell ? `"${npm.replace(/"/g, '\\"')}"` : npm;
  const r = spawnSync(npmForShell, args, { cwd: STAGE, stdio: 'inherit', shell: useShell });
  if (r.status !== 0) {
    const why = r.error ? ` error=${r.error.code || r.error.message}` : '';
    die(`npm install 失败（exit=${r.status}${why}）`);
  }
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
  // 【2026-10-07 修：链式 replace 会自我改写】
  // 旧实现第二步把 `**&#47;` 换成「点星加斜杠」的任意层前缀，第三步的 `*`→`[^/]*` 又把**刚注入的
  // 这个占位符**一起改掉 ⇒ 生成的正则只认**一层目录**（`a/b/c.d.ts` 匹配不到，`b/c.d.ts` 才行）。
  // 实测后果：`**&#47;*.d.ts` 只删到 128 / 7448 个，容器 zip 只小 0.77 MB（预期 −21 MB）；
  // 而日志里的「删除 xx MB」完全看不出异常 —— dirSize 只在循环前后各测一次，中间少删多少都自洽。
  // 同一条链上的 `**&#47;*.exe` / `*.dll` / `*.pdb` 也一直只删到顶层。
  // 改法：**单次 replace + 回调** —— 回调的返回值不再被扫描，占位符不会被二次改写。
  // 语义（够本脚本用）：`**&#47;` = 任意层目录前缀；其余 `**` = 跨目录任意串；`*` = 不跨目录。
  const rx = new RegExp('^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/|\*\*|\*/g, (m) => (m === '**/' ? '(?:.*/)?' : m === '**' ? '.*' : '[^/]*')) + '$');
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

/**
 * 裁剪时**永不删除**的文件名前缀（按 basename、大小写不敏感）。
 *
 * 【为什么必须有这张豁免表】`removeGlobs` 里的 `**&#47;*.md` 会连 `LICENSE.md` / `NOTICE.md` / `COPYING`
 * 一起删 —— 体积可以忽略，但**许可证与归属声明缺失是合规问题**，而这类文件对运行期毫无影响。
 * 取"前缀命中"是为了同时保住 `LICENSE`、`LICENSE-MIT`、`LICENSE.md`、`NOTICE.txt`、`COPYING`、
 * `AUTHORS`/`CONTRIBUTORS` 等常见命名；被删面本来就只有 `*.md` / `*.map` / 测试目录，
 * 因此这张表不会误伤任何被 require 的 JS。
 */
const PRUNE_KEEP_BASENAME_PREFIXES = [
  'license', 'licence', 'notice', 'copying', 'authors', 'contributors', 'thirdpartynotices',
];

/* rc.4 bowser exports ./README.md as a runtime entry; keep this single declared file. */
const PRUNE_KEEP_EXPORTS_README = new Set(['bowser/README.md']);

function prune() {
  const nm = join(STAGE, 'node_modules');
  const parentBundledCore = join(nm, '@deepseek-ai', 'dsh-base', 'node_modules', 'bowser');
  if (dirSize(parentBundledCore) > 100) {
    die(`裁剪前命中已打包的有重叠核心（${parentBundledCore}）；STAGE 不可复用，清掉后 --force-install 重建`);
  }
  log('\n[pack-core] ② 裁剪非鸿蒙二进制');
  let before = dirSize(nm);
  let removedBytes = 0;
  let removedCount = 0;
  let keptLicense = 0;
  let keptAsset = 0;
  /*
   * 【keepGlobs：运行期资源豁免，优先于所有 removeGlobs（2026-10-07 新增）】
   * 起因：`**&#47;*.md` 会连**被代码真正读取的资源**一起删 —— 实测 `@deepseek-ai/dsh-skill-badge`
   * 的 `assets/dsh-badge.md` 正是 `lib/index.js` 里 `new URL("../assets/dsh-badge.md", import.meta.url)`
   * + `readFile(...)` 的读取目标，删掉它 ⇒ 这个内置技能的 provider 直接抛错（"看起来是文档、
   * 实际是运行期资源"，光看扩展名分辨不出来）⇒ 用**目录级豁免**（`assets/` 是包内资源目录）。
   * 豁免表从配方的 `keepGlobs` 字段收集（可挂在任意规则上，收集时与规则顺序无关）。
   * 注意：`dir` 形式的规则（koffi / node-pty 的平台目录）是显式点名的删除，**不走**这张表。
   */
  const keepGlobs = (recipe.prune ?? []).flatMap((r) => r.keepGlobs ?? []);
  const isKept = (rel) => keepGlobs.some((g) => matchGlob(rel, g));

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
        // 运行期资源豁免（keepGlobs）优先：这类文件会被代码读，不是"随包文档"。
        if (isKept(rel)) {
          keptAsset++;
          continue;
        }
        // 许可证 / 归属声明一律保全（体积可忽略；删了是合规风险）——见 PRUNE_KEEP_BASENAME_PREFIXES。
        const base = f.slice(f.lastIndexOf(sep) + 1).toLowerCase();
        if (PRUNE_KEEP_BASENAME_PREFIXES.some((p) => base.startsWith(p))) {
          keptLicense++;
          continue;
        }
        const nmRel = rel.slice(rel.indexOf('node_modules/') + 'node_modules/'.length);
        if (PRUNE_KEEP_EXPORTS_README.has(nmRel)
          || PRUNE_KEEP_EXPORTS_README.has(nmRel.slice(nmRel.lastIndexOf('node_modules/') + 'node_modules/'.length))) {
          keptLicense++;
          continue;
        }
        removedBytes += statSync(f).size;
        removedCount++;
        rmSync(f, { force: true });
      }
      log(`[pack-core]   - ${pattern}  （${rule.why ?? ''}）`);
    }
  }
  const after = dirSize(nm);
  log(`[pack-core]   删除 ${removedCount} 项 / ${(removedBytes / 1048576).toFixed(1)} MB`
    + `（另有 ${keptLicense} 个许可证/归属声明、${keptAsset} 个 keepGlobs 运行期资源按豁免表保留）；`
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
      /*
       * 【原生工具优先（2026-11-05 补缺）】CLT 里自带的是**原生 ELF** `binary-sign-tool`
       * （2.9 MB，`-selfSign 1` 即可，无需 JDK）。旧代码只认 jar+java，本机没有 java ⇒
       * 每次都走"跳过签名"分支（日志：找不到 binary-sign-tool（或 JDK））。
       * 实测原生工具：`sign -inFile X -outFile Y -selfSign 1 -signAlg SHA256withECDSA`
       * 成功产出 `.codesign`，且签后的 nodecli 仍能按 argv[0] 分派（dsh/pnpm 实测可用）。
       */
      const args = tool.native !== undefined
        ? ['sign', '-inFile', f, '-outFile', tmp, '-selfSign', '1', '-signAlg', 'SHA256withECDSA']
        : ['-jar', tool.jar, 'sign', '-mode', 'localSign', '-selfSign', '1',
          '-inFile', f, '-outFile', tmp, '-signAlg', 'SHA256withECDSA'];
      execFileSync(tool.native !== undefined ? tool.native : tool.java, args,
        { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
      if (statSync(tmp).size <= 0) throw new Error('输出为空');
      copyFileSync(tmp, f);
      try { chmodSync(f, 0o755); } catch { /* 权限失败不影响签名 */ }
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

/**
 * 找自签名工具：**原生 ELF 优先**，其次 jar+java；都没有返回 null（签名是可选增量步骤）。
 *
 * 【为什么原生优先】本机（HarmonyOS PC / CLT）只有 `toolchains/lib/binary-sign-tool`
 * 这个原生 ELF，没有 jar、也没有 JDK（`command -v java` 为空）。旧实现只认 jar+java，
 * 于是每次构建都静默跳过签名，核心树里的 rg 等 ELF 在设备上永远 execve 被拒。
 */
function findBinarySignTool() {
  const nativeCandidates = devecoSdkHomeCandidates()
    .map((h) => join(h, 'default', 'openharmony', 'toolchains', 'lib', 'binary-sign-tool'))
    .filter((p) => existsSync(p));
  if (nativeCandidates.length > 0) {
    return { native: nativeCandidates[0] };
  }
  const javaCandidates = [
    process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : '',
    devecoPath(join('jbr', 'bin', process.platform === 'win32' ? 'java.exe' : 'java')),
  ].filter((p) => p !== null && p.length > 0 && existsSync(p));
  const jarCandidates = devecoSdkHomeCandidates()
    .map((h) => join(h, 'default', 'openharmony', 'toolchains', 'lib', 'binary-sign-tool.jar'))
    .filter((p) => existsSync(p));
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
  const MARK_VERSION = 'v4-capture-lifecycle';
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
  if (!/\bvar Recording\s*=\s*class/.test(text) && !/\bclass Recording\b/.test(text)) {
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
    '  const captureSessions = new WeakMap();',
    '  let activeCapture;',
    '  Recording.prototype.start = async function (onError) {',
    '    let cancel = function () {};',
    '    let signal;',
    '    let session;',
    '    let started = false;',
    '    try {',
    '      const b = br();',
    '      if (!b || typeof b.startNativeCapture !== \'function\') {',
    '        return await origStart.call(this, onError);',
    '      }',
    '      this.lifetime.signal.throwIfAborted();',
    '      if (activeCapture) { activeCapture.cancel(); }',
    '      const generation = b.startNativeCapture();',
    '      if (!generation) { throw new RecordingError("unavailable"); }',
    '      signal = this.lifetime.signal;',
    '      const owner = this;',
    '      cancel = function () {',
    '        signal.removeEventListener("abort", cancel);',
    '        if (captureSessions.get(owner) === session) { captureSessions.delete(owner); }',
    '        if (activeCapture === session) { activeCapture = undefined; }',
    '        try { b.cancelNativeCapture(generation); } catch (e) {}',
    '      };',
    '      session = { cancel };',
    '      captureSessions.set(this, session);',
    '      activeCapture = session;',
    '      signal.addEventListener("abort", cancel, { once: true });',
    '      const t0 = Date.now();',
    '      /* 等待窗口 15 秒：首次使用会弹系统麦克风授权框，',
    '       * 用户读完再点是**人的时间尺度**。原来的 3 秒会在用户还在看弹框时',
    '       * 就超时报 unavailable（现象：点一下没反应，再点才可能成功）。',
    '       * 授权只在首次发生，之后启动仍在百毫秒级返回。 */',
    '      while (Date.now() - t0 < 15000) {',
    '        signal.throwIfAborted();',
    '        if (activeCapture !== session) { throw new RecordingError("interrupted"); }',
    '        let st = \'\';',
    '        try { st = b.nativeCaptureState(); } catch (e) {}',
    '        if (st.indexOf(\'"phase":"recording"\') >= 0) { started = true; return; }',
    '        if (st.indexOf(\'"phase":"error\') >= 0) { throw new RecordingError("interrupted"); }',
    '        await new Promise(function (r) { setTimeout(r, 50); });',
    '      }',
    '      throw new RecordingError("unavailable");',
    '    } catch (err) {',
    '      cancel();',
    '      if (err instanceof RecordingError) { throw err; }',
    '      throw new RecordingError("unavailable");',
    '    } finally {',
    '      if (!started && signal) { signal.removeEventListener("abort", cancel); }',
    '    }',
    '  };',
    '  const origStop = Recording.prototype.stop;',
    '  Recording.prototype.stop = async function (maxDurationSeconds) {',
    '    const b = br();',
    '    if (!b || typeof b.takeNativeCapture !== \'function\') {',
    '      return await origStop.call(this, maxDurationSeconds);',
    '    }',
    '    const session = captureSessions.get(this);',
    '    if (!session || activeCapture !== session) { throw new RecordingError("empty"); }',
    '    let b64;',
    '    try { b64 = b.takeNativeCapture(); } finally { session.cancel(); }',
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
  const exitAnchor = text.includes('return module.exports;') ? 'return module.exports;' : 'return module.exports}';
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
  text = text.replace('echoCancellation:true', 'echoCancellation: true').replace('noiseSuppression:true', 'noiseSuppression: true');

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
  const syntax = spawnSync(process.execPath, SYNTAX_CHECK_FLAGS.concat(['--check', tmp]), { encoding: 'utf8' });
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
   * ①b 【2026-10-18 已删除：不再拷 `hostcore/speech-models/index.js`】
   *
   * 过去这里会把仓库里的模型下载器拷成 `<pkg>/speech-models/index.js`，因为
   * 当时的 provider 无条件 `import { ensureAssets, missingAssets, ASSETS } from
   * "../speech-models/index.js"`（hms-provider.js 落在 `<pkg>/lib/`，相对说明符
   * 解析到 `<pkg>/speech-models/`）；只拷 provider 而不拷它，运行时就是
   * `Cannot find module`（当时的 E-SV12）。
   *
   * 现在没有这个依赖了：普通听写的识别本体改用 HarmonyOS **Core Speech Kit**
   * （ArkTS 侧 `SystemSpeechRecognizer`，见施工方案 Task 3/Task 4），provider 只
   * 负责 `<id>.req` / `<id>.done` / `<id>.fail` 队列协议 ⇒ **不再 import 下载器**
   * ⇒ 树里也不需要那个 228MB 模型的下载器副本。
   *   · 因此**刻意不拷**，也**刻意不 die**：缺了它不再是错误（旧树里有残留也无害，
   *     只是没人引用的死文件；下次重打核心树即自然消失）。
   *   · 反向守卫在 `tools/check-core-openharmony-patches.mjs` 的 ③ 组：树内
   *     `hms-provider.js` **不得**再出现 `ensureAssets(` / `missingAssets(` /
   *     `preparation: prep`（防的是有人把下载路径加回来却只改一半）。
   */

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
  // 模型可见的 Python 工具（2026-10-16，r47 自检报告的缺口）：宿主进程里那份内嵌 CPython
  // 一直是就绪的，但 Agent 三条路全断（bash 走 guest VM 且受内存门槛 + guest 无 python3；
  // `/dshm-python/*` 是回环端点而 web_fetch 按 SSRF 策略拒回环；run_code 上游停用）
  // ⇒ 新增本插件把 `python` 工具接到主进程内的桥（见插件头注与 docs/165）。
  { name: '@deepseek-ai/dshm-tool-python', dir: 'dshm-tool-python' },
  // 模型可见的浏览器自动化工具（2026-10-16，docs/173/174）：browser_* 工具 → 宿主进程内
  // 浏览器桥（/dshm-browser/*）；设备本机浏览器里的 DSHM Browser Bridge 扩展经
  // ws://127.0.0.1:19390 连入。扩展源码在 hostcore/browser-extension/。
  { name: '@deepseek-ai/dshm-tool-browser', dir: 'dshm-tool-browser' },
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
  /*
   * 云同步设置分区（2026-10-30，docs/319）。
   *
   * 【为什么做成插件】前四版入口在手持档全部失败（顶栏菜单无顶栏、账号菜单不可达、
   * 手持浮钮真机未见、DOM 注入被 React 重渲染冲掉）。插件走官方 `settings.section`
   * 注册 ⇒ 分区由 React 渲染，与「通用 / 账号 / 插件」**结构同构**，
   * 不存在"被冲掉"或"样式对不齐"这两类问题。
   *
   * 【本插件是纯客户端**加一层薄宿主**】`lib/index.js` 的 `apply()` 有意留空
   * （能力在 client 与 ArkTS 桥），但 `main` 必须指向真模块 ——
   * `dsh.profile.bundles` 的每个条目都会被 `resolveBundleDir` 解析，任一失败启动即抛。
   */
  { name: '@deepseek-ai/dshm-cloud-sync', dir: 'dshm-cloud-sync' },
  // 原生朗读/分享动作条（2026-11-15）：纯客户端插件，注册官方
  // `conversation.chat.assistant-actions`；能力在 ArkTS 桥（ReadAloud/ShareBoard）。
  // 见 hostcore/profile/ondevice/cordis.patch.yml ⑬d 与插件头注。
  { name: '@deepseek-ai/dshm-read-aloud', dir: 'dshm-read-aloud' },
  // 启动编排（2026-11-26）：把「非首屏必需」的插件行推迟到壳就绪之后挂载。
  // 默认 deferredBundles 为空 ⇒ 加载后立即返回，行为与未挂载等价；
  // 填清单才生效（清单在 profile 的 cordis.patch.yml，不改插件代码）。
  { name: '@deepseek-ai/dshm-boot-extras', dir: 'dshm-boot-extras' },
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
  // 市场宿主桥（2026-10-06，见 hostcore/plugins/dshm-market-bridge/lib/index.js 头注）：
  // 手机/平板档"沙箱内一切自带可执行文件的 execve 都被拒"⇒ 插件市场赖以工作的
  // `spawn("pnpm")` / `spawn("dsh")` 结构性不可用（真机现象：「pnpm 自动配置失败」、
  // 市场一个插件都装不上）。本插件按上游明文契约（`dshmarket/lib/index.js:235-271`）
  // 发布 `desktopProfiles` + `desktopPnpm`，把市场的 add/remove 改走**进程内安装队列**
  // （与 `bin/pnpm` 假壳同一份协议），全程不 spawn。只在假壳真跑不起来时才接管
  // （同步探 `bin/pnpm --version`）⇒ PC/2in1 档行为零变化。
  // 【与其它 dshm-* 的差别】它**没有** cordis 行，也不是"插件页里的一项"：服务必须在
  // Loader 条目挂载**之前**就位，所以由 pack-core 的
  // `patchMarketDesktopRuntime()` 注入进 `@deepseek-ai/dsh/lib/profile-boot-*.js` 的
  // boot 回调（与 profileContext 同时机）；本清单里的作用只是"落树 + 声明依赖"。
  { name: '@deepseek-ai/dshm-market-bridge', dir: 'dshm-market-bridge' },
  // profile 包管理进程内通道（2026-10-06，见 hostcore/plugins/dshm-profile-pnpm/lib/index.js 头注）：
  // 手持档（手机/平板）**没有任何可 execve 的 shell**（`system-sh=缺` / `ash=denied` /
  // `bash=denied` / `realShell=no`），而 `@deepseek-ai/dsh-plugin-manager` 的
  // `runProfilePnpm()` 最后一跳是 `execa(options.command ?? "pnpm", …)` ⇒ 假壳
  // `bin/pnpm` 的第一行解释器就被内核拒（`spawn pnpm EACCES`），假壳里唯一干活的
  // 实现（写 `install-queue/*.rem`）**结构上不可达** ⇒ 「设置 → 插件 → 卸载」
  // 100% 失败、装上的包卸不掉（用户可见文案是 execa 的英文原文）。
  // 上游的 `profileContext.packageManager` 钩子只能换"spawn 哪个可执行文件"，本档
  // 任何 command 都点不着火（toybox 可跑但**不带 sh applet**）⇒ 纯配置解决不了。
  // 本插件把 add/remove 改走**与应用内安装器同一份队列协议**（与市场桥同判据：
  // 同步探 `bin/pnpm --version`，能跑就完全惰性）⇒ PC/2in1 档行为零变化。
  // 【与其它 dshm-* 的差别】它也没有 cordis 行：接线由本文件的
  // `patchProfilePnpmBridge()` 注入进 plugin-manager 的 `operations.js`。
  { name: '@deepseek-ai/dshm-profile-pnpm', dir: 'dshm-profile-pnpm' },
  // guest 虚拟机 bash 通道（2026-10-08，见 hostcore/plugins/dshm-vm-bash/lib/index.js 头注）：
  // 手持档（手机/平板）的应用沙箱里**没有任何可 execve 的 shell**，链 1
  // （`tool-bash` → `ctx.shell`(`dsh-bash-local`) → `ctx.subprocess` → 本机 `execve`）
  // 因此结构性不可用。本插件把 `ctx.subprocess.spawn` 在该档改接到**随包 QEMU guest**
  // 里的真 bash（`docs/119` 已把可行性验到端到端：QGA 可用 11.8 s、命令 81~219 ms），
  // 于是模型的 bash 工具真的能执行命令。
  // 【与其它 dshm-* 的差别】它与 profile-pnpm 桥同族：**接线不在本文件**，而是 profile 的
  // 一个 cordis 行（`hostcore/profile/ondevice/cordis.patch.yml` 第 ⑬ 节的 insert）——
  // 本插件对时机没有要求（改的是 `ctx.subprocess` 实例上的一个方法，第一次 spawn 远晚于
  // 所有插件装载），所以用普通行即可，让"哪一档装载了什么"在 profile 里一眼可读。
  // 本清单里的作用只是"落树 + 声明依赖"（与市场桥同）。
  // 【惰性】三条判据与市场桥 / profile-pnpm 桥**同源**：`DSHM_PLATFORM === 'ohos'` 且
  // "随包假壳 spawn 不起来" 且 VM 资产齐备才接管 ⇒ PC/2in1 档整条插件惰性。
  { name: '@deepseek-ai/dshm-vm-bash', dir: 'dshm-vm-bash' },
  // ⚠️ 历史沿革（2026-11-06）：以下描述的是**已剥离**的 dshm-meeting-ai 插件
  // （2026-10-31 会议模式剥离，源码仅存于 dist/frozen/meeting-mode-20261031T125746/）。
  // 当前 DSHM_PLUGIN_PACKAGES 无此项，profile 也无对应 insert；保留文字供追溯。
  // 原生会议面板的「AI 总结 / 实时英译」没有系统侧通道 —— 小艺慧记的摘要**没有公开 API**
  // （`@hms.ai.A2A` 是"我们被小艺调用"，方向相反；`textProcessing` 只有实体/分词），系统也
  // 没有翻译 API（`docs/197` §2.1/§2.3 逐条核过）。所以这两项走 **Host 侧本机模型**：
  // 面板把 `$DSH_HOME/meeting-ai/<id>.req` 写进磁盘，本插件用 `ctx.llm`（形态照官方
  // `dsh-session-title-llm` 的 prepareCall + call.stream）生成后写 `<id>.done` / `<id>.fail`。
  // 【与其它 dshm-* 的差别】它不需要改任何上游实现：只是一个普通 cordis 行
  // （`hostcore/profile/ondevice/cordis.patch.yml` ⑭ 的 insert），不包装 `ctx.subprocess`、
  // 不注入 boot 回调。本清单里的作用是"落树 + 声明依赖"（同其它项）。
  // 【失败面】模型没登录 / 断网 / 超时（60s）一律写 `.fail`，绝不写空 `.done`、绝不抛给宿主。
  // 启动救援（2026-11-08，见 hostcore/plugins/dshm-boot-rescue/README.md）：
  // 某个插件在加载阶段把 Web UI 打成 `Failed to load plugins` 失败页时，「设置 → 插件」
  // 也在同一张页面里 ⇒ 用户没有任何入口停用肇事插件，只能卸载重装。本插件是**纯宿主插件**
  // （无 cordis client 半身、零依赖、不声明 static inject），由宿主把 `rescue-client.js`
  // 通过 `webServer.tapIndex` 注入 index.html；即使其它插件全部 pending，这段脚本仍会执行，
  // 在失败页上挂出「启动恢复中心」，把肇事行 id 写进 `.dshm-plugin-rows.yml`，
  // 用户划掉后台重开即可恢复。所有读写限定在 $DSH_HOME / $DSHM_HOME 内，失败只写日志、不阻断启动。
  // 默认启用见 profile ⑮；恢复条件：删本项 + profile ⑮ 那一行。
  { name: '@deepseek-ai/dshm-boot-rescue', dir: 'dshm-boot-rescue' },
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

/**
 * 回归锁：自带插件的 **dsh peer 版本**必须与树里真正的运行版本一致。
 *
 * 【为什么必须有它（2026-10-16 真机事故）】`@deepseek-ai/dsh-app-boot` 的插件兼容闸门
 * （`evaluatePluginCompatibility`）在装载 profile 行之前逐条读插件 manifest：`engines.dsh`
 * 优先，否则看 `peerDependencies` 里每个 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`，
 * 用 `semver.satisfies(运行时版本, range, { includePrerelease: true })` 判。
 * **精确钉法**（`"0.2.1-alpha.2"` 这种）只要内核升一档就整条不满足 ⇒ 那一行被**停用**。
 * 2026-10-16 升 alpha.4 时正是漏了这一跳：四个自带插件的 peer 还写着 alpha.2 ⇒
 * `fs-write-nonchmod`（端侧 profile 里 `fs` 服务的**唯一**提供者，它 replace 掉上游
 * `fs-sandbox`）被停用 ⇒ `session-controller` 永远停在 `pending (waiting for service: fs)`，
 * 界面文案「session controller 不可用」。也就是说这类漏改**不是少个功能，而是整个会话面起不来**。
 *
 * 【判据取谁】运行版本从**树里**的 `node_modules/@deepseek-ai/dsh-app-boot/package.json` 现读
 * （与闸门 `getDshRuntimeVersion()` 同源），不取 recipe —— recipe 的 coreVersion 带
 * `+dshm.NN` 构建元数据，包版本不带，两者不相等。
 * 精确钉法必须逐字相等；`workspace:*|^|~` 与非精确范围交给上游闸门按 semver 判
 * （它们跨一个 prerelease 仍然满足），本锁只拦"精确钉法忘了跟着升"这一类。
 */
function assertDshmPeerPinsMatchRuntime() {
  const bootManifestPath = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json');
  if (!existsSync(bootManifestPath)) {
    die(`自带插件 peer 版本回归锁读不到运行时 manifest：${bootManifestPath}`);
  }
  const runtimeVersion = JSON.parse(readFileSync(bootManifestPath, 'utf8')).version;
  if (typeof runtimeVersion !== 'string' || runtimeVersion.trim() === '') {
    die(`自带插件 peer 版本回归锁读不到运行时版本：${bootManifestPath}`);
  }
  /** 精确钉法（可带 prerelease / build 元数据）；非精确写法不在此锁的判据面内。 */
  const exactPin = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  const mismatches = [];
  for (const pkg of DSHM_PLUGIN_PACKAGES) {
    const manifestPath = join(STAGE, DSHM_PLUGIN_SCOPE_DIR, pkg.dir, 'package.json');
    if (!existsSync(manifestPath)) die(`自带插件 manifest 不存在：${manifestPath}`);
    const peers = JSON.parse(readFileSync(manifestPath, 'utf8')).peerDependencies ?? {};
    for (const [name, range] of Object.entries(peers)) {
      if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue;
      if (typeof range !== 'string') die(`${pkg.name} 的 peerDependencies["${name}"] 必须是字符串`);
      if (exactPin.test(range) && range !== runtimeVersion) {
        mismatches.push(`${pkg.name}: ${name} 钉在 ${range}，树里的运行版本是 ${runtimeVersion}`);
      }
    }
  }
  if (mismatches.length) {
    die('自带插件的 dsh peer **精确钉法**与树里的运行版本不一致 —— 上游兼容闸门会把对应 profile 行'
      + '整条停用（2026-10-16 事故：fs-write-nonchmod 被停用 ⇒ fs 服务缺失 ⇒ session-controller'
      + '永远 pending）：\n'
      + mismatches.map((m) => `  · ${m}`).join('\n')
      + `\n  修法：把 hostcore/plugins/<dir>/package.json 里这些 peer 值改成 ${runtimeVersion}。`);
  }
  log(`[pack-core]   回归锁 ✓ 自带插件的 dsh peer 精确钉法均等于运行版本 ${runtimeVersion}`);
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

  // ③b 回归锁：精确 peer 钉法必须跟着内核版本走（见函数头注的 2026-10-16 事故）。
  // 放在"落树之后"而不是"读源码之前"：判据是**将要进产物的那份字节**。
  assertDshmPeerPinsMatchRuntime();

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
  t = 'import { existsSync } from "node:fs";\nimport { parse } from "node:path";\n' + t;

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
}
/**
 * 把「空结果」从「访问被拒」里救出来（真机 P1-1，见 docs/108）。
 *
 * 【缺陷】rg 遇到读不进去的目录时**不保证**用非 0/1 的退出码：权限拒绝是遍历期错误，
 * rg 把 \`目录: Permission denied (os error 1)\` 打到 stderr 后继续；若最终没有命中，
 * 它就以 exit 1 收场 —— 而上游把 exit 1 一律读成「真的没有匹配」（noMatches）。
 * 于是 \`glob(Documents,"*")\` 变成 "No files found"、\`grep(Documents,".")\` 变成
 * "No matches found"，把「没权限」伪装成「目录是空的」；用户与模型都会据此误判。
 * （降级路径同理：find 撞上 EPERM 也是 exit 1。）
 *
 * 【判据为什么只加在「空结果」这一支】大树里个别子目录读不到是常态（跨挂载点、系统目录），
 * 不能因为 stderr 里出现一条 Permission denied 就把整次搜索判失败 —— 那会把已经拿到的
 * 结果一起丢掉。所以只有「stderr 有访问类关键词」且「stdout 一个结果都没有」才升级为错误。
 *
 * @returns 要抛的 SearchError；不是「访问被拒」时返回 null（保持上游语义）
 */
function accessibilityDenial(toolName, stderrText) {
	const text = typeof stderrText === "string" ? stderrText : "";
	if (!/permission denied|operation not permitted|os error 1\\b|os error 13\\b|EACCES|EPERM/i.test(text)) return null;
	const first = text.split("\\n").find((line) => line.trim() !== "");
	if (first === undefined) return null;
	return new SearchError(toolName + " 读不到搜索目录：目录被系统拒绝访问（Permission denied）—— 这是『读不到』，不是『没有内容』。原始 stderr: " + first.trim(), "SEARCH_FAILED");
}`;

  /* ── 访问范围闸门（docs/137）：glob / grep 的**搜索根** ────────────────────
   * 【为什么这里有第二个入口】本工具**不过 `ctx.fs`**（其头注逐字："Spawn-backed, not
   * a `ctx.fs` provider method"）：它 spawn 随包 ripgrep（exec 被拒时降级系统
   * find/grep），搜索根作为 argv 元素直接进 `ctx.subprocess` ⇒ `ctx.fs` 那道闸门
   * 管不到它，必须在**把根交给 spawn 之前**再判一次。
   * 【判据从哪来】`hostcore/plugins/dshm-fs-write-nonchmod/lib/fs-fence.js` 里
   * BEGIN/END 之间那一段**原样**搬过来（纯字符串、无 import、只用 JS 内建）——
   * 这样"两个入口一份判据"是结构上的事实，而不是靠人工同步；
   * tools/check-fs-fence.mjs 再钉住块内容逐字节一致 + 行为矩阵。
   * 【依赖边界】注入的这段只能用目标文件已 import 的标识符：这里只用 `process`（全局）
   * 与 `SearchError` / `ctx`（都在作用域内）。 */
  const scopeBegin = '/* ==== DSHM-FS-SCOPE-BEGIN ====';
  const scopeEnd = '/* ==== DSHM-FS-SCOPE-END ==== */';
  const scopeSource = readFileSync(join(ROOT, 'hostcore', 'plugins', 'dshm-fs-write-nonchmod', 'lib', 'fs-fence.js'), 'utf8');
  const scopeFrom = scopeSource.indexOf(scopeBegin);
  const scopeTo = scopeSource.indexOf(scopeEnd);
  if (scopeFrom < 0 || scopeTo < 0) die('fs-search 访问范围闸门：fs-fence.js 里找不到 DSHM-FS-SCOPE 标记（判据源形态变了）');
  const scopeBlock = scopeSource.slice(scopeFrom, scopeTo + scopeEnd.length);
  const scopeHelpers = "\n/* ── 访问范围闸门（docs/137，pack-core 从 fs-fence.js 原样注入）────────── */\n"
    + scopeBlock + "\n" + [
      "/** 把模型给的 path 参数折成绝对路径，再判一次范围；越界抛 SearchError（同一工具错误面）。 */",
      "async function refuseOutOfScopeSearch(ctx, exec, toolName, requestedPath) {",
      "\tif (requestedPath === void 0 || String(requestedPath).trim() === \"\") return;",
      "\tconst raw = String(requestedPath).trim();",
      "\tlet absolute = raw;",
      "\tif (raw.charAt(0) !== \"/\") {",
      "\t\tconst workdir = exec.agent === void 0 ? process.cwd() : await ctx.workingDirectory.ensure(exec.agent, exec.signal);",
      "\t\tlet base = String(workdir);",
      "\t\twhile (base.length > 1 && base.charAt(base.length - 1) === \"/\") base = base.slice(0, -1);",
      "\t\tabsolute = base + \"/\" + raw;",
      "\t}",
      "\tconst roots = scopeRoots(process.env);",
      "\tconst normalized = scopeNormalize(absolute);",
      "\tif (normalized !== \"\" && scopeAllows(normalized, roots)) return;",
      "\tthrow new SearchError(scopeDenialMessage(normalized === \"\" ? absolute : normalized, roots), \"SEARCH_FAILED\");",
      "}"
    ].join("\n") + "\n";

  // 1) helpers 注入：resolveRgPath 尾锚点（文件内唯一，rg -c 验证）
  const tailAnchor = t.includes('import { resolveRgPath, spawnRipgrep } from "@deepseek-ai/dsh-util-ripgrep";')
    ? 'import { resolveRgPath, spawnRipgrep } from "@deepseek-ai/dsh-util-ripgrep";'
    : '\treturn rgPathPromise;\n}';
  if (!t.includes(tailAnchor)) die('fs-search 降级 patch：tail anchor 未命中（resolveRgPath 形态变了）');
  t = t.replace(tailAnchor, tailAnchor + '\n' + helpers + scopeHelpers + '\n/** DSHM_SEARCH_HELPERS_END */\n');

  // 2) spawn 段：rg 解析失败或 exec 探测失败 → find/grep argv
  const oldSpawn = t.includes('handle = await spawnRipgrep(ctx.subprocess, {\n\t\t\targv,')
    ? '\tlet handle;\n\ttry {\n\t\thandle = await spawnRipgrep(ctx.subprocess, {\n\t\t\targv,'
    : `\tlet handle;
\ttry {
\t\thandle = ctx.subprocess.spawn({
\t\t\targv: [
\t\t\t\tawait resolveRgPath(),
\t\t\t\t"--no-config",
\t\t\t\t...argv
\t\t\t],`;
  const newSpawn = `\t// 鸿蒙适配：rg 解析失败（平台包缺失）或 exec 探测失败（execve 被拒）→ 系统 find/grep
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

  // 4) 「空结果」守卫（真机 P1-1，docs/108）：rg / find 把「读不到」以 exit 1 收场时，
  //    上游一律读成「真的没有匹配」⇒ glob 报 No files found、grep 报 No matches found，
  //    把「被系统拒绝」伪装成「目录是空的」。这里把「stderr 有访问类关键词 且 stdout 为空」
  //    升级成可读错误。判据与理由见注入进来的 accessibilityDenial 头注。
  const oldEmpty = `\tif (outcome.exitCode !== 0 && outcome.exitCode !== 1) throw classifyRunFailure(toolName, outcome.exitCode, stderr.text, stderr.lossy);
\treturn {`;
  const newEmpty = `\tif (outcome.exitCode !== 0 && outcome.exitCode !== 1) throw classifyRunFailure(toolName, outcome.exitCode, stderr.text, stderr.lossy);
\tif (outcome.exitCode === 1 && stdout.text.length === 0) {
\t\tconst denial = accessibilityDenial(toolName, stderr.text);
\t\tif (denial !== null) throw denial;
\t}
\treturn {`;
  if (!t.includes(oldEmpty)) die('fs-search 空结果守卫：锚点未命中（runRipgrep 尾段形态变了）');
  t = t.replace(oldEmpty, newEmpty);

  // 5) 访问范围闸门（docs/137）：glob / grep 的搜索根，在 spawn **之前**判一次
  const oldGlobExec = `\t\tasync execute(args, exec) {
\t\t\tconst input = parseGlobArgs(args);
\t\t\tconst run = await runRipgrep(ctx, exec, "glob", buildGlobCommand(input), caps.rawOutputMaxBytes, caps.graceMs, caps.stderrMaxBytes);`;
  const newGlobExec = `\t\tasync execute(args, exec) {
\t\t\tconst input = parseGlobArgs(args);
\t\t\t// 访问范围闸门（docs/137）：搜索根直接进 argv ⇒ 必须在 spawn 之前判
\t\t\tawait refuseOutOfScopeSearch(ctx, exec, "glob", input.path);
\t\t\tconst run = await runRipgrep(ctx, exec, "glob", buildGlobCommand(input), caps.rawOutputMaxBytes, caps.graceMs, caps.stderrMaxBytes);`;
  if (!t.includes(oldGlobExec)) die('fs-search 访问范围闸门：glob execute 锚点未命中（形态变了）');
  t = t.replace(oldGlobExec, newGlobExec);

  const oldGrepExec = `\t\tasync execute(args, exec) {
\t\t\tconst run = await runRipgrep(ctx, exec, "grep", buildGrepCommand(parseGrepArgs(args)), caps.rawOutputMaxBytes, caps.graceMs, caps.stderrMaxBytes);`;
  const newGrepExec = `\t\tasync execute(args, exec) {
\t\t\tconst input = parseGrepArgs(args);
\t\t\t// 访问范围闸门（docs/137）：搜索根直接进 argv ⇒ 必须在 spawn 之前判
\t\t\tawait refuseOutOfScopeSearch(ctx, exec, "grep", input.path);
\t\t\tconst run = await runRipgrep(ctx, exec, "grep", buildGrepCommand(input), caps.rawOutputMaxBytes, caps.graceMs, caps.stderrMaxBytes);`;
  if (!t.includes(oldGrepExec)) die('fs-search 访问范围闸门：grep execute 锚点未命中（形态变了）');
  t = t.replace(oldGrepExec, newGrepExec);

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
  const probeRun = spawnSync(process.execPath, SYNTAX_CHECK_FLAGS.concat(['--check', syntaxProbe]), { encoding: 'utf8' });
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
   * 【幂等判定必须接受**旧标记**】原为 `includes(HDSH_ORIGIN_LIST)`；
   * HDSH→DSHM 改名后，核心树里由**上一版 pack-core** 打过的补丁仍带旧标记
   * ⇒ 只认新标记会判成"未打过"，于是重跑替换，而待替换片段已被换掉
   * ⇒ `die(上游实现已变化)`，整个打包中断。
   *
   * 教训与 E-SV14 同类：**改标记名时必须同时认旧名**，否则老树无法增量重打包。
   * 两处字面量都保留，直到核心树重建过一次（pack-core 会从上游重新解包）。
   */
  if (text.includes('DSHM_ORIGIN_LIST') || text.includes('HDSH_ORIGIN_LIST')) {
    log('[pack-core]   Origin 栅栏补丁已存在（跳过）');
    return;
  }
  /*
   * 【0.2.1-alpha.2：上游把同源判定抽成了独立函数】
   * alpha.1 的形态是内联在 isTrustedApiRequest 里的 try/catch 块（下面是旧锚点，
   * 保留它以便老树仍能增量重打包）；alpha.2 起改成 `return isSameAuthorityOrigin(origin, host);`，
   * 比较逻辑搬进新函数。补丁点随之搬迁：改函数本身即可，语义完全不变
   * （多值 Origin 任一候选同源即通过）。两种形态都认，两个都不中才 die。
   */
  const beforeNew = `function isSameAuthorityOrigin(origin, host) {
\tlet originUrl;
\ttry {
\t\toriginUrl = new URL(origin);
\t} catch {
\t\treturn false;
\t}
\tconst scheme = originUrl.protocol === "https:" ? "https:" : originUrl.protocol === "http:" ? "http:" : void 0;
\tif (scheme === void 0) return false;
\tconst hostUrl = parseAuthority(host, scheme);
\treturn hostUrl !== void 0 && originUrl.host === hostUrl.host;
}`;
  const afterNew = `function isSameAuthorityOrigin(origin, host) {
\t/* DSHM_ORIGIN_LIST: 多值 Origin（鸿蒙客户端 libwebsockets 附加的无端口 Origin +
\t * 调用方注入值）只要**任一项**同源即通过。原实现按整串解析，导致每一次端侧 WS 升级
\t * 都被判 403。详见 tools/pack-core.mjs 的 allowOriginList()。 */
\tfor (const rawOrigin of String(origin).split(",")) {
\t\tconst candidate = rawOrigin.trim();
\t\tif (candidate.length === 0) continue;
\t\tlet originUrl;
\t\ttry {
\t\t\toriginUrl = new URL(candidate);
\t\t} catch {
\t\t\t/* 单个非法候选不足以否决整条请求，继续看下一项 */
\t\t\tcontinue;
\t\t}
\t\t/* 不能像上游那样只认 http(s)：鸿蒙客户端附上来的那条是 ws:// —— 它正是本次要放行的值。
\t\t * 比较的是 .host，非层级 scheme（file:/data:）的 host 为空串 ⇒ 天然不匹配，安全边界不变。 */
\t\tif (originUrl.host === "") continue;
\t\tconst scheme = originUrl.protocol === "https:" || originUrl.protocol === "wss:" ? "https:" : "http:";
\t\tconst hostUrl = parseAuthority(host, scheme);
\t\tif (hostUrl !== void 0 && originUrl.host === hostUrl.host) return true;
\t}
\treturn false;
}`;
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
  if (text.includes(beforeNew)) {
    text = text.replace(beforeNew, afterNew);
    writeFileSync(target, text, 'utf8');
    log('[pack-core]   Origin 栅栏补丁（0.2.1-alpha.2 新形态）：已允许逗号分隔的 Origin 列表');
    return;
  }
  if (text.includes(before)) {
    text = text.replace(before, after);
    writeFileSync(target, text, 'utf8');
    log('[pack-core]   Origin 栅栏补丁（旧形态）：已允许逗号分隔的 Origin 列表');
    return;
  }
  die('Origin 栅栏补丁：上游实现已变化（未找到待替换片段），拒绝静默跳过');
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
 * ───────────────── ABI 预检（2026-11-24，Node 26 影响面审计 §2.3）─────────────
 * require 真件**之前**先读重定向目标 ELF64-LE 的动态节，校验 DT_NEEDED 里的
 * libnode soname 与**运行时 ABI**（process.versions.modules）一致；不一致/闭包缺失/
 * 文件损坏 → 直接走 stub（带 dshmSharpBackendUnavailable 标记），**不进入 dlopen**。
 * 【为什么必须有这一层】WorkBuddy 2026-11-23 独立测试实录：147 运行时加载钉着
 * libnode.so.137 的 sharp 闭包会 **SIGSEGV**（进程级崩溃，不是 JS 异常）；静态门禁
 * （check-node-cli）管的是构建期，覆盖不了"包内混入旧 ABI 件"的运行时现场。
 * 【为什么只查 .so 不查核心树里的 .node】原生重定向（jitless-env 的
 * installNativeRedirect）会把 .node 请求改写到 HSP libs 下的
 * libsharp-openharmony-arm64.so，真正 dlopen 的只有它；树里那份 .node 的 NEEDED
 * 从来不含 libnode（E44 的闭包改写发生在 collect-libvips 播种的 .so 上），查它必误报。
 * libs 目录通过 DSHM_NATIVE_LIBS 环境变量获得（installNativeRedirect 已验证存在后发布）。
 *
 * 【幂等】以 package.json 的版本号（DISPATCH_VERSION）为标记；0.0.0 旧版只刷新调度器。
 */
const SHARP_DISPATCH_VERSION = '0.0.2-dshm-dispatch';
function wrapSharp() {
  const nm = join(STAGE, 'node_modules');
  const sharpDir = join(nm, 'sharp');
  const implDir = join(nm, 'sharp.impl');
  if (!existsSync(sharpDir)) {
    log('[pack-core]   sharp 不在树里（跳过调度器）');
    return;
  }
  const pkgFile = join(sharpDir, 'package.json');
  let priorVersion = '';
  if (existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
      priorVersion = String(pkg.version || '');
    } catch {
      die('sharp 调度器：现有 sharp/package.json 不可解析，拒绝盲目覆盖');
    }
  }
  if (priorVersion === SHARP_DISPATCH_VERSION) {
    log('[pack-core]   sharp 调度器已存在（跳过）');
    return;
  }
  /*
   * 【哪些情形要把 sharp 目录挪成 sharp.impl】只有"当前 sharp 不是我们的调度器"（上游
   * sharp 原包 / 版本号非 *-dshm-dispatch）时才挪。**旧版调度器（0.0.0/0.0.1/…）绝不挪**：
   * 挪了会把调度器目录 rename 成 sharp.impl，先 rmSync 的还是真 impl —— 一起把真件
   * 毁掉。旧版只刷新调度器文件（真件已在 sharp.impl，不碰）。
   */
  if (!/-dshm-dispatch$/.test(priorVersion)) {
    if (existsSync(implDir)) {
      rmSync(implDir, { recursive: true, force: true });
    }
    renameSync(sharpDir, implDir);
    mkdirSync(sharpDir, { recursive: true });
  }
  writeFileSync(
    pkgFile,
    JSON.stringify({ name: 'sharp', version: SHARP_DISPATCH_VERSION, main: 'index.js', private: true }) + '\n',
    'utf8',
  );
  writeFileSync(
    join(sharpDir, 'index.js'),
    [
      '/* DSHM 端侧 sharp 调度器（E93 + 2026-11-24 ABI 预检）：真件优先；真件不可用/ABI 不匹配',
      ' * 时退回"会报错但能挂载"的 stub。失败原因挂在 dshmSharpLoadError 上，由入口脚本的',
      ' * 运行时事实如实上报（不假装可用）。stub 抛出的错误带 dshmSharpBackendUnavailable 标记，',
      ' * dsh-attachment-local 的端侧补丁据此抛稳定的 IMAGE_BACKEND_UNAVAILABLE。',
      ' * 本文件由 tools/pack-core.mjs 的 wrapSharp() 生成，不要手改。 */',
      "'use strict';",
      'const nodeFs = require("node:fs");',
      'const nodePath = require("node:path");',
      '/* 读 ELF64-LE 的 DT_NEEDED 名单；读不了/损坏返回 { broken: 原因 }，不抛。 */',
      'function dshmProbeElfNeeded(file) {',
      '  let buf;',
      '  try { buf = nodeFs.readFileSync(file); } catch (e) { return { broken: "读取失败：" + (e && e.message) }; }',
      '  if (!buf || buf.length < 64) return { broken: "文件小于 ELF 头" };',
      '  if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) return { broken: "非 ELF 魔数" };',
      '  if (buf[4] !== 2) return { broken: "非 ELF64" };',
      '  if (buf[5] !== 1) return { broken: "非小端字节序" };',
      '  const phoff = Number(buf.readBigUInt64LE(0x20));',
      '  const phentsize = buf.readUInt16LE(0x36);',
      '  const phnum = buf.readUInt16LE(0x38);',
      '  if (phnum === 0 || phentsize < 56) return { broken: "program header 表为空或异常" };',
      '  let dyn = null;',
      '  const loads = [];',
      '  for (let i = 0; i < phnum; i++) {',
      '    const off = phoff + i * phentsize;',
      '    if (off + 56 > buf.length) return { broken: "program header 越界" };',
      '    const ptype = buf.readUInt32LE(off);',
      '    if (ptype === 2) dyn = { offset: Number(buf.readBigUInt64LE(off + 8)), size: Number(buf.readBigUInt64LE(off + 32)) };',
      '    else if (ptype === 1) loads.push({ vaddr: Number(buf.readBigUInt64LE(off + 16)), filesz: Number(buf.readBigUInt64LE(off + 32)), offset: Number(buf.readBigUInt64LE(off + 8)) });',
      '  }',
      '  if (dyn === null) return { broken: "缺 PT_DYNAMIC 段" };',
      '  const v2o = (v) => {',
      '    for (const l of loads) {',
      '      if (v >= l.vaddr && v < l.vaddr + l.filesz) return v - l.vaddr + l.offset;',
      '    }',
      '    return -1;',
      '  };',
      '  let strtabFile = -1;',
      '  const neededVals = [];',
      '  for (let p = 0; p + 16 <= dyn.size; p += 16) {',
      '    const at = dyn.offset + p;',
      '    if (at + 16 > buf.length) break;',
      '    const tag = Number(buf.readBigUInt64LE(at));',
      '    const val = Number(buf.readBigUInt64LE(at + 8));',
      '    if (tag === 0) break;',
      '    if (tag === 5) strtabFile = v2o(val);',
      '    else if (tag === 1) neededVals.push(val);',
      '  }',
      '  if (strtabFile < 0) return { broken: "缺 DT_STRTAB" };',
      '  const names = [];',
      '  for (const nv of neededVals) {',
      '    const start = strtabFile + nv;',
      '    if (start < 0 || start >= buf.length) continue;',
      '    let end = start;',
      '    while (end < buf.length && buf[end] !== 0) end++;',
      '    names.push(buf.slice(start, end).toString("latin1"));',
      '  }',
      '  return { names };',
      '}',
      '/* ABI 预检：不一致抛带标记的错误（被下面的 catch 收进 stub 原因），阻止 dlopen。 */',
      'function dshmGuardSharpAbi() {',
      '  const libsDir = process.env.DSHM_NATIVE_LIBS;',
      '  if (typeof libsDir !== "string" || libsDir.length === 0) return; /* 开发机/未装重定向：跳过预检 */',
      '  const so = nodePath.join(libsDir, "libsharp-openharmony-arm64.so");',
      '  if (!nodeFs.existsSync(so)) return; /* 重定向目标不存在：交给 require 报真实错误 */',
      '  const expect = "libnode.so." + process.versions.modules;',
      '  const probe = dshmProbeElfNeeded(so);',
      '  if (probe.broken !== undefined) {',
      '    throw new Error("sharp ABI 预检失败：libsharp-openharmony-arm64.so " + probe.broken + "（已阻止 dlopen 以避免崩溃）");',
      '  }',
      '  const found = [];',
      '  let matched = false;',
      '  for (const n of probe.names) {',
      '    const m = /^libnode\\.so\\.(\\d+)$/.exec(n);',
      '    if (m === null) continue;',
      '    found.push(m[1]);',
      '    if (n === expect) matched = true;',
      '  }',
      '  if (matched) return;',
      '  if (found.length > 0) {',
      '    throw new Error("sharp ABI 预检失败：DT_NEEDED libnode.so." + found.join("/") + " 与运行时 ABI " + process.versions.modules + " 不匹配（混装不同 ABI 的 libnode 会 SIGSEGV，已阻止 dlopen）");',
      '  }',
      '  throw new Error("sharp ABI 预检失败：DT_NEEDED 里没有 libnode.so.<数字> 条目（E44 闭包改写缺失），napi 符号将无法解析，已阻止 dlopen");',
      '}',
      'let impl;',
      "let loadError = '';",
      'try {',
      '  dshmGuardSharpAbi();',
      "  impl = require('sharp.impl');",
      '} catch (e) {',
      '  impl = undefined;',
      "  loadError = e && e.message ? String(e.message) : String(e);",
      '}',
      'if (impl === undefined || impl === null) {',
      "  const reason = loadError.length > 0 ? loadError : '未知原因';",
      '  impl = function dshmSharpUnavailable() {',
      "    const err = new Error('sharp 不可用：真件加载失败（' + reason + '）——图片附件依赖随包提供的 libvips 全套库');",
      '    err.dshmSharpBackendUnavailable = true;',
      '    err.dshmSharpLoadError = reason;',
      '    throw err;',
      '  };',
      '  impl.dshmSharpLoadError = reason;',
      '}',
      'module.exports = impl;',
      'module.exports.default = impl;',
      '',
    ].join('\n'),
    'utf8',
  );
  log('[pack-core]   sharp 调度器：真件在 node_modules/sharp.impl（ABI 预检 + 加载失败如实降级）');
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
     * 【2026-10-16：ptc.patch.yml 归 `patchPtcPresetWorkflowEnabled()` 管】
     * 用户拍板「PTC 模式必须有 run_code」⇒ 那份文件里这两行要**恢复启用**。本函数若继续
     * 遍历它，第二遍 pack 会在 enable 补丁摘掉 `disabled: true` 之后重新插回来，
     * 幂等性当场破坏。两个方向各有一组门禁判据，谁都不许越界。
     */
    if (name === 'ptc.patch.yml') {
      continue;
    }
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
 * 【PTC 模式恢复 `run_code`：只动 ptc 预设那两行（2026-10-16，用户拍板「1 2 3 都做」第 2 件）】
 *
 * 【为什么上游那里是关的】alpha.4 把 `workflow-ptc` / `tool-workflow` 写成了 `disabled: true`
 * 两处：bundle 级 `dsh-web-app/cordis.patch.yml`（**根 plane**，预设之下不生效）与
 * 预设自己的 `presets/ptc.patch.yml`（**这一条才有效** —— 真机 `agentPresets/read('ptc')`
 * 的合成结果里这两行就是 disabled）。而"PTC 模式"的定义就是让模型用 `run_code` 编排工具调用
 * ⇒ 预设里停用这两行 = PTC 模式没有 `run_code`（客户端文案也明说"当前 PTC 预设未启用 workflow 工具"）。
 *
 * 【为什么端侧可以开】官方 `ptc-runtime` 已被 profile ① 换成同进程纯 JS 的
 * `@deepseek-ai/dshm-ptc-runtime-inproc`，它的 `language === 'typescript'` 正是
 * `dsh-workflow-ptc` 的硬要求（`dsh-workflow-ptc/lib/index.js:607`），并已有 166 条断言的门禁。
 *
 * 【只动 ptc】standard / cordis 由 `patchAgentPresetWorkflow()` 显式停用（带 DSHM 标记），
 * 本函数一个字都不碰它们 —— 否则模型在标准模式下会拿到一条没在端侧验证过的 `run_code`。
 *
 * 【幂等 / 失败即停】标记 `DSHM_PTC_WORKFLOW_ENABLED`；两行没同时命中（上游改名/改结构）
 * 就 `die`，绝不静默跳过：静默跳过会让"PTC 模式有 run_code"变成一句没人验证过的话。
 */
function patchPtcPresetWorkflowEnabled() {
  const file = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'ptc.patch.yml');
  if (!existsSync(file)) {
    die(`PTC 预设补丁：找不到 ${file}`);
  }
  const MARK = 'DSHM_PTC_WORKFLOW_ENABLED';
  const text = readFileSync(file, 'utf8');
  if (text.includes(MARK)) {
    log('[pack-core]   PTC 预设补丁已存在（幂等跳过）');
    return;
  }
  /*
   * 形态：`- id: <两者之一>` → 紧随其后的 `name:` 行 → 同级的 `disabled: true`。
   * 只摘 `disabled: true` 那一行，并原缩进插入标记注释（YAML 里注释不参与结构）。
   */
  const pattern = /^([ \t]*)- id: (workflow-ptc|tool-workflow)\n([ \t]*name: [^\n]*\n)([ \t]*)disabled: true\n/gm;
  let hits = 0;
  const next = text.replace(pattern, (whole, dashIndent, id, nameLine, disabledIndent) => {
    hits += 1;
    return `${dashIndent}- id: ${id}\n${nameLine}`
      + `${disabledIndent}# ${MARK}: 端侧有同进程 PTC 运行时（dshm-ptc-runtime-inproc）⇒ 这条恢复启用\n`;
  });
  if (hits !== 2) {
    die(`PTC 预设补丁：只命中 ${hits}/2 行（workflow-ptc / tool-workflow 的 disabled: true）`
      + '—— 上游结构变化，拒绝静默跳过（否则"PTC 模式有 run_code"就是句空话）');
  }
  writeFileSync(file, next, 'utf8');
  log('[pack-core]   PTC 预设补丁：ptc.patch.yml 的 workflow-ptc / tool-workflow 已恢复启用（只动这一份预设）');
}

/**
 * 【端侧插件开关：摘掉 `optional-terminal-pwsh`（2026-10-13，docs/150）】
 *
 * 【现象】「设置 → 插件 → 持久终端」里那条显示为 `@deepseek-ai/dsh-terminal-bash` 的开关
 * **点不动**（不报错，只是不响应）。
 *
 * 【根因】UI 的行列表**不来自合成后的挂载树**，而来自 bundle **自带**的补丁文件：
 * `@deepseek-ai/dsh-plugin-manager` 的 `declaredRows()` 用
 * `bundlePatchPaths(dir, bundle) → loadOverlayPatches()` 枚举 bundle 自带
 * `cordis.patch.yml` 的 insert 行，再用 `this.ctx.loader.entries()` 里**同 id 的活条目**
 * 反查 `entryId`；客户端 `RowSwitch()` 把 `row.entryId === void 0` 判成禁用
 * （`lib/client.js`：`const locked = row.readOnlyReason !== void 0 || row.entryId === void 0;`）。
 * 而端侧 profile（`hostcore/profile/ondevice/cordis.patch.yml` 的 D52 整组覆盖）把
 * `optional-persistent-terminals` 这个 group 的 config 换成了「除 pwsh 外的三条」
 * ⇒ 合成树里**没有** `optional-terminal-pwsh` 这个 id ⇒ 反查不到活条目 ⇒
 * `entryId === undefined` ⇒ 客户端判为锁定、`setPluginEnabled(id)` 也无从下手。
 * 更迷惑的是该行的 `name` 与真正的 bash 行相同（都是 `@deepseek-ai/dsh-terminal-bash`）
 * ⇒ 用户看到的是**同一个标题下的两个开关，其中一个点不动**。
 *
 * 【修法】就地删掉 bundle 自带补丁里 `optional-terminal-pwsh` 那一条（含它的
 * `name` / `disabled` / `config` 子行）⇒ `declaredRows()` 只枚举出 3 行 ⇒
 * 死开关**根本不出现**。端侧没有 PowerShell，该行本来就是必然 ENOENT 的占位，
 * 摘掉不损失任何能力。profile 的整组覆盖**保留**（两条口径一致、幂等、无害）。
 *
 * 【幂等】留一行 `# DSHM_TERMINAL_BUNDLE_PWSH_DROPPED` 注释做标记。
 * 该注释**不得**含 `- id: optional-terminal-pwsh` 这个字面量 ——
 * `tools/check-core-openharmony-patches.mjs` 对它断言 ×0，裸字面量会把那条判据顶红。
 *
 * 上游若给该 group 改名/加行，这里**报错退出**而不是静默跳过。
 */
function patchTerminalBundleRows() {
  const file = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-experimental-terminal-bundle', 'cordis.patch.yml');
  if (!existsSync(file)) {
    die(`终端 bundle 行补丁：找不到 ${file}`);
  }
  const MARK = 'DSHM_TERMINAL_BUNDLE_PWSH_DROPPED';
  const raw = readFileSync(file, 'utf8');
  // 已打标也必须核对结构：标记不能掩盖重打前的上游变动或手改。
  if (raw.split(MARK).length - 1 > 1) die('终端 bundle 行补丁：迁移标记重复，拒绝掩盖重复注入');
  const clean = raw.split('\n').filter((line) => !line.trimStart().startsWith(`# ${MARK}:`)).join('\n').trimEnd();
  const hasPanel = clean.includes("name: '@deepseek-ai/dsh-terminal-panel'");
  /*
   * 0.2.3-alpha.2 纳入"新布局"白名单的依据：实测其终端 bundle 布局与 rc.5 **逐字一致**
   *（dsh-terminal + dsh-terminal-panel + dsh-tool-terminal，preferredShells 仅 win32）。
   * 其余 5 处新/旧布局分支同样按此处理；若上游 0.2.3 的锚点与 rc.5 不符，
   * 下面的严格核对会显式 die，不会静默跳过。
   */
  const wantsPanel = ['0.2.2-rc.2', '0.2.2-rc.3', '0.2.2-rc.4', '0.2.2-rc.5', '0.2.3-alpha.2'].includes(recipe.coreVersion.split('+')[0]);
  if (hasPanel !== wantsPanel) die('终端 bundle 行补丁：配方版本与新旧终端布局不符');
  // rc.2 把两个 shell 后端合并为 terminal-panel；只接受已确认的新布局，未知变更仍判死。
  if (hasPanel) {
    const expected = `- insert:
    - id: optional-persistent-terminals
      name: cordis:group
      group: true
      isolate:
        terminals: true
      config:
        - id: optional-terminal-registry
          name: '@deepseek-ai/dsh-terminal'
        - id: optional-terminal-panel
          name: '@deepseek-ai/dsh-terminal-panel'
          config:
            preferredShells: !!js "process.platform === 'win32' ? ['pwsh', 'powershell'] : []"
        - id: optional-tool-terminal
          name: '@deepseek-ai/dsh-tool-terminal'`;
    if (clean !== expected) {
      die('终端 bundle 行补丁：terminal-panel 新布局与已核实的 rc.2 三条配置不符，拒绝静默跳过');
    }
    const profile = readFileSync(join(ROOT, 'hostcore/profile', recipe.profile, 'cordis.patch.yml'), 'utf8');
    const panelGroup = `- id: optional-persistent-terminals
  config:
    - id: optional-terminal-registry
      name: '@deepseek-ai/dsh-terminal'
    - id: optional-terminal-panel
      name: '@deepseek-ai/dsh-terminal-panel'
      config:
        preferredShells: []
    - id: optional-tool-terminal
      name: '@deepseek-ai/dsh-tool-terminal'`;
    if (!profile.includes(panelGroup) || /\n    - id: optional-terminal-(?:bash|pwsh)\b/.test(profile)) {
      die('终端 bundle 行补丁：rc.2 profile 未严格同步 panel 三行，禁止旧 shell backend 覆盖新布局');
    }
    if (!profile.includes("- id: terminal-controller\n  config:\n    shellCandidates: ['sh', 'zsh', 'bash']")) {
      die('终端 bundle 行补丁：profile 必须保留 sh/zsh/bash 候选且由设备执行环境决定默认 shell');
    }
    writeFileSync(file, clean + `\n# ${MARK}: 上游已合并为 terminal-panel，PowerShell 偏好仅限 win32，无独立占位开关。\n`, 'utf8');
    log('[pack-core]   终端 bundle 行补丁：已核实 rc.2 terminal-panel 布局（无独立 pwsh 占位行）');
    return;
  }
  const legacyExpected = `- insert:
    - id: optional-persistent-terminals
      name: cordis:group
      group: true
      isolate:
        terminals: true
      config:
        - id: optional-terminal-registry
          name: '@deepseek-ai/dsh-terminal'
        - id: optional-terminal-bash
          name: '@deepseek-ai/dsh-terminal-bash'
          disabled: !!js process.platform === 'win32'
        - id: optional-tool-terminal
          name: '@deepseek-ai/dsh-tool-terminal'`;
  const legacyPwsh = `        - id: optional-terminal-pwsh
          name: '@deepseek-ai/dsh-terminal-bash'
          disabled: !!js process.platform !== 'win32'
          config:
            shellDialect: pwsh
`;
  if (clean !== legacyExpected && clean.replace(legacyPwsh, '') !== legacyExpected) {
    die('终端 bundle 行补丁：旧布局并非已核实的 registry/bash/pwsh/tool-terminal，拒绝静默跳过');
  }
  if (raw.includes(MARK)) {
    if (clean !== legacyExpected) die('终端 bundle 行补丁：旧布局带标记但仍残留 pwsh 行');
    log('[pack-core]   终端 bundle 行补丁：旧布局结构已核实（幂等）');
    return;
  }
  const lines = raw.split('\n');
  const out = [];
  let dropped = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)- id: optional-terminal-pwsh\s*$/.exec(lines[i]);
    if (m === null) {
      out.push(lines[i]);
      continue;
    }
    // 该条目 = `- id:` 行本身 + 其后所有缩进更深的行（到同级/更浅为止）。
    const indent = m[1].length;
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (l.trim() !== '' && l.match(/^\s*/)[0].length <= indent) break;
      j += 1;
    }
    out.push(`${m[1]}# ${MARK}: 端侧没有 PowerShell，该占位行不再是可点的开关（tools/pack-core.mjs / docs/150）`);
    i = j - 1;
    dropped += 1;
  }
  if (dropped !== 1) {
    die(`终端 bundle 行补丁：期望摘掉 1 条 pwsh 占位行，实际 ${dropped} 条（上游结构变化？），拒绝静默跳过`);
  }
  writeFileSync(file, out.join('\n'), 'utf8');
  log(`[pack-core]   终端 bundle 行补丁：已摘掉 ${dropped} 条 pwsh 占位行`);
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
 * 等补丁同一机制；且这是**上游同一段逻辑的两份副本**（lib/index.js +
 * lib/worker/profile-resolution-bootstrap.js），必须在两处都改，否则 worker 侧照崩。
 *
 * 【2026-10-05 更正计数】本节原写"这 **4** 处"，与实现/树内实际不符：每份副本是 **3** 处
 * （`error.message = …` / `if (stack !== void 0) error.stack = …` / 其紧邻的 try-catch 结构），
 * 两份共 **6** 处。`tools/check-core-openharmony-patches.mjs` 现在按"每份各 3 处"钉死
 * （该门禁 2026-10-05 扩成"全部注入标记"清单时实测所得）。
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
 * 端侧「市场宿主桥」接线（2026-10-06）。
 *
 * 【为什么必须有这一步】手机/平板档沙箱内一切自带可执行文件的 execve 都被系统拒绝，
 * 插件市场（`dshmarket`）赖以工作的 `spawn("pnpm")` 探针与 `spawn("dsh")` 安装因此
 * **结构性不可用** —— 用户真机现象就是「pnpm 自动配置失败」，且市场一个插件都装不上
 * （完整证据链见 `hostcore/plugins/dshm-market-bridge/lib/index.js` 头注）。
 *
 * 【上游给的正规缝】`dshmarket/lib/index.js:235-271` 明文规定：宿主发布
 * `desktopProfiles` 后，市场即 `inject(["desktopPnpm"])` 改用宿主自带的包管理器运行时，
 * 那时它的 `probePnpm` / `provisionPnpm` 是常量真 ——「pnpm 自动配置」这一步根本不会发生。
 * 同一处注释还规定这两个服务必须在 **Loader 条目挂载之前**存在。核心树里唯一满足这个
 * 时机的地方，就是这里：`boot(...)` 回调里 `profileContext` 被 provide 的那两行之后。
 *
 * 【为什么不用 "insert 一个 cordis 行"】行序是"bundle 行在前、profile patch 行在后"，
 * 而市场自己就是 bundle 行 ⇒ 补丁行永远排它后面，赌不赢挂载顺序（实测口径见
 * `hostcore/plugins/dshm-workspace-claim` 之类"只管自己、不依赖顺序"的同族选择）。
 *
 * 【注入内容】`await import("@deepseek-ai/dshm-market-bridge")` 后 `provide` 两个服务；
 * 包本体由 `embedDshmToolPackages()` 落进树（`node_modules/@deepseek-ai/dshm-market-bridge`），
 * 从 `@deepseek-ai/dsh/lib/` 起算的裸标识符解析正好命中它。
 * **失败只记一行**：桥是增量能力，任何失败都不许影响已验收的启动链路。
 *
 * 【幂等/防呆】按标记跳过重复注入；找不到锚点即 die —— 上游改了这段就当场暴露在打包期，
 * 而不是静默失效成"手机档市场又装不上了"（那种回归只能靠用户复现）。
 */
function patchMarketDesktopRuntime() {
  const libDir = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh', 'lib');
  if (!existsSync(libDir)) {
    die(`市场宿主桥补丁：找不到 ${libDir}`);
  }
  const MARK = 'DSHM_MARKET_BRIDGE_BOOT';
  /*
   * 锚点：`profileContext` 与 `DSH_LAUNCH_ENVIRONMENT_KEY` 的两次 provide（同一回调内，
   * 缩进两个 tab）。这两行的相对顺序与缩进都是上游 `runProfile()` 的既有形态。
   */
  const anchor = '\t\t\thostCtx.provide("profileContext", profileContext);\n'
    + '\t\t\thostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment);\n';
  const injection = [
    `\t\t\t/* ${MARK}: 端侧市场宿主桥（desktopProfiles + desktopPnpm）。`,
    '\t\t\t   上游契约要求这两个服务在 Loader 条目挂载之前就位，所以 provide 必须在这里',
    '\t\t\t   （与 profileContext 同一时机），不能写成 cordis 行（行序赌不过 bundle 行）。',
    '\t\t\t   实现见 hostcore/plugins/dshm-market-bridge/（源码）；失败只记一行，不阻断启动。 */',
    '\t\t\ttry {',
    '\t\t\t\tconst mkt = await import("@deepseek-ai/dshm-market-bridge");',
    '\t\t\t\tmkt.provideMarketBridge(hostCtx, profileContext);',
    '\t\t\t} catch (error) {',
    '\t\t\t\tconsole.error("dsh: 市场宿主桥未挂载（不影响启动）："',
    '\t\t\t\t\t+ (error && error.message ? error.message : error));',
    '\t\t\t}',
    '',
  ].join('\n');
  // 实现文件的名字带上游构建哈希（`profile-boot-<hash>.js`），所以按前缀找而不是写死。
  const impls = readdirSync(libDir).filter((n) => /^profile-boot-.*\.js$/.test(n));
  if (impls.length === 0) {
    die(`市场宿主桥补丁：${libDir} 下没有 profile-boot-*.js`);
  }
  let injected = 0;
  for (const fileName of impls) {
    const target = join(libDir, fileName);
    const text = readFileSync(target, 'utf8');
    if (text.includes(MARK) || !text.includes(anchor)) {
      continue;
    }
    writeFileSync(target, text.replace(anchor, anchor + injection), 'utf8');
    log(`[pack-core]   市场宿主桥：${fileName} 已注入 desktopProfiles/desktopPnpm 的 provide`);
    injected += 1;
  }
  if (injected === 0) {
    if (impls.some((n) => readFileSync(join(libDir, n), 'utf8').includes(MARK))) {
      log('[pack-core]   市场宿主桥补丁已存在（跳过）');
      return;
    }
    die('市场宿主桥补丁：profile-boot 实现文件里找不到 provide(profileContext) 锚点'
      + '（上游结构变化？），拒绝静默跳过');
  }
}

/**
 * 端侧「profile 包管理进程内通道」接线（2026-10-06）。
 *
 * 【为什么必须有这一步】手机/平板档沙箱内**没有任何可 execve 的 shell**
 * （`system-sh=缺`、`ash=denied`、`bash=denied`、`realShell=no`），而
 * `@deepseek-ai/dsh-plugin-manager` 的 `runProfilePnpm()` 最后一跳是
 * `execa(options.command ?? 'pnpm', …)`（`lib/types/operations.js:325`）⇒ 假壳
 * `bin/pnpm` 的**第一行解释器**就被内核拒（`spawn pnpm EACCES`），假壳里唯一干活的
 * 实现（`remove/rm` 分支写 `install-queue/<base>.rem`）因此**结构上不可达**。
 * 真机现象：「设置 → 插件 → 卸载」100% 失败、装上的包卸不掉，用户看到的是 execa
 * 的英文原文（`Command failed with EACCES: pnpm remove <名>`）。
 *
 * 【上游的钩子救不了】`profileContext.packageManager`（`types/index.js:340/:401/:729`）
 * 只能改"**spawn 哪个可执行文件**"与 env，最终仍是 `execa(command, args)` ——
 * 本档任何 command 都点不着火：`toybox=ok` 但 toybox **不带 sh applet**
 * （真机 `toybox-exec-sh=rc1` / `toybox-exec-ash=rc126`）。⇒ 纯配置解决不了，
 * 必须在 `execa` 之前分叉。
 *
 * 【注入点为什么选这里】`operations.js` 里 `preflight`（兼容性预检）之后、
 * `const cancellation = new AbortController()` 之前：**兼容性预检与 profile 清单快照
 * 都已保留**（回滚语义不变），而 `execa` 还没被调用。此处 `log` / `append` /
 * `output` / `truncated` / `logPath` / `incompatible` 都已在作用域内，所以接管分支能
 * 合成**与 execa 路径完全相同的返回形状**（`{exitCode, output, truncated, logPath,
 * ...incompatible.length > 0 ? {incompatible} : {}}` —— `incompatible` 必须**非空才带**，
 * 理由见 `profilePnpmBridgeInjection()` 的同名注释），写进同一份
 * `.plugin-manager/logs/operation-<id>/pnpm.log`，
 * 上游的"失败 ⇒ `throw new Error(output)`"链路一个字都不用改。
 *
 * 【惰性保证】桥自己先同步探一次 `bin/pnpm --version`（与市场桥同一判据）；能跑就返回
 * `undefined` ⇒ 这里原样继续走 `execa`。PC/2in1 档（`sh=ok`/`ash=ok`）因此**行为一个
 * 字节不变**，市场与设置页都仍走已验收的 spawn 链路。
 *
 * 【幂等/防呆】按标记跳过；找不到锚点即 die —— 上游改了这段就当场暴露在打包期，
 * 而不是静默失效成"平板档又卸不掉插件了"。
 *
 * 【为什么是**两个**注入点（2026-10-14 追加）】上游一次构建出两份同源实现：
 *   · `lib/types/operations.js` —— 独立入口（`…/dsh-plugin-manager/operations`，CLI 那侧）；
 *   · `lib/index.js` —— 包 main，**服务/Web 侧真正走的那份**：
 *     `PluginManager.runPnpm()`（index.js:2073）调的就是它自己的 `runProfilePnpm()`。
 * 只打前者时，手机档「设置 → 插件 → 项目地址安装」仍然 `execa("pnpm", …)` ⇒
 * `spawn pnpm EACCES`（真机实证：fport 直打 `pluginManager/installBundle` 回
 * `{"exitCode":1,"output":"Command failed with EACCES: pnpm add …","kind":"permission"}`）。
 * 两份产物的风格不同（缩进 4 空格 / tab、字面量单引号 / 双引号）⇒ 锚点与注入串逐站点给。
 */
/**
 * 插件**检查**通道的进程内分叉（2026-11-03，docs/358）。
 *
 * 与 `patchProfilePnpmBridge()` 分开：那一处接的是**安装**（`runProfilePnpm`），
 * 这一处接的是**检查**（`view` / `registry` / git 预检）。手持档上前者也坏、后者也坏，
 * 但它们在上游是两个不同的文件位置与函数，锚点正则不能混用。
 *
 * 三处注入同一契约：**桥返回 undefined = 不接管，照旧走 execa**
 * （PC / 2in1 档就是这条 ⇒ 已验收链路零变化）。
 */
function patchPluginManagerInspectBridge() {
  const MARK = 'DSHM_PLUGIN_MANAGER_BRIDGE';
  const target = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-plugin-manager', 'lib', 'index.js');
  if (!existsSync(target)) {
    die(`插件检查通道补丁：找不到 ${target}`);
  }
  let text = readFileSync(target, 'utf8');
  text = patchManagerLifecycle(text);
  writeFileSync(target, text);
  const opsTarget = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-plugin-manager', 'lib', 'types', 'operations.js');
  let opsText = existsSync(opsTarget) ? readFileSync(opsTarget, 'utf8') : '';
  /*
   * 【不再按"任一文件已有标记"整段跳过（2026-11-07）】站点会继续增加（view / view-profile /
   * registry / git…），旧判据只要 index.js 有标记就 return ⇒ 新加的站点永远注入不进去
   * （上一轮 operations 的 view 桥、这一轮 viewProfilePackage 都被它挡过）。
   * 现在逐个站点按自己的 tag 判重（见下面的循环），这里只保留"文件是否可读"的检查。
   */
  const sites = [
    {
      what: 'view（pnpm view → /dshm-registry/view）',
      file: 'index',
      tag: 'view',
      re: /([ \t]*)if \(parsed\.kind !== "registry"\) return void 0;\n([ \t]*)const viewed = await execa\(options\.command \?\? "pnpm", \[/,
      make: (u1, u2) => [
        `${u1}/* ${MARK}:view —— 手持档 execa(pnpm) 必 EACCES；改走 Host 进程内 registry 通道。 */`,
        `${u1}{`,
        `${u2}  const dshmBridge = await import("@deepseek-ai/dshm-profile-pnpm");`,
        `${u2}  const dshmViewed = await dshmBridge.bridgeViewProfilePackage(dir, parsed.spec, options, environment);`,
        `${u2}  if (dshmViewed !== undefined) {`,
        `${u2}    if (dshmViewed.exitCode === 0) return JSON.parse(dshmViewed.stdout);`,
        `${u2}    throw new Error(dshmViewed.stderr || "无法获取插件信息（进程内 registry 通道）");`,
        `${u2}  }`,
        `${u1}}`,
        `${u1}const viewed = await execa(options.command ?? "pnpm", [`,
      ].join('\n'),
    },
    {
      what: 'view（operations 入口：pnpm view → /dshm-registry/view）',
      file: 'operations',
      tag: 'view-operations',
      re: /([ \t]*)if \(parsed\.kind !== 'registry'\)\n[ \t]*return undefined;\n([ \t]*)const viewed = await execa\(options\.command \?\? 'pnpm', \[/,
      make: (u1, u2) => [
        `${u1}/* ${MARK}:view-operations —— 与 lib/index.js 同源的第二份实现（CLI/operations 入口），
	          手持档 execa(pnpm) 必 EACCES；同样改走 Host 进程内 registry 通道。 */`,
        `${u1}{`,
        `${u2}  const dshmBridge = await import("@deepseek-ai/dshm-profile-pnpm");`,
        `${u2}  const dshmViewed = await dshmBridge.bridgeViewProfilePackage(dir, parsed.spec, options, environment);`,
        `${u2}  if (dshmViewed !== undefined) {`,
        `${u2}    if (dshmViewed.exitCode === 0) return JSON.parse(dshmViewed.stdout);`,
        `${u2}    throw new Error(dshmViewed.stderr || "无法获取插件信息（进程内 registry 通道）");`,
        `${u2}  }`,
        `${u1}}`,
        `${u1}const viewed = await execa(options.command ?? 'pnpm', [`,
      ].join('\n'),
    },
    {
      what: 'viewProfilePackage（插件页「无法获取插件信息」的真正 spawn 点）',
      file: 'index',
      tag: 'view-profile',
      /* 【必须在注入里**逐字回写函数头**】锚点包含 `async function viewProfilePackage(…) {`，
         只回写它之后的内容 = 把函数头删掉 ⇒ 函数体掉到模块作用域、`return` 出现在函数外
         ⇒ 整个模块 SyntaxError ⇒ 三端 `tool-plugin-manager` 一直 `waiting for pluginManager`
         （2026-11-07 20:07 真机 P0，见 docs/395）。 */
      re: /([ \t]*)((?:export )?async function viewProfilePackage\(dir, spec, options\) \{)\n([ \t]*)const result = await execa\(options\.command \?\? (["'])pnpm\4, \[/,
      make: (u1, header, u2, q) => [
        `${u1}${header}`,
        `${u2}/* ${MARK}:view-profile —— 插件页 inspect() 走这里；手持档 execa(pnpm) 必 EACCES，改走进程内 registry 通道。 */`,
        `${u2}{`,
        `${u2}  const dshmBridge = await import("@deepseek-ai/dshm-profile-pnpm");`,
        `${u2}  const dshmViewed = await dshmBridge.bridgeViewProfilePackage(dir, spec, options, process.env);`,
        `${u2}  if (dshmViewed !== undefined) return dshmViewed;`,
        `${u2}}`,
        `${u2}const result = await execa(options.command ?? ${q}pnpm${q}, [`,
      ].join('\n'),
    },
    {
      what: 'viewProfilePackage（operations 入口的同源实现）',
      file: 'operations',
      tag: 'view-profile-operations',
      re: /([ \t]*)((?:export )?async function viewProfilePackage\(dir, spec, options\) \{)\n([ \t]*)const result = await execa\(options\.command \?\? (["'])pnpm\4, \[/,
      make: (u1, header, u2, q) => [
        `${u1}${header}`,
        `${u2}/* ${MARK}:view-profile-operations —— 同源第二份；插件页 inspect() 若走 operations 入口也走进程内通道。 */`,
        `${u2}{`,
        `${u2}  const dshmBridge = await import("@deepseek-ai/dshm-profile-pnpm");`,
        `${u2}  const dshmViewed = await dshmBridge.bridgeViewProfilePackage(dir, spec, options, process.env);`,
        `${u2}  if (dshmViewed !== undefined) return dshmViewed;`,
        `${u2}}`,
        `${u2}const result = await execa(options.command ?? ${q}pnpm${q}, [`,
      ].join('\n'),
    },
    {
      what: 'registry（pnpm config get registry → installer.json / 默认源）',
      file: 'index',
      tag: 'registry',
      re: /([ \t]*)async function readProfileRegistry\(dir, options\) \{\n([ \t]*)const result = await execa\(options\.command \?\? "pnpm", \[/,
      make: (u1, u2) => [
        `${u1}async function readProfileRegistry(dir, options) {`,
        `${u2}/* ${MARK}:registry */`,
        `${u2}{`,
        `${u2}  const dshmBridge = await import("@deepseek-ai/dshm-profile-pnpm");`,
        `${u2}  const dshmRegistry = dshmBridge.bridgeReadProfileRegistry(dir, process.env);`,
        `${u2}  if (dshmRegistry !== undefined) return dshmRegistry;`,
        `${u2}}`,
        `${u2}const result = await execa(options.command ?? "pnpm", [`,
      ].join('\n'),
    },
    {
      what: 'git 预检（git ls-remote → 跳过，交给进程内安装器）',
      file: 'index',
      tag: 'git-preflight',
      re: /([ \t]*)async function checkGithubConnection\(spec, dir, options\) \{\n/,
      make: (u1) => [
        `${u1}async function checkGithubConnection(spec, dir, options) {`,
        `${u1}  /* ${MARK}:git-preflight */`,
        `${u1}  {`,
        `${u1}    const dshmBridge = await import("@deepseek-ai/dshm-profile-pnpm");`,
        `${u1}    if (dshmBridge.shouldSkipGithubConnection(spec, process.env) === true) return void 0;`,
        `${u1}  }`,
      ].join('\n') + '\n',
    },
  ];
  for (const site of sites) {
    const onOps = site.file === 'operations';
    const buf = onOps ? opsText : text;
    if (buf.length === 0) {
      die(`插件检查通道补丁：缺文件（${site.what}）`);
    }
    if (buf.includes(`${MARK}:${site.tag}`)) {
      log(`[pack-core]   ${site.what} 已注入（跳过）`);
      continue;
    }
    const matched = site.re.exec(buf);
    if (matched === null) {
      die(`插件检查通道补丁：找不到锚点（${site.what}）—— 上游结构变化？拒绝静默跳过`);
    }
    const injection = site.make(...matched.slice(1).map((v) => (v === undefined ? '' : v)));
    const next = buf.replace(site.re, () => injection);
    if (onOps) { opsText = next; } else { text = next; }
    log(`[pack-core]   插件检查通道：${site.what} 已注入`);
  }
  writeFileSync(target, text, 'utf8');
  if (opsText.length > 0) {
    writeFileSync(opsTarget, opsText, 'utf8');
  }
  /*
   * 【语法守卫（2026-11-07 P0 之后加）】注入型补丁改的是**正在被加载的模块**：一旦
   * 括号/函数头被破坏，端侧表现为 `tool-plugin-manager … waiting for pluginManager`，
   * 三端全崩，而纯文本门禁看不出来。这里直接用 node 自己的解析器验一遍，失败就 die。
   */
  for (const f of [target, opsTarget]) {
    if (!existsSync(f)) {
      continue;
    }
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) {
      die(`插件检查通道补丁：${f} 注入后语法不通过 —— ${String(r.stderr || '').split('\n').slice(0, 4).join(' ')}`);
    }
    log(`[pack-core]   插件检查通道：${basename(f)} 语法自检通过`);
  }
}

function patchProfilePnpmBridge() {
  const MARK = 'DSHM_PROFILE_PNPM_BRIDGE';
  const libDir = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-plugin-manager', 'lib');
  const sites = [
    {
      rel: join('types', 'operations.js'),
      /*
       * 【2026-10-16 升级 alpha.4 的教训】锚点原来写成**精确字符串**（4 空格缩进 + 无 await），
       * 而上游只是加了 `await`、缩进从 4 空格变 8 空格 ⇒ 补丁直接 die（"拒绝静默跳过"是对的，
       * 但代价是每换一版都要手改）。改成**形状正则**：缩进取捕获组、`await` 可选，
       * 既兼容 0.2.1-alpha.2 的老形态，也兼容 alpha.3+ 的新形态。
       */
      re: /([ \t]*)if \(preflight\.length > 0\)\n[ \t]*return (?:await )?rejected\(preflight, 'nothing was installed'\);\n/,
    },
    {
      rel: 'index.js',
      re: /([ \t]*)if \(preflight\.length > 0\)[ \t]*return (?:await )?rejected\(preflight, "nothing was installed"\);\n/,
    },
  ];
  for (const site of sites) {
    const target = join(libDir, site.rel);
    if (!existsSync(target)) {
      die(`profile 包通道补丁：找不到 ${target}`);
    }
    const text = readFileSync(target, 'utf8');
    if (text.includes(MARK)) {
      log(`[pack-core]   profile 包通道补丁已存在（跳过）：${site.rel}`);
      continue;
    }
    const matched = site.re.exec(text);
    if (matched === null) {
      die(`profile 包通道补丁：${site.rel} 里找不到 preflight/`
        + '`nothing was installed` 锚点（上游结构变化？），拒绝静默跳过');
    }
    const injection = profilePnpmBridgeInjection(matched[1]);
    writeFileSync(target, text.replace(site.re, (whole) => whole + injection), 'utf8');
    log(`[pack-core]   profile 包通道：${site.rel} 已注入 runProfilePnpm 的进程内分叉`);
  }
}

/**
 * 生成 `runProfilePnpm()` 里的进程内分叉段（见 `patchProfilePnpmBridge()` 的注释）。
 *
 * 注入点必须同时满足三件事：兼容性预检与 profile 清单快照**都已做完**（回滚语义不变）、
 * `execa` **还没被调用**、以及 `log`/`append`/`output`/`truncated`/`logPath`/`incompatible`
 * 都已在作用域内 —— 接管分支据此合成**与 execa 路径完全相同的返回形状**，写进同一份
 * `.plugin-manager/logs/operation-<id>/pnpm.log`，上游"失败 ⇒ `throw new Error(output)`"
 * 的链路一个字都不用改。
 *
 * 桥自己先同步探一次 `bin/pnpm --version`（与市场桥同判据）：能跑就返回 `undefined`
 * ⇒ 这里原样继续走 `execa`，PC/2in1 档因此**行为一个字节不变**。
 * @param unit 该文件的一级缩进（上游两份产物分别是 4 空格与 tab）
 * @returns 直接拼在锚点之后的源码片段（以换行结尾）
 */
function profilePnpmBridgeInjection(unit) {
  const i1 = unit;
  const i2 = unit + unit;
  const i3 = i2 + unit;
  const i4 = i3 + unit;
  return [
    `${i1}/* DSHM_PROFILE_PNPM_BRIDGE: 端侧（手机/平板档）没有任何可 execve 的 shell，execa(pnpm) 必 EACCES。`,
    `${i2}上游的 packageManager 钩子只能换"spawn 哪个可执行文件"，本档任何 command 都点不着火`,
    `${i2}⇒ 必须在这里分叉：探针判"随包假壳跑不起来"时改走 Host 进程内的安装队列`,
    `${i2}（与市场桥同一协议、同一判据、同一个 dshm-installer）。`,
    `${i2}返回 undefined = 不接管、照旧 spawn（PC/2in1 档就是这条）⇒ 已验收链路零变化。`,
    `${i2}实现见 hostcore/plugins/dshm-profile-pnpm/。 */`,
    `${i1}{`,
    `${i2}const dshmPnpm = await import("@deepseek-ai/dshm-profile-pnpm");`,
    `${i2}const bridged = await dshmPnpm.bridgeRunProfilePnpm(args, {`,
    `${i3}dir, signal: options.signal,`,
    `${i2}});`,
    `${i2}if (bridged !== undefined) {`,
    `${i3}if (bridged.text.length > 0) {`,
    `${i4}const bridgedBytes = Buffer.from(bridged.text, "utf8");`,
    `${i4}await log.write(bridgedBytes);`,
    `${i4}options.onOutput?.(bridged.text, bridged.exitCode === 0 ? "stdout" : "stderr");`,
    `${i4}append(bridgedBytes);`,
    `${i3}}`,
    `${i3}await log.close();`,
    `${i3}/* incompatible 必须**非空才带**：上游 execa 路径的收尾也是"非空才带上它"，`,
    `${i4}而 installBundle 那侧只看"这个字段在不在"（在就抛 incompatible-version）。`,
    `${i4}无条件带上空数组 ⇒ 任意失败（404/网络/权限）都被改判成"版本不兼容"（+dshm.49 真机 P0）。 */`,
    `${i3}return { exitCode: bridged.exitCode, output: output.toString("utf8"), truncated, logPath, ...incompatible.length > 0 ? { incompatible } : {} };`,
    `${i2}}`,
    `${i1}}`,
    '',
  ].join('\n');
}

/**
 * GitHub 安装地址归一化（2026-10-14，+dshm.48）。
 *
 * 【用户报】手机/PC 的「设置 → 插件 → 项目地址安装」粘贴 **GitHub 地址**时报
 * 「无法识别这个包名或地址」（`pluginManager/inspect` → `refused/invalid-spec`）；
 * 而手打 `owner/repo`、`github:owner/repo` 反而能装。
 *
 * 【根因】闸门只有一个 `HOSTED_REPOSITORY_URL`
 * （`/^https?:\/\/[^/]+\/[^/]+\/[^/#]+(?:\.git)?(?:#.*)?$/i`）—— **恰好两段路径**。
 * 而从浏览器地址栏复制的地址几乎总是页面路径：
 *   · `…/o/r/tree/main[/sub]`（看分支/子目录）—— 三段以上 ⇒ 直接拒；
 *   · `…/o/r/`（尾斜杠）—— 该正则不容尾斜杠 ⇒ 拒；
 *   · `…/o/r?tab=readme-ov-file`（点过 README 页签）—— `?` 落在 `[^/#]` 里 ⇒ 被并进
 *     **仓库名** ⇒ 即使侥幸过关，pnpm 也会去拉 `r?tab=…` 而 404（拒得更晚、报错更难懂）；
 *   · `o/r`（简写）—— 落进 `PACKAGE_NAME` 判据 ⇒「不是注册表接受的包名」。
 * 真机实证（fport 直打 `pluginManager/inspect`，+dshm.47）：`/tree/main`、尾斜杠、`o/r`
 * 三种形态全 `refused/invalid-spec`；两段式 `https://github.com/o/r`、`github:o/r`、
 * `.git`、`#ref` 本来就过。
 *
 * 【修法】在**解析入口**把 GitHub 系的页面地址折回 pnpm 的规范形态
 * `github:o/r[#ref][&path:/sub]`：
 *   · 上游判的是"包名/地址形态"，页面段在它眼里全是噪声 ⇒ 归一化后原样通过；
 *   · `&path:` 是 pnpm **自己**的规范拼法（`parseGitParams` 按 `&` 拆 committish 里的
 *     `path:` 前缀）⇒ PC 档直跑 pnpm 吃得下；
 *   · 端侧（手机/平板）走的是进程内安装通道 `hostcore/app/dshm-installer.js`，它的
 *     `parseGitHub()` 认的正是这一形态 ⇒ 两端同一份 spec，不多造第二种格式。
 *
 * 【边界】只做"放行 + 规范化"，且只碰 GitHub 系（`github.com` 页面地址 / `github:` 简写 /
 * `owner/repo` 简写）。npm 名、绝对路径、`file:`/`link:`、tarball、gitlab/bitbucket/gist
 * 简写、`git+ssh`/`git@…` scp 形态 **一个字节都不改**（原样返回，语义零变化）。
 *
 * 【两个站点】上游一次构建出两份实现（与 ⑬ 同族）：
 *   · `lib/index.js` —— 包 main，**服务/Web 侧真正走的那份**：它内联了一份
 *     `parseInstallSpec`，且 `inspect()` / `installBundle()` 各自把**原始 spec** 再交给
 *     `checkGithubConnection(parsedForRegistry(spec), …)` 与 `runPnpm(["add", spec, …])`
 *     ⇒ 三个锚点都要归一（只改 parse 内部不够：pnpm argv 与连接检查用的都是入口那个变量）；
 *   · `lib/types/install-spec.js` —— `operations` / `types` 两个入口共用的解析器
 *     （`import { parseInstallSpec } from "./install-spec.js"`）⇒ 改这一处，CLI 那侧一致。
 */
function patchInstallSpecNormalize() {
  const MARK = 'DSHM_INSTALL_SPEC_NORMALIZE';
  const libDir = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-plugin-manager', 'lib');
  const sites = [
    {
      rel: 'index.js',
      indent: '\t',
      parseHead: 'function parseInstallSpec(raw) {\n\tconst spec = raw.trim();\n',
      parseHeadPatched: 'function parseInstallSpec(raw) {\n\tconst spec = dshmNormalizeInstallSpec(raw);\n',
      entryHeads: [
        '\t\tasync inspect(spec, options, signal) {\n\t\t\tlet parsed;\n',
        '\t\tinstallBundle(spec, options) {\n\t\t\tconst requestId = options?.requestId;\n',
      ],
    },
    {
      rel: join('types', 'install-spec.js'),
      indent: '    ',
      parseHead: 'export function parseInstallSpec(raw) {\n    const spec = raw.trim();\n',
      parseHeadPatched: 'export function parseInstallSpec(raw) {\n    const spec = dshmNormalizeInstallSpec(raw);\n',
      entryHeads: [],
    },
  ];
  for (const site of sites) {
    const target = join(libDir, site.rel);
    if (!existsSync(target)) die(`安装地址归一化补丁：找不到 ${target}`);
    let text = readFileSync(target, 'utf8');
    if (text.includes(MARK)) {
      log(`[pack-core]   安装地址归一化已存在（跳过）：${site.rel}`);
      continue;
    }
    if (!text.includes(site.parseHead)) {
      die(`安装地址归一化补丁：${site.rel} 里找不到 parseInstallSpec 的头部锚点`
        + '（上游结构变化？），拒绝静默跳过');
    }
    for (const head of site.entryHeads) {
      if (!text.includes(head)) {
        die(`安装地址归一化补丁：${site.rel} 里找不到入口锚点 `
          + `${JSON.stringify(head.slice(0, 48))}…（上游结构变化？），拒绝静默跳过`);
      }
    }
    const helper = installSpecNormalizeHelper()
      .split('\n').map((line) => (line === '' ? line : site.indent + line)).join('\n');
    text = text.replace(site.parseHead, helper + '\n' + site.parseHeadPatched);
    const call = site.indent + site.indent + site.indent + 'spec = dshmNormalizeInstallSpec(spec);\n';
    for (const head of site.entryHeads) text = text.replace(head, head + call);
    writeFileSync(target, text, 'utf8');
    log(`[pack-core]   安装地址归一化：${site.rel} 已注入`
      + `（parseInstallSpec + ${site.entryHeads.length} 个入口）`);
  }
}

/**
 * 生成插进 `parseInstallSpec()` 之前的那份归一化源码（见 `patchInstallSpecNormalize()`）。
 *
 * 用 `String.raw` 是为了让正则里的 `\s` / `\/` **逐字**落进目标文件（普通字符串要写成
 * `\\s`，抄改一次就错一次）；片段本身零依赖：只用字符串与正则内建，不 import 任何东西
 * —— 目标文件在**模块求值期**就要解析它，不能引入解析顺序上的新耦合。
 * @returns 未缩进的源码片段（不含尾部换行）。
 */
function installSpecNormalizeHelper() {
  return String.raw`/* DSHM_INSTALL_SPEC_NORMALIZE: GitHub 安装地址归一化（tools/pack-core.mjs 的
 * patchInstallSpecNormalize() 注入；设计说明见那份注释）。
 *   https://github.com/o/r/tree/main/sub        → github:o/r#main&path:/sub
 *   https://github.com/o/r/blob/main/a/b/x.md   → github:o/r#main&path:/a/b
 *   https://github.com/o/r/releases/tag/v1.2.3  → github:o/r#v1.2.3
 *   https://github.com/o/r?tab=readme-ov-file   → github:o/r
 *   https://github.com/o/r/  ·  github.com/o/r  ·  o/r  ·  github:o/r#main&path:/sub
 * 非 GitHub 形态（npm 名 / 绝对路径 / file: / link: / tarball / gitlab·bitbucket·gist /
 * git+ssh / git@…) 原样返回；产出形态是 pnpm 自己的 github:o/r[#ref][&path:/sub]。
 * 【注意】这份片段是用反引号模板承载的 ⇒ 正文里**不许出现反引号**（会被提前闭合），
 * 也不许出现"美元 + 花括号"的插值起手；两者都有 tools/check-install-spec-normalize.mjs 盯着。 */
function dshmNormalizeInstallSpec(raw) {
	if (typeof raw !== "string") return raw;
	const typed = raw.trim();
	if (typed === "" || typed.startsWith("-")) return typed;
	/* ① 先摘子目录（'&path:' / '?path=' / '#path:' 三种拼法都认；值到下一个分隔符为止，
	 * 所以两种先后顺序都能切对 —— 与 hostcore/app/dshm-installer.js 的 parseGitHub() 同序）。 */
	let base = typed;
	let sub = "";
	const pathAt = /[&?#]path[:=]([^#&?\s]*)/.exec(base);
	if (pathAt !== null) {
		sub = pathAt[1].trim();
		base = base.slice(0, pathAt.index) + base.slice(pathAt.index + pathAt[0].length);
	}
	/* ② 再摘 ref（'#' 之后到下一个分隔符为止）。 */
	let ref = "";
	const hashAt = base.indexOf("#");
	if (hashAt >= 0) {
		const rest = base.slice(hashAt + 1);
		const stop = rest.search(/[&?\s]/);
		ref = (stop >= 0 ? rest.slice(0, stop) : rest).trim();
		base = base.slice(0, hashAt) + (stop >= 0 ? rest.slice(stop) : "");
	}
	base = base.trim();
	/* ③ 仓库主体只可能是三种 GitHub 形态（带 host 的页面地址 / 'github:' 简写 /
	 * 'owner/repo' 简写）；一种都不是 ⇒ 原样返回，一个字节都不改。
	 * '?' 走到这里只可能是页面参数（?tab=… / ?plain=… / ?q=…）：仓库名不该带上它。 */
	const candidates = [base];
	const queryAt = base.indexOf("?");
	if (queryAt >= 0) candidates.push(base.slice(0, queryAt));
	let match = null;
	for (const candidate of candidates) {
		match = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s?#]+)\/([^\/\s?#]+?)(?:\.git)?(?:\/(.*))?$/i.exec(candidate);
		if (match === null) match = /^github:([^\/\s?#:]+)\/([^\/\s?#:]+?)(?:\.git)?(?:\/(.*))?$/i.exec(candidate);
		if (match === null) match = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([^@\s\/]+?)(?:\.git)?$/.exec(candidate);
		if (match !== null) break;
	}
	if (match === null) return typed;
	/* ④ 页面段 → ref / 子目录。'/blob/<ref>/<file>' 指的是**文件** ⇒ 取它所在目录
	 * （装包要的是目录）；issues / pulls / actions / wiki / settings… 与仓库名无关，丢弃。 */
	let pageRef = "";
	let pagePath = "";
	const page = match[3] === undefined ? "" : match[3].replace(/^\/+/, "");
	if (page !== "") {
		const segments = page.split("/").filter((segment) => segment.length > 0);
		const head = (segments[0] === undefined ? "" : segments[0]).toLowerCase();
		if (head === "tree" || head === "blob") {
			pageRef = segments[1] === undefined ? "" : segments[1];
			const inner = segments.slice(2).join("/");
			pagePath = head === "tree" ? inner : inner.replace(/\/?[^\/]*$/, "");
		}
		else if (head === "releases" && (segments[1] === undefined ? "" : segments[1]).toLowerCase() === "tag") {
			pageRef = segments[2] === undefined ? "" : segments[2];
		}
	}
	if (pageRef !== "") ref = pageRef;
	/* 页面段里跟在 ref 后面的查询串（'/tree/main?tab=x'）不是 ref 的一部分。 */
	if (ref !== "") ref = ref.split(/[&?]/)[0].trim();
	if (sub === "" && pagePath !== "") sub = pagePath;
	sub = sub.split(/[&?]/)[0].trim().replace(/^\.?\//, "").replace(/\/+$/, "");
	return "github:" + match[1] + "/" + match[2]
		+ (ref === "" ? "" : "#" + ref)
		+ (sub === "" ? "" : "&path:/" + sub);
}`;
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
  /*
   * 【2026-11-05 上游 0.2.2-rc.1 迁移】上游把 `createIfAbsent` 收进了 `options`，
   * 且错误文案里的 `createIfAbsent.displayPath` 换成外层变量 `displayPath`：
   *   `if (createIfAbsent !== void 0) try { … }` → `if (options.createIfAbsent) try { … }`
   * 两种形态都保留：新的用于 0.2.2+，旧的用于回退重打 rc.5 的树。
   * 逐个按**逐字原文**试，都不命中才 die —— 绝不静默跳过（真机上会退化成"write 工具 EPERM link"）。
   */
  const VARIANTS = [
    {
      name: '0.2.2-rc.1+（options.createIfAbsent）',
      head: 'options.createIfAbsent',
      display: 'displayPath',
      before: `\t\tif (options.createIfAbsent) try {
\t\t\tawait linkFile(tempPath, absolutePath);
\t\t} catch (error) {
\t\t\tawait throwGuardedCreateFailure(error, absolutePath, displayPath, inspectPublicationTarget);
\t\t}`,
    },
    {
      name: '0.2.1-rc.5 及更早（裸 createIfAbsent）',
      head: 'createIfAbsent !== void 0',
      display: 'createIfAbsent.displayPath',
      before: `\t\tif (createIfAbsent !== void 0) try {
\t\t\tawait linkFile(tempPath, absolutePath);
\t\t} catch (error) {
\t\t\tawait throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);
\t\t}`,
    },
  ];
  const buildAfter = (v) => `\t\tif (${v.head}) {
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
\t\t\t\t\tawait throwGuardedCreateFailure(error, absolutePath, ${v.display}, inspectPublicationTarget);
\t\t\t\t} else {
\t\t\t\t\tlet exists = true;
\t\t\t\t\ttry {
\t\t\t\t\t\tawait inspectPublicationTarget(absolutePath);
\t\t\t\t\t} catch (_absent) {
\t\t\t\t\t\texists = false;
\t\t\t\t\t}
\t\t\t\t\tif (exists) {
\t\t\t\t\t\tawait throwGuardedCreateFailure(error, absolutePath, ${v.display}, inspectPublicationTarget);
\t\t\t\t\t} else {
\t\t\t\t\t\tawait rename(tempPath, absolutePath);
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}`;
  const variant = VARIANTS.find((v) => text.includes(v.before));
  if (!variant) {
    die('fs-local 补丁：上游 writeFileAtomic 的 createIfAbsent 发布段已变化（新旧两种形态都未命中），拒绝静默跳过');
  }
  writeFileSync(target, text.replace(variant.before, buildAfter(variant)), 'utf8');
  log(`[pack-core]   fs-local 补丁：createIfAbsent 发布 link→rename 回退（${variant.name}；鸿蒙禁硬链接）`);
}


/**
 * `dsh-fs-local` 的**权限错误人话化**（真机 P1-2，2026-10-06，见 docs/109）。
 *
 * 【上游行为】读路径上凡是被平台拒的调用，都把 node 的裸错直接上抛：
 *   · `statRegularFile()` 只认 ENOENT（其余 `throw error`）；
 *   · `readFileAbortable()` 只认 abort（其余 `throw error`）。
 * 真机（PC 档）在 `/storage/Users/currentUser/{Documents,Desktop,Download}` 这类受保护用户
 * 目录上拿到的正是裸 `EPERM: operation not permitted, stat/open …` ⇒ 用户与模型都只能猜。
 * 同一棵树里 `listDir` 早就把权限错翻成了 `FS_PERMISSION_DENIED`（`listingIoError()`），
 * 本补丁只是把读路径对齐到那条**上游已有**的口径。
 *
 * 【等价改写】复用上游已有的 `FS_PERMISSION_DENIED` 与同一句文案
 * （`cannot <verb> "<path>": permission denied`）；只翻权限错（EPERM/EACCES），
 * 其余错误（not-found 的 FS_NOT_FOUND、abort 的 FS_ABORTED）逐字不动。
 * `readFileAbortable()` 因此多收一个 `displayPath`（调用方共两处，都已带上），只用于报错文案。
 *
 * 【幂等/防呆】逐站点判断：上游片段还在就替换；片段不在而注入形态在 = 已打过（跳过）；
 * 两者都不在 = `die()`。末尾再核对标记总数 —— 上游改结构必须当场暴露在打包期，
 * 而不是静默失效成「真机又是裸 EPERM」（那种回归只能靠用户复现）。
 */
/**
 * `dsh-agent-instructions` 的**向上找项目根**必须容忍「允许面之外」的探测（P0，2026-10-10）。
 *
 * 【根因】上游按 `projectRootMarkers`（默认 `['.git']`）从会话 cwd **逐级向上**探
 * `<dir>/.git`（`findProjectRoot()` → `existsAsMarker()`），而 `existsAsMarker()` 只把
 * **`FS_NOT_FOUND`** 当成"这里没有标记"，其余一律 `throw`（它要的是"探针坏了就得响"）。
 * 我们这一层加的访问范围闸门（docs/137）对允许面之外的路径抛 **`FS_PERMISSION_DENIED`**
 * ⇒ 这条向上走的路在**边界那一跳**上炸掉，而它是在 `compose()` 里被 await 的
 * （`agent/pre-step` 钩子，无人捕捉）⇒ **整轮直接失败**，面板上就是那句闸门文案：
 *   `路径在 DSHM 的允许范围之外，已拒绝访问：/storage/Users/.git`
 *
 * 【为什么恰好是这条路径】真机（PC 档）实测：默认工作区
 * `/storage/Users/currentUser/Download/com.dshm.dshclient` 一路向上都没有 `.git`，
 * 于是探测依次 `/storage/Users/currentUser/Download/.git`（面内，FS_NOT_FOUND ⇒ 继续）
 * → `/storage/Users/currentUser/.git`（同上）→ **`/storage/Users/.git`**（面外 ⇒ 闸门拒绝 ⇒ 炸）。
 * `/storage/Users` 本身存在（`lstat` 通）但 `listdir` 是 `EPERM`（app 身份实测）
 * ⇒ 它不是 `currentUser` 的别名，而是**同级的别人的目录** ⇒ **闸门判得对**，
 * 错的是"把探针问到面外还当成致命错"。
 *
 * 【改法】`existsAsMarker()` 的 catch 里把**允许面之外的探测**当成"这里没有标记"
 * （返回 false，继续向上；走到 `/` 后由上游自己 `return resolve(cwd)` 收尾），
 * 判据只加一条 `error.code === "FS_PERMISSION_DENIED"`（闸门唯一的拒绝码，不 import 闸门）。
 * **不改闸门本身**：模型/工具主动要面外内容的读与写照样 `FS_PERMISSION_DENIED`（docs/137 不变）。
 */
function patchAgentInstructionsScopeWalk() {
  const target = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-agent-instructions', 'lib', 'index.js');
  if (!existsSync(target)) {
    die(`项目根探测容忍补丁：找不到 ${target}`);
  }
  const MARK = 'DSHM_SCOPE_WALK_TOLERANT';
  const sites = [
    {
      why: 'existsAsMarker 旁的判据助手（只认闸门的拒绝码，不 import 闸门）',
      before: [
        'function isMissingProviderPathError(error) {',
        '\treturn error instanceof Error && "code" in error && error.code === "FS_NOT_FOUND";',
        '}',
      ].join('\n'),
      after: [
        'function isMissingProviderPathError(error) {',
        '\treturn error instanceof Error && "code" in error && error.code === "FS_NOT_FOUND";',
        '}',
        '/*',
        ' * 【DSHM 端侧补丁 2026-10-10（DSHM_SCOPE_WALK_TOLERANT）】同族判据：**允许面之外**的探测。',
        ' * 拒绝码就是 docs/137 的 fs-fence.js 用的那个 `FS_PERMISSION_DENIED`（它只有一个码）。',
        ' * 这里**不 import** 闸门（上游文件不依赖端侧插件），只认码。',
        ' */',
        'function isScopeDeniedProviderPathError(error) {',
        '\treturn error instanceof Error && "code" in error && error.code === "FS_PERMISSION_DENIED";',
        '}',
      ].join('\n'),
    },
    {
      why: 'existsAsMarker：面外探测 ⇒ 当作"这里没有标记"（原来是把整轮打成失败）',
      before: [
        'async function existsAsMarker(path, fileSystem, signal) {',
        '\tif (fileSystem !== void 0) try {',
        '\t\tconst target = await fileSystem.resolve(path, signalOptions(signal));',
        '\t\treturn await fileSystem.stat(target, signal) !== void 0;',
        '\t} catch (error) {',
        '\t\tsignal?.throwIfAborted();',
        '\t\tif (isMissingProviderPathError(error)) return false;',
        '\t\tthrow error;',
        '\t}',
      ].join('\n'),
      after: [
        'async function existsAsMarker(path, fileSystem, signal) {',
        '\tif (fileSystem !== void 0) try {',
        '\t\tconst target = await fileSystem.resolve(path, signalOptions(signal));',
        '\t\treturn await fileSystem.stat(target, signal) !== void 0;',
        '\t} catch (error) {',
        '\t\tsignal?.throwIfAborted();',
        '\t\t/*',
        '\t\t * 【DSHM 端侧补丁 2026-10-10（DSHM_SCOPE_WALK_TOLERANT）】上游只认 `FS_NOT_FOUND`，',
        '\t\t * 而允许面之外的探测带的是 `FS_PERMISSION_DENIED`（真机：`/storage/Users/.git`）',
        '\t\t * ⇒ 原来一律 `throw`，等于把"向上找项目根"变成整轮失败。',
        '\t\t * 语义：这一问是"此处有没有标记"⇒ 无权看就是**没有**，继续向上；到 `/` 之后',
        '\t\t * 由 findProjectRoot() 自己 `return resolve(cwd)` 收尾（上游既有兜底）。',
        '\t\t * 只多认这一个码：其余错误（含取消）照旧上抛。',
        '\t\t */',
        '\t\tif (isMissingProviderPathError(error) || isScopeDeniedProviderPathError(error)) return false;',
        '\t\tthrow error;',
        '\t}',
      ].join('\n'),
    },
  ];
  let text = readFileSync(target, 'utf8');
  let patched = 0;
  for (const site of sites) {
    // 幂等判据必须先看 after：本函数 site① 的 after 是"before + 追加块"（before 是 after 的
    // 前缀），若先按 before 计数会得到 1 并**重复注入**（实测 2→3 处标记后判红）。
    if (text.includes(site.after)) continue; // 已打过（幂等）
    const times = text.split(site.before).length - 1;
    if (times === 0) {
      die(`项目根探测容忍补丁：未找到待替换片段（${site.why}）—— 上游结构变化？拒绝静默跳过`);
    }
    if (times !== 1) {
      die(`项目根探测容忍补丁：待替换片段出现 ${times} 次（${site.why}）—— 判据不再唯一，拒绝静默乱改`);
    }
    text = text.split(site.before).join(site.after);
    patched += 1;
  }
  if (patched === 0) {
    log('[pack-core]   项目根探测容忍补丁已存在（跳过）');
    return;
  }
  const marks = text.split(MARK).length - 1;
  if (marks !== sites.length) {
    die(`项目根探测容忍补丁：标记 ${MARK} 应出现 ${sites.length} 次，实际 ${marks} 次 —— 补丁不完整，拒绝出包`);
  }
  writeFileSync(target, text, 'utf8');
  log(`[pack-core]   项目根探测容忍补丁：面外探测不再炸 agent/pre-step（${marks} 处）`);
}

function patchFsLocalPermissionHint() {
  const target = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-fs-local', 'lib', 'index.js');
  if (!existsSync(target)) {
    die(`fs-local 权限文案补丁：找不到 ${target}`);
  }
  /*
   * 注入文本一律用**单引号**串拼（不用模板串）：里面既有反向引号又有 ${…}，
   * 模板串会在这里被就地求值（实测炸过），单引号串才是"逐字写进树里"。
   */
  const MARK = 'DSHM_FS_LOCAL_PERMISSION_HINT';
  if (['0.2.2-rc.2', '0.2.2-rc.3', '0.2.2-rc.4', '0.2.2-rc.5', '0.2.3-alpha.2'].includes(recipe.coreVersion.split('+')[0])) {
    const text = readFileSync(target, 'utf8');
    /*
     * 0.2.3-alpha.2 upstream trimmed dsh-fs-local import (removed unused FsTargetKey /
     * FsVersion). All other errno-normalization anchors are byte-identical. Accept exactly
     * two verified import shapes; anything else still dies below.
     */
    const importAnchor = recipe.coreVersion.split('+')[0] === '0.2.3-alpha.2'
      ? 'import { FileSystem, FsError, fsErrorFromErrno } from "@deepseek-ai/dsh-fs";'
      : 'import { FileSystem, FsError, FsTargetKey, FsVersion, fsErrorFromErrno } from "@deepseek-ai/dsh-fs";';
    const nativeSites = [
      importAnchor,
      '\t\tinfo = await stat(target.targetKey);\n\t} catch (error) {\n\t\tthrow fsErrorFromErrno(verb, target.displayPath, error);',
      'async function readFileAbortable(absolutePath, displayPath, verb, signal) {',
      '\t\tif (isAbortError(error)) throw new FsError(`${verb} aborted`, "FS_ABORTED");\n\t\tthrow fsErrorFromErrno(verb, displayPath, error);',
      '\tconst raw = await readFileAbortable(target.targetKey, target.displayPath, "read", signal);',
      '\tconst buffer = await readFileAbortable(absolutePath, displayPath, "edit", signal);',
    ];
    const shared = readFileSync(join(STAGE, 'node_modules/@deepseek-ai/dsh-fs/lib/index.js'), 'utf8');
    const errnoSites = [
      'case "EACCES":\n\t\tcase "EPERM": return new FsError(`${failure}: permission denied`, "FS_PERMISSION_DENIED", { cause: error });',
      'default: return new FsError(`${failure}: ${error.message}`, "FS_IO_ERROR", { cause: error });',
    ];
    if (text.includes(MARK) || nativeSites.some((lit) => !text.includes(lit)) || errnoSites.some((lit) => !shared.includes(lit))) {
      die('fs-local 权限文案：rc.2 原生 errno 归一化契约不完整或混入旧注入，拒绝覆盖上游');
    }
    log('[pack-core]   fs-local 权限文案：rc.2 原生 stat/read/edit errno 归一化已核实，无需注入');
    return;
  }
  const sites = [
    {
      why: 'statRegularFile：stat 被拒 ⇒ FS_PERMISSION_DENIED',
      before: [
        '\t\t/* v8 ignore next 2 -- a non-ENOENT stat failure needs a permission/IO fault; only the not-found path is reachable in tests. */',
        '\t\tif (!isENOENT(error)) throw error;',
        '\t\tthrow new FsError(`cannot ${verb} "${target.displayPath}": not found`, "FS_NOT_FOUND");',
      ].join('\n'),
      after: [
        '\t\t/*',
        '\t\t * 【DSHM 端侧补丁 2026-10-06（DSHM_FS_LOCAL_PERMISSION_HINT）】上游把 stat 的裸 errno 直接上抛：',
        '\t\t * 真机（PC 档）在受保护的用户目录上得到 `EPERM: operation not permitted, stat …`。',
        '\t\t * 这里复用上游**已有**的 FS_PERMISSION_DENIED（listingIoError() 早就在用这个码），',
        '\t\t * 文案与 `cannot list "…": permission denied` 同一口径；其余错误原样上抛。',
        '\t\t * v8 ignore next 3 -- 需要一次 stat 的权限/IO 故障；测试里只覆盖 not-found 那条。',
        '\t\t */',
        '\t\tif (isPermissionError(error)) throw new FsError(`cannot ${verb} "${target.displayPath}": permission denied`, "FS_PERMISSION_DENIED", { cause: error });',
        '\t\tif (!isENOENT(error)) throw error;',
        '\t\tthrow new FsError(`cannot ${verb} "${target.displayPath}": not found`, "FS_NOT_FOUND");',
      ].join('\n'),
    },
    {
      why: 'readFileAbortable：open/read 被拒 ⇒ FS_PERMISSION_DENIED（并多收 displayPath）',
      before: [
        'async function readFileAbortable(absolutePath, verb, signal) {',
        '\ttry {',
        '\t\treturn await readFile(absolutePath, signal ? { signal } : {});',
        '\t} catch (error) {',
        '\t\t/* v8 ignore next 2 -- a non-abort readFile rejection needs a permission/IO fault racing an open file. */',
        '\t\tif (!isAbortError(error)) throw error;',
        '\t\tthrow new FsError(`${verb} aborted`, "FS_ABORTED");',
        '\t}',
        '}',
      ].join('\n'),
      after: [
        '/*',
        ' * 【DSHM 端侧补丁 2026-10-06（DSHM_FS_LOCAL_PERMISSION_HINT）】多收的 displayPath 只为把',
        ' * 「读被拒」讲清楚（见下面 catch 的权限分支）；调用方只有 readWholeText() 与 readForEdit()',
        ' * 两处，都已带上。',
        ' */',
        'async function readFileAbortable(absolutePath, verb, signal, displayPath) {',
        '\ttry {',
        '\t\treturn await readFile(absolutePath, signal ? { signal } : {});',
        '\t} catch (error) {',
        '\t\t/*',
        '\t\t * 【DSHM 端侧补丁 2026-10-06】上游在这里只认 abort；权限错（真机 PC 档：',
        '\t\t * `EPERM: operation not permitted, open …`）会裸着上抛 ⇒ 先翻权限、再判 abort，其余原样上抛。',
        '\t\t * v8 ignore next 3 -- 需要一次 open/read 的权限故障；测试里只覆盖 abort 那条。',
        '\t\t */',
        '\t\tif (isPermissionError(error)) throw new FsError(`cannot ${verb} "${displayPath}": permission denied`, "FS_PERMISSION_DENIED", { cause: error });',
        '\t\tif (!isAbortError(error)) throw error;',
        '\t\tthrow new FsError(`${verb} aborted`, "FS_ABORTED");',
        '\t}',
        '}',
      ].join('\n'),
    },
    {
      why: 'readWholeText 的调用点：补上 displayPath',
      before: '\tconst raw = await readFileAbortable(target.targetKey, "read", signal);',
      after: '\tconst raw = await readFileAbortable(target.targetKey, "read", signal, target.displayPath); /* DSHM_FS_LOCAL_PERMISSION_HINT */',
    },
    {
      why: 'readForEdit 的调用点：补上 displayPath',
      before: '\tconst buffer = await readFileAbortable(absolutePath, "edit", signal);',
      after: '\tconst buffer = await readFileAbortable(absolutePath, "edit", signal, displayPath); /* DSHM_FS_LOCAL_PERMISSION_HINT */',
    },
  ];
  let text = readFileSync(target, 'utf8');
  let patched = 0;
  for (const site of sites) {
    // 同 patchAgentInstructionsScopeWalk()：先认 after 再按 before 计数，避免
    // "before 是 after 前缀"时把已打的补丁再打一遍。
    if (text.includes(site.after)) continue; // 已打过（幂等）
    const times = text.split(site.before).length - 1;
    if (times === 0) {
      die(`fs-local 权限文案补丁：未找到待替换片段（${site.why}）—— 上游结构变化？拒绝静默跳过`);
    }
    if (times !== 1) {
      die(`fs-local 权限文案补丁：待替换片段出现 ${times} 次（${site.why}）—— 判据不再唯一，拒绝静默乱改`);
    }
    text = text.split(site.before).join(site.after);
    patched += 1;
  }
  if (patched === 0) {
    log('[pack-core]   fs-local 权限文案补丁已存在（跳过）');
    return;
  }
  const marks = text.split(MARK).length - 1;
  if (marks !== sites.length) {
    die(`fs-local 权限文案补丁：标记 ${MARK} 应出现 ${sites.length} 次，实际 ${marks} 次 —— 补丁不完整，拒绝出包`);
  }
  writeFileSync(target, text, 'utf8');
  log(`[pack-core]   fs-local 权限文案补丁：stat/open 的裸 errno ⇒ FS_PERMISSION_DENIED（${marks} 处）`);
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

// ── ⑥ attachment-local 的失败 cause 必须进报文（2026-10-06）───────────────
/*
 * 【这一组解决什么】附件落盘失败时，`dsh-attachment-local` 的**三处** catch 把真正的 cause
 * （syscall 的 errno / TypeError 正文）包进 `AttachmentError` 的 `options.cause`；而
 * `dsh-client-file-upload/lib/index.js:269` 的 `commit()` 只取 `error.code` 放进 details ⇒
 * 报文里只剩 `{"reason":"ATTACHMENT_WRITE_FAILED"}`，**真因当场丢弃**，连日志都没有一处。
 *
 * 【代价（2026-10-06 实测，见 docs/111）】一个"流式请求体被宿主 fetch 垫片吞掉"的
 * `TypeError: Cannot read properties of undefined (reading 'getReader')`，因为报文与
 * "鸿蒙沙箱禁止 chmod/copyFile"**逐字相同**，被端侧自检报告连续两轮判成"补丁把附件写坏"， 
 * 最后靠 `attachments/v1/tmp` 的 mtime 变化反推失败阶段才定位到真正的组件。
 *
 * 【改法】在最里面那一层就把 cause 的 `code` + `message` 织进 `AttachmentError` 的
 * **message**：该 message 经 `commit()` 原样进 HTTP 响应体的 `error.message`（用户界面与
 * 日志都看得到），同时 `console.error` 落一条宿主日志（`node-output.log` 可 `hdc file recv` 取回）。
 * 不改 code、不改 details 形状、不改控制流 ⇒ `session/attachment-invalid` +
 * `reason=ATTACHMENT_WRITE_FAILED` 这套既有口径**保持不变**，只是**多带一句人话**。
 *
 * 【纪律】与上面所有 patch 一致：不改上游判定逻辑，只改打包产物；找不到片段就 die。
 */
function patchAttachmentLocalCause() {
  const target = join(
    STAGE, 'node_modules', '@deepseek-ai', 'dsh-attachment-local', 'lib', 'index.js',
  );
  if (!existsSync(target)) {
    die(`attachment-local cause 补丁：找不到 ${target}`);
  }
  let text = readFileSync(target, 'utf8');
  /* 独立标记（不复用 DSHM_ATTACHMENT_SANDBOX）：两者的注入时机互不依赖，
   * 树增量复用 + 只升过 ⑪ 的那种旧树不该让本条被静默跳过。 */
  if (text.includes('DSHM_ATTACHMENT_CAUSE')) {
    log('[pack-core]   attachment-local cause 补丁已存在（跳过）');
    return;
  }

  // ① 在 syncDirectory 之前插一个纯函数（模块级函数声明，抛出点都在其后定义，靠提升即可见）。
  const helperAnchor = 'async function syncDirectory(path) {';
  if (!text.includes(helperAnchor)) {
    die('attachment-local cause 补丁：syncDirectory 锚点已变化（未找到待插入位置），拒绝静默跳过');
  }
  /* 生成到端侧的那段源码：**只用字符串拼接**，不在外层模板字面量里再嵌反引号/`${` ——
   * 2026-10-06 踩过一次：嵌进去的转义反引号会把外层模板提前收尾，pack-core 自己
   * `node --check` 仍绿，但生成出来的文件是坏语法（到装机才炸）。 */
  const helper = `/*
 * 【DSHM 端侧补丁 2026-10-06（DSHM_ATTACHMENT_CAUSE）】把真正的失败 cause 织进 message。
 * 原实现把 cause 只挂在 options.cause 上，而唯一的读点（dsh-client-file-upload 的
 * commit()）只取 code ⇒ 报文里丢了 syscall/errno，故障排查只能靠猜。详见 docs/111。
 */
function attachmentPersistFailure(error) {
\tconst code = error !== null && typeof error === "object" && typeof error.code === "string" ? error.code : "";
\tconst detail = error instanceof Error ? error.message : String(error);
\tconst cause = code === "" ? detail : code + ": " + detail;
\tconsole.error("[attachment-local] 落盘失败：" + cause);
\treturn "Unable to persist attachment. (" + cause + ")";
}
${helperAnchor}`;
  text = text.replace(helperAnchor, helper);

  // ② 三处抛出点（publishImmutableAlias / stageImmutableObject / publishStagedObject）挂钩。
  const throwBefore = '\t\tthrow new AttachmentError("Unable to persist attachment.", "ATTACHMENT_WRITE_FAILED", { cause: error });';
  const throwAfter = '\t\tthrow new AttachmentError(attachmentPersistFailure(error), "ATTACHMENT_WRITE_FAILED", { cause: error });';
  const hits = text.split(throwBefore).length - 1;
  if (hits !== 3) {
    die(`attachment-local cause 补丁：期望 3 处 ATTACHMENT_WRITE_FAILED 抛出点，实到 ${hits} 处，拒绝静默跳过`);
  }
  text = text.split(throwBefore).join(throwAfter);

  writeFileSync(target, text, 'utf8');
  log('[pack-core]   attachment-local cause 补丁：3 处 ATTACHMENT_WRITE_FAILED 带上 cause（新增 2026-10-06）');
}

/**
 * 【Node 26 影响面审计 §2.3（2026-11-24）】IMAGE_BACKEND_UNAVAILABLE 错误码贯通。
 *
 * 【背景】sharp 调度器（wrapSharp）在真件加载失败 / ABI 预检不过时退回 stub，stub 抛出的
 * 错误带 dshmSharpBackendUnavailable 标记；此前 dsh-attachment-local 的三个 sharp catch
 * 把这类错误一律包成 INVALID_IMAGE / ATTACHMENT_WRITE_FAILED ——「图片后端没起来」被误报
 * 成「图片数据坏了」，排障方向完全错（WorkBuddy 2026-11-23 独立测试：147 运行时混入钉
 * 137 的 sharp 闭包会 SIGSEGV；包内 137 缺失时则是干净的 dlopen 失败，同样不是数据问题）。
 *
 * 【贯通面（四个文件，缺一不可）】
 *   ① dsh-attachment/lib/index.js（bundle 码表）—— IMAGE_BACKEND_UNAVAILABLE 并入
 *      ATTACHMENT_ERROR_CODES。**不进** IMAGE_ADMISSION_ERROR_CODES：后端不可用不是
 *      "调用方可修正的准入失败"，isImageAdmissionError 必须继续为 false，ACP / MCP
 *      的 invalid-content 分类不受污染；
 *   ② dsh-attachment/lib/types/error.js（子路径码表）—— 同上（bundle 导入与子路径导入
 *      各用一份码表，两份都要改）；
 *   ③ dsh-attachment-local/lib/index.js —— 三个 sharp catch 识别标记改抛
 *      IMAGE_BACKEND_UNAVAILABLE（probeImage / detectImage / encode 归一化三处）；
 *   ④ dsh-tool-fs/lib/index.js —— saveFailureDetail 的穷举 switch 补 case：不补则
 *      default 走 assertNever，新错误码会在运行时抛 "unreachable"。
 * 【纪律】与其它 patch 一致：锚点缺失 / 数量不符即 die，不静默跳过。
 */
function patchImageBackendUnavailable() {
  // ── ①② 码表（dsh-attachment 的 bundle 与子路径两份）──
  const codeTables = [
    {
      file: join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-attachment', 'lib', 'index.js'),
      before: '\t"ATTACHMENT_FILES_UNSUPPORTED"\n];',
      after: '\t"ATTACHMENT_FILES_UNSUPPORTED",\n\t"IMAGE_BACKEND_UNAVAILABLE"\n];',
      label: 'attachment 码表（bundle）',
    },
    {
      file: join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-attachment', 'lib', 'types', 'error.js'),
      before: "    'ATTACHMENT_FILES_UNSUPPORTED',\n];",
      after: "    'ATTACHMENT_FILES_UNSUPPORTED',\n    'IMAGE_BACKEND_UNAVAILABLE',\n];",
      label: 'attachment 码表（types/error）',
    },
  ];
  for (const table of codeTables) {
    if (!existsSync(table.file)) {
      die(`IMAGE_BACKEND_UNAVAILABLE 补丁：找不到 ${table.file}`);
    }
    let text = readFileSync(table.file, 'utf8');
    if (text.includes('IMAGE_BACKEND_UNAVAILABLE')) {
      log(`[pack-core]   ${table.label}：IMAGE_BACKEND_UNAVAILABLE 已存在（跳过）`);
      continue;
    }
    const hits = text.split(table.before).length - 1;
    if (hits !== 1) {
      die(`IMAGE_BACKEND_UNAVAILABLE 补丁：${table.label} 期望 1 处锚点，实到 ${hits} 处，拒绝静默跳过`);
    }
    text = text.replace(table.before, table.after);
    writeFileSync(table.file, text, 'utf8');
    log(`[pack-core]   ${table.label}：并入 IMAGE_BACKEND_UNAVAILABLE`);
  }

  // ── ③ dsh-attachment-local：三个 sharp catch 识别后端不可用 ──
  const localFile = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-attachment-local', 'lib', 'index.js');
  if (!existsSync(localFile)) {
    die(`IMAGE_BACKEND_UNAVAILABLE 补丁：找不到 ${localFile}`);
  }
  let localText = readFileSync(localFile, 'utf8');
  if (!localText.includes('dshmSharpBackendUnavailable')) {
    const backendCheck = '\t\tif (error instanceof Error && error.dshmSharpBackendUnavailable === true) throw new AttachmentError("Image backend unavailable: the bundled sharp runtime did not load in this host (see dshmSharpLoadError).", "IMAGE_BACKEND_UNAVAILABLE", { cause: error });\n';
    // ③-a probeImage / detectImage 两处（INVALID_IMAGE 包裹）
    const invalidBefore = '\t\tthrow new AttachmentError("Unsupported or malformed image data.", "INVALID_IMAGE", { cause: error });';
    const invalidHits = localText.split(invalidBefore).length - 1;
    if (invalidHits !== 2) {
      die(`IMAGE_BACKEND_UNAVAILABLE 补丁：attachment-local 期望 2 处 INVALID_IMAGE 包裹，实到 ${invalidHits} 处，拒绝静默跳过`);
    }
    localText = localText.split(invalidBefore).join(backendCheck + invalidBefore);
    // ③-b encode 归一化一处（ATTACHMENT_WRITE_FAILED 包裹，模板字面量开头做锚）
    const encodeBefore = '\t\tthrow new AttachmentError(`The ${detected.mediaType === "image/png" && detected.depth !== "uchar" ? `${detected.depth === "ushort" ? "16-bit" : detected.depth} PNG` : `${detected.depth} ${detected.mediaType.slice(6).toUpperCase()}`} could not be converted to the normalized 8-bit sRGB form.`';
    const encodeHits = localText.split(encodeBefore).length - 1;
    if (encodeHits !== 1) {
      die(`IMAGE_BACKEND_UNAVAILABLE 补丁：attachment-local 期望 1 处 encode 归一化锚点，实到 ${encodeHits} 处，拒绝静默跳过`);
    }
    localText = localText.replace(encodeBefore, backendCheck + encodeBefore);
    writeFileSync(localFile, localText, 'utf8');
    log('[pack-core]   attachment-local：3 处 sharp catch 识别 IMAGE_BACKEND_UNAVAILABLE（dshmSharpBackendUnavailable）');
  } else {
    log('[pack-core]   attachment-local：dshmSharpBackendUnavailable 已存在（跳过）');
  }

  // ── ④ dsh-tool-fs：穷举 switch 补 case（不补则 default 走 assertNever 运行时抛错）──
  const toolFsFile = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-tool-fs', 'lib', 'index.js');
  if (!existsSync(toolFsFile)) {
    die(`IMAGE_BACKEND_UNAVAILABLE 补丁：找不到 ${toolFsFile}`);
  }
  let toolFsText = readFileSync(toolFsFile, 'utf8');
  if (toolFsText.includes('IMAGE_BACKEND_UNAVAILABLE')) {
    log('[pack-core]   tool-fs remedy：IMAGE_BACKEND_UNAVAILABLE 已存在（跳过）');
    return;
  }
  const remedyBefore = '\t\tcase "ATTACHMENT_WRITE_FAILED": return /16-bit PNG/iu.test(error.message)';
  const remedyHits = toolFsText.split(remedyBefore).length - 1;
  if (remedyHits !== 1) {
    die(`IMAGE_BACKEND_UNAVAILABLE 补丁：tool-fs 期望 1 处 remedy switch 锚点，实到 ${remedyHits} 处，拒绝静默跳过`);
  }
  toolFsText = toolFsText.replace(
    remedyBefore,
    '\t\tcase "IMAGE_BACKEND_UNAVAILABLE": return "the bundled image backend (sharp/libvips) did not load in this host build, so this file cannot be read as an image here";\n' + remedyBefore,
  );
  writeFileSync(toolFsFile, toolFsText, 'utf8');
  log('[pack-core]   tool-fs remedy：补 IMAGE_BACKEND_UNAVAILABLE case（穷举 switch）');
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
      const before = ['0.2.2-rc.2', '0.2.2-rc.3', '0.2.2-rc.4', '0.2.2-rc.5', '0.2.3-alpha.2'].includes(recipe.coreVersion.split('+')[0])
        ? 'if(parsed.protocol!==`${`dsh-resource`}:`)return void 0;return parsed.hostname===``?void 0:parsed.hostname.toLowerCase()'
        : '\t\t\tif (parsed.protocol !== `dsh-resource:`) return void 0;\n'
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
      const before = ['0.2.2-rc.2', '0.2.2-rc.3', '0.2.2-rc.4', '0.2.2-rc.5', '0.2.3-alpha.2'].includes(recipe.coreVersion.split('+')[0])
        ? 'function pathOf(address){try{return new URL(address).pathname}catch{return}}'
        : '\t\tfunction pathOf(address) {\n'
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
      /*
       * 0.2.3-alpha.2 upstream inserted decodeURIComponent + an `url.search === ""` early
       * return between the host guard and the query reads. Under ArkWeb the query may be
       * merged into pathname, so that early return would misfire and yield a bare sessionId.
       * The patch below preserves upstream's decode step and only redirects the query source
       * to the armor-extracted value.
       */
      const isV3 = recipe.coreVersion.split('+')[0] === '0.2.3-alpha.2';
      const before = isV3
        ? 'if(url.protocol!==`dsh-resource:`||url.hostname.toLowerCase()!==`subagentchat`)return void 0;const parts=url.pathname.split(`/`).filter(Boolean);if(parts.length!==2||parts[0]!==`session`)return void 0;let sessionId;try{sessionId=decodeURIComponent(parts[1])}catch(_invalidEncoding){return}if(url.search===``)return sessionId;const parentSessionId=url.searchParams.get(`parent`);const mode=url.searchParams.get(`mode`);'
        : ['0.2.2-rc.2', '0.2.2-rc.3', '0.2.2-rc.4', '0.2.2-rc.5'].includes(recipe.coreVersion.split('+')[0])
          ? 'if(url.protocol!==`dsh-resource:`||url.hostname.toLowerCase()!==`subagentchat`)return void 0;const parts=url.pathname.split(`/`).filter(Boolean);if(parts.length!==2||parts[0]!==`session`)return void 0;const parentSessionId=url.searchParams.get(`parent`);const mode=url.searchParams.get(`mode`);'
          : '\t\t\tif (url.protocol !== "dsh-resource:" || url.hostname.toLowerCase() !== "subagentchat") return void 0;\n'
          + '\t\t\tconst parts = url.pathname.split("/").filter(Boolean);\n'
          + '\t\t\tif (parts.length !== 2 || parts[0] !== "session") return void 0;\n'
          + '\t\t\tconst parentSessionId = url.searchParams.get("parent");\n'
          + '\t\t\tconst mode = url.searchParams.get("mode");\n';
      if (!text.includes(before)) {
        die('资源地址补丁：subagent 的 parseSubagentChatAddress() 实现已变化（未找到待替换片段），拒绝静默跳过');
      }
      const decodeBlock = '\t\t\tlet sessionId;\n'
        + '\t\t\ttry { sessionId = decodeURIComponent(parts[1]); } catch (_invalidEncoding) { return; }\n';
      const after = '\t\t\t/*\n'
        + '\t\t\t * 【DSHM 鸿蒙补丁 DSHM_RESOURCE_ARMOR_SUBAGENT】ArkWeb 下 `dsh-resource://subagentchat/...` 的\n'
        + '\t\t\t * hostname === ""（判定直接失败），且 query 可能被并进 path ⇒ searchParams 取不到\n'
        + '\t\t\t * parent / mode。这里用正则从原始地址取回 authority / path / query，再走原有判定与白名单。\n'
        + (isV3 ? '\t\t\t * 0.2.3 新增的 decodeURIComponent 步骤原样保留，只把 query 来源换成 armor 提取值。\n' : '')
        + '\t\t\t */\n'
        + '\t\t\tconst armor = url.hostname === "" ? /^[a-z][a-z\\d+.-]*:\\/\\/([^/?#]*)([^?#]*)(\\?[^#]*)?/iu.exec(value) : null;\n'
        + '\t\t\tconst host = armor === null ? url.hostname : armor[1];\n'
        + '\t\t\tconst pathname = armor === null ? url.pathname : armor[2];\n'
        + '\t\t\tconst query = armor === null ? url.search : armor[3] === void 0 ? "" : armor[3];\n'
        + '\t\t\tif (url.protocol !== "dsh-resource:" || host.toLowerCase() !== "subagentchat") return void 0;\n'
        + '\t\t\tconst parts = pathname.split("/").filter(Boolean);\n'
        + '\t\t\tif (parts.length !== 2 || parts[0] !== "session") return void 0;\n'
        + (isV3 ? decodeBlock : '')
        + '\t\t\tconst searchParams = new URLSearchParams(query);\n'
        + (isV3 ? '\t\t\tif (query === "" || query === "?") return sessionId;\n' : '')
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
  const before = text.includes('const dispose=this.ctx.effect(()=>{this.ids.add(id);const slot=this.enter(kind,entry);this.refresh();return()=>{')
    ? 'const dispose=this.ctx.effect(()=>{this.ids.add(id);const slot=this.enter(kind,entry);this.refresh();return()=>{'
    : '\t\t\t\tconst dispose = this.ctx.effect(() => {\n'
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

/**
 * 首次启动「无法创建默认工作区」提示的收口（用户三条原话合起来）：
 *   「两边首次安装都提示，**无法创建默认工作区**，这个不需要提示，默认就是让用户自己去创建，
 *    弹窗别人还以为出什么毛病了」/「PC 也一样，三端都一样，不要这个提示，当然前提是没有什么影响」。
 *
 * 【为什么会弹】`dsh-client-ui-workspace/lib/client.js` 的启动流（逐行核对）：
 *   `:1599` 三条同时成立（无目标工作区 · `workspaces.items.length === 0` · 无会话）才尝试首建；
 *   `:1607-1614` `initializeDefaultWorkspace()` 里 `this.workspaces.initializeDefault(signal)` 抛错即
 *   `this.notify({ kind: "defaultWorkspaceFailed" })` ⇒ `:4519` 渲染成 `t("defaultWorkspace.failed")`
 *   = "无法创建默认工作区，请通过'选择工作区'选择文件夹"。
 *
 * 【为什么端侧必然抛】目录来自 `dsh-api-workspace-controller/lib/index.js:609-641` 的
 * `defaultWorkspaceDirectory()`：`documentsDirectory` 端侧没有覆盖值 ⇒ 走 `runNativeCommand`
 * 平台分支（`win32→powershell` / `darwin→osascript` / `linux→xdg-user-dir`），**openharmony 落到
 * `default: throw new Error("system Documents directory is unavailable on <platform>")`**。
 * 即"首次启动建默认工作区"在三端**结构性地不可能成功**（与 `docs/150` 把插件改成"只撤不建"
 * 后的"空注册表 = 正常态"是同一条结论）。
 *
 * 【修法为什么安全】失败路径上**只**发这条 warning：不建会话、不改注册表、不阻断启动
 * （`initializeDefaultWorkspace` 返回 undefined ⇒ `target` 仍 undefined ⇒ 跳过 `connectWorkspace`，
 * 主区维持空态）。所以这里把这个 notify **删掉**只是"不再弹这条提示"，其余行为逐字不变；
 * 用户仍可从侧栏「添加工作区」（`workspace.add` / `menu.addWorkspace`）自己选定目录。
 *
 * 【保持失败语义】`try/catch` 整段保留（吞掉 rejection、让启动流继续），只把 catch 体里那一行
 * `notify` 换成静默 `return` —— 与"失败要知道"相反的场景（真要提示的 `createFailed` 等）不受影响。
 *
 * 【防呆】找不到待替换片段即 die（上游改了这段就当场在打包期暴露，而不是悄悄失效）。
 */
function patchDefaultWorkspaceToast() {
  const target = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js');
  if (!existsSync(target)) die(`默认工作区提示补丁：找不到 ${target}`);
  let text = readFileSync(target, 'utf8');
  if (text.includes('DSHM_NO_DEFAULT_WORKSPACE_TOAST')) {
    log('[pack-core]   默认工作区提示补丁已存在（跳过）');
    return;
  }
  const before = text.includes('async initializeDefaultWorkspace(signal){try{return await this.workspaces.initializeDefault(signal)}catch(_error){if(!signal.aborted)this.notify({kind:`defaultWorkspaceFailed`});return}}')
    ? 'async initializeDefaultWorkspace(signal){try{return await this.workspaces.initializeDefault(signal)}catch(_error){if(!signal.aborted)this.notify({kind:`defaultWorkspaceFailed`});return}}'
    : '\t\t\tasync initializeDefaultWorkspace(signal) {\n'
    + '\t\t\t\ttry {\n'
    + '\t\t\t\t\treturn await this.workspaces.initializeDefault(signal);\n'
    + '\t\t\t\t} catch (_error) {\n'
    + '\t\t\t\t\tif (!signal.aborted) this.notify({ kind: "defaultWorkspaceFailed" });\n'
    + '\t\t\t\t\treturn;\n'
    + '\t\t\t\t}\n'
    + '\t\t\t}\n';
  if (!text.includes(before)) {
    die('默认工作区提示补丁：dsh-client-ui-workspace 的 initializeDefaultWorkspace() 实现已变化'
      + '（未找到待替换片段），拒绝静默跳过');
  }
  const after = '\t\t\tasync initializeDefaultWorkspace(signal) {\n'
    + '\t\t\t\t/* DSHM_NO_DEFAULT_WORKSPACE_TOAST：端侧 defaultWorkspaceDirectory() 必抛\n'
    + '\t\t\t\t * （openharmony 落 `default:` 分支）⇒ 原实现在这里弹\n'
    + '\t\t\t\t * 「无法创建默认工作区，请通过"选择工作区"选择文件夹」，用户会误以为出故障。\n'
    + '\t\t\t\t * 空注册表是有意为之的正常态（用户从侧栏「添加工作区」自建）⇒ 首次初始化失败改为\n'
    + '\t\t\t\t * **静默**：不弹提示、不建会话、不阻断启动（try/catch 语义原样保留）。 */\n'
    + '\t\t\t\ttry {\n'
    + '\t\t\t\t\treturn await this.workspaces.initializeDefault(signal);\n'
    + '\t\t\t\t} catch (_error) {\n'
    + '\t\t\t\t\treturn;\n'
    + '\t\t\t\t}\n'
    + '\t\t\t}\n';
  text = text.replace(before, after);
  writeFileSync(target, text, 'utf8');
  log('[pack-core]   默认工作区提示补丁：首建失败不再弹「无法创建默认工作区」');
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
  // rc.2 发布物改为压缩箭头；两种已知格式仍须唯一，不匹配不能省略 realm 补齐。
  const factories = ['factory: (require) => {', 'factory:require=>{'].filter((a) => text.includes(a));
  const factoryAnchor = factories[0];
  if (factories.length !== 1 || (text.split(factoryAnchor).length - 1) !== 1) {
    die('pdf 兼容补丁：chunk 工厂入口不唯一（未找到 factory 行），拒绝静默跳过');
  }
  const indented = MAP_COMPAT_SOURCE.replace(/\n+$/, '')
    .split('\n').map((line) => (line === '' ? line : '\t\t' + line)).join('\n');
  text = text.replace(factoryAnchor, factoryAnchor + '\n' + indented);

  // ② pdf worker：worker 由 Blob URL 起，独立 realm，不继承页面/主线程的原型补丁 ⇒
  //    在 Blob 分片数组**最前面**插一段同样源码的字符串字面量（JSON.stringify 保证转义正确）。
  const blobAnchor = text.includes('new Blob([_dsh_pdf_worker_default, ') ? 'new Blob([_dsh_pdf_worker_default, ' : 'new Blob([_dsh_pdf_worker_default,';
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

function patchNodePtySocketGuard() {
  const target = join(STAGE, 'node_modules', 'node-pty', 'lib', 'unixTerminal.js');
  if (!existsSync(target)) die(`node-pty 补丁：找不到 ${target}`);
  let text = readFileSync(target, 'utf8');
  if (text.includes('DSHM_NODE_PTY_SOCKET_GUARD')) {
    log('[pack-core]   node-pty 补丁（unixTerminal.js）已存在（跳过）');
    return;
  }
  /*
   * 【缺口（根因，2026-10-14）】`pty.fork()` **失败**时 `_socket` 还没被赋值，而
   * node-pty 在 `fork()` 之前就已经订好了 200ms 的 `DESTROY_SOCKET_TIMEOUT_MS` 定时器，
   * 回调里无条件 `_this._socket.destroy()`。于是"一次失败 spawn"会在 200ms 后升级成
   * **未捕获的 TypeError**，从定时器里逃出来，谁都接不住。
   *
   * 真机链（PC 档 `86E0226429000417`，`dist/acceptance/pc-node-output.log`）：
   *   `BOOT_40_PROFILE_BOOT +1053ms` → `[DEP0168] N-API 未捕获异常警告`
   *   → 恰好 +200ms `unixTerminal.js:114:35 TypeError`
   *   → `BOOT_50_DSH_INIT runProfile 已返回 但没有 webServer` → 宿主线程 `process.exit(1)`。
   *
   * 触发它的正是我们自己的探针：`hostcore/app/main.js` 的 `runtimeFacts()` 用
   * `pty.spawn('/system/bin/sh', ['-c', 'echo DSHM_PTY_OK'])` 试
   * `ALLOW_EXTERNAL_NATIVE_CODE`。在 `spawn-helper` 被平台拒的那一档，`fork()` 同步抛错、
   * 被探针自己的 try/catch 吞掉——补丁前那个 try/catch **接不住** 200ms 后的定时器回调，
   * 于是一次"探测"就把宿主打死（这正是"点了终端就闪退"的上游形状）。
   *
   * 修法：让那次 destroy 容忍 `_socket` 未定义。语义只放宽失败路径，成功路径逐字不变。
   */
  const before = '                    // Destroying the socket now will cause the close event to fire\n'
    + '                    _this._socket.destroy();';
  if ((text.split(before).length - 1) !== 1) {
    die('node-pty 补丁：unixTerminal.js 的 socket destroy 锚点不唯一（未找到待替换片段），拒绝静默跳过');
  }
  const after = '                    // Destroying the socket now will cause the close event to fire\n'
    + '                    // DSHM_NODE_PTY_SOCKET_GUARD: pty.fork() 抛错时 _socket 还是 undefined，\n'
    + '                    // 这里必须容忍它；否则 200ms 后的 TypeError 会逃出 try/catch 打死宿主。\n'
    + '                    if (_this._socket !== undefined && _this._socket !== null) {\n'
    + '                        _this._socket.destroy();\n'
    + '                    }';
  writeFileSync(target, text.replace(before, after), 'utf8');
  log('[pack-core]   node-pty 补丁：unixTerminal.js 的 socket destroy 容忍未赋值（spawn 失败不再打死宿主）');
}

/**
 * ⑳ web_fetch 的深嵌套 HTML 兜底（2026-10-17，抓取成功率）。
 *
 * 【为什么加】`dsh-tool-web` 的 `renderBody()` 在两条失败路径（词法深度超过
 * MAX_CONVERSION_DEPTH=512 / turndown 抛错）上把**整页**替换成一句 "HTML content omitted"
 * —— 真机会话实录：`https://www.stats.gov.cn/sj/ndsj/2025/indexch.htm`（HTTP 200，目录页
 * 表格嵌套深）就这样整页丢失，用户的体感是"抓不到数据"。
 * 深度上限本身**必须保留**（turndown 对深树是超线性：depth 2000≈2s / 20000≈5s，
 * 会把事件循环占死，注释见上游 MAX_CONVERSION_DEPTH）；但"丢弃"不是唯一选项 ——
 * 线性扫一遍标签 + 反转义几个常用实体，就能把正文救回来，且不泄露任何原始标签/脚本。
 *
 * 【边界】只改这两条失败分支；正常路径（turndown 成功）一个字节不动。
 * 标记：DSHM_SHALLOW_HTML_FALLBACK（门禁 tools/check-core-openharmony-patches.mjs 断言）。
 */
function patchWebToolDeepHtmlFallback() {
  const target = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-tool-web', 'lib', 'index.js');
  if (!existsSync(target)) die(`dsh-tool-web 兜底补丁：找不到 ${target}`);
  let text = readFileSync(target, 'utf8');
  if (text.includes('DSHM_SHALLOW_HTML_FALLBACK')) {
    log('[pack-core]   dsh-tool-web 深嵌套兜底补丁已存在（跳过）');
    return;
  }
  const upstream = '\t\tcase "html":\n'
    + '\t\t\tif (exceedsConversionDepth(content)) return {\n'
    + '\t\t\t\ttext: "[HTML content omitted: unable to convert safely.]",\n'
    + '\t\t\t\tsourceTruncated\n'
    + '\t\t\t};\n'
    + '\t\t\ttry {\n'
    + '\t\t\t\treturn {\n'
    + '\t\t\t\t\ttext: turndown.turndown(content),\n'
    + '\t\t\t\t\tsourceTruncated\n'
    + '\t\t\t\t};\n'
    + '\t\t\t} catch {\n'
    + '\t\t\t\treturn {\n'
    + '\t\t\t\t\ttext: "[HTML content omitted: unable to convert safely.]",\n'
    + '\t\t\t\t\tsourceTruncated\n'
    + '\t\t\t\t};\n'
    + '\t\t\t}';
  if ((text.split(upstream).length - 1) !== 1) {
    die('dsh-tool-web 兜底补丁：renderBody 的 html 分支锚点不唯一（未找到待替换片段），拒绝静默跳过');
  }
  const helper = '/**\n'
    + ' * DSHM_SHALLOW_HTML_FALLBACK（2026-10-17）：深嵌套/转换失败时的**兜底纯文本**提取。\n'
    + ' *\n'
    + ' * 【为什么加】原实现在词法深度超过 MAX_CONVERSION_DEPTH 或 turndown 抛错时，\n'
    + ' * 把整页替换成一句 "HTML content omitted"（连正文都不留）—— 真机会话实录：\n'
    + ' * 国家统计局的目录页（HTTP 200、表格嵌套深）就是这样整页丢失的。\n'
    + ' * 深度上限本身必须保留（turndown 对深树超线性，会占死事件循环）；\n'
    + ' * 但线性扫一遍标签 + 反转义几个实体即可救回正文，且不泄露任何原始标签/脚本。\n'
    + ' * 【边界】只在这两条失败分支上生效；正常路径（turndown 成功）一个字节不动。\n'
    + ' */\n'
    + 'function salvageDeepHtmlText(html) {\n'
    + '\tconst stripped = html\n'
    + '\t\t.replace(/<(script|style|noscript|template|svg)\\b[\\s\\S]*?<\\/\\1\\s*>/gi, " ")\n'
    + '\t\t.replace(/<!--[\\s\\S]*?-->/g, " ")\n'
    + '\t\t.replace(/<[^>]*>/g, " ");\n'
    + '\tconst decoded = stripped\n'
    + '\t\t.replace(/&nbsp;/gi, " ")\n'
    + '\t\t.replace(/&lt;/gi, "<")\n'
    + '\t\t.replace(/&gt;/gi, ">")\n'
    + '\t\t.replace(/&quot;/gi, \'"\')\n'
    + "\t\t.replace(/&#39;/gi, \"'\")\n"
    + '\t\t.replace(/&amp;/gi, "&");\n'
    + '\tconst frames = [];\n'
    + '\tconst frameRe = /<frame\\b[^>]*?\\bsrc\\s*=\\s*["\\\']([^"\\\']+)["\\\']/gi;\n'
    + '\tlet match;\n'
    + '\twhile ((match = frameRe.exec(html)) !== null && frames.length < 5) frames.push(match[1]);\n'
    + '\tconst frameNote = frames.length > 0\n'
    + '\t\t? ` Frameset srcs (fetch these directly): ${frames.join(", ")}.`\n'
    + '\t\t: "";\n'
    + '\treturn "[Shallow text fallback: deeply nested or unconvertible HTML; tags and scripts stripped.]"\n'
    + '\t\t+ frameNote + "\\n"\n'
    + '\t\t+ decoded.replace(/\\s+/g, " ").trim();\n'
    + '}\n\n';
  const after = '\t\tcase "html":\n'
    + '\t\t\tif (exceedsConversionDepth(content)) return {\n'
    + '\t\t\t\ttext: salvageDeepHtmlText(content),\n'
    + '\t\t\t\tsourceTruncated\n'
    + '\t\t\t};\n'
    + '\t\t\ttry {\n'
    + '\t\t\t\treturn {\n'
    + '\t\t\t\t\ttext: turndown.turndown(content),\n'
    + '\t\t\t\t\tsourceTruncated\n'
    + '\t\t\t\t};\n'
    + '\t\t\t} catch {\n'
    + '\t\t\t\treturn {\n'
    + '\t\t\t\t\ttext: salvageDeepHtmlText(content),\n'
    + '\t\t\t\t\tsourceTruncated\n'
    + '\t\t\t\t};\n'
    + '\t\t\t}';
  text = text.replace(upstream, after);
  const renderAnchor = 'function renderBody(body, maxInputChars) {';
  if ((text.split(renderAnchor).length - 1) !== 1) {
    die('dsh-tool-web 兜底补丁：renderBody 定义锚点不唯一，拒绝静默跳过');
  }
  text = text.replace(renderAnchor, helper + renderAnchor);
  writeFileSync(target, text, 'utf8');
  log('[pack-core]   dsh-tool-web 兜底补丁：深嵌套/转换失败的 HTML 改走线性纯文本提取（不再整页丢弃）');
}

/**
 * ㉑ web_fetch 的请求头（2026-10-17，抓取成功率第二批）。
 *
 * 【为什么】UA 已在 profile 里改成浏览器 UA（docs/177）；但很多反爬中间件还会看
 * **Accept-Language** 与**同源 Referer** —— 一个"只有 UA、没有语言/来源"的请求仍然会被
 * 打成低分。这里补上浏览器正常会带的两项（仅此两项，不动 method / redirect / SSRF 策略）。
 * 标记：DSHM_WEB_FETCH_HEADERS（门禁 tools/check-core-openharmony-patches.mjs 断言）。
 */
function patchWebFetchHeaders() {
  const target = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-web-fetch-http', 'lib', 'index.js');
  if (!existsSync(target)) die(`web-fetch-http 请求头补丁：找不到 ${target}`);
  let text = readFileSync(target, 'utf8');
  if (text.includes('DSHM_WEB_FETCH_HEADERS')) {
    log('[pack-core]   web-fetch-http 请求头补丁已存在（跳过）');
    return;
  }
  const before = '\t\tconst headers = {\n'
    + '\t\t\t"user-agent": this.limits.userAgent,\n'
    + '\t\t\t"accept": "text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8"\n'
    + '\t\t};';
  if ((text.split(before).length - 1) !== 1) {
    die('web-fetch-http 请求头补丁：headers 锚点不唯一（未找到待替换片段），拒绝静默跳过');
  }
  const after = '\t\tconst headers = {\n'
    + '\t\t\t"user-agent": this.limits.userAgent,\n'
    + '\t\t\t"accept": "text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8",\n'
    + '\t\t\t// DSHM_WEB_FETCH_HEADERS: 浏览器默认会带的语言/来源头（反爬中间件对缺席请求打分更低）\n'
    + '\t\t\t"accept-language": "zh-CN,zh;q=0.9,en;q=0.8",\n'
    + '\t\t\t"referer": url.origin + "/"\n'
    + '\t\t};';
  writeFileSync(target, text.replace(before, after), 'utf8');
  log('[pack-core]   web-fetch-http 请求头补丁：补 Accept-Language + 同源 Referer');
}

function patchClientHmrPoll() {
  const target = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-client-hmr', 'lib', 'index.js');
  if (!existsSync(target)) die(`client-hmr 补丁：找不到 ${target}`);
  let text = readFileSync(target, 'utf8');
  if (text.includes('DSHM_CLIENT_HMR_POLL_OFF')) {
    log('[pack-core]   client-hmr 轮询补丁已存在（跳过）');
    return;
  }
  /*
   * 【缺口（根因，2026-10-14）】`@deepseek-ai/dsh-client-hmr` 由 `dsh-web-app` 的
   * bundle patch **总是挂载**（上游注释："always mounted: it is idle until a rebuild
   * watcher (pnpm run dev:web) actually rewrites client bundles"）。它"idle"的判据是
   * "没人重写 bundle"，但它自己的实现是 `setInterval(pollWatches, 500)` —— **每 500ms
   * 把 client graph 里每一条 bundle 都 `statSync` 一遍**。上游语境里这些文件在本地盘、
   * 进程热着，代价看不出来；端侧两个条件同时变坏：
   *   · 核心树解在 el2（`/data/storage/el2/.../dsh/cores/<ver>/node_modules/...`），
   *     单次 stat 在设备上要 ~0.18ms（内存吃紧时单次 200~300ms）；
   *   · 端侧**没有** `dev:web` 重建器，也不可能有人在运行期改这些 bundle ⇒ 轮询 100% 是白工。
   *
   * 真机读数（PC 档，V8 CPU profile 的调用栈，`dist/acceptance/20261014-pcstart/`）：
   *   `statSync <- bundleStat <- pollWatches <- listOnTimeout` —— 一次 `LOOP-GAP 4262ms` 内
   *   `statSync×23117=4114ms`（下一次 `LOOP-GAP 11503ms` 内 `statSync×23185=8016ms`），
   *   同时段 WebView 渲染进程被系统 OOM 杀掉（`RenderExited exitSig:9`）。
   *   即：**它把事件循环整段占住**，网页那边的观感就是"启动巨慢 / 卡住"。
   *
   * 修法：把"挂 bundle 监视 + 起轮询"这一个 `ctx.effect` 变成惰性 —— 默认**不跑**，
   * 只有显式 `DSHM_CLIENT_HMR_POLL=1` 才启用（保留给将来在端侧做真 HMR 的场景）。
   * **只关轮询，不动 SSE 通道**：`/plugins/events` 那条 effect 原样保留（连接时的首帧
   * graph 与 `onGraphChanged`/`onRebuilt` 推送都还在），所以浏览器半边的模块表同步
   * 一个字都不变 —— 关掉的只有"磁盘上有没有人改了 bundle"这件端侧恒假的事。
   */
  const before = '\tctx.effect(() => {\n\t\tsyncWatches();\n';
  if ((text.split(before).length - 1) !== 1) {
    die('client-hmr 补丁：bundle watches 的 ctx.effect 锚点不唯一（未找到待替换片段），拒绝静默跳过');
  }
  const after = '\tctx.effect(() => {\n'
    + '\t\t// DSHM_CLIENT_HMR_POLL_OFF: 端侧没有重建器，轮询只会把事件循环整段占住（实测 23k statSync / 4s）。\n'
    + '\t\tif (process.env.DSHM_CLIENT_HMR_POLL !== "1") return () => {};\n'
    + '\t\tsyncWatches();\n';
  writeFileSync(target, text.replace(before, after), 'utf8');
  log('[pack-core]   client-hmr 补丁：bundle 轮询默认关闭（DSHM_CLIENT_HMR_POLL=1 可开；SSE 通道不动）');
}

/**
 * 侧边栏终端：软键盘弹出时禁止 xterm 的 ResizeObserver 触发 fit/resize。
 *
 * 真机现象（2026-10-18）：手机终端呼出键盘后，输入与删除时整行预览/滚动位置乱跳。
 * xterm 的 `ResizeObserver` 会把键盘引起的可视高度变化当成终端尺寸变化，连续
 * `fitScreen()` → `xterm.resize()` → `model.resize()`，服务端 PTY 也跟着反复收到
 * SIGWINCH。键盘输入还没提交，视口先重排了几次。
 *
 * 原生壳在 `avoidAreaChange(TYPE_KEYBOARD)` 时给 `<html>` 挂 `dshm-keyboard-open`；
 * 本补丁让测量函数在键盘存在期间直接返回，键盘收起后 ResizeObserver 会自然再跑一次。
 */
function patchTerminalKeyboardResizeGuard() {
  const target = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar-terminal',
    'lib', 'client.terminal.js');
  if (!existsSync(target)) die(`终端键盘 resize 守卫：找不到 ${target}`);
  const src = readFileSync(target, 'utf8');
  if (src.includes('DSHM_KEYBOARD_RESIZE_GUARD')) {
    log('[pack-core]   终端键盘 resize 守卫已存在（跳过）');
    return;
  }
  const anchor = ['0.2.2-rc.2', '0.2.2-rc.3', '0.2.2-rc.4', '0.2.2-rc.5', '0.2.3-alpha.2'].includes(recipe.coreVersion.split('+')[0])
    ? 'const measure=()=>{if(!current.current.visible'
    : 'const measure = () => {\n\t\t\t\t\tif (!current.current.visible';
  const count = src.split(anchor).length - 1;
  if (count !== 1) {
    die(`终端键盘 resize 守卫：measure 锚点不唯一（找到 ${count} 处），拒绝静默跳过`);
  }
  const inserted = 'const measure = () => {\n'
    + '\t\t\t\t\t/* DSHM_KEYBOARD_RESIZE_GUARD: 软键盘不是终端尺寸变化；键盘期暂停 fit/resize。 */\n'
    + '\t\t\t\t\tconst __dshmRoot = document.documentElement;\n'
    + "\t\t\t\t\tif (__dshmRoot && __dshmRoot.classList.contains('dshm-keyboard-open')) return;\n"
    + '\t\t\t\t\tif (!current.current.visible';
  writeFileSync(target, src.replace(anchor, inserted), 'utf8');
  log('[pack-core]   终端补丁：软键盘期暂停 xterm fit/resize（输入预览不再乱跳）');
}

/**
 * 左下角「连接异常，刷新重试」根治：WebSocket 失败后必须**自己**持续重试。
 *
 * 【真机现象（2026-10-31，三端一致，云调试新设备同样复现）】
 *   启动后左下角永远是「连接异常，刷新重试」，点一下手动重连又能好。
 *   日志逐毫秒对照（`com.dshm.dshclient/DSHM-NODELIVE`）：
 *     09:11:24.550  ACCEPT #10 127.0.0.1:40010
 *     09:11:24.551  IN-UPGRADE GET /api/remote.mux ... origin=http://127.0.0.1:3120
 *                   URLRequestCanceled error:ERR_WS_UPGRADE(-173)
 *   Host 收到升级后 **1ms 内**就被取消，`ws.handleUpgrade` 来不及写出 101
 *   ⇒ 这是 ArkWeb 网络栈自己 abort 的，不是 Host 拒绝、不是网络、不是 token。
 *
 * 【为什么这一处必须修（与 ArkWeb 为什么 cancel 是两件事）】
 *   对照实验（本机 1.1.6 实测）：用真实 token + cookie、逐字节照 ArkWeb 的头
 *   （Host / Origin / Sec-WebSocket-*）直接打 `/api/remote.mux`，Host 回的是
 *   `HTTP/1.1 101 Switching Protocols` ⇒ **Host 侧完全健康**。
 *   而 1.1.6(+dshm.96) 与 1.1.7(+dshm.103) 的 `dsh-client-connection` /
 *   `dsh-api-gateway` / `dsh-host-webserver` / 前端 dist 全部**逐字节相同**
 *   ⇒ "1.1.7 改坏了连接"不成立，两版共有一个上游缺陷：
 *
 *     ① `RemoteStreamMuxClient.maintain()` 失败后**只置 failure，不排下一次**；
 *     ② 它唯一的重启入口是 `onReconnectRequested`，而那个回调只在
 *        `ConnectionController.loop()` 走到 retry 分支时才触发；
 *     ③ `loop()` 的 offline 分支是 `await waitForAbort(retryDelay.signal)`，
 *        只有 `online` 事件能唤醒 —— 而 `setNetworkAvailable()` 首行
 *        `if (this.networkAvailable === available) return;` 让"再报一次 true"直接返回。
 *     ⇒ 一次 WS 失败 = 永久不再尝试（日志实证：17:11:24 之后再无任何 ACCEPT/UPGRADE）。
 *
 * 【修法】只动 ③ 之上那层（不碰 ArkWeb）：让 `maintain()` 在**失败后自己带退避重连**，
 *   不再依赖 `loop()` 的状态。退避与官方口径一致（500ms 起、×2、封顶 10s），
 *   连上（`opened`）即复位；`disposed`/`!running` 时立即停，不留悬挂定时器。
 *   这样即使 ArkWeb 偶发取消，用户看到的是"短暂连接中 → 自动连上"，
 *   而不是"永久连接异常"。
 *
 * 【判据】`tools/check-ws-self-heal.mjs`（带对照臂：把自愈删掉必须判红）。
 */
function patchRemoteStreamSelfHeal() {
  const target = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-api-gateway', 'lib', 'client.browser.js');
  if (!existsSync(target)) die(`WS 自愈补丁：找不到 ${target}`);
  let text = readFileSync(target, 'utf8');
  if (text.includes('DSHM_WS_SELF_HEAL')) {
    log('[pack-core]   WS 自愈补丁已存在（跳过）');
    return;
  }

  // ── ① 失败后自己排重试 ───────────────────────────────────────────────
  // rc.2 压缩发布格式：仅展开经核对的状态机边界，随后仍由旧补丁的唯一锚点判据逐项验收。
  text = text.replace('running=false;disposed=false;failure;', '\t\t\trunning = false;\n\t\t\tdisposed = false;\n\t\t\tfailure;\n')
    .replace('this.keepAlive=task;task.then(()=>{this.keepAlive=void 0})}', '\t\t\t\tthis.keepAlive = task;\n\t\t\t\ttask.then(() => {\n\t\t\t\t\tthis.keepAlive = void 0;\n\t\t\t\t});\n\t\t\t}\n')
    .replace('settled=true;this.cancelCandidate=void 0;this.socket=socket;', '\t\t\t\t\t\tsettled = true;\n\t\t\t\t\t\tthis.cancelCandidate = void 0;\n\t\t\t\t\t\tthis.socket = socket;\n')
    .replace('const failed=()=>{', '\t\t\t\t\tconst failed = () => {\n')
    .replace('const closed=()=>{socket.removeEventListener(`open`,opened);', '\t\t\t\t\tconst closed = () => {\n\t\t\t\t\t\tsocket.removeEventListener("open", opened);\n');
  const anchorFields = '\t\t\trunning = false;\n'
    + '\t\t\tdisposed = false;\n'
    + '\t\t\tfailure;\n';
  if ((text.split(anchorFields).length - 1) !== 1) {
    die('WS 自愈补丁：类字段锚点不唯一，拒绝静默跳过');
  }
  text = text.replace(anchorFields,
    '\t\t\trunning = false;\n'
    + '\t\t\tdisposed = false;\n'
    + '\t\t\t/* DSHM_WS_SELF_HEAL: 自愈退避状态（attempt 计数 / 待定定时器 / 待输出诊断）。 */\n'
    + '\t\t\tselfHealAttempt = 0;\n'
    + '\t\t\tselfHealTimer;\n'
    + '\t\t\tselfHealBuf;\n'
    + '\t\t\tfailure;\n');

  const anchorMaint = '\t\t\t\tthis.keepAlive = task;\n'
    + '\t\t\t\ttask.then(() => {\n'
    + '\t\t\t\t\tthis.keepAlive = void 0;\n'
    + '\t\t\t\t});\n'
    + '\t\t\t}\n';
  if ((text.split(anchorMaint).length - 1) !== 1) {
    die('WS 自愈补丁：maintain() 尾部锚点不唯一，拒绝静默跳过');
  }
  const afterMaint = '\t\t\t\tthis.keepAlive = task;\n'
    + '\t\t\t\ttask.then(() => {\n'
    + '\t\t\t\t\tthis.keepAlive = void 0;\n'
    + '\t\t\t\t\t/* DSHM_WS_SELF_HEAL: 失败后自己排下一次 —— 不再等 loop() 的 onReconnectRequested。\n'
    + '\t\t\t\t\t * 官方只在 reconnect() 里重排队，而 loop() 可能永远不回来（见 patch 头注③）。 */\n'
    + '\t\t\t\t\tthis.scheduleSelfHeal();\n'
    + '\t\t\t\t});\n'
    + '\t\t\t}\n'
    + '\t\t\t/** DSHM_WS_SELF_HEAL：按官方退避口径排一次自愈（500ms 起、×2、封顶 10s）。 */\n'
    + '\t\t\tscheduleSelfHeal() {\n'
    + '\t\t\t\tif (!this.running || this.disposed) return;\n'
    + '\t\t\t\tif (this.socket !== void 0 && this.socket.readyState === 1) { this.selfHealAttempt = 0; return; }\n'
    + '\t\t\t\tif (this.selfHealTimer !== void 0) return;\n'
    + '\t\t\t\tconst attempt = ++this.selfHealAttempt;\n'
    + '\t\t\t\tconst cap = Math.min(10000, 500 * (2 ** Math.max(0, attempt - 1)));\n'
    + '\t\t\t\tconst delay = cap / 2 + Math.random() * (cap / 2);\n'
    + '\t\t\t\tif (this.selfHealBuf !== void 0) {\n'
    + '\t\t\t\t\tconst line = "[DSHM-WS] 升级失败(error/close)，" + String(Math.round(delay)) + "ms 后第 " + String(attempt) + " 次自愈重连 " + String(this.selfHealBuf);\n'
    + '\t\t\t\t\tthis.selfHealBuf = void 0;\n'
    + '\t\t\t\t\ttry { console.warn(line); } catch (ignored) { /* 日志失败不影响重连 */ }\n'
    + '\t\t\t\t}\n'
    + '\t\t\t\tthis.selfHealTimer = setTimeout(() => {\n'
    + '\t\t\t\t\tthis.selfHealTimer = void 0;\n'
    + '\t\t\t\t\tif (!this.running || this.disposed) return;\n'
    + '\t\t\t\t\tthis.maintain();\n'
    + '\t\t\t\t}, delay);\n'
    + '\t\t\t\tif (typeof this.selfHealTimer === "object" && this.selfHealTimer !== null && typeof this.selfHealTimer.unref === "function") this.selfHealTimer.unref();\n'
    + '\t\t\t}\n';
  text = text.replace(anchorMaint, afterMaint);

  // ── ② 连上即复位退避、清掉待决定时器 ─────────────────────────────────
  const anchorOpened = '\t\t\t\t\t\tsettled = true;\n'
    + '\t\t\t\t\t\tthis.cancelCandidate = void 0;\n'
    + '\t\t\t\t\t\tthis.socket = socket;\n';
  if ((text.split(anchorOpened).length - 1) !== 1) {
    die('WS 自愈补丁：opened() 锚点不唯一，拒绝静默跳过');
  }
  text = text.replace(anchorOpened,
    '\t\t\t\t\t\tsettled = true;\n'
    + '\t\t\t\t\t\tthis.cancelCandidate = void 0;\n'
    + '\t\t\t\t\t\t/* DSHM_WS_SELF_HEAL: 连上即复位退避，并清掉残留的重连定时器。 */\n'
    + '\t\t\t\t\t\tthis.selfHealAttempt = 0;\n'
    + '\t\t\t\t\t\tthis.selfHealBuf = void 0;\n'
    + '\t\t\t\t\t\tif (this.selfHealTimer !== void 0) { clearTimeout(this.selfHealTimer); this.selfHealTimer = void 0; }\n'
    + '\t\t\t\t\t\tthis.socket = socket;\n');

  // ── ③ 诊断埋点：把 ArkWeb 给的 error/close 细节带出来（只记不抛）───────
  const anchorFailed = '\t\t\t\t\tconst failed = () => {\n';
  if ((text.split(anchorFailed).length - 1) !== 1) {
    die('WS 自愈补丁：failed() 锚点不唯一，拒绝静默跳过');
  }
  text = text.replace(anchorFailed,
    '\t\t\t\t\t/* DSHM_WS_SELF_HEAL: 记录 ArkWeb 侧的失败细节（code/reason），供云调试定位取消原因。 */\n'
    + '\t\t\t\t\tconst noteCarrier = (kind, event) => {\n'
    + '\t\t\t\t\t\ttry {\n'
    + '\t\t\t\t\t\t\tconst detail = {\n'
    + '\t\t\t\t\t\t\t\tkind,\n'
    + '\t\t\t\t\t\t\t\tcode: event?.code,\n'
    + '\t\t\t\t\t\t\t\treason: event?.reason,\n'
    + '\t\t\t\t\t\t\t\twasClean: event?.wasClean,\n'
    + '\t\t\t\t\t\t\t\tonLine: globalThis.navigator?.onLine,\n'
    + '\t\t\t\t\t\t\t\turl: typeof remoteStreamUrl === "function" ? remoteStreamUrl() : void 0\n'
    + '\t\t\t\t\t\t\t};\n'
    + '\t\t\t\t\t\t\tthis.selfHealBuf = JSON.stringify(detail);\n'
    + '\t\t\t\t\t\t} catch (ignored) { /* 诊断失败不影响重连 */ }\n'
    + '\t\t\t\t\t};\n'
    + '\t\t\t\t\tconst failed = () => {\n'
    + '\t\t\t\t\t\tnoteCarrier("error");\n');

  const anchorClosed = '\t\t\t\t\tconst closed = () => {\n'
    + '\t\t\t\t\t\tsocket.removeEventListener("open", opened);\n';
  if ((text.split(anchorClosed).length - 1) !== 1) {
    die('WS 自愈补丁：close 锚点不唯一，拒绝静默跳过');
  }
  text = text.replace(anchorClosed,
    '\t\t\t\t\tconst closed = (event) => {\n'
    + '\t\t\t\t\t\tif (this.selfHealBuf === void 0) noteCarrier("close", event);\n'
    + '\t\t\t\t\t\tsocket.removeEventListener("open", opened);\n');

  writeFileSync(target, text, 'utf8');
  log('[pack-core]   WS 自愈补丁：升级失败后自动退避重连 + error/close 诊断（DSHM-WS）');
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
    /*
     * 【可复现构建（docs/334 复核发现）】此前这里是 `new Date().toISOString()`，
     * 于是**同一个核心版本、同一棵源树，每次打包得到不同的 sha256**。
     * 实测三次连打：85a1447b / e0b0391a / 571077f3 —— 三个不同值。
     *
     * 后果不是"哈希不好看"，而是**"三方一致"门禁失去意义**：
     * `check-resfile-core-zip` 断言 resfile ↔ 配方 ↔ 本次产出三者相等，
     * 而"本次产出"每次都变 ⇒ 只要重打包一次，之前放进去的那份立刻"不一致"。
     * 而且无法回答"设备上跑的这棵树是不是就是仓库这一份"。
     *
     * 修法：优先取 `SOURCE_DATE_EPOCH`（可复现构建的标准环境变量，秒级时间戳），
     * 否则取**核心配方文件自身的 mtime** —— 后者与版本号同步递增（改核心必升
     * `+dshm.<n>` 并重写配方），因此"同一配方 ⇒ 同一 builtAt ⇒ 同一 sha256"。
     * 注意：这**不是**"打包时刻"，而是"这份核心内容成形的时刻"，语义更准。
     */
    builtAt: reproducibleStamp(),
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
  const omissions = bundledDevelopmentFiles(baseDir, log);
  const emptyDevelopmentDirectories = bundledEmptyDevelopmentDirectories(baseDir, log);
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
    if (isBundledZodBenchmarks(baseDir, rel)) return;
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() || e.isFile())
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    // ZIP extraction creates parent directories from file paths. Keep a
    // directory entry for an empty leaf so the extracted tree still matches.
    if (rel && entries.length === 0 && !emptyDevelopmentDirectories.has(rel)) addEntry(`${topName}/${rel}/`, Buffer.alloc(0), true);
    for (const e of entries) {
      const full = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(full, r);
      } else if (!omissions.has(r)) {
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

  // 随应用分发：放进 HAP/HSP common 的 resfile（见 hostruntime/core/BundledCore.ets：
  // resfile 安装后解压到沙箱，可按真实路径只读访问）。
  // 2026-10-28 双端分离后，core 只放在共享 HSP；entry/phone HAP 各自放一份会让
  // 合并 APP 体积翻倍。以下沿用旧的单份清理判据，补上 HSP 目录。
  if (process.argv.includes('--place-in-app')) {
    const resDir = join(ROOT, 'hostruntime', 'src', 'main', 'resources', 'resfile');
    mkdirSync(resDir, { recursive: true });
    const entryResDir = join(ROOT, 'entry', 'src', 'main', 'resources', 'resfile');
    for (const stale of existsSync(entryResDir) ? readdirSync(entryResDir) : []) {
      if (stale.startsWith('dsh-core-') && stale.endsWith('.zip')) {
        rmSync(join(entryResDir, stale), { force: true });
        log(`[pack-core]   清掉 entry 重复容器：${stale}`);
      }
    }
    /*
     * 【2026-10-05 加：放新的之前，把**其它**核心容器删掉】
     * 真机复测实测：三份 core 共存把 HAP 从 406 MB 顶到 491 MB（每份 ~85 MB）。
     * 判据 `tools/check-resfile-core-zip.mjs` 已能报错，但**报错不等于不会带上**——
     * 出包这一步自己清干净，才不会依赖"人记得删"。
     */
    for (const stale of readdirSync(resDir)) {
      if (stale.startsWith('dsh-core-') && stale.endsWith('.zip') && stale !== `${base}.zip`) {
        try {
          rmSync(join(resDir, stale), { force: true });
          log(`[pack-core]   清掉旧容器：${stale}（避免多份 core 撑大 HAP）`);
        } catch (e) {
          log(`[pack-core]   ⚠ 旧容器删除失败（不阻断）：${stale}`);
        }
      }
    }
    const dest = join(resDir, `${base}.zip`);
    cpSync(zipPath, dest, { force: true });
    log(`[pack-core]   已放入共享 HSP 资源：hostruntime/src/main/resources/resfile/${base}.zip`);
    log('[pack-core]   注意：该文件已在 .gitignore 中（体积大，不进版本库）');
  }

  return { zipPath, bytes: z.bytes, entries: z.count, tarPath };
}

function writeManifest(extra) {
  const nm = join(STAGE, 'node_modules');
  let fileCount = 0;
  for (const f of listFilesRecursive(nm)) { void f; fileCount++; }
  const corePkg = JSON.parse(readFileSync(join(nm, '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
  /*
   * 【打包前的最后一道断言（2026-10-29）】清单里同时记 `coreVersion`（配方）与
   * `coreVersionInstalled`（实际装了什么）**只是为了让人能对账**，它们相等必须由
   * 这里当场判死，而不是靠读者发现不相等。materialize() 的复用分支已有一道同样的
   * 断言；这里再判一次锁的是"即将被 zip 读走的这棵树"（中间还隔着一串 patch 步骤）。
   */
  /*
   * 【2026-10-30 与 materialize() 同口径】比较**上游版本**：`+dshm.<n>` 是 build metadata，
   * 不在 npm 包清单里（上一版拿整串比 ⇒ 每次出包都在这里判死，而门禁 check-resfile-core-zip
   * 又会指出"打包前断言失败"，两头都不通）。上游版本不等才是"旧核心被打上新标签"。
   */
  const installedUpstream = String(corePkg.version || '').split('+')[0];
  const recipeUpstream = String(recipe.coreVersion || '').split('+')[0];
  if (installedUpstream !== recipeUpstream) {
    die(`打包前断言失败：实际安装 ${corePkg.version} ≠ 配方 coreVersion ${recipe.coreVersion}（上游部分）。`
      + '产物会被打上错误版本标签 —— 请清掉该暂存树后 --force-install 重建');
  }
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
prepareZodLocales(STAGE, join(WORK_ROOT, '.pack-core-pristine'), log);
prepareZodFactories(STAGE, log);
replaceKoffiJs();
const sig = verify();
addPlatformAliases();
allowOriginList();
wrapSharp();
addSystemAddonPackage();
patchLinkForSandbox();
patchCredentialsOwnerCheck();
patchAppBootReadonlyStack();
patchMarketDesktopRuntime();
patchProfilePnpmBridge();
patchPluginManagerInspectBridge();
patchInstallSpecNormalize();
patchAgentPresetWorkflow();
patchPtcPresetWorkflowEnabled();
patchTerminalBundleRows();
patchTerminalKeyboardResizeGuard();
patchFsLocalLink();
patchFsLocalPermissionHint();
patchAttachmentLocalLink();
patchAttachmentLocalCause();
patchImageBackendUnavailable();
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
patchNodePtySocketGuard();
patchClientHmrPoll();
patchWebToolDeepHtmlFallback();
patchWebFetchHeaders();
patchSidebarTabIdLeak();
patchDefaultWorkspaceToast();
ensureRipgrepPlatformPackage();
patchFsSearchFallback();
patchAgentInstructionsScopeWalk();
/*
 * 【WS 自愈，2026-10-31】必须排在 `patchClientHmrPoll` 之类**同目录不同文件**的补丁之外、
 * 且早于 `pack()`。它改的是浏览器侧 `dsh-api-gateway/lib/client.browser.js`
 * （`RemoteStreamMuxClient`），与其他补丁无顺序耦合；放在树落盘之后、签名之前。
 */
/*
 * ── 回环网络豁免（docs/337）：ArkWeb 把 127.0.0.1 误判为 Offline，连接永久卡死 ──
 *
 * 【真机证据（2026-10-31 20:04–20:05，平板，+dshm.104）】
 *   20:04:38  nqe: event_message: network qualicy changed ... effective_connection_type Offline
 *   20:04:39.261  ACCEPT #10 127.0.0.1:41980          ← Host 正常接受 TCP
 *   20:04:39.262  IN-UPGRADE GET /api/remote.mux ... cookie=224B origin=http://127.0.0.1:3120
 *                 URLRequestCanceled error:ERR_WS_UPGRADE(-173) duration:6ms NQE:...Offline
 *   之后 27 秒内：零 ACCEPT、零 IN-UPGRADE —— 再没有任何连接尝试。
 *
 * 【机制（dsh-client-connection/lib/client.browser.js 实证）】
 *   watchBrowserNetwork():
 *     const initiallyAvailable = navigator?.onLine;      // ← ArkWeb 对回环报 false
 *     controller.setNetworkAvailable(initiallyAvailable); // → networkAvailable=false
 *     browser.addEventListener("online", online);        // ← 只认系统 online 事件
 *
 *   ClientConnectionLoop.loop():
 *     while (running) {
 *       if (!this.networkAvailable && !this.immediateRetry) {
 *         emitState("disconnected");                       // ← 左下角「连接异常，刷新重试」
 *         await waitForAbort(retryDelay.signal);           // ← **卡死**，只有 online 能唤醒
 *       }
 *     }
 *
 *   ⇒ 本机 Host 就在 127.0.0.1:3120 上活着、端口可连（ACCEPT 已证明），
 *     但 ArkWeb 的 navigator.onLine=false 让连接循环认定"设备离线"而永久休眠；
 *     而系统永远不会补发 online 事件（网络从头到尾都是通的）。
 *     **这不是"连不上"，是"根本不再尝试"。**
 *
 * 【为什么同步补上的 selfHeal 也救不了】docs/335 的 `scheduleSelfHeal` 在
 *   `dsh-api-gateway` 的 RemoteStreamMuxClient 层，而卡死发生在上游
 *   `dsh-client-connection` 的 `networkAvailable` 闸门——闸门不放行，
 *   下层连 `maintain()` 都进不去。层级搞错了，所以日志里一条 `[DSHM-WS]` 都没有。
 *
 * 【修法（最小侵入，只动"网络可用性"这一件事）】
 *   1. `watchBrowserNetwork()`：回环页面的 `navigator.onLine === false` **不予采信**
 *      （页面本身就是从 127.0.0.1 加载的，能加载出来就说明回环可达）；
 *   2. `loop()` 的离线闸门：把页面判据从"设备在线"放宽为"**Host 可达即可**"——
 *      给 `networkAvailable` 之外再认一个 `loopbackBypass`，回环下永不休眠；
 *   3. 保留原有的 online/offline 监听（真断网时仍会降级并如实显示）。
 */
function patchLoopbackNetworkBypass() {
  const target = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-client-connection', 'lib', 'client.browser.js');
  if (!existsSync(target)) die(`回环网络豁免补丁：找不到 ${target}`);
  let text = readFileSync(target, 'utf8');
  if (text.includes('DSHM_LOOPBACK_NET_BYPASS')) {
    log('[pack-core]   回环网络豁免补丁已存在（跳过）');
    return;
  }

  // ── ① watchBrowserNetwork：回环页面不采信 navigator.onLine=false ──────────
  text = text.replace('const initiallyAvailable=browser?.navigator?.onLine;', 'const initiallyAvailable = browser?.navigator?.onLine;')
    .replace('const offline=()=>{controller.setNetworkAvailable(false)};', '\t\t\tconst offline = () => {\n\t\t\t\tcontroller.setNetworkAvailable(false);\n\t\t\t};');
  const anchorWatch = 'const initiallyAvailable = browser?.navigator?.onLine;';
  if ((text.split(anchorWatch).length - 1) !== 1) {
    die('回环网络豁免补丁：watchBrowserNetwork 锚点不唯一，拒绝静默跳过');
  }
  text = text.replace(anchorWatch,
    '/* DSHM_LOOPBACK_NET_BYPASS: 回环页面（从 127.0.0.1/localhost 加载）能渲染出来\n'
    + '\t\t\t * 就证明回环可达，此时 ArkWeb 报的 navigator.onLine=false 不可采信。 */\n'
    + '\t\t\tconst dshmLoopbackPage = (() => {\n'
    + '\t\t\t\ttry {\n'
    + '\t\t\t\t\tconst h = (globalThis.location?.hostname ?? "").toLowerCase();\n'
    + '\t\t\t\t\treturn h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1"\n'
    + '\t\t\t\t\t\t|| /^127\\./.test(h);\n'
    + '\t\t\t\t} catch (e) { return false; }\n'
    + '\t\t\t})();\n'
    + '\t\t\tconst initiallyAvailable = dshmLoopbackPage ? true : browser?.navigator?.onLine;');

  // ── ② offline 监听：回环页面不因 offline 事件休眠（仍是真断网时记录，但不锁死） ──
  const anchorOffline = '\t\t\tconst offline = () => {\n'
    + '\t\t\t\tcontroller.setNetworkAvailable(false);\n'
    + '\t\t\t};';
  if ((text.split(anchorOffline).length - 1) === 1) {
    text = text.replace(anchorOffline,
      '\t\t\tconst offline = () => {\n'
      + '\t\t\t\t/* DSHM_LOOPBACK_NET_BYPASS: 回环页面不因 ArkWeb 的 offline 误判而休眠。 */\n'
      + '\t\t\t\tif (dshmLoopbackPage) { return; }\n'
      + '\t\t\t\tcontroller.setNetworkAvailable(false);\n'
      + '\t\t\t};');
  } else {
    die('回环网络豁免补丁：offline 监听锚点不唯一，拒绝静默跳过');
  }

  writeFileSync(target, text, 'utf8');
  log('[pack-core]   回环网络豁免补丁：ArkWeb 误报 Offline 时连接不再永久休眠（DSHM_LOOPBACK_NET_BYPASS）');
}
patchLoopbackNetworkBypass();

patchRemoteStreamSelfHeal();
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
deferPluginSubprocessImports(STAGE);
patchRuntimeScopeStartup(STAGE);
deferProfilePluginImports(STAGE);
patchCredentialsLocalStartup(STAGE);
patchHmrObserveStartup(STAGE);
patchHmrStartupSnapshot(STAGE);
await useScheduleOutputPrecompile(STAGE);
patchWorkbenchStartupMode(STAGE);
patchWorkbenchStartup(STAGE);
patchSettingsStartup(STAGE);
patchSettingsController(STAGE);
patchCordisStartup(STAGE);
patchPostStartupImports(STAGE);
// 「在文件夹显示」移动端可用性（2026-11-26）：客户端菜单在 desktop=false 时
// 改走壳层 __DSHM_BRIDGES__.openFileLocation；纯客户端补丁，不进启动路径。
patchOpenInAppReveal(STAGE);
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
log(`  暂存依赖   ${(manifest.nodeModules.unpackedBytes / 1048576).toFixed(1)} MB / ${manifest.nodeModules.fileCount} 文件`);
log(`  分发包     ${manifest.package.file}  ${(manifest.package.bytes / 1048576).toFixed(1)} MB / ${manifest.package.entries} 条目`);
log(`  sha256     ${manifest.package.sha256}`);
log(`  签名       ${manifest.native.signatureCheckSkipped ? '未校验' : `${manifest.native.signed.length} 通过 / ${manifest.native.unsigned.length} 未检出`}`);

if (PLACE_IN_APP) {
  placeIntoApp();
}

/**
 * 把本次产出的核心容器放进 entry 的 resfile（`--place-in-app`）。
 *
 * 三条纪律（都来自实测事故，见 AGENTS.md）：
 *   1. 目标文件名**必须**与配方 `coreVersion` 一致 —— 端侧按目录名/文件名认版本；
 *   2. 先清掉 resfile 里**其它**核心容器 —— 只增不删会让 HAP 从 306 MiB 顶到 491 MiB；
 *   3. 拷完立刻回读 sha256 并与本次产出一致，不一致就判错退出（不写"看起来成功了"）。
 */
function placeIntoApp() {
  const src = resolve(ROOT, manifest.package.file);
  const base = basename(src);
  if (!existsSync(RESFILE_DIR)) {
    mkdirSync(RESFILE_DIR, { recursive: true });
  }
  const stale = readdirSync(RESFILE_DIR)
    .filter((n) => /^dsh-core-.+\.zip$/.test(n) && n !== base);
  for (const n of stale) {
    rmSync(join(RESFILE_DIR, n), { force: true });
    log(`  放置       清掉旧容器 ${n}`);
  }
  const dst = join(RESFILE_DIR, base);
  copyFileSync(src, dst);
  const back = createHash('sha256').update(readFileSync(dst)).digest('hex');
  if (back !== manifest.package.sha256) {
    die(`放置后回读 sha256 不一致：期望 ${manifest.package.sha256}，实际 ${back}`);
  }
  log(`  放置       → hostruntime/src/main/resources/resfile/${base}（sha256 复核一致）`);
}
