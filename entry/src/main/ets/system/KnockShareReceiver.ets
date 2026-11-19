/**
 * 碰一碰接收（2026-11-16，docs/418）：手机轻触本机屏幕 → Share Kit 沙箱接收
 * → 系统把文件落进本类给的目录 → 读出 + base64 → 通知壳页推进官方输入框。
 *
 * 【范围裁定（用户 2026-11-16）】仅 PC 档（desktopForced：PC / 2in1 /
 * MatePad Edge / Pro Max）注册接收；普通平板不注册；手机端是系统分享面板的
 * 发送方（harmonyShare 的 dataReceive 只在 PC/2in1 屏幕侧触发），无需任何代码。
 *
 * 【零新增权限】harmonyShare/systemShare 全程无 @permission 声明要求
 * （docs/418 §2 逐条核验），本特性不触碰权限面（18/9 铁律）。
 *
 * 【receiveUri = filesDir 根（对齐 WorkBuddy，三轮实测后用户裁定）】WorkBuddy
 * 生产实现即 `receive(fileUri.getUriFromPath(ctx.filesDir))`——已知可用的参考；
 * 官方只硬性要求「已存在目录」（空目录是建议）。前版的一次性子目录
 * `filesDir/knock/<ts>` 未经真机验证（dataReceive 从未触发），在「一步一个变量」
 * 的判别纪律下改为与参考逐位一致，让正式签名包成为唯一差异项。代价：传输期间
 * 整个 filesDir 短暂授权给传输方（与 WorkBuddy 同，传完自动回收）；落盘文件按
 * uri 记账，onResult 后逐个清理。端到端打通后可再评估收紧回子目录。
 *
 * 【注册重试（对齐 WorkBuddy）】1/2/4/8s 指数退避、至多 5 次尝试（首次+4 重试），
 * 防首帧竞态一次性失败；canIUse=false 属设备永久缺能力，不重试；stop() 取消挂起
 * 的重试定时器。
 *
 * 【注册时机（2026-11-17 对照 WorkBuddy 逆向文档修订）】由 **EntryAbility.onWindowStageCreate**
 * 建窗即 bootstrap（仅 PC 档），用 windowStage 的真实主窗 id；壳页（WebApp）随后接管钩子并
 * 再 start() 一次（幂等空跑）。原「页面就绪后注册」使页面起来前系统侧无接收方，
 * 与 WorkBuddy「窗口就绪即 startKnockReceive」不一致——按参考对齐。
 *
 * 【页面未就绪的挂起】碰一碰可能发生在 Web 页重载窗口：文件先进本类挂起队列，
 * 壳页 onPageEnd（webReady）时 takePending() 补发；队列封顶防爆，超限丢弃留痕；
 * 投递中 controller 未挂载的残余文件走 requeue() 回队（不丢）。
 *
 * 【base64 通道的上限】单文件 16 MiB：再大 runJavaScript 的脚本体积会到几十 MB，
 * 大视频本就超出「附件进输入框」的合理范围——跳过并留痕（大文件通道见 docs/418 §6）。
 *
 * 【诊断（diag-knock）】本机 hilog 对本应用不可读（真机实测，diag-web-console
 * 头注同一结论）⇒ 注册/接收/投递全程按 writeDiagMarkerPublic 同一套落
 * `filesDir/diag-knock`（ISO 时间戳 + 事件行）：start 入口 / canIUse / 窗口身份
 * 三件套（type/showing/主窗对比）/ on 结果与重试 / target / result code /
 * 队列与注入结果，一条链一眼读全。
 *
 * 【docs/421 修复（2026-11-17）】
 *   ① 一窗一实例：`byWindow` 按 windowId 索引，会话窗（specified 实例）也注册；
 *   ② 生命周期解耦：页面销毁只 `detachPage()` 摘钩子，窗口销毁才 `release()` 注销，
 *      避免页面重载后系统侧无接收方；
 *   ③ 能力面改成 `general.object` + `general.file`：`general.file` 属 ENTITY 根，
 *      .md/.pdf/.docx 这类已知扩展名落在 object/text 分支，原 FILE+IMAGE+MEDIA
 *      收不到文档类（UTD 表见 SDK `@ohos.data.uniformTypeDescriptor.d.ts`）。
 */
