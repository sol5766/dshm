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
import fs from '@ohos.file.fs';
import { NotificationDraft, NotifyFacts, NotifyPriority, NotifyRoute, NotifySlot } from './NotifyTypes';

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

/** 诊断文件（`<filesDir>/diag-notify`）：每行一条 JSON，现场可直接 grep。 */
const DIAG_NAME: string = 'diag-notify';

export class NotificationCenter {
  private context?: common.UIAbilityContext;
  private slotsReady: boolean = false;
  /**
   * 完成通知要用的渠道。默认 `SERVICE_INFORMATION`（LEVEL_HIGH，带系统提示音）；
   * 若该渠道被建成静音且重建无效，`ensureSlots()` 会把它切到 `SOCIAL_COMMUNICATION`
   * （系统保证有声）。见 `ensureSlots()` 里的「重建后仍静音」分支。
   */
  private completionSlotType: notificationManager.SlotType =
    notificationManager.SlotType.SERVICE_INFORMATION;
  private enabled: boolean = false;
  private lastError: string = '';
  /** 去重键 → 已发布的通知 id */
  private live: Map<string, number> = new Map();

  /** 绑定 UIAbility 上下文。必须在发布前调用。 */
  attach(context: common.UIAbilityContext): void {
    this.context = context;
    /* 落一条"上下文到位"的事实：后续 diag-notify 里的每条日志都以此为前提。 */
    this.diag('attach ctx ok');
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
  /**
   * 落一条诊断（2026-11-04，测试反馈"完全没有通知、也没有日志"）。
   *
   * 【为什么必须有】`publish` 的每条分支（未授权 / 未发出去 / 换 ID / 取消失败）过去**一行
   * 日志都不落**，现场只能靠"通知栏有没有"反推，无法判断卡在授权还是渠道。
   */
  private diag(line: string): void {
    if (this.context === undefined) {
      return;
    }
    try {
      const p: string = `${this.context.filesDir}/${DIAG_NAME}`;
      /* fileIo 没有 appendFileSync：用 open(APPEND) + writeSync（端侧实测可用）。 */
      const f: fs.File = fs.openSync(p, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.APPEND);
      try {
        fs.writeSync(f.fd, `${new Date().toISOString()} ${line}\n`);
      } finally {
        fs.closeSync(f);
      }
    } catch (e) {
      /* 诊断写失败不影响主流程 */
    }
  }

  async ensureEnabled(): Promise<boolean> {
    try {
      this.enabled = await notificationManager.isNotificationEnabled();
      if (this.enabled) {
        return true;
      }
      // 仅会弹一次；用户拒绝后不再弹
      await notificationManager.requestEnableNotification(this.context);
      this.diag('requestEnableNotification 已调用');
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
      /* 完成/失败通知的目标渠道（LEVEL_HIGH ⇒ 带声音；先建好，渠道才可被用户单独配置）。 */
      notificationManager.SlotType.SERVICE_INFORMATION,
      notificationManager.SlotType.CONTENT_INFORMATION,
      notificationManager.SlotType.OTHER_TYPES
    ];
    for (let i = 0; i < wanted.length; i++) {
      /*
       * 【提示音为什么**不在这里**做（2026-11-03 核实）】本 SDK 的
       *   `notificationManager.addSlot(type: SlotType)` **只接受类型**，不接受
       *   `NotificationSlot` 对象；`NotificationSlot.soundEnabled` 只能通过 `getSlot()` 读出来，
       *   没有任何写入入口；`NotificationRequest` 也没有 `sound` 字段。
       * 更细的取舍：`request.slotType` 因两份同名枚举的标称类型冲突不能直接设（见 publish() 注释），
       * 所以"把完成通知路由到响铃渠道"同样走不通。
       * ✅ 2026-11-04 修正：`NotificationRequest.notificationSlotType` 是**存在**的
       *   （`notification/notificationRequest.d.ts:130`，类型就是 `notificationManager.SlotType`），
       *   所以"把通知路由到响铃渠道"这条路是通的 —— 已在 publish() 里按 draft.slot 设置。
       *   这里仍只负责**建渠道**（渠道要先存在，通知才有归属）。
       */
      try {
        await notificationManager.addSlot(wanted[i]);
      } catch (err) {
        // 渠道已存在时会返回错误，这不算失败
        const e = err as BusinessError;
        hilog.debug(DOMAIN, TAG, 'addSlot(%{public}d) returned %{public}d (usually already exists)',
          wanted[i], e.code);
      }
    }
    /*
     * ── 渠道自检 + 静音渠道重建（2026-11-04）───────────────────────────────
     *
     * 【为什么必须做】用户反馈：通知出现了、但**没有声音**，且「应用声音管理」里也没有本应用。
     * 通知的声音由**渠道（slot）**决定；`addSlot` 在渠道已存在时是空操作，**不会刷新它的
     * soundEnabled/level**。如果该渠道在某个早期版本被建成静音，之后永远静音 —— 这正是
     * "通知有了却没声音"的一种常见成因。
     *
     * 处理：把关键渠道读回来（`getSlot`）并落诊断；发现 `soundEnabled=false` 就
     * `removeSlot` + `addSlot` 重建一次（重建后按类型默认级别，SERVICE_INFORMATION=LEVEL_HIGH
     * 带声音），再读一次确认。全部失败也不影响通知发布（只是没声音）。
     */
    try {
      const key: notificationManager.SlotType = notificationManager.SlotType.SERVICE_INFORMATION;
      let slot: notificationManager.NotificationSlot = await notificationManager.getSlot(key);
      /*
       * 【字段名以 SDK 为准（2026-11-04）】`NotificationSlot` 里表达"响不响"的是
       * `sound?: string`（音频资源 URI；空串 = 静音），**不是** `soundEnabled`
       * （那个名字只在 `NotificationSlot` 的某些版本里出现，本 SDK 没有）。
       * `getSlot()` 拿到的就是渠道的真实配置，这条日志直接回答"渠道是不是静音"。
       */
      const soundUri: string = slot.sound === undefined ? '' : slot.sound;
      this.diag(`slot(SERVICE_INFORMATION): level=${slot.notificationLevel}`
        + ` sound="${soundUri}" vibration=${slot.vibrationEnabled}`);
      const soundOff: boolean = soundUri.length === 0;
      if (soundOff) {
        this.diag('slot(SERVICE_INFORMATION): 静音渠道 ⇒ 重建');
        try {
          await notificationManager.removeSlot(key);
        } catch (e) {
          /* 可能不存在：忽略 */
        }
        try {
          await notificationManager.addSlot(key);
          slot = await notificationManager.getSlot(key);
          const rebuilt: string = slot.sound === undefined ? '' : slot.sound;
          this.diag(`slot 重建后: level=${slot.notificationLevel} sound="${rebuilt}"`);
          if (rebuilt.length === 0) {
            /*
             * 【重建后仍然静音 ⇒ 完成通知改走 SOCIAL_COMMUNICATION（2026-11-05）】
             *
             * 用户口径：**提示音一律走系统提示音，不用随包音频**。
             * 系统的"默认提示音"只挂在**有声渠道**上（`LEVEL_MIN` 明确不触发提示音，
             * `sound` 为空串即静音）；SERVICE_INFORMATION 在部分机型/版本上会被建成静音，
             * 而 `addSlot` 对已存在的渠道是空操作、重建也可能拿不到声音。
             * 这时唯一的可靠出路是换一条**系统保证有声**的渠道：SOCIAL_COMMUNICATION。
             * 代价：通知在系统设置里归类为"社交通信"，与微信/短信同档 —— 对"任务完成提醒"
             * 这个语义是可以接受的，而且用户仍能在系统设置里单独改铃声或静音。
             */
            this.completionSlotType = notificationManager.SlotType.SOCIAL_COMMUNICATION;
            this.diag('slot(SERVICE_INFORMATION): 重建后仍静音 ⇒ 完成通知改走 SOCIAL_COMMUNICATION');
          }
        } catch (e) {
          this.diag(`slot 重建失败：${(e as BusinessError).message}`);
        }
      }
    } catch (e) {
      this.diag(`slot 自检失败（渠道可能尚未真正创建）：${(e as BusinessError).message}`);
    }
    this.diag(`ensureSlots done`);
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
      this.diag(`publish SKIP kind=${draft.slot} key=${draft.key} reason=not-enabled`);
      return 0;
    }
    await this.ensureSlots();

    /*
     * ── 完成类通知必须"先撤销旧条 + 用新 ID 发布"（2026-11-04，工程师方案二）──
     *
     * 【为什么】官方《通知更新》文档与工程师口径一致：**同 ID 发布是"更新"，系统不会再次
     * 提醒**（没有声音/振动/横幅）。而任务从"进行中"到"完成"恰好是同一条通知内容变化，
     * 我们就踩了这个坑：`stableId(key)` 恒为同一个 ID ⇒ 覆盖更新 ⇒ 静音。
     *
     * 处理：`OUTCOME` 类（任务完成/失败）先 `cancel` 掉该 key 的旧通知，再用**带时间戳的新 ID**
     * 发布 —— 对系统而言是"新通知"，会正常提醒（声音/横幅/振动）。
     * 其他类别（审批/提问这类"需要用户注意"的）保持固定 ID：它们本来就是一次性到达，
     * 不存在"进度→完成"的覆盖关系。
     */
    const isOutcome: boolean = draft.slot === NotifySlot.OUTCOME;
    let id: number = stableId(draft.key);
    this.diag(`publish BEGIN kind=${draft.slot} key=${draft.key} fixedId=${id} isOutcome=${isOutcome}`);
    if (isOutcome) {
      const prevId: number | undefined = this.live.get(draft.key);
      if (prevId !== undefined) {
        try {
          await notificationManager.cancel(prevId);
        } catch (e) {
          /* 旧条可能已被用户划掉：忽略 */
        }
        this.live.delete(draft.key);
      }
      id = stableId(draft.key + '#' + String(Date.now()));
      this.diag(`publish OUTCOME cancelPrev=${prevId === undefined ? 'none' : String(prevId)} newId=${id}`);
    }
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
      /*
       * ── 渠道归属：终于可以设了（2026-11-04，AGC 方案核对后修正）──
       *
       * 早先注释说"不能设 slotType"——那条结论**错了**：当时只查了顶层
       * `@ohos.notificationManager.d.ts`（那里只有文档注释），漏了子文件
       * `notification/notificationRequest.d.ts:130`：
       *
       *     notificationSlotType?: notificationManager.SlotType;
       *
       * 字段名是 **notificationSlotType**（不是 slotType），且类型就是
       * `notificationManager.SlotType` ⇒ **没有枚举标称冲突**，可以直接赋值。
       *
       * 渠道↔级别（SDK 枚举注释原文）：
       *   SOCIAL_COMMUNICATION = 1 → LEVEL_HIGH（图标 + 横幅 + **声音**）
       *   SERVICE_INFORMATION  = 2 → LEVEL_HIGH（同样带声音，语义是"服务/状态信息"）
       *   CONTENT_INFORMATION  = 3 → LEVEL_MIN（无图标/无横幅/无声）
       * 所以"任务完成"这类状态通知走 SERVICE_INFORMATION 就会响 —— 这正是用户要的
       * "接鸿蒙通知、系统分配默认提示音、用户可在系统里自定义"。
       */
      request.notificationSlotType = draft.slot === NotifySlot.DECISION
        ? notificationManager.SlotType.SOCIAL_COMMUNICATION
        : (draft.slot === NotifySlot.OUTCOME
          ? notificationManager.SlotType.SERVICE_INFORMATION
          : notificationManager.SlotType.CONTENT_INFORMATION);
      // 旧注释（保留作为历史）：
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
      /*
       * 【空串不设组】`groupName` 相同即折叠；把 `''` 设进去会让所有"没有会话 id"的通知
       * 又聚成一组（等于回到"多条挤在一起"）。空串一律交给系统按通知 id 独立展示。
       */
      if (draft.group !== undefined && draft.group.length > 0) {
        request.groupName = draft.group;
      }
      const agent: WantAgent | undefined = await this.buildAgent(id, draft);
      if (agent !== undefined) {
        request.wantAgent = agent;
      }
      await notificationManager.publish(request);
      this.live.set(draft.key, id);
      this.lastError = '';
      this.diag(`publish OK key=${draft.key} id=${id}`);
      return id;
    } catch (err) {
      const e = err as BusinessError;
      this.lastError = `发布失败 ${e.code}: ${e.message}`;
      this.diag(`publish FAIL key=${draft.key} id=${id} code=${e.code}`);
      hilog.error(DOMAIN, TAG, 'publish failed: %{public}s', this.lastError);
      return 0;
    }
  }

  /**
   * 任务进度通知（2026-11-04，用户需求"任务开始时状态栏有进度通知"）。
   *
   * 【静默 + ongoing】进度通知**不该响**（否则每轮开头叮一声很吵），所以路由到
   * `CONTENT_INFORMATION`（LEVEL_MIN，无图标/无横幅/无声）；`isOngoing=true` 让它挂在
   * 状态栏直到任务结束被撤掉。ID 由 `taskId` 稳定派生 ⇒ 同一任务重复调用是**更新**，
   * 不会堆一列。
   */
  async publishProgress(taskId: string, title: string, text: string, sessionId?: string): Promise<number> {
    if (this.context === undefined || !this.enabled) {
      this.diag(`progress SKIP taskId=${taskId} enabled=${this.enabled}`);
      return 0;
    }
    await this.ensureSlots();
    const id: number = stableId('progress:' + taskId);
    try {
      const request: notificationManager.NotificationRequest = {
        id: id,
        content: {
          notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
          normal: { title: title, text: text }
        },
        tapDismissed: false,
        isOngoing: true
      };
      request.notificationSlotType = notificationManager.SlotType.CONTENT_INFORMATION;
      /*
       * 进度通知也挂路由：用户点它同样是"想看看那个任务"。
       * sessionId 由调用方从 task-state.json 取（那里已带）。
       */
      const progressAgent: WantAgent | undefined =
        await this.buildRouteAgent(id, this.routeForSession(sessionId));
      if (progressAgent !== undefined) {
        request.wantAgent = progressAgent;
      }
      await notificationManager.publish(request);
      this.live.set('progress:' + taskId, id);
      this.diag(`progress OK taskId=${taskId} id=${id}`);
      return id;
    } catch (err) {
      const e = err as BusinessError;
      this.diag(`progress FAIL taskId=${taskId} code=${e.code}`);
      this.lastError = `进度通知失败 ${e.code}: ${e.message}`;
      return 0;
    }
  }

  /**
   * 任务完成通知（用户需求的核心：**不论前后台都要出通知 + 声音**）。
   *
   * 【顺序与 ID 都有讲究】
   *   ① 先撤掉该任务的**进度通知**（否则通知栏会留着一条"进行中"）；
   *   ② 用**新 ID** 发布完成通知 —— 同 ID 发布是"更新"，系统不会再次提醒（无声音/横幅）；
   *   ③ 路由到 `SERVICE_INFORMATION`（LEVEL_HIGH ⇒ 图标 + 横幅 + **声音**，用户可在系统设置里
   *      单独改铃声或静音）；
   *   ④ `isOngoing=false`：完成通知可被用户划走，也不与长时任务的常驻通知混在一起。
   */
  async publishCompletion(taskId: string, title: string, text: string, failed: boolean,
    sessionId?: string): Promise<number> {
    if (this.context === undefined || !this.enabled) {
      this.diag(`completion SKIP taskId=${taskId} enabled=${this.enabled}`);
      return 0;
    }
    await this.ensureSlots();
    /* ① 撤进度 */
    const progressKey: string = 'progress:' + taskId;
    const progressId: number | undefined = this.live.get(progressKey);
    if (progressId !== undefined) {
      try {
        await notificationManager.cancel(progressId);
        this.diag(`completion cancelProgress id=${progressId}`);
      } catch (e) {
        /* 已被用户划掉：忽略 */
      }
      this.live.delete(progressKey);
    }
    /* ②③④ 新 ID + 带声音渠道 */
    const id: number = stableId('done:' + taskId + '#' + String(Date.now()));
    try {
      const request: notificationManager.NotificationRequest = {
        id: id,
        content: {
          notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
          normal: {
            title: title,
            text: text,
            additionalText: failed ? '打开 DSHM 查看失败原因' : '打开 DSHM 查看结果'
          }
        },
        tapDismissed: true,
        isOngoing: false
      };
      request.notificationSlotType = this.completionSlotType;
      /*
       * 【2026-11-11 点击直达修复】原来这里传的 draft 没有 route ⇒ buildAgent 直接返回
       * undefined，通知**根本没有 wantAgent** —— 点击只能清除或把应用拉到前台，
       * 正是用户反馈的"只能清除、点不进去对应会话"。现在按 sessionId 拼会话路由。
       */
      const agent: WantAgent | undefined =
        await this.buildRouteAgent(id, this.routeForSession(sessionId));
      if (agent !== undefined) {
        request.wantAgent = agent;
      }
      await notificationManager.publish(request);
      this.live.set('done:' + taskId, id);
      this.diag(`completion OK taskId=${taskId} id=${id} failed=${failed}`);
      return id;
    } catch (err) {
      const e = err as BusinessError;
      this.diag(`completion FAIL taskId=${taskId} code=${e.code} msg=${e.message}`);
      this.lastError = `完成通知失败 ${e.code}: ${e.message}`;
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
   * 由会话 id 生成「直达会话」路由；空 id 返回 undefined（表示不挂 wantAgent）。
   */
  private routeForSession(sessionId?: string): NotifyRoute | undefined {
    const sid: string = sessionId === undefined ? '' : sessionId;
    if (sid.length === 0) {
      return undefined;
    }
    const route: NotifyRoute = { page: 'sessions' };
    route.sessionId = sid;
    return route;
  }

  private async buildAgent(id: number, draft: NotificationDraft): Promise<WantAgent | undefined> {
    return this.buildRouteAgent(id, draft.route);
  }

  /**
   * 构造点击直达的 WantAgent。
   *
   * 路由描述以 JSON 字符串放进 Want 的 parameters：
   * Want 的 parameters 只接受可序列化值，把结构化路由编码成字符串是最稳的做法，
   * 也让「通知点击」与「应用内跳转」共用同一套解析函数（appstate 侧的 parseNotifyRoute）。
   */
  private async buildRouteAgent(id: number, route?: NotifyRoute): Promise<WantAgent | undefined> {
    if (this.context === undefined || route === undefined) {
      return undefined;
    }
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
