#!/usr/bin/env node
/**
 * 门禁：`entry/src/main/resources/resfile/` 里**只能有一份**核心容器，且必须与本次产出、
 * 与 `hostcore/core-recipe.json` 的 `coreVersion` 三者一致。
 *
 * ── 为什么需要（两条真实事故，2026-10-05）──────────────────────────
 * 1. **新树从未进过安装包**：`tools/pack-core.mjs` 只有带 `--place-in-app` 时才把容器拷进
 *    resfile（源码 `:2924`）。排障期间多次只跑裸 `node tools/pack-core.mjs` ⇒ HAP 里始终是
 *    旧容器 ⇒ 期间所有**核心树侧**改动（插件加固、`loading` 改 `text-pages`、`AbortSignal`
 *    去重补丁）全部没生效，而链上自检只看"设备树目录名"，一路绿灯 —— 排查方向被带偏数小时。
 * 2. **容器只增不删**：每次 `--place-in-app` 都新增一份 ⇒ 三份 core 共存把 HAP 从 406 MB
 *    顶到 491 MB（真机复测报告 §2 实测）。
 *
 * ── 判据 ────────────────────────────────────────────────────────
 * · resfile 下 `dsh-core-*.zip` 恰好 **1 个**；
 * · 其文件名解析出的版本 == `core-recipe.json` 的 `coreVersion`；
 * · 其 sha256 + 字节数 == `dist/core/dsh-core-<ver>-openharmony-arm64.zip`（本次产出）。
 * 任一不满足 ⇒ exit 1 并逐条打印原因。
 *
 * 用法：`node tools/check-resfile-core-zip.mjs`（无参数；核心树未物化也能跑，只比容器）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESFILE = join(ROOT, 'entry', 'src', 'main', 'resources', 'resfile');
const RECIPE = join(ROOT, 'hostcore', 'core-recipe.json');

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

if (!existsSync(RECIPE)) {
  console.error(`✗ 找不到配方：${RECIPE}`);
  process.exit(2);
}
if (!existsSync(RESFILE)) {
  console.error(`✗ 找不到 resfile：${RESFILE}`);
  process.exit(2);
}

const recipe = JSON.parse(readFileSync(RECIPE, 'utf8'));
const version = recipe.coreVersion;
const expectedName = `dsh-core-${version}-openharmony-arm64.zip`;
const produced = join(ROOT, 'dist', 'core', expectedName);

const containers = readdirSync(RESFILE).filter((n) => n.startsWith('dsh-core-') && n.endsWith('.zip'));
console.log(`配方版本    ${version}`);
console.log(`resfile     ${containers.length} 个容器：${containers.join(', ') || '(无)'}`);

if (containers.length === 0) {
  fail(`resfile 里没有核心容器 —— 是不是漏了 \`pack-core.mjs --place-in-app\`？`);
} else if (containers.length > 1) {
  fail(`resfile 里有 ${containers.length} 份容器（只允许 1 份）：${containers.join(', ')} —— ` +
    '每份约 85 MB，会直接把 HAP 撑大（真机复测 §2 实测 406 MB → 491 MB）。删掉非当前版本的即可。');
}
if (containers.length === 1 && containers[0] !== expectedName) {
  fail(`resfile 里的容器名与配方不符：期望 ${expectedName}，实际 ${containers[0]}`);
}

if (!existsSync(produced)) {
  fail(`dist/core 里没有本次产出 ${expectedName} —— 先跑 \`node tools/pack-core.mjs --place-in-app\``);
} else if (containers.length === 1 && containers[0] === expectedName) {
  const a = join(RESFILE, expectedName);
  const sa = sha256(a);
  const sb = sha256(produced);
  const sz = statSync(a).size;
  const pz = statSync(produced).size;
  console.log(`resfile     ${sz} B  sha256 ${sa.slice(0, 16)}…`);
  console.log(`dist/core   ${pz} B  sha256 ${sb.slice(0, 16)}…`);
  if (sa !== sb || sz !== pz) {
    fail('resfile 里的容器与 dist/core 的本次产出**不一致** —— 安装包里带的不是你刚打的树');
  }
}

if (process.exitCode === undefined) {
  console.log('✅ 通过：resfile 只有 1 份容器，且与配方、与本次产出完全一致。');
}