import { harmonyShare, systemShare } from '@kit.ShareKit';
import { uniformTypeDescriptor } from '@kit.ArkData';
import { fileIo, fileUri } from '@kit.CoreFileKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { mimeTypeForName } from 'platform';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'DSHM-KNOCK';

/** 经 base64 通道送进 Web 层的单个文件载荷（JSON 序列化后嵌入注入脚本）。 */
export interface KnockFile {
  /** 展示文件名（SharedRecord.title 优先，路径末段兜底）。 */
  name: string;
  /** MIME 类型；推不出为空串，由 shim 兜底 application/octet-stream。 */
  mime: string;
  /** 原始字节数（诊断用）。 */
  size: number;
  /** 文件内容 base64。 */
  base64: string;
}

export class KnockShareReceiver {
  /**
   * 一窗一实例（docs/421 WP2）：键 = 系统 windowId。
   *
   * 会话窗是独立的 UIAbility 实例（launchType=specified），各自有被子碰的窗口；
   * 全局单实例只能绑一个窗口 ⇒ 会话窗永远收不到。窗口销毁时按 id 释放。
   * windowId 未知（<0）时退化成 -1 槽位，保持旧行为。
   */
  private static readonly byWindow: Map<number, KnockShareReceiver> = new Map();
  /**
   * 单类能力声明数。原值 5 与 WorkBuddy 对齐；docs/421 WP3 提为 20——它是
   * **单次**上限，超限会触发系统"数量异常"弹窗，20 覆盖日常多选且不打爆。
   */
  private static readonly MAX_PER_CAPABILITY: number = 20;
  /** base64 通道单文件上限（字节）。 */
  private static readonly MAX_FILE_BYTES: number = 16 * 1024 * 1024;
  /** 页面未就绪时的挂起队列上限（防重载窗口连碰堆积；≥ 单次能力上限 20，避免多选被队列截断）。 */
  private static readonly MAX_PENDING_FILES: number = 20;
  /** 注册失败重试间隔（ms，同 WorkBuddy 1/2/4/8s；首次之外至多 4 次重试）。 */
  private static readonly RETRY_DELAYS_MS: number[] = [1000, 2000, 4000, 8000];

  private readonly ctx: common.UIAbilityContext;
  /** 「有新文件入队」通知（无参）：壳页接管后注入；建窗即注册阶段为 undefined。 */
  private onFiles: (() => void) | undefined = undefined;
  /** 诊断落盘（壳页接管后替换；bootstrap 阶段用内置默认写入器）。 */
  private writeDiag: (detail: string) => void;
  /** dataReceive 回调的稳定引用（off 时按引用注销）。 */
  private readonly targetCb: (target: harmonyShare.ReceivableTarget) => void;
  /** knockShare 回调的稳定引用（对齐 WorkBuddy §10：2in1 同时注册发送侧监听）。 */
  private readonly knockCb: (target: harmonyShare.SharableTarget) => void;
  /** knockShare 注销用的 windowId。 */
  private knockWindowId: number = -1;
  private registry: harmonyShare.RecvCapabilityRegistry | undefined = undefined;
  private pending: Array<KnockFile> = [];
  /** 本传输已落盘的文件路径（filesDir 根接收的记账：onResult 后逐个清理）。 */
  private receivedPaths: string[] = [];
  private started: boolean = false;
  private retryCount: number = 0;
  private retryTimer: number = -1;

  constructor(ctx: common.UIAbilityContext, onFiles: () => void, writeDiag: (detail: string) => void) {
    this.ctx = ctx;
    this.onFiles = onFiles;
    this.writeDiag = writeDiag;
    this.targetCb = (target: harmonyShare.ReceivableTarget): void => {
      this.handleTarget(target);
    };
    this.knockCb = (target: harmonyShare.SharableTarget): void => {
      // 发送侧监听（WorkBuddy §10 同注册）：本机被碰时由应用向对方推送内容。
      // DSHM 当前没有「碰一碰推送文件」的产品需求，故只留痕——它是排查
      // 「碰一碰事件是否到达本机」的关键断点（有 knockShare 无 dataReceive =
      // 系统把本机当发送方；两者都无 = 系统未路由到本应用）。
      this.writeDiag('knockShare 触发（本版仅留痕，不推送）');
      hilog.info(DOMAIN, TAG, '碰一碰：knockShare 事件到达');
    };
  }

