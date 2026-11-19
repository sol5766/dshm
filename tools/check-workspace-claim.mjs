/**
 * 门禁：工作区登记插件**只准撤回，绝不准替用户建工作区**（`dshm-workspace-claim`）。
 *
 * 【为什么需要它】三轮同类事故都出在这个插件上：
 *   · 2026-10-07 用户报「工作区列表里多出一个 `com.dshm.dshclient`，不是我手动创建的，
 *     三端都有」⇒ 根因是它**每次启动**都 `workspaceRegistry.create(Download/<包名>/)`（`docs/113`）；
 *   · 2026-10-13 用户报「移动端全新安装自己建了一个下载的工作区目录，这个不应该」⇒
 *     上一轮的收窄（"只在注册表为空时登记一次"）在**全新安装**上必然命中：首启注册表
 *     就是空的 ⇒ 又替用户建了一条标题 `下载` 的工作区（`docs/150`）。
 * 结论：端侧**任何情况下都不该** `create`。本门禁把这条钉成机器判据：
 *   A. 全部用例里**一次 `create` 都不许出现**（直接 grep 调用记录）；
 *   B. 撤回的边界逐条判 —— 只撤"路径 = 认领目录"那条、撤完允许为空、读不到就 fail-closed；
 *   C. 对照臂：同文件内放一份**旧实现**（注册表空就 create、非空才撤）跑同一张用例表，
 *      它必须在 ≥5 条上判红 —— 否则说明用例本身没有牙（比如把"无调用"写成了不检查）。
 * 判据全部用**假注册表**驱动真模块（`apply()` 只需要 `ctx.workspaceRegistry`），
 * 所以离线可跑、不需要核心树与设备。
 *
 * 用法：`node tools/check-workspace-claim.mjs`（exit 0 = 全绿）
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MODULE_REL = 'hostcore/plugins/dshm-workspace-claim/lib/index.js';
// 真机注册表里存的是 POSIX 路径 ⇒ 这里的"末两段"必须写成正斜杠常量，
// 不能用 path.join（Windows 上会给你反斜杠，拼出的假记录就不是真机形态了）。
const TAIL = 'Download/com.dshm.dshclient';

let failures = 0;
let checks = 0;

function check(name, ok, detail) {
  checks += 1;
  if (ok) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

/** 假注册表：记录调用，不落盘。 */
function fakeRegistry(rows, log) {
  return {
    list: () => rows,
    create: (p, t) => {
      log.push(`create(${p}, ${t})`);
      return Promise.resolve({ id: 'created-id' });
    },
    delete: (id) => {
      log.push(`delete(${id})`);
      return Promise.resolve(true);
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 当前用例的调用记录（factories 里的 setTitle 也往这里写）。 */
let activeLog = [];

/** 跑一次 `apply()` 并返回它的调用记录。 */
async function runApply(mod, rows, envDir) {
  const log = [];
  process.env.DSHM_PUBLIC_DOWNLOAD = envDir;
  mod.apply({ workspaceRegistry: fakeRegistry(rows, log) });
  await sleep(40);
  return log.join(' | ');
}

const base = mkdtempSync(join(tmpdir(), 'dshm-claim-gate-'));
const claimed = join(base, 'Download', 'com.dshm.dshclient');
mkdirSync(claimed, { recursive: true });
const mod = await import(pathToFileURL(resolve(MODULE_REL)).href);

/** 认领目录那一类路径（真机形 + 被 realpath 解析过的形 + 第二条同路径记录）。 */
const mine = (sessions) => ({ id: 'mine', path: `/storage/Users/currentUser/${TAIL}`, sessionIds: sessions });
const mineReal = (sessions) => ({ id: 'mine', path: `/data/storage/Users/currentUser/${TAIL}`, sessionIds: sessions });
const mineB = (sessions) => ({ id: 'mine2', path: `/storage/Users/currentUser/${TAIL}`, sessionIds: sessions });
/** 官方 initializeDefault 自动建的那条：标题 = 目录 basename（包名）；只应改名、不应撤。 */
const mineAuto = (sessions) => ({
  id: 'mine',
  path: `/storage/Users/currentUser/${TAIL}`,
  sessionIds: sessions,
  title: 'com.dshm.dshclient',
  setTitle: (t) => {
    activeLog.push(`retitle(mine:${t})`);
    return Promise.resolve(true);
  },
});
const user = { id: 'u1', path: '/storage/Users/currentUser/harness', sessionIds: ['s1'] };
const user2 = { id: 'u2', path: '/storage/Users/currentUser/other', sessionIds: [] };

const cases = [
  ['用户 1 条 + 我们那条 0 会话 ⇒ 只撤我们那条', [user, mine([])], 'delete(mine)'],
  ['只有用户 1 条 ⇒ 一条都不动', [user], ''],
  ['只有我们那一条（0 会话）⇒ 照撤（撤完为空是正常态）', [mine([])], 'delete(mine)'],
  ['自动生成的那条（标题=包名）⇒ 只把标题改成人话，不撤', [mineAuto([])], 'retitle(mine:应用专属目录)'],
  ['只有我们那一条且名下有会话（客户端首启建的空壳）⇒ 照撤', [mine(['husk'])], 'delete(mine)'],
  // 2026-10-13 的关键用例：全新安装首启 = 注册表为空 ⇒ 一条都不许建。
  ['注册表为空（全新安装）⇒ 一条都不建', [], ''],
  ['我们那条有 2 个会话 + 用户 1 条 ⇒ 仍然撤我们那条', [user, mine(['a', 'b'])], 'delete(mine)'],
  ['记录 path 被 realpath 解析过、且名下有会话 ⇒ 仍认得出来并撤', [user, mineReal(['husk'])], 'delete(mine)'],
  ['我们那条 0 会话 + 用户 2 条 ⇒ 只撤我们那条', [user, user2, mine([])], 'delete(mine)'],
  ['两条都是我们的 ⇒ 两条都撤', [mine([]), mineB([])], 'delete(mine) | delete(mine2)'],
  ['两条都是我们的、其中一条名下有会话 ⇒ 仍然两条都撤', [mine(['husk']), mineB([])], 'delete(mine) | delete(mine2)'],
  ['DSHM_PUBLIC_DOWNLOAD 为空 ⇒ 完全惰性', [user, mine([])], ''],
  ['registry.list() 抛错 ⇒ 无调用且不抛（fail-closed）', [user, mine([])], ''],
];

console.log('【工作区登记撤回：只撤不建的纪律】');
const allLogs = [];
for (const [name, rows, want] of cases) {
  const isFailClosedCase = name.includes('抛错');
  if (isFailClosedCase) {
    const log = [];
    process.env.DSHM_PUBLIC_DOWNLOAD = claimed;
    const reg = fakeRegistry(rows, log);
    reg.list = () => { throw new Error('registry read exploded'); };
    mod.apply({ workspaceRegistry: reg });
    await sleep(40);
    allLogs.push(...log);
    check(name, log.length === 0, `实际：${JSON.stringify(log)}`);
    continue;
  }
  const isEmpty = name.includes('为空 ⇒ 完全惰性');
  const log = [];
  activeLog = log;
  process.env.DSHM_PUBLIC_DOWNLOAD = isEmpty ? '' : claimed;
  mod.apply({ workspaceRegistry: fakeRegistry(rows, log) });
  await sleep(40);
  allLogs.push(...log);
  const actual = log.join(' | ');
  check(name, actual === want, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`);
}

/* ── B 段：升级后工作区成员的非破坏性补回 ─────────────────────────────── */
console.log('【B：从会话 header 补回缺失的工作区成员】');
{
  const harness = join(base, 'harness');
  mkdirSync(harness, { recursive: true });
  const canonicalHarness = realpathSync(harness);
  const other = join(base, 'other');
  mkdirSync(other, { recursive: true });

  const runRepair = async (sessionIds, sessions, workspacePath = canonicalHarness) => {
    const attached = [];
    const deleted = [];
    const created = [];
    const workspace = {
      id: 'u1',
      path: workspacePath,
      sessionIds: [...sessionIds],
      attachSession: (id) => {
        attached.push(id);
        return Promise.resolve(true);
      },
    };
    const registry = {
      list: () => [workspace],
      create: (p, t) => {
        created.push(`create(${p}, ${t})`);
        return Promise.resolve({ id: 'created' });
      },
      delete: (id) => {
        deleted.push(id);
        return Promise.resolve(true);
      },
    };
    const persistence = {
      list: () => Promise.resolve(sessions),
    };
    process.env.DSHM_PUBLIC_DOWNLOAD = claimed;
    mod.apply({ workspaceRegistry: registry, sessionPersistence: persistence });
    await sleep(80);
    return { attached, deleted, created };
  };

  const recovered = await runRepair([], [
    { header: { id: 's-recover', cwd: canonicalHarness } },
  ]);
  check('现有工作区缺成员 ⇒ 从同路径会话 header 补回', recovered.attached.join(',') === 's-recover',
    `实际 attach=${JSON.stringify(recovered.attached)}`);
  check('补回过程不删除工作区、不新建工作区',
    recovered.deleted.length === 0 && recovered.created.length === 0,
    `delete=${JSON.stringify(recovered.deleted)} create=${JSON.stringify(recovered.created)}`);

  const already = await runRepair(['s-already'], [
    { header: { id: 's-already', cwd: canonicalHarness } },
  ]);
  check('已经计入的会话不重复 attach', already.attached.length === 0,
    `实际 attach=${JSON.stringify(already.attached)}`);

  const mismatch = await runRepair([], [
    { header: { id: 's-other', cwd: other } },
  ]);
  check('不同路径的孤儿会话不塞进现有工作区', mismatch.attached.length === 0,
    `实际 attach=${JSON.stringify(mismatch.attached)}`);
  check('没有匹配工作区的孤儿会话也不新建工作区', mismatch.created.length === 0,
    `实际 create=${JSON.stringify(mismatch.created)}`);

  const unavailable = await runRepair([], [
    { header: { id: 's-missing', cwd: join(base, 'does-not-exist') } },
  ]);
  check('cwd 当前不可解析 ⇒ 跳过而不是猜测', unavailable.attached.length === 0,
    `实际 attach=${JSON.stringify(unavailable.attached)}`);
}

/* ── A 段：全部用例里一次 create 都不许出现 ─────────────────────────────── */
console.log('【A：真模块在任何用例里都不许 create】');
const createCalls = allLogs.filter((line) => line.startsWith('create('));
check('全部用例的调用记录里 0 次 create', createCalls.length === 0,
  `实际 ${createCalls.length} 次：${JSON.stringify(createCalls)}`);

/* ── C 段：对照臂（旧实现必须判红） ─────────────────────────────────────── */
console.log('【C：对照臂 —— 旧实现（注册表空就 create）必须判红】');
/** 2026-10-07 那一版的形状：注册表空 ⇒ create；非空且自己那条不是最后一条 ⇒ 撤。 */
function legacyApply(rows, target) {
  const log = [];
  const reg = fakeRegistry(rows, log);
  const run = (async () => {
    const list = reg.list();
    if (!Array.isArray(list)) return;
    const mine = list.filter((w) => w && String(w.path || '').replace(/[\\/]+$/, '').endsWith('/' + TAIL));
    if (list.length > 0) {
      if (mine.length === 0 || mine.length >= list.length) return;
      for (const w of mine) await reg.delete(w.id);
      return;
    }
    await reg.create(target, '下载');
  })();
  return { log, run };
}

let oldRed = 0;
const oldMisses = [];
for (const [name, rows, want] of cases) {
  const { log, run } = legacyApply(rows, claimed);
  if (name.includes('抛错')) continue; // 旧实现没有 fail-closed 分支，这条不参与对照
  await run;
  const oldActual = log.join(' | ');
  if (oldActual !== want) {
    oldRed += 1;
    oldMisses.push(name);
  }
}
check('对照臂：旧实现在 ≥5 条用例上判红（说明用例有牙）', oldRed >= 5, `判红 ${oldRed} 条`);
for (const name of oldMisses) console.log(`     旧实现过不掉：${name}`);

rmSync(base, { recursive: true, force: true });

console.log('');
if (failures === 0) {
  console.log(`✅ 通过：${checks} 条断言全绿`);
  process.exit(0);
}
console.log(`❌ 失败：${failures}/${checks} 条断言未通过`);
process.exit(1);
