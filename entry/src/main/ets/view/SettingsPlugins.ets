/**
 * 设置 · 插件（P4-2：从 1878 行的 `SettingsPane` 拆出的**第一个域组件**）。
 *
 * ## 这一个域回答什么
 *
 * "我要改什么"：随包发版的插件清单 + **可安装性三态徽标**（纯 JS / 需发版 / 待确认，取值来自
 * `appstate` 的 `classifyPlugin` 契约）。只读清单是另一个域（`SettingsInventory`）——
 * 官方把两者分成两个分区（`settings-plugins` / `settings-plugin-inventory`），
 * 因为"改什么"（有风险）与"有什么"（只查证）不是同一件事。
 *
 * ## 从"硬边界"到"运行时安装通道"（D26，2026-09-21）
 *
 * 端侧曾有一条写在界面上的硬边界：上游 `dsh plugin add` 走 `spawnSync("pnpm")`，
 * 而设备上没有 pnpm/npm/git（E86），也没有独立 node 可执行文件能跑它们（D6 E15）
 * ⇒ 此前这里不提供任何安装入口，理由如实写在卡片上。
 *
 * D26 之后这条边界被**进程内安装器**绕开（不是修复 pnpm，是换通道）：
 * `dshm-installer.js` 在 Host 进程内完成 registry 解析 → HTTPS 下载 → 纯 JS
 * gunzip+tar 解包 → `node_modules` 落位 → 用户行追加。本组件的安装区块是它
 * 的 ArkUI 入口：把 spec 写进 `$DSH_HOME/install-queue/<id>.req`，轮询读
 * `<id>.done` / `<id>.fail`，安装完成后随应用重启生效（composeUserRows 把
 * 用户行拼进 cordis.patch.yml）。模型侧的同款入口见 skill `ohos-plugin-install`。
 *
 * ## 兼容性豁免开关（P1-3，2026-09-28）
 *
 * 核心 0.2.0-rc.1 起，peerDependencies 锁 `@deepseek-ai/dsh` 0.1.x 的插件会被
 * **拒绝挂载**，上游给的唯一出路是 `dsh plugin allow-version` 或插件管理器。
 * 端侧两条路原先都是死的：`dsh` 假壳没有 allow-version；插件管理器恰好就是那个
 * 被跳过的插件（鸡生蛋）。现在补上了两条：假壳子命令（命令行）与本页开关（UI）。
 *
 * 【为什么这里必须能"撤销"而不只是个开关】豁免记录是 `包名@精确版本 → 运行时版本[]`，
 * 粒度是**一对精确版本**，不是"这个包以后都放过"。所以本页的输入是
 * `<包名>@<精确版本>`（不是包名），并要求显式勾选风险确认——上游
 * `setProfileVersionExemption` 在 `acceptRisk !== true` 时会直接抛错，
 * 这不是端侧加的装饰性确认。
 *
 * 【为什么写 `.compat-req` 而不是自己写 compatibility.json】豁免文件的 schema
 * （精确版本校验、坏记录跳过但保留其余、`rewritable` 语义）由上游
 * `@deepseek-ai/dsh-app-boot` 定义。自己按 schema 写文件一旦偏离，上游会**静默不认**
 * ——用户以为授权成功、插件仍被跳过，比没有开关更难排查。所以这里只投一条请求，
 * 由 Host 侧的 `dshm-compat.js` 转调上游那三个导出。
 */

import { Fs, PluginItem, Radius, Sp, classifyPlugin, pluginSummary } from 'appstate';
import { PluginNative } from 'appstate';
import type { PluginRow } from 'appstate';
import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';

/** 安装结果轮询间隔（ms），与 Host 队列轮询同拍。 */
const INSTALL_POLL_MS = 2000;
/** 等待安装结果的时限（ms）：大包下载 + 递归依赖留足余量。 */
const INSTALL_TIMEOUT_MS = 180000;

@Component
export struct SettingsPlugins {
  /** 插件清单（随包发版 + 用户行叠加，宿主投影后传入） */
  @Prop plugins: PluginItem[] = [];

  // ── 安装区块状态（D26 运行时通道）──────────────────────────────────
  /** spec 输入草稿（npm 包名 / 包名@版本 / GitHub 仓库地址） */
  @State installSpecInput: string = '';
  /** idle=未提交；busy=等 Host 结果；done=成功；fail=失败 */
  @State installPhase: string = 'idle';
  /** 安装结果文案（各阶段的用户可见反馈） */
  @State installMsg: string = '';
  /** 轮询定时器句柄；-1 = 未启动 */
  private installTimerId: number = -1;
  /** 本次请求的基名（ui-<ts>），.done/.fail 与之配对 */
  private installReqBase: string = '';

