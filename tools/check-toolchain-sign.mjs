#!/usr/bin/env node
/*
 * 工具链自签名门禁（2026-09-27 新增）。
 *
 * ─────────────── 为什么需要它 ───────────────
 * AGENTS.md 的硬要求："所有沙箱内 ELF 必须**构建期自签名**"（execve 受签名域管辖）。
 * 但这条要求原本**没有任何门禁**守着，而 `place-toolchain.mjs` 在找不到宿主 python3 时
 * 只打一行 ⚠ 就**跳过签名并 exit 0** ⇒ 构建全绿、装机后工具链真身全被拒。
 *
 * 真实事故：本机 PATH 无 python3/python/py（只有 DevEco 的 jbr 与 node），
 * 于是长期未签名，设备上 `exec 探测 = python3.12=denied, git=denied, git-core/git=denied`，
 * 直到外部审查才发现。**构建端一切正常，症状只在设备上显现** —— 正是需要门禁的情形。
 *
 * ─────────────── 检查什么 ───────────────
 *   ① 两个归档目录里 `dshm-signed.txt` 标记存在；
 *   ② 标记是"前缀 + 内容摘要"形态（裸常量会让"未签名→已签名"这种换代测不出来，
 *      端侧判成没变、不重解 ⇒ 白签一场）；
 *   ③ 标记里的摘要与归档**实际大小之和**自洽（证明标记没被伪造、归档没被偷换）。
 *
 * 退出码：0 通过 / 1 有问题 / 3 环境不足（没跑成，不算通过）。
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DEST = join(ROOT, 'entry', 'src', 'main', 'resources', 'resfile', 'toolchain');
const MARKER = 'dshm-signed.txt';

const problems = [];
const notes = [];

/** 归档目录里除标记外的文件大小之和（place-toolchain 就是按这个算摘要的）。 */
function digestOf(sub) {
  const dir = join(DEST, sub);
  let sum = 0;
  for (const f of readdirSync(dir)) {
    if (f === MARKER) continue;
    try { sum += statSync(join(dir, f)).size; } catch { /* 忽略 */ }
  }
  return sum;
}

for (const sub of ['python', 'git']) {
  const dir = join(DEST, sub);
  if (!existsSync(dir)) {
    /*
     * 归档目录不存在 ⇒ 工具链尚未布置（place-toolchain 没跑过）。
     * 这属于"环境不足"，不是"签名缺失" —— 用 3 退出，明确区分二者。
     */
    console.error(`环境不足：${dir.replace(ROOT, '')} 不存在 —— 先跑 node tools/place-toolchain.mjs`);
    process.exit(3);
  }

  const mp = join(dir, MARKER);
  if (!existsSync(mp)) {
    problems.push(`${sub}/${MARKER} 缺失 ⇒ 端侧判"归档无标记"、走"存在即跳过"`
      + ' ⇒ 重新签名过的归档不会被解包（历史上"白签一场"的成因）');
    continue;
  }

  const val = readFileSync(mp, 'utf8').trim();
  const m = /^dshm-signed-v1\+(\d+)$/.exec(val);
  if (!m) {
    problems.push(`${sub} 标记 = "${val}"，不是"前缀+内容摘要"形态`
      + ' ⇒ 归档换代（如未签名→已签名）测不出来，端侧不会重解 ⇒ 白签一场');
    continue;
  }

  const claimed = Number(m[1]);
  const actual = digestOf(sub);
  if (claimed === actual) {
    notes.push(`${sub}：标记 ${val}，与归档实际大小自洽（${actual}B）`);
  } else {
    problems.push(`${sub}：标记摘要 ${claimed}B ≠ 归档实际 ${actual}B`
      + ' ⇒ 归档被换过而标记未更新（或反之），端侧换代判定会失效');
  }
}

console.log('工具链自签名门禁');
for (const n of notes) console.log('  ok  ：' + n);
if (problems.length === 0) {
  console.log(`  ✓ 通过（${notes.length} 项）`);
  process.exit(0);
}
console.log('');
for (const p of problems) console.log('  ✗ ' + p);
console.log(`  RESULT: FAIL (${problems.length})`);
process.exit(1);
