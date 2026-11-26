import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';

const supportedVersion = '4.6.6';
const factoryFile = 'dshm-zod-4.6.6-factories.mjs';
const factoryHash = '3beff548c5394c3e9ae4edf322ecdfc90df5e378c7c833a835701303308a994f';
const sources = {
  'v4/core/schemas.js': [
    'makeCoreSchemas',
    '0ee56e8afbae28eeb1060a162ad7e56f0675ee6fb83f0ae56bea2e088f6cdbc0',
    '05ba9daa1edadc55027d97f4c4c31bf1a73a8eb2497481f05c069ba52d3a6e8d',
  ],
  'v4/core/compile.js': [
    'makeCompiler',
    '53fcf24821f50ecf42492ab7101abe8a50ead8286a53567d71648fe5ca346b99',
    '864cf98d572d51e6302a1ebbecfbcce91be77236aae41171bd1e34b8b44de962',
  ],
  'v4/classic/schemas.js': [
    'makeClassicSchemas',
    '2bf4a631a18f734a9a7ab7fc11bcf919214774d2235a312dcec0dd53d0324c32',
    'caec4d10d2c98daaf69140f1ac7a6c4bc195519c83699e331a1c60ea939edcfe',
  ],
  'v4/core/json-schema-processors.js': [
    'makeSchemaProcessors',
    'b6d2aee72212c076b9cde38da6333591c76a24eb049a4ee4e7bd2b7825d8b817',
    '3623c5054b7a44f89c43fe4221e1854b927473985ea19ac8cefac7d2c492f40e',
  ],
  'v4/classic/from-json-schema.js': [
    'makeSchemaImporter',
    '31dc999a26cb6928f5e99ea564d648567e85cf9aa47565198fb6186dbd6c070e',
    'cb249505de6248026532f24e1ce725ebc24684bbc37aa414240f1f9a6b24dcf8',
  ],
};

const extraSources = {
  'v4/core/checks.js': [
    'makeChecks',
    'bc42543274218aa7ef72192b3218d2a4a399e53df8de240a04d9ff275096f563',
    'ba836e177cfbfb9906f753d3d67b75f0839a0eb60239fc86e07e7e08e31dc06f',
  ],
  'v4/core/regexes.js': [
    'makeRegexes',
    '24fc98f6fc9175e50ff29d28b040e3b4ac5650de19914d45ee27b853d367ecc6',
    'aba1a0c73d4bc4b8597153ce52fae53432ca52de893d79ad5ae07a511b711841',
  ],
  'v4/core/to-json-schema.js': [
    'makeToJsonSchema',
    '85b883eb8f05e9f060c71a39fce7df9345b566af29d5bc9c8fa477fe616a051d',
    'c722d97bfb08b407d00b1bf2686f5891f869a855c3a3262e23243e995877623c',
  ],
  'v4/core/errors.js': [
    'makeErrors',
    'a0c95ef2f7085b5bc2931f7b566f524b26a0360c8df741e3f87f923745cf9792',
    '732890bba3ef53b4c4cd7457147a3b7baff546cf1dc1b6490fa0a7c3cc81c15d',
  ],
  'v4/core/parse.js': [
    'makeParse',
    'fb05b91ec260f3f484f7c00a177b6126ceb8fd1b09dc90b1200afdffd4d98efd',
    'd6d4992eee0c38bb38782a9d9691ce76dcb60c3f9087b74a9d9e1f1e7a5fc457',
  ],
  'v4/core/memoizer.js': [
    'makeMemoizer',
    '18a3188c51229d9189a5408b0b7fbc3e121b55c2b4c3c406d79cb9b77e7ad964',
    '1cc6b13267601ec15d5ce240f8263912646f697932c12fb017ab83f382a7a1cb',
  ],
  'v4/core/visit.js': [
    'makeVisit',
    'a804062900869e09ea0b975cfa569fd3c70dc33bad7fc30b63872d451cae29f7',
    '47da226766be7fc238f926578d7fefd6cc09449bca7ef0e9c93e4febfda43f8e',
  ],
  'v4/core/json-schema-generator.js': [
    'makeJsonSchemaGenerator',
    'beaeab6faa654e99e443b8a9f5d8a4adc08cd8226f92a0cd32477a58ecfa1807',
    '47a75502cbaa05f8e82315e4affca8eddcd4d616fe3d952a2f0c87c5f83cc886',
  ],
};

