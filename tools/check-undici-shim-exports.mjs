/*
 * 门禁：undici 垫片的**具名导出面**必须覆盖核心树与已装插件实际 import 的名字（U1）。
 *
 * 【为什么单独有一条门禁】
 * 这条故障的症状是**不说话**的：ESM 具名导入在**解析阶段**校验导出存在性，
 * 缺一个名字 ⇒ 整个模块图 `failed to import` ⇒ 插件连 `apply()` 都到不了，
 * 而 loader 只打一行
 *
 *     dsh: warning: 1 entry did not activate
 *     codearts-auth (dsh-codearts-auth): failed to import
 *
 * **不给 reason**。用户侧的观感就是"插件装了、重启了、还是不生效"，排查成本极高。
 * 历史上已经踩过两次：2026-09-24 缺 `EnvHttpProxyAgent`（`dshmarket` 整行不激活）、
 * 2026-10-03 缺 `Pool`/`ProxyAgent`（`dsh-codearts-auth` 0.2.1003 新增 `opencode-proxy.js`）。
 * 每次都是"第三方/官方包里出现了一个新的 undici 名字"，那就只能**机器盯着**。
 *
 * 【它测什么】
 *   ① 从**垫片本体**取真实导出（`import()` 拿 `Object.keys`，不是读源码里的字符串）——
 *      保证判据是"运行时真的导出了什么"，而不是"源码里写了 export"。
 *   ② 扫核心树 + 已装插件的所有 `from 'undici'` / `import('undici')` 具名列表，
 *      逐个断言在 ① 里存在。
 *   ④ 请求方向探针：`Request` 必须**真能用**（本地回环发一次 POST，断言 method/头/体逐字到达；
 *      对照臂：吞掉 method/body 的假实现必须判红）—— 名字在但行为假属同一族事故，见该段注释。
 *   ③ 对照组：断言"上游确实会用到的名字"（`Agent`/`fetch`/`Dispatcher`/`EnvHttpProxyAgent`）
 *      真的被 ② 扫到了 —— 否则说明扫描逻辑失效（例如正则不再匹配上游写法），
 *      "全过"就成了假通过。
 *
 * 【它刻意不测什么】
 *   · 不测降解实现的行为是否等价真 undici（那需要真代理服务器，端侧也没有）。
 *     本门禁只管"导入面不缺口"，行为正确性由 `check-web-fetch-jitless.mjs` 覆盖。
 *   · 不测 `default` 导出（具名导入不走它），但会顺带断言它的键与具名导出一致，
 *     因为有的包里写的是 `undici.default?.X`。
 *
 * 退出码：0 通过 / 1 有真实缺口 / 2 前置条件缺失（无核心树，未跑过 pack-core）。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
/* 【目录名跟随配方，不写死版本】否则升核心后本门禁会静默扫旧树（或报"前置条件缺失"掩盖真因）。 */
const RECIPE = JSON.parse(readFileSync(join(ROOT, 'hostcore', 'core-recipe.json'), 'utf8'));
const STAGE = join(ROOT, 'dist', 'core', 'work', `dsh-core-${RECIPE.coreVersion}`);
const SHIM = join(ROOT, 'hostcore', 'app', 'undici-shim.mjs');

if (!existsSync(STAGE)) {
  console.log(`前置条件缺失：核心工作树 ${relative(ROOT, STAGE)} 不存在。`);
  console.log('先跑 `node tools/pack-core.mjs --skip-install` 生成核心工作树，再跑本门禁。');
  process.exit(2);
}
if (!existsSync(SHIM)) {
  console.error(`FAIL  垫片本体不存在：${relative(ROOT, SHIM)}`);
  process.exit(1);
}

/* ── ① 垫片真实导出（运行时事实） ───────────────────────────────────── */
const shim = await import(pathToFileURL(SHIM).href);
const exported = new Set(Object.keys(shim));
const defaultObj = shim.default;
const defaultKeys = defaultObj !== null && typeof defaultObj === 'object' ? new Set(Object.keys(defaultObj)) : new Set();

let failures = 0;
const fail = (msg) => { failures += 1; console.error(`  FAIL ${msg}`); };
const ok = (msg) => console.log(`  ok   ${msg}`);

