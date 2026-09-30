#!/usr/bin/env node
/**
 * 门禁：`web_fetch` 在端侧 jitless 环境下必须真的能抓网页。
 *
 * ---------------------------------------------------------------------------
 * 为什么要有这个门禁
 * ---------------------------------------------------------------------------
 * 曾经有过一个**只影响 web_fetch、且完全静默**的端侧缺陷（矩阵 §3.2）：
 *
 *   · `web_search` 正常，`web_fetch` **打不开任何网页、任何 IP**
 *   · 根因：上游 `dsh-web-fetch-http` 不用全局 fetch，而是 `await import("undici")`
 *     自建 Agent 再传 `dispatcher`；undici 的 HTTP 解析器是 WASM 版 llhttp，
 *     而端侧 Host 以 `--jitless` 运行 ⇒ `WebAssembly` 是 undefined
 *     ⇒ 每次 fetch 都抛 `fetch failed / cause: WebAssembly is not defined`
 *   · 我们的 `fetch-shim.js` 垫的是**全局 fetch**，因此对这条路径毫无作用
 *
 * 关键教训：**"Host 起来了、模型能回话"完全掩盖不了这条路径**。这个门禁就是为了
 * 让"抓网页"这件事本身被真的执行一次，而不是被结构检查推断成"应该没问题"。
 *
 * ---------------------------------------------------------------------------
 * 它为什么可信：门禁自带**对照实验**
 * ---------------------------------------------------------------------------
 * 同一份真实上游代码、同一个本地 HTTP 服务、同一套端侧 flag，只切换一件事：
 *
 *   A 臂：不注册解析钩子 ⇒ 用真 undici ⇒ **必须失败**（否则说明这个门禁没在测东西，
 *        例如被测路径已经不再走 undici 了）
 *   B 臂：注册解析钩子（`undici` → 本仓 `undici-shim.mjs`）⇒ **必须全部通过**
 *
 * 两臂都跑在两个子进程里，因为解析钩子是**进程级**的、注册后无法撤销。
 * 两臂分别用 `--experimental-loader` 与不使用来切换——那正是 `main.js` 里
 * `installUndiciNameHook()` 所做的事，只是入口不同。
 *
 * B 臂还验证了两条**安全语义**不能被削弱（这是本门禁最有价值的部分）：
 *   · 同源跳转必须被上游自己跟到最终 200（依赖上游 `redirect:'manual'` + 自己的同源判定）
 *   · **跨源跳转必须仍被拒**为 `WEB_REDIRECT_BLOCKED`
 *     （如果我们为了"让它能通"而放开 redirect 或忽略 lookup，这两条会立刻炸）
 *
 * ---------------------------------------------------------------------------
 * 用法
 * ---------------------------------------------------------------------------
 *   node tools/check-web-fetch-jitless.mjs            # 自动找 dist/core/work 下的核心树
 *   node tools/check-web-fetch-jitless.mjs --core <核心树根>
 *   node tools/check-web-fetch-jitless.mjs --self-test
 *
 * 退出码：0 通过 / 1 失败 / 3 环境不具备（缺核心树或该上游包，属跳过而非失败）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};

/* ───────────────────────── 输出分类（可自测） ───────────────────────── */

/** 从断言汇总行里取 (总数, 失败数)；没有汇总行则为 (NaN, NaN) */
export function parseAssertions(text) {
  const m = text.match(/断言 (\d+) 条，失败 (\d+) 条/);
  return m === null ? { total: NaN, failed: NaN } : { total: Number(m[1]), failed: Number(m[2]) };
}

/**
 * 判定 A 臂（无钩子）是否**因为 WASM 而失败**。
 *
 * 【为什么不能只看"失败了"】网络不通、包没装、我自己把测试写错了，都会失败。
 * 所以这里要求两件事同时成立：
 *   ① 断言没全过（否则说明被测路径已不再依赖 undici，本门禁失去意义）；
 *   ② 输出里出现 **WASM 因果证据**（A 臂会直接探一次真 undici 并打印 cause）。
 *
 * 只有"失败 + 因果是 WASM"才算对照实验成立。若只是失败却说不出原因，判**不成立**
 * （宁可让门禁报错，也不要拿一个来路不明的失败充当证据）。
 */
