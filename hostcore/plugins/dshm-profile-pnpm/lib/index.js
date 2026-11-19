/**
 * DSHM 端侧「profile 包管理进程内通道」：给 `@deepseek-ai/dsh-plugin-manager` 的
 * `runProfilePnpm()` 一条**不走 spawn** 的包操作通道。
 *
 * ── 要解决什么（两份真机报告，2026-10-06）──────────────────────────────────
 * 「设置 → 插件 → 卸载」在平板/手机档 100% 失败，用户可见文案是
 *     Command failed with EACCES: pnpm remove <包名> / spawn pnpm EACCES
 * 根因是**本档没有任何可 execve 的 shell**（`system-sh=缺`、`ash=denied`、
 * `bash=denied`、`realShell=no`），而 `runProfilePnpm()` 的最后一跳是
 * `execa(options.command ?? "pnpm", …)` ⇒ 假壳 `bin/pnpm` 的第一行解释器就被内核拒。
 * 更糟的是：假壳里唯一真正干活的实现（`remove/rm` 分支写
 * `$DSH_HOME/install-queue/<base>.rem`）因此**结构上不可达**（一行都没执行）。
 *
 * ── 为什么不能靠配置修 ────────────────────────────────────────────────────
 * 上游留了钩子 `profileContext.packageManager`（`types/index.js:340/:401/:729`），
 * 但它只能改"**spawn 哪个可执行文件**"和"带什么 env"，最终仍是 `execa(command, args)`
 * —— 本档任何 command 都点不着火（toybox 可跑但**不带 sh applet**：实测
 * `toybox-exec-sh=rc1` / `toybox-exec-ash=rc126`）。所以必须在这里分叉。
 *
 * ── 判据与协议：与市场桥**完全同源** ──────────────────────────────────────
 * · 启用判据：应用沙箱（`DSHM_HOME` / `DSHM_SANDBOX_HOME` 在 `/data/storage/`）
 *   内始终接管，避免 `bin/pnpm --version` 偶然能跑、真实 view/config/add 又失败；
 *   仓库离线环境仍用同一探针，能跑就不接管。调试覆盖：
 *   `DSHM_PROFILE_PNPM_BRIDGE=force` 强制接管 / `=off` 强制不接管。
 * · 投递协议与 `bin/pnpm` 假壳、`@deepseek-ai/dshm-market-bridge` 同一份：
 *     add    → `<queue>/<base>.req`（一行 spec）+ `<base>.dir`（目标 profile 目录）
 *     remove → `<queue>/<base>.rem`
 *   Host 取走后写回 `<base>.done` / `<base>.fail`（JSON），本桥读到即自行删除。
 *   取值口径同样含 `--dir`/`--profile` **连值跳过**（否则 `--dir /x` 的 `/x` 会被当成
 *   第二个包名投递 —— 市场侧真机踩过；这里是同一段逻辑的第二处使用）。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * · `runProfilePnpm` 只接管 add/install/i 与 remove/rm/uninstall；
 *   官方页的 registry/view/preflight/GitHub 预检由本文件另外三个导出入口接管。
 * · **不新增权限、不动用户数据**：只往 `$DSH_HOME/install-queue/` 写请求；真正的
 *   改动由 Host 进程内的 `hostcore/app/dshm-installer.js` 完成（installSpec/removeSpec），
 *   与 `bin/pnpm` 假壳走的是同一个函数。
 * · **失败不抛**：任何异常都收敛成 `{ exitCode: 1, text }`，与 `execa` 失败同形，
 *   并由调用方写进 `.plugin-manager/logs/operation-<id>` 下的 `pnpm.log`。
 * · **文案给人看**：`.fail` 的原因会经 `removeBundle` 的 `throw new Error(output)`
 *   直接呈现给用户，所以失败文案必须是中文、可行动（报告 §4.6 的方案 C）。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

const TAG = "[dshm-profile-pnpm]";

/** 结果轮询间隔（Host 的取件轮询是 2s，这里更密一档，只为少等一个来回）。 */
const POLL_MS = 500;

