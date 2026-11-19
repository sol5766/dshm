#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = readFileSync(new URL('../hostruntime/src/main/ets/runtime/HostModules.ets', import.meta.url), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
const context = (name = 'bundle', resourceDir = '/hap/entry/resources', bundleCodeDir = '/code') =>
  ({ applicationInfo: { name }, resourceDir, bundleCodeDir });

function load(text) {
  const calls = [];
  const control = { throwCreate: false };
  const code = text.replace(/^import .*;\n/gm, '').replaceAll('export ', '');
  const api = vm.runInNewContext(stripTypeScriptTypes(code, { mode: 'strip' }) +
    '\n({ resolveHostModulePaths, resolveHostDataDir, DSH_CORE_MODULE_NAME, MAIN_ENTRY_MODULE_NAME })', {
    application: { createModuleContext: (ctx, moduleName) => {
      assert.equal(moduleName, 'hostruntime');
      if (control.throwCreate) throw new Error('CREATE_FAILED');
      return new Promise((resolve, reject) => calls.push({ ctx, resolve, reject }));
    } },
    fs: { accessSync: p => p === '/data/haps/entry/files' }
  });
  return { ...api, calls, control };
}

async function verify(text) {
  const api = load(text);
  const resolve = api.resolveHostModulePaths;
  const hsp = { resourceDir: '/hsp/resources', bundleCodeDir: '/hsp/code' };
  const expected = { resourceDir: hsp.resourceDir, nativeLibsDir: '/hsp/code/libs/arm64', vmDataDir: '/hsp/resources/vm' };
  const check = value => assert.deepEqual({ ...value }, expected);
  const one = resolve(context());
  const two = resolve(context());
  await turn();
  assert.equal(api.calls.length, 1, 'concurrent matching identities must share module creation');
  api.calls[0].resolve(hsp);
  const [first, second] = await Promise.all([one, two]);
  check(first); check(second);
  assert.notEqual(first, second, 'concurrent callers need separate objects');
  for (const value of [first, second]) {
    value.resourceDir = 'mutated'; value.nativeLibsDir = 'mutated'; value.vmDataDir = 'mutated';
  }
  const cached = await resolve(context());
  check(cached);
  cached.resourceDir = 'mutated'; cached.nativeLibsDir = 'mutated'; cached.vmDataDir = 'mutated';
  check(await resolve(context()));
  assert.equal(api.calls.length, 1, 'successful resolution must remain cached');
  hsp.resourceDir = 'changed outside'; hsp.bundleCodeDir = 'changed outside';
  check(await resolve(context()));

  for (const failure of ['reject', 'throw']) {
    const retry = load(text);
    retry.control.throwCreate = failure === 'throw';
    const a = retry.resolveHostModulePaths(context());
    const b = retry.resolveHostModulePaths(context());
    const settled = Promise.allSettled([a, b]);
    await turn();
    if (failure === 'reject') {
      assert.equal(retry.calls.length, 1);
      retry.calls[0].reject(new Error('CREATE_FAILED'));
    }
    for (const result of await settled) {
      assert.equal(result.status, 'rejected');
      assert.match(result.reason.message, /CREATE_FAILED/);
    }
    retry.control.throwCreate = false;
    const next = retry.resolveHostModulePaths(context());
    next.catch(() => {});
    await turn();
    const call = retry.calls.at(-1);
    assert(call, 'failure must permit another creation');
    call.resolve({ resourceDir: '/retry', bundleCodeDir: '/retry-code' });
    assert.equal((await next).resourceDir, '/retry');
  }

  for (const [left, right] of [
    [context('bundle-a'), context('bundle-b')],
    [context('bundle', '/hap/entry/resources'), context('bundle', '/hap/phone/resources')],
    [context('bundle', '/res', '/code-a'), context('bundle', '/res', '/code-b')],
    [context('a|b', 'c', 'd'), context('a', 'b|c', 'd')]
  ]) {
    const isolated = load(text);
    const a = isolated.resolveHostModulePaths(left);
    const b = isolated.resolveHostModulePaths(right);
    await turn();
    assert.equal(isolated.calls.length, 2, 'distinct bundle/module/code identities must stay independent');
    isolated.calls[0].resolve({ resourceDir: '/left', bundleCodeDir: '/left-code' });
    isolated.calls[1].resolve({ resourceDir: '/right', bundleCodeDir: '/right-code' });
    assert.equal((await a).resourceDir, '/left');
    assert.equal((await b).resourceDir, '/right');
    assert.equal((await isolated.resolveHostModulePaths(left)).resourceDir, '/left');
    assert.equal((await isolated.resolveHostModulePaths(right)).resourceDir, '/right');
    assert.equal(isolated.calls.length, 2);
  }

  for (const ctx of [
    {}, context('', '/res', '/code'), context('bundle', '', ''),
    { get applicationInfo() { throw new Error('NO_IDENTITY'); } }
  ]) {
    const uncached = load(text);
    const a = uncached.resolveHostModulePaths(ctx);
    const b = uncached.resolveHostModulePaths(ctx);
    await turn();
    assert.equal(uncached.calls.length, 2, 'missing or inaccessible identity must not cache');
    for (const call of uncached.calls) call.resolve({ resourceDir: '/safe', bundleCodeDir: '/safe-code' });
    await Promise.all([a, b]);
    const c = uncached.resolveHostModulePaths(ctx);
    await turn();
    assert.equal(uncached.calls.length, 3);
    uncached.calls[2].resolve({ resourceDir: '/fresh', bundleCodeDir: '/fresh-code' });
    assert.equal((await c).resourceDir, '/fresh');
  }

  assert.equal(api.DSH_CORE_MODULE_NAME, 'hostruntime');
  assert.equal(api.MAIN_ENTRY_MODULE_NAME, 'entry');
  assert.equal(api.resolveHostDataDir(' /data/haps/pc/files ', true), '/data/haps/entry/files');
  assert.equal(api.resolveHostDataDir('/data/haps/phone/files', false), '/data/haps/phone/files');
  assert.equal(api.resolveHostDataDir('/missing/haps/pc/files', true), '/missing/haps/pc/files');
}

