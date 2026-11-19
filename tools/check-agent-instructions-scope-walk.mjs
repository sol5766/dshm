#!/usr/bin/env node
/*
 * 门禁：**上游「向上找项目根」在路径闸门下的行为**（正臂 + 四条对照臂）
 *
 * ---------------------------------------------------------------------------
 * 为什么要有它（2026-10-10 真机 P0，见 docs/139）
 * ---------------------------------------------------------------------------
 * 上游 `dsh-agent-instructions` 由 `projectRootMarkers`（默认 `['.git']`）决定项目根：
 * `findProjectRoot()` 从会话 cwd **逐级向上**探 `<dir>/.git`，判据落在
 * `existsAsMarker()` —— 它**只把 `FS_NOT_FOUND` 当成"这里没有标记"**，其余一律 `throw`。
 * 而 `docs/137` 的路径闸门对允许面之外的路径抛 `FS_PERMISSION_DENIED`
 * ⇒ 真机（PC 档，默认工作区 `/storage/Users/currentUser/Download/com.dshm.dshclient`，
 * 一路上没有 `.git`）第 4 跳 `/storage/Users/.git` 直接炸；它是在 `compose()` 里被
 * `agent/pre-step` await 的 ⇒ **整轮都是"本轮运行失败"**。
 *
 * 本门禁不读标记字符串（那是 `check-core-openharmony-patches.mjs` 的活），而是**真跑一遍**
 * 树里那份 `dsh-agent-instructions`：给它一个"像闸门一样"的假 `ctx.fs`，
 * 看它**炸不炸**。判据只有一条：**上游原文必须炸、注入后必须不炸** —— 少了对照臂就退化成
 * "两边都炸也绿"。
 *
 * 臂（全部用同一份假 fs 口径，只有"面外探测抛什么码"这一处不同）：
 *   A 正臂   · 已修 + 面外 ⇒ `FS_PERMISSION_DENIED` ⇒ **必须不炸**，且确实探到了面外那一跳
 *   B 对照臂 · 上游原文 + 同样的 fs ⇒ **必须炸**（这条就是真机故障的复现；它红 = 补丁没生效）
 *   C 对照臂 · 已修 + 面外抛**别的码**（裸 `EPERM`）⇒ **必须仍炸**（证明只多认那一个码，不是"一律吞"）
 *   D 对照臂 · 已修 + cwd 下就有 `.git` ⇒ 正常返回，且**一次都不往 cwd 上面探**
 *   E 对照臂 · 上游原文 + 面外"根本不存在"（FS_NOT_FOUND，等于没闸门）⇒ **必须不炸**
 *             （证明 B 的炸来自闸门那个码，而不是夹具自己有问题）
 *
 * 用法：node tools/check-agent-instructions-scope-walk.mjs
 * 退出码：0 通过 / 1 有真实问题 / 3 环境不具备（核心树未就位，不是失败）
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const recipe = JSON.parse(readFileSync(join(ROOT, 'hostcore', 'core-recipe.json'), 'utf8'));
const STAGE_NAME = `dsh-core-${recipe.coreVersion}`;
const TREE = join(ROOT, 'dist', 'core', 'work', STAGE_NAME);
const PKG_REL = join('node_modules', '@deepseek-ai', 'dsh-agent-instructions');
const TREE_LIB = join(TREE, PKG_REL, 'lib', 'index.js');

if (!existsSync(TREE_LIB)) {
  console.error(`环境不具备：核心树未就位（${TREE_LIB}）—— 先跑 node tools/pack-core.mjs --skip-install --place-in-app`);
  process.exit(3);
}

/* 注入形态 ↔ 上游原文（与 tools/check-core-openharmony-patches.mjs 的 ㉔ 组同源；
 * 这里必须逐字，否则"把补丁撤回去"这件事只做一半，B 臂会假绿）。 */
const CATCH_UPSTREAM = '\t\tif (isMissingProviderPathError(error)) return false;';
const CATCH_PATCHED = '\t\tif (isMissingProviderPathError(error) || isScopeDeniedProviderPathError(error)) return false;';
const HELPER_UPSTREAM = 'function isMissingProviderPathError(error) {\n\treturn error instanceof Error && "code" in error && error.code === "FS_NOT_FOUND";\n}\nasync function nodeStatFile(path, signal) {';
const HELPER_PATCHED = 'function isMissingProviderPathError(error) {\n\treturn error instanceof Error && "code" in error && error.code === "FS_NOT_FOUND";\n}\n/*\n * 【DSHM 端侧补丁 2026-10-10（DSHM_SCOPE_WALK_TOLERANT）】同族判据：**允许面之外**的探测。\n * 拒绝码就是 docs/137 的 fs-fence.js 用的那个 `FS_PERMISSION_DENIED`（它只有一个码）。\n * 这里**不 import** 闸门（上游文件不依赖端侧插件），只认码。\n */\nfunction isScopeDeniedProviderPathError(error) {\n\treturn error instanceof Error && "code" in error && error.code === "FS_PERMISSION_DENIED";\n}\nasync function nodeStatFile(path, signal) {';

