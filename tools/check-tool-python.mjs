#!/usr/bin/env node
/**
 * `dshm-tool-python` 门禁（2026-10-16，用户拍板「1 2 3 都做」第 3 件）。
 *
 * ## 为什么需要它
 *
 * 宿主侧那份内嵌 CPython 一直能跑（`/dshm-python/*` 桥），但模型**够不到**：
 * `bash` 走 guest VM（手机档受 1280 MiB 内存门槛 + guest 里没有 python3）、`/dshm-python/*`
 * 是回环端点而 `web_fetch` 按 SSRF 策略拒回环、`run_code` 上游停用。新插件把模型可见的
 * `python` 工具接到主进程内的桥 ⇒ 这条链一旦哪一环写错（token 读错文件、超时没 clamp、
 * 桥回 `ok:false` 被当成空输出），**表现都是"看起来能跑但没有结果"**，比报错难查得多。
 *
 * ## 它判什么
 *   · 静态面：包清单 / 注册形态（一个工具、名字 `python`）/ profile 的 insert 行 /
 *     pack-core 清单 / peer 版本与核心树运行版本一致（与 pack-core 的出包锁同一条规则）。
 *   · 行为面（真起一个回环 HTTP 桩 server，扮演宿主桥）：code 模式、file 模式的 argv 线格式、
 *     超时 clamp、rc 归一（`"None"` ⇒ 0）、`ok:false` / 401 / 读不到 host-ready.json 的错误映射、
 *     参数互斥与长度上限。
 *   · 负控制（`--self-test`）：两个变异体各自只改一处判据 ⇒ 对应断言必须红（否则判据是摆设）。
 *
 * 用法：
 *   node tools/check-tool-python.mjs
 *   node tools/check-tool-python.mjs --self-test
 */
import { createServer } from 'node:http';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const PLUGIN_DIR = join(ROOT, 'hostcore', 'plugins', 'dshm-tool-python');
const PLUGIN_SRC = readFileSync(join(PLUGIN_DIR, 'lib', 'index.js'), 'utf8');
const PLUGIN_PKG = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'));
const PROFILE = readFileSync(join(ROOT, 'hostcore', 'profile', 'ondevice', 'cordis.patch.yml'), 'utf8');
const PACK_CORE = readFileSync(join(ROOT, 'tools', 'pack-core.mjs'), 'utf8');
const RECIPE = JSON.parse(readFileSync(join(ROOT, 'hostcore', 'core-recipe.json'), 'utf8'));

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

/* ── 静态面 ─────────────────────────────────────────────────────────────── */
check('包清单：名字/入口/ESM 形态', PLUGIN_PKG.name === '@deepseek-ai/dshm-tool-python'
  && PLUGIN_PKG.main === 'lib/index.js' && PLUGIN_PKG.type === 'module');
const upstreamVersion = String(RECIPE.coreVersion).split('+')[0];
check('包清单：peer 钉法 == 核心树运行版本（与 pack-core 的出包锁同一条规则）',
  PLUGIN_PKG.peerDependencies?.['@deepseek-ai/dsh-tools'] === upstreamVersion,
  `peer=${PLUGIN_PKG.peerDependencies?.['@deepseek-ai/dsh-tools']} 运行版本=${upstreamVersion}`);
check('profile：部署层插入了 tool-python 行（与 tool-fs-remove 同形）',
  /* 该 yml 在本仓是 CRLF（Windows 工作区）⇒ 判据必须容忍两种换行，否则会假红。 */
  /- insert:\r?\n    - id: tool-python\r?\n      name: '@deepseek-ai\/dshm-tool-python'\r?\n/.test(PROFILE));
check('pack-core：DSHM_PLUGIN_PACKAGES 里有本插件',
  PACK_CORE.includes("{ name: '@deepseek-ai/dshm-tool-python', dir: 'dshm-tool-python' }"));
check('注册形态（静态）：声明并导出 inject = [\'tools\']（Cordis 的硬规则，真机 .53 就栽在这）',
  /const inject = \['tools'\];/.test(PLUGIN_SRC) && /export \{ apply, inject, name \};/.test(PLUGIN_SRC));

