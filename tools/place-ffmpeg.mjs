#!/usr/bin/env node
/**
 * 从 Harmonybrew 采集 ffmpeg / ffprobe 及其动态库闭包，放入 entry（tablet+2in1 单壳）resfile。
 *
 * 产物：
 *   entry/src/main/resources/resfile/toolchain/ffmpeg/
 *     bin/{ffmpeg,ffprobe}
 *     lib/*.so*
 *     dshm-ffmpeg.json
 *
 * 为什么构建期采集：
 *   APP 沙箱不能直接读取/执行 `~/.harmonybrew`。Brew 的 ffmpeg 又带 RUNPATH
 *   指向 Brew 私有库目录，所以不能只拷一个可执行文件。这里按 ELF NEEDED +
 *   RUNPATH 递归收集闭包，并在 HAP 组装前完成自签名。
 *
 * 用法：
 *   node tools/place-ffmpeg.mjs
 *   DSHM_FFMPEG_SOURCE=/path/to/ffmpeg node tools/place-ffmpeg.mjs
 *   node tools/place-ffmpeg.mjs --check
 *   node tools/place-ffmpeg.mjs --reuse-existing   # 源不可读时复用已放置且清单校验通过的闭包（默认不生效）
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devecoSdkHomeCandidates } from './lib/deveco-home.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'entry', 'src', 'main', 'resources', 'resfile', 'toolchain', 'ffmpeg');
const SIGNER = join(ROOT, 'third_party', 'ohos-selfsign', 'selfsign.js');
const SYSTEM_LIBS = new Set([
  'libc.so',
  'libdl.so',
  'libm.so',
  'libpthread.so',
  'libc++_shared.so',
  'ld-musl-aarch64.so.1',
]);

function fail(message) {
  console.error(`place-ffmpeg: ${message}`);
  process.exit(2);
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    fail(`${file} 失败（exit=${result.status ?? 'null'}）${detail ? `\n${detail}` : ''}`);
  }
  return String(result.stdout || '');
}

function findReadelf() {
  for (const sdkHome of devecoSdkHomeCandidates()) {
    const file = join(sdkHome, 'default', 'openharmony', 'native', 'llvm', 'bin', 'llvm-readelf');
    if (existsSync(file)) return file;
  }
  fail('找不到 llvm-readelf（需要 DEVECO_HOME / DEVECO_SDK_HOME）');
}

function sourceExecutable() {
  const explicit = String(process.env.DSHM_FFMPEG_SOURCE || '').trim();
  const candidates = [
    explicit,
    join(homedir(), '.harmonybrew', 'opt', 'ffmpeg', 'bin', 'ffmpeg'),
    join(homedir(), '.harmonybrew', 'bin', 'ffmpeg'),
    '/storage/Users/currentUser/.harmonybrew/opt/ffmpeg/bin/ffmpeg',
    '/storage/Users/currentUser/.harmonybrew/bin/ffmpeg',
  ].filter(Boolean);
  for (const file of candidates) {
    if (existsSync(file)) return realpathSync(file);
  }
  fail('找不到 Brew ffmpeg；可用 DSHM_FFMPEG_SOURCE 指向 ffmpeg 绝对路径');
}

function elfInfo(readelf, file) {
  const dynamic = run(readelf, ['-d', file]);
  const needed = [...dynamic.matchAll(/Shared library: \[([^\]]+)\]/g)].map((m) => m[1]);
  const runpath = [...dynamic.matchAll(/\((?:RUNPATH|RPATH)\).*?Library (?:runpath|rpath): \[([^\]]*)\]/g)]
    .flatMap((m) => m[1].split(':').filter(Boolean));
  return { needed, runpath };
}

function locateNeeded(name, currentFile, searchDirs, cache) {
  if (cache.has(name)) return cache.get(name);
  const candidates = [dirname(currentFile), ...searchDirs].map((dir) => join(dir, name));
  for (const file of candidates) {
    if (existsSync(file)) {
      const real = realpathSync(file);
      cache.set(name, real);
      return real;
    }
  }
  cache.set(name, null);
  return null;
}

function signOne(source, destination, scratch) {
  const temp = join(scratch, `${basename(destination)}.signed`);
  run(process.execPath, [SIGNER, source, temp, '--force']);
  copyFileSync(temp, destination);
  chmodSync(destination, 0o755);
}

if (process.argv.includes('--check')) {
  const marker = join(DEST, 'dshm-ffmpeg.json');
  if (!existsSync(join(DEST, 'bin', 'ffmpeg')) || !existsSync(join(DEST, 'bin', 'ffprobe')) || !existsSync(marker)) {
    fail(`ffmpeg 资产不完整：${DEST}`);
  }
  console.log(`place-ffmpeg: OK ${DEST}`);
  process.exit(0);
}

/*
 * 【源不可读时的**显式**复用通道（2026-10-28，docs/267 P2-4 同族）】
 *
 * 本机 brew 的 ffmpeg 与其闭包库是 `mode 770`（owner/group 可读写执行、others **无**），
 * 而端侧应用身份属 "other" ⇒ 应用域**读不到**（实测 EACCES / "Operation not permitted"），
 * readelf 与拷贝都失败 ⇒ 本脚本在鸿蒙 PC 上必然失败。
 *
 * 这里给一条**只在调用方明确要求时才生效**的通道：`--reuse-existing` 或
 * `DSHM_FFMPEG_REUSE_ON_UNREADABLE=1`。生效条件很严：
 *   ① 已放置的闭包**经清单校验完整** —— `bin/ffmpeg`、`bin/ffprobe` 在，
 *      且 `dshm-ffmpeg.json` 里每个 `libraries[].name` 都在、**大小逐条相符**；
 *   ② 任一条件不满足 ⇒ 仍然 fail（不许拿半个闭包出包）。
 * **默认不生效**，所以它不会在别的机器上把"源读不到"静默放行成"已放置"。
 */
