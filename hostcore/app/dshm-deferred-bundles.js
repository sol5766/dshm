'use strict';
/*
 * dshm-deferred-bundles.js —— 用户安装 bundle 的「延迟挂载」清单生成器
 * （2026-11-26，启动提速第二轮）
 *
 * ── 解决什么 ─────────────────────────────────────────────────────────────
 * 手机端启动实测：BOOT_45_PROFILE_START → SERVER-LISTENING 占 host-ready 的 95%
 * 以上，其中用户从插件市场装的 bundle（当前是 dshmarket）与核心 bundle 一起在
 * profile boot 里**同步**逐个 import。它不在首屏必需路径上，却把整个宿主启动
 * 拖长数秒；而核心容器 SHA-256 缓存 / 延迟 import / 快速轮询（A/B/C）只覆盖
 * 百毫秒级 ⇒ 用户"感受不到优化"。
 *
 * 本模块在 profile boot **之前**做三件事：
 *   ① 用上游 dsh-app-boot 自己的解析器读出每个用户 bundle 的 cordis.patch.yml；
 *   ② 只对"pure insert"的 bundle 生成延迟清单（.dshm-deferred-bundles.json），
 *      并把它们的行（id/name/config/disabled）原样记下来；
 *   ③ 把这些 bundle 从 `dsh.profile.bundles` 里移出（**保留 dependencies**，
 *      插件页/卸载逻辑仍能识别"已安装"）。
 * 随后宿主照常 runProfile（核心 bundle 全量加载，首屏立即可用），
 * `@deepseek-ai/dshm-boot-extras` 在壳就绪后按清单用 `ctx.loader.create()` 挂载。
 *
 * ── 为什么只处理 pure insert ──────────────────────────────────────────────
 * 上游把 bundle patch 当作"整个 patch 层"应用：除了 `{insert: [...]}`，还可能
 * 用 `- id: <既有行>` 覆盖核心行的 config / disabled。这类层被移出 bundles 会
 * 丢掉覆盖语义。所以只延迟"整份 patch 只有 insert 条目"的 bundle；其余保持
 * 原样（照旧同步加载），并在 diag 里点名——宁可少延迟一个，也不能静默改语义。
 *
 * ── 为什么保留 dependencies ───────────────────────────────────────────────
 * `dependencies` 是"用户装过什么"的唯一真源（卸载、插件页、幂等安装都读它）；
 * `dsh.profile.bundles` 只是 loader 的"立即挂载层"。移出后者不影响前者。
 *
 * ── 幂等 ─────────────────────────────────────────────────────────────────
 * 每次启动都重新解析候选集合 = (现有 bundles 非种子) ∪ (上次清单) ∪ (dependencies
 * 里声明 dsh.bundle 的包)。因此：已在上一轮移出 bundles 的用户 bundle 仍会被
 * 重新解析并写回清单；卸载后包不存在 ⇒ 自动从清单消失；用户禁用的行会把
 * disabled 带进清单，延迟挂载时保持禁用。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 延迟清单文件名（profile 目录下；种子覆盖不会碰 `.dshm-*`）。 */
const DEFERRED_FILENAME = '.dshm-deferred-bundles.json';

/** 上游诊断前缀（与 dsh-app-boot 的 binName 一致）。 */
const BIN_NAME = 'dsh';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 读取 JSON 文件；不存在/损坏都返回 null（调用方按"没有"处理）。 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * 原子写 JSON：同目录 temp + rename。
 *
 * 【为什么不用直接 writeFileSync】profile 目录同时在读（loader 还没起，但插件页/
 * 安装队列可能在别的时点读）；半截文件会让"用户插件清单"解析失败。rename 在
 * 同一文件系统内是原子的。
 */
function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp-' + String(process.pid);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (ignored) {
      // 清理失败不影响主错误
    }
    throw e;
  }
}

/**
 * 把一组上游解析好的 patch 条目收敛成"可延迟的行"。
 *
 * @param patches `loadOverlayPatches()` 的返回值：顶层 patch 数组
 * @returns `{ id, name, ... }[]`；只要出现一条非 `insert` 条目，返回 null（不可延迟）
 */
