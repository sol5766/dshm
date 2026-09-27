/**
 * 精确枚举 dsh Typert Remote endpoint（namespace/method）。
 *
 * 修正 v1 的两个盲区：
 *   ① 命名空间不在同一文件声明（如 settings/credentials 在 settings-controller 内，方法却在别处）；
 *   ② `_ab_decorators = [Remote("abbrev")]` 的属性名与线上方法名不同（如 _del_decorators → "delete"）。
 *
 * 因此本版：
 *   - 每个文件单独收集 `namespace: "x"` 与 `Remote("m")`，既做「同文件配对」，也输出全局清单；
 *   - 额外抓取 `_<prop>_decorators` 的 prop 与 Remote 名，供人工核对属性名→线上名映射。
 *
 * 用法：node tools/protocol-enum2.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DSH_NM = process.env.DSH_NODE_MODULES
  ?? 'C:\\Users\\aotian\\AppData\\Roaming\\io.github.hairyf.deepseek-harness-desktop\\dependencies\\dsh\\node_modules';

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
const packages = readdirSync(scope, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const root = process.cwd();

const perPackage = new Map();
const decorators = [];

for (const pkg of packages) {
  const pkgRoot = join(scope, pkg);
  const files = walk(pkgRoot, []);
  const namespaces = new Set();
  const methods = new Set();
  for (const file of files) {
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = file.slice(root.length + 1);
    for (const m of src.matchAll(/namespace:\s*"([A-Za-z0-9_$.-]+)"/g)) namespaces.add(m[1]);
    for (const m of src.matchAll(/_(\w+)_decorators\s*=\s*\[\s*Remote\(\s*(\{[^}]*\}|"[^"]*")\s*\)/g)) {
      const prop = m[1];
      const arg = m[2];
      const mode = /mode:\s*["']stream["']/.test(arg) ? 'stream' : 'unary';
      const named = arg.match(/^"([^"]*)"$/);
      const wire = named ? named[1] : prop;
      methods.add(wire);
      decorators.push({ pkg, prop, wire, mode, file: rel });
    }
  }
  if (namespaces.size > 0 || methods.size > 0) {
    perPackage.set(pkg, { namespaces: [...namespaces].sort(), methods: [...methods].sort() });
  }
}

console.log('# dsh Remote endpoint 精确枚举\n');
for (const [pkg, info] of [...perPackage.entries()].sort()) {
  console.log(`## ${pkg}`);
  console.log(`   namespace: ${info.namespaces.length > 0 ? info.namespaces.join(', ') : '(本文件未声明)'}`);
  console.log(`   methods  : ${info.methods.join(' ')}`);
}

console.log('\n# 属性名 ≠ 线上名的映射（需人工核对的候选）\n');
const mismatched = decorators.filter((d) => d.prop !== d.wire);
for (const d of mismatched) console.log(`  ${d.pkg}  ${d.prop}  ->  ${d.wire}  (${d.mode})`);

writeFileSync(join(root, '.research', 'protocol', 'endpoints-v2.json'),
  JSON.stringify({ packages: [...perPackage.entries()], decorators }, null, 2), 'utf8');
console.log('\n已写入 .research/protocol/endpoints-v2.json');
