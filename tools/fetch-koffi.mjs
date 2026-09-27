#!/usr/bin/env node
/*
 * 取 koffi 3.x 源码并为 OHOS 构建做准备（生成 trampolines）。
 *
 * 【为什么需要它】D6 E47：dsh 全线声明 `koffi ^3.1.0`，而鸿蒙侧只有
 * `@ohos-ports/koffi@2.16.2-beta.0`（2.x 的 `koffi.struct(...).size` 是 undefined，
 * 会让 `dsh-win32-process` 的模块顶层断言抛错 ⇒ `subprocess-local`/`sandbox-local` 加载失败）。
 * 上游 3.x 的分平台包没有 openharmony 变体，其 musl 包的 `DT_NEEDED` 又是
 * `libstdc++.so.6`/`libc.musl-aarch64.so.1`（鸿蒙不提供）⇒ 只能自己编。
 *
 * koffi 的 npm 包**自带全部源码与依赖头**：
 *   src/koffi/src/{ffi,call,interp,parser,type,util,uv,win32}.cc
 *   src/koffi/src/abi/{arm64,x64sysv}.cc(+_asm.S)
 *   lib/native/base/base.cc、vendor/node-addon-api、vendor/node-api-headers
 * 唯一需要"生成"的是 trampolines/*.inc（由 src/trampolines.cjs 产出，需要 host node）。
 *
 * 产物位置固定为 <repo>/third_party/koffi/（已 gitignore：源码不进库、方法进库）。
 * 用法：node tools/fetch-koffi.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KOFFI_VER = process.env.KOFFI_VER ?? '3.2.1';
const DIR = join(ROOT, 'third_party', 'koffi');
const PKG = join(DIR, 'package');
const TRAMP = join(DIR, 'trampolines');

/** Windows 上 npm/tar 是 .cmd/.exe，交给 shell 解析；两个平台都能跑。 */
function run(file, args, cwd) {
  // shell:true 时含空格的路径必须加引号（npm 装在 "D:\Program Files\nodejs\" 时，
  // 直接传 npm 会被 shell 拆词成 'D:\Program'），与 pack-core.mjs 同一处坑。
  const quoted = file.includes(' ') ? `"${file.replace(/"/g, '\\"')}"` : file;
  execFileSync(quoted, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

mkdirSync(DIR, { recursive: true });

if (!existsSync(join(PKG, 'src', 'koffi', 'CMakeLists.txt'))) {
  console.log(`[koffi] 下载源码 koffi@${KOFFI_VER}`);
  run('npm', ['pack', `koffi@${KOFFI_VER}`], DIR);
  const tgz = readdirSync(DIR).find((f) => f.startsWith(`koffi-${KOFFI_VER}`) && f.endsWith('.tgz'));
  if (tgz === undefined) {
    throw new Error(`npm pack 没有产出 koffi-${KOFFI_VER}*.tgz（检查网络或版本号）`);
  }
  run('tar', ['-xzf', tgz], DIR);
} else {
  console.log('[koffi] 源码已在（跳过下载）');
}

// 头文件与源码的存在性检查：缺任何一项都应在**这里**失败，而不是在漫长的 CMake 编译中途
const required = [
  'src/koffi/src/ffi.cc',
  'src/koffi/src/abi/arm64.cc',
  'src/koffi/src/abi/x64sysv.cc',
  'src/koffi/src/trampolines.cjs',
  'lib/native/base/base.cc',
  'vendor/node-addon-api/napi.h',
  'vendor/node-api-headers/include/node_api.h',
];
const missing = required.filter((rel) => !existsSync(join(PKG, rel)));
if (missing.length > 0) {
  throw new Error(`koffi 源码不完整，缺少：${missing.join('、')}`);
}

if (!existsSync(join(TRAMP, 'gnu.inc'))) {
  console.log('[koffi] 生成 trampolines（host node 执行 src/trampolines.cjs）');
  mkdirSync(TRAMP, { recursive: true });
  execFileSync(process.execPath, [join(PKG, 'src', 'koffi', 'src', 'trampolines.cjs'), TRAMP, '8192'], { stdio: 'inherit' });
} else {
  console.log('[koffi] trampolines 已生成（跳过）');
}

console.log(`[koffi] 就绪：${PKG}`);
console.log('[koffi] 下一步：devecocli build —— entry 的 CMakeLists 会把它编成 libs/<abi>/libkoffi.so');
