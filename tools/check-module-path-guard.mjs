#!/usr/bin/env node
/**
 * 门禁：收窄 Node 全局模块搜索路径（LOOP-GAP 除根，2026-10-19；见 docs/199 §8）
 *
 * 【为什么需要这条门禁】
 * 这一层动的是**模块解析的输入**，是本仓少见的"会影响 require 找哪里"的改动，
 * 所以它必须被钉死在三件事上：
 *   ① 只摘 `USER_PATH_PREFIX`（`/storage/Users/currentUser`）那一类项；
 *      **应用沙箱内的路径必须原样保留**（摘多了 = 把沙箱依赖也弄丢，插件全挂）；
 *   ② 收窄手段是"同步窗口内换 env → `Module._initPaths()` → 立刻逐字还原"，
 *      所以 **`HOME` / `NODE_PATH` 必须还原**（不还原 = 进程余下生命周期都在错误 env 里）；
 *   ③ `DSHM_GLOBAL_PATHS=keep` 必须真能关掉，异常必须真能直通。
 *
 * 另有一条"**别踩的坑**"被本门禁钉住：`Module.globalPaths` 只是 `modulePaths` 的浅拷贝，
 * 直接 `splice()`/赋值**对解析无效** → 门禁断言实现走的是 `_initPaths()` 这条路，
 * 且 fake module 的"活路径表"确实变了（不是只改了自省副本）。
 *
 * 【判据】
 *   A 纯逻辑（注入 fake Module + fake env；不碰真实 Module）
 *     A1 filterPaths 只摘用户项 / A2 filterNodePath 分段收窄 / A3 安装后活路径表真的变窄
 *     + env 逐字还原 + 诊断行；A4 keep 开关；A5 异常直通；A6 幂等；
 *     A7 不改 require 语义（_resolveFilename/_resolveLookupPaths/_pathCache 原对象）；
 *     A8 真 Node 运行时具备收窄杠杆（`_initPaths` 存在、`globalPaths` 是数组，只读不写）
 *   B 接线（真实文件）
 *     B1 main.js require + 调用；B2 安装点早于核心树 require、且早于 fs 探测缓存；
 *     B3 诊断行逐字存在；B4 resfile 两份清单都带上它；B5 已入 gates.yml；
 *     B6 docs/199 §8 在（讲清"缓存治第 2 次、收窄治第 1 次"与回退口径）
 *   C 变异对照臂（4 个，必须全部判红）：不删用户项 / 删掉沙箱项 / keep 被忽略 / HOME 不还原
 *
 * 用法：
 *   node tools/check-module-path-guard.mjs
 *   node tools/check-module-path-guard.mjs --self-test   # 同一套（变异臂默认就跑）
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, delimiter as pathDelimiter } from 'node:path';

const ROOT = process.cwd();
const MODULE_FILE = join(ROOT, 'hostcore', 'app', 'module-path-guard.cjs');
const MAIN_FILE = join(ROOT, 'hostcore', 'app', 'main.js');
const FS_CACHE_FILE = join(ROOT, 'hostcore', 'app', 'fs-probe-cache.cjs');
const PLACE_FILE = join(ROOT, 'tools', 'place-host-app.mjs');
const RESFILE_FILE = join(ROOT, 'tools', 'assert-resfile-sync.mjs');
const GATES_FILE = join(ROOT, '.github', 'workflows', 'gates.yml');
const DOC = join(ROOT, 'docs', '199-Host同步探测缓存（LOOP-GAP根因与修复）.md');

const requireCjs = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) {
    pass += 1;
    console.log('  PASS  ' + msg);
  } else {
    fail += 1;
    failures.push(msg);
    console.log('  FAIL  ' + msg);
  }
}

function fmt(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}
function expectJson(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}（实测 ${a}，应 ${b}）`);
}
function expectEq(actual, expected, msg) {
  if (!Object.is(actual, expected)) throw new Error(`${msg}（实测 ${fmt(actual)}，应 ${fmt(expected)}）`);
}

function readText(file) {
  return readFileSync(file, 'utf8');
}

/* ───────────────────────────── 夹具 ───────────────────────────── */

const USER = '/storage/Users/currentUser';
const SANDBOX_NODE_MODULES = '/data/storage/el2/base/haps/entry/files/sandbox_node_modules';
const PREFIX_LIB = '/system/lib/node';

