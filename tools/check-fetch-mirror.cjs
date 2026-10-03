#!/usr/bin/env node
/*
 * 出网镜像改写的回归检查（N1 / N3 的配套门禁）。
 *
 * 【它守的是什么】
 * `hostcore/app/fetch-shim.js` 里那段"镜像改写"——把**实测不可达**的主机换成可达的镜像。
 * 它之所以放在垫片而不是逐个改插件，是因为端侧三个插件（`dsh-skin-market` 的唯一源、
 * `dsh-our-free-model` 的首选源、`dshmarket` 的硬编码直连）**都**经由 `globalThis.fetch`
 * 出网（jitless ⇒ 原生 fetch/undici 不可用），一处改写三个同时受益、且与插件版本无关。
 *
 * 【为什么这层必须有门禁】
 * 改写逻辑一旦回归，症状是**静默的**：`raw.githubusercontent.com` 被 SNI 阻断后表现为
 * "转很久、列表还是旧的"（皮肤市场 12s 超时后吃本地缓存），而不是报错。没有门禁的话，
 * 只有等用户发现"列表不更新"才会知道。真机取证看 `node-output.log` 的
 * `DSHM-MIRROR <host> → <base>（本进程第 N 次）`；本脚本给的是**离线**侧的等价断言。
 *
 * 【全离线】起一个本地 http 服务当"镜像"，把 `DSHM_FETCH_MIRROR_PREFIX` 指过去，
 * 再请求被改写的主机名 —— 断言本地服务**收到**的 path 正是前缀式代理的约定形态。
 * 因此本脚本不需要外网、也不受"本机 raw 通不通"影响。
 */
'use strict';

const http = require('node:http');
const assert = require('node:assert');

const { dshmFetch } = require('../hostcore/app/fetch-shim.js');

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

/* 被改写的主机必须在表里 —— 这两个是端侧插件写死的"唯一源 / 首选源 / 已死的备用代理"。
 * 断言方式刻意选"行为"而不是"读源码里的表"：读源码只能证明字符串在，证明不了改写生效。 */
const seen = [];
const server = http.createServer((req, res) => {
  seen.push(req.url);
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
});

