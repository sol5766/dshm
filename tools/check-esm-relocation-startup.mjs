import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
import { runInNewContext } from 'node:vm';

const stageFlag = process.argv.indexOf('--stage');
assert(stageFlag >= 0 && process.argv[stageFlag + 1], 'Use --stage <packed core tree>');
const file = resolve(process.argv[stageFlag + 1], 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');

function extract(source, begin, end) {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start + begin.length);
  assert(start >= 0 && finish > start, 'Missing upstream ESM relocation code');
  return source.slice(start, finish);
}

function verify(source) {
  const movedClass = extract(source, 'var MovedDirectories = class {', '\n/** One mutable pointer');
  const relocateFunction = extract(source, 'const relocate = (result, parent) => {', '\n\t\treturn (request, parent, attributes)');
  const base = resolve('dshm-test-modules');
  const previous = resolve(base, 'previous');
  const current = resolve(base, 'current');
  const external = pathToFileURL(resolve(base, 'importer.mjs')).href;
  const internal = pathToFileURL(resolve(previous, 'importer.mjs')).href;
  const previousFile = pathToFileURL(resolve(previous, 'main.mjs')).href;
  const currentFile = pathToFileURL(resolve(current, 'main.mjs')).href;
  const resolved = { url: previousFile + '?epoch=2#prefix', format: 'module' };
  const builtIn = { url: 'node:fs', format: 'builtin' };
  let conversions = 0;
  const files = new Set([resolve(current, 'main.mjs')]);
  const { relocate, moved } = runInNewContext(
    movedClass + '\nconst moved = new MovedDirectories();\n'
      + 'const router = { moved, relocate: moved.relocate.bind(moved) };\n'
      + relocateFunction + '\n({ relocate, moved });',
    {
      URL, sep, pathToFileURL,
      fileURLToPath(url) {
        conversions++;
        return fileURLToPath(url);
      },
      spellings: directory => [directory + sep],
      existsSync: filename => files.has(filename),
    },
  );

  assert.equal(relocate(resolved, external), resolved);
  assert.equal(conversions, 0, 'An empty live relocation table should require no URL conversion');
  moved.record(previous, current);
  assert.equal(relocate(builtIn, external), builtIn);
  assert.equal(conversions, 0, 'Built-in URLs are never translated');
  assert.equal(relocate(resolved, external).url, currentFile + '?epoch=2#prefix');
  const fromRoot = relocate(resolved, undefined);
  assert.equal(fromRoot.url, currentFile + '?epoch=2#prefix');
  assert.equal(fromRoot.format, resolved.format);
  assert.equal(relocate(resolved, internal), resolved, 'Importers inside the old package retain local files');
  files.clear();
  assert.equal(relocate(resolved, external), resolved, 'A missing replacement keeps native resolution');
  moved.forget([previous]);
  const before = conversions;
  assert.equal(relocate(resolved, external), resolved);
  assert.equal(conversions, before, 'An emptied table should restore the fast path');
}

const source = readFileSync(file, 'utf8');
verify(source);
if (process.argv.includes('--self-test')) {
  for (const replacement of ['', 'true || ']) {
    const changed = source.replace('router.moved.targets.size === 0 || ', replacement);
    assert.notEqual(changed, source);
    assert.throws(() => verify(changed), assert.AssertionError);
  }
}
console.log('PASS ESM relocation fast path and live linked-package moves');
