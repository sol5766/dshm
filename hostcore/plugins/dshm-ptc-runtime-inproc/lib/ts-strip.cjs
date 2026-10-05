'use strict';

/*
 * ============================================================================
 * dshm-ptc-runtime-inproc / lib/ts-strip.cjs
 * ----------------------------------------------------------------------------
 * 纯 JS 的 erasable-TypeScript 擦除器。存在的唯一理由：
 *
 *   端侧 Node 以 `--jitless` 启动 ⇒ `typeof WebAssembly === 'undefined'`
 *   （已实测：node --jitless -e "console.log(typeof WebAssembly)" → undefined）。
 *   官方 `@deepseek-ai/dsh-ptc-runtime-node` 用 `node:module` 的
 *   `stripTypeScriptTypes()` 擦类型，而它底层是 SWC 的 **wasm** 实现 ⇒
 *   在端侧解析/编译之前就抛 `ReferenceError: WebAssembly is not defined`。
 *   所以这里必须提供一个**运行时绝不触碰 WebAssembly**的纯 JS 替代。
 *
 * 【本文件对调用方的契约】
 *   - 纯同步；无网络；无子进程；无原生模块；不读环境变量；不写文件。
 *   - 全程不出现 `WebAssembly`（门禁 `tools/check-ptc-ts-strip.mjs` 会在
 *     `--jitless` 下装一个"读 WebAssembly 即抛"的陷阱 getter 来证明这一点）。
 *
 * ----------------------------------------------------------------------------
 * 【vendor 选型：为什么是 @babel/standalone，而不是 sucrase / typescript】
 *
 * 包名 + 版本 + 体积（均为**实测**，非估计）：
 *
 *   | 候选                          | 需要 vendor 的字节  | 用例结论                    |
 *   |-------------------------------|--------------------|-----------------------------|
 *   | @babel/standalone 7.28.4      | 3 069 546 B (2.93 MiB) | 12 类全过（**选用**）    |
 *   | typescript 5.9.3              | 9 112 572 B (8.69 MiB) | 12 类全过（备选）        |
 *   | sucrase 3.35.1 (+8 个依赖)    | 1 137 073 B + 依赖树   | **静默丢 namespace，淘汰** |
 *
 *   - `sucrase` 本来最小，但它对 **所有** namespace 形式（`namespace N {...}`、
 *     `module N {...}`、`declare namespace`、有无 `imports` transform）都返回
 *     **空字符串** —— 输入 `namespace N { export const x = 1; }` 输出 `""`。
 *     这是"静默产出坏代码"，正是本任务明令禁止的失败模式（用例 12）。
 *     其 README 亦自述 "Sucrase does not check your code for errors"。
 *   - `typescript@5.9.3` 完全正确（`ts.transpileModule`），但单文件
 *     `lib/typescript.js` 就有 9.1 MB，是本方案的 2.97 倍；且 `transpileModule`
 *     的 diagnostics 只给字符 offset，要自己做 offset→行列映射。
 *   - `@babel/standalone@7.28.4` 是**单个自包含文件**（browserify bundle，
 *     零运行时依赖），`plugins: [['transform-typescript', ...]]` 只做类型擦除，
 *     不引入任何 preset（不降级 `?.` / `??`），且直接给出 `err.loc`
 *     （`{line, column}`，column 0-based），错误定位最省事。
 *     本项目**没有**用它做模块转换（不生成 CJS），只是当作 TS→JS 擦除器。
 *
 * 【体积/纯度实测证据】见 `lib/vendor/babel-standalone/PROVENANCE.md`。
 *   vendor 文件本身对 `WebAssembly` 只有 3 处**字符串字面量**命中，全部位于
 *   `@babel/preset-env` 的 core-js 兼容性数据表里（一份浏览器全局名清单 +
 *   两份 core-js `web.*` 模块描述表），都是"被读时才构造的数据"，不是执行路径；
 *   我们连 preset-env 都不启用。`grep -c '\.wasm'` = 0，无 `.node` 原生模块。
 *
 * ----------------------------------------------------------------------------
 * 【与官方 `stripTypeScriptTypes` 的行为对齐口径】
 *
 *   官方用法（`@deepseek-ai/dsh-ptc-runtime-node/lib/index.js:755-756, 930`）：
 *       const STRIP_PREFIX = "async function __dsh_program__() {\n";  // 35 字符
 *       const STRIP_SUFFIX = "\n}";                                   // 2 字符
 *       const stripped = stripTypeScriptTypes(STRIP_PREFIX + spec.program + STRIP_SUFFIX);
 *       const body = stripped.slice(35, stripped.length - 2);
 *
 *   所以本擦除器必须能吃 **module/script 级源码**（不能只吃"函数体片段"），
 *   并且在上述包壳用法下，擦除结果仍以 `STRIP_PREFIX` 开头、以 `STRIP_SUFFIX`
 *   结尾，切壳（`slice(35, -2)`）后仍是合法 JS。这两个常量因此一并导出，
 *   避免调用方再手抄一份字面量。门禁用例 9 专门断言这一点。
 *
 *   导入语义对齐 Node 的 strip 模式（≈ `verbatimModuleSyntax`）：
 *   `onlyRemoveTypeImports: true` ⇒ 只删显式 `import type` / `export type` /
 *   内联 `type` 说明符，**保留**无法判定是否为纯类型的普通 import。
 *   这是有意的：本擦除器不做类型检查，无权替调用方猜哪个 import 是类型。
 *
 * ============================================================================
 */

