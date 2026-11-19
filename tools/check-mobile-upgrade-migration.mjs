#!/usr/bin/env node
/**
 * ⚠️ 历史门禁（2026-11-06）：仅覆盖 1.1.4→1.1.6 升级，beta 基线目录已不存在，
 * 核心判据为死分支；不再作为当前 1.1.8 权限面的判据。
 * 1.1.4 -> 1.1.6 手机升级门禁。
 *
 * 两道门都对应真机已出现的事故：
 *   1. HAP 从 entry 改名为 phone 后，filesDir 换了，旧 dsh/home / workspace 没迁移；
 *      回退 1.1.4 又读回旧目录，所以表现为"升级丢数据、回退恢复"。
 *   2. 旧核心树缺少 node-addon-system 平台占位，或构建漏编
 *      libsystem.so；会话首轮直接报 shared library 不存在。新版本
 *      强制换树，并在 CoreStore 解包校验中把平台占位列为哨兵。
 *
 * 静态判据之外，若工作区里存在 `.app`，本门禁会直接检查其中 HSP 的 libs，
 * 防止"源码修了但交付包还是旧 HSP"。
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const MIGRATION = join(ROOT, 'phone/src/main/ets/system/LegacyStorageMigration.ets');
const ABILITY = join(ROOT, 'phone/src/main/ets/entryability/EntryAbility.ets');
const CMAKE = join(ROOT, 'hostruntime/src/main/cpp/CMakeLists.txt');
const VENDOR = join(ROOT, 'hostruntime/src/main/cpp/vendor/node-addon-system');
/**
 * 列出 zip 条目（不依赖 `unzip -Z1`）。
 *
 * 【2026-10-31 审核修】本机（以及设备上的 busybox）`unzip` **不支持 `-Z1`**，
 * 直接调用会打印 usage 并失败 ⇒ 本门禁曾因此恒 FAIL。
 * 优先用 python3 的 `zipfile`（沙箱内已有），拿不到再退回 `unzip -Z1`。
 */
