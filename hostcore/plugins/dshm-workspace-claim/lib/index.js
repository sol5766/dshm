/**
 * DSHM 端侧的**默认工作区登记**插件。
 *
 * ── 为什么需要它（缺口的事实，已核实）──────────────────────────────────────
 * 本端"新建会话落在哪个目录"由**客户端**决定，而官方 Web UI 的判定顺序是
 * （`@deepseek-ai/dsh-client-ui-workspace/lib/client.js`，已逐行核对）：
 *   · `restoreSelection()`（`:927-947`）：`saved.sessionId` 还在 ⇒ 用它的工作区；
 *     否则 `target = workspace?.workspaceId ?? recentWorkspace(items, byId)`；
 *   · `startSession()`（`:849-862`）：`target = workspaceId ?? currentWorkspaceId ?? recent`；
 *   · `recentWorkspace()`（`:1014-1030`）：按"该工作区下会话的最新 `updatedAt`、
 *     无会话时按 `workspace.createdAt`"取**最新**的那个工作区。
 *
 * 官方的 `workspace/initializeDefault` 在本端救不了场：`dsh-workspace` 的
 * `initializeDefault()`（`lib/index.js:423-443`）要求「注册表为空 **且** 归档集为空
 * **且** 会话历史为空」⇒ 设备上有历史就直接返回 `undefined`；而它的目录来源
 * `defaultWorkspaceDirectory()`（`dsh-api-workspace-controller/lib/index.js:609-641`）
 * 在本端（`process.platform === "linux"`）走 `xdg-user-dir DOCUMENTS` ⇒ 沙箱里
 * 必然失败并**抛错**。两条都堵死。
 *
 * 因此本条只在**注册表为空**（全新安装）时，把 ArkTS 认领到的
 * `Download/<包名>/`（`DSHM_PUBLIC_DOWNLOAD`，见 `NodeRuntime.claimPublicDownload()`）
 * 经官方 API `workspaceRegistry.create()` 登记一次：既给"新建会话"一个落点，
 * 又让上面那个 `initializeDefault()` 在 `workspaceIds.length > 0` 处**干净短路**，
 * 不会再去跑必失败的目录探测。
 *
 * ── 2026-10-07 修正：只在注册表为空时登记，并撤回自己早先注入的那条 ──────────
 * 原实现**每次启动都登记**（`create()` 幂等，路径已登记时只解析、不新增行），
 * 意图是"让认领目录成为 `recentWorkspace()` 认定的最新一条"。真机读数表明这一手
 * 价值有限（`cordis.patch.yml` ⑨ 已记明局限：`currentWorkspaceId` 那一段优先级更高，
 * 新会话其实落在**当前会话所属工作区**），代价却是实打实的：2026-10-03 起，凡是
 * 启动过一次的设备，注册表里都会多出一条**用户没建过**的 `com.dshm.dshclient`。
 * 已核（2026-10-07 真机 `$DSH_HOME/storages/workspace.json`）：
 * `"path": "/storage/Users/currentUser/Download/com.dshm.dshclient"`、
 * `"sessionIds": []`、`createdAt = 2026-10-03T09:48:26Z`（= 该提交当天），
 * 与用户自己的 `harness`（8 个会话）并列 —— 纯噪声。
 *
 * 现在的纪律（用户口径："不要替用户做选择"）：
 *   · 注册表里**已经有**工作区 ⇒ 绝不新增，一条也不碰；
 *   · 其中若有**本插件自己**早先注入的那条（路径 = 认领目录）且**它 0 会话**
 *     ⇒ 撤回那条登记（只删注册表一行；**不动目录、不动任何会话日志**）；
 *     但撤完必须仍有别的行，否则宁可留着 —— 注册表变空会把上面
 *     `initializeDefault()` 的短路条件弄丢。
 *
 * ── 纪律 ─────────────────────────────────────────────────────────────────────
 * · **不改上游 dsh、不新增权限、不碰任何既有目录**：只读 `DSHM_PUBLIC_DOWNLOAD`，
 *   只往本应用自己的注册表写/删**自己那一行**。
 * · **绝不阻断启动**：`apply()` 是同步的，真正的登记/撤回是一个**自行吞掉错误**的
 *   异步动作；任何失败都只打一行日志（成功/失败都是可观测事实），不抛给 loader。
 * · **没有 `DSHM_PUBLIC_DOWNLOAD` 就完全惰性**（其它部署/开发机上零副作用）。
 * · 用户自己的工作区登记保持原样，用户仍可在 UI 里自行改名/删除。
 *
 * @module dshm-workspace-claim
 */
import { statSync } from "node:fs";

/** Stable Loader identity. */
const name = "dshm-workspace-claim";
/** 需要的服务：工作区注册表（`dsh-workspace` 的 `workspaceRegistry`）。 */
const inject = ["workspaceRegistry"];

/**
 * 登记时用的标题。**不要**退化成目录末段 —— 那是包名 `com.dshm.dshclient`，
 * 在工作区列表里像一条垃圾记录。`create(path, title)` 的 title 只在**新建那一刻**
 * 生效，之后用户可在 UI 里自行改名。
 */
const DEFAULT_TITLE = "下载";

/** 本次要登记的目录；未由 ArkTS 认领时为空串（插件随即完全惰性）。 */
function claimedDirectory() {
	return (process.env.DSHM_PUBLIC_DOWNLOAD || "").trim();
}

