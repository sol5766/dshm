/**
 * `browser_*` 工具：模型可见的 PC 浏览器自动化入口（2026-10-16）。
 *
 * 【是什么】把"设备本机浏览器（海泰等 Chromium 系）里的 DSHM Browser Bridge 扩展"接进
 * Agent 工具面：扩展主动连**宿主进程内**的浏览器桥（ws://127.0.0.1:19390/browser-bridge），
 * 本插件经宿主 HTTP 端点 `/dshm-browser/invoke` 转发工具调用。浏览器侧的一切
 * （CDP 导航 / 脚本注入 / 点击 / 读元素树）由扩展完成——调研与 PoC 见 `docs/173`、`docs/174`。
 *
 * 【通道】与 `dshm-tool-python` 同款：走 `http://127.0.0.1:<port>/dshm-browser/*`
 * （端口 / token 取 `$DSHM_HOME/host-ready.json`——当前进程写出的权威值；插件不 require 宿主模块）。
 *
 * 【边界（如实写进工具描述）】
 *   · 需要用户先在目标浏览器里"加载已解压的扩展"（DSHM 随包提供扩展源码，引导安装）；
 *   · **浏览器没启动也能用**（2026-10-17）：`browser_navigate` 发现桥上没有扩展客户端时，
 *     经 `/dshm-open-link` 请求 ArkTS 壳层**显式拉起海泰**（`startAbility`，bundle 见
 *     `PREFERRED_BROWSER_BUNDLE`；失败回退系统 `openLink`），再等扩展回连；
 *     拉起失败/扩展未回连都会如实报错（不假装成功）。
 *   · Chrome 调试器**独占**：与其它占用调试器的扩展（如 WorkBuddy 的 Ultron）互斥，
 *     冲突时扩展侧会返回明确错误——此时应提示用户先断开对方；
 *   · 海泰浏览器禁扩展建/控标签页 ⇒ navigate 在**已存在的 http(s) 标签页**上用 CDP 导航，
 *     没有可用页面时工具如实报错（先让用户开一个普通网页）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import http from 'node:http';
import { defineTool } from '@deepseek-ai/dsh-tools';

/** 插件名（与 package.json / pack-core 的清单同值）。 */
const name = 'dshm-tool-browser';

/** Cordis 注入声明：register 需要 tools 服务（与 dshm-tool-python 同因）。 */
const inject = ['tools'];

const DEFAULT_TIMEOUT_SEC = 30;
const MIN_TIMEOUT_SEC = 5;
const MAX_TIMEOUT_SEC = 120;

/**
 * 浏览器自动化只对 PC / 2in1 开放。
 * 手机与平板没有可用的浏览器扩展/debugger 面，注册工具只会让模型调用后必然失败。
 */
export function browserToolsEnabled(env = process.env) {
  const mode = String(env.DSHM_BROWSER_TOOLS || '').trim().toLowerCase();
  if (mode === 'off') return false;
  if (mode === 'force') return true;
  return String(env.DSHM_DEVICE_FORM || '').trim().toLowerCase() === 'desktop';
}

/**
 * 浏览器截图工具默认关闭。
 *
 * 当前海泰 Chromium 内核的 `tabs.captureVisibleTab` 与 CDP
 * `Page.captureScreenshot(fromSurface=true)` 都不会返回；扩展只能 fail-fast。
 * 模型工具面不应暴露一个已知必然失败的能力。只有换成支持截图的浏览器内核，
 * 或未来完成独立 ArkTS 截图桥后，才显式设置 `DSHM_BROWSER_SCREENSHOT=on`
 * 打开注册。
 */
export function browserScreenshotEnabled(env = process.env) {
  return String(env.DSHM_BROWSER_SCREENSHOT || '').trim().toLowerCase() === 'on';
}

