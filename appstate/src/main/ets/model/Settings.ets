/**
 * 设置 / 凭据 / 插件 / 设备 / 诊断的呈现层契约
 * （D3 §1 信息架构的「设置」与「诊断」分支，对应 D1 §7.6 / §7.8）。
 *
 * 本文件同时承载「上游回复 → 本层契约」的投影函数。放这里的理由：
 * 契约与它的投影住在一起，改名/改形状时改一处即可；投影只依赖 `connection`
 * 的 JSON 取值工具，不认识端点名（端点名一律由调用方从 `dshcompat` 传入）。
 */

import { getArray, getBoolean, getNumber, getRecord, getString, isRecord, parseJson } from 'connection';
import { isGeneralNamespace } from './SettingsDomains';
// 域判定与「通用命名空间」白名单搬去 `SettingsDomains.ets`（零依赖，可被 fixture 直接执行）；
// 这里**再导出**，于是所有既有导入点（含 barrel）都不用改。
export { GENERAL_NAMESPACES, DEFAULT_MODEL_NS, SETTINGS_DOMAIN_UNKNOWN, isGeneralNamespace, settingsDomainOfNs, settingsDomainOfKey } from './SettingsDomains';

// ─────────────────────────── 设置 ───────────────────────────

/** 设置项类型 */
export enum SettingKind {
  TOGGLE = 'toggle',
  CHOICE = 'choice',
  TEXT = 'text',
  /**
   * 结构化值编辑器（数组 / 嵌套对象 / 复杂 union）。
   *
   * 【为什么是「整值编辑」而不是「逐字段编辑」】实测（`.research/protocol/probe-deep-path.mjs`）：
   *   - `path: ['models','0','maxTokens']` → `settings/rejected`，
   *     消息是 `$.models expected array but got [object Object]`——
   *     字符串段被当成**对象属性名**，于是往数组里加了个属性，数组就坏了；
   *   - `path: ['models',0,'maxTokens']`（数字下标）→ `gateway/input-invalid`，
   *     连**线上边界校验**都过不去（`ops` 里不接受数字段）。
   * 也就是说：**数组元素无法按路径寻址**。唯一可行的写法是把整个值读出来、
   * 在本地改、再整值写回（实测 `path: ['models']` 传完整数组、以及
   * `path: ['retryPolicy']` 传完整对象都成功）。
   * 因此这里提供的是「整值编辑」——不是因为省事，而是因为深路径**走不通**。
   *
   * 【写回是**合并**还是**替换**——实测是合并，别想当然】
   *   把 `retryPolicy` 写成 `{mode:'normal', maxRetries:9}`（**故意省略** `retryableCodes`
   *   与 `backoff`）后回读，缺失的键**原样保留**。也就是说 `set` 一个对象是
   *   **逐键合并**，不是整体替换。界面上必须如实说明「没提到的键不会被删除」——
   *   写成「整体替换」会让用户以为遗漏的键会被清掉，那是一个会撒谎的界面
   *   （本项目的初版文案就是这么写的，实测后改正）。
   *
   * 【删除键的路径】实测 `{op:'unset', path:['retryPolicy','maxRetries']}` **成功**
   *   （该键的用户层被移除，值回落到 schema 默认 5）。所以「删键」是可达的，
   *   只是本客户端当前没有暴露该入口——如实标注为未提供，而不是提供半真的替代。
   */
  STRUCT = 'struct',
  INFO = 'info'
}

/**
 * 设置项的**线上类型**。
 *
 * 【为什么必须与 `SettingKind` 分开】`SettingKind` 是「用哪种控件呈现」，
 * 这个是「发什么类型的 JSON 值」。实测 `ui-theme.fontSize` 的 schema 是
 * `{"type":"number"}`——若按字符串发 `"16"`，Host 会以 schema 校验失败拒绝。
 * 两者只是**经常**一一对应，不是同一个概念（例如布尔也能用 CHOICE 呈现）。
 */
export enum SettingValueType {
  STRING = 'string',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  OTHER = 'other'
}

/**
 * 设置项来源：**本项目自己定义**的项，还是从 Host 的 `settings/describe` 读来的。
 *
 * 为什么必须区分：本客户端的「通知」「离线缓存」等项属于**本地偏好**，
 * 上游没有对应命名空间；而外观 / 模型 / 重试策略等项来自 Host。
 * 两类项混在一起而不标注，用户会以为改通知开关也会影响 Host——
 * 那是一个**会撒谎的界面**。所以来源是设置项的一等属性，界面上必须显示。
 */
export enum SettingOrigin {
  /** 本客户端本地偏好（Host 不知道它的存在） */
  LOCAL = 'local',
  /** 来自 Host 的 `settings/describe` */
  HOST = 'host'
}

/** 选择项（`value` 发往上游，`label` 给人看） */
export interface SettingChoice {
  value: string;
  label: string;
}

/** 设置项 */
export interface SettingItem {
  /** 上游设置键（ns 内的路径，用 `.` 连接；本地项为本地键） */
  key: string;
  label: string;
  /** 说明文字（必填：设置项不能只有名字，D3 §4 文案纪律） */
  hint: string;
  kind: SettingKind;
  /** 当前值（布尔/字符串） */
  boolValue: boolean;
  textValue: string;
  /** CHOICE 的选项（带显示名）；旧字段 `options` 保留为等价的取值列表 */
  options: string[];
  /** CHOICE 的选项（取值 + 显示名） */
  choices: SettingChoice[];
  /** 是否只读（本客户端目前不提供编辑入口） */
  readOnly: boolean;
  /**
   * Host 是否接受对该命名空间的写。
   *
   * 【为什么与 `readOnly` 分开】两者含义不同，混用会造成**会撒谎的界面**：
   *   - `hostWritable === false`：Host 明确不接受写，控件必须禁用并**说明原因**；
   *   - `readOnly === true` 但 `hostWritable === true`：Host 接受写，只是本客户端
   *     还没做这个形态的编辑器（实测的 `models[]`、`retryPolicy` 就是这种）。
   * 曾经把两者合成一个 `readOnly`，结果是「本客户端没做」被渲染成「Host 不允许」——
   * 用户会以为 Host 限制了权限，而实际上是我们自己的功能缺口。
   */
  hostWritable: boolean;
  /** 是否需要在 Host 侧生效（提示"应用后生效"） */
  appliesLive: boolean;
  /** 来源：本地偏好还是 Host 设置 */
  origin: SettingOrigin;
  /**
   * 是否已被**用户层**显式覆盖。
   *
   * 实测 `value` 是「schema 默认 → 组合基线 → 用户层」三层合并的结果，
   * 所以 `value` 无法区分「继承来的默认值」与「用户显式设成同一个值」。
   * 界面靠这个标记告诉用户「这一项是你在 Host 上改过的」。
   */
  userSet: boolean;
  /** 该设置项是一个凭据引用（实测 `meta.role === 'credential-ref'`） */
  credentialRef: boolean;
  /** 发往上游时的 JSON 值类型（决定 `"16"` 还是 `16`） */
  valueType: SettingValueType;
  /**
   * 数值约束（仅 `valueType === NUMBER` 时有意义）。
   *
   * 从 `meta.min` / `meta.max` / `meta.step` 实测取得。
   * 用 `hasBound` 而不是「`min === 0` 表示没有下界」这类哨兵值：
   * 实测 `min: 0` 是**真实存在的下界**（`llm-deepseek` 的若干项），
   * 用 0 当「无约束」会把合法值判成越界。
   */
  minValue: number;
  maxValue: number;
  stepValue: number;
  hasMin: boolean;
  hasMax: boolean;
  /** 字符串约束：实测形如 `{source, flags}` 的正则源码（空串 = 无约束） */
  pattern: string;
  /** 该字段是否必填（`meta.required === true`） */
  required: boolean;
  /**
   * 结构化字段的**当前值原文**（紧凑 JSON；仅 `STRUCT` 有内容）。
   *
   * 用紧凑 JSON 而不是美化版：它是「当前真实状态」的忠实表示，
   * 界面在打开编辑器时再美化（缩进）以便人读写。
   * 直接存美化版会在比较与复位时引入无意义的空白差异。
   */
  rawJson: string;
  /**
   * 结构化字段期望的外层类型（`'array'` / `'object'` / 空串 = 不校验）。
   *
   * 空串的情形是复杂 `union`（实测 `retryPolicy` 是
   * `union(object, object)`，两个分支都是对象，但**未来可能出现异构 union**）。
   * 对异构 union 强行按其中一支校验，会把合法的另一支挡在门外——
   * 所以宁可不校验，交给 Host 判定。
   */
  structType: string;
}

