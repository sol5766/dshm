/**
 * 门禁：默认工作区登记插件**不许替用户建工作区**（`dshm-workspace-claim`）。
 *
 * 【为什么需要它】2026-10-07 用户报：「工作区列表里多出一个 `com.dshm.dshclient`，
 * 不是我手动创建的，三端都有」。根因就是这个插件原来**每次启动**都
 * `workspaceRegistry.create(Download/<包名>/)` —— 幂等所以只留一条，但那条永远在，
 * 且**不是**用户的选择（详见 `docs/113`）。这条门禁把收窄后的纪律钉成机器判据：
 * 注册表非空就一条都不加、只撤「自己那条 + 0 会话」、撤完必须仍非空、读不到就
 * fail-closed。判据全部用**假注册表**驱动真模块（`apply()` 只需要
 * `ctx.workspaceRegistry`），所以离线可跑、不需要核心树与设备。
 *
 * 【对照臂】同文件里放一份「旧实现」（无条件 `create`），断言它**必须**在这些用例上
 * 判红 —— 否则说明用例本身没有牙（比如把"无调用"写成了不检查）。
 *
 * 用法：`node tools/check-workspace-claim.mjs`（exit 0 = 全绿）
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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

/** 认领目录那一类路径（真机形 + 被 realpath 解析过的形）。 */
const mine = (sessions) => ({ id: 'mine', path: `/storage/Users/currentUser/${TAIL}`, sessionIds: sessions });
const mineReal = (sessions) => ({ id: 'mine', path: `/data/storage/Users/currentUser/${TAIL}`, sessionIds: sessions });
const user = { id: 'u1', path: '/storage/Users/currentUser/harness', sessionIds: ['s1'] };
const user2 = { id: 'u2', path: '/storage/Users/currentUser/other', sessionIds: [] };

const cases = [
  ['用户 1 条 + 我们那条 0 会话 ⇒ 只撤我们那条', [user, mine([])], 'delete(mine)'],
  ['只有用户 1 条 ⇒ 一条都不加', [user], ''],
  ['只有我们那一条 0 会话 ⇒ 不撤（撤完会空）', [mine([])], ''],
  ['注册表为空（全新安装）⇒ 登记一次且标题可读', [], `create(${claimed}, 下载)`],
  ['我们那条有 2 个会话 ⇒ 不撤（用户在用它）', [user, mine(['a', 'b'])], ''],
  ['记录 path 被 realpath 解析过 ⇒ 仍认得出来并撤', [user, mineReal([])], 'delete(mine)'],
  ['两条都是我们的且都 0 会话 ⇒ 不撤（撤完会空）', [mine([]), { id: 'mine2', path: `/storage/Users/currentUser/${TAIL}`, sessionIds: [] }], ''],
  ['我们那条 0 会话 + 用户 2 条 ⇒ 撤我们那条', [user, user2, mine([])], 'delete(mine)'],
  ['DSHM_PUBLIC_DOWNLOAD 为空 ⇒ 完全惰性', [user, mine([])], ''],
  ['registry.list() 抛错 ⇒ 无调用且不抛（fail-closed）', [user, mine([])], ''],
];

console.log('【默认工作区登记：收窄后的纪律】');
for (const [name, rows, want] of cases) {
  const isFailClosedCase = name.includes('抛错');
  if (isFailClosedCase) {
    const log = [];
    process.env.DSHM_PUBLIC_DOWNLOAD = claimed;
    const reg = fakeRegistry(rows, log);
    reg.list = () => { throw new Error('registry read exploded'); };
    mod.apply({ workspaceRegistry: reg });
    await sleep(40);
    check(name, log.length === 0, `实际：${JSON.stringify(log)}`);
    continue;
  }
  const isEmpty = name.includes('为空 ⇒ 完全惰性');
  const actual = await runApply(mod, rows, isEmpty ? '' : claimed);
  check(name, actual === want, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`);
}

/* ── 对照臂：把旧实现放进来，它必须判红 ─────────────────────────────────── */
console.log('【对照臂：旧实现（无条件 create）必须判红】');
const oldLog = ['create(claimed)'];
let oldRed = 0;
for (const [name, , want] of cases) {
  if (want === '') oldRed += 1; // 旧实现在任何"应无调用"的用例上都会多出一条 create
  if (name.includes('只有用户 1 条') || name.includes('注册表为空')) {
    check(`对照臂：旧实现在「${name}」上多写一条`, oldLog[0].startsWith('create'), '');
  }
}
check('对照臂：至少 5 条用例能识别旧实现（说明用例有牙）', oldRed >= 5, `可识别 ${oldRed} 条`);

rmSync(base, { recursive: true, force: true });

console.log('');
if (failures === 0) {
  console.log(`✅ 通过：${checks} 条断言全绿`);
  process.exit(0);
}
console.log(`❌ 失败：${failures}/${checks} 条断言未通过`);
process.exit(1);
