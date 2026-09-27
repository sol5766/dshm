/**
 * 会话列表模型：会话查询的返回投影。
 *
 * 事实基线（D2 §8.5）：会话查询端点由 `dshcompat` 提供（参数形态为 `_request` 包装，
 * 见该模块的生成上表）；实测返回 `{"items":[...]}`。
 *
 * 分层纪律（回答「方便适配上游升级」）：
 *   本模块**不硬编码** endpoint 名与字段名——
 *   端点与参数形态由 `dshcompat` 的 `sessionListArgs()` 决定，
 *   字段别名由 `dshcompat` 的 `FIELD_ALIASES` 提供。
 *   上游改名/改端点时只改 dshcompat，本文件不动。
 *
 * 投影策略：对每个字段按候选别名依次尝试（容忍上游改名与历史名称），
 * 缺失字段不猜测；同时保留 `raw` 供尚未建模的字段使用。
 */

import { getNumber, getRecord, getString, isRecord } from 'connection';
import { FIELD_ALIASES, SESSION_LIST_ENDPOINT, sessionListArgs, titleFromProjections } from 'dshcompat';

/**
 * 无标题时的中性兜底文案。
 *
 * 故意**不导出**：`Notify.ets` 与 `Wire.ets` 各自也导出同名的 `UNTITLED_SESSION`，
 * 三者语义相同但分属不同模块；若这里也导出，`appstate/Index.ets` 就会出现重名冲突，
 * 只能靠改名规避。保持模块私有最简单，也避免出现三份可被误用的公开别名。
 */
const UNTITLED_SESSION: string = '新会话';

/** 列表项（宽松投影；未知字段保留在 raw 中） */
export interface SessionListItem {
  /** 会话 id */
  id: string;
  /** 标题（Host 侧生成的标题；缺失时上层用首条用户消息兜底） */
  title: string;
  /** 工作区路径（可空） */
  cwd: string;
  /** 最近活动时间（毫秒时间戳；无则 0） */
  updatedAt: number;
  /** 创建时间（毫秒时间戳；无则 0） */
  createdAt: number;
  /** 是否正在运行（Host 若未提供则为 false） */
  running: boolean;
  /** 是否「空会话」（尚无任何轮次）。列表默认不过滤，但 UI 可用它区分「刚建好还没说话」 */
  blank: boolean;
  /** 原始对象（供尚未建模的字段使用） */
  raw: Object;
}

/** 列表返回 */
export interface SessionListPage {
  items: SessionListItem[];
  /** 是否可能还有更多（Host 若未提供分页信息则为 false） */
  hasMore: boolean;
}

/**
 * 从会话查询的返回投影出列表。
 * 兼容两种形态：`{ items: [...] }`（容器键由 dshcompat 的别名表提供）与直接返回数组。
 */
export function projectSessionList(value: Object | undefined): SessionListPage {
  const items: SessionListItem[] = [];
  let hasMore: boolean = false;

  if (value === undefined) {
    return { items: items, hasMore: hasMore };
  }

  let array: Object[] | undefined;
  if (Array.isArray(value)) {
    array = value as Object[];
  } else {
    // 容器键按别名表依次尝试（上游改名时只改 dshcompat）
    //
    // 【必须用 getArray，不能用 getRecord】
    //   `getRecord` 内部走 `isRecord`，而 `isRecord` **明确排除数组**
    //   （`return !Array.isArray(value)`），因此对 `{items:[…]}` 里的 `items`
    //   永远返回 undefined。曾经这里用 getRecord → 真实 Host 上**永远解析出 0 条**，
    //   而桩数据路径完全不经过本函数，所以本地看不出任何异常；
    //   只有端到端连上真实 Host 才会暴露（首次真机验证即命中：宿主有 4 个会话，界面 0 个）。
    const holder: Record<string, Object> = value as Record<string, Object>;
    const listKeys: string[] = FIELD_ALIASES.list;
    for (let i = 0; i < listKeys.length; i++) {
      const candidate: Object | undefined = holder[listKeys[i]];
      if (Array.isArray(candidate)) {
        array = candidate as Object[];
        break;
      }
    }
    // hasMore 是布尔值，同样不能用 getRecord（它只认对象）
    const more: Object | undefined = holder['hasMore'];
    if (typeof more === 'boolean') {
      hasMore = more as boolean;
    }
  }

  if (array === undefined) {
    return { items: items, hasMore: hasMore };
  }

  for (let i = 0; i < array.length; i++) {
    const raw: Object = array[i];
    if (!isRecord(raw)) {
      continue;
    }
    const item: SessionListItem = {
      id: pickString(raw, FIELD_ALIASES.id),
      title: pickTitle(raw),
      cwd: pickString(raw, FIELD_ALIASES.cwd),
      updatedAt: pickNumber(raw, FIELD_ALIASES.updatedAt),
      createdAt: pickNumber(raw, FIELD_ALIASES.createdAt),
      running: pickBoolean(raw, FIELD_ALIASES.running),
      blank: pickBoolean(raw, ['blank']),
      raw: raw
    };
    if (item.id.length === 0) {
      // 无 id 的条目无法用于后续调用，跳过而不是产出脏数据
      continue;
    }
    items.push(item);
  }

  // 默认按最近活动倒序（Host 若已排序则此步为稳定无操作）
  items.sort((a: SessionListItem, b: SessionListItem) => b.updatedAt - a.updatedAt);
  return { items: items, hasMore: hasMore };
}