/**
 * 假 Module：**模仿 Node 24 的真实形状** —— `_initPaths()` 用 env 重算"活路径表"，
 * 而 `globalPaths` 只是它的浅拷贝（这正是真机上的语义，也是本层必须走 `_initPaths` 的原因）。
 */
function makeFakeModule(options) {
  const opts = options || {};
  const fake = {
    _initPathsCalls: 0,
    __env: opts.env,
    __delimiter: opts.delimiter || ':',
    __throwOnInit: false,
    // 这三个是"不许被改"的语义面（A7 用它做身份断言）
    _resolveFilename: function fakeResolveFilename() {},
    _resolveLookupPaths: function fakeResolveLookupPaths() {},
    _pathCache: new Map([['sentinel', 'sentinel']]),
    _initPaths() {
      this._initPathsCalls += 1;
      if (this.__throwOnInit) throw new Error('init boom');
      const env = this.__env || {};
      const home = env.HOME !== undefined && env.HOME !== '' ? env.HOME
        : (env.USERPROFILE !== undefined && env.USERPROFILE !== '' ? env.USERPROFILE : '');
      const nodePath = typeof env.NODE_PATH === 'string' ? env.NODE_PATH : '';
      // 照抄 Node `_initPaths()` 的**顺序**：NODE_PATH 各项在前，然后 $HOME/.node_modules、
      // $HOME/.node_libraries，最后 <prefix>/lib/node（顺序会影响断言，别随手改）。
      const paths = [];
      if (nodePath.length > 0) {
        for (const entry of nodePath.split(this.__delimiter)) {
          if (entry.length > 0) paths.push(entry);
        }
      }
      if (home.length > 0) {
        paths.push(home + '/.node_modules');
        paths.push(home + '/.node_libraries');
      }
      paths.push(PREFIX_LIB);
      this.__live = paths.slice();
      this.globalPaths = paths.slice();
    },
  };
  return fake;
}

function makeEnv(home, nodePath, extra) {
  const env = { HOME: home };
  if (nodePath !== undefined) env.NODE_PATH = nodePath;
  return Object.assign(env, extra || {});
}

function captureLog() {
  const lines = [];
  const log = (line) => lines.push(String(line));
  log.lines = lines;
  return log;
}

function runCase(name, mod, fn) {
  try {
    fn(mod);
    ok(true, name);
  } catch (e) {
    ok(false, `${name} —— ${e && e.message}`);
  }
}

/* ─────────────────── A. 纯逻辑（注入 fake Module / fake env） ─────────────────── */

