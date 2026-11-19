#!/usr/bin/env node
/**
 * Guest VM memory scheduling must use two hardware tiers:
 *
 * - nominal 12 GB devices keep the existing low-resource policy;
 * - nominal 16 GB and above use the performance policy on every device form.
 *
 * Linux reports nominal 16 GB devices below 16384 MiB, so the split uses
 * MemTotal >= 14 GiB as the practical boundary between 12 GB and 16 GB SKUs.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const VM = join(ROOT, 'hostcore/plugins/dshm-vm-bash/lib/vm.js');
const INDEX = join(ROOT, 'hostcore/plugins/dshm-vm-bash/lib/index.js');
const SOURCE = readFileSync(VM, 'utf8');
const INDEX_SOURCE = readFileSync(INDEX, 'utf8');
const mod = await import(pathToFileURL(VM).href);

const fails = [];
const ok = (cond, label) => {
  if (!cond) fails.push(label);
};

const MIB_12G = 11700;
const MIB_16G = 15400;
const MIB_24G = 23000;

const hasFunctions = ['memoryTier', 'vmMemoryMib', 'tcgBufferMib', 'vmMinAvailableMib', 'prewarmPlan']
  .every((name) => typeof mod[name] === 'function');
ok(hasFunctions, 'tier policy functions exist');
if (hasFunctions) {
  ok(mod.memoryTier(MIB_12G) === 'economy', '12G class -> economy');
  ok(mod.memoryTier(MIB_16G) === 'performance', '16G class -> performance');
  ok(mod.memoryTier(MIB_24G) === 'performance', '24G class -> performance');
  ok(mod.memoryTier(null) === 'economy', 'unknown total memory -> economy');

  ok(mod.vmMemoryMib({}, MIB_12G) === 512, '12G guest memory is 512 MiB');
  ok(mod.vmMemoryMib({}, MIB_16G) === 1024, '16G guest memory is 1024 MiB');
  ok(mod.vmMemoryMib({}, MIB_24G) === 1024, '24G guest memory is 1024 MiB');
  ok(mod.vmMemoryMib({ DSHM_VM_MEMORY_MIB: '1024' }, MIB_12G) === 1024,
    'explicit memory override still wins on 12G');

  ok(mod.tcgBufferMib({}, MIB_12G) === 128, '12G TCG buffer is 128 MiB');
  ok(mod.tcgBufferMib({}, MIB_16G) === 512, '16G TCG buffer is 512 MiB');
  ok(mod.vmMinAvailableMib({}, MIB_12G) === 1280, '12G launch floor stays 1280 MiB');
  ok(mod.vmMinAvailableMib({}, MIB_16G) === 1792, '16G launch floor is 1792 MiB');

  ok(mod.prewarmPlan({}, MIB_12G).enabled === false, '12G prewarm stays off by default');
  ok(mod.prewarmPlan({}, MIB_16G).enabled === true, '16G prewarm is on by default');
  ok(mod.prewarmPlan({ DSHM_VM_PREWARM: 'off' }, MIB_16G).enabled === false,
    'explicit prewarm off wins on 16G');
  ok(mod.prewarmPlan({ DSHM_VM_PREWARM: 'on' }, MIB_12G).enabled === true,
    'explicit prewarm on still works on 12G');
}

ok(SOURCE.includes('const budget = memBudget(vmMinAvailableMib())'),
  'ensureRunning consumes the tiered launch floor');
ok(SOURCE.includes('tcgBufferMib()'), 'boot argv consumes the tiered TCG buffer');
ok(/memoryTier:\s*profile\.tier/.test(SOURCE), 'diagnostics expose the selected tier');
ok(/totalMemoryMib:\s*profile\.totalMib/.test(SOURCE),
  'diagnostics expose total physical memory');
ok(INDEX_SOURCE.includes('vmTierProfile') && INDEX_SOURCE.includes('VM 内存档位：'),
  'Host startup log exposes the selected memory profile');

if (fails.length === 0) {
  console.log('PASS  VM memory tiers: 12G economy / 16G+ performance');
  process.exit(0);
}

console.error('FAIL  VM memory tier policy');
for (const item of fails) console.error('  - ' + item);
process.exit(1);
