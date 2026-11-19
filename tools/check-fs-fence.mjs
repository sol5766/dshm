#!/usr/bin/env node
/*
 * 门禁：**DSHM 文件访问范围闸门**（docs/137）
 *
 * ---------------------------------------------------------------------------
 * 这条闸门防的是什么
 * ---------------------------------------------------------------------------
 * 用户 2026-10-10 拍板的策略是：**允许面 = 应用沙箱 ∪ `/storage/Users/currentUser/`，
 * 其余（系统数据区 / 别的应用沙箱 / 挂载点）读写都拒**。落实点是三处：
 *   ① `hostcore/plugins/dshm-fs-write-nonchmod/lib/index.js`（`ctx.fs` 后端，全部
 *      读/写/编辑/列目录都经它）；
 *   ② `hostcore/plugins/dshm-tool-fs-remove/lib/index.js` 的 **publish 目标**
 *      （那一处由插件自己用 node:fs 落盘，不过 `ctx.fs`）；
 *   ③ `dsh-tool-fs-search` 的 `glob` / `grep`（spawn ripgrep / 系统 find,grep，
 *      搜索根直接进 argv），由 `tools/pack-core.mjs` 把判据**原样搬进**核心树。
 * 三处的判据都来自同一份 `lib/fs-fence.js`（两份插件副本逐字节一致 + 打包期原样嵌入）。
 *
 * 这种"一份判据、三处消费"的结构最容易坏的方式是**静默分叉**：某个副本被改了一点、
 * 打包期的搬运被换掉、或某个入口悄悄不再调判据 —— 树里照样能跑，没有任何门禁会红，
 * 直到有人发现 agent 能读 `/etc`。所以本门禁钉四件事：
 *   A. 两份 `fs-fence.js` **逐字节一致**，且 BEGIN/END 标记各恰好一份；
 *   B. 判据的**行为矩阵**（允许面 / 面外 / 非绝对路径 / 逃生口 / env 推导），
 *      **带负控制**（`DSHM_FS_SCOPE=off` 必须全放行、改一个字必须变红）；
 *   C. 三个入口**真的接上了**（ctx.fs 的每个 method、publish 目标、pack-core 的两处
 *      调用点 + 块提取）；
 *   D. 若手头有核心树，则树里嵌进去的那一份与本仓这份**逐字节一致**。
 *
 * 用法：node tools/check-fs-fence.mjs
 *   只读本仓文件（核心树可选）；不需要设备、不需要网络。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { dirname } from 'node:path/posix';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FENCE_A = join(ROOT, 'hostcore', 'plugins', 'dshm-fs-write-nonchmod', 'lib', 'fs-fence.js');
const FENCE_B = join(ROOT, 'hostcore', 'plugins', 'dshm-tool-fs-remove', 'lib', 'fs-fence.js');
const FS_BACKEND = join(ROOT, 'hostcore', 'plugins', 'dshm-fs-write-nonchmod', 'lib', 'index.js');
const REMOVE_PLUGIN = join(ROOT, 'hostcore', 'plugins', 'dshm-tool-fs-remove', 'lib', 'index.js');
const PACK_CORE = join(ROOT, 'tools', 'pack-core.mjs');

const SCOPE_BEGIN = '/* ==== DSHM-FS-SCOPE-BEGIN ====';
const SCOPE_END = '/* ==== DSHM-FS-SCOPE-END ==== */';

let passed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed += 1; return true; }
  failures.push(label);
  return false;
}

/* ── A. 两份副本 + 标记 ─────────────────────────────────────────────────── */
const sourceA = readFileSync(FENCE_A, 'utf8');
const sourceB = readFileSync(FENCE_B, 'utf8');
ok(sourceA === sourceB, 'A1 两份 fs-fence.js 逐字节一致（dshm-fs-write-nonchmod ↔ dshm-tool-fs-remove）');
ok(sourceA.endsWith('\n') && !sourceA.includes('\r'), 'A2 判据文件是 LF、以换行结尾');

