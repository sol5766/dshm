#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const platformIndex = read('platform/src/main/ets/Index.ets');
const runtimePort = read('hostruntime/src/main/ets/runtime/RuntimePort.ets');
const runtimeIndex = read('hostruntime/src/main/ets/Index.ets');
const doneSoundPath = join(ROOT, 'platform/src/main/ets/notify/DoneSound.ets');
const assets = [
  'entry/src/main/resources/rawfile/notify_done.wav',
  'phone/src/main/resources/rawfile/notify_done.wav'
];
const baseline = {
  platformIndex, runtimePort, runtimeIndex,
  doneSoundExists: existsSync(doneSoundPath),
  assetsPresent: assets.map((rel) => existsSync(join(ROOT, rel)))
};

function judge(state) {
  const failures = [];
  if (state.doneSoundExists) failures.push('DoneSound.ets must be removed');
  if (/doneSound|DoneSound/.test(state.platformIndex)) failures.push('platform Index must not export DoneSound');
  if (/notWiredProbe|NotWiredRuntime/.test(state.runtimePort)) failures.push('RuntimePort must not define removed implementation');
  if (/notWiredProbe|NotWiredRuntime/.test(state.runtimeIndex)) failures.push('hostruntime Index must not export removed implementation');
  if (!/export enum RuntimeKind/.test(state.runtimePort) || !/NONE\s*=\s*'none'/.test(state.runtimePort)) {
    failures.push('RuntimeKind.NONE must remain');
  }
  for (const name of ['NativeFact', 'RuntimeProbe', 'HostHandle', 'RuntimePort']) {
    if (!new RegExp(`export interface ${name}\\b`).test(state.runtimePort)) failures.push(`${name} interface must remain`);
  }
  for (let i = 0; i < assets.length; i += 1) {
    if (!state.assetsPresent[i]) failures.push(`${assets[i]} protected asset must remain`);
  }
  return failures;
}
const failures = judge(baseline);

if (process.argv.includes('--self-test')) {
  const mutations = [
    ['restore DoneSound file', { doneSoundExists: true }],
    ['restore DoneSound export', { platformIndex: platformIndex + "\nexport { DoneSound } from './notify/DoneSound';" }],
    ['restore doneSound singleton export', { platformIndex: platformIndex + "\nexport { doneSound } from './notify/DoneSound';" }],
    ['restore notWiredProbe', { runtimePort: runtimePort + '\nexport function notWiredProbe() {}' }],
    ['restore NotWiredRuntime', { runtimePort: runtimePort + '\nexport class NotWiredRuntime {}' }],
    ['restore runtime barrel export', { runtimeIndex: runtimeIndex + "\nexport { NotWiredRuntime } from './runtime/RuntimePort';" }],
    ['remove NONE enum', { runtimePort: runtimePort.replace(/NONE\s*=\s*'none'/, "REMOVED = 'none'") }],
    ...['NativeFact', 'RuntimeProbe', 'HostHandle', 'RuntimePort'].map((name) =>
      [`remove ${name} interface`, { runtimePort: runtimePort.replace(`export interface ${name}`, `interface Removed${name}`) }]),
    ['remove entry protected audio', { assetsPresent: [false, true] }],
    ['remove phone protected audio', { assetsPresent: [true, false] }]
  ];
  let selfTestFailures = 0;
  for (const [label, patch] of mutations) {
    const mutated = { ...baseline, ...patch };
    const red = JSON.stringify(mutated) !== JSON.stringify(baseline) && judge(mutated).length > 0;
    console.log(`${red ? 'PASS' : 'FAIL'} self-test: ${label}`);
    if (!red) selfTestFailures += 1;
  }
  if (selfTestFailures > 0) process.exit(1);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log('PASS targeted residual cleanup');
