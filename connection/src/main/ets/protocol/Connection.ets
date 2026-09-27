/**
 * 连接门面（Connection）：把协议兼容层组装成一个可被 UI/状态层直接使用的对象。
 *
 * 职责边界：
 *   - 拥有 cookie jar、认证会话、HTTP 载体、mux、事件流、重连调度；
 *   - 对外只暴露：configure / authenticate / start / stop / reconnect / call / openStream / 诊断；
 *   - **不**做业务投影（会话状态由上层投影），**不**持有 UI 引用（D1 §6.3 分层铁律）。
 */

import {
  HostAddress,
  ParsedTarget,
  parseTarget
} from './HostAddress';
import { ProtocolSurface, FALLBACK_SURFACE } from './Surface';
import { CookieJar } from './Cookies';
import { HttpClient, HttpOutcome } from './HttpClient';
import { AuthOutcome, AuthSession, isAuthFailureStatus } from './AuthSession';
import { RemoteMux } from './RemoteMux';
import { EventStream, EventStreamPhase } from './EventStream';
import { ReconnectController } from './Backoff';
import { stringifyJson } from './JsonValue';
import {
  API_CHANNEL,
  checkTarget,
  CLIENT_FAILURE_CODE,
  RemoteFailure,
  rpcFail,
  RpcResult
} from './RpcTypes';
import { parseConnectionResponse } from './Envelope';
import {
  CallOptions,
  ConnectionState,
  CookieRecord,
  DiagnosticItem,
  DiagnosticReport,
  EventSink,
  HostConfig,
  StreamSink
} from './Types';

/** 连接参数 */
export interface ConnectionOptions {
  /** 一元调用默认超时（毫秒） */
  defaultTimeoutMs?: number;
  /** mux 单次连接尝试超时（毫秒） */
  muxConnectTimeoutMs?: number;
  /**
   * 上游接口面。装配时应由兼容面（dshcompat）显式注入；
   * 缺省为 FALLBACK_SURFACE，仅用于测试与安全退化（生产路径漏注入会在诊断页暴露）。
   */
  surface?: ProtocolSurface;
}

const DEFAULT_TIMEOUT_MS: number = 30000;
const DEFAULT_MUX_TIMEOUT_MS: number = 10000;

/** cookie 持久化钩子（实现方负责加密存储，D1 §11.5 S3） */
export interface CookiePersistence {
  load(): string | undefined;
  save(serialized: string): void;
  clear(): void;
}

/** 随机 UUID（RFC 4122 v4，避免额外依赖） */
export function randomUuid(): string {
  const hex: string = '0123456789abcdef';
  let out: string = '';
  for (let i = 0; i < 32; i++) {
    out += hex.charAt(Math.floor(Math.random() * 16));
  }
  return `${out.substring(0, 8)}-${out.substring(8, 12)}-4${out.substring(13, 16)}`
    + `-a${out.substring(17, 20)}-${out.substring(20)}`;
}

/**
 * 档位表用尽后的固定重连节奏（毫秒）。
 *
 * 取 2 s 的理由：设备侧长连接的实际寿命约 5 s（见 `scheduleReconnect` 的说明），
 * 因此重连必须比它更快才有意义——2 s 让"可用窗口"占空比约 70%。
 * 若 Host 是真下线，则每 2 s 一次的无害重试（一次 WS 升级尝试）成本可以接受。
 */
const PERSISTENT_RETRY_MS: number = 2000;

export class Connection {
  private options: Required<ConnectionOptions>;
  private surface: ProtocolSurface;
  private jar: CookieJar = new CookieJar();
  private http: HttpClient;
  private mux?: RemoteMux;
  private eventStream?: EventStream;
  private auth?: AuthSession;
  private address?: HostAddress;
  private config?: HostConfig;
  private reconnector: ReconnectController = new ReconnectController();
  private state: ConnectionState = ConnectionState.IDLE;
  private lastError?: string;
  private persistence?: CookiePersistence;
  private stateListeners: Array<(state: ConnectionState, detail: string) => void> = [];
  /**
   * `start()` 时记下的事件流回调。
   *
   * 为什么必须留着：底层判定连接失效（`handleMuxDead`）之后要**驱动重连**，
   * 而 `scheduleReconnect(sink)` 需要这个 sink。不存的话，
   * 连接失效后**没有任何人再次进入重连循环**——实测症状就是
   * 「探活发现失效了，但连接一直不恢复」（D4 待收口第 1 项）。
   */
  private startSink?: EventSink;

