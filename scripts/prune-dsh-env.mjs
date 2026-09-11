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

import { readdirSync, statSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
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
  if (/win32|darwin|freebsd|android/.test(lower)) return 'other-platform';
  if (['.pdb', '.dll', '.exe', '.lib', '.exp'].includes(ext)) return 'debug-or-win-binary';
  if (lower.includes('prebuilds')) return 'prebuilds';
  if (ext === '.map' && name !== 'client.js.map') return 'source-map';
  if (name.endsWith('.d.ts')) return 'type-decl';
  if (ext === '.md') return 'markdown';
  return null;
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
