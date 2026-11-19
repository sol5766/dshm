'use strict';
/**
 * resolve-cache.cjs —— 核心树 ESM 解析结果的**跨启动持久缓存**（冷启动治理，2026-11-15）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 一、它解决的是什么
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 温编译缓存（NODE_COMPILE_CACHE，ArkTS 侧注入，ESM 亦覆盖）落地之后，本地温态
 * BOOT_40→50 仍有 ~7.0s，其中 ~2.5s 花在**解析机器**上（2026-11-15 温态 CPU profile）：
 *
 *   normalizeString 576ms | internalModuleStat 514ms | getPathFromURLPosix 354ms
 *   | parse 213ms | getPackageScopeConfig 211ms | pathToFileURL 200ms
 *   | resolve 160ms | realpathSync 118ms | existsSync 113ms …
 *
 * 计数探针（--require 预载）证实：一次冷启动里核心树图要跑 **~14800 次 ESM resolve**
 * （~14800 个不同的 (parent, specifier) 对，进程内零冗余）+ ~1200 次 CJS resolve。
 * 每次解析平均 ~155µs：候选路径 stat 风暴 + package.json 逐级 walk + 路径归一化。
 * 这些推导的**答案跨启动完全不变**（核心树按版本不可变），却每个冷启动重付一遍。
 *
 * 本层把「parent 在核心树内的 ESM 解析结果」持久化到 HOME_DIR；下次冷启动
 * `module.registerHooks` 的 resolve 钩子查表命中，直接 `{url, format, shortCircuit: true}`
 * —— 把整套推导换成一次 Map.get。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 二、保守边界（每一条都是"宁可少省，也不许改语义"）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  ① **只缓存核心树内部解析**：parentURL 与解析结果都必须落在 CORE_DIR 之内
 *     （URL 前缀匹配，用 realpathSync 归一后的前缀）。HOME/profiles 里的用户插件、
 *     node: 内建、hostcore 壳层文件一律不碰 —— 用户内容随时可变，不属于本层承诺。
 *  ② **命名空间钉死核心身份**：ns = coreVersion + builtAt（读 CORE_DIR/dshm-core.json）
 *     + Node 版本 + modules ABI + 本层格式版本。核心升级/同版本重打（builtAt 变）
 *     /Node 换版 ⇒ ns 变 ⇒ 旧表整体失效，重新采集。核心树按 ns 不可变是本层的
 *     前提；不做逐条存在性校验（14800 次 statSync 会吃掉收益的 ~20%）。
 *  ③ `DSHM_RESOLVE_CACHE=off`（也认 0/false/no）⇒ 完全不接管，钩子都不注册。
 *  ④ **任何异常都直通**：缓存层自身的任何错（读表、切片、Map 操作）都退回
 *     nextResolve；nextResolve 抛的解析错误原样上抛 —— 绝不吞掉、绝不改写。
 *  ⑤ 只接管 **ESM 解析**（registerHooks.resolve）。CJS（Module._resolveFilename，
 *     ~1200 次，收益小）与 load/compile 层（编译缓存已覆盖）一概不碰。
 *  ⑥ 与其它 registerHooks 链天然可组合：本层只对"核心树内 parent"出手，命中
 *     shortCircuit、未命中透传；jitless-env 的 undici 垫片钩子照常生效
 *     （undici 的解析目标在核心树外 ⇒ 永远不会被本层采集或命中）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 三、采集与落盘
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  · 未命中 → nextResolve → 结果落在核心树内 ⇒ 采集 (parentRel, specifier) → [rel, format]。
 *  · 落盘两个检查点：BOOT_50 之后的 ready 检查点（模块图装载完毕，防之后被强杀丢表）
 *    + exit 钩子（兜底）；tmp + rename 原子替换；只在有新增时写（dirty 位）。
 *  · 落盘失败不影响运行（记 flushError，退出 stats 里可见）。
 *  · 排障：删 HOME_DIR/resolve-cache-*.json 即回到首启重新采集。
 *
 * 【为什么存"相对核心树 URL 前缀的切片"而不是绝对路径】核心树路径在设备上随安装
 * 位置变化（本地/真机不同）；存切片让表内容只依赖 ns，不依赖部署路径。切片是纯
 * 字符串操作（URL 的百分号编码原样保留），不做 decode/re-encode —— 没有编解码就
 * 没有编解码 bug。
 */
const fs = require('fs');
const path = require('path');
const nodeModule = require('module');
const { pathToFileURL } = require('url');

const NS_VER = 1;
const KILL_ENV = 'DSHM_RESOLVE_CACHE';

