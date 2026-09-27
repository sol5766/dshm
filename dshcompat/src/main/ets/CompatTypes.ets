/**
 * 兼容面类型定义。
 *
 * 设计约束（回答「方便适配上游升级」）：
 *   本文件 + 同目录的 Endpoints / Capabilities 是**唯一**允许出现 DSH 上游接口细节的地方。
 *   `connection` 只提供机制（HTTP/WS 载体、信封、cookie、退避），不含任何具体端点知识；
 *   `appstate` 与 UI 只见呈现层契约，不认上游字段名。
 *   上游升级时：改动本模块 → 跑一次协议基线与漂移工具 → 完成。
 */

/** 参数形态（决定 payload 的 `args` 如何构造） */
export enum ArgsShape {
  /** 无参数：`{}` */
  NONE = 'none',
  /** 单个 `request` 字段：`{ request: {...} }` */
  REQUEST = 'request',
  /** 单个 `_request` 字段（注意下划线，session/list 等使用）：`{ _request: {...} }` */
  UNDERSCORE_REQUEST = '_request',
  /** 多个扁平具名参数：`{ agentId, query }` */
  NAMED = 'named'
}

/** 一个 endpoint 的调用契约 */
export interface DshEndpoint {
  /** 上游生成的 descriptor id，形如 `@deepseek-ai/dsh-api-session-controller#session/list` */
  id: string;
  /** 命名空间（endpoint 的前半段） */
  ns: string;
  /** 方法名（endpoint 的后半段） */
  method: string;
  /** 参数形态 */
  shape: ArgsShape;
  /** 扁平参数名列表（仅 ArgsShape.NAMED 使用） */
  params: string[];
  /** 是否为流式端点（必须走 mux 载体，走一元会被 gateway/signature-invalid 拒绝） */
  stream: boolean;
  /** 是否支持取消（AbortSignal） */
  cancellable: boolean;
  /** 上游源码位置（file:line），便于升级时定位 */
  source: string;
  /** 该端点的主归属能力（capabilities 排序后的第一个；空串表示未被任何能力引用） */
  capability: string;
  /** 该端点的全部归属能力（一个端点可被多个能力引用） */
  capabilities: string[];
}

/** 能力（产品功能）到端点的映射：用于启动时探测与入口置灰 */
export interface DshCapability {
  id: string;
  label: string;
  /** 必需端点（缺任一即不可用） */
  requires: string[];
  /** 可选端点（缺失只降级，不影响可用） */
  optional: string[];
  /** 缺失时的用户可见说明与建议 */
  missingHint: string;
}

/** 能力可用性判定结果 */
export interface CapabilityState {
  id: string;
  available: boolean;
  /** 端点的三态：unknown = 尚未探测 */
  present: string[];
  missing: string[];
  unknown: string[];
  hint: string;
}

/** 单个端点的探测状态 */
export enum EndpointProbe {
  UNKNOWN = 'unknown',
  OK = 'ok',
  /** HTTP 404：该 endpoint 在本 Host 上不存在 */
  ABSENT = 'absent',
  /** 参数/签名类错误：端点存在但调用契约与我们的上表不一致 */
  SHAPE_MISMATCH = 'shape-mismatch',
  /** 其他失败（网络、认证、业务拒绝） */
  ERROR = 'error'
}

/** 探测结果表 */
export interface ProbeTable {
  /** endpoint → 状态 */
  entries: Map<string, EndpointProbe>;
  /** 最近一次探测时间 */
  probedAt: number;
}

/** 字段别名（上游可能改名；投影层按候选顺序尝试，实现优雅降级） */
export interface FieldAliases {
  /** 集合容器键（如 items） */
  list: string[];
}

/** 上游身份切片（写入基线，用于漂移比对） */
export interface UpstreamIdentity {
  /** 核心包版本（受支持矩阵的判定依据，D1 §11.4） */
  corePackage: string;
  /** 提取基线时的采集时间 */
  capturedAt: string;
  /** 端点总数（漂移的快速判据） */
  endpointCount: number;
}
