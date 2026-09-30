/**
 * 从协议契约数据生成 DSH 兼容面的端点上表（ArkTS 源）。
 *
 * 输入：tools/protocol-contract.mjs 产出的 contracts.json
 * 输出：dshcompat/src/main/ets/Endpoints.ets
 *
 * 为什么生成而不是手写：74 个端点、参数形态与可否取消都必须与上游生成描述符一致，
 * 手写必然漂移。生成物提交进仓库，漂移由 tools/compat-drift.mjs 的门禁检测。
 *
 * 用法：
 *   node tools/protocol-contract.mjs --json .research/protocol/contracts.json
 *   node tools/gen-compat-endpoints.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = process.cwd();
/**
 * 契约数据来源。
 *
 * 默认取当前环境提取结果；升级评估时用 `DSH_CONTRACTS` 指向**目标版本**的提取结果，
 * 配合 `DSH_VERSION` 声明版本号，即可在不动本机 dsh 安装的前提下生成新版本上表。
 */
const CONTRACTS = process.env.DSH_CONTRACTS
  ?? join(ROOT, '.research', 'protocol', 'contracts.json');
const OUT = join(ROOT, 'dshcompat', 'src', 'main', 'ets', 'Endpoints.ets');
const DSH_NM = process.env.DSH_NODE_MODULES
  ?? join(homedir(), 'AppData', 'Roaming', 'io.github.hairyf.deepseek-harness-desktop',
    'dependencies', 'dsh', 'node_modules');

/**
 * 生成物所标注的核心包版本与采集时间。
 *
 * 优先读契约的**自描述元数据**（`<contracts>.meta.json`）：生成物要如实地说明
 * 「我是从哪个版本采集来的」。靠环境探测在跨版本生成时必然标错版本号，
 * 而版本号是受支持矩阵与漂移判定的依据，标错会直接误导升级决策。
 */
