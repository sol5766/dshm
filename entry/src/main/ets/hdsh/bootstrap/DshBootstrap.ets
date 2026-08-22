/**
 * DSH 运行时引导（ArkTS 层）。
 *
 * 移植自 dsh-OHDSH/HDSH（MIT）：https://gitcode.com/MakeBlackSheepGreat/dsh-OHDSH
 *
 * 职责：
 * 1. 首次启动时将 HAP 内 rawfile/dsh 的 DSH 运行环境解压到应用沙箱 filesDir/dsh；
 * 2. 解压 rawfile/busybox 的 busybox 二进制并建立 applet 副本（sh/bash 等），
 *    为 dsh 提供 bash/Linux 命令环境（PATH/SHELL 等环境变量由 libdsh_host 注入）；
 * 3. 启动 native 子进程（libdsh_host.so:Main），子进程内 dlopen(libnode.so) →
 *    node::Start → 启动 DSH web server (127.0.0.1:3080)；
 * 4. 轮询 3080 端口就绪，供 ArkWeb 加载。
 */
import { common, childProcessManager, ChildProcessArgs } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { http } from '@kit.NetworkKit';
import resourceManager from '@ohos.resourceManager';
import { HdshLogger } from '../utils/Logger';

const TAG: string = 'DshBootstrap';
const RAWFILE_ROOT: string = 'dsh';
const DSH_SUBDIR: string = 'dsh';
const SERVER_URL: string = 'http://127.0.0.1:3080';

// 环境版本号：rawfile/dsh、busybox、pnpm 内容变化时递增。
// 覆盖安装（install -r）不清应用数据，靠版本文件判断是否需要重新解压，
// 避免旧环境残留、新环境不更新；会话/工作区/API key 存于 filesDir/home，
// 不随环境重建而丢失。
const ENV_VERSION: string = '20260822-01';
const VERSION_FILE: string = '.hdsh-version';

// busybox：随 HAP 分发（rawfile/busybox/busybox），解压到 filesDir/busybox
// 注意：可执行权限（0755）由 libdsh_host（C++）在 node 启动前 chmod，
// 因为 @ohos.file.fs 未提供 chmod 类 API（chmodSync 仅存在于旧 @ohos.fileio）。
const BUSYBOX_RAWFILE: string = 'busybox/busybox';
const BUSYBOX_SUBDIR: string = 'busybox';

// pnpm standalone（dsh plugin 前向器依赖）：rawfile/pnpm/pnpm → filesDir/pnpm/pnpm
const PNPM_RAWFILE: string = 'pnpm/pnpm';
const PNPM_SUBDIR: string = 'pnpm';

/** 需要建立的 busybox applet（复制 busybox 本体，按 argv[0] 分发）。
 *  鸿蒙沙箱禁止 symlink/hardlink（官方文档证实三方应用不可用），
 *  故采用复制本体到每个 applet 名；可执行权限由 libdsh_host（C++）chmod 补齐。 */
const BUSYBOX_APPLETS: string[] = [
  'sh', 'bash', 'ash', 'hush',
  'ls', 'cat', 'echo', 'printf', 'pwd', 'mkdir', 'cp', 'mv', 'rm',
  'chmod', 'chown', 'chgrp', 'touch', 'ln', 'readlink', 'stat', 'dd',
  'grep', 'egrep', 'fgrep', 'sed', 'awk', 'find', 'xargs',
  'head', 'tail', 'wc', 'sort', 'uniq', 'tr', 'cut', 'od', 'hexdump',
  'test', 'true', 'false', 'sleep', 'date', 'env', 'uname', 'id',
  'whoami', 'hostname', 'ps', 'kill', 'nohup', 'seq', 'expr',
  'basename', 'dirname', 'which', 'tee', 'yes', 'watch',
  'tar', 'gzip', 'gunzip', 'zcat', 'bzip2', 'xz', 'unzip', 'cpio',
  'diff', 'patch', 'vi', 'less', 'more',
  'wget', 'nc', 'ping', 'ifconfig', 'netstat', 'route', 'telnet',
  'sha256sum', 'md5sum', 'du', 'df', 'free', 'top', 'mount', 'sync'
];

