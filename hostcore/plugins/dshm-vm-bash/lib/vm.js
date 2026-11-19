/*
 * VM 生命周期：分档判据之外，本文件是"把 guest 弄活"的全部机器。
 *
 * 【一进程一 VM —— 不是约定，是硬约束】上一轮 PoC 实测：同一进程里 `quit` 之后
 * 再起第二台 ⇒ **进程当场消失（无 faultlog）**。所以这里所有入口都收敛到单例
 * `state`，启动函数带重入闸门；真需要换 VM 只能重启应用（不提供"重启 VM"接口，
 * 免得有人把它做成按钮）。
 *
 * 【2026-10-08 第二次真机首跑：QGA 通了之后，卡点全在 guest 这一侧】三件事记在这里，
 * 免得下一轮又去猜：
 *   ① **QGA 通道可用**（客户端本身是上一轮的 bug，根因见 qga.js 头注）：真机读数
 *      `QGA sync 成功（3804 ms，跳过 1 行杂音）` → `QGA 就绪（+13446 ms）`。
 *   ② **自指符号链接**（见 provision ②）：原实现把"宿主沙箱根"当成链接目标，
 *      而它与 guest 沙箱镜像路径是**同一个字符串** ⇒ guest 里宿主路径恒不可达，现场只剩
 *      `DSHM_PROVISION_NO_PKG`（因为恰好死在紧接着的 `cd` 上）。
 *   ③ **工作区在应用沙箱之外时 guest 看不见它**（见 extraShareRoot / EXTRA_TAG）：
 *      授权按目录给（父目录 `opendir` 一律 EPERM）⇒ 只能把被授权的那一层挂上去。
 *  ⇒ 本轮补 ②③ 与"一进程一 VM"的**串行**闸门（startGate）。
 *
 * 【启动为什么是"延迟预热 + 按需兜底"（2026-10-16 用户拍板）】冷启动到 QGA 可用实测 8~13 s、
 * 常驻 VmRSS +1.22 GB。原口径是"启动期一根手指都不碰 VM"（避免和应用冷启动抢资源）；
 * 现在改成：**前台且静置一段时间后**才允许静默预热，预热前要过前后台闸门、"阈值 +512 MiB"
 * 的更严内存闸门，cwd 优先取"上一次真实请求用过的目录"；首次运行回退默认工作区。
 * 第一条真实请求到来时若还没预热，走的仍是同一条 `ensureRunning()`（并发由 pending 单飞，
 * 不会起两台）。【2026-10-17 APMS】1.1.3 的首例 QEMU `tcg_region_init` 崩溃
 * `foreground=false`，说明后台冷启动必须 fail-closed；同时把 TCG/guest 的固定预留收紧。
 *
 * 【rootfs 为什么复制到 el2】guest 首启要往镜像里写 bash（apk），而 el1 的
 * resfile 是只读的 ⇒ 必须有一份可写的运行副本（与 PoC 同做法：存在即复用，
 * 于是"装过 bash"这件事跨启动保留）。
 */
import { createConnection } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, opendirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QgaSession } from './qga.js';
import { GUEST_INIT_VERSION, guestInitInstallScript } from './guest-init.js';
import {
  GUEST_PKG_DIR, TERM_PORTS, assetsPresent, guestPkgDirReady, migrateLegacyPkgDir, qemuLibraryPath,
  resfileAsset, resfileVmDir, sockets, termSocket, vmWorkDir, workPath,
} from './paths.js';

/*
 * 【为什么要有一份 log()（2026-10-08 真机首跑 P0 的代价）】
 * 这一轮真机首跑只留下一个 koffi 原生断言就带走了整个进程，而本文件当时**一行日志都没有**
 * ⇒ 只能靠「进程消失 + 一句 C++ 断言」反推，等于盲猜。开 VM 是本档最贵、最容易在真机上
 * 出岔子的一步（dlopen / QEMU 入口 / QGA 握手 / guest provisioning 四跳），每一跳都必须
 * 在 node-output.log 留痕：那是端侧**可 `hdc shell` 直读**的通道（宿主进程 stdout 转写）。
 * TAG 与 index.js 同一枚，且【不打印任何用户数据】——只有阶段名、耗时、错误原文。
 */
function log(message) {
  try {
    console.log(`[dshm-vm-bash] ${message}`);
  } catch {
    /* 日志通道异常不许影响功能 */
  }
}

/** 与 guest 的约定：9p 共享标签。**不能改** —— guest 镜像里已按这个名字挂载。 */
const SHARE_TAG = 'hostshare';

/**
 * 第二份 9p 的标签（工作区在应用沙箱之外时用，见 extraShareRoot）。
 * 【为什么是第二份而不是把沙箱那层往上提】宿主给应用的目录授权是**按目录**给的：
 * 真机实测 `opendir('/storage/Users/currentUser/Download')` 一律 `EPERM`，而工作区
 * 那一层可以打开 ⇒ 只能把"被授权的那一层"挂上去，往上一级都挂不上。
 */
const EXTRA_TAG = 'hostshare2';

/**
 * guest 首启要在 el2 里建的那个符号链接（让宿主路径在 guest 里逐字成立）。
 *
 * 【不能写死 entry】三端共用同一插件：PC 是 `haps/entry/files`，手机是
 * `haps/phone/files`，平板是 `haps/tablet/files`。2026-10-24 手机真机实测把
 * `run-*.sh` 落在手机沙箱后，guest 里只存在 entry 链接 ⇒ QGA 执行
 * `/bin/bash /data/storage/el2/base/haps/phone/files/vm/tmp/run-*.sh` 直接 127。
 * 唯一真源是 ArkTS 传入的 `DSHM_SANDBOX_HOME`；兜底只为旧调试环境保留。
 */
export function guestSandboxFilesPath(env = process.env) {
  const sandbox = String(env.DSHM_SANDBOX_HOME || '').trim();
  return sandbox.length > 0 ? sandbox : '/data/storage/el2/base/haps/entry/files';
}

/** QGA 就绪等待上限：实测 11.8 s，给到 150 s 是留给"冷启动 + 首次解包 bash"的余量。 */
const READY_TIMEOUT_MS = 150000;

/**
 * `provision()` 两段各自的超时。
 *
 * 【为什么必须拆两段】（2026-10-13 早期真机实证）原来一整段 120 s：快路径（bash 已装）
 * 只要 ~200 ms，而**首装**的 `apk add` 在真机上就能超过 120 s —— 这台 桌面模式设备上 rootfs
 * 其实装成了（48631808 → 54087680 B、`/bin/bash` 后来可执行），命令却已按超时判死。
 * 更重的是本档「一进程一 VM」的闸门（`state.spawned`）就此**永久关死** ⇒ 此后每条命令
 * 都撞 `startGate`，用户必须重启应用（手机端首装实测也要 150~200 s，同属"没超时是运气"）。
 * 现在按"这一段在干什么"分别给时限：探测段 30 s（只挂载 + 判 `/bin/bash`），
 * 安装段 600 s（首装是分钟级；装完就跨启动保留，下次走 30 s 那段）。
 */
const PROVISION_PROBE_MS = 30000;
const PROVISION_INSTALL_MS = 600000;

/**
 * 老镜像「最小 init」迁移的超时（见 `guestInitInstallScript`）。
 *
 * 【为什么单独一段、而不是并进 provision】两件事失败原因完全不同：迁移只写两个小文件
 * （实测 TCI 档 <1 s），而 provision 要装包（分钟级）。并进 600 s 那段会让"迁移其实挂了"
 * 一直不被看见；并进 30 s 那段又会让 apk 首装把迁移的超时预算吃光。
 *
 * 【为什么失败不判死】迁移只影响**下一次**冷启动的速度：本次 VM 已经起来了、功能是好的。
 * 失败时只在日志与自检读数里留原文（`guestInit` 字段），让"下次还是慢"这条能被解释。
 */
const GUEST_INIT_TIMEOUT_MS = 60000;

/**
 * 串口尾部读多少字节（进日志）。
 *
 * 【为什么改成落盘而不是内存】（2026-10-08 真机 P1 的代价）原实现是 `-serial unix:<socket>`
 * 由宿主连上去收字节，而 QEMU 的 unix chardev 在**没有读端**时按 posix 语义「写成功即丢弃」
 * （不阻塞、不留存）⇒ 真机上串口恒 0 B，「内核/initramfs 到底走到哪一步」永远无解，
 * 只剩一句 `QGA 在 150000 ms 内没有就绪`。改成 `-chardev file,…` 之后 QEMU 直接写文件，
 * 失败现场**持久留痕**：既可由本文件读尾部进日志，也可 `hdc file recv` 取回宿主侧按字节看。
 */
const SERIAL_TAIL_BYTES = 2000;

/** 进自检报文的串口读数上限（比日志宽一点，仍是「尾部」）。 */
const SERIAL_DIAG_BYTES = 4000;

const state = {
  phase: 'idle',            // idle | staging | starting | waiting-qga | provisioning | ready | failed
  detail: '',
  worker: null,
  session: null,
  startedAt: 0,
  readyAt: 0,
  attempt: 0,
  lastError: '',
  preloaded: null,
  // 【一进程一 VM 的硬闸门】本进程是否**已经真的拉起过** QEMU（见 startGate）。
  spawned: false,
  // 本次启动绑定的"沙箱之外的工作区"（没有则为 null），见 extraShareRoot。
  extraShare: null,
  // 就绪之后又来了"绑定之外的 cwd"的次数（见 ensureRunning 的 ready 早退）。
  // 一进程一 VM ⇒ 这类 cwd 本次不可见；计数是给自检一个可读的证据，而不是静默。
  cwdMiss: 0,
  // 老镜像「最小 init」迁移的结果：pending | current | installed | failed（进自检读数）。
  guestInit: 'pending',
  // 可选 SSH 工具：pending | lazy（首次调用时安装） | ready | failed。
  guestSsh: 'pending',
};

/**
 * POSIX 单引号包裹（与 handle.js 的 shq 同口径，本文件自带一份以免跨模块耦合）。
 */
function shq(value) {
  return `'${String(value).split("'").join("'\\''")}'`;
}

/**
 * 本进程还能不能启动 VM（纯函数，离线门禁直接对两种记录下断言）。
 *
 * 【为什么必须有这道闸门】"一进程一 VM"不是偏好而是硬约束：上一轮 PoC 实测
 * `quit` 之后再起第二台，**进程当场消失（无 faultlog）**。而 `ensureRunning()` 原来的
 * 重入闸门只挡住**并发**调用（`pending` 单飞）；**串行**的第二次调用（第一次失败之后
 * 再来一条命令）会绕过它 ⇒ 真的起第二台 ⇒ 应用进程消失。真机排障时"连点两条 bash"
 * 正是这么把进程带走的。
 *
 * 判据放在"**已经拉起过 QEMU**"上（而不是"启动流程走过"）：只有真正 spawn 过 worker
 * 才算，这样"资产缺失/环境变量缺失"这类在 spawn 之前的失败不会白白吃掉这一次机会。
 * @param record 本进程的 VM 记录（`state`）
 * @returns `{allow, reason}`
 */
export function startGate(record) {
  if (record.spawned === true) {
    return {
      allow: false,
      reason: '本进程已经启动过一台 guest VM（一进程一 VM 是硬约束）⇒ 不再启动第二台；要换 VM 请重启应用',
    };
  }
  return { allow: true, reason: '本进程还没起过 VM' };
}

/**
 * 启动 VM 前至少要有多少可用内存（MiB）——纯函数 `memBudget` 的默认阈值。
 *
 * 【为什么是 1280】实测 guest VM 常驻 VmRSS ≈ 1.22 GB（`docs/119`），加上 tb-size
 * （见 bootArgv 的 tb-size）与 QEMU 自身结构，取 1.25 GiB 作地板。它只是"明显不够就
 * 别试"的粗闸门，不是精确预算：Mate80 实测 MemAvailable ≈ 3.3 GiB、Mate60 上架自检
 * 现场 4.9 GB ⇒ 正常手持设备（含平板）都不会被误拦。
 */
export const VM_MIN_AVAILABLE_MIB = 1280;

/**
 * guest 的物理内存（MiB）—— `DEFAULT_VM_MEMORY_MIB` 是默认值，可用
 * `DSHM_VM_MEMORY_MIB` 覆盖（见 `vmMemoryMib`）。
 *
 * 【2026-11-19 调回 512 / 1024】上一轮为压 QEMU 预留把经济档降到 256 MiB，真机反馈
 * guest 侧偏紧（pnpm / 安装类命令吃紧）。用户要求适度放开：经济档 512、性能档 1024。
 * guest size 只是**地址空间上限**、不是常驻峰值（`prealloc=off` + `merge=off`，触碰多少
 * 才占多少），抬高上限对低内存设备的常驻影响有限，但能显著缓解 guest 内 OOM。
 *
 * 【为什么必须留 env 回退口】`DSHM_VM_MEMORY_MIB` 可在不重打包的前提下覆盖
 * （真机对照臂就靠它，见 `tools/check-vm-bash.mjs` 的内存一节）。
 */
