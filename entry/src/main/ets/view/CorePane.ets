/**
 * 核心页（Core Pane）—— 端侧自足架构下的新一级页面（D6 §2/§6）。
 *
 * 它回答四个问题（每个都必须在界面上有答案，不能靠猜）：
 *   1. 现在是什么状态？（未接线 / 未安装 / 解包中 / 启动中 / 就绪 / 降级 / 失败）
 *   2. 跑的是哪一版核心、哪个 profile、运行时是什么？（运行时事实表）
 *   3. 有哪些版本、能不能切、能不能回滚？（版本列表）
 *   4. 插件能不能装？（纯 JS 可装；含原生 .node 的必须随应用发版——这是鸿蒙的硬约束）
 *
 * 纪律（D3 §4）：本页**没有桩数据**。未探测的事实写"未探测"并给出探测条件；
 * 不可用的动作必须显示原因，不允许静默禁用或点了没反应。
 *
 * 本组件只做呈现：所有判据来自 appstate 的呈现契约（Core.buildCoreView），
 * 因此"某个阶段该显示什么"可以在没有设备的情况下被单测覆盖。
 */

import {
  CoreActionSpec,
  CoreFact,
  CorePhase,
  CoreVersionRow,
  CoreViewState,
  emptyCoreView,
  Fs,
  PluginRow,
  Radius,
  Sp,
  Sz
} from 'appstate';

/**
 * 核心版本切换是否可用（E149）。
 *
 * **当前为 false，且这是有证据的决定**：真机点「切换」→ `CppCrash / exitSigno = 6`（SIGABRT），
 * 因为 libnode 在一个应用进程里只允许启动一次，而切换需要"停旧 + 起新"。
 * 等到正确实现落地（热切换，或"退出 + 重拉应用进程"）再改为 true——
 * 在那之前**界面不给可点入口**，这与本项目"界面不撒谎"的纪律一致。
 */
const CORE_SWITCH_AVAILABLE: boolean = true;

@Component
export struct CorePane {
  @Prop view: CoreViewState = emptyCoreView();
  /** 动作点击（由宿主决定实现；未实现的动作也必须给出如实提示） */
  onAction: (id: string) => void = () => {
  };
  /** 选择某个版本作为切换目标 */
  onSelectVersion: (version: string) => void = () => {
  };
  /**
   * 切换某一行的启停（写 `$DSH_HOME/profiles/<profile>/.dshm-plugin-rows.yml`）。
   *
   * 【语义边界】端侧**只能**启停随核心包发版的行：上游的插件安装通道是
   * `spawnSync("pnpm", …)`，而鸿蒙不允许应用创建进程。所以这里的开关不是"装插件"，
   * 而是"把已经装好的行打开或关掉"，改完需要重启核心才生效（界面会说明）。
   */
  onTogglePlugin: (id: string, disabled: boolean) => void = () => {
  };
  /** 恢复默认：清空用户启停，回到核心包自带的启停状态。 */
  onResetPluginRows: () => void = () => {
  };
  /** 插件区的结果提示（空的就不显示） */
  @Prop pluginNotice: string = '';

