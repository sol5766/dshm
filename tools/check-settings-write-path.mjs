import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { settingsStartupSource, settingsFile } from './lib/settings-startup.mjs';
import { settingsControllerSource, controllerFile } from './lib/settings-controller.mjs';

const { values } = parseArgs({ options: { stage: { type: 'string' }, 'self-test': { type: 'boolean' } } });
assert(values.stage, 'Use --stage with the packed core working tree');
const patched = readFileSync(join(values.stage, settingsFile), 'utf8');
const upstream = settingsStartupSource(patched, false);
assert.equal(settingsStartupSource(upstream), patched);
assert.equal(settingsStartupSource(patched), patched);
const controllerPatched = readFileSync(join(values.stage, controllerFile), 'utf8');
const controllerUpstream = settingsControllerSource(controllerPatched, false);
assert.equal(settingsControllerSource(controllerUpstream), controllerPatched);
assert.equal(settingsControllerSource(controllerPatched), controllerPatched);

const normalize = value => JSON.parse(JSON.stringify(value));

async function writeFlow(shell) {
  const start = shell.indexOf('const dshmDescribeForms = Symbol(');
  const settingsSource = shell.slice(start < 0 ? shell.indexOf('var SettingsForms = class') : start, shell.indexOf('\n//#endregion\nexport { SettingsConflictError'));
  const notifications = [];
  const handlers = new Map();
  let configurationReads = 0;
  let entryReads = 0;
  let projectionCalls = 0;
  let migrations = 0;
  let shutdown;
  const ready = Promise.withResolvers();
  const schema = { toJSON: () => ({ type: 'object', keys: ['theme', 'key'] }), dict: { theme: {}, key: {} } };
  const rows = [
    { entry: { id: 'e1', options: { id: 'sample', config: { theme: 'light', key: 'k1' } },
      fiber: { uid: 1, runtime: { Config: schema }, state: 2, effectiveConfig: { theme: 'light', key: 'k1' }, ctx: {} } },
      inherited: { theme: 'system' }, override: { theme: 'light', key: 'k1' } },
    { entry: { id: 'e2', options: { id: 'other', config: { theme: 'dark' } },
      fiber: { uid: 2, runtime: { Config: schema }, state: 2, effectiveConfig: { theme: 'dark' }, ctx: {} } },
      inherited: { theme: 'light' }, override: { theme: 'dark' } },
  ];
  rows[0].entry.fiber.ctx.fiber = rows[0].entry.fiber;
  rows[1].entry.fiber.ctx.fiber = rows[1].entry.fiber;
  const scope = createContext({
    __dshmStartupSettingsRevisions: false,
    Context: { root: 'root' },
    Service: class { constructor(ctx) { this.ctx = ctx; } },
    SettingsConflictError: class extends Error {
      constructor(ns, expected, actual) {
        super(`settings conflict on ${ns}: expected revision ${expected}, found ${actual}`);
        this.name = 'SettingsConflictError';
        this.code = 'SETTINGS_CONFLICT';
        this.expected = expected;
        this.actual = actual;
      }
    },
    queueMicrotask,
    volatileForm: runtime => runtime === schema ? schema : undefined,
    plainConfig: value => ({ ...value }),
    projectForm: (_form, value) => { projectionCalls++; return { ...value }; },
    interpolate: (_ctx, value) => value,
    inheritedConfig: (_runtime, value) => value,
    redactSecrets: (_form, value) => {
      const { key, ...publicValue } = value;
      return { value: publicValue, secrets: [{ path: ['key'], set: !!key }] };
    },
    cloneJsonShaped: value => JSON.parse(JSON.stringify(value)),
    mergeLayers: (under, over) => ({ ...under, ...over }),
    isVolatilePath: (_schema, path) => path.length > 0,
    isPlainObject: value => typeof value === 'object' && value !== null && !Array.isArray(value),
    member: (node, key) => node?.[key],
    applyPathOp: (section, op) => ({ ...section, [op.path.join('.')]: op.value }),
  });
  const Forms = runInContext(settingsSource + '\nSettingsForms', scope);
  const owner = {
    fiber: { state: 2 },
    root: { loader: { await: () => ready.promise } },
    configEditor: {
      entries() { entryReads++; return rows.map(row => row.entry); },
      configuration() { configurationReads++; return rows; },
      async edit(entry, callback) {
        const row = rows.find(candidate => candidate.entry.id === entry.id);
        const next = callback(entry.options.config ?? {}, row?.inherited ?? {});
        entry.options.config = next;
        entry.fiber.effectiveConfig = { ...next };
        return next;
      },
    },
    emit: (...event) => notifications.push(event),
    on: (name, callback) => handlers.set(name, callback),
    effect: activate => { shutdown = activate(); },
    logger: { error(error) { throw error; } },
  };
  const instance = new Proxy(new Forms(owner), {});
  instance.importLegacyDocument = async () => { migrations++; };
  const flush = () => new Promise(resolve => queueMicrotask(resolve));
  ready.resolve();
  for (let settle = 0; settle < 12; settle++) await flush();
  assert.equal(migrations, 1, 'boot chain settled before measurement');
  const snap = () => ({ configurationReads, entryReads, projectionCalls });
  const delta = (before, after) => ({
    configuration: after.configurationReads - before.configurationReads,
    entries: after.entryReads - before.entryReads,
    projections: after.projectionCalls - before.projectionCalls,
  });
  let mark = snap();
  instance.describe();
  const baseline = delta(mark, mark = snap());
  await instance.update('sample', { theme: 'dark' });
  const update1 = delta(mark, mark = snap());
  await instance.update('sample', { theme: 'navy' }, 1);
  const update2 = delta(mark, mark = snap());
  let describeNamespaceMetrics = null;
  let namespaceRow = null;
  if (typeof instance.describeNamespace === 'function') {
    namespaceRow = instance.describeNamespace('sample', { redactSecrets: true });
    describeNamespaceMetrics = delta(mark, mark = snap());
  }
  const fullRows = instance.describe({ redactSecrets: true });
  const finalDescribe = delta(mark, mark = snap());
  await assert.rejects(instance.update('sample', { theme: 'x' }, 0), /SETTINGS_CONFLICT|settings conflict/);
  await assert.rejects(instance.update('missing', { theme: 'x' }), /No configurable plugin entry/);
  const fullRow = fullRows.find(row => row.ns === 'sample');
  if (typeof instance.describeNamespace === 'function') {
    assert.deepEqual(normalize(namespaceRow), normalize(fullRow));
    assert.equal(instance.describeNamespace('missing', { redactSecrets: true }), undefined);
  }
  shutdown();
  return {
    notifications: normalize(notifications),
    rows: normalize(fullRows),
    revisions: normalize(Object.fromEntries([...instance.revisions.entries()].map(([id, value]) => [id, value]))),
    baseline, update1, update2, describeNamespaceMetrics, finalDescribe,
  };
}

