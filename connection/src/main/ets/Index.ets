/**
 * HAR 模块：dsh 协议兼容层（机制层）。
 *
 * 分层纪律（回答「方便适配上游升级」）：
 *   本模块只提供**机制**——HTTP/WS 载体、信封编解码、cookie、退避、诊断。
 *   **具体端点与路径不在这里**：它们由 `ProtocolSurface` 注入，
 *   上游事实集中在 `dshcompat` 模块（端点上表 + 能力表 + 漂移门禁）。
 *   上层应通过 `dshcompat` 装配，而不是直接用本模块的 FALLBACK_SURFACE。
 */

export { Connection, randomUuid, serializeCookies, deserializeCookies } from './protocol/Connection';
export type { ConnectionOptions, CookiePersistence } from './protocol/Connection';

export { FALLBACK_SURFACE } from './protocol/Surface';
export type { ProtocolSurface } from './protocol/Surface';

export {
  API_CHANNEL,
  CLIENT_FAILURE_CODE,
  EVENTS_ENDPOINT,
  EVENTS_RESULT_ENDPOINT,
  REMOTE_MUX_PATH,
  EMPTY_ARGS_PAYLOAD,
  RemoteFailure,
  rpcFail,
  rpcOk,
  rpcOkVoid,
  checkTarget,
  endpointOf
} from './protocol/RpcTypes';
export type { RpcResult } from './protocol/RpcTypes';

export { parseHostAddress, parseTarget, extractStartupUrl, extractToken } from './protocol/HostAddress';
export type { HostAddress, ParsedTarget } from './protocol/HostAddress';

export {
  CookieJar,
  parseCookieString,
  parseSetCookieHeader
} from './protocol/Cookies';

export { buildClientRequest, parseConnectionResponse, peekResponseOk } from './protocol/Envelope';

export { HttpClient } from './protocol/HttpClient';
export type { HttpOutcome } from './protocol/HttpClient';

export { AuthSession, isAuthFailureStatus, isTrustFailureStatus } from './protocol/AuthSession';
export type { AuthOutcome } from './protocol/AuthSession';

export { RemoteMux, MuxState } from './protocol/RemoteMux';

export { EventStream, EventStreamPhase } from './protocol/EventStream';

export { BACKOFF_STEPS_MS, backoffDelayMs, isRetryable, ReconnectController } from './protocol/Backoff';

export {
  getArray,
  getBoolean,
  getField,
  getNumber,
  getRecord,
  getString,
  isRecord,
  isStringArray,
  parseJson,
  readPath,
  stringifyJson,
  toStringArray
} from './protocol/JsonValue';

export { ConnectionState } from './protocol/Types';
export type {
  CallOptions,
  CookieRecord,
  DiagnosticItem,
  DiagnosticReport,
  EventSink,
  HostConfig,
  HostFacts,
  RetryProgress,
  StreamSink
} from './protocol/Types';
