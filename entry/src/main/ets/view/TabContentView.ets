/**
 * 标签页内容（工作区 / 设置 / 核心）—— P0：主区内容搬迁的**第一束**。
 *
 * 本束 = `@Builder tabContent`（三形态下的主区分派）。
 *
 * 【P1 之后】原先它体内还带着「工作区→会话」那棵树（`workspaceHub` / `workspaceGroup`，285 行）——
 * 那是 **Sidebar 的信息架构**（官方 `dsh-client-ui-workspace`），不该长在主区里。现已抽成
 * `view/WorkspaceBrowser.ets`（同一份树，可挂主区页签、也可挂侧栏），本组件只负责"什么时候显示它"。
 *
 * ## 门面为什么带 setter（本轮实测出来的）
 *
 * 搬走的代码**会写宿主状态**（共 13 个：archiveOpen, choosing, choosingCurrent, choosingKey, choosingLabel …）。
 * 若门面里它们只是普通属性，赋值会写进**门面副本**、宿主收不到 ——
 * **这不是编译错误，而是静默行为错误**（界面看着正常、状态没变）。
 * 故被写成员在门面里成对出现：只读属性 + `setX(v)`，搬走代码里的赋值已改写成 setter 调用（29 处）。
 *
 * 其余成员：只读值给快照、方法给闭包；门面由宿主**每次渲染重建**（缓存它等于放弃"中枢变了界面跟着变"）。
 *
 * 【为什么用门面】把父组件的 `@Builder` 注入子组件再调用会在真机 JS 崩溃（本仓 E118 实测）
 * ⇒ 内容只能靠数据/回调传。本束里唯一被调用的别的 builder 是 `hubBanner`，
 * 而它**已经是组件 `HubBanner`**，故这里直接渲染组件。
 */

import { ActionNotice, AgentPresetRow, CoreViewState, CredentialItem, FileNode, FilePreview, Fs, HostRecord, HubPhase, LayoutMode, ModelOption, ModelSelection, NavTab, PendingItem, PluginItem, SessionHub, SessionListItem, SettingGroup, SkillRow, Sp, StackPage, WorkspaceItem, aboutInfo, projectGeneralGroups } from 'appstate';
import type { PanelDescriptor, PiAiProviderView, SettingChoice, SettingItem } from 'appstate';
import { PiAiSheetMode } from './PiAiProviderSheet';
import { LocalPrefs } from 'platform';
import { HubBanner } from './HubBanner';
import { SettingsPane } from './SettingsPane';
import { WorkspacePane } from './WorkspacePane';
import { WorkspaceBrowser } from './WorkspaceBrowser';
import type { WorkspaceBrowserFacade } from './WorkspaceBrowser';

