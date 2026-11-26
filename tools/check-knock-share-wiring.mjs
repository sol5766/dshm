#!/usr/bin/env node
/**
 * 门禁：碰一碰收文件（Share Kit）的**接线契约**必须仍在位。
 *
 * 【为什么要有这条（2026-11-18）】
 * `docs/FEATURES.md` 的台账规则要求：每个在版功能都要有可执行判据，没有门禁就必须
 * 写成分步验收。碰一碰是唯一一个此前只靠"真机判据见 archive"兜底的功能，
 * 而它的失败方式是**静默**的：能力面少一条 → 系统直接不投递；窗口 id 取错 →
 * 会话窗收不到；页面销毁就 `off` → 关页后立刻失效；垫片没注入 → 文件到了也投不进输入框。
 * 这些都不会让构建失败，所以必须由门禁守住。
 *
 * 判据（全部离线，读源码）：
 *   A 仅 PC 档注册：entry 的 `startKnockReceiver` 先判 `desktopForced`；phone 壳零引用。
 *   B 一窗一实例：按 `getWindowId()` 取本窗 id，经 `acquire(ctx, winId)` 取实例；
 *     注册表按 windowId 索引（`byWindow`）。
 *   C 能力面：宽集合必须含 `general.object` + `general.file`；窄回退保留四类。
 *   D 生命周期：页面销毁只 `detachPage()`（不 off）；窗口销毁才 `release()`。
 *   E 页面侧垫片：`KNOCK_SHIM_JS` 定义并注入到 document-start 清单；
 *     垫片按 `defaultPrevented` 判定投递是否真被接住。
 *
 * 用法：
 *   node tools/check-knock-share-wiring.mjs
 *   node tools/check-knock-share-wiring.mjs --self-test
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const F = {
  receiver: 'entry/src/main/ets/system/KnockShareReceiver.ets',
  entryShell: 'entry/src/main/ets/pages/WebApp.ets',
  phoneShell: 'phone/src/main/ets/pages/WebApp.ets',
  ability: 'entry/src/main/ets/entryability/EntryAbility.ets',
}

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/** 取 `needle` 起第一个 `{}` 块的内容（粗略平衡括号；源码里没有花括号字符串）。 */
function bodyOf(text, needle) {
  const at = text.indexOf(needle)
  if (at < 0) return ''
  const open = text.indexOf('{', at)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open + 1, i)
    }
  }
  return ''
}

/** 截取 `needle` 之后 `n` 个字符，找不到返回空串。 */
function windowAfter(text, needle, n) {
  const at = text.indexOf(needle)
  return at < 0 ? '' : text.slice(at, at + n)
}

/**
 * @param {{receiver:string, entryShell:string, phoneShell:string, ability:string}} f
 * @returns {string[]} 问题描述（空数组 = 通过）
 */
export function judge(f) {
  const out = []

  /* A 仅 PC 档注册 */
  const starter = bodyOf(f.entryShell, 'private startKnockReceiver')
  if (starter.length === 0) {
    out.push('entry 壳找不到 startKnockReceiver()（碰一碰注册入口缺失）')
  } else if (!starter.includes('if (!this.desktopForced)')) {
    out.push('startKnockReceiver() 没有 desktopForced 档位闸（会把碰一碰注册到手机/普通平板）')
  }
  if (f.phoneShell.includes('KnockShareReceiver')) {
    out.push('phone 壳出现 KnockShareReceiver 引用（碰一碰只允许 PC 档注册）')
  }

  /* B 一窗一实例 */
  if (!f.entryShell.includes('getWindowId()')) {
    out.push('entry 壳未用 getWindowId() 取本窗 id（会话窗会收不到）')
  }
  if (!/KnockShareReceiver\.acquire\(\s*ctx\s*,\s*winId\s*\)/.test(f.entryShell)) {
    out.push('entry 壳未按 acquire(ctx, winId) 取本窗实例（一窗一实例契约被破坏）')
  }
  if (!f.receiver.includes('byWindow')) {
    out.push('接收器缺少按 windowId 的实例表（byWindow）')
  }

  /* C 能力面 */
  const wide = windowAfter(f.receiver, 'const wide: harmonyShare.RecvCapability[]', 500)
  const narrow = windowAfter(f.receiver, 'const narrow: harmonyShare.RecvCapability[]', 700)
  if (!wide.includes('UniformDataType.OBJECT') || !wide.includes('UniformDataType.FILE')) {
    out.push('宽能力面必须是 general.object + general.file（漏一条 ⇒ 系统不投递对应类型）')
  }
  for (const t of ['TEXT', 'COMPOSITE_OBJECT', 'ARCHIVE', 'FILE']) {
    if (!narrow.includes(`UniformDataType.${t}`)) {
      out.push(`窄回退能力面缺少 ${t}（OBJECT 被拒时的回退不完整）`)
    }
  }

  /* D 生命周期 */
  const detach = bodyOf(f.receiver, 'detachPage(): void')
  if (detach.length === 0) {
    out.push('接收器缺少 detachPage()（页面销毁只能摘钩子）')
  } else if (detach.includes('this.stop()') || detach.includes('harmonyShare.off')) {
    out.push('detachPage() 里注销了系统监听（关页会永久失效；只允许 release() 这么做）')
  }
  const release = bodyOf(f.receiver, 'release(): void')
  if (release.length === 0 || !release.includes('this.stop()')) {
    out.push('release() 未真正注销监听（窗口销毁后监听泄漏）')
  }
  if (!f.ability.includes('KnockShareReceiver.release(')) {
    out.push('EntryAbility 的窗口销毁路径未调用 KnockShareReceiver.release()')
  }
  const pageCleanup = bodyOf(f.entryShell, '  aboutToDisappear(): void')
  if (!pageCleanup.includes('this.knockReceiver.detachPage()')) {
    out.push('entry 壳 aboutToDisappear 未调用 detachPage()（页面销毁未摘钩子）')
  }

  /* E 页面侧垫片 */
  const shimStart = f.entryShell.indexOf('const KNOCK_SHIM_JS')
  if (shimStart < 0) {
    out.push('entry 壳缺少 KNOCK_SHIM_JS（文件到了也投不进输入框）')
  } else {
    const shim = f.entryShell.slice(shimStart, shimStart + 6000)
    if (!shim.includes('__DSHM_KNOCK__')) {
      out.push('KNOCK_SHIM_JS 没有暴露 __DSHM_KNOCK__ 入口')
    }
    if (!shim.includes('defaultPrevented')) {
      out.push('KNOCK_SHIM_JS 未按 defaultPrevented 判定投递是否被官方 intake 接住')
    }
    if (!shim.includes('ClipboardEvent')) {
      out.push('KNOCK_SHIM_JS 未构造 ClipboardEvent（合成 paste 通道缺失）')
    }
  }
  if (!/script:\s*KNOCK_SHIM_JS\s*,\s*scriptRules:\s*\['\*'\]/.test(f.entryShell)) {
    out.push('KNOCK_SHIM_JS 未注册进 document-start 注入清单')
  }

  return out
}