  // ── 兼容性豁免区块状态（P1-3）──────────────────────────────────────
  /** `<包名>@<精确版本>` 草稿 */
  @State compatPkgInput: string = '';
  /** 风险确认勾选：**默认 false**，上游要求显式确认才允许授予 */
  @State compatAcceptRisk: boolean = false;
  /** idle=未提交；busy=等 Host 结果；done=成功；fail=失败 */
  @State compatPhase: string = 'idle';
  /** 豁免结果文案 */
  @State compatMsg: string = '';
  /** 轮询定时器句柄；-1 = 未启动 */
  private compatTimerId: number = -1;
  /** 本次请求的基名（uic-<ts>），与 .compat-req 同基名 */
  private compatReqBase: string = '';

  aboutToDisappear(): void {
    this.stopInstallPolling();
    this.stopCompatPolling();
  }

  build() {
    // 【ArkUI 约束】组件的 build() 只能有一个根节点 ⇒ 多段内容包进 Column
    Column({ space: Sp.S }) {
      Row({ space: Sp.S }) {
        Text(pluginSummary(this.plugins))
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .layoutWeight(1)
      }
      .width('100%')

      // 【通道变迁，如实写】旧文案说"端侧无法创建进程 ⇒ 不提供安装入口"——那在
      // E86/D6 E15 的意义上仍然为真（pnpm/npm/git 依旧不存在，上游 execa("pnpm")
      // 依旧第一步就 ENOENT）。但 D26 起安装不再经过它们：Host 进程内的
      // dshm-installer 直接下载并解包（见上方组件头注释），下方安装区块就是这个
      // 通道的入口。原生插件（含 .node）依旧装不了——沙箱禁 symlink/hardlink
      // （13900012），tar 里的链接条目会被如实跳过并在结果里报告。
      Text('端侧没有 pnpm/npm/git，上游安装通道 `dsh plugin add` 在此不可用；本页安装走 Host 进程内安装器（D26）：下载 npm 包或 GitHub 仓库并解包到当前 profile，重启应用后生效。含原生模块的插件（.node）不受支持；上游清单不含「是否含原生模块」，故徽标一律标注「待确认」。')
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_tertiary'))
        .width('100%')

      ForEach(this.plugins, (p: PluginItem) => {
        Row({ space: Sp.M }) {
          Row()
            .width(Sp.S)
            .height(Sp.S)
            .backgroundColor(p.phase === 'active' ? $r('sys.color.confirm') : $r('sys.color.font_tertiary'))
            .borderRadius(Radius.S)
          Column({ space: 2 }) {
            Text(p.moduleName)
              .fontSize(Fs.SECONDARY)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')
            Text(`${p.entryId} · ${p.enabled ? '已启用' : '已禁用'}${p.phase.length > 0 ? ` · ${p.phase}` : ''}`)
              .fontSize(Fs.CAPTION)
              .fontColor($r('sys.color.font_tertiary'))
              .width('100%')
          }
          .layoutWeight(1)
          if (p.firstParty) {
            Text('第一方')
              .fontSize(Fs.CAPTION_XS)
              .fontColor($r('sys.color.font_tertiary'))
              .padding({ left: 5, right: 5 })   // token-exempt: 徽标药丸内边距
              .borderRadius(5)   // token-exempt: 徽标药丸圆角
              .backgroundColor($r('sys.color.background_primary'))
          }
          // 可安装性徽标：取值由 appstate 的三态契约给出（纯 JS / 需发版 / 待确认）
          Text(this.pluginRowOf(p).badge)
            .fontSize(Fs.CAPTION_XS)
            .fontColor($r('sys.color.font_tertiary'))
            .padding({ left: 5, right: 5 })   // token-exempt: 徽标药丸内边距
            .borderRadius(5)   // token-exempt: 徽标药丸圆角
            .backgroundColor($r('sys.color.background_primary'))
        }
        .width('100%')
        .padding(Sp.M)
        .borderRadius(Radius.M)
        .backgroundColor($r('sys.color.background_secondary'))
      }, (p: PluginItem) => p.entryId)

      // ── D26 安装区块：文件队列（.req → .done/.fail），与模型 skill 同一通道 ──
      Column({ space: Sp.S }) {
        Text('安装插件')
          .fontSize(Fs.SECONDARY)
          .width('100%')
        Text('npm 包名（可带 @version / @range）或 GitHub 仓库地址；依赖会递归安装（深度 ≤3），同名已装则跳过。')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')
        Row({ space: Sp.S }) {
          TextInput({ text: this.installSpecInput, placeholder: '如 @deepseek-ai/xxx 或 github.com/owner/repo' })
            .layoutWeight(1)
            .onChange((v: string) => {
              this.installSpecInput = v;
            })
          Button(this.installPhase === 'busy' ? '安装中…' : '安装')
            .enabled(this.installPhase !== 'busy')
            .onClick(() => this.startInstall())
        }
        .width('100%')
        if (this.installMsg.length > 0) {
          Text(this.installMsg)
            .fontSize(Fs.CAPTION)
            .fontColor(this.installPhase === 'done' ? $r('sys.color.confirm')
              : this.installPhase === 'fail' ? $r('sys.color.warning')
                : $r('sys.color.font_tertiary'))
            .width('100%')
        }
      }
      .width('100%')
      .padding(Sp.M)
      .borderRadius(Radius.M)
      .backgroundColor($r('sys.color.background_secondary'))

      // ── P1-3 兼容性豁免区块：文件队列（.compat-req → .done/.fail）──
      Column({ space: Sp.S }) {
        Text('兼容性豁免（风险自负）')
          .fontSize(Fs.SECONDARY)
          .width('100%')
        Text('核心 0.2.0 起会拒绝挂载 peerDependencies 仍锁 0.1.x 的插件（如 dshmarket / dsh-better-sidebar）。'
          + '豁免的粒度是**一对精确版本**：必须填 `<包名>@<精确版本>`（不接受 ^ 或 range），且只对当前运行的核心版本生效。')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')
        Row({ space: Sp.S }) {
          TextInput({ text: this.compatPkgInput, placeholder: '如 dshmarket@1.66.2' })
            .layoutWeight(1)
            .onChange((v: string) => {
              this.compatPkgInput = v;
            })
          Button('授予')
            .enabled(this.compatPhase !== 'busy' && this.compatAcceptRisk)
            .onClick(() => this.startCompat(true))
          Button('撤销')
            .enabled(this.compatPhase !== 'busy')
            .onClick(() => this.startCompat(false))
        }
        .width('100%')
        // 风险确认必须由用户主动勾选：上游 setProfileVersionExemption 在
        // acceptRisk !== true 时会直接抛错（不是端侧加的装饰性确认），所以这里
        // 默认 false 且「授予」按钮在未勾选时禁用——避免点了才被上游拒绝。
        Row({ space: Sp.S }) {
          Toggle({ type: ToggleType.Switch, isOn: this.compatAcceptRisk })
            .onChange((isOn: boolean) => {
              this.compatAcceptRisk = isOn;
            })
          Text('我了解：不兼容的插件可能导致崩溃或数据丢失')
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_tertiary'))
            .layoutWeight(1)
        }
        .width('100%')
        if (this.compatMsg.length > 0) {
          Text(this.compatMsg)
            .fontSize(Fs.CAPTION)
            .fontColor(this.compatPhase === 'done' ? $r('sys.color.confirm')
              : this.compatPhase === 'fail' ? $r('sys.color.warning')
                : $r('sys.color.font_tertiary'))
            .width('100%')
        }
      }
      .width('100%')
      .padding(Sp.M)
      .borderRadius(Radius.M)
      .backgroundColor($r('sys.color.background_secondary'))

      Text('插件的安装与卸载由 Host 侧执行；端侧只展示状态与触发操作（D1 §7.6.4）。')
        .fontSize(Fs.CAPTION)
        .fontColor($r('sys.color.font_tertiary'))
        .width('100%')
    }
    .width('100%')
  }

