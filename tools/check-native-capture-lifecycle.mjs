import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

const sources = ['entry', 'phone'].map(name => [name,
  readFileSync(new URL(`../${name}/src/main/ets/pages/WebApp.ets`, import.meta.url), 'utf8')]);
const pack = readFileSync(new URL('./pack-core.mjs', import.meta.url), 'utf8');
const pageBeginCancellation = /(\.onPageBegin\(\(\s*(?:[\w$]+\s*:\s*OnPageBeginEvent\s*)?\)\s*=>\s*\{\s*)this\.cancelNativeCapture\(\);/;
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(text) {
  assert.match(text, /aboutToDisappear\(\): void \{\s*this.nativeCaptureDisposed = true;\s*this.cancelNativeCapture\(\);/);
  assert.match(text, pageBeginCancellation, 'a new document must cancel native capture before handling navigation');
  assert.match(text, /,'cancelNativeCapture':/);
  assert.match(text, /methodList: \[[^\n]*'cancelNativeCapture'/);
  const methods = text.slice(text.indexOf('  private nativeCaptureGeneration:'),
    text.indexOf('\n  /**\n   * javaScriptOnDocumentStart', text.indexOf('  private nativeCaptureGeneration:')));
  assert.ok(methods.length > 1000 && methods.length < 18000);
  const reset = methods.slice(methods.indexOf('  private cancelNativeCapture'), methods.indexOf('  private takeNativeCapture'));
  assert.ok(reset.indexOf('++natGeneration') < reset.indexOf('natChunks = []'));
  assert.doesNotMatch(reset, /takeNativeCapture|Base64|natPcmToWav/);
  const globals = text.slice(text.indexOf('let natCap:'), text.indexOf('/** 把裸 PCM'));
  const permissions = [], creations = [];
  let encodes = 0;
  const code = stripTypeScriptTypes(globals + '\nclass Page {\n' + methods + '\n}\n'
    + '({ Page, state: () => ({ natCap, natChunks, natBytes, natPhase, natGeneration }) });');
  const api = runInNewContext(code, {
    audio: { AudioSamplingRate: {}, AudioChannel: {}, AudioSampleFormat: {}, AudioEncodingType: {}, SourceType: {},
      createAudioCapturer() { const d = deferred(); creations.push(d); return d.promise; } },
    Uint8Array, DataView, Date, Math, Promise, JSON, String,
    util: { Base64Helper: class { encodeToStringSync(wav) { encodes++; return Buffer.from(wav).toString('base64'); } } },
    natPcmToWav: pcm => pcm, HMS_SAMPLE_RATE: 16000, DOMAIN: 0, TAG: '',
    hilog: { info() {}, error() {} }, getContext: () => { throw new Error('no diagnostic file'); }
  });
  const page = new api.Page();
  page.dirPickerBridge = { writeDiagMarkerPublic() {} };
  page.ensureMicPermission = () => { const d = deferred(); permissions.push(d); return d.promise; };
  function cap(options = {}) {
    return { starts: 0, stops: 0, releases: 0, callback: undefined,
      on(event, callback) { if (options.onThrows) throw new Error('on'); this.callback = callback; },
      off() { if (options.offThrows) throw new Error('off'); },
      start() { this.starts++; return options.start?.promise ?? Promise.resolve(); },
      stop() { this.stops++; if (options.stopThrows) throw new Error('stop'); return Promise.resolve(); },
      release() { this.releases++; return Promise.resolve(); }
    };
  }
  return { ...api, page, permissions, creations, cap, encodes: () => encodes };
}
async function verify(text) {
  let f = fixture(text);
  const old = f.page.startNativeCapture();
  assert.equal(f.page.startNativeCapture(), old);
  assert.equal(f.permissions.length, 1);
  f.page.cancelNativeCapture(old);
  f.permissions[0].resolve(true);
  await flush();
  assert.equal(f.creations.length, 0, 'late permission must not create');

  f = fixture(text);
  f.page.startNativeCapture();
  f.permissions[0].resolve(true);
  await flush();
  f.page.cancelNativeCapture();
  const stale = f.cap();
  f.creations[0].resolve(stale);
  await flush();
  assert.equal(stale.starts, 0, 'late creation must not start');
  assert.equal(stale.releases, 1);

  f = fixture(text);
  const start = deferred();
  const c = f.cap({ start, offThrows: true, stopThrows: true });
  const first = f.page.startNativeCapture();
  f.permissions[0].resolve(true);
  await flush();
  f.creations[0].resolve(c);
  await flush();
  c.callback(new Uint8Array([1, 2]).buffer);
  assert.equal(f.state().natBytes, 2);
  f.page.cancelNativeCapture(first);
  assert.equal(f.state().natBytes, 0);
  assert.equal(f.state().natChunks.length, 0);
  c.callback(new Uint8Array([1, 2]).buffer);
  assert.equal(f.state().natBytes, 0, 'queued callback must not refill cache');
  const second = f.page.startNativeCapture();
  f.permissions[1].resolve(true);
  await flush();
  assert.equal(f.creations.length, 1, 'new creation waits for old start and release');
  start.resolve();
  await flush();
  assert.equal(c.releases, 1, 'stop failure must still release');
  assert.equal(f.creations.length, 2);
  const next = f.cap();
  f.creations[1].resolve(next);
  await flush();
  f.page.cancelNativeCapture(first);
  assert.equal(f.state().natPhase, 'recording', 'old cancel must not cancel new capture');
  c.callback(new Uint8Array([1, 2]).buffer);
  assert.equal(f.state().natBytes, 0);
  for (let i = 0; i < 4; i++) next.callback(new Uint8Array([1, 2]).buffer);
  assert.equal(f.page.takeNativeCapture(), Buffer.from([1, 2, 1, 2, 1, 2, 1, 2]).toString('base64'));
  assert.equal(f.encodes(), 1);
  assert.equal(f.state().natChunks.length, 0);
  await flush();
  assert.equal(next.releases, 1);
  f.page.startNativeCapture();
  f.permissions[2].resolve(true);
  await flush();
  const bad = f.cap({ onThrows: true });
  f.creations[2].resolve(bad);
  await flush();
  assert.match(f.state().natPhase, /^error:/);
  assert.equal(bad.releases, 1);
  assert.equal(f.encodes(), 1, 'cancel must never encode');
  assert.notEqual(first, second);
  for (let i = 0; i < 3; i++) {
    f.page.startNativeCapture();
    f.permissions.at(-1).resolve(true);
    await flush();
    const repeat = f.cap();
    f.creations.at(-1).resolve(repeat);
    await flush();
    repeat.callback(new Uint8Array([3, 4]).buffer);
    assert.equal(f.page.takeNativeCapture(), Buffer.from([3, 4]).toString('base64'));
    await flush();
    assert.equal(repeat.releases, 1);
  }
  f.page.startNativeCapture();
  f.permissions.at(-1).resolve(false);
  await flush();
  assert.equal(f.state().natPhase, 'error:permission-denied');
  f.page.startNativeCapture();
  f.permissions.at(-1).resolve(true);
  await flush();
  const failedStart = deferred();
  const failed = f.cap({ start: failedStart });
  f.creations.at(-1).resolve(failed);
  await flush();
  failedStart.reject(new Error('start failed'));
  await flush();
  assert.equal(failed.releases, 1);
  assert.equal(f.state().natCap, undefined);
  f.page.startNativeCapture();
  f.permissions.at(-1).resolve(true);
  await flush();
  f.creations.at(-1).reject(new Error('creation failed'));
  await flush();
  assert.match(f.state().natPhase, /^error:/);
  f.page.nativeCaptureDisposed = true;
  assert.equal(f.page.startNativeCapture(), '');
}
function bridgeSource(text) {
  const from = text.indexOf("    '  const origStart = Recording.prototype.start;'");
  const to = text.indexOf("    '})();'", from);
  assert.ok(from >= 0 && to > from);
  return runInNewContext('[' + text.slice(from, to) + '].join("\\n")');
}
async function verifyBridge(text) {
  const code = bridgeSource(text);
  let now = 0;
  const cancels = [];
  class RecordingError extends Error {}
  class Recording {
    constructor() {
      this.lifetime = new AbortController();
      this.listeners = new Set();
      const signal = this.lifetime.signal;
      const add = signal.addEventListener.bind(signal);
      const remove = signal.removeEventListener.bind(signal);
      signal.addEventListener = (type, fn, options) => { this.listeners.add(fn); add(type, fn, options); };
      signal.removeEventListener = (type, fn) => { this.listeners.delete(fn); remove(type, fn); };
    }
    async dispose() { this.lifetime.abort(); }
  }
  const controller = new AbortController();
  const bridge = { startNativeCapture: () => '7', nativeCaptureState: () => '{"phase":"starting"}',
    cancelNativeCapture: generation => cancels.push(generation) };
  runInNewContext(code, { Recording, RecordingError, br: () => bridge,
    Date: { now: () => now }, setTimeout: fn => { now += 50; fn(); },
    atob: value => Buffer.from(value, 'base64').toString('binary'), Uint8Array });
  const recording = new Recording();
  recording.lifetime = { signal: controller.signal };
  await assert.rejects(recording.start(), /unavailable/);
  assert.deepEqual(cancels, ['7'], 'timeout must cancel its own generation');
  now = 0;
  cancels.length = 0;
  bridge.nativeCaptureState = () => { controller.abort(); return '{"phase":"starting"}'; };
  await assert.rejects(recording.start());
  assert.ok(cancels.length > 0);
  for (const action of ['abort', 'dispose']) {
    cancels.length = 0;
    bridge.nativeCaptureState = () => '{"phase":"recording"}';
    const live = new Recording();
    await live.start();
    assert.equal(live.listeners.size, 1, 'successful start retains abort listener');
    assert.equal(cancels.length, 0);
    if (action === 'abort') live.lifetime.abort();
    else await live.dispose();
    assert.deepEqual(cancels, ['7'], `successful start then ${action} must cancel`);
    assert.equal(live.listeners.size, 0, 'abort clears listener closure');
  }
  let sequence = 7;
  let active;
  let takes = 0;
  bridge.startNativeCapture = () => { active = String(++sequence); return active; };
  bridge.cancelNativeCapture = generation => {
    cancels.push(generation);
    if (generation === active) active = undefined;
  };
  bridge.takeNativeCapture = () => { takes++; active = undefined; return 'AQI='; };
  const previous = new Recording();
  await previous.start();
  const latest = new Recording();
  await latest.start();
  assert.equal(previous.listeners.size, 0, 'replacement detaches old listener');
  const latestGeneration = active;
  await previous.dispose();
  assert.equal(active, latestGeneration, 'old dispose cannot cancel new capture');
  await assert.rejects(previous.stop(), /empty/);
  assert.equal(takes, 0, 'old stop cannot take new capture');
  for (let i = 0; i < 3; i++) {
    if (i > 0) await latest.start();
    assert.deepEqual(Array.from(await latest.stop()), [1, 2]);
    assert.equal(latest.listeners.size, 0, 'normal stop detaches listener');
    assert.equal(active, undefined);
  }
  const beforeDispose = cancels.length;
  await latest.dispose();
  assert.equal(cancels.length, beforeDispose, 'dispose after stop retains no cancellation closure');
}
for (const [name, text] of sources) {
  await verify(text);
  console.log(`PASS ${name}: actual capture lifecycle behavior`);
}
await verifyBridge(pack);
console.log('PASS bridge: timeout, successful start abort/dispose, stop cleanup and repeat isolation');
if (process.argv.includes('--self-test')) {
  const mutants = [
    text => text.replaceAll('generation !== natGeneration', 'false'),
    text => text.replace('if (generation !== natGeneration || natCap !== c)', 'if (false)'),
    text => text.replace('++natGeneration;\n    const cap:', 'natGeneration;\n    const cap:'),
    text => text.replace('await cap.release();', 'await Promise.resolve();'),
    text => text.replace(pageBeginCancellation, '$1void 0;'),
    text => text.replace(pageBeginCancellation, '$1if (this.nativeCaptureDisposed) return;\n            this.cancelNativeCapture();'),
  ];
  for (const [name, text] of sources) {
    for (const [i, mutate] of mutants.entries()) {
      const changed = mutate(text);
      assert.notEqual(changed, text, `mutant ${i} must apply`);
      await assert.rejects(verify(changed), undefined, `${name} mutant ${i} escaped`);
    }
  }
  await assert.rejects(verifyBridge(pack.replace("    '      cancel();',", "    '      void 0;',")));
  const bridgeMutants = [
    text => text.replace('if (!started && signal)', 'if (signal)'),
    text => text.replace('finally { session.cancel(); }', 'finally {}'),
    text => text.replace('if (activeCapture) { activeCapture.cancel(); }', 'if (false) { activeCapture.cancel(); }'),
    text => text.replace('if (!session || activeCapture !== session)', 'if (false)'),
  ];
  for (const [i, mutate] of bridgeMutants.entries()) {
    const changed = mutate(pack);
    assert.notEqual(changed, pack);
    await assert.rejects(verifyBridge(changed), undefined, `bridge mutant ${i} escaped`);
  }
  console.log(`PASS self-test: ${sources.length * mutants.length + 1 + bridgeMutants.length} negative controls rejected`);
}
