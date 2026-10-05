'use strict';
/*
 * jitless 运行期的端侧补齐层（**单份实现**，主线程与 worker 线程共用）。
 *
 * ---------------------------------------------------------------------------
 * 为什么要抽成一份
 * ---------------------------------------------------------------------------
 * `--jitless`（端侧硬约束：OHOS 不允许 W^X 的 JIT 页）在 V8 里连带关掉了 WASM，
 * 于是 `WebAssembly === undefined`。Node 自带的一整圈东西因此不可用：
 *   · `globalThis.fetch` —— undici 的解析器是 WASM 版 llhttp，一连接就抛
 *     `WebAssembly is not defined`；
 *   · 裸 `undici` 说明符 —— 上游 `dsh-web-fetch-http` / `dsh-http-proxy` 自己
 *     `await import("undici")` 建 Agent，绕开全局 fetch；
 *   · `node:http`/`node:https` 的惰性 undici getter（`lazyUndici`）；
 *   · `node-addon-require-builtin`（Node-API addon 没有 openharmony 平台包）。
 *
 * 这些补齐原先只装在**主线程**（main.js 里的五个 IIFE）。2026-10-04 的真机证据
 * 说明这不够：开发者工具里的 `@deepseek-ai/dsh-experimental-inspector` 激活时会
 * `new Worker('./worker.js')`，而**worker 线程不会继承主线程的任何 monkey-patch**
 * ——新线程有全新的 globalThis 与 module registry。于是那个 worker 里
 * `globalThis.fetch` 又是 Node 原生实现、`node-addon-require-builtin` 又是真包，
 * 插件激活直接失败（用户可见：`启用失败: dsh: warning: 1 entry did not activate`，
 * 报错栈 `lazyllhttp … WebAssembly is not defined`）。
 *
 * 【为什么必须是同一份实现】主线程与 worker 是同一套约束的两处落点。抄一份必然
 * 漂移：worker 侧悄悄少一条补齐，症状又是"只有某个插件坏"这种极难归因的形态。
 * 所以这里只留单份实现，两侧都调它。
 *
 * 【与上游的边界】本文件不碰核心树一个字节：全部是运行期的 hook / 覆盖。
 */

const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');

const NOOP = () => {};

/* ─────────────────────────── 1. node:http/https 惰性 undici ─────────────────────────── */

/**
 * 阻断 `node:http` / `node:https` 的惰性 undici 初始化。
 *
 * 【关键栈帧（D6 E38）】`at lazyUndici (node:http:123:21)`。Node 22+ 用 undici 实现
 * `http.Agent` / `globalAgent` 等；只要在任何人访问之前把**所有惰性 getter** 定义掉，
 * 那条路径就不会被触发，也就不需要 WebAssembly。
 * 【为什么不能先读原值】读一下就触发初始化——只能用 getOwnPropertyDescriptor 看描述符。
 *
 * @param {(line: string) => void} [log]
 */
function sealHttpLazyUndici(log = NOOP) {
  /*
   * 【只在 jitless 下封】封 getter 的目的是**不让** `node:http` 的惰性 getter 把
   * undici（WASM 版 llhttp）拉起来。WASM 可用时（PC 侧 dev-host）不需要这个保护，
   * 而封掉会**反噬原生实现**：`maxHeaderSize` 被换成 `{}` 后，原生 undici 直接报
   * `fetch failed / cause: http module not available or http.maxHeaderSize invalid`
   * ——2026-10-04 在 worker 里实测到这条读数（同一份"封 + 不垫"在 PC 上必然如此）。
   * 端侧永远是 jitless，所以这个条件对真机行为零影响。
   */
  if (typeof WebAssembly !== 'undefined') {
    log('WASM 可用：保留 node:http/https 的惰性 getter（原生 fetch/undici 需要它们）');
    return false;
  }
  try {
    for (const modName of ['node:http', 'node:https']) {
      const mod = require(modName);
      const getters = [];
      for (const name of Object.getOwnPropertyNames(mod)) {
        const desc = Object.getOwnPropertyDescriptor(mod, name);
        if (desc !== undefined && desc.get !== undefined) {
          getters.push(name);
          Object.defineProperty(mod, name, { value: {}, writable: true, configurable: true });
        }
      }
      log(`${modName} 的惰性 getter（已全部封掉）：${getters.join(', ') || '(无)'}`);
    }
    return true;
  } catch (e) {
    log(`封掉惰性 getter 失败：${String(e)}`);
    return false;
  }
}

