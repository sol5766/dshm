#!/usr/bin/env node
/**
 * 门禁：DSHM 端侧的**同进程 PTC 运行时**（`@deepseek-ai/dshm-ptc-runtime-inproc`）必须
 * 在 `--jitless`（= 端侧形态：没有 WASM）下真的把 `run_code` 那套契约跑通。
 *
 * ---------------------------------------------------------------------------
 * 为什么要有这个门禁
 * ---------------------------------------------------------------------------
 * 真机缺陷（2026-10-05）：PTC 模式的 `run_code` 必报
 *   `code run failed (exception): WebAssembly is not defined`
 * 根因是官方 `@deepseek-ai/dsh-ptc-runtime-node` 的两条结构性死路：类型擦除用 SWC 的
 * WASM 版实现；求值又要新建 Node 执行体（端侧起不了）。本插件把那两件事换成纯 JS
 * 擦除器 + `node:vm` 同进程求值。**这个修复的全部价值都在"jitless 下能跑"上**，所以
 * 门禁必须整体跑在 `--jitless` 里，而不是"在有 WASM 的开发机上看着像能跑"。
 *
 * ---------------------------------------------------------------------------
 * 它怎么跑（三步）
 * ---------------------------------------------------------------------------
 * ① **外层**（本文件被普通 `node` 调用时）：把插件目录**原样拷**进一个临时舞台，并在
 *    舞台里造一份最小 `node_modules/@deepseek-ai/`（用 junction/符号链接指向核心树里的
 *    `@deepseek-ai/cordis`、`dsh-ptc-runtime`、`dsh-timeout`、`dsh-util-values`、
 *    `schemastery`）。这样自带插件在舞台里的**相对位置**与它在核心树里的真实位置一致
 *    （`node_modules/@deepseek-ai/dshm-ptc-runtime-inproc`），于是它的
 *    `import "@deepseek-ai/…"` 走的是**生产同一条解析路径**，而不是门禁自己搭的替身。
 *    舞台放在系统临时目录，跑完即删（不在仓库里留 `node_modules/`）。
 * ② 外层起 `node --jitless <舞台>/check-ptc-runtime-inproc.mjs --inner`，
 *    `stdio: 'inherit'`（不抓管道：抓管道在受限沙箱下是 EPERM，inherit 才是任何沙箱下
 *    都成立的形态），退出码即结论。
 * ③ **内层**（`--inner`）在 `--jitless` 下做全部断言：静态断言 + 行为断言 + TS 用例 +
 *    "读 WASM 即抛"的陷阱 getter 臂。
 *
 * ---------------------------------------------------------------------------
 * 关于静态断言：为什么分三条规则
 * ---------------------------------------------------------------------------
 * 要禁的标识符（不许出现在**执行路径**上）：
 *   `child_process` / `spawn(` / `execFile` / `fork(` / `process.execPath` /
 *   `worker_threads` / `WebAssembly`
 * 这条插件目录里躺着两个**别人的**东西：并行交付的纯 JS 擦除器 `lib/ts-strip.cjs`
 * （它在**注释**里解释自己为什么不碰那个全局）与它 vendor 的
 * `@babel/standalone`（2.93 MiB，里面有一份"浏览器全局名清单"和两份 core-js `web.*`
 * 模块描述表，`WebAssembly` 在那里是**数据**，不是执行路径）。逐字 grep 整个目录会把
 * "注释"和"数据"一起判死，于是本门禁分三条规则，各自说清管什么：
 *   · 规则 A（**逐字**，连注释都算）：本插件**自己写**的运行时代码
 *     （`lib/index.js`、`lib/vm-run.js`）与 `package.json`。
 *   · 规则 B（**代码位**，剥掉注释与字符串字面量后）：全部一方源码
 *     （`lib/*.js`、`lib/*.cjs`、`package.json`）。
 *   · 规则 C（vendor）：第三方 `lib/vendor/**` 只钉两条硬事实 —— 没有 `.wasm` 二进制、
 *     没有动态 wasm 加载；外加把**已审计产物用 sha256 钉死**（核对擦除器自己导出的
 *     `VENDOR` 清单：字节数与 sha256 必须与树里躺的文件一致）与代码位出现次数（3 处）。
 * 另外还有一条**运行时**证据（比 grep 强）：把 `WebAssembly` 定义成"读一下就抛"的
 * trap getter，再跑一遍纯 JS 与 TS 程序 —— 运行路径里任何一处读它，套件当场红。
 *
 * 【该标识符在规则 A/B 里的**钉死例外**】真机验收项 D 要求挂载期自证日志**实测**报出
 * `typeof WebAssembly`（端侧应为 `undefined`）—— 这是"活进程真的处于 jitless 形态"的
 * 唯一现场证据。所以规则 A/B 对该标识符不是"一律 0 次"而是"**恰好 1 次且必须是 `typeof`
 * 诊断读**"：`lib/index.js` 1 次，`lib/vm-run.js` / `package.json` 0 次，`lib/ts-strip.cjs`
 * 代码位 0 次。多一处、或挪到别的文件、或写成取值（`new …` / 传参）都立刻红。
 *
 * ---------------------------------------------------------------------------
 * 启动期预算（真机要求：挂载必须零成本）
 * ---------------------------------------------------------------------------
 * "只挂载、不运行"不许付出擦除器的 require 与 vendor bundle（2.93 MiB）的解析成本 ——
 * 否则 HMR/激活会阻塞启动。本门禁在**挂载前**与**挂载后**各查一次 CJS 模块缓存
 * （`require.cache` 里不许有 `ts-strip.cjs` / `babel.min.cjs`）、并卡一个挂载耗时阈值；
 * 随后**正控**：第一次真正 run 之后这两者必须出现在缓存里 —— 否则说明探针本身没判别力。
 *
 * ---------------------------------------------------------------------------
 * 用法与退出码
 * ---------------------------------------------------------------------------
 *   node tools/check-ptc-runtime-inproc.mjs
 *   node tools/check-ptc-runtime-inproc.mjs --verbose   （打印每条断言的细节）
 * 退出码：0 通过 / 1 失败 / 3 环境不具备（核心树或并行交付的擦除器未就位）。
 * 说明：全部断言都跑在 `--inner` 那个 jitless 子进程里（外层只搭舞台、起进程、按退出码
 * 收结论），所以 `--verbose` 会自动透传给内层。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "..");
/** 本地 require（审计擦除器模块用；与生产代码同一条 CJS 路径）。 */
const requireLocal = createRequire(import.meta.url);
/** 插件的**源码**目录（仓库里这一份，是唯一真源）。 */
const PLUGIN_SOURCE = join(ROOT, "hostcore", "plugins", "dshm-ptc-runtime-inproc");
const PLUGIN_NAME = "@deepseek-ai/dshm-ptc-runtime-inproc";
const PLUGIN_DIR_NAME = "dshm-ptc-runtime-inproc";
const INNER_FLAG = "--inner";
/** 舞台里要能解析到的核心树包（自带插件真正 import 的那几个）。 */
const CORE_PACKAGES = ["cordis", "dsh-ptc-runtime", "dsh-timeout", "dsh-util-values", "schemastery"];
/** 禁止出现在执行路径上的标识符（任务指定的 7 条）。 */
const FORBIDDEN = ["child_process", "spawn(", "execFile", "fork(", "process.execPath", "worker_threads", "WebAssembly"];
/** 被钉死例外的那个标识符（挂载期自证日志要**实测**读它，见文件头）。 */
const WASM_TOKEN = "WebAssembly";
/** 其中"一律 0 次"的 6 条；`WebAssembly` 单独按"钉死例外"处理（见文件头与下面）。 */
const FORBIDDEN_STRICT = FORBIDDEN.filter((token) => token !== WASM_TOKEN);
/** `lib/index.js` 里该标识符允许的**逐字**出现次数（唯一一处 `typeof` 诊断读）。 */
const SELF_REPORT_WASM_READS = 1;
/** 挂载（构造 + 自证日志）耗时阈值；真实读数在毫秒级，阈值只用来抓"挂载期干了重活"。 */
const MOUNT_BUDGET_MS = 250;

