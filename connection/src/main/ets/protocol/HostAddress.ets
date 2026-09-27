/**
 * 目标地址解析：把用户输入的 Host 地址规范化为「authority + 基址 + WebSocket 地址」。
 *
 * 事实基线（D2 §2.2）：
 *   - 签名 cookie 绑定「规范化 hostname + port」，因此 authority 必须唯一且稳定；
 *   - loopback 判定用于诊断展示（localhost / 127.0.0.0/8 / [::1]）。
 *
 * 设计要点：
 *   - 用户可输入 `192.168.1.5:3000`、`http://host:port`、`https://host`、`[::1]:8080`；
 *   - 缺省 scheme 用 http（dsh 默认 loopback HTTP，不设 Secure cookie）；
 *   - WebSocket scheme 由 http→ws、https→wss 推导。
 */

import { getNumber } from './JsonValue';

/** 解析结果 */
export interface HostAddress {
  /** 规范化 authority，如 `127.0.0.1:3000`、`[::1]:8080` */
  authority: string;
  /** 主机名（IPv6 保留方括号，与 WHATWG URL.hostname 一致） */
  hostname: string;
  /** 端口；未显式给出时按 scheme 推导 */
  port: number;
  /** http | https */
  scheme: string;
  /** HTTP 基址，如 `http://127.0.0.1:3000` */
  baseUrl: string;
  /** WebSocket 基址，如 `ws://127.0.0.1:3000` */
  wsBaseUrl: string;
  /** 是否 loopback（用于诊断与 L0/L1 路径判定） */
  isLoopback: boolean;
}

const DEFAULT_HTTP_PORT: number = 80;
const DEFAULT_HTTPS_PORT: number = 443;

function isLoopbackHostname(hostname: string): boolean {
  const lower: string = hostname.toLowerCase();
  if (lower === 'localhost') {
    return true;
  }
  if (lower === '[::1]' || lower === '::1') {
    return true;
  }
  if (lower.startsWith('127.')) {
    return true;
  }
  return false;
}

/**
 * 解析用户输入的地址。失败返回 { ok:false, reason }。
 */
export function parseHostAddress(input: string): HostAddress | undefined {
  const raw: string = input.trim();
  if (raw.length === 0) {
    return undefined;
  }
  let scheme: string = 'http';
  let rest: string = raw;
  const schemeMatch: RegExpMatchArray | null = raw.match(/^(https?):\/\//i);
  if (schemeMatch !== null) {
    scheme = schemeMatch[1].toLowerCase();
    rest = raw.substring(schemeMatch[0].length);
  }
  // 去掉路径/查询（Host 地址只取 authority）
  const slashIndex: number = rest.search(/[/?#]/);
  if (slashIndex >= 0) {
    rest = rest.substring(0, slashIndex);
  }
  // 去掉可能的凭据段
  const atIndex: number = rest.lastIndexOf('@');
  if (atIndex >= 0) {
    rest = rest.substring(atIndex + 1);
  }
  if (rest.length === 0) {
    return undefined;
  }

  let hostname: string = rest;
  let port: number = scheme === 'https' ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT;

  if (rest.startsWith('[')) {
    // IPv6 字面量
    const close: number = rest.indexOf(']');
    if (close < 0) {
      return undefined;
    }
    hostname = rest.substring(0, close + 1);
    const after: string = rest.substring(close + 1);
    if (after.startsWith(':')) {
      const portText: string = after.substring(1);
      const parsedPort: number = Number.parseInt(portText, 10);
      if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
        return undefined;
      }
      port = parsedPort;
    } else if (after.length > 0) {
      return undefined;
    }
  } else {
    const colon: number = rest.lastIndexOf(':');
    if (colon >= 0) {
      const portText: string = rest.substring(colon + 1);
      hostname = rest.substring(0, colon);
      const parsedPort: number = Number.parseInt(portText, 10);
      if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
        return undefined;
      }
      port = parsedPort;
    }
  }

  if (hostname.length === 0) {
    return undefined;
  }
  // 主机名合法性：字母数字、点、连字符、下划线（局域网主机名可能含下划线）+ IPv6 方括号
  if (!/^[A-Za-z0-9._\-\[\]:]+$/.test(hostname)) {
    return undefined;
  }

  const authority: string = `${hostname}:${port}`;
  const baseUrl: string = `${scheme}://${authority}`;
  const wsScheme: string = scheme === 'https' ? 'wss' : 'ws';
  return {
    authority: authority,
    hostname: hostname,
    port: port,
    scheme: scheme,
    baseUrl: baseUrl,
    wsBaseUrl: `${wsScheme}://${authority}`,
    isLoopback: isLoopbackHostname(hostname)
  };
}

/**
 * 从 dsh 启动输出行中提取带 token 的启动 URL。
 * 形态：`dsh web: http://127.0.0.1:3000/?token=xxxx`
 */
export function extractStartupUrl(text: string): string | undefined {
  const match: RegExpMatchArray | null = text.match(/https?:\/\/[^\s"'`]+/);
  return match === null ? undefined : match[0];
}

/** 从 URL 中取出 token 查询参数（仅用于根路径交换，D2 §2.1） */
export function extractToken(url: string): string | undefined {
  const match: RegExpMatchArray | null = url.match(/[?&]token=([^&\s]+)/);
  return match === null ? undefined : match[1];
}

/** 从「地址或带 token 的 URL」中同时取出地址与 token */
export interface ParsedTarget {
  address: HostAddress;
  token?: string;
}

export function parseTarget(input: string): ParsedTarget | undefined {
  const trimmed: string = input.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const token: string | undefined = extractToken(trimmed);
  const address: HostAddress | undefined = parseHostAddress(trimmed);
  if (address === undefined) {
    return undefined;
  }
  return token === undefined ? { address: address } : { address: address, token: token };
}

/** 端口是否与默认端口相同（用于日志与诊断展示） */
export function isDefaultPort(address: HostAddress): boolean {
  if (address.scheme === 'https') {
    return address.port === DEFAULT_HTTPS_PORT;
  }
  return address.port === DEFAULT_HTTP_PORT;
}

/** 保留：从 JSON 对象读取端口的工具（供 Host 描述文件解析复用） */
export function readPort(source: Object | undefined, key: string): number | undefined {
  return getNumber(source, key);
}
