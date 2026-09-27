/**
 * 「自定义模型 API」保存链上的关键一环：**模型的端点探测**（`llm/discoverModels`）。
 *
 * 【为什么测这个】官方 `CustomProviderCard` 的保存按钮 `ready` 判据里有一条
 * **`models.length > 0`**（dsh-client-ui-settings-models/lib/client.js:1245），
 * 而模型来自「获取模型」= `llm/discoverModels`（client.js:662/600）。
 * 该探测对**目录外的路由**（中转站/自部署）会发**真实 HTTP**
 * （dsh-llm-pi-ai/lib/index.js:2309 `fetch(url,{method:'GET',headers})`）——
 * 在端侧这必定**走我们的 fetch 垫片**。
 * 因此：探测失败 ⇒ 表单永远 `ready=false` ⇒ 用户看到的就是「自定义 API 保存不了」。
 *
 * 报告 9 §5 第 5 条（"本地假网关校验 Bearer + 拒绝 chunked 跑一遍 → 200"）**从未实现**，
 * 本脚本补上它：假网关**校验 Bearer**、对 chunked 回 412（与腾讯 WAF 同语义）。
 *
 * 用法: node tools/check-custom-api-discovery.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';

const ROOT = process.cwd();
const RECIPE = JSON.parse(readFileSync(join(ROOT, 'hostcore', 'core-recipe.json'), 'utf8'));
const CORE_DIR = join(ROOT, 'dist', 'core', 'work', `dsh-core-${RECIPE.coreVersion}`);
const HOME = join(ROOT, 'dist', 'localtest', 'discovery-home');
const SANDBOX = join(ROOT, 'dist', 'localtest', 'discovery-sandbox');
const ENTRY = join(ROOT, 'hostcore', 'app', 'main.js');
const PORT = Number(process.env.DSHM_CHECK_PORT ?? String(3860 + (process.pid % 100)));
const READY_PATH = join(HOME, 'host-ready.json');
const STOP_PATH = join(HOME, 'host-stop-request');

rmSync(HOME, { recursive: true, force: true });
rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
mkdirSync(SANDBOX, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 假网关：校验 Bearer、拒 chunked（复刻腾讯 WAF 的 412） ────────────────
const KEY = 'sk-test-gateway-key';
const seen = [];
const gateway = http.createServer((req, res) => {
  const rec = {
    method: req.method,
    url: req.url,
    auth: req.headers['authorization'],
    te: req.headers['transfer-encoding'],
    cl: req.headers['content-length'],
  };
  seen.push(rec);
  let body = 0;
  req.on('data', (c) => { body += c.length; });
  req.on('end', () => {
    rec.bodyBytes = body;
    // 拒 chunked POST（腾讯 chatapi 前置 WAF 的真实行为：412 空体）
    if (req.headers['transfer-encoding'] === 'chunked') {
      res.writeHead(412); res.end(); return;
    }
    // 校验 Bearer（缺了就是 401 —— 报告 9 缺陷 1 的症状）
    if (req.headers['authorization'] !== `Bearer ${KEY}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'missing or invalid API key' } })); return;
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gateway-model-a' }, { id: 'gateway-model-b' }] }));
      return;
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
const GW_PORT = gateway.address().port;
console.log(`fake gateway on 127.0.0.1:${GW_PORT}（校验 Bearer、拒 chunked）`);

function get(path, cookie) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'GET',
      headers: cookie === undefined ? {} : { cookie } }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString('utf8') }));
    });
    req.on('error', (e) => resolve({ status: 0, text: String(e && e.message) }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, text: 'timeout' }); });
    req.end();
  });
}
function rpc(endpoint, payload, cookie) {
  const body = Buffer.from(JSON.stringify({ type: 'client-request', rpcId: `c${Date.now()}`,
    method: endpoint, payload: { args: payload } }), 'utf8');
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: `/api/${endpoint}`, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length,
        ...(cookie === undefined ? {} : { cookie }) } }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => { const text = Buffer.concat(c).toString('utf8');
        let p; try { p = JSON.parse(text); } catch { p = undefined; }
        resolve({ status: res.statusCode, text, parsed: p }); });
    });
    req.on('error', (e) => resolve({ status: 0, text: String(e && e.message) }));
    req.setTimeout(40000, () => { req.destroy(); resolve({ status: 0, text: 'timeout' }); });
    req.end(body);
  });
}

let child = null; let hostLog = '';
child = spawn(process.execPath, ['--jitless', '--experimental-sqlite', '--expose-internals', ENTRY],
  { cwd: ROOT, env: { ...process.env, DSHM_CORE_DIR: CORE_DIR, DSHM_HOME: HOME,
    DSHM_SANDBOX_HOME: SANDBOX, DSHM_PORT: String(PORT), DSHM_PROFILE: 'ondevice',
    // 假网关 key 走凭据引用（探测器会按 apiKeyEnv 解析）
    WB2API_API_KEY: KEY }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (b) => { hostLog += b.toString(); });
child.stderr.on('data', (b) => { hostLog += b.toString(); });

const until = Date.now() + 90000;
while (Date.now() < until && !existsSync(READY_PATH)) await sleep(400);
if (!existsSync(READY_PATH)) { console.error('host not ready\n' + hostLog.slice(-2500)); process.exit(2); }
const token = String(JSON.parse(readFileSync(READY_PATH, 'utf8')).token ?? '');
const c0 = await get(`/?token=${encodeURIComponent(token)}`);
const sc = c0.headers?.['set-cookie'];
const cookie = (Array.isArray(sc) ? sc[0] : sc)?.split(';')[0];
console.log('host ready\n');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail === undefined ? '' : ' — ' + detail}`); }
}

// ① 先写一个自定义路由（= 表单的 profile 写入动作），使它成为"目录外的路由"
const ROUTE = 'gateway';
const CFG = { baseURL: `http://127.0.0.1:${GW_PORT}/v1`, api: 'openai-completions',
  apiKeyEnv: 'WB2API_API_KEY', models: [{ id: 'gateway-model-a' }] };
const d0 = await rpc('settings/describe', {}, cookie);
const pi0 = (d0.parsed?.result?.value?.namespaces ?? []).find((n) => n.ns === 'llm-pi-ai');
const mut = await rpc('settings/mutate', { ns: 'llm-pi-ai',
  ops: [{ op: 'set', path: ['providers', ROUTE], value: CFG }],
  expectedRevision: pi0?.revision }, cookie);
check('settings/mutate 写入自定义路由', mut.parsed?.result?.ok === true,
  JSON.stringify(mut.parsed?.result?.error ?? mut.text.slice(0, 200)));

// ② 关键：端点探测（「获取模型」）——这正是表单 ready 的前置
const disc = await rpc('llm/discoverModels', {
  settingsNs: 'llm-pi-ai',
  request: { provider: ROUTE, baseURL: `http://127.0.0.1:${GW_PORT}/v1`, api: 'openai-completions',
    apiKey: KEY },
}, cookie);
const discOk = disc.parsed?.result?.ok === true;
const models = disc.parsed?.result?.value;
check('llm/discoverModels 成功（表单才能 ready）', discOk,
  `status=${disc.status} body=${disc.text.slice(0, 300)}`);
if (discOk) {
  check('探测到 2 个模型', Array.isArray(models) && models.length === 2, JSON.stringify(models));
}

// ③ 假网关侧断言：探测必须带 Bearer，且**不能**用 chunked
const probe = seen.find((r) => r.url === '/v1/models');
check('假网关收到探测请求', probe !== undefined, JSON.stringify(seen));
if (probe !== undefined) {
  check('探测带 authorization: Bearer', probe.auth === `Bearer ${KEY}`, JSON.stringify(probe.auth));
  check('探测无 transfer-encoding: chunked', probe.te === undefined, JSON.stringify(probe.te));
  check('探测是 GET /v1/models', probe.method === 'GET' && probe.url === '/v1/models',
    `${probe.method} ${probe.url}`);
}

// ④ 再验证"错误 key 会被如实拒绝"（负测试：401 必须浮现）
const bad = await rpc('llm/discoverModels', {
  settingsNs: 'llm-pi-ai',
  request: { provider: 'gateway-bad', baseURL: `http://127.0.0.1:${GW_PORT}/v1`,
    api: 'openai-completions', apiKey: 'wrong-key' },
}, cookie);
check('错误 key ⇒ 探测失败（如实报错，不静默）', bad.parsed?.result?.ok === false,
  `status=${bad.status} body=${bad.text.slice(0, 200)}`);

writeFileSync(STOP_PATH, `${Date.now()}\n`, 'utf8');
await sleep(3000);
try { child.kill('SIGKILL'); } catch { }
gateway.close();
console.log(`\n${failures === 0 ? '全部通过：自定义模型 API 的端点探测在垫片上可用' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