/* ─────────────────────────── 2. 原生库重定向 ─────────────────────────── */

/**
 * 解析 HAP 里扁平原生库目录（`libs/arm64`）。
 * 入口脚本在 `<bundle>/entry/resources/resfile/resources/app/main.js`，
 * 原生库在 `<bundle>/libs/arm64/`（真机崩溃日志里的 libelectron.so 路径可证）。
 */
function resolveNativeLibsDir(appDir) {
  if (process.env.DSHM_NATIVE_LIBS && process.env.DSHM_NATIVE_LIBS.length > 0) {
    return process.env.DSHM_NATIVE_LIBS;
  }
  try {
    const bundleRoot = path.resolve(appDir === undefined ? __dirname : appDir, '../../../../../');
    return path.join(bundleRoot, 'libs', 'arm64');
  } catch (e) {
    return '';
  }
}

/** 沙箱内的 .node 路径 → libs/ 下的平铺文件名。约定：`lib<去掉扩展名的包名>.so` */
function flatNativeName(basename) {
  const stem = String(basename).replace(/\.node$/, '');
  return `lib${stem}.so`;
}

/**
 * 把"沙箱里的 .node"重定向到 HAP 的 libs/ 下加载（D6 E39，真机实测）。
 *
 * 【问题】运行时解包到**沙箱**里的原生库，`dlopen` 会被系统拦：
 *   `Error loading shared library …/koffi.node: No error information`
 * 而放在 HAP `libs/` 里的库可以正常加载（E18 已证，即使没有 `.codesign`）。
 * hvigor 又**只打包扁平的 `libs/<abi>/*.so`**（嵌套的 `.node` 不会被复制进产物），
 * 所以没法按 loader 的候选路径原样摆放。
 *
 * 【办法】不改任何第三方包：原生包的 loader 在 `require` 之前都会先 `fs.existsSync`
 * 候选路径，而真正加载 `.node` 一定经过 `Module._extensions['.node']`，于是同时接管：
 *   1) `existsSync` 对"沙箱里不存在、但 libs/ 里有同名平铺文件"的 .node 路径返回 true；
 *   2) `.node` 扩展加载器把实际路径改写成 libs/ 下的平铺文件；
 *   3) `_resolveFilename`：裸相对路径的 .node 请求（node-pty 的
 *      `require('prebuilds/openharmony-arm64/pty.node')`）在 Node 里按**包名**解析，
 *      `Module._findPath` 阶段就 MODULE_NOT_FOUND，走不到扩展 hook（真机实测：sharp ok
 *      而 node-pty 报 Cannot find module）；app-boot 的 installProfileResolution 之后会
 *      再包一层 `_resolveFilename`，它保存的"原函数"就是这个 hook，链不丢；
 *   4) `_resolveFilename` 返回的 flat 以 `.so` 结尾，Node 没有该后缀的处理器会 fallback
 *      到 '.js' 把 ELF 当源码读——补一个 `.so` 处理器（= 原 .node loader / process.dlopen）。
 *
 * @param {{ libsDir?: string, appDir?: string, log?: (line: string) => void }} [options]
 */
