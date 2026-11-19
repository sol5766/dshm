#!/usr/bin/env node
/**
 * 门禁：entry 必须是唯一的 tablet + 2in1 双形态壳（2026-11-08）。
 *
 * 【为什么改】2026-11-07 曾把 PC 拆成独立 `pc` 薄壳，entry 只留 tablet。
 * 实测后果：MatePad Edge / Pro Max 这类双形态平板只命中 tablet 壳，拿不到
 * 2in1 的 PC 兼容身份与随包 ffmpeg，运行时退回高内存的旧路径。
 *
 * 【现在的结构】entry 同时声明 tablet + 2in1，一份源码服务：
 *   - PC / 2in1：PC 形态；
 *   - Edge / Pro Max：DeviceFacts 判 desktopForced ⇒ PC 形态；
 *   - 单形态平板：DeviceFacts 判 TABLET ⇒ 原 tablet 形态不变。
 * 独立的 `pc` 模块不得再参与构建（同一设备类型最多一个 entry HAP）。
 *
 * 用法：`node tools/check-pc-tablet-parity.mjs`（退出码 0 = 结构正确）
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function stripJson5(text) {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
}

const problems = [];
const entryManifest = join(ROOT, 'entry/src/main/module.json5');
if (!existsSync(entryManifest)) {
  problems.push('缺少 entry/src/main/module.json5');
} else {
  const mod = JSON.parse(stripJson5(readFileSync(entryManifest, 'utf8')));
  const types = mod?.module?.deviceTypes ?? [];
  if (JSON.stringify(types) !== JSON.stringify(['tablet', '2in1'])) {
    problems.push(`entry deviceTypes=${JSON.stringify(types)}，期望 ["tablet","2in1"]`);
  }
  const abilities = mod?.module?.abilities ?? [];
  if (!abilities.some((item) => item?.name === 'SuperagentAbility')) {
    problems.push('entry 未声明 SuperagentAbility（合并后 PC 侧超管入口会丢）');
  }
}

const profilePath = join(ROOT, 'build-profile.json5');
if (!existsSync(profilePath)) {
  problems.push('缺少 build-profile.json5');
} else {
  const profile = JSON.parse(stripJson5(readFileSync(profilePath, 'utf8')));
  if ((profile.modules ?? []).some((item) => item?.name === 'pc')) {
    problems.push('build-profile 仍包含 pc 模块；2in1 会出现两个 entry HAP');
  }
  if ((profile.app?.products ?? []).some((item) => item?.name === 'pc')) {
    problems.push('build-profile 仍包含 pc product；PC 应由 entry 承载');
  }
}

const ffmpeg = join(ROOT, 'entry/src/main/resources/resfile/toolchain/ffmpeg/bin/ffmpeg');
if (!existsSync(ffmpeg)) {
  problems.push('entry 缺少随包 ffmpeg（PC/Edge 档原生媒体能力会缺）');
}

console.log('# 双形态 entry 结构门禁');
if (problems.length === 0) {
  console.log('PASS entry = tablet + 2in1 单壳，pc 模块不再参与构建，ffmpeg / SuperagentAbility 就位。');
  process.exit(0);
}
for (const problem of problems) console.error(`  FAIL  ${problem}`);
process.exit(1);
