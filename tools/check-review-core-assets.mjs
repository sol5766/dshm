#!/usr/bin/env node
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
const coreVersion = JSON.parse(fs.readFileSync('hostcore/core-recipe.json', 'utf8')).coreVersion;
const base = process.cwd() + `/dist/core/work/dsh-core-${coreVersion}/node_modules/`;
function load(file, result, deps) {
  const text = fs.readFileSync(file, 'utf8').replace(/^import[\s\S]*?from '[^']+';\n/gm, '').replaceAll('export ', '');
  return vm.runInNewContext(stripTypeScriptTypes(text, { mode: 'strip' }) + '\n' + result, deps);
}
const core = 'hostruntime/src/main/ets/core/BundledCore.ets';
for (const stamp of ['', '3', 'broken', 'sha256:' + 'b'.repeat(64)]) {
  for (const failure of ['', 'stage', 'commit']) {
    const files = new Map([['/res/core.zip', 'NEW ARCHIVE'], ['/cores/v', 'OLD TREE'], ['/home/profile', 'USER DATA'], ['/cores/v/.dshm-bundled-stamp', stamp]]);
    let stages = 0;
    const io = {
      OpenMode: {}, accessSync: p => p === '/res' || files.has(p), listFileSync: () => ['core.zip'],
      statSync: p => ({ size: files.get(p)?.length || 0 }), readTextSync: p => files.get(p),
      copyFile: async (a, b) => files.set(b, files.get(a)),
      unlinkSync: p => files.delete(p), renameSync: (a, b) => { assert(files.has(a)); files.set(b, files.get(a)); files.delete(a); },
      openSync: p => ({ fd: p }), writeSync: (p, s) => files.set(p, s), closeSync() {},
      rmdir: async p => { files.delete(p); }
    };
    const store = {
      baseDir: () => '/',
      ensureLayout: () => ({ ok: true }), listInstalled: () => ['v'], coreDir: () => '/cores/v',
      treeInfoPath: () => '/cores/info', readTreeInfo: () => ({ builtAt: 'OLD' }),
      stage: async () => { stages++; return { ok: failure !== 'stage', message: 'STAGE_FAILED' }; },
      commitStaged: async () => { if (failure === 'commit') return { ok: false, message: 'COMMIT_FAILED' }; files.set('/cores/v', 'NEW TREE'); return { ok: true }; }
    };
    const install = load(core, 'installBundledCores', {
      fs: io, parseArchiveName: () => 'v', sha256OfFile: async () => 'a'.repeat(64),
      hilog: { info() {}, warn() {}, error() {} }
    });
    const result = await install('/res', '/work', store);
    assert.equal(stages, 1);
    assert.equal(files.get('/home/profile'), 'USER DATA');
    assert.equal(files.get('/cores/v'), failure ? 'OLD TREE' : 'NEW TREE');
    assert.equal(result.installed.length, failure ? 0 : 1);
  }
}
console.log('FR1 complete installBundledCores legacy/missing/bad/different-content × success/stage/commit failure: 12/12 PASS (CoreStore boundary injected)');

const cordis = await import(pathToFileURL(base + '@deepseek-ai/cordis/lib/index.js').href);
const Context = cordis.Context || cordis.default;
const ctx = new Context();
let cleaned = false;
ctx.effect(() => () => { throw new Error('EXPECTED_DISPOSE_FAILURE'); });
ctx.effect(() => () => { cleaned = true; });
if (typeof ctx.dispose === 'function') await ctx.dispose();
else if (ctx.fiber?.dispose) { await ctx.fiber.dispose(); await ctx.fiber.inertia; }
else throw new Error('Actual Cordis dispose API unavailable');
assert.equal(cleaned, true);
console.log('CR2 actual installed Cordis dispose exception isolation PASS');