function installNativeRedirect(options = {}) {
  const log = options.log === undefined ? NOOP : options.log;
  const libsDir = options.libsDir === undefined ? resolveNativeLibsDir(options.appDir) : options.libsDir;
  try {
    if (String(libsDir).length === 0 || !fs.existsSync(libsDir)) {
      log(`原生库重定向未启用（NATIVE_LIBS=${libsDir}）`);
      return false;
    }
    const realExists = fs.existsSync.bind(fs);
    const redirect = (p) => {
      try {
        if (typeof p !== 'string' || !p.endsWith('.node')) return null;
        const flat = path.join(libsDir, flatNativeName(path.basename(p)));
        return realExists(flat) ? flat : null;
      } catch (e) {
        return null;
      }
    };
    fs.existsSync = function (p) {
      return redirect(p) !== null ? true : realExists(p);
    };
    const loader = Module._extensions['.node'];
    Module._extensions['.node'] = function (mod, filename) {
      const flat = redirect(filename);
      return loader.call(this, mod, flat !== null ? flat : filename);
    };
    const realResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, parent, isMain, opts) {
      try {
        if (typeof request === 'string' && request.endsWith('.node')) {
          const flat = redirect(request);
          if (flat !== null) return flat;
        }
      } catch (e) {
        /* fallthrough：按原逻辑解析 */
      }
      return realResolve.apply(this, arguments);
    };
    if (!Module._extensions['.so']) {
      Module._extensions['.so'] = function (mod, filename) {
        return loader.call(this, mod, filename);
      };
    }
    log(`原生库重定向已启用：libs=${libsDir}（含 _resolveFilename/.so 处理器）`);
    return true;
  } catch (e) {
    log(`原生库重定向安装失败：${String(e)}`);
    return false;
  }
}

/* ─────────────────────────── 3. node-addon-require-builtin ─────────────────────────── */

/**
 * `node-addon-require-builtin` → 端侧 JS shim（配合 `--expose-internals`）。
 *
 * 【为什么必须拦】0.1.6-alpha.2 起 host preparation 必经 internalModules()：
 * `dsh-app-boot/lib/index.js`（installProfileResolution）、
 * `dsh-app-boot/lib/worker/profile-resolution-bootstrap.js`（**worker 侧**）、
 * `cordis-plugin-loader/lib/index.js` 都 `require("node-addon-require-builtin")`
 * （Node-API addon，平台包只有 darwin/linux-gnu/win32）。真机没有对应平台包，报
 * `No usable native binding found for node-addon-require-builtin-openharmony-arm64 (auto)`。
 * 实现见 ./require-builtin-shim.cjs（纯 JS，`--expose-internals` 下等价）。
 *
 * 【为什么拦 _load 而不是 _resolveFilename】app-boot 的 installProfileResolution
 * 会**替换** `Module._resolveFilename`（profile 路由，enforce/restore），拦同一函数容易被
 * 它卷进去；`_load` 不在其 patch 清单里，且 CJS require（含 createRequire）必经。
 */
function installRequireBuiltinShim(log = NOOP) {
  try {
    if (Module.__dshmRequireBuiltinShim === true) {
      log('node-addon-require-builtin shim 已安装（跳过重复安装）');
      return true;
    }
    const shim = require('./require-builtin-shim.cjs');
    const realLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'node-addon-require-builtin') return shim;
      return realLoad.apply(this, arguments);
    };
    Module.__dshmRequireBuiltinShim = true;
    log('node-addon-require-builtin → 端侧 JS shim（--expose-internals）');
    return true;
  } catch (e) {
    log(`node-addon-require-builtin shim 安装失败：${String(e)}`);
    return false;
  }
}

/* ─────────────── 3b. 内建 undici 拦截（MessagePort 每投递必炸的根因） ─────────────── */

