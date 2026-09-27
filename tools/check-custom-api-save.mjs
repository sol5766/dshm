/**
 * 端到端门禁：**「添加自定义模型 API」的完整保存链**（真实 Host + 真实设置写入）。
 *
 * ---------------------------------------------------------------------------
 * 这一条修的是什么（用户报的"自定义 API 保存不了"）
 * ---------------------------------------------------------------------------
 * 官方 Models 页创建目录外路由的**唯一**入口是「自定义模型 API」表单。
 * 我们此前**没有这个入口**：可添加列表只来自
 * `llm/listProviders ∪ llm/listConfigurableProviders`，那是 **pi-ai 自带目录**——
 * 用户自己的中转站 / 自部署服务两个目录里都没有 ⇒ 界面上无处可加。
 *
 * 本脚本逐步走一遍新 UI（`PiAiProviderSheet`）会发出的**完全相同的写入序列**，
 * 每一步都用**真 Host**验证，最后重启确认配置存活：
 *
 *   1. 新建：`set ['providers','<route>']` = profile（含端点 / API 协议 / 模型目录）
 *   2. 存密钥：`credentials/set <ROUTE>_API_KEY`
 *   3. 编辑：`set ['providers',route,'baseURL']`（逐字段，只写变了的）
 *   4. 改模型目录：`set ['providers',route,'models']`（**整值**，不按下标）
 *   5. 重启 → Host 仍认得该路由、模型目录仍在、密钥仍已配置
 *   6. 删除：`unset ['providers',route]`（并验证密钥仍在——它是独立引用）
 *
 * 判据全部来自**行为**（Host 的 describe / modelCatalog / credentials），不看实现。
 *
 * 用法: node tools/check-custom-api-save.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';

const ROOT = process.cwd();
const RECIPE = JSON.parse(readFileSync(join(ROOT, 'hostcore', 'core-recipe.json'), 'utf8'));
const CORE_DIR = join(ROOT, 'dist', 'core', 'work', `dsh-core-${RECIPE.coreVersion}`);
const HOME = join(ROOT, 'dist', 'localtest', 'custom-api-save-home');
const SANDBOX = join(ROOT, 'dist', 'localtest', 'custom-api-save-sandbox');
const ENTRY = join(ROOT, 'hostcore', 'app', 'main.js');
const PORT = Number(process.env.DSHM_CHECK_PORT ?? String(3410 + (process.pid % 180)));
const READY_PATH = join(HOME, 'host-ready.json');
const STOP_PATH = join(HOME, 'host-stop-request');
const PATCH_PATH = join(HOME, 'profiles', 'ondevice', 'cordis.patch.yml');

if (!existsSync(CORE_DIR) || !existsSync(ENTRY)) {
  console.error('FAIL: core tree or host entry missing');
  process.exit(2);
}
rmSync(HOME, { recursive: true, force: true });
rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
mkdirSync(SANDBOX, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail === undefined ? '' : ' — ' + detail}`);
  }
}

// 与端侧 RuntimePort.buildHostArgv 对齐；密钥走环境变量（credentials/set 之外的第二来源）
const GW_KEY = 'sk-e2e-custom-api';
const HOST_ARGS = ['--jitless', '--experimental-sqlite', '--expose-internals', ENTRY];

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
function ok(r) { return r.parsed?.result?.ok === true; }

let child = null; let hostLog = '';
function boot(tag) {
  rmSync(READY_PATH, { force: true });
  hostLog = '';
  child = spawn(process.execPath, HOST_ARGS, {
    cwd: ROOT,
    env: { ...process.env, DSHM_CORE_DIR: CORE_DIR, DSHM_HOME: HOME,
      DSHM_SANDBOX_HOME: SANDBOX, DSHM_PORT: String(PORT), DSHM_PROFILE: 'ondevice' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => { hostLog += b.toString(); });
  child.stderr.on('data', (b) => { hostLog += b.toString(); });
  console.log(`${tag}: booting on ${PORT} ...`);
}
async function ready() {
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    if (existsSync(READY_PATH)) {
      try { if (Number(JSON.parse(readFileSync(READY_PATH, 'utf8')).port) === PORT) return true; } catch { /* writing */ }
    }
    await sleep(400);
  }
  return false;
}
async function cookieOf() {
  const token = String(JSON.parse(readFileSync(READY_PATH, 'utf8')).token ?? '');
  const r = await get(`/?token=${encodeURIComponent(token)}`);
  const sc = r.headers?.['set-cookie'];
  const c = Array.isArray(sc) ? sc[0] : sc;
  return c === undefined ? undefined : c.split(';')[0];
}
async function stop() {
  writeFileSync(STOP_PATH, `${Date.now()}\n`, 'utf8');
  const until = Date.now() + 20000;
  while (Date.now() < until) { if ((await get('/')).status === 0) return true; await sleep(400); }
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  return false;
}
async function describe(cookie) {
  const d = await rpc('settings/describe', {}, cookie);
  return (d.parsed?.result?.value?.namespaces ?? []).find((n) => n.ns === 'llm-pi-ai');
}
/** 按新 UI 的写入原语发一次 set */
async function setPath(cookie, path, value) {
  const pi = await describe(cookie);
  return rpc('settings/mutate', {
    ns: 'llm-pi-ai', ops: [{ op: 'set', path, value }], expectedRevision: pi?.revision,
  }, cookie);
}
async function unsetPath(cookie, path) {
  const pi = await describe(cookie);
  return rpc('settings/mutate', {
    ns: 'llm-pi-ai', ops: [{ op: 'unset', path }], expectedRevision: pi?.revision,
  }, cookie);
}
async function credentialState(cookie, ref) {
  const r = await rpc('credentials/describe', { refs: [ref] }, cookie);
  const v = r.parsed?.result?.value;
  return { status: r.status, value: v, text: r.text };
}