/** 取"最近一次打进来的 path"，并断言它命中预期（比 `seen.includes` 更能指出是哪次错）。 */
function lastPath() {
  assert.ok(seen.length > 0, '本地镜像一个请求都没收到：说明改写没发生');
  return seen[seen.length - 1];
}
function hits(needle) {
  return seen.filter((url) => url.includes(needle)).length;
}

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const prefix = `http://127.0.0.1:${port}`;
  const opts = { timeoutMs: 5000 };

  /* ── ① 前缀式代理：镜像收到的必须是**完整原始 URL**（含 scheme 与主机） ──
   * 覆盖 `dsh-skin-market/lib/catalog.js`（皮肤目录唯一源）与
   * `dsh-our-free-model/src/{updater,feed}.js`（首选源）这两条链的 URL 形态。 */
  await check('① raw.githubusercontent.com → 前缀式代理（path 含完整原始 URL）', async () => {
    seen.length = 0;
    process.env.DSHM_FETCH_MIRROR_PREFIX = prefix;
    await dshmFetch('http://raw.githubusercontent.com/kingOfSoySauce/dsh-skin-market/main/data/catalog.json', {}, opts);
    assert.strictEqual(
      lastPath(),
      '/https://raw.githubusercontent.com/kingOfSoySauce/dsh-skin-market/main/data/catalog.json',
    );
  });

  /* ── ② 换主机保路径 ──
   * `ghfast.top` 自身形态与前缀式代理一致（`https://ghfast.top/https://raw.githubusercontent.com/...`），
   * 所以只换主机。它同时是 `dshmarket/lib/regions.js:56` 写死的备用代理（已死）。
   * 【为什么这条要紧】N3 的症状是"主代理抽风时空等 30s"——备用代理本身是死的，等不到任何东西。 */
  await check('② ghfast.top（已死的备用代理）→ 换主机、path 原样保留', async () => {
    seen.length = 0;
    await dshmFetch('http://ghfast.top/https://raw.githubusercontent.com/a/b/c.json', {}, opts);
    assert.strictEqual(lastPath(), '/https://raw.githubusercontent.com/a/b/c.json');
  });

  /* ── ③ 表外主机必须放行 ──
   * 表里只放**实测不可达**的主机：改写是可叠加的，若把可达主机也吸进镜像，
   * 镜像自身失联时会把本来正常的链路一起拖死。 */
  await check('③ 表外主机放行（不产生任何改写）', async () => {
    seen.length = 0;
    await dshmFetch('http://example.invalid/keep/me.json', {}, opts).catch(() => {});
    assert.strictEqual(hits('keep/me'), 0, '表外主机被改写了：镜像表加了未实测的条目');
  });

  /* ── ④ 开关 ── 排查用：确认"关掉改写"能真的关掉（否则排障时会以为是别的问题） */
  await check('④ DSHM_FETCH_MIRROR=0 时整体关闭', async () => {
    seen.length = 0;
    process.env.DSHM_FETCH_MIRROR = '0';
    await dshmFetch('http://raw.githubusercontent.com/mirror-off.json', {}, opts).catch(() => {});
    assert.strictEqual(hits('mirror-off'), 0, '开关置 0 后仍在改写');
    delete process.env.DSHM_FETCH_MIRROR;
  });

  /* ── ⑤ DNS 钉住时不得改写（SSRF 防护） ──
   * 上游 `web_fetch` 先自己解析、再用 lookup 把地址钉死（防解析与连接之间被重绑定）。
   * 那批地址是针对**原主机**解析的 —— 换了主机继续透传等于把请求指向错的 IP，
   * 所以这条不是"少改一个"，是**必须**不改。 */
  await check('⑤ lookup 钉住时不改写（DNS 钉住的地址不会打到镜像）', async () => {
    seen.length = 0;
    process.env.DSHM_FETCH_MIRROR_PREFIX = prefix;
    const pinned = () => { const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; };
    await dshmFetch('http://raw.githubusercontent.com/pinned.json', {}, { ...opts, timeoutMs: 3000, lookup: pinned })
      .catch(() => {});
    assert.strictEqual(hits('pinned'), 0, 'lookup 钉住时仍被改写：SSRF 防护被绕过');
  });

  /* ── ⑥ 配置错误不得**改错路**，也不得变成"改写自身的错误" ──
   * 前缀可由 `DSHM_FETCH_MIRROR_PREFIX` 覆盖（镜像自身失联时无需改代码）。配错时（如漏了
   * scheme）必须**回退原 URL**：请求仍然发给原主机、镜像一个字节都收不到。
   *
   * 【为什么这里允许抛错，且不算失败】回退之后就是去连**原主机**——本机上
   * `raw.githubusercontent.com` 正是被 SNI 阻断的那台（实测 `ECONNRESET`），所以这条
   * 抛错是**原主机不可达**，与改写无关。真正要守的是：错误不能是"改写把 URL 拼坏了"
   * 那一类（`TypeError: Invalid URL`）——那才是配置笔误污染了出网路径。 */
  await check('⑥ 前缀不可解析时回退原 URL（镜像收不到，且不是改写自身报错）', async () => {
    seen.length = 0;
    process.env.DSHM_FETCH_MIRROR_PREFIX = 'not-a-url';
    const outcome = await dshmFetch('http://raw.githubusercontent.com/badprefix.json', {}, { ...opts, timeoutMs: 8000 })
      .then((r) => ({ kind: 'resolved', status: r.status }), (e) => ({ kind: 'threw', error: e }));
    assert.strictEqual(hits('badprefix'), 0, '前缀配错时仍打到了镜像：回退没生效');
    if (outcome.kind === 'threw') {
      const message = String((outcome.error && outcome.error.message) || outcome.error);
      assert.ok(
        !/Invalid URL/i.test(message),
        `前缀配错导致了改写自身的报错（说明回退没走通，改写的失败被暴露给了调用方）：${message}`,
      );
      console.log(`    （回退后打到原主机，本机该主机不可达 ⇒ 如实抛错：${message}）`);
    } else {
      console.log(`    （原主机本轮可达 ⇒ status=${outcome.status}）`);
    }
    delete process.env.DSHM_FETCH_MIRROR_PREFIX;
  });

  server.close();
  console.log(failures === 0
    ? '\n全部通过：出网镜像改写（N1/N3）在离线可复现范围内行为正确'
    : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})();
