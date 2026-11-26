import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createZodFactory, isBundledZodBenchmarks, verifyZodFactories } from './lib/zod-factories-startup.mjs';

const { values } = parseArgs({ options: { stage: { type: 'string' }, 'self-test': { type: 'boolean' } } });
assert(values.stage, 'Use --stage with a packed core working tree');
const stage = resolve(values.stage);
const copies = verifyZodFactories(stage);
const packageRoot = owner => join(stage, 'node_modules/@deepseek-ai', owner, 'node_modules/zod');
const load = (owner, file) => import(pathToFileURL(join(packageRoot(owner), file)));
const owners = ['dsh-cua', 'dsh-goal'];
const [primary, secondary] = await Promise.all(owners.map(owner => load(owner, 'index.js')));
const a = primary.z;
const b = secondary.z;

assert.notEqual(a.ZodString, b.ZodString);
assert.notEqual(a.core.$ZodString, b.core.$ZodString);
assert.notEqual(a.core.$ZodString.prototype, b.core.$ZodString.prototype);
assert.notEqual(a.core.compile, b.core.compile);
assert.notEqual(a.core.parse, b.core.parse);
assert.notEqual(a.core.$ZodError, b.core.$ZodError);
assert.notEqual(a.core.regexes.email, b.core.regexes.email);
assert.equal(a.globalRegistry, b.globalRegistry);
assert.equal(a.config(), b.config());

const schema = a.object({
  tag: a.literal('task'),
  title: a.string().min(3),
  count: a.number().int().positive(),
  items: a.array(a.union([a.string(), a.null()])),
});
const valid = { tag: 'task', title: 'host', count: 3, items: [null, 'text'] };
const invalid = { tag: 'other', title: 'x', count: -1, items: [false] };
assert.deepEqual(schema.parse(valid), valid);
const failed = await schema.safeParseAsync(invalid);
assert(failed.error instanceof a.ZodError);
assert.deepEqual(failed.error.issues.map(issue => issue.code),
  ['invalid_value', 'too_small', 'too_small', 'invalid_union']);
const metadata = a.registry();
const separate = b.registry();
metadata.add(schema, { id: 'local-item' });
assert.equal(metadata.get(schema).id, 'local-item');
assert.equal(separate.get(schema), undefined);
const restored = a.fromJSONSchema(a.toJSONSchema(schema));
assert.equal(restored.safeParse(valid).success, true);
assert.equal(restored.safeParse(invalid).success, false);

const [core, classic, compiler, mini] = await Promise.all([
  load(owners[0], 'v4/core/schemas.js'), load(owners[0], 'v4/classic/schemas.js'),
  load(owners[0], 'v4/core/compile.js'), load(owners[0], 'v4/mini/index.js'),
]);
assert.equal(a.core.$ZodString, core.$ZodString);
assert.equal(a.ZodString, classic.ZodString);
assert.equal(a.core.compile, compiler.compile);
assert.equal(mini.string().safeParse('small').success, true);
assert.equal(mini.string().safeParse(3).success, false);

if (values['self-test']) {
  const benchmarkPath = 'node_modules/@deepseek-ai/dsh-cua/node_modules/zod/src/v3/benchmarks';
  const zodPath = 'node_modules/@deepseek-ai/dsh-cua/node_modules/zod';
  assert.equal(isBundledZodBenchmarks(stage, benchmarkPath), true);
  assert.equal(isBundledZodBenchmarks(stage, zodPath + '/src/v3'), false);
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'dshm-zod-benchmarks-')));
  assert.equal(dirname(fixture), realpathSync(tmpdir()));
  try {
    mkdirSync(join(fixture, zodPath), { recursive: true });
    cpSync(join(stage, zodPath, 'package.json'), join(fixture, zodPath, 'package.json'));
    cpSync(join(stage, benchmarkPath), join(fixture, benchmarkPath), { recursive: true });
    assert.equal(isBundledZodBenchmarks(fixture, benchmarkPath), true);
    writeFileSync(join(fixture, benchmarkPath, 'index.ts'), 'export const changed = true;');
    assert.equal(isBundledZodBenchmarks(fixture, benchmarkPath), false);
    cpSync(join(stage, benchmarkPath, 'index.ts'), join(fixture, benchmarkPath, 'index.ts'));
    writeFileSync(join(fixture, benchmarkPath, 'NOTICE'), 'Keep this notice.');
    assert.equal(isBundledZodBenchmarks(fixture, benchmarkPath), false);
    rmSync(join(fixture, benchmarkPath, 'NOTICE'));
    writeFileSync(join(fixture, zodPath, 'package.json'), '{}');
    assert.equal(isBundledZodBenchmarks(fixture, benchmarkPath), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }


  assert.throws(() => createZodFactory('export let mutable = 1;\n', 'make', './shared.mjs'),
    /Unconverted module syntax/);
  assert.throws(() => createZodFactory('export * from "./other.js";\n', 'make', './shared.mjs'),
    /Unconverted module syntax/);
  const { wrapper, implementation } = createZodFactory(
    'import { name as dep } from "./dep.js";\nconst slot = {};\nexport { slot as null };\nexport const one = dep;\n',
    'make', './shared.mjs');
  assert.match(wrapper, /slot as null/);
  assert.match(wrapper, /make\(dep\)/);
  assert.match(implementation, /return \{slot,one\}/);
}

console.log('PASS shared Zod ESM, known artifact hashes, per-copy identities, global state, parse, JSON Schema and mini across ' + copies + ' copies');
