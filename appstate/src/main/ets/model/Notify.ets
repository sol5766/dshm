/**
 * 通知**策略**（D3 §6「通知规范」）。
 *
 * 分层纪律（回答「为什么策略在 appstate 而不是 platform」）：
 *   `platform` 只提供**机制**——渠道创建、发布、按 key 撤回、点击直达（`NotificationCenter`）；
 *   本文件只回答**产品问题**——「哪类事件该发什么标题/正文/优先级/点到哪里」。
 *   因此 platform 不认识 PendingItem，本文件也不碰任何系统 API，全是纯数据 + 纯函数，可单测。
 *
 * 本文件是 D3 §6 那张表格的**唯一落点**：六行通知的标题/正文/优先级/点击目标逐行对应，
 * 规范表格不可协商，改动必须先改规范。
 *
 * 安全规则（D3 §6「内容纪律」，这是一条**安全**要求而不只是文案偏好）：
 *   通知正文**不得**包含代码内容、文件内容、凭据；只允许「会话标题 + 动作摘要」。
 *   通知会出现在锁屏预览、手表镜像、跨设备通知同步里，
 *   一旦把代码片段或 API key 塞进正文，等于把工作区内容与凭据泄露到应用沙箱之外。
 *   因此本文件把「正文怎么拼」收进 `notificationFor()` 一处，并配 `scrubCredentials()`
 *   与 `looksSensitive()` 让这条纪律**可被检查**（可写断言测试）。
 */

import { NotificationDraft, NotifyPriority, NotifyRoute, NotifySlot } from 'platform';
import { getString, isRecord, parseJson } from 'connection';
import { PendingItem, PendingKind } from './Trajectory';

/**
 * 通知类型（D3 §6 的六行一一对应）。
 *
 * 用枚举而不是散落的字符串，是为了让「规范里有几行」与「代码里有几种」在编译期对齐：
 * 新增规范行必须在此加枚举值，`policyOf()` 的穷尽分支会立刻提示漏配。
 */
export enum NotifyKind {
  /** 审批请求 */
  APPROVAL = 'approval',
  /** 用户提问 */
  QUESTION = 'question',
  /** 轮次完成 */
  TURN_DONE = 'turn-done',
  /** 任务/目标完成 */
  TASK_DONE = 'task-done',
  /** 失败/中断 */
  FAILURE = 'failure',
  /** 连接断开（可选通知） */
  DISCONNECTED = 'disconnected'
}

/** 点击目标类别（D3 §6「点击」列）。 */
export enum NotifyTarget {
  /** 直达审批卡 */
  APPROVAL_CARD = 'approval-card',
  /** 直达提问卡 */
  QUESTION_CARD = 'question-card',
  /** 直达会话底部 */
  SESSION_BOTTOM = 'session-bottom',
  /** 直达目标区块 */
  GOAL_BLOCK = 'goal-block',
  /** 直达错误位置 */
  ERROR_POSITION = 'error-position',
  /** 直达诊断页 */
  DIAGNOSTICS = 'diagnostics'
}

/**
 * 一行的策略（D3 §6 的一个表头列组）。
 *
 * 每个字段都能在规范表格里指到具体一格；没有「顺手加」的字段。
 */
export interface NotifyPolicy {
  kind: NotifyKind;
  /** 标题（规范「标题」列原样） */
  title: string;
  priority: NotifyPriority;
  slot: NotifySlot;
  target: NotifyTarget;
  /** 正文里除会话标题外是否还要带「动作摘要」；轮次完成/连接断开不带 */
  includeActionSummary: boolean;
  /** 动作摘要允许的最大字符数（0 = 不带摘要） */
  detailLimit: number;
  /**
   * 是否默认关闭（规范在「审批请求」与「连接断开」两行标注）。
   *
   * 规范原文：审批请求「高（响铃/震动，可绕过静默时段，默认关）」、
   * 连接断开「低（静默）」且该行类型名即标注「（可选）」。
   * 含义：能力存在、策略已定义，但**默认不打扰用户**，由用户在设置里打开。
   */
  defaultOff: boolean;
}

/** 会话标题缺失时的兜底占位（绝不把空标题拼成「：动作摘要」这种残句）。 */
export const UNTITLED_SESSION: string = '未命名会话';

/** 动作摘要的默认长度上限（规范只对提问钉了 40 字，其余摘要按「能一眼扫完」取值）。 */
export const DEFAULT_DETAIL_LIMIT: number = 60;