  /** 提交安装请求：写 .req 进 Host 队列目录，启动结果轮询。 */
  private startInstall(): void {
    const spec: string = this.installSpecInput.trim();
    if (spec.length === 0 || this.installPhase === 'busy') {
      return;
    }
    const ctx = getContext(this) as common.UIAbilityContext;
    const queueDir: string = `${ctx.filesDir}/dsh/home/install-queue`;
    try {
      // recursive=true：首次（目录尚不存在）与之后（已存在）都成立
      fileIo.mkdirSync(queueDir, true);
    } catch (e) {
      this.installPhase = 'fail';
      this.installMsg = `创建安装队列目录失败：${queueDir}`;
      return;
    }
    this.installReqBase = `ui-${Date.now()}`;
    const reqPath: string = `${queueDir}/${this.installReqBase}.req`;
    try {
      const file: fileIo.File = fileIo.openSync(reqPath,
        fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.TRUNC);
      fileIo.writeSync(file.fd, spec);
      fileIo.closeSync(file);
    } catch (e) {
      this.installPhase = 'fail';
      this.installMsg = `写入安装请求失败：${reqPath}`;
      return;
    }
    this.installPhase = 'busy';
    this.installMsg = `已提交「${spec}」，等待 Host 安装…`;
    const startedAt: number = Date.now();
    this.stopInstallPolling();
    this.installTimerId = setInterval((): void => {
      this.pollInstallResult(queueDir, spec, startedAt);
    }, INSTALL_POLL_MS);
  }

