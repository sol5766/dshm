#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHELLS = ['entry/src/main/ets/pages/WebApp.ets', 'phone/src/main/ets/pages/WebApp.ets']
const MARK = 'const AI_DISCLOSURE_SHIM_JS: string = `'
const TEXT = '（内容由AI生成）'
let renderSources

export function extract(src) {
  const start = src.indexOf(MARK)
  if (start < 0) return { code: '', closed: false }
  const from = start + MARK.length
  let end = from
  while (end < src.length) {
    if (src[end] === '\\') { end += 2; continue }
    if (src[end] === '`') break
    end++
  }
  const raw = src.slice(from, end)
  if (end === src.length || src[end + 1] !== '\n' || raw.includes('${')) return { code: '', closed: false }
  return { code: runInNewContext('`' + raw + '`'), closed: true }
}

function productionContract(read) {
  const recipe = JSON.parse(read(join(ROOT, 'hostcore/core-recipe.json'), 'utf8'))
  assert.ok(typeof recipe.coreVersion === 'string' && /^[\w.+-]+$/.test(recipe.coreVersion), 'Invalid recipe coreVersion')
  const official = join(ROOT, 'dist/core/work', 'dsh-core-' + recipe.coreVersion, 'node_modules/@deepseek-ai')
  const source = (pkg, path) => {
    const file = join(official, pkg, path)
    try { return read(file, 'utf8') }
    catch (error) {
      if (error.code === 'ENOENT') {
        error.unverifiedCore = file
      }
      throw error
    }
  }
  const files = [
    ['dsh-client-ui-renderer', 'src/client/scoped-slots.tsx', ["const ANCHOR_STYLE = { display: 'contents' }", '<Anchor data-slot={slotKey} style={ANCHOR_STYLE}>', '<Comp {...provided} {...inputProps} />']],
    ['dsh-client-ui-layout', 'src/client/AppFrame.tsx', ["renderSlot('main', {},", '<CenterColumn inert={drawerOpen}>{main}</CenterColumn>', '<RightbarColumn inert={drawerOpen}>']],
    ['dsh-client-ui-conversation', 'src/client/skeleton/ConversationPanel.tsx', ["renderSlot('main.conversation', {})"]],
    ['dsh-client-ui-conversation', 'src/client/skeleton/ConversationMainPanel.tsx', ["renderSlot('conversation.header', {})", "renderFactorySlot('conversation.content',"]],
    ['dsh-client-ui-conversation', 'src/client/skeleton/ConversationContent.tsx', ['data-conversation-session={sessionId}', 'data-content-phase={phase}', 'data-conversation-scroll=""']],
    ['dsh-client-ui-chat', 'src/client/chat/ChatNodeSeat.tsx', ['data-chat-node-key={routedNode.key}', 'data-chat-flow-kind={routedNode.kind}', 'data-chat-turn={turn}']],
    ['dsh-client-ui-chat', 'src/client/chat/TurnTailNodeView.tsx', ['if (closing === null) return tail === null ? null', 'data-turn-tail={data.turn}', "data-actions-reveal={endsWithResponse ? 'always' : 'hover'}", 'text={assistantText(closing.blocks)}']],
    ['dsh-client-ui-chat', 'src/client/conversation-nodes/turn-tail.ts', ["if (end?.event.type !== 'turn/end') return null", "block.kind === 'text' && block.text.trim() !== ''", 'const closing = finalized.findLast(hasText) ?? null', "publication: match => match.event.type === 'turn/end' ? 'immediate' : 'none'"]],
    ['dsh-client-ui-chat', 'src/client/chat/register-node-renderers.ts', ["'conversation.chat.turnTail': { kind: 'list', scope: 'session' }"]],
    ['dsh-client-ui-chat', 'src/client/chat/MessageIconActions.tsx', ['const { copied, onCopy } = useClipboardCopy(text)']],
  ]
  for (const [pkg, path, tokens] of files) {
    const text = source(pkg, path)
    for (const token of tokens) assert.ok(text.includes(token), `${path}: contract drift: ${token}`)
  }
  renderSources = {
    renderer: source('dsh-client-ui-renderer', 'src/client/scoped-slots.tsx'),
    main: source('dsh-client-ui-layout', 'src/client/AppFrame.tsx'),
    conversation: source('dsh-client-ui-conversation', 'src/client/skeleton/ConversationPanel.tsx'),
    header: source('dsh-client-ui-conversation', 'src/client/skeleton/ConversationMainPanel.tsx'),
    headerContent: source('dsh-client-ui-conversation', 'src/client/skeleton/ConversationHeader.tsx'),
    hero: source('dsh-client-ui-conversation', 'src/client/skeleton/ConversationContent.tsx'),
    session: source('dsh-client-ui-conversation', 'src/client/skeleton/ConversationContent.tsx'),
    view: source('dsh-client-ui-conversation', 'src/client/skeleton/DefaultConversationViews.tsx'),
    flow: source('dsh-client-ui-chat', 'src/client/chat/ChatView.tsx'),
    node: source('dsh-client-ui-chat', 'src/client/chat/ChatNodeSeat.tsx'),
  }
  for (const [site, text] of Object.entries(renderSources)) console.log(`RENDER ${site} sha256=${createHash('sha256').update(text).digest('hex')}`)
  for (const [pkg, hash, tokens] of [
    ['dsh-client-ui-chat', 'eef53e82b8cd584d2f0e543a4a93395f9d90df3bba1218891bd99d07d788de5c', ['data-turn-tail', 'data-actions-reveal', 'data-chat-node-key', 'data-chat-flow-kind', 'data-chat-turn', 'data-chat-flow']],
    ['dsh-client-ui-conversation', '3d166eab312749bf8c528dd7d26d95340df75a27fec668b3510e4558fe9b343b', ['data-conversation-session', 'data-content-phase', 'data-conversation-scroll']],
  ]) {
    const bundle = source(pkg, 'lib/client.js')
    for (const token of tokens) assert.ok(bundle.includes(token), `${pkg} production bundle missing ${token}`)
    assert.equal(createHash('sha256').update(bundle).digest('hex'), hash, pkg + ': frozen rc3 bundle drift')
    console.log(`CONTRACT ${pkg}/lib/client.js sha256=${hash}`)
  }
}

