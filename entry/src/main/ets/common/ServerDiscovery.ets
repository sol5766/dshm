import { http, socket } from '@kit.NetworkKit';

/**
 * Fingerprint injected by the dsh host into the served index.html
 * (packages/client/modules/src/index.ts of deepseek-harness). A 200 response
 * whose body carries this marker is treated as a live dsh web server; anything
 * else occupying the port is not.
 */
const DSH_FINGERPRINT: string = '__DSH_BOOT__';

/** Default loopback address of `dsh web`. */
export const DEFAULT_SERVER_URL: string = 'http://127.0.0.1:3080';

/** Port 8080, a common deployment port for `dsh web`. */
export const PORT_8080_SERVER_URL: string = 'http://127.0.0.1:8080';

/**
 * Ordered probe candidates: the user's configured address first, then the two
 * known loopback ports (8080, dsh default 3080), de-duplicated.
 * @param configured - normalized configured URL.
 * @returns candidate base URLs, first live one wins.
 */
export function defaultCandidates(configured: string): string[] {
  const ordered: string[] = configured === DEFAULT_SERVER_URL
    ? [PORT_8080_SERVER_URL, DEFAULT_SERVER_URL]
    : [configured, PORT_8080_SERVER_URL, DEFAULT_SERVER_URL];
  return ordered.filter((url, index) => ordered.indexOf(url) === index);
}

const PROBE_TIMEOUT_MS: number = 3000;

/** Strip a trailing slash so the value can be used as a URL prefix. */
export function normalizeServerUrl(url: string): string {
  let trimmed = url.trim();
  if (trimmed.length === 0) {
    return DEFAULT_SERVER_URL;
  }
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    trimmed = `http://${trimmed}`;
  }
  while (trimmed.endsWith('/')) {
    trimmed = trimmed.substring(0, trimmed.length - 1);
  }
  return trimmed;
}

/**
 * TCP 端口探测：先确认端口开放（纯 socket，异步、不占主线程、硬超时）。
 * 冷启动早期 http 栈可能把主线程挂死（定时器都不触发），socket 不受影响。
 * @returns true 表示端口可连接。
 */
async function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const tcp = socket.constructTCPSocketInstance();
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) {
        return;
      }
      done = true;
      try {
        tcp.off('connect');
        tcp.off('error');
        tcp.off('close');
        tcp.close();
      } catch (e) {
        // ignore
      }
      resolve(ok);
    };
    try {
      tcp.on('connect', () => finish(true));
      tcp.on('error', () => finish(false));
      tcp.on('close', () => finish(false));
      const options: socket.TCPConnectOptions = {
        address: { address: host, port: port },
        timeout: timeoutMs
      };
      tcp.connect(options).catch(() => finish(false));
    } catch (e) {
      finish(false);
    }
  });
}

/**
 * 探测目标是否为可用的 dsh web：
 * 1. TCP 探测端口开放（异步、不阻塞主线程，冷启动网络栈未就绪也不会死等）；
 * 2. 开放后做 http 指纹校验；http 异常/超时则信任 TCP（回环端口被非 dsh 占用概率极低）。
 * @param url - normalized server base URL, e.g. http://127.0.0.1:3080.
 */
export async function probeDshServer(url: string): Promise<boolean> {
  let host = '127.0.0.1';
  let port = 3080;
  // 手写解析 host/port（不依赖 URL 全局类在 ArkTS 的可用性）
  const m: RegExpMatchArray | null = url.match(/^https?:\/\/([^:\/]+)(?::(\d+))?/);
  if (m !== null) {
    host = m[1];
    port = m[2] !== undefined ? parseInt(m[2], 10) : 3080;
  }
  const tcpOpen: boolean = await tcpProbe(host, port, PROBE_TIMEOUT_MS);
  if (!tcpOpen) {
    return false;
  }
  const request = http.createHttp();
  try {
    const probe: Promise<boolean> = request.request(`${url}/`, {
      method: http.RequestMethod.GET,
      connectTimeout: PROBE_TIMEOUT_MS,
      readTimeout: PROBE_TIMEOUT_MS,
      header: { 'Accept': 'text/html' }
    }).then((response) => {
      if (response.responseCode !== 200 || typeof response.result !== 'string') {
        return false;
      }
      return response.result.includes(DSH_FINGERPRINT);
    });
    // http 异常/超时降级：端口已由 TCP 确认开放，回环上基本就是我们的 dsh
    const timeout: Promise<boolean> = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(true), PROBE_TIMEOUT_MS + 2000);
    });
    return await Promise.race([probe, timeout]);
  } catch (error) {
    return true;
  } finally {
    request.destroy();
  }
}

/**
 * Try each candidate in order and return the first live dsh server URL.
 * @param candidates - normalized base URLs, first match wins.
 * @returns the reachable URL, or undefined when every candidate failed.
 */
export async function discoverServer(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await probeDshServer(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
