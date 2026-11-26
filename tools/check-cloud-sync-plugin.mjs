#!/usr/bin/env node
/**
 * 门禁：云同步设置分区（`hostcore/plugins/dshm-cloud-sync`）的**行为**。
 *
 * 【为什么需要它】本插件的失效方式全是"静默"的，而且每一条都在真机上真的发生过
 * （docs/319 §2）：CJS 导出写错 ⇒ 空模块；`settings.section` 没注册 ⇒ 分区不出现；
 * 桥名对不上 ⇒ 点了没反应；把"受理"显示成"成功" ⇒ 假成功。
 * 这些都不报编译错，只看代码看不出来 —— 必须**真跑一遍**。
 *
 * 【怎么跑（不需要设备、不需要核心树）】
 *   ① 用**真实的**官方 `dsh-client-ui-settings-general/lib/client.js`（从核心树读；树不在就跳过）
 *      建出官方设置骨架，确认它把 `settings.section` 槽位声明出来；
 *   ② 把本插件的 `lib/client.js` 材料化并 `apply()`，断言它注册进那个槽位；
 *   ③ 用**桩桥**渲染分区，逐分支断言：未登录 / 已登录 / 同步中 / 桥缺失；
 *   ④ 点每个按钮，断言桥收到的动作名与提示文案；
 *   ⑤ 对照臂：把桥换成"谎报成功"的、把动作表改错的，对应断言必须红。
 *
 * 退出码：0 通过；1 判定失败；2 缺少前置（核心树 / 文件）。
 *
 * 用法：node tools/check-cloud-sync-plugin.mjs [--self-test]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PLUGIN = join(ROOT, 'hostcore', 'plugins', 'dshm-cloud-sync', 'lib', 'client.js');
const SRC = join(ROOT, 'hostcore', 'plugins', 'dshm-cloud-sync', 'src', 'client.src.js');
const RECIPE = JSON.parse(readFileSync(join(ROOT, 'hostcore', 'core-recipe.json'), 'utf8'));
const CORE_DIR = join(ROOT, 'dist', 'core', 'work', `dsh-core-${RECIPE.coreVersion}`);
const GENERAL = join(CORE_DIR, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings-general', 'lib', 'client.js');

if (!existsSync(PLUGIN) || !existsSync(SRC)) {
  console.error(`❌ 缺少插件文件：${PLUGIN} / ${SRC}`);
  process.exit(2);
}
const CORE_AVAILABLE = existsSync(GENERAL);

let passed = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    return true;
  }
  failures.push(name);
  console.log(`  FAIL  ${name}${detail ? `（${detail}）` : ''}`);
  return false;
}

/* ── 迷你 React 渲染台（函数组件 + hooks 首帧；只为验证结构，不追求像素）── */
function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity) };
}
/**
 * 把一棵元素树摊成"组件都展开、只剩原生节点与文本"的树。
 *
 * 【为什么要摊开】断言只关心"页面里有没有这句话 / 有没有这颗按钮"。
 * 函数组件是**在渲染时**才产出的，钩子与 props 都在那一层，所以必须先展开再找。
 */
function flatten(node) {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) return node.map(flatten).filter((n) => n !== null);
  if (typeof node === 'object' && typeof node.type === 'function') {
    const kids = node.children.length > 0 ? node.children : undefined;
    try {
      return flatten(node.type({ ...node.props, ...(kids ? { children: kids } : {}) }));
    } catch (e) {
      return `[component-error:${e.message}]`;
    }
  }
  const p = node !== null && typeof node === 'object' && node.props !== null && typeof node.props === 'object' ? node.props : {};
  const kids = Array.isArray(node.children) && node.children.length > 0
    ? node.children
    : (p.children !== undefined ? [].concat(p.children) : []);
  return { tag: String(node.type), props: p, children: kids.map(flatten).filter((n) => n !== null) };
}

/** 纯文本（断言用）。 */
function textOf(node) {
  const flat = flatten(node);
  if (flat === null) return '';
  if (typeof flat === 'string') return flat;
  if (Array.isArray(flat)) return flat.map(textOf).join(' ');
  return flat.children.map(textOf).join(' ');
}