function fixture(code, setup = () => {}) {
  assert.ok(renderSources, 'Official slot renderer sources must be verified before fixtures')
  const observers = new Set(), timeouts = new Map(), intervals = new Map()
  let serial = 0
  function notify(target, attr = null) {
    for (const o of observers) if (o.root?.contains(target) && (attr === null || o.options.attributeFilter.includes(attr))) o.records.push({ target, attributeName: attr })
  }
  class Element {
    constructor(tag = 'div', attrs = {}) {
      this.tagName = tag.toUpperCase(); this.attrs = { ...attrs }; this.children = []; this.parentElement = null; this.text = ''
      this.style = new Proxy({}, { set: (o, k, v) => { o[k] = v; notify(this, 'style'); return true } })
      this.rect = { width: 600, height: 100 }
    }
    get parentNode() { return this.parentElement }
    get firstElementChild() { return this.children[0] ?? null }
    get nextElementSibling() { const a = this.parentElement?.children ?? []; return a[a.indexOf(this) + 1] ?? null }
    get isConnected() { return html.contains(this) }
    get id() { return this.getAttribute('id') ?? '' }
    set id(v) { this.setAttribute('id', v) }
    get textContent() { return this.text + this.children.map(c => c.textContent).join('') }
    set textContent(v) { this.text = v; this.children = []; notify(this) }
    getAttribute(k) { return this.attrs[k] ?? null }
    hasAttribute(k) { return Object.hasOwn(this.attrs, k) }
    setAttribute(k, v) { this.attrs[k] = String(v); notify(this, k) }
    removeAttribute(k) { delete this.attrs[k]; notify(this, k) }
    contains(el) { return el === this || this.children.some(c => c.contains(el)) }
    appendChild(el) { el.parentElement?.removeChild(el); this.children.push(el); el.parentElement = this; notify(this); return el }
    removeChild(el) { this.children.splice(this.children.indexOf(el), 1); el.parentElement = null; notify(this); return el }
    matches(selector) {
      return selector.split(',').some(s => {
        const m = s.trim().match(/^\[([\w-]+)(?:="([^"]*)")?\]$/)
        if (!m) throw Error('Unsupported fixture selector: ' + s)
        return this.hasAttribute(m[1]) && (m[2] === undefined || this.getAttribute(m[1]) === m[2])
      })
    }
    closest(s) { for (let e = this; e; e = e.parentElement) if (e.matches(s)) return e; return null }
    querySelectorAll(s) { return this.children.flatMap(c => [...(c.matches(s) ? [c] : []), ...c.querySelectorAll(s)]) }
    querySelector(s) { return this.querySelectorAll(s)[0] ?? null }
    getBoundingClientRect() { return this.rect }
  }
  function events(target) {
    const listeners = new Map()
    target.addEventListener = (n, f) => { if (!listeners.has(n)) listeners.set(n, new Set()); listeners.get(n).add(f) }
    target.removeEventListener = (n, f) => listeners.get(n)?.delete(f)
    target.emit = n => { for (const f of [...(listeners.get(n) ?? [])]) f() }
    target.listenerCount = () => [...listeners.values()].reduce((n, s) => n + s.size, 0)
    return target
  }
  const html = new Element('html'), body = html.appendChild(new Element('body'))
  const document = events({ documentElement: html, body, visibilityState: 'visible', createElement: tag => new Element(tag),
    querySelectorAll: s => html.querySelectorAll(s), getElementById: id => html.querySelectorAll('[id]').find(e => e.id === id) ?? null })
  const window = events({})
  const frame = body.appendChild(new Element()), sidebar = frame.appendChild(new Element())
  const center = frame.appendChild(new Element()), panel = center.appendChild(new Element())
  const rightbar = frame.appendChild(new Element('div', { 'data-rightbar-col': '' }))
  function outlet(parent, site, name) {
    assert.ok(renderSources[site].includes("renderSlot('" + name + "'"), 'Official render site missing: ' + name)
    const anchor = parent.appendChild(new Element('div', { 'data-slot': name }))
    anchor.style.display = 'contents'
    anchor.rect = { width: 0, height: 0 }
    return anchor
  }
  function conversation(parent = panel) {
    const mainSlot = outlet(parent, 'main', 'main')
    const conversationSlot = outlet(mainSlot, 'conversation', 'main.conversation')
    const root = conversationSlot.appendChild(new Element('div', { 'data-phase': 'active' }))
    const headerSlot = outlet(root, 'header', 'conversation.header')
    const header = headerSlot.appendChild(new Element('header'))
    outlet(header.appendChild(new Element('div', { 'data-conversation-header-leading': '' })), 'headerContent', 'conversation.header.leading')
    outlet(header, 'headerContent', 'conversation.session.header')
    const content = root.appendChild(new Element('div', { 'data-conversation-content': '', 'data-conversation-region': 'chat', 'data-conversation-session': 'session-1', 'data-content-phase': 'active' }))
    const heroSlot = outlet(content, 'hero', 'conversation.hero.frame')
    const hero = heroSlot.appendChild(new Element()), scroll = hero.appendChild(new Element('div', { 'data-conversation-scroll': '' }))
    const sessionSlot = outlet(scroll, 'session', 'conversation.session')
    const view = sessionSlot.appendChild(new Element()), viewSlot = outlet(view, 'view', 'conversation.view')
    const chatFrame = viewSlot.appendChild(new Element()), chatRoot = chatFrame.appendChild(new Element()), chatScroll = chatRoot.appendChild(new Element())
    const flow = outlet(chatScroll.appendChild(new Element('div', { 'data-chat-flow': '' })), 'flow', 'conversation.chat.flow')
    const seat = scroll.appendChild(new Element('div', { 'data-composer-seat': '', 'data-conversation-region': 'composer' }))
    return { root, header, headerSlot, mainSlot, conversationSlot, content, scroll, flow, seat }
  }
  function task(main, turn = 1, state = 'done', text = 'Actual assistant output') {
    const row = main.flow.appendChild(new Element('div', { 'data-chat-anchor-key': 'tail-' + turn, 'data-chat-flow-key': 'tail-' + turn, 'data-chat-node-key': 'tail-' + turn, 'data-chat-flow-kind': 'turn-tail', 'data-chat-turn': turn }))
    const slot = outlet(row, 'node', 'conversation.chat.node')
    if (state === 'running') { row.setAttribute('data-chat-flow-kind', 'assistant-step'); return { row, slot, tail: null } }
    if (!text.trim()) return { row, slot, tail: null }
    const tail = slot.appendChild(new Element('div', { 'data-turn-tail': turn, 'data-actions-reveal': state === 'done' ? 'always' : 'hover' }))
    const actions = tail.appendChild(new Element('div', { 'data-clock': 'end' }))
    actions.appendChild(new Element('button', { 'aria-label': 'Copy' }))
    return { row, slot, tail }
  }
  const main = conversation(), first = task(main)
  const env = { html, body, frame, sidebar, center, panel, rightbar, main, first, conversation, task, Element, document, window }
  setup(env)
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.records = []; this.root = null; observers.add(this) }
    observe(root, options) { this.root = root; this.options = options }
    disconnect() { this.root = null; this.records = [] }
  }
  const context = { document, window, MutationObserver, console: { info() {} },
    getComputedStyle: e => ({ display: 'flex', visibility: 'visible', opacity: '1', ...e.style }),
    setTimeout: f => { timeouts.set(++serial, f); return serial }, clearTimeout: id => timeouts.delete(id),
    setInterval: f => { intervals.set(++serial, f); return serial }, clearInterval: id => intervals.delete(id) }
  function flush() {
    for (let i = 0; i < 12; i++) {
      for (const o of observers) if (o.records.length) o.callback(o.records.splice(0))
      if (!timeouts.size && ![...observers].some(o => o.records.length)) return
      const batch = [...timeouts.values()]; timeouts.clear(); for (const f of batch) f()
    }
    throw Error('Observer self excitation')
  }
  runInNewContext(code, context, { timeout: 1000 }); flush()
  return { ...env, context, flush, timeouts, intervals, observers, labels: () => html.querySelectorAll('[data-dshm-ai-disclosure]') }
}

