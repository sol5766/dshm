/**
 * 会话面板（轨迹 + 输入区）—— D3 §3.2 / §3.3 / §3.6。
 *
 * 轨迹条目类型（D3 §3.2）：用户/助手消息、思考折叠、工具调用卡、子代理、交付物、
 * 目标、任务、错误。工具调用卡按 §3.3 的徽标与默认展开规则呈现。
 *
 * 数据来源：宿主注入（当前为桩数据源）。本组件不直接调用协议层，
 * 所有动作通过回调上报宿主，便于接入真实连接时只改宿主。
 */

import { Border, CommandCandidate, FeedbackRow, FollowSignal, Fs, HarmonyColor, HarmonyType, ModelOption, ModelSelection, PendingAttachment, PendingItem, QueuedItem, Radius, ReferenceCandidate, SessionHub, Sp, Speaker, TrajectoryItem, TrajectoryKind, cellIdForListIndex, chatRowOfItemIndex, chatVisibleItems, contextMenuGestures, defaultExpanded, followTimerShouldRun, formatDuration, groupTurns, hasProcessGroup, jobTickerNeeded, listIndexForCell, matchConversationIndices, matchTrajectoryIndices, modelSelectionLabel, nextFollowing, parseMarkdown, plainTextOf, presentTool, processSummary, shouldJumpOnNewItems, stepMatch, toolStateLabel } from 'appstate';
/** 类型单独 import type（本仓约定：值与类型分开写） */
import type { ActionNotice, SessionJob, SessionStatsInput, Turn } from 'appstate';
import type { NativeAction } from './NativePrimitives';
import { NativeCard, NativeChip } from './NativePrimitives';
import { Composer } from './Composer';
import { MarkdownRenderer } from './MarkdownRenderer';
import { MessageFeedback } from './MessageFeedback';
import { MessageRow } from './MessageRow';
import { DeliverableCard } from './DeliverableCard';
import { SubagentCard } from './SubagentCard';
import { ToolCard } from './ToolCard';
import { ReasoningRow } from './ReasoningRow';
import { ConversationHeader } from './ConversationHeader';
import { TurnView, TurnViewController } from './TurnView';
import { PendingPane } from './PendingPane';

@Component
export struct ConversationPane {
  @Prop @Watch('onSessionChanged') sessionId: string = '';
  /** 会话头上下文行：工作区名（宿主从选中会话的 cwd 派生；空 = 不显示） */
  @Prop workspaceName: string = '';
  /** 选中会话的最近活动时间（毫秒；0 = 不显示） */
  @Prop sessionUpdatedAt: number = 0;
  @Prop items: TrajectoryItem[] = [];
  @Prop running: boolean = false;
  @Prop offline: boolean = false;
  @Prop queuedCount: number = 0;
  @Prop draft: string = '';
  @Prop attachments: PendingAttachment[] = [];
  /** 当前会话在 Host 侧的排队项 */
  @Prop queued: QueuedItem[] = [];
  @Prop models: ModelOption[] = [];
  @Prop selection: ModelSelection = { provider: '', modelId: '', effort: '' };
  @Prop references: ReferenceCandidate[] = [];
  @Prop commands: CommandCandidate[] = [];
  /** 能力缺失的一次性提示（透传给输入区） */
  @Prop notice: string = '';
  /**
   * 本轮待决的审批/提问（E115：直接弹在会话里，方便一次点击放行）。
   *
   * 【为什么放在输入区上方而不是顶部】它卡住的是"这一轮还能不能继续"，
   * 用户的注意力在对话末尾与输入框之间；摆在顶部会让人以为"跟我现在做的无关"。
   */
  @Prop pending: PendingItem[] = [];
  onDecidePending: (item: PendingItem, choiceId: string, reason: string) => void = () => {
  };
  onAnswerPending: (item: PendingItem, selected: string[], custom: string) => void = () => {
  };

  onDraftChange: (text: string) => void = () => {
  };
  onSend: () => void = () => {
  };
  onStop: () => void = () => {
  };
  onAddAttachment: () => void = () => {
  };
  /** 移除附件（参数是上传回执 id，见 `Composer` 的说明） */
  onRemoveAttachment: (receiptId: string) => void = () => {
  };
  onPickModel: () => void = () => {
  };
  /** 计划模式（官方 ui-plan 的输入区 chip）与权限模式（只读展示） */
  /**
   * 会话的后台任务（官方 `conversation.header.jobs`）。
   *
   * 【为什么判定不在这里】live 与否、状态点语义、五种文案、时长三档、排序、计数、
   * "要不要定时刷新"全在 `appstate/model/Jobs`（40 条断言）；本组件只把结果画出来。
   */
  @Prop @Watch('onJobsChanged') jobs: SessionJob[] = [];
  @Prop planActive: boolean = false;
  @Prop planPending: boolean = false;
  @Prop permissionLabel: string = '';

  onTogglePlan: () => void = () => {
  };
  /** `@` 引用查询词变化（转发给宿主去问 Host） */
  onReferenceQuery: (query: string) => void = () => {
  };
  /** 排队项：取回编辑 / 移除 / 插话（三者都转发给宿主的真实调用） */
  onPullQueued: (itemId: string, text: string) => void = () => {
  };
  onRemoveQueued: (itemId: string) => void = () => {
  };
  onSteerQueued: (itemId: string) => void = () => {
  };
  /** 打开详情栏（单栏/双栏下没有并排详情栏时使用） */
  onOpenDetail: () => void = () => {
  };

