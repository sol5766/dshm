#!/usr/bin/env node
/**
 * Python 桥异步化门禁（2026-10-19，LOOP-GAP 根因二，见 docs/200）。
 *
 * ## 为什么需要它
 *
 * 内测日志（`dist/triage/2026-10-19/logs1019/.../node-output.log`）里三处超长事件循环停顿：
 *
 *   `LOOP-GAP 800711ms` / `LOOP-GAP 522814ms` / `LOOP-GAP 33277ms`
 *
 * 每一处前面都紧跟一条 `IN-REQ GET /dshm-python/run-get?...pip._internal.cli.main…`。
 * 旧实现是 HTTP 端点在**主线程**同步调 `bridge.captureRun(code)` —— pip 装一个包几十秒到
 * 十几分钟，这段时间整个 Host 的事件循环（心跳 / Web / 会话 / 停止通道）全部停摆。
 * 修法是把 Python 的执行搬进 worker 线程（`hostcore/app/python-worker.cjs`）。
 *
 * **这类回归不会让任何构建失败**：`captureRun` 依然"能跑"，只是又把主线程挡住而已。
 * 而它的症状（LOOP-GAP）只在真机长任务下出现，所以必须在离线门禁里把"执行线程位置"、
 * "超时到底是 terminate 还是干等"、"失败会不会被静默吞成空成功"逐条钉住。
 *
 * ## 判据（A~E 段，全部离线，不需要真 Python / 不需要真机）
 *
 *   A 协议面（静态）：两个模块的 `PROTOCOL_VERSION` 一致；run/result/error 帧字段齐备；
 *     worker 是**唯一默认加载 addon 并执行 Python** 的地方（主线程那份 dlopen 必须被
 *     `DSHM_PY_INLINE` 判定包住）；worker 的 result 帧把 `errStderr` 映射成协议里的 `stderr`。
 *   B 主线程零同步调用（静态）：`main.js` 里 `.captureRun(` 只允许出现在两个**降级分支**
 *     函数里（`ensurePythonBridgeInline` / `pyBridgeRun`），且 `pyBridgeRun` 的**默认分支**
 *     （`} else {` 之后那段）必须是 `await getPyWorkerBridge().run(...)`，一个 `captureRun` 都不许有；
 *     两个执行端点必须 `await pyBridgeRun(...)`；"取消"必须是 `terminate`，不许再跑取消代码。
 *   C 开关面（行为）：`pyBridgeInlineEnabled()` 的真实实现——**未设 env 时必须 false（走 worker）**，
 *     `DSHM_PY_INLINE=1` 才 true；启动日志必须有一行 `python 桥：执行线程=worker（…可回退）`。
 *   D 行为面（假 worker 注入，不需要真 Python）：协议字段、单飞 + FIFO 排队、超时 terminate + 重建
 *     （rc 仍是 `"124"`）、worker 崩/报错/取消都必须回**明确错误**、status 形状不变且不会挂住。
 *   E 接线面：两份 FILES 清单（`place-host-app.mjs` / `assert-resfile-sync.mjs`）都要带两个新文件
 *     （漏了 = 端侧静默不生效：worker 文件漏了只在**首个 python 请求**才失败），CI workflow 也要有本门禁。
 *
 * ## 变异对照臂（`--self-test`，逐个必须判红）
 *
 *   1. 把 `captureRun` 放回**默认分支**（等于没修）⇒ B 段必须红；
 *   2. 超时只回结果、不 `terminate` ⇒ D 段"超时必须 terminate"必须红；
 *   3. 排队用 `queue.pop()`（LIFO，乱序）⇒ D 段 FIFO 必须红；
 *   4. worker 报错被静默成 `{ok:true}`（空成功）⇒ D 段"必须明确失败"必须红；
 *   5. 降级开关默认翻转（没设 env 也走主线程）⇒ C 段必须红；
 *   6. worker 的 result 帧不再映射 `stderr`（吞掉 stderr）⇒ A 段必须红。
 *
 * 用法：
 *   node tools/check-python-async-worker.mjs
 *   node tools/check-python-async-worker.mjs --self-test
 *
 * 退出码：0 全过 / 1 有红项（含变异臂没有被判红的情形）。
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireCjs = createRequire(import.meta.url);

const P_MAIN = join(ROOT, 'hostcore', 'app', 'main.js');
const P_WORKER = join(ROOT, 'hostcore', 'app', 'python-worker.cjs');
const P_BRIDGE = join(ROOT, 'hostcore', 'app', 'python-bridge-async.cjs');
const P_PLACE = join(ROOT, 'tools', 'place-host-app.mjs');
const P_SYNC = join(ROOT, 'tools', 'assert-resfile-sync.mjs');
const P_GATES = join(ROOT, '.github', 'workflows', 'gates.yml');

const MAIN = readFileSync(P_MAIN, 'utf8');
const WORKER = readFileSync(P_WORKER, 'utf8');
const BRIDGE = readFileSync(P_BRIDGE, 'utf8');
const PLACE = readFileSync(P_PLACE, 'utf8');
const SYNC = readFileSync(P_SYNC, 'utf8');
const GATES = readFileSync(P_GATES, 'utf8');

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`ok   ${name}${detail.length > 0 ? `（${detail}）` : ''}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}${detail.length > 0 ? `（${detail}）` : ''}`);
  }
}

/* ── 静态面工具 ─────────────────────────────────────────────────────────── */

