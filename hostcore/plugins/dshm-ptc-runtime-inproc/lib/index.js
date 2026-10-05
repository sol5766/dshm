/**
 * DSHM 端侧的**同进程、纯 JS `ctx.ptcRuntime` 实现**（`dshm-ptc-runtime-inproc`）。
 *
 * ── 为什么必须替换官方实现（缺口，已是定论）──────────────────────────────────
 * 官方 `@deepseek-ai/dsh-ptc-runtime-node` 在端侧有两条**结构性**死路：
 *   ① 类型擦除走 `node:module` 的 `stripTypeScriptTypes()`（SWC 的 WASM 版），而端侧
 *      Node 以 `--jitless` 运行 ⇒ WASM 不可用 ⇒ 解析那一刻就抛 `ReferenceError`
 *      （端侧报错文本里点名的就是那个全局，本文件与 `lib/vm-run.js` 全程不出现该
 *      标识符，由门禁的静态断言钉住）。真机逐字读数是
 *      `code run failed (exception): …`，原因与用户程序无关（空程序也报同一条）。
 *   ② 它把程序放进一个**新建的 Node 执行体**（`lib/process.js` 的 bootstrap），而
 *      端侧不允许（`EACCES`），且进程自身的可执行路径是系统的 appspawn 而不是 node
 *      ⇒ 连"用哪个可执行文件"都无从谈起。
 * 两条都不是配置能绕开的：官方实现的隔离模型（执行体 + SWC 擦除）在端侧整体不可用。
 * 所以这里换一个**同进程、纯 JS** 的实现，并把契约面收窄到「不提供文件封闭」这一条
 * 诚实声明上（见下）。
 *
 * ── 契约对齐（逐条，读的是缝的 `types.d.ts` 与官方实现）──────────────────────
 * · `language = 'typescript'`：**必须**。`dsh-tools` 的 `resolveFlavor()`
 *   （`lib/types/ptc.js:98-115`）按 `runtime.language` 查 `run_code` 的 schema flavor，
 *   查不到**直接抛**（"no run_code schema flavor registered for runtime language"）。
 * · `isolation = 'in-process'`：诊断用描述符（已核对无人 switch 它）。
 * · `sandboxMode === undefined`：缝的 d.ts 逐字写着 "Deployment file-policy mode, or
 *   undefined for a provider without confinement support"。消费者在
 *   `sandboxMode === undefined` 时**不传 `sandboxPolicy`**、不要求结果带 `sandbox`、
 *   也不给 `run_code` 挂 `sandbox_permissions`/`justification`
 *   （`dsh-tools/lib/types/ptc.js:74`、`lib/index.js:946,1190`，其中 :1190 的
 *   `standingPolicy = runtime.sandboxMode === void 0 ? void 0 : …` 是硬判据）。
 *   我们**不能**做文件封闭（端侧没有沙箱后端、也没有独立执行体），所以这里返回
 *   `undefined`，而不是谎报一个 mode。代价如实登记：程序的文件效果全部经由 binding
 *   的工具，工具自己的策略/审批照常生效。
 * · `timeout`：官方默认值照搬 —— `timeoutMs` 默认 `120000`、`maxTimeoutMs` 默认
 *   `600000`（`@deepseek-ai/dsh-ptc-runtime-node/lib/index.js:772-773` 的 `z` 默认值），
 *   `defaultMs = min(timeoutMs, maxTimeoutMs)`（同文件 :818-823）。夹取用官方同源的
 *   `@deepseek-ai/dsh-timeout` 的 `clampTimeout()`（:43-46），`null` 语义照官方
 *   `resolve()`（:837）：`null` = 不要截止期，透传。
 * · 名字校验口径照抄官方 `lib/types/bindings.js` 的 `validateBindings()`（:12-38）：
 *   同一个 `IDENTIFIER` 正则、同三组缝导出的保留集合（`PORTABLE_RESERVED_WORDS` /
 *   `RESERVED_BINDING_GLOBALS` / `RESERVED_ERROR_MEMBERS` + `DUNDER_MEMBER`），
 *   **错误措辞也同源**，只有包名前缀不同。
 * · 擦除协议照官方 `index.js:755-756,930`：`STRIP_PREFIX + program + STRIP_SUFFIX`
 *   包壳后整体擦除，再切掉壳得到函数体。擦除器是并行交付的纯 JS 模块
 *   `./ts-strip.cjs`（`{ stripErasableTs, TypeStripError }`）。
 *
 * ── 错误分类映射（缝的 `PtcRunFailure.kind`）────────────────────────────────
 * | 触发 | kind | 出处 |
 * |---|---|---|
 * | 程序抛错 / 编译不过 / 擦除失败（含 `TypeStripError`） | `exception` | 官方 `index.js:1168-1172` 的 `parsing` 分支 |
 * | 截止期到（`timeoutMs` 非 null） | `timeout` | 官方 :917-920（`execution deadline reached (Nms)`） |
 * | `signal` 触发 / 运行时被销毁 | `abort` | 官方 :921-924 |
 * | 完成值不是无损 JSON | `invalid-output` | 官方 `process.js:849` |
 * | 日志或取值超过 `maxOutputBytes` | `output-limit` | 官方 `process.js:854-859`（`outer output exceeded N bytes`） |
 * 不产生：`worker-exit`（没有执行体）、`protocol`（没有控制通道）、
 * `sandbox-unavailable`（不声称封闭）。三条在端侧结构上不存在。
 *
 * ── 运行时自证（真机验收项 D）──────────────────────────────────────────────
 * 挂载时打**一行**日志（`reportSelf()`，绝不影响启动）：
 *   `[ptc] ctx.ptcRuntime = dshm-ptc-runtime-inproc（同进程纯 JS；implementation=<本文件绝对路径>；
 *     language=typescript isolation=in-process sandboxMode=undefined timeout=default 120000ms/max 600000ms；
 *     擦除器=<vendor 绝对路径> <字节数>B；typeof WebAssembly=undefined）`
 * 通道是既有两条：`console.log`（端侧 stdout 被宿主重定向进文件 + tail 到 hilog，同仓
 * `dshm-*` 插件证据行的既有做法）与 `ctx.logger.info`（cordis 结构化 diag）。挂载期**只**
 * 做 `statSync` 与 `typeof` 读 —— 不 require 擦除器、不碰 vendor 的 bundle（懒加载）。
 *
 * ── 关于本文件里那几处 `typeof WebAssembly` ─────────────────────────────────
 * 门禁的静态规则要求本插件源码不出现该标识符（它是"端侧 jitless"的判据，也是官方实现
 * 炸掉的那条路）。自证日志必须**实测**报出端侧形态，所以规则 A/B 对这一处做了**钉死**：
 *   · `lib/index.js` 里**可执行**引用**恰好 1 处**，且必须是 `typeof WebAssembly` 诊断读
 *     （代码位计数 == 1）；其余出现只许是同一表达式的**文本标签**（日志里那一段），
 *     判据是"逐字出现次数 == `typeof WebAssembly` 出现次数"（即不存在裸取值/传参）。
 *   · `lib/vm-run.js` / `package.json`：逐字 **0** 次。
 *   · `lib/ts-strip.cjs`（并行交付的擦除器）：**代码位** 0 次（它的文件头注释里有该词，
 *     那是说明文字）。
 * 真正扛住"运行路径不许依赖 WASM"的是门禁的**运行时**证据：把该全局定义成"读一下就抛"
 * 的 trap getter，再跑一遍纯 JS 与 TS 程序。
 *
 * ── 已知边界（如实登记）────────────────────────────────────────────────────
 * ① **同步死循环会阻塞宿主线程**：in-process 无法抢占。`while (true) {}` 会把宿主
 *    事件循环整个占住 ⇒ 截止期定时器不触发 ⇒ `run()` 永不 settle。异步死等
 *    （`await new Promise(() => {})`）没有这个问题，由超时/中止兜住（见
 *    `vm-run.js` 的 `startProgram`）。
 * ② **`node:vm` 不是安全边界**（Node 官方文档明说）：宿主函数（console/定时器/
 *    binding 包装）的 `constructor` 可达宿主 `Function`。这不新增能力（`tools.*`
 *    本来就是完整代理），细节见 `vm-run.js` 头注。
 * ③ **内存上限不可靠**：没有独立执行体 ⇒ 没有独立堆。程序里 `new Array(1e9)` 之类
 *    直接吃宿主进程的内存，`maxOutputBytes` 只管日志/取值/诊断的字节数，不管堆。
 * ④ `output-limit` 溢出时**整条日志被丢弃**（官方会保留能塞下的前缀），理由见
 *    `vm-run.js` 的 `OutputLedger`。
 * ⑤ **程序运行期栈帧的行号不等于用户 program 的行号**：擦除器（Babel）会重排格式
 *    （实测：一个对象字面量会被拆成三行），而 `retainLines` 必须关掉（否则包壳不再
 *    逐字保留、切壳会切坏代码，见 `ts-strip.cjs` 的实测记录）。所以 `exception` 消息里
 *    的 `dshm-ptc-program.js:N` 只能用来定位"大致的语句"，不能当精确行号。
 *    **擦除错误（`TypeStripError`）的行号是精确的**，且已换算回 program 行号。
 * ⑥ run 结束（超时/中止）后仍在跑的异步程序只能"不再等它"：它的定时器与 binding
 *    入口会被关掉，但**闭包本身不会消失**（in-process 无抢占）。
 *
 * ── 恢复条件 ───────────────────────────────────────────────────────────────
 * 官方若在端侧可用（例如 SWC 换成纯 JS 擦除、或端侧允许起执行体），把
 * `hostcore/profile/ondevice/cordis.patch.yml` ⑦ 的那两条（`ptc-runtime` 的
 * `disabled: true` 与 `insert:` 块）删掉、并把 `tools/pack-core.mjs` 的
 * `DSHM_PLUGIN_PACKAGES` 里本项删掉，即完全回到官方行为。
 *
 * @module dshm-ptc-runtime-inproc
 */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { DUNDER_MEMBER, PORTABLE_RESERVED_WORDS, PtcRuntime, RESERVED_BINDING_GLOBALS, RESERVED_ERROR_MEMBERS } from "@deepseek-ai/dsh-ptc-runtime";
