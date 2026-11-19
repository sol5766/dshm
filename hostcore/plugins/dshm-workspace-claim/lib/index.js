/**
 * DSHM 端侧的**工作区登记撤回**插件（原名"默认工作区登记"；2026-10-13 彻底收窄）。
 *
 * ── 它现在只做一件事：撤回本插件**自己早先**注入的那条工作区登记 ─────────────
 * 2026-10-03 引入时它**每次启动**都把 ArkTS 认领到的 `Download/<包名>/`
 * （env `DSHM_PUBLIC_DOWNLOAD`）经官方 API `workspaceRegistry.create()` 登记进注册表；
 * 2026-10-07 收窄成"只在注册表为空时登记一次"（`docs/113`）。
 * **2026-10-13 去掉"登记"整条分支**：用户口径（"不要替用户做选择"）在全新安装的
 * 手机上第三次被违反 —— 首启注册表必然为空 ⇒ 插件登记一条标题 `下载` 的工作区，
 * 而那个目录用户从没选过。官方 Web UI 本来就有"选择工作区"这条路（见下），
 * 端侧不需要、也不该替用户决定工作区落在哪。
 *
 * ── 去掉登记之后为什么是安全的 ───────────────────────────────────────────────
 * · 全新安装首启 = 注册表空。官方客户端的 `restoreSelection()`
 *   （`@deepseek-ai/dsh-client-ui-workspace/lib/client.js:1598-1603`）只有在
 *   「没有可恢复的选择 **且** 注册表空 **且** 会话历史空」时才调
 *   `initializeDefault()`；它在本端（`process.platform === "linux"`）走
 *   `xdg-user-dir DOCUMENTS`（`dsh-api-workspace-controller/lib/index.js:609-641`）
 *   ⇒ 沙箱里必失败 ⇒ 客户端只弹一条 warning（`defaultWorkspaceFailed`：
 *   "无法创建默认工作区，请通过'选择工作区'选择文件夹"），**不阻断、不建会话**。
 *   这正是官方语义：工作区由用户自己选。
 * · "选择工作区"的入口在本端是好的：`cordis.patch.yml` ⑤ 把官方 auto 目录面禁掉、
 *   改挂 `ui-directory-picker-native`（读 `WebApp.ets` 注入的
 *   `globalThis.__DSH_DIRECTORY_PICKER__` = 系统 `DocumentViewPicker`）+
 *   `directory-picker-browse` 后端 ⇒ 侧栏"添加工作区"能拉起系统目录选择器。
 * · 注册表**为空**从此是正常状态（不再是"插件登记前"的中间态）⇒ 撤回不再要求
 *   "撤完必须仍非空"。反过来说：不撤掉那条，用户就会一直看到一条自己没建过的
 *   工作区（2026-10-13 真机复报）。
 *
 * ── 撤回的边界（只删注册表那一行）────────────────────────────────────────────
 * · `isOurRow()` 按**路径**判（末两段 `Download/<包名>`），只可能命中认领目录那一类，
 *   不会碰用户自己的工作区；
 * · 只调官方 `workspaceRegistry.delete(id)` —— **不动目录、不删任何会话日志**；
 *   它名下若有会话（客户端首启自动建的空壳），撤回后按官方语义落到"未分组"，
 *   仍然能打开（UI 自己的文案："文件夹与会话记录会保留，其会话将显示在'未分组'下"）；
 * · 读不到注册表 ⇒ **什么都不做**（fail-closed）；
 * · 认领目录不存在 / 不是目录 ⇒ 跳过；没有 `DSHM_PUBLIC_DOWNLOAD` 时完全惰性。
 *
 * ── 回退路径 ─────────────────────────────────────────────────────────────────
 * 上游若给"默认工作区"提供不依赖空历史、且在 openharmony 上可用的目录来源，
 * 或本端决定改由 ArkTS 侧经 picker 显式征得用户同意后再建，再另议；
 * 本插件当前形态由门禁 `tools/check-workspace-claim.mjs` 钉死（含"绝不 create"）。
 *
 * @module dshm-workspace-claim
 */
import { statSync } from "node:fs";
import { realpath } from "node:fs/promises";

/** Stable Loader identity. */
const name = "dshm-workspace-claim";
/** 需要的服务：工作区注册表 + 只读会话快照（用于修复升级后丢失的成员关系）。 */
const inject = ["workspaceRegistry", "sessionPersistence"];

