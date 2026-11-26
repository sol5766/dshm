import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { settingsStartupSource, settingsFile } from './lib/settings-startup.mjs';

const { values } = parseArgs({ options: { stage: { type: 'string' }, 'self-test': { type: 'boolean' } } });
assert(values.stage, 'Use --stage with the packed core working tree');
const patched = readFileSync(join(values.stage, settingsFile), 'utf8');
const upstream = settingsStartupSource(patched, false);
assert.equal(settingsStartupSource(upstream), patched);
assert.equal(settingsStartupSource(patched), patched);
const prefs = { theme: 'light', key: 'test-secret' };
const normalize = value => JSON.parse(JSON.stringify(value));

async function observe(source, mode) {
  const marker = 'var SettingsForms = class';
  const start = source.indexOf('const dshmDescribeForms = Symbol(');
  const settingsSource = source.slice(start < 0 ? source.indexOf(marker) : start, source.indexOf('\n//#endregion\nexport { SettingsConflictError'));
  const notifications = [];
  const phases = [];
  const handlers = new Map();
  let configurationReads = 0;
  let entryReads = 0;
  let validationCalls = 0;
  let migrations = 0;
  let shutdown;
  const ready = Promise.withResolvers();
  const schema = { toJSON: () => ({ type: 'object', keys: ['theme', 'key'] }) };
  const rows = [{ entry: {
    id: 'example',
    options: { id: 'sample', config: { ...prefs } },
    fiber: { uid: 1, runtime: { Config: schema }, state: 2, effectiveConfig: { ...prefs }, ctx: {} },
  }, inherited: { theme: 'system' }, override: { ...prefs } }];
  rows[0].entry.fiber.ctx.fiber = rows[0].entry.fiber;
  const scope = createContext({
    __dshmStartupSettingsRevisions: mode,
    Context: { root: 'root' },
    Service: class { constructor(ctx) { this.ctx = ctx; } },
    queueMicrotask,
    volatileForm: runtime => runtime === schema ? schema : undefined,
    plainConfig: value => ({ ...value }),
    projectForm: (_form, value) => ({ ...value }),
    interpolate: (_ctx, value) => { validationCalls++; return value; },
    inheritedConfig: (_runtime, value) => value,
    redactSecrets: (_form, value) => {
      const { key, ...publicValue } = value;
      return { value: publicValue, secrets: [{ path: ['key'], set: !!key }] };
    },
  });
  const Forms = runInContext(settingsSource + '\nSettingsForms', scope);
  const owner = {
    fiber: { state: 2 },
    root: { loader: { await: () => ready.promise } },
    configEditor: {
      entries() { entryReads++; return rows.map(row => row.entry); },
      configuration() { configurationReads++; return rows; },
    },
    emit: (...event) => notifications.push(event),
    on: (name, callback) => handlers.set(name, callback),
    effect: activate => { shutdown = activate(); },
    logger: { error(error) { throw error; } },
  };
  const instance = new Proxy(new Forms(owner), {});
  instance.importLegacyDocument = async () => { migrations++; };
  const flush = () => new Promise(resolve => queueMicrotask(resolve));
  const capture = () => phases.push([configurationReads, entryReads, validationCalls]);

  const disposePolicy = instance.configure({ auto: false }, rows[0].entry.fiber);
  handlers.get('app-boot/config-reload')();
  await flush();
  capture();
  const description = instance.describe({ redactSecrets: true });
  assert.equal(description[0].value.key, undefined);
  assert.deepEqual(normalize(description[0].secrets), [{ path: ['key'], set: true }]);
  rows[0].entry.options.config.theme = 'dark';
  instance.invalidate();
  disposePolicy();
  await flush();
  capture();
  rows[0].entry.fiber.state = 3;
  instance.invalidate();
  await flush();
  capture();

  delete scope.__dshmStartupSettingsRevisions;
  ready.resolve();
  await flush();
  await flush();
  assert.equal(migrations, 1);
  rows[0].entry.fiber.state = 2;
  instance.invalidate();
  await flush();
  capture();
  const output = instance.describe();
  shutdown();
  instance.invalidate();
  await flush();
  capture();
  return { notifications: normalize(notifications), description: normalize(description), output: normalize(output), phases };
}
const baseline = await observe(upstream, false);
const fallback = await observe(patched, false);
const candidate = await observe(patched, true);
assert.deepEqual(fallback, baseline);
for (const key of ['notifications','description','output']) assert.deepEqual(candidate[key],baseline[key]);
assert.deepEqual(candidate.phases, [[0,1,0],[1,2,1],[1,3,1],[2,3,2],[3,3,3]]);
console.log('PASS pre-settlement events, edit revisions, removal and reactivation, redaction, post-settlement fallback, legacy migration and disposal');

if (values['self-test']) {
  const fullProjection = await observe(patched.replace('__dshmStartupSettingsRevisions === true', '__dshmStartupSettingsRevisions === false'), true);
  assert.notDeepEqual(fullProjection.phases, candidate.phases);
  const changedNotifications = await observe(patched.replace('this.ownerContext.emit("settings/document-updated", entry.options.id, revision);', 'void revision;'), true);
  assert.notDeepEqual(changedNotifications.notifications, baseline.notifications);
  assert.throws(() => settingsStartupSource(upstream.replace('class extends Service', 'class extends OtherService')),
    /Review upstream settings/);
  console.log('PASS mutation tests for projection, notifications and upstream drift');
}