import { MAX_TIMER_DELAY_MS, clampTimeout } from "@deepseek-ai/dsh-timeout";
import { OutputLedger, jsonValueBytes, startProgram } from "./vm-run.js";

/** 稳定标识（日志/错误前缀用）。 */
const MODULE_NAME = "dshm-ptc-runtime-inproc";
/** 所有对外错误文本的前缀。官方用 `dsh-ptc-runtime-node: `，我们换成自己的包名。 */
const MESSAGE_PREFIX = `${MODULE_NAME}: `;
/**
 * 便携标识符：与官方 `dsh-ptc-runtime-node/lib/types/bindings.js:12` 逐字相同的正则
 * （`[A-Za-z_][A-Za-z0-9_]*`，不含 `$`）。
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** 擦除包壳前缀（官方 `index.js:755` 逐字相同，长度 35）。 */
const STRIP_PREFIX = "async function __dsh_program__() {\n";
/** 擦除包壳后缀（官方 `index.js:756` 逐字相同，长度 2）。 */
const STRIP_SUFFIX = "\n}";
/** 擦除器模块的相对路径（与擦除器交付方的接口约定）。 */
const STRIPPER_MODULE = "./ts-strip.cjs";
/**
 * 擦除器 vendor（`@babel/standalone` bundle）的相对说明符。
 *
 * 【为什么本文件要写这份路径】自证日志（{@link DshmPtcRuntime.reportSelf}）要在**挂载期**
 * 报出"擦除器用的是哪个文件、多大"，而挂载期**绝不能**去 require 擦除器（那会把 vendor
 * 的解析/编译成本算进启动预算，见 HMR 隔离与端侧启动预算两条要求）。`statSync` 是 O(1)
 * 的元数据读，代价可忽略。这份常量必须与 `./ts-strip.cjs` 里 `VENDOR.specifier` 一致 ——
 * 门禁 `tools/check-ptc-runtime-inproc.mjs` 的 C 规则会核对两者（不一致即红）。
 */
