/**
 * 工作区浏览器（`workspaceHub` + `workspaceGroup`）—— P1：Sidebar 信息架构的**第一块**。
 *
 * ## 这一块是什么
 *
 * 官方 `dsh-client-ui-workspace` 是 **Sidebar 里的「工作区→会话」浏览器**：工作区为组、
 * 会话挂在组下（`docs/parity-matrix.md` 的 `sidebar` 行）。本仓原先这段树长在**主区**里
 * （`TabContentView` 的 `workspaceHub`/`workspaceGroup`，285 行），与 Sidebar 是两处；
 * 抽成独立组件之后，它既是主区那个页签的内容，也**可以原样挂进侧栏**——
 * 搬迁动作因而只剩"换个挂载点"，不需要再动树本身。
 *
 * 【为什么这次一行都不用改名】它本来就只经 `this.f.<成员>` 访问宿主 —— 新门面就是那些成员的**子集**
 * （30 个，名字与形状逐条从 `TabContentFacade` 抄来）。这与前三束（要批量改名 + 造 setter）不同：
 * 门面做到位之后，搬迁成本会一路下降。
 *
 * 【`compact` 为什么是入参】"紧凑"取决于**挂载它的那条轨道有多宽**，不是组件的属性：
 * 主区里由 `TabContentView` 给，将来挂进侧栏时由侧栏给（同一个组件，两种宽度）。
 */

import { HubBanner } from './HubBanner';
import { PendingPane } from './PendingPane';
import { CoreViewState, Fs, HarmonyIconSize, HubPhase, PendingItem, Radius, SessionListItem, Sp, Sz, WorkspaceItem, formatClock, relativeTime, sessionEmptyCopy } from 'appstate';

export interface WorkspaceBrowserFacade {
  answerPending: (item: PendingItem, selected: string[], custom: string) => void;
  archiveOpen: boolean;
  archivedSessionIds: string[];
  archivedSessions: () => SessionListItem[];
  /** 归档一个会话（副作用与失败文案留在宿主：宽版与窄版共用） */
  archiveSession: (id: string) => void;
  /** 删除登记的两步确认（判定与提示文案归宿主，宽窄两版共用） */
  toggleDeleteConfirm: (w: WorkspaceItem) => void;
  confirmingDeletePath: string;
  connectBusy: boolean;
  connectSettled: boolean;
  coreView: CoreViewState;
  createSessionIn: (w: WorkspaceItem) => void;
  decidePending: (item: PendingItem, choiceId: string, reason: string) => void;
  hubAuthority: string;
  hubError: string;
  hubPhase: HubPhase;
  hubStreams: number;
  hubTraceTail: () => string[];
  openDiagnostics: () => void;
  openFolderPicker: () => void;
  openSession: (id: string) => void;
  openWorkspaceFiles: (w: WorkspaceItem) => void;
  pending: PendingItem[];
  registryIdOf: (w: WorkspaceItem) => string;
  selectedSessionId: string;
  sessionsOf: (w: WorkspaceItem) => SessionListItem[];
  setArchiveOpen: (value: boolean) => void;
  workspaces: WorkspaceItem[];
}

@Component
export struct WorkspaceBrowser {

  /** 门面（**每次渲染重建**，同 `MainShell`/`AppShell`） */

  @Prop f: WorkspaceBrowserFacade;
  /** 是否紧凑（由挂载方按轨道宽度给） */

  @Prop compact: boolean = false;

