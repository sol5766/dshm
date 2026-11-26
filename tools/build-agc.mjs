#!/usr/bin/env node
/**
 * 构建 AGC 邀请测试用三端统一发布包。
 *
 * 本脚本只做本地构建与校验，不登录、不上传、不提交 AGC。
 *
 * 临时构建配置：
 *   - product `release` → signingConfig `release`
 *   - entry + phone + hostruntime 都加入该 product
 *   - bundleName 固定为正式包 com.dshm.dshclient
 *
 * 构建结束由 finally 逐字恢复 build-profile.json5，并重放正式 Host 资源。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEVECO_ROOT_MARKER, DEVECO_ROOT_MARKER_CLT, devecoPath, resolveDevecoRoot, resolveDevecoSdkHome,
} from './lib/deveco-home.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const APP_SCOPE_TEXT = readFileSync(join(ROOT, 'AppScope', 'app.json5'), 'utf8');
const APP_VERSION = /"versionName"\s*:\s*"([^"]+)"/.exec(APP_SCOPE_TEXT)?.[1] ?? '';
const APP_VERSION_CODE = /"versionCode"\s*:\s*(\d+)/.exec(APP_SCOPE_TEXT)?.[1] ?? '';
const CORE_VERSION = JSON.parse(
  readFileSync(join(ROOT, 'hostcore', 'core-recipe.json'), 'utf8')).coreVersion;
const BUNDLE = 'com.dshm.dshclient';
const APP_ID = '6917614360926110054';
const DEVICE_SIDELOAD = process.argv.includes('--device-sideload');
// 指定设备侧载 Profile：1.1.6 轮次文件，仅 --device-sideload 使用；与当前 1.1.8/1010015 版本不联动（待核是否仍配套）。
const DEVICE_PROFILE = './.certs/multihap-20261024/'
  + 'DSHM-prod-1.1.6-1010007-specified-device-20261024.p7b';
/*
 * 【ACL 口径（2026-11-11 用户裁决）】**不再钉死"恒定几条"**。
 * 唯一事实源 = 发布 Profile 的 `allowed-acls`；这里只保留"哪些权限属于受控 ACL"的分类，
 * 用来反查 entry 的声明有没有超出 Profile。Profile 增加 ACL 时无需改本文件。
 */
const ACL_SENSITIVE = new Set([
  'ohos.permission.ALLOW_EXTERNAL_NATIVE_CODE',
  'ohos.permission.CUSTOM_SANDBOX',
  'ohos.permission.FILE_ACCESS_PERSIST',
  'ohos.permission.READ_PASTEBOARD',
  'ohos.permission.READ_WRITE_DESKTOP_DIRECTORY',
  'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY',
  'ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY',
  'ohos.permission.ACCESS_USER_FULL_DISK',
]);

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: options.env ?? process.env,
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? 'pipe' : 'inherit',
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    fail(`${command} ${args.join(' ')} 失败（exit=${result.status ?? 'null'}）`
      + `${detail ? `\n${detail}` : ''}`);
  }
  return String(result.stdout || '');
}

function zipText(file, member, maxBuffer = 64 * 1024 * 1024) {
  return run('unzip', ['-p', file, member], { capture: true, maxBuffer });
}

/**
 * 读 zip 的**中央目录**取条目名（进程内解析，不再 shell 出去调 `unzip -Z1`）。
 *
 * 【为什么换掉】本机（鸿蒙 PC）的 `unzip` 是 **toybox** 版，不认 `-Z1`（zipinfo 语法）：
 * 它只回一段 usage 文本、退出码非零 ⇒ 本脚本**在最后一步校验**失败（构建本身其实已经成功）。
 * 进程内解析没有这个外部依赖，而且中央目录里的长度字段是**权威值**
 * （不受"流式写法把长度写 0、真正的值放在 data descriptor 里"影响）。
 *
 * 【Zip64 兜底】条目数 >65535 或偏移 >4GiB 时，EOCD 的字段是 `0xFFFF` / `0xFFFFFFFF`
 * 占位，真值在同名前缀的 Zip64 记录里 —— 本仓的 entry HAP 条目数是千级、暂不触发，
 * 但这里一并实现，免得将来换了打包器再踩。
 */
