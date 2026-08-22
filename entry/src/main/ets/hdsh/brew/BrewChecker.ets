import { common, childProcessManager, ChildProcessArgs } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { HdshLogger } from '../utils/Logger';

const TAG: string = 'BrewChecker';

export interface BrewCheckResult {
  brewInstalled: boolean;
  dshInstalled: boolean;
  dshPath: string;
}

export class BrewChecker {
  private static readonly RESULT_FILE: string = 'brew-check-result.json';
  private static readonly TMP_DIR: string = 'tmp';
  private static checkPid: number = -1;

  static async check(context: common.UIAbilityContext): Promise<BrewCheckResult> {
    const filesDir: string = context.filesDir;
    const tmpDir: string = filesDir + '/' + BrewChecker.TMP_DIR;
    const resultPath: string = tmpDir + '/' + BrewChecker.RESULT_FILE;

    // Clean stale result
    try {
      if (fileIo.accessSync(resultPath)) {
        fileIo.unlinkSync(resultPath);
      }
    } catch (e) {
      HdshLogger.warn(TAG, 'Clean stale result failed: ' + String(e));
    }

    // Set environment for native child process
    const homeDir: string = '/storage/Users/currentUser';
    try {
      const processArgs: ChildProcessArgs = {
        entryParams: filesDir
      };
      BrewChecker.checkPid = await childProcessManager.startNativeChildProcess(
        'libbrew_check.so:Main',
        processArgs
      );
      HdshLogger.info(TAG, 'brew check child process started, pid=' + BrewChecker.checkPid);
    } catch (e) {
      HdshLogger.error(TAG, 'startNativeChildProcess failed: ' + String(e));
      // Fallback: check files directly from ArkTS side
      return BrewChecker.checkDirect(context);
    }

    // Poll for result file (up to 10 seconds)
    const maxAttempts: number = 50;
    for (let i: number = 0; i < maxAttempts; i++) {
      try {
        if (fileIo.accessSync(resultPath)) {
          const content: string = fileIo.readTextSync(resultPath);
          const result: BrewCheckResult = BrewChecker.parseResult(content);
          HdshLogger.info(TAG, 'brew check result: brew=' + result.brewInstalled +
            ' dsh=' + result.dshInstalled + ' path=' + result.dshPath);
          return result;
        }
      } catch (e) {
        HdshLogger.warn(TAG, 'Read result failed, attempt ' + String(i));
      }
      await BrewChecker.sleep(200);
    }

    HdshLogger.warn(TAG, 'brew check timed out, falling back to direct check');
    return BrewChecker.checkDirect(context);
  }

  static cancel(): void {
    BrewChecker.checkPid = -1;
  }

  private static checkDirect(context: common.UIAbilityContext): BrewCheckResult {
    const homeDir: string = '/storage/Users/currentUser';
    const brewBin: string = homeDir + '/.harmonybrew/bin/brew';
    const dshBin: string = homeDir + '/.harmonybrew/bin/dsh';

    let brewInstalled: boolean = false;
    let dshInstalled: boolean = false;

    try {
      brewInstalled = fileIo.accessSync(brewBin);
    } catch (e) {
      brewInstalled = false;
    }
    try {
      dshInstalled = fileIo.accessSync(dshBin);
    } catch (e) {
      dshInstalled = false;
    }

    const result: BrewCheckResult = {
      brewInstalled: brewInstalled,
      dshInstalled: dshInstalled,
      dshPath: dshInstalled ? dshBin : ''
    };
    return result;
  }

  private static parseResult(content: string): BrewCheckResult {
    const result: BrewCheckResult = {
      brewInstalled: false,
      dshInstalled: false,
      dshPath: ''
    };
    if (content.length === 0) {
      return result;
    }
    try {
      // Simple JSON parsing without JSON.parse (ArkTS compatible)
      result.brewInstalled = content.includes('"brewInstalled":true');
      result.dshInstalled = content.includes('"dshInstalled":true');
      const pathKey: string = '"dshPath":"';
      const startIdx: number = content.indexOf(pathKey);
      if (startIdx >= 0) {
        const valueStart: number = startIdx + pathKey.length;
        const valueEnd: number = content.indexOf('"', valueStart);
        if (valueEnd > valueStart) {
          result.dshPath = content.substring(valueStart, valueEnd);
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
