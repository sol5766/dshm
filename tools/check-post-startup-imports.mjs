import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { postStartupImportSource } from './lib/post-startup-imports.mjs';
import { postStartupReportersSource } from './lib/profile-plugin-startup.mjs';

const stageIndex = process.argv.indexOf('--stage');
const stage = stageIndex < 0 ? '' : process.argv[stageIndex + 1];
if (!stage) throw new Error('Usage: node --jitless tools/check-post-startup-imports.mjs --stage <core-tree> [--self-test]');
const paths = [
  'dsh-tool-cordis/lib/types/providers.js',
  'dsh-tool-web/lib/index.js',
  'dsh-session-log-export/lib/index.js',
  'dsh-util-time/lib/index.js',
  'dsh-schedule/lib/index.js',
];
const urls = paths.map(relative => pathToFileURL(realpathSync(join(stage, 'node_modules', '@deepseek-ai', relative))));
for (const [index, relative] of paths.entries()) {
  const text = readFileSync(urls[index], 'utf8');
  assert.equal(postStartupImportSource(relative, text), text, 'Startup import patch must already be applied');
  if (process.argv.includes('--self-test')) {
    const anchors = ['import("./api-catalog.js")', 'requireConverter("turndown")', 'await import("fflate")', 'requireCalendar("rrule")', 'calendarTemporal().PlainTime'];
    const eager = ['apiCatalog', 'TurndownService', 'zipModule', 'rrulePackage', 'Temporal.PlainTime'];
    assert(text.includes(anchors[index]));
    const changed = text.replace(anchors[index], () => eager[index]);
    assert.throws(() => postStartupImportSource(relative, changed), /Review upstream import/);
  }
}

const otelRoot = join(stage, 'node_modules', '@deepseek-ai', 'dsh-otel', 'lib');
const otelUrl = pathToFileURL(realpathSync(join(otelRoot, 'index.js')));
const otelEntry = readFileSync(otelUrl, 'utf8');
const reporters = readFileSync(join(otelRoot, 'dshm-reporters.js'), 'utf8');
assert.deepEqual(postStartupReportersSource(otelEntry, reporters), { entry: otelEntry, reporters });
if (process.argv.includes('--self-test')) {
  assert.throws(() => postStartupReportersSource(otelEntry, undefined), /Review upstream OTel/);
  assert.throws(() => postStartupReportersSource(otelEntry, reporters + '\n'), /Review upstream OTel/);
  const eager = 'import "./dshm-reporters.js";\n' + otelEntry;
  assert.throws(() => postStartupReportersSource(eager, reporters), /Review upstream OTel/);
}

