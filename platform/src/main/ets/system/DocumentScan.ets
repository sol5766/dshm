/**
 * 文档扫描 / 表格提取结果落地（2026-11-25，移动端会话区「加号」）。
 *
 * 【为什么单独一层】Vision Kit 的 `DocumentScanner` 是** ArkUI 组件**，它的
 * `onResult` 回调给的是**临时 URI 列表**（不是沙箱文件）。官方 FAQ（faqs-vision-6）
 * 明确：直接把这个临时 URI 交给相册/文件接口会预览空白，必须先复制进应用沙箱，
 * 再用 `fileUri.getUriFromPath()` 换成沙箱 URI —— 这正是本模块要做的事。
 *
 * 【上下游链路】
 *   会话区「加号」 → ArkWeb `onShowFileSelector`（壳层拦截）
 *   → DocumentScanner（DOC 扫描 / SHEET 表格提取）
 *   → 本模块把临时 URI 复制进 `<filesDir>/dsh/scans/`
 *   → `event.result.handleFileList(沙箱 URI[])` → 网页侧按 input[type=file] 正常接收。
 *
 * 【不申请任何新权限】扫描由系统组件自己拉起相机/相册；本模块只做沙箱内文件复制。
 * 权限面维持 entry 19 / phone 9。
 */
import { fileIo as fs, fileUri } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/docscan';

/** 扫描结果类型（与 Vision Kit 的 SaveOption 数值一一对应）。 */
export enum ScanSaveKind {
  JPG = 0,
  PDF = 1,
  EXCEL = 2
}

/** 扫描落地结果：既给网页回执 URI，也保留沙箱路径便于诊断。 */
export interface ScanPersistedFile {
  /** 交给 `handleFileList` 的 URI（沙箱路径 URI） */
  uri: string;
  /** 沙箱绝对路径 */
  path: string;
  /** 落地后的文件名（含扩展名） */
  name: string;
  /** 文件字节数 */
  size: number;
}

/** 按保存类型取扩展名：EXCEL → xlsx，PDF → pdf，其余按 jpg。 */
export function scanExtension(kind: ScanSaveKind): string {
  if (kind === ScanSaveKind.EXCEL) {
    return 'xlsx';
  }
  if (kind === ScanSaveKind.PDF) {
    return 'pdf';
  }
  return 'jpg';
}

/**
 * 把 DocumentScanner 回调的临时 URI 列表复制进沙箱。
 *
 * 【为什么不用 rename/move】临时 URI 属于扫描组件，源码可能在系统临时目录；
 * 必须 copy 到我们自己的 filesDir，生命周期才可控。
 * 【单条失败不影响其余】返回成功落地的子集；全部失败时返回空数组，由调用方按"取消"处理。
 */
export function persistScanResults(uris: string[], kind: ScanSaveKind, filesDir: string): ScanPersistedFile[] {
  const result: ScanPersistedFile[] = [];
  if (uris.length === 0 || filesDir.length === 0) {
    return result;
  }
  const dir: string = `${filesDir}/dsh/scans`;
  try {
    if (!fs.accessSync(dir)) {
      fs.mkdirSync(dir, true);
    }
  } catch (err) {
    hilog.warn(DOMAIN, TAG, '扫描目录不可用：%{public}s', (err as BusinessError).message);
    return result;
  }
  const ext: string = scanExtension(kind);
  for (const sourceUri of uris) {
    let src: fs.File | undefined = undefined;
    let dst: fs.File | undefined = undefined;
    let path: string = '';
    try {
      src = fs.openSync(sourceUri, fs.OpenMode.READ_ONLY);
      const name: string = `scan-${Date.now()}-${util.generateRandomUUID()}.${ext}`;
      path = `${dir}/${name}`;
      dst = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
      fs.copyFileSync(src.fd, dst.fd);
      const size: number = fs.statSync(path).size;
      result.push({ uri: fileUri.getUriFromPath(path), path: path, name: name, size: size });
      hilog.info(DOMAIN, TAG, '扫描件已落地：%{public}s (%{public}d B)', name, size);
    } catch (err) {
      hilog.warn(DOMAIN, TAG, '扫描件复制失败：%{public}s', (err as BusinessError).message);
      // 复制失败时清掉可能的半截文件，不留脏数据
      if (path.length > 0) {
        try {
          fs.unlinkSync(path);
        } catch (_cleanErr) {
          /* 清理失败只留痕在下一条日志，不影响其余扫描件 */
        }
      }
    } finally {
      if (src !== undefined) {
        try {
          fs.closeSync(src);
        } catch (_closeErr) {
          /* 关闭失败不影响已复制的内容 */
        }
      }
      if (dst !== undefined) {
        try {
          fs.closeSync(dst);
        } catch (_closeErr) {
          /* 同上 */
        }
      }
    }
  }
  return result;
}

/**
 * 只取回执 URI 列表（供 `event.result.handleFileList` 直接使用）。
 */
export function scanUris(files: ScanPersistedFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    out.push(f.uri);
  }
  return out;
}