export const VM_MEMORY_DEFAULT_MIB = 512;
/** 16G+ 性能档的 guest 物理内存。 */
export const VM_MEMORY_PERFORMANCE_MIB = 1024;

/**
 * TCG 翻译缓存（MiB）。TCI 解释档仍然需要一个 buffer，但不再生成可执行翻译页。
 * 2026-11-19 起 guest 改为 **2 vCPU**（`-smp cpus=2`），TCG region 数随 vCPU 增长，
 * 按 2 倍预留：经济档 128 MiB、性能档 512 MiB（仍远小于 JIT 档的历史 2048）。
 */
export const VM_TCG_BUFFER_MIB = 128;
/** 16G+ 性能档的 TCG 翻译缓存（2 vCPU 下按 2× 预留）。 */
export const VM_TCG_BUFFER_PERFORMANCE_MIB = 512;
/** 16G+ 性能档启动 VM 前的可用内存地板。 */
export const VM_MIN_AVAILABLE_PERFORMANCE_MIB = 1792;
/**
 * 12G 与 16G 产品的实际 `/proc/meminfo` MemTotal 都低于标称值。
 * 14 GiB 能把约 11–12 GiB 的 12G 机型和约 15 GiB 的 16G 机型稳定分开。
 */
export const VM_PERFORMANCE_MEM_TOTAL_MIB = 14 * 1024;

/** guest 内存的允许区间（MiB）：低于下限 guest 起不来，高于上限手持设备扛不住。 */
export const VM_MEMORY_MIN_MIB = 192;
export const VM_MEMORY_MAX_MIB = 2048;

/** 读 `/proc/meminfo` 的 `MemTotal`（MiB）；读不到返回 null。 */
export function defaultMemTotal() {
  try {
    const text = readFileSync('/proc/meminfo', 'utf8');
    const match = /^MemTotal:\s+(\d+)\s*kB/m.exec(text);
    if (match === null) return null;
    const mib = Math.floor(Number(match[1]) / 1024);
    return Number.isFinite(mib) ? mib : null;
  } catch {
    return null;
  }
}

/** 物理内存分档：未知/不足 14 GiB 走 economy，16G+ 走 performance。 */
export function memoryTier(totalMib = defaultMemTotal()) {
  return typeof totalMib === 'number' && Number.isFinite(totalMib)
    && totalMib >= VM_PERFORMANCE_MEM_TOTAL_MIB ? 'performance' : 'economy';
}

/** 当前设备应使用的 VM 配额（纯函数，可注入总内存）。 */
export function vmTierProfile(env = process.env, totalMib = defaultMemTotal()) {
  const tier = memoryTier(totalMib);
  const performance = tier === 'performance';
  return {
    tier,
    totalMib: typeof totalMib === 'number' && Number.isFinite(totalMib) ? totalMib : null,
    defaultMemoryMib: performance ? VM_MEMORY_PERFORMANCE_MIB : VM_MEMORY_DEFAULT_MIB,
    tcgBufferMib: performance ? VM_TCG_BUFFER_PERFORMANCE_MIB : VM_TCG_BUFFER_MIB,
    minAvailableMib: performance ? VM_MIN_AVAILABLE_PERFORMANCE_MIB : VM_MIN_AVAILABLE_MIB,
  };
}

/**
 * 解析 guest 内存大小（纯函数，`env` 是注入点）。
 *
 * 缺省 / 非法（非数字、≤0）一律回默认值；越界**钳到区间端点而不报错** —— 这是资源参数，
 * 取个合理的邻近值远好过让整条 VM 通道因为一个环境变量打错字而失效。
 * @param env 环境变量表（默认 `process.env`）
 * @returns 整数 MiB
 */
export function vmMemoryMib(env = process.env, totalMib = defaultMemTotal()) {
  const profile = vmTierProfile(env, totalMib);
  const raw = String(env.DSHM_VM_MEMORY_MIB ?? '').trim();
  if (raw.length === 0) return profile.defaultMemoryMib;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return profile.defaultMemoryMib;
  const rounded = Math.round(value);
  if (rounded < VM_MEMORY_MIN_MIB) return VM_MEMORY_MIN_MIB;
  if (rounded > VM_MEMORY_MAX_MIB) return VM_MEMORY_MAX_MIB;
  return rounded;
}

/** 当前档位的 TCG buffer（MiB）。 */
export function tcgBufferMib(env = process.env, totalMib = defaultMemTotal()) {
  return vmTierProfile(env, totalMib).tcgBufferMib;
}

/** 当前档位启动 VM 前的 MemAvailable 地板（MiB）。 */
export function vmMinAvailableMib(env = process.env, totalMib = defaultMemTotal()) {
  return vmTierProfile(env, totalMib).minAvailableMib;
}

/**
 * 读 `/proc/meminfo` 的 `MemAvailable`（MiB）。读不到/解析不出返回 null。
 *
 * 【为什么是 MemAvailable 而不是 MemFree】`MemFree` 不含可回收的页缓存，会把"其实
 * 还能挤出内存"的设备误判成不足；`MemAvailable` 才是内核给"还能分配多少"的估计。
 */
function defaultMemAvailable() {
  try {
    const text = readFileSync('/proc/meminfo', 'utf8');
    const match = /^MemAvailable:\s+(\d+)\s*kB/m.exec(text);
    if (match === null) return null;
    const mib = Math.floor(Number(match[1]) / 1024);
    return Number.isFinite(mib) ? mib : null;
  } catch {
    // 读不到（非 Linux / procfs 被收紧 / 权限）⇒ null，由 memBudget fail-open。
    return null;
  }
}

/**
 * 设备可用内存够不够开 guest VM（纯函数，`readAvailable` 是注入点）。
 *
 * 【为什么必须在 spawn 之前拦】QEMU 的 `tcg_region_init` 在逐 region 设页保护时
 * `mprotect` 失败即 `exit(1)`，而 appspawn 把这个 exit 变成 **SIGABRT 拖死整个宿主
 * 进程**（2026-10-10 Mate60 上架自检 CppCrash 的真机现场：`Unexpected call: exit(1)`
 * + 崩溃 PC `tcg_region_init+1944`）。这个 exit 发生在 worker 线程里、是原生 abort，
 * 宿主 **catch 不到**（`docs/121` 的同族教训）⇒ 唯一的防线是"别在内存不足时把 QEMU
 * 拉起来"（内存吃紧会同时抬高分配与页保护失败的概率）。
 *
 * 【readAvailable() 返回 null 一律 fail-open】读不到读数时**不拦**：宁可让 QEMU 自己
 * 去试（最坏退回原实现），也不能因为"读不到 /proc/meminfo"就把整个手持档功能关掉。
 * @param needMib 需要的可用内存下限（MiB），默认 `VM_MIN_AVAILABLE_MIB`
 * @param readAvailable 读数注入点，默认读 `/proc/meminfo`
 * @returns `{ok, availableMib, needMib, reason}`
 */
export function memBudget(needMib = VM_MIN_AVAILABLE_MIB, readAvailable = defaultMemAvailable) {
  const availableMib = readAvailable();
  if (availableMib === null || availableMib === undefined) {
    return {
      ok: true,
      availableMib: null,
      needMib,
      reason: `读不到 MemAvailable ⇒ 不拦截（fail-open；阈值 ${needMib} MiB）`,
    };
  }
  if (availableMib < needMib) {
    return {
      ok: false,
      availableMib,
      needMib,
      reason: `设备可用内存不足（MemAvailable ${availableMib} MiB < 阈值 ${needMib} MiB）`
        + '⇒ 不启动 guest VM，命令按本档既有事实退回"跑不了"；释放内存后可重试',
    };
  }
  return {
    ok: true,
    availableMib,
    needMib,
    reason: `MemAvailable ${availableMib} MiB ≥ 阈值 ${needMib} MiB`,
  };
}

/**
 * 应用前后台状态文件。ArkTS 主窗在 onForeground / onBackground 同步覆写，
 * Node 侧只读。放在 `$DSHM_HOME` 下，是因为它和 host-ready.json、退出请求走同一个
 * 可写目录，不新增任何权限或跨进程 IPC。
 */
export function appLifecyclePath(env = process.env) {
  const home = String(env.DSHM_HOME || '').trim();
  return home.length === 0 ? '' : join(home, 'app-lifecycle.json');
}

/** 默认返回 unknown；只有同 pid、字段完整的 JSON 才认。 */
export function readLifecycleState(env = process.env) {
  const file = appLifecyclePath(env);
  if (file.length === 0) {
    return { known: false, foreground: null, source: '', updatedAt: '' };
  }
  try {
    const payload = JSON.parse(readFileSync(file, 'utf8'));
    if (`${payload?.pid ?? ''}` !== `${process.pid}` || typeof payload?.foreground !== 'boolean') {
      return { known: false, foreground: null, source: '', updatedAt: '' };
    }
    return {
      known: true,
      foreground: payload.foreground,
      source: typeof payload?.source === 'string' ? payload.source : '',
      updatedAt: typeof payload?.updatedAt === 'string' ? payload.updatedAt : '',
    };
  } catch {
    return { known: false, foreground: null, source: '', updatedAt: '' };
  }
}

/**
 * 冷启动闸门：应用明确在后台时，任何第一次 QEMU 拉起都拒绝。
 * 预热更严：状态未知也不猜前台（旧状态文件/写盘失败时跳过预热）。
 * 已经 running 的 VM 不经过这里，后台任务仍可继续使用。
 */
export function lifecycleGate(kind = 'request', lifecycle = readLifecycleState()) {
  const prewarm = kind === 'prewarm';
  const state = lifecycle !== null && typeof lifecycle === 'object'
    ? lifecycle
    : { known: false, foreground: null, source: '' };
  if (state.known !== true) {
    return prewarm
      ? { allow: false, reason: '应用前后台状态未知 ⇒ 不静默预热（真实请求仍可走兼容路径）' }
      : { allow: true, reason: '应用前后台状态未知 ⇒ 真实请求按兼容路径放行' };
  }
  if (state.foreground !== true) {
    return {
      allow: false,
      reason: `应用当前在后台（${state.source || '未知来源'}）⇒ 不冷启动 guest VM；`
        + '回到前台后再试（已运行的 VM 不受影响）',
    };
  }
  return { allow: true, reason: `应用在前台（${state.source || '未知来源'}）` };
}

/* ── 延迟静默预热（2026-10-16，用户拍板第 5 件）─────────────────────────────
 *
 * 【要解决什么】终端/第一条 bash 的冷启动要 8~13 s（QEMU TCG 起 guest + QGA 握手）。
 * 用户希望"进 APP 之后等一会儿，悄悄把它拉起来"，这样第一次开终端就是即时的。
 *
 * 【为什么不能像普通预热那样"启动即拉"】① 会和 App 冷启动抢 CPU / 内存（`docs/146` 的
 * LOOP-GAP 教训）；② 一进程一 VM，而"要不要第二份 9p（沙箱外工作区）"是在**启动那一刻**
 * 由 cwd 定死的 ⇒ 预热时给错 cwd，用户真正的工作区在 guest 里就看不见了。
 * 所以本轮设计成：**延迟**（性能档默认 12 s，可配可关）+ **更严的内存闸门**（阈值 + 余量）
 * + **cwd 优先取"上一次真实请求用过的目录"**；首次运行没有记录时回退到 ArkTS 已认领的
 * `DSHM_PUBLIC_DOWNLOAD`，让默认工作区也能在用户第一次打开终端前完成预热。
 *
 * 【开关】12G economy 默认关，16G+ performance 默认开；`DSHM_VM_PREWARM=on/off` 可覆盖，
 * `DSHM_VM_PREWARM_SEC=<秒>` 改延迟（默认 12，夹在 5..600）。
 *
 * 【两档默认策略】12G economy 继续默认关闭，避免低内存设备为终端预热承担 QEMU 常驻；
 * 16G+ performance 在更严的内存余量通过后默认开启，并把延迟从旧版 60 s 缩到 12 s，
 * 让用户在默认工作区正常进入后再开终端时通常已命中预热。显式 `off` 仍始终优先。
 */
export const PREWARM_DEFAULT_SEC = 12;
/** 预热要求的内存余量（MiB）：叠加在 `VM_MIN_AVAILABLE_MIB` 之上，避免贴着阈值偷内存。 */
export const PREWARM_HEADROOM_MIB = 512;

