window.__ModuleLoader__.load({
	id: "@deepseek-ai/dshm-read-aloud",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");

/**
 * DSHM 原生朗读/分享插件 —— 浏览器半边。
 *
 * 【入口】官方 `conversation.chat.assistant-actions` 列表槽（与点赞/点踩同一条动作条），
 * 只负责在**已完成**的助手消息上放两枚按钮：
 *   · 朗读 → `__DSHM_BRIDGES__.readAloud(text)` → Speech Kit TextReader（失败降级 TTS）
 *   · 分享 → `__DSHM_BRIDGES__.shareText(text)` → Share Kit 系统面板
 *
 * 【为什么不在 Web 侧合成】Web 侧没有系统 TTS/TextReader；chat-demo 那套 WebAudio +
 * 服务端 TTS 在 DSHM 上既多一次网络与密钥，也绕开了系统的后台/通知/AVSession。
 * 本插件只取正文纯文本，合成、播放、面板、后台全部交给 ArkTS。
 *
 * 【为什么不做 DOM 注入】设置面板的四版 DOM 注入都被 React 重渲染冲掉（docs/311-319）；
 * 动作条同理。走官方 slot，由官方 React 渲染，插件卸载时随 `ctx.slots` 回收。
 *
 * 【正文从哪来】槽入口只收 `messageId`；`useChat` 是会话标准 Hook，按 `legacy.nodes`
 * 找到对应的 assistant 节点，拼 `kind === 'text'` 的块。找不到就禁用按钮（不猜内容）。
 *
 * @module @deepseek-ai/dshm-read-aloud/client
 */

/** 本插件的模块 id / 包名。 */
const PKG = '@deepseek-ai/dshm-read-aloud';

/** 动作条按钮的通用内联样式（官方 action strip 用 hashed CSS，插件不复制它）。 */
const BUTTON_STYLE = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: 24,
	height: 24,
	padding: 0,
	border: 0,
	borderRadius: 6,
	background: 'transparent',
	color: 'inherit',
	cursor: 'pointer',
	opacity: 1
};

const DISABLED_STYLE = {
	opacity: 0.4,
	cursor: 'default'
};

/** 从一个 assistant 节点拼出纯文本（只取 text 块，思考/工具不朗读）。 */
function textOfNode(node) {
	if (!node || node.kind !== 'assistant' || !Array.isArray(node.blocks)) {
		return '';
	}
	const parts = [];
	for (let i = 0; i < node.blocks.length; i++) {
		const block = node.blocks[i];
		if (block && block.kind === 'text' && typeof block.text === 'string') {
			parts.push(block.text);
		}
	}
	return parts.join('');
}

/**
 * 把正文 Markdown 变成适合朗读/分享的纯文本。
 *
 * 【为什么在 Web 侧做】ArkTS 侧只有系统 TTS/TextReader，不该再解析 Markdown；
 * chat-demo 的 `filter_markdown` 是服务端能力，端侧没有对应开关。这里做最小清洗：
 * 去掉围栏代码、图片/链接目标、强调标记、标题/列表/引用前缀与表格分隔行；
 * 宁可少读一点，也不要把 `**`、反引号和 URL 念出来。
 */
function speechTextOf(markdown) {
	let text = String(markdown || '');
	text = text.replace(/```[\s\S]*?```/g, '\n');
	text = text.replace(/~~~[\s\S]*?~~~/g, '\n');
	text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
	text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
	text = text.replace(/<\/?[a-zA-Z][^>]*>/g, '');
	text = text.replace(/^[ \t]{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '');
	text = text.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, '');
	text = text.replace(/\|/g, '，');
	text = text.replace(/(\*\*|__|~~|\*|_|`)/g, '');
	text = text.replace(/[ \t]+\n/g, '\n');
	text = text.replace(/\n{3,}/g, '\n\n');
	return text.trim();
}

/** 在会话快照里按 messageId 找助手正文；找不到返回空串。 */
function findAssistantText(snapshot, messageId) {
	if (!snapshot || !snapshot.legacy || !Array.isArray(snapshot.legacy.nodes)) {
		return '';
	}
	const nodes = snapshot.legacy.nodes;
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		if (node && node.kind === 'assistant' && node.messageId === messageId) {
			return textOfNode(node);
		}
	}
	return '';
}

/** 扬声器图标（16×16，跟随 currentColor）。 */
function speakerIcon() {
	return React.createElement('svg', {
		width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
		stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
		'aria-hidden': 'true'
	},
		React.createElement('path', { d: 'M4 9v6h4l5 4V5L8 9H4z' }),
		React.createElement('path', { d: 'M16.5 8.5a5 5 0 0 1 0 7' }),
		React.createElement('path', { d: 'M19 6a8.5 8.5 0 0 1 0 12' })
	);
}

/** 分享图标（16×16）。 */
function shareIcon() {
	return React.createElement('svg', {
		width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
		stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
		'aria-hidden': 'true'
	},
		React.createElement('path', { d: 'M12 3v11' }),
		React.createElement('path', { d: 'M8 7l4-4 4 4' }),
		React.createElement('path', { d: 'M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6' })
	);
}

/**
 * 动作条入口的防御壳：`useChat` 是会话标准 Hook，但插件可能被装到非会话槽位
 * 或未来上游改了 props 形状。缺它时**整条返回 null**（不调 Hook、不炸动作条）。
 */
function ReadAloudAction(props) {
	if (typeof props.useChat !== 'function') {
		return null;
	}
	return React.createElement(ReadAloudButtons, props);
}

/**
 * 一条助手消息的两枚动作。`useChat` 由会话标准 props 注入；桥由 ArkTS 的
 * `javaScriptProxy` 注册。两者任一缺失都禁用按钮，不静默失败。
 */
function ReadAloudButtons(props) {
	const messageId = props.messageId;
	const selector = React.useMemo(function () {
		return function (snapshot) {
			return findAssistantText(snapshot, messageId);
		};
	}, [messageId]);
	const text = props.useChat(selector);
	const spoken = React.useMemo(function () {
		return speechTextOf(text);
	}, [text]);
	const bridge = typeof globalThis !== 'undefined' ? globalThis.__DSHM_BRIDGES__ : undefined;
	const hasText = spoken.length > 0;
	const canRead = hasText && bridge && typeof bridge.readAloud === 'function';
	const canShare = hasText && bridge && typeof bridge.shareText === 'function';

	const onRead = React.useCallback(function () {
		if (canRead) {
			bridge.readAloud(spoken);
		}
	}, [bridge, canRead, spoken]);

	const onShare = React.useCallback(function () {
		if (canShare) {
			bridge.shareText(spoken);
		}
	}, [bridge, canShare, spoken]);

	return React.createElement('span', {
		'data-dshm-read-aloud': '1',
		style: { display: 'inline-flex', alignItems: 'center', gap: 2 }
	},
		React.createElement('button', {
			type: 'button',
			title: '朗读',
			'aria-label': '朗读这条回答',
			disabled: !canRead,
			onClick: onRead,
			style: canRead ? BUTTON_STYLE : Object.assign({}, BUTTON_STYLE, DISABLED_STYLE)
		}, speakerIcon()),
		React.createElement('button', {
			type: 'button',
			title: '分享',
			'aria-label': '分享这条回答',
			disabled: !canShare,
			onClick: onShare,
			style: canShare ? BUTTON_STYLE : Object.assign({}, BUTTON_STYLE, DISABLED_STYLE)
		}, shareIcon())
	);
}

/** 注册动作条入口（官方 list slot；插件卸载时由 cordis 回收）。 */
function apply(ctx) {
	ctx.slots.inject('conversation.chat.assistant-actions', function () {
		return ctx.slots.register({
			name: 'conversation.chat.assistant-actions',
			id: 'dshm-read-aloud',
			order: 20
		}, ReadAloudAction);
	});
}

/** 本插件依赖的客户端服务。 */
const inject = ['slots'];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
