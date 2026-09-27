/**
 * JSON 安全取值工具。
 *
 * 为什么需要：协议层的所有入参都来自外部 JSON（HTTP 响应体 / WebSocket 帧），
 * ArkTS 禁止 `any` 与无检查的下标访问，因此统一通过本模块做「显式收窄」。
 * 所有取值函数在类型不符时返回 undefined，绝不抛异常。
 */

/** 判断是否为「可当对象使用」的值（非 null、非数组的 object） */
export function isRecord(value: Object | null | undefined): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value !== 'object') {
    return false;
  }
  return !Array.isArray(value);
}

/** 安全读取对象属性；非对象或键不存在时返回 undefined */
export function getField(source: Object | null | undefined, key: string): Object | undefined {
  if (!isRecord(source)) {
    return undefined;
  }
  const holder: Record<string, Object> = source as Record<string, Object>;
  const value: Object | undefined = holder[key];
  return value;
}

/** 读取字符串字段 */
export function getString(source: Object | null | undefined, key: string): string | undefined {
  const value: Object | undefined = getField(source, key);
  return typeof value === 'string' ? value as string : undefined;
}

/** 读取数字字段（含 NaN 保护） */
export function getNumber(source: Object | null | undefined, key: string): number | undefined {
  const value: Object | undefined = getField(source, key);
  if (typeof value !== 'number') {
    return undefined;
  }
  const num: number = value as number;
  return Number.isNaN(num) ? undefined : num;
}

/** 读取布尔字段 */
export function getBoolean(source: Object | null | undefined, key: string): boolean | undefined {
  const value: Object | undefined = getField(source, key);
  return typeof value === 'boolean' ? value as boolean : undefined;
}

/** 读取对象字段（要求是 record） */
export function getRecord(source: Object | null | undefined, key: string): Object | undefined {
  const value: Object | undefined = getField(source, key);
  return isRecord(value) ? value : undefined;
}

/** 读取数组字段（元素为未知 JSON 值） */
export function getArray(source: Object | null | undefined, key: string): Object[] | undefined {
  const value: Object | undefined = getField(source, key);
  return Array.isArray(value) ? value as Object[] : undefined;
}

/** 判断数组内是否全部为字符串 */
export function isStringArray(value: Object[] | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string') {
      return false;
    }
  }
  return true;
}

/** 把 Object[] 转为 string[]（要求已通过 isStringArray 校验） */
export function toStringArray(value: Object[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    out.push(value[i] as string);
  }
  return out;
}

/**
 * 按点分路径取值：`readPath(data, 'message.source.model')`。
 *
 * `$` 表示根对象自身（`readPath(data, '$')` 就是 `data`）。
 * 中间段为**整数**时按数组下标解释（`readPath(d, 'files.0.path')`），
 * 这在上游里是必要的：交付物事件把文件列表放在 `files` 数组里。
 * 任何一段不存在、或类型不符（对象段遇到标量、数组段遇到非数组、下标越界），
 * 都返回 `undefined`——**不抛异常、不做类型转换、不返回 placeholder**。
 *
 * 返回 placeholder 是一个刻意避开的陷阱：若「键不存在」也返回对象，
 * 调用方就再也分不清「字段缺失」与「字段为空」，而这两种情况需要不同的处置。
 */
export function readPath(source: Object | null | undefined, path: string): Object | undefined {
  if (path === '$') {
    return source === null ? undefined : source;
  }
  if (path.length === 0) {
    return undefined;
  }
  let cursor: Object | undefined = source === null ? undefined : source;
  let start: number = 0;
  while (start <= path.length) {
    const dot: number = path.indexOf('.', start);
    const end: number = dot < 0 ? path.length : dot;
    const segment: string = path.substring(start, end);
    if (segment.length === 0) {
      return undefined;
    }
    cursor = readSegment(cursor, segment);
    if (cursor === undefined || dot < 0) {
      return cursor;
    }
    start = dot + 1;
  }
  return cursor;
}

/** 读一段：整数按数组下标，其余按对象键 */
function readSegment(cursor: Object | undefined, segment: string): Object | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  if (/^\d+$/.test(segment)) {
    if (!Array.isArray(cursor)) {
      return undefined;
    }
    const list: Object[] = cursor as Object[];
    const at: number = Number.parseInt(segment, 10);
    return at < list.length ? list[at] : undefined;
  }
  return getField(cursor, segment);
}

/** JSON 解析：失败返回 undefined，绝不抛异常 */
export function parseJson(text: string): Object | undefined {
  try {
    const parsed: Object = JSON.parse(text) as Object;
    return parsed;
  } catch (error) {
    return undefined;
  }
}

/** JSON 序列化：失败返回 undefined */
export function stringifyJson(value: Object): string | undefined {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return undefined;
  }
}
