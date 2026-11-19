#!/usr/bin/env node
/**
 * 门禁：随包 ffmpeg 的**升级原子性**（离线，不需要设备 / 核心树 / SDK）。
 *
 * 守的是什么
 * ----------
 * 2026-11-04 审查发现：`ensureBundledFfmpeg()` 升级时先 `rmSync(destRoot)` 再
 * `rename(stage → destRoot)`。只要 rename 失败（EIO / 跨设备 / 被杀），用户就
 * 既没有新版本、也没有旧版本 —— 与函数头注释"失败保留旧版本"相反。
 *
 * 修法：旧目录先改名成 backup（改名不删数据），新目录 rename 成功后才删 backup；
 * 任一失败把 backup 改名回 destRoot。本门禁直接调用生产函数，用注入口模拟故障：
 *
 *   A 首次安装：复制 + wrapper 落位
 *   B 标记一致：不重复复制（changed=false）
 *   C 正常升级：目标内容换成新版本
 *   D 升级 rename 失败：旧版本仍在（内容未被替换）+ ready=true + 明确警告
 *   E 首次安装复制失败：ready=false，不留下半个目标
 *   F 对照臂：**旧的"先删后 rename"写法**在同一故障下必须丢掉旧版本
 *     （证明 D 不是空转；把修法改回去，本门禁必须判红）
 *
 * 退出码：0 通过；1 判定失败。
 *
 * 用法：node tools/check-ffmpeg-provision.mjs
 */
import { createRequire } from 'node:module';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const provision = require('../hostcore/app/ffmpeg-runtime-provision.cjs');

let passed = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    return true;
  }
  failures.push(name);
  console.log(`  FAIL  ${name}${detail ? `（${detail}）` : ''}`);
  return false;
}

const root = mkdtempSync(join(tmpdir(), 'dshm-ffmpeg-gate-'));
const resRoot = join(root, 'res');
const source = join(resRoot, 'toolchain', 'ffmpeg');
const sandboxHome = join(root, 'sandbox');
const binDir = join(root, 'bin');
const destRoot = join(sandboxHome, 'toolchain', 'ffmpeg');

function writeSource({ tool, marker }) {
  mkdirSync(join(source, 'bin'), { recursive: true });
  mkdirSync(join(source, 'lib'), { recursive: true });
  writeFileSync(join(source, 'bin', 'ffmpeg'), tool, 'utf8');
  writeFileSync(join(source, 'bin', 'ffprobe'), `${tool}-probe`, 'utf8');
  writeFileSync(join(source, 'lib', 'libavcodec.so.60'), 'lib', 'utf8');
  writeFileSync(join(source, 'dshm-ffmpeg.json'), marker, 'utf8');
}

function run(options = {}) {
  return provision.ensureBundledFfmpeg(Object.assign({
    resRoot,
    sandboxHome,
    binDir,
    nativeLibs: '/native/libs',
    deviceForm: '2in1',
    log: () => {},
    diag: () => {},
  }, options));
}

/** 注入口：只在指定操作上抛错，其余委托真实 fs。 */
function fsWithFailure({ failRenameToDest = false, failCopy = false }) {
  return Object.assign({}, require('node:fs'), {
    renameSync(src, dst) {
      if (failRenameToDest && String(src).includes('.tmp-') && dst === destRoot) {
        const e = new Error('EIO injected');
        e.code = 'EIO';
        throw e;
      }
      return require('node:fs').renameSync(src, dst);
    },
    cpSync(src, dst, opts) {
      if (failCopy) {
        const e = new Error('EIO injected');
        e.code = 'EIO';
        throw e;
      }
      return require('node:fs').cpSync(src, dst, opts);
    },
  });
}

console.log('# 门禁：随包 ffmpeg 升级原子性');

/* A 首次安装 */
writeSource({ tool: 'OLD-FFMPEG', marker: '{"version":1}' });
const first = run();
ok('A 首次安装 ready=true', first.ready === true);
ok('A 首次安装 changed=true', first.changed === true);
ok('A 目标 ffmpeg 已落位', existsSync(join(destRoot, 'bin', 'ffmpeg')));
ok('A wrapper 指向目标目录', readFileSync(join(binDir, 'ffmpeg'), 'utf8').includes(`exec "$P/bin/ffmpeg"`));