/** 设置分组 */
export interface SettingGroup {
  /** 分组标题（如「外观」「通知」） */
  title: string;
  items: SettingItem[];
}

/**
 * 「通用」分区承载的命名空间（E114，对齐官方 web 的层级）。
 *
 * 【依据】官方设置外壳的做法是：**「通用」分区没有内置行**，行由功能包通过
 * `settings.general.item` 注册进来（例如「外观」来自 ui-theme）。也就是说
 * 「通用」= **用户面向的功能包设置**，引擎内部参数不在其中。
 * 真机上 Host 报的 12 个命名空间里，符合这个定义的是下面这几个；
 * 模型相关的（`agent-default-model` / `llm-*` / `subagent-model-selection` /
 * `web-search-*`）归**模型分区**，引擎参数（`agent-loop` / `agent-presets`）不面向用户。
 *
 * 【为什么不是"全部隐藏"】用户**显式改过**的项即使属于引擎命名空间也要留在界面上
 * （否则他改过的东西无处可见、也无处撤回）。所以投影规则是"白名单 ∪ 用户已覆盖"。
 */
/**
 * 投影出「通用」分区应显示的分组（E114）。
 *
 * 规则（两条，缺一不可）：
 *   1. 白名单命名空间**整组**显示；
 *   2. 其余命名空间里**用户显式覆盖过**的项单独收进「其他已修改项」组——
 *      既保证"默认就好的参数不占版面"，又保证用户改过的东西永远找得到、撤得回。
 *
 * 标题用命名空间名（Host 的稳定标识）：官方是按贡献包给标题，我们这一层拿不到贡献包，
 * 用命名空间名比自造一个漂亮名字更诚实——它同时是诊断时能直接对照的键。
 */
export function projectGeneralGroups(groups: SettingGroup[]): SettingGroup[] {
  const out: SettingGroup[] = [];
  const others: SettingItem[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group: SettingGroup = groups[i];
    if (isGeneralNamespace(group.title)) {
      out.push(group);
      continue;
    }
    for (let j = 0; j < group.items.length; j++) {
      const item: SettingItem = group.items[j];
      if (item.userSet) {
        others.push(item);
      }
    }
  }
  if (others.length > 0) {
    out.push({ title: '其他已修改项', items: others });
  }
  return out;
}

/**
 * 一个命名空间的**写状态**（与 `SettingItem` 分开保存）。
 *
 * 为什么必须单独存：`revision` 是**写操作的并发令牌**（实测 `SettingsNamespaceView.revision`，
 * 见 D3b §2 第 3 条）。它属于「命名空间」而不属于「某个设置项」——
 * 同一个命名空间下改哪个字段都要带同一个 revision，且一次成功写会让它 +1。
 * 把它塞进每个 `SettingItem` 会立刻产生**同一份数据的多个副本**，
 * 而副本不同步的后果是：改完 A 字段后改 B 字段带着**过期 revision** → 恒被拒。
 */
export interface SettingsNamespaceState {
  ns: string;
  /** 最近一次读取/写入后的 revision */
  revision: number;
  /** Host 是否接受对该命名空间的写 */
  writable: boolean;
  /** `'live'`（立即生效）或 `'restart'`（需重启 Host） */
  applies: string;
}

/** 设置分组 + 它的命名空间写状态 */
export interface SettingsGroupEntry {
  group: SettingGroup;
  state: SettingsNamespaceState;
}

/** 写操作的结果（用于界面给出**可执行**的提示，而不是笼统的「失败」） */export enum SettingsWriteOutcome {
  /** 写入成功，Host 已接受 */
  OK = 'ok',
  /** 版本冲突：别的客户端改过，需要重新读取后再改（重试同一请求永远失败） */
  CONFLICT = 'conflict',
  /** Host 拒绝（只读提供方 / schema 校验 / 未注册命名空间） */
  REJECTED = 'rejected',
  /** 载体或其它失败（网络、未连接、端点不存在） */
  FAILED = 'failed'
}

/** 写操作的详细结果 */
export interface SettingsWriteResult {
  outcome: SettingsWriteOutcome;
  /** 用户可读的一句话（含发生了什么事 + 可以做什么） */
  message: string;
  /** 冲突时的实际 revision（若 Host 给出） */
  actualRevision: number;
}

/**
 * 凭据写入的结果。
 *
 * 与 `SettingsWriteResult` 分开：凭据写入没有 revision/冲突概念，
 * 强行复用会带上一堆永远为空的字段（而空字段正是「这格没测过」
 * 与「这格确实没有」无法区分的原因）。
 */
export interface CredentialWriteResult {
  ok: boolean;
  /** 用户可读的一句话（含发生了什么事 + 可以做什么） */
  message: string;
}

// ───────────────── 从 Host 的 settings/describe 生成设置项 ─────────────────

/**
 * `schemastery` schema 的一个节点（序列化后的形状）。
 *
 * **实测格式（D2b/D3b，必须照此读，不能按嵌套树猜）**：schema 不是树，
 * 而是一张**以 `uid` 为键的扁平表** `refs` + 一个根 `uid`：
 *
 * ```json
 * {"uid":231,"refs":{
 *   "225":{"type":"union","meta":{"default":"system"},"list":[220,222]},
 *   "220":{"type":"const","meta":{"required":true},"value":"light"},
 *   "231":{"type":"object","meta":{"default":{}},"dict":{"preference":225}}}}
 * ```
 *
 * 各结构键：
 *   - `dict`：对象字段名 → 子节点 uid（**设置项就来自这里**）
 *   - `list`：`union` 的候选 uid
 *   - `inner`：`array` 的元素 uid
 *   - `meta`：`required` / `default` / `min` / `max` / `step` / `pattern` / `role` / `description`
 *   - `value`：`const` 的取值
 */
