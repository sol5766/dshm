/**
 * 上游漂移门禁（回答「方便适配今后 DSH 上游升级」的核心机制）。
 *
 * 做什么：
 *   1. 用 protocol-contract.mjs 的同一套提取逻辑，对**当前环境里的上游**重新生成端点上表；
 *   2. 与仓库中已提交的 `dshcompat/src/main/ets/Endpoints.ets` 逐条比对；
 *   3. 输出精确差异（新增 / 删除 / 参数形状变化 / 流式标记变化 / 参数名变化）；
 *   4. 有差异时以非零码退出，形成 CI 门禁。
 *
 * 使用场景：
 *   - 日常：升级本机 dsh 后跑一次，看上游改了什么；
 *    . 升级前：在干净 checkout 上跑，决定是否要把新版本纳入受支持矩阵；
 *   - CI：每次改动 dshcompat 或上游版本时自动跑。
 *
 * 用法：
 *   node tools/protocol-contract.mjs --json .research/protocol/contracts.json
 *   node tools/compat-drift.mjs            # 只报告，不修改文件
 *   node tools/compat-drift.mjs --update   # 有差异时给出重新生成的命令提示（不自动改）
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
/**
 * 契约数据来源。
 *
 * 默认用当前环境提取的 `contracts.json`；可用 `DSH_CONTRACTS` 指向**任意版本**的提取结果，
 * 这样同一个门禁既能做「本机是否漂移」，也能做「0.1.2 → 0.1.5 差了什么」的版本间比对——
 * 升级评估阶段需要的正是后者。
 */
const CONTRACTS = process.env.DSH_CONTRACTS
  ?? join(ROOT, '.research', 'protocol', 'contracts.json');
const COMMITTED = join(ROOT, 'dshcompat', 'src', 'main', 'ets', 'Endpoints.ets');
const DSH_NM = process.env.DSH_NODE_MODULES
  ?? 'C:\\Users\\aotian\\AppData\\Roaming\\io.github.hairyf.deepseek-harness-desktop\\dependencies\\dsh\\node_modules';

if (!existsSync(CONTRACTS)) {
  console.error(`缺少契约数据：${CONTRACTS}`);
  console.error('请先运行：node tools/protocol-contract.mjs --json .research/protocol/contracts.json');
  process.exit(2);
}
if (!existsSync(COMMITTED)) {
  console.error(`缺少已提交的端点上表：${COMMITTED}`);
  process.exit(2);
}

/**
 * 读取已提交的上表。
 *
 * 实现说明：**不要**用「按固定字段顺序匹配整行」的正则——生成物字段顺序或缩进一变就会
 * 静默解析出 0 条，门禁随即变成一个永远说「无漂移」的假门（本项目第一次实现就踩了这个坑，
 * 用注入式负测试发现）。正确做法是括号配对的块扫描 + 块内逐字段提取。
 */
function parseCommitted() {
  const text = readFileSync(COMMITTED, 'utf8');
  const identity = {
    corePackage: (text.match(/corePackage:\s*'([^']*)'/) ?? [, 'unknown'])[1],
    capturedAt: (text.match(/capturedAt:\s*'([^']*)'/) ?? [, ''])[1],
    endpointCount: Number((text.match(/endpointCount:\s*(\d+)/) ?? [, '0'])[1])
  };

  const anchor = text.indexOf('export const DSH_ENDPOINTS');
  const start = text.indexOf('[', anchor);
  const end = text.indexOf('\n];', start);
  if (anchor < 0 || start < 0 || end < 0) {
    throw new Error('无法定位 DSH_ENDPOINTS 数组，生成物格式可能已变化');
  }
  const body = text.slice(start + 1, end);

  // 括号配对的块扫描（对象内无嵌套对象，但保留通用实现以防将来出现）
  const blocks = [];
  let depth = 0;
  let begin = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{') {
      if (depth === 0) begin = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && begin >= 0) {
        blocks.push(body.slice(begin, i + 1));
        begin = -1;
      }
    }
  }

  const fieldStr = (block, key) => (block.match(new RegExp(`${key}:\\s*'([^']*)'`)) ?? [, ''])[1];
  const fieldBool = (block, key) => (block.match(new RegExp(`${key}:\\s*(true|false)`)) ?? [, 'false'])[1] === 'true';
  const fieldShape = (block) => (block.match(/shape:\s*ArgsShape\.(\w+)/) ?? [, ''])[1];
  const fieldParams = (block) => {
    const raw = (block.match(/params:\s*\[([^\]]*)\]/) ?? [, ''])[1].trim();
    return raw === '' ? [] : raw.split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  };

  const entries = blocks.map((b) => ({
    id: fieldStr(b, 'id'),
    ns: fieldStr(b, 'ns'),
    method: fieldStr(b, 'method'),
    shape: fieldShape(b),
    params: fieldParams(b),
    stream: fieldBool(b, 'stream'),
    cancellable: fieldBool(b, 'cancellable')
  }));

  // 解析自检：块数与声明的端点数必须一致，否则门禁不可信
  if (identity.endpointCount > 0 && entries.length !== identity.endpointCount) {
    throw new Error(`解析自检失败：块数 ${entries.length} != 声明的 endpointCount ${identity.endpointCount}`);
  }
  if (entries.some((e) => e.ns === '' || e.method === '' || e.shape === '')) {
    throw new Error('解析自检失败：存在字段缺失的条目，生成物格式可能已变化');
  }

  return { identity, entries };
}