  constructor(options?: ConnectionOptions) {
    const merged: Required<ConnectionOptions> = {
      defaultTimeoutMs: options?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      muxConnectTimeoutMs: options?.muxConnectTimeoutMs ?? DEFAULT_MUX_TIMEOUT_MS,
      surface: options?.surface ?? FALLBACK_SURFACE
    };
    this.options = merged;
    this.surface = merged.surface;
    this.http = new HttpClient(this.jar);
  }

  /** 当前使用的上游接口面（诊断用：能立刻看出是否漏注入） */
  getSurface(): ProtocolSurface {
    return this.surface;
  }

  // ─────────────────────────── 配置与状态 ───────────────────────────

  getState(): ConnectionState {
    return this.state;
  }

  getLastError(): string | undefined {
    return this.lastError;
  }

  getConfig(): HostConfig | undefined {
    return this.config;
  }

  /** 事件流阶段（诊断与 UI 展示） */
  getEventPhase(): EventStreamPhase {
    return this.eventStream?.getPhase() ?? EventStreamPhase.IDLE;
  }

  /** Host 事实（ready 首项之后可用） */
  getHostFactsClientId(): string | undefined {
    return this.eventStream?.getFacts()?.clientId;
  }

  getHostHome(): string | undefined {
    return this.eventStream?.getFacts()?.home;
  }

  onStateChange(listener: (state: ConnectionState, detail: string) => void): void {
    this.stateListeners.push(listener);
  }

  private setState(state: ConnectionState, detail: string): void {
    this.state = state;
    if (state === ConnectionState.DISCONNECTED) {
      this.lastError = detail;
    }
    for (let i = 0; i < this.stateListeners.length; i++) {
      this.stateListeners[i](state, detail);
    }
  }

  /**
   * 底层物理连接失效时的收尾。
   *
   * 【做三件事】记下原因、把状态降级、并把事件流标记为失效
   * （物理连接没了，事件流不可能还活着——不标记的话诊断页会显示
   * 「事件流 live」，而那与事实相反）。
   *
   * **不做**重连本身：重连策略集中在 `ReconnectController`，
   * 这里再开一条重连路径会与它打架。
   *
   * 这条链路存在的理由见 `setOnSocketDead` 的注册处：socket 静默失效时
   * `close` 可能不来，此前 `Connection` 会一直停在 CONNECTED，
   * 诊断页因此显示「连接 live」而底层早已判死（D2 §8.7.13）。
   */
  private handleMuxDead(reason: string): void {
    this.lastError = reason;
    // 【可观测性】不在这里写日志：`connection` 层没有 trace 通道（那是 appstate 的），
    // 而 `lastError` 会被上层 `SessionHub` 读进快照、显示在横幅与诊断页上——
    // 那正是判断「底层判死有没有传到上层」的直接证据。
    // 【实测时要看的判据】横幅/诊断页是否出现本行的 `reason`
    // （例如 `探活发送失败 code=-1`）：
    //   - 出现 → 上报链通，问题在「谁来重连」；
    //   - 没出现 → 回调没被调用，问题在 RemoteMux 的判定或注册。
    // 不加这条可观测路径就只能靠「界面显示对不对」间接推断，而那个推断本轮已错过一次。
    const stream: EventStream | undefined = this.eventStream;
    if (stream !== undefined) {
      stream.markLost();
    }
    // 用 CONNECTING 而不是 DISCONNECTED：**重连即将开始**，这条连接的语义是
    // 「正在（重新）建立」而不是「已放弃」。DISCONNECTED 的文案是
    // 「重试耗尽或凭证失效，需人工干预」——那是另一种结论，这里用它会误导用户
    // 去手工处理一个正在自动恢复的问题。
    this.setState(ConnectionState.CONNECTING, `连接失效，正在重连：${reason}`);
    // 【关键：驱动重连】此前这里只改状态、不驱动重连，于是「探活能发现失效、
    // 但连接永远不恢复」。重连策略仍集中在 `ReconnectController`——
    // 这里只是**重新进入**那个循环，不自己实现退避。
    const sink: EventSink | undefined = this.startSink;
    if (sink !== undefined) {
      this.scheduleReconnect(sink);
    }
  }

