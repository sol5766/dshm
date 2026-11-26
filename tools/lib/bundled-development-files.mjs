import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// These SDK sources are absent from the consumer exports and the compiled
// import graph. The other groups contain only development fixtures and tools.
const reviewed = [
  ['openai', ['src'], /^src\/(?!.*\.d\.ts$).+\.ts$/, 453,
    'b57c23bbc8294d710cda751609938f2a202f9b2641c1bbe9abfa6743ff1a4cfc',
    '1311747613f9a97f8e92f8c36df37b12f781690571ac07a0f8fb4cc5a42030af'],
  ['@anthropic-ai/sdk', ['src'], /^src\/(?!.*\.d\.ts$).+\.ts$/, 193,
    '3da3840a09a3bfeac32aed68cfd7fa9ac952f41a00cabe335f806caa2966f3f1',
    '3f8e251d261deba8b6b0a08f79c5b901416655278d748606d102fa896f32b913'],
  ['@agentclientprotocol/sdk', ['dist'], /^dist\/(?:examples\/[^/]+\.js|(?:[^/]+\/)?[^/]+\.test\.js)$/, 26,
    '89bbcd7a71a3cd6e94b7096ef1f239dda62b5fb8aef840d3475af3fbfff3a955',
    '990c3758d4d8a05c65f7df74d5570919531b2e32d80bb6a9f73e3585395118cf'],
  ['node-pty', ['lib', 'src'], /^(?:lib\/[^/]+\.test\.js|src\/[^/]+\.test\.ts)$/, 12,
    '1dc1f9b4eb3f9a5013d5ebaf6eb266d25597137b5623521c6656e848a0cb6f87',
    'df27266488ee4d92f3c8ff53798498b3335dded7af30be75b881737daee1a43a'],
  ['node-pty', ['deps/winpty'], /^deps\/winpty\/(?:[^/]+\/)*(?:Makefile|configure|[^/]+\.(?:bat|cc|gyp|gypi|h|mk|ps1|py|sh|yml))$/, 157,
    '1dc1f9b4eb3f9a5013d5ebaf6eb266d25597137b5623521c6656e848a0cb6f87',
    '513f6713966a3a3ee85ff14b27a9f3418aaecc7e6428dd79bfdd3e2eac85b470'],
  ['fast-uri', ['.github', 'benchmark'], /^(?:benchmark\/[^/]+\.(?:mjs|json)|\.github\/(?:workflows\/)?[^/]+\.yml)$/, 11,
    '06728ad83c4df979c6895d089452622441e34afe9b1c24584e2acac8d94a2876',
    '5f53b012386c2062a9ef54e5db72b8c97005326227b1b2809f3b8cbcfda53689'],
  ['json-schema-traverse', ['.github', 'spec'], /^(?:spec\/(?:fixtures\/[^/]+\.js|index\.spec\.js)|\.github\/(?:workflows\/)?[^/]+\.ya?ml)$/, 5,
    '156fb24af02845c190701360d06dfda35ef04282e34a734289ea9535ad9819ae',
    '073720f784ed582578fa357b9fc063f8281dcc9edac8571e0ef8592d9ef43c07'],
  ['@stablelib/base64', ['lib'], /^lib\/base64\.(?:test|bench)\.js$/, 2,
    '7821116cc9ab0fb2542c1407ac5e34ff78bcc70b2d1295b753a9ea16134b3df7',
    '19a91ac64530155292f274a0b2d1bcd6e1a2385b360b104435dfeb7a69054efb'],
];

function collectFiles(root, directory, pattern, files) {
  const path = join(root, directory);
  if (!existsSync(path)) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const relative = directory + '/' + entry.name;
    if (entry.isDirectory()) collectFiles(root, relative, pattern, files);
    if (entry.isFile() && pattern.test(relative)) files.push(relative);
  }
}