export interface TabContentFacade {
  answerPending: (item: PendingItem, selected: string[], custom: string) => void;
  applyDefaultModel: (provider: string, model: string, effort: string) => void;
  archiveOpen: boolean;
  setArchiveOpen: (value: boolean) => void;
  archivedSessionIds: string[];
  archivedSessions: () => SessionListItem[];
  attachWorkspaceFileToComposer: (node: FileNode) => Promise<void>;
  /** 工作区浏览器（P1：可挂主区页签，也可挂侧栏） */
  browser: WorkspaceBrowserFacade;
  /** 工作区树是否已经由侧栏承载（三栏档位）：主区就不该再重复一份 */
  browserInSidebar: boolean;
  /** 设置域当前分区（`NavigationState.settingsSection`） */
  settingsSection: string;
  /** 设置域的可用分区清单（注册表给；顺序即呈现顺序） */
  settingsSections: PanelDescriptor[];
  /** 切设置分区（宿主经注册表校验后写进 `settingsSection`） */
  onSelectSettingsSection: (sectionId: string) => void;
  choosing: SettingChoice[] | undefined;
  setChoosing: (value: SettingChoice[] | undefined) => void;
  choosingCurrent: string;
  setChoosingCurrent: (value: string) => void;
  choosingKey: string;
  setChoosingKey: (value: string) => void;
  choosingLabel: string;
  setChoosingLabel: (value: string) => void;
  confirmingDeletePath: string;
  connectBusy: boolean;
  connectSettled: boolean;
  coreNotice: string;
  coreView: CoreViewState;
  createSessionIn: (w: WorkspaceItem) => void;
  credentials: CredentialItem[];
  currentTab: () => NavTab;
  decidePending: (item: PendingItem, choiceId: string, reason: string) => void;
  deleteWorkspaceByPath: (w: WorkspaceItem) => void;
  fileTree: FileNode[];
  forgetHost: () => void;
  hosts: HostRecord[];
  hubAuthority: string;
  hubConnected: boolean;
  hubError: string;
  hubPhase: HubPhase;
  hubStreams: number;
  hubTraceTail: () => string[];
  localItemOf: (key: string) => SettingItem | undefined;
  localized: (id: Resource) => string;
  mode: LayoutMode;
  models: ModelOption[];
  noticeText: (n: ActionNotice) => string;
  onCoreAction: (id: string) => void;
  onCoreSelectVersion: (version: string) => void;
  onResetPluginRows: () => void;
  onTogglePlugin: (id: string, disabled: boolean) => void;
  openCredentialSheet: (ref: string) => void;
  openDiagnostics: () => void;
  openFile: (node: FileNode) => void;
  openFolderPicker: () => void;
  openSession: (id: string) => void;
  openStructSettingSheet: (item: SettingItem) => void;
  openTextSettingSheet: (item: SettingItem) => void;
  /** 打开 pi-ai 路由浮层（按模式：编辑已有 / 新建自定义模型 API） */
  openPiAiSheet: (mode: string, route: string) => void;
  /** pi-ai 路由（逐字段视图） */
  piAiProviders: PiAiProviderView[];
  openWorkspaceFiles: (w: WorkspaceItem) => void;
  pending: PendingItem[];
  pendingWorkspacePick: boolean;
  setPendingWorkspacePick: (value: boolean) => void;
  permissionCurrent: string;
  permissionOptions: string[];
  plugins: PluginItem[];
  presetNote: string;
  presets: AgentPresetRow[];
  preview: FilePreview | undefined;
  registryIdOf: (w: WorkspaceItem) => string;
  resetSetting: (key: string) => void;
  selectedSessionId: string;
  selection: ModelSelection;
  sessionForWorkspace: (workspaceId: string) => string;
  sessionsOf: (w: WorkspaceItem) => SessionListItem[];
  settingItemOf: (key: string) => SettingItem | undefined;
  settingWriteNote: string;
  settingWriteDomain: string;
  setSettingWriteNote: (value: string) => void;
  settings: SettingGroup[];
  skillNote: string;
  skills: SkillRow[];
  stackPage: StackPage;
  setStackPage: (value: StackPage) => void;
  toggleDirectory: (path: string) => void;
  treeEmptyHint: string;
  setTreeEmptyHint: (value: string) => void;
  treeEmptyTitle: string;
  setTreeEmptyTitle: (value: string) => void;
  workspaces: WorkspaceItem[];
  writeSetting: (key: string, value: Object, label: string) => Promise<void>;
  wsDrill: number;
  setWsDrill: (value: number) => void;
}

@Component
export struct TabContentView {
  @Prop f: TabContentFacade;
  /** 是否紧凑（单栏/双栏下少留白）——由宿主给，组件不自己判定形态 */
  @Prop compact: boolean = false;

