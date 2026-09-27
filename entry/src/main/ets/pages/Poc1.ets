/**
 * POC-1 验证页：原生协议往返（D4 的「生死门」）。
 *
 * 本页是**验证工具**，不是产品界面。它按 D4 POC-1 的六步判定逐项执行并留下可复制日志：
 *   ① token 换 cookie（含 303 观测）
 *   ② 一元只读调用（返回信封校验）
 *   ③ 打开逻辑流复用端点并订阅事件流
 *   ④ 校验首帧为 ready
 *   ⑤ 心跳存活计时（默认 300s 门槛）
 *   ⑥ cancel 生效
 *
 * 端点与参数形态一律取自 `dshcompat` 兼容面，本页不硬编码上游接口细节。
 * 日志纪律：不打印 token / cookie 值（D1 §11.5 S4）。
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { common } from '@kit.AbilityKit';
import { DshHost } from 'hostruntime';
// NodeRuntime 是**本模块（entry）**的运行时实现，不在 hostruntime 里（分层：机制在 entry）
import { NodeRuntime } from '../runtime/NodeRuntime';
import {
  AuthOutcome,
  Connection,
  DiagnosticItem,
  DiagnosticReport,
  EventStreamPhase,
  HostConfig,
  HostFacts,
  RemoteFailure,
  RpcResult
} from 'connection';
import { READONLY_PROBE_ENDPOINTS, SURFACE } from 'dshcompat';
import { Border, Fs, Radius } from 'appstate';

const DOMAIN: number = 0xD5D5;
const TAG: string = 'DshPoc1';

/** 日志级别 */
enum LogLevel {
  INFO = 'INFO',
  OK = 'OK',
  FAIL = 'FAIL',
  STEP = 'STEP'
}

interface LogLine {
  level: LogLevel;
  time: string;
  text: string;
}

@Entry
@Component
struct Poc1 {
  // 默认地址用**真实默认端口**（HOST_DEFAULT_PORT=3120）；曾经写成 3000 是误导
  @State address: string = '127.0.0.1:3120';
  @State token: string = '';
  /** 本页自动填值的来源说明（空串 = 没填过，不显示） */
  @State prefillNote: string = '';
  @State stateText: string = '未连接';
  @State busy: boolean = false;
  @State lines: LogLine[] = [];
  @State copied: boolean = false;

  private conn: Connection = new Connection({ surface: SURFACE });
  private hostFactsText: string = '';
  private heartbeatTimer: number = -1;
  private heartbeatStart: number = 0;
  private disconnectCount: number = 0;
  private endpointUsed: string = '';

  aboutToDisappear(): void {
    this.stopHeartbeatWatch();
    this.conn.stop();
  }

  aboutToAppear(): void {
    this.prefillFromLocalHost();
  }

  /**
   * 进入本页时**自动填好本机核心**（E94）。
   *
   * 【为什么必须自动填，而不是留两个空输入框】这一页要的是"这台设备上正在跑的那个 Host
   * 的地址与令牌"；而 **令牌每个进程都会重新生成**（dsh 每次启动换一个，绑进程）。
   * 让人去 hilog 里找、再手抄进输入框，既容易错也没有信息量——用户已经明确说过
   * "不知道填什么"。这里直接读入口脚本写下的 `host-ready.json`（与客户端自动接入用的是
   * **同一份来源**），拆成地址与令牌填进去。
   *
   * 【读不到就如实说】而不是留一个看起来像"默认值"的地址让人以为配好了。
   * 本页仍然可手工改成**别的** Host（远程/局域网），自动填值不会覆盖已经改过的手工输入。
   */
  private prefillFromLocalHost(): void {
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      const host: DshHost = new DshHost(ctx.filesDir,
        new NodeRuntime(`${ctx.resourceDir}/resources/app/main.js`, ctx.filesDir));
      const url: string = host.localHostReadyUrl();
      if (url.length === 0) {
        this.prefillNote = '本机核心还没写下启动链接（未启动？）。地址已按默认端口 3120 填好；'
          + '核心起来后再回到本页会自动补上令牌。';
        return;
      }
      // 不用全局 URL（ArkTS 里它不是全局对象）：手工拆 `?token=`，这段格式由入口脚本决定
      const q: number = url.indexOf('?');
      const base: string = q >= 0 ? url.substring(0, q) : url;
      const query: string = q >= 0 ? url.substring(q + 1) : '';
      const authorityRaw: string = base.replace(/^https?:\/\//, '');
      // host-ready.json 的 url 形如 `http://127.0.0.1:3120/?token=…`：去掉 scheme 后
      // 还会带一个尾斜杠。它不算错（客户端的地址解析会在 `/` 处截断），但填进输入框
      // 会让人以为"地址要带斜杠"，所以这里清掉。
      const authority: string = authorityRaw.endsWith('/')
        ? authorityRaw.substring(0, authorityRaw.length - 1)
        : authorityRaw;
      let parsedToken: string = '';
      for (const pair of query.split('&')) {
        const eq: number = pair.indexOf('=');
        if (eq > 0 && pair.substring(0, eq) === 'token') {
          parsedToken = decodeURIComponent(pair.substring(eq + 1));
        }
      }
      if (authority.length > 0) {
        this.address = authority;
      }
      if (parsedToken.length > 0) {
        this.token = parsedToken;
      }
      this.prefillNote = `已自动填入本机核心：${this.address}`
        + `（令牌 ${parsedToken.length} 字符，来自设备上正在运行的核心；可直接点「① 认证并跑通」）`;
      hilog.info(DOMAIN, TAG, 'POC 已预填本机核心：authority=%{public}s tokenLen=%{public}d',
        this.address, parsedToken.length);
    } catch (e) {
      const err = e as Error;
      this.prefillNote = `自动填值失败（不影响手工填写）：${err.message}`;
      hilog.warn(DOMAIN, TAG, 'POC 预填失败：%{public}s', err.message);
    }
  }

