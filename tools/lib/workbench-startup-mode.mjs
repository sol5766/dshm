import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const upstreamHash = '2c332b1ed36583c102549a73ae8d5c6b92f88f978d024963772189ed3ba006c9';
const renderHead = '(open) => `${open}<base href="./">`';
const modeHead = '(open) => `${open}<base href="./">${workbenchStartupTags()}`';
const apply = 'function apply(ctx, config) {';
const tags = [
  'function workbenchStartupTags() {',
  '\tlet tags = "";',
  '\tif (process.env.DSHM_WORKBENCH_STARTUP === "1" && process.env.DSHM_CLIENT_HMR_POLL !== "1") {',
  '\t\ttags += \'<meta name="dshm-workbench-startup" content="1">\';',
  '\t}',
  '\tif (process.env.DSHM_WORKBENCH_TIMING === "1") tags += \'<meta name="dshm-workbench-timing" content="1">\';',
  '\tif (process.env.DSHM_WORKBENCH_DIAGNOSTICS === "1") tags += \'<meta name="dshm-workbench-diagnostics" content="1">\';',
  '\treturn tags;',
  '}',
  '',
].join('\n');

export function workbenchStartupModeSource(source, enabled = true) {
  const original = source.replace(modeHead, renderHead).replace(tags + apply, apply);
  if (createHash('sha256').update(original).digest('hex') !== upstreamHash
    || original.split(renderHead).length !== 2 || original.split(apply).length !== 2) {
    throw new Error('Review the authenticated frontend index renderer before setting startup mode');
  }
  const patched = original.replace(renderHead, modeHead).replace(apply, tags + apply);
  if (source !== original && source !== patched) throw new Error('Incomplete workbench startup mode');
  return enabled ? patched : original;
}

export function patchWorkbenchStartupMode(stage) {
  const file = join(stage, 'node_modules', '@deepseek-ai', 'dsh-host-frontend-static', 'lib', 'index.js');
  const before = readFileSync(file, 'utf8');
  const after = workbenchStartupModeSource(before);
  if (before === after) return;
  const temporary = file + '.dshm-' + process.pid + '.tmp';
  writeFileSync(temporary, after);
  renameSync(temporary, file);
}
