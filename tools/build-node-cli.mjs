#!/usr/bin/env node
/**
 * 编译并自签名随包 `nodecli`。
 *
 * 产物：hostruntime/src/main/resources/resfile/toolchain/node/nodecli
 *
 * 为什么需要：
 *   dsh-bili-whale 等插件会 spawn 独立 `node`，而 DSHM Host 只有内嵌
 *   libnode.so.137。完整 Node CLI 约 130 MB，会与随包 libnode 重复；
 *   nodecli 只用约几十 KB，在独立进程中 dlopen 同一份 libnode。
 *
 * 签名：
 *   端侧 execve 要求第三方 ELF 带 `.codesign`。优先使用既有
 *   `binary-sign-tool.jar`；本机 CLT 未带该 jar 时使用 third_party 中
 *   固定版本的 ohos-selfsign（0BSD，仅做 selfSign 段）。
 *
 * 用法：
 *   node tools/build-node-cli.mjs
 *   node tools/build-node-cli.mjs --check
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devecoPath, devecoSdkHomeCandidates } from './lib/deveco-home.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'hostruntime', 'src', 'main', 'cpp', 'nodecli.c');
const DEST = join(ROOT, 'hostruntime', 'src', 'main', 'resources', 'resfile', 'toolchain', 'node', 'nodecli');
const SELF_SIGN = join(ROOT, 'third_party', 'ohos-selfsign', 'selfsign.js');

function fail(message) {
  console.error(`build-node-cli: ${message}`);
  process.exit(2);
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    fail(`${file} 失败（exit=${result.status ?? 'null'}）${detail ? `\n${detail}` : ''}`);
  }
  return String(result.stdout || '');
}

function findNativeSdk() {
  const candidates = [];
  for (const sdkHome of devecoSdkHomeCandidates()) {
    candidates.push(join(sdkHome, 'default', 'openharmony', 'native'));
  }
  const explicit = process.env.DSHM_OHOS_NATIVE_SDK;
  if (explicit) {
    candidates.unshift(explicit);
  }
  for (const native of candidates) {
    const clang = join(native, 'llvm', 'bin', 'aarch64-unknown-linux-ohos-clang');
    const sysroot = join(native, 'sysroot');
    if (existsSync(clang) && existsSync(sysroot)) {
      return { clang, sysroot };
    }
  }
  fail('找不到 OpenHarmony native SDK（可用 DSHM_OHOS_NATIVE_SDK 指向 native 目录）');
}

function signerCommand() {
  const explicit = String(process.env.DSHM_ELF_SIGNER || '').trim();
  if (explicit) {
    return explicit.endsWith('.js')
      ? { file: process.execPath, prefix: [explicit] }
      : { file: explicit, prefix: [] };
  }
  if (existsSync(SELF_SIGN)) {
    return { file: process.execPath, prefix: [SELF_SIGN] };
  }
  const java = process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    : devecoPath(join('jbr', 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  for (const sdkHome of devecoSdkHomeCandidates()) {
    const jar = join(sdkHome, 'default', 'openharmony', 'toolchains', 'lib', 'binary-sign-tool.jar');
    if (java && existsSync(java) && existsSync(jar)) {
      return { file: java, prefix: ['-jar', jar, 'sign', '-mode', 'localSign', '-selfSign', '1', '-signAlg', 'SHA256withECDSA'] };
    }
  }
  fail('找不到 ELF 自签名工具（设置 DSHM_ELF_SIGNER，或放置 third_party/ohos-selfsign/selfsign.js）');
}

function checkSigned() {
  if (!existsSync(DEST)) {
    fail(`产物不存在：${DEST}`);
  }
  const signer = signerCommand();
  if (signer.prefix[0] === SELF_SIGN) {
    run(signer.file, [...signer.prefix, DEST, '--check']);
  }
  console.log(`build-node-cli: OK ${DEST} (${statSync(DEST).size} B)`);
}

if (process.argv.includes('--check')) {
  checkSigned();
  process.exit(0);
}
if (!existsSync(SOURCE)) fail(`源码不存在：${SOURCE}`);

const sdk = findNativeSdk();
mkdirSync(dirname(DEST), { recursive: true });
const stage = mkdtempSync(join(tmpdir(), 'dshm-node-cli-build-'));
const unsigned = join(stage, 'nodecli');
try {
  run(sdk.clang, [
    '--target=aarch64-linux-ohos',
    `--sysroot=${sdk.sysroot}`,
    '-D__MUSL__',
    '-fno-emulated-tls',
    '-std=gnu11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-fPIE',
    '-pie',
    SOURCE,
    '-o',
    unsigned,
    '-ldl',
    // libnode 自身需要 libc++ 的异常/RTTI 符号。即使本程序是纯 C，也要把
    // libc++_shared 放进它的依赖闭包，否则运行时 dlopen(libnode) 会报
    // `_Unwind_Resume / __cxa_*: symbol not found`。
    '-lc++_shared',
    /*
     * 【**不要**写 RUNPATH 到 el1（2026-11-05，真机 A/B 实证）】
     * 旧实现写 `-Wl,-rpath,/data/storage/el1/bundle/libs/arm64`，于是启动期就要
     * 从 el1 加载 `libc++_shared.so`；而 el1 里的 .so **未带 .codesign**，
     * exec 域加载直接被拒：
     *   `Error loading shared library libc++_shared.so: (needed by ./dsh)`
     * 对照实验（同一二进制、只改搜索路径）：加 `LD_LIBRARY_PATH=/system/lib64`
     * 立刻能跑到 dlopen 阶段 ⇒ 系统库可用、el1 库不可用。
     *
     * 现在：本程序只 NEEDED `libc.so`/`libc++_shared.so`（由**系统**提供），
     * 随包 `libnode.so.137` 由 `tools/sign-bundled-libs.mjs` 在构建期自签名后，
     * 再用**绝对路径** dlopen —— 这才是 exec 域唯一可行的组合。
     */
  ]);

  const signer = signerCommand();
  if (signer.prefix[0] === SELF_SIGN) {
    run(signer.file, [...signer.prefix, unsigned, DEST, '--force']);
  } else {
    const args = [...signer.prefix];
    if (args.includes('-jar')) {
      args.push('-inFile', unsigned, '-outFile', DEST);
    } else {
      args.push(unsigned, DEST, '--force');
    }
    run(signer.file, args);
  }
  const magic = readFileSync(DEST).subarray(0, 4);
  if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    fail('签名产物不是 ELF');
  }
  checkSigned();
  console.log(`build-node-cli: 源码 ${SOURCE}`);
  console.log(`build-node-cli: 签名 ${signer.file}`);
} finally {
  try {
    rmSync(stage, { recursive: true, force: true });
  } catch {
    // 临时目录清理失败不影响产物。
  }
}
