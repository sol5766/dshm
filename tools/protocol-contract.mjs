/**
 * 从 dsh 的**生成调用描述符**中提取权威的 endpoint 调用契约。
 *
 * 依据：`@deepseek-ai/dsh-api-remotes/lib/client.js` 与各包的 `lib/client.js` 内含
 * 「generated InvocationDescriptor」对象，形如：
 *   {
 *     id: "@deepseek-ai/dsh-api-session-controller#session/list",
 *     service, namespace, method,
 *     invocation: { kind: "direct" | "scoped" },
 *     parameters: [ { name, wire, source, codec }, ... ],
 *     cancellation: { parameter: "signal" },   // 可选
 *     result: { mode, typeSymbol },
 *     sourceLocation: { file, line, column }
 *   }
 *
 * 这是**唯一权威**的调用契约来源：参数名（含 `_request` / `request` 这类包装名）、
 * 是否可取消、返回类型符号，全部取自此处——比反推方法名可靠得多。
 *
 * 用法：node tools/protocol-contract.mjs [--json <outfile>]
 *
 * ⚠️ **纪律（E223）：新增任何端点之前，先跑这个工具取该端点的参数表。**
 *    - REQUEST 形态的端点，其**内层字段**要另外查上游 `types.d.ts` 里的请求体接口；
 *    - **不要按"同族端点"推断字段名，也不要照抄自己别处的字段命名**——
 *      本项目因此写错过两次（`commands/execute` 的字段名、`session/selectModel` 的嵌套层级），
 *      两次都是被这套契约工具抓出来的；**设备不在时，这是唯一能提前发现"字段不符"的手段**。
 *    - 找不到上游时本脚本会**明确失败**（不要退化成"没有数据也跑完"——静默失效比报错更糟）。
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * 上游 node_modules 的位置（E218）。
 *
 * 【为什么这么写】原先这里兜底成了一个**硬编码的用户名**（`C:\Users\<别人的名字>\…`），
 * 换一台机器/换一个用户就必然找不到上游，`compat-drift` 这条门禁于是**静默失效**——
 * 门禁失效比门禁报错更糟：它让人以为"检查过了、没问题"。
 * 现在按**当前用户**推导，并在两个候选都找不到时**明确失败**（见 `requireDshNodeModules()`）。
 */
const DSH_NM = process.env.DSH_NODE_MODULES
  ?? join(homedir(), 'AppData', 'Roaming', 'io.github.hairyf.deepseek-harness-desktop',
    'dependencies', 'dsh', 'node_modules');

/** 找不到上游就**直接失败并说清怎么指定**，不要退化成"没有数据也跑完" */
function requireDshNodeModules() {
  const marker = join(DSH_NM, '@deepseek-ai');
  if (!existsSync(marker)) {
    console.error(`找不到上游包目录：${marker}`);
    console.error('请用环境变量指定，例如：');
    console.error('  DSH_NODE_MODULES=<path-to>/dependencies/dsh/node_modules node tools/protocol-contract.mjs --json .research/protocol/contracts.json');
    console.error('（若用本仓库内置的核心树，可指向 dist/core/work/<core>/node_modules）');
    process.exit(1);
  }
  return DSH_NM;
}

requireDshNodeModules();

const jsonIdx = process.argv.indexOf('--json');
const jsonOut = jsonIdx >= 0 ? process.argv[jsonIdx + 1] : undefined;

/**
 * 采集对象的核心包版本。
 *
 * **只读核心包 `@deepseek-ai/dsh` 的 version**，不读外层打包包——外层版本号与协议面无关
 * （D2 §0 已记载这个判定规则）。`DSH_VERSION` 允许显式覆盖，用于脱离安装目录做版本标注。
 */
function coreVersion() {
  if (process.env.DSH_VERSION) {
    return process.env.DSH_VERSION;
  }
  try {
    const pkg = JSON.parse(readFileSync(join(DSH_NM, '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function walk(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile() && e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

/** 用括号配对从 id 起始位置切出一个完整的 `{...}` 对象字面量文本 */
function sliceObject(src, start) {
  let depth = 0;
  let i = start;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return undefined;
}

/** 在对象文本中按深度安全地找某个顶层键的值（字符串感知） */
function topLevelValue(objText, key) {
  let depth = 1;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = 1; i < objText.length - 1; i++) {
    const ch = objText[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth++;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth--;
      continue;
    }
    if (depth === 1 && objText.startsWith(key, i)) {
      const before = objText[i - 1];
      if (before !== undefined && /[A-Za-z0-9_$]/.test(before)) continue;
      let j = i + key.length;
      while (j < objText.length && /\s/.test(objText[j])) j++;
      if (objText[j] !== ':') continue;
      j++;
      while (j < objText.length && /\s/.test(objText[j])) j++;
      const start = j;
      if (objText[j] === '{' || objText[j] === '[') {
        let d = 0;
        let s = false;
        let q = '';
        let esc = false;
        for (; j < objText.length; j++) {
          const c = objText[j];
          if (s) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === q) s = false;
            continue;
          }
          if (c === '"' || c === "'" || c === '`') { s = true; q = c; continue; }
          if (c === '{' || c === '[') d++;
          else if (c === '}' || c === ']') { d--; if (d === 0) { j++; break; } }
        }
        return objText.slice(start, j);
      }
      // 标量值
      let end = j;
      while (end < objText.length && !/[,}\]]/.test(objText[end])) end++;
      return objText.slice(start, end).trim();
    }
  }
  return undefined;
}