const modules = new Set();
const track = [
  ['/api-catalog.js', 'catalog'],
  ['/turndown/', 'html'],
  ['/@mixmark-io/domino/', 'dom'],
  ['/fflate/', 'zip'],
  ['/@js-temporal/polyfill/', 'temporal'],
  ['/rrule/', 'rrule'],
  ['/dsh-otel/lib/dshm-reporters.js', 'reporters'],
  ['/@opentelemetry/', 'otel'],
];
const hook = registerHooks({ load(url, context, next) {
  const dependency = track.find(([part]) => url.includes(part));
  if (dependency) modules.add(dependency[1]);
  return next(url, context);
} });
try {
  const [cordis, web, zip, calendar, schedule] = await Promise.all(urls.map(url => import(url.href)));
  assert.deepEqual([...modules], []);

  const providers = cordis.hostInspectProviders({ tools: { schemas: () => [{ name: 'fixture' }] } });
  assert.deepEqual(providers.map(provider => provider.manifest.id), ['Service', 'Event', 'Config', 'Runtime', 'Tool']);
  assert.deepEqual(await providers[4].query('listTools', {}, { agent: 'fixture' }), { tools: [{ name: 'fixture' }] });
  assert.deepEqual([...modules], []);
  const [service, events] = await Promise.all([
    providers[0].query('listService', {}),
    providers[1].query('listEvents', {}),
  ]);
  assert.equal(service.mode, 'catalog');
  assert(service.services.length >= 10 && service.services.every(entry => typeof entry.key === 'string'));
  assert.equal(events.mode, 'catalog');
  assert(events.events.length >= 10 && events.events.every(entry => !entry.name.startsWith('cordis/')));
  await assert.rejects(providers[0].query('listService', { service: 'missing-gate-fixture' }), /no catalogued Service/);
  assert.deepEqual([...modules], ['catalog']);

  const result = (kind, content) => ({
    url: 'https://example.org/',
    statusCode: 200,
    body: { kind, content },
    truncated: false,
  });
  assert.match(web.formatFetchOutput(result('text', 'literal <markup>'), 1000), /literal <markup>/);
  assert.deepEqual([...modules], ['catalog']);
  const converted = web.formatFetchOutput(result('html', '<h1>A heading</h1><p><b>bold</b></p>'), 1000);
  assert.match(converted, /A heading/);
  assert.match(converted, /\*\*bold\*\*/);
  assert(modules.has('html'));
  assert(modules.has('dom'));
  assert(!modules.has('zip'));

  const payload = '{"kind":"fixture"}\n';
  const abort = new AbortController();
  const interrupted = zip.streamSessionLogZip({}, payload, 'startup-fixture', false, 6, abort.signal);
  abort.abort(new Error('export aborted'));
  await assert.rejects(new Response(interrupted).arrayBuffer(), /export aborted/);
  const stream = zip.streamSessionLogZip({}, payload, 'startup-fixture', false, 6, new AbortController().signal);
  const archive = new Uint8Array(await new Response(stream).arrayBuffer());
  assert(modules.has('zip'));
  const entries = createRequire(urls[2])('fflate').unzipSync(archive);
  assert.deepEqual(Object.keys(entries), [zip.SESSION_LOG_FILENAME]);
  assert.equal(new TextDecoder().decode(entries[zip.SESSION_LOG_FILENAME]), payload);
  assert(!modules.has('temporal') && !modules.has('rrule'));
  const gap = calendar.parseLocalCalendar('2026-03-08', '02:30:00');
  assert.equal(calendar.resolveLocalInstant(gap.time, 'America/New_York'), undefined);
  assert(modules.has('temporal'));
  assert(!modules.has('rrule'));
  const overlap = calendar.parseLocalCalendar('2026-11-01', '01:30:00');
  assert.equal(calendar.resolveLocalInstant(overlap.time, 'America/New_York'), Date.parse('2026-11-01T05:30:00Z'));
  const recurrence = calendar.RRule.parse('DTSTART:20261102T090000Z\nRRULE:FREQ=WEEKLY;COUNT=3');
  assert.equal(recurrence.kind, 'accepted');
  assert.equal(recurrence.rule.next(Date.parse('2026-11-02T09:00:00Z')), '2026-11-09T09:00:00.000Z');
  assert.equal(recurrence.rule.next(Date.parse('2026-11-16T09:00:00Z')), undefined);
  assert(modules.has('rrule'));

  const weekly = schedule.createWeeklyScheduleRecord('fixture', 'reminder',
    { time: '02:30:00', time_zone: 'America/New_York', weekdays: [7] },
    Date.parse('2026-03-07T12:00:00Z'), 'test');
  assert.equal(weekly.scheduledAt, '2026-03-15T06:30:00.000Z');
  assert.equal(schedule.formatScheduleLocalTime(weekly, weekly.scheduledAt), '2026-03-15T02:30:00-04:00');

  const { default: OTel } = await import(otelUrl.href);
  assert(!modules.has('reporters') && !modules.has('otel'));
  const options = {
    exporter: { url: 'http://127.0.0.1:1/v1/logs' },
    resourceAttributes: { 'service.name': 'startup-fixture' },
    scope: { name: 'startup-fixture' },
    onFailure: (message, error) => { throw new Error(message, { cause: error }); },
  };
  const eventReporter = OTel.prototype.createEventReporter(options);
  const sessionReporter = OTel.prototype.createSessionLogReporter(options);
  assert.equal(typeof eventReporter.emit, 'function');
  assert.equal(typeof sessionReporter.reportSessionLog, 'function');
  assert.notEqual(eventReporter.provider, sessionReporter.provider);
  assert(modules.has('reporters') && modules.has('otel'));
  assert.throws(() => OTel.prototype.createSessionLogReporter({ ...options, maxRequestBytes: 0 }), /maxRequestBytes/);
  await Promise.all([eventReporter.shutdown(), sessionReporter.shutdown()]);
  console.log('PASS lazy catalogs, HTML conversion, ZIP cancellation, calendar recurrence and OTel reporters');
} finally {
  hook.deregister();
}
