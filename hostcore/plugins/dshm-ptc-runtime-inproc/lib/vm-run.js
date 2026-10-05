/**
 * `dshm-ptc-runtime-inproc` 的**同进程求值底座**：一个 `node:vm` 新 realm、console
 * 捕获、定时器台账、输出字节账本。
 *
 * ── 为什么是 vm，而不是官方 bootstrap 的 `new AsyncFunction(...)` ─────────────
 * 官方 `dsh-ptc-runtime-node/lib/process.js:1027-1030` 在**子进程**里用
 * `new AsyncFunction(...globals, "console", "'use strict';\n" + code)` 求值 —— 那在
 * 子进程里是合理的（整个进程只跑这一个程序，进程退出即回收）。同进程下不行：宿主
 * realm 的 `globalThis` / `Object.prototype` / 内建对象全部可写，程序能改坏宿主，
 * "下一次 run 干净"这条也就不成立。`vm.createContext()` 给的是**全新 realm**：
 * `Object`/`Array`/`Promise`/`JSON`/`Math`/`Date`/`Map`/`Set`/`RegExp`/`Symbol`/`Intl`
 * 全是该 realm 自己的 intrinsics，而 `process` / `require` / 动态 import / `fetch` /
 * `queueMicrotask` 在该 realm 里**根本不存在**（`tools/check-ptc-runtime-inproc.mjs`
 * 对这些点都有读数断言）。所以本模块**不额外注入**任何标准内建 —— 需要的那一套
 * realm 自带；只注入四个定时器与 `console`（见下）。
 *
 * ── 它不是安全边界（如实登记，别当它是沙箱）──────────────────────────────────
 * Node 官方文档逐字写着 `node:vm` **不是**安全机制。我们注入的 `console`、四个定时器
 * 与 binding 包装都是宿主函数，程序可以顺着它们的 `constructor` 摸到宿主 `Function`。
 * 这不构成**新增**能力：`run_code` 的 binding 本来就是"调用宿主工具的完整代理"，
 * 模型经由 `tools.*` 本来就能读写文件、跑命令。本 realm 只承担三件事：
 *   ① run 之间互不污染（每次 run 新建 context）；
 *   ② 不把宿主的 `process`/`require`/`import`/`fetch` 面暴露给程序；
 *   ③ 不依赖 WASM（与端侧 `--jitless` 同向；`codeGeneration.wasm:false` 顺带钉死）。
 * "把敌意程序关住"不在这三件事里 —— 那需要进程/容器隔离，端侧没有。
 * 另加 `codeGeneration: { strings: false, wasm: false }`：零成本堵掉 realm 内的
 * `eval` / `new Function`，并把 wasm 编译在该 realm 里关死。
 *
 * @module dshm-ptc-runtime-inproc/vm-run
 */
import { Buffer } from "node:buffer";
import { inspect } from "node:util";
import { createContext, Script } from "node:vm";
import { snapshotJsonValue } from "@deepseek-ai/dsh-util-values";

/** 编译出来的程序函数在栈帧里显示的文件名（读数里可据此认出这是 PTC 程序）。 */
const PROGRAM_FILENAME = "dshm-ptc-program.js";

/**
 * 官方 `makeConsoleShim` 捕获的 5 个方法，顺序照抄
 * `dsh-ptc-runtime-node/lib/process.js:774-780`。
 */
const CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug"];

/** 官方 `INSPECT_OPTIONS`（`dsh-ptc-runtime-node/lib/process.js:825-829`）：够深、但有界。 */
const INSPECT_OPTIONS = { depth: 4, maxArrayLength: 100, maxStringLength: 1e4 };

/**
 * 错误值的文本化。**不查 `instanceof Error`** —— binding 的 reject 可能来自别的
 * realm，`instanceof` 会漏。
 * @param error - 任意抛出/拒绝值。
 * @returns 可读文本。
 */
function messageOf(error) {
	if (error !== null && typeof error === "object" && typeof error.message === "string") return error.message;
	return String(error);
}

