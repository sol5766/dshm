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
import { BusinessError, runningLock } from '@kit.BasicServicesKit';
import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { process } from '@kit.ArkTS';
import { socket, connection } from '@kit.NetworkKit';
import { claimPublicDownloadFolder, readBundleName, readDeviceFacts, readFamilyModel } from 'platform';
import dshhost from 'libdshhost.so';
import probe from 'libentryprobe.so';
import {
  buildHostArgv,
  buildHostEnv,
  HOST_DEFAULT_PORT,
  HostHandle,
  RuntimeKind,
  RuntimePort,
  RuntimeProbe
} from './RuntimePort';
import { HostModulePaths, resolveHostModulePaths } from './HostModules';

const DOMAIN = 0x0000;
const TAG: string = 'DSHM-NodeRuntime';

export interface NativeBindingProbe {
  probeOk: boolean;
  probeValue: string;
  probeError: string;
  runtimeVersion: string;
  runtimeError: string;
}

/**
 * 产品 HAP 的启动诊断入口。
 *
 * 原生模块现在属于公共 HSP，HAP 不再直接 import `.so`；通过本函数才能在两处
 * 继续验证同一件事：CMake 产出的模块可绑定，且 `runtimeVersion()` 能证明 libnode
 * 已随 HSP 加载。
 */
export function probeNativeBindings(): NativeBindingProbe {
  const out: NativeBindingProbe = {
    probeOk: false,
    probeValue: '',
    probeError: '',
    runtimeVersion: '',
    runtimeError: '',
  };
  try {
    out.probeValue = probe.hello();
    out.probeOk = out.probeValue.length > 0;
  } catch (e) {
    out.probeError = (e as BusinessError).message;
  }
  try {
    out.runtimeVersion = dshhost.runtimeVersion();
  } catch (e) {
    out.runtimeError = (e as BusinessError).message;
  }
  return out;
}

/**
 * 就绪轮询：预算与间隔（2026-11-10 改为**自适应**，起因是一次真实的启动误报）。
 *
 * 【事故】1.1.8 邀请测试版在设备上冷启动，用户看到
 *   `启动失败：Node 已启动，但 15000 ms 内 3120 端口未应答（Node 线程仍在运行）`
 * 而事实上宿主只是**还在启动**：日志里 `SERVER-LISTENING` 在报错后约 6 秒才出现，
 * Web 壳却已经把 ERROR 态化成永久页（旧实现的 `clearAutoRetry()` + `WebPhase.ERROR`），
 * 再也不会自己接回去。原来的 15 s 是"解包完之后应在数秒内起监听"这个假设下的值，
 * 而**首装/清数据/换核心**那条路径上，宿主启动前要先处理核心树与工具链，
 * 实测整段可达 20 s 以上 —— 15 s 必然误报。
 *
 * 【口径】预算按"这台设备上这个 home 目录有没有成功启动过"分两档，而不是一刀切：
 *   · 冷档 `READY_TIMEOUT_COLD_MS`：`host-ready.json` 不存在（首装 / 清数据 / 换核心）。
 *     要覆盖核心解包 + 工具链 + 插件图装载，取 120 s。
 *   · 温档 `READY_TIMEOUT_MS`：已经有成功启动的痕迹，宿主应很快起监听，取 45 s。
 * 另外 `waitListening()` 里宿主线程一退出就提前收工（不会对着死进程空等），
 * 并每 5 s 打一条进度，排障时能区分"一直在推进"与"卡住不动"。
 */
