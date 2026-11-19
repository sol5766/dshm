/**
 * DSHM 云同步插件 —— 浏览器半边（**官方设置里的「云同步」分区**，docs/319）。
 *
 * ── 为什么做成插件（而不是再注一次 DOM）────────────────────────────────
 * 前四版入口在手持档全部失败（见 docs/311/315/316/317/318）：
 * 顶栏菜单（手机无顶栏）、账号菜单注入（手机不可达）、手持浮钮（真机未见）、
 * DOM 注入设置面板（PC 有、手机被 React 重渲染冲掉）。
 *
 * 用户裁决（2026-10-30）：「那就按插件的形式去做，只是直接内置而已」。
 * 插件走官方 `settings.section` 槽位注册，分区由**官方** React 渲染：
 * 与「通用设置 / 内置插件」等分区同构 ⇒ 不存在"被冲掉"或"样式对不齐"。
 *
 * ── 这一版做到了什么（第二步：可交互）────────────────────────────────
 * 第一步（只读四行）已证明"分区出得来"；本版把它做成**完整功能面**：
 *   · 华为账号：登录 / 退出；
 *   · 云服务：开关、[上传]、[拉取并导入]；
 *   · 当前任务：阶段 + 进度条 + 成功/失败/跳过（三段任务分开显示）；
 *   · 同步内容：会话/附件、技能、插件清单的真实计数；
 *   · 插件恢复：入口（逐项勾选落到原生面板，见下）。
 *
 * ── 登录**不再跳任何界面**（2026-10-31，docs/323）──────────────────────
 * 旧版点「登录」由桥打开原生面板，再在面板里完成授权 —— 用户明确反对这种"二级菜单"
 * 与前后 UI 割裂（docs/322）。现在登录走 `silentSignIn()`（`forceLogin:false` 的静默授权）：
 * 壳在**当前进程内**直接取 UnionID，成功与否经 `cloudSyncState()` 回流到这张分区，
 * 网页侧只负责发一次 `login` 动作，**不产生任何新界面**。
 *
 * 仍会落到原生面板的只有**插件恢复**（要逐项多选，官方分区没有现成的多选控件）。
 *
 * ── 数据从哪来 ────────────────────────────────────────────────────────
 * `globalThis.__DSHM_BRIDGES__.cloudSyncState()` —— 同步返回一段 JSON；
 * 动作走 `__DSHM_BRIDGES__.cloudSyncAction(action)` —— 同步受理，结果回流到状态里
 * （长任务不可能同步返回；插件每秒轮询状态，任务结束自然可见）。
 * 桥未就位时显示"尚未就绪"，**不编造状态**（docs/313 §12.3「不得假成功」）。
 *
 * @module dshm-cloud-sync/client
 */

/** 本插件的模块 id / 包名（样式登记与摘除按它精确匹配）。 */
const PKG = '@deepseek-ai/dshm-cloud-sync';

/** 样式标签的登记 id（`<style data-plugin-css=…>`，与官方插件的登记口径一致）。 */
const CSS_TAG = PKG + '/CloudSync.module.css';

/** React.createElement 的短名（分区由官方 React 渲染；本文件不直接 require react/jsx-runtime）。 */
const jsx = React.createElement;

/** locale 命名空间（本插件自有，避免与上游撞名）。 */
const NS = 'settings.cloudsync';

/**
 * 轮询周期（ms）。
 *
 * 【2026-10-31 性能收口（docs/322）】旧值是 1000ms，且**页面不可见时照跑**：
 * 设置面板关掉后组件不一定马上卸载（分区内容被官方缓存在 DOM 里），
 * 于是后台每秒仍跨一次 ArkWeb 边界 + 触发一次原生状态拼接。
 *
 * 现在两档：
 *   · 可见（`document.visibilityState !== 'hidden'` 且分区在视口内）→ `POLL_MS`；
 *   · 不可见 → **停摆**（`visibilitychange` / 组件卸载时 clearInterval），
 *     重新可见时立刻补一拍（`tick()`），不会出现"切回来还是旧数"。
 * 与仓库既有垫片（侧栏 / 设置 / 引导）的"失焦停摆"是同一套纪律。
 */
const POLL_MS = 1500;

