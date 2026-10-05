#!/usr/bin/env node
/**
 * assert-fs-search-fallback.mjs —— 锁 fs-search 降级 patch 的结构与行为。
 *
 * 被测对象：dist/core/work/dsh-core-<ver>/node_modules/@deepseek-ai/dsh-tool-fs-search/lib/index.js
 * （由 pack-core.mjs 的 patchFsSearchFallback() 注入；本脚本在 pack 之后跑）。
 *
 * 三层防线：
 *   A. 结构：五个注入函数 + spawn/输出两段替换 + 旧段已消失（byte 级锚点）；
 *   B. 语法：vm.SourceTextModule 全文解析（ESM，import 不 link，纯语法门禁）；
 *   C. 行为：从注入块提取纯函数（new Function + stub existsSync/parse），验证
 *      rg→find/grep 参数转换、花括号展开、NDJSON 转换、exec 探测记忆。
 *
 * 用法：node tools/assert-fs-search-fallback.mjs
 */
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
// 被测树跟着配方走（hostcore/core-recipe.json 是唯一事实来源），不再写死版本号：
// 曾经写死 0.1.6 路径，升级 0.1.7 后断言悄悄测旧树（绿但无效）——这类"测错对象"比红更危险。
const RECIPE = JSON.parse(readFileSync(join(ROOT, 'hostcore', 'core-recipe.json'), 'utf8'));
const FILE = join(ROOT, 'dist', 'core', 'work', `dsh-core-${RECIPE.coreVersion}`,
  'node_modules', '@deepseek-ai', 'dsh-tool-fs-search', 'lib', 'index.js');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}`);
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}\n      期望 ${b}\n      实际 ${a}`);
}

const t = readFileSync(FILE, 'utf8');

