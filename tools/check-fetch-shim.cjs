#!/usr/bin/env node
/*
 * fetch 垫片的回归检查（D6 E52 的配套验证）。
 *
 * 【为什么必须带 `--jitless` 跑】垫片的**存在理由**就是 jitless：`--jitless` 隐含关掉 WASM，
 * Node 自带 undici（用 WASM 版 llhttp）因此无法初始化，原生 fetch 在端侧不可用。
 * 所以：
 *     node --jitless tools/check-fetch-shim.cjs
 *
 * 【2026-09-28 修：前提断言建错了 flag 语义】原先是
 *     node --jitless --no-experimental-fetch tools/check-fetch-shim.cjs
 * 并且 ① 断言「原生 fetch 必须**不可用**」。但 Node 24 起 fetch 已转正、**不再提供**
 * `--no-experimental-fetch`（传了直接死在 CLI 解析：`invalid negation because it is not
 * a boolean option`）⇒ 不带 flag 时 ① 因"原生 fetch 竟然可用"而 FAIL、带上 flag 时进程
 * 根本起不来。两条路都红，而**红的原因都不是垫片坏了**——是这把尺子量错了对象。
 *
 * 真正的等价前提是 **WASM 不可用**，这也正是 `hostcore/app/fetch-shim.js:549` 的判据：
 *     if (typeof globalThis.fetch === 'function' && typeof WebAssembly !== 'undefined') return false;
 * 即垫片自己就承认"原生 fetch 存在 ≠ 能用"。所以本脚本改为：
 *   ① 断言 `WebAssembly === undefined`（跑 `--jitless` 即成立）；
 *   ①′ 顺带**取证**原生 fetch 在此时确实炸（报 `WebAssembly is not defined`）——
 *      这才是"垫片有必要"的证据，比"原生 fetch 不存在"更贴近 Node 24 的现实；
 *   ② 再装垫片并断言它返回 true。
 * 没带 `--jitless` 时脚本会**自己重新拉起自己**并补上该 flag（`spawnSync(..., {stdio:'inherit'})`），
 * 免得"忘了加 flag"被误读成"代码失败"。
 *
 * 覆盖 dsh 实际用到的面（`dsh-llm-deepseek/lib/index.js:1770` 的 POST JSON + signal、
 * 响应 `.ok/.status/.headers/.text()/.json()`，以及附件上传要用的 FormData）。
 *
 * 【2026-10-06 扩：请求方向的流式体】`DshmRequest` 曾把流式体一律吞掉且**不设 `body`**，
 * 而全仓唯一的 `streaming` 路由（`/api/session/uploadFileBinary`，附件上传）正是靠
 * `request.body` 拿字节 ⇒ 真机上"对话框上传文件"永远失败、报文只剩 ATTACHMENT_WRITE_FAILED
 * （真因见 docs/111）。下面 ⑧′/⑧″ 就是这条的回归断言 + 对照臂。
 */
'use strict';

const http = require('node:http');
const assert = require('node:assert');

/*
 * 【自己补 --jitless】不带该 flag 时 WASM 可用，本脚本量的就不是垫片了。
 * 这里重新拉起自己一次（`stdio:'inherit'` 直通输出），而不是报错退出——
 * 「忘了加 flag」不该长得像「代码失败」。
 */