const STRIPPER_VENDOR_SPECIFIER = "./vendor/babel-standalone/babel.min.cjs";
/** 本文件的绝对路径（`import.meta.url` → 文件路径）；自证日志用它回答"加载的是哪一份实现"。 */
const SELF_FILE = fileURLToPath(import.meta.url);

const requireLocal = createRequire(import.meta.url);

/** 已解析的擦除器模块（进程内只 require 一次）。 */
let resolvedStripper;

/**
 * 取纯 JS 擦除器模块；缺失或接口不符就 **fail loud**。
 *
 * 【为什么缺失要抛而不是退化成某种"报 exception"】擦除器缺位是**部署故障**，不是
 * 程序故障。若伪装成 `exception`，模型会以为自己的 TypeScript 写错了、反复重试，
 * 而真正的原因在打包层。所以这里抛给调用方（`dsh-tools` 的 `resolve()` 调用点），
 * 与"只有契约误用才 reject"的缝约定一致：部署前提不满足属于契约误用。
 *
 * @returns `{ stripErasableTs, TypeStripError }`。
 */
function typeStripper() {
	if (resolvedStripper !== undefined) return resolvedStripper;
	let candidate;
	try {
		candidate = requireLocal(STRIPPER_MODULE);
	} catch (error) {
		throw new Error(`${MESSAGE_PREFIX}the pure-JS type stripper ${STRIPPER_MODULE} is not installed: ${messageOf(error)}`);
	}
	if (candidate === null || typeof candidate !== "object" || typeof candidate.stripErasableTs !== "function") {
		throw new Error(`${MESSAGE_PREFIX}${STRIPPER_MODULE} must export stripErasableTs(source: string): string`);
	}
	resolvedStripper = candidate;
	return candidate;
}

/** 任意值的可读文本（不查 `instanceof`：可能来自别的 realm）。 */
function messageOf(error) {
	if (error !== null && typeof error === "object" && typeof error.message === "string") return error.message;
	return String(error);
}

/**
 * 判定一个擦除失败是不是 `TypeStripError`。
 * 先按模块导出的类做 `instanceof`，再退回按 `name` 判形状 —— 擦除器与插件各自
 * 打包时类的同一性可能不成立，而**行号/列号必须被映射回用户 program 行号**这条
 * 契约不能因此丢失。
 * @param error - 擦除器抛出的值。
 * @param stripper - 擦除器模块。
 * @returns 是否按 `TypeStripError` 处理。
 */
function isTypeStripError(error, stripper) {
	if (typeof stripper.TypeStripError === "function" && error instanceof stripper.TypeStripError) return true;
	return error !== null && typeof error === "object" && error.name === "TypeStripError";
}

/**
 * 把 `TypeStripError` 变成可回喂模型的消息：**行号换算回用户 program**。
 *
 * 【换算依据】擦除器收到的 source 是包壳后的 `STRIP_PREFIX + program + STRIP_SUFFIX`，
 * 而 `STRIP_PREFIX` 含**恰好一个换行** ⇒ 包壳源码的第 N 行 = program 的第 N-1 行。
 * 若擦除器在包壳行上报错（N=1，理论上不会发生），夹到 1 而不是报"第 0 行"。
 *
 * @param error - `TypeStripError`（带 1-based `.line`/`.column`）。
 * @returns 面向前缀化的错误文本。
 */
