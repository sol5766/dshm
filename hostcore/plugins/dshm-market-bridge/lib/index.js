/**
 * DSHM 端侧「市场宿主桥」：给插件市场（`dshmarket`）一条**不走 spawn** 的包操作通道。
 *
 * ── 要解决什么（真机实测，报告在案）───────────────────────────────────────
 * 市场的默认运行时是 `runDshPlugin()`（`dshmarket/lib/dsh-cli.js:980`）：探针
 * `spawn("pnpm", ["--version"])`、安装 `spawn("dsh", ["plugin", …])`。手机/平板档
 * 沙箱内**一切自带可执行文件的 execve 都被系统拒绝**（`EACCES`，见 docs/104 的六条
 * 终端读数：`rg`/`ash`/`bash` 全 denied、`toybox=ok` 但 toybox 没有 sh applet），于是：
 *   · `pnpm --version` 探针必失败 ⇒ `provisionPnpm()` 退到 corepack / `npm -g`
 *     （同样是 spawn，同样失败）⇒ 用户看到「pnpm 自动配置失败」+ 在鸿蒙上根本执行
 *     不了的 `sudo npm i -g pnpm` / `brew install pnpm` 建议；
 *   · 即便探针侥幸通过，`pnpm add <spec>` 也起不来 ⇒ 市场一个插件都装不上。
 * 而 DSHM 自己的安装通道是好的：`$DSH_HOME/install-queue/<id>.req` → Host 进程内的
 * `hostcore/app/dshm-installer.js`（纯 JS 下载 + 解包 + 落位 + 用户行），**不 spawn
 * 任何东西** —— 市场插件本机就是靠它装进来的。缺的只是「市场 → 队列」这最后一小段接线。
 *
 * ── 这段接线是上游明文契约，不是我们自造的缝 ──────────────────────────────
 * `dshmarket/lib/index.js:235-271` 写着：宿主若发布 `desktopProfiles`，市场即改用
 * `hostCtx.inject(["desktopPnpm"], …)` 取一条自带包管理器的运行时
 * （`createDesktopPluginRuntime(service, current.dir)`，`dsh-cli.js:1066`），而该运行时里
 * `probePnpm()` / `provisionPnpm()` 是常量真（`:1226-1227`）—— 也就是说「pnpm 自动配置」
 * 这一步在这个契约下**根本不会发生**。上游同一处注释还规定：这两个服务必须在
 * **Loader 条目挂载之前**就已存在（原文："Desktop's supported cross-environment contract
 * guarantees that desktopProfiles exists before Loader entries mount"）⇒ 本桥的
 * `provide()` 由打包补丁注入核心树 `@deepseek-ai/dsh/lib/profile-boot-*.js` 的 boot 回调里
 * （与 `profileContext` 同一处、同一时机），**不是**作为一个 cordis 行去赌挂载顺序
 * （bundle 行在 profile patch 行之前，行序赌不赢）。
 *
 * ── 市场要的面（只有这些，其余它自己提供）─────────────────────────────────
 * `desktopPnpm` 只被要求实现 `runPlugin(argv, invokingDir, signal)`，且必须**同步返回**
 * 句柄（`dsh-cli.js:1114-1147` 拿到返回值后**立刻** `handle.stdout.on(...)`；返回 Promise
 * 会当场 TypeError）：
 *     { stdout: EventEmitter, stderr: EventEmitter,
 *       done: Promise<{ exitCode, signal }>, cancel(): void }
 * `probePnpm` / `provisionPnpm` / `cancelActive` / `supportsExactRollbackTarget` 由市场的
 * `createDesktopPluginRuntime` 自己提供，本桥**不重复实现**（契约面如实收窄）。
 * 命令面只有两个：`add <target>`（可带 `-w` / `--force` / `--config.*=` 等市场选项）、
 * `remove <name>`；其余（含恢复备份用的无目标 `install`）如实返回 127，不假装成功。
 *
 * ── 队列映射（与 `hostcore/app/main.js` 里 `bin/pnpm` 假壳同一份协议）────────
 *   add    → `<queue>/<base>.req`（一行 spec）+ `<queue>/<base>.dir`（目标 profile 目录）
 *   remove → `<queue>/<base>.rem`
 *   Host 取走后写回 `<base>.done` / `<base>.fail`（JSON），本桥读到后自行删除。
 * 选项口径与 `shimSkipOptValuesLines()` 逐条对齐：`--dir <path>` / `--profile <name>`
 * **连值一起跳过**，其余 `-*` 单跳过 —— 否则 `--dir /tmp/x` 的 `/tmp/x` 会被当成第二个
 * 包名投递（真机踩过：装出一个不存在的包）。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * · **只在随包假壳真跑不起来时才接管**：同步探一次 `bin/pnpm --version`，能跑就完全惰性
 *   ⇒ PC/2in1 档行为一个字节不变，市场照旧走已验收的假壳链路。
 *   调试覆盖：`DSHM_MARKET_BRIDGE=force` 强制接管 / `=off` 强制不接管。
 * · **不阻断启动**：`provideMarketBridge()` 全程 try/catch，任何失败只打一行日志、返回
 *   false，loader 与 web 服务链路不受影响。
 * · **不新增权限、不动用户数据**：只往 `$DSH_HOME/install-queue/` 写请求
 *   （该目录由 Host 自己 `mkdir -p`），实际安装/卸载由既有安装器执行。
 *
 * @module dshm-market-bridge
 */
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Stable Loader identity（本包不经 cordis 行挂载，保留导出只为与自带插件同形）。 */
const name = "dshm-market-bridge";

