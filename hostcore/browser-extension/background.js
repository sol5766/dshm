// DSHM Browser Bridge — MV3 service worker（docs/173 调研 + docs/174 PoC 的正式化）
// 连接 DSHM 宿主进程内的浏览器桥（ws://127.0.0.1:19390/browser-bridge）。
// 海泰实测约束（docs/174 §3）：禁扩展 tabs.create/update（导航一律走 CDP Page.navigate）；
// debugger 独占（与 WorkBuddy 的 Ultron 等其它调试器扩展互斥，冲突时工具会明确报错）。
const BRIDGE = 'ws://127.0.0.1:19390/browser-bridge?token=dshm-browser-beta';
let ws = null;
let retryTimer = null;

/**
 * 【为什么需要 alarms 心跳（2026-10-16 真机复现：宿主重启后扩展**静默离线**）】
 * MV3 的 service worker 空闲 ~30s 会被停；此前本 worker 里**没有任何 chrome.* 事件监听**
 * （只有 WS 回调）⇒ 一旦被停，浏览器侧再无事件能唤醒它 ⇒ 宿主（重装/重启 DSHM）再上线，
 * 也没人执行 `connect()` —— `/dshm-browser/status` 恒空，模型侧表现就是
 * "没有已连接的浏览器扩展"，而用户明明加载过扩展。
 * ⇒ 修法：`chrome.alarms`（periodInMinutes 0.5，Chromium 120+ 允许 30s 下限）周期性唤醒
 * SW 并自愈重连；再叠 `onStartup` / `tabs.onUpdated` 两个顺手的唤醒点。
 * 同时 `connect()` 里任何同步异常都必须留下重试（旧写法一旦 `new WebSocket` 抛异常，
 * 重试链就断了）。
 */
const KEEPALIVE_ALARM = 'dshm-bridge-keepalive';

/** 没有活着的连接就起一条；在 alarms / tabs 事件里被调用。 */
function ensureConnected() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  clearTimeout(retryTimer);
  connect();
}

// docs/226：海泰内核不支持可靠的扩展截图，因此 screenshot 只保留 runTool
// 兼容分支并立即 fail-fast，绝不能重新放回 TOOLS 对模型宣告为可用。
const TOOLS = [
  { name: 'navigate', description: 'Open a URL in the active tab', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
  { name: 'get_tree', description: 'Read the element tree (ref ids) of the active page', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'click', description: 'Click an element by ref id from get_tree', inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false } },
  { name: 'get_text', description: 'Get the visible text of the page', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'cdp_eval', description: 'Evaluate JS in the page via chrome.debugger (CDP Runtime.evaluate)', inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'], additionalProperties: false } },
  { name: 'close', description: 'Close the tab/window DSHM used (auto-close after a task ends)', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'type', description: 'Set the value of a textbox by ref id (input/textarea/contenteditable)', inputSchema: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' } }, required: ['ref', 'text'], additionalProperties: false } },
  { name: 'tabs', description: 'List browser tabs (id/title/url/active)', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'select_tab', description: 'Select a tab by id (activate it, then attach debugger)', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'], additionalProperties: false } },
  { name: 'network', description: 'Read recent resource timing entries of the page (URL/type/duration/transferSize)', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
];

function log(...a) { console.log('[DSHM-Bridge]', ...a); }
function send(o) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (e) { /* ignore */ } }
// 把关键步骤也送到桥（SW 的 console 看不到，桥能看）
function trace(m) { send({ method: 'log', params: { m } }); }
// 给任何可能"永不 resolve"的浏览器 API 加超时（海泰的 SW 语境下实测有 API 会挂）
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('api-timeout: ' + label)), ms))
  ]);
}