function check(shell, tool) {
  return (async () => {
    assert(tool.includes('settings.describeNamespace === void 0'));
    assert(tool.includes('? settings.describe({ redactSecrets: true }).find((candidate) => candidate.ns === namespace)'));
    assert(tool.includes(': settings.describeNamespace(namespace, { redactSecrets: true });'));
    assert(!tool.includes('\t\t\tconst descriptor = settings.describe({ redactSecrets: true }).find((candidate) => candidate.ns === namespace);'));
    const flow = await writeFlow(shell);
    const reference = await writeFlow(upstream);
    if (process.env.DSHM_DEBUG_METRICS) {
      console.error('flow:', JSON.stringify({ baseline: flow.baseline, update1: flow.update1, update2: flow.update2, namespace: flow.describeNamespaceMetrics, finalDescribe: flow.finalDescribe }, null, 1));
      console.error('reference:', JSON.stringify({ baseline: reference.baseline, update1: reference.update1, update2: reference.update2, finalDescribe: reference.finalDescribe }, null, 1));
    }
    assert.deepEqual(flow.notifications, reference.notifications);
    assert.deepEqual(flow.rows, reference.rows);
    assert.deepEqual(flow.revisions, reference.revisions);
    assert.equal(flow.update1.configuration, 0);
    assert.equal(flow.update2.configuration, 0);
    assert.equal(flow.update1.projections, 2);
    assert.equal(flow.update2.projections, 2);
    assert.equal(reference.update1.configuration, 2);
    assert.equal(reference.update2.configuration, 2);
    assert.equal(reference.update1.projections, 14);
    assert.equal(reference.update2.projections, 14);
    assert.equal(flow.finalDescribe.projections, 6);
    assert.equal(flow.describeNamespaceMetrics.configuration, 1);
    assert.equal(flow.describeNamespaceMetrics.projections, 3);
    assert.equal(flow.baseline.projections, 6);
  })();
}

await check(patched, controllerPatched);
console.log('PASS settings write path: zero full describes per write, single-entry probe and namespace row, controller guard with fallback');

if (values['self-test']) {
  const mutations = [
    [patched.replace('return { ns: entry.options.id, revision };', 'return { ns: entry.options.id, revision: revision + 1 };'), controllerPatched],
    [patched.replace('if (previous?.raw !== raw || previous.autoGenerate !== autoGenerate) this.ownerContext.emit("settings/document-updated", entry.options.id, revision);\n\t\treturn { ns: entry.options.id, revision };', 'return { ns: entry.options.id, revision };'), controllerPatched],
    [patched.replace('\t\t\tconst descriptor = this[dshmTouchEntry](entry);', '\t\t\tconst descriptor = this.describe().find((row) => row.ns === ns);'), controllerPatched],
    [patched.replace('\t\tthis[dshmTouchEntry](entry);\n\t}\n\tschema(entry) {', '\t\tthis.describe();\n\t}\n\tschema(entry) {'), controllerPatched],
    [patched, controllerPatched.replace(': settings.describeNamespace(namespace, { redactSecrets: true });', ': settings.describe({ redactSecrets: true }).find((candidate) => candidate.ns === namespace);')],
    [patched, controllerPatched.replace('\t\t\t\t? settings.describe({ redactSecrets: true }).find((candidate) => candidate.ns === namespace)\n\t\t\t\t: settings.describeNamespace(namespace, { redactSecrets: true });', '\t\t\t\t: settings.describeNamespace(namespace, { redactSecrets: true });')],
    [patched, controllerPatched.replace('settings.describeNamespace === void 0', 'false === void 0')],
  ];
  for (const [shell, tool] of mutations) {
    assert(shell !== patched || tool !== controllerPatched, 'mutation applied');
    await assert.rejects(() => check(shell, tool));
  }
  assert.throws(() => settingsControllerSource(controllerUpstream.replace('async write(ns, mode, input, expectedRevision)', 'async write(ns, mode, input, rev)')),
    /Review upstream settings controller/);
  console.log(`PASS self-test: ${mutations.length} write-path mutations rejected plus controller drift`);
}