/** 预热计划（纯函数，`env` 是注入点）。 */
export function prewarmPlan(env = process.env, totalMib = defaultMemTotal()) {
  const profile = vmTierProfile(env, totalMib);
  const raw = String(env.DSHM_VM_PREWARM ?? '').trim().toLowerCase();
  const on = raw === 'on' || raw === '1' || raw === 'true' || raw === 'yes';
  const off = raw === 'off' || raw === '0' || raw === 'false' || raw === 'no';
  const performanceDefault = raw.length === 0 && profile.tier === 'performance';
  if (!on && !(performanceDefault && !off)) {
    /* 默认（未设置）也走这里：显式写明原因，便于真机日志判读 */
    const why = raw.length === 0
      ? `默认关（${profile.tier} 档；DSHM_VM_PREWARM=on 才开）`
      : `DSHM_VM_PREWARM=${raw}`;
    return { enabled: false, delayMs: 0, reason: why };
  }
  const sec = Number(String(env.DSHM_VM_PREWARM_SEC ?? '').trim());
  const delaySec = Number.isFinite(sec) && sec > 0 ? Math.min(600, Math.max(5, Math.round(sec))) : PREWARM_DEFAULT_SEC;
  const source = on ? 'DSHM_VM_PREWARM=on' : `${profile.tier} 档默认开`;
  return { enabled: true, delayMs: delaySec * 1000, reason: `延迟 ${delaySec}s 后预热（${source}）` };
}

/** 记录"上一次真实请求用过的 cwd"的文件（落在 VM 运行目录里，跨启动保留）。 */
export function prewarmCwdPath() {
  const dir = vmWorkDir();
  return dir.length === 0 ? '' : join(dir, 'prewarm-cwd.txt');
}

/** 读上一次真实请求使用的 cwd（没有 / 读不到 ⇒ 空串）。 */
export function readPrewarmCwd() {
  const file = prewarmCwdPath();
  if (file.length === 0) return '';
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 解析本次预热使用的工作区：
 * 1. 优先使用上一次真实 spawn/终端请求记录的 cwd；
 * 2. 首次运行时退回 ArkTS 已认领的 `DSHM_PUBLIC_DOWNLOAD`；
 * 3. 两者都打不开时返回空串，保持 fail-closed，不拿猜测路径启动 QEMU。
 */
export function resolvePrewarmCwd(env = process.env, recalled = readPrewarmCwd(), canOpen = defaultCanOpen) {
  const remembered = typeof recalled === 'string' ? recalled.trim() : '';
  if (remembered.length > 0 && canOpen(remembered)) return remembered;
  const fallback = String(env.DSHM_PUBLIC_DOWNLOAD || '').trim();
  if (fallback.length > 0 && canOpen(fallback)) return fallback;
  return '';
}

/** 真实请求带 cwd 时记一笔（失败只忽略：它只是让**下一次**冷启动能预热）。 */
export function rememberPrewarmCwd(cwd) {
  const file = prewarmCwdPath();
  const value = typeof cwd === 'string' ? cwd.trim() : '';
  if (file.length === 0 || value.length === 0) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${value}\n`, 'utf8');
  } catch {
    /* 记不上不影响任何功能 */
  }
}

/** 目录能不能被**打开**（不是 stat）—— 这才是宿主文件访问授权的真实粒度。 */
function defaultCanOpen(dir) {
  try {
    const handle = opendirSync(dir);
    handle.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * 本次启动要不要再挂一份 9p 共享（纯函数，`canOpen` 是注入点）。
 *
 * 【为什么需要它】工作区可以落在应用沙箱**之外**（用户在"下载/文档"里挑的目录，
 * `docs/103`/`docs/105` 的授权链路）。那种目录不在 fsdev0 的 path 里 ⇒ guest 里
 * `cd <宿主工作区>` 只会说"不存在"。所以：沙箱内的 cwd 什么都不用做（fsdev0 已覆盖），
 * 沙箱外的 cwd 就**把工作区自己**挂成第二份共享。
 *
 * 【为什么往上走到最上层可打开的那一级】授权落在哪一层只有内核知道 ⇒ 直接问它：
 * 从 cwd 逐级往上 `opendir`，能打开的最后一层就是"授权给的根"。真机上
 * `/storage/Users/currentUser/Download` 打不开、工作区打得开 ⇒ 根 = 工作区本身；
 * 如果用户的授权给的是更上层，这里就会自动挂更上层（同一根下的多个工作区一次覆盖）。
 *
 * 【取不到时一律返回 null】目录不存在/没授权 ⇒ 不硬挂（QEMU 启动时会因 path 不存在
 * 直接失败，比"少挂一份共享"严重得多）。
 * @param cwd 本次 spawn 的工作目录
 * @param sandbox 应用沙箱根（`DSHM_SANDBOX_HOME`）
 * @param canOpen 目录可打开性判据（注入点，默认问文件系统）
 * @returns 需要挂的宿主目录，或 null
 */
export function extraShareRoot(cwd, sandbox, canOpen = defaultCanOpen) {
  const override = String(process.env.DSHM_VM_EXTRA_SHARE || '').trim();
  if (override.length > 0) return override;
  const target = String(cwd || '').trim();
  if (target.length === 0 || target === '/') return null;
  const base = String(sandbox || '').trim();
  if (base.length > 0 && (target === base || target.startsWith(base + '/'))) return null;
  if (!canOpen(target)) return null;
  let root = target;
  for (;;) {
    const parent = dirname(root);
    if (parent === root || parent === '/' || parent.length === 0) break;
    if (!canOpen(parent)) break;
    root = parent;
  }
  return root;
}

/**
 * 构造 QEMU argv。
 *
 * 取值全部来自上一轮 PoC 的**实跑** argv（`dist/poc-hish-vm/poc_vm.py:27`），只替换
 * 三处与本集成相关的路径：共享目录（改成应用沙箱根 ⇒ 工作区在 guest 里可见）、
 * rootfs（改成 el2 的可写副本）、固件目录（保持 resfile，只读使用）。
 */
function bootArgv(extraShare = state.extraShare) {
  const res = resfileVmDir();
  const extra = typeof extraShare === 'string' && extraShare.length > 0 ? extraShare : null;
  const share = String(process.env.DSHM_SANDBOX_HOME || '').trim();
  const sock = sockets();
  const root = workPath('rootfs.qcow2');
  // guest 内存：`mem0` 的 size 与 `-m` 是同一份内存的两种说法（`-machine` 已把
  // `memory-backend=mem0`），所以**只取一个变量**喂两处 —— 写死两份常量迟早会漂。
  const memMib = vmMemoryMib();
  // 【为什么要有 earlycon】`console=ttyAMA0` 要等 PL011 驱动 probe 完才生效，
  // 而真机 P1 的症状（`query-status=running` 却永远等不到 QGA、串口恒 0 B）恰恰可能是
  // **更早**就停了（解压/MMU/PSCI/设备树）。earlycon 直写 PL011，把这之前的输出也捞出来。
  const append = 'root=/dev/sda rw rootfstype=ext4 rootwait earlycon=pl011,0x09000000 '
    + 'console=tty0 console=ttyAMA0 consoleblank=0 '
    + 'elevator=noop skew_tick=1 acpi=on mitigations=off audit=0 nmi_watchdog=0 hardened_usercopy=off '
    + 'random.trust_cpu=on virtio_balloon.config_impl=0 security=none selinux=0 apparmor=0 psi=0 '
    + 'page_alloc.shuffle=0 swiotlb=noforce idle=halt cpuidle.off=1 transparent_hugepage=always pci=noaer '
    + 'scsi_mod.use_blk_mq=1 rng_core.default_quality=1000 '
    + 'systemd.mask=run-lock.mount systemd.mask=sys-kernel-debug.mount systemd.mask=dev-hugepages.mount '
    + 'cryptomgr.notests rodata=off rcupdate.rcu_cpu_stall_timeout=60 rcu_expedited=1 init_on_free=0 '
    + 'init_on_alloc=1 page_poison=0 slub_debug=- TERM=xterm init=/init';
  const argv = [
    'qemu-system-aarch64',
    '-machine', 'virt,acpi=on,gic-version=max,iommu=none,its=off,usb=off,virtualization=off,'
      + 'memory-backend=mem0,compact-highmem=on,dump-guest-core=off,mem-merge=off,hmat=off',
    '-overcommit', 'cpu-pm=off',
    '-cpu', 'max,pauth-impdef=on,sve=off,pmu=off',
    // 【`-accel` 里为什么一个 split-wx 都不带】（2026-10-14 TCI 换轨后定稿）
    // 上一版随包的是 **JIT 档** .so：匿名码缓冲路径 `tcg_region_init` 要
    // `mprotect(…, 0x7)`（RWX），被鸿蒙应用域拒成 EINVAL ⇒ QEMU 在 worker 线程里
    // `exit(1)` ⇒ appspawn 转成 SIGABRT，宿主**catch 不到**、整个进程当场消失
    // （同 `docs/121` 的族）。当时靠 `split-wx=on`（memfd 双映射，RW/RX 分开）绕开，
    // 反汇编与真机取证逐条留在 `docs/154`。
    // 现在两份 .so（`third_party/vmhish/` 与 `entry/libs/arm64-v8a/`，同一 sha256）
    // 已换成 **TCI 解释器档**（`--enable-tcg-interpreter`）：解释执行不生成可执行翻译
    // 缓存，既用不上 split-wx、**也不接受它** —— 真机逐字：
    //   qemu-system-aarch64: -accel tcg,thread=multi,tb-size=256,split-wx=on:
    //     jit split-wx not supported
    // 之后同样是原生退出（宿主无栈可查、串口 0 B）。⇒ 这项**永远不许复活**，
    // `tools/check-vm-bash.mjs` 用"任何形态的 split-wx 都零命中"钉住。
    // 2 vCPU（cpus=2）下 TCG region 随 vCPU 增长；经济档 128 MiB，16G+ 性能档 512 MiB。
    '-accel', `tcg,thread=multi,tb-size=${tcgBufferMib()}`,
    '-object', 'rng-random,filename=/dev/urandom,id=rng0',
    '-device', 'virtio-rng-pci-non-transitional,rng=rng0',
    '-rtc', 'base=utc,clock=host',
    '-L', res,
    '-display', 'none',
    // 串口写文件（不是 socket）：见 SERIAL_TAIL_BYTES 的注释 —— unix chardev 无读端即丢弃。
    '-chardev', `file,id=ser0,path=${workPath('serial.log')}`,
    '-serial', 'chardev:ser0',
    // 【终端端口的 chardev：socket】宿主 `net.connect(<vm>/tmp/term<i>)` 一条连接就是双向字节流。
    // 这里**只**声明 chardev，tty 那一半由下面 virtio-serial 控制器之后的 `-device virtconsole`
    // 提供（QEMU 按命令行顺序 realize，设备不能引用还不存在的总线 ⇒ 两截必须分开写）。
    // 0 号留给控制台日志（上面那条 file chardev）⇒ 终端从 1 号开始，与 paths.js 的
    // `termSocket/termTty` 一一对应。
    ...Array.from({ length: TERM_PORTS }, (_, k) => {
      const index = k + 1;
      return ['-chardev', `socket,id=term${index},path=${termSocket(index)},server=on,wait=off`];
    }).flat(),
    '-smp', 'cpus=2,sockets=1,cores=2,threads=1',
    // 【两处同源】见上面 `memMib` 的注释；`DSHM_VM_MEMORY_MIB` 一改，两处一起变。
    '-object', `memory-backend-ram,id=mem0,size=${memMib}M,merge=off,prealloc=off`,
    '-m', `${memMib}M`,
    '-kernel', join(res, 'kernel_aarch64'),
    '-netdev', 'user,id=eth0',
    '-device', 'virtio-net-pci-non-transitional,netdev=eth0,csum=on,gso=on,guest_tso4=on,'
      + 'guest_tso6=on,guest_ecn=off,mrg_rxbuf=on,tx=bh',
    /*
     * 【9p 权限模型：为什么两份都必须 `mapped-*`，不能用 `none`（2026-10-08 真机实测定案）】
     *
     * 两档都上过真机，判据只有一条：「guest 能不能往**用户自己的工作区**写」。
     *
     *   · `none`（`+dshm.22` 用过一版）：QEMU 会**按 guest 请求的 uid/gid 落盘**（impersonate）。
     *     而宿主给应用的「工作区授权」是**按应用**给的（`docs/105`：授权只对该应用有效，
     *     父目录 `opendir` 一律 `EPERM`）—— 换成 uid 0 就落在授权之外 ⇒ guest 里的
     *     `touch` / `mkdir` / `echo >` 全部 `Operation not permitted`。真机两轮读数一致：
     *       工作区（宿主侧 `drwxrwx--x 20001006:1006`）⇒ `touch_ws=1` / `mkdir_ws=1`（2/2 复现）；
     *       沙箱共享根（`drwxrwxrwx 20020450:20020450`）⇒ `touch_sbox=0`。
     *     即：`none` 只在「宿主 uid 自己就有 DAC 写权限」的目录里能用 —— 而用户挑的工作区
     *     恰恰是**授权目录、不是自有目录**的那一类 ⇒ 它对本档是错档。
     *   · `mapped-file`（本档长期配置，也是 HiSH 上游的配置，见 `docs/119` §共享目录）：
     *     QEMU **从不 impersonate**，始终以本应用的身份落盘（授权照旧生效），uid/gid/mode
     *     记在 `<共享目录>/.virtfs_metadata/<名>.virtfs_metadata` 旁挂件里。
     *     代价就是那些旁挂件：用户工作区里会出现一个 `.virtfs_metadata/` 隐藏目录，
     *     且**删掉原文件后旁挂件不消失**（真机曾留下 6 个孤儿，形如
     *     `dshm-term-proof.txt.virtfs_metadata`）。本轮的处置：**回到 `mapped-file` 保证能写**，
     *     并在 `stage()` 起点把旁挂件清掉（`sweepSidecars()`；只动 `.virtfs_metadata/`
     *     这一个我们自己造的命名空间）。
     *
     * 【为什么不用 `passthrough`】它同样按 guest 的 uid 去 `chown`，而 QEMU 不是 root
     * ⇒ 每一次写都可能 EPERM，把「能写」变成「看运气」。
     * 【为什么不是 `mapped-xattr`】它把 uid/gid 记在 `user.virtfs.*` 扩展属性上（旁挂件就没了），
     * 但 `/storage/Users/currentUser/**` 这一层支不支持 user xattr 本仓没实测过 ⇒ 留作
     * 下一轮候选，本轮先用**已验证能写**的这一档（判据现状优先于整洁）。
     */
    '-fsdev', `local,security_model=mapped-file,id=fsdev0,path=${share}`,
    '-device', `virtio-9p-pci,id=fs0,fsdev=fsdev0,mount_tag=${SHARE_TAG}`,
    // 【第二份 9p：沙箱之外的工作区】授权是按目录给的（见 EXTRA_TAG 的注释），
    // 所以挂的就是工作区那一层、且挂到**同一个绝对路径**上 —— 这样 guest 里的
    // `pwd`、相对路径、报错里的路径与宿主侧逐字一致。没有这种工作区时一个参数都不加。
    ...(extra === null ? [] : [
      // 与 fsdev0 同档：两份的判据只有一条（guest 能不能在**授权目录**里写），
      // 混档只会制造「一份能写、一份不能写」的假象（`+dshm.22` 就是这么翻的车）。
      '-fsdev', `local,security_model=mapped-file,id=fsdev1,path=${extra}`,
      '-device', `virtio-9p-pci,id=fs1,fsdev=fsdev1,mount_tag=${EXTRA_TAG}`,
    ]),
    '-global', 'virtio-blk-pci.scsi=off',
    '-global', 'virtio-scsi-pci.cmd_per_lun=128',
    '-global', 'virtio-scsi-pci.packed=on',
    '-drive', `if=none,format=qcow2,file=${root},id=hd0,cache=writeback,aio=threads,discard=unmap`,
    '-object', 'iothread,id=iothread0,poll-max-ns=2000000',
    '-device', 'virtio-scsi-pci-non-transitional,id=scsi0,num_queues=1,virtqueue_size=256,iothread=iothread0',
    '-device', 'scsi-hd,drive=hd0,bus=scsi0.0,logical_block_size=4096,physical_block_size=4096,'
      + 'rotation_rate=1,bootindex=1',
    '-append', append,
    '-qmp', `unix:${sock.qmp},server,nowait`,
    '-device', 'virtio-serial-pci-non-transitional,id=virtio-serial0',
    '-chardev', `socket,path=${sock.qga},server=on,wait=off,id=qga0`,
    '-device', `virtserialport,chardev=qga0,bus=virtio-serial0.0,name=org.qemu.guest_agent.0`,
    // 【侧边栏终端的 tty：console 型 virtio 端口】放在控制器与 QGA 之后（总线先 realize）。
    // 第 i 个 virtconsole ↔ guest 的 `/dev/hvc<i-1>`：hvc 号只发给 **console 型**端口、按枚举
    // 顺序分配，而 QGA 那条 virtserialport 是普通 port（`/dev/vportXpY`，不是 tty）**不占号**
    // ⇒ 映射确定。真机实证（作业控制 / 窗口尺寸 / 双向字节）见 paths.js 的 TERM_PORTS 头注。
    ...Array.from({ length: TERM_PORTS }, (_, k) => {
      const index = k + 1;
      return ['-device', `virtconsole,chardev=term${index},id=vc${index},bus=virtio-serial0.0`];
    }).flat(),
  ];
  return argv;
}

