/**
 * Regression check: the WebSocket upgrade Origin fence (E81/E82).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * dsh's `/api` carriers sit behind `isTrustedApiRequest()`: when a request
 * carries an `Origin` header it must be same-origin with the request `Host`,
 * otherwise the Host answers 403 and the WebSocket upgrade never completes.
 *
 * HarmonyOS's WebSocket client (netstack over libwebsockets) ALWAYS attaches
 * its own `Origin`, and it derives that value from the URL while DROPPING the
 * port (`ws://127.0.0.1:3120/...` becomes `Origin: http://127.0.0.1`). Worse,
 * a caller-supplied `origin` in `WebSocketRequestOptions.header` is APPENDED
 * rather than replaced, so the wire value becomes a comma-joined list:
 *
 *     origin: http://127.0.0.1, ws://127.0.0.1:3120
 *
 * `new URL(thatValue).host` can never equal `127.0.0.1:3120`, so the fence
 * rejects every upgrade with 403 - and the ArkTS client surfaces it as the
 * famously misleading `error code=200`. That is the real reason the phone
 * could not open a single logical stream.
 *
 * The host-side fix (applied by `tools/pack-core.mjs`) accepts an origin LIST
 * and passes when ANY entry is same-origin. This script pins that behaviour:
 *
 *   - `clean`      one correct origin            -> must be 101
 *   - `absent`     no origin at all              -> must be 101
 *   - `duplicated` libwebsockets-shaped list     -> 101 only WITH the patch
 *
 * Run it against the work tree (no device needed):
 *
 *     node tools/check-origin-fence.mjs
 *
 * Exit code 0 = all expectations met.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';

const ROOT = process.cwd();
// 目录名跟随 recipe：coreVersion 变了这里不用改（collect-libvips.mjs 同一课——写死版本号曾让 0.1.6 时代静默错位）
const RECIPE = JSON.parse(readFileSync(join(ROOT, 'hostcore', 'core-recipe.json'), 'utf8'));
const CORE_DIR = join(ROOT, 'dist', 'core', 'work', `dsh-core-${RECIPE.coreVersion}`);
const HOME_DIR = join(ROOT, 'dist', 'localtest', 'origin-check-home');
const PORT = Number(process.env.DSHM_CHECK_PORT ?? '3137');
const MUX_PATH = '/api/remote.mux';
const ENTRY = join(ROOT, 'hostcore', 'app', 'main.js');

if (!existsSync(CORE_DIR)) {
  console.error(`FAIL: core tree not found: ${CORE_DIR}`);
  process.exit(2);
}
if (!existsSync(ENTRY)) {
  console.error(`FAIL: host entry not found: ${ENTRY}`);
  process.exit(2);
}

rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(HOME_DIR, { recursive: true });

/** One raw HTTP request; resolves { status, headers } and never throws. */
function rawRequest(path, headers) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path, method: 'GET', headers },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode, headers: res.headers });
      },
    );
    req.on('upgrade', (res) => {
      resolve({ status: res.statusCode, headers: res.headers, upgraded: true });
    });
    req.on('error', (err) => resolve({ status: 0, error: String(err && err.message) }));
    req.setTimeout(6000, () => {
      req.destroy();
      resolve({ status: 0, error: 'timeout' });
    });
    req.end();
  });
}