  @State expanded: string[] = [];

  /**
   * 消息操作条（§10）的反馈面板状态。
   *
   * 【为什么要有"面板"这一步】契约里 `messageFeedback/put` 除了 `rating` 还有可选的
   * `category` 与 `note`（D2b §6.7）。只发 rating 等于把官方那套"类别 → 可选说明 → 提交"
   * 砍成两个文字按钮——那正是 §10 明确不允许的形态。
   */
  /**
   * 上下文菜单（§10 的「更多」与 P3 输入语义）。
   *
   * 【为什么用"受控形式"而不是 `bindContextMenu(builder, ResponseType.X)`】
   * 后者一次只能绑一种手势，且其 builder **不带参数** ⇒ 无法表达"每条消息各自的菜单"。
   * 受控形式（`bindContextMenu(isShown, content, options)`）把显隐交给我们，
   * 于是"长按 ≡ 右键 → 同一个菜单"是**显式实现**的（手势集合由 `contextMenuGestures` 决定），
   * 而不是靠两套绑定碰巧长得一样。
   */
  /** 输入模态（宿主从设备事实派生后传入；视图不认识 deviceInfo） */
  /**
   * 会话统计（时间总览用）。由宿主把快照字段映射成这个形状——
   * 视图不做"哪个数字该显示"的判断，那在 `model/Timeline` 里（有断言）。
   */
  @Prop stats: SessionStatsInput = {
    turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0
  };

  /** 时间总览条已测量的宽度（拖动聚焦要按它把偏移量换算成比例） */

  /** 当前聚焦的格子 id（拖动/点选/滚动列表都会改它，见下面的双向联动） */
  @State focusedCellId: string = '';

  /**
   * 是否正在**拖动比例条**。
   *
   * 【为什么需要它】联动是双向的：拖条会滚列表，滚列表也会改聚焦。
   * 拖条的时候若还让"滚动"反过来改聚焦，两边会互相覆盖（拖到哪都被列表当前行抢走）。
   * 故拖条期间**关掉**列表→条这一路。
   */
  @State timelineDragging: boolean = false;

  @Prop hasPointer: boolean = false;
  @Prop hasKeyboard: boolean = false;
  /** 当前被指针悬停的消息 id（有指针设备时才有值） */

  /** 哪个消息的反馈面板开着（空串 = 都没开） */
  @State fbFor: string = '';
  /** 本次评价是"有帮助"还是"没帮助"（契约取值 positive / negative） */
  @State fbRating: string = '';
  /**
   * 反馈回执。
   *
   * 【为什么留在宿主而不进组件】"提交成功要不要关面板"是宿主的策略；回执文本也要贴着面板显示，
   * 而它由宿主的中枢调用产生 ⇒ 组件只接收显示（见 `MessageFeedback.notice`）。
   * （表单里的类别与说明已随组件走：`fbCategory` / `fbNote` 两个状态**已删除**。）
   */
  @State fbNote2: string = '';

  /** 复制消息正文（剪贴板是平台能力，由宿主传入回调——视图层不直接依赖 platform） */
  onCopyMessage: (text: string) => void = () => {
  };
  /** 引用到输入框 / 重发（都由宿主执行：草稿与发送都在宿主手里） */
  onQuoteMessage: (item: TrajectoryItem) => void = () => {
  };
  onResendMessage: (item: TrajectoryItem) => void = () => {
  };

  /**
   * 毫秒时间戳 → **钟点**（E204，官方 `ui-trajectory` 的 `toolbar.actualTime`「实际时间」）。
   *
   * 【为什么不做一个开关】官方那三项里，"实际时长/等宽操作"控制的是**时间轴条宽**——
   * 我们没有时间轴，照搬就是点了没效果的开关（§13.3 的结论）；而"实际时间"提供的是
   * **信息**（这件事发生在几点），对列表同样有意义 ⇒ 直接**与时长并列显示**：
   * 少一份状态、少一个入口，信息一点不少。
   */
  /** 时间线格子（每次都按当前条目算一次；条目数是几十到几百，代价可忽略） */


  /** 聚焦格子的详情行（官方：「总计」「开始于」「首 token … · 解码 …」「无计时数据」） */

  /** 会话统计（时间相关四项）的文案：单位由模型给，排版在这里 */

  /** 拖动/点选：把条上的比例位置换算成"聚焦哪一格"（越界夹到首尾，规则在模型里） */

  /**
   * 条 → 列表：把聚焦的那一格滚进视野。
   *
   * 【为什么只在"拖动结束/点选"时滚，而不是拖动过程中每一帧都滚】拖动时每帧滚动会让列表
   * 剧烈抖动，且用户此刻看的是**条上的详情行**，不是列表。松手再跳，符合"先扫、再过去看"的动作。
   *
   * 【为什么要判 -1】`listIndexForCell` 会在"还没聚焦 / 该条目被过滤出列表"时返回 -1，
   * 此时**不滚**——滚到第 0 行等于"用户什么都没点，列表自己跳回顶部"。
   */
  private scrollToFocusedCell(): void {
    const index: number = listIndexForCell(this.visibleItems(), this.focusedCellId);
    if (index < 0) {
      return;
    }
    /*
     * 用 START 对齐：让该条落在列表顶部，这样"列表首行"与"聚焦格"一致，
     * 下面那条 `onScrollIndex → 聚焦` 才不会被同一个动作来回改（否则会自己抖自己）。
     *
     * 【为什么不用平滑滚动】平滑滚动会在动画途中**反复**触发 `onScrollIndex`，
     * 于是"列表 → 条"那一路会把聚焦扫过中间的每一格——聚焦指示器在动画期间短暂地"说谎"，
     * 看起来像条在自己动。改成立即跳转直接消掉这条未验证的观感风险；
     * 想要平滑效果可以后续加"程序化滚动期间挂起列表→条"再换回 `true`
     * （已记进 docs/device-validation.md 的 D8，真机上若观感需要再补）。
     */
    this.scroller.scrollToIndex(index, false, ScrollAlign.START);
  }

