/*
 * 语音 provider 语法门禁（报告 P0 建议）。
 *
 * 【为什么需要 —— 真实事故（2026-09-26）】
 *   推送的 hms-provider.js 里有**重复的顶层 `const SEG_ATTEMPTS`**
 *   （P1-4 新加的 `=2` 与旧 P0-4 的 `=3` 并存）。
 *   作为 **ES Module** 这是 SyntaxError ⇒ 整个插件 `failed to import`
 *   ⇒ 语音服务退化到 stub ⇒ `preparation.phase` 不再是 `ready`
 *   ⇒ 官方 UI 判 `usable = false` ⇒ **点按钮跳设置页**（表现为"功能失效"）。
 *
 * 【为什么 node --check 拦不住】它默认按 **CommonJS** 解析，
 *   顶层重复 const 在 CJS 下不报错；必须按 ESM 解析才能复现。
 *
 * 【本门禁检查五件事】
 *   ① 按 **ESM** 解析（写出 .mjs 再 `node --check`）
 *   ② 顶层重复的 const/let/var/function/class
 *   ③ 引用的 SEG_* / WAV_* 等常量都有定义
 *   ④ 括号配平
 *   ⑤ 必需的导出（pack-core 以命名导入引用）
 *
 * 用法：node tools/assert-speech-syntax.mjs   （退出码非 0 表示禁止推送）
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const FILES = ['hostcore/speech-provider/index.js'];

let failed = 0;
let checked = 0;

for (const f of FILES) {
  if (!existsSync(f)) {
    console.log(`★ ${f} 不存在`);
    failed++;
    continue;
  }
  const src = readFileSync(f, 'utf8');
  const lines = src.split('\n');
  console.log(`\n=== ${f} ===`);
  checked++;

  /* ① 按 ESM 解析（--check 对 .mjs 用 ESM 语义） */
  {
    const tmp = join(tmpdir(), 'dshm-speech-syntax-check.mjs');
    writeFileSync(tmp, src, 'utf8');
    const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8', timeout: 120000 });
    if (r.status === 0) {
      console.log('  ① ESM 语法: ✓');
    } else {
      console.log('  ① ★ ESM 语法错误（这就是让按钮失效的那类错误）:');
      String(r.stderr || '').split('\n').slice(0, 8).forEach((l) => console.log('     ' + l.slice(0, 130)));
      failed++;
    }
    try { unlinkSync(tmp); } catch (e) { /* 清理失败不影响结论 */ }
  }

  /* ② 顶层重复声明 */
  {
    const seen = new Map();
    const dups = [];
    lines.forEach((l, i) => {
      const m = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/.exec(l);
      if (!m) return;
      if (seen.has(m[1])) dups.push(`${m[1]} @ 行 ${seen.get(m[1])} 与 ${i + 1}`);
      else seen.set(m[1], i + 1);
    });
    if (dups.length === 0) {
      console.log('  ② 顶层重复声明: ✓ 无');
    } else {
      dups.forEach((d) => console.log(`  ② ★ 重复声明: ${d}`));
      failed++;
    }
  }

  /* ③ 常量引用完整性（SEG_/WAV_/POLL_/TIMEOUT_/STALE_ 前缀） */
  {
    const defined = new Set();
    lines.forEach((l) => {
      const m = /^const ([A-Za-z_$][\w$]*)/.exec(l);
      if (m) defined.add(m[1]);
    });
    const used = new Set();
    for (const m of src.matchAll(/\b((?:SEG|WAV|POLL|TIMEOUT|STALE)_[A-Z0-9_]+)\b/g)) used.add(m[1]);
    const missing = [...used].filter((u) => !defined.has(u));
    if (missing.length === 0) {
      console.log(`  ③ 常量引用完整性: ✓（${used.size} 个全部有定义）`);
    } else {
      missing.forEach((u) => console.log(`  ③ ★ 未定义常量引用: ${u}`));
      failed++;
    }
  }

  /* ④ 括号配平 */
  {
    let br = 0, par = 0, bk = 0;
    for (const c of src) {
      if (c === '{') br++;
      else if (c === '}') br--;
      else if (c === '(') par++;
      else if (c === ')') par--;
      else if (c === '[') bk++;
      else if (c === ']') bk--;
    }
    if (br === 0 && par === 0 && bk === 0) {
      console.log('  ④ 括号配平: ✓');
    } else {
      console.log(`  ④ ★ 括号不配平: {} ${br}  () ${par}  [] ${bk}`);
      failed++;
    }
  }

  /* ⑤ 必需导出（pack-core 以命名导入引用它们） */
  {
    const need = ['hmsApply', 'hmsProviderInject'];
    const miss = need.filter((n) => !src.includes(`export function ${n}`) && !new RegExp(`export \\{[^}]*\\b${n}\\b`).test(src));
    if (miss.length === 0) {
      console.log('  ⑤ 必需导出: ✓');
    } else {
      miss.forEach((n) => console.log(`  ⑤ ★ 缺少导出: ${n}`));
      failed++;
    }
  }
}

console.log('');
if (failed === 0) {
  console.log(`✓✓ 语法门禁通过（检查 ${checked} 个文件）`);
  process.exit(0);
} else {
  console.log(`★★ 语法门禁失败：${failed} 项 —— 禁止推送`);
  process.exit(1);
}
