#!/usr/bin/env node
/**
 * 门禁：桥接契约层（BRIDGE_CONTRACT_JS）的行为与两壳同源。
 *
 * 【为什么需要它】契约层是页面侧唯一统一入口：信封 / 未知路由 / 参数校验 / 超时 /
 * 幂等完成。它由字符串常量注入 ArkWeb，编译器不会替我们检查语义，真机也只会
 * 表现为"某个桥偶尔不返回"。这里把注入的 JS 原文抽出来，在 Node 的独立 ctx 里
 * 用一个假桥跑行为矩阵；任何一条回归都当场判红。
 *
 * 【判据】（基线必须 0 失败）
 *   1. 同步成功 / 未知路由 / 非法参数 / 业务抛错 / 无返回值
 *   2. callAsync 普通路由立即完成；picker 成功 / 取消 / 超时
 *   3. 幂等完成：同一 id 第二次 complete 返回 false；迟到回调被忽略
 *   4. 16 路并发互不串包；1 MiB 载荷与 Unicode 原样透传
 *   5. 入口与手机两壳的契约文本逐字节一致，且在注入清单里排第一
 *
 * 【--self-test】四个变异体必须全部判红：去掉未知路由判据 / 改超时结果 / 去掉幂等
 * 守卫 / 破坏取消语义。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FILES = {
  entry: 'entry/src/main/ets/pages/WebApp.ets',
  phone: 'phone/src/main/ets/pages/WebApp.ets',
};
const EXTRACT = /const BRIDGE_CONTRACT_JS: string = `([\s\S]*?)`;/;

function extract(rel) {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const m = src.match(EXTRACT);
  if (!m) throw new Error(`${rel} 里找不到 BRIDGE_CONTRACT_JS`);
  return m[1];
}

/** 注入清单里契约必须排第一（先立统一入口，后续垫片才可能直接调用）。 */
function injectedFirst(rel) {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const m = src.match(/private pickerShimScripts: Array<ScriptItem> = \[([\s\S]*?)\n  \];/);
  if (!m) return false;
  const first = m[1].split('\n').map((l) => l.trim()).find((l) => l.startsWith('{ script:'));
  return first !== undefined && /^\{\s*script:\s*BRIDGE_CONTRACT_JS,/.test(first);
}

function makeContext(code, bridges, picker, origin = 'http://127.0.0.1:3121') {
  const sandbox = {
    __DSHM_BRIDGES__: bridges,
    __DSH_DIRECTORY_PICKER__: picker,
    location: { origin },
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

function parse(env) {
  try {
    return typeof env === 'string' ? JSON.parse(env) : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSuite(code) {
  const failures = [];
  const check = (label, cond, detail = '') => {
    if (!cond) failures.push(`${label}${detail ? `（${detail}）` : ''}`);
  };

  /* 1. 同步成功 / 无返回值 / 抛错 / 未知路由 / 非法参数 */
  {
    const ctx = makeContext(code, {
      echo: (s) => `E:${s}`,
      silent: () => undefined,
      boom: () => { throw new Error('kaboom'); },
    }, null);
    const api = ctx.dshmBridge;
    check('契约对象存在', api && typeof api.call === 'function');
    const ok = parse(api.call('echo', '["hi"]'));
    check('同步成功 code=0', ok && ok.code === 0 && ok.data === 'E:hi', JSON.stringify(ok));
    const silent = parse(api.call('silent', '[]'));
    check('无返回值归一为空串', silent && silent.code === 0 && silent.data === '', JSON.stringify(silent));
    const boom = parse(api.call('boom', '[]'));
    check('业务抛错 code=1', boom && boom.code === 1 && boom.msg === 'kaboom', JSON.stringify(boom));
    const unknown = parse(api.call('nope', '[]'));
    check('未知路由 code=1', unknown && unknown.code === 1 && /^unknown-route:/.test(unknown.msg), JSON.stringify(unknown));
    const badArgs = parse(api.call('echo', '{"a":1}'));
    check('非数组参数 code=1', badArgs && badArgs.code === 1 && badArgs.msg === 'invalid-args', JSON.stringify(badArgs));
    const badName = parse(api.call('', '[]'));
    check('空方法名 code=1', badName && badName.code === 1 && badName.msg === 'invalid-name', JSON.stringify(badName));

    /* 同源闸门：origin 被换掉（模拟被注入到远端 iframe）后必须拒绝 */
    ctx.location.origin = 'https://evil.example';
    const denied = parse(api.call('echo', '["x"]'));
    check('跨源调用被拒', denied && denied.code === 1 && denied.msg === 'origin-denied', JSON.stringify(denied));
    ctx.location.origin = 'http://127.0.0.1:3121';
    const allowed = parse(api.call('echo', '["x"]'));
    check('同源恢复后可用', allowed && allowed.code === 0, JSON.stringify(allowed));
  }

  /* 2. callAsync：普通路由立即完成 */
  {
    const ctx = makeContext(code, { echo: (s) => `A:${s}` }, null);
    const env = parse(await ctx.dshmBridge.callAsync('echo', '["x"]'));
    check('callAsync 同步路由', env && env.code === 0 && env.data === 'A:x', JSON.stringify(env));
  }

  /* 3. picker 成功 / 取消 */
  {
    const pickerOk = { pick: () => Promise.resolve('/tmp/demo') };
    const ctxOk = makeContext(code, {}, pickerOk);
    const ok = parse(await ctxOk.dshmBridge.callAsync('pickDirectory', '[]'));
    check('picker 成功', ok && ok.code === 0 && ok.data === '/tmp/demo', JSON.stringify(ok));

    const pickerCancel = { pick: () => Promise.resolve(null) };
    const ctxCancel = makeContext(code, {}, pickerCancel);
    const cancelled = parse(await ctxCancel.dshmBridge.callAsync('pickDirectory', '[]'));
    check('picker 取消', cancelled && cancelled.code === 0 && cancelled.data === 'null' && cancelled.msg === 'cancelled', JSON.stringify(cancelled));
  }

  /* 4. 超时 + 迟到回调忽略 + 幂等完成 */
  {
    let release = null;
    const picker = { pick: () => new Promise((resolve) => { release = resolve; }) };
    const ctx = makeContext(code, {}, picker);
    const api = ctx.dshmBridge;
    const started = api.callAsync('pickDirectory', '[]', { timeoutMs: 25 });
    await sleep(60);
    const timeout = parse(await started);
    check('超时 code=1/timeout', timeout && timeout.code === 1 && timeout.msg === 'timeout', JSON.stringify(timeout));
    check('超时后 pending 清空', api.pendingCount() === 0, String(api.pendingCount()));
    release('/late');
    await sleep(10);
    check('迟到回调不重建 pending', api.pendingCount() === 0, String(api.pendingCount()));

    const never = { pick: () => new Promise(() => {}) };
    const ctx2 = makeContext(code, {}, never);
    const api2 = ctx2.dshmBridge;
    const pending = api2.callAsync('pickDirectory', '[]', { timeoutMs: 2000 });
    const ids = api2.pendingIds();
    check('pendingIds 可读', ids.length === 1, String(ids.length));
    if (ids.length === 1) {
      check('第一次 complete 生效', api2.complete(ids[0], true, 'first', 'ok') === true);
      check('第二次 complete 被忽略', api2.complete(ids[0], true, 'second', 'ok') === false);
    }
    const first = parse(await pending);
    check('只认第一次完成', first && first.data === 'first', JSON.stringify(first));
    check('未知 id complete=false', api2.complete('bogus', true, '', '') === false);
  }

  /* 5. 16 路并发 + 1 MiB + Unicode */
  {
    const picker = {
      pick: () => new Promise((resolve) => {
        setTimeout(() => resolve('/p'), 1 + Math.floor(Math.random() * 4));
      }),
    };
    const ctx = makeContext(code, { echo: (s) => s }, picker);
    const api = ctx.dshmBridge;
    const jobs = [];
    for (let i = 0; i < 16; i += 1) {
      const name = i % 2 === 0 ? 'pickDirectory' : 'echo';
      const args = name === 'echo' ? JSON.stringify([`v${i}`]) : '[]';
      jobs.push(api.callAsync(name, args, { timeoutMs: 2000 }).then(parse));
    }
    const results = await Promise.all(jobs);
    check('16 路全部成功', results.every((r) => r && r.code === 0), JSON.stringify(results.filter((r) => !r || r.code !== 0)));
    check('16 路不串包', results[0].data === '/p' && results[1].data === 'v1' && results[15].data === 'v15');
    check('并发后 pending 清空', api.pendingCount() === 0, String(api.pendingCount()));

    const big = 'x'.repeat(1024 * 1024);
    const bigEnv = parse(api.call('echo', JSON.stringify([big])));
    check('1 MiB 原样透传', bigEnv && bigEnv.code === 0 && bigEnv.data.length === big.length, String(bigEnv && bigEnv.data.length));
    const uni = '中文🙂\u0000tail';
    const uniEnv = parse(api.call('echo', JSON.stringify([uni])));
    check('Unicode/NUL 原样透传', uniEnv && uniEnv.data === uni, JSON.stringify(uniEnv && uniEnv.data));
  }

  return failures;
}

const codeEntry = extract(FILES.entry);
const codePhone = extract(FILES.phone);

const problems = [];
if (codeEntry !== codePhone) problems.push('entry 与 phone 的契约文本不一致（必须逐字节相同）');
for (const [mod, rel] of Object.entries(FILES)) {
  if (!injectedFirst(rel)) problems.push(`[${mod}] 契约不在 pickerShimScripts 第一项`);
}

const baseline = await runSuite(codeEntry);
problems.push(...baseline.map((p) => `[基线] ${p}`));

if (!process.argv.includes('--self-test')) {
  if (problems.length > 0) {
    console.error(`❌ 桥接契约不成立（${problems.length} 处）：`);
    for (const p of problems) console.error(`   · ${p}`);
    process.exit(1);
  }
  console.log('✅ 通过：桥接契约（信封/未知路由/参数校验/超时/幂等完成/并发/1MiB/Unicode）成立，两壳同源且首项注入。');
  process.exit(0);
}

console.log('--self-test：变异体必须判红 --');
console.log(`  基线：${baseline.length} 处失败（应为 0）`);
const mutations = [
  ['去掉未知路由判据', codeEntry.replace("if (typeof b[name] !== 'function') { return envelope(1, '', 'unknown-route:' + name); }", '')],
  ['把超时结果改成成功', codeEntry.replace("resolve(envelope(1, '', 'timeout'));", "resolve(envelope(0, '', 'late'));")],
  ['去掉幂等守卫（unknown id 也报完成）', codeEntry.replace('if (!entry) { return false; }', 'if (!entry) { return true; }')],
  ['破坏取消语义（返回空串）', codeEntry.replace("cancelled ? 'null' : path", 'path')],
  ['去掉同源闸门', codeEntry.replace("if (!originAllowed()) { return envelope(1, '', 'origin-denied'); }", '')],
];
let ok = baseline.length === 0;
for (const [label, mutated] of mutations) {
  let failed = 0;
  try {
    failed = (await runSuite(mutated)).length;
  } catch (e) {
    failed = 1; /* 变异体直接跑不起来也算判红 */
  }
  const red = failed > 0;
  console.log(`  ${red ? '✅' : '❌'} ${label} ⇒ ${red ? `判红（${failed} 处）` : '未判红（门禁没牙）'}`);
  if (!red) ok = false;
}
console.log(ok ? '\n✅ 自检通过。' : '\n❌ 自检失败。');
process.exit(ok ? 0 : 3);