function coreVersion() {
  if (process.env.DSH_VERSION) {
    return process.env.DSH_VERSION;
  }
  try {
    const meta = JSON.parse(readFileSync(`${CONTRACTS}.meta.json`, 'utf8'));
    if (meta.corePackage) {
      return meta.corePackage;
    }
  } catch {
    // 无元数据时回落到环境探测
  }
  try {
    const pkg = JSON.parse(readFileSync(join(DSH_NM, '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 采集时间：优先用契约记录的采集时刻，保证生成物与契约同源可溯。 */
function capturedAt() {
  try {
    const meta = JSON.parse(readFileSync(`${CONTRACTS}.meta.json`, 'utf8'));
    if (meta.capturedAt) {
      return meta.capturedAt;
    }
  } catch {
    // 无元数据则用当前时间
  }
  return new Date().toISOString();
}

/** 能力映射：产品功能 → 必需/可选端点（缺省端点归入未引用集合） */
const CAPABILITIES = [
  {
    id: 'sessions', label: '会话',
    requires: ['session/list', 'session/create', 'session/prompt', 'session/follow'],
    optional: ['session/page', 'session/search', 'session/rename', 'session/cancel', 'session/fork',
      'session/updateQueue', 'session/modelCatalog', 'session/selectModel'],
    missingHint: '该 Host 未提供会话读写端点，无法收发对话'
  },
  {
    // 【映射说明】审批与提问**不走** `session/control`：
    //   该流只承载 baseline / queue / jobs / projection 四态（见 D2 §8.7.4）。
    //   审批与提问通过网关 `$events` 的 waterfall 帧到达，应答走 `$events/result`——
    //   这两个都是网关内部端点，**不在业务端点上表里**，因此无法用 endpoints 表达依赖。
    //   结论：本能力的可用性无法由「端点上表探测」判定，只能由事件流是否就绪判定
    //   （`SessionHub.eventsReady`）。把 `session/control` 列为必需曾是错的。
    id: 'approvals', label: '审批与提问',
    requires: [],
    optional: ['session/control', 'session/prompt'],
    missingHint: '审批与提问依赖网关转发事件流（$events / $events/result），需确认事件流已就绪'
  },
  {
    id: 'workspaces', label: '工作区与文件',
    requires: ['session/canOpenWorkspacePath'],
    optional: ['workspace/create', 'workspace/rename', 'workspace/delete', 'workspace/follow',
      'directoryPicker/list', 'directoryPicker/pick', 'directoryPicker/createDirectory'],
    missingHint: '该 Host 未提供工作区端点，无法管理目录'
  },
  {
    // 0.1.5-rc.1 新增命名空间：真正的工作区文件读写。
    // 在此之前我们的文件树只能靠桩数据——D2 §8.6 记的「workspace/list 不存在」就是这条缺口。
    //
    // 【2026-09-25 rc.2 同步】`workspaceFiles/readAll` 与 `readRelated` **已从上游移除**
    // （rc.1 时就不在了；提交基线停在 0.1.5-rc.2，所以漂移报告才把它们列为"移除"）。
    // 替代路径：`readBytes`（rc.2 起参数由 `range` 改为 `options`，仍能整读）。
    // 故把它们从 optional 里摘掉——**能力的可用性判据不该包含不存在的端点**，
    // 否则该能力在**任何** rc.1/rc.2 Host 上都会恒报 missing（假降级）。
    // `readBytes` 保留（它才是实际能用的那条）。
    id: 'workspaceFiles', label: '工作区文件',
    requires: [],
    optional: ['workspaceFiles/list', 'workspaceFiles/stat', 'workspaceFiles/read',
      'workspaceFiles/readBytes', 'workspaceFiles/changes'],
    missingHint: '该 Host 未提供工作区文件端点，文件树与预览将不可用（不影响会话与审批）'
  },
  {
    id: 'fileUploads', label: '附件上传',
    requires: [],
    optional: ['fileUploads/upload'],
    missingHint: '该 Host 未提供附件上传端点，无法投喂本机文件'
  },
  {
    id: 'sessionFeedback', label: '会话反馈',
    requires: [],
    optional: ['sessionFeedback/record'],
    missingHint: '该 Host 未提供会话反馈端点，反馈入口将隐藏'
  },
  {
    // 【2026-09-25 rc.2 同步】`agentPresets/{copy,deletePreset}` **已从上游移除**
    // （rc.1 时就不在了）。上游把「预设注册表」拆成了只读的 registry
    // （`dsh-agent-preset-registry` 提供 list/read/select），写入口径另行演进
    // ⇒ 当前**没有**「复制/删除自定义预设」的端点可用。
    // 侧效应（已核实）：`SessionHub.copyAgentPreset`/`deleteAgentPreset` 会走
    // `argsFor()` 返回 undefined 的分支 → 如实返回 `contract.missing`，
    // **不崩、不静默**（这是既有的优雅降级路径，本次无需改调用代码）。
    id: 'agentPresets', label: 'Agent 预设',
    requires: ['agentPresets/list'],
    optional: ['agentPresets/read', 'agentPresets/select'],
    missingHint: '该 Host 未提供 Agent 预设端点'
  },
  {
    id: 'settings', label: '设置与模型',
    requires: ['settings/describe'],
    optional: ['settings/update', 'settings/replace', 'settings/mutate', 'session/modelCatalog'],
    missingHint: '该 Host 未提供设置端点，设置页不可用'
  },
  {
    id: 'credentials', label: '凭据',
    requires: ['credentials/describe'],
    optional: ['credentials/set', 'credentials/unset'],
    missingHint: '该 Host 未提供凭据端点'
  },
  {
    id: 'plugins', label: '插件',
    requires: ['pluginInventory/list'],
    optional: [],
    missingHint: '该 Host 未提供插件清单端点'
  },
  {
    id: 'goals', label: '目标',
    requires: [],
    optional: ['goals/create', 'goals/edit', 'goals/pause', 'goals/resume', 'goals/complete', 'goals/clear',
      'goals/get'],
    missingHint: '该 Host 未提供目标端点'
  },
  {
    // 【2026-09-25 rc.2 同步】`subagents/list` **已从上游移除**（rc.1 时就不在了）。
    // 剩下的 `prompt` / `interruptByParent` 才是现行面。
    id: 'subagents', label: '子代理',
    requires: [],
    optional: ['subagents/prompt', 'subagents/interruptByParent'],
    missingHint: '该 Host 未提供子代理端点'
  },
  {
    id: 'commands', label: '斜杠命令',
    requires: [],
    optional: ['commands/list', 'commands/execute'],
    missingHint: '该 Host 未提供命令端点'
  },
  {
    id: 'skills', label: '技能',
    requires: [],
    optional: ['skills/list'],
    missingHint: '该 Host 未提供技能目录端点'
  },
  {
    id: 'llm', label: '模型发现',
    requires: [],
    optional: ['llm/listProviders', 'llm/listConfigurableProviders', 'llm/discoverModels'],
    missingHint: '该 Host 未提供模型发现端点'
  }
];

const contracts = JSON.parse(readFileSync(CONTRACTS, 'utf8'));

/**
 * 推断参数形态。
 *
 * **必须用 `wire` 名而不是 `name`**：`protocol-contract.mjs` 提取的是成对的
 * `{name, wire}`，其中 `name` 是上游 TypeScript 形参名，`wire` 才是**线上字段名**。
 * 二者在 30 个端点上不同（最典型的是 Agent 作用域端点：形参叫 `agent`，线上叫 `agentId`）。
 * 用 `name` 生成的上表会让客户端按错名字构造 `args`，直接得到 `gateway/arguments-invalid`。
 * 这个缺陷在仓库里潜伏了很久没被发现，因为当时没有任何代码去读上表的 `params` 字段。
 */
function shapeOf(params) {
  if (params.length === 0) return 'ArgsShape.NONE';
  const names = params.map((p) => p.wire);
  if (names.length === 1 && names[0] === 'request') return 'ArgsShape.REQUEST';
  if (names.length === 1 && names[0] === '_request') return 'ArgsShape.UNDERSCORE_REQUEST';
  return 'ArgsShape.NAMED';
}

/**
 * endpoint → 能力 id 集合。
 * 一个端点被多个能力引用是**合法**的（例如 session/prompt 同时属于「会话」与「审批与提问」），
 * 因此这里记录集合而不是单值；DshEndpoint.capability 取排序后的第一个作为「主归属」，
 * 需要完整归属时用 CompatIndex.capabilitiesOf(endpoint)。
 */
const capabilityOf = new Map();
for (const cap of CAPABILITIES) {
  for (const e of [...cap.requires, ...cap.optional]) {
    const set = capabilityOf.get(e) ?? new Set();
    if (set.has(cap.id) === false && cap.requires.includes(e) === false && cap.optional.includes(e) === false) {
      throw new Error(`内部错误：端点在能力 ${cap.id} 中重复声明`);
    }
    set.add(cap.id);
    capabilityOf.set(e, set);
  }
}

const entries = contracts
  .map((d) => {
    const caps = [...(capabilityOf.get(`${d.namespace}/${d.method}`) ?? new Set())].sort();
    return {
      id: d.id,
      ns: d.namespace,
      method: d.method,
      shape: shapeOf(d.params),
      // 线上名（wire），不是上游 TS 形参名（name）——见 shapeOf 的说明
      params: d.params.map((p) => p.wire),
      stream: d.kind === 'stream',
      cancellable: d.cancellable === true,
      source: d.source ?? '',
      capability: caps.length > 0 ? caps[0] : '',
      capabilities: caps
    };
  })
  .sort((a, b) => `${a.ns}/${a.method}`.localeCompare(`${b.ns}/${b.method}`));

// 校验：能力表引用的端点必须都真实存在（否则是能力表写错，不是上游变化）
const known = new Set(entries.map((e) => `${e.ns}/${e.method}`));
for (const cap of CAPABILITIES) {
  for (const e of [...cap.requires, ...cap.optional]) {
    if (!known.has(e)) console.warn(`WARN 能力 ${cap.id} 引用了不存在的端点 ${e}（将出现在 missing 中）`);
  }
}

const lines = [];
lines.push('/**');
lines.push(' * 【自动生成，请勿手改】DSH 上游端点上表。');
lines.push(' *');
lines.push(' * 生成方式：');
lines.push(' *   node tools/protocol-contract.mjs --json .research/protocol/contracts.json');
lines.push(' *   node tools/gen-compat-endpoints.mjs');
lines.push(' * 漂移检测：node tools/compat-drift.mjs（对当前安装/checkout 的上游重新提取并比对）');
lines.push(' *');
lines.push(` * 采集对象：@deepseek-ai/dsh ${coreVersion()} · ${entries.length} 个 endpoint`);
lines.push(' */');
lines.push('');
lines.push("import { ArgsShape, DshCapability, DshEndpoint, UpstreamIdentity } from './CompatTypes';");
lines.push('');
lines.push(`export const UPSTREAM_IDENTITY: UpstreamIdentity = {`);
lines.push(`  corePackage: '${coreVersion()}',`);
lines.push(`  capturedAt: '${capturedAt()}',`);
lines.push(`  endpointCount: ${entries.length}`);
lines.push('};');
lines.push('');
lines.push('/** 全部 endpoint 调用契约（按 endpoint 名排序） */');
lines.push('export const DSH_ENDPOINTS: DshEndpoint[] = [');
for (const e of entries) {
  const params = e.params.length === 0 ? '[]' : `[${e.params.map((p) => `'${p}'`).join(', ')}]`;
  lines.push('  {');
  lines.push(`    id: '${e.id}',`);
  lines.push(`    ns: '${e.ns}',`);
  lines.push(`    method: '${e.method}',`);
  lines.push(`    shape: ${e.shape},`);
  lines.push(`    params: ${params},`);
  lines.push(`    stream: ${e.stream},`);
  lines.push(`    cancellable: ${e.cancellable},`);
  lines.push(`    source: '${e.source}',`);
  lines.push(`    capability: '${e.capability}',`);
  lines.push(`    capabilities: [${e.capabilities.map((c) => `'${c}'`).join(', ')}]`);
  lines.push('  },');
}
lines.push('];');
lines.push('');
lines.push('/** 能力映射：产品功能 → 必需/可选端点（用于启动探测与入口置灰） */');
lines.push('export const DSH_CAPABILITIES: DshCapability[] = [');
for (const cap of CAPABILITIES) {
  const req = cap.requires.length === 0 ? '[]' : `[${cap.requires.map((e) => `'${e}'`).join(', ')}]`;
  const opt = cap.optional.length === 0 ? '[]' : `[${cap.optional.map((e) => `'${e}'`).join(', ')}]`;
  lines.push('  {');
  lines.push(`    id: '${cap.id}',`);
  lines.push(`    label: '${cap.label}',`);
  lines.push(`    requires: ${req},`);
  lines.push(`    optional: ${opt},`);
  lines.push(`    missingHint: '${cap.missingHint}'`);
  lines.push('  },');
}
lines.push('];');
lines.push('');

writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`已生成 ${OUT}`);
console.log(`  端点 ${entries.length} 个；其中流式 ${entries.filter((e) => e.stream).length} 个`);
console.log(`  能力 ${CAPABILITIES.length} 个；未被能力引用的端点 ${entries.filter((e) => e.capability === '').length} 个`);
