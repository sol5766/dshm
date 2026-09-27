/**
 * 从已安装的 dsh 包中反向枚举 Typert Remote endpoint（namespace + method）。
 *
 * 依据（D2 §1.1）：endpoint = `${namespace}/${method}`，由 descriptor 拼成。
 * 上游编译产物的稳定形态：
 *   - 命名空间：super(ctx, "<service>", { namespace: "<ns>" });
 *   - Remote 方法：_<name>_decorators = [Remote("methodName")] / [Remote({ mode: "stream" })]
 *     其中 mode:"stream" 时方法名与属性名同名（_foo_decorators = [Remote({mode:'stream'})] → "foo"）。
 *
 * 用法：node tools/protocol-enum.mjs [--json <outfile>]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DSH_NM = process.env.DSH_NODE_MODULES
  ?? 'C:\\Users\\aotian\\AppData\\Roaming\\io.github.hairyf.deepseek-harness-desktop\\dependencies\\dsh\\node_modules';

const jsonOutIdx = process.argv.indexOf('--json');
const jsonOut = jsonOutIdx >= 0 ? process.argv[jsonOutIdx + 1] : undefined;

/** 递归收集 js 文件 */
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
    else if (e.isFile() && (e.name.endsWith('.js') || e.name.endsWith('.mjs'))) acc.push(p);
  }
  return acc;
}

const scope = join(DSH_NM, '@deepseek-ai');
const packages = readdirSync(scope, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

const findings = new Map(); // endpoint -> { pkg, mode, file }

for (const pkg of packages) {
  const root = join(scope, pkg);
  const files = walk(root, []);
  // 本包内出现的命名空间（可能多个）
  const namespaces = new Set();
  for (const file of files) {
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(/namespace:\s*"([A-Za-z0-9_$.-]+)"/g)) namespaces.add(m[1]);
    for (const m of src.matchAll(/_(\w+)_decorators\s*=\s*\[\s*Remote\(\s*(\{[^}]*\}|"[^"]*")\s*\)/g)) {
      const prop = m[1];
      const arg = m[2];
      const mode = /mode:\s*"stream"/.test(arg) ? 'stream' : 'unary';
      const named = arg.match(/^"([^"]*)"$/);
      const method = named ? named[1] : prop;
      findings.set(`${pkg}\u0000${method}\u0000${mode}`, {
        pkg, method, mode, prop,
        file: file.slice(scope.length + 1)
      });
    }
  }
  for (const ns of namespaces) {
    // 记录命名空间与包的对应关系，便于人工核对
    const key = `${pkg}\u0000<namespace>\u0000ns`;
    if (!findings.has(key)) findings.set(key, { pkg, namespace: ns, mode: 'namespace' });
  }
}

const rows = [...findings.values()].sort((a, b) =>
  a.pkg === b.pkg ? (a.method ?? '').localeCompare(b.method ?? '') : a.pkg.localeCompare(b.pkg));

const unary = rows.filter((r) => r.mode === 'unary');
const stream = rows.filter((r) => r.mode === 'stream');
const nsRows = rows.filter((r) => r.mode === 'namespace');

console.log(`# dsh Remote endpoint 枚举（${packages.length} 个 @deepseek-ai 包）\n`);
console.log(`一元方法 ${unary.length} 个 / 流式方法 ${stream.length} 个 / 命名空间声明 ${nsRows.length} 条\n`);

console.log('## 命名空间声明（包 → namespace）\n');
for (const r of nsRows) console.log(`${r.pkg}\t${r.namespace}`);

console.log('\n## 一元方法（包 → method）\n');
for (const r of unary) console.log(`${r.pkg}\t${r.method}`);

console.log('\n## 流式方法（包 → method）\n');
for (const r of stream) console.log(`${r.pkg}\t${r.method}`);

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ packages, rows }, null, 2), 'utf8');
  console.log(`\n已写入 ${jsonOut}`);
}