/** 单次等待上限：比插件页自己的操作超时宽一档（正常只会由调用方先取消）。 */
const WAIT_MAX_MS = 20 * 60 * 1000;

/** 需要「连值一起跳过」的选项（口径与 `bin/pnpm` 假壳、市场桥逐条对齐）。 */
const VALUE_OPTS = ["--dir", "--profile"];

/** 本桥接管的命令字（其余一律返回 undefined = 沿用 spawn）。 */
const ADD_COMMANDS = ["add", "install", "i"];
const REMOVE_COMMANDS = ["remove", "rm", "uninstall"];
const ON_DEVICE_ROOT = "/data/storage/";
const DEFAULT_REGISTRY = "https://registry.npmmirror.com/";
const PUBLIC_VIEW_REGISTRIES = new Set([
	"https://registry.npmmirror.com/",
	"https://registry.npmjs.org/",
]);

/** 只记日志：桥的任何异常都不许升级成调用方的失败。 */
function log(message) {
	try {
		console.log(`${TAG} ${message}`);
	} catch {
		// 日志通道本身异常（极少）：忽略，绝不外抛。
	}
}

/** `Error | unknown` → 一行字符串。 */
function messageOf(error) {
	if (error && typeof error.message === "string") {
		return error.message;
	}
	return String(error);
}

/**
 * 随包 `bin/pnpm` 假壳能不能**真的**被 spawn 起来 —— 本桥唯一的启用判据
 * （与 `@deepseek-ai/dshm-market-bridge` 的 `shimRunnable()` 同判据同写法）。
 * 用 `spawnSync` 是为了能**同步**判定：本函数在 `runProfilePnpm()` 的调用链上，
 * 判定结果必须在使用前就拿到，不能把整条包操作变成异步探针的赌注。
 */
export function shimRunnable(env = process.env) {
	const sandbox = String(env.DSHM_SANDBOX_HOME || "").trim();
	if (sandbox.length === 0) {
		return false;
	}
	const shim = join(sandbox, "bin", "pnpm");
	if (!existsSync(shim)) {
		return false;
	}
	try {
		const result = spawnSync(shim, ["--version"], { stdio: "ignore", timeout: 5000 });
		return result.status === 0;
	} catch {
		return false;
	}
}

/**
 * 当前是否运行在 DSHM 应用沙箱里的 Host。
 *
 * 应用内**没有真 pnpm**，`bin/pnpm` 只是脚本薄壳。即使该脚本在某台 PC 上能被
 * `--version` 探针启动，上游后续的 `view/config/add` 仍会重新走 execa；只要其中
 * 任一跳因解释器/沙箱差异失败，官方插件页就会在“检查安装包”阶段直接失败。
 * 因此应用沙箱内以进程内通道为准；仓库离线测试（/tmp 等）仍保留原来的
 * “假壳能跑就不接管”语义。
 */
export function isDshmAppRuntime(env = process.env) {
	const home = String(env.DSHM_HOME || "").trim();
	const sandbox = String(env.DSHM_SANDBOX_HOME || "").trim();
	return home.startsWith(ON_DEVICE_ROOT) && sandbox.startsWith(ON_DEVICE_ROOT);
}

/** 本桥是否应接管；`force` / `off` 保留给现场诊断。 */
export function bridgeEnabled(env = process.env) {
	const mode = String(env.DSHM_PROFILE_PNPM_BRIDGE || "").trim().toLowerCase();
	if (mode === "off") {
		return false;
	}
	return mode === "force" || isDshmAppRuntime(env) || !shimRunnable(env);
}

/**
 * 官方页在 GitHub 安装前会额外 spawn `git ls-remote` 做可达性预检；应用内真正的
 * 下载已经由 `dshm-installer` 完成。该预检在 PC/手机上仍是另一条 shell 依赖，
 * 且一旦失败会抢在安装器之前把整次安装终止。应用内跳过它，让真实下载路径给出
 * 准确错误；非应用环境保持上游原实现。
 */
