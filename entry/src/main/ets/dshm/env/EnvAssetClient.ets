/**
 * 在线环境预设：manifest 拉取 + 资产 failover 下载（Range 断点续传）+ sha256 校验 + zip 解压。
 *
 * 路线见 docs/plan-lite-env-online.md。目标是替代「pnpm 原地升级」——后者只换依赖树、
 * 不重放构建期鸿蒙适配，实测装上去 boot 时主线程死循环（见 .agent-rules/bug-log.md 2026-09-11）。
 *
 * 设计要点：
 *  - **两层源表**：本文件顶部的 MANIFEST_SOURCES 列 manifest 源；manifest 内列 asset 的多个源。
 *    两层分开是为了换下载源时不必重发 HAP 也能靠 manifest 换资产源。
 *  - **zip 而非 tar.gz**：解压发生在 ArkTS 侧（此时设备上还没有 node），只能用系统 API；
 *    @ohos.zlib 原生支持 zip 解压，tar 无任何系统支持。打包侧 scripts/build-env-asset.mjs。
 *  - **校验清单取自 manifest.sentinels**，与 DshBootstrap.verifyDshSentinel 同源，
 *    避免重演「更新侧能过、启动侧必拒」的不一致。
 *  - **断点续传用 HTTP Range**：失败后按本地已落盘字节数续下；服务端若忽略 Range 返回 200，
 *    则截断重写（不信任 200 响应的偏移）。
 */

import { http } from '@kit.NetworkKit';
import { fileIo, hash } from '@kit.CoreFileKit';
import { zlib } from '@kit.BasicServicesKit';
import { common } from '@kit.AbilityKit';
import { DshmLogger } from '../utils/Logger';

const TAG: string = 'EnvAsset';

/**
 * manifest 源表（按顺序 failover）。
 *
 * ⚠️ `dev-mock` 是开发期联调通道（开发机起静态服务器托管 dist/env，
 *    再用 `hdc rport tcp:18080 tcp:18080` 映射到设备 loopback）。
 *    发布前必须置 false，并实测 GitHub 两条 200 可达（content-length 需与 manifest.size 一致）。
 */
const MANIFEST_SOURCES: string[] = [
  'http://127.0.0.1:18080/manifest.json'
];

/**
 * 发布源（确认可达后替换上面的数组）。
 *
 * 仓库已迁到 GitHub `sol5766/dshm`：资产以 Release 附件发布（tag `env-<version>`）。
 * 注意 `dist/` 在 .gitignore 中，raw 通道取不到 zip，因此只保留 Release 通道；
 * 国内直连不稳时再补 gh-proxy 加速源。
 */
export const RELEASE_MANIFEST_SOURCES: string[] = [
  'https://github.com/sol5766/dshm/releases/download/env-latest/manifest.json'
];

/** manifest 里的引擎信息。 */
export interface EnvAssetEngine {
  node: string;
  platform: string;
  arch: string;
}

/** manifest 里的资产描述。 */
export interface EnvAsset {
  name: string;
  format: string;
  size: number;
  sha256: string;
  entries: number;
  extractTo: string;
  sentinels: string[];
  urls: string[];
}

/** 环境资产 manifest（schema: dsh-env-asset/1）。 */
export interface EnvManifest {
  schema: string;
  version: string;
  engine: EnvAssetEngine;
  generatedAt: string;
  asset: EnvAsset;
}

/** 下载进度回调载荷。 */
export interface EnvDownloadProgress {
  source: string;
  received: number;
  total: number;
  attempt: number;
  phase: string;
}

/** 进度回调。 */
export type EnvProgressFn = (p: EnvDownloadProgress) => void;

const MAX_ATTEMPTS_PER_SOURCE: number = 3;
const CONNECT_TIMEOUT_MS: number = 10000;
const READ_TIMEOUT_MS: number = 120000;