function connect() {
  try {
    ws = new WebSocket(BRIDGE);
  } catch (e) {
    log('WebSocket ctor threw; retry in 3s:', String(e));
    ws = null;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, 3000);
    return;
  }
  ws.onopen = () => {
    log('connected to bridge');
    send({ method: 'extensionInfo', params: {
      extensionVersion: '0.11.2',
      build: 'dshm-host-bridge-13',
      browserType: 'chromium',
      displayName: 'DSHM Browser Bridge',
      capabilities: {
        tools: TOOLS.map((t) => t.name),
        screenshot: false,
        screenshotReason: 'haitai-kernel-unsupported'
      }
    } });
  };
  ws.onmessage = async (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    await handle(m);
  };
  ws.onclose = () => { log('bridge closed; retry in 3s'); ws = null; clearTimeout(retryTimer); retryTimer = setTimeout(connect, 3000); };
  ws.onerror = () => { /* onclose follows */ };
}

// ── 唤醒点：alarms 心跳（主）+ 浏览器启动 / 标签页活动（顺手） ──────────────
try {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((a) => { if (a && a.name === KEEPALIVE_ALARM) ensureConnected(); });
} catch (e) { log('alarms unavailable:', String(e)); }
try { chrome.runtime.onStartup.addListener(() => ensureConnected()); } catch (e) { /* ignore */ }
try { chrome.tabs.onUpdated.addListener(() => ensureConnected()); } catch (e) { /* ignore */ }

async function activeTab() {
  // MV3 SW 里 currentWindow 不可靠：三级回退 + 超时
  let tabs = await withTimeout(chrome.tabs.query({ active: true, lastFocusedWindow: true }), 4000, 'query(lastFocused)');
  if (!tabs || !tabs.length) tabs = await withTimeout(chrome.tabs.query({ active: true }), 4000, 'query(active)');
  if (!tabs || !tabs.length) tabs = await withTimeout(chrome.tabs.query({}), 4000, 'query(all)');
  return tabs && tabs.length ? tabs[tabs.length - 1] : null;
}

// 会话绑定的目标 tab（navigate 选定后，其余工具操作同一 tab）
let sessionTabId = null;

/**
 * 【v3：调试器冲突不再静默（2026-10-16 真机复现）】
 * v2 在 attach 的 catch 里写"already attached"注释就吞掉了错误，随后 sendCommand 报
 * `Debugger is not attached to the tab with id: …` —— 真实原因（别人占着调试器）完全丢失。
 * 这里改成：attach 失败只**记账**，等 CDP 命令真失败时把两边原文一起抛出来，
 * 并对"另一个调试器占用"给可行动提示（docs/174 §3.2：Ultron / WorkBuddy 冲突实测）。
 */
const attachedTabs = new Set();

/** 试附着；成功回 ''，失败回错误原文（不抛，交给调用方决定重试/换 tab）。 */
async function tryAttach(tabId) {
  if (attachedTabs.has(tabId)) return '';
  try {
    await withTimeout(chrome.debugger.attach({ tabId }, '1.3'), 5000, 'debugger.attach');
    attachedTabs.add(tabId);
    return '';
  } catch (e) {
    return String((e && e.message) || e);
  }
}

/**
 * 【v5：陈旧附着自愈（2026-10-16 真机复现，模型侧三轮 navigate 全红）】
 * v4 的 `attachedTabs` 是"SW 记着的状态"，不是"浏览器侧的真实状态"：真机实录
 * 14:02 attach 成功 → 14:05 同一条连接上 `Page.navigate` 报
 * `Debugger is not attached to the tab with id: 1960785795`，而 Set 仍认为已附着
 * ⇒ 之后每次 navigate 都直接走"已附着"分支、全部失败。
 * 修法：命令报 not-attached ⇒ **清缓存 → detach 残留（失败无妨）→ 重 attach → 重试一次**。
 */
async function refreshAttach(tabId) {
  attachedTabs.delete(tabId);
  try { await withTimeout(chrome.debugger.detach({ tabId }), 2000, 'debugger.detach'); } catch (e) { /* 本来就没有会话 */ }
  return await tryAttach(tabId);
}

