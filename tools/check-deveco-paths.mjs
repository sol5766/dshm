#!/usr/bin/env node
/**
 * 门禁：`tools/` 下**不许再写死 DevEco Studio 的安装根**。
 *
 * 【为什么要有这条】2026-10-10 用户把 DevEco Studio 从 `C:\Program Files\Huawei\DevEco Studio`
 * 卸载、改装到 `D:\Program Files\Huawei\DevEco Studio`，本仓 **11 个脚本**里写死的路径当场全部失效：
 * 装机（`update-device.ps1`）、发布签名（`sign-release-hap.ps1`）、端侧验收
 * （`device-acceptance.ps1` / `device-code-fingerprint.ps1`）、核心打包（`pack-core.mjs`）、
 * 工具链落位（`place-toolchain.mjs`）、权限摘除（`strip-ungranted-acl-perms.mjs`）、
 * hdc 探测（`dshtest.py`）……修法是收出一个统一解析口 ——
 * `tools/lib/deveco-home.mjs` 与 `tools/lib/deveco-home.ps1`（候选列表 + **必须真的含
 * `tools/hvigor/bin/hvigorw.js`** 才算命中，只看目录存在会把卸载残留的空目录当安装根）。
 * 本门禁就是那次事故的守卫：**再写死就判红**。
 *
 * 【判据】只看**代码里的字符串字面量**：引号包住的 Windows 绝对路径且含 `DevEco Studio`。
 * 注释整块跳过（`//` / `#` / `*` 起头的行，以及 `/*` 与 `<#` 开的块注释）——
 * 解释"当年为什么写死过"恰恰需要在注释里把那两条路径写出来，注释不该判红。
 * 所以**不要**为了提高灵敏度去扫注释，那只会逼着后人把历史抹掉。
 *
 * 【离线】不碰网络、不碰 SDK、不碰真机，纯文本扫描。
 *
 * 用法：
 *   node tools/check-deveco-paths.mjs              # 扫 tools/
 *   node tools/check-deveco-paths.mjs --self-test  # 三个变异体（代码形态判红 / 注释形态判绿 / 解析口形态判绿）
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = join(HERE, '..')

/** 扫描范围：`tools/` 下的这些扩展名。 */
const EXTS = new Set(['.mjs', '.cjs', '.js', '.ts', '.ps1', '.sh', '.py', '.bat', '.cmd'])
const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git', 'dist', 'oh_modules'])

/** 违规形态：引号包住的 Windows 绝对路径，且路径里带 `DevEco Studio`。 */
const VIOLATION = /(['"`])[A-Za-z]:[\\/][^'"`\n]*DevEco Studio[^'"`\n]*\1/

/**
 * 逐行扫一份文本，返回违规行（1-based 行号）。
 * 纯函数，供自检注入样例 —— 判定逻辑和真跑是同一份。
 */
export function scanText(text) {
  const hits = []
  const lines = text.split('\n')
  let inBlock = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const t = line.trim()
    if (inBlock) {
      // 块注释在**同一行**收尾也算收尾（`/* 一句话 */` 这种单行块注释不能把后面全吃掉）
      if (t.includes('*/') || t.includes('#>')) inBlock = false
      continue
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true
      continue
    }
    if (t.startsWith('<#')) {
      if (!t.includes('#>')) inBlock = true
      continue
    }
    if (t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('<!--')) continue
    if (VIOLATION.test(line)) hits.push({ line: i + 1, text: t })
  }
  return hits
}

/** 递归列出待扫文件。 */
function listFiles(dir) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      out.push(...listFiles(join(dir, e.name)))
    } else if (e.isFile() && EXTS.has(extname(e.name))) {
      out.push(join(dir, e.name))
    }
  }
  return out
}

function scanDir(root) {
  const bad = []
  for (const f of listFiles(root)) {
    let text
    try {
      text = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    for (const h of scanText(text)) bad.push({ file: relative(REPO, f).replace(/\\/g, '/'), ...h })
  }
  return bad
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-deveco-paths-'))
  // 【为什么把产品名拆开拼】自检样例本身必须**含**那条路径才测得到东西，但样例又写在本文件里；
  // 直接写成字面量会让本门禁**把自己的样例判红**（第一次跑就是这么挂的）。拆开后，
  // 写出去的样例如旧，而本文件的源码里没有可被匹配的连续片段 —— 于是"门禁扫自己"仍然成立。
  const PRODUCT = ['DevEco', 'Studio'].join(' ')
  const winDir = 'C:\\Program Files\\Huawei\\' + PRODUCT
  const legacyDir = 'D:\\Huawei\\' + PRODUCT
  const cases = [
    {
      name: '代码里的字面量（必须判红）',
      body: `const java = '${winDir}\\jbr\\bin\\java.exe'\n`,
      want: 1,
    },
    {
      name: '行注释里的路径（必须判绿）',
      body: `// 原先写死 \`${winDir}\`，已改走解析口\nconst x = 1\n`,
      want: 0,
    },
    {
      name: '块注释里的路径（必须判绿）',
      body: `<#\n  从前写死 ${legacyDir}\\sdk。\n#>\nGet-ChildItem .\n`,
      want: 0,
    },
    {
      name: '走解析口的写法（必须判绿）',
      body: "const java = devecoPath(join('jbr', 'bin', 'java.exe'))\n",
      want: 0,
    },
  ]
  let failed = 0
  for (const c of cases) {
    const f = join(dir, 'case' + cases.indexOf(c) + '.mjs')
    writeFileSync(f, c.body, 'utf8')
    const got = scanText(readFileSync(f, 'utf8')).length
    const ok = got === c.want
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${c.name}（期望 ${c.want} 条，实得 ${got} 条）`)
    if (!ok) failed++
  }
  rmSync(dir, { recursive: true, force: true })
  if (failed > 0) {
    console.error(`\n❌ 自检失败：${failed} 个变异体没判对。`)
    process.exit(1)
  }
  console.log('\n✅ 自检通过：代码形态判红、注释形态判绿、解析口形态判绿。')
  process.exit(0)
}

if (process.argv.includes('--self-test')) selfTest()

const toolsDir = join(REPO, 'tools')
console.log('# 门禁：tools/ 下不许写死 DevEco Studio 安装根\n')
if (!existsSync(toolsDir)) {
  console.error(`环境受限：找不到 ${toolsDir}`)
  process.exit(3)
}
const bad = scanDir(toolsDir)
if (bad.length === 0) {
  console.log(`✅ 通过：扫了 ${listFiles(toolsDir).length} 个脚本，没有写死的 DevEco 安装根。`)
  console.log('   需要 DevEco 自带工具时，用 tools/lib/deveco-home.mjs（node 侧）或')
  console.log('   tools/lib/deveco-home.ps1（PowerShell 侧）；可用环境变量 DEVECO_HOME 指定安装根。')
  process.exit(0)
}
console.error(`❌ ${bad.length} 处写死了 DevEco 安装根（DevEco 换个盘/换个目录就会当场失效）：`)
for (const b of bad) console.error(`   ${b.file}:${b.line}  ${b.text}`)
console.error('\n   改用 tools/lib/deveco-home.mjs / deveco-home.ps1 的解析口。')
process.exit(1)
