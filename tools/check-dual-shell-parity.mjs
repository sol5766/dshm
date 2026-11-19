#!/usr/bin/env node
/*
 * check-dual-shell-parity.mjs —— P0-2 防漂移（docs/388 / docs/389）
 *
 * 【为什么需要】entry 与 phone 两个产品壳靠「整文件复制后微调」维护：WebApp 5772 行
 * 相同、105/107 函数同名、33 个 *_SHIM_JS 常量双份，另有 7 个 ArkTS 文件逐字节相同。
 * 共享段一旦只改一侧就会静默漂移（HmsSpeechBridge 已差 12 行、SystemSpeechRecognizer
 * 差 2 行）。结构性抽取（共享 HAR）单独立项，本门禁先在**不改壳**的前提下把这 7 个
 * 纯共享文件钉死：任一侧单独改动立即判红，逼迫双写或按 docs/389 抽取。
 *
 * 【用法】node tools/check-dual-shell-parity.mjs [--self-test]
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

/** 未来抽共享 HAR 的第一批候选：当前两壳逐字节相同、且没有形态差异。 */
const SHARED = [
  'agentextability/AgentExtAbility.ets',
  'entrybackupability/EntryBackupAbility.ets',
  'form/CardState.ets',
  'form/UsageFormAbility.ets',
  'form/pages/UsageCard.ets',
  'insightintents/StartNewSessionImpl.ets',
  'system/CardStateWatcher.ets',
];
const SHARED_COUNT = 7;

/** 纯判据：入参是两壳的相对路径 → sha256 映射，返回失败原因数组。 */
function evaluate({ entryHashes, phoneHashes, shared = SHARED }) {
  const fails = [];
  const need = (cond, label) => { if (!cond) fails.push(label); };
  need(shared.length === SHARED_COUNT, 'E0 共享清单被改动（不得靠缩短清单绕过）');
  for (const rel of shared) {
    const a = entryHashes[rel];
    const b = phoneHashes[rel];
    need(typeof a === 'string' && typeof b === 'string', `E1 ${rel} 在一侧缺失`);
    need(typeof a === 'string' && typeof b === 'string' && a === b, `E2 ${rel} 两壳内容漂移`);
  }
  return fails;
}

function hashes(side) {
  const base = join(ROOT, side, 'src/main/ets');
  const out = {};
  for (const rel of SHARED) {
    const p = join(base, rel);
    if (existsSync(p)) {
      out[rel] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  }
  return out;
}

if (SELF_TEST) {
  const base = { entryHashes: hashes('entry'), phoneHashes: hashes('phone') };
  const clean = evaluate(base);
  if (clean.length > 0) {
    console.error('FAIL：未变异的事实就没过判据：' + clean.join('；'));
    process.exit(1);
  }
  const mutations = [
    ['M1 单侧改动一个共享文件', (f) => ({ ...f, phoneHashes: { ...f.phoneHashes, [SHARED[0]]: 'deadbeef' } })],
    ['M2 单侧删掉一个共享文件', (f) => ({ ...f, phoneHashes: Object.fromEntries(Object.entries(f.phoneHashes).filter(([k]) => k !== SHARED[2])) })],
    ['M3 两侧同时缺失', (f) => ({ ...f, entryHashes: {}, phoneHashes: {} })],
    ['M4 偷偷缩短共享清单', (f) => ({ ...f, shared: SHARED.slice(0, 6) })],
  ];
  let passed = 0;
  for (const [label, mutate] of mutations) {
    const fails = evaluate(mutate(base));
    if (fails.length === 0) {
      console.error(`FAIL：${label} 没有判红`);
      process.exit(1);
    }
    passed += 1;
  }
  console.log(`OK：check-dual-shell-parity --self-test ${passed}/${mutations.length} 个变异体全部判红`);
  process.exit(0);
}

const fails = evaluate({ entryHashes: hashes('entry'), phoneHashes: hashes('phone') });
if (fails.length > 0) {
  console.error('FAIL：' + fails.join('；'));
  process.exit(1);
}
console.log(`OK：双壳 ${SHARED_COUNT} 个纯共享 ArkTS 文件逐字节一致（P0-2 抽取前的防漂移闸）`);
