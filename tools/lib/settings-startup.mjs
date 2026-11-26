import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const settingsFile = 'node_modules/@deepseek-ai/dsh-settings/lib/index.js';
const upstreamHash = '411ae83e6ce9c082ba965f04f9104b42bc3400f98ff4f5546af49c0c54ad7747';
const marker = 'const dshmDescribeForms = Symbol("dshmDescribeForms");';
const describe = '\tdescribe(options) {\n\t\tconst active';
const listForms = '\t\tconst descriptors = this.ownerContext.configEditor.configuration().flatMap(({ entry, inherited, override }) => {';
const renderValues = '\t\t\tconst value = projectForm(form, plainConfig(entry.fiber.effectiveConfig));';

const changes = [
  ['var SettingsForms = class', marker + '\nvar SettingsForms = class'],
  ['\t\t\t\tthis.describe();',
    '\t\t\t\tif (globalThis.__dshmStartupSettingsRevisions === true) this[dshmDescribeForms](undefined, false);\n'
    + '\t\t\t\telse this.describe();'],
  [describe, '\tdescribe(options) {\n\t\treturn this[dshmDescribeForms](options, true);\n\t}\n'
    + '\t[dshmDescribeForms](options, includeValues) {\n\t\tconst active'],
  [listForms, '\t\tconst editor = this.ownerContext.configEditor;\n'
    + '\t\tconst entries = includeValues ? editor.configuration() : editor.entries().map(entry => ({ entry }));\n'
    + '\t\tconst descriptors = entries.flatMap(({ entry, inherited, override }) => {'],
  [renderValues, '\t\t\tif (!includeValues) return [];\n' + renderValues],
];

function replaceOne(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Review settings startup anchor: ' + before.trim().slice(0, 64));
  return source.replace(before, () => after);
}

export function settingsStartupSource(source, enabled = true) {
  let original = source;
  if (source.includes(marker)) {
    for (const [before, after] of changes.toReversed()) original = replaceOne(original, after, before);
  }
  if (createHash('sha256').update(original).digest('hex') !== upstreamHash) {
    throw new Error('Review upstream settings revisions and startup configuration projection');
  }
  if (!enabled) return original;
  return changes.reduce((text, [before, after]) => replaceOne(text, before, after), original);
}

export function patchSettingsStartup(stage) {
  const file = join(stage, settingsFile);
  const current = readFileSync(file, 'utf8');
  const next = settingsStartupSource(current);
  if (current === next) return;
  const temp = file + '.dshm-' + process.pid + '.tmp';
  writeFileSync(temp, next);
  renameSync(temp, file);
}
