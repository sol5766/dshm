#!/usr/bin/env node
/**
 * 门禁：`bin/dsh` 必须按 **`cores/.current`** 选核心，glob 只能兜底。
 *
 * 【为什么要有这条（2026-11-12，docs/410）】
 * 旧实现只靠 `"$_cores"` 下的 glob 展开取"最后一个"，而 glob 按**字符序**：
 * `0.2.2-rc.1+dshm.10` 排在 `+dshm.9` **前面** ⇒ 升到 dshm.10 时会静默选回旧核心。
 * 改为宿主每次启动发布 `cores/.current`（当前实际在跑的核心目录名），壳优先读它。
 *
 * 判据（四条，含真跑）：
 *   ① 宿主有 `publishCurrentCore()` 且**真的被调用**；
 *   ② 壳脚本里 `.current` 分支出现在 glob 循环**之前**；
 *   ③ 兜底路径按档位推导（不得再无条件写死 `haps/entry/...`）；
 *   ④ **行为**：造两个名字满足"字典序与版本序相反"的核心目录
 *      （`+dshm.9` / `+dshm.10`），`.current` 指向 `+dshm.10` ⇒ 必须选中 `+dshm.10`；
 *      删掉 `.current` ⇒ 必须退回旧行为（选中 `+dshm.9`），证明兜底没被误删。
 *
 * 用法：
 *   node tools/check-dsh-cli-current-core.mjs
 *   node tools/check-dsh-cli-current-core.mjs --self-test
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const MAIN = 'hostcore/app/main.js'

const OLD_CORE = 'core-0.2.2-rc.1+dshm.9'
const NEW_CORE = 'core-0.2.2-rc.1+dshm.10'

/** 取 main.js 里某个函数的源码（花括号配平）。 */
function fnSrc(text, name) {
  const at = text.indexOf(`function ${name}(`)
  if (at < 0) {
    return ''
  }
  let depth = 0
  const open = text.indexOf('{', at)
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') {
      depth++
    } else if (text[i] === '}') {
      depth--
      if (depth === 0) {
        return text.slice(at, i + 1)
      }
    }
  }
  return ''
}

/** 把 DSH_SHIM_LINES 数组重建成可执行的 shell 脚本。 */
export function buildShim(mainText, homeDir) {
  const start = mainText.indexOf('const DSH_SHIM_LINES = [')
  if (start < 0) {
    throw new Error('main.js 里找不到 DSH_SHIM_LINES')
  }
  const end = mainText.indexOf('\n]', start)
  if (end < 0) {
    throw new Error('DSH_SHIM_LINES 数组没有正常结束')
  }
  const body = mainText.slice(start + 'const DSH_SHIM_LINES = '.length, end + 2)
  const helpers = fnSrc(mainText, 'shimDirResolveLines')
  if (helpers.length === 0) {
    throw new Error('main.js 里找不到 shimDirResolveLines()')
  }
  // eslint-disable-next-line no-new-func
  const arr = new Function('HOME_DIR', 'CORE_DIR', 'DSHM_HOME', 'USER_DATA',
    `${helpers}\nreturn ${body}`)(homeDir, '/nonexistent-core', homeDir, '/nonexistent-user-data')
  return `#!/bin/sh\n${arr.join('\n')}\n`
}

/**
 * 真跑一次：造 sandbox（bin/ + dsh/cores/<两个核心>），用假 node 吐出被选中的路径。
 * @returns {string} 被选中的 core 目录名（失败返回空串）
 */
