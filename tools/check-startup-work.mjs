import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const production = require('../hostcore/app/startup-work.cjs');
const main = readFileSync(new URL('../hostcore/app/main.js', import.meta.url), 'utf8');
const source = readFileSync(new URL('../hostcore/app/startup-work.cjs', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

export async function verifyStartupWork(text = main, implementation = production) {
  const calls = [];
  const timers = new Set();
  const errors = [];
  let stdlib = false;
  const work = implementation.create({
    onError: (error) => errors.push(String(error)),
    setTimer: (run, delay) => {
      assert.equal(delay, 3000);
      const timer = { run, delay };
      timers.add(timer);
      return timer;
    },
    clearTimer: (timer) => timers.delete(timer),
  });
  const context = vm.createContext({
    startupWork: work,
    ensureExecutables: () => calls.push('exec'),
    ensurePythonBridge: () => calls.push('python'),
    pythonReady: () => stdlib,
    writeToolchainSelfTest: () => calls.push('toolchain'),
    writeEnvProbe: () => calls.push('runtime'),
  });
  const requests = text.split('\n').filter((line) => /^\s*startupWork\.request\(/.test(line));
  assert.equal(requests.length, 6);
  const boot = text.slice(text.indexOf('  scheduleToolchainExtraction(resRoot, binDir, true);'), text.indexOf('\n/**', text.indexOf('  scheduleToolchainExtraction(resRoot, binDir, true);')));
  const finish = text.slice(text.indexOf('  finalizeToolchain();\n  const pyOk'), text.indexOf('\n{\n', text.indexOf('  finalizeToolchain();\n  const pyOk')));
  assert.match(boot, /startupWork\.request\('exec', ensureExecutables\)/);
  assert.match(boot, /startupWork\.request\('python', ensurePythonBridge, pythonReady\)/);
  assert.match(finish, /if \(pyOk\) \{\s*startupWork\.request\('exec', ensureExecutables\)/);
  assert.match(finish, /if \(pyOk\) \{\s*startupWork\.request\('python', ensurePythonBridge, pythonReady\)/);
  const code = text.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n');
  assert.equal((code.match(/\bensureExecutables\(/g) || []).length, 1);
  assert.equal((code.match(/\bensurePythonBridge\(/g) || []).length, 1);
  assert.equal((code.match(/\bwriteToolchainSelfTest\(/g) || []).length, 1);
  assert.equal((code.match(/\bwriteEnvProbe\(/g) || []).length, 1);
  const ready = text.indexOf('  startupWork.markReady();');
  assert(ready > text.indexOf('const result = await profileBoot.runProfile('));
  assert(ready > text.indexOf('  registerPythonHttpBridge(ctx);'));
  assert(ready > text.indexOf("  console.log('DSHM_READY '"));
  assert.match(text, /stopRequested = true;\s*startupWork\.stop\(\);/);
  assert.match(text, /const ready = await bridge.status\(\);\s*if \(startupWork.stopped \|\| !pyBridgeSelftestActive\) return;/);
  assert.match(text, /res\.once\('finish',/);
  assert.match(text, /includes\('remote.mux'\)\) startupWork\.activity\(\)/);
  assert.match(text, /runtimeFacts\(\);\s*globalThis\.__dshmUpdateTransaction/);
  vm.runInContext(requests.join('\n'), context);
  await flush();
  assert.deepEqual(calls, []);
  assert.equal(timers.size, 0);
  stdlib = true;
  vm.runInContext(requests.join('\n'), context);
  await flush();
  assert.deepEqual(calls, []);
  work.markReady();
  work.markReady();
  assert.equal(timers.size, 1);
  assert.deepEqual(calls, []);
  for (const timer of timers) timer.run();
  timers.clear();
  await flush();
  assert.deepEqual([...calls].sort(), ['exec', 'python', 'runtime', 'toolchain']);
  vm.runInContext(requests.join('\n'), context);
  work.markReady();
  await flush();
  assert.equal(calls.length, 4);
  assert.equal(timers.size, 0);
  work.request('failure', () => { throw new Error('expected'); });
  work.request('rejection', async () => { throw new Error('expected async'); });
  work.request('after-failure', () => calls.push('survived'));
  await flush();
  assert.equal(errors.length, 2);
  assert.equal(calls.at(-1), 'survived');
  work.stop();
  work.request('late', () => calls.push('late'));
  work.markReady();
  await flush();
  assert(!calls.includes('late'));

  let fire;
  let latePython = 0;
  let available = false;
  const late = implementation.create({ setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => {} });
  late.request('python', () => latePython++, () => available);
  late.markReady();
  fire();
  await flush();
  assert.equal(latePython, 0);
  available = true;
  late.request('python', () => latePython++, () => available);
  await flush();
  assert.equal(latePython, 1);
  late.request('python', () => latePython++);
  assert.equal(latePython, 1);

  let cancelled = 0;
  let ran = 0;
  const stopped = implementation.create({ setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => cancelled++ });
  stopped.request('task', () => ran++);
  stopped.markReady();
  stopped.stop();
  fire();
  stopped.markReady();
  stopped.request('task2', () => ran++);
  await flush();
  assert.equal(cancelled, 1);
  assert.equal(ran, 0);

  let release;
  let following = 0;
  const inFlight = implementation.create({ setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => {} });
  inFlight.request('active', () => new Promise((resolve) => { release = resolve; }));
  inFlight.request('following', () => following++);
  inFlight.markReady();
  fire();
  await flush();
  inFlight.stop();
  release();
  await flush();
  assert.equal(following, 0);

  const activityTimers = new Set();
  let activityRuns = 0;
  const activityWork = implementation.create({
    setTimer: (run, delay) => { const item = { run, delay }; activityTimers.add(item); return item; },
    clearTimer: (item) => activityTimers.delete(item),
  });
  activityWork.request('python', () => activityRuns++);
  activityWork.request('other', () => activityRuns++);
  activityWork.activity();
  assert.equal(activityTimers.size, 0);
  activityWork.markReady();
  activityWork.activity();
  assert.deepEqual([...activityTimers].map((item) => item.delay), [1000]);
  const firstQuiet = [...activityTimers].find((item) => item.delay === 1000);
  activityWork.activity();
  assert(!activityTimers.has(firstQuiet));
  activityWork.discard('python');
  [...activityTimers].find((item) => item.delay === 1000).run();
  await flush();
  assert.equal(activityRuns, 1);
  assert.equal(activityTimers.size, 0);
  activityWork.stop();

  const stopTimers = new Set();
  const quietStop = implementation.create({
    setTimer: (run) => { stopTimers.add(run); return run; },
    clearTimer: (run) => stopTimers.delete(run),
  });
  quietStop.markReady();
  quietStop.activity();
  quietStop.stop();
  assert.equal(stopTimers.size, 0);

  let now = 0;
  const clockTimers = new Set();
  let clockRuns = 0;
  let completeTask;
  const clockWork = implementation.create({
    setTimer: (run, delay) => { const item = { run, at: now + delay }; clockTimers.add(item); return item; },
    clearTimer: (item) => clockTimers.delete(item),
  });
  const advance = async (target) => {
    while (true) {
      const next = [...clockTimers].filter((item) => item.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      clockTimers.delete(next);
      next.run();
      await flush();
    }
    now = target;
  };
  clockWork.request('first', () => { clockRuns++; return new Promise((resolve) => { completeTask = resolve; }); });
  clockWork.request('second', () => clockRuns++);
  clockWork.markReady();
  for (const time of [500, 1300, 2100, 2900]) {
    await advance(time);
    clockWork.activity();
  }
  await advance(3000);
  assert.equal(clockRuns, 0);
  await advance(3899);
  assert.equal(clockRuns, 0);
  await advance(3900);
  assert.equal(clockRuns, 1);
  clockWork.activity();
  completeTask();
  await flush();
  assert.equal(clockRuns, 1);
  await advance(4899);
  assert.equal(clockRuns, 1);
  await advance(4900);
  assert.equal(clockRuns, 2);
  assert.equal(clockTimers.size, 0);
  clockWork.stop();

  const selftestStart = text.indexOf('async function pyBridgeSelftestAsync()');
  const selftestBody = text.slice(selftestStart, text.indexOf('\n}\n', selftestStart) + 2);
  for (const outcome of ['stopped', 'preempted', 'cancelled', 'stopped-rejection', 'preempted-rejection', 'failed', 'error', 'success']) {
    const probes = [];
    let finishRun;
    let rejectRun;
    const selftestContext = vm.createContext({
      startupWork: { stopped: false },
      pyBridgeSelftestActive: true,
      getPyWorkerBridge: () => ({
        status: async () => ({ bridge: true, ready: true, initialized: true }),
        run: () => new Promise((resolve, reject) => { finishRun = resolve; rejectRun = reject; }),
      }),
      diag: () => {},
      log: () => {},
      recordRuntimeProbe: (key, probe) => probes.push(probe),
    });
    vm.runInContext(selftestBody, selftestContext);
    const runningSelftest = vm.runInContext('pyBridgeSelftestAsync()', selftestContext);
    await flush();
    if (outcome.startsWith('stopped')) vm.runInContext('startupWork.stopped = true', selftestContext);
    if (outcome.startsWith('preempted')) vm.runInContext('pyBridgeSelftestActive = false', selftestContext);
    if (outcome.endsWith('rejection') || outcome === 'error') rejectRun(new Error('worker rejected'));
    else finishRun({ ok: outcome === 'success', stdout: outcome === 'success' ? '2' : '', cancelled: outcome === 'cancelled' });
    await runningSelftest;
    if (outcome === 'failed' || outcome === 'success' || outcome === 'error') {
      assert.equal(probes.length, 1);
      assert.equal(probes[0].selftest, outcome === 'failed' ? 'fail' : (outcome === 'error' ? 'error' : 'ok'));
    } else assert.equal(probes.length, 0);
  }

  const pyRun = text.slice(text.indexOf('async function pyBridgeRun('), text.indexOf('\nfunction ', text.indexOf('async function pyBridgeRun(')));
  let userRuns = 0;
  const pyContext = vm.createContext({
    pythonReady: () => true,
    pyBridgeInlineEnabled: () => false,
    pyBridgeArtifacts: () => ({}),
    getPyWorkerBridge: () => ({ run: async () => { userRuns++; return { ok: true, stdout: '2' }; } }),
    pyBridgePrelude: () => '',
    processVmHwmKb: () => 0,
    diag: () => {},
    process,
    startupWork: implementation.create(),
    pyBridgeSelftestActive: true,
    pyWorkerBridge: { cancel: () => { calls.push('preempt-selftest'); } },
  });
  vm.runInContext(pyRun, pyContext);
  const result = await vm.runInContext('pyBridgeRun("print(1+1)", 1)', pyContext);
  assert.equal(userRuns, 1);
  assert.equal(result.ok, true);
  assert(calls.includes('preempt-selftest'));
  assert.equal(vm.runInContext('pyBridgeSelftestActive', pyContext), false);
  return { preReadyDiagnostics: 0, readyDelayMs: 3000, uniqueDiagnostics: 4, lateStdlibSelftests: latePython, userRuns };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await verifyStartupWork()));
  if (process.argv.includes('--self-test')) {
    const mutants = [
      source.replace('      idle = false;', ''),
      source.replace('if (task.done) continue;', ''),
      source.replace('if (!task.available()) continue;', ''),
      source.replace('if (stopped || !idle) break;', 'if (stopped) break;'),
      source.replace('stopped = true;', 'stopped = false;'),
      source.replace('setTimer(begin, 3000)', 'setTimer(begin, 30000)'),
      source.replace('idle = false;\n      if (timer !== null) clearTimer(timer);', 'idle = false;'),
    ];
    for (const mutant of mutants) {
      const sandbox = { module: { exports: {} }, setTimeout, clearTimeout };
      vm.runInNewContext(mutant, sandbox);
      await assert.rejects(() => verifyStartupWork(main, sandbox.module.exports), `scheduler mutant ${mutants.indexOf(mutant) + 1}`);
    }
    for (const mutant of [
      main.replace('    if (startupWork.stopped || !pyBridgeSelftestActive || r.cancelled) return;', ''),
      main.replace("startupWork.request('python', ensurePythonBridge, pythonReady);", 'ensurePythonBridge();'),
      main.replace('    startupWork.stop();', ''),
    ]) await assert.rejects(() => verifyStartupWork(mutant));
    console.log(`self-test: ${mutants.length + 3} mutants rejected`);
  }
  const started = performance.now();
  let ranAt = null;
  const measured = production.create();
  measured.request('measurement', () => { ranAt = performance.now(); });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(ranAt, null);
  const readyAt = performance.now();
  measured.markReady();
  await new Promise((resolve) => setTimeout(resolve, 3050));
  assert.notEqual(ranAt, null);
  assert(ranAt - readyAt >= 2950);
  measured.stop();
  console.log(JSON.stringify({ productionTimers: true, preReadyObservationMs: Math.round(readyAt - started), firstDiagnosticAfterReadyMs: Math.round(ranAt - readyAt) }));
  let activityAt = null;
  const active = production.create();
  active.request('measurement', () => { activityAt = performance.now(); });
  active.markReady();
  const activityReadyAt = performance.now();
  for (const time of [500, 1300, 2100, 2900]) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, activityReadyAt + time - performance.now())));
    active.activity();
  }
  const responseFinishedAt = performance.now();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(activityAt, null);
  assert(performance.now() - activityReadyAt >= 3000);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.notEqual(activityAt, null);
  active.stop();
  console.log(JSON.stringify({ continuousActivityAt2900Ms: true, noDiagnosticAt3000Ms: true, firstDiagnosticAfterLastActivityMs: Math.round(activityAt - responseFinishedAt), noActivityFallbackIsNotIdleEvidence: true }));
}
