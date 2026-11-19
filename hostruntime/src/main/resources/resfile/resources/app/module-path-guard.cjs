'use strict';
/**
 * module-path-guard.cjs —— 收窄 Node **全局模块搜索路径**（LOOP-GAP 的除根，2026-10-19）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 一、它解决什么（与 fs-probe-cache 的分工）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 分诊报告（`dist/triage/2026-10-19/TRIAGE.md` P0-2 / S-07）给了一条我们上一轮**没治**的读数：
 *
 *   SYNC-SLOW 192220ms existsSync
 *     /storage/Users/currentUser/.node_modules/@cocofhu/skillhub/package.json
 *   （另有两笔同型：15843ms、36839ms；见 logs1019/dshm-host.log:8369）
 *
 * 这条延迟的**自变量不是我们的代码，而是 Node 的全局搜索路径**：
 * 本机 `HOME=/storage/Users/currentUser`（公共存储挂载），而 Node 在启动时会把
 * `$HOME/.node_modules`、`$HOME/.node_libraries`、`<prefix>/lib/node`（以及 `NODE_PATH`）
 * 拼成"全局路径表"。于是**任何一次** `require('某包')` 在正常的 `node_modules` 链上没命中时，
 * 都会回退到这些全局目录去探测 —— 其中两条指向公共存储，一次 miss 就是 3.7s / 15.8s / 192s。
 *
 * 分工：
 *   · `fs-probe-cache.cjs` 治**第 2 次**（同一路径 30s 内的重复探测）；
 *   · 本文件治**第 1 次**（第一次探测要不要去那条慢路径）。
 * 两者不冲突：先摘掉慢路径，再缓存剩下的负结果。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 二、为什么不是"`Module.globalPaths.splice()` 一下就好"（实测结论，别踩这个坑）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Node 24 的 CJS loader（`internal/modules/cjs/loader.js`）里是**两个东西**：
 *
 *   modulePaths = paths;                          // ← 解析真正用的"活路径表"（模块内私有变量）
 *   Module.globalPaths = ArrayPrototypeSlice(modulePaths);   // ← 只是给自省用的**浅拷贝**
 *
 * 而 `Module._resolveLookupPaths()` 用的是 `modulePaths`，**不是** `Module.globalPaths`。
 * 实测（Node v24.19.0，PC）：
 *   · `Module.globalPaths.splice(0)` 之后 `require.resolve('foo')` 仍然命中 NODE_PATH 里那个包；
 *   · `Module.globalPaths = []` 同样**无效**；
 *   · 只有"让 Node 用它自己的初始化逻辑**重算一遍**活路径表"才会真的改变解析行为。
 *
 * `Module._initPaths()` 恰好就是那段初始化逻辑，它只读两个输入：
 *   `HOME`（Windows 上 `USERPROFILE`）与 `NODE_PATH`，然后把 `modulePaths` 重算成
 *   `<prefix>/lib/node` + `$HOME/.node_modules` + `$HOME/.node_libraries` + `NODE_PATH` 各项。
 *
 * 所以本文件的做法是：**在同步窗口内**把这两个输入换成"收窄后的版本"，调一次
 * `Module._initPaths()`，然后**立刻把 env 原样还回去**。实测（PC，Node 24.19）：
 *
 *   收窄前 lookup: [<tmp>/node_modules, C:\Users\Sol\.node_modules, C:\Users\Sol\.node_libraries, <prefix>/lib/node]
 *   收窄后 lookup: [/data/storage/.../files/sandbox-node_modules, <prefix>/lib/node]
 *   收窄后 require.resolve('foo') ⇒ MODULE_NOT_FOUND（NODE_PATH 那条被换掉了）
 *   HOME / USERPROFILE 均逐字还原
 *
 * 也就是说：**解析算法一行没改**（`_resolveFilename` / `_resolveLookupPaths` / `_pathCache`
 * 全部原对象、原语义、原缓存），改的只是它拿去比对的**目录清单的输入**。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 三、规则与边界
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  ① 只摘掉指向前缀 `/storage/Users/currentUser` 的项（路径分隔符先归一成 `/`，
 *     允许正好等于前缀本身）。**应用沙箱内路径一律保留**（`/data/storage/...`、`<prefix>/lib/node`、
 *     沙箱里的 `NODE_PATH` 项）。
 *  ② `DSHM_GLOBAL_PATHS=keep` ⇒ **完全不动**（默认是收窄；排障时想复现旧行为用它）。
 *  ③ 任何异常都**原样直通**：本层绝不抛、绝不改写 `require` 语义；失败时尽量把 env 还原，
 *     只留一行诊断（`全局模块路径收窄失败（不阻塞）：…`）。
 *  ④ 幂等：同一个 Module 只做一次（重复 install 返回同一份结果）。
 *  ⑤ 同步窗口：`HOME` 只在 `_initPaths()` 这一次同步调用期间被换成空串；退出前逐字还原
 *     （`finally` + `restoreEnv`），不存在"异步期间 HOME 是空"的窗口。
 *  ⑥ 只影响**主线程**。worker 线程是新的 module registry，会自己按 env 重新初始化
 *     —— `NODE_PATH` 已被我们在主线程收窄过（worker 继承 env）⇒ NODE_PATH 那一半连带修好；
 *     但 worker 里的 `$HOME/.node_modules` 仍会被它自己加回去（`HOME` 我们不改）。
 *     需要时由 `worker-bootstrap.cjs` 另行安装本层；本批不做（LOOP-GAP 读数来自主线程）。
 *
 * 用法：
 *   const { installModulePathGuard } = require('./module-path-guard.cjs');
 *   installModulePathGuard({ log: diag });   // 必须早于核心树 require
 *   // 诊断行：[dshm-host] 全局模块路径已收窄（移除 N 项 /storage/Users/currentUser）
 */