/** 从当前环境的上游契约推导期望值（与 gen-compat-endpoints.mjs 保持同一规则） */
function expectedFromContracts() {
  const contracts = JSON.parse(readFileSync(CONTRACTS, 'utf8'));
  const shapeOf = (params) => {
    if (params.length === 0) return 'NONE';
    // 线上名（wire）而非上游 TS 形参名（name）：见 gen-compat-endpoints.mjs 的 shapeOf 说明。
    // 影响面：84 个端点里有 30 个的 `name` 与 `wire` **不同**（最典型的是 Agent 作用域端点：
    // 形参 `agent` / 线上 `agentId`）。在这 30 个端点上，按 `name` 比对会让门禁
    // **看不见真正的线上改名**——而线上改名正是会让客户端收到 `gateway/arguments-invalid`
    // 的那一类变更。用 `wire` 比对后，门禁检出的才是客户端真正会撞上的差异。
    const names = params.map((p) => p.wire);
    if (names.length === 1 && names[0] === 'request') return 'REQUEST';
    if (names.length === 1 && names[0] === '_request') return 'UNDERSCORE_REQUEST';
    return 'NAMED';
  };
  return contracts
    .map((d) => ({
      id: d.id,
      ns: d.namespace,
      method: d.method,
      shape: shapeOf(d.params),
      params: d.params.map((p) => p.wire),
      stream: d.kind === 'stream',
      cancellable: d.cancellable === true
    }))
    .sort((a, b) => `${a.ns}/${a.method}`.localeCompare(`${b.ns}/${b.method}`));
}

/**
 * 被比对的那份契约所对应的核心包版本。
 *
 * 优先级：显式声明 > 契约自描述元数据 > 当前环境安装的 dsh。
 * 顺序很重要：为了评估新版本，我们会把契约指向别的安装目录；
 * 此时若回落到「当前环境」，报告的版本号就会张冠李戴。
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
    // 无元数据（旧格式契约）时回落到环境探测
  }
  try {
    const pkg = JSON.parse(readFileSync(join(DSH_NM, '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const committed = parseCommitted();
const expected = expectedFromContracts();

const committedByKey = new Map(committed.entries.map((e) => [`${e.ns}/${e.method}`, e]));
const expectedByKey = new Map(expected.map((e) => [`${e.ns}/${e.method}`, e]));

const added = expected.filter((e) => !committedByKey.has(`${e.ns}/${e.method}`));
const removed = committed.entries.filter((e) => !expectedByKey.has(`${e.ns}/${e.method}`));
const changed = [];
for (const e of expected) {
  const c = committedByKey.get(`${e.ns}/${e.method}`);
  if (!c) continue;
  const diffs = [];
  if (c.shape !== e.shape) diffs.push(`shape ${c.shape} → ${e.shape}`);
  if (c.stream !== e.stream) diffs.push(`stream ${c.stream} → ${e.stream}`);
  if (c.cancellable !== e.cancellable) diffs.push(`cancellable ${c.cancellable} → ${e.cancellable}`);
  if (c.params.join(',') !== e.params.join(',')) diffs.push(`params [${c.params.join(',')}] → [${e.params.join(',')}]`);
  if (c.id !== e.id) diffs.push(`id ${c.id} → ${e.id}`);
  if (diffs.length > 0) changed.push({ key: `${e.ns}/${e.method}`, diffs });
}

const hostVersion = coreVersion();
const drift = added.length + removed.length + changed.length;

console.log('# DSH 上游漂移报告\n');
console.log(`当前环境核心包      : @deepseek-ai/dsh ${hostVersion}`);
console.log(`已提交基线核心包    : ${committed.identity.corePackage}`);
console.log(`已提交基线采集时间  : ${(readFileSync(COMMITTED, 'utf8').match(/capturedAt:\s*'([^']*)'/) ?? [, ''])[1]}`);
console.log(`端点数量            : 期望 ${expected.length} / 基线 ${committed.entries.length}`);
console.log('');

if (drift === 0) {
  console.log('✅ 无漂移：当前上游与已提交的兼容面上表一致。');
  process.exit(0);
}

console.log(`⚠️  检测到 ${drift} 处漂移\n`);

if (added.length > 0) {
  console.log(`## 上游新增端点（${added.length}）`);
  for (const e of added) {
    console.log(`  + ${e.ns}/${e.method}  shape=${e.shape} stream=${e.stream} cancellable=${e.cancellable}`);
  }
  console.log('');
}
if (removed.length > 0) {
  console.log(`## 上游移除端点（${removed.length}）— 这些调用会返回 HTTP 404`);
  for (const e of removed) {
    console.log(`  - ${e.ns}/${e.method}  shape=${e.shape}`);
  }
  console.log('');
}
if (changed.length > 0) {
  console.log(`## 契约变化（${changed.length}）— 参数形状/流式标记变化会导致调用失败`);
  for (const c of changed) {
    console.log(`  ~ ${c.key}`);
    for (const d of c.diffs) console.log(`      ${d}`);
  }
  console.log('');
}

console.log('## 处置步骤');
console.log('  1. 逐条判断：是上游改契约，还是我们尚未接入的新能力；');
console.log('  2. 更新能力映射（tools/gen-compat-endpoints.mjs 的 CAPABILITIES）与受支持矩阵');
console.log('     （dshcompat/src/main/ets/CompatIndex.ets 的 SUPPORTED_VERSIONS）；');
console.log('  3. 重新生成上表并据此调整兼容面：');
console.log('       node tools/gen-compat-endpoints.mjs');
console.log('  4. 重跑协议实测，更新 docs/10-协议兼容事实基线.md 的 §8 附录；');
console.log('  5. 本报告的差异条目应逐条落入提交说明，便于回溯。');

process.exit(1);
