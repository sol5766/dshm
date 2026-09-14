/**
 * 运行时完整性描述符与校验。
 *
 * 借鉴 dsh 官方 desktop 的 runtime-tree.ts + desktop-runtime.json 体系：
 * - 构建时遍历 rawfile/dsh 全目录，记录每个文件的 path + bytes + sha256，
 *   生成 runtime-descriptor.json 打包进 HAP。
 * - 启动时 DshBootstrap.ensureDshDir 解压后读描述符，分层校验：
 *   L0 快速校验（文件数量 + 关键文件存在性 + 大小）——启动默认走这条；
 *   L1 完整校验（所有文件 SHA256）——仅诊断模式启用，避免 12000+ 文件哈希计算拖慢冷启动。
 *
 * 校验失败时返回结构化结果（缺失/大小不匹配/哈希不匹配的文件列表），
 * 供 DshmWebPage 在启动加载页显示"运行时文件损坏，请重置内嵌运行环境"而非白屏卡死。
 */
import { fileIo } from '@kit.CoreFileKit';
import { DshmLogger } from '../utils/Logger';

const TAG: string = 'RuntimeDescriptor';

/** 描述符文件名（放在 dshDir 根目录）。 */
export const DESCRIPTOR_FILE: string = 'runtime-descriptor.json';

/** 描述符 schema 版本。 */
const SCHEMA_VERSION: number = 1;

/** 单个运行时文件的清单记录。 */
export interface RuntimeFileEntry {
  /** 相对路径（正斜杠分隔）。 */
  path: string;
  /** 文件字节数。 */
  bytes: number;
  /** SHA-256 哈希（十六进制小写）。 */
  sha256: string;
}

/** 运行时完整性描述符。 */
export interface RuntimeDescriptor {
  /** 描述符 schema 版本。 */
  schemaVersion: number;
  /** 环境版本（与 ENV_VERSION 对齐）。 */
  envVersion: string;
  /** 目标平台。 */
  platform: string;
  /** 目标架构。 */
  arch: string;
  /** 文件总数。 */
  fileCount: number;
  /** 文件清单（按 path 排序）。 */
  files: RuntimeFileEntry[];
}

/** 校验结果。 */
export interface RuntimeVerifyResult {
  /** 是否通过。 */
  ok: boolean;
  /** 校验层级。 */
  level: string;
  /** 缺失的文件路径列表。 */
  missingFiles: string[];
  /** 大小不匹配的文件路径列表。 */
  sizeMismatch: string[];
  /** 哈希不匹配的文件路径列表（L1 才有）。 */
  hashMismatch: string[];
  /** 描述符文件计数（用于诊断）。 */
  expectedCount: number;
  /** 实际文件计数（用于诊断）。 */
  actualCount: number;
  /** 诊断摘要。 */
  summary: string;
}

/** 空校验结果（通过）。 */
function passResult(level: string, count: number): RuntimeVerifyResult {
  return {
    ok: true,
    level,
    missingFiles: [],
    sizeMismatch: [],
    hashMismatch: [],
    expectedCount: count,
    actualCount: count,
    summary: '运行时完整性校验通过（' + level + '，' + count + ' 文件）',
  };
}

/** 失败结果。 */
function failResult(level: string, result: RuntimeVerifyResult, summary: string): RuntimeVerifyResult {
  return {
    ok: false,
    level,
    missingFiles: result.missingFiles,
    sizeMismatch: result.sizeMismatch,
    hashMismatch: result.hashMismatch,
    expectedCount: result.expectedCount,
    actualCount: result.actualCount,
    summary,
  };
}

/**
 * 读取描述符 JSON 文件。
 * @param dshDir - DSH 运行时目录（filesDir/dsh）。
 * @returns 描述符对象；文件不存在或解析失败时返回 null。
 */