export function classifyNoHookArm(stdout, stderr) {
  const all = `${stdout}\n${stderr}`;
  const { total, failed } = parseAssertions(all);
  const allPassed = Number.isFinite(total) && total > 0 && failed === 0;
  const wasmCause = /WebAssembly is not defined/.test(all);

  if (allPassed) {
    return { ok: false, why: 'A 臂竟然全过 —— 说明被测路径已不再依赖 undici，本门禁失去意义，请重新审视' };
  }
  if (!wasmCause) {
    return { ok: false, why: 'A 臂失败了，但输出里没有 WASM 因果证据 —— 无法认定这是我们要防的那个原因（可能是环境/测试自身的问题）' };
  }
  if (Number.isFinite(total) && failed === total) {
    return { ok: true, why: `全部 ${total} 条断言失败，且带 WASM 因果证据（预期）` };
  }
  return { ok: true, why: '上游 fetch 失败并带 WASM 因果证据（预期）' };
}

/** 判定 B 臂（有钩子）是否全部通过 */
export function classifyHookedArm(stdout, stderr) {
  const all = `${stdout}\n${stderr}`;
  const { total, failed } = parseAssertions(all);
  if (!Number.isFinite(total)) {
    return { ok: false, why: 'B 臂没有产出断言汇总（可能崩在断言之前）' };
  }
  if (failed !== 0) {
    return { ok: false, why: `B 臂有 ${failed}/${total} 条断言失败` };
  }
  if (total < 8) {
    return { ok: false, why: `B 臂只跑了 ${total} 条断言（少于预期的 8 条，可能提前中断）` };
  }
  return { ok: true, why: `${total}/${total} 条断言通过` };
}

/* ───────────────────────── 自测（喂人造输出） ───────────────────────── */

const WASM_CAUSE = '[probe] 真 undici 失败原因: WebAssembly is not defined';

function selfTest() {
  let pass = 0;
  let fail = 0;
  const t = (name, cond) => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } };

  t('A臂：全失败 + WASM 因果 → 对照成立',
    classifyNoHookArm(`检查失败：\n${WASM_CAUSE}\n断言 8 条，失败 8 条。\n`, '').ok === true);
  t('A臂：上游报 fetch failed + WASM 因果 → 对照成立',
    classifyNoHookArm(`${WASM_CAUSE}\nweb fetch failed: TypeError: fetch failed code=WEB_PROVIDER_ERROR`, '').ok === true);
  t('A臂：**全过** → 必须判不成立（门禁失去意义）',
    classifyNoHookArm(`${WASM_CAUSE}\n断言 8 条，失败 0 条。`, '').ok === false);
  t('A臂：失败但**说不出原因**（无 WASM 因果）→ 判不成立（不拿来路不明的失败当证据）',
    classifyNoHookArm('断言 8 条，失败 8 条。', '').ok === false);
  t('A臂：只有 fetch failed、没有 WASM 因果 → 判不成立（指纹太弱，不能归因）',
    classifyNoHookArm('web fetch failed: TypeError: fetch failed code=WEB_PROVIDER_ERROR', '').ok === false);
  t('A臂：没有任何输出 → 判不成立', classifyNoHookArm('', '').ok === false);

  t('断言解析：8 条 0 失败 → (8,0)', parseAssertions('断言 8 条，失败 0 条。').total === 8
    && parseAssertions('断言 8 条，失败 0 条。').failed === 0);
  t('断言解析：4 条 4 失败 → (4,4)', parseAssertions('断言 4 条，失败 4 条。').total === 4
    && parseAssertions('断言 4 条，失败 4 条。').failed === 4);
  t('断言解析：无汇总行 → NaN', Number.isNaN(parseAssertions('boom').total));

  t('B臂：8/8 通过 → 判成立', classifyHookedArm('断言 8 条，失败 0 条。', '').ok === true);
  t('B臂：有失败 → 判不成立', classifyHookedArm('断言 8 条，失败 1 条。', '').ok === false);
  t('B臂：断言数不足（提前中断）→ 判不成立', classifyHookedArm('断言 3 条，失败 0 条。', '').ok === false);
  t('B臂：没有汇总行 → 判不成立', classifyHookedArm('SyntaxError: boom', '').ok === false);

  console.log(`\n自测 ${pass + fail} 条，失败 ${fail} 条。`);
  return fail === 0 ? 0 : 1;
}