export function shouldSkipGithubConnection(spec, env = process.env) {
	if (!bridgeEnabled(env) || spec === null || typeof spec !== "object" || spec.kind !== "git") {
		return false;
	}
	const host = String(spec.host || "").toLowerCase().replace(/:.*$/, "");
	const handled = host === "github.com" || host.endsWith(".github.com");
	if (handled) {
		log(`GitHub preflight skipped: ${String(spec.spec || host)}（由进程内安装器下载）`);
	}
	return handled;
}

function normalizeRegistry(value) {
	try {
		const parsed = new URL(String(value || "").trim());
		if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
			return "";
		}
		parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/`;
		return parsed.href;
	} catch {
		return "";
	}
}

/** 读应用内配置的 registry；缺省与 Host 安装器一致使用 npmmirror。 */
export function bridgeReadProfileRegistry(profileDir, env = process.env) {
	void profileDir;
	if (!bridgeEnabled(env)) {
		return undefined;
	}
	const home = String(env.DSHM_HOME || "").trim();
	if (home.length > 0) {
		try {
			const config = JSON.parse(readFileSync(join(home, "installer.json"), "utf8"));
			const configured = normalizeRegistry(config && config.registry);
			if (configured.length > 0) {
				log(`registry bridge: ${configured}`);
				return configured;
			}
		} catch {
			// 没有配置文件或内容不可读：使用与安装器相同的默认 registry。
		}
	}
	log(`registry bridge: ${DEFAULT_REGISTRY}`);
	return DEFAULT_REGISTRY;
}

function hostReady(env) {
	const home = String(env.DSHM_HOME || "").trim();
	if (home.length === 0) {
		return null;
	}
	try {
		const ready = JSON.parse(readFileSync(join(home, "host-ready.json"), "utf8"));
		const token = typeof ready.token === "string" ? ready.token : "";
		const configuredPort = Number(env.DSHM_PORT || ready.port || 3120);
		if (token.length === 0 || !Number.isInteger(configuredPort) || configuredPort <= 0 || configuredPort > 65535) {
			return null;
		}
		return { token, port: configuredPort };
	} catch {
		return null;
	}
}

function getLocalJson(pathname, params, signal, env = process.env) {
	return new Promise((resolve) => {
		if (signal && signal.aborted) {
			resolve({ status: 0, body: null, error: "cancelled" });
			return;
		}
		const ready = hostReady(env);
		if (ready === null) {
			resolve({ status: 0, body: null, error: "Host token 尚未就绪" });
			return;
		}
		const query = new URLSearchParams({ token: ready.token, ...params }).toString();
		const req = httpRequest({
			host: "127.0.0.1",
			port: ready.port,
			method: "GET",
			path: `${pathname}?${query}`,
			headers: { accept: "application/json" },
			timeout: 20000,
		}, (response) => {
			const chunks = [];
			let bytes = 0;
			response.on("data", (chunk) => {
				bytes += chunk.length;
				if (bytes <= 4 * 1024 * 1024) {
					chunks.push(chunk);
				}
			});
			response.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				let body = null;
				try {
					body = JSON.parse(text);
				} catch {
					body = null;
				}
				resolve({
					status: Number(response.statusCode || 0),
					body,
					error: body && typeof body.error === "string" ? body.error : "",
				});
			});
		});
		const cancel = () => req.destroy(new Error("cancelled"));
		if (signal) {
			signal.addEventListener("abort", cancel, { once: true });
		}
		req.on("timeout", () => req.destroy(new Error("view timed out after 20000ms")));
		req.on("error", (error) => resolve({ status: 0, body: null, error: messageOf(error) }));
		req.on("close", () => {
			if (signal) {
				signal.removeEventListener("abort", cancel);
			}
		});
		req.end();
	});
}

/**
 * 官方插件页在安装前会调用 `viewProfilePackage()`（`pnpm view` 同形）。
 * 应用内改为转发 Host 已有的 `/dshm-registry/view`，让检查与安装使用同一个
 * 进程内 registry 通道；自定义 registry 不在这里冒充，继续走原实现。
 */
export async function bridgeViewProfilePackage(dir, spec, options = {}, env = process.env) {
	void dir;
	if (!bridgeEnabled(env)) {
		return undefined;
	}
	const requested = normalizeRegistry(options.registry);
	if (requested.length > 0 && !PUBLIC_VIEW_REGISTRIES.has(requested)) {
		return undefined;
	}
	const ready = hostReady(env);
	if (ready === null) {
		return {
			exitCode: 1,
			stdout: "",
			stderr: "Host token 尚未就绪（host-ready.json）",
			timedOut: false,
			isCanceled: false,
		};
	}
	const fieldsParam = Array.isArray(options.fields) && options.fields.length > 0 ? options.fields.join(",") : "";
	const result = await getLocalJson("/dshm-registry/view", { spec: String(spec || ""), ...(fieldsParam ? { fields: fieldsParam } : {}) }, options.signal, env);
	log(`view bridge: ${String(spec || "")} fields=${fieldsParam || "(default)"} → /dshm-registry/view status=${result.status}`);
	if (result.status === 200 && result.body && typeof result.body === "object") {
		return {
			exitCode: 0,
			stdout: JSON.stringify(result.body),
			stderr: "",
			timedOut: false,
			isCanceled: false,
		};
	}
	const reason = result.error || `registry view exited with ${String(result.status)}`;
	return {
		exitCode: 1,
		stdout: result.body ? JSON.stringify(result.body) : "",
		stderr: reason,
		timedOut: /timed out/i.test(reason),
		isCanceled: options.signal && options.signal.aborted === true,
	};
}

/**
 * 队列目录：`$DSH_HOME/install-queue`；`DSHM_HOME` 缺失时按 profile 目录反推
 * （`<HOME>/profiles/<name>`）—— 队列永远与 profile 同源。
 */
export function queueDirFor(profileDir, env = process.env) {
	const home = String(env.DSHM_HOME || "").trim();
	if (home.length > 0) {
		return join(home, "install-queue");
	}
	const dir = String(profileDir || "").trim();
	if (dir.length === 0) {
		return "";
	}
	// <HOME>/profiles/<name> → <HOME>/install-queue
	const parts = dir.replace(/[\\/]+$/, "").split(/[\\/]/);
	parts.pop();
	parts.pop();
	return join(parts.join("/"), "install-queue");
}

/**
 * 取「命令字之后」的目标参数。与 `bin/pnpm` 假壳的 `shimSkipOptValuesLines()` 同一口径：
 * `--dir`/`--profile` 连值一起跳过，其余 `-` 开头的一律单跳过，剩下的才是包名 / GitHub 地址。
 * 导出是为了离线门禁能直接断言这套口径。
 * @param args 命令字之后的原始参数
 * @returns 目标 spec 数组（保持出现顺序）
 */
export function bridgeTargets(args) {
	const out = [];
	const list = Array.isArray(args) ? args : [];
	for (let i = 0; i < list.length; i += 1) {
		const arg = list[i];
		if (typeof arg !== "string") {
			continue;
		}
		if (VALUE_OPTS.includes(arg)) {
			i += 1; // 连值一起吞掉（值本身可能不带 `-`，不能被当成包名）
			continue;
		}
		let skipped = false;
		for (const opt of VALUE_OPTS) {
			if (arg.startsWith(`${opt}=`)) {
				skipped = true;
				break;
			}
		}
		if (skipped || (arg.startsWith("-") && arg.length > 1)) {
			continue;
		}
		out.push(arg);
	}
	return out;
}

/**
 * 投递一条请求：`.req`（装）/ `.rem`（卸）一行 spec，另写 `.dir` 指明目标 profile。
 * `.dir` 用调用方给的 profile 目录（`profileContext.dir`，权威值）—— Host 侧对 `.dir`
 * 是"原样采纳"，写错就会装进别的 profile 的 node_modules。
 * @returns base（结果文件名前缀）
 */
function submit(queueDir, spec, profileDir, remove) {
	mkdirSync(queueDir, { recursive: true });
	const base = `profile-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const writerToken = globalThis.__dshmProfileWriterToken?.(profileDir);
	if (writerToken) writeFileSync(join(queueDir, `${base}.writer`), writerToken, 'utf8');
	if (profileDir.length > 0) {
		try {
			writeFileSync(join(queueDir, `${base}.dir`), profileDir, "utf8");
		} catch (error) {
			log(`目标目录标记写失败（Host 将回退宿主 profile）：${messageOf(error)}`);
		}
	}
	writeFileSync(join(queueDir, `${base}${remove ? ".rem" : ".req"}`), `${spec}\n`, "utf8");
	return base;
}