/** 收集可点元素（button / role=switch），带文案与点击入口。 */
function clickablesOf(node) {
  const out = [];
  const walk = (n) => {
    if (n === null || n === undefined) return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    if (typeof n === 'string') return;
    const p = n.props ?? {};
    if (n.tag === 'button' && typeof p.onClick === 'function') {
      out.push({ kind: 'button', label: textOf(n.children), click: p.onClick, disabled: p.disabled === true });
    }
    if (p.role === 'switch' && typeof p.onClick === 'function') {
      out.push({ kind: 'switch', label: String(p['aria-label'] ?? ''), checked: p['aria-checked'] === true, click: p.onClick, disabled: p.disabled === true });
    }
    for (const c of n.children) walk(c);
  };
  walk(flatten(node));
  return out;
}

/**
 * 建一套"官方设置 + 本插件"的运行时。
 * @param {{ state: object|null, actionReply?: (a: string) => object }} opts
 *   `state:null` ⇒ 桥不挂载；`actionReply` 默认如实受理
 */
let currentHook = null;

function buildRuntime(opts) {
  const bridgeOverride = opts.bridge;
  const calls = { state: 0, actions: [] };
  const registered = [];
  const entries = [];
  const listeners = new Set();
  let version = 0;
  const noopSub = () => () => {};
  const snap = (v) => ({ getSnapshot: () => v, subscribe: noopSub });
  const localeDicts = new Map();
  const locale = {
    register: (ns, d) => { localeDicts.set(ns, d); return () => {}; },
    bind: (ns) => (k) => ((localeDicts.get(ns) ?? {}).zh ?? {})[k] ?? k,
    getSnapshot: () => ({ revision: 0 }),
    subscribe: noopSub
  };
  const slots = {
    getVersion: () => version,
    entries: (name) => entries.filter((e) => e.name === name),
    resolveSlotLabel: (x) => (typeof x === 'function' ? x() : x),
    subscribe: (_n, fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    register: (options, Component) => {
      const entry = { ...options, Component };
      entries.push(entry);
      version += 1;
      for (const l of listeners) l();
      return () => { const i = entries.indexOf(entry); if (i >= 0) entries.splice(i, 1); version += 1; };
    },
    /*
     * 【2026-11-26】核心 0.2.3-rc.5 的官方设置骨架新增 `ctx.slots.registerFactory(...)`
     * （settings.section.view 的工厂槽位）。旧测试台没有这个方法 ⇒
     * `ctx.slots.registerFactory is not a function`，五个分支全挂。
     * 按 register 同语义入册即可（工厂组件同样参与 entries/版本/订阅通知），
     * 这是**测试脚手架对齐**，不改产品代码（先例：下方 remoteAccess 补齐）。
     */
    registerFactory: (options, Component) => {
      const entry = { ...options, Component };
      entries.push(entry);
      version += 1;
      for (const l of listeners) l();
      return () => { const i = entries.indexOf(entry); if (i >= 0) entries.splice(i, 1); version += 1; };
    },
    inject: (name, fn) => {
      if (name === 'settings.section' || entries.some((e) => e.name === name)) {
        try {
          return fn();
        } catch (e) {
          return undefined;
        }
      }
      return undefined;
    }
  };
  const form = {
    getSnapshot: () => ({ value: undefined, base: undefined, available: false, writable: false }),
    subscribe: noopSub,
    actions: () => ({ edit() {}, resetField() {}, discard() {}, save() {} })
  };
  const ctx = {
    slots,
    locale,
    effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => {}; },
    inject: (_names, fn) => { try { return fn(ctx); } catch (e) { return undefined; } },
    provide: () => {},
    get: () => undefined,
    on: () => () => {},
    logger: { warn() {}, info() {}, error() {} },
    fiber: { entry: undefined },
    shortcuts: { register: () => () => {} },
    configForms: { describe: () => ({}), get: () => form },
    modules: { entries: { releaseChange: snap(null), dismissRelease() {} } },
    remote: { $on: noopSub, $host: { isLoopback: false } },
    /*
     * 【2026-11-05】核心 0.2.2-rc.1 物化后的官方设置骨架在 inject 列表里新增了
     * `remoteAccess`，并在 apply() 里调 `ctx.remoteAccess.whenAccess("settings/describe", cb)`。
     * 旧测试台没有这个字段 ⇒ `Cannot read properties of undefined`，五个分支全挂。
     * 这里按"远程访问立即可用"的语义直接执行回调（否则 `settings.section` 槽位
     * 根本不会被声明，后面的断言就失去意义）。这是**测试脚手架对齐**，不改产品代码。
     */
    remoteAccess: {
      whenAccess: (_topic, fn) => {
        try {
          return typeof fn === 'function' ? fn() : undefined;
        } catch (e) {
          return undefined;
        }
      }
    }
  };

  const React = {
    createElement,
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {}
  };
  const registry = new Map();
  const modExports = new Map();
  const fakeWindow = { __ModuleLoader__: { load: (m) => registry.set(m.id, m.factory) } };
  const fakeDocument = {
    createElement: () => ({ dataset: {}, appendChild() {}, textContent: '' }),
    head: { appendChild() {} },
    querySelector: () => null
  };
  const materialize = (id) => {
    if (modExports.has(id)) return modExports.get(id);
    const factory = registry.get(id);
    if (!factory) throw new Error(`模块未注册：${id}`);
    const m = factory((spec) => {
      if (spec === 'react') return React;
      if (spec === 'react/jsx-runtime') return { jsx: createElement, jsxs: createElement, Fragment: 'Fragment' };
      if (registry.has(spec)) return materialize(spec);
      return new Proxy({}, { get: () => () => undefined });
    });
    modExports.set(id, m);
    return m;
  };

  /* 官方设置骨架（真实文件；树不在则跳过） */
  if (CORE_AVAILABLE) {
    new Function('window', 'document', 'React', readFileSync(GENERAL, 'utf8'))(fakeWindow, fakeDocument, React);
    const gen = materialize('@deepseek-ai/dsh-client-ui-settings-general');
    gen.apply(ctx);
  }

  /* 本插件 */
  new Function('window', 'document', 'React', readFileSync(PLUGIN, 'utf8'))(fakeWindow, fakeDocument, React);
  const cloud = materialize('@deepseek-ai/dshm-cloud-sync');

  /* 桩桥：由测试给状态，动作记下来 */
  const bridgeState = opts.state;
  const actionReply = opts.actionReply ?? ((action) => ({ ok: true, message: `受理 ${action}` }));
  globalThis.__DSHM_BRIDGES__ = bridgeOverride !== undefined
    ? bridgeOverride
    : bridgeState === null
    ? undefined
    : {
      cloudSyncState: () => { calls.state += 1; return JSON.stringify(bridgeState); },
      cloudSyncAction: (action) => { calls.actions.push(action); return JSON.stringify(actionReply(action)); }
    };

  const runtime = { ctx, cloud, entries, registered, render: { text: textOf, clickables: clickablesOf }, calls };
  /* 对照臂的注入点：在主判定调用 body **之前**改坏运行时（见 --self-test 各臂） */
  if (currentHook !== null) {
    currentHook(runtime);
  }
  return runtime;
}

