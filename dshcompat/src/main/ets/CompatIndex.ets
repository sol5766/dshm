/**
 * 兼容面解析逻辑：由端点上表 + 探测表推导「某能力是否可用」与「参数怎么构造」。
 *
 * 这是把「上游知识」转化为「产品行为」的**唯一**转换点：
 *   - 入口置灰依据：`evaluateCapability()`
 *   - 参数构造依据：`buildArgs()`
 *   - 版本判定依据：`checkVersion()`
 * UI 与状态层只消费本文件的结果，不直接读 DSH_ENDPOINTS。
 */

import {
  ArgsShape,
  CapabilityState,
  DshCapability,
  DshEndpoint,
  EndpointProbe,
  ProbeTable
} from './CompatTypes';
import { DSH_CAPABILITIES, DSH_ENDPOINTS, UPSTREAM_IDENTITY } from './Endpoints';

/** 版本判定结论 */
export enum VersionVerdict {
  /** 在受支持矩阵内 */
  SUPPORTED = 'supported',
  /** 未验证但可继续（提示用户） */
  UNVERIFIED = 'unverified',
  /** 明确不兼容（缺少协议骨架） */
  INCOMPATIBLE = 'incompatible'
}

/** 版本判定结果 */
export interface VersionCheck {
  verdict: VersionVerdict;
  /** 用户可见说明 */
  message: string;
  /** 建议 */
  advice: string;
}

