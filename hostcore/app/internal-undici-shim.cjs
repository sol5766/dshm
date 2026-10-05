'use strict';
/*
 * 内建 undici 的纯 JS 替身（**只在 jitless 下**由 jitless-env.cjs 拦截 require 后返回）。
 *
 * ─────────────────────────── 为什么必须有这个文件 ───────────────────────────
 * `--jitless` 隐含关掉 WASM（`typeof WebAssembly === 'undefined'`），而 Node 内建的
 * `internal/deps/undici/undici` 在**模块初始化阶段**就会实例化 WASM 版 llhttp 解析器
 * （`lazyllhttp`）。端侧 Node v24.2.0 尤其致命：它的 `lib/global.js` 在模块作用域就
 * `new Agent()`，于是**一加载就抛** `ReferenceError: WebAssembly is not defined`。
 *
 * 关键点：Node 自己**内部直接 require** 这个模块，不经过 `globalThis`：
 *
 *   1. `lib/internal/worker/io.js`：每条 MessagePort 消息投递都会
 *      `require('internal/deps/undici/undici').createFastMessageEvent`
 *      ⇒ 用 `new MessageChannel()` 做 Host↔Worker 通信的插件（例如
 *      `@deepseek-ai/dsh-experimental-inspector`，lib/index.js:1805）**第一条消息就炸**。
 *   2. `lib/internal/bootstrap/web/exposed-window-or-worker.js`：
 *      `exposeLazyInterfaces(globalThis, 'internal/deps/undici/undici', [...])`
 *      ⇒ `globalThis` 上 `Headers/Request/Response/FormData/MessageEvent/CloseEvent/
 *      WebSocket/EventSource` 的**惰性 getter** 第一次被读也会 require 它。
 *
 * 之前的四个垫片入口（全局 `fetch`、裸说明符 `undici`、`node:http` 惰性 getter、
 * `node-addon-require-builtin`）**都拦不到"Node 内部按完整路径直接 require"**。
 * 本文件由 `jitless-env.cjs` 的 `installInternalUndiciShim()` 接管那条路径——
 * **落点是 `BuiltinModule` 层**：预置 `BuiltinModule.map.get('internal/deps/undici/undici')`
 * 的 `exports` 为本文件并置 `loaded = true`（`compileForInternalLoader()` 第一行即返回）。
 * `Module._load` 上的同名钩子只作 **userland 直接 require 的兜底**，不是主入口
 * —— **Node 内部模块不走 `Module._load`**（走 `requireBuiltin()`），第一版正是栽在这里：
 * 钩子挂在 `Module._load` 上，日志说"已安装"、故障却一模一样。
 *
 * ─────────────────────────── 实现边界（不要过度承诺） ───────────────────────────
 * - `createFastMessageEvent` 必须返回**真正的 Event 实例**：Node 的
 *   `EventTarget.dispatchEvent()` 对非 Event 参数抛 `ERR_INVALID_ARG_TYPE`（已实测），
 *   所以这里的 `MessageEvent` 继承原生 `globalThis.Event`，而不是个朴素对象。
 * - `WebSocket` / `EventSource` 只提供常量与**明确的降级报错**：jitless 下没有可用的
 *   原生 WS 客户端。要真用 WS 请用核心树里的 `ws`（纯 JS，走 `node:http`/`node:net`，
 *   上游 inspector 的 worker 就是这么做的）。这符合本项目"明确降级并提示、不静默失败"
 *   的既有约定。
 * - dispatcher 系（`Agent`/`setGlobalDispatcher`…）在本文件里只是**占位 + 明确报错**：
 *   上游真正拿 undici 的路径走的是"裸说明符 `undici`"钩子（见 undici-shim.mjs），
 *   不经过这里；这里提供它们只是为了让"取到 undefined 再调用"变成一句能读懂的错。
 * - 标记 `__dshmInternalUndiciShim` 供回归门禁做**身份判定**（对照臂用它证明"没拦住"）。
 */

const fetchShim = require('./fetch-shim.js');
const { dshmFetch, DshmHeaders, DshmRequest, DshmResponse, DshmFormData, DshmBlob, DshmFile } = fetchShim;

/* ── Event 基类：优先原生，保证 dispatchEvent 接受我们的实例 ── */
const NodeEvent = typeof globalThis.Event === 'function' ? globalThis.Event : null;

