/**
 * 阶段二的运行时载体实现：自建 `libnode.so` + NAPI 引导（D6 §4.2）。
 *
 * 【它取代谁】`NotWiredRuntime` 是"如实报告未接线"的占位；本类是**真接线**。
 * 阶段一（Electron-on-鸿蒙）已按设计关闭（D6 E23/E27）：它依赖 JIT、不可上架。
 *
 * 【为什么这个文件在 entry 而不是 hostruntime】`hostruntime` 是 HAR，它没法直接
 * import 声明在 **entry** 的 `oh-package.json5` 里的原生模块 `libdshhost.so`；
 * 而 entry 同时能 import HAR 的类型与原生模块。所以"载体实现"落在 entry，
 * 契约（`RuntimePort` / `buildHostArgv` / `buildHostEnv`）仍留在 hostruntime。
 *
 * 【就绪判定为什么是轮询回环端口，而不是解析 stdout】`DSHM_READY` 是入口脚本打到
 * **stdout** 的，而应用进程的 stdout 在设备上不可见（D6 E23）；shim 也没有把它转交
 * ArkTS 的通道。回环端口能应答 HTTP，就说明 Host 真的在监听——这是可观测的事实。
 */
import { BusinessError } from '@kit.BasicServicesKit';
import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { process } from '@kit.ArkTS';
import { socket } from '@kit.NetworkKit';
import { claimPublicDownloadFolder, readBundleName } from 'platform';
import dshhost from 'libdshhost.so';
import {
  buildHostArgv,
  buildHostEnv,
  HOST_DEFAULT_PORT,
  HostHandle,
  RuntimeKind,
  RuntimePort,
  RuntimeProbe
} from 'hostruntime';

const DOMAIN = 0x0000;
const TAG: string = 'DSHM-NodeRuntime';

/** 就绪轮询：总预算与间隔。
 * 预算刻意不大：首启解包之后 Host 应在数秒内起监听。预算太大（原先 60 s）会让
 * "起不来"的结论迟迟不落盘，而设备上读 hilog 的窗口很短（系统日志滚动很快，实测踩过两次）。 */
const READY_TIMEOUT_MS: number = 15000;
const READY_POLL_INTERVAL_MS: number = 1000;
/** 协作式停止（E90）：等待宿主退出的预算与轮询间隔。 */
const STOP_TIMEOUT_MS: number = 10000;
const STOP_POLL_INTERVAL_MS: number = 300;
/** host-ready.json 落盘等待：就绪链 BOOT_60（端口通）→ BOOT_65（写文件）只差毫秒级，
 * 端口轮询赢在窗口里时文件可能还没写好（或还是旧进程的）。短重试等**本次**文件。 */
const AUTH_URL_RETRY: number = 5;
const AUTH_URL_RETRY_INTERVAL_MS: number = 500;

export class NodeRuntime implements RuntimePort {
  private readonly entryScript: string;
  private readonly sandboxHome: string;
  /**
   * 本应用包名（`Download/<包名>/` 的那一段）。**只用于诊断日志，不参与路径解析。**
   *
   * 【为什么只打日志】Host 的默认工作区有且只有一条路径来源：`DSHM_PUBLIC_DOWNLOAD`
   * （`claimPublicDownload()` 的返回值）。曾经还有一条"把包名交给 Host、由 Host 自己拼
   * `$HOME/Download/<包名>/` 再 mkdir"的路，端侧实测必 EPERM（应用进程直拼公共路径
   * 建目录不被放行），已整条删除。包名保留在这里是因为它是**归属关系**的唯一可读读数：
   * 与 `DSHM_PUBLIC_DOWNLOAD` 的末段比对，一眼能看出"认领到的目录是不是本应用的那个"。
   * 【为什么在这里取一次】包名只能由 ArkTS 侧问系统（`platform` 的 `readBundleName()`
   * → `bundleManager.getBundleInfoForSelfSync`，与公共目录能力**同一个来源**，不另写一份）。
   * 取不到就是空串，日志里如实显示为空（不影响任何路径解析）。
   */
  private readonly bundleName: string;
  /**
   * UIAbility 上下文（`Host` 启动前认领公共下载目录要用它）。
   *
   * 【为什么是可选的】本类在单测/无 UI 的装配里也可能被构造；缺上下文时
   * `claimPublicDownload()` 如实返回空串（Host 走沙箱回退），而不是抛异常。
   */
  private readonly abilityContext: common.Context | undefined;