  /** 列表 → 条：列表滚动时，把**首行**对应的格子设为聚焦（条上的位置随之移动） */
  private focusFromListIndex(firstVisible: number): void {
    if (this.timelineDragging) {
      return;
    }
    const id: string = cellIdForListIndex(this.visibleItems(), firstVisible);
    if (id.length > 0 && id !== this.focusedCellId) {
      this.focusedCellId = id;
    }
  }

  /**
   * 展开/收起**全部**条目（E197，官方轨迹工具栏的 `expandTurns`/`collapseTurns` 与
   * `expandCalls`/`collapseCalls`）。
   *
   * 【为什么合并成一个"全部"而不是四颗按钮】官方把"轮次"和"调用"分成两组开关；
   * 我们的轨迹把消息、思考、工具调用、子代理、交付物都放在**同一条时间线**里，
   * 逐组区分反而不如"全部"直观——这是**形态差异**，不是能力缺失，所以如实做成两颗：
   * 需要更细的粒度时再按 `TrajectoryKind` 拆分即可（`expanded` 存的是条目 id）。
   */
  /**
   * 会话内搜索状态（D3 §5.1 的 `Ctrl/Cmd + F`）。
   *
   * 【为什么状态放在本组件而不是宿主】搜索框就在轨迹上方，命中的滚动目标也是这条 List，
   * 放在持有 List/Scroller 的组件里最直接。宿主只负责**触发**（Ctrl+F 把 `searchOpen` 置真）。
   */
  @Prop searchOpen: boolean = false;
  /** 关闭搜索（`searchOpen` 是 `@Prop`，子组件不能可靠地写回，因此由宿主关闭） */
  onCloseSearch: () => void = () => {
  };
  /** 搜索关键词（本组件自己维护；宿主不需要知道用户搜了什么） */
  @State searchQuery: string = '';
  /** 当前选中的命中在**命中数组**里的位置（-1 = 未选中） */
  @State matchPos: number = -1;
  private scroller: Scroller = new Scroller();

  /**
   * 是否**跟随最新**（E113）。
   *
   * 【为什么需要它】官方 web 的行为是"贴底跟随"，而朴素做法（每条新消息都 `scrollEdge`）
   * 会在用户**正在往上翻历史**时把他拽回底部——那是最令人恼火的一类交互缺陷。
   * 规则三条：
   *   1. 默认跟随：进入会话、发消息、模型流式输出时都停在最新；
   *   2. 用户手动上翻 ⇒ **解除跟随**，新内容只追加不抢焦点；
   *   3. 用户自己拉回底部 ⇒ **恢复跟随**，此后新内容继续自动滚。
   * 判定用可见区间（`onScrollIndex` 的 `end` 是否覆盖最后一条），它对"手滑一下又停住"
   * 这种情况也稳：只要最后一条重新可见，就认为用户回到了底部。
   */
  @State stickToBottom: boolean = true;
  /** 渲染条数（宿主传入；@Watch 用于"有新条目就贴底"） */
  @Prop @Watch('onItemsChanged') itemCount: number = 0;
  private followTimer: number = -1;

  /** 可见区间变化：最后一条可见 ⇔ 用户在底部 ⇒ 恢复跟随；否则解除跟随 */
  private onVisibleRange(start: number, end: number): void {
    const last: number = this.rowCount() - 1;
    const atBottom: boolean = last < 0 || end >= last;
    // 几何只回答"在不在底部"；**是否跟随**由跟随模型按信号决定（§8 的独立管理）
    this.stickToBottom = nextFollowing(this.stickToBottom,
      atBottom ? FollowSignal.AT_BOTTOM : FollowSignal.SCROLLED_AWAY);
  }

  /**
   * 会话切换（§8 缺的那条意图信号）。
   *
   * 【修的是什么】此前"在会话 A 上翻过历史"会让跟随保持 false，切到会话 B 时
   * **新会话不在底部**——用户看到的是 B 的中间某处。切换会话的意图显然是"看最新"。
   */
  private onSessionChanged(): void {
    this.stickToBottom = nextFollowing(this.stickToBottom, FollowSignal.SESSION_CHANGED);
    this.scrollToLatest();
  }

  private onItemsChanged(): void {
    if (shouldJumpOnNewItems(this.stickToBottom)) {
      this.scrollToLatest();
    }
  }

  /** 贴到底部；失败不该让页面崩（列表未就绪/尺寸为 0 时会抛） */
  private scrollToLatest(): void {
    try {
      this.scroller.scrollEdge(Edge.Bottom);
    } catch (err) {
      // 忽略：下一次内容变化会再试
    }
  }

