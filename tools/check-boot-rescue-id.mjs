#!/usr/bin/env node
/**
 * 门禁：内置救援插件的 **entry id 必须与外部同名插件区分开**，且两条实现只能跑一套。
 *
 * 【为什么要有这条（2026-11-12，docs/410）】
 * 外部 `dshm-boot-rescue@1.1.0` 与内置行曾共用 entry id `dshm-boot-rescue`。
 * `@deepseek-ai/dsh-app-boot` 的 bundle patches **先于** profile patch 应用，
 * `applyPatches()` 的 insert 只 `push` 不去重，`@deepseek-ai/cordis-plugin-loader`
 * 又用 `tree.store[options.id]` 按 id 建实体索引 ⇒ 后写的内置 1.0.0 静默顶掉外部 1.1.0：
 * 外部 `apply()` 永不执行、安全中心消失，插件页的「启停」切的是同 id 的内置那一份。
 * 真机取证：`dshm-boot-rescue.log` 165 行全部 `@1.0.0`，从未出现 1.1.0。
 *
 * 判据（四条，全离线）：
 *   ① 种子里 boot-rescue 的 insert 行 id = `dshm-boot-rescue-builtin`，name 不变；
 *   ② 内置包自带的 bundle patch 用**同一个** id（市场重装时不得再撞一次）；
 *   ③ 仓内不出现裸 `- id: dshm-boot-rescue`（那是外部包的行 id）；
 *   ④ 让位逻辑在位：`dshm-user-rows.js` 有外部版本探测 + 写 `disabled: true` 的分支，
 *      且 `RESCUE_BUILTIN_VERSION` 与 `hostcore/plugins/dshm-boot-rescue/package.json` 一致。
 *
 * 用法：
 *   node tools/check-boot-rescue-id.mjs
 *   node tools/check-boot-rescue-id.mjs --self-test
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const PROFILE_PATCH = 'hostcore/profile/ondevice/cordis.patch.yml'
const PLUGIN_PATCH = 'hostcore/plugins/dshm-boot-rescue/cordis.patch.yml'
const PLUGIN_PKG = 'hostcore/plugins/dshm-boot-rescue/package.json'
const ROWS_MODULE = 'hostcore/app/dshm-user-rows.js'

const BUILTIN_ID = 'dshm-boot-rescue-builtin'
const EXTERNAL_ID = 'dshm-boot-rescue'
const PKG_NAME = '@deepseek-ai/dshm-boot-rescue'

/**
 * @param {{profile:string, plugin:string, pkg:string, rows:string}} f
 * @returns {string[]} 问题描述（空数组 = 通过）
 */
export function judge(f) {
  const out = []

  /* ① 种子 insert */
  const at = f.profile.indexOf(`name: '${PKG_NAME}'`)
  if (at < 0) {
    out.push(`种子 patch 里找不到 name: '${PKG_NAME}' 的 insert 行`)
  } else {
    const head = f.profile.slice(Math.max(0, at - 200), at)
    if (!head.includes(`id: ${BUILTIN_ID}`)) {
      out.push(`种子 insert 的 id 不是 ${BUILTIN_ID}（内置与外部共用 id 会静默覆盖外部新版）`)
    }
  }

  /* ② 内置包 bundle patch 用同一 id */
  if (!new RegExp(`^\\s*-\\s+id:\\s*${BUILTIN_ID}\\s*$`, 'm').test(f.plugin)) {
    out.push(`内置包 cordis.patch.yml 的 id 不是 ${BUILTIN_ID}（市场重装会再撞一次）`)
  }
  if (!f.plugin.includes(`name: '${PKG_NAME}'`)) {
    out.push(`内置包 cordis.patch.yml 丢了 name: '${PKG_NAME}'`)
  }

  /* ③ 裸外部 id 不得出现在 patch 的顶层行 */
  for (const [label, text] of [['种子 patch', f.profile], ['内置包 patch', f.plugin]]) {
    const re = new RegExp(`^\\s*-\\s+id:\\s*${EXTERNAL_ID}\\s*$`, 'm')
    if (re.test(text)) {
      out.push(`${label} 出现裸 id: ${EXTERNAL_ID}（必须用 ${BUILTIN_ID}）`)
    }
  }

  /* ④ 让位逻辑 + 版本常量一致 */
  if (!f.rows.includes('resolveRescueYield') || !f.rows.includes('readExternalRescueVersion')) {
    out.push('dshm-user-rows.js 缺少救援让位逻辑（resolveRescueYield / readExternalRescueVersion）')
  }
  if (!f.rows.includes('disabled: true')) {
    out.push('dshm-user-rows.js 的让位行没有写 disabled: true')
  }
  const vm = /const RESCUE_BUILTIN_VERSION = '([^']+)'/.exec(f.rows)
  let pkgVersion = ''
  try {
    pkgVersion = JSON.parse(f.pkg).version ?? ''
  } catch (e) {
    out.push(`内置包 package.json 解析失败：${e.message}`)
  }
  if (vm === null) {
    out.push('dshm-user-rows.js 里找不到 RESCUE_BUILTIN_VERSION')
  } else if (pkgVersion !== '' && vm[1] !== pkgVersion) {
    out.push(`RESCUE_BUILTIN_VERSION=${vm[1]} 与内置包 version=${pkgVersion} 不一致（谁让位给谁会判错）`)
  }

  return out
}