/** rootfs 可写副本 + guest 包闭包落到 el2（存在即复用）。 */
function stage() {
  const vmDir = vmWorkDir();
  if (vmDir.length === 0) throw new Error('DSHM_SANDBOX_HOME 缺失，无法定位 VM 运行目录');
  mkdirSync(join(vmDir, 'tmp'), { recursive: true });
  const root = join(vmDir, 'rootfs.qcow2');
  if (!existsSync(root)) {
    copyFileSync(resfileAsset('rootfs_aarch64.qcow2'), root);
  }
  // 上一代运行目录里那个包闭包目录（`apk/`）就地改名到 `guestpkgs/`：改名不是删除，
  // 失败就落到下面这条正常复制路径（el2 是用户数据，任何情况下都不 unlink）。
  migrateLegacyPkgDir();
  stageGuestPackages();
  // 上一轮的陈旧 socket 必须清掉：`server` 模式在文件已存在时不一定能覆盖。
  // 其中 `serial_socket` 是**上一版**（unix chardev）遗留的：本版串口走文件，一并清掉，
  // 免得看到 tmp/ 里还躺着它就以为串口还挂在 socket 上；`serial.log` 也清掉，
  // 保证「日志里读到的尾部」一定是**本次**启动的。
  for (const path of [sockets().serial, sockets().qga, sockets().qmp, workPath('serial.log'),
    ...Array.from({ length: TERM_PORTS }, (_, k) => termSocket(k + 1))]) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      /* 删不掉就让 QEMU 自己报错，别在这里吞掉信息 */
    }
  }
  sweepStaleTmp();
  // 共享根 = 本次要挂的两份（沙箱自己 + 授权工作区那份）；**外加清单里记着的历史根** ——
  // 换过工作区的用户，上一个工作区里那坨旁挂件只靠"本次的根"是扫不到的（见 sweepSharedRoots）。
  const sharedRoots = [String(process.env.DSHM_SANDBOX_HOME || '').trim(), state.extraShare]
    .filter((root) => typeof root === 'string' && root.length > 0);
  sweepSharedRoots(sharedRoots);
  rememberSharedRoots(sharedRoots);
}

export function stageGuestPackages(resourceVmDir = resfileVmDir(), vmDir = vmWorkDir()) {
  const pkgSrc = join(resourceVmDir, GUEST_PKG_DIR);
  const pkgDst = join(vmDir, GUEST_PKG_DIR);
  if (!existsSync(pkgSrc)) throw new Error(`guest package source missing: ${pkgSrc}`);
  mkdirSync(pkgDst, { recursive: true });
  for (const name of readdirSync(pkgSrc)) {
    const src = join(pkgSrc, name);
    const dst = join(pkgDst, name);
    if (!existsSync(dst) || statSync(src).size !== statSync(dst).size) copyFileSync(src, dst);
  }
  const name = 'cpython-3.12.14-aarch64-musl.tar.gz';
  const python = join(dirname(resourceVmDir), 'toolchain', 'python', name);
  if (!existsSync(python)) throw new Error(`guest Python source missing: ${python}`);
  const target = join(pkgDst, name);
  if (!existsSync(target) || statSync(target).size !== statSync(python).size) copyFileSync(python, target);
}

/*
 * `vm/tmp` 里"上一轮留下的"运行件白名单（正则）。
 *
 * 【为什么要有它】上面那 4 个写死的名字只覆盖 QEMU 自己的 socket；`tmp/` 里实际还会
 * 累积别的：每次命令一份的 `run-<id>.sh` / `stdin-<id>.txt`（`handle.js` 落盘执行用；
 * 文件名带**随机 id** ⇒ 天然不会重名，也就天然会越攒越多），以及调试期留下的
 * `ram.dump` / `*_hold.txt`、旧版多终端留下的 `term2`/`term3`/`qga2_socket`。
 * 2026-10-08 真机清点：15 个 `run-*.sh` + 一个 **512 MiB** 的 `ram.dump` + 3 个连不上的死 socket。
 *
 * 【为什么敢删】它们的共同点是"上一次进程留下的"：名字要么是固定的（QEMU `bind()`
 * 之前必须不存在），要么带随机 id（下一次命令只会生成新的 id）—— 而清扫只发生在
 * `stage()`（VM 尚未拉起，`ensureRunning()` 的 `phase === 'ready'` 早退与 `pending`
 * 单飞保证这里只会走到一次）⇒ **不可能**删掉本次要用的东西。
 *
 * 【为什么只认白名单】宁可留下一个看不懂的文件，也不许误删下次要用的 ⇒ 用正则白名单，
 * 不是"清空 tmp/"。
 */
const STALE_TMP = /^(?:serial_socket|qga\d*_socket|qmp\d*_socket|term\d+|run-.*\.sh|stdin-.*\.txt|.*_hold\.txt|ram\.dump)$/;

/** 起点清扫 `vm/tmp`（见 `STALE_TMP`）。任何失败只记日志，绝不影响启动。 */
function sweepStaleTmp() {
  const dir = join(vmWorkDir(), 'tmp');
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const removed = [];
  for (const name of names) {
    if (!STALE_TMP.test(name)) continue;
    try {
      unlinkSync(join(dir, name));
      removed.push(name);
    } catch {
      /* 删不掉就让 QEMU 自己报错，别在这里吞掉信息 */
    }
  }
  if (removed.length > 0) {
    log(`已清掉 vm/tmp 里上一轮留下的 ${removed.length} 个陈旧运行件：${removed.join('、')}`);
  }
}

/*
 * `.virtfs_metadata/` 旁挂件的起点清扫（`security_model=mapped-file` 的副产物）。
 *
 * 【它是什么】mapped 模式把 guest 侧看到的 uid/gid/mode 记在共享目录里的一个隐藏目录下，
 * guest 每造一个文件就对应一个 `<名>.virtfs_metadata` 旁挂件；QEMU **删原文件时不连带删**
 * ⇒ 会攒孤儿（真机在用户工作区里清出 6 个）。这坨东西就是 `docs/124` 里用户看见的那个目录。
 *
 * 【为什么敢在起点整目录删】旁挂件只在 `create` / `setattr` 时被**写**，读路径不看它：
 * 删掉之后 QEMU 对同名文件回退到真实属性（= 本应用自己的 uid/gid），行为与「从来没建过
 * 旁挂件」一致。而清扫只发生在 `stage()`（VM 尚未拉起，与 `STALE_TMP` 那段注释同一套
 * 单飞理由：`ensureRunning()` 的 ready 早退 + pending 单飞保证这里只走到一次）
 * ⇒ **不可能**删掉本次运行要用的东西。
 *
 * 【为什么清完就 rmdir】整个 `.virtfs_metadata/` 目录是**我们自己**的命名空间：清空了
 * 还留着它 = 用户工作区里平白多一个隐藏目录。`rmdir` 只对空目录成功 ⇒ 非空（还有别的
 * 东西在用同一份共享）时自然失败，也不会误删。
 *
 * 失败一律只记日志：清不干净顶多留个隐藏目录，绝不影响能不能读写。
 *
 * 【扫描面】调用方是 `sweepSharedRoots()` —— 除本次要挂的两份，还会把**上一进程挂过**的根
 * 也扫一遍（清单 `vm/shared-roots.json`，理由见下一段注释）。
 */
function sweepSidecars(root) {
  if (typeof root !== 'string' || root.length === 0) return;
  const dir = join(root, '.virtfs_metadata');
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.virtfs_metadata')) continue;
    try {
      unlinkSync(join(dir, name));
      removed += 1;
    } catch {
      /* 删不掉就留着：旁挂件删不掉也不影响读写 */
    }
  }
  try {
    rmdirSync(dir);
  } catch {
    /* 非空（或权限）都正常：留个目录不构成问题 */
  }
  if (removed > 0) {
    log(`已清掉 ${dir} 里上一轮留下的 ${removed} 个 9p 旁挂件（security_model=mapped-file 的副产物）`);
  }
}