const path = require('node:path');

/** 要摘掉的前缀：用户家目录（公共存储挂载；真机 HOME 就是它）。 */
const USER_PATH_PREFIX = '/storage/Users/currentUser';
/** 诊断/审计里用的名字（与上面同源）。 */
const USER_PATH_LABEL = '/storage/Users/currentUser';

const ENV_KEEP = 'DSHM_GLOBAL_PATHS';
const HANDLE_KEY = '__dshmModulePathGuard';

/* ─────────────────────────────── 纯判据（门禁直接测） ─────────────────────────────── */

function normalizePath(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * 这一项是不是"指向用户家目录"的全局路径。**纯函数**。
 * 认的形态：正好等于前缀，或前缀 + `/…`（归一化后）。
 */
function isUserHomePath(p) {
  if (typeof p !== 'string' || p.length === 0) {
    return false;
  }
  const normalized = normalizePath(p).replace(/\/+$/, '');
  return normalized === USER_PATH_PREFIX || normalized.startsWith(USER_PATH_PREFIX + '/');
}

/**
 * 把一组路径分成 `{ kept, removed }`：只摘用户家目录项，其余（含沙箱项）原样保留。
 * **纯函数**、不改入参。
 */
function filterPaths(list) {
  const kept = [];
  const removed = [];
  if (!Array.isArray(list)) {
    return { kept, removed };
  }
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    if (isUserHomePath(entry)) {
      removed.push(entry);
    } else {
      kept.push(entry);
    }
  }
  return { kept, removed };
}

/** `NODE_PATH` 原始串 → 分段数组（分隔符由调用方给，默认本平台 `path.delimiter`）。 */
function splitNodePath(raw, delimiter) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return [];
  }
  const sep = typeof delimiter === 'string' && delimiter.length > 0 ? delimiter : path.delimiter;
  return raw.split(sep).filter((entry) => entry.length > 0);
}

/** `NODE_PATH` 收窄：返回 `{ kept, removed, next }`，`next` 是收窄后该写回 env 的串。 */
function filterNodePath(raw, delimiter) {
  const sep = typeof delimiter === 'string' && delimiter.length > 0 ? delimiter : path.delimiter;
  const entries = splitNodePath(raw, delimiter);
  const { kept, removed } = filterPaths(entries);
  return { kept, removed, next: kept.join(sep) };
}

/* ─────────────────────────────── 安装 ─────────────────────────────── */

function readEnv(env, name) {
  try {
    const value = env === undefined || env === null ? undefined : env[name];
    return value === undefined || value === null ? '' : String(value);
  } catch (e) {
    return '';
  }
}

function isKeepMode(env) {
  return readEnv(env, ENV_KEEP).trim().toLowerCase() === 'keep';
}

/** 还原 env：原本不存在就删掉，原本有就逐字写回。 */
function restoreEnv(env, name, value) {
  try {
    if (value === undefined) {
      delete env[name];
    } else {
      env[name] = value;
    }
  } catch (e) { /* env 还原失败也不能把安装搞崩 */ }
}

function makeState(extra) {
  return Object.assign({
    installed: false,
    applied: false,
    keep: false,
    removedGlobalPaths: 0,
    removedNodePath: 0,
    kept: 0,
    reason: '',
  }, extra || {});
}

/**
 * 收窄全局模块路径。**幂等**、**绝不抛**。
 *
 * @param {{ module?: object, env?: object, log?: (line: string) => void, pathDelimiter?: string }} [options]
 *        `module` / `env` / `pathDelimiter` 三个注入点只为门禁存在（生产调用只传 `log`）。
 * @returns {{ installed: boolean, applied: boolean, keep: boolean,
 *             removedGlobalPaths: number, removedNodePath: number, kept: number, reason: string }}
 */
