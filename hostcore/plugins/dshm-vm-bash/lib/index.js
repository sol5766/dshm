/*
 * DSHM 端侧「guest 虚拟机 bash 通道」。
 *
 * ── 要解决什么 ────────────────────────────────────────────────────────────
 * 手持档（手机/平板）的应用沙箱里**没有任何可 execve 的 shell**：真机读数
 * `system-sh=缺` / `ash=denied` / `bash=denied` / `realShell=no`（docs/104）。
 * 于是链 1（模型的 `bash` 工具 = `tool-bash` → `ctx.shell`(`dsh-bash-local`) →
 * `ctx.subprocess` → 本机 `execve`）在本档**结构性不可用**：命令一条都跑不了。
 * 上游把这条链的最后一跳收在 `ctx.subprocess` 上，而这一跳是**可以换实现**的。
 *
 * ── 换什么 ────────────────────────────────────────────────────────────────
 * 换成随包 QEMU guest（HiSH 同源的 Linux VM，`docs/119` 已把可行性验到端到端：
 * QGA 可用 11.8 s、命令 81~219 ms）。本插件只做三件事：
 *   ① 判据：本档是不是"真的没有可用的 spawn"（与 dshm-market-bridge /
 *      dshm-profile-pnpm **同源判据**：同步探随包假壳能不能跑）；
 *   ② 接管 `ctx.subprocess.spawn`：把 `["bash","-c",cmd]` 改派到 guest；
 *   ③ 生命周期：**延迟静默预热 + 按需兜底**（2026-10-16 用户拍板）：进 APP 后延迟 60 s
 *      （`DSHM_VM_PREWARM_SEC` 可配、`DSHM_VM_PREWARM=off` 可关）悄悄拉起来，预热前要过
 *      "阈值 +512 MiB"的更严内存闸门、cwd 取上一次真实请求的记录；没有记录就退回纯按需。
 *
 * ── 刻意不做的（写在这里，免得被当成"漏了"）────────────────────────────
 *   · **`spawnTerminal` 的拒绝面与 spawn 逐条一致**：只有能过 `translateProgram`
 *     的 argv[0]（bash/sh/ash/dash/zsh）才改派到 guest；端侧 profile 给 `terminal-bash`
 *     配的 `/usr/bin/zsh`（本档不存在）**不接管**，与今天一致 —— 不假装能跑。
 *   · **宿主随包假壳（`bin/pnpm` / `python3` / `git`…）不进白名单**：它们的逻辑是
 *     "在宿主上做事"（探 execve 白名单、转发 127.0.0.1 的 Python 桥），搬进 guest
 *     只会得到看不懂的失败（guest 的 `127.0.0.1` 是它自己的回环）。
 *   · **`stdio.control === 'pipe'` 不接管**：control pipe 是 subprocess-local 的
 *     私有协议，用伪 handle 假装实现会静默改变调用方语义 ⇒ 如实退回"本档跑不了"。
 *   · **不新增权限、不碰用户数据**：只用包内资产 + 沙箱内的 `vm/` 运行目录。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 *   · **三端 VM 路线**：release 应用域下随包假壳无法 `execve`（PC 也一样 ——
 *     2026-10-14 早期真机 `dshm-market-bridge` 的同一探针报「随包假壳无法 spawn」），
 *     所以 PC / 手机 / 平板的 bash 与终端都由本插件改派到 guest VM。
 *   · **不做"起 VM 之前的可执行页预检"**：那一层曾试图用 memfd 上的
 *     `mmap(PROT_EXEC)` 提前判定平台给不给可执行页，但探针自己漏了 `MFD_EXEC`
 *     ⇒ 在**能跑**的设备上恒判失败、把整条 VM 主路掐死（2026-10-14 12:43 的
 *     `+dshm.41`，真机报文「端侧 VM 不可用：worker 线程退出（code=0）」）。
 *     QEMU 自己走的是带 `MFD_EXEC` 的 `qemu_memfd_alloc`，能不能起来由它定；
 *     本插件只如实转述它的成败，不代它下结论。见 docs/155。
 *   · **失败一律 fail-open 到原实现**：不管哪一步失败，都退回原来的 `spawn`
 *     （也就是"本档跑不了"这一既有事实），绝不返回一个假的成功 handle。
 *   · **VM 起来之前不许伪装**：`ensureRunning()` 失败的情形（资产缺失/dlopen 失败/
 *     QGA 不就绪）会把原因写进 `done` 的失败里，报文是中文、可行动。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createVmHandle, translateProgram } from './handle.js';
import { assetsPresent } from './paths.js';
import { createVmTerminal, terminalDiagnostics } from './terminal.js';
import {
  PREWARM_HEADROOM_MIB, diagnostics, ensureRunning, memBudget, prewarmPlan,
  lifecycleGate, rememberPrewarmCwd, resolvePrewarmCwd, session, stop, vmMemoryMib,
  vmMinAvailableMib, vmTierProfile,
} from './vm.js';

export const name = '@deepseek-ai/dshm-vm-bash';

/** 本插件要在 `subprocess` 服务就位之后才 apply。 */
export const inject = ['subprocess'];

