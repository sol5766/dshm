/**
 * 从 dsh-api-remotes 与插件 lib/client.js 的完整生成调用提取全量权威端点契约。
 * 不执行上游代码，不混收声明包中的残缺 methods 块，也不跨对象猜 package。
 * 默认核心树来自 hostcore/core-recipe.json；环境变量仅用于显式跨版本取证。
 * 用法：DSH_NODE_MODULES=<node_modules> node tools/protocol-contract.mjs --json <文件>
 * 自检：node tools/protocol-contract.mjs --self-test
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

/** 仅做词法切片；引号、转义、注释中的括号与逗号不参与结构配对。 */
function* tokens(src) {
  for (let i = 0; i < src.length;) {
    if (/\s/.test(src[i])) { i++; continue; }
    if (src.startsWith('//', i)) {
      const end = src.indexOf('\n', i + 2);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error('未闭合的注释');
      i = end + 2;
      continue;
    }
    const start = i;
    const quote = src[i];
    if (quote === '"' || quote === "'" || quote === '`') {
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
      if (i >= src.length) throw new Error('未闭合的字符串');
      i++;
    } else if (/[A-Za-z0-9_$]/.test(src[i])) {
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) i++;
    } else {
      i++;
    }
    yield { text: src.slice(start, i), start, end: i };
  }
}

function unquote(text = '') {
  const t = text.trim();
  return ['"', "'", '`'].includes(t[0]) && t.at(-1) === t[0] ? t.slice(1, -1) : t;
}

function closingIndex(list, start) {
  const closing = { '{': '}', '[': ']', '(': ')' };
  const stack = [];
  for (let i = start; i < list.length; i++) {
    const text = list[i].text;
    if (Object.hasOwn(closing, text)) stack.push(closing[text]);
    else if (['}', ']', ')'].includes(text)) {
      if (stack.pop() !== text) throw new Error(`生成描述符括号不匹配：位置 ${list[i].start}，符号 ${text}`);
      if (stack.length === 0) return i;
    }
  }
  throw new Error('生成描述符对象未闭合');
}

/** 顶层键可为标识符，或单/双/反引号字符串。 */
function entries(objText) {
  const list = [...tokens(objText)];
  if (list[0]?.text !== '{' || list.at(-1)?.text !== '}') throw new Error('预期对象字面量');
  const out = [];
  for (let i = 1; i < list.length - 1;) {
    if (list[i].text === ',') { i++; continue; }
    const key = unquote(list[i++].text);
    if (list[i++]?.text !== ':') throw new Error(`描述符键 ${key} 缺少冒号`);
    const start = i;
    while (i < list.length - 1 && list[i].text !== ',') {
      if (['{', '[', '('].includes(list[i].text)) i = closingIndex(list, i) + 1;
      else i++;
    }
    out.push({ key, value: objText.slice(list[start].start, list[i - 1].end) });
  }
  return out;
}

function fields(text) {
  return new Map(entries(text).map(({ key, value }) => [key, value]));
}

function parameters(text = '[]') {
  const list = [...tokens(text)];
  if (list[0]?.text !== '[' || list.at(-1)?.text !== ']') throw new Error('预期参数数组');
  const out = [];
  for (let i = 1; i < list.length - 1;) {
    if (list[i].text === ',') { i++; continue; }
    if (list[i].text !== '{') throw new Error('预期参数对象');
    const end = closingIndex(list, i);
    const p = fields(text.slice(list[i].start, list[end].end));
    const name = unquote(p.get('name'));
    if (!name) throw new Error('参数缺少 name');
    out.push({ name, wire: p.has('wire') ? unquote(p.get('wire')) : name });
    i = end + 1;
  }
  return out;
}