function stripFailureMessage(error) {
	const line = typeof error.line === "number" ? error.line : undefined;
	const column = typeof error.column === "number" ? error.column : undefined;
	const programLine = line === undefined ? undefined : Math.max(1, line - 1);
	const where = programLine === undefined
		? ""
		: ` at program line ${programLine}${column === undefined ? "" : `, column ${column}`}`;
	return `${MESSAGE_PREFIX}cannot erase TypeScript types${where}: ${messageOf(error)}`;
}

/**
 * 校验并索引 binding 声明。规则、顺序与错误措辞与官方
 * `dsh-ptc-runtime-node/lib/types/bindings.js:18-38` 同源。
 *
 * @param request - `{ bindings }`。
 * @returns 以 `global` 为键、按声明顺序的 Map（重复 global 在此被拒）。
 * @throws 名字不可用、保留名、重复 global、成员不是函数等契约误用。
 */
function validateBindings(request) {
	const bindings = new Map();
	for (const namespace of request.bindings) {
		if (namespace === null || typeof namespace !== "object") throw new Error(`${MESSAGE_PREFIX}binding namespace must be an object`);
		const global = namespace.global;
		if (typeof global !== "string" || !IDENTIFIER.test(global) || PORTABLE_RESERVED_WORDS.has(global)) throw new Error(`${MESSAGE_PREFIX}binding global ${JSON.stringify(global)} is not a usable identifier`);
		if (RESERVED_BINDING_GLOBALS.has(global)) throw new Error(`${MESSAGE_PREFIX}reserved binding global ${JSON.stringify(global)}`);
		if (bindings.has(global)) throw new Error(`${MESSAGE_PREFIX}duplicate binding global ${JSON.stringify(global)}`);
		const functions = namespace.functions;
		if (functions === null || typeof functions !== "object" || Array.isArray(functions)) throw new Error(`${MESSAGE_PREFIX}binding namespace ${JSON.stringify(global)} must carry a functions object`);
		for (const name of Object.keys(functions)) {
			if (typeof functions[name] !== "function") throw new Error(`${MESSAGE_PREFIX}binding ${JSON.stringify(`${global}.${name}`)} must be a function`);
		}
		bindings.set(global, namespace);
	}
	const errorClassNames = new Set();
	for (const namespace of request.bindings) {
		const descriptor = namespace.errorClass;
		if (descriptor === undefined) continue;
		if (descriptor === null || typeof descriptor !== "object") throw new Error(`${MESSAGE_PREFIX}binding error class descriptor must be an object`);
		if (typeof descriptor.name !== "string" || !IDENTIFIER.test(descriptor.name) || PORTABLE_RESERVED_WORDS.has(descriptor.name)) throw new Error(`${MESSAGE_PREFIX}binding error class ${JSON.stringify(descriptor.name)} is not a usable identifier`);
		if (RESERVED_BINDING_GLOBALS.has(descriptor.name)) throw new Error(`${MESSAGE_PREFIX}reserved binding global ${JSON.stringify(descriptor.name)}`);
		if (bindings.has(descriptor.name) || errorClassNames.has(descriptor.name)) throw new Error(`${MESSAGE_PREFIX}duplicate injected global ${JSON.stringify(descriptor.name)}`);
		const member = descriptor.memberNameProperty;
		if (typeof member !== "string" || member.length === 0 || RESERVED_ERROR_MEMBERS.has(member) || DUNDER_MEMBER.test(member)) throw new Error(`${MESSAGE_PREFIX}binding error member property ${JSON.stringify(member)} is not usable`);
		errorClassNames.add(descriptor.name);
	}
	return bindings;
}

/**
 * 把"诊断/取值塞不进剩余预算"折叠成固定的 `output-limit` 诊断
 * （官方 `process.js:861-867` 的 `prepareFailure` 同义：不把超限的可变字节带出去）。
 * @param failure - 原失败。
 * @param ledger - 日志账本（提供剩余预算）。
 * @param limitFailure - 生成固定超限诊断的工厂。
 * @returns 可用的失败，或固定超限诊断。
 */
function fitFailure(failure, ledger, limitFailure) {
	if (jsonValueBytes(failure.message) > ledger.remainingBytes()) return limitFailure();
	return failure;
}

/**
 * 同进程 PTC 运行时：`ctx.ptcRuntime` 的实现，注册在**根层**（profile ⑦ 把它
 * `insert` 在根层，而 cordis 服务注册在根 ctx ⇒ `ctx.ptcRuntime` 即本实现）。
 */
export class DshmPtcRuntime extends PtcRuntime {
	/**
	 * 配置 schema。三个默认值来源：官方 `dsh-ptc-runtime-node/lib/index.js:771-781`
	 * 的 `Config`（`timeoutMs` 12e4、`maxTimeoutMs` 6e5、`maxOutputBytes` 67108864）。
	 * 官方还有 `maxOldGenerationSizeMb`/`maxMessageBytes`/`maxPendingCalls`/`graceMs`/
	 * `nodeExecutable`/`bootstrapPath` —— 那六个都只服务于"子进程 + 控制通道"，本实现
	 * 结构上没有对应物，**故意不接受**（照 `maxMessageBytes` 的写法造一个空壳只会让
	 * 读者以为它有用）。
	 */
	static Config = z.object({
		timeoutMs: z.number().default(12e4),
		maxTimeoutMs: z.number().default(6e5),
		maxOutputBytes: z.number().default(67108864)
	});