const TAG = '[dshm-vm-bash]';

/** 只在测试/调试里用的接管标记（防止插件重载时二次包装同一个 runtime）。 */
const WRAPPED = Symbol.for('dshm.vmBash.wrapped');

function log(message) {
  try {
    console.log(`${TAG} ${message}`);
  } catch {
    /* 日志通道异常不许影响功能 */
  }
}

/**
 * 随包假壳能不能**真的**被 spawn 起来 —— 本插件唯一的"这档需不需要接管"判据。
 *
 * 与 `hostcore/plugins/dshm-market-bridge/lib/index.js:105` 的实现逐字同源：
 * 用 `spawnSync` 而不是异步探针（apply 期需要同步结论）；被拒时 `status === null`
 * 且 `error` 置位，几毫秒返回；能跑时是假壳自己打印版本号后退出 0。
 * 假壳缺失（未布置 / 非端侧部署）同样返回 false —— 那种场合"没有可用 spawn 链路"
 * 是更该有的默认（随后由 `DSHM_PLATFORM` 与资产预检把关）。
 */
function spawnProbeOk() {
  const sandbox = String(process.env.DSHM_SANDBOX_HOME || '').trim();
  if (sandbox.length === 0) {
    return false;
  }
  const shim = join(sandbox, 'bin', 'pnpm');
  if (!existsSync(shim)) {
    return false;
  }
  try {
    const result = spawnSync(shim, ['--version'], { stdio: 'ignore', timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * 调试用：确认当前宿主是否真的能 spawn 随包假壳。
 * release 应用域下 PC/手机/平板都会返回 false，因此 enabled() 不再以它分档；
 * 保留这个探针是为了诊断和与旧口径对照，不影响产品行为。
 */
export function hostSpawnProbe() {
  return spawnProbeOk();
}

/** 设备事实已选择宿主原生执行路线（2in1 / PC / Edge desktop）。 */
export function nativeExecutionOnly(env = process.env) {
  if (String(env.DSHM_NATIVE_TERMINAL_ONLY || '').trim() === '1') return true;
  // 双保险：ArkTS 判据已经把 Edge 报成 desktop；这里再认 Host 收到的原始设备事实，
  // 防止标记丢失、旧宿主壳或启动参数遗漏时回落到 guest VM（Edge 上有系统原生 PTY）。
  if (String(env.DSHM_DEVICE_FORM || '').trim().toLowerCase() === 'desktop') return true;
  const model = String(env.DSHM_DEVICE_MODEL || '').trim().toUpperCase();
  return model.includes('QXS-');
}

/**
 * 本档要不要接管（纯函数，离线门禁直接对三种档位下断言）。
 *
 * @param env 环境变量表（默认 `process.env`）
 * @param deps `{probe, assets}` —— 测试注入点，默认真实现
 * @returns `{enabled, reason}`
 */
export function enabled(env = process.env, deps = {}) {
  const probe = deps.probe ?? spawnProbeOk;
  const assets = deps.assets ?? assetsPresent;
  const mode = String(env.DSHM_VM_BASH || '').trim().toLowerCase();
  if (mode === 'off') return { enabled: false, reason: 'DSHM_VM_BASH=off（显式关闭）' };
  if (mode === 'force') return { enabled: true, reason: 'DSHM_VM_BASH=force（显式接管）' };
  if (nativeExecutionOnly(env)) {
    return { enabled: false, reason: '系统原生执行路线（DSHM_NATIVE_TERMINAL_ONLY=1）' };
  }
  // 端侧标识：main.js 只在沙箱路径确实落在 /data/storage 下时设置它。
  if (String(env.DSHM_PLATFORM || '') !== 'ohos') {
    return { enabled: false, reason: 'DSHM_PLATFORM≠ohos（非鸿蒙应用沙箱）' };
  }
  const present = assets();
  if (!present.ok) {
    return { enabled: false, reason: `VM 资产未随包（缺 ${present.missing.join('、')}）` };
  }
  return { enabled: true, reason: '鸿蒙端侧且 VM 资产齐备（三端同步走 guest VM）' };
}

/**
 * 终端是否仍由 guest VM 接管。
 *
 * `DSHM_NATIVE_TERMINAL_ONLY=1` 由 ArkTS 设备事实层给出。MatePad Edge / QXS-*
 * 系列永久识别为 desktop 后走这条：bash 工具仍可使用 guest，但侧边栏终端
 * 必须交给系统原生 PTY，不再在 native / guest 两条路线之间切换。
 */
export function terminalTakeoverEnabled(env = process.env) {
  return !nativeExecutionOnly(env);
}

/**
 * guest 侧**保证存在**的 shell 绝对路径（随包 rootfs + provisioning 的产物）。
 *
 * 【为什么敢写成静态表】这张表不是猜的：镜像自带 `/bin/sh`、`/bin/ash`（都是 busybox），
 * 而 `/bin/bash` 是 `provision()` 的**成功判据**（`vm.js:413` 起不到就报错）⇒ 三者都在
 * 就是"VM 起来了"的同义词。反过来，**不在表里的名字一律交回原实现**：
 * `resolveShell()` 对缺失候选靠 `error.name === 'SubprocessExecutableNotFoundError'`
 * 忽略（`dsh-api-terminal-controller:54`），原实现给的正是这个名字错的信号。
 * 真机读数（docs/123 §1）：`/bin/sh -> /bin/busybox`、`/bin/ash -> /bin/busybox`、
 * `/bin/bash` 866000 B 的 GNU bash 5.2.37；`/bin/dash` / `/bin/zsh` / `/usr/bin/zsh` 全不存在。
 */
const GUEST_SHELL_EXECUTABLES = new Map([
  ['sh', '/bin/sh'],
  ['ash', '/bin/ash'],
  ['bash', '/bin/bash'],
]);

/**
 * 一次 `spawnTerminal` 要不要改派到 guest（纯函数）。
 *
 * 与 `shouldTakeOver` 同一把尺子：**只看 argv[0] 是不是 guest 里的 shell**。
 * `spawnTerminal` 的 spec 里没有 `stdio`（那是 `spawn` 才有的形态），所以没有 control 面要拒。
 * @param spec 上游 terminal spec
 * @returns `{take, reason}`
 */
export function shouldTakeOverTerminal(spec) {
  if (spec === null || typeof spec !== 'object' || !Array.isArray(spec.argv) || spec.argv.length === 0) {
    return { take: false, reason: 'argv 非法' };
  }
  if (translateProgram(spec.argv[0]) === null) {
    return { take: false, reason: 'argv[0]=' + String(spec.argv[0]) + ' 不在 guest shell 白名单' };
  }
  return { take: true, reason: 'guest tty（-serial 通道）' };
}

/**
 * 一次 `resolveExecutable` 要不要由本插件回答（纯函数）。
 *
 * 【为什么必须接管】侧边栏终端的 shell 解析链是 `terminalEnvironment()`（取默认 shell）
 * → `resolveExecutable(path)`（验存在），两步都在**宿主**上跑：手持档沙箱里既没有
 * `/bin/sh` 也没有 `/bin/bash` ⇒ 终端连"有哪些 shell"都问不出来，会话根本到不了
 * `spawnTerminal`。这里只回答**guest 的 shell 名字**，其余一律交回原实现（保持
 * "宿主上没有就是没有"这一既有事实，不扩散影响面）。
 * @param command 上游请求的可执行名或路径
 * @returns guest 侧绝对路径，或 null（= 交回原实现）
 */
export function guestShellPath(command) {
  const requested = String(command ?? '');
  if (requested.length === 0) return null;
  const name = requested.slice(requested.lastIndexOf('/') + 1);
  const mapped = GUEST_SHELL_EXECUTABLES.get(name);
  if (mapped === undefined) return null;
  // 绝对路径请求必须与表里那条一致：`/usr/bin/bash` 这类走原实现（本档确实没有）。
  if (requested.includes('/') && requested !== mapped) return null;
  return mapped;
}

/**
 * 一次 spawn 要不要改派到 guest（纯函数）。
 * @param spec 上游 subprocess spec
 * @returns `{take, reason}`
 */
export function shouldTakeOver(spec) {
  if (spec === null || typeof spec !== 'object' || !Array.isArray(spec.argv) || spec.argv.length === 0) {
    return { take: false, reason: 'argv 非法' };
  }
  const stdio = spec.stdio && typeof spec.stdio === 'object' ? spec.stdio : {};
  if (stdio.control === 'pipe') {
    return { take: false, reason: 'stdio.control=pipe（control 通道是 subprocess-local 私有协议）' };
  }
  if (translateProgram(spec.argv[0]) === null) {
    return { take: false, reason: `argv[0]=${String(spec.argv[0])} 不在 guest shell 白名单` };
  }
  return { take: true, reason: 'guest shell' };
}

/**
 * 把 ctx.subprocess 的 spawn 换掉。
 *
 * 【为什么是"换方法"而不是"换服务"】`ctx.subprocess` 是 `LocalSubprocessRuntime`
 * 的实例（`@deepseek-ai/dsh-subprocess-local`），它之外的链路（terminal / LSP /
 * workspace-changes / deliverables）都持有**同一个实例引用**。只换 `spawn` 这一个
 * 方法，别的行为逐字保留（这些链路在本档该失败还是失败，语义不变）。
 */
export function apply(ctx) {
  /*
   * 【P0-1 / docs/388】宿主退出前必须能找到 QMP 优雅关机入口。宿主 main.js 是
   * CommonJS、插件是 ESM，两边没有 import 关系 ⇒ 用进程级 Set 作唯一接线点。
   * Set 保证插件重载重复注册也只调一次；卸载时移除，新实例会重新注册。
   * 注意：这里**不调用** shutdown()（那是进程真正退出时才做的事）。
   */
  const hooks = globalThis.__DSHM_HOST_SHUTDOWN_HOOKS__
    || (globalThis.__DSHM_HOST_SHUTDOWN_HOOKS__ = new Set());
  hooks.add(shutdown);
  ctx.effect(() => () => { hooks.delete(shutdown); });
  const decision = enabled();
  if (!decision.enabled) {
    log(`不接管：${decision.reason}`);
    return;
  }
  const runtime = ctx.subprocess;
  if (runtime === undefined || runtime === null || typeof runtime.spawn !== 'function') {
    log('不接管：ctx.subprocess 上没有 spawn（上游结构变化？）');
    return;
  }
  if (runtime[WRAPPED] === true) {
    log('已接管（跳过重复包装）');
    return;
  }
  runtime[WRAPPED] = true;
  const originalSpawn = runtime.spawn.bind(runtime);
  let taken = 0;
  let delegated = 0;
  runtime.spawn = (spec) => {
    const choice = shouldTakeOver(spec);
    if (!choice.take) {
      delegated += 1;
      return originalSpawn(spec);
    }
    taken += 1;
    // 【同步返回 + 后台启动】spawn 必须是同步的（上游拿到 handle 立刻 await done），
    // 而 VM 冷启动要 11.8 s ⇒ 这里只把"取会话"这件事包成 promise 交给 handle，
    // 由 handle 的 done 去等（第一次命令的额外延迟就体现在这一次 done 上）。
    return createVmHandle(spec, async () => {
      // 【为什么把 cwd 传下去】沙箱之外的工作区要在**启动时**挂第二份 9p
      // （一进程一 VM ⇒ 挂载只能在启动那一次决定），而"本次命令在哪个目录"
      // 是这里唯一知道的事（vm.js 的 extraShareRoot）。
      const cwd = typeof spec.cwd === 'string' ? spec.cwd : '';
      // 记下这次真实请求的 cwd：下一轮冷启动的静默预热就按它去挂第二份 9p（见 vm.js 的预热一节）
      rememberPrewarmCwd(cwd);
      const outcome = await ensureRunning({ cwd });
      if (!outcome.ok) {
        throw new Error(`端侧 VM 不可用：${outcome.error}`);
      }
      const live = session();
      if (live === null) throw new Error('端侧 VM 会话在就绪后消失（请重启应用）');
      return live;
    });
  };
  log(`已接管 ctx.subprocess.spawn（${decision.reason}）`);
  const memoryProfile = vmTierProfile();
  log(`VM 内存档位：${memoryProfile.tier} total=${memoryProfile.totalMib ?? '?'}MiB `
    + `guest=${vmMemoryMib(process.env, memoryProfile.totalMib)}MiB `
    + `tcg=${memoryProfile.tcgBufferMib}MiB minAvail=${memoryProfile.minAvailableMib}MiB`);

  // ── 侧边栏终端：`spawnTerminal` + 两个 shell 解析入口 ────────────────────────
  //
  // 【为什么是三个方法而不是一个】终端链路在到达 `spawnTerminal` 之前要先**解析 shell**：
  // `dsh-api-terminal-controller` 的 `resolveShell()` = `subprocess.terminalEnvironment()`
  // 取默认 shell → `subprocess.resolveExecutable(path)` 验它真的在。这两步在宿主沙箱里
  // 必然失败（没有 /bin/sh）⇒ 只包 `spawnTerminal` 的话，终端连"有哪些 shell"都问不出来，
  // 会话永远到不了我们这一跳。三个方法同生同死，判据都是上面那个 `decision`。
  let takenTerminal = 0;
  let delegatedTerminal = 0;
  if (terminalTakeoverEnabled(process.env)) {
    const acquire = async (cwd) => {
      const value = typeof cwd === 'string' ? cwd : '';
      rememberPrewarmCwd(value);
      return ensureRunning({ cwd: value });
    };
    if (typeof runtime.spawnTerminal === 'function') {
      const originalSpawnTerminal = runtime.spawnTerminal.bind(runtime);
      runtime.spawnTerminal = async (spec) => {
        const choice = shouldTakeOverTerminal(spec);
        if (!choice.take) {
          delegatedTerminal += 1;
          return originalSpawnTerminal(spec);
        }
        takenTerminal += 1;
        /*
         * 每次接管都留一行（含累计次数）：MatePad Edge 现场的"启动期连续建终端"只能靠
         * 这行计数判出来；失败在 createVmTerminal 里已有熔断，这里只负责把错误原文
         * 带进宿主日志（此前错误只回到前端，宿主侧看不到重试风暴）。
         */
        log(`终端接管请求 #${takenTerminal}：argv=${Array.isArray(spec && spec.argv) ? spec.argv.join(' ') : '(?)'}`);
        try {
          const handle = await createVmTerminal(spec, acquire);
          log(`终端接管请求 #${takenTerminal} 成功`);
          return handle;
        } catch (error) {
          const msg = error && error.message ? error.message : String(error);
          log(`终端接管请求 #${takenTerminal} 失败：${msg}`);
          throw error;
        }
      };
      log(`已接管 ctx.subprocess.spawnTerminal（${decision.reason}）`);
    } else {
      log('未接管 spawnTerminal：ctx.subprocess 上没有它（上游结构变化？）');
    }
    if (typeof runtime.terminalEnvironment === 'function') {
      // 默认 shell 指向 guest 的 /bin/sh：调用方随后一定会拿它去 resolveExecutable，
      // 而那个入口也由本插件回答（见下）⇒ 两步一致，不会自相矛盾。
      runtime.terminalEnvironment = async (signal) => {
        signal?.throwIfAborted();
        return { platform: 'posix', defaultShell: '/bin/sh' };
      };
    }
    if (typeof runtime.resolveExecutable === 'function') {
      const originalResolveExecutable = runtime.resolveExecutable.bind(runtime);
      runtime.resolveExecutable = async (command, env, signal) => {
        const mapped = guestShellPath(command);
        if (mapped === null) return originalResolveExecutable(command, env, signal);
        signal?.throwIfAborted();
        return mapped;
      };
    }
  } else {
    log('不接管终端：系统原生终端路线（DSHM_NATIVE_TERMINAL_ONLY=1）');
  }
  /*
   * 【延迟静默预热（2026-10-16 用户拍板第 5 件）】
   *
   * 原口径是"启动阶段一根手指都不碰 VM"（见 docs/155）：理由是会和 App 冷启动抢资源，且
   * "沙箱之外的工作区"要在**启动那一刻**由 cwd 定死第二份 9p（一进程一 VM，挂上就改不了）。
   * 用户现在的诉求是把第一条命令 / 第一次开终端那 8~13 s 挪走（"进 APP 之后多久都行，
   * 悄悄拉起来"）。三条约束一起满足：
   *   ① **延迟**：性能档默认 12 s（`DSHM_VM_PREWARM_SEC` 可改，夹在 5..600），避开 App 冷启动窗口；
   *   ② **更严的内存闸门**：`vmMinAvailableMib() + PREWARM_HEADROOM_MIB`（档位阈值 +512 MiB）——
   *      预热是后台行为，不许贴着可用内存下限偷；
   *   ③ **cwd 取真实记录**：`prewarm-cwd.txt` 存的是**上一次真实请求用过的目录**（spawn 与
   *      终端两条链都记）；首次运行回退 `DSHM_PUBLIC_DOWNLOAD`（默认工作区），两者都不可用时 fail-closed。
   * `DSHM_VM_PREWARM=off` 可整条关掉。
   */
  const plan = prewarmPlan();
  if (!plan.enabled) {
    log(`静默预热：已关闭（${plan.reason}）；首条 bash / 终端请求时才拉 guest VM`);
  } else {
    const timer = setTimeout(() => {
      const lifecycle = lifecycleGate('prewarm');
      if (!lifecycle.allow) {
        log(`静默预热跳过：${lifecycle.reason}`);
        return;
      }
      const budget = memBudget(vmMinAvailableMib() + PREWARM_HEADROOM_MIB);
      if (!budget.ok) {
        log(`静默预热跳过：${budget.reason}`);
        return;
      }
      const cwd = resolvePrewarmCwd();
      if (cwd.length === 0) {
        log('静默预热跳过：历史 cwd 与 DSHM_PUBLIC_DOWNLOAD 都不可用（不猜路径，避免把 9p 绑错目录）');
        return;
      }
      log(`静默预热开始：cwd=${cwd}（${budget.reason}）`);
      ensureRunning({ cwd, kind: 'prewarm' }).then((r) => {
        log(`静默预热结果：ok=${r.ok}${r.ok ? '' : ` err=${r.error}`}`);
      }).catch((e) => {
        log(`静默预热异常（不影响真实请求）：${e && e.message ? e.message : e}`);
      });
    }, plan.delayMs);
    ctx.effect(() => () => clearTimeout(timer));
    log(`静默预热已排程：${plan.reason}`);
  }
  ctx.effect(() => () => {
    log(`插件卸载：本进程累计接管 ${taken} 次、退回原实现 ${delegated} 次；终端接管 ${takenTerminal} 次、退回 ${delegatedTerminal} 次`);
    // 【插件重载不 stop() VM】一进程一 VM 且不可重启（见 vm.js 头注）：插件重载后
    // VM 还在跑，新实例可继续用同一条 QGA。**进程真正退出时**由宿主经
    // `globalThis.__DSHM_HOST_SHUTDOWN_HOOKS__` 调用下面导出的 shutdown()，
    // 走 QMP quit 优雅关机并等 worker 退出（P0-1 / docs/388）。
  });
}

/** 机器可读诊断（进宿主自检，不必靠用户复现）。 */
export function vmDiagnostics() {
  const decision = enabled();
  return { plugin: name, enabled: decision.enabled, reason: decision.reason, vm: diagnostics(), terminal: terminalDiagnostics() };
}

/** 宿主退出时的收尾（由宿主调用；幂等）。返回 Promise，宿主必须等它 settle。 */
export function shutdown() {
  return stop();
}
