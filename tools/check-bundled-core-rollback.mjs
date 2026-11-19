#!/usr/bin/env node
/**
 * 门禁：内置核心"同版本换树"必须**先验证新树、后挪走旧树、失败回滚**。
 *
 * 【为什么要有这条（2026-10-29，docs/291 复核）】
 * 原实现是"先把旧树 `rename` 成 `.stale-*.tmp` → 再拷/解压/校验 → 最后无条件 `rmdir`"。
 * 覆盖安装一个**同版本号但内容损坏**的容器时：旧树已被挪走，新树在解压或哨兵校验处
 * 失败 ⇒ 失败分支只记一条 `failed`，末尾仍把旧树删掉 ⇒ 设备上该版本**一棵树都不剩**，
 * 而 `state.current` 还指着它 ⇒ 下次 `host.start()` 报"没有可用的核心树"，App 起不来。
 * `CoreStore` 里"current 版本拒绝覆盖"的守卫也同时失效（目录早被挪空）。
 *
 * 这种错**不报编译错、不崩**，只在"新容器恰好坏掉"那天让用户失去全部核心 ——
 * 正是最该被静态钉住、最容易被下一个人"顺手简化"回去的那类顺序约束。
 *
 * 【判据】只看源码结构，不需要核心树与设备：
 *   ① `CoreStore` 有 `stage()`（解包+校验，不落位）与 `commitStaged()`（落位）两段，
 *      且 `stage()` 的**函数体内**不得出现 `renameSync(inner, target)` 这类落位动作；
 *   ② `BundledCore.installOneVersion()` 里 `store.stage(` 的位置必须早于第一次
 *      `fs.renameSync(oldDir`（挪走旧树），后者必须早于 `commitStaged(`；
 *   ③ 回滚存在：`finally` 块里对 `stale` 的 `renameSync(stale, oldDir)`；
 *   ④ 反形态 0 命中：`installBundledCores` 主循环里不得再有"安装前 `renameSync` 旧树"
 *      或"`staged.ok` 之前 push staleDirs"的旧写法。
 *
 * 对照臂（--self-test）：把 ② 的三步顺序调换 / 删掉 ③ 的回滚 ⇒ 必须判红。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BUNDLED = 'hostruntime/src/main/ets/core/BundledCore.ets';
const CORE_STORE = 'hostruntime/src/main/ets/core/CoreStore.ets';

/** 取 `needle` 所在函数的函数体文本（从 needle 起，按大括号配平到函数结束）。 */
function bodyAfter(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) return '';
  const open = text.indexOf('{', at);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

