/**
 * Cookie 处理。
 *
 * 事实基线（D2 §2.1）：
 *   - 认证流程：`GET /?token=<token>` → 303 + `Set-Cookie`（host-only、Path=/、HttpOnly、SameSite=Strict）
 *   - 此后 `/api` 的全部 HTTP 方法与全部 WebSocket 流都必须携带该 cookie
 *   - cookie 同时绑定「规范化 hostname + port」，因此保存时必须连同 authority 一起存
 *   - ArkTS `HttpResponse.cookies` 是「原始 cookie 字符串」，格式由服务器决定，
 *     因此解析器必须容忍多种分隔形态（本模块的核心价值）
 */

import { CookieRecord } from './Types';

/** 需要从 Set-Cookie 中剔除的属性名（大小写不敏感） */
const COOKIE_ATTRIBUTES: string[] = [
  'path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly', 'priority', 'partitioned'
];

function isCookieAttribute(token: string): boolean {
  const eq: number = token.indexOf('=');
  const name: string = (eq < 0 ? token : token.substring(0, eq)).trim().toLowerCase();
  return COOKIE_ATTRIBUTES.indexOf(name) >= 0;
}

/** 把 name=value 片段解析为 CookieRecord；非法返回 undefined */
function parseCookiePair(raw: string, authority: string): CookieRecord | undefined {
  const token: string = raw.trim();
  if (token.length === 0) {
    return undefined;
  }
  const eq: number = token.indexOf('=');
  if (eq <= 0) {
    return undefined;
  }
  const name: string = token.substring(0, eq).trim();
  const value: string = token.substring(eq + 1).trim();
  if (name.length === 0 || isCookieAttribute(token)) {
    return undefined;
  }
  return { name: name, value: value, authority: authority };
}

/**
 * 解析服务器返回的原始 cookie 字符串。
 *
 * 容忍形态：
 *   - 换行分隔的多条 Set-Cookie
 *   - `;;` 分隔（部分实现用双分号连接多条）
 *   - `; ` 分隔且每段都形如 `name=value`（此时视为多条）
 *   - 单条 `name=value` + 若干属性段（`Path=/; HttpOnly`）
 */
export function parseCookieString(raw: string, authority: string): CookieRecord[] {
  const out: CookieRecord[] = [];
  if (raw === undefined || raw === null || raw.length === 0) {
    return out;
  }

  // 先按换行与双分号切分「可能的多条」
  const coarse: string[] = raw.split(/\r?\n|;;/);
  for (let i = 0; i < coarse.length; i++) {
    const chunk: string = coarse[i].trim();
    if (chunk.length === 0) {
      continue;
    }
    // 再按单分号切分：既可能是「多条 cookie」，也可能是「一条 cookie + 属性」
    const parts: string[] = chunk.split(';');
    let cookieLike: number = 0;
    for (let j = 0; j < parts.length; j++) {
      const part: string = parts[j].trim();
      if (part.length === 0 || isCookieAttribute(part)) {
        continue;
      }
      if (part.indexOf('=') > 0) {
        cookieLike++;
      }
    }
    if (cookieLike <= 1) {
      // 一条 cookie + 属性：只取第一个非属性片段
      for (let j = 0; j < parts.length; j++) {
        const part: string = parts[j].trim();
        if (part.length === 0 || isCookieAttribute(part)) {
          continue;
        }
        const record: CookieRecord | undefined = parseCookiePair(part, authority);
        if (record !== undefined) {
          out.push(record);
        }
        break;
      }
    } else {
      // 多条 cookie：逐个解析非属性片段
      for (let j = 0; j < parts.length; j++) {
        const part: string = parts[j].trim();
        if (part.length === 0 || isCookieAttribute(part)) {
          continue;
        }
        const record: CookieRecord | undefined = parseCookiePair(part, authority);
        if (record !== undefined) {
          out.push(record);
        }
      }
    }
  }
  return out;
}

/**
 * 解析 HTTP 响应头中的 `set-cookie`。
 * header 为 ArkTS 的 `HttpResponse.header: Object`，键名大小写不敏感（兼容 string / string[] 值）。
 */
export function parseSetCookieHeader(header: Object | undefined, authority: string): CookieRecord[] {
  const out: CookieRecord[] = [];
  if (header === undefined || header === null || typeof header !== 'object') {
    return out;
  }
  const holder: Record<string, Object> = header as Record<string, Object>;
  const keys: string[] = Object.keys(holder);
  for (let i = 0; i < keys.length; i++) {
    const key: string = keys[i];
    if (key.toLowerCase() !== 'set-cookie') {
      continue;
    }
    const value: Object = holder[key];
    if (typeof value === 'string') {
      out.push(...parseCookieString(value as string, authority));
    } else if (Array.isArray(value)) {
      const list: Object[] = value as Object[];
      for (let j = 0; j < list.length; j++) {
        const item: Object = list[j];
        if (typeof item === 'string') {
          out.push(...parseCookieString(item as string, authority));
        }
      }
    }
  }
  return out;
}

/** Cookie 容器：按 authority 隔离（cookie 绑定 authority，跨 Host 绝不混用） */
export class CookieJar {
  private records: CookieRecord[] = [];

  /** 全量替换（用于从持久化恢复） */
  replaceAll(records: CookieRecord[]): void {
    this.records = [];
    for (let i = 0; i < records.length; i++) {
      this.records.push(records[i]);
    }
  }

  /** 合并新解析出的 cookie（同名 + 同 authority 覆盖） */
  merge(records: CookieRecord[]): void {
    for (let i = 0; i < records.length; i++) {
      const incoming: CookieRecord = records[i];
      let replaced: boolean = false;
      for (let j = 0; j < this.records.length; j++) {
        const existing: CookieRecord = this.records[j];
        if (existing.name === incoming.name && existing.authority === incoming.authority) {
          this.records[j] = incoming;
          replaced = true;
          break;
        }
      }
      if (!replaced) {
        this.records.push(incoming);
      }
    }
  }

  /** 指定 authority 下是否已有 cookie */
  hasFor(authority: string): boolean {
    for (let i = 0; i < this.records.length; i++) {
      if (this.records[i].authority === authority) {
        return true;
      }
    }
    return false;
  }

  /** 构造 `Cookie` 请求头；无可用 cookie 时返回 undefined */
  headerFor(authority: string): string | undefined {
    const parts: string[] = [];
    for (let i = 0; i < this.records.length; i++) {
      const record: CookieRecord = this.records[i];
      if (record.authority === authority) {
        parts.push(`${record.name}=${record.value}`);
      }
    }
    return parts.length === 0 ? undefined : parts.join('; ');
  }

  /** 清除指定 authority 的 cookie（认证失效重绑时使用） */
  clearFor(authority: string): void {
    const kept: CookieRecord[] = [];
    for (let i = 0; i < this.records.length; i++) {
      if (this.records[i].authority !== authority) {
        kept.push(this.records[i]);
      }
    }
    this.records = kept;
  }

  /** 全部清空 */
  clearAll(): void {
    this.records = [];
  }

  /** 快照（用于持久化；value 为敏感值，调用方负责加密存储） */
  snapshot(): CookieRecord[] {
    const out: CookieRecord[] = [];
    for (let i = 0; i < this.records.length; i++) {
      out.push(this.records[i]);
    }
    return out;
  }

  /** 诊断用：cookie 名清单（不含 value） */
  namesFor(authority: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.records.length; i++) {
      const record: CookieRecord = this.records[i];
      if (record.authority === authority) {
        out.push(record.name);
      }
    }
    return out;
  }
}
