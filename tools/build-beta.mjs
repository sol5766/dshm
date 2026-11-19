#!/usr/bin/env node
/**
 * 临时构建 com.dshm.dshmbeta beta 测试包。
 *
 * 纪律：
 *   1. 只在构建期间临时替换包名/Profile，结束后在 finally 中逐字恢复；
 *   2. 不接触正式 App ID、正式签名物料或设备数据；
 *   3. 口径与 AGC 完全一致：**只有两个交付面** —— `entry`(tablet+2in1)、`phone`(phone)，
 *      共享 `hostruntime`；默认一次 `assembleApp` 产出三端合一 .app，并另备 tablet / phone
 *      两个单入口安装目录供 hdc 侧载（本地安装器拒收 .app）；
 *   4. debug 侧载保持正式权限面，不删任何权限。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEVECO_ROOT_MARKER, DEVECO_ROOT_MARKER_CLT, devecoPath, resolveDevecoRoot } from './lib/deveco-home.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CORE_VERSION = JSON.parse(
  readFileSync(join(ROOT, 'hostcore', 'core-recipe.json'), 'utf8')).coreVersion;
const APP_SCOPE_TEXT = readFileSync(join(ROOT, 'AppScope', 'app.json5'), 'utf8');
const APP_VERSION = /"versionName"\s*:\s*"([^"]+)"/.exec(APP_SCOPE_TEXT)?.[1] ?? '';
const APP_VERSION_CODE = /"versionCode"\s*:\s*(\d+)/.exec(APP_SCOPE_TEXT)?.[1] ?? '';
if (APP_VERSION.length === 0 || APP_VERSION_CODE.length === 0) {
  throw new Error('无法从 AppScope/app.json5 读取版本号');
}
const PROD_BUNDLE = 'com.dshm.dshclient';
const BETA_BUNDLE = 'com.dshm.dshmbeta';
const BETA_APP_ID = '6918745051729970584';
/*
 * 品牌显示名（与 AppScope/entry/phone 的 string.json 同源）。
 * 2026-10-30 应用正式更名「DSHM」后，旧写死的 DSHM→DSHM beta 替换与断言会
 * 让 Beta 出包失败；改为**只替换当前正式名**，不再假设旧品牌名。
 * 包名仍由上面的 PROD_BUNDLE/BETA_BUNDLE 处理，互不相干。
 */
const PROD_LABEL = 'DSHM';
const BETA_LABEL = 'DSHM beta';
const PROD_LABEL_EN = 'Jinghong';
const BETA_LABEL_EN = 'Jinghong beta';
const BETA_PROFILE = join(ROOT,
  'signing/debug/default_desktop.ohos.arm64_H6ERYybQIgIZaVstkvwvtC9vr-nLxAUfZBhCBJKkRhw=.p7b');
const BETA_ACLS = [
  'ohos.permission.ALLOW_EXTERNAL_NATIVE_CODE',
  'ohos.permission.FILE_ACCESS_PERSIST',
];
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const argOf = (name, fallback = '') => {
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
};
const SIDELOAD_ONLY = flag('--sideload-only');
/* 【2026-11-08 两口径】Beta 与 AGC 看齐：不再有独立 pc 壳，也不再按端分 product。
   固定单 product（entry tablet+2in1 / phone phone / hostruntime 共享），一次出三端合一包。
   旧命令里的 `--combined-app` 仍接受（等价于默认行为）；`--pc-only` 明确拒绝。 */
if (flag('--pc-only')) {
  throw new Error('--pc-only 已废弃：2in1 由 entry 承载（entry=deviceTypes tablet+2in1），请直接构建默认三端包');
}
const COMBINED_APP = true;
const PC_ONLY = false;
const EXISTING_BETA_UPGRADE = flag('--existing-beta-upgrade');
/*
 * 【2026-11-10 用户口径】beta 只用于本地测试：**默认**附带
 * `ohos.permission.ACCESS_USER_FULL_DISK`（2in1 全盘文件访问），正式 AGC 包不动。
 * 用 `--no-full-disk` 可退回纯"与正式权限面一致"的 beta。
 *
 * 【红线】这条只在构建期注入 entry 的 module.json5（finally 逐字恢复），
 * 不写进源码、不进正式 manifest、不改 phone（手机没有该能力）。
 * 【边界】它在 SDK 里是 system_basic + manual_settings + deviceTypes=['2in1']：
 * 装完还要用户去「设置 → 应用 → DSHM beta → 全盘文件访问」手动打开，
 * 不是安装即授，也不是"补齐七条目录 ACL 就顺带拿到"。
 */