export class DshBootstrap {
  /**
   * 确保 DSH 运行环境在沙箱中就绪，返回 DSH 目录绝对路径。
   * 版本匹配（存在 .hdsh-version 且等于 ENV_VERSION）则跳过复制；
   * 版本不一致时递归清理旧目录后重新解压（会话/工作区存于 filesDir/home，不受影响）。
   */
  static async ensureDshDir(context: common.UIAbilityContext): Promise<string> {
    const dshDir: string = context.filesDir + '/' + DSH_SUBDIR;
    const versionPath: string = dshDir + '/' + VERSION_FILE;
    if (DshBootstrap.isEnvVersionOk(versionPath)) {
      HdshLogger.info(TAG, 'DSH 环境已就绪 (v' + ENV_VERSION + '): ' + dshDir);
      return dshDir;
    }
    HdshLogger.info(TAG, 'DSH 环境版本变化或首次启动，解压到 ' + dshDir);
    DshBootstrap.resetDir(dshDir);
    const resMgr: resourceManager.ResourceManager = context.resourceManager;
    DshBootstrap.copyRawfileRecursive(resMgr, RAWFILE_ROOT, dshDir);
    DshBootstrap.writeEnvVersion(versionPath);
    // 版本变化后清除 profiles fallback 缓存：dsh 运行时从
    // home/.dsh/profiles/node_modules 解析依赖副本（heal 对已存在目录不更新），
    // 不清除则 host-apiproxy 等新端点/新插件不会生效。
    DshBootstrap.clearProfilesFallback(context);
    HdshLogger.info(TAG, 'DSH 环境解压完成');
    return dshDir;
  }