function installModulePathGuard(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const moduleImpl = opts.module || require('node:module');
  const log = typeof opts.log === 'function' ? opts.log : null;
  const delimiter = typeof opts.pathDelimiter === 'string' && opts.pathDelimiter.length > 0
    ? opts.pathDelimiter
    : path.delimiter;

  /* 幂等：同一个 Module 只做一次。 */
  try {
    const prior = moduleImpl[HANDLE_KEY];
    if (prior !== undefined && prior !== null) {
      return prior;
    }
  } catch (e) { /* 冻结对象 ⇒ 继续，下面各自兜底 */ }

  const state = makeState({ installed: true });

  try {
    /* ① keep 开关：完全不动。 */
    if (isKeepMode(env)) {
      state.keep = true;
      state.reason = `${ENV_KEEP}=keep`;
      try { moduleImpl[HANDLE_KEY] = state; } catch (e) { /* ignore */ }
      if (log !== null) log('[dshm-host] 全局模块路径保持原样（DSHM_GLOBAL_PATHS=keep）');
      return state;
    }

    const globalPaths = Array.isArray(moduleImpl.globalPaths) ? moduleImpl.globalPaths : null;
    const before = globalPaths === null ? [] : globalPaths.slice();
    const savedNodePath = env === undefined || env === null ? undefined : env.NODE_PATH;
    const savedHome = env === undefined || env === null ? undefined : env.HOME;
    const savedUserProfile = env === undefined || env === null ? undefined : env.USERPROFILE;
    const canReinit = typeof moduleImpl._initPaths === 'function';
    let nodePathRemoved = 0;

    try {
      /* ② 先收窄 NODE_PATH（它既是 _initPaths 的输入，也会被 worker 继承）。 */
      if (typeof savedNodePath === 'string' && savedNodePath.length > 0) {
        const filtered = filterNodePath(savedNodePath, delimiter);
        if (filtered.removed.length > 0) {
          env.NODE_PATH = filtered.next;
          nodePathRemoved = filtered.removed.length;
        }
      }

      /* ③ 让 Node 用"收窄后的输入"重算活路径表。
       *    —— 关键：真正被解析用的是内部 `modulePaths`，`Module.globalPaths` 只是浅拷贝（见头注 §二）。
       *    清 HOME/USERPROFILE 让 `$HOME/.node_modules`、`$HOME/.node_libraries` 这两条不再被加回来，
       *    收窄后的 NODE_PATH 则照常保留（沙箱内路径不会被删掉）。 */
      if (canReinit) {
        try {
          if (env !== undefined && env !== null) {
            env.HOME = '';
            env.USERPROFILE = '';
          }
          moduleImpl._initPaths();
        } finally {
          /* ④ 同步窗口结束立刻逐字还原（哪怕 _initPaths 抛了）。 */
          if (env !== undefined && env !== null) {
            restoreEnv(env, 'HOME', savedHome);
            restoreEnv(env, 'USERPROFILE', savedUserProfile);
          }
        }
      }

      /* ⑤ `Module.globalPaths`（自省副本）再兜一层：_initPaths 不可用时至少让读数与工具面一致。 */
      const afterInit = Array.isArray(moduleImpl.globalPaths) ? moduleImpl.globalPaths : null;
      if (afterInit !== null) {
        const filteredAfter = filterPaths(afterInit);
        if (filteredAfter.removed.length > 0) {
          try {
            afterInit.length = 0;
            for (const entry of filteredAfter.kept) afterInit.push(entry);
          } catch (e) { /* 只读数组 ⇒ 跳过；解析面由上面的 _initPaths 负责 */ }
        }
        state.kept = filteredAfter.kept.length;
      }

      const removedGlobal = filterPaths(before).removed.length;
      state.applied = true;
      state.removedGlobalPaths = removedGlobal;
      state.removedNodePath = nodePathRemoved;
      state.reason = canReinit ? '' : '_initPaths 不可用（只过滤了自省副本）';
      try { moduleImpl[HANDLE_KEY] = state; } catch (e) { /* ignore */ }

      if (log !== null) {
        log('[dshm-host] 全局模块路径已收窄（移除 ' + removedGlobal + ' 项 ' + USER_PATH_LABEL
          + '，NODE_PATH 移除 ' + nodePathRemoved + ' 项，保留 ' + state.kept + ' 项）');
      }
      return state;
    } catch (e) {
      /* ⑤ 任何异常：把 env 还回去（NODE_PATH 可能已被改），然后如实报"没生效"。 */
      try {
        if (env !== undefined && env !== null) {
          restoreEnv(env, 'NODE_PATH', savedNodePath);
          restoreEnv(env, 'HOME', savedHome);
          restoreEnv(env, 'USERPROFILE', savedUserProfile);
        }
      } catch (e2) { /* ignore */ }
      state.applied = false;
      state.reason = '收窄失败：' + String(e && e.message ? e.message : e);
      try { moduleImpl[HANDLE_KEY] = state; } catch (e2) { /* ignore */ }
      if (log !== null) log('[dshm-host] 全局模块路径收窄失败（不阻塞）：' + state.reason);
      return state;
    }
  } catch (e) {
    /* 最外层兜底：连"读 env"都可能被坏 env 弄炸。 */
    state.installed = true;
    state.applied = false;
    state.reason = '安装失败：' + String(e && e.message ? e.message : e);
    if (log !== null) log('[dshm-host] 全局模块路径收窄失败（不阻塞）：' + state.reason);
    return state;
  }
}

module.exports = {
  installModulePathGuard,
  isUserHomePath,
  filterPaths,
  splitNodePath,
  filterNodePath,
  USER_PATH_PREFIX,
  USER_PATH_LABEL,
  ENV_KEEP,
};