const WITH_FULL_DISK = !flag('--no-full-disk');

const TEXT_EDITS = [
  'AppScope/app.json5',
  'AppScope/resources/base/element/string.json',
  'build-profile.json5',
  'phone/src/main/resources/base/profile/agent_config.json',
  'phone/src/main/resources/base/profile/shortcuts_config.json',
  'phone/src/main/resources/base/element/string.json',
  'phone/src/main/resources/en_US/element/string.json',
  'entry/src/main/ets/entryability/EntryAbility.ets',
  'entry/src/main/resources/base/profile/agent_config.json',
  'entry/src/main/resources/base/profile/shortcuts_config.json',
  'entry/src/main/resources/base/element/string.json',
  'entry/src/main/resources/en_US/element/string.json',
  'hostruntime/src/main/ets/runtime/NodeRuntime.ets',
  'hostcore/app/dshm-installer.js',
  'entry/src/main/module.json5',
  'hostruntime/src/main/module.json5',
];

const originals = new Map();
const BUILD_CLI = 'devecocli';
if (!existsSync(BETA_PROFILE)) throw new Error(`找不到 beta debug Profile：${BETA_PROFILE}`);
const devecoRoot = resolveDevecoRoot();
const json5 = createRequire(import.meta.url)(
  join(devecoRoot, 'hvigor', 'hvigor-ohos-plugin', 'node_modules', 'json5'));