/**
 * 注册表里某条记录，是不是**本插件认领的那个目录**。
 *
 * 【为什么不直接比字符串】注册表存的是 `realpath` 规范形
 * （`dsh-workspace/lib/index.js:407,635-638`），而 ArkTS 交过来的是**拼出来**的
 * 路径 —— 两者可能只差前缀（设备上 `/storage/Users/currentUser` 那一段会被
 * realpath 解析掉）。末两段（`Download` + 包名）相同即认定同一条：这条判据
 * **只可能**命中"认领目录"这一类路径，不会误伤用户自己的工作区。
 *
 * @param recorded - 注册表记录里的 `path`。
 * @param claimed - 本次认领到的目录。
 * @returns 是否指向同一处认领目录。
 */
function isOurRow(recorded, claimed) {
	// 两个分隔符都认：设备上是 POSIX 路径，开发机上自测时可能是 Windows 路径。
	const a = String(recorded || "").replace(/[\\/]+$/, "");
	const b = String(claimed || "").replace(/[\\/]+$/, "");
	if (a.length === 0 || b.length === 0) return false;
	if (a === b) return true;
	const tail = "/" + b.split(/[\\/]+/).filter((seg) => seg.length > 0).slice(-2).join("/");
	return tail.length > 1 && a.endsWith(tail);
}

/**
 * 与注册表对账：**只在注册表为空时加一条；否则只撤自己那一条**。
 * 同步返回一个浮空 promise，调用方（`apply()`）不等它。
 *
 * @param registry - `ctx.workspaceRegistry`（`dsh-workspace` 的服务）。
 * @param target - 本次认领到的目录（调用方已判为存在且是目录）。
 * @returns 对账完成的 promise（错误在内部消化成日志）。
 */
function reconcile(registry, target) {
	let list;
	try {
		list = typeof registry.list === "function" ? registry.list() : void 0;
	} catch (error) {
		list = void 0;
	}
	// 读不到注册表就**什么都不做**（fail-closed）：既然判断不了"用户是否已经有工作区"，
	// 就既不新增也不撤回 —— 绝不因为一次读失败而替用户加一条。
	if (!Array.isArray(list)) {
		console.warn("[dshm-workspace-claim] 注册表读不出列表 ⇒ 本次不新增也不撤回（不影响启动）");
		return Promise.resolve();
	}
	if (list.length > 0) {
		// 用户已经有自己的工作区 ⇒ 绝不替他新增，也不再"抢最新"。
		const mine = list.filter((w) => isOurRow(w && w.path, target));
		const emptyMine = mine.filter((w) => Array.isArray(w.sessionIds) && w.sessionIds.length === 0);
		// 撤自己那条时注册表**撤完必须仍非空**：空了会让上游 initializeDefault()
		// 下次启动去跑在本端必失败的目录探测（见本文件头注释）。
		if (emptyMine.length === 0 || emptyMine.length >= list.length) {
			console.log(`[dshm-workspace-claim] 注册表里已有 ${list.length} 条工作区 ⇒ 本次不新增`
			  + `（本插件只在注册表为空时登记一次）`);
			return Promise.resolve();
		}
		return emptyMine.reduce((chain, w) => chain.then(() => registry.delete(w.id)).then(
			() => {
				console.log(`[dshm-workspace-claim] 已撤回本插件早先登记的一条：${target}`
				  + `（0 会话；只删注册表这一行，目录与任何会话日志都未动）`);
			},
			(error) => {
				console.warn(`[dshm-workspace-claim] 撤回登记失败（不影响启动）：`
				  + `${error && error.message ? String(error.message) : String(error)}`);
			}
		), Promise.resolve());
	}
	return registry.create(target, DEFAULT_TITLE).then((workspace) => {
		const id = workspace && workspace.id !== undefined ? String(workspace.id) : "(无 id)";
		console.log(`[dshm-workspace-claim] 注册表为空 ⇒ 已登记默认工作区：${target}（workspaceId=${id}）`);
	}, (error) => {
		console.warn(`[dshm-workspace-claim] 默认工作区登记失败（不影响启动，客户端会退回注册表里的最新一条）：`
		  + `${error && error.message ? String(error.message) : String(error)}`);
	});
}

/**
 * 登记/撤回默认工作区。**同步返回、异步对账**：loader 不会因为这里的成败而改变启动结果。
 * @param ctx - 插件上下文（用它的 `workspaceRegistry`）。
 */
function apply(ctx) {
	const target = claimedDirectory();
	if (target.length === 0) {
		// 惰性：没有认领结果（开发机 / 认领失败）⇒ 什么都不做，也不打日志刷屏。
		return;
	}
	// 【为什么先 stat】`workspaceRegistry.create()` 对不存在的路径会抛
	// `cannot create a workspace at '…': path is not a directory`；先自己判一次能把
	// "目录还没建出来"（ArkTS 认领失败，属预期分支）与"注册表写失败"（真异常）分开报。
	let isDirectory = false;
	let note = "";
	try {
		isDirectory = statSync(target).isDirectory();
		if (!isDirectory) {
			note = "路径不是目录";
		}
	} catch (e) {
		note = `stat 失败：${e && e.message ? String(e.message) : String(e)}`;
	}
	if (!isDirectory) {
		console.log(`[dshm-workspace-claim] 跳过：DSHM_PUBLIC_DOWNLOAD=${target}（${note}）`);
		return;
	}
	// 浮空 promise + 兜底 catch：对账失败只是"默认工作区没换成用户可见目录"，
	// 绝不能升级成"Host 启动失败"。真机判据读的就是下面这几行日志。
	Promise.resolve()
		.then(() => reconcile(ctx.workspaceRegistry, target))
		.catch((error) => {
			// `.then(ok, fail)` 的 fail 分支自己抛错时才会到这里：同样只记不抛。
			console.warn(`[dshm-workspace-claim] 对账回调异常（不影响启动）：${String(error)}`);
		});
}

export { apply, inject, name };