function collectInsertRows(patches) {
  if (!Array.isArray(patches)) {
    return null;
  }
  const rows = [];
  for (const patch of patches) {
    if (!isPlainObject(patch)) {
      return null;
    }
    const keys = Object.keys(patch);
    if (keys.length !== 1 || keys[0] !== 'insert') {
      return null;
    }
    if (!Array.isArray(patch.insert)) {
      return null;
    }
    for (const row of patch.insert) {
      if (!isPlainObject(row)) {
        return null;
      }
      if (typeof row.name !== 'string' || row.name.length === 0) {
        return null;
      }
      if (row.id !== undefined && (typeof row.id !== 'string' || row.id.length === 0)) {
        return null;
      }
      rows.push(row);
    }
  }
  return rows;
}

/**
 * 解析一个 bundle：包目录 → manifest → bundle patch 文件 → 解析后的 patch 数组。
 *
 * @returns `{ packageName, packageDir, patches }`；不是 bundle（没有 dsh.bundle）
 *          或解析失败返回 null
 */
function resolveBundleLayer(appBoot, packageName, installAnchor, profileDir) {
  try {
    const packageDir = appBoot.resolveBundleDir(BIN_NAME, packageName, installAnchor, profileDir);
    const manifest = appBoot.readProfileManifest(BIN_NAME, packageDir);
    const bundle = manifest !== null && isPlainObject(manifest.dsh) ? manifest.dsh.bundle : undefined;
    if (bundle === undefined || bundle === null) {
      return null;
    }
    const patchPaths = appBoot.bundlePatchPaths(packageDir, bundle);
    const patches = [];
    for (const patchPath of patchPaths) {
      patches.push(...appBoot.loadOverlayPatches(BIN_NAME, patchPath));
    }
    return { packageName, packageDir, patches };
  } catch (e) {
    return null;
  }
}

/**
 * 读取 profile 自己的 patch 层里对"行 id"的覆盖（用户禁用 / 改 config）。
 *
 * bundle 被移出 bundles 后，它原本插入的行在 boot 时不存在，用户层写下的
 * `- id: dsh-market disabled: true` 就落不到任何东西上。延迟挂载时必须把这层
 * 意图带上，否则"用户禁用过的插件"会在延迟挂载时被重新启用。
 *
 * @returns Map<id, { disabled?: boolean, config?: any }>
 */
function readPatchOverrides(appBoot, profileDir) {
  const out = new Map();
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  if (!fs.existsSync(patchPath)) {
    return out;
  }
  let patches = [];
  try {
    patches = appBoot.loadOverlayPatches(BIN_NAME, patchPath);
  } catch (e) {
    return out;
  }
  for (const patch of Array.isArray(patches) ? patches : []) {
    if (!isPlainObject(patch) || typeof patch.id !== 'string' || patch.id.length === 0) {
      continue;
    }
    const cur = out.get(patch.id) || {};
    if (typeof patch.disabled === 'boolean') {
      cur.disabled = patch.disabled;
    }
    if (patch.config !== undefined) {
      cur.config = patch.config;
    }
    out.set(patch.id, cur);
  }
  return out;
}

/**
 * 生成/刷新延迟清单，并把可延迟的 bundle 移出 `dsh.profile.bundles`。
 *
 * @param profileDir `$DSH_HOME/profiles/<name>`
 * @param opts `{ appBoot, installAnchor, seedBundles, log, diag }`
 * @returns `{ bundles: string[], rows: object[] }`
 */
