/**
 * 上游字段别名表与常用 endpoint 便捷入口。
 *
 * 存在理由（回答「方便适配上游升级」）：
 *   投影层需要按字段名取值，而上游可能改名。把「候选名列表」集中在本文件后，
 *   上游改名时只改这里；投影层与 UI 无需改动。
 *   别名顺序 = 优先匹配顺序；通常把当前实测名放第一位。
 *
 * 维护纪律：新增别名必须来自实测或上游源码，不允许凭猜测堆砌
 * （否则会把「字段不存在」误判成「值就是空」）。
 */

import { FieldAliases } from './CompatTypes';
import { buildArgs } from './CompatIndex';

/**
 * 字段别名表类型。
 *
 * 注意：ArkTS 禁止交叉类型（arkts-no-intersection-types），
 * 因此这里用「继承 FieldAliases 的具名接口」表达，而不是 `FieldAliases & Record<...>`。
 */
export interface FieldAliasTable extends FieldAliases {
  /** 会话 id */
  id: string[];
  /** 会话标题 */
  title: string[];
  /** 工作目录 */
  cwd: string[];
  /** 最近活动时间 */
  updatedAt: string[];
  /** 创建时间 */
  createdAt: string[];
  /** 是否运行中 */
  running: string[];
}

/** 会话列表项的字段别名（D2 §8.5 的实际返回结构 + 历史名称容忍） */
export const FIELD_ALIASES: FieldAliasTable = {
  /** 集合容器键 */
  list: ['items', 'sessions', 'data'],
  /**
   * 会话 id。实测（0.1.5-rc.1 的 `SessionSummary`）用的名字是 `sessionId`，
   * 因此把它排在第一位——别名表的顺序是匹配优先级，把历史名排在实测名前面
   * 会让投影读到错误字段而不自知。
   */
  id: ['sessionId', 'id', 'sid'],
  /**
   * 顶层标题别名。
   *
   * 注意：**当前上游的标题不在顶层**，在 `projections.values.title`
   * （见 `RemoteEvents.PROJECTION_TITLE`）。投影层必须先读投影、再回落本表，
   * 顺序写在 `appstate/model/SessionList.ets` 的 `pickTitle()` 里。
   * 这里保留顶层候选只为容忍历史/第三方 Host。
   */
  title: ['title', 'name', 'summary'],
  cwd: ['cwd', 'workspace', 'workspacePath', 'directory'],
  updatedAt: ['updatedAt', 'lastActivityAt', 'lastActiveAt', 'mtime'],
  createdAt: ['createdAt', 'ctime'],
  running: ['running', 'isRunning', 'active']
};

// ─────────────────── 常用 endpoint（避免在各处写字面量） ───────────────────

/** 会话列表（可取消；参数为 `_request`） */
export const SESSION_LIST_ENDPOINT: string = 'session/list';
/** 会话创建 */
export const SESSION_CREATE_ENDPOINT: string = 'session/create';
/** 发送提示词 */
export const SESSION_PROMPT_ENDPOINT: string = 'session/prompt';
/** 取消当前轮次 */
export const SESSION_CANCEL_ENDPOINT: string = 'session/cancel';
/** 会话改名 */
export const SESSION_RENAME_ENDPOINT: string = 'session/rename';
/** 会话分叉（从某个事件序号起复制出一个新会话） */
export const SESSION_FORK_ENDPOINT: string = 'session/fork';
/** 修改待发队列中的某一项（编辑 / 移除 / 转为插话） */
export const SESSION_UPDATE_QUEUE_ENDPOINT: string = 'session/updateQueue';
/**
 * 按游标读取会话记录（**一元**）。
 *
 * 【为什么值得单独接出来】设备上 WebSocket 长连接约 5 秒必断、`$events` 常拿不到 `ready`
 * （D2 §8.7.19），而一元 HTTP 是好的。实测这条端点能读出**整段历史**
 * （D2 §8.7.23），因此它给"读会话内容"提供了一条不依赖长连接的兜底通路。
 */
