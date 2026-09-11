#!/usr/bin/env node
/**
 * dsh 环境瘦身：把运行时**用不到**的文件从 rawfile/dsh 里移走（默认移到仓库外备份目录，
 * 出问题可原样还原；加 --delete 才是真删）。
 *
 * 为什么可以裁（2026-09-11 实测，env 总计 253.5MB / 26,762 文件）：
 *   Windows 平台二进制       64 文件  48.6 MB   （@img/sharp-win32-x64/lib/libvips-42.dll 单个 17.8MB、rg.exe 5.2MB…）
 *   调试符号 .pdb/.dll/.exe  18 文件  48.1 MB
 *   其它平台预编译 prebuilds  18 文件  23.2 MB
 *   source map .map        5,056 文件 38.8 MB   （仅调试用；client.js.map 保留，客户端合并包要读）
 *   TypeScript 声明 .d.ts   6,969 文件 36.5 MB   （类型专用，运行时绝不加载）
 *   test/tests/__tests__    1,257 文件  8.2 MB
 *   markdown .md             945 文件   7.5 MB
 *   并集（去重）          14,283 文件 142.8 MB   —— 占 env 56%
 *
 * 为什么安全：
 *   - 鸿蒙 arm64 上永远加载不了 win32/darwin 的 dll/exe/pdb；
 *   - .d.ts 只服务编译期类型检查，restool 之前还会白打包一遍；
 *   - 服务端 bundle 的 .map 只有调试器会读；`dsh-client-modules` 读的是
 *     `<clientPath>.map`（共 5 个，已保留），缺 map 时它本身就有 ENOENT 兜底；
 *   - test/ 与 README 不参与任何 require。
 *
 * 用法：
 *   node scripts/prune-dsh-env.mjs [--env entry/src/main/resources/rawfile/dsh]
 *                                  [--backup <仓库外目录>] [--delete] [--restore]
 * 默认（无 --delete/--restore）：移动到 --backup（默认 %TEMP%/dshm-env-pruned）。
 */

import { readdirSync, statSync, existsSync, mkdirSync, renameSync, rmSync, readFileSync } from 'node:fs';
import { join, relative, dirname, extname } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const ENV_DIR = argOf('--env', 'entry/src/main/resources/rawfile/dsh');
const BACKUP = argOf('--backup', join(tmpdir(), 'dshm-env-pruned'));
const DELETE = argv.includes('--delete');
const RESTORE = argv.includes('--restore');

if (!existsSync(ENV_DIR)) {
  console.error('[prune] env 目录不存在: ' + ENV_DIR);
  process.exit(2);
}

function walk(dir, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      // 纯测试目录整棵剪掉
      if (/(^|[\\/])(test|tests|__tests__)([\\/]|$)/.test(p)) { out.push({ path: p, dir: true }); continue; }
      walk(p, out);
    } else if (e.isFile()) {
      out.push({ path: p, dir: false });
    }
  }
  return out;
}

function shouldPrune(rel, name, ext) {
  const lower = rel.toLowerCase();
  const inDshScope = /node_modules[\\/]@deepseek-ai[\\/]/.test(lower);

  // 这三类与平台无关，任何包里都只是类型/调试/文档，删掉不影响运行时。
  if (ext === '.map' && name !== 'client.js.map') return 'source-map';
  if (name.endsWith('.d.ts')) return 'type-decl';
  if (ext === '.md') return 'markdown';

  // ⚠️ DSH 自有包（@deepseek-ai/**）**绝不能**按平台名裁剪。
  // 2026-09-11 事故：`@deepseek-ai/dsh-subprocess-local` 在 lib/index.js **顶层** import
  // `@deepseek-ai/dsh-win32-process`（peer 语义上必装），该包名里带 "win32"，
  // 被平台规则整包删掉 → 内嵌模式启动即 `ERR_MODULE_NOT_FOUND` + SIGNAL 6。
  // 包名/路径里出现 win32/darwin 不代表它是 Windows 专用二进制。
  if (inDshScope) return null;

  // 平台裁剪只认「平台构建产物」的形状，绝不按目录名里出现 win32/darwin 就删：
  //   ✔ prebuilds/<platform>/…          （node-pty 等预编译目录）
  //   ✔ 形如 win32-x64 / darwin-arm64 / linux-x64 的**完整路径段**（@img/sharp-win32-x64、@esbuild/win32-x64）
  //   ✔ .pdb/.dll/.exe/.lib/.exp        （Windows 调试符号与 PE 产物）
  //   ✘ isexe/dist/mjs/win32.js         —— 这是**跨平台分支模块**，删了会 ERR_MODULE_NOT_FOUND
  //     （2026-09-11 实测：旧规则把它删掉后，pnpm 依赖树自检立刻报缺入口）
  const isPlatformDir = /(^|[\\/])prebuilds([\\/]|$)/.test(lower)
    || /(^|[\\/])(win32|darwin|linux|linuxmusl|android|freebsd|openbsd|sunos)-(x64|arm64|ia32|arm|ppc64|s390x|riscv64)([\\/]|$)/.test(lower);
  if (isPlatformDir) return 'other-platform';
  if (['.pdb', '.dll', '.exe', '.lib', '.exp'].includes(ext)) return 'debug-or-win-binary';
  return null;
}