/** 日志前缀（真机核查用；与其它 dshm-* 插件同款方括号形态）。 */
const TAG = "[dshm-market-bridge]";

/** 结果轮询间隔（Host 的取件轮询是 2s，这里更密一档，只为少等一个来回）。 */
const POLL_MS = 500;

/** 单次等待的上限：比市场自己 15 分钟的超时宽一档（正常只会由市场那侧先取消）。 */
const WAIT_MAX_MS = 20 * 60 * 1000;

/** 需要「连值一起跳过」的选项（口径见文件头注）。 */
const VALUE_OPTS = ["--dir", "--profile"];

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
 * 随包 `bin/pnpm` 假壳能不能**真的**被 spawn 起来 —— 本桥唯一的启用判据。
 *
 * 用 `spawnSync` 而不是异步探针：`provide()` 必须与 boot 回调同步完成（那两个服务得在
 * Loader 条目挂载前就位），异步探针赶不上。被拒时 `status === null`、`error` 置位，
 * 几毫秒返回；能跑时就是假壳自己打印 `10.0.0 (dshm install-queue shim)` 后退出 0。
 * 假壳缺失（未布置 / 非端侧部署）同样返回 false —— 那种场合没有可用的 spawn 链路，
 * 让市场走进程内通道是更该有的默认。
 */
