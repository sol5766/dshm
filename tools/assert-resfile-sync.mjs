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
  'main.js',
  'jitless-env.cjs',
  'worker-bootstrap.cjs',
  'fetch-shim.js',
  'undici-shim.mjs',
  'undici-loader.mjs',
  'require-builtin-shim.cjs',
  'internal-undici-shim.cjs',
  'dshm-installer.js',
  'dshm-user-rows.js',
  'dshm-skills.js',
  'dshm-compat.js',
];
const SRC_DIR = join(ROOT, 'hostcore', 'app');
const DST_DIR = join(ROOT, 'entry', 'src', 'main', 'resources', 'resfile', 'resources', 'app');

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
