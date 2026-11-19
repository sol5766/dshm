#!/usr/bin/env node
/**
 * 门禁：javaScriptProxy 的 methodList 必须**覆盖**页面垫片实际调用的所有桥方法。
 *
 * 【为什么要守（2026-10-29 真机性能事故）】entry 模块的 methodList 漏了 `platformPcMode`
 * （phone 模块有、迁移遗漏）。后果：侧栏垫片的 300ms tick 每拍调 `b.platformPcMode()`，
 * ArkWeb 找不到代理对象就打一条 "native proxy object not found, name:__DSHM_BRIDGES__"，
 * 并伴随 5 行 OhGin 调度日志 —— 实测 node-output.log 全链（4 档）
 * 累计 **124,000+ 次报错、约 60% 的日志字节**（263 MiB 中约 150 MiB）都来自这一个遗漏；
 * 每秒一次的桥调用 + 文件写放大是"应用开久了打字顿挫"的直接贡献源之一。
 * 这种错**不报编译错、不崩**，只有性能与日志慢慢劣化 —— 必须静态钉住。
 *
 * 判据：从每个 WebApp.ets 里抽出
 *   ① methodList 里登记的方法名；
 *   ② bridges 对象里**定义**的方法名（'name': 形态）；
 *   ③ 垫片代码里实际**调用**的桥方法（b.<name>( / __DSHM_BRIDGES__.<name>(）。
 * 三者必须满足：③ ⊆ ①（调用的必须已登记），且 ① ⊆ ②（登记的必须有定义）。
 *
 * 【2026-10-29 追加：方案 A 失焦降频（docs/277 §4-A）】四个 300/500ms 轮询垫片必须
 * 挂 visibilitychange 节流（SIDEBAR 降频 1500ms 保自愈；其余三个 hidden 停摆）。
 * 没有它 ⇒ 后台每秒 200+ 次 DOM/桥操作白耗，正是"开久了顿挫"的温床。
 *
 * 对照臂（--self-test）：删掉 methodList 里一个名字 ⇒ 必须判红。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FILES = {
  entry: 'entry/src/main/ets/pages/WebApp.ets',
  phone: 'phone/src/main/ets/pages/WebApp.ets',
};

function judge(src) {
  const problems = [];
  const mlMatch = src.match(/methodList:\s*\[([^\]]*)\]/);
  if (mlMatch === null) {
    return ['找不到 methodList'];
  }
  const registered = new Set(Array.from(mlMatch[1].matchAll(/'([a-zA-Z]+)'/g), (m) => m[1]));
  const bridgeMatch = src.match(/private bridges: Record<string, Function> = \{([\s\S]*?)\n  \};/);
  if (bridgeMatch === null) {
    return ['找不到 this.bridges 聚合对象'];
  }
  /*
   * bridges 定义有两种形态（都会出现）：
   *   · 行首  'name': (id: string): string => …   （第一项，无逗号前缀）
   *   · 缩进  ,'name': (…                          （后续项，逗号前缀）
   * 正则必须两者都认，否则会把真实定义误报成"没有定义"。
   */
  const defined = new Set(Array.from(bridgeMatch[1].matchAll(/(?:^\s+|,)\s*'([a-zA-Z]+)':\s*\(/gm), (m) => m[1]));
  // 垫片调用：b.<name>( 或 __DSHM_BRIDGES__.<name>(
  const called = new Set(Array.from(src.matchAll(/\bb\.([a-zA-Z]+)\(/g), (m) => m[1]));
  for (const name of called) {
    if (!registered.has(name)) {
      problems.push(`垫片调用了 b.${name}() 但 methodList 未登记（原生侧无代理 ⇒ 每次调用打一条 not found）`);
    }
  }
  for (const name of registered) {
    if (!defined.has(name)) {
      problems.push(`methodList 登记了 '${name}' 但 bridges 对象里没有定义`);
    }
  }
  /*
   * 方案 A：四个轮询垫片必须挂失焦节流。
   * 判据形态：visibilitychange 监听 + 各自的停摆/降频变量。
   * （只判 entry：phone 模块同一批垫片尚未接方案 A，接上后再把 FILES.phone 纳入本段。）
   */
  const visListeners = (src.match(/document\.addEventListener\('visibilitychange'/g) || []).length;
  if (visListeners < 4) {
    problems.push(`失焦节流不完整：visibilitychange 监听只有 ${visListeners} 处（4 个轮询垫片应各 1 处）`);
  }
  if (!src.includes('TICK_BG_MS')) {
    problems.push('SIDEBAR 垫片缺 TICK_BG_MS（hidden 时 300ms→1500ms 降频）');
  }
  /*
   * 【2026-10-29 追加：桥未就位时必须退避（docs/291 §5.1）】
   * 垫片由 javaScriptOnDocumentStart 注入（早于页面脚本），桥由 `.javaScriptProxy`
   * 属性注册 —— 两者不保证同时就位。桥对象存在但方法还没挂上时，每拍调用一次
   * 都会让 ArkWeb 打一条 `native proxy object not found, name:__DSHM_BRIDGES__`
   * （真机实测持续 13 次/秒、占日志六成）。判据：applyHandheld 的"桥未就位"分支
   * 必须写退避时间（`bridgeRetryAt`），且退避变量在文件里真的有定义。
   */
  if (!src.includes('bridgeRetryAt')) {
    problems.push('桥探测缺退避（bridgeRetryAt）：桥未就位时会每拍调用一次并刷 ArkWeb 报错');
  }
  if (!/bridgeMiss\s*=\s*Math\.min\(bridgeMiss \+ 1/.test(src)) {
    problems.push('桥探测的退避不是指数递增（bridgeMiss = Math.min(bridgeMiss + 1, …)）');
  }
  if (!/bridgeMiss\s*=\s*0;\s*\n\s*bridgeRetryAt\s*=\s*0;/.test(src)) {
    problems.push('桥就位后没有清零退避（成功一次仍会卡在旧的重试时间）');
  }
  return problems;
}

const selfTest = process.argv.includes('--self-test');
const srcs = {};
const problems = [];
/*
 * 【2026-11-16 追加：生成清单比对】methodList 与 bridges 是两份人工清单，
 * 漂移方向有两个（漏登记 / 多定义）。定义侧已由 gen-bridge-methods.mjs 生成清单，
 * 这里调用它的 --check：过期或不一致 ⇒ 判红。只读检查，不写文件。
 */
if (!selfTest) {
  const generated = spawnSync(process.execPath, [join(ROOT, 'tools/gen-bridge-methods.mjs'), '--check'], {
    cwd: ROOT, encoding: 'utf8',
  });
  if (generated.status !== 0) {
    problems.push(`方法表生成清单不一致：${String(generated.stderr || generated.stdout || '').trim()}`);
  }
}
for (const [mod, rel] of Object.entries(FILES)) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  srcs[mod] = text;
  for (const p of judge(text)) {
    problems.push(`[${mod}] ${p}`);
  }
}

if (!selfTest) {
  if (problems.length > 0) {
    console.error(`❌ 桥方法登记不完整（${problems.length} 处）：`);
    for (const p of problems) console.error(`   · ${p}`);
    process.exit(1);
  }
  console.log('✅ 通过：methodList 覆盖垫片全部桥调用，且登记项都有定义（entry + phone）。');
  process.exit(0);
}

/* 自检：删掉 entry 的 platformPcMode 必须判红 */
let ok = true;
console.log('--self-test：变异体必须判红 --');
const baseline = judge(srcs.entry);
console.log(`  基线：${baseline.length} 处问题（应为 0）`);
if (baseline.length !== 0) { ok = false; }
for (const [label, mutated] of [
  ['删掉 methodList 的 platformPcMode', srcs.entry.replace("'platformForm', 'platformPcMode',", "'platformForm',")],
  ['删掉桥探测退避（每拍硬打桥）', srcs.entry.replace(/bridgeMiss = Math\.min\(bridgeMiss \+ 1, 4\);\s*\n\s*bridgeRetryAt = now \+ Math\.pow\(2, bridgeMiss\) \* 500;/g, '')],
  ['删掉 phone 云同步桥定义但保留 methodList', srcs.phone.replace(/\s*,'cloudSyncState': \(\): string => this\.cloudSyncStateJson\(\)/, '').replace(/\s*,'cloudSyncAction': \(action: string\): string => this\.cloudSyncAction\(action\)/, '')],
]) {
  const judged = judge(mutated);
  const red = judged.length > 0;
  console.log(`  ${red ? '✅' : '❌'} ${label} ⇒ ${red ? `判红（${judged.length} 处）` : '未判红（门禁没牙）'}`);
  if (!red) { ok = false; }
}
console.log(ok ? '\n✅ 自检通过。' : '\n❌ 自检失败。');
process.exit(ok ? 0 : 3);