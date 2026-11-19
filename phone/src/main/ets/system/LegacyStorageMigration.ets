/**
 * 1.1.4 -> 1.1.6 手机沙箱迁移。
 *
 * 1.1.4 的 phone/tablet/2in1 共用一个名为 `entry` 的 HAP。1.1.6 把手机拆成
 * 独立的 `phone` HAP，因此同一 bundle 下 `context.filesDir` 从：
 *
 *   <el2>/haps/entry/files
 *
 * 变成了：
 *
 *   <el2>/haps/phone/files
 *
 * CoreStore 原本把 `$DSH_HOME=<filesDir>/dsh/home` 当作"跨版本共享"的唯一
 * 用户数据，但这个承诺只在**模块名不变**时成立。手机模块改名后，新目录是空的，
 * 所以会话、工作区注册和插件看起来全丢了；回退 1.1.4 又读回旧的 entry 目录，
 * 数据于是"恢复"。
 *
 * 本迁移只补这两个模块目录之间的断层：
 *   - 复制 `<legacy>/dsh/home`：sessions / profiles / plugins / credentials / 工作区注册；
 *   - 复制 `<legacy>/workspace`：用户在应用沙箱内创建的工作区文件。
 *
 * 纪律：
 *   1. **只复制，不移动、不删除旧目录**。1.1.4 回退路径必须继续可用；
 *   2. 目录合并，同名文件以新目录为准，绝不覆盖 1.1.6 已写入的数据；
 *   3. marker 原子落盘；有任一失败就不写 marker，下次启动可继续补齐；
 *   4. 不复制 host-ready / host-exit-mode / host-stop-request 这类上一个进程的
 *      瞬态控制文件，避免把旧 PID、旧 token 或待退出请求带进新进程。
 */
import fs from '@ohos.file.fs';

const LEGACY_SUFFIX: string = '/haps/entry/files';
const CURRENT_SUFFIX: string = '/haps/phone/files';
const MARKER_NAME: string = 'dshm-legacy-entry-migration.v1.json';

const TRANSIENT_HOME_FILES: string[] = [
  'host-ready.json',
  'host-exit-mode',
  'host-stop-request',
];

export interface LegacyStorageMigrationResult {
  ok: boolean;
  status: string;
  sourceDir: string;
  targetDir: string;
  files: number;
  directories: number;
  bytes: number;
  skippedExisting: number;
  failures: string[];
}

interface CopyStats {
  files: number;
  directories: number;
  bytes: number;
  skippedExisting: number;
  failures: string[];
}

interface MigrationMarker {
  version: number;
  sourceDir: string;
  targetDir: string;
  completedAt: string;
  files: number;
  directories: number;
  bytes: number;
  skippedExisting: number;
}

let activeMigration: Promise<LegacyStorageMigrationResult> | undefined = undefined;

function result(status: string, sourceDir: string, targetDir: string): LegacyStorageMigrationResult {
  return {
    ok: status === 'migrated' || status === 'already-done' || status === 'not-applicable'
      || status === 'legacy-empty',
    status: status,
    sourceDir: sourceDir,
    targetDir: targetDir,
    files: 0,
    directories: 0,
    bytes: 0,
    skippedExisting: 0,
    failures: [],
  };
}

export function initialLegacyStorageMigrationResult(): LegacyStorageMigrationResult {
  return result('not-started', '', '');
}

function legacyFilesDir(current: string): string {
  if (!current.endsWith(CURRENT_SUFFIX)) {
    return '';
  }
  return `${current.substring(0, current.length - CURRENT_SUFFIX.length)}${LEGACY_SUFFIX}`;
}

function isTransientHomeFile(name: string, sourceRoot: string): boolean {
  if (sourceRoot.endsWith('/dsh/home')) {
    return TRANSIENT_HOME_FILES.indexOf(name) >= 0;
  }
  return false;
}

