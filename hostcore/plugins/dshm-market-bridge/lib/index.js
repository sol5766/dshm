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
 *   add    → `<queue>/<base>.req`（一行 spec）+ `<queue>/<base>.dir`（目标目录：argv 的
 *   `--dir` 取值，缺省为宿主 profile 目录；见 `targetDirFromArgv()`）
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
 * · **不新增权限；用户数据只读**：只往 `$DSH_HOME/install-queue/` 写请求
 *   （该目录由 Host 自己 `mkdir -p`），实际安装/卸载由既有安装器执行。
 *   **唯一的例外**：`patchMarketCliBranch()` 会给**已安装的 `dsh-skin-market`** 就地改写
 *   desktop 分支的挂载调用（幂等、锚点唯一才写、失败一个字节都不写），理由见该函数头注 ——
 *   那条分支把宿主当「官方 Desktop」，只认 41/302 条 `install.desktop.mode==='managed'` 的皮肤；
 *   而端侧的进程内安装器执行的是**完整的 pnpm 装卸契约**（npm `name@version` 与 GitHub
 *   `github:o/r#sha[&path:/sub]` 都吃）⇒ 该按市场的 **CLI 契约**（`hostKind:'dsh'`，界面判定
 *   随之换成 `review.installation`）挂载，251/302 条皮肤才有一键安装（2026-10-09 真机复现，见 docs/129）。
 * · **重启能力用树里**已有的** `appExit`**：端侧 profile-boot 自己就会
 *   `provideCmdline(hostCtx, {…})` ⇒ `ctx.provide("appExit", host.exit)`（上游语义：由启动器
 *   在树挂载前提供）。**我们绝不能再 provide 一遍** —— cordis 的 `provide` 撞名会抛
 *   `service "appExit" has been registered at <root>`，而它发生在 boot 回调**期间** ⇒
 *   整个 Host 起不来（2026-10-09 真机 100% 复现：`dsh: host preparation failed`）。因此本桥
 *   只补市场 desktop 分支**缺的那一跳**（读已有的 appExit + 建 scheduler）；市场那边的
 *   `restart.schedule()` 仍是 `spawn(process.execPath, ['-e', …])`，由宿主既有的 execPath
 *   兜底转成整机冷启动（写 `host-exit-mode=app-restart` 后关闭）。见 docs/128。
 *
 * @module dshm-market-bridge
 */
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

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
 * 这次要落位到哪个目录 —— 与 `bin/pnpm` 假壳的 `shimDirResolveLines()` 同优先级：
 * argv 的 `--dir`（两种写法）> 宿主 profile 目录。
 *
 * 【为什么必须有这一条】市场的 CLI 链路 `prefetch()` 发的就是
 * `add <target> --dir <临时目录> --ignore-scripts --config.auto-install-peers=false` ——
 * 先在**没被监视的临时项目**里解析/下载（`mkdtempSync(tmpdir(), 'dsh-skin-market-download-')`），
 * 校验通过后才落到真 profile。只认 profileDir 的话预取会直接装进 live profile，而临时目录是
 * 空的 ⇒ 市场读不到 manifest（`installed package manifest missing`），同时包/依赖/插件行全部
 * 泄漏进 profile —— 与 `bin/pnpm` 假壳踩过的「报告 7 §1a」是同一个坑。
 *
 * 相对路径按 profileDir 解析（假壳是把 `--dir` 原样写进 `.dir` 的；这里多做一档更安全的归一，
 * 市场自己传的都是绝对路径，相对路径只可能来自手写的调试调用）。
 * @param argv 市场的完整 argv（`[命令, …选项, 目标]`）
 * @param profileDir 宿主 profile 目录（缺 `--dir` 时的目标）
 * @returns 目标目录
 */
function targetDirFromArgv(argv, profileDir) {
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const value = arg === "--dir"
			? (typeof argv[i + 1] === "string" ? argv[i + 1] : "")
			: (arg.startsWith("--dir=") ? arg.slice("--dir=".length) : null);
		if (value === null) {
			continue;
		}
		if (value.length === 0 || value === "/") {
			return profileDir;
		}
		return isAbsolute(value) ? value : resolve(profileDir, value);
	}
	return profileDir;
}

