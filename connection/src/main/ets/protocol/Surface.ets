/**
 * 载体「接口面」：由兼容面（dshcompat）注入的上游事实。
 *
 * 为什么这样切（回答「方便适配上游升级」）：
 *   `connection` 只提供**机制**——HTTP/WS 载体、信封编解码、cookie、退避、诊断。
 *   它**不含**任何具体端点或路径知识：路径、事件流端点、随机 id 长度等
 *   全部由本接口注入。上游改路径/改端点时，改动落在 dshcompat 一处，
 *   connection 与 UI/状态层零改动。
 */

/** 兼容面必须提供的最小事实集 */
export interface ProtocolSurface {
  /** 一元 RPC channel（如 `/api`） */
  apiChannel: string;
  /** 逻辑流复用 WebSocket 路径（如 `/api/remote.mux`） */
  muxPath: string;
  /** 事件流逻辑端点（如 `$events`） */
  eventsEndpoint: string;
  /** 事件流开流 payload 文本（如 `{"args":{}}`） */
  eventsPayloadJson: string;
  /** 事件 waterfall 结果回送端点（如 `$events/result`） */
  eventsResultEndpoint: string;
  /**
   * **连接级探活**用的逻辑端点。
   *
   * 三条硬要求（都踩过坑，别改动）：
   *   1. **无副作用**——它会被周期性调用；
   *   2. **必然应答**——不应答就无法区分「链路死了」与「这个端点本来就不回」；
   *   3. **实参必须是该端点本来就接受的形态**。`settings/describe` 不接受任何实参，
   *      因此探活帧用**空 args**。曾为了让探针在日志里可辨认而塞一个 `cursor`，
   *      结果服务端回 `gateway/arguments-invalid`，而那一帧是 `type:"error"`、
   *      被当作**该流的终结** → **探活反而把健康的连接判死**。
   *      症状与「socket 静默失效」几乎一样，排查方向会完全跑偏。
   *
   * 由兼容面注入而不是在 connection 里写死：它是**上游端点名**，
   * 属于 `dshcompat` 的事实；connection 只管「怎么发一帧并等回帧」这个机制。
   */
  probeEndpoint: string;
  /** 生成 rpcId / streamId 用的随机串长度 */
  idLength: number;
}

/**
 * 兜底默认值（仅用于测试与「未注入」时的安全退化）。
 *
 * 生产路径**必须**显式注入 dshcompat 提供的 surface；
 * 若某次运行真的走到这里，说明装配漏了一处，诊断页会显示出来。
 */
export const FALLBACK_SURFACE: ProtocolSurface = {
  apiChannel: '/api',
  muxPath: '/api/remote.mux',
  eventsEndpoint: '$events',
  eventsPayloadJson: '{"args":{}}',
  eventsResultEndpoint: '$events/result',
  /**
   * **空串 = 不可探活**。
   *
   * 这里刻意**不**填一个真实端点名。理由有两条，都很实在：
   *   1. 兜底值只有测试与「装配漏注入」两种路径会走到。填一个真实端点名会让
   *      漏注入的构建**看起来也能探活**，把装配缺陷掩盖成「跑得好好的」；
   *   2. 端点名是上游事实，只允许出现在 `dshcompat`（架构门禁会拦）。
   *      为绕开门禁而把名字拆开拼接是更坏的做法——那会训练出「门禁可以绕」的习惯。
   *
   * 探活逻辑对空串的处置是**跳过探活并记一条 trace**（见 `RemoteMux.startLivenessProbe`）：
   * 明确地「没做」比含糊地「做了但用了假端点」安全。
   */
  probeEndpoint: '',
  idLength: 32
};
