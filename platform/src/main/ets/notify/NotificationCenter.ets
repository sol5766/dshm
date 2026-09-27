/**
 * 通知发布与撤回（Notification Kit 机制封装）。
 *
 * 覆盖 D3 §6「通知规范」中**与系统交互**的部分：
 *   - 三类渠道（决策 / 结果 / 系统状态）的创建与等级映射；
 *   - 发布、按去重键撤回、全部撤回；
 *   - 点击直达（wantAgent 携带路由描述）。
 *
 * 不在这里的部分：文案、优先级判定、去重键算法——那些是产品策略，放在 appstate。
 *
 * 关键实现约束（D3 §6「通知去重」）：
 *   「同一审批/提问的多端处理只推一次；处理完成后主动撤回」。
 *   因此本类必须维护 `key → notificationId` 映射，撤回时按 key 找回 id。
 *   另一端的处理结果通过事件流到达后，由上层调用 `withdraw(key)` 完成撤回。
 */

import { notificationManager } from '@kit.NotificationKit';
import { wantAgent, WantAgent, common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { NotificationDraft, NotifyFacts, NotifyPriority, NotifyRoute } from './NotifyTypes';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/notify';

/** 通知 id 分配基准：避开长时任务通知等系统占用的低位 id */
const ID_BASE: number = 10000;

/**
 * 字符串 → 稳定正整数。
 *
 * 用途：把「去重键」映射成系统需要的数字通知 id。
 * 必须是**稳定**的（同一 key 每次都得到同一 id），否则撤回会找不到目标；
 * 用 FNV-1a 而不是语言内置 hash，避免不同实现对同一字符串给出不同结果。
 */
export function stableId(key: string): number {
  let h: number = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h = h ^ key.charCodeAt(i);
    // 乘以 FNV 质数 16777619，用移位加法避免 32 位溢出丢失精度
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return ID_BASE + (h % 100000);
}

export class NotificationCenter {
  private context?: common.UIAbilityContext;
  private slotsReady: boolean = false;
  private enabled: boolean = false;
  private lastError: string = '';
  /** 去重键 → 已发布的通知 id */
  private live: Map<string, number> = new Map();

  /** 绑定 UIAbility 上下文。必须在发布前调用。 */
  attach(context: common.UIAbilityContext): void {
    this.context = context;
  }

  /** 是否可用（未绑定上下文时不可用） */
  isAttached(): boolean {
    return this.context !== undefined;
  }

  /**
   * 查询并（首次）申请通知授权。
   *
   * D3 §6 要求「渠道可单独配置；静默时段可用」，因此授权失败**不是错误**，
   * 只是降级：调用方应继续把待决项留在应用内可见（不许因为没通知就丢事件）。
   */
  async ensureEnabled(): Promise<boolean> {
    try {
      this.enabled = await notificationManager.isNotificationEnabled();
      if (this.enabled) {
        return true;
      }
      // 仅会弹一次；用户拒绝后不再弹
      await notificationManager.requestEnableNotification(this.context);
      this.enabled = await notificationManager.isNotificationEnabled();
      return this.enabled;
    } catch (err) {
      const e = err as BusinessError;
      this.lastError = `授权查询失败 ${e.code}: ${e.message}`;
      hilog.warn(DOMAIN, TAG, 'ensureEnabled failed: %{public}s', this.lastError);
      this.enabled = false;
      return false;
    }
  }

  /** 创建三类渠道。重复调用安全（已存在时系统忽略）。 */
  async ensureSlots(): Promise<void> {
    if (this.slotsReady) {
      return;
    }
    const wanted: notificationManager.SlotType[] = [
      notificationManager.SlotType.SOCIAL_COMMUNICATION,
      notificationManager.SlotType.CONTENT_INFORMATION,
      notificationManager.SlotType.OTHER_TYPES
    ];
    for (let i = 0; i < wanted.length; i++) {
      try {
        await notificationManager.addSlot(wanted[i]);
      } catch (err) {
        // 渠道已存在时会返回错误，这不算失败
        const e = err as BusinessError;
        hilog.debug(DOMAIN, TAG, 'addSlot(%{public}d) returned %{public}d (usually already exists)',
          wanted[i], e.code);
      }
    }
    this.slotsReady = true;
  }

  /**
   * 发布一条通知。
   * @returns 已发布的通知 id；0 表示未发布（未授权 / 未绑定上下文 / 系统拒绝）
   */
  async publish(draft: NotificationDraft): Promise<number> {
    if (this.context === undefined) {
      this.lastError = '未绑定 UIAbility 上下文';
      return 0;
    }
    if (!this.enabled) {
      this.lastError = '用户未允许通知，已降级为应用内提醒';
      return 0;
    }
    await this.ensureSlots();

    const id: number = stableId(draft.key);
    try {
      const request: notificationManager.NotificationRequest = {
        id: id,
        content: {
          notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
          normal: {
            title: draft.title,
            text: draft.body
          }
        },
        tapDismissed: true,
        isOngoing: draft.ongoing === true
      };
      // 【渠道归属的实现取舍】这里**不**设置 `request.slotType`。
      //
      // 原因（编译期实证，不是猜测）：`NotificationRequest.slotType` 的类型来自
      // 已废弃的 `@ohos.notification` 的 `SlotType`，而 `notificationManager` 另有
      // 一份同名的数值枚举。ArkTS 的枚举是**标称类型**，两者不能互相赋值，
      // 直接写会得到：
      //   Type 'notificationManager.SlotType' is not assignable to type
      //   'notification.SlotType' (10505001)
      // 为了不引入一个已废弃模块的依赖（它随时可能被移除，且与 SDK 未来版本的关系不可控），
      // 本实现改为在 `ensureSlots()` 里**创建**三类渠道：渠道存在后，用户可在
      // 「设置 → 通知」中为「决策 / 结果 / 系统状态」三类分别配置提醒方式与静默时段，
      // 这正是 D3 §6「渠道可单独配置；静默时段可用」所要的能力。
      // 逐条通知按类型路由到具体渠道的能力，待上游 SDK 统一这两份枚举后再补。
      if (draft.group !== undefined) {
        request.groupName = draft.group;
      }
      const agent: WantAgent | undefined = await this.buildAgent(id, draft);
      if (agent !== undefined) {
        request.wantAgent = agent;
      }
      await notificationManager.publish(request);
      this.live.set(draft.key, id);
      this.lastError = '';
      return id;
    } catch (err) {
      const e = err as BusinessError;
      this.lastError = `发布失败 ${e.code}: ${e.message}`;
      hilog.error(DOMAIN, TAG, 'publish failed: %{public}s', this.lastError);
      return 0;
    }
  }

  /** 按去重键撤回（D3 §6：处理完成后主动撤回对应通知）。 */
  async withdraw(key: string): Promise<void> {
    const id: number | undefined = this.live.get(key);
    if (id === undefined) {
      return;
    }
    this.live.delete(key);
    try {
      await notificationManager.cancel(id);
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, 'cancel %{public}d failed: %{public}s', id, e.message);
    }
  }

  /** 撤回全部本应用通知（退出登录 / 切换 Host / 用户手动清空时使用）。 */
  async withdrawAll(): Promise<void> {
    this.live.clear();
    try {
      await notificationManager.cancelAll();
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, 'cancelAll failed: %{public}s', e.message);
    }
  }

  /** 当前通知中心事实（诊断页展示，D1 §7.8）。 */
  facts(): NotifyFacts {
    return {
      enabled: this.enabled,
      slotsReady: this.slotsReady,
      live: this.live.size,
      lastError: this.lastError
    };
  }

  /**
   * 构造点击直达的 WantAgent。
   *
   * 路由描述以 JSON 字符串放进 Want 的 parameters：
   * Want 的 parameters 只接受可序列化值，把结构化路由编码成字符串是最稳的做法，
   * 也让「通知点击」与「应用内跳转」共用同一套解析函数（appstate 侧的 parseRoute）。
   */
  private async buildAgent(id: number, draft: NotificationDraft): Promise<WantAgent | undefined> {
    if (this.context === undefined || draft.route === undefined) {
      return undefined;
    }
    const route: NotifyRoute = draft.route;
    const params: Record<string, Object> = {};
    params['dshRoute'] = JSON.stringify(route);
    try {
      const info: wantAgent.WantAgentInfo = {
        wants: [
          {
            bundleName: this.context.abilityInfo.bundleName,
            abilityName: this.context.abilityInfo.name,
            parameters: params
          }
        ],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: id
      };
      return await wantAgent.getWantAgent(info);
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, 'getWantAgent failed: %{public}s', e.message);
      return undefined;
    }
  }
}

/** 优先级 → 是否允许绕过静默时段（渠道等级由用户在各渠道上配置） */
export function priorityAllowsBypassDnd(priority: NotifyPriority): boolean {
  return priority === NotifyPriority.HIGH;
}
