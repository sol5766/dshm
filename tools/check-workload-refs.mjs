#!/usr/bin/env node
/**
 * 门禁：Host 侧 `workload.json` 的 `refs` 判据必须认得 `card-state.json` 的**真实字段**。
 *
 * 【为什么要有这条（2026-11-05，客户反馈核对）】
 * 手持档（含平板）的保活链是两段拼起来的：
 *   Host（`main.js` 的看门狗）写 `$DSH_HOME/workload.json` 的 `refs`
 *     → ArkTS `EntryAbility.workloadRefs()` 读它
 *     → `maybeAcquireHandheldKeepAlive()` 的 `busy` 判据
 *     → `KeepAlive.acquireTaskKeeping()` 申请长时任务。
 *
 * 第一段此前判的是 `card.running === true || card.turnActive === true`，**两个键都不存在**：
 * `registerCardState()` 写出去的形状是 `{ session: { state, turn, … } }`，
 * `state ∈ idle | running | done | error`。结果 `turnRunning` **恒为 0**，
 * `refs` 只剩"在途安装数" ⇒ 熄屏那一刻若没有安装任务，就判成"无保活诉求"，
 * 长时任务不申请、进程被系统冻结。
 *
 * 这类缺陷不报编译错、不崩、离线也看不出来，只在真机上表现为"熄屏就停 / 平板后台任务不跑"，
 * 而 `check-keepalive-wiring.mjs` 只盯 ArkTS 两个壳层的接线 —— 生产者那一段没人看。
 * 所以单独立这条：**判据必须与实际写入形状对得上**。
 *
 * 【判据（全离线，只读一个文件）】
 *   ① 判据里必须同时认 `session.state === 'running'`（现形状）与 `running/turnActive`（历史键）；
 *   ② 写出去的负载必须含 `refs` / `turnRunning` / `pendingInstalls` 三个键；
 *   ③ `refs` 必须由 `turnRunning + pendingInstalls` 组成（不能改成常量）。
 *
 * 用法：
 *   node tools/check-workload-refs.mjs
 *   node tools/check-workload-refs.mjs --self-test   # 变异体必须判红
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HOST = 'hostcore/app/main.js';

/** 去注释：注释里写着正确判据而代码已删，是本仓反复踩的坑。 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let inBlock = false;
  let inLine = false;
  let quote = '';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      i += 1;
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i += 2; continue; }
      if (c === '\n') out += c;
      i += 1;
      continue;
    }
    if (quote) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === quote) quote = '';
      i += 1;
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
    if (c === '\'' || c === '"' || c === '`') { quote = c; out += c; i += 1; continue; }
    out += c;
    i += 1;
  }
  return out;
}

/** 取 `workload` 构造的那一段（从 `let turnRunning` 到 `writeFileSync(... 'workload.json'` 之后）。 */
function workloadBlock(code) {
  const start = code.indexOf('let turnRunning');
  if (start < 0) return '';
  const end = code.indexOf("'workload.json'", start);
  if (end < 0) return '';
  const tail = code.indexOf(')', end);
  return code.slice(start, tail < 0 ? code.length : tail + 1);
}

