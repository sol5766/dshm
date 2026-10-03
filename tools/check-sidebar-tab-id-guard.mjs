/*
 * 门禁：侧栏页签 id 守卫（N4）
 *
 * 背景：`SidebarRightTabRegistry.register()` 的取号不是原子的 ——
 *
 *     const dispose = this.ctx.effect(() => {
 *       this.ids.add(id);                  // ← 取号
 *       const slot = this.enter(kind, entry);
 *       this.refresh();                    // ← refresh → notifySubscribers()，订阅者可抛
 *       return () => { this.ids.delete(id); … };   // ← 抛错时这个清理函数根本不存在
 *     }, …);
 *
 * cordis 的 `effect()`（`@deepseek-ai/cordis/lib/index.js:1249-1263`）在 setup 抛错
 * 时只清理"已经收集到"的 disposables；而那条 `return () => {…}` 是 effect **体**的
 * 返回值 —— 体一抛错就没被收集，于是永远不会执行。结果：`ids` 里留一条永久占位，
 * 谁都释放不掉。这正是 N4 的成因 —— `dsh-better-sidebar` 每次 `sync()` 都用同一个
 * id 重试接管 `files` 页签，恒抛 `already registered`，页签立不起来、文件树落空态，
 * 只有刷新整个页面才恢复。
 *
 * `tools/pack-core.mjs` 的 `patchSidebarTabIdLeak()` 打了 `DSHM_TAB_ID_GUARD`，
 * 把"取号 + 入座 + 通知"做成原子（异常路径按原样退回）。本门禁把**随包发布的源码
 * 原文**抽出来，放进一个忠实模拟 cordis 抛错语义的壳里跑，要求：
 *   · 不补丁 → 必须复现 id 占死 + 重试失败（证明这个门禁真的在测东西）
 *   · 打补丁 → 异常当刻 id / kind 槽都已释放，重试成功
 *   · 成功路径 → 语义零变化（占位与注册计数都不许变）
 *
 * 退出码：0 通过 / 1 有真实问题 / 2 前置条件缺失（未跑过 pack-core，无核心树）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'dist', 'core', 'work', 'dsh-core-0.2.0-rc.2', 'node_modules',
  '@deepseek-ai', 'dsh-client-ui-sidebar-right', 'lib', 'client.js');

if (!existsSync(SRC)) {
  console.log(`前置条件缺失：${SRC} 不存在。`);
  console.log('先跑 `node tools/pack-core.mjs --skip-install` 生成核心工作树，再跑本门禁。');
  process.exit(2);
}

const full = readFileSync(SRC, 'utf8');

if (!full.includes('DSHM_TAB_ID_GUARD')) {
  console.error('FAIL  随包发布的 sidebar-right 里没有 DSHM_TAB_ID_GUARD 守卫。');
  console.error('      pack-core 的 patchSidebarTabIdLeak() 没跑，或上游实现已变而补丁静默失效。');
  process.exit(1);
}

const from = full.indexOf('const RANKS = {');
const docMark = full.indexOf('* Observe low-frequency registry changes.', from);
const to = docMark < 0 ? -1 : full.lastIndexOf('/**', docMark);
if (from < 0 || to <= from) {
  console.error('FAIL  抽不出注册表源码段（RANKS…subscribe 之间）。上游结构已变，门禁需要同步。');
  process.exit(1);
}

const slice = full.slice(from, to) + '\n\t\t};\n';

// 反向还原成上游原样，作为对照组 —— 否则"测试通过"可能只是测试没在测东西
const PATCHED_BODY = `\t\t\t\tconst dispose = this.ctx.effect(() => {
\t\t\t\t\t/* DSHM_TAB_ID_GUARD：取号与入座必须原子，否则异常路径会把 id 永久占死 */
\t\t\t\t\tthis.ids.add(id);
\t\t\t\t\tlet slot;
\t\t\t\t\ttry {
\t\t\t\t\t\tslot = this.enter(kind, entry);
\t\t\t\t\t\tthis.refresh();
\t\t\t\t\t} catch (reason) {
\t\t\t\t\t\tthis.ids.delete(id);
\t\t\t\t\t\tif (slot !== void 0) this.leave(kind, slot, entry);
\t\t\t\t\t\tthrow reason;
\t\t\t\t\t}
\t\t\t\t\treturn () => {`;
const ORIGINAL_BODY = `\t\t\t\tconst dispose = this.ctx.effect(() => {
\t\t\t\t\tthis.ids.add(id);
\t\t\t\t\tconst slot = this.enter(kind, entry);
\t\t\t\t\tthis.refresh();
\t\t\t\t\treturn () => {`;
if (!slice.includes(PATCHED_BODY)) {
  console.error('FAIL  守卫片段与门禁里记录的原文不一致：补丁被改动过，或上游格式变了。');
  process.exit(1);
}
const controlSlice = slice.replace(PATCHED_BODY, ORIGINAL_BODY);

function buildClass(registrySrc) {
  const Cls = new Function(
    'const import_posix = { default: () => () => false };\n'
    + registrySrc
    + '\nreturn SidebarRightTabRegistry;\n')();
  // refresh() 位于切片之外（真实实现在 subscribe 之后），按源码语义补上
  Cls.prototype.refresh = function refresh() {
    if (this.throwOnRefresh === true) {
      throw new Error('refresh failed（模拟 notifySubscribers 里某个订阅者抛错）');
    }
    this.cached = this.active().map((entry) => entry.definition);
  };
  return Cls;
}

// 忠实模拟 cordis effect()：setup 抛错时只清"已收集到"的清理项
function makeCtx() {
  return {
    effect(execute) {
      const disposables = [];
      try {
        const cleanup = execute();
        if (typeof cleanup === 'function') disposables.push(cleanup);
      } catch (reason) {
        for (const dispose of disposables.splice(0).reverse()) dispose();
        throw reason;
      }
      return () => {
        for (const dispose of disposables.splice(0).reverse()) dispose();
      };
    },
  };
}

const ID = 'dsh-better-sidebar:files';
const KIND = 'files';
const DEF = { id: ID, kind: KIND, priority: 'extension' };

function scenario(registrySrc, { throwOnRefresh }) {
  const reg = new (buildClass(registrySrc))(makeCtx());
  reg.throwOnRefresh = throwOnRefresh;
  let firstError = null;
  try {
    reg.register(DEF);
  } catch (reason) {
    firstError = reason?.message ?? String(reason);
  }
  // 失败之后、重试之前的现场：守卫该不该生效的直接读数
  const idsAfterFailure = reg.ids.has(ID);
  const kindsAfterFailure = reg.kinds.has(KIND);
  const registrationsAfterFailure = reg.registrations;
  // 随后同一个 id 再注册一次 —— dsh-better-sidebar 每次 sync() 都这么干
  reg.throwOnRefresh = false;
  let secondError = null;
  let secondRegistered = false;
  try {
    secondRegistered = typeof reg.register(DEF) === 'function';
  } catch (reason) {
    secondError = reason?.message ?? String(reason);
  }
  return { firstError, secondError, secondRegistered, idsAfterFailure, kindsAfterFailure, registrationsAfterFailure };
}

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass, detail });

const raceBefore = scenario(controlSlice, { throwOnRefresh: true });
const raceAfter = scenario(slice, { throwOnRefresh: true });
const okBefore = scenario(controlSlice, { throwOnRefresh: false });
const okAfter = scenario(slice, { throwOnRefresh: false });

check('对照组真的复现了 id 占死（否则本门禁没在测东西）',
  raceBefore.idsAfterFailure === true && raceBefore.kindsAfterFailure === true,
  `ids=${raceBefore.idsAfterFailure} kinds=${raceBefore.kindsAfterFailure}`);
check('对照组重试必然再抛 already registered',
  typeof raceBefore.secondError === 'string' && raceBefore.secondError.includes('is already registered'),
  `secondError=${raceBefore.secondError}`);

check('守卫：异常当刻 id 已释放',
  raceAfter.idsAfterFailure === false, `失败后 ids.has=${raceAfter.idsAfterFailure}`);
check('守卫：异常当刻 kind 槽已释放',
  raceAfter.kindsAfterFailure === false, `失败后 kinds.has=${raceAfter.kindsAfterFailure}`);
check('守卫：重试成功（不再 already registered）',
  raceAfter.secondError === null && raceAfter.secondRegistered === true,
  `secondError=${raceAfter.secondError} registered=${raceAfter.secondRegistered}`);
check('守卫：首次异常仍如实上抛（不吞异常）',
  typeof raceAfter.firstError === 'string' && raceAfter.firstError.includes('refresh failed'),
  `firstError=${raceAfter.firstError}`);

check('成功路径零变化：id 占位一致',
  okBefore.idsAfterFailure === okAfter.idsAfterFailure,
  `before=${okBefore.idsAfterFailure} after=${okAfter.idsAfterFailure}`);
check('成功路径零变化：重注册都抛 already registered',
  typeof okBefore.secondError === 'string' && okBefore.secondError.includes('is already registered')
  && typeof okAfter.secondError === 'string' && okAfter.secondError.includes('is already registered'),
  `before=${okBefore.secondError} / after=${okAfter.secondError}`);
check('成功路径零变化：注册计数一致',
  okBefore.registrationsAfterFailure === okAfter.registrationsAfterFailure,
  `before=${okBefore.registrationsAfterFailure} after=${okAfter.registrationsAfterFailure}`);

let failed = 0;
for (const c of checks) {
  if (!c.pass) failed += 1;
  console.log(`${c.pass ? 'ok  ' : 'FAIL'}：${c.name}（${c.detail}）`);
}
console.log(`\nRESULT: ${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
