#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('hostcore/app/dshm-update-transaction.cjs', 'utf8');

async function preparationFailure(text, partial) {
  const root = fs.mkdtempSync('/data/storage/el2/base/files/tmp/deveco/review-fault-');
  const profile = path.join(root, 'profile');
  const dest = path.join(profile, 'node_modules/demo');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'old'), 'COMPLETE ORIGINAL');
  fs.writeFileSync(path.join(profile, 'package.json'), '{"dependencies":{"demo":"1"}}');
  let called = false;
  const io = { ...fs, cpSync(a, b) {
    if (a === dest) {
      if (partial) { fs.mkdirSync(b); fs.writeFileSync(path.join(b, 'partial'), 'INCOMPLETE'); }
      throw new Error('ENOSPC_IN_PREPARATION');
    }
    return fs.cpSync(a, b, { recursive: true });
  } };
  const context = { module: { exports: {} }, require: name => name === 'node:fs' ? io : require(name) };
  try {
    vm.runInNewContext(text, context);
    await assert.rejects(() => context.module.exports.withUpdateTransaction(profile, 'demo', '1', '2', async () => { called = true; }), /ENOSPC/);
    assert.equal(called, false);
    assert.equal(fs.readFileSync(path.join(dest, 'old'), 'utf8'), 'COMPLETE ORIGINAL');
    assert.deepEqual(fs.readdirSync(dest), ['old']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function refusal(text) {
  let deletes = 0;
  const io = { existsSync: () => true, readFileSync: p => p.endsWith('package.json') ? '{"dependencies":{"demo":"1"}}' : '',
    mkdtempSync: () => '/profile/owned', cpSync() {}, writeFileSync() {},
    rmSync(p) { if (p === '/profile/node_modules/demo') deletes++; } };
  const context = { module: { exports: {} }, require: name => name === 'node:fs' ? io : require(name) };
  vm.runInNewContext(text, context);
  for (const step of ['check', 'remove']) {
    await context.module.exports.withUpdateTransaction('/profile', 'demo', '1', '2', async () => ({ step, result: { application: 'failed', changed: false } }));
  }
  assert.equal(deletes, 0);
}

async function main() {
  await preparationFailure(source, false);
  await preparationFailure(source, true);
  await refusal(source);
  const installer = fs.readFileSync('hostcore/app/dshm-installer.js', 'utf8');
  const start = installer.indexOf('async function installSpecOwned(spec, opts)');
  const end = installer.indexOf('\nasync function installSpecInner', start);
  const restored = [];
  const io = {
    existsSync: () => true, mkdtempSync: p => p + 'owned', rmSync() {},
    renameSync(a, b) {
      if (a.endsWith('/package')) {
        restored.push(b);
        if (b.endsWith('/first')) throw new Error('RESTORE_RENAME_FAILED');
      }
    }
  };
  const install = vm.runInNewContext(installer.slice(start, end) + '\ninstallSpecOwned', {
    fs: io, path,
    installSpecInner: async (_spec, opts) => {
      opts.preserve('/modules/first'); opts.preserve('/modules/second');
      throw new Error('ORIGINAL_INTEGRITY_ERROR');
    }
  });
  const result = await install('demo', {});
  assert.equal(result.ok, false);
  assert.match(result.error, /ORIGINAL_INTEGRITY_ERROR/);
  assert.match(result.error, /RESTORE_RENAME_FAILED/);
  assert.deepEqual(restored, ['/modules/first', '/modules/second']);
  console.log('R7 actual installSpec original error/restore diagnostics/all backups attempted PASS');
  console.log('R1 first/mid-copy ENOSPC old bytes intact, operation not called: 2/2 PASS');
  console.log('R2 official check/remove unchanged refusal zero package deletes: 2/2 PASS');
  if (process.argv.includes('--self-test')) {
    await assert.rejects(() => preparationFailure(source.replace('if (!prepared || !operationStarted)', 'if (false)'), true));
    await assert.rejects(() => refusal(source.replace("if (result?.step === 'check' || result?.step === 'remove')", 'if (false)')));
    console.log('R1/R2 destructive regression mutations rejected 2/2');
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
