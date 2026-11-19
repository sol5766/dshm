#!/usr/bin/env node
/**
 * 海泰浏览器截图能力守卫。
 *
 * 2026-10-21 真机结论：
 *   · tabs.captureVisibleTab 的 Promise / callback 都会同步挂住；
 *   · Page.captureScreenshot 只允许 fromSurface=true，而 surface 调用不返回；
 *   · 继续调用会把扩展 service worker 卡死，连 navigate/get_text 一起掉线。
 *
 * 因此 screenshot 还必须从扩展能力声明中移除，并且 Host 插件默认不注册
 * `browser_screenshot`；兼容调用分支只保留 fail-fast。以后若浏览器厂商修复，
 * 必须先加真机行为证据，再一起更新本门禁。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SOURCE = join(ROOT, 'hostcore/browser-extension/background.js');
const MANIFEST = join(ROOT, 'hostcore/browser-extension/manifest.json');
const PLUGIN = join(ROOT, 'hostcore/plugins/dshm-tool-browser/lib/index.js');

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

export function inspectScreenshotBody(source) {
  const code = stripComments(source);
  const start = code.indexOf("if (tool === 'screenshot') {");
  const end = code.indexOf("if (tool === 'cdp_eval') {", start + 1);
  if (start < 0 || end < 0) return ['找不到 screenshot / cdp_eval 分支边界'];
  const body = code.slice(start, end);
  const problems = [];
  if (!body.includes('当前海泰浏览器内核不支持扩展截图')) {
    problems.push('screenshot 分支缺少明确的平台不支持提示');
  }
  if (body.includes('chrome.tabs.captureVisibleTab(')) {
    problems.push('screenshot 分支重新调用会同步挂死的 tabs.captureVisibleTab');
  }
  if (body.includes('chrome.debugger.sendCommand(')) {
    problems.push('screenshot 分支重新调用会挂死的 Page.captureScreenshot');
  }
  return problems;
}

export function inspectCapability(manifestText, extensionSource, pluginSource) {
  const problems = [];
  const code = stripComments(extensionSource);
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return ['manifest.json 不是有效 JSON'];
  }
  if (manifest.version !== '0.11.2') problems.push(`manifest.version 应为 0.11.2，实为 ${manifest.version}`);
  if (!code.includes("extensionVersion: '0.11.2'")) problems.push('extensionInfo.extensionVersion 未升到 0.11.2');
  if (!code.includes("build: 'dshm-host-bridge-13'")) problems.push('extensionInfo.build 未升到 dshm-host-bridge-13');
  const toolsStart = code.indexOf('const TOOLS = [');
  const toolsEnd = code.indexOf('];', toolsStart + 1);
  if (toolsStart < 0 || toolsEnd < 0) {
    problems.push('找不到扩展 TOOLS 清单边界');
  } else if (/name:\s*'screenshot'/.test(code.slice(toolsStart, toolsEnd))) {
    problems.push('扩展 TOOLS 仍把 screenshot 声明为可用能力');
  }
  if (!/screenshot:\s*false/.test(code)) problems.push('extensionInfo.capabilities.screenshot 必须为 false');
  if (!code.includes("screenshotReason: 'haitai-kernel-unsupported'")) {
    problems.push('extensionInfo 缺少 screenshotReason=haitai-kernel-unsupported');
  }
  if (!pluginSource.includes('export function browserScreenshotEnabled(env = process.env)')) {
    problems.push('Host 插件缺少 browserScreenshotEnabled 开关');
  }
  if (!/String\(env\.DSHM_BROWSER_SCREENSHOT[^\n]*=== 'on'/.test(pluginSource)) {
    problems.push('Host 截图开关必须只由 DSHM_BROWSER_SCREENSHOT=on 显式开启');
  }
  const condition = pluginSource.indexOf('if (browserScreenshotEnabled())');
  const register = pluginSource.indexOf("name: 'browser_screenshot'");
  if (condition < 0 || register < 0 || condition > register) {
    problems.push('browser_screenshot 注册没有被 browserScreenshotEnabled() 条件包住');
  }
  if (!pluginSource.includes("screenshot = browserScreenshotEnabled()")
    || !pluginSource.includes("'unsupported(haitai-kernel)'")) {
    problems.push('browser_status 没有报告 screenshot=unsupported(haitai-kernel)');
  }
  return problems;
}

const source = readFileSync(SOURCE, 'utf8');
const manifestText = readFileSync(MANIFEST, 'utf8');
const pluginSource = readFileSync(PLUGIN, 'utf8');
const problems = [
  ...inspectScreenshotBody(source),
  ...inspectCapability(manifestText, source, pluginSource),
];
if (process.argv.includes('--self-test')) {
  const badBody = source.replace(
    "throw new Error('当前海泰浏览器内核不支持扩展截图：'",
    "chrome.tabs.captureVisibleTab(tab.windowId); throw new Error('当前海泰浏览器内核不支持扩展截图：'"
  );
  const badTool = source.replace(
    "  { name: 'type',",
    "  { name: 'screenshot', description: 'bad', inputSchema: { type: 'object', properties: {} } },\n  { name: 'type',"
  );
  const badPlugin = pluginSource.replace('if (browserScreenshotEnabled()) {', 'if (true) {');
  const arms = [
    ['截图分支重新调用浏览器 API', inspectScreenshotBody(badBody).length > 0],
    ['扩展重新声明 screenshot', inspectCapability(manifestText, badTool, pluginSource).length > 0],
    ['Host 无条件注册 browser_screenshot', inspectCapability(manifestText, source, badPlugin).length > 0],
  ];
  const missed = arms.filter(([, red]) => !red).map(([label]) => label);
  if (missed.length > 0) {
    console.error(`SELF-TEST FAIL: 变异体没有被截图门禁识别：${missed.join(' / ')}`);
    process.exit(3);
  }
  console.log('SELF-TEST PASS');
}

if (problems.length > 0) {
  for (const p of problems) console.error('FAIL: ' + p);
  process.exit(1);
}
console.log('PASS: 扩展不再声明 screenshot，Host 默认不注册工具，兼容分支仍 fail-fast');