function run(command, args, env = process.env) {
  const r = spawnSync(command, args, { cwd: ROOT, env, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败（exit=${r.status}）`);
}

function zipText(file, member) {
  const r = spawnSync('unzip', ['-p', file, member], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`读取 ${file}:${member} 失败`);
  return r.stdout;
}

/**
 * 静态快捷方式的目标必须是当前 HAP 自己的模块。
 *
 * 2026-10-26 AGC 审核反馈：手机 HAP 的模块名已是 phone，快捷方式却仍指向
 * 旧模块 entry。系统能显示菜单，但点击时找不到目标模块，表现为完全无响应。
 * 本检查直接读**即将进入 beta APP 的已签 HAP**，防止源码配置正确而产物回退。
 */
function assertShortcutSurface(hap, expectedModule, forbidMeeting) {
  const member = 'resources/base/profile/shortcuts_config.json';
  const parsed = JSON.parse(zipText(hap, member));
  const shortcuts = parsed?.shortcuts;
  if (!Array.isArray(shortcuts) || shortcuts.length === 0) {
    throw new Error(`${hap}:${member} 没有 shortcuts`);
  }
  const newSession = shortcuts.find((s) => s?.shortcutId === 'id_new_session');
  if (!newSession || newSession.visible !== true) {
    throw new Error(`${expectedModule} beta 快捷方式缺少可见的 id_new_session`);
  }
  if (forbidMeeting && shortcuts.some((s) => s?.shortcutId === 'id_meeting')) {
    throw new Error('phone beta 快捷方式不得再声明 id_meeting');
  }
  for (const shortcut of shortcuts) {
    const wants = shortcut?.wants;
    if (!Array.isArray(wants) || wants.length === 0) {
      throw new Error(`${expectedModule} 快捷方式 ${shortcut?.shortcutId ?? '(无 id)'} 缺少 wants`);
    }
    for (const want of wants) {
      if (want?.bundleName !== BETA_BUNDLE
          || want?.moduleName !== expectedModule
          || want?.abilityName !== 'EntryAbility') {
        throw new Error(
          `${expectedModule} 快捷方式 ${shortcut?.shortcutId ?? '(无 id)'} 目标错误：`
          + `${JSON.stringify(want?.bundleName)}/${JSON.stringify(want?.moduleName)}/`
          + `${JSON.stringify(want?.abilityName)}，期望 ${BETA_BUNDLE}/${expectedModule}/EntryAbility`);
      }
      if (typeof want?.parameters?.dshAction !== 'string'
          || want.parameters.dshAction.length === 0) {
        throw new Error(`${expectedModule} 快捷方式 ${shortcut?.shortcutId ?? '(无 id)'} 缺少 dshAction`);
      }
    }
  }
}

function verifyBetaProfileAcls() {
  const text = readFileSync(BETA_PROFILE, 'latin1');
  if (!text.includes(`"bundle-name":"${BETA_BUNDLE}"`)
      || !text.includes(`"app-identifier":"${BETA_APP_ID}"`)
      || !text.includes('"type":"debug"')) {
    throw new Error('beta debug Profile 的 bundle / App ID / type 不正确');
  }
  const block = text.match(/"allowed-acls":\[(.*?)\]/)?.[1] ?? '';
  const actual = [...block.matchAll(/"([^"]+)"/g)]
    .map((m) => m[1])
    .sort();
  const expected = [...BETA_ACLS].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const message = (
      `beta debug Profile ACL 面不完整：实际 ${JSON.stringify(actual)}，`
      + `期望 ${JSON.stringify(expected)}。独立 bundle 不能沿用正式 App ID 的 ACL，`
      + '必须先给 beta App ID 取得同一组 ACL 后再构建。');
    if (EXISTING_BETA_UPGRADE) {
      console.warn(`\nWARN: ${message}`);
      console.warn('WARN: 本次明确按“设备上已安装同签名 beta、仅覆盖升级”生成侧载件。');
      console.warn('WARN: 该包不得用于全新安装或分发给没有既有 beta 权限记录的设备。\n');
      return;
    }
    throw new Error(message);
  }
}

/**
 * 把一条权限插进 entry 的 requestPermissions 开头（构建期临时改动，finally 恢复）。
 *
 * 【为什么用文本插入而不是 json5 重写】module.json5 里有大量注释与结构说明，
 * 解析后再序列化会把它们全丢掉 —— 一旦 finally 恢复失败，源码就被永久改写。
 * 这里只做一次"在数组开头插一个对象"的最小编辑。
 */
function injectFullDiskPermission() {
  const rel = 'entry/src/main/module.json5';
  const text = read(rel);
  if (text.includes('ACCESS_USER_FULL_DISK')) {
    return;
  }
  const anchor = '"requestPermissions": [';
  const at = text.indexOf(anchor);
  if (at < 0) {
    throw new Error('entry/src/main/module.json5 找不到 requestPermissions 数组');
  }
  const insertAt = at + anchor.length;
  const block = `
      {
        "name": "ohos.permission.ACCESS_USER_FULL_DISK",
        "reason": "$string:perm_full_disk_reason",
        "usedScene": {
          "abilities": [
            "EntryAbility"
          ],
          "when": "always"
        }
      },`;
  write(rel, text.slice(0, insertAt) + block + text.slice(insertAt));
  addStringResource('entry/src/main/resources/base/element/string.json',
    'perm_full_disk_reason',
    '用于在用户选择的任意本地项目目录中读写代码，并让内置 Node、Git、Python 等工具以真实路径访问该目录');
  addStringResource('entry/src/main/resources/en_US/element/string.json',
    'perm_full_disk_reason',
    'Read and write code in any local project directory chosen by the user, and let the built-in Node, Git and Python tools access that directory by its real path');
}

/** 给 string.json 补一条（幂等；只用于构建期临时文件）。 */
function addStringResource(rel, name, value) {
  const parsed = JSON.parse(read(rel));
  const rows = parsed?.string;
  if (!Array.isArray(rows)) {
    throw new Error(`${rel} 缺少 string 数组`);
  }
  if (rows.some((row) => row?.name === name)) {
    return;
  }
  rows.push({ name, value });
  write(rel, JSON.stringify(parsed, null, 2) + '\n');
}

/** 读 beta debug profile 的 allowed-acls（只取字段，不做密码学验签）。 */
function betaProfileAcls() {
  const text = readFileSync(BETA_PROFILE, 'latin1');
  const block = text.match(/"allowed-acls"\s*:\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * 声明面 vs 签名授权面的**逐条**对照（只告警，不阻断 beta）。
 *
 * 【为什么 beta 不阻断】设备侧对 debug 包的实测表现与 release 不同：当前 beta
 * 声明 17 条、profile 只列 2 条 ACL，仍能安装运行（用户 2026-11-10 已装包实测）。
 * 因此这里不能照搬 release 的 fail-closed，否则 beta 直接出不来。
 * 【为什么仍要打印】"装得上"不等于"已授权"：这些条目要靠用户在系统设置里逐项
 * 打开，或被系统按 apl 拒绝。把差集明写出来，避免再把"声明了"当成"拿到了"。
 */
function warnUncoveredAcls(declared) {
  const defsFile = join(devecoRoot, 'sdk', 'default', 'openharmony', 'toolchains', 'lib',
    'PermissionDefinitions.json');
  if (!existsSync(defsFile)) {
    console.warn('WARN: 找不到 SDK 权限表，跳过 ACL 覆盖对照');
    return;
  }
  const defs = JSON.parse(readFileSync(defsFile, 'utf8'));
  const rows = Array.isArray(defs) ? defs : (defs.definePermissions ?? []);
  const levelOf = new Map(rows.filter((p) => p && p.name).map((p) => [p.name, p.availableLevel]));
  const allowed = new Set(betaProfileAcls());
  const missing = declared.filter((name) => {
    const level = levelOf.get(name);
    return (level === 'system_basic' || level === 'system_core') && !allowed.has(name);
  });
  if (missing.length > 0) {
    console.warn(`\nWARN: beta Profile 未授权以下 ${missing.length} 条受限权限（声明仍在包里）：`);
    for (const name of missing) {
      console.warn(`WARN:   - ${name} [${levelOf.get(name)}]`);
    }
    console.warn('WARN: debug 包实测可安装，但这些条目的实际授予取决于系统设置/设备策略，');
    console.warn('WARN: 不能在验收里把"包内有声明"当成"已获权"。\n');
  }
}

function backup(rel) {
  const path = join(ROOT, rel);
  originals.set(path, readFileSync(path));
}

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function write(rel, text) {
  writeFileSync(join(ROOT, rel), text);
}

function restoreAll() {
  for (const [path, bytes] of originals) writeFileSync(path, bytes);
  for (const [path, bytes] of originals) {
    if (!readFileSync(path).equals(bytes)) throw new Error(`正式文件逐字恢复失败：${path}`);
  }
  const place = spawnSync(process.execPath, [join(ROOT, 'tools/place-host-app.mjs')], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  if (place.status !== 0) {
    console.error('⚠ 正式 host app 资源恢复失败，请立即运行 node tools/place-host-app.mjs');
  }
}

const defaultStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
const outDir = resolve(argOf(
  '--out',
  join(ROOT, 'dist/beta', `DSHM-beta-${APP_VERSION}-${APP_VERSION_CODE}-${defaultStamp}`),
));

try {
  if (existsSync(outDir)) throw new Error(`beta 输出目录已存在，拒绝覆盖：${outDir}`);
  verifyBetaProfileAcls();
  run(process.execPath, [join(ROOT, 'tools/check-host-port-isolation.mjs')]);
  run(process.execPath, [join(ROOT, 'tools/build-node-cli.mjs')]);
  /* 随包 libnode 必须带 .codesign，否则 exec 域 dlopen 被拒（见 tools/sign-bundled-libs.mjs 头注）。 */
  run(process.execPath, [join(ROOT, 'tools/sign-bundled-libs.mjs')]);
  run(process.execPath, [join(ROOT, 'tools/place-ffmpeg.mjs')]);
  run(BUILD_CLI, ['build', 'clean'], {
    ...process.env,
    DEVECO_HOME: devecoRoot,
    DEVECO_SDK_HOME: join(devecoRoot, 'sdk'),
  });
  for (const rel of TEXT_EDITS) backup(rel);

  for (const rel of TEXT_EDITS) {
    let text = read(rel);
    text = text.split(PROD_BUNDLE).join(BETA_BUNDLE);
    if (rel === 'build-profile.json5') {
      text = text.replaceAll(
        './.certs/multihap-20261024/DSHM-multihap-debug-pc-phone-20261024.p7b',
        './signing/debug/default_desktop.ohos.arm64_H6ERYybQIgIZaVstkvwvtC9vr-nLxAUfZBhCBJKkRhw=.p7b');
    }
    if (rel.endsWith('/element/string.json')) {
      text = text.replaceAll(`"value": "${PROD_LABEL}"`, `"value": "${BETA_LABEL}"`);
      text = text.replaceAll(`"value": "${PROD_LABEL_EN}"`, `"value": "${BETA_LABEL_EN}"`);
    }
    write(rel, text);
  }
  if (WITH_FULL_DISK) {
    injectFullDiskPermission();
  }
  {
    const profile = json5.parse(read('build-profile.json5'));
    const base = profile.app.products[0];
    const moduleTarget = (name) => profile.modules.find((m) => m.name === name)?.targets?.[0];
    const entryTarget = moduleTarget('entry');     // entry = tablet + 2in1（同一 HAP）
    const phoneTarget = moduleTarget('phone');     // phone = 手机
    const hostTarget = moduleTarget('hostruntime'); // 共享 HSP：三设备面
    if (!entryTarget || !phoneTarget || !hostTarget) {
      throw new Error('build-profile 缺少 entry / phone / hostruntime 模块 target');
    }
    /* 单 product = AGC 的三端合一组合；不再有 pc product / pc 模块。
       历史 build-profile 若还残留 pc，这里直接剔除，保证 Beta 结构 == AGC。 */
    const combined = JSON.parse(JSON.stringify(base));
    combined.name = 'default';
    combined.signingConfig = 'debug';
    combined.bundleName = BETA_BUNDLE;
    profile.app.products = [combined];
    profile.modules = profile.modules.filter((module) => module.name !== 'pc');
    entryTarget.applyToProducts = ['default'];
    phoneTarget.applyToProducts = ['default'];
    hostTarget.applyToProducts = ['default'];
    write('build-profile.json5', JSON.stringify(profile, null, 2) + '\n');
  }
  run(process.execPath, [join(ROOT, 'tools/place-host-app.mjs')]);
  const stagedInstaller = read('hostruntime/src/main/resources/resfile/resources/app/dshm-installer.js');
  if (!stagedInstaller.includes(BETA_BUNDLE)) {
    throw new Error('beta 临时 Host 资源未写入 beta 包名');
  }
  run(BUILD_CLI, ['build', '--product', 'default', '--build-mode', 'debug'], {
    ...process.env,
    DEVECO_HOME: devecoRoot,
    DEVECO_SDK_HOME: join(devecoRoot, 'sdk'),
  });
  /* 单 product 已同时包含 entry + phone + hostruntime ⇒ 不再有第二遍 product=phone 构建。 */

  const phoneVariant = 'default';
  const hapSrc = join(ROOT, `phone/build/${phoneVariant}/outputs/default/phone-default-signed.hap`);
  const entrySrc = join(ROOT, 'entry/build/default/outputs/default/entry-default-signed.hap');
  const hspDefaultSrc = join(ROOT, 'hostruntime/build/default/outputs/default/hostruntime-default-signed.hsp');
  const requiredOutputs = [hapSrc, entrySrc, hspDefaultSrc];
  for (const src of requiredOutputs) {
    if (!existsSync(src)) throw new Error(`缺少 beta 构建产物：${src}`);
  }
  if (!PC_ONLY) {
    const betaModule = JSON.parse(zipText(hapSrc, 'module.json'));
    if (betaModule.app?.bundleName !== BETA_BUNDLE
        || String(betaModule.app?.versionCode) !== APP_VERSION_CODE
        || betaModule.app?.buildMode !== 'debug'
        || betaModule.app?.debug !== true) {
      throw new Error(`beta HAP 身份/模式不正确：${JSON.stringify(betaModule.app)}`);
    }
    const betaPerms = (betaModule.module?.requestPermissions ?? []).map((p) => p.name);
    /*
     * 【2026-11-02 更新】手机端权限面由 7 增至 9（GET_NETWORK_INFO / RUNNING_LOCK，
     * 两条都是 normal、安装即授）。原判据里的 SET_NETWORK_INFO 是历史遗留（手机端
     * 从未真正声明过它，是 module.json5 里那段注释的残留），换成实际存在的两条新权限。
     */
    if (betaPerms.length !== 9 || !betaPerms.includes('ohos.permission.READ_PASTEBOARD')
        || !betaPerms.includes('ohos.permission.FILE_ACCESS_PERSIST')
        || !betaPerms.includes('ohos.permission.GET_NETWORK_INFO')
        || !betaPerms.includes('ohos.permission.RUNNING_LOCK')) {
      throw new Error(`beta phone 权限面不完整：${JSON.stringify(betaPerms)}`);
    }
  }
  if (!PC_ONLY) {
    const entryModule = JSON.parse(zipText(entrySrc, 'module.json'));
    const entryPerms = (entryModule.module?.requestPermissions ?? []).map((p) => p.name);
    /* 2026-11-11：全盘权限已进正式声明（Profile DSHM1109Release 已批），因此恒为 18 条。 */
    const wantEntryPerms = 18;
    if (entryModule.app?.bundleName !== BETA_BUNDLE
        || String(entryModule.app?.versionCode) !== APP_VERSION_CODE
        || entryModule.app?.buildMode !== 'debug'
        || entryModule.app?.debug !== true
        || entryPerms.length !== wantEntryPerms
        /* 2026-11-02：SET_NETWORK_INFO 是历史遗留（从未真实声明）；改为实际新增的两条 normal */
        || !entryPerms.includes('ohos.permission.GET_NETWORK_INFO')
        || !entryPerms.includes('ohos.permission.RUNNING_LOCK')
        || !entryPerms.includes('ohos.permission.ACCESS_USER_FULL_DISK')) {
      throw new Error(`beta 桌面/平板 HAP 身份、模式或 ${wantEntryPerms} 条权限面不正确`);
    }
    /* 声明 ≠ 授权：把 profile 未覆盖的 ACL 条目逐条打出来（见 warnUncoveredAcls）。 */
    warnUncoveredAcls(entryPerms);
  }
  assertShortcutSurface(hapSrc, 'phone', true);
  assertShortcutSurface(entrySrc, 'entry', false);
  for (const hap of [entrySrc, hapSrc]) {
    const resources = spawnSync('unzip', ['-p', hap, 'resources.index'], {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (resources.status !== 0 || !resources.stdout.includes(Buffer.from(BETA_LABEL, 'utf8'))) {
      throw new Error(`beta HAP 未编译出可见名称 ${BETA_LABEL}：${hap}`);
    }
  }
  /* 单 product ⇒ 只产 default 一个 HSP（三设备面），与 AGC 一致。 */
  for (const hspSrc of [hspDefaultSrc]) {
    const hspInstaller = zipText(hspSrc, 'resources/resfile/resources/app/dshm-installer.js');
    if (!hspInstaller.includes(BETA_BUNDLE) || hspInstaller.includes(PROD_BUNDLE)) {
      throw new Error('beta HSP 的 Host 资源没有完全切到 beta 包名');
    }
  }
  const appSources = [{
    dir: 'combined',
    path: join(ROOT, 'build/outputs/default/DSHM-deveco-workspace-default-signed.app'),
  }];
  for (const item of appSources) {
    if (!existsSync(item.path)) throw new Error(`缺少 beta debug APP：${item.path}`);
    const appPack = JSON.parse(zipText(item.path, 'pack.info', 32 * 1024 * 1024));
    const summary = appPack.summary;
    const modules = summary?.modules ?? [];
    const entries = modules.filter((m) => m.distro?.moduleType === 'entry');
    const actualNames = entries.map((m) => m.distro?.moduleName).sort();
    if (summary?.app?.bundleName !== BETA_BUNDLE
        || String(summary?.app?.version?.code) !== APP_VERSION_CODE
        || JSON.stringify(actualNames) !== JSON.stringify(['entry', 'phone'])) {
      throw new Error(`${item.dir} beta APP entry 结构不正确：`
        + `${JSON.stringify(actualNames)}，期望 ["entry","phone"]`);
    }
    /* 与 AGC 包同一份结构断言：entry=tablet+2in1、phone=phone、hostruntime 三设备面。 */
    const expectedTypes = new Map([
      ['entry', ['tablet', '2in1']],
      ['phone', ['phone']],
      ['hostruntime', ['phone', 'tablet', '2in1']],
    ]);
    for (const [name, types] of expectedTypes) {
      const module = modules.find((m) => m.distro?.moduleName === name);
      if (!module || JSON.stringify(module.deviceType) !== JSON.stringify(types)) {
        throw new Error(`beta APP 模块 ${name} 的 deviceType 不正确：${JSON.stringify(module?.deviceType)}`);
      }
    }
    if (modules.some((m) => m.distro?.moduleName === 'pc')) {
      throw new Error('beta APP 不应包含 pc 模块（2in1 由 entry 承载）');
    }
  }
  mkdirSync(outDir, { recursive: true });
  const appSrc = appSources[0].path;
  const appDst = join(outDir, `DSHM-beta-${APP_VERSION}-${APP_VERSION_CODE}-combined-debug.app`);
  copyFileSync(appSrc, appDst);
  const staged = [appDst];
  /*
   * 侧载目录：每个目录恰好一个 entry HAP + 一个共享 HSP（本地安装器拒收 .app）。
   * tablet 与 PC / 2in1 共用同一份 entry HAP —— 与 AGC 的
   * entry=deviceTypes( tablet, 2in1 ) 完全一致；不再生成 pc 目录 / pc 模块。
   */
  const targets = [
    { dir: 'tablet', hap: entrySrc, hsp: hspDefaultSrc, name: `DSHM-${APP_VERSION}-beta-entry-debug.hap` },
    { dir: 'phone', hap: hapSrc, hsp: hspDefaultSrc, name: `DSHM-${APP_VERSION}-beta-phone-debug.hap` },
  ];
  for (const target of targets) {
    mkdirSync(join(outDir, target.dir), { recursive: true });
    const hapDst = join(outDir, target.dir, target.name);
    const hspDst = join(outDir, target.dir, `DSHM-${APP_VERSION}-beta-hostruntime-debug.hsp`);
    copyFileSync(target.hap, hapDst);
    copyFileSync(target.hsp, hspDst);
    staged.push(hapDst, hspDst);
  }
  const sums = staged.map((file) => {
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
    return `${hash}  ${file.slice(outDir.length + 1)}`;
  });
  writeFileSync(join(outDir, 'SHA256SUMS'), sums.join('\n') + '\n', 'utf8');
  writeFileSync(join(outDir, 'README.txt'), `DSHM ${APP_VERSION} beta / ${APP_VERSION_CODE}

Bundle: ${BETA_BUNDLE}
AGC App ID: ${BETA_APP_ID}
Core: ${CORE_VERSION}
Signing: debug
Profile: 2068255084709442560
Install: exactly ONE device directory (one entry HAP + one shared HSP); never uninstall.

This build is structurally identical to the AGC package:
  entry-default.hap       deviceTypes: tablet, 2in1
  phone-default.hap       deviceTypes: phone
  hostruntime-default.hsp deviceTypes: phone, tablet, 2in1

Side-load directories (local hdc / installer):
  tablet: 平板 + PC / 2in1 / Edge / Pro Max（同一份 entry HAP）
  phone:  手机（phone）

Label: ${BETA_LABEL}
Permissions: entry=18 (same declarations as formal, including ACCESS_USER_FULL_DISK), phone=9.
${WITH_FULL_DISK ? `Full disk: declared in entry only. It is system_basic + manual_settings +
  deviceTypes=[2in1] => after install, enable it manually in
  Settings > Apps > ${BETA_LABEL} > full disk file access. Declaring it does not
  grant it; the debug profile only lists 2 allowed-acls (see build log WARN).
` : 'Full disk: NOT included (--no-full-disk).\n'}
The ffmpeg/ffprobe toolchain is inside the entry HAP, not the shared HSP.

Expected checks after cover-install:
  1. First launch installs ${CORE_VERSION}; a new turn has no
     "node-addon-system-linux-arm64/bin/musl/system.node" error.
  2. Existing beta sessions, workspaces and plugins remain visible.
  3. Install one plugin and confirm the install result is produced.

  node tools/update-device.mjs --skip-build --target <connect-key> \\
    --bundle ${BETA_BUNDLE} --module entry \\
    --hap tablet/DSHM-${APP_VERSION}-beta-entry-debug.hap \\
    --hsp tablet/DSHM-${APP_VERSION}-beta-hostruntime-debug.hsp

  # tablet / PC / 2in1 / Edge share the same entry HAP
  # phone: use --module phone plus the two files under phone/
`, 'utf8');
  if (SIDELOAD_ONLY) {
    const zipName = `${basename(outDir)}.zip`;
    const zip = spawnSync('zip', ['-qr', zipName, basename(outDir)], {
      cwd: dirname(outDir),
      encoding: 'utf8',
    });
    if (zip.status !== 0) {
      throw new Error(`侧载 ZIP 打包失败：${zip.stderr || zip.stdout}`);
    }
    console.log(`ZIP: ${join(dirname(outDir), zipName)}`);
  }
  /*
   * 【2026-10-29 加：产物必须晚于源码（docs/282 §9-6 / 283 §5-4）】
   * 真机踩过：17:06:50 改的源码，被测的是 17:02:58 出的包 ⇒ 整轮验收结论作废。
   * 构建刚跑完，正常来说产物一定是最新的；这里只做**事后自证**并打印两侧 mtime，
   * 让人一眼看到"这个包对应哪份源码"。若发现产物比源码旧（例如产物目录被复用），
   * 直接判失败而不是让人带着错误结论去装机。
   */
  const SOURCE_FILES = [
    'entry/src/main/ets/pages/WebApp.ets',
    'phone/src/main/ets/pages/WebApp.ets',
    'hostruntime/src/main/cpp/dshhost.cc',
    'platform/src/main/ets/ui/ImmersiveMaterialKit.ets',
    'entry/src/main/ets/entryability/EntryAbility.ets',
  ];
  const appFile = readdirSync(outDir).filter((f) => f.endsWith('.app'))[0];
  if (appFile !== undefined) {
    const appMtime = statSync(join(outDir, appFile)).mtimeMs;
    for (const rel of SOURCE_FILES) {
      const p = join(ROOT, rel);
      if (!existsSync(p)) { continue; }
      const srcMtime = statSync(p).mtimeMs;
      if (srcMtime > appMtime) {
        console.error(`\n❌ 产物比源码旧：${rel}（${new Date(srcMtime).toISOString()}）`
          + ` > ${appFile}（${new Date(appMtime).toISOString()}）`);
        console.error('   本次包不含该文件的改动 —— 不要把它的结论当真机结论。');
        process.exitCode = 4;
      }
    }
    console.log(`   产物时间戳: ${new Date(appMtime).toISOString()}（已核对晚于 ${SOURCE_FILES.length} 个关键源码文件）`);
  }
  console.log(`\nBETA OK: ${outDir}`);
} finally {
  restoreAll();
}
