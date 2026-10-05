#!/usr/bin/env node
/*
 * ============================================================================
 * tools/check-ptc-ts-strip.mjs
 * ----------------------------------------------------------------------------
 * 门禁：证明 `hostcore/plugins/dshm-ptc-runtime-inproc/lib/ts-strip.cjs`
 * 是一个**在 `node --jitless` 下可用**的纯 JS erasable-TS 擦除器。
 *
 * 一键重跑：
 *     node tools/check-ptc-ts-strip.mjs              # exit 0/1
 *     node tools/check-ptc-ts-strip.mjs --self-test  # 额外跑"门禁自检"（变异测试）
 *
 * ----------------------------------------------------------------------------
 * 【为什么这个门禁必须跑在 --jitless 下】
 *   端侧 Node 以 `--jitless` 启动 ⇒ `typeof WebAssembly === 'undefined'`。
 *   官方擦除路径（`node:module` 的 `stripTypeScriptTypes`，SWC wasm）在这种情况下
 *   直接抛：
 *       Error [ERR_WEBASSEMBLY_NOT_SUPPORTED]:
 *         WebAssembly is not supported in this environment, but is required for TypeScript
 *   所以"在普通 node 下能跑"**完全不构成证据**。本脚本因此把自己**重新拉起到
 *   `--jitless` 子进程**里跑（见下面的 re-exec），并在子进程里三重自证：
 *     ① 断言 `process.execArgv` 含 `--jitless`；
 *     ② 断言 `typeof WebAssembly === 'undefined'`（与端侧一致）；
 *     ③ 把 `globalThis.WebAssembly` 换成一个"**一读就抛**"的陷阱 getter，
 *        跑完全部用例后断言陷阱**从未被触发** —— 即擦除器连"看一眼"都没有过。
 *   第 ③ 条是关键：它把"我们没用 wasm"从"代码审查的结论"变成"运行时的事实"。
 *   （实测：`--jitless` 下 globalThis 上压根没有 WebAssembly 自有属性，
 *     `Object.getOwnPropertyDescriptor` 返回 undefined，所以陷阱能干净地装上。）
 *
 * ----------------------------------------------------------------------------
 * 【用例矩阵】任务要求的 12 类，逐条对应到下面的 group：
 *   1  变量/参数/返回值类型注解            group "用例 1"
 *   2  interface / type 别名 / declare      group "用例 2"
 *   3  泛型 Array<T> Promise<T> Map<...>    group "用例 3"
 *   4  as / ! / satisfies / ?. / ??         group "用例 4"（含"不得被降级"断言）
 *   5  带泛型与返回类型的箭头函数           group "用例 5"
 *   6  类：字段注解 / private / readonly / implements   group "用例 6"
 *   7  字符串·模板串·正则·注释里的 : < as interface enum 必须逐字保留  group "用例 7"
 *   8  satisfies / as const                 group "用例 8"
 *   9  官方包壳用法（STRIP_PREFIX/SUFFIX + slice(35,-2)）group "用例 9"
 *   10 语法错误必须抛 TypeStripError 且带 line/column    group "用例 10"
 *   11 参数属性 / 装饰器：正确编译 或 抛可定位错误        group "用例 11"
 *   12 enum / 带运行时语义的 namespace / const enum       group "用例 12"
 *
 * 【正向用例怎么判"语义不变"】每类正向用例都同时走两条路：
 *     A. 官方包壳：strip(STRIP_PREFIX + body + STRIP_SUFFIX) → slice(35,-2) → 求值
 *     B. module/script 级：strip(tsSource) → 求值
 *   并三方对账：A 的值 == B 的值 == 手写无类型等价实现（ref）的值 == 硬编码期望值。
 *   三个都相等才算过 —— 只比自己写的 ref 会"一起错"，只比硬编码又说不清语义，
 *   所以两边都要。
 *
 * 【正向用例的求值方式】用例统一写成"函数体"（以 `return (expr);` 收尾），
 * 用 `new Function(...)` 执行；`--jitless` 只关掉 JIT，解释执行 `new Function`
 * 完全正常。因此"擦除后语义不变"是**真的跑出来的**，不是正则比对出来的。
 *
 * 【--self-test 是干什么的】它把整套用例对着一个"变异擦除器"再跑一遍：
 *     sucraseLikeStripper(src) —— 只要源码里出现 namespace/module，就返回空串
 *   （这正是实测到的 sucrase 3.35.1 的行为：输入 `namespace N { export const x = 1; }`
 *     输出 `""`，静默丢代码）。自检断言"用例 12 的 namespace 那条必须挂"，
 *   以此证明本门禁**不是永真断言**。没有这一条，"门禁全绿"可能只是因为门禁什么都没查。
 *
 * ============================================================================
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, openSync, readSync, closeSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const LIB_DIR = path.join(ROOT, 'hostcore', 'plugins', 'dshm-ptc-runtime-inproc', 'lib');
const STRIP_MODULE = path.join(LIB_DIR, 'ts-strip.cjs');
const VENDOR_DIR = path.join(LIB_DIR, 'vendor');
const VENDOR_ENTRY = path.join(VENDOR_DIR, 'babel-standalone', 'babel.min.cjs');

const cliArgs = process.argv.slice(2);
const SELF_TEST = cliArgs.includes('--self-test');

/* ==========================================================================
 * 0. re-exec：不在 --jitless 下就把自己拉进 --jitless 子进程
 * ========================================================================== */

const alreadyJitless = process.execArgv.includes('--jitless');

if (!alreadyJitless) {
  console.log('[gate] 当前不在 --jitless 下，重新拉起到子进程：');
  console.log(`[gate]   ${process.execPath} --jitless ${path.relative(ROOT, SELF)} ${cliArgs.join(' ')}`.trimEnd());
  const child = spawnSync(process.execPath, ['--jitless', SELF, ...cliArgs], {
    // inherit：把子进程输出直接透传（也避免"管道捕获 stdio"在某些沙箱下的限制）
    stdio: 'inherit',
  });
  if (child.error) {
    console.error('[gate] 拉起 --jitless 子进程失败：' + child.error.message);
    process.exit(1);
  }
  process.exit(child.status === null ? 1 : child.status);
}

/* ==========================================================================
 * 1. jitless 三重自证（必须在 require 被测模块**之前**装好陷阱）
 * ========================================================================== */

console.log('================================================================');
console.log('dshm PTC TypeScript 擦除器门禁 — tools/check-ptc-ts-strip.mjs');
console.log('================================================================');
console.log(`[jitless] node ${process.version}`);
console.log(`[jitless] process.execArgv = ${JSON.stringify(process.execArgv)}`);