if (args.includes('--self-test')) {
  process.exit(selfTest());
}

/* ───────────────────────── 找核心树与上游包 ───────────────────────── */

function coreCandidates() {
  const explicit = arg('--core', process.env.DSHM_CORE_DIR ?? '');
  if (explicit !== '') {
    return [resolve(explicit)];
  }
  const work = join(ROOT, 'dist', 'core', 'work');
  if (!existsSync(work)) {
    return [];
  }
  return readdirSync(work)
    .filter((n) => n.startsWith('dsh-core-'))
    .sort()
    .map((n) => join(work, n));
}

function findProvider() {
  for (const core of coreCandidates()) {
    const p = join(core, 'node_modules', '@deepseek-ai', 'dsh-web-fetch-http', 'lib', 'index.js');
    if (existsSync(p)) {
      return { core, provider: p };
    }
  }
  return null;
}

const found = findProvider();
if (found === null) {
  const hint = coreCandidates().length === 0
    ? '没找到 dist/core/work/dsh-core-*（也未给 --core）'
    : '核心树里没有 @deepseek-ai/dsh-web-fetch-http';
  console.log(`SKIP: ${hint} —— 属环境不具备，不作为失败`);
  process.exit(3);
}

/* ───────────────────── 子进程本尊：真正跑两臂 ───────────────────── */

/* 【为什么必须是 file:// URL】`--experimental-loader` 吃的是 **ESM 说明符**，不是文件路径：
 * Windows 上传 `D:\...\undici-loader.mjs` 会被默认 ESM 加载器当成协议 `d:` 而拒绝——
 *   `ERR_UNSUPPORTED_ESM_URL_SCHEME: ... Received protocol 'd:'`
 * 崩在第一条断言之前 ⇒ B 臂永远"没有产出断言汇总"，门禁在 Windows 上整体失效（假红）。
 * `existsSync` 仍要用真实路径，所以两者分开存。 */
const LOADER_PATH = join(ROOT, 'entry', 'src', 'main', 'resources', 'resfile', 'resources', 'app', 'undici-loader.mjs');
const LOADER = pathToFileURL(LOADER_PATH).href;