function shimRunnable() {
	const sandbox = String(process.env.DSHM_SANDBOX_HOME || "").trim();
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
 * 队列目录：`$DSH_HOME/install-queue`。
 *
 * `DSHM_HOME` 缺失时按 profile 目录反推（`<HOME>/profiles/<name>`）—— 这比写死
 * "ondevice" 稳：队列与 profile 永远同源，不会出现"装到别的 HOME 去了"这种查不出的错。
 */
function queueDirFor(profileDir) {
	const home = String(process.env.DSHM_HOME || "").trim();
	if (home.length > 0) {
		return join(home, "install-queue");
	}
	return join(dirname(dirname(profileDir)), "install-queue");
}

/**
 * 取「命令字之后」的目标参数（导出是为了离线门禁能直接断言这套口径）。
 *
 * 与 `shimSkipOptValuesLines()` 同一口径：`--dir`/`--profile` 连它的值一起跳过，
 * 其它 `-` 开头的（市场选项 `-w` / `--force` / `--config.minimum-release-age=0` /
 * `--reporter=ndjson`）一律单跳过，剩下的才是包名 / GitHub 地址。
 * @param args 命令字之后的原始参数
 * @returns 目标 spec 数组（保持出现顺序）
 */
function marketTargets(args) {
	const out = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
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
 *
 * `.dir` 用宿主给的 profile 目录（`profileContext.dir`，权威值），不用市场的
 * `invokingDir`（那是 `process.cwd()`，可能与 profile 无关）—— Host 侧对 `.dir`
 * 是"原样采纳"，写错就会装进别的 profile 的 node_modules（市场随后读不到 manifest）。
 * `.dir` 写失败不阻断：Host 缺 `.dir` 时回退宿主 profile，与本端目标一致。
 * @returns base（结果文件名前缀）
 */
function submit(queueDir, spec, profileDir, remove) {
	mkdirSync(queueDir, { recursive: true });
	// base 里带 pid + 序号 + 随机尾：同一 profile 并发/连发时不会互相覆盖结果文件。
	const base = `market-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
			 * 【不能 unref】这个等待本身就是"进程还要干的活"：unref 掉的定时器**不保活事件循环**，
			 * 于是"等队列结果"期间的进程会被判成无事可做 —— 离线门禁里表现为
			 * `Detected unsettled top-level await` 直接退出，真机上则是在 Host 恰好没有其它
			 * 待办时把一次安装吊死。Host 有 HTTP 服务常年保活，所以这个坑只在"看起来一切正常"
			 * 的场合才发作 —— 正是必须钉死的那类。
			 */
			setTimeout(tick, POLL_MS);
		};
		tick();
	});
}

/** 安装器的结果 JSON → 一行给人看的 stdout（市场把它当"最后一行进度"显示）。 */
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
 * `runPlugin` 的句柄（**同步**返回：市场拿到就挂监听）。
 * @param queueDir 队列目录
 * @param profileDir 目标 profile 目录
 * @param argv 市场的完整 argv（`[命令, …选项, 目标]`）
 */
function createHandle(queueDir, profileDir, argv) {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const command = typeof argv[0] === "string" ? argv[0] : "";
	let cancelled = false;
	let settled = false;
	let finish = () => {};
	const done = new Promise((resolve) => {
		finish = resolve;
	});
	const emit = (stream, text) => {
		try {
			stream.emit("data", Buffer.from(`${text}\n`, "utf8"));
		} catch (error) {
			// 监听方自己抛错不该把桥带崩（市场只读这些流，正常不会）。
			log(`输出流监听方异常：${messageOf(error)}`);
		}
	};
	const settle = (exitCode) => {
		if (settled) {
			return;
		}
		settled = true;
		// signal **必须显式 null**：市场用 `outcome.signal !== null` 判失败
		// （`dsh-cli.js:1153`），缺字段（undefined）会被当成"被信号杀死"。
		finish({ exitCode, signal: null });
	};
	const cancel = () => {
		cancelled = true;
	};
	/** 逐个目标串行投递（Host 的安装队列本身一次只装一个，串行与它同构）。 */
	const runTargets = async (targets, remove) => {
		let failed = false;
		for (const spec of targets) {
			if (cancelled) {
				emit(stderr, `已取消：${spec}`);
				failed = true;
				break;
			}
			let base = "";
			try {
				base = submit(queueDir, spec, profileDir, remove);
			} catch (error) {
				emit(stderr, `队列写入失败：${spec}：${messageOf(error)}`);
				failed = true;
				break;
			}
			emit(stdout, `${remove ? "remove" : "add"} ${spec}：已投递进程内安装队列，等待 Host 结果…`);
			const outcome = await waitOutcome(queueDir, base, () => cancelled);
			if (outcome.kind === "cancelled") {
				emit(stderr, `已取消：${spec}`);
				failed = true;
				break;
			}
			if (outcome.kind === "timeout") {
				emit(stderr, `等待结果超时：${spec}（Host 可能仍在装，可在插件页刷新查看）`);
				failed = true;
				break;
			}
			if (outcome.kind === "ok") {
				emit(stdout, describeDone(spec, outcome.payload));
				continue;
			}
			emit(stderr, `${remove ? "卸载" : "安装"}失败：${spec}：${outcome.error}`);
			failed = true;
		}
		return failed;
	};
	/*
	 * 【必须延后一个宏任务再开跑】市场拿到句柄后**同一 tick**才挂监听
	 * （`dshmarket/lib/dsh-cli.js:1146-1147` 的 `handle.stdout.on(...)`）。
	 * 若这里同步跑，拒绝面（缺目标 / 不支持的命令）的 `emit` 会发生在"还没有听众"的时刻 ⇒
	 * 用户只看到退出码，看不到原因（成功路径的首行同理会被丢掉）。
	 */
	setImmediate(() => {
	void (async () => {
		if (command === "add" || command === "install" || command === "i") {
			const targets = marketTargets(argv.slice(1));
			if (targets.length === 0) {
				if (command === "install") {
					// `install` 无目标 = "按 profile 清单把所有依赖装上"（恢复备份流程用）。
					// 本桥不做清单展开：安装器一次只吃一个 spec，且清单里的 semver range
					// （`^1.2.3`）它解析不了 —— 与其静默装成 latest（跨过用户声明的 range），
					// 不如如实拒绝（契约面如实收窄，与上游 official-desktop 的 127 同做法）。
					emit(stderr, "端侧不支持无目标的 install（本桥只做 add <target> / remove <name>）；"
						+ "恢复备份请逐个 add，或在「设置 → 插件」里操作。");
					settle(127);
					return;
				}
				emit(stderr, "未给出包名或 GitHub 地址");
				settle(1);
				return;
			}
			settle(await runTargets(targets, false) ? 1 : 0);
			return;
		}
		if (command === "remove" || command === "rm" || command === "uninstall") {
			const targets = marketTargets(argv.slice(1));
			if (targets.length === 0) {
				emit(stderr, "未给出要卸载的包名");
				settle(1);
				return;
			}
			settle(await runTargets(targets, true) ? 1 : 0);
			return;
		}
		emit(stderr, `端侧市场桥不支持该命令：${command.length > 0 ? command : "(空)"}`
			+ "（只支持 add / remove）");
		settle(127);
	})().catch((error) => {
		emit(stderr, `市场桥内部异常：${messageOf(error)}`);
		settle(1);
	});
	});
	return { stdout, stderr, done, cancel };
}

/** 组装 `desktopPnpm`（市场只需要 `runPlugin`，其余它自己提供）。 */
function createDesktopPnpm(queueDir, profileDir) {
	return {
		runPlugin(argv, _invokingDir, signal) {
			const args = Array.isArray(argv) ? argv.filter((a) => typeof a === "string") : [];
			const handle = createHandle(queueDir, profileDir, args);
			// 市场的 AbortSignal（超时/取消）与句柄的 cancel 是两条路，都接上。
			if (signal && typeof signal.addEventListener === "function") {
				if (signal.aborted) {
					handle.cancel();
				} else {
					signal.addEventListener("abort", () => handle.cancel(), { once: true });
				}
			}
			return handle;
		},
	};
}

/**
 * 注入点（由 `tools/pack-core.mjs` 的 profile-boot 补丁在 boot 回调里调用）。
 *
 * @param hostCtx cordis 宿主上下文（与 `profileContext` 同源的那个）
 * @param profileContext 核心树构造的 profile 上下文（取 `name` / `dir`）
 * @returns 是否真的接管了（真机核查用；false 表示市场仍走假壳/CLI 链路）
 */
function provideMarketBridge(hostCtx, profileContext) {
	try {
		const mode = String(process.env.DSHM_MARKET_BRIDGE || "").trim().toLowerCase();
		if (mode === "off") {
			log("已按 DSHM_MARKET_BRIDGE=off 关闭（市场走假壳链路）");
			return false;
		}
		const forced = mode === "force";
		if (!forced && shimRunnable()) {
			log("随包 bin/pnpm 假壳可执行 ⇒ 不接管（市场走已验收的假壳链路）");
			return false;
		}
		const profileName = profileContext && typeof profileContext.name === "string"
			? profileContext.name.trim()
			: "";
		const profileDir = profileContext && typeof profileContext.dir === "string"
			? profileContext.dir.trim()
			: "";
		if (profileName.length === 0 || profileDir.length === 0) {
			log("profileContext 缺 name/dir ⇒ 不接管（市场退回 CLI 链路）");
			return false;
		}
		const queueDir = queueDirFor(profileDir);
		hostCtx.provide("desktopProfiles", { current: { name: profileName, dir: profileDir } });
		hostCtx.provide("desktopPnpm", createDesktopPnpm(queueDir, profileDir));
		log(`已接管市场包操作：profile=${profileName}，队列=${queueDir}`
			+ `（原因：${forced ? "DSHM_MARKET_BRIDGE=force" : "随包假壳无法 spawn"}）`);
		return true;
	} catch (error) {
		log(`未挂载（不影响启动）：${messageOf(error)}`);
		return false;
	}
}

export { marketTargets, name, provideMarketBridge };