  /** 注入 cookie 持久化实现并立即恢复已保存的 cookie */
  attachPersistence(persistence: CookiePersistence): void {
    this.persistence = persistence;
    const serialized: string | undefined = persistence.load();
    if (serialized !== undefined && serialized.length > 0) {
      this.jar.replaceAll(deserializeCookies(serialized));
    }
  }

  /**
   * 解析并设置目标地址（不发起网络请求）。
   * 接受 `host:port` / `http://host:port` / 带 `?token=` 的启动 URL。
   */
  configure(input: string, name?: string): HostConfig | undefined {
    const target: ParsedTarget | undefined = parseTarget(input);
    if (target === undefined) {
      this.lastError = `无法解析地址：${input}`;
      return undefined;
    }
    const address: HostAddress = target.address;
    this.address = address;
    this.pendingToken = target.token;
    this.auth = new AuthSession(this.jar, this.http, address);
    this.auth.setToken(target.token);
    const config: HostConfig = {
      name: name ?? address.authority,
      authority: address.authority,
      hostname: address.hostname,
      port: address.port,
      scheme: address.scheme,
      baseUrl: address.baseUrl,
      wsBaseUrl: address.wsBaseUrl,
      isLoopback: address.isLoopback
    };
    this.config = config;
    return config;
  }

  /** 当前是否已配置 */
  isConfigured(): boolean {
    return this.address !== undefined;
  }

  // ─────────────────────────── 认证 ───────────────────────────

  /** 是否已持有可用 cookie */
  hasSession(): boolean {
    return this.auth?.hasCookie() ?? false;
  }

  /** 用 token 交换签名 cookie（配置必须已完成） */
  async authenticate(token?: string): Promise<AuthOutcome> {
    const session: AuthSession | undefined = this.auth;
    if (session === undefined) {
      return { ok: false, status: 0, reason: '未配置 Host 地址' };
    }
    const effective: string = token ?? this.pendingToken ?? '';
    if (effective.length === 0) {
      return {
        ok: false,
        status: 0,
        reason: '未提供 token',
        advice: '粘贴 Host 的启动 URL（形如 http://127.0.0.1:3000/?token=xxxx），或单独填写 token。'
      };
    }
    const outcome: AuthOutcome = await session.exchange(effective);
    if (outcome.ok) {
      this.persistCookies();
    }
    return outcome;
  }

  /** 重新绑定认证（cookie 失效时） */
  async rebind(): Promise<AuthOutcome> {
    const session: AuthSession | undefined = this.auth;
    if (session === undefined) {
      return { ok: false, status: 0, reason: '未配置 Host 地址' };
    }
    const outcome: AuthOutcome = await session.rebind();
    if (outcome.ok) {
      this.persistCookies();
    }
    return outcome;
  }

  /** 最近一次 configure 中解析出的 token（用于自动重绑） */
  private pendingToken?: string;

  // ─────────────────────────── 生命周期 ───────────────────────────

  /**
   * 建立连接：一次 mux 物理连接尝试 + 打开事件流。
   * 首次握手由调用方在 authenticate() 之后调用。失败时不自动重试（由 start 负责调度）。
   */
  async connectOnce(): Promise<boolean> {
    const address: HostAddress | undefined = this.address;
    if (address === undefined) {
      this.lastError = '未配置 Host 地址';
      return false;
    }
    // 【唯一的 mux 创建点】`getMux()` 同时负责注册失效回调，见其说明。
    const mux: RemoteMux = this.getMux();
    this.setState(ConnectionState.CONNECTING, '正在连接…');
    const opened: boolean = await mux.connectOnce(this.options.muxConnectTimeoutMs);
    if (!opened) {
      this.lastError = mux.getLastError() ?? 'WebSocket 连接失败';
      return false;
    }
    return true;
  }

  /**
   * 启动连接循环：建立连接 + 打开事件流，失败按 D2 §3 退避重试。
   * @param sink 事件流回调
   */
  async start(sink: EventSink): Promise<boolean> {
    this.startSink = sink;
    this.reconnector.reset();
    this.bindEventStream(sink);
    const ok: boolean = await this.connectOnce();
    if (!ok) {
      this.scheduleReconnect(sink);
      return false;
    }
    const stream: EventStream | undefined = this.eventStream;
    const streamOk: boolean = stream === undefined ? false : stream.open();
    if (!streamOk) {
      this.scheduleReconnect(sink);
      return false;
    }
    return true;
  }

