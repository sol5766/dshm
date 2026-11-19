import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext, Script } from 'node:vm';

const source = readFileSync(new URL('../phone/src/main/ets/pages/WebApp.ets', import.meta.url), 'utf8');
const mark = 'const VIEWPORT_RECONCILE_SCRIPT: string = `';
const templates = [
  '',
  '0px minmax(0px, 1fr) minmax(0px, 0px)',
  '56px minmax(0px, 1fr) minmax(0px, 0px)',
  '280px minmax(0px, 1fr) minmax(0px, 0px)',
  '280px minmax(400px, 1fr) minmax(0px, 320px)',
  '56px minmax(400px, 1fr) minmax(0px, 420px)',
];
const specs = [
  { name: 'drawer-closed', drawer: true },
  { name: 'drawer-open', drawer: true, expanded: true },
  { name: 'drawer-stale', drawer: true, frameWidth: 313.5 },
  { name: 'drawer-boundary', drawer: true, rootWidth: 767 },
  { name: 'non-drawer-boundary', rootWidth: 768 },
  { name: 'non-drawer-collapsed', rootWidth: 900 },
  { name: 'non-drawer-expanded', rootWidth: 1200, expanded: true },
  { name: 'root-window-disagree', windowWidth: 681, frameWidth: 681 },
  { name: 'zero-root-fallback', rootWidth: 0 },
  { name: 'fractional-root', rootWidth: 390.4 },
  { name: 'missing-frame', noFrame: true },
  { name: 'missing-body-visual', noBody: true, noVisual: true },
  { name: 'non-handheld', off: true, rootWidth: 1200 },
  { name: 'non-handheld-missing-frame', off: true, noFrame: true },
  { name: 'missing-root', noRoot: true },
];

function extract(src) {
  const at = src.indexOf(mark);
  assert.ok(at >= 0, 'missing viewport template');
  const from = at + mark.length;
  const end = src.indexOf('`', from);
  assert.ok(end > from && src[end + 1] === ';', 'unclosed viewport template');
  return runInNewContext('`' + src.slice(from, end) + '`', {}, { timeout: 1000 });
}

function behavior(code, spec, template) {
  const writes = [];
  const events = [];
  const style = (name, initial = {}) => new Proxy(initial, {
    set(target, key, value) {
      writes.push([name, key, value]);
      target[key] = value;
      return true;
    },
    deleteProperty(target, key) {
      writes.push([name, key, 'DELETE']);
      return Reflect.deleteProperty(target, key);
    },
    defineProperty(target, key, descriptor) {
      writes.push([name, key, descriptor.value]);
      return Reflect.defineProperty(target, key, descriptor);
    },
  });
  const rootWidth = spec.rootWidth ?? 390;
  const windowWidth = spec.windowWidth ?? 390;
  const root = { clientWidth: rootWidth, clientHeight: 844, style: style('root'),
    getAttribute: key => key === 'class' ? (spec.off ? 'dshm-desktop' : 'dshm-handheld dshm-compact') : null };
  const body = { style: style('body') };
  const frame = { style: style('frame', { gridTemplateColumns: template }),
    hasAttribute: key => key === 'data-sidebar-drawer' ? !!spec.drawer
      : key === 'data-sidebar-collapsed' ? !spec.expanded : false,
    getAttribute: key => frame.hasAttribute(key) ? '' : null,
    getBoundingClientRect: () => ({ width: frame.style.width === '100%'
      ? rootWidth || windowWidth : spec.frameWidth ?? rootWidth }) };
  const document = { documentElement: spec.noRoot ? null : root, body: spec.noBody ? null : body,
    querySelector: selector => {
      assert.equal(selector, '.dshm-frame');
      return spec.noFrame ? null : frame;
    } };
  const dispatch = target => event => events.push([target, event.type, frame.style.gridTemplateColumns]);
  const window = { innerWidth: windowWidth, innerHeight: 844, dispatchEvent: dispatch('window'),
    visualViewport: spec.noVisual ? undefined : { dispatchEvent: dispatch('visualViewport') } };
  const expectedWrites = spec.off || spec.noRoot ? [] : [
    ['root', 'width', '100%'], ['root', 'maxWidth', '100%'],
    ...spec.noBody ? [] : [['body', 'width', '100%'], ['body', 'maxWidth', '100%'], ['body', 'overflowX', 'hidden']],
    ...spec.noFrame ? [] : [['frame', 'width', '100%'], ['frame', 'maxWidth', '100%'], ['frame', 'minWidth', '0']],
  ];
  const expectedEvents = spec.off || spec.noRoot ? [] : [
    ['window', 'resize', template], ...spec.noVisual ? [] : [['visualViewport', 'resize', template]],
  ];
  for (let pass = 0; pass < 2; pass++) {
    writes.length = 0;
    events.length = 0;
    const before = spec.noFrame ? -1 : Math.round(frame.getBoundingClientRect().width);
    const result = runInNewContext(code, { document, window, Event }, { timeout: 1000 });
    assert.equal(frame.style.gridTemplateColumns, template, 'official grid template changed');
    assert.deepEqual(writes, expectedWrites, 'unexpected style writes or missing width reconciliation');
    assert.deepEqual(events, expectedEvents, 'resize targets, order or grid snapshot changed');
    const after = spec.noFrame ? -1 : Math.round(rootWidth || windowWidth);
    assert.equal(result, spec.off || spec.noRoot ? 'off'
      : `vw=${Math.round(rootWidth || windowWidth)} vh=844 frame=${before}->${after}`, 'viewport result changed');
  }
}

export function judge(src) {
  const problems = [];
  let code;
  try { code = extract(src); new Script(code); }
  catch (error) { return [`extract/cook: ${error.message}`]; }
  for (const spec of specs) {
    for (const template of templates) {
      try { behavior(code, spec, template); }
      catch (error) { problems.push(`${spec.name} [${template}]: ${error.message}`); }
    }
  }
  return problems;
}

function selfTest() {
  const anchor = "frame.style.minWidth = '0';";
  const mutations = [
    ['restore-clear', anchor, anchor + "\nif (frame.style.gridTemplateColumns) { frame.style.gridTemplateColumns = ''; }"],
    ['write-zero-columns', anchor, anchor + "\nframe.style.gridTemplateColumns = '0px minmax(0,1fr) 0px';"],
    ['remove-handheld-gate', "if (cls.indexOf('dshm-handheld') < 0) { return 'off'; }", ''],
    ['same-value-grid-write', anchor, anchor + '\nframe.style.gridTemplateColumns = frame.style.gridTemplateColumns;'],
    ['remove-width-reconcile', "frame.style.width = '100%';", ''],
    ['remove-window-resize', "window.dispatchEvent(new Event('resize'));", ''],
    ['remove-visual-resize', "window.visualViewport.dispatchEvent(new Event('resize'));", ''],
  ];
  for (const [name, before, after] of mutations) {
    assert.equal(source.split(before).length, 2, `mutation anchor must be unique: ${name}`);
    const mutant = source.replace(before, after);
    new Script(extract(mutant));
    const problems = judge(mutant);
    assert.ok(problems.length > 0, `negative control escaped: ${name}`);
    console.log(`PASS self-test ${name}: rejected (${problems.length} cases)`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = judge(source);
  for (const problem of problems) console.error(`FAIL ${problem}`);
  if (problems.length) process.exitCode = 1;
  else {
    if (process.argv.includes('--self-test')) selfTest();
    console.log(`PASS phone viewport grid: ${specs.length * templates.length} cases, two passes each (mock DOM only)`);
  }
}