function scopeBlockOf(source, label) {
  const from = source.indexOf(SCOPE_BEGIN);
  const to = source.indexOf(SCOPE_END);
  ok(from >= 0 && to > from, `${label}：BEGIN/END 标记各在位且有序`);
  ok(source.indexOf(SCOPE_BEGIN, from + 1) < 0 && source.indexOf(SCOPE_END, to + 1) < 0, `${label}：BEGIN/END 各只出现一次`);
  return source.slice(from, to + SCOPE_END.length);
}
const blockA = scopeBlockOf(sourceA, 'A3');
const blockB = scopeBlockOf(sourceB, 'A4');
ok(blockA === blockB && blockA.length > 500, `A5 判据块非空且两侧同内容（${blockA.length} 字节）`);
ok(!/^\s*(import|export)\s/m.test(blockA), 'A6 判据块内没有 import/export（它要被原样嵌进上游文件中部）');

/* ── 载入判据（剥掉 import/export，注入 FsError/realpath/dirname）─────────
 * 为什么不直接 import：本仓根没有 node_modules（`@deepseek-ai/dsh-fs` 只在核心树
 * 与设备上），而这条门禁必须在**干净克隆 + CI** 里也能跑。剥壳必须是**可断言**的：
 * 只允许剥掉已知的 3 条 import 与 `export ` 前缀，数量对不上就判红。 */
class FsErrorStub extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
const IMPORT_RE = /^import[^\n]*\n/gm;
function loadFence(source, label) {
  const imports = source.match(IMPORT_RE) ?? [];
  const exports = source.match(/^export /gm) ?? [];
  ok(imports.length === 3, `${label}：判据文件恰好 3 条 import（逐条对应 FsError/realpath/dirname），实得 ${imports.length}`);
  ok(imports.some((line) => line.includes('from "@deepseek-ai/dsh-fs"')), `${label}：其中一条是 FsError（@deepseek-ai/dsh-fs）`);
  ok(imports.some((line) => line.includes('from "node:fs/promises"')), `${label}：其中一条是 realpath（node:fs/promises）`);
  ok(imports.some((line) => line.includes('from "node:path/posix"')), `${label}：其中一条是 dirname（node:path/posix）`);
  ok(exports.length === 4, `${label}：判据文件恰好 4 处 export，实得 ${exports.length}`);
  const body = source.replace(IMPORT_RE, '').replace(/^export /gm, '');
  const factory = new Function(
    'FsError', 'realpath', 'dirname',
    body + '\nreturn { assertFsScope, assertFsScopeLexical, fsScopeRoots, fsScopeEnabled, scopeRoots, scopeAllows, scopeNormalize, scopeDenialMessage };'
  );
  return factory(FsErrorStub, realpath, dirname);
}
const fence = loadFence(sourceA, 'A7');

/* ── B. 行为矩阵（env 必须在**第一次调用**前设好：允许面带进程内缓存）────── */
const DEVICE_ENV = {
  DSHM_SANDBOX_HOME: '/data/storage/el2/base/haps/entry/files',
  HOME: '/data/storage/el2/base/haps/entry/files',
  TMPDIR: '/data/storage/el2/base/cache',
  DSHM_PUBLIC_DOWNLOAD: '/storage/Users/currentUser/Download/com.dshm.dshclient'
};
function setEnv(env) {
  for (const key of ['DSHM_SANDBOX_HOME', 'HOME', 'TMPDIR', 'DSHM_PUBLIC_DOWNLOAD', 'DSHM_FS_SCOPE']) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}
setEnv(DEVICE_ENV);

const roots = fence.fsScopeRoots();
ok(roots.includes('/data/storage/el1/base') && roots.includes('/data/storage/el2/base'),
  `B1 允许面含两个应用数据根（实得 ${roots.length} 项）`);
ok(roots.includes('/storage/Users/currentUser'), 'B2 允许面含用户家目录');
ok(roots.every((root) => root === root.trim() && root.startsWith('/') && !root.endsWith('/')),
  'B3 允许面每一项都已归一化（绝对、无尾斜杠）');

