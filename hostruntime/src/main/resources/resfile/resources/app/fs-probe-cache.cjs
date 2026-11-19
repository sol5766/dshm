'use strict';
/**
 * fs-probe-cache.cjs —— 同步 fs「探测型」调用的**负结果**缓存（LOOP-GAP 治理，2026-10-19）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 一、它解决的是什么
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 内测日志（`node-output.log`，2026-10-19 那批）里的事件循环停顿读数全部指向同一件事：
 *
 *   LOOP-GAP 33277ms（第 9413 拍）
 *   LOOP-GAP-33277ms SYNC-SLOW-LOG 36839ms existsSync
 *       /storage/Users/currentUser/.node_modules/@linxin666/dsh-web-all/package.json
 *   SYNC-COUNT 同步调用总耗时 113819ms，Top12：
 *       existsSync×332830=64485ms | readFileSync×122216=42862ms |
 *       readdirSync×8728=5114ms | realpathSync×14914=773ms
 *   LOOP-GAP 800711ms（最长一次，13 分钟）
 *
 * 这 33 万次 `existsSync` 里绝大多数是 **Node / 打包器解析依赖时逐级向上找 `node_modules`**
 * 产生的**负结果**（`/storage/Users/currentUser/.node_modules/…`、`/data/storage/node_modules/…`、
 * `/data/node_modules/…`）：同一个"这个名字在不在"的答案，在同一个进程里被重复问上万次，
 * 每次都要穿透到慢存储。答案本身在秒级内不会变 ⇒ 只对**负结果**做短 TTL 缓存即可砍掉绝大部分。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 二、它只做三件事（其余 fs 一个字节都不碰）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   fs.existsSync   —— 负结果（返回 false）⇒ 可缓存
 *   fs.statSync     —— 负结果（抛 ENOENT）⇒ 可缓存；`{throwIfNoEntry:false}` 一律直通
 *   fs.readFileSync —— 负结果（抛 ENOENT）⇒ 可缓存
 *
 * 不接管 readdirSync / realpathSync / openSync / write* / mkdir* / rm* / rename* …
 * （`readdirSync` 与 `realpathSync` 的耗时在这次读数里是 5.1s / 0.77s，且它们的负结果缓存
 *  会改变"目录内容"的语义 —— 收益远小于风险，刻意不做。）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 三、保守规则（每一行都是"宁可少省，也不许改语义"）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  ① **只缓存负结果**，默认 TTL 30s。正结果（存在 / 读到了内容）**一律不缓存** ——
 *     安装完插件、升级完核心之后必须立刻看得见，这是本层第一条不可谈判的边界。
 *  ② **路径白名单**（子串标记，`\` 先归一成 `/`）：`node_modules`、`/package.json`、
 *     `/profiles/`、`/install-queue`。**其它路径直通**（连一次 Map 查询都不做，直接调原函数）。
 *     白名单是本层的"收益面"：这次读数里的 33 万次探测全部落在这些形态上。
 *  ③ `DSHM_FS_PROBE_CACHE=off`（也认 `false` / `0` / `no`）⇒ **完全不接管**，fs 原样不动。
 *     `DSHM_FS_PROBE_CACHE_TTL_MS` 可调（默认 30000，非法值退回默认，超 10 分钟按 10 分钟夹住，
 *     `0` 等同关闭）。
 *  ④ **任何异常都必须直通**：缓存层自己出的任何错（Map 操作、时间函数、白名单匹配）只会让
 *     这一次调用**退回原函数**；而**原函数**抛出的异常照原样、原对象、只抛一次地往上抛
 *     —— 绝不把异常改写成 `false` / `undefined` / 假 error。
 *  ⑤ 幂等：同一个 fs 对象只包装一次（重复 install 返回同一个句柄）。
 *  ⑥ 上限：缓存条目数封顶 4096，满了先清过期项，仍满就整体丢弃（丢缓存永远安全）。
 *
 * 【负结果的语义怎么保住】`statSync` / `readFileSync` 的负结果是**一次抛出**，不是返回值。
 * 本层缓存的是**当初那个 Error 对象**，命中时原样重抛：`code` / `errno` / `syscall` / `path` /
 * `message` 与真实调用逐字一致（不重新构造错误对象 —— 重新构造就会把 ENOENT 悄悄变成别的
 * errno，那正是本层最该避免的事）。代价是 `stack` 停在首次抛出点，见 docs/199。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 四、为什么没有"小文件内容缓存"（对 256KB 这条口径的如实交代）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 需求里写的是"`readFileSync` 仅小文件 ≤256KB 且路径特征匹配才加缓存"。落到保守规则 ① 上，
 * **正结果一律不缓存** ⇒ 不存在"把某份文件内容缓存在内存里"这回事，也就没有"缓存了 256KB
 * 以上内容"的风险面；`readFileSync` 这条通道**只缓存 ENOENT 负结果**（那时一个字节都没读到，
 * 大小无从谈起，也与大小无关）。
 *
 * 于是本层**刻意不写**一个 256KB 的常量：写了也没人读（`docs/199` §4「不要忠实转发没人要的
 * 字段」那条教训）。这条口径改为由门禁的**行为断言**守住：一个 300KB 的文件连续读两次，
 * 底层必须被调用**两次**（证明大文件内容从不进缓存）。
 *
 * 若将来真要开内容缓存：上限常量、失效判据（mtime/size）、安装窗口的显式失效三件必须一起加，
 * 并同步扩门禁。**现在不做。**
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 五、已知边界（如实记，不假装更全）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  · 只对**之后**发生的调用生效：在 install 之前就 `const { existsSync } = require('fs')`
 *    解构走的模块看不见这层（与 `jitless-env.cjs` 的 `installNativeRedirect()` 同一约束）。
 *  · **同进程安装窗口**：若某路径在本进程里先被探测成"不存在"、紧接着（同一个 TTL 内，≤30s）
 *    才被安装器创建出来，那次负结果仍会命中。跨启动没有这个问题（缓存只活在内存里）。
 *    处置口径：`DSHM_FS_PROBE_CACHE=off` 全关、`DSHM_FS_PROBE_CACHE_TTL_MS` 调小；
 *    `clear()` 供安装器/诊断面显式清空（本批未接线，见 docs/199 的真机待验清单）。
 *  · 缓存不落盘、不跨进程、不跨 worker（worker 线程是新 module registry，需要时由
 *    `worker-bootstrap.cjs` 另行安装 —— 本批**没有**装，因为 LOOP-GAP 读数来自主线程）。
 *
 * 用法：
 *   const { installFsProbeCache, stats, clear } = require('./fs-probe-cache.cjs');
 *   const handle = installFsProbeCache({ log: diag });   // 早于核心树 require
 *   handle.stats()  // { installed, enabled, ttlMs, whitelist, hits, misses, passthrough,
 *                   //   cachedNegatives, savedMs, expired, dropped, reason }
 *   stats()         // 最近一次安装的同一份快照（模块级便捷口，退出时用）
 */