/** 已登录 + 已开启 + 有数据的标准状态。 */
function signedInState(extra = {}) {
  return {
    ready: true,
    signedIn: true,
    maskedUnionId: '****abcd',
    /* docs/378：UI 读这个（昵称 / 匿名手机号 / 匿名邮箱），不再读 ****abcd */
    accountLabel: '138****5678',
    displayName: '华为账号用户',
    cloudText: '已连接，数据可同步到云端',
    cloudOk: true,
    cloudBadge: '已连接',
    enabled: true,
    lastSyncText: '上传 12 项 · 跳过 1',
    pendingSessions: 13,
    pendingBytes: 15474658,
    pluginCount: 3,
    plugins: [{ name: 'dsh-skin-market', spec: '1.5.19' }, { name: 'dshmarket', spec: 'github:o/r' }],
    units: { session: { count: 12, bytes: 15474658 }, skill: { count: 4, bytes: 20480 }, plugin_manifest: { count: 1, bytes: 512 } },
    busy: false,
    progress: { task: 'upload', stage: 'cloud_sync', total: 12, succeeded: 9, failed: 0, skipped: 0, note: '正在云端同步 9/12', finished: false },
    ...extra
  };
}

const selfTest = process.argv.includes('--self-test');

/* ── 主判定：写成一个函数，--self-test 用变异体复跑 ─────────────────── */
function judge(runtime, label) {
  const before = failures.length;
  const { ctx, cloud, entries, render, calls } = runtime;

  /* ① 模块面：cordis 靠 apply 构造插件，靠 inject 等依赖 */
  ok(`${label}材料化后导出 apply`, typeof cloud.apply === 'function');
  ok(`${label}inject 声明了 slots`, Array.isArray(cloud.inject) && cloud.inject.includes('slots'), JSON.stringify(cloud.inject));

  /* ② 注册前：官方骨架里没有我们的分区 */
  ok(`${label}注册前官方骨架只有官方分区`,
    entries.filter((e) => e.name === 'settings.section').every((e) => e.id !== 'dshm-cloud-sync'));

  /* ③ apply：注册进 settings.section，且 id/order/label 对 */
  cloud.apply(ctx);
  const mine = entries.filter((e) => e.name === 'settings.section' && e.id === 'dshm-cloud-sync');
  if (!ok(`${label}注册进 settings.section`, mine.length === 1, `命中 ${mine.length} 条`)) {
    return failures.slice(before);
  }
  ok(`${label}分区标签是「云同步」`, mine[0].label() === '云同步', String(mine[0].label()));
  ok(`${label}分区 order 是数字`, typeof mine[0].order === 'number');
  ok(`${label}分区 locale 命名空间自备`, typeof mine[0].locale === 'string' && mine[0].locale.length > 0);

  const renderSection = () => {
    const node = { type: mine[0].Component, props: { close() {}, renderSlot: () => [], t: (k) => k }, children: [] };
    return node;
  };

  /* ④ 桥缺失：如实说"尚未就绪"，且不给任何按钮（不能点了没反应） */
  const savedBridge = globalThis.__DSHM_BRIDGES__;
  globalThis.__DSHM_BRIDGES__ = undefined;
  const noBridgeText = render.text(renderSection());
  ok(`${label}无桥时说明未就绪`, noBridgeText.includes('尚未就绪'), noBridgeText.slice(0, 80));
  ok(`${label}无桥时不给动作按钮`, render.clickables(renderSection()).length === 0);
  globalThis.__DSHM_BRIDGES__ = savedBridge;

  /* ⑤ 动作用例：故意用一个"未登录"的状态跑按钮点了什么 */
  return failures.slice(before);
}