export const SESSION_PAGE_ENDPOINT: string = 'session/page';
/** 会话轨迹流（**流式**，必须走 mux 载体） */
export const SESSION_FOLLOW_ENDPOINT: string = 'session/follow';
/** 审批/提问控制流（**流式**） */
export const SESSION_CONTROL_ENDPOINT: string = 'session/control';
/** 设置描述（无参数） */
export const SETTINGS_DESCRIBE_ENDPOINT: string = 'settings/describe';

/**
 * 设置写入（有序路径操作）。
 *
 * 【为什么选 `mutate` 而不是 `update` / `replace`】上游三个写端点语义不同（D2b §4）：
 *   - `update` 的 `patch` 是**浅覆盖**：改 `retryPolicy.maxRetries` 会整块替换 `retryPolicy`；
 *   - `replace` **整体替换**用户 section：未出现的键被删除，用它改一个开关会误删其他设置；
 *   - `mutate` 是**按路径**的 `set`/`unset`，正合「改一个具体字段」这个唯一用例。
 * 本客户端只做单字段编辑，所以选 `mutate`；选错会导致**静默删掉用户的其他设置**。
 */
export const SETTINGS_MUTATE_ENDPOINT: string = 'settings/mutate';
/** 设置写入被拒（未注册/畸形命名空间、只读提供方、schema 校验、存储失败） */
export const SETTINGS_REJECTED = 'settings/rejected';
/**
 * 设置写入的版本冲突：`{ns, expected, actual}`。
 *
 * 这是**独立的一种结果**（不是「非法请求」）：调用方必须重新读取后再写，
 * 而不是重试同一个请求——重试永远失败，用户会看到「点了没反应」。
 */
export const SETTINGS_CONFLICT = 'settings/conflict';
/** 凭据写入被拒：`{ref}`（详情只给引用名，永不含值） */
export const CREDENTIAL_REJECTED = 'credential/rejected';
/** 模型目录（无参数，只读，适合作连通性探测） */
export const MODEL_CATALOG_ENDPOINT: string = 'session/modelCatalog';
/** 插件清单（无参数，只读） */
export const PLUGIN_INVENTORY_ENDPOINT: string = 'pluginInventory/list';
/** 凭据描述 */
export const CREDENTIALS_DESCRIBE_ENDPOINT: string = 'credentials/describe';
/**
 * 凭据写入。
 *
 * 【成功回复是 `{ok:true}`，没有 `value` 键】上游把它的 `typeSymbol` 标为 `void`，
 * `JSON.stringify` 会把 `value: undefined` 丢掉（D2b §4.1）。因此
 * **不能用「有没有 value」判断成败**——那会把每一次成功都当失败。
 * 解析层已按「键存在性」区分「没有 value 键」与「有 value 键但值为 null」
 * （见 D2 §8.7.6 缺陷 2 的同类陷阱）。
 */
export const CREDENTIALS_SET_ENDPOINT: string = 'credentials/set';
/** 凭据删除（同样是 `void` 回复） */
export const CREDENTIALS_UNSET_ENDPOINT: string = 'credentials/unset';

// ── 0.1.5-rc.1 新增端点（升级时新增；老 Host 上会 404，由能力探测降级） ──

/**
 * 工作区注册（E98）：**在已有目录上创建或幂等解析一个工作区**，回复 `{workspace, created}`。
 *
 * 【为什么必须注册】只给 `session/create` 传 `cwd` 而不注册工作区时，会话没有可折叠的
 * 工作区条目：真机上表现为打开会话即抛 `gateway/internal …reading 'kind'`
 * （用户看到的「轨迹流失败」）与 `workspaceFiles/list … cannot list`。
 * 注册一次之后，建会话带上 `workspaceId`，两者都成立。
 */
export const WORKSPACE_CREATE_ENDPOINT: string = 'workspace/create';

/**
 * 工作区注册表**变更流**（E132）。
 *
 * 首帧 `{type:'baseline', value:{items: WorkspaceView[], archivedSessionIds}}`，
 * 其后是增量（`{type:'upsert', workspace}` …）。
 * 【为什么必须接它】注册表是**唯一**能给出 `workspaceId` 的地方，而
 * `workspace/delete` 与 `workspace/archiveSession` 都以 id 为键——
 * 我们此前的工作区列表是从会话 `cwd` 投影出来的，**没有 id**，那两个动作因此做不了。
 */