/**
 * 「拉起浏览器」后的回连预算：`/dshm-open-link` 受理 ≈ 壳层立刻 openLink，
 * 浏览器冷启动 + MV3 SW 拉起 + WS 回连通常 2~5s；15s 覆盖首次冷启动的慢路径。
 * 轮询间隔 1s（`/dshm-browser/status` 是免 token 的本地只读端点，代价可忽略）。
 */
const LAUNCH_CONNECT_BUDGET_MS = 15000;
const LAUNCH_CONNECT_POLL_MS = 1000;

/**
 * 拉起浏览器时**优先显式启动**的 bundle —— DSHM 扩展部署在其中的那个浏览器。
 *
 * 【为什么不能只靠系统默认】2026-10-17 真机实测：`openLink` 走系统默认浏览器
 * （本机 = `com.huawei.hmos.browser`），而扩展装在 `com.haitai.htbrowser` ⇒
 * 只走 openLink 会拉起"另一个浏览器"，扩展永远不回连。壳层因此优先 startAbility 拉起本 bundle，
 * 失败才回退 openLink（见 `entry/src/main/ets/system/OpenLinkBridge.ets`）。
 * 可用宿主环境变量覆盖（换浏览器时不必改代码）。
 */
const PREFERRED_BROWSER_BUNDLE = String(process.env.DSHM_BROWSER_BUNDLE || 'com.haitai.htbrowser');

/** 从 host-ready.json 取桥的 baseUrl 与 token；读不到就抛出可行动的错误。 */
async function bridgeEndpoint() {
  const home = String(process.env.DSHM_HOME ?? '').trim();
  if (home.length === 0) {
    throw new Error('browser 桥不可用：DSHM_HOME 未设置（宿主未按预期拉起？）');
  }
  let info;
  try {
    info = JSON.parse(await readFile(join(home, 'host-ready.json'), 'utf8'));
  } catch (error) {
    throw new Error(`browser 桥不可用：读不到 host-ready.json（${error instanceof Error ? error.message : String(error)}）`);
  }
  const baseUrl = typeof info.baseUrl === 'string' ? info.baseUrl : '';
  const token = typeof info.token === 'string' ? info.token : '';
  if (baseUrl.length === 0 || token.length === 0) {
    throw new Error('browser 桥不可用：host-ready.json 里没有 baseUrl/token（宿主尚在启动？稍后重试）');
  }
  return { baseUrl, token };
}

/** GET 一个 JSON 端点；只在传输层失败 / 非 2xx / 响应非 JSON 时抛错（与 python 插件同法）。 */
function getJson(urlString, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const request = http.get(urlString, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode !== undefined && (response.statusCode < 200 || response.statusCode > 299)) {
          done(rejectPromise, new Error(`${response.statusCode} ${text.slice(0, 300)}`));
          return;
        }
        try {
          done(resolvePromise, JSON.parse(text));
        } catch {
          done(rejectPromise, new Error(`桥返回的不是 JSON：${text.slice(0, 300)}`));
        }
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('请求超时（宿主浏览器桥无响应）'));
    });
    request.on('error', (error) => done(rejectPromise, error));
  });
}

/** 超时归一到 [5,120]（与宿主端点 clamp 同口径）。 */
function clampTimeoutSec(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_TIMEOUT_SEC;
  return Math.min(MAX_TIMEOUT_SEC, Math.max(MIN_TIMEOUT_SEC, Math.round(seconds)));
}

/**
 * 桥上有几个扩展客户端？—— `/dshm-browser/status` 是免 token 的只读端点。
 * @returns 客户端数组（读不到时抛错，由调用方决定是否吞）。
 */
async function statusClients() {
  const { baseUrl } = await bridgeEndpoint();
  const raw = await getJson(`${baseUrl}/dshm-browser/status`, 5000);
  return Array.isArray(raw.clients) ? raw.clients : [];
}

/** 普通 http 的本地启动页：让 browser_status 拉起后就有可驱动标签，而不是 chrome://newtab。 */
async function browserStartUrl() {
  const { baseUrl } = await bridgeEndpoint();
  return `${baseUrl}/dshm-browser/start`;
}

