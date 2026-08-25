/**
 * InstallManager — 应用内安装 Harmonybrew / DeepSeek Harness（NAPI 主进程执行）。
 *
 * 安装命令由 libdsh_launcher.so 的 NAPI（installBrew / installDsh）在主进程内
 * fork 执行（继承主进程网络空间，与 launchDsh 同一机制）。
 * 进度：安装日志尾部（<filesDir>/log/install-<name>-*.log）轮询回调。
 * 结果：<filesDir>/tmp/install-<name>-result.json {"success":bool,"exitCode":n,"log":"..."}。
 */
import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import launcher from 'libdsh_launcher.so';
import { HdshLogger } from '../utils/Logger';

const TAG: string = 'InstallManager';

export class InstallManager {
  private static timer: number = -1;

  /** 是否正在安装（全局单实例，避免重复触发）。 */
  static get isInstalling(): boolean {
    return InstallManager.timer >= 0;
  }

  /**
   * 启动安装并轮询进度/结果。
   * @param context  UIAbilityContext
   * @param name     'brew' | 'dsh'
   * @param onProgress 每次轮询回调日志尾部（可显示在进度区）
   * @param onDone   完成回调（success 表示退出码为 0）
   */
  static startInstall(context: common.UIAbilityContext, name: string,
    onProgress: (logTail: string) => void, onDone: (success: boolean) => void): void {
    if (InstallManager.timer >= 0) {
      return;
    }
    // 清理上一轮的结果文件，避免读到过期结果被误判为本次已完成
    const resultPath: string = context.filesDir + '/tmp/install-' + name + '-result.json';
    try {
      if (fileIo.accessSync(resultPath)) {
        fileIo.unlinkSync(resultPath);
      }
    } catch (e) {
      HdshLogger.warn(TAG, 'clean stale install result failed: ' + String(e));
    }
    try {
      if (name === 'brew') {
        launcher.installBrew();
      } else {
        launcher.installDsh();
      }
    } catch (e) {
      HdshLogger.error(TAG, `launcher.install${name} failed: ${String(e)}`);
      onDone(false);
      return;
    }
    // 超时兜底：15 分钟无结果视为失败，避免永久轮询
    let polls: number = 0;
    const maxPolls: number = 15 * 60;
    InstallManager.timer = setInterval(() => {
      const tail: string = InstallManager.readLogTail(context, name);
      onProgress(tail);
      const result: string = InstallManager.readResult(context, name);
      if (result !== '') {
        InstallManager.stop();
        const ok: boolean = result.indexOf('"success":true') >= 0;
        onDone(ok);
        return;
      }
      polls++;
      if (polls >= maxPolls) {
        InstallManager.stop();
        HdshLogger.error(TAG, 'install timed out waiting for result file');
        onDone(false);
      }
    }, 1000);
  }

  static stop(): void {
    if (InstallManager.timer >= 0) {
      clearInterval(InstallManager.timer);
      InstallManager.timer = -1;
    }
  }

  /** 读最近一个 install-<name>-*.log 的尾部（滚动窗口 2000 字符）。 */
  static readLogTail(context: common.UIAbilityContext, name: string): string {
    const logDir: string = context.filesDir + '/log';
    try {
      const files: Array<string> = fileIo.listFileSync(logDir);
      let latest: string = '';
      for (const f of files) {
        if (f.indexOf('install-' + name + '-') === 0 && f.endsWith('.log')) {
          if (f > latest) {
            latest = f;
          }
        }
      }
      if (latest !== '') {
        const content: string = fileIo.readTextSync(logDir + '/' + latest);
        return content.length > 2000 ? content.substring(content.length - 2000) : content;
      }
    } catch (e) {
      HdshLogger.warn(TAG, `read install log failed: ${String(e)}`);
    }
    return '安装中…';
  }

  /** 读结果文件；不存在返回空串。 */
  static readResult(context: common.UIAbilityContext, name: string): string {
    const resultPath: string = context.filesDir + '/tmp/install-' + name + '-result.json';
    try {
      if (fileIo.accessSync(resultPath)) {
        return fileIo.readTextSync(resultPath);
      }
    } catch (e) {
      HdshLogger.warn(TAG, `read install result failed: ${String(e)}`);
    }
    return '';
  }
}
