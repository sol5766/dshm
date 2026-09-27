/**
 * 端侧核心树的**可安装性事实**（插件行 + 原生模块），供两处共用：
 *
 *   - `tools/scan-core-plugins.mjs`：离线取证 / 出报告（人工看）
 *   - `tools/pack-core.mjs`：打包时把结果写进树内 `<top>/dshm-core.json`（端侧看）
 *
 * 【为什么要共用而不是各写一份】这两处的结论必须是同一个。端侧只读打包时写下的清单，
 * 如果打包的判据和离线取证的判据漂移，就会出现"报告说纯 JS、端侧标记依赖原生"这种
 * 谁也说不清的分歧。判据只有一份，改动只在这里。
 *
 * 【核心判据】某插件行是否"依赖原生码"，看的是**依赖闭包**内是否出现 `.node`，
 * **不是**该插件包自己是否含 `.node`。实测 6 个 NATIVE 行没有一个自带 `.node`——
 * 它们全靠传递依赖摸到 koffi / node-pty / sharp。用"包内有没有 .node"当判据会把
 * 它们错标成"纯 JS 可安装"，用户装完必然起不来。
 *
 * 另外：patch 行的 `name` 可能是**包的子路径导出**（如
 * `@deepseek-ai/dsh-web-app/startup`），必须先去掉子路径再解析，否则会得到一个
 * 假的"待确认"——而实测 `web-startup` 经由 koffi，其实是 NATIVE。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

/** 已知的插件来源 bundle（profile 的 dsh.profile.bundles 就是这两个）。 */
export const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/**
 * 建立包索引：relPath（相对 node_modules，例如 `a/node_modules/b`）→ 绝对目录。
 * 同时建立"包名 → relPath 列表"，用于解析依赖时按作用域就近查找。
 */
export function indexPackages(nm) {
  const pkgByRel = new Map()
  const walk = (dir, prefix) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue
      if (e.name === '.bin') continue
      if (e.name.startsWith('@')) {
        walk(join(dir, e.name), prefix + e.name + '/')
        continue
      }
      const rel = prefix + e.name
      const abs = join(dir, e.name)
      if (pkgByRel.has(rel)) continue
      pkgByRel.set(rel, abs)
      const nested = join(abs, 'node_modules')
      if (existsSync(nested)) walk(nested, rel + '/node_modules/')
    }
  }
  walk(nm, '')

  const relsByName = new Map()
  for (const rel of pkgByRel.keys()) {
    const marker = 'node_modules/'
    const name = rel.slice(rel.lastIndexOf(marker) + marker.length)
    if (!relsByName.has(name)) relsByName.set(name, [])
    relsByName.get(name).push(rel)
  }
  return { pkgByRel, relsByName }
}

/** 包目录下是否存在 `.node` 文件（返回相对路径列表）。`deps/` 与 `.git/` 不含原生码，跳过以省时间。 */
function findNativeFiles(pkgDir) {
  const hits = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'deps') continue
        walk(join(dir, e.name))
      } else if (e.name.endsWith('.node')) {
        hits.push(relative(pkgDir, join(dir, e.name)))
      }
    }
  }
  walk(pkgDir)
  return hits
}

/** 每个包目录 → 命中的 .node 文件。 */
export function nativePackagesOf(pkgByRel) {
  const nativeByRel = new Map()
  for (const [rel, abs] of pkgByRel) {
    const hits = findNativeFiles(abs)
    if (hits.length > 0) nativeByRel.set(rel, hits)
  }
  return nativeByRel
}

/** 从包 `fromRel` 里解析依赖 `dep`：沿 `/node_modules/` 逐级向上找。 */
export function resolveDep(pkgByRel, fromRel, dep) {
  const segs = fromRel.split('/node_modules/')
  for (let i = segs.length - 1; i >= 0; i--) {
    const prefix = segs.slice(0, i).join('/node_modules/')
    const cand = (prefix.length > 0 ? prefix + '/node_modules/' : '') + dep
    if (pkgByRel.has(cand)) return cand
  }
  if (pkgByRel.has(dep)) return dep
  return null
}

/** entryRel 的依赖闭包里所有含 .node 的包（rel → 命中文件）。 */
export function nativeClosure(pkgByRel, nativeByRel, entryRel) {
  const found = new Map()
  const seen = new Set()
  const pkgJsonCache = new Map()
  const pkgJson = (rel) => {
    if (pkgJsonCache.has(rel)) return pkgJsonCache.get(rel)
    let json = null
    try {
      json = JSON.parse(readFileSync(join(pkgByRel.get(rel), 'package.json'), 'utf8'))
    } catch {
      json = null
    }
    pkgJsonCache.set(rel, json)
    return json
  }
  const queue = [entryRel]
  while (queue.length > 0) {
    const rel = queue.pop()
    if (seen.has(rel)) continue
    seen.add(rel)
    if (nativeByRel.has(rel)) found.set(rel, nativeByRel.get(rel))
    const json = pkgJson(rel)
    if (json === null) continue
    const deps = Object.keys({ ...(json.dependencies ?? {}), ...(json.optionalDependencies ?? {}) })
    for (const d of deps) {
      const r = resolveDep(pkgByRel, rel, d)
      if (r !== null && !seen.has(r)) queue.push(r)
    }
  }
  return found
}

/**
 * 解析 bundle patch 的插件行。**只做行解析，不引 YAML 库**——端侧也用同一套规则，
 * 而 ArkTS 侧不该为了 `id`/`name`/`disabled` 三个字段引入 YAML 依赖。
 */