function judge(src) {
  const problems = [];
  const code = stripComments(src);
  const block = workloadBlock(code);
  if (block.length === 0) {
    problems.push('找不到 Host 侧的 workload 构造段（`const refs = …` → `workload.json`）');
    return problems;
  }
  if (!/session/.test(block) || !/\.state\s*===\s*'running'/.test(block)) {
    problems.push("workload 判据没认 `session.state === 'running'`（card-state 的真实字段），turnRunning 会恒为 0");
  }
  if (!/card\.running\s*===\s*true/.test(block) || !/card\.turnActive\s*===\s*true/.test(block)) {
    problems.push('workload 判据丢了历史键兼容（`card.running` / `card.turnActive`）');
  }
  if (!/const refs\s*=\s*turnRunning\s*\+\s*pending\s*\+\s*\(scheduled\.count\s*>\s*0\s*\?\s*1\s*:\s*0\)/.test(block)) {
    problems.push('`refs` 不再由 `turnRunning + pending + 活跃调度` 组成（定时任务会被判成空闲）');
  }
  if (!/const scheduled\s*=\s*readScheduledWork\(\)/.test(block)) {
    problems.push('workload 没有读取 `readScheduledWork()`（熄屏后到点的定时任务不在保活诉求里）');
  }
  if (!/turnRunning\s*=\s*running\s*\?\s*1\s*:\s*0/.test(block)) {
    problems.push('`turnRunning` 没有按判据结果赋值（被写成常量等于静默失效）');
  }
  for (const key of ['refs', 'turnRunning', 'pendingInstalls', 'scheduledTasks', 'nextScheduleAt']) {
    if (!new RegExp(`\\b${key}\\b`).test(block)) problems.push(`workload 负载缺 \`${key}\` 键`);
  }
  /* 调度事实的来源必须仍是 schedule 域的持久文件（换存储时这条会提醒同步改读取路径）。 */
  if (!/path\.join\(HOME_DIR,\s*'storages',\s*'schedule\.json'\)/.test(code)) {
    problems.push("`readScheduledWork()` 没有读 `$DSH_HOME/storages/schedule.json`（调度域换了位置？）");
  }
  if (!/tables\.tasks|doc\.tasks/.test(code)) {
    problems.push('`readScheduledWork()` 没有读 schedule 域的 `tasks` 表');
  }
  if (!/status\s*!==\s*'active'/.test(code)) {
    problems.push("调度计数没有过滤 `status !== 'active'`（暂停 / 结束的任务会被当成诉求）");
  }
  return problems;
}

const raw = readFileSync(join(ROOT, HOST), 'utf8');
const selfTest = process.argv.includes('--self-test');
const problems = judge(raw);

if (!selfTest) {
  if (problems.length > 0) {
    console.error(`❌ workload refs 判据有问题（${problems.length} 处）：`);
    for (const p of problems) console.error(`   · ${p}`);
    process.exit(1);
  }
  console.log("✅ 通过：Host 的 workload 判据认 card-state 的真实字段（session.state==='running'），refs = turnRunning + pending。");
  process.exit(0);
}

console.log('--self-test：变异体必须判红 --');
let ok = problems.length === 0;
console.log(`  基线：${problems.length} 处问题（应为 0）`);
for (const p of problems) console.log(`     · ${p}`);

const arms = [
  ['删掉 session.state 判据（退回只认顶层键的旧形态）',
    (s) => s.replace(/\|\| \(sess && sess\.state === 'running'\)/, '')],
  ['turnRunning 恒置 0（静默失效）',
    (s) => s.replace(/turnRunning = running \? 1 : 0;/, 'turnRunning = 0;')],
  ['refs 改成常量（丢掉在途事实）',
    (s) => s.replace(/const refs = turnRunning \+ pending \+ \(scheduled\.count > 0 \? 1 : 0\);/, 'const refs = 0;')],
  ['refs 丢掉活跃调度项（定时任务不再保活）',
    (s) => s.replace(/const refs = turnRunning \+ pending \+ \(scheduled\.count > 0 \? 1 : 0\);/, 'const refs = turnRunning + pending;')],
  ['删掉调度读取（不再读 schedule 域）',
    (s) => s.replace(/const scheduled = readScheduledWork\(\);/, '')],
];
for (const [label, mutate] of arms) {
  const mutated = mutate(raw);
  const changed = mutated !== raw;
  const reds = changed ? judge(mutated) : [];
  const red = changed && reds.length > 0;
  if (!red) ok = false;
  console.log(`  ${red ? '✅' : '❌'} ${label} ⇒ ${changed ? `判红（${reds.length} 处）` : '变异未生效'}`);
}
console.log(ok ? '\n✅ 自检通过。' : '\n❌ 自检失败（门禁没牙）。');
process.exit(ok ? 0 : 3);
