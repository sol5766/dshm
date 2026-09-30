/**
 * 逻辑流复用载体（`/api/remote.mux`，D2 §1.2）。
 *
 * 帧事实（服务端 → 客户端，共三类，见上游 `dsh-api-gateway/lib/types/stream-protocol.d.ts`
 * 的 `RemoteStreamServerMessage`）：
 *   1. `{ type:"item", streamId, value? }` —— 逐项推送业务值；
 *   2. `{ type:"error", streamId, error:{code,message,details} }` —— 终止并报错；
 *   3. `{ type:"end", streamId }` —— **正常终止**。
 *
 * 【事实修正】D2 §8.3 原先记录「正常结束即流结束（无终止帧）」，该记录**已被上游类型声明推翻**：
 *   `end` 帧确实存在。漏处理它不会立刻出错（因为上游随后也会关闭逻辑流），
 *   但会让上层无法区分「Host 主动正常结束」与「连接意外断开」——
 *   前者不该触发重连，后者必须触发。因此这里必须显式处理。
 *
 * 客户端 → `{ type:"open", streamId, endpoint, payload }` / `{ type:"cancel", streamId }`
 *
 * 心跳事实：Host 每 2 s 发 Ping 控制帧，若在下一周期前未收到 Pong 会**主动断开**。
 * ArkTS 侧对策（本项目决策，写入 D2）：显式开启客户端心跳
 *   `pingInterval=5000ms, pongTimeout=4000ms`
 * 使链路上持续存在**双向**流量，避免中间设备与对端把连接判为静默。
 *
 * 连接纪律：物理连接**空闲也保持**；重连调度由 ReconnectController 拥有，
 * 本类只做「一次物理连接尝试」，不做自主重试（与上游语义一致）。
 */