const fs = require('node:fs');

/** 关闭开关（`off`/`false`/`0`/`no` 都认，大小写无关）。 */
const ENV_OFF = 'DSHM_FS_PROBE_CACHE';
/** TTL（毫秒，整数；默认 30000）。 */
const ENV_TTL = 'DSHM_FS_PROBE_CACHE_TTL_MS';

const DEFAULT_TTL_MS = 30000;
/** 上限：任何 env 配置都不许把一条"不存在"钉超过 10 分钟。 */
const MAX_TTL_MS = 600000;
/** 条目上限（满了丢缓存，丢缓存永远安全）。 */
const MAX_ENTRIES = 4096;

/**
 * 路径白名单：**子串**标记（先把 `\` 归一成 `/`）。命中任一即"可缓存"。
 * 与 `main.js` 那行诊断里的 `白名单=node_modules/package.json/profiles/install-queue` 逐字对应。
 */
const WHITELIST = ['node_modules', '/package.json', '/profiles/', '/install-queue'];
const WHITELIST_LABEL = 'node_modules/package.json/profiles/install-queue';

const HANDLE_KEY = '__dshmFsProbeCacheHandle';

/* ─────────────────────────────── 配置解析 ─────────────────────────────── */

function readEnv(env, name) {
  try {
    const value = env === undefined || env === null ? undefined : env[name];
    return value === undefined || value === null ? '' : String(value).trim();
  } catch (e) {
    return '';
  }
}