const ROUTE = 'e2e-gateway';
const KEY_REF = 'E2E_GATEWAY_API_KEY';
const BASE1 = 'http://192.168.7.7:8080/v1';
const BASE2 = 'http://10.4.4.4:9999/v1';

try {
  // ── boot #1 ──
  boot('boot#1');
  if (!(await ready())) {
    console.error('FAIL: host never became ready\n' + hostLog.slice(-2500));
    process.exit(2);
  }
  const c1 = await cookieOf();
  check('能取到 cookie', c1 !== undefined);

  const pi0 = await describe(c1);
  check('Host 有 llm-pi-ai 命名空间', pi0 !== undefined);
  check('初始没有这条路由', !Object.keys(pi0?.value?.providers ?? {}).includes(ROUTE));

  // ── ① 新建（= 浮层「添加」的动作）──
  const profile = {
    displayName: 'E2E 中转站',
    apiKeyEnv: KEY_REF,
    api: 'openai-completions',
    baseURL: BASE1,
    models: [{ id: 'e2e-model-a' }, { id: 'e2e-model-b', name: 'B' }],
  };
  const r1 = await setPath(c1, ['providers', ROUTE], profile);
  check('① 新建路由（set providers.<route>）', ok(r1), r1.text.slice(0, 200));
  const pi1 = await describe(c1);
  const p1 = pi1?.value?.providers?.[ROUTE];
  check('① 路由出现', p1 !== undefined);
  check('① 端点已写入', p1?.baseURL === BASE1, JSON.stringify(p1?.baseURL));
  check('① API 协议已写入', p1?.api === 'openai-completions', JSON.stringify(p1?.api));
  check('① 显示名已写入', p1?.displayName === 'E2E 中转站', JSON.stringify(p1?.displayName));
  check('① 模型目录 2 条', Array.isArray(p1?.models) && p1.models.length === 2,
    JSON.stringify(p1?.models?.length));

  // ── ② 存密钥（= 浮层密钥框）：必须存到 apiKeyEnv 记的引用下 ──
  const r2 = await rpc('credentials/set', { ref: KEY_REF, value: GW_KEY }, c1);
  check('② 写入密钥 credentials/set', ok(r2), r2.text.slice(0, 200));
  const cred = await credentialState(c1, KEY_REF);
  check('② 密钥状态读回为已配置', cred.value?.[KEY_REF]?.configured === true,
    JSON.stringify(cred.value));

  // ── ③ 逐字段编辑端点（= 浮层「保存」只写变了的那一项）──
  const r3 = await setPath(c1, ['providers', ROUTE, 'baseURL'], BASE2);
  check('③ 逐字段改端点（set ...baseURL）', ok(r3), r3.text.slice(0, 200));
  const pi3 = await describe(c1);
  check('③ 端点已更新', pi3?.value?.providers?.[ROUTE]?.baseURL === BASE2,
    JSON.stringify(pi3?.value?.providers?.[ROUTE]?.baseURL));
  check('③ 其它字段未被波及（显示名仍在）',
    pi3?.value?.providers?.[ROUTE]?.displayName === 'E2E 中转站');
  check('③ 模型目录未被波及',
    pi3?.value?.providers?.[ROUTE]?.models?.length === 2);

  // ── ④ 模型目录整值写（加一行）──
  const r4 = await setPath(c1, ['providers', ROUTE, 'models'],
    profile.models.concat([{ id: 'e2e-model-c' }]));
  check('④ 整值写模型目录（set ...models）', ok(r4), r4.text.slice(0, 200));
  const pi4 = await describe(c1);
  check('④ 模型目录变 3 条', pi4?.value?.providers?.[ROUTE]?.models?.length === 3,
    JSON.stringify(pi4?.value?.providers?.[ROUTE]?.models?.length));

  // ── 重启 ──
  if (!(await stop())) child.kill('SIGKILL');
  await sleep(1500);
  boot('boot#2');
  if (!(await ready())) {
    console.error('FAIL: restarted host never became ready\n' + hostLog.slice(-2500));
    process.exit(2);
  }
  const c2 = await cookieOf();
  const pi5 = await describe(c2);
  const p5 = pi5?.value?.providers?.[ROUTE];
  check('⑤ 重启后路由仍在（配置持久）', p5 !== undefined);
  check('⑤ 重启后端点仍是改过的值', p5?.baseURL === BASE2, JSON.stringify(p5?.baseURL));
  check('⑤ 重启后 API 协议仍在', p5?.api === 'openai-completions');
  check('⑤ 重启后模型目录 3 条', p5?.models?.length === 3, JSON.stringify(p5?.models?.length));
  const cred5 = await credentialState(c2, KEY_REF);
  check('⑤ 重启后密钥仍已配置', cred5.value?.[KEY_REF]?.configured === true,
    JSON.stringify(cred5.value));

  // 文件层证据：patch 里确实有这条路由（与 Host 视图一致）
  const patchText = readFileSync(PATCH_PATH, 'utf8');
  check('⑤ 落盘文件里有该路由', patchText.includes(ROUTE));
  check('⑤ 落盘文件里有改后的端点', patchText.includes(BASE2));
  // 托管块（种子 + 用户行）不能被我们的拼装弄坏
  check('⑤ 托管块仍在（种子保护未被破坏）', patchText.includes('# >>> dshm-user-rows'));

  // ── ⑥ 删除（= 浮层「删除这个提供方」）──
  const r6 = await unsetPath(c2, ['providers', ROUTE]);
  check('⑥ 删除路由（unset providers.<route>）', ok(r6), r6.text.slice(0, 200));
  const pi6 = await describe(c2);
  check('⑥ 路由已消失', !Object.keys(pi6?.value?.providers ?? {}).includes(ROUTE));
  // 密钥是**独立引用**：删路由不该顺手删掉它（可能被别处使用），且界面回执要如实说明
  const cred6 = await credentialState(c2, KEY_REF);
  check('⑥ 密钥仍保留（独立引用，不随路由删除）',
    cred6.value?.[KEY_REF]?.configured === true, JSON.stringify(cred6.value));

  // 重启一次，确认删除也持久（避免"删了又回来"）
  if (!(await stop())) child.kill('SIGKILL');
  await sleep(1500);
  boot('boot#3');
  if (!(await ready())) {
    console.error('FAIL: third boot never became ready\n' + hostLog.slice(-2500));
    process.exit(2);
  }
  const c3 = await cookieOf();
  const pi7 = await describe(c3);
  check('⑥ 重启后删除仍生效（没有"删了又回来"）',
    !Object.keys(pi7?.value?.providers ?? {}).includes(ROUTE),
    JSON.stringify(Object.keys(pi7?.value?.providers ?? {})));

  if (!(await stop())) child.kill('SIGKILL');
} catch (e) {
  console.error(`FAIL: ${e && e.stack ? e.stack : e}`);
  try { if (child !== null) child.kill('SIGKILL'); } catch { /* gone */ }
  process.exit(1);
}

console.log(failures === 0
  ? '\n✅ 通过：「自定义模型 API」的创建 / 编辑 / 存密钥 / 重启存活 / 删除 全链路成立'
  : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
