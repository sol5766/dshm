'use strict';
// ---------------------------------------------------------------------------
// Global fetch shim for --jitless mode (HarmonyOS sandbox, no WebAssembly).
//
// node's built-in fetch (undici) dies with
//   ReferenceError: WebAssembly is not defined
// the moment ANY undici-backed global is touched (undici embeds the llhttp
// WASM parser with no non-WASM fallback). This file is preloaded (node -r
// <this>) BEFORE the dsh bin, and replaces every undici-backed global with a
// pure-JS implementation routed through node:http/node:https (C++ llhttp,
// no WASM). After this runs, 'internal/deps/undici/undici' must never be
// loaded again: fetch, Headers, Request, Response, FormData, MessageEvent,
// CloseEvent, ErrorEvent, EventSource and WebSocket are all covered here.
// ---------------------------------------------------------------------------

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');

// ---------------------------------------------------------------------------
// jitless kill-switch for WebAssembly: with --jitless the global is absent so
// undici's module-scope `llhttpPromise = lazyllhttp(); llhttpPromise.catch()`
// references `WebAssembly` and, if the identifier is unbound at that point,
// rejects; being a bare .catch() it surfaces as an unhandled rejection that
// aborts the whole boot. The stub must be installed FIRST, before any other
// global install: once another global (e.g. Headers) has been defined on the
// global object, undici's later resolution of WebAssembly fails. A
// never-settling stub keeps that promise pending forever: no rejection, and
// the only things that would await it are real undici requests, which the
// shim below has fully replaced.
// ---------------------------------------------------------------------------
if (typeof globalThis.WebAssembly === 'undefined') {
  const neverSettle = () => new Promise(() => {});
  const FauxWebAssembly = {
    compile: neverSettle,
    compileStreaming: neverSettle,
    instantiate: neverSettle,
    instantiateStreaming: neverSettle,
    Module: function Module() { throw new Error('WebAssembly unavailable under --jitless'); },
    Instance: function Instance() { throw new Error('WebAssembly unavailable under --jitless'); },
  };
  Object.defineProperty(globalThis, 'WebAssembly', {
    value: FauxWebAssembly,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  process.stderr.write('[fetch-shim] WebAssembly stub installed early (jitless mode)\n');
}

const kMaxRedirects = 20;

// ---------------------------------------------------------------------------
// 启动剖析器（诊断用，常开但开销极小）
//
// 背景：真机冷启动要 40-90s，而同等环境下 x86 主机 `node --jitless … bin.js web`
// 只要 17.8s；用户反馈另一款内置运行时的鸿蒙应用 3-5s 就能起来。必须先拿到
// 「时间花在哪」的确定性数据，而不是继续猜。
//
// 两类证据：
//   1. `module.registerHooks({ load })` 统计每个模块的加载耗时（读文件 + 解析 +
//      字节码编译 + 执行），并给出最慢的若干项与总计；
//   2. 每 3s 的心跳日志。若在慢启动期间心跳持续输出 → 说明是异步 I/O 等待；
//      若心跳在结束时才一次性补出来 → 说明是同步 CPU 密集（解析/执行）。
// 结果在 dsh 打印 "dsh web: …" 那一行时汇总输出到 stderr（即 node-*.log）。
//
// 默认**关闭**（生产零开销）：只有 DSHM_BOOT_PROFILE=1 时才装钩子/心跳/fs 计数。
// 真机排查时由 dsh_host.cpp 依据 <filesDir>/boot-prof.on 标记文件注入该环境变量。
// ---------------------------------------------------------------------------
const __profEnabled = process.env.DSHM_BOOT_PROFILE === '1';
const __profT0 = process.hrtime.bigint();
const __profModules = new Map();
let __profCount = 0;
let __profTotalNs = 0n;
let __profHooks = 'disabled';

function __profMs(ns) {
  return (Number(ns) / 1e6).toFixed(1);
}

if (__profEnabled) {
  try {
    const nodeModule = require('node:module');
    if (typeof nodeModule.registerHooks === 'function') {
      nodeModule.registerHooks({
        load(url, context, nextLoad) {
          const t0 = process.hrtime.bigint();
          const result = nextLoad(url, context);
          const dt = process.hrtime.bigint() - t0;
          __profCount += 1;
          __profTotalNs += dt;
          const prev = __profModules.get(url);
          if (prev === undefined || dt > prev) __profModules.set(url, dt);
          return result;
        },
      });
      __profHooks = 'installed';
    } else {
      __profHooks = 'unavailable';
    }
  } catch (e) {
    __profHooks = 'failed: ' + (e && e.message);
  }
  process.stderr.write('[boot-prof] module hooks ' + __profHooks + '\n');
}

function __profElapsedMs() {
  return __profMs(process.hrtime.bigint() - __profT0);
}

// ---- 同步文件系统计数 ----
// 证据链：模块加载只占 wall 的不到 2%，且 --jitless 与正常 JIT 只差 2 倍、
// 3s 心跳直到结束时才补出一次 —— 说明启动期是一个长同步阻塞，且主要不是
// 「解释执行」本身。下一步量同步 fs 调用（沙箱文件系统按次计费，最可疑）。
const __fsModule = require('node:fs');
const __fsByName = new Map();
const __fsByPath = new Map();
let __fsTotalNs = 0n;
let __fsCalls = 0;

function __shortPath(p) {
  if (typeof p !== 'string') return String(p);
  const i = p.indexOf('node_modules/');
  const tail = i >= 0 ? p.slice(i + 13) : p;
  const parts = tail.split('/');
  return parts.slice(0, 3).join('/');
}

function __wrapFs(name) {
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(__fsModule, name);
  } catch (_e) {
    return;
  }
  const orig = desc && desc.value ? desc.value : __fsModule[name];
  if (typeof orig !== 'function') return;
  const wrapped = function profiledFs(...args) {
    const t0 = process.hrtime.bigint();
    try {
      return orig.apply(this, args);
    } finally {
      const dt = process.hrtime.bigint() - t0;
      __fsTotalNs += dt;
      __fsCalls += 1;
      let s = __fsByName.get(name);
      if (s === undefined) { s = { count: 0, ns: 0n, seen: new Set() }; __fsByName.set(name, s); }
      s.count += 1;
      s.ns += dt;
      if (typeof args[0] === 'string' && s.seen.size < 200000) s.seen.add(args[0]);
      if (dt > 500000n) {
        const key = name + '  ' + __shortPath(args[0]);
        let t = __fsByPath.get(key);
        if (t === undefined) { t = { count: 0, ns: 0n }; __fsByPath.set(key, t); }
        t.count += 1;
        t.ns += dt;
      }
    }
  };
  // 保留原函数上的自有属性（如 fs.realpathSync.native），否则会破坏调用方。
  try {
    for (const key of Object.getOwnPropertyNames(orig)) {
      if (key === 'name' || key === 'length' || key === 'prototype') continue;
      try {
        Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(orig, key));
      } catch (_inner) {
        /* 个别属性不可复制，忽略 */
      }
    }
  } catch (_outer) {
    /* 忽略 */
  }
  try {
    Object.defineProperty(__fsModule, name, {
      value: wrapped, writable: true, configurable: true, enumerable: true,
    });
  } catch (_e) {
    /* 少数不可重定义项忽略 */
  }
}