  /**
   * 把事件流绑到**当前**的 mux 上（`start()` 与每次重连都要调用）。
   *
   * 【为什么必须每次重连都重建，而不是复用同一个 `EventStream`】
   *   `EventStream` 在**构造时**就把 `RemoteMux` 实例存了下来。重连会
   *   `this.mux = undefined` 并创建一个新实例，而事件流若不重建，就仍然指着
   *   那条**已经死掉的**旧 mux——`open()` 第一句 `this.mux.isOpen()` 恒为 false，
   *   于是重连循环的表现是：**TCP 连上了、却永远开不了事件流**。
   *   连带后果是一整条链：`ready` 永不送达 → `CONNECTED` 永不发布 →
   *   `SessionHub` 永远等不到"载体恢复"事件 → 轨迹流永不重开 → 界面永远停在 degraded。
   *
   *   实测症状（本轮定位）：首次静默掉线之后，旁路日志在 **39 秒**里
   *   **一条重连记录都没有**（连"第 N 次重试"也没有），而同一时刻一元调用是好的。
   *   这不是"重连没被驱动"，而是"重连在驱动、但每次都在开一条注定失败的事件流"。
   */
  private bindEventStream(sink: EventSink): void {
    this.eventStream = new EventStream(this.getMux(), {
      onReady: (facts) => {
        this.setState(ConnectionState.CONNECTED, `已连接（clientId=${facts.clientId}）`);
        const readySink = sink.onReady;
        if (readySink !== undefined) {
          readySink(facts);
        }
      },
      onEvent: (event: Object) => {
        sink.onEvent(event);
      },
      onEnd: (error?: string) => {
        this.lastError = error ?? '事件流结束';
        this.scheduleReconnect(sink);
      }
    }, this.surface);
  }

  private getMux(): RemoteMux {
    const address: HostAddress | undefined = this.address;
    if (this.mux === undefined) {
      const base: string = address === undefined ? '' : address.wsBaseUrl;
      const authority: string = address === undefined ? '' : address.authority;
      const mux: RemoteMux = new RemoteMux(base, () => this.jar.headerFor(authority), this.surface);
      /**
       * 底层（RemoteMux）判定物理连接失效时，把事实传上来。
       *
       * 【为什么注册必须放在**创建点**而不是 `connectOnce()` 里】
       *   实测（本轮定位）：手动「重连」可以恢复，而**自动重连在两分钟里一条记录都没有**。
       *   原因是创建 mux 有两条路径——`connectOnce()` 与 `getMux()`——而注册只写在
       *   `connectOnce()` 的 `if (this.mux === undefined)` 分支里。重连路径是
       *   「先 `bindEventStream()`（内部 `getMux()` 建 mux）→ 再 `connectOnce()`」，
       *   于是 `connectOnce()` 看到 mux 已存在就**跳过了注册**：
       *   新 mux 没有失效回调 ⇒ 它下一次静默死亡时**无人知晓**，应用从此冻结。
       *   创建点只有一个（就是这里），把注册放这里才不会有第二条路径漏掉。
       */
      mux.setOnSocketDead((reason: string) => {
        this.handleMuxDead(reason);
      });
      this.mux = mux;
    }
    return this.mux;
  }