  @Builder
  workspaceHub(compact: boolean) {
    Column({ space: Sp.S }) {
      // 连接状态条（E111）：**先区分"正在连"与"连不上"**。
      // 启动时要等本机核心就绪（几十秒），这段时间中枢的 lastError 可能带着中间态文本；
      // 无条件渲染它，用户就会看到「无法连接核心」闪一下——那是假报错。
      if (this.f.connectBusy || !this.f.connectSettled) {
        Text($r('app.string.connecting_local_core'))
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')
          .padding(Sp.S)
          .borderRadius(Radius.S)
          .backgroundColor($r('sys.color.background_secondary'))
      } else if (this.f.hubError.length > 0) {
        HubBanner({
          errorText: this.f.hubError, authority: this.f.hubAuthority, phase: this.f.hubPhase,
          streams: this.f.hubStreams, traceTail: this.f.hubTraceTail(),
          onOpenDiagnostics: () => {
            this.f.openDiagnostics();
          }
        })
      }

      Row({ space: 4 }) {
        /*
         * E163（用户反馈①）：**顶层不再放「新建会话」**。
         * 用户原话："新建会话应当在工作区文件夹上点击，而不是处在顶层外围，不然不知是给哪个工作区加会话。"
         * 现在入口在每个工作区组头（见 `workspaceGroup`），建会话时会把该工作区注册成目标 ⇒
         * "给哪个工作区加会话"从"猜"变成"看得见"。
         */
        Text('选择工作区后，在其组头点「+ 会话」')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
      }
      .width('100%')
      .height(Sz.TOUCH_MIN)
      Blank()
      Text($r('app.string.action_choose_folder'))
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.brand'))
        .onClick(() => {
          this.f.openFolderPicker();
        })
      .width('100%')
      .height(Sz.TOUCH_MIN)

      if (this.f.pending.length > 0) {
        Column({ space: Sp.XS }) {
          Text(`待你决定 · ${this.f.pending.length}`)
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.warning'))
            .width('100%')
          PendingPane({
            items: this.f.pending,
            onDecide: (item: PendingItem, choiceId: string, reason: string) => {
              this.f.decidePending(item, choiceId, reason);
            },
            onAnswer: (item: PendingItem, selected: string[], custom: string) => {
              this.f.answerPending(item, selected, custom);
            }
          })
        }
        .width('100%')
        .constraintSize({ maxHeight: 320 })
      }

      /*
       * E134：归档列表（官方语义：注册表全局归档集）。
       *
       * 【为什么是只读】线协议只给了 `workspace/archiveSession`，**没有反向端点**——
       * 所以这里列出它们、可以点开看，但不提供"恢复"（那会是个点不动的按钮）。
       * 归档集为空时整段不出现，不占版面。
       */
      if (this.f.archivedSessionIds.length > 0) {
        /*
         * E165：归档**默认折叠**（反馈②）。这一行是入口；点开才列出已归档会话。
         * 说明文字写清语义，避免"归档了为什么还在这里"的误解。
         */
        Row({ space: Sp.S }) {
          Text(`${$r('app.string.section_archive')} · ${this.f.archivedSessionIds.length}`)
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_tertiary'))
            .layoutWeight(1)
          Text(this.f.archiveOpen ? '收起' : '展开')
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.brand'))
        }
        .width('100%')
        .padding(Sp.M)
        .borderRadius(Radius.S)
        .backgroundColor($r('sys.color.background_secondary'))
        .onClick(() => {
          this.f.setArchiveOpen(!this.f.archiveOpen);
        })

        if (this.f.archiveOpen) {
        Column({ space: Sp.XS }) {
          Text(`${$r('app.string.section_archive')} · ${this.f.archivedSessionIds.length}`)
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_tertiary'))
            .width('100%')
          ForEach(this.f.archivedSessions(), (s: SessionListItem) => {
            Row({ space: Sp.S }) {
              SymbolGlyph($r('sys.symbol.archivebox')).fontSize(HarmonyIconSize.STATUS)
                .fontColor([$r('sys.color.font_secondary')])
              Text(s.title.length > 0 ? s.title : $r('app.string.label_unnamed_session'))
                .fontSize(Fs.SECONDARY)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .layoutWeight(1)
              Text(formatClock(s.updatedAt))
                .fontSize(Fs.CAPTION)
                .fontColor($r('sys.color.font_tertiary'))
            }
            .width('100%')
            .padding(Sp.M)
            .borderRadius(Radius.S)
            .backgroundColor($r('sys.color.background_primary'))
            .onClick(() => {
              this.f.openSession(s.id);
            })
          }, (s: SessionListItem) => s.id)
        }
        .width('100%')
        .padding(Sp.M)
        .borderRadius(Radius.M)
        .backgroundColor($r('sys.color.background_secondary'))
        }
      }

      if (this.f.workspaces.length === 0) {
        // 空态按核心阶段分档（D7 §3 第 7 项）：把"看不到会话"引向正确的排查方向
        Column({ space: Sp.S }) {
          SymbolGlyph($r('sys.symbol.folder'))
            .fontSize(36)   // token-exempt: 空态大图标，仅此一处，不属于排版层级
            .fontColor([$r('sys.color.font_tertiary')])
          Text(sessionEmptyCopy(this.f.coreView.phase).title)
            .fontSize(Fs.BODY)
            .fontColor($r('sys.color.font_secondary'))
          Text(sessionEmptyCopy(this.f.coreView.phase).hint)
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_tertiary'))
            .textAlign(TextAlign.Center)
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else {
        List({ space: this.compact ? Sp.XS : Sp.M }) {
          ForEach(this.f.workspaces, (w: WorkspaceItem) => {
            ListItem() {
              // 宽窄之别只在这里：树本身（工作区分组、会话归属）两种宽度完全一样
              if (this.compact) {
                this.narrowGroup(w)
              } else {
                this.workspaceGroup(w)
              }
            }
          }, (w: WorkspaceItem) => w.path)
        }
        .width('100%')
        .layoutWeight(1)
        .scrollBar(BarState.Off)
      }
    }
    .width('100%')
    .height('100%')
    .padding(Sp.M)
  }

  @Builder
  workspaceGroup(w: WorkspaceItem) {
    Column({ space: Sp.XS }) {
      Row({ space: Sp.S }) {
        SymbolGlyph($r('sys.symbol.folder')).fontSize(HarmonyIconSize.STATUS)
          .fontColor([w.primary ? $r('sys.color.brand') : $r('sys.color.font_secondary')])
        Column({ space: 2 }) {
          Text(w.name.length > 0 ? w.name : w.path)
            .fontSize(Fs.BODY)
            .fontWeight(FontWeight.Medium)
            .width('100%')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(`${w.path} · ${w.sessionCount} 会话`)
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_tertiary'))
            .width('100%')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .layoutWeight(1)
        // E163：**在该工作区里建会话**（反馈①：入口挂在工作区上，用户看得见"给谁加"）
        Text('+ 会话')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.brand'))
          .onClick(() => {
            this.f.createSessionIn(w);
          })
        Text($r('app.string.action_files'))
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.brand'))
          .onClick(() => {
            this.f.openWorkspaceFiles(w);
          })
        /*
         * E132：删除工作区（只删**注册**，不删目录）。
         *
         * 【为什么要两步确认】它虽然不动磁盘文件，但会让"这个目录在这里出现过、以及它下面
         * 那些会话的归属"消失——一次误触的代价不小，而 ArkUI 的 Row 里塞不下一个说得清楚的
         * 确认弹窗。所以同一位置先变成「确认删除 / 取消」，用户看清了再按。
         * 【为什么有时不显示】删除需要**注册表 id**；列表里的工作区是由会话 cwd 归并出来的，
         * 只有注册表里登记过的才有 id。没有 id 就**不显示**这个入口（而不是给一个点了没反应的）。
         */
        if (this.f.registryIdOf(w).length > 0) {
          Text(this.f.confirmingDeletePath === w.path
            ? $r('app.string.action_delete_confirm')
            : $r('app.string.action_delete'))
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.alert'))
            .onClick(() => {
              this.f.toggleDeleteConfirm(w);
            })
        }
      }
      .width('100%')

      ForEach(this.f.sessionsOf(w), (s: SessionListItem) => {
        this.sessionRow(s)
      }, (s: SessionListItem) => s.id)
    }
    .width('100%')
    .padding(Sp.M)
    .borderRadius(Radius.M)
    .backgroundColor($r('sys.color.background_secondary'))
  }

  /* ───────────────── 窄版（挂进侧栏时用） ─────────────────
   *
   * 【为什么必须有窄版】侧栏 PANEL 轨道只有 `Sz.NAV_PANEL`（240vp）。宽版把 `+ 会话` / `文件` /
   * `删除` 三个**文字**入口与「路径 · 会话数」挤在名字右侧 ⇒ 240vp 下名字只剩几个字。
   * 窄版的做法是**改行不改树**：
   *   · 第 1 行：图标 + 名字（拿满宽度）+ 会话数；
   *   · 第 2 行：三个动作，各自给足触控高度；
   *   · 会话行与宽版**共用** `sessionRow`（240vp 本来就放得下）。
   *   · 删掉「路径 · 会话数」副标题行里的路径（240vp 下路径会被截成无意义的片段；
   *     路径本身在"浏览文件"视图里完整可见）。
   *
   * 【为什么动作不藏进 `⋯` 菜单】官方 Web 侧栏是"悬停才显出图标按钮"，但那需要一个**能验证**的
   * 悬停/菜单态；本仓当前做不了真机验收（D3 签名阻塞）。而「新建会话 / 浏览文件 / 删除登记」在窄版里
   * 只有这一个入口——菜单一旦在真机上打不开，功能就不可达。宁可先用两行把它们摆在明处，
   * 等能真机验收再谈收进菜单（**不预留"以后会收"的空壳**）。
   */

  /**
   * 会话行（宽版与窄版**共用同一份**：240vp 下这一行本来就放得下——
   * 名字 + 运行中 + 归档，不需要为窄版再写一遍）。
   */
  @Builder
  sessionRow(s: SessionListItem) {
        Column({ space: 2 }) {
          Row({ space: Sp.S }) {
            Text(s.title.length > 0 ? s.title : $r('app.string.label_unnamed_session'))
              .fontSize(Fs.SECONDARY)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .layoutWeight(1)
            if (s.running) {
              Text($r('app.string.status_running'))
                .fontSize(Fs.CAPTION)
                .fontColor($r('sys.color.brand'))
            }
            /*
             * E134：归档会话（官方语义是"注册表全局归档集"）。
             * 【为什么没有"取消归档"】线协议里只有 `workspace/archiveSession`，
             * **没有反向端点**——所以这里只提供归档，不造一个点不动的"恢复"。
             */
            Text($r('app.string.action_archive'))
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.font_tertiary'))
              .onClick(() => {
                this.f.archiveSession(s.id);
              })
          }
          .width('100%')
          Text(s.blank ? $r('app.string.status_not_started')
            : `${relativeTime(s.updatedAt, Date.now())} · ${formatClock(s.updatedAt)}`)
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_tertiary'))
            .width('100%')
            .maxLines(1)
        }
        .width('100%')
        .padding({ left: Sp.L, right: Sp.M, top: Sp.S, bottom: Sp.S })
        .borderRadius(Radius.S)
        .backgroundColor(this.f.selectedSessionId === s.id
          ? $r('sys.color.background_secondary')
          : $r('sys.color.background_primary'))
        .onClick(() => {
          this.f.openSession(s.id);
        })
  }

  @Builder
  narrowGroup(w: WorkspaceItem) {
    Column({ space: Sp.XS }) {
      Row({ space: Sp.S }) {
        SymbolGlyph($r('sys.symbol.folder')).fontSize(HarmonyIconSize.STATUS)
          .fontColor([w.primary ? $r('sys.color.brand') : $r('sys.color.font_secondary')])
        Text(w.name.length > 0 ? w.name : w.path)
          .fontSize(Fs.BODY)
          .fontWeight(FontWeight.Medium)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        Text(`${w.sessionCount} 会话`)
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
      }
      .width('100%')

      Row({ space: Sp.M }) {
        Text('+ 会话')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.brand'))
          .height(Sz.TOUCH_MIN)
          .onClick(() => {
            this.f.createSessionIn(w);
          })
        Text($r('app.string.action_files'))
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.brand'))
          .height(Sz.TOUCH_MIN)
          .onClick(() => {
            this.f.openWorkspaceFiles(w);
          })
        /*
         * E132：删除工作区（只删**注册**，不删目录）+ 两步确认。
         * 判定与提示文案归宿主（`toggleDeleteConfirm`）——宽窄两版共用同一处，避免写两遍。
         */
        if (this.f.registryIdOf(w).length > 0) {
          Text(this.f.confirmingDeletePath === w.path
            ? $r('app.string.action_delete_confirm')
            : $r('app.string.action_delete'))
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.alert'))
            .height(Sz.TOUCH_MIN)
            .onClick(() => {
              this.f.toggleDeleteConfirm(w);
            })
        }
      }
      .width('100%')

      ForEach(this.f.sessionsOf(w), (s: SessionListItem) => {
        this.sessionRow(s)
      }, (s: SessionListItem) => s.id)
    }
    .width('100%')
    .padding(Sp.M)
    .borderRadius(Radius.M)
    .backgroundColor($r('sys.color.background_secondary'))
  }


  build() {
    this.workspaceHub(this.compact)
  }
}