if (!process.execArgv.includes('--jitless')) {
  console.error('[jitless] 致命：execArgv 里没有 --jitless，拒绝继续（否则证据无效）');
  process.exit(1);
}
if (typeof WebAssembly !== 'undefined') {
  console.error('[jitless] 致命：`typeof WebAssembly` 不是 undefined，本进程并非端侧等价环境');
  process.exit(1);
}
console.log("[jitless] typeof WebAssembly === 'undefined'  ⇒ 与端侧 --jitless 一致 ✓");

/* ==========================================================================
 * 1.5 对照臂探测：官方 `node:module`.stripTypeScriptTypes 在同一进程里的表现
 * --------------------------------------------------------------------------
 * 【必须在装陷阱之前探测】官方实现内部会去**读** `WebAssembly` 全局来判断可用性（实测：
 * 装好陷阱后再调它，抛的是陷阱的错而不是 ERR_WEBASSEMBLY_NOT_SUPPORTED）。
 * 若在陷阱装好之后探测，陷阱会被官方实现触发、计数加一，把
 * "擦除器有没有碰过 wasm"这条结论污染掉。所以顺序是：先探测官方，再装陷阱，
 * 之后**只有**被测擦除器自己能触发陷阱。
 * ========================================================================== */

const requireFromHere = createRequire(SELF);

const officialStrip = (() => {
  let api;
  try {
    api = requireFromHere('node:module').stripTypeScriptTypes;
  } catch {
    api = undefined;
  }
  if (typeof api !== 'function') return { kind: 'absent' };
  try {
    return { kind: 'ok', value: api('const a: number = 1;') };
  } catch (e) {
    return { kind: 'threw', name: e.name, code: e.code, message: e.message };
  }
})();

console.log(
  '[对照臂] 官方 node:module.stripTypeScriptTypes 在本 --jitless 进程：' +
    (officialStrip.kind === 'threw'
      ? `抛 ${officialStrip.name} ${officialStrip.code || ''} ⇒ 官方路线在端侧不可用（这就是本次要修的问题）`
      : officialStrip.kind === 'ok'
        ? `竟然成功（${JSON.stringify(truncate(officialStrip.value, 60))}）⇒ 本 vendor 可能已无必要`
        : '本 Node 无此 API')
);

/**
 * WebAssembly 陷阱。读或写即计数并抛错。
 * 之所以能装：--jitless 下 globalThis 上没有 WebAssembly 自有属性（descriptor === undefined）。
 */
let wasmTrapHits = 0;
Object.defineProperty(globalThis, 'WebAssembly', {
  configurable: true,
  enumerable: false,
  get() {
    wasmTrapHits += 1;
    throw new Error('WebAssembly 陷阱：擦除器读取了 WebAssembly 全局（端侧会 ReferenceError）');
  },
  set() {
    wasmTrapHits += 1;
    throw new Error('WebAssembly 陷阱：擦除器写入了 WebAssembly 全局');
  },
});
console.log('[jitless] 已把 globalThis.WebAssembly 换成"一读就抛"的陷阱 getter ✓');

/* ==========================================================================
 * 2. vendor 树"纯 JS"审计（无 .wasm / 无原生 / 无二进制 / 无 node_modules）
 * ========================================================================== */

function walkFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(p));
    else if (ent.isFile()) out.push(p);
    else out.push(p); // symlink 等：也列出来，让审计看得见
  }
  return out;
}

const NATIVE_EXTS = new Set(['.node', '.dll', '.so', '.dylib', '.a', '.lib', '.exe', '.wasm']);
const vendorFindings = { wasm: [], native: [], binary: [], symlink: [] };
let vendorBytes = 0;
const vendorFiles = [];

if (!existsSync(VENDOR_DIR)) {
  console.error(`[vendor] 致命：vendor 目录不存在 ${VENDOR_DIR}`);
  process.exit(1);
}
for (const f of walkFiles(VENDOR_DIR)) {
  const st = statSync(f);
  const rel = path.relative(ROOT, f);
  if (st.isSymbolicLink()) vendorFindings.symlink.push(rel);
  else if (st.isFile()) {
    vendorFiles.push(rel);
    vendorBytes += st.size;
    const ext = path.extname(f).toLowerCase();
    if (ext === '.wasm') vendorFindings.wasm.push(rel);
    else if (NATIVE_EXTS.has(ext)) vendorFindings.native.push(rel);
    // 二进制嗅探：前 8 KiB 里出现 NUL 字节
    const fd = openSync(f, 'r');
    try {
      const n = Math.min(8192, st.size);
      const buf = Buffer.alloc(n);
      const got = readSync(fd, buf, 0, n, 0);
      if (buf.subarray(0, got).includes(0)) vendorFindings.binary.push(rel);
    } finally {
      closeSync(fd);
    }
  }
}

const vendorSha256 = createHash('sha256').update(readFileSync(VENDOR_ENTRY)).digest('hex');
const vendorEntryBytes = statSync(VENDOR_ENTRY).size;

console.log(
  `[vendor ] lib/vendor/** 共 ${vendorFiles.length} 个文件 / ${vendorBytes} B；` +
    `.wasm=${vendorFindings.wasm.length} 原生=${vendorFindings.native.length} 二进制=${vendorFindings.binary.length} 符号链接=${vendorFindings.symlink.length}`
);
console.log(`[vendor ] 入口 babel.min.cjs = ${vendorEntryBytes} B  sha256=${vendorSha256}`);

const pluginDir = path.join(ROOT, 'hostcore', 'plugins', 'dshm-ptc-runtime-inproc');
const strayNodeModules = [];
(function findNodeModules(dir) {
  if (!existsSync(dir)) return;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules') strayNodeModules.push(path.relative(ROOT, path.join(dir, ent.name)));
      else findNodeModules(path.join(dir, ent.name));
    }
  }
})(pluginDir);

/* ==========================================================================
 * 3. 加载被测模块（先把 cwd 挪走，以证明 vendor 是**相对路径**解析的）
 * ========================================================================== */

process.chdir(tmpdir());
const mod = requireFromHere(STRIP_MODULE);
const { stripErasableTs, TypeStripError, STRIP_PREFIX, STRIP_SUFFIX, VENDOR } = mod;

/* ==========================================================================
 * 4. 断言小工具
 * ========================================================================== */