  // ─────────────────────────── 日志 ───────────────────────────

  private log(level: LogLevel, text: string): void {
    const time: string = formatClock(Date.now());
    // 单行日志：ArkTS 不允许数组内直接修改，必须整体替换以触发刷新
    const next: LogLine[] = this.lines.slice();
    next.push({ level: level, time: time, text: text });
    this.lines = next;
    const head: string = text.length > 400 ? text.substring(0, 400) : text;
    hilog.info(DOMAIN, TAG, '%{public}s %{public}s', level, head);
  }

  private clearLog(): void {
    this.lines = [];
    this.copied = false;
  }

  private reportText(): string {
    const parts: string[] = [];
    parts.push(`# POC-1 报告  ${new Date().toISOString()}`);
    parts.push(`地址: ${this.address}`);
    parts.push(`状态: ${this.stateText}`);
    parts.push(`Host 事实: ${this.hostFactsText.length > 0 ? this.hostFactsText : '(未获取)'}`);
    parts.push(`使用的端点: ${this.endpointUsed.length > 0 ? this.endpointUsed : '(未调用)'}`);
    parts.push(`断连次数: ${this.disconnectCount}`);
    parts.push('--- 日志 ---');
    for (let i = 0; i < this.lines.length; i++) {
      const line: LogLine = this.lines[i];
      parts.push(`[${line.time}] ${line.level} ${line.text}`);
    }
    return parts.join('\n');
  }

  // ─────────────────────────── 步骤 ① 认证 ───────────────────────────

  private async runAuth(): Promise<void> {
    this.busy = true;
    this.log(LogLevel.STEP, '步骤①：token → 签名 cookie');
    try {
      const trimmed: string = this.address.trim();
      const rawToken: string = this.token.trim();
      const input: string = rawToken.length > 0 ? `${trimmed}?token=${rawToken}` : trimmed;
      const config: HostConfig | undefined = this.conn.configure(input, 'POC Host');
      if (config === undefined) {
        this.log(LogLevel.FAIL, '地址解析失败：请填写 host:port 或完整启动 URL');
        this.busy = false;
        return;
      }
      this.log(LogLevel.INFO, `authority=${config.authority} loopback=${config.isLoopback} scheme=${config.scheme}`);
      const outcome: AuthOutcome = await this.conn.authenticate();
      if (!outcome.ok) {
        this.log(LogLevel.FAIL, `认证失败（HTTP ${outcome.status}）：${outcome.reason ?? ''}`);
        if (outcome.advice !== undefined) {
          this.log(LogLevel.INFO, `建议：${outcome.advice}`);
        }
        this.stateText = '认证失败';
        this.busy = false;
        return;
      }
      this.log(LogLevel.OK, '① 认证成功：已获得会话 cookie');
      this.log(LogLevel.INFO, `已持 cookie: ${this.conn.hasSession() ? 'yes' : 'no'}`);
      this.stateText = '已认证';
      await this.runUnary();
    } catch (error) {
      this.log(LogLevel.FAIL, `认证异常：${asMessage(error)}`);
    }
    this.busy = false;
  }

  // ─────────────────────────── 步骤 ② 一元调用 ───────────────────────────

