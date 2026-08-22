/**
 * DSHM 日志工具（基于 hilog）。
 *
 * 移植自 dsh-OHDSH/HDSH（MIT）：https://gitcode.com/MakeBlackSheepGreat/dsh-OHDSH
 */
import { hilog } from '@kit.PerformanceAnalysisKit';

export class HdshLogger {
  static readonly DOMAIN: number = 0xd511;

  static info(tag: string, message: string): void {
    hilog.info(HdshLogger.DOMAIN, tag, '%{public}s', message);
  }

  static debug(tag: string, message: string): void {
    hilog.debug(HdshLogger.DOMAIN, tag, '%{public}s', message);
  }

  static warn(tag: string, message: string): void {
    hilog.warn(HdshLogger.DOMAIN, tag, '%{public}s', message);
  }

  static error(tag: string, message: string): void {
    hilog.error(HdshLogger.DOMAIN, tag, '%{public}s', message);
  }
}