  /**
   * 运行中定时贴底：流式输出时**条目数不变而正文在长**，只靠 `itemCount` 会停在半截。
   * 只在自己跟随（`stickToBottom`）时定时；用户上翻时立刻停。
   */
  private syncFollowTimer(): void {
    const shouldRun: boolean = followTimerShouldRun(this.stickToBottom, this.running);
    if (shouldRun && this.followTimer < 0) {
      this.followTimer = setInterval(() => {
        this.scrollToLatest();
      }, 900);
    } else if (!shouldRun && this.followTimer >= 0) {
      clearInterval(this.followTimer);
      this.followTimer = -1;
    }
  }

  /** 任务列表变化：只在"有 live 任务"时才开定时器（模型判定），否则白跑 */
  onJobsChanged(): void {
    this.syncJobsTimer();
  }

  private syncJobsTimer(): void {
    const needed: boolean = jobTickerNeeded(this.jobs);
    if (needed && this.jobsTimer < 0) {
      this.jobsTimer = setInterval(() => {
        this.jobsTick = this.jobsTick + 1;
      }, 1000);
    } else if (!needed && this.jobsTimer >= 0) {
      clearInterval(this.jobsTimer);
      this.jobsTimer = -1;
    }
  }

  aboutToAppear(): void {
    // 进入会话先贴到底部（用户要看到的是最新一条，而不是最老一条）
    this.scrollToLatest();
  }

  aboutToDisappear(): void {
    if (this.followTimer >= 0) {
      clearInterval(this.followTimer);
      this.followTimer = -1;
    }
    if (this.jobsTimer >= 0) {
      clearInterval(this.jobsTimer);
      this.jobsTimer = -1;
    }
  }

  /**
   * 当前命中集合（每次渲染按关键词算一次；轨迹长度是几十到几百条，代价可忽略）。
   *
   * 【按视图作用域】对话视图只搜**用户可见的那几类**——否则 `system/message` 的正文
   * （就是完整的 agent 提示词）会被搜到并计入命中数，而那一行根本不在对话里显示
   * （P0-1 的绕过路径：泄漏不只是"显示"，"能被搜到、能被计数"同样算）。
   * 轨迹视图搜全部条目：内部事件在那里本来就该可查。
   */
  /** 回合渲染的控制器（"全部展开 / 收起全部"由它接给会话头按钮） */
  private turnController: TurnViewController = new TurnViewController();