/**
 * 受支持矩阵（D1 §11.4）。
 *
 * 升级流程：改这里 + 重跑基线工具 + 重跑漂移门禁。
 * 值语义：supported = 已验证；unverified = 允许连接但提示；其余视为不兼容。
 *
 * 记录（D5 升级手册第 3 步）：
 *   0.1.2-rc.1 —— 首个基线（74 端点，2026-09-10 实测）
 *   0.1.5-rc.1 —— 跨 0.1.3 / 0.1.5 两条线后的新基线（84 端点）。
 *                 差异：新增 workspaceFiles/*（7）、fileUploads/upload、goals/get、
 *                 sessionFeedback/record；commands/execute 的 images → submittedAttachments。
 *   0.1.5-rc.2 —— **零协议漂移**（84 端点、参数、流式标记逐条一致；
 *                 调用描述符提取结果与 rc.1 **逐字节相同**，1336 个 `.d.ts` 里只有
 *                 8 个 message-feedback 的文件有差异，与我们消费的面无关）。
 *                 因此这里直接纳入矩阵，不需要任何代码或能力映射改动。
 *                 证据：D2 §8.7.18。
 *   同时保留 0.1.2-rc.1：老 Host 仍可用，缺的端点由能力探测降级为入口置灰。
 *   0.1.7-rc.1 —— 端侧首个自建核心树的基线（125 端点）。
 *                 相对 0.1.5-rc.2（84 端点）：**+58 / −7**，另有若干契约变化：
 *                 · 新增 `account/*`、`job/*`、`pluginManager/*`、`schedule/*`、`speech/*`、
 *                   `terminal/*`、`officeToPdf/*` 等命名空间；
 *                 · **移除** `agentPresets/{copy,deletePreset}`、
 *                   `settings/{canOpen,open}AgentPresetDirectory`、`subagents/list`、
 *                   `workspaceFiles/{readAll,readRelated}`；
 *                 · `agentPresets/{list,read,select}` 的**声明包**从 `dsh-agent-presets`
 *                   迁到 `dsh-agent-preset-registry`（端点名未变，调用不受影响）；
 *                 · `workspaceFiles/changes` 增 `path` 参数；
 *                   `workspaceFiles/readBytes` 的 `range` → `options`。
 *   0.1.7-rc.2 —— 端侧当前基线（135 端点）。相对 rc.1：**+10 / −0**，5 处参数形状变化：
 *                 · 新增 `account/{ackBonusNotified,getUnnotifiedBonuses,hasRunningAccountTasks,watchExpiry}`、
 *                   `schedule/{catalog,delete,history,list,update}`、`session/initializeDefaultModel`；
 *                 · `account/{getBalance,getProfile,signOut}` 增 `client`；
 *                   `account/startSignIn` 的 `locale` → `client`；
 *                   `workspace/initializeDefault` 由 `[request]` 变为**无参**。
 *                 ⇒ 这些端点**我方当前均未调用**（见下"影响面"），故本次升级只需
 *                 重生成上表 + 更新矩阵，不必改调用代码。
 *                 证据：`.research/protocol/drift-rc1-to-rc2.txt`。
 *   0.2.0-rc.1 —— 端侧当前基线（138 端点）。相对 0.1.7-rc.2：**+3 / −0**、零契约变化：
 *                 · 新增 `productAnalytics/{enabled,report,watchPolicy}`（后两者其一为
 *                   一元 NAMED、其一为流式，命名空间整体为新包）。
 *                 · 既有 135 个端点**逐条一致**（形状、参数、流式标记、可取消性均无变化）。
 *                 ⇒ `productAnalytics/*` **我方当前未调用**（无对应能力项、无 UI 入口），
 *                 故本次升级只需重生成上表 + 更新矩阵，**不必改调用代码**。
 *                 证据：`.research/protocol/contracts-0.2.0-rc.1.json`（本地取证，
 *                 `.research/` 已被 `.gitignore` 排除）+ `compat-drift` 实跑 exit=1（3 处新增）。
 *   0.2.0-rc.2（140 端点）。相对 0.2.0-rc.1：**+2 / −0**、零契约变化：
 *                 · 新增 `userQuestions/{answer,attachWait}`（前者一元 NAMED、后者流式可取消，
 *                   命名空间整体为新包）。
 *                 · 既有 138 个端点**逐条一致**（形状、参数、流式标记、可取消性均无变化）。
 *                 ⇒ `userQuestions/*` **我方当前未调用**（无对应能力项、无 UI 入口），
 *                 故本次升级只需重生成上表 + 更新矩阵，**不必改调用代码**。
 *                 证据：`.research/protocol/contracts-0.2.0-rc.2.json`（本地取证，
 *                 `.research/` 已被 `.gitignore` 排除）+ `compat-drift` 实跑 exit=1（2 处新增）。
 *   0.2.1-rc.2 —— 端侧当前基线（144 端点）。相对 0.2.1-alpha.4：**零协议漂移**：
 *                 · 端点数量、形状、参数名、流式标记、可取消性与声明包逐条一致。
 *                 · Host / 前端新增 `dsh-web-deepseek-api` 与
 *                   `dsh-client-ui-deepseek-model-label-1017` 两个已挂载的纯 JS 能力，
 *                   但不改变 Remote endpoint 契约，也不需要新增权限或 ArkTS 调用代码。
 *                 证据：`.research/protocol/contracts-0.2.1-rc.2.json`（`endpointCount: 144`）+
 *                 `DSH_CONTRACTS=.research/protocol/contracts.json DSH_VERSION=0.2.1-rc.2
 *                 node tools/compat-drift.mjs` 实跑 exit=0。
 *   0.2.1-alpha.4 —— 前一版端侧基线（144 端点）。相对 0.2.1-alpha.2：**+5 / −3**、其余零契约变化
 *                 （**本仓首次出现「上游移除端点」**）：
 *                 · 新增：`pluginMarket/{listIndexes,search,setIndexes}`（均一元；`search(url,query)`、
 *                   `setIndexes(urls)`）、`remoteAccess/follow`（流式可取消）、`terminal/attach`
 *                   （流式可取消，参数 `agentId` / `id`）。
 *                 · 移除：`terminal/{follow,resize,write}` —— 上游把**终端 API 重设计成单条 `attach`**。
 *                 · 其余 137 个端点**逐条一致**（形状、参数名、流式标记、可取消性、声明包均无变化）。
 *                 ⇒ **我方无需改调用代码**：三个被移除的端点在本仓**只存在于生成的上表里**
 *                   （`dshcompat/src/main/ets/Endpoints.ets` 由生成器产出），`rg` 实查全仓**无手写调用点**；
 *                   五条新增端点也不落在任何能力映射（`tools/gen-compat-endpoints.mjs` 零命中）
 *                   ⇒ 不会有能力因为这次移除被判缺失。
 *                 证据：`.research/protocol/contracts-0.2.1-alpha.4.json`（本地取证；`endpointCount: 144`）
 *                 + `DSH_CONTRACTS=<新契约> node tools/compat-drift.mjs` 实跑 **exit=1（8 处漂移）**，
 *                 刷默认快照 + 重生成上表后 **exit=0**。
 *                 ⚠️ 同时记一条**工具侧**修订：上游自 alpha.3 起换了描述符的发射形状
 *                   （`remoteInfo({ package, methods: { "ns/method": {…} } })`），旧正则解析到 **0 个端点
 *                   却仍静默写盘**；`tools/protocol-contract.mjs` 已补新形状解析（保留旧形状兼容）
 *                   + **0 端点自检**，两棵树实测：alpha.2 → 142、alpha.4 → 144。
 *   0.2.1-alpha.2 —— 前一版端侧基线（142 端点）。相对 0.2.1-alpha.1：**+2 / −0**、零契约变化：
 *                 · 新增 `cotTranslation/{limits,translate}`（均一元、均 cancellable；
 *                   命名空间整体为新包 `dsh-experimental-client-ui-cot-translation`）。
 *                 · 既有 140 个端点**逐条一致**（形状、参数名、流式标记、可取消性、声明包均无变化）。
 *                 ⇒ `cotTranslation/*` **我方当前未调用**（无对应能力项、无 UI 入口），
 *                 故本次升级只需重生成上表 + 更新矩阵，**不必改调用代码**。
 *                 证据：`.research/protocol/contracts-0.2.1-alpha.2.json`（本地取证，
 *                 `.research/` 已被 `.gitignore` 排除；`endpointCount: 142`）+
 *                 `DSH_CONTRACTS=<新契约> DSH_VERSION=0.2.1-alpha.2 node tools/compat-drift.mjs`
 *                 实跑 **exit=1（2 处新增）**，刷默认快照 + 重生成上表后 **exit=0**。
 *   0.2.1-alpha.1（前一版端侧基线，140 端点）。相对 0.2.0-rc.2：**零漂移**——
 *                 · 端点数量不变（140），既有 140 个端点**逐条一致**：形状、参数名、流式标记、
 *                   可取消性、声明包全部相同 ⇒ 上表除版本号与采集时间外**一个字节都没变**。
 *                 · 这是连续第四次「契约层零意外」（0.1.5-rc.2 / 0.2.0-rc.1 / 0.2.0-rc.2 / 本次）。
 *                 ⇒ 本次升级只需重生成上表 + 更新矩阵，**不动任何调用代码与能力映射**。
 *                 证据：`.research/protocol/contracts-0.2.1-alpha.1.json`（本地取证，
 *                 `.research/` 已被 `.gitignore` 排除；`endpointCount: 140`）+
 *                 `DSH_CONTRACTS=<新契约> DSH_VERSION=0.2.1-alpha.1 node tools/compat-drift.mjs`
 *                 实跑 **exit=0「无漂移」**（跨版本比对，未先动默认快照）。
 *   0.2.2-rc.1 —— 历史混收基线（193 端点 / 20 流式 / 15 能力，非权威 remotes 单源口径）。
 *                 2026-11-12 修复采集器后，权威同口径复采为 150 端点 / 16 流式；
 *                 下述 +51 / −2 是旧表汇总差异，不可用于声称 rc.2 移除扩展端点。相对旧上表 144 端点：
 *                 **+51 新增 / −2 移除 / 0 契约变化**（参数形状、流式标记、可取消性逐条未变）。
 *                 新增集中在 forgePanel/*、liveshareShares/*、pluginManager/*、session/observe*、
 *                 toolResults/* 等新能力命名空间，我方均未调用 ⇒ 按"默认不调用"处理，不接新能力。
 *                 移除的 `schedule/delete`、`schedule/update` 全仓只在生成的上表里出现，
 *                 `connection/src`/`appstate/src`/`entry/src` 零调用 ⇒ 无需降级处置；
 *                 `CAPABILITIES` 未引用它们，重生成上表零 WARN。
 *                 证据：`.research/protocol/contracts-0.2.2-rc.1.json`（`endpointCount: 193`，
 *                 2026-11-05 从 `dist/core/work/dsh-core-0.2.2-rc.1+dshm.1` 实采）+
 *                 `DSH_CONTRACTS=<新契约> DSH_VERSION=0.2.2-rc.1 node tools/compat-drift.mjs`
 *                 实跑 **exit=1（53 处漂移）**，刷默认快照（含 `.meta.json`）+ 重生成上表后 **exit=0**。
 *                 ⚠️ 该版本的 `engines.node >= 24.9.0`，端侧已换自建 libnode v24.9.0（docs/365、366）。
 *   0.2.2-rc.2 —— 当前完整多源基线（223 端点 / 22 流式 / 15 能力）。
 *                 2026-11-13 同提取器复采 rc.1=193/20、rc.2=223/22；保留插件扩展。
 *                 下述 150→158 仅是 remotes 子集历史比较，不是完整接口面。
 *                 两版均只采 dsh-api-remotes/lib/client.js 的完整 createTypertRemoteInfo 调用：
 *                 rc.1 150 → rc.2 158，真实 +13 / −5；保留 145 条参数、流式与取消性均不变，
 *                 其中 9 条 account/* 仅声明包改为 dsh-deepseek-account。
 *                 · 新增 account 三条通知端点、agentTeams/setEnabled、mcpManager 三条端点、
 *                   officeKit 两条端点、subagents/interruptByUser、terminal/watch、web/listProviders、
 *                   workspaceFiles/search；officeKit 参数与旧 officeToPdf 对应端点一致。
 *                 · 移除 account/{ackBonusNotified,getUnnotifiedBonuses}、officeToPdf/{generation,render}、
 *                   subagents/interruptByParent；后者由 interruptByUser(childSessionId) 替换。
 *                 · 从历史 193 条表迁移为 +13 / −48，额外 43 条是旧混收扩展声明，
 *                   并非由两版权威源比较证实的上游删除，不可混为一谈。
 *                 · 移除端点在 ArkTS 调用层零命中；子代理能力映射更新为 interruptByUser。
 *                 验证：采集器 35 项自检、生成器 6 项自检、compat-drift 零漂移；仅离线契约验证。
 *                 证据：.research/protocol/drift-0.2.2-rc.1-to-rc.2.json 与两版 authoritative 契约。
 */