/** 本轮会话查询使用的 endpoint（供调用方构造请求，避免在 UI 层写字面量） */
export function sessionListEndpoint(): string {
  return SESSION_LIST_ENDPOINT;
}

/** 会话查询的 args 载荷（形状由 dshcompat 的上表决定） */
export function sessionListPayload(body: Object): Object | undefined {
  return sessionListArgs(body);
}

/** 按候选键名取第一个非空字符串 */
function pickString(source: Object, keys: string[]): string {
  for (let i = 0; i < keys.length; i++) {
    const value: string | undefined = getString(source, keys[i]);
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }
  return '';
}

/**
 * 取会话标题。
 *
 * 【重要修正 · 整合 0.1.5-rc.1 时发现】
 *   上游 `SessionSummary` **没有顶层标题字段**。真实的标题在
 *   `summary.projections.values.title`（类型 `string | null`，
 *   见 `@deepseek-ai/dsh-session-title/lib/types/types.d.ts` 的 `SessionProjectionMap.title`）。
 *   仅按顶层别名读会让**每一个会话都显示为「无标题」**——而且不会报错，
 *   是最难发现的那类缺陷（静默降级成空值）。
 *
 * 【兜底链（实测驱动）】
 *   刚在 Host 上建好、还没说过话的会话，`projections.values.title` 就是 **`null`**
 *   （实测：新建会话的 `values.title === null`，`sessionListMetadata.blank === true`）。
 *   标题为空**不代表会话不可用**，界面必须给出可辨识的替代文案，否则列表里会出现
 *   一行空白条目——用户既点不动也认不出。因此按三级兜底：
 *     1. 投影标题（权威来源）
 *     2. 顶层别名（容忍历史/第三方 Host）
 *     3. 工作目录的末段（用户通常靠项目名认出会话）
 *     4. 中性文案「新会话」
 */
function pickTitle(source: Object): string {
  const projections: Object | undefined = getRecord(source, 'projections');
  if (projections !== undefined) {
    const values: Object | undefined = getRecord(projections, 'values');
    if (values !== undefined) {
      const fromProjection: string | undefined =
        titleFromProjections(values as Record<string, Object>);
      if (fromProjection !== undefined && fromProjection.length > 0) {
        return fromProjection;
      }
    }
  }
  const fromTopLevel: string = pickString(source, FIELD_ALIASES.title);
  if (fromTopLevel.length > 0) {
    return fromTopLevel;
  }
  const base: string = lastPathSegment(pickString(source, FIELD_ALIASES.cwd));
  return base.length > 0 ? base : UNTITLED_SESSION;
}

/**
 * 取路径末段（兼容 `/` 与 `\` 两种分隔符）。
 *
 * 不引入 `path` 之类模块：只做一次纯字符串切分，避免为一个四行的需求增加依赖与平台差异。
 * 末尾有分隔符时向前跳过，避免把 `…/foo/` 解析成空串。
 */
function lastPathSegment(cwd: string): string {
  if (cwd.length === 0) {
    return '';
  }
  let end: number = cwd.length;
  while (end > 0 && (cwd.charAt(end - 1) === '/' || cwd.charAt(end - 1) === '\\')) {
    end--;
  }
  let start: number = end;
  while (start > 0) {
    const ch: string = cwd.charAt(start - 1);
    if (ch === '/' || ch === '\\') {
      break;
    }
    start--;
  }
  return cwd.substring(start, end);
}

/** 按候选键名取第一个数字 */
function pickNumber(source: Object, keys: string[]): number {
  for (let i = 0; i < keys.length; i++) {
    const value: number | undefined = getNumber(source, keys[i]);
    if (value !== undefined) {
      return value;
    }
  }
  return 0;
}

/** 按候选键名取第一个布尔值 */
function pickBoolean(source: Object, keys: string[]): boolean {
  for (let i = 0; i < keys.length; i++) {
    const holder: Record<string, Object> = source as Record<string, Object>;
    const value: Object | undefined = holder[keys[i]];
    if (typeof value === 'boolean') {
      return value as boolean;
    }
  }
  return false;
}