async function withDebugger(tabId, label, fn) {
  const attachError = await tryAttach(tabId);
  if (attachError) trace('debugger.attach failed: ' + attachError);
  try {
    return await fn();
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/not attached/i.test(msg)) {
      const re = await refreshAttach(tabId);
      if (re === '') {
        trace(label + ': 陈旧附着已刷新，重试一次');
        await new Promise((r) => setTimeout(r, 150));
        try {
          return await fn();
        } catch (e2) {
          throw new Error(`${label} 失败（重附着后重试仍败）：${String((e2 && e2.message) || e2)}`);
        }
      }
      const hint = /already attached/i.test(attachError)
        ? '另一个调试器（如 WorkBuddy / Ultron / 千问连接器）已附着在该标签页 —— 请先在对方应用里断开浏览器连接，再重试'
        : '调试器未能附着（目标页可能不可调试）';
      throw new Error(`${label} 失败：${hint}。首次 attach 原文：${attachError || '（无 —— 本 SW 认为已附着）'}；重附着原文：${re}；命令原文：${msg}`);
    }
    throw new Error(`${label} 失败：${msg}`);
  }
}

/** 注入脚本 + 一次重试；失败时带上目标页 url，便于定位"加载中/休眠标签页"。 */
async function scriptInTab(tabId, label, func, args) {
  let last = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const exec = args === undefined
        ? chrome.scripting.executeScript({ target: { tabId }, func })
        : chrome.scripting.executeScript({ target: { tabId }, func, args });
      return await withTimeout(exec, 8000, `executeScript(${label})#${attempt}`);
    } catch (e) {
      last = String((e && e.message) || e);
      if (attempt === 1) await new Promise((r) => setTimeout(r, 1200));
    }
  }
  let tabUrl = '';
  try {
    const t = await withTimeout(chrome.tabs.get(tabId), 2000, 'tabs.get(url)');
    tabUrl = t && t.url ? String(t.url).slice(0, 120) : '';
  } catch (e) { /* ignore */ }
  throw new Error(`脚本注入失败（${label}，已重试一次）：${last}；目标标签页 url=${tabUrl || '?'} —— 若该页仍在加载或处于休眠，先切到该标签页再试`);
}

/**
 * 【v7：CDP 兜底读正文（2026-10-17）】`scripting.executeScript` 在个别站点的重页面/长任务上
 * 会挂死（真机实录：中国招标投标公共服务平台的检索页，8s×2 重试全超时 ⇒ 抓取失败），
 * 而 CDP `Runtime.evaluate` 走调试器通道，实测更稳。仅在 scripting 失败后使用
 * （正常路径一个字节不变）。
 *
 * ⚠ 只用于**纯文本**：CDP 在**主世界**求值，而 `buildTree()` 的 ref 表建在隔离世界
 * （`chrome.scripting` 默认 ISOLATED）⇒ tree/click 的 ref 不能跨世界复用。
 */
async function pageTextViaCdp(tabId) {
  const res = await withDebugger(tabId, 'get_text(CDP)', () =>
    withTimeout(chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: '(document.body ? document.body.innerText : "").replace(/\\s+/g, " ").trim().slice(0, 20000)',
      returnByValue: true,
    }), 8000, 'Runtime.evaluate(text)'));
  return res && res.result && typeof res.result.value === 'string' ? res.result.value : '';
}

/**
 * 【v8：任务结束自动关浏览器】只关 **DSHM 用过的那一个标签页**（`sessionTabId`），不碰用户
 * 自己的窗口/标签页：
 *   ① `chrome.tabs.remove(tab)` **点火不 await**（海泰的 tabs.* 有"promise 永久挂起"前科，
 *      但副作用可能生效 —— 与 v6 的 tabs.update 同一口径），随后轮询 `tabs.get` 看它是否消失；
 *   ② 3s 内还在 ⇒ 若该窗口**只有这一个标签页**，再 `chrome.windows.remove(windowId)` 并轮询；
 *   ③ 仍不行 ⇒ 如实返回失败（宿主日志留痕，不假装关掉了）。
 * 为什么只关单标签页窗口：用户可能同时开着别的网页/窗口，整窗关闭是不可接受的副作用。
 */