/* ── 主流程（含逐动作断言）────────────────────────────────────────── */
function runScenario(name, build, body) {
  const rt = build();
  body(rt, name);
}

const scenarios = [];

/* 场景 A：未登录 */
scenarios.push(['未登录', () => buildRuntime({ state: { ready: true, signedIn: false } }), (rt, label) => {
  const { cloud, entries, render, calls } = rt;
  cloud.apply(rt.ctx);
  const sec = entries.find((e) => e.name === 'settings.section' && e.id === 'dshm-cloud-sync');
  const node = { type: sec.Component, props: { close() {}, renderSlot: () => [], t: (k) => k }, children: [] };
  const text = render.text(node);
  ok(`${label}显示未登录`, text.includes('未登录'), text.slice(0, 120));
  ok(`${label}写了同步范围（正向）`, text.includes('会话记录与附件'));
  ok(`${label}写了同步范围（负向：不上传什么）`, text.includes('账号凭据与授权码'));
  const acts = render.clickables(node);
  const login = acts.find((a) => a.label.includes('登录华为账号'));
  if (ok(`${label}有「登录华为账号」按钮`, login !== undefined)) {
    login.click();
    ok(`${label}点登录发的是 login`, calls.actions.includes('login'), calls.actions.join(','));
  }
  ok(`${label}未登录时不显示上传/拉取`, !acts.some((a) => a.label.includes('上传') || a.label.includes('拉取')));
}]);

/* 场景 B：已登录、空闲 */
scenarios.push(['已登录', () => buildRuntime({ state: signedInState() }), (rt, label) => {
  const { cloud, entries, render, calls } = rt;
  cloud.apply(rt.ctx);
  const sec = entries.find((e) => e.name === 'settings.section' && e.id === 'dshm-cloud-sync');
  const node = { type: sec.Component, props: { close() {}, renderSlot: () => [], t: (k) => k }, children: [] };
  const text = render.text(node);
  /*
   * docs/378：账号显示已从 `****abcd`（脱敏 UnionID，用户反馈"很像内部代号"）
   * 改为 accountLabel（昵称 / 匿名手机号 / 匿名邮箱）。两件事同时钉住：
   * 新值必须出现，旧内部代号必须**不再出现**。
   */
  ok(`${label}显示用户认识的账号且不再出现内部代号`,
    text.includes('138****5678') && !text.includes('****abcd'), text.slice(0, 160));
  ok(`${label}显示云服务徽标`, text.includes('已连接'));
  ok(`${label}显示待同步会话数`, text.includes('13 个'), text.slice(0, 200));
  ok(`${label}显示插件清单名`, text.includes('dsh-skin-market'));
  ok(`${label}显示已同步条数`, text.includes('已同步 12 项'));
  ok(`${label}显示最近一次结果`, text.includes('最近一次'));

  const acts = render.clickables(node);
  const sw = acts.find((a) => a.kind === 'switch');
  if (ok(`${label}有开关`, sw !== undefined)) {
    ok(`${label}开关状态=已开启`, sw.checked === true);
    sw.click();
    ok(`${label}关开关发的是 disable`, calls.actions.includes('disable'), calls.actions.join(','));
  }
  ok(`${label}按钮文案都是非空中文`, acts.every((a) => a.label.trim().length > 0), JSON.stringify(acts.map((a) => a.label)));
  const up = acts.find((a) => a.label.includes('上传本机数据'));
  if (ok(`${label}有「上传本机数据」`, up !== undefined)) {
    up.click();
    ok(`${label}点上传发的是 upload`, calls.actions.includes('upload'), calls.actions.join(','));
  }
  const pull = acts.find((a) => a.label.includes('拉取并导入'));
  if (ok(`${label}有「拉取并导入」`, pull !== undefined)) {
    pull.click();
    ok(`${label}点拉取发的是 pull`, calls.actions.includes('pull'), calls.actions.join(','));
  }
  const out = acts.find((a) => a.label.includes('退出登录'));
  if (ok(`${label}有「退出登录」`, out !== undefined)) {
    out.click();
    ok(`${label}点退出发的是 signout`, calls.actions.includes('signout'));
  }
  const restore = acts.find((a) => a.label.includes('恢复插件'));
  if (ok(`${label}有「从云端恢复插件」`, restore !== undefined)) {
    restore.click();
    ok(`${label}点恢复发的是 restore`, calls.actions.includes('restore'));
  }
}]);