export const WORKSPACE_FOLLOW_ENDPOINT: string = 'workspace/follow';
/** 删除一个工作区注册（请求 `{workspaceId}`，回复 `{deleted:true}`） */
export const WORKSPACE_DELETE_ENDPOINT: string = 'workspace/delete';
/**
 * 归档一个会话（请求 `{sessionId}`，回复 `{archivedSessionIds}`——**完整**归档集合）。
 * 官方语义是"注册表全局归档集"：客户端按它把会话从常规列表里过滤掉。
 */
export const WORKSPACE_ARCHIVE_SESSION_ENDPOINT: string = 'workspace/archiveSession';

/**
 * 技能清单（E135）。请求 `{request:{scope?}}`（REQUEST 形态），回复为技能摘要列表。
 *
 * 摘要字段（`dsh-skill` 的 `SkillSummary`）：
 * `{name, description, whenToUse?, invocation, source, provider, resourceBase?}`。
 * **外层键未确证**：类型定义里只给了单个摘要的形状，没说列表挂在哪个键下
 * （`skills` / `items` / 裸数组都有可能）⇒ 解析层两种都收，都不中就如实记账，
 * 等真机把真实形状打出来再收紧（不猜一个键名然后当它是对的）。
 */
export const SKILLS_LIST_ENDPOINT: string = 'skills/list';

/*
 * ── Agent 预设（E156 纠正语义后接线）──────────────────────────────────────
 *
 * 【语义】预设 = **一个会话的 Agent 所运行的插件组装**（它的工具、提示词与能力），
 * 不是"模型设置"。官方流程：**复制一份既有预设**改成自己的（复制对话框是**唯一**创建入口，
 * 浏览器不编辑任何组装文本），或用「创造模式」让 Agent 帮你创建。
 * 宿主侧 `dsh-agent-presets` 有 `typert.host.js` ⇒ 这四个端点是真实存在的表面。
 */
/** 预设名单 */
export const AGENT_PRESETS_LIST_ENDPOINT: string = 'agentPresets/list';
/** **复制**一个既有预设（创建自定义预设的唯一入口） */
export const AGENT_PRESETS_COPY_ENDPOINT: string = 'agentPresets/copy';
/** 删除一个**自定义**预设（随附预设不可删；已据其组装的会话继续运行） */
export const AGENT_PRESETS_DELETE_ENDPOINT: string = 'agentPresets/deletePreset';
/** 读取一个预设的内容（只读查看器用） */
export const AGENT_PRESETS_READ_ENDPOINT: string = 'agentPresets/read';

/*
 * ── 模型提供方（E178：官方 Models 页的数据源）─────────────────────────────
 *
 * 官方 `dsh-client-ui-settings-models` 的说明原文：提供方目录 =
 * `llm/listProviders`（**已注册的路由**）**联合** `llm/listConfigurableProviders`
 * （**声明出来的可配置提供方**，即"可添加"的来源），再与各提供方的**设置命名空间**
 * （`llm-<name>` 之类）对应；模型目录在该命名空间下用 `llm/discoverModels` 发现。
 * 我们的模型页此前只渲染"已出现在设置里的提供方" ⇒ **无法添加新提供方**，这正是用户指出的缺口。
 */
/** 已注册的路由（当前可用的提供方） */
export const LLM_LIST_PROVIDERS_ENDPOINT: string = 'llm/listProviders';
/** 声明出来的**可配置**提供方（"添加提供方"的目录；NONE 形态，无参数） */
export const LLM_LIST_CONFIGURABLE_PROVIDERS_ENDPOINT: string = 'llm/listConfigurableProviders';