export function parsePatchRows(text) {
  const rows = []
  let cur = null
  let curIndent = -1
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*#/.test(raw) || raw.trim().length === 0) continue
    const mInline = /^(\s*)-\s+id:\s*(\S+)\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(raw)
    if (mInline) {
      if (cur) rows.push(cur)
      cur = { id: mInline[2], name: mInline[3], disabled: false }
      curIndent = mInline[1].length
      continue
    }
    const mId = /^(\s*)-\s+id:\s*(\S+)\s*$/.exec(raw)
    if (mId) {
      if (cur) rows.push(cur)
      cur = { id: mId[2], name: '', disabled: false }
      curIndent = mId[1].length
      continue
    }
    if (cur === null) continue
    const mName = /^(\s*)name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(raw)
    if (mName && mName[1].length > curIndent) {
      cur.name = mName[2]
      continue
    }
    const mDisabled = /^(\s*)disabled:\s*(true|false)\s*$/.exec(raw)
    if (mDisabled && mDisabled[1].length > curIndent) {
      cur.disabled = mDisabled[2] === 'true'
      continue
    }
  }
  if (cur) rows.push(cur)
  return rows.filter((r) => r.name.length > 0)
}

/**
 * 行里的 `name` 可能是包的子路径导出，先按整名解析，再退回去掉子路径的包名。
 * 返回 { rel, pkgName } 或 null。
 */
function resolveRowPackage(pkgByRel, relsByName, name) {
  const direct = relsByName.get(name)?.[0] ?? resolveDep(pkgByRel, '', name) ?? null
  if (direct !== null) return { rel: direct, pkgName: name }
  const slash = name.startsWith('@') ? name.indexOf('/', name.indexOf('/') + 1) : name.indexOf('/')
  if (slash > 0) {
    const pkgName = name.slice(0, slash)
    const r = relsByName.get(pkgName)?.[0] ?? resolveDep(pkgByRel, '', pkgName) ?? null
    if (r !== null) return { rel: r, pkgName }
  }
  return null
}

/** patch 行 → 插件行（含 nativeKind 判定）。 */
export function pluginRowsOf(nm) {
  const { pkgByRel, relsByName } = indexPackages(nm)
  const nativeByRel = nativePackagesOf(pkgByRel)

  const bundles = []
  const allRows = []
  for (const b of BUNDLES) {
    const dir = join(nm, b)
    if (!existsSync(dir)) continue
    /*
     * 【patch 字段的两种形态（dsh 0.1.7-alpha.2 结构演进，批次备注十一）】
     * 0.1.6 及以前：dsh.bundle.patch 是 string（单个 cordis.patch.yml）。
     * 0.1.7 起 dsh-web-app 把它改成**数组**：主 patch + presets/*.patch.yml
     * （standard/ptc/minimal/cordis 四个 preset 补充行）。
     * 这里两种都吃：每个 patch 文件独立解析、独立计数（bundles 里一条一行），
     * 行合并进 allRows——清单/打包逻辑关心的是"所有行"，不关心行来自哪个文件。
     */
    let patchRels = ['./cordis.patch.yml']
    try {
      const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const p = json?.dsh?.bundle?.patch
      if (typeof p === 'string') {
        patchRels = [p]
      } else if (Array.isArray(p)) {
        const strs = p.filter((x) => typeof x === 'string' && x.length > 0)
        if (strs.length > 0) patchRels = strs
      }
    } catch {
      /* 用默认值 */
    }
    for (const patchRel of patchRels) {
      const patchPath = join(dir, patchRel)
      if (!existsSync(patchPath)) continue
      const rows = parsePatchRows(readFileSync(patchPath, 'utf8'))
      bundles.push({ bundle: b, patch: patchRel, rowCount: rows.length })
      for (const r of rows) allRows.push({ bundle: b, ...r })
    }
  }

  const rows = []
  for (const r of allRows) {
    const hit = resolveRowPackage(pkgByRel, relsByName, r.name)
    if (hit === null) {
      rows.push({ ...r, resolved: false, nativeKind: 'UNKNOWN', nativeVia: [] })
      continue
    }
    const closure = nativeClosure(pkgByRel, nativeByRel, hit.rel)
    rows.push({
      ...r,
      resolved: true,
      pkgName: hit.pkgName,
      subpath: hit.pkgName === r.name ? '' : r.name.slice(hit.pkgName.length + 1),
      nativeKind: closure.size > 0 ? 'NATIVE' : 'PURE_JS',
      nativeVia: [...closure.keys()],
    })
  }

  return {
    bundles,
    rows,
    packageCount: pkgByRel.size,
    nativePackages: [...nativeByRel.entries()].map(([rel, files]) => ({ rel, files })),
  }
}

/** 一次算全：给 pack-core 用的紧凑版（只留端侧要展示/判断的字段）。 */
export function inventoryOf(nm) {
  const full = pluginRowsOf(nm)
  const rows = full.rows
  const pure = rows.filter((r) => r.nativeKind === 'PURE_JS')
  const nat = rows.filter((r) => r.nativeKind === 'NATIVE')
  const unk = rows.filter((r) => r.nativeKind === 'UNKNOWN')
  return {
    packageCount: full.packageCount,
    nativePackages: full.nativePackages.map((p) => p.rel),
    nativeFiles: full.nativePackages.flatMap((p) => p.files.map((f) => `${p.rel}/${f}`)),
    plugins: rows.map((r) => ({
      id: r.id,
      name: r.name,
      bundle: r.bundle,
      disabled: r.disabled,
      nativeKind: r.nativeKind,
      nativeVia: r.nativeVia,
    })),
    totals: {
      pluginRows: rows.length,
      pureJs: pure.length,
      native: nat.length,
      unknown: unk.length,
      disabled: rows.filter((r) => r.disabled).length,
    },
  }
}
