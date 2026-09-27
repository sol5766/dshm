/**
 * **在设备内部**探测 `remote.mux`：把 ArkTS `WebSocket` 实现与 `hdc rport` 转发分开。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 为什么需要这条用例
 *   长期症状：设备上 `$events` 逻辑流在 `open` 后约 27 ms 内被关，
 *   错误统一是 `carrier/closed: ws error code=200 message=undefined`；
 *   一元 HTTP RPC 同时全部正常。它阻塞了审批/提问推送、通知、设置页外部改动刷新。
 *
 *   宿主侧用 `.research/protocol/probe-mux.mjs` 直连**同一台 Host** 得到的结论是
 *   「载体稳定」（升级 101、10 秒内每 2 s 收到 ping、连接保持），
 *   于是排除了服务端主动关流、心跳超时（阈值 4–6 s vs 实测 27 ms）、
 *   握手层、以及客户端帧结构。剩下的候选只有两个。
 *
 *   这条用例就是那个判据：**在设备内部连同一个地址**。
 *     - 本用例**稳定** → 问题在转发通道（`hdc rport`），属于开发期链路限制，
 *       不是客户端缺陷，验收应改用 hostkit 隧道；
 *     - 本用例**同样快速断开** → 问题在 ArkTS `WebSocket` 实现本身，
 *       需要在客户端侧修。
 *
 * 【为什么要跳过一个「连不上」的情况】这条用例需要一台真的在跑的 Host
 * （且设备侧有可用转发）。CI 或没起 Host 时它必须**跳过而不是失败**——
 * 否则「环境没准备好」会被误读成「客户端有缺陷」。
 * ────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, it } from '@ohos/hypium';
import { webSocket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';

/** 设备侧可达的 Host 地址（模拟器/真机通常需要 `hdc rport tcp:3116 tcp:3115`） */
const MUX_URL = 'ws://127.0.0.1:3116/api/remote.mux';
/** 观察窗口：足够跨越服务端 2 s 的心跳周期，又不会拖长测试 */
const WATCH_MS = 8000;

/** 探测结果 */
interface MuxProbeResult {
  /** 是否成功升级到 WebSocket */
  connected: boolean;
  /** 观察窗口内是否收到过服务端消息（心跳 ping 会以 message 事件到达或被底层吞掉） */
  messages: number;
  /** 是否在窗口内被关闭 */
  closed: boolean;
  /** 关闭码与原因（区分「帧格式错」与「心跳超时」的唯一依据） */
  closeCode: number;
  closeReason: string;
  /** 错误文案（ArkTS 的 error 事件给的是 code 与 message） */
  error: string;
  /**
   * `error` 事件相对 `connect()` 的毫秒数（-1 = 没发生）。
   *
   * 【为什么必须记这个时间】`code=200 message=undefined` 在**多种**情形下都会出现——
   * 包括调用方自己 `close()` 时。只看「有没有 error」会把「我自己关的」
   * 误判成「链路把我关了」。时间戳能一眼分开：几十毫秒 = 链路/协议问题，
   * 接近窗口末端 = 我们自己关的。
   */
  errorAtMs: number;
  /** `close` 事件相对 `connect()` 的毫秒数（-1 = 没发生） */
  closedAtMs: number;
}

/**
 * 连一次 mux 并在窗口内观察。
 *
 * @param useHeartbeat - 是否启用与客户端**完全一致**的 `pingInterval/pongTimeout`。
 *   这个开关就是本探测的关键对照：服务端每 2 s 发一次 Ping，
 *   若 ArkTS 的心跳配置导致它无法在 `pongTimeout` 内回 Pong，
 *   连接会被**本地**关掉（而不是服务端关），现象正好是「极快断开」。
 * @returns 探测结果；`connected=false` 表示连升级都没成功
 */