/** → `{ enabled, reason }`。只有明确写 off/false/0/no 才关；其它一律按开。 */
function resolveEnabled(env) {
  const raw = readEnv(env, ENV_OFF).toLowerCase();
  if (raw === 'off' || raw === 'false' || raw === '0' || raw === 'no') {
    return { enabled: false, reason: `${ENV_OFF}=${raw}` };
  }
  return { enabled: true, reason: '' };
}

/** → `{ ttlMs, reason }`。非法退回默认；超上限夹住；0 表示关闭（由调用方判定）。 */
function resolveTtl(env) {
  const raw = readEnv(env, ENV_TTL);
  if (raw.length === 0) {
    return { ttlMs: DEFAULT_TTL_MS, reason: '' };
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return { ttlMs: DEFAULT_TTL_MS, reason: `${ENV_TTL}=${raw} 非法，按默认 ${DEFAULT_TTL_MS}` };
  }
  if (value > MAX_TTL_MS) {
    return { ttlMs: MAX_TTL_MS, reason: `${ENV_TTL}=${raw} 超上限，按 ${MAX_TTL_MS}` };
  }
  return { ttlMs: Math.floor(value), reason: '' };
}

/**
 * 这条路径是否落在白名单面内（**纯函数**，门禁直接对它做行为/变异断言）。
 * 非字符串（URL / Buffer / fd 数字）⇒ 不可缓存 ⇒ 直通。
 */
function isCacheablePath(p) {
  if (typeof p !== 'string' || p.length === 0) {
    return false;
  }
  const normalized = p.replace(/\\/g, '/');
  for (const marker of WHITELIST) {
    if (normalized.includes(marker)) return true;
  }
  return false;
}

/** 只认 `ENOENT`：ENOTDIR / EACCES / EPERM 之类的负结果**不进缓存**（语义各不相同）。 */
function isEnoent(err) {
  try {
    return Boolean(err) && err.code === 'ENOENT';
  } catch (e) {
    return false;
  }
}

/* ─────────────────────────────── 缓存运行时 ─────────────────────────────── */

/**
 * 一次安装对应一个运行时（独立 store / 独立计数）。
 * 门禁通过注入 `now` 把"过期"变成确定性的（不 sleep、不看真实时钟）。
 */
function createRuntime(now, ttlMs) {
  const store = new Map();
  let hits = 0;
  let misses = 0;
  let passthrough = 0;
  let cachedNegatives = 0;
  let savedMs = 0;
  let expired = 0;
  let dropped = 0;

  function prune(nowMs) {
    for (const [key, entry] of store) {
      if (entry.expiresAt <= nowMs) {
        store.delete(key);
        expired += 1;
      }
    }
  }

  /** 命中返回 entry，未命中/已过期返回 null。**不抛**。 */
  function lookup(key) {
    const entry = store.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt <= now()) {
      store.delete(key);
      expired += 1;
      return null;
    }
    return entry;
  }

  function remember(key, costMs, error) {
    const nowMs = now();
    if (store.size >= MAX_ENTRIES) {
      prune(nowMs);
      if (store.size >= MAX_ENTRIES) {
        store.clear();
        dropped += 1;
      }
    }
    store.set(key, {
      expiresAt: nowMs + ttlMs,
      costMs: Number.isFinite(costMs) && costMs > 0 ? costMs : 0,
      error: error === undefined ? null : error,
    });
    cachedNegatives += 1;
  }

  return {
    store,
    lookup,
    remember,
    noteHit(entry) {
      hits += 1;
      savedMs += entry.costMs;
    },
    noteMiss() { misses += 1; },
    notePassthrough() { passthrough += 1; },
    clear() {
      store.clear();
    },
    snapshot() {
      return {
        installed: true,
        enabled: true,
        ttlMs,
        whitelist: WHITELIST.slice(),
        entries: store.size,
        hits,
        misses,
        passthrough,
        cachedNegatives,
        savedMs,
        expired,
        dropped,
      };
    },
  };
}

