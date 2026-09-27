#!/usr/bin/env node
/*
 * fetch 垫片的回归检查（D6 E52 的配套验证）。
 *
 * 【为什么必须带 `--jitless` 跑】垫片的**存在理由**就是 jitless：`--jitless` 隐含关掉 WASM，
 * Node 自带 undici（用 WASM 版 llhttp）因此无法初始化，原生 fetch 在端侧不可用。
 * 所以：
 *     node --jitless --no-experimental-fetch tools/check-fetch-shim.cjs
 * 不带这两个开关的话，本脚本会在第 ① 步直接失败——那正是它要证明的前提。
 *
 * 覆盖 dsh 实际用到的面（`dsh-llm-deepseek/lib/index.js:1770` 的 POST JSON + signal、
 * 响应 `.ok/.status/.headers/.text()/.json()`，以及附件上传要用的 FormData）。
 */
'use strict';

const http = require('node:http');
const assert = require('node:assert');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}: ${error && error.message}`);
  }
}

(async () => {
  // ① 前提：原生 fetch 必须**不可用**（否则测的不是垫片）
  assert.notStrictEqual(typeof globalThis.fetch, 'function',
    '原生 fetch 竟然可用：本检查需要在 --no-experimental-fetch 下运行');
  console.log('前提成立：globalThis.fetch 不可用（jitless/无 undici）');

  // ② 安装垫片
  const { installFetchShim } = require('../hostcore/app/fetch-shim.js');
  const installed = installFetchShim();
  assert.strictEqual(installed, true, 'installFetchShim() 应返回 true');
  assert.strictEqual(typeof globalThis.fetch, 'function', '安装后 fetch 应为函数');
  console.log('垫片已安装\n');

  // ③ 真实 HTTPS GET（走 node:https 的 TLS，验证非 WASM 路径可用）
  await check('HTTPS GET https://example.com → 200 + text()', async () => {
    const res = await fetch('https://example.com/');
    assert.strictEqual(res.status, 200, `status=${res.status}`);
    assert.strictEqual(res.ok, true);
    const body = await res.text();
    assert.ok(body.includes('Example Domain'), '响应体应含 Example Domain');
    assert.ok((res.headers.get('content-type') || '').includes('text/html'), 'content-type 应可读');
  });

  // ④ 真实 HTTPS GET + json()（较大响应，验证流式读取拼接）
  await check('HTTPS GET https://nodejs.org/dist/index.json → json()', async () => {
    const res = await fetch('https://nodejs.org/dist/index.json');
    assert.strictEqual(res.status, 200, `status=${res.status}`);
    const list = await res.json();
    assert.ok(Array.isArray(list) && list.length > 0, 'json 应为非空数组');
    assert.ok(typeof list[0].version === 'string');
  });

  // ⑤ 本地 POST：JSON body + content-type + 双向读写
  const received = {};
  const server = http.createServer((req, res) => {
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('chunk-1');
      setTimeout(() => res.end('chunk-2'), 100);
      return;
    }
    if (req.url === '/slow') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      setTimeout(() => res.end('late'), 3000);
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.method = req.method;
      received.contentType = req.headers['content-type'];
      received.body = Buffer.concat(chunks).toString('utf8');
      res.writeHead(201, { 'content-type': 'application/json', 'x-dshm-test': 'yes' });
      // multipart 的 body 不是 JSON：只在真的是 JSON 时才解析（否则服务器自己会抛未捕获异常）
      const isJson = (req.headers['content-type'] || '').includes('json');
      res.end(JSON.stringify({ echo: isJson ? JSON.parse(received.body).hello : 'multipart' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  await check('本地 POST JSON → 201 + json() + 自定义头', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({ hello: 'world' }),
    });
    assert.strictEqual(res.status, 201, `status=${res.status}`);
    assert.strictEqual(received.method, 'POST');
    assert.strictEqual(received.contentType, 'application/json');
    assert.strictEqual(JSON.parse(received.body).hello, 'world');
    assert.strictEqual(res.headers.get('x-dshm-test'), 'yes');
    const payload = await res.json();
    assert.strictEqual(payload.echo, 'world');
  });

  await check('FormData 上传（multipart + boundary）', async () => {
    const form = new FormData();
    form.append('purpose', 'assistants');
    form.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'a.txt');
    const res = await fetch(`http://127.0.0.1:${port}/files`, { method: 'POST', body: form });
    assert.strictEqual(res.status, 201, `status=${res.status}`);
    assert.ok(received.contentType.startsWith('multipart/form-data; boundary='), received.contentType);
    assert.ok(received.body.includes('name="purpose"') && received.body.includes('hello'), 'multipart 应含字段与文件内容');
  });

  await check('stream（response.body 是 ReadableStream，可逐块读）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/stream`);
    const reader = res.body.getReader();
    const first = await reader.read();
    assert.strictEqual(first.done, false, '应能读到第一块');
    assert.ok(Buffer.from(first.value).length > 0);
    await reader.cancel();
  });

  await check('signal 中止 → 请求被拒', async () => {
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/slow`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    let rejected = false;
    try {
      await pending;
    } catch (error) {
      rejected = true;
    }
    assert.strictEqual(rejected, true, '中止后应 reject');
  });

  server.close();
  console.log(failures === 0 ? '\n全部通过：fetch 垫片在 jitless 下可用' : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})();