const ALLOW = [
  '/data/storage/el1/base',
  '/data/storage/el2/base',
  '/data/storage/el2/base/cache',
  '/data/storage/el2/base/haps/entry/files/dsh/home/host-ready.json',
  '/data/storage/el2/base/haps/entry/files/workspace/notes/a.md',
  '/storage/Users/currentUser',
  '/storage/Users/currentUser/Documents/report.md',
  '/storage/Users/currentUser/Download/com.dshm.dshclient/out.md',
  '/data/storage/el2/base/haps/entry/../../el2/base/cache/x'
];
const DENY = [
  '/', '/etc', '/etc/passwd', '/system', '/system/etc/x', '/vendor',
  '/data', '/data/local/tmp/x', '/data/storage', '/data/storage/el3/base/x',
  '/storage', '/storage/Users', '/storage/Users/other/x', '/storage/Users/currentUserX/x',
  '/proc/1/environ', '/mnt/x', '/sys/kernel', '/tmp/x',
  'relative/path', '', '   '
];
for (const path of ALLOW) {
  try { fence.assertFsScopeLexical(path); } catch (error) {
    ok(false, `B4 词法应放行却拒绝：${path}（${error.code}）`);
  }
  try { await fence.assertFsScope(path); } catch (error) {
    ok(false, `B5 身份应放行却拒绝：${path}（${String(error.message).split('\n')[0]}）`);
  }
}
for (const path of DENY) {
  let threw = null;
  try { fence.assertFsScopeLexical(path); } catch (error) { threw = error; }
  ok(threw !== null, `B6 词法应拒却放行：${path}`);
  ok(threw === null || threw.code === 'FS_PERMISSION_DENIED', `B7 拒绝码是 FS_PERMISSION_DENIED：${path}`);
  let threwAsync = null;
  try { await fence.assertFsScope(path); } catch (error) { threwAsync = error; }
  ok(threwAsync !== null, `B8 身份应拒却放行：${path}`);
}
ok(ALLOW.length >= 8 && DENY.length >= 15, 'B9 行为矩阵的样本量下限（允许 ≥8 / 拒绝 ≥15）');

const denial = fence.scopeDenialMessage('/etc/passwd', roots);
ok(denial.includes('/etc/passwd') && denial.includes('/storage/Users/currentUser'),
  'B10 拒绝文案点明被拒路径与允许面');
ok(/DSHM|本应用/.test(denial) && /不是操作系统/.test(denial), 'B11 拒绝文案说清"这是本应用策略，不是 OS 报错"');

/* 负控制 1：逃生口必须让同一批路径全部放行（证明拦住它们的就是这条闸门） */
setEnv({ ...DEVICE_ENV, DSHM_FS_SCOPE: 'off' });
const fenceOff = loadFence(sourceA, 'B12');
ok(fenceOff.fsScopeEnabled() === false, 'B12 DSHM_FS_SCOPE=off ⇒ 闸门判为关闭');
let offAllowed = 0;
for (const path of DENY) {
  try { fenceOff.assertFsScopeLexical(path); offAllowed += 1; } catch { /* 关闭后仍拒 ⇒ 后面判红 */ }
}
ok(offAllowed === DENY.length, `B13 逃生口下全部放行（${offAllowed}/${DENY.length}）`);
setEnv(DEVICE_ENV);

/* 负控制 2：env 推导（换一份 HOME ⇒ 允许面跟着换；不是只认写死的两个常量） */
setEnv({ DSHM_SANDBOX_HOME: '/data/app/el2/100/base/com.example.app/haps/entry/files', HOME: '/data/app/el2/100/base/com.example.app/haps/entry/files', TMPDIR: '/data/app/el2/100/base/com.example.app/cache', DSHM_PUBLIC_DOWNLOAD: '/storage/Users/currentUser/Download/com.example.app' });
const fenceAlt = loadFence(sourceA, 'B14a');
const altRoots = fenceAlt.fsScopeRoots();
ok(altRoots.includes('/data/app/el2/100/base/com.example.app'), 'B14 env 推导出的沙箱根进了允许面');
ok(altRoots.includes('/data/app/el1/100/base/com.example.app'), 'B15 el1/el2 孪生根补齐');
ok(altRoots.includes('/data/app/el2/100/base/com.example.app/cache') === false, 'B16 推导根不含 cache 子目录（根就是应用数据根）');
let altThrew = null;
try { fenceAlt.assertFsScopeLexical('/data/app/el2/100/base/com.example.app/haps/entry/files/x'); } catch (error) { altThrew = error; }
ok(altThrew === null, `B17 推导根下的路径放行（${altThrew === null ? 'ok' : String(altThrew.message).split('\n')[0]}）`);
setEnv(DEVICE_ENV);

