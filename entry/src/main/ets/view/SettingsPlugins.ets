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

  aboutToDisappear(): void {
    this.stopInstallPolling();
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
          Circle({ width: 8, height: 8 })   // token-exempt: 状态点几何（与插件行原样一致，搬迁不改视觉）
            .fill(p.phase === 'active' ? $r('sys.color.confirm') : $r('sys.color.font_tertiary'))
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