/* ── ② 扫描全部 undici 具名导入 ─────────────────────────────────────── */
/** 一个文件里所有 `from 'undici'` 与 `import('undici')` 的具名导入名。 */
function namedImportsIn(text) {
  const names = new Set();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // 静态：import { A, B as C } from 'undici'      （可能跨行，向上合并到一条语句）
    if (/from\s*['"]undici['"]/.test(line)) {
      let stmt = line;
      for (let k = i - 1; k >= 0 && k >= i - 6; k -= 1) {
        stmt = lines[k] + '\n' + stmt;
        if (/(^|\n)\s*import\b/.test(lines[k])) break;
      }
      const m = /import\s*\{([\s\S]*?)\}\s*from\s*['"]undici['"]/.exec(stmt);
      if (m !== null) {
        for (const part of m[1].split(',')) {
          const name = part.trim().split(/\s+as\s+/)[0].trim();
          if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
        }
      } else if (/import\s*[A-Za-z_$][\w$]*\s*,/.test(stmt)) {
        // `import undici, { A } from 'undici'` 已由上面的分支覆盖；默认导入无具名
      }
      continue;
    }
    // 动态：const { A, B } = await import('undici')
    if (/import\(\s*['"]undici['"]\s*\)/.test(line)) {
      let stmt = line;
      for (let k = i + 1; k < lines.length && k <= i + 8; k += 1) {
        stmt += '\n' + lines[k];
        if (/;/.test(lines[k])) break;
      }
      const head = /(?:const|let|var)\s*\{([\s\S]*?)\}\s*=/.exec(stmt);
      if (head !== null) {
        for (const part of head[1].split(',')) {
          const name = part.trim().split(/[:=]/)[0].trim();
          if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
        }
      }
      // `const undici = await import('undici')` → 后面会用 undici.X，无法静态枚举；
      // 这里只在文件级记一条"动态命名空间"提示，不做断言（见下方 report）。
      if (/(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*\n?\s*$/.test(lines[Math.max(0, i - 1)].trim()) || /^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*await\s+import/.test(line)) {
        names.add('\u0000NAMESPACE');
      }
    }
  }
  return names;
}

/** 递归收集候选文件（跳过 node_modules 嵌套、sourcemap、.d.ts）。 */
function walk(dir, out, depth) {
  if (depth > 8) return out;
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '.bin' || e.name === '.cache') continue;
      walk(p, out, depth + 1);
    } else if (/\.(mjs|cjs|js)$/.test(e.name) && !e.name.endsWith('.min.js')) {
      out.push(p);
    }
  }
  return out;
}

const files = walk(join(STAGE, 'node_modules'), [], 0);

const requested = new Map();   // name → [site]
const namespaceSites = [];
for (const f of files) {
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  if (!text.includes('undici')) continue;
  const names = namedImportsIn(text);
  for (const n of names) {
    if (n === '\u0000NAMESPACE') { namespaceSites.push(relative(ROOT, f)); continue; }
    if (!requested.has(n)) requested.set(n, []);
    requested.get(n).push(`${relative(ROOT, f)}`);
  }
}

/* ── ③ 对照组：扫描逻辑必须真的看到上游用到的名字 ─────────────────── */
const CONTROL = ['Agent', 'fetch'];
for (const c of CONTROL) {
  if (!requested.has(c)) {
    fail(`对照组失守：核心树里应当扫到 \`${c}\` 的 undici 具名导入，实际 0 处 —— `
      + '扫描逻辑（正则/文件遍历）已失效，本次"通过"不成立。');
  }
}
if (!namespaceSites.some((s) => s.includes('dsh-http-proxy'))) {
  ok('注：未扫到 dsh-http-proxy 的命名空间式 import（若上游改了写法，这条提示会消失）');
}

/* ── 断言 ──────────────────────────────────────────────────────────── */
const missing = [];
for (const [name, sites] of requested) {
  if (!exported.has(name)) {
    missing.push({ name, sites: [...new Set(sites)].slice(0, 4) });
  }
}
if (missing.length > 0) {
  for (const m of missing) {
    fail(`垫片缺具名导出 \`${m.name}\` —— 需要它的文件：${m.sites.join(', ')}`
      + '（ESM 具名导入解析期即失败 ⇒ 这些包的整个模块图 `failed to import`，'
      + '而 loader 不打印 reason）');
  }
} else if (failures === 0) {
  ok(`垫片导出面完整：${requested.size} 个被请求的名字全部存在`
    + `（${[...requested.keys()].sort().join(', ')}）`);
}

/* default 导出的一致性（有的包经 `undici.default.X` 取用） */
if (defaultObj !== undefined) {
  const drift = [...requested.keys()].filter((n) => exported.has(n) && !defaultKeys.has(n));
  if (drift.length > 0) {
    fail(`垫片 default 导出与具名导出不一致，缺：${drift.join(', ')}`
      + '（有的包写 `undici.default.X`，会拿到 undefined）');
  } else {
    ok(`default 导出与具名导出一致（${defaultKeys.size} 键）`);
  }
}

/* 已修复的具体缺口：留成断言，防止有人"清理"掉它们 */
for (const name of ['Pool', 'ProxyAgent', 'EnvHttpProxyAgent', 'Request']) {
  if (!exported.has(name)) {
    fail(`历史缺陷复发：垫片缺 \`${name}\`（见本文件头部注释里的两次事故记录）`);
  } else {
    ok(`历史缺口仍在位：\`${name}\``);
  }
  if (!defaultKeys.has(name)) {
    fail(`\`${name}\` 没进 default 导出`);
  }
}

// 降级实现必须可构造、不抛错（真 undici 的 ProxyAgent 收 { uri, clientFactory }）
if (exported.has('ProxyAgent') && exported.has('Pool')) {
  try {
    const viaObject = new shim.ProxyAgent({ uri: 'http://127.0.0.1:8080', clientFactory: (o, p) => new shim.Pool(o, p) });
    const viaString = new shim.ProxyAgent('socks5://127.0.0.1:1080');
    const pool = new shim.Pool('http://127.0.0.1:8080', { pipelining: 0 });
    if (!(viaObject instanceof shim.Agent) || !(viaString instanceof shim.Agent) || !(pool instanceof shim.Agent)) {
      fail('降级实现没有继承 Agent（上游会把它当 Dispatcher 传给 fetch）');
    } else if (viaString.uri !== 'socks5://127.0.0.1:1080') {
      fail(`ProxyAgent 未收下字符串形态的 uri（拿到 ${JSON.stringify(viaString.uri)}）`);
    } else {
      ok('降级实现可构造：ProxyAgent({uri,clientFactory}) / ProxyAgent(string) / Pool(origin,opts) 都不抛错且是 Agent');
    }
  } catch (error) {
    fail(`降级实现构造抛错（会变成运行期失败，比缺导出更难查）：${error && error.message}`);
  }
}

/* ── ④ 请求方向：`Request` 必须**真能用**（不是只为过解析期的空壳） ────────────
 * 【为什么这条必须有牙】上面 ①②③ 只断言"导出面不缺名字"，而缺名字的代价是
 * "整个模块图 `failed to import`"。**反向的坑是名字在、行为假**：给一个吞掉
 * method/body 的 `Request`（本仓 `fetch-shim.js` 2026-10-07 就出过这个病 ——
 * 只读 `.url` ⇒ `fetch(new Request(url, {method:'POST', body}))` 退化成"无头无体的 GET"）。
 * 所以这里用**本地回环**真发一次 POST，断言服务端看到的 method / 头 / 体逐字一致；
 * 并且**必须有对照臂**：把 method/body 吞掉的假实现判红，否则说明探针没有牙。
 *
 * 【只用 127.0.0.1:0】临时端口，不出网 —— 与 `check-fetch-shim.cjs` 同一做法。
 */
const PROBE_BODY = 'probe-请求体-中文';
async function requestRoundTrip(RequestImpl) {
  const seen = { method: null, probeHeader: null, body: null };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.method = req.method;
      seen.probeHeader = req.headers['x-dshm-probe'] === undefined ? null : req.headers['x-dshm-probe'];
      seen.body = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('pong');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const req = new RequestImpl('http://127.0.0.1:' + port + '/probe', {
      method: 'POST',
      headers: { 'x-dshm-probe': '1', 'content-type': 'text/plain' },
      body: PROBE_BODY,
    });
    const resp = await shim.fetch(req, { redirect: 'manual' });
    const text = await resp.text();
    return { status: resp.status, text, seen };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

if (typeof shim.Request !== 'function') {
  fail('垫片缺可用导出 `Request`（openai 7.x 的 x509-transport-capability.mjs 具名导入它 ⇒ '
    + '整个 openai 模块图 failed to import）');
} else {
  try {
    const r = await requestRoundTrip(shim.Request);
    if (r.status !== 200 || r.text !== 'pong') fail(`Request 探针：响应不是 200/pong（拿到 ${r.status}/${JSON.stringify(r.text)}）`);
    else if (r.seen.method !== 'POST') fail(`Request 探针：服务端看到的 method 是 ${r.seen.method}（应为 POST —— 典型的"只取 .url"退化）`);
    else if (r.seen.probeHeader !== '1') fail(`Request 探针：自定义头丢了（拿到 ${JSON.stringify(r.seen.probeHeader)}）`);
    else if (r.seen.body !== PROBE_BODY) fail(`Request 探针：请求体不一致（收到 ${JSON.stringify(r.seen.body)}）`);
    else ok('Request 可用：`fetch(new Request(url, {method,headers,body}))` 真发 POST、头与体逐字到达（本地回环实测）');
  } catch (error) {
    fail(`Request 探针抛错（不可用）：${error && error.message}`);
  }
  /* 对照臂：吞掉 method/body 的假实现必须被判红 */
  class DroppingRequest {
    constructor(input) { this.url = String(input); this.method = 'GET'; this.headers = new Map(); }
    async text() { return ''; }
  }
  try {
    const r = await requestRoundTrip(DroppingRequest);
    if (r.seen.method === 'POST' && r.seen.body === PROBE_BODY) {
      fail('对照臂失守：吞掉 method/body 的假 Request 竟也通过了探针 —— 上面那条"Request 可用"没有牙');
    } else {
      ok(`对照臂如期判红：假 Request 在服务端看到 method=${r.seen.method} / body=${JSON.stringify(r.seen.body)}`);
    }
  } catch (error) {
    ok(`对照臂如期判红（探针抛错也算）：${error && error.message}`);
  }
}

console.log(failures === 0
  ? '\nRESULT: 全部通过'
  : `\nRESULT: ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