const FallbackEvent = class DshmBaseEvent {
  constructor(type, init) {
    this.type = String(type);
    this.defaultPrevented = false;
    this.cancelable = Boolean(init && init.cancelable);
    this.bubbles = false;
    this.composed = false;
    this.timeStamp = Date.now();
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() {}
  stopImmediatePropagation() {}
  composedPath() { return []; }
};

const EventBase = NodeEvent === null ? FallbackEvent : NodeEvent;

/** 与 undici 的 `createFastMessageEvent(type, { data, ... })` 同形。 */
class MessageEvent extends EventBase {
  constructor(type, init = {}) {
    /*
     * 【为什么把 init 传给 super】原生 `Event` 的签名是 `constructor(type, options)`：
     * 只有传下去，`cancelable`/`bubbles`/`composed` 才与真实 undici 一致
     * （2026-10-05 审核指出：只 `super(type)` 会让 `e.cancelable` 恒为 false）。
     */
    super(type, init);
    this.data = init.data === undefined ? null : init.data;
    this.origin = init.origin === undefined ? '' : String(init.origin);
    this.lastEventId = init.lastEventId === undefined ? '' : String(init.lastEventId);
    this.source = init.source === undefined ? null : init.source;
    this.ports = Array.isArray(init.ports) ? init.ports : [];
  }
}

class CloseEvent extends EventBase {
  constructor(type, init = {}) {
    super(type, init);
    this.wasClean = Boolean(init.wasClean);
    this.code = init.code === undefined ? 0 : Number(init.code);
    this.reason = init.reason === undefined ? '' : String(init.reason);
  }
}

/**
 * 真实模块也导出 `ErrorEvent`（内置无人取用，这里是为**导出面等价**而提供，
 * 2026-10-05 审核对比端侧 `libnode.so.137` 的导出块后指出缺这一项）。
 */
class ErrorEvent extends EventBase {
  constructor(type, init = {}) {
    super(type, init);
    this.message = init.message === undefined ? '' : String(init.message);
    this.filename = init.filename === undefined ? '' : String(init.filename);
    this.lineno = init.lineno === undefined ? 0 : Number(init.lineno);
    this.colno = init.colno === undefined ? 0 : Number(init.colno);
    this.error = init.error === undefined ? null : init.error;
  }
}

/** Node 内部 `internal/worker/io.js` 每条消息投递时调用的就是这个。 */
function createFastMessageEvent(type, init) {
  return new MessageEvent(type, init);
}

function unsupported(name, hint) {
  return class DshmUnsupported {
    constructor() {
      throw new Error(
        `jitless(HarmonyOS) 下 globalThis.${name} 不可用：原生实现依赖 WASM 版解析器。${hint}`,
      );
    }
  };
}

/** WebSocket 常量要保留：有代码只读 `WebSocket.OPEN` 这类常量。 */
const WebSocket = unsupported('WebSocket', '需要 WebSocket 时请用核心树里的 `ws`（纯 JS，走 node:http/node:net）。');
WebSocket.CONNECTING = 0;
WebSocket.OPEN = 1;
WebSocket.CLOSING = 2;
WebSocket.CLOSED = 3;

const EventSource = unsupported('EventSource', '需要 SSE 时请用基于 node:http 的自实现。');

/* ── dispatcher 占位：只为把"静默 undefined"变成可读报错 ── */
class Dispatcher {
  dispatch() {
    throw new Error('jitless 下内建 undici 的 Dispatcher 不可用；上游请走裸说明符 `undici`（本仓 undici-shim.mjs）。');
  }
  close() { return Promise.resolve(); }
  destroy() { return Promise.resolve(); }
}
class Agent extends Dispatcher {
  constructor() { super(); }
}
const Pool = Agent;
const ProxyAgent = Agent;
const EnvHttpProxyAgent = Agent;
const RetryAgent = Agent;
class RetryHandler { constructor() { throw new Error('jitless 下 RetryHandler 不可用；请走 undici-shim.mjs。'); } }

let globalDispatcher = null;
function setGlobalDispatcher(d) { globalDispatcher = d; }
function getGlobalDispatcher() { return globalDispatcher; }

module.exports = {
  /* 身份标记：回归门禁据此判定"内建 undici 已被本垫片接管" */
  __dshmInternalUndiciShim: true,

  /* Node 内部实际取用的项 */
  createFastMessageEvent,
  MessageEvent,
  CloseEvent,

  /* globalThis 惰性接口会取用的名字 */
  WebSocket,
  EventSource,

  /* 导出面等价（对比端侧 libnode.so.137 的导出块）：ErrorEvent 内置无人取用，仅为面等价 */
  ErrorEvent,

  /* Web 平台其余接口：复用 fetch-shim.js 的实现，保证与全局垫片同一套语义 */
  fetch: dshmFetch,
  Headers: DshmHeaders,
  Request: DshmRequest,
  Response: DshmResponse,
  FormData: DshmFormData,
  Blob: DshmBlob,
  File: DshmFile,

  /*
   * dispatcher 系：真实模块**并不导出**这些（2026-10-05 审核核对导出块），
   * 这里纯属**预防性占位** —— 让"取到 undefined 再调用"变成一句能读懂的报错。
   * 构造是宽容的（不抛），只有真正 `dispatch()` 才抛；与 undici-shim.mjs 的既有约定一致。
   */
  Agent,
  Dispatcher,
  Pool,
  ProxyAgent,
  EnvHttpProxyAgent,
  RetryAgent,
  RetryHandler,
  setGlobalDispatcher,
  getGlobalDispatcher,
};