/* ── 行为的测试台：真起一个回环桩 server，扮演宿主桥 ─────────────────────── */
const TOKEN = 'token-for-gate';
let canned = { ok: true, stdout: '', errStderr: '', rc: 'None' };
let statusOverride = 0;
let lastUrl = '';
let cancelResponse = false;
const server = createServer((request, response) => {
  lastUrl = request.url;
  if (cancelResponse) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{');
    setImmediate(() => response.destroy());
    return;
  }
  const url = new URL(request.url, 'http://127.0.0.1');
  if (statusOverride !== 0) {
    response.writeHead(statusOverride, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: 'stub status override' }));
    return;
  }
  if (url.searchParams.get('token') !== TOKEN) {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: 'token required' }));
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(canned));
});
await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
const bridgeBase = `http://127.0.0.1:${server.address().port}`;

/** 把插件与一个 stub `@deepseek-ai/dsh-tools` 放进临时目录（bare import 才解析得到）。 */
function stagePlugin(sourceText) {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-tool-python-'));
  mkdirSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-tools'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0-gate', type: 'module', main: 'index.js' }), 'utf8');
  writeFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'index.js'),
    'export const defineTool = (definition) => definition;\n', 'utf8');
  writeFileSync(join(dir, 'index.js'), sourceText, 'utf8');
  return dir;
}

/** 造一份 host-ready.json（桥的 baseUrl/token 都从这里读）。 */
function makeHome(baseUrl, token) {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-tool-python-home-'));
  writeFileSync(join(dir, 'host-ready.json'),
    JSON.stringify({ url: `${baseUrl}/?token=${token}`, baseUrl, token, port: Number(new URL(baseUrl).port) }), 'utf8');
  return dir;
}

/** 载入插件并取回它注册的那个工具（apply 只做注册，可以直接抓）。 */
async function loadTool(stagedDir) {
  const module = await import(pathToFileURL(join(stagedDir, 'index.js')).href);
  /*
   * 复刻 Cordis 的注入规则：不声明 `inject: ['tools']` 就直接取 `ctx.tools` 会抛
   * `cannot get property "tools" without inject`（2026-10-16 真机 `.53` 的现场：
   * `include:tool-python enabled=True phase=failed`）。门禁自己也要认得这条，
   * 否则"注册成功"只在本机桩里成立、到设备上必炸。
   */
  const injected = Array.isArray(module.inject) ? module.inject : [];
  if (!injected.includes('tools')) {
    throw new Error('cannot get property "tools" without inject');
  }
  let captured = null;
  module.apply({ tools: { register(tool) { captured = tool; } } });
  if (captured === null) throw new Error('apply() 没有注册任何工具');
  return captured;
}

/**
 * 找出"没写显式 type"的字段（参数与输出两边都看）。
 *
 * 独立成函数是为了让 `--self-test` 能拿"改坏后的同一份源码"复算它 —— 否则这条判据
 * 是不是恒真就没人证。真机证据：`.54` 上 `exitCode` 没写 type ⇒ dsh-tools 的编译器
 * 直接拒，整行 `phase=failed`。
 */
function schemaTypeGaps(tool) {
  const gaps = [];
  for (const [group, dict] of [['parameters', tool.parameters ?? {}],
    ['output.schema.properties', tool.output?.schema?.properties ?? {}]]) {
    for (const [key, spec] of Object.entries(dict)) {
      if (typeof spec?.type !== 'string') {
        gaps.push(`${group}.${key}`);
      }
    }
  }
  return gaps;
}

