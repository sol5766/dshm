#!/usr/bin/env node
/**
 * dsh 环境补丁：修 @deepseek-ai/dsh-client-modules 的启动期性能瓶颈。
 *
 * 背景（2026-09-11 实测，V8 --cpu-prof，主机 `node --jitless … dsh web`）：
 *   冷启动 wall≈19.6s，其中
 *     newlineCount        @ dsh-client-modules/lib/index.js  57.8%  11.4s
 *     buildCombo          @ 同文件                            8.3%   1.6s
 *     identitySectionMap  @ 同文件                            5.6%   1.1s
 *  即：**客户端合并包（/plugins/??…，约 11MB）的拼装占了启动时间的一半以上**。
 *
 * 根因：newlineCount 用 `for (const char of value)` 逐码点遍历字符串，
 * V8 每次迭代都会分配一个单字符字符串；对 11MB 文本就是千万次分配，
 * 在 --jitless（无 JIT 优化）下被放大到十几秒。indexOf 走原生扫描，
 * 语义完全等价但快几个数量级。
 *
 * 同时把 identitySectionMap 里 `Array.from({length:n}, cb).join(";")` 的
 * 逐行数组构造换成等价的字符串重复（n=0 → ""，n≥1 → "AAAA" + ";AACA"×(n-1)）。
 *
 * 效果（主机，--jitless）：19.6s → 6.1s（3.2 倍）。
 *
 * --- 已评估但**未采用**的方案（勿重复尝试）---
 * 「把合并包产物缓存到磁盘（DSHM_COMBO_CACHE_DIR）」：能把主机 6.1s 再降到约 4.0s，
 * 但无法确证字节级等价 —— 469 次 buildCombo 调用只落盘 65 个键、其余 404 次命中，
 * 且「开缓存」与「关缓存」两次运行产出的 artifact 集合（以 rev 为指纹）有 55 项不同。
 * 由于 rev 里含非确定成分，跨进程比对本身不可靠，等于既没证明等价、也没定位差异，
 * 属于「可能悄悄换错客户端产物」的高风险改动，故回退。若将来重做，必须先有
 * 「同一进程内 cold/warm 各构建一次并逐字节比较」的等价性方案。
 *
 * 用法：node scripts/patch-dsh-env-client-modules.mjs <dshEnvDir>
 *   dshEnvDir 例如 entry/src/main/resources/rawfile/dsh
 * 幂等：已打过补丁则直接跳过。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const envDir = process.argv[2];
if (!envDir) {
  console.error('usage: node patch-dsh-env-client-modules.mjs <dshEnvDir>');
  process.exit(2);
}

const target = join(envDir, 'node_modules', '@deepseek-ai', 'dsh-client-modules', 'lib', 'index.js');

const ORIGINAL_NEWLINE_COUNT = `function newlineCount(value) {
\tlet count = 0;
\tfor (const char of value) if (char === "\\n") count += 1;
\treturn count;
}`;

const PATCHED_NEWLINE_COUNT = `function newlineCount(value) {
\t// DSHM-OHOS patch: 逐码点 \`for (const char of value)\` 会为每个字符分配一个
\t// 单字符字符串，对约 11MB 的合并包源码就是千万次分配；--jitless 下实测占
\t// 整个冷启动的 57.8%（11.4s/19.6s）。indexOf 走原生扫描，语义完全一致。
\tlet count = 0;
\tlet index = value.indexOf("\\n");
\twhile (index !== -1) {
\t\tcount += 1;
\t\tindex = value.indexOf("\\n", index + 1);
\t}
\treturn count;
}`;

const ORIGINAL_IDENTITY_MAP = `\tconst mappings = Array.from({ length: newlineCount(source) }, (_, index) => index === 0 ? "AAAA" : "AACA").join(";");`;

const PATCHED_IDENTITY_MAP = `\t// DSHM-OHOS patch: 等价改写，避免为每一行构造数组元素再 join。
\tconst lineCount = newlineCount(source);
\tconst mappings = lineCount === 0 ? "" : "AAAA" + ";AACA".repeat(lineCount - 1);`;

// ---- 第三段：同一进程内的合并包记忆化 ----
// 实测：一轮启动里 buildCombo 被调用 469 次，但只有 65 个互不相同的产物 ——
// 约 400 次是在用**完全相同的输入**重复拼装同一个合并包。
// 这里加一层进程内 Map（不落盘、不跨进程）：键 = 每个 record 的
// (entry.id, entry.rev) + 显式 revision，而 entry.rev 本身就是内容指纹
// （pluginArtifactRev = framedHash("plugin-artifact", [bundle(, sourceMap.body)])），
// 所以同一键必然对应同一份产物。设 DSHM_COMBO_VERIFY=1 时会在每次命中处
// 重新构建并逐字节比对，用来自证等价。
const ORIGINAL_BUILD_COMBO_HEAD = `/** Concatenate one or more factory registrations and compose their maps as indexed sections. */
function buildCombo(records, revision) {`;

const PATCHED_BUILD_COMBO_HEAD = `// ---------------------------------------------------------------------------
// DSHM-OHOS patch: 同一进程内的合并包记忆化（不落盘、不跨进程）
//
// 为什么：一轮启动中 buildCombo 被调用 469 次，只有 65 个互不相同的产物，
// 其余约 400 次是用完全相同的输入重复拼装（每次都涉及 MB 级字符串拼接、数行、
// 造 source map、JSON.stringify、UTF-8 编码与哈希）。实测约占打完 newlineCount
// 补丁后剩余冷启动时间的三分之一。
//
// 为什么安全：键取每个 record 的 (entry.id, entry.rev) 加显式 revision，而
// entry.rev 就是内容指纹，所以同一键 ⇒ 同一输入 ⇒ 同一产物；命中时返回的就是
// 本进程早先构建的同一个对象。不存在跨进程/跨版本失效问题（这是它与被否掉的
// 磁盘缓存方案的本质区别）。DSHM_COMBO_VERIFY=1 时会在每次命中处重新构建并
// 逐字节比对，用来自证等价。
// ---------------------------------------------------------------------------
const COMBO_MEMO = new Map();
const COMBO_MEMO_MAX = 512;
let COMBO_MEMO_HITS = 0;
let COMBO_MEMO_VERIFIED = 0;
let COMBO_MEMO_MISMATCH = 0;

function comboMemoKey(records, revision) {
\tconst hash = createHash("sha1");
\thash.update(revision === void 0 ? "" : String(revision));
\thash.update("\\u0000");
\tfor (const record of records) {
\t\thash.update(record.entry.id);
\t\thash.update("\\u0000");
\t\tconst rev = record.entry.rev;
\t\tif (typeof rev === "string" && rev !== "") hash.update(rev);
\t\telse hash.update(record.bundle);
\t\thash.update("\\u0000");
\t}
\treturn hash.digest("hex");
}

function comboMemoArtifactDiffers(memoized, fresh) {
\tif (memoized.rev !== fresh.rev) return "rev";
\tif (memoized.sourceMapUrl !== fresh.sourceMapUrl) return "sourceMapUrl";
\tif (memoized.url !== fresh.url) return "url";
\tif (memoized.entries.join(",") !== fresh.entries.join(",")) return "entries";
\tif (memoized.script.length !== fresh.script.length) return "script.length";
\tif (!memoized.script.equals(fresh.script)) return "script.bytes";
\tif (memoized.sourceMap.length !== fresh.sourceMap.length) return "sourceMap.length";
\tif (!memoized.sourceMap.equals(fresh.sourceMap)) return "sourceMap.bytes";
\treturn void 0;
}

/** Concatenate one or more factory registrations and compose their maps as indexed sections. */
function buildCombo(records, revision) {
\tcomboMemoScheduleReport();
\tconst memoKey = comboMemoKey(records, revision);
\tconst memoized = COMBO_MEMO.get(memoKey);
\tif (memoized !== void 0) {
\t\tCOMBO_MEMO_HITS += 1;
\t\tif (process.env.DSHM_COMBO_VERIFY === "1") {
\t\t\tconst fresh = buildComboUncached(records, revision);
\t\t\tconst differs = comboMemoArtifactDiffers(memoized, fresh);
\t\t\tif (differs === void 0) COMBO_MEMO_VERIFIED += 1;
\t\t\telse {
\t\t\t\tCOMBO_MEMO_MISMATCH += 1;
\t\t\t\tprocess.stderr.write("[dshm-combo-memo] MISMATCH at " + differs + " for " + memoKey + "\\n");
\t\t\t}
\t\t}
\t\treturn memoized;
\t}
\tconst artifact = buildComboUncached(records, revision);
\tif (COMBO_MEMO.size >= COMBO_MEMO_MAX) COMBO_MEMO.clear();
\tCOMBO_MEMO.set(memoKey, artifact);
\treturn artifact;
}

/** 诊断出口：打印记忆化统计（仅在 DSHM_COMBO_VERIFY=1 时输出）。 */
function comboMemoReport() {
\tif (process.env.DSHM_COMBO_VERIFY !== "1") return;
\tprocess.stderr.write("[dshm-combo-memo] hits=" + String(COMBO_MEMO_HITS) +
\t\t" verified=" + String(COMBO_MEMO_VERIFIED) +
\t\t" mismatches=" + String(COMBO_MEMO_MISMATCH) +
\t\t" distinct=" + String(COMBO_MEMO.size) + "\\n");
}

// 启动期事件循环被同步任务堵住，定时器会在启动完成后才真正跑起来 ——
// 正好用它把统计打在启动结束之后。
let COMBO_MEMO_REPORT_TIMER = null;
function comboMemoScheduleReport() {
\tif (process.env.DSHM_COMBO_VERIFY !== "1" || COMBO_MEMO_REPORT_TIMER !== null) return;
\tCOMBO_MEMO_REPORT_TIMER = setInterval(() => {
\t\tclearInterval(COMBO_MEMO_REPORT_TIMER);
\t\tCOMBO_MEMO_REPORT_TIMER = null;
\t\tcomboMemoReport();
\t}, 2000);
\tif (typeof COMBO_MEMO_REPORT_TIMER.unref === "function") COMBO_MEMO_REPORT_TIMER.unref();
}

/** 原实现（未记忆化）。 */
function buildComboUncached(records, revision) {`;

let text = readFileSync(target, 'utf8');
const applied = [];

function replaceOnce(label, from, to) {
  if (text.includes(to)) {
    applied.push(label + ': already-patched');
    return;
  }
  const first = text.indexOf(from);
  if (first === -1) {
    applied.push(label + ': SOURCE-NOT-FOUND');
    return;
  }
  if (text.indexOf(from, first + 1) !== -1) {
    applied.push(label + ': AMBIGUOUS(>1 match)');
    return;
  }
  text = text.slice(0, first) + to + text.slice(first + from.length);
  applied.push(label + ': patched');
}

replaceOnce('newlineCount', ORIGINAL_NEWLINE_COUNT, PATCHED_NEWLINE_COUNT);
replaceOnce('identitySectionMap', ORIGINAL_IDENTITY_MAP, PATCHED_IDENTITY_MAP);
replaceOnce('buildCombo:memo', ORIGINAL_BUILD_COMBO_HEAD, PATCHED_BUILD_COMBO_HEAD);

const fatal = applied.some((line) => line.includes('SOURCE-NOT-FOUND') || line.includes('AMBIGUOUS'));
if (!fatal) writeFileSync(target, text, 'utf8');

for (const line of applied) console.log('[patch-client-modules] ' + line);
console.log('[patch-client-modules] target=' + target);
process.exit(fatal ? 1 : 0);
