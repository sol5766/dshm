window.__ModuleLoader__.load({
	id: "@deepseek-ai/dshm-office-system-preview",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
/**
 * DSHM 端侧的 Office **系统预览** 插件 —— 浏览器半边。
 *
 * ── 为什么需要它（缺口的事实，已核实）──────────────────────
 * · 侧栏文档预览的实现选择在
 *   `@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js:604-618`：
 *   `candidates = matchingDocumentPreviews(definitions, file.path)`，`selected = candidates[0]`。
 *   而 `matchingDocumentPreviews`（`:286-293`）的排序键是
 *   `right.rank - left.rank || right.length - left.length || left.order - right.order`，
 *   其中 `rank = definition.priority === "builtin" ? 0 : 1`（`:291`）
 *   ⇒ **一个 `priority` 非 `builtin` 的同后缀实现，一定排在内置实现前面**。
 * · 内置 office 实现（`:5639-5699`，id `…/office`，`extensions = ["doc","docx","ppt","pptx"]`）
 *   的读取函数是一个恒 reject 的桩：`:5652 let read = unavailable;`，只有
 *   `:5700 ctx.inject(["remote","remote.officeToPdf","remote.workspaceFiles"], …)`
 *   完备后才会被换成真实现——而 `remote.officeToPdf` 的宿主提供者
 *   `@deepseek-ai/libreoffice-kit` 的 `resolveEngine()`（`lib/index.js:1267`）在
 *   `openharmony-arm64` 上直接 `:1288 throw new Error(\`Unsupported LibreOfficeKit host: …\`)`
 *   ⇒ 结构性不可达。结果就是用户看到的
 *   `Office 预览不可用。请在运行 DeepSeek Harness 的主机上启用文档预览服务。`
 *   （zh 字典 `:5112`），外加「一直渲染中」——因为内置实现用的是 `loading:"renderer"`
 *   （`:5661`），而 renderer 模式下正文只在 `content !== void 0` 时才渲染，
 *   桩永远不产出内容，正文区于是长期空转。
 *
 * ── 本插件做什么 ──────────────────────────────────────────
 * 认领 `doc/docx/ppt/pptx` 四个后缀（`priority` 非 `builtin` ⇒ 一定赢 `candidates[0]`），
 * 用 `loading:"bytes-complete"` 让侧栏先把文件整读一遍（`readBytes`，上限 32 MiB，
 * 见 `@deepseek-ai/dsh-api-workspace-files/lib/index.js:385`）：读成功 ⇒ 正文直接渲染本插件
 * 的面板（不再是空转的转圈）；读失败 ⇒ `actions.failed` 落到 `:996-1017` 的空态失败块，
 * `emptyFailureRecourse("workspace-file/too-large") === "open"`（`:173-181`）
 * ⇒ 仍会渲染 `.unpreviewable` 槽里的按钮。两条路径都给得出「用系统预览打开」。
 * 正文与两个工具栏槽各给一个入口，都走 ArkTS 桥
 * `globalThis.__DSHM_BRIDGES__.openFilePreview(absolutePath)`（`WebApp.ets:1251`），
 * 由 `platform/src/main/ets/system/FilePreview.ets` 调 `PreviewKit` 弹系统预览窗。
 *
 * ── 纪律 ──────────────────────────────────────────────────
 * · **不改上游 dsh、不新增权限、不碰任何既有目录。**
 * · **绝不阻断启动**：`apply()` 只做注册；注册失败包在 `ctx.effect` 里由 cordis 回收。
 * · **只认领 `doc/docx/ppt/pptx`**。`xls/xlsx/csv/tsv` 归内置 Excel——那是纯客户端实现
 *   （`:5853-5880`，`LazyExcelBody`），端侧本来就正常；认领会把它顶掉。
 * · **`loading` 必须是 `bytes-complete`，不能是 `renderer`**：renderer 模式要求正文自己
 *   回执（`actions.rendered(tabId, revision, version)`，`:1331-1336` 且非 renderer 模式直接
 *   早退），且 `content === void 0` 时正文既不转圈也不渲染槽 ⇒ 空白。
 * · **不重复声明那四个子槽**（`sidebar.right.tab.document{,.actions,.unpreviewable,.action}`）：
 *   它们由上游 `TextPreview` 的父条目声明（`:6827-6846`），重复声明会被
 *   `slots/lib/index.js:191-194` 抛 `slot "…" is already declared`。
 * · **locale 用自有 ns**：上游 `sidebarOffice` 已注册（`:5641`）同 locale 会
 *   `locale namespace "…" already has locale "…"`（`dsh-client-locale/lib/client.js:1387-1412`）。
 *
 * @module dshm-office-system-preview/client
 */

const NS = "dshmOfficeSystemPreview";
const ID = "@deepseek-ai/dshm-office-system-preview/office";

/** 本插件认领的后缀。**只这四个**：其余 Office 后缀归内置的纯客户端实现。 */
const EXTENSIONS = ["doc", "docx", "ppt", "pptx"];

/** 注入的样式：正文面板 + 两个工具栏按钮的外观（配色全部走设计 token）。 */
const css = ".dshmOfficeSystemPreview_empty{box-sizing:border-box;height:100%;color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family);font-size:var(--dsh-content-font-size-secondary,13px);text-align:center;white-space:normal;flex-direction:column;justify-content:center;align-items:center;gap:14px;padding:0 24px;line-height:1.6;display:flex}.dshmOfficeSystemPreview_icon{opacity:.6;filter:grayscale();flex:none}.dshmOfficeSystemPreview_name{margin:0;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,14px);word-break:break-all}.dshmOfficeSystemPreview_hint{margin:0;max-width:34em}.dshmOfficeSystemPreview_meta{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px}.dshmOfficeSystemPreview_failure{margin:0;max-width:34em;color:var(--dsw-alias-state-warn-label)}";

const tagId = "@deepseek-ai/dshm-office-system-preview/OfficeSystemPreview.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
	const tag = document.createElement("style");
	// data-plugin 必须是**本插件包名**：dsh-client-modules/lib/client.js:194-197 的
	// removeOwnedStyles(id) 按 `style[data-plugin=<模块 id>]` 精确摘除，写错就漏摘。
	tag.dataset.plugin = "@deepseek-ai/dshm-office-system-preview";
	tag.dataset.pluginCss = tagId;
	tag.textContent = css;
	document.head.appendChild(tag);
}

const zh = {
	"viewer.label": "系统预览",
	"open.action": "系统预览",
	"open.empty": "系统预览",
	"body.hint": "这个文件由系统的文档预览窗打开，侧边栏不内嵌渲染。",
	"body.done": "已交给系统预览窗。若没看到窗口，请再点一次。",
	"error.noPath": "还没拿到这个文件的绝对路径，稍后再试。",
	"error.noBridge": "当前不在 DSHM 客户端里，无法调用系统预览。",
	"error.empty": "文件路径为空，系统预览未受理。",
	"error.nouri": "系统没把这个路径转成可委托的 URI，预览未受理。",
	"error.threw": "调用系统预览时出错：{message}"
};

const en = {
	"viewer.label": "System preview",
	"open.action": "System preview",
	"open.empty": "System preview",
	"body.hint": "This file opens in the system document preview window; the sidebar does not render it inline.",
	"body.done": "Handed to the system preview window. If no window appeared, press again.",
	"error.noPath": "The file's absolute path is not available yet. Try again in a moment.",
	"error.noBridge": "Not running inside the DSHM client, so the system preview cannot be invoked.",
	"error.empty": "The file path was empty; the system preview declined it.",
	"error.nouri": "The path could not be turned into a delegatable URI; the preview declined it.",
	"error.threw": "Calling the system preview failed: {message}"
};

/** 路径的末段（`/` 与 `\` 都认）。空路径回空串。 */
function basenameOf(path) {
	const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
	return cut <= 0 ? path : path.slice(cut);
}

/**
 * 调 ArkTS 桥弹系统预览窗。
 *
 * 【为什么桥要在点击时现取】`__DSHM_BRIDGES__` 由 `javaScriptOnDocumentStart`
 * 注入（`WebApp.ets:2463`），模块求值期拿到的引用可能在页面重载后失效；
 * 且非 DSHM 环境（桌面浏览器）根本没有这个全局对象——现取才能区分这两种情况。
 *
 * @param absolutePath - 宿主给的绝对路径。
 * @returns 失败时的 locale key（含插值的已解析文本），成功返回 `null`。
 */
function invokeSystemPreview(absolutePath) {
	const target = typeof absolutePath === "string" ? absolutePath.trim() : "";
	if (target.length === 0) return { key: "error.noPath" };
	const bridges = globalThis.__DSHM_BRIDGES__;
	const call = bridges !== null && typeof bridges === "object" ? bridges.openFilePreview : void 0;
	if (typeof call !== "function") return { key: "error.noBridge" };
	try {
		const status = call.call(bridges, target);
		// 桥的返回契约见 WebApp.ets:1251-1266：'ok' 成功，其余为拒绝原因。
		if (status === "ok") return null;
		return { key: status === "empty" ? "error.empty" : "error.nouri" };
	} catch (error) {
		return { key: "error.threw", params: { message: error instanceof Error ? error.message : String(error) } };
	}
}

/** 把 invokeSystemPreview 的返回值译成一句可显示的文案。 */
function describeFailure(t, failure) {
	return failure === null ? null : t(failure.key, failure.params);
}

/**
 * 工具栏上的「系统预览」按钮（`.actions` 与 `.unpreviewable` 两个槽共用）。
 *
 * 两个槽的 owner 都是 `{absolutePath}`（`documentpreview/lib/client.js:643` 的 `fileOwner`），
 * 因此路径直接来自 props，不需要再走 `useResource`。
 *
 * @param props - owner 给的 `absolutePath`，加上 entry 级 `t`。
 * @returns 按钮本体，失败时附带一个临时的横幅。
 */
function SystemPreviewButton(props) {
	const t = props.t;
	const absolutePath = props.absolutePath;
	const prominent = props.prominent === true;
	const [banner, setBanner] = react.useState(null);
	const seq = react.useRef(0);
	const announce = (text) => {
		seq.current += 1;
		setBanner({ seq: seq.current, text });
	};
	return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
		children: [
			react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.Button, {
				variant: prominent ? "primary" : "ghost",
				size: "sm",
				icon: react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.IconRightUpOutlineRegular, { size: 14 }),
				"data-dshm-office-preview": prominent ? "empty-action" : "action",
				onClick: () => {
					announce(describeFailure(t, invokeSystemPreview(absolutePath)) ?? t("body.done"));
				},
				children: prominent ? t("open.empty") : t("open.action")
			}),
			banner === null ? null : react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.Toast, {
				text: banner.text,
				icon: react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutlineRegular, {}),
				holdMs: 4000,
				onDone: () => {
					setBanner(null);
				}
			}, banner.seq)
		]
	});
}

