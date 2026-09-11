/**
 * DSHM 日志工具（基于 hilog）。
 */
import { hilog } from '@kit.PerformanceAnalysisKit';

export class DshmLogger {
  static readonly DOMAIN: number = 0x0001;

  static info(tag: string, message: string): void {
    hilog.info(DshmLogger.DOMAIN, tag, '%{public}s', message);
  }

  static debug(tag: string, message: string): void {
    hilog.debug(DshmLogger.DOMAIN, tag, '%{public}s', message);
  }

  static warn(tag: string, message: string): void {
    hilog.warn(DshmLogger.DOMAIN, tag, '%{public}s', message);
  }

  static error(tag: string, message: string): void {
    hilog.error(DshmLogger.DOMAIN, tag, '%{public}s', message);
  }
}