  constructor(entryScript: string, sandboxHome: string, abilityContext?: common.Context) {
    this.entryScript = entryScript;
    // 【为什么是 filesDir 而不是 cacheDir】实测：`hdc shell` 对 `…/el2/base/…` 下
    // cacheDir 无权限，而 `files` 目录可读。入口脚本的诊断日志会落在沙箱 HOME 下，
    // 我们必须能把它取回来（stdout 在设备上看不见，见 D6 E23）。
    this.sandboxHome = sandboxHome;
    this.abilityContext = abilityContext;
    this.bundleName = readBundleName();
    hilog.info(DOMAIN, TAG, 'Host 环境：本应用包名=%{public}s（仅诊断；默认工作区路径由 DSHM_PUBLIC_DOWNLOAD 决定）',
      this.bundleName.length > 0 ? this.bundleName : '(空)');
  }

  /**
   * 启动 Host **之前**认领一次本应用在公共 `Download/<包名>/` 下的专属目录。
   *
   * 【为什么必须在这里、而且是 await】认领走 `DocumentPickerMode.DOWNLOAD` 的
   * `save()`（无 UI、实测 ~106 ms），它建出的目录是**按包名归属的路径级授权**，
   * Host 的 `node:fs` 与 bash 都吃同一份授权。结果必须**在 spawn 之前**放进 env
   * （`buildHostEnv` 的 `DSHM_PUBLIC_DOWNLOAD`）——env 是 spawn 时定死的，天然无竞态；
   * 若改成"启动后再写状态文件给 Host 读"，Host 早已用旧值算完默认工作区（本函数的
   * 返回路径就是那个竞态的消除器）。
   *
   * 【每次启动都调】官方 FAQ `faqs-local-file-manager-46`：冷启动后系统可能不再授予
   * 之前经 picker 拿到的 URI 权限 ⇒ 不能假设"建过一次永久有效"。
   *
   * 【失败不阻断】拿不到就返回空串，Host 明确回退 `<SANDBOX_HOME>/workspace` 并把
   * 原因记进 diag（绝不出现 cwd = `/`）。本方法自己**不抛**。
   */
  private async claimPublicDownload(): Promise<string> {
    if (this.abilityContext === undefined) {
      hilog.warn(DOMAIN, TAG, '默认工作区：没有 UIAbility 上下文，跳过公共下载目录认领（Host 将回退沙箱）');
      return '';
    }
    try {
      return await claimPublicDownloadFolder(this.abilityContext);
    } catch (e) {
      const err = e as BusinessError;
      hilog.warn(DOMAIN, TAG, '默认工作区：认领调用异常（按失败处理）：%{public}s', err.message);
      return '';
    }
  }

  kind(): RuntimeKind {
    return RuntimeKind.LIBNODE;
  }

  label(): string {
    return 'libnode.so（自建 Node）';
  }

