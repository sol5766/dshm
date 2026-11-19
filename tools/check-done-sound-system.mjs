#!/usr/bin/env node
/**
 * 门禁：任务完成提示音**一律走系统提示音**，三个壳层都不得播随包音频。
 *
 * 【为什么要有这条（2026-11-05 用户口径）】
 * 提示音的所有权应当交给**系统通知渠道**：用户在「设置 → 通知 → 本应用」里能单独
 * 换铃声或静音，这是抖音/微信这类应用的通行做法。应用自己再播一份音频会：
 *   ① 与系统通知音**双响**；
 *   ② 绕过用户的静音选择；
 *   ③ 三端不一致 —— 本仓真实出现过：entry 端 `id<=0` 才播，phone 端**无条件播**。
 *
 * 所以判据分两半：
 *   A. 三个壳层的 EntryAbility **不得**引用 `doneSound`（`play` / `attach` / import 都不许）；
 *   B. 完成通知必须走一个**可回退到有声渠道**的 slot：`publishCompletion` 用
 *      `this.completionSlotType`，且 `ensureSlots()` 里有"重建后仍静音 ⇒ SOCIAL_COMMUNICATION"
 *      的分支（只写死 SERVICE_INFORMATION 时，渠道被建成静音就永远没声音）。
 *
 * 用法：
 *   node tools/check-done-sound-system.mjs
 *   node tools/check-done-sound-system.mjs --self-test   # 3 个变异体必须判红
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SHELLS = [
  'entry/src/main/ets/entryability/EntryAbility.ets',
  'phone/src/main/ets/entryability/EntryAbility.ets',
];
const CENTER = 'platform/src/main/ets/notify/NotificationCenter.ets';

/** 去注释：注释里写着"不再播随包音频"而代码还在播，是本仓反复踩的坑。 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let inBlock = false;
  let inLine = false;
  let quote = '';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } i += 1; continue; }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i += 2; continue; }
      if (c === '\n') out += c;
      i += 1; continue;
    }
    if (quote) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === quote) quote = '';
      i += 1; continue;
    }
    if (c === '/' && n === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
    if (c === '\'' || c === '"' || c === '`') { quote = c; out += c; i += 1; continue; }
    out += c; i += 1;
  }
  return out;
}

function judgeShell(rel, src) {
  const problems = [];
  const code = stripComments(src);
  if (/\bdoneSound\b/.test(code)) {
    problems.push('仍引用 `doneSound`（随包音频）—— 提示音必须只由系统通知渠道提供');
  }
  return problems.map((p) => `[${rel.split('/')[0]}] ${p}`);
}

function judgeCenter(src) {
  const problems = [];
  const code = stripComments(src);
  const at = code.indexOf('async publishCompletion');
  if (at < 0) {
    problems.push('[platform] 找不到 publishCompletion');
    return problems;
  }
  const body = code.slice(at, code.indexOf('\n  }', at) + 4);
  if (!/notificationSlotType\s*=\s*this\.completionSlotType/.test(body)) {
    problems.push('[platform] publishCompletion 没用 `this.completionSlotType`（写死渠道 ⇒ 静音时无回退）');
  }
  if (!/SOCIAL_COMMUNICATION/.test(code)) {
    problems.push('[platform] 缺少"重建后仍静音 ⇒ SOCIAL_COMMUNICATION"的回退分支');
  }
  if (!/completionSlotType\s*:/.test(code)) {
    problems.push('[platform] 缺 `completionSlotType` 字段声明');
  }
  return problems;
}

const texts = {};
const problems = [];
for (const rel of SHELLS) {
  texts[rel] = readFileSync(join(ROOT, rel), 'utf8');
  for (const p of judgeShell(rel, texts[rel])) problems.push(p);
}
texts[CENTER] = readFileSync(join(ROOT, CENTER), 'utf8');
for (const p of judgeCenter(texts[CENTER])) problems.push(p);

if (!process.argv.includes('--self-test')) {
  if (problems.length > 0) {
    console.error(`❌ 提示音口径不达标（${problems.length} 处）：`);
    for (const p of problems) console.error(`   · ${p}`);
    process.exit(1);
  }
  console.log('✅ 通过：三端都不播随包音频；完成通知走系统渠道，静音时回退 SOCIAL_COMMUNICATION。');
  process.exit(0);
}

console.log('--self-test：变异体必须判红 --');
let ok = problems.length === 0;
console.log(`  基线：${problems.length} 处问题（应为 0）`);
for (const p of problems) console.log(`     · ${p}`);

const arms = [
  ['entry 恢复随包音频播放',
    (t) => t.replace('private setupNotifications(): void {',
      'private setupNotifications(): void {\n    doneSound.play().catch(() => {});')],
  ['phone 恢复无条件播放',
    (t) => t.replace('private startTaskWatch',
      'private startTaskWatch2(): void { doneSound.play(); }\n  private startTaskWatch')],
];
for (const [label, mutate] of arms) {
  const rel = SHELLS[0].includes('entry') && label.startsWith('entry') ? SHELLS[0] : SHELLS[1];
  const mutated = mutate(texts[rel]);
  const reds = mutated === texts[rel] ? [] : judgeShell(rel, mutated);
  const red = reds.length > 0;
  if (!red) ok = false;
  console.log(`  ${red ? '✅' : '❌'} ${label} ⇒ ${mutated === texts[rel] ? '变异未生效' : `判红（${reds.length} 处）`}`);
}

const centerArm = texts[CENTER].replace(/request\.notificationSlotType\s*=\s*this\.completionSlotType;/,
  'request.notificationSlotType = notificationManager.SlotType.SERVICE_INFORMATION;');
{
  const reds = centerArm === texts[CENTER] ? [] : judgeCenter(centerArm);
  const red = reds.length > 0;
  if (!red) ok = false;
  console.log(`  ${red ? '✅' : '❌'} 完成通知写死 SERVICE_INFORMATION ⇒ ${centerArm === texts[CENTER] ? '变异未生效' : `判红（${reds.length} 处）`}`);
}

console.log(ok ? '\n✅ 自检通过。' : '\n❌ 自检失败（门禁没牙）。');
process.exit(ok ? 0 : 3);
