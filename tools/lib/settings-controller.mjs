import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const controllerFile = 'node_modules/@deepseek-ai/dsh-api-settings-controller/lib/index.js';
const upstreamHash = '36204d6b456997563cf6e5026589b67fa71707c5db35caf708fbb35ccee3dea1';
const marker = 'settings.describeNamespace === void 0';
const descriptorLine = '\t\t\tconst descriptor = settings.describe({ redactSecrets: true }).find((candidate) => candidate.ns === namespace);';

const changes = [
  [descriptorLine,
    '\t\t\tconst descriptor = settings.describeNamespace === void 0\n'
    + '\t\t\t\t? settings.describe({ redactSecrets: true }).find((candidate) => candidate.ns === namespace)\n'
    + '\t\t\t\t: settings.describeNamespace(namespace, { redactSecrets: true });'],
];

function replaceOne(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Review settings controller anchor: ' + before.trim().slice(0, 64));
  return source.replace(before, () => after);
}

export function settingsControllerSource(source, enabled = true) {
  let original = source;
  if (source.includes(marker)) {
    for (const [before, after] of changes.toReversed()) original = replaceOne(original, after, before);
  }
  if (createHash('sha256').update(original).digest('hex') !== upstreamHash) {
    throw new Error('Review upstream settings controller write response');
  }
  if (!enabled) return original;
  return changes.reduce((text, [before, after]) => replaceOne(text, before, after), original);
}

export function patchSettingsController(stage) {
  const file = join(stage, controllerFile);
  const current = readFileSync(file, 'utf8');
  const next = settingsControllerSource(current);
  if (current === next) return;
  const temp = file + '.dshm-' + process.pid + '.tmp';
  writeFileSync(temp, next);
  renameSync(temp, file);
}