/** Poll until the Host really answers, or give up. */
async function waitReady(deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const res = await rawRequest('/', {});
    if (res.status > 0) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * 等 Host 真正「宣告」自己的 auth URL（host-ready.json 落盘），而不是只等端口有应答。
 *
 * 为什么必须单独等文件：`waitReady()` 把任何 `status > 0` 视为就绪，而 0.2.1-alpha.1 起上游的启动顺序
 * 变了一点点——**先**应答一个 404（webServer 已监听、connection 信任栅栏与 auth URL 尚未就绪），
 * **后**才写 host-ready.json。0.2.0-rc.2 是反过来的（先落盘 +5415ms、再以 401 应答 +5631ms）。
 * 旧写法于是变成「应答即读文件、读到就过、读不到就退 2」，把上游的正常顺序变化误报成失败。
 * 只等文件这一条对两版都成立，且比「只看状态码」更贴近门禁真正的前提。
 */
async function waitHostReadyFile(deadlineMs) {
  const readyPath = join(HOME_DIR, 'host-ready.json');
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (existsSync(readyPath)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return existsSync(readyPath);
}

/** Mint the browser cookie exactly like a browser would: GET /?token=... */
async function mintCookie() {
  const readyPath = join(HOME_DIR, 'host-ready.json');
  if (!existsSync(readyPath)) return { ok: false, reason: 'host-ready.json missing' };
  const ready = JSON.parse(readFileSync(readyPath, 'utf8'));
  const token = String(ready.token ?? '');
  if (token.length === 0) return { ok: false, reason: 'token empty in host-ready.json' };
  const res = await rawRequest(`/?token=${encodeURIComponent(token)}`, {});
  const setCookie = res.headers?.['set-cookie'];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (typeof first !== 'string' || first.length === 0) {
    return { ok: false, reason: `no set-cookie (status=${res.status})` };
  }
  return { ok: true, cookie: first.split(';')[0] };
}

const WS_HEADERS = {
  Connection: 'Upgrade',
  Upgrade: 'websocket',
  'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
  'Sec-WebSocket-Version': '13',
};

// 与端侧 RuntimePort.buildHostArgv（hostruntime/.../runtime/RuntimePort.ets:125）对齐：
// 不带 --no-experimental-fetch（libnode v24 fetch 已转正，否定形态死在 CLI 解析，
// fetch 由 fetch-shim.js 运行期接管）；必须带 --expose-internals（require-builtin-shim 的前提）。
const child = spawn(
  process.execPath,
  ['--jitless', '--experimental-sqlite', '--expose-internals', ENTRY],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      DSHM_CORE_DIR: CORE_DIR,
      DSHM_HOME: HOME_DIR,
      DSHM_SANDBOX_HOME: HOME_DIR,
      DSHM_PORT: String(PORT),
      DSHM_PROFILE: 'ondevice',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let hostLog = '';
child.stdout.on('data', (b) => { hostLog += b.toString(); });
child.stderr.on('data', (b) => { hostLog += b.toString(); });

function shutdown(code) {
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  if (code !== 0) {
    console.error('---- host log tail ----');
    console.error(hostLog.split('\n').slice(-25).join('\n'));
  }
  process.exit(code);
}

const results = [];
let failed = false;

try {
  // 【为什么可用环境变量放宽】端侧 Host 的启动时间随机器差别很大：本机（Orange Pi 5B，
  // 且工作区还在 NFS 上）实测 `BOOT_60_HTTP_BIND … (+62951ms)`——**63 秒**，恰好越过这里的 60 秒，
  // 于是门禁报 "host never answered"，而事实是 Host 正常、`GET /` 正确返回 401（信任栅栏）。
  // 同目录的 check-plugin-toggle 用的是 90 秒，所以它在本机能过。
  // 默认值保持不变（可能是别人 CI 的口径），慢机器上显式放宽：
  //   DSHM_CHECK_READY_MS=180000 node tools/check-origin-fence.mjs
  const readyMs = Number(process.env.DSHM_CHECK_READY_MS ?? '60000');
  const ready = await waitReady(readyMs);
  if (!ready) {
    console.error(`FAIL: host never answered on 127.0.0.1:${PORT}`);
    shutdown(2);
  }
  // waitReady 只证明「端口有人应答」，0.2.1-alpha.1 起上游会先给一个 404（见 waitHostReadyFile 注释），
  // 所以再等 host-ready.json 真正落盘；只等文件这一条对 0.2.0-rc.2 与 0.2.1-alpha.1 都成立。
  const fileWaitMs = Number(process.env.DSHM_CHECK_READY_FILE_MS ?? '20000');
  if (!(await waitHostReadyFile(fileWaitMs))) {
    console.error(`FAIL: host answered on 127.0.0.1:${PORT} but host-ready.json never appeared within ${fileWaitMs}ms`);
    shutdown(2);
  }
  const cookie = await mintCookie();
  if (!cookie.ok) {
    console.error(`FAIL: could not mint cookie: ${cookie.reason}`);
    shutdown(2);
  }
  console.log(`host ready on 127.0.0.1:${PORT}; cookie ${cookie.cookie.length}B`);

  const cases = [
    {
      name: 'clean',
      expect: 101,
      headers: { ...WS_HEADERS, cookie: cookie.cookie, origin: `http://127.0.0.1:${PORT}` },
    },
    {
      name: 'absent',
      expect: 101,
      headers: { ...WS_HEADERS, cookie: cookie.cookie },
    },
    {
      // Exactly what HarmonyOS/libwebsockets puts on the wire.
      name: 'duplicated',
      expect: 101,
      headers: {
        ...WS_HEADERS,
        cookie: cookie.cookie,
        origin: `http://127.0.0.1, ws://127.0.0.1:${PORT}`,
      },
    },
    {
      // Negative control: a genuinely foreign origin must still be refused.
      name: 'foreign',
      expect: 403,
      headers: { ...WS_HEADERS, cookie: cookie.cookie, origin: 'http://evil.example' },
    },
    {
      // Negative control: no cookie must still be refused.
      name: 'no-cookie',
      expect: 401,
      headers: { ...WS_HEADERS, origin: `http://127.0.0.1:${PORT}` },
    },
  ];

  for (const c of cases) {
    const res = await rawRequest(MUX_PATH, c.headers);
    const got = res.status;
    const ok = got === c.expect;
    if (!ok) failed = true;
    results.push({ name: c.name, expect: c.expect, got, ok, error: res.error });
  }

  console.log('');
  console.log('case        expect  got   verdict');
  for (const r of results) {
    console.log(
      `${r.name.padEnd(11)} ${String(r.expect).padEnd(7)} ${String(r.got).padEnd(5)} ` +
      `${r.ok ? 'ok' : 'MISMATCH'}${r.error === undefined ? '' : ` (${r.error})`}`,
    );
  }
  console.log('');
  console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
  shutdown(failed ? 1 : 0);
} catch (err) {
  console.error(`FAIL: ${String(err)}`);
  shutdown(2);
}