  /**
   * 依次尝试候选端点，找到可用的那个。
   *
   * 端点清单**不在这里硬编码**：来自 `dshcompat` 的 `READONLY_PROBE_ENDPOINTS`
   * （全部是无参数、无副作用的只读端点）。参数形态也由兼容面按生成上表决定，
   * 因此上游改动端点或参数形状时本页面无需修改。
   */
  private async runUnary(): Promise<void> {
    this.log(LogLevel.STEP, '步骤②：一元 RPC（只读端点连通性判定）');
    const candidates: string[] = READONLY_PROBE_ENDPOINTS;
    const noArgs: Record<string, Object> = {};
    for (let i = 0; i < candidates.length; i++) {
      const endpoint: string = candidates[i];
      const result: RpcResult = await this.conn.call(endpoint, noArgs as Object);
      if (result.ok) {
        this.endpointUsed = endpoint;
        const value: Object | undefined = result.value;
        this.log(LogLevel.OK, `② 一元调用成功：${endpoint}`);
        this.log(LogLevel.INFO, `value 摘要=${summarize(value)}`);
        await this.runEventStream();
        return;
      }
      const failure: RemoteFailure | undefined = result.error;
      this.log(LogLevel.FAIL, `端点半失败：${endpoint} → ${failure?.toString() ?? 'unknown'}`);
    }
    this.log(LogLevel.FAIL, '② 一元调用全部候选失败：请核对 D2 §8.5 的调用契约表与漂移报告');
  }

  // ─────────────────────────── 步骤 ③④⑤ 事件流 ───────────────────────────

  private async runEventStream(): Promise<void> {
    this.log(LogLevel.STEP, '步骤③：打开 /api/remote.mux 并订阅 $events');
    const started: boolean = await this.conn.start({
      onReady: (facts: HostFacts) => {
        this.hostFactsText = `clientId=${facts.clientId} home=${facts.home}`;
        this.log(LogLevel.OK, `④ 收到 ready 首项：${this.hostFactsText}`);
        this.startHeartbeatWatch();
      },
      onEvent: (event: Object) => {
        this.log(LogLevel.INFO, `事件：${summarize(event)}`);
      },
      onEnd: (error?: string) => {
        this.disconnectCount += 1;
        this.log(LogLevel.FAIL, `事件流终止：${error ?? '(无原因)'}`);
      }
    });
    if (!started) {
      this.log(LogLevel.FAIL, `③ 连接/开流失败：${this.conn.getLastError() ?? '未知'}`);
      return;
    }
    this.log(LogLevel.OK, '③ mux 已建立，开流帧已发送');
    this.log(LogLevel.INFO, `事件流阶段=${this.conn.getEventPhase()}`);
  }

  private startHeartbeatWatch(): void {
    this.stopHeartbeatWatch();
    this.heartbeatStart = Date.now();
    this.log(LogLevel.STEP, '步骤⑤：心跳存活观察开始（建议 ≥300s）');
    this.heartbeatTimer = setInterval(() => {
      const elapsed: number = Math.round((Date.now() - this.heartbeatStart) / 1000);
      if (this.conn.getEventPhase() === EventStreamPhase.LIVE) {
        this.log(LogLevel.INFO, `⑤ 心跳存活 ${elapsed}s（事件流仍为 LIVE）`);
      } else {
        this.log(LogLevel.FAIL, `⑤ 心跳期间事件流失效（${elapsed}s，phase=${this.conn.getEventPhase()}）`);
        this.stopHeartbeatWatch();
      }
    }, 30000);
  }

