#!/usr/bin/env node
/*
 * assert-resfile-sync.mjs —— resfile 快照与 hostcore 源逐字节一致性检查
 *
 * 【为什么需要】批次备注八 ③ 事故：门禁链漏跑 place-host-app.mjs 时，
 * resfile 里的 main.js 停留在上一次拷贝的快照（拆除前版本），build 忠实
 * 打包旧文件——**全程零报错**，直到装机后 tail dshm-host.log 才发现设备
 * 在跑旧代码。快照失同步是静默的，此断言把它变成显式 FAIL。
 *
 * 【用法】place-host-app 之后、build 之前跑：node tools/assert-resfile-sync.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 与 place-host-app.mjs 的 FILES 保持同步（新增文件两处一起改）
const FILES = [
  'dshm-update-transaction.cjs',
  'dshm-profile-writer.cjs',
  'main.js',
  'startup-work.cjs',
  'tar-gz.cjs',
  'jitless-env.cjs',
  'worker-bootstrap.cjs',
  'fetch-shim.js',
  'undici-shim.mjs',
  'undici-loader.mjs',
  'require-builtin-shim.cjs',
  'internal-undici-shim.cjs',
  'dshm-installer.js',
  'dshm-install-command.js',
  'dshm-market-patch.cjs',
  'dshm-user-rows.js',
  'dshm-skills.js',
  'dshm-compat.js',
  // LOOP-GAP 治理（2026-10-19）：main.js 在核心树 require 之前 `require('./fs-probe-cache.cjs')`。
  // 漏掉它不会崩（安装点自带 try/catch，只留一行 diag），但**缓存层整段不生效** ⇒
  // 真机 LOOP-GAP / SYNC-COUNT 与修复前一模一样，属于"静默白修"，必须一起进清单。
  'fs-probe-cache.cjs',
  // LOOP-GAP 除根（2026-10-19，见 docs/199 §8）：main.js 在**核心树 require 之前、负结果缓存之前**
  // `require('./module-path-guard.cjs')`，摘掉全局模块路径里指向 `/storage/Users/currentUser` 的项
  // （公共存储挂载，真机一次负探测可达 192s）。漏掉它不会崩（安装点自带 try/catch），但第一次
  // 探测仍走慢路径 ⇒ 等于没除根，必须一起进清单。
  'module-path-guard.cjs',
  // LOOP-GAP 根因二（2026-10-19，见 docs/200）：Python 的执行搬到 worker 线程。
  //   · python-bridge-async.cjs 被 main.js 顶层 require ⇒ 漏掉它 Host 直接起不来；
  //   · python-worker.cjs 是 worker 入口 ⇒ 漏掉它只会让**首个 python 请求**失败
  //     （MODULE_NOT_FOUND 被端点吞成一行 diag），启动日志毫无异常 —— 正是本门禁存在的理由。
  'python-bridge-async.cjs',
  'python-worker.cjs',
  // 插件独立 Node CLI（2026-10-25）：main.js 顶层 require；漏掉它 Host 直接
  // MODULE_NOT_FOUND。随包 nodecli 本体由 tools/build-node-cli.mjs 生成。
  'node-runtime-provision.cjs',
  'ffmpeg-runtime-provision.cjs',
  // 冷启动治理（2026-11-15）：main.js 在 CORE_DIR/HOME_DIR 就绪后 require
  // './resolve-cache.cjs' 安装持久解析缓存。漏掉它不会崩（安装点自带 try/catch，
  // 只留一行 diag），但解析缓存整段不生效 ⇒ 冷启动白修，必须一起进清单。
  'resolve-cache.cjs',
  // 冷启动种子（2026-11-16）：main.js 在 installResolveCache 之前 require
  // './boot-seed.cjs' 装载随包种子（解析表 JSON + V8 code cache blob）。
  // 漏掉它不会崩（安装点自带 try/catch），但全新安装后的第一次启动全冷
  // —— 静默白修，必须进清单。
  'boot-seed.cjs',
];
const SRC_DIR = join(ROOT, 'hostcore', 'app');
const DST_DIR = join(ROOT, 'hostruntime', 'src', 'main', 'resources', 'resfile', 'resources', 'app');

let failed = 0;
for (const name of FILES) {
  let src;
  let dst;
  try {
    src = readFileSync(join(SRC_DIR, name));
  } catch {
    console.error(`FAIL：hostcore/app/${name} 缺失`);
    failed += 1;
    continue;
  }
  try {
    dst = readFileSync(join(DST_DIR, name));
  } catch {
    console.error(`FAIL：resfile/resources/app/${name} 缺失（先跑 place-host-app.mjs）`);
    failed += 1;
    continue;
  }
  if (src.equals(dst)) {
    console.log(`ok  ：${name} 一致（${src.length}B）`);
  } else {
    console.error(`FAIL：${name} 不一致（hostcore ${src.length}B vs resfile ${dst.length}B）——重跑 place-host-app.mjs`);
    failed += 1;
  }
}

// package.json 由 place-host-app 内联生成（非拷贝），走语义锁：
// CommonJS 关键约束 = 无 "type" 字段 + main 指向 main.js（有 "type":"module"
// 会让 main.js 里的 require/__dirname 全炸）。
try {
  const pkg = JSON.parse(readFileSync(join(DST_DIR, 'package.json'), 'utf8'));
  if (pkg.main === 'main.js' && pkg.type === undefined) {
    console.log('ok  ：package.json 语义锁（main=main.js，无 type 字段 ⇒ CommonJS）');
  } else {
    console.error(`FAIL：package.json 语义漂移（main=${pkg.main} type=${pkg.type}）——查 place-host-app.mjs`);
    failed += 1;
  }
} catch (e) {
  console.error(`FAIL：package.json 解析失败（${e && e.message}）`);
  failed += 1;
}

if (failed > 0) {
  console.error(`assert-resfile-sync：${failed} 项失同步`);
  process.exit(1);
}
console.log(`assert-resfile-sync：${FILES.length + 1} 件快照全部同步`);
