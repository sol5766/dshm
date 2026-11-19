#!/usr/bin/env node
/**
 * 门禁：**包内不得出现 apk 相关的目录 / 文件 / 归档条目**（用户 2026-10-14 拍板，永久生效）。
 *
 * 【为什么要有这条】应用市场审核**按路径判**"包里带 apk 相关目录或文件"就判**安装失败**
 * （`docs/148`：当年的 `.app` 里带着 Alpine 的 `.apk`，手机/平板直接装不上）。随包的
 * Alpine 包因此改名为 `.tar.gz`、目录从 `vm/apk/` 改成 `vm/guestpkgs/`。
 * 但改名这条只靠"人记得"不够 —— 上游包升级、脚本重跑、旧产物回填，任何一处都能把它带回来。
 * 所以把它钉成门禁：**文件扩展名、目录名、归档条目名**三处同时判。
 *
 * 【判据（四条）】
 *   ① 全仓**没有**扩展名为 `.apk` / `.apks` / `.xapk` / `.aab` 的文件（大小写不敏感）。
 *   ② 全仓**没有**名字里带 `apk` 的**目录**（大小写不敏感）。
 *   ③ 会被装进包的归档（`entry/src/main/resources/resfile/`、`entry/build/`（含 outputs/）、
 *      `dist/sideload/` 三棵子树下的 `.zip` / `.hap` / `.app`）里，**条目名**不得带 `apk`。
 *      只读中央目录，不解压（400 MB 级的 HAP 也能秒级扫完）；支持 Zip64。
 *   ④ `third_party/` 下随包的 guest 包闭包目录，文件名一律 `.tar.gz`（拦"手抖放回 .apk"）。
 *
 * 【为什么只判"路径"不判"正文"】
 * guest 里装包走的是 Alpine 的包管理器，**命令名本身**（`apk add` / `apk-tools` / `APKINDEX`）
 * 必须留在 provisioning 脚本里 —— 那是 guest 内部的事，不出现在**任何路径**上，审核不看它。
 * 判据盯的是"路径里带 apk"，不是"正文里提没提过这个词"：后者会把正确的注释/文档一起判红。
 *
 * 【离线】不碰网络、不碰 SDK、不碰真机、不跑构建。
 *
 * 用法：
 *   node tools/check-no-apk-surface.mjs              # 四条判据
 *   node tools/check-no-apk-surface.mjs --self-test  # 变异体自检（.apk 文件 / apk 目录 / 归档条目 / 干净样例）
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = join(HERE, '..')

/** ① 文件扩展名黑名单（全小写比较）。 */
export const BANNED_EXTS = new Set(['.apk', '.apks', '.xapk', '.aab'])

/** ② 目录名里出现就判红的词（全小写子串匹配）。 */
export const BANNED_DIR_TOKEN = 'apk'

/** ③ 会被装进包 / 会被侧载的归档所在目录（相对 REPO 的 posix 前缀）+ 扩展名。 */
const ARCHIVE_ROOTS = ['entry/src/main/resources/resfile', 'entry/build', 'dist/sideload']
const ARCHIVE_EXTS = new Set(['.zip', '.hap', '.app'])

const WALK_SKIP_DIRS = new Set(['.git'])
const WALK_MAX_DEPTH = 30

/* ────────────────────────────── ①② 文件 / 目录 ────────────────────────────── */

/**
 * 递归走全仓，收集"扩展名命中"的文件与"名字命中"的目录。
 * 纯函数式的返回值便于自检复用：`{ files, dirs, dirsVisited }`。
 */
export function scanTree(root) {
  const files = []
  const dirs = []
  let dirsVisited = 0
  const stack = [{ dir: root, depth: 0 }]
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    dirsVisited++
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (WALK_SKIP_DIRS.has(e.name)) continue
        if (e.name.toLowerCase().includes(BANNED_DIR_TOKEN)) {
          dirs.push(relative(root, full).replace(/\\/g, '/'))
        }
        if (depth + 1 < WALK_MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (!e.isFile()) continue
      if (BANNED_EXTS.has(extname(e.name).toLowerCase())) {
        files.push(relative(root, full).replace(/\\/g, '/'))
      }
    }
  }
  return { files: files.sort(), dirs: dirs.sort(), dirsVisited }
}

/* ────────────────────────────── ③ 归档条目名 ────────────────────────────── */

/** 从中央目录读条目名（不解压）。支持 Zip64；不是 zip 时返回 null。 */
export function readZipEntryNames(buf) {
  if (buf.length < 22) return null
  // EOCD：从尾部往回找（注释最长 65535）
  const minEocd = Math.max(0, buf.length - (0xffff + 22))
  let eocd = -1
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null
  let count = buf.readUInt16LE(eocd + 10)
  let cdOffset = buf.readUInt32LE(eocd + 16)
  // Zip64：EOCD 里是哨兵值 ⇒ 走 Zip64 EOCD 记录
  if (count === 0xffff || cdOffset === 0xffffffff) {
    let loc = -1
    for (let i = eocd - 20; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x07064b50) {
        loc = i
        break
      }
    }
    if (loc < 0) return null
    const z64 = Number(buf.readBigUInt64LE(loc + 8))
    if (z64 < 0 || z64 + 56 > buf.length) return null
    if (buf.readUInt32LE(z64) !== 0x06064b50) return null
    count = Number(buf.readBigUInt64LE(z64 + 32))
    cdOffset = Number(buf.readBigUInt64LE(z64 + 48))
  }
  const names = []
  let off = cdOffset
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) return null
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    if (off + 46 + nameLen > buf.length) return null
    names.push(buf.toString('utf8', off + 46, off + 46 + nameLen))
    off += 46 + nameLen + extraLen + commentLen
  }
  return names
}