const READY_TIMEOUT_MS: number = 45000;
/** 首启/换核心档：必须覆盖核心解包与工具链，见上。 */
const READY_TIMEOUT_COLD_MS: number = 120000;
/**
 * 端口轮询间隔（2026-11-15：1000 → 250 ms）。
 *
 * 【为什么改】宿主就绪是**秒级事件**，而墙钟上用户感知的是"最后那一段"。
 * 1 s 粒度在最坏情况下白等近 1 s，且 1 s 也正好是 `portAnswers` 的 connect 超时，
 * 两个语义被同一个常量耦合。实测（PC Beta 冷启动）从 `startHost` 到端口应答约 14 s，
 * 其中最后一段就是轮询空转 + token 落盘窗口；缩短轮询能把这部分压到 0.25 s 内。
 * 失败重试只是重建一个 loopback socket，代价可忽略。
 */
const READY_POLL_INTERVAL_MS: number = 250;
const FOREGROUND_READY_POLL_INTERVAL_MS: number = 64;
const FOREGROUND_READY_POLL_START_MS: number = 2000;
const FOREGROUND_READY_POLL_END_MS: number = 5000;
/**
 * 单次 TCP 探测的 connect 超时。
 *
 * 【为什么不复用轮询间隔】loopback 的 connect 是毫秒级；但系统繁忙时 250 ms 可能不够，
 * 被误判成"没应答"只会多轮一次（幂等）。给 connect 留 1 s，保证判定本身不是瓶颈。
 */
const READY_CONNECT_TIMEOUT_MS: number = 1000;
/** 等待期进度日志间隔：既能让排障看到"在推进"，又不会把 hilog 刷满。 */
const READY_PROGRESS_LOG_MS: number = 5000;
/** 端口未应答时，"宿主已退出 ⇒ 提前收工"的确认延迟（刚 startHost 的一瞬不判死）。 */
const READY_ALIVE_GRACE_MS: number = 5000;

/**
 * 宿主监听端口按**包名**派生（2026-10-15 真机事故修复）。
 *
 * 【事故】beta 包（独立 bundle `com.dshm.dshmbeta`）与正式包（`com.dshm.dshclient`）
 * **同时**装在同一台手机上、同时运行时，beta 的宿主起不来。`<HOME>/.dshm-boot-failed` 原文：
 *   `stage=BOOT_40_PROFILE_BOOT reason=启动失败：… listen EADDRINUSE:
 *    address already in use 127.0.0.1:3120`（webserver 插件起不来 ⇒ 两个必需插件无法激活）
 * 根因：两个包跑**同一份**宿主脚本，而端口默认写死 —— `hostcore/app/main.js` 的
 *   `const PORT = process.env.DSHM_PORT || '3120';` ⇒ 后起的那个必然撞端口。
 *
 * 【口径】正式包**保持 3120 不变**（历史行为；`hdc fport tcp:3120` 之类既有工具口径依赖它），
 * 其他包按包名算一个稳定偏移（3121~3170）。页面侧不写死端口 —— 端口最终由
 * `host-ready.json` 的 authenticatedUrl 带回（`readAuthUrl()`），健康轮询用的也是同一个值。
 */
const PROD_BUNDLE_NAME: string = 'com.dshm.dshclient';
const BETA_BUNDLE_NAME: string = 'com.dshm.dshmbeta';
const BETA_HOST_PORT: number = 3121;
const HOST_PORT_SPAN: number = 50;

function hostPortForBundle(bundle: string): number {
  if (bundle === BETA_BUNDLE_NAME) {
    return BETA_HOST_PORT;
  }
  if (bundle.length === 0 || bundle === PROD_BUNDLE_NAME) {
    return HOST_DEFAULT_PORT;
  }
  let h: number = 0;
  for (let i = 0; i < bundle.length; i++) {
    h = (h * 31 + bundle.charCodeAt(i)) % 997;
  }
  return HOST_DEFAULT_PORT + 1 + (h % HOST_PORT_SPAN);
}
/** 协作式停止（E90）：等待宿主退出的预算与轮询间隔。 */
const STOP_TIMEOUT_MS: number = 10000;
const STOP_POLL_INTERVAL_MS: number = 300;
/**
 * host-ready.json 落盘等待：就绪链 BOOT_60（端口监听）→ BOOT_65（认证 URL 落盘）
 * 之间的窗口**不是毫秒级**。真机实测（手机冷启动，2026-10-14）：
 *     SERVER-LISTENING 07:02:46.956Z → host-ready token 07:02:49.583Z，相差 **2627 ms**
 * （dsh 要等路由挂完才打印带 token 的 `dsh web:` 行，入口脚本抓到它才写文件）。
 * 原预算 5×500 = 2000 ms 不够 ⇒ `start()` 拿无 token 的基址发布出去，Web 壳页
 * **永久 401**（用户看到的「host 拒绝了本次令牌」）。预算按温档 READY_TIMEOUT_MS（45 s）同口径。
 * 等的是**本次进程**的文件（pid 守卫会把旧文件如实拒掉）；超时也只是退回无 token 基址，
 * 不会把"起不来"变成失败。
 */