if (process.env.DSHM_WEBFETCH_ARM !== undefined) {
  const arm = process.env.DSHM_WEBFETCH_ARM;
  const label = process.env.DSHM_WEBFETCH_LABEL ?? arm;
  const providerUrl = `file://${found.provider}`;

  // 注意：这里必须用 CJS `require('node:http')`。ESM `import 'node:http'` 在
  // `--jitless` 下会让进程在收尾时抛 internal-undici 的 WASM 错误并以 1 退出
  // （与本次修复无关，但会把本门禁的结论搅浑）。见 docs/50-端侧核心运行架构.md。
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const http = require('node:http');

  const { HttpFetchProvider, DEFAULT_USER_AGENT } = await import(providerUrl);

  const server = http.createServer((req, res) => {
    if (req.url === '/redir') { res.writeHead(302, { location: '/ok' }); res.end(); return; }
    if (req.url === '/cross') { res.writeHead(302, { location: 'http://evil.example/ok' }); res.end(); return; }
    if (req.url === '/echo-ua') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`UA=${req.headers['user-agent'] ?? ''}`); return; }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('BODYDATA');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const PORT = server.address().port;
  /* 主机名**故意不用字面 IP**：靠注入的解析器把它钉到 loopback。
   * 这正是上游 DNS 钉住的语义（URL 主机名不变，用于 Host/SNI）。 */
  const base = `http://example.com:${PORT}`;

  const limits = {
    maxBodyChars: 1e5, timeoutMs: 3e4, maxRedirects: 5,
    maxResponseBytes: 5e6, userAgent: DEFAULT_USER_AGENT,
  };
  const provider = new HttpFetchProvider(limits, async () => [{ address: '127.0.0.1', family: 4 }]);

  let pass = 0;
  let fail = 0;
  const t = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); }
  };

  console.log(`[${label}] WASM=${typeof WebAssembly}`);

  /* A 臂的**因果证据**：直接探一次真 undici，并把 cause 打出来。
   *
   * 【为什么非要有这一步】只证明"A 臂失败了"是不够的 —— 网络不通、包缺失、
   * 我自己写错，都会失败。这里直接让真 undici 发一个请求并打印它的 cause，
   * 于是"失败的原因就是 WASM 不可用"成为**被观测到的事实**，而不是推断。
   * 该探测只在 A 臂跑：B 臂注册了钩子，`import("undici")` 拿到的是垫片。 */
  if (arm === 'nohook') {
    /* 【必须从核心树的角度解析 undici】仓库根并没有 undici 包，只有核心树的
     * node_modules 里有。如果在这里直接 `import('undici')`，拿到的是
     * MODULE_NOT_FOUND —— 一个与 WASM 毫无关系的原因，会把结论带偏
     * （本门禁的严格判定正是这样当场抓出了这个错误）。
     * 所以先以"上游包所在位置"为基准解析出真实路径，再按路径 import。 */
    try {
      const requireFromCore = createRequire(found.provider);
      const undiciMain = requireFromCore.resolve('undici');
      const real = await import(pathToFileURL(undiciMain).href);
      const realFetch = real.default !== undefined && typeof real.default.fetch === 'function'
        ? real.default.fetch : real.fetch;
      await realFetch(`http://127.0.0.1:${PORT}/ok`);
      console.log('[probe] 真 undici 竟然成功了 —— 与预期相反（WASM 应当不可用）');
    } catch (e) {
      const cause = e !== null && e !== undefined && e.cause !== undefined && e.cause !== null
        ? e.cause.message : e.message;
      console.log(`[probe] 真 undici 失败原因: ${cause}`);
    }
  }

  try {
    const r = await provider.fetch({ url: `${base}/ok` });
    t('真实上游 fetch → 200', r.statusCode === 200, `status=${r.statusCode}`);
    t('body.kind=text', r.body !== undefined && r.body !== null && r.body.kind === 'text');
    t('body 内容正确', r.body !== undefined && r.body !== null && r.body.content === 'BODYDATA', JSON.stringify(r.body));
    t('url 回显', typeof r.url === 'string' && r.url.includes('/ok'), String(r.url));
    t('truncated=false', r.truncated === false);
  } catch (e) {
    t('真实上游 fetch /ok', false, `${e && e.message} code=${e && e.code}`);
  }

  try {
    const r = await provider.fetch({ url: `${base}/echo-ua` });
    t('上游发出的 UA 抵达服务端（证明真连上，不是空壳）',
      r.body !== undefined && r.body !== null && r.body.content === `UA=${DEFAULT_USER_AGENT}`,
      JSON.stringify(r.body && r.body.content).slice(0, 60));
  } catch (e) {
    t('UA 透传', false, e && e.message);
  }

  try {
    const r = await provider.fetch({ url: `${base}/redir` });
    t('同源跳转被上游自己跟到 200（依赖 redirect:manual 语义）',
      r.statusCode === 200 && r.body.content === 'BODYDATA', `status=${r.statusCode}`);
  } catch (e) {
    t('同源跳转', false, e && e.message);
  }

  try {
    await provider.fetch({ url: `${base}/cross` });
    t('跨源跳转必须被拒', false, '竟然没抛错 —— 安全语义被削弱了');
  } catch (e) {
    t('跨源跳转被拒（WEB_REDIRECT_BLOCKED）', e && e.code === 'WEB_REDIRECT_BLOCKED',
      `code=${e && e.code} msg=${e && e.message}`);
  }

  server.close();
  console.log(`\n断言 ${pass + fail} 条，失败 ${fail} 条。`);
  process.exit(0);
}