function zipNames(file) {
  const buf = readFileSync(file);
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 65536);   // zip 注释最长 64KB
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) fail(`不是合法 zip（找不到 EOCD）：${file}`);
  let total = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || offset === 0xffffffff) {
    // Zip64：EOCD 定位器（0x07064b50）紧邻 EOCD 之前
    let locator = -1;
    for (let i = eocd - 20; i >= Math.max(0, eocd - 40); i--) {
      if (buf.readUInt32LE(i) === 0x07064b50) { locator = i; break; }
    }
    if (locator < 0) fail(`Zip64 定位器缺失：${file}`);
    const z64 = Number(buf.readBigUInt64LE(locator + 8));
    if (buf.readUInt32LE(z64) !== 0x06064b50) fail(`Zip64 EOCD 签名不对：${file}`);
    total = Number(buf.readBigUInt64LE(z64 + 32));
    offset = Number(buf.readBigUInt64LE(z64 + 48));
  }
  const names = [];
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) fail(`中央目录项签名不对：${file} @${offset}`);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    names.push(buf.toString('utf8', offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  if (names.length !== total) fail(`zip 条目数不符：${file}`);
  return names;
}

function parseProvision(profile) {
  const text = readFileSync(profile).toString('latin1');
  const start = text.indexOf('{"version-name');
  if (start < 0) fail('release Profile 内没有可解析的 provision JSON');
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) {
      return JSON.parse(text.slice(start, i + 1));
    }
  }
  fail('release Profile 的 provision JSON 不完整');
}

function checkReleaseMaterials(profileText) {
  const json5 = createRequire(import.meta.url)(
    join(DEVECO_ROOT, 'hvigor', 'hvigor-ohos-plugin', 'node_modules', 'json5'));
  const config = json5.parse(profileText);
  const release = (config.app?.signingConfigs ?? []).find((item) => item.name === 'release');
  if (!release) fail('build-profile.json5 缺少 release signingConfig');
  const material = release.material ?? {};
  if (DEVICE_SIDELOAD) material.profile = DEVICE_PROFILE;
  for (const key of ['certpath', 'profile', 'storeFile']) {
    const rel = String(material[key] ?? '');
    if (rel.length === 0 || !existsSync(join(ROOT, rel))) {
      fail(`release signingConfig 的 ${key} 不存在：${rel}`);
    }
  }
  const provisionFile = join(ROOT, material.profile);
  const provision = parseProvision(provisionFile);
  const bundleInfo = provision['bundle-info'] ?? {};
  const acls = [...(provision.acls?.['allowed-acls'] ?? [])].sort();
  if (provision.type !== 'release') fail(`Profile type=${provision.type}，期望 release`);
  if (bundleInfo['bundle-name'] !== BUNDLE) {
    fail(`Profile bundle-name=${bundleInfo['bundle-name']}，期望 ${BUNDLE}`);
  }
  if (bundleInfo['app-identifier'] !== APP_ID) {
    fail(`Profile app-identifier=${bundleInfo['app-identifier']}，期望 ${APP_ID}`);
  }
  const distribution = provision['app-distribution-type'] ?? '';
  const deviceIds = provision['debug-info']?.['device-ids'] ?? [];
  if (DEVICE_SIDELOAD) {
    if (distribution !== 'internaltesting' || deviceIds.length === 0) {
      fail(`指定设备 Profile 不正确：distribution=${distribution} devices=${deviceIds.length}`);
    }
  } else if (distribution !== 'app_gallery') {
    fail(`AGC 邀请测试 Profile distribution=${distribution}，期望 app_gallery`);
  }
  /*
   * 【以 Profile 为准】不再要求 ACL 恰好等于某个固定清单。
   * 硬约束只有一条：entry 声明的受控权限必须全部被 Profile 批准（否则装上=拿不到）。
   * Profile 多批的 ACL 不强制声明（允许为后续能力预留）。
   */
  const entryModuleText = readFileSync(join(ROOT, 'entry/src/main/module.json5'), 'utf8');
  const declared = [...entryModuleText.matchAll(/"name"\s*:\s*"(ohos\.permission\.[^"]+)"/g)]
    .map((m) => m[1]);
  const declaredAcls = [...new Set(declared)].filter((p) => ACL_SENSITIVE.has(p)).sort();
  const missing = declaredAcls.filter((p) => !acls.includes(p));
  if (missing.length > 0) {
    fail(`entry 声明了 Profile 未批准的受控权限：${missing.join(', ')}`
      + `（Profile 现有：${acls.join(', ')}）`);
  }
  console.log(`ACL：Profile ${acls.length} 条；entry 受控声明 ${declaredAcls.length} 条，全部在 Profile 内`);
  const notAfter = Number(provision.validity?.['not-after'] ?? 0);
  if (notAfter > 0 && notAfter * 1000 <= Date.now()) {
    fail(`release Profile 已过期：${new Date(notAfter * 1000).toISOString()}`);
  }
  return { config, provisionFile, acls };
}