	/**
	 * 构造期的**兜底默认值** —— 与上面的 `Config` 逐值相同，**必须保持同步**。
	 *
	 * 【为什么"schema 有默认值"还不够（2026-10-05 真机实证）】
	 * profile 里我们那条 `insert` **不带 `config`**，而真机 Loader 的构造路径
	 * （`cordis` 的 `Fiber.execute` → `new Plugin(ctx, config)`，真机日志逐字可见
	 * `at Fiber.execute (…/@deepseek-ai/cordis/lib/index.js:1068:24)`）实测**没有**补上
	 * schema 默认值：当时打进树里的那份 `Config` 恰好少了 `timeoutMs` 的 `.default()`，
	 * 真机就报
	 *   `ptc-runtime-inproc (@deepseek-ai/dshm-ptc-runtime-inproc): Error:
	 *    dshm-ptc-runtime-inproc: timeoutMs must be positive and finite`
	 * ⇒ `ctx.ptcRuntime` 注册失败 ⇒ **PTC 照旧不可用**（与没修等价，且只有真机看得出来）。
	 * 因此本类**不把 schema 默认值当唯一防线**：缺键就补这份兜底值；
	 * 给了值（含显式值）则一律不覆盖。
	 */
	static DEFAULT_CONFIG = Object.freeze({ timeoutMs: 12e4, maxTimeoutMs: 6e5, maxOutputBytes: 67108864 });

	/** 消费者按它选 `run_code` 的 SDK flavor；`dsh-tools` 查不到会直接抛。 */
	language = "typescript";
	/** 执行基底描述符（诊断用；已核对无人 switch 它）。 */
	isolation = "in-process";

	/** 已校验配置（schemastery 已填默认值）。 */
	config;
	/** 在飞行的 run：`{ controller, finished }`，销毁时统一中止并等待。 */
	live = new Set();
	/** 是否已销毁（销毁后 `resolve`/`run` 一律拒绝）。 */
	disposed = false;