const SCHEMA_KIND_STRING = 'string';
const SCHEMA_KIND_NUMBER = 'number';
const SCHEMA_KIND_BOOLEAN = 'boolean';
const SCHEMA_KIND_CONST = 'const';
const SCHEMA_KIND_UNION = 'union';
const SCHEMA_KIND_ARRAY = 'array';
const SCHEMA_KIND_OBJECT = 'object';
/** 实测值：该字段是一个凭据引用（不是普通字符串） */
const META_ROLE_CREDENTIAL_REF = 'credential-ref';

/** 从 `Record` 取一个字段（`readPath` 只吃点分路径，这里要按任意字符串键取） */
function fieldOf(source: Object | undefined, key: string): Object | undefined {
  if (source === undefined || !isRecord(source)) {
    return undefined;
  }
  return (source as Record<string, Object>)[key];
}

/** 按 `string[]` 路径读取**
 *
 * 为什么不用 `connection.readPath`：那个吃点分**字符串**路径，
 * 而 schema 的字段名里可能含点（`a.b` 会被它当成两段）。这里的路径是
 * 上游直接给出的段数组，必须逐段按字面键取。
 */
function readSegments(source: Object | undefined, segments: string[]): Object | undefined {
  let cursor: Object | undefined = source;
  for (let i = 0; i < segments.length; i++) {
    cursor = fieldOf(cursor, segments[i]);
    if (cursor === undefined) {
      return undefined;
    }
  }
  return cursor;
}

/** `camelCase` / `snake_case` → 人可读标签（schema 里**没有**显示名，实测） */
export function humanizeKey(key: string): string {
  if (key.length === 0) {
    return key;
  }
  let out: string = '';
  for (let i = 0; i < key.length; i++) {
    const ch: string = key.charAt(i);
    const code: number = key.charCodeAt(i);
    const isUpper: boolean = code >= 65 && code <= 90;
    if (i > 0 && isUpper) {
      out += ' ';
    }
    out += isUpper ? ch.toLowerCase() : ch;
  }
  return out.length > 0 ? out.charAt(0).toUpperCase() + out.substring(1) : key;
}

