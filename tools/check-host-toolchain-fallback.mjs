import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';

const source = fs.readFileSync('hostcore/app/main.js', 'utf8');
async function judge(text) {
  const calls = [];
  const finishes = [];
  const specs = ['bash', 'gh', 'npm', 'pnpm', 'tmux'].map(name => ({ name, root: '/' + name, probe: ['probe'] }));
  const sandbox = {
    path, RES_ROOT: '/resources', TOOLCHAIN_DIR: '/toolchain', EXTRA_TOOLCHAINS: specs,
    extraReady: () => false, needsReextractForSign: () => false,
    fs: { existsSync: () => true, readdirSync: () => ['a.tar.gz', 'b.tar.gz'], appendFileSync: () => {}, renameSync: () => {}, statSync: () => ({ size: 1 }) },
    diag: () => {}, ensureDir: () => {},
    finishToolchainExtraction: (...args) => finishes.push(args),
    tarGz: { extractTarGzFile: async (archive, root, options) => {
      assert.ok(options.yieldEvery <= 64);
      assert.ok(options.maxOutputLength <= 256 * 1024 * 1024);
      calls.push([archive, root]);
      await Promise.resolve();
      return { written: 1, skipped: [] };
    } },
  };
  vm.createContext(sandbox);
  const start = text.indexOf('function toolchainExtraJobs(');
  const end = text.indexOf('function finishToolchainExtraction(', start);
  vm.runInContext(text.slice(start, end), sandbox);
  for (const needPy of [false, true]) {
    calls.length = finishes.length = 0;
    await sandbox.inProcessToolchainFallback('/python.tar.gz', needPy, true, 'EACCES', '/custom');
    assert.equal(calls.length, needPy ? 11 : 10);
    assert.ok(calls.slice(0, 10).every(([a]) => a.startsWith('/custom/toolchain/')));
    assert.deepEqual(finishes[0], needPy ? [true, false, true, true, true] : [false, false, true, true]);
  }
  const finishStart = text.indexOf('function finishToolchainExtraction(');
  const finishEnd = text.indexOf('\n{\n', finishStart);
  const markers = [];
  const finishSandbox = {
    path, RES_ROOT: '/resources', PYTHON_PREFIX: '/python', GIT_ROOT: '/git', TOOLCHAIN_DIR: '/toolchain',
    EXTRA_TOOLCHAINS: specs, TOOLCHAIN_SIGN_MARKER_FILE: 'signed',
    fs: { existsSync: () => false, renameSync: () => {}, rmSync: () => {}, writeFileSync: p => markers.push(p) },
    readArchiveSignMarker: () => 'new', statSize: () => 1, extraReady: () => true,
    finalizeToolchain: () => {}, pythonReady: () => false, gitReady: () => false,
    diag: () => {}, log: () => {},
  };
  vm.createContext(finishSandbox);
  vm.runInContext(text.slice(finishStart, finishEnd), finishSandbox);
  finishSandbox.finishToolchainExtraction(false, false, true, false);
  assert.equal(markers.length, 0);
  finishSandbox.finishToolchainExtraction(false, false, true, true);
  assert.equal(markers.length, 5);
  assert.ok(markers.every(p => p !== '/git/signed' && p !== '/python/signed'));
  calls.length = finishes.length = 0;
  sandbox.tarGz.extractTarGzFile = async () => { throw new Error('corrupt archive'); };
  await sandbox.inProcessToolchainFallback('/python.tar.gz', false, true, 'EACCES', '/custom');
  assert.equal(finishes[0][3], false);
  finishes.length = 0;
  await sandbox.inProcessToolchainFallback('/python.tar.gz', true, true, 'EACCES', '/custom');
  assert.equal(finishes.length, 0);
  sandbox.tarGz.extractTarGzFile = async (archive) => {
    if (archive !== '/python.tar.gz') throw new Error('extras failed');
    return { written: 1, skipped: [] };
  };
  sandbox.finishToolchainExtraction = (...args) => {
    finishes.push(args);
    finishSandbox.finishToolchainExtraction(...args);
  };
  const renames = [];
  finishSandbox.fs.renameSync = (...args) => renames.push(args);
  markers.length = finishes.length = 0;
  await sandbox.inProcessToolchainFallback('/python.tar.gz', true, true, 'EACCES', '/custom');
  assert.ok(renames.some(([from, to]) => from === '/toolchain/py-stage/python' && to === '/python'));
  assert.deepEqual(markers, ['/python/signed']);
  sandbox.tarGz.extractTarGzFile = async () => ({ written: 1, skipped: [] });
  sandbox.fs.renameSync = () => { throw new Error('extras publish denied'); };
  renames.length = markers.length = 0;
  await sandbox.inProcessToolchainFallback('/python.tar.gz', true, true, 'EACCES', '/custom');
  assert.ok(renames.some(([from, to]) => from === '/toolchain/py-stage/python' && to === '/python'));
  assert.deepEqual(markers, ['/python/signed']);

  const writes = new Map();
  let denied = false;
  let compatAttempts = 0;
  const task = {
    path, HOME_DIR: '/files/dsh/home', SANDBOX_HOME: '/files', DSH_BASE: '',
    Date, diag: () => {}, stage: () => {}, setTimeout: () => {},
    titles: new Map(), current: {}, titleOf: () => 'test', scheduleWrite: () => {},
    refreshBalance: async () => {},
    ctx: { on: (name, callback) => { task.event = callback; } },
    fs: {
      constants: { W_OK: 2 }, accessSync: p => assert.equal(p, '/files'),
      lstatSync: () => ({ isSymbolicLink: () => false }),
      readFileSync: () => { throw new Error('ENOENT'); },
      writeFileSync: (p, body) => {
        if (p === '/files/task-state.json') {
          compatAttempts++;
          if (denied) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        }
        assert.ok(path.isAbsolute(p));
        writes.set(p, JSON.parse(body));
      },
    },
  };
  vm.createContext(task);
  const taskStart = text.indexOf("      const taskStateFile = path.join(HOME_DIR, 'task-state.json');");
  const taskEnd = text.indexOf('\n    }', text.indexOf("void refreshBalance('turn-end')", taskStart));
  vm.runInContext(text.slice(taskStart, taskEnd), task);
  let seq = 0;
  for (const kind of ['completed', 'error', 'aborted', 'interrupted']) {
    const turn = seq + 1;
    task.event({ id: 'session' }, { type: 'turn/start', data: { turn } });
    assert.equal(writes.get('/files/dsh/home/task-state.json').active, true);
    task.event({ id: 'session' }, { type: 'turn/end', data: { turn, reason: { kind } } });
    const main = writes.get('/files/dsh/home/task-state.json');
    assert.equal(main.active, false);
    assert.equal(main.state, kind === 'error' ? 'error' : 'done');
    assert.equal(main.seq, ++seq);
    assert.deepEqual(writes.get('/files/task-state.json'), main);
  }
  denied = true;
  const before = compatAttempts;
  for (let i = 0; i < 3; i++) task.event({ id: 'session' }, { type: 'turn/end', data: { turn: seq + i + 1 } });
  assert.equal(compatAttempts, before + 1);
  assert.equal(writes.get('/files/dsh/home/task-state.json').seq, seq + 3);
}