function assertTrue(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function deepEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || '值不相等'}：实际 ${a}，期望 ${b}`);
}
function truncate(s, n = 400) {
  const t = String(s);
  return t.length > n ? `${t.slice(0, n)}…(+${t.length - n})` : t;
}
function firstLines(err, n = 4) {
  const s = err && err.stack ? err.stack : String(err);
  return s.split('\n').slice(0, n).join('\n');
}
function evalBody(body, what) {
  let fn;
  try {
    fn = new Function(body);
  } catch (e) {
    throw new Error(`${what}：产出物不是合法 JS —— ${e.message}\n--- 产出 ---\n${truncate(body, 800)}`);
  }
  return fn();
}
function assertTypeStripErrorShape(err, label) {
  assertTrue(err instanceof TypeStripError, `${label}：抛出的不是 TypeStripError（而是 ${err && err.name}）`);
  assertTrue(err.name === 'TypeStripError', `${label}：err.name 不是 'TypeStripError'（而是 ${err.name}）`);
  assertTrue(
    Number.isInteger(err.line) && err.line >= 1,
    `${label}：err.line 不是 >=1 的整数（${JSON.stringify(err.line)}）`
  );
  assertTrue(
    Number.isInteger(err.column) && err.column >= 1,
    `${label}：err.column 不是 >=1 的整数（${JSON.stringify(err.column)}）`
  );
  assertTrue(typeof err.message === 'string' && err.message.length > 0, `${label}：err.message 为空`);
}
function stripOrNull(strip, source) {
  try {
    return { ok: true, code: strip(source) };
  } catch (e) {
    return { ok: false, err: e };
  }
}

/* ==========================================================================
 * 5. 用例定义
 * ========================================================================== */

// 用例 7 的"逐字保留"素材：字符串/模板串/正则/注释里塞满 : < as interface enum。
const NO_FALSE_POSITIVE_SRC =
  'const s = "a: b <T> as interface enum";\n' +
  'const t = `x: ${1} <y> as`;\n' +
  'const re = /[:<]as/g;\n' +
  '// comment: interface enum as <T>\n' +
  '/* block: type X = 1 */\n' +
  'const n = s.length;';

/**
 * 正向用例：`ts` 是**不含顶层 return** 的 module/script 级源码（可独立擦除），
 * `expr` 是求值表达式，`expected` 是硬编码期望值，`ref` 是手写的无类型等价实现。
 */
const POSITIVE_CASES = [
  {
    id: '1',
    title: '变量/参数/返回值类型注解',
    ts: [
      'const a: number = 1;',
      'function f(x: string, y?: boolean): number { return y ? x.length : 0 }',
      'const r: number[] = [a, f("abc"), f("abc", true)];',
    ].join('\n'),
    expr: 'r',
    expected: [1, 0, 3],
    ref: ['const a = 1;', 'function f(x, y) { return y ? x.length : 0 }', 'const r = [a, f("abc"), f("abc", true)];'].join('\n'),
  },
  {
    id: '2',
    title: 'interface / type 别名 / declare（全部擦成空）',
    ts: [
      'interface A { b: number }',
      'type C = A | null;',
      'declare const d: number;',
      'declare function df(x: number): void;',
    ].join('\n'),
    expr: '1',
    expected: 1,
    ref: 'const _unused = 1;',
    // 额外：这四行必须一行不剩
    extra(stripped) {
      assertTrue(!/\binterface\b/.test(stripped), '用例 2：产出里仍残留 interface');
      assertTrue(!/\bdeclare\b/.test(stripped), '用例 2：产出里仍残留 declare');
      assertTrue(!/\btype\s+C\b/.test(stripped), '用例 2：产出里仍残留 type 别名');
    },
  },
  {
    id: '3',
    title: '泛型：Array<T> / Promise<T> / Map<string, {...}> / <T extends object>',
    ts: [
      'const m: Map<string, { a: number; b?: string[] }> = new Map([["k", { a: 1 }]]);',
      'function g<T extends object>(x: T): T { return x }',
      'const p: Promise<Array<number>> = Promise.resolve([1, 2]);',
      'const e = m.get("k");',
    ].join('\n'),
    expr: '[e ? e.a : -1, g(7), g("s"), p instanceof Promise]',
    expected: [1, 7, 's', true],
    ref: [
      'const m = new Map([["k", { a: 1 }]]);',
      'function g(x) { return x }',
      'const p = Promise.resolve([1, 2]);',
      'const e = m.get("k");',
    ].join('\n'),
  },
  {
    id: '4',
    title: 'as / 非空 ! / 可选链 ?. / 空值合并 ??（后两者不得被降级）',
    ts: [
      'const obj: any = { bar: { baz: 5 } };',
      'const v = (obj as any).bar!.baz;',
      'const a: any = { b: 2 };',
      'const z = a?.b ?? 99;',
      'const w = (null as any)?.b ?? 7;',
      'const q = a!.b!;',
    ].join('\n'),
    expr: '[v, z, w, q]',
    expected: [5, 2, 7, 2],
    ref: [
      'const obj = { bar: { baz: 5 } };',
      'const v = obj.bar.baz;',
      'const a = { b: 2 };',
      'const z = a?.b ?? 99;',
      'const w = (null)?.b ?? 7;',
      'const q = a.b;',
    ].join('\n'),
    extra(stripped) {
      assertTrue(stripped.includes('?.'), '用例 4：可选链 ?. 被擦除器改动了（应原样保留）');
      assertTrue(stripped.includes('??'), '用例 4：空值合并 ?? 被擦除器改动了（应原样保留）');
    },
  },
  {
    id: '5',
    title: '箭头函数带泛型与返回类型 `const h = <T,>(x: T): T => x`',
    ts: [
      'const h = <T,>(x: T): T => x;',
      'const k = <T extends object, U>(a: T, b: U): [T, U] => [a, b];',
    ].join('\n'),
    expr: '[h("q"), k(1, "z")]',
    expected: ['q', [1, 'z']],
    ref: ['const h = (x) => x;', 'const k = (a, b) => [a, b];'].join('\n'),
  },
  {
    id: '6',
    title: '类：字段类型注解 / private / readonly / static / implements',
    ts: [
      'interface I { m(): number }',
      'class A implements I {',
      '  private x: number = 1;',
      '  readonly y: string = "s";',
      '  static z: number = 9;',
      '  m(): number { return this.x }',
      '}',
    ].join('\n'),
    expr: '[new A().y, new A().m(), A.z]',
    expected: ['s', 1, 9],
    ref: [
      'class A {',
      '  x = 1;',
      '  y = "s";',
      '  static z = 9;',
      '  m() { return this.x }',
      '}',
    ].join('\n'),
    extra(stripped) {
      assertTrue(!/\bimplements\b/.test(stripped), '用例 6：产出里仍残留 implements');
      assertTrue(!/\bprivate\b/.test(stripped), '用例 6：产出里仍残留 private');
      assertTrue(!/\breadonly\b/.test(stripped), '用例 6：产出里仍残留 readonly');
      assertTrue(!/\binterface\b/.test(stripped), '用例 6：产出里仍残留 interface');
    },
  },
  {
    id: '7',
    title: '字符串/模板串/正则/注释里的 : < as interface enum 必须逐字保留',
    ts: NO_FALSE_POSITIVE_SRC,
    // `":as<as".match(re)` 必须命中 `[":as","<as"]` ⇒ 正则本身连 flags 一起被原样保留。
    // 这里**故意不用 `re.test(...)` 连调两次**：`/g` 正则有 lastIndex 状态，
    // 两次 test 会互相干扰（那是在测 JS 的坑，不是测擦除器）。
    // `String.prototype.match` 对 `g` 正则不读 lastIndex，是干净的。
    // `n` 是 `"a: b <T> as interface enum"` 的长度（26）⇒ 字符串内容没被截断/改写。
    expr: '[s, t, re.source, ":as<as".match(re), n]',
    expected: ['a: b <T> as interface enum', 'x: 1 <y> as', '[:<]as', [':as', '<as'], 26],
    // ref 就是源码本身 —— 它本来就没有类型，是合法 JS
    ref: NO_FALSE_POSITIVE_SRC,
    // 对"无类型可擦"的源码，擦除器必须**逐字节原样返回**
    byteIdentical: true,
    extra(stripped) {
      for (const needle of ['"a: b <T> as interface enum"', '`x: ${1} <y> as`', '/[:<]as/g', '// comment: interface enum as <T>', '/* block: type X = 1 */']) {
        assertTrue(stripped.includes(needle), `用例 7：${needle} 未逐字保留`);
      }
    },
  },
  {
    id: '8',
    title: 'satisfies / as const',
    ts: [
      'const o = { a: 1 } satisfies Record<string, number>;',
      'const arr = [1, 2] as const;',
      'const frozen = { b: 3 } as const;',
    ].join('\n'),
    expr: '[o.a, arr[0], arr.length, frozen.b]',
    expected: [1, 1, 2, 3],
    ref: ['const o = { a: 1 };', 'const arr = [1, 2];', 'const frozen = { b: 3 };'].join('\n'),
    extra(stripped) {
      assertTrue(!/\bsatisfies\b/.test(stripped), '用例 8：产出里仍残留 satisfies');
      assertTrue(!/\bas\s+const\b/.test(stripped), '用例 8：产出里仍残留 as const');
    },
  },
];

/* ==========================================================================
 * 6. 套件主体（可注入不同的 strip 实现 → --self-test 用变异体验证门禁非永真）
 * ========================================================================== */

function runSuite(strip, opts) {
  const quiet = !!(opts && opts.quiet);
  const failures = [];
  let pass = 0;
  const emit = (...a) => {
    if (!quiet) console.log(...a);
  };

  function test(label, fn) {
    try {
      fn();
      pass += 1;
      emit(`  ok   ${label}`);
    } catch (e) {
      failures.push({ label, error: e });
      emit(`  FAIL ${label}`);
      emit(`       ${firstLines(e).split('\n').join('\n       ')}`);
    }
  }
  function group(title) {
    emit(`\n--- ${title} ---`);
  }

  /* ---------- 导出面 ---------- */
  group('导出面 / 常量对齐');
  test('导出 stripErasableTs (function) 与 TypeStripError (function)', () => {
    assertTrue(typeof stripErasableTs === 'function', 'stripErasableTs 不是函数');
    assertTrue(typeof TypeStripError === 'function', 'TypeStripError 不是函数');
    assertTrue(TypeStripError.prototype instanceof Error, 'TypeStripError 不是 Error 的子类');
  });
  test('STRIP_PREFIX 长度 35、STRIP_SUFFIX 长度 2（与官方 lib/index.js:755-756 对齐）', () => {
    assertTrue(STRIP_PREFIX.length === 35, `STRIP_PREFIX.length=${STRIP_PREFIX.length}，应为 35`);
    assertTrue(STRIP_SUFFIX.length === 2, `STRIP_SUFFIX.length=${STRIP_SUFFIX.length}，应为 2`);
    assertTrue(STRIP_PREFIX === 'async function __dsh_program__() {\n', 'STRIP_PREFIX 字面量不对');
    assertTrue(STRIP_SUFFIX === '\n}', 'STRIP_SUFFIX 字面量不对');
  });
  test('vendor 元数据与树里的字节数/sha256 一致（防止 vendor 被误替换）', () => {
    assertTrue(VENDOR && VENDOR.name === '@babel/standalone', `vendor 名称异常：${VENDOR && VENDOR.name}`);
    assertTrue(VENDOR.version === '7.28.4', `vendor 版本异常：${VENDOR.version}`);
    assertTrue(VENDOR.bytes === vendorEntryBytes, `vendor 字节数 ${vendorEntryBytes} ≠ 声明 ${VENDOR.bytes}`);
    assertTrue(vendorSha256 === VENDOR.sha256, `vendor sha256 ${vendorSha256} ≠ 声明 ${VENDOR.sha256}`);
    assertTrue(VENDOR.specifier.startsWith('./'), 'vendor 说明符不是相对路径');
    assertTrue(existsSync(path.join(LIB_DIR, VENDOR.specifier)), `相对路径解析不到：${VENDOR.specifier}`);
  });
  test('vendor 树是纯 JS：无 .wasm / 无原生模块 / 无二进制 / 无符号链接', () => {
    assertTrue(vendorFindings.wasm.length === 0, `发现 .wasm：${vendorFindings.wasm.join(', ')}`);
    assertTrue(vendorFindings.native.length === 0, `发现原生模块：${vendorFindings.native.join(', ')}`);
    assertTrue(vendorFindings.binary.length === 0, `发现二进制文件：${vendorFindings.binary.join(', ')}`);
    assertTrue(vendorFindings.symlink.length === 0, `发现符号链接：${vendorFindings.symlink.join(', ')}`);
  });
  test('插件目录下没有 node_modules（vendor 不依赖核心树/宿主机的模块解析）', () => {
    assertTrue(strayNodeModules.length === 0, `发现 node_modules：${strayNodeModules.join(', ')}`);
  });

  /* ---------- 正向：1..8，每条走"包壳 + 直接擦除"两条路 ---------- */
  for (const c of POSITIVE_CASES) {
    group(`用例 ${c.id}  ${c.title}`);
    const body = `${c.ts}\nreturn (${c.expr});`;
    const wrapped = `${STRIP_PREFIX}${body}${STRIP_SUFFIX}`;

    let wrappedInner = null;
    test(`${c.id}.A 官方包壳用法：擦除 → slice(35,-2) → 可求值`, () => {
      const out = strip(wrapped);
      assertTrue(typeof out === 'string', `${c.id}.A：产出不是字符串`);
      assertTrue(out.startsWith(STRIP_PREFIX), `${c.id}.A：产出不再以 STRIP_PREFIX 开头`);
      assertTrue(out.endsWith(STRIP_SUFFIX), `${c.id}.A：产出不再以 STRIP_SUFFIX 结尾`);
      wrappedInner = out.slice(STRIP_PREFIX.length, out.length - STRIP_SUFFIX.length);
      evalBody(wrappedInner, `${c.id}.A`);
    });

    let directCode = null;
    let directValue;
    test(`${c.id}.B module/script 级直接擦除：产出是合法 JS 且可求值`, () => {
      directCode = strip(c.ts);
      assertTrue(typeof directCode === 'string', `${c.id}.B：产出不是字符串`);
      directValue = evalBody(`${directCode}\nreturn (${c.expr});`, `${c.id}.B`);
    });

    test(`${c.id}.C 两条路语义一致（包壳 A == 直接 B）`, () => {
      if (wrappedInner === null) throw new Error(`${c.id}.C：跳过 —— A 未产出可求值结果`);
      deepEq(evalBody(wrappedInner, `${c.id}.C`), directValue, `${c.id}.C 包壳与直接擦除语义不一致`);
    });

    test(`${c.id}.D 与硬编码期望值一致`, () => {
      deepEq(directValue, c.expected, `${c.id}.D 结果与期望不符`);
    });

    test(`${c.id}.E 与手写无类型等价实现一致（擦除后语义不变）`, () => {
      deepEq(directValue, evalBody(`${c.ref}\nreturn (${c.expr});`, `${c.id}.E ref`), `${c.id}.E 语义被改变`);
    });

    if (c.byteIdentical) {
      test(`${c.id}.F 无类型可擦时必须逐字节原样返回`, () => {
        assertTrue(directCode === c.ts, `${c.id}.F 产出与输入不是逐字节相同`);
      });
    }

    if (c.extra) {
      test(`${c.id}.G 额外断言（残留检查 / 不得误改）`, () => {
        c.extra(directCode);
      });
    }
  }

  /* ---------- 用例 9：包壳用法（任务单独点名） ---------- */
  group('用例 9  官方包壳用法：stripErasableTs(STRIP_PREFIX + body + STRIP_SUFFIX)');
  test('9.1 整段包壳擦除成功，切壳后是合法 JS 且行为正确', () => {
    const body = 'const a: number = 1;\nreturn a;';
    const out = strip(STRIP_PREFIX + body + STRIP_SUFFIX);
    assertTrue(out.startsWith(STRIP_PREFIX), '9.1：产出不以 STRIP_PREFIX 开头（官方 slice(35,...) 会切错）');
    assertTrue(out.endsWith(STRIP_SUFFIX), '9.1：产出不以 STRIP_SUFFIX 结尾（官方 slice(...,-2) 会切错）');
    const inner = out.slice(35, out.length - 2);
    deepEq(evalBody(inner, '9.1 切壳结果'), 1, '9.1：切壳后行为不对');
  });
  test('9.2 壳内含有 interface/enum/generics 时同样成立', () => {
    const body = [
      'interface P { a: number }',
      'enum E { X = 4 }',
      'function pick<T>(v: T): T { return v }',
      'const p: P = { a: E.X };',
      'return pick(p.a);',
    ].join('\n');
    const out = strip(STRIP_PREFIX + body + STRIP_SUFFIX);
    deepEq(evalBody(out.slice(35, out.length - 2), '9.2 切壳结果'), 4, '9.2：切壳后行为不对');
  });

  /* ---------- 用例 10：语法错误 ---------- */
  group('用例 10  语法错误必须抛 TypeStripError 且带 1-based line/column');
  test('10.1 `const = ;` → line 1, column 7', () => {
    const r = stripOrNull(strip, 'const = ;');
    assertTrue(!r.ok, '10.1：语法错误没有抛错');
    assertTypeStripErrorShape(r.err, '10.1');
    deepEq([r.err.line, r.err.column], [1, 7], '10.1 定位不对');
  });
  test('10.2 未闭合大括号 → line 2, column 23', () => {
    const r = stripOrNull(strip, 'function f() {\n  const x: number = 1;');
    assertTrue(!r.ok, '10.2：未闭合括号没有抛错');
    assertTypeStripErrorShape(r.err, '10.2');
    deepEq([r.err.line, r.err.column], [2, 23], '10.2 定位不对');
  });
  test('10.3 未闭合圆括号 → line 1, column 13', () => {
    const r = stripOrNull(strip, 'const a = (1;');
    assertTrue(!r.ok, '10.3：未闭合圆括号没有抛错');
    assertTypeStripErrorShape(r.err, '10.3');
    deepEq([r.err.line, r.err.column], [1, 13], '10.3 定位不对');
  });
  test('10.4 报错文案里带人类可读原因 + 代码帧（便于模型自我修复）', () => {
    const r = stripOrNull(strip, 'const = ;');
    assertTrue(!r.ok, '10.4：没有抛错');
    assertTrue(/unexpected token/i.test(r.err.message), `10.4：message 不含原因 —— ${truncate(r.err.message)}`);
    assertTrue(r.err.message.includes('> 1 |'), `10.4：message 不含代码帧 —— ${truncate(r.err.message)}`);
  });
  test('10.5 包壳场景下的定位是相对"收到的那段 source"（不做偏移）', () => {
    // 壳内第 1 行是壳头，第 2 行才是声明；错误报在 2 行（而不是相对 body 的 1 行）
    const src = `${STRIP_PREFIX}const = ;${STRIP_SUFFIX}`;
    const r = stripOrNull(strip, src);
    assertTrue(!r.ok, '10.5：没有抛错');
    deepEq([r.err.line, r.err.column], [2, 7], '10.5：定位不是相对传入 source');
  });

  /* ---------- 用例 11：参数属性 / 装饰器 ---------- */
  group('用例 11  参数属性、装饰器：正确编译 或 抛可定位错误（绝不允许静默产出坏代码）');
  test('11.1 参数属性 `constructor(private x: number)`：编译正确 或 抛可定位错误', () => {
    const ts = 'class B { constructor(private x: number) {} get(): number { return this.x } }';
    const r = stripOrNull(strip, ts);
    if (!r.ok) {
      assertTypeStripErrorShape(r.err, '11.1');
      emit(`       （本 vendor 选择抛错而非转换：${r.err.line}:${r.err.column}）`);
      return;
    }
    // 不抛就必须真的对：产出是合法 JS、语义正确
    assertTrue(/this\.x\s*=\s*x/.test(r.code), `11.1：编译产出里没有 this.x = x —— ${truncate(r.code)}`);
    deepEq(evalBody(`${r.code}\nreturn new B(5).get();`, '11.1'), 5, '11.1：参数属性语义不对');
    emit('       （本 vendor 是**转换**而非报错：产出 `this.x = x`）');
  });
  test('11.2 装饰器 `@dec class A {}`：正确编译 或 抛可定位错误', () => {
    const r = stripOrNull(strip, '@dec class A {}');
    if (!r.ok) {
      assertTypeStripErrorShape(r.err, '11.2');
      emit(`       （本 vendor 对装饰器选择抛可定位错误：${r.err.line}:${r.err.column}）`);
      return;
    }
    // 若某天 vendor 改成"原样透传装饰器"，产出必须是**合法 JS**（否则就是静默产出坏代码）
    evalBody(r.code, '11.2');
    emit('       （本 vendor 原样透传装饰器，且产出仍是合法 JS）');
  });
  test('11.3 成员装饰器 `class B { @dec m() {} }`：编译正确 或 抛可定位错误', () => {
    const r = stripOrNull(strip, 'class B { @dec m() {} }');
    if (!r.ok) {
      assertTypeStripErrorShape(r.err, '11.3');
      return;
    }
    evalBody(r.code, '11.3');
  });

  /* ---------- 用例 12：enum / namespace / const enum ---------- */
  group('用例 12  enum、带运行时语义的 namespace、const enum：正确编译 或 抛可定位错误');
  test('12.1 enum 编译正确且运行语义正确（E.A=0, E.B=1, E[0]="A"）', () => {
    const r = stripOrNull(strip, 'enum E { A, B }');
    assertTrue(r.ok, `12.1：enum 抛错了 —— ${r.ok ? '' : r.err.message}`);
    deepEq(evalBody(`${r.code}\nreturn [E.A, E.B, E[0], E[1]];`, '12.1'), [0, 1, 'A', 'B'], '12.1：enum 语义不对');
  });
  test('12.2 带运行时语义的 namespace 编译正确（**sucrase 会在这里静默丢代码**）', () => {
    const src = 'namespace N { export const x = 1; export function f(): number { return 2 } }';
    const r = stripOrNull(strip, src);
    assertTrue(r.ok, `12.2：namespace 抛错了 —— ${r.ok ? '' : r.err.message}`);
    assertTrue(r.code.trim().length > 0, '12.2：namespace 被静默擦成空串（这就是 sucrase 的失败模式）');
    // 产出必须是合法 JS，且运行时真的能取到 N.x / N.f()
    deepEq(evalBody(`${r.code}\nreturn [N.x, N.f()];`, '12.2'), [1, 2], '12.2：namespace 运行语义不对');
  });
  test('12.3 const enum 编译正确（E.A=5, E.B=7）', () => {
    const r = stripOrNull(strip, 'const enum CE { A = 5, B = 7 }');
    assertTrue(r.ok, `12.3：const enum 抛错了 —— ${r.ok ? '' : r.err.message}`);
    deepEq(evalBody(`${r.code}\nreturn [CE.A, CE.B];`, '12.3'), [5, 7], '12.3：const enum 语义不对');
  });
  test('12.4 环境声明 `declare enum` / `declare namespace` 被擦除且不抛错', () => {
    // 注意：这里**不能**在源码里写顶层 return —— 这是 module/script 级源码，
    // 不是函数体（顶层 return 是语法错误，属于用例 10 的范畴）。
    const r = stripOrNull(strip, 'declare enum DE { A }\ndeclare namespace DN { const y: number }');
    assertTrue(r.ok, `12.4：declare enum/namespace 抛错了 —— ${r.ok ? '' : r.err.message}`);
    assertTrue(!/\bdeclare\b/.test(r.code), '12.4：产出里仍残留 declare');
    assertTrue(r.code.trim() === '', `12.4：环境声明应被完全擦除，实际产出 ${JSON.stringify(truncate(r.code, 120))}`);
  });
  test('12.5 namespace 产出里必须真的出现 N（防止"擦成空串"这类静默丢失）', () => {
    const r = stripOrNull(strip, 'namespace N { export const x = 1; }');
    assertTrue(r.ok, '12.5：抛错了');
    assertTrue(/\bN\b/.test(r.code), `12.5：产出里没有 N —— ${truncate(r.code)}`);
  });

  /* ---------- 附加：擦除器边界与模块级支持 ---------- */
  group('附加  模块级语法 / 导入语义 / 其它边界');
  test('E1 module 级源码（有 import/export）可擦除，且不降级模块语法', () => {
    const src = 'import type { A } from "./a";\nimport { B } from "./b";\nimport { type C, D } from "./c";\nexport type { A };\nconsole.log(B, D);';
    const r = stripOrNull(strip, src);
    assertTrue(r.ok, `E1：module 级源码抛错了 —— ${r.ok ? '' : r.err.message}`);
    assertTrue(!/import\s+type/.test(r.code), 'E1：`import type` 未删干净');
    assertTrue(!/\.\/a"/.test(r.code), 'E1：类型专用 import 的模块说明符未删掉');
    assertTrue(!/export\s+type/.test(r.code), 'E1：`export type` 未删干净');
    assertTrue(r.code.includes('./b"') && r.code.includes('./c"'), 'E1：把无法判定为类型的 import 误删了');
    assertTrue(r.code.includes('B') && r.code.includes('D'), 'E1：值导入被误删');
  });
  test('E2 `declare module` / `declare global` 被擦除', () => {
    const r = stripOrNull(strip, 'declare module "m" { const q: number }\ndeclare global { interface Window { a: number } }\nexport {};');
    assertTrue(r.ok, `E2：抛错了 —— ${r.ok ? '' : r.err.message}`);
    assertTrue(!/\binterface\b/.test(r.code), 'E2：残留 interface');
  });
  test('E3 abstract class / this 参数 / 类型谓词 / 重载 均被正确处理', () => {
    const r = stripOrNull(
      strip,
      [
        'abstract class K { abstract m(): void; n(): void {} }',
        'function withThis(this: any, x: number) { return x }',
        'function isFoo(x: any): x is Foo { return true }',
        'function ov(a: number): number;',
        'function ov(a: string): string;',
        'function ov(a: any): any { return a }',
      ].join('\n')
    );
    assertTrue(r.ok, `E3：抛错了 —— ${r.ok ? '' : r.err.message}`);
    assertTrue(!/\babstract\b/.test(r.code), 'E3：残留 abstract');
    assertTrue(!/\bthis:\s*any/.test(r.code), 'E3：残留 this 参数的类型');
    assertTrue((r.code.match(/function ov/g) || []).length === 1, 'E3：重载签名没有被消掉');
  });
  test('E4 非擦除语法 `import x = require()` / `export =` 抛可定位错误（不静默）', () => {
    for (const src of ['import x = require("y"); x();', 'declare const z: number; export = z;']) {
      const r = stripOrNull(strip, src);
      assertTrue(!r.ok, `E4：${truncate(src, 40)} 没有抛错（会被静默产出坏代码）`);
      assertTypeStripErrorShape(r.err, `E4/${truncate(src, 20)}`);
    }
  });
  test('E5 入参不是字符串 → TypeError（且不伪装成 TypeStripError）', () => {
    for (const bad of [null, undefined, 42, {}, ['x']]) {
      let thrown = null;
      try {
        strip(bad);
      } catch (e) {
        thrown = e;
      }
      assertTrue(thrown instanceof TypeError, `E5：strip(${JSON.stringify(bad)}) 没有抛 TypeError`);
      assertTrue(!(thrown instanceof TypeStripError), 'E5：API 误用不该伪装成 TypeStripError');
    }
  });
  test('E6 再次擦除已擦除的代码：不抛错且语义不变（幂等性，语义层面）', () => {
    // 同样用 module 级源码（无顶层 return）
    const once = strip('const a: number = 1;\nfunction f(x: string): string { return x }');
    const twice = strip(once);
    deepEq(evalBody(`${twice}\nreturn [a, f("z")];`, 'E6'), [1, 'z'], 'E6：二次擦除后语义变了');
  });
  test('E7 空源码 / 纯注释源码不抛错', () => {
    for (const src of ['', '   ', '// just a comment\n', '/* only block */']) {
      const r = stripOrNull(strip, src);
      assertTrue(r.ok, `E7：${JSON.stringify(src)} 抛错了 —— ${r.ok ? '' : r.err.message}`);
      assertTrue(typeof r.code === 'string', `E7：${JSON.stringify(src)} 产出不是字符串`);
    }
  });
  test('E8 未启用 preset-env：不降级 ?. / ?? / 类字段 等现代语法', () => {
    const r = stripOrNull(strip, 'const a = b?.c ?? 1;\nclass Z { f = 1; static s = 2; #p = 3; getP() { return this.#p } }');
    assertTrue(r.ok, `E8：抛错了 —— ${r.ok ? '' : r.err.message}`);
    assertTrue(r.code.includes('?.') && r.code.includes('??'), 'E8：可选链/空值合并被降级');
    assertTrue(r.code.includes('#p'), 'E8：私有字段被降级/改写');
    assertTrue(/f\s*=\s*1/.test(r.code), 'E8：类字段被降级');
  });

  /* ---------- 对照臂：官方擦除路径在同一进程里必须失败 ---------- */
  group('对照臂  官方 `node:module`.stripTypeScriptTypes 在同一 --jitless 进程里必须失败');
  test('CA.1 官方 stripTypeScriptTypes 在本进程抛错（证明门禁确实在测那个真问题）', () => {
    // 这条断言的作用：证明"本门禁不是自说自话"。
    // 若哪天官方改成纯 JS 实现、在本进程里能跑通，这条会失败 —— 那是**好消息**，
    // 说明本 vendor 可以退休了（到时应删掉这个插件，而不是把这条断言改绿）。
    if (officialStrip.kind === 'absent') {
      emit('       （本 Node 没有 stripTypeScriptTypes，跳过对照臂）');
      return;
    }
    assertTrue(
      officialStrip.kind === 'threw',
      `CA.1：官方 stripTypeScriptTypes 竟然成功了（产出 ${JSON.stringify(truncate(officialStrip.value, 80))}）—— ` +
        '要么本进程不是真 jitless，要么官方已换纯 JS 实现'
    );
    emit(
      `       （官方抛：${officialStrip.name} ${officialStrip.code || ''} ${truncate(officialStrip.message, 90)}）`
    );
    // 只要求"抛错"，不把 code 钉死成 ERR_WEBASSEMBLY_NOT_SUPPORTED：
    // 换 Node 版本时错误码可能变，但"官方路径在 jitless 下不可用"这个事实不变。
  });

  /* ---------- 回归：retainLines 默认值（有实测证据的硬要求） ---------- */
  group('回归  retainLines 默认必须是 false（否则官方 slice(35,-2) 会切坏代码）');
  test('R1 默认配置在"壳内含 enum"场景下仍保住包壳首尾不变量并跑对', () => {
    // 这是 retainLines:true 实际会炸的那个输入。默认配置必须扛住。
    const body = [
      'interface P { a: number }',
      'enum E { X = 4 }',
      'function pick<T>(v: T): T { return v }',
      'const p: P = { a: E.X };',
      'return pick(p.a);',
    ].join('\n');
    const out = strip(`${STRIP_PREFIX}${body}${STRIP_SUFFIX}`);
    assertTrue(out.startsWith(STRIP_PREFIX), 'R1：默认配置下输出不再以 STRIP_PREFIX 逐字开头');
    assertTrue(out.endsWith(STRIP_SUFFIX), 'R1：默认配置下输出不再以 STRIP_SUFFIX 结尾');
    deepEq(evalBody(out.slice(35, out.length - 2), 'R1'), 4, 'R1：切壳后行为不对');
  });
  test('R2 记录 `retainLines:true` 的地雷（仅记录，不判定失败）', () => {
    // 不把"Babel 一定会粘行"钉成断言 —— 上游有权改。只把观测打进日志，
    // 让后来者能看到"为什么默认是 false"是实测出来的，而不是抄来的。
    const body = 'enum E { X = 4 }\nreturn E.X;';
    let observed = '(未观测：调用抛错了)';
    try {
      const out = strip(`${STRIP_PREFIX}${body}${STRIP_SUFFIX}`, { retainLines: true });
      observed = out.startsWith(STRIP_PREFIX)
        ? '本次未复现粘连（前缀不变量仍成立）'
        : `已复现粘连：输出开头 = ${JSON.stringify(truncate(out.slice(0, 46), 46))} ⇒ slice(35,-2) 会切坏`;
    } catch (e) {
      observed = `调用抛错：${truncate(e.message, 80)}`;
    }
    emit(`       （retainLines:true 观测：${observed}）`);
  });

  /* ---------- 与宿主插件的跨边界契约 ---------- */
  group('跨边界契约  包壳空体形状、包壳内 import、vendor 必须 .cjs');

  test('XB.1 无运行时语句的包壳被折叠成 `async function __dsh_program__() {}`（lib/index.js:464 的空体正则依赖此形状）', () => {
    // 宿主插件 lib/index.js:464 用
    //     /^async function __dsh_program__\(\)\s*\{\s*\}$/
    // 识别"体为空"，此时首尾壳**不再逐字保留**，必须特判才能不落进它的"壳被改写"守卫。
    // 也就是说"空体折叠成 {}"是**两个包之间的契约**，所以在这里钉住。
    const EMPTY_SHELL = 'async function __dsh_program__() {}';
    const programs = [
      '',
      '   ',
      '\n\n',
      'interface X { a: number }',
      'type T = number;',
      'declare const x: number;',
      'interface X { a: number }\ntype T = number;\ndeclare const x: number;',
    ];
    for (const program of programs) {
      const out = strip(`${STRIP_PREFIX}${program}${STRIP_SUFFIX}`);
      assertTrue(
        out === EMPTY_SHELL,
        `XB.1：program=${JSON.stringify(truncate(program, 40))} 的产出不是空壳形状，而是 ${JSON.stringify(truncate(out, 90))}`
      );
      assertTrue(
        /^async function __dsh_program__\(\)\s*\{\s*\}$/.test(out),
        'XB.1：宿主 lib/index.js:464 的空体正则不再匹配 —— 空程序会被误报成"壳被改写"内部错误'
      );
    }
  });

  test('XB.2 只有注释 / 只有空语句的包壳**保留**首尾壳，走正常切壳路径', () => {
    for (const program of ['// only a comment', '/* only a block */', ';']) {
      const out = strip(`${STRIP_PREFIX}${program}${STRIP_SUFFIX}`);
      assertTrue(
        out.startsWith(STRIP_PREFIX) && out.endsWith(STRIP_SUFFIX),
        `XB.2：program=${JSON.stringify(program)} 把壳弄丢了 —— ${JSON.stringify(truncate(out, 90))}`
      );
      evalBody(out.slice(STRIP_PREFIX.length, out.length - STRIP_SUFFIX.length), `XB.2/${program}`);
    }
  });

  test('XB.3 包壳里出现顶层 import/export 必须抛可定位错误（program 是函数体，与官方同口径）', () => {
    // 官方也是 `stripTypeScriptTypes("async function …{\n" + program + "\n}")`，
    // 所以 program 里写顶层 import 在官方路径上同样不合法（函数体内不能有 import）。
    // 重点是**报得出来**：这条必须抛可定位的 TypeStripError，而不是静默产出解析不了的码。
    const r = stripOrNull(strip, `${STRIP_PREFIX}import type { A } from "./a";${STRIP_SUFFIX}`);
    assertTrue(!r.ok, 'XB.3：包壳内 import 竟然没抛错 —— 产出的东西在端侧会解析失败');
    assertTypeStripErrorShape(r.err, 'XB.3');
    emit(`       （包壳内 import 报 ${r.err.line}:${r.err.column}，宿主会换算成 program 第 ${Math.max(1, r.err.line - 1)} 行）`);
  });

  test('XB.4 vendor 与擦除器必须是 .cjs（插件 package.json 声明 "type":"module"）', () => {
    // 实测（Node v24.19.0，宿主 package.json 为 "type":"module"）：
    //   · vendor 命名 babel.min.js  ⇒ Node 的 require(esm) 把 UMD 当 ESM 加载，
    //     UMD 包装里的 module/exports 分支不成立 ⇒ require 拿到空命名空间
    //     ⇒ 报 `api.transform is not a function`（错得莫名其妙）。
    //   · vendor 命名 babel.min.cjs ⇒ 正常。
    // 所以 .cjs 不是"防御性风格"，是这个包 layout 下的**硬要求**。
    const manifestPath = path.join(pluginDir, 'package.json');
    if (!existsSync(manifestPath)) {
      emit('       （插件 package.json 尚不存在，跳过；打包层补上后本断言会自动生效）');
      return;
    }
    let type;
    try {
      type = JSON.parse(readFileSync(manifestPath, 'utf8')).type;
    } catch (e) {
      throw new Error(`XB.4：插件 package.json 读不动/不是合法 JSON —— ${e.message}`);
    }
    if (type !== 'module') {
      emit(`       （package.json type=${JSON.stringify(type)}，本断言不适用）`);
      return;
    }
    assertTrue(
      VENDOR.specifier.endsWith('.cjs'),
      `XB.4：vendor 入口 ${VENDOR.specifier} 不是 .cjs —— 在 "type":"module" 的包内会被 require(esm) 当 ESM 加载而失效`
    );
    assertTrue(STRIP_MODULE.endsWith('.cjs'), 'XB.4：ts-strip.cjs 不是 .cjs');
    assertTrue(
      existsSync(path.join(LIB_DIR, VENDOR.specifier)),
      `XB.4：相对路径解析不到 ${VENDOR.specifier}`
    );
    emit('       （package.json type=module ⇒ vendor 与擦除器均为 .cjs —— 已满足）');
  });

  return { pass, fail: failures.length, failures };
}

/* ==========================================================================
 * 7. 跑正式套件
 * ========================================================================== */

console.log('\n=================== 正式套件（真实擦除器） ===================');
const main = runSuite(stripErasableTs, { quiet: false });

/* ==========================================================================
 * 8. WebAssembly 陷阱最终结算
 * ========================================================================== */

console.log('\n=================== WebAssembly 陷阱结算 ===================');
console.log(`[wasm] 陷阱触发次数 = ${wasmTrapHits}`);
if (wasmTrapHits !== 0) {
  console.error('[wasm] 致命：擦除器读过/写过 WebAssembly 全局 —— 端侧必然 ReferenceError');
  main.failures.push({ label: 'WebAssembly 陷阱被触发', error: new Error(`触发 ${wasmTrapHits} 次`) });
}

/* ==========================================================================
 * 9. --self-test：变异测试，证明门禁不是永真断言
 * ========================================================================== */

let selfTestOk = true;
if (SELF_TEST) {
  console.log('\n=================== --self-test：门禁变异测试 ===================');
  const sucraseLikeStripper = (source) => {
    // 复刻实测到的 sucrase 3.35.1 行为：namespace/module 被当成纯类型，静默丢成空串
    if (/\bnamespace\b|\bmodule\b/.test(source)) return '';
    if (/\benum\b/.test(source)) return ''; // sucrase 对 enum 其实是正确的；这里顺手也测一条
    return stripErasableTs(source);
  };
  const mutant = runSuite(sucraseLikeStripper, { quiet: true });
  const nsFailures = mutant.failures.filter((f) => /12\.2|12\.5/.test(f.label));
  console.log(`[self-test] 变异体（sucrase 式静默丢 namespace）失败用例数 = ${mutant.fail}, 通过 = ${mutant.pass}`);
  console.log(`[self-test] 其中命中 namespace 断言的有 ${nsFailures.length} 条：`);
  for (const f of nsFailures) console.log(`             - ${f.label}: ${String(f.error.message).split('\n')[0]}`);
  if (nsFailures.length === 0) {
    console.error('[self-test] 失败：门禁没有抓住"静默丢 namespace"—— 说明 namespace 断言是永真的');
    selfTestOk = false;
  } else {
    console.log('[self-test] 通过：门禁确实能抓住"静默丢 namespace"这类静默产出坏代码 ✓');
  }
}

/* ==========================================================================
 * 10. 汇总
 * ========================================================================== */

console.log('\n================================================================');
console.log(`PASS ${main.pass}  FAIL ${main.fail}${SELF_TEST ? `  SELF-TEST ${selfTestOk ? 'ok' : 'FAILED'}` : ''}`);
console.log(`[wasm] 陷阱触发次数 = ${wasmTrapHits}（0 ⇒ 擦除器全程未触碰 WebAssembly）`);
console.log(`[jitless] 本进程 execArgv 含 --jitless，typeof WebAssembly === 'undefined'`);
console.log('================================================================');

if (main.fail > 0) {
  console.error('\n失败明细：');
  for (const f of main.failures) console.error(`  - ${f.label}\n      ${String(f.error && f.error.message).split('\n')[0]}`);
}

process.exit(main.fail === 0 && selfTestOk ? 0 : 1);