const SUPPORTED_VERSIONS: string[] = [
  '0.2.2-rc.4',
  '0.2.2-rc.3',
  '0.2.2-rc.2',
  '0.2.2-rc.1',
  '0.2.1-rc.4',
  '0.2.1-rc.3',
  '0.2.1-rc.2',
  '0.2.1-alpha.4',
  '0.2.1-alpha.2',
  '0.2.1-alpha.1',
  '0.2.0-rc.2',
  '0.2.0-rc.1',
  '0.1.7-rc.2',
  '0.1.7-rc.1',
  '0.1.5-rc.2',
  '0.1.5-rc.1',
  '0.1.2-rc.1'
];

/** 协议骨架端点：缺任一个即视为不兼容（连基本会话都做不了） */
const PROTOCOL_SKELETON: string[] = ['session/list', 'session/create', 'session/prompt'];

/** 上表索引（构造时一次性建立） */
class Index {
  byKey: Map<string, DshEndpoint> = new Map();
  capabilities: Map<string, DshCapability> = new Map();
}

let index: Index | undefined;

function idx(): Index {
  if (index !== undefined) {
    return index;
  }
  const built: Index = new Index();
  for (let i = 0; i < DSH_ENDPOINTS.length; i++) {
    const e: DshEndpoint = DSH_ENDPOINTS[i];
    built.byKey.set(`${e.ns}/${e.method}`, e);
  }
  for (let i = 0; i < DSH_CAPABILITIES.length; i++) {
    const c: DshCapability = DSH_CAPABILITIES[i];
    built.capabilities.set(c.id, c);
  }
  index = built;
  return built;
}

