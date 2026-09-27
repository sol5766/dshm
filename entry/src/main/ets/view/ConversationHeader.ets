/**
 * 会话正文的**头部**（P2-5：从 `ConversationPane` 抽出的第一刀）。
 *
 * ## 它拥有什么
 *
 * 1. **视图切换**（对话 / 轨迹）与轨迹工具栏（展开全部 / 收起全部 / 事件计数）；
 * 2. **后台任务条**（官方在会话头；`Jobs` 模型判定，live 任务每秒走字）；
 * 3. **时间总览**（轨迹视图的交互式总览，官方 `timeline.overviewAria`）；
 * 4. **会话内搜索条**（输入框 + 命中计数 + 上/下一条 + 关闭）。
 *
 * ## 为什么"头部"值得单独成组件
 *
 * 这四块的共同点是：**它们都在正文列表之外**，决定"正文要以什么形态呈现"，
 * 而不是正文本身。混在正文组件里时，正文的每一点改动都要绕过这 240 行 chrome；
 * 抽出去之后父组件只剩"列表 + 尾部"。
 *
 * ## 搜索与任务条的**状态为什么仍在父组件**
 *
 * · **搜索**：命中判定要扫整条过程流（`matchTrajectoryIndices`），命中的高亮也要画在
 *   列表项上 ⇒ 状态在父组件，这里只做"显示 + 转发"（输入框的每个字符都会回到父组件）。
 * · **任务条**：live 任务的耗时每秒走字，而"要不要起定时器"由模型 `jobTickerNeeded`
 *   判定、父组件持有定时器 ⇒ 刻度（`jobsTick`）由父组件当 prop 传进来，
 *   **它同时是本组件的真实依赖**（刻度变了才重绘）。
 *
 * 这条分工与 `MessageRow` 的两条边界同源：**跨行的状态留在父组件，行内/块内的留在这里**。
 */

import {
  Fs, JobDot, Radius, SemanticColor, Sp, Sz,
  jobCountLabel, jobDotState, jobDurationText, jobDurationTitle, jobElapsedMs,
  jobListA11y, jobListVisible, jobRowStatusText, matchCounterText, orderedJobs,
  relativeTime, sessionContextLine
} from 'appstate';
import type { SessionJob, SessionStatsInput, TrajectoryItem } from 'appstate';
import { TimelineOverview } from './TimelineOverview';

/** 会话头的呈现（视图切换 / 任务条 / 时间总览 / 搜索） */
@Component
export struct ConversationHeader {
  /** 当前视图（`chat` / `trajectory`）——唯一真值在父组件 */
  @Prop view: string = 'chat';
  /** 全量条目（轨迹工具栏的计数 + 时间总览的输入） */
  @Prop items: TrajectoryItem[] = [];
  /** 后台任务（官方会话头的任务条；模型判定"要不要显示"） */
  @Prop jobs: SessionJob[] = [];
  /** 任务条的重绘刻度（live 任务每秒走字；父组件的定时器在推进它） */
  @Prop jobsTick: number = 0;
  /**
   * 时间总览要的统计（数字，不是拼好的字符串）。
   *
   * 【为什么没有默认值】与 `TimelineOverview` 一致：宿主一定给（它就是投影出来的统计事实）。
   * 造一个"全 0 的默认统计"会让"没接到数据"看起来像"这场会话什么也没花"——那是假的读数。
   */
  @Prop stats: SessionStatsInput;
  /** 时间线当前聚焦的格子（父组件持有：滚动时它也跟着走） */
  @Prop focusedCellId: string = '';
  /** 是否正在拖动时间线（拖动期间关掉"滚动→聚焦"这一路） */
  @Prop dragging: boolean = false;
  /** 搜索条是否打开 */
  @Prop searchOpen: boolean = false;
  /** 搜索词（唯一真值在父组件） */
  @Prop searchQuery: string = '';
  /** 命中位置 / 命中总数（父组件算好——它扫的是整条过程流） */
  @Prop matchPos: number = -1;
  @Prop hitCount: number = 0;
  /** 上下文行：工作区名（空 = 不显示这一段） */
  @Prop workspaceName: string = '';
  /** 选中会话的最近活动时间（毫秒；0 = 不显示「多久没动」） */
  @Prop sessionUpdatedAt: number = 0;
  /** 当前模型名（父组件用 `modelSelectionLabel` 拼好；空 = 不显示） */
  @Prop modelLabel: string = '';