/* 负控制 3：抽掉用户根 ⇒ 用户目录必须立刻全拒（矩阵有牙） */
const mutatedSource = sourceA.replace('const SCOPE_USER_ROOT = "/storage/Users/currentUser";', 'const SCOPE_USER_ROOT = "/storage/Users/nobody";');
ok(mutatedSource !== sourceA, 'B18 变异体确实改到了用户根常量');
const fenceMutated = loadFence(mutatedSource, 'B19a');
let mutatedAllowed = 0;
for (const path of ['/storage/Users/currentUser', '/storage/Users/currentUser/Documents/report.md']) {
  try { fenceMutated.assertFsScopeLexical(path); mutatedAllowed += 1; } catch { /* 预期全被拒 */ }
}
ok(mutatedAllowed === 0, `B19 变异体下用户目录全拒（实得放行 ${mutatedAllowed}）`);
/* 反向：**已认领的工作区**即使不在用户根之下也必须仍然可用（`DSHM_PUBLIC_DOWNLOAD`
 * 本身就是一条允许面根）—— 否则换卷/换目录选出来的工作区会被自己的闸门锁死。 */
let claimedAllowed = false;
try { fenceMutated.assertFsScopeLexical('/storage/Users/currentUser/Download/com.dshm.dshclient/out.md'); claimedAllowed = true; } catch { /* 判红 */ }
ok(claimedAllowed, 'B20 已认领的工作区不受用户根变异影响（DSHM_PUBLIC_DOWNLOAD 自成一根）');

/* ── C. 三个入口真的接上了 ─────────────────────────────────────────────── */
const backend = readFileSync(FS_BACKEND, 'utf8');
ok(/import \{ assertFsScope, assertFsScopeLexical \} from "\.\/fs-fence\.js";/.test(backend),
  'C1 ctx.fs 后端 import 了判据');
const fencedMethods = ['resolve', 'stat', 'lstat', 'readText', 'streamText', 'readBytes', 'readByteRange', 'listDir', 'watch'];
for (const method of fencedMethods) {
  const re = new RegExp(`(async )?${method}\\([^)]*\\)\\s*\\{[^}]*assertFsScope`, 'm');
  ok(re.test(backend), `C2 ctx.fs 的 ${method}() 在动手前判范围`);
}
ok(/const checked = await this\.checkedTarget\([^)]*\);\s*\n\s*assertFsScopeLexical\(checked\.targetKey\);/.test(backend),
  'C3 writeText 在 checkedTarget 之后立刻判范围');
const editIdx = backend.indexOf('async editText(');
ok(editIdx > 0 && /assertFsScopeLexical\(checked\.targetKey\);/.test(backend.slice(editIdx, editIdx + 400)),
  'C4 editText 同上');