export class EnvAssetClient {
  /** 逐个源拉取 manifest，第一个 schema 合法者胜出。 */
  static async fetchManifest(urls: string[]): Promise<EnvManifest | null> {
    for (let i = 0; i < urls.length; i++) {
      const url: string = urls[i];
      try {
        DshmLogger.info(TAG, '拉取 manifest: ' + url);
        const text: string = await EnvAssetClient.httpGetText(url);
        const m: EnvManifest = JSON.parse(text) as EnvManifest;
        if (m.schema !== 'dsh-env-asset/1' || m.asset === undefined ||
          m.asset.sha256.length !== 64 || m.asset.urls.length === 0) {
          DshmLogger.warn(TAG, 'manifest 非法: ' + url);
          continue;
        }
        DshmLogger.info(TAG, 'manifest OK: v' + m.version + ' / ' + m.asset.name +
          ' / ' + (m.asset.size / 1048576).toFixed(1) + 'MB / ' + m.asset.urls.length + ' 源');
        return m;
      } catch (e) {
        DshmLogger.warn(TAG, '拉取失败 ' + url + ': ' + String(e));
      }
    }
    return null;
  }

  /** 默认源表（开发期为 mock，见文件头说明）。 */
  static defaultSources(): string[] {
    return MANIFEST_SOURCES;
  }

