/**
 * 对真实 dsh Host 做协议探测，产出「端点可用性 + 错误码语义」实测矩阵。
 *
 * 用途：D2 §8.4 的证据来源；也可作为 POC-1/POC-3 的辅助工具与 Host 版本漂移回归的基线。
 *
 * 用法：
 *   1) 先启动 Host：dsh web --no-open --port 3111 --host 127.0.0.1
 *   2) node tools/protocol-probe.mjs --base http://127.0.0.1:3111 --token <token>
 *
 * 纪律：本脚本只调用**只读**端点，不创建/修改任何会话或配置。
 */
const args = process.argv.slice(2);
function argOf(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const BASE = argOf('--base', 'http://127.0.0.1:3111');
const TOKEN = argOf('--token', process.env.DSH_PROBE_TOKEN ?? '');

if (TOKEN === '') {
  console.error('缺少 token：请传 --token <token> 或设 DSH_PROBE_TOKEN（取自 Host 打印的启动 URL）');
  process.exit(2);
}

let cookie = '';

async function exchangeToken() {
  const res = await fetch(`${BASE}/?token=${encodeURIComponent(TOKEN)}`, { redirect: 'manual' });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const raw of setCookie) {
    const pair = raw.split(';')[0];
    if (pair.includes('=')) cookie = cookie === '' ? pair : `${cookie}; ${pair}`;
  }
  return { status: res.status, location: res.headers.get('location'), cookies: setCookie.length };
}

async function rpc(endpoint, payload) {
  const rpcId = crypto.randomUUID();
  const started = Date.now();
  let res;
  try {
    res = await fetch(`${BASE}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload })
    });
  } catch (error) {
    return { endpoint, status: 0, ms: Date.now() - started, outcome: `transport: ${error.message}` };
  }
  const ms = Date.now() - started;
  const text = await res.text();
  if (res.status !== 200) {
    return { endpoint, status: res.status, ms, outcome: `HTTP ${res.status}` };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { endpoint, status: res.status, ms, outcome: 'invalid JSON envelope' };
  }
  const rpcIdMatches = json.rpcId === rpcId;
  const ok = json.result?.ok === true;
  if (ok) {
    const value = JSON.stringify(json.result.value);
    return {
      endpoint, status: res.status, ms, rpcIdMatches, outcome: 'ok',
      value: value.length > 160 ? `${value.slice(0, 160)}…` : value
    };
  }
  const err = json.result?.error ?? {};
  return {
    endpoint, status: res.status, ms, rpcIdMatches,
    outcome: `err ${err.code ?? '(no code)'}`,
    message: err.message ?? ''
  };
}

/** 探测清单：全部为只读或无副作用调用 */
const PROBES = [
  // 无参数只读端点
  ['session/modelCatalog', { args: {} }],
  ['pluginInventory/list', { args: {} }],
  ['settings/describe', { args: {} }],
  ['settings/canOpenAgentPresetDirectory', { args: {} }],
  ['agentPresets/list', { args: {} }],
  ['llm/listProviders', { args: {} }],
  ['llm/listConfigurableProviders', { args: {} }],
  ['session/canOpenWorkspacePath', { args: {} }],
  // 需要 _request 包装
  ['session/list', { args: { _request: {} } }],
  // 需要具名参数
  ['credentials/describe', { args: { refs: ['DEEPSEEK_API_KEY'] } }],
  ['llm/discoverModels', { args: { settingsNs: 'agent-default-model', request: {} } }],
  // 断言不存在的端点（验证 404 语义）
  ['workspace/list', { args: {} }],
  ['does/notExist', { args: {} }],
  // 参数形状错误（验证 gateway/arguments-invalid）
  ['session/list', { args: { bogus: 1 } }],
  // 流式端点用一元载体（验证 gateway/signature-invalid）
  ['workspace/follow', { args: {} }]
];

const auth = await exchangeToken();
const rows = [];
for (const [endpoint, payload] of PROBES) {
  rows.push(await rpc(endpoint, payload));
}

console.log('# dsh 协议探测矩阵\n');
console.log(`base    : ${BASE}`);
console.log(`token交换: HTTP ${auth.status}${auth.location ? ` → Location: ${auth.location}` : ''}；收获 cookie ${auth.cookies} 条`);
console.log(`cookie  : ${cookie === '' ? '(空)' : `${cookie.split(';').length} 个（值不打印）`}`);
console.log('');

const header = ['endpoint', 'HTTP', 'rpcId', 'ms', 'outcome', 'detail'];
const widths = [34, 5, 6, 6, 34, 60];
function line(cells) {
  return cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join(' ');
}
console.log(line(header));
console.log(widths.map((w) => '-'.repeat(w)).join(' '));
for (const r of rows) {
  console.log(line([
    r.endpoint, r.status === 0 ? 'N/A' : r.status,
    r.rpcIdMatches === undefined ? '-' : (r.rpcIdMatches ? 'ok' : 'MISMATCH'),
    r.ms, r.outcome, r.value ?? r.message ?? ''
  ]));
}

console.log('\n## 结论摘要\n');
const okCount = rows.filter((r) => r.outcome === 'ok').length;
const errCount = rows.filter((r) => r.outcome.startsWith('err')).length;
const httpCount = rows.filter((r) => r.outcome.startsWith('HTTP')).length;
console.log(`成功 ${okCount} / 业务失败 ${errCount} / HTTP 层失败 ${httpCount} / 共 ${rows.length}`);
const codes = [...new Set(rows.filter((r) => r.outcome.startsWith('err')).map((r) => r.outcome.slice(4)))].sort();
console.log(`观察到的错误码：${codes.join(', ')}`);