const factoryBundles = [
  { file: factoryFile, fingerprint: factoryHash, sources },
  {
    file: 'dshm-zod-4.6.6-extra-factories.mjs',
    fingerprint: '00d622a73b424164f6e2fc5d6159b6fb4997d348a8140d2e96036d5ddac958d9',
    sources: extraSources,
  },
];

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

const benchmarkManifestHash = 'cff7e142055a9dd9bc2947a71ca3fb5e3aacdfda966d7728993ff3656245b94a';
const benchmarkContentHash = '816f1b04bb407b8344fd118fc21738333dcd56396e7b10bf5063ac4ba72cff73';

// The exact bundled v3 benchmarks have no consumer entry, including under
// @zod/source. Keep unknown package builds, files and notices in the archive.
export function isBundledZodBenchmarks(stage, rel) {
  const match = /^(node_modules\/@deepseek-ai\/[a-z0-9][a-z0-9._-]*\/node_modules\/zod)\/src\/v3\/benchmarks$/.exec(rel);
  if (!match) return false;
  const manifest = join(stage, match[1], 'package.json');
  if (!existsSync(manifest) || hash(readFileSync(manifest)) !== benchmarkManifestHash) return false;
  const directory = join(stage, rel);
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1);
  if (entries.length !== 9 || entries.some(entry => !entry.isFile())) return false;
  const contents = createHash('sha256');
  for (const entry of entries) {
    contents.update(entry.name + '\0').update(readFileSync(join(directory, entry.name))).update('\0');
  }
  return contents.digest('hex') === benchmarkContentHash;
}

export function isSharedZodWrapper(stage, file, source, upstreamHash) {
  const bundle = factoryBundles.find(candidate => Object.hasOwn(candidate.sources, file));
  const entry = bundle?.sources[file];
  if (!entry || entry[1] !== upstreamHash || hash(source) !== entry[2]) return false;
  const implementation = join(stage, bundle.file);
  return existsSync(implementation) && hash(readFileSync(implementation)) === bundle.fingerprint;
}
const bindings = /^[A-Za-z_$][\w$]*$/;
const moduleSpecifiers = /^(?:import|export)\b[^;]*?\bfrom "(?<path>\.[^"\n]+)";/gm;

function verifyGraph(root, file) {
  const seen = new Set();
  function walk(current) {
    const source = readFileSync(join(root, current), 'utf8');
    for (const hit of source.matchAll(moduleSpecifiers)) {
      const dependency = posix.normalize(posix.join(posix.dirname(current), hit.groups.path));
      if (!dependency.startsWith('v4/')) continue;
      assert.notEqual(dependency, file, 'Cyclic dependency in shared Zod factory: ' + file);
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      walk(dependency);
    }
  }
  walk(file);
}

export function createZodFactory(source, factory, specifier) {
  const originalImports = [];
  const locals = [];
  const directExports = [];
  const exports = new Map();
  const entry = (local, publicName = local) => {
    assert(bindings.test(local) && bindings.test(publicName), 'Invalid binding: ' + local);
    assert(!exports.has(publicName),'Duplicate export '+publicName);
    exports.set(publicName, local);
  };
  const list = text => text.split(',').map(part => part.trim()).filter(Boolean);
  let body = source.replace(/^import ([^;]+) from "\.[^"\n]+";$/gm,(statement, specifiers) => {
    originalImports.push(statement);
    if (specifiers.startsWith('* as ')) locals.push(specifiers.slice(5));
    else if (specifiers.startsWith('{')) locals.push(...list(specifiers.slice(1,-1)).map(field=>field.split(/\s+as\s+/).at(-1)));
    else locals.push(specifiers);
    return '';
  });
  assert(locals.every(x=>bindings.test(x)) && new Set(locals).size===locals.length,'Unexpected imports in '+factory);
  body=body.replace(/^export \{([^}]*)\}( from "\.[^"\n]+")?;$/gm,(statement,specifiers,from)=>{
    if(from) directExports.push(statement);
    else for(const item of list(specifiers.replace(/\/\/[^\n]*/g,''))){
      const [local,publicName]=item.split(/\s+as\s+/);
      entry(local,publicName);
    }
    return '';
  }).replace(/^export ((?:function|class|const) ([\w$]+))\b/gm,(statement, declaration, local)=>{
    entry(local);
    return declaration;
  });
  assert(!/^(?:import|export)\b/m.test(body) && !body.includes('import.meta'), 'Unconverted module syntax '+factory);
  const symbols = [...new Set(exports.values())];
  const names = [...exports].map(([publicName,local])=>publicName===local?local:local+' as '+publicName);
  // Native imports and re-exports stay in the original module. The factory
  // allocates that module's own values from exactly those imported bindings.
  const implementation = [
    'export function '+factory+'('+locals.join(', ')+') {',
    body.trim(),
    'return {'+symbols.join(',')+'};',
    '}',
    '',
  ].join('\n');
  const wrapper = [
    ...originalImports,
    ...directExports,
    'import { '+factory+' } from '+JSON.stringify(specifier)+';',
    'const {'+symbols.join(',')+'} = '+factory+'('+locals.join(', ')+');',
    'export { '+names.join(', ')+' };',
    '',
  ].join('\n');
  return { implementation, wrapper };
}