  /** 切视图（对话 / 轨迹） */
  onPickView: (view: string) => void = () => {
  };
  /** 轨迹工具栏：展开全部 / 收起全部 */
  onExpandAll: () => void = () => {
  };
  onCollapseAll: () => void = () => {
  };
  /** 搜索词变化（父组件重算命中） */
  onQueryChange: (value: string) => void = () => {
  };
  /** 上一条 / 下一条命中 */
  onStep: (delta: number) => void = () => {
  };
  /** 关闭搜索 */
  onCloseSearch: () => void = () => {
  };
  /** 时间总览：聚焦某一格 / 提交（提交 = 滚到聚焦项）/ 拖动状态变化 */
  onFocusCell: (cellId: string) => void = () => {
  };
  onCommitTimeline: () => void = () => {
  };
  onDragChange: (dragging: boolean) => void = () => {
  };

  /**
   * 上下文行：工作区 · 模型 · 最近活动。
   *
   * 【为什么在视图里拼】三段事实都在本组件手边（两个 prop + 父组件拼好的模型名），
   * 而「每段拿不到就不出现」的规则在 `sessionContextLine`（纯模型、有 fixture）。
   * 【为什么要传 now】`relativeTime` 需要「现在」，由调用点给 ⇒ 这一行随时钟自然更新，
   * 不引入第二个定时器（任务条已经有一个每秒刻度）。
   */
  private contextLine(): string {
    const updated: string = this.sessionUpdatedAt > 0
      ? relativeTime(this.sessionUpdatedAt, Date.now())
      : '';
    return sessionContextLine(this.workspaceName, this.modelLabel, updated);
  }

  /** 状态点 → 语义色（模型给语义 `JobDot`，颜色是视图的事） */
  private jobDotColor(status: string): Resource {
    const dot: JobDot = jobDotState(status);
    if (dot === JobDot.ONGOING) {
      return SemanticColor.BRAND;
    }
    if (dot === JobDot.WARNING) {
      return SemanticColor.WARNING;
    }
    if (dot === JobDot.DONE) {
      return SemanticColor.CONFIRM;
    }
    return SemanticColor.ALERT;
  }

  build() {
    Column() {
      /*
       * 对话 / 轨迹 两个视图（E108，与官方 web 一致）。
       *
       * 【为什么分开】同一条会话流里有两种读者需求：
       *   - **对话**：只看问答（人说的话 + 模型的回答，思考折叠在回答上方）——日常使用；
       *   - **轨迹**：看全过程（工具调用、子代理、目标/任务、交付物、错误）——排查与复盘。
       * 官方 web 也是这两个视图；混在一起会让"想安静读答案"的人被工具卡刷屏，
       * 而"想查某次工具参数"的人又要在气泡之间翻找。
       */
      // 上下文行（P2-7，对齐官方 conversation.header 的 Workspace context / Model 两项）：
      // 一段都拿不到时整行不画——空行占位比没有更难读。
      if (this.contextLine().length > 0) {
        Text(this.contextLine())
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .padding({ left: Sp.M, right: Sp.M, top: Sp.XS })
      }

      Row({ space: Sp.S }) {
        this.viewChip('chat', $r('app.string.view_chat'))
        this.viewChip('trajectory', $r('app.string.view_trajectory'))
        Blank()
        if (this.view === 'trajectory') {
          // E197：官方的"展开/收起所有"（`toolbar.expandTurns`/`collapseTurns`、`expandCalls`/`collapseCalls`）
          Text('展开全部')
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.brand'))
            .onClick(() => {
              this.onExpandAll();
            })
          Text('收起全部')
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.brand'))
            .onClick(() => {
              this.onCollapseAll();
            })
          Text(`${this.items.length} 条事件`)
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_tertiary'))
        }
      }
      .width('100%')
      .padding({ left: Sp.M, right: Sp.M, top: Sp.S })

      // 后台任务条（官方在会话头）：有任务才出现，位置在视图切换行下方
      if (jobListVisible(this.jobs)) {
        this.jobsStrip()
      }

      // 轨迹视图的时间总览（P2 §11 的 TrajectoryPresenter）
      if (this.view === 'trajectory') {
        // 时间总览归 TimelineOverview（右栏「轨迹」面板用**同一份**）
        TimelineOverview({
          items: this.items,
          stats: this.stats,
          focusedCellId: this.focusedCellId,
          dragging: this.dragging,
          onFocusCell: (cellId: string) => {
            this.onFocusCell(cellId);
          },
          onCommit: () => {
            this.onCommitTimeline();
          },
          onDragChange: (dragging: boolean) => {
            this.onDragChange(dragging);
          }
        })
      }

      if (this.searchOpen) {
        this.searchBar()
      }
    }
    .width('100%')
  }

