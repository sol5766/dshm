/**
 * Regression check: plugin row enable/disable through `$DSH_HOME/cordis.patch.yml`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The objective requires plugin management on device. Installing a plugin is
 * impossible (upstream shells out to pnpm, and HarmonyOS forbids process
 * creation), but *enabling/disabling a row that already ships in the core* is a
 * pure file operation - and dsh's own profile layering reads exactly one
 * user-owned file for it:
 *
 *     bundle patch -> <profile>/cordis.patch.yml -> $DSH_HOME/cordis.patch.yml -> --patch
 *
 * So the honest feature is "toggle shipped rows, then restart the core", not a
 * marketplace. This script proves the mechanism end to end WITHOUT a device:
 *
 *   1. boot the host with a scratch DSH_HOME, read the plugin inventory
 *   2. stop it through the cooperative stop channel (host-stop-request)
 *   3. write a managed block disabling one safe row (tool-web)
 *   4. boot again and require that row to report `enabled: false`
 *
 * Step 3 is the exact file the ArkTS "插件" page will maintain, so a PASS here
 * means the app-side writer only has to produce this YAML shape.
 *
 * Usage:  node tools/check-plugin-toggle.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';

const ROOT = process.cwd();
// 目录名跟随 recipe：coreVersion 变了这里不用改（collect-libvips.mjs 同一课——写死版本号曾让 0.1.6 时代静默错位）
const RECIPE = JSON.parse(readFileSync(join(ROOT, 'hostcore', 'core-recipe.json'), 'utf8'));
const CORE_DIR = join(ROOT, 'dist', 'core', 'work', `dsh-core-${RECIPE.coreVersion}`);
const HOME = join(ROOT, 'dist', 'localtest', 'plugin-toggle-home');
const SANDBOX = join(ROOT, 'dist', 'localtest', 'plugin-toggle-sandbox');
const ENTRY = join(ROOT, 'hostcore', 'app', 'main.js');
const PORT = Number(process.env.DSHM_CHECK_PORT ?? String(3200 + (process.pid % 300)));
const READY_PATH = join(HOME, 'host-ready.json');
const STOP_PATH = join(HOME, 'host-stop-request');
const ROWS_PATH = join(HOME, 'profiles', 'ondevice', '.dshm-plugin-rows.yml');

if (!existsSync(CORE_DIR) || !existsSync(ENTRY)) {
  console.error('FAIL: core tree or host entry missing');
  process.exit(2);
}
rmSync(HOME, { recursive: true, force: true });
rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
mkdirSync(SANDBOX, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(path, cookie) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path,
      method: 'GET',
      headers: cookie === undefined ? {} : { cookie },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (err) => resolve({ status: 0, text: String(err && err.message) }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, text: 'timeout' }); });
    req.end();
  });
}

function rpc(endpoint, payload, cookie) {
  const body = Buffer.from(JSON.stringify({
    type: 'client-request', rpcId: `c${Date.now()}`, method: endpoint, payload: { args: payload },
  }), 'utf8');
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: `/api/${endpoint}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        ...(cookie === undefined ? {} : { cookie }),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = undefined; }
        resolve({ status: res.statusCode, text, parsed });
      });
    });
    req.on('error', (err) => resolve({ status: 0, text: String(err && err.message) }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, text: 'timeout' }); });
    req.end(body);
  });
}

let child = null;
let hostLog = '';

// 与端侧 RuntimePort.buildHostArgv（hostruntime/.../runtime/RuntimePort.ets:125）对齐：
// - 不带 --no-experimental-fetch：端侧 libnode v24 里 fetch 已转正，否定形态是
//   invalid negation，进程直接死在 CLI 解析（真机实测，见 files/node-output.log）；
//   fetch 垫片由 fetch-shim.js 运行期无条件接管（jitless 下原生 fetch 本就不可用，无损）。
// - 必须带 --expose-internals：require-builtin-shim.cjs 顶替 node-addon-require-builtin
//   的前提，dsh-app-boot 的 host preparation 要 require("internal/…")。
const HOST_ARGS = ['--jitless', '--experimental-sqlite', '--expose-internals', ENTRY];

function startHost(tag) {
  rmSync(READY_PATH, { force: true });
  child = spawn(process.execPath, HOST_ARGS, {
    cwd: ROOT,
      env: {
        ...process.env,
        DSHM_CORE_DIR: CORE_DIR,
        DSHM_HOME: HOME,
        DSHM_SANDBOX_HOME: SANDBOX,
        DSHM_PORT: String(PORT),
        DSHM_PROFILE: 'ondevice',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  child.stdout.on('data', (b) => { hostLog += b.toString(); });
  child.stderr.on('data', (b) => { hostLog += b.toString(); });
  console.log(`${tag}: starting host on ${PORT} ...`);
}

async function waitReady() {
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    if (existsSync(READY_PATH)) {
      try {
        const r = JSON.parse(readFileSync(READY_PATH, 'utf8'));
        if (Number(r.port) === PORT) return true;
      } catch { /* still writing */ }
    }
    await sleep(400);
  }
  return false;
}

async function stopHost() {
  writeFileSync(STOP_PATH, `${Date.now()}\n`, 'utf8');
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const res = await get('/');
    if (res.status === 0) return true;
    await sleep(400);
  }
  return false;
}

