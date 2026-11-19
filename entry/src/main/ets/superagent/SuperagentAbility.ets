/**
 * SuperagentAbility —— 为 `dsh-superagent` 单独起一个**独立进程**的宿主（2026-11-02）。
 *
 * 【为什么必须是独立进程】官方要求 superagent「跑在与工作 profile 隔离的独立 profile、
 * 独立端口、能独立重启」；而端侧原生层**一个进程只允许一个 Node 实例**
 * （既有事实：`dshhost.startHost` 对第二次调用返回 `started=false`）。
 * 所以"两个 profile 同时在线"在单进程里做不到 —— 只有第二个应用进程能做到。
 * HarmonyOS 的多进程是声明式的：`module.json5` 里给这个 ability 写
 * `"process": "superagent"`，系统就会把它放进独立进程（见本模块配置）。
 *
 * 【端口为什么必须显式给】`hostPortForBundle()` 对同一 bundle 恒返回同一个口（正式包 3120），
 * 第二进程不给覆盖值必然 `listen EADDRINUSE: 127.0.0.1:3120`
 * —— 这正是源码里 beta 包撞端口那条注释记下的坑。这里固定官方默认 3082。
 *
 * 【本 ability 没有界面】它只负责把宿主拉起来并保持存活；面板通过
 * `http://127.0.0.1:3082` 访问（Auth token 走 `host-ready.json`，与主宿主同一套机制）。
 *
 * 【不自动启动】由主进程按"手动标记文件"触发（见 EntryAbility 的 startSuperagentIfRequested），
 * 避免常驻多占 200–400 MB 内存。
 */
import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import fs from '@ohos.file.fs';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DshHost, NodeRuntime, resolveHostModulePaths } from 'hostruntime';

const DOMAIN: number = 0x0000;
const TAG: string = 'DSHM-Superagent';
/** superagent 的 profile 名（与 `dsh superagent --from-default-profile` 生成的一致）。 */
const PROFILE: string = 'superagent';
/** 官方默认面板端口。 */
const PORT: number = 3082;

export default class SuperagentAbility extends UIAbility {
  private host: DshHost | null = null;
  /** 停止看门狗的定时器（10 s 一次，见 onWindowStageCreate） */
  private stopWatchdog: number | null = null;

  onCreate(): void {
    hilog.warn(DOMAIN, TAG, 'SuperagentAbility.onCreate：独立进程启动（profile=%{public}s port=%{public}d）',
      PROFILE, PORT);
  }

  /**
   * 起宿主。**不加载页面**（本 ability 无界面），失败只记录、不崩溃 ——
   * 它是个可选的服务进程，起不来不该把应用主流程带下水。
   */
  onWindowStageCreate(windowStage: window.WindowStage): void {
    /*
     * 【窗口必须立刻隐藏（2026-11-02，docs/348 §5）】
     * UIAbility 即使不 `loadContent` 也会创建一个窗口 —— 实测表现是任务栏/桌面多出一个
     * **空的 DSHM beta 窗口，且点不开**（用户口径"这个也不好看"）。
     * 本 ability 是纯后台服务，不需要可见窗口 ⇒ 起来第一件事就把它隐藏。
     * 隐藏失败不影响宿主启动（只记日志）。
     */
    try {
      const win = windowStage.getMainWindowSync();
      /*
       * SDK 里 `Window` **没有 `hide()`**（编译报过错：Property 'hide' does not exist on type 'Window'）。
       * 可用的是 `minimize()`（@ohos.window.d.ts:7336）。语义上"最小化"就够：
       * 窗口不再占据屏幕，本 ability 又从不 loadContent，用户看到的就是"没有窗口"。
       * destroy() 会连带结束 ability，故不用。
       */
      win.minimize();
      hilog.info(DOMAIN, TAG, 'SuperagentAbility：主窗口已最小化（纯后台服务，无界面）');
    } catch (e) {
      const err = e as Error;
      hilog.warn(DOMAIN, TAG, 'SuperagentAbility：隐藏窗口失败（不影响宿主）：%{public}s', err.message);
    }
    this.startHost();
    /*
     * 【按需停止（2026-11-03，用户口径"不需要的话就不要触发启动"）】
     * 本 ability 是**服务进程**，没有界面可关；用轮询标记文件的方式给它一个"停止"入口：
     * 存在 `<filesDir>/stop-superagent.request` ⇒ 停宿主并结束本进程。
     * 间隔 10 s、只做一次 statSync —— 成本可忽略；标记一次性消费。
     */
    this.stopWatchdog = setInterval((): void => {
      try {
        const marker = `${this.context.filesDir}/stop-superagent.request`;
        if (!fs.accessSync(marker)) {
          return;
        }
        fs.unlinkSync(marker);
        hilog.warn(DOMAIN, TAG, 'superagent：收到停止请求 ⇒ 停宿主并结束进程');
        this.stopSelf();
      } catch (e) {
        /* 读不到就当没有请求 */
      }
    }, 10000);
  }

  /** 停宿主 + 结束本 ability 所在进程（幂等）。 */
  private stopSelf(): void {
    try {
      if (this.stopWatchdog !== null) {
        clearInterval(this.stopWatchdog);
        this.stopWatchdog = null;
      }
      const h = this.host;
      this.host = null;
      if (h !== null) {
        h.stop().catch((e: Error) => {
          hilog.warn(DOMAIN, TAG, 'superagent 停止宿主失败（继续退出）：%{public}s', e.message);
        });
      }
      this.context.terminateSelf();
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'superagent 停止异常：%{public}s', (e as Error).message);
    }
  }

  onDestroy(): void {
    if (this.stopWatchdog !== null) {
      clearInterval(this.stopWatchdog);
      this.stopWatchdog = null;
    }
    const h = this.host;
    this.host = null;
    if (h !== null) {
      h.stop().catch((e: Error) => {
        hilog.warn(DOMAIN, TAG, 'SuperagentAbility 停止宿主失败：%{public}s', e.message);
      });
    }
  }

  private startHost(): void {
    try {
      const ctx = this.context;
      const runtime = new NodeRuntime('', ctx.filesDir, ctx);
      /* 第三/四参 = profile 与显式端口（DshHost 默认仍是 ondevice + 按包名推导） */
      const host = new DshHost(ctx.filesDir, runtime, PROFILE, PORT);
      this.host = host;
      /*
       * 与主进程同一条启动链：先解析模块路径（HSP 里的 resfile 与 libs），
       * 再 installBundled（幂等：核心已装则秒过），最后以 superagent profile + 3082 启动。
       * 这里**不传 port 的默认推导**，显式给 3082 —— 理由见文件头注释。
       */
      resolveHostModulePaths(ctx).then((paths) =>
        host.installBundled(paths.resourceDir, ctx.cacheDir),
      ).then(() => host.start()).then((s) => {
        hilog.warn(DOMAIN, TAG, 'SuperagentAbility 宿主已启动：ok=%{public}s note=%{public}s',
          s.ok ? 'true' : 'false', s.ok ? '' : s.note);
      }).catch((e: Error) => {
        hilog.error(DOMAIN, TAG, 'SuperagentAbility 启动失败：%{public}s', e.message);
      });
    } catch (e) {
      const err = e as Error;
      hilog.error(DOMAIN, TAG, 'SuperagentAbility 启动异常：%{public}s', err.message);
    }
  }
}