/** 提问正文的动作摘要上限：D3 §6 明确写「问题前 40 字」，属规范硬值。 */
export const QUESTION_DETAIL_LIMIT: number = 40;

/** 凭据被脱敏后的替换文本（保留占位，让句子仍读得通）。 */
export const REDACTED: string = '[已隐藏凭据]';

/**
 * D3 §6 通知表：**规范原表的代码形态**。
 *
 * 顺序与规范表格一致，便于逐行核对（改规范时对照顺序即可）。
 * 这里刻意不做「按 kind 索引的 Map」以外的加工：任何派生行为都放到纯函数里，
 * 让本表保持「可打印出来与规范贴在一起比对」的形态。
 */
export const NOTIFY_POLICIES: NotifyPolicy[] = [
  {
    kind: NotifyKind.APPROVAL,
    title: '需要批准',
    priority: NotifyPriority.HIGH,
    slot: NotifySlot.DECISION,
    target: NotifyTarget.APPROVAL_CARD,
    includeActionSummary: true,
    detailLimit: DEFAULT_DETAIL_LIMIT,
    defaultOff: true
  },
  {
    kind: NotifyKind.QUESTION,
    title: '有问题需要你回答',
    priority: NotifyPriority.HIGH,
    slot: NotifySlot.DECISION,
    target: NotifyTarget.QUESTION_CARD,
    includeActionSummary: true,
    detailLimit: QUESTION_DETAIL_LIMIT,
    defaultOff: false
  },
  {
    kind: NotifyKind.TURN_DONE,
    title: '回答完成',
    priority: NotifyPriority.NORMAL,
    slot: NotifySlot.OUTCOME,
    target: NotifyTarget.SESSION_BOTTOM,
    includeActionSummary: false,
    detailLimit: 0,
    defaultOff: false
  },
  {
    kind: NotifyKind.TASK_DONE,
    title: '任务完成',
    priority: NotifyPriority.NORMAL,
    slot: NotifySlot.OUTCOME,
    target: NotifyTarget.GOAL_BLOCK,
    includeActionSummary: true,
    detailLimit: DEFAULT_DETAIL_LIMIT,
    defaultOff: false
  },
  {
    kind: NotifyKind.FAILURE,
    title: '运行失败',
    priority: NotifyPriority.NORMAL,
    slot: NotifySlot.OUTCOME,
    target: NotifyTarget.ERROR_POSITION,
    includeActionSummary: true,
    detailLimit: DEFAULT_DETAIL_LIMIT,
    defaultOff: false
  },
  {
    kind: NotifyKind.DISCONNECTED,
    title: '连接已断开',
    priority: NotifyPriority.LOW,
    slot: NotifySlot.SYSTEM,
    target: NotifyTarget.DIAGNOSTICS,
    includeActionSummary: false,
    detailLimit: 0,
    defaultOff: true
  }
];

/** 取某一行的策略。表是有限枚举，找不到即编程错误，但这里仍返回一个安全兜底而不是抛异常。 */
export function policyOf(kind: NotifyKind): NotifyPolicy {
  for (let i = 0; i < NOTIFY_POLICIES.length; i++) {
    if (NOTIFY_POLICIES[i].kind === kind) {
      return NOTIFY_POLICIES[i];
    }
  }
  // 理论上不可达（kind 是枚举）；兜底成「连接断开」这种最安静的一行，避免误打扰用户。
  return NOTIFY_POLICIES[5];
}

/** 优先级 → 通知栏是否折叠进「决策」分组（规范的「高」两行合成一个分组）。 */
export function groupOf(kind: NotifyKind): string {
  const p: NotifyPolicy = policyOf(kind);
  return p.slot === NotifySlot.DECISION ? '待决' : '进展';
}

// ───────────────────────── 内容纪律：脱敏与截断 ─────────────────────────

