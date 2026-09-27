/**
 * Static native-closure check for the libs that will be packed into the HAP (E93).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * On HarmonyOS, hvigor packs `libs/<abi>/*` FLAT: the file name in the HAP is the
 * only name the loader has. Two invariants decide whether the whole native chain
 * can load, and both are invisible on the build machine until the app runs:
 *
 *   1. **SONAME must equal the file name.** The loader matches a `DT_NEEDED`
 *      entry against each candidate's SONAME, not against its file name. Rename a
 *      library (which hvigor forces us to do, because versioned names like
 *      `libglib-2.0.so.0.8800.2` are not `*.so`) without updating its SONAME and
 *      the failure is `cannot open shared object` at runtime, on device only.
 *   2. **Every `DT_NEEDED` must resolve** to either a library we ship in the same
 *      directory or a library the system provides. A missing dependency in the
 *      middle of libvips' 46-library web shows up as one opaque dlopen failure.
 *
 * Neither can be caught by "the build succeeded": this project has already paid
 * for that lesson more than once (E44/E45 are exactly this class of bug). So the
 * closure is checked statically, on the build machine, before anything is packed.
 *
 * Usage:
 *   node tools/check-native-closure.mjs                 # default target/ABI
 *   node tools/check-native-closure.mjs --abi x86_64 --target default
 *   node tools/check-native-closure.mjs --dir <libs 目录>
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const ROOT = process.cwd();
const PATCH_TOOL = join(ROOT, 'tools', 'patch-native-needed.mjs');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const ABI = arg('--abi', 'arm64-v8a');
const TARGET = arg('--target', 'default');
const CANDIDATES = [
  arg('--dir', ''),
  join(ROOT, 'entry', 'build', 'default', 'intermediates', 'libs', TARGET, ABI),
  join(ROOT, 'entry', 'libs', ABI),
].filter((p) => p.length > 0);

/**
 * Libraries the HarmonyOS system image provides. Anything NOT here and NOT shipped
 * by us is a real hole; keeping the list explicit (instead of "unknown => ok")
 * is what makes this check meaningful.
 */
const SYSTEM_LIBS = new Set([
  'libc.so', 'libdl.so', 'libm.so', 'libz.so', 'liblog.so', 'libhilog.so',
  'libhilog_ndk.z.so', 'libace_napi.z.so', 'libuv.so', 'libpthread.so', 'librt.so',
  'libatomic.so', 'libxml2.so.2', 'libEGL.so', 'libGLESv2.so', 'libnative_window.so',
  'libnative_image.so', 'libpixelmap.so', 'libimage_source.so', 'libimage_packer.so',
  'libohimage.so', 'libipc_capi.so', 'libhitrace_ndk.z.so', 'libzstd.so.1',
  /*
   * 【2026-09-27 补入】sherpa-onnx（SenseVoice 语音）依赖 OHOS 的 rawfile 接口，
   * `libsherpa_onnx.so` 与 `libsherpa-onnx-c-api.so` 的 DT_NEEDED 里都有它。
   *
   * 证据：docs/70-鸿蒙移植踩坑与修复总览.md 的依赖表已列明
   *   "`libace_napi.z`/`libhilog_ndk.z`/`librawfile.z` 都是 OHOS 标准系统库"
   * 但本白名单当时只登记了前两个 ⇒ 漏登记使得门禁在 SenseVoice 引入后
   * **一直失败**（报 librawfile.z.so 无法解析），而它其实是系统提供的。
   *
   * 补入依据（不只凭文档）：库文件在项目与 HAP 内**都不存在**，
   * 而设备上能加载（识别功能真机实测通过）⇒ 确为系统库。
   */
  'librawfile.z.so',
]);

function elfInfo(path) {
  const raw = execFileSync(process.execPath, [PATCH_TOOL, path, '-', '-', '--list'], { encoding: 'utf8' });
  return JSON.parse(raw);
}