const hvigorw = devecoPath(DEVECO_ROOT_MARKER) ?? devecoPath(DEVECO_ROOT_MARKER_CLT);
const DEVECO_ROOT = resolveDevecoRoot();
const SDK_HOME = resolveDevecoSdkHome();
if (!hvigorw || !DEVECO_ROOT || !SDK_HOME) {
  fail('找不到 DevEco / hvigor / SDK；请检查 .env 的 DEVECO_HOME');
}
if (APP_VERSION.length === 0 || APP_VERSION_CODE.length === 0) {
  fail('无法从 AppScope/app.json5 读取版本号');
}

const buildProfilePath = join(ROOT, 'build-profile.json5');
const originalBuildProfile = readFileSync(buildProfilePath);
const originalText = originalBuildProfile.toString('utf8');
const materialInfo = checkReleaseMaterials(originalText);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
const releaseDir = join(ROOT, 'dist', 'release-test');
/*
 * 【2026-10-30 修：交付名里的核心版本不能写死】旧名写死 `core96`，而核心已到
 * `0.2.1-rc.4+dshm.98` —— 名字与包内实际带的容器不一致（"名字撒谎"），事后核对
 * 只能靠拆包。改为从 `hostcore/core-recipe.json`（核心版本唯一真源）现读：
 * `0.2.1-rc.4+dshm.98` → 段 `dshm.98`（去掉上游前缀，文件名短一点；`+` 不能出现在
 * 文件名里）。文件名前缀走**拼音/拉丁**形式，避免非 ASCII 文件名在 AGC/命令行两侧出编码问题。
 *
 * 【品牌名口径】应用显示名统一为 **DSHM**（2026-11-01 起中英文一致）。文件名前缀
 * 同步用 `dshm`，否则交付件名与实际品牌对不上。
 */
const CORE_TAG = (CORE_VERSION.split('+')[1] ?? CORE_VERSION).replace(/[^A-Za-z0-9.]/g, '');
const finalApp = join(releaseDir,
  `dshm-${APP_VERSION}-${APP_VERSION_CODE}-${CORE_TAG}-`
  + `${DEVICE_SIDELOAD ? 'internaltesting-device' : 'AGC-invite'}-${stamp}.app`);
let restored = false;