function descriptor(value, id, namespace, method, streamProps) {
  const d = fields(value);
  const service = unquote(d.get('service'));
  const invocationKind = unquote(fields(d.get('invocation') ?? '{}').get('kind'));
  if (!service || !['direct', 'scoped'].includes(invocationKind)) {
    throw new Error(`权威契约不完整：${id} 缺少 service / invocation.kind`);
  }
  const declPkg = id.slice(0, id.indexOf('#'));
  // 新生成物自带顶层 mode；只有旧格式未声明 mode 时才回退装饰器。
  const stream = d.has('mode') ? unquote(d.get('mode')) === 'stream'
    : streamProps.has(`${declPkg}#${method}`) || streamProps.has(`${declPkg}#${service}`);
  const result = fields(d.get('result') ?? '{}');
  const loc = fields(d.get('sourceLocation') ?? '{}');
  const file = unquote(loc.get('file'));
  return {
    id, pkg: 'dsh-api-remotes', service, namespace, method,
    kind: stream ? 'stream' : invocationKind, invocationKind,
    cancellable: d.has('cancellation'), params: parameters(d.get('parameters')),
    resultSymbol: unquote(result.get('typeSymbol')),
    source: file ? `${file}:${unquote(loc.get('line'))}` : ''
  };
}

/** 重复 id 和重复线上 endpoint 均拒绝；不能由 Map 静默覆盖冲突。 */
export function validateContracts(descriptors) {
  if (!Array.isArray(descriptors) || descriptors.length === 0) throw new Error('解析到 0 个 endpoint，拒绝空契约');
  const ids = new Set();
  const endpoints = new Set();
  for (const d of descriptors) {
    const key = `${d.namespace}/${d.method}`;
    if (!d.id || !d.namespace || !d.method) throw new Error('端点标识不完整');
    if (ids.has(d.id)) throw new Error(`重复契约 id：${d.id}`);
    if (endpoints.has(key)) throw new Error(`重复线上 endpoint：${key}`);
    ids.add(d.id);
    endpoints.add(key);
  }
  return descriptors;
}

export function parseRemoteDescriptors(src, streamProps = new Set()) {
  // 客户端业务代码含正则和嵌套模板；仅对生成调用内部做词法扫描，避免把业务正则当字符串。
  const callTexts = [];
  const marker = /\bcreateTypertRemoteInfo\s*\(\s*\{/g;
  let match;
  while ((match = marker.exec(src)) !== null) {
    const prefix = src.slice(0, match.index);
    if (prefix.lastIndexOf('/*') > prefix.lastIndexOf('*/')) continue;
    const start = match.index;
    const stack = [];
    let began = false;
    for (const token of tokens(src.slice(start))) {
      if (['{', '[', '('].includes(token.text)) { stack.push(token.text); began = true; }
      else if (['}', ']', ')'].includes(token.text)) {
        stack.pop();
        if (began && stack.length === 0) {
          callTexts.push(src.slice(start, start + token.end));
          marker.lastIndex = start + token.end;
          break;
        }
      }
    }
  }
  const list = [...tokens(callTexts.length ? callTexts.join(';') : src)];
  const parsedSrc = callTexts.length ? callTexts.join(';') : src;
  const out = [];
  let calls = 0;
  for (let i = 0; i < list.length - 2; i++) {
    if (list[i].text !== 'createTypertRemoteInfo' || list[i + 1].text !== '(' || list[i + 2].text !== '{') continue;
    const callEnd = closingIndex(list, i + 1);
    const objectEnd = closingIndex(list, i + 2);
    const spec = fields(parsedSrc.slice(list[i + 2].start, list[objectEnd].end));
    const pkg = unquote(spec.get('package'));
    if (!pkg.startsWith('@deepseek-ai/') || !spec.has('methods')) throw new Error('权威 remote 调用缺少 package / methods');
    for (const entry of entries(spec.get('methods'))) {
      const slash = entry.key.indexOf('/');
      if (slash <= 0 || slash === entry.key.length - 1) throw new Error(`非法 endpoint：${entry.key}`);
      out.push(descriptor(entry.value, `${pkg}#${entry.key}`, entry.key.slice(0, slash), entry.key.slice(slash + 1), streamProps));
    }
    calls++;
    i = callEnd;
  }
  // 旧版生成物是完整 InvocationDescriptor 对象，仅在新调用格式完全缺席时解析。
  if (calls === 0) {
    for (let i = 0; i < list.length - 3; i++) {
      if (list[i].text !== '{' || unquote(list[i + 1].text) !== 'id' || list[i + 2].text !== ':') continue;
      const end = closingIndex(list, i);
      const value = src.slice(list[i].start, list[end].end);
      const d = fields(value);
      if (!d.has('namespace') || !d.has('method') || !d.has('service')) continue;
      out.push(descriptor(value, unquote(d.get('id')), unquote(d.get('namespace')), unquote(d.get('method')), streamProps));
      i = end;
    }
  }
  validateContracts(out);
  return out.sort((a, b) => `${a.namespace}/${a.method}`.localeCompare(`${b.namespace}/${b.method}`));
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) walk(path, acc);
    else if (e.isFile() && e.name.endsWith('.js')) acc.push(path);
  }
  return acc;
}

