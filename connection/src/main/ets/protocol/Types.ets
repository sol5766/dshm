/**
 * 连接层共享类型。
 *
 * 分层约定（D1 §6.1）：
 *   协议兼容层（本模块）零 UI 依赖；所有跨层数据结构在此声明，
 *   上层（状态层 / UI）只消费这些类型，不得反向依赖。
 */

/** Cookie 记录（绑定 authority，D2 §2.1） */
export interface CookieRecord {
  name: string;
  value: string;
  authority: string;
}

/** 连接状态（对齐上游 ctx.connection.state 语义，D2 §3） */
export enum ConnectionState {
  /** 未配置任何 Host */
  IDLE = 'idle',
  /** 正在连接（含退避重试中） */
  CONNECTING = 'connecting',
  /** 已连接且事件流 generation 有效 */
  CONNECTED = 'connected',
  /** 重试耗尽或凭证失效，需人工干预 */
  DISCONNECTED = 'disconnected'
}

/** Host 接入配置 */
export interface HostConfig {
  /** 用户可读名称 */
  name: string;
  /** 规范化 authority（如 127.0.0.1:3000） */
  authority: string;
  /** 主机名 */
  hostname: string;
  /** 端口 */
  port: number;
  /** http | https */
  scheme: string;
  /** HTTP 基址 */
  baseUrl: string;
  /** WebSocket 基址 */
  wsBaseUrl: string;
  /** 是否 loopback（诊断与 L0/L1 判定） */
  isLoopback: boolean;
  /** 设备密钥引用（L1 隧道；L0 为 undefined） */
  deviceKeyRef?: string;
}

/** 从 ready 首项解析出的 Host 事实（D2 §1.3） */
export interface HostFacts {
  /** clientId（Host 侧分配的客户端标识） */
  clientId: string;
  /** Host home 目录（首个 ready 帧之后才有值） */
  home: string;
}

/** 连接诊断的单项结论 */
export interface DiagnosticItem {
  /** 判定项名称 */
  name: string;
  /** 是否通过 */
  passed: boolean;
  /** 结论摘要 */
  detail: string;
  /** 可执行建议（失败时给出） */
  advice?: string;
}

/** 连接诊断报告（对应 D1 G7 的五项判定） */
export interface DiagnosticReport {
  items: DiagnosticItem[];
  /** 总体是否可用 */
  healthy: boolean;
  /** 生成时间（毫秒时间戳） */
  generatedAt: number;
}

/** 重试进度（用于 UI 展示「第 N 次 / 下一次 Xms 后」） */
export interface RetryProgress {
  /** 当前处于第几档（1 起） */
  attempt: number;
  /** 本档延迟（毫秒） */
  delayMs: number;
  /** 抖动后的实际等待（毫秒） */
  waitMs: number;
}

/** 事件流订阅回调 */
export interface EventSink {
  /** ready 首项到达 */
  onReady?: (facts: HostFacts) => void;
  /** 一条增量事件（原始 JSON 值，由上层投影解释） */
  onEvent: (event: Object) => void;
  /** 流终止 */
  onEnd: (error?: string) => void;
}

/** 逻辑流 item 回调（RemoteMux 使用） */
export interface StreamSink {
  onItem: (value: Object) => void;
  onError: (code: string, message: string) => void;
  onEnd: () => void;
}

/** 请求可选项 */
export interface CallOptions {
  /** 超时毫秒数；缺省使用 ConnectionOptions.defaultTimeoutMs */
  timeoutMs?: number;
  /** 401 时是否允许自动重绑认证并重放（最多一次） */
  allowAuthRetry?: boolean;
}
