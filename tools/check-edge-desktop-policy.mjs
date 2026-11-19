#!/usr/bin/env node
/**
 * MatePad Edge family must use one permanent desktop route.
 *
 * Contract:
 *   A. DeviceFacts recognizes the whole Edge family (QXS-* product models and
 *      market name "MatePad Edge") and reports form=desktop everywhere.
 *   B. The ArkTS -> Host env carries the product model and an explicit
 *      native-terminal-only policy.
 *   C. dshm-vm-bash may still provide the guest bash tool, but it must not wrap
 *      spawnTerminal / terminalEnvironment / resolveExecutable for this family.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const DEVICE = read('platform/src/main/ets/system/DeviceFacts.ets');
const NODE_RUNTIME = read('hostruntime/src/main/ets/runtime/NodeRuntime.ets');
const RUNTIME_PORT = read('hostruntime/src/main/ets/runtime/RuntimePort.ets');
const VM_INDEX = read('hostcore/plugins/dshm-vm-bash/lib/index.js');

const fails = [];
const ok = (cond, label) => {
  if (!cond) fails.push(label);
};

/* A. Device classification */
ok(DEVICE.includes('deviceInfo.productModel'), 'A1 productModel is read');
ok(DEVICE.includes('isDesktopPcSeriesFull'), 'A2 full desktop predicate exists');
ok(DEVICE.includes('QXS-') && DEVICE.includes('MATEPADEDGE') && DEVICE.includes('MATEBOOK'),
  'A2 predicate covers QXS / Edge / MateBook product families');
ok(DEVICE.includes('PRO_MAX_MARKET_TOKEN') && DEVICE.includes('TABLET_MARKET_TOKEN'),
  'A2 predicate covers MatePad Pro Max token variants');
ok(DEVICE.includes('readFamilyModel') && DEVICE.includes('productSeries') &&
  DEVICE.includes('productModelAlias'),
  'A2 product-family fallback is wired');
ok(DEVICE.includes('desktopForced') && DEVICE.includes('FormFactor.DESKTOP'),
  'A3 forced family publishes desktop form');
ok(/desktopForced\s*\?\s*FormFactor\.DESKTOP/.test(DEVICE),
  'A3 forced family overrides the system tablet form');
ok(/nativeTerminalOnly\s*:\s*form\s*===\s*FormFactor\.DESKTOP/.test(DEVICE),
  'A4 every desktop form (PC / 2in1 / Edge / Pro Max) is native-terminal-only');
/*
 * A5（2026-11-12 用户口径，最终）：型号族白名单**只留 `QXS`**（MatePad Edge）。
 *
 * 「PC / 2in1 / MateBook / MatePad Edge / MatePad Pro Max 走原生终端（sh / zsh / bash）；
 *  其余所有普通平板与手机都没有原生终端，只能走 guest VM。」
 *
 * 所以 MRX/MRR/MRD/MRO/DRA 这五个型号族**必须不在**白名单里 —— 它们在名单里就意味着
 * 普通 MatePad Pro 被判 desktop、VM 被关死、终端直接不可用（`MRO-W00` 真机事故）。
 * Pro Max 改由上面的 `PROMAX` + `MATEPAD` 市场名联合判定识别，不依赖型号族。
 */
function judgeTokens(deviceText) {
  const out = [];
  const m = /const EDGE_FAMILY_TOKENS: string\[\] = \[([^\]]*)\]/.exec(deviceText);
  if (m === null) {
    return ['A5 找不到 EDGE_FAMILY_TOKENS 定义'];
  }
  if (!m[1].includes("'QXS'")) {
    out.push('A5 型号族白名单丢了 QXS（MatePad Edge 会掉回手机/平板档）');
  }
  for (const token of ['MRX', 'MRR', 'MRD', 'MRO', 'DRA']) {
    if (m[1].includes(`'${token}'`)) {
      out.push(`A5 型号族 ${token} 不得在桌面白名单里（普通 MatePad 会被判 desktop ⇒ VM 关死 ⇒ 终端不可用）`);
    }
  }
  return out;
}
for (const item of judgeTokens(DEVICE)) fails.push(item);

/* B. ArkTS -> Host environment */
ok(RUNTIME_PORT.includes('deviceModel') && RUNTIME_PORT.includes('nativeTerminalOnly'),
  'B1 buildHostEnv accepts model and terminal policy');
ok(RUNTIME_PORT.includes('DSHM_DEVICE_MODEL='), 'B2 model env key is emitted');
ok(RUNTIME_PORT.includes('DSHM_NATIVE_TERMINAL_ONLY='),
  'B2 native-terminal env key is emitted');