const CASES = [
  ['completed', () => {}, 1],
  ['completed no assistant', e => { e.main.flow.removeChild(e.first.row); e.task(e.main, 1, 'done', '') }, 0],
  ['completed whitespace only', e => { e.main.flow.removeChild(e.first.row); e.task(e.main, 1, 'done', ' \n\t') }, 0],
  ...['failed', 'cancelled'].flatMap(state => [
    [state + ' partial AI', e => { e.main.flow.removeChild(e.first.row); e.task(e.main, 1, state, 'Partial assistant') }, 1],
    [state + ' no AI', e => { e.main.flow.removeChild(e.first.row); e.task(e.main, 1, state, '') }, 0],
  ]),
  ['streaming', e => e.first.row.setAttribute('data-chat-flow-kind', 'assistant-step'), 0],
  ['no closing text extension tail', e => e.first.tail.removeAttribute('data-actions-reveal'), 0],
  ['history and multiple tasks', e => { e.task(e.main, 2); e.task(e.main, 3, 'failed'); e.task(e.main, 4, 'running') }, 3],
  ['rightbar negative', e => e.task(e.conversation(e.rightbar), 2), 1],
  ['sidebar fake main', e => e.sidebar.appendChild(e.panel), 0],
  ['ambiguous main', e => e.conversation(), 0],
  ['no header', e => e.main.headerSlot.removeChild(e.main.header), 0],
  ...['headerSlot', 'mainSlot', 'conversationSlot'].flatMap(slot => [
    ['wrong official slot ' + slot, e => e.main[slot].setAttribute('data-slot', 'sidebar'), 0],
    ['missing official slot ' + slot, e => e.main[slot].removeAttribute('data-slot'), 0],
    ['arbitrary wrapper ' + slot, e => { const anchor = e.main[slot]; const child = anchor.firstElementChild; anchor.appendChild(new e.Element()).appendChild(child) }, 0],
  ]),
  ...['data-shell-bottom', 'data-shell-leading', 'data-shell-overlay', 'data-rightbar-col'].map(attr => [
    'complete official tree in ' + attr, e => { e.panel.removeChild(e.main.mainSlot); e.task(e.conversation(e.frame.appendChild(new e.Element('div', { [attr]: '' })))) }, 0,
  ]),
  ['wrong turn', e => e.first.row.setAttribute('data-chat-turn', '2'), 0],
  ['missing stable key', e => e.first.row.removeAttribute('data-chat-node-key'), 0],
  ['duplicate stable task', e => e.task(e.main), 0],
  ['same turn different node key', e => e.task(e.main).row.setAttribute('data-chat-node-key', 'replacement-tail'), 0],
  ['no flow', e => e.main.flow.parentElement.removeAttribute('data-chat-flow'), 0],
  ['composer fake tail', e => e.main.seat.appendChild(e.first.row), 0],
  ['nested embedded', e => { const nested = e.conversation(e.main.flow); nested.flow.appendChild(e.first.row) }, 0],
  ...['hero', 'settling', 'future'].map(phase => [phase, e => { e.main.root.setAttribute('data-phase', phase); e.main.content.setAttribute('data-content-phase', phase) }, 0]),
  ...[null, '', ' \t\n'].map(session => ['invalid session ' + session, e => session === null ? e.main.content.removeAttribute('data-conversation-session') : e.main.content.setAttribute('data-conversation-session', session), 0]),
  ...['data-rightbar-col', 'data-shell-overlay', 'data-sidebar-mask'].map(attr => [attr, e => e.panel.setAttribute(attr, ''), 0]),
  ...['settings', 'plugins', 'market', 'task-manager'].map(id => [id, e => e.panel.setAttribute('data-global-panel', id), 0]),
  ...['hidden', 'inert', 'aria-hidden'].map(attr => [attr, e => e.center.setAttribute(attr, attr === 'aria-hidden' ? 'true' : ''), 0]),
  ...[['display', 'none'], ['visibility', 'hidden'], ['opacity', '0']].map(([k, v]) => [k, e => { e.center.style[k] = v }, 0]),
  ['dialog', e => e.body.appendChild(new e.Element('div', { role: 'dialog' })), 0],
  ['hidden dialog', e => { const d = e.body.appendChild(new e.Element('div', { role: 'dialog' })); d.style.display = 'none' }, 1],
  ['modal', e => e.body.appendChild(new e.Element('div', { 'aria-modal': 'true' })), 0],
  ['zero geometry tail', e => { e.first.tail.rect.width = 0 }, 0],
  ['hidden tail', e => e.first.tail.setAttribute('hidden', ''), 0],
  ['host panel', e => e.html.setAttribute('data-dshm-panel', 'open'), 0],
  ['document hidden', e => { e.document.visibilityState = 'hidden' }, 0],
]