/*
 * 共享根清单：**上一进程**挂过哪些目录，记在 `vm/shared-roots.json`。
 *
 * 【为什么需要一份清单】旁挂件只长在**被 9p 导出过**的目录里，而导出的目录一进程一 VM
 * ⇒ 只在 `stage()` 那一刻由"首个拿到 cwd 的调用"定死（`state.extraShare`）。于是
 * 「换一个工作区再重启」时，**上一个工作区**里那坨 `.virtfs_metadata/` 谁都不会去扫 ——
 * 它长在用户可见目录里、且 QEMU 删原文件时**不**连带删 ⇒ 就这么留着
 * （r43 真机在用户工作区里清出过 6 个孤儿）。清单只放**我们挂过的根**（纯路径字符串），
 * 不含任何用户数据；读不到 / 写不进都只记日志。
 *
 * 【为什么敢整目录扫】判据与 `sweepSidecars()` 同一套：只删 `*.virtfs_metadata`、
 * 清空才 `rmdir`、只发生在 VM 未拉起时。清单里的路径**可能**早就不是工作区了
 * （用户换过目录、删过目录）⇒ 扫之前先 `existsSync` 过滤，扫不到就是 `readdirSync` 直接返回。
 *
 * 【为什么要有上限】清单不能只增不减（迁移过很多次的用户）⇒ 只留最近 `MAX_SHARED_ROOTS` 条，
 * 并在每次记录时把**已不存在**的路径剔掉。
 */
const MAX_SHARED_ROOTS = 8;

/** 清单文件（`vm/shared-roots.json`）；运行目录拿不到时返回空串（整段随即空转）。 */
function sharedRootsFile() {
  const dir = vmWorkDir();
  return dir.length > 0 ? join(dir, 'shared-roots.json') : '';
}

/** 读清单。任何异常都当"没有"—— 清扫是尽力而为，绝不允许影响 VM 启动。 */
function readSharedRoots() {
  const file = sharedRootsFile();
  if (file.length === 0) return [];
  let list = [];
  try {
    list = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  return Array.isArray(list) ? list.filter((root) => typeof root === 'string' && root.length > 0) : [];
}

/** 把本次要挂的根并进清单（去重 + 剔掉已不存在的 + 只留最近 MAX_SHARED_ROOTS 条）。 */
function rememberSharedRoots(roots) {
  const file = sharedRootsFile();
  if (file.length === 0) return;
  const keep = [];
  for (const root of [...roots, ...readSharedRoots()]) {
    if (typeof root !== 'string' || root.length === 0 || keep.includes(root)) continue;
    if (!existsSync(root)) continue;
    keep.push(root);
    if (keep.length >= MAX_SHARED_ROOTS) break;
  }
  try {
    mkdirSync(vmWorkDir(), { recursive: true });
    writeFileSync(file, JSON.stringify(keep));
  } catch {
    /* 写不进去只意味着"下一次少扫一个目录"，不值得打断启动 */
  }
}

/** 扫「本次要挂的根」+「清单里记着的历史根」（同一根只扫一次）。 */
function sweepSharedRoots(roots) {
  const seen = new Set();
  for (const root of [...roots, ...readSharedRoots()]) {
    if (typeof root !== 'string' || root.length === 0 || seen.has(root)) continue;
    seen.add(root);
    sweepSidecars(root);
  }
}

/** 读串口文件尾部。失败返回空串 —— 它纯诊断，绝不许影响 VM。
 *  【为什么要剥 NUL】设备侧 grep 把 NUL 当行尾 ⇒ 含 NUL 的日志行会**假截断**
 *  （`docs/106` §7.3 实测：尾巴上的词 `grep -c` 直接 0）。串口里 device tree/内核早期
 *  输出带 NUL 是常态，所以先剔再截。
 */
function serialText(keep) {
  try {
    return readFileSync(workPath('serial.log'), 'utf8').split('\u0000').join('').slice(-keep);
  } catch {
    return '';
  }
}

/** 串口文件当前字节数（-1 = 还没有这个文件）。 */
function serialBytes() {
  return safeSize(workPath('serial.log'));
}

/** 串口尾部（进日志用）。 */
function serialTail() {
  return serialText(SERIAL_TAIL_BYTES);
}

/** 启动 worker（dlopen + qemu_system_entry）。 */
function startWorker() {
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'vm-worker.cjs');
  /*
   * 【`execArgv: []` 不能省（2026-10-08 真机首跑 P0）】
   * 省略它就等于"继承 `process.execArgv`"，而端侧宿主的 argv 里有 `--jitless`；
   * `jitless-env.cjs` 的 `wrapWorkerThreads()` 会把继承来的那份**写成一个显式数组**再交出去，
   * 而 Node 对显式 `execArgv` 是**严格校验**的（隐式继承时它会自己过滤）⇒ 实测报文
   * `Initiated Worker with invalid execArgv flags: --jitless`，worker 一个都没起来。
   * 上游起自己的 worker 时同样显式写 `execArgv: []`（`lib/index.js:1904`）—— 这里照办：
   * 要补的 `--expose-internals --require worker-bootstrap.cjs` 由那层包装器加。
   */
  const worker = new Worker(workerPath, {
    execArgv: [],
    env: { ...process.env, TMPDIR: join(vmWorkDir(), 'tmp'), TMP: join(vmWorkDir(), 'tmp') },
    workerData: { libPath: qemuLibraryPath(), argv: bootArgv() },
    stdout: true,
    stderr: true,
  });
  /*
   * 【为什么必须显式转发】`stdout: true`/`stderr: true` 是"接成管道"，**不会**自动
   * 转发到父进程的 node-output.log；而 QEMU 是**同进程**跑的（koffi 直调入口）⇒ 它
   * `error_report()` 打的 stderr（例如 `-serial: invalid option`）全部落在这条**没人读**
   * 的管道里：既看不到，又可能把 64 KB 塞满反手把 worker 卡死。两件事都不许发生。
   */
  for (const [stream, tag] of [[worker.stdout, 'stdout'], [worker.stderr, 'stderr']]) {
    stream?.on('data', (chunk) => {
      const text = String(chunk).split('\u0000').join('').trim();
      if (text.length > 0) log(`worker ${tag}：${text}`);
    });
  }
  worker.on('message', (message) => {
    // worker 里**每一步**的读数（dlopen / 绑定 / 进入入口）：原生 abort 不会留 JS 异常，
    // 这些 diag 是把失败钉在某一跳上的唯一证据（2026-10-08 真机首跑就是缺了它才只能猜）。
    if (message && message.type === 'diag') {
      log(`worker: ${message.message}`);
    } else if (message && message.type === 'error') {
      state.lastError = String(message.message);
      state.detail = `worker 报错：${state.lastError}`;
      log(`worker 报错：${state.lastError}`);
    } else if (message && message.type === 'preloaded') {
      state.preloaded = message.names;
      log(`worker: 旁挂 .so 预挂 ${message.names.length} 项（${message.names.join('、')}）`);
    } else if (message && message.type === 'entered') {
      state.detail = `qemu_system_entry 已进入（argc=${message.argc}）`;
      log(`qemu_system_entry 已进入（argc=${message.argc}）——此后由 QEMU 接管（串口/QGA）`);
    } else if (message && message.type === 'returned') {
      state.phase = 'stopped';
      state.detail = `VM 已退出（rc=${message.rc}，存活 ${Math.round(message.ms / 1000)} s）`;
      log(`VM 已退出（rc=${message.rc}，存活 ${Math.round(message.ms / 1000)} s）`);
    }
  });
  worker.on('error', (error) => {
    state.lastError = String((error && error.message) || error);
    state.detail = `worker 线程异常：${state.lastError}`;
    log(`worker 线程异常：${state.lastError}`);
  });
  worker.on('exit', (code) => {
    if (state.phase !== 'stopped') {
      state.phase = 'failed';
      /*
       * 【不许把更精确的原因盖掉（2026-10-14 真机）】worker 报错时 `detail` 已经写明
       * 缘由（如「worker 报错：…」），而这条退出的 `code` 却常常是 **0** —— vm-worker.cjs
       * 最外层 `catch` 会吞掉 `throw`、线程照常正常结束。原实现无条件覆盖 ⇒ 模型与用户
       * 看到的只剩一句没用的「端侧 VM 不可用：worker 线程退出（code=0）」，真正的原因
       * 反而被替换掉。所以：只在还没有具体原因时才用这句兜底。
       */
      if (state.detail.length === 0) state.detail = `worker 线程退出（code=${code}）`;
    }
    log(`worker 线程退出（code=${code}）`);
    state.worker = null;
  });
  state.worker = worker;
}

/** 可选 SSH 工具的就绪标记；终端启动不需要等它。 */
const GUEST_SSH_READY_MARKER = '/usr/local/sbin/dshm-ssh-tools-ready';
const GUEST_SSH_HELPER = '/usr/local/sbin/dshm-ensure-ssh-tools';
const SSH_HELPER_EOF = 'DSHM_SSH_HELPER_EOF';
const SSH_WRAPPER_EOF = 'DSHM_SSH_WRAPPER_EOF';

/**
 * 生成 guest 侧 SSH 工具的**惰性安装垫片**。
 *
 * 2026-10-23 真机：全新安装第一次开终端用了 78.6 s。QEMU 在 2.7 s 已进入 guest init，
 * 剩余时间几乎全耗在启动阶段安装 SSH/Dropbear 闭包；但侧边栏终端只需要 bash。
 * 因此启动只等 `/bin/bash`，并在 `/usr/bin/{ssh,scp,dropbearkey}` 缺失时放一个透明 wrapper：
 * 用户第一次真正调用 SSH 工具时才 `apk add`，安装完成后 wrapper 被真实二进制覆盖。
 */
function guestSshBootstrapLines() {
  const helper = [
    '#!/bin/sh',
    'set -u',
    'tool=${1:-}',
    '[ -n "$tool" ] || { echo "dshm-ensure-ssh-tools: missing tool" >&2; exit 2; }',
    'shift || true',
    `marker=${GUEST_SSH_READY_MARKER}`,
    'ready() {',
    '  [ -f "$marker" ] && [ -x /usr/bin/ssh ] && [ -x /usr/bin/scp ] && [ -x /usr/bin/dropbearkey ]',
    '}',
    'if ready; then exec "/usr/bin/$tool" "$@"; fi',
    'lock=/tmp/.dshm-ssh-tools.lock',
    'if ! mkdir "$lock" 2>/dev/null; then',
    '  i=0',
    '  while [ -d "$lock" ] && [ "$i" -lt 600 ]; do sleep 1; i=$((i+1)); done',
    '  if ready; then exec "/usr/bin/$tool" "$@"; fi',
    '  echo "dshm-ensure-ssh-tools: another installer did not finish" >&2',
    '  exit 1',
    'fi',
    'trap \'rmdir "$lock" 2>/dev/null || true\' EXIT HUP INT TERM',
    'mkdir -p /tmp/dshm-ssh-pkgs',
    'rm -f /tmp/dshm-ssh-pkgs/*.apk',
    'for f in /mnt/share/vm/guestpkgs/*.tar.gz; do',
    '  [ -e "$f" ] || continue; b=${f##*/}',
    '  case "$b" in dropbear-*|skalibs-*|utmps-*|zlib-*) ;; *) continue ;; esac',
    '  cp -f "$f" "/tmp/dshm-ssh-pkgs/${b%.tar.gz}.apk"',
    'done',
    'if apk add --no-cache --allow-untrusted --force-overwrite --no-network /tmp/dshm-ssh-pkgs/*.apk >/tmp/dshm-ssh-pkg.log 2>&1',
    'then',
    '  touch "$marker"',
    '  cp -f /tmp/dshm-ssh-pkg.log /mnt/share/dshm-vm-ssh-pkg.log 2>/dev/null || true',
    '  exec "/usr/bin/$tool" "$@"',
    'fi',
    'cp -f /tmp/dshm-ssh-pkg.log /mnt/share/dshm-vm-ssh-pkg.log 2>/dev/null || true',
    'tail -n 20 /tmp/dshm-ssh-pkg.log >&2 || true',
    'echo "guest SSH 工具安装失败；日志：/mnt/share/dshm-vm-ssh-pkg.log" >&2',
    'exit 1',
  ].join('\n');
  const wrapper = [
    '#!/bin/sh',
    'tool=${0##*/}',
    `exec ${GUEST_SSH_HELPER} "$tool" "$@"`,
  ].join('\n');
  return [
    `if [ ! -f ${GUEST_SSH_READY_MARKER} ]; then`,
    '  if [ -x /usr/bin/ssh ] && [ -x /usr/bin/scp ] && [ -x /usr/bin/dropbearkey ]'
      + ' && [ "$(wc -c < /usr/bin/ssh)" -gt 4096 ]; then',
    `    touch ${GUEST_SSH_READY_MARKER}`,
    '    echo DSHM_GUEST_SSH=ready',
    '  else',
    '    mkdir -p /usr/local/sbin /usr/local/bin',
    `    cat > ${GUEST_SSH_HELPER} <<'${SSH_HELPER_EOF}'`,
    helper,
    SSH_HELPER_EOF,
    `    chmod 0755 ${GUEST_SSH_HELPER}`,
    '    for tool in ssh scp dropbearkey; do',
    '      if [ ! -x "/usr/bin/$tool" ] || [ "$(wc -c < "/usr/bin/$tool")" -le 4096 ]; then',
    `        cat > "/usr/bin/$tool" <<'${SSH_WRAPPER_EOF}'`,
    wrapper,
    SSH_WRAPPER_EOF,
    '        chmod 0755 "/usr/bin/$tool"',
    '      fi',
    '    done',
    '    echo DSHM_GUEST_SSH=lazy',
    '  fi',
    'else',
    '  echo DSHM_GUEST_SSH=ready',
    'fi',
  ];
}