function deferUserBundles(profileDir, opts) {
  const o = opts || {};
  const log = typeof o.log === 'function' ? o.log : () => {};
  const diag = typeof o.diag === 'function' ? o.diag : log;
  const appBoot = o.appBoot;
  const installAnchor = typeof o.installAnchor === 'string' ? o.installAnchor : '';
  const empty = { bundles: [], rows: [] };
  if (!appBoot || typeof appBoot.resolveBundleDir !== 'function'
    || typeof appBoot.loadOverlayPatches !== 'function') {
    diag('用户插件延迟挂载：dsh-app-boot 解析 API 不可用，跳过（保持原样）');
    return empty;
  }
  if (installAnchor.length === 0) {
    diag('用户插件延迟挂载：installAnchor 为空，跳过（保持原样）');
    return empty;
  }
  const seedSet = new Set(Array.isArray(o.seedBundles) ? o.seedBundles : []);
  const pkgPath = path.join(profileDir, 'package.json');
  const manifestPath = path.join(profileDir, DEFERRED_FILENAME);
  const profileManifest = readJson(pkgPath) || {};
  const prevManifest = readJson(manifestPath) || {};
  const bundlesNow = isPlainObject(profileManifest.dsh) && isPlainObject(profileManifest.dsh.profile)
    && Array.isArray(profileManifest.dsh.profile.bundles)
    ? profileManifest.dsh.profile.bundles : [];
  const deps = isPlainObject(profileManifest.dependencies)
    ? Object.keys(profileManifest.dependencies) : [];

  // 候选 = 现有 bundles（非种子）∪ 上次清单 ∪ dependencies（是否 bundle 由解析判定）
  const candidates = new Set();
  for (const name of bundlesNow) {
    if (typeof name === 'string' && name.length > 0 && !seedSet.has(name)) {
      candidates.add(name);
    }
  }
  for (const name of Array.isArray(prevManifest.bundles) ? prevManifest.bundles : []) {
    if (typeof name === 'string' && name.length > 0) {
      candidates.add(name);
    }
  }
  for (const name of deps) {
    if (!seedSet.has(name)) {
      candidates.add(name);
    }
  }

  const deferred = [];
  const skipped = [];
  const rowsById = new Map();
  for (const packageName of candidates) {
    if (seedSet.has(packageName)) {
      continue;
    }
    const layer = resolveBundleLayer(appBoot, packageName, installAnchor, profileDir);
    if (layer === null) {
      // plain dependency（没有 dsh.bundle）或包已不在 ⇒ 不是 bundle，跳过
      continue;
    }
    const rows = collectInsertRows(layer.patches);
    if (rows === null || rows.length === 0) {
      skipped.push(packageName);
      continue;
    }
    deferred.push(packageName);
    for (const row of rows) {
      const id = typeof row.id === 'string' && row.id.length > 0
        ? row.id : ('deferred-' + row.name);
      rowsById.set(id, Object.assign({}, row, { id }));
    }
  }

  if (rowsById.size === 0) {
    // 没有可延迟的 bundle：清掉旧清单，避免卸载后残留指向不存在的包
    try {
      fs.rmSync(manifestPath, { force: true });
    } catch (e) {
      // 清理失败不影响启动
    }
    log('用户插件延迟挂载：无可延迟的用户 bundle（清单已清空）');
    return empty;
  }

  // 用户层意图（禁用 / 改 config）必须跟着延迟行走
  const overrides = readPatchOverrides(appBoot, profileDir);
  for (const [id, row] of rowsById) {
    const override = overrides.get(id);
    if (override === undefined) {
      continue;
    }
    if (typeof override.disabled === 'boolean') {
      row.disabled = override.disabled;
    }
    if (override.config !== undefined) {
      row.config = override.config;
    }
  }

  const rows = Array.from(rowsById.values());
  try {
    writeJsonAtomic(manifestPath, {
      version: 1,
      generatedAt: new Date().toISOString(),
      // 只记录"本次真正延迟的 bundle"；上次清单里已卸载的包不会写回
      bundles: Array.from(new Set(deferred)),
      rows,
    });
  } catch (e) {
    diag('用户插件延迟挂载：写清单失败，本次保持原样（' + String(e && e.message) + '）');
    return empty;
  }

  // 从 dsh.profile.bundles 移出（保留 dependencies）。写失败时清单已在，
  // 下次启动会再试；本次就算 bundle 仍被同步加载，boot-extras 也会因"行已存在"跳过。
  try {
    const remove = new Set(deferred);
    const kept = bundlesNow.filter((b) => !remove.has(b));
    if (kept.length !== bundlesNow.length) {
      profileManifest.dsh.profile.bundles = kept;
      writeJsonAtomic(pkgPath, profileManifest);
      log('用户插件延迟挂载：' + deferred.join('、')
        + ' 已移出 dsh.profile.bundles（保留 dependencies），改由 dshm-boot-extras 在壳就绪后挂载；行数=' + rows.length);
    } else {
      log('用户插件延迟挂载：' + deferred.join('、')
        + ' 已在延迟清单中（dsh.profile.bundles 无需改动）；行数=' + rows.length);
    }
  } catch (e) {
    diag('用户插件延迟挂载：写 profile package.json 失败（本次仍会同步加载，清单留给下次）：'
      + String(e && e.message));
  }

  if (skipped.length > 0) {
    diag('用户插件延迟挂载：跳过非 pure-insert bundle（保持同步加载）：' + skipped.join('、'));
  }
  return { bundles: deferred, rows };
}

module.exports = {
  DEFERRED_FILENAME,
  collectInsertRows,
  deferUserBundles,
};