/** 收集待扫归档（相对 REPO 的 posix 路径）。 */
export function listArchives(root) {
  const out = []
  for (const rel of ARCHIVE_ROOTS) {
    const abs = join(root, ...rel.split('/'))
    const stack = [{ dir: abs, depth: 0 }]
    while (stack.length > 0) {
      const { dir, depth } = stack.pop()
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        const full = join(dir, e.name)
        if (e.isDirectory()) {
          if (depth + 1 < WALK_MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 })
          continue
        }
        if (!e.isFile()) continue
        if (ARCHIVE_EXTS.has(extname(e.name).toLowerCase())) out.push(full)
      }
    }
  }
  return out
}

/** 扫归档：返回命中条目 `[{ archive, entry }]` 与跳过项 `[{ archive, why }]`。 */
export function scanArchives(root) {
  const hits = []
  const skipped = []
  for (const abs of listArchives(root)) {
    let buf
    try {
      buf = readFileSync(abs)
    } catch (e) {
      skipped.push({ archive: relative(root, abs).replace(/\\/g, '/'), why: `读不到：${String(e)}` })
      continue
    }
    const names = readZipEntryNames(buf)
    if (names === null) {
      skipped.push({ archive: relative(root, abs).replace(/\\/g, '/'), why: '不是 zip（或截断）' })
      continue
    }
    const rel = relative(root, abs).replace(/\\/g, '/')
    for (const n of names) {
      if (n.toLowerCase().includes(BANNED_DIR_TOKEN)) hits.push({ archive: rel, entry: n })
    }
  }
  return { hits, skipped }
}

/* ────────────────────────────── ④ guest 包闭包文件名 ────────────────────────────── */

/**
 * `third_party/` 下随包的 guest 包闭包：文件名一律 `.tar.gz`。
 * 返回目录里出现的"非 `.tar.gz` 且不是 README/校验和/签名标记"的可疑文件（自检与真跑共用）。
 * 放行的 `.txt` / `.json` 是**标记与元数据**（`dshm-signed.txt` 这类），不是包体本身；
 * 真要搁一个 `.apk` 进去，判据 ① 就会单独把它抓出来。
 */
export function findSuspiciousPkgFiles(dir, { exts = ['.tar.gz'] } = {}) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  const allowed = new Set(['readme.md', '.gitignore'])
  const allowedExts = ['.txt', '.json']
  for (const e of entries) {
    if (!e.isFile()) continue
    const low = e.name.toLowerCase()
    if (allowed.has(low)) continue
    if (allowedExts.some((x) => low.endsWith(x))) continue
    if (exts.some((x) => low.endsWith(x))) continue
    out.push(e.name)
  }
  return out.sort()
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

function run(root, { quiet = false } = {}) {
  const tree = scanTree(root)
  const archives = scanArchives(root)
  const pkgDirs = [
    'third_party/vmhish/guestpkgs',
    'third_party/git/packages',
    'entry/src/main/resources/resfile/vm/guestpkgs',
    'entry/src/main/resources/resfile/toolchain/git',
  ]
  const odd = []
  for (const rel of pkgDirs) {
    for (const name of findSuspiciousPkgFiles(join(root, ...rel.split('/')))) {
      odd.push(`${rel}/${name}`)
    }
  }
  if (!quiet) {
    console.log(`  ① 文件扩展名：扫了 ${tree.dirsVisited} 个目录，命中 ${tree.files.length}`)
    console.log(`  ② 目录名：命中 ${tree.dirs.length}`)
    console.log(`  ③ 归档条目名：扫了 ${listArchives(root).length} 个归档，命中 ${archives.hits.length}（跳过 ${archives.skipped.length}）`)
    console.log(`  ④ 随包闭包文件：扫了 ${pkgDirs.length} 个目录，可疑 ${odd.length}`)
  }
  return { tree, archives, odd }
}

