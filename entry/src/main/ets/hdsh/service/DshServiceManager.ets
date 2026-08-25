import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { http } from '@kit.NetworkKit';
import launcher from 'libdsh_launcher.so';
import { HdshLogger } from '../utils/Logger';
import { DEFAULT_SERVER_URL, discoverServer, defaultCandidates } from '../../common/ServerDiscovery';
import { loadServerUrl } from '../../common/ServerSettings';

const TAG: string = 'DshServiceManager';

export interface ServiceInfo {
  pid: number;
  url: string;
  port: number;
  selfStarted: boolean;
  message: string;
}

export class DshServiceManager {
  private static readonly SERVICE_FILE: string = 'dsh-service.json';
  private static readonly RESULT_FILE: string = 'dsh-service-result.json';
  private static launcherPid: number = -1;
  private static currentService: ServiceInfo | undefined = undefined;

  static async startDshWeb(context: common.UIAbilityContext, port: number): Promise<string> {
    const filesDir: string = context.filesDir;
    const tmpDir: string = filesDir + '/tmp';
    const logDir: string = filesDir + '/log';
    const resultPath: string = tmpDir + '/' + DshServiceManager.RESULT_FILE;

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
      // NAPI：应用主进程内 fork+exec dsh（继承主进程网络命名空间，
      // dsh 监听的 127.0.0.1:3080 对 ArkWeb 可见；childProcess 子进程在独立 netns 连不上）
      try {
        launcher.physTrace('startDshWeb: invoking launchDsh NAPI');
      } catch (e) {
        HdshLogger.warn(TAG, 'physTrace failed: ' + String(e));
      }
      launcher.launchDsh();
      HdshLogger.info(TAG, 'dsh launcher triggered via NAPI');
    } catch (e) {
      HdshLogger.error(TAG, 'launchDsh failed: ' + String(e));
      return '';
    }

    // Poll for result (up to 60 seconds for dsh web to start)
    const maxAttempts: number = 300;
    for (let i: number = 0; i < maxAttempts; i++) {
      try {
        if (fileIo.accessSync(resultPath)) {
          const content: string = fileIo.readTextSync(resultPath);
          const info: ServiceInfo | undefined = DshServiceManager.parseServiceInfo(content);
          if (info !== undefined) {
            DshServiceManager.currentService = info;
            if (info.url.length > 0) {
              HdshLogger.info(TAG, 'dsh web started: url=' + info.url + ' pid=' + info.pid);
              return info.url;
            }
            if (info.message.length > 0) {
              HdshLogger.error(TAG, 'dsh launch error: ' + info.message);
            }
            return '';
          }
        }
      } catch (e) {
        HdshLogger.warn(TAG, 'Read result failed, attempt ' + String(i));
      }
      await DshServiceManager.sleep(200);
    }