/** 去掉注释后再判（"注释里写着正确顺序、代码已经改回去"是本仓踩过的坑）。 */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function judge(bundled, coreStore) {
  const problems = [];
  const b = stripComments(bundled);
  const c = stripComments(coreStore);

  // ── ① CoreStore 两段式 ────────────────────────────────────────────────
  const stageBody = bodyAfter(c, 'async stage(zipPath');
  const commitBody = bodyAfter(c, 'async commitStaged(');
  if (stageBody.length === 0) {
    problems.push('CoreStore 缺少 stage()（解包+校验、不落位）');
  } else if (/renameSync\(\s*inner\s*,\s*target\s*\)/.test(stageBody)) {
    problems.push('stage() 里出现了落位动作 renameSync(inner, target) —— 解包与落位必须分开');
  }
  if (commitBody.length === 0) {
    problems.push('CoreStore 缺少 commitStaged()（只落位、不删目标）');
  }

  // ── ② installOneVersion 三步顺序 ─────────────────────────────────────
  const oneBody = bodyAfter(b, 'async function installOneVersion(');
  if (oneBody.length === 0) {
    problems.push('BundledCore 缺少 installOneVersion()（首装与换树必须走同一条顺序）');
  } else {
    const atStage = oneBody.indexOf('store.stage(');
    const atMove = oneBody.indexOf('fs.renameSync(oldDir');
    const atCommit = oneBody.indexOf('store.commitStaged(');
    if (atStage < 0) problems.push('installOneVersion 没有调 store.stage()');
    if (atMove < 0) problems.push('installOneVersion 没有挪走旧树（renameSync(oldDir, …)）');
    if (atCommit < 0) problems.push('installOneVersion 没有调 store.commitStaged()');
    if (atStage >= 0 && atMove >= 0 && atStage > atMove) {
      problems.push('顺序错：旧树在新树通过 stage() 校验之前就被挪走了（失败会丢旧树）');
    }
    if (atMove >= 0 && atCommit >= 0 && atMove > atCommit) {
      problems.push('顺序错：commitStaged() 早于挪走旧树（同名目录会被当成"已存在"）');
    }
    // ── ③ 回滚 ───────────────────────────────────────────────────────
    const atFinally = oneBody.indexOf('finally {');
    const finallyBody = atFinally < 0 ? '' : oneBody.slice(atFinally);
    if (!/renameSync\(\s*stale\s*,\s*oldDir\s*\)/.test(finallyBody)) {
      problems.push('installOneVersion 的 finally 里没有回滚旧树（renameSync(stale, oldDir)）');
    }
  }

  // ── ④ 旧写法不得复活 ──────────────────────────────────────────────────
  const mainBody = bodyAfter(b, 'export async function installBundledCores(') +
    bodyAfter(b, 'async function runBundledInstall(');
  if (/staleDirs\.push\(/.test(mainBody) && !/outcome\.stale/.test(mainBody)) {
    problems.push('主循环仍在直接 push staleDirs（旧写法：安装前就决定要删旧树）');
  }
  if (/const stale: string = `\$\{oldDir\}\.stale-/.test(mainBody)) {
    problems.push('主循环里仍有"安装前改名旧树"的旧写法');
  }
  return problems;
}

const selfTest = process.argv.includes('--self-test');
const bundled = readFileSync(join(ROOT, BUNDLED), 'utf8');
const coreStore = readFileSync(join(ROOT, CORE_STORE), 'utf8');
const problems = judge(bundled, coreStore);

if (!selfTest) {
  if (problems.length > 0) {
    console.error(`❌ 内置核心换树顺序不安全（${problems.length} 处）：`);
    for (const p of problems) console.error(`   · ${p}`);
    process.exit(1);
  }
  console.log('✅ 通过：stage → 挪旧树 → commit → 失败回滚，旧写法 0 命中。');
  process.exit(0);
}

/* ── 对照臂：每个变异体都必须判红 ──────────────────────────────────────── */
let ok = true;
const base = judge(bundled, coreStore);
console.log('--self-test：变异体必须判红 --');
console.log(`  基线：${base.length} 处问题（应为 0）`);
if (base.length !== 0) ok = false;

const arms = [
  ['旧树挪到 stage 之前（还原成先挪后装）', () => {
    const oneBody = bodyAfter(bundled, 'async function installOneVersion(');
    const atStage = oneBody.indexOf('store.stage(');
    const atMove = oneBody.indexOf('fs.renameSync(oldDir');
    // 把"挪旧树"整段搬到 stage 之前
    const moveStart = oneBody.lastIndexOf('if (fs.accessSync(oldDir))', atMove);
    const moveEnd = oneBody.indexOf('\n    }', atMove) + '\n    }'.length;
    const moved = oneBody.slice(moveStart, moveEnd);
    const rest = oneBody.slice(0, moveStart) + oneBody.slice(moveEnd);
    const atStage2 = rest.indexOf('store.stage(');
    const mutatedOne = rest.slice(0, atStage2) + moved + '\n    ' + rest.slice(atStage2);
    return bundled.replace(oneBody, mutatedOne);
  }],
  ['删掉 finally 里的回滚', () => bundled.replace(
    /fs\.renameSync\(\s*stale\s*,\s*oldDir\s*\);/,
    '/* 回滚已删除 */')],
  ['stage() 里偷偷落位（两段又合并回去）', () => coreStore.replace(
    "return ok(`已解包并校验 ${version}（staging 就绪，等待落位）`);",
    "fs.renameSync(inner, target); return ok(`已解包并校验 ${version}`);")],
];
for (const [label, mutate] of arms) {
  const mutated = mutate();
  const changed = mutated !== bundled && mutated !== coreStore;
  const reds = changed ? judge(
    label.includes('stage()') ? bundled : mutated,
    label.includes('stage()') ? mutated : coreStore) : [];
  const red = changed && reds.length > 0;
  if (!red) ok = false;
  console.log(`  ${red ? '✅' : '❌'} ${label} ⇒ ${changed ? `判红（${reds.length} 处）` : '变异未生效'}`);
}
console.log(ok ? '\n✅ 自检通过。' : '\n❌ 自检失败（门禁没牙）。');
process.exit(ok ? 0 : 3);
