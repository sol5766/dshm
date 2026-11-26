#!/usr/bin/env node
/**
 * 门禁：需要独立 Node CLI 的插件必须由 DSHM 自动获得 `bin/node`。
 *
 * 覆盖：
 *   A. dsh-bili-whale 能被识别，无关插件不会被误判；
 *   B. 随包 nodecli 被复制为可执行 `node-cli`，wrapper 注入 libnode 路径、
 *      `LD_LIBRARY_PATH`、`UV_USE_IO_URING=0`，子进程不强制 `--jitless`
 *      （fetch/undici 需要 WebAssembly）；
 *   C. 幂等：第二次布置不改变字节；
 *   D. `DSHM_NODE_PROVISION=off` 生效；
 *   E. Host 启动接线早于 runProfile；place-host-app 带新模块；
 *   F. 养鱼媒体工具 ffmpeg/ffprobe：运行时目录替换、PATH/环境变量接线；
 *   G. 本地已有 nodecli / ffmpeg 时，产物必须是带 `.codesign` 的 ELF
 *      （干净克隆没有生成物时如实标记 SKIP）。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 找 native SDK（llvm-readelf 所在）。门禁不依赖设备，找不到就跳过该断言。 */
function CLI_SDK() {
  const candidates = [];
  const env = String(process.env.DSHM_OHOS_NATIVE_SDK || '').trim();
  if (env) candidates.push(env);
  for (const root of [process.env.DEVECO_HOME, '/data/service/hnp/hmos-clt.org/hmos-clt_1.0.0']) {
    if (!root) continue;
    candidates.push(join(root, 'sdk', 'default', 'openharmony', 'native'));
    candidates.push(join(root, 'default', 'openharmony', 'native'));
  }
  for (const c of candidates) if (existsSync(join(c, 'llvm', 'bin', 'llvm-readelf'))) return c;
  return candidates[0] || '';
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = join(ROOT, 'hostcore', 'app', 'node-runtime-provision.cjs');
const FFMPEG_MODULE = join(ROOT, 'hostcore', 'app', 'ffmpeg-runtime-provision.cjs');
const CLI = join(ROOT, 'hostruntime', 'src', 'main', 'resources', 'resfile', 'toolchain', 'node', 'nodecli');
const NODECLI_SOURCE = join(ROOT, 'hostruntime', 'src', 'main', 'cpp', 'nodecli.c');
const FFMPEG_DIR = join(ROOT, 'entry', 'src', 'main', 'resources', 'resfile', 'toolchain', 'ffmpeg');
let passed = 0;
let failed = 0;
let skipped = 0;

function ok(name) {
  passed += 1;
  console.log(`ok ${name}`);
}

function bad(name, detail) {
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
}

function skip(name, detail) {
  skipped += 1;
  console.log(`SKIP ${name}${detail ? `: ${detail}` : ''}`);
}

function check(name, value, detail = '') {
  if (value) ok(name);
  else bad(name, detail);
}

const scratch = mkdtempSync(join(tmpdir(), 'dshm-check-node-cli-'));
try {
  const provision = await import(`file://${MODULE}?gate=${Date.now()}`);
  const ffmpegProvision = await import(`file://${FFMPEG_MODULE}?gate=${Date.now()}`);
  check('module exports ensureForProfile', typeof provision.ensureForProfile === 'function');
  check('module exports ensureBundledNodeCli', typeof provision.ensureBundledNodeCli === 'function');
  check('白名单登记 dsh-bili-whale', provision.NODE_CLI_PLUGINS.has('dsh-bili-whale'));

  const home = join(scratch, 'home');
  const profile = join(home, 'profiles', 'ondevice');
  mkdirSync(join(profile, 'node_modules', 'dsh-bili-whale'), { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    dependencies: { 'dsh-bili-whale': 'github:Alterssss/dsh-bili-whale' },
  }));
  check('依赖清单命中插件', provision.profileNeedsNodeCli(home, 'ondevice'));

  const unrelated = join(home, 'profiles', 'web');
  mkdirSync(unrelated, { recursive: true });
  writeFileSync(join(unrelated, 'package.json'), JSON.stringify({ dependencies: { dshmarket: '1.0.0' } }));
  check('无关 profile 不误触发', !provision.profileNeedsNodeCli(home, 'web'));

  const resRoot = join(scratch, 'resfile');
  const source = join(resRoot, provision.BUNDLED_SOURCE_REL);
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3]));
  const bin = join(scratch, 'bin');
  const nativeLibs = join(scratch, 'libs');
  mkdirSync(nativeLibs, { recursive: true });
  const prepared = provision.ensureBundledNodeCli({ binDir: bin, resRoot, nativeLibs });
  check('随包 nodecli 布置成功', prepared.ready && prepared.source === 'bundled-libnode', prepared.error);
  check('nodecli 字节复制', readFileSync(join(bin, 'node-cli')).equals(readFileSync(source)));
  const wrapper = readFileSync(join(bin, 'node'), 'utf8');
  check('wrapper 注入 DSHM_NODE_LIBNODE', wrapper.includes('DSHM_NODE_LIBNODE="$LIBS/libnode.so.147"'));
  check('wrapper 注入 LD_LIBRARY_PATH', wrapper.includes('LD_LIBRARY_PATH="$LIBS'));
  check('wrapper 关闭 io_uring', wrapper.includes('UV_USE_IO_URING=0'));
  check('子进程 Node 不强制 jitless', wrapper.includes('exec "$CLI" "$@"')
    && !wrapper.includes('exec "$CLI" --jitless "$@"'));
  const nodecliSource = readFileSync(NODECLI_SOURCE, 'utf8');
  check('nodecli 绝对 libnode 候选不再拼接自身目录',
    /if \(suffix\[0\] == '\/'\)\s*\{\s*\(void\)snprintf\(candidate, sizeof\(candidate\), "%s", suffix\);\s*\}\s*else\s*\{\s*\(void\)snprintf\(candidate, sizeof\(candidate\), "%s\/%s", dir, suffix\);/s.test(nodecliSource));
  check('nodecli 包含设备实际 libs/arm64 libnode 路径',
    nodecliSource.includes('"/data/storage/el1/bundle/libs/arm64/libnode.so.147"'));

  const before = [
    readFileSync(join(bin, 'node-cli')).toString('hex'),
    readFileSync(join(bin, 'node'), 'utf8'),
  ];
  provision.ensureBundledNodeCli({ binDir: bin, resRoot, nativeLibs });
  check('重复布置幂等', before[0] === readFileSync(join(bin, 'node-cli')).toString('hex')
    && before[1] === readFileSync(join(bin, 'node'), 'utf8'));

  const disabled = provision.ensureForProfile({
    env: { DSHM_NODE_PROVISION: 'off' },
    homeDir: home,
    profile: 'ondevice',
  });
  check('DSHM_NODE_PROVISION=off 生效', !disabled.requested && disabled.action === 'none');

  const candidates = provision.candidateSources({
    HOME: '/sandbox/home',
    DSH_NODE: '/configured/node',
    PATH: '/usr/bin:/bin',
  }, '/storage/Users/currentUser/Download/com.dshm.dshclient');
  check('显式 DSH_NODE 优先', candidates[0] === '/configured/node');
  check('发现 Harmonybrew Node', candidates.includes('/storage/Users/currentUser/.harmonybrew/opt/node/bin/node'));
  check('发现公共目录 node-brew',
    candidates.includes('/storage/Users/currentUser/Download/com.dshm.dshclient/node-brew'));

  const main = readFileSync(join(ROOT, 'hostcore', 'app', 'main.js'), 'utf8');
  const bundleAt = main.indexOf('nodeRuntimeProvision.ensureBundledNodeCli');
  const profileAt = main.indexOf('nodeRuntimeProvision.ensureForProfile');
  const bootAt = main.indexOf('profileBoot.runProfile');
  check('main.js 布置随包 nodecli', bundleAt > 0);
  check('main.js 在 profile boot 前准备 CLI', profileAt > 0 && bootAt > profileAt);
  check('main.js 注入 DSH_NODE', main.includes('process.env.DSH_NODE = NODE_CLI_STATUS.file'));

  const place = readFileSync(join(ROOT, 'tools', 'place-host-app.mjs'), 'utf8');
  check('place-host-app 携带运行时模块', place.includes("'node-runtime-provision.cjs'"));
  check('place-host-app 携带 ffmpeg 模块', place.includes("'ffmpeg-runtime-provision.cjs'"));

  const ffSource = join(resRoot, 'toolchain', 'ffmpeg');
  mkdirSync(join(ffSource, 'bin'), { recursive: true });
  mkdirSync(join(ffSource, 'lib'), { recursive: true });
  writeFileSync(join(ffSource, 'bin', 'ffmpeg'), 'ffmpeg');
  writeFileSync(join(ffSource, 'bin', 'ffprobe'), 'ffprobe');
  writeFileSync(join(ffSource, 'lib', 'libavutil.so.61'), 'lib');
  writeFileSync(join(ffSource, 'dshm-ffmpeg.json'), '{"version":"9.0.1"}\n');
  const ff = ffmpegProvision.ensureBundledFfmpeg({
    resRoot,
    sandboxHome: scratch,
    binDir: bin,
    nativeLibs,
    deviceForm: 'desktop',
  });
  check('ffmpeg 随包落位', ff.ready && existsSync(join(scratch, 'toolchain', 'ffmpeg', 'bin', 'ffmpeg')), ff.warning);
  const ffWrapper = readFileSync(join(bin, 'ffmpeg'), 'utf8');
  check('ffmpeg wrapper 注入动态库目录', ffWrapper.includes('LD_LIBRARY_PATH="$P/lib:$LIBS:/system/lib64'));
  check('ffmpeg wrapper 指向随包二进制', ffWrapper.includes('exec "$P/bin/ffmpeg" "$@"'));
  check('ffprobe wrapper 指向随包二进制',
    readFileSync(join(bin, 'ffprobe'), 'utf8').includes('exec "$P/bin/ffprobe" "$@"'));
  check('main.js 注入 FFMPEG/FFPROBE',
    main.includes('process.env.FFMPEG = bundledFfmpeg.ffmpeg')
    && main.includes('process.env.FFPROBE = bundledFfmpeg.ffprobe'));
  check('build-beta 构建前采集 ffmpeg',
    readFileSync(join(ROOT, 'tools', 'build-beta.mjs'), 'utf8').includes("tools/place-ffmpeg.mjs"));
  const blocked = ffmpegProvision.ensureBundledFfmpeg({
    resRoot,
    sandboxHome: scratch,
    binDir: bin,
    nativeLibs,
    deviceForm: 'tablet',
  });
  check('平板不加载 ffmpeg', blocked.ready === false);
  check('平板清理历史 ffmpeg 落位',
    !existsSync(join(scratch, 'toolchain', 'ffmpeg'))
    && !existsSync(join(bin, 'ffmpeg')) && !existsSync(join(bin, 'ffprobe')));

  if (!existsSync(CLI)) {
    skip('生成物 nodecli', '干净克隆尚未运行 tools/build-node-cli.mjs');
  } else {
    const bytes = readFileSync(CLI);
    check('nodecli 是 ELF', bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])));
    check('nodecli 带 .codesign 段', bytes.includes(Buffer.from('.codesign\0')));
    check('nodecli 体积 < 1 MB', statSync(CLI).size < 1024 * 1024, `${statSync(CLI).size} B`);
    /*
     * 【2026-11-05：exec 域加载随包库的前提】
     * ① nodecli **不能**带指向 el1 的 RUNPATH —— 启动期会去加载未签名的 libc++，
     *    实测直接 `Error loading shared library libc++_shared.so`；
     * ② 随包 libnode 必须带 `.codesign` —— 未签名时 dlopen 返回 Permission denied
     *    （已签名的最小探针可 OK，同一路径、同一权限）。
     */
    const dynamic = spawnSync(
      join(CLI_SDK(), 'llvm', 'bin', 'llvm-readelf'), ['-d', CLI], { encoding: 'utf8' });
    const dynText = String(dynamic.stdout || '');
    check('nodecli 不带指向 el1 的 RUNPATH', !/RUNPATH.*el1\/bundle\/libs/.test(dynText));
    const libnode = join(ROOT, 'hostruntime', 'libs', 'arm64-v8a', 'libnode.so.147');
    if (existsSync(libnode)) {
      check('随包 libnode 已自签名（.codesign）',
        readFileSync(libnode).includes(Buffer.from('.codesign\0')));
    } else {
      skip('随包 libnode 自签名', '仓内没有 hostruntime/libs/arm64-v8a/libnode.so.147');
    }
    check('build-beta 构建前签名随包库',
      readFileSync(join(ROOT, 'tools', 'build-beta.mjs'), 'utf8').includes('sign-bundled-libs.mjs'));

    /*
     * 【2026-11-24 Node 26 升级】随包原生库的 DT_NEEDED 必须指向当前 libnode soname。
     * 核心树里的 pty.node / sharp 原生件按旧 ABI 编译，直接写着 `libnode.so.137`；
     * 147 上线后 libpty.so 找不到 137，终端报
     * `Error loading shared library libnode.so.137: (needed by .../libpty.so)`。
     * 生成端已由 collect-libvips 统一改写，这里做发布前回归。
     */
    {
      const libsDir = join(ROOT, 'hostruntime', 'libs', 'arm64-v8a');
      const sonames = existsSync(libsDir)
        ? readdirSync(libsDir).filter((n) => /^libnode\.so\.\d+$/.test(n)).sort()
        : [];
      const current = sonames.length > 0 ? sonames[sonames.length - 1] : '';
      if (current === '') {
        skip('随包原生库 libnode NEEDED', '仓内没有 libnode.so.<abi>');
      } else {
        const stray = [];
        for (const name of readdirSync(libsDir)) {
          if (!name.endsWith('.so') || name.startsWith('libnode.so')) continue;
          let info = null;
          try {
            info = JSON.parse(execFileSync(process.execPath,
              [join(ROOT, 'tools', 'patch-native-needed.mjs'), join(libsDir, name), '-', '-', '--list'],
              { encoding: 'utf8' }));
          } catch {
            continue;
          }
          for (const need of info.needed || []) {
            if (/^libnode\.so\.\d+$/.test(need) && need !== current) {
              stray.push(`${name}: ${need}`);
            }
          }
        }
        check('随包原生库 libnode NEEDED 指向当前 ABI', stray.length === 0,
          stray.length > 0 ? `${stray.join('; ')}（当前 ${current}）` : `当前 ${current}`);
      }
    }
  }
  if (!existsSync(join(FFMPEG_DIR, 'bin', 'ffmpeg')) || !existsSync(join(FFMPEG_DIR, 'dshm-ffmpeg.json'))) {
    skip('生成物 ffmpeg', '干净克隆尚未运行 tools/place-ffmpeg.mjs');
  } else {
    for (const tool of ['ffmpeg', 'ffprobe']) {
      const bytes = readFileSync(join(FFMPEG_DIR, 'bin', tool));
      check(`${tool} 是 ELF`, bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])));
      check(`${tool} 带 .codesign 段`, bytes.includes(Buffer.from('.codesign\0')));
    }
    const manifest = JSON.parse(readFileSync(join(FFMPEG_DIR, 'dshm-ffmpeg.json'), 'utf8'));
    check('ffmpeg 动态库闭包已采集', Array.isArray(manifest.libraries) && manifest.libraries.length >= 20,
      String(manifest.libraries?.length));
  }
} catch (e) {
  bad('门禁执行异常', e && e.stack ? e.stack : String(e));
} finally {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // 临时目录清理失败不影响结论。
  }
}

console.log(`\n# node-cli 门禁：${passed} passed / ${failed} failed / ${skipped} skipped`);
process.exit(failed === 0 ? 0 : 1);