/**
 * 等一条请求的结果。
 * @returns `{kind:"ok", payload}` | `{kind:"fail", error}` | `{kind:"cancelled"}` | `{kind:"timeout"}`
 */
function waitOutcome(queueDir, base, isCancelled) {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const tick = () => {
			if (isCancelled()) {
				resolve({ kind: "cancelled" });
				return;
			}
			const doneFile = join(queueDir, `${base}.done`);
			const failFile = join(queueDir, `${base}.fail`);
			const hit = existsSync(doneFile) ? doneFile : (existsSync(failFile) ? failFile : "");
			if (hit.length > 0) {
				let payload = null;
				let parseError = "";
				try {
					payload = JSON.parse(readFileSync(hit, "utf8"));
				} catch (error) {
					parseError = messageOf(error);
				}
				// 结果文件由写入方（本桥）自己清理：Host 只在 mtime 超 1h 时清陈旧文件。
				try {
					rmSync(hit, { force: true });
				} catch {
					// 删不掉只会留一个陈旧文件，Host 一小时后自清；不报错。
				}
				if (parseError.length > 0) {
					resolve({ kind: "fail", error: `结果文件不是合法 JSON：${parseError}` });
					return;
				}
				if (hit === doneFile && payload && payload.ok !== false) {
					resolve({ kind: "ok", payload });
					return;
				}
				const reason = payload && typeof payload.error === "string" && payload.error.length > 0
					? payload.error
					: "安装器未给出原因（见 $DSH_HOME/install-queue 与宿主日志）";
				resolve({ kind: "fail", error: reason });
				return;
			}
			if (Date.now() - startedAt > WAIT_MAX_MS) {
				resolve({ kind: "timeout" });
				return;
			}
			/*
			 * 【不能 unref】这个等待本身就是"进程还要干的活"：unref 掉的定时器不保活事件循环，
			 * 于是"等队列结果"期间的进程会被判成无事可做（市场桥的同款注释记着这个坑）。
			 */
			setTimeout(tick, POLL_MS);
		};
		tick();
	});
}

