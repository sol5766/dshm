/**
 * ArkWeb 下载落地（2026-11-15）。
 *
 * 【缺口】官方 Web 的「下载 Session 日志」是 `<a download>` 触发浏览器下载
 * （`@deepseek-ai/dsh-session-log-export` 的 `downloadUrl()`）。ArkWeb 默认不接管
 * 网页下载：没有 `WebDownloadDelegate` 时任务停在 PENDING，用户点完只看到
 * 「浏览器正在下载」，实际没有文件落地。本模块把这个缺口补成一条原生链路：
 *
 *   网页下载 → onBeforeDownload（落应用缓存）→ onDownloadFinish（系统保存框）
 *   → 复制到用户选定的 URI。
 *
 * 【为什么先落缓存再让用户选】`WebDownloadItem.start(path)` 只接受路径；
 * 用户可见位置由 `DocumentViewPicker.save()` 返回 URI。先写缓存再复制，既不改
 * 下载目标语义，也不需要任何新增权限（picker 本身无需权限）。
 *
 * 【边界】只接管网页触发的下载；文件名做白名单清洗（去掉路径分隔符/控制字符/
 * 连续点），失败只写 `diag-download` 与日志，不抛到页面、不影响其它功能。
 */

import { webview } from '@kit.ArkWeb';
import { picker } from '@kit.CoreFileKit';
import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/webdownload';
const DIAG_FILE: string = 'diag-download';
const DOWNLOAD_DIR: string = 'downloads';

/** 是否已挂过全局下载委托（WebDownloadManager 是进程级单例） */
let installed: boolean = false;
/** 保活：WebDownloadManager 是否强持有委托不由文档保证，留一份模块级引用最稳 */
let activeDelegate: webview.WebDownloadDelegate | undefined = undefined;

/** 诊断落盘：每行一条，现场 `cat files/diag-download` 即可判"为什么没存下来" */
function writeDiag(context: common.Context, line: string): void {
  try {
    const path: string = context.filesDir + '/' + DIAG_FILE;
    const file = fileIo.openSync(path,
      fileIo.OpenMode.CREATE | fileIo.OpenMode.APPEND | fileIo.OpenMode.READ_WRITE);
    try {
      fileIo.writeSync(file.fd, line + '\n');
    } finally {
      fileIo.closeSync(file);
    }
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, 'diag-download 写入失败：%{public}s', e.message);
  }
}

/**
 * 清洗网页建议的文件名：只保留单层文件名。
 *
 * 【为什么必须做】`getSuggestedFileName()` 来自网页，不可信；带 `/`、`\`、`..`
 * 的名字一旦拼进缓存路径就会越出下载目录。清洗后为空时退回固定名。
 */
export function safeDownloadName(raw: string): string {
  const trimmed: string = raw.trim();
  const cleaned: string = trimmed
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/^\.+/, '_');
  return cleaned.length > 0 ? cleaned : 'download.bin';
}

/** 缓存下载目录（按需创建）；失败返回空串，调用方取消下载 */
function ensureDownloadDir(context: common.Context): string {
  const dir: string = context.cacheDir + '/' + DOWNLOAD_DIR;
  try {
    if (!fileIo.accessSync(dir)) {
      fileIo.mkdirSync(dir, true);
    }
    return dir;
  } catch (err) {
    const e = err as BusinessError;
    writeDiag(context, `mkdir-fail ${e.code} ${e.message}`);
    return '';
  }
}

/**
 * 把缓存文件交给系统保存框，用户选定位置后复制过去。
 *
 * 【为什么用 picker 而不是直接写 Download/<包名>】写公共目录需要额外授权；
 * picker 由系统授予本次 URI 的读写权，零权限、零路径猜测。
 */
async function saveToPickedUri(context: common.Context, srcPath: string, name: string): Promise<void> {
  try {
    const view: picker.DocumentViewPicker = new picker.DocumentViewPicker(context);
    const uris: string[] = await view.save({ newFileNames: [name] });
    if (uris.length === 0) {
      writeDiag(context, `save-cancel ${name}`);
      return;
    }
    const dest = fileIo.openSync(uris[0],
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.TRUNC);
    try {
      await fileIo.copyFile(srcPath, dest.fd);
    } finally {
      fileIo.closeSync(dest);
    }
    writeDiag(context, `saved ${name} -> ${uris[0]}`);
    hilog.info(DOMAIN, TAG, '网页下载已保存：%{public}s', name);
    try {
      fileIo.unlinkSync(srcPath);
    } catch (err) {
      // 缓存清理失败不影响已保存的文件
    }
  } catch (err) {
    const e = err as BusinessError;
    writeDiag(context, `save-fail ${name} code=${e.code} ${e.message}`);
    hilog.warn(DOMAIN, TAG, '网页下载保存失败：%{public}s', e.message);
  }
}

/**
 * 安装 ArkWeb 下载委托（幂等）。
 *
 * @param context 宿主 UIAbility 上下文（取 cacheDir / filesDir，并交给保存框）
 */
export function installWebDownloadDelegate(context: common.Context): void {
  if (installed && activeDelegate !== undefined) {
    return;
  }
  installed = true;
  const delegate: webview.WebDownloadDelegate = new webview.WebDownloadDelegate();
  activeDelegate = delegate;

  delegate.onBeforeDownload((item: webview.WebDownloadItem): void => {
    const dir: string = ensureDownloadDir(context);
    if (dir.length === 0) {
      item.cancel();
      return;
    }
    const name: string = safeDownloadName(item.getSuggestedFileName());
    const target: string = dir + '/' + Date.now().toString() + '-' + name;
    writeDiag(context, `begin ${name} -> ${target}`);
    try {
      item.start(target);
    } catch (err) {
      const e = err as BusinessError;
      writeDiag(context, `start-fail ${name} code=${e.code} ${e.message}`);
      item.cancel();
    }
  });

  delegate.onDownloadFinish((item: webview.WebDownloadItem): void => {
    const name: string = safeDownloadName(item.getSuggestedFileName());
    const path: string = item.getFullPath();
    writeDiag(context, `finish ${name} ${path}`);
    void saveToPickedUri(context, path, name);
  });

  delegate.onDownloadFailed((item: webview.WebDownloadItem): void => {
    writeDiag(context, `failed ${safeDownloadName(item.getSuggestedFileName())}`);
  });

  try {
    webview.WebDownloadManager.setDownloadDelegate(delegate);
    writeDiag(context, 'delegate-installed');
    hilog.info(DOMAIN, TAG, 'ArkWeb 下载委托已安装');
  } catch (err) {
    const e = err as BusinessError;
    writeDiag(context, `delegate-fail ${e.code} ${e.message}`);
    hilog.warn(DOMAIN, TAG, 'ArkWeb 下载委托安装失败：%{public}s', e.message);
  }
}