/** `.actions`（正常态与 unsupported 态的标题栏）里的紧凑入口。 */
function HeaderAction(props) {
	return react_jsx_runtime.jsx(SystemPreviewButton, { absolutePath: props.absolutePath, t: props.t });
}

/** `.unpreviewable`（空态失败块）里的主入口。 */
function EmptyAction(props) {
	return react_jsx_runtime.jsx(SystemPreviewButton, { absolutePath: props.absolutePath, t: props.t, prominent: true });
}

/**
 * 正文面板。
 *
 * owner props 见 `documentpreview/lib/client.js:971-985`：
 * `{resourceAddress, content, wrap, scrollportRef, addResource, setResources}`。
 * 绝对路径取法与上游 `MarkdownBody`（`:1554-1555`）一致：
 * `useResource(resourceAddress).value?.absolutePath`（`useResource` 是
 * `@deepseek-ai/dsh-client-resources` 经 `slots.provideRoot` 提供的根级 keyedHook）。
 *
 * @param props - 上述 owner props 加上 entry 级 `t`。
 * @returns 一个「不内嵌渲染、交给系统预览」的面板。
 */
function OfficeBody(props) {
	const t = props.t;
	const content = props.content;
	const absolutePath = props.useResource(props.resourceAddress).value?.absolutePath;
	const [banner, setBanner] = react.useState(null);
	const seq = react.useRef(0);
	const name = basenameOf(typeof absolutePath === "string" ? absolutePath : "");
	const bytes = content !== void 0 && content.kind === "bytes" && content.data !== void 0 ? content.data.byteLength : void 0;
	const announce = (text) => {
		seq.current += 1;
		setBanner({ seq: seq.current, text });
	};
	const run = () => {
		const failure = invokeSystemPreview(absolutePath);
		if (failure !== null) {
			announce(describeFailure(t, failure));
			return;
		}
		announce(t("body.done"));
	};
	return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
		children: [
			react_jsx_runtime.jsxs("div", {
				className: "dshmOfficeSystemPreview_empty",
				"data-dshm-office-preview": "body",
				children: [
					react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.FileTypeIcon, {
						kind: _deepseek_ai_dsh_client_ui_primitives.classifyFileType(name.length === 0 ? "file" : name),
						size: 36,
						className: "dshmOfficeSystemPreview_icon"
					}),
					name.length === 0 ? null : react_jsx_runtime.jsx("p", { className: "dshmOfficeSystemPreview_name", children: name }),
					react_jsx_runtime.jsx("p", { className: "dshmOfficeSystemPreview_hint", children: t("body.hint") }),
					bytes === void 0 ? null : react_jsx_runtime.jsx("p", {
						className: "dshmOfficeSystemPreview_meta",
						children: _deepseek_ai_dsh_client_ui_primitives.fileSizeText(bytes)
					}),
					react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "primary",
						size: "sm",
						icon: react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.IconRightUpOutlineRegular, { size: 14 }),
						"data-dshm-office-preview": "body-action",
						onClick: run,
						children: t("open.action")
					})
				]
			}),
			banner === null ? null : react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.Toast, {
				text: banner.text,
				icon: react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutlineRegular, {}),
				holdMs: 4000,
				onDone: () => {
					setBanner(null);
				}
			}, banner.seq)
		]
	});
}