/** 工作区文件列表（需要的 `workspaceFileScopeId` 来自会话/工作区上下文） */
export const WORKSPACE_FILES_LIST_ENDPOINT: string = 'workspaceFiles/list';
/** 工作区文件元信息 */
export const WORKSPACE_FILES_STAT_ENDPOINT: string = 'workspaceFiles/stat';
/** 工作区文件读取（文本） */
export const WORKSPACE_FILES_READ_ENDPOINT: string = 'workspaceFiles/read';
/**
 * 工作区文件读取（**整文件，base64**，无 `range`）。
 *
 * 【为什么要单独有这个常量】「投喂 Host 侧文件」需要的是**字节**而不是文本：
 * `read` 只返回 UTF-8 文本（且非文本直接拒绝），拿不到可上传的 base64。
 * `readAll` 返回 `WorkspaceFileBytes`（`{offset:0, data:<base64>, eof:true, ...}`），
 * 正是 `fileUploads/upload` 需要的输入。两者不可互相替代。
 */
export const WORKSPACE_FILES_READ_ALL_ENDPOINT: string = 'workspaceFiles/readAll';
/** 工作区文件变更流（**流式**） */
export const WORKSPACE_FILES_CHANGES_ENDPOINT: string = 'workspaceFiles/changes';
/** 附件上传（返回的引用随后放入 prompt/命令的附件字段） */
export const FILE_UPLOAD_ENDPOINT: string = 'fileUploads/upload';
/** 读取单个目标 */
export const GOALS_GET_ENDPOINT: string = 'goals/get';
/** 记录会话反馈 */
export const SESSION_FEEDBACK_RECORD_ENDPOINT: string = 'sessionFeedback/record';

/*
 * ── 消息级反馈（E252：官方 `ui-message-feedback`）─────────────────────────
 *
 * 权威契约（`dsh-message-feedback` 的 `types.d.ts`，E251 取证）：
 *   · `list`   = `{ sessionId }` → `{ items: MessageFeedbackItem[] }`（按首次创建顺序）
 *   · `put`    = `{ sessionId, messageId, rating, note?, category? }`
 *                —— 上游注释原文："Create or replace feedback for one assistant message"
 *   · `delete` = 删除某条消息的反馈
 * 语义：`rating` 是**总体判断**，`note` 是可选说明，`category` 可选（缺省即未分类）。
 */
/** 读某会话的全部消息反馈 */
export const MESSAGE_FEEDBACK_LIST_ENDPOINT: string = 'messageFeedback/list';
/** 创建或替换**某一条助手消息**的反馈 */
export const MESSAGE_FEEDBACK_PUT_ENDPOINT: string = 'messageFeedback/put';
/** 删除某条消息的反馈 */
export const MESSAGE_FEEDBACK_DELETE_ENDPOINT: string = 'messageFeedback/delete';

/** 斜杠命令执行（参数名在上游发生过改名，见 `PARAM_ALIASES`） */
export const COMMANDS_EXECUTE_ENDPOINT: string = 'commands/execute';
/**
 * 斜杠命令目录。
 *
 * 【为什么必须拉真实目录而不是内置一份命令表】
 *   命令由 Host 侧的插件注册（上游 `dsh-commands`），**客户端无法预知全集**：
 *   内置一份「常见命令」会在 Host 装了别的插件时漏掉真实命令，
 *   又会在插件被禁用后继续展示不存在的命令。两种错误都让用户按下一个必然失败的命令。
 *   实测回复是 `CommandDescriptor[]`（D2b §6.1），`description` 之外还有可选 `input.hint`。
 */
export const COMMANDS_LIST_ENDPOINT: string = 'commands/list';
/** 工作区内文件路径候选（`@` 文件的真实来源） */
export const FILE_REFERENCES_LIST_ENDPOINT: string = 'fileReferences/list';
/** 可 `@` 提及的会话候选（与文件候选是两个不同端点，不能互相替代） */
export const SESSION_REFERENCE_CANDIDATES_ENDPOINT: string = 'sessionReferenceResolver/candidates';

/** 只读探测端点（用于连通性与能力探测；均为无副作用调用） */
export const READONLY_PROBE_ENDPOINTS: string[] = [
  MODEL_CATALOG_ENDPOINT,
  PLUGIN_INVENTORY_ENDPOINT,
  SETTINGS_DESCRIBE_ENDPOINT
];