  private stopHeartbeatWatch(): void {
    if (this.heartbeatTimer >= 0) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = -1;
    }
  }

  // ─────────────────────────── 步骤 ⑥ + 诊断 ───────────────────────────

  private async runStop(): Promise<void> {
    this.busy = true;
    this.stopHeartbeatWatch();
    const elapsed: number = this.heartbeatStart > 0 ? Math.round((Date.now() - this.heartbeatStart) / 1000) : 0;
    this.log(LogLevel.STEP, `步骤⑥：停止连接（心跳观察时长 ${elapsed}s）`);
    await this.conn.stop();
    this.log(LogLevel.OK, '⑥ 已停止：mux 关闭、逻辑流已 cancel');
    this.stateText = '已停止';
    this.busy = false;
  }

  private async runDiagnose(): Promise<void> {
    this.busy = true;
    this.log(LogLevel.STEP, '生成连接诊断（五项判定）');
    const report: DiagnosticReport = await this.conn.diagnose();
    for (let i = 0; i < report.items.length; i++) {
      const item: DiagnosticItem = report.items[i];
      const level: LogLevel = item.passed ? LogLevel.OK : LogLevel.FAIL;
      this.log(level, `${item.name}: ${item.detail}`);
      if (!item.passed && item.advice !== undefined) {
        this.log(LogLevel.INFO, `  建议：${item.advice}`);
      }
    }
    this.log(report.healthy ? LogLevel.OK : LogLevel.FAIL, `诊断结论：${report.healthy ? '健康' : '存在问题'}`);
    this.busy = false;
  }

  /** 生成报告并复制到系统剪贴板（@kit.BasicServicesKit 的 pasteboard） */
  private async copyReport(): Promise<void> {
    const text: string = this.reportText();
    try {
      const data: pasteboard.PasteData = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text);
      await pasteboard.getSystemPasteboard().setData(data);
      this.copied = true;
      this.log(LogLevel.OK, `报告已复制到剪贴板（${text.length} 字符）`);
    } catch (error) {
      this.log(LogLevel.FAIL, `复制报告失败：${asMessage(error)}`);
    }
  }

  // ─────────────────────────── UI ───────────────────────────

  build() {
    Column({ space: 10 }) {
      Text('DSH 协议往返验证（POC-1）')
        .fontSize(Fs.TITLE_L)
        .fontWeight(FontWeight.Bold)
        .width('100%')

      if (this.prefillNote.length > 0) {
        Text(this.prefillNote)
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')
      }

      TextInput({ text: this.address, placeholder: 'Host 地址，如 127.0.0.1:3120' })
        .onChange((value: string) => { this.address = value; })
        .width('100%')

      TextInput({ text: this.token, placeholder: 'token（或直接粘贴完整启动 URL 到上一栏）' })
        .onChange((value: string) => { this.token = value; })
        .width('100%')

      Row({ space: 8 }) {
        Button('① 认证并跑通')
          .enabled(!this.busy)
          .onClick(() => { this.runAuth(); })
        Button('诊断')
          .enabled(!this.busy)
          .buttonStyle(ButtonStyleMode.NORMAL)
          .onClick(() => { this.runDiagnose(); })
        Button('停止')
          .enabled(!this.busy)
          .buttonStyle(ButtonStyleMode.NORMAL)
          .onClick(() => { this.runStop(); })
        Button('复制报告')
          .buttonStyle(ButtonStyleMode.TEXTUAL)
          .onClick(() => { this.copyReport(); })
        Button('清空')
          .buttonStyle(ButtonStyleMode.TEXTUAL)
          .onClick(() => { this.clearLog(); })
      }
      .width('100%')

      Row({ space: 8 }) {
        Text(`状态：${this.stateText}`)
          .fontSize(Fs.SECONDARY)
        Text(this.busy ? '运行中…' : '空闲')
          .fontSize(Fs.SECONDARY)
          .fontColor(Color.Gray)
      }
      .width('100%')

      if (this.hostFactsText.length > 0) {
        Text(this.hostFactsText)
          .fontSize(Fs.CAPTION)
          .fontColor(Color.Gray)
          .width('100%')
      }

      List({ space: 4 }) {
        ForEach(this.lines, (line: LogLine) => {
          ListItem() {
            Row({ space: 6 }) {
              Text(line.time)
                .fontSize(Fs.CAPTION)
                .fontColor(Color.Gray)
                .width(64)
              Text(line.level)
                .fontSize(Fs.CAPTION)
                .fontColor(levelColor(line.level))
                .width(40)
              Text(line.text)
                .fontSize(Fs.CAPTION)
                .layoutWeight(1)
            }
            .width('100%')
            .alignItems(VerticalAlign.Top)
          }
        }, (line: LogLine, index: number) => `${index}-${line.time}-${line.level}`)
      }
      .layoutWeight(1)
      .width('100%')
      .borderWidth(Border.HAIRLINE)
      .borderColor(Color.Gray)
      .borderRadius(Radius.XS)
      .padding(6)
    }
    .padding(12)
    .width('100%')
    .height('100%')
  }
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** 本地时钟字符串 HH:MM:SS（用单个 Date 实例派生，避免重复构造） */
function formatClock(epochMs: number): string {
  const d: Date = new Date(epochMs);
  const hh: string = pad2(d.getHours());
  const mm: string = pad2(d.getMinutes());
  const ss: string = pad2(d.getSeconds());
  return `${hh}:${mm}:${ss}`;
}

function levelColor(level: LogLevel): Color {
  if (level === LogLevel.OK) {
    return Color.Green;
  }
  if (level === LogLevel.FAIL) {
    return Color.Red;
  }
  if (level === LogLevel.STEP) {
    return Color.Blue;
  }
  return Color.Gray;
}

function summarize(value: Object | undefined): string {
  if (value === undefined) {
    return '(undefined)';
  }
  let text: string = '';
  try {
    text = JSON.stringify(value);
  } catch (error) {
    text = '<不可序列化>';
  }
  return text.length > 300 ? `${text.substring(0, 300)}…(共 ${text.length} 字符)` : text;
}

function asMessage(error: Object): string {
  if (error instanceof Error) {
    return (error as Error).message;
  }
  return `${error}`;
}
