#!/usr/bin/env node
/**
 * 把多 HAP 构建拆成“每设备一个 entry HAP + 一个 shared HSP”的安全侧载目录。
 *
 * 统一包的 AGC `.app` 合法地同时包含 entry(tablet/2in1) 与 phone；
 * 但本地安装器一次只接受一个 entry，把 `.app` 或扁平的 `all/` 直接交给
 * DevEco/Hokit 会报 `9568287 install invalid number of entry hap`。
 *
 * 本脚本只读写 dist/sideload，不接触设备、签名物料或用户数据。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());

function argsOf(argv) {
  const out = { buildMode: 'debug', out: '', checkOnly: false, noZip: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--build-mode') out.buildMode = argv[++i] ?? '';
    else if (argv[i] === '--out') out.out = argv[++i] ?? '';
    else if (argv[i] === '--check-only') out.checkOnly = true;
    else if (argv[i] === '--no-zip') out.noZip = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('用法：node tools/stage-sideload.mjs [--build-mode debug|release] [--out <目录>] [--check-only] [--no-zip]');
      process.exit(0);
    } else {
      console.error(`未知参数：${argv[i]}`);
      process.exit(2);
    }
  }
  if (!['debug', 'release'].includes(out.buildMode)) {
    console.error(`--build-mode 只接受 debug|release，收到：${out.buildMode}`);
    process.exit(2);
  }
  return out;
}

const OPT = argsOf(process.argv.slice(2));
const appScope = readFileSync(join(ROOT, 'AppScope/app.json5'), 'utf8');
const versionName = appScope.match(/"versionName"\s*:\s*"([^"]+)"/)?.[1] ?? '';
const versionCode = appScope.match(/"versionCode"\s*:\s*(\d+)/)?.[1] ?? '';
if (!versionName || !versionCode) {
  console.error('无法从 AppScope/app.json5 读取 versionName/versionCode');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
const OUT = resolve(OPT.out || join(ROOT, 'dist/sideload',
  `DSHM-${versionName}-${versionCode}-${OPT.buildMode}-multidevice-${stamp}`));
if (existsSync(OUT)) {
  console.error(`输出目录已存在，拒绝覆盖：${OUT}`);
  process.exit(1);
}

const VARIANT = OPT.buildMode === 'release' ? 'release' : 'default';
const BUILD_ROOT = join(ROOT, 'build', 'outputs', VARIANT);
const HSP_SRC = join(ROOT, `hostruntime/build/${VARIANT}/outputs/default/hostruntime-default-signed.hsp`);
const entries = [
  {
    dir: 'tablet',
    title: '平板 / PC / 2in1 / MatePad Edge',
    hap: join(ROOT, `entry/build/${VARIANT}/outputs/default/entry-default-signed.hap`),
  },
  {
    dir: 'tablet',
    title: '普通平板',
    hap: join(ROOT, `entry/build/${VARIANT}/outputs/default/entry-default-signed.hap`),
  },
  {
    dir: 'phone',
    title: '手机',
    hap: join(ROOT, `phone/build/${VARIANT}/outputs/default/phone-default-signed.hap`),
  },
];
const APP_SRC = join(BUILD_ROOT, `DSHM-deveco-workspace-${VARIANT}-signed.app`);

for (const item of [...entries, { hap: HSP_SRC }]) {
  if (!existsSync(item.hap)) {
    console.error(`缺少构建产物：${item.hap}`);
    console.error('先跑 hvigor assembleApp，再运行本脚本。');
    process.exit(1);
  }
}
if (!existsSync(APP_SRC)) {
  console.error(`缺少签名 APP：${APP_SRC}`);
  process.exit(1);
}

function zipText(file, member, maxBuffer = 16 * 1024 * 1024) {
  const r = spawnSync('unzip', ['-p', file, member], { encoding: 'utf8', maxBuffer });
  if (r.status !== 0) throw new Error(`${file} 读取 ${member} 失败：${r.stderr || r.stdout}`);
  return r.stdout;
}

for (const item of [...entries, { hap: HSP_SRC }]) {
  const module = JSON.parse(zipText(item.hap, 'module.json'));
  const app = module.app ?? {};
  if (app.buildMode !== OPT.buildMode || app.debug !== (OPT.buildMode === 'debug')) {
    console.error(`构建模式不匹配：${item.hap} 是 ${app.buildMode}/debug=${app.debug}，`
      + `期望 ${OPT.buildMode}/debug=${OPT.buildMode === 'debug'}`);
    process.exit(1);
  }
}
const appPack = JSON.parse(zipText(APP_SRC, 'pack.info', 32 * 1024 * 1024));
const appVersion = appPack.summary?.app?.version;
if (String(appVersion?.name) !== versionName || String(appVersion?.code) !== versionCode) {
  console.error(`APP 版本不匹配：${JSON.stringify(appVersion)} != ${versionName}/${versionCode}`);
  process.exit(1);
}

const hspList = spawnSync('unzip', ['-Z1', HSP_SRC], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
if (hspList.status !== 0 || !hspList.stdout.split(/\r?\n/).includes('libs/arm64-v8a/libsystem.so')) {
  console.error('共享 HSP 缺少 libs/arm64-v8a/libsystem.so：拒绝生成会话必坏的侧载包');
  process.exit(1);
}
if (OPT.checkOnly) {
  console.log(`CHECK OK：${OPT.buildMode} / ${versionName}(${versionCode})，单 entry 源与 HSP libsystem 齐备`);
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });
const checksumLines = [];
/**
 * 三个设备目录里的 PC / 平板文件完全相同，HSP 三份也相同。在同一文件系统内用
 * 硬链接复用字节，既保持每个目录都可独立侧载，又不把 dist 无谓放大三倍。
 * 跨文件系统或文件系统不支持硬链接时回退普通复制。
 */
