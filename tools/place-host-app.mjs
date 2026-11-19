#!/usr/bin/env node
/*
 * 把 Host 入口脚本放进共享 HSP（`hostruntime/src/main/resources/resfile/resources/app/`）。
 *
 * 【为什么入口归 entry 自己所有】此前它靠 `web_engine` 那个 HAR 的 resfile 合并进 HAP
 * （`tools/electron-runtime/place-host-app.ps1` 把 main.js 拷进 web_engine）。阶段一的
 * Electron 链已整体移除（D6 E49），`entry` 也不再依赖 `web_engine` —— 结果就是入口脚本
 * **从 HAP 里消失**（实测：HAP 内不再有 `resources/resfile/resources/app/`），
 * 表现为 Host 永远起不来。所以入口改由 `entry` 自己携带，并用本脚本同步。
 *
 * 【为什么是"拷贝"而不是软链/引用】鸿蒙侧通过 `resourceDir + /resources/app/main.js`
 * 直接按真实路径读取（resfile 安装后会解压到沙箱，可按真实路径只读访问），所以
 * HAP 里必须有这几份真实文件。
 *
 * 产物目录已 gitignore（生成物：字节不进库、方法进库）。
 * 用法：node tools/place-host-app.mjs
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPlans, backupDirFor, planWrite } from './lib/safe-apply.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(ROOT, 'hostcore', 'app');
const DEST = join(ROOT, 'hostruntime', 'src', 'main', 'resources', 'resfile', 'resources', 'app');

// 入口脚本依赖的文件，缺一份都会让端侧功能静默变哑：
//   · main.js       —— 入口本身
//   · fetch-shim.js —— 被 main.js `require('./fetch-shim.js')`（jitless 下垫 fetch，见 D6 E52）
//   · undici-shim.mjs / undici-loader.mjs
//       被 main.js `register()` 的解析钩子指向。**漏掉这两个不会报错**，只会让
//       `import("undici")` 落回原生 undici，而它在 jitless 下必然抛
//       `WebAssembly is not defined` ⇒ 表现为"web_fetch 打不开任何网页"（矩阵 §3.2）。
//   · require-builtin-shim.cjs
//       被 main.js `installRequireBuiltinShim()` 拦截 `Module._load` 指向。**漏掉它
//       Host 直接起不来**：0.1.6-alpha.2 的 host preparation 要经
//       node-addon-require-builtin 访问 internal 模块，真机没有 openharmony 平台包
//       ⇒ `No usable native binding found for …openharmony-arm64 (auto)`。
//   · dshm-installer.js
//       被 main.js 安装队列段 `require('./dshm-installer.js')`（D26 插件安装器）。
//       【2026-09-23 缺口教训】它曾靠 9/21 手工拷贝进 resfile、不在本清单——
//       源头修改后 build 仍打旧文件，**全程零报错**，装机后表现为"修复不生效"。
//   · dshm-skills.js
//       被 main.js 的 ensureBundledSkills `require('./dshm-skills.js')`（P0-1 修复：
//       skill 同步按内容 sha256 判等）。漏掉它 ⇒ 端侧 require 抛 MODULE_NOT_FOUND，
//       被那个 try/catch 吞成一行 diag ⇒ **内置技能再也不更新**，与 P0-1 原来的
//       症状（改了推不下去）一模一样，等于修复白做。同样必须进清单。
//   · jitless-env.cjs —— jitless 运行期补齐层（**单份实现**：主线程与 worker 共用，
//       原先内联在 main.js 的五段挂载点都指向它）。漏掉它 ⇒ main.js 第 281 行起
//       每一处 `jitlessEnv.*` 全抛 MODULE_NOT_FOUND。
//   · internal-undici-shim.cjs
//       被 jitless-env.cjs 的 `installInternalUndiciShim()` **在 BuiltinModule 层**接管
//       （预置 `BuiltinModule.map` 里 `internal/deps/undici/undici` 的 exports/loaded）。
//       漏掉它 ⇒ 安装函数自己 require 时就抛 MODULE_NOT_FOUND（被调用点吞成一行 diag），
//       而 Node 内部那条路径照旧炸（`internal/worker/io.js` 每投递一条 MessagePort 消息
//       都会 require 它）⇒ 插件激活失败、`/bootstrap` 恒 404 —— **与完全不修一模一样**
//       （2026-10-05 真机形态）。
//   · worker-bootstrap.cjs —— worker 线程的 `--require` preload（由
//       `jitlessEnv.wrapWorkerThreads()` 注入）。**漏掉它不会报错**，只会让每个 worker
//       退回"没有补齐"的状态：`import("node-addon-require-builtin")` 又变成真 addon、
//       worker 里的 `globalThis.fetch` 又是原生 undici ⇒ 插件自建 worker 激活失败
//       （真机形态：开发者工具启用 experimental-inspector 报
//       `dsh: warning: 1 entry did not activate … WebAssembly is not defined`）。
//   · tar-gz.cjs —— 纯 JS tar / tar.gz 解包（**单份实现**，插件安装器与工具链共用）。
//       main.js 的工具链解包在手机 / 平板档**不能 spawn**（本档应用自带可执行文件一律
//       EACCES，见 docs/104）⇒ 走进程内回退；漏掉它 ⇒ `require('./tar-gz.cjs')` 抛
//       MODULE_NOT_FOUND，被调用点吞成一行 diag，表现为 `toolchain/python/bin/*` 永远为空、
//       `runtime.python` 永远 `stdlib=false`（与修复前一模一样）。
//       `dshm-installer.js` 也 require 它 ⇒ 插件安装同样会哑。
//   · dshm-market-patch.cjs
//       被 main.js 的安装队列段 `require('./dshm-market-patch.cjs')`（2026-10-14：市场挂载
//       契约补丁的**装完重放**）。漏掉它 ⇒ require 抛 MODULE_NOT_FOUND（被队列的 try/catch
//       吞成一行日志）⇒ 启动之后才装进来的皮肤市场永远是上游原形，302 条皮肤只剩 41 条能
//       一键装，其余一律「需手动安装」，与不修一模一样。
//   · fs-probe-cache.cjs —— 同步 fs「探测型」调用的负结果缓存（LOOP-GAP 根因治理，2026-10-19；
//       见 docs/199）。被 main.js 在**核心树 require 之前**安装（`installFsProbeCache()`），
//       只缓存 existsSync/statSync/readFileSync 的负结果。漏掉它**不会崩**（安装点自带
//       try/catch，只留一行 diag），但缓存层整段不生效 ⇒ 真机 LOOP-GAP / SYNC-COUNT 与
//       修复前一模一样，属于"静默白修"，所以必须进清单。
//   · python-worker.cjs —— 进程内 CPython 的**执行线程**（LOOP-GAP 根因二，2026-10-19；见 docs/200）。
//       由 ./python-bridge-async.cjs 用 `new Worker(path.join(__dirname, 'python-worker.cjs'))` 起，
//       是**唯一** dlopen libpython_runner.so 并执行 Python 的地方。漏掉它不会在启动时报错 ——
//       它是**首个 python 请求**才走到 ⇒ 表现为"python 工具 / python3 垫片调用失败（MODULE_NOT_FOUND）"，
//       而主线程同步执行那条老路已经**不再**被默认使用（降级开关 DSHM_PY_INLINE=1 才回去）。
//   · python-bridge-async.cjs —— 主线程侧的排队/调度/超时 terminate（同上）。被 main.js 顶层
//       `require('./python-bridge-async.cjs')` ⇒ 漏掉它 **Host 直接起不来**（MODULE_NOT_FOUND
//       在 require 处抛出，boot 链断在第一行），所以这一项是硬依赖。
//   · module-path-guard.cjs —— Node 全局模块搜索路径收窄（LOOP-GAP 除根，2026-10-19；见
//       docs/199 §8）。被 main.js 在**核心树 require 之前、fs 探测缓存之前**安装：摘掉
//       全局列表 / `NODE_PATH` 里指向 `/storage/Users/currentUser` 的项（公共存储挂载，
//       真机一次负探测可达 192s）。漏掉它**不会崩**（安装点自带 try/catch），但第一次探测
//       仍然走慢路径 ⇒ 只省了第二次，等于没除根。
//   · resolve-cache.cjs —— 核心树 ESM 解析结果的跨启动持久缓存（冷启动治理，2026-11-15）。
//       被 main.js 在 CORE_DIR/HOME_DIR 就绪后、核心树 import 之前安装
//       （`installResolveCache()`，内部走 module.registerHooks）。漏掉它**不会崩**
//       （安装点自带 try/catch，只留一行 diag），但解析缓存整段不生效 ⇒ 冷启动
//       BOOT_40→50 与不修一模一样，属于"静默白修"，所以必须进清单。
//   · boot-seed.cjs —— 冷启动"种子"装载器（首启提速，2026-11-16）。被 main.js 在
//       installResolveCache 之前、核心树装载之前调用（`installBootSeed()`）：把随包
//       resfile/boot-seed/ 里的解析表 JSON + V8 code cache blob 拷进可写目录。
//       漏掉它**不会崩**（安装点自带 try/catch），但全新安装后的第一次启动
//       全冷（解析空表 + 冷编译），种子整段不生效 —— 又一处"静默白修"，必须进清单。
const FILES = ['main.js', 'tar-gz.cjs', 'jitless-env.cjs', 'worker-bootstrap.cjs', 'fetch-shim.js', 'undici-shim.mjs', 'undici-loader.mjs', 'require-builtin-shim.cjs', 'internal-undici-shim.cjs', 'dshm-installer.js', 'dshm-install-command.js', 'dshm-market-patch.cjs', 'dshm-user-rows.js', 'dshm-skills.js', 'dshm-compat.js', 'fs-probe-cache.cjs', 'module-path-guard.cjs', 'python-worker.cjs', 'python-bridge-async.cjs', 'node-runtime-provision.cjs', 'ffmpeg-runtime-provision.cjs', 'resolve-cache.cjs', 'boot-seed.cjs'];

/*
 * 【2026-11-16 工具纪律】默认行为不变；新增两个可选开关：
 *   --dry-run  只打印将要写入/跳过/变更的文件，不落盘；
 *   --backup   覆盖前把旧文件备份到 dist/backups/place-host-app/<时间戳>/。
 * 未变更的文件不再重复写（减少构建期无谓的文件 mtime 变化）。
 */
