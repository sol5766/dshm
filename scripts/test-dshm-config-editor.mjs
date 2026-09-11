import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const pluginPath = path.resolve('entry/src/main/resources/rawfile/dsh/node_modules/dshm-config-editor/lib/index.js');
const plugin = await import(pathToFileURL(pluginPath).href);
const tempDir = mkdtempSync(path.join(tmpdir(), 'dshm-config-editor-'));
const settingsPath = path.join(tempDir, 'settings.yaml');
writeFileSync(settingsPath, 'general:\n  locale: zh\n', 'utf8');

const routes = new Map();
const host = {
  webServer: {
    register(definition) {
      const key = definition.path + ':' + definition.handler.name + ':' + routes.size;
      routes.set(key, definition.handler);
      return () => routes.delete(key);
    }
  },
  settings: {
    async prepareDocument() {
      return settingsPath;
    }
  },
  effect(callback) {
    return callback();
  }
};

plugin.apply({
  inject(names, callback) {
    assert.deepEqual(names, ['webServer', 'settings']);
    callback(host);
  }
});

const handlers = [...routes.values()];
// DSHM: GET and POST share one exact route (dsh-host-webserver rejects
// duplicate (kind, path) registrations), dispatched by request method.
assert.equal(handlers.length, 1, 'editor must register a single method-dispatching route');
const handler = handlers[0];

function createResponse() {
  return {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status;
    },
    end(body = '') {
      this.body = String(body);
    }
  };
}

function createRequest(method, body, origin = 'http://127.0.0.1:3080') {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const request = Readable.from(chunks);
  request.method = method;
  request.headers = { host: '127.0.0.1:3080', origin };
  return request;
}

async function invoke(handler, method, body, origin) {
  const response = createResponse();
  await handler(createRequest(method, body, origin), response);
  return { status: response.status, body: JSON.parse(response.body) };
}

try {
  const initial = await invoke(handler, 'GET');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.ok, true);
  assert.equal(typeof initial.body.revision, 'string');

  const saved = await invoke(handler, 'POST', {
    content: 'general:\n  locale: en\n',
    revision: initial.body.revision
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ok, true);
  assert.equal(readFileSync(settingsPath, 'utf8'), 'general:\n  locale: en\n');

  const stale = await invoke(handler, 'POST', {
    content: 'general:\n  locale: zh\n',
    revision: initial.body.revision
  });
  assert.equal(stale.status, 409);
  assert.equal(readFileSync(settingsPath, 'utf8'), 'general:\n  locale: en\n');

  const invalid = await invoke(handler, 'POST', {
    content: 'general: [\n',
    revision: saved.body.revision
  });
  assert.equal(invalid.status, 400);
  assert.equal(readFileSync(settingsPath, 'utf8'), 'general:\n  locale: en\n');

  const rejected = await invoke(handler, 'GET', undefined, 'https://untrusted.example');
  assert.equal(rejected.status, 403);
  console.log('dshm-config-editor route tests passed');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