  /** 轮询一轮：读 .done/.fail（读到即删结果文件并停表），超时则报错停表。 */
  private pollInstallResult(queueDir: string, spec: string, startedAt: number): void {
    const donePath: string = `${queueDir}/${this.installReqBase}.done`;
    const failPath: string = `${queueDir}/${this.installReqBase}.fail`;
    try {
      const text: string = fileIo.readTextSync(donePath);
      this.deleteQuietly(donePath);
      this.stopInstallPolling();
      this.installPhase = 'done';
      this.installMsg = this.describeDone(text, spec);
      return;
    } catch (e) {
      // .done 不存在：继续看 .fail
    }
    try {
      const text: string = fileIo.readTextSync(failPath);
      this.deleteQuietly(failPath);
      this.stopInstallPolling();
      this.installPhase = 'fail';
      this.installMsg = `安装失败：${this.describeError(text)}`;
      return;
    } catch (e) {
      // .fail 也不存在：Host 还在装，继续等
    }
    if (Date.now() - startedAt > INSTALL_TIMEOUT_MS) {
      this.stopInstallPolling();
      this.installPhase = 'fail';
      this.installMsg = `等待超时（${INSTALL_TIMEOUT_MS / 1000}s）：Host 未回报「${spec}」的安装结果。请确认 Host 在运行（或查 dshm-host.log）后重试。`;
    }
  }

  /** done JSON → 用户文案（包数 + Host 给出的 note，如"重启后生效"）。 */
  private describeDone(text: string, spec: string): string {
    try {
      const r = JSON.parse(text) as Record<string, Object>;
      const installed = r['installed'] as Object[];
      const note = r['note'] as string;
      const count: number = installed !== null && installed !== undefined ? installed.length : 0;
      return `安装完成：「${spec}」共 ${count} 个包。${note !== null && note !== undefined ? note : '重启应用后生效。'}`;
    } catch (e) {
      return `安装完成：「${spec}」。重启应用后生效。`;
    }
  }

  /** fail JSON（{ok:false,error}）→ 错误文案；解析不了就原样展示。 */
  private describeError(text: string): string {
    try {
      const r = JSON.parse(text) as Record<string, Object>;
      const err = r['error'] as string;
      if (err !== null && err !== undefined && err.length > 0) {
        return err;
      }
    } catch (e) {
      // 非 JSON：原样返回
    }
    return text.length > 0 ? text : '未知错误';
  }

  private stopInstallPolling(): void {
    if (this.installTimerId >= 0) {
      clearInterval(this.installTimerId);
      this.installTimerId = -1;
    }
  }

  /**
   * 提交兼容性豁免请求（P1-3）：写 `<id>.compat-req`（JSON 载荷）。
   *
   * 【为什么载荷是 JSON 而不是像安装那样一行 spec】豁免需要三个字段
   * （`packageVersion` / `enabled` / `acceptRisk`），用分隔符拼串会让"包名里恰好
   * 含分隔符"变成注入面；队列另一端本来就要 `JSON.parse`。
   *
   * 【为什么不写 `.dir`（与安装通道一致）】省略时 Host 回退到宿主 profile
   * （`$DSH_HOME/profiles/<PROFILE>`，默认 ondevice）——正是兼容性检查读取的那个
   * 目录。界面拿不到 profile 名，硬猜反而会写错。结果里带回 Host 实际写入的
   * `profileDir` 并如实展示，避免"写到了别处却以为成功"。
   *
   * 【撤销也走同一通道】豁免是"一对精确版本"的集合，撤销只是从数组里去掉当前
   * 运行时版本；空数组则删除该键。撤销不需要风险确认（是在收紧权限）。
   */
  private startCompat(enable: boolean): void {
    const pkg: string = this.compatPkgInput.trim();
    if (pkg.length === 0 || this.compatPhase === 'busy') {
      return;
    }
    const ctx = getContext(this) as common.UIAbilityContext;
    const queueDir: string = `${ctx.filesDir}/dsh/home/install-queue`;
    try {
      fileIo.mkdirSync(queueDir, true);
    } catch (e) {
      this.compatPhase = 'fail';
      this.compatMsg = `创建安装队列目录失败：${queueDir}`;
      return;
    }
    const payload: Record<string, Object> = {};
    payload['action'] = 'set';
    payload['packageVersion'] = pkg;
    payload['enabled'] = enable;
    // 撤销不确认风险（收紧）；授予时必须由用户已勾选，服务端还会再拒一次
    payload['acceptRisk'] = enable && this.compatAcceptRisk;
    this.compatReqBase = `uic-${Date.now()}`;
    const reqPath: string = `${queueDir}/${this.compatReqBase}.compat-req`;
    try {
      const file: fileIo.File = fileIo.openSync(reqPath,
        fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.TRUNC);
      fileIo.writeSync(file.fd, JSON.stringify(payload));
      fileIo.closeSync(file);
    } catch (e) {
      this.compatPhase = 'fail';
      this.compatMsg = `写入豁免请求失败：${reqPath}`;
      return;
    }
    this.compatPhase = 'busy';
    this.compatMsg = enable
      ? `已提交授予「${pkg}」，等待 Host 处理…`
      : `已提交撤销「${pkg}」，等待 Host 处理…`;
    const startedAt: number = Date.now();
    this.stopCompatPolling();
    this.compatTimerId = setInterval((): void => {
      this.pollCompatResult(queueDir, pkg, enable, startedAt);
    }, INSTALL_POLL_MS);
  }