/* ─────────────────────────────── 三个包装 ─────────────────────────────── */

function wrapExists(runtime, fsImpl, orig, now) {
  return function existsSync(p) {
    let key = null;
    try {
      if (isCacheablePath(p)) key = 'exists\u0000' + p;
    } catch (e) {
      key = null;
    }
    if (key === null) {
      runtime.notePassthrough();
      return orig.apply(fsImpl, arguments);
    }
    let hit = null;
    try {
      hit = runtime.lookup(key);
    } catch (e) {
      hit = null;
    }
    if (hit !== null) {
      runtime.noteHit(hit);
      return false;
    }
    runtime.noteMiss();
    const start = now();
    /* 原函数抛出的异常在这里**原样冒出**（不 try/catch）⇒ 绝不改写成 false。 */
    const r = orig.apply(fsImpl, arguments);
    const costMs = now() - start;
    /* 只缓存**负结果**；正结果一律不缓存（安装 / 升级后必须立刻可见）。 */
    if (r === false) {
      try {
        runtime.remember(key, costMs, null);
      } catch (e) { /* 记账失败不影响返回值 */ }
    }
    return r;
  };
}

function wrapStat(runtime, fsImpl, orig, now) {
  return function statSync(p, options) {
    let key = null;
    try {
      /* `throwIfNoEntry:false` 的负结果是 `undefined`，与"抛 ENOENT"是两套语义 ⇒ 直通。 */
      const throwIfNoEntry = options && typeof options === 'object' ? options.throwIfNoEntry : undefined;
      if (throwIfNoEntry !== false && isCacheablePath(p)) {
        const bigint = options && typeof options === 'object' && options.bigint === true ? 'bigint' : 'plain';
        key = 'stat:' + bigint + '\u0000' + p;
      }
    } catch (e) {
      key = null;
    }
    if (key === null) {
      runtime.notePassthrough();
      return orig.apply(fsImpl, arguments);
    }
    let hit = null;
    try {
      hit = runtime.lookup(key);
    } catch (e) {
      hit = null;
    }
    if (hit !== null) {
      runtime.noteHit(hit);
      throw hit.error;
    }
    runtime.noteMiss();
    const start = now();
    let result;
    try {
      result = orig.apply(fsImpl, arguments);
    } catch (err) {
      const costMs = now() - start;
      if (isEnoent(err)) {
        try {
          runtime.remember(key, costMs, err);
        } catch (e) { /* 记账失败不影响抛出 */ }
      }
      throw err;
    }
    /* 正结果不缓存。 */
    return result;
  };
}

function wrapRead(runtime, fsImpl, orig, now) {
  return function readFileSync(p, options) {
    let key = null;
    try {
      if (isCacheablePath(p)) key = 'read\u0000' + p;
    } catch (e) {
      key = null;
    }
    if (key === null) {
      runtime.notePassthrough();
      return orig.apply(fsImpl, arguments);
    }
    let hit = null;
    try {
      hit = runtime.lookup(key);
    } catch (e) {
      hit = null;
    }
    if (hit !== null) {
      runtime.noteHit(hit);
      throw hit.error;
    }
    runtime.noteMiss();
    const start = now();
    let result;
    try {
      result = orig.apply(fsImpl, arguments);
    } catch (err) {
      const costMs = now() - start;
      if (isEnoent(err)) {
        try {
          runtime.remember(key, costMs, err);
        } catch (e) { /* 记账失败不影响抛出 */ }
      }
      throw err;
    }
    /* 正结果不缓存 —— 与文件大小无关（没有内容缓存这回事，见文件头 §四）。 */
    return result;
  };
}