/**
 * guest 侧 tmux / gh 的**惰性安装垫片**（2026-11-02，docs/342）。
 *
 * 【为什么不并进启动时的 bash 闭包】TCI 档下一次 `apk add` 是分钟级价钱的活，
 * 而 tmux/gh 是"用户真要用才用"的工具。SSH 闭包已经是这个口径（`docs/157`：
 * 启动只等 bash，SSH 工具首次调用才装），这里照抄同一套：锁 + marker + 幂等覆盖。
 *
 * 【包从哪来】`/mnt/share/vm/guestpkgs/*.tar.gz`（9p 共享 = 宿主 resfile），
 * 安装前按 apk 要求的扩展名在 guest 的 /tmp 里补一层 `.apk` 名字（目录名/文件名
 * 在包内不许出现 apk 字样，见 docs/148）。
 *
 * 【依赖】tmux 要 libevent + libncursesw + ncurses-terminfo-base（后两个可能没装过，
 * 因为 bash 闭包只装 dropbear 那几个）；gh 只需要 libc.musl（实测 NEEDED 只有它）。
 */
function guestExtraToolBootstrapLines() {
  const HELPER = '/usr/local/sbin/dshm-ensure-guest-tool';
  const MARKER = '/usr/local/sbin/dshm-guest-tool-';
  const HELPER_EOF = 'DSHM_GUEST_TOOL_HELPER_EOF';
  const WRAP_EOF = 'DSHM_GUEST_TOOL_WRAP_EOF';
  const helper = [
    '#!/bin/sh',
    'set -u',
    'tool=${1:-}',
    '[ -n "$tool" ] || { echo "dshm-ensure-guest-tool: missing tool" >&2; exit 2; }',
    'shift || true',
    'marker=/usr/local/sbin/dshm-guest-tool-$tool',
    '[ "$tool" != git ] || marker=$marker-curl-v2',
    'ready() {',
    '  [ -f "$marker" ] && [ -x "/usr/bin/$tool" ] || return 1',
    '  case "$tool" in',
    '    git) [ -e /usr/lib/libcurl.so.4 ] ;;',
    '    pnpm) [ -s /opt/dshm/pnpm/bin/pnpm.cjs ] ;;',
    '    python3) [ -s /opt/dshm/python/lib/python3.12/encodings/__init__.py ] && [ -x /opt/dshm/python/bin/python3.12 ] ;;',
    '    *) return 0 ;;',
    '  esac',
    '}',
    'launch() {',
    '  case "$tool" in',
    /*
     * ── pnpm 在 guest 里的三处避坑（2026-11-15，0.2.2-rc.3 复测 P0）──────────────
     *
     * 现场：`pnpm -v` 与 `node /opt/dshm/pnpm/bin/pnpm.cjs -v` 在 1 vCPU 上 >120 s 无输出，
     * 而同一台机器 `node -v` 只要 4 s、`python3 --version` 1 s ⇒ 不是 guest 坏了，
     * 是 pnpm 这条启动路径在 TCG 模拟下太重。逐项收掉可以收掉的成本：
     *
     *   ① `-v` / `--version` 不启动 node：`dist/pnpm.cjs` 是 8.8 MB 单文件 bundle，
     *      版本号却只写在 `package.json` 里。guest 上"启动 node + 解析 8.8 MB"是全部成本，
     *      而版本查询根本不需要 CLI 本体。输出与原 CLI 逐字一致（同一份 package.json）。
     *   ② `NODE_COMPILE_CACHE`：真实命令仍要过 CLI，但 V8 的字节码缓存能让 8.8 MB 只解析一次
     *      （本机对照 0.87 s → 0.61 s，TCG 下比例更大）。缓存目录在 /opt/dshm/pnpm 内，
     *      随工具一起换新；损坏时 libnode 自动忽略。
     *   ③ 关掉两条"启动即触网/自管理"的行为：更新检查与 `packageManager` 版本自管理。
     *      guest 网络受宿主代理影响，这两条一旦卡住就是分钟级空等，且与"用 pnpm 装包"无关。
     */
    '    pnpm)',
    '      case "${1:-}" in',
    '        -v|--version)',
    "          v=$(awk -F'\"' '/\"version\"/{print $4; exit}' /opt/dshm/pnpm/package.json 2>/dev/null)",
    '          [ -n "$v" ] && { echo "$v"; exit 0; }',
    '          ;;',
    '      esac',
    '      [ -d /opt/dshm/pnpm/.compile-cache ] || \\',
    '        ( NODE_COMPILE_CACHE=/opt/dshm/pnpm/.compile-cache node /opt/dshm/pnpm/bin/pnpm.cjs --help >/dev/null 2>&1 & )',
    '      NODE_COMPILE_CACHE=/opt/dshm/pnpm/.compile-cache \\',
    '      npm_config_update_notifier=false \\',
    '      npm_config_manage_package_manager_versions=false \\',
    '      exec node /opt/dshm/pnpm/bin/pnpm.cjs "$@" ;;',
    '    python3) exec /opt/dshm/python/bin/python3.12 "$@" ;;',
    '    *) exec "/usr/bin/$tool" "$@" ;;',
    '  esac',
    '}',
    'if ready; then launch "$@"; fi',
    'lock=/tmp/.dshm-guest-tool-$tool.lock',
    'if ! mkdir "$lock" 2>/dev/null; then',
    '  i=0',
    '  while [ -d "$lock" ] && [ "$i" -lt 600 ]; do sleep 1; i=$((i+1)); done',
    '  if ready; then launch "$@"; fi',
    '  echo "dshm-ensure-guest-tool: another installer did not finish" >&2',
    '  exit 1',
    'fi',
    "trap 'rmdir \"$lock\" 2>/dev/null || true' EXIT HUP INT TERM",
    /*
     * 【不走 apk add，直接解 tar（2026-11-02 r3 P0）】
     *
     * 移动端复测把这条路走死了：旧实现把 `/mnt/share/vm/guestpkgs/*.tar.gz`
     * **改名成 .apk** 交给 `apk add`，apk 直接回
     *     ERROR: /tmp/dshm-guest-gh/github-cli-2.72.0-r6.apk: Not supported
     * 因为我们的包是普通 tar.gz（没有 APKv2 的 .PKGINFO + 签名）——**改名不等于转格式**。
     * 同一轮里 tmux 还撞了 `Unable to lock database`（并发/残留库锁）。
     *
     * guest 是固定 rootfs，把这几个包**直接解到 /** 即可用（里面就是 usr/bin、usr/lib），
     * 既绕开包管理器格式，也绕开库锁。marker 保证只装一次。
     */
    'dir=/tmp/dshm-guest-$tool',
    'mkdir -p "$dir"',
    'ok=1',
    'found=0',
    'if [ "$tool" = git ]; then',
    '  for prefix in git libcurl libcrypto3 libssl3 brotli-libs c-ares nghttp2-libs libidn2 libunistring libpsl zlib zstd-libs; do',
    '    present=0',
    '    for f in /mnt/share/vm/guestpkgs/$prefix-*.tar.gz; do [ ! -f "$f" ] || present=1; done',
    '    [ "$present" = 1 ] || { echo "guest git: missing archive $prefix" >&2; ok=0; }',
    '  done',
    'fi',
    'for f in /mnt/share/vm/guestpkgs/*.tar.gz; do',
    '  [ -e "$f" ] || continue; b=${f##*/}',
    '  case "$tool:$b" in',
    /* tmux 闭包：本体 + 事件库 + ncurses（含 terminfo） */
    '    tmux:tmux-*|tmux:libevent-*|tmux:libncursesw-*|tmux:ncurses-terminfo-base-*) ;;',
    /* gh 闭包：本体即可（Go 静态二进制，NEEDED 只有 musl） */
    '    gh:github-cli-*) ;;',
    /* git 是 superagent 的硬依赖（clone / worktree）：独立工具与顺带安装都支持 */
    '    git:git-[0-9]*|git:libcurl-*|git:libcrypto3-*|git:libssl3-*|git:brotli-libs-*|git:c-ares-*|git:nghttp2-libs-*|git:libidn2-*|git:libunistring-*|git:libpsl-*|git:zlib-*|git:zstd-libs-*) ;;',
    '    pnpm:pnpm-*|python3:cpython-*) ;;',
    '    *) continue ;;',
    '  esac',
    '  found=$((found+1))',
    '  if [ "$tool" = python3 ]; then',
    '    mkdir -p /opt/dshm',
    '    tar xzfm "$f" -C /opt/dshm >>/tmp/dshm-guest-$tool.log 2>&1 || ok=0',
    '  elif [ "$tool" = pnpm ]; then',
    '    tar xzfm "$f" -C / >>/tmp/dshm-guest-$tool.log 2>&1 || ok=0',
    '  else',
    '    tar xzf "$f" -C / >>/tmp/dshm-guest-$tool.log 2>&1 || ok=0',
    '  fi',
    'done',
    'if [ "$tool" = python3 ] && [ -f /opt/dshm/python/bin/python3.12 ]; then',
    '  chmod 0755 /opt/dshm/python/bin/*',
    '  ln -sfn /opt/dshm/python/bin/python3.12 /usr/bin/python3',
    'fi',
    /* 包内权限是 0660/0:file_manager ⇒ 解出来默认不可执行，必须显式 chmod（r5 §五.4） */
    'for b in /usr/bin/* /usr/libexec/git-core/*; do',
    '  [ -f "$b" ] || continue',
    '  case "$b" in *tmux|*gh|*git|*git-*|*/pnpm) chmod 0755 "$b" 2>/dev/null || true ;; esac',
    'done',
    'if [ "${1:-}" = "--dshm-verbose" ] || [ -z "${DSHM_GUEST_QUIET:-}" ]; then',
    '  echo "guest：正在安装 $tool（首次可能需要几分钟，请稍候）…" >&2',
    'fi',
    '[ "$tool" != git ] || [ -e /usr/lib/libcurl.so.4 ] || ok=0',
    '[ "$tool" != pnpm ] || [ -s /opt/dshm/pnpm/bin/pnpm.cjs ] || ok=0',
    '[ "$tool" != python3 ] || [ -s /opt/dshm/python/lib/python3.12/encodings/__init__.py ] || ok=0',
    'if [ "$ok" = "1" ] && [ "$found" -gt 0 ] && [ -x "/usr/bin/$tool" ]; then',
    '  touch "$marker"',
    '  rmdir "$lock"',
    '  launch "$@"',
    'fi',
    'tail -n 20 /tmp/dshm-guest-$tool.log >&2 || true',
    'echo "guest 工具 $tool 安装失败；日志：/tmp/dshm-guest-$tool.log" >&2',
    'exit 1',
  ].join('\n');
  const wrapper = [
    '#!/bin/sh',
    'tool=${0##*/}',
    `exec ${HELPER} "$tool" "$@"`,
  ].join('\n');
  /*
   * 【每次启动都重写（2026-11-03，r5 §四.1 实测）】
   * 旧实现是 `if [ ! -x $HELPER ]` —— 文件存在就永不更新，r5 实测安装器停在 22:17 的
   * 旧版（仍是 `cp → .apk → apk add`），核心升版也碰不到它 ⇒ 修复永远到不了设备。
   */
  const lines = [`cat > ${HELPER} <<'${HELPER_EOF}'`, helper, HELPER_EOF, `chmod 0755 ${HELPER}`];
  /* git 也要垫片：superagent 的 clone/worktree 靠它；r5 实测 /usr/bin/git 根本不存在 */
  for (const tool of ['tmux', 'gh', 'git', 'pnpm', 'python3']) {
    lines.push(
      `if [ ! -f ${MARKER}${tool} ] || [ ! -x /usr/bin/${tool} ]; then`,
      `  if [ -x /usr/bin/${tool} ] && [ "$(wc -c < /usr/bin/${tool})" -gt 4096 ]; then`,
      `    touch ${MARKER}${tool}`,
      '  else',
      `    cat > /usr/bin/${tool} <<'${WRAP_EOF}'`,
      wrapper,
      WRAP_EOF,
      `    chmod 0755 /usr/bin/${tool}`,
      '  fi',
      'fi',
    );
  }
  lines.push('mkdir -p /usr/local/bin');
  for (const tool of ['git']) {
    lines.push(`cat > /usr/local/bin/${tool} <<'${WRAP_EOF}'`, wrapper, WRAP_EOF, `chmod 0755 /usr/local/bin/${tool}`);
  }
  return lines;
}

