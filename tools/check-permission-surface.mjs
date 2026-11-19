#!/usr/bin/env node
/**
 * 门禁：当前三端权限面固定为 **entry 18 条 / phone 9 条**。
 *
 * 【为什么要有这条】权限面在本仓翻覆过好几轮：`docs/142` §7 撤过三条 `system_basic` 受限条目、
 * `docs/143`/`docs/144` 又各自加回一条（"撤哪条瘫哪块"），最后用户拍板 ——
 * **（历史口径已作废）**当时拍板「恒 8 条」；当前 **entry 18 / phone 9**（见 `AGENTS.md`）。
 * 屡次往复的代价不只是"多两行声明"：多一条没有审批的
 * `system_basic`/`system_core`，整包会在设备侧按 `PERMISSION_ACL_RULE` **拒装**（`docs/142` §1），
 * 而"撤一条"的代价是宿主域掉档、数据区里的 ELF 全 `EPERM`（`docs/143`/`docs/144`）。
 * 所以这条门禁的判据是**逐条、逐位**的：多一条红、少一条红、改一条红、换一句 reason 也红。
 *
 * 【判据（三条，全离线）】
 *   ① `entry/src/main/module.json5` 的 `requestPermissions` **恰好 18 条**，且与本文的
 *      `EXPECTED` **顺序逐条相等**（顺序变了说明有人动过数组 —— 值得人看一眼，不该静默过去）。
 *      每条还必须有 `reason: "$string:<key>"`，且该 key 在 `base/element/string.json` 里
 *      **真实存在且非空**（防"声明的 reason 指向不存在的字符串"这种装得上但解释不了的情况）。
 *   ② `base/element/string.json` 里 `perm_*` 键的集合 **必须恰好等于**上面 18 条引用到的那些 ——
 *      **不留孤儿**（历史上撤条目时留下过三条孤儿 reason 字符串，是"以后要加回"的引线）。
 *   ③ 全仓文本不得回补未获批的全盘权限；历史申请文档保留原文作为审计记录。
 *
 * 【为什么本文件里看不到那三个标识符】它们要出现在判据里，但判据本身也在被扫的仓里 ——
 * 直接写成字面量，本门禁就会**把自己判红**（`check-deveco-paths` 的样例踩过同一个坑）。
 * 故用**片段拼接**构造：写出去的是完整标识符，本文件源码里没有可被匹配的连续片段。
 *
 * 【离线】不碰网络、不碰 SDK、不碰真机、不跑构建。
 *
 * 用法：
 *   node tools/check-permission-surface.mjs              # 三条判据
 *   node tools/check-permission-surface.mjs --self-test  # 变异体自检（少一条 / 加一条 / 改 name / 换 reason / 孤儿 reason）
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = join(HERE, '..')

/**
 * 【2026-10-29 补齐 phone】此前本门禁**只读 entry** ⇒ phone 权限增删、乱序、改 reason、
 * reason 指向空资源，全部可以静默通过（CI 也只跑这一个脚本）。而 AGENTS.md 的口径是
 * "entry 恒 18 条 / phone 恒 9 条，逐条钉死"——两侧都必须各有自己的 EXPECTED。
 */
const MODULES = {
  entry: {
    moduleJson5: 'entry/src/main/module.json5',
    stringJson: 'entry/src/main/resources/base/element/string.json',
  },
  phone: {
    moduleJson5: 'phone/src/main/module.json5',
    stringJson: 'phone/src/main/resources/base/element/string.json',
  },
  /* 【2026-11-08】原 pc 独立壳已并入 entry（tablet+2in1），只保留 entry / phone 两个交付面。 */
}
// 保留旧名给自检与其它引用（都指 entry）
const MODULE_JSON5 = MODULES.entry.moduleJson5
const STRING_JSON = MODULES.entry.stringJson

/**
 * entry 固定 18 条，**顺序也钉住**。其中 8 条 ACL 与发布 Profile 的
 * `allowed-acls` 对齐；CUSTOM_SANDBOX 是原生 PTY / ELF / Python 进入动态
 * 沙箱执行域的前提，不能当成「多余条目」删除；按旧 8 条口径回退会直接删掉它。
 */
