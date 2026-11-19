/**
 * 同步规划器：把**本机真实数据**转成可上传的 unit 计划（docs/313 §1、批次 B）。
 *
 * ── 职责边界 ───────────────────────────────────────────────────────────
 * 它回答"**要传什么**"，不负责"怎么传"（SyncStore）也不负责"界面怎么显示"。
 * 输入是本机的会话树与 profile，输出是一份 `UnitPlan[]`，每项带来源路径与类型。
 *
 * ── 三条纪律（每条都有过代价）──────────────────────────────────────────
 * 1. **排除面显式**：`cache` / `cores` / `node_modules` / 临时文件一律不进计划。
 *    核心树有 143 MB，误传既浪费流量又会破坏对方设备的运行环境（docs/309）。
 * 2. **工作区用稳定 ID**：会话目录名是 `projectKey(cwd)`，含本机绝对路径。
 *    直接当 ID 会跨端错位，所以**用其摘要**生成 `workspaceId`（docs/301 §6.1）。
 * 3. **不读、不传凭据**：`.credentials.yaml` 等一律排除，且该判断独立成函数，
 *    便于门禁单独钉住。
 *
 * @module sync/SyncPlanner
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { buildManifest, SessionEntry, SessionGeneration, SyncManifest } from '../system/SessionSyncScope';
import { makeUnitId, UnitKind } from './SyncModel';

/** 一个待处理单元的来源描述（**只在内存里用**，不写进云端）。 */
export interface UnitPlan {
  unitId: string;
  kind: UnitKind;
  workspaceId: string;
  sessionId: string;
  version: number;
  /** 本机源文件绝对路径（上传时读它；云端不保存这个字段） */
  sourcePath: string;
  /** 资产文件名（导入时用来还原，不含路径） */
  assetName: string;
  /** 给人看的显示名 */
  displayName: string;
  bytes: number;
}

/** 计划结果。 */
export interface PlanResult {
  plans: UnitPlan[];
  /** 被跳过的条目与原因（**必须可解释**，不能静默丢） */
  skipped: string[];
  /** 工作区列表：workspaceId ↔ 本机 projectKey（供映射 UI 用） */
  workspaces: WorkspaceRef[];
}

/** 工作区引用：稳定 ID 与本机目录的对应关系。 */
export interface WorkspaceRef {
  workspaceId: string;
  /** 本机 sessions 下的目录名（含路径编码，仅本机可见） */
  projectKey: string;
  /** 给人看的名字（取编码里最后一段可读部分） */
  displayName: string;
}

/**
 * 由 projectKey 生成**稳定、跨端可比**的 workspaceId。
 *
 * 【为什么用哈希而不是原名】`projectKey` 是 `--storage-Users-xxx-project--` 这种
 * 含本机绝对路径的编码：同一台机器可用，换一台用户名不同就完全变了。
 * 取摘要后：同一 cwd 在同一设备上稳定，不同设备间也能作为"不同工作区"区分。
 *
 * 【算法】FNV-1a 32 位 + 长度后缀，输出 `ws-<8hex>`。
 * 不用加密哈希：这里的目标是**稳定标识**，不是防碰撞攻击；碰撞概率对本地工作区足够低。
 */