/** 出现次数（字面量计数，不用正则以免被特殊字符咬）。 */
function countOf(text, needle) {
  if (needle.length === 0) return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const at = text.indexOf(needle, i);
    if (at < 0) return n;
    n += 1;
    i = at + needle.length;
  }
}

/**
 * 只剥注释、**保留字符串字面量**。
 *
 * 【为什么不剥字符串】本门禁要判的是"代码里有没有那个调用"，而字符串只要不掺和结构判断就没影响；
 * 反过来整段抹掉字符串会把模板串里的 `${…}` 弄坏（`docs/200` 同族的 check-dead-code 踩过）。
 * 【为什么必须剥注释】`main.js` 的注释里**故意**引用了 `bridge.captureRun(` 这个写法（解释降级分支），
 * 不剥就会把它当成真实调用 ⇒ 判据假红。
 */
function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < n) {
        if (text[i] === '\\') { out += text.slice(i, i + 2); i += 2; continue; }
        out += text[i];
        if (text[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 找出所有**顶层**函数声明（行首 `function` / `async function`）。
 * 仓里 main.js 的顶层函数一律顶格写，所以这个判定足够稳；返回 [{name, start}]。
 */
function topLevelFunctions(text) {
  const out = [];
  const re = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ name: m[1], start: m.index });
  return out;
}

/** 某个下标归属哪个顶层函数（= 它之前最近的顶层函数声明）。 */
function enclosingFunction(funcs, index) {
  let found = null;
  for (const f of funcs) {
    if (f.start <= index) found = f; else break;
  }
  return found === null ? null : found.name;
}

/** 取顶层函数体文本（从声明到**顶格**的收尾 `}`）。 */
function functionBody(text, name) {
  const funcs = topLevelFunctions(text);
  const idx = funcs.findIndex((f) => f.name === name);
  if (idx < 0) return '';
  const start = funcs[idx].start;
  const endMarker = text.indexOf('\n}\n', start);
  if (endMarker < 0) return '';
  return text.slice(start, endMarker + 3);
}

/** 断言：某段文本里唯一的 `.captureRun(` 都落在允许的函数里，且那些函数带 DSHM_PY_INLINE 判定。 */
function inspectMainThreadSyncCalls(main) {
  const funcs = topLevelFunctions(main);
  const allowed = new Set(['ensurePythonBridgeInline', 'pyBridgeRun']);
  const hits = [];
  let i = 0;
  for (;;) {
    const at = main.indexOf('.captureRun(', i);
    if (at < 0) break;
    hits.push({ at, fn: enclosingFunction(funcs, at) });
    i = at + 1;
  }
  const illegal = hits.filter((h) => h.fn === null || !allowed.has(h.fn));
  return { hits, illegal, funcs };
}

/** main.js 里"默认分支"那一段文本（`pyBridgeRun` 的 `} else {` 到诊断块之间）。 */
function defaultBranchOf(main) {
  const anchor = 'const prelude = pyBridgePrelude(timeoutSec);';
  const from = main.indexOf(anchor);
  if (from < 0) return null;
  const elseAt = main.indexOf('} else {', from);
  if (elseAt < 0) return null;
  const end = main.indexOf('try {\n    const outBytes', elseAt);
  if (end < 0) return null;
  return main.slice(elseAt, end);
}

/** 提取 `pyBridgeInlineEnabled()` 的真实实现并在隔离作用域里跑（验默认值）。 */
function pyInlineSwitch(main) {
  const start = main.indexOf('function pyBridgeInlineEnabled() {');
  if (start < 0) return null;
  const end = main.indexOf('\n}', start);
  if (end < 0) return null;
  const src = main.slice(start, end + 2);
  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function('process', `${src}\nreturn pyBridgeInlineEnabled;`);
    return factory;
  } catch (e) {
    return null;
  }
}

/* ── A 段：协议面（静态） ───────────────────────────────────────────────── */

