import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { cordisStartupSource } from './lib/cordis-startup.mjs';

const arg = process.argv.indexOf('--stage');
assert(arg >= 0 && process.argv[arg + 1], 'Use --stage <packed core tree>');
const file = resolve(process.argv[arg + 1], 'node_modules/@deepseek-ai/cordis/lib/index.js');
const source = readFileSync(file, 'utf8');
const baseline = cordisStartupSource(source, false);
function verifyPatched(text) {
  assert.equal(cordisStartupSource(text), text, 'Expected the packed Cordis patch');
}
verifyPatched(source);
assert.notEqual(source, baseline);
assert.equal(cordisStartupSource(baseline), source);

function specialProperty(text) {
  const start = text.indexOf('function isSpecialProperty(prop) {');
  const end = text.indexOf('\n}', start);
  assert(start >= 0 && end > start);
  return runInNewContext('const RESERVED_WORDS = ["prototype", "then"];\n'
    + text.slice(start, end + 2) + '\nisSpecialProperty;');
}
const before = specialProperty(baseline);
const after = specialProperty(source);
for (const name of ['', 'then', 'prototype', '_field', 'NaN', '-0', '-1', '0', '01', '1e+21', '+1',
  '0x10', '18446744073709551616', 'Ｘ', '0xFF', Symbol('key')]) {
  assert.equal(after(name), before(name), String(name));
}
for (let code = 0; code < 128; code++) {
  for (const suffix of ['', '0', '123', 'thing']) {
    const name = String.fromCharCode(code) + suffix;
    assert.equal(after(name), before(name), name);
  }
}

const { Context } = await import(pathToFileURL(file).href);
const root = new Context();
root.provide('testValue', 42);
root.accessor('testComputed', {
  get(_receiver, error) {
    assert(error instanceof Error);
    return this.testValue + 1;
  },
});
let active;
await root.plugin({
  inject: ['testValue'],
  apply(ctx) {
    assert.equal(ctx.testValue, 42);
    assert.equal(ctx.testComputed, 43);
    assert.throws(() => ctx.notDeclared, /without inject/);
    active = ctx;
  },
});
assert(active);
const detach = root.on('internal/get', (_ctx, name, error, next) => {
  assert(error instanceof Error);
  return name === 'testValue' ? 'observed ' + next() : next();
});
assert.equal(active.testValue, 'observed 42');
detach();
assert.equal(active.testValue, 42);
const events = root.events;
const original = events.waterfall;
events.waterfall = function (...args) {
  if (args[0] === 'internal/get' && args[2] === 'testValue') return 17;
  return original.apply(this, args);
};
assert.equal(active.testValue, 17);
events.waterfall = original;
assert.equal(active.testValue, 42);
await root.fiber.dispose();
if (process.argv.includes('--self-test')) {
  assert.throws(() => verifyPatched(baseline), assert.AssertionError);
  assert.throws(() => verifyPatched(source.replace('events.waterfall === defaultEventWaterfall', 'true')));
}
console.log('PASS: Cordis fast reads preserve accessors, live observers, custom dispatch and injection errors');