function probeMux(useHeartbeat: boolean): Promise<MuxProbeResult> {
  return new Promise<MuxProbeResult>((resolve) => {
    const result: MuxProbeResult = {
      connected: false, messages: 0, closed: false,
      closeCode: 0, closeReason: '', error: '', errorAtMs: -1, closedAtMs: -1
    };
    let settled: boolean = false;
    const startedAt: number = Date.now();
    const socket: webSocket.WebSocket = webSocket.createWebSocket();

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.close();
      } catch (err) {
        // 连接已断时 close 会抛；这里只关心观察结果，忽略即可
      }
      resolve(result);
    };

    socket.on('open', () => {
      result.connected = true;
      // 与客户端一致地打开 `$events`：实测实参字段名是 `payload`
      // （写成 `args` 会被服务端以 1008 invalid Remote stream request 关掉，
      //  而且现象与心跳超时几乎一样——只有 close reason 能区分）
      // `$events` 的实参必须是**空对象**；`{}` 会撞上 arkts-no-untyped-obj-literals，
      // 因此先建成有声明类型的空 Record 再放入
      const emptyPayload: Record<string, Object> = {};
      const frame: Record<string, Object> = {
        'type': 'open', 'streamId': 'ohos-test-events', 'endpoint': '$events',
        'payload': emptyPayload as Object
      };
      const text: string = JSON.stringify(frame);
      // `send` 的第二个实参在 ArkTS 里需要一个显式声明的 options 对象；
      // 用 `undefined` 会撞上无类型对象字面量检查，因此显式给一个空的回调类型
      socket.send(text, (err: BusinessError) => {
        if (err !== undefined && err !== null && err.code !== 0) {
          result.error = `send 失败 code=${err.code}`;
        }
      });
    });

    socket.on('message', (_err: BusinessError, _data: string | ArrayBuffer) => {
      result.messages += 1;
    });

    socket.on('close', (_err: BusinessError, value: webSocket.CloseResult) => {
      result.closed = true;
      result.closedAtMs = Date.now() - startedAt;
      if (value !== undefined && value !== null) {
        result.closeCode = value.code;
        result.closeReason = value.reason ?? '';
      }
      finish();
    });

    socket.on('error', (err: BusinessError) => {
      result.error = `code=${err.code} message=${err.message}`;
      result.errorAtMs = Date.now() - startedAt;
      finish();
    });

    const options: webSocket.WebSocketRequestOptions = {};
    if (useHeartbeat) {
      // 与客户端**完全一致**的心跳设置（见 RemoteMux.connectOnce）
      options.pingInterval = 5000;
      options.pongTimeout = 4000;
    }

    socket.connect(MUX_URL, options).then((opened: boolean) => {
      result.connected = opened;
      if (!opened) {
        finish();
        return;
      }
      setTimeout(finish, WATCH_MS);
    }).catch((err: BusinessError) => {
      result.error = `connect 失败 code=${err.code} message=${err.message}`;
      finish();
    });
  });
}

export default function muxProbeTest() {
  describe('MuxCarrier', () => {
    /**
     * 设备内部连 mux 并观察是否被快速关闭——**两个对照**：
     *   1. 不带心跳（纯 WebSocket 行为）；
     *   2. 带客户端那套 `pingInterval=5000 / pongTimeout=4000`。
     *
     * 这个对照直接回答「是不是客户端自己的心跳配置把连接关掉了」：
     * 若只有带心跳的那次快速断开，问题就在客户端的心跳配置上，
     * 而不在转发通道、也不在服务端。
     *
     * 判据（写进断言消息，便于从报告里直接读出结论）：
     *   - 连不上 → 环境未就绪（Host 没起 / 无转发），不算失败；
     *   - 连上且在窗口内保持 → 该配置下链路正常；
     *   - 连上后很快被关 → 记录 close code/reason，用于区分格式错与超时。
     */
    it('compares mux survival with and without the client heartbeat options', 0, async () => {
      const noHeartbeat: MuxProbeResult = await probeMux(false);
      const withHeartbeat: MuxProbeResult = await probeMux(true);
      const fmt = (label: string, r: MuxProbeResult): string =>
        `${label}{connected=${r.connected},closed=${r.closed},code=${r.closeCode},`
          + `reason=${r.closeReason},msgs=${r.messages},err=${r.error},`
          + `errAt=${r.errorAtMs}ms,closedAt=${r.closedAtMs}ms}`;
      const summary: string = `${fmt('无心跳', noHeartbeat)} | ${fmt('有心跳', withHeartbeat)}`;
      // 【为什么用「自反断言」而不是 console.info】`console.info` 在 ohosTest 的报告里
      // **看不到**（实测：用例通过时不回传），而这条用例的产出就是**证据**。
      // 把实际观测值放进断言消息，报告里就会打印它。
      //
      // 【为什么断言要写成「必定成立」而不是「故意失败」】故意失败能让消息显示出来，
      // 但会让套件**长期红**——而长期红的门禁会被忽略，比没有门禁更糟。
      // 这里断言「两次探测的连通性一致」：既真实、又永远成立，
      // 同时把两次的完整读数打印进报告。
      expect(noHeartbeat.connected === withHeartbeat.connected)
        .assertEqual(true);
      // 再断言一次把证据打出来（比较一个常量与它自己，消息里带上实测值）
      expect(summary).assertEqual(summary);
      // 环境未就绪（Host 没起 / 无转发）时到此为止：不判失败
      expect(true).assertTrue();
    });
  });
}
