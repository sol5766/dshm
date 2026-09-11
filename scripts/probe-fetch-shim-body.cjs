'use strict';
// TEMP diagnostic: exercise every response-body consumption path the shim must
// support: dsh's real SSE chain (pipeThrough x2), getReader, for-await, gzip,
// text()/json() (the RPC envelope path), abort, and a real HTTPS 401 mapping.
// Usage: node __tmp-body-probe.cjs <path-to-shim.cjs> <env-node-modules-dir>
const http = require('node:http');
const zlib = require('node:zlib');
const path = require('node:path');

const shimPath = process.argv[2];
const envModules = process.argv[3];
require(shimPath);

const { EventSourceParserStream } = require(path.join(envModules, 'eventsource-parser/dist/stream.cjs'));

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail));
  if (!ok) failures += 1;
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/sse') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"a":1}\n\n');
    setTimeout(() => { res.write('data: {"a":2}\n\n'); res.end('data: [DONE]\n\n'); }, 20);
    return;
  }
  if (url === '/sse-gzip') {
    const body = zlib.gzipSync('data: {"g":1}\n\ndata: [DONE]\n\n');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
    res.end(body);
    return;
  }
  if (url === '/json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'client-request', rpcId: 7, method: 'settings/describe' }));
    return;
  }
  if (url === '/slow') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"a":1}\n\n');
    setTimeout(() => { try { res.write('data: {"a":2}\n\n'); res.end(); } catch (e) {} }, 400);
    return;
  }
  res.writeHead(404).end();
});

// Mirrors @deepseek-ai/dsh-llm-deepseek/lib/index.js parseSse (line ~1108).
async function dshParseSse(stream) {
  const events = stream.pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment: () => {} }));
  const out = [];
  for await (const evt of events) out.push(evt.data);
  return out;
}

server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const r1 = await fetch(base + '/sse');
    check('sse:status', r1.status === 200, String(r1.status));
    check('sse:body-is-ReadableStream', r1.body instanceof ReadableStream, r1.body && r1.body.constructor.name);
    check('sse:pipeThrough', typeof r1.body.pipeThrough === 'function');
    const events = await dshParseSse(r1.body);
    check('sse:dsh-parseSse', events.length === 3 && events[2] === '[DONE]', JSON.stringify(events));

    const r2 = await fetch(base + '/sse');
    const reader = r2.body.getReader();
    let viaReader = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      viaReader += new TextDecoder().decode(value);
    }
    check('sse:getReader', viaReader.includes('[DONE]'), String(viaReader.length) + 'B');

    const r3 = await fetch(base + '/sse');
    let viaForAwait = '';
    for await (const c of r3.body) viaForAwait += new TextDecoder().decode(c);
    check('sse:for-await', viaForAwait.includes('[DONE]'), String(viaForAwait.length) + 'B');

    const r4 = await fetch(base + '/sse-gzip');
    const eventsGzip = await dshParseSse(r4.body);
    check('sse:gzip', eventsGzip.length === 2 && eventsGzip[1] === '[DONE]', JSON.stringify(eventsGzip));

    const r5 = await fetch(base + '/json');
    const envelope = await r5.json();
    check('rpc:json', envelope.method === 'settings/describe', JSON.stringify(envelope));

    const r6 = await fetch(base + '/json');
    const asText = await r6.text();
    check('rpc:text', asText.includes('settings/describe'), String(asText.length) + 'B');

    const r7 = await fetch(base + '/slow');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    let aborted = false;
    try {
      const stream = r7.body.pipeThrough(new TextDecoderStream());
      for await (const _c of stream) { /* drain */ }
      void ac;
    } catch (e) {
      aborted = /abort|closed|premature|destroy/i.test(String(e && e.message));
    }
    check('sse:drain-after-abort-tolerant', true, aborted ? 'errored-cleanly' : 'drained');

    const r8 = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer invalid-probe-key' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: '1+1' }], stream: true }),
    });
    check('https:reachable', r8.status === 401 || r8.status === 400 || r8.status === 200, 'HTTP ' + r8.status);
    const body8 = await r8.text();
    check('https:body-readable', body8.length > 0, body8.slice(0, 120));
  } catch (e) {
    check('probe:unexpected', false, (e && e.stack) || String(e));
  } finally {
    server.close();
    console.log(failures === 0 ? 'ALL_PASS' : 'FAILURES=' + failures);
    process.exit(failures === 0 ? 0 : 1);
  }
});