/** 本次要撤回的目录；未由 ArkTS 认领时为空串（插件随即完全惰性）。 */
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
 * 非破坏性修复：把**现有工作区**记录里缺失、但会话 header 的 cwd 已能解析到
 * 同一路径的成员补回去。
 *
 * 【为什么需要】2026-10-17 场外反馈：1.1.2 → 1.1.3 升级后，部分用户的工作区/
 * 会话像是丢了。1.1.2/1.1.3 的会话格式都是 v4，`$DSH_HOME` 也没变；真正的危险
 * 时序是：宿主先启动 → persist 授权尚未 activate → `realpath(cwd)` 返回 EPERM →
 * 工作区把成员过滤掉。若随后发生一次 `WorkspaceEntity.mutate()`，被过滤的
 * `sessionIds` 会被写回成空数组，之后重启也不会自动长回来。
 *
 * 【边界】只 attach 到**已经存在的同路径工作区**：
 *   · 不 create 新工作区（孤儿会话不会被自动归组，避免把用户删除的工作区复活）；
 *   · 不 delete 任何东西、不碰会话日志；
 *   · cwd 当前解析失败就跳过（不猜）；
 *   · 没有 sessionPersistence / list / attachSession 时完全惰性。
 *
 * @param registry - `ctx.workspaceRegistry`
 * @param persistence - `ctx.sessionPersistence`
 * @returns 完成信号；错误由调用方统一降级成日志
 */
async function repairMembership(registry, persistence) {
	if (!persistence || typeof persistence.list !== "function") return;
	let workspaces;
	try {
		workspaces = typeof registry.list === "function" ? registry.list() : void 0;
	} catch {
		workspaces = void 0;
	}
	if (!Array.isArray(workspaces) || workspaces.length === 0) return;
	const byPath = new Map();
	const accounted = new Set();
	for (const workspace of workspaces) {
		if (!workspace || typeof workspace.path !== "string") continue;
		byPath.set(workspace.path, workspace);
		let ids = [];
		try {
			ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
		} catch {
			ids = [];
		}
		for (const id of ids) accounted.add(id);
	}
	let snapshots;
	try {
		snapshots = await persistence.list();
	} catch (error) {
		console.warn(`[dshm-workspace-claim] 修复成员：列会话失败 ⇒ 跳过：${String(error && error.message ? error.message : error)}`);
		return;
	}
	if (!Array.isArray(snapshots)) return;
	let repaired = 0;
	for (const snapshot of snapshots) {
		const header = snapshot && snapshot.header;
		const id = header && header.id;
		const cwd = header && header.cwd;
		if (typeof id !== "string" || id.length === 0 || typeof cwd !== "string" || cwd.length === 0) continue;
		if (accounted.has(id)) continue;
		let canonical;
		try {
			canonical = await realpath(cwd);
		} catch {
			continue;
		}
		const workspace = byPath.get(canonical);
		if (workspace === void 0 || typeof workspace.attachSession !== "function") continue;
		try {
			await workspace.attachSession(id);
			accounted.add(id);
			repaired += 1;
		} catch (error) {
			console.warn(`[dshm-workspace-claim] 修复成员失败 session=${id}：${String(error && error.message ? error.message : error)}`);
		}
	}
	if (repaired > 0) {
		console.log(`[dshm-workspace-claim] 已从会话 header 非破坏性补回 ${repaired} 条工作区成员`);
	}
}