/**
 * 已知的「上游本来就没有」项（已用 npm tarball 核实，2026-09-11）：
 *   - @xterm/headless 的 package.json 写了 "module": "lib/xterm.mjs"，但发布包里只有
 *     lib-headless/xterm-headless.{js,mjs}，该文件从未发布；
 *   - @modelcontextprotocol/sdk 的 exports 列出 ./dist/{esm,cjs}/index.js，但发布包里
 *     只有 ./client、./server 等子路径，根 index 从未发布。
 * 它们不是被裁剪掉的，白名单放行以免自检长期亮红。
 */
const RUNTIME_ENTRY_ALLOWLIST = [
  '@xterm/headless -> lib/xterm.mjs',
  '@modelcontextprotocol/sdk -> ./dist/esm/index.js',
  '@modelcontextprotocol/sdk -> ./dist/cjs/index.js'
];

/**
 * 裁剪后自检：每个 package.json 声明的**运行时**入口（main / exports 的 js 目标）必须还在。
 * 上面那次事故如果早有这道检查，就不会等到设备上 SIGNAL 6 才发现。
 */
function verifyRuntimeEntries(envDir) {
  const missing = [];
  const stack = [envDir];
  let pkgCount = 0;
  const collect = (v, out) => {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) collect(v[k], out);
  };
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    // 只把「node_modules/<name>」或「node_modules/@scope/<name>」直下的 package.json 当包根。
    // 包内还会有别的 package.json（tshy 的 dist/cjs/package.json 甚至是整份拷贝、
    // dist/mjs/package.json 只是 {"type":"module"}），按包根解析会得到假的「入口缺失」。
    const segs = dir.split(/[\\/]/);
    const base = segs[segs.length - 1];
    const parentSeg = segs[segs.length - 2];
    const grandSeg = segs[segs.length - 3];
    const isScopedRoot = parentSeg === 'node_modules' && base.startsWith('@');
    const isPlainRoot = base === 'node_modules' ? false : parentSeg === 'node_modules';
    const isScopeDir = isScopedRoot && grandSeg === 'node_modules';
    const treatAsRoot = isPlainRoot || isScopeDir;
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (e.name !== 'package.json') continue;
      if (!treatAsRoot) continue;
      // 跳过仓库内的示例/基准/测试夹具目录：它们不是被依赖的包，
      // 其 package.json 常引用并不发布的文件（fast-uri/benchmark 就是这种）。
      const parent = dir.split(/[\\/]/).pop().toLowerCase();
      if (['benchmark', 'benchmarks', 'test', 'tests', 'example', 'examples', 'fixtures'].includes(parent)) continue;
      let j;
      try { j = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
      pkgCount += 1;
      const targets = [];
      if (typeof j.main === 'string') targets.push(j.main);
      if (typeof j.module === 'string') targets.push(j.module);
      if (j.exports) collect(j.exports, targets);
      for (const t of targets) {
        if (typeof t !== 'string' || t.includes('*')) continue;
        if (t.startsWith('..') || t.startsWith('/')) continue; // 包外相对路径不归本包管
        if (!/\.(js|cjs|mjs|json)$/.test(t)) continue; // 类型/裸路径交给 Node 解析规则
        if (!existsSync(join(dir, t))) {
          const key = (j.name || dir) + ' -> ' + t;
          if (!RUNTIME_ENTRY_ALLOWLIST.includes(key)) missing.push(key);
        }
      }
    }
  }
  return { pkgCount, missing };
}