  /**
   * 确保 busybox 就绪并建立 applet 副本，返回 busybox 目录绝对路径。
   * 版本匹配则跳过复制（applet 幂等补齐）；版本变化时递归清理后重新解压。
   */
  static async ensureBusybox(context: common.UIAbilityContext): Promise<string> {
    const busyboxDir: string = context.filesDir + '/' + BUSYBOX_SUBDIR;
    const busyboxPath: string = busyboxDir + '/busybox';
    const versionPath: string = busyboxDir + '/' + VERSION_FILE;
    if (DshBootstrap.isEnvVersionOk(versionPath)) {
      DshBootstrap.installBusyboxApplets(busyboxDir, busyboxPath);
      HdshLogger.info(TAG, 'busybox 已就绪: ' + busyboxPath);
      return busyboxDir;
    }
    HdshLogger.info(TAG, 'busybox 版本变化或首次启动，解压到 ' + busyboxDir);
    DshBootstrap.resetDir(busyboxDir);
    const resMgr: resourceManager.ResourceManager = context.resourceManager;
    const data: Uint8Array = resMgr.getRawFileContentSync(BUSYBOX_RAWFILE);
    const file = fileIo.openSync(busyboxPath,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    fileIo.writeSync(file.fd, data.buffer as ArrayBuffer);
    fileIo.closeSync(file);
    // 可执行权限由 libdsh_host（C++）在 node 启动前 chmod（@ohos.file.fs 无 chmod API）
    DshBootstrap.installBusyboxApplets(busyboxDir, busyboxPath);
    DshBootstrap.writeEnvVersion(versionPath);
    HdshLogger.info(TAG, 'busybox 解压完成，applet 副本就绪');
    return busyboxDir;
  }

  /**
   * 确保 pnpm standalone 就绪，返回 pnpm 目录绝对路径。
   * dsh plugin 是 pnpm 前向器（spawnSync("pnpm")），沙箱无 node 可执行，
   * 需内置 linuxstatic-arm64 standalone 并注入 PATH（由 libdsh_host 完成）。
   * 版本匹配则跳过；版本变化时重新解压。
   */
  static async ensurePnpm(context: common.UIAbilityContext): Promise<string> {
    const pnpmDir: string = context.filesDir + '/' + PNPM_SUBDIR;
    const pnpmPath: string = pnpmDir + '/pnpm';
    const versionPath: string = pnpmDir + '/' + VERSION_FILE;
    if (DshBootstrap.isEnvVersionOk(versionPath)) {
      HdshLogger.info(TAG, 'pnpm 已就绪: ' + pnpmPath);
      return pnpmDir;
    }
    HdshLogger.info(TAG, 'pnpm 版本变化或首次启动，解压到 ' + pnpmDir);
    DshBootstrap.resetDir(pnpmDir);
    const resMgr: resourceManager.ResourceManager = context.resourceManager;
    const data: Uint8Array = resMgr.getRawFileContentSync(PNPM_RAWFILE);
    const file = fileIo.openSync(pnpmPath,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    fileIo.writeSync(file.fd, data.buffer as ArrayBuffer);
    fileIo.closeSync(file);
    DshBootstrap.writeEnvVersion(versionPath);
    // 可执行权限由 libdsh_host（C++）在 node 启动前 chmod（@ohos.file.fs 无 chmod API）
    HdshLogger.info(TAG, 'pnpm 解压完成');
    return pnpmDir;
  }

  /**
   * 为 busybox 建立 applet（复制 busybox 本体，缺失才创建）。
   * 鸿蒙沙箱禁止 symlink/hardlink，只能复制；可执行权限由 libdsh_host（C++）
   * 在启动前统一 chmod 0755。
   */
  private static installBusyboxApplets(busyboxDir: string, busyboxPath: string): void {
    for (let i = 0; i < BUSYBOX_APPLETS.length; i++) {
      const applet: string = busyboxDir + '/' + BUSYBOX_APPLETS[i];
      if (fileIo.accessSync(applet)) {
        continue;
      }
      try {
        fileIo.copyFileSync(busyboxPath, applet);
      } catch (e) {
        // 单个 applet 复制失败不阻断整体初始化
        HdshLogger.warn(TAG, '创建 applet 失败: ' + applet + ', ' + String(e));
      }
    }
  }

  /** 判断环境版本文件是否与当前 ENV_VERSION 匹配（容忍尾部换行）。 */
  private static isEnvVersionOk(versionPath: string): boolean {
    try {
      if (!fileIo.accessSync(versionPath)) {
        return false;
      }
      const v: string = fileIo.readTextSync(versionPath).trim();
      return v === ENV_VERSION;
    } catch (e) {
      return false;
    }
  }

  /** 写入环境版本文件（覆盖旧版本号）。 */
  private static writeEnvVersion(versionPath: string): void {
    try {
      const file = fileIo.openSync(versionPath,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      fileIo.writeSync(file.fd, ENV_VERSION + '\n');
      fileIo.closeSync(file);
    } catch (e) {
      HdshLogger.warn(TAG, '写入环境版本失败: ' + String(e));
    }
  }

  /** 递归删除目录（rmdirSync 不支持递归，手动遍历删除文件与子目录）。 */
  private static removeDirRecursive(dir: string): void {
    if (!fileIo.accessSync(dir)) {
      return;
    }
    let entries: Array<string> = [];
    try {
      entries = fileIo.listFileSync(dir);
    } catch (e) {
      HdshLogger.warn(TAG, '列出目录失败，跳过清理: ' + String(e));
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      const child: string = dir + '/' + entries[i];
      try {
        const stat = fileIo.statSync(child);
        if (stat.isDirectory()) {
          DshBootstrap.removeDirRecursive(child);
          fileIo.rmdirSync(child);
        } else {
          fileIo.unlinkSync(child);
        }
      } catch (e) {
        HdshLogger.warn(TAG, '清理 ' + child + ' 失败: ' + String(e));
      }
    }
  }

  /** 重置目录：递归清空内容 → 删除目录本身 → 重新创建（用于版本变化时重建环境）。 */
  private static resetDir(dir: string): void {
    DshBootstrap.removeDirRecursive(dir);
    if (fileIo.accessSync(dir)) {
      try {
        fileIo.rmdirSync(dir);
      } catch (e) {
        HdshLogger.warn(TAG, '删除目录失败: ' + String(e));
      }
    }
    fileIo.mkdirSync(dir);
  }

  /** 清除 dsh profiles fallback 缓存（home/.dsh/profiles/node_modules），
   *  让 dsh 下次启动时按新环境重新生成依赖副本。 */
  private static clearProfilesFallback(context: common.UIAbilityContext): void {
    const fallbackDir: string = context.filesDir + '/home/.dsh/profiles/node_modules';
    DshBootstrap.removeDirRecursive(fallbackDir);
    if (fileIo.accessSync(fallbackDir)) {
      try {
        fileIo.rmdirSync(fallbackDir);
      } catch (e) {
        HdshLogger.warn(TAG, '删除 fallback 目录失败: ' + String(e));
      }
    }
    HdshLogger.info(TAG, '已清除 profiles fallback 缓存');
  }

  /** 递归复制 rawfile 目录到目标目录（保持相对结构）。 */
  private static copyRawfileRecursive(resMgr: resourceManager.ResourceManager, relPath: string, destDir: string): void {
    const entries: Array<string> = resMgr.getRawFileListSync(relPath);
    for (let i = 0; i < entries.length; i++) {
      const childRel: string = relPath + '/' + entries[i];
      const childDest: string = destDir + '/' + entries[i];
      let isDir: boolean = false;
      try {
        const sub: Array<string> = resMgr.getRawFileListSync(childRel);
        isDir = sub.length >= 0;
      } catch (e) {
        isDir = false;
      }
      if (isDir) {
        if (!fileIo.accessSync(childDest)) {
          fileIo.mkdirSync(childDest);
        }
        DshBootstrap.copyRawfileRecursive(resMgr, childRel, childDest);
      } else {
        const data: Uint8Array = resMgr.getRawFileContentSync(childRel);
        const file = fileIo.openSync(childDest,
          fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
        fileIo.writeSync(file.fd, data.buffer as ArrayBuffer);
        fileIo.closeSync(file);
      }
    }
  }

  /** 启动 native 子进程运行 DSH。返回子进程 pid。 */
  static async launchDsh(): Promise<number> {
    HdshLogger.info(TAG, '启动 libdsh_host 子进程');
    const args: ChildProcessArgs = {};
    return childProcessManager.startNativeChildProcess('libdsh_host.so:Main', args);
  }

  /** 启动前仅清理上一轮 node 诊断日志，避免超时诊断混入历史进程错误。 */
  static clearNodeLogs(context: common.UIAbilityContext): void {
    const logDir: string = context.filesDir + '/log';
    DshBootstrap.removeDirRecursive(logDir);
    if (fileIo.accessSync(logDir)) {
      try {
        fileIo.rmdirSync(logDir);
      } catch (e) {
        HdshLogger.warn(TAG, '删除旧 node 日志目录失败: ' + String(e));
        return;
      }
    }
    try {
      fileIo.mkdirSync(logDir);
      HdshLogger.info(TAG, '已清除上一轮 node 诊断日志');
    } catch (e) {
      HdshLogger.warn(TAG, '创建 node 日志目录失败: ' + String(e));
    }
  }

  /**
   * 诊断：回读 filesDir/log/ 下的 node 子进程日志并打到 hilog。
   * libdsh_host 将 node stdout/stderr 重定向到 <filesDir>/log/node-*.log，
   * 但应用沙箱对 hdc shell 不可见，只能由应用自身读取后输出。
   */
  static async dumpNodeLogs(context: common.UIAbilityContext): Promise<void> {
    const logDir: string = context.filesDir + '/log';
    let entries: Array<string> = [];
    try {
      entries = fileIo.listFileSync(logDir);
    } catch (e) {
      HdshLogger.error(TAG, 'log 目录不可读: ' + String(e));
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      const p: string = logDir + '/' + entries[i];
      try {
        const content: string = fileIo.readTextSync(p);
        HdshLogger.error('NodeLog', entries[i] + '\n' + content);
      } catch (e) {
        HdshLogger.error(TAG, '读取 ' + entries[i] + ' 失败: ' + String(e));
      }
    }
  }

  /** 读取最近 Node 子进程日志的末尾，供启动失败界面显示可操作的根因。 */
  static readNodeLogTail(context: common.UIAbilityContext): string {
    const logDir: string = context.filesDir + '/log';
    let entries: Array<string> = [];
    try {
      entries = fileIo.listFileSync(logDir);
    } catch (e) {
      return '';
    }
    let latest: string = '';
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].startsWith('node-') && entries[i].endsWith('.log')) {
        latest = entries[i];
      }
    }
    if (latest.length === 0) return '';
    try {
      const content: string = fileIo.readTextSync(logDir + '/' + latest);
      const maxLength: number = 1200;
      return content.length > maxLength ? content.slice(content.length - maxLength) : content;
    } catch (e) {
      return '';
    }
  }

  /**
   * 诊断：列出 DSH 源目录与 profiles fallback 目录中 pi-ai 相关路径，
   * 用于定位 .manifest.json 缺失（rawfile 隐藏文件解压丢失或 cpSync 复制问题）。
   */
  static async dumpFallbackDiag(context: common.UIAbilityContext): Promise<void> {
    const paths: string[] = [
      context.filesDir + '/dsh/node_modules/@earendil-works/pi-ai/dist/providers/data',
      context.filesDir + '/home/.dsh/profiles/node_modules/@earendil-works/pi-ai/dist/providers/data',
      context.filesDir + '/home/.dsh/profiles/node_modules/@earendil-works/pi-ai/dist/providers'
    ];
    for (let i = 0; i < paths.length; i++) {
      let names: Array<string> = [];
      try {
        names = fileIo.listFileSync(paths[i]);
      } catch (e) {
        HdshLogger.error('FallbackDiag', paths[i] + ' => 不可读: ' + String(e));
        continue;
      }
      HdshLogger.error('FallbackDiag', paths[i] + ' => [' + names.join(',') + ']');
    }
  }

  /** 诊断：输出当前 Web profile 的插件清单，用于定位某个第三方包的启动失败。 */
  static async dumpWebProfileManifest(context: common.UIAbilityContext): Promise<void> {
    const manifestPath: string = context.filesDir + '/home/.dsh/profiles/web/package.json';
    try {
      const content: string = fileIo.readTextSync(manifestPath);
      HdshLogger.error('ProfileDiag', 'web profile manifest: ' + content);
    } catch (e) {
      HdshLogger.error('ProfileDiag', 'web profile manifest 不可读: ' + String(e));
    }
  }

  /** 轮询 DSH web server 就绪。 */
  static async waitForServer(timeoutMs: number): Promise<boolean> {
    const deadline: number = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await DshBootstrap.probeServer()) {
        return true;
      }
      await new Promise<void>((resolve: () => void) => {
        setTimeout(resolve, 2000);
      });
    }
    return false;
  }

  private static async probeServer(): Promise<boolean> {
    const request = http.createHttp();
    try {
      const resp = await request.request(SERVER_URL, {
        method: http.RequestMethod.GET,
        connectTimeout: 2000,
        readTimeout: 2000
      });
      return resp.responseCode < 500;
    } catch (e) {
      return false;
    } finally {
      request.destroy();
    }
  }
}