/**
 * 把 Node **内部**按完整路径 require 的 `internal/deps/undici/undici` 指到纯 JS 垫片。
 *
 * 【真机根因（2026-10-05 端侧报告 + 本机复现）】`--jitless` 下 `WebAssembly` 不可用，
 * 而端侧 Node v24.2.0 的内建 undici **在模块初始化阶段**就 `new Agent()`（lib/global.js）
 * ⇒ 一加载就抛 `ReferenceError: WebAssembly is not defined`。谁在加载它？
 *
 *   1. `lib/internal/worker/io.js` 的 `onMessageEvent()`：
 *      每条 MessagePort 消息投递都 `require('internal/deps/undici/undici').createFastMessageEvent`。
 *      用 `new MessageChannel()` 做 Host↔Worker 通信的插件（如
 *      `@deepseek-ai/dsh-experimental-inspector`，lib/index.js:1805）**第一条消息即炸**
 *      → entry 激活失败 → 它的 `/api/experimental-inspector/bootstrap` 从未注册（一直 404）。
 *   2. `exposeLazyInterfaces(globalThis, 'internal/deps/undici/undici', [...])`：
 *      `globalThis` 上 `Headers/Request/Response/FormData/MessageEvent/CloseEvent/
 *      WebSocket/EventSource` 的**惰性 getter** 第一次被读也要 require 它。
 *
 * 【为什么前四个入口都拦不到，以及**为什么拦 `Module._load` 也不对**】
 * 全局 fetch 垫片、裸说明符 `undici` 的解析钩子、`node:http` 惰性 getter 封堵、
 * require-builtin 垫片——都在 userland 那一层。而 Node **内部模块**的 require 走的是
 * `requireBuiltin()` → `BuiltinModule.prototype.compileForInternalLoader()`
 * （`internal/worker/io.js` 的 id 以 `internal/` 开头，不是 `internal/deps/`，
 * 所以它拿到的是 `requireBuiltin`），**与 `Module._load` 完全没有交集**。
 * 2026-10-05 真机 v2 报告 + 反编译 `libnode.so.137` 确认了这一点：
 * 上一版把钩子挂在 `Module._load` 上，等于"装了但没接上线"（日志打了、故障照旧）。
 *
 * 【正确的落点】`BuiltinModule.map.get('internal/deps/undici/undici')`：
 * 把它的 `exports` 预置成垫片并置 `loaded = true`，`compileForInternalLoader()`
 * 第一行 `if (this.loaded || this.loading) return this.exports;` 就直接返回垫片。
 * 该类在 `--expose-internals` 下可达（借任一 public builtin 的实例取 `constructor`）。
 * 本机已实测：预置后 MessagePort 的 `onmessage` 事件由本垫片的 `MessageEvent` 构造
 * （即 `internal/worker/io.js` 的 `lazyMessageEvent` 真的走了垫片）。
 *
 * 【为什么这条也顺带修好了 globalThis 的惰性接口】那些 getter 内部同样是
 * `require('internal/deps/undici/undici')` 取成员，走的是同一个 BuiltinModule 路径
 * ⇒ 拿到垫片的实现（本机实测 `globalThis.MessageEvent === 垫片.MessageEvent`）。
 * `Module._load` 钩子保留，但只作 userland 直接 require 的补充。
 *
 * 【控制实验】`DSHM_NO_INTERNAL_UNDICI_SHIM=1` 时不安装，用来复现修复前的失败形态；
 * 回归门禁 tools/check-internal-undici.mjs 的对照臂靠它成立。
 */
