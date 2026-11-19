#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
let ts;
for (const candidate of ['typescript',
  '/data/service/hnp/hmos-clt.org/hmos-clt_1.0.0/codelinter/node_modules/typescript']) {
  try { ts = require(candidate); break; } catch {}
}
assert.ok(ts, 'TypeScript parser is required (project or HarmonyOS SDK)');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const status = { UNDEFINED: 0, FULL_SCREEN: 1, MAXIMIZE: 2, MINIMIZE: 3, FLOATING: 4, SPLIT_SCREEN: 5 };
const modules = ['entry', 'phone'];
const paths = modules.map(module => `${module}/src/main/ets/entryability/EntryAbility.ets`);

function extract(source) {
  const tree = ts.createSourceFile('ability.ts', source, ts.ScriptTarget.Latest, true);
  const ability = tree.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'EntryAbility');
  assert.ok(ability, 'production EntryAbility');
  const methods = new Map(ability.members.filter(ts.isMethodDeclaration).map(n => [n.name.getText(tree), n.getText(tree)]));
  const policy = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'shouldRestoreFreeDecor');
  assert.ok(policy, 'production pure policy');
  const selected = ['refreshDecorCaps', 'bindGeometry', 'unbindGeometry', 'reassertDecorButtons', 'afterWindowStageReady',
    'onForeground', 'onBackground', 'onWindowStageDestroy', 'onWindowStageCreate'];
  if (methods.has('bindFreeWindowMode')) selected.push('bindFreeWindowMode');
  selected.push('hideHandheldTitleButtons');
  if (methods.has('showTitleButtons')) selected.push('showTitleButtons');
  const fields = ability.members.filter(ts.isPropertyDeclaration).filter(n =>
    /^(decor|free|pcMode|onFreeWindowModeChanged|onDecorStatusChanged)/.test(n.name.getText(tree)));
  selected.push('revokeDecorStyle', 'publishDecorKeysVisible');
  for (const name of ['decorStyleWritable']) {
    assert.ok(fields.some(n => n.name.getText(tree) === name), `production field ${name}`);
  }
  const code = `${policy.getText(tree)}\nclass Harness {\n${fields.map(n => n.getText(tree)).join('\n')}\n` +
    selected.map(name => { assert.ok(methods.has(name), name); return methods.get(name); }).join('\n') + '\n}\nHarness;';
  return { methods, code: ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText };
}

