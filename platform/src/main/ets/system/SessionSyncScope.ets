/**
 * 会话同步的**本地清单与打包**（docs/298 §4 的 P2，纯离线部分）。
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────
 * 不管最后用哪个云端，同步前都必须先回答两个问题：
 *   ① **要同步哪些文件**（会话清单）；
 *   ② **怎么把它们打包成一个可校验、可续传的单元**。
 * 这一层**不联网、不认识 Drive**：它只产出清单与归档，让上层去传。
 *
 * ── 数据形态（核心树实测，`dsh-session-persistence-jsonl`）──────────────
 * ```text
 * <sessionsRoot>/
 *   --<cwd 编码>--/                 ← projectKey(cwd)，见下
 *     <sessionId>/                  ← encodeSegment(id)，一个会话一个目录
 *       <vN>.jsonl.zstd             ← 不可变代际日志（可能有多代）
 * ```
 * `projectKey` 的编码规则（源码逐字）：`/ \ :` → `-`（连续折叠成一个），
 * `[A-Za-z0-9._-]` 原样，其他字符 → `~XXXX`（4 位大写十六进制），
 * 首尾包 `--`，总长上限 251。
 *
 * ── 三条硬纪律 ────────────────────────────────────────────────────────
 * 1. **只扫描、不写入**本模块不修改任何会话文件（同步的"恢复"是 P4，另写）。
 * 2. **排除面显式**：`cache` / `cores` / 临时文件一律不进清单 —— 这是数据量
 *    与"别把 350 MB 核心树传上去"的安全线，必须有门禁钉住。
 * 3. **不猜路径**：`sessionsRoot` 由调用方传（端侧是 `$DSH_HOME/sessions`）。
 *
 * @module platform/system/SessionSyncScope
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';

/**
 * 一个会话代际文件（一个会话可能有多个代际）。
 *
 * 【为什么要记 `version`】上游格式代际是**不可变**的（v0→v4 已有五个迁移包）；
 * 跨端恢复时必须知道"这是哪一代"，否则会把新格式塞给老核心。
 */
export interface SessionGeneration {
  /** 代际号（文件名里的 `vN`；v0 无编号，记 0） */
  version: number;
  /** 文件绝对路径 */
  path: string;
  /** 字节数（用于打包前的体量预估与传输进度） */
  bytes: number;
}

/** 一个会话（= 一个目录）。 */
export interface SessionEntry {
  /** 会话 id（目录名，已按上游 encodeSegment 处理） */
  id: string;
  /** 所属工作区目录名（projectKey 形态，`--…--`） */
  projectKey: string;
  /** 该会话的所有代际，按 version 升序 */
  generations: SessionGeneration[];
  /** 该会话总字节数 */
  bytes: number;
}

/** 一次扫描的结果。 */
export interface SyncManifest {
  /** 扫描根（绝对路径） */
  root: string;
  /** 所有会话（按 projectKey + id 排序，保证**同样输入产出同样顺序**） */
  sessions: SessionEntry[];
  /** 会话总数 */
  sessionCount: number;
  /** 总会话字节数 */
  totalBytes: number;
  /** 扫描中被跳过的条目（**要能解释**，不能静默丢弃） */
  skipped: string[];
}

/**
 * 从代际文件名解析版本号（与上游 `parseSessionFormatLogFilename` 同口径）。
 *
 * 规则（源码逐字的反向）：v0 是**纯后缀名**（`session.v0` 那段没有 `vN`），
 * 之后每一代带小写 `vN`。非规范名（临时文件、大写、前导零）**不算**已提交代际。
 *
 * @returns 版本号；不是规范代际文件名时返回 -1
 */