/**
 * 状态刷新最小间隔（原生侧统计节流的镜像，单位 ms）。
 *
 * 【为什么还要在插件侧限一次】原生 `cloudSyncState()` 每次调用都会顺手发起一次
 * RDB 统计查询（`refreshCloudStats`）；面板轮询再快也没用 —— 统计由原生侧节流，
 * 这里只是不再制造无谓的跨边界调用。
 */
const MIN_REFRESH_MS = 800;

/**
 * 安全取桥。
 *
 * 【为什么每次现取】`__DSHM_BRIDGES__` 由 javaScriptProxy 在页面层注册，
 * 与插件脚本的加载时机不保证同序（仓库既有插件的同一教训）。
 */
function bridge() {
	try {
		const b = globalThis.__DSHM_BRIDGES__;
		return b === undefined || b === null ? null : b;
	} catch (e) {
		return null;
	}
}

/** 状态缺省值：桥不在时的诚实形态（`ready:false`）。 */
function emptyState() {
	return {
		ready: false,
		signedIn: false,
		maskedUnionId: '',
		/* docs/378：账号展示名（昵称 / 匿名手机号 / 匿名邮箱）；老壳无此字段时回退「已登录」 */
		accountLabel: '',
		displayName: '华为账号用户',
		cloudText: '尚未检测',
		cloudOk: false,
		cloudBadge: '未检测',
		enabled: false,
		lastSyncText: '',
		pendingSessions: 0,
		pendingBytes: 0,
		pluginCount: 0,
		plugins: [],
		units: {},
		busy: false,
		progress: null
	};
}

/** 读一次同步状态（同步桥，解析失败按未就绪处理）。 */
function readState() {
	const b = bridge();
	if (b === null || typeof b.cloudSyncState !== 'function') {
		return emptyState();
	}
	let raw = '';
	try {
		raw = b.cloudSyncState();
	} catch (e) {
		return emptyState();
	}
	if (typeof raw !== 'string' || raw.length === 0) {
		return emptyState();
	}
	let parsed = null;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		return emptyState();
	}
	if (parsed === null || typeof parsed !== 'object' || parsed.ready !== true) {
		return emptyState();
	}
	const base = emptyState();
	const pick = (key) => (parsed[key] === undefined || parsed[key] === null ? base[key] : parsed[key]);
	const progress = parsed.progress !== null && typeof parsed.progress === 'object'
		? {
			task: String(parsed.progress.task || ''),
			stage: String(parsed.progress.stage || ''),
			total: Number(parsed.progress.total) || 0,
			succeeded: Number(parsed.progress.succeeded) || 0,
			failed: Number(parsed.progress.failed) || 0,
			skipped: Number(parsed.progress.skipped) || 0,
			note: String(parsed.progress.note || ''),
			finished: parsed.progress.finished === true
		}
		: null;
	const plugins = Array.isArray(parsed.plugins)
		? parsed.plugins
			.filter((p) => p !== null && typeof p === 'object' && typeof p.name === 'string')
			.map((p) => ({
				name: p.name,
				spec: typeof p.spec === 'string' ? p.spec : '',
				kind: typeof p.kind === 'string' ? p.kind : 'npm'
			}))
		: [];
	const units = parsed.units !== null && typeof parsed.units === 'object' ? parsed.units : {};
	return {
		ready: true,
		signedIn: parsed.signedIn === true,
		maskedUnionId: String(pick('maskedUnionId')),
		accountLabel: String(pick('accountLabel')),
		displayName: String(pick('displayName')),
		cloudText: String(pick('cloudText')),
		cloudOk: parsed.cloudOk === true,
		cloudBadge: String(pick('cloudBadge')),
		enabled: parsed.enabled === true,
		lastSyncText: String(pick('lastSyncText')),
		pendingSessions: Number(pick('pendingSessions')) || 0,
		pendingBytes: Number(pick('pendingBytes')) || 0,
		pluginCount: Number(pick('pluginCount')) || 0,
		plugins: plugins,
		units: units,
		busy: parsed.busy === true,
		progress: progress
	};
}

/**
 * 发送一个动作。
 *
 * @param action `login` / `signout` / `enable` / `disable` / `upload` / `pull` / `restore`
 * @returns `{ok, message}`；桥不在 ⇒ `{ok:false, message:'原生桥未就绪'}`
 */