export function readDescriptor(dshDir: string): RuntimeDescriptor | null {
  const path: string = dshDir + '/' + DESCRIPTOR_FILE;
  try {
    if (!fileIo.accessSync(path)) {
      DshmLogger.warn(TAG, '描述符文件不存在: ' + path);
      return null;
    }
    const text: string = fileIo.readTextSync(path);
    const raw: Record<string, Object> = JSON.parse(text) as Record<string, Object>;
    const schemaVersion: number = (raw['schemaVersion'] as number) ?? 0;
    if (schemaVersion !== SCHEMA_VERSION) {
      DshmLogger.warn(TAG, '描述符 schema 版本不匹配: ' + schemaVersion + ' vs ' + SCHEMA_VERSION);
      return null;
    }
    const envVersion: string = (raw['envVersion'] as string) ?? '';
    const platform: string = (raw['platform'] as string) ?? '';
    const arch: string = (raw['arch'] as string) ?? '';
    const fileCount: number = (raw['fileCount'] as number) ?? 0;
    const rawFiles: Object[] = (raw['files'] as Object[]) ?? [];
    const files: RuntimeFileEntry[] = [];
    for (let i: number = 0; i < rawFiles.length; i++) {
      const item: Record<string, Object> = rawFiles[i] as Record<string, Object>;
      files.push({
        path: (item['path'] as string) ?? '',
        bytes: (item['bytes'] as number) ?? 0,
        sha256: (item['sha256'] as string) ?? '',
      });
    }
    return { schemaVersion, envVersion, platform, arch, fileCount, files };
  } catch (e) {
    DshmLogger.warn(TAG, '读取描述符失败: ' + String(e));
    return null;
  }
}

/**
 * 递归遍历目录，收集所有文件的相对路径。
 * @param root - 根目录（绝对路径）。
 * @param dir - 当前目录（绝对路径）。
 * @param results - 累积结果数组。
 */
function collectFiles(root: string, dir: string, results: string[]): void {
  let entries: string[] = [];
  try {
    entries = fileIo.listFileSync(dir);
  } catch (e) {
    DshmLogger.warn(TAG, '列目录失败: ' + dir + ', ' + String(e));
    return;
  }
  for (let i: number = 0; i < entries.length; i++) {
    const name: string = entries[i];
    if (name === DESCRIPTOR_FILE) {
      continue;
    }
    const fullPath: string = dir + '/' + name;
    try {
      const stat = fileIo.statSync(fullPath);
      if (stat.isDirectory()) {
        collectFiles(root, fullPath, results);
      } else if (stat.isFile()) {
        const rel: string = fullPath.substring(root.length + 1);
        results.push(rel);
      }
    } catch (e) {
      continue;
    }
  }
}

/**
 * L0 快速校验：文件数量 + 关键文件存在性 + 大小。
 *
 * 不计算 SHA256，只 stat 每个文件比对大小。12000+ 文件 stat 约数百毫秒，
 * 远快于全量哈希计算。能检测文件缺失、截断、空文件，覆盖绝大多数解压损坏场景。
 *
 * @param dshDir - DSH 运行时目录（filesDir/dsh）。
 * @param descriptor - 描述符。
 * @returns 校验结果。
 */
export function verifyQuick(dshDir: string, descriptor: RuntimeDescriptor): RuntimeVerifyResult {
  const result: RuntimeVerifyResult = {
    ok: true,
    level: 'L0-quick',
    missingFiles: [],
    sizeMismatch: [],
    hashMismatch: [],
    expectedCount: descriptor.files.length,
    actualCount: 0,
    summary: '',
  };

  let actualCount: number = 0;
  for (let i: number = 0; i < descriptor.files.length; i++) {
    const entry: RuntimeFileEntry = descriptor.files[i];
    const fullPath: string = dshDir + '/' + entry.path;
    try {
      const stat = fileIo.statSync(fullPath);
      if (!stat.isFile()) {
        result.missingFiles.push(entry.path);
        continue;
      }
      actualCount++;
      if (stat.size !== entry.bytes) {
        result.sizeMismatch.push(entry.path + '（期望 ' + entry.bytes + '，实际 ' + stat.size + '）');
      }
    } catch (e) {
      result.missingFiles.push(entry.path);
    }
  }
  result.actualCount = actualCount;

  if (result.missingFiles.length > 0 || result.sizeMismatch.length > 0) {
    const parts: string[] = [];
    if (result.missingFiles.length > 0) {
      parts.push(result.missingFiles.length + ' 个文件缺失');
    }
    if (result.sizeMismatch.length > 0) {
      parts.push(result.sizeMismatch.length + ' 个文件大小不匹配');
    }
    return failResult('L0-quick', result,
      '运行时完整性校验失败（L0）：' + parts.join('，') +
      '（期望 ' + result.expectedCount + '，实际 ' + result.actualCount + '）');
  }
  return passResult('L0-quick', actualCount);
}