/** 取 endpoint 定义（不存在返回 undefined） */
export function endpointOf(key: string): DshEndpoint | undefined {
  return idx().byKey.get(key);
}

/** 取能力定义 */
export function capabilityOf(id: string): DshCapability | undefined {
  return idx().capabilities.get(id);
}

/** 全部能力 id（供诊断页列出） */
export function allCapabilityIds(): string[] {
  const out: string[] = [];
  for (let i = 0; i < DSH_CAPABILITIES.length; i++) {
    out.push(DSH_CAPABILITIES[i].id);
  }
  return out;
}

/** 上表统计（诊断展示） */
export interface TableStats {
  endpoints: number;
  streamEndpoints: number;
  capabilities: number;
  /** 未被任何能力引用的端点数量（可能是我们尚未接入的功能） */
  unreferenced: number;
}

export function tableStats(): TableStats {
  let stream: number = 0;
  let unreferenced: number = 0;
  for (let i = 0; i < DSH_ENDPOINTS.length; i++) {
    const e: DshEndpoint = DSH_ENDPOINTS[i];
    if (e.stream) {
      stream++;
    }
    if (e.capabilities.length === 0) {
      unreferenced++;
    }
  }
  return {
    endpoints: DSH_ENDPOINTS.length,
    streamEndpoints: stream,
    capabilities: DSH_CAPABILITIES.length,
    unreferenced: unreferenced
  };
}

