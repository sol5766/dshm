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
 * · 启用判据：同步探一次随包 `bin/pnpm --version`（`shimRunnable()`）。能跑 ⇒ 本桥
 *   **完全惰性**（返回 undefined，调用方照旧 spawn）⇒ PC/2in1 档行为一个字节不变。
 *   调试覆盖：`DSHM_PROFILE_PNPM_BRIDGE=force` 强制接管 / `=off` 强制不接管。
 * · 投递协议与 `bin/pnpm` 假壳、`@deepseek-ai/dshm-market-bridge` 同一份：
 *     add    → `<queue>/<base>.req`（一行 spec）+ `<base>.dir`（目标 profile 目录）
 *     remove → `<queue>/<base>.rem`
 *   Host 取走后写回 `<base>.done` / `<base>.fail`（JSON），本桥读到即自行删除。
 *   取值口径同样含 `--dir`/`--profile` **连值跳过**（否则 `--dir /x` 的 `/x` 会被当成
 *   第二个包名投递 —— 市场侧真机踩过；这里是同一段逻辑的第二处使用）。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * · **只接管 add/install/i 与 remove/rm/uninstall**：其余子命令（view/config/list…）
 *   返回 undefined，仍走 spawn —— 与其假装成功，不如如实沿用原有失败形态。
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
		const mode = String(process.env.DSHM_PROFILE_PNPM_BRIDGE || "").trim().toLowerCase();
		if (mode === "off") {
			return undefined;
		}
		const argv = (Array.isArray(args) ? args : []).filter((a) => typeof a === "string");
		const command = typeof argv[0] === "string" ? argv[0] : "";
		const isRemove = REMOVE_COMMANDS.includes(command);
		const isAdd = ADD_COMMANDS.includes(command);
		if (!isRemove && !isAdd) {
			return undefined;
		}
		if (mode !== "force" && shimRunnable()) {
			// 假壳能跑 ⇒ 完全惰性（PC/2in1 档走已验收的 spawn 链路）。
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