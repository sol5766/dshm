/**
 * 报告 9 的四项修复 —— 回归断言（对应报告 §5 的五条用例 + 补强）。
 *
 * 【为什么单独写这个脚本】报告 §5 明确建议"可直接进 CI"。放进 tools/ 与
 * 其它 assert-*.mjs 同级，便于和其它门禁一起跑。
 *
 * 【判据全部来自行为，不看实现】每条都给"输入 → 期望输出"，失败即报错退出非 0。
 * 特别地：
 *   · 缺陷1 用**原生 Headers**（不是普通对象）当输入 —— 这正是真机 401 的触发形态
 *   · 缺陷2 必须用**中文 body**验证长度按字节算（字符数算会漏过）
 *   · 缺陷4 用"设置页写入后的 patch"当输入，验证非种子条目被保留
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIM = path.join(ROOT, 'hostcore', 'app', 'fetch-shim.js');
const ROWS = path.join(ROOT, 'hostcore', 'app', 'dshm-user-rows.js');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`ok  : ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? `  — ${detail}` : ''}`);
    console.log(`FAIL: ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

const shim = require(SHIM);
const rows = require(ROWS);

// ══ 1) DshmHeaders 接受原生 Headers ═════════════════════════════════════
console.log('\n# 1) 原生 Headers 传进 DshmHeaders（缺陷1）');
{
  const H = shim.DshmHeaders;
  ok('DshmHeaders 已导出', typeof H === 'function');

  const native = new Headers({ authorization: 'Bearer k', 'content-type': 'application/json' });
  const h = new H(native);
  ok('authorization 被保留', h.get('authorization') === 'Bearer k', `实际 ${JSON.stringify(h.get('authorization'))}`);
  ok('content-type 被保留', h.get('content-type') === 'application/json', `实际 ${JSON.stringify(h.get('content-type'))}`);
  ok('has() 认得该头', h.has('authorization') === true);

  // 报告 §5 第 1 条后半：重复 append 的合并语义
  const h2 = new H([['a', '1'], ['a', '2']]);
  ok('同名多次 append → "1, 2"', h2.get('a') === '1, 2', `实际 ${JSON.stringify(h2.get('a'))}`);

  // Map 也应走同一支（判据用能力，不用类名）
  const hm = new H(new Map([['x', 'y']]));
  ok('Map 也支持', hm.get('x') === 'y', `实际 ${JSON.stringify(hm.get('x'))}`);

  // 普通对象仍要工作（不能为新支路破坏旧行为）
  const ho = new H({ 'x-a': '1' });
  ok('普通对象仍工作（无回归）', ho.get('x-a') === '1');

  // Headers 实例（我们自己的）仍工作
  const hh = new H(new H({ 'a-b': 'c' }));
  ok('DshmHeaders 实例仍工作（无回归）', hh.get('a-b') === 'c');
}

// ══ 2) content-length 与 transfer-encoding ══════════════════════════════
console.log('\n# 2) 已知长度 body 设置 Content-Length（缺陷2）');
{
  const src = fs.readFileSync(SHIM, 'utf8');
  // 静态判据：源码里确实存在"设置 content-length"与"删 transfer-encoding"
  ok('源码设 content-length', /headers\.set\(\s*['"]content-length['"]/.test(src));
  ok('源码删 transfer-encoding', /headers\.delete\(\s*['"]transfer-encoding['"]/.test(src));

  // 动态判据：起一个本地 HTTP 服务，实测收到的头
  const http = require('node:http');
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({
      auth: req.headers['authorization'],
      cl: req.headers['content-length'],
      te: req.headers['transfer-encoding'],
      method: req.method,
      bodyLen: 0,
    });
    let n = 0;
    req.on('data', (c) => { n += c.length; });
    req.on('end', () => {
      seen[seen.length - 1].bodyLen = n;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // 【关键】中文 body：字符数 20 左右、字节数更大；用字符数算长度必然被这条测出来
  const body = JSON.stringify({ 模型: '中文测试', 内容: '中文内容会变长' });
  const byteLen = Buffer.byteLength(body);

  await shim.dshmFetch(`http://127.0.0.1:${port}/v1/chat`, {
    method: 'POST',
    headers: new Headers({ authorization: 'Bearer k' }),
    body,
  });

  const got = seen[0];
  ok('服务端收到 authorization', got && got.auth === 'Bearer k', `实际 ${JSON.stringify(got && got.auth)}`);
  ok('content-length 等于**字节数**',
    got && got.cl === String(byteLen),
    `期望 ${byteLen}（字节），实际 ${got && got.cl}`);
  ok('无 transfer-encoding: chunked',
    got && got.te === undefined,
    `实际 ${JSON.stringify(got && got.te)}`);
  ok('content-length 不等于字符数（中文用例有效性）',
    String(body.length) !== String(byteLen),
    `字符 ${body.length} vs 字节 ${byteLen}`);

  // 3) Request 形态（报告 §5 第 3 条）
  console.log('\n# 3) Request 形态（method/headers/body 不丢）');
  // 【为什么用鸭子类型而不是 new DshmRequest】DshmRequest 未从垫片导出
  // （第一版脚本因此 TypeError）。而本修复的判据是"**任何**长得像 Request、
  // 带 url+method 的对象都要被展开"——用形状构造正好测到这个语义，
  // 比依赖某个具体类更贴近真实调用（openai SDK 传的是原生 Request）。
  await shim.dshmFetch({
    url: `http://127.0.0.1:${port}/v1/chat`,
    method: 'POST',
    headers: new Headers({ authorization: 'Bearer k' }),
    text: async () => '{}',
  });
  const got2 = seen[seen.length - 1];
  ok('Request 形态：method 未丢', got2 && got2.method === 'POST', `实际 ${got2 && got2.method}`);
  ok('Request 形态：头未丢', got2 && got2.auth === 'Bearer k', `实际 ${got2 && got2.auth}`);
  ok('Request 形态：body 未丢', got2 && got2.bodyLen === 2, `实际 ${got2 && got2.bodyLen}`);

  await new Promise((r) => server.close(r));
}

// ══ 4) entryCandidates：纯类型包放行，真半残仍拦 ════════════════════════
console.log('\n# 4) entryCandidates 语义（缺陷3）');
{
  const ec = rows.entryCandidates;
  ok('entryCandidates 已导出', typeof ec === 'function');

  const t1 = ec({ name: '@types/trusted-types', main: '', types: 'index.d.ts' });
  ok('纯类型包（types）→ 空候选（放行）', Array.isArray(t1) && t1.length === 0, `实际 ${JSON.stringify(t1)}`);

  const t2 = ec({ name: 'x', main: '', typings: 'index.d.ts' });
  ok('纯类型包（typings）→ 空候选', Array.isArray(t2) && t2.length === 0, `实际 ${JSON.stringify(t2)}`);

  // 【不能放宽真正的半残】main 为空、也没 types ⇒ 仍按 index.js 判
  const t3 = ec({ name: 'broken', main: '' });
  ok('main 空且无 types → 仍判 index.js（不放宽半残）',
    Array.isArray(t3) && t3.includes('index.js'), `实际 ${JSON.stringify(t3)}`);

  // 正常包不受影响
  const t4 = ec({ name: 'normal', main: 'lib/main.js' });
  ok('正常 main 仍取 main', t4.includes('lib/main.js'), `实际 ${JSON.stringify(t4)}`);
}

// ══ 5) 缺陷 4：非种子条目被保留 ═════════════════════════════════════════
console.log('\n# 5) profile patch 保留非种子条目（缺陷4）');
{
  const carry = rows.carryForeignTopLevelEntries;
  ok('carryForeignTopLevelEntries 已导出', typeof carry === 'function');

  const seed = [
    '# 种子头注释',
    '- id: subprocess',
    '  disabled: false',
    '- id: sandbox',
    '  disabled: false',
    '- insert:',
    '  - id: ui-directory-picker-native',
    '    name: \'@deepseek-ai/dsh-client-ui-directory-picker-native\'',
  ].join('\n');

  // 设置页写入的形态（模拟 dsh 0.1.7 SettingsForms 的 llm-pi-ai 路由段）
  const userWritten = [
    '- id: llm-pi-ai',
    '  config:',
    '    models:',
    '      - name: auto',
    '        provider: tencent',
    '- id: llm-pi-ai-wb2api',
    '  config:',
    '    baseURL: http://192.168.1.10:8080/v1',
  ].join('\n');

  // 场景 A：种子 + 用户写的
  const prevA = `${seed}\n${userWritten}\n`;
  const carried = carry(seed, prevA);
  ok('保留用户写的 llm-pi-ai 段', carried.includes('llm-pi-ai'), `实际: ${JSON.stringify(carried.slice(0, 120))}`);
  ok('保留时 context 行跟着走（缩进未丢）', carried.includes('provider: tencent'));
  ok('保留 wb2api 段', carried.includes('llm-pi-ai-wb2api'));

  // 场景 B：种子已有的条目不应被重复保留（升级要能流入）
  const prevB = `${seed}\n- id: subprocess\n  disabled: true\n`;
  const carriedB = carry(seed, prevB);
  ok('种子已有的 id 不重复保留', !carriedB.includes('subprocess'), `实际 ${JSON.stringify(carriedB)}`);

  // 场景 C：上一次写入的托管块必须排除（否则会累积）
  const prevC = `${seed}\n${userWritten}\n\n${rows.USER_ROWS_BEGIN}\n- id: some-plugin\n${rows.USER_ROWS_END}\n`;
  const carriedC = carry(seed, prevC);
  ok('托管块被排除（不累积）', !carriedC.includes('some-plugin'), `实际 ${JSON.stringify(carriedC)}`);

  // 场景 D：首次安装（无 prev）→ 空
  ok('无原文 → 空（首次安装）', carry(seed, '') === '');
}

console.log('\n' + '='.repeat(58));
console.log(`通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
