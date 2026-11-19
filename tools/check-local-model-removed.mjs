import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const paths = [
  'appstate/src/main/ets/model/PiAiProviders.ets',
  'appstate/src/main/ets/Index.ets',
  'entry/src/main/ets/pages/Index.ets',
  'entry/src/main/ets/view/TabContentView.ets',
  'entry/src/main/ets/view/SettingsPane.ets',
  'entry/src/main/ets/view/SettingsModels.ets'
];
const root = new URL('../', import.meta.url);
const sources = paths.map(path => readFileSync(new URL(path, root), 'utf8'));
const forbidden = /ollama|11434|ollamaLocalProfile|desktopModelShortcutVisible|localModelShortcutMode|piAiPresetDraft|onAddLocalModelProvider|\bdesktopHost\b/i;
const required = [
  [0, /export interface PiAiProviderView\b/],
  [0, /export function emptyProviderView\b/],
  [0, /export function projectPiAiProviders\b/],
  [0, /export function buildRouteProfile\b/],
  [1, /export type \{ PiAiFieldCheck, PiAiModelRow, PiAiProviderView \} from '\.\/model\/PiAiProviders'/],
  [2, /this\.piAiDraft = emptyProviderView\(protocols\.length > 0 \? protocols\[0\] : ''\);/],
  [2, /private openPiAiSheet\(mode: string, route: string\): void/],
  [2, /private async submitPiAiSheet\(\): Promise<void>/],
  [2, /this\.piAiDraft = found;/],
  [3, /this\.f\.openPiAiSheet\(PiAiSheetMode\.CREATE, ''\)/],
  [3, /this\.f\.openPiAiSheet\(PiAiSheetMode\.EDIT, route\)/],
  [4, /this\.onAddProvider\(\)/],
  [4, /this\.onEditProvider\(route\)/],
  [5, /Button\('添加自定义模型 API'\)/],
  [5, /this\.onAddProvider\(\)/],
  [5, /ForEach\(this\.piAiProviders,/],
  [5, /this\.onEditProvider\(p\.route\)/]
];
const genericExports = [
  'checkRoute', 'checkBaseURL', 'checkProtocol', 'checkModels', 'checkApiKeyDraft',
  'deriveKeyRef', 'emptyProviderView', 'buildRouteProfile', 'projectPiAiProviders'
];
for (const name of genericExports) {
  required.push([0, new RegExp(`export function ${name}\\b`)]);
  required.push([1, new RegExp(`\\b${name}\\b`)]);
}

function check(texts) {
  const errors = [];
  texts.forEach((text, index) => {
    if (forbidden.test(text)) errors.push(`${paths[index]}: local-model residue`);
  });
  for (const [index, pattern] of required) {
    if (!pattern.test(texts[index])) errors.push(`${paths[index]}: missing ${pattern}`);
  }
  return errors;
}

const errors = check(sources);
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}
if (process.argv.includes('--self-test')) {
  let controls = 0;
  for (let index = 0; index < sources.length; index++) {
    for (const residue of ['ollama-local', 'http://127.0.0.1:11434/v1',
      'ollamaLocalProfile', 'desktopModelShortcutVisible', 'localModelShortcutMode',
      'piAiPresetDraft', 'onAddLocalModelProvider', 'desktopHost']) {
      const mutated = [...sources];
      mutated[index] += `\n${residue}\n`;
      assert.ok(check(mutated).length > 0, `missed residue: ${index}/${residue}`);
      controls++;
    }
  }
  for (const [index, pattern] of required) {
    const mutated = [...sources];
    mutated[index] = mutated[index].replace(pattern, 'REMOVED');
    assert.notEqual(mutated[index], sources[index], `ineffective mutation: ${pattern}`);
    assert.ok(check(mutated).length > 0, `missed generic API removal: ${pattern}`);
    controls++;
  }
  console.log(`PASS: ${controls} negative controls; no source files written`);
}
console.log(`PASS: local-model removal and generic API retention (${paths.length} source files, ${fileURLToPath(root)})`);