export function generationVersionOf(filename: string): number {
  const name: string = String(filename === undefined || filename === null ? '' : filename);
  /*
   * 与上游 `CANONICAL_LOG_FILENAME` **逐字同款**的判据（源码原样）：
   *     /^session(?:\.v([1-9][0-9]*))?\.jsonl$/u
   * 即：v0 = `session.jsonl`；vN = `session.vN.jsonl`，N **不允许前导零**（`v01` 非规范）。
   * 先把物理压缩后缀剥掉，再按同一形状匹配。
   */
  let stem: string = '';
  if (name.endsWith('.jsonl.zstd')) {
    stem = name.slice(0, name.length - '.jsonl.zstd'.length);
  } else if (name.endsWith('.jsonl')) {
    stem = name.slice(0, name.length - '.jsonl'.length);
  } else {
    return -1;
  }
  if (stem === 'session') {
    return 0;
  }
  const m = new RegExp('^session\\.v([1-9][0-9]*)$').exec(stem);
  if (m === null) {
    return -1;
  }
  const v: number = Number(m[1]);
  return Number.isSafeInteger(v) ? v : -1;
}

/** 目录/文件名是否是本模块**绝不**碰的那几类（排除面集中在一处）。 */
export function isExcludedName(name: string): boolean {
  const n: string = String(name ?? '');
  if (n.length === 0) {
    return true;
  }
  /* 临时/中间产物：上游用 tmp + rename 原子落位，这些不该被当成会话 */
  if (n.endsWith('.tmp') || n.endsWith('.stale') || n.startsWith('.dsh-mkdir-')) {
    return true;
  }
  /* 明确的三条排除线（cache / cores / 沙箱工作区） */
  if (n === 'cache' || n === 'cores' || n === 'node_modules') {
    return true;
  }
  return false;
}

/** 列目录（失败返回空数组而不是抛：扫描要"能扫多少扫多少"）。 */
function listDir(dir: string): string[] {
  try {
    return fs.listFileSync(dir);
  } catch (e) {
    return [];
  }
}

/**
 * 扫描 `sessionsRoot`，产出同步清单。
 *
 * @param sessionsRoot 会话根目录（端侧 `$DSH_HOME/sessions`）
 * @returns 清单；根不可读时 `sessions` 为空且 `skipped` 带原因
 */
export function buildManifest(sessionsRoot: string): SyncManifest {
  const root: string = String(sessionsRoot ?? '').trim();
  const manifest: SyncManifest = {
    root: root,
    sessions: [],
    sessionCount: 0,
    totalBytes: 0,
    skipped: []
  };
  if (root.length === 0) {
    manifest.skipped.push('sessionsRoot 为空');
    return manifest;
  }
  try {
    if (!fs.accessSync(root)) {
      manifest.skipped.push(`sessions 根不存在：${root}`);
      return manifest;
    }
  } catch (e) {
    manifest.skipped.push(`sessions 根不可访问：${root}`);
    return manifest;
  }

  const projectKeys: string[] = listDir(root);
  for (let i: number = 0; i < projectKeys.length; i++) {
    const pk: string = projectKeys[i];
    if (isExcludedName(pk)) {
      manifest.skipped.push(`跳过 ${pk}（排除面）`);
      continue;
    }
    /* 只认 `--…--` 形态的工作区目录；其它一律记跳过原因，不静默忽略 */
    if (!pk.startsWith('--') || !pk.endsWith('--')) {
      manifest.skipped.push(`跳过 ${pk}（不是工作区目录形态）`);
      continue;
    }
    const pkPath: string = `${root}/${pk}`;
    const sessionIds: string[] = listDir(pkPath);
    for (let j: number = 0; j < sessionIds.length; j++) {
      const sid: string = sessionIds[j];
      if (isExcludedName(sid)) {
        manifest.skipped.push(`跳过 ${pk}/${sid}（排除面）`);
        continue;
      }
      const sidPath: string = `${pkPath}/${sid}`;
      const files: string[] = listDir(sidPath);
      const gens: SessionGeneration[] = [];
      let sessionBytes: number = 0;
      for (let k: number = 0; k < files.length; k++) {
        const f: string = files[k];
        const version: number = generationVersionOf(f);
        if (version < 0) {
          continue; // 不是规范代际文件：不记入，也不报错（会话目录里可能有别的产物）
        }
        const full: string = `${sidPath}/${f}`;
        let bytes: number = 0;
        try {
          bytes = fs.statSync(full).size;
        } catch (e) {
          manifest.skipped.push(`跳过 ${pk}/${sid}/${f}（stat 失败）`);
          continue;
        }
        gens.push({ version: version, path: full, bytes: bytes });
        sessionBytes += bytes;
      }
      if (gens.length === 0) {
        manifest.skipped.push(`跳过 ${pk}/${sid}（没有规范代际文件）`);
        continue;
      }
      /* 代际升序：恢复时按顺序重放才是对的 */
      gens.sort((a: SessionGeneration, b: SessionGeneration) => a.version - b.version);
      manifest.sessions.push({
        id: sid,
        projectKey: pk,
        generations: gens,
        bytes: sessionBytes
      });
      manifest.sessionCount += 1;
      manifest.totalBytes += sessionBytes;
    }
  }
  /*
   * 【为什么排序】"同样输入产出同样清单"是 P2 的验收判据之一：
   * 不排序时 `listFileSync` 的顺序不稳定，两次扫描 diff 会假阳性。
   */
  manifest.sessions.sort((a: SessionEntry, b: SessionEntry) => {
    const ka: string = `${a.projectKey}/${a.id}`;
    const kb: string = `${b.projectKey}/${b.id}`;
    return ka < kb ? -1 : (ka > kb ? 1 : 0);
  });
  return manifest;
}