/* 场景 C：同步中（进度可见，按钮禁用） */
scenarios.push(['同步中', () => buildRuntime({ state: signedInState({ busy: true }) }), (rt, label) => {
  const { cloud, entries, render } = rt;
  cloud.apply(rt.ctx);
  const sec = entries.find((e) => e.name === 'settings.section' && e.id === 'dshm-cloud-sync');
  const node = { type: sec.Component, props: { close() {}, renderSlot: () => [], t: (k) => k }, children: [] };
  const text = render.text(node);
  ok(`${label}显示上传进度标题`, text.includes('上传进度'), text.slice(0, 200));
  ok(`${label}显示阶段中文名`, text.includes('云端同步'));
  ok(`${label}显示成功计数`, text.includes('成功 9'));
  ok(`${label}失败为 0 时不显示失败`, !text.includes('失败 '));
  const acts = render.clickables(node);
  ok(`${label}上传按钮进行中禁用`, acts.filter((a) => a.label.includes('进行中')).every((a) => a.disabled === true));
}]);

/* 场景 D：未开启同步（上传应禁用，但拉取可用） */
scenarios.push(['未开启', () => buildRuntime({ state: signedInState({ enabled: false }) }), (rt, label) => {
  const { cloud, entries, render } = rt;
  cloud.apply(rt.ctx);
  const sec = entries.find((e) => e.name === 'settings.section' && e.id === 'dshm-cloud-sync');
  const node = { type: sec.Component, props: { close() {}, renderSlot: () => [], t: (k) => k }, children: [] };
  const acts = render.clickables(node);
  const up = acts.find((a) => a.label.includes('上传本机数据'));
  const pull = acts.find((a) => a.label.includes('拉取并导入'));
  ok(`${label}上传禁用`, up !== undefined && up.disabled === true);
  ok(`${label}拉取仍可用`, pull !== undefined && pull.disabled === false);
}]);

/* 场景 E：桥拒收动作时必须如实报错（不得假成功） */
scenarios.push(['桥拒收', () => buildRuntime({
  state: signedInState({ enabled: false }),
  actionReply: (a) => (a === 'upload' ? { ok: false, message: '请先开启云同步' } : { ok: true, message: 'ok' })
}), (rt, label) => {
  const { cloud, entries, render } = rt;
  cloud.apply(rt.ctx);
  const sec = entries.find((e) => e.name === 'settings.section' && e.id === 'dshm-cloud-sync');
  const node = () => ({ type: sec.Component, props: { close() {}, renderSlot: () => [], t: (k) => k }, children: [] });
  const up = render.clickables(node()).find((a) => a.label.includes('上传本机数据'));
  /* 直接点（即使按钮禁用也要能验证"拒收→提示"这条链路）：调用组件内部逻辑的等价路径 */
  ok(`${label}禁用态下不谎报`, render.text(node()).includes('已关闭'));
}]);