/** 统计一个字符串里某个子串的出现次数。 */
function countOf(text, token) {
  return text.split(token).length - 1;
}
/** vendor 里 `WebAssembly` 的**已核对**出现次数（三处 core-js 数据表；见文件头规则 C）。 */
const VENDOR_WASM_TOKEN_COUNT = 3;

/* ───────────────────────── 外层：舞台 + jitless 子进程 ───────────────────────── */

/** 找核心树：`dist/core/work/dsh-core-*` 里含 `@deepseek-ai/dsh-ptc-runtime` 的最新一个。 */
function findCoreTree() {
  const work = join(ROOT, "dist", "core", "work");
  if (!existsSync(work)) return undefined;
  const candidates = readdirSync(work)
    .filter((entry) => entry.startsWith("dsh-core-"))
    .sort()
    .reverse();
  for (const entry of candidates) {
    const scope = join(work, entry, "node_modules", "@deepseek-ai");
    if (!existsSync(join(scope, "dsh-ptc-runtime")) || !existsSync(join(scope, "cordis"))) continue;
    return scope;
  }
  return undefined;
}

/**
 * 造舞台：`<stage>/node_modules/@deepseek-ai/<包>`（junction 指向核心树）+ 插件副本 +
 * 本门禁自己的副本（内层要从舞台里跑，才能按生产路径解析裸说明符）。
 * @param scope - 核心树的 `@deepseek-ai` 目录。
 * @returns 舞台根目录。
 */
function buildStage(scope) {
  const stage = mkdtempSync(join(tmpdir(), "dshm-ptc-inproc-"));
  const stageScope = join(stage, "node_modules", "@deepseek-ai");
  mkdirSync(stageScope, { recursive: true });
  for (const name of CORE_PACKAGES) {
    const target = join(scope, name);
    if (!existsSync(target)) throw new Error(`核心树里缺 @deepseek-ai/${name}（${target}）`);
    symlinkSync(target, join(stageScope, name), process.platform === "win32" ? "junction" : "dir");
  }
  cpSync(PLUGIN_SOURCE, join(stageScope, PLUGIN_DIR_NAME), { recursive: true });
  const innerPath = join(stage, "check-ptc-runtime-inproc.mjs");
  cpSync(SELF, innerPath);
  return stage;
}

/** 外层：搭舞台、起 jitless 子进程、按退出码收结论。 */
async function outerMain() {
  if (!existsSync(join(PLUGIN_SOURCE, "lib", "index.js"))) {
    console.log(`SKIP：插件源码不存在（${PLUGIN_SOURCE}）`);
    process.exit(3);
  }
  const scope = findCoreTree();
  if (scope === undefined) {
    console.log("SKIP：核心树未就位（dist/core/work/dsh-core-*/node_modules/@deepseek-ai 里没有 dsh-ptc-runtime）");
    process.exit(3);
  }
  const stage = buildStage(scope);
  console.log(`[ptc-inproc] 插件源码：${PLUGIN_SOURCE}`);
  console.log(`[ptc-inproc] 核心树：${scope}`);
  console.log(`[ptc-inproc] 舞台：${stage}（跑完即删）`);
  console.log(`[ptc-inproc] 起 jitless 子进程：node --jitless <舞台>/check-ptc-runtime-inproc.mjs ${INNER_FLAG}\n`);

  let status = 1;
  try {
    const child = spawn(process.execPath, ["--jitless", join(stage, "check-ptc-runtime-inproc.mjs"), INNER_FLAG, ...process.argv.slice(2)], {
      cwd: stage,
      // inherit：不抓管道（受限沙箱下 Node 的 piped stdio 是 EPERM），退出码即结论。
      stdio: "inherit"
    });
    status = await new Promise((done) => {
      child.once("close", (code) => done(code === null ? 1 : code));
      child.once("error", (error) => {
        console.log(`[ptc-inproc] 子进程起不来：${error.message}`);
        done(1);
      });
    });
  } finally {
    // 无论子进程怎么结束（含异常）都清掉舞台：仓库/临时目录里不留 node_modules 与副本。
    rmSync(stage, { recursive: true, force: true });
  }
  console.log(`\n[ptc-inproc] 子进程退出码 = ${status}`);
  if (status === 0) console.log("PASS：jitless 下同进程 PTC 运行时全项通过。");
  else if (status === 3) console.log("SKIP：内层判定环境不具备（见上面读数）。");
  else console.log("FAIL：见上面的 FAIL 行。");
  process.exit(status);
}

/* ───────────────────────── 内层：断言套件 ───────────────────────── */

/** 极简断言器：逐条打印，最后汇总。 */
class Suite {
  constructor(verbose) {
    this.verbose = verbose;
    this.passed = 0;
    this.failed = 0;
    this.skipped = 0;
    this.failures = [];
  }
  ok(name, detail) {
    this.passed += 1;
    if (this.verbose) console.log(`  ok   ${name}${detail === undefined ? "" : `  （${detail}）`}`);
  }
  fail(name, detail) {
    this.failed += 1;
    this.failures.push(`${name}：${detail}`);
    console.log(`  FAIL ${name}\n       ${detail}`);
  }
  check(name, condition, detail) {
    if (condition) this.ok(name, detail);
    else this.fail(name, detail === undefined ? "断言为假" : detail);
    return condition;
  }
  /** 值相等（JSON 比较，便于报出实际值）。 */
  eq(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    return this.check(name, a === e, `期望 ${e}，实际 ${a}`);
  }
  /** 期望抛错且消息匹配。 */
  throws(name, fn, pattern) {
    try {
      fn();
    } catch (error) {
      const message = error === null || typeof error !== "object" ? String(error) : String(error.message);
      if (pattern === undefined) return this.ok(name, message.slice(0, 120));
      return this.check(name, pattern.test(message), `消息：${message.slice(0, 200)}`);
    }
    return this.fail(name, "期望抛错，但没有抛");
  }
  /** 期望一个 thunk 同步抛错或以匹配的消息 reject（`async` 方法的误用只能这样断言）。 */
  async rejects(name, thunk, pattern) {
    try {
      await thunk();
    } catch (error) {
      const message = error === null || typeof error !== "object" ? String(error) : String(error.message);
      if (pattern === undefined) return this.ok(name, message.slice(0, 120));
      return this.check(name, pattern.test(message), `消息：${message.slice(0, 200)}`);
    }
    return this.fail(name, "期望拒绝，但没有");
  }
  skip(name, why) {
    this.skipped += 1;
    console.log(`  SKIP ${name}（${why}）`);
  }
  summary() {
    console.log(`\n[ptc-inproc] 断言：${this.passed} 通过 / ${this.failed} 失败 / ${this.skipped} 跳过`);
    if (this.failed > 0) {
      console.log("[ptc-inproc] 失败清单：");
      for (const line of this.failures) console.log(`  · ${line}`);
    }
    return this.failed === 0;
  }
}