/**
 * 疑似凭据的写法表。
 *
 * 只看**形状**，不看语义——我们无法知道用户工作区里哪个词是密钥，但密钥几乎总有可辨认的形状：
 *   1. `sk-` 前缀（本产品自家的 DeepSeek / OpenAI 风格密钥）；
 *   2. 已知服务前缀（`ghp_`/`gho_`/`xox?`/`AKIA`/`AIza`/`glpat-`）；
 *   3. `Bearer <token>` 认证头；
 *   4. `key=value` 形式的赋值（把「名字里带 key/token/secret/password」的值一起吃掉）；
 *   5. 兜底：足够长且混杂大小写/数字的连续串（≥24 位的不透明 token）。
 *
 * 取舍（**刻意宁可多脱敏**）：脱敏会把正常长词误伤成 `[已隐藏凭据]`。
 * 但这条规则服务于安全而非可读性——通知在锁屏可见，
 * 「偶尔少显示一个长词」远好于「偶尔泄露一个真密钥」，因此不追求零误伤。
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|glpat|xoxa|xoxb|xoxp|AKIA|AIza)[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\b[A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|credential)[A-Za-z0-9_.-]*\s*[:=]\s*\S+/gi,
  /(?=[A-Za-z0-9_-]{24,})(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{24,}/g
];

/**
 * 是否包含疑似凭据。
 *
 * 存在理由：把「内容纪律」变成**可断言**的谓词，
 * 让测试/评审能对一条已生成的正文直接判定「违规与否」，
 * 而不是靠人眼审阅文案。返回 true 表示**发现疑似凭据**（即违规）。
 */