  @Builder
  tabContent(compact: boolean) {
    /*
     * E108：工作区视图（合并了原来的「会话」与「待决」两个页签）。
     * 官方 web 的侧栏就是"工作区为组、会话挂在组下"；待决属于**当前这次对话**，显示在列表顶部。
     * 文件浏览仍是工作区里的下钻（`wsDrill > 0`，见下一个分支）。
     */
    if (this.f.currentTab() === NavTab.WORKSPACES && this.f.wsDrill === 0) {
      if (this.f.browserInSidebar) {
        /*
         * 三栏：树的座位在侧栏（官方 `ui-workspace` 就在 Sidebar 里），主区**不再重复一份**。
         * 【为什么不是空白】"这里什么都没有"和"列表搬到左边了"是两件事：前者看起来像坏了。
         * 文件浏览仍留在主区（工作区行点「浏览文件」即进入下钻分支），所以这句话不是安慰。
         */
        Column({ space: Sp.S }) {
          Text('会话列表在左侧「工作区」浏览器里')
            .fontSize(Fs.BODY)
            .fontColor($r('sys.color.font_secondary'))
          Text('在左侧点某个工作区的「浏览文件」可进入文件浏览；这个页面不再重复一份列表。')
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_tertiary'))
            .textAlign(TextAlign.Center)
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else {
        // 单栏 / 双栏：侧栏容不下树（底部标签 / 图标条），主区这一页签仍然是它的家
        WorkspaceBrowser({ f: this.f.browser, compact: false })
      }
    } else if (this.f.currentTab() === NavTab.WORKSPACES) {
      WorkspacePane({
        workspaces: this.f.workspaces,
        onPickFolder: () => {
          this.f.openFolderPicker();
        },
        tree: this.f.fileTree,
        selectedPath: this.f.preview === undefined ? '' : this.f.preview.path,
        preview: this.f.preview,
        compact: compact && this.f.mode === LayoutMode.SINGLE,
        drillLevel: this.f.wsDrill,
        treeEmptyTitle: this.f.treeEmptyTitle,
        treeEmptyHint: this.f.treeEmptyHint,
        onSelectWorkspace: (id: string) => {
          const scope: string = this.f.sessionForWorkspace(id);
          // 空态文案按「为什么空」分档（D3 §4：空态要说明可以做什么）
          this.f.setPendingWorkspacePick(true);
          if (scope.length === 0) {
            this.f.setTreeEmptyTitle('该工作区下还没有会话');
            this.f.setTreeEmptyHint('文件浏览的作用域是会话级（workspaceFileScopeId = 会话 id），请先在这个目录里新建一个会话。');
          } else {
            this.f.setTreeEmptyTitle('该目录暂无文件');
            this.f.setTreeEmptyHint('目录确实为空，或 Host 拒绝列出它的内容（详见连接诊断）。');
            if (this.f.hubConnected) {
              SessionHub.shared().openWorkspace(scope);
            }
          }
          if (this.f.mode === LayoutMode.SINGLE) {
            this.f.setWsDrill(1);
          }
        },
        onToggleDirectory: (path: string) => {
          this.f.toggleDirectory(path);
        },
        onOpenFile: (node: FileNode) => {
          this.f.openFile(node);
        },
        onAttachFile: (node: FileNode) => {
          this.f.attachWorkspaceFileToComposer(node);
        },
        onBack: () => {
          this.f.setWsDrill(this.f.wsDrill > 0 ? this.f.wsDrill - 1 : 0);
        }
      })
    } else {
      SettingsPane({
        // P4-1：分区与清单由注册表给（唯一真值在 NavigationState.settingsSection）
        section: this.f.settingsSection,
        sections: this.f.settingsSections,
        onSelectSection: (sectionId: string) => {
          this.f.onSelectSettingsSection(sectionId);
        },
        // E118：核心分区的内容直接由属性传入（不再用 @BuilderParam 注入父 Builder——
        // 真机上点开该分区会 JS 崩溃）
        coreView: this.f.coreView,
        permissionCurrent: this.f.permissionCurrent,
        permissionOptions: this.f.permissionOptions,
        coreNotice: this.f.coreNotice,
        onCoreAction: (id: string) => {
          this.f.onCoreAction(id);
        },
        onCoreSelectVersion: (version: string) => {
          this.f.onCoreSelectVersion(version);
        },
        onTogglePluginRow: (id: string, disabled: boolean) => {
          this.f.onTogglePlugin(id, disabled);
        },
        onResetPluginRowsAction: () => {
          this.f.onResetPluginRows();
        },
        // E114：官方「通用」分区承载的是**用户面向的功能包设置**（外观/语言/会话…），
        // 引擎参数不在其中。这里做同样的策展：白名单命名空间整组显示，
        // 其余命名空间里**用户改过**的项收进「其他已修改项」，既不占版面又撤得回。
        groups: projectGeneralGroups(this.f.settings),
        // E128：模型页要能编辑提供方的设置分区（baseURL / 模型目录），所以另传全量
        allGroups: this.f.settings,
        // pi-ai 路由（逐字段编辑 + 自定义模型 API 新建）：数据由中枢投影好，
        // 因为"设置项粒度"的 groups 看不出一张路由有几个字段（见 HubSnapshot.piAiProviders）
        piAiProviders: this.f.piAiProviders,
        onEditProvider: (route: string) => {
          this.f.openPiAiSheet(PiAiSheetMode.EDIT, route);
        },
        onAddProvider: () => {
          this.f.openPiAiSheet(PiAiSheetMode.CREATE, '');
        },
        // E135：技能清单（数据层已就绪；形状未识别时界面如实显示结论）
        skills: this.f.skills,
        skillNote: this.f.skillNote,
        // E161：预设名单（数据层已按真机实测契约接线）
        presets: this.f.presets,
        presetNote: this.f.presetNote,
        /*
         * E170：预设的**复制**（官方唯一创建入口）与**删除**（仅自定义项）。
         * 【为什么自动命名而不弹输入框】官方用复制对话框让我们填"标识 + 名称"；
         * 端侧先做**一步完成**的版本（`<id>-copy` / `<名称> 副本`）——它是一个完整可用的动作，
         * 而不是半成品表单；需要改名时再走查看/编辑那条线（`read` 已就绪）。
         */
        onPresetCopy: (from: string, name: string) => {
          const id: string = `${from}-copy`;
          SessionHub.shared().copyAgentPreset(from, id, `${name.length > 0 ? name : from} 副本`)
            .then((n: ActionNotice) => {
              this.f.setSettingWriteNote(this.f.noticeText(n));
            }).catch((e: Object) => {
              this.f.setSettingWriteNote(`复制预设失败：${(e as Error).message}`);
            });
        },
        onPresetDelete: (id: string) => {
          SessionHub.shared().deleteAgentPreset(id)
            .then((n: ActionNotice) => {
              this.f.setSettingWriteNote(this.f.noticeText(n));
            }).catch((e: Object) => {
              this.f.setSettingWriteNote(`删除预设失败：${(e as Error).message}`);
            });
        },
        credentials: this.f.credentials,
        plugins: this.f.plugins,
        hosts: this.f.hosts,
        models: this.f.models,
        selection: this.f.selection,
        about: aboutInfo(),
        writeNote: this.f.settingWriteNote,
        writeDomain: this.f.settingWriteDomain,
        onToggleSetting: (key: string, value: boolean) => {
          if (this.f.settingItemOf(key) === undefined) {
            // 本地偏好：本客户端自己的开关，没有上游写路径。
            // 如实说明它只在本机生效，而不是假装写成功了。
            this.f.setSettingWriteNote(`「${key}」是本机偏好，只在本次运行内生效（尚未做持久化）。`);
            return;
          }
          this.f.writeSetting(key, value as Object, key);
        },
        onPickChoice: (key: string, current: string) => {
          const item: SettingItem | undefined = this.f.settingItemOf(key);
          if (item === undefined) {
            // 本机偏好：没有上游写路径，但**有端侧持久化路径**（`platform/LocalPrefs`）。
            // 仍然复用同一个选中浮层（选项来源换成端侧那一组），提交时由 `applyChoice` 分流。
            const local: SettingItem | undefined = this.f.localItemOf(key);
            if (local === undefined) {
              this.f.setSettingWriteNote(`「${key}」既不属于 Host 设置、也不在本机偏好表里。`);
              return;
            }
            this.f.setChoosingKey(key);
            this.f.setChoosingLabel(local.label);
            this.f.setChoosingCurrent(current);
            this.f.setChoosing(local.choices);
            return;
          }
          if (item.choices.length === 0) {
            // 防御分支：列表里的 TEXT 项已直接走 `onEditText`，不会走到这里。
            this.f.openTextSettingSheet(item);
            return;
          }
          this.f.setChoosingKey(key);
          this.f.setChoosingLabel(item.label);
          this.f.setChoosingCurrent(current);
          this.f.setChoosing(item.choices);
        },
        onEditText: (item: SettingItem) => {
          this.f.openTextSettingSheet(item);
        },
        onEditStruct: (item: SettingItem) => {
          this.f.openStructSettingSheet(item);
        },
        onResetSetting: (key: string) => {
          this.f.resetSetting(key);
        },
        onSelectModel: (provider: string, model: string, effort: string) => {
          this.f.applyDefaultModel(provider, model, effort);
        },
        onAuthorizeCredential: (ref: string) => {
          this.f.openCredentialSheet(ref);
        },
        onPairHost: () => {
          this.f.setStackPage(StackPage.CONNECT);
        },
        onRevokeHost: (id: string) => {
          this.f.forgetHost();
        },
        onOpenDiagnostics: () => {
          this.f.openDiagnostics();
        }
      })
    }
  }

  build() {
    this.tabContent(this.compact)
  }
}