function verify(e, count) {
  assert.equal(e.labels().length, count)
  for (const label of e.labels()) {
    assert.equal(label.getAttribute('aria-label'), TEXT)
    assert.equal(label.textContent, '')
    assert.equal(label.nextElementSibling, null)
    assert.ok(label.parentElement.hasAttribute('data-turn-tail'))
    assert.ok(label.id.includes(encodeURIComponent(label.getAttribute('data-dshm-ai-disclosure'))))
    assert.ok(e.html.children.some(c => c.tagName === 'STYLE' && c.textContent === '[data-dshm-ai-disclosure]::after{content:"' + TEXT + '"}'))
    assert.equal(label.closest('[data-composer-seat]'), null)
  }
}

function behavior(code) {
  const errors = []
  for (const [name, setup, count] of CASES) {
    try { const e = fixture(code, setup); verify(e, count); for (let i = 0; i < 3; i++) { e.context.__DSHM_AI_DISCLOSURE__.refresh(); e.flush(); verify(e, count) } }
    catch (error) { errors.push(name + ': ' + error.message) }
  }
  try {
    const e = fixture(code); verify(e, 1)
    const id = e.labels()[0].id
    for (const [mutate, restore] of [
      [() => e.first.tail.removeAttribute('data-actions-reveal'), () => e.first.tail.setAttribute('data-actions-reveal', 'hover')],
      [() => e.main.flow.removeChild(e.first.row), () => e.main.flow.appendChild(e.first.row)],
      [() => e.center.setAttribute('hidden', ''), () => e.center.removeAttribute('hidden')],
      [() => e.panel.setAttribute('data-global-panel', 'market'), () => e.panel.removeAttribute('data-global-panel')],
      [() => e.main.content.removeAttribute('data-conversation-session'), () => e.main.content.setAttribute('data-conversation-session', 'session-1')],
      [() => e.main.headerSlot.setAttribute('data-slot', 'sidebar'), () => e.main.headerSlot.setAttribute('data-slot', 'conversation.header')],
      [() => e.main.mainSlot.setAttribute('data-slot', 'sidebar'), () => e.main.mainSlot.setAttribute('data-slot', 'main')],
      [() => e.main.conversationSlot.setAttribute('data-slot', 'rightbar'), () => e.main.conversationSlot.setAttribute('data-slot', 'main.conversation')],
    ]) { mutate(); e.flush(); verify(e, 0); restore(); e.flush(); verify(e, 1); assert.equal(e.labels()[0].id, id) }
    e.main.flow.removeChild(e.first.row); e.task(e.main); e.flush(); verify(e, 1); assert.equal(e.labels()[0].id, id)
    e.main.content.setAttribute('data-conversation-session', 'session-2'); e.flush(); verify(e, 1); assert.notEqual(e.labels()[0].id, id)
    e.window.emit('resize'); e.window.emit('resize'); assert.equal(e.timeouts.size, 1)
    e.document.visibilityState = 'hidden'; e.document.emit('visibilitychange'); verify(e, 0)
    assert.equal(e.intervals.size, 0); assert.equal(e.timeouts.size, 0); assert.ok([...e.observers].every(o => o.root === null))
    e.document.visibilityState = 'visible'; e.document.emit('visibilitychange'); verify(e, 1)
    e.window.emit('pagehide'); verify(e, 0); e.window.emit('pageshow'); verify(e, 1)
    const listeners = e.document.listenerCount() + e.window.listenerCount()
    runInNewContext(code, e.context); verify(e, 1); assert.equal(e.document.listenerCount() + e.window.listenerCount(), listeners)
    e.window.emit('unload'); e.context.__DSHM_AI_DISCLOSURE__.refresh(); e.flush(); verify(e, 0)
    assert.equal(e.intervals.size, 0); assert.equal(e.document.listenerCount() + e.window.listenerCount(), 0)
  } catch (error) { errors.push('SPA/virtualization/lifecycle: ' + error.message) }
  return errors
}

