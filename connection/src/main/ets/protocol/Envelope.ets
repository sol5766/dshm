/**
 * 一元 RPC 信封的构造与解析。
 *
 * 事实基线（D2 §1.1）：
 *   请求：{ "type":"client-request", "rpcId":"<uuid>", "method":"<endpoint>", "payload":{ "args":{...} } }
 *   成功：{ "type":"server-response", "rpcId":"<同请求>", "result":{ "ok":true, "value":<T> } }
 *   失败：{ "type":"server-response", "rpcId":"<同请求>", "result":{ "ok":false, "error":{ "code","message","details" } } }
 *
 * 解析规则（与上游 parseConnectionResponse 一致，含宽松点与差异说明）：
 *   - type 必须为 "server-response"；
 *   - rpcId 必须为字符串且等于请求（上游为硬校验，本项目同样硬校验）；
 *   - result 必须为对象；
 *   - ok=true 时 `value` 字段**可以不存在**——那是「成功且无返回值」的合法形态
 *     （上游 4 个 `void` 端点即如此，其中包括审批答复通道 `$events/result`）。
 *     旧实现要求 `value` 必须存在，会把这类成功响应误判为解析失败（D2 §1.1 修正）；
 *   - ok=false 时 error.code 与 error.message 必须为字符串；details 在缺省或非对象时
 *     收窄为 ''（上游要求 isRecord(details)，此处按「不因 details 形状毁掉整个响应」处理，
 *     差异已记录在 D2 §7）。
 */

import { getField, getRecord, getString, isRecord, parseJson, stringifyJson } from './JsonValue';
import { RemoteFailure, rpcFail, rpcOk, rpcOkVoid, RpcResult } from './RpcTypes';

/** 请求信封的线格式（只用于序列化） */
interface ClientRequestMessage {
  type: string;
  rpcId: string;
  method: string;
  payload: Object;
}

/** 构造一元请求体。args 为具名参数对象（对应 descriptor 的 args）。 */
export function buildClientRequest(rpcId: string, endpoint: string, args: Object): string | undefined {
  const payload: Record<string, Object> = { 'args': args };
  const message: ClientRequestMessage = {
    type: 'client-request',
    rpcId: rpcId,
    method: endpoint,
    payload: payload
  };
  return stringifyJson(message as Object);
}

/** 解析一元响应体文本。返回 RpcResult（绝不为载体问题 reject）。 */
export function parseConnectionResponse(text: string, expectedRpcId: string, endpoint: string): RpcResult {
  const parsed: Object | undefined = parseJson(text);
  if (parsed === undefined) {
    return rpcFail(RemoteFailure.parse(`invalid JSON body for ${endpoint}`));
  }
  const type: string | undefined = getString(parsed, 'type');
  if (type !== 'server-response') {
    return rpcFail(RemoteFailure.parse(`invalid server-response envelope for ${endpoint}`, `type=${type ?? 'undefined'}`));
  }
  const rpcId: string | undefined = getString(parsed, 'rpcId');
  if (rpcId === undefined) {
    return rpcFail(RemoteFailure.parse(`missing rpcId in response for ${endpoint}`));
  }
  if (rpcId !== expectedRpcId) {
    return rpcFail(RemoteFailure.parse(`rpcId mismatch for ${endpoint}`, `sent=${expectedRpcId} got=${rpcId}`));
  }
  const result: Object | undefined = getRecord(parsed, 'result');
  if (result === undefined) {
    return rpcFail(RemoteFailure.parse(`invalid server-response result for ${endpoint}`));
  }
  const okValue: Object | undefined = getField(result, 'ok');
  if (okValue === true as Object) {
    // 先用键存在性判断，再取值：要区分「没有 value 键」（合法的 void 成功）
    // 与「有 value 键但值为 null」（合法的 JSON 值）。用 getField 的返回值判断
    // 无法区分这两者，会把 void 成功误判成畸形响应。
    const resultRecord: Record<string, Object> = result as Record<string, Object>;
    const hasValue: boolean = Object.keys(resultRecord).indexOf('value') >= 0;
    if (!hasValue) {
      return rpcOkVoid();
    }
    const value: Object | undefined = getField(result, 'value');
    return rpcOk(value === undefined ? ('' as Object) : value);
  }
  if (okValue !== false as Object) {
    return rpcFail(RemoteFailure.parse(`ok field is neither true nor false for ${endpoint}`));
  }
  const error: Object | undefined = getRecord(result, 'error');
  if (error === undefined) {
    return rpcFail(RemoteFailure.parse(`ok:false response for ${endpoint} carries no error object`));
  }
  const code: string | undefined = getString(error, 'code');
  const message: string | undefined = getString(error, 'message');
  if (code === undefined || message === undefined) {
    return rpcFail(RemoteFailure.parse(`malformed error for ${endpoint}`));
  }
  const detailsRecord: Object | undefined = getRecord(error, 'details');
  const details: string = detailsRecord === undefined ? '' : (stringifyJson(detailsRecord) ?? '');
  return rpcFail(new RemoteFailure(code, message, details));
}

/** 仅用于诊断：从响应体里尽力取出 result.ok，不做校验 */
export function peekResponseOk(text: string): boolean | undefined {
  const parsed: Object | undefined = parseJson(text);
  if (!isRecord(parsed)) {
    return undefined;
  }
  const result: Object | undefined = getRecord(parsed, 'result');
  if (result === undefined) {
    return undefined;
  }
  const ok: Object | undefined = getField(result, 'ok');
  return typeof ok === 'boolean' ? ok as boolean : undefined;
}