/**
 * 「浏览器没起时也能用」：没有扩展客户端 ⇒ 请求 ArkTS 壳层用 `openLink` 拉起浏览器，
 * 然后等扩展回连（浏览器的 MV3 service worker 一启动就会连回宿主桥）。
 *
 * 【为什么能拉起】`openLink` 是 ArkTS 的 UIAbilityContext API（登录外开授权页走的就是它，
 * 系统会"没有浏览器就启动默认浏览器"）；Host 的 Node 进程调不到 ⇒ 经 `/dshm-open-link`
 * 走文件队列到 `entry/.../system/OpenLinkBridge.ets`。请求-回执-超时全部如实返回。
 *
 * @param launchUrl 拉起浏览器时顺手打开的地址（navigate 用目标 URL，最自然）
 * @returns { connected, launched, launch } —— launched 只表示"壳层受理了 openLink"
 */
async function ensureClient(launchUrl, options = {}) {
  if (options.force !== true) {
    try {
      if ((await statusClients()).length > 0) {
        return { connected: true, launched: false, launch: null };
      }
    } catch (error) {
      // status 读不到不是致命：继续走拉起 + 轮询（可能宿主刚起）
    }
  }
  const { baseUrl, token } = await bridgeEndpoint();
  let launch = null;
  try {
    const requestUrl = `${baseUrl}/dshm-open-link?token=${encodeURIComponent(token)}`
      + `&url=${encodeURIComponent(launchUrl)}`
      + `&bundle=${encodeURIComponent(PREFERRED_BROWSER_BUNDLE)}&timeout=8`;
    launch = await getJson(requestUrl, 15000);
  } catch (error) {
    launch = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const deadline = Date.now() + LAUNCH_CONNECT_BUDGET_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, LAUNCH_CONNECT_POLL_MS));
    try {
      if ((await statusClients()).length > 0) {
        return { connected: true, launched: true, launch };
      }
    } catch (error) {
      // 下一拍再试
    }
  }
  return { connected: false, launched: launch !== null && launch.ok === true, launch };
}

/** 调一次桥；返回扩展侧 result 原样 JSON。 */
async function invokeTool(tool, args, timeoutSec) {
  // 任何浏览器工具被调用时都先确保浏览器在线；没有目标 URL 的查询类工具
  // 打开 Host 的本地可驱动启动页，避免只得到 chrome://newtab 后再次失败。
  const clients = await statusClients().catch(() => []);
  if (clients.length === 0) {
    const target = tool === 'navigate' && typeof args.url === 'string'
      ? args.url
      : await browserStartUrl();
    const ensured = await ensureClient(target);
    if (!ensured.connected) {
      const why = ensured.launch && ensured.launch.error ? ensured.launch.error : '扩展未回连';
      throw new Error(`${tool}：浏览器未连接，主动拉起失败（${why}）`);
    }
  }
  const { baseUrl, token } = await bridgeEndpoint();
  const path = `/dshm-browser/invoke?token=${encodeURIComponent(token)}`
    + `&tool=${encodeURIComponent(tool)}`
    + `&timeout=${encodeURIComponent(String(timeoutSec))}`
    + `&args=${encodeURIComponent(JSON.stringify(args || {}))}`;
  const raw = await getJson(baseUrl + path, (timeoutSec + 10) * 1000);
  if (raw.ok !== true) {
    throw new Error(`浏览器桥拒绝执行：${typeof raw.error === 'string' ? raw.error : JSON.stringify(raw)}`);
  }
  return raw.result;
}

/** 扩展内部失败也必须让工具调用失败，不能把 `{ok:false}` 包装成成功文本。 */
function assertInnerOk(tool, result) {
  if (result && result.ok === false) {
    throw new Error(`${tool}：${typeof result.error === 'string' ? result.error : JSON.stringify(result).slice(0, 500)}`);
  }
  return result;
}