  private scheduleReconnect(sink: EventSink): void {
    this.reconnector.schedule(async (): Promise<boolean> => {
      const mux: RemoteMux | undefined = this.mux;
      if (mux !== undefined) {
        await mux.close();
      }
      this.mux = undefined;
      // 【必须先重建事件流再连】否则事件流仍指向刚被关掉的那条 mux，
      // `open()` 会因 `isOpen()` 为假而恒失败（详见 `bindEventStream` 的说明）。
      this.bindEventStream(sink);
      const ok: boolean = await this.connectOnce();
      if (!ok) {
        return false;
      }
      // cookie 可能在断连期间失效：401 由 call 处理，这里只重建事件流 generation
      const stream: EventStream | undefined = this.eventStream;
      if (stream !== undefined) {
        return stream.open();
      }
      return true;
    }, (progress) => {
      this.setState(ConnectionState.CONNECTING,
        `第 ${progress.attempt} 次重试将在 ${progress.waitMs}ms 后进行（档位 ${progress.delayMs}ms）`);
    }, () => {
      /**
       * 【为什么"重试耗尽"不再进入终态，而是**继续重连**】
       *
       * 实测（2026-09-11，`10.0.2.2:3115` 直连、不经任何转发）：
       * **服务端每 2 s 发 Ping，漏两次就在约 5.4 s 主动关连接**；
       * 而设备侧 ArkTS 的 `WebSocket` 不回 Pong（对照实验：同一个手工客户端
       * 回 Pong 时 15 s 保持连接，不回时 5.4 s 被关）。也就是说，
       * 在这台设备上**长连接必然会周期性断开**，这是平台层限制，不是我们的 bug。
       *
       * 于是"重试耗尽即终态"这个设计在此环境下等于**应用不可用**：
       * 一条会话最多活 5 秒，之后永久停在 degraded，用户看不到任何回复。
       * 而一元 RPC（`session/prompt` / `session/list` …）是好的——
       * 只要重连不停，`session/follow` 每次都会用 **snapshot** 把整段历史重新同步回来，
       * 因此会话仍然可用（可见延迟约等于这个重连周期）。
       *
       * 档位表仍然用于**快速恢复**（前 6 档 0.5–10 s）；耗尽后改为固定节奏继续重试，
       * 且**保持 DEGRADED 而不进入 DISCONNECTED**——因为事实就是"降级但仍可用"，
       * 报成终态是在说谎（D2 §8.7.10：`error` 不等于连接死了；这里同理）。
       */
      this.setState(ConnectionState.CONNECTING,
        `重试档位已用尽，改为每 ${PERSISTENT_RETRY_MS}ms 继续重连（${this.lastError ?? '未知原因'}）`);
      // 【必须先 reset】`ReconnectController.schedule` 用**自增且只在成功时归零**的
      // `attempt` 判断档位；耗尽后再调 `schedule` 只会让计数器继续增长，
      // 于是它一遍遍回调 `onExhausted` 而**永不真正发起连接**——
      // 症状就是「trace 停在一条『重试已耗尽』上再也不动」（第一版改法就踩了这个坑）。
      // 归零后重新进入档位表，才会真的去连。
      this.reconnector.reset();
      setTimeout(() => {
        this.scheduleReconnect(sink);
      }, PERSISTENT_RETRY_MS);
    });
  }

  /** 立即手动重连（对应上游 connection.reconnect()） */
  async reconnect(sink: EventSink): Promise<boolean> {
    const mux: RemoteMux | undefined = this.mux;
    if (mux !== undefined) {
      await mux.close();
    }
    this.mux = undefined;
    this.reconnector.reset();
    return await this.start(sink);
  }

  /** 停止并释放（幂等） */
  async stop(): Promise<void> {
    this.reconnector.stop();
    this.eventStream?.close();
    this.eventStream = undefined;
    const mux: RemoteMux | undefined = this.mux;
    if (mux !== undefined) {
      await mux.close();
    }
    this.mux = undefined;
    this.setState(ConnectionState.IDLE, '已停止');
  }

  // ─────────────────────────── 一元调用 ───────────────────────────

  /**
   * 发起一元 Remote 调用。
   *
   * 纪律：**绝不为载体问题 reject**；调用方只需判 `result.ok`。
   * 401 时（且 allowAuthRetry !== false）自动重绑一次并重放原请求。
   */
  async call(endpoint: string, args: Object, options?: CallOptions): Promise<RpcResult> {
    const address: HostAddress | undefined = this.address;
    if (address === undefined) {
      return rpcFail(RemoteFailure.carrier('未配置 Host 地址'));
    }
    const target = checkTarget(this.surface.apiChannel, endpoint);
    if (!target.ok) {
      // 用调用方错误码而不是 carrier/parse：这是我们自己的 endpoint 拼错了，
      // 与「链路断了」是两回事，文案层必须能区分（见 RpcTypes.CLIENT_FAILURE_CODE）。
      return rpcFail(new RemoteFailure(CLIENT_FAILURE_CODE,
        `非法 endpoint：${target.reason ?? endpoint}`, ''));
    }

    const timeoutMs: number = options?.timeoutMs ?? this.options.defaultTimeoutMs;
    const first: RpcResult = await this.callOnce(address, endpoint, args, timeoutMs);
    if (first.ok) {
      return first;
    }
    const failure: RemoteFailure | undefined = first.error;
    const shouldRetryAuth: boolean = options?.allowAuthRetry !== false;
    if (shouldRetryAuth && failure !== undefined && isAuthFailureStatus(failure.httpStatus ?? 0)) {
      const rebind: AuthOutcome = await this.rebind();
      if (rebind.ok) {
        return await this.callOnce(address, endpoint, args, timeoutMs);
      }
      return rpcFail(new RemoteFailure('auth/rebind-failed',
        rebind.reason ?? '重新授权失败', rebind.advice ?? ''));
    }
    return first;
  }

