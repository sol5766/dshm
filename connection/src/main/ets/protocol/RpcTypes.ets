/**
 * RPC 目标校验与信封类型定义。
 *
 * 事实基线（D2 §1.1）：
 *   - endpoint 段字符集 `^[A-Za-z0-9_$.-]+$`，以 `/` 连接，禁止空段与 `.` / `..`
 *   - channel 必须匹配 `^/[A-Za-z0-9._~-]+$`，且 `/api` 由 Gateway 认领
 *   - 一元请求体：{ type:"client-request", rpcId, method, payload }
 *   - 一元响应体：{ type:"server-response", rpcId, result }
 *   - result.ok=true  → { ok:true, value }
 *   - result.ok=false → { ok:false, error:{ code, message, details } }
 */

/** 一元 RPC 的 channel（Gateway 认领的唯一 channel） */
export const API_CHANNEL: string = '/api';

/** 事件流逻辑端点（D2 §1.3） */
export const EVENTS_ENDPOINT: string = '$events';

/** 事件 waterfall 结果回送端点（D2 §1.3） */
export const EVENTS_RESULT_ENDPOINT: string = '$events/result';

/** 逻辑流复用 WebSocket 路径（D2 §1.2） */
export const REMOTE_MUX_PATH: string = '/api/remote.mux';

/** 逻辑流开流 payload（D2 §1.3：{ args: {} }） */
export const EMPTY_ARGS_PAYLOAD: string = '{"args":{}}';

const CHANNEL_PATTERN: RegExp = /^\/[A-Za-z0-9._~-]+$/;
const ENDPOINT_SEGMENT_PATTERN: RegExp = /^[A-Za-z0-9_$.-]+$/;

/** 校验结果 */
export interface TargetCheck {
  ok: boolean;
  reason?: string;
}

/**
 * 校验 channel + endpoint 组合是否合法。
 *
 * 【语义修正（有实测驱动）】
 *   原实现把 `/api` 当成「被 Gateway 保留、调用方不得使用」的 channel 而拒绝它。
 *   含义搞反了：`/api` 正是 **Gateway 自己服务的** channel，也是本客户端**唯一**使用的
 *   channel（`dshcompat.SURFACE.apiChannel`）。而 `Connection.call()` 恰恰是用
 *   `surface.apiChannel` 来调本函数的——于是**每一次一元 RPC 都被这道守卫拦下**，
 *   返回 `carrier/parse`。
 *
 *   为什么长期没被发现：认证走 `AuthSession` 直连 `HttpClient`，流走 `RemoteMux`，
 *   两者都不经过本函数。因此「能认证、能开流」造成了「连接正常」的错觉，
 *   而所有一元调用（会话列表、发送提示词、取消轮次、**审批答复**）都是死的。
 *   单元测试里那条 `checkTarget(API_CHANNEL, 'session/list').ok === true` 一直在指着它，
 *   但旁边一条自相矛盾的 `it('rejects the reserved /api channel')`（`API_CHANNEL` 就是 `/api`）
 *   把错误行为写成了预期，两条测试同时存在时必然有一条失败——直到把测试真正跑起来才暴露。
 *
 *   现在的语义：**校验的是「以 Gateway 的 channel 发起该 endpoint 调用」是否合法**，
 *   因此 `/api` 必须被接受；被拒绝的只有形状非法的 channel 与 endpoint。
 *   上游对调用方错误用 `gateway/*` 前缀，本层对应地改用 `client/endpoint-invalid`，
 *   不再伪装成载体解析失败（否则文案会把人引向「网络问题」这一错误方向）。
 */
export function checkTarget(channel: string, endpoint: string): TargetCheck {
  if (!CHANNEL_PATTERN.test(channel)) {
    return { ok: false, reason: `invalid channel ${JSON.stringify(channel)}` };
  }
  if (endpoint.length === 0) {
    return { ok: false, reason: 'empty endpoint' };
  }
  const segments: string[] = endpoint.split('/');
  for (let i = 0; i < segments.length; i++) {
    const segment: string = segments[i];
    if (segment === '' || segment === '.' || segment === '..') {
      return { ok: false, reason: `invalid endpoint segment in ${JSON.stringify(endpoint)}` };
    }
    if (!ENDPOINT_SEGMENT_PATTERN.test(segment)) {
      return { ok: false, reason: `invalid endpoint segment ${JSON.stringify(segment)}` };
    }
  }
  return { ok: true };
}

/**
 * 调用方错误（装配错误，非业务错误、非载体错误）的失败码。
 *
 * 与上游 `gateway/*` 同一层次：**绝不重试、绝不归因于网络**。
 * 单列一个码是为了让文案层能把「我们自己的 endpoint 拼错了」与
 * 「链路断了」区分开——两者此前都是 `carrier/parse`，会把排查引向错误方向。
 */
export const CLIENT_FAILURE_CODE: string = 'client/endpoint-invalid';

/** 把 namespace + method 拼成 endpoint */
export function endpointOf(namespace: string, method: string): string {
  return `${namespace}/${method}`;
}

/** 业务/传输失败（与上游 RemoteError 对齐：code + message + details） */
export class RemoteFailure {
  code: string;
  message: string;
  details: string;
  /** 触发该失败的 HTTP 状态码（0 表示载体未获得响应）；用于区分 401/403 语义 */
  httpStatus: number = 0;

  constructor(code: string, message: string, details: string, httpStatus: number = 0) {
    this.code = code;
    this.message = message;
    this.details = details;
    this.httpStatus = httpStatus;
  }

  /** 是否由载体（非业务）引起 */
  isCarrierFailure(): boolean {
    return this.code === 'carrier/closed' || this.code === 'carrier/transport'
      || this.code === 'carrier/parse' || this.code === 'carrier/timeout';
  }

  static carrier(message: string, details: string = ''): RemoteFailure {
    return new RemoteFailure('carrier/transport', message, details);
  }

  static closed(message: string): RemoteFailure {
    return new RemoteFailure('carrier/closed', message, '');
  }

  static parse(message: string, details: string = ''): RemoteFailure {
    return new RemoteFailure('carrier/parse', message, details);
  }

  static timeout(message: string): RemoteFailure {
    return new RemoteFailure('carrier/timeout', message, '');
  }

  toString(): string {
    return `${this.code}: ${this.message}`;
  }
}

/** 一元调用结果：ok=true 携带 value，ok=false 携带 error。绝不为载体问题 reject。 */
export interface RpcResult {
  ok: boolean;
  value?: Object;
  error?: RemoteFailure;
}

export function rpcOk(value: Object): RpcResult {
  return { ok: true, value: value };
}

/**
 * 成功但**无返回值**的调用。
 *
 * 存在理由（D2 §1.1 修正）：上游有若干端点的返回类型是 `void`，
 * 其成功响应是 `{ok:true}`——**没有 `value` 键**（`JSON.stringify` 会丢弃 `undefined`）。
 * 这不是畸形响应，而是「成功且无值」的合法形态。
 *
 * 上游源码实证：网关对 `$events/result` 的成功分支直接写
 * `return { ok: true, value: undefined };`（`dsh-api-gateway/lib/types/index.js`）。
 * 而 `$events/result` 正是**审批与提问的答复通道**——若把「无 value」当成解析失败，
 * 用户点了「允许」而客户端认为调用失败，这是最致命的一类误判。
 */
export function rpcOkVoid(): RpcResult {
  return { ok: true };
}

export function rpcFail(error: RemoteFailure): RpcResult {
  return { ok: false, error: error };
}