export function looksSensitive(text: string): boolean {
  for (let i = 0; i < SENSITIVE_PATTERNS.length; i++) {
    // 每次判定前重置 lastIndex：这些正则带 g 标志，复用同一个对象会留下游标状态。
    SENSITIVE_PATTERNS[i].lastIndex = 0;
    if (SENSITIVE_PATTERNS[i].test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * 把疑似凭据替换成占位符。
 *
 * 为什么需要（而不是「发现疑似就整条丢弃」）：
 *   整条丢弃会让用户看到「什么都没说」的通知；替换占位符仍能传达
 *   「这条摘要里原本有一个凭据，我们替你藏了」，信息量更大且不泄露。
 */
export function scrubCredentials(text: string): string {
  let out: string = text;
  for (let i = 0; i < SENSITIVE_PATTERNS.length; i++) {
    SENSITIVE_PATTERNS[i].lastIndex = 0;
    out = out.replace(SENSITIVE_PATTERNS[i], REDACTED);
  }
  return out;
}

/**
 * 折叠空白（换行/制表/连续空格 → 单个空格）。
 *
 * 为什么必须先做这一步：动作摘要来自工具参数或错误信息，天然含换行与缩进；
 * 不折叠的话，截断出来的「前 40 字」可能全是缩进空格——既没信息量，
 * 也容易把多行代码的**第二行**内容带进通知（那正是我们要防的）。
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 生成可安全放进通知正文的动作摘要。
 *
 * 处理链（顺序有讲究，不能换）：
 *   1. 折叠空白 → 让行结构消失，代码块无法以「多行」形态漏出；
 *   2. 脱敏 → 在截断**之前**做，避免密钥被截成半截而逃过模式匹配；
 *   3. 按规范上限截断 → 提问 40 字（D3 §6 硬值），其余按策略表。
 *
 * `limit <= 0` 返回空串，调用方据此不拼摘要（轮次完成/连接断开两行就是这种）。
 */
export function sanitizeDetail(text: string, limit: number): string {
  if (limit <= 0) {
    return '';
  }
  const flat: string = collapseWhitespace(text);
  if (flat.length === 0) {
    return '';
  }
  const scrubbed: string = scrubCredentials(flat);
  if (scrubbed.length <= limit) {
    return scrubbed;
  }
  // 用「…」而不是悄悄切掉，让读者知道后面还有内容（避免误读成完整摘要）。
  return `${scrubbed.substring(0, limit)}…`;
}

// ───────────────────────── 去重键与撤回 ─────────────────────────

/**
 * 去重键。
 *
 * 为什么键必须**跨重连稳定**：
 *   `platform` 的 `NotificationCenter` 用 `stableId(key)` 把键映射成系统通知 id，
 *   `withdraw(key)` 再靠同一个键找回 id 取消通知。
 *   如果键里掺进「本次连接代次」「到达时间」「自增序号」这类会变的东西，
 *   那么同一条审批在断线重连后会被算成**新**通知：
 *     已发出的旧通知撤不掉（键对不上），用户先收到一条永远不会消失的僵尸通知，
 *     再收到一条重复通知——正好违反 D3 §6「同一审批/提问的多端处理只推一次」。
 *
 * 因此键只能由**业务身份**构成：类型 + 会话 id + 待决项 id。
 * 没有 pendingId 的行（轮次完成等）用 '0' 占位，
 * 使同一会话的该类通知天然互相覆盖（新的一条替换旧的，而不是堆叠一列）。
 */
export function dedupeKeyOf(kind: NotifyKind, sessionId: string, pendingId: string): string {
  const pend: string = pendingId.length > 0 ? pendingId : '0';
  return `dsh.notify.${kind}.${sessionId}.${pend}`;
}

/**
 * 某个待决项被处理后，必须撤回的通知键。
 *
 * 存在理由：D3 §6 要求「处理完成后**主动撤回**对应通知」。
 * 多端场景下，「处理」可能发生在另一台设备上——本端是从事件流得知的，
 * 此时本端手上只有「哪个会话的哪个待决项已解决」，没有通知 id，
 * 必须能**由业务身份反推出键**，这正是本函数与 `dedupeKeyOf()` 共用同一算法的原因。
 */
export function withdrawalKeysFor(kind: NotifyKind, sessionId: string, pendingId: string): string[] {
  return [dedupeKeyOf(kind, sessionId, pendingId)];
}

/**
 * 会话被整体处理掉（归档 / 删除 / 切走并清理）时要撤回的键：该会话的**全部**通知类型。
 *
 * 取舍：撤回是「按已知 key 取消」，所以只能穷举该会话的六种 kind，
 * 而不是「按前缀批量取消」。前者不依赖 platform 提供新能力，且在键结构变化时
 * 会立刻编译期暴露（新增 kind 时本函数必须同步补上）。
 */
export function withdrawalKeysForSession(sessionId: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < NOTIFY_POLICIES.length; i++) {
    out.push(dedupeKeyOf(NOTIFY_POLICIES[i].kind, sessionId, ''));
  }
  return out;
}

// ───────────────────────── 路由与草稿 ─────────────────────────

/**
 * 点击目标 → `platform` 的路由描述。
 *
 * 分层要点：`NotifyRoute.page` 用的是**路由 token**（sessions / pending / diagnostics），
 * 不是 UI 的内部页对象——这样「通知点击」与「应用内跳转」在 entry 层能走同一个解析函数。
 */
export function routeOf(kind: NotifyKind, sessionId: string, pendingId: string,
  hostId: string): NotifyRoute {
  const target: NotifyTarget = policyOf(kind).target;
  let page: string = 'sessions';
  if (target === NotifyTarget.APPROVAL_CARD || target === NotifyTarget.QUESTION_CARD) {
    page = 'pending';
  } else if (target === NotifyTarget.DIAGNOSTICS) {
    page = 'diagnostics';
  }
  // 只挂该目标真正需要的定位参数：多余的参数会让路由解析出现「不该存在的组合」。
  const route: NotifyRoute = { page: page };
  if (hostId.length > 0) {
    route.hostId = hostId;
  }
  if (sessionId.length > 0 && page !== 'diagnostics') {
    route.sessionId = sessionId;
  }
  if (pendingId.length > 0 && page === 'pending') {
    route.pendingId = pendingId;
  }
  return route;
}

/** `notificationFor()` 的入参（收成一个接口，避免长位置参数在调用点错位）。 */
export interface NotifyInput {
  kind: NotifyKind;
  sessionId: string;
  /** 会话标题；空串时用 `UNTITLED_SESSION` 兜底 */
  sessionTitle: string;
  /** 动作摘要原文（工具参数/问题正文/错误码）；连接断开时传 Host 名，会被忽略 */
  detailText: string;
  /** 待决项 id（审批/提问必填，其余传空串） */
  pendingId: string;
  /** Host 记录 id（多 Host 时用于切回正确连接；单 Host 传空串） */
  hostId: string;
}

/**
 * 组装一条待发布通知（D3 §6 的完整实现）。
 *
 * 正文规则（安全规则，见文件头）：`<会话标题>`，需要摘要时拼成 `<会话标题>：<动作摘要>`。
 * 就这么多——正文里**不允许**出现第三种成分。
 * 轮次完成与连接断开两行的规范正文只有会话标题/Host 名，因此 `detailText` 被忽略。
 */
export function notificationFor(input: NotifyInput): NotificationDraft {
  const policy: NotifyPolicy = policyOf(input.kind);
  const title: string = input.sessionTitle.length > 0 ? input.sessionTitle : UNTITLED_SESSION;
  const summary: string = policy.includeActionSummary
    ? sanitizeDetail(input.detailText, policy.detailLimit)
    : '';
  const body: string = summary.length > 0 ? `${title}：${summary}` : title;
  return {
    key: dedupeKeyOf(input.kind, input.sessionId, input.pendingId),
    title: policy.title,
    body: body,
    priority: policy.priority,
    slot: policy.slot,
    group: groupOf(input.kind),
    route: routeOf(input.kind, input.sessionId, input.pendingId, input.hostId),
    ongoing: false
  };
}

// ───────────────────────── 未授权时的应用内降级 ─────────────────────────

/** 应用内降级提示（通知发不出去时 UI 直接渲染这段文字）。 */
export interface InAppNotice {
  title: string;
  body: string;
  /** 该条是否允许用户点击直达（与通知点击同语义） */
  route: NotifyRoute;
}

/**
 * 用户拒绝通知授权时的应用内文案。
 *
 * 存在理由（D3 §6 与 `NotificationCenter.ensureEnabled()` 的契约）：
 *   授权失败**不是错误**，只是降级——「不许因为没通知就丢事件」。
 *   因此策略层必须能产出**同一份信息**的应用内版本，且它必然与通知正文一致
 *   （同一个 `notificationFor()` 产物加一个「需要处理」前缀），
 *   否则两条通道的措辞会各自漂移。
 *
 * 取舍：应用内版本可以比通知更啰嗦（它不在锁屏上，泄露面小得多），
 * 但我们仍复用同一条已脱敏正文，保持「一处脱敏、处处脱敏」的单一实现。
 */
export function inAppFallbackText(input: NotifyInput): InAppNotice {
  const draft: NotificationDraft = notificationFor(input);
  const policy: NotifyPolicy = policyOf(input.kind);
  const prefix: string = policy.slot === NotifySlot.DECISION ? '需要你处理：' : '';
  const route: NotifyRoute | undefined = draft.route;
  return {
    title: `${prefix}${draft.title}`,
    body: draft.body,
    // route 在 notificationFor 里必然被赋值；这里的兜底只为满足类型收窄，不代表可发生。
    route: route !== undefined ? route : { page: 'sessions' }
  };
}

/**
 * 路由里允许出现的页面名。
 *
 * 【为什么要白名单】路由是通过 Want 参数从**系统通知**回到应用的，
 * 而通知参数在应用升级后可能是**旧版本**写下的（用户点了几天前的那条通知）。
 * 不加校验就会把任意字符串当页面名去跳转——最坏情况是跳到一个不存在的页面，
 * 表现是"点了通知什么都没发生"，而没有任何线索说明为什么。
 */
export const NOTIFY_PAGES: string[] = ['sessions', 'pending', 'diagnostics'];

/**
 * 解析通知点击携带的路由（`NotificationCenter.buildAgent` 写入的 `dshRoute` 参数）。
 *
 * 返回 `undefined` 表示**不该跳转**（JSON 坏、缺 `page`、或页面名不在白名单里）——
 * 调用方据此保持当前页面，而不是猜一个目标。
 *
 * 实现说明：只做形状校验，不做"参数组合是否合理"的推断（例如 `pending` 页面
 * 却带了 `pendingId` 之外的东西）。组合语义由 `routeOf()` 在**生产端**保证，
 * 消费端重复推断一遍等于把同一条规则写两处。
 */
export function parseNotifyRoute(json: string): NotifyRoute | undefined {
  if (json.length === 0) {
    return undefined;
  }
  const parsed: Object | undefined = parseJson(json);
  if (parsed === undefined || !isRecord(parsed)) {
    return undefined;
  }
  const page: string | undefined = getString(parsed, 'page');
  if (page === undefined || NOTIFY_PAGES.indexOf(page) < 0) {
    return undefined;
  }
  const route: NotifyRoute = { page: page };
  const hostId: string | undefined = getString(parsed, 'hostId');
  if (hostId !== undefined && hostId.length > 0) {
    route.hostId = hostId;
  }
  const sessionId: string | undefined = getString(parsed, 'sessionId');
  if (sessionId !== undefined && sessionId.length > 0) {
    route.sessionId = sessionId;
  }
  const pendingId: string | undefined = getString(parsed, 'pendingId');
  if (pendingId !== undefined && pendingId.length > 0) {
    route.pendingId = pendingId;
  }
  return route;
}

/**
 * 内容纪律的自检：给定一条草稿，返回它是否**违规**。
 *
 * 存在理由：把文件头的安全规则变成评审/测试可调用的一次判定。
 * 返回 true 表示「这条草稿不该被发布」，而不是「文本里有敏感词」这么含糊。
 */
export function assertNoSensitiveContent(draft: NotificationDraft): boolean {
  if (looksSensitive(draft.title) || looksSensitive(draft.body)) {
    return true;
  }
  // 兜底几何检查：正文只允许「标题」或「标题：摘要」两种形态，
  // 出现第二个冒号意味着有人在正文里塞了额外内容（例如 `path:line:col` 形式的代码位置）。
  const firstColon: number = draft.body.indexOf('：');
  if (firstColon >= 0 && draft.body.indexOf('：', firstColon + 1) >= 0) {
    return true;
  }
  return false;
}

// ───────────────────────── 「何时发」的入参构造 ─────────────────────────

/**
 * 待决项 → 通知入参。
 *
 * 【为什么"何时发"要单独有函数，而不是让调用方自己拼 `NotifyInput`】
 *   拼一个 `NotifyInput` 需要同时知道三件事：待决项的类型、政策层要求哪个 `kind`、
 *   以及"摘要用哪段文本"。把这三件事留给每个调用点，就会出现"审批通知用了提问的 kind"
 *   或"把整段问题正文塞进摘要"这类错误——而它们**只在锁屏上才看得出来**。
 *   收成一个函数后，"待决项长什么样"与"通知怎么发"之间只有一条通路。
 */
export function notifyInputForPending(item: PendingItem, sessionTitle: string,
  hostId: string): NotifyInput {
  const kind: NotifyKind = item.kind === PendingKind.APPROVAL
    ? NotifyKind.APPROVAL : NotifyKind.QUESTION;
  return {
    kind: kind,
    sessionId: item.sessionId,
    sessionTitle: sessionTitle,
    // 摘要用**动作名/问题标题**（短、已由待决投影给出），不是 `detail`：
    // 正文只允许「标题：摘要」两段，塞长文本会被 `assertNoSensitiveContent` 判违规。
    detailText: item.title,
    pendingId: item.id,
    hostId: hostId
  };
}

/** 待决项被处理后应当撤回的通知键（按它的 kind 计算，不能按"当前所有 kind"撤）。 */
export function withdrawalKeysForPending(item: PendingItem): string[] {
  const kind: NotifyKind = item.kind === PendingKind.APPROVAL
    ? NotifyKind.APPROVAL : NotifyKind.QUESTION;
  return withdrawalKeysFor(kind, item.sessionId, item.id);
}

/**
 * 轮次结束 → 通知入参。
 *
 * @param failed 这一轮是否以失败/中断收场（决定 `FAILURE` 还是 `TURN_DONE`）
 *
 * 两者的正文规范都**只有会话标题**，因此 `detailText` 传空串——
 * 传了也会被 `notificationFor` 按政策忽略，但显式传空能让"这里不参与正文"一眼可见。
 */
export function notifyInputForTurn(sessionId: string, sessionTitle: string, hostId: string,
  failed: boolean): NotifyInput {
  return {
    kind: failed ? NotifyKind.FAILURE : NotifyKind.TURN_DONE,
    sessionId: sessionId,
    sessionTitle: sessionTitle,
    detailText: '',
    pendingId: '',
    hostId: hostId
  };
}

/**
 * 连接状态变化 → 通知入参。
 *
 * 【为什么目前**不**接线】D3 §6 把「连接断开」定为低优先级且**默认关闭**，
 * 而本客户端尚未实现本机偏好（没有那个开关）。更关键的是实测现实：
 * 这台设备上长连接约 5 秒就断一次（见 D2 §8.7.19），
 * 按默认开启发布会让用户每 5 秒收一条"连接断开"——比不发更糟。
 * 因此这里只保留入参构造，等"本机偏好"落地后再由偏好决定是否发布。
 */
export function notifyInputForConnection(hostName: string, hostId: string): NotifyInput {
  return {
    kind: NotifyKind.DISCONNECTED,
    sessionId: '',
    // 连接通知的"标题"位置放 Host 名（D3 §6 该行正文只有 Host 名）
    sessionTitle: hostName,
    detailText: '',
    pendingId: '',
    hostId: hostId
  };
}