const treeText = readFileSync(TREE_LIB, 'utf8').replace(/\r\n/g, '\n');
for (const [lit, label] of [[CATCH_PATCHED, '两码判断行'], [HELPER_PATCHED, '判据助手']]) {
  if (treeText.split(lit).length - 1 !== 1) {
    console.error(`环境不具备/树形态已变：找不到注入形态（${label}）—— 出包链路或上游结构变了，先复核 pack-core 的 ㉔ 补丁`);
    process.exit(3);
  }
}
const pristineText = treeText.split(HELPER_PATCHED).join(HELPER_UPSTREAM).split(CATCH_PATCHED).join(CATCH_UPSTREAM);
if (pristineText === treeText) {
  console.error('对照臂夹具失效：还原后与树内逐字节相同（说明用的不是注入形态）');
  process.exit(1);
}

/* ── 舞台：把两份包放到临时目录，用 junction 指回核心树的 node_modules 供裸导入解析 ── */
const stage = mkdtempSync(join(tmpdir(), 'dshm-walk-'));
const patchedLib = join(stage, 'patched', 'lib');
const pristineLib = join(stage, 'pristine', 'lib');

/* ── 假 ctx.fs：像闸门一样只对面外说"不行"；探针全记账 ── */
function fakeFs({ inScope, outOfScopeCode }) {
  const probes = [];
  const classify = (p) => (inScope(p) ? 'in' : 'out');
  const outError = () => {
    if (outOfScopeCode === null) return Object.assign(new Error(`cannot resolve "${'x'}": not found`), { code: 'FS_NOT_FOUND' });
    return Object.assign(new Error('路径在 DSHM 的允许范围之外，已拒绝访问'), { code: outOfScopeCode });
  };
  return {
    probes,
    async resolve(path) {
      const where = classify(path);
      probes.push([where, path]);
      if (where === 'out') throw outError();
      return { displayPath: path, targetKey: path };
    },
    async stat(target) {
      probes.push(['stat', target.targetKey]);
      const error = Object.assign(new Error(`not found: ${target.targetKey}`), { code: 'FS_NOT_FOUND' });
      throw error;
    },
    async streamText() {
      /* eslint-disable-next-line no-unused-vars */
      return (async function* empty() {})();
    },
  };
}

/** 加载一次基线（返回 {ok, error, probes}）。 */
async function runArm(dir, fsImpl, options) {
  const mod = await import(pathToFileURL(join(dir, 'lib', 'index.js')).href);
  try {
    await mod.loadBaselineInstructions(options, fsImpl);
    return { ok: true, error: null, probes: fsImpl.probes };
  } catch (error) {
    return { ok: false, error, probes: fsImpl.probes };
  }
}

/* 口径：夹具必须与模块内一致 —— 模块用 node:path 处理这些路径，在 Windows 上
 * `/storage/Users/currentUser` 会被 resolve 成 `<盘符>:\\storage\\Users\\currentUser`。
 * 所以这里一律先过 resolve()，断言里比较的也是**同一口径**的字符串。 */
const HOME = resolvePath('/storage/Users/currentUser');
const CWD = join(HOME, 'Download', 'ws');
/* 面外那一跳：HOME 的父目录 + `.git` —— 真机上就是 `/storage/Users/.git`（同级别人的目录）。 */
const OUTSIDE_GIT = join(dirname(HOME), '.git');
const inScope = (p) => p === HOME || p.startsWith(HOME + sep);
const baseOptions = {
  cwd: CWD,
  dshHome: join(stage, 'fake-dsh-home'),
  agentsHome: join(stage, 'fake-agents-home'),
  projectRootMarkers: ['.git'],
  maxBytes: 262144,
  maxSourceBytes: 262144,
  instructionFileCandidates: ['AGENTS.md'],
  localInstructionFileCandidates: ['AGENTS.local.md'],
};

let passed = 0;
let failed = 0;
const ok = (m) => { console.log(`ok    ${m}`); passed += 1; };
const bad = (m) => { console.log(`FAIL  ${m}`); failed += 1; };