function installResolveCache(opts) {
  const o = opts || {};
  const coreDir = String(o.coreDir || '');
  const homeDir = String(o.homeDir || '');
  const log = typeof o.log === 'function' ? o.log : null;

  const stats = {
    enabled: false,
    reason: '',
    ns: '',
    coreVersion: '',
    builtAt: '',
    cacheFile: '',
    entries: 0,
    hits: 0,
    misses: 0,
    passthrough: 0,
    harvested: 0,
    flushed: 0,
    flushError: '',
  };
  const entries = new Map();
  let dirty = false;

  function flush(reason) {
    if (!stats.enabled || !dirty) {
      return false;
    }
    try {
      const payload = {
        v: NS_VER,
        ns: stats.ns,
        coreVersion: stats.coreVersion,
        builtAt: stats.builtAt,
        nodeVersion: String(process.versions.node || ''),
        abi: String(process.versions.modules || ''),
        checkpoint: String(reason || ''),
        createdAt: new Date().toISOString(),
        entries: Object.fromEntries(entries),
      };
      const tmp = stats.cacheFile + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, stats.cacheFile);
      dirty = false;
      stats.flushed += 1;
      return true;
    } catch (e) {
      stats.flushError = String((e && e.message) || e).slice(0, 200);
      return false;
    }
  }

  const off = String(process.env[KILL_ENV] || '').trim().toLowerCase();
  if (off === 'off' || off === '0' || off === 'false' || off === 'no') {
    stats.reason = '已关闭（' + KILL_ENV + '=' + off + '）';
    return { stats, flush };
  }
  if (coreDir.length === 0 || homeDir.length === 0) {
    stats.reason = 'coreDir/homeDir 缺失';
    return { stats, flush };
  }
  if (typeof nodeModule.registerHooks !== 'function') {
    stats.reason = 'module.registerHooks 不可用';
    return { stats, flush };
  }

  /* 命名空间：dshm-core.json 的 coreVersion+builtAt 钉住核心树身份 */
  let coreVersion = '';
  let builtAt = '';
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(coreDir, 'dshm-core.json'), 'utf8'));
    coreVersion = String(manifest.coreVersion || '');
    builtAt = String(manifest.builtAt || '');
  } catch (e) { /* 读不到清单：退回目录名当版本，builtAt 留空（仍随核心目录名失效） */ }
  if (coreVersion.length === 0) {
    coreVersion = path.basename(coreDir);
  }
  stats.coreVersion = coreVersion;
  stats.builtAt = builtAt;
  stats.ns = [
    coreVersion, builtAt,
    String(process.versions.node || ''),
    String(process.versions.modules || ''),
    String(NS_VER),
  ].join('|');
  const sanitize = (s) => s.replace(/[^A-Za-z0-9._=+-]+/g, '_').slice(0, 160);
  stats.cacheFile = path.join(homeDir, 'resolve-cache-' + sanitize(stats.ns) + '.json');

  /* 装载既有表；首启/损坏 → 空表重新采集，不视为错误 */
  try {
    const parsed = JSON.parse(fs.readFileSync(stats.cacheFile, 'utf8'));
    if (parsed && parsed.v === NS_VER && parsed.ns === stats.ns
      && parsed.entries && typeof parsed.entries === 'object') {
      for (const k of Object.keys(parsed.entries)) {
        const v = parsed.entries[k];
        if (Array.isArray(v) && typeof v[0] === 'string' && v[0].length > 0) {
          entries.set(k, [v[0], typeof v[1] === 'string' ? v[1] : '']);
        }
      }
    }
  } catch (e) { /* 空表 */ }
  stats.entries = entries.size;

  /*
   * URL 前缀用 realpath 归一：ESM loader 对模块 URL 做 realpath，parentURL 是真实路径。
   * 若 CORE_DIR 本身是符号链接，字面前缀将永远匹配不上（表现为全直通、零命中、不损语义）；
   * realpathSync 归一后两边一致。realpath 失败退回字面路径（同样只是少命中，不会错命中）。
   */
  let realCoreDir = coreDir;
  try {
    const rp = fs.realpathSync(coreDir);
    if (typeof rp === 'string' && rp.length > 0) {
      realCoreDir = rp;
    }
  } catch (e) { /* 退回字面路径 */ }
  const coreUrlPrefix = pathToFileURL(realCoreDir).href + '/';
  const relInsideCore = (url) => (typeof url === 'string' && url.startsWith(coreUrlPrefix)
    ? url.slice(coreUrlPrefix.length)
    : null);

  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        const parentRel = relInsideCore(context && context.parentURL);
        if (parentRel === null
          || typeof specifier !== 'string'
          || specifier.startsWith('node:')) {
          stats.passthrough += 1;
          return nextResolve(specifier, context);
        }
        const key = parentRel + ' ' + specifier;
        const hit = entries.get(key);
        if (hit !== undefined) {
          stats.hits += 1;
          const out = { url: coreUrlPrefix + hit[0], shortCircuit: true };
          if (hit[1]) {
            out.format = hit[1];
          }
          return out;
        }
        stats.misses += 1;
        const resolved = nextResolve(specifier, context);
        try {
          const rel = relInsideCore(resolved && resolved.url);
          if (rel !== null) {
            entries.set(key, [rel, (resolved && resolved.format) ? String(resolved.format) : '']);
            stats.harvested += 1;
            stats.entries = entries.size;
            dirty = true;
          }
        } catch (e2) { /* 采集失败不影响本次解析 */ }
        return resolved;
      } catch (e) {
        /* 缓存层自身异常 → 直通（绝不改写解析语义） */
        stats.passthrough += 1;
        return nextResolve(specifier, context);
      }
    },
  });

  stats.enabled = true;
  if (log) {
    log('持久解析缓存已接管核心树 ESM 解析（装载条目=' + entries.size + '）');
  }
  return { stats, flush };
}

module.exports = { installResolveCache };