export function judge(blocks) {
  return blocks.flatMap(([rel, code, closed]) => !closed || !code ? [rel + ': invalid template'] : behavior(code).map(e => rel + ': ' + e))
}

function selfTest(base) {
  const mutations = [
    ['header wrapper support lost', "header = header.firstElementChild;", ''],
    ['main wrapper support lost', 'var panel = mainSlot.parentElement;', 'var panel = root.parentElement;'],
    ['conversation wrapper support lost', 'var mainSlot = conversationSlot.parentElement;', 'var mainSlot = root.parentElement;'],
    ...['conversation.header', 'main.conversation', 'main'].map(slot => [
      'wrong slot accepted ' + slot, "getAttribute('data-slot') !== '" + slot + "'", 'getAttribute(\'data-slot\') === null',
    ]),
    ['wrong text', TEXT, '内容由 AI 生成'],
    ['Hero accepted', "phase !== 'active'", "phase !== 'active' && phase !== 'hero'"],
    ['session ignored', "if (session === null || session.trim() === '') { return false; }", ''],
    ['closing absent accepted', "tail.getAttribute('data-actions-reveal') === null", 'false'],
    ['streaming accepted', "row.getAttribute('data-chat-flow-kind') !== 'turn-tail'", 'false'],
    ['turn mismatch accepted', "row.getAttribute('data-chat-turn') !== turn", 'false'],
    ['duplicate accepted', 'if (wanted.has(key))', 'if (false)'],
    ['stale retained', 'detach(el); nodes.delete(key);', ''],
    ['observer disabled', 'new MutationObserver(schedule)', 'new MutationObserver(function () {})'],
    ['slot observation absent', "'data-slot',", ''],
    ['closing observation absent', "'data-actions-reveal',", ''],
    ['hidden cleanup absent', "if (document.visibilityState === 'hidden') { pause(); } else { resume(); }", "if (document.visibilityState !== 'hidden') { resume(); }"],
    ['copy contamination', "found.setAttribute('role', 'note');", "found.textContent = TEXT; found.setAttribute('role', 'note');"],
    ['stable id lost', "found.id = ID + '-' + encodeURIComponent(key);", 'found.id = ID;'],
    ['rightbar accepted', "if (p.getAttribute('data-rightbar-col') !== null) { return true; }", ''],
    ['main ownership absent', "if (rightbar === null || !rightbar.matches('[data-rightbar-col]')) { return false; }", ''],
    ['unload cleanup absent', 'stopped = true;', 'return;'],
  ]
  let missed = 0
  for (const [rel, code] of base) for (const [name, from, to] of mutations) {
    assert.ok(code.includes(from), 'Mutation target absent: ' + name)
    const detected = behavior(code.replace(from, to)).length > 0
    console.log(`${detected ? 'PASS' : 'FAIL'} negative ${rel.split('/')[0]}: ${name}`)
    if (!detected) missed++
  }
  for (const malformed of [MARK + '`broken`\n', MARK + '${unexpected}`\n', MARK + '\\uZZZZ`\n']) {
    let detected = false
    try { const x = extract(malformed); detected = !x.closed || judge([['template', x.code, x.closed]]).length > 0 } catch { detected = true }
    assert.ok(detected, 'Malformed template accepted')
  }
  for (const mode of ['missing-tree', 'missing-bundle', 'bad-recipe']) {
    const output = [], paths = []
    const rc = run((path, encoding) => {
      paths.push(path)
      if (path.endsWith('hostcore/core-recipe.json')) {
        return mode === 'bad-recipe' ? '{' : mode === 'missing-tree'
          ? JSON.stringify({ coreVersion: '9.8.7-ci-probe' }) : readFileSync(path, encoding)
      }
      if (mode === 'missing-tree' || path.endsWith('lib/client.js')) {
        throw Object.assign(new Error('Missing dependency probe'), { code: 'ENOENT' })
      }
      return readFileSync(path, encoding)
    }, message => output.push(message))
    assert.equal(rc, mode === 'bad-recipe' ? 1 : 2)
    assert.ok(output.some(line => line.startsWith(mode === 'bad-recipe' ? 'FAIL:' : 'UNVERIFIED:')))
    assert.ok(!output.some(line => line.startsWith('PASS')))
    if (mode === 'missing-tree') assert.ok(paths.some(path => path.includes('dsh-core-9.8.7-ci-probe/')))
    console.log(`PASS dependency probe: ${mode}; rc=${rc}; no PASS summary`)
  }
  return missed
}

export function run(read = readFileSync, report = message => console.error(message)) {
  try { productionContract(read) }
  catch (error) {
    if (error.unverifiedCore) {
      report(`UNVERIFIED: requires core sources and production bundles from hostcore/core-recipe.json; missing ${error.unverifiedCore}; disclosure scenarios/self-test not run; rc=2 (environment SKIP, not PASS)`)
      return 2
    }
    report('FAIL: production contract: ' + error.message)
    return 1
  }
  const base = SHELLS.map(rel => { const { code, closed } = extract(readFileSync(join(ROOT, rel), 'utf8')); return [rel, code, closed] })
  const problems = judge(base)
  for (const [rel, code] of base) console.log(`SHIM ${rel.split('/')[0]} cooked sha256=${createHash('sha256').update(code).digest('hex')}`)
  problems.forEach(p => console.error(p))
  const missed = process.argv.includes('--self-test') ? selfTest(base) : 0
  console.log(`${problems.length || missed ? 'FAIL' : 'PASS'}: 2 shells x ${CASES.length + 1} cooked production-DOM scenarios; ${problems.length} failures; ${missed} missed negatives`)
  return problems.length || missed ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = run()
}
