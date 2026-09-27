/**
 * `undici` 垫片（端侧 jitless 环境的必要件）。
 * 状态：**已接线并端到端验证通过**（见 docs/parity-matrix.md §3.2）。
 *
 * ## 为什么需要它（实测根因）
 *
 * 上游 `dsh-web-fetch-http` **不用全局 fetch**：它 `await import("undici")`，自建
 * `new Agent({ autoSelectFamily: true, connect: { lookup: createPinnedLookup(addresses) } })`
 * 并把 `dispatcher` 传进 fetch。而 **undici 的 HTTP 解析器是 WASM**（`lib/llhttp/llhttp-wasm.js`）。
 *
 * 端侧 Host 以 `--jitless` 运行（上架要求：不申请 JIT 权限），而 `--jitless` 下
 * **`WebAssembly` 是 undefined** ⇒ undici 每次 fetch 都抛 `fetch failed`，
 * `cause: WebAssembly is not defined`。实测对照（同一核心树、同一个本地 HTTP 服务）：
 *
 * | 条件 | 结果 |
 * |---|---|
 * | 无 `--jitless`（WASM 可用） | `undici.fetch` → 200 |
 * | `--jitless`（**App 里 Host 的真实运行方式**） | `fetch failed` / `WebAssembly is not defined` |
 *
 * 这解释了"`web_search` 正常、`web_fetch` 打不开任何网页和 IP"：
 * 前者走本仓的 http/https 垫片（`fetch-shim.js`，纯 JS，不需要 WASM），后者走 undici。
 *
 * ## 做法：把 `undici` 这个**模块名**接到已有的 http/https 实现上
 *
 * 不复制一份 fetch：`fetch-shim.js` 已经实现了完整响应面（`DshmHeaders` / `DshmResponse`，
 * `body` 是真正的 `ReadableStream`）。这里只做三件 undici 特有的事：
 *   1. 转出 `fetch`（带 dispatcher → lookup 的翻译，**保住上游的 DNS 钉住/SSRF 防护**）；
 *   2. 提供 `Agent` / `Dispatcher`（上游要 `new Agent(...)` 与 `await dispatcher.close()`）；
 *   3. 补上 `setGlobalDispatcher` / `getGlobalDispatcher` 之类的空实现，避免 import 报错。
 *
 * 【为什么扩展名是 .mjs】生成的 `package.json` 故意不带 `type` 字段（main.js 是 CommonJS），
 * 所以 .js 会被当成 CJS；本文件用的是 ESM 语法。用 .mjs 让 ESM 属性成为**结构性事实**，
 * 而不是依赖 Node 的语法探测或钩子里的 format 提示。
 *
 * 模块名的替换由 `undici-loader.mjs` 的 resolve 钩子完成（**运行期组合**，
 * 不改上游源码、也不改核心树——符合 D5 §1「上游知识不落进客户端代码」的边界）。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { dshmFetch } = require('./fetch-shim.js');

/**
 * 上游用到的 undici `Agent` 的最小实现。
 *
 * 只保留"能把它携带的 connect.lookup 取出来"这一件事——因为那正是上游的 SSRF 防护
 * （先解析地址、再钉住连接）。其余选项（autoSelectFamily 等）由 node:http 自行决定，
 * 这里刻意不假装支持。
 */
export class Agent {
  constructor(options) {
    this.options = options === undefined || options === null ? {} : options;
    this.closed = false;
  }

  /** 取出上游钉住的 DNS lookup（没有则返回 undefined，表示用系统解析） */
  pinnedLookup() {
    const connect = this.options.connect;
    if (connect !== undefined && connect !== null && typeof connect.lookup === 'function') {
      return connect.lookup;
    }
    return undefined;
  }

  async close() {
    this.closed = true;
  }
}

/** undici 里 `Dispatcher` 是基类名；上游只用到它的实例语义 */
export const Dispatcher = Agent;

/**
 * undici 的 `EnvHttpProxyAgent`（按 HTTP(S)_PROXY 环境变量选代理的 Agent）。
 *
 * 【为什么是空壳】真 undici 的 EnvHttpProxyAgent 把请求路由到环境变量指定的代理，
 * 而端侧 jitless 用不了真 undici（WASM，见文件头）。它的现实使用面都不需要路由能力：
 *   - 上游 dshmarket 1.62.0 `lib/net.js:85-97`（marketFetch）：无代理变量时直接走全局
 *     fetch，检测到 http(s)_proxy 才 `new EnvHttpProxyAgent(...)`——鸿蒙应用沙箱进程
 *     环境没有这些变量，实例不会创建；即便创建了，这里降级为直连（等价「无代理」），
 *     失败模式与变量被清空一致，不会静默错路由。设备实测缺这个具名导出会让整个
 *     dsh-market 行 `failed to import`（2026-09-24 node-output.log：fiber 未建，
 *     loader 只打 "failed to import" 不带 reason）。
 *   - 其余上游只把它当 Dispatcher 实例经 `init.dispatcher` 传递，继承 Agent 即满足。
 *
 * 刻意不假装支持 CONNECT 隧道：那需要真 HTTP 栈配合，垫片层面装不出来。
 */
export class EnvHttpProxyAgent extends Agent {
}

export function setGlobalDispatcher(_dispatcher) {
}

export function getGlobalDispatcher() {
  return new Agent();
}

/**
 * fetch：把 undici 风格的 `dispatcher` 翻译成我们垫片认识的 `lookup`。
 *
 * 其余选项（method/headers/signal/redirect/body）原样透传——特别是 **`redirect: 'manual'`**：
 * 上游 `web_fetch` 靠它自己做"仅同源跳转"的安全策略。
 */
export async function fetch(input, init) {
  const opts = init === undefined || init === null ? {} : init;
  const dispatcher = opts.dispatcher;
  let lookup;
  if (dispatcher !== undefined && dispatcher !== null && typeof dispatcher.pinnedLookup === 'function') {
    lookup = dispatcher.pinnedLookup();
  }
  return await dshmFetch(input, opts, lookup === undefined ? {} : { lookup });
}

export default { fetch, Agent, Dispatcher, EnvHttpProxyAgent, setGlobalDispatcher, getGlobalDispatcher };