  /**
   * 进程级引导（EntryAbility.onWindowStageCreate 调用，每个窗口各一次，仅 PC 档）：
   * 取/建本窗口的接收器并立即注册。对齐 WorkBuddy（窗口就绪即 startKnockReceive）
   * 与官方示例（aboutToAppear 即注册）；原「Web 页面就绪后注册」在实测中表现为
   * 系统侧长时间无接收方，是「碰了没反应」的候选原因之一。
   */
  static bootstrap(ctx: common.UIAbilityContext, windowId: number): KnockShareReceiver {
    const r: KnockShareReceiver = KnockShareReceiver.acquire(ctx, windowId);
    if (r.started) {
      return r;
    }
    r.start(windowId).then((ok: boolean): void => {
      r.writeDiag(`bootstrap 完成 ok=${ok} windowId=${windowId}`);
    }).catch((): void => {
      // start() 内部已逐项留痕并排退避重试
    });
    return r;
  }

  /**
   * 取本窗口的接收器（不存在则创建）。壳页与能力层用同一个 windowId 取到同一实例，
   * 避免两处各注册一份 dataReceive。
   */
  static acquire(ctx: common.UIAbilityContext, windowId: number): KnockShareReceiver {
    const key: number = windowId >= 0 ? windowId : -1;
    const hit: KnockShareReceiver | undefined = KnockShareReceiver.byWindow.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const r: KnockShareReceiver = new KnockShareReceiver(ctx, (): void => {
      // 壳页接管前的入队通知：无接收方，文件留在挂起队列等页面就绪补发
    }, (detail: string): void => {
      KnockShareReceiver.appendDiag(ctx.filesDir, detail);
    });
    KnockShareReceiver.byWindow.set(key, r);
    return r;
  }

  /** 窗口销毁：注销系统监听并丢弃挂起队列（EntryAbility.onWindowStageDestroy 调用）。 */
  static release(windowId: number): void {
    const key: number = windowId >= 0 ? windowId : -1;
    const r: KnockShareReceiver | undefined = KnockShareReceiver.byWindow.get(key);
    if (r === undefined) {
      return;
    }
    r.release();
    KnockShareReceiver.byWindow.delete(key);
  }

  /** 壳页接管：有新文件入队时通知。 */
  setOnFiles(cb: () => void): void {
    this.onFiles = cb;
  }

  /** 壳页接管：诊断落盘替换为壳页版本（与既有 writeDiagMarkerPublic 同一文件）。 */
  setWriteDiag(cb: (detail: string) => void): void {
    this.writeDiag = cb;
  }

  /** 内置诊断写入（bootstrap 阶段用；格式与 writeDiagMarkerPublic 一致）。 */
  private static appendDiag(filesDir: string, detail: string): void {
    try {
      const p: string = `${filesDir}/diag-knock`;
      const f: fileIo.File = fileIo.openSync(p,
        fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.APPEND);
      fileIo.writeSync(f.fd, `${new Date().toISOString()} ${detail}\n`);
      fileIo.closeSync(f);
    } catch (e) {
      // 诊断写失败静默
    }
  }