for (const name of [
  'readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'accessSync',
  'openSync', 'readSync', 'writeSync', 'closeSync', 'realpathSync', 'readlinkSync',
  'mkdirSync', 'rmSync', 'unlinkSync', 'copyFileSync', 'writeFileSync', 'createReadStream',
  'opendirSync', 'appendFileSync', 'renameSync', 'chmodSync', 'utimesSync', 'fsyncSync',
]) {
  if (__profEnabled) __wrapFs(name);
}

function __profFsDump(lines) {
  lines.push('[boot-prof] sync-fs calls=' + __fsCalls + ' total=' + __profMs(__fsTotalNs) + 'ms');
  const byName = Array.from(__fsByName.entries()).sort((a, b) => Number(b[1].ns - a[1].ns)).slice(0, 12);
  for (const entry of byName) {
    lines.push('[boot-prof]   fs.' + entry[0] + '  n=' + entry[1].count +
      '  uniquePaths=' + entry[1].seen.size + '  ' + __profMs(entry[1].ns) + 'ms');
  }
  const byPath = Array.from(__fsByPath.entries()).sort((a, b) => Number(b[1].ns - a[1].ns)).slice(0, 15);
  if (byPath.length > 0) {
    lines.push('[boot-prof] slowest fs targets (>0.5ms 单次累计):');
    for (const entry of byPath) {
      lines.push('[boot-prof]   ' + __profMs(entry[1].ns) + 'ms n=' + entry[1].count + '  ' + entry[0]);
    }
  }
}

let __profDumped = false;
function __profDump(reason) {
  if (__profDumped) return;
  __profDumped = true;
  try {
    const top = Array.from(__profModules.entries()).sort((a, b) => Number(b[1] - a[1])).slice(0, 25);
    const lines = [];
    lines.push('[boot-prof] === ' + reason + ' ===');
    lines.push('[boot-prof] wall=' + __profElapsedMs() + 'ms modules=' + __profCount +
      ' moduleTotal=' + __profMs(__profTotalNs) + 'ms (解释执行下的文件读+解析+执行)');
    lines.push('[boot-prof] top modules (ms, 单次最慢):');
    for (const entry of top) {
      lines.push('[boot-prof]   ' + __profMs(entry[1]) + '  ' + entry[0]);
    }
    __profFsDump(lines);
    process.stderr.write(lines.join('\n') + '\n');
  } catch (e) {
    process.stderr.write('[boot-prof] dump failed: ' + (e && e.message) + '\n');
  }
}

// 心跳：判别「同步 CPU 阻塞」还是「异步 I/O 等待」的关键证据。
let __profBeats = 0;
const __profTimer = __profEnabled ? setInterval(() => {
  __profBeats += 1;
  process.stderr.write('[boot-prof] heartbeat #' + __profBeats + ' @' + __profElapsedMs() +
    'ms modules=' + __profCount + ' moduleTotal=' + __profMs(__profTotalNs) + 'ms\n');
  if (__profBeats >= 200) clearInterval(__profTimer);
}, 3000) : null;
if (__profTimer !== null && typeof __profTimer.unref === 'function') __profTimer.unref();