  /**
   * 探测：向原生模块要"链接进来的 Node 是哪个版本"。
   *
   * 这一问就是运行时门的判据（D6 E31）：只要它返回非空，就同时证明
   * ① `libdshhost.so` 加载并绑定成功；② 它 `NEEDED` 的 `libnode.so.127` 也在设备上
   * 加载成功。**不填猜测值**：拿不到就 available=false 并说清原因。
   */
  async probe(): Promise<RuntimeProbe> {
    let version: string = '';
    let note: string = '';
    try {
      version = dshhost.runtimeVersion();
    } catch (e) {
      const err = e as BusinessError;
      note = `原生模块调用失败：${err.message}`;
    }
    if (version.length === 0) {
      return {
        kind: RuntimeKind.LIBNODE,
        available: false,
        note: note.length > 0 ? note : '原生模块未返回 Node 版本（模块未绑定或未链接 libnode）',
        nodeVersion: '',
        platform: '',
        zstd: null,
        jitless: null,
        natives: [],
        listenAddress: '',
      };
    }
    // jitless 可以如实断言：argv 里我们**总是**带 --jitless（buildHostArgv 的单测钉住了这一点）。
    // platform/zstd/natives/listenAddress 只有 Host 起来之后才知道，这里一律留空/null，不猜。
    return {
      kind: RuntimeKind.LIBNODE,
      available: true,
      note: '',
      nodeVersion: version,
      platform: '',
      zstd: null,
      jitless: true,
      natives: [],
      listenAddress: '',
    };
  }

  /**
   * 启动 Host：先把 Node 起在同进程的独立线程里，再**轮询回环端口**确认它真的在监听。
   *
   * 失败时抛异常并把原因写清楚——上层（`DshHost.start`）会把它变成核心页上的一句人话，
   * 而不是一个静默的"启动了但没反应"。
   */
  async start(coreDir: string, homeDir: string, profile: string): Promise<HostHandle> {
    const port: number = HOST_DEFAULT_PORT;
    /*
     * 【2026-10-03：先把默认工作区认领好，再 spawn】(必须 await、必须在 buildHostEnv 之前)
     * 认领到的路径经 `DSHM_PUBLIC_DOWNLOAD` 交给 Host，Host 只做 lstat+探写、**不再 mkdir**。
     * 放在这里（而不是页面 onAppear 里）的理由：这是"Host 启动"这一动作的前置，任何
     * 启动路径（首启/重启/切换核心）都必然经过它，不存在"某条路径忘了认领"。
     */
    const publicDownload: string = await this.claimPublicDownload();
    const argv: string[] = buildHostArgv(this.entryScript);
    const env: string[] = buildHostEnv(coreDir, homeDir, this.sandboxHome, port, profile,
      publicDownload);
    hilog.info(DOMAIN, TAG, 'startHost：入口=%{public}s 核心=%{public}s profile=%{public}s 端口=%{public}d',
      this.entryScript, coreDir, profile, port);
    hilog.info(DOMAIN, TAG, 'startHost：DSHM_PUBLIC_DOWNLOAD=%{public}s（空=Host 会回退沙箱工作区）',
      publicDownload.length > 0 ? publicDownload : '(空)');
    const res = dshhost.startHost(argv, env);
    hilog.info(DOMAIN, TAG, 'startHost 返回：started=%{public}s envApplied=%{public}d note=%{public}s',
      res.started ? 'true' : 'false', res.envApplied, res.note);
    if (!res.started) {
      /*
       * 【"已经启动过"不是失败（E99）】原生层一个进程只允许一个 Node 实例，重复启动会返回
       * `started=false`（note 是「运行时已经启动过」）。而这时**核心确实在跑**——这正是
       * "启动"想要的结果。此前把它当异常抛出，界面就显示成
       * 「启动失败：运行时已经启动过；同一进程只允许一个 Node 实例」，
       * 用户会以为核心坏了（真机实测：核心页的切换/启动/重启都会撞这条）。
       * 只要 `isHostRunning()` 为真就继续往下走（等端口应答），把它当成"已在运行"。
       */
      if (dshhost.isHostRunning()) {
        hilog.info(DOMAIN, TAG, '原生层报告已启动过，且运行时确实在跑 ⇒ 视为已在运行：%{public}s', res.note);
      } else {
        throw new Error(res.note.length > 0 ? res.note : '运行时拒绝启动');
      }
    }
    const listening: boolean = await this.waitListening(port, READY_TIMEOUT_MS);
    if (!listening) {
      // 如实报告"进程起来了但端口没应答"，并且不假装成功
      const alive: boolean = dshhost.isHostRunning();
      throw new Error(`Node 已启动，但 ${READY_TIMEOUT_MS} ms 内 ${port} 端口未应答`
        + `（Node 线程${alive ? '仍在运行' : '已经退出'}）`);
    }
    hilog.info(DOMAIN, TAG, 'Host 已就绪：127.0.0.1:%{public}d', port);
    /*
     * 【为什么句柄里的 url 要带 token】dsh 的 `/api` 前面是 browser-trust fence：
     * 不带 token 一律 401（入口脚本自探 `GET /` 得到的就是 401，那是**正确**响应）。
     * token 只出现在 dsh 打印的 `dsh web: http://127.0.0.1:<port>/?token=…` 里，
     * 由入口脚本抓下来写成 `<DSHM_HOME>/host-ready.json`（`libdshhost` 没有"读 Node 输出"的 API）。
     * 这里把它读出来放进句柄，上层就能把 baseUrl 与 token 一起交给客户端。
     * 读不到就退回不带 token 的基址——**不阻塞启动**，只是客户端会停在 401。
     */
    const authUrl: string = await this.readAuthUrlWithRetry(homeDir, port);
    if (authUrl.length > 0) {
      hilog.info(DOMAIN, TAG, '已从 host-ready.json 取到带 token 的地址（tokenLen=%{public}d）',
        authUrl.length - authUrl.indexOf('token=') - 'token='.length);
    } else {
      hilog.warn(DOMAIN, TAG, 'host-ready.json 里没有 authenticatedUrl：客户端将只能拿到 401');
    }
    return { port: port, url: authUrl.length > 0 ? authUrl : `http://127.0.0.1:${port}` };
  }

