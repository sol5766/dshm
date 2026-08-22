import { common, childProcessManager, ChildProcessArgs } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { HdshLogger } from '../utils/Logger';

const TAG: string = 'BrewInstaller';

export interface BrewInstallResult {
  success: boolean;
  exitCode: number;
  message: string;
}

export class BrewInstaller {
  private static readonly RESULT_FILE: string = 'brew-install-result.json';
  private static installPid: number = -1;

  static async installDsh(context: common.UIAbilityContext): Promise<BrewInstallResult> {
    const filesDir: string = context.filesDir;
    const tmpDir: string = filesDir + '/tmp';
    const logDir: string = filesDir + '/log';
    const resultPath: string = tmpDir + '/' + BrewInstaller.RESULT_FILE;

    // Ensure dirs
    try {
      if (!fileIo.accessSync(tmpDir)) {
        fileIo.mkdirSync(tmpDir);
      }
      if (!fileIo.accessSync(logDir)) {
        fileIo.mkdirSync(logDir);
      }
    } catch (e) {
      HdshLogger.warn(TAG, 'Ensure dirs failed: ' + String(e));
    }

    // Clean stale result
    try {
      if (fileIo.accessSync(resultPath)) {
        fileIo.unlinkSync(resultPath);
      }
    } catch (e) {
      HdshLogger.warn(TAG, 'Clean stale result failed: ' + String(e));
    }

    const homeDir: string = '/storage/Users/currentUser';
    try {
      const processArgs: ChildProcessArgs = {
        entryParams: filesDir
      };
      BrewInstaller.installPid = await childProcessManager.startNativeChildProcess(
        'libbrew_installer.so:Main',
        processArgs
      );
      HdshLogger.info(TAG, 'brew install child process started, pid=' + BrewInstaller.installPid);
    } catch (e) {
      HdshLogger.error(TAG, 'startNativeChildProcess failed: ' + String(e));
      const failResult: BrewInstallResult = {
        success: false,
        exitCode: -1,
        message: '无法启动安装进程：' + String(e)
      };
      return failResult;
    }

    // Poll for result file (up to 5 minutes for brew install)
    const maxAttempts: number = 1500;
    for (let i: number = 0; i < maxAttempts; i++) {
      try {
        if (fileIo.accessSync(resultPath)) {
          const content: string = fileIo.readTextSync(resultPath);
          const result: BrewInstallResult = BrewInstaller.parseResult(content);
          HdshLogger.info(TAG, 'brew install result: success=' + result.success +
            ' exitCode=' + result.exitCode);
          return result;
        }
      } catch (e) {
        HdshLogger.warn(TAG, 'Read result failed, attempt ' + String(i));
      }
      await BrewInstaller.sleep(200);
    }

    HdshLogger.error(TAG, 'brew install timed out');
    const timeoutResult: BrewInstallResult = {
      success: false,
      exitCode: -2,
      message: '安装超时（5分钟），请检查网络连接后重试'
    };
    return timeoutResult;
  }

  static readInstallProgress(context: common.UIAbilityContext): string {
    const logDir: string = context.filesDir + '/log';
    let entries: Array<string> = [];
    try {
      entries = fileIo.listFileSync(logDir);
    } catch (e) {
      return '';
    }
    let latestLog: string = '';
    for (let i: number = 0; i < entries.length; i++) {
      if (entries[i].startsWith('brew-install') && entries[i].endsWith('.log')) {
        latestLog = entries[i];
      }
    }
    if (latestLog.length === 0) {
      return '';
    }
    try {
      const content: string = fileIo.readTextSync(logDir + '/' + latestLog);
      const maxLen: number = 2000;
      return content.length > maxLen ? content.slice(content.length - maxLen) : content;
    } catch (e) {
      return '';
    }
  }

  static cancel(): void {
    BrewInstaller.installPid = -1;
  }

  private static parseResult(content: string): BrewInstallResult {
    const result: BrewInstallResult = {
      success: false,
      exitCode: -1,
      message: ''
    };
    if (content.length === 0) {
      return result;
    }
    try {
      result.success = content.includes('"success":true');
      const exitKey: string = '"exitCode":';
      const exitStart: number = content.indexOf(exitKey);
      if (exitStart >= 0) {
        const valueStart: number = exitStart + exitKey.length;
        let valueEnd: number = valueStart;
        while (valueEnd < content.length && content[valueEnd] >= '0' && content[valueEnd] <= '9') {
          valueEnd++;
        }
        if (valueEnd > valueStart) {
          const codeStr: string = content.substring(valueStart, valueEnd);
          result.exitCode = parseInt(codeStr, 10);
        }
      }
      const msgKey: string = '"message":"';
      const msgStart: number = content.indexOf(msgKey);
      if (msgStart >= 0) {
        const valueStart: number = msgStart + msgKey.length;
        const valueEnd: number = content.indexOf('"', valueStart);
        if (valueEnd > valueStart) {
          result.message = content.substring(valueStart, valueEnd);
        }
      }
    } catch (e) {
      HdshLogger.error(TAG, 'parse result failed: ' + String(e));
    }
    return result;
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void) => {
      setTimeout(resolve, ms);
    });
  }
}