function sendAction(action) {
	const b = bridge();
	if (b === null || typeof b.cloudSyncAction !== 'function') {
		return { ok: false, message: '原生桥未就绪' };
	}
	let raw = '';
	try {
		raw = b.cloudSyncAction(action);
	} catch (e) {
		return { ok: false, message: '动作调用失败' };
	}
	if (typeof raw !== 'string' || raw.length === 0) {
		return { ok: false, message: '原生侧没有回执' };
	}
	try {
		const r = JSON.parse(raw);
		return { ok: r.ok === true, message: typeof r.message === 'string' ? r.message : '' };
	} catch (e) {
		return { ok: false, message: '回执格式不可读' };
	}
}

/** 字节数转可读文案（与原生侧同一口径：B / KB / MB / GB）。 */
function bytesText(bytes) {
	const n = typeof bytes === 'number' && isFinite(bytes) ? bytes : 0;
	if (n < 1024) {
		return n + ' B';
	}
	if (n < 1024 * 1024) {
		return (n / 1024).toFixed(1) + ' KB';
	}
	if (n < 1024 * 1024 * 1024) {
		return (n / (1024 * 1024)).toFixed(1) + ' MB';
	}
	return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/** 同步表里某一类内容的记录数（同步过多少；没有算过就显示"—"）。 */
function unitText(units, kind) {
	const u = units === null || units === undefined ? undefined : units[kind];
	if (u === undefined || u === null || typeof u.count !== 'number') {
		return '';
	}
	if (u.count === 0) {
		return '尚未同步';
	}
	return '已同步 ' + u.count + ' 项 · ' + bytesText(Number(u.bytes) || 0);
}

/** 阶段码 → 用户能懂的词（与原生 `SyncProgressCard.stageText` 同一口径）。 */
const STAGE_TEXT = {
	scan: '扫描',
	stage_file: '准备文件',
	write_db: '写入同步表',
	cloud_sync: '云端同步',
	verify: '核对',
	discover: '发现变更',
	fetch_meta: '取元数据',
	fetch_asset: '下载内容',
	ready: '待导入',
	map_workspace: '映射工作区',
	stage: '暂存',
	commit: '落位',
	verify_usable: '可用性验收',
	done: '完成'
};

/** 任务码 → 进度条标题。 */
const TASK_TEXT = { upload: '上传进度', pull: '拉取进度', import: '导入进度', plugins: '插件安装' };

/** 进度比例：失败的也算"已处理"，不然进度条永远停在 99%。 */
function ratio(p) {
	if (p === null || p.total <= 0) {
		return 0;
	}
	const done = p.succeeded + p.failed + p.skipped;
	return Math.max(0, Math.min(1, done / p.total));
}

/* ── 样式：全部走官方设计 token（不写死颜色，主题切换自动跟随）────────── */
const CSS = [
	'.dshmCloud_group{display:flex;flex-direction:column;border-bottom:.5px solid var(--dsw-alias-border-l2);padding:16px 0}',
	'.dshmCloud_groupLast{border-bottom:0}',
	'.dshmCloud_title{margin:0 0 8px;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
	'.dshmCloud_row{display:flex;align-items:center;gap:16px;min-height:44px;padding:8px 0;box-sizing:border-box}',
	'.dshmCloud_rowMain{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:0}',
	'.dshmCloud_label{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}',
	'.dshmCloud_hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
	'.dshmCloud_value{flex:none;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}',
	'.dshmCloud_ok{color:var(--dsw-alias-state-success-primary)}',
	'.dshmCloud_warn{color:var(--dsw-alias-state-warn-primary)}',
	'.dshmCloud_bad{color:var(--dsw-alias-state-error-primary)}',
	'.dshmCloud_actions{display:flex;flex-wrap:wrap;gap:8px;padding:4px 0 0}',
	'.dshmCloud_btn{font:inherit;font-size:13px;line-height:20px;padding:7px 14px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l4);background:0 0;color:var(--dsw-alias-label-primary);cursor:pointer}',
	'.dshmCloud_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
	'.dshmCloud_btn:disabled{opacity:.45;cursor:default}',
	'.dshmCloud_btnPrimary{border-color:transparent;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}',
	'.dshmCloud_switch{display:flex;align-items:center;gap:8px;flex:none}',
	'.dshmCloud_track{position:relative;width:40px;height:22px;border-radius:11px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-interactive-bg-hover);cursor:pointer;transition:background .15s}',
	'.dshmCloud_trackOn{background:var(--dsw-alias-state-success-primary);border-color:transparent}',
	'.dshmCloud_knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}',
	'.dshmCloud_knobOn{left:20px}',
	'.dshmCloud_bar{position:relative;height:6px;border-radius:3px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden;margin:6px 0}',
	'.dshmCloud_barFill{position:absolute;left:0;top:0;bottom:0;background:var(--dsw-alias-state-success-primary);transition:width .2s}',
	'.dshmCloud_barWarn{background:var(--dsw-alias-state-warn-primary)}',
	'.dshmCloud_counts{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
	'.dshmCloud_notice{display:flex;gap:8px;align-items:flex-start;margin:0 0 12px;padding:10px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px}',
	'.dshmCloud_noticeErr{color:var(--dsw-alias-state-warn-label)}',
	'.dshmCloud_scope{display:flex;flex-wrap:wrap;gap:6px 18px;margin:8px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
	'.dshmCloud_scopeNo{color:var(--dsw-alias-label-tertiary)}'
].join('');

/* ── 行与分组（本插件自有实现：不依赖 primitives 的内部行语义）──────── */
function Row(props) {
	const { title, hint, value, valueClass } = props;
	const children = [
		jsx('div', {
			key: 'main',
			className: 'dshmCloud_rowMain',
			children: [
				jsx('div', { key: 't', className: 'dshmCloud_label', children: title }),
				hint === undefined || hint === null || hint === ''
					? null
					: jsx('p', { key: 'h', className: 'dshmCloud_hint', children: hint })
			]
		})
	];
	if (value !== undefined && value !== null && value !== '') {
		children.push(jsx('div', {
			key: 'v',
			className: 'dshmCloud_value' + (valueClass ? ' ' + valueClass : ''),
			children: value
		}));
	}
	return jsx('div', { className: 'dshmCloud_row', children: children });
}

function Group(props) {
	const { title, last, children } = props;
	const kids = [];
	if (title !== undefined && title !== null) {
		kids.push(jsx('div', { key: 'title', className: 'dshmCloud_title', children: title }));
	}
	/* children 可能是数组也可能是单个子节点（React 两种都允许）⇒ 一律摊平 */
	for (const child of [].concat(children === undefined ? [] : children)) {
		kids.push(child);
	}
	return jsx('div', {
		className: 'dshmCloud_group' + (last ? ' dshmCloud_groupLast' : ''),
		children: kids.length === 1 ? kids[0] : kids
	});
}

function Button(props) {
	const { label, onClick, disabled, primary } = props;
	return jsx('button', {
		type: 'button',
		className: 'dshmCloud_btn' + (primary ? ' dshmCloud_btnPrimary' : ''),
		disabled: disabled === true,
		onClick: onClick,
		children: label
	});
}

/** 开关（官方设置里同款：胶囊轨道 + 圆点；`role="switch"` 让无障碍读得出状态）。 */
function Switch(props) {
	const { checked, disabled, label, onChange } = props;
	return jsx('div', {
		className: 'dshmCloud_switch',
		children: jsx('div', {
			role: 'switch',
			tabIndex: disabled === true ? -1 : 0,
			'aria-checked': checked === true,
			'aria-label': label,
			'data-disabled': disabled === true,
			className: 'dshmCloud_track' + (checked === true ? ' dshmCloud_trackOn' : ''),
			onClick: () => {
				if (disabled === true) {
					return;
				}
				if (onChange) {
					onChange(!checked);
				}
			},
			children: jsx('div', { className: 'dshmCloud_knob' + (checked === true ? ' dshmCloud_knobOn' : '') })
		})
	});
}

/** 进度块：阶段名 + 进度条 + 成功/失败/跳过计数（三段任务各自的标题）。 */
function ProgressBlock(props) {
	const { p } = props;
	if (p === null) {
		return null;
	}
	const pct = Math.round(ratio(p) * 100);
	const stage = STAGE_TEXT[p.stage] || p.stage || '';
	const title = TASK_TEXT[p.task] || '同步进度';
	return jsx('div', {
		className: 'dshmCloud_rowMain',
		children: [
			jsx('div', {
				key: 'head',
				className: 'dshmCloud_row',
				children: [
					jsx('div', { key: 'm', className: 'dshmCloud_rowMain', children: jsx('div', { className: 'dshmCloud_label', children: title }) }),
					jsx('div', { key: 's', className: 'dshmCloud_value', children: stage })
				]
			}),
			jsx('div', {
				key: 'bar',
				className: 'dshmCloud_bar',
				children: jsx('div', {
					className: 'dshmCloud_barFill' + (p.failed > 0 ? ' dshmCloud_barWarn' : ''),
					style: { width: pct + '%' }
				})
			}),
			jsx('p', { key: 'note', className: 'dshmCloud_hint', children: p.note }),
			jsx('div', {
				key: 'counts',
				className: 'dshmCloud_counts',
				children: [
					jsx('span', { key: 'ok', children: '成功 ' + p.succeeded }),
					p.failed > 0 ? jsx('span', { key: 'fail', children: '失败 ' + p.failed }) : null,
					p.skipped > 0 ? jsx('span', { key: 'skip', children: '跳过 ' + p.skipped }) : null,
					jsx('span', { key: 'all', children: (p.succeeded + p.failed + p.skipped) + '/' + p.total })
				]
			})
		]
	});
}

/** 同步范围：正反两面都写清（用户要做的决定是"要不要把数据交给云端"）。 */
function ScopeList() {
	const yes = ['会话记录与附件', '技能', '插件清单（只记安装地址）'];
	const no = ['核心运行库与缓存', '账号凭据与授权码', '本机绝对路径'];
	const kids = [];
	for (let i = 0; i < yes.length; i++) {
		kids.push(jsx('span', { key: 'y' + i, children: '✓ ' + yes[i] }));
	}
	for (let i = 0; i < no.length; i++) {
		kids.push(jsx('span', { key: 'n' + i, className: 'dshmCloud_scopeNo', children: '✕ ' + no[i] }));
	}
	return jsx('div', { className: 'dshmCloud_scope', children: kids });
}

/**
 * 云同步设置分区。
 *
 * 【刷新策略】桥是同步的，但状态会变（长任务在原生侧跑）。**1500ms** 轮询，
 * 且页面不可见时**停摆**（docs/322 性能收口；旧的"1s 轮询、不可见照跑"已废弃）；
 * 面板关闭后组件卸载、定时器在清理里停掉，不留悬挂。
 * 【本地提示】动作的被拒原因放组件自己的 notice，随下一次成功动作清掉 ——
 * 它是"刚才那一下怎么了"的一次性反馈，不该污染状态读数。
 */
function CloudSyncSection(ownerProps) {
	const [state, setState] = React.useState(readState);
	const [notice, setNotice] = React.useState({ text: '', error: false });
	/* 上一拍的时间戳（`MIN_REFRESH_MS` 的判据；放闭包里，不进 React 状态） */
	let lastRefreshAt = 0;
	React.useEffect(() => {
		let timer = 0;
		const visible = () => {
			try {
				return typeof document === 'undefined' || document.visibilityState !== 'hidden';
			} catch (e) {
				return true;
			}
		};
		const tick = () => {
			if (!visible()) {
				return;
			}
			const now = Date.now();
			if (now - lastRefreshAt < MIN_REFRESH_MS) {
				return;
			}
			lastRefreshAt = now;
			setState(readState());
		};
		const start = () => {
			if (timer !== 0) {
				return;
			}
			timer = setInterval(tick, POLL_MS);
		};
		const stop = () => {
			if (timer === 0) {
				return;
			}
			clearInterval(timer);
			timer = 0;
		};
		/* 失焦停摆：页面不可见时**零开销**，可见瞬间补一拍 */
		const onVisibility = () => {
			if (visible()) {
				tick();
				start();
			} else {
				stop();
			}
		};
		start();
		try {
			if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
				document.addEventListener('visibilitychange', onVisibility);
			}
		} catch (e) { /* 无 document：退化为纯定时器 */ }
		return () => {
			stop();
			try {
				if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
					document.removeEventListener('visibilitychange', onVisibility);
				}
			} catch (e) { /* 同上 */ }
		};
	}, []);

	const act = (action, okText) => {
		const r = sendAction(action);
		if (!r.ok) {
			setNotice({ text: r.message || '操作未受理', error: true });
			return;
		}
		setNotice({ text: okText || r.message, error: false });
		setState(readState());
	};

	const groups = [];

	/* ── ① 华为账号 ───────────────────────────────────────────────── */
	if (!state.signedIn) {
		groups.push(jsx(Group, {
			key: 'account',
			title: '华为账号',
			children: [
				jsx(Row, {
					key: 'r',
					title: '未登录',
					hint: '登录后，换到另一台设备用同一个华为账号即可拉取并导入，继续之前的工作。'
				}),
				jsx('div', {
					key: 'a',
					className: 'dshmCloud_actions',
					children: [jsx(Button, { label: '登录华为账号', primary: true, onClick: () => act('login', '已打开登录面板') })]
				})
			]
		}));
	} else {
		groups.push(jsx(Group, {
			key: 'account',
			title: '华为账号',
			children: [
				jsx(Row, {
					key: 'id',
				title: state.displayName,
				/* docs/378：不再用 ****abcd（脱敏 UnionID）冒充账号；老壳无该字段时说人话 */
				hint: '华为账号 ' + (state.accountLabel || '已登录'),
					value: state.cloudBadge,
					valueClass: state.cloudOk ? 'dshmCloud_ok' : 'dshmCloud_warn'
				}),
				jsx('div', {
					key: 'a',
					className: 'dshmCloud_actions',
					children: [jsx(Button, { label: '退出登录', onClick: () => act('signout', '已退出华为账号') })]
				})
			]
		}));
	}

	/* ── ② 云同步（开关 + 两个动作 + 当前任务）────────────────────── */
	if (state.signedIn) {
		const busy = state.busy;
		const children = [
			jsx(Row, {
				key: 'sw',
				title: '开启云同步',
				hint: state.enabled ? '数据变更后可同步到云端' : '关闭后仅在本机保存，不会上传',
				value: state.enabled ? '已开启' : '已关闭',
				valueClass: state.enabled ? 'dshmCloud_ok' : undefined
			}),
			jsx('div', {
				key: 'sa',
				className: 'dshmCloud_actions',
				children: jsx(Switch, {
					checked: state.enabled,
					disabled: busy,
					label: '开启云同步',
					onChange: (on) => act(on ? 'enable' : 'disable')
				})
			}),
			jsx(Row, {
				key: 'svc',
				title: '云服务',
				hint: state.cloudText,
				value: state.cloudBadge,
				valueClass: state.cloudOk ? 'dshmCloud_ok' : 'dshmCloud_warn'
			}),
			/*
			 * 上传与拉取**不是同一件事**：一个是往上备份、一个是往下取。
			 * 做成两个按钮而不是一个"同步"，用户才知道自己在做什么（docs/313 §4.2）。
			 */
			jsx('div', {
				key: 'acts',
				className: 'dshmCloud_actions',
				children: [
					jsx(Button, { key: 'up', label: busy ? '进行中…' : '上传本机数据', primary: true, disabled: busy || !state.enabled, onClick: () => act('upload') }),
					jsx(Button, { key: 'pull', label: busy ? '进行中…' : '拉取并导入', disabled: busy, onClick: () => act('pull') })
				]
			}),
			jsx('p', {
				key: 'last',
				className: 'dshmCloud_hint',
				children: state.lastSyncText.length > 0 ? '最近一次：' + state.lastSyncText : '还没有同步过'
			}),
			busy ? jsx(ProgressBlock, { key: 'prog', p: state.progress }) : null
		];
		groups.push(jsx(Group, { key: 'sync', title: '云同步', children: children }));
	}

	/* ── ③ 同步内容（真实计数：本机多少个 + 同步表里多少条）────────────── */
	if (state.signedIn) {
		const sessionSynced = unitText(state.units, 'session');
		const skillSynced = unitText(state.units, 'skill');
		const pluginSynced = unitText(state.units, 'plugin_manifest');
		const pluginHints = [];
		if (state.pluginCount === 0) {
			pluginHints.push('本机没有安装用户插件');
		} else {
			for (let i = 0; i < state.plugins.length; i++) {
				const item = state.plugins[i];
				/* 只给"装的是什么"：npm 版本号原样、GitHub 地址只留 owner/repo（不显示凭据型 URL） */
				pluginHints.push(item.name + (item.kind === 'git' ? '（GitHub）' : ''));
			}
			if (state.pluginCount > state.plugins.length) {
				pluginHints.push('…另有 ' + (state.pluginCount - state.plugins.length) + ' 个');
			}
		}
		groups.push(jsx(Group, {
			key: 'content',
			title: '同步内容',
			children: [
				jsx(Row, {
					key: 'sess',
					title: '会话记录与附件',
					hint: sessionSynced === '' ? '会话记录与附件会随华为账号同步' : sessionSynced,
					value: state.pendingSessions === 0 ? '—' : state.pendingSessions + ' 个 · ' + bytesText(state.pendingBytes)
				}),
				jsx(Row, {
					key: 'skill',
					title: '技能',
					hint: skillSynced === '' ? '技能文件（体积小，随账号走）' : skillSynced,
					value: ''
				}),
				jsx(Row, {
					key: 'plug',
					title: '插件清单',
					hint: pluginHints.join(' · '),
					value: pluginSynced === '' ? (state.pluginCount === 0 ? '未安装' : state.pluginCount + ' 个') : pluginSynced
				}),
				jsx('div', {
					key: 'restore',
					className: 'dshmCloud_actions',
					children: jsx(Button, { label: '从云端恢复插件', onClick: () => act('restore', '已打开插件恢复') })
				}),
				jsx(ScopeList, { key: 'scope' })
			]
		}));
	}

	if (!state.ready) {
		return jsx('div', {
			className: 'dshmCloud_hint',
			style: { padding: '16px 0' },
			children: '云同步尚未就绪（原生桥未挂载）。'
		});
	}

	const kids = [];
	if (notice.text.length > 0) {
		kids.push(jsx('div', {
			key: 'notice',
			className: 'dshmCloud_notice' + (notice.error ? ' dshmCloud_noticeErr' : ''),
			children: [
				jsx('span', { key: 'i', children: notice.error ? '⚠' : '✓' }),
				jsx('span', { key: 't', children: notice.text })
			]
		}));
	}
	for (const g of groups) {
		kids.push(g);
	}
	/* 未登录时也要让用户先看清"交出去的是什么"（隐私预期前置，docs/313 §4.1） */
	if (!state.signedIn) {
		kids.push(jsx('div', {
			key: 'scopeIntro',
			className: 'dshmCloud_scope',
			children: [
				jsx('span', { key: 'head', children: '将同步这些内容' }),
				jsx(ScopeList, { key: 'list' })
			]
		}));
	}
	/* 根容器同理：摊平（防止单组时 children 退化成单个对象） */
	/* 末组不画分隔线（分区底部跟着官方 options 的 padding 收尾） */
	if (kids.length > 1) {
		const last = kids[kids.length - 1];
		if (last !== null && last.props !== undefined) {
			last.props = { ...last.props, last: true };
		}
	}
	return jsx('div', { children: kids });
}

/**
 * 插件入口。
 *
 * 【只做注册】`apply()` 不碰 DOM、不做网络请求；
 * 注册包在 `ctx.effect` 里，由 cordis 在插件卸载时自动回收（仓库既有插件的同一纪律）。
 */
function apply(ctx) {
	/* 样式只注入一次（按本包名登记，卸载时由 dsh-client-modules 精确摘除） */
	if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + CSS_TAG + '"]') === null) {
		const tag = document.createElement('style');
		tag.dataset.plugin = PKG;
		tag.dataset.pluginCss = CSS_TAG;
		tag.textContent = CSS;
		document.head.appendChild(tag);
	}
	ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
		name: 'settings.section',
		id: 'dshm-cloud-sync',
		order: 50,
		label: () => '云同步',
		locale: NS
	}, CloudSyncSection)), 'dshm-cloud-sync: settings section');
}

/** 声明依赖的客户端服务（由 dsh 的 client 加载器注入）。 */
const inject = ['slots'];