function extractWeb(source) {
  const tree = ts.createSourceFile('web.ts', source.replace('struct WebApp {', 'class WebApp {'),
    ts.ScriptTarget.Latest, true);
  const page = tree.statements.find(n => (ts.isClassDeclaration(n) || ts.isStructDeclaration(n)) && n.name?.text === 'WebApp');
  assert.ok(page, 'production WebApp');
  const method = page.members.find(n => ts.isMethodDeclaration(n) && n.name.getText(tree) === 'applyDecorButtonMode');
  assert.ok(method, 'production WebApp.applyDecorButtonMode');
  for (const field of ['decorWin', 'handheld', 'decorStyleWritable', 'decorStyleWindowId']) {
    assert.ok(page.members.some(n => ts.isPropertyDeclaration(n) && n.name.getText(tree) === field),
      `production WebApp field ${field}`);
  }
  const declarations = page.members.filter(n => ts.isPropertyDeclaration(n)
    && ['decorWin', 'handheld', 'decorStyleWritable', 'decorStyleWindowId'].includes(n.name.getText(tree)));
  assert.equal(declarations.length, 4);
  const cleanField = (node) => node.getText(tree).replace(/@StorageProp\([^\n]*\)\s*/g, '').replace(/\s+private\s+/g, ' ');
  const cleanMethod = method.getText(tree).replace(/^\s*private\s+/, ' ');
  const code = `class WebHarness { ${declarations.map(cleanField).join('\n')} ${cleanMethod} } WebHarness;`;
  return { method: method.getText(tree), code: ts.transpileModule(code,
    { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText };
}

function inspect(source, webSource) {
  const production = extract(source);
   const writes = [];
   const storage = new Map();
  const diagnostics = [];
  let handheld = true;
  const context = vm.createContext({
    window: { WindowStatusType: status }, isHandheldForm: () => handheld,
    WindowKind: { MAIN: 'MAIN' }, DOMAIN: 0, TAG: 'test',
    hilog: { info() {}, warn() {}, debug() {}, error() {} },
     AppStorage: {
       get: key => storage.get(key),
       setOrCreate: (key, value) => { storage.set(key, value); writes.push([key, value]); }
     },
    KEY_PC_MODE: 'pc', KEY_DECOR_KEYS_VISIBLE: 'inset',
    KEY_DECOR_STYLE_WRITABLE: 'styleWritable', KEY_DECOR_STYLE_WINDOW_ID: 'styleWindowId',
    writeDecorCapsDiag: (_dir, line) => diagnostics.push(line),
    readWindowStatusOf: win => { try { return win.getWindowStatus(); } catch { return undefined; } },
    windowStatusName: value => String(value),
    decorPresentOf: () => false, statusBarOwnedByApp: () => true,
    registerWindow() {}, writeWindowCloseDiag() {}, readDeviceFacts: () => ({ form: 'desktop' }),
    ConfigurationConstant: { ColorMode: { COLOR_MODE_DARK: 0, COLOR_MODE_LIGHT: 1 } }
  });
  const Harness = vm.runInContext(production.code, context);
  const web = extractWeb(webSource);
  const WebHarness = vm.runInContext(web.code, context);
  const make = () => {
    const calls = [];
    const listeners = new Map();
    const fail = new Set();
    const win = {
      free: true, status: status.FLOATING,
      isInFreeWindowMode() { if (fail.has('query')) throw Error('query'); return this.free; },
      getWindowStatus() { if (fail.has('status')) throw Error('status'); return this.status; },
      getWindowProperties() { if (fail.has('id')) throw Error('id'); return { id: 1 }; },
      getWindowDecorHeight: () => 38,
      on(event, callback) { if (fail.has(`on:${event}`)) throw Error('on'); listeners.set(event, callback); },
      off(event, callback) {
        assert.equal(callback, listeners.get(event), `symmetric off ${event}`);
        listeners.delete(event);
        if (fail.has(`off:${event}`)) throw Error('off');
      },
      setWindowDecorVisible(value) { calls.push(['decor', value]); if (fail.has('decor')) throw Error('decor'); },
      setWindowTitleButtonVisible(...args) { calls.push(['buttons', ...args]); if (fail.has('buttons')) throw Error('buttons'); },
      setWindowDecorHeight(value) { calls.push(['height', value]); },
      setDecorButtonStyle(value) { calls.push(['style', value.colorMode]); }
    };
    const ability = new Harness();
    Object.assign(ability, {
      mainWindow: win, decorContentReady: true, decorForeground: true, appBackgrounded: false,
      decorStyleWritable: false,
      launchParams: { kind: 'MAIN' }, context: { filesDir: '' }, appearanceMode: () => 'light',
      reassertWindowChrome() { this.reassertDecorButtons(win); },
      onGeometryChanged() {}, mainWindowOf: () => win, ledgerLabel: () => '',
      enterTabletImmersive() {}, memoryReady: Promise.resolve(), memory: { restoreMainGeometry: () => false }
    });
     ability.reassertWindowChrome = function() {
       this.reassertDecorButtons(win);
     };
    ability.launchParams.kind = 'MAIN';
    return { ability, win, calls, listeners, fail };
  };
  let count = 0;
  for (const free of [undefined, false, true]) {
    for (const mode of [undefined, ...Object.values(status)]) {
      for (const foreground of [false, true]) {
        const t = make();
        t.win.free = free;
        t.win.status = mode;
        t.ability.decorForeground = foreground;
        t.ability.refreshDecorCaps(t.win);
        const restore = free === true && foreground && [status.FLOATING, status.MAXIMIZE].includes(mode);
        const decorCalls = t.calls.filter(call => call[0] === 'decor' || call[0] === 'buttons');
        assert.deepEqual(decorCalls, restore ? [['decor', true], ['buttons', true, true, true]] : [],
          `matrix free=${free} status=${mode} foreground=${foreground}`);
        assert.equal(t.ability.freeDecorShown, restore);
        assert.equal(t.ability.freeButtonsShown, restore);
        count++;
      }
    }
  }
  for (const guard of ['unready', 'destroyed', 'old-window', 'session', 'background', 'before-foreground', 'query', 'status', 'pc']) {
    const t = make();
    if (guard === 'unready') t.ability.decorContentReady = false;
    if (guard === 'destroyed') t.ability.mainWindow = undefined;
    if (guard === 'old-window') t.ability.mainWindow = {};
    if (guard === 'session') t.ability.launchParams.kind = 'session';
    if (guard === 'background') t.ability.appBackgrounded = true;
    if (guard === 'before-foreground') t.ability.decorForeground = false;
    if (guard === 'query' || guard === 'status') t.fail.add(guard);
    if (guard === 'pc') handheld = false;
    t.ability.refreshDecorCaps(t.win);
    assert.deepEqual(t.calls, [], guard);
    handheld = true;
    count++;
  }
  for (const failure of ['decor', 'buttons']) {
    const t = make();
    t.fail.add(failure);
    t.ability.bindGeometry(t.win);
    assert.equal(t.ability.freeDecorShown, failure !== 'decor');
    assert.equal(t.ability.freeButtonsShown, failure !== 'buttons');
    assert.equal(t.calls.filter(call => call[0] === 'decor' || call[0] === 'buttons').length, 2, 'independent catch');
    t.fail.clear();
    t.listeners.get('windowStatusDidChange')(status.FLOATING);
    assert.equal(t.ability.freeDecorShown, true, 'retry decor');
    assert.equal(t.ability.freeButtonsShown, true, 'retry buttons');
    count++;
  }
  for (const failure of [undefined, 'decor', 'buttons']) {
    const denied = make();
    denied.ability.refreshDecorCaps(denied.win);
    denied.calls.length = 0;
    denied.fail.add('id');
    if (failure) denied.fail.add(failure);
    denied.ability.refreshDecorCaps(denied.win);
    denied.ability.reassertDecorButtons(denied.win);
    assert.deepEqual(denied.calls, [['decor', true], ['buttons', true, true, true]],
      `ID failure preserves independent environment restore: ${failure}`);
    assert.equal(denied.ability.freeDecorShown, failure !== 'decor');
    assert.equal(denied.ability.freeButtonsShown, failure !== 'buttons');
    assert.equal(denied.ability.decorStyleWritable, false, 'ID failure denies native style');
    assert.equal(storage.get('styleWritable'), false, 'ID failure revokes existing shared style grant');
    count++;
  }
  const missingId = make();
  missingId.fail.add('id');
  missingId.ability.refreshDecorCaps(missingId.win);
  assert.deepEqual(missingId.calls, [['decor', true], ['buttons', true, true, true]],
    'initial ID failure restores decor and buttons without style');
  assert.equal(missingId.ability.decorStyleWritable, false);
  assert.equal(missingId.ability.decorStyleWindowId, '');
  count++;
  const t = make();
  t.win.free = false;
  t.ability.bindGeometry(t.win);
  assert.deepEqual(t.calls, [], 'false FLOATING startup');
  assert.equal(t.ability.pcMode, true, 'existing FLOATING layout consumer retained');
  assert.ok(t.listeners.has('freeWindowModeChange'));
  assert.ok(t.listeners.has('windowStatusDidChange'));
  const lateFree = t.listeners.get('freeWindowModeChange');
  const lateStatus = t.listeners.get('windowStatusDidChange');
  lateFree(true);
  assert.equal(t.calls.filter(call => call[0] === 'decor' || call[0] === 'buttons').length, 2,
    'environment callback value used without FLOATING inference');
  t.calls.length = 0;
  t.ability.decorForeground = false;
  lateFree(true);
  lateStatus(status.FLOATING);
  assert.deepEqual(t.calls, [], 'background callbacks');
  t.win.free = true;
  t.ability.decorForeground = true;
  const foreground = production.methods.get('onForeground');
  const replay = foreground.slice(foreground.indexOf('this.appBackgrounded = false;'),
    foreground.indexOf('this.refreshDecorCaps(this.mainWindow);') + 'this.refreshDecorCaps(this.mainWindow);'.length);
  assert.ok(replay.includes('this.decorForeground = true;'), 'foreground replay wiring');
   vm.runInContext(ts.transpileModule(`(function() { ${replay} })`,
     { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context).call(t.ability);
  assert.equal(t.calls.filter(call => call[0] === 'decor' || call[0] === 'buttons').length, 2,
    'production foreground prefix replay');
  t.calls.length = 0;
  t.ability.unbindGeometry(t.win);
  assert.equal(t.listeners.size, 0, 'all listeners removed');
  t.ability.mainWindow = {};
  lateFree(true);
  lateStatus(status.FLOATING);
  assert.deepEqual(t.calls, [], 'late callbacks cannot write old window');
  const independentOff = make();
  independentOff.ability.bindGeometry(independentOff.win);
  independentOff.fail.add('off:freeWindowModeChange');
  independentOff.ability.unbindGeometry(independentOff.win);
  assert.equal(independentOff.listeners.size, 0, 'one failed off cannot skip other off');
  const failedListener = make();
  failedListener.fail.add('on:windowStatusDidChange');
  failedListener.ability.bindGeometry(failedListener.win);
  assert.ok(failedListener.listeners.has('freeWindowModeChange'), 'independent registration');
  assert.equal(failedListener.calls.filter(call => call[0] === 'decor' || call[0] === 'buttons').length, 2,
    'initial refresh despite failed listener');
  const stateRetry = make();
  stateRetry.ability.bindGeometry(stateRetry.win);
  stateRetry.calls.length = 0;
  stateRetry.win.status = status.FULL_SCREEN;
  stateRetry.listeners.get('windowStatusDidChange')(status.FULL_SCREEN);
  assert.deepEqual(stateRetry.calls, [], 'fullscreen does not hide or queue preference');
  stateRetry.win.status = status.MAXIMIZE;
  stateRetry.listeners.get('windowStatusDidChange')(status.MAXIMIZE);
  assert.deepEqual(stateRetry.calls.filter(call => call[0] === 'decor' || call[0] === 'buttons'),
    [['decor', true], ['buttons', true, true, true]], 'exit fullscreen replays');
  const style = make();
  style.ability.reassertDecorButtons(style.win);
  assert.deepEqual(style.calls, [], 'all handheld style calls guarded');
  style.ability.refreshDecorCaps(style.win);
  assert.equal(style.ability.decorStyleWindowId, '1', 'production grant binds native owner');
  assert.equal(storage.get('styleWindowId'), '1', 'production grant publishes owner');
  style.calls.length = 0;
  style.ability.reassertDecorButtons(style.win);
  assert.deepEqual(style.calls, [['style', 1]], 'native grant permits replay');
  handheld = false;
  style.ability.reassertDecorButtons(style.win);
  assert.deepEqual(style.calls, [['style', 1], ['style', 1]], 'PC style retained');
   const page = new WebHarness();
   assert.equal(page.decorStyleWritable, false, 'production page defaults to deny');
   assert.equal(page.decorStyleWindowId, '', 'production page defaults to no window');
  page.decorWin = style.win;
  page.handheld = true;
  page.decorStyleWritable = false;
  page.decorStyleWindowId = '1';
  page.applyDecorButtonMode('dark');
  assert.deepEqual(style.calls, [['style', 1], ['style', 1]], 'mobile deny makes no style call');
  page.decorStyleWritable = true;
  page.decorStyleWindowId = 'other-window';
  page.applyDecorButtonMode('dark');
  assert.deepEqual(style.calls, [['style', 1], ['style', 1]], 'other window cannot consume MAIN grant');
  page.decorStyleWindowId = '1';
  page.applyDecorButtonMode('dark');
  assert.equal(style.calls.length, 3, 'authorized mobile write');
  page.handheld = false;
  page.decorStyleWritable = false;
  page.applyDecorButtonMode('light');
   assert.equal(style.calls.length, 4, 'PC path ignores mobile grant');
   handheld = true;
  assert.ok(web.method.indexOf('if (!this.decorStyleWritable)') < web.method.indexOf('setDecorButtonStyle'));
  assert.ok(web.method.indexOf('getWindowProperties') < web.method.indexOf('setDecorButtonStyle'));
  const publish = production.methods.get('publishDecorKeysVisible');
  assert.ok(publish.indexOf('this.revokeDecorStyle();') < publish.indexOf('KEY_DECOR_KEYS_VISIBLE'));
  const lifecycle = make();
  lifecycle.ability.launchParams.kind = 'MAIN';
   lifecycle.ability.refreshDecorCaps(lifecycle.win);
  lifecycle.ability.revokeDecorStyle();
  assert.equal(lifecycle.ability.decorStyleWritable, false);
  assert.deepEqual(writes.at(-1), ['styleWritable', false], 'native revocation published');
   lifecycle.ability.refreshDecorCaps(lifecycle.win);
   lifecycle.ability.publishDecorKeysVisible(true);
  assert.deepEqual(writes.slice(-2), [['styleWritable', false], ['inset', true]], 'revoke precedes keys notification');
   const nativeReplay = make();
   nativeReplay.ability.appearanceMode = () => 'dark';
   nativeReplay.ability.reassertWindowChrome = () => {};
   nativeReplay.ability.refreshDecorCaps(nativeReplay.win);
   assert.ok(nativeReplay.calls.some(call => call[0] === 'style' && call[1] === 0),
     'production grant directly replays current theme');
   const otherMain = make();
   otherMain.win.getWindowProperties = () => ({ id: 2 });
   otherMain.ability.refreshDecorCaps(otherMain.win);
   nativeReplay.ability.revokeDecorStyle();
   assert.equal(storage.get('styleWritable'), true, 'old MAIN cannot revoke another MAIN grant');
     assert.equal(storage.get('styleWindowId'), '2', 'new MAIN retains window identity');
     const staleMain = make();
     staleMain.win.getWindowProperties = () => ({ id: 3 });
     staleMain.ability.bindGeometry(staleMain.win);
     const staleFree = staleMain.listeners.get('freeWindowModeChange');
     const staleStatus = staleMain.listeners.get('windowStatusDidChange');
     otherMain.ability.refreshDecorCaps(otherMain.win);
     staleMain.ability.decorForeground = false;
     staleMain.calls.length = 0;
     for (const [callback, value] of [[staleFree, true], [staleStatus, status.FLOATING]]) {
       callback(value);
       assert.equal(staleMain.ability.decorStyleWritable, false, 'late old MAIN locally denied');
       assert.equal(storage.get('styleWritable'), true, 'late old MAIN preserves new owner grant');
       assert.equal(storage.get('styleWindowId'), '2', 'late old MAIN preserves new owner identity');
       assert.deepEqual(staleMain.calls, [], 'late background MAIN cannot write native chrome');
       count++;
     }
    const ungrantedMain = make();
    ungrantedMain.ability.revokeDecorStyle();
    assert.equal(storage.get('styleWritable'), true, 'ungranted MAIN cannot revoke owner');
    nativeReplay.fail.add('query');
    nativeReplay.calls.length = 0;
    nativeReplay.ability.refreshDecorCaps(nativeReplay.win);
    assert.equal(storage.get('styleWritable'), true, 'stale owner query failure preserves new grant');
    assert.equal(storage.get('styleWindowId'), '2', 'stale query failure preserves new owner');
    assert.deepEqual(nativeReplay.calls, [], 'stale query failure makes no native writes');
    otherMain.fail.add('query');
    otherMain.calls.length = 0;
    otherMain.ability.refreshDecorCaps(otherMain.win);
    assert.equal(storage.get('styleWritable'), false, 'current owner query failure revokes grant');
    assert.deepEqual(otherMain.calls, [], 'current owner query failure makes no native writes');
    otherMain.fail.clear();
    otherMain.ability.refreshDecorCaps(otherMain.win);
   const session = make();
   session.ability.launchParams.kind = 'session';
   session.ability.revokeDecorStyle();
   assert.equal(storage.get('styleWritable'), true, 'session cannot revoke MAIN grant');
   otherMain.ability.publishDecorKeysVisible(true);
   assert.deepEqual(writes.slice(-2), [['styleWritable', false], ['inset', true]],
     'owner revokes before keys notification');
   for (const deny of ['query', 'status', 'background', 'before-foreground']) {
     const denied = make();
     denied.ability.refreshDecorCaps(denied.win);
     denied.calls.length = 0;
     if (deny === 'query' || deny === 'status') denied.fail.add(deny);
     if (deny === 'background') denied.ability.appBackgrounded = true;
     if (deny === 'before-foreground') denied.ability.decorForeground = false;
     denied.ability.refreshDecorCaps(denied.win);
     assert.equal(storage.get('styleWritable'), false, `existing grant revoked: ${deny}`);
     assert.deepEqual(denied.calls, [], `no style or decor write after ${deny}`);
   }
  const nativeDenied = make();
  nativeDenied.ability.reassertDecorButtons(nativeDenied.win);
  assert.deepEqual(nativeDenied.calls, [], 'native mobile style denied without grant');
   const pc = make();
   handheld = false;
  pc.ability.afterWindowStageReady({});
  assert.deepEqual(pc.calls, [['decor', false], ['height', 38], ['style', 1], ['style', 1]], 'PC startup unchanged');
  handheld = true;
  const startup = make();
  startup.win.free = false;
  startup.ability.afterWindowStageReady({});
  assert.deepEqual(startup.calls, [], 'handheld startup does not hide/height/style');
  const destroy = production.methods.get('onWindowStageDestroy');
  assert.ok(destroy.indexOf('this.decorContentReady = false;') < destroy.indexOf('this.unbindGeometry('));
  assert.ok(destroy.includes('this.decorStage = undefined;'));
  assert.ok(destroy.includes('this.mainWindow = undefined;'));
  assert.ok(production.methods.get('onWindowStageCreate').includes('this.decorStage !== windowStage'));
  assert.ok(production.methods.get('onWindowStageCreate').includes('this.decorContentReady = !err.code;'));
  assert.ok(production.methods.get('onBackground').includes('this.decorForeground = false;'));
  assert.ok(!production.methods.get('refreshDecorCaps').includes('setTimeout'));
  assert.ok(diagnostics.some(line => line.includes('desired=restore') && line.includes('decorCallOk=')));
    return count + 38;
}

const mutations = [
  ['FLOATING inferred environment', s => s.replace('this.freeWindowMode = win.isInFreeWindowMode();', 'this.freeWindowMode = true;')],
  ['non-free hide', s => s.replace("let decorResult: string = 'skip';", "win.setWindowDecorVisible(false); let decorResult: string = 'skip';")],
  ['mobile 38', s => s.replace("let decorResult: string = 'skip';", "win.setWindowDecorHeight(38); let decorResult: string = 'skip';")],
  ['failed decor marked success', s => s.replace('decorResult = `error=${String(err)}`;', 'this.freeDecorShown = true; decorResult = `error=${String(err)}`;')],
  ['failed buttons marked success', s => s.replace('buttonsResult = `error=${String(err)}`;', 'this.freeButtonsShown = true; buttonsResult = `error=${String(err)}`;')],
  ['background writes', s => s.replace('this.decorForeground && !this.appBackgrounded);', 'true);')],
   ['unready writes', s => s.replaceAll('!this.decorContentReady', 'false')],
   ['old window writes', s => s.replaceAll('win !== this.mainWindow', 'false')],
  ['MAXIMIZE omitted', s => s.replace('status === window.WindowStatusType.MAXIMIZE', 'false')],
  ['missing free off', s => s.replace("win.off('freeWindowModeChange', this.onFreeWindowModeChanged);", '')],
  ['missing status off', s => s.replace("win.off('windowStatusDidChange', this.onDecorStatusChanged);", '')],
  ['missing foreground replay', s => s.replace('this.refreshDecorCaps(this.mainWindow);', '')],
  ['unguarded mobile style', s => s.replace("return 'system-owned';", 'win.setDecorButtonStyle({ colorMode: 1 });')],
   ['layout replaced with environment', s => s.replace('const pcModeNow: boolean = this.decorFloating === true;', 'const pcModeNow: boolean = this.freeWindowMode === true;')],
   ['cross-window revoke', s => s.replace('AppStorage.get<string>(KEY_DECOR_STYLE_WINDOW_ID) === this.decorStyleWindowId', 'true')],
   ['ID failure blocks environment restore', s => s.replace(
     "    let decorResult: string = 'skip';",
     "    if (!this.decorStyleWritable) return;\n    let decorResult: string = 'skip';")],
   ['ID failure retains style grant', s => s.replace(
     '      } catch (err) {\n        this.revokeDecorStyle();\n      }',
     '      } catch (err) {\n        this.decorStyleWritable = true;\n      }')],
   ['missing grant theme replay', s => s.replace('        this.reassertDecorButtons(win);', '')],
   ['keys notify before revoke', s => s.replace('  private publishDecorKeysVisible(value: boolean): void {',
     '  private publishDecorKeysVisible(value: boolean): void { AppStorage.setOrCreate<boolean>(KEY_DECOR_KEYS_VISIBLE, value);')]
];

const webMutations = [
  ['missing web permission guard', s => s.replace('if (!this.decorStyleWritable) {', 'if (false) {')],
  ['default permission true', s => s.replace('decorStyleWritable: boolean = false', 'decorStyleWritable: boolean = true')],
  ['pcMode reused as permission', s => s.replace('if (!this.decorStyleWritable) {', 'if (!this.pcMode) {')],
  ['decorKeysVisible reused as permission', s => s.replace('if (!this.decorStyleWritable) {', 'if (!this.decorKeysVisible) {')],
  ['window identity bypass', s => s.replace('String(this.decorWin.getWindowProperties().id) !== this.decorStyleWindowId', 'false')]
];

let total = 0;
let killed = 0;
for (const path of paths) {
  const source = readFileSync(resolve(root, path), 'utf8');
  const webSource = readFileSync(resolve(root, `${modules[paths.indexOf(path)]}/src/main/ets/pages/WebApp.ets`), 'utf8');
  const count = inspect(source, webSource);
  total += count;
  console.log(`PASS ${path}: ${count} production behavior cases`);
  if (process.argv.includes('--self-test')) {
    for (const [name, mutate] of mutations) {
      const mutant = mutate(source);
      assert.notEqual(mutant, source, `mutation anchor: ${name}`);
      assert.throws(() => inspect(mutant, webSource), undefined, `surviving mutant: ${name}`);
      killed++;
    }
    for (const [name, mutate] of webMutations) {
      const mutant = mutate(webSource);
      assert.notEqual(mutant, webSource, `web mutation anchor: ${name}`);
      assert.throws(() => inspect(source, mutant), undefined, `surviving WebApp mutant: ${name}`);
      killed++;
    }
  }
}
console.log(`PASS: ${total} cases; ${killed} effective mutants rejected`);