/* ─────────────────────────────── 句柄 / 快照 ─────────────────────────────── */

/**
 * 写操作入口：**先清空负结果缓存再执行**（2026-10-19 真机门禁回归的修法）。
 *
 * 【为什么必须有】缓存只记"不存在"，而写操作（尤其 `renameSync` 落位、`writeFileSync`
 * 写 manifest、`mkdirSync` 建目录）会让刚被记为"不存在"的路径**立刻存在**。
 * `check-plugin-toggle` 在同一个进程里改写 profile 再让宿主重载插件 —— 若不清缓存，
 * 宿主会在 TTL（默认 30s）内继续读到"插件清单不存在"，表现为"插件全被停用/宿主起不来"。
 *
 * 【为什么不按路径精确失效】代价不对等：写操作远少于读探测，整表清空是 O(1) 语义且
 * 绝不漏（漏一次就是 30s 的假阴性）。清空只影响缓存条目，不动计数与统计。
 */
function wrapInvalidate(runtime, fsImpl, orig) {
  return function (...args) {
    try {
      runtime.store.clear();
    } catch (e) { /* 缓存清空失败不影响真实写操作 */ }
    return orig.apply(fsImpl, args);
  };
}

function emptySnapshot(extra) {
  const base = {
    installed: false,
    enabled: false,
    ttlMs: DEFAULT_TTL_MS,
    whitelist: WHITELIST.slice(),
    entries: 0,
    hits: 0,
    misses: 0,
    passthrough: 0,
    cachedNegatives: 0,
    savedMs: 0,
    expired: 0,
    dropped: 0,
    reason: '',
  };
  return Object.assign(base, extra || {});
}

function makeHandle(fields) {
  const handle = {
    enabled: fields.enabled === true,
    ttlMs: fields.ttlMs,
    reason: fields.reason || '',
    whitelist: WHITELIST.slice(),
    patched: (fields.patched || []).slice(),
    /** 被接了"写前清缓存"的操作名（诊断面；不参与缓存命中口径）。 */
    invalidateWrites: (fields.invalidateWrites || []).slice(),
    stats() {
      try {
        if (fields.runtime === null || fields.runtime === undefined) {
          return emptySnapshot({ installed: true, enabled: false, ttlMs: fields.ttlMs, reason: fields.reason || '' });
        }
        const snapshot = fields.runtime.snapshot();
        return Object.assign(snapshot, { reason: fields.reason || '' });
      } catch (e) {
        return emptySnapshot({ installed: true, enabled: fields.enabled === true, reason: String(e) });
      }
    },
    clear() {
      try {
        if (fields.runtime !== null && fields.runtime !== undefined) fields.runtime.clear();
      } catch (e) { /* 清缓存失败不影响任何语义 */ }
    },
  };
  return handle;
}

/** 最近一次安装的句柄（模块级便捷口；`stats()` / `clear()` 都转发到它）。 */
let active = null;

/**
 * 安装缓存层。**幂等**、**绝不抛**。
 *
 * @param {{ fs?: object, env?: object, now?: () => number, log?: (line: string) => void }} [options]
 *        `fs` / `env` / `now` 三个注入点只为门禁存在（生产调用只传 `log`）。
 * @returns {{ enabled: boolean, ttlMs: number, reason: string, whitelist: string[],
 *             patched: string[], stats: () => object, clear: () => void }}
 */