function selfTest() {
  const stage = mkdtempSync(join(tmpdir(), 'dshm-noapk-'))
  let failed = 0
  const expect = (label, got, want) => {
    const ok = got === want
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}（得到 ${got}，期望 ${want}）`)
    if (!ok) failed++
  }
  try {
    // 干净样例
    mkdirSync(join(stage, 'clean', 'vm', 'guestpkgs'), { recursive: true })
    writeFileSync(join(stage, 'clean', 'vm', 'guestpkgs', 'bash.tar.gz'), 'x')
    const clean = scanTree(join(stage, 'clean'))
    expect('干净树：文件命中 0', clean.files.length, 0)
    expect('干净树：目录命中 0', clean.dirs.length, 0)

    // 变异体 ①：一个 .apk 文件
    const s1 = join(stage, 'm1')
    mkdirSync(join(s1, 'vm'), { recursive: true })
    writeFileSync(join(s1, 'vm', 'bash-5.2.37-r0.apk'), 'x')
    expect('变异体 .apk 文件 ⇒ 判红', scanTree(s1).files.length, 1)

    // 变异体 ②：一个 apk 目录
    const s2 = join(stage, 'm2')
    mkdirSync(join(s2, 'vm', 'apk'), { recursive: true })
    expect('变异体 apk 目录 ⇒ 判红', scanTree(s2).dirs.length, 1)

    // 变异体 ②b：大小写混合照样判红
    const s2b = join(stage, 'm2b')
    mkdirSync(join(s2b, 'vm', 'APKS'), { recursive: true })
    expect('变异体 APKS 目录 ⇒ 判红', scanTree(s2b).dirs.length, 1)

    // 变异体 ③：归档里带 apk 条目（真造一个 zip：local header + 中央目录 + EOCD）
    const zipPath = join(stage, 'arch.zip')
    writeFileSync(zipPath, makeZip([{ name: 'resources/resfile/vm/apk/bash.tar.gz', data: 'x' }]))
    const names = readZipEntryNames(readFileSync(zipPath))
    expect('真造 zip 能读出条目名', names?.length ?? -1, 1)
    expect('归档条目带 apk ⇒ 判红', names.filter((n) => n.includes('apk')).length, 1)

    // 对照臂：同样的 zip，条目名换成 guestpkgs ⇒ 判绿
    const zip2 = join(stage, 'arch2.zip')
    writeFileSync(zip2, makeZip([{ name: 'resources/resfile/vm/guestpkgs/bash.tar.gz', data: 'x' }]))
    const names2 = readZipEntryNames(readFileSync(zip2))
    expect('对照臂：guestpkgs 条目 ⇒ 判绿', names2.filter((n) => n.includes('apk')).length, 0)

    // 变异体 ④：闭包目录里混进一个非 .tar.gz 的文件
    const s4 = join(stage, 'm4')
    mkdirSync(s4, { recursive: true })
    writeFileSync(join(s4, 'bash.tar.gz'), 'x')
    writeFileSync(join(s4, 'bash.apk'), 'x')
    expect('闭包目录里混进非 .tar.gz ⇒ 判红', findSuspiciousPkgFiles(s4).length, 1)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
  if (failed > 0) {
    console.error(`\n❌ 自检失败：${failed} 条没判对。`)
    process.exit(1)
  }
  console.log('\n✅ 自检通过：.apk 文件 / apk 目录（含大小写）/ 归档条目 / 闭包目录混入 全部判红，干净样例与 guestpkgs 对照臂判绿。')
  process.exit(0)
}

/** 造一个只含 store（不压缩）条目的最小 zip，供自检用。 */
function makeZip(items) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const it of items) {
    const name = Buffer.from(it.name, 'utf8')
    const data = Buffer.from(it.data, 'utf8')
    const crc = crc32(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0, 6)
    lh.writeUInt16LE(0, 8)
    lh.writeUInt16LE(0, 10)
    lh.writeUInt16LE(0, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(data.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    lh.writeUInt16LE(0, 28)
    locals.push(lh, name, data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0, 8)
    ch.writeUInt16LE(0, 10)
    ch.writeUInt16LE(0, 12)
    ch.writeUInt16LE(0, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt16LE(0, 30)
    ch.writeUInt16LE(0, 32)
    ch.writeUInt16LE(0, 34)
    ch.writeUInt16LE(0, 36)
    ch.writeUInt32LE(0, 38)
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, name)
    offset += lh.length + name.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(items.length, 8)
  eocd.writeUInt16LE(items.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, cd, eocd])
}

let CRC_TABLE = null
function crc32(buf) {
  if (CRC_TABLE === null) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

if (process.argv.includes('--self-test')) selfTest()

console.log('# 门禁：包内无 apk 目录 / 文件 / 归档条目\n')
const { tree, archives, odd } = run(REPO, { quiet: false })

if (tree.files.length === 0 && tree.dirs.length === 0 && archives.hits.length === 0 && odd.length === 0) {
  console.log('')
  console.log(`✅ 通过：全仓 0 个 apk 扩展名文件、0 个 apk 目录、随包归档 0 条 apk 条目。`)
  console.log(`   随包目录口径：resfile/vm/guestpkgs/（guest 包管理器命令本身不受此门禁约束）。`)
  process.exit(0)
}
for (const f of tree.files) console.error(`❌ 文件扩展名命中：${f}`)
for (const d of tree.dirs) console.error(`❌ 目录名命中：${d}`)
for (const h of archives.hits) console.error(`❌ 归档条目命中：${h.archive} :: ${h.entry}`)
for (const o of odd) console.error(`❌ 随包闭包里出现非 .tar.gz 文件：${o}`)
console.error('\n   应用市场按路径判"包内带 apk 相关目录/文件"即判安装失败（docs/148）。')
process.exit(1)
