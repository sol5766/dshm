/**
 * 载体接口面的**具体值**（上游事实的唯一落点）。
 *
 * 这些路径原本硬编码在 connection/RemoteMux、EventStream、Connection 里；
 * 现在集中到这里，connection 通过 ProtocolSurface 注入取得。
 * 上游改路径时只改本文件。
 */

import { ProtocolSurface } from 'connection';

/**
 * 当前受支持的上游接口面。
 *
 * 事实来源（D2 §1.1 / §1.2 / §1.3，均已实测）：
 *   - 一元 RPC：`POST /api/<endpoint>`
 *   - 逻辑流复用：`/api/remote.mux`（精确 upgrade 路由）
 *   - 事件流逻辑端点：`$events`，开流 payload `{ args: {} }`
 *   - waterfall 结果回送：`$events/result`（一元）
 */
export const SURFACE: ProtocolSurface = {
  apiChannel: '/api',
  muxPath: '/api/remote.mux',
  eventsEndpoint: '$events',
  eventsPayloadJson: '{"args":{}}',
  eventsResultEndpoint: '$events/result',
  // 连接级探活用：无副作用、必然应答、参数可重复（`{"args":{}}`）
  probeEndpoint: 'settings/describe',
  idLength: 32
};
