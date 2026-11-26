import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const credentialsLocalFile = core => join(core, 'node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js');

const parseHeader = 'function parseCredentialsDocument(text, filename) {';
const migrateHeader = 'function renderFlatLayoutMigration(text) {';
const parse = 'parseDocument(text, {\n\t\tprettyErrors: true,\n\t\tuniqueKeys: true\n\t})';
// Embedded in the materialized ESM package. An undefined result selects the ordinary
// async permission/absence/error handling, including its canonical ancestor validation.
function readBoundedPrivateCredentials(filename, config, markRead, io = credentialFs, env = process.env) {
  const sandbox = env.DSHM_SANDBOX_HOME;
  if (env.DSHM_CREDENTIALS_BOUNDED_READ !== '1' || env.DSHM_PLATFORM !== 'ohos' || env.DSHM_PROFILE !== 'ondevice' ||
      config?.path !== undefined || config?.dshHome !== undefined ||
      !['/data/storage/el2/base/files', '/data/storage/el2/base/haps/entry/files', '/data/storage/el2/base/haps/phone/files'].includes(sandbox)) return;
  const home = sandbox + '/dsh/home';
  if (env.DSHM_HOME !== home || env.DSH_HOME !== home || filename !== home + '/.credentials.yaml') return;
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = io.constants;
  if (!Number.isInteger(O_NOFOLLOW) || O_NOFOLLOW <= 0 || !Number.isInteger(O_NONBLOCK) || O_NONBLOCK <= 0) return;
  const options = { bigint: true };
  const sameFile = (a, b) => b.isFile() && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode &&
    a.size === b.size && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs;
  try {
    if (io.realpathSync.native(home) !== home) return;
    const fd = io.openSync(filename, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      const before = io.fstatSync(fd, options);
      if (!before.isFile() || before.ino <= 0n || before.size < 0n || before.size > 65536n ||
          typeof before.mtimeNs !== 'bigint' || typeof before.ctimeNs !== 'bigint') return;
      markRead?.();
      const size = Number(before.size);
      const data = Buffer.alloc(size + 1);
      const read = io.readSync(fd, data, 0, data.length, 0);
      if (read !== size || !sameFile(before, io.fstatSync(fd, options)) ||
          !sameFile(before, io.lstatSync(filename, options))) return;
      return data.toString('utf8', 0, read);
    } finally {
      io.closeSync(fd);
    }
  } catch {
    // The upstream path owns permission checks and diagnostics, including watcher behavior.
    return undefined;
  }
}

const fdImport = 'import * as credentialFs from "node:fs";';
const fsImport = 'import { mkdir, readFile, stat } from "node:fs/promises";';
const readStamp = 'globalThis.__dshmMcpModuleStamp?.("credentialsReadStarted");';
const fastStamp = 'globalThis.__dshmMcpModuleStamp?.("credentialsBoundedReadUsed");';
function ioEdit(traced) {
  const readLine = traced ? '\t\t\t' + readStamp + '\n' : '';
  const original = '\t\tawait assertOwnerOnly(this.spec.filename);\n\t\tlet text;\n\t\ttry {\n' + readLine +
    '\t\t\ttext = await readFile(this.spec.filename, "utf8");\n\t\t} catch (error) {\n\t\t\tif (!isENOENT(error)) throw error;\n\t\t\treturn;\n\t\t}';
  const marker = traced ? '\t\tlet readMarked = false;\n\t\tconst markRead = () => {\n\t\t\tif (readMarked) return;\n\t\t\treadMarked = true;\n\t\t\t' + readStamp + '\n\t\t};\n' : '';
  const changed = marker + '\t\tlet text = readBoundedPrivateCredentials(this.spec.filename, this.config, ' + (traced ? 'markRead' : 'undefined') + ');\n' +
    '\t\tif (text === undefined) {\n\t\t\tawait assertOwnerOnly(this.spec.filename);\n\t\t\ttry {\n' +
    (traced ? '\t\t\t\tmarkRead();\n' : '') +
    '\t\t\t\ttext = await readFile(this.spec.filename, "utf8");\n\t\t\t} catch (error) {\n\t\t\t\tif (!isENOENT(error)) throw error;\n\t\t\t\treturn;\n\t\t\t}\n\t\t}' +
    (traced ? ' else {\n\t\t\t' + fastStamp + '\n\t\t}' : '');
  return [original, changed];
}
const edits = [
  [parseHeader + '\n\tconst document = ' + parse + ';',
    parseHeader + '\n\treturn credentialSnapshot(parseCredentialYaml(text), filename);\n}\n' +
    'function parseCredentialYaml(text) {\n\treturn ' + parse + ';\n}\n' +
    'function credentialSnapshot(document, filename) {'],
  [migrateHeader + '\n\tconst document = ' + parse + ';',
    migrateHeader + '\n\treturn flatCredentialMigration(text, parseCredentialYaml(text));\n}\n' +
    'function flatCredentialMigration(text, document) {'],
  ['\t\tif (renderFlatLayoutMigration(text) !== void 0) text = await this.migrateFlatDocument();',
    '\t\tconst initialYaml = parseCredentialYaml(text);\n' +
    '\t\tconst migrate = flatCredentialMigration(text, initialYaml) !== void 0;\n' +
    '\t\tif (migrate) text = await this.migrateFlatDocument();'],
  ['\t\tconst document = parseCredentialsDocument(text, this.spec.filename);',
    '\t\tconst document = migrate ? parseCredentialsDocument(text, this.spec.filename) : credentialSnapshot(initialYaml, this.spec.filename);']
];