/*
 * ---------------------------------------------------------------------------
 * vendor 清单（名称 / 版本 / 体积 / 摘要）。门禁会拿着这几个常量去核对
 * `lib/vendor/babel-standalone/babel.min.cjs` 的真实字节数与 sha256，
 * 保证"注释里写的"和"树里躺的"是同一个东西，也防止以后被误替换。
 * ---------------------------------------------------------------------------
 */
const VENDOR = Object.freeze({
  name: '@babel/standalone',
  version: '7.28.4',
  license: 'MIT',
  /** 相对本文件的 require 说明符 —— 用相对路径，不依赖核心树/宿主机的模块解析。 */
  specifier: './vendor/babel-standalone/babel.min.cjs',
  /** 上游 `babel.min.js` 原样改名（`.cjs` 是为了不受宿主 package.json 的 "type" 影响）。 */
  bytes: 3069546,
  sha256: '254d0fe4bd4a17bcceb0623a467de5f69e9938ee07de3bff9851dcb94adeb03d',
  /** npm 上游 dist.integrity（sha512），出处可复核。 */
  npmIntegrity: 'sha512-Qc1BNCfuJZBKs2SC5lqRmSYOw7Ka0X7urZQ7oVsGIax4eGDUIHX+CDg752N4jDxC2rbBh3li098ReGOtjT0x4g==',
});

/** 官方包壳前缀（35 字符）。导出以免调用方手抄。 */
const STRIP_PREFIX = 'async function __dsh_program__() {\n';
/** 官方包壳后缀（2 字符）。 */
const STRIP_SUFFIX = '\n}';

/** 默认文件名：只用于 Babel 的报错文案与 `.d.ts` 判定，不参与任何 IO。 */
const DEFAULT_FILENAME = 'dsh-ptc-program.ts';

/**
 * `@babel/plugin-transform-typescript` 的配置。逐项理由：
 *   - isTSX: false           —— 关闭 TSX 解析，`<T,>(x) => x` 才能按泛型箭头函数解析
 *                               （真 JSX 会报语法错误，这是**有意的**：见文件尾"已知边界"）。
 *   - allowDeclareFields: true —— 允许类里 `declare x: number;`（否则 Babel 直接报错）。
 *   - onlyRemoveTypeImports: true —— 见文件头"导入语义对齐口径"。
 *   - allowNamespaces: true  —— 让 Babel **正确编译**带运行时语义的 namespace
 *                               （`namespace N { export const x = 1 }` → IIFE 赋值），
 *                               而不是像 sucrase 那样静默丢掉。
 * 注意这里**故意不启用** decorators 语法插件：见"已知边界"。
 */