const AUTH_URL_RETRY: number = 100;
/**
 * 落盘轮询间隔（2026-11-15：500 → 150 ms）。
 *
 * 【口径不变】总等待窗口仍是 100 × 150 ≈ 15 s（与旧的 30 × 500 同样覆盖实测 2627 ms
 * 的 BOOT_60→65 窗口，并留足余量）。改的只是**探测粒度**：这份文件一旦写出，
 * 再等一个 500 ms 周期就是纯粹的墙钟浪费，而它正好落在"启动页已经盖满屏"的尾段。
 */
const AUTH_URL_RETRY_INTERVAL_MS: number = 150;
// TCP 在文件写回前几十毫秒就可达。仅在首个重试间隔内增加三次读取。
const AUTH_URL_FIRST_RETRY_DELAYS_MS: number[] = [16, 24, 40];
const FOREGROUND_AUTH_URL_FIRST_RETRY_DELAYS_MS: number[] = [12, 12, 16, 16, 20, 20, 24];

export class NodeRuntime implements RuntimePort {
  /** 启动期 CPU 锁（RUNNING_LOCK 消费点），到期由系统释放 */
  private startupLock: runningLock.RunningLock | null = null;
  private startupListeningCallback: (() => void) | undefined = undefined;

  private entryScript: string;
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
  private readonly nativeLibsDir: string;
  private resolvedNativeLibsDir: string;
  private resolvedResourceDir: string;
  private readonly pcResfileDir: string;
  /**
   * Node 模块编译缓存目录（空串 = 不启用）。
   *
   * 取自 `cacheDir` 而不是 `files`：这份数据是**可再生成物**，放系统缓存区既符合语义，
   * 也不会污染 `files/dsh/home`（会话、插件、workspace 的落点，且参与云同步范围）。
   */
  private readonly compileCacheDir: string;

  constructor(entryScript: string, sandboxHome: string, abilityContext?: common.Context,
    nativeLibsDir: string = '', pcResfileDir: string = '') {
    this.entryScript = entryScript;
    // 【为什么是 filesDir 而不是 cacheDir】实测：`hdc shell` 对 `…/el2/base/…` 下
    // cacheDir 无权限，而 `files` 目录可读。入口脚本的诊断日志会落在沙箱 HOME 下，
    // 我们必须能把它取回来（stdout 在设备上看不见，见 D6 E23）。
    this.sandboxHome = sandboxHome;
    this.abilityContext = abilityContext;
    this.nativeLibsDir = nativeLibsDir;
    this.resolvedNativeLibsDir = nativeLibsDir;
    this.resolvedResourceDir = '';
    this.pcResfileDir = pcResfileDir.length > 0
      ? pcResfileDir
      : (abilityContext !== undefined && abilityContext.resourceDir.length > 0
        ? `${abilityContext.resourceDir}/resfile`
        : '');
    const cacheRoot: string = abilityContext === undefined ? '' : abilityContext.cacheDir;
    this.compileCacheDir = cacheRoot.length > 0 ? `${cacheRoot}/v8-compile-cache` : '';
    /*
     * 2026-10-26 真机：Beta 与正式包同时运行时，Beta 仍回落到 3120 并撞端口。
     * `bundleManager.getBundleInfoForSelfSync()` 在这次 HSP/多模块组合里没有返回有效
     * 包名，导致 `hostPortForBundle('')` 走了正式包默认口。UIAbilityContext 是启动链
     * 已经持有的可靠来源，故以它的 applicationInfo.name 优先，再回退到 bundleManager。
     */
    const contextBundle: string = abilityContext === undefined
      ? ''
      : abilityContext.applicationInfo.name;
    this.bundleName = contextBundle.length > 0 ? contextBundle : readBundleName();
    hilog.info(DOMAIN, TAG, 'Host 环境：本应用包名=%{public}s（仅诊断；默认工作区路径由 DSHM_PUBLIC_DOWNLOAD 决定）',
      this.bundleName.length > 0 ? this.bundleName : '(空)');
  }