/**
 * 行为臂：真的跑一次 `composeUserRows()`，验证让位行**按条件出现**。
 *
 * 静态判据只能证明"代码里有这几个词"，证明不了"外部在时确实让位、外部不在时确实不让位"。
 * 三种场景：无外部 / 外部 1.1.0（更新）/ 外部 0.9.0（更旧）。
 */
export function behavior() {
  const out = []
  const requireCjs = createRequire(import.meta.url)
  let mod
  try {
    mod = requireCjs('../hostcore/app/dshm-user-rows.js')
  } catch (e) {
    return [`无法加载 dshm-user-rows.js：${e.message}`]
  }
  const SEED = [
    '# seed',
    '- insert:',
    `    - id: ${BUILTIN_ID}`,
    `      name: '${PKG_NAME}'`,
    '',
  ].join('\n')

  const run = (externalVersion) => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-rescue-'))
    try {
      writeFileSync(join(dir, 'cordis.patch.yml'), SEED, 'utf8')
      if (externalVersion !== '') {
        const pkgDir = join(dir, 'node_modules', EXTERNAL_ID)
        mkdirSync(pkgDir, { recursive: true })
        writeFileSync(join(pkgDir, 'package.json'),
          JSON.stringify({ name: EXTERNAL_ID, version: externalVersion }), 'utf8')
      }
      mod.composeUserRows(dir, { log: () => {}, diag: () => {}, prevPatchText: '', profile: 'ondevice' })
      return readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch (e) { /* 临时目录 */ }
    }
  }

  const hasYield = (text) => new RegExp(`-\\s*id:\\s*${BUILTIN_ID}\\s*\\n\\s*disabled:\\s*true`).test(text)

  let text = ''
  try {
    text = run('')
    if (hasYield(text)) {
      out.push('外部未安装时也写了让位行（内置会被禁用 ⇒ 一个救援插件都不跑）')
    }
  } catch (e) {
    out.push(`场景「无外部」执行失败：${e.message}`)
  }

  try {
    text = run('1.1.0')
    if (!hasYield(text)) {
      out.push('外部 1.1.0 已安装但没写让位行（内置仍会顶掉外部新版）')
    }
  } catch (e) {
    out.push(`场景「外部 1.1.0」执行失败：${e.message}`)
  }

  try {
    text = run('0.9.0')
    if (hasYield(text)) {
      out.push('外部 0.9.0 比内置旧却仍让位（旧实现会被启用）')
    }
  } catch (e) {
    out.push(`场景「外部 0.9.0」执行失败：${e.message}`)
  }

  return out
}

function load(root = ROOT) {
  const read = (rel) => readFileSync(join(root, rel), 'utf8')
  return {
    profile: read(PROFILE_PATCH),
    plugin: read(PLUGIN_PATCH),
    pkg: read(PLUGIN_PKG),
    rows: read(ROWS_MODULE),
  }
}

function selfTest(base) {
  const arms = [
    ['内置 id 退回裸 dshm-boot-rescue（必须判红）', (f) => {
      f.profile = f.profile.replace(`id: ${BUILTIN_ID}`, `id: ${EXTERNAL_ID}`)
    }],
    ['内置包 patch 退回裸 id（必须判红）', (f) => {
      f.plugin = f.plugin.replace(`id: ${BUILTIN_ID}`, `id: ${EXTERNAL_ID}`)
    }],
    ['让位逻辑被删（必须判红）', (f) => {
      f.rows = f.rows.replace(/resolveRescueYield/g, 'noopYield')
    }],
    ['版本常量与包版本漂移（必须判红）', (f) => {
      f.rows = f.rows.replace(/const RESCUE_BUILTIN_VERSION = '[^']+'/, "const RESCUE_BUILTIN_VERSION = '9.9.9'")
    }],
    ['name 写错（必须判红）', (f) => {
      f.profile = f.profile.replace(`name: '${PKG_NAME}'`, "name: '@deepseek-ai/dshm-boot-rescueX'")
    }],
  ]
  let bad = 0
  console.log('\n== 对照臂：每条变异都必须判红 ==')
  for (const [name, mutate] of arms) {
    const copy = { ...base }
    mutate(copy)
    const got = judge(copy)
    const ok = got.length > 0
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}（问题数 ${got.length}）`)
    if (!ok) bad++
  }
  return bad
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const base = load()
  const problems = [...judge(base), ...behavior()]
  console.log('== 主检：内置救援插件 entry id 与让位逻辑 ==')
  if (problems.length === 0) {
    console.log(`  PASS（id=${BUILTIN_ID}，外部 id=${EXTERNAL_ID} 不再被覆盖）`)
  } else {
    console.log(`  FAIL（${problems.length} 条失败）`)
    for (const p of problems) console.log('  ✗ ' + p)
  }

  if (process.argv.includes('--self-test')) {
    const bad = selfTest(base)
    if (problems.length > 0 || bad > 0) {
      console.error(`\n❌ 失败：主检 ${problems.length} 条 / 对照臂 ${bad} 条未判红`)
      process.exit(1)
    }
    console.log('\n✅ 自检通过：主检 0 问题，5 个变异体全部判红。')
    process.exit(0)
  }

  if (problems.length > 0) {
    console.error('\n❌ 内置救援插件的 id 冲突守卫不成立，见上。')
    process.exit(1)
  }
  console.log('\n✅ 通过：内置 id 独立、外部 id 不被覆盖、让位逻辑与版本常量自洽。')
}