function installInternalUndiciShim(log = NOOP) {
  if (typeof WebAssembly !== 'undefined') {
    log('WASM 可用，保留 Node 内建 undici（未拦截）');
    return false;
  }
  if (process.env.DSHM_NO_INTERNAL_UNDICI_SHIM === '1') {
    log('内建 undici 拦截已被 DSHM_NO_INTERNAL_UNDICI_SHIM=1 显式关闭（控制实验用）');
    return false;
  }
  try {
    if (Module.__dshmInternalUndiciShim === true) {
      log('内建 undici 拦截已安装（跳过重复安装）');
      return true;
    }
    const shim = require('./internal-undici-shim.cjs');
    const ID = 'internal/deps/undici/undici';

    /* ── 主入口：BuiltinModule（Node **内部** require 的真正落点） ──
     * 见函数头注释与 docs/parity-matrix：`internal/worker/io.js` 走 requireBuiltin，
     * 不经过 Module._load。--expose-internals 下可借 public builtin 实例取到该类。 */
    const helpers = require('internal/modules/helpers');
    const probe = helpers.loadBuiltinModule('module');
    const BuiltinModule = probe && probe.constructor;
    if (typeof BuiltinModule !== 'function' || BuiltinModule.map === undefined) {
      throw new Error('取不到 BuiltinModule（--expose-internals 未生效？）');
    }
    const target = BuiltinModule.map.get(ID);
    if (target === undefined) throw new Error(`BuiltinModule.map 里没有 ${ID}`);
    const wasLoaded = target.loaded === true;
    target.exports = shim;
    target.loaded = true;
    target.loading = false;

    /* 兜底：id 变体或后续被重置的情况。失败只记日志，不影响上面的主入口。 */
    try {
      const proto = BuiltinModule.prototype;
      if (proto.__dshmInternalUndiciPatched !== true) {
        const orig = proto.compileForInternalLoader;
        proto.compileForInternalLoader = function () {
          if (this.id === ID || this.id === `${ID}.js`) {
            this.exports = shim;
            this.loaded = true;
            return this.exports;
          }
          return orig.call(this);
        };
        Object.defineProperty(proto, '__dshmInternalUndiciPatched', { value: true });
      }
    } catch (e) {
      log(`BuiltinModule 原型兜底未装上（不影响主入口）：${e && e.message}`);
    }

    /* 补充：userland 直接 require('internal/...') 时可能仍走 Module._load */
    const realLoad = Module._load;
    Module._load = function (request) {
      if (request === ID || request === `node:${ID}`) return shim;
      return realLoad.apply(this, arguments);
    };

    /*
     * 安装期自检（v2 §2.1）：宁可当场报"没接上"，也不要再出现"日志说装了、实际没用"。
     *
     * 【自检必须**有判别力**】不能只写 `BuiltinModule.map.get(ID).exports === shim`
     * ——那只是复核上面自己刚赋的值，恒为真（2026-10-05 审核指出：这种自检等于同义反复）。
     * 这里多查一条真正走"内部加载路径"的断言：`require(ID) === shim`
     * （走 compileForPublicLoader → compileForInternalLoader）。
     * 幂等标志位**放到自检通过之后**再置，否则失败后再调会走早退分支谎报"已安装"。
     */
    let exportsOk = false;
    let requireOk = false;
    try {
      exportsOk = BuiltinModule.map.get(ID).exports === shim;
      requireOk = require(ID) === shim;
    } catch (e) {
      requireOk = false;
    }
    let lazyState = '未知';
    try {
      lazyState = globalThis.MessageEvent === shim.MessageEvent ? 'ok' : '未接管';
    } catch (e) {
      lazyState = `读取即抛错（${e && e.message}）`;
    }
    const selfOk = exportsOk && requireOk && lazyState === 'ok';
    log(
      `内建 undici → 纯 JS 垫片（BuiltinModule 层拦截；自检 exports=${exportsOk ? 'ok' : 'FAIL'}`
      + `、require=${requireOk ? 'ok' : 'FAIL'}`
      + `、globalThis.MessageEvent=${lazyState}`
      + `${wasLoaded ? '；安装前该模块已被加载过' : ''}）`,
    );
    if (!selfOk) {
      log('内建 undici 拦截自检失败：内部加载路径未指向垫片（MessageChannel 型插件仍会失败）');
      return false; // 不置幂等位 ⇒ 后续仍可重试安装
    }
    Module.__dshmInternalUndiciShim = true;
    return true;
  } catch (e) {
    log(`内建 undici 拦截安装失败（MessageChannel 型插件仍会失败）：${e && e.message}`);
    return false;
  }
}

/* ─────────────────────────── 4. jitless fetch 垫片（D6 E52） ─────────────────────────── */

/**
 * 安装 jitless fetch 垫片。
 *
 * 【为什么必须有】`--jitless` 隐含关掉 WASM，而 Node 自带 undici 用 WASM 版 llhttp
 * ⇒ 原生 fetch 在端侧不可用。但 dsh **调模型就是用 fetch**（`dsh-llm-deepseek`）——
 * 不垫它，"Host 起来了"也只是个不能干活的空壳。垫片基于 `node:http`/`node:https`
 * （原生 llhttp，与 WASM 无关），见 fetch-shim.js 的文件头。
 *
 * 只在原生 fetch 不可用（缺失，或 WASM 不可用即 jitless）时覆盖：本机调试（有 WASM）
 * 时用的仍是原生实现。
 */
function installJitlessFetch(log = NOOP) {
  try {
    const shim = require('./fetch-shim.js');
    const installed = shim.installFetchShim();
    log(installed
      ? 'jitless fetch 垫片已安装（基于 node:http/https；原生 fetch 不可用）'
      : '原生 fetch 可用，未安装 jitless 垫片');
    return installed;
  } catch (e) {
    log(`fetch 垫片安装失败：${e && e.message}`);
    return false;
  }
}

