#!/usr/bin/env node
/**
 * DSHM PC / 2in1 环境能力体检（只读）。
 *
 * 目的：在 DevEco Studio 终端中不依赖 PowerShell，直接回答：
 *   · 本机工具链是否齐全；
 *   · 设备、系统与当前安装包身份；
 *   · 11 条权限的设备授予状态；
 *   · 最近一次 Host 启动是否真的有 Node / Python / exec / 终端能力；
 *   · PC 工程是否仍残留移动端 VM 插件、资源或 QEMU 库。
 *
 * 不安装、不卸载、不启动应用、不改设备数据。
 *
 * 用法：
 *   node tools/doctor.mjs
 *   node tools/doctor.mjs --target 127.0.0.1:45595
 */
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveHdc, listTargets, runHdc } from './lib/hdc-client.mjs';
import { resolveDevecoRoot } from './lib/deveco-home.mjs';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const targetArg = args.indexOf('--target');
const requestedTarget = targetArg >= 0 ? (args[targetArg + 1] ?? '') : '';

function out(kind, label, value = '') {
  const tag = {
    ok: '[ OK ]',
    warn: '[WARN]',
    miss: '[MISS]',
    info: '[INFO]',
  }[kind] ?? '[INFO]';
  console.log(`${tag} ${label}${value ? `: ${value}` : ''}`);
}

function readText(path, fallback = '') {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return fallback;
  }
}