import { webSocket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { getString, getRecord, parseJson, stringifyJson } from './JsonValue';
import { ProtocolSurface, FALLBACK_SURFACE } from './Surface';
import { StreamSink } from './Types';

/** hilog 域与标签（E81 诊断用） */
const DOMAIN: number = 0x0000;
const TAG: string = 'DSHM-Mux';

/** 一条逻辑流的本地记账 */
interface LogicalStream {
  streamId: string;
  sink: StreamSink;
  /** 流是否已进入终态（避免重复回调） */
  settled: boolean;
}

/** 物理连接状态 */
export enum MuxState {
  CLOSED = 'closed',
  CONNECTING = 'connecting',
  OPEN = 'open'
}

/**
 * 【已废弃的机制，保留此说明以免被重新发明】曾经用一段 6 s 的「活性宽限期」
 * 来判断 `error` 事件之后链路是否真的断了：宽限期内没收到**数据帧**就判死。
 *
 * 这个机制已被**删除**，原因有两条，都由实测得出：
 *
 * 1. `error` 事件本身就不是死亡信号。设备内部探测（`MuxProbe.test.ets`）显示
 *    ArkTS 会在链路健康时抛 `code=200 message=undefined`，且**不伴随 `close`**，
 *    连接存活整个观察窗口。既然 error 不代表断，就不需要围绕它做任何判定。
 *
 * 2. 更糟的是，这个计时器是**连接级**的（一个 mux 一个），而 `session/control`
 *    这类流在空闲时**根本不推数据帧**。于是「`$events` 的 error 启动了计时器 →
 *    `control` 在计时器到点时被一起杀掉」——杀掉的是一条**完全健康**的流。
 *    实测症状：启动后约 3–6 秒出现 `control error carrier/closed`。
 *
 * 现在的判死依据只有 WebSocket 层的 `close` 事件（权威信号）+ 库自身的心跳。
 * **不要把「数据帧静默」当判据**——有些流本来就是静默的。
 */

/**
 * **连接级**存活探活间隔与判死阈值（毫秒）。
 *
 * 【为什么必须有这道探活】实测（D2 §8.7.13）：ArkTS 的 socket 静默失效时
 * **可能不触发 `close`**。于是 `state` 停在 `OPEN`、`isOpen()` 恒真，
 * 上层在死 socket 上开流才会因 `send` 失败而察觉——也就是说
 * **应用没有写操作时根本不知道自己已经掉线**（只读浏览时表现为
 * 「数据不更新」而不是「掉线」，对用户仍是误导）。
 *
 * 【为什么判据是「主动发的应用级探针」而不是「有没有收到数据帧」】
 * 服务端每 2 s 发的是 **WebSocket 协议级 Ping 控制帧**，它**不会**作为
 * `message` 事件交给应用，因此「最近收到数据帧的时刻」在静默期恒为很旧——
 * 用它判死会把**空闲但健康**的连接全部误杀。这正是 §8.7.10 那版中间修法
 * 翻车的原因（用流级/数据帧证据判定连接级健康）。
 *
 * 所以这里主动发一帧并等回帧：**回帧才证明链路双向可用**。
 * 时间参数依据服务端 2 s Ping 的节奏取，给它 3 个周期多一点。
 */
const PROBE_INTERVAL_MS: number = 6000;
/**
 * 探活发出后等待回帧的上限。
 *
 * 【为什么从 8000 放宽到 20000】动因是用户反馈"跑任务时经常看到正在连接"，
 * 且 Windows 端同样出现 ⇒ 与平台无关、由**负载**触发。
 * ⚠️ 当时把"探活超时计时器与收帧回调同一 JS 线程"记为**根因**，**该判断已被推翻**
 * （见 docs/device-validation.md 批次三十七：用户看的是 WebView 里的 host web UI，
 * 而本类所属的 ArkTS 自绘 UI 不可达）。这组参数是"高负载下探活容错"的合理加固，**但不是**该现象的因。
 *
 * 20 秒的依据：服务端每 2s 发一次协议级 Ping，20s = 10 个周期。
 * 放宽不会拖慢真实断线的发现 —— 真实断线由「连续 N 次无回帧」判定
 * （见 `PROBE_FAIL_THRESHOLD`），不靠单次超时；而 socket 真死通常由
 * `close` 事件**立即**上报。
 */
const PROBE_TIMEOUT_MS: number = 20000;
/**
 * 连续多少次探活失败才判连接失效。
 *
 * 【为什么必须 > 1】单次探活超时**不是**断线的充分证据：它可能只是这一轮
 * 恰好被负载推迟、或对端在忙。由此判死会引发"健康的连接被反复重连"，
 * 用户看到的就是"跑任务时一直在重新连接"。
 *
 * 【为什么是 3】服务端 2s 一个 Ping 周期 ⇒ 3 次失败约需 3 个探活周期
 * （≈18s 起）+ 单次 20s 超时 ≈ 最坏约 1 分钟才判死。这一延迟只影响
 * 「`close` 不来且探活也无回帧」的静默失效场景 —— 那种场景下晚一点判死
 * 是可接受的代价，远优于把所有健康连接在负载下反复误杀。
 */
const PROBE_FAIL_THRESHOLD: number = 3;

export class RemoteMux {
  private baseUrl: string;
  private cookieProvider: () => string | undefined;
  /** 上游接口面（路径等事实由兼容面注入，不在本类硬编码） */
  private surface: ProtocolSurface;
  private socket?: webSocket.WebSocket;
  private state: MuxState = MuxState.CLOSED;
  private streams: Map<string, LogicalStream> = new Map<string, LogicalStream>();
  private disposed: boolean = false;
  private openWaiters: Array<(ok: boolean, reason?: string) => void> = [];
  private lastError?: string;
  /**
   * 物理连接失效时的通知回调（由 `Connection` 注册）。
   *
   * 【为什么必须有它】实测（D2 §8.7.13）：socket 静默失效时 `close` **可能不来**，
   * 于是 `RemoteMux` 只能靠自己（探活超时 / send 失败）判定失效。但它把
   * `state` 置为 `CLOSED` 之后，**`Connection` 无从得知**——后者只在需要时
   * 调 `isOpen()`，而诊断页读的是 `Connection` 自己的状态。
   * 结果就是：底层已经判死，界面仍显示「连接 live」。
   * 这条回调把底部事实向上传递，是「静默失效」能被上层看见的唯一通道。
   */
  private onSocketDead?: (reason: string) => void;
  /** 探活计时器（-1 = 未启用） */
  private probeTimer: number = -1;
  /** 已发出探活、正在等待回帧（避免重复发） */
  private probePending: boolean = false;
  /** 探活专用的应答等待者：收到**任何**帧都视为链路活着 */
  private probeWaiter?: () => void;
  /**
   * 连续探活失败次数（收到任何帧即清零）。
   *
   * 【为什么需要它】单次探活超时不是断线的充分证据 —— 跑任务时负载会推迟回帧，
   * 单次超时据此判死，会让**健康连接被反复重连**（用户看到"跑任务时经常显示
   * 正在连接"，Windows 端同样出现）。只有**连续**失败才构成判死依据。
   */
  private probeFailCount: number = 0;

  constructor(baseUrl: string, cookieProvider: () => string | undefined,
    surface: ProtocolSurface = FALLBACK_SURFACE) {
    this.baseUrl = baseUrl;
    this.cookieProvider = cookieProvider;
    this.surface = surface;
  }

  getState(): MuxState {
    return this.state;
  }

  getLastError(): string | undefined {
    return this.lastError;
  }

  /** 当前活动逻辑流数（诊断用） */
  activeStreamCount(): number {
    return this.streams.size;
  }

  /** 是否已就绪（可开流） */
  isOpen(): boolean {
    return this.state === MuxState.OPEN && !this.disposed;
  }

  /** 注册「物理连接失效」的回调（见 `onSocketDead` 字段的说明） */
  setOnSocketDead(handler: (reason: string) => void): void {
    this.onSocketDead = handler;
  }

  /**
   * 执行一次物理连接尝试。成功返回 true。
   * 若已有开启的连接，直接返回 true（幂等）。
   */
  async connectOnce(timeoutMs: number): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    if (this.state === MuxState.OPEN) {
      return true;
    }
    if (this.state === MuxState.CONNECTING) {
      return await this.waitForOpen(timeoutMs);
    }

    const socket: webSocket.WebSocket = webSocket.createWebSocket();
    this.socket = socket;
    this.state = MuxState.CONNECTING;
    this.lastError = undefined;

    socket.on('message', (err: BusinessError, data: string | ArrayBuffer) => {
      if (err !== undefined && err !== null && err.code !== 0) {
        return;
      }
      // 收到帧 = 链路活着的**证据**：撤销 error 记录，并让探活成功
      this.clearLivenessGrace();
      this.settleProbe();
      if (typeof data === 'string') {
        this.handleFrame(data as string);
      }
    });
    socket.on('close', (err: BusinessError, value: webSocket.CloseResult) => {
      const code: number = value === undefined || value === null ? 0 : value.code;
      const reason: string = value === undefined || value === null ? '' : (value.reason ?? '');
      this.onSocketClosed(`close code=${code}${reason.length > 0 ? ` reason=${reason}` : ''}${err !== undefined && err !== null && err.code !== 0 ? ` err=${err.code}` : ''}`);
    });
    socket.on('error', (err: BusinessError) => {
      // 【`error` 事件不是「连接已断」——这是本文件最重要的一条实测结论】
      //
      // 设备内部探测（`entry/src/ohosTest/ets/test/MuxProbe.test.ets`，
      // 连同一个 mux 地址）给出的读数：
      //   - 升级成功（`connected=true`）；
      //   - 窗口内**从未收到 `close` 事件**（`closed=false`、`closedAt=-1ms`）；
      //   - `error` 在 **73–216 ms** 到达，内容恒为 `code=200 message=undefined`；
      //   - 连接**存活整个 8 s 观察窗口**；有无客户端心跳配置表现一致。
      // 也就是说：ArkTS 会在链路健康时抛这个 error。
      //
      // 旧实现一见 error 就 `onSocketClosed()`，后果：
      //   - 全部逻辑流被以 `carrier/closed` 终止（症状＝「open 后几十毫秒就 closed」）；
      //   - 上层以为「连接失效」，而物理链路其实是好的；
      //   - 错误文案把排查方向指向「载体/转发通道断了」——本项目因此长期记着一个
      //     **错结论**（已在 D4 明确推翻）。
      //
      // 所以这里只**记下错误**（供诊断页展示），不据此终止任何流。
      // 判死交给 `close` 事件（WebSocket 层的权威信号）+ 库自身的心跳。
      //
      // 【为什么**不**在这里主动关闭 socket】
      // 一度想「既然 close 可能不来，那就主动关掉它」。但实测反对这个做法：
      // 同一个手工客户端在这次 error 之后**仍然正常工作**——它收到了 `ready`、
      // 也收到了后续的 `api-session/added`（见 D2 §8.7.11/§8.7.12）。
      // 也就是说这条 error 之后 socket 往往**仍可用**；一见 error 就关，
      // 会把一条能用的连接反复掐断，制造出「一直重连」的抖动。
      //
      // 因此这里只记录。真正的收尾放在**确实发不出去**的地方：
      // `open()` 里 `socket.send()` 的失败会调用 `onSocketClosed()`
      // （见那里的说明），那时「连接不可用」是**已经被证实的事实**，而不是推测。
      this.lastError = `ws error code=${err.code} message=${err.message}`;
    });

    const header: Record<string, string> = {};
    const cookie: string | undefined = this.cookieProvider();
    if (cookie !== undefined) {
      header['cookie'] = cookie;
    }
    /*
     * 【Origin：真机读数与真相（E81）】
     * dsh 的 `/api` 前面是 browser-trust fence：**带了 `Origin` 就必须与 `Host` 同源**，
     * 否则 403（`isTrustedApiRequest`，`dsh-client-connection/lib/index.js`）。
     *
     * 端侧两侧原始读数（服务端 `IN-UPGRADE` + 客户端 `DSHM-MUX`，同一次握手）：
     *   DSHM-MUX     connect url=ws://127.0.0.1:3120/api/remote.mux
     *                headerKeys=cookie,origin cookieLen=224
     *   IN-UPGRADE   GET /api/remote.mux conn=Upgrade upgrade=websocket key=yes ver=13
     *                cookie=224B origin=http://127.0.0.1, ws://127.0.0.1:3120
     *
     * 两条结论，都是"看到线上值"才能得出的事实：
     *   1. **libwebsockets 一定会自己附 `Origin`**，并且它按 URL 推导时**丢掉端口**
     *      （`ws://127.0.0.1:3120` → `Origin: http://127.0.0.1`）。所以"原生客户端不带
     *      Origin"这个早先的判断是错的——它一直带着，只是带错了形态。
     *   2. `WebSocketRequestOptions.header` 里的 `origin` 是**追加**而不是替换，
     *      于是线上成为逗号列表。fence 按整串解析 ⇒ 永远不等 ⇒ **每一次升级都 403**。
     *      客户端把这个失败报成 `error code=200`，长期把人误导到"链路是好的"上。
     *
     * 修法分两侧，缺一不可：
     *   - 宿主侧（`tools/pack-core.mjs` 的 `allowOriginList()`）：接受逗号分隔的
     *     Origin 列表，**任一项**同源即通过（跨源项一律不认，语义不变）；
     *   - 本处：注入的 Origin 用 **http(s) 形态**（浏览器发 WS 升级时 `Origin` 就是
     *     http(s) 源，不是 `ws:`），让列表里至少有一项是语义正确的同源值。
     * 回归检查：`node tools/check-origin-fence.mjs`（本地无设备，含正/反控制组）。
     */
    if (this.baseUrl.startsWith('wss://')) {
      header['origin'] = `https://${this.baseUrl.substring('wss://'.length)}`;
    } else if (this.baseUrl.startsWith('ws://')) {
      header['origin'] = `http://${this.baseUrl.substring('ws://'.length)}`;
    }
    /**
     * 连接选项：**刻意不设客户端心跳**。
     *
     * 【为什么把 `pingInterval: 5000, pongTimeout: 4000` 去掉】
     *   实测（`.research/protocol/probe-probe-harm.mjs`，对真实 Host）：
     *     - 客户端**回 Pong** → 连接在 15 s 观察窗内保持；
     *     - 客户端**不回 Pong** → 服务端在 **5.4 s** 关闭连接。
     *   即：**服务端的心跳是硬要求**（每 2 s 发 Ping，漏两次就 terminate）。
     *   而带这两个选项时，设备上稳定复现「连上约 6 秒后 `control error carrier/closed`、
     *   下一次 `send()` 以 `code=-1` 失败」——且**换到不经 hdc 的稳定通道
     *   （`10.0.2.2:3115`，slirp 直连）后症状完全相同**，因此根因在客户端而不在转发通道
     *   （这条推翻了 D2 §8.7.15 把责任归给 `hdc rport` 的结论）。
     *   最可能的是这两个选项让库把「没在 pongTimeout 内收到**数据帧**」当成失活
     *   （`session/control` 空闲时本来就不推数据帧），于是它自己把健康的连接关掉。
     *   先做这个最小改动验证；若仍失效，再考虑「应用级保活帧」或库层替代方案。
     */
    const options: webSocket.WebSocketRequestOptions = {
      header: header
    };

    /*
     * 【诊断（E81）】把**实际发出的** WS 地址与头打进 hilog。
     *
     * 为什么要打：端侧只报「升级响应不是 101、状态码 200」，这个二手结论无法区分
     * 三种完全不同的原因——路径不对 / 升级头没发出去 / 升级头与路径都对但 cookie 没带上。
     * 服务端侧同一时刻的原始读数（Host 的 IN-UPGRADE / IN-REQ）与本行按时间戳对齐即可定案。
     * 打的是 `target`，也是下面真正用来 connect 的同一个值，避免"日志与行为不一致"。
     */
    const target: string = `${this.baseUrl}${this.surface.muxPath}`;
    hilog.info(DOMAIN, TAG,
      'DSHM-MUX connect url=%{public}s headerKeys=%{public}s cookieLen=%{public}d',
      target, Object.keys(header).join(','), cookie === undefined ? 0 : cookie.length);

    try {
      const opened: boolean = await socket.connect(target, options);
      if (!opened) {
        // 【诊断（E65）】WS 升级被 fence 拒 403 时，必须能区分"cookie 是空的"与
        // "cookie 有值但没被发出去（ArkTS webSocket.connect 是否转发自定义 header）"。
        // 不引入新导入：把结论并进 lastError，它会经 SessionHub.lastError 显示到
        // `DSHM-AUTH connect 结果 … err=` 上。
        this.lastError = `ws connect 返回 false（cookie=${cookie === undefined ? '无' : `${cookie.length}B`}）`;
        this.state = MuxState.CLOSED;
        this.resolveOpenWaiters(false, this.lastError);
        return false;
      }
      this.state = MuxState.OPEN;
      this.resolveOpenWaiters(true);
      this.startLivenessProbe();
      return true;
    } catch (error) {
      const businessError: BusinessError = error as BusinessError;
      this.lastError = `ws connect 失败 code=${businessError.code} message=${businessError.message}`
        + `（cookie=${cookie === undefined ? '无' : `${cookie.length}B`}）`;
      this.state = MuxState.CLOSED;
      this.resolveOpenWaiters(false, this.lastError);
      return false;
    }
  }

  private waitForOpen(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer: number = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
      this.openWaiters.push((ok: boolean, reason?: string) => {
        clearTimeout(timer);
        resolve(ok);
      });
    });
  }

  private resolveOpenWaiters(ok: boolean, reason?: string): void {
    const waiters = this.openWaiters;
    this.openWaiters = [];
    for (let i = 0; i < waiters.length; i++) {
      waiters[i](ok, reason);
    }
  }

  /**
   * 收到 `error` 后给链路的**宽限期**（毫秒）。
   *
   * 取值依据：服务端每 2 s 发一次 Ping（见文件头心跳事实），
   * 因此 6 s 内至少应有一个周期到达。取 6 s 是为了在
   * 「真断了要尽快恢复」与「不要被一个含糊事件误判」之间折中。
   */
  // 常量在文件末尾声明（ArkTS 要求先声明后用，这里用类静态字段规避顺序问题）

  /**
   * 启动**连接级**探活。
   *
   * 每次探活发一个上游必然应答的最小请求（`session/list`，带唯一 cursor），
   * 并等**任何**回帧：
   *   - 收到帧 → 链路双向可用，桥接等待者让它立刻返回；
   *   - `PROBE_TIMEOUT_MS` 内没有帧 → 判为静默失效，主动收尾并让重连介入。
   *
   * 【探活帧不带任何额外字段】这一点是踩坑换来的，详见 `probeOnce` 内注释：
   * 曾给探针加过唯一 `cursor` 以便在旁路日志里辨认，而 `settings/describe`
   * 不接受任何实参 ⇒ 服务端回 `type:"error"`，被当作**该流终结**处理，
   * 反而把**健康连接判死**。故探活帧只用空实参。
   */
  private startLivenessProbe(): void {
    this.stopLivenessProbe();
    // 兜底 surface 的 `probeEndpoint` 是空串（= 未注入真实接口面）。
    // 此时**明确不探活**并留下一条 trace：含糊地「探了但用假端点」会让
    // 装配漏注入的构建把缺陷藏在「一切正常」的外表下。
    if (this.surface.probeEndpoint.length === 0) {
      // 兜底 surface 的 `probeEndpoint` 是空串（= 未注入真实接口面）。
      // 此时**明确不探活**：含糊地「探了但用假端点」会让装配漏注入的构建
      // 把缺陷藏在「一切正常」的外表下。本类刻意不持日志通道，因此
      // 「没探活」只能由诊断页的探活计数反映——那也正是它该被记的地方。
      return;
    }
    // 新的一轮探活 = 新的连接 ⇒ 连续失败计数必须从零开始，
    // 否则上一轮（或上一次连接）的失败会累积进来，让新连接很快被判死。
    this.probeFailCount = 0;
    this.probeTimer = setInterval(() => {
      this.probeOnce();
    }, PROBE_INTERVAL_MS);
  }

  private stopLivenessProbe(): void {
    if (this.probeTimer !== -1) {
      clearInterval(this.probeTimer);
      this.probeTimer = -1;
    }
    this.probePending = false;
    this.probeWaiter = undefined;
    this.probeFailCount = 0;
  }

  /** 发一次探活并设超时 */
  private probeOnce(): void {
    if (this.state !== MuxState.OPEN || this.probePending) {
      // 上一发还没回来就跳过这一轮，而不是叠加发送
      return;
    }
    const socket: webSocket.WebSocket | undefined = this.socket;
    if (socket === undefined) {
      return;
    }
    this.probePending = true;
    // 【探活帧必须用**合法**实参——这里踩过一个很隐蔽的坑】
    // 初版为了让探针在旁路日志里可辨认，给它塞了一个唯一 `cursor`。
    // 但 `settings/describe` **不接受任何实参**，服务端回：
    //   `gateway/arguments-invalid: unexpected "cursor"`
    // 而那一帧是 `type:"error"`，被 `handleFrame` 当作**这条流的终结**处理
    // → 探活反而把**健康的连接**判死（症状与「socket 静默失效」几乎一样，
    //   查错方向会完全跑偏）。
    //
    // 所以：探活帧只能用该端点**本来就接受**的实参（`settings/describe` 是空对象）。
    // 代价是旁路日志里辨认不出探针——但那条日志并非必需：
    // 连接状态变化（`connection degraded/disconnected`）已经落进 trace。
    const emptyArgs: Record<string, Object> = {};
    const probePayload: Record<string, Object> = {};
    probePayload['args'] = emptyArgs as Object;
    const frame: Record<string, Object> = {
      'type': 'open',
      'streamId': `probe-${randomId()}`,
      'endpoint': this.surface.probeEndpoint,
      'payload': probePayload as Object
    };
    const text: string | undefined = stringifyJson(frame as Object);
    if (text === undefined) {
      this.probePending = false;
      return;
    }
    const settled: Promise<void> = new Promise<void>((resolve) => {
      this.probeWaiter = resolve;
    });
    socket.send(text).catch((error: BusinessError) => {
      // 发送失败也**不是立即判死**的充分证据（负载下可能瞬时失败），
      // 与超时同样计入连续失败；真断线仍由 `close` 事件或连续 N 次失败兜住。
      this.probeWaiter = undefined;
      this.probePending = false;
      this.noteProbeFailure(`探活发送失败 code=${error.code}`);
    });
    const timer: number = setTimeout(() => {
      // 超时未收到任何回帧 ⇒ **记一次失败**，而不是立刻判死。
      // 早期实现在这里直接 `onSocketClosed(...)`，于是跑任务时（回帧被负载推迟）
      // 健康的连接被反复误判为断线 → 触发重连 → 界面闪「正在连接」。
      this.probeWaiter = undefined;
      this.probePending = false;
      this.noteProbeFailure('探活超时（连接级）：在阈值内未收到任何回帧');
    }, PROBE_TIMEOUT_MS);
    settled.then(() => {
      clearTimeout(timer);
    });
  }

  /**
   * 记一次探活失败；只有**连续**失败达到阈值才判连接失效。
   *
   * 【为什么必须计数而不是单次判死】见 `PROBE_FAIL_THRESHOLD` 的说明：
   * 探活计时器与收帧回调跑在同一个 JS 线程上，跑任务时回帧被推迟，
   * 单次超时不足以证明断线 —— 据此判死会让健康连接被反复重连。
   */
  private noteProbeFailure(reason: string): void {
    this.probeFailCount += 1;
    if (this.probeFailCount < PROBE_FAIL_THRESHOLD) {
      // 未达阈值：只记数、不断开。连接语义仍是「活着但有疑问」，
      // 下一轮探活会再试一次；期间若有任何帧到达会清零（见 `settleProbe`）。
      return;
    }
    this.onSocketClosed(`${reason}（连续 ${this.probeFailCount} 次探活无回帧）`);
  }

  /** 收到任何帧：探活成功 */
  private settleProbe(): void {
    this.probePending = false;
    // 收到任何帧即证明链路双向可用 ⇒ 连续失败计数清零（这是"负载延迟"与"真断线"的分界）
    this.probeFailCount = 0;
    const waiter: (() => void) | undefined = this.probeWaiter;
    this.probeWaiter = undefined;
    if (waiter !== undefined) {
      waiter();
    }
  }

  /** 收到任何服务端帧：清掉上一次的 error 记录（链路已被证明是活的） */
  private clearLivenessGrace(): void {
    if (this.lastError !== undefined) {
      this.lastError = undefined;
    }
  }

  /**
   * 物理连接关闭：终止全部逻辑流并让上层（ReconnectController）看到失效
   *
   * 【只有两个调用点，都代表**连接确实断了**】
   *   1. `socket.on('close')` —— WebSocket 层给出的权威信号；
   *   2. `clientClose()` —— 我们自己主动关闭。
   *
   * 【为什么不把 `error` 事件也接进来】实测：ArkTS 会在链路**健康**时抛
   * `code=200 message=undefined`，而且**不伴随 `close`**（设备内部探测，
   * `MuxProbe.test.ets`：`closed=false`、`closedAt=-1ms`，连接存活整个观察窗口）。
   * 把它当死亡通知会杀掉健康的流，并让错误文案指向「载体断了」这个错误方向。
   *
   * 【那「真断了但没有 close 事件」怎么办】由**库自身的心跳**负责：
   * 服务端每 2 s 发 Ping，客户端在 `pongTimeout` 内未回 Pong 时库会关闭连接并
   * 触发 `close`。判死因此落在「一个权威的关闭信号」上，而不是一个含义含糊的事件。
   * 若将来实测发现库在无响应时不关，再在这里补一条**连接级**的超时——
   * 但不能再用「数据帧静默」当判据：`session/control` 空闲时就是不推帧。
   */
  private onSocketClosed(reason: string): void {
    if (this.state === MuxState.CLOSED) {
      return;
    }
    this.state = MuxState.CLOSED;
    // 连接已死：停掉探活，否则计时器会在 CLOSED 之后继续跑并重复收尾
    this.stopLivenessProbe();
    // 把「底层已判死」这件事**向上传递**，否则上层会一直以为自己是 live
    const notify: ((reason: string) => void) | undefined = this.onSocketDead;
    if (notify !== undefined) {
      notify(reason);
    }
    this.resolveOpenWaiters(false, reason);
    const ids: string[] = [];
    this.streams.forEach((_value: LogicalStream, key: string) => {
      ids.push(key);
    });
    for (let i = 0; i < ids.length; i++) {
      const stream: LogicalStream | undefined = this.streams.get(ids[i]);
      if (stream !== undefined) {
        this.streams.delete(ids[i]);
        if (!stream.settled) {
          stream.settled = true;
          stream.sink.onError('carrier/closed', reason);
        }
      }
    }
  }

  /** 处理一条服务端帧 */
  private handleFrame(text: string): void {
    const frame: Object | undefined = parseJson(text);
    if (frame === undefined) {
      return;
    }
    const streamId: string | undefined = getString(frame, 'streamId');
    if (streamId === undefined) {
      return;
    }
    const stream: LogicalStream | undefined = this.streams.get(streamId);
    if (stream === undefined) {
      return;
    }
    const type: string | undefined = getString(frame, 'type');
    if (type === 'item') {
      const value: Object | undefined = getRecord(frame, 'value');
      if (value !== undefined) {
        stream.sink.onItem(value);
      }
      return;
    }
    if (type === 'error') {
      this.streams.delete(streamId);
      stream.settled = true;
      const error: Object | undefined = getRecord(frame, 'error');
      // 【命名修正】原先这里用 `gateway/internal` 作兜底码——那是**我们自造的**，
      // 不是上游的码（上游的 `gateway/*` 是一组明确的边界错误，见 D2）。
      // 用自己的码冒充上游命名空间会带来两个问题：一是架构门禁无法区分
      // 「上游事实」与「我们的兜底」（正是它把此处报成违规的原因），
      // 二是排查时会把「我们的解析兜底」误读成「Host 报了一个网关错误」。
      // 语义上这确实是**信封解析**问题（错误对象读不出 code），故归入 carrier/parse。
      const code: string = error === undefined ? 'carrier/parse' : (getString(error, 'code') ?? 'carrier/parse');
      const message: string = error === undefined ? 'stream error' : (getString(error, 'message') ?? 'stream error');
      stream.sink.onError(code, message);
      return;
    }
    if (type === 'end') {
      // 正常终止：与 error 区分开，上层据此**不**触发重连（见文件头「事实修正」）
      this.streams.delete(streamId);
      stream.settled = true;
      stream.sink.onEnd();
      return;
    }
    // 未知帧类型：忽略（前向兼容）
  }

  /**
   * 打开一条逻辑流。
   * @returns streamId；未连接时返回 undefined（调用方应先 await connectOnce）
   */
  open(endpoint: string, payloadJson: string, sink: StreamSink): string | undefined {
    if (!this.isOpen()) {
      return undefined;
    }
    const socket: webSocket.WebSocket | undefined = this.socket;
    if (socket === undefined) {
      return undefined;
    }
    const streamId: string = randomId();
    this.streams.set(streamId, { streamId: streamId, sink: sink, settled: false });
    const payload: Object | undefined = parseJson(payloadJson);
    const frame: Record<string, Object> = {
      'type': 'open',
      'streamId': streamId,
      'endpoint': endpoint,
      'payload': payload ?? (parseJson(this.surface.eventsPayloadJson) as Object)
    };
    const text: string | undefined = stringifyJson(frame as Object);
    if (text === undefined) {
      this.streams.delete(streamId);
      return undefined;
    }
    socket.send(text).catch((error: BusinessError) => {
      const stream: LogicalStream | undefined = this.streams.get(streamId);
      this.streams.delete(streamId);
      if (stream !== undefined && !stream.settled) {
        stream.settled = true;
        stream.sink.onError('carrier/transport', `send 失败 code=${error.code}`);
      }
      // 【发送失败必须让连接失效，否则会「一直失败下去」】
      // 实测症状：`follow open` 后立刻 `follow error carrier/transport send 失败 code=-1`，
      // 而诊断页显示「连接 live」——因为 `open()` 是**同步返回 streamId**、
      // 失败发生在异步的 `send()` 里，**状态没有被改动**。
      // 于是 `isOpen()` 继续为真，上层每次重试都在同一个死 socket 上发帧，
      // 每次都失败，形成「看起来已连接、实际什么都发不出去」的死循环。
      // 这里把失败升级为连接失效：终止全部逻辑流并让重连控制器介入。
      this.onSocketClosed(`send 失败 code=${error.code}`);
    });
    return streamId;
  }

  /** 主动取消一条逻辑流（对应上游 finally 里的 cancel 帧） */
  cancel(streamId: string): void {
    const stream: LogicalStream | undefined = this.streams.get(streamId);
    if (stream === undefined) {
      return;
    }
    this.streams.delete(streamId);
    stream.settled = true;
    const socket: webSocket.WebSocket | undefined = this.socket;
    if (socket !== undefined && this.state === MuxState.OPEN) {
      const frame: Record<string, Object> = { 'type': 'cancel', 'streamId': streamId };
      const text: string | undefined = stringifyJson(frame as Object);
      if (text !== undefined) {
        socket.send(text).catch((_error: BusinessError) => {
          // 取消失败无副作用：连接已被上层视为失效
        });
      }
    }
    stream.sink.onEnd();
  }

  /** 关闭物理连接（永久） */
  async close(): Promise<void> {
    this.disposed = true;
    const socket: webSocket.WebSocket | undefined = this.socket;
    this.socket = undefined;
    this.onSocketClosed('client closed');
    if (socket !== undefined) {
      try {
        await socket.close();
      } catch (error) {
        // 忽略关闭异常
      }
    }
  }
}

/** 生成 streamId（无外部依赖的随机标识） */
function randomId(): string {
  const hex: string = '0123456789abcdef';
  let out: string = '';
  for (let i = 0; i < 32; i++) {
    out += hex.charAt(Math.floor(Math.random() * 16));
  }
  return `${out.substring(0, 8)}-${out.substring(8, 12)}-${out.substring(12, 16)}-${out.substring(16, 20)}-${out.substring(20)}`;
}
