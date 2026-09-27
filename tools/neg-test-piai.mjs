/*
 * 负测试：确认新增的 pi-ai 断言**真的在跑**（而不是被静默跳过）。
 * 纪律：每次篡改都必须断言替换真的发生，没发生即报错退出。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const GATE = 'tools/check-layout-fixtures.mjs';
const original = readFileSync(GATE, 'utf8');

/** 只改**源模块**的返回值，比改断言更硬：断言对不对，看它会不会因此变红 */
const MOD = 'appstate/src/main/ets/model/PiAiProviders.ets';
const modOriginal = readFileSync(MOD, 'utf8');

function run(label, mutatedMod, expectFail) {
  writeFileSync(MOD, mutatedMod, 'utf8');
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [GATE], { encoding: 'utf8', stdio: 'pipe',
      env: { ...process.env, DEVECO_CLI_CLT_PATH: process.env.DEVECO_CLI_CLT_PATH } });
  } catch (e) {
    code = e.status === undefined ? 1 : e.status;
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  const fails = out.split('\n').filter((l) => l.includes('✗'));
  const summary = out.split('\n').filter((l) => l.includes('断言 ')).pop() || '(no summary)';
  const ok = expectFail ? fails.length > 0 : fails.length === 0;
  console.log(`  [${label}] ${ok ? 'PASS' : 'FAIL'} — ${summary.trim()}`);
  for (const f of fails.slice(0, 4)) console.log(`       ${f.trim().slice(0, 100)}`);
  return ok;
}

let allOk = true;

console.log('=== 负测试 A：篡改 deriveKeyRef（应为 RED）===');
{
  const from = "return `${route.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;";
  const n = modOriginal.split(from).length - 1;
  if (n !== 1) { console.log(`  ANCHOR FAILED (${n})`); allOk = false; }
  else allOk = run('A', modOriginal.replace(from, "return 'WRONG_KEY';"), true) && allOk;
}

console.log('\n=== 负测试 B：篡改 isHttpUrl 恒真（端点校验失效，应为 RED）===');
{
  const from = "  const lower: string = value.trim().toLowerCase();";
  const n = modOriginal.split(from).length - 1;
  if (n !== 1) { console.log(`  ANCHOR FAILED (${n})`); allOk = false; }
  else allOk = run('B', modOriginal.replace(from, "  return true;\n  const lower: string = value.trim().toLowerCase();"), true) && allOk;
}

console.log('\n=== 负测试 C：篡改 checkModels 恒通过（应为 RED）===');
{
  const from = "  if (models.length === 0) {\n    return { ok: false, message: '至少需要一个模型（模型 id 是路由提供什么的唯一依据）。' };\n  }";
  const n = modOriginal.split(from).length - 1;
  if (n !== 1) { console.log(`  ANCHOR FAILED (${n})`); allOk = false; }
  else allOk = run('C', modOriginal.replace(from, ""), true) && allOk;
}

console.log('\n=== 负测试 D：篡改 piAiModelsPath 按下标写（应为 RED）===');
{
  const from = "  return ['providers', route, 'models'];";
  const n = modOriginal.split(from).length - 1;
  if (n !== 1) { console.log(`  ANCHOR FAILED (${n})`); allOk = false; }
  else allOk = run('D', modOriginal.replace(from, "  return ['providers', route, 'models', '0'];"), true) && allOk;
}

// 还原
writeFileSync(MOD, modOriginal, 'utf8');
console.log('\n=== 还原后应为 GREEN ===');
{
  let out = '';
  try {
    out = execFileSync(process.execPath, [GATE], { encoding: 'utf8', stdio: 'pipe',
      env: { ...process.env, DEVECO_CLI_CLT_PATH: process.env.DEVECO_CLI_CLT_PATH } });
  } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
  const summary = out.split('\n').filter((l) => l.includes('断言 ')).pop() || '(none)';
  const fails = out.split('\n').filter((l) => l.includes('✗'));
  console.log(`  ${fails.length === 0 ? 'PASS' : 'FAIL'} — ${summary.trim()}`);
  if (fails.length > 0) allOk = false;
}

console.log(`\n负测试总体：${allOk ? '全部按预期（新断言确实会红）' : '有问题'}`);
process.exit(allOk ? 0 : 1);