export function bundledDevelopmentFiles(stage, log = console.log) {
  const omitted = new Set();
  for (const [name, directories, pattern, count, manifestHash, contentHash] of reviewed) {
    const prefix = 'node_modules/' + name;
    const root = join(stage, prefix);
    const manifest = join(root, 'package.json');
    if (!existsSync(manifest)) continue;
    const files = [];
    if (createHash('sha256').update(readFileSync(manifest)).digest('hex') === manifestHash) {
      for (const directory of directories) collectFiles(root, directory, pattern, files);
    }
    const fingerprint = createHash('sha256');
    for (const file of files.sort()) {
      fingerprint.update(file + '\0').update(readFileSync(join(root, file))).update('\0');
    }
    if (files.length !== count || fingerprint.digest('hex') !== contentHash) {
      log('[pack-core] Keep development files in ' + name + ': package differs from the reviewed copy');
      continue;
    }
    for (const file of files) omitted.add(prefix + '/' + file);
  }
  log('[pack-core] Omit ' + omitted.size + ' reviewed development files from the bundled core ZIP');
  return omitted;
}

const reviewedCoreManifest = '2a694f0180a778c1c083fdc0369500d3638fa72457aee882e0aeedf14581f2ff';

function childDirectories(stage, folder) {
  const path = join(stage, folder);
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .map(entry => folder + '/' + entry.name);
}

function collectEmptyLeaves(stage, folder, result) {
  const path = join(stage, folder);
  if (!existsSync(path)) return;
  const entries = readdirSync(path, { withFileTypes: true });
  if (entries.length === 0) {
    result.push(folder);
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) collectEmptyLeaves(stage, folder + '/' + entry.name, result);
  }
}

// The existing core prune has already removed the declaration and test files
// in these leaves. Keep any populated leaves and unknown empty directories.
export function bundledEmptyDevelopmentDirectories(stage, log = console.log) {
  const result = new Set();
  const manifest = join(stage, 'node_modules/@deepseek-ai/dsh/package.json');
  if (!existsSync(manifest) || createHash('sha256').update(readFileSync(manifest)).digest('hex') !== reviewedCoreManifest) {
    log('[pack-core] Keep empty development directories: upstream core differs from the reviewed copy');
    return result;
  }
  const deepseek = childDirectories(stage, 'node_modules/@deepseek-ai');
  const aws = ['@aws', '@aws-sdk', '@smithy'].flatMap(scope => childDirectories(stage, 'node_modules/' + scope));
  const zod = ['node_modules/zod', ...deepseek.map(dir => dir + '/node_modules/zod')];
  const rules = [
    ['DeepSeek declaration', deepseek, ['lib/types'], 312,
      '0a15bb34b392c1353e29bd91454ddd7867c793812b5c725d86d0a500f4d733a2'],
    ['AWS declaration', aws, ['dist-types'], 288,
      'c6ee08510ae18807800a70d864d9a84d753ab6ef25a031e9e98aae17ae97d645'],
    ['Zod test', zod, ['src/v3/tests', 'src/v4/classic/tests', 'src/v4/core/tests', 'src/v4/mini/tests'], 272,
      'c61fa0c91240cb86ec3d7fec4128cac73ad8fe85e48fa8eaacd066e8dcbb0d8a'],
  ];
  for (const [name, owners, folders, count, contentHash] of rules) {
    const leaves = [];
    for (const owner of owners) {
      for (const folder of folders) collectEmptyLeaves(stage, owner + '/' + folder, leaves);
    }
    const digest = createHash('sha256');
    for (const leaf of leaves.sort()) digest.update(leaf + '\0');
    if (leaves.length !== count || digest.digest('hex') !== contentHash) {
      log('[pack-core] Keep empty ' + name + ' directories: paths differ from the reviewed set');
      continue;
    }
    for (const leaf of leaves) result.add(leaf);
  }
  log('[pack-core] Omit ' + result.size + ' reviewed empty development directories from the bundled core ZIP');
  return result;
}