function caseFilterPaths(mod) {
  const mixed = [
    `${USER}/.node_modules`,
    `${USER}/.node_libraries`,
    SANDBOX_NODE_MODULES,
    PREFIX_LIB,
    '/data/storage/node_modules',
  ];
  const { kept, removed } = mod.filterPaths(mixed);
  expectJson(removed, [`${USER}/.node_modules`, `${USER}/.node_libraries`], '只摘用户家目录那两项');
  expectJson(kept, [SANDBOX_NODE_MODULES, PREFIX_LIB, '/data/storage/node_modules'], '沙箱 / 前缀 / 其它路径原样保留');
  // 归一化 & 边界
  expectEq(mod.isUserHomePath(USER), true, '正好等于前缀 ⇒ 摘');
  expectEq(mod.isUserHomePath(`${USER}/.node_modules`), true, '前缀 + /… ⇒ 摘');
  expectEq(mod.isUserHomePath(USER.replace(/\//g, '\\') + '\\.node_modules'), true, '反斜杠形态归一化后 ⇒ 摘');
  expectEq(mod.isUserHomePath('/storage/Users/currentUserX'), false, '前缀的"同名前缀"不许误伤');
  expectEq(mod.isUserHomePath('/data/storage/el2/base/haps/entry/files/node_modules'), false, '沙箱路径 ⇒ 保留');
  expectEq(mod.isUserHomePath(''), false, '空串 ⇒ 保留（不判）');
  expectEq(mod.isUserHomePath(7), false, '非字符串 ⇒ 保留（不判）');
  expectJson(mod.filterPaths(null), { kept: [], removed: [] }, '非数组入参 ⇒ 空结果，不抛');
}

function caseFilterNodePath(mod) {
  const raw = `${USER}/.node_modules:${SANDBOX_NODE_MODULES}:/data/storage/node_modules`;
  const result = mod.filterNodePath(raw, ':');
  expectJson(result.removed, [`${USER}/.node_modules`], 'NODE_PATH 只摘用户项');
  expectJson(result.kept, [SANDBOX_NODE_MODULES, '/data/storage/node_modules'], 'NODE_PATH 沙箱项保留');
  expectEq(result.next, `${SANDBOX_NODE_MODULES}:/data/storage/node_modules`, '写回串是保留项按原分隔符拼');
  const allUser = mod.filterNodePath(`${USER}/.node_modules:${USER}/.node_libraries`, ':');
  expectEq(allUser.next, '', '全被摘掉时写回空串（Node 视为没有 NODE_PATH 项）');
  expectJson(mod.splitNodePath('', ':'), [], '空串 ⇒ 空数组');
  expectJson(mod.splitNodePath(`a::b`, ':'), ['a', 'b'], '空段被丢掉（与 Node 的 filter(Boolean) 同口径）');
  const platform = mod.filterNodePath(`a${pathDelimiter}b`);
  expectJson(platform.kept, ['a', 'b'], '不传分隔符时按本平台 path.delimiter 切');
}

function caseInstallNarrowsLivePaths(mod) {
  const env = makeEnv(USER, `${USER}/.npm-global/node_modules:${SANDBOX_NODE_MODULES}`);
  const fake = makeFakeModule({ env, delimiter: ':' });
  fake._initPaths(); // 模拟 Node 启动时初始化：此刻全局表里还有三条慢路径
  expectJson(fake.globalPaths, [
    `${USER}/.npm-global/node_modules`,
    SANDBOX_NODE_MODULES,
    `${USER}/.node_modules`,
    `${USER}/.node_libraries`,
    PREFIX_LIB,
  ], '装之前：全局表里有用户家目录项（这就是 192s 的来源）');
  const log = captureLog();
  const state = mod.installModulePathGuard({ module: fake, env, log, pathDelimiter: ':' });
  expectEq(state.applied, true, '收窄已生效');
  expectEq(state.keep, false, '默认不是 keep');
  // 活路径表（= 解析真正用的那份）必须真的变窄
  expectJson(fake.__live, [SANDBOX_NODE_MODULES, PREFIX_LIB], '活路径表只剩沙箱项 + 前缀目录');
  expectJson(fake.globalPaths, [SANDBOX_NODE_MODULES, PREFIX_LIB], '自省副本同步收窄（工具面读数一致）');
  expectEq(fake._initPathsCalls, 2, '_initPaths 共两次：启动一次 + 本层重算一次');
  // 计数与诊断行
  expectEq(state.removedGlobalPaths, 3, '移除 3 项：$HOME/.node_modules、$HOME/.node_libraries、NODE_PATH 里的用户项');
  expectEq(state.removedNodePath, 1, 'NODE_PATH 移除 1 项');
  expectEq(state.kept, 2, '保留 2 项');
  const narrowLine = log.lines.find((line) => line.startsWith('[dshm-host] 全局模块路径已收窄'));
  expect(Boolean(narrowLine), '诊断行存在');
  expect(narrowLine.startsWith('[dshm-host] 全局模块路径已收窄（移除 3 项 /storage/Users/currentUser'), '诊断行文案与计数正确');
  // env 必须逐字还原（同步窗口）
  expectEq(env.HOME, USER, 'HOME 逐字还原');
  expectEq('USERPROFILE' in env, false, '本来没有的 USERPROFILE 不许凭空多出来');
  expectEq(env.NODE_PATH, SANDBOX_NODE_MODULES, 'NODE_PATH 已收窄（沙箱项保留）');
}

function caseKeepSwitch(mod) {
  const env = makeEnv(USER, `${USER}/.npm-global/node_modules:${SANDBOX_NODE_MODULES}`, { DSHM_GLOBAL_PATHS: 'keep' });
  const fake = makeFakeModule({ env, delimiter: ':' });
  fake._initPaths();
  const log = captureLog();
  const state = mod.installModulePathGuard({ module: fake, env, log, pathDelimiter: ':' });
  expectEq(state.keep, true, 'keep 模式被识别');
  expectEq(state.applied, false, 'keep 模式不做任何收窄');
  expectEq(fake._initPathsCalls, 1, 'keep 模式不许重算路径表');
  expectJson(fake.globalPaths, [
    `${USER}/.npm-global/node_modules`,
    SANDBOX_NODE_MODULES,
    `${USER}/.node_modules`,
    `${USER}/.node_libraries`,
    PREFIX_LIB,
  ], 'keep 模式全局表原样');
  expectEq(env.NODE_PATH, `${USER}/.npm-global/node_modules:${SANDBOX_NODE_MODULES}`, 'keep 模式 NODE_PATH 原样');
  expectEq(env.HOME, USER, 'keep 模式 HOME 原样');
  expect(log.lines.some((line) => line.includes('保持原样')), 'keep 模式有诊断行');
}

function caseExceptionPassthrough(mod) {
  const env = makeEnv(USER, `${USER}/.node_modules:${SANDBOX_NODE_MODULES}`);
  const fake = makeFakeModule({ env, delimiter: ':' });
  fake._initPaths();
  const beforeGlobals = fake.globalPaths.slice();
  fake.__throwOnInit = true;
  const log = captureLog();
  let threw = null;
  let state = null;
  try {
    state = mod.installModulePathGuard({ module: fake, env, log, pathDelimiter: ':' });
  } catch (e) {
    threw = e;
  }
  expectEq(threw, null, '异常必须直通（安装不许抛）');
  expectEq(state.applied, false, '失败如实报 applied=false');
  expect(String(state.reason).includes('收窄失败'), 'reason 写明失败原因');
  expectJson(fake.globalPaths, beforeGlobals, '失败时不改写全局表');
  expectEq(env.HOME, USER, '失败路径也必须把 HOME 还原');
  expectEq(env.NODE_PATH, `${USER}/.node_modules:${SANDBOX_NODE_MODULES}`, '失败路径也必须把 NODE_PATH 还原');
  expect(log.lines.some((line) => line.includes('收窄失败（不阻塞）')), '失败有诊断行');
}

function caseIdempotent(mod) {
  const env = makeEnv(USER, `${USER}/.node_modules`);
  const fake = makeFakeModule({ env, delimiter: ':' });
  fake._initPaths();
  const first = mod.installModulePathGuard({ module: fake, env, pathDelimiter: ':' });
  const second = mod.installModulePathGuard({ module: fake, env, pathDelimiter: ':' });
  expectEq(first === second, true, '重复安装返回同一份结果（幂等）');
  expectEq(fake._initPathsCalls, 2, '重复安装不会再次重算路径表');
}

function caseNoSemanticChange(mod) {
  const env = makeEnv(USER, `${USER}/.node_modules`);
  const fake = makeFakeModule({ env, delimiter: ':' });
  fake._initPaths();
  const resolveFilename = fake._resolveFilename;
  const resolveLookupPaths = fake._resolveLookupPaths;
  const pathCache = fake._pathCache;
  mod.installModulePathGuard({ module: fake, env, pathDelimiter: ':' });
  expectEq(fake._resolveFilename, resolveFilename, '不改 _resolveFilename');
  expectEq(fake._resolveLookupPaths, resolveLookupPaths, '不改 _resolveLookupPaths');
  expectEq(fake._pathCache, pathCache, '_pathCache 原对象（不清缓存）');
  expectEq(Array.isArray(fake.globalPaths), true, 'globalPaths 仍是数组');
}

function caseRealRuntimeLever() {
  // 只读核对：真机上我们依赖的杠杆确实存在（不写、不改）。
  const realModule = requireCjs('node:module');
  expectEq(typeof realModule._initPaths, 'function', 'Node 运行时提供 Module._initPaths（收窄活路径表的唯一杠杆）');
  expectEq(Array.isArray(realModule.globalPaths), true, 'Module.globalPaths 是数组（自省面）');
  const before = realModule.globalPaths.slice();
  expectEq(JSON.stringify(realModule.globalPaths), JSON.stringify(before), '（只读核对，不改真实全局表）');
}

/* ───────────────────────── B. 接线（真实文件） ───────────────────────── */

function caseWiring(mod) {
  const main = readText(MAIN_FILE);
  const requireIdx = main.indexOf("require('./module-path-guard.cjs')");
  ok(requireIdx > 0, 'B1 main.js 真的 require 了 ./module-path-guard.cjs');
  const installIdx = main.indexOf('installModulePathGuard({ log: diag })');
  ok(installIdx > 0, 'B1 main.js 真的调用了 installModulePathGuard({ log: diag })');
  ok(installIdx > requireIdx, 'B1 调用点在 require 之后');

  const coreDirIdx = main.indexOf('const CORE_DIR = process.env.DSHM_CORE_DIR || currentCoreDir();');
  ok(coreDirIdx > 0, 'B2 找到核心树锚点');
  ok(installIdx < coreDirIdx, 'B2 安装点早于核心树目录解析（CORE_DIR 之前）');
  const coreRequireIdx = main.indexOf("require(path.join(CORE_DIR, 'node_modules', mod))");
  ok(coreRequireIdx > 0, 'B2 找到核心树模块 require 锚点');
  ok(installIdx < coreRequireIdx, 'B2 安装点早于核心树第一次 require');

  const fsCacheIdx = main.indexOf("require('./fs-probe-cache.cjs')");
  ok(fsCacheIdx > 0, 'B2 找到 fs 探测缓存安装点');
  ok(installIdx < fsCacheIdx, 'B2 收窄先于负结果缓存（先摘慢路径、再缓存剩下的负结果）');

  ok(main.includes('全局模块路径已收窄（移除'), 'B3 诊断行存在（[dshm-host] 全局模块路径已收窄（移除 N 项 …））');
  ok(main.includes('DSHM_GLOBAL_PATHS'), 'B3 main.js 注释里写明 keep 开关');
  ok(mod.USER_PATH_PREFIX === '/storage/Users/currentUser', 'B3 模块的前缀常量为 /storage/Users/currentUser');

  let place = '';
  let resfile = '';
  try { place = readText(PLACE_FILE); } catch { place = ''; }
  try { resfile = readText(RESFILE_FILE); } catch { resfile = ''; }
  ok(place.includes("'module-path-guard.cjs'"), 'B4 place-host-app.mjs 的 FILES 带上 module-path-guard.cjs');
  ok(resfile.includes("'module-path-guard.cjs'"), 'B4 assert-resfile-sync.mjs 的 FILES 带上 module-path-guard.cjs');
  ok(typeof mod.installModulePathGuard === 'function', 'B4 模块导出 installModulePathGuard()');

  let gates = '';
  try { gates = readText(GATES_FILE); } catch { gates = ''; }
  ok(gates.includes('tools/check-module-path-guard.mjs'), 'B5 已加入 .github/workflows/gates.yml');

  let doc = '';
  try { doc = readText(DOC); } catch { doc = ''; }
  ok(doc.length > 0, 'B6 docs/199 存在');
  ok(/## 8[\.、 ]*除根/.test(doc), 'B6 docs/199 §8「除根：收窄全局模块路径」在');
  ok(doc.includes('globalPaths'), 'B6 §8 讲了 globalPaths');
  ok(doc.includes('NODE_PATH'), 'B6 §8 讲了 NODE_PATH');
  ok(doc.includes('第 1 次'), 'B6 §8 讲清"缓存治第 2 次、收窄治第 1 次"');
  ok(doc.includes('DSHM_GLOBAL_PATHS=keep'), 'B6 §8 写了回退口径');
  ok(doc.includes('真机'), 'B6 §8 写了真机验收方式');

  let docs199 = [];
  try { docs199 = readdirSync(join(ROOT, 'docs')).filter((name) => /^199-.*\.md$/.test(name)); } catch { docs199 = []; }
  ok(docs199.length === 1, `B6 docs/199-*.md 仍恰好一份（实测 ${docs199.length}）`);
}

/* ───────────────────── C. 变异对照臂（必须全部判红） ───────────────────── */

const MUTATIONS = [
  {
    name: '不删用户项',
    from: "return normalized === USER_PATH_PREFIX || normalized.startsWith(USER_PATH_PREFIX + '/');",
    to: 'return false;',
    case: caseFilterPaths,
    detail: '把"摘掉用户家目录项"改成什么都不摘（等于本层白装）',
  },
  {
    name: '删掉沙箱项',
    from: 'if (isUserHomePath(entry)) {',
    to: 'if (true) {',
    case: caseInstallNarrowsLivePaths,
    detail: '把所有项都当用户项摘掉（沙箱依赖会整体丢失）',
  },
  {
    name: 'keep 被忽略',
    from: 'if (isKeepMode(env)) {',
    to: 'if (false) {',
    case: caseKeepSwitch,
    detail: '让 DSHM_GLOBAL_PATHS=keep 关不掉（排障时无法复现旧行为）',
  },
  {
    name: 'HOME 不还原',
    from: '    } else {\n      env[name] = value;\n    }',
    to: '    } else {\n      /* 变异臂：还原失效 */\n    }',
    case: caseInstallNarrowsLivePaths,
    detail: '同步窗口结束后不把 HOME 写回去（进程余下生命周期环境被污染）',
  },
];

const SOURCE = readText(MODULE_FILE);
const tmpRoot = mkdtempSync(join(tmpdir(), 'dshm-module-path-guard-'));
let tmpSeq = 0;

function loadModuleFromSource(source) {
  tmpSeq += 1;
  const file = join(tmpRoot, `mut-${tmpSeq}.cjs`);
  writeFileSync(file, source, 'utf8');
  return requireCjs(file);
}

function mutationArm(entry) {
  try {
    if (SOURCE.split(entry.from).length - 1 !== 1) {
      throw new Error(`变异锚点在源码里不唯一或不存在：${fmt(entry.from)}`);
    }
    const mutated = SOURCE.replace(entry.from, entry.to);
    const mutatedModule = loadModuleFromSource(mutated);
    let red = false;
    try {
      entry.case(mutatedModule);
    } catch (e) {
      red = true;
    }
    if (!red) throw new Error('变异体仍然通过 ⇒ 这条断言没有牙');
    ok(true, `对照臂 · ${entry.name} ⇒ 判红（${entry.detail}）`);
  } catch (e) {
    ok(false, `对照臂 · ${entry.name} —— ${e && e.message}`);
  }
}

/* ───────────────────────────── 主流程 ───────────────────────────── */

const selfTest = process.argv.includes('--self-test');

console.log('# 模块路径收窄门禁（LOOP-GAP 除根，docs/199 §8）');
console.log(`# 模块：${MODULE_FILE}`);
console.log(`# 用法：node tools/check-module-path-guard.mjs${selfTest ? ' --self-test（变异臂默认就跑）' : ''}`);
console.log('');

let realModule = null;
try {
  realModule = requireCjs(MODULE_FILE);
} catch (e) {
  console.error(`FAIL 模块本身加载失败：${e && e.message}`);
  process.exit(1);
}

try {
  console.log('## A 纯逻辑（注入 fake Module / fake env；不碰真实 Module）');
  runCase('A1 filterPaths 只摘用户家目录项（沙箱项保留）', realModule, caseFilterPaths);
  runCase('A2 filterNodePath 分段收窄（空段/分隔符口径）', realModule, caseFilterNodePath);
  runCase('A3 安装后活路径表真的变窄 + env 逐字还原 + 诊断行', realModule, caseInstallNarrowsLivePaths);
  runCase('A4 DSHM_GLOBAL_PATHS=keep 完全不动', realModule, caseKeepSwitch);
  runCase('A5 异常直通（不抛、env 还原、如实报失败）', realModule, caseExceptionPassthrough);
  runCase('A6 幂等（重复安装返回同一份）', realModule, caseIdempotent);
  runCase('A7 不改 require 语义（_resolveFilename/_resolveLookupPaths/_pathCache 原对象）', realModule, caseNoSemanticChange);
  runCase('A8 真 Node 运行时具备收窄杠杆（_initPaths 只读核对）', realModule, caseRealRuntimeLever);

  console.log('');
  console.log('## B 接线（真实文件）');
  caseWiring(realModule);

  console.log('');
  console.log('## C 变异对照臂（每个必须判红）');
  for (const entry of MUTATIONS) mutationArm(entry);
} finally {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结论 */ }
}

console.log('');
if (fail > 0) {
  console.error(`❌ ${fail} 项失败（pass=${pass}）`);
  console.error('失败项：');
  for (const item of failures) console.error('  · ' + item);
  process.exit(1);
}
console.log(`✅ 通过：${pass} 项（A 纯逻辑 / B 接线 / C ${MUTATIONS.length} 个变异对照臂全红）`);