function materialize(src, dest) {
  try {
    linkSync(src, dest);
  } catch {
    copyFileSync(src, dest);
  }
}
for (const item of entries) {
  const dir = join(OUT, item.dir);
  mkdirSync(dir, { recursive: true });
  const hapDst = join(dir, `DSHM-${versionName}-${item.dir}-${OPT.buildMode}.hap`);
  const hspDst = join(dir, `DSHM-${versionName}-${item.dir}-${OPT.buildMode}.hsp`);
  materialize(item.hap, hapDst);
  materialize(HSP_SRC, hspDst);
  const haps = readdirSync(dir).filter((n) => n.endsWith('.hap'));
  if (haps.length !== 1) {
    console.error(`${dir} 不是单 entry 目录（${haps.length} 个 HAP）`);
    process.exit(1);
  }
  for (const file of [hapDst, hspDst]) {
    const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
    checksumLines.push(`${digest}  ${file.slice(OUT.length + 1).split('\\').join('/')}`);
  }
  console.log(`${item.title}: ${hapDst}`);
  console.log(`  + ${hspDst}`);
}

writeFileSync(join(OUT, 'README.txt'), `DSHM ${versionName} (${versionCode}) safe sideload

AGC .app contains both entry HAPs for device-type routing. Local installers accept
only ONE entry HAP at a time. Use exactly one directory below:

  tablet/  entry-default HAP (tablet + 2in1，PC / Edge 共用) + hostruntime HSP
  phone/   phone-default HAP + hostruntime HSP

Do NOT pass the .app or a combined directory to hdc / Hokit / DevEco.
The device must already use the same signing identity. Identical files in the
device directories may be hard links on this workspace filesystem.

Safe command:
  node tools/update-device.mjs --skip-build --target <connect-key>

The installer detects entry vs phone and only passes one HAP plus the shared HSP.
It uses hdc install -r and never uninstalls or touches el2 user data.
`, 'utf8');

writeFileSync(join(OUT, 'SHA256SUMS'), checksumLines.join('\n') + '\n', 'utf8');

if (!OPT.noZip) {
  const zip = spawnSync('zip', ['-qr', `${basename(OUT)}.zip`, basename(OUT)], {
    cwd: join(OUT, '..'),
    encoding: 'utf8',
  });
  if (zip.status !== 0) {
    console.error(`ZIP 打包失败：${zip.stderr || zip.stdout}`);
    process.exit(1);
  }
}
console.log(`\n输出：${OUT}`);
console.log(OPT.noZip ? 'ZIP ：未生成（--no-zip）' : `ZIP ：${OUT}.zip`);
console.log(`布局：${entries.length} 个设备目录，每目录恰好 1 HAP + 1 HSP`);