async function closeSessionBrowser() {
  const tabId = sessionTabId;
  if (tabId == null) return { ok: false, error: 'no session tab' };
  // 【v10 安全策略：单标签窗口只最小化，绝不删最后一个标签页】
  // 真机 2026-10-17：删掉最后一页后海泰 EntryAbility 进入 "terminate timeout"，
  // 进程活着但窗口句柄 -1，浏览器再也打不开（只能 force-stop 恢复）。
  let winId = null;
  try {
    const t = await withTimeout(chrome.tabs.get(tabId), 2000, 'tabs.get(close)');
    winId = t ? t.windowId : null;
  } catch (e) {
    sessionTabId = null;
    return { ok: true, via: 'already-gone' };
  }
  if (winId == null) {
    sessionTabId = null;
    return { ok: true, via: 'already-gone' };
  }
  let tabCount = 1;
  try {
    const tabs = await withTimeout(chrome.tabs.query({ windowId: winId }), 2000, 'query(window)');
    tabCount = (tabs || []).length;
  } catch (e) { /* 读不到就按单标签处理（更安全） */ }
  if (tabCount <= 1) {
    trace('close: single-tab window; minimize instead of closing (avoid haitai terminate hang)');
    try {
      const p = chrome.windows.update(winId, { state: 'minimized' });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) {
      trace('windows.update(minimized) threw: ' + e);
    }
    if (await waitWindowMinimized(winId, 3000)) {
      sessionTabId = null;
      return { ok: true, via: 'minimize-single-tab', windowId: winId };
    }
    return { ok: false, error: 'minimize not effective (single-tab window)' };
  }
  trace('close: trying tabs.remove tab=' + tabId);
  try {
    const p = chrome.tabs.remove(tabId);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) { trace('tabs.remove threw: ' + e); }
  if (await waitTabGone(tabId, 3000)) {
    sessionTabId = null;
    return { ok: true, via: 'tabs.remove', tabId };
  }
  return { ok: false, error: 'close not effective (multi-tab window: tab was not removed)' };
}

/** 等窗口真的进入最小化；不能只相信 `windows.update` 的调用没有抛错。 */
async function waitWindowMinimized(windowId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const w = await withTimeout(chrome.windows.get(windowId), 1500, 'windows.get(minimized)');
      if (!w) return true;
      if (w.state === 'minimized') return true;
    } catch (e) {
      return true;
    }
  }
  return false;
}

/** 等标签页消失：`tabs.get` 抛错/返回空都视为已关闭。 */
async function waitTabGone(tabId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const t = await withTimeout(chrome.tabs.get(tabId), 1500, 'tabs.get(gone)');
      if (!t) return true;
    } catch (e) {
      return true;
    }
  }
  return false;
}

async function toolTab() {
  if (sessionTabId != null) {
    try { const t = await withTimeout(chrome.tabs.get(sessionTabId), 3000, 'tabs.get(session)'); if (t) return t; } catch (e) { sessionTabId = null; }
  }
  const t = await activeTab();
  if (t && /^https?:/.test(t.url || '')) return t;
  // 活动标签页不是普通网页（chrome://…）⇒ 退到第一个 http(s) 标签页；
  // 一个都没有才把原 tab（chrome://）交回去，让上层报错带上真实 url。
  try {
    const all = await withTimeout(chrome.tabs.query({}), 4000, 'query(all)');
    const web = (all || []).find((x) => /^https?:/.test(x.url || ''));
    if (web) return web;
  } catch (e) { /* ignore */ }
  return t;
}

// 等标签页加载完成：轮询 chrome.tabs.get（比 onUpdated 事件稳；读不到即视为已关闭）
async function waitTabComplete(tabId, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const t = await withTimeout(chrome.tabs.get(tabId), 3000, 'tabs.get');
      if (t && t.status === 'complete') return 'complete';
    } catch (e) { return 'tab-closed'; }
    await new Promise((r) => setTimeout(r, 300));
  }
  return 'timeout';
}