async function mintCookie() {
  const token = String(JSON.parse(readFileSync(READY_PATH, 'utf8')).token ?? '');
  const res = await get(`/?token=${encodeURIComponent(token)}`);
  const setCookie = res.headers?.['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0];
  return typeof cookie === 'string' && cookie.length > 0 ? cookie : undefined;
}

/**
 * Pick a row to toggle: it must be ENABLED in the baseline and belong to the
 * "plain tool" family, because disabling a service/provider row can make the
 * host fail loud on the next boot (which would report a boot failure instead of
 * the mechanism result we are after).
 */
const TOGGLE_CANDIDATES = [
  'include:tool-web', 'include:tool-todo', 'include:tool-skill', 'include:tool-present',
  'include:tool-ask-user', 'include:ui-deliverables', 'include:session-stats',
];

function pickTargetRow(snapshot) {
  const entries = snapshot?.entries ?? [];
  for (const id of TOGGLE_CANDIDATES) {
    const hit = entries.find((e) => String(e.entryId) === id && e.enabled === true);
    if (hit !== undefined) return String(hit.entryId);
  }
  // Fallback: first enabled row whose id looks like a tool and is not a provider
  for (const e of entries) {
    const id = String(e.entryId);
    if (e.enabled === true && /tool-/.test(id) && !/provider|llm|model|webserver|gateway/.test(id)) {
      return id;
    }
  }
  return undefined;
}

function rowState(snapshot, id) {
  const entries = snapshot?.entries ?? [];
  const hit = entries.find((e) => String(e.entryId) === id)
    ?? entries.find((e) => String(e.moduleName ?? '').includes(id));
  return hit === undefined ? undefined : { entryId: String(hit.entryId), enabled: hit.enabled === true, moduleName: String(hit.moduleName) };
}

function die(message, code) {
  try { if (child !== null) child.kill('SIGKILL'); } catch { /* gone */ }
  console.error(message);
  if (code !== 0) {
    console.error('---- host log tail ----');
    console.error(hostLog.split('\n').slice(-15).join('\n').slice(0, 2000));
  }
  process.exit(code);
}

try {
  // ── 1. baseline boot ────────────────────────────────────────────────────
  startHost('baseline');
  if (!(await waitReady())) die('FAIL: baseline host never became ready', 2);
  let cookie = await mintCookie();
  if (cookie === undefined) die('FAIL: could not mint cookie', 2);
  const before = await rpc('pluginInventory/list', {}, cookie);
  if (before.status !== 200 || before.parsed?.result?.ok === false) {
    die(`FAIL: pluginInventory/list -> ${before.status} ${before.text.slice(0, 300)}`, 1);
  }
  const snapshotBefore = before.parsed?.result?.value;
  console.log(`baseline: ${(snapshotBefore?.entries ?? []).length} entries`);
  const targetRow = pickTargetRow(snapshotBefore);
  if (targetRow === undefined) {
    const enabled = (snapshotBefore?.entries ?? []).filter((e) => e.enabled === true)
      .map((e) => String(e.entryId)).slice(0, 20);
    die(`FAIL: no enabled tool row to toggle; enabled rows: ${enabled.join(', ')}`, 1);
  }
  const rowBefore = rowState(snapshotBefore, targetRow);
  console.log(`baseline: target=${targetRow.replace('include:', '')} enabled=${String(rowBefore?.enabled)}`);

  // ── 2. stop through the cooperative channel (E90) ───────────────────────
  if (!(await stopHost())) die('FAIL: host did not stop (stop channel broken)', 1);
  console.log('stopped (stop channel ok)');

  // ── 3. write the user-owned rows file (the exact app-side contract) ─────
  //
  // dsh's user layer is `<profile dir>/cordis.patch.yml` (dsh-app-boot/lib/index.js:861),
  // and the host re-writes that file from the core seed on EVERY boot - so writing it
  // directly cannot persist. The app therefore owns a side file and lets the entry
  // script compose seed + user rows before dsh reads it (see hostcore/app/main.js E91).
  //
  // The row id here is the PROFILE ROW id (e.g. `ui-deliverables`), not the Loader
  // entry id the inventory reports (`include:ui-deliverables`) - patch rows match on
  // the former.
  const rowId = targetRow.replace('include:', '');
  const block = [
    '# 端侧「插件」页维护的用户行：只写「行 id + disabled」。',
    '# 「恢复默认」= 删除本文件（入口脚本下次启动就不会再拼上这段）。',
    `- id: ${rowId}`,
    '  disabled: true',
    '',
  ].join('\n');
  writeFileSync(ROWS_PATH, block, 'utf8');
  console.log(`wrote ${ROWS_PATH}`);

  // ── 4. boot again and require the toggle to have taken effect ───────────
  startHost('patched');
  if (!(await waitReady())) die('FAIL: patched host never became ready (row choice may be fatal)', 1);
  cookie = await mintCookie();
  if (cookie === undefined) die('FAIL: could not mint cookie after patch', 2);
  const after = await rpc('pluginInventory/list', {}, cookie);
  if (after.status !== 200 || after.parsed?.result?.ok === false) {
    die(`FAIL: pluginInventory/list after patch -> ${after.status} ${after.text.slice(0, 300)}`, 1);
  }
  const rowAfter = rowState(after.parsed?.result?.value, targetRow);
  console.log(`patched:  target=${targetRow.replace('include:', '')} enabled=${String(rowAfter?.enabled)}`);

  await stopHost();
  if (rowBefore.enabled === true && rowAfter?.enabled === false) {
    console.log('');
    console.log('RESULT: PASS');
    die('', 0);
  }
  console.log('');
  console.log('RESULT: FAIL (row state did not flip through $DSH_HOME/cordis.patch.yml)');
  die('', 1);
} catch (err) {
  die(`FAIL: ${String(err)}`, 2);
}
