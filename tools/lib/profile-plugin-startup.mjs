import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const gotImport = 'import got from "got";';
const localGot = 'const { default: got } = await import("got");';
const sendBlock = [
  '\t\tasync send(data, timeoutMillis) {',
  '\t\t\tsignal.throwIfAborted();',
  '\t\t\tagent ??= config.agentFactory(new URL(config.url).protocol);',
  '\t\t\tconst selectedAgent = await agent;',
  '\t\t\tconst headers = await config.headers();',
  '\t\t\tsignal.throwIfAborted();',
  '\t\t\tconst compressed = config.compression === "gzip";',
  '\t\t\tconst request = got.post(config.url, {',
].join('\n');
const lazySend = sendBlock.replace('const headers = await config.headers();',
  'const headers = await config.headers();\n\t\t\t' + localGot);

const transformer = '@opentelemetry/otlp-transformer';
const wholeTransformer = 'import { JsonLogsSerializer, LogsExporterMetricsHelper } from "' + transformer + '";';
const logImports = [
  'import { JsonLogsSerializer } from "' + transformer + '/build/src/logs/json/index.js";',
  'import { LogsExporterMetricsHelper } from "' + transformer + '/build/src/logs/index.js";',
].join('\n');

export function verifyOtelTransformerManifest(pkg) {
  if (pkg.name !== transformer || pkg.version !== '0.222.0' || pkg.main !== 'build/src/index.js' ||
      pkg.sideEffects !== false || pkg.exports !== undefined) {
    throw new Error('dsh-otel: unexpected OTLP transformer manifest');
  }
}

export function verifyOtelTransformer(plugin) {
  const require = createRequire(plugin);
  const manifest = require.resolve(transformer + '/package.json');
  verifyOtelTransformerManifest(JSON.parse(readFileSync(manifest, 'utf8')));
  // Exact public barrel and the two CJS modules to which its public getters delegate.
  const anchors = [
    ['index.js', 'b3e4a32640937efd8fe40e6b8251d5e6529d079be0aaf4d32d73a888ca58a3dd'],
    ['logs/json/index.js', '694eba813ea6b62476fffad15e59f32affb9789cbde571e47d52658aa8fed331'],
    ['logs/index.js', '53ac91d6022087082f9f6aa0ad00c2687ca4051e03d5b62f1d613217fb2b6cf0'],
  ];
  for (const [name, expected] of anchors) {
    const actual = createHash('sha256').update(readFileSync(join(dirname(manifest), 'build/src', name))).digest('hex');
    if (actual !== expected) throw new Error('dsh-otel: unexpected OTLP transformer entry ' + name);
  }
}

export function useOtelLogTransformers(source) {
  const text = source.replaceAll('\r\n', '\n');
  const count = text.split('from "' + transformer).length - 1;
  if (count === 2 && text.split(logImports).length === 2) return source;
  if (count !== 1 || text.split(wholeTransformer).length !== 2) throw new Error('dsh-otel: unexpected transformer import');
  const output = text.replace(wholeTransformer, logImports);
  return source.includes('\r\n') ? output.replaceAll('\n', '\r\n') : output;
}

export function deferOtelHttpClient(source) {
  const lines = source.split(/\r?\n/);
  const uses = lines.filter(line => /\bgot\b/.test(line) && !/^\s*(?:\/\/|\*|\/\*)/.test(line)).map(line => line.trim());
  const local = uses.includes(localGot);
  const text = lines.join('\n');
  const block = local ? lazySend : sendBlock;
  if (uses.length !== 2 || uses[0] !== (local ? localGot : gotImport) ||
      uses[1] !== 'const request = got.post(config.url, {' || text.split(block).length !== 2) {
    throw new Error('dsh-otel: unexpected got import or HTTP send implementation');
  }
  if (local) return source;
  const result = text.replace(gotImport + '\n', '').replace(block, lazySend);
  return source.includes('\r\n') ? result.replaceAll('\n', '\r\n') : result;
}

function hash(source) {
  return createHash('sha256').update(source).digest('hex');
}

const otelOriginal = '80f8b49c28623edeb57e3248c419b2f93142ee3ec8ff965589d511ef879f08a3';
const otelEntry = '2fec92881f20ebc3d76effc47a3f9dc052319e46fb3d9eb947af324426997637';
const otelReporters = 'adbe3fda48966b43777ca7a045bdd716bd282929b9682ce416aa871e6b6b9565';
const transportName = 'dshm-reporters.js';

export function postStartupReportersSource(source, transport) {
  const sourceHash = hash(source);
  if (sourceHash === otelEntry && transport !== undefined && hash(transport) === otelReporters) {
    return { entry: source, reporters: transport };
  }
  if (sourceHash !== otelOriginal || (transport !== undefined && hash(transport) !== otelReporters)) {
    throw new Error('Review upstream OTel provider and first-use reporter behavior');
  }
  const serviceImport = 'import { Service } from "@deepseek-ai/cordis";\n';
  const boundary = '//#region lib/types/index.js\n';
  const [implementation, service] = source.slice(serviceImport.length).split(boundary);
  const serviceBody = service
    .replace('new EventLogReporter(options)', 'new (loadReporters().EventLogReporter)(options)')
    .replace('new SessionLogReporter(options)', 'new (loadReporters().SessionLogReporter)(options)');
  const entry = serviceImport + 'import { createRequire } from "node:module";\n'
    + 'const require = createRequire(import.meta.url);\n'
    + 'let reporters;\n'
    + 'function loadReporters() {\n\treturn reporters ??= require("./' + transportName + '");\n}\n'
    + boundary + serviceBody;
  const reporters = implementation + 'export { EventLogReporter, SessionLogReporter };\n';
  if (hash(entry) !== otelEntry || hash(reporters) !== otelReporters) {
    throw new Error('OTel startup patch output changed');
  }
  return { entry, reporters };
}

export function deferProfilePluginImports(stage) {
  const directory = join(stage, 'node_modules', '@deepseek-ai', 'dsh-otel', 'lib');
  const entryFile = join(directory, 'index.js');
  const reportersFile = join(directory, transportName);
  const source = readFileSync(entryFile, 'utf8');
  const transport = existsSync(reportersFile) ? readFileSync(reportersFile, 'utf8') : undefined;
  verifyOtelTransformer(entryFile);
  const normalized = hash(source) === otelEntry ? source : useOtelLogTransformers(deferOtelHttpClient(source));
  const { entry, reporters } = postStartupReportersSource(normalized, transport);
  // Publish the verified dependency first so a retry can finish updating the entry.
  for (const [file, before, after] of [[reportersFile, transport, reporters], [entryFile, source, entry]]) {
    if (before === after) continue;
    const temporary = file + '.dshm-' + process.pid + '.tmp';
    writeFileSync(temporary, after);
    renameSync(temporary, file);
  }
}