async function copyTree(source: string, target: string, sourceRoot: string,
  stats: CopyStats): Promise<void> {
  try {
    if (!fs.accessSync(target)) {
      fs.mkdirSync(target, true);
      stats.directories += 1;
    }
  } catch (e) {
    stats.failures.push(`建目录失败 ${target}：${String(e)}`);
    return;
  }

  let names: string[] = [];
  try {
    names = fs.listFileSync(source);
  } catch (e) {
    stats.failures.push(`列目录失败 ${source}：${String(e)}`);
    return;
  }

  for (const name of names) {
    if (isTransientHomeFile(name, sourceRoot)) {
      continue;
    }
    const from: string = `${source}/${name}`;
    const to: string = `${target}/${name}`;
    try {
      const stat = fs.statSync(from);
      if (stat.isDirectory()) {
        await copyTree(from, to, sourceRoot, stats);
      } else if (stat.isFile()) {
        if (fs.accessSync(to)) {
          stats.skippedExisting += 1;
          continue;
        }
        await fs.copyFile(from, to);
        stats.files += 1;
        stats.bytes += stat.size;
      }
    } catch (e) {
      stats.failures.push(`复制失败 ${from} -> ${to}：${String(e)}`);
    }
  }
}

function writeMarker(targetDir: string, sourceDir: string, stats: CopyStats): void {
  const marker: MigrationMarker = {
    version: 1,
    sourceDir: sourceDir,
    targetDir: targetDir,
    completedAt: new Date().toISOString(),
    files: stats.files,
    directories: stats.directories,
    bytes: stats.bytes,
    skippedExisting: stats.skippedExisting,
  };
  const tmpPath: string = `${targetDir}/${MARKER_NAME}.tmp`;
  const markerPath: string = `${targetDir}/${MARKER_NAME}`;
  const file: fs.File = fs.openSync(tmpPath,
    fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
  try {
    fs.writeSync(file.fd, JSON.stringify(marker, null, 2));
  } finally {
    fs.closeSync(file);
  }
  fs.renameSync(tmpPath, markerPath);
}

/**
 * 仅对 `.../haps/phone/files` 生效。迁移函数自身绝不 reject，调用方可把它当作
 * Host 启动前的一道可等待栅栏。
 */
export async function migrateLegacyEntryStorage(
  targetFilesDir: string): Promise<LegacyStorageMigrationResult> {
  const sourceFilesDir: string = legacyFilesDir(targetFilesDir);
  if (sourceFilesDir.length === 0) {
    return result('not-applicable', '', targetFilesDir);
  }

  const markerPath: string = `${targetFilesDir}/${MARKER_NAME}`;
  try {
    if (fs.accessSync(markerPath)) {
      return result('already-done', sourceFilesDir, targetFilesDir);
    }
  } catch {
    // 读 marker 失败时仍尝试合并；复制本身是幂等且不覆盖的。
  }

  try {
    if (!fs.accessSync(sourceFilesDir)) {
      return result('legacy-empty', sourceFilesDir, targetFilesDir);
    }
  } catch {
    return result('legacy-empty', sourceFilesDir, targetFilesDir);
  }

  const stats: CopyStats = {
    files: 0,
    directories: 0,
    bytes: 0,
    skippedExisting: 0,
    failures: [],
  };

  const entries: string[] = ['dsh/home', 'workspace'];
  let present: number = 0;
  for (const relative of entries) {
    const from: string = `${sourceFilesDir}/${relative}`;
    let exists: boolean = false;
    try {
      exists = fs.accessSync(from);
    } catch {
      exists = false;
    }
    if (!exists) {
      continue;
    }
    present += 1;
    await copyTree(from, `${targetFilesDir}/${relative}`, from, stats);
  }

  if (present === 0) {
    return result('legacy-empty', sourceFilesDir, targetFilesDir);
  }

  const migrated: LegacyStorageMigrationResult = result(
    stats.failures.length === 0 ? 'migrated' : 'partial', sourceFilesDir, targetFilesDir);
  migrated.ok = stats.failures.length === 0;
  migrated.files = stats.files;
  migrated.directories = stats.directories;
  migrated.bytes = stats.bytes;
  migrated.skippedExisting = stats.skippedExisting;
  migrated.failures = stats.failures;

  if (stats.failures.length === 0) {
    try {
      writeMarker(targetFilesDir, sourceFilesDir, stats);
    } catch (e) {
      migrated.ok = false;
      migrated.status = 'partial';
      migrated.failures.push(`写迁移完成标记失败：${String(e)}`);
    }
  }
  return migrated;
}

/**
 * 同进程只跑一份。specified 多窗会在同一进程创建多个 Ability，若各自复制同一棵树，
 * 会对同名文件产生无意义竞争。
 */
export function ensureLegacyEntryStorageMigration(
  targetFilesDir: string): Promise<LegacyStorageMigrationResult> {
  if (activeMigration === undefined) {
    activeMigration = migrateLegacyEntryStorage(targetFilesDir);
  }
  return activeMigration;
}