/** 供离线门禁断言；运行时用同一份行数组。 */
export function guestExtraToolBootstrapScript() {
  return guestExtraToolBootstrapLines().join('\n');
}
/** 供离线门禁做 shell 语法与关键语义断言；运行时用同一份行数组。 */
export function guestSshBootstrapScript() {
  return guestSshBootstrapLines().join('\n');
}

/**
 * guest 首启初始化（幂等，每次启动都跑一遍，实测 ~50 ms）。
 *
 * 【四件事，顺序不能换】
 *   ① **确认 9p 共享在位**：镜像的 /etc/fstab 里确实有
 *      `hostshare /mnt/share 9p trans=virtio,version=9p2000.L`（2026-10-08 真机
 *      `/proc/mounts` 实测已生效）。但"镜像自带的约定"不能当成"我一定有"：
 *      它没挂上时后面每一条都会以看不懂的方式失败，所以先查再补挂。
 *   ② **让宿主路径在 guest 里逐字成立**：`ln -sfn /mnt/share <el2 files>`。
 *      这是整条链路里最省事也最关键的一步：没有它，guest 里要写
 *      `/data/storage/el2/base/haps/entry/files/...` 就得到处做路径翻译，而模型
 *      看到的 `pwd`、报错里的路径、宿主侧的文件树会各说各话。
 *      【链接目标必须是**挂载点** /mnt/share】2026-10-08 真机踩到：原实现把
 *      "宿主沙箱根"当成目标，而它与 EL2_FILES 是**同一个字符串** ⇒ 造出一条指向
 *      自己的符号链接，guest 里 `cd <宿主路径>` 恒失败（现场只剩一句
 *      `DSHM_PROVISION_NO_PKG`，因为失败的那一步恰好是 `cd`）。
 *   ③ **沙箱之外的工作区**（见 extraShareRoot）单独挂第二份 9p，挂在同一个绝对路径。
 *   ④ **离线装 bash**：guest 原始镜像只有 busybox ash，而上游 bash 执行器固定发
 *      `["bash","-c",cmd]`；用 ash 顶替会静默改变语义。默认只试 `--no-network`
 *      （纯本地文件，随包闭包本来就在 9p 共享里）；**联网回退默认关闭**——它有网也
 *      极慢，会把"慢"变成"更慢"，只有宿主显式设 `DSHM_VM_ALLOW_NET_INSTALL=1` 才发。
 *
 * 【两段执行】（2026-10-13 早期真机）本函数现在分两次 `exec`：先"探测段"（挂载 +
 * 判 `/bin/bash`，30 s），命中就是快路径；否则再发"安装段"（apk add，600 s）。
 * 详见 `PROVISION_PROBE_MS` 的注释：一整段的 120 s 会把**已经装成功**的首装判死，
 * 并把一进程一 VM 的闸门永久关掉。
 */
async function provision(session) {
  const pkgDir = join(vmWorkDir(), GUEST_PKG_DIR);
  const extra = state.extraShare;
  const guestFiles = guestSandboxFilesPath();
  /*
   * 第一段：探测。只做"让宿主路径在 guest 里成立"的挂载/链接，再看 `/bin/bash` 在不在。
   * bash 已装（正常情况：镜像跨启动保留）⇒ 这一段 ~200 ms 结束，整条链路不装包。
   */
  const probeLines = [
    'set -u',
    // ① 共享目录在位性检查（幂等；补挂失败不在这里判死，让 ② 的失败原文说话）
    `if ! grep -q " /mnt/share " /proc/mounts; then mkdir -p /mnt/share; mount -t 9p -o trans=virtio,version=9p2000.L ${SHARE_TAG} /mnt/share 2>&1 || true; fi`,
    // ② 只建实际沙箱路径的**父目录**（`.../haps/<phone|tablet|entry>`）：
    //    `ln` 不会替你建中间层；模块名不能写死，见 guestSandboxFilesPath()。
    `mkdir -p ${dirname(guestFiles)}`,
    `ln -sfn /mnt/share ${guestFiles}`,
  ];
  if (extra !== null) {
    // ③ 工作区那一层：mkdir 出挂载点（宿主的中间层在 guest 里不存在）再挂。
    probeLines.push(`if ! grep -q " ${extra} " /proc/mounts; then mkdir -p ${shq(extra)}; mount -t 9p -o trans=virtio,version=9p2000.L ${EXTRA_TAG} ${shq(extra)} 2>&1 || true; fi`);
  }
  probeLines.push(...guestSshBootstrapLines());
  /* tmux / gh 垫片：与 SSH 同口径（首次调用才装），失败不影响 bash 可用性 */
  probeLines.push(...guestExtraToolBootstrapLines());
  probeLines.push(
    'if [ -x /bin/bash ]; then echo DSHM_PROVISION_OK; exit 0; fi',
    // 没命中不是错误：交给第二段去装（两条路径的判据都是同一件事 —— `/bin/bash` 可执行）。
    'echo DSHM_PROVISION_NEEDS_INSTALL',
  );
  const probe = await session.exec('/bin/busybox', ['sh', '-c', probeLines.join('\n')], PROVISION_PROBE_MS, 40);
  const probeText = `${probe.stdout}${probe.stderr}`;
  if (probeText.includes('DSHM_GUEST_SSH=ready')) {
    state.guestSsh = 'ready';
  } else if (probeText.includes('DSHM_GUEST_SSH=lazy')) {
    state.guestSsh = 'lazy';
  } else {
    state.guestSsh = 'failed';
  }
  if (probeText.includes('DSHM_PROVISION_OK')) {
    log(`guest 探测段：/bin/bash 已在（${probe.ms} ms）⇒ 跳过安装段`);
    return { ok: true, exitCode: probe.exitCode, text: probeText.trim() };
  }
  /*
   * 第二段：真装。符号链接建好之后，宿主路径在 guest 里逐字成立 ⇒ 包目录直接用宿主路径。
   * 【联网回退默认关闭】见 ④ 与 `PROVISION_INSTALL_MS` 的注释：有网也极慢，只有显式
   * `DSHM_VM_ALLOW_NET_INSTALL=1` 才发第二条安装命令（在**宿主**读了再生成脚本，
   * guest 侧拿不到宿主 env ⇒ 这条开关只能由这里落地）。
   */
  const netFallback = String(process.env.DSHM_VM_ALLOW_NET_INSTALL || '').trim() === '1';
  log(`guest 安装段开始（${PROVISION_INSTALL_MS} ms 上限；联网回退=${netFallback ? '开' : '关'}）`);
  const installLines = [
    'set -u',
    // 【失败时把现场一起打出来】这一行原来只有一个 error 标签，真机上等于没有证据。
    `cd ${pkgDir} 2>/dev/null || { echo DSHM_PROVISION_NO_PKG; grep -i 9p /proc/mounts 2>&1 | head -4; ls -l /mnt 2>&1 | head -4; exit 1; }`,
    // 【扩展名】随包的 guest bash 闭包为过应用市场审核一律叫 `.tar.gz`（内容仍是 Alpine v2
    // 包）。apk-tools 对本地文件按内容嗅探、不看扩展名，但不把命押在这一条实现细节上：
    // 先在 **guest 的 /tmp** 里补一层 `.apk` 名字再装（宿主包体里没有任何 `.apk`，
    // 这里成的是运行期临时文件，随 VM 一起消失）。旧设备 stage 目录里若还有上一代的
    // `.apk`，同一个 `./*.apk` 分支也认。
    'mkdir -p /tmp/dshm-pkgs',
    'for f in ./*.tar.gz; do [ -e "$f" ] || continue; b=${f##*/}; cp -f "$f" "/tmp/dshm-pkgs/${b%.tar.gz}.apk"; done',
    'pkgs=""',
    // 终端启动只等 bash 闭包。Dropbear/SSH 是可选工具，首次真正调用 ssh/scp/dropbearkey 时
    // 由 guest 侧惰性安装；不能再把分钟级的可选包安装塞进 terminal/create 的关键路径。
    'for f in /tmp/dshm-pkgs/*.apk; do',
    '  [ -e "$f" ] || continue; b=${f##*/}',
    '  case "$b" in bash-*|libncursesw-*|ncurses-terminfo-base-*|readline-*) ;; *) continue ;; esac',
    '  pkgs="$pkgs $f"',
    'done',
    'if [ -z "$pkgs" ]; then echo DSHM_PROVISION_NO_PKG; exit 1; fi',
    'if ! apk add --no-cache --allow-untrusted --no-network $pkgs >/tmp/dshm-pkg.log 2>&1; then',
    netFallback
      ? 'apk add --no-cache --allow-untrusted $pkgs >>/tmp/dshm-pkg.log 2>&1 || true'
      : 'echo "离线安装失败；联网回退已关闭（需要时宿主设 DSHM_VM_ALLOW_NET_INSTALL=1）" >>/tmp/dshm-pkg.log',
    'fi',
    'if [ -x /bin/bash ]; then echo DSHM_PROVISION_OK; exit 0; fi',
    'echo DSHM_PROVISION_NOBASH',
    // 【把安装日志带出 guest】原来只 tail 5 行且只留在 guest 的 /tmp ⇒ 真机排障读不到。
    // 落一份到 9p 共享根（宿主侧 = 沙箱根），再 tail 20 行进日志。
    'cp -f /tmp/dshm-pkg.log /mnt/share/dshm-vm-pkg.log 2>/dev/null || true',
    'tail -n 20 /tmp/dshm-pkg.log 2>/dev/null || true',
    'exit 1',
  ];
  const result = await session.exec('/bin/busybox', ['sh', '-c', installLines.join('\n')], PROVISION_INSTALL_MS, 40);
  if (result.stdout.includes('DSHM_PROVISION_OK')) {
    state.guestSsh = state.guestSsh === 'failed' ? 'lazy' : state.guestSsh;
  }
  return {
    ok: result.stdout.includes('DSHM_PROVISION_OK'),
    exitCode: result.exitCode,
    text: `${result.stdout}${result.stderr}`.trim(),
  };
}

/**
 * 确保 VM 在跑且 QGA 可用。并发调用共用同一次启动（`pending` 单飞）。
 * @returns `{ok, error?}`
 */