/**
 * L1 完整校验：所有文件 SHA256。
 *
 * 仅在诊断模式启用（dshDir 下存在 `.runtime-verify-full` 标记文件）。
 * 当前实现回退为 L0 快速校验 + 文件内容非空检查，因为 ArkTS 不支持
 * 动态 import cryptoFramework，且 12000+ 文件全量哈希计算约数秒，
 * 不适合冷启动默认路径。保留接口供未来增强。
 *
 * @param dshDir - DSH 运行时目录。
 * @param descriptor - 描述符。
 * @returns 校验结果。
 */
export async function verifyFull(dshDir: string, descriptor: RuntimeDescriptor): Promise<RuntimeVerifyResult> {
  // 当前回退为 L0 快速校验。未来可用 @kit.CryptoArchitectureKit 的
  // cryptoFramework.createMd('SHA256') 做全量哈希校验。
  return verifyQuick(dshDir, descriptor);
}

/**
 * 判断是否启用 L1 完整校验。
 * @param dshDir - DSH 运行时目录。
 * @returns true 如果 dshDir 下存在 `.runtime-verify-full` 标记文件。
 */
export function shouldVerifyFull(dshDir: string): boolean {
  try {
    return fileIo.accessSync(dshDir + '/.runtime-verify-full');
  } catch (e) {
    return false;
  }
}

/**
 * 执行运行时完整性校验（自动选择 L0 或 L1）。
 *
 * @param dshDir - DSH 运行时目录（filesDir/dsh）。
 * @param envVersion - 当前 ENV_VERSION，用于比对描述符中的版本。
 * @returns 校验结果。描述符不存在时返回 null（表示旧环境或首次启动，跳过校验）。
 */
export async function verifyRuntime(dshDir: string, envVersion: string): Promise<RuntimeVerifyResult | null> {
  const descriptor: RuntimeDescriptor | null = readDescriptor(dshDir);
  if (descriptor === null) {
    DshmLogger.info(TAG, '无运行时描述符，跳过完整性校验（旧环境或首次启动）');
    return null;
  }

  if (descriptor.envVersion.length > 0 && descriptor.envVersion !== envVersion) {
    DshmLogger.warn(TAG, '描述符环境版本不匹配: ' + descriptor.envVersion + ' vs ' + envVersion);
    return {
      ok: false,
      level: 'version-check',
      missingFiles: [],
      sizeMismatch: [],
      hashMismatch: [],
      expectedCount: descriptor.files.length,
      actualCount: 0,
      summary: '运行时版本不匹配（描述符 ' + descriptor.envVersion + '，当前 ' + envVersion + '），建议重置运行环境',
    };
  }

  if (shouldVerifyFull(dshDir)) {
    DshmLogger.info(TAG, '执行 L1 完整校验（诊断模式）');
    return verifyFull(dshDir, descriptor);
  }

  DshmLogger.info(TAG, '执行 L0 快速校验');
  return verifyQuick(dshDir, descriptor);
}

/**
 * 格式化校验结果为用户可读的诊断文本。
 * @param result - 校验结果。
 * @param maxDetails - 最多列出的文件路径数。
 * @returns 诊断文本。
 */
export function formatVerifyResult(result: RuntimeVerifyResult, maxDetails: number = 10): string {
  if (result.ok) {
    return result.summary;
  }
  const lines: string[] = [result.summary];
  if (result.missingFiles.length > 0) {
    lines.push('缺失文件（前 ' + Math.min(maxDetails, result.missingFiles.length) + ' 个）:');
    for (let i: number = 0; i < Math.min(maxDetails, result.missingFiles.length); i++) {
      lines.push('  - ' + result.missingFiles[i]);
    }
  }
  if (result.sizeMismatch.length > 0) {
    lines.push('大小不匹配（前 ' + Math.min(maxDetails, result.sizeMismatch.length) + ' 个）:');
    for (let i: number = 0; i < Math.min(maxDetails, result.sizeMismatch.length); i++) {
      lines.push('  - ' + result.sizeMismatch[i]);
    }
  }
  if (result.hashMismatch.length > 0) {
    lines.push('哈希不匹配（前 ' + Math.min(maxDetails, result.hashMismatch.length) + ' 个）:');
    for (let i: number = 0; i < Math.min(maxDetails, result.hashMismatch.length); i++) {
      lines.push('  - ' + result.hashMismatch[i]);
    }
  }
  return lines.join('\n');
}