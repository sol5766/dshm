#!/usr/bin/env node
/**
 * 门禁：浏览器「任务结束自动关闭」的接线（2026-10-17，用户口径："主动拉起浏览器执行完任务后
 * 浏览器就一直在前台，可以在任务结束后自动关闭，包括预约的定时任务也是一样"）。
 *
 * 【判什么】
 *   ① Host（`hostcore/app/main.js`）：
 *      · `/dshm-open-link` **成功拉起**后才调用 `onLaunched`（只关"为本次任务开的"浏览器）；
 *      · boot 链把 `armAutoClose` 交给外开桥端点；
 *      · 全局订阅 `session/event`（`{ global: true }`）+ 只认 `turn/end`（定时任务的回合同样落这个事件）；
 *      · `turn/end` 时调用扩展的 `close`；两小时未等到只**解除武装**（不强行关）；
 *      · `DSHM_BROWSER_AUTOCLOSE=off` 可整体关闭。
 *   ② 扩展（`hostcore/browser-extension/background.js`）：
 *      · 工具面含 `close`；
 *      · 多标签页窗口只删 `sessionTabId` 那一个标签页；
 *      · **单标签页窗口只最小化**（2026-10-17 真机事故：删最后一页 ⇒ 海泰 EntryAbility
 *        "terminate timeout" 卡死、窗口句柄 -1、浏览器再也打不开；绝不 `windows.remove`）。
 *
 * 【对照臂】10 个内存变异（摘订阅 / 改事件名 / 摘 tabs.remove / 删最小化守卫 / 取消武装 /
 * 把 windows.remove 加回来 / 最小化不确认 / click 内错误报成功 / 手机也注册工具 /
 * Host 不限 PC）都必须判红，
 * 否则门禁是恒真摆设。
 */
import { readFileSync } from 'node:fs';

const HOST_FILE = 'hostcore/app/main.js';
const EXT_FILE = 'hostcore/browser-extension/background.js';
const PLUGIN_FILE = 'hostcore/plugins/dshm-tool-browser/lib/index.js';

function inspect(files) {
  const notes = [];
  let pass = 0;
  let fail = 0;
  const ok = (cond, msg) => {
    if (cond) { pass++; notes.push('  PASS  ' + msg); } else { fail++; notes.push('  FAIL  ' + msg); }
  };
  const host = files.host;
  const ext = files.ext;
  const plugin = files.plugin;

  // ── Host ──
  ok(host.includes("path: '/dshm-open-link'"), 'Host：外开端点仍在');
  ok(host.includes('onLaunched({ url: target, id });'), 'Host：只有拉起成功才回调 onLaunched（武装自动关闭）');
  ok(host.includes('result.ok === true && typeof onLaunched === \'function\''),
    'Host：onLaunched 的触发条件 = result.ok === true');
  ok(host.includes('registerOpenLinkEndpoint(ctx, browserBridge && browserBridge.armAutoClose);'),
    'Host：boot 链把 armAutoClose 交给外开桥');
  ok(host.includes("void closeLaunchedBrowser('turn-end turn=' + turn);"),
    'Host：自动关闭的 session/event 监听真的接上（判据打在监听体内的调用行，不是通用订阅字样）');
  ok(host.includes('{ global: true }'),
    'Host：订阅带 { global: true }（否则 session 作用域的 filter 会把根上下文排除）');
  ok(host.includes("event.type !== 'turn/end'"), 'Host：只认 turn/end');
  ok(host.includes("invokeOnClient(null, 'close'"), 'Host：turn/end 时调用扩展 close');
  ok(host.includes("DSHM_BROWSER_AUTOCLOSE"), 'Host：提供 DSHM_BROWSER_AUTOCLOSE 开关');
  ok(host.includes("disarmAutoClose('deadline") && !host.includes("closeLaunchedBrowser('deadline')"),
    'Host：deadline 只解除武装，不强行关闭');
  ok(host.includes('function browserAutomationEnabled(env = process.env)') &&
    host.includes("String(env.DSHM_DEVICE_FORM || '').trim().toLowerCase() === 'desktop'") &&
    host.includes('browserAutomationEnabled() ? registerBrowserBridge(ctx) : null'),
    'Host：浏览器桥只对 DSHM_DEVICE_FORM=desktop 注册（PC / 2in1）');

  // ── Extension ──
  ok(ext.includes("{ name: 'close', description:"), '扩展：工具面含 close');
  ok(ext.includes('async function closeSessionBrowser()'), '扩展：close 实现存在');
  ok(ext.includes('const tabId = sessionTabId;'), '扩展：只关 sessionTabId（DSHM 用过的那一个标签页）');
  ok(ext.includes('chrome.tabs.remove(tabId)'), '扩展：多标签页窗口只删 sessionTabId 那一页');
  ok(!ext.includes('chrome.windows.remove(winId)'),
    '扩展：绝不 windows.remove（真机 2026-10-17：删最后一页后海泰 terminate timeout 卡死）');
  ok(ext.includes('if (tabCount <= 1) {'), '扩展：单标签窗口走最小化分支');
  ok(ext.includes("chrome.windows.update(winId, { state: 'minimized' })"),
    '扩展：单标签窗口只最小化（离开前台但不触发终止）');
  ok(ext.includes('async function waitWindowMinimized(windowId, timeoutMs)') &&
    ext.includes('await waitWindowMinimized(winId, 3000)'),
    '扩展：最小化后轮询 windows.get 确认，不把"调用没抛错"当成功');
  ok(ext.includes("error: 'minimize not effective (single-tab window)'"),
    '扩展：最小化未生效时如实失败');
  ok(ext.includes("via: 'minimize-single-tab'"), '扩展：如实返回最小化语义');
  ok(ext.includes('waitTabGone(tabId'), '扩展：关闭后轮询确认（不假装成功）');
  ok((ext.match(/slice\(0, 20000\)/g) || []).length >= 2,
    '扩展：get_text 的 script / CDP 两条路都保留 20k（不再只留 4k）');
  ok(plugin.includes('function assertInnerOk(tool, result)') &&
    plugin.includes("assertInnerOk('browser_click', result)") &&
    plugin.includes("assertInnerOk('browser_type', result)"),
    '插件：click/type 的扩展内失败不再包装成成功');
  ok(plugin.includes("assertInnerOk('browser_tab_select', result)") &&
    plugin.includes('browser_tab_select：标签页没有成功切到前台'),
    '插件：切标签页未激活时如实失败');
  ok(plugin.includes('export function browserToolsEnabled(env = process.env)') &&
    plugin.includes("String(env.DSHM_DEVICE_FORM || '').trim().toLowerCase() === 'desktop'") &&
    plugin.includes('if (!browserToolsEnabled())') &&
    plugin.indexOf('if (!browserToolsEnabled())') < plugin.indexOf('ctx.tools.register('),
    '插件：手机 / 平板不注册 browser_*（只开放 PC / 2in1）');

  return { pass, fail, notes };
}

