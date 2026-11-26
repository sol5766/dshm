import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The bundled root 4.6.7 and nested 4.6.6 contain the same audited ESM locale sources.
const ESM_HASH = 'c3ef8675e25d7415860e48e8b07a7494f84871e09f246e62fd68a7cc398cc006';

// The previous packaging pass emitted 64 per-package files with these exact bytes.
const FLAT_HASH = '83ca170864916bf2746dee1ee3f54f3c590b68014d0383bc1a8de300eac60739';
// Fingerprints also recognize an already-shared, freshly extracted container without a pristine cache.
const SHARED_HASH = 'd797d98bc71d2406586a229f71880cfbe3c238edce2f1d0720d6243b49d5f1b8';
const ROOT_SHARED_HASH = 'ea2d15ae47f7392f45318386ae05242b41ee5aba7ffc2a1b6cf87ca9edcbbd11';
const IMPLEMENTATION_HASH = '71d6cf2c6606f31f93ef35e80f1f7e130afd4a6940e04d5a52786c6cecb29a0b';
const FACTORY_NAME = 'dshm-zod-4.6.6-locales.mjs';
// From node_modules/@deepseek-ai/<owner>/node_modules/zod/v4/locales/ to the core root.
const FACTORY_IMPORT = '../../../../../../../' + FACTORY_NAME;
const ROOT_FACTORY_IMPORT = '../../../../' + FACTORY_NAME;

function filesIn(dir, ext) {
  return readdirSync(dir).filter(name => name.endsWith(ext)).sort();
}

function digest(files) {
  const hash = createHash('sha256');
  for (const name of [...files.keys()].sort()) hash.update(name + '\0').update(files.get(name));
  return hash.digest('hex');
}

function readEsm(dir) {
  return new Map(filesIn(dir, '.js').map(name => [name, readFileSync(join(dir, name), 'utf8')]));
}

// Keep each leaf's private helpers and default function in their own lexical scope.
// All 63 scopes belong to this package's ESM instance, including its original util.
export function bundleLocaleFiles(upstream) {
  const files = new Map();
  const lines = ['import * as util from "../core/util.js";'];
  const entries = new Map();
  for (const line of upstream.get('index.js').trimEnd().split(/\r?\n/)) {
    const match = /^export \{ default as (\w+) \} from "\.\/([\w-]+)\.js";$/.exec(line);
    if (!match) throw new Error('Unrecognized Zod locale export: ' + line);
    const [, name, stem] = match;
    entries.set(stem + '.js', name);
  }
  for (const [file, name] of entries) {
    const body = upstream.get(file).replace(/^import \* as util from "\.\.\/core\/util\.js";\r?\n/m, '')
      .replace(/^import (\w+) from "\.\/(.+\.js)";\r?\n/m, (line, alias, target) => {
        // kh/km and ua/uk refer to a sibling binding when the factory is called.
        if (entries.get(target) !== alias) throw new Error('Unrecognized Zod locale alias: ' + line);
        return '';
      });
    const parts = body.trimEnd().split('export default function () {');
    if (parts.length !== 2 || /^\s*(?:import|export)\b/m.test(parts.join(''))) {
      throw new Error('Unrecognized Zod locale factory: ' + file);
    }
    lines.push(`export const ${name} = (() => {\n${parts[0]}return { default: function () {${parts[1]} }.default;\n})();`);
    files.set(file, `export { ${name} as default } from './index.js';\n`);
  }
  files.set('index.js', lines.join('\n') + '\n');
  return files;
}

