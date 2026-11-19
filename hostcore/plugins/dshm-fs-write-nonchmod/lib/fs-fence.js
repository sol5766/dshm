/**
 * DSHM 文件访问范围闸门（**唯一真源**；落地与实测见 docs/137）。
 *
 * ── 缺口（真机实测，见 docs/137 §3）──────────────────────────────────────
 * 上游 `@deepseek-ai/dsh-fs-sandbox` 的定义里**没有读闸门**（其头注逐字写着
 * "Reads pass through untouched: every mode permits reading"），而且
 * `checkedTarget()` 在 `danger-full-access` 下**直接返回调用方的 target**（连写闸门
 * 也不做）。本端的 sandbox-policy 正是 danger-full-access ⇒ 工具层对"能碰哪里"
 * 没有任何边界：应用身份可以列 `/etc`、读 `/system/...`，也能往用户目录之外写。
 *
 * ── 用户拍板的策略（2026-10-10）────────────────────────────────────────
 *   ① 应用沙箱**不变**（照旧全可读写）；
 *   ② `/storage/Users/currentUser/` 之下**全域**可读写；
 *   ③ 其余一律拒绝 —— **读与写都拒绝**（系统数据区、别的应用沙箱、挂载点…）。
 * 用**白名单**而不是黑名单：系统面是开放集合（新分区 / 新挂载点 / 别人的沙箱都算），
 * 黑名单必然漏。
 *
 * ── 三个入口，一份判据 ─────────────────────────────────────────────────
 *   1. `ctx.fs` 后端（本包 `lib/index.js`）—— read / write / edit / ls / stat 全经由它；
 *   2. `dshm-tool-fs-remove` 的 `publish` **目标**—— 它自己用 node:fs 落盘，不过
 *      `ctx.fs`（该插件的 remove/move 两端、publish 的源都经 `ctx.fs.resolve`，
 *      已被 ① 覆盖：本闸门在 `resolve()` 里就抛）；
 *   3. `dsh-tool-fs-search` 的 `glob` / `grep` —— 它们 spawn 随包 ripgrep（exec 被拒时
 *      降级系统 find/grep），搜索根直接进 argv，**同样不过 `ctx.fs`**。
 * 判据集中在下面 BEGIN / END 之间的**纯字符串**实现里：tools/pack-core.mjs 的
 * patchFsSearchFallback() 会把这一段**原样**嵌进核心树的
 * `dsh-tool-fs-search/lib/index.js`；tools/check-fs-fence.mjs 钉住
 * 「两份插件副本逐字节一致」＋「纯判据的行为矩阵」＋「三个入口真的接上了」。
 *
 * ── 为什么判据是纯字符串（不做 realpath）────────────────────────────────
 * 这一段要能被原样搬进上游文件（那边没有可用的 fs 标识符，也不能在模块中部 import）。
 * 真实身份由入口 ① 的 `targetKey` 负责（`resolve()` 已经 realpath 过"最深已存在祖先"）；
 * 需要 realpath 的两个入口（`lstat`、`publish`）由本文件的 `assertFsScope()` 补上。
 *
 * ── 不判的两种情形（如实登记）──────────────────────────────────────────
 *   · 相对路径：`ctx.fs` 侧在 `resolve()` 之前就由调用方按会话 cwd 解析成绝对路径；
 *     `glob`/`grep` 侧由注入的那段自己拼 cwd。判据本身只认绝对路径，非绝对一律拒。
 *   · PC 档的**真 shell**（`bash` 工具）：那是本机进程级能力，不在本闸门的可达面内
 *     （手持档的 bash 走 guest 虚拟机，9p 只导出沙箱 + 工作区，天然在允许面内）。
 *
 * ── 调试逃生口 ─────────────────────────────────────────────────────────
 * `DSHM_FS_SCOPE=off` 让整条闸门惰性（与 `DSHM_VM_BASH=force|off` 同一惯例）：
 * 只在排障时用，不落任何用户可见开关。
 *
 * @module dshm-fs-fence
 */
import { FsError } from "@deepseek-ai/dsh-fs";
import { realpath } from "node:fs/promises";
/* 用 **posix** 版的 dirname：本模块的整个路径域就是 POSIX 形态（`/data/...`、
 * `/storage/...`），不该随宿主平台（Windows 上按盘符/反斜杠）改语义。 */
import { dirname } from "node:path/posix";

/* ==== DSHM-FS-SCOPE-BEGIN ====
 * 【这一段的特殊性】tools/pack-core.mjs 会把 BEGIN / END 之间的**全部文本原样**嵌进
 * 核心树里的 `dsh-tool-fs-search/lib/index.js`（glob/grep 不过 ctx.fs，只在那里还有
 * 第二个入口）。因此这一段必须**自足**：
 *   · 不许出现 import / export（嵌进去的位置在模块中部）；
 *   · 不许引用目标文件里没有的名字（只用入参 env 与 JS 内建）；
 *   · 只做**纯字符串**运算，不碰文件系统。
 * 改动这一段必须同改 tools/check-fs-fence.mjs（它按 BEGIN/END 提取并比对）。
 */