function staticChecks(src) {
  const out = [];
  const add = (name, ok, detail = '') => out.push({ name, ok, detail });
  const main = src.main;
  /* 判结构的东西一律在"剥注释 + 统一 LF"的文本上做：仓里是 CRLF，而注释里**故意**引用了
     `bridge.captureRun(` / `process.dlopen` 这些写法（用来解释降级分支），不剥就会假红。 */
  const mainCode = stripComments(main).replace(/\r\n/g, '\n');
  const worker = src.worker;
  const bridge = src.bridge;
  const bridgeCode = stripComments(bridge);

  const workerVersion = /const PROTOCOL_VERSION = (\d+);/.exec(worker);
  const bridgeVersion = /const PROTOCOL_VERSION = (\d+);/.exec(bridge);
  add('A1 协议版本：worker 与主线程桥的 PROTOCOL_VERSION 一致（改一边必须改另一边）',
    workerVersion !== null && bridgeVersion !== null && workerVersion[1] === bridgeVersion[1],
    `worker=${workerVersion ? workerVersion[1] : '?'} bridge=${bridgeVersion ? bridgeVersion[1] : '?'}`);

  add('A2 协议字段：run 帧带 type/id/code/timeoutMs，result 帧带 id/ok/stdout/stderr/rc',
    worker.includes("type: 'result'")
      && bridge.includes("type: 'run'")
      && bridge.includes('id: task.id, code: task.code, timeoutMs: task.timeoutMs')
      && worker.includes('stdout: typeof r.stdout')
      && worker.includes('rc: r.rc === undefined')
      && worker.includes('id: id'),
    'run/result 的字段名必须两边逐字一致（否则静默丢帧）');

  add('A3 worker：唯一默认的执行点 —— addon 通过 process.dlopen 在 worker 里加载',
    countOf(worker, 'process.dlopen(') === 1 && worker.includes('DSHM_PYTHON_LIB') && worker.includes('DSHM_PYTHON_HOME'),
    `dlopen 次数=${countOf(worker, 'process.dlopen(')}`);

  add('A4 worker：env 必须在 dlopen **之前**设好（addon 的 EnsurePythonInit 读它）',
    worker.indexOf('DSHM_PYTHON_LIB = libPath') >= 0
      && worker.indexOf('DSHM_PYTHON_LIB = libPath') < worker.indexOf('process.dlopen('));

  const mainFuncs = topLevelFunctions(mainCode);
  const dlopenAt = mainCode.indexOf('process.dlopen(mod, addon)');
  add('A5 主线程：python addon 的 dlopen 只在 getPyBridge（且该函数带 DSHM_PY_INLINE 判定）—— 默认不加载',
    dlopenAt >= 0
      && enclosingFunction(mainFuncs, dlopenAt) === 'getPyBridge'
      && functionBody(mainCode, 'getPyBridge').includes('pyBridgeInlineEnabled()'),
    `python addon dlopen 次数=${countOf(mainCode, 'process.dlopen(mod, addon)')}（只允许降级分支这 1 处）`);

  add('A6 worker：result 帧把 addon 的 errStderr 映射成协议里的 stderr（不漏 stderr）',
    worker.includes('stderr: typeof r.errStderr === \'string\' ? r.errStderr : \'\''),
    '映射在 toResultFrame()；漏了就是"python 跑出 stderr 但上层看不见"');

  add('A7 worker：itimer 清理与执行同侧（epilogue 里 runString 清 ITIMER_REAL）',
    worker.includes("runString('try:\\n    import signal\\n    signal.setitimer(signal.ITIMER_REAL, 0)"),
    'pending alarm 不清会误杀下一个请求（2026-09-22 真机教训）');

  add('A8 worker：未捕获异常也要回 error 帧（不许静默死掉）',
    worker.includes("process.on('uncaughtException'") && worker.includes("type: 'error'", worker.indexOf("process.on('uncaughtException'")));

  add('A9 主线程桥：不含 process.dlopen（主线程侧零加载）',
    countOf(bridgeCode, 'process.dlopen(') === 0);
  add('A10 主线程桥：不含 captureRun（执行全在 worker）',
    countOf(bridgeCode, 'captureRun') === 0);

  return out;
}

/* ── B 段：主线程零同步调用（静态） ─────────────────────────────────────── */