  /**
   * 注册沙箱接收能力（幂等）。返回 false = 本轮未注册成功（canIUse 判否 / 窗口
   * 不可得 / on() 抛），调用方只留痕，不影响壳页任何既有功能；瞬时失败由本类按
   * 1/2/4/8s 退避自动重试。每一步都落 diag-knock：真机上把「注册失败」与
   * 「注册成功但系统不投递（签名资格等）」分开。
   *
   * @param windowIdHint 本窗口 id（EntryAbility 用 windowStage 真实 id；壳页用
   *   UIContext.getWindowId()）。多窗下 getLastWindow 可能拿到别的窗口，因此
   *   hint ≥ 0 时以它为准，只有 hint < 0 才完全依赖 getLastWindow。
   */
  async start(windowIdHint: number = -1): Promise<boolean> {
    if (this.started) {
      return true;
    }
    if (this.retryTimer >= 0) {
      // 直接调用优先于挂起的重试：清掉定时器，本轮马上试
      clearTimeout(this.retryTimer);
      this.retryTimer = -1;
    }
    this.writeDiag('start enter');
    if (!canIUse('SystemCapability.Collaboration.HarmonyShare')) {
      // 设备永久缺该能力：重试无意义
      this.writeDiag('canIUse=false 未注册');
      hilog.warn(DOMAIN, TAG, '设备无 Collaboration.HarmonyShare 能力，不注册');
      return false;
    }
    this.writeDiag('canIUse=true');
    let windowId: number = windowIdHint;
    try {
      const win: window.Window = await window.getLastWindow(this.ctx);
      const props: window.WindowProperties = win.getWindowProperties();
      const lastId: number = props.id;
      // windowType 自 API 26（旧设备 undefined → 退路取已弃用的 type，只为诊断读数完整）
      const wType: number = props.windowType !== undefined ? props.windowType : props.type;
      let showing: string = '?';
      try {
        showing = win.isWindowShowing() ? 'true' : 'false';
      } catch (e2) {
        showing = 'err';
      }
      if (windowIdHint >= 0 && windowIdHint !== lastId) {
        // 多窗：getLastWindow 拿到的是别的窗口，按本实例的窗口 id 注册
        this.writeDiag(`getLastWindow=${lastId} 与本窗=${windowIdHint} 不符，按本窗注册`);
      } else {
        windowId = lastId;
      }
      this.writeDiag(`windowId=${windowId} type=${wType} showing=${showing} getLast=${lastId}`);
    } catch (e) {
      const err = e as BusinessError;
      if (windowIdHint >= 0) {
        windowId = windowIdHint;
        this.writeDiag(`getLastWindow err code=${err.code} msg=${err.message} 按本窗id=${windowId}`);
      } else {
        this.writeDiag(`getLastWindow err code=${err.code} msg=${err.message} 无窗口id可回退`);
        hilog.warn(DOMAIN, TAG, '窗口获取失败 code=%{public}d msg=%{public}s', err.code, err.message);
        this.scheduleRetry(windowIdHint);
        return false;
      }
    }
    // 发送侧监听（WorkBuddy §10 同注册）：仅在 2in1 档有意义，失败不阻塞接收注册
    try {
      harmonyShare.on('knockShare', { windowId: windowId }, this.knockCb);
      this.knockWindowId = windowId;
      this.writeDiag(`knockShare on ok windowId=${windowId}`);
    } catch (e2) {
      this.writeDiag(`knockShare on err code=${(e2 as BusinessError).code}`);
    }
    /*
     * 【能力面（docs/421 WP3）】原 FILE+IMAGE+MEDIA 收不到文档类：
     *   `general.file` 在 UTD 里属 ENTITY 物理根，已知扩展名会被系统归到
     *   `general.object` / `general.text` 分支（.md → general.markdown 属 TEXT，
     *   PDF 属 OBJECT），因此按扩展名推 UTD 的发送端必然匹配不上 FILE。
     *   `general.object` 是逻辑根，一条盖住文档/文本/压缩/媒体；`general.file`
     *   继续兜「未知扩展名、utd 恰为 general.file」的文件。
     *   OBJECT 未真机实测（on() 若拒绝），回退到 TEXT+COMPOSITE_OBJECT+ARCHIVE+FILE。
     */
    const wide: harmonyShare.RecvCapability[] = [
      { utd: uniformTypeDescriptor.UniformDataType.OBJECT,
        maxSupportedCount: KnockShareReceiver.MAX_PER_CAPABILITY },
      { utd: uniformTypeDescriptor.UniformDataType.FILE,
        maxSupportedCount: KnockShareReceiver.MAX_PER_CAPABILITY },
    ];
    const narrow: harmonyShare.RecvCapability[] = [
      { utd: uniformTypeDescriptor.UniformDataType.TEXT,
        maxSupportedCount: KnockShareReceiver.MAX_PER_CAPABILITY },
      { utd: uniformTypeDescriptor.UniformDataType.COMPOSITE_OBJECT,
        maxSupportedCount: KnockShareReceiver.MAX_PER_CAPABILITY },
      { utd: uniformTypeDescriptor.UniformDataType.ARCHIVE,
        maxSupportedCount: KnockShareReceiver.MAX_PER_CAPABILITY },
      { utd: uniformTypeDescriptor.UniformDataType.FILE,
        maxSupportedCount: KnockShareReceiver.MAX_PER_CAPABILITY },
    ];
    const sets: harmonyShare.RecvCapability[][] = [wide, narrow];
    let lastCode: number = -1;
    let lastMsg: string = '';
    for (let i = 0; i < sets.length; i++) {
      const caps: harmonyShare.RecvCapability[] = sets[i];
      const registry: harmonyShare.RecvCapabilityRegistry = {
        windowId: windowId,
        capabilities: caps,
      };
      try {
        harmonyShare.on('dataReceive', registry, this.targetCb);
        this.registry = registry;
        this.started = true;
        this.retryCount = 0;
        this.writeDiag(`on ok windowId=${windowId} caps=${KnockShareReceiver.capsText(caps)}`
          + ` max=${KnockShareReceiver.MAX_PER_CAPABILITY}`);
        hilog.info(DOMAIN, TAG, '碰一碰接收已注册 windowId=%{public}d set=%{public}d',
          registry.windowId, i);
        return true;
      } catch (e) {
        const err = e as BusinessError;
        lastCode = err.code;
        lastMsg = err.message;
        this.writeDiag(`on err set=${i} code=${err.code} msg=${err.message}`);
      }
    }
    this.writeDiag(`start err code=${lastCode} msg=${lastMsg}`);
    hilog.warn(DOMAIN, TAG, '碰一碰注册失败 code=%{public}d msg=%{public}s', lastCode, lastMsg);
    this.scheduleRetry(windowIdHint);
    return false;
  }