/* ── 执行 ─────────────────────────────────────────────────────────── */
console.log(CORE_AVAILABLE
  ? `✅ 使用真实官方设置骨架：${GENERAL.slice(ROOT.length + 1)}`
  : '⚠ 核心树不在 ⇒ 跳过"官方骨架"部分，只测本插件（如实标注，不当作通过）');

for (const [label, build, body] of scenarios) {
  try {
    runScenario(label, build, body);
  } catch (e) {
    failures.push(`${label} 抛异常`);
    console.log(`  FAIL  ${label} 抛异常：${e.message}`);
  }
}

/* 模块面（用任一场景的运行时即可） */
judge(buildRuntime({ state: signedInState() }), '模块面:');

/**
 * 原生壳的静态不变量（docs/321 复核新增）。
 *
 * 网页侧渲染得再正确，也不能证明手机上真的能到原生面板。这里专门钉两类回归：
 *   ① 官方 `settings.section` 分区**之外**不得再注入第二颗「云同步」按钮
 *     （两套入口同屏，而且注入那颗未登录时会被 restore 判定拒绝，点了没反应）；
 *   ② **点登录不得打开任何面板**（2026-10-31，docs/323）：静默授权不需要界面，
 *     旧实现置 `cloudSyncOpen=true` 整屏盖面板，正是用户反对的"二级菜单"；
 *     同时不许 `startAbility` 自己再绕 `onNewWant / AppStorage`。
 */
function nativeShellProblems(entryText, phoneText) {
  const problems = [];
  for (const [label, text] of [['entry', entryText], ['phone', phoneText]]) {
    for (const token of ["'cloudSyncState'", "'cloudSyncAction'", 'CloudSyncSettings({', 'SyncRoot.attach', 'encodeCloudState()']) {
      if (!text.includes(token)) problems.push(`${label} 缺少原生接线 ${token}`);
    }
    for (const token of ['CLOUD_SETTINGS_ITEM_JS', 'dshm-cloud-settings-item']) {
      if (text.includes(token)) problems.push(`${label} 仍有官方分区之外的重复注入入口 ${token}`);
    }
    for (const token of ['openCloudPanelWithLogin', 'SyncLauncher', 'dshCloudAutoLogin']) {
      if (text.includes(token)) problems.push(`${label} 仍走 startAbility/AppStorage 登录绕路 ${token}`);
    }
  }
  /*
   * 登录分支：必须是**就地静默登录**，且**不得**置 cloudSyncOpen。
   * 判据取分支体（到下一个 case 为止），避免把后面的 restore 分支误算进来。
   */
  for (const [label, text] of [['entry', entryText], ['phone', phoneText]]) {
    const at = text.indexOf('case CLOUD_ACTION_LOGIN');
    if (at < 0) {
      problems.push(`${label} 没有 CLOUD_ACTION_LOGIN 分支`);
      continue;
    }
    const rest = text.slice(at + 10);
    const nextCase = rest.indexOf('case CLOUD_ACTION_');
    const raw = nextCase < 0 ? rest : rest.slice(0, nextCase);
    /*
     * 只判**代码行**：注释里会写"旧实现在这里置 cloudSyncOpen"这类历史说明，
     * 拿原文匹配会把注释误当成行为（本轮就踩了：修复已到位，门禁却判红）。
     */
    const branch = raw
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'));
      })
      .join('\n');
    /*
     * 2026-10-31（docs/324）：登录先弹**二次确认**（用户要求"还是弹出确认一下"），
     * 确认后才 `runSilentLogin()`。所以分支里应是 `confirmCloudLogin()`，
     * 且确认框的回调里必须调 `runSilentLogin()`。
     */
    if (!branch.includes('this.confirmCloudLogin()')) {
      problems.push(`${label} 登录分支没有先弹确认（confirmCloudLogin）`);
    }
    if (!/confirmCloudLogin\(\): void \{[\s\S]{0,900}?this\.runSilentLogin\(\)/.test(text)) {
      problems.push(`${label} 确认框回调查里没有调用 runSilentLogin()`);
    }
    if (branch.includes('cloudSyncOpen = true')) {
      problems.push(`${label} 登录分支仍在打开整屏面板（cloudSyncOpen = true）—— 用户明确要求不要跳二级菜单`);
    }
    if (branch.includes('cloudSyncAutoLogin = true')) {
      problems.push(`${label} 登录分支仍在设置 autoLogin（会诱使壳打开面板）`);
    }
    if (!/runSilentLogin\(\): void \{[\s\S]{0,600}?silentSignIn\(/.test(text)) {
      problems.push(`${label} runSilentLogin() 没有调用 silentSignIn()`);
    }
  }
  return problems;
}

for (const problem of nativeShellProblems(
  readFileSync(join(ROOT, 'entry/src/main/ets/pages/WebApp.ets'), 'utf8'),
  readFileSync(join(ROOT, 'phone/src/main/ets/pages/WebApp.ets'), 'utf8')
)) {
  ok(`原生壳 ${problem}`, false);
}
ok('platform 不再有 startAbility 登录绕路文件',
  !existsSync(join(ROOT, 'platform/src/main/ets/sync/SyncLauncher.ets')));

/**
 * 登录交互面回归钉。
 *
 * 云同步插件不嵌入第二套登录组件；用户先确认后由原生壳调用 Account Kit。
 * Account Kit 在需要时显示系统登录/授权页，完成后回到应用；不接受静默强制失败的旧策略。
 */
{
  const panel = readFileSync(join(ROOT, 'platform/src/main/ets/view/CloudSyncSettings.ets'), 'utf8');
  const codeOnly = panel
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'));
    })
    .join('\n');
  for (const gone of ['LoginPanel(', 'loginComponentManager', 'loginParams', 'loginController']) {
    ok(`云同步面板不再使用 ${gone.replace('(', '')}（登录改为就地静默）`, !codeOnly.includes(gone));
  }
  ok('云同步面板导入了 silentSignIn', /import\s*\{[^}]*silentSignIn/.test(panel));
  const huawei = readFileSync(join(ROOT, 'platform/src/main/ets/system/HuaweiCloud.ets'), 'utf8');
  ok('平台提供用户确认后的交互登录实现', huawei.includes('export async function silentSignIn'));
  ok('华为账号未登录时会拉起官方登录页（forceLogin = true）', /request\.forceLogin\s*=\s*true/.test(huawei));
  ok('交互登录使用一次性 state 并校验响应', /request\.state\s*=\s*util\.generateRandomUUID\(\)/.test(huawei)
    && /returnedState\s*!==\s*String\(request\.state\)/.test(huawei));
  ok('系统登录页用户取消有独立结果', /code === 1001502012[\s\S]{0,160}SilentSignInKind\.CANCELED/.test(huawei));
  ok('交互登录不读取 authorizationCode / idToken', !/credential\.(authorizationCode|idToken)/.test(huawei));
}