const EXPECTED = [
  'ohos.permission.INTERNET',
  'ohos.permission.KEEP_BACKGROUND_RUNNING',
  'ohos.permission.PREPARE_APP_TERMINATE',
  'ohos.permission.ALLOW_EXTERNAL_NATIVE_CODE',
  'ohos.permission.FILE_ACCESS_PERSIST',
  'ohos.permission.CUSTOM_SANDBOX',
  'ohos.permission.kernel.IGNORE_LIBRARY_VALIDATION',
  'ohos.permission.kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY',
  'ohos.permission.STORE_PERSISTENT_DATA',
  'ohos.permission.VIBRATE',
  'ohos.permission.READ_PASTEBOARD',
  'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY',
  'ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY',
  'ohos.permission.READ_WRITE_DESKTOP_DIRECTORY',
  /* 2026-11-11：AGC 已批（Profile DSHM1109Release.p7b 的 allowed-acls 含本条） */
  'ohos.permission.ACCESS_USER_FULL_DISK',
  'ohos.permission.MICROPHONE',
  /* 2026-11-02 第一批：两条 normal（安装即授，无需 ACL） */
  'ohos.permission.GET_NETWORK_INFO',
  'ohos.permission.RUNNING_LOCK',
]

/**
 * phone 固定 9 条，**顺序也钉住**。
 *
 * 【与 entry 的差异都是有原因的，不是遗漏】
 *   · 没有 `PREPARE_APP_TERMINATE` / `ALLOW_EXTERNAL_NATIVE_CODE` / `CUSTOM_SANDBOX` /
 *     两条 `kernel.*` / 三个 `READ_WRITE_*_DIRECTORY`：手持档不跑原生 PTY / 随包 ELF 的
 *     宿主域路线（终端走 guest VM），也不外开目录选择器；
 *   · 没有 `MICROPHONE`？**有**（会议模式与听写都在 phone 上）；
 *   · `STORE_PERSISTENT_DATA` 与 `VIBRATE` 都在原始用途里（entry 侧也有，并非 phone 独有）。
 * 改动这一组必须有 `docs/` 里的新依据，并同步 AGENTS.md 的「phone 恒 9 条」。
 */
const PHONE_EXPECTED = [
  'ohos.permission.INTERNET',
  'ohos.permission.KEEP_BACKGROUND_RUNNING',
  'ohos.permission.FILE_ACCESS_PERSIST',
  'ohos.permission.STORE_PERSISTENT_DATA',
  'ohos.permission.VIBRATE',
  'ohos.permission.READ_PASTEBOARD',
  'ohos.permission.MICROPHONE',
  'ohos.permission.GET_NETWORK_INFO',
  'ohos.permission.RUNNING_LOCK',
]

/** 未获批准的全盘路径权限（片段拼接 ⇒ 本文件源码里没有完整字面量）。 */
const RETIRED = [
  'ohos.permission.' + 'READ_WRITE_' + 'USER_FILE',
  /*
   * 2026-11-11：`ACCESS_USER_FULL_DISK` 已获批并从退役词表移除。
   * 判据改为「entry 声明必须在发布 Profile 的 allowed-acls 里」——由 build-agc 按 Profile 实测校验，
   * 不再用「这一条永远不许出现」的静态禁令（那会把已批准的权限也挡掉）。
   */
]

/** 全仓文本扫描的范围与跳过项（产物目录不进判据：它们是生成物，源码面才是唯一事实源）。 */
const SCAN_EXTS = new Set([
  '.mjs', '.cjs', '.js', '.mts', '.cts', '.ts', '.ets', '.json', '.json5', '.md',
  '.ps1', '.sh', '.py', '.yml', '.yaml', '.txt', '.css', '.html', '.gitignore', '.h', '.cpp', '.cmake',
])
const SCAN_SKIP_DIRS = new Set([
  '.git', 'dist', 'build', 'oh_modules', 'node_modules', 'third_party', '.hvigor', '.idea', '.research',
])
const SCAN_MAX_BYTES = 4 * 1024 * 1024

/**
 * 把 JSON5 揉成 JSON.parse 能吃的东西：剥 `/* *\/` 与 `//` 注释、去尾随逗号。
 * 故意只做这两件事（本仓的 `module.json5` 就用到这两样），不做通用 JSON5 实现。
 */
export function toStrictJson(text) {
  let out = ''
  let i = 0
  let quote = null
  while (i < text.length) {
    const c = text[i]
    if (quote) {
      out += c
      if (c === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      out += c
      i++
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
      // 块注释替换成等量空白里的一个换行，避免把相邻 token 粘起来
      out += '\n'
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      i = end === -1 ? text.length : end
      continue
    }
    out += c
    i++
  }
  // 去尾随逗号（`, }` / `, ]`）
  return out.replace(/,(\s*[}\]])/g, '$1')
}

/**
 * 判据 ①②：纯函数，真跑与自检走**同一份**。返回问题串数组（空 = 绿）。
 * `permKeys` = `base/element/string.json` 里 `perm_*` 的键集合。
 */
