/**
 * 标签页内容（工作区 / 设置 / 核心）—— P0：主区内容搬迁的**第一束**。
 *
 * 本束 = `@Builder tabContent` + 它调用的 `@Builder workspaceHub` / `workspaceGroup`（277 行）。
 *
 * ## 门面为什么带 setter（本轮实测出来的）
 *
 * 搬走的代码**会写宿主状态**（共 17 个：attachNotice, connectAddress, connectAdvice, connectBusy, connectOk …）。
 * 若门面里它们只是普通属性，赋值会写进**门面副本**、宿主收不到 ——
 * **这不是编译错误，而是静默行为错误**（界面看着正常、状态没变）。
 * 故被写成员在门面里成对出现：只读属性 + `setX(v)`，搬走代码里的赋值已改写成 setter 调用（33 处）。
 *
 * 其余成员：只读值给快照、方法给闭包；门面由宿主**每次渲染重建**（缓存它等于放弃"中枢变了界面跟着变"）。
 *
 * 【为什么用门面】把父组件的 `@Builder` 注入子组件再调用会在真机 JS 崩溃（本仓 E118 实测）
 * ⇒ 内容只能靠数据/回调传。本束里唯一被调用的别的 builder 是 `hubBanner`，
 * 而它**已经是组件 `HubBanner`**，故这里直接渲染组件。
 */

import { ActionNotice, CommandCandidate, DiagEntry, DiagMode, DiagReport, Fs, HostRecord, HubPhase, MAIN_CONNECT, MAIN_CONVERSATION, ModelOption, ModelSelection, PanelRegistry, PendingAttachment, PendingItem, Radius, ReferenceCandidate, SessionHub, SessionJob, Sp, StackPage, TrajectoryItem, diagHintOf, diagTitleOf, filterDiagEntries, openSettings } from 'appstate';
import hilog from '@ohos.hilog';
import { CommandList } from '../CommandList';
import { ConnectPane } from '../ConnectPane';
import { ConversationPane } from '../ConversationPane';
import { DiagnosticsPane } from '../DiagnosticsPane';
import { GoalBar } from '../GoalBar';
import { SessionModelPicker } from '../SessionModelPicker';
import { copyText } from 'platform';
import type { HubSnapshot, InputModality, NavigationState, SessionStatsInput } from 'appstate';
import { TabContentView } from '../TabContentView';
import { extractToken } from 'connection';
import type { TabContentFacade } from '../TabContentView';