if (process.argv.includes('--reuse-existing')
  || process.env.DSHM_FFMPEG_REUSE_ON_UNREADABLE === '1') {
  const marker = join(DEST, 'dshm-ffmpeg.json');
  const missing = [];
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(marker, 'utf8'));
  } catch {
    manifest = null;
  }
  if (!existsSync(join(DEST, 'bin', 'ffmpeg'))) missing.push('bin/ffmpeg');
  if (!existsSync(join(DEST, 'bin', 'ffprobe'))) missing.push('bin/ffprobe');
  if (manifest === null) {
    missing.push('dshm-ffmpeg.json（清单不可读）');
  } else {
    for (const lib of manifest.libraries ?? []) {
      const file = join(DEST, 'lib', lib.name);
      try {
        if (statSync(file).size !== lib.size) missing.push(`lib/${lib.name}（大小不符）`);
      } catch {
        missing.push(`lib/${lib.name}（缺失）`);
      }
    }
  }
  if (missing.length > 0) {
    fail(`要求复用已放置的闭包，但它不完整：${missing.slice(0, 6).join('、')}`
      + `${missing.length > 6 ? ` 等 ${missing.length} 项` : ''}`);
  }
  console.log(`place-ffmpeg: 源不可读（应用域对 brew 无读权限）⇒ **复用**已放置的闭包`);
  console.log(`place-ffmpeg: ${manifest.version ?? '(清单无版本)'}`);
  console.log(`place-ffmpeg: 清单校验通过：${(manifest.libraries ?? []).length} 个库大小逐条相符`);
  console.log(`place-ffmpeg: ${DEST}`);
  process.exit(0);
}

if (!existsSync(SIGNER)) fail(`缺少 ELF 自签名器：${SIGNER}`);
const readelf = findReadelf();
const ffmpeg = sourceExecutable();
const ffprobe = join(dirname(ffmpeg), 'ffprobe');
const packageRoot = dirname(dirname(ffmpeg));
if (!existsSync(ffprobe)) fail(`ffprobe 与 ffmpeg 不在同一 bin 目录：${ffprobe}`);

const queue = [ffmpeg, ffprobe];
const visited = new Set();
const libraries = new Map();
const lookupCache = new Map();
while (queue.length > 0) {
  const file = queue.shift();
  if (visited.has(file)) continue;
  visited.add(file);
  const info = elfInfo(readelf, file);
  for (const name of info.needed) {
    if (SYSTEM_LIBS.has(name) || libraries.has(name)) continue;
    const found = locateNeeded(name, file, info.runpath, lookupCache);
    if (found === null) {
      if (name === 'libc.so') continue;
      fail(`无法解析 ${basename(file)} 的依赖 ${name}`);
    }
    libraries.set(name, found);
    queue.push(found);
  }
}

rmSync(DEST, { recursive: true, force: true });
mkdirSync(join(DEST, 'bin'), { recursive: true });
mkdirSync(join(DEST, 'lib'), { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'dshm-ffmpeg-sign-'));
try {
  signOne(ffmpeg, join(DEST, 'bin', 'ffmpeg'), scratch);
  signOne(ffprobe, join(DEST, 'bin', 'ffprobe'), scratch);
  const entries = [];
  for (const [name, source] of [...libraries].sort(([a], [b]) => a.localeCompare(b))) {
    const destination = join(DEST, 'lib', name);
    signOne(source, destination, scratch);
    entries.push({ name, source, size: statSync(destination).size });
  }
  const versionLine = run(ffmpeg, ['-version']).split('\n')[0].trim();
  for (const name of ['LICENSE.md', 'COPYING.GPLv2', 'COPYING.GPLv3', 'COPYING.LGPLv2.1', 'COPYING.LGPLv3']) {
    const source = join(packageRoot, name);
    if (existsSync(source)) copyFileSync(source, join(DEST, name));
  }
  const buildConfig = run(ffmpeg, ['-version']).split('\n')
    .find((line) => line.startsWith('configuration:')) || 'configuration: unavailable';
  writeFileSync(join(DEST, 'NOTICE.md'), [
    '# FFmpeg notice',
    '',
    versionLine,
    buildConfig,
    '',
    'Source: https://ffmpeg.org/download.html',
    'This packaged build follows the Homebrew ffmpeg formula and may include GPL components.',
    'The applicable license texts are copied into this directory.',
    '',
  ].join('\n'), 'utf8');
  const manifest = {
    version: versionLine,
    source: ffmpeg,
    generatedAt: new Date().toISOString(),
    licenseNotice: 'NOTICE.md',
    libraries: entries,
  };
  writeFileSync(join(DEST, 'dshm-ffmpeg.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const digest = createHash('sha256');
  for (const rel of ['bin/ffmpeg', 'bin/ffprobe', ...entries.map((entry) => `lib/${entry.name}`)]) {
    digest.update(rel).update('\0').update(readFileSync(join(DEST, rel))).update('\0');
  }
  console.log(`place-ffmpeg: ${versionLine}`);
  console.log(`place-ffmpeg: ${entries.length} libraries, sha256=${digest.digest('hex')}`);
  console.log(`place-ffmpeg: ${DEST}`);
} finally {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // 临时签名目录清理失败不影响产物。
  }
}