function transform(source, reverse = false, withFd = true) {
  const replacements = withFd ? [
    ...edits, [fsImport, fdImport + '\n' + fsImport],
    [migrateHeader, readBoundedPrivateCredentials.toString().replace(/\r\n/g, '\n') + '\n' + migrateHeader], ioEdit(source.includes(readStamp))
  ] : edits;
  // Undo in reverse order because the fd helper sits immediately before a rewritten declaration.
  for (const [before, after] of reverse ? [...replacements].reverse() : replacements) {
    const from = reverse ? after : before;
    if (source.split(from).length !== 2) throw new Error('Unexpected credentials-local startup anchor: ' + from.slice(0, 60));
    source = source.replace(from, () => reverse ? before : after);
  }
  return source;
}

// Pin the two consumers and the lifetime in which the AST can be shared. In particular,
// the migration recognizer only inspects this tree, and the writer lock may return new text.
const regions = [
  ['async function assertOwnerOnly(filename) {', '\n}', '1c947ca7e2a743706870794f242deaeaef23a5765a0e9e993df086e491028809'],
  [parseHeader, '\n}', '989478895a92342241593cabcb0c00b6a28feaa7a0bc0ff6ea9eb7cd4eec9491'],
  [migrateHeader, '\n}', 'f7f8ebbe81645131d8baabe905a425404933620120e9b3562a86743b358e44ec'],
  ['\tasync loadInitial() {', '\n\t}', 'a2594146670dc14ed327b2407cab1a946ec5b7e3f149ad7f12c5e29d58507384']
];
function validate(source) {
  const marks = /^[\t ]*globalThis\.__dshmMcpModuleStamp\?\.\("credentials(?:OwnerCheckStarted|ReadStarted|DecodeStarted)"\);\n/gm;
  for (const [header, end, digest] of regions) {
    const start = source.indexOf(header);
    const finish = source.indexOf(end + '\n', start);
    const block = source.slice(start, finish + end.length).replace(marks, '');
    if (start < 0 || finish < 0 || start !== source.lastIndexOf(header) ||
      createHash('sha256').update(block).digest('hex') !== digest) {
      throw new Error('Review credentials-local YAML handling: ' + header);
    }
  }
}

export function originalCredentialsLocal(source) {
  if (!/\b(?:parseCredentialYaml|credentialSnapshot|flatCredentialMigration)\b/.test(source)) {
    validate(source);
    return source;
  }
  const withFd = source.includes(fdImport) || source.includes('readBoundedPrivateCredentials');
  const original = transform(source, true, withFd);
  validate(original);
  if (transform(original, false, withFd) !== source) throw new Error('Incomplete credentials-local optimization');
  return original;
}

export function optimizeCredentialsLocal(source) {
  return transform(originalCredentialsLocal(source));
}

export function patchCredentialsLocalStartup(core, instrument = source => source) {
  const file = credentialsLocalFile(core);
  const source = readFileSync(file, 'utf8');
  const patched = optimizeCredentialsLocal(instrument(originalCredentialsLocal(source)));
  if (patched === source) return;
  const temporary = file + '.dshm-' + process.pid + '.tmp';
  writeFileSync(temporary, patched);
  renameSync(temporary, file);
}