/** 把一个抛出的值渲染成可读文本：优先栈（官方 `prepareException` 也是栈优先）。 */
function describeThrown(error) {
	if (error !== null && typeof error === "object") {
		const stack = error.stack;
		if (typeof stack === "string" && stack.length > 0) return stack;
		const message = error.message;
		if (typeof message === "string") return message;
	}
	try {
		return String(error);
	} catch {
		// 抛出的值自身在文本化时又抛（Proxy/坏 toString）：不能让它变成第二个异常。
		return "program threw an unrenderable value";
	}
}

/** 一个字符串按 JSON 序列化后的字节数（官方 `LogBuffer` 的记账口径）。 */
function jsonStringBytes(text) {
	const encoded = JSON.stringify(text);
	return encoded === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(encoded, "utf8");
}

/**
 * 一个已校验的无损 JSON 值按 JSON 序列化后的字节数。
 * @param value - 已经过 `snapshotJsonValue` 的取值。
 * @returns JSON 文本的 UTF-8 字节数。
 */
export function jsonValueBytes(value) {
	const encoded = JSON.stringify(value);
	return encoded === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(encoded, "utf8");
}

/**
 * 日志字节账本：与官方 `LogBuffer`（`dsh-ptc-runtime-node/lib/process.js:729-772`）
 * 同一套记账 —— 初始 2 字节算 `[` `]`、条目间 1 字节算逗号、每条按 JSON 字符串
 * 计字节。
 *
 * **与官方的一处简化（如实登记）**：官方在溢出时会把"能塞下的那一段前缀"也推
 * 进去（`truncateJsonStringBytes`），我们整条丢弃、只置 `truncated`。原因是这一
 * 条路径本来就会把整个 run 判成 `output-limit`（程序结果被丢弃、模型拿到固定
 * 诊断），前缀文本只影响展示、不影响判定；而"按 JSON 字节安全地截断一个可能
 * 巨大的字符串"要额外一套码点感知的算法，不值得在端侧多背一份。
 */
export class OutputLedger {
	/** 全部日志的字节预算（= 配置 `maxOutputBytes`）。 */
	maxBytes;
	/** 已记账字节（含数组括号与分隔符）。 */
	bytes = 2;
	/** 已收录条目数。 */
	entries = 0;
	/** 是否已经溢出：一旦为真，后续 push 全部丢弃。 */
	truncated = false;
	/** 已收录的日志文本。 */
	items = [];

	/**
	 * @param maxBytes - 日志 + 取值 + 诊断共用的字节预算。
	 */
	constructor(maxBytes) {
		this.maxBytes = maxBytes;
	}

	/**
	 * 收录一条日志文本；塞不下就把账本标记为溢出并丢弃该条。
	 * @param text - 渲染后的日志文本。
	 */
	push(text) {
		if (this.truncated) return;
		const separatorBytes = this.entries > 0 ? 1 : 0;
		const cost = jsonStringBytes(text);
		if (cost + separatorBytes > this.maxBytes - this.bytes) {
			this.truncated = true;
			return;
		}
		this.bytes += cost + separatorBytes;
		this.entries += 1;
		this.items.push(text);
	}

	/** 扣掉日志后剩下的字节预算（取值/诊断共用）。 */
	remainingBytes() {
		return this.maxBytes - this.bytes;
	}
}

/**
 * 定时器台账：把 realm 里的 `setTimeout`/`setInterval` 全部记在册上，`settle()` 时
 * 一律清掉。
 *
 * 【为什么必须有这一层】in-process 无法抢占（见 `startProgram` 的边界注释）：程序
 * 超时/被中止后**仍在跑**，它排的定时器会在 run 结束之后继续在宿主事件循环上触发。
 * 那些回调可能再去调 binding ⇒ 落到调用方的记账窗口之外。所以：① settle 时清光
 * 定时器；② 回调进入前先看 `settled` 标志（清不掉的极端情形也不执行）。
 */