  /** 能力表 → 诊断短名（general.object → object）。 */
  private static capsText(caps: harmonyShare.RecvCapability[]): string {
    const names: string[] = [];
    for (const c of caps) {
      names.push(c.utd.startsWith('general.') ? c.utd.substring('general.'.length) : c.utd);
    }
    return names.join(',');
  }

  /** 瞬时注册失败的指数退避（1/2/4/8s，至多 4 次重试；stop() 取消）。 */
  private scheduleRetry(windowIdHint: number): void {
    if (this.retryCount >= KnockShareReceiver.RETRY_DELAYS_MS.length) {
      this.writeDiag(`重试上限（${KnockShareReceiver.RETRY_DELAYS_MS.length} 次），放弃`);
      hilog.warn(DOMAIN, TAG, '碰一碰注册重试已达上限，放弃');
      return;
    }
    const delay: number = KnockShareReceiver.RETRY_DELAYS_MS[this.retryCount];
    this.retryCount += 1;
    this.writeDiag(`${delay}ms 后第 ${this.retryCount} 次重试`);
    this.retryTimer = setTimeout((): void => {
      this.retryTimer = -1;
      this.start(windowIdHint).then((): void => {});
    }, delay);
  }

  /** 页面销毁：只摘页面钩子，不注销系统监听、不丢挂起队列（docs/421 WP1）。 */
  detachPage(): void {
    this.onFiles = undefined;
  }

  /** 窗口销毁：此刻才真正注销系统监听并清队列（由静态 release(windowId) 调用）。 */
  release(): void {
    this.stop();
    this.pending = [];
    this.receivedPaths = [];
  }

