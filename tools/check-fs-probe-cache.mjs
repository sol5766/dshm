#!/usr/bin/env node
/**
 * 门禁：fs 同步「探测型」调用的负结果缓存（LOOP-GAP 治理，2026-10-19；见 docs/199）
 *
 * 【为什么需要这条门禁】
 * 这一层是**性能修复**，而性能修复最容易烂在被悄悄放宽上：
 *   · 有人为了"多省一点"把**正结果**也缓存 ⇒ 装完插件 / 升完核心看不到新文件，
 *     症状与"安装器坏了"一模一样，且只在秒级窗口内复现、几乎不可诊断；
 *   · 有人把**白名单**顺手去掉（"全路径都缓存更省"）⇒ 我们会开始缓存
 *     `/system/**`、`/data/**` 的"不存在"，把系统面拖进来；
 *   · 有人把**异常**吞成 `false` ⇒ 权限错误 / I/O 错误被改写成"文件不存在"，
 *     上层会去做错误的分支（这不是性能问题，是语义损坏）；
 *   · 有人让**过期**失效（"TTL 调大点更省"）⇒ 内存里钉住过期答案；
 *   · 有人让 `DSHM_FS_PROBE_CACHE=off` 不好使 ⇒ 真机排障时关不掉这层。
 * 于是本门禁不只是"测通过"，还带 **5 个变异对照臂**：把上面五种放宽各注入一次，
 * 对应断言**必须判红** —— 否则说明这条断言没有牙（同族教训见 docs/199 §6）。
 *
 * 【判据】
 *   A 纯逻辑（注入假 fs + 注入时钟，不碰真实 fs、不 sleep）
 *     A1 负结果命中      A2 过期后重探      A3 正结果不缓存    A4 白名单外直通
 *     A5 off 直通        A6 异常直通        A7 TTL/上限口径    A8 statSync 负结果
 *     A9 readFileSync    A10 绝不自崩       A11 savedMs 估计   A12 幂等
 *     A13 统计与清空
 *   B 接线（真实文件）
 *     B1 main.js require 了这个模块；B2 安装点在**核心树 require 之前**；
 *     B3 在同步调用环**之前**；B4 诊断行逐字存在且与模块白名单清单一致；
 *     B5 退出时打 stats（且句柄声明在 exit 钩子之前，不踩 TDZ）；
 *     B6 resfile 两份清单都带上它；B7 已入 gates.yml；B8 文档 docs/199 在且被 README 索引。
 *   C 变异对照臂（5 个，必须全部判红）：正结果也缓存 / 白名单失效 / 异常吞成 false /
 *     过期失效 / off 被忽略。
 *
 * 【它不做什么】不验证真机 LOOP-GAP 是否消失（那要装机；见 docs/199 §7 的验收命令）。
 *
 * 用法：
 *   node tools/check-fs-probe-cache.mjs
 *   node tools/check-fs-probe-cache.mjs --self-test   # 同一套（变异臂默认就跑）
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const MODULE_FILE = join(ROOT, 'hostcore', 'app', 'fs-probe-cache.cjs');
const MAIN_FILE = join(ROOT, 'hostcore', 'app', 'main.js');
const PLACE_FILE = join(ROOT, 'tools', 'place-host-app.mjs');
const RESFILE_FILE = join(ROOT, 'tools', 'assert-resfile-sync.mjs');
const GATES_FILE = join(ROOT, '.github', 'workflows', 'gates.yml');
const DOCS_DIR = join(ROOT, 'docs');

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
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

/** 断言失败即抛：用于"行为用例"与"变异对照臂"（后者必须靠抛来判红）。 */
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}
function expectEq(actual, expected, msg) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${msg}（实测 ${fmt(actual)}，应 ${fmt(expected)}）`);
  }
}

/* ───────────────────────────── 夹具 ───────────────────────────── */

/** 造一个能判"底层被调用了几次"的假 fs；handlers 决定行为（可以抛）。 */
function makeFakeFs(handlers) {
  const calls = { existsSync: 0, statSync: 0, readFileSync: 0 };
  const fake = {
    existsSync(p) {
      calls.existsSync += 1;
      return handlers.existsSync(p);
    },
    statSync(p, options) {
      calls.statSync += 1;
      return handlers.statSync(p, options);
    },
    readFileSync(p, options) {
      calls.readFileSync += 1;
      return handlers.readFileSync(p, options);
    },
  };
  return { fake, calls };
}

function enoent(p) {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), {
    code: 'ENOENT',
    errno: -2,
    syscall: 'open',
    path: p,
  });
}

/** 默认"什么都探测不到"的假 fs（可覆盖）。 */
function noneHandlers(overrides) {
  return Object.assign({
    existsSync: () => false,
    statSync: (p) => { throw enoent(p); },
    readFileSync: (p) => { throw enoent(p); },
  }, overrides || {});
}

/** 跑一个"行为用例"：抛 = 失败。 */
function runCase(name, mod, fn) {
  try {
    fn(mod);
    ok(true, name);
  } catch (e) {
    ok(false, `${name} —— ${e && e.message}`);
  }
}

/* ─────────────────── A. 纯逻辑用例（注入假 fs / 假时钟） ─────────────────── */

function caseNegativeHit(mod) {
  const { fake, calls } = makeFakeFs(noneHandlers());
  const handle = mod.installFsProbeCache({ fs: fake, env: {}, now: () => 0 });
  expectEq(handle.enabled, true, '默认启用');
  expectEq(handle.ttlMs, 30000, '默认 TTL=30000ms');
  expectEq(handle.patched.join(','), 'existsSync,statSync,readFileSync', '只接管这三个入口');
  const p = '/storage/Users/currentUser/.node_modules/@linxin666/dsh-web-all/package.json';
  expectEq(fake.existsSync(p), false, '首次负结果');
  expectEq(fake.existsSync(p), false, '命中负结果仍返回 false');
  expectEq(calls.existsSync, 1, '底层只被调用一次（第二次命中缓存）');
  const stats = handle.stats();
  expectEq(stats.hits, 1, 'hits=1');
  expectEq(stats.misses, 1, 'misses=1');
  expectEq(stats.cachedNegatives, 1, '入缓存 1 条');
  expectEq(stats.entries, 1, '缓存里 1 条');
}

function caseExpiry(mod) {
  const clock = { value: 0 };
  const { fake, calls } = makeFakeFs(noneHandlers());
  const handle = mod.installFsProbeCache({
    fs: fake,
    env: { DSHM_FS_PROBE_CACHE_TTL_MS: '50' },
    now: () => clock.value,
  });
  expectEq(handle.ttlMs, 50, 'TTL 可调（50ms）');
  const p = '/srv/app/node_modules/x/package.json';
  fake.existsSync(p);
  clock.value = 49;
  fake.existsSync(p);
  expectEq(calls.existsSync, 1, 'TTL 内仍命中');
  clock.value = 51;
  fake.existsSync(p);
  expectEq(calls.existsSync, 2, '过期后必须重新探测');
  expectEq(handle.stats().expired, 1, 'expired 计数=1');
}

function casePositiveNotCached(mod) {
  const { fake, calls } = makeFakeFs(noneHandlers({ existsSync: () => true }));
  const handle = mod.installFsProbeCache({ fs: fake, env: {}, now: () => 0 });
  const p = '/srv/app/node_modules/x/package.json';
  expectEq(fake.existsSync(p), true, '正结果照常见 true');
  expectEq(fake.existsSync(p), true, '正结果第二次仍 true');
  expectEq(calls.existsSync, 2, '正结果**绝不缓存**（连续两次都到底层）');
  expectEq(handle.stats().hits, 0, '正结果不产生命中');
  expectEq(handle.stats().entries, 0, '缓存里一条都没有');
}

function caseWhitelist(mod) {
  const { fake, calls } = makeFakeFs(noneHandlers());
  const handle = mod.installFsProbeCache({ fs: fake, env: {}, now: () => 0 });
  const outside = '/storage/Users/currentUser/Workspace/notes/a.txt';
  expectEq(fake.existsSync(outside), false, '白名单外照常返回 false');
  expectEq(fake.existsSync(outside), false, '白名单外第二次');
  expectEq(calls.existsSync, 2, '白名单外**直通**（不许进缓存）');
  expectEq(handle.stats().passthrough, 2, 'passthrough=2');
  expectEq(handle.stats().entries, 0, '白名单外一条都不缓存');
  // 纯函数矩阵（顺带钉住"归一化"与"只认子串标记"的口径）
  expectEq(mod.isCacheablePath('/storage/Users/currentUser/.node_modules/@x/y/package.json'), true, '含 node_modules ⇒ 可缓存');
  expectEq(mod.isCacheablePath('/data/storage/node_modules/x'), true, '上行探测面 ⇒ 可缓存');
  expectEq(mod.isCacheablePath('C:\\app\\x\\package.json'), true, '反斜杠归一化后含 /package.json ⇒ 可缓存');
  expectEq(mod.isCacheablePath('/home/u/.dsh/profiles/ondevice/package.json'), true, 'profiles 面 ⇒ 可缓存');
  expectEq(mod.isCacheablePath('/home/u/.dsh/install-queue/a.req'), true, 'install-queue 面 ⇒ 可缓存');
  expectEq(mod.isCacheablePath('/storage/Users/currentUser/Workspace/a.txt'), false, '普通用户文件 ⇒ 直通');
  expectEq(mod.isCacheablePath('/system/build.prop'), false, '系统面 ⇒ 直通');
  expectEq(mod.isCacheablePath(''), false, '空串 ⇒ 直通');
  expectEq(mod.isCacheablePath(7), false, '数字（fd）⇒ 直通');
  expectEq(mod.isCacheablePath(new URL('file:///x/node_modules/a')), false, 'URL 对象 ⇒ 直通');
}

function caseOff(mod) {
  for (const raw of ['off', 'OFF', 'false', '0', 'no']) {
    const { fake } = makeFakeFs(noneHandlers());
    const before = fake.existsSync;
    const handle = mod.installFsProbeCache({
      fs: fake,
      env: { DSHM_FS_PROBE_CACHE: raw },
      now: () => 0,
    });
    expectEq(handle.enabled, false, `DSHM_FS_PROBE_CACHE=${raw} ⇒ 关闭`);
    expectEq(handle.patched.length, 0, `关闭时不包装任何入口（${raw}）`);
    expectEq(fake.existsSync === before, true, `关闭时 fs 原样不动（${raw}）`);
    expectEq(handle.stats().hits, 0, `关闭时没有命中（${raw}）`);
  }
}

function caseExceptionPassthrough(mod) {
  const boom = Object.assign(new Error('EACCES: permission denied'), {
    code: 'EACCES', errno: -13, syscall: 'access', path: '/srv/app/node_modules/x/package.json',
  });
  const { fake, calls } = makeFakeFs(noneHandlers({
    existsSync: () => { throw boom; },
    statSync: () => { throw boom; },
    readFileSync: () => { throw boom; },
  }));
  const handle = mod.installFsProbeCache({ fs: fake, env: {}, now: () => 0 });
  const p = '/srv/app/node_modules/x/package.json';
  let caught = null;
  try { fake.existsSync(p); } catch (e) { caught = e; }
  expectEq(caught, boom, 'existsSync 的异常原对象直通（**绝不**变成 false）');
  let caughtAgain = null;
  try { fake.existsSync(p); } catch (e) { caughtAgain = e; }
  expectEq(caughtAgain, boom, '异常不被缓存（第二次仍抛原对象）');
  expectEq(calls.existsSync, 2, '异常路径每次都到底层');
  let statCaught = null;
  try { fake.statSync(p); } catch (e) { statCaught = e; }
  expectEq(statCaught, boom, 'statSync 的非 ENOENT 异常原样抛出');
  let readCaught = null;
  try { fake.readFileSync(p); } catch (e) { readCaught = e; }
  expectEq(readCaught, boom, 'readFileSync 的非 ENOENT 异常原样抛出');
  expectEq(handle.stats().entries, 0, '异常一条都不进缓存');
}

function caseTtlConfig(mod) {
  expectEq(mod.DEFAULT_TTL_MS, 30000, 'DEFAULT_TTL_MS=30000');
  expectEq(mod.MAX_TTL_MS, 600000, 'MAX_TTL_MS=600000（10 分钟上限）');
  expectEq(mod.resolveTtl({}).ttlMs, 30000, '不设 env ⇒ 默认');
  expectEq(mod.resolveTtl({ DSHM_FS_PROBE_CACHE_TTL_MS: '1234' }).ttlMs, 1234, 'env 可调');
  expectEq(mod.resolveTtl({ DSHM_FS_PROBE_CACHE_TTL_MS: 'abc' }).ttlMs, 30000, '非法值退回默认');
  expectEq(mod.resolveTtl({ DSHM_FS_PROBE_CACHE_TTL_MS: '-5' }).ttlMs, 30000, '负数退回默认');
  expectEq(mod.resolveTtl({ DSHM_FS_PROBE_CACHE_TTL_MS: '999999999' }).ttlMs, 600000, '超上限被夹到 10 分钟');
  const { fake } = makeFakeFs(noneHandlers());
  const before = fake.existsSync;
  const handle = mod.installFsProbeCache({
    fs: fake, env: { DSHM_FS_PROBE_CACHE_TTL_MS: '0' }, now: () => 0,
  });
  expectEq(handle.enabled, false, 'TTL=0 ⇒ 等同关闭');
  expectEq(fake.existsSync === before, true, 'TTL=0 时 fs 原样不动');
}

function caseStatNegative(mod) {
  const state = { exists: false };
  const clock = { value: 0 };
  const { fake, calls } = makeFakeFs(noneHandlers({
    statSync: (p, options) => {
      if (options && typeof options === 'object' && options.throwIfNoEntry === false) {
        return state.exists ? { size: 3, path: p } : undefined;
      }
      if (!state.exists) throw enoent(p);
      return { size: 3, path: p };
    },
  }));
  const handle = mod.installFsProbeCache({ fs: fake, env: {}, now: () => clock.value });
  const p = '/srv/app/node_modules/x/package.json';
  let first = null;
  try { fake.statSync(p); } catch (e) { first = e; }
  expectEq(first && first.code, 'ENOENT', '首次 statSync 抛 ENOENT（code 不变）');
  expectEq(first && first.path, p, '异常 path 逐字一致');
  state.exists = true; // 模拟"同进程安装窗口"：文件刚被装上
  let second = null;
  try { fake.statSync(p); } catch (e) { second = e; }
  expectEq(second && second.code, 'ENOENT', 'TTL 内负结果仍命中（本层刻意接受的安装窗口，见 docs/199）');
  expectEq(calls.statSync, 1, '命中期内底层没有被调用第二次');
  clock.value = 30001;
  const stat = fake.statSync(p);
  expectEq(stat && stat.size, 3, '过期后真的重探到文件');
  expectEq(calls.statSync, 2, '过期后底层被调用第二次');
  fake.statSync(p);
  fake.statSync(p);
  expectEq(calls.statSync, 4, 'statSync 正结果**不缓存**');
  // `throwIfNoEntry:false` 的负结果是 undefined（不是抛），语义不同 ⇒ 必须直通
  state.exists = false;
  const before = calls.statSync;
  expectEq(fake.statSync(p, { throwIfNoEntry: false }), undefined, 'throwIfNoEntry:false 返回 undefined');
  expectEq(fake.statSync(p, { throwIfNoEntry: false }), undefined, 'throwIfNoEntry:false 第二次仍 undefined');
  expectEq(calls.statSync, before + 2, 'throwIfNoEntry:false 一律直通（不缓存）');
  expectEq(handle.stats().passthrough >= 2, true, 'passthrough 记账');
}

function caseReadNegative(mod) {
  const state = { content: Buffer.alloc(300 * 1024, 0x61) };
  const clock = { value: 0 };
  const { fake, calls } = makeFakeFs(noneHandlers({
    readFileSync: (p) => {
      if (state.content === null) throw enoent(p);
      return state.content;
    },
  }));
  const handle = mod.installFsProbeCache({ fs: fake, env: {}, now: () => clock.value });
  const p = '/srv/app/profiles/ondevice/package.json';
  const firstRead = fake.readFileSync(p);
  const secondRead = fake.readFileSync(p);
  expectEq(firstRead.length, 300 * 1024, '读到 300KB');
  expectEq(secondRead.length, 300 * 1024, '第二次也读到 300KB');
  expectEq(calls.readFileSync, 2, '300KB 正结果连续两次都到底层（大文件内容**永不**进缓存）');
  expectEq(handle.stats().entries, 0, '大文件读完之后缓存里一条都没有');
  // 负结果
  state.content = null;
  let e1 = null;
  try { fake.readFileSync(p); } catch (e) { e1 = e; }
  expectEq(e1 && e1.code, 'ENOENT', '首次读到 ENOENT');
  const callsAfterMiss = calls.readFileSync;
  let e2 = null;
  try { fake.readFileSync(p); } catch (e) { e2 = e; }
  expectEq(calls.readFileSync, callsAfterMiss, '命中负结果时没有再到底层');
  expectEq(e2 === e1, true, '重抛的是**同一个** Error 对象（code/path 逐字一致）');
  clock.value = 30001;
  state.content = Buffer.from('{}');
  expectEq(String(fake.readFileSync(p)), '{}', '过期后读到新内容');
}

function caseNeverThrows(mod) {
  const { fake, calls } = makeFakeFs(noneHandlers());
  const handle = mod.installFsProbeCache({ fs: fake, env: {}, now: () => 0 });
  expectEq(fake.existsSync(new URL('file:///srv/node_modules/x/package.json')), false, 'URL 参数直通');
  expectEq(fake.existsSync(3), false, '数字参数直通');
  expectEq(fake.existsSync(''), false, '空串直通');
  expectEq(calls.existsSync, 3, '三种奇怪参数都到底层');
  expectEq(handle.stats().passthrough, 3, 'passthrough=3');
  expectEq(handle.stats().cachedNegatives, 0, '奇怪参数不进缓存');
  // env 取值本身抛错：不许把安装搞崩（按默认开）
  const evilEnv = { get DSHM_FS_PROBE_CACHE() { throw new Error('boom'); } };
  const { fake: fake2 } = makeFakeFs(noneHandlers());
  let threw = null;
  let evilHandle = null;
  try { evilHandle = mod.installFsProbeCache({ fs: fake2, env: evilEnv, now: () => 0 }); } catch (e) { threw = e; }
  expectEq(threw, null, 'env getter 抛错时安装不许抛');
  expectEq(evilHandle && evilHandle.enabled, true, 'env 读不出来 ⇒ 按默认启用');
  // 冻结的 fs（只读属性赋值会抛）：包装跳过，原函数照常可用
  const frozen = Object.freeze({
    existsSync() { return false; },
    statSync(p) { throw enoent(p); },
    readFileSync(p) { throw enoent(p); },
  });
  let frozenThrew = null;
  try { mod.installFsProbeCache({ fs: frozen, env: {}, now: () => 0 }); } catch (e) { frozenThrew = e; }
  expectEq(frozenThrew, null, '冻结 fs 上安装不许抛');
  expectEq(frozen.existsSync('/x/node_modules/y'), false, '冻结 fs 的原函数仍可用');
  // 关闭之后 clear()/stats() 也必须可用
  mod.clear();
  expectEq(typeof mod.stats().hits, 'number', '模块级 stats() 永远返回数字');
}

function caseSavedMs(mod) {
  const clock = { value: 0 };
  const { fake } = makeFakeFs(noneHandlers({
    existsSync: () => { clock.value += 900; return false; }, // 模拟慢存储：一次探测 900ms
  }));
  const handle = mod.installFsProbeCache({ fs: fake, env: {}, now: () => clock.value });
  const p = '/srv/app/node_modules/x/package.json';
  fake.existsSync(p);
  fake.existsSync(p);
  expectEq(handle.stats().savedMs, 900, '估计节省 = 首次探测耗时（命中时累加）');
}

function caseIdempotent(mod) {
  const { fake, calls } = makeFakeFs(noneHandlers());
  const first = mod.installFsProbeCache({ fs: fake, env: {}, now: () => 0 });
  const second = mod.installFsProbeCache({ fs: fake, env: {}, now: () => 0 });
  expectEq(first === second, true, '同一 fs 重复安装返回同一个句柄（幂等）');
  fake.existsSync('/srv/app/node_modules/x/package.json');
  expectEq(calls.existsSync, 1, '重复安装不会导致底层被调用两次');
}

function caseStatsAndClear(mod) {
  const { fake } = makeFakeFs(noneHandlers());
  const handle = mod.installFsProbeCache({ fs: fake, env: {}, now: () => 0 });
  fake.existsSync('/srv/app/node_modules/a/package.json');
  fake.existsSync('/srv/app/node_modules/b/package.json');
  expectEq(handle.stats().entries, 2, '两条负结果入缓存');
  mod.clear();
  expectEq(handle.stats().entries, 0, 'clear() 清空缓存');
  fake.existsSync('/srv/app/node_modules/a/package.json');
  expectEq(handle.stats().misses, 3, '清空后重新探测（misses 累加）');
  const snapshot = mod.stats();
  expectEq(typeof snapshot.hits, 'number', '模块级 stats().hits 是数字');
  expectEq(Array.isArray(snapshot.whitelist), true, '快照带白名单');
}

function caseWriteInvalidation(mod) {
  /*
   * 2026-10-19 真机门禁回归（check-plugin-toggle 红）：缓存只记"不存在"，
   * 而同进程里的写操作（renameSync 落位 / writeFileSync 写清单 / mkdirSync）
   * 会让路径立刻存在 ⇒ 必须在写前清缓存，否则 TTL 内一直读到"插件清单不存在"。
   */
  let exists = false;
  const fake = {
    existsSync(p) {
      calls.existsSync += 1;
      return exists;
    },
    statSync(p) {
      calls.statSync += 1;
      if (!exists) throw enoent(p);
      return { isFile: () => true, size: 1 };
    },
    readFileSync(p) {
      calls.readFileSync += 1;
      if (!exists) throw enoent(p);
      return '{"ok":true}';
    },
    writeFileSync(p, data) {
      calls.writeFileSync += 1;
      exists = true;
      return undefined;
    },
  };
  const calls = { existsSync: 0, statSync: 0, readFileSync: 0, writeFileSync: 0 };
  const handle = mod.installFsProbeCache({ fs: fake, env: {}, now: () => 0 });
  const p = '/srv/profile/node_modules/plugin/package.json';
  expectEq(fake.existsSync(p), false, '写前：负结果进缓存');
  expectEq(handle.stats().entries, 1, '写前有 1 条负结果');
  fake.writeFileSync(p, '{}');
  expectEq(calls.writeFileSync, 1, '写操作真的执行了');
  expectEq(handle.stats().entries, 0, '写操作后缓存被清空（关键判据）');
  expectEq(fake.existsSync(p), true, '写后立刻能看到新文件（不再吃 30s 假阴性）');
  expectEq(calls.existsSync, 2, '写后那次是真实探测（不是命中缓存）');
  expectEq(handle.invalidateWrites.includes('writeFileSync'), true, 'invalidateWrites 登记了 writeFileSync');
}

/* ───────────────────────── B. 接线（真实文件） ───────────────────────── */function readText(file) {
  return readFileSync(file, 'utf8');
}

function caseWiring(mod) {
  const main = readText(MAIN_FILE);
  const place = readText(PLACE_FILE);
  const resfile = readText(RESFILE_FILE);

  const requireIdx = main.indexOf("require('./fs-probe-cache.cjs')");
  ok(requireIdx > 0, 'B1 main.js 真的 require 了 ./fs-probe-cache.cjs');
  const installIdx = main.indexOf('installFsProbeCache({ log: diag })');
  ok(installIdx > 0, 'B1 main.js 真的调用了 installFsProbeCache({ log: diag })');
  ok(installIdx > requireIdx, 'B1 调用点在 require 之后');

  const coreDirIdx = main.indexOf('const CORE_DIR = process.env.DSHM_CORE_DIR || currentCoreDir();');
  ok(coreDirIdx > 0, 'B2 找到核心树锚点 `const CORE_DIR = …`');
  ok(installIdx < coreDirIdx, 'B2 安装点**早于**核心树目录解析（CORE_DIR 之前）');
  const coreRequireIdx = main.indexOf("require(path.join(CORE_DIR, 'node_modules', mod))");
  ok(coreRequireIdx > 0, 'B2 找到核心树模块 require 锚点');
  ok(installIdx < coreRequireIdx, 'B2 安装点**早于**核心树第一次 require');

  const ringIdx = main.indexOf('同步调用环已安装');
  ok(ringIdx > 0, 'B3 找到同步调用环安装锚点');
  ok(installIdx < ringIdx, 'B3 安装点**早于**同步调用环（SYNC-COUNT 才量得到收益）');

  ok(main.includes('[dshm-host] fs 探测缓存已安装（TTL='), 'B4 诊断行存在（[dshm-host] fs 探测缓存已安装（TTL=…））');
  const whitelistLiteral = '白名单=node_modules/package.json/profiles/install-queue';
  ok(main.includes(whitelistLiteral), 'B4 诊断行里白名单清单逐字存在');
  ok(mod.WHITELIST_LABEL === 'node_modules/package.json/profiles/install-queue',
    'B4 模块的 WHITELIST_LABEL 与诊断行逐字一致');
  ok(Array.isArray(mod.WHITELIST) && mod.WHITELIST.join('/') === 'node_modules//package.json//profiles///install-queue',
    'B4 模块 WHITELIST 仍是四项（node_modules / /package.json / /profiles/ / /install-queue）');

  const handleDeclIdx = main.indexOf('let fsProbeCacheHandle = null;');
  ok(handleDeclIdx > 0, 'B5 句柄声明为 `let`（避免 exit 回调踩 TDZ）');
  const exitIdx = main.indexOf("process.on('exit'");
  ok(exitIdx > handleDeclIdx, 'B5 句柄声明在 exit 钩子之前');
  const statsIdx = main.indexOf('fs 探测缓存 stats：enabled=');
  ok(statsIdx > exitIdx, 'B5 退出时真的打了 stats（在 exit 钩子内）');
  ok(main.includes('fsProbeCacheHandle.stats()'), 'B5 退出统计走句柄的 stats()');

  ok(place.includes("'fs-probe-cache.cjs'"), 'B6 place-host-app.mjs 的 FILES 带上 fs-probe-cache.cjs');
  ok(resfile.includes("'fs-probe-cache.cjs'"), 'B6 assert-resfile-sync.mjs 的 FILES 带上 fs-probe-cache.cjs');
  ok(typeof mod.installFsProbeCache === 'function' && typeof mod.stats === 'function',
    'B6 模块导出了 installFsProbeCache() 与 stats()');

  let gates = '';
  try { gates = readText(GATES_FILE); } catch { gates = ''; }
  ok(gates.includes('tools/check-fs-probe-cache.mjs'), 'B7 已加入 .github/workflows/gates.yml');

  let docs = [];
  try { docs = readdirSync(DOCS_DIR).filter((name) => /^199-.*\.md$/.test(name)); } catch { docs = []; }
  ok(docs.length === 1, `B8 docs/199-*.md 恰好一份（实测 ${docs.length} 份：${docs.join('、') || '无'}）`);
  if (docs.length === 1) {
    const body = readText(join(DOCS_DIR, docs[0]));
    ok(body.includes('LOOP-GAP'), 'B8 docs/199 写了现象（LOOP-GAP）');
    ok(body.includes('DSHM_FS_PROBE_CACHE_TTL_MS'), 'B8 docs/199 写了开关与 TTL 口径');
    ok(body.includes('真机待验'), 'B8 docs/199 带真机待验清单');
    let readme = '';
    try { readme = readText(join(DOCS_DIR, 'README.md')); } catch { readme = ''; }
    ok(readme.includes('199-'), 'B8 docs/README.md 索引了 199');
  }
}

/* ───────────────────── C. 变异对照臂（必须全部判红） ───────────────────── */

const MUTATIONS = [
  {
    name: '正结果也缓存',
    from: 'if (r === false) {',
    to: 'if (true) {',
    case: casePositiveNotCached,
    detail: '把"只缓存负结果"放宽成正负都缓存',
  },
  {
    name: '白名单失效（全路径缓存）',
    from: 'if (normalized.includes(marker)) return true;',
    to: 'return true;',
    case: caseWhitelist,
    detail: '把路径白名单拆掉，任何路径都缓存',
  },
  {
    name: '异常被吞成 false',
    from: 'const r = orig.apply(fsImpl, arguments);',
    to: 'let r; try { r = orig.apply(fsImpl, arguments); } catch (e) { r = false; }',
    case: caseExceptionPassthrough,
    detail: '把 existsSync 的异常改写成"不存在"',
  },
  {
    name: '过期失效（TTL 不生效）',
    from: 'if (entry.expiresAt <= now()) {',
    to: 'if (false) {',
    case: caseExpiry,
    detail: '让缓存项永不过期',
  },
  {
    name: 'off 被忽略',
    from: "if (raw === 'off' || raw === 'false' || raw === '0' || raw === 'no') {",
    to: 'if (false) {',
    case: caseOff,
    detail: '让 DSHM_FS_PROBE_CACHE=off 关不掉',
  },
  {
    name: '写操作不清缓存',
    from: 'runtime.store.clear();',
    to: '/* mutated: 写前不清缓存 */',
    case: caseWriteInvalidation,
    detail: '把写操作前的整表清空去掉（模拟 TTL 内仍读到旧负结果）',
  },
];

const SOURCE = readText(MODULE_FILE);
const tmpRoot = mkdtempSync(join(tmpdir(), 'dshm-fs-probe-cache-'));
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

console.log('# fs 探测缓存门禁（LOOP-GAP 治理，docs/199）');
console.log(`# 模块：${MODULE_FILE}`);
console.log(`# 用法：node tools/check-fs-probe-cache.mjs${selfTest ? ' --self-test（变异臂默认就跑）' : ''}`);
console.log('');

