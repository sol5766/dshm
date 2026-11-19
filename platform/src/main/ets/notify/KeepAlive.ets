/**
 * 长时任务（后台保活）机制封装。
 *
 * 存在理由（D1 §7.7.2 / D3 §6 后台补偿）：
 *   审批与提问是**随时随地**到达的。若应用退到后台就断连，用户会漏掉待决事项——
 *   这直接违反 G5「从收到通知到完成答复 ≤ 2 步」。
 *   HarmonyOS 的解法是申请**长时任务**（continuous task），使进程不被挂起、网络不被释放。
 *
 * 为什么分两档：
 *   - PC / 2in1 的后台主体是 Agent / 模型计算，走 `TASK_KEEPING`；
 *   - 手持档兼容原有 `DATA_TRANSFER` 路径（只在确有在途任务时申请）。
 *   官方对 `DATA_TRANSFER` 有硬约束：首次进度超过 10 分钟未更新就会被系统取消。
 *   MatePad Edge 真机日志已抓到该取消发生，随后整个进程进入冻结周期，因此 PC/2in1
 *   不能再用 DATA_TRANSFER 冒充计算任务。用 AUDIO_PLAYBACK 骗保活仍明确禁止。
 *
 * 设计要点：
 *   - 保活是**可选**的：申请失败只降级（回到前台时补拉待决），不能让应用不可用；
 *   - 引用计数式：多个窗口/多条连接可能都要保活，最后一个释放才真正停止任务；
 *   - 任务 id 记录下来，便于诊断页显示「后台保活中」与释放。
 */