if (typeof WebAssembly !== 'undefined' && process.env.DSHM_FETCH_SHIM_RERUN !== '1') {
  const { spawnSync } = require('node:child_process');
  console.log('注：未带 --jitless，已自动用 `--jitless` 重新拉起本脚本（WASM 不可用才是垫片的前提）\n');
  const rerun = spawnSync(process.execPath, ['--jitless', __filename], {
    stdio: 'inherit',
    env: { ...process.env, DSHM_FETCH_SHIM_RERUN: '1' },
  });
  process.exit(rerun.status === null ? 1 : rerun.status);
}

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
  /*
   * ① 前提：WASM 必须**不可用**（`--jitless` 隐含关掉它）。这是垫片存在的前提，
   * 也是它与 `installFetchShim()` 共用的判据（`fetch-shim.js`：
   * `if (typeof globalThis.fetch === 'function' && typeof WebAssembly !== 'undefined') return false;`）
   * ——注意**不是**"原生 fetch 是否存在"。
   */
  assert.strictEqual(typeof WebAssembly, 'undefined',
    'WebAssembly 竟然可用：本检查需要在 --jitless 下运行');
  console.log(`前提成立：WebAssembly 不可用（node ${process.version} + --jitless）`);

  /*
   * 【必须在装垫片之前抓住原生 fetch 的引用】装完之后 `globalThis.fetch` 就是垫片本身了，
   * "取证原生 fetch 坏在哪"就无从谈起（2026-09-28 踩过：拿装完后的引用去探，探的是自己，
   * 于是"原生 fetch 没炸"这个假结论反而把真 bug 挡住了）。
   */
  const nativeFetch = globalThis.fetch;

  // 本地 server 提到取证之前：①′ 需要一个**真的活着**的地址（理由见下）
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

  /*
   * ①′ 取证：原生 fetch 在此时**确实坏**，且**坏因就是 WebAssembly**。
   *
   * 【为什么必须换掉旧探针（2026-09-28）】旧版用 `http://127.0.0.1:9/never`，而 **9 是
   * fetch 规范里禁用的端口**：原生 fetch 在**入口**就报 `bad port` 返回，
   * **根本没走到 undici 的解析器**。于是"reason 里没有 WebAssembly 字样"被误读成
   * "本机 jitless 没关 WASM"，把一条真 bug 挡在了后面。
   * 实测：换成活着的本地 server 后立刻得到
   *     TypeError: fetch failed / cause: ReferenceError: WebAssembly is not defined
   * 【判据也收紧了】只认 WebAssembly 相关字样——旧版 `/WebAssembly|not defined|fetch failed/i`
   * 里那个 `fetch failed` 太宽，任何网络错误都能满足它，等于没判。
   */
  await check('取证：原生 fetch 在 jitless 下不可用（WebAssembly is not defined）', async () => {
    if (typeof nativeFetch !== 'function') {
      console.log('    （本机原生 fetch 不存在，取证项自动成立）');
      return;
    }
    let reason = '';
    try {
      await nativeFetch(`http://127.0.0.1:${port}/probe`);
    } catch (error) {
      reason = String((error && (error.cause && error.cause.message)) || (error && error.message) || error);
    }
    assert.ok(
      /WebAssembly|not defined/i.test(reason),
      `原生 fetch 竟然可用，或坏因不是 WASM（reason=${reason || '(无异常)'}）⇒ 本机量不到垫片`,
    );
    console.log(`    取证成立：原生 fetch 失败原因 = ${reason}`);
  });

  // ② 安装垫片
  const { installFetchShim, DshmFormData, DshmHeaders } = require('../hostcore/app/fetch-shim.js');
  const { Readable } = require('node:stream');
  const installed = installFetchShim();
  assert.strictEqual(installed, true, 'installFetchShim() 应返回 true（WASM 不可用时必须覆盖原生 fetch）');
  assert.strictEqual(typeof globalThis.fetch, 'function', '安装后 fetch 应为函数');
  console.log('垫片已安装\n');

  /*
   * ③④ 真实 HTTPS GET：验证"非 WASM 路径可用"（走 node:https 的 TLS，不经 undici 的 llhttp）。
   *
   * 【为什么这两条允许 SKIP（2026-09-28）】本机实测 `https://example.com/` **裸 https.get 就超时**
   * （`ERR timeout 5029ms`），而 `https://nodejs.org/dist/index.json` 是 `200 / 331923B / 1379ms`。
   * 也就是说 ③ 的那条红**是网络，不是垫片**。把它记成"代码失败"会掩盖真问题
   * （`docs/90` §3.6 的教训「『环境问题』这个标签会掩盖它内部的 bug」反过来同样成立）。
   * 但也不能一律放过：**必须有一侧成功**才足以把原因归给主机；两条都链路层失败时，
   * 无法区分"本机不通外网"与"垫片的 TLS 路径坏了"⇒ 报 FAIL 并写明歧义。
   * 离线环境可显式跳过：`DSHM_FETCH_SHIM_SKIP_REMOTE=1`。
   */
  const remote = { attempted: 0, ok: 0, transport: [] };
  async function remoteCheck(name, fn) {
    if (process.env.DSHM_FETCH_SHIM_SKIP_REMOTE === '1') {
      console.log(`  skip ${name}（DSHM_FETCH_SHIM_SKIP_REMOTE=1）`);
      return;
    }
    remote.attempted += 1;
    try {
      await fn();
      remote.ok += 1;
      console.log(`  ok   ${name}`);
    } catch (error) {
      const code = (error && error.cause && error.cause.code) || (error && error.code) || '';
      const LINK_CODES = [
        'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
        'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'ABORT_ERR',
      ];
      /*
       * 【别只看 code —— 2026-09-28 实测】`withTimeout` 触发的 abort 抛出来的 error
       * **`code` 是空的**，特征在 `name === 'AbortError'`（Node 24，fetch 规范域）。
       * 只看 code 就会把"本机这个主机连不上、被我们自己的 8s 超时掐掉"记成**代码失败**
       * ——正是上一段注释刚说要避免的那种误判，我自己在同一个函数里又犯了一次。
       */
      const isOurTimeout = error && error.name === 'AbortError';
      const reason = isOurTimeout ? 'AbortError（本脚本 8s 超时）' : code;
      if (!isOurTimeout && !LINK_CODES.includes(code)) {
        failures += 1;
        console.error(`  FAIL ${name}: ${error && error.message}`);
        return;
      }
      remote.transport.push(`${reason} @ ${name}`);
      console.log(`  skip ${name}：链路层失败 ${reason}（不计入代码失败）`);
    }
  }

  // 自加超时：环境不通时不要靠系统 TCP 超时干等（本机 example.com 实测 5s 才回）
  async function withTimeout(ms, run) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  await remoteCheck('HTTPS GET https://example.com → 200 + text()', async () => {
    const res = await withTimeout(8000, (signal) => fetch('https://example.com/', { signal }));
    assert.strictEqual(res.status, 200, `status=${res.status}`);
    assert.strictEqual(res.ok, true);
    const body = await res.text();
    assert.ok(body.includes('Example Domain'), '响应体应含 Example Domain');
    assert.ok((res.headers.get('content-type') || '').includes('text/html'), 'content-type 应可读');
  });

  // ④ 真实 HTTPS GET + json()（较大响应，验证流式读取拼接）
  await remoteCheck('HTTPS GET https://nodejs.org/dist/index.json → json()', async () => {
    const res = await withTimeout(8000, (signal) => fetch('https://nodejs.org/dist/index.json', { signal }));
    assert.strictEqual(res.status, 200, `status=${res.status}`);
    const list = await res.json();
    assert.ok(Array.isArray(list) && list.length > 0, 'json 应为非空数组');
    assert.ok(typeof list[0].version === 'string');
  });

  if (remote.attempted > 0 && remote.ok === 0 && remote.transport.length === remote.attempted) {
    failures += 1;
    console.error(`  FAIL 远端两条**全部**链路层失败（${remote.transport.join('、')}）⇒ 无法区分"本机不通外网"与"垫片的 TLS 路径坏了"。若是前者，请带 DSHM_FETCH_SHIM_SKIP_REMOTE=1 重跑。`);
  } else if (remote.transport.length > 0) {
    console.log(`  note 有远端主机不可达（${remote.transport.join('、')}），按环境跳过；同批另有 ${remote.ok} 条远端成功 ⇒ 垫片的 TLS 路径已被证明。`);
  }

  /*
   * ⑤ 本地 POST：JSON body + content-type + 双向读写。
   * 本地 server 已在**上面**起好（①′ 需要一个真活着的探针地址）——
   * 2026-09-28 首次修这个脚本时漏删了这一段旧定义，导致同作用域重复声明 `received`/`port`
   * ⇒ 语法错，脚本连第 ① 步都进不去。改这个文件时注意只有一处 server。
   */
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

  /*
   * 【这条是 2026-09-28 那个真 bug 的回归断言】`hostcore/app/fetch-shim.js` 原先只认
   * `instanceof DshmFormData`，而 `installFetchShim()` 不替换已存在的全局 FormData
   * （Node 24 启动就自带，且不依赖 WASM）⇒ 调用方（dsh 附件上传）拿的是**原生** FormData
   * ⇒ 体退化成 `Buffer.from(String(body))` = 字面量 `"[object FormData]"`（17 字节）。
   *
   * 【为什么断言要写得这么"啰嗦"】第一版只判 `received.contentType.startsWith(...)`，
   * 故障注入时（把 `isForeignFormData` 那一支短路）报的是
   * "Cannot read properties of undefined (reading 'startsWith')" —— **症状在下一跳**，
   * 读的人看不出是"FormData 没被编码"，更看不出体变成了一串字面量。
   * 下面先把两件事各自判清，最后才判 content-type：失败信息直接点名缺陷。
   */
  await check('FormData 上传（multipart + boundary）', async () => {
    const form = new FormData();
    form.append('purpose', 'assistants');
    form.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'a.txt');
    const res = await fetch(`http://127.0.0.1:${port}/files`, { method: 'POST', body: form });
    assert.strictEqual(res.status, 201, `status=${res.status}`);
    assert.notStrictEqual(
      received.contentType,
      undefined,
      `请求体没被当成 FormData 编码（服务端读到的 content-type=undefined，body=${JSON.stringify(received.body)}）：`
        + '原生 FormData 落进了 `Buffer.from(String(body))` 那一支（encodeRequestBody 缺少 isForeignFormData 分支）',
    );
    assert.ok(
      !received.body.includes('[object FormData]'),
      `请求体退化成了字面量：body=${JSON.stringify(received.body)}（应为 multipart 正文）`,
    );
    assert.ok(
      String(received.contentType).startsWith('multipart/form-data; boundary='),
      `content-type 应为 multipart 且带 boundary，实际 ${JSON.stringify(received.contentType)}`,
    );
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

  /*
   * ── ⑧′ 请求方向的流式体（2026-10-06 的真 bug 回归断言）─────────────────────
   *
   * 【被量的是什么】`dsh-client-connection/lib/index.js:75-81` 的 `bridge()` 对声明为
   * `streaming` 的路由构造 `new Request(url, {body: Readable.toWeb(req), duplex: 'half'})`；
   * 处理器（`dsh-client-file-upload` 的 `/api/session/uploadFileBinary`）随后读
   * `request.body` → `body.getReader()`。所以"垫片给不给 `body`"就是这条路由的生死线。
   *
   * 【探针写成函数是为了给它配对照臂】判据必须能**判红**：下面立刻用一个"照旧实现"
   * （流式体一律吞成 `_body=null`、不设 `body`）跑同一段探针，它必须报 not-ok。
   * 没有这个对照臂，探针有可能恒绿（例如把 `req.body` 换成别的东西也能"读到串"）。
   */
  const STREAM_CHUNKS = ['hello-', 'stream'];
  const streamBodyProbe = async (RequestImpl) => {
    const req = new RequestImpl('http://dsh.internal/api/session/uploadFileBinary?name=x.txt', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Readable.toWeb(Readable.from(STREAM_CHUNKS.map((s) => Buffer.from(s)))),
      duplex: 'half',
    });
    if (req.body === null || req.body === undefined) {
      return { ok: false, why: `request.body === ${String(req.body)}（流式体被吞掉 ⇒ 处理器会掉进 undefined.getReader()）` };
    }
    if (typeof req.body.getReader !== 'function') {
      return { ok: false, why: `request.body 不是可读流（getReader=${typeof req.body.getReader}）` };
    }
    const reader = req.body.getReader();
    const chunks = [];
    for (;;) {
      const step = await reader.read();
      if (step.done === true) break;
      chunks.push(Buffer.from(step.value));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const want = STREAM_CHUNKS.join('');
    return text === want ? { ok: true, text } : { ok: false, why: `读出 ${JSON.stringify(text)}，应为 ${JSON.stringify(want)}` };
  };

  await check('请求流式体保真（streaming 路由的 request.body 可读）', async () => {
    const probe = await streamBodyProbe(globalThis.Request);
    assert.strictEqual(probe.ok, true, probe.why);
  });

  await check('对照臂：吞掉流式体的 Request 实现必须被判红', async () => {
    /* 「照旧实现」：只认 Buffer，其余一律 `_body = null`，且**不设** `body`。 */
    class DroppingRequest {
      constructor(input, init = {}) {
        this.url = String(input);
        this.method = init.method === undefined ? 'GET' : String(init.method).toUpperCase();
        this.headers = init.headers instanceof DshmHeaders ? init.headers : new DshmHeaders(init.headers);
        this.signal = init.signal;
        this.bodyUsed = false;
        this._body = Buffer.isBuffer(init.body) ? init.body : null;
      }
    }
    const probe = await streamBodyProbe(DroppingRequest);
    assert.strictEqual(probe.ok, false,
      '对照臂竟然判绿 ⇒ 上面的断言量不到"流式体被吞"这件事（探针失效）');
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