export function workspaceIdOf(projectKey: string): string {
  const s: string = String(projectKey === undefined || projectKey === null ? '' : projectKey);
  let h: number = 0x811c9dc5;
  for (let i: number = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    /* FNV 素数 16777619，用位运算保持 32 位 */
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  const hex: string = h.toString(16).padStart(8, '0');
  return `ws-${hex}`;
}

/**
 * 从 projectKey 里取一个**给人看**的名字。
 *
 * 编码形如 `--storage-Users-currentUser-data-DSHM-deveco-workspace--`，
 * 取最后一段可读部分（`DSHM-deveco-workspace`）作为显示名。
 * 取不到就退回 `工作区`，**不显示完整路径**（那是本机信息）。
 */
export function displayNameOf(projectKey: string): string {
  const s: string = String(projectKey === undefined || projectKey === null ? '' : projectKey).trim();
  const inner: string = s.replace(/^-+/, '').replace(/-+$/, '');
  if (inner.length === 0) {
    return '工作区';
  }
  const parts: string[] = inner.split('-').filter((p: string) => p.length > 0);
  if (parts.length === 0) {
    return '工作区';
  }
  /* 末段通常就是目录名；取最后 3 段够可读又不长 */
  const tail: string[] = parts.slice(Math.max(0, parts.length - 3));
  return tail.join('-').slice(0, 48);
}

/**
 * 判断一个路径/文件名是否属于**绝不同步**的那一类。
 *
 * 【为什么集中在一处】这个判断同时被"扫描会话"和"生成计划"用到；
 * 两处各写一份必然走样（历史教训：`check-session-sync-scope` 就是这么来的）。
 */
export function isExcludedPath(name: string): boolean {
  const n: string = String(name === undefined || name === null ? '' : name);
  if (n.length === 0) {
    return true;
  }
  /* 凭据：任何形态都不许上传 */
  if (n === '.credentials.yaml' || n.endsWith('.credentials.yaml')
    || n === '.credentials' || n.endsWith('p12') || n.endsWith('.pfx')) {
    return true;
  }
  /* 可重建/运行时产物 */
  if (n === 'cache' || n === 'cores' || n === 'node_modules'
    || n === 'session_projcache' || n === 'cost-meter' || n === 'shots') {
    return true;
  }
  /* 临时文件 */
  if (n.endsWith('.tmp') || n.endsWith('.stale') || n.startsWith('.dsh-mkdir-')) {
    return true;
  }
  return false;
}

/**
 * 扫描会话树，生成会话类单元计划。
 *
 * @param sessionsRoot `$DSH_HOME/sessions`
 */
export function planSessions(sessionsRoot: string): PlanResult {
  const out: PlanResult = { plans: [], skipped: [], workspaces: [] };
  const root: string = String(sessionsRoot === undefined || sessionsRoot === null ? '' : sessionsRoot).trim();
  if (root.length === 0) {
    out.skipped.push('会话根目录为空');
    return out;
  }
  if (isExcludedPath(root.split('/').pop() ?? '')) {
    out.skipped.push('会话根目录命中排除面');
    return out;
  }
  let manifest: SyncManifest;
  try {
    manifest = buildManifest(root);
  } catch (e) {
    out.skipped.push('扫描会话树失败');
    return out;
  }
  for (let i: number = 0; i < manifest.sessions.length; i++) {
    const entry: SessionEntry = manifest.sessions[i];
    const pk: string = entry.projectKey;
    if (isExcludedPath(pk)) {
      out.skipped.push(`跳过 ${pk}（排除面）`);
      continue;
    }
    const wsId: string = workspaceIdOf(pk);
    out.workspaces.push({
      workspaceId: wsId,
      projectKey: pk,
      displayName: displayNameOf(pk)
    });
    for (let g: number = 0; g < entry.generations.length; g++) {
      const gen: SessionGeneration = entry.generations[g];
      if (isExcludedPath(gen.path)) {
        out.skipped.push(`跳过 ${entry.id}/${gen.version}（排除面）`);
        continue;
      }
      /*
       * 【unitId 的关键段】同一会话的不同代际**各是一个单元**。
       * 代际是不可变的：v3 存在不代表 v2 可以被覆盖，所以 key 必须带 version。
       */
      const key: string = `${entry.id}:v${gen.version}`;
      out.plans.push({
        unitId: makeUnitId(UnitKind.SESSION, wsId, key),
        kind: UnitKind.SESSION,
        workspaceId: wsId,
        sessionId: entry.id,
        version: gen.version,
        sourcePath: gen.path,
        /* 资产文件名：会话 id + 代际，导入时可还原成上游的规范文件名 */
        assetName: `${entry.id}-v${gen.version}.jsonl.zstd`,
        displayName: `${entry.id.slice(0, 24)} · v${gen.version}`,
        bytes: gen.bytes
      });
    }
  }
  return out;
}

/**
 * 扫描附件目录，生成附件类单元计划。
 *
 * 【为什么附件也要同步】会话里的图片/文件若不在，换设备后会话全是死链。
 *
 * 附件是**内容寻址**的（目录名就是 sha256 前缀），所以 unitId 直接用内容哈希：
 * 同一份内容天然只传一次。
 */
export function planAttachments(attachmentsRoot: string): PlanResult {
  const out: PlanResult = { plans: [], skipped: [], workspaces: [] };
  const root: string = String(attachmentsRoot === undefined ? '' : attachmentsRoot).trim();
  if (root.length === 0) {
    out.skipped.push('附件目录为空');
    return out;
  }
  try {
    if (!fs.accessSync(root)) {
      out.skipped.push('附件目录不存在');
      return out;
    }
  } catch (e) {
    out.skipped.push('附件目录不可访问');
    return out;
  }
  /* 附件是全局的（不属于某个工作区），统一挂 global */
  collectFiles(root, root, out, UnitKind.ATTACHMENT, 0);
  return out;
}

/**
 * 递归收集文件并生成计划（附件/技能共用）。
 *
 * 【为什么限深度】附件目录可能很深；限制层数既防炸栈，也防把意外的深层噪声带进来。
 */
function collectFiles(root: string, dir: string, out: PlanResult, kind: UnitKind,
  depth: number): void {
  if (depth > 6) {
    out.skipped.push(`目录过深，跳过：${dir.slice(root.length)}`);
    return;
  }
  let names: string[] = [];
  try {
    names = fs.listFileSync(dir);
  } catch (e) {
    out.skipped.push(`无法列目录：${dir.slice(root.length)}`);
    return;
  }
  for (let i: number = 0; i < names.length; i++) {
    const name: string = names[i];
    if (isExcludedPath(name)) {
      continue;
    }
    const full: string = `${dir}/${name}`;
    let isDir: boolean = false;
    let size: number = 0;
    try {
      const st: fs.Stat = fs.statSync(full);
      isDir = st.isDirectory();
      size = st.size;
    } catch (e) {
      out.skipped.push(`无法 stat：${name}`);
      continue;
    }
    if (isDir) {
      collectFiles(root, full, out, kind, depth + 1);
      continue;
    }
    /* 相对路径作为 key，保证跨端一致（不含本机前缀） */
    const rel: string = full.slice(root.length + 1);
    out.plans.push({
      unitId: makeUnitId(kind, 'global', rel),
      kind: kind,
      workspaceId: 'global',
      sessionId: '',
      version: 0,
      sourcePath: full,
      assetName: rel.replace(/\//g, '_'),
      displayName: rel.slice(-48),
      bytes: size
    });
  }
}

/**
 * 扫描技能目录（`$DSH_HOME/skills`，都是 md 小文件）。
 */
export function planSkills(skillsRoot: string): PlanResult {
  const out: PlanResult = { plans: [], skipped: [], workspaces: [] };
  const root: string = String(skillsRoot === undefined ? '' : skillsRoot).trim();
  if (root.length === 0) {
    out.skipped.push('技能目录为空');
    return out;
  }
  try {
    if (!fs.accessSync(root)) {
      out.skipped.push('技能目录不存在');
      return out;
    }
  } catch (e) {
    out.skipped.push('技能目录不可访问');
    return out;
  }
  collectFiles(root, root, out, UnitKind.SKILL, 0);
  return out;
}

/** 合并多份计划。 */
export function mergePlans(parts: PlanResult[]): PlanResult {
  const out: PlanResult = { plans: [], skipped: [], workspaces: [] };
  for (let i: number = 0; i < parts.length; i++) {
    const p: PlanResult = parts[i];
    for (let j: number = 0; j < p.plans.length; j++) {
      out.plans.push(p.plans[j]);
    }
    for (let j: number = 0; j < p.skipped.length; j++) {
      out.skipped.push(p.skipped[j]);
    }
    for (let j: number = 0; j < p.workspaces.length; j++) {
      /* 工作区去重：同一 wsId 只保留一条 */
      const w: WorkspaceRef = p.workspaces[j];
      let seen: boolean = false;
      for (let k: number = 0; k < out.workspaces.length; k++) {
        if (out.workspaces[k].workspaceId === w.workspaceId) {
          seen = true;
          break;
        }
      }
      if (!seen) {
        out.workspaces.push(w);
      }
    }
  }
  /* 稳定排序：同样输入产出同样顺序（否则每次同步都"发现变更"） */
  out.plans.sort((a: UnitPlan, b: UnitPlan) => a.unitId < b.unitId ? -1 : (a.unitId > b.unitId ? 1 : 0));
  return out;
}