// ---- injected functions（必须自包含，序列化后注入页面）----
function buildTree() {
  const REFS = (globalThis.__dshmRefs = globalThis.__dshmRefs || new Map());
  let n = 0;
  function role(el) {
    const r = el.getAttribute('role'); if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button') return 'button';
    if (t === 'input') { const ty = (el.type || 'text').toLowerCase(); return ty === 'checkbox' ? 'checkbox' : ty === 'radio' ? 'radio' : ty === 'search' ? 'searchbox' : ty === 'submit' ? 'button' : 'textbox'; }
    if (t === 'textarea') return 'textbox';
    if (t === 'select') return 'combobox';
    if (/^h[1-6]$/.test(t)) return 'heading';
    return '';
  }
  function name(el) {
    return (el.getAttribute('aria-label') || el.getAttribute('title') || el.placeholder || el.alt || (el.textContent || '').trim().slice(0, 80) || '').trim();
  }
  function visible(el) { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetWidth > 0 && el.offsetHeight > 0; }
  const INTERACTIVE = ['link', 'button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'heading'];
  const out = [];
  let count = 0;
  function walk(el, depth) {
    if (count > 500 || !visible(el)) return;
    const r = role(el);
    if (INTERACTIVE.includes(r)) {
      const id = 'ref_' + (n++);
      REFS.set(id, new WeakRef(el));
      out.push('  '.repeat(Math.min(depth, 8)) + '[' + id + '] ' + r + ' "' + name(el) + '"');
      count++;
    }
    for (const c of el.children) walk(c, depth + 1);
  }
  if (document.body) walk(document.body, 0);
  return out.join('\n') || '(empty)';
}
function clickRef(ref) {
  const REFS = globalThis.__dshmRefs;
  if (!REFS) return { ok: false, error: 'no tree yet — call get_tree first' };
  const w = REFS.get(ref);
  const el = w && w.deref();
  if (!el) return { ok: false, error: 'ref not found: ' + ref };
  el.scrollIntoView({ block: 'center' });
  el.click();
  return { ok: true, clicked: ref, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 60) };
}
function typeText(ref, text) {
  const REFS = globalThis.__dshmRefs;
  if (!REFS) return { ok: false, error: 'no tree yet — call get_tree first' };
  const w = REFS.get(ref);
  const el = w && w.deref();
  if (!el) return { ok: false, error: 'ref not found: ' + ref };
  el.scrollIntoView({ block: 'center' });
  try { el.focus(); } catch (e) { /* ignore */ }
  const value = String(text == null ? '' : text);
  try {
    if ('value' in el) {
      el.value = value;
    } else if (el.isContentEditable) {
      el.textContent = value;
    } else {
      el.textContent = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  return { ok: true, ref: ref, text: value, tag: el.tagName.toLowerCase() };
}
function networkEntries() {
  const out = [];
  try {
    const entries = performance.getEntriesByType('resource');
    for (let i = Math.max(0, entries.length - 100); i < entries.length; i++) {
      const e = entries[i];
      out.push({
        name: String(e.name || '').slice(0, 300),
        initiatorType: String(e.initiatorType || ''),
        duration: Math.round(Number(e.duration) || 0),
        transferSize: Math.round(Number(e.transferSize) || 0),
      });
    }
  } catch (e) { /* 页面不支持 Performance 时给空表 */ }
  return out;
}
function pageText() {
  return (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 20000);
}

async function runTool(tool, a) {
  trace('runTool:' + tool + ' start');
  if (tool === 'navigate') {
    // ⚠️【2026-10-16 真机规律修正（v6）】先前判的"毒标签页/扩展换版泄漏"**不对**：把三轮读数对齐后，
    // 真正的规律是 —— 海泰的 `chrome.debugger.attach` **只在"浏览器当前活动标签页"上成功**：
    //   · 13:59 / 14:02 网页在活动位 ⇒ attach 秒过、CDP 导航 load=complete；
    //   · 13:56 / 13:58 / 14:08 活动位是扩展管理页（haitai://extensions）⇒ 后台网页 attach 一律
    //     挂死 5s（`api-timeout: debugger.attach`）；同一 tab 一变成活动页就立刻可 attach。
    //   · 14:08 还顺带证伪了 tabs.create 兜底：点火后轮询 8s，**没有**出现新的 http(s) 标签页。
    // ⇒ 修法：先把目标页**变成活动页**（tabs.update 的 promise 永久挂起但可能仍有副作用 ⇒
    //   点火不 await + 轮询 active 状态，最多 3s），attach 只对确认活动的页发起。
    const all = await withTimeout(chrome.tabs.query({}), 4000, 'query(all)');
    const web = (all || []).filter((t) => /^https?:/.test(t.url || ''));
    const activeWeb = web.find((t) => t.active);
    const ordered = activeWeb ? [activeWeb, ...web.filter((t) => t.id !== activeWeb.id)] : web;
    const attachErrors = [];
    let target = null;
    const budgetEnd = Date.now() + 20000;
    for (const cand of ordered.slice(0, 3)) {
      if (Date.now() > budgetEnd) { attachErrors.push('时间预算耗尽'); break; }
      if (!cand.active) {
        trace('activating tab ' + cand.id + '（点火 tabs.update + 轮询 active）');
        try {
          const p = chrome.tabs.update(cand.id, { active: true });
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (e) { trace('tabs.update threw: ' + e); }
        const t0 = Date.now();
        let nowActive = false;
        while (Date.now() - t0 < 3000) {
          await new Promise((r) => setTimeout(r, 300));
          try {
            const t = await withTimeout(chrome.tabs.get(cand.id), 2000, 'tabs.get(active)');
            nowActive = !!(t && t.active);
          } catch (e) { break; }
          if (nowActive) break;
        }
        if (!nowActive) {
          attachErrors.push(`tab ${cand.id}: 无法激活（tabs.update 无副作用）`);
          trace('activate failed for tab ' + cand.id);
          continue;
        }
        trace('tab ' + cand.id + ' 已激活');
      }
      const err = await tryAttach(cand.id);
      if (err === '') { target = cand; break; }
      attachErrors.push(`tab ${cand.id}(${String(cand.url).slice(0, 40)}): ${err}`);
      trace('attach failed: ' + attachErrors[attachErrors.length - 1]);
    }
    if (!target) {
      throw new Error('没有可驱动的网页标签页：海泰的调试器只对"浏览器**当前活动**标签页"生效，'
        + '且扩展管理页（chrome:// / haitai://）不可操作。请点开一个普通网页标签页、让它成为当前页，再重试。明细：'
        + (attachErrors.join(' | ') || '无候选 tab'));
    }
    sessionTabId = target.id;
    trace('navigate target=' + target.id + ' cur=' + String(target.url).slice(0, 50));
    trace('Page.navigate via CDP');
    await withDebugger(target.id, 'Page.navigate', () =>
      withTimeout(chrome.debugger.sendCommand({ tabId: target.id }, 'Page.navigate', { url: a.url }), 8000, 'Page.navigate'));
    const st = await waitTabComplete(target.id);
    trace('load state=' + st);
    return { ok: true, tabId: target.id, url: a.url, load: st, via: 'cdp-pagenavigate' };
  }
  if (tool === 'close') {
    return await closeSessionBrowser();
  }
  if (tool === 'tabs') {
    const all = await withTimeout(chrome.tabs.query({}), 4000, 'query(tabs)');
    const tabs = (all || []).map((t) => ({
      id: t.id,
      title: String(t.title || '').slice(0, 120),
      url: String(t.url || '').slice(0, 240),
      active: !!t.active,
    }));
    return { ok: true, tabs };
  }
  if (tool === 'select_tab') {
    const id = Number(a.tabId);
    if (!Number.isFinite(id)) throw new Error('select_tab: tabId 必须是数字');
    try {
      const p = chrome.tabs.update(id, { active: true });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { trace('select_tab update threw: ' + e); }
    const t0 = Date.now();
    let active = false;
    while (Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        const t = await withTimeout(chrome.tabs.get(id), 2000, 'tabs.get(select)');
        if (t && t.active) { active = true; break; }
      } catch (e) { break; }
    }
    sessionTabId = id;
    return { ok: true, tabId: id, active };
  }
  const tab = await toolTab();
  trace('toolTab=' + (tab ? tab.id + ':' + String(tab.url).slice(0, 60) : 'none'));
  if (!tab) throw new Error('no tab');
  if (tool === 'get_tree') {
    const r = await scriptInTab(tab.id, 'tree', buildTree);
    return { ok: true, tree: r[0] ? r[0].result : '(no result)' };
  }
  if (tool === 'click') {
    const r = await scriptInTab(tab.id, 'click', clickRef, [a.ref]);
    return r[0] ? r[0].result : { ok: false, error: 'no result' };
  }
  if (tool === 'get_text') {
    try {
      const r = await scriptInTab(tab.id, 'text', pageText);
      return { ok: true, text: (r[0] ? r[0].result : '').slice(0, 20000), via: 'script' };
    } catch (e) {
      trace('get_text scripting 失败，转 CDP 兜底：' + String((e && e.message) || e).slice(0, 140));
      const text = await pageTextViaCdp(tab.id);
      return { ok: true, text: text.slice(0, 20000), via: 'cdp' };
    }
  }
  if (tool === 'type') {
    const r = await scriptInTab(tab.id, 'type', typeText, [String(a.ref || ''), String(a.text == null ? '' : a.text)]);
    return r[0] ? r[0].result : { ok: false, error: 'no result' };
  }
  if (tool === 'network') {
    const r = await scriptInTab(tab.id, 'network', networkEntries);
    return { ok: true, entries: r[0] ? r[0].result : [] };
  }
  if (tool === 'screenshot') {
    /*
     * 海泰实测（2026-10-21）：
     *   · `tabs.captureVisibleTab` 在该内核上同步卡住，Promise / callback 都是；
     *   · `Page.captureScreenshot(fromSurface=false)` 明确拒绝，只允许 surface；
     *   · `Page.captureScreenshot(fromSurface=true)` 的 Promise 与 callback 都永不返回。
     * 这是浏览器内核侧的限制，继续调用会把扩展 service worker 一起卡死。这里立即
     * fail-fast，让工具层给出可行动结论；不要用更长的超时掩盖。
     */
    throw new Error('当前海泰浏览器内核不支持扩展截图：'
      + 'tabs.captureVisibleTab 会同步挂起；Page.captureScreenshot 仅允许 surface，而 surface 调用也不返回。'
      + '导航、读树、点击、输入、正文和网络工具不受影响；需要截图时请用系统截图工具。');
  }
  if (tool === 'cdp_eval') {
    const res = await withDebugger(tab.id, 'Runtime.evaluate', () =>
      withTimeout(chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.evaluate', { expression: a.expression, returnByValue: true, awaitPromise: true }), 8000, 'debugger.sendCommand'));
    return { ok: true, value: res && res.result ? res.result.value : null };
  }
  throw new Error('unknown tool: ' + tool);
}

async function handle(m) {
  if (!m || typeof m !== 'object') return;
  if (m.method === 'ping') { send({ method: 'pong' }); return; }
  if (m.method === 'tools/discover') { send({ id: m.id, result: { tools: TOOLS } }); return; }
  if (m.method === 'tools/invoke') {
    const id = m.id;
    const tool = (m.params || {}).tool;
    const a = (m.params || {}).arguments || {};
    log('invoke', tool, JSON.stringify(a).slice(0, 120));
    try {
      const r = await runTool(tool, a);
      send({ id, result: r });
      log('ok', tool);
    } catch (e) {
      send({ id, error: { code: 'TOOL_ERROR', message: String((e && e.message) || e) } });
      log('err', tool, String(e));
    }
    return;
  }
}

connect();
