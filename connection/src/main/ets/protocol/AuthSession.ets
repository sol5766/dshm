/**
 * 认证会话（D2 §2.1）。
 *
 * 流程事实：进程启动生成随机 token → `GET /?token=<token>` 校验通过后写入
 * **绑定 authority 的签名 cookie** 并 **303 重定向到干净的 `/`**；此后 `/api`
 * 的全部 HTTP 方法与全部 WebSocket 流都要求该 cookie。
 *
 * 已知约束（D2 §7 A-7）：cookie 默认 30 天有效，但**没有续期端点也没有 logout**；
 * 过期后唯一恢复路径是「重新取一次启动 URL 里的 token」。因此：
 *   - 本模块把「最后一次成功使用过的 token」一并记录（用于自动重绑）；
 *   - 重绑后必须由调用方重放原请求（见 Connection.call 的 allowAuthRetry）。
 */

import { HttpClient, HttpOutcome } from './HttpClient';
import { CookieJar } from './Cookies';
import { HostAddress } from './HostAddress';

/** 认证交换结果 */
export interface AuthOutcome {
  ok: boolean;
  /** HTTP 状态码（0 表示载体失败） */
  status: number;
  /** 失败原因 */
  reason?: string;
  /** 失败时的可执行建议 */
  advice?: string;
}

/** 是否为「认证相关」的失败状态（需要重绑） */
export function isAuthFailureStatus(status: number): boolean {
  return status === 401;
}

/** 是否为「信任栅栏」拒绝（不可通过重绑解决） */
export function isTrustFailureStatus(status: number): boolean {
  return status === 403;
}

export class AuthSession {
  private jar: CookieJar;
  private http: HttpClient;
  private address: HostAddress;
  private token?: string;

  constructor(jar: CookieJar, http: HttpClient, address: HostAddress) {
    this.jar = jar;
    this.http = http;
    this.address = address;
  }

  /** 记录最近一次已知的启动 token（用于 cookie 失效后的自动重绑） */
  setToken(token: string | undefined): void {
    this.token = token;
  }

  /** 是否已有可用于 authority 的 cookie */
  hasCookie(): boolean {
    return this.jar.hasFor(this.address.authority);
  }

  /** 诊断用：cookie 名清单（不含 value） */
  cookieNames(): string[] {
    return this.jar.namesFor(this.address.authority);
  }

  /** 丢弃当前 authority 的 cookie（重绑前调用） */
  clear(): void {
    this.jar.clearFor(this.address.authority);
  }

  /**
   * 用 token 交换签名 cookie。
   *
   * 说明：HTTP 客户端默认跟随重定向，因此 303 之后最终会到达干净的 `/`；
   * 无论最终状态码是 200 还是 303 本身，只要**收获到 cookie** 即视为成功。
   */
  async exchange(token: string): Promise<AuthOutcome> {
    const url: string = `${this.address.baseUrl}/?token=${encodeURIComponent(token)}`;
    const outcome: HttpOutcome =
      await this.http.send(url, this.address.authority, false, undefined, 15000, true);

    if (!outcome.responded) {
      return {
        ok: false,
        status: 0,
        reason: `无法连接到 ${this.address.authority}：${outcome.transportError ?? '未知网络错误'}`,
        advice: '检查地址与端口是否正确、Host 是否在运行、设备与 Host 是否在同一网络。'
      };
    }
    if (this.jar.hasFor(this.address.authority)) {
      this.token = token;
      return { ok: true, status: outcome.status };
    }
    if (outcome.status === 403) {
      return {
        ok: false,
        status: 403,
        reason: 'Host 拒绝了该请求（信任栅栏）',
        advice: '地址与 Host 绑定的 authority 不一致。本项目的跨设备访问应经加密隧道（隧道出口为 loopback），'
          + '不要直接访问 Host 的对外地址。'
      };
    }
    if (outcome.status === 401) {
      return {
        ok: false,
        status: 401,
        reason: 'token 无效或已过期',
        advice: '重新从 Host 启动输出中获取最新的启动 URL（token 每个进程只生成一次）。'
      };
    }
    return {
      ok: false,
      status: outcome.status,
      reason: `token 交换未获得会话 cookie（HTTP ${outcome.status}）`,
      advice: '确认该地址确实是 dsh Host 的根路径，且响应头中包含 Set-Cookie。'
    };
  }

  /** 用记录中的 token 重新交换（cookie 失效时使用）；无 token 时返回明确失败 */
  async rebind(): Promise<AuthOutcome> {
    const token: string | undefined = this.token;
    if (token === undefined || token.length === 0) {
      return {
        ok: false,
        status: 0,
        reason: '会话已失效且未记录可重绑的 token',
        advice: '请重新粘贴 Host 的启动 URL（含 ?token=）以完成授权。'
      };
    }
    this.clear();
    return this.exchange(token);
  }
}