export interface MainShellFacade {
  TAG: string;
  DOMAIN: number;
  composeHostUrl: (address: string, token: string) => string;
  storageBaseUrl: (url: string) => string;
  reportConnectedHost: (baseUrl: string, token: string) => void;
  activePanel: () => string;
  answerPending: (item: PendingItem, selected: string[], custom: string) => void;
  attachNotice: string;
  setAttachNotice: (value: string) => void;
  attachments: PendingAttachment[];
  commands: CommandCandidate[];
  connectAddress: string;
  setConnectAddress: (value: string) => void;
  connectAdvice: string;
  setConnectAdvice: (value: string) => void;
  connectBusy: boolean;
  setConnectBusy: (value: boolean) => void;
  connectOk: boolean;
  setConnectOk: (value: boolean) => void;
  connectResult: string;
  setConnectResult: (value: string) => void;
  connectToken: string;
  setConnectToken: (value: string) => void;
  decidePending: (item: PendingItem, choiceId: string, reason: string) => void;
  detailOverlayOpen: boolean;
  setDetailOverlayOpen: (value: boolean) => void;
  diag: DiagReport;
  diagMode: () => DiagMode;
  diagRunning: boolean;
  draft: string;
  setDraft: (value: string) => void;
  exportDiagnostics: () => void;
  hosts: HostRecord[];
  hubAuthority: string;
  hubConnected: boolean;
  hubError: string;
  hubPhase: HubPhase;
  hubStreams: number;
  hubTraceTail: () => string[];
  modality: InputModality;
  modalityEntry: () => DiagEntry;
  models: ModelOption[];
  /** 后台任务（官方会话头的任务条）；判定全在 `appstate/model/Jobs`，视图只画 */
  jobs: SessionJob[];
  nav: NavigationState;
  setNav: (value: NavigationState) => void;
  noticeText: (n: ActionNotice) => string;
  offline: boolean;
  openDiagnostics: () => void;
  openPoc: () => void;
  paletteOpen: boolean;
  setPaletteOpen: (value: boolean) => void;
  panelRegistry: PanelRegistry;
  pending: PendingItem[];
  permissionCurrent: string;
  pickAndAttach: () => Promise<void>;
  planActive: boolean;
  planPending: boolean;
  queuedCount: number;
  quoteIntoDraft: (item: TrajectoryItem) => void;
  references: ReferenceCandidate[];
  resendMessage: (item: TrajectoryItem) => void;
  runDiagnostics: () => Promise<void>;
  running: boolean;
  setRunning: (value: boolean) => void;
  searchOpen: boolean;
  setSearchOpen: (value: boolean) => void;
  selectedSessionId: string;
  /** 会话头上下文行的工作区名（从选中会话的 cwd 派生；空 = 不知道，不显示） */
  sessionWorkspaceName: string;
  /** 选中会话的最近活动时间（毫秒；0 = 不知道 ⇒ 不显示「多久没动」） */
  sessionUpdatedAt: number;
  selection: ModelSelection;
  sendDraft: () => void;
  sessionStats: SessionStatsInput;
  settingWriteNote: string;
  /** 这条设置写入回执属于哪个分区（E347；空串 = 判不出来） */
  settingWriteDomain: string;
  setSettingWriteNote: (value: string) => void;
  stackPage: StackPage;
  setStackPage: (value: StackPage) => void;
  statsLine: string;
  /**
   * 主区**剩下三类面板**（工作区 / 设置 / 核心）的门面——交给 `TabContentView` 渲染。
   *
   * 本组件自己分派「诊断 / 连接 / 会话」，其余落进兜底分支由这一束接管（见 `mainContent` 的 else，E343）。
   * 曾经它是**零消费者**（本组件根本没用过，只有宿主在造）；E343 修完后它才真正被用上。
   */
  tabFacade: TabContentFacade;
  togglePlan: () => void;
  traceEnabled: boolean;
  setTraceEnabled: (value: boolean) => void;
  traceLines: string[];
  setTraceLines: (value: string[]) => void;
  trajectoryItems: TrajectoryItem[];
}

@Component
export struct MainShell {
  @Prop f: MainShellFacade;
  /** 是否紧凑（单栏/双栏下少留白）——由宿主给，组件不自己判定形态 */
  @Prop compact: boolean = false;