/** 把任意 JSON 标量渲染成一行文本（用于取值展示） */
function scalarText(value: Object | undefined): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value as string;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${value}`;
  }
  return JSON.stringify(value) ?? '';
}

/** 该字段是否被用户层显式覆盖（`user` 里出现同名键即为覆盖） */
function isUserSet(user: Object | undefined, field: string): boolean {
  if (user === undefined || !isRecord(user)) {
    return false;
  }
  return (user as Record<string, Object>)[field] !== undefined;
}

/**
 * 把一棵 schema 子节点的 `union(list:const…)` 展开成选择项。
 * 非枚举（例如 `union` 里混了对象分支）返回空数组，调用方降级为只读展示。
 */
function choicesOf(refs: Object, uid: number): SettingChoice[] {
  const node: Object | undefined = fieldOf(refs, `${uid}`);
  if (node === undefined || getString(node, 'type') !== SCHEMA_KIND_UNION) {
    return [];
  }
  const list: Object[] | undefined = getArray(node, 'list');
  if (list === undefined) {
    return [];
  }
  const out: SettingChoice[] = [];
  for (let i = 0; i < list.length; i++) {
    // `list` 的元素可能是 uid（数字）——实测如此
    const childUid: Object = list[i];
    if (typeof childUid !== 'number') {
      // 内联节点（非 uid）：实测未出现，按不可枚举处理而不是猜
      return [];
    }
    const child: Object | undefined = fieldOf(refs, `${childUid as number}`);
    if (child === undefined || getString(child, 'type') !== SCHEMA_KIND_CONST) {
      return [];
    }
    const value: Object | undefined = fieldOf(child, 'value');
    const text: string = scalarText(value);
    if (text.length === 0) {
      return [];
    }
    // 实测：上游**没有**枚举显示名，显示值就是取值本身
    out.push({ value: text, label: text });
  }
  return out;
}

/**
 * 结构化字段的**外层**类型（`'array'` / `'object'` / 空串 = 不校验）。
 *
 * 只有两种情况能给出确定的答案：
 *   - schema 节点本身是 `array` 或 `object`；
 *   - 是 `union` 且**所有**分支都是同一种外层类型（实测 `retryPolicy` 的
 *     `union(object,object)` 属于这种）。
 * 其余（含嵌套 union、异构 union）一律返回空串——**宁可不校验**，
 * 也不要因为猜错类型把合法输入挡在门外。
 */
function structOuterType(refs: Object, uid: number, type: string): string {
  if (type === SCHEMA_KIND_ARRAY || type === SCHEMA_KIND_OBJECT) {
    return type;
  }
  if (type !== SCHEMA_KIND_UNION) {
    return '';
  }
  const node: Object | undefined = fieldOf(refs, `${uid}`);
  if (node === undefined) {
    return '';
  }
  const list: Object[] | undefined = getArray(node, 'list');
  if (list === undefined || list.length === 0) {
    return '';
  }
  let seen: string = '';
  for (let i = 0; i < list.length; i++) {
    const childUid: Object = list[i];
    if (typeof childUid !== 'number') {
      return '';
    }
    const child: Object | undefined = fieldOf(refs, `${childUid as number}`);
    if (child === undefined) {
      return '';
    }
    const childType: string = getString(child, 'type') ?? '';
    if (childType !== SCHEMA_KIND_ARRAY && childType !== SCHEMA_KIND_OBJECT) {
      return '';
    }
    if (seen.length === 0) {
      seen = childType;
    } else if (seen !== childType) {
      // 异构 union：不校验
      return '';
    }
  }
  return seen;
}

/** `null` 与 `undefined` 在 JSON 里语义不同，但本层都表示「没有值」 */
function metaOf(refs: Object, uid: number): Object | undefined {  const node: Object | undefined = fieldOf(refs, `${uid}`);
  return node === undefined ? undefined : fieldOf(node, 'meta');
}

/**
 * 为一个字段生成**非空**的说明文字。
 *
 * D3 §4 要求设置项不能只有名字。实测**多数字段没有 `description`**，
 * 因此这里逐级降级到「上游字段名 + 约束」，而不是留下空串：
 * 空说明比没有说明更糟——它看起来像「这项没什么可说的」。
 */
function hintFor(ns: string, field: string, meta: Object | undefined,
  credentialRef: boolean): string {
  const described: string | undefined = meta === undefined ? undefined : getString(meta, 'description');
  if (described !== undefined && described.length > 0) {
    return described;
  }
  const parts: string[] = [];  if (credentialRef) {
    parts.push('凭据引用（不是明文；值由「凭据」页管理）');
  }
  const min: number | undefined = meta === undefined ? undefined : getNumber(meta, 'min');
  const max: number | undefined = meta === undefined ? undefined : getNumber(meta, 'max');
  if (min !== undefined || max !== undefined) {
    parts.push(`取值范围 ${min === undefined ? '不限' : min} – ${max === undefined ? '不限' : max}`);
  }
  const step: number | undefined = meta === undefined ? undefined : getNumber(meta, 'step');
  if (step !== undefined && step > 1) {
    parts.push(`步长 ${step}`);
  }
  if (meta !== undefined) {
    const pattern: Object | undefined = fieldOf(meta, 'pattern');
    if (pattern !== undefined) {
      const source: string | undefined = getString(pattern, 'source');
      if (source !== undefined && source.length > 0) {
        parts.push(`须匹配 ${source}`);
      }
    }
    if (getBoolean(meta, 'required') === true) {
      parts.push('必填');
    }
  }
  parts.push(`Host 设置项 ${ns}.${field}`);
  return parts.join('；');
}

/** 一个命名空间的投影结果 */
export interface SettingsNamespaceItems {
  ns: string;
  items: SettingItem[];
}

/**
 * 把 `settings/describe` 的一个命名空间视图投影成设置分组。
 *
 * 只展开 `dict` 的**一级字段**（实测设置项都在这一级）。嵌套对象与数组
 * （如 `llm-deepseek.models`、`retryPolicy`）以只读信息行呈现——
 * **不猜**它们的编辑形态：列表编辑器需要被嵌套 schema 的结构，
 * 而第一版没有实测过「写一个数组项」的线上效果，宁可不给入口。
 *
 * `writable` 为 false 时**所有**项只读（Host 明确说了不接受写）。
 */
export function projectSettingsNamespace(view: Object, writable: boolean): SettingsNamespaceItems {
  const ns: string = getString(view, 'ns') ?? '';
  const out: SettingsNamespaceItems = { ns: ns, items: [] };
  const schema: Object | undefined = getRecord(view, 'schema');
  if (schema === undefined || ns.length === 0) {
    return out;
  }
  const refs: Object | undefined = getRecord(schema, 'refs');
  const rootUid: number | undefined = getNumber(schema, 'uid');
  if (refs === undefined || rootUid === undefined) {
    return out;
  }
  const dict: Object | undefined = fieldOf(fieldOf(refs, `${rootUid}`), 'dict');
  if (dict === undefined || !isRecord(dict)) {
    return out;
  }
  const value: Object | undefined = getRecord(view, 'value');
  const user: Object | undefined = getRecord(view, 'user');
  const applies: string = getString(view, 'applies') ?? 'live';
  const fields: Record<string, Object> = dict as Record<string, Object>;

  for (const field of Object.keys(fields)) {
    const childUid: Object = fields[field];
    if (typeof childUid !== 'number') {
      continue;
    }
    const uid: number = childUid as number;
    const node: Object | undefined = fieldOf(refs, `${uid}`);
    if (node === undefined) {
      continue;
    }
    const type: string = getString(node, 'type') ?? '';
    const meta: Object | undefined = metaOf(refs, uid);
    const credentialRef: boolean =
      (meta === undefined ? '' : (getString(meta, 'role') ?? '')) === META_ROLE_CREDENTIAL_REF;
    const current: Object | undefined = fieldOf(value, field);
    const itemKey: string = `${ns}.${field}`;
    const minValue: number | undefined = meta === undefined ? undefined : getNumber(meta, 'min');
    const maxValue: number | undefined = meta === undefined ? undefined : getNumber(meta, 'max');
    const stepValue: number | undefined = meta === undefined ? undefined : getNumber(meta, 'step');
    const patternObj: Object | undefined = meta === undefined ? undefined : fieldOf(meta, 'pattern');
    const patternSource: string = patternObj === undefined
      ? '' : (getString(patternObj, 'source') ?? '');
    let valueType: SettingValueType = SettingValueType.OTHER;
    if (type === SCHEMA_KIND_STRING) {
      valueType = SettingValueType.STRING;
    } else if (type === SCHEMA_KIND_NUMBER) {
      valueType = SettingValueType.NUMBER;
    } else if (type === SCHEMA_KIND_BOOLEAN) {
      valueType = SettingValueType.BOOLEAN;
    }
    const base: SettingItem = {
      key: itemKey,
      label: humanizeKey(field),
      hint: hintFor(ns, field, meta, credentialRef),
      kind: SettingKind.INFO,
      boolValue: false,
      textValue: '',
      options: [],
      choices: [],
      // Host 不接受写时，任何形态都不可编辑
      readOnly: !writable,
      hostWritable: writable,
      appliesLive: applies !== 'restart',
      origin: SettingOrigin.HOST,
      userSet: isUserSet(user, field),
      credentialRef: credentialRef,
      valueType: valueType,
      minValue: minValue === undefined ? 0 : minValue,
      maxValue: maxValue === undefined ? 0 : maxValue,
      stepValue: stepValue === undefined ? 0 : stepValue,
      hasMin: minValue !== undefined,
      hasMax: maxValue !== undefined,
      pattern: patternSource,
      required: meta === undefined ? false : getBoolean(meta, 'required') === true,
      rawJson: current === undefined ? '' : (JSON.stringify(current) ?? ''),
      structType: structOuterType(refs, uid, type)
    };

    if (type === SCHEMA_KIND_BOOLEAN) {
      base.kind = SettingKind.TOGGLE;
      base.boolValue = current === true;
      out.items.push(base);
      continue;
    }
    const choices: SettingChoice[] = choicesOf(refs, uid);
    if (choices.length > 0) {
      base.kind = SettingKind.CHOICE;
      base.choices = choices;
      base.textValue = scalarText(current);
      for (let c = 0; c < choices.length; c++) {
        base.options.push(choices[c].value);
      }
      out.items.push(base);
      continue;
    }
    if (type === SCHEMA_KIND_STRING || type === SCHEMA_KIND_NUMBER) {
      base.kind = SettingKind.TEXT;
      base.textValue = scalarText(current);
      out.items.push(base);
      continue;
    }
    // `array` / `object` / 复杂 `union`：**整值编辑**。
    //
    // 【为什么不是只读】早先这里标成 `INFO` + `readOnly`，理由是「还没实测过
    // 怎么写数组元素」。现在实测过了（见 `SettingKind.STRUCT` 的说明）：
    // 深路径走不通，但**整值写回可行**。既然有可用的写法，就不该继续把这一整类
    // 设置标成「本客户端暂不支持」——那会让 `llm-deepseek.models`（4 个模型、
    // 各约 8 个字段）这样的重要配置永远改不了。
    //
    // Host 不接受写时仍然只读（`readOnly` 已由 `!writable` 置好）。
    base.kind = SettingKind.STRUCT;
    // 写回语义**按外层类型不同**，必须在说明里讲清（实测）：
    //   - 对象：`set` 一个对象是**逐键合并**，没提到的键保留旧值；
    //   - 数组：`set` 一个数组是**整体替换**（写成 [] 就真的清空了）。
    // 这条差异是用户最容易猜错的地方，而猜错的后果是「以为清空了其实没清」
    // 或「以为保留了其实被删了」——两种都很难察觉。
    if (base.structType === 'object') {
      base.hint = `${base.hint}；写回为逐键合并（未提到的键保留）`;
    } else if (base.structType === 'array') {
      base.hint = `${base.hint}；写回为整体替换（未列出的元素会被删除）`;
    }
    base.textValue = current === undefined
      ? '（未设置）'
      : `${type} · ${scalarText(current).length} 字符`;
    out.items.push(base);
  }
  return out;
}

/**
 * 把所有命名空间投影成分组列表（分组标题 = 命名空间名）。
 *
 * **不硬编码命名空间清单**：实测 Host 上的命名空间集合取决于它装了哪些插件
 * （本机 14 个），硬编码会退化成又一张「猜测表」。
 * 未知命名空间同样展示——只是没有友好标题。
 */
export function projectSettingsGroups(value: Object | undefined): SettingGroup[] {
  const entries: SettingsGroupEntry[] = projectSettingsEntries(value);
  const out: SettingGroup[] = [];
  for (let i = 0; i < entries.length; i++) {
    out.push(entries[i].group);
  }
  return out;
}

/**
 * 与 `projectSettingsGroups` 相同，但**带上每个命名空间的写状态**（revision 等）。
 *
 * 中枢用它保存并发令牌；纯展示路径用上面那个（UI 不需要看见 revision）。
 */
export function projectSettingsEntries(value: Object | undefined): SettingsGroupEntry[] {
  const out: SettingsGroupEntry[] = [];
  if (value === undefined) {
    return out;
  }
  const writable: boolean = getBoolean(value, 'writable') === true;
  const namespaces: Object[] | undefined = getArray(value, 'namespaces');
  if (namespaces === undefined) {
    return out;
  }
  for (let i = 0; i < namespaces.length; i++) {
    const view: Object = namespaces[i];
    const projected: SettingsNamespaceItems = projectSettingsNamespace(view, writable);
    if (projected.items.length === 0) {
      continue;
    }
    const state: SettingsNamespaceState = {
      ns: projected.ns,
      revision: getNumber(view, 'revision') ?? 0,
      writable: writable,
      applies: getString(view, 'applies') ?? 'live'
    };
    out.push({ group: { title: projected.ns, items: projected.items }, state: state });
  }
  return out;
}

/**
 * 构造 `settings/mutate` 的实参：设置项的 key → 有序路径操作。
 *
 * 设置项的 key 形如 `ns.field`。**只切第一个点**：命名空间名不含点（实测 14 个
 * 全部如此，如 `llm-deepseek`），而字段名可能含点（上游 `dict` 的键名无限制），
 * 所以其余点留给字段路径。
 *
 * `expectedRevision` **不能省略**：省略等于放弃乐观并发检查，两个客户端同时改
 * 会互相覆盖（D2b §4）。
 */
export function settingsMutateArgs(ns: string, fieldPath: string, value: Object,
  expectedRevision: number): Object {
  const segments: string[] = [];
  let start: number = 0;
  while (start <= fieldPath.length) {
    const dot: number = fieldPath.indexOf('.', start);
    const end: number = dot < 0 ? fieldPath.length : dot;
    const segment: string = fieldPath.substring(start, end);
    if (segment.length > 0) {
      segments.push(segment);
    }
    if (dot < 0) {
      break;
    }
    start = dot + 1;
  }
  const op: Record<string, Object> = {};
  op['op'] = 'set';
  op['path'] = segments;
  op['value'] = value;
  const ops: Object[] = [op as Object];
  const args: Record<string, Object> = {};
  args['ns'] = ns;
  args['ops'] = ops;
  args['expectedRevision'] = expectedRevision;
  return args as Object;
}

/**
 * 构造 `settings/mutate` 的**删除**实参（`{op:'unset', path}`）。
 *
 * 【`unset` 与「把值设为 null」的区别——这决定文案怎么写】
 *   实测：`{op:'unset', path:['retryPolicy','maxRetries']}` 成功，且该键的
 *   **用户层被移除、值回落到 schema 默认**（实测回读到默认值 5）。
 *   而 `{op:'set', path:[...], value:null}` 只是把值设成 `null`——
 *   `null` 在若干 schema 里是**合法取值**（实测存在 `{"type":"const","value":null}`），
 *   所以那是「设成 null」，不是「删掉」。
 *   界面上必须说成「恢复默认」而不是「清空为 null」，否则语义是错的。
 */
export function settingsUnsetArgs(ns: string, fieldPath: string, expectedRevision: number): Object {
  const segments: string[] = [];
  let start: number = 0;
  while (start <= fieldPath.length) {
    const dot: number = fieldPath.indexOf('.', start);
    const end: number = dot < 0 ? fieldPath.length : dot;
    const segment: string = fieldPath.substring(start, end);
    if (segment.length > 0) {
      segments.push(segment);
    }
    if (dot < 0) {
      break;
    }
    start = dot + 1;
  }
  const op: Record<string, Object> = {};
  op['op'] = 'unset';
  op['path'] = segments;
  const ops: Object[] = [op as Object];
  const args: Record<string, Object> = {};
  args['ns'] = ns;
  args['ops'] = ops;
  args['expectedRevision'] = expectedRevision;
  return args as Object;
}

/**
 * 把设置项的 key 拆成「命名空间 + 字段路径」（第一个点之前是命名空间）。
 * 拆不开时返回 undefined——调用方应**拒绝**这次写，而不是猜一个命名空间出来。
 */
export function splitSettingKey(key: string): SettingsKeyParts | undefined {
  const dot: number = key.indexOf('.');
  if (dot <= 0 || dot >= key.length - 1) {
    return undefined;
  }
  return { ns: key.substring(0, dot), fieldPath: key.substring(dot + 1) };
}

/** 设置项 key 的拆分结果 */
export interface SettingsKeyParts {
  ns: string;
  fieldPath: string;
}

/**
 * 用户输入 → 待写入的 JSON 值。
 *
 * 【为什么必须按 `valueType` 转换】实测 `ui-theme.fontSize` 的 schema 是
 * `{"type":"number"}`。把 `"16"` 当字符串发过去会被 Host 的 schema 校验拒绝，
 * 而错误信息只说「不符合 schema」——用户看到一个自己明明按提示填的数字被拒。
 * 所以数字字段必须发**数字**。
 *
 * 【为什么在客户端做校验，而不是直接让 Host 拒】两条都做，但客户端先做：
 * Host 的拒绝文案是给开发者看的（「不符合 schema」），而用户需要的是
 * 「这个值超出 12–17 的范围」。本地校验能把这句话说清楚，也省一次往返。
 * Host 仍是最终权威——它的拒绝走 `settings/rejected` 分支如实呈现。
 */
export function parseSettingInput(item: SettingItem, raw: string): SettingInputResult {
  const text: string = raw.trim();
  if (item.valueType === SettingValueType.NUMBER) {
    if (text.length === 0) {
      // 数字字段不接受空串：空串在 JSON 里没有对应的数字
      return { ok: false, message: '请输入一个数字。', value: undefined };
    }
    const num: number = Number(text);
    if (Number.isNaN(num)) {
      return { ok: false, message: `「${text}」不是有效的数字。`, value: undefined };
    }
    if (item.hasMin && num < item.minValue) {
      return { ok: false, message: `不能小于 ${item.minValue}。`, value: undefined };
    }
    if (item.hasMax && num > item.maxValue) {
      return { ok: false, message: `不能大于 ${item.maxValue}。`, value: undefined };
    }
    if (item.stepValue > 1 && num % item.stepValue !== 0) {
      // 实测 `step` 语义是「整数步长」；只对 >1 的步长提示，避免把 step=1 说成约束
      return { ok: false, message: `必须是 ${item.stepValue} 的整数倍。`, value: undefined };
    }
    return { ok: true, message: '', value: num as Object };
  }
  // 字符串字段
  if (text.length === 0 && item.required) {
    return { ok: false, message: '这一项是必填的，不能留空。', value: undefined };
  }
  if (item.pattern.length > 0) {
    let matched: boolean = true;
    try {
      const re: RegExp = new RegExp(item.pattern);
      matched = re.test(text);
    } catch (err) {
      // 正则本身非法（上游 schema 出错）：不因此拦下用户的输入——
      // 放行并让 Host 去判定，否则一个坏 schema 会让这一项永远改不了。
      matched = true;
    }
    if (!matched) {
      return { ok: false, message: `格式不符合要求（须匹配 ${item.pattern}）。`, value: undefined };
    }
  }
  return { ok: true, message: '', value: text as Object };
}

/** 输入解析结果 */
export interface SettingInputResult {
  ok: boolean;
  /** 不合法时的原因（给人看的一句话） */
  message: string;
  /** 合法时待写入的值（已按 `valueType` 转成正确的 JSON 类型） */
  value: Object | undefined;
}

/**
 * 结构化值（数组 / 对象）的输入解析。
 *
 * 【为什么必须校验「类型与外层一致」】写回意味着我们提交的是整个字段的新内容。
 * 若用户的输入是合法 JSON 但类型不对（该是数组却给了对象），Host 的报错是
 * `$.models expected array but got [object Object]`（实测原文）——
 * 对用户来说是天书。这里先挡住，并把这句翻译成「这一项需要一个数组」。
 *
 * 【为什么允许 `null`】实测 schema 里存在 `{"type":"const","value":null}` 的分支
 * （`providers.*.models[].reasoningEfforts` 的 union 就有 null 分支），
 * 所以 `null` 是**合法取值**，不能当成「空输入」拒掉。
 *
 * @param item - 目标设置项（用于取期望的外层类型）
 * @param raw - 用户输入的文本
 */
export function parseStructInput(item: SettingItem, raw: string): SettingInputResult {
  const text: string = raw.trim();
  if (text.length === 0) {
    return { ok: false, message: '内容不能为空。若要清空一个数组，请输入 []。', value: undefined };
  }
  const parsed: Object | undefined = parseJson(text);
  if (parsed === undefined) {
    // `parseJson` 对语法错误只返回 undefined，不会有更细的原因——
    // 因此文案指向最常见的两类问题，而不是编一个具体的出错位置
    return {
      ok: false,
      message: '不是合法的 JSON。请检查引号（必须用双引号）、逗号与括号是否配对。',
      value: undefined
    };
  }
  if (parsed === null) {
    // null 是合法取值，直接放行
    return { ok: true, message: '', value: parsed };
  }
  const expected: string = structExpectation(item);
  const isArray: boolean = Array.isArray(parsed);
  if (expected === 'array' && !isArray) {
    return { ok: false, message: '这一项需要一个数组（以 [ 开头、] 结尾）。', value: undefined };
  }
  if (expected === 'object' && (isArray || typeof parsed !== 'object')) {
    return { ok: false, message: '这一项需要一个 JSON 对象（以 { 开头、} 结尾）。', value: undefined };
  }
  return { ok: true, message: '', value: parsed };
}

/**
 * 该结构化字段期望的外层类型。
 *
 * 取不到时返回空串 = **不做外层类型校验**（而不是猜一个）：
 * 猜错会把合法输入挡在门外，那比让 Host 去判更糟。
 */
function structExpectation(item: SettingItem): string {
  if (item.structType === 'array' || item.structType === 'object') {
    return item.structType;
  }
  return '';
}

/**
 * 合并「来自 Host 的设置」与「本客户端本地偏好」。
 *
 * 【为什么必须合并，而不是二选一】
 *   本客户端的通知、离线缓存等偏好**不存在于上游**——Host 的
 *   `settings/describe` 里没有这些命名空间。若连上 Host 后整页替换成
 *   Host 设置，这些本地偏好就会**从界面上消失**（用户会以为功能没了）；
 *   若反过来只显示本地偏好，用户又无法配置真正生效的 Host 设置。
 *
 * Host 分组在前（那是用户来设置页主要想看的东西），本地分组在后。
 */
export function mergeSettingsGroups(host: SettingGroup[], local: SettingGroup[]): SettingGroup[] {
  const out: SettingGroup[] = [];
  for (let i = 0; i < host.length; i++) {
    out.push(host[i]);
  }
  for (let j = 0; j < local.length; j++) {
    out.push(local[j]);
  }
  return out;
}

// ─────────────────────────── 凭据 ───────────────────────────

/** 凭据条目（**绝不包含明文值**，只呈现状态，D1 §11.5 S3/S4） */
export interface CredentialItem {
  /** 引用名（如 DEEPSEEK_API_KEY） */
  ref: string;
  /** 是否已配置 */
  configured: boolean;
  /** 是否可写（Host 侧决定） */
  writable: boolean;
  /** 来源说明（file / env / 交互式授权） */
  source: string;
  /** 是否支持交互式授权 flow（如 OAuth / 粘贴码） */
  interactive: boolean;
  /** 所属设置命名空间（E96：官方按"提供方"组织模型与密钥，命名空间是这条线索的来源） */
  namespace: string;
  /** 提供方 id（当引用路径形如 `providers.<id>.…` 时非空） */
  providerId: string;
}

/**
 * 一条凭据引用的**来源信息**（E96）。
 *
 * 【为什么要带 namespace / providerId】官方 Models 页是"一个提供方一行、行上带密钥状态"，
 * 而这条关联只能从 `settings/describe` 的引用路径里读出来：
 * `namespaces[].secrets[].path` 形如 `["providers", "<providerId>", "apiKey"]`。
 * 早先的投影只留了 `path.join('.')`，**把命名空间与提供方 id 丢掉了**，
 * 于是界面只能看到一个孤零零的 `apiKey`，说不出它属于谁。
 */
export interface CredentialRefInfo {
  ref: string;
  namespace: string;
  providerId: string;
}

// ─────────────────────────── 插件 ───────────────────────────

/** 插件条目（对应 pluginInventory 的投影） */
export interface PluginItem {
  entryId: string;
  moduleName: string;
  enabled: boolean;
  /** cordis fiber 阶段（active / null） */
  phase: string;
  /** 是否第一方（@deepseek-ai/*） */
  firstParty: boolean;
}

/** 插件健康度（用于设置页的一行摘要） */
export function pluginSummary(items: PluginItem[]): string {
  let enabled: number = 0;
  let active: number = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i].enabled) {
      enabled++;
    }
    if (items[i].phase === 'active') {
      active++;
    }
  }
  return `${items.length} 个条目 · ${enabled} 已启用 · ${active} 运行中`;
}

/**
 * 投影 `pluginInventory/list` 的回复。
 *
 * 实测形状（D2 §8.7.2）：`{entries:[{entryId, moduleName, enabled, fiberPhase}]}`，
 * 其中 `fiberPhase` 是 `'active'` 或 `null`（**不是**空串）。
 * `null` 表示「已加载但未进入 active 阶段」，界面上按原样展示，不美化。
 *
 * `firstParty` 由模块名推断（`@deepseek-ai/*`）——这是**本地展示分类**，
 * 不是上游字段；上游没有「第一方」这个概念。注释写清楚以免被当成协议事实。
 */