ok(RUNTIME_PORT.includes('DSHM_VM_BASH=off') && RUNTIME_PORT.includes('DSHM_BASH_EXECUTABLE=/usr/bin/zsh'),
  'B2 native desktop disables guest VM and selects the native shell');
ok(RUNTIME_PORT.includes('DSHM_DEVICE_FAMILY=') && RUNTIME_PORT.includes('DSHM_NATIVE_LIBS='),
  'B2 product family and shared HSP native libs are forwarded');
ok(NODE_RUNTIME.includes('facts.productModel') &&
  NODE_RUNTIME.includes('facts.nativeTerminalOnly'),
  'B3 NodeRuntime forwards the two new facts');

/* C. Terminal route */
ok(VM_INDEX.includes('terminalTakeoverEnabled'),
  'C1 terminal route is a separately testable decision');
ok(VM_INDEX.includes('nativeExecutionOnly'),
  'C1 one native-execution decision guards both VM command and terminal routes');
ok(VM_INDEX.includes('DSHM_NATIVE_TERMINAL_ONLY'),
  'C1 native-terminal policy is consumed by the VM plugin');
ok(VM_INDEX.includes('不接管终端') && VM_INDEX.includes('系统原生终端'),
  'C2 native-only route is visible in Host diagnostics');
ok(/if\s*\(terminalTakeoverEnabled\(process\.env\)\)/.test(VM_INDEX),
  'C2 terminal wrappers are guarded by the native-only policy');

let vm = null;
try {
  vm = await import(pathToFileURL(join(ROOT, 'hostcore/plugins/dshm-vm-bash/lib/index.js')).href);
} catch (error) {
  fails.push('C3 VM plugin imports for behavior test: ' + String(error && error.message ? error.message : error));
}

if (vm !== null && typeof vm.terminalTakeoverEnabled === 'function') {
  ok(vm.terminalTakeoverEnabled({ DSHM_NATIVE_TERMINAL_ONLY: '1' }) === false,
    'C3 native terminal policy disables terminal takeover');
  ok(vm.terminalTakeoverEnabled({ DSHM_NATIVE_TERMINAL_ONLY: '0' }) === true,
    'C3 ordinary devices keep the guest terminal route');
  ok(vm.terminalTakeoverEnabled({}) === true,
    'C3 missing policy keeps backward-compatible guest terminal route');
  ok(vm.terminalTakeoverEnabled({ DSHM_DEVICE_FORM: 'desktop' }) === false,
    'C3 desktop form blocks terminal takeover even without the semantic flag');
  ok(vm.enabled({ DSHM_NATIVE_TERMINAL_ONLY: '1' }).enabled === false,
    'C3 native execution also blocks the guest command/prewarm route');
}

if (process.argv.includes('--self-test')) {
  const arms = [
    ['白名单加回 MRO（普通 MatePad Pro 必须判红）', DEVICE.replace(
      "const EDGE_FAMILY_TOKENS: string[] = ['QXS'];",
      "const EDGE_FAMILY_TOKENS: string[] = ['QXS', 'MRO'];")],
    ['白名单加回 MRX/MRR/MRD/DRA（必须判红）', DEVICE.replace(
      "const EDGE_FAMILY_TOKENS: string[] = ['QXS'];",
      "const EDGE_FAMILY_TOKENS: string[] = ['QXS', 'MRX', 'MRR', 'MRD', 'DRA'];")],
    ['白名单丢掉 QXS（Edge 必须判红）', DEVICE.replace(
      "const EDGE_FAMILY_TOKENS: string[] = ['QXS'];",
      "const EDGE_FAMILY_TOKENS: string[] = [];")],
  ];
  let bad = 0;
  console.log('== 对照臂：每条变异都必须判红 ==');
  for (const [name, mutated] of arms) {
    const got = judgeTokens(mutated);
    const good = got.length > 0 && mutated !== DEVICE;
    console.log(`  ${good ? 'ok  ' : 'FAIL'}  ${name}（问题数 ${got.length}）`);
    if (!good) bad += 1;
  }
  if (fails.length > 0 || bad > 0) {
    console.error(`\nFAIL  主检 ${fails.length} 条 / 对照臂 ${bad} 条未判红`);
    process.exit(1);
  }
  console.log('\nPASS  自检通过：主检 0 问题，3 个变异体全部判红。');
  process.exit(0);
}

if (fails.length === 0) {
  console.log('PASS  桌面档只含 PC / 2in1 / MateBook / Edge / Pro Max；其余平板与手机走 guest VM');
  process.exit(0);
}

console.error('FAIL  Edge desktop policy');
for (const item of fails) console.error('  - ' + item);
process.exit(1);