// ─────────────────── 参数别名（容忍上游参数改名） ───────────────────

/**
 * `session/selectModel`（E192）：**按会话**切换模型与推理强度。
 *
 * 【为什么需要它】官方把它放在**会话输入区**（`dsh-client-ui-model-selection`），
 * 而设置页只管"新会话默认用什么"（写 `agent-default-model`，我们早就有 `setDefaultModel`）。
 * 此前只有后者 ⇒ 用户在一个**已存在**的会话里改不了用哪个模型/强度。
 * 端点在兼容表里（`Endpoints.ets:683`，`shape: REQUEST`、`params: ['request']`）。
 */
export const SESSION_SELECT_MODEL_ENDPOINT: string = 'session/selectModel';

/**
 * 一个发生改名的参数。
 *
 * 存在理由（D5 升级手册「降级策略」）：
 *   上游不保证参数名稳定。0.1.5-rc.1 就把 `commands/execute` 的 `images` 改成了
 *   `submittedAttachments`——**形状没变，名字变了**，表现为 `gateway/arguments-invalid`。
 *   这类破坏性改名若靠版本号分支处理，会在「版本号读不到」时失效；
 *   而按别名重试一次是纯粹由**错误码驱动**的，与版本号无关，因此更稳。
 *
 * 用法：先用 `current` 名构造参数调用；若返回 `gateway/arguments-invalid`，
 * 用 `rebuildWithLegacyNames()` 换用 `legacy[0]` 重试一次；再失败则不再重试（是真的不兼容）。
 */
export interface ParamAlias {
  /** 当前（最新已验证上游）使用的参数名 */
  current: string;
  /** 历史参数名，按「最近的旧名优先」排列 */
  legacy: string[];
}

/**
 * endpoint → 该端点上发生过改名的参数。
 *
 * 【唯一的真实条目：`commands/execute` 的 `images` → `submittedAttachments`】
 *   这条是**实测确认**的线上改名，不是形参改名：
 *     - `0.1.2-rc.1` 契约：`params = [agentId<-agent, line<-line, images<-images]`
 *     - `0.1.5-rc.1` 契约：`params = [agentId<-agent, line<-line, submittedAttachments<-submittedAttachments]`
 *   （`wire<-name` 记法；两端点都是 `kind: direct`、`cancellable: true`，其余完全一致。）
 *   我们的上表对准 0.1.5，因此 `current` 是新名、`legacy` 是旧名。
 *
 * 【一次被推翻的「推翻」，留档为教训】
 *   升级过程中曾有一位复核者判定这条是**假阳性**，理由是「该参数的线上名在两版里都是
 *   `submittedAttachments`」。这个结论本身是错的，错因值得记住：
 *   它拿**已提交上表里的 `name`**（当时生成工具有缺陷，存的是 TS 形参名）去比
 *   **契约里的 `wire`**——两个字段不对等。而在这个端点上 `name` 与 `wire` 恰好相同，
 *   所以那次比对看起来「两边都是新名」，实则只证明了「新版的 name 等于新版的 wire」。
 *
 *   教训：**比对必须字段对字段**。跨来源比对时先确认两边取的是同一个字段，
 *   否则会得到一个看起来很有说服力的错误结论——比没有结论更危险。
 *
 * 【怎么加新条目】
 *   1. 只认**线上名**（`protocol-contract.mjs` 提取出的 `wire`）的变化；
 *   2. 必须两端都用 `wire` 比对，并记录两端原始 params 数组作为证据；
 *   3. 形参名（`name`）变化**不得**入表——它对客户端零影响。
 */
export const PARAM_ALIASES: Record<string, ParamAlias[]> = {
  'commands/execute': [{ current: 'submittedAttachments', legacy: ['images'] }]
};

/** 该 endpoint 是否存在参数别名（调用方据此决定要不要在 arguments-invalid 时重试）。 */
export function hasParamAliases(endpoint: string): boolean {
  const list: ParamAlias[] | undefined = PARAM_ALIASES[endpoint];
  return list !== undefined && list.length > 0;
}