  /** 本次命中条目的 id 集合（判定在 `hits()`；命中高亮在列表项与回合里都用它） */
  private hitIds(): string[] {
    const list: number[] = this.hits();
    const out: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const it: TrajectoryItem | undefined = this.items[list[i]];
      if (it !== undefined) {
        out.push(it.id);
      }
    }
    return out;
  }

  /** 该回合内是否有命中（列表项的命中色条据此显示） */
  private turnHasHit(turn: Turn): boolean {
    const ids: string[] = this.hitIds();
    if (turn.user !== undefined && ids.indexOf(turn.user.id) >= 0) {
      return true;
    }
    for (let i = 0; i < turn.answers.length; i++) {
      if (ids.indexOf(turn.answers[i].id) >= 0) {
        return true;
      }
    }
    for (let i = 0; i < turn.process.length; i++) {
      if (ids.indexOf(turn.process[i].id) >= 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * 轨迹视图的**扁平条目分派**（条目级台账）。
   *
   * 【为什么不复用 `TurnView` 里的 `trajectoryItem`】那个分派长在"一个回合"的语境里
   * （它要用回合的展开集合、回合内的反馈归属）；而轨迹视图是**条目级**的：
   * 一条思考、一次工具调用都直接列在时间线上，没有回合外壳。
   * 两处共用的是**卡片本身**（`MessageRow` / `ReasoningRow` / `ToolCard` / `SubagentCard` /
   * `DeliverableCard`）——那才是"同一份呈现"该共享的粒度；分派逻辑各写各的，
   * 因为它俩的上下文不同（这与 P3 各面板和过程流共用卡片是同一条规矩）。
   */
  @Builder
  flatItem(item: TrajectoryItem) {
    if (item.kind === TrajectoryKind.MESSAGE) {
      MessageRow({
        item: item,
        a11yText: this.flatA11y(item),
        hasPointer: this.hasPointer,
        hasKeyboard: this.hasKeyboard,
        feedbackOpen: this.fbFor === item.id,
        feedbackNotice: this.fbNote2,
        storedRating: this.storedRatingOf(item.id),
        storedCategory: this.storedCategoryOf(item.id),
        storedNote: this.storedNoteOf(item.id),
        actions: this.flatActionsOf(item),
        onAction: (it: TrajectoryItem, id: string) => {
          this.onFlatAction(it, id);
        },
        onOpenFeedback: (it: TrajectoryItem, rating: string) => {
          this.openFlatFeedback(it, rating);
        },
        onSubmitFeedback: (it: TrajectoryItem, rating: string, category: string, note: string) => {
          this.submitFlatFeedback(it, rating, category, note);
        },
        onCloseFeedback: () => {
          this.fbFor = '';
          this.fbNote2 = '';
        }
      })
    } else if (item.kind === TrajectoryKind.REASONING) {
      // 思考块归 ReasoningRow（与回合的过程分组共用同一份）
      ReasoningRow({
        item: item,
        expanded: this.isExpanded(item.id),
        onToggle: () => {
          this.toggle(item.id);
        }
      })
    } else if (item.kind === TrajectoryKind.TOOL) {
      ToolCard({
        item: item,
        expanded: this.isExpanded(item.id)
          || presentTool(item, toolStateLabel(item.toolState)).defaultExpanded,
        onToggle: () => {
          this.toggle(item.id);
        }
      })
    } else if (item.kind === TrajectoryKind.SUBAGENT) {
      SubagentCard({ item: item })
    } else if (item.kind === TrajectoryKind.DELIVERABLE) {
      DeliverableCard({ item: item })
    } else if (item.kind === TrajectoryKind.GOAL || item.kind === TrajectoryKind.JOB) {
      this.flatGoal(item)
    } else if (item.kind === TrajectoryKind.ERROR) {
      this.flatError(item)
    }
  }

  /** 目标 / 任务卡（轨迹视图；对话视图那份在 `TurnView` 里） */
  @Builder
  flatGoal(item: TrajectoryItem) {
    NativeCard({
      iconSymbol: item.kind === TrajectoryKind.GOAL
        ? $r('sys.symbol.checkmark_circle')
        : $r('sys.symbol.list_bullet'),
      title: item.title,
      badge: item.kind === TrajectoryKind.GOAL ? '目标' : '任务',
      tone: 'brand',
      summary: item.progress,
      progress: item.percent,
      a11y: `${item.kind === TrajectoryKind.GOAL ? '目标' : '任务'} ${item.title}`
    })
  }

  /** 错误块（轨迹视图；对话视图那份在 `TurnView` 里） */
  @Builder
  flatError(item: TrajectoryItem) {
    Row({ space: Sp.S }) {
      Divider().vertical(true).color($r('sys.color.alert')).height('100%')
      Text(`出错了：${item.body}`)
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.alert'))
        .layoutWeight(1)
    }
    .width('100%')
    .padding(Sp.S)
    .borderRadius(Radius.S)
    .backgroundColor($r('sys.color.background_secondary'))
    .accessibilityText(`错误：${item.body}`)
  }

  /** 某条目是否已展开（轨迹视图的展开集合也在这里：轨迹是条目级台账，没有回合外壳） */
  private isExpanded(id: string): boolean {
    return this.expanded.indexOf(id) >= 0;
  }

  private toggle(id: string): void {
    const out: string[] = [];
    let found: boolean = false;
    for (let i = 0; i < this.expanded.length; i++) {
      if (this.expanded[i] === id) {
        found = true;
      } else {
        out.push(this.expanded[i]);
      }
    }
    if (!found) {
      out.push(id);
    }
    this.expanded = out;
  }

  /** 轨迹视图的无障碍读数（与 `TurnView` 里那句同形） */
  private flatA11y(item: TrajectoryItem): string {
    const who: string = item.speaker === Speaker.USER ? '我说' : '助手回复';
    const plain: string = plainTextOf(parseMarkdown(item.body));
    const head: string = plain.length > 60 ? `${plain.substring(0, 60)}…` : plain;
    return `${who}：${head}（共 ${plain.length} 字）`;
  }

  /** 该条消息宿主记录的评价（决定菜单里要不要给"撤回评价"） */
  private storedRatingOf(messageId: string): string {
    const row: FeedbackRow | undefined = SessionHub.shared().feedbackOf(messageId);
    return row === undefined ? '' : row.rating;
  }

  private storedCategoryOf(messageId: string): string {
    const row: FeedbackRow | undefined = SessionHub.shared().feedbackOf(messageId);
    return row === undefined ? '' : row.category;
  }

  private storedNoteOf(messageId: string): string {
    const row: FeedbackRow | undefined = SessionHub.shared().feedbackOf(messageId);
    return row === undefined ? '' : row.note;
  }

  /** 条目动作清单（与 `TurnView` 同一份规则：复制 / 评价 / 引用 / 重发 / 撤回） */
  private flatActionsOf(item: TrajectoryItem): NativeAction[] {
    const out: NativeAction[] = [];
    out.push({ id: 'copy', label: '复制', a11y: '复制这条消息的正文' });
    out.push({
      id: 'like', label: '有帮助',
      active: this.storedRatingOf(item.id) === 'positive', a11y: '评价为有帮助'
    });
    out.push({
      id: 'dislike', label: '没帮助',
      active: this.storedRatingOf(item.id) === 'negative', a11y: '评价为没帮助'
    });
    out.push({ id: 'quote', label: '引用', a11y: '把这条消息引用到输入框' });
    if (item.speaker === Speaker.USER) {
      // 只有用户消息能"重发"（助手消息重发需要"重跑那一轮"的端点，本仓没有 ⇒ 不给假入口）
      out.push({ id: 'resend', label: '重发', a11y: '重新发送这条消息' });
    }
    if (this.storedRatingOf(item.id).length > 0) {
      out.push({ id: 'withdraw', label: '撤回评价', a11y: '撤回这条消息的反馈' });
    }
    return out;
  }

  private onFlatAction(item: TrajectoryItem, id: string): void {
    if (id === 'copy') {
      this.onCopyMessage(item.body);
    } else if (id === 'like' || id === 'dislike') {
      this.openFlatFeedback(item, id === 'like' ? 'positive' : 'negative');
    } else if (id === 'quote') {
      this.onQuoteMessage(item);
    } else if (id === 'resend') {
      this.onResendMessage(item);
    } else if (id === 'withdraw') {
      SessionHub.shared().clearFeedback(item.id).then((n: ActionNotice) => {
        this.fbNote2 = this.feedbackNoticeTextOf(n);
      });
    }
  }

  private openFlatFeedback(item: TrajectoryItem, rating: string): void {
    this.fbFor = item.id;
    this.fbRating = rating;
    this.fbNote2 = '';
  }

  private submitFlatFeedback(item: TrajectoryItem, rating: string, category: string, note: string): void {
    SessionHub.shared().putFeedback(item.id, rating, note, category).then((n: ActionNotice) => {
      this.fbNote2 = this.feedbackNoticeTextOf(n);
      if (n.code === 'feedback.saved') {
        this.fbFor = '';
      }
    });
  }

  /** 反馈回执 → 一句话（与 `TurnView` 同表；两处都贴着各自的面板显示） */
  private feedbackNoticeTextOf(n: ActionNotice): string {
    if (n.code === 'feedback.saved' || n.code === 'feedback.withdrawn') {
      return '';
    }
    if (n.code === 'feedback.failed') {
      return '评价未保存：' + n.params.reason;
    }
    if (n.code === 'feedback.no-version') {
      return '无法撤回：没读到该评价的版本（不猜版本号去删）。';
    }
    if (n.code === 'offline') {
      return '未连接：评价需要连上 Host 才能保存。';
    }
    return '';
  }

  private hits(): number[] {
    return this.view === 'chat'
      ? matchConversationIndices(this.items, this.searchQuery)
      : matchTrajectoryIndices(this.items, this.searchQuery);
  }

  /**
   * 命中条目下标 → **当前视图的列表行号**。
   *
   * 对话视图的行是**回合**，条目下标直接喂给 `scrollToIndex` 会滚到错误的行
   * （"搜到了却跳错地方"，且不报错）。找不到所属回合时返回 -1 ⇒ 不滚。
   */
  private rowOfHit(itemIndex: number): number {
    if (this.view === 'chat') {
      return chatRowOfItemIndex(this.items, this.chatTurns(), itemIndex);
    }
    return itemIndex;
  }

  /** 某一条是否在命中集合里（`isHit` 只用于左侧色条） */
  private isHit(item: TrajectoryItem): boolean {
    const list: number[] = this.hits();
    for (let i = 0; i < list.length; i++) {
      if (this.items[list[i]] !== undefined && this.items[list[i]].id === item.id) {
        return true;
      }
    }
    return false;
  }

  /** 跳到第 `pos` 个命中（越界时不动作） */
  private jumpTo(pos: number): void {
    const list: number[] = this.hits();
    if (pos < 0 || pos >= list.length) {
      return;
    }
    this.matchPos = pos;
    const row: number = this.rowOfHit(list[pos]);
    if (row < 0) {
      // 命中不在当前视图的行里（例如刚切视图）：不滚，而不是滚到第 0 行
      return;
    }
    // `scrollToIndex` 失败（索引越界/列表未就绪）不该让整页崩：搜索只是导航辅助。
    try {
      this.scroller.scrollToIndex(row, true, ScrollAlign.CENTER);
    } catch (err) {
      // 忽略：下一次按键会再试一次
    }
  }

  /** 关键词变化：重算命中并把光标移到第一个命中上 */
  private onQueryChange(value: string): void {
    this.searchQuery = value;
    const list: number[] = this.hits();
    this.matchPos = list.length > 0 ? 0 : -1;
    if (list.length > 0) {
      this.jumpTo(0);
    }
  }

  /** 上一个 / 下一个命中（环绕，见 `stepMatch` 的语义说明） */
  private step(delta: number): void {
    const list: number[] = this.hits();
    this.jumpTo(stepMatch(this.matchPos, list.length, delta));
  }

  /**
   * 视图模式（E108）：`chat` = 只看问答；`trajectory` = 全过程（工具/子代理/目标…）。
   *
   * 默认落在 `chat`：日常是"读答案"，把工具卡默认糊在脸上会淹没对话。
   */
  @State view: string = 'chat';
  /** 任务条的重绘刻度（live 任务的耗时要走字；模型 `jobTickerNeeded` 决定要不要定时器） */
  @State jobsTick: number = 0;
  /** 任务条定时器 id（-1 = 未启动） */
  private jobsTimer: number = -1;

  /**
   * 当前视图下要渲染的条目。
   *
   * `chat` 只留**用户可见的对话**：消息与错误（错误必须留在这里——它是"为什么没有回答"的唯一说明）。
   * `trajectory` 保留全部条目：工具、子代理、目标/任务、交付物都在这里可查。
   */
  /**
   * 对话视图的回合列表（§8）。
   *
   * 【为什么对话视图要以**回合**为单位渲染】§8 要求"已完成的回合可折叠、进行中的回合展开"——
   * 折叠的单位是回合。此前对话视图根本**不显示**过程条目（工具/思考被整段过滤掉），
   * 与 D3 §3.2「思考默认折叠为一行、可展开」也不符：用户看不到"模型做过什么"。
   * 现在改成"每个回合 = 用户消息 + 折叠的过程分组 + 回答"，与官方语义一致。
   */
  private chatTurns(): Turn[] {
    return groupTurns(this.items, this.running);
  }

  /**
   * 列表的行数（sticky-follow 的判据）。
   *
   * 【为什么单独一个函数】`onVisibleRange` 拿可见区间的 **end** 和"最后一行"比较来决定是否贴底。
   * 两个视图的行单位不同（轨迹=条目，对话=回合），若两处各写一遍必然错位——
   * 错位的症状是"明明在底部却不跟随"或"上翻了还被拽回去"，都属于难查的体感缺陷。
   */
  private rowCount(): number {
    return this.view === 'trajectory' ? this.items.length : this.chatTurns().length;
  }

  private visibleItems(): TrajectoryItem[] {
    if (this.view === 'trajectory') {
      return this.items;
    }
    /*
     * 对话视图的可见集合由**回合模型**回答（§8），不再由视图层自己写过滤规则。
     *
     * 【为什么必须搬走】此前这段逻辑里藏着两条判断："什么算对话内容"（只留消息与错误）
     * 与"系统消息不显示"。换个视图（或换个入口）就得再答一次，而两处必然漂移。
     * 现在它们与回合分组**同处一地**（`appstate/model/Turns.ets`），并有 15 条断言覆盖——
     * 其中"错误必须留在对话视图"是 E134 的教训（它是"为什么没有回答"的唯一说明）。
     */
    return chatVisibleItems(groupTurns(this.items, this.running));
  }





  /**
   * 轨迹的**时间总览**（P2 §11：交互式时间总览）。
   *
   * 【为什么需要它】轨迹此前只有一条扁平的事件列表，看不出"这一步花了多久、时间花在哪、总耗时多少"；
   * 而 `sessionStats` 那几个数字（模型用时 / 工具用时 / TTFT / TPS）**投影出来了却没有任何界面显示**。
   *
   * 【为什么每条一格的比例条】官方的做法是把整场会话摊成格子、按耗时给比例，
   * 并支持"**水平拖动可聚焦事件**"（`timeline.overviewAria` 原文）。这里照做：
   * 拖动 → 按条宽把偏移量换算成比例 → 落到哪一格就聚焦哪一格（越界夹到首尾）。
   * 判定规则全在 `model/Timeline`（60 条断言），视图只把比例映射成宽度。
   */

  /** 格子种类的颜色：只有"工具"与"助手"需要区分，其余用中性色（不靠颜色表达状态） */

  build() {
    Column() {
      // 会话头归 ConversationHeader（P2-5 抽出的 chrome）：视图切换 / 任务条 / 时间总览 / 搜索。
      // 它只做"显示 + 转发"——搜索的命中判定与任务条的定时器仍在本组件（跨行的状态留在父组件）。
      ConversationHeader({
        view: this.view,
        items: this.items,
        jobs: this.jobs,
        jobsTick: this.jobsTick,
        stats: this.stats,
        focusedCellId: this.focusedCellId,
        dragging: this.timelineDragging,
        searchOpen: this.searchOpen,
        searchQuery: this.searchQuery,
        matchPos: this.matchPos,
        hitCount: this.hits().length,
        workspaceName: this.workspaceName,
        sessionUpdatedAt: this.sessionUpdatedAt,
        modelLabel: modelSelectionLabel(this.selection, this.models),
        onPickView: (value: string) => {
          this.view = value;
        },
        onExpandAll: () => {
          this.turnController.expandAll();
        },
        onCollapseAll: () => {
          this.turnController.collapseAll();
        },
        onQueryChange: (value: string) => {
          this.onQueryChange(value);
        },
        onStep: (delta: number) => {
          this.step(delta);
        },
        onCloseSearch: () => {
          this.onCloseSearch();
        },
        onFocusCell: (cellId: string) => {
          this.focusedCellId = cellId;
        },
        onCommitTimeline: () => {
          this.scrollToFocusedCell();
        },
        onDragChange: (dragging: boolean) => {
          this.timelineDragging = dragging;
        }
      })

      List({ space: Sp.M, scroller: this.scroller }) {
        if (this.view === 'trajectory') {
          // 轨迹视图 = 全量台账：条目级扁平列表（工具、子代理、目标/任务、交付物都在这里可查）
          ForEach(this.visibleItems(), (item: TrajectoryItem) => {
            ListItem() {
              this.flatItem(item)
            }
            // 命中项加一条左侧色条：**不改变正文**（正文里做高亮要拆 span，
            // 而拆 span 会让 Markdown/代码块的渲染路径多一条分支，风险大于收益）。
            /*
             * 左侧色条承担两种含义，用**颜色**区分（同一个通道，宽度一致）：
             *   · 搜索命中 → brand（与既有行为一致）
             *   · 时间线聚焦 → emphasize（"你现在在时间线的哪一格"）
             * 两者同时成立时以聚焦为准：聚焦是用户刚刚做的动作。
             */
            .border({
              width: { left: this.focusedCellId === item.id || this.isHit(item) ? 3 : 0 },
              color: this.focusedCellId === item.id
                ? $r('sys.color.font_emphasize') : $r('sys.color.brand')
            })
          }, (item: TrajectoryItem) => item.id)
        } else {
          // 对话视图 = 按**回合**渲染（§8）：用户消息 + 过程分组（折叠）+ 回答
          ForEach(this.chatTurns(), (turn: Turn) => {
            ListItem() {
              // 一个回合的渲染归 TurnView（P2-6 第二刀）；"全部展开/收起全部"经控制器接出去。
              TurnView({
                turn: turn,
                expanded: this.expanded,
                onExpandedChange: (next: string[]) => {
                  this.expanded = next;
                },
                controller: this.turnController,
                hasPointer: this.hasPointer,
                hasKeyboard: this.hasKeyboard,
                fbFor: this.fbFor,
                fbNote: this.fbNote2,
                onCopyMessage: (text: string) => {
                  this.onCopyMessage(text);
                },
                onQuoteMessage: (it: TrajectoryItem) => {
                  this.onQuoteMessage(it);
                },
                onResendMessage: (it: TrajectoryItem) => {
                  this.onResendMessage(it);
                },
                onOpenFeedback: (itemId: string, rating: string) => {
                  this.fbFor = itemId;
                  this.fbRating = rating;
                  this.fbNote2 = '';
                },
                onFeedbackNote: (note: string) => {
                  this.fbNote2 = note;
                },
                onCloseFeedback: () => {
                  this.fbFor = '';
                  this.fbNote2 = '';
                },
                onOpenDetail: () => {
                  this.onOpenDetail();
                }
              })
            }
            .border({ width: { left: this.turnHasHit(turn) ? 3 : 0 },
              color: $r('sys.color.brand') })
          }, (turn: Turn) => turn.id)
        }
      }
      .layoutWeight(1)
      .width('100%')
      // 列表 → 条：滚动时让条上的聚焦跟着走（拖动条期间由 `timelineDragging` 关掉这一路）
      .onScrollIndex((firstVisible: number) => {
        this.focusFromListIndex(firstVisible);
      })
      .padding({ left: Sp.M, right: Sp.M, top: Sp.M })
      // E113：可见区间决定"是否跟随最新"；贴底跟随由 `stickToBottom` + 定时器实现
      .onScrollIndex((start: number, end: number) => {
        this.onVisibleRange(start, end);
        this.syncFollowTimer();
      })
      .scrollBar(BarState.Auto)

      Divider().color($r('sys.color.comp_divider'))

      /*
       * 【审批弹在会话里（E115）】以前审批/提问只在「待决」页签里，用户得先切页签再点，
       * 而它恰恰是"卡住当前这一轮"的东西——官方 web 就是把它直接摆在对话流里。
       * 这里放在**输入区正上方**：眼睛在对话上，手指就在按钮附近，一次点击即可放行。
       * 只在这一轮真的有待决时出现，平时不占一行。
       */
      if (this.pending.length > 0) {
        Column({ space: Sp.XS }) {
          Row({ space: Sp.S }) {
            SymbolGlyph($r('sys.symbol.exclamationmark_triangle'))
              .fontSize(14)
              .fontColor([$r('sys.color.warning')])
            Text(`待你决定 · ${this.pending.length}`)
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.warning'))
              .layoutWeight(1)
          }
          .width('100%')

          PendingPane({
            items: this.pending,
            onDecide: (item: PendingItem, choiceId: string, reason: string) => {
              this.onDecidePending(item, choiceId, reason);
            },
            onAnswer: (item: PendingItem, selected: string[], custom: string) => {
              this.onAnswerPending(item, selected, custom);
            }
          })
        }
        .width('100%')
        .constraintSize({ maxHeight: 300 })
        .padding({ left: Sp.M, right: Sp.M, bottom: Sp.S })
      }

      Composer({
        draft: this.draft,
        running: this.running,
        offline: this.offline,
        queuedCount: this.queuedCount,
        attachments: this.attachments,
        queued: this.queued,
        models: this.models,
        selection: this.selection,
        references: this.references,
        commands: this.commands,
        notice: this.notice,
        onDraftChange: this.onDraftChange,
        onSend: () => {
          // 用户发消息 = 他在等回答 ⇒ 恢复跟随（否则上翻过历史时，回答会出现在看不到的地方）
          this.stickToBottom = nextFollowing(this.stickToBottom, FollowSignal.USER_SENT);
          this.scrollToLatest();
          this.onSend();
        },
        onStop: this.onStop,
        onAddAttachment: this.onAddAttachment,
        onRemoveAttachment: this.onRemoveAttachment,
        planActive: this.planActive,
        planPending: this.planPending,
        permissionLabel: this.permissionLabel,
        onPickModel: this.onPickModel,
        onTogglePlan: this.onTogglePlan,
        onReferenceQuery: this.onReferenceQuery,
        onPullQueued: this.onPullQueued,
        onRemoveQueued: this.onRemoveQueued,
        onSteerQueued: this.onSteerQueued
      })
    }
    .width('100%')
    .height('100%')
  }

  // ───────────────────── 轨迹条目 ─────────────────────


  /**
   * 取这次工具调用的改动对照（没有则 null）。
   *
   * 【失败态刻意不出对照卡】官方渲染器对 `isError` 的块直接返回 null——
   * 因为失败时参数只是"意图"，真正的结果在输出里；此时把意图画成对照会误导
   * （看起来"改了"，其实没改成）。我们照此：失败/被拒一律走原输出视图。
   */

  /** 对照的行文本（带 +/-/空格前缀——这是 diff 的通用读法） */

  /** 对照每行的性质（与原语里的取色按下标对应） */

  /** 徽标：非通用类别时带上类别名（"读取 · 成功"比单说"成功"有用） */

  /**
   * 类别 → 系统符号。
   *
   * 【符号名不是猜的】每个名字都用编译器验过（不存在会 `Unknown resource name`）——
   * 例如 `terminal`/`globe`/`photo`/`pencil` 在本 SDK **都不存在**，实测后改用 `code`/`link`/`picture`/`pencil_line`。
   *
   * 【为什么图标映射留在视图层】`$r(...)` 是 ArkUI 资源引用，模型层（appstate）刻意不认识它——
   * 那条边界让模型可以在本机直接执行。所以"哪一类画哪个图标"是视图的决定，类别判定才是模型的。
   */



  /**
   * 交付物的动作行（数据化：review 时一眼看得完"这一行有哪些动作"）。
   *
   * 保存/分享都交给宿主（文件系统与系统分享面板是平台能力，视图层不直接依赖 platform），
   * 与 Composer 的复制同一条约定。
   */


  // ───────────────────── 辅助 ─────────────────────


}