    HdshLogger.error(TAG, 'dsh web start timed out');
    return '';
  }

  static async stopDshWeb(context: common.UIAbilityContext): Promise<void> {
    const service: ServiceInfo | undefined = DshServiceManager.loadServiceInfo(context);
    if (service === undefined) {
      HdshLogger.info(TAG, 'No running service to stop');
      return;
    }
    if (!service.selfStarted) {
      HdshLogger.info(TAG, 'Service was not self-started, not stopping');
      return;
    }
    // dsh 经 setsid 脱离进程组，应用退出后可能残留占用 3080，必须显式 TERM
    if (service.pid > 0) {
      try {
        const ret: number = launcher.stopDsh(service.pid);
        HdshLogger.info(TAG, 'stopDsh pid=' + service.pid + ' ret=' + ret);
      } catch (e) {
        HdshLogger.warn(TAG, 'stopDsh failed: ' + String(e));
      }
    }
    DshServiceManager.clearServiceInfo(context);
    DshServiceManager.currentService = undefined;
    HdshLogger.info(TAG, 'Service stop recorded');
  }

  static async restartDshWeb(context: common.UIAbilityContext): Promise<string> {
    await DshServiceManager.stopDshWeb(context);
    return DshServiceManager.startDshWeb(context, 0);
  }

  static isServiceRunning(): boolean {
    return DshServiceManager.currentService !== undefined;
  }

  static getServiceUrl(): string {
    if (DshServiceManager.currentService !== undefined) {
      return DshServiceManager.currentService.url;
    }
    return '';
  }

  static isSelfStarted(): boolean {
    if (DshServiceManager.currentService !== undefined) {
      return DshServiceManager.currentService.selfStarted;
    }
    return false;
  }

  static loadServiceInfo(context: common.UIAbilityContext): ServiceInfo | undefined {
    const servicePath: string = context.filesDir + '/dsh/' + DshServiceManager.SERVICE_FILE;
    try {
      if (!fileIo.accessSync(servicePath)) {
        return undefined;
      }
      const content: string = fileIo.readTextSync(servicePath);
      return DshServiceManager.parseServiceInfo(content);
    } catch (e) {
      HdshLogger.warn(TAG, 'Load service info failed: ' + String(e));
      return undefined;
    }
  }

  static clearServiceInfo(context: common.UIAbilityContext): void {
    const servicePath: string = context.filesDir + '/dsh/' + DshServiceManager.SERVICE_FILE;
    try {
      if (fileIo.accessSync(servicePath)) {
        fileIo.unlinkSync(servicePath);
      }
    } catch (e) {
      HdshLogger.warn(TAG, 'Clear service info failed: ' + String(e));
    }
  }

  static async probeService(url: string): Promise<boolean> {
    const request = http.createHttp();
    try {
      const resp = await request.request(url + '/', {
        method: http.RequestMethod.GET,
        connectTimeout: 3000,
        readTimeout: 3000
      });
      return resp.responseCode < 500;
    } catch (e) {
      return false;
    } finally {
      request.destroy();
    }
  }

  private static parseServiceInfo(content: string): ServiceInfo | undefined {
    if (content.length === 0) {
      return undefined;
    }
    try {
      const info: ServiceInfo = {
        pid: 0,
        url: '',
        port: 0,
        selfStarted: false,
        message: ''
      };
      // Parse message (launch error description from WriteLaunchError)
      const msgKey: string = '"message":"';
      const msgStart: number = content.indexOf(msgKey);
      if (msgStart >= 0) {
        const valueStart: number = msgStart + msgKey.length;
        const valueEnd: number = content.indexOf('"', valueStart);
        if (valueEnd > valueStart) {
          info.message = content.substring(valueStart, valueEnd);
        }
      }
      // Parse pid
      const pidKey: string = '"pid":';
      const pidStart: number = content.indexOf(pidKey);
      if (pidStart >= 0) {
        const valueStart: number = pidStart + pidKey.length;
        let valueEnd: number = valueStart;
        while (valueEnd < content.length && content[valueEnd] >= '0' && content[valueEnd] <= '9') {
          valueEnd++;
        }
        if (valueEnd > valueStart) {
          info.pid = parseInt(content.substring(valueStart, valueEnd), 10);
        }
      }
      // Parse url
      const urlKey: string = '"url":"';
      const urlStart: number = content.indexOf(urlKey);
      if (urlStart >= 0) {
        const valueStart: number = urlStart + urlKey.length;
        const valueEnd: number = content.indexOf('"', valueStart);
        if (valueEnd > valueStart) {
          info.url = content.substring(valueStart, valueEnd);
        }
      }
      // Parse port
      const portKey: string = '"port":';
      const portStart: number = content.indexOf(portKey);
      if (portStart >= 0) {
        const valueStart: number = portStart + portKey.length;
        let valueEnd: number = valueStart;
        while (valueEnd < content.length && content[valueEnd] >= '0' && content[valueEnd] <= '9') {
          valueEnd++;
        }
        if (valueEnd > valueStart) {
          info.port = parseInt(content.substring(valueStart, valueEnd), 10);
        }
      }
      // Parse selfStarted
      info.selfStarted = content.includes('"selfStarted":true');
      return info;
    } catch (e) {
      HdshLogger.error(TAG, 'parse service info failed: ' + String(e));
      return undefined;
    }
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void) => {
      setTimeout(resolve, ms);
    });
  }
}