/** 安装器结果 JSON → 一行给人看的文本（与市场桥同一口径）。 */
function describeDone(spec, payload) {
	const p = payload && typeof payload === "object" ? payload : {};
	const head = typeof p.name === "string" && p.name.length > 0 ? p.name : spec;
	const version = typeof p.version === "string" && p.version.length > 0 ? `@${p.version}` : "";
	const parts = [`完成：${head}${version}`];
	if (Array.isArray(p.installed) && p.installed.length > 0) {
		const names = p.installed
			.map((item) => (item && typeof item.name === "string" ? item.name : ""))
			.filter((item) => item.length > 0);
		parts.push(`（共 ${p.installed.length} 个包${names.length > 0 ? `：${names.join("、")}` : ""}）`);
	}
	if (typeof p.note === "string" && p.note.length > 0) {
		parts.push(`—— ${p.note}`);
	}
	return parts.join(" ");
}

/**
 * 桥的入口：由 `tools/pack-core.mjs` 注入核心树的
 * `@deepseek-ai/dsh-plugin-manager/lib/types/operations.js` 调起。
 *
 * @param args `runProfilePnpm()` 收到的 pnpm 参数（`[命令, …选项, 目标]`）
 * @param ctx `{ dir, signal }` —— profile 目录与调用方的取消信号
 * @returns `undefined`（不接管，调用方照旧 spawn）或 `{ exitCode, text }`
 */
