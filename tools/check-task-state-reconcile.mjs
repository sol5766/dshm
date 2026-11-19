#!/usr/bin/env node
/**
 * 门禁：task-state 必须遵循官方 dsh 的 turn/end 语义（2026-11-12，Beta 真机证据链）。
 *
 * 【为什么要有这条】用户实测：会话回复完（1+1 → 2）后仍一直显示「深度求索中」、
 * 停止按钮无效、只能手动退出。完整日志显示 turn 9 在 01:02:27 已由
 * `interruptedTurnClosers` 以 `reason=interrupted` 收尾，但 `task-state.json` 仍是
 * `#9 running seq=0`；重启后 taskWatchPrimed 把这条残留当基线，每 5 秒一次持续 6 分钟，
 * 直到 turn 10 才被覆盖。
 *
 * 【官方契约】`dsh-agent` 的 `turnBoundary` 投影对 `turn/end` **不区分 reason**，
 * 一律 `openTurnStartSeq = null`；`accountsForClaim` 把 completed / blocked /
 * aborted / interrupted / error 都列为正常结束种类。恢复补写的 `turn/end` 只进会话日志、
 * 不发实时 `session/event`，因此自造的状态副本必须在启动时按官方语义校正。
 *
 * 【判据】
 *   ① 启动基线读现有 task-state.json，识别残留 running，收敛为 `state:'done'`，
 *      并恢复 seq（不得 +1，否则重启会误发一次「任务完成」通知）；
 *   ② `turn/end` 对**任何** reason 都写 `active:false / state:done`，只有
 *      `kind === 'error'` 记 'error'；禁止把非 completed 的 reason 判成未完成；
 *   ③ `turn/end` 必须把 `reason.kind` 打进日志，供真机取证。
 *
 * 用法：node tools/check-task-state-reconcile.mjs [--self-test]
 */
import { readFileSync } from 'node:fs';

const FILE = 'hostcore/app/main.js';

export function judge(text) {
  const problems = [];

  const bootStart = text.indexOf('/*\n       * 启动基线');
  /* 用真实调用行作终点：启动基线注释里也引用了 `ctx.on('session/event')` 这个字面量，
     用短串会从注释内部截断，导致判据全部落空。 */
  const bootEnd = text.indexOf("      ctx.on('session/event'", bootStart);
  const boot = bootStart >= 0 && bootEnd > bootStart ? text.slice(bootStart, bootEnd) : '';
  if (!boot) {
    problems.push('找不到启动基线块（锚点漂了）');
  } else {
    if (!boot.includes('JSON.parse(fs.readFileSync(taskStateFile')) {
      problems.push('启动基线没有读取现有 task-state.json');
    }
    if (!boot.includes("prev.active === true || prev.state === 'running'")) {
      problems.push('启动基线没有识别残留 running（重启会继续显示深度求索中）');
    }
    if (!boot.includes("state: 'done'")) {
      problems.push('残留 running 没有收敛为 done');
    }
    if (!boot.includes('taskSeq = prev.seq')) {
      problems.push('启动基线没有恢复 seq（doneKey 会从 0 重来）');
    }
    if (boot.includes('taskSeq += 1')) {
      problems.push('启动基线里 +1 了 seq（重启会误发一次完成通知）');
    }
  }

  const endStart = text.indexOf("if (event.type === 'turn/end')");
  const endStop = text.indexOf("void refreshBalance('turn-end')", endStart);
  const turnEnd = endStart >= 0 && endStop > endStart ? text.slice(endStart, endStop) : '';
  if (!turnEnd) {
    problems.push('找不到 turn/end 处理块（锚点漂了）');
  } else {
    if (!turnEnd.includes("state: failed ? 'error' : 'done'")) {
      problems.push('turn/end 没有对所有 reason 写 done/error');
    }
    if (!turnEnd.includes("const failed = reasonKind === 'error';")) {
      problems.push("failed 不是只由 kind==='error' 决定（interrupted 会被误判）");
    }
    if (/reasonKind\s*!==\s*'completed'/.test(turnEnd)) {
      problems.push('把非 completed 的 reason 当成未完成（违反官方 turnBoundary）');
    }
    if (!/diag\('task-state: turn\/end reason=' \+ \(reasonKind/.test(turnEnd)) {
      problems.push('turn/end 没有把 reason.kind 打进日志（真机无法取证）');
    }
  }
  return problems;
}

const selfTest = process.argv.includes('--self-test');
const raw = readFileSync(FILE, 'utf8');
const base = judge(raw);

if (!selfTest) {
  if (base.length > 0) {
    console.error(`❌ task-state 未遵循官方 turn/end 语义（${base.length} 处）：`);
    for (const p of base) console.error(`   · ${p}`);
    process.exit(1);
  }
  console.log('✅ 通过：启动收敛残留 running 并恢复 seq；turn/end 对所有 reason 置 done；reason.kind 可取证。');
  process.exit(0);
}

console.log('--self-test：变异体必须判红 --');
let failures = 0;
if (base.length !== 0) {
  failures += 1;
  console.error(`基线应为 0 处，实际 ${base.length}`);
}
const arms = [
  ['启动不识别残留 running', (t) => t.replace("prev.active === true || prev.state === 'running'", 'false')],
  ['残留 running 不收敛', (t) => t.replace(
    "turn: prev.turn || 0, state: 'done', startedAt: prev.startedAt || ''",
    "turn: prev.turn || 0, state: 'running', startedAt: prev.startedAt || ''")],
  ['不恢复 seq', (t) => t.replace('taskSeq = prev.seq;', '')],
  ['interrupted 被判成未完成', (t) => t.replace(
    "const failed = reasonKind === 'error';", "const failed = reasonKind !== 'completed';")],
  ['丢掉 reason.kind 取证', (t) => t.replace(
    "diag('task-state: turn/end reason=' + (reasonKind || '(none)') +",
    "diag('task-state: turn/end reason=' + ('') +")],
];
for (const [name, mutate] of arms) {
  const mutated = mutate(raw);
  if (mutated === raw) {
    failures += 1;
    console.error(`  ✗ ${name}：变异未生效（锚点漂了）`);
    continue;
  }
  const problems = judge(mutated);
  if (problems.length === 0) {
    failures += 1;
    console.error(`  ✗ ${name}：判据没判红`);
  } else {
    console.log(`  ✓ ${name} ⇒ 判红（${problems.length} 处：${problems[0]}）`);
  }
}
console.log(failures === 0 ? '✅ 自检通过' : `❌ 自检失败（${failures}）`);
process.exit(failures === 0 ? 0 : 1);