/**
 * 用第 `round` 代旧名重建参数体。
 *
 * `round = 0` 表示使用当前名（原样返回）；`round = n > 0` 表示使用第 n 个旧名。
 * 超出旧名列表时返回 `undefined`，调用方据此停止重试。
 *
 * 注意：只处理**顶层**参数名。上游若改的是嵌套字段，需要另加机制——
 * 目前未观察到这种情况，不预先抽象。
 */
export function rebuildWithLegacyNames(endpoint: string, body: Record<string, Object>,
  round: number): Record<string, Object> | undefined {
  if (round === 0) {
    return body;
  }
  const list: ParamAlias[] | undefined = PARAM_ALIASES[endpoint];
  if (list === undefined) {
    return undefined;
  }
  const out: Record<string, Object> = {};
  const keys: string[] = Object.keys(body);
  for (let i = 0; i < keys.length; i++) {
    const key: string = keys[i];
    const renamed: string = legacyNameOf(list, key, round);
    if (renamed.length === 0) {
      return undefined;
    }
    out[renamed] = body[key];
  }
  return out;
}

/** 在第 round 代别名表中查找 key 的旧名；不存在改名时原样返回；超出代数返回空串。 */
function legacyNameOf(list: ParamAlias[], key: string, round: number): string {
  for (let i = 0; i < list.length; i++) {
    const alias: ParamAlias = list[i];
    if (alias.current !== key) {
      continue;
    }
    if (round > alias.legacy.length) {
      return '';
    }
    return alias.legacy[round - 1];
  }
  return key;
}

/** 会话列表的 args 载荷（参数形态由生成上表决定，禁止按方法名猜） */
export function sessionListArgs(body: Object): Object | undefined {
  return buildArgs(SESSION_LIST_ENDPOINT, body);
}

/** 任意 endpoint 的 args 载荷 */
export function argsFor(endpoint: string, body: Object): Object | undefined {
  return buildArgs(endpoint, body);
}

// ─────────────────── 网关边界错误码（上游事实，供上层分支判断） ───────────────────

/**
 * 上游网关的边界错误码。
 *
 * 存在理由：上层（`appstate`）需要**按错误码分支**——例如「控制流被网关拒绝」
 * 与「控制流因网络断开」要区别对待，后者才需要提示用户。
 * 但错误码是上游事实，直接在上层写字面量会违反「上游知识只允许出现在 dshcompat」，
 * 而且上游改码时会**静默失效**（判断永远为假、分支永不触发，且不报错）。
 *
 * 因此在唯一的事实落点导出常量，上层只消费常量。
 * 出处：上游 `dsh-api-gateway` 的 `TypertGatewayErrorCode`（D2 §1.1 已登记该枚举）。
 * 这里只导出**我们真正会分支**的三个，不搬运整个枚举——
 * 未被使用的常量会变成无人维护的噪声。
 */

/** 一元载体上打开了流式端点（调用方错误，绝不重试） */
export const GATEWAY_SIGNATURE_INVALID: string = 'gateway/signature-invalid';
/** 参数名与描述符不符（调用方错误，绝不重试） */
export const GATEWAY_ARGUMENTS_INVALID: string = 'gateway/arguments-invalid';
/** 参数值未通过边界校验（调用方错误，绝不重试） */
export const GATEWAY_INPUT_INVALID: string = 'gateway/input-invalid';

/**
 * 诊断页「协议旁路日志」的演示行。
 *
 * 放在兼容面而不是 UI：这些行展示的是**上游端点名**，
 * 属于上游知识；UI 不得自行拼写（D5 §1 架构约束）。
 * 接入真实连接后由连接层的 trace 记录替换。
 */
export function demoTraceLines(): string[] {
  return [
    `rpc  ${MODEL_CATALOG_ENDPOINT}  41ms  ok`,
    `rpc  ${PLUGIN_INVENTORY_ENDPOINT}  168ms  ok`,
    `rpc  ${SETTINGS_DESCRIBE_ENDPOINT}  10ms  ok`,
    'ws   frame item (128B)  stream=events',
    'ws   frame ready  clientId=…'
  ];
}