try {
  cpSync(join(TREE, PKG_REL), join(stage, 'patched'), { recursive: true });
  cpSync(join(TREE, PKG_REL), join(stage, 'pristine'), { recursive: true });
  writeFileSync(join(pristineLib, 'index.js'), pristineText, 'utf8');
  symlinkSync(join(TREE, 'node_modules'), join(stage, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');

  /* A 正臂 */
  const a = await runArm(join(stage, 'patched'), fakeFs({ inScope, outOfScopeCode: 'FS_PERMISSION_DENIED' }), baseOptions);
  if (a.ok) ok('A 正臂：面外探测 FS_PERMISSION_DENIED ⇒ 不炸（上游原文会炸，见 B）');
  else bad(`A 正臂：已修版仍然炸了 —— ${a.error?.code ?? ''} ${a.error?.message ?? a.error}`);
  const aOut = a.probes.filter(([w, p]) => w === 'out' && p === OUTSIDE_GIT);
  if (aOut.length === 1) ok(`A 正臂：确实走到了面外那一跳 ${OUTSIDE_GIT}（真机等价物 /storage/Users/.git；不是"没探到所以没炸"）`);
  else bad(`A 正臂：没有探到面外那一跳 ${OUTSIDE_GIT}（真机等价物 /storage/Users/.git；记账 ${a.probes.length} 条：`
    + `${JSON.stringify(a.probes.slice(0, 12))}）⇒ 夹具与真机路径不符，本条不算数`);

  /* B 对照臂：上游原文必须炸 */
  const b = await runArm(join(stage, 'pristine'), fakeFs({ inScope, outOfScopeCode: 'FS_PERMISSION_DENIED' }), baseOptions);
  if (!b.ok && b.error?.code === 'FS_PERMISSION_DENIED') ok('B 对照臂：上游原文 + 同一个闸门 ⇒ 炸（真机 P0 的复现；本臂绿 = 注入的容忍真的在起作用）');
  else bad(`B 对照臂：上游原文本应炸出 FS_PERMISSION_DENIED，实际 ${b.ok ? '没炸' : `code=${b.error?.code}`} —— 夹具失效或补丁形态已变`);

  /* C 对照臂：只多认一个码 */
  const c = await runArm(join(stage, 'patched'), fakeFs({ inScope, outOfScopeCode: 'EPERM' }), baseOptions);
  if (!c.ok && c.error?.code === 'EPERM') ok('C 对照臂：已修版遇到**别的**码（裸 EPERM）⇒ 仍然炸（只多认 FS_PERMISSION_DENIED，不是一律吞）');
  else bad(`C 对照臂：已修版把 EPERM 也吞了（${c.ok ? '没炸' : `code=${c.error?.code}`}）—— 容忍面过宽`);

  /* D 对照臂：面内就有 .git ⇒ 正常，且不往 cwd 上面探 */
  const dFs = fakeFs({ inScope, outOfScopeCode: 'FS_PERMISSION_DENIED' });
  dFs.resolve = async (path) => {
    dFs.probes.push(['resolve', path]);
    return { displayPath: path, targetKey: path };
  };
  dFs.stat = async (target) => {
    dFs.probes.push(['stat', target.targetKey]);
    if (target.targetKey === join(CWD, '.git')) return { type: 'file', size: 1, version: 'v1' };
    throw Object.assign(new Error('not found'), { code: 'FS_NOT_FOUND' });
  };
  const d = await runArm(join(stage, 'patched'), dFs, baseOptions);
  const dAbove = d.probes.filter(([, p]) => p === OUTSIDE_GIT || p === resolvePath('/.git'));
  if (d.ok && dAbove.length === 0) ok('D 对照臂：cwd 下有 .git ⇒ 正常返回且不再向上探（项目根识别语义没被改坏）');
  else bad(`D 对照臂：${d.ok ? '返回正常' : '炸了'}，但向上探了 ${dAbove.length} 次（应为 0）`);

  /* E 对照臂：没有闸门（面外也 FS_NOT_FOUND）时上游原文本来就不炸 */
  const e = await runArm(join(stage, 'pristine'), fakeFs({ inScope, outOfScopeCode: null }), baseOptions);
  if (e.ok) ok('E 对照臂：上游原文 + 面外"不存在"（无闸门）⇒ 不炸（证明 B 的炸来自闸门那个码，不是夹具自身）');
  else bad(`E 对照臂：无闸门时上游原文仍炸（${e.error?.code}）—— 夹具自身有问题，B 臂结论作废`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed —— 上游 findProjectRoot() 的面外探测在闸门下必须"当作没有标记"（不炸），`
  + '而闸门本身（FS_PERMISSION_DENIED）与其它错误码的错误语义都没被放宽。');
process.exit(failed === 0 ? 0 : 1);