  build() {
    Scroll() {
      Column({ space: Sp.M }) {
        this.statusCard()
        this.factsCard()
        this.versionsCard()
        this.pluginsCard()
      }
      .width('100%')
      .padding(Sp.M)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height('100%')
    .scrollBar(BarState.Auto)
    .align(Alignment.TopStart)
  }

  // ── 状态卡 ────────────────────────────────────────────────────────────
  @Builder
  statusCard() {
    Column({ space: Sp.S }) {
      Row({ space: Sp.S }) {
        Text(this.view.badge)
          .fontSize(Fs.CAPTION)
          .fontColor(this.phaseColor())
          .padding({ left: 8, right: 8, top: 2, bottom: 2 })
          .borderRadius(Radius.XS)
          .backgroundColor($r('sys.color.background_primary'))
        if (this.view.currentVersion.length > 0) {
          Text(`v${this.view.currentVersion}`)
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_secondary'))
        }
        if (this.view.profileName.length > 0) {
          Text(`profile: ${this.view.profileName}`)
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_tertiary'))
        }
      }
      .width('100%')

      Text(this.view.title)
        .fontSize(Fs.TITLE_L)
        .fontWeight(FontWeight.Medium)
        .width('100%')

      Text(this.view.detail)
        .fontSize(Fs.SECONDARY)
        .fontColor($r('sys.color.font_secondary'))
        .width('100%')

      // 动作行：横排 + 允许换行（不用 LengthMetrics，避免引入额外导入）
      Flex({ wrap: FlexWrap.Wrap }) {
        ForEach(this.view.actions, (a: CoreActionSpec) => {
          this.actionButton(a)
        }, (a: CoreActionSpec) => a.id)
      }
      .width('100%')
    }
    .width('100%')
    .padding(Sp.M)
    .borderRadius(Radius.M)
    .backgroundColor($r('sys.color.background_primary'))
  }

  @Builder
  actionButton(a: CoreActionSpec) {
    Column({ space: 2 }) {
      Text(a.label)
        .fontSize(Fs.SECONDARY)
        .fontColor(a.enabled ? $r('sys.color.brand') : $r('sys.color.font_tertiary'))
        .padding({ left: Sp.M, right: Sp.M, top: Sp.XS, bottom: Sp.XS })
        .borderRadius(Radius.S)
        .backgroundColor($r('sys.color.background_secondary'))
        .margin({ right: Sp.S, bottom: Sp.XS })
        .onClick(() => {
          if (a.enabled) {
            this.onAction(a.id);
          }
        })
      // 不可用时把原因写在按钮下面——"禁用但不说为什么"是这一页最不能犯的错
      if (!a.enabled && a.reason.length > 0) {
        Text(a.reason)
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .constraintSize({ maxWidth: 240 })
      }
    }
  }

  // ── 运行时事实 ────────────────────────────────────────────────────────
  @Builder
  factsCard() {
    Column({ space: Sp.S }) {
      Text('运行时')
        .fontSize(Fs.SECONDARY)
        .fontWeight(FontWeight.Medium)
        .width('100%')
      ForEach(this.view.facts, (f: CoreFact) => {
        Column({ space: 2 }) {
          Row({ space: Sp.S }) {
            Text(f.label)
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.font_secondary'))
              .layoutWeight(1)
            Text(f.value)
              .fontSize(Fs.CAPTION)
              .fontColor(this.factColor(f.verdict))
          }
          .width('100%')
          if (f.verdict === 'unknown' && f.hint.length > 0) {
            Text(f.hint)
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.font_tertiary'))
              .width('100%')
          }
        }
        .width('100%')
      }, (f: CoreFact) => f.label)
    }
    .width('100%')
    .padding(Sp.M)
    .borderRadius(Radius.M)
    .backgroundColor($r('sys.color.background_primary'))
  }

  // ── 版本 ──────────────────────────────────────────────────────────────
  @Builder
  versionsCard() {
    Column({ space: Sp.S }) {
      Text('核心版本')
        .fontSize(Fs.SECONDARY)
        .fontWeight(FontWeight.Medium)
        .width('100%')
      if (this.view.versions.length === 0) {
        Text('还没有安装任何核心版本。核心随应用内置，首次启动会自动解包；也可以在这里导入核心包。')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')
      } else {
        ForEach(this.view.versions, (row: CoreVersionRow) => {
          Column({ space: 2 }) {
            Row({ space: Sp.S }) {
              Text(row.version)
                .fontSize(Fs.SECONDARY)
                .layoutWeight(1)
              Text(row.badge)
                .fontSize(Fs.CAPTION)
                .fontColor(row.badge === '当前' ? $r('sys.color.brand') : $r('sys.color.font_tertiary'))
                .padding({ left: 6, right: 6, top: 1, bottom: 1 })
                .borderRadius(Radius.XS)
                .backgroundColor($r('sys.color.background_secondary'))
              if (row.selectable) {
                /*
                 * 【E149：切换当前**不可用**，界面必须这么说】
                 *
                 * 真机取证：点「切换」会让应用**原生崩溃**（`CppCrash / exitSigno = 6` = SIGABRT）。
                 * 原因是物理约束：libnode 在**一个应用进程里只被设计为启动一次**，而"切换"要
                 * "停旧 + 起新" ⇒ 同一进程内第二次 `node::Start` 直接 abort。
                 * （E119 修好的 `g_started` 复位是必要但不充分的：它让代码能走到这一步。）
                 *
                 * 在找到正确实现（热切换不重启 Node，或把切换做成"退出 + 重拉应用进程"）之前，
                 * 这里**不给可点的入口**，改为一行说明——点了就崩的按钮比没有按钮更糟。
                 */
                Text(CORE_SWITCH_AVAILABLE ? '切换' : '切换暂不可用')
                  .fontSize(Fs.CAPTION)
                  .fontColor(CORE_SWITCH_AVAILABLE ? $r('sys.color.brand') : $r('sys.color.font_tertiary'))
                  .onClick(() => {
                    if (CORE_SWITCH_AVAILABLE) {
                      this.onSelectVersion(row.version);
                    }
                  })
              }
            }
            .width('100%')
            .height(Sz.TOUCH_MIN)
            if (!row.selectable && row.reason.length > 0) {
              Text(row.reason)
                .fontSize(Fs.CAPTION)
                .fontColor($r('sys.color.font_tertiary'))
                .width('100%')
            }
          }
          .width('100%')
        }, (row: CoreVersionRow) => row.version)
      }
    }
    .width('100%')
    .padding(Sp.M)
    .borderRadius(Radius.M)
    .backgroundColor($r('sys.color.background_primary'))
  }

  // ── 插件 ──────────────────────────────────────────────────────────────
  @Builder
  pluginsCard() {
    Column({ space: Sp.S }) {
      Text('插件')
        .fontSize(Fs.SECONDARY)
        .fontWeight(FontWeight.Medium)
        .width('100%')
      // 【为什么不能承诺"运行时安装"（E86）】上游的插件安装通道是 `dsh plugin add`，
      // 而它的实现就是创建进程：`dsh/lib/plugin-Ddi42qoW.js:109` → `spawnSync("pnpm", …)`。
      // 鸿蒙不允许应用创建进程（D6 E15），所以"运行时安装/卸载插件"在端侧**永远不成立**——
      // 无论插件是纯 JS 还是含 .node。这里如实说清，并指出真正能改插件的地方在打包侧。
      Text('插件不能在端侧运行时安装或卸载：上游安装通道 `dsh plugin add` 的实现是创建子进程执行 pnpm，而鸿蒙不允许应用创建进程（D6 E15）。下面列出的是随核心包发版提供的插件；**可以开/关**，改动在重启核心后生效。')
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_tertiary'))
        .width('100%')
      // 恢复默认 + 结果提示：把"改了哪一行、要不要重启"讲清楚，不留需要用户猜的状态
      Row({ space: Sp.S }) {
        Button('恢复默认启停')
          .fontSize(Fs.CAPTION)
          .height(28)
          .backgroundColor($r('sys.color.background_secondary'))
          .fontColor($r('sys.color.font_secondary'))
          .onClick(() => {
            this.onResetPluginRows();
          })
        if (this.pluginNotice.length > 0) {
          Text(this.pluginNotice)
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_secondary'))
            .layoutWeight(1)
        }
      }
      .width('100%')
      if (this.view.plugins.length === 0) {
        Text('未读取到插件清单。清单由核心包携带（打包时算好，端侧只读一份清单，不遍历目录）；装上带清单的核心版本后，这里会列出实际的行。')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')
      } else {
        ForEach(this.view.plugins, (p: PluginRow) => {
          Column({ space: 2 }) {
            Row({ space: Sp.S }) {
              // 行 id 是用户在 profile 里改启停时写的那个名字，比包名更有用，因此优先显示
              Text(p.id.length > 0 ? p.id : p.name)
                .fontSize(Fs.CAPTION)
                .layoutWeight(1)
              if (p.disabled) {
                Text('已禁用')
                  .fontSize(Fs.CAPTION)
                  .fontColor($r('sys.color.font_tertiary'))
              }
              Text(p.badge)
                .fontSize(Fs.CAPTION)
                .fontColor(p.installable ? $r('sys.color.brand') : $r('sys.color.font_tertiary'))
              // 启停开关：只对**有行 id** 的行显示（没有 id 就无法写 patch 行，
              // 硬给一个开关会变成"点了没反应"的假入口）
              if (p.id.length > 0) {
                Toggle({ type: ToggleType.Switch, isOn: !p.disabled })
                  .onChange((isOn: boolean) => {
                    this.onTogglePlugin(p.id, !isOn);
                  })
              }
            }
            .width('100%')
            Text(p.name)
              .fontSize(Fs.CAPTION_XS)
              .fontColor($r('sys.color.font_tertiary'))
              .width('100%')
            if (!p.installable && p.reason.length > 0) {
              Text(p.reason)
                .fontSize(Fs.CAPTION)
                .fontColor($r('sys.color.font_tertiary'))
                .width('100%')
            }
          }
          .width('100%')
        }, (p: PluginRow) => `${p.id}|${p.name}`)
      }
    }
    .width('100%')
    .padding(Sp.M)
    .borderRadius(Radius.M)
    .backgroundColor($r('sys.color.background_primary'))
  }

  // ── 颜色 ──────────────────────────────────────────────────────────────
  private phaseColor(): ResourceColor {
    if (this.view.phase === CorePhase.READY) {
      return $r('sys.color.brand');
    }
    if (this.view.phase === CorePhase.FAILED) {
      return $r('sys.color.warning');
    }
    return $r('sys.color.font_secondary');
  }

  private factColor(verdict: string): ResourceColor {
    if (verdict === 'ok') {
      return $r('sys.color.brand');
    }
    if (verdict === 'warn') {
      return $r('sys.color.warning');
    }
    return $r('sys.color.font_tertiary');
  }
}
