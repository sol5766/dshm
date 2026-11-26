import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { frontendFile, workbenchEntryHtml, workbenchHtmlFile, workbenchSource } from './lib/workbench-startup.mjs';

const stageFlag = process.argv.indexOf('--stage');
assert(stageFlag >= 0 && process.argv[stageFlag + 1], 'Use --stage <packed core tree>');
const root = resolve(process.argv[stageFlag + 1], 'node_modules/@deepseek-ai');
const file = 'dsh-client-modules/lib/index.js';
const packed = readFileSync(join(root, file), 'utf8');
const baseline = workbenchSource(file, packed, false);
assert.notEqual(packed, baseline);
assert.equal(workbenchSource(file, baseline), packed, 'Verify the workbench patch round trip');
const shell = readFileSync(join(root, frontendFile), 'utf8');
const html = readFileSync(join(root, workbenchHtmlFile), 'utf8');
assert.equal(workbenchSource(frontendFile, shell), shell, 'Patched frontend must be the startup entry');
assert.equal(workbenchEntryHtml(html, shell), html, 'Entry URL must identify the patched frontend bytes');

const mode = shell.match(/const dshmLazyWorkbenchSyntax = [^;]+;/)?.[0];
assert(mode);
const window = {};
window.top = window;
const loopback = { protocol: 'http:', hostname: '127.0.0.1', pathname: '/' };
function defersSyntax(overrides = {}) {
  return runInNewContext(mode + 'dshmLazyWorkbenchSyntax;', {
    __DSHM_TABLET_WORKBENCH_STARTUP__: true,
    window,
    location: loopback,
    document: { querySelector: () => ({ content: '1' }) },
    ...overrides,
  });
}
assert.equal(defersSyntax(), true);
assert.equal(defersSyntax({ __DSHM_TABLET_WORKBENCH_STARTUP__: false }), false);
assert.equal(defersSyntax({ location: { ...loopback, pathname: '/secondary' } }), false);
assert.equal(defersSyntax({ window: { top: window } }), false);
assert.equal(defersSyntax({ document: { querySelector: () => null } }), false);

function prepare(source) {
  const start = source.indexOf('function prepareSource(');
  const end = source.indexOf('/** Stamp a combo', start);
  assert(start >= 0 && end > start);
  const trailers = source.split('\n').filter(line => /^const SOURCE_(URL|MAP)_TRAILER = /.test(line));
  assert.equal(trailers.length, 2);
  return runInNewContext([...trailers, source.slice(start, end), 'prepareSource;'].join('\n'));
}

const original = prepare(baseline);
const samples = [
  '', 'code', '前 😀\n//# sourceMappingURL=client.js.map',
  'code\n//# sourceMappingURL=client.js.map', 'code\r\n//# sourceMappingURL=client.js.map',
  'code\n\n//# sourceMappingURL=client.js.map', 'code\r\n\r\n//# sourceMappingURL=client.js.map',
  'code\n//# sourceMappingURL=client.js.map\n', 'code\n//# sourceMappingURL=custom.map',
  'code\n//# sourceMappingURL=client.js.map\n//# sourceURL=inline.js',
  'code\n//# sourceURL=https://example.test/café\n//# sourceMappingURL=client.js.map',
].map(value => Buffer.from(value));
samples.push(Buffer.from([0xf0, 0x80, 0xff, ...Buffer.from('\n//# sourceMappingURL=client.js.map')]));

function verify(source) {
  assert.equal(workbenchSource(file, source), source, 'Packed workbench is missing the exact combo optimization');
  const fast = prepare(source);
  const compare = (id, fileName, bundle) => {
    const input = { id, fileName, bundle };
    assert.equal(JSON.stringify(fast(input)), JSON.stringify(original(input)), id + '/' + fileName);
  };
  for (const buffer of samples) compare('example', 'client.js', buffer);
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('dsh-')) continue;
    const lib = join(root, entry.name, 'lib');
    let files;
    try {
      files = readdirSync(lib);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const name of files) {
      if (!/^client(?:\.[\w-]+)*\.js$/.test(name)) continue;
      compare(entry.name, name, readFileSync(join(lib, name)));
      count++;
    }
  }
  assert(count > 0, 'Use an actual core with bundled Web plugins');
  return count;
}

const matched = verify(packed);
if (process.argv.includes('--self-test')) {
  assert.throws(() => verify(baseline), assert.AssertionError);
  const broken = packed.replace('source.charCodeAt(end - 1) === 13 ? end - 1 : end', 'end');
  assert.notEqual(broken, packed);
  assert.throws(() => verify(broken));
  const eagerSyntax = shell.replace('if(!dshmLazyWorkbenchSyntax)setTimeout', 'setTimeout');
  assert.notEqual(eagerSyntax, shell);
  assert.throws(() => workbenchSource(frontendFile, eagerSyntax));
  assert.notEqual(workbenchEntryHtml(html, shell + '\n'), html);
}
console.log('PASS: workbench asset version, scoped syntax warmup and equivalent combo source for ' + matched + ' bundled clients');