function installFsProbeCache(options) {
  const opts = options || {};
  const fsImpl = opts.fs || fs;
  const env = opts.env || process.env;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const log = typeof opts.log === 'function' ? opts.log : null;

  const off = resolveEnabled(env);
  const ttl = resolveTtl(env);
  const enabled = off.enabled && ttl.ttlMs > 0;
  const reason = !off.enabled ? off.reason : (ttl.ttlMs > 0 ? '' : `${ENV_TTL}=0`);

  /* 幂等：同一个 fs 只包装一次（已经装上就返回原来那份句柄）。 */
  let prior = null;
  try {
    prior = fsImpl[HANDLE_KEY] === undefined ? null : fsImpl[HANDLE_KEY];
  } catch (e) {
    prior = null;
  }
  if (prior !== null && prior.enabled === true && enabled) {
    active = prior;
    return prior;
  }

  if (!enabled) {
    const handle = makeHandle({ enabled: false, ttlMs: ttl.ttlMs, reason, patched: [], runtime: null });
    try { fsImpl[HANDLE_KEY] = handle; } catch (e) { /* 冻结对象：跳过 */ }
    active = handle;
    if (log !== null) {
      log(`fs 探测缓存未启用（${reason.length > 0 ? reason : '已关闭'}；DSHM_FS_PROBE_CACHE=off 关、DSHM_FS_PROBE_CACHE_TTL_MS 调）`);
    }
    return handle;
  }

  const runtime = createRuntime(now, ttl.ttlMs);
  const patched = [];
  const patch = (name, wrap) => {
    const orig = fsImpl[name];
    if (typeof orig !== 'function') return;
    try {
      fsImpl[name] = wrap(runtime, fsImpl, orig, now);
      patched.push(name);
    } catch (e) {
      /* 只读属性 / 冻结对象 ⇒ 跳过该入口，其余照常。 */
    }
  };
  patch('existsSync', wrapExists);
  patch('statSync', wrapStat);
  patch('readFileSync', wrapRead);

  /*
   * 写操作单独登记（不进 `patched`：`patched` 的语义是"被缓存的读入口"，
   * 由 check-fs-probe-cache 的 A 段钉成 existsSync/statSync/readFileSync 三项）。
   * 见 wrapInvalidate 头注：任何写都可能让负结果立刻失效，必须同进程清缓存。
   */
  const invalidateWrites = [];
  for (const name of ['writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'rmSync',
    'mkdirSync', 'rmdirSync', 'copyFileSync', 'truncateSync', 'symlinkSync', 'linkSync']) {
    const orig = fsImpl[name];
    if (typeof orig !== 'function') continue;
    try {
      fsImpl[name] = wrapInvalidate(runtime, fsImpl, orig);
      invalidateWrites.push(name);
    } catch (e) { /* 冻结对象：跳过 */ }
  }

  const handle = makeHandle({ enabled: true, ttlMs: ttl.ttlMs, reason, patched, runtime });
  handle.invalidateWrites = invalidateWrites;
  try { fsImpl[HANDLE_KEY] = handle; } catch (e) { /* 冻结对象：跳过 */ }
  active = handle;
  if (log !== null) {
    log(`fs 探测缓存已接管 ${patched.join('/')}（TTL=${ttl.ttlMs}ms）`);
  }
  return handle;
}

/** 最近一次安装的快照。**绝不抛**（诊断面用）。 */
function stats() {
  try {
    if (active === null) return emptySnapshot({ reason: '未安装' });
    return active.stats();
  } catch (e) {
    return emptySnapshot({ reason: 'stats 读取失败：' + String(e) });
  }
}

/** 清空最近一次安装的缓存（不改计数；诊断面 / 门禁用）。**绝不抛**。 */
function clear() {
  try {
    if (active !== null) active.clear();
  } catch (e) { /* ignore */ }
}

module.exports = {
  installFsProbeCache,
  stats,
  clear,
  isCacheablePath,
  resolveTtl,
  WHITELIST,
  WHITELIST_LABEL,
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  MAX_ENTRIES,
  ENV_OFF,
  ENV_TTL,
};