function restoreBuildProfile() {
  if (restored) return;
  writeFileSync(buildProfilePath, originalBuildProfile);
  const placed = spawnSync(process.execPath, [join(ROOT, 'tools/place-host-app.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (placed.status !== 0) {
    console.error('WARN: build-profile 已恢复，但正式 Host 资源重放失败');
  }
  restored = true;
}

function configureCombinedRelease(profile) {
  const base = profile.app.products?.find((product) => product.name === 'default');
  if (!base) fail('build-profile 缺少 default product');
  // hvigor 要求配置中始终存在名为 default 的 product，即使本次显式构建 release。
  // default 只作为 schema 占位；三端模块全部只加入 release，不会产出第二套 APP。
  const placeholder = JSON.parse(JSON.stringify(base));
  placeholder.name = 'default';
  placeholder.bundleName = BUNDLE;
  const product = JSON.parse(JSON.stringify(base));
  product.name = 'release';
  product.signingConfig = 'release';
  product.bundleName = BUNDLE;
  profile.app.products = [placeholder, product];
  for (const name of ['entry', 'phone', 'hostruntime']) {
    const target = profile.modules.find((item) => item.name === name)?.targets?.[0];
    if (!target) fail(`build-profile 缺少 ${name} 模块 target`);
    target.applyToProducts = ['release'];
  }
  /*
   * 【2026-11-08】`pc` 是 PC 侧载专用壳（moduleName=pc，保住旧安装的覆盖升级）。
   * AGC 统一包只放 entry(tablet+2in1)+phone：若再带 pc(2in1)，同一 2in1 设备会命中
   * 两个 entry HAP（9568287/9568267）。因此在 release 组合里直接移除 pc 模块，
   * 而不是把它挂到不存在的 product 上。
   */
  profile.modules = profile.modules.filter((item) => item.name !== 'pc');
  writeFileSync(buildProfilePath, JSON.stringify(profile, null, 2) + '\n');
}

function assertModule(module, expected, fileName) {
  const app = module.app ?? {};
  if (app.bundleName !== BUNDLE
      || String(app.versionCode) !== APP_VERSION_CODE
      || app.buildMode !== 'release'
      || app.debug !== false) {
    fail(`${fileName} 身份/构建模式不正确：${JSON.stringify(app)}`);
  }
}

function validateApp(app) {
  const pack = JSON.parse(zipText(app, 'pack.info'));
  const summary = pack.summary ?? {};
  const modules = summary.modules ?? [];
  const entries = modules.filter((item) => item.distro?.moduleType === 'entry')
    .map((item) => item.distro?.moduleName).sort();
  if (summary.app?.bundleName !== BUNDLE
      || summary.app?.version?.name !== APP_VERSION
      || String(summary.app?.version?.code) !== APP_VERSION_CODE) {
    fail(`APP 版本/包名不正确：${JSON.stringify(summary.app)}`);
  }
  if (JSON.stringify(entries) !== JSON.stringify(['entry', 'phone'])) {
    fail(`APP entry 模块不正确：${JSON.stringify(entries)}`);
  }
  const expectedTypes = new Map([
    /* 【2026-11-08 用户裁决】entry 同一声明 tablet + 2in1：
       - Edge / Pro Max 等双形态平板按 PC 兼容应用分发，运行时走 PC 形态；
       - 单形态平板仍由 DeviceFacts 判为 TABLET，布局与运行结果不变；
       - PC/2in1 也由 entry 承载（原独立 pc 壳已并入，避免同设备类型两个 entry）。
       phone=phone；hostruntime 三设备面。 */
    ['entry', ['tablet', '2in1']],
    ['phone', ['phone']],
    ['hostruntime', ['phone', 'tablet', '2in1']],
  ]);
  for (const name of ['entry', 'phone', 'hostruntime']) {
    const item = modules.find((module) => module.distro?.moduleName === name);
    if (!item || JSON.stringify(item.deviceType) !== JSON.stringify(expectedTypes.get(name))) {
      fail(`APP 模块 ${name} 的 deviceType 不正确：${JSON.stringify(item?.deviceType)}`);
    }
  }

  const scratch = mkdtempSync(join(tmpdir(), 'dshm-agc-check-'));
  try {
    run('unzip', ['-q', app,
      'entry-default.hap', 'phone-default.hap', 'hostruntime-default.hsp', '-d', scratch]);
    const entryHap = join(scratch, 'entry-default.hap');
    const phoneHap = join(scratch, 'phone-default.hap');
    const hsp = join(scratch, 'hostruntime-default.hsp');
    const entry = JSON.parse(zipText(entryHap, 'module.json'));
    const phone = JSON.parse(zipText(phoneHap, 'module.json'));
    const shared = JSON.parse(zipText(hsp, 'module.json'));
    assertModule(entry, 'entry', 'entry-default.hap');
    assertModule(phone, 'phone', 'phone-default.hap');
    assertModule(shared, 'hostruntime', 'hostruntime-default.hsp');
    if (entry.module?.name !== 'entry' || phone.module?.name !== 'phone'
        || shared.module?.name !== 'hostruntime') {
      fail('APP 内模块名不符合预期');
    }
    const entryPerms = (entry.module?.requestPermissions ?? []).map((item) => item.name);
    const phonePerms = (phone.module?.requestPermissions ?? []).map((item) => item.name);
    /*
     * 【条数从门禁判据里取，不在这里抄一遍】写死的 17/9 会在每次收口权限时假红
     * （2026-10-31 docs/328 删 GET/SET_NETWORK_INFO ⇒ 17/9 → 15/7，本行当场报错）。
     * 权限面的**唯一裁判**是 tools/check-permission-surface.mjs 的 EXPECTED / PHONE_EXPECTED，
     * 这里只做"出包前再确认一次"。
     */
    /*
     * 【条数从门禁判据里取，不在这里抄一遍】写死的 17/9 会在每次收口权限时假红
     * （2026-10-31 docs/328 删 GET/SET_NETWORK_INFO ⇒ 17/9 → 15/7，本行当场报错）。
     * 权限面的**唯一裁判**是 tools/check-permission-surface.mjs，
     * 这里只按"数组块内 'ohos.permission.' 出现次数"再确认一次 ——
     * 不用正则配对括号：那对注释里的示例数组也会命中，脆得很。
     */
    const permGate = readFileSync(join(ROOT, 'tools', 'check-permission-surface.mjs'), 'utf8');
    const countIn = (name) => {
      const at = permGate.indexOf('const ' + name + ' = [');
      if (at < 0) fail('无法从 check-permission-surface.mjs 找到 ' + name);
      /* 从数组起点扫到与之配对的 ']'（只数方括号，注释里的方括号在这两个数组里不存在） */
      let depth = 0;
      let end = at;
      for (let k = permGate.indexOf('[', at); k < permGate.length; k += 1) {
        if (permGate[k] === '[') depth += 1;
        else if (permGate[k] === ']') {
          depth -= 1;
          if (depth === 0) { end = k; break; }
        }
      }
      return (permGate.slice(at, end).match(/'ohos\.permission\./g) ?? []).length;
    };
    const wantEntry = countIn('EXPECTED');
    const wantPhone = countIn('PHONE_EXPECTED');
    if (entryPerms.length !== wantEntry) fail('entry 权限数是 ' + entryPerms.length + '，期望 ' + wantEntry + '（见 check-permission-surface）');
    if (phonePerms.length !== wantPhone) fail('phone 权限数是 ' + phonePerms.length + '，期望 ' + wantPhone + '（见 check-permission-surface）');

    /*
     * 【2026-11-10 用户口径】"AGC 包声明的权限要与 profile 有的权限对齐"。
     * 只比 ACL **集合**不够：集合相同、但某个模块多声明了一条 system_basic 时，
     * 设备侧仍会按 PERMISSION_ACL_RULE 拒装（docs/142）。这里按 SDK 权限表逐条判：
     * 凡是 system_basic / system_core 的声明，必须在 release profile 的 allowed-acls 里。
     * normal / user_grant 不受 ACL 约束，不做要求。
     */
    const defFile = join(SDK_HOME, 'default', 'openharmony', 'toolchains', 'lib',
      'PermissionDefinitions.json');
    if (!existsSync(defFile)) fail('找不到 SDK 权限表：' + defFile);
    const defJson = JSON.parse(readFileSync(defFile, 'utf8'));
    const defRows = Array.isArray(defJson) ? defJson : (defJson.definePermissions ?? []);
    const levelOf = new Map(defRows.filter((p) => p && p.name).map((p) => [p.name, p.availableLevel]));
    const allowedAcls = new Set(materialInfo.acls);
    for (const [label, perms] of [['entry', entryPerms], ['phone', phonePerms]]) {
      for (const name of perms) {
        const level = levelOf.get(name);
        if (level === undefined) continue;
        if ((level === 'system_basic' || level === 'system_core') && !allowedAcls.has(name)) {
          fail(`${label} 声明了 ${name}（${level}），但 release Profile 的 allowed-acls 未授权 ⇒ 设备侧 PERMISSION_ACL_RULE 拒装`);
        }
      }
    }

    const entryNames = zipNames(entryHap);
    const hspNames = zipNames(hsp);
    /* ffmpeg 是 PC/2in1 档资产（RuntimePort 只在 nativeTerminalOnly 档注入 DSHM_PC_RESFILE_DIR）。
       entry 现在同时承载 tablet + 2in1，因此必须随 entry 携带；共享 HSP 仍不得重复打包。 */
    const ffmpegBins = entryNames.filter((name) =>
      /^resources\/resfile\/toolchain\/ffmpeg\/bin\/(ffmpeg|ffprobe)$/.test(name));
    const ffmpegLibs = entryNames.filter((name) =>
      /^resources\/resfile\/toolchain\/ffmpeg\/lib\/.*\.so/.test(name));
    if (ffmpegBins.length !== 2 || ffmpegLibs.length !== 28) {
      fail(`entry 内 ffmpeg 资产不完整：bins=${ffmpegBins.length} libs=${ffmpegLibs.length}`);
    }
    if (hspNames.some((name) => name.startsWith('resources/resfile/toolchain/ffmpeg/'))) {
      fail('共享 HSP 不应携带 ffmpeg 资产');
    }
    if (!hspNames.includes('libs/arm64-v8a/libsystem.so')) {
      fail('共享 HSP 缺少 libsystem.so');
    }
    const cores = hspNames.filter((name) =>
      /^resources\/resfile\/dsh-core-.+-openharmony-arm64\.zip$/.test(name));
    if (cores.length !== 1 || !cores[0].includes(CORE_VERSION)) {
      fail(`共享 HSP 核心容器不正确：${JSON.stringify(cores)}`);
    }
    const pluginEntries = [...entryNames, ...zipNames(phoneHap), ...hspNames]
      .filter((name) => /(^|\/)dsh-bili-whale(\/|$)/.test(name));
    if (pluginEntries.length > 0) fail('APP 不得内置 dsh-bili-whale');

    const verifyDir = mkdtempSync(join(tmpdir(), 'dshm-agc-verify-'));
    try {
      const signTool = join(SDK_HOME,
        'default', 'openharmony', 'toolchains', 'lib', 'hap-sign-tool');
      if (!existsSync(signTool)) fail(`找不到 hap-sign-tool：${signTool}`);
      run(signTool, [
        'verify-app', '-inFile', app,
        '-outCertChain', join(verifyDir, 'verify.cer'),
        '-outProfile', join(verifyDir, 'verify.p7b'),
      ], { capture: true });
    } finally {
      rmSync(verifyDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  if (existsSync(finalApp)) fail(`输出已存在，拒绝覆盖：${finalApp}`);
  mkdirSync(releaseDir, { recursive: true });

  run(process.execPath, [join(ROOT, 'tools/build-node-cli.mjs')]);
  /* 随包 libnode 必须带 .codesign，否则 exec 域 dlopen 被拒（tools/sign-bundled-libs.mjs）。 */
  run(process.execPath, [join(ROOT, 'tools/sign-bundled-libs.mjs')]);
  /*
   * 【2026-11-08】独立 `pc` 薄壳已并入 entry（entry=deviceTypes: tablet+2in1），
   * 不再需要为第二份源码补 cpp 类型软链。保留 place-ffmpeg：目标已改为 entry。
   */
  run(process.execPath, [join(ROOT, 'tools/place-ffmpeg.mjs')]);
  run(process.execPath, [join(ROOT, 'tools/place-host-app.mjs')]);
  run('devecocli', ['build', 'clean'], {
    env: { ...process.env, DEVECO_HOME: DEVECO_ROOT, DEVECO_SDK_HOME: SDK_HOME },
  });

  configureCombinedRelease(materialInfo.config);
  run('devecocli', [
    'build', '--product', 'release', '--build-mode', 'release',
  ], {
    env: { ...process.env, DEVECO_HOME: DEVECO_ROOT, DEVECO_SDK_HOME: SDK_HOME },
  });

  const appSrc = join(ROOT, 'build', 'outputs', 'release',
    'DSHM-deveco-workspace-release-signed.app');
  if (!existsSync(appSrc)) fail(`缺少 release 签名 APP：${appSrc}`);
  validateApp(appSrc);
  copyFileSync(appSrc, finalApp);
  const digest = createHash('sha256').update(readFileSync(finalApp)).digest('hex');
  writeFileSync(`${finalApp}.sha256`, `${digest}  ${basename(finalApp)}\n`, 'utf8');
  const sumsPath = join(releaseDir, 'SHA256SUMS.txt');
  const previous = existsSync(sumsPath) ? readFileSync(sumsPath, 'utf8').trimEnd() : '';
  writeFileSync(sumsPath,
    `${previous}${previous.length > 0 ? '\n' : ''}${digest}  ${basename(finalApp)}\n`, 'utf8');
  console.log(`\n${DEVICE_SIDELOAD ? 'DEVICE RELEASE OK' : 'AGC RELEASE OK'}: ${finalApp}`);
  console.log(`size=${statSync(finalApp).size}`);
  console.log(`sha256=${digest}`);
  console.log(`profile_acls=${materialInfo.acls.length}`);
} finally {
  restoreBuildProfile();
}