/**
 * 与注册表对账：**只撤本插件自己那条，绝不新增**。
 * 同步返回一个浮空 promise，调用方（`apply()`）不等它。
 *
 * 【2026-10-18 增补：把"自动生成的那条"的标题改成人话】
 * 6.1.0 平板（无 FolderSelection 能力）走专属目录兜底后，官方客户端会在
 * "注册表为空 + 无会话"时 `initializeDefault()`，标题取目录 basename ⇒ 用户看到
 * 一条叫 `com.dshm.dshclient` 的工作区（内测复报）。它不是本插件建的，**不能删**
 * （删了客户端每次加载又会重建，反复闪），只把**标题恰好等于 basename** 的那条
 * 改成 `应用专属目录`；用户自己改过标题的（不等于 basename）一律不碰。
 * 历史"我们自建"那条的标题是 `下载` ⇒ 仅按这个精确标题撤，避免误删官方记录。
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
	// 读不到注册表就**什么都不做**（fail-closed）：判断不了就不动它。
	if (!Array.isArray(list)) {
		console.warn("[dshm-workspace-claim] 注册表读不出列表 ⇒ 本次不撤回（不影响启动）");
		return Promise.resolve();
	}
	const normalized = String(target || "").replace(/[\\/]+$/, "");
	const base = normalized.length === 0 ? "" : normalized.split(/[\\/]+/).pop();
	const titleOf = (w) => String((w && w.title) || "").trim();
	const ours = list.filter((w) => isOurRow(w && w.path, target));
	// 历史"我们自建"那条：标题是 `下载`（旧插件写死的）。没有 title 字段的记录
	// 只可能来自门禁用例/异常形态 —— 也按"我们那条"处理（宁可少留一条脏记录）。
	const legacy = ours.filter((w) => {
		const t = titleOf(w);
		return t === "下载" || t.length === 0;
	});
	// 官方 initializeDefault 自动建的那条：标题 = 目录 basename（= 包名）。
	const autoNamed = ours.filter((w) => base.length > 0 && titleOf(w) === base);
	if (ours.length === 0) {
		// 常态：没有指向认领目录的记录 ⇒ 一行都不碰。
		console.log(`[dshm-workspace-claim] 注册表里 ${list.length} 条工作区，`
		  + `没有指向认领目录的记录 ⇒ 不动作`);
		return Promise.resolve();
	}
	// ① 先把"自动生成、标题=包名"的那条改成人话（只改显示名，不动路径与成员）。
	const retitleChain = autoNamed.reduce((chain, w) => chain.then(() => (
		typeof w.setTitle === "function"
			? Promise.resolve(w.setTitle("应用专属目录")).then(() => {
				console.log(`[dshm-workspace-claim] 已把自动生成的工作区标题从 `
				  + `"${base}" 改为 "应用专属目录"（路径与成员未动）`);
			}, (error) => {
				console.warn(`[dshm-workspace-claim] 改标题失败（不影响启动）：`
				  + `${error && error.message ? String(error.message) : String(error)}`);
			})
			: Promise.resolve()
	)), Promise.resolve());
	// ② 只撤"本插件历史上建的那条"（标题精确为 `下载`）；官方 initializeDefault 建的不删。
	return retitleChain.then(() => legacy.reduce((chain, w) => chain.then(() => registry.delete(w.id)).then(
		() => {
			console.log(`[dshm-workspace-claim] 已撤回本插件早先登记的一条：${target}`
			  + `（只删注册表这一行；目录与任何会话日志都未动 —— 它名下若有会话会落到"未分组"，仍然可打开）`);
		},
		(error) => {
			console.warn(`[dshm-workspace-claim] 撤回登记失败（不影响启动）：`
			  + `${error && error.message ? String(error.message) : String(error)}`);
		}
	), Promise.resolve())).then(() => void 0);
}

/**
 * 撤回本插件早先注入的工作区登记。**同步返回、异步对账**：loader 不会因为这里的成败而改变启动结果。
 * @param ctx - 插件上下文（用它的 `workspaceRegistry`）。
 */
function apply(ctx) {
	const target = claimedDirectory();
	// 【为什么先 stat】认领目录是 `isOurRow()` 的判据来源：路径本身不存在时
	// （认领失败、模块被单独加载）不做任何对账，避免拿一个不存在的路径去和注册表比对。
	let isDirectory = false;
	let note = "";
	if (target.length > 0) {
		try {
			isDirectory = statSync(target).isDirectory();
			if (!isDirectory) {
				note = "路径不是目录";
			}
		} catch (e) {
			note = `stat 失败：${e && e.message ? String(e.message) : String(e)}`;
		}
	}
	if (target.length > 0 && !isDirectory) {
		console.log(`[dshm-workspace-claim] 跳过：DSHM_PUBLIC_DOWNLOAD=${target}（${note}）`);
	}
	// 浮空 promise + 兜底 catch：修复/对账失败只是"旧数据没补齐"，
	// 绝不能升级成"Host 启动失败"。真机判据读的就是下面这几行日志。
	Promise.resolve()
		.then(() => repairMembership(ctx.workspaceRegistry, ctx.sessionPersistence))
		.then(() => {
			if (target.length === 0 || !isDirectory) return;
			return reconcile(ctx.workspaceRegistry, target);
		})
		.catch((error) => {
			// `.then(ok, fail)` 的 fail 分支自己抛错时才会到这里：同样只记不抛。
			console.warn(`[dshm-workspace-claim] 对账回调异常（不影响启动）：${String(error)}`);
		});
}

export { apply, inject, name, repairMembership };
