#!/usr/bin/env node
/**
 * 门禁：桥暴露面（页面可调能力的边界）。
 *
 * 【背景】页面里的 `__DSHM_BRIDGES__`/`dshmBridge` 是高权限面（选目录、外开、文件预览、
 * 云同步动作…）。两类风险必须静态钉住：
 *   ① 注入范围：垫片 scriptRules 为 '*'，若 ArkWeb 把脚本注入到远端子 frame，那些页面
 *      也能看到全局对象 ⇒ 契约层必须有同源闸门（origin-denied），不能只靠"相信不注入"。
 *   ② 参数校验：外开/导航是页面可控输入，必须复校协议与主机名；不能用前缀匹配
 *      （`127.0.0.1.evil.com`、`127.0.0.1@evil.com` 都能绕过）。
 *
 * 【判据】
 *   1. 两壳契约都含 `origin-denied` 闸门；对外 API 只有 call/callAsync/complete/pending*，
 *      不暴露 eval / Function / 动态执行口。
 *   2. `openExternal` 必须调 `isOpenableUrl(target)` 复校。
 *   3. `isExternalNavigation` 必须是主机名**全等**白名单（127.0.0.1 / localhost / [::1]），
 *      且先剥 userinfo（`split('@')`）。
 *   4. `onLoadIntercept` 必须用 `isExternalNavigation` 判定。
 *   5. methodList 不得出现通用执行类名字（exec/eval/run/shell/system）。
 *
 * 【--self-test】四个变异体必须判红。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FILES = {
  entry: 'entry/src/main/ets/pages/WebApp.ets',
  phone: 'phone/src/main/ets/pages/WebApp.ets',
};
const FORBIDDEN = ['exec', 'eval', 'run', 'shell', 'system'];

function judge(src) {
  const problems = [];
  const contract = src.match(/const BRIDGE_CONTRACT_JS: string = `([\s\S]*?)`;/)?.[1] ?? '';
  const guardCount = (contract.match(/'origin-denied'/g) || []).length;
  if (guardCount < 2) problems.push(`契约同源闸门不完整（origin-denied 只出现 ${guardCount} 次，call/callAsync 各需一次）`);
  if (!/function originAllowed\(\)/.test(contract)) problems.push('契约缺 originAllowed()');
  if (/\beval\s*\(|new\s+Function\s*\(/.test(contract)) problems.push('契约出现 eval / new Function');
  const api = contract.match(/var api = \{([\s\S]*?)\n  \};/)?.[1] ?? '';
  const apiKeys = [...api.matchAll(/^\s*([a-zA-Z]+):/gm)].map((m) => m[1]).sort();
  const expected = ['call', 'callAsync', 'complete', 'pendingCount', 'pendingIds'].sort();
  if (JSON.stringify(apiKeys) !== JSON.stringify(expected)) {
    problems.push(`契约 API 面不符：${apiKeys.join(',')}（期望 ${expected.join(',')}）`);
  }

  if (!/if \(!isOpenableUrl\(target\)\)/.test(src)) problems.push('openExternal 没有调 isOpenableUrl 复校');
  if (!src.includes("authority.split('@')")) problems.push('isExternalNavigation 没剥 userinfo');
  if (!/if \(host === '127\.0\.0\.1' \|\| host === 'localhost' \|\| host === '\[::1\]'\)/.test(src)) {
    problems.push('isExternalNavigation 不是主机名全等白名单（前缀匹配可被 127.0.0.1.evil.com 绕过）');
  }
  if (!/onLoadIntercept\([^)]*\)[\s\S]{0,400}?isExternalNavigation\(/.test(src)) {
    problems.push('onLoadIntercept 未使用 isExternalNavigation 判定');
  }
  const ml = src.match(/methodList:\s*\[([^\]]*)\]/)?.[1] ?? '';
  const registered = Array.from(ml.matchAll(/'([a-zA-Z]+)'/g), (m) => m[1]);
  for (const name of registered) {
    if (FORBIDDEN.includes(name)) problems.push(`methodList 出现通用执行类方法 '${name}'`);
  }
  return problems;
}

const srcs = {};
const problems = [];
for (const [mod, rel] of Object.entries(FILES)) {
  srcs[mod] = readFileSync(join(ROOT, rel), 'utf8');
  for (const p of judge(srcs[mod])) problems.push(`[${mod}] ${p}`);
}

if (!process.argv.includes('--self-test')) {
  if (problems.length > 0) {
    console.error(`❌ 桥暴露面不成立（${problems.length} 处）：`);
    for (const p of problems) console.error(`   · ${p}`);
    process.exit(1);
  }
  console.log('✅ 通过：契约同源闸门在位、外开协议/主机名校验为全等、onLoadIntercept 接管外链、无通用执行型桥方法。');
  process.exit(0);
}

console.log('--self-test：变异体必须判红 --');
console.log(`  基线：${problems.length} 处问题（应为 0）`);
let ok = problems.length === 0;
const mutations = [
  ['去掉 openExternal 的协议复校', srcs.entry.replace('if (!isOpenableUrl(target)) {', 'if (false) {')],
  ['把主机名全等改成前缀', srcs.entry.replace("if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]')", "if (host.startsWith('127.0.0.1'))")],
  ['去掉契约同源闸门', srcs.entry.replace(/'origin-denied'/g, "'denied'")],
  ['给 methodList 加 exec', srcs.entry.replace("methodList: ['startPick'", "methodList: ['exec', 'startPick'")],
];
for (const [label, mutated] of mutations) {
  const red = judge(mutated).length > 0;
  console.log(`  ${red ? '✅' : '❌'} ${label} ⇒ ${red ? '判红' : '未判红（门禁没牙）'}`);
  if (!red) ok = false;
}
console.log(ok ? '\n✅ 自检通过。' : '\n❌ 自检失败。');
process.exit(ok ? 0 : 3);