ok(/assertFsScope\(isAbsolute\(path\)/.test(backend), 'C5 lstat 收原始路径 ⇒ 用会 realpath 的 assertFsScope()');

const removeSrc = readFileSync(REMOVE_PLUGIN, 'utf8');
ok(/import \{ assertFsScope, fsScopeEnabled, fsScopeRoots \} from "\.\/fs-fence\.js";/.test(removeSrc),
  'C6 remove 插件 import 了判据（publish 目标那一处）');
const destIdx = removeSrc.indexOf('const destination = publishDestination(');
const writeIdx = removeSrc.indexOf('await writeFileAtomicBytes(destination');
const assertIdx = removeSrc.indexOf('await assertFsScope(destination);');
ok(destIdx > 0 && assertIdx > destIdx && writeIdx > assertIdx,
  'C7 publish 目标在**落盘之前**判范围（publishDestination → assertFsScope → writeFileAtomicBytes）');
ok(!/impose no path restriction/.test(removeSrc) && !/restrict no path/.test(removeSrc),
  'C8 三个工具的描述/系统提示不再声明"工具层不设限"');
ok(/every path is checked against this app's path scope|Every path is first checked|Both endpoints are checked|Source and destination are both checked/.test(removeSrc),
  'C9 工具描述已改写成新策略');

const pack = readFileSync(PACK_CORE, 'utf8');
ok(pack.includes('DSHM-FS-SCOPE-BEGIN') && pack.includes('DSHM-FS-SCOPE-END'),
  'C10 pack-core 按标记提取判据块');
ok(/fs-fence\.js'\)/.test(pack) || /'fs-fence\.js'/.test(pack), 'C11 提取源就是 fs-fence.js');
ok(/await refuseOutOfScopeSearch\(ctx, exec, "glob", input\.path\);/.test(pack), 'C12 pack-core 在 glob 注入范围判据');
ok(/await refuseOutOfScopeSearch\(ctx, exec, "grep", input\.path\);/.test(pack), 'C13 pack-core 在 grep 注入范围判据');
ok(/const oldGlobExec = /.test(pack) && /const oldGrepExec = /.test(pack), 'C14 两处注入都带锚点断言（漂移即 die）');

/* ── D. 若手头有核心树：树里那份必须与本仓这份逐字节一致 ───────────────── */
const coreWork = join(ROOT, 'dist', 'core', 'work');
let treeChecked = 0;
if (existsSync(coreWork)) {
  /* 先钉"**当前配方那一棵**（如果存在）必须有注入"—— 否则一个"树里没注入"的干净
   * 跳过会把 D 段变成永远绿的空转。 */
  let recipeVersion = '';
  try { recipeVersion = JSON.parse(readFileSync(join(ROOT, 'hostcore', 'core-recipe.json'), 'utf8')).coreVersion; } catch { recipeVersion = ''; }
  if (recipeVersion !== '') {
    const current = join(coreWork, `dsh-core-${recipeVersion}`, 'node_modules', '@deepseek-ai', 'dsh-tool-fs-search', 'lib', 'index.js');
    if (existsSync(current)) {
      const currentText = readFileSync(current, 'utf8');
      ok(currentText.includes(SCOPE_BEGIN), `D0 当前配方的核心树（dsh-core-${recipeVersion}）里**有**范围闸门注入`);
    }
  }
  for (const entry of readdirSync(coreWork)) {
    if (!entry.startsWith('dsh-core-')) continue;
    const file = join(coreWork, entry, 'node_modules', '@deepseek-ai', 'dsh-tool-fs-search', 'lib', 'index.js');
    if (!existsSync(file)) continue;
    const treeText = readFileSync(file, 'utf8');
    const from = treeText.indexOf(SCOPE_BEGIN);
    const to = treeText.indexOf(SCOPE_END);
    if (from < 0 || to < 0) continue;
    const embedded = treeText.slice(from, to + SCOPE_END.length);
    ok(embedded === blockA, `D1 ${entry}：树里嵌入的判据块与本仓逐字节一致`);
    ok(treeText.includes('async function refuseOutOfScopeSearch(ctx, exec, toolName, requestedPath)'),
      `D2 ${entry}：搜索根判据薄壳在位`);
    treeChecked += 1;
  }
}
if (treeChecked === 0) console.log('· 提示：dist/core/work 下没有已打包的核心树 ⇒ 跳过 D 段（需要它时先跑 pack-core）');

/* ── 结论 ──────────────────────────────────────────────────────────────── */
console.log(`\ncheck-fs-fence: ${passed} 项通过${failures.length ? `，${failures.length} 项失败` : ''}`
  + `（核心树 ${treeChecked} 棵）`);
if (failures.length > 0) {
  for (const label of failures) console.log(`  FAIL ${label}`);
  process.exit(1);
}
process.exit(0);