function legacyStreamProps(scope) {
  const streams = new Set();
  for (const pkg of readdirSync(scope, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    for (const file of walk(join(scope, pkg.name))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/_(\w+)_decorators\s*=\s*\[\s*Remote\(\s*\{\s*mode:\s*(["'`])stream\2/g)) {
        streams.add(`@deepseek-ai/${pkg.name}#${m[1]}`);
      }
    }
  }
  return streams;
}

function selfTest() {
  let tests = 0;
  const check = (fn) => { fn(); tests++; };
  for (const quote of ['"', "'", '`']) {
    const q = (s) => `${quote}${s}${quote}`;
    const method = `{service:${q('svc')},mode:${q('stream')},invocation:{kind:${q('scoped')}},parameters:[{name:${q('agent')},wire:${q('agentId')},codec:{mode:${q('strict')}}}],cancellation:{parameter:${q('signal')}},result:{mode:${q('strict')},typeSymbol:${q('result')}},sourceLocation:{${q('file')}:${q('path.ts')},${q('line')}:42}}`;
    const call = `createTypertRemoteInfo({package:${q('@deepseek-ai/real')},methods:{${q('session/follow')}:${method}}},zod)`;
    const d = parseRemoteDescriptors(`const decoy={package:${q('@deepseek-ai/wrong')},methods:{}};${call}`)[0];
    check(() => assert.equal(d.id, '@deepseek-ai/real#session/follow'));
    check(() => assert.equal(d.kind, 'stream'));
    check(() => assert.equal(d.invocationKind, 'scoped'));
    check(() => assert.deepEqual(d.params, [{ name: 'agent', wire: 'agentId' }]));
    check(() => assert.equal(d.source, 'path.ts:42'));
    check(() => assert.equal(d.resultSymbol, 'result'));
    check(() => assert.equal(d.cancellable, true));
    check(() => assert.throws(() => parseRemoteDescriptors(`${call};${call}`), /重复契约 id/));
    check(() => assert.throws(() => parseRemoteDescriptors(`${call};${call.replace('@deepseek-ai/real', '@deepseek-ai/other')}`), /重复线上 endpoint/));
  }
  const method = `{service:'svc',invocation:{kind:'direct'},parameters:[{name:'request',codec:{mode:'stream'}}],result:{mode:'stream',typeSymbol:'r'}}`;
  const call = (m) => `createTypertRemoteInfo({package:'@deepseek-ai/real',methods:{'session/follow':${m}}},zod)`;
  const streams = new Set(['@deepseek-ai/real#follow']);
  check(() => assert.equal(parseRemoteDescriptors(call(method))[0].kind, 'direct'));
  check(() => assert.equal(parseRemoteDescriptors(call(method), streams)[0].kind, 'stream'));
  check(() => assert.equal(parseRemoteDescriptors(call(method.replace("service:'svc'", "mode:'unary',service:'svc'")), streams)[0].kind, 'direct'));
  check(() => assert.deepEqual(parseRemoteDescriptors(call(method))[0].params, [{ name: 'request', wire: 'request' }]));
  check(() => assert.throws(() => parseRemoteDescriptors(`const declaration={package:'@deepseek-ai/real',methods:{'session/follow':${method}}}`), /0 个 endpoint/));
  check(() => assert.throws(() => parseRemoteDescriptors(call(method.replace("invocation:{kind:'direct'},", ''))), /契约不完整/));
  check(() => assert.equal(parseRemoteDescriptors(`const old={id:'@deepseek-ai/real#session/follow',namespace:'session',method:'follow',${method.slice(1)}`, streams)[0].kind, 'stream'));
  check(() => assert.equal(parseRemoteDescriptors(`/* createTypertRemoteInfo({wrong}) */ ${call(method)}`)[0].resultSymbol, 'r'));
  check(() => assert.throws(() => collectContracts('/__dshm_missing_contract_target__'), /找不到权威契约源/));
  check(() => assert.throws(() => validateContracts([]), /拒绝空契约/));
  console.log(`协议采集自检通过：${tests} 项（引号、完整调用边界、唯一性、顶层 stream 与旧版回退）`);
}

export function recipeNodeModules(root = process.cwd()) {
  const recipe = JSON.parse(readFileSync(join(root, 'hostcore', 'core-recipe.json'), 'utf8'));
  return join(root, 'dist', 'core', 'work', `dsh-core-${recipe.coreVersion}`, 'node_modules');
}

/** 核心汇总和插件的完整远端调用都是权威源；声明包的裸 methods 块不算。 */
export function collectContracts(nm) {
  const scope = join(nm, '@deepseek-ai');
  const sourceFile = join(scope, 'dsh-api-remotes', 'lib', 'client.js');
  if (!existsSync(sourceFile)) throw new Error(`找不到权威契约源：${sourceFile}；请设置 DSH_NODE_MODULES`);
  const streams = legacyStreamProps(scope);
  const files = [sourceFile, ...readdirSync(scope).sort().filter((pkg) => pkg !== 'dsh-api-remotes')
    .map((pkg) => join(scope, pkg, 'lib', 'client.js')).filter((file) => existsSync(file))];
  const byId = new Map();
  const authorities = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    if (file !== sourceFile && !/\bcreateTypertRemoteInfo\s*\(\s*\{/.test(src)) continue;
    const ds = parseRemoteDescriptors(src, streams);
    authorities.push({ file, endpointCount: ds.length });
    for (const d of ds) {
      const prev = byId.get(d.id);
      if (prev && JSON.stringify(prev) !== JSON.stringify(d)) throw new Error(`权威源冲突：${d.id}，${file}`);
      if (!prev) byId.set(d.id, d);
    }
  }
  const descriptors = validateContracts([...byId.values()]).sort((a, b) => `${a.namespace}/${a.method}`.localeCompare(`${b.namespace}/${b.method}`));
  return { descriptors, authorities };
}

function main() {
  if (process.argv.includes('--self-test')) { selfTest(); return; }
  const nm = process.env.DSH_NODE_MODULES ?? recipeNodeModules();
  const { descriptors, authorities } = collectContracts(nm);
  console.log(`# dsh endpoint 调用契约（${descriptors.length} 个 endpoint / ${descriptors.filter((d) => d.kind === 'stream').length} 个流式）`);
  for (const d of descriptors) console.log(`${d.namespace}/${d.method}  ${d.kind}  ${d.cancellable ? 'cancel' : ''}  params: ${d.params.map((p) => p.wire).join(', ')}`);
  const jsonIdx = process.argv.indexOf('--json');
  if (jsonIdx < 0) return;
  const jsonOut = process.argv[jsonIdx + 1];
  if (!jsonOut || jsonOut.startsWith('--')) throw new Error('--json 需要输出路径');
  const version = JSON.parse(readFileSync(join(nm, '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version;
  if (process.env.DSH_VERSION && process.env.DSH_VERSION !== version) throw new Error(`目标版本不符：${process.env.DSH_VERSION} != ${version}`);
  writeFileSync(jsonOut, JSON.stringify(descriptors, null, 2), 'utf8');
  writeFileSync(`${jsonOut}.meta.json`, JSON.stringify({ corePackage: version, capturedAt: new Date().toISOString(), endpointCount: descriptors.length, nodeModules: nm, authorities }, null, 2), 'utf8');
  console.log(`已写入 ${jsonOut} 与元数据（核心包 ${version}）`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
