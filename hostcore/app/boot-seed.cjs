'use strict';

/*
 * ── 冷启动"种子"装载器（2026-11-16，首启提速）──────────────────────────────
 *
 * 【它解决什么】全新安装后的第一次启动，两份缓存都还没有：
 *   · 持久解析缓存（./resolve-cache.cjs，A2）：首次启动装的是空表，
 *     BOOT_40→50 里 ~14800 次核心树 ESM 解析只能整套推导重跑一遍；
 *   · 模块编译缓存（NODE_COMPILE_CACHE）：V8 code cache 的落盘点原生只有两处 ——
 *     AtExit 钩子（compile_cache.cc 的 Enable 注册 AtExit(FlushCompileCache)）与
 *     module.flushCompileCache()（fork v24.9.0 暴露的同步 API，node_modules.cc:648）。
 *     端侧宿主进程是被**杀掉**的（没有干净退出）⇒ AtExit 从不执行；
 *     main.js 在 markReady 处补了 flushCompileCache() 调用（见 main.js 该处注释）之后，
 *     从第 2 次启动起才是温编译 —— 但"第 1 次"仍是冷编译。
 *
 * 【做法】随包预置两份种子（hostruntime resfile 的 `boot-seed/` 目录，只读 el1），
 * 首次启动、插件图装载**之前**，把种子拷进可写目录：
 *   · resolve-cache-<ns>.json
 *       A2 的持久解析缓存文件。键值都是**核心树相对路径**（resolve-cache.cjs 头注），
 *       跨设备可移植；ns = coreVersion|builtAt|node 版本|ABI|格式版本，核心树或
 *       Node 换版自动整体失效（种子变成"白拿"，不会错命中）。
 *       拷贝目标：$DSHM_HOME。判据=同名文件不存在才拷 —— home 里的活文件
 *       （markReady/exit 落盘的）永远优先于种子，绝不覆盖。
 *   · v8-compile-cache/<v版本>-arm64-<hash>-<uid>/<8位hex>
 *       V8 code cache blob。文件名 = Uint32ToHex(源码**绝对路径**+模块类型的哈希)
 *       ⇒ 必须以设备精确路径生成（采集走"装好 Beta 的真机以应用自导出"，
 *       见 main.js 的 maybeExportBootSeed）。ns 目录名带导出进程 uid，但
 *       Enable 在运行侧已把**当前进程** uid 拼进目录名（fork compile_cache.cc
 *       GetCacheVersionTag）⇒ 装载时只按"去 uid 前缀"匹配（v<node>-arm64-<hash>，
 *       hash 由 V8 版本+flag 集决定），一致才拷；不一致 ⇒ 目录名对不上，自动
 *       全体不命中（安全）。
 *
 * 【每一步为什么是安全的】（宁可少省，也不改语义）
 *   · blob 自带校验（头部 magic/code hash/cache hash）：文件名没命中=不用；
 *     内容过期=V8 拒用并重新编译（MaybeSave 重新登记、下次落盘修正）。种子没有
 *     任何"强行生效"的路径。
 *   · 解析种子由 installResolveCache 的既有装载逻辑消费：ns 不匹配/文件损坏 ⇒
 *     空表重新采集，行为与无种子逐字相同。
 *   · 全部拷贝失败只记 diag，不抛出、不阻塞启动。
 *   · 幂等：resolve 靠"同名文件存在即跳过"；compile 靠每个 ns 目录内的
 *     `.dshm-boot-seed-v1` 标记 + 逐文件"存在即跳过"，重复执行零副作用。
 *   · 总开关：DSHM_BOOT_SEED=off（也认 0/false/no）整体关闭。
 */

const fs = require('fs');
const path = require('path');