export function projectPluginInventory(value: Object | undefined): PluginItem[] {
  const out: PluginItem[] = [];
  if (value === undefined) {
    return out;
  }
  const entries: Object[] | undefined = getArray(value, 'entries');
  if (entries === undefined) {
    return out;
  }
  for (let i = 0; i < entries.length; i++) {
    const entry: Object = entries[i];
    const entryId: string = getString(entry, 'entryId') ?? '';
    if (entryId.length === 0) {
      // 无 id 的条目无法在界面上区分，跳过而不是产出一行空卡片
      continue;
    }
    const moduleName: string = getString(entry, 'moduleName') ?? '';
    out.push({
      entryId: entryId,
      moduleName: moduleName,
      enabled: getBoolean(entry, 'enabled') === true,
      // fiberPhase 为 null 时统一成空串：本层契约里 phase 是 string
      phase: getString(entry, 'fiberPhase') ?? '',
      firstParty: moduleName.indexOf('@deepseek-ai/') === 0
    });
  }
  return out;
}

/**
 * 从 `settings/describe` 的回复里取出**凭据引用列表**。
 *
 * 这是凭据页的前置：`credentials/describe` **没有「列出全部」模式**——
 * 实测传 `refs: []` 只得到 `{}`。ref 列表的唯一来源就是各命名空间声明的
 * `secrets[].path`（D2 §8.7.2 第 17/19 条）。
 *
 * **ref 的编码是 `path` 用 `.` 连接，不带命名空间前缀**（实测确证，D2 §8.7.2 第 18 条）：
 * `"apiKey"` 命中，而看起来更自然的 `"<ns>:apiKey"` 被 `gateway/bad-request` 拒绝。
 * 这里按实测编码拼接；若上游改变编码，失败会表现为「凭据全部显示未配置」——
 * 一个不报错只撒谎的形态，因此本函数的上游出处必须在升级时重点复核。
 *
 * ⚠️ **只取 `path`，绝不要读同一个对象里的 `set`。** 实测（2026-09-11）：
 * 对同一个 Host 连续做 `credentials/set`（→ `configured: true, source: "file"`）
 * 与 `credentials/unset`（→ `configured: false`），`settings/describe` 的
 * `secrets[].set` **始终是 `false`**。它表达的是「这个 secret 槽位**是否存在**」，
 * 不是「是否已配置」。拿它当配置状态用会让界面**永远显示未配置**，
 * 而真正的状态在 `credentials/describe`（那一份会如实变化）。
 */
