/**
 * 工具调用卡（P3-5：从 `ConversationPane` 抽出的**共用**呈现）。
 *
 * ## 为什么抽出来
 *
 * 它有两个"家"：会话过程流里的一张卡，以及**右栏的「工具」面板**（官方右栏的候选之一）。
 * 这张卡是过程流里信息量最大的一张（图标 / 语气 / 参数摘要 / **改动对照** / 输出预览 / 截断提示），
 * 两处各画一份必然走样。抽出来之后，`ConversationPane` 里那一整套判定
 * （`diffOf` / `diffTextLines` / `diffKindLines` / `toolBadge` / `toolIcon`）也跟着过来——
 * **判定与呈现同处一组件**，宿主只给"数据 + 展开态 + 回调"。
 *
 * ## 两条判定仍来自模型（视图不重写）
 *
 *  · 类别与语气：`presentTool(this.item, toolStateLabel(this.item.toolState))`（17 条断言）
 *  · 改动对照：`presentDiff(toolName, toolArgs)`（45 条断言）；
 *    **失败 / 被拒刻意不出对照**（官方对 `isError` 返回 null：失败时参数只是"意图"，画成对照会误导）。
 *
 * ## 展开态为什么是入参
 *
 * 主区的「展开全部 / 收起全部」要能一次性控制所有卡（`ConversationPane.expanded` 数组是唯一真值），
 * 所以本组件**不自己持有展开态**，只吃 `expanded` + 报 `onToggle`。右栏面板同样如此
 * （它维护自己那一条列表的展开集合）。
 */

import {
  ToolKind, ToolState, TrajectoryItem, formatClock, formatDuration,
  presentDiff, presentTool, previewOutput, toolStateLabel, toolSummaryOf,
} from 'appstate';
import type { DiffPresentation, ToolPresentation } from 'appstate';
import { NativeCard } from './NativePrimitives';

@Component
export struct ToolCard {
  /** 要显示的工具调用条目 */
  @Prop item: TrajectoryItem;
  /** 是否已展开（唯一真值在宿主；见文件头说明） */
  @Prop expanded: boolean = false;

  /** 点卡片展开/收起 */
  onToggle: () => void = () => {
  };

  build() {
    // 卡片本体走 P1.5 的原语（NativeCard）；**工具类别**由 `ToolPresenter` 判定
    // （纯模型 + 17 条断言）：图标、语气、展开默认态、无障碍文案都不再由视图各自猜。
    NativeCard({
      iconSymbol: this.toolIcon(presentTool(this.item, toolStateLabel(this.item.toolState)).kind),
      title: this.item.toolName,
      badge: this.toolBadge(),
      tone: presentTool(this.item, toolStateLabel(this.item.toolState)).tone,
      meta: this.item.elapsedMs > 0
        ? (this.item.at > 0
          ? `${formatClock(this.item.at)} · ${formatDuration(this.item.elapsedMs)}`
          : formatDuration(this.item.elapsedMs))
        : '',
      // 参数摘要**按类别提炼**（§11 的 path summary）：终端出命令、读取出路径、搜索出模式+范围；
      // 提炼不到再退回清理后的原文——不再把整段 JSON 糊在卡片第一行。
      summary: toolSummaryOf(presentTool(this.item, toolStateLabel(this.item.toolState)).kind, this.item.toolArgs),
      // 编辑类工具优先显示**改动对照**（有对照时不再显示工具的输出确认）：
      // 用户要看的是"改了什么"，而不是"改成功了"这句话。
      diffLines: this.diffTextLines(),
      diffKinds: this.diffKindLines(),
      bodyText: this.diffTextLines().length > 0
        ? ''
        : ((this.expanded
          || presentTool(this.item, toolStateLabel(this.item.toolState)).defaultExpanded)
          ? previewOutput(this.item.toolOutput).shown
          : ''),
      bodyTruncatedHint: this.diffTextLines().length > 0
        ? (this.diffOf() !== null && this.diffOf()!.truncated
          ? '▸ 对照较长，已按上限截断' : '')
        : (previewOutput(this.item.toolOutput).truncated
          ? `▸ 查看完整输出（共 ${previewOutput(this.item.toolOutput).totalLength} 字符）`
          : ''),
      collapsedHint: this.diffOf() !== null
        ? `▸ 查看改动 +${this.diffOf()!.added} −${this.diffOf()!.removed}`
        : (this.item.toolOutput.length > 0 ? '▸ 查看结果' : ''),
      expanded: this.expanded
        || presentTool(this.item, toolStateLabel(this.item.toolState)).defaultExpanded,
      a11y: presentTool(this.item, toolStateLabel(this.item.toolState)).a11y,
      onToggle: () => {
        this.onToggle();
      }
    })
  }

  private diffOf(): DiffPresentation | null {
    if (this.item.toolState === ToolState.FAILED || this.item.toolState === ToolState.REJECTED) {
      return null;
    }
    if (this.item.toolState !== ToolState.SUCCESS && this.item.toolState !== ToolState.RUNNING) {
      return null;
    }
    return presentDiff(this.item.toolName, this.item.toolArgs);
  }

  private diffTextLines(): string[] {
    const p: DiffPresentation | null = this.diffOf();
    const out: string[] = [];
    if (p === null) {
      return out;
    }
    for (let i = 0; i < p.lines.length; i++) {
      const kind: string = p.lines[i].kind;
      if (kind === 'added') {
        out.push('+ ' + p.lines[i].text);
      } else if (kind === 'removed') {
        out.push('- ' + p.lines[i].text);
      } else if (kind === 'skipped') {
        out.push(`  ⋯ 省略 ${p.lines[i].skipped} 行未改动`);
      } else {
        out.push('  ' + p.lines[i].text);
      }
    }
    return out;
  }

  private diffKindLines(): string[] {
    const p: DiffPresentation | null = this.diffOf();
    const out: string[] = [];
    if (p === null) {
      return out;
    }
    for (let i = 0; i < p.lines.length; i++) {
      out.push(p.lines[i].kind);
    }
    return out;
  }

  private toolBadge(): string {
    const p: ToolPresentation = presentTool(this.item, toolStateLabel(this.item.toolState));
    const state: string = toolStateLabel(this.item.toolState);
    return p.kind === ToolKind.GENERIC ? state : `${p.kindLabel} · ${state}`;
  }

  private toolIcon(kind: ToolKind): Resource {
    if (kind === ToolKind.TERMINAL) {
      return $r('sys.symbol.code');
    }
    if (kind === ToolKind.READ) {
      return $r('sys.symbol.doc_text');
    }
    if (kind === ToolKind.WRITE) {
      return $r('sys.symbol.square_and_pencil');
    }
    if (kind === ToolKind.EDIT) {
      return $r('sys.symbol.pencil_line');
    }
    if (kind === ToolKind.SEARCH) {
      return $r('sys.symbol.magnifyingglass');
    }
    if (kind === ToolKind.WEB) {
      return $r('sys.symbol.link');
    }
    if (kind === ToolKind.IMAGE) {
      return $r('sys.symbol.picture');
    }
    if (kind === ToolKind.ASK) {
      return $r('sys.symbol.questionmark_circle');
    }
    return $r('sys.symbol.wrench_and_screwdriver');
  }
}
