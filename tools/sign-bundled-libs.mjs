#!/usr/bin/env node
/**
 * 给**随包动态库**补 `.codesign`（构建期，幂等）。
 *
 * 【为什么必须有这一步（2026-11-05，真机 A/B 实证）】
 * `nodecli` 是独立进程（exec 域），它用 `dlopen` 加载 `libnode.so.137`。实测：
 *
 *   $ dlprobe /data/storage/el1/bundle/libs/arm64/libnode.so.137
 *   ERR: Error loading shared library …/libnode.so.137: Permission denied
 *   $ # 同一份文件自签名后（复制到 files 下）
 *   OK
 *
 * 系统 `libc++_shared.so` 能加载、未签名的随包 `libnode` 不能 —— **签名域策略**
 * 只放行「带 `.codesign` 的 ELF」，与文件权限无关。三轮复测里
 * `dsh --version → rc=127 / libnode 加载失败`、以及「PC 上 ELF 启动器一换就坏」
 * 都是这一条造成的（不是路径写错，路径只是**表象**）。
 *
 * 【为什么在打包前做】HAP 的签名在 `SignHap` 阶段覆盖**最终字节**；必须先签库、
 * 再让 hvigor 打包，否则改了库就把 HAP 签名弄坏。
 *
 * 用法：
 *   node tools/sign-bundled-libs.mjs          # 签名（已有 .codesign 则跳过）
 *   node tools/sign-bundled-libs.mjs --check  # 只校验，未签则非零退出
 */

import { existsSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_SIGN = join(ROOT, 'third_party', 'ohos-selfsign', 'selfsign.js');

/** 随包库：与 `hostruntime/src/main/module.json5` 的 `libs` 分发口径一致。 */
const TARGETS = [
  join(ROOT, 'hostruntime', 'libs', 'arm64-v8a', 'libnode.so.147'),
  join(ROOT, 'hostruntime', 'libs', 'arm64-v8a', 'libc++_shared.so'),
];

const CODESIGN = Buffer.from('.codesign\0', 'utf8');

function fail(message) {
  console.error(`sign-bundled-libs: ${message}`);
  process.exit(2);
}

function signed(file) {
  return readFileSync(file).includes(CODESIGN);
}

function sign(file) {
  if (!existsSync(SELF_SIGN)) fail(`缺自签名工具：${SELF_SIGN}`);
  const r = spawnSync(process.execPath, [SELF_SIGN, file, file, '--force'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) {
    fail(`签名失败：${file}\n${String(r.stderr || r.stdout || '').trim().slice(0, 400)}`);
  }
}

const checkOnly = process.argv.includes('--check');
const problems = [];

for (const file of TARGETS) {
  if (!existsSync(file)) {
    /* libc++ 可能由 SDK 提供，不在仓内；缺了只告警，不算失败。 */
    if (file.endsWith('libc++_shared.so')) continue;
    problems.push(`缺随包库：${file}`);
    continue;
  }
  if (checkOnly) {
    if (!signed(file)) problems.push(`未签名（exec 域 dlopen 会被拒）：${file}`);
    else console.log(`[sign-bundled-libs] ok  ${file}（${statSync(file).size} B）`);
    continue;
  }
  if (signed(file)) {
    console.log(`[sign-bundled-libs] 已签，跳过：${file}`);
  } else {
    sign(file);
    chmodSync(file, 0o755);
    if (!signed(file)) problems.push(`签名后仍找不到 .codesign：${file}`);
    else console.log(`[sign-bundled-libs] 已签名 ${file}（${statSync(file).size} B）`);
  }
}

if (problems.length > 0) {
  console.error('sign-bundled-libs: 失败');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`sign-bundled-libs: ${checkOnly ? '校验通过' : '完成'}`);