let realModule = null;
try {
  realModule = requireCjs(MODULE_FILE);
} catch (e) {
  console.error(`FAIL 模块本身加载失败：${e && e.message}`);
  process.exit(1);
}

try {
  console.log('## A 纯逻辑（注入假 fs / 假时钟；不碰真实 fs、不 sleep）');
  runCase('A1 负结果命中（existsSync 只到底层一次）', realModule, caseNegativeHit);
  runCase('A2 过期后重探（TTL 可调、expired 记账）', realModule, caseExpiry);
  runCase('A3 正结果不缓存（连续两次都到底层）', realModule, casePositiveNotCached);
  runCase('A4 白名单外直通（含 isCacheablePath 矩阵）', realModule, caseWhitelist);
  runCase('A5 DSHM_FS_PROBE_CACHE=off 全直通、fs 原样不动', realModule, caseOff);
  runCase('A6 异常直通（原对象、不缓存、绝不变成 false）', realModule, caseExceptionPassthrough);
  runCase('A7 TTL / 上限 / 非法值 / TTL=0 口径', realModule, caseTtlConfig);
  runCase('A8 statSync 负结果缓存 + throwIfNoEntry:false 直通', realModule, caseStatNegative);
  runCase('A9 readFileSync 负结果缓存 + 300KB 内容永不缓存', realModule, caseReadNegative);
  runCase('A10 绝不自崩（奇怪参数 / env getter 抛错 / 冻结 fs）', realModule, caseNeverThrows);
  runCase('A11 savedMs 估计（慢盘 900ms ⇒ 命中记 900ms）', realModule, caseSavedMs);
  runCase('A12 幂等（重复安装返回同一句柄）', realModule, caseIdempotent);
  runCase('A13 统计与 clear()', realModule, caseStatsAndClear);
  runCase('A14 写操作清缓存（写后立刻能看到新文件；2026-10-19 check-plugin-toggle 回归）', realModule, caseWriteInvalidation);

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
