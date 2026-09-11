'use strict';
// TEMP diagnostic: reproduce dsh's SSE consumption path against the fetch shim.
// Usage: node __tmp-sse-probe.cjs <path-to-shim.cjs>
const http = require('node:http');
require(process.argv[2]);

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  let n = 0;
  const t = setInterval(() => {
    n += 1;
    res.write('data: {"n":' + n + '}\n\n');
    if (n >= 3) {
      clearInterval(t);
      res.end('data: [DONE]\n\n');
    }
  }, 20);
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ a: 1 }),
    });
    console.log('STATUS', r.status, 'ok=' + r.ok);
    const body = r.body;
    console.log('body ctor=' + (body && body.constructor && body.constructor.name) +
      ' pipeThrough=' + typeof (body && body.pipeThrough) +
      ' getReader=' + typeof (body && body.getReader));
    const txt = body.pipeThrough(new TextDecoderStream());
    let all = '';
    for await (const c of txt) all += c;
    console.log('STREAM_OK bytes=' + all.length);
    console.log('PAYLOAD ' + JSON.stringify(all));
  } catch (e) {
    console.log('STREAM_FAIL ' + (e && e.constructor && e.constructor.name) + ': ' + (e && e.message));
  } finally {
    server.close();
    process.exit(0);
  }
});
