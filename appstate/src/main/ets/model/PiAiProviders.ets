/**
 * pi-ai 提供方路由的**纯逻辑**：对齐 dsh 官方 Models 页的「提供方编辑 + 添加自定义模型 API」。
 *
 * ## 这个文件解决什么
 *
 * 官方 Models 页对 pi-ai 路由给的是**逐字段编辑器**：显示名 / 端点(`baseURL`) /
 * **API 协议**(`api`) / 模型目录(`models`)，另加一个「自定义模型 API」**创建表单**
 * （Provider ID + 端点 + 协议 + 至少一个模型 + 密钥）。
 *
 * 我们此前只有"把整个 `providers` 当一块 JSON 编辑"这一条路，于是：
 *   1. **没有任何入口能新建自定义路由**——候选列表来自
 *      `llm/listProviders ∪ llm/listConfigurableProviders`，那是 **pi-ai 自带目录**；
 *      用户自己的中转站/自部署路由（如 `wb2api`）两个目录里都没有 ⇒ 界面上无处可加。
 *      这正是"自定义 API 保存不了"的直接原因。
 *   2. 改一个端点要动整块 JSON，且与官方形态完全不同。
 *
 * ## 为什么是独立文件、零依赖
 *
 * 与 `SettingsDomains` / `SettingEditors` 同一条纪律：判定要能被
 * `tools/check-layout-fixtures.mjs` 直接执行。那个门禁只编译**零依赖**的纯逻辑
 * `.ets`（不碰 `connection` 的 JSON 取值工具），所以这里自带最小的类型守卫，
 * 不 import 任何模块。
 *
 * ## 写入原语的实测结论（真 Host `settings/mutate`，2026-09-26）
 *
 * | 目标 | 写法 | 结果 |
 * |---|---|---|
 * | 新建路由 | `set ['providers','<route>']` = profile 对象 | ✅ |
 * | 逐字段改标量 | `set ['providers','<route>','baseURL']` 等 | ✅（四条都通） |
 * | 模型目录 | `set ['providers','<route>','models']` = 整个数组 | ✅ |
 * | 模型数组的**下标** | `set [...'models','0','name']` | 字符串段被当对象键（能写进去但不达意）；**数字段被网关拒**（`gateway/input-invalid`） |
 * | 删除路由 | `unset ['providers','<route>']` | ✅ |
 * | 删单字段 | `unset ['providers','<route>','displayName']` | ✅ |
 *
 * ⇒ 结论：**标量逐字段写、数组整值写**。数组元素一律"读出来→本地改→整个写回"，
 * 不按下标写（下标写对数组语义是错的）。
 */

/** 一个 pi-ai 路由的模型行（官方每行可编辑 id / 显示名 / 上下文窗口 / 最大输出） */
export interface PiAiModelRow {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
}

/** 一个 pi-ai 路由的完整可编辑视图 */
export interface PiAiProviderView {
  /** 路由 id（settings 的键，也是凭据引用词干） */
  route: string;
  /** 显示名（空 ⇒ 界面回落显示 route） */
  displayName: string;
  /** 端点 */
  baseURL: string;
  /** **API 协议**（官方文案 "API 协议"；取值是 schema 里的协议标识符） */
  api: string;
  /** 该路由记录的凭据引用（如 `WB2API_API_KEY`） */
  apiKeyEnv: string;
  models: PiAiModelRow[];
}

/** 一个字段的编辑结果：合法性与原因 */
export interface PiAiFieldCheck {
  ok: boolean;
  /** 不合法时给人看的一句话（合法时为空串） */
  message: string;
}

/** pi-ai 路由所在的设置命名空间 */
export const PIAI_SETTINGS_NS: string = 'llm-pi-ai';

/**
 * 路由 id 的合法形态。
 *
 * 【为什么与官方逐字一致】官方 `CustomProviderCard` 用
 * `/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/`，并附了一条理由：id 同时是
 * **settings 的键**、**凭据引用词干**（`deriveKeyRef` 大写并把非字母数字换成 `_`），
 * 而凭据引用是 POSIX shell 标识符、**不能以数字开头**。
 * 一个数字开头的 id 能通过所有本页检查，却在凭据那一层以用户看不懂的正则报错失败。
 */