function makeTimerSet() {
	const timeouts = new Set();
	const intervals = new Set();
	let settled = false;

	const arm = (kind, registry, handler, delay, args) => {
		if (typeof handler !== "function") throw new TypeError("timer handler must be a function");
		let handle;
		const invoke = () => {
			registry.delete(handle);
			if (settled) return;
			handler(...args);
		};
		// 定时器回调只会在之后的 tick 触发 ⇒ `handle` 必已赋值，闭包安全。
		handle = kind === "timeout" ? setTimeout(invoke, delay) : setInterval(invoke, delay);
		registry.add(handle);
		return handle;
	};

	return {
		api: {
			setTimeout: (handler, delay, ...args) => arm("timeout", timeouts, handler, delay, args),
			clearTimeout: (handle) => {
				timeouts.delete(handle);
				clearTimeout(handle);
			},
			setInterval: (handler, delay, ...args) => arm("interval", intervals, handler, delay, args),
			clearInterval: (handle) => {
				intervals.delete(handle);
				clearInterval(handle);
			}
		},
		settle() {
			settled = true;
			// Node 里 clearTimeout/clearInterval 对 Timeout 句柄是等价的，但按登记
			// 类型分开清，读代码的人不必知道这个细节。
			for (const handle of timeouts) clearTimeout(handle);
			for (const handle of intervals) clearInterval(handle);
			timeouts.clear();
			intervals.clear();
		}
	};
}

/**
 * 程序可见的 `console`：只有 5 个方法，渲染成 `util.inspect` 风格（与官方
 * `makeConsoleShim` 逐项同形），全部落进账本。
 *
 * 【为什么连全局 `console` 也一起换掉】`vm.createContext()` 会给新 context 自带一个
 * `console`（实测：`Object.getOwnPropertyNames(globalThis)` 里有 `console`），那是
 * 直写宿主 stdout 的实现 —— 程序只要写 `globalThis.console.log(...)` 就绕开了捕获。
 * 所以沙箱对象上显式放我们的 shim（覆盖自带的那个），同时仍作为**末位形参**传进
 * 程序函数（官方同形）：形参遮蔽全局，程序体内 `console.log` 一定被捕获。
 *
 * @param ledger - 日志账本。
 * @param state - 共享的 `{ settled }` 标志；settle 之后不再收日志（run 已结束）。
 * @returns 5 方法的 null 原型 console 对象。
 */
function makeConsoleShim(ledger, state) {
	const render = (arg) => {
		if (typeof arg === "string") return arg;
		try {
			return inspect(arg, INSPECT_OPTIONS);
		} catch {
			// 敌意/畸形取值让 inspect 抛时，不能把宿主异常灌进程序的控制流。
			return "[unrenderable]";
		}
	};
	const shim = Object.create(null);
	for (const level of CONSOLE_LEVELS) {
		shim[level] = (...args) => {
			if (state.settled) return;
			ledger.push(args.map(render).join(" "));
		};
	}
	return shim;
}

/**
 * 在**程序 realm 里**建一个继承该 realm `Error` 的类。
 *
 * 【为什么不能直接用宿主 `class extends Error`】跨 realm 的实例在程序里
 * `e instanceof Error` 为 **false**（`instanceof` 查的是 realm 自己的
 * `Error.prototype`），抛出注入实例的成员 reject 会变成一句令模型困惑的
 * "不是 Error"。官方在子进程里天生同 realm、没有这个问题；同进程实现必须显式把
 * 类建在程序 realm 里。
 *
 * 形态与官方 `makeBindingErrorClass`（`process.js:891-899`）一致：
 * `instance.name === descriptor.name`，`instance[memberNameProperty] === 成员名`，
 * 两个字段都是自有可枚举数据属性（官方 `defineBindingErrorField` 同形）。
 *
 * @param context - 程序 realm 的 context。
 * @param descriptor - `{ name, memberNameProperty }`。
 * @returns 程序 realm 里的错误类构造器。
 */