  @Builder
  mainContent(compact: boolean) {
    // E190：命令面板（列表来自宿主：CommandCandidate 的 name/args/detail；选中即执行）
    if (this.f.paletteOpen) {
      Column({ space: Sp.XS }) {
        Row({ space: Sp.S }) {
          Text('命令面板')
            .fontSize(Fs.BODY)
            .fontWeight(FontWeight.Medium)
            .layoutWeight(1)
          Text('关闭')
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.brand'))
            .onClick(() => {
              this.f.setPaletteOpen(false);
            })
        }
        .width('100%')
        // 长期目标栏归 GoalBar 所有（官方 ui-goal 的目标栏形态）；它自足读中枢快照，无需 props。
        GoalBar()
        /*
         * E195（§13 第 3 项）：**本会话的模型**。
         *
         * 官方把它做成会话输入区的选择器（`dsh-client-ui-model-selection`，写 `session/selectModel`）。
         * 这里放在同一个面板里而不是再造入口：面板本就是"会话操作"的地方、快捷键已绑定
         * ⇒ **可发现、不新增状态**。选中即调 `hub.selectSessionModel`（E194）；
         * 未选会话时如实说明（那条端点也要会话）。
         */
        // 本会话模型选择归 SessionModelPicker 所有（官方 ui-model-selection）；
        // 组件只管呈现，选中后的副作用（关面板 / 调中枢 / 写提示）留在宿主。
        SessionModelPicker({
          sessionId: this.f.selectedSessionId,
          models: this.f.models,
          currentModelId: this.f.selection.modelId,
          onPick: (m: ModelOption) => {
            this.f.setPaletteOpen(false);
            SessionHub.shared().selectSessionModel(m.provider, m.modelId, m.defaultEffort)
              .then((n: ActionNotice) => {
                this.f.setSettingWriteNote(this.f.noticeText(n));
              }).catch((e: Object) => {
                this.f.setSettingWriteNote('切换会话模型失败：' + (e as Error).message);
              });
          }
        })
        // 命令列表归 CommandList 所有（官方 ui-commands）；执行副作用留在宿主。
        CommandList({
          sessionId: this.f.selectedSessionId,
          commands: this.f.commands,
          onRun: (c: CommandCandidate) => {
            this.f.setPaletteOpen(false);
            SessionHub.shared().executeCommand(c.name).then((n: ActionNotice) => {
              this.f.setSettingWriteNote(this.f.noticeText(n));
            }).catch((e: Object) => {
              this.f.setSettingWriteNote('命令执行失败：' + (e as Error).message);
            });
          }
        })
      }
      .width('100%')
      .padding(Sp.M)
      .borderRadius(Radius.M)
      .backgroundColor($r('sys.color.background_primary'))
    }
    if (this.f.stackPage === StackPage.DIAGNOSTICS) {
      DiagnosticsPane({
        report: this.f.diag,
        running: this.f.diagRunning,
        // 判定项按模式裁剪（D7 §3 第 4 项）：本地核心模式下 TLS / 认证不适用
        entries: filterDiagEntries(this.f.diagMode(), this.f.diag.entries).concat([this.f.modalityEntry()]),
        modeTitle: diagTitleOf(this.f.diagMode()),
        modeHint: diagHintOf(this.f.diagMode()),
        traceEnabled: this.f.traceEnabled,
        traceLines: this.f.traceLines,
        onRerun: () => {
          this.f.runDiagnostics();
        },
        onToggleTrace: (on: boolean) => {
          this.f.setTraceEnabled(on);
          // 打开时显示**中枢的真实旁路日志**，而不是演示行。
          // 演示行只在未连接时作为布局示例出现（见 `applyHubSnapshot`）。
          this.f.setTraceLines(on
            ? SessionHub.shared().snapshot().trace
            : []);
        },
        onExportLog: () => {
          this.f.exportDiagnostics();
        },
        onClearCache: () => {
          // E130：此前是空实现（点了没反应）。清理的是**我们自己缓存的东西**：
          // 旁路日志 / 未识别事件清单 / 缓存的会话与轨迹。
          // **不碰 Host 上的任何数据**——诊断页不该有"顺手删远端东西"的按钮。
          SessionHub.shared().clearLocalCache();
          hilog.info(this.f.DOMAIN, this.f.TAG, 'DSHM-DIAG 已清理本机缓存');
        },
        onOpenPoc: () => {
          this.f.openPoc();
        },
        onBack: () => {
          this.f.setStackPage(StackPage.MAIN);
        }
      })
    } else if (this.f.activePanel() === MAIN_CONNECT) {
      ConnectPane({
        hosts: this.f.hosts,
        address: this.f.connectAddress,
        token: this.f.connectToken,
        busy: this.f.connectBusy,
        resultText: this.f.connectResult,
        resultOk: this.f.connectOk,
        resultAdvice: this.f.connectAdvice,
        discoveryAvailable: false,
        onAddressChange: (v: string) => {
          this.f.setConnectAddress(v);
        },
        onTokenChange: (v: string) => {
          this.f.setConnectToken(v);
        },
        onSubmit: () => {
          this.f.setConnectBusy(true);
          this.f.setConnectResult('');
          this.f.setConnectAdvice('');
          const hub: SessionHub = SessionHub.shared();
          const url: string = this.f.composeHostUrl(this.f.connectAddress, this.f.connectToken);
          if (!hub.configure(url, undefined)) {
            this.f.setConnectOk(false);
            this.f.setConnectBusy(false);
            this.f.setConnectResult('地址无法解析');
            this.f.setConnectAdvice('请填形如 http://主机:端口 的地址；token 可单独填，也可直接粘贴完整启动链接（含 ?token=…）。');
            return;
          }
          hub.connect().then((ok: boolean) => {
            this.f.setConnectBusy(false);
            this.f.setConnectOk(ok);
            const snap: HubSnapshot = hub.snapshot();
            this.f.setConnectResult(ok
              ? `已连接 ${snap.authority}，收到 ${snap.sessions.length} 个会话`
              : (snap.lastError.length > 0 ? snap.lastError : '连接未建立'));
            this.f.setConnectAdvice(ok
              ? '真实数据已接管会话列表与待决；可在「连接诊断」页查看五项判定。'
              : '请确认 Host 已启动且令牌有效；模拟器/真机访问宿主回环需先做端口转发（hdc fport）。');
            if (ok) {
              // 只报告**成功的**连接：失败的地址/token 不该被记住，
              // 否则下次启动会拿一个已知无效的 token 去自动重连，用户看到的是
              // 「自动重连失败」——而正确行为是回到「添加 Host」。
              //
              // token 来自**解析后的 URL**，而不是 token 输入框：
              // 用户用的是「① 粘贴启动 URL」这条路径，token 输入框是空的。
              // 曾因此把空串当 token 存进去，表现为「保存失败 + 下次读不到 token」。
              this.f.reportConnectedHost(this.f.storageBaseUrl(url), extractToken(url) ?? this.f.connectToken.trim());
            }
          });
        },
        /*
         * 【局域网发现：本形态**未接线**，且子组件按钮已置灰】
         *
         * `discoveryAvailable: false`（上一行）⇒ `ConnectPane` 的按钮显示为
         * 「发现不可用」并 `.enabled(false)`（见 ConnectPane.ets:
         * `Button(this.discoveryAvailable ? '开始发现' : '发现不可用')`），
         * 所以这个空实现**点不到**，不是"点了没反应"的死按钮。
         *
         * 【为什么要显式写注释而不是留裸 `() => {}`】它是 `ConnectPane` 的**必填回调 prop**，
         * 不传编译不过。留裸空体会被人当成"漏接线"（死按钮扫描门禁也会报它）；
         * 写明理由后，读者能立刻分清"有意不接线"与"忘了接线"。
         *
         * 【将来要接线时做什么】Host 侧需运行 `hostkit` 搭桥服务做 mDNS 广播；
         * 拿到候选后走 `hub.configure(url, token)` + `hub.connect()`
         * （与上面 `onSubmit` 同一条路径），并把 `discoveryAvailable` 换成真实探测结果。
         */
        onStartDiscovery: () => {
          // 故意为空：发现能力未接线（按钮已置灰，见上）
        },
        onOpenDiagnostics: () => {
          this.f.openDiagnostics();
        },
        onBack: () => {
          this.f.setStackPage(StackPage.MAIN);
        }
      })
    } else if (this.f.activePanel() === MAIN_CONVERSATION) {
      // E125：会话统计行（官方措辞），贴在会话页头部——数据来自投影，没有就不占位置
      if (this.f.statsLine.length > 0) {
        Text(this.f.statsLine)
          .fontSize(Fs.CAPTION)
          .fontColor(('sys.color.font_tertiary'))
          .width('100%')
          .padding({ left: Sp.M, right: Sp.M, top: Sp.XS })
      }
      ConversationPane({
        itemCount: this.f.trajectoryItems.length,
        // E115：审批/提问直接弹在会话里（官方 web 的形态），一次点击即可放行
        pending: this.f.pending,
        onDecidePending: (item: PendingItem, choiceId: string, reason: string) => {
          this.f.decidePending(item, choiceId, reason);
        },
        onAnswerPending: (item: PendingItem, selected: string[], custom: string) => {
          this.f.answerPending(item, selected, custom);
        },
        sessionId: this.f.selectedSessionId,
        workspaceName: this.f.sessionWorkspaceName,
        sessionUpdatedAt: this.f.sessionUpdatedAt,
        jobs: this.f.jobs,
        items: this.f.trajectoryItems,
        running: this.f.running,
        offline: this.f.offline,
        queuedCount: this.f.queuedCount,
        draft: this.f.draft,
        attachments: this.f.attachments,
        models: this.f.models,
        selection: this.f.selection,
        references: this.f.references,
        commands: this.f.commands,
        notice: this.f.attachNotice,
        planActive: this.f.planActive,
        planPending: this.f.planPending,
        permissionLabel: this.f.permissionCurrent,
        onDraftChange: (text: string) => {
          this.f.setDraft(text);
        },
        onSend: () => {
          this.f.sendDraft();
        },
        onStop: () => {
          // 连上后停止 = 真的取消当前轮次；未连接时只熄灭本地指示
          if (this.f.hubConnected) {
            SessionHub.shared().cancelTurn();
          }
          this.f.setRunning(false);
        },
        onAddAttachment: () => {
          this.f.pickAndAttach();
        },
        onRemoveAttachment: (receiptId: string) => {
          SessionHub.shared().removeAttachment(receiptId);
        },
        onPickModel: () => {
          this.f.setNav(openSettings(this.f.nav, '', this.f.panelRegistry));
        },
        onTogglePlan: () => {
          this.f.togglePlan();
        },
        // 输入模态：有指针才启用右键菜单与悬停（策略模型决定，见 appstate/model/InputPolicy）。
        // 两个事实**分开传**：合成来源见本文件 `recomputeModality()`。
        hasPointer: this.f.modality.hasPointer,
        hasKeyboard: this.f.modality.hasKeyboard,
        // 轨迹的时间总览要用的统计（数字，不是拼好的字符串）
        stats: this.f.sessionStats,
        onQuoteMessage: (item: TrajectoryItem) => {
          this.f.quoteIntoDraft(item);
        },
        onResendMessage: (item: TrajectoryItem) => {
          this.f.resendMessage(item);
        },
        // 消息操作条的「复制」：剪贴板是平台能力，回调由宿主提供（视图层不依赖 platform）
        onCopyMessage: (text: string) => {
          if (text.length === 0) {
            this.f.setAttachNotice('这条消息没有可复制的正文。');
            return;
          }
          copyText(text).then((ok: boolean) => {
            this.f.setAttachNotice(ok ? '已复制到剪贴板。' : '复制失败：剪贴板不可用。');
          });
        },
        onReferenceQuery: (query: string) => {
          if (this.f.hubConnected) {
            SessionHub.shared().refreshReferences(query);
          }
        },
        onPullQueued: (itemId: string, text: string) => {
          // 「取回编辑」= 移除该队列项 + 把正文放回草稿。
          // 移除走 Host（否则用户会在界面上看不到它、而它仍会被发送），
          // 放回草稿是本地动作。**先放回再移除**：即使移除失败，
          // 用户也已经拿回了文本，不会丢内容。
          this.f.setDraft(text);
          SessionHub.shared().removeQueuedItem(itemId).then((ok: boolean) => {
            if (!ok) {
              this.f.setAttachNotice('已把内容取回输入框，但队列项移除失败——它仍可能被 Host 发送，请检查诊断页。');
            }
          });
        },
        onRemoveQueued: (itemId: string) => {
          SessionHub.shared().removeQueuedItem(itemId);
        },
        onSteerQueued: (itemId: string) => {
          SessionHub.shared().steerQueuedItem(itemId);
        },
        onOpenDetail: () => {
          this.f.setDetailOverlayOpen(true);
        },
        searchOpen: this.f.searchOpen,
        onCloseSearch: () => {
          this.f.setSearchOpen(false);
        }
      })
    } else {
      /*
       * 兜底分支：**不许再调 `mainContent`**（E343）。
       *
       * 这里曾经是 `this.mainContent(this.compact)`，真机上点一下就 `RangeError: Stack overflow!`
       * 直接杀进程——栈里成对出现 `MainShell.ets:405`（这句）与 `:404`（`else` 本身），
       * 即"兜底又把自己叫了一遍"，而 `mainContent` 每次都会重新走到这条 `else`。
       *
       * 【为什么会走到 else】主区还剩工作区 / 核心 / 设置三类面板，它们过去由**主区的第二束**
       * （`TabContentView`）直接渲染，搬迁后本组件忘了把这一束接上。
       * 静态阅读时它看着像"交回给上面继续分派"，实际是**自递归**。
       *
       * 【正确形态】兜底 = 把剩下的面板交给**真正拥有它们的那一束**，而不是回头再问自己：
       * 这里直接渲染 `TabContentView`（工作区 / 设置 / 核心的既有分派点，自带兜底、不再外调）。
       * 门禁 `tools/check-builder-recursion.mjs` 守着这条规矩：`@Builder` 体内不许出现自己的名字。
       */
      TabContentView({ f: this.f.tabFacade, compact: this.compact })
    }
  }

  build() {
    this.mainContent(this.compact)
  }
}