  /**
   * 解析公共核心 HSP。旧调用方传空入口时，启动前自动从 HSP 模块上下文补齐。
   */
  private async ensureHostModulePaths(): Promise<void> {
    if (this.entryScript.length > 0 && this.resolvedNativeLibsDir.length > 0
      && this.resolvedResourceDir.length > 0) {
      return;
    }
    if (this.abilityContext === undefined) {
      throw new Error('缺少 UIAbilityContext，无法解析公共核心 HSP');
    }
    const paths: HostModulePaths = await resolveHostModulePaths(this.abilityContext);
    this.entryScript = `${paths.resourceDir}/resources/app/main.js`;
    this.resolvedNativeLibsDir = paths.nativeLibsDir;
    this.resolvedResourceDir = paths.resourceDir;
  }

  /** 供产品 HAP 在安装内置核心时取得同一个 HSP 的 resourceDir。 */
  async resourceDir(): Promise<string> {
    await this.ensureHostModulePaths();
    return this.resolvedResourceDir;
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
    // 当前 debug Profile 在 V8 申请可执行内存时会触发 native CHECK 崩溃，
    // 因此 Host 仍以 --jitless 启动；exec / 原生库权限继续由动态沙箱提供。
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
  /**
   * 起宿主期间持一把 CPU 锁（`RUNNING_LOCK` 的消费点）。
   *
   * 时长取 120s：覆盖"解包 + 起 Node"的实测上限（BOOT_70 约 +10s，冷启解包约 +11s），
   * 到期自动释放，不会长期占着电池。锁对象存字段，方便排障时查看是否持着。
   */
  private holdStartupLock(): void {
    try {
      if (!runningLock.isSupported(runningLock.RunningLockType.BACKGROUND)) {
        hilog.info(DOMAIN, TAG, 'startHost：该设备不支持 BACKGROUND 运行锁（跳过）');
        return;
      }
      /*
       * 【必须用回调重载】无回调的 `createRunningLock(name, type)` 在 SDK 里返回
       * `Promise<RunningLock>`（编译报过错：Type 'Promise<RunningLock>' is missing
       * properties from type 'RunningLock'）。这里用三参回调重载，拿到的就是真对象。
       */
      runningLock.createRunningLock('dshm-host-start', runningLock.RunningLockType.BACKGROUND,
        (err: BusinessError, lock: runningLock.RunningLock) => {
          if (err) {
            hilog.warn(DOMAIN, TAG, 'startHost：CPU 锁创建失败（不影响启动）：%{public}s', err.message);
            return;
          }
          lock.hold(120000);
          this.startupLock = lock;
          hilog.info(DOMAIN, TAG, 'startHost：已持 CPU 锁 120s（RUNNING_LOCK 消费点）');
        });
    } catch (e) {
      const err = e as BusinessError;
      hilog.warn(DOMAIN, TAG, 'startHost：CPU 锁不可用（不影响启动）：%{public}s', err.message);
    }
  }

  /**
   * @param portOverride 显式端口（不传则按包名推导）。
   *
   * 【为什么需要它（2026-11-02）】superagent 要跑在**独立进程**的**独立 profile** 上，
   * 而 `hostPortForBundle()` 对同一 bundle 永远给出同一个口（正式包 3120）。
   * 第二进程若不给覆盖值，必然 `listen EADDRINUSE: 127.0.0.1:3120`
   * —— 源码里那条 beta 撞端口的注释就是同一个坑。
   */
  async start(coreDir: string, homeDir: string, profile: string,
    portOverride?: number): Promise<HostHandle> {
    await this.ensureHostModulePaths();
    const port: number = (portOverride !== undefined && portOverride > 0)
      ? portOverride
      : hostPortForBundle(this.bundleName);
    /*
     * 【2026-10-03：先把默认工作区认领好，再 spawn】(必须 await、必须在 buildHostEnv 之前)
     * 认领到的路径经 `DSHM_PUBLIC_DOWNLOAD` 交给 Host，Host 只做 lstat+探写、**不再 mkdir**。
     * 放在这里（而不是页面 onAppear 里）的理由：这是"Host 启动"这一动作的前置，任何
     * 启动路径（首启/重启/切换核心）都必然经过它，不存在"某条路径忘了认领"。
     */
    const publicDownload: string = await this.claimPublicDownload();
    const argv: string[] = buildHostArgv(this.entryScript, true);
    const facts = readDeviceFacts();
    /*
     * 型号族（`deviceInfo.model`）单独读一次：它不参与 DeviceFacts 快照（那份是 UI 断点用的），
     * 只作为 Host 侧设备事实的兜底 —— `dshm-vm-bash` 拿它判「这条设备走原生 PTY、不该拉 QEMU」。
     * 读失败一律空串，绝不影响启动（docs/262）。
     */
    const familyModel: string = readFamilyModel();
    const env: string[] = buildHostEnv(coreDir, homeDir, this.sandboxHome, port, profile,
      publicDownload, facts.form, facts.productModel, facts.nativeTerminalOnly,
      familyModel, this.resolvedNativeLibsDir, this.resolvedResourceDir, this.pcResfileDir,
      this.compileCacheDir);
    hilog.info(DOMAIN, TAG,
      'startHost 设备事实：form=%{public}s productModel=%{public}s marketName=%{public}s family=%{public}s nativeTerminalOnly=%{public}s',
      facts.form, facts.productModel, facts.model, familyModel.length > 0 ? familyModel : '(空)',
      facts.nativeTerminalOnly ? 'true' : 'false');
    hilog.info(DOMAIN, TAG, 'startHost：入口=%{public}s 核心=%{public}s profile=%{public}s 端口=%{public}d',
      this.entryScript, coreDir, profile, port);
    hilog.info(DOMAIN, TAG, 'startHost：DSHM_PUBLIC_DOWNLOAD=%{public}s（空=Host 会回退沙箱工作区）',
      publicDownload.length > 0 ? publicDownload : '(空)');
    hilog.info(DOMAIN, TAG, 'startHost：NODE_COMPILE_CACHE=%{public}s（空=不启用）',
      this.compileCacheDir.length > 0 ? this.compileCacheDir : '(空)');

    /*
     * ── 权限的真实消费点（2026-11-02，第一批）─────────────────────────────
     *
     * 【为什么必须在这里用一次】`GET_NETWORK_INFO` 与 `RUNNING_LOCK` 都是 normal 权限
     * （安装即授、无需 ACL），但 AGC 的前置检查要求"声明的权限必须有功能在用"。
     * 两处都放在 startHost 链路里，各用一次，成本可忽略：
     *   · 网络态：离线时 Host 的模型请求会一路等到超时，先留一条事实便于排障；
     *   · CPU 锁：解包 + 起 Node 属于长任务，持锁避免被休眠降频打断
     *     （用户的原始诉求就是"长时任务体验不好"）。
     * 任何失败都吞掉 —— 能力缺失不能影响启动。
     *
     * API 来源（SDK 类型声明核实，不是猜）：
     *   `connection.hasDefaultNetSync(): boolean`            @ohos.net.connection.d.ts:524
     *   `runningLock.createRunningLock(name, type, cb)`      @ohos.runningLock.d.ts:196
     *   `RunningLock.hold(timeout)` / `unhold()`             @ohos.runningLock.d.ts:60/98
     */
    let netState: string = 'unknown';
    try {
      netState = connection.hasDefaultNetSync() ? 'online' : 'offline';
    } catch (e) {
      netState = 'unavailable';
    }
    hilog.info(DOMAIN, TAG, 'startHost：网络=%{public}s（GET_NETWORK_INFO 消费点）', netState);
    this.holdStartupLock();
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
    /*
     * 【预算按冷/温分档（2026-11-10）】判据是 `host-ready.json` 在不在：这个文件只由
     * 入口脚本在**成功起过一次**之后写下，所以"没有它"就是"这台设备的这个 home 目录
     * 还没有完成过一次启动"（首装 / 清数据 / 换核心后的第一次）。那条路径上宿主启动前
     * 还有核心树与工具链的活，给短预算必然误报（见 READY_TIMEOUT_MS 的事故说明）。
     */
    const coldBoot: boolean = !this.hostReadyFileExists(homeDir);
    const budgetMs: number = coldBoot ? READY_TIMEOUT_COLD_MS : READY_TIMEOUT_MS;
    hilog.info(DOMAIN, TAG, 'startHost：就绪预算 %{public}d ms（%{public}s）',
      budgetMs, coldBoot ? '冷档：本 home 尚无成功启动痕迹，含核心解包/工具链' : '温档：已成功启动过');
    const listening: boolean = await this.waitListening(port, budgetMs);
    if (!listening) {
      // 如实报告"进程起来了但端口没应答"，并且不假装成功
      const alive: boolean = dshhost.isHostRunning();
      throw new Error(`Node 已启动，但 ${budgetMs} ms 内 ${port} 端口未应答`
        + `（Node 线程${alive ? '仍在运行' : '已经退出'}）`);
    }
    hilog.info(DOMAIN, TAG, 'Host 已就绪：127.0.0.1:%{public}d', port);
    const onListening = this.startupListeningCallback;
    this.startupListeningCallback = undefined;
    if (onListening !== undefined) {
      onListening();
    }
    /*
     * 【为什么句柄里的 url 要带 token】dsh 的 `/api` 前面是 browser-trust fence：
     * 不带 token 一律 401（入口脚本自探 `GET /` 得到的就是 401，那是**正确**响应）。
     * token 只出现在 dsh 打印的 `dsh web: http://127.0.0.1:<port>/?token=…` 里，
     * 由入口脚本抓下来写成 `<DSHM_HOME>/host-ready.json`（`libdshhost` 没有"读 Node 输出"的 API）。
     * 这里把它读出来放进句柄，上层就能把 baseUrl 与 token 一起交给客户端。
     * 读不到就退回不带 token 的基址——**不阻塞启动**，只是客户端会停在 401。
     */
    const authUrl: string = await this.readAuthUrlWithRetry(homeDir, port, onListening !== undefined);
    if (authUrl.length > 0) {
      hilog.info(DOMAIN, TAG, '已从 host-ready.json 取到带 token 的地址（tokenLen=%{public}d）',
        authUrl.length - authUrl.indexOf('token=') - 'token='.length);
    } else {
      hilog.warn(DOMAIN, TAG, 'host-ready.json 里没有 authenticatedUrl：客户端将只能拿到 401');
    }
    return { port: port, url: authUrl.length > 0 ? authUrl : `http://127.0.0.1:${port}` };
  }

  /**
   * 读入口脚本落下的 authenticatedUrl；TCP 通了但文件还没写好时按预算重试。
   *
   * 【为什么需要重试】readAuthUrl 的 pid 校验会把**旧进程**的文件如实拒掉；
   * 而本次 Host 写文件（BOOT_65）比端口监听（BOOT_60）晚**实测 2627 ms**（见
   * AUTH_URL_RETRY 的注释）——这里的重试负责跨过这个窗口，避免把「慢了半拍」
   * 误报成「没有 authenticatedUrl」，进而把无 token 的地址发布给 Web 壳页（永久 401）。
   */
  private async readAuthUrlWithRetry(homeDir: string, port: number, foreground: boolean): Promise<string> {
    const firstRetryDelays: number[] = foreground ?
      FOREGROUND_AUTH_URL_FIRST_RETRY_DELAYS_MS : AUTH_URL_FIRST_RETRY_DELAYS_MS;
    for (let attempt: number = 0; attempt < AUTH_URL_RETRY; attempt++) {
      const url: string = this.readAuthUrl(homeDir, port);
      if (url.length > 0) {
        return url;
      }
      let remaining: number = AUTH_URL_RETRY_INTERVAL_MS;
      if (attempt === 0) {
        for (const delay of firstRetryDelays) {
          await this.sleep(delay);
          remaining -= delay;
          const earlyUrl: string = this.readAuthUrl(homeDir, port);
          if (earlyUrl.length > 0) {
            return earlyUrl;
          }
        }
      }
      await this.sleep(remaining);
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

  /** `<home>/host-ready.json` 是否存在 = 这个 home 是否成功启动过（判据见 READY_TIMEOUT_MS 说明）。 */
  private hostReadyFileExists(homeDir: string): boolean {
    try {
      return fs.accessSync(`${homeDir}/host-ready.json`);
    } catch (e) {
      return false;
    }
  }

  setStartupListeningCallback(callback: () => void): void {
    this.startupListeningCallback = callback;
  }

  /** 轮询回环端口直到 TCP 连接成功。 */
  private async waitListening(port: number, budgetMs: number): Promise<boolean> {
    const startedAt: number = Date.now();
    const deadline: number = startedAt + budgetMs;
    let lastLog: number = startedAt;
    while (Date.now() < deadline) {
      if (await this.portAnswers(port)) {
        return true;
      }
      const now: number = Date.now();
      /*
       * 【宿主线程已退出 ⇒ 提前收工】端口没应答、Node 也不在跑了，再等下去只会在
       * 预算耗尽后报同一句话，用户白等。留 5 s 宽限：刚 `startHost()` 的一瞬间
       * 引导层的 g_running 可能还没置上，那一瞬不算"死了"。
       */
      if (now - startedAt > READY_ALIVE_GRACE_MS && !dshhost.isHostRunning()) {
        hilog.error(DOMAIN, TAG, '等待端口：宿主线程已退出（已等 %{public}d ms），提前结束等待',
          now - startedAt);
        return false;
      }
      if (now - lastLog >= READY_PROGRESS_LOG_MS) {
        lastLog = now;
        hilog.info(DOMAIN, TAG, '等待端口：已等 %{public}d ms / 预算 %{public}d ms（宿主%{public}s）',
          now - startedAt, budgetMs, dshhost.isHostRunning() ? '仍在运行' : '未在运行');
      }
      const elapsed: number = now - startedAt;
      // 桌面主窗常规冷启动在这段绑定端口。其余时间仍用常规间隔。
      const foreground: boolean = this.startupListeningCallback !== undefined &&
        elapsed >= FOREGROUND_READY_POLL_START_MS && elapsed < FOREGROUND_READY_POLL_END_MS;
      await this.sleep(foreground ? FOREGROUND_READY_POLL_INTERVAL_MS : READY_POLL_INTERVAL_MS);
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
        timeout: READY_CONNECT_TIMEOUT_MS
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
