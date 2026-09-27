/**
 * 协议兼容层单元测试。
 *
 * 覆盖对象是**纯逻辑**部分（不依赖网络、不依赖设备能力），因此可在设备/模拟器上稳定运行：
 *   - HostAddress：地址规范化、authority 生成、loopback 判定、token 提取
 *   - RpcTypes：endpoint/channel 目标校验（对齐上游 assertTarget 语义）
 *   - Envelope：一元信封构造与解析（含全部失败分支）
 *   - Cookies：Set-Cookie 多形态解析、按 authority 隔离的合并与清除
 *   - Backoff：D2 §3 的逐档延迟与抖动边界
 *
 * 每条断言的依据都指向 D2 的具体条目，失败即意味着实现与协议基线不一致。
 */

import { describe, expect, it } from '@ohos/hypium';
import {
  API_CHANNEL,
  backoffDelayMs,
  BACKOFF_STEPS_MS,
  checkTarget,
  CLIENT_FAILURE_CODE,
  CookieJar,
  buildClientRequest,
  endpointOf,
  extractStartupUrl,
  extractToken,
  isRetryable,
  parseConnectionResponse,
  parseCookieString,
  parseHostAddress,
  parseTarget,
  RemoteFailure,
  getString,
  getArray,
  isRecord,
  parseJson
} from 'connection';
import { projectSessionList } from 'appstate';

function sampleArgs(): Record<string, Object> {
  const inner: Record<string, Object> = {};
  const args: Record<string, Object> = { 'args': inner as Object };
  return args;
}