/**
 * 把清单转成**可存储、可 diff** 的纯 JSON 形态。
 *
 * 【为什么单独一层】清单要写进云端索引（`index.json`）与本地状态；
 * 结构一变，云端旧索引就解析不了。这一层把"对外形状"钉死，内部结构随便改。
 */
/**
 * 清单里的一代（对外形状）。
 * 【为什么单独立接口】ArkTS 禁止"对象字面量当类型声明"
 * （`arkts-no-obj-literals-as-types`）—— 内联 `Array<{…}>` 会直接编译失败。
 */
export interface ManifestGeneration {
  version: number;
  bytes: number;
}

/** 清单里的一个会话（对外形状；**不含绝对路径**）。 */
export interface ManifestSession {
  id: string;
  projectKey: string;
  bytes: number;
  generations: ManifestGeneration[];
}

export interface ManifestJson {
  schema: number;
  root: string;
  sessionCount: number;
  totalBytes: number;
  sessions: ManifestSession[];
}

/** 当前清单 JSON 的 schema 号。**改形状必须 +1**，好让旧索引能被识别。 */
export const MANIFEST_SCHEMA: number = 1;

/** 清单 → 对外 JSON（**不含绝对路径**：云端索引里不该出现本机路径）。 */
export function toManifestJson(manifest: SyncManifest): ManifestJson {
  const out: ManifestJson = {
    schema: MANIFEST_SCHEMA,
    root: '',
    sessionCount: manifest.sessionCount,
    totalBytes: manifest.totalBytes,
    sessions: []
  };
  for (let i: number = 0; i < manifest.sessions.length; i++) {
    const s: SessionEntry = manifest.sessions[i];
    const gens: ManifestGeneration[] = [];
    for (let j: number = 0; j < s.generations.length; j++) {
      const g: ManifestGeneration = { version: s.generations[j].version, bytes: s.generations[j].bytes };
      gens.push(g);
    }
    const row: ManifestSession = { id: s.id, projectKey: s.projectKey, bytes: s.bytes, generations: gens };
    out.sessions.push(row);
  }
  return out;
}

/**
 * 清单里**某个会话**的相对落点（用于拼云端路径）。
 *
 * 形态：`<projectKey>/<sessionId>/<vN>.jsonl.zstd`
 * —— 刻意与原目录结构一致，恢复时可原样还原。
 */
export function relativePathOf(projectKey: string, sessionId: string, version: number): string {
  /* 与上游 `sessionFormatLogFilename` 同形，再加物理压缩后缀 `.zstd` */
  const suffix: string = version === 0 ? 'session.jsonl.zstd' : `session.v${version}.jsonl.zstd`;
  return `${projectKey}/${sessionId}/${suffix}`;
}