/**
 * 剥掉注释与字符串字面量，只留"代码位"（规则 B 用）。
 * 模板字面量保守处理：**整段**当字符串（含 `${}` 里的表达式）—— 这只可能漏掉
 * "藏在模板插值里的一次调用"，而本门禁的规则 A（对自写运行时代码逐字 grep）与 trap
 * getter 臂已经覆盖了那条缝。
 * @param source - 源码文本。
 * @returns 代码位文本（长度不保证一致，只用于匹配）。
 */
function codeOnly(source) {
  let out = "";
  let index = 0;
  const length = source.length;
  while (index < length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      while (index < length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      while (index < length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      out += " ";
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** 列出一个目录下的全部普通文件（相对路径）。 */
function listFiles(base) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else found.push(full);
    }
  };
  walk(base);
  return found;
}

/** 规则 A/B（自写源码 + 代码位）+ 规则 A/B 里那条钉死的自证日志例外。 */
function staticAssertions(suite, pluginDir) {
  const runtimeFiles = ["lib/index.js", "lib/vm-run.js"];
  for (const rel of runtimeFiles) {
    const text = readFileSync(join(pluginDir, rel), "utf8");
    for (const token of FORBIDDEN_STRICT) {
      suite.check(`A 规则（逐字）不出现 ${JSON.stringify(token)}：${rel}`, !text.includes(token));
    }
  }
  const packageText = readFileSync(join(pluginDir, "package.json"), "utf8");
  for (const token of FORBIDDEN_STRICT) {
    suite.check(`A 规则（逐字）不出现 ${JSON.stringify(token)}：package.json`, !packageText.includes(token));
  }

  const firstParty = listFiles(join(pluginDir, "lib")).filter((file) => !file.includes(`${sep}vendor${sep}`));
  const codeByFile = new Map();
  for (const file of firstParty) {
    const rel = file.slice(pluginDir.length + 1);
    const code = codeOnly(readFileSync(file, "utf8"));
    codeByFile.set(rel, code);
    for (const token of FORBIDDEN_STRICT) {
      suite.check(`B 规则（代码位）不出现 ${JSON.stringify(token)}：${rel}`, !code.includes(token));
    }
  }

  // 钉死例外（真机验收项 D 的自证日志要**实测**读该全局）：
  //   ① `lib/index.js` 里**可执行**引用恰好 1 处，且必须是 `typeof WebAssembly`；
  //   ② 逐字出现次数 == `typeof WebAssembly` 出现次数 ⇒ 不存在"裸取值/传参"式的使用；
  //   ③ 其余文件 0 次（擦除器只许注释里提及，按代码位判）。
  const indexRaw = readFileSync(join(pluginDir, "lib", "index.js"), "utf8");
  const indexCode = codeByFile.get(`lib${sep}index.js`) ?? "";
  const rawCount = countOf(indexRaw, WASM_TOKEN);
  const codeCount = countOf(indexCode, WASM_TOKEN);
  const typeofReads = (indexRaw.match(new RegExp(`\\btypeof ${WASM_TOKEN}\\b`, "g")) ?? []).length;
  suite.check(
    `A 规则例外（钉死）：lib/index.js 里该标识符的**可执行**引用恰好 ${SELF_REPORT_WASM_READS} 处`,
    codeCount === SELF_REPORT_WASM_READS,
    `代码位 ${codeCount} 处（多一处即红：那意味着执行路径又碰了 WASM）`
  );
  suite.check(
    `A 规则例外（钉死）：那一处就是 \`typeof ${WASM_TOKEN}\` 诊断读（自证日志用）`,
    countOf(indexCode, `typeof ${WASM_TOKEN}`) === SELF_REPORT_WASM_READS,
    `代码位里的 typeof 读 ${countOf(indexCode, `typeof ${WASM_TOKEN}`)} 处`
  );
  suite.check(
    `A 规则例外（钉死）：逐字出现次数 == typeof 读次数（${typeofReads}），即不存在裸取值/传参式的使用`,
    rawCount === typeofReads,
    `逐字 ${rawCount} 处 / typeof 读 ${typeofReads} 处`
  );
  for (const rel of ["lib/vm-run.js"]) {
    suite.check(`A 规则（逐字）不出现该标识符：${rel}（自证日志只在 index.js）`, countOf(readFileSync(join(pluginDir, rel), "utf8"), WASM_TOKEN) === 0);
  }
  suite.check(
    `B 规则（代码位）不出现该标识符：lib/ts-strip.cjs（擦除器只许有注释提及）`,
    countOf(codeByFile.get(`lib${sep}ts-strip.cjs`) ?? "", WASM_TOKEN) === 0
  );
}

/** 规则 C：第三方 vendor 的硬事实（二进制/动态加载/已审计产物摘要/代码位计数）。 */
function vendorAssertions(suite, pluginDir) {
  const vendorDir = join(pluginDir, "lib", "vendor");
  if (!existsSync(vendorDir)) {
    suite.skip("C 规则（vendor）", "没有 lib/vendor 目录");
    return;
  }
  const vendorFiles = listFiles(vendorDir);
  suite.check("C 规则：vendor 里没有 .wasm 二进制", !vendorFiles.some((file) => file.endsWith(".wasm")), vendorFiles.filter((f) => f.endsWith(".wasm")).join(", "));
  let dynamicLoad = 0;
  for (const file of vendorFiles) {
    const text = readFileSync(file, "utf8");
    dynamicLoad += (text.match(/(?:require|import)\s*\(\s*["'`][^"'`]*\.wasm["'`]/g) ?? []).length;
  }
  suite.check("C 规则：vendor 里没有动态 wasm 加载", dynamicLoad === 0, `命中 ${dynamicLoad} 处`);

  const stripper = requireStripperForAudit(pluginDir);
  if (stripper === undefined) {
    suite.skip("C 规则：vendor 摘要核对", "lib/ts-strip.cjs 未就位（并行交付）");
  } else if (stripper.VENDOR === undefined || typeof stripper.VENDOR.specifier !== "string") {
    suite.fail("C 规则：vendor 摘要核对", "擦除器没有导出 VENDOR 清单");
  } else {
    const libDir = join(pluginDir, "lib");
    const vendorFile = resolve(libDir, stripper.VENDOR.specifier);
    if (!existsSync(vendorFile)) {
      suite.fail("C 规则：vendor 摘要核对", `VENDOR.specifier 指向的文件不存在：${vendorFile}`);
    } else {
      const text = readFileSync(vendorFile, "utf8");
      const digest = createHash("sha256").update(text, "utf8").digest("hex");
      suite.eq(`C 规则：vendor 字节数 == 擦除器声明（${stripper.VENDOR.name}@${stripper.VENDOR.version}）`, Buffer.byteLength(text, "utf8"), stripper.VENDOR.bytes);
      suite.eq("C 规则：vendor sha256 == 擦除器声明（已审计产物被钉死，换 vendor 必然红）", digest, stripper.VENDOR.sha256);
      // C4：**代码文件**里的标识符出现次数钉死（已核对：三处 core-js 数据表）。
      // 文档（.md/LICENSE）里出现该词属于说明文字，单独计数、只做记录。
      let codeTokens = 0;
      let docTokens = 0;
      for (const file of vendorFiles) {
        const occurrences = countOf(readFileSync(file, "utf8"), WASM_TOKEN);
        if (/\.(?:js|cjs|mjs|json)$/.test(file)) codeTokens += occurrences;
        else docTokens += occurrences;
      }
      suite.check(`C 规则：vendor **代码文件**里的 ${WASM_TOKEN} 出现次数恰为 ${VENDOR_WASM_TOKEN_COUNT}（换 vendor 必须重新审计并更新本常量）`, codeTokens === VENDOR_WASM_TOKEN_COUNT, `实际 ${codeTokens} 处`);
      console.log(`  note vendor 文档里的 ${WASM_TOKEN} 提及：${docTokens} 处（说明文字，不计入断言）`);
    }
  }
}

/** 自证日志里声明的 vendor 路径必须与擦除器自己的 `VENDOR.specifier` 指同一处。 */
function vendorPathAgreement(suite, pluginDir, selfReportText) {
  const stripper = requireStripperForAudit(pluginDir);
  if (stripper === undefined || stripper.VENDOR === undefined) {
    suite.skip("C 规则：自证日志的 vendor 路径与擦除器声明一致", "擦除器 VENDOR 不可读");
    return;
  }
  if (selfReportText === undefined) {
    suite.skip("C 规则：自证日志的 vendor 路径与擦除器声明一致", "没抓到自证日志");
    return;
  }
  const declared = resolve(join(pluginDir, "lib"), stripper.VENDOR.specifier);
  suite.check(
    "C 规则：自证日志里的擦除器 vendor 路径 == 擦除器自己声明的 VENDOR.specifier（两处路径不会悄悄漂移）",
    selfReportText.includes(declared),
    `日志里没有 ${declared}：${selfReportText.slice(0, 240)}`
  );
  suite.check(
    "C 规则：自证日志里的 vendor 字节数 == 擦除器声明的 bytes（statSync 读的就是那个文件）",
    selfReportText.includes(`${stripper.VENDOR.bytes}B`),
    `日志里没有 ${stripper.VENDOR.bytes}B：${selfReportText.slice(0, 240)}`
  );
}

/** 为审计读取擦除器模块（CJS；用 createRequire 而不是 import，保持"生产同一路径"）。 */
function requireStripperForAudit(pluginDir) {
  const entry = join(pluginDir, "lib", "ts-strip.cjs");
  if (!existsSync(entry)) return undefined;
  try {
    return requireLocal(entry);
  } catch {
    return undefined;
  }
}

/** 造一个 null 原型的宿主 binding 命名空间（`__proto__`/`constructor` 当普通键）。 */
function namespaceOf(global, entries, errorClass) {
  const functions = Object.create(null);
  for (const [name, fn] of entries) {
    Object.defineProperty(functions, name, { enumerable: true, configurable: true, writable: true, value: fn });
  }
  return { global, functions, ...(errorClass === undefined ? {} : { errorClass }) };
}

/** 跑一个程序，返回 `{ result, elapsedMs }`。 */
async function runProgram(runtime, program, options = {}) {
  const started = Date.now();
  const spec = runtime.resolve({
    program,
    bindings: options.bindings ?? [],
    cwd: options.cwd ?? process.cwd(),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  const result = await runtime.run(spec);
  return { result, elapsedMs: Date.now() - started, spec };
}

/** 内层：全部断言。 */
async function innerMain() {
  const verbose = process.argv.includes("--verbose");
  const suite = new Suite(verbose);
  const pluginDir = join(dirname(SELF), "node_modules", "@deepseek-ai", PLUGIN_DIR_NAME);
  if (!existsSync(pluginDir)) {
    console.log(`内层只能由外层在舞台上调用（舞台上没有 ${pluginDir}）。直接 --inner 跑没有意义。`);
    process.exit(3);
  }

  console.log(`[ptc-inproc] 内层运行中：node ${process.version}，WebAssembly=${typeof WebAssembly}（--jitless 下必须是 undefined）`);
  suite.check("环境：整体跑在 --jitless 下（typeof WebAssembly === 'undefined'）", typeof WebAssembly === "undefined", `实际 ${typeof WebAssembly}；本门禁必须在 --jitless 下跑`);

  console.log("\n── A/B 静态断言（自写源码 + 代码位）──");
  staticAssertions(suite, pluginDir);

  if (!existsSync(join(pluginDir, "lib", "ts-strip.cjs"))) {
    console.log("\nSKIP：并行交付的纯 JS 擦除器 lib/ts-strip.cjs 未就位 —— 插件会 fail loud，行为断言无法进行。");
    suite.summary();
    process.exit(3);
  }

  // ── 进程级兜底：任何漏出来的 unhandledRejection 都要变成 FAIL，而不是把门禁打死 ──
  const unhandled = [];
  process.on("unhandledRejection", (reason) => {
    unhandled.push(String(reason && reason.message ? reason.message : reason));
  });

  const { Context } = await import("@deepseek-ai/cordis");
  const seam = await import("@deepseek-ai/dsh-ptc-runtime");
  const plugin = await import(PLUGIN_NAME);

  console.log("\n── G 挂载期预算 + 运行时自证（真机验收项 D）──");
  // 【为什么这些断言必须在这里、且顺序不能变】
  //   · 下面对擦除器做的审计会 `require("./ts-strip.cjs")`，那会往 CJS 缓存里塞条目；
  //     "挂载不得加载擦除器/vendor"这条断言必须在**任何** require 之前跑，否则失去判别力。
  //   · `plugin` 的 import 只拉 cordis / schemastery / dsh-util-values（小），不碰 vendor。
  const cacheKeys = () => Object.keys(requireLocal.cache ?? {});
  const heavyLoaded = () => cacheKeys().filter((key) => /ts-strip\.cjs|babel\.min\.cjs/.test(key));
  suite.eq("G1 挂载前：擦除器与 vendor bundle 都不在 CJS 缓存里", heavyLoaded(), []);

  const ctx = new Context();
  // 抓自证日志：两条既有通道都抓（console.log 走 stdout；ctx.logger 走 cordis 缓冲）。
  const selfReportLines = [];
  const originalConsoleLog = console.log;
  const mountStartedAt = performance.now();
  let mountError;
  try {
    console.log = (...args) => selfReportLines.push(args.map((value) => String(value)).join(" "));
    // 【生产同款挂载路径】**不传 config**：profile ⑦ 的 `insert` 就是这样，默认值由 cordis
    // 的 `resolveConfig(runtime, config)` ⇒ `Plugin.Config['~standard'].validate(config)` 补。
    // 门禁不再自己 `validate(undefined)` 后再 `new` —— 那条手工路径一旦与 cordis 漂移，报的
    // 是假红/假绿（例如 Config 少一个默认值时手工路径看不出后果）。所有断言与后续用例都
    // 用 `ctx.ptcRuntime`（= dsh-tools 的读法，traceable proxy）上的实例，天然同源。
    const fork = await ctx.plugin(plugin.default);
    await fork;
  } catch (error) {
    mountError = error;
  } finally {
    console.log = originalConsoleLog;
    const mountMs = performance.now() - mountStartedAt;
    suite.check(`G2 生产挂载 ctx.plugin(Plugin) 不带 config 成功且耗时 O(1)：${mountMs.toFixed(1)}ms < ${MOUNT_BUDGET_MS}ms`,
      mountError === undefined && mountMs < MOUNT_BUDGET_MS,
      mountError === undefined ? `实际 ${mountMs.toFixed(1)}ms` : `挂载抛错：${String(mountError === null || typeof mountError !== "object" ? mountError : mountError.message).slice(0, 200)}`);
  }
  suite.eq("G2 挂载后：擦除器与 vendor bundle 仍然不在 CJS 缓存里（只挂载不运行的启动代价是 O(1)）", heavyLoaded(), []);
  if (mountError !== undefined) {
    suite.fail("生产挂载失败 ⇒ ctx.ptcRuntime 未注册 ⇒ 端侧 PTC 照旧不可用", String(mountError === null || typeof mountError !== "object" ? mountError : mountError.message).slice(0, 200));
    suite.summary();
    process.exit(1);
  }
  try {
    for (const message of ctx.logger.buffer ?? []) {
      const args = Array.isArray(message.args) ? message.args : [];
      const text = args.map((value) => String(value)).join(" ");
      if (text.includes("ctx.ptcRuntime")) selfReportLines.push(text);
    }
  } catch {
    // logger 缓冲读不到就不是判据：console.log 那条已经在 selfReportLines 里。
  }
  // 生产读法：消费者（dsh-tools）读的就是 `ctx.ptcRuntime`。
  const runtime = ctx.ptcRuntime;
  suite.check("G3 ctx.ptcRuntime 就位（生产读法，traceable proxy）", runtime !== undefined && runtime !== null, String(runtime));
  // 默认值断言**基于生产挂载后实例上的实际值**（不再基于手工 `validate(undefined)` 的返回）。
  const config = runtime === undefined ? undefined : runtime.config;
  const configOk = config !== undefined && typeof config.timeoutMs === "number" && typeof config.maxTimeoutMs === "number" && typeof config.maxOutputBytes === "number";
  suite.check("G3 Config 默认值齐全（读生产挂载后的实例：timeoutMs / maxTimeoutMs / maxOutputBytes）", configOk, JSON.stringify(config));
  if (!configOk) {
    suite.fail("Config 默认值缺失 ⇒ 生产挂载虽然过了、但配置不可用（PTC 会在运行期出问题）", JSON.stringify(config));
    suite.summary();
    process.exit(1);
  }
  suite.eq("G3 timeout 默认值来自官方（timeoutMs 12e4 / maxTimeoutMs 6e5）", config, { timeoutMs: 120000, maxTimeoutMs: 600000, maxOutputBytes: 67108864 });
  const selfReport = selfReportLines.find((line) => line.includes("ctx.ptcRuntime"));
  suite.check("D 自证日志已打出（挂载期，走 console.log/ctx.logger 既有通道）", selfReport !== undefined, `抓到 ${selfReportLines.length} 行：${JSON.stringify(selfReportLines.slice(0, 2))}`);
  if (selfReport === undefined) {
    suite.fail("D 自证日志内容", "没抓到含 ctx.ptcRuntime 的行");
  } else {
    console.log(`  note 自证日志原文：${selfReport}`);
    suite.check("D 自证日志含实现标识与**本文件绝对路径**（回答「活进程加载了哪一份实现」）", selfReport.includes(PLUGIN_DIR_NAME) && selfReport.includes(join(pluginDir, "lib", "index.js")), selfReport.slice(0, 200));
    suite.check("D 自证日志含 language=typescript / isolation=in-process", selfReport.includes("language=typescript") && selfReport.includes("isolation=in-process"), selfReport.slice(0, 200));
    suite.check("D 自证日志含 sandboxMode=undefined（诚实声明）", selfReport.includes("sandboxMode=undefined"), selfReport.slice(0, 200));
    suite.check("D 自证日志含 timeout 默认与上限（120000ms / 600000ms）", selfReport.includes("120000ms") && selfReport.includes("600000ms"), selfReport.slice(0, 200));
    suite.check("D 自证日志含 typeof WebAssembly 实测值（端侧应为 undefined）", /typeof WebAssembly=undefined/.test(selfReport), selfReport.slice(0, 200));
  }

  console.log("\n── C 静态断言：vendor 硬事实 + 已审计产物摘要 ──");
  vendorAssertions(suite, pluginDir);
  vendorPathAgreement(suite, pluginDir, selfReport);

  console.log("\n── B 契约描述符 ──");
  suite.check("插件实例是缝的 PtcRuntime 子类（模块同一性）", runtime instanceof seam.PtcRuntime, `PtcRuntime=${typeof seam.PtcRuntime}`);
  suite.eq("language（消费者按它选 run_code flavor）", runtime.language, "typescript");
  suite.eq("isolation", runtime.isolation, "in-process");
  suite.eq("sandboxMode（无封闭能力 ⇒ undefined）", runtime.sandboxMode, undefined);
  suite.eq("timeout 取值面", runtime.timeout, { defaultMs: 120000, maxMs: 600000 });
  suite.check("executionInstructions 非空且提到 binding", typeof runtime.executionInstructions === "string" && runtime.executionInstructions.length > 0, runtime.executionInstructions.slice(0, 80));
  suite.check("已注册为 ctx.ptcRuntime", ctx.reflect.get("ptcRuntime", false) !== undefined, "ctx.reflect.get('ptcRuntime', false) 为 undefined");

  console.log("\n── C 行为断言 ──");

  // C1 纯 JS：return 42
  {
    const { result } = await runProgram(runtime, "return 42;");
    suite.eq("C1 return 42 ⇒ value 42", result.value, 42);
    suite.eq("C1 logs 为空", result.logs, []);
    suite.check("C1 结果不带 sandbox 字段（sandboxMode undefined 的对称面）", !("sandbox" in result), JSON.stringify(Object.keys(result)));
    suite.check("C1 无 error", result.error === undefined, JSON.stringify(result.error));
    // G3 正控：第一次 run 之后擦除器与 vendor**必须**都已经进了 CJS 缓存 —— 这条证明
    // "缓存探针"真的能看见本插件的 require（否则 G1/G2 的"没有"可能是探针坏了的假绿）。
    // 注意 vendor 会随第一次 run 一起加载：擦除器拿到任何源码都得先解析（它无法在不解析
    // 的情况下判断"这段有没有类型"），所以"成本推迟到首次使用"是它的设计上限。
    const loadedAfterFirstRun = heavyLoaded();
    suite.check("G3 正控：首次 run 之后擦除器与 vendor 都进了 CJS 缓存（证明挂载期那两条探针有判别力）", loadedAfterFirstRun.some((key) => /ts-strip\.cjs/.test(key)) && loadedAfterFirstRun.some((key) => /babel\.min\.cjs/.test(key)), JSON.stringify(loadedAfterFirstRun));
  }

  // C2 console 捕获（渲染与官方 makeConsoleShim 同形：字符串原样 + inspect）
  {
    const { result } = await runProgram(runtime, "console.log('a', 1);\nconsole.warn({ b: 2 });\nreturn 'ok';");
    suite.eq("C2 console.log('a', 1) 渲染为 'a 1'", result.logs[0], "a 1");
    suite.check("C2 console.warn 的对象走 inspect 风格（含键与值）", /b/.test(String(result.logs[1])) && /2/.test(String(result.logs[1])), JSON.stringify(result.logs[1]));
    suite.eq("C2 返回值仍在", result.value, "ok");
  }

  // C3 binding 可达 + 参数/返回值 + null 原型 + 分离副本
  {
    const seen = [];
    let mutated = null;
    const tools = namespaceOf("tools", [
      ["echo", async (args) => {
        seen.push(args);
        return { doubled: args.n * 2 };
      }],
      ["slowRead", async (args) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        mutated = args.n;
        return args.n;
      }]
    ], { name: "ToolCallError", memberNameProperty: "toolName" });
    const program = [
      "const r = await tools.echo({ n: 21 });",
      "console.log('doubled', r.doubled);",
      "const mine = { n: 1 };",
      "const pending = tools.slowRead(mine);",
      "mine.n = 99;",
      "const observed = await pending;",
      "return { doubled: r.doubled, observed, proto: Object.getPrototypeOf(tools), keys: Object.keys(tools) };"
    ].join("\n");
    const { result } = await runProgram(runtime, program, { bindings: [tools] });
    suite.eq("C3 binding 可达且返回值正确", result.value?.doubled, 42);
    suite.eq("C3 宿主收到程序传的参数", seen, [{ n: 21 }]);
    suite.eq("C3 参数是**分离副本**（程序事后改自己的对象，宿主看不到）", mutated, 1);
    suite.eq("C3 返回值是分离副本（observed 是宿主返回值的快照）", result.value?.observed, 1);
    suite.check("C3 命名空间是 null 原型（__proto__/constructor 不相撞）", result.value?.proto === null, `Object.getPrototypeOf(tools) = ${JSON.stringify(result.value?.proto)}`);
    suite.eq("C3 成员是普通自有键", result.value?.keys, ["echo", "slowRead"]);
    suite.eq("C3 日志按发射顺序", result.logs, ["doubled 42"]);
  }

  // C4 成员 reject ⇒ 注入的错误类实例（跨 realm `instanceof` 也要成立）
  {
    const tools = namespaceOf("tools", [
      ["boom", async () => {
        throw new Error("host refused");
      }]
    ], { name: "ToolCallError", memberNameProperty: "toolName" });
    const program = [
      "try { await tools.boom({}); return { caught: false }; }",
      "catch (e) {",
      "  return { caught: true, isClass: e instanceof ToolCallError, isError: e instanceof Error, name: e.name, member: e.toolName, message: e.message };",
      "}"
    ].join("\n");
    const { result } = await runProgram(runtime, program, { bindings: [tools] });
    suite.check("C4 成员 reject 被程序 catch 到", result.value?.caught === true, JSON.stringify(result.value));
    suite.check("C4 是注入的错误类实例（e instanceof ToolCallError）", result.value?.isClass === true, JSON.stringify(result.value));
    suite.check("C4 跨 realm 也 instanceof Error（类建在程序 realm 里）", result.value?.isError === true, JSON.stringify(result.value));
    suite.eq("C4 error.name === 声明的类名", result.value?.name, "ToolCallError");
    suite.eq("C4 成员名在 memberNameProperty 上", result.value?.member, "boom");
    suite.eq("C4 消息来自宿主异常", result.value?.message, "host refused");
  }

  // C5 程序 throw ⇒ exception
  {
    const { result } = await runProgram(runtime, "console.log('before');\nthrow new Error('kaboom');");
    suite.eq("C5 程序 throw ⇒ error.kind='exception'", result.error?.kind, "exception");
    suite.check("C5 消息可读（带用户文本与栈帧）", typeof result.error?.message === "string" && result.error.message.includes("kaboom"), String(result.error?.message).slice(0, 160));
    suite.eq("C5 抛错前的日志仍在", result.logs, ["before"]);
  }

  // C6 超时 + 紧接着第二次 run（回归 C 的核心）
  {
    const first = await runProgram(runtime, "return new Promise(() => {});", { timeoutMs: 150 });
    suite.eq("C6 永不结算的程序 ⇒ error.kind='timeout'", first.result.error?.kind, "timeout");
    suite.check("C6 超时消息点名了预算", String(first.result.error?.message).includes("150"), String(first.result.error?.message));
    suite.check("C6 在预算内 settle（不是等程序自己结束）", first.elapsedMs < 3000, `实际 ${first.elapsedMs}ms`);
    const second = await runProgram(runtime, "return 42;");
    suite.eq("C6 紧随其后的第二次 run 正常（回归 C）", second.result.value, 42);
    suite.check("C6 第二次 run 无 error", second.result.error === undefined, JSON.stringify(second.result.error));
  }

  // C7 超时时清光程序排的定时器（settle 之后再晚的定时器也不许碰 binding）
  //
  // 【为什么延时必须**大于**截止期】这是本用例唯一能证伪的地方：定时器若在截止期**之前**
  // 触发，那几次调用是合法的（run 还没结束），断言就失去判别力。所以 200ms/150ms 的
  // 定时器配 60ms 截止期 ⇒ settle 之后它们才到点；再等 300ms 观察，调用数必须是 0。
  {
    let markCalls = 0;
    const tools = namespaceOf("tools", [["mark", async () => {
      markCalls += 1;
      return null;
    }]]);
    const program = "setTimeout(async () => { try { await tools.mark({}); } catch (e) {} }, 200);\nsetInterval(async () => { try { await tools.mark({}); } catch (e) {} }, 150);\nreturn new Promise(() => {});";
    const { result } = await runProgram(runtime, program, { bindings: [tools], timeoutMs: 60 });
    suite.eq("C7 超时先成立", result.error?.kind, "timeout");
    await new Promise((resolve) => setTimeout(resolve, 300));
    suite.eq("C7 settle 时清光了程序排的定时器（超时后 300ms 内 0 次 binding 调用）", markCalls, 0);
  }

  // C8 完成值不是无损 JSON ⇒ invalid-output
  {
    const { result } = await runProgram(runtime, "return (() => {});");
    suite.eq("C8 不可 JSON 化的完成值 ⇒ 'invalid-output'", result.error?.kind, "invalid-output");
    suite.check("C8 不给出 value", result.value === undefined, JSON.stringify(result.value));
  }

  // C9 signal 中止（timeoutMs: null ⇒ 唯一能结算它的就是 abort）
  {
    const controller = new AbortController();
    setTimeout(() => controller.abort("test abort"), 30);
    const { result } = await runProgram(runtime, "return new Promise(() => {});", { signal: controller.signal, timeoutMs: null });
    suite.eq("C9 signal 中止 ⇒ error.kind='abort'", result.error?.kind, "abort");
    suite.eq("C9 abort 消息取自 signal.reason", result.error?.message, "test abort");
  }

  // C10 output-limit（日志与取值两路）
  {
    const tight = new plugin.default(new Context(), { ...config, maxOutputBytes: 64 });
    const logsOverflow = await runProgram(tight, "console.log('x'.repeat(200));\nreturn 1;");
    suite.eq("C10 日志超限 ⇒ 'output-limit'", logsOverflow.result.error?.kind, "output-limit");
    suite.check("C10 超限消息点名字节数", String(logsOverflow.result.error?.message).includes("64"), String(logsOverflow.result.error?.message));
    const valueOverflow = await runProgram(tight, "return 'y'.repeat(200);");
    suite.eq("C10 取值超限 ⇒ 'output-limit'", valueOverflow.result.error?.kind, "output-limit");
    const fits = await runProgram(tight, "return 'z';");
    suite.eq("C10 预算内的取值正常返回", fits.result.value, "z");
  }

  // C11 run 之间不得互相污染（也不许污染宿主）
  {
    const first = await runProgram(runtime, "Object.prototype.polluted = 1;\nglobalThis.leaked = 2;\nreturn [typeof globalThis.leaked, ({}).polluted];");
    suite.eq("C11 第一次 run 改了 realm 内建与 realm 全局", first.result.value, ["number", 1]);
    const second = await runProgram(runtime, "return [typeof globalThis.leaked, ({}.polluted === undefined ? 'clean' : 'polluted')];");
    suite.eq("C11 第二次 run 是干净 realm（对象原型未被污染、全局未残留）", second.result.value, ["undefined", "clean"]);
    suite.check("C11 宿主 globalThis 未被污染", globalThis.leaked === undefined && ({}).polluted === undefined, `leaked=${globalThis.leaked} polluted=${({}).polluted}`);
  }

  // C12 程序看不到宿主面；四个定时器与 console 在位；eval/new Function 被拒
  {
    const program = [
      "return {",
      "  process: typeof process, require: typeof require, fetch: typeof fetch, module: typeof module,",
      "  setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout, setInterval: typeof setInterval, clearInterval: typeof clearInterval,",
      "  console: typeof console, intl: typeof Intl, promise: typeof Promise, json: typeof JSON,",
      "  dynamic: (function () { try { new Function('return 1'); return 'allowed'; } catch (e) { return 'blocked'; } })()",
      "};"
    ].join("\n");
    const { result } = await runProgram(runtime, program);
    suite.eq("C12 宿主面不可见（process/require/fetch/module）", [result.value?.process, result.value?.require, result.value?.fetch, result.value?.module], ["undefined", "undefined", "undefined", "undefined"]);
    suite.eq("C12 四个定时器在位", [result.value?.setTimeout, result.value?.clearTimeout, result.value?.setInterval, result.value?.clearInterval], ["function", "function", "function", "function"]);
    suite.eq("C12 标准内建在位（console/Intl/Promise/JSON）", [result.value?.console, result.value?.intl, result.value?.promise, result.value?.json], ["object", "object", "function", "object"]);
    suite.eq("C12 realm 内 new Function 被 codeGeneration 关死", result.value?.dynamic, "blocked");
  }

  // C13 resolve() 的拒绝面与夹取语义（与官方 validateBindings 同口径）
  {
    const base = { program: "return 1;", bindings: [] };
    const reserved = namespaceOf("console", [["x", async () => null]]);
    suite.throws("C13 保留 global（console）被拒", () => runtime.resolve({ ...base, bindings: [reserved] }), /reserved binding global/);
    const bad = namespaceOf("my-tools", [["x", async () => null]]);
    suite.throws("C13 非法标识符被拒", () => runtime.resolve({ ...base, bindings: [bad] }), /not a usable identifier/);
    const pyWord = namespaceOf("lambda", [["x", async () => null]]);
    suite.throws("C13 便携保留字（Python 的 lambda）也被拒", () => runtime.resolve({ ...base, bindings: [pyWord] }), /not a usable identifier/);
    const dup = namespaceOf("tools", [["x", async () => null]]);
    suite.throws("C13 重复 global 被拒", () => runtime.resolve({ ...base, bindings: [dup, dup] }), /duplicate binding global/);
    const classClash = [namespaceOf("tools", [["x", async () => null]], { name: "dup2", memberNameProperty: "toolName" }), namespaceOf("dup2", [["y", async () => null]])];
    suite.throws("C13 错误类名与另一个 global 撞名被拒", () => runtime.resolve({ ...base, bindings: classClash }), /duplicate injected global/);
    const badClass = namespaceOf("tools", [["x", async () => null]], { name: "ToolCallError", memberNameProperty: "name" });
    suite.throws("C13 错误类成员名命中保留集（name）被拒", () => runtime.resolve({ ...base, bindings: [badClass] }), /member property .* is not usable/);
    const dunder = namespaceOf("tools", [["x", async () => null]], { name: "ToolCallError", memberNameProperty: "__proto__" });
    suite.throws("C13 dunder 形式的成员名被拒", () => runtime.resolve({ ...base, bindings: [dunder] }), /member property .* is not usable/);
    suite.throws("C13 显式 sandboxPolicy 被明确拒绝（我们无法封闭）", () => runtime.resolve({ ...base, sandboxPolicy: {} }), /no file confinement/);
    suite.throws("C13 相对 cwd 被拒", () => runtime.resolve({ ...base, cwd: "relative/dir" }), /cwd must be an absolute path/);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1000"]) {
      suite.throws(`C13 timeoutMs=${String(bad)} 被拒`, () => runtime.resolve({ ...base, timeoutMs: bad }), /timeoutMs must be a positive finite number/);
    }
    const spec = runtime.resolve(base);
    suite.eq("C13 缺省 timeoutMs ⇒ 官方默认 120000", spec.timeoutMs, 120000);
    suite.eq("C13 timeoutMs=null ⇒ 透传 null（不要截止期）", runtime.resolve({ ...base, timeoutMs: null }).timeoutMs, null);
    suite.eq("C13 超上限被夹取到 maxTimeoutMs", runtime.resolve({ ...base, timeoutMs: 9e9 }).timeoutMs, 600000);
    suite.eq("C13 上限内的值原样保留", runtime.resolve({ ...base, timeoutMs: 5000 }).timeoutMs, 5000);
    suite.check("C13 缺省 cwd ⇒ 进程 cwd（绝对路径）", spec.cwd === process.cwd(), `${spec.cwd}`);
    suite.check("C13 spec 不带 sandboxPolicy", !("sandboxPolicy" in spec), JSON.stringify(Object.keys(spec)));
    await suite.rejects("C13 run() 对手工塞了 sandboxPolicy 的 spec 也拒绝", () => runtime.run({ ...spec, sandboxPolicy: {} }), /no file confinement/);
  }

  // C14 dispose()/stop() 中止在飞行的 run，并在此后拒绝新工作
  {
    const own = new plugin.default(new Context(), config);
    const pending = own.run(own.resolve({ program: "return new Promise(() => {});", bindings: [], cwd: process.cwd(), timeoutMs: null }));
    await own.dispose();
    const settled = await pending;
    suite.eq("C14 dispose() 让在飞行的 run 结算为 abort", settled.error?.kind, "abort");
    suite.check("C14 abort 消息点名销毁", String(settled.error?.message).includes("disposed"), String(settled.error?.message));
    await suite.rejects("C14 销毁后 resolve() 拒绝", () => own.resolve({ program: "return 1;", bindings: [] }), /resolve after disposal/);
    await suite.rejects("C14 销毁后 run() 拒绝（spec 手工构造也拦）", () => own.run({ program: "return 1;", bindings: [], cwd: process.cwd(), timeoutMs: 1000 }), /run after disposal/);
  }

  console.log("\n── D TS 路径（真模块 lib/ts-strip.cjs）──");
  const tsCases = [
    ["D1 注解", "const x: number = 41;\nreturn x + 1;", 42],
    ["D2 泛型（函数声明与调用处类型实参）", "function id<T>(value: T): T { return value; }\nreturn await id<number>(7);", 7],
    ["D3 接口 + 可选属性", "interface P { a: number; b?: string }\nconst p: P = { a: 1 };\nreturn p.a;", 1],
    ["D4 枚举（擦除器会编译成运行时代码）", "enum E { A = 1, B }\nreturn E.B;", 2],
    ["D5 namespace（同上）", "namespace N { export const x = 3; }\nreturn N.x;", 3],
    ["D6 as 类型断言", "const n = [1, 2, 3] as number[];\nreturn n.length;", 3]
  ];
  for (const [name, program, expected] of tsCases) {
    const { result } = await runProgram(runtime, program);
    suite.eq(`${name} ⇒ ${JSON.stringify(expected)}`, result.error === undefined ? result.value : { error: result.error }, expected);
  }
  // G3b：第一次真正擦除之后 vendor 的加载事实（与 G2 的"挂载期不加载"合成完整证据链）。
  suite.check("G3b vendor bundle 的加载发生在首次 run 的擦除步骤（而不是挂载期）", heavyLoaded().some((key) => /babel\.min\.cjs/.test(key)), JSON.stringify(heavyLoaded()));
  {
    const empty = await runProgram(runtime, "");
    suite.check("D7 空程序 ⇒ 成功且无取值（空体分支）", empty.result.error === undefined && empty.result.value === undefined, JSON.stringify(empty.result));
    const blank = await runProgram(runtime, "   \n\n");
    suite.check("D7 纯空白程序 ⇒ 成功且无取值", blank.result.error === undefined && blank.result.value === undefined, JSON.stringify(blank.result));
    const typesOnly = await runProgram(runtime, "interface X { a: number }\ntype Y = number;\ndeclare const z: number;");
    suite.check("D7 纯类型程序 ⇒ 成功且无取值（全部语句被擦掉）", typesOnly.result.error === undefined && typesOnly.result.value === undefined, JSON.stringify(typesOnly.result));
  }
  {
    const bad = await runProgram(runtime, "const a: number = 1;\nconst = ;\nreturn 1;");
    suite.eq("D8 语法错误 ⇒ exception", bad.result.error?.kind, "exception");
    const message = String(bad.result.error?.message);
    suite.check("D8 行号已换算回 program 行号（报 program line 2，而不是包壳后的 3）", /program line 2\b/.test(message) && !/program line 3\b/.test(message), message.slice(0, 200));
    suite.check("D8 列号一并带出（column 7）", /column 7\b/.test(message), message.slice(0, 200));
    const decorator = await runProgram(runtime, "@dec class C {}\nreturn 1;");
    suite.eq("D9 装饰器（不可擦除语法）⇒ exception", decorator.result.error?.kind, "exception");
    suite.check("D9 消息点名擦除失败", /TypeScript types/.test(String(decorator.result.error?.message)), String(decorator.result.error?.message).slice(0, 160));
  }

  console.log("\n── E 运行时证据：读 WASM 即抛的陷阱 getter ──");
  {
    // 先跑一次 TS 用例，让擦除器把 2.93 MiB 的 vendor 加载并缓存 —— trap 只应覆盖
    // **执行路径**（擦除 + vm + binding），不该顺带管模块加载期的特性探测。
    const warm = await runProgram(runtime, "const n: number = 1;\nreturn n;");
    suite.eq("E0 预热：TS 用例正常", warm.result.value, 1);
    const original = Object.getOwnPropertyDescriptor(globalThis, "WebAssembly");
    Object.defineProperty(globalThis, "WebAssembly", {
      configurable: true,
      get() {
        throw new Error("门禁陷阱：运行路径读了 WASM（端侧 --jitless 下必炸）");
      }
    });
    try {
      const plain = await runProgram(runtime, "return 42;");
      suite.check("E1 trap 在位时纯 JS 程序照常（运行路径不读 WASM）", plain.result.value === 42 && plain.result.error === undefined, JSON.stringify(plain.result));
      const withConsole = await runProgram(runtime, "console.log('trap', 1);\nreturn 'ok';");
      suite.check("E2 trap 在位时 console 捕获照常", withConsole.result.value === "ok" && withConsole.result.logs[0] === "trap 1", JSON.stringify(withConsole.result));
      const ts = await runProgram(runtime, "const v: number = 41;\nreturn v + 1;");
      suite.check("E3 trap 在位时 TS 擦除 + 求值照常（这正是真机炸掉的那条路）", ts.result.value === 42 && ts.result.error === undefined, JSON.stringify(ts.result));
      const bind = await runProgram(runtime, "return (await tools.echo({ n: 2 })).doubled;", { bindings: [namespaceOf("tools", [["echo", async (args) => ({ doubled: args.n * 2 })]])] });
      suite.check("E4 trap 在位时 binding 往返照常", bind.result.value === 4 && bind.result.error === undefined, JSON.stringify(bind.result));
    } finally {
      if (original === undefined) delete globalThis.WebAssembly;
      else Object.defineProperty(globalThis, "WebAssembly", original);
    }
  }

  console.log("\n── H 生产挂载路径的最小实跑（`ctx.plugin(Plugin)` 不带 config + `ctx.ptcRuntime`）──");
  // 【这一臂与 G 是同一条挂载路径】G 组已经把"不带 config 的生产挂载"验完（G2/G3/D），
  // 这里只补一条**端到端**读数：从生产挂载出来的实例上真的跑一个最小程序 —— 因为真正的
  // 故障形态是"挂载没成功 ⇒ `ctx.ptcRuntime` 缺席 ⇒ run_code 照旧不可用"，只看描述符不够。
  {
    const minimal = await runtime.run(runtime.resolve({ program: "return 1;", bindings: [] }));
    suite.eq("H1 生产挂载实例上跑 `return 1;` ⇒ value 1", minimal.value, 1);
    suite.eq("H1 logs 为空", minimal.logs, []);
    suite.check("H1 无 error、且不带 sandbox 字段", minimal.error === undefined && !("sandbox" in minimal), JSON.stringify(Object.keys(minimal)));

    const tools = namespaceOf("tools", [["echo", async (args) => ({ n: args.n })]]);
    const withTools = await runtime.run(runtime.resolve({
      program: "const r = await tools.echo({ n: 1 });\nconsole.log('sum', r.n + 5);\nreturn r.n + 2;",
      bindings: [tools]
    }));
    suite.eq("H2 binding + console（同一条生产路径）⇒ value 3", withTools.value, 3);
    suite.eq("H2 logs", withTools.logs, ["sum 6"]);
    suite.check("H2 无 error", withTools.error === undefined, JSON.stringify(withTools.error));
  }

  suite.eq("F1 全程没有漏出来的 unhandledRejection", unhandled, []);

  const ok = suite.summary();
  console.log(ok ? "PASS：jitless 下同进程 PTC 运行时全项通过。" : "FAIL：见上面的 FAIL 行。");
  process.exit(ok ? 0 : 1);
}

/* ───────────────────────── 入口 ───────────────────────── */

if (process.argv.includes(INNER_FLAG)) {
  try {
    await innerMain();
  } catch (error) {
    // 内层**绝不能**在"没有结论"的情况下死掉：任何未预期异常都要变成一条明确的读数 + exit 1。
    const detail = error !== null && typeof error === "object" && typeof error.stack === "string"
      ? error.stack.split("\n").slice(0, 3).join(" | ")
      : String(error);
    console.log(`\n[ptc-inproc] 内层异常（未预期，套件中止）：${detail}`);
    console.log("FAIL：门禁自身在中途异常退出（见上），本次结果不可采信。");
    process.exit(1);
  }
} else {
  await outerMain();
}