function findOnPath(name) {
  for (const dir of String(process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return '';
}

function commandVersion(command, versionArgs) {
  const r = spawnSync(command, versionArgs, { encoding: 'utf8', timeout: 5000 });
  return String(r.stdout || r.stderr || '').split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
}

function bundleName() {
  const text = readText(join(ROOT, 'AppScope', 'app.json5'));
  return text.match(/"bundleName"\s*:\s*"([^"]+)"/)?.[1] ?? '';
}

function parseBm(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

function stateName(state) {
  if (state === 0) return 'granted';
  if (state === -1) return 'not granted / pending user';
  return `unknown(${state})`;
}

console.log('DSHM DevEco 终端环境体检（只读）\n');

const node = process.execPath;
const deveco = resolveDevecoRoot();
const hvigor = findOnPath('hvigorw')
  || (deveco ? [
    join(deveco, 'hvigor', 'bin', 'hvigorw.js'),
    join(deveco, 'Contents', 'tools', 'hvigor', 'bin', 'hvigorw'),
  ].find((path) => existsSync(path)) ?? '' : '');
const ohpm = findOnPath('ohpm');
const hdc = resolveHdc();
const javaHome = String(process.env.JAVA_HOME ?? '');
const javaBin = join(javaHome, 'bin', 'java');
const javaOk = Boolean(javaHome) && existsSync(javaBin);

out('ok', 'Node', `${process.version} (${node})`);
out(hvigor ? 'ok' : 'miss', 'hvigorw', hvigor || 'not found');
out(ohpm ? 'ok' : 'info', 'ohpm', ohpm || 'not present in this CLT layout (build does not require it)');
out(hdc ? 'ok' : 'miss', 'hdc', hdc || 'not found');
out(deveco ? 'ok' : 'miss', 'DevEco root', deveco || 'not found');
out(javaOk ? 'ok' : 'miss', 'JAVA_HOME', javaOk ? `${javaHome} (${commandVersion(javaBin, ['-version']) || 'java available'})` : (javaHome || 'unset'));

if (String(process.env.DEVECO_CLI_CLT_PATH ?? '') !== '') {
  out('ok', 'DEVECO_CLI_CLT_PATH', process.env.DEVECO_CLI_CLT_PATH);
} else {
  out('warn', 'DEVECO_CLI_CLT_PATH', deveco
    ? `unset; auto-discovery works (${deveco})`
    : 'unset and auto-discovery failed');
}

const pwsh = findOnPath('pwsh');
out('info', 'PowerShell', pwsh
  ? pwsh
  : 'not installed; Node tools are the supported HarmonyOS PC path');

if (!hdc) {
  out('miss', '结论', '找不到 hdc，无法继续检查设备');
  process.exit(3);
}

const targets = listTargets(hdc);
if (targets.length === 0) {
  out('miss', '设备', 'hdc list targets = [Empty]');
  process.exit(3);
}
const target = requestedTarget || (targets.length === 1 ? targets[0] : '');
if (!target) {
  out('warn', '设备', `online=${targets.join(', ')}；请用 --target 指定一台`);
  process.exit(3);
}
if (!targets.includes(target)) {
  out('miss', '设备', `${target} 不在线；当前 ${targets.join(', ')}`);
  process.exit(3);
}

function hdcShell(command) {
  const r = runHdc(hdc, target, ['shell', command]);
  return `${r.stdout || ''}${r.stderr || ''}`;
}

out('ok', '设备连接', target);
for (const [label, param] of [
  ['产品型号', 'const.product.model'],
  ['设备形态', 'const.product.devicetype'],
  ['API', 'const.ohos.apiversion'],
  ['系统版本', 'const.product.software.version'],
]) {
  const value = hdcShell(`param get ${param}`).trim();
  out(value ? 'ok' : 'warn', label, value || 'unavailable');
}

const bundle = bundleName();
if (!bundle) {
  out('miss', 'Bundle', '无法从 AppScope/app.json5 解析');
  process.exit(2);
}

const dumpText = hdcShell(`bm dump -n ${bundle}`);
const dump = parseBm(dumpText);
if (!dump) {
  out('miss', '安装包', `${bundle} 未安装或 bm dump 无法解析`);
  process.exit(2);
}

const app = dump.applicationInfo ?? {};
out('ok', '安装包', `${dump.versionName} (${dump.versionCode})`);
out(app.debug === true ? 'warn' : 'ok', '构建身份', app.debug === true ? 'debug build' : 'release build');
out('info', 'App ID', dump.appIdentifier || app.appIdentifier || 'unknown');
out('info', 'Provision', app.appProvisionType || 'unknown');

const pid = hdcShell(`pidof ${bundle}`).trim();
out(pid ? 'ok' : 'warn', '进程', pid ? `running pid=${pid}` : 'not running');

console.log('\n权限状态：');
const permissions = Array.isArray(dump.reqPermissions) ? dump.reqPermissions : [];
const states = Array.isArray(dump.reqPermissionStates) ? dump.reqPermissionStates : [];
for (let i = 0; i < permissions.length; i++) {
  out(states[i] === 0 ? 'ok' : 'warn', permissions[i], stateName(states[i]));
}

const filesDir = `/data/app/el2/100/base/${bundle}/haps/entry/files`;
const runtimePattern = 'BOOT_00_NODE_START|BOOT_65_AUTH_URL|python 桥自检通过|exec 探测：|终端能力汇总'
const logs = hdcShell(`grep -E '${runtimePattern}' ${filesDir}/node-output.log 2>/dev/null | tail -n 120`);
const has = (re) => re.test(logs);
console.log('\n最近一次运行能力：');
out(has(/BOOT_00_NODE_START/) ? 'ok' : 'warn', 'Host Node 启动', has(/BOOT_00_NODE_START/) ? 'observed' : 'not found in current log');
const nodeLine = logs.match(/BOOT_00_NODE_START[^\n]*/)?.[0] ?? '';
const nodeVersion = nodeLine.match(/node=(v[0-9.]+)/)?.[1] ?? '';
const jitless = nodeLine.match(/jitless=(true|false)/)?.[1] ?? '';
if (nodeVersion) out('info', 'Host Node', `${nodeVersion}${jitless ? `, jitless=${jitless}` : ''}`);
out(has(/BOOT_65_AUTH_URL/) ? 'ok' : 'warn', 'Host ready', has(/BOOT_65_AUTH_URL/) ? 'host-ready written' : 'not found');
out(has(/python 桥自检通过/) ? 'ok' : 'warn', 'Python worker', has(/python 桥自检通过/) ? 'self-test passed' : 'not found');
const execLine = logs.match(/exec 探测：[^\n]+/)?.[0] ?? '';
const execItems = execLine.replace(/^.*exec 探测：/, '').split(/[，,]/).map((s) => s.trim()).filter(Boolean);
const execAllOk = execItems.length > 0 && execItems.every((item) => /=ok$/.test(item));
out(execAllOk ? 'ok' : 'warn', '原生 exec', execLine || 'not found');
const terminalLine = logs.match(/终端能力汇总：[^\n]+/)?.[0] ?? '';
out(terminalLine ? 'ok' : 'warn', '终端能力', terminalLine || 'not found');
const vmPaths = [
  'hostcore/plugins/dshm-vm-bash',
  'entry/src/main/resources/resfile/vm',
  'entry/libs/arm64-v8a/libqemu-system-aarch64.so',
  'third_party/vmhish',
];
const vmLeft = vmPaths.filter((rel) => existsSync(join(ROOT, rel)));
out(vmLeft.length > 0 ? 'ok' : 'warn', 'Guest VM 共享资产',
  vmLeft.length > 0
    ? `${vmLeft.join(', ')}；统一工程保留给手机/平板，PC 运行时由 DSHM_NATIVE_TERMINAL_ONLY 禁用`
    : '未找到；手机/平板的 VM 通道可能缺失');
const legacyDeviceVm = hdcShell(`du -sh ${filesDir}/vm 2>/dev/null`).trim();
out(legacyDeviceVm ? 'warn' : 'ok', '设备旧 VM 数据',
  legacyDeviceVm
    ? `${legacyDeviceVm}；位于 el2，按数据保全红线未删除`
    : 'none');

const mem = hdcShell('free -m');
const memLine = mem.split(/\r?\n/).find((line) => /^Mem:/.test(line.trim()));
out('info', '系统内存', memLine?.trim() || 'unavailable');
const critical = hdcShell(`cat ${filesDir}/diag-mem-critical 2>/dev/null`).trim();
out(critical ? 'warn' : 'ok', '内存压力标记', critical || 'none');

console.log('\n结论提示：');
console.log('  · 三端统一工程共享 VM 资产；PC 运行时只走宿主原生 exec + PTY。');
console.log('  · 手机 / 平板在共享 HSP 中使用 guest VM；PC / Edge / ProMax 走原生 PTY。DSHM-mobile 第二工作区已于 2026-11-03 删除。');
console.log('  · 没有 pwsh 不是构建阻塞；Node 已是本仓鸿蒙 PC 工具的主路径。');
console.log('  · ACCESS_USER_FULL_DISK 未获批前，不把“全盘访问”视为当前能力。');
