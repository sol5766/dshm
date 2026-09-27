/**
 * 轨迹的**时间总览**（P3-6：从 `ConversationPane` 抽出的**共用**呈现）。
 *
 * ## 它是什么
 *
 * 「总计 + 每格比例条 + 水平拖动可聚焦事件」（官方 `timeline.overviewAria` 的语义，47 条断言在
 * `appstate/model/Timeline`）。此前它只长在主区「轨迹视图」的顶部；现在右栏的「轨迹」面板也用**同一份**
 * ——注意两者的差别：**主区是"全量台账 + 总览"，右栏是"总览"**。官方右栏的 trajectory 是
 * "当前回合的过程"，本仓没有"回合作用域的过程列表"这个概念（`TrajectoryItem` 没有回合字段），
 * 所以右栏只放总览：**宁可少放一份列表，也不把主区那份台账在 320vp 里照抄一遍**。
 *
 * ## 受控项（都因为"别处也要读写"）
 *
 *  · `focusedCellId` —— 主区列表滚动时也会改它（列表 → 条那一路），唯一真值必须留在宿主；
 *  · `dragging` —— 拖动期间宿主**暂停**"列表 → 条"，否则条会被自己的滚动带着抖；
 *  · `onCommit` —— "松手/点击落定才滚列表"是宿主的动作（要拿 `scroller`）。
 *
 * 组件自己只管：比例条宽度（`onAreaChange`）、拖动过程、悬停高亮、详情行文案。
 */

import {
  Fs, Radius, Sp, StatsLine, StatsUnit, Sz, TimelineCell, TimelineKind, TimelineScale,
  TimelineSegment, TrajectoryItem, cellIdAtRatio, formatClock, formatDuration,
  segmentOrdinalOf, statsLinesOf, timelineCellsOf, timelineKindLabel, timelineScaleOf,
  timelineStartedLabel, timelineTotalLabel,
} from 'appstate';
import type { SessionStatsInput } from 'appstate';

@Component
export struct TimelineOverview {
  /** 当前会话的过程条目（组件自己算格子与比例） */
  @Prop items: TrajectoryItem[] = [];
  /** 会话统计（时间四项；轮次/步数由会话头承担，这里不重复） */
  @Prop stats: SessionStatsInput;
  /** 聚焦的格子（受控） */
  @Prop focusedCellId: string = '';
  /** 是否正在拖动比例条（受控：宿主据此暂停"列表 → 条"） */
  @Prop dragging: boolean = false;

  /** 聚焦某格（拖动过程中会连续触发） */
  onFocusCell: (cellId: string) => void = () => {
  };
  /** 拖动/点选**落定**（宿主在此把该格滚进视野） */
  onCommit: () => void = () => {
  };
  /** 拖动状态变化（受控项的写回口） */
  onDragChange: (dragging: boolean) => void = () => {
  };

  /** 比例条实测宽度（拖动换算的起点） */
  @State barWidth: number = 0;

  build() {
    Column({ space: Sp.XS }) {
      Row({ space: Sp.S }) {
        Text(timelineTotalLabel(this.timelineScale()))
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_secondary'))
        Text(`${this.timelineScale().count} 格`)
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
        Blank()
        // 会话统计的**时间四项**（轮次/步数由会话头部那行承担，不在这里重复）
        ForEach(statsLinesOf(this.stats), (line: StatsLine) => {
          Text(this.statsLineText(line))
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_tertiary'))
        }, (line: StatsLine) => line.key)
      }
      .width('100%')

      if (this.timelineScale().hasData) {
        // 比例条：每段用**累计起点 + 宽度**摆放（不是浮动相加，避免四舍五入出缝隙）
        Stack({ alignContent: Alignment.Start }) {
          Row() {
            ForEach(this.timelineScale().segments, (seg: TimelineSegment) => {
              Column()
                .width(`${seg.ratio * 100}%`)
                .height(this.focusedCellId === seg.id ? Sz.POINTER_MIN : Sp.M)
                .backgroundColor(this.timelineColorOf(seg.kind))
            }, (seg: TimelineSegment) => seg.id)
          }
          .width('100%')
          .height(Sp.M)
          .borderRadius(Radius.XS)
          .clip(true)
        }
        .width('100%')
        .onAreaChange((_oldArea: Area, newArea: Area) => {
          this.barWidth = Number(newArea.width);
        })
        .gesture(
          PanGesture({ direction: PanDirection.Horizontal })
            .onActionStart(() => {
              this.onDragChange(true);
            })
            .onActionUpdate((event: GestureEvent) => {
              this.focusTimelineAt(event.offsetX);
            })
            .onActionEnd(() => {
              this.onDragChange(false);
              // 松手才滚（见 `scrollToFocusedCell` 的说明）
              this.onCommit();
            })
        )
        .onClick((event: ClickEvent) => {
          // `event.x` 是**相对本组件**的横坐标，正是比例条的换算起点（`displayX` 是相对窗口的）
          this.focusTimelineAt(Number(event.x));
          this.onCommit();
        })

        if (this.focusedTimelineNote().length > 0) {
          Text(this.focusedTimelineNote())
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_secondary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
      } else {
        // 官方 `timeline.noTimingData` 的情形：如实说"无计时数据"，而不是画一条空条
        Text('这一轮的条目没有计时数据，无法给出时间分布。')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
      }
    }
    .width('100%')
    .padding({ left: Sp.M, right: Sp.M, top: Sp.XS, bottom: Sp.XS })
    .backgroundColor($r('sys.color.background_primary'))
  }

  private timelineCells(): TimelineCell[] {
    return timelineCellsOf(this.items);
  }

  private timelineScale(): TimelineScale {
    return timelineScaleOf(this.timelineCells());
  }

  private focusedTimelineNote(): string {
    const cells: TimelineCell[] = this.timelineCells();
    let cell: TimelineCell | undefined = undefined;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].id === this.focusedCellId) {
        cell = cells[i];
        break;
      }
    }
    if (cell === undefined) {
      return '';
    }
    const parts: string[] = [];
    parts.push(`${timelineKindLabel(cell.kind)} · ${segmentOrdinalOf(this.timelineScale().segments, cell.id)}/${this.timelineScale().segments.length}`);
    const started: string = timelineStartedLabel(cell, (at: number) => (at > 0 ? formatClock(at) : ''));
    if (started.length > 0) {
      parts.push(started);
    }
    if (cell.durationMs > 0) {
      parts.push(formatDuration(cell.durationMs));
    }
    return parts.join(' · ');
  }

  private statsLineText(line: StatsLine): string {
    if (line.unit === StatsUnit.MS) {
      return `${line.label} ${formatDuration(Math.round(line.value))}`;
    }
    if (line.unit === StatsUnit.TPS) {
      return `${line.label} ${line.value.toFixed(1)}`;
    }
    return `${line.label} ${line.value}`;
  }

  private focusTimelineAt(deltaXVp: number): void {
    const scale: TimelineScale = this.timelineScale();
    if (scale.segments.length === 0 || this.barWidth <= 0) {
      return;
    }
    const ratio: number = deltaXVp / this.barWidth;
    const id: string = cellIdAtRatio(scale.segments, ratio);
    if (id.length > 0) {
      this.onFocusCell(id);
    }
  }

  private timelineColorOf(kind: TimelineKind): Resource {
    if (kind === TimelineKind.TOOL) {
      return $r('sys.color.brand');
    }
    if (kind === TimelineKind.USER) {
      return $r('sys.color.comp_background_tertiary');
    }
    return $r('sys.color.comp_divider');
  }
}