	/**
	 * @param ctx - cordis 上下文（`super` 会把实例注册为 `ptcRuntime`）。
	 * @param config - 已由 {@link DshmPtcRuntime.Config} 校验/补默认的配置。
	 */
	constructor(ctx, config) {
		// 缺键补齐：见 DEFAULT_CONFIG 的注释 —— 真机 Loader 路径不给 schema 默认值时，这里是唯一防线。
		const merged = { ...(config ?? {}) };
		for (const [key, value] of Object.entries(DshmPtcRuntime.DEFAULT_CONFIG)) {
			if (merged[key] === undefined) merged[key] = value;
		}
		super(ctx, merged);
		this.config = merged;
		for (const key of ["timeoutMs", "maxTimeoutMs", "maxOutputBytes"]) {
			const value = this.config[key];
			// schema 只保证"是数字"；正/有限/整数上界与官方构造期守卫同源（:796-802）。
			if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${MESSAGE_PREFIX}${key} must be positive and finite`);
		}
		for (const key of ["timeoutMs", "maxTimeoutMs"]) {
			if (this.config[key] > MAX_TIMER_DELAY_MS) throw new Error(`${MESSAGE_PREFIX}${key} exceeds the supported timer range`);
		}
		if (!Number.isSafeInteger(this.config.maxOutputBytes) || this.config.maxOutputBytes < 4) throw new Error(`${MESSAGE_PREFIX}maxOutputBytes must be an integer of at least 4`);
		// 与官方 `index.js:808-813` 同形的 fiber 清理：中止在飞行的 run 并等它们结算。
		ctx.effect(() => async () => {
			await this.shutdown("runtime disposed");
		}, `${MODULE_NAME} cleanup`);
		// 自证日志：真机验收唯一能证明"活进程到底加载了哪个实现"的东西。**绝不抛**。
		this.reportSelf();
	}

	/**
	 * 打一行**运行时自证**日志（真机验收项 D）。
	 *
	 * 【为什么需要】端侧的失败形态里有一类特别贵：日志说"某插件已启用"，实际活进程里加载
	 * 的是另一个实现（或旧版本）。这一行把"我是谁 / 我在哪 / 我的形态参数 / 我用的擦除器是
	 * 哪个文件"一次性钉在启动日志里，`hdc` 取回的日志即可判定。
	 *
	 * 【走哪条通道】两条**既有**通道，都不新造日志系统：
	 *   · `console.log` —— 端侧应用进程的 stdout 被宿主重定向进文件并 tail 到 hilog
	 *     （见 `hostcore/app/main.js` 的 stdout 拦截与 dshhost.cc），是同仓 `dshm-*` 插件
	 *     证据行（`[dshm-workspace-claim]` 等）一直在用的那条；
	 *   · `ctx.logger.info` —— cordis 的结构化 diag 通道（真机启动日志里带 fiber 名）。
	 *
	 * 【零成本纪律】这里**只做** `statSync`（O(1) 元数据）与 `typeof` 读；**不** require 擦除器、
	 * 更不碰 vendor 的 3 MiB bundle（那要等第一次真正擦除时才懒加载）。
	 *
	 * 【绝不抛】整段 try/catch：自证日志失败绝不能把插件挂载搞挂（那会连带 PTC 模式消失）。
	 */
	reportSelf() {
		try {
			const vendorPath = resolve(dirname(SELF_FILE), STRIPPER_VENDOR_SPECIFIER);
			let vendorBytes = "(缺失)";
			try {
				vendorBytes = `${statSync(vendorPath).size}B`;
			} catch {
				vendorBytes = "(stat 失败)";
			}
			// 【内容 hash（真机报告的验收建议）】自证行原来只有路径与体积；真机上"同名不同内容"
			// 完全可能（曾经就因为打包落在编辑中间态，树里那份与源码差一行，见 parity v1.48）。
			// 这里把**本实现自己的源码**与 **vendor 擦除器 bundle** 的 sha256（前 16 位）钉进日志，
			// 与仓库里 `node tools/check-ptc-wiring.mjs`（逐字节一致性）互相印证。
			// 成本：约 3.15 MiB 读盘 + 哈希 ⇒ 上电一次；下面把实测毫秒数一并打出来，便于端侧对照。
			const hashStartedAt = performance.now();
			const sha256Short = (path) => {
				try {
					return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
				} catch {
					return "(读不到)";
				}
			};
			const libDir = dirname(SELF_FILE);
			const selfHashes = `index.js:${sha256Short(SELF_FILE)}`
				+ ` vm-run.js:${sha256Short(resolve(libDir, "vm-run.js"))}`
				+ ` ts-strip.cjs:${sha256Short(resolve(libDir, "ts-strip.cjs"))}`
				+ ` vendor:${sha256Short(vendorPath)}`;
			const hashMs = Math.round((performance.now() - hashStartedAt) * 10) / 10;
			// 本文件里唯一一处**可执行**的该全局读取（前面那句 `typeof …`），是"活进程到底
			// 是不是 jitless 形态"的现场证据；同一文本在下面那行日志里再出现一次作为标签。
			const wasmState = typeof WebAssembly;
			const line = `[ptc] ctx.ptcRuntime = ${MODULE_NAME}（同进程纯 JS；implementation=${SELF_FILE}`
				+ `；language=${this.language} isolation=${this.isolation} sandboxMode=${String(this.sandboxMode)}`
				+ ` timeout=default ${this.timeout.defaultMs}ms/max ${this.timeout.maxMs}ms`
				+ `；擦除器=${vendorPath} ${vendorBytes}`
				+ `；自证 sha256(前16)=${selfHashes}（耗时 ${hashMs}ms）`
				+ `；typeof WebAssembly=${wasmState}）`;
			console.log(line);
			// 结构化通道：cordis logger 默认 exporter 只入缓冲（不重复打到 stdout），
			// 所以两处都有、设备日志不会出现两行。
			try {
				this.ctx.logger.info(line);
			} catch {
				// logger 不可用（极早期/被裁剪）：console.log 那一行已经是验收判据。
			}
		} catch (error) {
			try {
				console.log(`[ptc] ctx.ptcRuntime = ${MODULE_NAME}（自证日志生成失败，已忽略：${messageOf(error)}）`);
			} catch {
				// 连 console 都不可用：静默，绝不因为日志把挂载搞挂。
			}
		}
	}

	/**
	 * 程序使用说明：会被拼进 `run_code` 的 description（见 `dsh-tools/lib/index.js:1452-1458`）。
	 *
	 * 【语法口径按**实际擦除器**写，不按愿望写】交付的 `./ts-strip.cjs` 是
	 * `@babel/standalone` 的 `transform-typescript`：注解/接口/泛型/`as`/枚举/
	 * namespace 都能过（枚举与 namespace 会被**编译**成运行时语义，不只是删类型），
	 * 而 `import x = require(...)`、`export =`、装饰器会被擦除器**拒绝**（实测：
	 * `TypeStripError`）。所以这里点名后者。
	 */
	get executionInstructions() {
		return "Programs run in this process inside a fresh isolated context, so no Node API surface is reachable: `process`, `require`, dynamic `import()`, `fetch`, and `eval`/`new Function` are unavailable — reach every effect through the bound `tools` calls. TypeScript type syntax is supported (annotations, interfaces, generics, `as`, enums, namespaces), while `import x = require(...)`, `export =`, and decorators are rejected. This runtime enforces no file confinement: filesystem effects happen through the bound tools and follow their own policies.";
	}

	/**
	 * 部署文件策略：**没有**封闭能力 ⇒ 按缝的契约返回 `undefined`
	 * （而不是谎报一个 mode）。消费者据此不传 `sandboxPolicy`、不要求结果带
	 * `sandbox`，也不挂 `sandbox_permissions`/`justification`。
	 */
	get sandboxMode() {
		return undefined;
	}

	/** 默认/上限：与官方同源同值（见类头注的出处）。 */
	get timeout() {
		return {
			defaultMs: Math.min(this.config.timeoutMs, this.config.maxTimeoutMs),
			maxMs: this.config.maxTimeoutMs
		};
	}

	/**
	 * 解析一次执行：补齐目录、截止期与（不支持的）授权选择。
	 *
	 * @param request - `PtcRunRequest`。
	 * @returns `PtcRunSpec`：`cwd` 绝对、`timeoutMs` 为夹取后的正数或 `null`。
	 * @throws 契约误用时（名字不可用、显式 `sandboxPolicy`、相对 `cwd`、坏 `timeoutMs`、
	 *   擦除器缺位）。
	 */
	resolve(request) {
		if (this.disposed) throw new Error(`${MESSAGE_PREFIX}resolve after disposal`);
		if (request === null || typeof request !== "object") throw new Error(`${MESSAGE_PREFIX}resolve requires a request object`);
		// 【为什么显式拒绝而不是忽略】缝的 d.ts 明说 "Providers without confinement
		// reject an explicit policy"：调用方一旦传了策略，就是期待封闭生效 —— 静默忽略
		// 会让它以为程序被关住了。诚实拒绝。
		if (request.sandboxPolicy !== undefined) throw new Error(`${MESSAGE_PREFIX}this runtime provides no file confinement, so an explicit sandboxPolicy is not supported`);
		if (typeof request.program !== "string") throw new Error(`${MESSAGE_PREFIX}program must be a string`);
		if (!Array.isArray(request.bindings)) throw new Error(`${MESSAGE_PREFIX}bindings must be an array`);
		validateBindings(request);
		// 部署自检放在这里：擦除器缺位要在**执行之前**就以契约错误暴露，不能被伪装成
		// 程序异常（见 `typeStripper()` 的注释）。
		typeStripper();
		const cwd = request.cwd === undefined ? process.cwd() : request.cwd;
		if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error(`${MESSAGE_PREFIX}cwd must be an absolute path`);
		const timeoutMs = request.timeoutMs === null
			? null
			: clampTimeout(request.timeoutMs, this.config.timeoutMs, this.config.maxTimeoutMs, `${MESSAGE_PREFIX}timeoutMs`);
		return { ...request, cwd, timeoutMs };
	}

	/**
	 * 执行一个已解析的程序。**程序失败是结果字段 `error`，不是 reject**；只有契约
	 * 误用（非法 spec、已销毁）才 reject。
	 *
	 * @param spec - `resolve()` 的返回值（这里会重新校验，不信任调用方传进来的形状）。
	 * @returns `{ logs, value?, error? }`（**不产生** `sandbox`）。
	 */
	async run(spec) {
		if (this.disposed) throw new Error(`${MESSAGE_PREFIX}run after disposal`);
		if (spec === null || typeof spec !== "object") throw new Error(`${MESSAGE_PREFIX}run requires a resolved spec`);
		if (spec.sandboxPolicy !== undefined) throw new Error(`${MESSAGE_PREFIX}this runtime provides no file confinement, so an explicit sandboxPolicy is not supported`);
		if (typeof spec.cwd !== "string" || !isAbsolute(spec.cwd)) throw new Error(`${MESSAGE_PREFIX}run requires a resolved absolute cwd`);
		if (spec.timeoutMs !== null && (typeof spec.timeoutMs !== "number" || !Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0 || spec.timeoutMs > this.config.maxTimeoutMs)) throw new Error(`${MESSAGE_PREFIX}run requires a resolved timeout`);
		if (typeof spec.program !== "string") throw new Error(`${MESSAGE_PREFIX}program must be a string`);
		if (!Array.isArray(spec.bindings)) throw new Error(`${MESSAGE_PREFIX}bindings must be an array`);
		const bindings = [...validateBindings(spec).values()];
		const ledger = new OutputLedger(this.config.maxOutputBytes);
		const finished = Promise.withResolvers();
		const entry = { controller: new AbortController(), finished: finished.promise };
		this.live.add(entry);
		try {
			return await this.execute(spec, bindings, entry.controller, ledger);
		} finally {
			this.live.delete(entry);
			finished.resolve();
		}
	}

	/**
	 * 一次执行的完整流程：擦除 → 起程序 → 截止期/中止竞速 → 结果装配。
	 *
	 * 【为什么用 `Promise.race` 而不是"await 程序 + 定时器里抛"】in-process 无法抢占
	 * （见类头注 ①）：程序不会被"杀掉"，只能**不再等它**。所以 `run()` 的结算由
	 * 竞速决定，程序自己继续跑到自然结束（它的定时器与 binding 入口在 settle 时已被
	 * 关掉，见 `vm-run.js`）。这保证 `run()` **一定会 settle**（除同步死循环这一条
	 * 已登记的边界）。
	 *
	 * @param spec - 已解析的输入。
	 * @param namespaces - 已校验的命名空间（声明顺序）。
	 * @param runController - 本次 run 的控制器（销毁时由 `shutdown()` 中止）。
	 * @param ledger - 日志账本。
	 * @returns 结果（`sandbox` 字段不产生）。
	 */
	async execute(spec, namespaces, runController, ledger) {
		const limit = this.config.maxOutputBytes;
		const limitFailure = () => ({ kind: "output-limit", message: `outer output exceeded ${limit} bytes` });
		// 调用方信号与"运行时销毁"信号合流：两者都走 abort 分类。
		const signal = spec.signal === undefined ? runController.signal : AbortSignal.any([spec.signal, runController.signal]);
		const abortMessage = () => (signal.reason === undefined ? "run aborted" : messageOf(signal.reason));

		// 进门前已中止：程序一次都不起（否则会先产生副作用再报 abort）。
		if (signal.aborted) return { logs: [], error: { kind: "abort", message: abortMessage() } };

		const stripped = this.stripProgram(spec.program);
		if (!stripped.ok) return { logs: ledger.items, error: fitFailure(stripped.failure, ledger, limitFailure) };

		const started = startProgram({ body: stripped.body, namespaces, ledger });
		let timer;
		let onAbort;
		// `timeoutMs === null` = 不要截止期（官方 :837/:883 同义）：这一臂**永不结算**。
		const deadline = new Promise((resolve) => {
			if (spec.timeoutMs === null) return;
			timer = setTimeout(() => resolve(), spec.timeoutMs);
		});
		const aborted = new Promise((resolve) => {
			if (signal.aborted) {
				resolve();
				return;
			}
			onAbort = () => resolve();
			signal.addEventListener("abort", onAbort, { once: true });
		});
		let winner;
		try {
			winner = await Promise.race([
				started.promise.then((outcome) => ({ which: "program", outcome })),
				deadline.then(() => ({ which: "timeout" })),
				aborted.then(() => ({ which: "abort" }))
			]);
		} finally {
			// 谁先结算都要走到这里：关掉程序的定时器与 console/binding 入口，撤掉监听器
			// 与截止期定时器。这一步是"run 一定 settle 且不留尾巴"的唯一保证点。
			started.settle();
			if (timer !== undefined) clearTimeout(timer);
			if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
		}

		// settle 之后账本/入口都已关死（`vm-run.js` 里 console 与定时器都看 settled
		// 标志），所以这里取到的 `logs` 就是最终值。
		const logs = ledger.items;
		if (winner.which === "timeout") return { logs, error: { kind: "timeout", message: `execution deadline reached (${spec.timeoutMs}ms)` } };
		if (winner.which === "abort") return { logs, error: { kind: "abort", message: abortMessage() } };
		const outcome = winner.outcome;
		// 日志溢出优先于程序结果（官方 :910 的 `outputOverflow` 判定顺序同义）。
		if (ledger.truncated) return { logs, error: limitFailure() };
		if (outcome.failure !== undefined) return { logs, error: fitFailure(outcome.failure, ledger, limitFailure) };
		if (outcome.value === undefined) return { logs };
		if (jsonValueBytes(outcome.value) > ledger.remainingBytes()) return { logs, error: limitFailure() };
		return { logs, value: outcome.value };
	}

	/**
	 * 包壳 → 擦除 → 切壳（官方 `index.js:930-933` 同法）。
	 *
	 * @param program - 用户 program（async 函数体）。
	 * @returns `{ ok: true, body }` 或 `{ ok: false, failure }`（失败是**程序**失败 ⇒
	 *   `exception` 分类，不是 reject）。
	 */
	stripProgram(program) {
		const stripper = typeStripper();
		const wrapped = STRIP_PREFIX + program + STRIP_SUFFIX;
		let stripped;
		try {
			stripped = stripper.stripErasableTs(wrapped);
		} catch (error) {
			if (isTypeStripError(error, stripper)) return { ok: false, failure: { kind: "exception", message: stripFailureMessage(error) } };
			return { ok: false, failure: { kind: "exception", message: `${MESSAGE_PREFIX}type stripping failed: ${messageOf(error)}` } };
		}
		// 【空体分支（实测得来）】函数体里**一条运行时语句都没有**时（空程序、纯空白、
		// 只有注释、或只有 `interface`/`type`/`declare`），擦除器会把包壳折叠成
		// `async function __dsh_program__() {}` —— 前后壳都不再逐字保留（实测
		// @babel/standalone 7.28.4；空串/空白/纯换行/纯类型声明四种输入都是这个形状）。
		// 正则要求花括号之间**空无一物**，所以"体为空"是被证明过的，直接取空体。若不特判
		// 就会落进下面的守卫、把"模型写了个空程序"报成一条内部错误。
		if (/^async function __dsh_program__\(\)\s*\{\s*\}$/.test(stripped)) return { ok: true, body: "" };
		// 切壳前先确认壳**原样还在**：官方直接 `slice(35, -2)` 是建立在"擦除器不改动
		// 已合法的 JS 前缀"这一前提上的。前提不成立时静默切片会把用户代码切坏 —— 那是
		// 最难查的一类 bug，所以这里宁可报一条明确的内部错误。
		if (typeof stripped !== "string" || !stripped.startsWith(STRIP_PREFIX) || !stripped.endsWith(STRIP_SUFFIX)) {
			return { ok: false, failure: { kind: "exception", message: `${MESSAGE_PREFIX}type stripping rewrote the program wrapper; refusing to slice the result (stripper defect, not a program error)` } };
		}
		return { ok: true, body: stripped.slice(STRIP_PREFIX.length, stripped.length - STRIP_SUFFIX.length) };
	}

	/**
	 * 停机：中止在飞行的 run 并等它们全部结算（幂等）。`ctx.effect` 的清理、
	 * `dispose()`、`stop()` 三条路都走这里。
	 * @param reason - 透传给 `AbortController.abort()`，会成为结果的 `abort` 消息。
	 */
	async shutdown(reason) {
		this.disposed = true;
		const active = [...this.live];
		for (const entry of active) entry.controller.abort(reason);
		await Promise.all(active.map((entry) => entry.finished));
	}

	/** 显式销毁（与 fiber 清理同一条路径）。 */
	async dispose() {
		await this.shutdown("runtime disposed");
	}

	/** `dispose()` 的别名（停机语义相同的两种叫法）。 */
	async stop() {
		await this.shutdown("runtime stopped");
	}
}

export default DshmPtcRuntime;
