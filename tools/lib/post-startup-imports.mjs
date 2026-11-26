import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const changes = new Map();

function register(relative, original, patched, transform) {
  changes.set(relative, { original, patched, transform });
}

function edit(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) {
    throw new Error('Expected exactly one startup import patch anchor: ' + anchor);
  }
  return source.replace(anchor, () => replacement);
}

// Keep the Cordis providers registered and defer their read-only catalog.
register('dsh-tool-cordis/lib/types/providers.js',
  '91ee78df2502cf23cd5436c25ac74aa3ccbf07b2901e3945d3c3bdedb981ff75',
  '86c5ec35959aaf4d0369a22c9eae312dabef593f275cd46fd17e5b4e4ec47224', source => {
  source = edit(source, 'import { EVENT_API, queryEventApi, queryServiceApi } from "./api-catalog.js";',
    'const loadApiCatalog = () => import("./api-catalog.js");');
  source = edit(source, "const HOST_EVENTS = EVENT_API.filter(event => !event.name.startsWith('cordis/'));",
    "let hostEvents;");
  source = edit(source, "input => queryServiceApi(readExact(input, 'service'))",
    "async input => (await loadApiCatalog()).queryServiceApi(readExact(input, 'service'))");
  return edit(source, "input => queryEventApi(readExact(input, 'event'), HOST_EVENTS)",
    "async input => {\n            const { EVENT_API, queryEventApi } = await loadApiCatalog();\n            hostEvents ??= EVENT_API.filter(event => !event.name.startsWith('cordis/'));\n            return queryEventApi(readExact(input, 'event'), hostEvents);\n        }");
});
// Keep the synchronous formatter and initialize the converter on the first eligible HTML result.
register('dsh-tool-web/lib/index.js',
  '243e7f142e2ba81cbdbce4f24e9bf5f1b1fbd41f8fa34e75be63d2ff67697e48',
  'c7aed7d01b094054c6b796958f4cad01f69261fe183ea1879693a7cb3da2ec0a', source => {
  source = edit(source, 'import TurndownService from "turndown";\nimport { gfm } from "@joplin/turndown-plugin-gfm";',
    'import { createRequire as createConverterRequire } from "node:module";');
  const start = source.indexOf('const turndown = new TurndownService({');
  const end = source.indexOf('/**\n* Validate value constraints',start);
  if (start < 0 || end <= start) throw new Error('Review HTML converter initialization');
  const init = source.slice(start,end);
  if (!init.endsWith('});\n')) throw new Error('Review HTML converter rules');
  source = source.slice(0, start) + `const requireConverter = createConverterRequire(import.meta.url);
let converter;
function webConverter() {
  if (converter) return converter;
  const TurndownService = requireConverter("turndown");
  const { gfm } = requireConverter("@joplin/turndown-plugin-gfm");
`+init.split('\n').map(line => line ? '  ' + line : '').join('\n')+`  converter = turndown;
  return converter;
}
`+source.slice(end);
  return edit(source, 'text: turndown.turndown(content),','text: webConverter().turndown(content),');
});
// Keep the route and its stream contract. The producer loads the ZIP implementation.
register('dsh-session-log-export/lib/index.js',
  'b1da2687811d4e8d696cf480ad5266ec43d0548091dcf50805ad577f6f5804cd',
  'f9b48f8f1b364c9606cca8de17a8f82c8d659e97466e1eea1421e9c0243558f7', source => {
  source = edit(source, 'import { Zip, ZipDeflate } from "fflate";\n','');
  const first = source.indexOf('\t\t\tconst archive = new Zip(');
  const last = source.indexOf('\t\t\t\t\tfor await (const entry of sessionLogZipEntries',first);
  if (first < 0 || last <= first) throw new Error('Review ZIP producer initialization');
  const original = source.slice(first,last);
  const anchor = '\t\t\t(async () => {\n\t\t\t\ttry {\n';
  if (!original.endsWith(anchor)) throw new Error('Review ZIP producer boundary');
  const setup = original.slice(0,-anchor.length).split('\n').map(line => line ? '\t\t' + line : '').join('\n');
  return source.slice(0, first) + anchor + '\t\t\t\t\tconst { Zip, ZipDeflate } = await import("fflate");\n\t\t\t\t\tproducerSignal.throwIfAborted();\n' + setup + source.slice(last);
});

function deferTemporal(source, expectedUses) {
  if ([...source.matchAll(/\bTemporal\./g)].length !== expectedUses) {
    throw new Error('Review Temporal call sites before deferring the import');
  }
  const deferred = source.replace(/\bTemporal\./g, 'calendarTemporal().');
  const constructor = deferred.includes('new calendarTemporal().PlainDateTime(')
    ? edit(deferred, 'new calendarTemporal().PlainDateTime(', 'new (calendarTemporal().PlainDateTime)(')
    : deferred;
  return edit(constructor, 'import { Temporal } from "@js-temporal/polyfill";', `import { createRequire as createCalendarRequire } from "node:module";
import { fileURLToPath as calendarFileURLToPath } from "node:url";
const requireCalendar = createCalendarRequire(import.meta.url);
let temporalImplementation;
function calendarTemporal() {
    // Open the same ES module selected by Node's original import conditions.
    return temporalImplementation ??= requireCalendar(calendarFileURLToPath(import.meta.resolve("@js-temporal/polyfill"))).Temporal;
}`);
}

register('dsh-util-time/lib/index.js',
  '01a46863c3857b09172e80be271f61ad27d269bf1b933e20d852f46581fd9562',
  '7fd08385b60c7a123b5a7d08bf976bc6152b687109f58be6297ba51145ac694d', source => {
  source = deferTemporal(source, 12);
  source = edit(source, 'import rrulePackage from "rrule";', '');
  source = edit(source, 'const { Weekday, rrulestr } = rrulePackage;', `let recurrenceImplementation;
function recurrenceRules() {
    return recurrenceImplementation ??= requireCalendar("rrule");
}`);
  source = edit(source, 'new Weekday(', 'new (recurrenceRules().Weekday)(');
  return edit(source, 'return rrulestr(', 'return recurrenceRules().rrulestr(');
});

register('dsh-schedule/lib/index.js',
  'a90f4b095317b8e767d39e0da9acb131049977d4cc2c362d2ac8205a3cf89654',
  '089b77f0c985adfe4be15ad300c00b27e82873c546849896eb2851afc0460e9d', source => deferTemporal(source, 5));

function hash(source) {
  return createHash('sha256').update(source).digest('hex');
}

export function postStartupImportSource(relative, source) {
  const change = changes.get(relative);
  if (!change) throw new Error('Unknown post-startup import patch: ' + relative);
  const digest = hash(source);
  if (digest === change.patched) return source;
  if (digest !== change.original) {
    throw new Error('Review upstream import and first-use behavior: ' + relative);
  }
  const candidate = change.transform(source);
  if (hash(candidate) !== change.patched) {
    throw new Error('Post-startup import patch output changed: ' + relative);
  }
  return candidate;
}

export function patchPostStartupImports(stage) {
  // Validate each input before writing so upstream drift leaves the stage untouched.
  const candidates = [];
  for (const relative of changes.keys()) {
    const file = join(stage, 'node_modules', '@deepseek-ai', relative);
    const source = readFileSync(file, 'utf8');
    const candidate = postStartupImportSource(relative, source);
    if (candidate !== source) candidates.push({ file, candidate });
  }
  for (const { file, candidate } of candidates) {
    const temporary = file + '.dshm-' + process.pid + '.tmp';
    writeFileSync(temporary, candidate);
    renameSync(temporary, file);
  }
}