const BABEL_PLUGINS = [
  [
    'transform-typescript',
    {
      isTSX: false,
      allowDeclareFields: true,
      onlyRemoveTypeImports: true,
      allowNamespaces: true,
    },
  ],
];

/**
 * 擦除失败。`name === 'TypeStripError'`，且一定带 **1-based** 的 `line` / `column`，
 * 定位基准是**调用方传进来的那段 source 本身**（不做任何偏移）。
 *
 * 额外字段（都不参与契约，只是方便调用方/模型排障）：
 *   - `reason`        人类可读的失败原因（已剥掉文件名与位置尾巴）
 *   - `frame`         Babel 生成的代码帧（`> 1 | const = ;` / `|  ^`），可能为 ''
 *   - `detail`        上游原始 message（含 Babel 的完整提示）
 *   - `locationExact` 位置是否精确。只有连锚点都扫不到时才是 false
 *   - `cause`         原始异常
 */
class TypeStripError extends Error {
  constructor(reason, line, column, extra) {
    const e = extra || {};
    const exact = e.locationExact !== false;
    const where = exact ? `at ${line}:${column}` : `at ${line}:${column} (位置为兜底值)`;
    super(`${reason} (${where})${e.frame ? `\n\n${e.frame}` : ''}`);
    this.name = 'TypeStripError';
    this.line = line;
    this.column = column;
    this.reason = reason;
    this.frame = e.frame || '';
    this.detail = e.detail || '';
    this.locationExact = exact;
    if (e.cause !== undefined) this.cause = e.cause;
    // 让 V8 的栈从抛出错的那一行开始，而不是从构造函数开始。
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, TypeStripError);
    }
  }
}

/*
 * 懒加载：`babel.min.cjs` 有 2.93 MiB，解析它（实测 --jitless 下约 130 ms）
 * 不该由"只是 require 了本模块"来买单。第一次真正擦除时才载入并缓存。
 */
let babelApi = null;

function loadBabel() {
  if (babelApi === null) {
    // eslint-disable-next-line global-require
    babelApi = require(VENDOR.specifier);
  }
  return babelApi;
}

/** 构造一次擦除的 Babel 配置。抽出来是为了让选项集中可读、也便于门禁对照。 */
function transformOptionsFor(filename, retainLines) {
  return {
    filename,
    // 'unambiguous'：有 import/export 就按 module 解析，否则按 script 解析。
    // 比强制 'module' 宽容（不因严格模式/八进制字面量等产生假报错），
    // 又比强制 'script' 能接受 module 语法。
    sourceType: 'unambiguous',
    plugins: BABEL_PLUGINS,
    compact: false,
    comments: true,
    // 默认 false —— 这是**实测出来的硬要求，不是口味问题**。
    // 官方用法靠 `stripped.slice(35, stripped.length - 2)` 切壳，隐含两个不变量：
    //   (a) 输出必须以 STRIP_PREFIX 逐字开头；(b) 必须以 STRIP_SUFFIX 结尾。
    // 而 `retainLines: true` 会为了对齐行号把语句粘到上一行。实测（壳内含 enum）：
    //     async function __dsh_program__() {let        ← 前缀后面直接接了 `let`，没有换行
    //     …
    //   此时 startsWith(STRIP_PREFIX) === false，官方 slice(35,-2) 会切进 `let` 中间，
    //   切出 `et\n\n  E = …` ⇒ 运行时 `ReferenceError: et is not defined`
    //   —— 一个**静默**的、只在特定输入下出现的灾难性损坏。
    // 因此 retainLines 只作为显式 opt-in（模块级擦除、且不做 slice 切壳时才有意义），
    // 默认必须关闭。门禁的"回归"分组把这个证据固化在案。
    retainLines: retainLines === true,
    sourceMaps: false,
    // 关掉代码帧的 ANSI 着色：错误文案要进日志/进模型上下文，纯文本更稳。
    highlightCode: false,
    // 明确不做配置文件发现（端侧没有 .babelrc，也不想让它去找）。
    babelrc: false,
    configFile: false,
  };
}