function replaceFile(file, source) {
  const temp = file + '.dshm-' + process.pid + '.tmp';
  writeFileSync(temp, source);
  renameSync(temp, file);
}

function planZodFactories(stage) {
  const scope = join(stage, 'node_modules', '@deepseek-ai');
  const roots = readdirSync(scope, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .map(entry => join(scope, entry.name, 'node_modules', 'zod'))
    .filter(root => existsSync(join(root, 'package.json')))
    .filter(root => {
      const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      return metadata.name === 'zod' && metadata.version === supportedVersion;
    });
  if (!roots.length) throw new Error('Review bundled Zod version before sharing ESM implementations');

  return { plans: factoryBundles.map(bundle => planZodBundle(stage, roots, bundle)), copies: roots.length };
}

function planZodBundle(stage, roots, bundle) {
  const factoryPath = join(stage, bundle.file);
  const existingFactory = existsSync(factoryPath) ? readFileSync(factoryPath, 'utf8') : undefined;
  if (existingFactory !== undefined && hash(existingFactory) !== bundle.fingerprint) {
    throw new Error('Unexpected contents of the shared Zod factories');
  }
  const wrappers = [];
  const factories = new Map();
  for (const [file, [factory, sourceHash, wrapperHash]] of Object.entries(bundle.sources)) {
    let shared;
    for (const root of roots) {
      const modulePath = join(root, file);
      const current = readFileSync(modulePath, 'utf8');
      const digest = hash(current);
      if (digest === wrapperHash) continue;
      if (digest !== sourceHash) throw new Error('Review upstream Zod module ' + modulePath);
      if (!shared) {
        verifyGraph(root, file);
        const specifier = relative(dirname(modulePath), factoryPath).replaceAll('\\', '/');
        shared = createZodFactory(current, factory, specifier);
        if (hash(shared.wrapper) !== wrapperHash) {
          throw new Error('Unexpected generated Zod wrapper for ' + modulePath);
        }
        factories.set(factory, shared.implementation);
      }
      wrappers.push({ modulePath, wrapper: shared.wrapper });
    }
  }
  const implementation = existingFactory === undefined ? [...factories.values()].join('\n') : undefined;
  if (implementation !== undefined && hash(implementation) !== bundle.fingerprint) {
    throw new Error('Could not reconstruct the complete shared Zod factories');
  }
  return { factoryPath, implementation, wrappers };
}

export function verifyZodFactories(stage) {
  const { plans, copies } = planZodFactories(stage);
  if (plans.some(({ implementation, wrappers }) => implementation !== undefined || wrappers.length)) {
    throw new Error('Shared Zod ESM files are missing from the staged core');
  }
  return copies;
}

export function prepareZodFactories(stage, log = console.log) {
  const { plans, copies } = planZodFactories(stage);
  for (const { factoryPath, implementation, wrappers } of plans) {
    if (implementation !== undefined) replaceFile(factoryPath, implementation);
    for (const { modulePath, wrapper } of wrappers) replaceFile(modulePath, wrapper);
  }
  log('[pack-core] Shared audited Zod ESM implementations across ' + copies + ' bundled copies');
  return copies;
}
