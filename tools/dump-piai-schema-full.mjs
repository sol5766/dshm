/**
 * 把 llm-pi-ai 的完整 schema（含 refs）落盘，用于**离线**查看字段定义。
 * 对齐官方 Models 页必须按这份 schema 取候选值（协议、模型字段），不能硬编码。
 *
 * 用法: node tools/dump-piai-schema-full.mjs   → dist/localtest/piai-schema.json
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';

const ROOT = process.cwd();
const RECIPE = JSON.parse(readFileSync(join(ROOT, 'hostcore', 'core-recipe.json'), 'utf8'));
const CORE_DIR = join(ROOT, 'dist', 'core', 'work', `dsh-core-${RECIPE.coreVersion}`);
const HOME = join(ROOT, 'dist', 'localtest', 'schemafull-home');
const SANDBOX = join(ROOT, 'dist', 'localtest', 'schemafull-sandbox');
const ENTRY = join(ROOT, 'hostcore', 'app', 'main.js');
const PORT = Number(process.env.DSHM_CHECK_PORT ?? String(3999 + (process.pid % 80)));
const READY_PATH = join(HOME, 'host-ready.json');
const STOP_PATH = join(HOME, 'host-stop-request');
const OUT = join(ROOT, 'dist', 'localtest', 'piai-schema.json');

rmSync(HOME, { recursive: true, force: true });
rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
mkdirSync(SANDBOX, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    DSHM_SANDBOX_HOME: SANDBOX, DSHM_PORT: String(PORT), DSHM_PROFILE: 'ondevice' },
    stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (b) => { hostLog += b.toString(); });
child.stderr.on('data', (b) => { hostLog += b.toString(); });

const until = Date.now() + 90000;
while (Date.now() < until && !existsSync(READY_PATH)) await sleep(400);
if (!existsSync(READY_PATH)) { console.error('not ready\n' + hostLog.slice(-2000)); process.exit(2); }
const token = String(JSON.parse(readFileSync(READY_PATH, 'utf8')).token ?? '');
const cookie = await new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: PORT,
    path: `/?token=${encodeURIComponent(token)}`, method: 'GET' }, (res) => {
    const sc = res.headers['set-cookie'];
    const c = Array.isArray(sc) ? sc[0] : sc;
    res.resume();
    res.on('end', () => resolve(c === undefined ? undefined : c.split(';')[0]));
  });
  req.end();
});

// 先创建一个实例：某些 schema 分支（union）只在有实例时才展开
const d0 = await rpc('settings/describe', {}, cookie);
const ns0 = (d0.parsed?.result?.value?.namespaces ?? []).find((n) => n.ns === 'llm-pi-ai');
await rpc('settings/mutate', { ns: 'llm-pi-ai',
  ops: [{ op: 'set', path: ['providers', 'probe'], value: {
    baseURL: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKeyEnv: 'PROBE_API_KEY',
    models: [{ id: 'pm', name: 'PM' }] } }],
  expectedRevision: ns0?.revision }, cookie);

const d = await rpc('settings/describe', {}, cookie);
const ns = (d.parsed?.result?.value?.namespaces ?? []).find((n) => n.ns === 'llm-pi-ai');
const dump = {
  ns: 'llm-pi-ai',
  schema: ns.schema,
  value: ns.value,
  user: ns.user,
  base: ns.base,
  revision: ns.revision,
  secrets: ns.secrets,
};
writeFileSync(OUT, JSON.stringify(dump, null, 1), 'utf8');
console.log('written:', OUT, String(JSON.stringify(dump).length) + 'B');
console.log('refs count =', Object.keys(ns.schema?.refs ?? {}).length);

writeFileSync(STOP_PATH, `${Date.now()}\n`, 'utf8');
await sleep(3000);
try { child.kill('SIGKILL'); } catch { }