/** 应用自身数据根：鸿蒙上应用看到的自身沙箱就在这两个根之下（真机 realpath 实证）。 */
const SCOPE_SANDBOX_ROOTS = ["/data/storage/el1/base", "/data/storage/el2/base"];
/** 用户文件区根：用户家目录（策略里的允许面之二）。 */
const SCOPE_USER_ROOT = "/storage/Users/currentUser";

/**
 * 词法归一化：折叠重复斜杠、去掉 `.`、用 `..` 出栈（到根即止）。**不碰文件系统。**
 * 非绝对路径（或空白）返回空串 —— 调用方按"空串一律不允许"处理。
 * @param input - 待归一化的路径。
 * @returns 归一化后的绝对路径；不是绝对路径时为空串。
 */
function scopeNormalize(input) {
	if (typeof input !== "string") return "";
	const text = input.trim();
	if (text.length === 0 || text.charAt(0) !== "/") return "";
	const parts = [];
	for (const part of text.split("/")) {
		if (part.length === 0 || part === ".") continue;
		if (part === "..") {
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return "/" + parts.join("/");
}

/**
 * `path` 是否等于 `root` 或在其**之下**（按路径段比较：`/a/bc` 不算在 `/a/b` 之下）。
 * @param path - 已归一化的绝对路径。
 * @param root - 已归一化的允许面根。
 * @returns 在允许面内为 true。
 */
function scopeIsUnder(path, root) {
	if (path === root) return true;
	if (root === "/") return path.charAt(0) === "/";
	return path.indexOf(root + "/") === 0;
}

/**
 * 从一个"沙箱内路径"推出**应用数据根**：优先按 `/haps/` 切（沙箱 home 的形态），
 * 其次按最末一个 `base` 段切（`…/el2/base/cache` 这种）。推不出来返回空串。
 * @param input - 形如 `$DSHM_SANDBOX_HOME` / `$HOME` / `$TMPDIR` 的路径。
 * @returns 应用数据根，推不出来时为空串。
 */
function scopeAppRootOf(input) {
	const path = scopeNormalize(input);
	if (path === "") return "";
	const haps = path.indexOf("/haps/");
	if (haps > 0) return path.slice(0, haps);
	const parts = path.split("/");
	const base = parts.lastIndexOf("base");
	if (base > 1) return parts.slice(0, base + 1).join("/");
	return "";
}

/**
 * 允许面（唯一真源，每次从 env 现算；宿主进程的 env 启动后不再变）。
 * 组成：两个固定在册的应用数据根 + 用户家目录 + 由 env 推导出的沙箱根（含 el1/el2 孪生）
 * + 已认领的工作区（`DSHM_PUBLIC_DOWNLOAD`，正常情况下已在用户家目录之下）。
 * @param env - 进程环境（`process.env`）。
 * @returns 去重后的允许面根列表。
 */
function scopeRoots(env) {
	const e = env || {};
	const roots = [];
	const push = (value) => {
		const root = scopeNormalize(value);
		if (root !== "" && roots.indexOf(root) < 0) roots.push(root);
	};
	for (const root of SCOPE_SANDBOX_ROOTS) push(root);
	push(SCOPE_USER_ROOT);
	for (const key of ["DSHM_SANDBOX_HOME", "HOME", "TMPDIR"]) {
		const root = scopeAppRootOf(e[key]);
		if (root === "") continue;
		push(root);
		if (root.indexOf("/el2/") > 0) push(root.split("/el2/").join("/el1/"));
		else if (root.indexOf("/el1/") > 0) push(root.split("/el1/").join("/el2/"));
	}
	/* 已认领的工作区：正常在用户家目录之下（重复 push 会被去重）。万一被放到别处
	 * （换卷 / 换目录），工作区**必须**仍可用 —— 否则应用的核心功能自断。 */
	push(e.DSHM_PUBLIC_DOWNLOAD);
	return roots;
}

/**
 * `absPath`（绝对、词法）是否落在允许面内。空串（非绝对路径）一律不放行。
 * @param absPath - 绝对路径。
 * @param roots - {@link scopeRoots} 的结果。
 * @returns 允许为 true。
 */
function scopeAllows(absPath, roots) {
	const path = scopeNormalize(absPath);
	if (path === "") return false;
	for (const root of roots) if (scopeIsUnder(path, root)) return true;
	return false;
}

/**
 * 拒绝文案：用户与模型都读它，所以必须说清"这是本应用策略"与"允许面到底是什么"，
 * 并给出可执行的下一步（改到允许面内 / 如实告诉用户），而不是一句"没有权限"。
 * @param absPath - 被拒的绝对路径。
 * @param roots - {@link scopeRoots} 的结果。
 * @returns 多行拒绝文案。
 */
function scopeDenialMessage(absPath, roots) {
	const list = Array.isArray(roots) ? roots : [];
	const sandbox = list.filter((root) => root.indexOf("/data/") === 0).join("、");
	const users = list.filter((root) => root.indexOf("/data/") !== 0).join("、");
	return "路径在 DSHM 的允许范围之外，已拒绝访问：" + absPath + "\n"
		+ "本应用只允许访问两处：① 应用沙箱（" + sandbox + "）；"
		+ "② 用户目录（" + users + "）以及它们之下的一切。\n"
		+ "系统数据区（/system、/etc、/data 下本应用沙箱以外的部分、/proc、/mnt、其它应用的沙箱等）"
		+ "的读与写都会被本应用的路径策略拒绝：这是 DSHM 自己的闸门，不是操作系统报的错，"
		+ "重试或换写法都不会通过。\n"
		+ "请把要做的事放到允许范围内的位置；确实需要面外内容时，如实告诉用户该路径在本设备上不可访问，不要绕。";
}
/* ==== DSHM-FS-SCOPE-END ==== */

/** 允许面缓存（env 在宿主进程启动后是常量）。 */
let scopeRootsCache = null;

/**
 * 本端允许面（含 env 推导项）。
 * @returns 允许面根列表。
 */
export function fsScopeRoots() {
	if (scopeRootsCache === null) scopeRootsCache = scopeRoots(process.env);
	return scopeRootsCache;
}

/**
 * 闸门是否生效。`DSHM_FS_SCOPE=off` 时整条惰性（排障逃生口）。
 * @returns 生效为 true。
 */
export function fsScopeEnabled() {
	return String(process.env.DSHM_FS_SCOPE || "").trim().toLowerCase() !== "off";
}

/**
 * 纯词法判定：拿**已 realpath 的 targetKey** 调它，等价于判"真实身份"（零系统调用）。
 * 热路径（read/list/stat…）用它；收**模型原始路径**的入口用 {@link assertFsScope}。
 * @param absPath - 目标（或原始）绝对路径。
 */
export function assertFsScopeLexical(absPath) {
	if (!fsScopeEnabled()) return;
	const roots = fsScopeRoots();
	if (scopeAllows(absPath, roots)) return;
	throw new FsError(scopeDenialMessage(scopeNormalize(absPath) || String(absPath), roots), "FS_PERMISSION_DENIED");
}

/**
 * 按**真实身份**判定（「最深已存在祖先」的 realpath + 缺失尾巴词法回接）。
 * 两个作用：
 *   · 挡住"允许面**内**的软链指向面**外**"（`rm` / `rename` / `publish` 走词法路径，
 *     只有这一层能看见真实身份）；
 *   · 让同一目录的**别名**形态也能通过（例如 `/data/app/el2/<uid>/base/<bundle>/…`
 *     与 `/data/storage/el2/base/…` 是同一份沙箱的两个视图；realpath 会把前者映射到后者）。
 * 判据是"**只**看真实身份"：真实身份在允许面内就放行，在面外就拒 —— 不会因为
 * 词法形态像允许面内而放行，也不会因为像面外而误拒。
 * @param absPath - 模型给的绝对路径（可能尚不存在）。
 */
export async function assertFsScope(absPath) {
	if (!fsScopeEnabled()) return;
	const roots = fsScopeRoots();
	const lexical = scopeNormalize(absPath);
	if (lexical === "") throw new FsError(scopeDenialMessage(String(absPath), roots), "FS_PERMISSION_DENIED");
	if (scopeAllows(await scopeCanonicalize(lexical), roots)) return;
	throw new FsError(scopeDenialMessage(lexical, roots), "FS_PERMISSION_DENIED");
}

/**
 * 「最深已存在祖先 realpath + 缺失尾巴词法回接」（与上游 resolveLocalTarget 同一手法）。
 * 一路退回根还给不出真实路径时，退回词法结果（宁可退回词法，也不抛错打断调用方）。
 * @param absPath - 已归一化的绝对路径。
 * @returns 真实身份（词法兜底）。
 */
async function scopeCanonicalize(absPath) {
	let head = absPath;
	const missing = [];
	for (;;) {
		try {
			const real = await realpath(head);
			let out = scopeNormalize(real);
			/* realpath 给回来的不是 POSIX 绝对路径（Windows 盘符之类，只在开发机上出现）
			 * ⇒ 这个平台没有可比的真实身份，退回**词法**结果（设备上是 POSIX，走不到这里）。 */
			if (out === "") return absPath;
			for (let index = missing.length - 1; index >= 0; index -= 1) out = scopeNormalize(out + "/" + missing[index]);
			return out;
		} catch {
			const parent = dirname(head);
			if (parent === head) return absPath;
			missing.push(head.slice(parent.length + 1));
			head = parent;
		}
	}
}