// dsh 在插件全部加载完成后才打印这一行 URL；用它作为「启动完成」的锚点。
// 仅在剖析开启时包装 console.log，避免生产路径多一层间接调用。
if (__profEnabled) {
  const __origConsoleLog = console.log.bind(console);
  console.log = function profiledLog(...args) {
    __origConsoleLog(...args);
    if (typeof args[0] === 'string' && args[0].startsWith('dsh web: ')) {
      clearInterval(__profTimer);
      __profDump('dsh web URL announced');
      // 诊断开关：配合 --cpu-prof 时需要进程正常退出才会落盘 profile。
      if (process.env.DSHM_PROF_EXIT === '1') {
        setTimeout(() => process.exit(0), 300);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------
const INVALID_HEADER_NAME = /[^\u0021\u0023-\u0027\u002a\u002b\u002d\u002e\u0030-\u0039\u0041-\u005a\u005e-\u007a\u007c\u007e]/;

class ShHeaders {
  constructor(init) {
    this._map = new Map(); // lowercase name -> [values...]
    if (init == null) return;
    if (init instanceof ShHeaders) {
      for (const [k, vals] of init._map) this._map.set(k, vals.slice());
    } else if (Array.isArray(init)) {
      for (const [k, v] of init) this.append(k, v);
    } else if (typeof init === 'object') {
      for (const k of Object.keys(init)) this.append(k, init[k]);
    }
  }
  _name(name) {
    if (typeof name !== 'string' || name.length === 0 || INVALID_HEADER_NAME.test(name)) {
      throw new TypeError(`Invalid header name: ${name}`);
    }
    return name.toLowerCase();
  }
  append(name, value) {
    const k = this._name(name);
    const arr = this._map.get(k);
    if (arr) arr.push(String(value)); else this._map.set(k, [String(value)]);
  }
  delete(name) { this._map.delete(this._name(name)); }
  get(name) {
    const arr = this._map.get(this._name(name));
    return arr ? arr.join(', ') : null;
  }
  getSetCookie() {
    const arr = this._map.get('set-cookie');
    return arr ? arr.slice() : [];
  }
  has(name) { return this._map.has(this._name(name)); }
  set(name, value) { this._map.set(this._name(name), [String(value)]); }
  entries() {
    const out = [];
    for (const [k, vals] of this._map)
      for (const v of vals) out.push([k, v]);
    return out;
  }
  keys() { return this.entries().map(([k]) => k); }
  values() { return this.entries().map(([, v]) => v); }
  forEach(cb, thisArg) { for (const [k, v] of this.entries()) cb.call(thisArg, v, k, this); }
  [Symbol.iterator]() { return this.entries()[Symbol.iterator](); }
}

// ---------------------------------------------------------------------------
// FormData (multipart encoding for SDK uploads)
// ---------------------------------------------------------------------------
function isFileLike(v) {
  return v != null && typeof v === 'object' &&
    typeof v.arrayBuffer === 'function' && typeof v.type === 'string';
}

async function encodeMultipart(fd) {
  const boundary = '----dshff' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  const parts = [];
  for (const p of fd._parts) {
    const isFile = isFileLike(p.value) || Buffer.isBuffer(p.value);
    let data;
    if (Buffer.isBuffer(p.value)) data = p.value;
    else if (isFile) data = Buffer.from(await p.value.arrayBuffer());
    else if (typeof p.value === 'string') data = Buffer.from(p.value, 'utf8');
    else data = Buffer.from(String(p.value ?? ''), 'utf8');

    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (isFile) {
      const fn = String(p.fileName || (p.value && p.value.name) || 'blob');
      head += `; filename="${fn}"\r\nContent-Type: ${(p.value && p.value.type) || 'application/octet-stream'}`;
    }
    head += '\r\n\r\n';
    parts.push(Buffer.from(head, 'latin1'), data, Buffer.from('\r\n', 'latin1'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'));
  return { boundary, buffer: Buffer.concat(parts) };
}

class ShFormData {
  constructor() { this._parts = []; }
  append(name, value, fileName) { this._parts.push({ name: String(name), value, fileName }); }
  delete(name) { this._parts = this._parts.filter((p) => p.name !== String(name)); }
  get(name) {
    const p = this._parts.find((p) => p.name === String(name));
    return p ? (p.value == null ? '' : p.value) : null;
  }
  getAll(name) {
    return this._parts.filter((p) => p.name === String(name)).map((p) => (p.value == null ? '' : p.value));
  }
  has(name) { return this._parts.some((p) => p.name === String(name)); }
  set(name, value, fileName) { this.delete(name); this.append(name, value, fileName); }
  keys() { return this._parts.map((p) => p.name); }
  values() { return this._parts.map((p) => p.value); }
  entries() { return this._parts.map((p) => [p.name, p.value]); }
  forEach(cb, thisArg) { for (const [k, v] of this.entries()) cb.call(thisArg, v, k, this); }
  *[Symbol.iterator]() { for (const p of this._parts) yield [p.name, p.value]; }
}

// ---------------------------------------------------------------------------
// Response body: a real node:stream/web ReadableStream.
//
// 历史：这里原先是一个自制的 “ReadableStream-lite”（只有 getReader +
// asyncIterator）。它在 --jitless 真机上暴露了致命缺陷：dsh 的 SSE 解析链是
//   stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream())
// （@deepseek-ai/dsh-llm-deepseek/lib/index.js 的 parseSse；MCP 的
// streamableHttp 也是同一写法），自制流没有 pipeThrough，于是 fetch 已经拿到
// HTTP 200 之后仍然抛 TypeError，被上层包成
//   LlmError("DeepSeek API stream from … failed", "TRANSPORT")
// 表现为「API key 正确、设备网络可达，但永远无法对话，只看到重试 5/5」。
//
// 现在直接返回 node:stream/web 的 ReadableStream（Node 内置纯 JS 实现，
// --jitless 下可用、不依赖 WebAssembly）：pipeThrough / pipeTo / tee /
// getReader / for await / cancel / locked 全部与标准一致，并且按 pull 拉取，
// 天然具备背压，不再把整个响应体预先堆进内存。
// ---------------------------------------------------------------------------
const ShReadableStream = require('node:stream/web').ReadableStream;

function shBodyBytes(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  if (Buffer.isBuffer(chunk)) return new Uint8Array(chunk);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return new TextEncoder().encode(String(chunk));
}

function shIsRawBody(source) {
  return typeof source === 'string' || source instanceof Uint8Array || Buffer.isBuffer(source) ||
    source instanceof ArrayBuffer || ArrayBuffer.isView(source);
}

function shRawBodyIterator(value) {
  let sent = false;
  return {
    next: async () => {
      if (sent) return { done: true, value: undefined };
      sent = true;
      return { done: false, value };
    },
  };
}

// Normalizes every body source the shim may hold into an async iterator.
function shBodyIterator(source) {
  if (source == null) return (async function* emptyBody() {})();
  if (shIsRawBody(source)) return shRawBodyIterator(source);
  if (typeof source.getReader === 'function') {
    const reader = source.getReader();
    return {
      next: () => reader.read(),
      return: async () => {
        try { await reader.cancel(); } catch (_ignoredCancel) {}
        return { done: true, value: undefined };
      },
    };
  }
  if (typeof source[Symbol.asyncIterator] === 'function') return source[Symbol.asyncIterator]();
  if (typeof source[Symbol.iterator] === 'function') return source[Symbol.iterator]();
  if (typeof source.pipe === 'function' && typeof source.on === 'function') {
    const chunks = [];
    let ended = false;
    let failure = null;
    let wake = null;
    const notify = () => { if (wake) { const resume = wake; wake = null; resume(); } };
    source.on('data', (c) => { chunks.push(c); notify(); });
    source.on('end', () => { ended = true; notify(); });
    source.on('error', (e) => { failure = e; ended = true; notify(); });
    return {
      next: async () => {
        for (;;) {
          if (chunks.length) return { done: false, value: chunks.shift() };
          if (failure) throw failure;
          if (ended) return { done: true, value: undefined };
          await new Promise((resolve) => { wake = resolve; });
        }
      },
      return: async () => {
        try { source.destroy(); } catch (_ignoredDestroy) {}
        return { done: true, value: undefined };
      },
    };
  }
  return shRawBodyIterator(String(source));
}

function makeBodyStream(source) {
  let iterator = null;
  let finished = false;
  return new ShReadableStream({
    start(controller) {
      try {
        iterator = shBodyIterator(source);
      } catch (err) {
        finished = true;
        controller.error(err);
      }
    },
    async pull(controller) {
      if (finished || iterator == null) return;
      try {
        const step = await iterator.next();
        if (step.done) {
          finished = true;
          controller.close();
          return;
        }
        controller.enqueue(shBodyBytes(step.value));
      } catch (err) {
        finished = true;
        controller.error(err);
      }
    },
    cancel(reason) {
      finished = true;
      try {
        if (iterator && typeof iterator.return === 'function') {
          const closed = iterator.return();
          if (closed && typeof closed.catch === 'function') closed.catch(() => {});
        }
      } catch (_ignoredIteratorClose) {}
      try {
        if (source && typeof source.destroy === 'function') source.destroy(reason instanceof Error ? reason : undefined);
      } catch (_ignoredSourceDestroy) {}
    },
  });
}

function isBodyStream(value) {
  return value instanceof ShReadableStream;
}

// ---------------------------------------------------------------------------
// Request / Response
// ---------------------------------------------------------------------------
class ShRequest {
  constructor(input, init = {}) {
    if (input instanceof ShRequest) {
      this._url = new URL(input._url.href);
      this._method = input._method;
      this._headers = new ShHeaders(input._headers);
      this._body = input._body;
      this._signal = input._signal;
      this._redirect = input._redirect;
    } else {
      this._url = new URL(String(input));
      this._method = 'GET';
      this._headers = new ShHeaders();
      this._body = null;
      this._signal = null;
      this._redirect = 'follow';
    }
    if (init.method) this._method = String(init.method).toUpperCase();
    if (init.headers != null) this._headers = new ShHeaders(init.headers);
    if (init.body != null && init.body !== undefined) this._body = init.body;
    if (init.signal) this._signal = init.signal;
    if (init.redirect) this._redirect = String(init.redirect);
  }
  get url() { return this._url.href; }
  get method() { return this._method; }
  get headers() { return this._headers; }
  get redirect() { return this._redirect; }
  get signal() { return this._signal; }
  get body() { return this._body; }
  get bodyUsed() { return this._bodyUsed === true; }
  /**
   * DSHM 鸿蒙适配（--jitless）：补齐 Request 的 body 读取能力。
   *
   * 为什么必须：`dsh-client-connection` 的 fetch handler 用 `await request.json()` 读取
   * RPC 信封（`{"type":"client-request","rpcId":…,"method":"<ns>/<m>",…}`）。本 shim 的
   * ShRequest 原先只有 body/bodyUsed getter、没有 text()/json()/arrayBuffer() →
   * TypeError 被该 handler 的 catch 统一包成 `400 body is not JSON` →
   * settings/describe、llm/listProviders、agentPresets/list、directoryPicker/list、
   * pluginInventory/list 全部 400，界面表现为「设置里都不可用、无法选择工作区目录」。
   *
   * 与 docs/device-runtime-fixes.md §5.1 记录的是同一处：那次修复曾让 0.1.2 环境恢复，
   * 但没有留在 scripts/_fetch-shim.cjs 里，重建环境时 shim 被覆盖 → 0.1.5 又踩回来。
   * 修改本文件后必须同步 scripts/_fetch-shim.cjs。
   */
  async _consumeBodyBytes() {
    if (this._bodyUsed === true) {
      throw new TypeError('Body is already used');
    }
    this._bodyUsed = true;
    const b = this._body;
    if (b == null) return new Uint8Array(0);
    if (typeof b === 'string') return new TextEncoder().encode(b);
    if (Buffer.isBuffer(b)) return new Uint8Array(b);
    if (b instanceof Uint8Array) return b;
    if (b instanceof ArrayBuffer) return new Uint8Array(b);
    if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (typeof b[Symbol.asyncIterator] === 'function') {
      const chunks = [];
      for await (const c of b) chunks.push(c instanceof Uint8Array ? c : Buffer.from(String(c)));
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.byteLength; }
      return out;
    }
    return new TextEncoder().encode(String(b));
  }
  async arrayBuffer() {
    const bytes = await this._consumeBodyBytes();
    const out = new Uint8Array(bytes.byteLength);
    out.set(bytes);
    return out.buffer;
  }
  async text() { return new TextDecoder('utf-8').decode(await this._consumeBodyBytes()); }
  async json() { return JSON.parse(await this.text()); }
  clone() { return new ShRequest(this); }
}

const RESPONSE_STATUS_TEXT = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 206: 'Partial Content',
  301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified',
  307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 408: 'Request Timeout', 409: 'Conflict',
  413: 'Payload Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Entity',
  429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout',
};

class ShResponse {
  constructor(body = null, init = {}) {
    this._status = init.status ?? 200;
    // 0 is legal only for Response.error(); everything else must be 200..599.
    if (this._status !== 0 && (this._status < 200 || this._status > 599)) {
      throw new RangeError(`Invalid status code ${this._status}`);
    }
    this._statusText = init.statusText != null ? String(init.statusText) : (RESPONSE_STATUS_TEXT[this._status] || '');
    this._headers = init.headers instanceof ShHeaders
      ? new ShHeaders(init.headers)
      : new ShHeaders(init.headers);
    this._url = init.url || '';
    this._redirected = !!init.redirected;
    this._body = body;
    this._bodyUsed = false;
  }
  get status() { return this._status; }
  get statusText() { return this._statusText; }
  get ok() { return this._status >= 200 && this._status < 300; }
  get headers() { return this._headers; }
  get url() { return this._url; }
  get redirected() { return this._redirected; }
  get body() {
    if (this._body == null) return null;
    if (!isBodyStream(this._body)) this._body = makeBodyStream(this._body);
    return this._body;
  }
  get bodyUsed() { return this._bodyUsed; }
  async arrayBuffer() {
    this._bodyUsed = true;
    const chunks = [];
    const body = this.body;
    if (body != null) {
      for await (const c of body) chunks.push(c instanceof Uint8Array ? c : Buffer.from(String(c)));
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out.buffer;
  }
  async text() {
    const buf = await this.arrayBuffer();
    return new TextDecoder('utf-8').decode(buf);
  }
  async json() { return JSON.parse(await this.text()); }
  async blob() {
    const ab = await this.arrayBuffer();
    const type = this.headers.get('content-type') || '';
    return new Blob([ab], { type });
  }
  clone() {
    if (this._bodyUsed) throw new TypeError('Body is already used');
    return new ShResponse(this._body, {
      status: this._status, statusText: this._statusText,
      headers: new ShHeaders(this._headers), url: this._url, redirected: this._redirected,
    });
  }
  static error() { return new ShResponse(null, { status: 0, statusText: '' }); }
  static json(data, init = {}) {
    const h = new ShHeaders(init.headers);
    if (!h.has('content-type')) h.set('content-type', 'application/json');
    return new ShResponse(JSON.stringify(data), { ...init, headers: h });
  }
  static redirect(url, status = 302) {
    if (![301, 302, 303, 307, 308].includes(status)) throw new RangeError(`Invalid redirect status code ${status}`);
    return new ShResponse(null, { status, headers: new ShHeaders({ location: String(url) }) });
  }
}

// ---------------------------------------------------------------------------
// fetch()
// ---------------------------------------------------------------------------
async function shimFetch(input, init = {}) {
  let req = new ShRequest(input, init);
  let u = new URL(req.url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new TypeError(`fetch() only supports http/https in shim, got ${u.protocol}`);
  }

  let redirectCount = 0;
  for (;;) {
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const headers = new ShHeaders(req.headers);
    req._headers = headers;

    // ---- encode request body ----
    let bodyBuf = null;
    if (req._body != null) {
      const b = req._body;
      if (typeof b === 'string') bodyBuf = Buffer.from(b, 'utf8');
      else if (b instanceof Uint8Array) bodyBuf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
      else if (b instanceof ShFormData) {
        const { boundary, buffer } = await encodeMultipart(b);
        if (!headers.has('content-type')) headers.set('content-type', `multipart/form-data; boundary=${boundary}`);
        bodyBuf = buffer;
      } else if (b && typeof b[Symbol.asyncIterator] === 'function') {
        const chunks = [];
        for await (const c of b) chunks.push(c instanceof Uint8Array ? Buffer.from(c) : Buffer.from(String(c)));
        bodyBuf = Buffer.concat(chunks);
      } else if (b && typeof b.pipe === 'function') {
        throw new Error('Streaming (pipe) request bodies are not supported by the shim');
      } else {
        bodyBuf = Buffer.from(String(b), 'utf8');
      }
    }

    // ---- request headers ----
    const hdrs = {};
    for (const [k, v] of headers.entries()) {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'content-length' || lk === 'transfer-encoding' || lk === 'connection') continue;
      hdrs[k] = hdrs[k] ? hdrs[k] + ', ' + v : v;
    }
    if (bodyBuf && !hdrs['content-length']) hdrs['content-length'] = String(bodyBuf.length);

    // ---- dispatch ----
    let resolveResp;
    const respPromise = new Promise((resolve) => { resolveResp = resolve; });
    let socketAborted = false;

    const serverReq = lib.request({
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: req.method,
      headers: hdrs,
    }, (incoming) => resolveResp({ res: incoming }));
    serverReq.on('error', (e) => resolveResp({ err: e }));
    if (req.signal) {
      const onAbort = () => { socketAborted = true; serverReq.destroy(new Error('Aborted')); };
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener('abort', onAbort, { once: true });
    }
    if (bodyBuf) serverReq.end(bodyBuf);
    else serverReq.end();

    const { res, err } = await respPromise;
    if (err || !res) {
      if (socketAborted) {
        const abortErr = new Error('This operation was aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      throw err || new Error('No response received');
    }

    // ---- parse response headers ----
    const outHeaders = new ShHeaders();
    for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
      const k = res.rawHeaders[i].toLowerCase();
      const v = res.rawHeaders[i + 1];
      if (k === 'set-cookie') outHeaders.append('set-cookie', v);
      else {
        const arr = outHeaders._map.get(k);
        if (arr) arr.push(v); else outHeaders._map.set(k, [v]);
      }
    }

    // ---- redirects ----
    if ([301, 302, 303, 307, 308].includes(res.statusCode) &&
        req.redirect === 'follow' && redirectCount < kMaxRedirects) {
      const loc = outHeaders.get('location');
      if (loc) {
        res.resume(); // drain old socket
        const nextUrl = new URL(loc, u);
        let nextMethod = req.method;
        let nextBody = req._body;
        if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && req.method === 'POST')) {
          nextMethod = 'GET';
          nextBody = null;
        }
        req = new ShRequest(nextUrl.href, { method: nextMethod, signal: req.signal });
        req._body = nextBody;
        u = nextUrl;
        redirectCount++;
        continue;
      }
    }

    // ---- body ----
    let outBody = null;
    const noBodyStatus = res.statusCode === 204 || res.statusCode === 304 || req.method === 'HEAD';
    if (!noBodyStatus) {
      const enc = (outHeaders.get('content-encoding') || '').toLowerCase();
      if (enc && (enc.includes('gzip') || enc.includes('deflate') || enc.includes('br'))) {
        try {
          const chunks = [];
          for await (const c of res) chunks.push(Buffer.from(c));
          const full = Buffer.concat(chunks);
          const dec = enc.includes('br') ? zlib.brotliDecompressSync(full)
                    : enc.includes('gzip') ? zlib.gunzipSync(full)
                    : zlib.inflateSync(full);
          outBody = makeBodyStream(new Uint8Array(dec));
          outHeaders._map.delete('content-encoding');
          outHeaders._map.delete('content-length');
        } catch (e) {
          outBody = makeBodyStream('');
        }
      } else {
        outBody = makeBodyStream(res);
      }
    } else {
      res.resume();
    }

    return new ShResponse(outBody, {
      status: res.statusCode || 200,
      statusText: res.statusMessage || RESPONSE_STATUS_TEXT[res.statusCode] || '',
      headers: outHeaders,
      url: u.href,
      redirected: redirectCount > 0,
    });
  }
}

// ---------------------------------------------------------------------------
// Event stubs — inert replacements, fail cleanly instead of loading undici.
// ---------------------------------------------------------------------------
const WS_CONNECTING = 0, WS_OPEN = 1, WS_CLOSING = 2, WS_CLOSED = 3;

class ShMessageEvent {
  constructor(type, init = {}) {
    this.type = String(type);
    this.data = init.data ?? null;
    this.origin = init.origin ?? '';
    this.lastEventId = init.lastEventId ?? '';
    this.source = init.source ?? null;
    this.ports = init.ports ?? [];
    this.cancelable = false;
  }
}
class ShCloseEvent {
  constructor(type, init = {}) {
    this.type = String(type);
    this.code = init.code ?? 1000;
    this.reason = init.reason ?? '';
    this.wasClean = init.wasClean ?? false;
  }
}
class ShErrorEvent {
  constructor(type, init = {}) {
    this.type = String(type);
    this.message = init.message ?? '';
    this.filename = init.filename ?? '';
    this.lineno = init.lineno ?? 0;
    this.colno = init.colno ?? 0;
    this.error = init.error ?? null;
  }
}

function makeInertSocket(name) {
  return class extends ShEventTarget2 {
    constructor(url, opts) {
      super();
      this.url = String(url);
      this.readyState = WS_CONNECTING;
      this.CONNECTING = WS_CONNECTING;
      this.OPEN = WS_OPEN;
      this.CLOSING = WS_CLOSING;
      this.CLOSED = WS_CLOSED;
      this.bufferedAmount = 0;
      this.binaryType = 'blob';
      this.extensions = '';
      this.protocol = '';
      this.onopen = this.onerror = this.onclose = this.onmessage = null;
      // Clean, immediate failure: no connection is ever attempted, no undici.
      setImmediate(() => {
        this.readyState = WS_CLOSED;
        this._fire('error', new ShErrorEvent('error', { message: `${name} is unavailable in --jitless mode` }));
        this._fire('close', new ShCloseEvent('close', { code: 1006, reason: `${name} unavailable` }));
      });
    }
    send() { throw new Error(`${name}.send() is unavailable in --jitless mode`); }
    close(code, reason) { this.readyState = WS_CLOSED; }
  };
}

class ShEventTarget2 {
  constructor() {
    this._listeners = new Map();
  }
  addEventListener(type, cb) {
    if (typeof cb !== 'function') return;
    const set = this._listeners.get(type) || new Set();
    set.add(cb);
    this._listeners.set(type, set);
  }
  removeEventListener(type, cb) {
    const set = this._listeners.get(type);
    if (!set) return;
    set.delete(cb);
    if (set.size === 0) this._listeners.delete(type);
  }
  dispatchEvent(evt) {
    const set = this._listeners.get(evt && evt.type);
    if (set) for (const cb of [...set]) cb.call(this, evt);
    return true;
  }
  _fire(type, evt) {
    this.dispatchEvent(evt);
    const prop = this['on' + type];
    if (typeof prop === 'function') {
      try { prop.call(this, evt); } catch (e) { /* swallow */ }
    }
  }
}

const ShWebSocket = makeInertSocket('WebSocket');
Object.assign(ShWebSocket, {
  CONNECTING: WS_CONNECTING, OPEN: WS_OPEN, CLOSING: WS_CLOSING, CLOSED: WS_CLOSED,
});
class ShEventSource extends makeInertSocket('EventSource') {
  constructor(url, opts) {
    super(url, opts);
    this.withCredentials = !!(opts && opts.withCredentials);
    this.reconnect = true;
    this.readyState = 2; // CLOSED (per our failure path)
  }
  close() { this.readyState = 2; }
}
ShEventSource.CONNECTING = 0;
ShEventSource.OPEN = 1;
ShEventSource.CLOSED = 2;

// ---------------------------------------------------------------------------
// Install onto globalThis (before anything can touch the undici getters).
// ---------------------------------------------------------------------------
function installGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

// ---------------------------------------------------------------------------
// JIT 模式（方案 A）下不覆盖任何 Web 全局：
//   有 ohos.permission.kernel.ALLOW_EXECUTABLE_FORT_MEMORY 的签名里 node 不带
//   --jitless 启动，真 WebAssembly/undici fetch 全部可用。shim 此时只做诊断日志
//   （WebAssembly 桩本身已是条件式：真全局存在时不装）。
// 判定：node --jitless 会把 process.execArgv 含 --jitless；或 V8 报告无 JIT。
// ---------------------------------------------------------------------------
const execArgv = (process.execArgv || []);
const isJitless = execArgv.includes('--jitless');
if (isJitless) {
  installGlobal('fetch', shimFetch);
  installGlobal('Headers', ShHeaders);
  installGlobal('Request', ShRequest);
  installGlobal('Response', ShResponse);
  installGlobal('FormData', ShFormData);
  installGlobal('MessageEvent', ShMessageEvent);
  installGlobal('CloseEvent', ShCloseEvent);
  installGlobal('ErrorEvent', ShErrorEvent);
  installGlobal('WebSocket', ShWebSocket);
  installGlobal('EventSource', ShEventSource);
  process.stderr.write('[fetch-shim] jitless mode: globals shimmed (fetch=' +
    globalThis.fetch.name + ')\n');
} else {
  process.stderr.write('[fetch-shim] JIT mode detected: native WebAssembly/undici available, globals untouched\n');
}

// ---- diagnostics: prove preload order + catch undici loaders ----
process.stderr.write('[fetch-shim] installed globals; fetch.name=' +
  globalThis.fetch.name + ' instanceof=' + (globalThis.fetch instanceof Function) + '\n');
const fetchDesc = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
process.stderr.write('[fetch-shim] fetch desc: writable=' + !!fetchDesc.writable +
  ' configurable=' + !!fetchDesc.configurable + '\n');

const CJS = (() => { try { return require('internal/modules/cjs/loader'); } catch { return null; } })();
if (CJS) {
  const origLoad = CJS.Module._load;
  CJS.Module._load = function (request, ...rest) {
    if (typeof request === 'string' && request.includes('undici')) {
      process.stderr.write('[fetch-shim] !!! CJS require of undici: ' + request +
        '\n' + new Error('marker').stack + '\n');
    }
    return origLoad.call(this, request, ...rest);
  };
  process.stderr.write('[fetch-shim] CJS loader hooked\n');
}
// ESM import of undici is NOT hooked here on purpose: module.registerHooks()
// puts every subsequent module load (including internal/deps/undici) through
// a fresh-context pipeline where globalThis mutations made by this preload
// are invisible, so undici then sees no WebAssembly stub at all. The CJS
// hook above stays as the load tracer; ESM-side, if the app imports undici
// at all, the globals + stub installed here still cover it.

globalThis.__fetchShimLoaded = { status: 'ok', undici: isJitless ? 'blocked' : 'native' };

process.stderr.write('[fetch-shim] loaded OK\n');
// ---------------------------------------------------------------------------
// Worker-thread coverage: in jitless mode every worker thread also lacks
// WebAssembly (fresh global context). In JIT mode workers inherit native
// WebAssembly, so the wrap is only needed for jitless.
// ---------------------------------------------------------------------------
try {
  const workerThreads = require('node:worker_threads');
  if (workerThreads.isMainThread && workerThreads.Worker && isJitless) {
    const shimPath = __filename;
    const OrigWorker = workerThreads.Worker;
    class ShimWorker extends OrigWorker {
      constructor(filename, options = {}) {
        const execArgv = Array.isArray(options.execArgv) ? [...options.execArgv] : [];
        if (!execArgv.includes('-r') && !execArgv.includes('--require')) {
          execArgv.push('-r', shimPath);
        }
        super(filename, { ...options, execArgv });
      }
    }
    workerThreads.Worker = ShimWorker;
    process.stderr.write('[fetch-shim] Worker wrapped; worker threads will preload shim\n');
  }
} catch (e) {
  process.stderr.write('[fetch-shim] worker wrapping unavailable: ' + e.message + '\n');
}

process.stderr.write('[fetch-shim] worker coverage done\n');

// ---------------------------------------------------------------------------
// DSHM 结构化启动状态（boot-state.json）
//
// 目标：ArkTS 侧不再轮询/刮削 node-*.log 去猜「dsh 是否就绪、带 token 的 URL 是什么」——
// dsh 打印带 token 的 URL 那一刻，由本预加载脚本一次性把结构化状态原子写盘
// （tmp + rename），壳侧读单文件即可，消灭「先监听端口、后打印 URL」之间的白屏窗口
// （实测 waitForServer 6.7s 就绪而 token 40-60s 才落盘）。
//
// 环境变量 DSHM_FILES_DIR 由 libdsh_host 注入（与 DSHM_KOFFI_PATH 同批）。
// 注意：本块必须由脚本生成（手改环境树会在重建时丢失，2026-09-13 踩过）。
// 剖析模式（DSHM_BOOT_PROFILE=1）已自行包装 console.log，这里让位。
// ---------------------------------------------------------------------------
if (!__profEnabled) {
  try {
    const bootFilesDir = process.env.DSHM_FILES_DIR;
    if (typeof bootFilesDir === 'string' && bootFilesDir.length > 0) {
      const bootStatePath = bootFilesDir + '/boot-state.json';
      const bootTmpPath = bootStatePath + '.tmp';
      const bootFs = require('node:fs');
      const bootOrigLog = console.log.bind(console);
      let bootStateWritten = false;
      console.log = function bootStateLog(...args) {
        bootOrigLog(...args);
        if (bootStateWritten || typeof args[0] !== 'string' || !args[0].startsWith('dsh web: ')) {
          return;
        }
        bootStateWritten = true;
        try {
          const line = args[0];
          const at = line.indexOf('http://');
          const url = at >= 0 ? line.slice(at).trim() : '';
          // URL 尚无 token 时（dsh 先监听后打印的窗口期）不写盘，保留壳侧刮削回退，
          // 避免写入半截状态让 ArkTS 提前判定就绪。
          if (!url.startsWith('http://') || url.indexOf('token=') < 0) {
            bootStateWritten = false;
            return;
          }
          const payload = {
            mode: 'embedded',
            pid: process.pid,
            url,
            dshVersion: typeof process.env.DSHM_DSH_VERSION === 'string' ? process.env.DSHM_DSH_VERSION : '',
            nodeVersion: process.version,
            arch: process.arch,
            readyAt: new Date().toISOString(),
          };
          bootFs.writeFileSync(bootTmpPath, JSON.stringify(payload, null, 2) + '\n');
          bootFs.renameSync(bootTmpPath, bootStatePath);
        } catch (bootError) {
          /* 写失败不影响服务；壳侧仍有日志刮削回退 */
        }
      };
    }
  } catch (bootSetupError) {
    /* 装配失败同样静默 */
  }
}