/* ───────────────────────── 父进程：跑两臂并判定 ───────────────────────── */

if (!existsSync(LOADER_PATH)) {
  console.log(`SKIP: 解析钩子不在应用资源里（${LOADER_PATH}）—— 先跑 node tools/place-host-app.mjs`);
  process.exit(3);
}

/* 【为什么要在运行时探测，而不是写死】
 * `--no-experimental-fetch` 是**否定形态**，而 Node v24 的 fetch 已转正 ⇒ CLI 解析阶段
 * 直接拒绝：`--no-experimental-fetch is an invalid negation because it is not a boolean
 * option`，进程在跑到任何断言之前就退出。实测后果是**两臂同时哑火**：
 * A 臂"失败了但没有 WASM 因果证据"、B 臂"没有产出断言汇总"，门禁整体失效（假红）。
 * 端侧 `RuntimePort.buildHostArgv` 本就不带这个 flag（同一课已写在
 * `check-origin-fence.mjs:119-121`），所以在新 Node 上剔掉它反而**更贴近端侧**；
 * 旧 Node 上仍接受则原样保留。探测失败一律按"不接受"处理。 */
const CANDIDATE_FLAGS = ['--jitless', '--no-experimental-fetch'];
const FLAGS = CANDIDATE_FLAGS.filter((f) =>
  spawnSync(process.execPath, [f, '-e', '0'], { encoding: 'utf8' }).status === 0);
const droppedFlags = CANDIDATE_FLAGS.filter((f) => !FLAGS.includes(f));
if (droppedFlags.length > 0) {
  console.log(`注：本机 Node ${process.version} 不接受 ${droppedFlags.join(' ')}，已剔除（不影响本门禁的对照实验）`);
}

function runArm(id, label, extraFlags) {
  console.log(`\n──── ${label} ────`);
  const r = spawnSync(process.execPath, [...FLAGS, ...extraFlags, SELF], {
    env: { ...process.env, DSHM_WEBFETCH_ARM: id, DSHM_WEBFETCH_LABEL: label },
    encoding: 'utf8',
    timeout: 120000,
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  process.stdout.write(stdout.split('\n').filter((l) => !/^--import|ExperimentalWarning|trace-warnings/.test(l)).join('\n'));
  return { stdout, stderr };
}

const a = runArm('nohook', '无钩子（真 undici，必须失败）', []);
const verdictA = classifyNoHookArm(a.stdout, a.stderr);
console.log(`  → A 臂判定：${verdictA.ok ? '符合预期' : '不符合预期'}（${verdictA.why}）`);

const b = runArm('hook', '有钩子（本仓垫片，必须全过）', ['--experimental-loader', LOADER]);
const verdictB = classifyHookedArm(b.stdout, b.stderr);
console.log(`  → B 臂判定：${verdictB.ok ? '通过' : '失败'}（${verdictB.why}）`);

console.log('\n════════ 结论 ════════');
if (verdictA.ok && verdictB.ok) {
  console.log('PASS：对照实验成立 —— 同一份上游代码，无钩子必失败、有钩子全通过。');
  console.log('      web_fetch 在端侧 jitless 下可用，且跨源跳转仍被拒。');
  process.exit(0);
}
console.log('FAIL：');
if (!verdictA.ok) {
  console.log(`  · A 臂：${verdictA.why}`);
}
if (!verdictB.ok) {
  console.log(`  · B 臂：${verdictB.why}`);
}
process.exit(1);