export function checkModuleText(moduleText, stringEntries, expected = EXPECTED) {
  const problems = []
  let mod
  try {
    mod = JSON.parse(toStrictJson(moduleText))
  } catch (e) {
    return [`module.json5 解析失败（注释/尾随逗号剥完仍不是合法 JSON）：${String(e)}`]
  }
  const list = mod?.module?.requestPermissions
  if (!Array.isArray(list)) return ['module.requestPermissions 不是数组']

  const names = list.map((p) => p?.name)
  if (list.length !== expected.length) {
    problems.push(`requestPermissions 条数 = ${list.length}，必须是 ${expected.length} 条`)
  }
  for (let i = 0; i < Math.max(list.length, expected.length); i++) {
    if (names[i] !== expected[i]) {
      problems.push(`第 ${i + 1} 条 = ${JSON.stringify(names[i] ?? null)}，期望 ${JSON.stringify(expected[i] ?? null)}`)
    }
  }

  const referenced = new Set()
  for (const [i, p] of list.entries()) {
    const at = `第 ${i + 1} 条（${p?.name ?? '?'}）`
    const reason = p?.reason
    if (typeof reason !== 'string' || !reason.startsWith('$string:')) {
      problems.push(`${at} 的 reason 不是 "$string:<key>" 形态：${JSON.stringify(reason ?? null)}`)
    } else {
      const key = reason.slice('$string:'.length)
      referenced.add(key)
      const value = stringEntries.get(key)
      if (!value) problems.push(`${at} 的 reason 指向的字符串资源 ${key} 不存在或为空（装得上但解释不了，且会留孤儿）`)
    }
    const scene = p?.usedScene
    if (!scene || !Array.isArray(scene.abilities) || scene.abilities.length === 0) {
      problems.push(`${at} 缺 usedScene.abilities`)
    }
    if (!scene || (scene.when !== 'always' && scene.when !== 'inuse')) {
      problems.push(`${at} 的 usedScene.when 既不是 always 也不是 inuse：${JSON.stringify(scene?.when ?? null)}`)
    }
  }

  const permKeys = [...stringEntries.keys()].filter((k) => k.startsWith('perm_'))
  for (const k of permKeys) {
    if (!referenced.has(k)) problems.push(`string.json 里的 ${k} 是孤儿（没有任何权限引用它）—— 撤条目时要把 reason 一起删掉`)
  }
  return problems
}

/** 判据 ③：纯函数，返回命中的禁用标识符。 */
export function findRetired(text) {
  return RETIRED.filter((name) => text.includes(name))
}

/** 递归收集待扫文本文件（相对 REPO 的 posix 路径）。 */
function listTextFiles(dir, out = [], depth = 0) {
  if (depth > 12) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (SCAN_SKIP_DIRS.has(e.name)) continue
      listTextFiles(full, out, depth + 1)
      continue
    }
    if (!e.isFile()) continue
    if (e.name.startsWith('.') && e.name !== '.gitignore') continue
    if (!SCAN_EXTS.has(extname(e.name).toLowerCase())) continue
    try {
      if (statSync(full).size > SCAN_MAX_BYTES) continue
    } catch {
      continue
    }
    out.push(relative(REPO, full).replace(/\\/g, '/'))
  }
  return out
}

function readStringEntries(stringJson = STRING_JSON) {
  const raw = readFileSync(join(REPO, stringJson), 'utf8')
  const parsed = JSON.parse(raw)
  const map = new Map()
  for (const it of parsed?.string ?? []) map.set(it.name, it.value ?? '')
  return map
}