// ── A. 结构 ─────────────────────────────────────────────────────────────
console.log('[1/3] 结构锚点');
ok(t.includes('function rgExecutable('), 'helpers: rgExecutable 定义在位');
ok(t.includes('function probeSystemTool('), 'helpers: probeSystemTool 定义在位');
ok(t.includes('function expandBraces('), 'helpers: expandBraces 定义在位');
ok(t.includes('function buildFallbackArgv('), 'helpers: buildFallbackArgv 定义在位');
ok(t.includes('function grepTextToNdjson('), 'helpers: grepTextToNdjson 定义在位');
ok(t.includes('await rgExecutable(ctx, rgPath, exec.signal)'), 'spawn 段：exec 探测调用在位');
ok(t.includes('const fb = buildFallbackArgv(toolName, argv);'), 'spawn 段：降级 argv 构造在位');
ok(t.includes('argv: spawnArgv,'), 'spawn 段：argv 改用 spawnArgv 变量');
ok(t.includes('fallbackGrep = toolName === "grep";'), 'spawn 段：fallbackGrep 标志在位');
ok(t.includes('text: grepTextToNdjson(stdoutRaw.text ?? "")'), '输出段：grep 文本 → NDJSON 转换在位');
ok(t.includes('{ ...stdoutRaw,'), '输出段：保持 {text, lossy} 收集器形状');
ok(!t.includes('await resolveRgPath(),\n\t\t\t\t"--no-config",'), '旧 spawn 段（await resolveRgPath 内联）已消失');
ok(!t.includes('\tconst stdout = handle.collected.stdout?.readFrom(0);\n'), '旧输出段（stdout 直读）已消失');
ok(t.includes('"-Hrn", "-E"'), 'grep 降级带 -H（单文件名前缀修复）在位');
ok(!/statSync\(/.test(t.slice(t.indexOf('let rgExecOk'), t.indexOf('async function runRipgrep'))),
  '注入块不引用未 import 的 statSync（加载即 ReferenceError 的坑）');
ok(!/[^.](basename)\(/.test(t.slice(t.indexOf('let rgExecOk'), t.indexOf('async function runRipgrep'))),
  '注入块不引用未 import 的 basename');
// 探测放行线：execve 放开的将来（正式签名），rg --version exit 0 → 走 rg 全功能
ok(t.includes('rgExecOk = outcome.exitCode === 0;'), '探测：exitCode 0 判可用（未来放开自动回 rg）');
ok(t.includes('if (signal && signal.aborted) return true;'), '探测：abort 竞态不记忆');

// ── B. 语法（ESM 全文解析；不 link，import 不解析）────────────────────────
console.log('[2/3] 语法解析（vm.SourceTextModule）');
// vm.SourceTextModule 需要 --experimental-vm-modules：起子进程跑，主进程无 flag 也能过
try {
  const probe = execFileSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e',
    `import vm from 'node:vm'; import { readFileSync } from 'node:fs';`
    + `new vm.SourceTextModule(readFileSync(${JSON.stringify(FILE)}, 'utf8'));`],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  pass++;
} catch (e) {
  fail++;
  console.error(`  ✗ 全文语法解析失败：${e.stderr?.toString() ?? e.message}`);
}

// ── C. 行为（提取注入块 + stub）──────────────────────────────────────────
console.log('[3/3] 注入函数行为');
const blockStart = t.indexOf('let rgExecOk = null;');
// 终点锚：helpers 之后紧邻的原文是 runRipgrep 的 JSDoc（不能用 '\n/**'——helpers 自带 JSDoc 注释）
const blockEnd = t.indexOf('\n/**\n* Run the packaged ripgrep binary', blockStart);
ok(blockStart >= 0 && blockEnd > blockStart, '注入块可定位（let rgExecOk … 下一个 JSDoc 前）');
if (blockStart >= 0 && blockEnd > blockStart) {
  const block = t.slice(blockStart, blockEnd);
  const factory = new Function('existsSync', 'parse', 'Buffer',
    block + '\nreturn { rgExecutable, probeSystemTool, expandBraces, buildFallbackArgv, grepTextToNdjson };');
  // stub：PC 上没有 /system/bin —— 让 grep/find 命中系统路径分支
  const stubExists = (p) => p === '/system/bin/grep' || p === '/system/bin/find';
  const stubParse = (p) => ({ base: p.split('/').pop() });
  const api = factory(stubExists, stubParse, Buffer);

  // expandBraces
  eq(api.expandBraces('*.{sh,txt}'), ['*.sh', '*.txt'], 'expandBraces：两分支展开');
  eq(api.expandBraces('*.ets'), ['*.ets'], 'expandBraces：无花括号原样');
  eq(api.expandBraces('{a,b}x{1,2}'), ['ax1', 'ax2', 'bx1', 'bx2'], 'expandBraces：嵌套展开');

  // buildFallbackArgv：glob → find
  eq(api.buildFallbackArgv('glob', ['--files', '--', '/ws']),
    ['/system/bin/find', '/ws', '-type', 'f'], 'glob：基础 find argv');
  eq(api.buildFallbackArgv('glob', ['--files', '--glob=*.ets', '--', '/ws']),
    ['/system/bin/find', '/ws', '-type', 'f', '-name', '*.ets'], 'glob：-name 取 glob 末段');
  eq(api.buildFallbackArgv('glob', ['--files', '--glob=**/*.{sh,ets}', '--', '.']),
    ['/system/bin/find', '.', '-type', 'f', '(', '-name', '*.sh', '-o', '-name', '*.ets', ')'],
    'glob：花括号展开成 -o 分组');
  eq(api.buildFallbackArgv('glob', ['--files', '--glob=!**/node_modules', '--', '/ws']),
    ['/system/bin/find', '/ws', '-type', 'f'], 'glob：negation（--glob=!…）忽略');
  eq(api.buildFallbackArgv('glob', ['--files', '--glob=!**/node_modules', '--glob=*.ets', '--', '/ws']),
    ['/system/bin/find', '/ws', '-type', 'f', '-name', '*.ets'],
    'glob：negation 跳过后首个正 pattern 生效');

  // 【2026-10-05 真机缺陷回归：目录锚定】`dir/*` 类模式**不得**退化成"任意深度的 basename 匹配"。
  // 真机实测（13111 个文件的树）：原实现 `_tool_probe/*` 命中 13111（应为 1）、
  // `_tool_probe/*.txt` 命中全局 8 条；根因是 `glob.split("/").pop()` 把目录前缀 pop 掉了，
  // 于是 argv 变成 `find <root> -type f -name '*'`。
  // 修法：最长**字面目录前缀**并入 find 起点 + `-maxdepth` 限深（端侧 toybox 实测支持）。
  const anchored = [
    ['_tool_probe/*', '_tool_probe', '*'],
    ['./_tool_probe/*', '_tool_probe', '*'],
    ['pptmaster/*', 'pptmaster', '*'],
    ['_tool_probe/*.txt', '_tool_probe', '*.txt'],
    ['_tool_probe/hello.*', '_tool_probe', 'hello.*'],
  ];
  for (const [pattern, dir, name] of anchored) {
    const argv = api.buildFallbackArgv('glob', ['--files', `--glob=${pattern}`, '--', '/ws']);
    eq(argv, ['/system/bin/find', `/ws/${dir}`, '-type', 'f', '-maxdepth', '1', '-name', name],
      `glob：${pattern} 锚定到 ${dir}/ 并限深 1 层`);
    ok(argv[1] !== '/ws', `glob：${pattern} 的 find 起点已收窄（原缺陷下这里是 /ws ⇒ 全树）`);
  }
  // 末段不含 `/`（含 `**/x`）：保持 rg 的"任意深度"语义，**不加** -maxdepth
  eq(api.buildFallbackArgv('glob', ['--files', '--glob=**/hello.txt', '--', '/ws']),
    ['/system/bin/find', '/ws', '-type', 'f', '-name', 'hello.txt'], 'glob：**/x 保持任意深度');
  eq(api.buildFallbackArgv('glob', ['--files', '--glob=*.ets', '--', '/ws']),
    ['/system/bin/find', '/ws', '-type', 'f', '-name', '*.ets'], 'glob：纯 basename 保持任意深度');
  // 多展开但**起点相同**：仍走精确形（maxdepth + -o 分组），不要无谓退到 -path
  eq(api.buildFallbackArgv('glob', ['--files', '--glob=_tool_probe/*.{txt,md}', '--', '/ws']),
    ['/system/bin/find', '/ws/_tool_probe', '-type', 'f', '-maxdepth', '1',
      '(', '-name', '*.txt', '-o', '-name', '*.md', ')'],
    'glob：dir/*.{a,b} 同起点仍精确限深');
  // 中间段带通配 / 多起点：退到 -path 锚定（POSIX 的 * 跨 /，做不到精确限深，但仍锚定目录）
  eq(api.buildFallbackArgv('glob', ['--files', '--glob=a/*/b.txt', '--', '/ws']),
    ['/system/bin/find', '/ws', '-type', 'f', '(', '-path', '*/a/*/b.txt', ')'],
    'glob：中间段通配 → -path 锚定');
  eq(api.buildFallbackArgv('glob', ['--files', '--glob={a,b}/*.md', '--', '/ws']),
    ['/system/bin/find', '/ws', '-type', 'f', '(', '-path', '*/a/*.md', '-o', '-path', '*/b/*.md', ')'],
    'glob：多起点（花括号）→ -path 锚定');

  // buildFallbackArgv：grep → grep -Hrn
  eq(api.buildFallbackArgv('grep', ['--regexp=foo|bar', '--', '/ws']),
    ['/system/bin/grep', '-Hrn', '-E', '-e', 'foo|bar', '/ws'], 'grep：基础 -Hrn -E -e');
  eq(api.buildFallbackArgv('grep', ['--regexp=x', '--glob=*.md', '--', '/ws']),
    ['/system/bin/grep', '-Hrn', '-E', '-e', 'x', '/ws', '--include=*.md'], 'grep：--include 过滤');
  eq(api.buildFallbackArgv('grep', ['--regexp=x']), ['/system/bin/grep', '-Hrn', '-E', '-e', 'x', '.'],
    'grep：无 root 默认 .');
  // 【2026-10-05 同类缺陷回归】grep 侧原来也一律只取末段做 --include ⇒ `dir/*.ts` 会搜**全树**。
  // 系统 grep 没有路径 glob，但它的**搜索根**就是目录约束 ⇒ 把字面前缀换进根参数。
  const grepAnchored = api.buildFallbackArgv('grep', ['--regexp=x', '--glob=dir/*.ts', '--', '/ws']);
  eq(grepAnchored, ['/system/bin/grep', '-Hrn', '-E', '-e', 'x', '/ws/dir', '--include=*.ts'],
    'grep：dir/*.ts 把搜索根换到 dir/');
  ok(grepAnchored[5] === '/ws/dir', 'grep：搜索根已收窄（原缺陷下这里是 /ws ⇒ 全树）');
  eq(api.buildFallbackArgv('grep', ['--regexp=x', '--glob=dir/**/*.ts', '--', '/ws']),
    ['/system/bin/grep', '-Hrn', '-E', '-e', 'x', '/ws/dir', '--include=*.ts'],
    'grep：dir/**/*.ts 先去掉 **/ 再锚定');
  eq(api.buildFallbackArgv('grep', ['--regexp=x', '--glob=**/*.ts', '--', '/ws']),
    ['/system/bin/grep', '-Hrn', '-E', '-e', 'x', '/ws', '--include=*.ts'],
    'grep：**/*.ts 保持全树（任意深度）');

  // 不可降级：stub 下没有 find/grep 时返回空数组（caller 会抛 SEARCH_FAILED）
  const noTool = new Function('existsSync', 'parse', 'Buffer',
    block + '\nreturn { buildFallbackArgv };')(() => false, stubParse, Buffer);
  eq(noTool.buildFallbackArgv('glob', ['--files', '--', '/ws']), [], '探测不到系统工具 → 空数组');

  // grepTextToNdjson
  const nd = api.grepTextToNdjson('a.js:3:hello world\nb.js:12:x:y\n\n1:bad\n');
  eq(nd, '{"type":"match","data":{"path":{"text":"a.js"},"line_number":3,"lines":{"text":"hello world"}}}\n'
    + '{"type":"match","data":{"path":{"text":"b.js"},"line_number":12,"lines":{"text":"x:y"}}}\n',
    'NDJSON：正常行转换 + 单冒号/空行丢弃');
  eq(api.grepTextToNdjson(''), '', 'NDJSON：空输入');
  eq(api.grepTextToNdjson('a.js:0:zero'), '', 'NDJSON：行号 0 非法丢弃');

  // rgExecutable：spawn 抛错（execve 被拒）→ false 且记忆
  let spawns = 0;
  const deniedCtx = { subprocess: { spawn: () => { spawns++; throw new Error('denied'); } } };
  eq(await api.rgExecutable(deniedCtx, '/fake/rg', null), false, '探测：spawn 抛错 → 不可用');
  eq(await api.rgExecutable(deniedCtx, '/fake/rg', null), false, '探测：第二次读记忆');
  eq(spawns, 1, '探测：记忆后不再 spawn');

  // rgExecutable：exit 0 → true（新 factory 重置记忆）
  const okCtx = { subprocess: { spawn: () => ({ done: Promise.resolve({ exitCode: 0 }) }) } };
  const api2 = factory(stubExists, stubParse, Buffer);
  eq(await api2.rgExecutable(okCtx, '/fake/rg', null), true, '探测：exit 0 → 可用（回 rg 路径）');
}

console.log(`\nassert-fs-search-fallback：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