function replaceFile(path, content) {
  const tmp = path + '.dshm-' + process.pid + '.tmp';
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** All wrappers call this pure implementation once, supplying their own util and receiving fresh bindings. */
export function shareLocaleImplementation(flat, specifier = FACTORY_IMPORT) {
  const header = 'import * as util from "../core/util.js";\n';
  const code = flat.get('index.js');
  const names = [...code.matchAll(/^export const (\w+) = \(\(\) => \{$/gm)].map(m => m[1]);
  if (!code.startsWith(header) || names.length !== flat.size - 1) throw new Error('Unrecognized bundled Zod locale index');
  const localBindings = code.slice(header.length).replace(/^export const /gm, 'const ');
  const implementation = 'export function makeLocales(util) {\n' + localBindings + '\nreturn {' + names.join(',') + '};\n}\n';
  const files = new Map(flat);
  files.set('index.js', header + "import { makeLocales } from '" + specifier + "';\n"
    + 'export const {' + names.join(',') + '} = makeLocales(util);\n');
  return { files, implementation };
}

function writeIfMissing(path, bytes) {
  if (!existsSync(path)) replaceFile(path, bytes);
  else if (readFileSync(path, 'utf8') !== bytes) throw new Error('Unexpected contents of generated Zod implementation: ' + path);
}

function readBackup(dir, hash) {
  if (!existsSync(dir)) return;
  const files = readEsm(dir);
  if (digest(files) === hash) return files;
}

function backUp(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of files) replaceFile(join(dir, name), body);
}

export function prepareZodLocales(stage, pristineDir, log = console.log) {
  const scope = join(stage, 'node_modules', '@deepseek-ai');
  const roots = readdirSync(scope, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .map(entry => join(scope, entry.name, 'node_modules', 'zod')).filter(root => existsSync(root));
  const rootPackage = join(stage, 'node_modules', 'zod');
  if (existsSync(rootPackage)) roots.unshift(rootPackage);
  const backup = join(pristineDir, 'zod-4.6.6-esm-locales');
  const flatBackup = join(pristineDir, 'zod-4.6.6-esm-locales-flat');
  const implementationPath = join(stage, FACTORY_NAME);
  let upstream = readBackup(backup, ESM_HASH);
  let flat = upstream ? bundleLocaleFiles(upstream) : readBackup(flatBackup, FLAT_HASH);
  const layouts = new Map();
  let optimized = 0;
  let implementationReady = false;
  for (const root of roots) {
    const isRoot = root === rootPackage;
    const expectedVersion = isRoot ? '4.6.7' : '4.6.6';
    const layout = isRoot ? ROOT_FACTORY_IMPORT : FACTORY_IMPORT;
    const dir = join(root, 'v4', 'locales');
    if (!existsSync(dir)) { log('[pack-core] ⚠ Zod locales missing, kept ' + root); continue; }
    const actual = readEsm(dir);
    let matchesVersion = false;
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      matchesVersion = pkg.name === 'zod' && pkg.version === expectedVersion;
    }
    catch (error) { log('[pack-core] ⚠ Zod metadata unavailable: ' + error.message); }
    if (!upstream && matchesVersion && digest(actual) === ESM_HASH) {
      upstream = actual;
      backUp(backup, upstream);
      flat ??= bundleLocaleFiles(upstream);
    }
    if (!flat && !isRoot && matchesVersion && digest(actual) === FLAT_HASH) {
      flat = actual;
      backUp(flatBackup, flat);
    }
    // Repacking an extracted, already-shared distribution without any pristine directory.
    if (!flat && matchesVersion && digest(actual) === (isRoot ? ROOT_SHARED_HASH : SHARED_HASH)) {
      if (!existsSync(implementationPath) ||
          createHash('sha256').update(readFileSync(implementationPath)).digest('hex') !== IMPLEMENTATION_HASH) {
        throw new Error('Missing or changed shared Zod locale implementation, restore the pristine input');
      }
      optimized++;
      continue;
    }
    if (flat && !layouts.has(layout)) layouts.set(layout, shareLocaleImplementation(flat, layout));
    const shared = layouts.get(layout);
    const known = shared && matchesVersion && actual.size === flat.size
      && [...flat].every(([name, old]) => (!isRoot && actual.get(name) === old) || actual.get(name) === shared.files.get(name)
        || (upstream?.has(name) && actual.get(name) === upstream.get(name)));
    if (known) {
      // Publish the dependency before any imports point at it. Multiple packages and reruns share this file.
      if (!implementationReady) {
        writeIfMissing(implementationPath, shared.implementation);
        implementationReady = true;
      }
      optimized++;
    } else {
      log('[pack-core] ⚠ Unrecognized Zod locale input in ' + root);
    }
    for (const [name, current] of actual) {
      const wasGenerated = current === shared?.files.get(name) || (!isRoot && current === flat?.get(name));
      const original = upstream?.get(name) ?? flat?.get(name);
      const next = known ? shared.files.get(name) : (wasGenerated ? original : current);
      if (next !== current && next !== undefined) replaceFile(join(dir, name), next);
    }
  }
  log('[pack-core] Zod shared locale implementation: ' + optimized + '/' + roots.length + ' bundled packages');
  return optimized;
}