function syncCallChecks(rawMain) {
  const out = [];
  const add = (name, ok, detail = '') => out.push({ name, ok, detail });
  /* 剥注释 + 统一 LF（仓里是 CRLF；结构锚点里带 `\n`，不统一就永远找不到）。 */
  const main = stripComments(rawMain).replace(/\r\n/g, '\n');

  const inspected = inspectMainThreadSyncCalls(main);
  add('B1 main.js：`.captureRun(` 只出现在两个降级分支函数里（默认路径零同步调用）',
    inspected.hits.length === 2 && inspected.illegal.length === 0,
    `命中 ${inspected.hits.length} 处：${inspected.hits.map((h) => h.fn || '（顶层）').join(' / ')}`
      + (inspected.illegal.length > 0 ? `；越界：${inspected.illegal.map((h) => h.fn || '顶层').join(',')}` : ''));

  add('B2 main.js：`ensurePythonBridgeInline()` 的 captureRun 落在 DSHM_PY_INLINE 判定之内',
    functionBody(main, 'ensurePythonBridgeInline').includes('pyBridgeInlineEnabled()')
      && countOf(functionBody(main, 'ensurePythonBridgeInline'), '.captureRun(') >= 1);

  const branch = defaultBranchOf(main);
  add('B3 main.js：pyBridgeRun 的**默认分支**只有 `await getPyWorkerBridge().run(...)`，没有 captureRun',
    branch !== null
      && branch.includes('await getPyWorkerBridge().run(')
      && !branch.includes('captureRun('),
    branch === null ? '找不到默认分支锚点（pyBridgeRun 结构被改坏了？）' : '');

  add('B4 main.js：`pyBridgeRun` 是 async，且降级分支写在 `if (inlineMode)` 里',
    /async function pyBridgeRun\(code, timeoutSec\) \{/.test(main)
      && main.includes('const inlineMode = pyBridgeInlineEnabled();')
      && main.includes('if (inlineMode) {'));

  add('B5 main.js：两个执行端点都 `await pyBridgeRun(...)`（少一个 await 就等于没搬走）',
    countOf(main, 'pyBridgeSendJson(response, 200, await pyBridgeRun(') === 2
      && countOf(main, 'pyBridgeSendJson(response, 200, pyBridgeRun(') === 0,
    `await 版=${countOf(main, 'pyBridgeSendJson(response, 200, await pyBridgeRun(')}`);

  add('B6 main.js：self-test 与降级分支里没有"别的"同步执行口（`bridge.runString` 只用于清 itimer）',
    countOf(main, 'bridge.runString(') === 1
      && main.includes("signal.setitimer(signal.ITIMER_REAL, 0)"),
    `bridge.runString 次数=${countOf(main, 'bridge.runString(')}`);

  add('B7 main.js：itimer 清理只在 inline 分支里跑（默认分支由 worker 的 epilogue 清）',
    (() => {
      const at = main.indexOf("bridge.runString('try:\\n    import signal");
      if (at < 0) return false;
      const before = main.slice(Math.max(0, at - 400), at);
      return before.includes('if (inlineMode) {');
    })());

  add('B8 main.js：取消路径 = terminate（requestStop 里调 python worker 的 shutdown）',
    main.includes('pyWorkerBridge.shutdown(')
      && main.includes('python worker：停止时取消了'),
    '"取消"跑一段 Python 停不掉正在跑的任务');

  add('B9 main.js：worker 脚本路径与会话同目录（resfile 里必须带这个文件）',
    main.includes("workerScript: path.join(__dirname, 'python-worker.cjs')"));

  add('B10 main.js：顶层 require 了异步桥（漏掉 = Host 起不来，而不是悄悄退化）',
    main.includes("const pythonBridgeAsync = require('./python-bridge-async.cjs');"));

  return out;
}

/* ── C 段：降级开关与启动日志 ───────────────────────────────────────────── */

function switchChecks(main) {
  const out = [];
  const add = (name, ok, detail = '') => out.push({ name, ok, detail });

  add('C1 启动日志：默认那一行必须是"执行线程=worker（DSHM_PY_INLINE=1 可回退）"',
    main.includes('python 桥：执行线程=worker（DSHM_PY_INLINE=1 可回退）'),
    '真机验收就 grep 这一行');

  const factory = pyInlineSwitch(main);
  if (factory === null) {
    add('C2 开关默认值：pyBridgeInlineEnabled() 可被解析并在隔离作用域里求值', false);
    return out;
  }
  const call = (env) => factory({ env }).call(null);
  const unset = call({});
  const one = call({ DSHM_PY_INLINE: '1' });
  const zero = call({ DSHM_PY_INLINE: '0' });
  const padded = call({ DSHM_PY_INLINE: ' 1 ' });
  add('C2 开关默认值：未设 env ⇒ false（走 worker）；=1 ⇒ true；=0 ⇒ false；" 1 " 也认',
    unset === false && one === true && zero === false && padded === true,
    JSON.stringify({ unset, one, zero, padded }));

  return out;
}

/* ── D 段：行为（假 worker 注入） ───────────────────────────────────────── */

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** 可注入的假 worker：只实现主线程桥用到的那几个方法（on/postMessage/terminate/unref）。 */
class FakeWorker extends EventEmitter {
  constructor(script, options, plan) {
    super();
    this.script = script;
    this.options = options;
    this.plan = plan;
    this.posted = [];
    this.terminated = false;
    this.unrefed = false;
    this.setMaxListeners(50);
  }

  postMessage(msg) {
    this.posted.push(msg);
    this.plan(this, msg);
  }

  terminate() {
    this.terminated = true;
    return Promise.resolve(0);
  }

  unref() {
    this.unrefed = true;
    return this;
  }
}

function fakeFactory(workers, plan) {
  return (script, options) => {
    const w = new FakeWorker(script, options, plan);
    workers.push(w);
    return w;
  };
}

const runPlans = {
  /** 立刻正常回一帧 result。 */
  autoReply: (w, msg) => {
    if (msg.type === 'run') {
      setTimeout(() => w.emit('message', {
        type: 'result', id: msg.id, ok: true, stdout: `out:${msg.code}`, stderr: 'err', rc: 'None',
      }), 0);
    }
  },
  /** 什么也不回（用于超时/取消/排队臂）。 */
  silent: () => {},
};

async function behaviorChecks(modBridge) {
  const out = [];
  const add = (name, ok, detail = '') => out.push({ name, ok, detail });

  /* D1 协议字段 + 结果映射 */
  {
    const workers = [];
    const bridge = modBridge.create({
      workerScript: 'fake-worker.cjs', spawnWorker: fakeFactory(workers, runPlans.autoReply),
      diag: () => {}, watchdogMarginMs: 20, startupTimeoutMs: 200,
    });
    const r = await bridge.run({ code: 'print(1)', timeoutMs: 5000 });
    const msg = workers.length === 1 ? workers[0].posted.find((m) => m.type === 'run') : null;
    add('D1 run 帧字段（type/id/code/timeoutMs）与 result 映射（stdout/stderr/rc）',
      msg !== null && msg.type === 'run' && typeof msg.id === 'number'
        && msg.code === 'print(1)' && msg.timeoutMs === 5000
        && r.ok === true && r.stdout === 'out:print(1)' && r.errStderr === 'err' && r.rc === 'None',
      JSON.stringify({ msg, r }));
    await bridge.shutdown('gate');
  }

  /* D2/D3/D4 单飞 + FIFO + 结果顺序 */
  {
    const workers = [];
    const bridge = modBridge.create({
      workerScript: 'fake-worker.cjs', spawnWorker: fakeFactory(workers, runPlans.silent),
      diag: () => {}, watchdogMarginMs: 5000, startupTimeoutMs: 200,
    });
    const p1 = bridge.run({ code: 'A', timeoutMs: 30000 });
    const p2 = bridge.run({ code: 'B', timeoutMs: 30000 });
    const p3 = bridge.run({ code: 'C', timeoutMs: 30000 });
    await tick();
    const runs = () => workers.flatMap((w) => w.posted.filter((m) => m.type === 'run'));
    add('D2 单飞：同一时刻只投递 1 个任务（其余排队）', runs().length === 1, `已投递 ${runs().length} 个`);
    workers[0].emit('message', { type: 'result', id: runs()[0].id, ok: true, stdout: 'A', stderr: '', rc: 'None' });
    await tick();
    add('D3 排队：上一个完成后才投递下一个（FIFO 而不是一次全发）',
      runs().length === 2 && runs()[1].code === 'B',
      `已投递 ${runs().map((m) => m.code).join(',')}`);
    workers[0].emit('message', { type: 'result', id: runs()[1].id, ok: true, stdout: 'B', stderr: '', rc: 'None' });
    await tick();
    workers[0].emit('message', { type: 'result', id: runs()[2].id, ok: true, stdout: 'C', stderr: '', rc: 'None' });
    const rs = await Promise.all([p1, p2, p3]);
    add('D4 排队顺序：结果按提交顺序返回（A,B,C），不串号',
      rs.map((x) => x.stdout).join(',') === 'A,B,C',
      rs.map((x) => x.stdout).join(','));
    await bridge.shutdown('gate');
  }

  /* D5/D6 超时 = terminate + 重建，rc 口径仍是 "124" */
  {
    const workers = [];
    const bridge = modBridge.create({
      workerScript: 'fake-worker.cjs', spawnWorker: fakeFactory(workers, runPlans.silent),
      diag: () => {}, watchdogMarginMs: 10, startupTimeoutMs: 50,
    });
    const r = await bridge.run({ code: 'hang', timeoutMs: 1000 });
    add('D5 超时：必须 terminate 当前 worker，rc 仍是 "124"、timedOut 显式（不是空成功、也不是干等）',
      workers.length === 1 && workers[0].terminated === true
        && r.ok === false && r.rc === '124' && r.timedOut === true
        && String(r.error).includes('超时'),
      JSON.stringify({ terminated: workers[0] && workers[0].terminated, r }));
    const p2 = bridge.run({ code: 'after', timeoutMs: 30000 });
    await tick();
    add('D6 超时后重建：下个任务起新 worker（解释器随线程重建），旧的不复用',
      workers.length === 2 && workers[1].posted.filter((m) => m.type === 'run').length === 1,
      `worker 数=${workers.length}`);
    workers[1].emit('message', { type: 'result', id: workers[1].posted[0].id, ok: true, stdout: '', stderr: '', rc: '0' });
    await p2;
    await bridge.shutdown('gate');
  }

  /* D7 worker 崩溃 ⇒ 明确错误 */
  {
    const workers = [];
    const bridge = modBridge.create({
      workerScript: 'fake-worker.cjs',
      spawnWorker: fakeFactory(workers, (w, msg) => {
        if (msg.type === 'run') setTimeout(() => w.emit('exit', 3), 0);
      }),
      diag: () => {}, watchdogMarginMs: 5000, startupTimeoutMs: 50,
    });
    const r = await bridge.run({ code: 'x', timeoutMs: 30000 });
    add('D7 worker 退出（崩溃）：在飞任务回明确错误，绝不静默空成功',
      r.ok === false && typeof r.error === 'string' && r.error.length > 0 && !('timedOut' in r && r.timedOut === true),
      JSON.stringify(r));
    await bridge.shutdown('gate');
  }

  /* D8 worker 回 error 帧 ⇒ 明确失败 */
  {
    const workers = [];
    const bridge = modBridge.create({
      workerScript: 'fake-worker.cjs',
      spawnWorker: fakeFactory(workers, (w, msg) => {
        if (msg.type === 'run') {
          setTimeout(() => w.emit('message', { type: 'error', id: msg.id, message: 'addon 加载失败' }), 0);
        }
      }),
      diag: () => {}, watchdogMarginMs: 5000, startupTimeoutMs: 50,
    });
    const r = await bridge.run({ code: 'x', timeoutMs: 30000 });
    add('D8 worker error 帧：回明确失败（带原因），不是空成功',
      r.ok === false && String(r.error).includes('addon 加载失败'),
      JSON.stringify(r));
    await bridge.shutdown('gate');
  }

  /* D9 取消 = terminate + 明确取消（在飞与排队都算） */
  {
    const workers = [];
    const bridge = modBridge.create({
      workerScript: 'fake-worker.cjs', spawnWorker: fakeFactory(workers, runPlans.silent),
      diag: () => {}, watchdogMarginMs: 5000, startupTimeoutMs: 50,
    });
    const p1 = bridge.run({ code: 'running', timeoutMs: 30000 });
    const p2 = bridge.run({ code: 'queued', timeoutMs: 30000 });
    await tick();
    const n = bridge.cancel('gate');
    const r1 = await p1;
    const r2 = await p2;
    add('D9 取消：terminate 当前任务并把排队项一并回明确取消（cancelled:true）',
      n === 2 && workers[0].terminated === true
        && r1.ok === false && r1.cancelled === true
        && r2.ok === false && r2.cancelled === true,
      JSON.stringify({ n, terminated: workers[0].terminated, r1, r2 }));
    await bridge.shutdown('gate');
  }

  /* D10 status 形状不变 */
  {
    const workers = [];
    const bridge = modBridge.create({
      workerScript: 'fake-worker.cjs',
      spawnWorker: fakeFactory(workers, (w, msg) => {
        if (msg.type === 'status') {
          setTimeout(() => w.emit('message', {
            type: 'status', id: msg.id, bridge: true, ready: true, initialized: false,
          }), 0);
        }
      }),
      diag: () => {}, watchdogMarginMs: 20, startupTimeoutMs: 200,
    });
    const st = await bridge.status();
    add('D10 status：字段形状仍是 {bridge, ready, initialized}（HTTP 契约不变）',
      st.bridge === true && st.ready === true && st.initialized === false,
      JSON.stringify(st));
    await bridge.shutdown('gate');
  }

  /* D11 status 不会挂住 */
  {
    const workers = [];
    const bridge = modBridge.create({
      workerScript: 'fake-worker.cjs', spawnWorker: fakeFactory(workers, runPlans.silent),
      diag: () => {}, watchdogMarginMs: 20, startupTimeoutMs: 30,
    });
    const st = await bridge.status();
    add('D11 status 超时：回 bridge:false + 明确 error，绝不挂住 HTTP 端点',
      st.bridge === false && typeof st.error === 'string' && st.error.length > 0,
      JSON.stringify(st));
    await bridge.shutdown('gate');
  }

  /* D12 空 code / 关闭后调用：明确拒绝 */
  {
    const workers = [];
    const bridge = modBridge.create({
      workerScript: 'fake-worker.cjs', spawnWorker: fakeFactory(workers, runPlans.autoReply),
      diag: () => {}, watchdogMarginMs: 20, startupTimeoutMs: 50,
    });
    const empty = await bridge.run({ code: '', timeoutMs: 1000 });
    await bridge.shutdown('gate');
    const closed = await bridge.run({ code: 'x', timeoutMs: 1000 });
    add('D12 空 code / 桥已关闭 ⇒ 明确拒绝（不 spawn、不空成功）',
      empty.ok === false && String(empty.error).length > 0
        && closed.ok === false && String(closed.error).includes('已关闭')
        && workers.every((w) => w.posted.length === 0),
      JSON.stringify({ empty, closed }));
  }

  /* D13 真实 worker + 忙等：证明"Python 忙的时候主线程事件循环还在转"（这条就是 LOOP-GAP 的正面判据） */
  {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-py-busy-'));
    const workerPath = join(dir, 'fake-python-worker.cjs');
    writeFileSync(workerPath, [
      "const { parentPort } = require('node:worker_threads');",
      "parentPort.on('message', (msg) => {",
      "  if (msg.type !== 'run') { return; }",
      '  const t0 = Date.now();',
      '  // 模拟 Python 在 worker 里跑 700ms（旧实现这段是在**主线程**里跑的）',
      '  while (Date.now() - t0 < 700) { /* busy */ }',
      "  parentPort.postMessage({ type: 'result', id: msg.id, ok: true, stdout: 'busy-done', stderr: '', rc: 'None' });",
      '});',
      '',
    ].join('\n'), 'utf8');
    const bridge = modBridge.create({ workerScript: workerPath, diag: () => {}, watchdogMarginMs: 5000 });
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 50);
    const r = await bridge.run({ code: 'busy', timeoutMs: 30000 });
    clearInterval(ticker);
    await bridge.shutdown('gate');
    rmSync(dir, { recursive: true, force: true });
    add('D13 事件循环不被挡：worker 里忙等 700ms 期间，主线程 50ms 定时器照常跳（LOOP-GAP 的正面判据）',
      r.ok === true && r.stdout === 'busy-done' && ticks >= 3,
      `ticks=${ticks}`);
  }

  return out;
}

