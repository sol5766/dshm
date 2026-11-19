#!/usr/bin/env node
/**
 * 门禁：仅可见主会话座位钉底、head 延迟出现时补挂样式；顶部只消费 SYSTEM 并接受合法零值。
 * 模板必须先 cooked，再执行行为测试；不将离线通过宣称为真机布局已闭环。
 * 用法：node tools/check-composer-pin.mjs [--self-test]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = 'entry/src/main/ets/pages/WebApp.ets'
const PHONE = 'phone/src/main/ets/pages/WebApp.ets'
const MARK = 'const COMPOSER_PIN_SHIM_JS: string = `'

export function extract(src) {
  const at = src.indexOf(MARK)
  const from = at + MARK.length
  const tick = at < 0 ? -1 : src.indexOf('`', from)
  return tick < 0 ? { code: '', closed: false }
    : { code: src.slice(from, tick), closed: src[tick + 1] === '\n' }
}

function composerBehavior(code) {
  const cooked = runInNewContext('`' + code + '`', {}, { timeout: 1000 })
  class Element {
    constructor(attrs = {}, parent = null) {
      this.attrs = attrs; this.parentElement = parent; this.children = []; this.classes = new Set()
      this.hidden = false
      if (parent) parent.children.push(this)
      this.classList = { add: key => this.classes.add(key), remove: key => this.classes.delete(key) }
    }
    getAttribute(key) { return this.attrs[key] ?? null }
    matches(selector) {
      if (selector === '[class*="composerHero"]') return (this.attrs.class ?? '').includes('composerHero')
      const m = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector)
      return !!m && (m[2] === undefined ? this.attrs[m[1]] !== undefined : this.attrs[m[1]] === m[2])
    }
    closest(selectors) {
      for (let p = this; p; p = p.parentElement) {
        if (selectors.split(',').some(selector => p.matches(selector))) return p
      }
      return null
    }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [ ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector) ])
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
    getBoundingClientRect() {
      let hidden = false
      for (let p = this; p; p = p.parentElement) hidden ||= p.hidden
      return { width: hidden ? 0 : 400, height: hidden ? 0 : 100 }
    }
  }
  const html = new Element()
  const body = new Element({}, html)
  const makeConversation = (attrs = {}) => {
    const container = new Element(attrs, body)
    const scroll = new Element({ 'data-conversation-scroll': '' }, container)
    const seat = new Element({ 'data-composer-seat': '' }, container)
    return { container, scroll, seat }
  }
  const main = makeConversation()
  // 官方真实结构：seat 在 scroll 内，而不是 scroll 的兄弟节点。
  const officialContainer = new Element({ 'data-conversation-content': '' }, body)
  const officialScroll = new Element({ 'data-conversation-scroll': '' }, officialContainer)
  const officialSeat = new Element({ 'data-composer-seat': '' }, officialScroll)
  const right = makeConversation({ 'data-rightbar-col': '' })
  const dialog = makeConversation({ role: 'dialog' })
  const panel = makeConversation({ 'data-global-panel': '' })
  const shell = makeConversation({ 'data-shell-overlay': '' })
  const mask = makeConversation({ 'data-sidebar-mask': '' })
  const hero = makeConversation({ class: 'welcome composerHero' })
  const hidden = makeConversation(); hidden.container.hidden = true
  const hiddenSeat = makeConversation(); hiddenSeat.seat.hidden = true
  const noScroll = makeConversation(); noScroll.scroll.hidden = true
  const orphan = new Element({ 'data-composer-seat': '' }, new Element({}, body))
  const globalSeat = new Element({ 'data-composer-seat': '' }, body)
  const sideScrollContainer = new Element({}, body)
  const sideScrollSeat = new Element({ 'data-composer-seat': '' }, sideScrollContainer)
  const side = new Element({ 'data-rightbar-col': '' }, sideScrollContainer)
  new Element({ 'data-conversation-scroll': '' }, side)
  const styles = []
  const timers = []
  const listeners = {}
  const document = {
    body, documentElement: html, head: null, visibilityState: 'visible',
    querySelectorAll: selector => html.querySelectorAll(selector),
    querySelector: selector => html.querySelector(selector),
    getElementById: id => styles.find(style => style.id === id) ?? null,
    createElement: () => ({}),
    addEventListener: (type, listener) => { listeners[type] = listener },
  }
  runInNewContext(cooked, {
    document, window: { getComputedStyle: el => ({ display: el.hidden ? 'none' : 'block', visibility: 'visible', opacity: '1' }) },
    console: { info() {} }, setInterval(fn) { timers.push(fn); return 1 }, clearInterval() {},
  }, { timeout: 1000 })
  assert.equal(styles.length, 0, 'head 为空不能注入样式')
  const tick = timers[0]
  assert.equal(typeof tick, 'function', '必须有补挂巡检')
  const pinned = seat => seat.classes.has('dshm-seat-pin')
  assert.ok(pinned(main.seat), '可见主会话必须钉底')
  assert.ok(pinned(officialSeat), '官方真实结构中 parent 本身是滚动区，必须识别')
  const excluded = [right.seat, dialog.seat, panel.seat, shell.seat, mask.seat, hero.seat,
    hidden.seat, hiddenSeat.seat, noScroll.seat, orphan, globalSeat, sideScrollSeat]
  assert.ok(excluded.every(seat => !pinned(seat)), '右栏、dialog、global-panel、hero、隐藏及无所属滚动区的座位不得钉底')
  document.head = { appendChild: style => styles.push(style) }
  tick(); tick()
  assert.equal(styles.length, 1, 'head 延迟出现必须补挂且不能重复注入')
  for (const rule of ['position:sticky', 'bottom:0', 'will-change:auto', 'top:auto', 'left:auto', 'right:auto']) {
    assert.ok(styles[0].textContent.includes(rule), `钉底 CSS 缺少 ${rule}`)
  }
  main.container.hidden = true
  tick()
  assert.equal(pinned(main.seat), false, '主会话隐藏后必须摘类')
  main.container.hidden = false
  tick()
  assert.equal(pinned(main.seat), true, '主会话再次可见必须恢复')
  main.container.attrs['data-global-panel'] = ''
  tick()
  assert.equal(pinned(main.seat), false, '座位归属变化后必须摘类')
  delete main.container.attrs['data-global-panel']
  document.visibilityState = 'visible'
  listeners.visibilitychange()
  assert.equal(pinned(main.seat), true, '前台恢复时必须立即重检')
}

function methodBody(src, start, end) {
  const at = src.indexOf(start)
  assert.ok(at >= 0, `缺少方法 ${start}`)
  const until = src.indexOf(end, at + start.length)
  assert.ok(until >= 0, `缺少方法边界 ${end}`)
  const chunk = src.slice(at, until)
  return chunk.slice(chunk.indexOf('{') + 1, chunk.lastIndexOf('}'))
    .replace(/:\s*(number|boolean|window\.WindowStatusType)\b/g, '')
}

function safeAreaBehavior(src) {
  const apply = methodBody(src, 'private applyTopInset(', 'private readBottomAvoidPx(')
  const preserve = methodBody(src, 'private shouldPreserveTopZero(', 'private applyTopInset(')
  const change = methodBody(src, 'private onBottomAvoidChanged(', 'private applyBottomInsetPx(')
  const areaType = { TYPE_SYSTEM: 0, TYPE_NAVIGATION_INDICATOR: 1, TYPE_KEYBOARD: 2, TYPE_CUTOUT: 3 }
  const functions = runInNewContext('({ apply: function(px) {' + apply + '}, preserve: function() {' + preserve + '}, change: function(opt) {' + change + '} })', {
    window: { AvoidAreaType: areaType, WindowStatusType: { FULL_SCREEN: 1, MAXIMIZE: 2, FLOATING: 4, SPLIT_SCREEN: 5 } },
    px2vp: px => px / 2, clearTimeout() {},
  }, { timeout: 1000 })
  const bottoms = []
  const state = {
    topInsetArmed: true, topInsetVp: 0, decorWin: {}, keyboardVisible: false,
    dirPickerBridge: { writeDiagMarkerPublic() {} },
    applyTopInset: functions.apply,
    shouldPreserveTopZero: functions.preserve,
    readBottomAvoidPx: () => 24, applyBottomInsetPx: px => bottoms.push(px),
  }
  const fire = (type, top) => functions.change.call(state, { type, area: { topRect: { height: top }, bottomRect: { height: 0 } } })
  fire(areaType.TYPE_SYSTEM, 78)
  assert.equal(state.topInsetVp, 39, 'SYSTEM top=78 必须应用 px→vp')
  fire(areaType.TYPE_NAVIGATION_INDICATOR, 0)
  assert.equal(state.topInsetVp, 39, 'indicator top=0 不能清零顶部')
  fire(areaType.TYPE_NAVIGATION_INDICATOR, 120)
  assert.equal(state.topInsetVp, 39, 'indicator 非零 top 也不能更新顶部')
  assert.equal(bottoms.length, 3, 'SYSTEM 与 indicator 都必须保留底部更新')
  fire(areaType.TYPE_SYSTEM, 0)
  assert.equal(state.topInsetVp, 39,
    '平板 SYSTEM 瞬态 0 必须保留上次非零（否则顶栏被状态栏盖住，docs/417 2026-11-15 回归）')
  fire(areaType.TYPE_SYSTEM, 60)
  state.decorWin = { getWindowStatus: () => 4 }
  fire(areaType.TYPE_SYSTEM, 0)
  assert.equal(state.topInsetVp, 0, '自由窗口的合法零值必须接受（否则多一条 39vp 空白）')
  state.decorWin = {}
  fire(areaType.TYPE_SYSTEM, 60)
  fire(areaType.TYPE_CUTOUT, 0)
  assert.equal(state.topInsetVp, 30, '其它事件不得更新顶部')
  state.topInsetArmed = false
  fire(areaType.TYPE_SYSTEM, 100)
  assert.equal(state.topInsetVp, 30, '未 armed 不得应用顶部')
}

export function judge(files) {
  const out = []
  for (const [rel, src] of files) {
    const tag = rel.split('/')[0]
    const block = extract(src)
    if (!block.code || !block.closed) out.push(`[${tag}] composer 模板缺失或提前闭合`)
    if (!src.includes('{ script: COMPOSER_PIN_SHIM_JS, scriptRules')) out.push(`[${tag}] composer 未接入注入表`)
    try { composerBehavior(block.code) } catch (e) { out.push(`[${tag}] cooked composer 行为失败：${e.message}`) }
  }
  try { safeAreaBehavior(files.find(([rel]) => rel === ENTRY)?.[1] ?? '') }
  catch (e) { out.push(`[entry] SYSTEM/indicator 安全区行为失败：${e.message}`) }
  return out
}

function load() {
  return [ENTRY, PHONE].map(rel => [rel, readFileSync(join(ROOT, rel), 'utf8')])
}

function selfTest(base) {
  const mutate = (index, before, after) => () => {
    const files = base.map(([rel, src]) => [rel, src])
    assert.ok(files[index][1].includes(before), `变异锚点不存在：${before}`)
    files[index][1] = files[index][1].replaceAll(before, after)
    return judge(files)
  }
  const arms = [
    ['跨容器借用会话滚动区', mutate(0, "parent.querySelectorAll('[data-conversation-scroll]')", "document.querySelectorAll('[data-conversation-scroll]')")],
    ['取消右栏排除', mutate(0, '[data-rightbar-col]', '[data-no-rightbar]')],
    ['取消 dialog 排除', mutate(0, '[role="dialog"]', '[role="none"]')],
    ['取消 global-panel 排除', mutate(1, '[data-global-panel]', '[data-no-panel]')],
    ['取消 hero 排除', mutate(1, '[class*="composerHero"]', '[class*="nothing"]')],
    ['取消可见性检查', mutate(0, 'if (!visible(el)) { return false; }', 'if (false) { return false; }')],
    ['不再补挂样式', mutate(1, 'function tick() {\n    ensureStyle();', 'function tick() {')],
    ['恢复 transform 合成提示', mutate(1, 'will-change:auto !important', 'will-change:transform !important')],
    ['未接入注入表', mutate(1, '{ script: COMPOSER_PIN_SHIM_JS, scriptRules', '{ script: COMPOSER_PIN_X, scriptRules')],
    ['indicator 也更新顶部', mutate(0, 'opt.type === window.AvoidAreaType.TYPE_SYSTEM && this.topInsetArmed', 'this.topInsetArmed')],
    ['SYSTEM 瞬态零值清零（回归）', mutate(0, 'if (rounded === 0 && this.topInsetVp > 0 && this.shouldPreserveTopZero()) {', 'if (false) {')],
    ['取消底部更新', mutate(0, 'this.applyBottomInsetPx(this.readBottomAvoidPx(this.decorWin));', 'void 0;')],
    ['模板提前闭合', mutate(0, "var PIN_CLASS = 'dshm-seat-pin';", "var PIN_CLASS = 'x`';")],
  ]
  let bad = 0
  for (const [name, run] of arms) {
    const problems = run()
    console.log(`  ${problems.length ? '通过' : '失败'}：${name}（${problems.length} 项命中）`)
    if (!problems.length) bad++
  }
  return bad
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const base = load()
  const problems = judge(base)
  console.log('== 双壳可见主会话钉底、延迟样式与 SYSTEM 安全区行为 ==')
  for (const problem of problems) console.error('失败：' + problem)
  const bad = process.argv.includes('--self-test') ? selfTest(base) : 0
  if (problems.length || bad) process.exit(1)
  console.log('通过：所属容器、可见性、浮层排除、head 补挂、SYSTEM/indicator 与合法零值均已行为验证。')
}
