import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('entry/src/main/ets/pages/WebApp.ets', 'utf8');
function check(text) {
  assert(!/webModal|syncModal|modalVisible|MODAL_SEL/.test(text));
  const top = text.slice(text.indexOf('  TopBar() {'), text.indexOf('  private bottomSafeAreaTypes('));
  assert(!top.includes('#66000000'));
  /* 2026-11-16 沉浸：顶栏不再画自己的底色（原 topBarBgNow 断言随该设计退役，2026-11-17 改钉现状） */
  assert(top.includes('.backgroundColor(Color.Transparent)'));
  assert(top.includes('this.beginWindowDrag()'));
  assert(text.includes('this.decorWin.setDecorButtonStyle('));
  const start = text.indexOf('  function findDialogs() {');
  const end = text.indexOf('  function findMenus()', start);
  assert(start >= 0 && end > start);
  for (const desktop of [false, true]) {
    const selector = '[data-shortcut-modal="settings"]';
    const settings = { role: true, modal: true, closest: value => value === selector ? settings : null };
    const nested = { role: false, modal: true, closest: value => value === selector ? settings : null };
    const floating = { role: false, modal: true, closest: () => null };
    const other = { role: true, modal: false, closest: () => null };
    const document = { documentElement: { classList: { contains: value => desktop && value === 'dshm-desktop' } },
      querySelectorAll: value => [settings, nested, floating, other].filter(node =>
        (value.includes('[role="dialog"]') && node.role)
        || (value.includes('[aria-modal="true"]') && node.modal)) };
    const find = vm.runInNewContext(text.slice(start, end) + '\nfindDialogs', { document });
    /* 2026-11-17：设置面板排除扩到全形态（原 11-14 只排 PC 桌面标记）——
       两种形态下设置面板及其内部 dialog 都不打标；非设置弹层（floating/other）照常打标。 */
    assert.deepEqual(Array.from(find()), [floating, other]);
  }
}
check(source);
console.log('PASS settings panel keeps official colors on all form factors; no native modal tint; non-settings dialogs still glassed; top bar stays transparent (2026-11-16 immersive)');
if (process.argv.includes('--self-test')) {
  const mutants = [
    text => text + '\nwebModal',
    text => text.replace("nodes[i].closest('[data-shortcut-modal=\"settings\"]') !== null", 'false'),
    text => text.replace("nodes[i].closest('[data-shortcut-modal=\"settings\"]') !== null", 'true'),
    text => text.replace('.backgroundColor(Color.Transparent)', ".backgroundColor('#66000000')"),
    text => text.replace("nodes[i].closest('[data-shortcut-modal=\"settings\"]')", "nodes[i].closest('[data-shortcut-modal=\"wrong\"]')"),
    text => text.replace("querySelectorAll('[role=\"dialog\"], [aria-modal=\"true\"]')", "querySelectorAll('[role=\"dialog\"]')"),
    text => text.replace("if (nodes[i].closest('[data-shortcut-modal=\"settings\"]')", 'if (true')
  ];
  for (const mutate of mutants) {
    const changed = mutate(source);
    assert.notEqual(changed, source);
    assert.throws(() => check(changed));
  }
  console.log(`PASS ${mutants.length} regression mutations rejected`);
}