const files = walk(ENV_DIR, []);
const plan = new Map();
let totalBytes = 0;
for (const f of files) {
  const rel = relative(ENV_DIR, f.path);
  if (f.dir) { plan.set(f.path, 'test-dir'); continue; }
  const kind = shouldPrune(rel, f.path.split(/[\\/]/).pop(), extname(f.path));
  if (kind) plan.set(f.path, kind);
}

// 目录条目只算一次（其下文件不再单独处理）
const prunedDirs = [...plan.keys()].filter((p) => plan.get(p) === 'test-dir');
const isUnderPrunedDir = (p) => prunedDirs.some((d) => p === d || p.startsWith(d + '\\') || p.startsWith(d + '/'));

const stats = new Map();
const actions = [];
for (const [p, kind] of plan) {
  if (kind !== 'test-dir' && isUnderPrunedDir(p)) continue;
  let size = 0;
  if (kind === 'test-dir') {
    const stack = [p];
    while (stack.length) {
      const cur = stack.pop();
      for (const e of readdirSync(cur, { withFileTypes: true })) {
        const c = join(cur, e.name);
        if (e.isDirectory()) stack.push(c); else size += statSync(c).size;
      }
    }
  } else {
    size = statSync(p).size;
  }
  stats.set(kind, { count: (stats.get(kind)?.count ?? 0) + 1, bytes: (stats.get(kind)?.bytes ?? 0) + size });
  totalBytes += size;
  actions.push({ path: p, kind });
}

console.log('[prune] env = ' + ENV_DIR);
console.log('[prune] 模式 = ' + (RESTORE ? 'RESTORE' : DELETE ? 'DELETE' : 'MOVE -> ' + BACKUP));
for (const [kind, s] of [...stats.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log('  ' + kind.padEnd(22) + String(s.count).padStart(6) + ' 项  ' + (s.bytes / 1048576).toFixed(1).padStart(7) + ' MB');
}
console.log('  合计' + ' '.repeat(18) + String(actions.length).padStart(6) + ' 项  ' + (totalBytes / 1048576).toFixed(1).padStart(7) + ' MB');

if (!DELETE && !RESTORE) {
  let moved = 0;
  for (const a of actions) {
    const rel = relative(ENV_DIR, a.path);
    const dest = join(BACKUP, rel);
    try {
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(a.path, dest);
      moved += 1;
    } catch (e) {
      console.error('[prune] 移动失败 ' + rel + ': ' + e.message);
    }
  }
  console.log('[prune] 已移动 ' + moved + ' 项到备份目录：' + BACKUP);
  console.log('[prune] 还原：node scripts/prune-dsh-env.mjs --restore --backup "' + BACKUP + '"');
} else if (DELETE) {
  for (const a of actions) {
    try { rmSync(a.path, { recursive: true, force: true }); } catch (e) { console.error('[prune] 删除失败 ' + a.path + ': ' + e.message); }
  }
  console.log('[prune] 已删除 ' + actions.length + ' 项');
} else {
  // 还原：按备份树整体搬回
  if (!existsSync(BACKUP)) { console.error('[prune] 备份不存在: ' + BACKUP); process.exit(2); }
  let restored = 0;
  const stack = [BACKUP];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const c = join(cur, e.name);
      if (e.isDirectory()) { stack.push(c); continue; }
      const rel = relative(BACKUP, c);
      const dest = join(ENV_DIR, rel);
      try {
        mkdirSync(dirname(dest), { recursive: true });
        renameSync(c, dest);
        restored += 1;
      } catch (err) { console.error('[prune] 还原失败 ' + rel + ': ' + err.message); }
    }
  }
  console.log('[prune] 已还原 ' + restored + ' 个文件');
}

// 无论哪种模式都跑一次入口自检：被裁掉的包若还有人 import，设备上会以
// ERR_MODULE_NOT_FOUND + SIGNAL 6 的形式炸在启动阶段，代价远高于这里多跑几秒。
const { pkgCount, missing } = verifyRuntimeEntries(ENV_DIR);
console.log('[prune] 入口自检：扫描 ' + pkgCount + " 个 package.json，缺失运行时入口 " + missing.length + ' 个');
if (missing.length) {
  for (const m of missing.slice(0, 20)) console.error('  缺失: ' + m);
  console.error('[prune] ❌ 有包入口被裁掉，会导致 dsh 启动失败；请修正裁剪规则或还原该包');
  process.exit(1);
}
console.log('[prune] ✅ 环境入口自检通过');