function selfTest() {
  const reasonKeys = [
    'perm_internet_reason',
    'perm_keep_background_reason',
    'perm_prepare_terminate_reason',
    'perm_external_native_reason',
    'perm_file_access_persist_reason',
    'perm_custom_sandbox_reason',
    'perm_ignore_library_validation_reason',
    'perm_executable_memory_reason',
    'perm_store_persist_reason',
    'perm_vibrate_reason',
    'perm_read_pasteboard_reason',
    'perm_documents_directory_reason',
    'perm_download_directory_reason',
    'perm_desktop_directory_reason',
    /* 2026-11-12：405 把 entry 升到 18 条（全盘），此处样本必须同步，否则「真条数」用例自己就红 */
    'perm_full_disk_reason',
    'perm_microphone_reason',
    'perm_get_network_info_reason',
    'perm_running_lock_reason',
  ]
  const strEntries = new Map(reasonKeys.map((key) => [key, 'x']))
  const reason = (i) => [...strEntries.keys()][i]
  const synth = (names, reasonOf = (i) => reason(i)) => {
    const items = names.map((n, i) =>
      `{ "name": ${JSON.stringify(n)}, "reason": "$string:${reasonOf(i)}", "usedScene": { "abilities": ["EntryAbility"], "when": "always" } }`)
    return `{ "module": { "requestPermissions": [\n${items.join(',\n')}\n] } }`
  }

  const good = synth(EXPECTED)
  const cases = [
    { name: '真·18 条（必须判绿）', text: good, want: 0 },
    { name: '少一条（删 MICROPHONE ⇒ 必须判红）', text: synth(EXPECTED.slice(0, EXPECTED.length - 1)), want: 1 },
    { name: '多一条（加第 19 条 ⇒ 必须判红）', text: synth([...EXPECTED, 'ohos.permission.MANAGE_MISSIONS']), want: 1 },
    {
      name: '换一条（KEEP_BACKGROUND_RUNNING → 别的 ⇒ 必须判红）',
      text: synth(EXPECTED.map((n) => (n === 'ohos.permission.KEEP_BACKGROUND_RUNNING' ? 'ohos.permission.RUNNING_LOCK' : n))),
      want: 1,
    },
    { name: '全盘权限冒充受控 ACL ⇒ 必须判红', text: synth([...EXPECTED.slice(0, 7), RETIRED[0]]), want: 1 },
    { name: 'reason 指向不存在的字符串 ⇒ 必须判红', text: synth(EXPECTED, (i) => (i === 3 ? 'perm_gone_reason' : reason(i))), want: 1 },
  ]
  let failed = 0
  for (const c of cases) {
    const got = checkModuleText(c.text, strEntries).length
    const ok = c.want === 0 ? got === 0 : got > 0
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${c.name}（问题数 ${got}）`)
    if (!ok) failed++
  }
  /*
   * 【2026-10-29 新增】phone 侧变异体：这一侧此前完全不在判据里 ⇒ 必须证明
   * "phone 少一条 / 多一条"真的会判红，否则补进来的只是形式。
   */
  /*
   * phone 的 reason 表必须**恰好**覆盖 PHONE_EXPECTED 的下标（synth 按下标取 reason）。
   * 2026-10-31（docs/328）：删掉 GET/SET_NETWORK_INFO 后这里若不同步，
   * 合成用例会因计数错位把"真条数"判红 —— 自检当场抓到了。
   * 2026-11-04：17/9 收口后又漏了 GET_NETWORK_INFO / RUNNING_LOCK，自检再次判红。
   */
  const phoneStrEntries = new Map([
    ['perm_internet_reason', 'x'], ['perm_keep_background_reason', 'x'],
    ['perm_file_access_persist_reason', 'x'], ['perm_store_persist_reason', 'x'],
    ['perm_vibrate_reason', 'x'], ['perm_read_pasteboard_reason', 'x'],
    ['perm_microphone_reason', 'x'],
    ['perm_get_network_info_reason', 'x'], ['perm_running_lock_reason', 'x'],
  ])
  const phoneSynth = (names) => synth(names, (i) => [...phoneStrEntries.keys()][i])
  const phoneCases = [
    { name: 'phone 真·9 条（必须判绿）', text: phoneSynth(PHONE_EXPECTED), want: 0 },
    { name: 'phone 少一条（删 RUNNING_LOCK ⇒ 必须判红）', text: phoneSynth(PHONE_EXPECTED.slice(0, -1)), want: 1 },
    { name: 'phone 多一条（加第 10 条 ⇒ 必须判红）', text: phoneSynth([...PHONE_EXPECTED, 'ohos.permission.ACCESS_BLUETOOTH']), want: 1 },
    {
      name: 'phone 换序（VIBRATE 与 READ_PASTEBOARD 对调 ⇒ 必须判红）',
      text: phoneSynth(PHONE_EXPECTED.map((n) => (n === 'ohos.permission.VIBRATE' ? 'ohos.permission.READ_PASTEBOARD'
        : n === 'ohos.permission.READ_PASTEBOARD' ? 'ohos.permission.VIBRATE' : n))),
      want: 1,
    },
  ]
  for (const c of phoneCases) {
    const got = checkModuleText(c.text, phoneStrEntries, PHONE_EXPECTED).length
    const ok = c.want === 0 ? got === 0 : got > 0
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${c.name}（问题数 ${got}）`)
    if (!ok) failed++
  }

  // ③ 的变异体：禁用标识符自己（片段拼出来，写出去的样例里才是完整体）
  const hit = findRetired(`  { "name": "${RETIRED[0]}" }`)
  const miss = findRetired('  { "name": "ohos.permission.INTERNET" }')
  for (const [label, got, want] of [
    ['扫到禁用标识符（必须判红）', hit.length, 1],
    ['普通权限之一（必须判绿）', miss.length, 0],
  ]) {
    const ok = got === want
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}（命中 ${got}）`)
    if (!ok) failed++
  }
  if (failed > 0) {
    console.error(`\n❌ 自检失败：${failed} 个变异体没判对。`)
    process.exit(1)
  }
  console.log('\n✅ 自检通过：entry/phone 的少一条 / 加一条 / 换序 / 禁用条目 / 坏 reason / 禁用标识符 全部判红，真·18/9 条判绿。')
  process.exit(0)
}

if (process.argv.includes('--self-test')) selfTest()

console.log('# 门禁：entry 18 条 / phone 9 条\n')

/*
 * 两个模块各判各的：EXPECTED 条目不同、reason 字符串在不同 string.json 里，
 * 任何一侧红都判红（以前只有 entry 进判据 ⇒ phone 是保护真空）。
 */
const MODULE_EXPECT = { entry: EXPECTED, phone: PHONE_EXPECTED }
const problems = []
const perModule = {}
for (const [name, cfg] of Object.entries(MODULES)) {
  const moduleText = readFileSync(join(REPO, cfg.moduleJson5), 'utf8')
  const stringEntries = readStringEntries(cfg.stringJson)
  const moduleProblems = checkModuleText(moduleText, stringEntries, MODULE_EXPECT[name])
  perModule[name] = moduleProblems
  for (const p of moduleProblems) problems.push(`[${name}] ${p}`)
}

const files = listTextFiles(REPO)
const banned = []
for (const rel of files) {
  let text
  try {
    text = readFileSync(join(REPO, rel), 'utf8')
  } catch {
    continue
  }
  /* 历史档豁免：2026-11-18 文档体系重整后，原 `docs/223-*` 移入 `docs/archive/`，
     两处路径都要认，否则归档当天就会假红。 */
  const docKey = rel.replace(/^docs\/archive\//, 'docs/')
  if (docKey === 'docs/223-ACCESS_USER_FULL_DISK权限申请回复（DSHM-PC本地AI编程工作台）.md') continue
  /*
   * 【2026-11-10 用户口径变更：beta 本地测试包带全盘权限】
   * 用户明确「beta 只用于本地测试，开发者中心可以不申请；AGC 包声明要与 profile 对齐」。
   * 于是 build-beta 会在**构建期**把 ACCESS_USER_FULL_DISK 注入 entry 的 module.json5，
   * 并在 finally 逐字恢复 —— 源码 manifest、正式包、AGC 包都不含它。
   *
   * 这是一处**受控例外**：只豁免 `tools/build-beta.mjs` 这一个文件，其余任何
   * 源码 / manifest / 文档出现该标识符仍然判红。豁免同时要求该文件真的带
   * `WITH_FULL_DISK` 闸门（防止有人把它无条件写进别的构建路径）。
   */
  if (rel === 'tools/build-beta.mjs') {
    if (!text.includes('WITH_FULL_DISK')) {
      banned.push({ rel, name: RETIRED[1] })
      problems.push(`[beta] ${rel} 出现全盘权限但没有 WITH_FULL_DISK 闸门`)
    }
    continue
  }
  for (const name of findRetired(text)) banned.push({ rel, name })
}

for (const [name, list] of Object.entries(perModule)) {
  const countRed = list.some((p) => p.includes('条数'))
  const orphanRed = list.some((p) => p.includes('孤儿'))
  console.log(`  ① [${name}] requestPermissions：${countRed ? '红' : `${MODULE_EXPECT[name].length} 条、逐条对得上`}`
    + `　② reason：${orphanRed ? '有孤儿（红）' : '无孤儿'}`)
}
console.log(`  ③ 已删除标识符扫描：${files.length} 个文本文件，命中 ${banned.length} 处`)
console.log('')

if (problems.length === 0 && banned.length === 0) {
  console.log(`✅ 通过：entry ${EXPECTED.length} 条 / phone ${PHONE_EXPECTED.length} 条、reason 无孤儿、退役词表 0 命中。`)
  console.log('   ACL 以发布 Profile 的 allowed-acls 为准（当前 8 条），由 build-agc 实测校验。')
  process.exit(0)
}
for (const p of problems) console.error(`❌ ${p}`)
for (const b of banned) console.error(`❌ ${b.rel}：出现了已永久删除的受限条目 ${b.name}`)
console.error('\n   当前权限面固定为 entry 18 / phone 9；不能声明未获批准的额外 ACL。')
process.exit(1)