/** 桥状态：连接了哪些浏览器扩展。 */
async function runStatus(args) {
  const timeoutSec = clampTimeoutSec(args.timeoutSec);
  const { baseUrl } = await bridgeEndpoint();
  let raw = await getJson(`${baseUrl}/dshm-browser/status`, (timeoutSec + 10) * 1000);
  let clients = Array.isArray(raw.clients) ? raw.clients : [];
  let ensured = null;
  if (clients.length === 0) {
    ensured = await ensureClient(await browserStartUrl());
    raw = await getJson(`${baseUrl}/dshm-browser/status`, (timeoutSec + 10) * 1000);
    clients = Array.isArray(raw.clients) ? raw.clients : [];
  }
  const screenshot = browserScreenshotEnabled()
    ? 'enabled(opt-in)'
    : 'unsupported(haitai-kernel)';
  const clientDetail = clients
    .map((c) => `${c.id}: ${(c.info && c.info.displayName) || '?'} v${(c.info && c.info.extensionVersion) || '?'}`)
    .join('; ');
  return {
    ok: raw.ok === true,
    connected: clients.length,
    screenshot,
    detail: `connected=${clients.length}; screenshot=${screenshot}; `
      + (ensured === null ? '' : `launch=${ensured.connected ? 'launched-and-connected' : 'failed'}; `)
      + (clientDetail.length > 0 ? clientDetail : '(无扩展连接)'),
  };
}

/**
 * 渲染：`output.render(args, value)` —— 框架**两个参数**都传（见 dsh-tools
 * `createSuccessResult`：`render(exec.arguments, value)`），返回的 content 必须是无损 JSON。
 * ⚠️ 2026-10-16 真机回归：本文件初版写成单参 `(value)`，实际收到的是 `args` ⇒
 * `value.detail === undefined` ⇒ 框架判 `output.render returned non-lossless JSON`
 * （`browser_status` 两次调用全炸，模型被迫转去翻文件系统）。
 */
function renderText(_args, value) {
  return [{ type: 'text', text: value.detail }];
}