const dir = CANDIDATES.find((p) => existsSync(p));
if (dir === undefined) {
  console.error(`check-native-closure: 找不到任何原生库目录（试过：${CANDIDATES.join(' / ')}）`);
  process.exit(2);
}

/** `.so*` 与 `.node` 都要检查：两者都会进 HAP 并被 dlopen。 */
const files = readdirSync(dir)
  .filter((name) => /\.so(\.|$)/.test(name) || name.endsWith('.node'))
  .filter((name) => statSync(join(dir, name)).isFile());

if (files.length === 0) {
  console.error(`check-native-closure: ${dir} 里没有任何原生库`);
  process.exit(2);
}

const available = new Set(files);
const problems = [];
const warnings = [];
const rows = [];
/** 先收集"谁被点名为依赖"：只有被点名的库，SONAME 才必须与文件名一致。 */
const referenced = new Set();

for (const name of files.sort()) {
  const path = join(dir, name);
  let info;
  try {
    info = elfInfo(path);
  } catch (e) {
    problems.push(`${name}: 无法读取 ELF 动态段（${String(e.message).slice(0, 120)}）`);
    continue;
  }
  for (const needed of info.needed ?? []) {
    referenced.add(needed);
  }
  rows.push({
    name,
    soname: info.soname ?? '',
    needed: (info.needed ?? []).length,
    rpath: info.rpath ?? info.runpath ?? '',
    unresolved: [],
  });
}

for (const row of rows) {
  // 1. SONAME 与文件名一致 —— **只对被别人 NEEDED 的库是硬要求**。
  //    顶层库（koffi / sharp / pty）由我们的原生重定向按**绝对路径** dlopen，
  //    加载器此时不看 SONAME；而任何被 NEEDED 点名的库，加载器是按 SONAME 匹配的，
  //    名字对不上就是 `cannot open shared object`。
  if (row.soname.length > 0 && row.soname !== row.name) {
    const neededByOther = referenced.has(row.name);
    const message = `${row.name}: SONAME 是 ${row.soname}，与文件名不一致`
      + (neededByOther ? '（且它被别的库 DT_NEEDED 点名）' : '（没有被别人点名，按路径 dlopen，属可接受）');
    if (neededByOther) {
      problems.push(message);
    } else {
      warnings.push(message);
    }
  }
  // 2. 每个依赖都要能解析到"我们打包的库"或"系统库白名单"
  const info = elfInfo(join(dir, row.name));
  const unresolved = [];
  for (const needed of info.needed ?? []) {
    if (available.has(needed) || SYSTEM_LIBS.has(needed)) continue;
    unresolved.push(needed);
  }
  row.unresolved = unresolved;
  if (unresolved.length > 0) {
    problems.push(`${row.name}: 有 ${unresolved.length} 个依赖无法解析：${unresolved.join(', ')}`);
  }
}

console.log(`check-native-closure: ${dir}`);
console.log(`  ${rows.length} 个库；系统库白名单 ${SYSTEM_LIBS.size} 项`);
console.log('');
console.log('library                                  soname-match  needed  unresolved  rpath');
for (const r of rows) {
  const match = r.soname.length === 0 ? '(none)' : (r.soname === r.name ? 'ok' : 'MISMATCH');
  console.log(`${r.name.padEnd(40)} ${match.padEnd(13)} ${String(r.needed).padEnd(7)} ${String(r.unresolved).padEnd(11)} ${r.rpath === '' ? '' : r.rpath}`);
}
console.log('');
if (warnings.length > 0) {
  console.log(`warnings (${warnings.length})：`);
  for (const w of warnings) console.log(`  ~ ${w}`);
  console.log('');
}
if (problems.length === 0) {
  console.log('RESULT: PASS');
  process.exit(0);
}
console.log(`RESULT: FAIL (${problems.length})`);
for (const p of problems) console.log(`  - ${p}`);
process.exit(1);