/* ─────────────────────────── 5. undici 模块名解析钩子 ─────────────────────────── */

/**
 * jitless 下的 `undici` **模块名**解析钩子（与 fetch 垫片是同一件事的另一半）。
 *
 * 【为什么光有垫片还不够】垫片解决的是"全局 fetch 不可用"，但上游
 * `dsh-web-fetch-http` **不用全局 fetch**：它 `await import("undici")` 自建 Agent，
 * 再把 `dispatcher` 传进 fetch。而 undici 的 HTTP 解析器是 WASM 版 llhttp
 * ⇒ jitless 下 `new Agent()` 一连接就抛 `WebAssembly is not defined`。
 * `dsh-http-proxy` 同理（`await import("undici")` 装全局 dispatcher）。
 *
 * 【怎么修】注册解析钩子把 `undici` 指到本仓 undici-shim.mjs：**运行期组合**，
 * 不改上游源码、不改核心树。钩子同时翻译 `dispatcher` → 垫片认识的 `lookup`，
 * 从而保住上游的 DNS 钉住/SSRF 防护。
 *
 * 【注册条件】只在 WASM 不可用（jitless）时注册。原生 undici 可用时不该被替换。
 *
 * 【已知未验项】`register()` 的钩子跑在 Node 的**独立线程**里；端侧嵌入式运行时是否
 * 允许起线程属真机待验收项（docs/parity-matrix.md §3.2）。故失败时只降级、不阻断启动。
 */
function installUndiciNameHook(log = NOOP) {
  if (typeof WebAssembly !== 'undefined') {
    log('WASM 可用，保留原生 undici（未注册解析钩子）');
    return false;
  }
  try {
    if (Module.__dshmUndiciHook === true) {
      log('undici 解析钩子已注册（跳过重复注册）');
      return true;
    }
    const { register } = require('node:module');
    const { pathToFileURL } = require('node:url');
    register(pathToFileURL(path.join(__dirname, 'undici-loader.mjs')).href,
      pathToFileURL(__filename).href);
    Module.__dshmUndiciHook = true;
    log('undici 解析钩子已注册（web_fetch 走本仓垫片，绕开 WASM）');
    return true;
  } catch (e) {
    log(`undici 解析钩子注册失败（web_fetch 将不可用）：${e && e.message}`);
    return false;
  }
}

/* ─────────────────────────── 6. worker 线程注入 ─────────────────────────── */
/**
 * 包装 `node:worker_threads` 的 `Worker`：每个 worker 线程都带上 jitless 补齐。
 *
 * 【为什么必须包装】worker 是**新线程、新 globalThis、新 module registry**：主线程
 * 装的 hook（`Module._load`、fetch 覆盖、ESM 解析钩子）一个都不过去。上游
 * `@deepseek-ai/dsh-experimental-inspector` 起 worker 时还**显式**写死
 * `execArgv: []`（lib/index.js:1904），连 `--expose-internals` 都不继承 —— 其 worker
 * 的第一行 `import "@deepseek-ai/dsh-app-boot/worker/profile-resolution-bootstrap"`
 * 就要 `require("node-addon-require-builtin")`，随即在 worker 里炸。
 *
 * 【为什么用 `--require` 预载】worker 的 preload 必须早于它的任何 import 生效；
 * `--require` 正好在这个位置（实测：`new Worker(f, { execArgv: ['--require', p] })`
 * 里 p 先于 worker 入口执行），且 `--expose-internals` 也是 worker execArgv 的合法项。
 *
 * 【为什么要 syncBuiltinESMExports】内建模块的 **ESM** 具名导入（本插件就是
 * `import { Worker } from "node:worker_threads"`）读的是 builtin 的 ESM facade，
 * 只改 `require(...)` 上的属性它看不见；`module.syncBuiltinESMExports()` 把 CJS 侧
 * 的新值同步进 facade。已用对照实验确认（包装后从 ESM 里 new 出来的 worker 也会带上
 * preload）。
 *
 * 【为什么用函数包装而不是 class extends】保持 `instanceof` 双向成立：
 * `wrapper.prototype = RealWorker.prototype`，于是 `new Worker() instanceof Worker`
 * 与 `instanceof RealWorker` 都为真，不会把上游的 `instanceof` 判定改语义。
 *
 * @param {{ preloadPath: string, log?: (line: string) => void }} options
 */