await judge(source);
console.log('PASS production fallback: five roots, Python ready/missing, failures, task success/fail/cancel, EACCES cache');
if (process.argv.includes('--self-test')) {
  const mutations = [
    ['scope', t => t.replace('function toolchainExtraJobs(resRoot = RES_ROOT)', 'function toolchainExtraJobs()')],
    ['git early return', t => t.replace("diag('工具链：git 归档在手持档不做进程内解包（execve 被拒）；git=SKIPPED');", "return;")],
    ['false success', t => t.replaceAll('okCount === jobs.length', 'true')],
    ['relative compat', t => t.replace("path.join(SANDBOX_HOME, 'task-state.json')", "path.join(DSH_BASE, '..', 'task-state.json')")],
    ['retry EACCES', t => t.replace("if (e2 && ['EACCES', 'EPERM', 'EROFS'].includes(e2.code)) compatWritableCache = false;", '')],
    ['cancel left active', t => t.replace("const failed = reasonKind === 'error';", "if (reasonKind === 'aborted') return;\n            const failed = reasonKind === 'error';")],
    ['extras failure blocks Python', t => t.replace('finishToolchainExtraction(true, false, needGit, true, extrasOk)', 'finishToolchainExtraction(true, false, needGit, extrasOk)')],
    ['failed extras marked complete', t => t.replace('!extrasOk || !extraReady(spec)', '!extraReady(spec)')],
  ];
  for (const [name, mutate] of mutations) {
    const changed = mutate(source);
    assert.notEqual(changed, source, name + ' mutation applied');
    await assert.rejects(() => judge(changed), undefined, name + ' must fail');
    console.log('PASS negative control: ' + name);
  }
}