/**
 * 把 Babel 抛出来的东西统一成 TypeStripError（带 1-based line/column）。
 *
 * 位置来源按可靠性依次尝试：
 *   ① `err.loc`（Babel 解析错误的正规通道；line 1-based、column 0-based → +1）
 *   ② 首行消息尾巴里的 `(行:列)`（Babel 部分错误只把位置写进文案）
 *   ③ 锚点扫描（**仅**用于 Babel 连 loc 都不给的两种非擦除语法：
 *      `import x = require(...)` 与 `export = ...`；见 ANCHOR_PATTERNS）
 *   ④ 兜底 1:1，并把 locationExact 标成 false —— 宁可自曝"位置不可靠"，
 *      也不要伪造一个精确位置。
 */
function toTypeStripError(err, source, filename) {
  if (err instanceof TypeStripError) return err;

  const raw = err && typeof err.message === 'string' ? err.message : String(err);
  const firstLineRaw = raw.split('\n', 1)[0];
  const frame = extractCodeFrame(raw);

  let reason = stripFilenamePrefix(firstLineRaw, filename)
    .replace(/\s*\(\d+:\d+\)\s*:?\s*$/, '')
    .replace(/:\s*$/, '')
    .trim();
  if (!reason) reason = 'TypeScript 擦除失败';

  const loc = err && err.loc;
  if (loc && Number.isInteger(loc.line) && loc.line >= 1 && Number.isInteger(loc.column) && loc.column >= 0) {
    return new TypeStripError(reason, loc.line, loc.column + 1, { frame, detail: raw, cause: err });
  }

  const inMessage = /\((\d+):(\d+)\)\s*:?\s*$/.exec(firstLineRaw);
  if (inMessage) {
    return new TypeStripError(reason, Number(inMessage[1]), Number(inMessage[2]), {
      frame,
      detail: raw,
      cause: err,
    });
  }

  const anchored = anchorLocate(source);
  if (anchored) {
    return new TypeStripError(reason, anchored.line, anchored.column, {
      frame,
      detail: raw,
      cause: err,
    });
  }

  return new TypeStripError(reason, 1, 1, { frame, detail: raw, cause: err, locationExact: false });
}

/** 剥掉 Babel 加在消息前面的 `<filename>: ` 前缀（只认我们传进去的那个名字）。 */
function stripFilenamePrefix(line, filename) {
  const escaped = String(filename).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return line.replace(new RegExp(`^/?${escaped}:\\s*`), '');
}

/**
 * 从 Babel 的原始 message 里抠出代码帧。
 * Babel 的 message 形如：
 *     /x.ts: Unexpected token (1:6)\n\n> 1 | const = ;\n    |       ^
 * 或（带建议时）帧后面还跟一段 "\n\nAdd @babel/plugin-..." 的废话，一并切掉。
 */
function extractCodeFrame(raw) {
  const at = raw.indexOf('\n> ');
  if (at === -1) return raw.startsWith('> ') ? raw.split('\n\n')[0] : '';
  return raw.slice(at + 1).split('\n\n')[0];
}

/**
 * 当 Babel 不提供 loc 时的最后手段：按已知的非擦除语法锚点扫一遍源码。
 * 目前只可能命中这两种（其余错误都会带 loc），见 toTypeStripError ① ②。
 */
const ANCHOR_PATTERNS = [
  /\bimport\s+[A-Za-z_$][\w$]*\s*=\s*require\s*\(/, // TS 的 import-=-require
  /\bexport\s*=/, // TS 的 export =
];

function anchorLocate(source) {
  const lines = String(source).split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const re of ANCHOR_PATTERNS) {
      const m = re.exec(lines[i]);
      if (m) return { line: i + 1, column: m.index + 1 };
    }
  }
  return null;
}

function typeNameOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * 擦除 erasable TypeScript 类型标注，返回 JS 源码字符串。
 *
 * @param {string} source 要擦除的源码。可以是 module/script 级源码，
 *                        也可以是官方那种 `async function …{\n<body>\n}` 包壳后的整段。
 * @param {{filename?: string, retainLines?: boolean}} [options]
 *        `filename` 只影响报错文案；`retainLines` 见 transformOptionsFor。
 * @returns {string}
 * @throws {TypeStripError} 语法错误，或输入含**不可擦除**的 TS 语法时
 *                          （`import x = require()`、`export =`、装饰器）；
 *                          一定带 1-based `line` / `column`。
 * @throws {TypeError} 入参不是字符串（API 误用，不算"擦除失败"，故不伪装成
 *                     TypeStripError —— 否则调用方无法区分"代码有问题"和
 *                     "调用方式有问题"）。
 */
function stripErasableTs(source, options) {
  if (typeof source !== 'string') {
    throw new TypeError(
      `stripErasableTs(source): source 必须是 string，收到 ${typeNameOf(source)}`
    );
  }

  const opts = options || {};
  const filename =
    typeof opts.filename === 'string' && opts.filename.length > 0 ? opts.filename : DEFAULT_FILENAME;

  const api = loadBabel();

  let result;
  try {
    result = api.transform(source, transformOptionsFor(filename, opts.retainLines));
  } catch (err) {
    throw toTypeStripError(err, source, filename);
  }

  const code = result && result.code;
  if (typeof code !== 'string') {
    // 理论上到不了这里；留着是为了"宁可报错也不返回 undefined"。
    throw new TypeStripError('擦除器没有产出源码字符串', 1, 1, {
      detail: `transform() 返回的 code 类型是 ${typeNameOf(code)}`,
      locationExact: false,
    });
  }
  return code;
}

module.exports = {
  stripErasableTs,
  TypeStripError,
  // 以下为便利导出，不属于任务要求的最小接口。
  STRIP_PREFIX,
  STRIP_SUFFIX,
  VENDOR,
  DEFAULT_FILENAME,
};