export async function bridgeRunProfilePnpm(args, ctx = {}) {
	try {
		const argv = (Array.isArray(args) ? args : []).filter((a) => typeof a === "string");
		const command = typeof argv[0] === "string" ? argv[0] : "";
		const isRemove = REMOVE_COMMANDS.includes(command);
		const isAdd = ADD_COMMANDS.includes(command);
		if (!isRemove && !isAdd) {
			return undefined;
		}
		if (!bridgeEnabled()) {
			return undefined;
		}
		const profileDir = String(ctx.dir || "").trim();
		if (profileDir.length === 0) {
			log("ctx.dir 缺失 ⇒ 不接管（无法定位目标 profile）");
			return undefined;
		}
		const queueDir = queueDirFor(profileDir);
		if (queueDir.length === 0) {
			return undefined;
		}
		const targets = bridgeTargets(argv.slice(1));
		if (targets.length === 0) {
			if (isRemove) {
				return { exitCode: 1, text: "未给出要卸载的包名" };
			}
			// 与 `bin/pnpm` 假壳同口径：无目标的 install 在端侧是 lockfile 重建/恢复路径，
			// 端侧没有 lockfile 概念，如实跳过而不是假装装了什么。
			return { exitCode: 0, text: "install 无目标：端侧按 lockfile 重建语义跳过（与 bin/pnpm 假壳同口径）" };
		}
		const signal = ctx.signal;
		const cancelled = () => Boolean(signal && signal.aborted);
		const lines = [];
		let failed = false;
		for (const spec of targets) {
			if (cancelled()) {
				lines.push(`已取消：${spec}`);
				failed = true;
				break;
			}
			let base = "";
			try {
				base = submit(queueDir, spec, profileDir, isRemove);
			} catch (error) {
				lines.push(`安装队列写入失败：${spec}：${messageOf(error)}`);
				failed = true;
				break;
			}
			lines.push(`${isRemove ? "remove" : "add"} ${spec}：已投递端侧进程内安装队列，等待宿主结果…`);
			const outcome = await waitOutcome(queueDir, base, cancelled);
			if (outcome.kind === "cancelled") {
				lines.push(`已取消：${spec}`);
				failed = true;
				break;
			}
			if (outcome.kind === "timeout") {
				lines.push(`等待超时：${spec}（宿主可能正忙；见 $DSH_HOME/install-queue 与宿主日志）`);
				failed = true;
				break;
			}
			if (outcome.kind === "ok") {
				lines.push(describeDone(spec, outcome.payload));
				continue;
			}
			lines.push(`${isRemove ? "卸载" : "安装"}失败：${spec}：${outcome.error}`);
			failed = true;
			break;
		}
		if (failed) {
			lines.push("提示：端侧没有可用的 shell，插件包操作由宿主进程内的安装器代行；"
				+ "若反复失败，可在「设置 → 插件」里重试，或改用插件市场（同一通道）。");
		}
		return { exitCode: failed ? 1 : 0, text: `${lines.join("\n")}\n` };
	} catch (error) {
		// 契约：任何异常都收敛成 ExitCode 1，与 execa 失败同形（调用方据此抛给 UI）。
		log(`内部异常：${messageOf(error)}`);
		return { exitCode: 1, text: `端侧包通道异常：${messageOf(error)}\n` };
	}
}