/* ── E 段：接线（打包清单 / CI） ────────────────────────────────────────── */

function wiringChecks() {
  const out = [];
  const add = (name, ok, detail = '') => out.push({ name, ok, detail });
  add('E1 place-host-app FILES 带 python-worker.cjs 与 python-bridge-async.cjs',
    PLACE.includes("'python-worker.cjs'") && PLACE.includes("'python-bridge-async.cjs'"));
  add('E2 assert-resfile-sync FILES 也带这两个文件（两份清单必须同步）',
    SYNC.includes("'python-worker.cjs'") && SYNC.includes("'python-bridge-async.cjs'"));
  add('E3 CI workflow 跑本门禁（6 空格 - name: / 8 空格 run:）',
    /\n {6}- name: [^\n]*check-python-async-worker[^\n]*\n(?: {8}if: [^\n]*\n)? {8}run: node tools\/check-python-async-worker\.mjs(\s|$)/.test(GATES),
    'gates.yml 里必须有一模一样的一步');
  return out;
}

/* ── 主流程 ─────────────────────────────────────────────────────────────── */

async function main() {
  const selfTest = process.argv.includes('--self-test');
  console.log('# Python 桥异步化门禁（worker 线程执行 / 主线程零同步调用）\n');

  /*
   * 【为什么在主流程里挂一个 ref 的 interval】主线程桥的看门狗 timer 是 `unref()` 的 —— 生产里
   * 事件循环由 HTTP 服务撑着，而离线门禁里只有假 worker（零真实句柄）⇒ 等超时那一刻 Node 会认为
   * loop 已排空并直接退出（表现为 "unsettled top-level await"）。这个 interval 只是"宿主还活着"
   * 的替身，**不参与任何判据**，结束时清掉。
   */
  const keepAlive = setInterval(() => {}, 1000);

  const statics = [
    ...staticChecks({ main: MAIN, worker: WORKER, bridge: BRIDGE }),
    ...syncCallChecks(MAIN),
    ...switchChecks(MAIN),
    ...wiringChecks(),
  ];
  for (const c of statics) check(c.name, c.ok, c.detail);

  const bridgeMod = requireCjs(P_BRIDGE);
  const behaviors = await behaviorChecks(bridgeMod);
  for (const c of behaviors) check(c.name, c.ok, c.detail);

  console.log(`\n结果：${passed} 通过 / ${failures.length} 失败`);

  if (selfTest) {
    console.log('\n# 变异对照臂（每个都必须判红，否则判据是摆设）\n');
    let armFailed = 0;
    let armPassed = 0;
    const armOut = (name, ok, detail) => {
      if (ok) { armPassed += 1; console.log(`ok   ${name}${detail ? `（${detail}）` : ''}`); }
      else { armFailed += 1; console.log(`FAIL ${name}${detail ? `（${detail}）` : ''}`); }
    };

    const tmp = mkdtempSync(join(tmpdir(), 'dshm-py-async-arms-'));
    const writeCjs = (name, text) => {
      const p = join(tmp, name);
      writeFileSync(p, text, 'utf8');
      return p;
    };
    const names = (arr) => arr.filter((c) => !c.ok).map((c) => c.name);

    try {
      /* ── 臂 1：把 captureRun 放回默认分支（等于没修） ── */
      {
        const mutant = MAIN.replace(
          "      r = await getPyWorkerBridge().run({ code: prelude + code, timeoutMs: timeoutSec * 1000, label: 'run' });",
          '      r = getPyBridge().captureRun(prelude + code);',
        );
        armOut('臂1 锚点存在（把 captureRun 放回默认分支）', mutant !== MAIN);
        const got = syncCallChecks(mutant).filter((c) => !c.ok);
        armOut('臂1 必须判红：默认分支出现 captureRun / captureRun 越界',
          got.length > 0, got.map((c) => c.name).join(' | ') || '竟然全绿 ⇒ 判据没有牙');
      }

      /* ── 臂 2：超时不 terminate ── */
      {
        const anchor = 'killWorker(`超时 ${task.timeoutMs}ms`);';
        const mutant = BRIDGE.replace(anchor, '/* 变异体：不 terminate */');
        armOut('臂2 锚点存在（超时分支去掉 terminate）', mutant !== BRIDGE);
        const mod = requireCjs(writeCjs('bridge-arm2.cjs', mutant));
        const workers = [];
        const bridge = mod.create({
          workerScript: 'fake-worker.cjs', spawnWorker: fakeFactory(workers, runPlans.silent),
          diag: () => {}, watchdogMarginMs: 10, startupTimeoutMs: 50,
        });
        const r = await bridge.run({ code: 'hang', timeoutMs: 1000 });
        /* 必须在 shutdown 之前读 terminated：shutdown 自己也会 terminate（会掩盖变异体） */
        const terminated = workers.length > 0 && workers[0].terminated === true;
        await bridge.shutdown('gate');
        armOut('臂2 必须判红：超时没有 terminate 当前 worker',
          terminated === false && r.timedOut === true,
          `terminated=${terminated}`);
      }

      /* ── 臂 3：排队乱序（LIFO） ── */
      {
        const mutant = BRIDGE.replace('const task = queue.shift();', 'const task = queue.pop();');
        armOut('臂3 锚点存在（排队改 LIFO）', mutant !== BRIDGE);
        const mod = requireCjs(writeCjs('bridge-arm3.cjs', mutant));
        const workers = [];
        const bridge = mod.create({
          workerScript: 'fake-worker.cjs', spawnWorker: fakeFactory(workers, runPlans.silent),
          diag: () => {}, watchdogMarginMs: 5000, startupTimeoutMs: 50,
        });
        const p1 = bridge.run({ code: 'A', timeoutMs: 30000 });
        const p2 = bridge.run({ code: 'B', timeoutMs: 30000 });
        const p3 = bridge.run({ code: 'C', timeoutMs: 30000 });
        await tick();
        const runs = () => workers.flatMap((w) => w.posted.filter((m) => m.type === 'run'));
        /* 记录**投递顺序**（不是"哪个 promise 拿回什么"）：LIFO 变异的可观测差异在这里 */
        const order = [];
        for (let i = 0; i < 3; i++) {
          for (const m of runs()) {
            if (!order.includes(m.code)) order.push(m.code);
          }
          if (runs().length <= i) break;
          workers[0].emit('message', {
            type: 'result', id: runs()[i].id, ok: true, stdout: runs()[i].code, stderr: '', rc: 'None',
          });
          await tick();
        }
        const rs = await Promise.all([p1, p2, p3]);
        await bridge.shutdown('gate');
        armOut('臂3 必须判红：排队改成 LIFO ⇒ 投递顺序不再是 A,B,C',
          order.join(',') !== 'A,B,C', `投递顺序=${order.join(',')}；结果=${rs.map((x) => x.stdout).join(',')}`);
      }

      /* ── 臂 4：worker error 帧被静默成空成功 ── */
      {
        const anchor = "      finishCurrent({ ok: false, error: `python worker：${message}` });";
        const mutant = BRIDGE.replace(anchor, "      finishCurrent({ ok: true, stdout: '' });");
        armOut('臂4 锚点存在（error 帧静默成 ok:true）', mutant !== BRIDGE);
        const mod = requireCjs(writeCjs('bridge-arm4.cjs', mutant));
        const workers = [];
        const bridge = mod.create({
          workerScript: 'fake-worker.cjs',
          spawnWorker: fakeFactory(workers, (w, msg) => {
            if (msg.type === 'run') {
              setTimeout(() => w.emit('message', { type: 'error', id: msg.id, message: 'boom' }), 0);
            }
          }),
          diag: () => {}, watchdogMarginMs: 5000, startupTimeoutMs: 50,
        });
        const r = await bridge.run({ code: 'x', timeoutMs: 30000 });
        await bridge.shutdown('gate');
        armOut('臂4 必须判红：worker 报错被当成功（空成功）', r.ok !== false, JSON.stringify(r));
      }

      /* ── 臂 5：降级开关默认翻转 ── */
      {
        const anchor = "  return String(process.env.DSHM_PY_INLINE || '').trim() === '1';";
        const mutant = MAIN.replace(anchor, '  return true;');
        armOut('臂5 锚点存在（开关默认翻转成内联）', mutant !== MAIN);
        const got = switchChecks(mutant).filter((c) => !c.ok);
        armOut('臂5 必须判红：没设 env 也走主线程（默认值判据）', got.length > 0,
          got.map((c) => c.name).join(' | ') || '竟然全绿');
      }

      /* ── 臂 6：worker 的 result 帧吞掉 stderr ── */
      {
        const anchor = "    stderr: typeof r.errStderr === 'string' ? r.errStderr : '',";
        const mutant = WORKER.replace(anchor, "    stderr: '',");
        armOut('臂6 锚点存在（result 帧不再映射 stderr）', mutant !== WORKER);
        const mod = requireCjs(writeCjs('worker-arm6.cjs', mutant));
        const frame = mod.toResultFrame({ ok: true, stdout: 'o', errStderr: 'E!', rc: 'None' }, 7);
        armOut('臂6 必须判红：toResultFrame 吞掉 stderr', frame.stderr !== 'E!', JSON.stringify(frame));
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    console.log(`\n变异臂：${armPassed} 通过 / ${armFailed} 失败`);
    if (armFailed > 0) {
      console.log('\n❌ 有变异臂没有被判红 —— 判据没有牙，不得据此判断"异步化没被改回去"。');
      process.exit(1);
    }
    if (failures.length > 0) {
      console.log('\n失败项：');
      for (const name of failures) console.log(`  · ${name}`);
      process.exit(1);
    }
    console.log('\n✅ 门禁 + 6 个变异臂全部符合预期。');
    clearInterval(keepAlive);
    return;
  }

  if (failures.length > 0) {
    console.log('\n失败项：');
    for (const name of failures) console.log(`  · ${name}`);
    console.log('\n处置：Python 的执行必须在 worker 线程里；主线程只排队/await。');
    console.log('      降级分支（DSHM_PY_INLINE=1）是唯一允许同步 captureRun 的地方，且必须被判定包住。');
    process.exit(1);
  }
  console.log('\n✅ 通过：执行线程=worker、主线程零同步调用、超时 terminate、失败不静默、status 形状不变。');
  clearInterval(keepAlive);
}

await main();
