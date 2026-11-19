#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { withUpdateTransaction } = require('../hostcore/app/dshm-update-transaction.cjs');

async function main() {
  const root = fs.mkdtempSync('/data/storage/el2/base/files/tmp/deveco/update-test-');
  let count = 0;
  try {
    for (const stage of ['download', 'integrity', 'placement', 'enable', 'success', 'official-restore']) {
      const profile = path.join(root, stage);
      const dest = path.join(profile, 'node_modules', 'demo');
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'package.json'), '{"name":"demo","version":"1.0.0"}');
      fs.writeFileSync(path.join(dest, 'entry.js'), 'OLD');
      fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dependencies: { demo: '^1.0.0', other: '1' }, dsh: { profile: { bundles: ['demo', 'other'] } } }));
      const result = await withUpdateTransaction(profile, 'demo', '1.0.0', '2.0.0', async () => {
        fs.rmSync(dest, { recursive: true }); // official remove
        const pkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json')));
        delete pkg.dependencies.demo;
        pkg.dependencies.other = '2'; // unrelated user change must survive
        fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify(pkg));
        if (stage === 'enable' || stage === 'success' || stage === 'official-restore') {
          fs.mkdirSync(dest, { recursive: true });
          fs.writeFileSync(path.join(dest, 'entry.js'), stage === 'official-restore' ? 'OFFICIAL OLD' : 'NEW');
          if (stage === 'enable') fs.rmSync(dest, { recursive: true }); // second remove
        }
        return { result: { application: stage === 'success' ? 'applied' : 'failed', stage },
          restore: { application: stage === 'official-restore' ? 'applied' : 'failed' } };
      });
      const expected = stage === 'success' ? 'NEW' : stage === 'official-restore' ? 'OFFICIAL OLD' : 'OLD';
      assert.equal(fs.readFileSync(path.join(dest, 'entry.js'), 'utf8'), expected);
      const after = JSON.parse(fs.readFileSync(path.join(profile, 'package.json')));
      assert.equal(after.dependencies.other, '2');
      if (!['success', 'official-restore'].includes(stage)) {
        assert.equal(after.dependencies.demo, '^1.0.0');
        assert.equal(result.localRestore.application, 'restart-required');
      }
      count++;
    }
    console.log(`D01 local production lifecycle ${count}/6 PASS (remove/new failure/enable-remove/dual-failure/official recovery/success)`);
    if (process.argv.includes('--self-test')) {
      // Mutation executes the same helper with its actual snapshot operation disabled.
      const vm = require('node:vm');
      const source = fs.readFileSync('hostcore/app/dshm-update-transaction.cjs', 'utf8');
      const context = { require, module: { exports: {} } };
      vm.runInNewContext(source.replace('fs.cpSync(dest, backup, { recursive: true, dereference: false });', '/* lost backup */'), context);
      const profile = path.join(root, 'mutant');
      const dest = path.join(profile, 'node_modules/demo');
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'entry.js'), 'OLD');
      fs.writeFileSync(path.join(profile, 'package.json'), '{"dependencies":{"demo":"1"}}');
      await assert.rejects(() => context.module.exports.withUpdateTransaction(profile, 'demo', '1', '2', async () => {
        fs.rmSync(dest, { recursive: true });
        return { result: { application: 'failed' } };
      }));
      console.log('D01 snapshot-loss mutation rejected 1/1');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