function apply(ctx) {
  if (!browserToolsEnabled()) {
    console.log(`[${name}] 不注册浏览器工具：当前形态=${String(process.env.DSHM_DEVICE_FORM || 'unknown')}（仅 PC / 2in1）`);
    return;
  }
  ctx.tools.register(defineTool({
    name: 'browser_status',
    description: 'Check whether a browser extension (e.g. the DSHM Browser Bridge loaded in the user\'s browser) '
      + 'is connected to this app\'s host bridge, and list the connected clients. If no client is connected, '
      + 'this actively launches the preferred browser without navigating to an arbitrary web page, then waits '
      + 'for the extension to reconnect.',
    parameters: {
      timeoutSec: { type: 'number', description: 'Timeout seconds (default 30, clamped 5..120).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          connected: { type: 'integer', required: true },
          screenshot: { type: 'string', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: renderText,
    },
    async execute(args) {
      return runStatus(args);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_navigate',
    description: 'Navigate the user\'s browser to a URL using the connected DSHM Browser Bridge extension '
      + '(CDP Page.navigate on an existing http(s) tab — the browser forbids extensions from creating tabs). '
      + 'If the browser is not running at all, this first asks the app shell to launch the browser with the '
      + 'target URL (system openLink, same path as the login flow) and waits for the extension to reconnect. '
      + 'Fails with an actionable message when the extension never reconnects or no ordinary web page is open.',
    parameters: {
      url: { type: 'string', description: 'Absolute URL to open (https://...).' },
      timeoutSec: { type: 'number', description: 'Timeout seconds (default 30, clamped 5..120).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: renderText,
    },
    async execute(args) {
      const url = typeof args.url === 'string' ? args.url : '';
      if (!/^https?:\/\//.test(url)) throw new Error('browser_navigate：url 必须是 http(s) 绝对地址');
      // 浏览器没起时先把它拉起来（用户 2026-10-17 口径：不用手动提前开浏览器）
      const ensured = await ensureClient(url);
      if (!ensured.connected) {
        const launchNote = ensured.launched
          ? '已受理 openLink 拉起浏览器'
          : `拉起浏览器未成功（${(ensured.launch && ensured.launch.error) || '未知原因'}）`;
        throw new Error(`browser_navigate：浏览器扩展 ${LAUNCH_CONNECT_BUDGET_MS / 1000}s 内没有回连 —— ${launchNote}；`
          + '请确认海泰浏览器里已加载 DSHM Browser Bridge 扩展，然后重试');
      }
      let result;
      try {
        result = await invokeTool('navigate', { url }, clampTimeoutSec(args.timeoutSec));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        /*
         * 「僵尸客户端」竞态：浏览器进程刚被杀时，连接可能半开约 10s —— status 仍把它列为客户端
         * （ensureClient 因此跳过拉起），而 invoke 已经选不中它。这里重来一轮"拉起 + 等回连"。
         */
        const noClient = /没有已连接的浏览器扩展/.test(message);
        const noDrivableTab = /没有可驱动的网页标签页|无候选 tab/.test(message);
        if (!noClient && !noDrivableTab) throw error;
        /*
         * clients>0 也可能没有可驱动页面：browser_status 冷启动后浏览器可能停在
         * chrome://newtab，扩展虽然在线但 CDP 无可附着目标。此时必须 force 绕过
         * “已有 client 就不拉起”的早退，带上目标 URL 再拉起一次（海泰会激活目标页）。
         */
        const retried = await ensureClient(url, { force: noDrivableTab });
        if (!retried.connected) {
          throw new Error(`browser_navigate：浏览器连接刚断开且 ${LAUNCH_CONNECT_BUDGET_MS / 1000}s 内未恢复 —— `
            + `（${(retried.launch && retried.launch.error) || message}）`);
        }
        result = await invokeTool('navigate', { url }, clampTimeoutSec(args.timeoutSec));
      }
      return { ok: true, detail: JSON.stringify(result).slice(0, 2000) };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_tree',
    description: 'Read the interactive element tree (ref ids, roles, names) of the currently targeted browser page. '
      + 'Use the returned ref ids with browser_click.',
    parameters: {
      timeoutSec: { type: 'number', description: 'Timeout seconds (default 30, clamped 5..120).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          tree: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.tree }],
    },
    async execute(args) {
      const result = await invokeTool('get_tree', {}, clampTimeoutSec(args.timeoutSec));
      const tree = result && typeof result.tree === 'string' ? result.tree : JSON.stringify(result);
      return { ok: true, tree: tree.slice(0, 30000) };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_click',
    description: 'Click an element in the targeted browser page by its ref id from browser_tree.',
    parameters: {
      ref: { type: 'string', description: 'Element ref id from browser_tree (e.g. ref_3).' },
      timeoutSec: { type: 'number', description: 'Timeout seconds (default 30, clamped 5..120).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: renderText,
    },
    async execute(args) {
      const ref = typeof args.ref === 'string' ? args.ref : '';
      if (ref.length === 0) throw new Error('browser_click：ref 不能为空');
      const result = await invokeTool('click', { ref }, clampTimeoutSec(args.timeoutSec));
      assertInnerOk('browser_click', result);
      return { ok: true, detail: JSON.stringify(result).slice(0, 2000) };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_text',
    description: 'Get the visible text of the targeted browser page (useful to read search results / articles).',
    parameters: {
      timeoutSec: { type: 'number', description: 'Timeout seconds (default 30, clamped 5..120).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const result = await invokeTool('get_text', {}, clampTimeoutSec(args.timeoutSec));
      const text = result && typeof result.text === 'string' ? result.text : JSON.stringify(result);
      return { ok: true, text: text.slice(0, 20000) };
    },
  }));

  if (browserScreenshotEnabled()) {
    ctx.tools.register(defineTool({
      name: 'browser_screenshot',
      description: 'Capture a PNG screenshot of the targeted browser page and save it under the app home '
        + '(returns the absolute path). Only available when the configured browser kernel supports it.',
      parameters: {
        timeoutSec: { type: 'number', description: 'Timeout seconds (default 30, clamped 5..120).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            detail: { type: 'string', required: true },
          },
        },
        render: renderText,
      },
      async execute(args) {
        const result = await invokeTool('screenshot', {}, clampTimeoutSec(args.timeoutSec));
        const base64 = result && typeof result.base64 === 'string' ? result.base64 : '';
        if (base64.length === 0) throw new Error('browser_screenshot：扩展没有返回图像数据');
        const bytes = Buffer.from(base64, 'base64');
        const home = String(process.env.DSHM_HOME || '').trim();
        if (home.length === 0) throw new Error('DSHM_HOME 未设置（宿主未按预期拉起？）');
        const dir = join(home, 'screenshots');
        await mkdir(dir, { recursive: true });
        const file = join(dir, `browser-${Date.now()}.png`);
        await writeFile(file, bytes);
        return { ok: true, detail: `已保存截图：${file}（${bytes.length} B）` };
      },
    }));
  }

  ctx.tools.register(defineTool({
    name: 'browser_type',
    description: 'Set the value of a textbox (input/textarea/contenteditable) identified by a ref id from browser_tree, '
      + 'dispatching input/change events so framework forms react.',
    parameters: {
      ref: { type: 'string', description: 'Element ref id from browser_tree (e.g. ref_3).' },
      text: { type: 'string', description: 'Text to set.' },
      timeoutSec: { type: 'number', description: 'Timeout seconds (default 30, clamped 5..120).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: renderText,
    },
    async execute(args) {
      const ref = typeof args.ref === 'string' ? args.ref : '';
      if (ref.length === 0) throw new Error('browser_type：ref 不能为空');
      const text = typeof args.text === 'string' ? args.text : String(args.text ?? '');
      const result = await invokeTool('type', { ref, text }, clampTimeoutSec(args.timeoutSec));
      assertInnerOk('browser_type', result);
      return { ok: true, detail: JSON.stringify(result).slice(0, 2000) };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_tabs',
    description: 'List the browser tabs (id/title/url/active). Use browser_tab_select to switch the target tab.',
    parameters: {
      timeoutSec: { type: 'number', description: 'Timeout seconds (default 30, clamped 5..120).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: renderText,
    },
    async execute(args) {
      const result = await invokeTool('tabs', {}, clampTimeoutSec(args.timeoutSec));
      return { ok: true, detail: JSON.stringify(result).slice(0, 20000) };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_tab_select',
    description: 'Select a browser tab by id (from browser_tabs): activate it and use it for subsequent tools.',
    parameters: {
      tabId: { type: 'number', description: 'Tab id from browser_tabs.' },
      timeoutSec: { type: 'number', description: 'Timeout seconds (default 30, clamped 5..120).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: renderText,
    },
    async execute(args) {
      const tabId = Number(args.tabId);
      if (!Number.isFinite(tabId)) throw new Error('browser_tab_select：tabId 必须是数字');
      const result = await invokeTool('select_tab', { tabId }, clampTimeoutSec(args.timeoutSec));
      assertInnerOk('browser_tab_select', result);
      if (!result || result.active !== true) {
        throw new Error('browser_tab_select：标签页没有成功切到前台');
      }
      return { ok: true, detail: JSON.stringify(result).slice(0, 2000) };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_network',
    description: 'Read recent resource-timing entries of the targeted page (URL, initiator type, duration, transferSize). '
      + 'Useful to see which requests a page made (XHR/fetch/images/scripts).',
    parameters: {
      timeoutSec: { type: 'number', description: 'Timeout seconds (default 30, clamped 5..120).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: renderText,
    },
    async execute(args) {
      const result = await invokeTool('network', {}, clampTimeoutSec(args.timeoutSec));
      return { ok: true, detail: JSON.stringify(result).slice(0, 20000) };
    },
  }));
}

export { apply, inject, name };