  /** 轮询一轮：读 .done/.fail（读到即删结果文件并停表），超时则报错停表。 */
  private pollCompatResult(queueDir: string, pkg: string, enable: boolean, startedAt: number): void {
    const donePath: string = `${queueDir}/${this.compatReqBase}.done`;
    const failPath: string = `${queueDir}/${this.compatReqBase}.fail`;
    try {
      const text: string = fileIo.readTextSync(donePath);
      this.deleteQuietly(donePath);
      this.stopCompatPolling();
      this.compatPhase = 'done';
      this.compatMsg = this.describeCompatDone(text, pkg, enable);
      return;
    } catch (e) {
      // .done 不存在：继续看 .fail
    }
    try {
      const text: string = fileIo.readTextSync(failPath);
      this.deleteQuietly(failPath);
      this.stopCompatPolling();
      this.compatPhase = 'fail';
      this.compatMsg = `豁免未生效：${this.describeError(text)}`;
      return;
    } catch (e) {
      // .fail 也不存在：Host 还在处理，继续等
    }
    if (Date.now() - startedAt > INSTALL_TIMEOUT_MS) {
      this.stopCompatPolling();
      this.compatPhase = 'fail';
      this.compatMsg = `等待超时（${INSTALL_TIMEOUT_MS / 1000}s）：Host 未回报「${pkg}」的豁免结果。请确认 Host 在运行（或查 dshm-host.log）后重试。`;
    }
  }

  /**
   * done JSON → 用户文案。
   *
   * 【为什么要显示 Host 实际写入的目录】界面不写 `.dir`（回退宿主 profile），
   * 而"豁免写到了哪个 profile"恰好是这套机制最安静的失败点——写错目录时上游
   * 读不到、插件仍被跳过，用户从提示里看不出任何异常。所以把 `profileDir`
   * 原样呈现，让"授予成功"带上可核对的落点。
   */
  private describeCompatDone(text: string, pkg: string, enable: boolean): string {
    try {
      const r = JSON.parse(text) as Record<string, Object>;
      const note = r['note'] as string;
      const profileDir = r['profileDir'] as string;
      const where: string = profileDir !== null && profileDir !== undefined && profileDir.length > 0
        ? `（写入 ${profileDir}）` : '';
      const base: string = enable ? `已授予「${pkg}」的精确版本豁免` : `已撤销「${pkg}」的豁免`;
      if (note !== null && note !== undefined && note.length > 0) {
        return `${base}。${note}${where}`;
      }
      return `${base}。重启应用后生效。${where}`;
    } catch (e) {
      return enable ? `已授予「${pkg}」。重启应用后生效。` : `已撤销「${pkg}」。`;
    }
  }

  private stopCompatPolling(): void {
    if (this.compatTimerId >= 0) {
      clearInterval(this.compatTimerId);
      this.compatTimerId = -1;
    }
  }

  private deleteQuietly(p: string): void {
    try {
      fileIo.unlinkSync(p);
    } catch (e) {
      // 删不掉不阻塞结果展示（下次同名提交会覆盖）
    }
  }

  private pluginRowOf(p: PluginItem): PluginRow {
    return classifyPlugin(p.moduleName, '', PluginNative.UNKNOWN);
  }
}
