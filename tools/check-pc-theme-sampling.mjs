import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const file = 'entry/src/main/ets/pages/WebApp.ets';
const source = readFileSync(process.argv.find(v => v.startsWith('--source='))?.slice(9) || file, 'utf8');
function cooked(text, name) {
  const start = text.indexOf(`const ${name}: string = `);
  assert(start >= 0, name);
  const open = text.indexOf('`', start);
  let end = open + 1;
  for (; end < text.length; end++) {
    if (text[end] === '\\') { end++; continue; }
    if (text[end] === '`') break;
  }
  return vm.runInNewContext(text.slice(open, end + 1));
}
function check(text) {
  const root = { scheme: 'light', bg: 'rgba(0, 0, 0, 0)', attrs: new Map(),
    setAttribute(k, v) { this.attrs.set(k, v); },
    classList: { contains() { return false; } } };
  const body = { bg: 'rgb(255, 255, 255)' };
  const timers = [];
  const observers = [];
  const reports = [];
  const glass = [];
  let popup = false;
  const doc = { documentElement: root, body,
    getElementById() { return {}; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    elementFromPoint() { return popup ? { bg: 'rgba(0, 0, 0, 0.4)' } : body; },
    addEventListener() {} };
  const context = vm.createContext({ document: doc,
    window: { CSS: { supports() { return false; } } },
    CSS: { supports() { return false; } },
    localStorage: { getItem() { return 'off'; } },
    getComputedStyle(node) { return { colorScheme: node.scheme || '', backgroundColor: node.bg }; },
    matchMedia() { return { matches: true, addEventListener() {} }; },
    MutationObserver: class { constructor(fn) { observers.push(fn); } observe() {} },
    setTimeout(fn) { timers.push(fn); }, setInterval(fn) { timers.push(fn); },
    __DSHM_BRIDGES__: { onThemeMode(mode) { reports.push(mode); },
      writeGlassDiag(detail) { glass.push(JSON.parse(detail)); } } });
  vm.runInContext(cooked(text, 'THEME_SHIM_JS'), context);
  vm.runInContext(cooked(text, 'GLASS_SKIN_JS'), context);
  const flush = () => { for (const fn of [...observers, ...timers]) fn(); };
  flush();
  assert.equal(reports.at(-1), 'light');
  assert.equal(root.attrs.get('data-dshm-glass-dark'), '0');
  popup = true;
  flush();
  assert.deepEqual(reports, ['light']);
  assert.equal(glass.at(-1).dark, false);
  root.scheme = 'dark'; body.bg = 'rgb(21, 21, 23)';
  flush();
  assert.equal(reports.at(-1), 'dark');
  assert.equal(root.attrs.get('data-dshm-glass-dark'), '1');
  assert.equal(glass.at(-1).dark, true);
  root.scheme = 'light'; body.bg = 'rgb(255, 255, 255)';
  flush();
  popup = false;
  flush(); flush();
  assert.deepEqual(reports, ['light', 'dark', 'light']);
  assert.equal(root.attrs.get('data-dshm-glass-dark'), '0');
  body.bg = 'rgba(0, 0, 0, 0)'; root.bg = 'rgb(255, 255, 255)';
  flush();
  assert.equal(root.attrs.get('data-dshm-glass-dark'), '0');
  body.bg = 'rgba(21, 21, 23, 1)';
  flush();
  assert.equal(root.attrs.get('data-dshm-glass-dark'), '1');
}
check(source);
console.log('PASS cooked production theme/glass: light popup, dark switch, close stability, transparent root fallback');
if (process.argv.includes('--self-test')) {
  const mutants = [
    text => text.replace('var m = /rgba?', 'var m = /broken?'),
    text => text.replace('var a = /rgba', 'var a = /broken'),
    text => text.replace("if (scheme.indexOf('dark') >= 0)", 'if (true)'),
    text => text.replace("if (mode === last) { return; }", '')
  ];
  for (const mutate of mutants) {
    const changed = mutate(source);
    assert.notEqual(changed, source);
    assert.throws(() => check(changed));
  }
  console.log(`PASS self-test: ${mutants.length} behavior mutations rejected`);
}