/* B 标记一致不重复复制 */
const again = run();
ok('B 标记一致 changed=false', again.changed === false);
ok('B 标记一致 ready=true', again.ready === true);

/* C 正常升级 */
writeSource({ tool: 'NEW-FFMPEG', marker: '{"version":2}' });
const upgrade = run();
ok('C 升级 ready=true', upgrade.ready === true);
ok('C 升级 changed=true', upgrade.changed === true);
ok('C 目标内容已换新', readFileSync(join(destRoot, 'bin', 'ffmpeg'), 'utf8') === 'NEW-FFMPEG');
ok('C 目标标记已换新', readFileSync(join(destRoot, 'dshm-ffmpeg.json'), 'utf8') === '{"version":2}');
ok('C 无更新残留', readdirSync(sandboxHome).every((n) => !n.includes('.tmp-') && !n.includes('.old-')));

/* D 升级 rename 失败：旧版本必须还在 */
writeSource({ tool: 'NEWER-FFMPEG', marker: '{"version":3}' });
const failed = run({ fs: fsWithFailure({ failRenameToDest: true }) });
ok('D 失败后 ready=true（旧版本仍可用）', failed.ready === true, `warning=${failed.warning}`);
ok('D 失败原因写进 warning', failed.warning.includes('更新失败'), failed.warning);
ok('D 旧版本内容未被替换', readFileSync(join(destRoot, 'bin', 'ffmpeg'), 'utf8') === 'NEW-FFMPEG');
ok('D 旧标记未被替换', readFileSync(join(destRoot, 'dshm-ffmpeg.json'), 'utf8') === '{"version":2}');
ok('D 无 stage 残留', readdirSync(sandboxHome).every((n) => !n.includes('.tmp-') && !n.includes('.old-')));

/* E 首次安装复制失败：不留下半个目标 */
const freshRoot = join(root, 'fresh');
const freshDest = join(freshRoot, 'sandbox', 'toolchain', 'ffmpeg');
mkdirSync(join(freshRoot, 'bin'), { recursive: true });
const eFailed = run({
  sandboxHome: join(freshRoot, 'sandbox'),
  binDir: join(freshRoot, 'bin'),
  fs: fsWithFailure({ failRenameToDest: true, failCopy: true }),
});
ok('E 首次安装失败 ready=false', eFailed.ready === false);
ok('E 首次安装失败给出原因', eFailed.warning.includes('复制失败'), eFailed.warning);
ok('E 首次安装失败不留目标', !existsSync(freshDest));

/* F 对照臂：旧写法（先删后 rename）在同一故障下会丢掉旧版本 */
function oldAlgorithmUnderFailure() {
  const probeRoot = join(root, 'old-algo');
  const probeDest = join(probeRoot, 'toolchain', 'ffmpeg');
  const probeStage = join(probeRoot, 'stage');
  mkdirSync(join(probeDest, 'bin'), { recursive: true });
  writeFileSync(join(probeDest, 'bin', 'ffmpeg'), 'OLD', 'utf8');
  mkdirSync(join(probeStage, 'bin'), { recursive: true });
  writeFileSync(join(probeStage, 'bin', 'ffmpeg'), 'NEW', 'utf8');
  rmSync(probeDest, { recursive: true, force: true });
  try {
    const e = new Error('EIO injected');
    e.code = 'EIO';
    throw e;
  } catch {
    return !existsSync(probeDest);
  }
}
ok('F 对照臂：旧写法在故障下丢掉旧版本（证明 D 有牙）', oldAlgorithmUnderFailure() === true);

rmSync(root, { recursive: true, force: true });

console.log(failures.length === 0
  ? `✅ 通过：${passed} 项（首次安装 / 幂等 / 升级 / 失败保留旧版本 / 无旧版本时不假成功 / 对照臂）`
  : `❌ 失败：${failures.length} 项`);
process.exit(failures.length === 0 ? 0 : 1);