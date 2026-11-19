#!/usr/bin/env node
/**
 * 把 DevEco 侧（DevEco Studio 的 AI 助手）的技能包「继承」进 DSH 的技能根。
 *
 * ## 为什么要有这条（而不是手工拷一份）
 *
 * DSH 的技能发现根（`@deepseek-ai/dsh-skill-filesystem`）是按**目录包**认的：
 * `<root>/<skill>/SKILL.md` + 同目录下的 `assets/` `reference/` `scripts/`。
 * 而 DevEco 侧的技能包也在同一形态里带着**上游会升级**的内容（现在 `.version` = `0.1.4`），
 * 手工拷贝的两个必然结局：① 忘了拷新版本；② 拷了一半（漏 `reference/` 或 `assets/`），
 * 技能"看起来在、用起来缺素材"。两种都**不会报错**，只会在真用的时候出问题。
 *
 * 所以这里做成一次可重复跑的同步，判据是**逐文件 sha256**：
 *   - 只增/改，**不删**（默认）；`--prune` 才清掉「源侧已消失」的旧文件；
 *   - 等长改动（大小相同、内容不同）也必须被检出 —— 这正是 `tools/check-skill-sync.cjs`
 *     那条门禁的真实事故：按字节数判等 ⇒ 文档改了但设备上永远没生效；
 *   - 目标根是**共享技能根**（`~/.dsh/skills` 里还可能有用户自己的技能）⇒
 *     只碰「源侧有」和「本脚本清单登记过」的目录，别的一律不动。
 *
 * ## 两侧路径怎么定（不许写死任何安装根）
 *
 * - 源：`<home>/.local/share/deveco/skills`（DevEco Code 的用户数据区；`DEVECO_USER_HOME` 可覆盖，
 *   再兜 `%APPDATA%/deveco/skills`）。**注意不是** `tools/lib/deveco-home.mjs` 那个安装根解析口 ——
 *   技能跟着用户数据走，不跟安装目录走。本脚本里因此**没有任何** Windows 绝对路径字面量。
 * - 目标：`<DSH_HOME>/skills`（`DSH_HOME` 未设时 `~/.dsh/skills`，与 `@deepseek-ai/dsh-home-paths` 同口径）。
 *
 * ## 用法
 *
 *   node tools/sync-deveco-skills.mjs                    # 同步（幂等；第二次跑 0 复制）
 *   node tools/sync-deveco-skills.mjs --check            # 只判定：有差异退出 1（不写盘）
 *   node tools/sync-deveco-skills.mjs --prune            # 连"源侧已消失"的旧文件一起清掉
 *   node tools/sync-deveco-skills.mjs --source=<dir> --dest=<dir>
 *   node tools/sync-deveco-skills.mjs --self-test        # 注入式自检（26 条）
 *
 * 退出码：0 同步完成/已一致；1 源侧技能包不合法或 --check 发现差异；2 参数错；3 环境受限（找不到源）。
 *
 * 【控制台口径】输出一律 ASCII（PS 5.1 / GBK 控制台安全，同 `check-skill-sync.cjs`）。
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

/** 同步清单落在目标根（`.json` 不会被当成技能：发现器只认顶层 `*.md` 与 `<dir>/SKILL.md`）。 */
export const MANIFEST_NAME = '.deveco-skills.manifest.json'
const MANIFEST_SCHEMA = 1
const GENERATOR = 'tools/sync-deveco-skills.mjs'
/** 原子写的临时后缀；崩在中途留下的这类文件下次跑会被扫掉。 */
export const TMP_SUFFIX = '.dshm-sync-tmp'

/** 技能包里不该被继承的目录（源侧万一有，别把依赖树搬进技能根）。 */
const SKIP_DIR_NAMES = new Set(['node_modules', '.git'])

/** 与 `@deepseek-ai/dsh-skill` 的 `isSkillName` 同一条判据：名字不合法 = 整条技能被静默忽略。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function sha256File(path) {
  return sha256Bytes(readFileSync(path))
}

function toSlash(rel) {
  return rel.split(sep).join('/')
}

/** 递归列出目录下的**文件**相对路径（不含目录自身；跳过依赖树/版本库目录）。 */
export function listRelFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue
      listRelFiles(join(dir, entry.name), base, out)
    } else if (entry.isFile()) {
      out.push(toSlash(relative(base, join(dir, entry.name))))
    } else if (entry.isSymbolicLink()) {
      // 链接按目标内容复制：技能根里留一个指向 DevEco 数据区的链接，DevEco 一升级就断。
      const target = statSync(join(dir, entry.name))
      if (target.isFile()) out.push(toSlash(relative(base, join(dir, entry.name))))
    }
  }
  return out
}