/** 需要的浏览器侧服务：槽位注册、文案、实现注册表（由上游 sidebar-documentpreview 提供）。 */
const inject = ["slots", "locale", "documentPreviews"];

/**
 * 浏览器半边入口。
 * @param ctx - 客户端根上下文。
 */
function apply(ctx) {
	/*
	 * 【2026-10-05 加固：每一步各自隔离 + 认领后缀提到最前】
	 *
	 * 原实现把四个 `ctx.effect(...)` 顺序排下来。`ctx.effect` 是**同步立即执行**的，
	 * 所以其中任何一步抛错都会让整个 `apply()` 中断，后面的注册全部不生效——而
	 * 「认领 doc/docx/ppt/pptx」恰好排在第二步（文案之后）。一旦前两步里任一处抛错，
	 * 用户看到的就是内置 office 实现的
	 * 「Office 预览不可用。请在运行 DeepSeek Harness 的主机上启用文档预览服务。」
	 * 而且浏览器里没有任何会被 ArkTS 侧 `.onConsole` 抓到的痕迹（未捕获异常不走那条路），
	 * 真机上表现为"点开 PPT 没反应、也查不出原因"。
	 *
	 * 现在：
	 *   ① `documentPreviews.register` 提到最前（决定用哪个实现，最关键）；
	 *   ② 每一段独立 try/catch，互不连坐；
	 *   ③ 文案用闭包变量兜底，`locale` 失败也照样能认领（title 退化为静态字符串）。
	 */
	let titleText = "系统预览";
	try {
		ctx.effect(() => ctx.locale.register(NS, {
			zh,
			en
		}), "dshm-office-system-preview: dictionaries");
		titleText = ctx.locale.bind(NS)("viewer.label");
	} catch (error) {
		// 文案失败不影响认领：title 退化成下面的静态字符串
	}
	try {
		ctx.effect(() => ctx.documentPreviews.register({
			id: ID,
			extensions: EXTENSIONS,
			// binaryExtensions 必须是 extensions 的子集（registry 会校验），这里相等：
			// 这四个后缀的字节从来不是可读文本。
			binaryExtensions: EXTENSIONS,
			// 非 "builtin" ⇒ 排序 rank 1，一定排在 rank 0 的内置 office 实现之前。
			priority: "extension",
			title: () => titleText,
			// 【2026-10-05 改：bytes-complete → text-pages】
			// 原为 "bytes-complete"（由宿主整读文件后把 content 交给正文）。真机实测：
			// `workspaceFiles/readBytes` 从 10/05 起**每次都被客户端立刻取消**
			// ——宿主日志（dshm-host.log，不轮转）里 10/04 是 3 请求 / 3 成功 / 0 取消，
			// 10/05 变成 78 请求 / 78 取消 / 0 成功，取消耗时只有 3–13 ms；同期
			// `workspaceFiles/stat`、`workspaceFiles/read` 一直 200。取消 ⇒ 宿主的
			// `bridge()`（dsh-client-connection/lib/index.js:36-38）见连接关闭就 abort，
			// 响应流里每个 chunk 被 `continue` 跳过、最后 `res.end()` 什么都不写 ⇒
			// ArkWeb 记 ERR_EMPTY_RESPONSE ⇒ 前端显示 "读取失败：… Failed to fetch"。
			// 结果：正文永远拿不到 content，一直停在空态，工具栏入口也不出现。
			//
			// 本插件的正文**不渲染文件内容**（只显示文件名 + 「系统预览」按钮），
			// 所以根本不需要整读。改用 "text-pages" ⇒ 走的是**正常可用**的
			// `workspaceFiles/read`（10/05 实测 200）；二进制文件会被判为不支持 ⇒
			// 落到侧栏的 "unsupported" 分支，而**那个分支会渲染 `.actions` 槽**
			// （上游 `lib/client.js:798` 的 `renderSlot("sidebar.right.tab.document.actions", fileOwner)`）
			// ⇒ 我们的「系统预览」按钮得以出现并可用。
			// ⚠️ 若哪天 readBytes 恢复（宿主侧那 78/78 的取消消失），可以再评估换回 bytes-complete。
			loading: "text-pages",
			wrap: false
		}), "dshm-office-system-preview: metadata");
	} catch (error) {
		// 认领失败 ⇒ 内置实现继续接管（用户会看到"Office 预览不可用"），
		// 但仍然把下面的槽位注册完，工具栏/空态按钮至少还有机会出现。
	}
	/**
	 * 注册一个槽位，**单个失败不影响其它**。
	 * @param name - 槽位名。
	 * @param field - 该槽位用来对齐的字段名（正文槽是 `key`，两个按钮槽是 `id`）。
	 * @param value - 字段值（一律是本插件标识）。
	 * @param component - 槽位组件。
	 * @param label - cordis effect 标签。
	 */
	const registerSlot = (name, field, value, component, label) => {
		try {
			ctx.effect(() => ctx.slots.inject(name, () => ctx.slots.register({
				name,
				[field]: value,
				locale: NS
			}, component)), label);
		} catch (error) {
			// 单个槽位失败（例如槽位已被别人声明）不影响其它槽位
		}
	};
	registerSlot("sidebar.right.tab.document", "key", ID, OfficeBody, "dshm-office-system-preview: body");
	registerSlot("sidebar.right.tab.document.actions", "id", "dshm-office-system-preview", HeaderAction, "dshm-office-system-preview: header action");
	registerSlot("sidebar.right.tab.document.unpreviewable", "id", "dshm-office-system-preview", EmptyAction, "dshm-office-system-preview: empty action");
}

exports.apply = apply;
exports.inject = inject;
return module.exports;
}
});

//# sourceMappingURL=client.js.map
