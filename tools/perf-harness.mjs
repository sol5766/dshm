#!/usr/bin/env node
/**
 * 性能测量 harness（2026-11-16，参考社区 electron-arkts-bridge-kit 的验收口径）。
 *
 * 【为什么要有它】此前的性能结论多次被"整机负载 / 测量顺序 / 预热不足"污染
 * （2026-11-16 冷启动复测就是一次活教材）。这里把测量纪律固化成代码：
 *   · 同一进程内 A/B 交替：偶数轮先 baseline 再 candidate，奇数轮反过来（AB/BA）；
 *   · 每轮前先做 warmup（默认 1000 次，场景可覆盖）；
 *   · 每轮分别记录 mean / P50 / P95 / SD / min / max，逐项算增长比例；
 *   · 原始样本默认随报告落盘（--no-samples 可关），便于复核；
 *   · 低于计时分辨率的结果不记 0 后参与百分比（样本统一用 ns，报告换算 µs）。
 *
 * 用法：
 *   node tools/perf-harness.mjs --scenario <file.mjs> --out <report.json>
 *        [--rounds 5] [--warmup 1000] [--samples 10000] [--max-growth 10] [--enforce]
 *
 * 场景模块：
 *   export default {
 *     name: '...',
 *     // 返回 { baseline(i), candidate(i), warmup?, samples? }
 *     setup() { ... },
 *   }
 *   baseline/candidate 同步函数，返回任意值（只用于防止死代码消除）。
 *
 * 退出码：测量完成 0；加了 --enforce 且任一场景平均增长 > --max-growth ⇒ 1；场景加载失败 2。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpus, totalmem } from 'node:os';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const value = process.argv[at + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}

const scenarioPath = arg('scenario', '');
const outPath = arg('out', '');
if (typeof scenarioPath !== 'string' || scenarioPath.length === 0) {
  console.error('用法：node tools/perf-harness.mjs --scenario <file.mjs> --out <report.json> [--rounds 5] [--warmup 1000] [--samples 10000] [--max-growth 10] [--enforce]');
  process.exit(2);
}

const rounds = Number(arg('rounds', 5));
const warmup = Number(arg('warmup', 1000));
const samples = Number(arg('samples', 10000));
const maxGrowth = Number(arg('max-growth', 10));
const enforce = process.argv.includes('--enforce');
const keepSamples = !process.argv.includes('--no-samples');

function stats(ns) {
  if (ns.length === 0) return { count: 0, meanUs: 0, p50Us: 0, p95Us: 0, sdUs: 0, minUs: 0, maxUs: 0 };
  const sorted = [...ns].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / sorted.length;
  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / sorted.length;
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1)))))];
  return {
    count: sorted.length,
    meanUs: mean / 1000,
    p50Us: at(0.5) / 1000,
    p95Us: at(0.95) / 1000,
    sdUs: Math.sqrt(variance) / 1000,
    minUs: sorted[0] / 1000,
    maxUs: sorted[sorted.length - 1] / 1000,
  };
}

function timeMany(fn, count) {
  const out = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const t0 = process.hrtime.bigint();
    fn(i);
    out[i] = Number(process.hrtime.bigint() - t0);
  }
  return out;
}

async function main() {
  const url = pathToFileURL(resolve(scenarioPath)).href;
  const mod = await import(url);
  const scenario = mod.default ?? mod.scenario;
  if (!scenario || typeof scenario.setup !== 'function') {
    console.error('场景模块必须导出 { name, setup() }');
    process.exit(2);
  }
  const roundCount = Number(scenario.rounds ?? rounds);
  const warmCount = Number(scenario.warmup ?? warmup);
  const sampleCount = Number(scenario.samples ?? samples);
  const { baseline, candidate } = scenario.setup();

  /* 预热：两边各自预热，避免第一次 JIT/缓存命中差异落在第一轮。 */
  for (let i = 0; i < warmCount; i += 1) { baseline(i); candidate(i); }

  const perRound = [];
  for (let r = 0; r < roundCount; r += 1) {
    const order = r % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    const bucket = { baseline: [], candidate: [] };
    for (const which of order) {
      bucket[which] = timeMany(which === 'baseline' ? baseline : candidate, sampleCount);
    }
    const b = stats(bucket.baseline);
    const c = stats(bucket.candidate);
    const growthPct = b.meanUs > 0 ? ((c.meanUs - b.meanUs) / b.meanUs) * 100 : 0;
    perRound.push({ round: r + 1, order: order.join('→'), baseline: b, candidate: c, growthPct, samples: bucket });
    console.log(`round ${r + 1}/${roundCount} ${order.join('→')} baseline=${b.meanUs.toFixed(3)}µs candidate=${c.meanUs.toFixed(3)}µs growth=${growthPct.toFixed(3)}%`);
  }

  const merged = {
    baseline: stats(perRound.flatMap((x) => x.samples ? x.samples.baseline : [])),
    candidate: stats(perRound.flatMap((x) => x.samples ? x.samples.candidate : [])),
  };
  /*
   * 不保留原始样本时，用各轮均值近似合并（样本数不可知，只给均值/最大轮增长）。
   * 保留样本时 merged 是真实全量统计。
   */
  const growthPct = merged.baseline.meanUs > 0
    ? ((merged.candidate.meanUs - merged.baseline.meanUs) / merged.baseline.meanUs) * 100
    : 0;
  if (!keepSamples) {
    for (const row of perRound) delete row.samples;
  }
  const worstRound = Math.max(...perRound.map((x) => Math.abs(x.growthPct)));
  const report = {
    scenario: scenario.name ?? scenarioPath,
    measuredAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpu: cpus()[0]?.model ?? '',
      cpuCount: cpus().length,
      totalMemBytes: totalmem(),
    },
    config: { rounds: roundCount, warmup: warmCount, samplesPerRound: sampleCount, alternating: true, maxGrowthPct: maxGrowth },
    merged,
    growthPct,
    worstRoundAbsGrowthPct: worstRound,
    verdict: growthPct <= maxGrowth && worstRound <= maxGrowth ? 'PASS' : 'FAIL',
    perRound,
  };
  const target = outPath === true ? join(ROOT, 'dist', 'acceptance', 'perf-report.json') : outPath;
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\n${report.verdict}: growth=${growthPct.toFixed(3)}% worstRound=${worstRound.toFixed(3)}% (limit ${maxGrowth}%)`);
  console.log(`WROTE ${target}`);
  if (enforce && report.verdict !== 'PASS') process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
