import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { posix } from 'node:path';
import { parseArgs } from 'node:util';
import { runInNewContext } from 'node:vm';
import { optimizeInstallationScope, originalInstallationScope } from './lib/runtime-scope-startup.mjs';

const { values } = parseArgs({ options: { stage: { type: 'string' }, 'self-test': { type: 'boolean' } } });
assert(values.stage, 'Use --stage with a packed core working tree');
const source = readFileSync(`${values.stage}/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`, 'utf8');
const upstream = originalInstallationScope(source);
const packed = optimizeInstallationScope(upstream);
assert.equal(optimizeInstallationScope(packed), packed);
assert.equal(originalInstallationScope(packed), upstream);

function slice(text, from, to) {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + from.length);
  assert(start >= 0 && end > start, from);
  return text.slice(start, end).trimEnd();
}

async function run(text, enabled = true) {
  const core = '/installed/core';
  const modules = core + '/node_modules';
  const anchor = modules + '/@deepseek-ai/dsh/package.json';
  const alpha = modules + '/alpha';
  const beta = modules + '/beta';
  const betaReal = '/replacement/beta';
  const manifests = new Map([
    [anchor, { name: '@deepseek-ai/dsh', version: '1', dependencies: { alpha: '1', beta: '1', fs: '*' } }],
    [alpha + '/package.json', { name: 'alpha', version: '1', dependencies: { gamma: '1', late: '1' } }],
    [betaReal + '/package.json', { name: 'beta', version: '1', dependencies: { external: '1' } }],
    [alpha + '/node_modules/gamma/package.json', { name: 'gamma', version: '1' }],
    ['/outside/node_modules/external/package.json', { name: 'external', version: '1' }],
    [modules + '/fs/package.json', { name: 'fs', version: '1' }],
  ]);
  const real = path => path === beta ? betaReal : path;
  real.native = real;
  let lookups = 0;
  const createRequire = path => {
    lookups++;
    return { resolve: { paths: name => isBuiltin(name) ? null :
      [posix.dirname(path) + '/node_modules', modules, '/outside/node_modules'] } };
  };
  function existsSync(path) {
    const candidate = path === beta + '/package.json' ? betaReal + '/package.json' : path;
    return manifests.has(candidate) || [...manifests.keys()].some(key => key.startsWith(candidate + '/'));
  }
  const textParts = [
    slice(text, 'function readPackageManifest(', '/** Synthetic profiles'),
    slice(text, 'function packageDirFromAnchor(', '\n/**'),
    slice(text, 'function canonicalPath(', 'function computeProfileLayer('),
    '({ createRuntimeResolution, compileResolution })',
  ];
  const { createRuntimeResolution, compileResolution } = runInNewContext(textParts.join('\n'), {
    ...posix, process: { pkg: {}, env: {
      DSHM_PLATFORM: 'ohos', DSHM_CORE_DIR: core, DSHM_INSTALLATION_MANIFEST_PATH_FAST: enabled ? '1' : '0'
    } },
    PROFILES_DIR: 'profiles', isPackagedExecutable: () => true, realModuleDirectory: real, realpathSync: real,
    createRequire, isBuiltin, existsSync, readOptionalProfileManifest: () => undefined,
    readFileSync(path) {
      assert(manifests.has(path), path);
      return JSON.stringify(manifests.get(path));
    },
  });
  async function resolution() {
    const live = await createRuntimeResolution({ installAnchor: anchor, home: '/home' });
    const table = compileResolution(live);
    return [...table.entries.values()].map(row => [row.name, row.packageDir, row.realDir, row.declarer]);
  }
  const first = await resolution();
  assert(!first.some(([name]) => name === 'fs'));
  assert(first.some(([name, , realDir]) => name === 'beta' && realDir === betaReal));
  manifests.set(alpha + '/node_modules/late/package.json', { name: 'late', version: '1' });
  const second = await resolution();
  assert(second.some(([name]) => name === 'late'));
  return { first, second, lookups };
}
const baseline = await run(upstream);
const candidate = await run(packed);
assert.deepEqual(candidate.first, baseline.first);
assert.deepEqual(candidate.second, baseline.second);
assert(candidate.lookups < baseline.lookups);
assert.deepEqual(await run(packed, false), baseline);
console.log(`PASS installation lookups ${baseline.lookups} → ${candidate.lookups}, nested providers, aliases and fresh resolution`);
if (values['self-test']) {
  for (const [before, after] of [
    ['&& !isBuiltin(dep)', ''],
    ['dshmVerifiedInstallationRows.has(entry)', 'entry.scope === "installation"'],
  ]) {
    assert(packed.includes(before));
    await assert.rejects(() => run(packed.replace(before, after)));
  }
  console.log('PASS mutation tests for built-ins and canonical alias fallback');
}
