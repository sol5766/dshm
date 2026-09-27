/**
 * 审计：`appstate` / `dshcompat` 对外导出的符号里，**哪些在 `entry`（UI）里从未被引用**。
 *
 * 存在理由：本项目反复出现同一类缺陷——**协议层与状态层实现好了，但界面从未接上**。
 * 已发生的实例：Host 侧待发队列（`session/updateQueue`）、会话分叉（`session/fork`）、
 * 内联图片片段（`imagePart`）、附件上传（`fileUploads/upload`）。
 * 它们的共同点是"代码在、门禁绿、功能不可达"，而不接设备就看不出来。
 *
 * 这个脚本把这类缺口一次列全，不依赖模拟器：把「导出了但没人用」当作**怀疑清单**，
 * 再逐条判断是"该接的没接"还是"给测试/未来预留的"。
 *
 * 用法：node tools/audit-unused-exports.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 递归收集目录下所有 .ets 文件的文本 */
function collect(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const name of readdirSync(cur)) {
      const p = join(cur, name);
      if (statSync(p).isDirectory()) {
        stack.push(p);
      } else if (name.endsWith('.ets')) {
        out.push(readFileSync(p, 'utf8'));
      }
    }
  }
  return out.join('\n');
}

/** 从 barrel（Index.ets）里抽出所有导出名（值导出 + 类型导出，忽略 `as` 重命名） */
function exportedNames(barrelPath) {
  const text = readFileSync(barrelPath, 'utf8');
  const names = new Set();
  const blocks = text.split('export ');
  for (const block of blocks) {
    // 只看 `export { ... }` / `export type { ... }`
    const open = block.indexOf('{');
    const close = block.indexOf('}');
    if (open < 0 || close < 0 || close < open) {
      continue;
    }
    const inner = block.substring(open + 1, close);
    for (let raw of inner.split(',')) {
      raw = raw.trim();
      if (raw.length === 0) {
        continue;
      }
      // `X as Y` → 外部可见名是 Y
      const asParts = raw.split(/\s+as\s+/);
      const name = asParts[asParts.length - 1].trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
        names.add(name);
      }
    }
  }
  return names;
}

const entryText = collect('entry/src/main/ets');
/**
 * 全工程源码（用于区分"完全没人用"与"只被上游模块内部用"）。
 *
 * 【为什么要分这两类】只看"entry 有没有引用"会把两类完全不同的东西混在一起：
 *   - 只被 `appstate`/`connection` 内部用的工具函数：**正常**，不该出现在清单里；
 *   - 全工程零引用的导出：要么是**死代码**（该删），要么是**没接完的功能**（该接）。
 * 前者是噪声，后者才是这份清单存在的理由。
 */
const allSourceText = collect('appstate/src') + collect('connection/src')
  + collect('platform/src') + entryText;

const targets = [
  ['appstate', 'appstate/src/main/ets/Index.ets'],
  ['dshcompat', 'dshcompat/src/main/ets/Index.ets']
];

let total = 0;
let deadTotal = 0;
for (const [label, barrel] of targets) {
  const names = exportedNames(barrel);
  const unused = [];
  const dead = [];
  for (const n of names) {
    // 用词边界匹配，避免 `queue` 命中 `queued`
    const re = new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\b`);
    if (!re.test(entryText)) {
      unused.push(n);
    }
    // 零引用要排除"声明处自己"：导出名必然出现在 barrel 与源文件里，
    // 因此这里只统计**除 barrel 之外**的引用数——由下面这个更严格的正则近似达成：
    // 出现次数 <= 2（barrel 一次 + 源文件一次）即视为"只在声明处出现"。
    const count = (allSourceText.match(new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\b`, 'g')) ?? []).length;
    if (count <= 2) {
      dead.push(`${n}(${count})`);
    }
  }
  unused.sort();
  dead.sort();
  console.log(`\n=== ${label}：导出 ${names.size} 个；entry 未引用 ${unused.length} 个；**全工程近零引用** ${dead.length} 个 ===`);
  console.log('  「近零引用」= 除声明处外几乎没人用 ⇒ 死代码或没接完的功能：');
  for (let i = 0; i < dead.length; i += 3) {
    console.log('    ' + dead.slice(i, i + 3).join('  '));
  }
  total += unused.length;
  deadTotal += dead.length;
}
console.log(`\n合计：entry 未引用 ${total} 个（含类型与内部消费，属正常）；近零引用 ${deadTotal} 个（**这才是要处理的**）。`);