  /** 注销接收（只由 release() 调用）。 */
  private stop(): void {
    if (this.retryTimer >= 0) {
      clearTimeout(this.retryTimer);
      this.retryTimer = -1;
    }
    this.retryCount = 0;
    if (this.registry !== undefined) {
      try {
        harmonyShare.off('dataReceive', this.registry, this.targetCb);
        this.writeDiag('off ok');
      } catch (e) {
        // 注销失败只留痕：页面已在销毁，泄漏的监听随进程结束回收
        this.writeDiag(`off err code=${(e as BusinessError).code} msg=${(e as BusinessError).message}`);
        hilog.warn(DOMAIN, TAG, '碰一碰注销异常：%{public}s', (e as BusinessError).message);
      }
    }
    this.registry = undefined;
    if (this.knockWindowId >= 0) {
      try {
        harmonyShare.off('knockShare', { windowId: this.knockWindowId });
        this.writeDiag('knockShare off ok');
      } catch (e) {
        this.writeDiag(`knockShare off err code=${(e as BusinessError).code}`);
      }
      this.knockWindowId = -1;
    }
    this.started = false;
    this.pending = [];
  }

  /** 取走挂起文件（消费即清空；页面就绪时由壳页调用）。 */
  takePending(): Array<KnockFile> {
    if (this.pending.length === 0) {
      return [];
    }
    const out: Array<KnockFile> = this.pending;
    this.pending = [];
    return out;
  }

  /** 未投递文件回队（封顶防爆）；返回实际回队数。 */
  requeue(files: Array<KnockFile>): number {
    if (files.length === 0) {
      return 0;
    }
    const room: number = KnockShareReceiver.MAX_PENDING_FILES - this.pending.length;
    if (room <= 0) {
      this.writeDiag(`requeue 丢弃=${files.length}（队列已满）`);
      return 0;
    }
    const back: Array<KnockFile> = files.length <= room ? files : files.slice(0, room);
    this.pending = this.pending.concat(back);
    this.writeDiag(`requeue n=${back.length} 丢弃=${files.length - back.length}`);
    return back.length;
  }

  /**
   * dataReceive 主流程：receive（filesDir 根，对齐 WorkBuddy）→ 系统落盘 →
   * ingest 读出 → onResult 后按记账清理落盘文件。
   */
  private handleTarget(target: harmonyShare.ReceivableTarget): void {
    this.writeDiag('target filesDir根接收');
    hilog.info(DOMAIN, TAG, '碰一碰：开始接收（filesDir 根）');
    target.receive(fileUri.getUriFromPath(this.ctx.filesDir), {
      onDataReceived: (data: systemShare.SharedData): void => {
        this.ingest(data);
      },
      onResult: (code: harmonyShare.ShareResultCode): void => {
        this.writeDiag(`result code=${code}`);
        hilog.info(DOMAIN, TAG, '碰一碰：传输结束 code=%{public}d', code);
        this.cleanupReceived();
      },
    }).catch((err: BusinessError): void => {
      this.writeDiag(`receive err code=${err.code} msg=${err.message}`);
      hilog.warn(DOMAIN, TAG, 'receive 发起失败 code=%{public}d msg=%{public}s', err.code, err.message);
      this.cleanupReceived();
    });
  }

  /** 读取落盘记录 → 组装 KnockFile 入队 → 通知壳页。 */
  private ingest(data: systemShare.SharedData): void {
    const files: Array<KnockFile> = [];
    let records: number = 0;
    try {
      const recs: Array<systemShare.SharedRecord> = data.getRecords();
      records = recs.length;
      for (const rec of recs) {
        const uri: string = rec.uri ?? '';
        if (uri.length === 0) {
          continue; // 文本/链接记录走系统原路径，这里只收文件
        }
        const path: string = new fileUri.FileUri(uri).path;
        if (path.length === 0) {
          this.writeDiag(`skip uri无法换路径 ${uri}`);
          hilog.warn(DOMAIN, TAG, '记录 uri 无法换路径，跳过：%{public}s', uri);
          continue;
        }
        // filesDir 根接收的记账：无论后续读取/入队成败，落盘文件都要在传输结束后清走
        this.receivedPaths.push(path);
        const file: KnockFile | undefined = this.readFileRecord(rec, path);
        if (file !== undefined) {
          files.push(file);
        }
      }
    } catch (e) {
      const err = e as BusinessError;
      this.writeDiag(`ingest err code=${err.code} msg=${err.message}`);
      hilog.warn(DOMAIN, TAG, '落盘记录读取异常 code=%{public}d msg=%{public}s', err.code, err.message);
    }
    if (files.length === 0) {
      this.writeDiag(`records=${records} 入队=0`);
      return;
    }
    if (this.pending.length + files.length > KnockShareReceiver.MAX_PENDING_FILES) {
      const room: number = KnockShareReceiver.MAX_PENDING_FILES - this.pending.length;
      const drop: number = room <= 0 ? files.length : files.length - room;
      this.writeDiag(`队列已满（${this.pending.length}），丢弃=${drop}`);
      hilog.warn(DOMAIN, TAG, '挂起队列已满（%{public}d），本次丢弃 %{public}d 个',
        this.pending.length, drop);
      if (room <= 0) {
        return;
      }
      files.splice(room, files.length - room);
    }
    this.pending = this.pending.concat(files);
    this.writeDiag(`records=${records} 入队=${files.length} 挂起=${this.pending.length}`);
    hilog.info(DOMAIN, TAG, '碰一碰：入队 %{public}d 个文件（挂起 %{public}d）',
      files.length, this.pending.length);
    const hook: (() => void) | undefined = this.onFiles;
    if (hook !== undefined) {
      hook();
    }
  }