  private async callOnce(address: HostAddress, endpoint: string, args: Object,
    timeoutMs: number): Promise<RpcResult> {
    const rpcId: string = randomUuid();
    const body: string | undefined = buildBody(rpcId, endpoint, args);
    if (body === undefined) {
      return rpcFail(RemoteFailure.parse(`无法序列化请求体：${endpoint}`));
    }
    const outcome: HttpOutcome = await this.http.send(
      `${address.baseUrl}${this.surface.apiChannel}/${endpoint}`,
      address.authority, true, body, timeoutMs, true);

    if (!outcome.responded) {
      return rpcFail(RemoteFailure.carrier(
        `请求失败：${outcome.transportError ?? '未知网络错误'}`));
    }
    if (outcome.status !== 200) {
      if (isAuthFailureStatus(outcome.status)) {
        const failure: RemoteFailure = new RemoteFailure('auth/unauthorized',
          '会话未认证或已过期（HTTP 401）', '需要重新授权');
        failure.httpStatus = outcome.status;
        return rpcFail(failure);
      }
      return rpcFail(new RemoteFailure('carrier/transport',
        // 【为什么把响应体也放进**文案**（E72）】`details` 里本来就带着 `outcome.body`，
        // 但上层展示只取文案，于是 dsh 写在 400 body 里的真实原因被吞掉——我们只能看到
        // "HTTP 400（session/list）"，下一步仍要猜。这与 E71 的教训同源：**先让错误自己说话**。
        `传输失败：HTTP ${outcome.status}（${endpoint}）`
          + (outcome.body.length > 0 ? `：${outcome.body.substring(0, 300)}` : ''),
        outcome.body.substring(0, 200)));
    }
    if (outcome.body.length === 0) {
      return rpcFail(RemoteFailure.parse(`空响应体（${endpoint}）`));
    }
    return parseConnectionResponse(outcome.body, rpcId, endpoint);
  }

  // ─────────────────────────── 逻辑流 ───────────────────────────

  /**
   * 打开一条业务逻辑流（例如会话轨迹流；具体 endpoint 由调用方从兼容面取得，
   * 本层不硬编码任何端点名）。
   * @returns 取消函数；未连接时返回 undefined
   */
  openStream(endpoint: string, args: Object, sink: StreamSink): (() => void) | undefined {
    const mux: RemoteMux | undefined = this.mux;
    if (mux === undefined || !mux.isOpen()) {
      return undefined;
    }
    const payload: Record<string, Object> = { 'args': args };
    const payloadJson: string | undefined = stringifyJson(payload as Object);
    if (payloadJson === undefined) {
      return undefined;
    }
    const streamId: string | undefined = mux.open(endpoint, payloadJson, sink);
    if (streamId === undefined) {
      return undefined;
    }
    return () => {
      mux.cancel(streamId);
    };
  }

  // ─────────────────────────── 诊断 ───────────────────────────