import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { wantAgent, WantAgent, common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/keepalive';
const DIAG_FILE: string = 'diag-keepalive';

/** 保活状态（诊断页展示） */
export interface KeepAliveFacts {
  /** 是否已成功申请长时任务 */
  active: boolean;
  /** 当前引用计数 */
  refs: number;
  /** 最近一次失败原因（空串表示无失败） */
  lastError: string;
  /** 最近一次**被取消**的原因（`USER_CANCEL` / `SYSTEM_CANCEL` / …；空串表示没被取消过） */
  cancelReason: string;
  /**
   * 用户是否主动停过（删长时任务通知 / 手动取消）。
   *
   * 【为什么要记它】官方《Background Tasks Kit 接入规范》禁止「用户主动停止并取消长时任务后**立即**再次申请」
   * ⇒ 本标志置真后 `acquire()` 直接拒绝，直到**回到前台再进后台**（`noteForeground()` 清标志）——
   * 也就是"这一轮后台周期里用户说了不要，就别再弹"。
   */
  userStopped: boolean;
}

export class KeepAlive {
  private context?: common.UIAbilityContext;
  private refs: number = 0;
  private active: boolean = false;
  private lastError: string = '';
  private cancelReason: string = '';
  private userStopped: boolean = false;
  /** 取消监听只注册一次（`attach()` 可能被多次调用：多窗口、重建） */
  private cancelListenerReady: boolean = false;
  /**
   * 本后台周期"我们是否想保活"（由 EntryAbility 在 onBackground/onForeground 告知）。
   * 它是**系统取消后是否续期**的唯一判据：用户主动停过 ⇒ 不续；系统按业务规则取消 ⇒ 续。
   */
  private backgroundWanted: boolean = false;
  /** 续期退避基数（ms）：避开"立即重申请"的观感与系统节流（官方只禁用户停后立即再申请）。 */
  /**
   * 续期退避基数（毫秒）。
   *
   * ⚠️ 2026-10-31（docs/326）：旧值是 10000 + 最多 3 次 = **总共 60 秒窗口**。
   * 而 `DATA_TRANSFER` 的系统取消点是"首次进度后 **10 分钟**（600s）没有更新"——
   * 也就是说：熄屏 10 分钟时任务被取消，我们只有 60 秒的续期窗口，
   * 一旦这个窗口内没续上（熄屏时 JS 定时器被冻结，几乎必然没续上），
   * 本次后台周期就**再也不会尝试**，直到用户解锁让定时器解冻。
   * 现在基数降到 5s、次数提到 8 次，窗口约 5+10+…+40 ≈ 3 分钟，
   * 足以覆盖"熄屏-解锁"之间的抖动，且不会变成无限重试。
   */
  private static readonly RENEW_BASE_DELAY_MS: number = 5000;
  /** 单次后台周期内最多续期几次（连续失败就放弃，只留诊断）。 */
  /**
   * 续期最多尝试次数。
   *
   * 旧值 3 → 见 `RENEW_BASE_DELAY_MS` 的说明（60 秒窗口撑不过一次熄屏）。
   * 8 次配合 5s 基数，退避序列 5/10/15/…/40s，总窗口约 3 分钟。
   */
  private static readonly RENEW_MAX_ATTEMPTS: number = 8;
  private renewAttempts: number = 0;
  private renewTimer: number = -1;
  /**
   * 是否有一次 `acquire` 正在申请（已决定要，但系统回调还没回来）。
   *
   * 【为什么必须有】熄屏事件与 `onBackground` 可能几乎同时到达：
   * 前者会走 `noteScreenState()` 的"停-起校准"，后者会走 `acquire()`。
   * 两条 `startBackgroundRunning` 并发时，后到的那条会报"任务已存在"并把
   * `active` 覆写成 false（任务其实在跑）⇒ 后续判据全错、甚至提前释放。
   * 申请在途时让 `noteScreenState()` 只记诊断、不重复申请。
   */
  private pendingAcquire: boolean = false;
  private releaseGeneration: number = 0;
  private systemTail: Promise<void> = Promise.resolve();
  private pendingStops: number = 0;

  private serializeSystem(operation: () => Promise<boolean>): Promise<boolean> {
    const result: Promise<boolean> = this.systemTail.then(operation);
    this.systemTail = result.then(() => {}, () => {});
    return result;
  }
  /** 最近一次成功申请用的类型：续期沿用同一类型（手持档恒 DATA_TRANSFER，见 E4 口径）。 */
  private lastMode: backgroundTaskManager.BackgroundMode
    = backgroundTaskManager.BackgroundMode.DATA_TRANSFER;
  private lastModeLabel: string = 'DATA_TRANSFER';

  attach(context: common.UIAbilityContext): void {
    this.context = context;
    this.installCancelListener();
  }

  /** 长时任务模式最终由系统判定；hilog 在本机并不总能取到，故落一份可回传的短日志。 */
  private writeDiag(detail: string): void {
    const ctx: common.UIAbilityContext | undefined = this.context;
    if (ctx === undefined) {
      return;
    }
    try {
      const path: string = `${ctx.filesDir}/${DIAG_FILE}`;
      const file: fileIo.File = fileIo.openSync(path,
        fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.APPEND);
      fileIo.writeSync(file.fd, `${new Date().toISOString()} ${detail}\n`);
      fileIo.closeSync(file);
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, 'diag-keepalive 写入失败：%{public}s', e.message);
    }
  }

  /**
   * 注册「长时任务被取消」监听（API 15+，`backgroundTaskManager.on('continuousTaskCancel')`）。
   *
   * 【为什么必须有】用户把通知划掉 / 系统因业务不符撤回时，任务已经被平台取消，但我们这边的
   * `active` 还是旧值 ⇒ 之后所有判断都会基于一个假事实。这里把真因记下来并置 `userStopped`
   * （用户主动停的那两种 reason），`acquire()` 据此拒绝"立即再申请"。
   *
   * 失败只记日志：老设备/老系统没有这个 API 时降级为"不感知取消"，不影响保活本身。
   */
  private installCancelListener(): void {
    if (this.cancelListenerReady) {
      return;
    }
    try {
      backgroundTaskManager.on('continuousTaskCancel', (info: backgroundTaskManager.ContinuousTaskCancelInfo) => {
        this.active = false;
        this.cancelReason = `reason=${info.reason} id=${info.id}`;
        // USER_CANCEL = 1（用户取消）、USER_CANCEL_REMOVE_NOTIFICATION = 3（预留：删通知）
        if (info.reason === backgroundTaskManager.ContinuousTaskCancelReason.USER_CANCEL
          || info.reason === backgroundTaskManager.ContinuousTaskCancelReason.USER_CANCEL_REMOVE_NOTIFICATION) {
          this.userStopped = true;
        }
        hilog.info(DOMAIN, TAG, '长时任务被取消：%{public}s（userStopped=%{public}s）',
          this.cancelReason, this.userStopped ? 'true' : 'false');
        this.writeDiag(`cancel ${this.cancelReason} userStopped=${this.userStopped ? 'true' : 'false'}`);
        /*
         * 【系统取消 ⇒ 退避续期（2026-10-28，用户反馈"熄屏就断"）】
         *
         * 手持档只能用 `DATA_TRANSFER`（非 PC/2in1 用 `TASK_KEEPING` 需要受限 ACL
         * `KEEP_BACKGROUND_RUNNING_SYSTEM`，本仓权限铁律恒 17/9 条 ⇒ 加不了），
         * 而它的官方契约是"首次进度超过 10 分钟未更新即被取消"（`docs/209` 已抓到 603s 现场）。
         * 于是"熄屏一段时间就断"是**必然而不是偶发**。唯一能做的就是**被取消后续期**：
         * 官方接入规范只禁止"**用户主动停止**后立即再次申请"，系统侧取消不受此限。
         */
        const userInitiated: boolean = this.userStopped;
        if (!userInitiated && this.backgroundWanted && this.refs > 0) {
          this.scheduleRenew();
        } else {
          this.writeDiag(`renew 跳过（userInitiated=${userInitiated}`
            + ` wanted=${this.backgroundWanted} refs=${this.refs}）`);
        }
      });
      this.cancelListenerReady = true;
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, '注册长时任务取消监听失败（降级：不感知取消）：%{public}s', e.message);
    }
  }

  /**
   * EntryAbility 告知"本后台周期是否想保活"。
   * 置假时顺手清掉续期状态（回前台/无事时不该再续）。
   */
  noteBackground(wanted: boolean): void {
    this.backgroundWanted = wanted;
    if (!wanted) {
      this.clearRenew();
    }
  }

  /** 把"为什么判成需要/不需要保活"落 diag（真机反馈可逐项对账）。 */
  recordNeed(note: string): void {
    this.writeDiag(`need ${note}`);
  }

  private clearRenew(): void {
    if (this.renewTimer !== -1) {
      clearTimeout(this.renewTimer);
      this.renewTimer = -1;
    }
    this.renewAttempts = 0;
  }

  /** 退避排一次续期；连续失败到上限就放弃（只留一行诊断，不无限重试）。 */
  private scheduleRenew(): void {
    if (this.renewAttempts >= KeepAlive.RENEW_MAX_ATTEMPTS) {
      this.writeDiag(`renew 放弃（已连续 ${this.renewAttempts} 次）`);
      hilog.warn(DOMAIN, TAG, '长时任务续期放弃（已连续 %{public}d 次）', this.renewAttempts);
      return;
    }
    if (this.renewTimer !== -1) {
      clearTimeout(this.renewTimer);
    }
    const delay: number = KeepAlive.RENEW_BASE_DELAY_MS * (this.renewAttempts + 1);
    this.renewTimer = setTimeout(() => {
      this.renewTimer = -1;
      this.renewNow();
    }, delay);
    this.writeDiag(`renew 计划第 ${this.renewAttempts + 1} 次，${delay}ms 后（${this.lastModeLabel}）`);
  }

  /**
   * 真的重申请一次。**不动引用计数**（`refs` 仍代表"有几方想要保活"），
   * 成功即恢复 `active`；失败继续退避。
   */
  private async renewNow(): Promise<void> {
    if (this.userStopped || this.active || !this.backgroundWanted || this.context === undefined) {
      return;
    }
    this.renewAttempts++;
    const ok: boolean = await this.requestMode(this.lastMode, this.lastModeLabel);
    if (ok) {
      this.renewAttempts = 0;
      this.writeDiag('renew 成功');
      hilog.info(DOMAIN, TAG, '长时任务已续期（%{public}s）', this.lastModeLabel);
      return;
    }
    this.scheduleRenew();
  }

  /**
   * 屏幕状态变化时的**显式校准**（2026-10-31，docs/326）。
   *
   * 【为什么必须在熄屏瞬间做一次】`DATA_TRANSFER` 的续期依赖 `setTimeout`，
   * 而熄屏后 JS 定时器会被系统冻结 —— 等"被取消后再续期"这条路径在熄屏场景下
   * 天然失效（回调要等解锁后才跑）。唯一可靠的做法是：
   * **在屏幕即将熄灭前，主动把长时任务重新申请一次**，让系统的"10 分钟无进度"
   * 计时从现在重新开始，从而把取消点尽量往后推。
   *
   * @param screenOff true = 屏幕熄灭前；false = 屏幕亮起后
   * @param skipIfPending 申请在途时是否跳过本次校准（入口默认 false = 行为不变；
   *        entry 壳在熄屏分支传 true，避免与 onBackground 的 acquire 并发 start）
   * @returns 是否处于保活状态
   */
  async noteScreenState(screenOff: boolean, skipIfPending: boolean = false): Promise<boolean> {
    const generation: number = this.releaseGeneration;
    /*
     * 【为什么要看 active 而不是只看 refs】熄屏事件的到达时机不确定：
     *   · 用户在前台直接熄屏 → 此时手持档还没申请保活（`refs = 0`），
     *     但**应用马上要进入后台**，正是需要保活的时刻；
     *   · 已在后台且保活着 → `refs > 0 && active`，只需重置计时。
     * 若只在 `refs > 0` 时才动作，第一种情况（最常见的"看着看着锁屏"）会被整个跳过。
     * ⇒ 判据放宽为：**有上下文，且（有引用 或 当前正处于保活）**就校准。
     */
    const wanted: boolean = this.refs > 0 || this.active;
    if (this.context === undefined || !wanted) {
      this.writeDiag(`screen ${screenOff ? 'off' : 'on'} 跳过（无保活诉求 refs=${this.refs} active=${this.active}）`);
      return this.active;
    }
    if (this.userStopped) {
      /* 用户主动停过：官方规范禁止立即再申请，熄屏也不例外 */
      this.writeDiag(`screen ${screenOff ? 'off' : 'on'} 跳过（用户已停保活）`);
      return false;
    }
    if (skipIfPending && this.pendingAcquire) {
      /* 另一条链（onBackground / 熄屏补申请）正在申请：不并发 startBackgroundRunning，
         否则后到的那条会报"任务已存在"并把 active 覆写成 false。
         默认不启用，phone 壳保持原有行为不变。 */
      this.writeDiag(`screen ${screenOff ? 'off' : 'on'} 跳过（保活申请在途）`);
      return this.active;
    }
    if (screenOff && this.refs <= 0 && !this.active) {
      /*
       * 熄屏时还没有任何保活诉求（典型："看着看着锁屏"）。
       * 这时**不抢着申请** —— 应用还在前台，没有后台工作要做；真正需要保活是
       * `onBackground` 之后（那条链自己会调用 `acquire()`）。
       * 抢申请只会在前台多挂一条"正在运行后台任务"的通知，冒犯用户。
       */
      this.writeDiag('screen off 跳过（应用仍在前台、无保活诉求）');
      return false;
    }
    if (screenOff) {
      this.writeDiag('screen off ⇒ 主动重申请长时任务（重置系统的无进度计时）');
      hilog.info(DOMAIN, TAG, '熄屏前主动续期长时任务（%{public}s）', this.lastModeLabel);
      /*
       * 先停再起：系统对"已经在跑的任务"再次 startBackgroundRunning 会返回
       * "任务已存在"，不会重置计时。停-起是**唯一**能把 600s 计时归零的手段。
       * 期间 active 短暂为 false 是预期的，调用方应把它当作"正在校准"而非"已丢失"。
       */
      await this.stopForRenew();
      if (generation !== this.releaseGeneration) { return false; }
      const ok: boolean = await this.requestMode(this.lastMode, this.lastModeLabel);
      if (!ok) {
        /* 熄屏瞬间起不来就退避重试（解锁后定时器解冻会继续跑） */
        this.scheduleRenew();
      }
      return ok;
    }
    /* 亮屏后：若此刻还没保活，立刻补一次（不等退避），并重置退避计数 */
    this.renewAttempts = 0;
    if (this.active) {
      return true;
    }
    this.writeDiag('screen on ⇒ 立即补申请长时任务');
    const ok: boolean = await this.requestMode(this.lastMode, this.lastModeLabel);
    if (!ok) {
      this.scheduleRenew();
    }
    return ok;
  }

  /** 只停任务、不动引用计数（供 `noteScreenState` 的"停-起"使用）。 */
  private async stopForRenew(): Promise<void> {
    await this.serializeSystem(async (): Promise<boolean> => {
      await this.stopForRenewOwned();
      return false;
    });
  }

  private async stopForRenewOwned(): Promise<void> {
    const ctx: common.UIAbilityContext | undefined = this.context;
    if (!this.active || ctx === undefined) {
      return;
    }
    try {
      await backgroundTaskManager.stopBackgroundRunning(ctx);
      this.active = false;
      this.writeDiag('stopForRenew 成功');
    } catch (err) {
      const e = err as BusinessError;
      this.active = false;
      this.writeDiag(`stopForRenew 失败 ${e.code}: ${e.message}`);
    }
  }

  /** 回到前台时调用：清掉"用户已停"的标志（下一个后台周期允许重新申请）。 */
  noteForeground(): void {
    if (this.userStopped) {
      hilog.info(DOMAIN, TAG, '已回前台：清掉「用户停过保活」标志（下次进后台可重新申请）');
    }
    this.userStopped = false;
  }

  /**
   * 申请保活（引用计数 +1）。
   *
   * 调用方约定：连接建立且用户开启了「后台保持连接」时申请；连接断开或用户关闭开关时释放。
   * @returns 是否处于保活状态（false 表示降级运行，不阻断任何功能）
   */
  async acquire(): Promise<boolean> {
    return this.acquireWithMode(backgroundTaskManager.BackgroundMode.DATA_TRANSFER,
      'DATA_TRANSFER', false);
  }

  /**
   * PC / 2in1 专用：优先申请计算型长时任务；设备不支持时降级回 DATA_TRANSFER。
   *
   * 为什么要降级：设备能力最终由系统判定。即使应用层把 MatePad Edge 识别为 desktop，
   * 某些平板形态仍可能暂时按非 PC/2in1 执行策略。TASK_KEEPING 被拒时保留旧路径，
   * 至少维持 10 分钟，并让诊断日志给出明确原因。
   */
  async acquireTaskKeeping(): Promise<boolean> {
    return this.acquireWithMode(backgroundTaskManager.BackgroundMode.TASK_KEEPING,
      'TASK_KEEPING', true);
  }

  private async acquireWithMode(mode: backgroundTaskManager.BackgroundMode,
    modeLabel: string, fallbackToDataTransfer: boolean): Promise<boolean> {
    const generation: number = this.releaseGeneration;
    if (this.userStopped) {
      hilog.info(DOMAIN, TAG, '本后台周期内用户已手动停止保活 ⇒ 不再申请（官方接入规范禁止立即重申请）');
      return false;
    }
    if (this.active && this.pendingStops === 0) {
      this.refs++;
      return true;
    }
    if (this.context === undefined) {
      return false;
    }
    this.pendingAcquire = true;
    const requested: boolean = await this.requestMode(mode, modeLabel);
    this.pendingAcquire = false;
    if (generation !== this.releaseGeneration) { return false; }
    if (requested || !fallbackToDataTransfer) {
      if (requested) {
        this.refs++;
      }
      return requested;
    }
    this.writeDiag(`fallback ${modeLabel} -> DATA_TRANSFER`);
    hilog.warn(DOMAIN, TAG, 'TASK_KEEPING 不可用 ⇒ 降级 DATA_TRANSFER（长时任务仍受 10 分钟进度约束）');
    this.pendingAcquire = true;
    const fallback: boolean = await this.requestMode(backgroundTaskManager.BackgroundMode.DATA_TRANSFER, 'DATA_TRANSFER');
    this.pendingAcquire = false;
    if (generation !== this.releaseGeneration) { return false; }
    if (fallback) {
      this.refs++;
    }
    return fallback;
  }

  private async requestMode(mode: backgroundTaskManager.BackgroundMode,
    modeLabel: string): Promise<boolean> {
    const generation: number = this.releaseGeneration;
    return this.serializeSystem(async (): Promise<boolean> => {
      if (generation !== this.releaseGeneration) { return false; }
      if (this.active) { return true; }
      return this.requestModeOwned(mode, modeLabel, generation);
    });
  }

  private async requestModeOwned(mode: backgroundTaskManager.BackgroundMode,
    modeLabel: string, generation: number): Promise<boolean> {
    const ctx: common.UIAbilityContext | undefined = this.context;
    if (ctx === undefined) {
      return false;
    }
    try {
      const info: wantAgent.WantAgentInfo = {
        wants: [
          {
            bundleName: ctx.abilityInfo.bundleName,
            abilityName: ctx.abilityInfo.name
          }
        ],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: 1
      };
      const agent: WantAgent = await wantAgent.getWantAgent(info);
      if (generation !== this.releaseGeneration) { return false; }
      // 用「单一类型」重载而不是 `string[]` 重载：
      // SDK 里 `BackgroundMode` 是**数值枚举**（DATA_TRANSFER = 1、TASK_KEEPING = 9），
      // 而数组重载声明的是 `string[]`，数值枚举不能赋给 string（编译期直接报错）。
      // 单一类型重载的参数类型就是 `BackgroundMode`。
      await backgroundTaskManager.startBackgroundRunning(ctx, mode, agent);
      if (generation !== this.releaseGeneration) {
        await backgroundTaskManager.stopBackgroundRunning(ctx);
        return false;
      }
      this.active = true;
      this.lastMode = mode;
      this.lastModeLabel = modeLabel;
      this.lastError = '';
      this.writeDiag(`写入 mode=${modeLabel} active=true`);
      hilog.info(DOMAIN, TAG, '长时任务已申请（%{public}s）', modeLabel);
    } catch (err) {
      const e = err as BusinessError;
      // 常见拒绝原因：未授予 KEEP_BACKGROUND_RUNNING、后台类型与场景不符、电量策略
      this.lastError = `${modeLabel} 申请失败 ${e.code}: ${e.message}`;
      this.active = false;
      this.writeDiag(`写入 mode=${modeLabel} active=false error=${this.lastError}`);
      hilog.warn(DOMAIN, TAG, 'startBackgroundRunning(%{public}s) failed: %{public}s',
        modeLabel, this.lastError);
    }
    return this.active;
  }

  /** 释放保活（引用计数 -1；归零才真正停止长时任务）。 */
  async release(): Promise<void> {
    if (this.refs > 0) {
      this.refs--;
    }
    if (this.refs > 0) {
      return;
    }
    /* 引用归零 ⇒ 不再需要保活：连带清掉续期与后台期许（避免"没人要了还在续"）。 */
    this.releaseGeneration++;
    this.backgroundWanted = false;
    this.clearRenew();
    this.pendingStops++;
    try {
      await this.serializeSystem(async (): Promise<boolean> => {
        await this.stopForRenewOwned();
        return false;
      });
    } finally {
      this.pendingStops--;
    }
    return;
  }

  /** 无视引用计数强制释放（切换 Host / 退出应用时使用，避免任务泄漏）。 */
  async forceRelease(): Promise<void> {
    this.releaseGeneration++;
    this.refs = 0;
    await this.release();
  }

  facts(): KeepAliveFacts {
    return {
      active: this.active,
      refs: this.refs,
      lastError: this.lastError,
      cancelReason: this.cancelReason,
      userStopped: this.userStopped
    };
  }
}