function runPick(script, opts) {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-cli-'))
  try {
    const sb = join(dir, 'sb')
    const bin = join(sb, 'bin')
    mkdirSync(bin, { recursive: true })
    for (const core of [OLD_CORE, NEW_CORE]) {
      const lib = join(sb, 'dsh', 'cores', core, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
      mkdirSync(lib, { recursive: true })
      writeFileSync(join(lib, 'bin.js'), '', 'utf8')
    }
    if (opts.current !== '') {
      writeFileSync(join(sb, 'dsh', 'cores', '.current'), `${opts.current}\n`, 'utf8')
    }
    const shim = join(bin, 'dsh')
    writeFileSync(shim, script, 'utf8')
    chmodSync(shim, 0o755)
    const fakeBin = join(dir, 'fakebin')
    mkdirSync(fakeBin, { recursive: true })
    const fakeNode = join(fakeBin, 'node')
    writeFileSync(fakeNode, '#!/bin/sh\necho "PICKED:$1"\n', 'utf8')
    chmodSync(fakeNode, 0o755)

    const out = execFileSync('sh', [shim, '--version'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, HOME: join(dir, 'home') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const m = /PICKED:.*\/cores\/([^/]+)\//.exec(out)
    return m === null ? '' : m[1]
  } catch (e) {
    return ''
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (e) { /* 临时目录清不掉不影响判据 */ }
  }
}

/**
 * @param {string} mainText main.js 全文
 * @returns {string[]} 问题描述
 */
export function judge(mainText) {
  const out = []

  /* ① 宿主发布 .current */
  if (!mainText.includes('function publishCurrentCore(')) {
    out.push('main.js 缺少 publishCurrentCore()')
  }
  if (!/^\s*publishCurrentCore\(\);/m.test(mainText)) {
    out.push('publishCurrentCore() 定义了但没被调用')
  }

  /* ② 壳里 .current 先于 glob */
  const iCurrent = mainText.indexOf('"$_cores/.current"')
  const iGlob = mainText.indexOf('"$_cores"/*/')
  if (iCurrent < 0) {
    out.push('壳脚本没有读 $_cores/.current')
  }
  if (iGlob < 0) {
    out.push('壳脚本丢了 glob 兜底（旧版宿主没写过 .current 时会完全没有核心）')
  }
  if (iCurrent >= 0 && iGlob >= 0 && iCurrent > iGlob) {
    out.push('.current 分支排在 glob 循环之后（会被兜底覆盖，等于没修）')
  }

  /* ③ 兜底路径按档位推导 */
  if (mainText.includes("'[ -d \"$_cores\" ] || _cores=\"/data/storage/el2/base/haps/entry/files/dsh/cores\"',")) {
    out.push('仍无条件写死 haps/entry 的核心目录兜底（phone 档会指错）')
  }
  if (!mainText.includes('*haps/phone*')) {
    out.push('兜底路径没有按档位（*haps/phone*）区分')
  }

  /* ④ 真跑：.current 优先 + 兜底仍在 */
  let script = ''
  try {
    script = buildShim(mainText, join(tmpdir(), 'dshm-home'))
  } catch (e) {
    out.push(`重建壳脚本失败：${e.message}`)
    return out
  }
  const withCurrent = runPick(script, { current: NEW_CORE })
  if (withCurrent === '') {
    out.push('壳脚本执行失败（sh 语法或路径解析坏了）')
  } else if (withCurrent !== NEW_CORE) {
    out.push(`.current 指向 ${NEW_CORE} 但实际选中 ${withCurrent}（字典序缺陷仍在）`)
  }
  const withoutCurrent = runPick(script, { current: '' })
  if (withoutCurrent !== OLD_CORE) {
    out.push(`没有 .current 时应退回旧行为选 ${OLD_CORE}，实际选 ${withoutCurrent === '' ? '（空/失败）' : withoutCurrent}`)
  }

  return out
}

function selfTest(base) {
  const arms = [
    ['壳不读 .current（必须判红）', (t) => t.replace(/"\$_cores\/\.current"/g, '"$_cores/.missing"')],
    ['.current 分支挪到 glob 之后（必须判红）', (t) => {
      const a = t.indexOf('  \'if [ -f "$_cores/.current" ]; then\',')
      const b = t.indexOf('  \'if [ -z "$_dshbin" ] && [ -d "$_cores" ]; then\',')
      if (a < 0 || b < 0) { return t }
      const block = t.slice(a, b)
      return t.slice(0, a) + t.slice(b) + block
    }],
    ['宿主不发布 .current（必须判红）', (t) => t.replace('publishCurrentCore();', 'void 0;')],
    ['兜底退回写死 entry 档（必须判红）', (t) => t.replace(/if \[ ! -d "\$_cores" \]; then[\s\S]*?fi',/, "'[ -d \"$_cores\" ] || _cores=\"/data/storage/el2/base/haps/entry/files/dsh/cores\"',")],
  ]
  let bad = 0
  console.log('\n== 对照臂：每条变异都必须判红 ==')
  for (const [name, mutate] of arms) {
    const got = judge(mutate(base))
    const ok = got.length > 0
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}（问题数 ${got.length}）`)
    if (!ok) bad++
  }
  return bad
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const base = readFileSync(join(ROOT, MAIN), 'utf8')
  const problems = judge(base)
  console.log('== 主检：bin/dsh 按 cores/.current 选核心 ==')
  if (problems.length === 0) {
    console.log(`  PASS（.current 优先 → ${NEW_CORE}；无 .current 退回 glob → ${OLD_CORE}）`)
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
    console.log('\n✅ 自检通过：4 个变异体全部判红（含"没有 .current 必须退回旧行为"）。')
    process.exit(0)
  }

  if (problems.length > 0) {
    console.error('\n❌ bin/dsh 选核心的守卫不成立，见上。')
    process.exit(1)
  }
  console.log('\n✅ 通过：.current 优先、glob 兜底、兜底路径按档位。')
}
