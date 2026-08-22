import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';

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
 * GET `url + '/'` once and report whether the body carries the dsh fingerprint.
 * @param url - normalized server base URL, e.g. http://127.0.0.1:3080.
 * @returns true when the server is a reachable dsh web instance.
 */
export async function probeDshServer(url: string): Promise<boolean> {
  const request = http.createHttp();
  try {
    const response = await request.request(`${url}/`, {
      method: http.RequestMethod.GET,
      connectTimeout: PROBE_TIMEOUT_MS,
      readTimeout: PROBE_TIMEOUT_MS,
      header: { 'Accept': 'text/html' }
    });
    if (response.responseCode !== 200 || typeof response.result !== 'string') {
      return false;
    }
    return response.result.includes(DSH_FINGERPRINT);
  } catch (error) {
    const err = error as BusinessError;
    console.warn(`dsh-client: probe ${url} failed: ${err?.code} ${err?.message}`);
    return false;
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
