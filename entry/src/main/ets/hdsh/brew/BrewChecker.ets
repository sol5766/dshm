import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import launcher from 'libdsh_launcher.so';
import { HdshLogger } from '../utils/Logger';

const TAG: string = 'BrewChecker';

export interface BrewCheckResult {
  brewInstalled: boolean;
  dshInstalled: boolean;
  dshPath: string;
}

/**
 * BrewChecker — 检测 Harmonybrew / deepseek-harness 安装状态。
 *
 * 检测走 libdsh_launcher.so 的 NAPI checkInstall()（应用主进程内 access，
 * 与 launchDsh/installDsh 同一上下文）。注意不能用
 * childProcessManager.startNativeChildProcess（appspawn 子进程在独立沙箱，
 * 访问不到 /storage/Users/currentUser，会误报未安装）；fileIo 直接访问
 * 用户目录同样被沙箱拦截，仅作为 NAPI 异常时的兜底。
 */
export class BrewChecker {
  static async check(context: common.UIAbilityContext): Promise<BrewCheckResult> {
    try {
      const content: string = launcher.checkInstall();
      const result: BrewCheckResult = BrewChecker.parseResult(content);
      HdshLogger.info(TAG, 'brew check result: brew=' + result.brewInstalled +
        ' dsh=' + result.dshInstalled + ' path=' + result.dshPath);
      return result;
    } catch (e) {
      HdshLogger.error(TAG, 'launcher.checkInstall failed: ' + String(e));
      // Fallback: check files directly from ArkTS side
      return BrewChecker.checkDirect(context);
    }
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
}