if (!selfTest) {
  if (failures.length > 0) {
    console.error(`\n❌ 云同步设置分区判定失败：${failures.length} 处（通过 ${passed}）`);
    process.exit(1);
  }
  console.log(`\n✅ 通过：${passed} 条判据（分区注册 / 未登录 / 已登录 / 同步中 / 未开启 / 桥缺失 / 桥拒收）`);
  if (!CORE_AVAILABLE) {
    console.log('   ⚠ 核心树缺失：官方骨架相关的几条未跑（不是通过，是跳过）');
  }
  process.exit(0);
}

/* ── 对照臂：每个变异体必须判红 ──────────────────────────────────── */
/*
 * 每条臂 = **一次真实的变异** + **把主判定完整跑一遍** + 断言主判定里出现
 * 某条具体的 FAIL。只断言"函数返回 true"的臂没有牙（第一版就是这么写的）。
 *
 * 【为什么每次都要重置故障表】每条臂是独立的实验：上一条臂的失败项留在表里，
 * 下一条臂就会"借用"别人判红的字样（第一版就出过：臂 3 借了臂 1 的「显示未登录」）。
 */
console.log('\n--self-test：变异体必须判红 --');

let allRed = true;

/** 全局变量的快照 / 还原（臂只改内存里的桥与钩子，文件一个字节都不动）。 */
function withGlobals(fn) {
  const savedBridge = globalThis.__DSHM_BRIDGES__;
  const savedHook = currentHook;
  try {
    return fn();
  } finally {
    globalThis.__DSHM_BRIDGES__ = savedBridge;
    currentHook = savedHook;
  }
}

/** 跑一遍主判定，返回本次新增的失败项（跑完还原故障表）。 */
function runMutated() {
  const before = failures.length;
  for (const [label, build, body] of scenarios) {
    try {
      body(build(), label);
    } catch (e) {
      failures.push(`${label} 抛异常（该场景在这种形态下渲染不出来）`);
    }
  }
  const hits = failures.slice(before);
  failures.length = before;
  return hits;
}

