#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync('tools/build-beta.mjs', 'utf8');
function check(s) {
  assert.ok(s.includes("run(BUILD_CLI, ['build', '--product', 'default', '--build-mode', 'debug']"));
  assert.ok(s.includes("run(BUILD_CLI, ['build', 'clean']"));
  assert.ok(!/run\(process\.execPath,\s*\[\s*hvigorw/.test(s));
  assert.ok(s.includes('} finally {\n  restoreAll();'));
  assert.ok(s.includes('readFileSync(path).equals(bytes)'));
  assert.ok(s.includes('refuse') || s.includes('拒绝覆盖'));
  assert.ok(s.includes('verifyBetaProfileAcls();'));
  assert.ok(s.includes("'phone-default-signed.hap'") || s.includes('phone-default-signed.hap'));
}
check(source);
if (process.argv.includes('--self-test')) {
  for (const anchor of ['restoreAll();', 'readFileSync(path).equals(bytes)', "run(BUILD_CLI, ['build', '--product', 'default', '--build-mode', 'debug']", 'verifyBetaProfileAcls();']) {
    assert.throws(() => check(source.replace(anchor, 'BROKEN')));
  }
}
console.log('Beta入口静态契约 PASS；4个负控制（--self-test）；未执行构建或身份切换');