const KILL_ENV = 'DSHM_BOOT_SEED';
/** 每个 ns 目标目录内的"已应用"标记；内容为应用时刻的时间戳。 */
const NS_MARKER = '.dshm-boot-seed-v1';
/** v24.9.0-arm64-<hash>-<uid>（GetCacheVersionTag 的形态；版本段允许 -pre 等后缀） */
const NS_DIR_RE = /^v\S+-arm64-[0-9a-f]+-\d+$/;
/**
 * blob 文件名 = Uint32ToHex(GetCacheKey(源码绝对路径+模块类型)) —— 恰好 8 位小写十六进制，
 * **没有** `.cache` 后缀（compile_cache.cc GetOrInsert：cache_filename = dir + '/' + Uint32ToHex(key)；
 * 头注释里的 `.cache` 说法与实现不符，设备实测文件名也是裸 8 hex）。
 */
const BLOB_RE = /^[0-9a-f]{8}$/;

function isOff(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return s === 'off' || s === '0' || s === 'false' || s === 'no';
}

/**
 * 装载冷启动种子。必须在两处之前调用（由 main.js 保证）：
 *   ① installResolveCache（解析种子要先落到 $DSHM_HOME 才会被它读到）；
 *   ② 核心树插件图装载（编译种子要先就位，装载期编译才能命中）。
 *
 * @param {object} opts
 * @param {string} opts.homeDir  DSHM_HOME（解析种子的拷贝目标）；空串 ⇒ 跳过解析种子
 * @param {Function} [opts.log]  diag 日志函数
 * @returns {object} stats（enabled/seedDir/reason/resolveCopied/compileCopied/nsCount/nsCopied）
 */