function makeRealmErrorClass(context, descriptor) {
	const factory = new Script(
		`(function (className, memberProperty) {
			class BindingCallError extends Error {
				constructor(memberName, message) {
					super(message);
					Object.defineProperty(this, "name", { value: className, enumerable: true, configurable: true, writable: true });
					Object.defineProperty(this, memberProperty, { value: memberName, enumerable: true, configurable: true, writable: true });
				}
			}
			return BindingCallError;
		})`,
		{ filename: `${PROGRAM_FILENAME}.error-class` }
	).runInContext(context);
	return factory(descriptor.name, descriptor.memberNameProperty);
}

/**
 * 建一个 binding 失败值：声明了错误类就用它的实例（成员名在
 * `memberNameProperty` 上），否则用程序 realm 的 `Error`。
 * @param ErrorClass - 程序 realm 的错误类，或 undefined。
 * @param realmError - 程序 realm 的 `Error` 构造器。
 * @param memberName - 成员名。
 * @param message - 人可读的错误文本。
 * @returns 可抛进程序 realm 的错误实例。
 */
function bindingFailure(ErrorClass, realmError, memberName, message) {
	return ErrorClass === undefined ? new realmError(message) : new ErrorClass(memberName, message);
}

/**
 * 建一个 binding 命名空间对象：null 原型（`__proto__`/`constructor`/`toString`
 * 都只是普通自有属性，绝不与原型链相撞 —— 缝的 `types.d.ts:41-47` 明文要求），
 * 每个成员是 async 包装：
 *   ① settle 之后一律拒绝（run 已经结束，不能让程序继续往宿主里调工具）；
 *   ② 入参必须无损 JSON，且**把分离出来的副本**交给宿主函数（官方是把参数编码过
 *      线再在宿主侧解码，等价于"宿主拿到的是副本"，程序改不到宿主看到的对象）；
 *   ③ 宿主函数 reject ⇒ 抛注入的错误类实例，成员名在 `memberNameProperty` 上；
 *   ④ 返回值必须无损 JSON，同样交出分离副本（宿主对象不会漏进程序 realm）。
 *
 * @param namespace - `{ global, functions, errorClass? }`。
 * @param ErrorClass - 该命名空间的程序 realm 错误类（可空）。
 * @param realmError - 程序 realm 的 `Error`。
 * @param state - 共享的 `{ settled }` 标志。
 * @returns null 原型命名空间对象。
 */
function makeNamespace(namespace, ErrorClass, realmError, state) {
	const object = Object.create(null);
	for (const name of Object.keys(namespace.functions)) {
		const member = namespace.functions[name];
		Object.defineProperty(object, name, {
			enumerable: true,
			configurable: true,
			writable: true,
			value: async (args) => {
				if (state.settled) {
					throw bindingFailure(ErrorClass, realmError, name, "the program run has already settled; no further binding calls are accepted");
				}
				let detached;
				try {
					detached = snapshotJsonValue(args);
				} catch {
					detached = undefined;
				}
				if (detached === undefined) {
					throw bindingFailure(ErrorClass, realmError, name, "binding arguments must be lossless JSON");
				}
				let resolution;
				try {
					resolution = await member(detached);
				} catch (error) {
					throw bindingFailure(ErrorClass, realmError, name, messageOf(error));
				}
				let snapshot;
				try {
					snapshot = snapshotJsonValue(resolution);
				} catch {
					snapshot = undefined;
				}
				if (snapshot === undefined) {
					throw bindingFailure(ErrorClass, realmError, name, "binding resolution must be lossless JSON");
				}
				return snapshot;
			}
		});
	}
	return object;
}