  /**
   * 下载资产：多源 failover + 每源重试（Range 续传）+ sha256 校验。
   * @returns 校验通过的本地文件路径；全部失败返回 null。
   */
  static async downloadAsset(context: common.UIAbilityContext, manifest: EnvManifest,
    onProgress: EnvProgressFn): Promise<string | null> {

    const destDir: string = context.filesDir + '/env-download';
    EnvAssetClient.ensureDir(destDir);
    const destPath: string = destDir + '/' + manifest.asset.name;
    const total: number = manifest.asset.size;

    for (let s = 0; s < manifest.asset.urls.length; s++) {
      const url: string = manifest.asset.urls[s];
      const sourceName: string = EnvAssetClient.sourceLabel(url, s);
      for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_SOURCE; attempt++) {
        let have: number = EnvAssetClient.fileSize(destPath);
        if (have >= total) {
          break;
        }
        try {
          onProgress({ source: sourceName, received: have, total, attempt, phase: '下载中' });
          await EnvAssetClient.downloadOnce(url, destPath, have, total, sourceName, attempt, onProgress);
        } catch (e) {
          DshmLogger.warn(TAG, sourceName + ' 第 ' + attempt + ' 次失败: ' + String(e));
        }
        have = EnvAssetClient.fileSize(destPath);
        if (have >= total) {
          break;
        }
      }
      if (EnvAssetClient.fileSize(destPath) < total) {
        DshmLogger.warn(TAG, sourceName + ' 不完整，换下一个源');
        continue;
      }
      onProgress({ source: sourceName, received: total, total, attempt: 0, phase: '校验 sha256' });
      const actual: string = await hash.hash(destPath, 'sha256');
      if (actual.toLowerCase() === manifest.asset.sha256.toLowerCase()) {
        DshmLogger.info(TAG, '资产校验通过: ' + destPath);
        return destPath;
      }
      DshmLogger.warn(TAG, sourceName + ' sha256 不符，重下');
      EnvAssetClient.removeFile(destPath);
    }
    return null;
  }

  /** 用系统 zlib 解压 zip（OHOS 原生支持 zip；tar 无系统支持）。 */
  static async extractZip(zipPath: string, destDir: string): Promise<void> {
    EnvAssetClient.ensureDir(destDir);
    DshmLogger.info(TAG, '解压 -> ' + destDir);
    await zlib.decompressFile(zipPath, destDir);
    DshmLogger.info(TAG, '解压完成');
  }

  /** 按 manifest.sentinels 校验解压结果，返回缺失项（空数组=通过）。 */
  static missingSentinels(destDir: string, sentinels: string[]): string[] {
    const missing: string[] = [];
    for (let i = 0; i < sentinels.length; i++) {
      const p: string = destDir + '/' + sentinels[i];
      try {
        const st = fileIo.statSync(p);
        if (!st.isFile() || st.size <= 0) {
          missing.push(sentinels[i]);
        }
      } catch (e) {
        missing.push(sentinels[i]);
      }
    }
    return missing;
  }

  // ── 内部 ───────────────────────────────────────────────────────────────────

  /** 单次 GET（带 Range），把响应体写入文件。返回本次落盘字节数。 */
  private static async downloadOnce(url: string, destPath: string, from: number, total: number,
    sourceName: string, attempt: number, onProgress: EnvProgressFn): Promise<number> {

    const client = http.createHttp();
    try {
      const resp = await client.request(url, {
        method: http.RequestMethod.GET,
        header: { 'Range': 'bytes=' + from + '-' },
        expectDataType: http.HttpDataType.ARRAY_BUFFER,
        connectTimeout: CONNECT_TIMEOUT_MS,
        readTimeout: READ_TIMEOUT_MS,
        usingProxy: false
      });
      const code: number = resp.responseCode;
      if (code !== 200 && code !== 206) {
        throw new Error('HTTP ' + code);
      }
      const body: ArrayBuffer = resp.result as ArrayBuffer;
      if (body.byteLength <= 0) {
        return 0;
      }
      // 服务端忽略 Range（返回 200）时必须从头写，不能把整包追加到偏移之后。
      // 注意 openSync 返回 File 对象，writeSync 要的是数字 fd（与 DshBootstrap.writeEnvVersion 一致）。
      if (code === 206 && from > 0) {
        const f = fileIo.openSync(destPath, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.APPEND);
        try {
          fileIo.writeSync(f.fd, body);
        } finally {
          fileIo.closeSync(f);
        }
      } else {
        const f = fileIo.openSync(destPath,
          fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
        try {
          fileIo.writeSync(f.fd, body);
        } finally {
          fileIo.closeSync(f);
        }
      }
      const now: number = EnvAssetClient.fileSize(destPath);
      onProgress({ source: sourceName, received: now, total, attempt, phase: '下载中' });
      return body.byteLength;
    } finally {
      client.destroy();
    }
  }

  /** GET 文本（manifest 用）。 */
  private static async httpGetText(url: string): Promise<string> {
    const client = http.createHttp();
    try {
      const resp = await client.request(url, {
        method: http.RequestMethod.GET,
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: CONNECT_TIMEOUT_MS,
        readTimeout: 30000,
        usingProxy: false
      });
      if (resp.responseCode !== 200) {
        throw new Error('HTTP ' + resp.responseCode);
      }
      return resp.result as string;
    } finally {
      client.destroy();
    }
  }

  /** 源标签：取 URL 的 host 部分，便于日志与 UI 区分（不用正则，避免类型歧义）。 */
  private static sourceLabel(url: string, index: number): string {
    const scheme: number = url.indexOf('://');
    if (scheme < 0) {
      return 'source#' + index;
    }
    const rest: string = url.substring(scheme + 3);
    const slash: number = rest.indexOf('/');
    return slash > 0 ? rest.substring(0, slash) : rest;
  }

  private static fileSize(path: string): number {
    try {
      return fileIo.statSync(path).size;
    } catch (e) {
      return 0;
    }
  }

  private static ensureDir(dir: string): void {
    try {
      if (!fileIo.accessSync(dir)) {
        fileIo.mkdirSync(dir, true);
      }
    } catch (e) {
      DshmLogger.warn(TAG, '建目录失败 ' + dir + ': ' + String(e));
    }
  }

  private static removeFile(path: string): void {
    try {
      fileIo.unlinkSync(path);
    } catch (e) {
      DshmLogger.warn(TAG, '删除失败 ' + path + ': ' + String(e));
    }
  }
}