  /**
   * 读入口脚本落下的 authenticatedUrl；TCP 通了但文件还没写好时短等重试。
   *
   * 【为什么需要重试】readAuthUrl 的 pid 校验会把**旧进程**的文件如实拒掉；
   * 而本次 Host 写文件（BOOT_65）只比端口监听（BOOT_60）晚毫秒级——这里的
   * 重试负责跨过这个窗口，避免把「慢了半拍」误报成「没有 authenticatedUrl」。
   */
  private async readAuthUrlWithRetry(homeDir: string, port: number): Promise<string> {
    for (let attempt: number = 0; attempt < AUTH_URL_RETRY; attempt++) {
      const url: string = this.readAuthUrl(homeDir, port);
      if (url.length > 0) {
        return url;
      }
      await this.sleep(AUTH_URL_RETRY_INTERVAL_MS);
    }
    return '';
  }

  /** 读入口脚本落下的 authenticatedUrl（读不到/不是本次进程的都返回空串，绝不抛）。 */
  private readAuthUrl(homeDir: string, port: number): string {
    const path: string = `${homeDir}/host-ready.json`;
    try {
      if (!fs.accessSync(path)) {
        return '';
      }
      const parsed = JSON.parse(fs.readTextSync(path)) as Record<string, string>;
      const url: string = typeof parsed.url === 'string' ? parsed.url : '';
      // 端口必须与本次一致：换端口后读到旧文件会连到别处（宁可退回无 token 的基址）
      if (url.length === 0 || !url.includes(`:${port}/`)) {
        return '';
      }
      /*
       * 【防旧文件】应用重启的窗口里可能读到**上一次进程**留下的 host-ready.json：
       * 它的 token 对本次 Host 无效（dsh 每次启动换 token），拿去只会换来 401。
       * pid 校验一票否决：Node 线程的 process.pid 就是应用进程 pid
       * （Linux 下线程 getpid() 返回进程号），与 @ohos.process 的 pid 恒等。
       */
      const pidInFile: string = `${parsed.pid}`;
      if (pidInFile !== `${process.pid}`) {
        hilog.warn(DOMAIN, TAG, 'host-ready.json 属于旧进程（pid 不符），等本次写入');
        return '';
      }
      return url;
    } catch (e) {
      const err = e as BusinessError;
      hilog.warn(DOMAIN, TAG, '读 host-ready.json 失败（不影响启动）：%{public}s', err.message);
      return '';
    }
  }