  /** 单条文件记录 → KnockFile；读失败/超限返回 undefined（留痕）。 */
  private readFileRecord(rec: systemShare.SharedRecord, path: string): KnockFile | undefined {
    let name: string = rec.title ?? '';
    if (name.length === 0) {
      const segs: string[] = path.split('/');
      name = segs.length > 0 ? segs[segs.length - 1] : 'knock-file';
    }
    if (name.length === 0) {
      name = 'knock-file';
    }
    let file: fileIo.File | undefined = undefined;
    try {
      file = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY);
      const stat: fileIo.Stat = fileIo.statSync(file.fd);
      if (stat.size > KnockShareReceiver.MAX_FILE_BYTES) {
        this.writeDiag(`skip 超限 name=${name} size=${stat.size}`);
        hilog.warn(DOMAIN, TAG, '文件超 16MiB 上限，跳过（等大文件通道）：name=%{public}s size=%{public}d',
          name, stat.size);
        return undefined;
      }
      let b64: string = '';
      if (stat.size > 0) {
        const buf: ArrayBuffer = new ArrayBuffer(stat.size);
        fileIo.readSync(file.fd, buf);
        b64 = new util.Base64Helper().encodeToStringSync(new Uint8Array(buf));
      }
      this.writeDiag(`读出 name=${name} size=${stat.size} utd=${rec.utd ?? '-'}`);
      hilog.info(DOMAIN, TAG, '读出文件 name=%{public}s size=%{public}d utd=%{public}s',
        name, stat.size, rec.utd);
      const out: KnockFile = {
        name: name,
        mime: mimeTypeForName(name),
        size: stat.size,
        base64: b64,
      };
      return out;
    } catch (e) {
      const err = e as BusinessError;
      this.writeDiag(`读失败 name=${name} code=${err.code} msg=${err.message}`);
      hilog.warn(DOMAIN, TAG, '文件读取失败 name=%{public}s code=%{public}d msg=%{public}s',
        name, err.code, err.message);
      return undefined;
    } finally {
      if (file !== undefined) {
        try {
          fileIo.closeSync(file);
        } catch (e) {
          // 关闭失败：fd 随进程回收，不值得为一手失败掩盖读取结果
        }
      }
    }
  }

  /** 传输结束后按记账清理落盘文件（filesDir 根接收不删目录，只删本次文件）。 */
  private cleanupReceived(): void {
    if (this.receivedPaths.length === 0) {
      return;
    }
    let removed: number = 0;
    let failed: number = 0;
    for (const path of this.receivedPaths) {
      try {
        fileIo.unlinkSync(path);
        removed += 1;
      } catch (e) {
        failed += 1;
        // 单文件清理失败：留痕计数即可，残留文件不阻塞后续传输
      }
    }
    this.receivedPaths = [];
    this.writeDiag(`清理 清=${removed} 失败=${failed}`);
    hilog.info(DOMAIN, TAG, '碰一碰：清理落盘文件 %{public}d 个（失败 %{public}d）', removed, failed);
  }
}
