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

/**
 * undici 的 `ProxyAgent`（把请求经 HTTP(S) 代理转发）。
 *
 * 【为什么是降级实现】真 `ProxyAgent` 要 CONNECT 隧道与完整 HTTP 栈，而端侧 jitless
 * 用不了真 undici（WASM，见文件头）。这个导出**首先是给 ESM 具名导入用的**：
 * 具名导入在解析阶段就校验导出存在性，缺一个名字会让**整个模块图** `failed to import`，
 * 插件连 `apply()` 都到不了。这与本文件 `EnvHttpProxyAgent` 段记的是同一类事故
 * （2026-09-24 dshmarket；2026-10-03 `dsh-codearts-auth` 0.2.1003 新增
 * `lib/opencode-proxy.js` 又踩一次，真机 `codearts-auth (dsh-codearts-auth): failed to import`）。
 *
 * 行为上退化为直连 Agent，与"没配代理"等价——不会静默错路由。
 *
 * 【构造参数必须宽容】真 `ProxyAgent` 收 `{ uri, clientFactory }`，其中 `clientFactory`
 * 内部会 `new Pool(...)`；某些调用方还会传 `{ proxy, requestTls, ... }`。这里**一律忽略、
 * 绝不抛错** —— 抛错就成了运行期失败，比缺导出更难排查。
 */
export class ProxyAgent extends Agent {
  constructor(options) {
    super(options);
    // 真 undici 两种形态都收：`new ProxyAgent('http://host:port')` 与 `{ uri }` / `{ proxy }`。
    if (typeof options === 'string') {
      this.uri = options;
      return;
    }
    const opts = options === undefined || options === null ? {} : options;
    const uri = opts.uri !== undefined ? opts.uri : opts.proxy;
    this.uri = typeof uri === 'string' ? uri : '';
  }
}

/**
 * undici 的 `Pool`（到一个 origin 的连接池）。同样为具名导入而存在，退化为 `Agent`。
 *
 * 调用形态有 `new Pool(origin, opts)` 与 `new Pool({ origin, ... })` 两种，`Agent`
 * 的构造器只记 options、不做校验，两种都能安全吞下。
 */
export class Pool extends Agent {
}

/**
 * undici 的 `RetryAgent`（带重试策略的 Dispatcher）。
 *
 * 与 `ProxyAgent` 同理，**首先是给具名导入用的**：它是一个 Dispatcher，继承 `Agent`
 * 就能被上游传给 `fetch(..., { dispatcher })`，只是不重试——退化为"不发重试"，
 * 失败模式与被重试策略放行一致，不会静默错路由。当前没有已知使用方（预防性补齐，
 * 见 report 的建议：同类缺口第三次复发时排查成本极高）。
 *
 * 【刻意**不**补的三个名字】`request` / `stream` / `interceptors`：
 *   · `request()` 返回的是 undici 特有的 `{statusCode, headers, body, trailers}` 形态，
 *     不是 `Response`。用 `dshmFetch` 冒充会**静默给错类型**，比缺导出更难查。
 *   · `interceptors` 是拦截器工厂集合，装成空实现会**静默关掉调用方的拦截逻辑**。
 *   · `stream` 同理（duplex 包装与真实流语义绑定）。
 * 这三者一旦出现真实使用方，正确做法是**明确失败**（缺导出 ⇒ import 报错），
 * 而不是给一个行为不一致的替身。缺什么名字由门禁 `check-undici-shim-exports.mjs` 报出。
 */
export class RetryAgent extends Agent {
}

/**
 * undici 的 `RetryHandler`（`new RetryAgent(new RetryHandler(opts))` 里的重试策略）。
 *
 * 与 `RetryAgent` 同理：`RetryAgent` 的降级实现会忽略这个参数，于是净效果是"不重试"。
 * 这里给的是空壳（不继承 `Agent`——它是 handler 不是 dispatcher，继承反而会误导调用方）。
 *
 * 【界线（为什么这四个补、另外三个不补）】判断标准是**降级后是否静默给出错误语义**：
 *   · `Pool` / `ProxyAgent` / `RetryAgent` / `RetryHandler` —— 降级后请求要么直连成功、
 *     要么在网络层**明确失败**；不会"看起来成功但结果不对"。
 *   · `request` / `stream` / `interceptors` —— 降级会**静默**改变返回值类型 / 关掉调用方
 *     的拦截逻辑。那比"缺导出、import 直接报错"更难排查，故**刻意不提供**。
 */
export class RetryHandler {
  constructor(options) {
    this.options = options === undefined || options === null ? {} : options;
  }
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

export default {
  fetch,
  Agent,
  Dispatcher,
  EnvHttpProxyAgent,
  ProxyAgent,
  Pool,
  RetryAgent,
  RetryHandler,
  setGlobalDispatcher,
  getGlobalDispatcher,
};