const dryRun = process.argv.includes('--dry-run');
const wantBackup = process.argv.includes('--backup');
const backupDir = wantBackup ? backupDirFor(ROOT, 'place-host-app') : '';

if (!dryRun) mkdirSync(DEST, { recursive: true });

FILES.push('dshm-update-transaction.cjs');
FILES.push('dshm-profile-writer.cjs');
FILES.push('startup-work.cjs');
const missing = FILES.filter((name) => !existsSync(join(SRC_DIR, name)));
if (missing.length > 0) {
  console.error(`place-host-app: 源文件缺失：${missing.join('、')}（在 ${SRC_DIR}）`);
  process.exit(1);
}

// package.json 刻意**不带** "type" 字段 ⇒ CommonJS（main.js 里用 require/__dirname）
const pkg = {
  name: 'dshm-host',
  version: '1.0.0',
  private: true,
  description: 'DSHM 端侧 Host 入口（在 libnode.so.127 里运行；不属于任何 npm 包发布物）',
  main: 'main.js',
};
const contents = new Map();
const plans = [];
for (const name of [...FILES, 'package.json']) {
  const src = name === 'package.json' ? null : join(SRC_DIR, name);
  const content = src === null ? Buffer.from(JSON.stringify(pkg, null, 2) + '\n') : readFileSync(src);
  const dst = join(DEST, name);
  contents.set(dst, content);
  plans.push(planWrite(dst, content));
}
const result = applyPlans(plans, { content: contents, dryRun, backupDir });
for (const dst of result.written) {
  console.log(`${dryRun ? 'would write' : 'placed   :'} ${dst.slice(DEST.length + 1)}`);
}
for (const dst of result.skipped) {
  console.log(`unchanged: ${dst.slice(DEST.length + 1)}`);
}
if (result.backedUp.length > 0) console.log(`backups  : ${backupDir}（${result.backedUp.length} 个）`);
console.log(`dest     : ${DEST}${dryRun ? '（dry-run，未落盘）' : ''}`);