/**
 * 启动一个程序：编译进新 realm 并调用，返回 `{ promise, settle }`。
 *
 * 【已知边界：同步死循环】in-process 无法抢占。程序里一个**同步**死循环
 * （`while (true) {}`）会把宿主线程整个占住：定时器不会触发、`settle()` 不会被调到、
 * `run()` 永远不会 settle。进程/线程隔离下靠"终止执行体"能解决，同进程无解 —— 这是
 * 本实现如实登记的**唯一一条硬边界**（异步死等如 `await new Promise(() => {})` 由
 * `run()` 的超时/中止兜住，没有问题）。程序若是恶意/失控形态，宿主线程会被拖住：
 * 这是"端侧起不了执行体"这一约束的直接代价。
 *
 * @param options - `{ body, namespaces, ledger }`；`body` 是擦除后的程序体（一段语句
 *   序列，不是函数声明）。
 * @returns `{ promise, settle }`：`promise` 结算为 `{ value }` 或 `{ failure }`
 *   （**永不 reject** —— 程序失败是结果字段，不是异常路径）；`settle` 幂等，清定时器
 *   并关掉 console/binding 入口。
 */
export function startProgram(options) {
	const { body, namespaces, ledger } = options;
	const state = { settled: false };
	const timers = makeTimerSet();
	const settle = () => {
		state.settled = true;
		timers.settle();
	};

	const sandbox = Object.create(null);
	sandbox.console = makeConsoleShim(ledger, state);
	sandbox.setTimeout = timers.api.setTimeout;
	sandbox.clearTimeout = timers.api.clearTimeout;
	sandbox.setInterval = timers.api.setInterval;
	sandbox.clearInterval = timers.api.clearInterval;

	const context = createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
	const realmError = new Script("Error", { filename: `${PROGRAM_FILENAME}.boot` }).runInContext(context);

	// 形参顺序与官方一致（process.js:1030）：先各命名空间全局，再各错误类，最后 console。
	const errorClasses = new Map();
	for (const namespace of namespaces) {
		if (namespace.errorClass !== undefined) errorClasses.set(namespace, makeRealmErrorClass(context, namespace.errorClass));
	}
	const parameterNames = [];
	const parameters = [];
	for (const namespace of namespaces) {
		parameterNames.push(namespace.global);
		parameters.push(makeNamespace(namespace, errorClasses.get(namespace), realmError, state));
	}
	for (const namespace of namespaces) {
		if (namespace.errorClass === undefined) continue;
		parameterNames.push(namespace.errorClass.name);
		parameters.push(errorClasses.get(namespace));
	}
	parameterNames.push("console");
	parameters.push(sandbox.console);

	// 包壳：程序体是 async 函数的**体**（顶层 `await`/`return` 可用）。`"use strict";`
	// 与 `{` 同处第一条语句 ⇒ 程序自己的第 1 行 = 编译源码的第 2 行（栈帧行号 =
	// 程序行号 + 1）。官方是把 `'use strict';\n` 拼进 AsyncFunction 的 body
	// （process.js:1030），语义相同。
	const source = `(async function (${parameterNames.join(", ")}) { "use strict";\n${body}\n})`;
	let program;
	try {
		program = new Script(source, { filename: PROGRAM_FILENAME }).runInContext(context);
	} catch (error) {
		// 语法错误是**程序**失败（缝的 PtcRunFailure 把 "failed to parse/transform" 归
		// 到 'exception'），不是契约误用 ⇒ 结果字段。
		settle();
		return { promise: Promise.resolve({ failure: { kind: "exception", message: describeThrown(error) } }), settle };
	}

	const promise = (async () => {
		let value;
		try {
			value = await program(...parameters);
		} catch (error) {
			return { failure: { kind: "exception", message: describeThrown(error) } };
		}
		// 程序没 return（或 `return undefined`）：成功但无取值（官方
		// `prepareCompletion` 的 `if (value === void 0) return {}` 同义）。
		if (value === undefined) return {};
		let snapshot;
		try {
			snapshot = snapshotJsonValue(value);
		} catch {
			snapshot = undefined;
		}
		if (snapshot === undefined) {
			return { failure: { kind: "invalid-output", message: "program completion must be lossless JSON" } };
		}
		return { value: snapshot };
	})();

	// 兜底：上面这段按构造不可能 reject，但一旦有别的实现（例如某个 thenable 的
	// `then` 在 await 之外抛），也绝不能把 run() 变成 reject 路径。
	return { promise: promise.catch((error) => ({ failure: { kind: "exception", message: describeThrown(error) } })), settle };
}