function installBootSeed(opts) {
  const o = opts || {};
  const homeDir = String(o.homeDir || '');
  const log = typeof o.log === 'function' ? o.log : null;
  const stats = {
    enabled: false,
    reason: '',
    seedDir: '',
    resolveCopied: 0,
    compileCopied: 0,
    nsCount: 0,
    nsCopied: 0,
  };

  if (isOff(process.env[KILL_ENV])) {
    stats.reason = '已关闭（' + KILL_ENV + '=' + String(process.env[KILL_ENV] || '').trim() + '）';
    return stats;
  }

  /*
   * 种子目录解析（都不动 DSHM_RESOURCE_DIR 的既有语义）：
   *   ① DSHM_BOOT_SEED_DIR —— 显式指定（测试/采集用）；
   *   ② $DSHM_RESOURCE_DIR/boot-seed —— 正式路径：DSHM_RESOURCE_DIR 本就是
   *      hostruntime resfile 根（RuntimePort.buildHostEnv 注入），种子随包住在那里。
   */
  let seedDir = String(process.env.DSHM_BOOT_SEED_DIR || '').trim();
  if (seedDir.length === 0) {
    const resDir = String(process.env.DSHM_RESOURCE_DIR || '').trim();
    if (resDir.length > 0) {
      seedDir = path.join(resDir, 'boot-seed');
    }
  }
  if (seedDir.length === 0) {
    stats.reason = '无种子目录（DSHM_BOOT_SEED_DIR / DSHM_RESOURCE_DIR 均为空）';
    return stats;
  }
  stats.seedDir = seedDir;

  let names = [];
  try {
    names = fs.readdirSync(seedDir);
  } catch (e) {
    /* 目录不存在/不可读：老包无种子属常态，不算错误 */
    stats.reason = '种子目录不可读（' + String((e && e.message) || e).slice(0, 120) + '）';
    return stats;
  }

  /* ── ① 解析种子：同名文件不存在才拷（活文件优先，绝不覆盖）────────────── */
  if (homeDir.length > 0) {
    for (const name of names) {
      if (!/^resolve-cache-.+\.json$/.test(name)) {
        continue;
      }
      const dst = path.join(homeDir, name);
      try {
        fs.accessSync(dst);
        continue; // 已有活文件
      } catch (e) { /* 不存在 → 拷种子 */ }
      try {
        fs.copyFileSync(path.join(seedDir, name), dst);
        stats.resolveCopied += 1;
        if (log) {
          log('冷启动种子：解析表 ' + name + ' → HOME（'
            + Math.round(fs.statSync(dst).size / 1024) + ' KB）');
        }
      } catch (e) {
        if (log) {
          log('冷启动种子：拷 ' + name + ' 失败（跳过）：'
            + String((e && e.message) || e).slice(0, 120));
        }
      }
    }
  }

  /*
   * ── ② 编译种子：与当前 ns 目录按前缀匹配后整目录应用 ────────────────────
   * fork v24.9.0 的 module.getCompileCacheDir() 返回**带 tag 的 ns 目录**本身
   * （compile_cache.cc:550 compile_cache_dir_ = base + '/' + cache_tag，tag =
   * v<node>-arm64-<hash>-<getuid()>）——Enable 已经把**当前进程** uid 拼进目录名，
   * 种子侧无需（也不能）重算 uid：只比较"去掉 uid 段"后的前缀
   * （v<node>-arm64-<hash>，hash 由 V8 flag 集决定），一致 ⇒ blob 可命中，
   * 不一致 ⇒ flag/版本不同、blob 必不命中，跳过该 ns。
   * 每个目标目录成功扫完一轮后落 `.dshm-boot-seed-v1` 标记：之后同 ns 的
   * 启动跳过整个 blob 目录扫描（万级 readdir + access），温启动零开销。
   */
  let cacheNsDir = '';
  try {
    const nodeModule = require('node:module');
    if (typeof nodeModule.getCompileCacheDir === 'function') {
      cacheNsDir = String(nodeModule.getCompileCacheDir() || '');
    }
  } catch (e) {
    cacheNsDir = '';
  }
  if (cacheNsDir.length === 0) {
    /* 编译缓存没开（NODE_COMPILE_CACHE 未注入）⇒ 编译种子无处安放；解析种子照常 */
    stats.enabled = true;
    if (stats.resolveCopied === 0) {
      stats.reason = '编译缓存未启用（仅解析种子路径可用）';
    }
    return stats;
  }
  const currentNs = path.basename(cacheNsDir);
  const currentPrefix = currentNs.slice(0, currentNs.lastIndexOf('-'));

  const sub = path.join(seedDir, 'v8-compile-cache');
  let nsNames = [];
  try {
    nsNames = fs.readdirSync(sub).filter((n) => NS_DIR_RE.test(n));
  } catch (e) {
    /* 种子不带编译缓存（只发解析种子）属合法形态 */
  }
  stats.nsCount = nsNames.length;
  for (const nsName of nsNames) {
    const seedPrefix = nsName.slice(0, nsName.lastIndexOf('-'));
    if (seedPrefix !== currentPrefix) {
      if (log) {
        log('冷启动种子：ns ' + nsName + ' 与当前 ' + currentNs
          + ' 前缀不一致（V8 flag/版本不同），跳过');
      }
      continue;
    }
    const marker = path.join(cacheNsDir, NS_MARKER);
    try {
      fs.accessSync(marker);
      continue; // 该 ns 已应用过
    } catch (e) { /* 未应用 → 继续 */ }
    let blobs = [];
    try {
      blobs = fs.readdirSync(path.join(sub, nsName)).filter((n) => BLOB_RE.test(n));
    } catch (e) {
      if (log) {
        log('冷启动种子：读 ' + nsName + ' 失败（跳过该 ns）：'
          + String((e && e.message) || e).slice(0, 120));
      }
      continue;
    }
    let copied = 0;
    for (const blob of blobs) {
      const dst = path.join(cacheNsDir, blob);
      try {
        fs.accessSync(dst);
        continue; // 已存在（上轮中断续拷场景）
      } catch (e) { /* 不存在 → 拷 */ }
      try {
        fs.copyFileSync(path.join(sub, nsName, blob), dst);
        copied += 1;
      } catch (e) { /* 单文件失败不挡其余 */ }
    }
    stats.compileCopied += copied;
    stats.nsCopied += 1;
    try {
      fs.writeFileSync(marker, String(Date.now()) + '\n', 'utf8');
    } catch (e) {
      /* 标记写失败：最坏情形是下次启动重复扫一遍（逐文件已存在即跳过，幂等） */
    }
    if (log) {
      log('冷启动种子：编译缓存 ' + currentNs + ' 应用完成（本次新拷 ' + copied
        + ' / 种子共 ' + blobs.length + ' 个 blob）');
    }
  }

  stats.enabled = true;
  return stats;
}

module.exports = { installBootSeed };