async function requestBudgetChecks(tool, baseUrl, token) {
  const home = makeHome(baseUrl, token);
  const previousHome = process.env.DSHM_HOME;
  const originalGet = http.get;
  let requests = 0;
  http.get = function (...args) {
    requests += 1;
    return originalGet.apply(this, args);
  };
  process.env.DSHM_HOME = home;
  const results = [];
  try {
    for (const [label, args, allowed] of [
      ['Chinese/newlines', { code: '#\u4e2d\n'.repeat(800) }, false],
      ['encoded punctuation', { code: '#%&=+?\n'.repeat(600) }, false],
      ['file argv', { file: '/x.py', args: ['\u4e2d\n'.repeat(800)] }, false],
      ['path alias', { path: `/${'\u4e2d'.repeat(1000)}.py` }, false],
      ...[8191, 8192, 8193].flatMap((bytes) => {
        const codePrefix = new URL(`${baseUrl}/dshm-python/run-get?token=${encodeURIComponent(token)}&timeout=1&code=`);
        const filePrefix = new URL(`${baseUrl}/dshm-python/exec?token=${encodeURIComponent(token)}&timeout=300&argv=${encodeURIComponent('/x.py\u001f')}`);
        return [
          [`code boundary ${bytes}`, { code: 'x'.repeat(bytes - Buffer.byteLength(codePrefix.pathname + codePrefix.search)), timeoutSec: 1 }, bytes <= 8192],
          [`argv boundary ${bytes}`, { file: '/x.py', args: ['x'.repeat(bytes - Buffer.byteLength(filePrefix.pathname + filePrefix.search))], timeoutSec: 300 }, bytes <= 8192],
        ];
      }),
    ]) {
      const before = requests;
      let message = '';
      try {
        await tool.execute(args);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      results.push([label, allowed
        ? message === '' && requests === before + 1
        : requests === before && message.includes('8192') && message.includes('file')
          && !message.includes(token) && !message.includes(baseUrl) && !message.includes('?token=')]);
    }
    const before = requests;
    const value = await tool.execute({ code: 'pass' });
    results.push(['short call after rejection', requests === before + 1 && value.exitCode === 0]);
    return results;
  } finally {
    http.get = originalGet;
    if (previousHome === undefined) delete process.env.DSHM_HOME;
    else process.env.DSHM_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}

const cleanups = [server];
try {
  const staged = stagePlugin(PLUGIN_SRC);
  cleanups.push({ close: () => rmSync(staged, { recursive: true, force: true }) });
  const home = makeHome(bridgeBase, TOKEN);
  cleanups.push({ close: () => rmSync(home, { recursive: true, force: true }) });
  process.env.DSHM_HOME = home;

  const tool = await loadTool(staged);
  check('注册形态：只有一个工具、名字是 python、带 code/file/path/args/timeoutSec 参数',
    tool.name === 'python'
      && Object.keys(tool.parameters ?? {}).join(',') === 'code,file,path,args,timeoutSec');
  /*
   * schema 形状：`dsh-tools` 编译时**每个字段都要显式 type**（2026-10-16 真机 `.54` 现场：
   * `unsupported JSON schema: schema.properties.exitCode.type must be …` ⇒ 整行 phase=failed）。
   * 这里把参数与输出两边的字段都过一遍（缺一个就红，而不是等设备上才发现）。
   */
  check('schema：参数与输出字段都带显式 type（dsh-tools 的 JsonSchema 校验器硬要求）',
    schemaTypeGaps(tool).length === 0, schemaTypeGaps(tool).join(', '));

  /* ① code 模式 happy path：rc "None" 必须归一成 0。 */
  canned = { ok: true, stdout: '42\n', errStderr: '', rc: 'None' };
  let value = await tool.execute({ code: 'print(6*7)' });
  check('code 模式：stdout 原样带出、rc "None" ⇒ exitCode 0',
    value.stdout === '42\n' && value.stderr === '' && value.exitCode === 0 && value.mode === 'code',
    JSON.stringify({ stdout: value.stdout, exitCode: value.exitCode }));
  check('code 模式：请求打到 run-get，且带上 timeout 与源码',
    lastUrl.startsWith('/dshm-python/run-get?') && lastUrl.includes('timeout=120')
      && lastUrl.includes(encodeURIComponent('print(6*7)')));
  const rendered = tool.output.render({ code: 'print(6*7)' }, value);
  check('渲染：stdout/stderr/exit-code 三段都在',
    rendered[0].text.includes('<exit-code>0</exit-code>')
      && rendered[0].text.includes('<stdout>\n42\n</stdout>'));

  /* ② 非 0 退出码如实带出（桥的 rc 是字符串）。 */
  canned = { ok: true, stdout: '', errStderr: 'boom\n', rc: '124' };
  value = await tool.execute({ code: 'raise SystemExit(124)' });
  check('code 模式：rc 124 ⇒ exitCode 124（超时/非零退出如实带出）',
    value.exitCode === 124 && value.stderr === 'boom\n');

  /* ③ file 模式：argv 用 \x1f 分隔、参数按序带上。 */
  canned = { ok: true, stdout: 'argv-ok\n', errStderr: '', rc: 'None' };
  value = await tool.execute({ file: '/data/storage/el2/.../x.py', args: ['a', 'b c'] });
  const argvRaw = new URL(lastUrl, bridgeBase).searchParams.get('argv');
  check('file 模式：走 exec 且 argv 以 \\x1f 分隔（脚本 + 参数按序）',
    lastUrl.startsWith('/dshm-python/exec?') && argvRaw === '/data/storage/el2/.../x.py\u001fa\u001fb c',
    JSON.stringify(argvRaw));
  check('file 模式：mode 标记正确', value.mode === 'file');
  value = await tool.execute({ path: '/data/storage/el2/.../alias.py', args: ['p'] });
  const aliasArgv = new URL(lastUrl, bridgeBase).searchParams.get('argv');
  check('file 模式：`path` 是 `file` 的兼容别名（调用方不必猜参数名）',
    aliasArgv === '/data/storage/el2/.../alias.py\u001fp' && value.mode === 'file',
    JSON.stringify(aliasArgv));

  /* ④ 超时 clamp（9999 ⇒ 300；缺省/0/负 ⇒ 120）。 */
  await tool.execute({ code: 'pass', timeoutSec: 9999 });
  const clampedHigh = new URL(lastUrl, bridgeBase).searchParams.get('timeout');
  await tool.execute({ code: 'pass', timeoutSec: 0 });
  const clampedZero = new URL(lastUrl, bridgeBase).searchParams.get('timeout');
  await tool.execute({ code: 'pass' });
  const clampedDefault = new URL(lastUrl, bridgeBase).searchParams.get('timeout');
  check('超时 clamp：9999⇒300 / 0⇒120 / 缺省⇒120（与宿主端点同口径）',
    clampedHigh === '300' && clampedZero === '120' && clampedDefault === '120',
    JSON.stringify({ clampedHigh, clampedZero, clampedDefault }));

  /* ⑤ 参数面：互斥 / 二选一 / 长度上限。 */
  const expectThrow = async (args, fragment) => {
    try {
      await tool.execute(args);
      return `没有抛错（期望含「${fragment}」）`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes(fragment) ? null : message;
    }
  };
  const bothFail = await expectThrow({ code: 'pass', file: '/x.py' }, '只能给一个');
  const aliasBothFail = await expectThrow({ code: 'pass', path: '/x.py' }, '只能给一个');
  const neitherFail = await expectThrow({}, '必须给');
  const longFail = await expectThrow({ code: 'x'.repeat(9000) }, '上限');
  check('参数面：code/file/path 互斥、二者必给其一、内联源码长度上限都如实拒绝',
    bothFail === null && aliasBothFail === null && neitherFail === null && longFail === null,
    JSON.stringify({ bothFail, aliasBothFail, neitherFail, longFail }));

  canned = { ok: true, stdout: '', errStderr: '', rc: 'None' };
  for (const [label, ok] of await requestBudgetChecks(tool, bridgeBase, TOKEN)) {
    check(`request target budget: ${label}`, ok);
  }
  const longToken = 'private-token-%'.repeat(80);
  const longHome = makeHome(bridgeBase, longToken);
  cleanups.push({ close: () => rmSync(longHome, { recursive: true, force: true }) });
  process.env.DSHM_HOME = longHome;
  const originalGet = http.get;
  let longTokenRequests = 0;
  http.get = function (...args) {
    longTokenRequests += 1;
    return originalGet.apply(this, args);
  };
  try {
    const errors = [];
    for (const args of [{ code: 'x'.repeat(7000) }, { file: '/x.py', args: ['x'.repeat(7000)] }]) {
      try {
        await tool.execute(args);
        errors.push('');
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    check('long token counts toward code/argv budget without requests or token disclosure',
      longTokenRequests === 0 && errors.every((message) => message.includes('8192') && message.includes('file')
        && !message.includes(longToken) && !message.includes(encodeURIComponent(longToken))
        && !message.includes(bridgeBase) && !message.includes('?token=')));
  } finally {
    http.get = originalGet;
    process.env.DSHM_HOME = home;
  }
  for (const [label, ok] of await requestBudgetChecks(tool, `${bridgeBase}/${'p'.repeat(128)}`, TOKEN)) {
    check(`base path budget: ${label}`, ok);
  }
  cancelResponse = true;
  const cancelled = await expectThrow({ code: 'pass' }, '桥连接');
  cancelResponse = false;
  value = await tool.execute({ code: 'pass' });
  check('cancelled response rejects and subsequent short call succeeds', cancelled === null && value.exitCode === 0);

  /* ⑥ 桥回 ok:false：必须抛真因，不许把空输出当成功。 */
  canned = { ok: false, error: 'stdlib not ready (extraction in progress?)', stdlibReady: false };
  const bridgeFail = await expectThrow({ code: 'pass' }, 'stdlib not ready');
  check('桥回 ok:false ⇒ 抛出真因（不返回空输出冒充成功）', bridgeFail === null, String(bridgeFail));

  /* ⑦ HTTP 非 2xx（token 不对 / 桥拒服务）⇒ 抛出状态码与正文。 */
  statusOverride = 401;
  const httpFail = await expectThrow({ code: 'pass' }, '401');
  statusOverride = 0;
  check('HTTP 401 ⇒ 抛错且带状态码（不许静默）', httpFail === null, String(httpFail));

  /* ⑧ host-ready.json 缺失 ⇒ 可行动的错误，而不是 undefined 崩溃。 */
  const brokenHome = mkdtempSync(join(tmpdir(), 'dshm-tool-python-nohome-'));
  cleanups.push({ close: () => rmSync(brokenHome, { recursive: true, force: true }) });
  process.env.DSHM_HOME = brokenHome;
  const noReady = await expectThrow({ code: 'pass' }, 'host-ready.json');
  process.env.DSHM_HOME = home;
  check('读不到 host-ready.json ⇒ 可行动报错（点名文件），不是 undefined 崩溃', noReady === null, String(noReady));
} finally {
  delete process.env.DSHM_HOME;
  for (const item of cleanups.reverse()) {
    if (typeof item.close === 'function') item.close();
  }
}

/* ── 可选加强臂：核心树在时，用**树里那份真 dsh-tools** 再注册一遍 ────────────
 * 桩 `defineTool` 抓不到"schema 编译器会不会拒"（.54 真机正是这么栽的）。核心树存在时直接
 * import 树内副本（bare import 会解析到树里的 `@deepseek-ai/dsh-tools`）并 apply 一次。
 * 没有核心树（干净克隆 / CI）时**如实跳过**，不算失败。 */
{
  const coreDir = join(ROOT, 'dist', 'core', 'work', `dsh-core-${RECIPE.coreVersion}`);
  const pluginInTree = join(coreDir, 'node_modules', '@deepseek-ai', 'dshm-tool-python', 'lib', 'index.js');
  if (existsSync(pluginInTree)) {
    let realError = '';
    try {
      const real = await import(pathToFileURL(pluginInTree).href);
      if (!Array.isArray(real.inject) || !real.inject.includes('tools')) {
        throw new Error(`inject 里没有 tools（实际 ${JSON.stringify(real.inject)}）`);
      }
      real.apply({ tools: { register() { /* 只要不抛就算过 */ } } });
    } catch (error) {
      realError = error instanceof Error ? error.message : String(error);
    }
    check('真编译器预检：树内副本 + 树里那份 dsh-tools 能成功注册（schema/inject 都过）',
      realError === '', realError);
  } else {
    console.log('skip 真编译器预检：没有核心树（dist/core/work/dsh-core-<recipe> 不存在）');
  }
}

/* ── 负控制（--self-test）：变异体只改一处判据 ⇒ 对应断言必须红 ───────────── */
if (process.argv.includes('--self-test')) {
  /** 变异体 A：把超时上限从 300 改成 60 ⇒ ④ 的 9999⇒300 断言必须不再成立。 */
  const clampMutant = PLUGIN_SRC.replace('const MAX_TIMEOUT_SEC = 300;', 'const MAX_TIMEOUT_SEC = 60;');
  /** 变异体 B：把 `ok !== true` 判据改坏（吞掉桥的失败）⇒ ⑥ 的"必须抛真因"必须不再成立。 */
  const swallowMutant = PLUGIN_SRC.replace('if (raw.ok !== true) {', 'if (raw.ok === false && raw.error === \'__never__\') {');
  /** 变异体 C：inject 里去掉 tools ⇒ 载入时必须复现 Cordis 的注入错误（.53 真机那条）。 */
  const injectMutant = PLUGIN_SRC.replace("const inject = ['tools'];", 'const inject = [];');
  /** 变异体 D：删掉输出 schema 里 exitCode 的 type ⇒ schema 判据必须红（.54 真机那条）。 */
  const schemaMutant = PLUGIN_SRC.replace("exitCode: { type: 'integer', required: true },",
    'exitCode: { required: true },');
  const budgetMutants = [
    PLUGIN_SRC.replace('> MAX_REQUEST_TARGET_BYTES)', '> Infinity)'),
    PLUGIN_SRC.replace("Buffer.byteLength(url.pathname + url.search, 'utf8')", 'code.length'),
    PLUGIN_SRC.replace('> MAX_REQUEST_TARGET_BYTES)', '>= MAX_REQUEST_TARGET_BYTES)'),
    PLUGIN_SRC.replace("Buffer.byteLength(url.pathname + url.search, 'utf8')", "Buffer.byteLength(path, 'utf8')"),
  ];
  check('self-test: request budget mutation anchors exist', budgetMutants.every((source) => source !== PLUGIN_SRC));
  check('自检：四个变异体的替换锚点都在（判据与源码没脱钩）',
    clampMutant !== PLUGIN_SRC && swallowMutant !== PLUGIN_SRC
      && injectMutant !== PLUGIN_SRC && schemaMutant !== PLUGIN_SRC);

  const clampDir = stagePlugin(clampMutant);
  const swallowDir = stagePlugin(swallowMutant);
  const injectDir = stagePlugin(injectMutant);
  const schemaDir = stagePlugin(schemaMutant);
  /* 每个变异体自带一个**会记录请求**的桩（前一个 server 在主流程末尾已关掉）。 */
  const makeRecordingServer = async (payload) => {
    const state = { lastUrl: '' };
    const recording = createServer((request, response) => {
      state.lastUrl = request.url;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
    await new Promise((resolvePromise) => recording.listen(0, '127.0.0.1', resolvePromise));
    return {
      base: `http://127.0.0.1:${recording.address().port}`,
      state,
      close: () => recording.close(),
    };
  };
  try {
    for (const [index, source] of budgetMutants.entries()) {
      const dir = stagePlugin(source);
      const recording = await makeRecordingServer({ ok: true, stdout: '', errStderr: '', rc: 'None' });
      try {
        const mutantTool = await loadTool(dir);
        const results = await requestBudgetChecks(mutantTool, `${recording.base}/${'p'.repeat(128)}`, TOKEN);
        check(`self-test: request budget mutant ${index + 1} rejected by behavioral checks`,
          results.some(([, ok]) => !ok));
      } finally {
        recording.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const clampServer = await makeRecordingServer({ ok: true, stdout: '', errStderr: '', rc: 'None' });
    const clampHome = makeHome(clampServer.base, TOKEN);
    process.env.DSHM_HOME = clampHome;
    const clampTool = await loadTool(clampDir);
    await clampTool.execute({ code: 'pass', timeoutSec: 9999 });
    const high = new URL(clampServer.state.lastUrl, clampServer.base).searchParams.get('timeout');
    check('自检：把上限改成 60 ⇒ 9999 变成 60（原断言 9999⇒300 必红）', high === '60', `实测 ${high}`);
    clampServer.close();
    rmSync(clampHome, { recursive: true, force: true });

    const failServer = await makeRecordingServer({ ok: false, error: 'stdlib not ready' });
    const failHome = makeHome(failServer.base, TOKEN);
    process.env.DSHM_HOME = failHome;
    const swallowTool = await loadTool(swallowDir);
    let threw = false;
    try {
      /* 桩回 ok:false —— 变异体应当把它当成功吞掉（原实现会抛）。 */
      await swallowTool.execute({ code: 'pass' });
    } catch {
      threw = true;
    }
    failServer.close();
    rmSync(failHome, { recursive: true, force: true });
    check('自检：吞掉 ok:false 的变异体不再抛错（原断言「必须抛真因」必红）', threw === false);

    let cordisError = '';
    try {
      await loadTool(injectDir);
    } catch (error) {
      cordisError = error instanceof Error ? error.message : String(error);
    }
    check('自检：inject 去掉 tools ⇒ 复现 Cordis 的「without inject」（原断言必红）',
      cordisError.includes('without inject'), cordisError);

    const schemaTool = await loadTool(schemaDir);
    const schemaGaps = schemaTypeGaps(schemaTool);
    check('自检：删掉 exitCode 的 type ⇒ schema 判据必红（.54 真机那条）',
      schemaGaps.includes('output.schema.properties.exitCode'), JSON.stringify(schemaGaps));
  } finally {
    rmSync(clampDir, { recursive: true, force: true });
    rmSync(swallowDir, { recursive: true, force: true });
    rmSync(injectDir, { recursive: true, force: true });
    rmSync(schemaDir, { recursive: true, force: true });
    delete process.env.DSHM_HOME;
  }
}

console.log(`\n结果：${passed} 通过 / ${failures.length} 失败`
  + (process.argv.includes('--self-test') ? '（含 --self-test 的 8 个变异体）' : ''));
if (failures.length > 0) {
  console.log('失败项：');
  for (const name of failures) {
    console.log(`  · ${name}`);
  }
  process.exit(1);
}