/** 当前兼容面绑定的上游身份 */
export function upstreamIdentity(): string {
  return UPSTREAM_IDENTITY.corePackage;
}

/** 兼容面采集时间（About/诊断页展示，证明「这份上表是什么时候、从哪个版本采集的」）。 */
export function upstreamCapturedAt(): string {
  return UPSTREAM_IDENTITY.capturedAt;
}

/** 受支持版本的展示文本（About 页用；顺序即优先级）。 */
export function supportedVersionsText(): string {
  return SUPPORTED_VERSIONS.join(' / ');
}

/**
 * 按参数形态构造 `args` 载荷。
 *
 * 这是「不再按方法名猜参数形状」的落点：形状来自生成描述符（D2 §8.6 教训 2）。
 * @param key endpoint（`ns/method`）
 * @param body 业务参数体（按形态装入 request / _request / 展开为具名）
 */
export function buildArgs(key: string, body: Object): Object | undefined {
  const e: DshEndpoint | undefined = endpointOf(key);
  if (e === undefined) {
    return undefined;
  }
  if (e.shape === ArgsShape.NONE) {
    const empty: Record<string, Object> = {};
    return empty as Object;
  }
  if (e.shape === ArgsShape.REQUEST) {
    const wrapped: Record<string, Object> = { 'request': body };
    return wrapped as Object;
  }
  if (e.shape === ArgsShape.UNDERSCORE_REQUEST) {
    const wrapped: Record<string, Object> = { '_request': body };
    return wrapped as Object;
  }
  // NAMED：body 必须已经是具名参数对象，直接使用
  return body;
}

/**
 * 无参调用所需的 args（用于探测）。
 * 仅对 ArgsShape.NONE 的端点返回空对象；其余返回 undefined（不可盲探）。
 */
export function probeArgs(key: string): Object | undefined {
  const e: DshEndpoint | undefined = endpointOf(key);
  if (e === undefined || e.shape !== ArgsShape.NONE) {
    return undefined;
  }
  const empty: Record<string, Object> = {};
  return empty as Object;
}

