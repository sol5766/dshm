#!/usr/bin/env node
/*
 * check-tools-syntax.mjs —— tools/ 脚本的 shebang 位置与语法闸
 *
 * 【为什么需要】2026-11-06 出 AGC 包时 `tools/build-agc.mjs` 直接 SyntaxError：
 * 清理批次往脚本里插了一行 `# 指定设备侧载 Profile …`（Python 风格注释），
 * 而回归清单里没有构建脚本 ⇒ 111 条全绿也挡不住它。同轮全量扫描还发现
 * `apms-query.mjs` / `check-apms-query.mjs` 的 shebang 被「历史用途」注释挤到第 2 行
 * （Node 要求 shebang 必须是第 1 行），两个诊断脚本同样起不来。
 *
 * 两条判据：① 有 shebang 就必须在第 1 行；② 每个脚本都过 `node --check`
 * （裸 `#` 注释、模板串提前闭合等语法错误由它裁决，不做易误报的文本猜测）。
 * 用 `process.execPath` 起检查，不依赖 PATH 里有 node。
 *
 * 【用法】node tools/check-tools-syntax.mjs [--self-test]
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(ROOT, 'tools');
const SELF_TEST = process.argv.includes('--self-test');
const FILES = readdirSync(TOOLS).filter((n) => /\.(mjs|cjs|js)$/.test(n)).sort();

/** 纯判据：shebang 若存在必须是第 1 行；返回问题数组。 */
function judgeShebang(text) {
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.startsWith('#!'));
  if (idx === -1) return [];
  return idx === 0 ? [] : [`shebang 在第 ${idx + 1} 行（必须在第 1 行）`];
}

if (SELF_TEST) {
  const arms = [
    ['S1 shebang 在首行', '#!/usr/bin/env node\nimport x from "y";', true],
    ['S2 无 shebang', '// 只有注释\nimport x from "y";', true],
    ['S3 注释挤到 shebang 前面', '// 历史用途\n#!/usr/bin/env node\n', false],
    ['S4 shebang 落在第 3 行', '\n// x\n#!/usr/bin/env node\n', false],
  ];
  for (const [label, text, wantClean] of arms) {
    const clean = judgeShebang(text).length === 0;
    if (clean !== wantClean) {
      console.error(`FAIL：${label} 期望 ${wantClean ? '判绿' : '判红'}，实际 ${clean ? '判绿' : '判红'}`);
      process.exit(1);
    }
  }
  // S5 真跑对照臂：Python 风格裸注释必须被 node --check 判红（就是 build-agc 那次事故）。
  const probe = join(tmpdir(), 'dshm-tools-syntax-probe.mjs');
  writeFileSync(probe, 'const x = 1;\n# 指定设备侧载 Profile\n', 'utf8');
  const r = spawnSync(process.execPath, ['--check', probe], { encoding: 'utf8' });
  rmSync(probe, { force: true });
  if (r.status === 0) {
    console.error('FAIL：S5 裸 # 注释没有被 node --check 判红（语法闸没牙）');
    process.exit(1);
  }
  console.log(`OK：check-tools-syntax --self-test ${arms.length + 1}/${arms.length + 1} 个样例符合预期（含真跑对照臂）`);
  process.exit(0);
}

const fails = [];
for (const name of FILES) {
  const p = join(TOOLS, name);
  const text = readFileSync(p, 'utf8');
  for (const problem of judgeShebang(text)) {
    fails.push(`${name}：${problem}`);
  }
  const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
  if (r.status !== 0) {
    fails.push(`${name}：node --check 失败 — ${String(r.stderr || '').split('\n').slice(0, 2).join(' ').slice(0, 160)}`);
  }
}

if (fails.length > 0) {
  console.error('FAIL：tools 脚本语法闸\n  ' + fails.slice(0, 20).join('\n  '));
  process.exit(1);
}
console.log(`OK：tools/ ${FILES.length} 个脚本 shebang 位置与 node --check 全部通过`);