const files = {
  host: readFileSync(HOST_FILE, 'utf8'),
  ext: readFileSync(EXT_FILE, 'utf8'),
  plugin: readFileSync(PLUGIN_FILE, 'utf8'),
};

console.log('== 主体：任务结束自动关闭浏览器 ==');
const main = inspect(files);
for (const line of main.notes) console.log(line);
console.log(`  小计：${main.pass} passed / ${main.fail} failed`);

let failed = main.fail > 0;

const arms = [
  {
    name: 'A：摘掉 session/event 订阅（永远不会触发关闭）',
    files: {
      ...files,
      host: files.host.replace("void closeLaunchedBrowser('turn-end turn=' + turn);", '/* removed */'),
    },
  },
  {
    name: "B：把 turn/end 改成 turn/start（一开始任务就关）",
    files: { ...files, host: files.host.replace("event.type !== 'turn/end'", "event.type !== 'turn/start'") },
  },
  {
    name: 'C：摘掉 tabs.remove（只剩整窗兜底）',
    files: { ...files, ext: files.ext.replace('chrome.tabs.remove(tabId)', 'void 0') },
  },
  {
    name: 'D：删掉单标签最小化守卫（重新走删最后一页 ⇒ 会卡死海泰）',
    files: { ...files, ext: files.ext.replace('if (tabCount <= 1) {', 'if (false) {') },
  },
  {
    name: 'E：外开成功后不再武装（用户口径的"自动关闭"整体失效）',
    files: { ...files, host: files.host.replace('onLaunched({ url: target, id });', '/* unarmed */') },
  },
  {
    name: 'F：把 windows.remove 加回来（会再次触发海泰 terminate 卡死）',
    files: {
      ...files,
      ext: files.ext.replace(
        "return { ok: true, via: 'minimize-single-tab', windowId: winId };",
        "try { chrome.windows.remove(winId); } catch (e) { /* ignore */ }\n    return { ok: true, via: 'minimize-single-tab', windowId: winId };",
      ),
    },
  },
  {
    name: 'G：最小化后不再回读确认（恢复"调用即成功"的假绿）',
    files: {
      ...files,
      ext: files.ext.replace('await waitWindowMinimized(winId, 3000)', 'true'),
    },
  },
  {
    name: 'H：click 扩展内失败不再抛错（工具层误报成功）',
    files: {
      ...files,
      plugin: files.plugin.replace("assertInnerOk('browser_click', result);", ''),
    },
  },
  {
    name: 'I：手机 / 平板也注册 browser_*（回到必然失败的工具面）',
    files: {
      ...files,
      plugin: files.plugin.replace('if (!browserToolsEnabled()) {', 'if (false) {'),
    },
  },
  {
    name: 'J：Host 不再限制 PC 形态（移动端也开浏览器桥）',
    files: {
      ...files,
      host: files.host.replace("String(env.DSHM_DEVICE_FORM || '').trim().toLowerCase() === 'desktop'", 'true'),
    },
  },
];

for (const arm of arms) {
  const mutated = inspect(arm.files);
  const red = mutated.fail > 0;
  console.log(`\n== 对照臂 ${arm.name} ==`);
  console.log(`  变异体：${mutated.pass} passed / ${mutated.fail} failed（期望 failed > 0）`);
  if (!red) {
    console.log('  FAIL  变异体竟然全绿 => 判据是恒真摆设，必须修');
    failed = true;
  } else {
    console.log('  PASS  变异体如期变红 => 判据有牙');
  }
}

console.log('\nRESULT: ' + (failed ? 'FAIL' : 'PASS')
  + ` —— 主体 ${main.pass}/${main.fail}，对照臂 ${arms.length} 组`);
process.exit(failed ? 1 : 0);
