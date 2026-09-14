/**
 * 应用级动作：重启 / 停止 DSH 服务。
 *
 * 为什么单独抽一层：`restartDsh` 里那套「先停旧、等它真退出、再按当前模式拉起」的顺序
 * 是踩过坑才收敛出来的（不等旧实例退出就拉起 → 新旧抢 3080），必须只有一份实现。
 * 目前调用方是应用内 Harness 菜单（DshmWebPage）；早期它还同时服务托盘/Dock 的系统级
 * 菜单入口，那些入口已移除（原因见 QuickBarMenuCleanup.ets）。
 */
import { common } from '@kit.AbilityKit';
import { commonEventManager } from '@kit.BasicServicesKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo } from '@kit.CoreFileKit';
import { DshBootstrap } from '../bootstrap/DshBootstrap';
import { DshmLogger } from '../utils/Logger';

const TAG: string = 'DshmAppActions';

/**
 * 重启流程诊断文件：hilog 在部分设备上读不到应用日志（实测 2in1 上 `hilog -x`
 * 里没有本应用的 tag），而"重启/退出"是必须能查证的动作，因此把关键步骤写成文件。
 */
const DIAG_FILE: string = 'restart-diag.txt';

/**
 * 「重启完成」事件：dsh 每次启动都会换一个鉴权 token，页面必须重新用新 URL 加载，
 * 否则停在 401/旧连接上。重启方（主进程）广播本事件，页面收到即重新 loadUrl。
 */
export const EVENT_RESTART_DONE: string = 'dshm.dsh.restarted';

export class DshmAppActions {
  /** 已创建的订阅者，避免被 GC 回收后收不到事件。 */
  private static subscribers: Array<commonEventManager.CommonEventSubscriber> = [];

  /**
   * 重启 DSH 服务。
   *
   * 顺序（每一步都有理由）：
   *   1. 按**当前生效模式**停掉旧实例，并等它真正退出（host 等 host-stopped、
   *      embedded 等 node-exited）—— 旧实例的监听套接字必须先释放，否则新实例
   *      绑不上 3080，或两个实例交替抢端口；
   *   2. 清上一轮 node 日志与陈旧 boot-state（就绪判据要读新日志）；
   *   3. 重做 profile 镜像（env 版本变化会清空 profiles/node_modules，不重做则
   *      ERR_MODULE_NOT_FOUND: dshm-terminal）；
   *   4. launchDsh() 起一个**读当前 runtime-mode.txt** 的 native 进程，因此切换模式
   *      后不需要额外分支；
   *   5. 等 `dsh web:` 标记出现（文件读取，可靠），成功后广播重启完成事件。
   *
   * @returns 服务是否已在超时内就绪
   */
  static async restartDsh(context: common.UIAbilityContext): Promise<boolean> {
    const oldMode: string = DshBootstrap.readActiveMode(context).mode;
    DshmAppActions.appendDiag(context, 'restartDsh 开始 oldMode=' + oldMode);
    const stopped: boolean = await DshBootstrap.stopDsh(context, oldMode, 30000);
    DshmAppActions.appendDiag(context, 'stopDsh stopped=' + String(stopped));
    if (!stopped) {
      DshmLogger.error(TAG, '旧实例未在超时内退出（mode=' + oldMode + '），取消重启以免抢端口');
      DshmAppActions.appendDiag(context, '放弃：旧实例未退出');
      return false;
    }
    DshBootstrap.clearNodeLogs(context);
    DshBootstrap.ensureBundleMirror(context);
    DshBootstrap.ensureMarketBundle(context);
    await DshBootstrap.launchDsh();
    DshmAppActions.appendDiag(context, 'launchDsh 已发起，等待 web 标记');
    const ready: boolean = await DshBootstrap.waitForWebMarker(context, 120000);
    DshmAppActions.appendDiag(context, 'waitForWebMarker ready=' + String(ready));
    if (ready) {
      DshmLogger.info(TAG, 'DSH 服务已重启并就绪');
      DshmAppActions.publish(EVENT_RESTART_DONE, '重启完成');
    }
    return ready;
  }

  /** 追加一行诊断（best-effort，失败不影响主流程；超过 64KB 先截断，避免长期无限增长）。 */
  private static appendDiag(context: common.UIAbilityContext, line: string): void {
    try {
      const path: string = context.filesDir + '/' + DIAG_FILE;
      let truncate: boolean = false;
      try {
        if (fileIo.accessSync(path) && fileIo.statSync(path).size > 64 * 1024) {
          truncate = true;
        }
      } catch (e) {
        truncate = false;
      }
      const mode: number = truncate
        ? (fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC)
        : (fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.APPEND);
      const f = fileIo.openSync(path, mode);
      fileIo.writeSync(f.fd, new Date().toISOString() + ' ' + line + '\n');
      fileIo.closeSync(f);
    } catch (e) {
      DshmLogger.warn(TAG, '写重启诊断失败: ' + String(e));
    }
  }

  /**
   * 退出应用前先停掉 DSH。
   *
   * 官方文档没有任何一句保证 `terminateSelf()` 会清理应用自己 spawn 的 native
   * 子进程，必须显式停：内嵌模式下发 `kill-request`，native 父进程 kill 掉
   * node 后写 `node-exited`。
   * 超时（默认 8s）后仍然返回，由调用方继续走 terminateSelf，避免"退不掉"。
   */
  static async stopForExit(context: common.UIAbilityContext): Promise<boolean> {
    const mode: string = DshBootstrap.readActiveMode(context).mode;
    return await DshBootstrap.stopDshForExit(context, mode, 8000);
  }

  // ============ 重启完成通知（页面换新 token 重载）============

  /** 页面订阅重启完成，重新用新 token 的 URL 加载 Web UI。 */
  static subscribeRestartDone(handler: () => void): void {
    DshmAppActions.subscribe(EVENT_RESTART_DONE, handler);
  }

  private static publish(event: string, label: string): void {
    commonEventManager.publish(event, (err: BusinessError): void => {
      if (err) {
        DshmLogger.warn(TAG, '发布事件失败（' + label + '）: ' + JSON.stringify(err));
        return;
      }
      DshmLogger.info(TAG, '已发布事件: ' + event + '（' + label + '）');
    });
  }

  private static subscribe(event: string, handler: () => void): void {
    const info: commonEventManager.CommonEventSubscribeInfo = { events: [event] };
    commonEventManager.createSubscriber(info)
      .then((sub: commonEventManager.CommonEventSubscriber): void => {
        DshmAppActions.subscribers.push(sub);
        commonEventManager.subscribe(sub, (err: BusinessError): void => {
          if (err) {
            DshmLogger.warn(TAG, '订阅回调异常（' + event + '）: ' + JSON.stringify(err));
            return;
          }
          DshmLogger.info(TAG, '收到事件: ' + event);
          handler();
        });
      })
      .catch((e: Object): void => {
        DshmLogger.warn(TAG, '创建订阅者失败（' + event + '）: ' + String(e));
      });
  }
}