export function projectCredentialRefs(value: Object | undefined): CredentialRefInfo[] {
  const out: CredentialRefInfo[] = [];
  if (value === undefined) {
    return out;
  }
  const namespaces: Object[] | undefined = getArray(value, 'namespaces');
  if (namespaces === undefined) {
    return out;
  }
  for (let i = 0; i < namespaces.length; i++) {
    const ns: string = getString(namespaces[i], 'ns') ?? getString(namespaces[i], 'name') ?? '';
    const secrets: Object[] | undefined = getArray(namespaces[i], 'secrets');
    if (secrets === undefined) {
      continue;
    }
    for (let j = 0; j < secrets.length; j++) {
      const path: Object[] | undefined = getArray(secrets[j], 'path');
      if (path === undefined || path.length === 0) {
        continue;
      }
      const parts: string[] = [];
      for (let k = 0; k < path.length; k++) {
        const seg: Object = path[k];
        parts.push(typeof seg === 'string' ? seg as string : '');
      }
      const ref: string = parts.join('.');
      if (ref.length === 0) {
        continue;
      }
      // 提供方 id：路径形如 `providers.<id>.…` 时取第二段（官方也是按提供方组织密钥）
      let providerId: string = '';
      if (parts.length >= 2 && parts[0] === 'providers') {
        providerId = parts[1];
      }
      let known: boolean = false;
      for (let m = 0; m < out.length; m++) {
        if (out[m].ref === ref) {
          known = true;
        }
      }
      if (!known) {
        out.push({ ref: ref, namespace: ns, providerId: providerId });
      }
    }
  }
  return out;
}