  /** 生成五项连接诊断（D1 G7） */
  async diagnose(): Promise<DiagnosticReport> {
    const items: DiagnosticItem[] = [];
    const address: HostAddress | undefined = this.address;

    // ① 端点
    if (address === undefined) {
      items.push({
        name: '端点', passed: false, detail: '未配置 Host 地址',
        advice: '填写 Host 地址（如 127.0.0.1:3000）或粘贴启动 URL。'
      });
      return { items: items, healthy: false, generatedAt: Date.now() };
    }
    const isUp: boolean = await this.probeReachable(address);
    items.push({
      name: '端点', passed: isUp,
      detail: isUp ? `${address.authority} 可达` : `${address.authority} 不可达`,
      advice: isUp ? undefined : '确认 Host 正在运行、端口正确，且设备与 Host 网络互通。'
    });

    // ② TLS
    const tlsOk: boolean = address.scheme === 'http' ? true : isUp;
    items.push({
      name: 'TLS', passed: tlsOk,
      detail: address.scheme === 'https'
        ? (isUp ? 'HTTPS 握手成功' : 'HTTPS 握手失败')
        : 'HTTP（dsh 默认 loopback 姿态，不设 Secure cookie）',
      advice: address.scheme === 'https' && !isUp
        ? '自签证书需在设备上受信任；建议优先使用隧道方案而非直接暴露 Host。'
        : undefined
    });

    // ③ 认证
    const cookieNames: string[] = this.auth?.cookieNames() ?? [];
    const authOk: boolean = cookieNames.length > 0;
    items.push({
      name: '认证', passed: authOk,
      detail: authOk ? `已持有会话 cookie（${cookieNames.join(', ')}）` : '未持有会话 cookie',
      advice: authOk ? undefined : '重新粘贴 Host 启动 URL（含 ?token=）完成授权。'
    });

    // ④ 协议（mux 是否就绪 + 事件流阶段）
    const muxReady: boolean = this.mux?.isOpen() ?? false;
    const phase: EventStreamPhase = this.getEventPhase();
    const protocolOk: boolean = muxReady && phase === EventStreamPhase.LIVE;
    items.push({
      name: '协议', passed: protocolOk,
      detail: `WebSocket ${muxReady ? '已建立' : '未建立'}；事件流 ${phase}`,
      advice: protocolOk ? undefined
        : (muxReady ? '事件流未就绪：查看诊断日志中的帧序列，确认 /api/remote.mux 与 $events 行为。'
          : 'WebSocket 未建立：可能是 Host 未启用 webserver，或中间网络阻断 upgrade。')
    });

    // ⑤ Host 版本/事实
    const clientId: string | undefined = this.getHostFactsClientId();
    items.push({
      name: 'Host', passed: phase === EventStreamPhase.LIVE,
      detail: phase === EventStreamPhase.LIVE
        ? `clientId=${clientId ?? '(空)'} home=${this.getHostHome() ?? '(空)'}`
        : '尚未收到 ready 首项，无法读取 Host 事实',
      advice: phase === EventStreamPhase.LIVE ? undefined : '等待 ready 首项；若长期不到达，检查事件流端点可用性。'
    });

    let healthy: boolean = true;
    for (let i = 0; i < items.length; i++) {
      if (!items[i].passed) {
        healthy = false;
      }
    }
    return { items: items, healthy: healthy, generatedAt: Date.now() };
  }

  /** 探测端点可达性（用根路径 HEAD 语义的 GET，不消耗业务端点） */
  private async probeReachable(address: HostAddress): Promise<boolean> {
    const outcome: HttpOutcome =
      await this.http.send(`${address.baseUrl}/`, address.authority, false, undefined, 8000, false);
    return outcome.responded;
  }

  // ─────────────────────────── cookie 持久化 ───────────────────────────

  private persistCookies(): void {
    const persistence: CookiePersistence | undefined = this.persistence;
    if (persistence === undefined) {
      return;
    }
    persistence.save(serializeCookies(this.jar.snapshot()));
  }

  /** 清空认证与持久化 cookie */
  clearSession(): void {
    this.auth?.clear();
    this.persistence?.clear();
  }
}

/** 构造一元请求体 */
function buildBody(rpcId: string, endpoint: string, args: Object): string | undefined {
  const payload: Record<string, Object> = { 'args': args };
  const message: Record<string, Object> = {
    'type': 'client-request',
    'rpcId': rpcId,
    'method': endpoint,
    'payload': payload as Object
  };
  return stringifyJson(message as Object);
}

/** cookie 序列化（仅内存/持久化用；实现方须加密存储） */
export function serializeCookies(records: CookieRecord[]): string {
  const parts: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const r: CookieRecord = records[i];
    parts.push(`${r.authority}|${r.name}|${r.value}`);
  }
  return parts.join('\n');
}

/** cookie 反序列化 */
export function deserializeCookies(text: string): CookieRecord[] {
  const out: CookieRecord[] = [];
  const lines: string[] = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line: string = lines[i];
    if (line.length === 0) {
      continue;
    }
    const first: number = line.indexOf('|');
    const second: number = line.indexOf('|', first + 1);
    if (first <= 0 || second <= first) {
      continue;
    }
    out.push({
      authority: line.substring(0, first),
      name: line.substring(first + 1, second),
      value: line.substring(second + 1)
    });
  }
  return out;
}
