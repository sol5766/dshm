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
 * 也就是说：**注册表里最新的一条**才是"默认工作区"。而 31 轮经 picker 选过的
 * `Download/com.example.dshprobe` 已经**持久化**在注册表里（`$DSH_HOME`，el2，覆盖安装
 * 不会清）⇒ 37 轮真机的新会话 `cwd` 就落在那里（报告 §5.1 原文）。
 *
 * 官方的 `workspace/initializeDefault` 救不了这个局面：`dsh-workspace` 的
 * `initializeDefault()`（`lib/index.js:423-443`）要求
 * 「注册表为空 **且** 归档集为空 **且** 会话历史为空」，设备上有历史 ⇒ 直接返回
 * `undefined`；而且它的目录来源 `defaultWorkspaceDirectory()`
 * （`dsh-api-workspace-controller/lib/index.js:609-641`）在 `openharmony` 平台会落到
 * `default: throw` 分支。两条都堵死。
 *
 * 唯一既不删用户数据、又走**官方 API** 的路，就是本条：启动期把 ArkTS 认领到的
 * `Download/<包名>/`（`DSHM_PUBLIC_DOWNLOAD`，见 `NodeRuntime.claimPublicDownload()`）
 * 经 `workspaceRegistry.create()` 登记一次。新登记的行 `createdAt` 最新 ⇒
 * `recentWorkspace()` 选中它 ⇒ 客户端"新建会话"的默认工作区就是用户可见目录。
 * （`create()` 是幂等的：路径已登记时只解析、不新增行，见 `dsh-workspace/lib/index.js:400-410`。）
 *
 * ── 纪律 ─────────────────────────────────────────────────────────────────────
 * · **不改上游 dsh、不新增权限、不碰任何既有目录**：只读 `DSHM_PUBLIC_DOWNLOAD`，
 *   只往本应用自己的注册表写一行登记。
 * · **绝不阻断启动**：`apply()` 是同步的，真正的登记是一个**自行吞掉错误**的异步动作；
 *   任何失败都只打一行日志（成功/失败都是可观测事实），不抛给 loader。
 * · **没有 `DSHM_PUBLIC_DOWNLOAD` 就完全惰性**（其它部署/开发机上零副作用）。
 * · 不做任何删除/迁移：历史工作区登记保持原样，用户仍可在 UI 里自行删除。
 *
 * @module dshm-workspace-claim
 */
import { statSync } from "node:fs";

/** Stable Loader identity. */
const name = "dshm-workspace-claim";
/** 需要的服务：工作区注册表（`dsh-workspace` 的 `workspaceRegistry`）。 */
const inject = ["workspaceRegistry"];

/** 本次要登记的目录；未由 ArkTS 认领时为空串（插件随即完全惰性）。 */
function claimedDirectory() {
	return (process.env.DSHM_PUBLIC_DOWNLOAD || "").trim();
}

/**
 * 登记默认工作区。**同步返回、异步登记**：loader 不会因为这里的成败而改变启动结果。
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
	// 浮空 promise + 兜底 catch：登记失败只是"默认工作区没换成用户可见目录"，
	// 绝不能升级成"Host 启动失败"。真机判据读的就是下面这两行日志。
	Promise.resolve()
		.then(() => ctx.workspaceRegistry.create(target))
		.then((workspace) => {
			const id = workspace && workspace.id !== undefined ? String(workspace.id) : "(无 id)";
			console.log(`[dshm-workspace-claim] 默认工作区已登记：${target}（workspaceId=${id}）`);
		}, (error) => {
			console.warn(`[dshm-workspace-claim] 默认工作区登记失败（不影响启动，客户端会退回注册表里的最新一条）：`
				+ `${error && error.message ? String(error.message) : String(error)}`);
		})
		.catch((error) => {
			// `.then(ok, fail)` 的 fail 分支自己抛错时才会到这里：同样只记不抛。
			console.warn(`[dshm-workspace-claim] 登记回调异常（不影响启动）：${String(error)}`);
		});
}

export { apply, inject, name };