  /**
   * 停止 Host —— **协作式停止的等待端**（E90）。
   *
   * 【为什么这里只是"等"】请求本身是一个落在 `$DSH_HOME/host-stop-request` 的文件
   * （入口脚本每 1.5 s 巡检一次，见 `hostcore/app/main.js` 的 E90 说明），而
   * `$DSH_HOME` 的布局知识属于 hostruntime（`CoreStore.homeDir()`），所以**写文件在
   * `DshHost.stop()`**，这里只负责等原生层确认"Node 线程真的结束了"。
   *
   * 【为什么不能继续只调 stopHost()】原生层只在 `node::Start` 返回时把 `g_running`
   * 置假，而没有任何外部手段能让它返回 ⇒ 那个调用如实返回"做不到"。协作式停止走的是
   * "让 Node 自己收工"这条路：dsh 的 shutdown 关掉服务 → 事件循环排空 → 入口脚本在
   * 1.5 s 兜底里显式退出 → 原生线程函数返回 → `isHostRunning()` 变假。
   * 本机实测：请求后 +1536 ms 端口静默、Node 退出码 **0**（干净退出）。
   */
  async stop(): Promise<void> {
    const deadline: number = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!dshhost.isHostRunning()) {
        hilog.info(DOMAIN, TAG, 'Host 已停止（isHostRunning=false）');
        return;
      }
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, STOP_POLL_INTERVAL_MS);
      });
    }
    // 超时后退回原生通道：它若声称成功就接受，否则**如实**抛错（绝不假装停成功）
    const res = dshhost.stopHost();
    if (res.ok) {
      hilog.warn(DOMAIN, TAG, '协作式停止超时，原生层已接受停止请求');
      return;
    }
    throw new Error(`${res.note}（已写入 host-stop-request 并等待 ${STOP_TIMEOUT_MS} ms，仍未确认 Node 线程退出）`);
  }

  /**
   * Host 是否正在本进程里跑——**问引导层**（`isHostRunning()`），不记自己的账。
   *
   * 【为什么不能让调用方记】端侧只有一个 Node 进程，Host 一起就是进程级事实；
   * 而 `DshHost` 会被反复构造（页面每次刷新都 new 一个）。若"在跑"只记在实例里，
   * 新实例就会在端口已经监听的情况下报"未启动核心"——端侧实测正是这个症状。
   */
  isRunning(): boolean {
    return dshhost.isHostRunning();
  }

  /** 轮询回环端口直到有 HTTP 应答。任何应答（哪怕 404）都说明"在监听"。 */
  private async waitListening(port: number, budgetMs: number): Promise<boolean> {
    const deadline: number = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (await this.portAnswers(port)) {
        return true;
      }
      await this.sleep(READY_POLL_INTERVAL_MS);
    }
    return false;
  }

  /**
   * 端口是否在监听——**TCP 直连**判定，不走 HTTP 栈。
   *
   * 【为什么放弃 @ohos.net.http】真机实测（2026-09-20）：Host 在 127.0.0.1:3120 正常
   * LISTEN（设备 netstat 可见），设备外经 hdc fport 也能拿到 401 应答，但应用进程内
   * `http.createHttp()` 的 GET 在 15 s 预算里**全部** connect/read 超时。HTTP 栈受
   * 系统代理等环境因素影响（代理不回传 127.0.0.1 是标准行为）；而 TCP connect 是
   * "在不在监听"的最原始事实，被 accept 即成功，不需要任何 HTTP 语义。
   */
  private async portAnswers(port: number): Promise<boolean> {
    const tcp: socket.TCPSocket = socket.constructTCPSocketInstance();
    try {
      await tcp.connect({
        address: {
          address: '127.0.0.1',
          port: port
        },
        timeout: READY_POLL_INTERVAL_MS
      });
      return true;
    } catch (e) {
      return false;
    } finally {
      tcp.close().catch((_e: BusinessError) => {
        // 连接可能已被对端重置：close 失败不影响"是否在监听"的判定
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void) => {
      setTimeout(() => {
        resolve();
      }, ms);
    });
  }
}
