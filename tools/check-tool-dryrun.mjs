#!/usr/bin/env node
/**
 * 门禁：工具落盘必须支持 dry-run 与备份（tools/lib/safe-apply.mjs 的行为 + 接线）。
 *
 * 【为什么需要】place-host-app 这类工具会覆盖生成物；没有预览与备份时，出问题只能靠
 * 记忆恢复。这里在临时目录里真跑一遍：
 *   · dry-run：报告"将写入"，但文件字节不变；
 *   · 备份：覆盖前把旧内容存到指定目录，且新内容已写入；
 *   · 未变更：不重复写（mtime 不变由调用方决定，这里只断言内容语义）。
 *
 * 【--self-test】把 safe-apply 复制到临时目录、去掉 dry-run 短路，必须判红。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;
const LIB = join(ROOT, 'tools/lib/safe-apply.mjs');

async function run(libPath) {
  const { planWrite, applyPlans } = await import(pathToFileURL(libPath).href);
  const failures = [];
  const dir = mkdtempSync(join(tmpdir(), 'dshm-safe-apply-'));
  try {
    const target = join(dir, 'a.txt');
    writeFileSync(target, 'old', 'utf8');

    const plan = planWrite(target, 'new');
    if (!(plan.exists && plan.changed)) failures.push('planWrite 未识别内容变化');

    const dry = applyPlans([plan], { content: new Map([[target, 'new']]), dryRun: true });
    if (dry.written.length !== 1) failures.push('dry-run 未报告将写入');
    if (readFileSync(target, 'utf8') !== 'old') failures.push('dry-run 竟然落盘了');

    const backupDir = join(dir, 'backup');
    const applied = applyPlans([plan], { content: new Map([[target, 'new']]), backupDir });
    if (applied.written.length !== 1) failures.push('正常写入未报告');
    if (readFileSync(target, 'utf8') !== 'new') failures.push('正常写入内容不对');
    const backups = applied.backedUp.map((p) => readFileSync(p, 'utf8'));
    if (backups.length !== 1 || backups[0] !== 'old') failures.push('备份内容不是旧值');

    const same = applyPlans([planWrite(target, 'new')], { content: new Map([[target, 'new']]) });
    if (same.written.length !== 0 || same.skipped.length !== 1) failures.push('未变更文件被重复写');

    /* place-host-app 必须真的接了这两个开关（否则只是空文档） */
    const host = readFileSync(join(ROOT, 'tools/place-host-app.mjs'), 'utf8');
    if (!host.includes("--dry-run")) failures.push('place-host-app 缺 --dry-run');
    if (!host.includes("--backup")) failures.push('place-host-app 缺 --backup');
    if (!host.includes('applyPlans(')) failures.push('place-host-app 没走 safe-apply');

    return failures;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const baseline = await run(LIB);
if (!process.argv.includes('--self-test')) {
  if (baseline.length > 0) {
    console.error(`❌ 工具 dry-run/备份不成立（${baseline.length} 处）：`);
    for (const p of baseline) console.error(`   · ${p}`);
    process.exit(1);
  }
  console.log('✅ 通过：dry-run 不落盘、备份保存旧值、未变更不重写，place-host-app 已接线。');
  process.exit(0);
}

console.log('--self-test：变异体必须判红 --');
console.log(`  基线：${baseline.length} 处失败（应为 0）`);
const dir = mkdtempSync(join(tmpdir(), 'dshm-safe-apply-mut-'));
let ok = baseline.length === 0;
try {
  const mutated = join(dir, 'safe-apply.mjs');
  writeFileSync(mutated, readFileSync(LIB, 'utf8').replace('if (dryRun) continue;', 'if (false) continue;'), 'utf8');
  const failed = await run(mutated);
  const red = failed.length > 0;
  console.log(`  ${red ? '✅' : '❌'} 去掉 dry-run 短路 ⇒ ${red ? `判红（${failed.length} 处）` : '未判红'}`);
  if (!red) ok = false;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(ok ? '\n✅ 自检通过。' : '\n❌ 自检失败。');
process.exit(ok ? 0 : 3);