let pending = null;
export function ensureRunning(options = {}) {
  if (state.phase === 'ready') {
    /*
     * 【ready 早退不许静默忽略新 cwd（2026-10-12 真机）】一进程一 VM ⇒ 沙箱之外的
     * 工作区在**启动那一刻**挂第二份 9p（extraShareRoot）；就绪之后再来一个"绑定之外"
     * 的 cwd，挂载已经补不上了。原来这里 `return {ok:true}` 一声不吭 ⇒ 上层 `cd` 静默
     * 失败、落到 /root，用户只看到"终端不在工作区"而拿不到任何线索。现在如实记一行：
     * 只要本次 cwd 的共享根与已绑定不同（且本次 cwd 确实需要一份共享），就报警并计数。
     */
    const cwd = typeof options.cwd === 'string' ? options.cwd : '';
    if (cwd.length > 0) {
      const wanted = extraShareRoot(cwd, String(process.env.DSHM_SANDBOX_HOME || '').trim());
      if (wanted !== null && wanted !== state.extraShare) {
        state.cwdMiss += 1;
        log(`VM 已就绪，但本次 cwd 的共享根（${wanted}）与启动时绑定的（${state.extraShare ?? '无'}）不同；`
          + '一进程一 VM ⇒ 该目录本次不可见（如需它请重启应用）');
      }
    }
    return Promise.resolve({ ok: true });
  }
  if (pending !== null) return pending;
  pending = (async () => {
    /* 5s 心跳（纯日志）：任何 30~60 秒的日志窗口都能看出 VM 走到哪一步 */
    const hb = setInterval(() => {
      const el = state.startedAt > 0 ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
      log(`VM 启动中：阶段=${state.phase} 已 ${el}s`);
    }, 5000);
    if (typeof hb.unref === 'function') hb.unref();
    try {
      // 【一进程一 VM 的硬闸门】见 startGate 的注释：并发由 pending 挡，**串行的第二次**
      // 必须在这里挡死（真机实测第二台会让应用进程当场消失）。
      const gate = startGate(state);
      if (!gate.allow) {
        state.phase = 'failed';
        state.lastError = gate.reason;
        if (state.detail.length === 0) state.detail = gate.reason;
        log(`拒绝启动第二台 VM：${gate.reason}`);
        return { ok: false, error: gate.reason };
      }
      const kind = options.kind === 'prewarm' ? 'prewarm' : 'request';
      const lifecycle = lifecycleGate(kind);
      if (!lifecycle.allow) {
        state.phase = 'failed';
        state.lastError = lifecycle.reason;
        if (state.detail.length === 0) state.detail = lifecycle.reason;
        log(`拒绝启动 VM：${lifecycle.reason}`);
        return { ok: false, error: lifecycle.reason };
      }
      const assets = assetsPresent();
      if (!assets.ok) {
        throw new Error(`VM 资产缺失（${assets.missing.join('、')}）`);
      }
      const share = String(process.env.DSHM_SANDBOX_HOME || '').trim();
      if (share.length === 0) throw new Error('DSHM_SANDBOX_HOME 缺失');
      // 沙箱之外的工作区（授权目录）在**启动时**定下来：一进程一 VM ⇒ 挂载点只在
      // 这一处确定（ext4 fsdev 的 path 不能热插）。首个拿到 cwd 的调用说了算。
      state.extraShare = extraShareRoot(typeof options.cwd === 'string' ? options.cwd : '', share);
      // 【内存闸门：必须在 spawn 之前】见 memBudget 的注释 —— QEMU 在 `tcg_region_init`
      // 里设页保护失败会 `exit(1)`，被 appspawn 变成 SIGABRT 拖死整个宿主进程，宿主
      // catch 不到 ⇒ 唯一的防线是"内存不够就别把 QEMU 拉起来"。放在这里而不是 spawn
      // 之后：`state.spawned` 还没置真 ⇒ 用户释放内存后下一次调用仍可正常启动。
      const budget = memBudget(vmMinAvailableMib());
      if (!budget.ok) {
        state.phase = 'failed';
        state.lastError = budget.reason;
        if (state.detail.length === 0) state.detail = budget.reason;
        log(`拒绝启动 VM：${budget.reason}`);
        return { ok: false, error: budget.reason };
      }
      log(`内存预检通过：${budget.reason}`);
      state.phase = 'staging';
      state.attempt += 1;
      state.startedAt = Date.now();
      log(`启动 guest VM（第 ${state.attempt} 次尝试；share=${share}；工作区共享=${state.extraShare ?? '无（cwd 在沙箱内或未给出）'}）`);
      stage();
      log(`资产已就位：rootfs 副本 ${safeSize(workPath('rootfs.qcow2'))} B + guest 包闭包 + socket 目录`);
      state.phase = 'starting';
      // 闸门在**这一步**关死：此后即便本次启动失败，本进程也不会再试图起第二台。
      state.spawned = true;
      startWorker();
      log(`worker 线程已拉起（lib=${qemuLibraryPath()}）`);
      state.phase = 'waiting-qga';
      // 【为什么把 log 交给 QgaSession】2026-10-08 真机 P0：QGA 每一跳的失败都被这里的
      // `catch {}` 吞掉，现场只剩「仍在等 QGA」，等于把「通道其实一直在报错」藏起来
      // —— 排障时最贵的一环不是 bug 本身，是证据被吞。现在失败原文原样进日志。
      const session = new QgaSession(sockets().qga, log);
      const deadline = Date.now() + READY_TIMEOUT_MS;
      let ready = false;
      let waited = 0;
      let lastSync = '（还没试过）';
      while (Date.now() < deadline) {
        try {
          if (await session.sync(4000)) {
            ready = true;
            break;
          }
          lastSync = 'sync 返回 false（详见上面的 QGA 读数行）';
        } catch (error) {
          // 还没起来：socket 不存在/未 accept/连接断了。原文照记，不许静默。
          lastSync = String((error && error.message) || error);
        }
        if (state.phase === 'failed' || state.phase === 'stopped') {
          throw new Error(state.detail || 'VM 启动失败');
        }
        waited += 400;
        // 每 5 s 一拍，只报「等了多少、串口收到多少」：冷启动 11.8 s 之外若一直不响，
        // 就靠这一行 + 串口尾部把失败钉在 QEMU 侧，而不是回头猜宿主。
        // 【为什么是 10000 而不是 5000】`waited` 每次 +400（400 的倍数），
        // `% 5000` 永远不为 0 ⇒ 这一拍在真机上**一次都没打过**（2026-10-08 实测）。
        if (waited % 10000 === 0) {
          log(`仍在等 QGA（已 ${Math.round(waited / 1000)} s，串口 ${serialBytes()} B，上次：${lastSync}）`);
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 400);
        });
      }
      if (!ready) {
        log(`QGA 超时（${READY_TIMEOUT_MS} ms，连过 ${session.stats().connects} 条连接，最后失败：${lastSync}）`);
        log(`串口尾部：${serialTail()}`);
        throw new Error(`QGA 在 ${READY_TIMEOUT_MS} ms 内没有就绪（最后失败：${lastSync}）`);
      }
      state.readyAt = Date.now();
      log(`QGA 就绪（+${state.readyAt - state.startedAt} ms）`);
      /*
       * 【老镜像的一次性迁移：最小 init】见 guest-init.js 与 docs/157。
       *
       * 为什么放在 QGA 就绪之后、provision 之前：迁移只依赖 QGA（写两个小文件 + sync），
       * 与 provision 的挂载/装包完全无关；而且**越早发越好** —— 它决定的是**下一次**
       * 冷启动的速度（本次 VM 已经按老 init 起来了），早一次发完就早一次摆脱 76 s 的
       * OpenRC 段。失败不判死：本次功能完好，只是下次还慢，证据留在 `guestInit` 读数里。
       */
      try {
        const r = await session.exec('/bin/busybox', ['sh', '-c', guestInitInstallScript()], GUEST_INIT_TIMEOUT_MS, 40);
        const text = `${r.stdout}${r.stderr}`;
        if (text.includes('DSHM_INIT_CURRENT')) {
          state.guestInit = 'current';
          log(`guest 最小 init（${GUEST_INIT_VERSION}）：已是最新（${r.ms} ms，本次就绪不受影响）`);
        } else if (text.includes('DSHM_INIT_INSTALLED')) {
          state.guestInit = 'installed';
          log(`guest 最小 init（${GUEST_INIT_VERSION}）：迁移完成（${r.ms} ms）⇒ 下次冷启动不再走 OpenRC`);
        } else {
          state.guestInit = 'failed';
          log(`guest 最小 init：迁移未确认（exit=${r.exitCode}，${r.ms} ms）：${text.trim()}`);
        }
      } catch (error) {
        state.guestInit = 'failed';
        log(`guest 最小 init：迁移异常（不影响本次启动）：${String((error && error.message) || error)}`);
      }
      state.phase = 'provisioning';
      const provisioned = await provision(session);
      log(provisioned.ok
        ? `guest 侧已就绪：/bin/bash 可用；可选 SSH 工具=${state.guestSsh}`
        : `guest 侧 bash 未装成（exit=${provisioned.exitCode}）：${provisioned.text}`
          + `（安装日志：${share}/dshm-vm-pkg.log）`);
      state.session = session;
      state.phase = 'ready';
      state.detail = provisioned.ok
        ? `就绪（${Math.round((state.readyAt - state.startedAt) / 1000)} s；SSH=${state.guestSsh}）`
        : `QGA 就绪但 guest bash 未装成：${provisioned.text}`;
      return provisioned.ok
        ? { ok: true }
        : { ok: false, error: `guest 侧 bash 不可用：${provisioned.text}` };
    } catch (error) {
      const message = String((error && error.message) || error);
      state.lastError = message;
      state.phase = 'failed';
      if (state.detail.length === 0) state.detail = message;
      // 失败必须留痕：这行是「模型看到的报文」与「真机现场」之间唯一的对应关系。
      log(`VM 启动失败（阶段 ${state.phase}）：${message}`);
      const tail = serialTail();
      if (tail.length > 0) log(`串口尾部：${tail}`);
      return { ok: false, error: message };
    } finally {
      clearInterval(hb);
      pending = null;
    }
  })();
  return pending;
}

/** 已就绪的 QGA 会话（未就绪返回 null；调用方先 `await ensureRunning()`）。 */
export function session() {
  return state.phase === 'ready' ? state.session : null;
}

/**
 * 通过 QMP 优雅关机（唯一安全的停机方式：kill 线程会留下半写 qcow2）。
 *
 * 【P0-1 / docs/388：返回 Promise，让宿主等它结束再退出进程】旧实现发完 `quit`
 * 就立刻返回，而宿主 `requestStop` 在 1.5 s 后 `process.exit(0)` —— QEMU 是
 * **同进程 worker 线程**（`startWorker()`），这一刀下去 guest 还没刷完盘，
 * `rootfs.qcow2` 半写；而 `stage()` 只在镜像不存在时才重拷 ⇒ 坏镜像跨启动
 * 一直留着，VM 以后每次都起不来，只能清应用数据自救。
 * 完成判据：worker 线程退出（QMP 连接随之关闭）；连不上 / 不响应都有超时兜底，
 * 绝不让"停止核心"变成永久挂起。
 */
export const VM_STOP_GRACE_MS = 8000;
let stopping = null;

export function stop() {
  if (stopping !== null) return stopping;
  const worker = state.worker;
  const socket = state.session;
  if (worker === null && socket === null) return Promise.resolve();
  if (socket !== null) {
    try {
      socket.close();
    } catch {
      /* 关连接失败不影响进程退出 */
    }
    state.session = null;
  }
  stopping = new Promise((resolve) => {
    let done = false;
    let timer = null;
    let qmp = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      if (worker !== null) worker.removeListener('exit', finish);
      if (qmp !== null) qmp.destroy();
      resolve();
    };
    // 兜底：QEMU 不响应 quit / worker 不退出时，也不能把整个应用卡在"正在停止"。
    // 刻意不 unref —— 这个定时器就是要撑住事件循环直到收尾完成。
    timer = setTimeout(() => {
      log('VM stop timeout: worker exit unconfirmed');
      finish();
    }, VM_STOP_GRACE_MS);
    if (worker !== null) {
      // QEMU 收到 quit 后 qemu_system_entry 返回 ⇒ worker 线程退出 ⇒ 镜像已刷完。
      worker.once('exit', finish);
    }
    try {
      qmp = createConnection({ path: sockets().qmp });
      qmp.on('connect', () => {
        qmp.write(`${JSON.stringify({ execute: 'qmp_capabilities' })}\n`);
        qmp.write(`${JSON.stringify({ execute: 'quit' })}\n`);
      });
      qmp.on('data', () => { /* greeting/response is not worker exit */ });
      qmp.on('error', () => {
        // QMP 不可达：worker 还在就继续等它退出，否则立即收尾（没 VM 可关）。
        if (worker === null) finish();
      });
    } catch {
      if (worker === null) finish();
    }
  }).finally(() => { stopping = null; });
  return stopping;
}


/** 机器可读状态（进宿主自检，避免"只能靠用户复现"）。 */
export function diagnostics() {
  const assets = assetsPresent();
  const profile = vmTierProfile();
  return {
    phase: state.phase,
    lifecycle: readLifecycleState(),
    detail: state.detail,
    attempt: state.attempt,
    lastError: state.lastError,
    preloaded: state.preloaded,
    spawned: state.spawned,
    extraShare: state.extraShare,
    cwdMiss: state.cwdMiss,
    // 老镜像「最小 init」迁移结果：pending | current | installed | failed。
    // "下次还是慢"这条唯一能被解释的地方就是这里（installed ⇒ 下次冷启动生效）。
    guestInit: state.guestInit,
    // SSH/Dropbear 是可选工具：lazy = wrapper 已就位，首次调用时才安装。
    guestSsh: state.guestSsh,
    qga: state.session === null ? null : state.session.stats(),
    assetsOk: assets.ok,
    assetsMissing: assets.missing,
    lib: qemuLibraryPath(),
    libSize: safeSize(qemuLibraryPath()),
    share: String(process.env.DSHM_SANDBOX_HOME || ''),
    workDir: vmWorkDir(),
    // 上架自检 CppCrash 的守卫读数：内存不足时 ensureRunning 会在 spawn 之前拒绝。
    memAvailableMib: defaultMemAvailable(),
    memoryTier: profile.tier,
    totalMemoryMib: profile.totalMib,
    minAvailableMib: profile.minAvailableMib,
    tcgBufferMib: profile.tcgBufferMib,
    // guest 内存读数：真机上"起得慢/被 OOM"时，第一件要确认的事就是这台的 guest 拿了多少。
    memoryMib: vmMemoryMib(process.env, profile.totalMib),
    defaultMemoryMib: profile.defaultMemoryMib,
    startedAt: state.startedAt,
    readyAt: state.readyAt,
    serialTail: serialText(SERIAL_DIAG_BYTES),
  };
}

function safeSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

/** 供自检/离线门禁使用：把 argv 也算出来（不启动任何东西）。 */
export function describe(options = {}) {
  const extra = options.extraShare === undefined ? state.extraShare : options.extraShare;
  return { argv: bootArgv(extra), ready: state.phase === 'ready', phase: state.phase };
}

/** 读回 rootfs 是否已存在（首启之后应为 true）。 */
export function rootfsStaged() {
  return existsSync(workPath('rootfs.qcow2'));
}

/** 供诊断：rootfs 副本大小。 */
export function rootfsSize() {
  return safeSize(workPath('rootfs.qcow2'));
}
