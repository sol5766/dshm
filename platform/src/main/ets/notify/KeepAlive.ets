/**
 * 长时任务（后台保活）机制封装。
 *
 * 存在理由（D1 §7.7.2 / D3 §6 后台补偿）：
 *   审批与提问是**随时随地**到达的。若应用退到后台就断连，用户会漏掉待决事项——
 *   这直接违反 G5「从收到通知到完成答复 ≤ 2 步」。
 *   HarmonyOS 的解法是申请**长时任务**（continuous task），使进程不被挂起、网络不被释放。
 *
 * 为什么用 DATA_TRANSFER：
 *   长时任务类型必须与「用户可感知的任务」相符。本应用在后台做的是维持与 Host 的
 *   长连接并收发会话数据，语义上属于数据传输；用 AUDIO_PLAYBACK 之类的类型去骗保活
 *   属于滥用系统能力，会被审核拒绝，也会误导用户（通知栏会显示在放音乐）。
 *
 * 设计要点：
 *   - 保活是**可选**的：申请失败只降级（回到前台时补拉待决），不能让应用不可用；
 *   - 引用计数式：多个窗口/多条连接可能都要保活，最后一个释放才真正停止任务；
 *   - 任务 id 记录下来，便于诊断页显示「后台保活中」与释放。
 */

import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { wantAgent, WantAgent, common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/keepalive';

/** 保活状态（诊断页展示） */
export interface KeepAliveFacts {
  /** 是否已成功申请长时任务 */
  active: boolean;
  /** 当前引用计数 */
  refs: number;
  /** 最近一次失败原因（空串表示无失败） */
  lastError: string;
}

export class KeepAlive {
  private context?: common.UIAbilityContext;
  private refs: number = 0;
  private active: boolean = false;
  private lastError: string = '';

  attach(context: common.UIAbilityContext): void {
    this.context = context;
  }

  /**
   * 申请保活（引用计数 +1）。
   *
   * 调用方约定：连接建立且用户开启了「后台保持连接」时申请；连接断开或用户关闭开关时释放。
   * @returns 是否处于保活状态（false 表示降级运行，不阻断任何功能）
   */
  async acquire(): Promise<boolean> {
    this.refs++;
    if (this.active || this.context === undefined) {
      return this.active;
    }
    try {
      const info: wantAgent.WantAgentInfo = {
        wants: [
          {
            bundleName: this.context.abilityInfo.bundleName,
            abilityName: this.context.abilityInfo.name
          }
        ],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: 1
      };
      const agent: WantAgent = await wantAgent.getWantAgent(info);
      // 用「单一类型」重载而不是 `string[]` 重载：
      // SDK 里 `BackgroundMode` 是**数值枚举**（DATA_TRANSFER = 1），
      // 而数组重载声明的是 `string[]`，数值枚举不能赋给 string（编译期直接报错）。
      // 单一类型重载的参数类型就是 `BackgroundMode`，语义也正好够用——
      // 我们只需要「数据传输」这一种后台类型。
      await backgroundTaskManager.startBackgroundRunning(this.context,
        backgroundTaskManager.BackgroundMode.DATA_TRANSFER, agent);
      this.active = true;
      this.lastError = '';
      hilog.info(DOMAIN, TAG, '长时任务已申请（DATA_TRANSFER）');
    } catch (err) {
      const e = err as BusinessError;
      // 常见拒绝原因：未授予 KEEP_BACKGROUND_RUNNING、后台类型与场景不符、电量策略
      this.lastError = `申请失败 ${e.code}: ${e.message}`;
      this.active = false;
      hilog.warn(DOMAIN, TAG, 'startBackgroundRunning failed: %{public}s', this.lastError);
    }
    return this.active;
  }

  /** 释放保活（引用计数 -1；归零才真正停止长时任务）。 */
  async release(): Promise<void> {
    if (this.refs > 0) {
      this.refs--;
    }
    if (this.refs > 0 || !this.active || this.context === undefined) {
      return;
    }
    try {
      await backgroundTaskManager.stopBackgroundRunning(this.context);
      this.active = false;
      hilog.info(DOMAIN, TAG, '长时任务已释放');
    } catch (err) {
      const e = err as BusinessError;
      this.lastError = `释放失败 ${e.code}: ${e.message}`;
      hilog.warn(DOMAIN, TAG, 'stopBackgroundRunning failed: %{public}s', e.message);
    }
  }

  /** 无视引用计数强制释放（切换 Host / 退出应用时使用，避免任务泄漏）。 */
  async forceRelease(): Promise<void> {
    this.refs = 0;
    await this.release();
  }

  facts(): KeepAliveFacts {
    return { active: this.active, refs: this.refs, lastError: this.lastError };
  }
}