export default function connectionTest() {
  describe('HostAddress', () => {
    it('parses host:port with default http scheme', 0, () => {
      const a = parseHostAddress('127.0.0.1:3000');
      expect(a !== undefined).assertTrue();
      expect(a!.hostname).assertEqual('127.0.0.1');
      expect(a!.port).assertEqual(3000);
      expect(a!.scheme).assertEqual('http');
      expect(a!.authority).assertEqual('127.0.0.1:3000');
      expect(a!.baseUrl).assertEqual('http://127.0.0.1:3000');
      expect(a!.wsBaseUrl).assertEqual('ws://127.0.0.1:3000');
      expect(a!.isLoopback).assertTrue();
    });

    it('derives ws/wss from scheme', 0, () => {
      const https = parseHostAddress('https://dsh.example.com');
      expect(https !== undefined).assertTrue();
      expect(https!.port).assertEqual(443);
      expect(https!.wsBaseUrl).assertEqual('wss://dsh.example.com:443');
      expect(https!.isLoopback).assertFalse();

      const plain = parseHostAddress('http://dsh.example.com');
      expect(plain!.port).assertEqual(80);
      expect(plain!.wsBaseUrl).assertEqual('ws://dsh.example.com:80');
    });

    it('strips path, query and credentials from the authority', 0, () => {
      const a = parseHostAddress('http://user:pass@10.0.0.5:8080/api/foo?x=1');
      expect(a !== undefined).assertTrue();
      expect(a!.authority).assertEqual('10.0.0.5:8080');
      expect(a!.baseUrl).assertEqual('http://10.0.0.5:8080');
    });

    it('handles IPv6 literals with brackets retained', 0, () => {
      const withPort = parseHostAddress('[::1]:8080');
      expect(withPort !== undefined).assertTrue();
      expect(withPort!.hostname).assertEqual('[::1]');
      expect(withPort!.port).assertEqual(8080);
      expect(withPort!.authority).assertEqual('[::1]:8080');
      expect(withPort!.isLoopback).assertTrue();

      const noPort = parseHostAddress('http://[fe80::1]');
      expect(noPort !== undefined).assertTrue();
      expect(noPort!.port).assertEqual(80);
      expect(noPort!.isLoopback).assertFalse();
    });

    it('classifies loopback variants', 0, () => {
      expect(parseHostAddress('localhost:1')!.isLoopback).assertTrue();
      expect(parseHostAddress('127.0.0.1:1')!.isLoopback).assertTrue();
      expect(parseHostAddress('127.9.9.9:1')!.isLoopback).assertTrue();
      expect(parseHostAddress('128.0.0.1:1')!.isLoopback).assertFalse();
      expect(parseHostAddress('192.168.1.5:1')!.isLoopback).assertFalse();
    });

    it('rejects malformed input', 0, () => {
      expect(parseHostAddress('')).assertUndefined();
      expect(parseHostAddress('   ')).assertUndefined();
      expect(parseHostAddress('host:0')).assertUndefined();
      expect(parseHostAddress('host:70000')).assertUndefined();
      expect(parseHostAddress('host:abc')).assertUndefined();
      expect(parseHostAddress('http://')).assertUndefined();
      expect(parseHostAddress('[::1')).assertUndefined();
      expect(parseHostAddress('bad host:80')).assertUndefined();
    });

    it('extracts token and startup url', 0, () => {
      const url = 'dsh web: http://127.0.0.1:3111/?token=abc123';
      expect(extractStartupUrl(url)).assertEqual('http://127.0.0.1:3111/?token=abc123');
      expect(extractToken('http://127.0.0.1:3111/?token=abc123')).assertEqual('abc123');
      expect(extractToken('http://127.0.0.1:3111/')).assertUndefined();

      const target = parseTarget('http://127.0.0.1:3111/?token=abc123');
      expect(target !== undefined).assertTrue();
      expect(target!.address.authority).assertEqual('127.0.0.1:3111');
      expect(target!.token).assertEqual('abc123');

      const noToken = parseTarget('192.168.1.5:3000');
      expect(noToken !== undefined).assertTrue();
      expect(noToken!.token).assertUndefined();
    });
  });

  describe('RpcTypes', () => {
    it('accepts a valid namespace/method endpoint', 0, () => {
      expect(checkTarget(API_CHANNEL, 'session/list').ok).assertTrue();
      expect(checkTarget(API_CHANNEL, 'settings/canOpenAgentPresetDirectory').ok).assertTrue();
      expect(checkTarget(API_CHANNEL, '$events').ok).assertTrue();
      expect(checkTarget(API_CHANNEL, 'dynamicCordisRunner/getClientCode').ok).assertTrue();
    });

    /**
     * 【回归测试 · 曾经的真实生产 bug】
     *   原实现把 `/api` 当成「被 Gateway 保留、调用方不得使用」的 channel 而拒绝它。
     *   但 `Connection.call()` 恰恰是用 `surface.apiChannel`（= `/api`）来调 `checkTarget`——
     *   于是**每一次一元 RPC 都被这道守卫拦下**，返回 `carrier/parse`（看起来像网络问题）。
     *   认证走 `AuthSession` 直连 HTTP、流走 `RemoteMux`，都不经过本函数，
     *   所以「能认证、能开流」造成了「连接正常」的错觉，而会话列表 / 发送提示词 /
     *   取消轮次 / **审批答复**全都是死的。
     *
     *   本用例与上一条 `accepts a valid namespace/method endpoint` 一起锁住正确语义；
     *   原先这里是一条自相矛盾的 `it('rejects the reserved /api channel')`——
     *   `API_CHANNEL` 就是 `/api`，两条测试不可能同时通过，等于把 bug 写成了预期行为。
     */
    it('accepts the Gateway channel and rejects malformed channels', 0, () => {
      expect(checkTarget(API_CHANNEL, 'session/list').ok).assertTrue();
      expect(checkTarget('/ap i', 'session/list').ok).assertFalse();
      expect(checkTarget('', 'session/list').ok).assertFalse();
    });

    it('rejects invalid endpoint shapes', 0, () => {
      expect(checkTarget(API_CHANNEL, '').ok).assertFalse();
      expect(checkTarget(API_CHANNEL, 'session/').ok).assertFalse();
      expect(checkTarget(API_CHANNEL, '/list').ok).assertFalse();
      expect(checkTarget(API_CHANNEL, 'session/./x').ok).assertFalse();
      expect(checkTarget(API_CHANNEL, 'session/../x').ok).assertFalse();
      expect(checkTarget(API_CHANNEL, 'session li/st').ok).assertFalse();
      expect(checkTarget(API_CHANNEL, 'session/li%20st').ok).assertFalse();
    });

    it('rejects invalid channels', 0, () => {
      expect(checkTarget('api', 'session/list').ok).assertFalse();
      expect(checkTarget('', 'session/list').ok).assertFalse();
      expect(checkTarget('/ap i', 'session/list').ok).assertFalse();
    });

    it('builds endpoints from namespace and method', 0, () => {
      expect(endpointOf('session', 'list')).assertEqual('session/list');
      expect(endpointOf('directoryPicker', 'createDirectory')).assertEqual('directoryPicker/createDirectory');
    });

    /**
     * 【回归测试 · 诊断可读性】
     *   调用方错误（endpoint 拼错）**绝不能**被归类为载体失败。
     *   此前它用 `carrier/parse`，文案层于是把「我们自己的 endpoint 写错了」
     *   说成「中间转发通道截断了连接」——一个把排查引向错误方向的假结论（真实发生过）。
     */
    it('classifies caller mistakes separately from carrier failures', 0, () => {
      const callerBug = new RemoteFailure(CLIENT_FAILURE_CODE, '非法 endpoint', '');
      expect(callerBug.isCarrierFailure()).assertFalse();
      expect(new RemoteFailure('carrier/parse', 'x', '').isCarrierFailure()).assertTrue();
      expect(new RemoteFailure('carrier/closed', 'x', '').isCarrierFailure()).assertTrue();
    });
  });

  describe('Envelope', () => {
    it('builds the client-request envelope with named args', 0, () => {
      const inner: Record<string, Object> = {};
      const args: Record<string, Object> = { '_request': inner as Object };
      const text = buildClientRequest('rpc-1', 'session/list', args as Object);
      expect(text !== undefined).assertTrue();
      const parsed = parseJson(text!);
      expect(parsed !== undefined).assertTrue();
      expect(getString(parsed, 'type')).assertEqual('client-request');
      expect(getString(parsed, 'rpcId')).assertEqual('rpc-1');
      expect(getString(parsed, 'method')).assertEqual('session/list');
      expect(isRecord(parsed!)).assertTrue();
    });

    it('parses an ok response and preserves the value', 0, () => {
      const body = '{"type":"server-response","rpcId":"r1","result":{"ok":true,"value":{"items":[]}}}';
      const result = parseConnectionResponse(body, 'r1', 'session/list');
      expect(result.ok).assertTrue();
      expect(isRecord(result.value!)).assertTrue();
      expect(getArray(result.value, 'items')!.length).assertEqual(0);
    });

    it('parses a business failure into code/message', 0, () => {
      const body = '{"type":"server-response","rpcId":"r1","result":{"ok":false,'
        + '"error":{"code":"gateway/arguments-invalid","message":"missing _request","details":{}}}}';
      const result = parseConnectionResponse(body, 'r1', 'session/list');
      expect(result.ok).assertFalse();
      expect(result.error!.code).assertEqual('gateway/arguments-invalid');
      expect(result.error!.message).assertEqual('missing _request');
      expect(result.error!.isCarrierFailure()).assertFalse();
    });

    it('tolerates a missing details object without dropping the failure', 0, () => {
      const body = '{"type":"server-response","rpcId":"r1","result":{"ok":false,'
        + '"error":{"code":"llm/model-discovery-rejected","message":"nope"}}}';
      const result = parseConnectionResponse(body, 'r1', 'llm/discoverModels');
      expect(result.ok).assertFalse();
      expect(result.error!.code).assertEqual('llm/model-discovery-rejected');
      expect(result.error!.details).assertEqual('');
    });

    it('rejects rpcId mismatch (carrier-level parse failure)', 0, () => {
      const body = '{"type":"server-response","rpcId":"other","result":{"ok":true,"value":1}}';
      const result = parseConnectionResponse(body, 'r1', 'session/list');
      expect(result.ok).assertFalse();
      expect(result.error!.code).assertEqual('carrier/parse');
      expect(result.error!.isCarrierFailure()).assertTrue();
    });

    it('rejects wrong envelope type', 0, () => {
      const body = '{"type":"client-request","rpcId":"r1","result":{"ok":true,"value":1}}';
      expect(parseConnectionResponse(body, 'r1', 'x/y').ok).assertFalse();
    });

    it('rejects malformed JSON and missing result', 0, () => {
      expect(parseConnectionResponse('not json', 'r1', 'x/y').ok).assertFalse();
      expect(parseConnectionResponse('{"type":"server-response","rpcId":"r1"}', 'r1', 'x/y').ok).assertFalse();
      expect(parseConnectionResponse(
        '{"type":"server-response","rpcId":"r1","result":{}}', 'r1', 'x/y').ok).assertFalse();
    });

    /**
     * 【回归测试 · 曾经的真实缺陷】
     *   旧实现要求 `ok:true` 响应必须带 `value` 字段，于是上游 4 个 `void` 端点的成功响应
     *   （`{ok:true}`，`JSON.stringify` 丢弃 undefined 后**没有 value 键**）被判为畸形响应。
     *   其中包含**审批与提问的答复通道 `$events/result`**——症状是
     *   「用户点了允许、客户端认为调用失败」，属最致命的一类误判。
     *
     *   上游代码实证：网关对 `$events/result` 的成功分支直接写
     *   `return { ok: true, value: undefined };`（`dsh-api-gateway/lib/types/index.js`）。
     *
     *   同时锁住「不能为了兼容 void 而把正常响应里的 value 丢掉」。
     */
    it('accepts a void success without a value field', 0, () => {
      const voidBody = '{"type":"server-response","rpcId":"r1","result":{"ok":true}}';
      const voidResult = parseConnectionResponse(voidBody, 'r1', '$events/result');
      expect(voidResult.ok).assertTrue();
      expect(voidResult.value).assertUndefined();

      const valued = '{"type":"server-response","rpcId":"r1","result":{"ok":true,"value":{"items":[]}}}';
      const valuedResult = parseConnectionResponse(valued, 'r1', 'session/list');
      expect(valuedResult.ok).assertTrue();
      expect(valuedResult.value !== undefined).assertTrue();
    });

    it('accepts an explicit null value', 0, () => {
      const body = '{"type":"server-response","rpcId":"r1","result":{"ok":true,"value":null}}';
      const result = parseConnectionResponse(body, 'r1', 'x/y');
      expect(result.ok).assertTrue();
    });

    it('rejects malformed error objects', 0, () => {
      const noError = '{"type":"server-response","rpcId":"r1","result":{"ok":false}}';
      expect(parseConnectionResponse(noError, 'r1', 'x/y').ok).assertFalse();
      const noCode = '{"type":"server-response","rpcId":"r1","result":{"ok":false,"error":{"message":"m"}}}';
      expect(parseConnectionResponse(noCode, 'r1', 'x/y').ok).assertFalse();
    });
  });

  describe('Cookies', () => {
    it('parses a single Set-Cookie with attributes', 0, () => {
      const records = parseCookieString(
        'dsh-auth-abc=xyz; Path=/; HttpOnly; SameSite=Strict', '127.0.0.1:3111');
      expect(records.length).assertEqual(1);
      expect(records[0].name).assertEqual('dsh-auth-abc');
      expect(records[0].value).assertEqual('xyz');
      expect(records[0].authority).assertEqual('127.0.0.1:3111');
    });

    it('parses newline-separated multiple cookies', 0, () => {
      const records = parseCookieString('a=1; Path=/\nb=2; HttpOnly', 'h:1');
      expect(records.length).assertEqual(2);
      expect(records[0].name).assertEqual('a');
      expect(records[1].name).assertEqual('b');
    });

    it('parses double-semicolon separated multiple cookies', 0, () => {
      const records = parseCookieString('a=1;; b=2', 'h:1');
      expect(records.length).assertEqual(2);
    });

    it('ignores attribute-only tokens', 0, () => {
      const records = parseCookieString('Path=/; HttpOnly; Secure', 'h:1');
      expect(records.length).assertEqual(0);
    });

    it('returns nothing for empty input', 0, () => {
      expect(parseCookieString('', 'h:1').length).assertEqual(0);
    });

    it('isolates cookies per authority', 0, () => {
      const jar = new CookieJar();
      jar.merge(parseCookieString('a=1', 'host-a:1'));
      jar.merge(parseCookieString('b=2', 'host-b:1'));
      expect(jar.headerFor('host-a:1')).assertEqual('a=1');
      expect(jar.headerFor('host-b:1')).assertEqual('b=2');
      expect(jar.headerFor('host-c:1')).assertUndefined();
      expect(jar.hasFor('host-a:1')).assertTrue();
      expect(jar.hasFor('host-c:1')).assertFalse();
      expect(jar.namesFor('host-a:1').length).assertEqual(1);
    });

    it('overwrites same-name cookie within the same authority', 0, () => {
      const jar = new CookieJar();
      jar.merge(parseCookieString('a=1', 'h:1'));
      jar.merge(parseCookieString('a=2', 'h:1'));
      expect(jar.headerFor('h:1')).assertEqual('a=2');
    });

    it('clears only the targeted authority', 0, () => {
      const jar = new CookieJar();
      jar.merge(parseCookieString('a=1', 'host-a:1'));
      jar.merge(parseCookieString('b=2', 'host-b:1'));
      jar.clearFor('host-a:1');
      expect(jar.hasFor('host-a:1')).assertFalse();
      expect(jar.hasFor('host-b:1')).assertTrue();
    });

    it('round-trips through snapshot and replaceAll', 0, () => {
      const jar = new CookieJar();
      jar.merge(parseCookieString('a=1', 'h:1'));
      const snapshot = jar.snapshot();
      const other = new CookieJar();
      other.replaceAll(snapshot);
      expect(other.headerFor('h:1')).assertEqual('a=1');
    });
  });

  describe('Backoff', () => {
    it('follows the documented step table (D2 §3)', 0, () => {
      expect(BACKOFF_STEPS_MS.length).assertEqual(6);
      expect(BACKOFF_STEPS_MS[0]).assertEqual(500);
      expect(BACKOFF_STEPS_MS[1]).assertEqual(1000);
      expect(BACKOFF_STEPS_MS[2]).assertEqual(2000);
      expect(BACKOFF_STEPS_MS[3]).assertEqual(4000);
      expect(BACKOFF_STEPS_MS[4]).assertEqual(8000);
      expect(BACKOFF_STEPS_MS[5]).assertEqual(10000);
    });

    it('applies 50%-100% jitter bounds per step', 0, () => {
      for (let step = 1; step <= BACKOFF_STEPS_MS.length; step++) {
        const base = BACKOFF_STEPS_MS[step - 1];
        expect(backoffDelayMs(step, 0)).assertEqual(Math.round(base * 0.5));
        expect(backoffDelayMs(step, 1)).assertEqual(base);
      }
    });

    it('clamps out-of-range random values', 0, () => {
      expect(backoffDelayMs(1, -5)).assertEqual(250);
      expect(backoffDelayMs(1, 5)).assertEqual(500);
    });

    it('clamps attempts beyond the last step to the 10s ceiling', 0, () => {
      expect(backoffDelayMs(99, 1)).assertEqual(10000);
      expect(backoffDelayMs(0, 1)).assertEqual(500);
    });

    it('reports retryability up to the step count', 0, () => {
      expect(isRetryable(1)).assertTrue();
      expect(isRetryable(6)).assertTrue();
      expect(isRetryable(7)).assertFalse();
    });
  });

  describe('JsonValue', () => {
    it('narrows values safely and never throws', 0, () => {
      const obj = parseJson('{"s":"x","n":1,"b":true,"arr":[1],"o":{"k":"v"}}');
      expect(obj !== undefined).assertTrue();
      expect(getString(obj, 's')).assertEqual('x');
      expect(getString(obj, 'missing')).assertUndefined();
      expect(getString(obj, 'n')).assertUndefined();
      expect(getArray(obj, 'arr')!.length).assertEqual(1);
      expect(getArray(obj, 's')).assertUndefined();
      expect(isRecord(parseJson('[1,2]'))).assertFalse();
      expect(parseJson('{bad')).assertUndefined();
    });

    /**
     * 【回归测试 · 曾经的真实生产缺陷】
     *   `isRecord` **明确排除数组**（`return !Array.isArray(value)`），
     *   而 `getRecord` 内部走 `isRecord`。曾经用 `getRecord(value, 'items')`
     *   去取 `{items:[…]}` 的容器 → 永远 undefined → **真实 Host 上永远解析出 0 条会话**。
     *   桩数据路径不经过该函数，所以本地完全看不出异常；
     *   首次真机端到端验证即命中：宿主有 4 个会话，界面 0 个。
     *
     *   本用例把「取数组容器必须用数组语义」这件事锁死。
     */
    it('cannot read an array container through record semantics', 0, () => {
      const value = parseJson('{"items":[{"a":1}]}');
      expect(getArray(value, 'items')!.length).assertEqual(1);
      // 这两条正是当初踩坑的地方：数组不是 record
      expect(isRecord(value)).assertTrue();
      expect(isRecord(getArray(value, 'items'))).assertFalse();
    });
  });

  describe('SessionListProjection', () => {
    /**
     * 用**真实实测样本**驱动投影（0.1.5-rc.1 Host 实际返回，见 D2 §8.7.2）。
     *
     * 关键事实（三条都曾经被实现写错）：
     *   1. 容器是 `items` 且值为**数组**——必须用数组语义取；
     *   2. **顶层没有 `title` 字段**，标题在 `projections.values.title`，且新建会话为 `null`；
     *   3. `updatedAt` 是毫秒时间戳数字，`running` / `blank` 是布尔。
     */
    const REAL_LIST_JSON = '{"items":['
      + '{"sessionId":"session-07917d40-28da-46f4-9af7-da839bfaccf7","updatedAt":1789051283087,'
      + '"running":false,"blank":true,"cwd":"D:\\\\dev\\\\deepseek-harness-desktop-HarmonyOS",'
      + '"projections":{"asOfSeq":2,"values":{"title":null,"agentPreset":"standard"}}},'
      + '{"sessionId":"session-2","updatedAt":1789051283088,"running":true,"blank":false,'
      + '"cwd":"/home/u/other-project",'
      + '"projections":{"asOfSeq":9,"values":{"title":"给 DSHM 写协议兼容层"}}}'
      + ']}';

    it('projects the real wire shape into list items', 0, () => {
      const page = projectSessionList(parseJson(REAL_LIST_JSON));
      expect(page.items.length).assertEqual(2);
      // 投影按最近活动倒序 → session-2（updatedAt 更大）在前
      expect(page.items[0].id).assertEqual('session-2');
      expect(page.items[1].id).assertEqual('session-07917d40-28da-46f4-9af7-da839bfaccf7');
      // 字段类型必须与实测一致：毫秒数字、布尔
      expect(page.items[1].running).assertFalse();
      expect(page.items[1].blank).assertTrue();
      expect(page.items[1].updatedAt).assertEqual(1789051283087);
      expect(page.items[0].running).assertTrue();
      expect(page.items[0].blank).assertFalse();
    });

    it('reads the title from the projection, not from a top-level field', 0, () => {
      const page = projectSessionList(parseJson(REAL_LIST_JSON));
      let titled = '';
      for (let i = 0; i < page.items.length; i++) {
        if (page.items[i].id === 'session-2') {
          titled = page.items[i].title;
        }
      }
      expect(titled).assertEqual('给 DSHM 写协议兼容层');
    });

    /**
     * 标题为 `null` 的会话必须仍有可辨识的显示名。
     * Host 上刚建好、还没说话的会话就是这个形态（实测确认），
     * 不兜底会让列表出现空白条目——用户既点不动也认不出。
     */
    it('falls back to the cwd basename when the projection title is null', 0, () => {
      const page = projectSessionList(parseJson(REAL_LIST_JSON));
      let fallback = '';
      for (let i = 0; i < page.items.length; i++) {
        if (page.items[i].id === 'session-07917d40-28da-46f4-9af7-da839bfaccf7') {
          fallback = page.items[i].title;
        }
      }
      // Windows 路径用反斜杠：末段必须被正确取出（不能整串返回，也不能取成空串）
      expect(fallback).assertEqual('deepseek-harness-desktop-HarmonyOS');
      expect(fallback.length > 0).assertTrue();
    });

    it('treats a bare array reply as a list too', 0, () => {
      const page = projectSessionList(parseJson('[{"sessionId":"a","updatedAt":1,"cwd":"/x"}]'));
      expect(page.items.length).assertEqual(1);
      expect(page.items[0].id).assertEqual('a');
    });
  });
}