/**
 * 判定某能力是否可用。
 *
 * 三态语义（避免「未知」被误判成「不可用」）：
 *   - present：探测为 OK
 *   - absent：探测为 HTTP 404（上游确实没有）
 *   - unknown：尚未探测 / 探测失败但端点可能存在
 * 结论：requires 中出现 absent ⇒ 不可用；requires 全部 present 或 unknown ⇒ 可用（unknown 不阻断）。
 */
export function evaluateCapability(id: string, probes: ProbeTable): CapabilityState {
  const cap: DshCapability | undefined = capabilityOf(id);
  if (cap === undefined) {
    return { id: id, available: false, present: [], missing: [], unknown: [], hint: `未知能力 ${id}` };
  }
  const present: string[] = [];
  const missing: string[] = [];
  const unknown: string[] = [];

  for (let i = 0; i < cap.requires.length; i++) {
    classify(cap.requires[i], probes, present, missing, unknown);
  }
  // 可选端点只统计，不影响可用性
  const optionalUnknown: string[] = [];
  for (let i = 0; i < cap.optional.length; i++) {
    classify(cap.optional[i], probes, present, missing, optionalUnknown);
  }

  const available: boolean = missing.length === 0;
  const hint: string = available
    ? ''
    : `${cap.missingHint}（缺少端点：${missing.join('、')}）`;
  return { id: id, available: available, present: present, missing: missing, unknown: unknown, hint: hint };
}

function classify(key: string, probes: ProbeTable, present: string[], missing: string[],
  unknown: string[]): void {
  const state: EndpointProbe | undefined = probes.entries.get(key);
  if (state === EndpointProbe.OK) {
    present.push(key);
    return;
  }
  if (state === EndpointProbe.ABSENT) {
    missing.push(key);
    return;
  }
  unknown.push(key);
}

/**
 * 版本判定。
 * @param hostVersion 从 Host 侧读到的核心包版本（未知时传空串）
 * @param probes 探测表（用于协议骨架判定）
 */
export function checkVersion(hostVersion: string, probes: ProbeTable): VersionCheck {
  // 骨架缺失优先于版本号：版本号可能读不到，但端点缺失是可确定的事实
  const skeletonMissing: string[] = [];
  for (let i = 0; i < PROTOCOL_SKELETON.length; i++) {
    const key: string = PROTOCOL_SKELETON[i];
    if (probes.entries.get(key) === EndpointProbe.ABSENT) {
      skeletonMissing.push(key);
    }
  }
  if (skeletonMissing.length > 0) {
    return {
      verdict: VersionVerdict.INCOMPATIBLE,
      message: `该 Host 缺少协议骨架端点：${skeletonMissing.join('、')}`,
      advice: '这通常意味着 Host 版本过旧或不是 dsh Web 表层。请升级 Host 到受支持版本后重试。'
    };
  }
  if (hostVersion.length === 0) {
    return {
      verdict: VersionVerdict.UNVERIFIED,
      message: '未能读取 Host 版本号',
      advice: `本客户端已验证的上游版本为 ${SUPPORTED_VERSIONS.join('、')}；当前仍可继续使用，功能按端点探测结果降级。`
    };
  }
  for (let i = 0; i < SUPPORTED_VERSIONS.length; i++) {
    if (SUPPORTED_VERSIONS[i] === hostVersion) {
      return {
        verdict: VersionVerdict.SUPPORTED,
        message: `Host 版本 ${hostVersion} 在受支持矩阵内`,
        advice: ''
      };
    }
  }
  return {
    verdict: VersionVerdict.UNVERIFIED,
    message: `Host 版本 ${hostVersion} 未经验证（受支持：${SUPPORTED_VERSIONS.join('、')}）`,
    advice: '可继续使用；若出现功能异常，请先按端点探测结果判断是能力缺失还是协议漂移。'
  };
}

/** 空探测表 */
export function emptyProbeTable(): ProbeTable {
  return { entries: new Map<string, EndpointProbe>(), probedAt: 0 };
}