async function boundedVerify(text) {
  let timer;
  try {
    await Promise.race([verify(text), new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('resolver verification timed out')), 2000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

await boundedVerify(source);
console.log('PASS: real resolver concurrency, success cache, retry, identity isolation, defensive copies, data-dir semantics');
if (process.argv.includes('--self-test')) {
  const mutations = [
    ['no inflight sharing', 'if (inflight !== undefined)', 'if (false)'],
    ['no success cache', 'hostModuleResolved.set(key, paths);', ''],
    ['sticky failure', 'hostModuleInflight.delete(key);', ''],
    ['bundle collision', 'JSON.stringify([name, resourceDir, bundleCodeDir])', 'JSON.stringify([resourceDir, bundleCodeDir])'],
    ['module collision', 'JSON.stringify([name, resourceDir, bundleCodeDir])', 'JSON.stringify([name, bundleCodeDir])'],
    ['code collision', 'JSON.stringify([name, resourceDir, bundleCodeDir])', 'JSON.stringify([name, resourceDir])'],
    ['delimiter collision', 'JSON.stringify([name, resourceDir, bundleCodeDir])', "[name, resourceDir, bundleCodeDir].join('|')"],
    ['shared result', 'return copy;', 'return paths;'],
    ['cache missing identity', 'name.length > 0 && (resourceDir.length > 0 || bundleCodeDir.length > 0)', 'true']
  ];
  for (const [name, from, to] of mutations) {
    assert(source.includes(from), 'mutation target missing: ' + name);
    await assert.rejects(() => boundedVerify(source.replace(from, to)), undefined, name);
    console.log('mutation rejected: ' + name);
  }
}
