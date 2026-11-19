#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';

const files = ['entry', 'phone'].map(name => name + '/src/main/ets/pages/WebApp.ets');
function shimOf(src) {
  const marker = 'const BACK_SHIM_JS: string = `';
  const at = src.indexOf(marker);
  assert(at >= 0, 'missing back shim');
  const start = at + marker.length;
  const end = src.indexOf('\n})();`', start);
  assert(end > start, 'unclosed back shim');
  return runInNewContext('`' + src.slice(start, end + '\n})();'.length) + '`', {}, { timeout: 1000 });
}
function fixture(code, form = 'phone') {
  const model = { panel: true, drawer: false, right: false, overlays: [], detail: false,
    rows: true, editor: true, editorVisible: true, classes: 'dshm-desktop', escape: true, exits: 0, clicks: 0, at: 10000, logs: [], timers: [] };
  let serial = 0;
  const setTimer = (fn, delay) => {
    const id = ++serial;
    model.timers.push({ id, fn, at: model.at + delay });
    return id;
  };
  const clearTimer = id => { model.timers = model.timers.filter(task => task.id !== id); };
  const advance = ms => {
    const target = model.at + ms;
    for (;;) {
      model.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      if (!model.timers.length || model.timers[0].at > target) break;
      const task = model.timers.shift();
      model.at = task.at;
      task.fn();
    }
    model.at = target;
  };
  function node(attrs = {}, click = () => {}) {
    return { tagName: 'DIV', textContent: '', getAttribute: key => attrs[key] ?? null,
      getClientRects: () => [{}], getBoundingClientRect: () => ({ width: 200, height: 200 }),
      querySelector: sel => sel === '[data-sidebar-right-toggle]' ? toggle : null,
      querySelectorAll: () => model.detail ? [back] : [], click,
      dispatchEvent: () => { if (model.escape) model.overlays.pop(); } };
  }
  const row = node({}, () => { model.panel = false; model.clicks++; });
  const back = node({ 'aria-label': 'Back to plugins' }, () => { model.detail = false; model.clicks++; });
  const toggle = node({}, () => { model.right = false; model.clicks++; });
  const panel = node();
  const editor = node();
  editor.getClientRects = () => model.editorVisible ? [{}] : [];
  const right = node({ 'data-sidebar-right-open': '', 'aria-hidden': 'false' });
  const handlers = {};
  const document = {
    documentElement: { getAttribute: () => model.classes,
      classList: { contains: name => model.classes.split(' ').includes(name) } },
    querySelector: sel => {
      if (sel === '[data-global-panel]') return model.panel ? panel : null;
      if (sel === '[data-sidebar-right-panel]') return model.right ? right : null;
      if (sel.includes('data-lexical-editor')) return model.editor ? editor : null;
      if (sel === '[data-sidebar-list-area]') return row;
      return null;
    },
    querySelectorAll: sel => {
      if (sel === '[data-lexical-editor="true"]') return model.editor ? [editor] : [];
      if (sel.includes('data-shortcut-modal')) return model.overlays;
      if (sel === '[data-sidebar-right-open]') return model.right ? [right] : [];
      if (sel === '[data-sidebar-right-toggle]') return [toggle];
      if (sel.includes('data-row-key')) return model.rows ? [row] : [];
      return [];
    },
    addEventListener: (event, handler) => { handlers[event] = handler; }
  };
  panel.querySelector = () => null;
  const context = { document, window: { innerWidth: 1200, getComputedStyle: () => ({}) },
    console: { info: text => model.logs.push(text) }, Date: { now: () => model.at },
     KeyboardEvent: class {}, setTimeout: setTimer, clearTimeout: clearTimer,
    __DSHM_BRIDGES__: { platformForm: () => form, requestSystemBack: () => { model.exits++; } },
    __DSHM_SIDEBAR__: { state: () => model.drawer ? 'expanded' : 'collapsed',
      toggle: () => { model.drawer = !model.drawer; } } };
  runInNewContext(code, context);
  return { model, context, node, row, handlers, advance, back: context.__DSHM_BACK__,
    native: () => { const verdict = context.__DSHM_BACK__.consume(); if (verdict === 'none') model.exits++; return verdict; },
  };
}
function behavior(code) {
  let f = fixture(code);
  assert.equal(f.native(), 'home');
  assert.equal(f.model.panel, false);
  assert.equal(f.model.exits, 0);
  f.model.at += 1000;
  assert.equal(f.native(), 'none');
  assert.equal(f.model.exits, 1);
  f = fixture(code, 'desktop');
  f.context.__DSHM_BRIDGES__.platformHandheld = () => true;
  f.model.classes = 'dshm-desktop dshm-pc';
  assert.equal(f.back.state(), 'home');
  assert.equal(f.native(), 'home');
  assert.equal(f.model.exits, 0);
  f = fixture(code, 'phone');
  f.context.__DSHM_BRIDGES__.platformHandheld = () => false;
  assert.equal(f.back.state(), 'off');
  assert.equal(f.native(), 'off');
  assert.equal(f.model.clicks, 0);
  for (const hidden of [false, true]) {
    f = fixture(code);
    f.model.panel = false;
    f.model.editor = hidden;
    f.model.editorVisible = false;
    assert.equal(f.back.state(), 'blocked');
    assert.equal(f.native(), 'blocked');
    assert.equal(f.model.exits, 0);
  }
  f = fixture(code);
  assert.equal(f.back.state(), 'home');
  assert.equal(f.native(), 'home');
  f = fixture(code);
  f.model.detail = true;
  f.model.overlays = [f.node(), f.node()];
  assert.equal(f.native(), 'overlay');
  assert.equal(f.model.overlays.length, 1);
  assert.equal(f.model.detail, true);
  assert.equal(f.native(), 'overlay');
  assert.equal(f.model.overlays.length, 0);
  assert.equal(f.native(), 'panel');
  f = fixture(code);
  f.model.right = true;
  assert.equal(f.native(), 'right');
  assert.equal(f.model.right, false);
  assert.equal(f.model.panel, true);
  f.model.drawer = true;
  assert.equal(f.native(), 'drawer');
  assert.equal(f.model.drawer, false);
  for (const form of ['tablet', 'foldable']) {
    f = fixture(code, form);
    f.model.classes = form === 'foldable' ? 'dshm-desktop dshm-form-foldable' : 'dshm-handheld dshm-tablet';
    assert.equal(f.native(), 'home');
    assert.equal(f.model.exits, 0);
  }
  f = fixture(code, 'desktop');
  assert.equal(f.native(), 'off');
  assert.equal(f.model.clicks, 0);
  f.model.classes = 'dshm-desktop dshm-form-foldable';
  assert.equal(f.native(), 'off');
  for (const bridgeState of ['missing', 'throw', 'empty']) {
    f = fixture(code);
    f.model.classes = 'dshm-desktop dshm-form-foldable';
    if (bridgeState === 'missing') f.context.__DSHM_BRIDGES__ = undefined;
    else f.context.__DSHM_BRIDGES__.platformForm = () => {
      if (bridgeState === 'throw') throw new Error('bridge unavailable');
      return '';
    };
    assert.equal(f.native(), 'home');
    assert.equal(f.model.exits, 0);
  }
  f = fixture(code);
  f.context.__DSHM_BRIDGES__ = undefined;
  f.model.classes = 'dshm-desktop dshm-form-foldable dshm-pc';
  assert.equal(f.native(), 'off');
  f = fixture(code);
  f.model.escape = false;
  f.model.overlays = [f.node()];
  assert.equal(f.native(), 'overlay');
  f.advance(320);
  assert.equal(f.model.exits, 0);
  assert.equal(f.model.overlays.length, 1);
  assert(f.model.logs.some(text => text.includes('retained internal layer')));
  f = fixture(code);
  f.model.rows = false;
  f.context.__DSHM_SIDEBAR__ = undefined;
  f.native();
  assert.equal(f.model.panel, true);
  assert.equal(f.model.exits, 0);
  f = fixture(code);
  f.context.__DSHM_BRIDGES__ = undefined;
  assert.equal(f.native(), 'off');
  assert.equal(f.model.exits, 0);
  assert.equal(f.handlers.touchstart, undefined);
  assert.equal(f.handlers.touchend, undefined);
  f = fixture(code);
  f.model.rows = false;
  assert.equal(f.native(), 'home');
  f.model.rows = true;
  f.advance(150);
  assert.equal(f.model.panel, false);
  assert.equal(f.model.drawer, true);
  f.advance(350);
  assert.equal(f.back.state(), 'blocked');
  assert.equal(f.native(), 'duplicate');
  f.advance(49);
  assert.equal(f.back.state(), 'blocked');
  const toggle = f.context.__DSHM_SIDEBAR__.toggle;
  f.context.__DSHM_SIDEBAR__.toggle = () => {
    assert.equal(f.back.state(), 'blocked');
    toggle();
  };
  f.advance(1);
  assert.equal(f.model.drawer, false);
  assert.equal(f.back.state(), 'none');
  assert.equal(f.model.exits, 0);
  assert.equal(f.native(), 'none');
  assert.equal(f.model.exits, 1);
  for (const failure of ['open', 'lookup', 'click', 'close', 'timeout']) {
    f = fixture(code);
    f.model.rows = false;
    if (failure === 'open') f.context.__DSHM_SIDEBAR__.toggle = () => { throw new Error('open'); };
    assert.equal(f.native(), 'home');
    if (failure === 'lookup') {
      const query = f.context.document.querySelectorAll;
      f.context.document.querySelectorAll = sel => {
        if (sel.includes('data-row-key')) throw new Error('lookup');
        return query(sel);
      };
    } else if (failure !== 'timeout' && failure !== 'open') {
      f.model.rows = true;
      if (failure === 'click') f.row.click = () => { throw new Error('click'); };
      if (failure === 'close') f.context.__DSHM_SIDEBAR__.toggle = () => { throw new Error('close'); };
    }
    const deadline = failure === 'timeout' ? 2550 : (failure === 'close' ? 550 : (failure === 'open' ? 0 : 150));
    if (failure === 'timeout') {
      f.advance(deadline - 1);
      assert.equal(f.back.state(), 'blocked');
      f.advance(1);
    } else {
      f.advance(deadline);
    }
    assert.notEqual(f.back.state(), 'blocked', failure + ' must release busy');
    assert.equal(f.model.exits, 0, failure + ' must not exit internally');
    assert.equal(f.model.timers.length, 0);
  }
}
function method(src, name) {
  const match = src.match(new RegExp('^  (?:private )?' + name + '\\([^\\n]*\\)[: \\w=]*\\{', 'm'));
  assert(match, 'missing native method ' + name);
  const start = match.index;
  const end = src.indexOf('\n  }', start) + '\n  }'.length;
  assert(end > start);
  return src.slice(start, end).replace('private ', '')
    .replace(/: (?:boolean|string|number|void|BusinessError)\b/g, '')
    .replace(/ as Error\b/g, '');
}
function nativeBehavior(src, code, ability) {
  const f = fixture(code);
  const calls = [];
  const advance = f.advance;
  const names = ['onBackPress', 'onBackTickRequest', 'requestWebRootBack', 'consumeWebBack', 'finishWebBack', 'readWebVerdict'];
  const Host = runInNewContext('(class { ' + names.map(name => method(src, name)).join('\n') + ' })', {
    setTimeout: f.context.setTimeout, clearTimeout: f.context.clearTimeout, Date: { now: () => f.model.at },
    hilog: { info() {}, warn() {} }, DOMAIN: 0, TAG: ''
  });
  const host = new Host();
  Object.assign(host, { handheld: true, backInFlight: false, backSettled: false, backRequestId: 0,
    backFallbackTimer: -1, lastBackHandledAt: -10000,
    dirPickerBridge: { writeDiagMarkerPublic() {} }, minimizeToBackground: () => { f.model.exits++; },
    controller: { runJavaScript: (script, callback) => { calls.push({ callback, result: JSON.stringify(runInNewContext(script, f.context)) }); },
      accessBackward: () => false, backward() {} } });
  let tick = 0;
  const abilityBack = runInNewContext('(function() { ' + method(ability, 'onBackPressed').replace(/^\s*onBackPressed\(\)\s*\{/, '').replace(/\}\s*$/, '')
    .replace(/AppStorage.get<number>/g, 'AppStorage.get').replace(/AppStorage.setOrCreate<number>/g, 'AppStorage.setOrCreate') + ' })', {
    isHandheldForm: () => host.handheld, KEY_BACK_TICK: 'dshBackTick',
    AppStorage: { get: () => tick, setOrCreate: (key, value) => { tick = value; host.onBackTickRequest(); } }
  });
  const reply = (index = calls.length - 1, error = null, result = calls[index].result) => calls[index].callback(error, result);
  const page = () => assert.equal(host.onBackPress(), true);
  const dual = order => { if (order) { page(); abilityBack(); } else { abilityBack(); page(); } };
  f.model.panel = false; f.model.overlays = [f.node()];
  f.handlers.touchstart?.({ touches: [{ clientX: 0, clientY: 0 }] });
  f.handlers.touchend?.({ changedTouches: [{ clientX: 100, clientY: 0 }] });
  advance(950); assert.equal(f.model.overlays.length, 1); assert.equal(calls.length, 0);
  dual(true); assert.equal(calls.length, 1);
  host.consumeWebBack(); host.requestWebRootBack();
  assert.equal(calls.length, 1); reply();
  abilityBack(); assert.equal(calls.length, 1, 'completion must retain lock until settle');
  assert.equal(f.model.overlays.length, 0); assert.equal(f.model.exits, 0);
  advance(500); dual(false); assert.equal(calls.length, 2, 'independent back at 500ms must work');
  reply(); assert.equal(f.model.exits, 1); reply(); assert.equal(f.model.exits, 1);
  advance(0);
  f.model.panel = true; dual(false); assert.equal(calls.length, 3); reply(); advance(0);
  assert.equal(f.model.panel, false); assert.equal(f.model.exits, 1);
  page(); const old = calls.length - 1; advance(1200);
  assert.equal(f.model.exits, 1); page(); const current = calls.length - 1;
  reply(old, null, '"none"'); assert.equal(host.backSettled, false);
  assert.equal(f.model.exits, 1); reply(current, new Error('bridge')); advance(0);
  assert.equal(f.model.exits, 1);
  const settledCount = calls.length;
  page(); assert.equal(calls.length, settledCount + 1); reply(undefined, new Error('bridge')); advance(0);
  page(); const expired = calls.length - 1; advance(1200); reply(expired, null, '"none"');
  assert.equal(f.model.exits, 1);
  f.model.panel = true; host.requestWebRootBack(); reply(); advance(0);
  assert.equal(f.model.panel, true); assert.equal(f.model.exits, 1);
  f.model.panel = false; host.requestWebRootBack(); reply(); advance(0);
  assert.equal(f.model.exits, 2);
  f.model.editor = false; page(); reply(); advance(0); assert.equal(f.model.exits, 2);
  host.handheld = false;
  const count = calls.length;
  assert.equal(abilityBack(), !method(ability, 'onBackPressed').includes('if (!isHandheldForm())'));
  host.onBackTickRequest(); host.requestWebRootBack();
  assert.equal(host.onBackPress(), false); assert.equal(calls.length, count);
  let backwards = 0;
  host.controller.accessBackward = () => true; host.controller.backward = () => { backwards++; };
  assert.equal(host.onBackPress(), true); assert.equal(backwards, 1); assert.equal(calls.length, count);
}
function inspect(src, ability) {
  const code = shimOf(src);
  assert(!code.includes('`') && !code.includes('${'));
  assert(!/SWIPE_|onSwipe|function askSystemBack|touchstart|touchend|lastBackSource|lastBackAt/.test(code));
  assert(!src.includes('lastBackHandledAt'));
  assert(!code.includes('editorblocked'));
  assert(src.includes("@StorageProp('dshBackTick') @Watch('onBackTickRequest')"));
  assert(src.includes("'requestSystemBack': (): void => this.requestWebRootBack()"));
  assert(src.includes('if (requestId !== this.backRequestId) { return; }'));
  assert(src.includes('if (this.handheld) {\n      this.onBackTickRequest();\n      return true;'));
  assert(src.includes("v === 'duplicate' || v === 'blocked'"));
  assert(src.includes("'platformHandheld': (): boolean => this.handheld"));
  assert(src.match(/methodList:\s*\[[^\]]*'platformHandheld'/));
  behavior(code);
  nativeBehavior(src, code, ability);
}
let failures = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const ability = readFileSync(file.replace('pages/WebApp.ets', 'entryability/EntryAbility.ets'), 'utf8');
  try { inspect(src, ability); console.log('PASS ' + file + ': cooked shim + extracted native/Ability behavior'); }
  catch (error) { failures++; console.error('FAIL ' + file, error.message); }
  if (process.argv.includes('--self-test')) {
    const mutations = [
      ["if (br && typeof br.platformHandheld === 'function') { return br.platformHandheld() === true; }", ''],
      ["'platformHandheld': (): boolean => this.handheld", "'platformHandheld': (): boolean => this.pcMode"],
      ["'platformHandheld', 'platformForm'", "'platformForm'"],
      ["return conversationRootVisible() ? 'none' : 'blocked';", "return document.querySelector('[data-sidebar-list-area]') !== null ? 'none' : 'blocked';"],
      ["if (visible(editors[i])) { return true; }", 'return true;'],
      ["if (form === 'phone' || form === 'tablet' || form === 'foldable') { return true; }", "if (form === 'phone') { return true; }"],
      ["classes.contains('dshm-form-foldable') && !classes.contains('dshm-pc')", 'false'],
      ["if (form === 'desktop') { return false; }", ''],
      ["&& !classes.contains('dshm-pc')", ''],
      ["return document.querySelector('[data-global-panel]');", 'return null;'],
      ["log('overlay not closed; retained internal layer');", "globalThis.__DSHM_BRIDGES__.requestSystemBack();"],
      ["if (consumeRightPanel()) { return 'right'; }", ''],
      ["if (consumePanelBack()) { return 'panel'; }", ''],
      ['if (this.backInFlight) { return; }', ''],
      ['}, 0);\n    if (this.backFallbackTimer', '}, 900);\n    if (this.backFallbackTimer'],
      ["this.finishWebBack('absent'); }", "this.finishWebBack('none'); }"],
      ['this.consumeWebBack(true);', 'this.minimizeToBackground();'],
      ["if (this.backSettled) { return; }", ''],
      ['globalThis.__DSHM_BACK__ = {', "document.addEventListener('touchend', function () { consume(); }); globalThis.__DSHM_BACK__ = {"],
      ["if (verdict === 'none') { this.minimizeToBackground(); }", 'this.minimizeToBackground();'],
      ['if (requestId !== this.backRequestId) { return; }', ''],
      ['} finally {\n            backBusy = false;', '} finally {'],
      ['backBusy = true;', 'backBusy = true; setTimeout(function () { backBusy = false; }, 3000);'],
      ["else { backBusy = false; log('consume: home aborted", "else { log('consume: home aborted"],
      ["log('session row click threw: ' + e);\n          backBusy = false;", "log('session row click threw: ' + e);"],
      ['} catch (e) {\n        backBusy = false;\n        return true;', '} catch (e) {\n        return true;']
    ];
    for (const [before, after] of mutations) {
      const changed = src.replace(before, after);
      let rejected = false;
      try { inspect(changed, ability); } catch { rejected = true; }
      if (changed === src || !rejected) { failures++; console.error('FAIL mutation ' + before); }
      else console.log('PASS mutation rejected: ' + before);
    }
  }
}
process.exitCode = failures ? 1 : 0;
