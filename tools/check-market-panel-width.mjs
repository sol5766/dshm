#!/usr/bin/env node
/**
 * 门禁：681px 查询兼容必须经过外层模板 cooked 求值，再验证真实 matchMedia 行为。
 * 只证明补丁有效，不证明整页缩窄已经修复；禁止列数及祖先宽度改写。
 * 用法：node tools/check-market-panel-width.mjs [--self-test]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHELL = 'phone/src/main/ets/pages/WebApp.ets'
const MARK = 'const MARKET_WIDE_SHIM_JS: string = `'

export function extract(src) {
  const at = src.indexOf(MARK)
  const from = at + MARK.length
  const tick = at < 0 ? -1 : src.indexOf('`', from)
  return tick < 0 ? { code: '', closed: false }
    : { code: src.slice(from, tick), closed: src[tick + 1] === '\n' }
}

function execute(code) {
  // 先执行 ArkTS 普通模板的转义语义，不能直接把源码正文当最终 JS。
  const cooked = runInNewContext('`' + code + '`', {}, { timeout: 1000 })
  let classes = 'dshm-compact'
  let nativeValue = false
  let calls = 0
  const originals = []
  class NativeMql extends EventTarget {
    constructor(media) { super(); this.media = media; this.onchange = null }
    get matches() { return nativeValue }
    addListener(listener) { this.addEventListener('change', listener) }
    removeListener(listener) { this.removeEventListener('change', listener) }
  }
  const logs = []
  const callbacks = []
  let nowRoot = null
  const style = { display: 'block', visibility: 'visible' }
  const html = {
    getAttribute: () => classes, clientWidth: 390, scrollWidth: 700,
  }
  const document = {
    documentElement: html, visibilityState: 'visible',
    querySelectorAll: () => nowRoot ? [nowRoot] : [], querySelector: () => null,
  }
  const window = {
    matchMedia(q) { calls++; const mql = new NativeMql(q); originals.push(mql); return mql },
    getComputedStyle: () => style, innerWidth: 390, visualViewport: { width: 390, scale: 1 },
  }
  let cleared = false
  runInNewContext(cooked, {
    window, document, console: { info: text => logs.push(text) },
    setInterval(fn, ms) { assert.ok(ms >= 2000, '诊断周期不得低于两秒'); callbacks.push(fn); return 1 },
    clearInterval() { cleared = true },
  }, { timeout: 1000 })
  const query = '(min-width: 681px)'
  const mql = window.matchMedia(query)
  assert.equal(mql.matches, true, '带空格真实查询必须强置真（外层模板不能吞反斜杠）')
  assert.equal(mql instanceof NativeMql, false, 'compact 目标维持原 FakeMQL 策略，不覆写原生 getter')
  assert.equal(mql.media, query)
  assert.equal(window.matchMedia('( MIN-WIDTH : 681px )').matches, true, '大小写、空格必须归一化')
  assert.equal(window.matchMedia('(min-width:681px)').matches, true, '无空格查询也必须命中')
  assert.equal(window.matchMedia('(min-width: 682px)').matches, false, '其它断点必须透传')
  assert.equal(window.matchMedia('(prefers-color-scheme: dark)').matches, false, '其它查询必须透传')
  let events = 0
  const listener = () => events++
  mql.addListener(listener)
  mql.dispatchEvent(new Event('change'))
  assert.equal(events, 0, '原 FakeMQL 不派 change；不得引入与 matches 矛盾的原生载荷')
  mql.removeListener(listener)
  mql.dispatchEvent(new Event('change'))
  assert.equal(events, 0, 'FakeMQL removeListener 维持无订阅行为')
  mql.addEventListener('change', listener)
  mql.dispatchEvent(new Event('change'))
  assert.equal(events, 0, 'FakeMQL addEventListener 维持无订阅行为')
  mql.removeEventListener('change', listener)
  classes = 'dshm-handheld'
  assert.equal(mql.matches, true, '原 FakeMQL 不追踪形态切换，此轮保持该边界')
  const nativeMql = window.matchMedia(query)
  assert.equal(nativeMql, originals.at(-1), '非 compact 必须原样透传原生对象')
  assert.equal(nativeMql.matches, false, '非 compact 查询必须保持原生值')
  nativeValue = true
  assert.equal(nativeMql.matches, true, '非 compact 原生 getter 必须动态读取')
  nativeValue = false
  assert.equal(nativeMql.matches, false, '非 compact 原生 getter 必须动态读取')
  let nativeEvents = 0
  nativeMql.addEventListener('change', () => nativeEvents++)
  nativeMql.dispatchEvent(new Event('change'))
  assert.equal(nativeEvents, 1, '非 compact 的原生订阅不得改写')
  assert.equal(calls, 3, '仅非 compact 和其它查询交给原生 matchMedia')

  const sample = callbacks[0]
  assert.equal(typeof sample, 'function', '必须有低频市场布局诊断')
  nowRoot = {
    tagName: 'DIV', parentElement: null, clientWidth: 350, scrollWidth: 500,
    getBoundingClientRect: () => ({ width: 350, height: 600, x: 0, y: 0 }),
    getAttribute: () => '', closest: () => null,
  }
  for (let i = 0; i < 10; i++) sample()
  assert.equal(logs.filter(x => x.includes('layout ')).length, 3, '每次打开市场最多采样三次')
  for (let n = 0; n < 4; n++) {
    nowRoot = null; sample()
    nowRoot = { ...nowRoot, tagName: 'DIV', parentElement: null, clientWidth: 350, scrollWidth: 500,
      getBoundingClientRect: () => ({ width: 350, height: 600, x: 0, y: 0 }),
      getAttribute: () => '', closest: () => null }
    for (let i = 0; i < 3 && !cleared; i++) sample()
  }
  assert.equal(logs.filter(x => x.includes('layout ')).length, 12, '每文档最多十二次布局采样')
  assert.ok(cleared, '采满后必须停止诊断定时器')
  const diagnostic = JSON.parse(logs.find(x => x.includes('layout ')).split('layout ')[1])
  for (const key of ['clientWidth', 'scrollWidth', 'scale', 'chain', 'queries', 'gateMatches']) {
    assert.ok(key in diagnostic, `缺少布局诊断字段 ${key}`)
  }
  assert.ok(diagnostic.queries.some(x => x.query === query && x.matches === true), '必须记录实际带空格查询命中')
}

export function judge(src, block = extract(src)) {
  const out = []
  if (!src.includes(MARK)) return ['缺少 MARKET_WIDE_SHIM_JS']
  if (!src.includes('{ script: MARKET_WIDE_SHIM_JS, scriptRules')) out.push('市场垫片未接入注入表')
  if (!block.closed) out.push('模板字符串未正常闭合或正文含反引号')
  if (!block.code) return [...out, '垫片正文为空']
  for (const banned of ['data-dshm-cols', 'repeat(', 'style.width', 'style.minWidth', 'style.maxWidth', 'createElement(\'style\')']) {
    if (block.code.includes(banned)) out.push(`禁止列数或宽度 CSS 改写：${banned}`)
  }
  try { execute(block.code) } catch (e) { out.push(`cooked 脚本行为失败：${e.message}`) }
  return out
}

function selfTest(src, block) {
  const mutate = (oldText, newText) => () => {
    assert.ok(block.code.includes(oldText), `变异锚点不存在：${oldText}`)
    return judge(src, { ...block, code: block.code.replaceAll(oldText, newText) })
  }
  const arms = [
    ['模板吞掉正则转义', mutate('/\\\\s+/g', '/\\s+/g')],
    ['断点被改变', mutate("'(min-width:681px)'", "'(min-width:682px)'")],
    ['取消 matchMedia 包装', mutate('window.matchMedia = wrapped', 'window.matchOther = wrapped')],
    ['取消 compact 限定', mutate('&& compact()', '&& true')],
    ['FakeMQL 不再强置真', mutate('this.matches = true', 'this.matches = false')],
    ['半原生 getter 矛盾形态', mutate('forced ? new FakeMediaQueryList(q) : orig.call(window, q)', 'orig.call(window, q)')],
    ['混入列数规则', () => judge(src, { ...block, code: block.code + '\n/* data-dshm-cols */' })],
    ['取消诊断采样上限', mutate('diagTotal >= 12', 'diagTotal >= 120')],
    ['取消每次打开采样上限', mutate('diagPerOpen >= 3', 'diagPerOpen >= 30')],
    ['未接入注入表', () => judge(src.replace('{ script: MARKET_WIDE_SHIM_JS, scriptRules', '{ script: MARKET_WIDE_X, scriptRules'), block)],
    ['正文提前闭合', () => judge(src, { ...block, closed: false })],
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
  const src = readFileSync(join(ROOT, SHELL), 'utf8')
  const problems = judge(src)
  console.log('== 市场 cooked 模板、原 FakeMQL 兼容与有界诊断 ==')
  for (const p of problems) console.error('失败：' + p)
  const bad = process.argv.includes('--self-test') ? selfTest(src, extract(src)) : 0
  if (problems.length || bad) process.exit(1)
  console.log('通过：真实 681px 查询、compact 作用域、原 FakeMQL、不匹配查询原生透传及诊断上限均已验证；Fake 不派 change、不追踪形态切换，真机缩窄未闭环。')
}