/**
 * 最小 frontmatter 解析：只取顶层 `key: value`（技能包只用到 `name` / `description`）。
 * 解析失败返回 `undefined`，由调用方判红 —— DSH 侧遇到这种文件是**静默忽略**的，
 * 同步器必须比它更吵，否则"继承了一堆看不见的技能"。
 */
export function parseSkillFrontmatter(text) {
  const m = FRONTMATTER_RE.exec(text)
  if (!m) return undefined
  const fields = {}
  for (const rawLine of m[1].split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    fields[key] = value
  }
  return fields
}

/** 源目录候选（先环境变量，再 XDG 同形态路径，再 Windows 的 %APPDATA%）。 */
export function sourceCandidates(env = process.env, home = homedir()) {
  const out = []
  const explicit = env.DEVECO_USER_HOME
  if (explicit !== undefined && explicit.trim() !== '') out.push(join(explicit.trim(), 'skills'))
  out.push(join(home, '.local', 'share', 'deveco', 'skills'))
  if (env.APPDATA !== undefined && env.APPDATA.trim() !== '') out.push(join(env.APPDATA.trim(), 'deveco', 'skills'))
  return out
}

export function resolveSourceDir(explicit) {
  if (explicit !== undefined) return existsSync(explicit) ? resolve(explicit) : undefined
  for (const candidate of sourceCandidates()) if (existsSync(candidate)) return resolve(candidate)
  return undefined
}

export function resolveDestDir(explicit, env = process.env, home = homedir()) {
  if (explicit !== undefined) return resolve(explicit)
  const dshHome = env.DSH_HOME !== undefined && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : join(home, '.dsh')
  return resolve(join(dshHome, 'skills'))
}

/** 扫源：把每个「子目录 + SKILL.md」认成一条技能；顶层散文件一律不参与。 */
export function collectSourceSkills(srcRoot) {
  const skills = []
  const ignored = []
  const warnings = []
  const errors = []
  let version
  const versionFile = join(srcRoot, '.version')
  if (existsSync(versionFile)) {
    try {
      version = readFileSync(versionFile, 'utf8').trim() || undefined
    } catch {
      version = undefined
    }
  }

  const entries = readdirSync(srcRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (SKIP_DIR_NAMES.has(entry.name)) continue
    const dir = join(srcRoot, entry.name)
    const skillFile = join(dir, 'SKILL.md')
    if (!existsSync(skillFile)) {
      ignored.push(entry.name)
      continue
    }
    let text
    try {
      text = readFileSync(skillFile, 'utf8')
    } catch (error) {
      errors.push(`${entry.name}/SKILL.md: unreadable (${String(error && error.message)})`)
      continue
    }
    const fields = parseSkillFrontmatter(text)
    if (fields === undefined) {
      errors.push(`${entry.name}/SKILL.md: missing YAML frontmatter`)
      continue
    }
    const name = fields.name
    const description = fields.description
    if (name === undefined || name === '' || description === undefined || description === '') {
      errors.push(`${entry.name}/SKILL.md: frontmatter requires name and description`)
      continue
    }
    if (!SKILL_NAME_RE.test(name)) {
      errors.push(`${entry.name}/SKILL.md: invalid skill name "${name}" (must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/)`)
      continue
    }
    if (name !== entry.name) warnings.push(`${entry.name}: frontmatter name "${name}" differs from directory name`)
    skills.push({ name, dirName: entry.name, dir, description })
  }

  return { skills, ignored, warnings, errors, version }
}

/** 把源侧展开成「相对路径 → 源文件 + sha256」，不碰目标。 */
export function buildPlan(srcRoot) {
  const scanned = collectSourceSkills(srcRoot)
  if (scanned.errors.length > 0) return { ok: false, ...scanned, desired: new Map(), skills: [] }

  const desired = new Map()
  const skills = []
  for (const skill of scanned.skills) {
    const rels = listRelFiles(skill.dir)
    for (const rel of rels) {
      const srcPath = join(skill.dir, rel)
      desired.set(`${skill.dirName}/${rel}`, { srcPath, sha: sha256File(srcPath) })
    }
    skills.push({ name: skill.name, dirName: skill.dirName, fileCount: rels.length })
  }
  return { ok: true, ...scanned, desired, skills }
}