function listZipEntries(zipPath) {
  const py = process.env.DSHM_PYTHON3 || '/data/storage/el2/base/haps/entry/files/bin/python3';
  try {
    const out = execFileSync(py, ['-c',
      'import sys,zipfile;print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', zipPath,
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split(/\r?\n/).filter(Boolean);
  } catch (e) {
    return execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split(/\r?\n/).filter(Boolean);
  }
}

const APP_ROOT = join(ROOT, 'dist/release-test');
const INSTALLER = join(ROOT, 'tools/update-device.mjs');
const STAGER = join(ROOT, 'tools/stage-sideload.mjs');
const BETA_BUILDER = join(ROOT, 'tools/build-beta.mjs');
/*
 * 【2026-10-31 审核修】`app.json5` 是 **JSON5**（带注释），直接 `JSON.parse` 必抛
 * `Expected double-quoted property name`。本门禁因此**从写下的那天起就一直跑不起来**
 * （不在 CI 里，所以没人发现）。改用与 `check-auth-return.mjs` 同一套去注释实现。
 */
function parseJson5(text) {
  return JSON.parse(text
    .replace(/^\uFEFF/, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1'));
}
const APP_SCOPE = parseJson5(readFileSync(join(ROOT, 'AppScope/app.json5'), 'utf8'));
const EXPECTED_VERSION_NAME = String(APP_SCOPE.app?.versionName ?? '');
const EXPECTED_VERSION_CODE = String(APP_SCOPE.app?.versionCode ?? '');
const BETA_PROFILE = join(
  ROOT,
  '.certs/beta-20261024/DSHM-beta-1.1.6-1010007-debug.p7b',
);
const BETA_ROOT = join(ROOT, 'dist/beta/DSHM-beta-1.1.6-1010007-core93-app-r2');
const BETA_PHONE = join(BETA_ROOT, 'phone/DSHM-1.1.6-beta-phone-debug.hap');
const BETA_ENTRY = join(BETA_ROOT, 'pc/DSHM-1.1.6-beta-pc-debug.hap');
const ALLOW_EXISTING_BETA_UPGRADE = process.argv.includes('--existing-beta-upgrade')
  || process.env.DSHM_BETA_EXISTING_UPGRADE === '1';

const failures = [];
const passes = [];
const check = (ok, message) => {
  if (ok) passes.push(message);
  else failures.push(message);
};
const mustContain = (text, needle, label) => check(text.includes(needle), label);
const mustNotContain = (text, needle, label) => check(!text.includes(needle), label);

const migration = readFileSync(MIGRATION, 'utf8');
const ability = readFileSync(ABILITY, 'utf8');
const cmake = readFileSync(CMAKE, 'utf8');
const flock = readFileSync(join(VENDOR, 'flock.c'), 'utf8');
const installer = readFileSync(INSTALLER, 'utf8');
const stager = readFileSync(STAGER, 'utf8');
const betaBuilder = readFileSync(BETA_BUILDER, 'utf8');

mustContain(migration, "const LEGACY_SUFFIX: string = '/haps/entry/files';",
  '迁移源固定为 1.1.4 的 haps/entry/files');
mustContain(migration, "const CURRENT_SUFFIX: string = '/haps/phone/files';",
  '迁移目标固定为 1.1.6 的 haps/phone/files');
mustContain(migration, "const entries: string[] = ['dsh/home', 'workspace'];",
  '只迁移 dsh/home（会话/插件/注册）与 workspace（沙箱工作区文件）');
mustContain(migration, "if (fs.accessSync(to))", '目标已有文件时不覆盖');
mustContain(migration, 'stats.skippedExisting += 1;', '跳过已存在文件并记账');
mustContain(migration, 'await fs.copyFile(from, to);', '迁移动作是复制');
mustContain(migration, 'if (stats.failures.length === 0)', '仅在完整成功后写 marker');
mustContain(migration, "'host-ready.json'", '不迁移旧 host-ready（旧 PID/token）');
mustContain(migration, "'host-exit-mode'", '不迁移旧 host-exit-mode（避免误重启）');
mustContain(migration, "'host-stop-request'", '不迁移旧 host-stop-request（避免新进程退出）');

for (const forbidden of ['unlinkSync(', 'rmdirSync(']) {
  mustNotContain(migration, forbidden, `迁移模块不得调用 ${forbidden}（旧数据只读保留）`);
}
mustContain(migration, 'fs.renameSync(tmpPath, markerPath);',
  '迁移完成标记先写临时文件再 rename，避免半截 marker 导致永久跳过');

const migrateCall = ability.indexOf('ensureLegacyEntryStorageMigration(this.context.filesDir)');
const firstFilesDirWrite = ability.indexOf('this.applyWebMemoryProfile();');
check(migrateCall >= 0 && firstFilesDirWrite >= 0 && migrateCall < firstFilesDirWrite,
  'onCreate 中迁移启动早于任何 filesDir 诊断/业务写入');
const hostGate = ability.indexOf('await this.legacyMigrationReady');
const grantGate = ability.indexOf('await this.folderGrantsReady', hostGate);
check(hostGate >= 0 && grantGate > hostGate,
  'Host 启动链先等待数据迁移，再等待目录授权恢复');

mustContain(cmake, 'vendor/node-addon-system/flock.c',
  'HSP 使用仓库内固定版本的 flock 源');
mustNotContain(cmake, 'file(GLOB DSHM_CORE_SYSTEM_DIRS', 'HSP 不再依赖 dist/core/work 的 glob');
mustNotContain(cmake, 'dist/core/work/__missing__', '不再以 __missing__ 路径静默降级');
mustContain(cmake, 'add_library(system MODULE ${SYSTEM_ADDON_SRC})',
  'CMake 明确构建 system 模块 → libsystem.so');
check((cmake.match(/message\(FATAL_ERROR/g) ?? []).length >= 2,
  '源或 libnode 缺失时构建立即失败');
mustContain(flock, 'NAPI_MODULE_INIT()', 'vendored flock 是完整 Node-API 模块');
mustContain(flock, 'napi_queue_async_work', 'vendored flock 保留异步锁实现');
check(existsSync(join(VENDOR, 'LICENSE')), 'vendored flock 带 BSD-3-Clause 许可证');

mustContain(installer, "const installArgs = ['install', '-r', '-p', OPT.hap, OPT.hsp]",
  '真机安装器一次只提交一个 entry HAP + shared HSP');
mustContain(installer, 'haps/${moduleName}/files', '数据保全读数按实际 entry/phone 模块取 filesDir');
mustContain(installer, '拒绝把 .app 交给本地安装器', '.app 不再被误当成本地安装输入');
mustContain(installer, "if (/phone/.test(rawType)) return 'phone'", '安装器按设备形态选择 phone entry');
mustContain(stager, "dir: 'tablet'", '侧载拆分含平板 / PC / Edge 目录（同一 entry HAP）');
mustContain(stager, "dir: 'tablet'", '侧载拆分含平板目录');
mustContain(stager, "dir: 'phone'", '侧载拆分含手机目录');
mustContain(stager, "haps.length !== 1", '每个侧载目录复核恰好一个 entry HAP');
mustContain(stager, "app.buildMode !== OPT.buildMode", '侧载复核 HAP buildMode，防止 release 目录混入 debug 件');
mustContain(stager, "String(appVersion?.code) !== versionCode", '侧载复核 APP 的 versionCode 与 AppScope');
mustContain(stager, "if (OPT.checkOnly)", '侧载提供不改文件的构建产物预检模式');
mustContain(stager, "!hspList.stdout.split(/\\r?\\n/).includes('libs/arm64-v8a/libsystem.so')",
  '侧载前直接检查 HSP 里的 libsystem.so');
mustContain(stager, 'Do NOT pass the .app or a combined directory',
  '侧载 README 明确禁止把 .app/组合目录交给本地安装器');

mustContain(betaBuilder, "const BETA_BUNDLE = 'com.dshm.dshmbeta'", 'beta 构建固定使用独立包名');
mustContain(betaBuilder, '} finally {\n  restoreAll();', 'beta 构建无论成败都恢复正式包名/签名/权限面');
mustContain(betaBuilder, "flag('--sideload-only')", 'beta 构建提供只产出单 entry 侧载目录的模式');
mustContain(betaBuilder, "flag('--existing-beta-upgrade')", '既有 beta 覆盖升级必须显式开关');
mustNotContain(betaBuilder, 'blankPermissionObject', 'beta debug 侧载不裁剪任何权限声明');
check(readFileSync(join(ROOT, 'AppScope/app.json5'), 'utf8').includes('"bundleName": "com.dshm.dshclient"'),
  'beta 构建结束后源码已恢复正式 bundleName');
check(!readFileSync(join(ROOT, 'build-profile.json5'), 'utf8').includes('com.dshm.dshmbeta'),
  'beta 构建结束后 build-profile 不含 beta 包名');

const hasBetaArtifact = existsSync(BETA_ROOT)
  || existsSync(BETA_PHONE)
  || existsSync(BETA_ENTRY);
if (existsSync(BETA_PROFILE) && hasBetaArtifact) {
  const profileText = readFileSync(BETA_PROFILE, 'latin1');
  const aclBlock = profileText.match(/"allowed-acls":\[(.*?)\]/)?.[1] ?? '';
  const acls = [...aclBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  const expectedAcls = [
    'ohos.permission.ALLOW_EXTERNAL_NATIVE_CODE',
    'ohos.permission.CUSTOM_SANDBOX',
    'ohos.permission.FILE_ACCESS_PERSIST',
    'ohos.permission.READ_PASTEBOARD',
    'ohos.permission.READ_WRITE_DESKTOP_DIRECTORY',
    'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY',
    'ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY',
  ].sort();
  check(profileText.includes('"bundle-name":"com.dshm.dshmbeta"')
    && profileText.includes('"app-identifier":"6917619917870725140"')
    && profileText.includes('"type":"debug"'),
  'beta debug Profile 身份为 com.dshm.dshmbeta / 6917619917870725140 / debug');
  if (ALLOW_EXISTING_BETA_UPGRADE && acls.length === 0) {
    passes.push('既有 beta 覆盖升级模式：保留空 ACL Profile，但仅允许已授权设备使用');
  } else {
    check(JSON.stringify(acls) === JSON.stringify(expectedAcls),
      `beta debug Profile 覆盖完整 7 条 ACL（实际 ${JSON.stringify(acls)}）`);
  }
} else if (existsSync(BETA_PROFILE)) {
  passes.push('无 beta 构建产物：beta Profile 不参与当前正式 release 校验');
}

if (existsSync(BETA_PHONE)) {
  const betaModule = JSON.parse(execFileSync('unzip', ['-p', BETA_PHONE, 'module.json'], { encoding: 'utf8' }));
  const betaApp = betaModule.app ?? {};
  const betaPhone = betaModule.module ?? {};
  const betaPerms = (betaPhone.requestPermissions ?? []).map((p) => p.name);
  check(betaApp.bundleName === 'com.dshm.dshmbeta' && betaApp.versionCode === 1010007,
    'beta HAP 身份为 com.dshm.dshmbeta / 1010007');
  check(betaPhone.name === 'phone' && betaPhone.type === 'entry'
    && JSON.stringify(betaPhone.deviceTypes) === JSON.stringify(['phone']),
  'beta HAP 只含 phone entry');
  check(betaPerms.length === 9 && betaPerms.includes('ohos.permission.READ_PASTEBOARD')
    && betaPerms.includes('ohos.permission.FILE_ACCESS_PERSIST')
    && betaPerms.includes('ohos.permission.SET_NETWORK_INFO'),
  'beta 手机 HAP 保留完整 9 条权限面');
}
if (existsSync(BETA_ENTRY)) {
  const entryModule = JSON.parse(execFileSync('unzip', ['-p', BETA_ENTRY, 'module.json'], { encoding: 'utf8' }));
  const entryPerms = (entryModule.module?.requestPermissions ?? []).map((p) => p.name);
  check(entryModule.app?.bundleName === 'com.dshm.dshmbeta'
    && String(entryModule.app?.versionCode) === '1010007'
    && entryPerms.length === 17
    && entryPerms.includes('ohos.permission.SET_NETWORK_INFO'),
  'beta 桌面/平板 HAP 保留完整 17 条权限面');
}
for (const hap of [BETA_PHONE, BETA_ENTRY]) {
  if (!existsSync(hap)) continue;
  const resources = execFileSync('unzip', ['-p', hap, 'resources.index'], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  check(resources.includes(Buffer.from('DSHM Beta', 'utf8')),
    `${hap.includes('phone') ? 'phone' : 'entry'} beta HAP 可见名称为 DSHM Beta`);
}
function newestApp() {
  const candidates = [
    join(ROOT, 'build/outputs/default'),
    join(ROOT, 'build/outputs/release'),
    APP_ROOT,
  ];
  const apps = candidates.flatMap((dir) => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.app'))
      .map((name) => join(dir, name));
  }).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return apps[0] ?? '';
}

const app = newestApp();
if (app.length > 0) {
  const tmp = mkdtempSync(join(tmpdir(), 'dshm-upgrade-gate-'));
  const hsp = join(tmp, 'hostruntime.hsp');
  const coreZip = join(tmp, 'core.zip');
  try {
    const pack = JSON.parse(execFileSync('unzip', ['-p', app, 'pack.info'], { encoding: 'utf8' }));
    const version = pack.summary?.app?.version;
    check(version?.name === EXPECTED_VERSION_NAME
      && String(version?.code) === EXPECTED_VERSION_CODE,
    `最新交付版本是 ${EXPECTED_VERSION_NAME} / ${EXPECTED_VERSION_CODE}（实际 ${version?.name}/${version?.code}）`);
    const hspBytes = execFileSync('unzip', ['-p', app, 'hostruntime-default.hsp'], {
      encoding: 'buffer',
      maxBuffer: 600 * 1024 * 1024,
    });
    const entryBytes = execFileSync('unzip', ['-p', app, 'entry-default.hap'], {
      encoding: 'buffer',
      maxBuffer: 160 * 1024 * 1024,
    });
    const entryHap = join(tmp, 'entry.hap');
    writeFileSync(entryHap, entryBytes);
    writeFileSync(hsp, hspBytes);
    const entries = listZipEntries(hsp);
    check(entries.includes('libs/arm64-v8a/libsystem.so'),
      `最新交付包含 HSP libsystem.so：${app.slice(ROOT.length + 1)}`);
    const entryEntries = listZipEntries(entryHap);
    check(entries.includes('libs/arm64-v8a/libpython3.12.so.1.0')
      && !entryEntries.includes('libs/arm64-v8a/libpython3.12.so.1.0'),
    'libpython 只随共享 HSP 一份，PC/平板 entry HAP 不再重复携带');
    /*
     * 插件安装命令必须按最终 HSP 里的真实字节验证，不能只看源码。
     * 1.1.6 的有效入口是 `dsh plugin --profile <p> add <spec>`；这里直接执行包内
     * 解析器，并同时确认 main.js 真的用解析结果调用 installSpec。
     */
    const packagedCommandParser = execFileSync('unzip', [
      '-p', hsp, 'resources/resfile/resources/app/dshm-install-command.js',
    ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const sourceCommandParser = readFileSync(
      join(ROOT, 'hostcore/app/dshm-install-command.js'), 'utf8');
    const packagedModule = { exports: {} };
    new Function('module', 'exports', packagedCommandParser)(
      packagedModule, packagedModule.exports);
    const parsedOfficial = packagedModule.exports.parseInstallCommand(
      'dsh plugin --profile ondevice add @scope/plugin@1.2.3 --save-exact');
    const packagedMain = execFileSync('unzip', [
      '-p', hsp, 'resources/resfile/resources/app/main.js',
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    check(packagedCommandParser === sourceCommandParser
      && parsedOfficial.ok === true
      && parsedOfficial.spec === '@scope/plugin@1.2.3'
      && parsedOfficial.profile === 'ondevice'
      && parsedOfficial.saveExact === true
      && packagedMain.includes("require('./dshm-install-command.js')")
      && packagedMain.includes('pluginInstaller.installSpec(installSpec, instOpts)'),
    '最终 HSP 内的官方插件安装命令解析与安装调用完整');
    const coreNames = entries.filter((name) =>
      /^resources\/resfile\/dsh-core-.+-openharmony-arm64\.zip$/.test(name));
    check(coreNames.length === 1,
      `最新交付 HSP 只携带一个核心容器（实际 ${coreNames.length}）`);
    if (coreNames.length === 1) {
      const coreName = coreNames[0];
      const coreVersion = coreName
        .replace(/^resources\/resfile\/dsh-core-/, '')
        .replace(/-openharmony-arm64\.zip$/, '');
      const coreBytes = execFileSync('unzip', ['-p', hsp, coreName], {
        encoding: 'buffer',
        maxBuffer: 160 * 1024 * 1024,
      });
      writeFileSync(coreZip, coreBytes);
      const coreEntries = listZipEntries(coreZip);
      const addonRoot = `dsh-core-${coreVersion}/node_modules/`
        + '@deepseek-ai/node-addon-system-linux-arm64';
      check(coreEntries.includes(`${addonRoot}/package.json`)
        && coreEntries.includes(`${addonRoot}/bin/musl/system.node`),
      `最新 ${coreVersion} 核心包含 node-addon-system 平台占位`);
    }
    const sumsPath = join(APP_ROOT, 'SHA256SUMS.txt');
    if (app.startsWith(APP_ROOT) && existsSync(sumsPath)) {
      const base = app.slice(APP_ROOT.length + 1);
      const expected = readFileSync(sumsPath, 'utf8').split(/\r?\n/)
        .map((line) => line.match(/^([0-9a-f]{64})\s+(.+)$/))
        .find((m) => m && m[2] === base)?.[1] ?? '';
      const actual = createHash('sha256').update(readFileSync(app)).digest('hex');
      check(expected !== '' && expected === actual,
        `release-test SHA256SUMS 与最新 APP 一致（${base}）`);
    }
  } catch (error) {
    failures.push(`无法检查最新交付包 ${app}：${error.message}`);
  } finally {
    try { chmodSync(tmp, 0o700); } catch {}
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
} else {
  passes.push('工作区无 .app 交付包：仅跑源码接线判据');
}

console.log('# 门禁：1.1.4 -> 1.1.6 数据迁移与会话 flock 原生件');
for (const p of passes) console.log(`  OK  ${p}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  console.log(`RESULT: FAIL (${failures.length})`);
  process.exit(1);
}
console.log(`RESULT: PASS (${passes.length})`);