const scope = join(DSH_NM, '@deepseek-ai');
const packages = readdirSync(scope, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

/**
 * 第一遍：找出「流式」方法。
 *
 * 为什么必须单独扫：`invocation: { kind }` 只有 `direct` / `scoped`，
 * 流式与否记录在 `Remote` **装饰器**参数里（`Remote({ mode: "stream" })`），
 * 描述符本身不携带该信息。误把流式端点当一元调用会被 Host 以
 * `gateway/signature-invalid` 拒绝（D2 §8.4 实测），因此这个标记必须准确。
 */
const streamProps = new Set();
/** 同时记录带 scope 与不带 scope 两种键，兼容 id 的书写形式 */
for (const pkg of packages) {
  for (const file of walk(join(scope, pkg), [])) {
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(/_(\w+)_decorators\s*=\s*\[\s*Remote\(\s*\{\s*mode:\s*"stream"/g)) {
      streamProps.add(`@deepseek-ai/${pkg}#${m[1]}`);
      streamProps.add(`${pkg}#${m[1]}`);
    }
  }
}

const descriptors = [];
const seen = new Set();

for (const pkg of packages) {
  const files = walk(join(scope, pkg), []);
  for (const file of files) {
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const re = /\{\s*id:\s*"([^"]+)"\s*,\s*service:\s*"([^"]*)"\s*,\s*namespace:\s*"([^"]*)"\s*,\s*method:\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const id = m[1];
      if (seen.has(id)) continue;
      const objText = sliceObject(src, m.index);
      if (objText === undefined) continue;
      seen.add(id);
      const invocationText = topLevelValue(objText, 'invocation') ?? '';
      const invocationKind = (invocationText.match(/kind:\s*"([^"]+)"/) ?? [, 'unknown'])[1];
      // 流式判定：装饰器集合按「声明包#属性名」记录。
      // 关键：descriptor 的**声明包**在 id 里（`<declPkg>#<ns>/<method>`），
      // 而所有 descriptor 都集中由 dsh-api-remotes 装配，因此不能用「文件所在包」做键。
      const declPkg = id.includes('#') ? id.slice(0, id.indexOf('#')) : pkg;
      const isStream = streamProps.has(`${declPkg}#${m[4]}`)
        || streamProps.has(`${declPkg}#${m[2]}`);
      const cancelText = topLevelValue(objText, 'cancellation');
      const paramsText = topLevelValue(objText, 'parameters') ?? '[]';
      const params = [];
      const pre = /name:\s*"([^"]*)"\s*,\s*wire:\s*"([^"]*)"/g;
      let pm;
      while ((pm = pre.exec(paramsText)) !== null) params.push({ name: pm[1], wire: pm[2] });
      const resultText = topLevelValue(objText, 'result') ?? '';
      const resultSymbol = (resultText.match(/typeSymbol:\s*"([^"]+)"/) ?? [, ''])[1];
      const locText = topLevelValue(objText, 'sourceLocation') ?? '';
      const locFile = (locText.match(/file:\s*"([^"]+)"/) ?? [, ''])[1];
      const locLine = (locText.match(/line:\s*(\d+)/) ?? [, ''])[1];
      descriptors.push({
        id, pkg, service: m[2], namespace: m[3], method: m[4],
        kind: isStream ? 'stream' : invocationKind,
        invocationKind,
        cancellable: cancelText !== undefined,
        params,
        resultSymbol,
        source: locFile === '' ? '' : `${locFile}:${locLine}`
      });
    }
  }
}

descriptors.sort((a, b) => (a.namespace + '/' + a.method).localeCompare(b.namespace + '/' + b.method));

console.log(`# dsh endpoint 调用契约（${descriptors.length} 个 endpoint）\n`);
const byNs = new Map();
for (const d of descriptors) {
  if (!byNs.has(d.namespace)) byNs.set(d.namespace, []);
  byNs.get(d.namespace).push(d);
}
for (const ns of [...byNs.keys()].sort()) {
  console.log(`## ${ns}`);
  for (const d of byNs.get(ns)) {
    const p = d.params.length === 0 ? '(无参数)' : d.params.map((x) => x.wire).join(', ');
    console.log(`  ${d.method.padEnd(24)} ${d.kind.padEnd(8)} ${d.cancellable ? 'cancel' : '      '}  params: ${p}`);
  }
  console.log('');
}

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(descriptors, null, 2), 'utf8');
  console.log(`已写入 ${jsonOut}`);

  /**
   * 同时写一份「自描述」元数据。
   *
   * 存在理由（D5 升级手册）：契约文件本身是个纯数组，不带版本号，于是下游工具只能去
   * 「当前环境里装的那个 dsh」猜版本。一旦我们为了评估新版本而把契约指向别的安装目录
   * （`DSH_NODE_MODULES`），猜出来的版本就是错的——漂移报告会显示错误的「当前环境核心包」，
   * 而错误的版本号会让人做出错误的兼容性判断。
   * 让采集者自己记下版本，下游就永远不需要猜。
   */
  const meta = {
    corePackage: coreVersion(),
    capturedAt: new Date().toISOString(),
    endpointCount: descriptors.length,
    nodeModules: DSH_NM
  };
  writeFileSync(`${jsonOut}.meta.json`, JSON.stringify(meta, null, 2), 'utf8');
  console.log(`已写入 ${jsonOut}.meta.json（核心包 ${meta.corePackage}）`);
}