const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * 由路由 id 派生默认凭据引用（官方 `deriveKeyRef`，逐字一致）。
 *
 * 官方页面**从不询问环境变量名**：用户填的那把键就存在这个派生引用下，
 * 而 profile 把引用名记进 `apiKeyEnv`。两端必须用同一个规则，
 * 否则"密钥存了但路由读的是另一个引用"⇒ 表现为 `MISSING_CREDENTIAL`。
 */
export function deriveKeyRef(route: string): string {
  return `${route.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

/** 协议标识符 → 产品名（官方 `protocolLabel` 的三个已命名协议） */
export function protocolLabel(api: string): string {
  if (api === 'openai-completions') {
    return 'OpenAI Chat Completions';
  }
  if (api === 'openai-responses') {
    return 'OpenAI Responses';
  }
  if (api === 'anthropic-messages') {
    return 'Anthropic Messages';
  }
  // 适配器新增而官方页面尚未命名的协议：**直接显示标识符**，不编一个像样的名字
  return api;
}

/** 端点占位示例（官方随协议变化：Anthropic 的 SDK 会自己追加 /v1/messages） */
export function baseURLPlaceholder(api: string): string {
  return api === 'anthropic-messages' ? 'https://gateway.example' : 'https://gateway.example/v1';
}

// ── 最小的 JSON 读取工具（零依赖：不能 import connection 的取值工具）──────────

/** 是不是一个"普通对象"（非数组、非 null） */
function isRec(value: Object | undefined): boolean {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recOf(source: Object | undefined, key: string): Object | undefined {
  if (!isRec(source)) {
    return undefined;
  }
  return (source as Record<string, Object>)[key];
}

function strOf(source: Object | undefined, key: string): string {
  const value: Object | undefined = recOf(source, key);
  return typeof value === 'string' ? value : '';
}

function numOf(source: Object | undefined, key: string): number {
  const value: Object | undefined = recOf(source, key);
  return typeof value === 'number' ? value : 0;
}

// ── schema 读取：协议候选 ──────────────────────────────────────────────────

/**
 * 从 `llm-pi-ai` 命名空间的 schema 里读出**可声明的 API 协议**。
 *
 * 【为什么必须读 schema 而不是写死三个】官方 `protocolChoices` 的理由原文：
 * 让它保持"读 schema 而不是线协议字段"，这样**页面给出的选项不可能与适配器接受的
 * 选项漂移**——两者来自同一个 `Config`。适配器新增协议时本页自动跟上。
 *
 * 路径（实测 `settings/describe` 的形状）：
 *   refs[rootUid].dict.providers  →  providers 节点（type=dict）
 *   refs[providersUid].inner      →  该 dict 的**值类型**（一个 provider profile，type=object）
 *   refs[innerUid].dict.api       →  api 字段（type=union）
 *   refs[apiUid].list[]           →  每个候选（type=const, value=<协议标识符>）
 *
 * @param refs schema 的 `refs`（uid 字符串 → 节点）
 * @param rootUid schema 的根 uid
 * @returns 协议标识符列表；结构不认识时返回**空数组**（调用方据此禁用协议选择，
 *          而不是编一个候选出来）
 */
export function piAiProtocolChoices(refs: Object | undefined, rootUid: number): string[] {
  const out: string[] = [];
  if (!isRec(refs)) {
    return out;
  }
  const root: Object | undefined = recOf(refs, `${rootUid}`);
  const providersUid: Object | undefined = recOf(recOf(root, 'dict'), 'providers');
  if (typeof providersUid !== 'number') {
    return out;
  }
  const innerUid: Object | undefined = recOf(recOf(refs, `${providersUid}`), 'inner');
  if (typeof innerUid !== 'number') {
    return out;
  }
  const apiUid: Object | undefined = recOf(recOf(recOf(refs, `${innerUid}`), 'dict'), 'api');
  if (typeof apiUid !== 'number') {
    return out;
  }
  const apiNode: Object | undefined = recOf(refs, `${apiUid}`);
  const list: Object | undefined = recOf(apiNode, 'list');
  if (!Array.isArray(list)) {
    return out;
  }
  for (let i = 0; i < list.length; i++) {
    const entry: Object = list[i] as Object;
    const value: Object | undefined = recOf(entry, 'value');
    if (typeof value === 'string' && value.length > 0 && out.indexOf(value) < 0) {
      out.push(value);
    }
  }
  return out;
}

// ── 投影：providers 值 → 可编辑视图 ────────────────────────────────────────

/**
 * 把 `settings/describe` 里 `llm-pi-ai.value.providers` 投影成路由列表。
 *
 * **只读取，不补默认值**：`displayName` 缺就是空串（界面回落显示 route），
 * `api` 缺就是空串（界面显示"未选择"，与官方 `customApiUnset` 同语义）。
 * 编一个默认协议出来会让"用户没配"与"配了 openai-completions"两件事长得一样。
 */
export function projectPiAiProviders(providers: Object | undefined): PiAiProviderView[] {
  const out: PiAiProviderView[] = [];
  if (!isRec(providers)) {
    return out;
  }
  const map: Record<string, Object> = providers as Record<string, Object>;
  const routes: string[] = Object.keys(map);
  for (let i = 0; i < routes.length; i++) {
    const route: string = routes[i];
    const profile: Object | undefined = map[route];
    if (!isRec(profile)) {
      continue;
    }
    out.push({
      route: route,
      displayName: strOf(profile, 'displayName'),
      baseURL: strOf(profile, 'baseURL'),
      api: strOf(profile, 'api'),
      apiKeyEnv: strOf(profile, 'apiKeyEnv'),
      models: projectPiAiModels(recOf(profile, 'models')),
    });
  }
  return out;
}

/** 投影一个路由的模型目录（`models[]`） */
export function projectPiAiModels(models: Object | undefined): PiAiModelRow[] {
  const out: PiAiModelRow[] = [];
  if (!Array.isArray(models)) {
    return out;
  }
  for (let i = 0; i < models.length; i++) {
    const row: Object = models[i] as Object;
    if (!isRec(row)) {
      continue;
    }
    out.push({
      id: strOf(row, 'id'),
      name: strOf(row, 'name'),
      contextWindow: numOf(row, 'contextWindow'),
      maxTokens: numOf(row, 'maxTokens'),
    });
  }
  return out;
}

// ── 校验 ──────────────────────────────────────────────────────────────────

/** 路由 id 是否合法（官方同一正则） */
export function isRouteValid(route: string): boolean {
  return ROUTE_PATTERN.test(route);
}

/** 端点是否是可解析的 http/https URL（官方 `isHttpUrl`） */
export function isHttpUrl(value: string): boolean {
  const lower: string = value.trim().toLowerCase();
  if (!(lower.startsWith('http://') || lower.startsWith('https://'))) {
    return false;
  }
  // 必须有主机名部分（"http://" 之后不能立刻是空或斜杠）
  const rest: string = lower.startsWith('https://') ? value.trim().substring(8) : value.trim().substring(7);
  if (rest.length === 0) {
    return false;
  }
  const host: string = rest.startsWith('/') ? '' : (rest.indexOf('/') < 0 ? rest : rest.substring(0, rest.indexOf('/')));
  return host.length > 0 && host.indexOf(' ') < 0;
}

/**
 * 检查**创建**表单的路由 id：格式 + 是否已被占用。
 *
 * 【为什么占用检查在客户端也做一遍】官方把 `taken` 作为表单的就地提示
 * （`customRouteTaken`），而不是等 Host 拒绝——Host 对"覆盖已有路由"是**允许**的
 * （就是一次 set），所以服务端不会替你拦这个错。这个检查是**唯一**的拦点。
 */
export function checkRoute(route: string, takenRoutes: string[]): PiAiFieldCheck {
  const value: string = route.trim();
  if (value.length === 0) {
    return { ok: false, message: '请填写 Provider ID（用于设置键与凭据引用名）。' };
  }
  if (!isRouteValid(value)) {
    return {
      ok: false,
      message: 'Provider ID 只能是小写字母、数字与连字符，且必须以字母开头（例如 my-gateway）。'
    };
  }
  for (let i = 0; i < takenRoutes.length; i++) {
    if (takenRoutes[i] === value) {
      return { ok: false, message: `「${value}」已经存在，请换一个 ID。` };
    }
  }
  return { ok: true, message: '' };
}

/** 检查端点 */
export function checkBaseURL(baseURL: string): PiAiFieldCheck {
  const value: string = baseURL.trim();
  if (value.length === 0) {
    return { ok: false, message: '请填写 API 地址（端点）。' };
  }
  if (!isHttpUrl(value)) {
    return { ok: false, message: '端点必须是一个 http:// 或 https:// 地址。' };
  }
  return { ok: true, message: '' };
}

/**
 * 检查协议：必须是 schema 给出的候选之一。
 *
 * 【为什么不能只判"非空"】协议是路由**唯一的线协议声明**，写错字的后果是
 * 每次请求都失败且原因难查。官方把它做成下拉正是为了让取值不可能写错。
 * 这里对空候选（schema 没读到）的情况如实报"读不到候选"，而不是放行任何字符串。
 */
export function checkProtocol(api: string, choices: string[]): PiAiFieldCheck {
  if (choices.length === 0) {
    return { ok: false, message: 'Host 没有报告可声明的协议（schema 未读到），暂时无法新建路由。' };
  }
  if (api.length === 0) {
    return { ok: false, message: '请选择 API 协议。' };
  }
  for (let i = 0; i < choices.length; i++) {
    if (choices[i] === api) {
      return { ok: true, message: '' };
    }
  }
  return { ok: false, message: `协议「${api}」不在 Host 报告的候选里。` };
}

/** 检查模型目录：至少一个，且每行都要有 id，id 不能重复 */
export function checkModels(models: PiAiModelRow[]): PiAiFieldCheck {
  if (models.length === 0) {
    return { ok: false, message: '至少需要一个模型（模型 id 是路由提供什么的唯一依据）。' };
  }
  const seen: string[] = [];
  for (let i = 0; i < models.length; i++) {
    const id: string = models[i].id.trim();
    if (id.length === 0) {
      return { ok: false, message: `第 ${i + 1} 个模型缺少 id。` };
    }
    if (seen.indexOf(id) >= 0) {
      return { ok: false, message: `模型 id「${id}」重复了。` };
    }
    seen.push(id);
  }
  return { ok: true, message: '' };
}

/**
 * 检查密钥草稿（官方 `apiKeyFailure` 的语义）。
 *
 * 三条，逐字对齐官方：
 *   · **空字段不是失败**——每张卡打开时密钥框都是空的，即使已经存了密钥；
 *     空表示"保留原来那把"（这是"只写不读"的必然结果：页面读不回明文）。
 *   · **只有空白是失败**，不是空字段——否则用户输入的内容被静默丢弃。
 *   · 含换行/引号等非法字符是失败。
 */
export function checkApiKeyDraft(draft: string): PiAiFieldCheck {
  if (draft.length === 0) {
    return { ok: true, message: '' };
  }
  const value: string = draft.trim();
  if (value.length === 0) {
    return { ok: false, message: '密钥不能只有空白字符。' };
  }
  if (value.indexOf('\n') >= 0 || value.indexOf('\r') >= 0) {
    return { ok: false, message: '密钥不能包含换行。' };
  }
  if (value.startsWith('"') || value.startsWith("'")) {
    return { ok: false, message: '密钥不要加引号，请直接填值。' };
  }
  return { ok: true, message: '' };
}

// ── 写入载荷：与 settings/mutate 的 op 一一对应 ─────────────────────────────

/**
 * 一个路由的字段写入路径（`settings/mutate` 的 `path` 段数组）。
 *
 * 标量逐字段写；`models` 虽然也是字段，但见 `piAiModelsPath` 的说明。
 */
export function piAiFieldPath(route: string, field: string): string[] {
  return ['providers', route, field];
}

/**
 * 模型目录的写入路径。
 *
 * 【为什么整值写而不是按下标写】实测：`models.0.name`（字符串段）会被当成对象属性名
 * 写进去、却不改变数组元素；`models.0`（数字段）直接被网关拒
 * （`gateway/input-invalid`）。**数组元素无法按路径寻址**是本项目的既定事实，
 * 所以模型行的增删改一律"读出来 → 本地改 → 整个 models 数组写回"。
 * 注意这是**整体替换**语义：写回的数组就是 Host 上最终的目录。
 */
export function piAiModelsPath(route: string): string[] {
  return ['providers', route, 'models'];
}

/** 新建/覆盖一个路由的写入路径（`['providers', route]`） */
export function piAiRoutePath(route: string): string[] {
  return ['providers', route];
}

/**
 * 由表单值构造**新建路由**的 profile 对象。
 *
 * 【为什么字段名在这里写死一次】这三个字段共同构成"一个手工声明的路由"：
 * 端点、协议、至少一个模型。官方把这些列为必填，理由原文是
 * "没有任何东西能为它们兜底"——pi-ai 目录不认识这个路由，所以默认值无从谈起。
 *
 * 【`apiKeyEnv` 只在真的要存密钥时写】官方：`...storesKey ? { apiKeyEnv: keyRef } : {}`。
 * 不填密钥时不写这个字段，让路由沿用 Host 上的既有值（编辑场景下尤其重要：
 * 用户只是来改端点的，不该顺手把密钥引用改掉）。
 */
export function buildRouteProfile(view: PiAiProviderView, storesKey: boolean,
  keyRef: string): Record<string, Object> {
  const out: Record<string, Object> = {};
  const displayName: string = view.displayName.trim();
  if (displayName.length > 0) {
    out['displayName'] = displayName;
  }
  if (storesKey) {
    out['apiKeyEnv'] = keyRef;
  }
  out['api'] = view.api;
  out['baseURL'] = view.baseURL.trim();
  out['models'] = modelsPayload(view.models);
  return out;
}

/**
 * 模型行 → 写入载荷。
 *
 * 【为什么 `name` 空就不写】官方每行的 `name` 是"可选显示名"；写空串会把它变成
 * "显示名是空"而不是"没设显示名"。省略让 Host 侧沿用默认（用 id 显示）。
 * `contextWindow`/`maxTokens` 为 0 视为未填，同样省略——它们是**可选覆盖**，
 * 写 0 会变成一个真实的上限 0（比不写危险得多）。
 */
export function modelsPayload(models: PiAiModelRow[]): Object[] {
  const out: Object[] = [];
  for (let i = 0; i < models.length; i++) {
    const row: PiAiModelRow = models[i];
    const item: Record<string, Object> = {};
    item['id'] = row.id.trim();
    const name: string = row.name.trim();
    if (name.length > 0) {
      item['name'] = name;
    }
    if (row.contextWindow > 0) {
      item['contextWindow'] = row.contextWindow;
    }
    if (row.maxTokens > 0) {
      item['maxTokens'] = row.maxTokens;
    }
    out.push(item);
  }
  return out;
}

/** 空模型行（界面上「加一行模型」用的初值） */
export function emptyModelRow(): PiAiModelRow {
  return { id: '', name: '', contextWindow: 0, maxTokens: 0 };
}

/** 新建路由表单的初值 */
export function emptyProviderView(api: string): PiAiProviderView {
  return {
    route: '',
    displayName: '',
    baseURL: '',
    api: api,
    apiKeyEnv: '',
    models: [emptyModelRow()]
  };
}

/**
 * 一次"编辑已有路由"要发出的字段写入清单。
 *
 * 【为什么要先比对再写，而不是无脑全写】省略未变化的字段有两个实际好处：
 *   1. 少几次 RPC（每次写都会让 revision +1、触发一次整页 describe）；
 *   2. 用户只改端点时，不会把 `displayName` 等字段用界面上的值**覆盖**回去
 *      （若别处同时改过它们，无脑全写会静默抹掉对方的改动）。
 */
export function changedScalarFields(before: PiAiProviderView,
  after: PiAiProviderView): string[] {
  const out: string[] = [];
  if (before.displayName !== after.displayName.trim()) {
    out.push('displayName');
  }
  if (before.baseURL !== after.baseURL.trim()) {
    out.push('baseURL');
  }
  if (before.api !== after.api) {
    out.push('api');
  }
  return out;
}

/** 一个字段的写入值（与 `changedScalarFields` 配对使用） */
export function scalarFieldValue(view: PiAiProviderView, field: string): Object {
  if (field === 'displayName') {
    return view.displayName.trim();
  }
  if (field === 'baseURL') {
    return view.baseURL.trim();
  }
  return view.api;
}

/**
 * 模型目录是否与 Host 上的不同。
 *
 * 比较用**规范化后的载荷**（与写入形状一致），避免"界面上多了个空格"就判定变化。
 * 比较 JSON 字符串足够：模型目录是纯数据结构，键顺序由 `modelsPayload` 固定。
 */
export function modelsDiffer(before: PiAiModelRow[], after: PiAiModelRow[]): boolean {
  return JSON.stringify(modelsPayload(before)) !== JSON.stringify(modelsPayload(after));
}