/* ============================================================================
 * 已知边界（都是**实测**结论，不是推测）
 * ----------------------------------------------------------------------------
 * 1) 装饰器 ⇒ 抛可定位的 TypeStripError，而不是转换。
 *    我们**故意不启用** Babel 的 decorators 语法插件。启用后 Babel 会把
 *    `@dec class A {}` 原样透传，而端侧 Node 解析不了装饰器 ⇒ 产出的"JS"其实
 *    不是合法 JS，等于静默产出坏代码。现在报
 *    `Support for the experimental syntax 'decorators' isn't currently enabled (at 1:1)`
 *    并附代码帧，模型能直接看到问题在哪。成员装饰器同理（`class B { @dec m() {} }`
 *    → 1:11）。
 *    —— 与官方 `stripTypeScriptTypes` 的口径一致：装饰器不是可擦除语法。
 *
 * 2) 参数属性 `constructor(private x: number) {}` ⇒ **转换**（不是报错）。
 *    Babel 产出 `constructor(x) { this.x = x; }`，语义正确，门禁用例 11.1 会真的求值
 *    断言 `new B(5).get() === 5`。这是用例 11 允许的"正确编译"分支。
 *
 * 3) enum / const enum / 带运行时语义的 namespace ⇒ **转换**（不是报错）。
 *    `enum E { A, B }` → `var E = (function (E) {…})(E || {})`；
 *    `namespace N { export const x = 1 }` → `let N; (function (_N) {…})(N || (N = {}))`。
 *    注意这正是选中 Babel 而淘汰 sucrase 的原因（sucrase 静默输出空串）。
 *    `declare enum` / `declare namespace` 属环境声明，被擦成空。
 *
 * 4) 不可擦除的 TS 模块语法 ⇒ 抛可定位错误（与官方一致）：
 *    `import x = require("y")` 与 `export = z`。这两条 Babel 只在"编译到 CJS"时支持，
 *    而我们只做类型擦除、不做模块转换。它们还有个特点：Babel 不提供 `err.loc`，
 *    所以本模块用锚点扫描兜底定位（实测：`import x = require("y"); x();` → 1:1；
 *    `declare const z: number; export = z;` → 1:26，与 Babel 代码帧的 `^` 位置一致）。
 *    若将来 Babel 抛出**别种**不给 loc 的错误，会退化成 1:1 并把
 *    `error.locationExact` 标为 false（宁可自曝不可靠，也不伪造精确位置）。
 *
 * 5) JSX / TSX **不支持**（`isTSX: false`）。这是刻意的：打开 TSX 解析后
 *    `<T,>(x: T) => x` 这种泛型箭头函数会被当成 JSX 而解析失败，而 run_code
 *    场景里泛型箭头函数比 JSX 常见得多。`<div>hi</div>` 会报
 *    `Unterminated regular expression`（并带行列）。
 *
 * 6) `accessor x = 1`（ES 装饰器自动访问器）⇒ 报错（缺 decoratorAutoAccessors 语法插件）。
 *    与 (1) 同源：不启用装饰器相关语法，宁可报错也不透传端侧解析不了的语法。
 *
 * 7) 输出是**重新排版**过的 JS，不是"原始字节 + 挖空类型"。因此**行列号不与输入对齐**
 *    （官方 `stripTypeScriptTypes` 是把类型文本替换成等长空格，行列完全保真）。
 *    这是本方案唯一的实质性行为差异：
 *      · 好处：输出是可读的规范 JS；无类型可擦的源码**逐字节原样返回**（用例 7.F 断言）。
 *      · 代价：运行时栈里的行列号偏移。`{ retainLines: true }` 只能救回"行"，
 *        且如上所述会破坏包壳不变量，故默认关闭（见 transformOptionsFor 注释）。
 *    如果调用方更看重栈帧行号而非可读性，需要的是"按 AST 区间删字节"的另一种实现
 *    （如 ts-blank-space 的思路），而不是本 vendor —— 那是另一件事，不在本次范围内。
 *
 * 8) 【与宿主插件的跨边界契约】**包壳里"一条运行时语句都没有"时，输出会被折叠成
 *    `async function __dsh_program__() {}`**（首尾壳都不再逐字保留，因为花括号之间空了）。
 *    这**不是**可以随便改的行为：宿主 `lib/index.js:464` 用
 *    `/^async function __dsh_program__\(\)\s*\{\s*\}$/` 特判这个形状并返回空体，
 *    否则会落进它"壳被改写"的守卫、把"模型写了个空程序"误报成内部故障。
 *    实测会折叠的输入：空串 / 纯空白 / 纯换行 / 只有 `interface` / 只有 `type` /
 *    只有 `declare`。**不会**折叠的：只有注释、只有 `;`（这些仍保留首尾壳，走正常切壳）。
 *    门禁 XB.1 / XB.2 就是钉住这条契约的。
 *
 * 9) 包壳内的**顶层 `import`/`export` 会抛可定位错误**（`'import' and 'export' may only
 *    appear at the top level`）。这不是本实现的缺陷：官方也是把 program 包进
 *    `async function` 再擦除，函数体内同样不能有 `import`。所以 run_code 的 program
 *    只能使用宿主注入的 binding，不能自己 import。门禁 XB.3 钉住"报得出来"这一点。
 *
 * 10) 真机（HarmonyOS 端侧）**已验收**（2026-10-05）：`check-ptc-runtime-inproc.mjs` 的
 *    166 条断言整体跑在 `--jitless` 下，端侧实测 PTC 全链路恢复（32 个 binding 暴露、
 *    30 个实测可用、TS 擦除与 vm 沙箱成立、6000ms 精确超时）；vendor bundle 与端侧树里
 *    那份**逐字节一致**（自证行的 sha256 前 16 位 `254d0fe4…` 在两侧相同）。
 *    仍未单独测的：端侧 V8 在 jitless 下解析 2.93 MiB 单文件的耗时（首帧延迟），
 *    以及端侧内存峰值。
 * ========================================================================== */