function atomicWriteFile(target, content) {
  const tmp = target + TMP_SUFFIX
  try {
    writeFileSync(tmp, content)
    renameSync(tmp, target)
  } finally {
    rmSync(tmp, { force: true })
  }
}

function atomicCopyFile(src, target) {
  const tmp = target + TMP_SUFFIX
  try {
    copyFileSync(src, tmp)
    renameSync(tmp, target)
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** 扫掉上次崩在中途留下的临时文件（只在目标根与源侧技能目录下）。 */
export function sweepTempFiles(root, relFiles) {
  let removed = 0
  const direct = join(root, MANIFEST_NAME + TMP_SUFFIX)
  if (existsSync(direct)) {
    rmSync(direct, { force: true })
    removed += 1
  }
  for (const rel of relFiles) {
    const tmp = join(root, ...rel.split('/')) + TMP_SUFFIX
    if (existsSync(tmp)) {
      rmSync(tmp, { force: true })
      removed += 1
    }
  }
  return removed
}

export function readManifest(destRoot) {
  try {
    const parsed = JSON.parse(readFileSync(join(destRoot, MANIFEST_NAME), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * 同步主体。`log` 拿结构化事件（自检不需要它），返回值是**全部判定依据**，
 * 不在里面用 console 输出 —— 自检要断言的是返回值，不是字符串。
 */
export function syncDevecoSkills(options) {
  const { source, dest } = options
  const check = options.check === true
  const prune = options.prune === true
  const report = {
    source,
    dest,
    checkOnly: check,
    prune,
    ok: true,
    outOfSync: false,
    version: undefined,
    skills: [],
    copied: [],
    unchanged: 0,
    stale: [],
    pruned: [],
    ignored: [],
    warnings: [],
    errors: [],
    manifestWritten: false,
    restored: [],
  }
  if (source === undefined || !existsSync(source) || !statSync(source).isDirectory()) {
    report.ok = false
    report.errors.push(`source skill root not found: ${String(source)}`)
    return report
  }
  // 目标根不能包住源根（否则「同步」会把自己的产物当源，越滚越大）
  const relSourceInDest = relative(dest, source)
  const relDestInSource = relative(source, dest)
  const inside = (rel) => rel !== '' && !rel.startsWith('..') && !/^[A-Za-z]:/.test(rel)
  if (inside(relSourceInDest) || inside(relDestInSource)) {
    report.ok = false
    report.errors.push(`source and dest overlap: ${source} <-> ${dest}`)
    return report
  }

  const plan = buildPlan(source)
  report.version = plan.version
  report.ignored = plan.ignored
  report.warnings = plan.warnings
  if (!plan.ok) {
    report.ok = false
    report.errors = plan.errors
    return report
  }

  const tmpSwept = check ? 0 : sweepTempFiles(dest, [...plan.desired.keys()])
  if (tmpSwept > 0) report.restored.push(`${tmpSwept} leftover temp file(s)`)

  const copiedByDir = new Map()
  const unchangedByDir = new Map()
  for (const [key, item] of [...plan.desired.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dirName = key.slice(0, key.indexOf('/'))
    const dstPath = join(dest, ...key.split('/'))
    let same = false
    if (existsSync(dstPath)) {
      try {
        same = statSync(dstPath).isFile() && sha256File(dstPath) === item.sha
      } catch {
        same = false
      }
    }
    if (same) {
      report.unchanged += 1
      unchangedByDir.set(dirName, (unchangedByDir.get(dirName) ?? 0) + 1)
      continue
    }
    report.outOfSync = true
    report.copied.push(key)
    copiedByDir.set(dirName, (copiedByDir.get(dirName) ?? 0) + 1)
    if (!check) {
      mkdirSync(dirname(dstPath), { recursive: true })
      atomicCopyFile(item.srcPath, dstPath)
    }
  }

  // 「源侧已消失 / 目标被塞进来」的文件：默认只报不动（共享技能根里可能是别人的东西）。
  // 归属面 = 源侧现有技能目录 ∪ 清单登记过的技能目录。
  const ownedDirs = new Set(plan.skills.map((s) => s.dirName))
  const manifest = readManifest(dest)
  if (manifest !== undefined && manifest.files !== null && typeof manifest.files === 'object') {
    for (const key of Object.keys(manifest.files)) ownedDirs.add(String(key).split('/')[0])
  }
  for (const dirName of [...ownedDirs].sort()) {
    const dir = join(dest, dirName)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
    for (const rel of listRelFiles(dir)) {
      const key = `${dirName}/${rel}`
      if (plan.desired.has(key)) continue
      report.stale.push(key)
    }
  }
  if (report.stale.length > 0) report.outOfSync = true

  if (prune && !check && report.stale.length > 0) {
    for (const key of report.stale) {
      const target = join(dest, ...key.split('/'))
      rmSync(target, { force: true })
      report.pruned.push(key)
      // 只清到目标根为止，且只删空目录
      let dir = dirname(target)
      while (dir !== dest && dir.startsWith(dest + sep)) {
        try {
          if (readdirSync(dir).length > 0) break
        } catch {
          break
        }
        try {
          rmSync(dir, { recursive: false })
        } catch {
          break
        }
        dir = dirname(dir)
      }
    }
    // 整条技能在源侧消失 ⇒ 目录本体也要收走（只收清单登记过的那几条）
    const sourceDirNames = new Set(plan.skills.map((s) => s.dirName))
    if (manifest !== undefined && manifest.files !== null && typeof manifest.files === 'object') {
      const registered = new Set(Object.keys(manifest.files).map((key) => String(key).split('/')[0]))
      for (const dirName of registered) {
        if (sourceDirNames.has(dirName)) continue
        const dir = join(dest, dirName)
        if (!existsSync(dir)) continue
        const leftovers = listRelFiles(dir)
        if (leftovers.length > 0) continue
        try {
          rmSync(dir, { recursive: true, force: true })
          report.pruned.push(`${dirName}/ (whole skill)`)
        } catch {
          // 删不掉就算了：下一轮还会报 stale，不会静默
        }
      }
    }
  }

  report.skills = plan.skills.map((skill) => ({
    ...skill,
    copied: copiedByDir.get(skill.dirName) ?? 0,
    unchanged: unchangedByDir.get(skill.dirName) ?? 0,
  }))

  if (!check) {
    // 清单内容是**确定性**的（键排序、不含时间戳）⇒ 内容没变就不写盘，
    // 于是「第二次跑」可以被 mtime 证明为真幂等。
    const files = {}
    for (const key of [...plan.desired.keys()].sort()) files[key] = plan.desired.get(key).sha
    const manifestText =
      JSON.stringify(
        {
          schema: MANIFEST_SCHEMA,
          generator: GENERATOR,
          source: { path: source, version: report.version ?? null },
          skills: plan.skills.map((s) => s.name).sort(),
          files,
        },
        null,
        2,
      ) + '\n'
    const manifestPath = join(dest, MANIFEST_NAME)
    let previous
    try {
      previous = readFileSync(manifestPath, 'utf8')
    } catch {
      previous = undefined
    }
    mkdirSync(dest, { recursive: true })
    if (previous !== manifestText) {
      atomicWriteFile(manifestPath, manifestText)
      report.manifestWritten = true
    }
  }

  return report
}

const USAGE = [
  'Usage: node tools/sync-deveco-skills.mjs [options]',
  '',
  '  --check            dry run: exit 1 when the DSH skill root is out of sync',
  '  --prune            also remove files whose source is gone (owned dirs only)',
  '  --source=<dir>     override the DevEco skill root',
  '  --dest=<dir>       override the DSH skill root (default <DSH_HOME>/skills)',
  '  --self-test        run the injected self test (12 assertions)',
  '  -h, --help         this text',
  '',
  'Exit codes: 0 synced/in-sync, 1 invalid source or out of sync, 2 bad usage, 3 source missing.',
].join('\n')

function parseArgs(argv) {
  const opts = { check: false, prune: false, selfTest: false, help: false, source: undefined, dest: undefined }
  for (const arg of argv) {
    if (arg === '--check') opts.check = true
    else if (arg === '--prune') opts.prune = true
    else if (arg === '--self-test') opts.selfTest = true
    else if (arg === '-h' || arg === '--help') opts.help = true
    else if (arg.startsWith('--source=')) opts.source = arg.slice('--source='.length)
    else if (arg.startsWith('--dest=')) opts.dest = arg.slice('--dest='.length)
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

function printReport(report, opts) {
  const mode = report.checkOnly ? 'check' : report.prune ? 'sync+prune' : 'sync'
  console.log('# 继承 DevEco 技能 -> DSH 技能根\n')
  console.log(`source  : ${report.source}`)
  console.log(`version : ${report.version ?? '(none)'}`)
  console.log(`dest    : ${report.dest}`)
  console.log(`mode    : ${mode}`)
  const totalFiles = report.skills.reduce((n, s) => n + s.fileCount, 0)
  console.log(`skills  : ${report.skills.length} (${totalFiles} files)`)
  for (const skill of report.skills) {
    console.log(`  - ${skill.name}: ${skill.fileCount} files, ${skill.copied} ${report.checkOnly ? 'pending' : 'copied'}, ${skill.unchanged} unchanged`)
  }
  if (report.ignored.length > 0) console.log(`ignored dirs (no SKILL.md): ${report.ignored.join(', ')}`)
  for (const warn of report.warnings) console.log(`warn    : ${warn}`)
  console.log(`copied  : ${report.copied.length}`)
  console.log(`unchanged: ${report.unchanged}`)
  console.log(`stale   : ${report.stale.length}`)
  if (report.stale.length > 0) {
    for (const key of report.stale.slice(0, 20)) console.log(`  ~ ${key}${report.pruned.includes(key) ? ' (pruned)' : ''}`)
    if (report.stale.length > 20) console.log(`  ... ${report.stale.length - 20} more`)
    if (!opts.prune && !report.checkOnly) console.log('  (kept: pass --prune to remove them)')
  }
  if (report.pruned.length > report.stale.length) {
    for (const extra of report.pruned.slice(report.stale.length)) console.log(`  - ${extra} (pruned)`)
  }
  if (report.manifestWritten) console.log('manifest: rewritten')
  for (const line of report.restored) console.log(`cleanup : ${line}`)
  for (const error of report.errors) console.error(`error   : ${error}`)
}

function runSelfTest() {
  const root = mkdtempSync(join(tmpdir(), 'dshm-deveco-sync-'))
  let passed = 0
  let failed = 0
  const check = (label, cond, detail) => {
    if (cond) {
      passed += 1
      console.log(`[PASS] ${label}`)
    } else {
      failed += 1
      console.log(`[FAIL] ${label}${detail === undefined ? '' : ' :: ' + String(detail)}`)
    }
  }
  const write = (path, text) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  const read = (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  }
  const skillA = (src) => join(src, 'skill-a')
  const makeSource = (tag) => {
    const src = join(root, tag, 'src')
    write(join(skillA(src), 'SKILL.md'), '---\nname: skill-a\ndescription: Fixture skill A.\n---\n\nbody A\n')
    write(join(skillA(src), 'reference', 'note.md'), 'note\n')
    write(join(skillA(src), 'scripts', 'run.mjs'), 'console.log(1)\n')
    write(join(src, 'skill-b', 'SKILL.md'), '---\nname: skill-b\ndescription: Fixture skill B.\n---\n\nbody B\n')
    write(join(src, '.version'), '9.9.9\n')
    write(join(src, 'loose.md'), '# not a skill root file\n') // 顶层散文件：DevEco 侧格式里没有，也不该被当成技能
    return src
  }
  const dstOf = (tag) => join(root, tag, 'dst')

  // ── A 首次同步：全量复制 + 顶层散文件不参与 + 清单落位 ──────────────
  {
    const src = makeSource('first')
    const dst = dstOf('first')
    const r = syncDevecoSkills({ source: src, dest: dst })
    check('A1 首次同步复制全部 4 个文件', r.copied.length === 4, JSON.stringify(r.copied))
    check('A2 首次同步无 stale / 无 error', r.stale.length === 0 && r.errors.length === 0, JSON.stringify(r))
    check('A3 目标内容与源逐字节一致（嵌套 reference）', read(join(dst, 'skill-a', 'reference', 'note.md')) === 'note\n')
    check('A4 顶层散文件与 .version 都没被当成技能复制', read(join(dst, 'loose.md')) === null && read(join(dst, '.version')) === null)
    check('A5 清单登记 4 个文件且记录源版本', (() => {
      const m = readManifest(dst)
      return m !== undefined && m.schema === 1 && m.source.version === '9.9.9' && Object.keys(m.files).length === 4
    })(), JSON.stringify(readManifest(dst)))
  }

  // ── B 真幂等：内容没变就不写盘（mtime 证明）────────────────────────
  {
    const src = join(root, 'first', 'src')
    const dst = dstOf('first')
    const target = join(dst, 'skill-a', 'SKILL.md')
    const stamp = new Date(Date.now() - 86400000)
    utimesSync(target, stamp, stamp)
    const before = statSync(target).mtimeMs
    const manifestBefore = statSync(join(dst, MANIFEST_NAME)).mtimeMs
    const r = syncDevecoSkills({ source: src, dest: dst })
    check('B1 内容相同 => copied 为空', r.copied.length === 0, JSON.stringify(r.copied))
    check('B2 内容相同 => unchanged 计满 4', r.unchanged === 4, r.unchanged)
    check('B3 目标文件未被触碰（mtime 不变）', statSync(target).mtimeMs === before, `${before} vs ${statSync(target).mtimeMs}`)
    check('B4 清单内容未变 => 不重写（mtime 不变）', r.manifestWritten === false && statSync(join(dst, MANIFEST_NAME)).mtimeMs === manifestBefore)
  }

  // ── C 等长改动（本脚本存在的理由：sha256 而不是大小/mtime）──────────
  {
    const src = makeSource('equallen')
    const dst = dstOf('equallen')
    syncDevecoSkills({ source: src, dest: dst })
    // 先让目标侧是旧内容，再把源侧换成**等长**新内容
    write(join(src, 'skill-b', 'SKILL.md'), '---\nname: skill-b\ndescription: Fixture skill B.\n---\n\nbody C\n')
    const sizeSrc = statSync(join(src, 'skill-b', 'SKILL.md')).size
    const sizeDst = statSync(join(dst, 'skill-b', 'SKILL.md')).size
    check('C0 夹具前提：新旧两份字节数相同', sizeSrc === sizeDst, `${sizeSrc} vs ${sizeDst}`)
    const r = syncDevecoSkills({ source: src, dest: dst })
    check('C1 等长改动被检出并复制', r.copied.length === 1 && r.copied[0] === 'skill-b/SKILL.md', JSON.stringify(r.copied))
    check('C2 目标内容真的更新了', read(join(dst, 'skill-b', 'SKILL.md')).includes('body C'))
    // 反向：目标被等长篡改 ⇒ 以源为准恢复
    write(join(dst, 'skill-b', 'SKILL.md'), read(join(dst, 'skill-b', 'SKILL.md')).replace('body C', 'body X'))
    const r2 = syncDevecoSkills({ source: src, dest: dst })
    check('C3 目标被等长篡改 => 以源为准恢复', r2.copied.length === 1 && read(join(dst, 'skill-b', 'SKILL.md')).includes('body C'))
  }

  // ── D 源侧消失的旧文件：默认只报不删，--prune 才删 ─────────────────
  {
    const src = makeSource('stale')
    const dst = dstOf('stale')
    syncDevecoSkills({ source: src, dest: dst })
    write(join(dst, 'skill-a', 'extra.md'), 'left over\n')
    const r = syncDevecoSkills({ source: src, dest: dst })
    check('D1 默认只报 stale、不删', r.stale.includes('skill-a/extra.md') && read(join(dst, 'skill-a', 'extra.md')) === 'left over\n', JSON.stringify(r.stale))
    check('D2 stale 不改动已同步文件计数', r.copied.length === 0 && r.unchanged === 4)
    const r2 = syncDevecoSkills({ source: src, dest: dst, prune: true })
    check('D3 --prune 真的删掉 stale 文件', r2.pruned.includes('skill-a/extra.md') && read(join(dst, 'skill-a', 'extra.md')) === null, JSON.stringify(r2.pruned))
  }

  // ── E --check：只判定，不写盘 ──────────────────────────────────────
  {
    const src = makeSource('checkmode')
    const dst = dstOf('checkmode')
    syncDevecoSkills({ source: src, dest: dst })
    write(join(src, 'skill-a', 'reference', 'note.md'), 'note v2\n')
    const r = syncDevecoSkills({ source: src, dest: dst, check: true })
    check('E1 --check 报 out-of-sync 且不写目标', r.outOfSync === true && read(join(dst, 'skill-a', 'reference', 'note.md')) === 'note\n', JSON.stringify(r.copied))
    const r2 = syncDevecoSkills({ source: src, dest: dst, check: true })
    check('E2 --check 之后仍不一致（证明真的没写）', r2.outOfSync === true)
    syncDevecoSkills({ source: src, dest: dst })
    check('E3 真同步后 --check 转绿', syncDevecoSkills({ source: src, dest: dst, check: true }).outOfSync === false)
  }

  // ── F 源侧不合法：判红且**一个字节都不写** ─────────────────────────
  {
    const src = join(root, 'broken', 'src')
    write(join(src, 'skill-bad', 'SKILL.md'), '---\nname: skill-bad\n---\n\nmissing description\n')
    const dst = dstOf('broken')
    const r = syncDevecoSkills({ source: src, dest: dst })
    check('F1 缺 description 的 SKILL.md 判红', r.ok === false && r.errors.length > 0, JSON.stringify(r.errors))
    check('F2 判红时目标根一个文件都没写', !existsSync(join(dst, 'skill-bad')))
    const src2 = join(root, 'broken2', 'src')
    write(join(src2, 'Bad_Name', 'SKILL.md'), '---\nname: Bad_Name\ndescription: upper case name.\n---\n')
    const r2 = syncDevecoSkills({ source: src2, dest: dstOf('broken2') })
    check('F3 与 DSH 同一条名字判据（大写人名必红）', r2.ok === false && /invalid skill name/.test(r2.errors.join('\n')), JSON.stringify(r2.errors))
  }

  // ── G 源不存在 / 命令行解析 ────────────────────────────────────────
  {
    const missing = syncDevecoSkills({ source: join(root, 'nope'), dest: dstOf('nope') })
    check('G1 源不存在 => ok=false 且有可读原因', missing.ok === false && /not found/.test(missing.errors.join('\n')))
    const parsed = parseArgs(['--check', '--prune', '--source=a', '--dest=b'])
    check('G2 参数解析（--source/--dest/--check/--prune）', parsed.check && parsed.prune && parsed.source === 'a' && parsed.dest === 'b')
    let threw = false
    try {
      parseArgs(['--nope'])
    } catch {
      threw = true
    }
    check('G3 未知参数一律拒绝', threw)
  }

  // ── H 崩溃残留的临时文件会被扫掉 ──────────────────────────────────
  {
    const src = makeSource('temp')
    const dst = dstOf('temp')
    syncDevecoSkills({ source: src, dest: dst })
    write(join(dst, 'skill-a', 'reference', 'note.md') + TMP_SUFFIX, 'half written\n')
    const r = syncDevecoSkills({ source: src, dest: dst })
    check('H1 上次留下的 temp 文件被清掉', !existsSync(join(dst, 'skill-a', 'reference', 'note.md') + TMP_SUFFIX) && r.restored.length === 1, JSON.stringify(r.restored))
  }

  rmSync(root, { recursive: true, force: true })
  if (failed > 0) {
    console.error(`\n[FAIL] self-test: ${failed} failed, ${passed} passed`)
    process.exit(1)
  }
  console.log(`\n[OK] self-test: ${passed}/${passed} passed`)
  process.exit(0)
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(String(error && error.message))
    console.error(USAGE)
    process.exit(2)
  }
  if (opts.help) {
    console.log(USAGE)
    process.exit(0)
  }
  if (opts.selfTest) {
    runSelfTest()
  }
  const source = resolveSourceDir(opts.source)
  const dest = resolveDestDir(opts.dest)
  if (source === undefined) {
    console.error('# 继承 DevEco 技能 -> DSH 技能根\n')
    console.error(`环境受限：找不到 DevEco 技能根。候选：\n  ${sourceCandidates().join('\n  ')}`)
    console.error('可用 --source=<dir> 或 DEVECO_USER_HOME=<DevEco 用户数据目录> 指定。')
    process.exit(3)
  }
  const report = syncDevecoSkills({ source, dest, check: opts.check, prune: opts.prune })
  printReport(report, opts)
  if (!report.ok) process.exit(1)
  if (report.checkOnly && report.outOfSync) {
    console.log('\n[OUT-OF-SYNC] 目标技能根与源不一致；跑不带 --check 的同一条命令即可同步。')
    process.exit(1)
  }
  console.log(report.copied.length === 0 && report.stale.length === 0 ? '\n[OK] already in sync（0 复制）' : '\n[OK] synced')
  process.exit(0)
}
