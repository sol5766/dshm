import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const source = readFileSync(new URL('../phone/src/main/ets/pages/WebApp.ets', import.meta.url), 'utf8');
const verify = readFileSync(new URL('./dshm-verify.mjs', import.meta.url), 'utf8');

function check(shell, tool) {
  assert(!shell.includes('PHONE_GLASS_DIAGNOSTICS_JS'));
  assert(!shell.includes("'writeGlassDiag'"));
  assert(!shell.includes('const GLASS_SKIN_JS'));
  assert(shell.includes('private glassCapabilityDeclared: boolean = false;'));
  const block = /aboutToAppear\(\): void \{\s*([\s\S]*?)\n    \/\//.exec(shell)?.[1];
  assert(block, 'native declaration at appearance');
  const calls = [];
  const owner = { glassCapabilityDeclared: false,
    dirPickerBridge: { writeDiagMarkerPublic(name, detail) { calls.push([name, JSON.parse(detail)]); } } };
  const appear = vm.runInNewContext(`(function () { ${block} })`, {}, { timeout: 1000 });
  appear.call(owner);
  appear.call(owner);
  assert.deepEqual(calls, [['diag-glass', { module: 'phone', implemented: false,
    effective: false, reason: 'phone-shell-no-glass-skin', cssSupport: null }]]);
  const body = /function evaluateGlass\(root, glass\) \{[\s\S]*?\n\}/.exec(tool)?.[0];
  assert(body);
  const evaluate = vm.runInNewContext(`(${body})`, { resolve }, { timeout: 1000 });
  const declaration = calls[0][1];
  const entry = '/data/storage/el2/base/haps/entry/files';
  const phone = '/data/storage/el2/base/haps/phone/files';
  const valid = { support: true, effective: true, counts: { sidebar: 1 } };
  const cases = [
    [entry, null, 'fail', false],
    [entry, {}, 'fail', false],
    [entry, declaration, 'fail', false],
    [entry, valid, 'pass', true],
    [entry, { ...valid, support: false, effective: false }, 'pass', true],
    [phone, declaration, 'notapplicable', true],
    [phone, null, 'notapplicable', true],
    [phone, valid, 'notapplicable', true],
    ['/export/files', null, 'unknown', null],
    ['/export/files', valid, 'unknown', null],
    ['/export/files', declaration, 'notapplicable', true],
    ['/export/files', { ...declaration, module: 'other' }, 'unknown', null],
    ['/export/files', { ...declaration, cssSupport: true }, 'unknown', null],
    ['/some/phone/files', null, 'unknown', null]
  ];
  for (const [root, glass, status, ok] of cases) {
    const result = evaluate(root, glass);
    assert.equal(result.status, status);
    assert.equal(result.ok, ok);
    if (status === 'notapplicable') {
      assert.equal(result.effective, false);
      assert.equal(result.cssSupport, null);
    }
  }
  assert(tool.includes('const glassAssessment = evaluateGlass(root, glass);'));
  assert(tool.includes('glassAssessment,'));
  assert(tool.includes('c.ok === false'));
  assert(tool.includes('unknown.length > 0 ? 2 : 0'));
}

check(source, verify);
console.log('PASS production native declaration: once per component, no CSS probe or bridge; 14 module assessment cases');
if (process.argv.includes('--self-test')) {
  const mutations = [
    [source.replace('if (!this.glassCapabilityDeclared)', 'if (true)'), verify],
    [source.replace('this.glassCapabilityDeclared = true;', ''), verify],
    [source.replace('"cssSupport":null', '"cssSupport":true'), verify],
    [source.replace('"effective":false', '"effective":true'), verify],
    [source.replace('phone-shell-no-glass-skin', 'rendered'), verify],
    [source, verify.replace("pathModule || (phoneDeclaration ? 'phone' : 'unknown')", "phoneDeclaration ? 'phone' : pathModule || 'unknown'")],
    [source, verify.replace("status: 'unknown', ok: null", "status: 'pass', ok: true")],
    [source, verify.replace("status: valid ? 'pass' : 'fail'", "status: 'pass'")],
    [source, verify.replace('cssSupport: null, reason:', 'cssSupport: true, reason:')],
    [source, verify.replace('unknown.length > 0 ? 2 : 0', '0')]
  ];
  for (const [shell, tool] of mutations) {
    assert(shell !== source || tool !== verify, 'mutation applied');
    assert.throws(() => check(shell, tool), 'mutation rejected');
  }
  console.log(`PASS self-test: ${mutations.length} production mutations rejected`);
}
