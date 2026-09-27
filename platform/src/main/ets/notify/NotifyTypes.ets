/**
 * 通知的**机制层类型**（不含产品策略）。
 *
 * 分层纪律：
 *   「哪类事件该发什么标题/正文/优先级」是产品策略，属于呈现层契约，放在 `appstate`；
 *   本文件只定义「一条通知怎么描述」这种与系统 API 对齐的中性结构。
 *   `platform` 不认识 PendingItem，也不认识上游。
 */

/** 通知紧急度（映射到系统渠道等级；策略由 appstate 决定） */
export enum NotifyPriority {
  /** 高：响铃/震动，可绕过静默时段（需用户在系统设置允许） */
  HIGH = 'high',
  /** 普通：随系统提示方式 */
  NORMAL = 'normal',
  /** 低：静默，不打扰 */
  LOW = 'low'
}

/** 通知渠道分组（D3 §6 的分级基础） */
export enum NotifySlot {
  /** 审批 / 提问：需要用户立即决策 */
  DECISION = 'decision',
  /** 轮次与任务完成 */
  OUTCOME = 'outcome',
  /** 连接与系统状态 */
  SYSTEM = 'system'
}

/**
 * 点击通知后的跳转目标。
 *
 * 用「路由描述」而不是 Want 参数散落的键值，是为了让 appstate/UI 用**同一套路由语义**
 * 处理「通知点击」与「应用内跳转」两条入口（D3 §6「点击直达」）。
 */
export interface NotifyRoute {
  /** 目标页：pending / session / diagnostics / settings / workspace */
  page: string;
  /** Host 记录 id（多 Host 时用于切回正确连接） */
  hostId?: string;
  /** 会话 id */
  sessionId?: string;
  /** 待决项 id（审批/提问直达） */
  pendingId?: string;
}

/** 一条待发布的通知（中性描述，由调用方组装好文案） */
export interface NotificationDraft {
  /** 去重键：同一业务对象重复产生通知时用它覆盖而不是叠加 */
  key: string;
  title: string;
  body: string;
  priority: NotifyPriority;
  slot: NotifySlot;
  /** 同组通知在通知栏折叠（一般用 Host 名或「待决」） */
  group?: string;
  /** 点击直达目标 */
  route?: NotifyRoute;
  /** 是否为「进行中」通知（如长连接保活），不可被用户划掉 */
  ongoing?: boolean;
}

/** 通知中心当前状态（供诊断页展示） */
export interface NotifyFacts {
  /** 用户是否允许本应用发通知 */
  enabled: boolean;
  /** 渠道是否已创建 */
  slotsReady: boolean;
  /** 当前已发布且未撤回的通知数 */
  live: number;
  /** 最近一次失败原因（空串表示无失败） */
  lastError: string;
}