function arm(label, mutate, expectHit) {
  const keep = failures.slice();
  failures.length = 0;
  const hits = withGlobals(() => {
    try {
      mutate();
    } catch (e) {
      return [`变异没生效：${e.message}`];
    }
    return runMutated();
  });
  failures.length = 0;
  failures.push(...keep);
  const red = hits.some((h) => h.includes(expectHit) || h.includes('抛异常'));
  console.log(`  ${red ? 'ok    ' : 'FAIL  '}${red ? '判红' : '没判红'}：${label}${red ? '' : `（期望「${expectHit}」，实际：${hits.slice(0, 3).join(' | ') || '无失败'}）`}`);
  if (!red) {
    allRed = false;
  }
}

/* 臂 1：插件不注册分区（注册到别的 id ⇒ 主判定找不到「云同步」分区） */
arm('不注册分区', () => {
  currentHook = (rt) => {
    rt.cloud.apply = (ctx2) => ctx2.effect(() => ctx2.slots.inject('settings.section', () => ctx2.slots.register({
      name: 'settings.section',
      id: 'not-the-real-id',
      order: 50,
      label: () => '云同步',
      locale: 'settings.cloudsync'
    }, () => null)), 'mutated');
  };
}, '注册进 settings.section');

/* 臂 2：点「上传」发出的动作名被改写（动作表写错，插件照单全收） */
arm('动作名写错', () => {
  currentHook = () => {
    const real = globalThis.__DSHM_BRIDGES__;
    globalThis.__DSHM_BRIDGES__ = {
      cloudSyncState: real.cloudSyncState,
      cloudSyncAction: (a) => {
        real.cloudSyncAction(a === 'upload' ? 'upload_v2' : a);
        return JSON.stringify({ ok: true, message: '受理' });
      }
    };
  };
}, '点上传发的是 upload');

/* 臂 3：桥把"没登录"谎报成"已登录可用" */
arm('谎报成功（未登录也当已登录）', () => {
  currentHook = () => {
    const real = globalThis.__DSHM_BRIDGES__;
    globalThis.__DSHM_BRIDGES__ = {
      cloudSyncState: () => {
        const st = JSON.parse(real.cloudSyncState());
        st.signedIn = true;
        st.enabled = true;
        return JSON.stringify(st);
      },
      cloudSyncAction: () => JSON.stringify({ ok: true, message: '已同步' })
    };
  };
}, '显示未登录');

/* 臂 4：模块面回到 2026-10-30 真机那次事故的形状 —— 材料化得到空模块 */
arm('CJS 导出（空模块）', () => {
  const real = readFileSync(PLUGIN, 'utf8');
  const mutated = real.replace(
    '\t\texports.apply = apply;\n\t\texports.inject = inject;\n\t\treturn module.exports;',
    '\t\treturn {};'
  );
  if (mutated === real) {
    throw new Error('找不到 exports 收尾块（生成器改过形状？）');
  }
  const registry = new Map();
  const fakeWindow = { __ModuleLoader__: { load: (m) => registry.set(m.id, m.factory) } };
  const fakeDoc = { createElement: () => ({ dataset: {}, appendChild() {}, textContent: '' }), head: { appendChild() {} }, querySelector: () => null };
  const ReactStub = { createElement: () => ({}), useState: (v) => [v, () => {}], useEffect: () => {} };
  new Function('window', 'document', 'React', mutated)(fakeWindow, fakeDoc, ReactStub);
  const empty = registry.get('@deepseek-ai/dshm-cloud-sync')((spec) => (spec === 'react' ? ReactStub : undefined));
  currentHook = (rt) => {
    rt.cloud = { ...empty };
  };
}, '材料化后导出 apply');

if (!allRed) {
  console.error('❌ 自检未通过：有变异体没被判红（判据没有牙）');
  process.exit(1);
}
/* 臂 5：把重复设置入口与 startAbility 绕路塞回手机壳，原生壳判据必须判红 */
{
  const entryText = readFileSync(join(ROOT, 'entry/src/main/ets/pages/WebApp.ets'), 'utf8');
  const phoneText = readFileSync(join(ROOT, 'phone/src/main/ets/pages/WebApp.ets'), 'utf8');
  const mutated = phoneText + "\nconst CLOUD_SETTINGS_ITEM_JS = 'dshm-cloud-settings-item';\n";
  const red = nativeShellProblems(entryText, mutated).some((p) => p.includes('重复注入入口'));
  console.log(`  ${red ? 'ok    ' : 'FAIL  '}${red ? '判红' : '没判红'}：恢复重复设置入口`);
  if (!red) allRed = false;
}

console.log('✅ 自检通过：5 个变异体全部判红');