/* ───────────────────────── 运行 ───────────────────────── */

function load() {
  return {
    receiver: read(F.receiver),
    entryShell: read(F.entryShell),
    phoneShell: read(F.phoneShell),
    ability: read(F.ability),
  }
}

let pass = 0
let fail = 0
const failures = []

function ok(cond, msg) {
  if (cond) {
    pass += 1
    console.log('  PASS  ' + msg)
  } else {
    fail += 1
    failures.push(msg)
    console.log('  FAIL  ' + msg)
  }
}

const files = load()
const baseIssues = judge(files)

console.log('# 碰一碰接线门禁：PC 档注册 · 一窗一实例 · 能力面 · 生命周期 · 垫片\n')
ok(baseIssues.length === 0,
  `基线：接线契约完整${baseIssues.length ? `（${baseIssues.join('；')}）` : ''}`)

if (process.argv.includes('--self-test')) {
  console.log('\n## 变异体（每条都必须判红）\n')

  const mutations = [
    {
      name: '去掉 desktopForced 档位闸',
      apply: (f) => ({
        ...f,
        entryShell: f.entryShell.replace('if (!this.desktopForced) {', 'if (false) {'),
      }),
    },
    {
      name: 'phone 壳也注册碰一碰',
      apply: (f) => ({
        ...f,
        phoneShell: f.phoneShell
          + "\nimport { KnockShareReceiver } from '../system/KnockShareReceiver';\n",
      }),
    },
    {
      name: '宽能力面漏 general.object',
      apply: (f) => ({
        ...f,
        receiver: f.receiver.replace(
          'utd: uniformTypeDescriptor.UniformDataType.OBJECT,',
          'utd: uniformTypeDescriptor.UniformDataType.TEXT,'),
      }),
    },
    {
      name: '页面销毁时注销监听',
      apply: (f) => ({
        ...f,
        receiver: f.receiver.replace(
          'detachPage(): void {\n    this.onFiles = undefined;',
          'detachPage(): void {\n    this.stop();\n    this.onFiles = undefined;'),
      }),
    },
    {
      name: '窗口销毁不 release',
      apply: (f) => ({
        ...f,
        ability: f.ability.replace('KnockShareReceiver.release(this.knockWindowId);', ''),
      }),
    },
    {
      name: '页面销毁不 detachPage',
      apply: (f) => ({
        ...f,
        entryShell: f.entryShell.replace('this.knockReceiver.detachPage();', ''),
      }),
    },
    {
      name: '垫片未注册进 document-start 清单',
      apply: (f) => ({
        ...f,
        entryShell: f.entryShell.replace(
          "{ script: KNOCK_SHIM_JS, scriptRules: ['*'] },", ''),
      }),
    },
    {
      name: 'acquire 用固定 -1 代替代本窗 id',
      apply: (f) => ({
        ...f,
        entryShell: f.entryShell.replace('KnockShareReceiver.acquire(ctx, winId)',
          'KnockShareReceiver.acquire(ctx, -1)'),
      }),
    },
  ]

  for (const m of mutations) {
    const mutated = m.apply(files)
    const issues = judge(mutated)
    ok(issues.length > 0, `${m.name} ⇒ 判红${issues.length ? '' : '（漏检！）'}`)
  }
}

console.log(fail === 0
  ? `\n✅ 通过：${pass} 项（${process.argv.includes('--self-test') ? '含 8 个变异体' : '基线'}）`
  : `\n❌ 失败 ${fail} 项：\n  - ${failures.join('\n  - ')}`)
process.exit(fail === 0 ? 0 : 1)