/**
 * 投影 `credentials/describe` 的回复。
 *
 * 实测形状：`{"<ref>": {configured, source?, writable}}`——一个**以 ref 为键的映射**。
 * 因此必须把 `refs` 一起传入：不能靠遍历回复的键还原顺序（Host 只会回应被请求的 ref）。
 *
 * 实测（2026-09-11）这一份状态是**活的**：
 *   - 未配置时 `{configured:false, writable:true}`，且 `source` **缺省**；
 *   - `credentials/set` 之后 `{configured:true, source:"file", writable:true}`；
 *   - `credentials/unset` 之后回到 `{configured:false, writable:true}`。
 * 因此**配置状态的唯一权威来源就是这里**（`settings/describe` 的 `secrets[].set`
 * 在同样的操作下始终为 false，见 `projectCredentialRefs` 的说明）。
 *
 * 三个取舍：
 *   - `source` 在**未配置时缺省**（可选字段）。不能当成空串来源，
 *     否则界面会把「没有来源信息」显示成一个来源；这里仅在存在时赋值。
 *   - `interactive`（是否支持交互式授权）**线协议里没有对应字段**，一律置 false
 *     并在此说明——凭空假定为 true 会渲染出一个并不存在的「去授权」按钮。
 *     注意：这不代表凭据不可写；可写性由 `writable` 表达（实测有可写的 ref）。
 *   - Host 未描述某条 ref 时**保留一个「未配置」条目**而不是丢掉：
 *     丢掉会让用户以为 Host 上根本没有这项凭据。
 */