function wrapWorkerThreads(options) {
  const log = options.log === undefined ? NOOP : options.log;
  const preloadPath = options.preloadPath;
  try {
    const wt = require('node:worker_threads');
    const RealWorker = wt.Worker;
    /*
     * 【控制实验开关】`DSHM_NO_WORKER_SHIM=1` 时**故意不注入**，用来复现修复前的
     * 失败形态（插件自建 worker 里的 `No usable native binding` /
     * `WebAssembly is not defined`）。没有它，这类"只在 worker 里坏"的回归无法被
     * 对照验证——只跑通过的一臂，证明不了这一臂是因注入而通的。默认关闭注入=关闭开关。
     */
    if (process.env.DSHM_NO_WORKER_SHIM === '1') {
      log('worker 注入已被 DSHM_NO_WORKER_SHIM=1 显式关闭（控制实验用）');
      return false;
    }
    if (typeof preloadPath !== 'string' || preloadPath.length === 0) {
      log('worker 注入未启用（preloadPath 为空）');
      return false;
    }
    if (RealWorker.__dshmWrapped === true) {
      log('worker 注入已安装（跳过重复安装）');
      return true;
    }
    function DshmWorker(filename, workerOptions) {
      const opts = workerOptions === undefined || workerOptions === null ? {} : { ...workerOptions };
      const base = Array.isArray(opts.execArgv) ? opts.execArgv : process.execArgv;
      const argv = Array.isArray(base) ? [...base] : [];
      if (!argv.includes('--expose-internals')) argv.push('--expose-internals');
      if (!argv.includes(preloadPath)) argv.push('--require', preloadPath);
      opts.execArgv = argv;
      return new RealWorker(filename, opts);
    }
    DshmWorker.prototype = RealWorker.prototype;
    Object.setPrototypeOf(DshmWorker, RealWorker);
    Object.defineProperty(DshmWorker, '__dshmWrapped', { value: true });
    wt.Worker = DshmWorker;
    Module.syncBuiltinESMExports();
    log('worker 注入已安装（每个 worker 带 --expose-internals --require worker-bootstrap.cjs，含 ESM 侧）');
    return true;
  } catch (e) {
    log(`worker 注入安装失败（插件自建 worker 可能仍会失败）：${e && e.message}`);
    return false;
  }
}

/* ─────────────────────────── 组合入口 ─────────────────────────── */

/**
 * worker 线程启动时的完整补齐（由 worker-bootstrap.cjs 调用，早于 worker 入口模块）。
 * 顺序有讲究：先封 http 惰性 getter（否则任何一次 http 触碰都可能先把 undici 拉起来），
 * 再装 require-builtin（worker 的第一个 import 就要它），然后才是 fetch / undici
 * 解析钩子，最后把注入链延伸到嵌套 worker。
 *
 * @param {(line: string) => void} [log]
 * @param {{ appDir?: string, libsDir?: string }} [options]
 */
function installWorkerEnvironment(log = NOOP, options = {}) {
  const results = {
    seal: sealHttpLazyUndici(log),
    native: installNativeRedirect({ libsDir: options.libsDir, appDir: options.appDir, log }),
    requireBuiltin: installRequireBuiltinShim(log),
    internalUndici: installInternalUndiciShim(log),
    fetch: installJitlessFetch(log),
    undiciHook: installUndiciNameHook(log),
    nestedWorkers: wrapWorkerThreads({ preloadPath: __filename.replace(/jitless-env\.cjs$/, 'worker-bootstrap.cjs'), log }),
  };
  log(`worker 线程 jitless 补齐完成：${JSON.stringify(results)}`);
  return results;
}

module.exports = {
  sealHttpLazyUndici,
  resolveNativeLibsDir,
  flatNativeName,
  installNativeRedirect,
  installRequireBuiltinShim,
  installInternalUndiciShim,
  installJitlessFetch,
  installUndiciNameHook,
  wrapWorkerThreads,
  installWorkerEnvironment,
};