/**
 * 投递一条请求：`.req`（装）/ `.rem`（卸）一行 spec，另写 `.dir` 指明目标目录。
 *
 * `.dir` 用 `targetDirFromArgv()` 定出的目标目录（argv 的 `--dir` 优先，缺省为宿主
 * `profileContext.dir`），**不用**市场的 `invokingDir`（那是 `process.cwd()`，可能与
 * profile 无关）—— Host 侧对 `.dir` 是"原样采纳"，写错就会装进别的 profile 的
 * node_modules（市场随后读不到 manifest）。
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
 * @param profileDir 缺 `--dir` 时的目标目录（宿主 profile）
 * @param argv 市场的完整 argv（`[命令, …选项, 目标]`）
 */
function createHandle(queueDir, profileDir, argv) {
	/*
	 * 【落位目录：argv 的 `--dir` 优先】见 `targetDirFromArgv()` 的头注 —— 市场的 `prefetch()`
	 * 用 `--dir <临时目录>` 做隔离预取；只认 profileDir 会把包装进 live profile 而临时目录留空。
	 */
	const dir = targetDirFromArgv(argv, profileDir);
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
				base = submit(queueDir, spec, dir, remove);
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

/** 把市场的 AbortSignal（超时/取消）接到句柄的 cancel 上。 */
function attachAbort(handle, signal) {
	if (signal && typeof signal.addEventListener === "function") {
		if (signal.aborted) {
			handle.cancel();
		} else {
			signal.addEventListener("abort", () => handle.cancel(), { once: true });
		}
	}
	return handle;
}

/**
 * 组装 `desktopPnpm`。【市场要的两条路都在，缺一条就有一整类操作当场失败】市场对桌面宿主有两条入口：
 *   · `runPlugin(argv, invokingDir, signal)` —— 装卸/启停走的通用 pnpm argv 通道；
 *   · `installPlugin(request, options)` —— **皮肤市场「一键安装」专用的托管安装**入口
 *     （`desktopRunner` 的 `runner.installPlugin`，见市场 `lib/commands.js:451`）。
 *
 * 【2026-10-09 真机实证：只实现第一条的后果】皮肤市场点「安装」**立刻**失败，
 * `GET /dsh-skin-market/operations/<id>` 原文：
 *     `{"phase":"failed","message":"service.installPlugin is not a function","step":"安装到 profile"}`
 * ⇒ 42 条 npm 托管皮肤（`install.desktop.mode==='managed'`）**一条都装不上**。
 *
 * 【request 长什么样】`{pnpmOptions, invokingDir, recovery:{packageName,packageVersion,receiptId}, signal}`。
 * 市场在这一跳之前已经核过 `capability.packageName/packageVersion === skin.package/install.version`
 * （`lifecycle.js:768`）⇒ 这里只落一条 `add <name>@<version>`。落进 profile 的依赖值会是
 * `<version>`（**不带 `^`**）—— 正是市场 `exactNpmSpecMatches()`（`profile.js:173`）认的三种
 * 形态之一（`spec === version`），否则装完会被判成"来源不符"再抛一次。
 * `recovery.receiptId` 是**上游 Desktop 自己的**回执编号（它用来自查/回滚），本桥的队列通道
 * 没有这条台账 ⇒ **故意忽略**：装了就是装了，失败由 `.fail` 如实回报。
 */
function createDesktopPnpm(queueDir, profileDir) {
	return {
		runPlugin(argv, _invokingDir, signal) {
			const args = Array.isArray(argv) ? argv.filter((a) => typeof a === "string") : [];
			return attachAbort(createHandle(queueDir, profileDir, args), signal);
		},
		installPlugin(request, options) {
			const raw = request && typeof request === "object" ? request : {};
			// 【request 的**真实**形状（真机 2026-10-09 第二次复测钉住）】市场 `desktopRunner`
			// 把包名塞在 **`recovery`** 里，不是顶层 —— `commands.js:454`：
			//     service.installPlugin({ pnpmOptions, invokingDir, recovery:
			//       { packageName, packageVersion, receiptId }, signal })
			// 顶层那对 `packageName/packageVersion` 是**官方 Electron runner** 的形状
			// （`official-desktop.js:145` 的 `request.packageName`），本档走不到。
			// 只读顶层时的现场：`argv` 退化成裸 `add` ⇒ 市场侧
			// `{"phase":"failed","step":"安装到 profile","message":"未给出包名或 GitHub 地址"}`，
			// 与"没实现 installPlugin"长得一样但根因不同 ⇒ 两种形状都认，recovery 优先。
			const recovery = raw.recovery && typeof raw.recovery === "object" ? raw.recovery : {};
			const pick = (first, second) => {
				if (typeof first === "string" && first.trim().length > 0) return first.trim();
				return typeof second === "string" ? second.trim() : "";
			};
			const name = pick(recovery.packageName, raw.packageName);
			const version = pick(recovery.packageVersion, raw.packageVersion);
			// 市场的 pnpmOptions（`--prefer-offline` / `--reporter=ndjson`）跟着 argv 走：
			// createHandle → marketTargets 会把 `-` 开头的整段滤掉，**不会**混进 .req 的 spec 行
			// （那一行必须是裸 spec，安装器按 spec 解析）。
			const extra = Array.isArray(raw.pnpmOptions) ? raw.pnpmOptions.filter((a) => typeof a === "string") : [];
			// 缺包名/版本时不另外编错误文案：交给 createHandle 既有的拒绝面（与 runPlugin 同一口径），
			// 市场拿到的是同一条 stdout/stderr + 非 0 退出码。
			const spec = name.length === 0 ? "" : (version.length > 0 ? `${name}@${version}` : name);
			const argv = spec.length === 0 ? ["add"] : ["add", spec, ...extra];
			// 取消信号：市场把它放在 request.signal（`desktopRunner`），也接受 options.signal
			// （`runDesktopOperation` 交下来的那个合并信号）—— 两条都接，谁的先到谁生效。
			const signal = raw.signal ?? (options && typeof options === "object" ? options.signal : undefined);
			return attachAbort(createHandle(queueDir, profileDir, argv), signal);
		},
	};
}

/** 就地补丁的标记：写了它即视为「本文件已按 DSHM 的目标形态改过」（幂等判据，见 patchMarketCliBranch）。 */
const PATCH_MARKER = "/* dshm-market-bridge: cli-branch */";

/** 上一代补丁（只补 restart、仍把宿主当官方 Desktop）的标记：见到它就**就地升级**，不叠加。 */
const LEGACY_PATCH_MARKER = "/* dshm-market-bridge: desktop-restart */";

/**
 * 上一代补丁插入的整段（标记 + 随后的两行）。
 *
 * 【为什么必须逐字认得它】旧补丁插的 `const appExit` 与新补丁插的**同名、同作用域**；若只按锚点
 * 追加，一处 `const` 会变成两处 ⇒ 重复声明 ⇒ **语法错 ⇒ 整个市场插件挂不起来**（比原缺陷更糟）。
 * 所以「认得旧形态」不是兼容分支，而是**升级路径**：摘掉旧的，写上新形态。
 */
const LEGACY_PATCH_BLOCK = "            " + LEGACY_PATCH_MARKER
	+ " const appExit = readService('appExit');\n"
	+ "            const restart = appExit === undefined ? undefined : createCliRestartScheduler(appExit);\n";

/** 收窄官方 Desktop 判据那一处改写的标记（幂等判据，见 patchMarketCliBranch）。 */
const OFFICIAL_DESKTOP_MARKER = "/* dshm-market-bridge: official-desktop-off */";

/**
 * 上游 `officialDesktop` 判据的**逐字原形**（三子句，8 / 12 空格缩进 —— 缩进属于上游源码，
 * 不是本文件的风格，必须逐字节对齐才能命中）。
 *
 * 第三个子句 `desktopProfiles === undefined && pluginManager !== undefined` 是给「没有
 * profileContext 的官方 Electron Desktop」兜底的：它没有 `desktopProfiles`（那是本桥的
 * 概念），但核心树一定会 provide `pluginManager`。可它在**端侧恒真** —— 端侧 `pluginManager`
 * 由核心树提供，而 PC/2in1 档本桥**不** provide `desktopProfiles`（假壳能 spawn ⇒ 走已验收的
 * 假壳链路）⇒ 市场被误判成官方 Desktop，落到 `hostKind:'desktop'`，界面只认
 * `install.desktop.mode==='managed'` 的那 41 条（目录 302 条里其余一律「需手动安装」）。
 * 删掉它之后，端侧自然落到上游**本就写好**的 CLI 分支（`hostKind:'dsh'` + `restart`，
 * 判定换成 `review.installation`，251 条皮肤立刻可一键安装）。
 *
 * 语音语义不破：真官方 Desktop 命中的是前两个子句（`config.profile==='desktop'`，或
 * 未配 profile 而 profileContext.name / `--profile` 就是 'desktop'）。
 */
const OFFICIAL_DESKTOP_UPSTREAM = "        const officialDesktop = configuredProfile?.toLowerCase() === 'desktop'\n"
	+ "            || (configuredProfile === undefined && launchedProfile?.toLowerCase() === 'desktop')\n"
	+ "            || (desktopProfiles === undefined && pluginManager !== undefined);\n";

/** 目标形态：同形，只删掉第三子句并打上标记。 */
const OFFICIAL_DESKTOP_TARGET = "        " + OFFICIAL_DESKTOP_MARKER
	+ " const officialDesktop = configuredProfile?.toLowerCase() === 'desktop'\n"
	+ "            || (configuredProfile === undefined && launchedProfile?.toLowerCase() === 'desktop');\n";

/**
 * desktop 分支那一行 `desktopHost.effect(() => mountRoutes(…`。
 *
 * `hostKind` 与尾部 `restart` 都写成可选项：上游原形（`hostKind: 'desktop'`、无 restart）与上一代
 * 补丁形态（`hostKind: 'desktop'`、有 restart）都能命中 ⇒「首次改写」与「原地升级」共用同一段逻辑。
 * 命中数必须恰好 1（见判据）⇒ 上游改形、或文件里出现第二份副本时**一个字节都不写**。
 */
const DESKTOP_EFFECT_RE = /^ {12}desktopHost\.effect\(\(\) => mountRoutes\(host, \{ profile: current\.name, profileDir: current\.dir, runner: desktopRunner\(service, current\.dir\), hostKind: '(?:desktop|dsh)', runtime: detectDshRuntime\(\), agents(?:, restart)? \}\), 'dsh-skin-market: desktop routes'\);\n/m;

/** 目标形态那一行：与上游**同形**，只把 `hostKind` 换成 `'dsh'`、尾部补上 `restart`。 */
const DESKTOP_EFFECT_TARGET = "            desktopHost.effect(() => mountRoutes(host, { profile: current.name, profileDir: current.dir, runner: desktopRunner(service, current.dir), hostKind: 'dsh', runtime: detectDshRuntime(), agents, restart }), 'dsh-skin-market: desktop routes');\n";

/** `dshmarket` 预览图代理补丁的标记（幂等判据，见 patchDshmarketThumbs）。 */
const SHOT_PROXY_MARKER = "/* dshm-market-bridge: shot-proxy */";

/**
 * `dshmarket/client/client.js` 里缩略图那段**逐字节原文**。
 *
 * 【tab 缩进是上游产物的形态，不是本文件的风格】那个文件是 tsdown 打包出来的，缩进全是
 * tab；这两个常量的缩进必须与产物逐字节对齐才能命中（对齐方式抄的是 `OFFICIAL_DESKTOP_UPSTREAM`
 * 那一处的先例）。真机取回的那份 sha256 = `3b6dd4f8c1094894edb0199091658502f101fbe45dfec37be36284b964898ac8`。
 */
const DSHMARKET_THUMB_UPSTREAM = "\t\tfunction thumbUrl(src, height) {\n"
	+ "\t\t\treturn `https://images.weserv.nl/?url=${encodeURIComponent(src.replace(/^https?:\\/\\//, \"\"))}&h=${String(height)}&fit=inside&we=1`;\n"
	+ "\t\t}\n";

/**
 * 目标形态：把出网那一跳换成**宿主**的本地代理（`/dshm-shot`，见 main.js 的
 * `registerShotProxyEndpoint()`），并在紧挨着 `thumbUrl` 的上一行定义共用的 `shotProxyUrl`。
 *
 * 【为什么不写成一行 inline】灯箱那张原图也要走同一个口（见 DSHMARKET_LIGHTBOX_*），
 * 两处共用一个函数才不会各写各的 URL 形态。`h` 只在**给了**的时候才拼上去：缩略图会给
 * （200/240/300/520），灯箱不给 —— 与上游两个调用点的差别逐条对应。
 */
const DSHMARKET_THUMB_TARGET = "\t\t" + SHOT_PROXY_MARKER + "\n"
	+ "\t\tfunction shotProxyUrl(src, height) {\n"
	+ "\t\t\tconst base = `/dshm-shot?url=${encodeURIComponent(String(src))}`;\n"
	+ "\t\t\treturn height === undefined ? base : `${base}&h=${String(height)}`;\n"
	+ "\t\t}\n"
	+ "\t\tfunction thumbUrl(src, height) {\n"
	+ "\t\t\treturn shotProxyUrl(src, height);\n"
	+ "\t\t}\n";

/** 灯箱那张原图的 `src` 行（上游直连图床，命中数必须恰好 1）。 */
const DSHMARKET_LIGHTBOX_UPSTREAM = "\t\t\t\t\t\tsrc: shots[index],\n";
/** 灯箱目标形态：同一张图改走宿主代理。 */
const DSHMARKET_LIGHTBOX_TARGET = "\t\t\t\t\t\tsrc: shotProxyUrl(shots[index]),\n";

/** 数一个子串出现几次（判据要用「恰好 1 次」，不能只判 includes）。 */
function countOccurrences(haystack, needle) {
	let n = 0;
	let at = haystack.indexOf(needle);
	while (at !== -1) {
		n += 1;
		at = haystack.indexOf(needle, at + needle.length);
	}
	return n;
}

/**
 * 给已安装的 `dsh-skin-market` **就地**改写两处（官方 Desktop 判据 + desktop 分支挂载调用），
 * 让端侧按市场的 **CLI 契约**挂载。
 *
 * 【改什么（两处）】
 *
 * ㈠ **官方 Desktop 判据**：上游 `const officialDesktop = …` 的第三子句
 *     `|| (desktopProfiles === undefined && pluginManager !== undefined)` 在端侧恒真 ⇒ 删掉它
 *     （并在原处打上 `OFFICIAL_DESKTOP_MARKER`）。这是**本缺陷的真正根因**：PC/2in1 档本桥
 *     不 provide `desktopProfiles`，而 `pluginManager` 由核心树提供 ⇒ 市场被判成官方 Desktop ⇒
 *     皮肤大半「需手动安装」。删掉后自然落到上游**本就写好**的 CLI 分支（`hostKind:'dsh'` +
 *     `restart`，判定换成 `review.installation`）。详见 `OFFICIAL_DESKTOP_UPSTREAM` 的注释。
 *
 * ㈡ 上游 `lib/index.js` 的 desktop 分支
 *     runner: desktopRunner(service, current.dir), hostKind: 'desktop', runtime: detectDshRuntime(), agents })
 * 改成
 *     runner: desktopRunner(service, current.dir), hostKind: 'dsh', runtime: detectDshRuntime(), agents, restart })
 * 即 `hostKind` 由 `'desktop'` → `'dsh'`，并按 CLI 分支同款补上 `restart`（`readService('appExit')`
 * + `createCliRestartScheduler`，与上游 CLI 分支逐字同形）。
 *
 * 【为什么必须补上游的源码（两个独立缺陷，同一处修）】
 *
 * ① **「皮肤市场里大半皮肤只能手动安装」**（2026-10-09 真机复现）。市场的判定公式只有一处
 *    （`client/client.js` 的 `isManualOnly`）且只看 `hostKind`：
 *        hostKind === 'desktop' ? skin.install.desktop?.mode !== 'managed'
 *                                : skin.review?.installation === 'manual-only'
 *    端侧我们发布 `desktopProfiles`/`desktopPnpm` ⇒ 走 `hostContext.inject(['desktopPnpm'], …)`
 *    那条 **desktop 分支** ⇒ `hostKind='desktop'` ⇒ 只认 `install.desktop.mode==='managed'` 的
 *    **41 条**（目录实测：302 条里 247 条 `manual-only`、14 条无 `install.desktop`），其余一律
 *    「需手动安装」—— 而它们的 `review.installation` 是 `verified`（251 条）。
 *    端侧的进程内安装器**执行的是 pnpm 的装卸契约**（不是只有 npm 托管那一半）：`add <spec>`
 *    既吃 npm `name@version`，也吃 GitHub `github:o/r#sha[&path:/sub]`（`hostcore/app/dshm-installer.js`）；
 *    `prefetch()` 的 `--dir <临时目录>` 预取也照做（见 `targetDirFromArgv()`）。⇒ 端侧该按 **CLI 契约**
 *    挂载：`hostKind='dsh'` 时判定换成 `review.installation`，251 条皮肤立刻有一键安装。
 *
 * ② **重启能力**（上一代补丁修的同一处）。市场拿重启能力只有一个来源 —— CLI 分支里的
 *    `readService('appExit')` + `createCliRestartScheduler`；desktop 分支上游**没传** `restart`
 *    ⇒ `GET /dsh-skin-market/state` 恒报 `restartAvailable:false` ⇒ 客户端 `openRestartConfirm()`
 *    当场 `setError('请从官方 Desktop 重启应用后生效')` ⇒ 用户点了「使用」也永远用不上皮肤。
 *    （改成 `hostKind='dsh'` 后仍要**显式**补上：`restart` 是 mountRoutes 的独立入参，不是由
 *    `hostKind` 推出来的。）真机上 `restart.schedule()` 仍是 `spawn(process.execPath, ['-e', …])`，
 *    由宿主既有的 execPath 兜底转成整机冷启动（写 `host-exit-mode=app-restart` 后关闭）。见 docs/128。
 *
 * 【为什么不改市场目录（catalog）】`manual-only` 的 247 条里，`npm-package-not-found` 说的是
 * 「**Desktop 的托管安装**找不到已核验的 npm 制品」—— 那是上游审核的真话；改目录等于替市场改口。
 * 这里换的是**宿主形态**：端侧确实没有 Desktop 那套 npm 托管器，但有一条能跑 pnpm 装卸契约的
 * 进程内通道，判定随之落到市场自己的 CLI 分支上 —— 用的是上游明文契约，不是自造的缝。
 *
 * 【判据（全中才写；任何一条不中 ⇒ 一个字节都不写）】
 *   ① 文件在 `<profileDir>/node_modules/dsh-skin-market/lib/index.js`（读不到 = 没装 ⇒ 跳过）；
 *   ② 改写一：`officialDesktop` 判据要么是上游三子句（恰好 1 处，⇒ 改写），要么是目标形态
 *      （恰好 1 处，⇒ 跳过）；两者皆不中 / 命中数不为 1 ⇒ 一个字节都不写；
 *   ③ 改写二：锚点 `const desktopHost = desktopContext;` 恰好命中 1 次；
 *   ④ 紧随其后那一行 `desktopHost.effect(…` 恰好命中 1 次，且它**紧贴**锚点（或只隔着上一代补丁
 *      的整段 `LEGACY_PATCH_BLOCK`）—— 中间出现任何别的东西 ⇒ 不猜着改；
 *   ⑤ 写盘只发生一次（两处改写都先在内存里算完，再一次性 writeFileSync）。
 * 幂等：目标形态（`OFFICIAL_DESKTOP_MARKER` + `PATCH_MARKER` + `hostKind: 'dsh'`）下重算结果与
 * 原文逐字节相同 ⇒ 不写盘。
 * 两处改写**相互独立**（设备上可能只差其中一处，例如刚装好市场但还没跑过新版桥）⇒ 谁该改就改谁，
 * `reason` 逐项拼出来。
 * @returns {{ ok: boolean, reason: string }} reason 是给人读的形态（进宿主日志）
 */
function patchMarketCliBranch(profileDir) {
	const file = join(profileDir, "node_modules", "dsh-skin-market", "lib", "index.js");
	let source;
	try {
		source = readFileSync(file, "utf8");
	} catch (error) {
		return { ok: false, reason: `未安装（${messageOf(error)}）` };
	}
	// ── 判据一：官方 Desktop 判据的形状（上游三子句 ↔ 目标形态两子句 + 标记）
	const officialUpstream = countOccurrences(source, OFFICIAL_DESKTOP_UPSTREAM);
	const officialTarget = countOccurrences(source, OFFICIAL_DESKTOP_TARGET);
	let officialState;
	if (officialUpstream === 1 && officialTarget === 0) {
		officialState = "upstream";
	} else if (officialUpstream === 0 && officialTarget === 1) {
		officialState = "target";
	} else {
		return {
			ok: false,
			reason: "上游形状变了（officialDesktop 判据没唯一命中：三子句 "
				+ `${officialUpstream} 处、目标形态 ${officialTarget} 处）⇒ 不改`,
		};
	}
	// ── 判据二：desktop 分支的挂载调用（锚点 `desktopHost` + 紧随其后的 mountRoutes 行）
	const head = "            const desktopHost = desktopContext;\n";
	if (countOccurrences(source, head) !== 1) {
		return { ok: false, reason: "上游形状变了（desktopHost 锚点没唯一命中）⇒ 不改" };
	}
	// 两处改写先在内存里算完，最后**只写盘一次**（判据 ④）。
	let next = source;
	if (officialState === "upstream") {
		const at = next.indexOf(OFFICIAL_DESKTOP_UPSTREAM);
		next = next.slice(0, at) + OFFICIAL_DESKTOP_TARGET + next.slice(at + OFFICIAL_DESKTOP_UPSTREAM.length);
	}
	const headAt = next.indexOf(head);
	const canonical = head
		+ "            " + PATCH_MARKER + " const appExit = readService('appExit');\n"
		+ "            const restart = appExit === undefined ? undefined : createCliRestartScheduler(appExit);\n"
		+ DESKTOP_EFFECT_TARGET;
	let desktopState = "target";
	if (!next.startsWith(canonical, headAt)) {
		const tail = next.slice(headAt + head.length);
		const match = DESKTOP_EFFECT_RE.exec(tail);
		if (match === null || countOccurrences(tail, match[0]) !== 1) {
			return { ok: false, reason: "上游形状变了（desktop 分支的 mountRoutes 行没唯一命中）⇒ 不改" };
		}
		const between = tail.slice(0, match.index);
		if (between !== "" && between !== LEGACY_PATCH_BLOCK) {
			return { ok: false, reason: "desktopHost 锚点与 mountRoutes 行之间不是已知形态 ⇒ 不改" };
		}
		desktopState = between === LEGACY_PATCH_BLOCK ? "upgraded" : "rewritten";
		next = next.slice(0, headAt) + canonical + tail.slice(match.index + match[0].length);
	}
	if (next === source) {
		return { ok: true, reason: "已是目标形态（跳过）" };
	}
	try {
		writeFileSync(file, next, "utf8");
	} catch (error) {
		return { ok: false, reason: `写失败（${messageOf(error)}）` };
	}
	const reasons = [];
	if (officialState === "upstream") {
		reasons.push("官方 Desktop 判据收窄（三子句 → 两子句）");
	}
	if (desktopState === "upgraded") {
		reasons.push("已从上一代补丁升级（hostKind 'dsh' + restart）");
	} else if (desktopState === "rewritten") {
		reasons.push("已按 CLI 契约改写（hostKind 'dsh' + restart）");
	}
	return { ok: true, reason: reasons.join("；") };
}

/**
 * 给已安装的 `dshmarket`（**插件市场**）就地改写两处，把预览图的出网搬回宿主。
 *
 * 【缺陷（2026-10-14 真机）】插件市场的预览图两条路都是**浏览器直连图床**：卡片缩略图走
 * `https://images.weserv.nl/?url=…`（上游用它做服务端缩放），灯箱直接 `src: shots[index]`。
 * 端侧 WebView 里这两类主机都连不上（真机实测 TLS 失败）⇒ 卡片一片空白、灯箱打不开。
 * 而**宿主进程**里同一批 URL 1.15–3s 就能拿到 ⇒ 改走宿主的 `/dshm-shot`（本地 http，同源）。
 *
 * 【改什么（两处，相互独立，谁该改就改谁）】
 *   ㈠ `function thumbUrl(src, height)`：`images.weserv.nl` 那行换成 `shotProxyUrl(src, height)`，
 *      并把 `shotProxyUrl` 定义在**紧挨着它的上一行**（同一作用域 —— 上游 `thumbUrl` 本身就被
 *      卡片/对话框/多张调用点共用，插在它旁边就落在同一个作用域里）。
 *   ㈡ 灯箱的 `src: shots[index],` → `src: shotProxyUrl(shots[index]),`（灯箱是"看大图"，此前
 *      直连原图，端侧同样是空白）。开关与白名单都在宿主那侧（main.js），这里只换地址。
 *
 * 【判据（每处各自「上游形态 / 目标形态」二选一）】
 *   ① 文件在 `<profileDir>/node_modules/dshmarket/client/client.js`（读不到 = 没装 ⇒ 跳过）；
 *   ② 每处的上游形态与目标形态命中数必须是 (1,0) / (0,1)，其它情况（上游改形、文件里出现
 *      第二份副本）⇒ **一个字节都不写**，只回一行 reason；
 *   ③ 写盘只发生一次：两处先在内存里算完，再一次性 `writeFileSync`。
 * 幂等：目标形态下重算结果与原文逐字节相同 ⇒ 不写盘（每次冷启动都会跑一遍）。
 *
 * 【为什么不改 client.js.map】那是 sourcemap，只在开发者工具里用、真机执行不读它；改它
 * 反而会让 map 与实际产物对不上。宁可让 map 落后，也不写一份自造的假 map。
 *
 * @returns {{ ok: boolean, reason: string }} reason 是给人读的形态（进宿主日志）
 */
function patchDshmarketThumbs(profileDir) {
	const file = join(profileDir, "node_modules", "dshmarket", "client", "client.js");
	let source;
	try {
		source = readFileSync(file, "utf8");
	} catch (error) {
		return { ok: false, reason: `未安装（${messageOf(error)}）` };
	}
	// ── 判据 ㈠：thumbUrl 那段
	const thumbUpstream = countOccurrences(source, DSHMARKET_THUMB_UPSTREAM);
	const thumbTarget = countOccurrences(source, DSHMARKET_THUMB_TARGET);
	let thumbState;
	if (thumbUpstream === 1 && thumbTarget === 0) {
		thumbState = "upstream";
	} else if (thumbUpstream === 0 && thumbTarget === 1) {
		thumbState = "target";
	} else {
		return {
			ok: false,
			reason: "上游形状变了（thumbUrl 没唯一命中：上游 "
				+ `${thumbUpstream} 处、目标形态 ${thumbTarget} 处）⇒ 不改`,
		};
	}
	// ── 判据 ㈡：灯箱那张原图（同一份文件里的第二处，各自独立判定）
	const boxUpstream = countOccurrences(source, DSHMARKET_LIGHTBOX_UPSTREAM);
	const boxTarget = countOccurrences(source, DSHMARKET_LIGHTBOX_TARGET);
	let boxState;
	if (boxUpstream === 1 && boxTarget === 0) {
		boxState = "upstream";
	} else if (boxUpstream === 0 && boxTarget === 1) {
		boxState = "target";
	} else {
		return {
			ok: false,
			reason: "上游形状变了（灯箱 shots[index] 没唯一命中：上游 "
				+ `${boxUpstream} 处、目标形态 ${boxTarget} 处）⇒ 不改`,
		};
	}
	if (thumbState === "target" && boxState === "target") {
		return { ok: true, reason: "已是目标形态（跳过）" };
	}
	// 两处改写先在内存里算完，最后**只写盘一次**（判据 ③）。
	let next = source;
	if (thumbState === "upstream") {
		const at = next.indexOf(DSHMARKET_THUMB_UPSTREAM);
		next = next.slice(0, at) + DSHMARKET_THUMB_TARGET
			+ next.slice(at + DSHMARKET_THUMB_UPSTREAM.length);
	}
	if (boxState === "upstream") {
		const at = next.indexOf(DSHMARKET_LIGHTBOX_UPSTREAM);
		next = next.slice(0, at) + DSHMARKET_LIGHTBOX_TARGET
			+ next.slice(at + DSHMARKET_LIGHTBOX_UPSTREAM.length);
	}
	try {
		writeFileSync(file, next, "utf8");
	} catch (error) {
		return { ok: false, reason: `写失败（${messageOf(error)}）` };
	}
	const reasons = [];
	if (thumbState === "upstream") {
		reasons.push("缩略图出网改为宿主代理（/dshm-shot）");
	}
	if (boxState === "upstream") {
		reasons.push("灯箱原图改为宿主代理（/dshm-shot）");
	}
	return { ok: true, reason: reasons.join("；") };
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
		const profileName = profileContext && typeof profileContext.name === "string"
			? profileContext.name.trim()
			: "";
		const profileDir = profileContext && typeof profileContext.dir === "string"
			? profileContext.dir.trim()
			: "";
		if (!forced && shimRunnable()) {
			// **只贴补丁、不接管**：假壳能 spawn ⇒ 市场包操作仍走已验收的假壳链路
			// （**不 provide**，否则会把 dshmarket 从假壳链路改道到进程内队列）。但「挂载
			// 契约的就地改写」与「接管包操作」是两件独立的事：PC/2in1 档同样要把官方
			// Desktop 判据收窄，否则皮肤市场仍被判成官方 Desktop、一大半皮肤显示
			// 「需手动安装」（见 patchMarketCliBranch 的头注）。
			if (profileDir.length === 0) {
				log("随包 bin/pnpm 假壳可执行 ⇒ 不接管（市场走已验收的假壳链路；profileContext 缺 dir ⇒ 不贴补丁）");
				return false;
			}
			log(`皮肤市场挂载契约改写：${patchMarketCliBranch(profileDir).reason}`);
			log(`插件市场预览图改写：${patchDshmarketThumbs(profileDir).reason}`);
			log("随包 bin/pnpm 假壳可执行 ⇒ 不接管（市场走已验收的假壳链路）");
			return false;
		}
		if (profileName.length === 0 || profileDir.length === 0) {
			log("profileContext 缺 name/dir ⇒ 不接管（市场退回 CLI 链路）");
			return false;
		}
		const queueDir = queueDirFor(profileDir);
		hostCtx.provide("desktopProfiles", { current: { name: profileName, dir: profileDir } });
		hostCtx.provide("desktopPnpm", createDesktopPnpm(queueDir, profileDir));
		const patched = patchMarketCliBranch(profileDir);
		log(`皮肤市场挂载契约改写：${patched.reason}`);
		log(`插件市场预览图改写：${patchDshmarketThumbs(profileDir).reason}`);
		log(`已接管市场包操作：profile=${profileName}，队列=${queueDir}`
			+ `（原因：${forced ? "DSHM_MARKET_BRIDGE=force" : "随包假壳无法 spawn"}）`);
		return true;
	} catch (error) {
		log(`未挂载（不影响启动）：${messageOf(error)}`);
		return false;
	}
}

export { marketTargets, name, patchDshmarketThumbs, patchMarketCliBranch, provideMarketBridge, targetDirFromArgv };
