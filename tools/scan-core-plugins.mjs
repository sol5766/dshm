#!/usr/bin/env node
/**
 * 离线取证：在**已物化的端侧核心树**上算出插件行与原生模块，出人看的报告。
 *
 * 判据与打包时写进树内 `dshm-core.json` 的**完全同一份代码**
 * （`tools/lib/core-inventory.mjs`）——见那里的头注释，别在这里另写一套。
 *
 * 输出：
 *   - stdout：ASCII 摘要（Windows 控制台会把中文打成乱码，结论必须能被读到）
 *   - <coreDir>/../plugin-scan.json：结构化结果
 *   - <coreDir>/../plugin-scan.md  ：可直接抄进文档的证据表
 *
 * 用法：node tools/scan-core-plugins.mjs [coreDir]
 *   coreDir 默认跟着 hostcore/core-recipe.json 的 coreVersion 走：
 *   dist/core/work/dsh-core-<coreVersion>
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inventoryOf, pluginRowsOf } from './lib/core-inventory.mjs'

// 默认核心树跟着配方走（core-recipe.json 是唯一事实来源）——原先写死
// dsh-core-0.1.5-rc.2，升级后默认参数指向早已不存在的旧树，一跑就报
// "no node_modules under …"（看起来像"核心树没物化"，其实是版本陈旧）。
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const RECIPE = JSON.parse(readFileSync(join(ROOT, 'hostcore', 'core-recipe.json'), 'utf8'))
const coreDir = process.argv[2] ?? join(ROOT, 'dist', 'core', 'work', `dsh-core-${RECIPE.coreVersion}`)
const nm = join(coreDir, 'node_modules')
if (!existsSync(nm)) {
  console.error(`FATAL: no node_modules under ${coreDir}`)
  process.exit(1)
}

const inv = inventoryOf(nm)
const full = pluginRowsOf(nm)

console.log(`packages scanned: ${inv.packageCount}`)
console.log(`native (.node)  : ${inv.nativePackages.length}`)
for (const p of inv.nativePackages) console.log(`  NATIVE ${p}`)
for (const b of full.bundles) console.log(`rows in ${b.bundle}: ${b.rowCount}`)
console.log(`plugin rows total: ${inv.totals.pluginRows}`)
console.log(
  `resolved: PURE_JS ${inv.totals.pureJs} / NATIVE ${inv.totals.native} / UNKNOWN ${inv.totals.unknown}`,
)
for (const r of inv.plugins.filter((r) => r.nativeKind === 'NATIVE')) {
  console.log(`  PLUGIN-NATIVE ${r.id}  <- ${r.nativeVia.join(', ')}`)
}
for (const r of inv.plugins.filter((r) => r.nativeKind === 'UNKNOWN')) {
  console.log(`  PLUGIN-UNKNOWN ${r.id}  (${r.name})`)
}
const disabled = inv.plugins.filter((r) => r.disabled)
console.log(`disabled by default: ${disabled.length} -> ${disabled.map((d) => d.id).join(', ')}`)

// ── 落盘 ────────────────────────────────────────────────────────────────────
const base = dirname(coreDir)
const jsonPath = join(base, 'plugin-scan.json')
writeFileSync(
  jsonPath,
  JSON.stringify({ coreDir, scannedAt: new Date().toISOString(), ...inv }, null, 2),
  'utf8',
)
console.log(`report written: ${jsonPath}`)

const md = []
md.push('# 端侧核心插件扫描（离线，取自真实核心树）')
md.push('')
md.push(`- 核心树：\`${coreDir.replace(/\\/g, '/')}\``)
md.push(`- 包总数：${inv.packageCount}；含原生模块的包：${inv.nativePackages.length}`)
md.push(
  `- 插件行：${inv.totals.pluginRows}（纯 JS ${inv.totals.pureJs} / 依赖原生 ${inv.totals.native} / 待确认 ${inv.totals.unknown}；默认禁用 ${inv.totals.disabled}）`,
)
md.push('')
md.push('## 含原生模块的包（发版风险面）')
md.push('')
md.push('| 包（node_modules 相对路径） |')
md.push('| --- |')
for (const p of inv.nativePackages) md.push(`| \`${p}\` |`)
md.push('')
md.push('## 依赖原生码的插件行（运行时不可安装，只能随应用发版）')
md.push('')
const nat = inv.plugins.filter((r) => r.nativeKind === 'NATIVE')
if (nat.length === 0) {
  md.push('（无）')
} else {
  md.push('| 行 id | 包 | 经由 |')
  md.push('| --- | --- | --- |')
  for (const r of nat) {
    md.push(`| \`${r.id}\` | \`${r.name}\` | ${r.nativeVia.map((v) => `\`${v}\``).join(', ')} |`)
  }
}
md.push('')
md.push('## 全部插件行')
md.push('')
md.push('| 行 id | 包 | bundle | 判定 | 默认 |')
md.push('| --- | --- | --- | --- | --- |')
for (const r of inv.plugins) {
  md.push(
    `| \`${r.id}\` | \`${r.name}\` | ${r.bundle.replace('@deepseek-ai/', '')} | ${r.nativeKind} | ${r.disabled ? '禁用' : '启用'} |`,
  )
}
md.push('')
const mdPath = join(base, 'plugin-scan.md')
writeFileSync(mdPath, md.join('\n'), 'utf8')
console.log(`report written: ${mdPath}`)
