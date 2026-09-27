/**
 * 事件流（`$events` 逻辑流，D2 §1.3）。
 *
 * 关键事实：
 *   - 唯一首项为 `{ type:'ready', clientId, host:{ home } }`；收到 ready 之前**不得**发布 generation；
 *   - 任一异常（流结束 / 流 error / 非 ready 首项 / 畸形事件项）都使当前 generation 失效；
 *   - 普通通知重连后**不重放**，因此上层必须靠 baseline 快照 + 增量做对账（D2 §7 A-3）。
 */

import { getRecord, getString } from './JsonValue';
import { RemoteMux } from './RemoteMux';
import { ProtocolSurface, FALLBACK_SURFACE } from './Surface';
import { EventSink, HostFacts } from './Types';

/** 事件流当前阶段 */
export enum EventStreamPhase {
  /** 未启动 */
  IDLE = 'idle',
  /** 已开流但未收到 ready 首项 */
  OPENING = 'opening',
  /** 已收到 ready，generation 有效 */
  LIVE = 'live',
  /** 已失效（等待上层重连） */
  LOST = 'lost'
}

export class EventStream {
  private mux: RemoteMux;
  private sink: EventSink;
  /** 上游接口面（事件流端点等事实由兼容面注入） */
  private surface: ProtocolSurface;
  private streamId?: string;
  private phase: EventStreamPhase = EventStreamPhase.IDLE;
  private facts?: HostFacts;
  /** 已收到 ready 首项 */
  private readySeen: boolean = false;
  private lastFailure?: string;

  constructor(mux: RemoteMux, sink: EventSink, surface: ProtocolSurface = FALLBACK_SURFACE) {
    this.mux = mux;
    this.sink = sink;
    this.surface = surface;
  }

  getPhase(): EventStreamPhase {
    return this.phase;
  }

  getFacts(): HostFacts | undefined {
    return this.facts;
  }

  getLastFailure(): string | undefined {
    return this.lastFailure;
  }

  /**
   * 在已就绪的 mux 上打开事件流。
   * @returns 是否成功发出开流帧
   */
  open(): boolean {
    if (!this.mux.isOpen()) {
      this.lastFailure = 'mux 未就绪';
      return false;
    }
    this.readySeen = false;
    this.phase = EventStreamPhase.OPENING;
    const streamId: string | undefined = this.mux.open(this.surface.eventsEndpoint, this.surface.eventsPayloadJson, {
      onItem: (value: Object) => {
        this.handleItem(value);
      },
      onError: (code: string, message: string) => {
        this.fail(`stream error ${code}: ${message}`);
      },
      onEnd: () => {
        this.fail('stream ended');
      }
    });
    if (streamId === undefined) {
      this.lastFailure = '开流失败（mux 未就绪或帧构造失败）';
      this.phase = EventStreamPhase.LOST;
      return false;
    }
    this.streamId = streamId;
    return true;
  }

  private handleItem(value: Object): void {
    if (!this.readySeen) {
      const type: string | undefined = getString(value, 'type');
      if (type !== 'ready') {
        // 上游语义：非 ready 首项即视为畸形，当前 generation 失效
        this.fail(`首项不是 ready（type=${type ?? 'undefined'}）`);
        return;
      }
      const clientId: string = getString(value, 'clientId') ?? '';
      const host: Object | undefined = getRecord(value, 'host');
      const home: string = host === undefined ? '' : (getString(host, 'home') ?? '');
      this.facts = { clientId: clientId, home: home };
      this.readySeen = true;
      this.phase = EventStreamPhase.LIVE;
      const readySink = this.sink.onReady;
      if (readySink !== undefined) {
        readySink(this.facts);
      }
      return;
    }
    this.sink.onEvent(value);
  }

  private fail(reason: string): void {
    if (this.phase === EventStreamPhase.LOST) {
      return;
    }
    this.lastFailure = reason;
    this.phase = EventStreamPhase.LOST;
    const id: string | undefined = this.streamId;
    this.streamId = undefined;
    if (id !== undefined) {
      this.mux.cancel(id);
    }
    this.sink.onEnd(reason);
  }

  /** 主动关闭（不触发 onEnd 的失败语义） */
  close(): void {
    const id: string | undefined = this.streamId;
    this.streamId = undefined;
    this.phase = EventStreamPhase.IDLE;
    this.readySeen = false;
    if (id !== undefined) {
      this.mux.cancel(id);
    }
  }

  /** 供上层在重连成功后重建 generation */
  markLost(): void {
    this.phase = EventStreamPhase.LOST;
  }

  /** 结果回送端点（waterfall 场景，D2 §1.3）；由兼容面注入，不在本类硬编码 */
  eventsResultEndpoint(): string {
    return this.surface.eventsResultEndpoint;
  }
}