export function projectCredentials(value: Object | undefined, refs: CredentialRefInfo[]): CredentialItem[] {
  const out: CredentialItem[] = [];
  const map: Record<string, Object> = (value === undefined ? {} : value) as Record<string, Object>;
  for (let i = 0; i < refs.length; i++) {
    const info0: CredentialRefInfo = refs[i];
    const ref: string = info0.ref;
    const info: Object | undefined = map[ref];
    if (info === undefined || info === null) {
      out.push({
        ref: ref, configured: false, writable: false, source: '', interactive: false,
        namespace: info0.namespace, providerId: info0.providerId
      });
      continue;
    }
    out.push({
      ref: ref,
      configured: getBoolean(info, 'configured') === true,
      writable: getBoolean(info, 'writable') === true,
      source: getString(info, 'source') ?? '',
      interactive: false,
      namespace: info0.namespace,
      providerId: info0.providerId
    });
  }
  return out;
}

// ─────────────────────────── 设备与 Host ───────────────────────────

/** Host 记录（对应 D1 §7.1 的多 Host 管理） */
export interface HostRecord {
  id: string;
  name: string;
  authority: string;
  /** 是否 loopback（决定接入路径 L0/L1，D1 §6.4） */
  isLoopback: boolean;
  /** 接入级别展示文案 */
  level: string;
  /** 是否已授权（持有会话 cookie） */
  authorized: boolean;
  /** Host 核心包版本（用于版本矩阵提示） */
  version: string;
}

/** 连接状态展示（D3 §4 状态与文案规范） */
export interface ConnectionBanner {
  /** 是否已连接 */
  connected: boolean;
  /** 一行状态（如「已连接 · clientId=…」） */
  text: string;
  /** 是否需要用户动作（显示按钮） */
  actionable: boolean;
  /** 动作按钮文案 */
  actionLabel: string;
}

// ─────────────────────────── 诊断 ───────────────────────────

/** 诊断项（与 connection 的 DiagnosticItem 对齐，此处为呈现层副本以避免跨层依赖） */
export interface DiagEntry {
  name: string;
  passed: boolean;
  detail: string;
  advice: string;
}

/** 诊断报告呈现模型 */
export interface DiagReport {
  entries: DiagEntry[];
  healthy: boolean;
  /** 生成时间（毫秒） */
  generatedAt: number;
  /** 上游版本判定结论（来自 dshcompat.checkVersion） */
  versionVerdict: string;
  versionMessage: string;
  versionAdvice: string;
  /** 兼容面上表统计 */
  tableStats: string;
  /** 当前接口面（用于暴露"是否漏注入"） */
  surface: string;
}

// ─────────────────────────── 关于与版本 ───────────────────────────

/** 关于页信息 */
export interface AboutInfo {
  appVersion: string;
  /** 受支持的上游版本矩阵（来自 dshcompat） */
  supportedUpstream: string;
  /** 兼容面采集时间 */
  compatCapturedAt: string;
  /** 端点上表规模描述 */
  endpointStats: string;
}

// ─────────────────────────── 模型选择 ───────────────────────────

/** 模型选项 */
export interface ModelOption {
  provider: string;
  providerName: string;
  modelId: string;
  modelName: string;
  description: string;
  /** 推理强度选项（空 = 不支持） */
  efforts: string[];
  defaultEffort: string;
}

/**
 * 投影 `session/modelCatalog` 的回复。
 *
 * 实测形状（D2 §8.7.2）：
 * `{default:{provider,model,routingEffort?}, routableProviders:[…],
 *   groups:[{id, name, models:[{id, name, description?, reasoning?:{efforts:[{id,name,description?}], defaultEffort?}}]}]}`
 *
 * 投影策略：把两级结构（provider 分组 → 模型）**拍平成 `ModelOption[]`**，
 * 因为本层契约是按「一行一个可选模型」设计的（设置页的模型页签与输入区的
 * 模型 chip 都按这个粒度选择）。provider 名与 id 都保留下来，
 * 以便选择后能构造上游要求的 `{provider, model, reasoningEffort}`。
 *
 * `efforts` 取的是**强度 id 列表**（不是显示名）——下游要把它原样发回上游。
 * 显示名由界面按需查表，不在这里混入。
 */
export function projectModelCatalog(value: Object | undefined): ModelOption[] {
  const out: ModelOption[] = [];
  if (value === undefined) {
    return out;
  }
  const groups: Object[] | undefined = getArray(value, 'groups');
  if (groups === undefined) {
    return out;
  }
  for (let g = 0; g < groups.length; g++) {
    const group: Object = groups[g];
    const providerId: string = getString(group, 'id') ?? '';
    const providerName: string = getString(group, 'name') ?? providerId;
    const models: Object[] | undefined = getArray(group, 'models');
    if (models === undefined) {
      continue;
    }
    for (let m = 0; m < models.length; m++) {
      const model: Object = models[m];
      const modelId: string = getString(model, 'id') ?? '';
      if (modelId.length === 0 || providerId.length === 0) {
        // provider/model 是后续 selectModel 的必需定位信息，缺一不可用
        continue;
      }
      const efforts: string[] = [];
      let defaultEffort: string = '';
      const reasoning: Object | undefined = getRecord(model, 'reasoning');
      if (reasoning !== undefined) {
        const list: Object[] | undefined = getArray(reasoning, 'efforts');
        if (list !== undefined) {
          for (let e = 0; e < list.length; e++) {
            const id: string = getString(list[e], 'id') ?? '';
            if (id.length > 0) {
              efforts.push(id);
            }
          }
        }
        defaultEffort = getString(reasoning, 'defaultEffort') ?? '';
      }
      out.push({
        provider: providerId,
        providerName: providerName,
        modelId: modelId,
        modelName: getString(model, 'name') ?? modelId,
        description: getString(model, 'description') ?? '',
        efforts: efforts,
        defaultEffort: defaultEffort
      });
    }
  }
  return out;
}

/**
 * 投影模型目录里的**默认选择**（Host 为未配置会话准备的默认路由）。
 * 返回 undefined 表示 Host 没给默认值（界面应保持当前选择而不是猜一个）。
 */
export function projectDefaultSelection(value: Object | undefined): ModelSelection | undefined {
  if (value === undefined) {
    return undefined;
  }
  const def: Object | undefined = getRecord(value, 'default');
  if (def === undefined) {
    return undefined;
  }
  const provider: string = getString(def, 'provider') ?? '';
  const model: string = getString(def, 'model') ?? '';
  if (provider.length === 0 || model.length === 0) {
    return undefined;
  }
  return { provider: provider, modelId: model, effort: getString(def, 'reasoningEffort') ?? '' };
}

/** 当前模型与推理强度 */
export interface ModelSelection {
  provider: string;
  modelId: string;
  effort: string;
}

/** 当前选择的显示文案 */
export function modelSelectionLabel(selection: ModelSelection, options: ModelOption[]): string {
  for (let i = 0; i < options.length; i++) {
    const o: ModelOption = options[i];
    if (o.provider === selection.provider && o.modelId === selection.modelId) {
      return o.modelName.length > 0 ? o.modelName : o.modelId;
    }
  }
  return selection.modelId.length > 0 ? selection.modelId : '未选择模型';
}