  @Builder
  viewChip(value: string, label: ResourceStr) {
    Text(label)
      .fontSize(Fs.SECONDARY)
      .fontColor(this.view === value ? Color.White : $r('sys.color.font_secondary'))
      .padding({ left: Sp.M, right: Sp.M, top: Sp.XS, bottom: Sp.XS })
      .borderRadius(Radius.L)
      .backgroundColor(this.view === value
        ? $r('sys.color.brand')
        : $r('sys.color.background_secondary'))
      .onClick(() => {
        this.onPickView(value);
      })
  }

  @Builder
  searchBar() {
    Row({ space: Sp.S }) {
      TextInput({ text: this.searchQuery, placeholder: '在本次会话中搜索…' })
        .layoutWeight(1)
        .constraintSize({ minHeight: Sz.TOUCH_MIN - 8 })
        .onChange((value: string) => {
          this.onQueryChange(value);
        })
        .accessibilityText('会话内搜索输入框')
      Text(matchCounterText(this.matchPos, this.hitCount))
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_tertiary'))
      Text('↑')
        .fontSize(Fs.SECONDARY)
        .fontColor($r('sys.color.brand'))
        .padding(Sp.XS)
        .onClick(() => {
          this.onStep(-1);
        })
      Text('↓')
        .fontSize(Fs.SECONDARY)
        .fontColor($r('sys.color.brand'))
        .padding(Sp.XS)
        .onClick(() => {
          this.onStep(1);
        })
      Text('×')
        .fontSize(Fs.SECONDARY)
        .fontColor($r('sys.color.font_secondary'))
        .padding(Sp.XS)
        .onClick(() => {
          this.onCloseSearch();
        })
    }
    .width('100%')
    .padding({ left: Sp.M, right: Sp.M, top: Sp.S, bottom: Sp.S })
    .backgroundColor($r('sys.color.background_secondary'))
  }

  /**
   * 后台任务条（P2-2：官方会话头的 `conversation.header.jobs`）。
   *
   * 【为什么把整段判定都放在模型里】"有没有任务要显示"（`jobListVisible`）、
   * 排序（`orderedJobs`）、状态文案（`jobRowStatusText`）、耗时（`jobElapsedMs` /
   * `jobDurationText` / `jobDurationTitle`）、无障碍整段（`jobListA11y`）——全在 `Jobs` 模型里
   * （40 条断言）；视图只做"点 + 字 + 颜色"。
   */
  @Builder
  jobsStrip() {
    Column({ space: Sp.XS }) {
      Row({ space: Sp.S }) {
        Text(jobCountLabel(this.jobs))
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .layoutWeight(1)
        Text('展开收起全部任务在「轨迹」')
          .fontSize(Fs.CAPTION_XS)
          .fontColor($r('sys.color.font_tertiary'))
      }
      .width('100%')

      Flex({ wrap: FlexWrap.Wrap }) {
        ForEach(orderedJobs(this.jobs), (job: SessionJob) => {
          Row({ space: Sp.XS }) {
            SymbolGlyph($r('sys.symbol.circle'))
              .fontSize(Fs.CAPTION_XS)
              .fontColor([this.jobDotColor(job.status)])
            Text(job.label.length > 0 ? job.label : job.kind)
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.font_secondary'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
            Text(jobRowStatusText(job))
              .fontSize(Fs.CAPTION_XS)
              .fontColor($r('sys.color.font_tertiary'))
            Text(jobDurationText(jobElapsedMs(job, Date.now())))
              .fontSize(Fs.CAPTION_XS)
              .fontColor($r('sys.color.font_tertiary'))
          }
          .padding({ left: Sp.S, right: Sp.S, top: Sp.XS, bottom: Sp.XS })
          .margin({ right: Sp.XS, bottom: Sp.XS })
          .borderRadius(Radius.S)
          .backgroundColor($r('sys.color.background_secondary'))
          .accessibilityText(jobDurationTitle(job, Date.now()))
          // key 带上"每秒刻度"：live 任务的耗时才会走字（读 `jobsTick` 也让刻度成为本组件的真实依赖）
        }, (job: SessionJob) => `${job.id}:${this.jobsTick}`)
      }
      .width('100%')
    }
    .width('100%')
    .padding({ left: Sp.M, right: Sp.M, top: Sp.XS })
    .accessibilityText(jobListA11y(this.jobs))
  }
}