const require = createRequire(import.meta.url);
const tar = require('../hostcore/app/tar-gz.cjs');
const tarSource = fs.readFileSync('hostcore/app/tar-gz.cjs', 'utf8');
async function deadlineJudge(text) {
  for (const phase of ['stat', 'read', 'gunzip', 'write', 'yield']) {
    let clock = 0;
    const fakeFs = {
      promises: {
        stat: async () => { if (phase === 'stat') clock = 20; return { size: 1 }; },
        readFile: async () => { if (phase === 'read') clock = 20; return Buffer.alloc(1); },
      },
    };
    const context = {
      Date: { now: () => clock },
      fs: fakeFs,
      zlib: { gunzip: (data, options, callback) => { if (phase === 'gunzip') clock = 20; callback(null, Buffer.alloc(512)); } },
      walkTar: function* () { yield {}; },
      writeEntry: () => { if (phase === 'write') clock = 20; },
      newStats: () => ({}),
      setImmediate: callback => { if (phase === 'yield') clock = 20; callback(); },
    };
    vm.createContext(context);
    const start = text.indexOf('async function extractTarGzFile(');
    vm.runInContext(text.slice(start, text.indexOf('\nmodule.exports', start)), context);
    await assert.rejects(() => context.extractTarGzFile('archive', 'dest', { timeoutMs: 10, yieldEvery: phase === 'write' ? 64 : 1 }), /timed out/, phase);
  }
}
await deadlineJudge(tarSource);
console.log('PASS deadlines after stat/read/gunzip/final write/final yield');
if (process.argv.includes('--self-test')) {
  const mutants = [
    ['final write deadline', t => t.replace("  if (Date.now() > deadline) throw new Error('Archive extraction timed out');\n  return stats;", '  return stats;')],
    ['all deadline enforcement', t => t.replaceAll("if (Date.now() > deadline) throw new Error('Archive extraction timed out');", '')],
  ];
  for (const [name, mutate] of mutants) {
    const changed = mutate(tarSource);
    assert.notEqual(changed, tarSource);
    await assert.rejects(() => deadlineJudge(changed), undefined, name);
    console.log('PASS negative control: ' + name);
  }
}
async function scanJudge(text) {
  assert.ok(text.includes('async function finalizeToolchain()'));
  assert.ok(text.includes('replica = await readGitCoreSymlinks('));
  let reads = 0;
  let inputSize = 33 * 1024 * 1024;
  let outputLimit = 0;
  const context = {
    fs: { promises: { stat: async () => ({ size: inputSize }), readFile: async () => { reads++; return Buffer.alloc(1); } } },
    zlib: { gunzip: (data, options, callback) => { outputLimit = options.maxOutputLength; callback(null, Buffer.alloc(512)); } },
    tarGz: { walkTar: function* () { yield { type: '2', name: 'usr/libexec/git-core/git-fetch', link: '../../bin/git' }; } },
    setImmediate,
  };
  vm.createContext(context);
  const start = text.indexOf('async function readGitCoreSymlinks(');
  const stop = text.indexOf('\n/**', start);
  assert.ok(start >= 0);
  vm.runInContext(text.slice(start, stop), context);
  assert.equal(await context.readGitCoreSymlinks('archive'), null);
  assert.equal(reads, 0);
  inputSize = 1;
  const result = await context.readGitCoreSymlinks('archive');
  assert.equal(result[0][0], 'git-fetch');
  assert.ok(outputLimit > 0 && outputLimit <= 128 * 1024 * 1024);
}
await scanJudge(source);
console.log('PASS bounded asynchronous git link scan');
{
  const context = { fs, tarGz: tar, zlib: require('node:zlib'), setImmediate };
  vm.createContext(context);
  const start = source.indexOf('async function readGitCoreSymlinks(');
  vm.runInContext(source.slice(start, source.indexOf('\n/**', start)), context);
  const folder = 'hostruntime/src/main/resources/resfile/toolchain/git';
  const files = fs.readdirSync(folder).filter(name => /^git-\d.*\.tar\.gz$/.test(name));
  assert.ok(files.length > 0);
  let links = 0;
  for (const name of files) {
    const result = await context.readGitCoreSymlinks(path.join(folder, name));
    if (result) links += result.length;
  }
  assert.ok(links > 0);
  console.log('PASS bundled git asynchronous link scan: links=' + links);
}
if (process.argv.includes('--self-test')) {
  for (const [name, from, to] of [
    ['git input limit', 'size <= 0 || size > maxInput', 'size <= 0'],
    ['git output limit', 'const maxOutputLength = 128 * 1024 * 1024;', 'const maxOutputLength = undefined;'],
  ]) {
    const changed = source.replace(from, to);
    assert.notEqual(changed, source);
    await assert.rejects(() => scanJudge(changed));
    console.log('PASS negative control: ' + name);
  }
}
const dir = fs.mkdtempSync(path.join(tmpdir(), 'host-fallback-'));
const archive = path.join(dir, 'fixture.tar.gz');
const header = Buffer.alloc(512);
header.write('file');
header.write('00000000001', 124);
header[156] = 48;
const raw = Buffer.concat([header, Buffer.from('x'), Buffer.alloc(511), Buffer.alloc(1024)]);
fs.writeFileSync(archive, gzipSync(raw));
const dest = path.join(dir, 'out');
await tar.extractTarGzFile(archive, dest, { yieldEvery: 1 });
assert.equal(fs.readFileSync(path.join(dest, 'file'), 'utf8'), 'x');
fs.writeFileSync(archive, gzipSync(raw.subarray(0, 600)));
await assert.rejects(() => tar.extractTarGzFile(archive, dest));
assert.equal(fs.readFileSync(path.join(dest, 'file'), 'utf8'), 'x');
fs.writeFileSync(archive, gzipSync(raw));
await assert.rejects(() => tar.extractTarGzFile(archive, dest, { maxOutputLength: 512 }));
const linked = path.join(dir, 'linked');
try {
  fs.symlinkSync(dest, linked);
  await assert.rejects(() => tar.extractTarGzFile(archive, linked), /symlink/);
  console.log('PASS existing output symlink rejected');
} catch (error) {
  if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
  console.log('ENVIRONMENT LIMITED: symlink fixture: ' + error.code);
}
const resource = 'hostruntime/src/main/resources/resfile/toolchain';
for (const name of ['bash', 'gh', 'npm', 'pnpm', 'tmux', 'python']) {
  const folder = path.join(resource, name);
  const files = fs.readdirSync(folder).filter(n => n.endsWith('.tar.gz')).sort();
  assert.ok(files.length > 0);
  let count = 0;
  for (const file of files) {
    const result = await tar.extractTarGzFile(path.join(folder, file), path.join(dir, name), { yieldEvery: 16 });
    count += result.written;
  }
  assert.ok(count > 0, name);
  console.log('PASS bundled archive extraction: ' + name + ' files=' + count);
}
console.log('PASS bounded extraction, truncated failure preserves existing asset; fixtures=' + dir);
