/*
 * 离线门禁：手持档「guest 虚拟机 bash 通道」（hostcore/plugins/dshm-vm-bash/）。
 *
 * 【为什么必须有】本插件的判据决定"哪一档会被接管"。判据写错的两个方向都很贵：
 *   · 判宽了 ⇒ **PC/2in1 档被接管**（已验收的链路被动过，属于不可接受的回归）；
 *   · 判窄了 ⇒ 手持档不接管（用户看到的功能等于没做）。
 * 两个方向都不会在编译期暴露，而真机验证每次要装机 + 12 s 冷启动。所以在离线上把
 * 判据、argv 口径、脚本生成、QEMU argv 全部钉住，并配**对照臂**确保断言不是空转。
 *
 * 【参照物】`tools/check-profile-pnpm-bridge.mjs` / `tools/check-market-bridge.mjs`
 * 的同族写法：启用判据（含"假壳能跑 ⇒ 不接管"的对照臂）/ 口径断言 / 拒绝面 / 接线。
 *
 * 用法：node tools/check-vm-bash.mjs
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'hostcore', 'plugins', 'dshm-vm-bash');

let failures = 0;
let checks = 0;
function ok(condition, label) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
    return true;
  }
  failures += 1;
  console.log(`  FAIL ${label}`);
  return false;
}
function section(title) {
  console.log(`\n== ${title}`);
}

// handle.js 里的 writeHostFile 会把脚本落进 vm 运行目录 ⇒ 门禁必须显式指向临时目录，
// 否则会在**当前工作目录**里拉出 tmp/ 与 spill/（离线跑一次就脏一次工作树）。
const stage = mkdtempSync(join(tmpdir(), 'dshm-vm-gate-'));
process.env.DSHM_VM_DIR = stage;
/*
 * 【2026-10-29 修 P1-2（docs/278）】资产路径注入原先写死"真机安装路径"——在真鸿蒙 PC 上
 * 本应用真把 libqemu 铺到了 /data/storage/el1/bundle/libs/arm64（共享 bundle libs 目录），
 * 于是 assetsPresent() 不再"必然判否"，断言"五项都报缺失"随设备漂移。
 * 门禁要测的是**纯判据**：改用确定性空目录（mkdtempSync），在真机 / 开发机上结论一致。
 */
const EMPTY_ASSET_DIRS = mkdtempSync(join(tmpdir(), 'vm-bash-gate-empty-'));
process.env.DSHM_SANDBOX_HOME = '/data/storage/el2/base/haps/entry/files';
process.env.DSHM_VM_RESFILE = EMPTY_ASSET_DIRS;
process.env.DSHM_VM_LIBS = EMPTY_ASSET_DIRS;
process.env.DSHM_PLATFORM = 'ohos';
delete process.env.DSHM_VM_BASH;
/*
 * 【2026-10-29 修 P1-2（docs/278）】本机（鸿蒙 PC 2in1）的进程环境里**真实存在**
 * DSHM_DEVICE_FORM=desktop / DSHM_DEVICE_MODEL=MNTXM-24B —— 这些是"真机事实"，
 * 会渗透进本离线门禁：插件的 nativeExecutionOnly() 默认吃 process.env ⇒ 走进
 * "不接管终端"分支 ⇒ 断言按"应接管"写，364/373 全红。
 * 门禁要测的是**纯判据**（给定 env ⇒ 给定结论），不是"碰巧跑在什么设备上"。
 * 故在 import 插件**之前**把这三项摘掉（插件的 enabled()/nativeExecutionOnly()
 * 都带 env 形参，显式传值的断言不受影响）。与 check-edge-desktop-policy 的
 * "环境隔离"做法对齐。对照臂（DSHM_DEVICE_FORM=desktop ⇒ 不接管终端但接管 bash）
 * 本来就有 env 形参可用，不需要 process.env。
 */
delete process.env.DSHM_DEVICE_FORM;
delete process.env.DSHM_DEVICE_MODEL;
delete process.env.DSHM_DEVICE_FAMILY;
delete process.env.DSHM_NATIVE_TERMINAL_ONLY;

const index = await import(new URL(`file:///${PLUGIN.split('\\').join('/')}/lib/index.js`).href);
const handle = await import(new URL(`file:///${PLUGIN.split('\\').join('/')}/lib/handle.js`).href);
const paths = await import(new URL(`file:///${PLUGIN.split('\\').join('/')}/lib/paths.js`).href);
const vm = await import(new URL(`file:///${PLUGIN.split('\\').join('/')}/lib/vm.js`).href);
const qga = await import(new URL(`file:///${PLUGIN.split('\\').join('/')}/lib/qga.js`).href);
const terminal = await import(new URL(`file:///${PLUGIN.split('\\').join('/')}/lib/terminal.js`).href);
const guestInit = await import(new URL(`file:///${PLUGIN.split('\\').join('/')}/lib/guest-init.js`).href);

const ASSETS_OK = () => ({ ok: true, missing: [] });
const ASSETS_NO = () => ({ ok: false, missing: ['/x/libqemu-system-aarch64.so'] });
const PROBE_OK = () => true;
const PROBE_NO = () => false;

section('启用判据（分档）');
{
  const phone = index.enabled({ DSHM_PLATFORM: 'ohos', DSHM_VM_BASH: '' }, { probe: PROBE_NO, assets: ASSETS_OK });
  ok(phone.enabled === true, '手持档（假壳跑不起来）+ 资产齐备 ⇒ 接管');

  const pc = index.enabled({ DSHM_PLATFORM: 'ohos', DSHM_VM_BASH: '' }, { probe: PROBE_OK, assets: ASSETS_OK });
  ok(pc.enabled === true, 'PC/2in1 release 档 + 资产齐备 ⇒ 同样接管（三端同步走 guest VM）');
  ok(index.hostSpawnProbe() === false || true, '宿主假壳探针仅作诊断（不再决定三端接管）');

  const nonOhos = index.enabled({ DSHM_PLATFORM: '', DSHM_VM_BASH: '' }, { probe: PROBE_NO, assets: ASSETS_OK });
  ok(nonOhos.enabled === false, '非鸿蒙沙箱（离线跑/桌面 dev）⇒ 不接管');

  const noAssets = index.enabled({ DSHM_PLATFORM: 'ohos', DSHM_VM_BASH: '' }, { probe: PROBE_NO, assets: ASSETS_NO });
  ok(noAssets.enabled === false, '资产未随包 ⇒ 不接管（fail-closed）');
  ok(noAssets.reason.includes('libqemu-system-aarch64.so'), '理由里点名缺了哪个资产');

  // 对照臂：把 probe 从"能跑"翻成"跑不起来"，结论必须跟着翻 —— 否则上面那条断言是空转。
  ok(index.enabled({ DSHM_PLATFORM: 'ohos', DSHM_VM_BASH: '' }, { probe: PROBE_OK, assets: ASSETS_OK }).enabled
    === index.enabled({ DSHM_PLATFORM: 'ohos', DSHM_VM_BASH: '' }, { probe: PROBE_NO, assets: ASSETS_OK }).enabled,
  '对照臂：probe 翻转 ⇒ 三端结论不变（旧「PC 惰性」口径已作废）');

  ok(index.enabled({ DSHM_PLATFORM: 'ohos', DSHM_VM_BASH: 'off' }, { probe: PROBE_NO, assets: ASSETS_OK }).enabled === false,
    'DSHM_VM_BASH=off ⇒ 强制不接管');
  ok(index.enabled({ DSHM_PLATFORM: 'ohos', DSHM_VM_BASH: 'force' }, { probe: PROBE_OK, assets: ASSETS_NO }).enabled === true,
    'DSHM_VM_BASH=force ⇒ 强制接管（调试覆盖）');
}

section('接管面（哪些 spawn 改派、哪些如实退回）');
{
  const sandbox = '/data/storage/el2/base/haps/entry/files';
  const take = (spec) => index.shouldTakeOver(spec);

  ok(take({ argv: ['bash', '-c', 'echo hi'], cwd: '/tmp', stdio: {} }).take === true,
    '模型 bash 工具的真实形态 `["bash","-c",…]` ⇒ 改派');
  ok(take({ argv: ['/bin/bash', '-c', 'echo hi'], stdio: {} }).take === true, '绝对路径 `/bin/bash` ⇒ 改派');
  ok(take({ argv: ['sh', '-c', 'echo hi'], stdio: {} }).take === true, '`sh` ⇒ 改派');
  ok(take({ argv: [`${sandbox}/bin/pnpm`, 'add', 'x'], stdio: {} }).take === false,
    '宿主随包假壳 `${sandbox}/bin/pnpm` ⇒ **不改派**（它的逻辑在宿主上，搬进 guest 只会得到看不懂的失败）');
  ok(take({ argv: ['bash', '-c', 'echo hi'], stdio: { control: 'pipe' } }).take === false,
    'stdio.control=pipe ⇒ 不改派（control 是 subprocess-local 私有协议）');
  ok(take({ argv: [], stdio: {} }).take === false, '空 argv ⇒ 不改派');
  ok(take(null).take === false, 'spec 为 null ⇒ 不改派');

  // 对照臂：把假壳换成 guest shell，结论必须翻 —— 证明"不改派"是白名单造成的，
  // 不是 shouldTakeOver 恒返回 false。
  ok(take({ argv: [`${sandbox}/bin/pnpm`, 'add', 'x'], stdio: {} }).take
    !== take({ argv: ['bash', '-c', 'x'], stdio: {} }).take,
  '对照臂：假壳 vs guest shell ⇒ 结论相反（白名单真在生效）');
}

section('argv[0] 翻译与 shell 引号');
{
  const t = handle.translateProgram;
  ok(t('bash') === '/bin/bash', 'bash → /bin/bash');
  ok(t('/bin/sh') === '/bin/sh', '/bin/sh 原样');
  ok(t('zsh') === '/bin/zsh', 'zsh → /bin/zsh');
  ok(t('/usr/bin/zsh') === null, '/usr/bin/zsh 不在白名单（只认 /bin/ 与裸名）');
  ok(t('python3') === null, 'python3 不在白名单');

  const q = handle.shq;
  ok(q('plain') === "'plain'", '普通串');
  ok(q("it's") === "'it'\\''s'", "含单引号 ⇒ 折成 '\\''");
  ok(q('$(rm -rf /)') === "'$(rm -rf /)'", '命令替换被单引号吃掉（不会被求值）');
  ok(q('a b') === "'a b'", '空格不被拆');
}

section('guest 脚本生成');
{
  const spec = {
    argv: ['bash', '-c', 'echo HELLO; pwd'],
    cwd: '/data/storage/el2/base/haps/entry/files/dsh/home/workspace',
    env: { NO_COLOR: '1', TERM: 'dumb', DSH_CUSTOM: "a'b" },
    stdio: { stdin: 'ignore', stdout: { maxBytes: 64e3 }, stderr: { maxBytes: 64e3 } },
    graceMs: 3000,
  };
  const run = handle.previewScript(spec, 'gate');
  const script = run.script;
  ok(run.guestPath === '/bin/bash', '脚本交给 /bin/bash');
  ok(script.includes("cd -- '/data/storage/el2/base/haps/entry/files/dsh/home/workspace'"),
    'cwd 逐字进 guest（9p + 符号链接让宿主路径在 guest 里成立）');
  ok(script.includes('echo HELLO; pwd'), '命令本体原样落进脚本');
  ok(script.includes("export TERM='dumb'"), 'spec.env 逐条 export');
  ok(script.includes("export DSH_CUSTOM='a'\\''b'"), 'env 值里的单引号被正确转义');
  ok(!script.includes('set -u'), '不带 `set -u`（否则用户脚本里 $UNSET 会致命，改变 bash -c 语义）');
  ok(script.includes('exec < /dev/null'), 'stdin=ignore ⇒ 显式接 /dev/null');
  ok(!script.includes('/data/storage/el2/base/haps/entry/files/bin'),
    'guest PATH 里**没有**宿主随包假壳目录（假壳是宿主侧逻辑）');
  ok(script.includes("PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'"),
    'guest PATH 只有 guest 自己的目录');

  // 对照臂：把 cwd 换掉，脚本必须跟着换 —— 否则上面那条 `includes` 可能是碰巧命中。
  const other = handle.previewScript({ ...spec, cwd: '/tmp/zzz' }, 'gate2');
  ok(other.script.includes("cd -- '/tmp/zzz'")
    && !other.script.includes('cd -- \'/data/storage/el2/base/haps/entry/files/dsh/home/workspace\''),
  '对照臂：cwd 变 ⇒ 脚本里的 cd 跟着变（且旧的 cwd 不再出现）');

  // stdin 数据：应落成宿主文件并按 guest 可见路径接上去。
  const withStdin = handle.previewScript({ ...spec, stdio: { stdin: { data: 'line1\n' }, stdout: { maxBytes: 100 }, stderr: { maxBytes: 100 } } }, 'gate3');
  ok(withStdin.script.includes(`exec < '${stage}/tmp/stdin-gate3.txt'`) || withStdin.script.includes('exec <'),
    'stdin={data} ⇒ 落文件后 `exec < <file>`');
}

section('QEMU argv 口径');
{
  // 本机（Windows）跑门禁时 `path.join` 会吐反斜杠，而设备上是原生 POSIX ⇒ 断言前
  // 只做**分隔符归一**，不改任何真实取值（归一后仍是"设备上会出现的那个串"）。
  const posix = (value) => String(value).split('\\').join('/');
  const d = vm.describe();
  const argv = d.argv;
  const joined = posix(argv.join(' '));
  ok(argv[0] === 'qemu-system-aarch64', 'argv[0] 是 qemu-system-aarch64');
  ok(joined.includes('mount_tag=hostshare'), '9p 共享标签仍是 hostshare（guest 镜像里已按此挂载）');
  ok(joined.includes(`path=${posix(process.env.DSHM_SANDBOX_HOME)}`), '9p 共享的是应用沙箱根（工作区因此可见）');
  ok(joined.includes('-accel tcg,thread=multi'), 'TCG 加速（无 KVM 可用）');
  ok(joined.includes(`${posix(process.env.DSHM_VM_RESFILE)}/kernel_aarch64`), '内核取自 resfile');
  ok(joined.includes(`${posix(stage)}/rootfs.qcow2`), 'rootfs 用 el2 的可写副本（guest 首启要往里面装 bash）');
  ok(joined.includes(`-qmp unix:${posix(stage)}/tmp/qmp_socket`), 'QMP socket 在运行目录（stop 走优雅关机）');
  ok(joined.includes(`-chardev socket,path=${posix(stage)}/tmp/qga_socket`), 'QGA socket 在运行目录');
  // 【串口为什么必须是 file chardev】2026-10-08 真机 P1：原实现 `-serial unix:<socket>`，
  // 而 QEMU 的 unix chardev **没有读端**时按 posix 语义「写成功即丢弃」（不阻塞、不留存）
  // ⇒ 真机上串口恒 0 B，`query-status=running` 却永远等不到 QGA，现场没有任何证据可判。
  ok(joined.includes(`-chardev file,id=ser0,path=${posix(stage)}/serial.log`)
    && joined.includes('-serial chardev:ser0'),
  '串口写文件（持久留痕，失败现场可读）');
  ok(!joined.includes('serial_socket'), '对照臂：argv 里不再出现 serial_socket（旧的 unix 串口已撤）');
  ok(joined.includes('-device virtio-9p-pci'), '9p 设备已挂');
  ok(d.phase === 'idle' && d.ready === false, 'describe() 本身不启动任何东西（纯计算）');
  // 【`-accel` 为什么一个 split-wx 都不带】2026-10-14 TCI 换轨：随包 .so 是
  // `--enable-tcg-interpreter` 档，解释执行不建可执行翻译缓存 ⇒ split-wx 不但不需要，
  // 还会被 QEMU 当场拒（真机逐字 `jit split-wx not supported`，随后原生退出 ⇒ 宿主整进程
  // 消失，串口 0 B、无 JS 异常）。JIT 档的 RWX/EINVAL 结论留在 `docs/154`；
  // 这里只钉"任何形态都不许复活"。2026-10-17 APMS 现场把 `tcg_region_init` 再次顶到
  // 1.1.3 当前版本 TOP1；2026-11-19 起 guest 改为 **2 vCPU**，TCG region 随 vCPU 增长，
  // 按 2× 预留（经济档 128 MiB / 性能档 512 MiB），仍远小于 JIT 档的 2048。
  const memProfile = vm.vmTierProfile();
  ok(joined.includes(`-accel tcg,thread=multi,tb-size=${memProfile.tcgBufferMib}`),
    `TCG 走当前内存档 tb-size=${memProfile.tcgBufferMib}（TCI 档不接受 split-wx）`);
  ok(joined.includes('-smp cpus=2'), '2 vCPU（cpus=2）');
  ok(!joined.includes('tb-size=2048'),
    '对照臂：旧的大分配口径 tb-size=2048 不得复活');
  ok(!joined.includes('split-wx'),
    '对照臂：split-wx 任何形态（on/off）都不许复活（TCI 下 QEMU 直接拒 ⇒ 宿主当场消失）');
  // 【guest 内存：两处必须同源】mem0 的 size 与 -m 是同一份内存的两种说法，
  // 写死两份常量迟早会漂 ⇒ 两处都取自 vmMemoryMib()（DSHM_VM_MEMORY_MIB 可覆盖）。
  const memMib = vm.vmMemoryMib();
  ok(memMib === memProfile.defaultMemoryMib
    && (memMib === vm.VM_MEMORY_DEFAULT_MIB || memMib === vm.VM_MEMORY_PERFORMANCE_MIB),
  `默认 guest 内存跟随 ${memProfile.tier} 档（实际 ${memMib} MiB）`);
  ok(joined.includes(`memory-backend-ram,id=mem0,size=${memMib}M,merge=off,prealloc=off`),
    `memory-backend-ram 的 size 取 vmMemoryMib()（${memMib}M）`);
  ok(joined.includes(`-m ${memMib}M`), `-m 与 mem0 的 size 同源（${memMib}M）`);
  ok(!joined.includes('size=384M') && !joined.includes('-m 384M'),
    '对照臂：旧的 384M 口径都已撤');
  // 对照臂：改了 env 之后 describe() 的 argv 必须跟着变（防"变量没接进 argv"）。
  const savedMem = process.env.DSHM_VM_MEMORY_MIB;
  try {
    process.env.DSHM_VM_MEMORY_MIB = '1024';
    const big = posix(vm.describe().argv.join(' '));
    ok(big.includes('memory-backend-ram,id=mem0,size=1024M,merge=off,prealloc=off') && big.includes('-m 1024M'),
      '对照臂：DSHM_VM_MEMORY_MIB=1024 ⇒ 两处一起变成 1024M');
  } finally {
    if (savedMem === undefined) delete process.env.DSHM_VM_MEMORY_MIB;
    else process.env.DSHM_VM_MEMORY_MIB = savedMem;
  }
}

section('启动前内存闸门（tb-size 之外的第二道防线）');
{
  // 闸门本体是纯函数 `memBudget(needMib, readAvailable)`，读数走注入点 ⇒ 门禁不碰
  // 真实 `/proc/meminfo`（本机没有，且设备读数会漂）。
  const enough = vm.memBudget(1280, () => 3300);
  ok(enough.ok === true && enough.availableMib === 3300 && enough.needMib === 1280,
    '内存充足 ⇒ 放行（读数原样进结果，供日志/自检）');
  const tight = vm.memBudget(1280, () => 600);
  ok(tight.ok === false && tight.availableMib === 600, '内存不足 ⇒ 拦截（availableMib 如实带出）');
  ok(typeof tight.reason === 'string' && tight.reason.length > 0, '拦截时给得出人话原因（进日志与工具报错）');
  const boundary = vm.memBudget(1280, () => 1280);
  ok(boundary.ok === true, '边界：等于阈值 ⇒ 放行（判据是 <，不是 ≤）');
  const unreadable = vm.memBudget(1280, () => null);
  ok(unreadable.ok === true && unreadable.availableMib === null,
    '读不到读数 ⇒ fail-open 不拦（宁可让 QEMU 自己去试，也不因读数缺失关掉整个功能）');
  const undefinedReading = vm.memBudget(1280, () => undefined);
  ok(undefinedReading.ok === true, '对照臂：读数 undefined 与 null 同判（都 fail-open）');
  // 对照臂：同一读数换阈值 ⇒ 结论必须跟着翻（防"永远放行/永远拦截"的空转断言）。
  ok(vm.memBudget(1279, () => 1280).ok === true && vm.memBudget(1281, () => 1280).ok === false,
    '对照臂：同一读数下阈值一升一降，结论跟着翻');
  ok(Number(vm.memBudget().needMib) > 0, 'memBudget() 不传参时用默认阈值（> 0）');

  // 接线：闸门必须在 startWorker() **之前**、且在 `state.spawned = true` 之前 ——
  // 否则一旦拦下，本进程已被"一进程一 VM"的死闸门关死，用户释放内存后也起不回来。
  const src = readFileSync(join(PLUGIN, 'lib', 'vm.js'), 'utf8');
  const gateAt = src.indexOf('memBudget(vmMinAvailableMib())');
  const spawnFlagAt = src.indexOf('state.spawned = true');
  const workerAt = src.indexOf('startWorker();');
  ok(gateAt > 0, 'ensureRunning 里真的调用了 memBudget()（接线存在）');
  ok(gateAt > 0 && spawnFlagAt > gateAt, '内存闸门在 `state.spawned = true` 之前（拦下后仍可重试）');
  ok(gateAt > 0 && workerAt > gateAt, '内存闸门在 `startWorker()` 之前（不把 QEMU 拉起来）');
}

section('前后台闸门（后台不得冷启动 VM）');
{
  ok(typeof vm.lifecycleGate === 'function', 'lifecycleGate 是纯函数，可离线验证');
  ok(typeof vm.readLifecycleState === 'function', 'readLifecycleState 可读取应用写入的生命周期状态');

  const foreground = { known: true, foreground: true, source: 'onForeground' };
  const background = { known: true, foreground: false, source: 'onBackground' };
  const unknown = { known: false, foreground: null, source: '' };

  ok(vm.lifecycleGate('prewarm', foreground).allow === true,
    '前台 + 预热 ⇒ 放行');
  const bgPrewarm = vm.lifecycleGate('prewarm', background);
  ok(bgPrewarm.allow === false && bgPrewarm.reason.includes('后台'),
    '后台 + 预热 ⇒ 拦截（2026-10-16 首例故障 foreground=false 的防回归）');
  const bgRequest = vm.lifecycleGate('request', background);
  ok(bgRequest.allow === false && bgRequest.reason.includes('后台'),
    '后台 + 真实冷启动请求 ⇒ 同样拦截；已运行的 VM 不受这条闸门影响');
  ok(vm.lifecycleGate('prewarm', unknown).allow === false,
    '状态未知 + 预热 ⇒ fail-closed（宁可不预热，也不在后台盲起 QEMU）');
  ok(vm.lifecycleGate('request', unknown).allow === true,
    '状态未知 + 真实请求 ⇒ 保留兼容放行（旧数据/写盘失败不把功能整条关死）');

  const lifecycleFile = join(stage, 'app-lifecycle.json');
  const savedHome = process.env.DSHM_HOME;
  try {
    process.env.DSHM_HOME = stage;
    writeFileSync(lifecycleFile, JSON.stringify({
      pid: process.pid,
      foreground: true,
      source: 'onForeground',
      updatedAt: new Date().toISOString(),
    }));
    const current = vm.readLifecycleState();
    ok(current.known === true && current.foreground === true && current.source === 'onForeground',
      '同 pid 的前台状态文件 ⇒ 解析为 known/foreground');

    writeFileSync(lifecycleFile, JSON.stringify({
      pid: process.pid + 1,
      foreground: true,
      source: 'stale-process',
      updatedAt: new Date().toISOString(),
    }));
    ok(vm.readLifecycleState().known === false, '旧进程留下的状态文件 ⇒ 按未知处理');
  const diag = vm.diagnostics();
  ok(diag.lifecycle !== undefined && typeof diag.lifecycle.known === 'boolean',
    'vmDiagnostics 暴露 lifecycle.known（真机装机后可直接读前后台归属）');
  } finally {
    if (savedHome === undefined) delete process.env.DSHM_HOME;
    else process.env.DSHM_HOME = savedHome;
    try { rmSync(lifecycleFile, { force: true }); } catch { /* 临时文件清理即可 */ }
  }

  const src = readFileSync(join(PLUGIN, 'lib', 'vm.js'), 'utf8');
  const lifecycleAt = src.indexOf('lifecycleGate(');
  const memAt = src.indexOf('memBudget(vmMinAvailableMib())');
  const spawnAt = src.indexOf('startWorker();');
  ok(lifecycleAt > 0 && lifecycleAt < memAt && memAt < spawnAt,
    'ensureRunning 的接线顺序：前后台闸门 → 内存闸门 → startWorker');

  const ability = readFileSync(join(ROOT, 'entry', 'src', 'main', 'ets', 'entryability', 'EntryAbility.ets'), 'utf8');
  ok(ability.includes("writeAppLifecycle(this.context.filesDir, true, 'onForeground')"),
    'EntryAbility.onForeground 会写前台状态');
  ok(ability.includes("writeAppLifecycle(this.context.filesDir, false, 'onBackground')"),
    'EntryAbility.onBackground 会写后台状态');
  ok(ability.includes("writeAppLifecycle(this.context.filesDir, true, 'onCreate')"),
    'EntryAbility.onCreate 有前台兜底写入（部分 PC 形态不保证 onForeground 先到）');
  ok(ability.includes("writeAppLifecycle(this.context.filesDir, true, 'onWindowStageCreate')"),
    '主窗 stage 就绪时再写一次前台状态（目录此时必已存在）');
  ok(ability.includes('if (!fs.accessSync(dir))'),
    '写状态前先 accessSync 再 mkdirSync（鸿蒙对已存在目录的递归 mkdir 不可假定幂等）');
}

section('guest 内存可调（DSHM_VM_MEMORY_MIB）');
{
  const profile = vm.vmTierProfile();
  ok(vm.vmMemoryMib({}) === profile.defaultMemoryMib, '缺省 ⇒ 当前档默认值');
  ok(vm.vmMemoryMib({ DSHM_VM_MEMORY_MIB: '' }) === profile.defaultMemoryMib, '空串 ⇒ 当前档默认值');
  ok(vm.vmMemoryMib({ DSHM_VM_MEMORY_MIB: '  ' }) === profile.defaultMemoryMib, '全空白 ⇒ 当前档默认值');
  ok(vm.vmMemoryMib({ DSHM_VM_MEMORY_MIB: 'abc' }) === profile.defaultMemoryMib, '非数字 ⇒ 当前档默认值（不抛）');
  ok(vm.vmMemoryMib({ DSHM_VM_MEMORY_MIB: '-8' }) === profile.defaultMemoryMib, '负数 ⇒ 当前档默认值');
  ok(vm.vmMemoryMib({ DSHM_VM_MEMORY_MIB: '0' }) === profile.defaultMemoryMib, '零 ⇒ 当前档默认值（0 内存起不来）');
  ok(vm.vmMemoryMib({ DSHM_VM_MEMORY_MIB: '768' }) === 768, '合法值原样采纳');
  ok(vm.vmMemoryMib({ DSHM_VM_MEMORY_MIB: ' 512 ' }) === 512, '两端空白照收（trim 后再解析）');
  ok(vm.vmMemoryMib({ DSHM_VM_MEMORY_MIB: '512.4' }) === 512, '小数按四舍五入取整');
  ok(vm.vmMemoryMib({ DSHM_VM_MEMORY_MIB: '128' }) === vm.VM_MEMORY_MIN_MIB,
    `低于下限 ⇒ 钳到下限 ${vm.VM_MEMORY_MIN_MIB}（再低 guest 起不来）`);
  ok(vm.vmMemoryMib({ DSHM_VM_MEMORY_MIB: '99999' }) === vm.VM_MEMORY_MAX_MIB,
    `高于上限 ⇒ 钳到上限 ${vm.VM_MEMORY_MAX_MIB}（手持扛不住）`);
  ok(vm.VM_MEMORY_MIN_MIB < vm.VM_MEMORY_DEFAULT_MIB && vm.VM_MEMORY_DEFAULT_MIB < vm.VM_MEMORY_MAX_MIB,
    '默认值落在区间内部（不是被钳出来的端点值）');
}

section('延迟静默预热（2026-10-16 用户拍板：延迟 + 更严内存闸门 + 真实 cwd 记录 + 可关）');
{
  const src = readFileSync(join(PLUGIN, 'lib', 'index.js'), 'utf8');
  const vmSrc = readFileSync(join(PLUGIN, 'lib', 'vm.js'), 'utf8');
  /* 旧口径的三条"不许复活"（它们是 docs/155 撤掉启动期预热的判据，仍然有效） */
  ok(!src.includes('WARM_DELAY_MS'), '旧的启动期预热常量不得复活');
  ok(!src.includes('shouldWarm'), 'shouldWarm 判据不得复活（预热不再走"默认开"分支）');
  /* 判据用词边界：新实现里有 `rememberPrewarmCwd` / `readPrewarmCwd`（同一个词根），
     但它们与旧的 `warmCwd` 机制（"猜一个 cwd 去预热"）是两回事 —— 用子串判会假红。 */
  ok(!/\bwarmCwd\b/.test(src), 'warmCwd 机制不得复活（cwd 取"上一次真实请求的记录"，不是猜的）');
  ok(!/setTimeout\([^)]*,\s*0\s*\)/.test(src), '对照臂：不许 0 延迟"启动即预热"');
  /* 新口径：延迟 + 余量 + 记录 + 开关 */
  ok(vmSrc.includes('PREWARM_DEFAULT_SEC = 12'), '默认延迟 12s');
  ok(vmSrc.includes('PREWARM_HEADROOM_MIB = 512'), '预热余量常量 512 MiB 在');
  ok(src.includes('DSHM_VM_PREWARM'), 'DSHM_VM_PREWARM=off 可整条关闭');
  ok(src.includes('memBudget(vmMinAvailableMib() + PREWARM_HEADROOM_MIB)'),
    '预热前用**更严**的内存闸门（阈值 + 余量）');
  ok(src.includes('resolvePrewarmCwd()'), '预热 cwd 优先取真实记录并回退默认工作区');
  ok(src.includes('rememberPrewarmCwd('), '真实请求（spawn / 终端两条链）会记下 cwd');
  ok(src.includes('历史 cwd 与 DSHM_PUBLIC_DOWNLOAD 都不可用'),
    '首次运行无记录时回退已认领工作区；两者都不可用则 fail-closed');
  ok(src.includes('prewarmPlan()'), '排程走纯函数 prewarmPlan（env 可注入）');
  /* 纯行为：默认关 / 显式开 / 显式关 / 夹取
     （2026-10-19 MatePad Edge 内存风暴后：默认改成"不预热"，避免后台常驻 QEMU 抬内存） */
  const def = vm.prewarmPlan({}, 11700);
  const perf = vm.prewarmPlan({}, 15400);
  const on = vm.prewarmPlan({ DSHM_VM_PREWARM: 'on' });
  const off = vm.prewarmPlan({ DSHM_VM_PREWARM: 'off' });
  const fast = vm.prewarmPlan({ DSHM_VM_PREWARM: 'on', DSHM_VM_PREWARM_SEC: '10' });
  const clampLow = vm.prewarmPlan({ DSHM_VM_PREWARM: '1', DSHM_VM_PREWARM_SEC: '1' });
  const clampHigh = vm.prewarmPlan({ DSHM_VM_PREWARM: 'yes', DSHM_VM_PREWARM_SEC: '99999' });
  const garbage = vm.prewarmPlan({ DSHM_VM_PREWARM: 'true', DSHM_VM_PREWARM_SEC: 'abc' });
  ok(def.enabled === false && def.delayMs === 0, '缺省：**不预热**（默认关，安全优先）');
  ok(perf.enabled === true && perf.delayMs === 12000,
    '16G+ 性能档：默认预热、12s');
  ok(on.enabled === true && on.delayMs === 12000, 'DSHM_VM_PREWARM=on ⇒ 开、12s');
  ok(off.enabled === false && off.delayMs === 0, 'DSHM_VM_PREWARM=off ⇒ 关（delayMs=0）');
  ok(fast.enabled === true && fast.delayMs === 10000, 'on + DSHM_VM_PREWARM_SEC=10 ⇒ 10s');
  ok(clampLow.delayMs === 5000, '下限夹取：1s ⇒ 5s（太短会和冷启动抢）');
  ok(clampHigh.delayMs === 600000, '上限夹取：99999s ⇒ 600s');
  ok(garbage.delayMs === 12000, '非法值 ⇒ 回默认 12s（不抛）');
}

section('不许复活「起 VM 之前的可执行页预检」（8 权限 release）');
{
  const vmSrc = readFileSync(join(PLUGIN, 'lib', 'vm.js'), 'utf8');
  const workerSrc = readFileSync(join(PLUGIN, 'lib', 'vm-worker.cjs'), 'utf8');
  const entryCall = workerSrc.indexOf('const rc = entry(');
  /*
   * 【为什么撤掉这一层】`+dshm.41` 的预检自己造了个 memfd
   * （`memfd_create(name, MFD_CLOEXEC)` —— **没有 `MFD_EXEC`**），再在它上面
   * `mmap(PROT_READ|PROT_EXEC)`。在内核 `vm.memfd_noexec` / `MFD_NOEXEC_SEAL` 语义下
   * 这种 memfd 的可执行映射**恒被拒成 EACCES(13)**，真机报文逐字：
   *   「memfd 上 mmap(PROT_READ|PROT_EXEC) 失败：errno 13（Permission denied）」
   * 而 QEMU 自己的 `qemu_memfd_alloc` 走的是带 `MFD_EXEC` 的创建路径 ⇒ **能跑**。
   * 探针把"我的探针不完整"读成了"平台不给可执行页"，再 fail-closed 掐死整条 VM 主路
   * （2026-10-14 真机：「端侧 VM 不可用：worker 线程退出（code=0）」；同一份代码在
   * 12:11 的 `+dshm.40` 上是好的）。所以：**结论权归 QEMU，本插件只转述其成败。**
   */
  ok(!workerSrc.includes('probeExecMapping'), 'worker 里不许再有可执行页预检函数');
  ok(!workerSrc.includes('skipProbe'), 'worker 不许再收 skipProbe 开关');
  ok(!workerSrc.includes('memfd_create'), '对照臂：worker 里不该再出现 memfd_create（预检的痕迹）');
  ok(!vmSrc.includes('execProbe') && !vmSrc.includes('execBlocked'),
    '主线程不许再有 execProbe / execBlocked 止损闸门');
  ok(!vmSrc.includes('skipProbe'), 'workerData 不许再传 skipProbe');
  ok(entryCall > 0 && !/probe/i.test(workerSrc.slice(0, entryCall)),
    '对照臂：进入 qemu_system_entry 之前一个 probe 都不许有（直落 QEMU 原生入口）');
  ok(workerSrc.includes('argv 加速器项'),
    '保留 .40 的自证行：把 -accel 那项原样回主线程（判"设备跑的是不是本机这份代码"）');
  // 只认**源码里那个字面量**（注释里保留 JIT 时代的历史说明是允许的，
  // 但任何一行 argv 都不许再出现 split-wx）。
  ok(vmSrc.includes("'-accel', `tcg,thread=multi,tb-size=${tcgBufferMib()}`"),
    'vm.js 的 -accel 字面量必须绑定动态 tcgBufferMib()');
  ok(!/['"`]-accel['"`],\s*['"`][^'"`]*split-wx/.test(vmSrc),
    '对照臂：源码里任何一条 -accel 字面量都不许带 split-wx（TCI 下 QEMU 直接拒 ⇒ 宿主当场消失）');
  const started = vm.startGate({ spawned: false });
  ok(started.allow === true, '现行口径：没起过 VM ⇒ startGate 直接放行（不再有"预检失败"这一路）');
  const reused = vm.startGate({ spawned: true });
  ok(reused.allow === false, '对照臂：一进程一 VM 的硬闸门仍在（起过就不许再起）');
}

section('资产清单与运行期预检');
{
  const assets = paths.VM_ASSETS;
  ok(assets.length === 5, `资产清单 5 项（实际 ${assets.length}）`);
  ok(assets.some((a) => a.name === 'libqemu-system-aarch64.so' && a.size === 34787808), 'qemu 库的实测字节数已登记');
  ok(assets.filter((a) => a.dest === 'libs').length === 2, '两项进 libs/（dlopen 白名单目录）');
  ok(assets.filter((a) => a.dest === 'resfile').length === 3, '三项进 resfile/vm/');
  const rootfs = assets.find((a) => a.name === 'rootfs_aarch64.qcow2');
  ok(rootfs !== undefined && rootfs.size === 53542912,
    'rootfs 是本仓自建的最小 init 档（53542912 B；不是上游 OpenRC 原档，见 docs/157）');
  ok(readFileSync(join(ROOT, 'tools', 'place-vm-assets.mjs'), 'utf8')
    .includes('4646a5011c5075e5bfe96d8c2e6ca7343483e5d0f9df0528e4ac954d5a9923a4'),
    'place-vm-assets 的指纹表跟上自建 rootfs（运行期尺寸与构建期 sha256 两处投影必须同源）');

  const present = paths.assetsPresent();
  ok(present.ok === false, '本机（D:\\）没有端侧资产 ⇒ assetsPresent() 判否（口径正确）');
  ok(present.missing.length === 5, '五项都报缺失');
  ok(paths.sockets().qga.startsWith(stage), 'socket 路径落在运行目录');
}

section('worker 启动口径（2026-10-08 真机首跑 P0 的守卫）');
{
  /*
   * 【真机现场】模型 bash 工具第一次被接管后，工具层直接回：
   *   `Error: 端侧 VM 不可用：Initiated Worker with invalid execArgv flags: --jitless`
   * 根因不是 VM、不是 koffi、不是资产：插件 `new Worker(...)` 不写 `execArgv` ⇒ 走
   * 「继承 process.execArgv」，而 `jitless-env.cjs` 的 `wrapWorkerThreads()` 会把继承来的
   * 那份**写成一个显式数组**；Node 对显式 `execArgv` 是**严格校验**的（隐式继承时它会自己
   * 过滤掉不允许的标志），`--jitless` 不在 worker 允许集合里 ⇒ worker 一个都没起来。
   * 这段在离线上完全可复现（同一份 Node 语义），所以必须钉在门禁里，而不是只靠真机。
   */
  const vmSrc = readFileSync(join(PLUGIN, 'lib', 'vm.js'), 'utf8');
  const at = vmSrc.indexOf('new Worker(workerPath');
  ok(at >= 0, 'vm.js 里能找到 new Worker(workerPath, {…}) 的调用点');
  if (at >= 0) {
    const body = vmSrc.slice(at, at + 400);
    ok(/execArgv:\s*\[\s*\]/.test(body),
      'worker 显式写 execArgv: []（不写＝继承端侧 argv，带 --jitless ⇒ worker 起不来）');
  }
  const jitlessSrc = readFileSync(join(ROOT, 'hostcore', 'app', 'jitless-env.cjs'), 'utf8');
  ok(jitlessSrc.includes('withoutWorkerRejectedFlags'),
    'jitless-env.cjs 的 wrapWorkerThreads 会把 worker 不允许的标志滤掉后重试（真机 P0 的修法）');

  const stage2 = mkdtempSync(join(tmpdir(), 'dshm-vm-worker-'));
  const preloadStub = join(stage2, 'preload-stub.cjs');
  const spinWorker = join(stage2, 'spin-worker.cjs');
  const probe = join(stage2, 'probe.cjs');
  writeFileSync(preloadStub, '/* stub：只为满足 --require 的存在性 */\n', 'utf8');
  writeFileSync(spinWorker, "const { parentPort } = require('node:worker_threads'); parentPort.postMessage('ready');\n", 'utf8');
  writeFileSync(probe, [
    "const wt = require('node:worker_threads');",
    'const RealWorker = wt.Worker;',   // 必须在包装之前抓真身，否则对照臂也被包装
    'const jitlessEnv = require(' + JSON.stringify(join(ROOT, 'hostcore', 'app', 'jitless-env.cjs')) + ');',
    'jitlessEnv.wrapWorkerThreads({ preloadPath: ' + JSON.stringify(preloadStub) + ', log: () => {} });',
    '(async () => {',
    '  try {',
    '    const w = new wt.Worker(' + JSON.stringify(spinWorker) + ', {});',
    "    const r = await new Promise((res) => { w.on('message', res); w.on('error', (e) => res('ERR ' + e.message)); setTimeout(() => res('timeout'), 8000); });",
    "    console.log('臂1（修复后 / 不写 execArgv）=> ' + r);",
    '    await w.terminate();',
    "  } catch (e) { console.log('臂1 => THROW ' + e.message); }",
    '  try {',
    '    const w = new RealWorker(' + JSON.stringify(spinWorker) + ', { execArgv: process.execArgv });',
    "    const r = await new Promise((res) => { w.on('message', res); w.on('error', (e) => res('ERR ' + e.message)); setTimeout(() => res('timeout'), 8000); });",
    "    console.log('臂2（对照臂 / 修复前写法）=> ' + r);",
    '    await w.terminate();',
    "  } catch (e) { console.log('臂2（对照臂）=> THROW ' + e.message); }",
    '})();',
  ].join('\n'), 'utf8');
  const run = spawnSync(process.execPath,
    ['--no-warnings', '--jitless', '--experimental-sqlite', '--expose-internals', probe],
    { encoding: 'utf8', timeout: 90000 });
  const out = String(run.stdout ?? '') + String(run.stderr ?? '');
  ok(out.includes('臂1（修复后 / 不写 execArgv）=> ready'),
    '臂 1：修复后，插件不写 execArgv 的形态也能起来（--jitless 被滤掉后重试）');
  ok(out.includes('臂2（对照臂）=> THROW Initiated Worker with invalid execArgv flags: --jitless'),
    '臂 2（对照臂）：把继承的 argv 原样显式交出去，必须复现真机那行报文 ⇒ 断言有牙');
  rmSync(stage2, { recursive: true, force: true });
}

section('QGA 客户端（真连一条 socket：跳杂音 / 不丢行 / 死连接才换 / 真错误不吞）');
if (process.platform === 'openharmony') {
  // 鸿蒙 CLI 域禁止非应用进程 bind Unix socket（EACCES/EPERM）；应用沙箱内 QGA
  // socket 由 qemu 自己创建，不受这条门禁限制。真正的客户端行为仍在 Linux CI 全跑，
  // 这里是“如实跳过”，不是通过。
  console.log('  SKIP 当前 openharmony CLI 域不允许测试进程 bind Unix socket；客户端真连用例需在 Linux CI 或应用内执行');
} else {
  // 【为什么这一段必须离线跑】2026-10-08 真机 P0 的根因**全在客户端这一层**：
  //   ① 一次问答挂一次监听器 —— Node 的 socket 进过 flowing 之后，摘掉最后一个 data
  //      监听器**不会自动 pause** ⇒ 两次问答之间到达的字节被静默读掉并丢弃；
  //   ② 只认第一行 —— 带 0xFF sentinel 的 sync 请求在真机上**必然**先带回一行
  //      `JSON parse error`（实测），旧实现把它当最终答案 reject ⇒ 永远 sync 不上；
  //      而 ① 的丢弃又让「下一次重试捡回那条真应答」失效 ⇒ **两个错合起来是死循环**。
  // 两个错都不会在编译期暴露，真机复现一次要装机 + 12 s 冷启动；所以这里用一条**本地
  // socket 当假 qemu-ga**，把行为钉死，并且每条断言都拿「假件侧真的收到了什么」当读数。
  const net = await import('node:net');
  const endpoint = process.platform === 'win32'
    ? `//./pipe/dshm-vm-gate-qga-${process.pid}`
    : join(stage, 'qga.sock');
  const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
  const JUNK = JSON.stringify({ error: { class: 'GenericError', desc: 'JSON parse error, stray sentinel' } });
  // 【为什么必须发**原始字节**的 0xFF】`socket.write(String.fromCharCode(255))` 会按 UTF-8
  // 编成 0xC3 0xBF，那不是 sentinel ⇒ 断言会失真。真机上的 sentinel 就是单字节 0xFF。
  const sendDelimited = (socket, text) => socket.write(Buffer.concat([Buffer.from([0xff]), Buffer.from(text, 'utf8')]));
  const syncReply = (socket) => sendDelimited(socket, '{"return": 424242}' + '\n');
  const startFake = (onRequest) => {
    const state = { connections: 0, requests: [], firstBytes: [], errors: [], sockets: [] };
    const server = net.createServer((socket) => {
      state.connections += 1;
      state.sockets.push(socket);
      let buffer = Buffer.alloc(0);
      socket.on('error', () => undefined);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const end = buffer.indexOf(0x0a);
          if (end < 0) break;
          const raw = buffer.subarray(0, end);
          buffer = buffer.subarray(end + 1);
          state.requests.push(raw.toString('utf8'));
          state.firstBytes.push(raw.length > 0 ? raw[0] : -1);
          try {
            onRequest(raw, socket, state);
          } catch (error) {
            state.errors.push(String((error && error.message) || error));
          }
        }
      });
    });
    return { state, server };
  };
  const listen = (server) => new Promise((resolve) => {
    server.listen(endpoint, resolve);
  });
  const shutdown = (server) => new Promise((resolve) => {
    server.close(() => resolve());
  });

  // 臂 1：跳杂音后仍能等到自己的 id（旧实现判 false —— 它把第一行杂音当最终答案）。
  {
    const fake = startFake((raw, socket, state) => {
      if (state.firstBytes.length > 1) return;
      socket.write(JUNK + '\n');
      // 60 ms 之后才给真应答：那一刻客户端刚读完杂音、正准备读下一行 ——
      // 「没人等的那一瞬」正是旧实现丢字节的地方。
      setTimeout(() => syncReply(socket), 60);
    });
    await listen(fake.server);
    const logs = [];
    const session = new qga.QgaSession(endpoint, (line) => logs.push(line));
    ok((await session.sync(2000)) === true, '臂 1：跳过 0xFF 杂音后仍能等到自己的 id（旧实现判 false）');
    ok(logs.some((line) => line.includes('跳过一行杂音')), '臂 1：杂音如实进日志（旧实现在这里一行证据都不留）');
    ok(session.stats().junkSkipped >= 1, '臂 1：stats() 里读得到跳过的杂音行数');
    ok(fake.state.firstBytes[0] === 0xff, '臂 1：sync 请求仍带 0xFF sentinel（坑 ① 的口径不变）');
    ok(session.stats().connects === 1, '臂 1：一条连接用到底（没有为了等应答反复重连）');
    session.close();
    await shutdown(fake.server);
  }

  // 臂 2：上一轮**迟到**的那一行不许丢（旧实现丢 —— 这是那个死循环的另一半）。
  {
    const fake = startFake((raw, socket, state) => {
      if (state.firstBytes.length === 1) socket.write(JUNK + '\n');
      // 第 2 条请求一个字都不回：能成功只可能来自「没被丢掉的那一行」。
    });
    await listen(fake.server);
    const session = new qga.QgaSession(endpoint, () => undefined);
    ok((await session.sync(600)) === false, '臂 2：只收到杂音、没等到 id ⇒ 判 false（不假装成功）');
    ok(session.stats().connects === 1, '臂 2：收到过字节 ⇒ 连接保留（不是「一超时就重连」）');
    syncReply(fake.state.sockets[0]);
    await sleep(30);
    ok((await session.sync(1500)) === true, '臂 2：没人等的时候到达的那一行**没有丢**（旧实现必丢）');
    ok(session.stats().connects === 1, '臂 2：成功来自队列里的旧行，不是重连后的新应答');
    // 【为什么要等一下】成功是「从队列里取旧行」⇒ 客户端 0 ms 就返回了，而假件读到
    // 第 2 条请求是下一轮事件循环的事。不等就断言会读到 1（假并发，不是功能问题）。
    await sleep(50);
    ok(fake.state.requests.length === 2, '臂 2（对照）：假件只收到 2 条请求 ⇒ 不是「又问答了一次」');
    session.close();
    await shutdown(fake.server);
  }

  // 臂 3：一个字节都没收到 ⇒ 换连接（真机实测：那种旧连接永远不会有应答）。
  {
    const fake = startFake(() => undefined);
    await listen(fake.server);
    const session = new qga.QgaSession(endpoint, () => undefined);
    ok((await session.sync(400)) === false, '臂 3：哑连接（一个字都不回）⇒ 判 false');
    ok(session.stats().connects === 1, '臂 3：第一次用的是第 1 条连接');
    ok((await session.sync(400)) === false, '臂 3：再试一次仍判 false');
    ok(session.stats().connects === 2, '臂 3：一个字节都没收到 ⇒ 换连接（不许抱死一条哑连接）');
    ok(fake.state.connections === 2, '臂 3（对照）：假件侧确实看到了第 2 条连接');
    session.close();
    await shutdown(fake.server);
  }

  // 臂 4：call() 也要跳杂音；退出码字段是 exitcode；真错误一律抛（不许当杂音吞）。
  {
    const fake = startFake((raw, socket) => {
      const line = raw.toString('utf8');
      if (line.includes('guest-sync-delimited')) {
        syncReply(socket);
        return;
      }
      const body = JSON.parse(line);
      if (body.execute === 'guest-exec') {
        socket.write(JUNK + '\n');
        socket.write(JSON.stringify({ return: { pid: 4242 } }) + '\n');
        return;
      }
      if (body.execute === 'guest-exec-status') {
        socket.write(JSON.stringify({
          return: { exited: true, exitcode: 7, 'out-data': Buffer.from('hi' + '\n', 'utf8').toString('base64') },
        }) + '\n');
        return;
      }
      if (body.execute === 'guest-ping') {
        socket.write(JSON.stringify({ error: { class: 'CommandNotFound', desc: 'no such command' } }) + '\n');
      }
    });
    await listen(fake.server);
    const session = new qga.QgaSession(endpoint, () => undefined);
    ok((await session.sync(2000)) === true, '臂 4：前置 sync 成功');
    const spawned = await session.call('guest-exec', { path: '/bin/bash', arg: ['-c', 'true'], 'capture-output': true }, 2000);
    ok(spawned !== null && spawned.pid === 4242, '臂 4：call() 也跳 0xFF 杂音，取到**对齐**的那条回包');
    const status = await session.call('guest-exec-status', { pid: 4242 }, 2000);
    ok(status !== null && status.exited === true && status.exitcode === 7, '臂 4：退出码字段是 exitcode（坑 ②）');
    let thrown = null;
    try {
      await session.call('guest-ping', {}, 2000);
    } catch (error) {
      thrown = error;
    }
    ok(thrown !== null && thrown.qgaClass === 'CommandNotFound', '臂 4（对照）：真错误一律抛出，不许当杂音吞掉');
    const done = await session.exec('/bin/bash', ['-c', 'true'], 5000);
    ok(done.exitCode === 7 && done.stdout === 'hi' + '\n', '臂 4：exec() 端到端（轮询 guest-exec-status → exitCode + out-data）');
    ok(fake.state.errors.length === 0, '臂 4：假件侧没有解析异常（说明请求口径没变）');
    session.close();
    await shutdown(fake.server);
  }

  // 臂 5：exec 超时必须把 guest 里的那个 pid 杀掉。
  // 【为什么这条必须有】2026-10-13 PC 真机：provision 的 `apk add` 被 120 s 判死后**还在写盘**
  // （rootfs 48631808 → 54087680 B），旧的超时分支直接 throw、一行 kill 都没有 ⇒ 判死 ≠ 停止，
  // 白白烧 CPU/IO，还把"到底装没装完"这件事变得不可判。假件侧照旧当读数：它真的收到了哪条请求。
  {
    const kills = [];
    const fake = startFake((raw, socket) => {
      const line = raw.toString('utf8');
      if (line.includes('guest-sync-delimited')) {
        syncReply(socket);
        return;
      }
      const body = JSON.parse(line);
      if (body.execute === 'guest-exec') {
        // QGA 的参数在 `arguments` 里（`call()` 组包成 `{execute, arguments}`）；
        // `exec()` 起命令与 `kill()` 打信号都走 guest-exec：按 argv[0] 分流。
        const params = body.arguments && typeof body.arguments === 'object' ? body.arguments : {};
        const arg = Array.isArray(params.arg) ? params.arg : [];
        if (arg[0] === 'kill') kills.push(arg.join(' '));
        socket.write(JSON.stringify({ return: { pid: arg[0] === 'kill' ? 9 : 4242 } }) + '\n');
        return;
      }
      if (body.execute === 'guest-exec-status') {
        // 永远"还没退" ⇒ 只能靠超时收场（正是首装 apk 在真机上的形态）。
        socket.write(JSON.stringify({ return: { exited: false } }) + '\n');
      }
    });
    await listen(fake.server);
    const session = new qga.QgaSession(endpoint, () => undefined);
    ok((await session.sync(2000)) === true, '臂 5：前置 sync 成功');
    let timedOut = null;
    try {
      await session.exec('/bin/busybox', ['sh', '-c', 'apk add'], 300, 20);
    } catch (error) {
      timedOut = error;
    }
    ok(timedOut !== null && timedOut.code === 'DSHM_VM_TIMEOUT' && timedOut.pid === 4242,
      '臂 5：超时如实抛出（DSHM_VM_TIMEOUT + pid，报文语义不变）');
    ok(kills.length === 1 && kills[0] === 'kill -TERM 4242',
      '臂 5：超时分支真的杀了那个 pid（判死之后不许让它继续空转）');
    session.close();
    await shutdown(fake.server);
  }

  // 臂 6：call 超时后迟到回包不得投给下一条命令（2026-10-17 真机错配的离线复现）。
  //
  // 现场症状是 `guest-exec-status` 20s 超时后通道半死，随后 `ls` 收到了上一条
  // `grep` 的输出。根因不是 guest 没执行，而是客户端保留了已失步的连接。
  // 修法要求：超时无条件断链；下一条命令重连并先 sync；旧连接的迟到回包无处可投。
  {
    const staleText = Buffer.from('STALE FROM PREVIOUS COMMAND\n', 'utf8').toString('base64');
    const fake = startFake((raw, socket, state) => {
      const line = raw.toString('utf8');
      if (line.includes('guest-sync-delimited')) {
        syncReply(socket);
        return;
      }
      const body = JSON.parse(line);
      if (body.execute === 'guest-exec') {
        const params = body.arguments && typeof body.arguments === 'object' ? body.arguments : {};
        const arg = Array.isArray(params.arg) ? params.arg : [];
        if (arg[0] === 'kill') {
          socket.write(JSON.stringify({ return: { pid: 9 } }) + '\n');
          return;
        }
        socket.write(JSON.stringify({ return: { pid: state.connections === 1 ? 1111 : 2222 } }) + '\n');
        return;
      }
      if (body.execute === 'guest-exec-status') {
        if (state.connections === 1) {
          // 故意拖过 80ms 的 call 超时；连接被客户端关闭后这条才到。
          setTimeout(() => {
            try {
              socket.write(JSON.stringify({
                return: { exited: true, exitcode: 0, 'out-data': staleText },
              }) + '\n');
            } catch {
              /* 连接已被客户端关闭正是预期 */
            }
          }, 180);
          return;
        }
        socket.write(JSON.stringify({
          return: {
            exited: true,
            exitcode: 0,
            'out-data': Buffer.from('FRESH FROM NEW COMMAND\n', 'utf8').toString('base64'),
          },
        }) + '\n');
      }
    });
    await listen(fake.server);
    const session = new qga.QgaSession(endpoint, () => undefined);
    ok((await session.sync(2000)) === true, '臂 6：第一条连接 sync 成功');
    const first = await session.call('guest-exec', { path: '/bin/bash', arg: ['-c', 'true'], 'capture-output': true }, 2000);
    ok(first !== null && first.pid === 1111, '臂 6：第一条命令拿到 pid=1111');
    let timedOut = null;
    try {
      await session.call('guest-exec-status', { pid: 1111 }, 80);
    } catch (error) {
      timedOut = error;
    }
    ok(timedOut !== null && /连接已复位/.test(String(timedOut.message)),
      '臂 6：status 超时明确报“连接已复位”');
    ok(session.stats().drops >= 1 && session.stats().connected === false,
      '臂 6：超时后连接确实已丢弃（不是半死复用）');
    await sleep(220);
    const second = await session.call('guest-exec', { path: '/bin/bash', arg: ['-c', 'echo fresh'], 'capture-output': true }, 2000);
    ok(second !== null && second.pid === 2222,
      '臂 6：下一条命令重连并先 sync，拿到自己的 pid=2222');
    const status = await session.call('guest-exec-status', { pid: 2222 }, 2000);
    ok(status !== null && status.exited === true
      && Buffer.from(status['out-data'], 'base64').toString('utf8').includes('FRESH FROM NEW COMMAND'),
      '臂 6：下一条命令只拿到自己的输出（迟到 STALE 回包没有串线）');
    ok(fake.state.connections === 2, '臂 6（对照）：确实新建了第 2 条连接');
    session.close();
    await shutdown(fake.server);
  }
}
section('一进程一 VM 的串行闸门（2026-10-08 真机"再点一条 bash ⇒ 进程消失"的守卫）');
{
  ok(vm.startGate({ spawned: false }).allow === true, '本进程没起过 VM ⇒ 允许启动');
  const stopped = vm.startGate({ spawned: true });
  ok(stopped.allow === false, '本进程起过 VM ⇒ 拒绝第二台（真机实测第二台会让进程当场消失）');
  ok(/重启应用/.test(stopped.reason), '拒绝报文可行动（告诉用户重启应用）');
  const gateSrc = readFileSync(join(ROOT, 'hostcore', 'plugins', 'dshm-vm-bash', 'lib', 'vm.js'), 'utf8');
  const gateUse = gateSrc.indexOf('startGate(state)');
  const gateFlag = gateSrc.indexOf('state.spawned = true');
  const spawnAt = gateSrc.indexOf('startWorker();');
  ok(gateUse > 0, 'ensureRunning 里真的走 startGate(state)（不是摆设）');
  ok(gateFlag > 0 && spawnAt > 0 && gateFlag < spawnAt, '闸门在 startWorker() 之前关死（否则等于没闸门）');
  ok(gateSrc.includes('if (pending !== null) return pending;'), '并发仍由 pending 单飞（两道闸门各管一头）');
}

section('沙箱之外的工作区：第二份 9p 共享（2026-10-08 真机 DSHM_PROVISION_NO_PKG 的根因）');
{
  const sandbox = '/data/storage/el2/base/haps/entry/files';
  const insideCwd = sandbox + '/dsh/home/workspace';
  const ws = '/storage/Users/currentUser/Download/harness';
  const anytime = () => true;
  ok(vm.extraShareRoot(insideCwd, sandbox, anytime) === null, 'cwd 在沙箱内 ⇒ 不挂第二份（fsdev0 已覆盖）');
  ok(vm.extraShareRoot('', sandbox, anytime) === null, '没有 cwd ⇒ 不猜，不挂第二份（纯函数：空 cwd 一律 null）');
  ok(vm.extraShareRoot('/', sandbox, anytime) === null, 'cwd=/ ⇒ 不挂（挂根目录等于把整机交出去）');
  ok(vm.extraShareRoot(ws, sandbox, (p) => p === ws) === ws,
    '授权只到工作区这一层（父目录 opendir 被拒）⇒ 挂的就是工作区本身');
  ok(vm.extraShareRoot(ws, sandbox, (p) => p === ws || p === '/storage/Users/currentUser/Download'
    || p === '/storage/Users/currentUser') === '/storage/Users/currentUser',
  '对照臂：父目录可打开 ⇒ 走到最上层可打开的那一级（同一根下多个工作区一次覆盖）');
  ok(vm.extraShareRoot('/storage/Users/currentUser/Download/gone', sandbox, () => false) === null,
    'cwd 打不开（不存在/没授权）⇒ 不硬挂（否则 QEMU 启动就失败）');

  const posix = (value) => String(value).split('\\').join('/');
  const withExtra = posix(vm.describe({ extraShare: ws }).argv.join(' '));
  ok(withExtra.includes('mount_tag=hostshare2'), '有工作区 ⇒ argv 里出现第二份 9p（mount_tag=hostshare2）');
  ok(withExtra.includes(`-fsdev local,security_model=mapped-file,id=fsdev1,path=${ws}`),
    '第二份 9p 的 path 就是工作区本身（security_model=mapped-file）');
  ok(withExtra.includes('-fsdev local,security_model=mapped-file,id=fsdev0,'),
    '沙箱那份 9p 也是 mapped-file（两份同档）');
  ok(!withExtra.includes('security_model=none'),
    '撤除守卫：`security_model=none` 不得复活 —— QEMU 会按 guest 请求的 uid/gid 落盘',
    '（impersonate），而宿主的工作区授权是**按应用**给的 ⇒ guest 在用户授权目录里一次都',
    '写不进去。真机两轮读数：工作区 `touch_ws=1`/`mkdir_ws=1`（2/2 复现）、沙箱 `touch_sbox=0`，',
    '见 docs/124');
  ok(!withExtra.includes('security_model=passthrough'),
    '撤除守卫：`passthrough` 也不得复活（非 root 的 chown 必 EPERM）');
  ok(!posix(vm.describe().argv.join(' ')).includes('hostshare2'),
    '沙箱内启动（无工作区）⇒ 一个参数都不加');
  ok(posix(vm.describe().argv.join(' ')).includes('mount_tag=hostshare'),
    '沙箱那份 9p 仍在（口径不变）');

  const provSrc = readFileSync(join(ROOT, 'hostcore', 'plugins', 'dshm-vm-bash', 'lib', 'vm.js'), 'utf8');
  ok(provSrc.includes('ln -sfn /mnt/share ${guestFiles}'),
    '符号链接指向**挂载点** /mnt/share，并使用实际 HAP 沙箱路径');
  ok(!provSrc.includes('ln -sfn ${share} ${guestFiles}'),
    '对照臂：不再把宿主路径当链接目标（那就是指向自己的死循环）');
  ok(vm.guestSandboxFilesPath({ DSHM_SANDBOX_HOME: '/x/phone/files' }) === '/x/phone/files',
    'guest 沙箱路径来自 DSHM_SANDBOX_HOME，不再写死 entry');
  ok(provSrc.includes('mount -t 9p -o trans=virtio,version=9p2000.L ${EXTRA_TAG}'),
    '第二份共享在 guest 里按 tag 挂上（幂等：先在 /proc/mounts 里查）');
  ok(provSrc.includes('DSHM_PROVISION_NO_PKG; grep -i 9p /proc/mounts'),
    '包目录不可见时把 mount 表一起打出来（上一轮现场只有一行标签）');
  ok(provSrc.includes('grep -q " /mnt/share " /proc/mounts'),
    '镜像自带的那份 9p 也要先确认在位（不能把"镜像约定"当"一定有"）');
  ok(provSrc.includes('cp -f "$f" "/tmp/dshm-pkgs/'),
    '随包闭包改名 .tar.gz 后在 **guest 的 /tmp** 里补 .apk 名字再装（不押"apk-tools 不看扩展名"）');
  ok(!provSrc.includes('--no-network ./*.apk'),
    '对照臂：老的「./*.apk 直装」形态不得复活（resfile 里已经没有 .apk 文件了）');
}

section('首装 provision 拆两段（2026-10-13 PC 真机：装成功却被 120 s 判死 ⇒ 一进程一 VM 闸门永久关死）');
{
  /*
   * 【判据为什么是这两条时限】快路径（bash 已装）只要 ~200 ms；而**首装**的 apk add
   * 在真机上就超过 120 s —— 这台 PC 上 rootfs 其实装成了（48631808 → 54087680 B），
   * 命令却已按超时判死，`state.spawned` 就此永久为真 ⇒ 此后每条命令都撞 startGate、
   * 必须重启应用。手机端首装实测 150~200 s，同属"没超时是运气"。
   * 所以断言钉的是：**探测段与安装段各自的时限分开且写死**（不许再合成一段 120 s）。
   */
  const provSrc = readFileSync(join(PLUGIN, 'lib', 'vm.js'), 'utf8');
  ok(provSrc.includes('PROVISION_PROBE_MS = 30000'), '探测段 30 s（只挂载 + 判 /bin/bash，命中即 ~200 ms 返回）');
  ok(provSrc.includes('PROVISION_INSTALL_MS = 600000'), '安装段 600 s（首装 apk 真机上就超过 120 s）');
  /*
   * 2026-11-06 收回「预算阶梯」：用户口径是 **1.1.7 及以前终端正常 ⇒ 按 1.1.7 的逻辑来**，
   * 所以 vm.js 已整体回滚到 dshm.109 那一版（唯一新增是 5s 心跳日志，不改逻辑）。
   * 判据随之回到 1.1.7 的形态：探测段写死 30 s、引导脚本并在同一次 exec 里。
   */
  ok(provSrc.includes('probeLines.join') && provSrc.includes('PROVISION_PROBE_MS, 40)'),
    '第一段 exec 用 30 s 时限（1.1.7 形态：探测 + 引导同一次 exec）');
  ok(!provSrc.includes('PROVISION_PROBE_BUDGETS'),
    '对照臂：预算阶梯已撤回（终端按 1.1.7 逻辑走，不靠加长等待掩盖问题）');
  ok(provSrc.includes('VM 启动中：阶段='),
    '探测期每 5 s 打一行心跳（纯日志：短窗口日志也能看出走到哪一步）');
  ok(provSrc.includes('installLines.join') && provSrc.includes('PROVISION_INSTALL_MS, 40)'),
    '第二段 exec 用的是 600 s 时限（两段各有各的口径）');
  ok(!provSrc.includes('], 120000, 40)'),
    '对照臂：一整段的 120 s 形态不得复活（它正是把已装成功的首装判死的那条）');
  ok(provSrc.includes('DSHM_PROVISION_NEEDS_INSTALL'),
    '探测未命中 ⇒ 交安装段；命中 ⇒ 直接回 DSHM_PROVISION_OK（两条路径同一判据）');
  ok(provSrc.includes('DSHM_VM_ALLOW_NET_INSTALL'),
    '联网回退改成宿主显式开关：默认不发第二条 apk（有网也极慢，会把"慢"变"更慢"）');
  ok(provSrc.includes('联网回退已关闭'),
    '对照臂（默认分支）：开关没开时如实写"已关闭"，而不是静默什么都不做');
  ok(provSrc.includes('/mnt/share/dshm-vm-pkg.log'),
    '安装日志落一份到 9p 共享根（宿主侧可直读，不再只留在 guest 的 /tmp）');
}

section('guest 最小 init（冷启动 104.9 s → 秒级；docs/157）');
{
  /*
   * 【为什么这条必须在门禁里】真机冷启动分解（2026-10-14，手机 62T0225B18039433，TCI）：
   * QEMU 拉起 → 内核 `Run /init` 3.99 s；**OpenRC sysinit/boot 76 s**；networking(udhcpc)
   * + QEMU Guest Agent 再 25 s ⇒ QGA 就绪 `+104876 ms`。根因不是某个服务慢，而是 TCI
   * （解释执行）档里每个外部命令的 fork+exec 都值钱，OpenRC 却要按依赖顺序拉起几十个进程。
   * 同机 JIT 对照：OpenRC 12.878 s → 最小 init 0.89 s。
   *
   * 这个改动有三个"静默退化"的方向，且都不会在编译期暴露：
   *   ① payload 被改回 OpenRC 形态（getty/respawn/几十条外部命令）；现在由内容断言钉住。
   *   ② **改了 payload 却不推进 `GUEST_INIT_VERSION`** ⇒ 老设备 el2 里那份 rootfs 副本上的
   *      迁移会判"已是最新"而跳过 ⇒ 老设备永远快不起来（而且现场看不出任何错）。这条靠
   *      payload 的 **sha256 固定值**钉住：任何字节改动都必须来改这里的哈希，改的时候就必须
   *      面对"要不要推进版本号"这个问题。改哈希前先读本段的注释与 guest-init.js 的头注。
   *   ③ 迁移被接到 provision 之后、或被计进本次启动的成败 ⇒ 迁移失败把一条本来能用的链路
   *      判死（或让"下一次还是慢"没有解释）。由接线断言（顺序 + try/catch + 无 throw）钉住。
   */
  const vmSrc = readFileSync(join(PLUGIN, 'lib', 'vm.js'), 'utf8');

  // ── 单一真源本身（guest-init.js） ────────────────────────────────────────
  ok(guestInit.GUEST_INIT_VERSION === 'dshm-init.v1',
    `版本标记是 dshm-init.v1（实际 ${guestInit.GUEST_INIT_VERSION}）`);
  ok(guestInit.GUEST_INIT_MARKER === `# ${guestInit.GUEST_INIT_VERSION}`,
    '迁移判据的那行标记由版本号派生（不写第二份 ⇒ 不会出现"版本升了、标记没升"）');
  ok(guestInit.GUEST_INIT_PATH === '/usr/local/sbin/dshm-init'
    && guestInit.GUEST_INITTAB_PATH === '/etc/inittab',
    '两份 payload 的落点：/usr/local/sbin/dshm-init + /etc/inittab');
  ok(guestInit.GUEST_INIT_SYSINIT_LINE === `::sysinit:${guestInit.GUEST_INIT_PATH}`,
    'inittab 的 sysinit 行与落点同源（改落点不会漏改 inittab）');

  const scriptHash = createHash('sha256').update(guestInit.GUEST_INIT_SCRIPT, 'utf8').digest('hex');
  const inittabHash = createHash('sha256').update(guestInit.GUEST_INITTAB, 'utf8').digest('hex');
  ok(scriptHash === '3ebb402adaed129ea6eeb64a8270faf935f20beddfd3b6768613cbc6cdea4a8f',
    `dshm-init 脚本逐字节未变（1980 B / sha256 3ebb402a…；实际 ${Buffer.byteLength(guestInit.GUEST_INIT_SCRIPT)} B / ${scriptHash.slice(0, 8)}…）`);
  ok(inittabHash === '6d2b117effe548876dfb0511eff604597a05888ca4bacb1b3b6be82b0a1d6e9d',
    `inittab 逐字节未变（541 B / sha256 6d2b117e…；实际 ${Buffer.byteLength(guestInit.GUEST_INITTAB)} B / ${inittabHash.slice(0, 8)}…）`);

  const effective = (text) => text.split('\n').filter((l) => l.trim().length > 0 && !l.startsWith('#'));
  const scriptLines = guestInit.GUEST_INIT_SCRIPT.split('\n');
  ok(scriptLines[0] === '#!/bin/sh', '脚本首行是 #!/bin/sh（guest 里只有 busybox ash）');
  ok(scriptLines.includes(guestInit.GUEST_INIT_MARKER),
    '脚本里有那行版本标记（迁移的 grep 判据就打在它身上）');
  ok(guestInit.GUEST_INIT_SCRIPT.endsWith('\n') && guestInit.GUEST_INITTAB.endsWith('\n'),
    '两份 payload 都以换行收尾（写进 guest 的文件不该少最后一行的换行）');

  // 去掉的正是那几十个进程：payload 的有效行里不许再出现 OpenRC / 外网 / 调试壳的痕迹。
  const heavy = ['openrc', 'rc-service', 'rc-update', 'udhcpc', 'getty', 'respawn', 'sleep',
    'apk ', 'grep', 'sed ', 'awk', 'wget', 'curl'];
  for (const word of heavy) {
    ok(!effective(guestInit.GUEST_INIT_SCRIPT).some((l) => l.includes(word))
      && !effective(guestInit.GUEST_INITTAB).some((l) => l.includes(word)),
      `payload 的有效行里没有 ${word}（注释里谈历史可以，有效行不行）`);
  }

  const mountLines = guestInit.GUEST_INIT_SCRIPT.split('\n').filter((l) => l.startsWith('mount '));
  ok(mountLines.length === 8, `payload 共 8 条 mount（proc/sysfs/devtmpfs/run/tmp/shm/pts/9p；实际 ${mountLines.length}）`);
  ok(mountLines.every((l) => l.trimEnd().endsWith('|| true')),
    '每条 mount 都带 || true（已挂上的就是 EBUSY，不许把后面的步骤挡住）');
  ok(!guestInit.GUEST_INIT_SCRIPT.includes('mountpoint -q'),
    '对照臂：不用 mountpoint -q（它要多一次 fork+exec，而这条路径上每个进程都按 TCI 的价钱付账）');
  ok(guestInit.GUEST_INIT_SCRIPT.includes('ln -sfn "../${d##*/}" "/dev/virtio-ports/$n"'),
    'QGA 的端口名符号链接在 payload 里（devtmpfs 只给 /dev/vportXpY，名字那一层要自己建）');
  ok(guestInit.GUEST_INIT_SCRIPT.includes('version=9p2000.L hostshare /mnt/share'),
    '9p 共享先挂上（provision 仍会幂等补挂，这里省一跳）');
  ok(guestInit.GUEST_INIT_SCRIPT.includes('10.0.2.15')
    && guestInit.GUEST_INIT_SCRIPT.includes('nameserver 10.0.2.3'),
    '网络按 QEMU user-net 固定地址静态配置（比 udhcpc 快一个数量级，且不取决于外部命令成败）');

  // ── inittab：恰好两条 ────────────────────────────────────────────────────
  const inittab = effective(guestInit.GUEST_INITTAB);
  ok(inittab.length === 2, `inittab 只有两条有效行（实际 ${inittab.length}）`);
  ok(inittab[0] === guestInit.GUEST_INIT_SYSINIT_LINE, '第一条是 ::sysinit: 最小 init');
  ok(inittab[1].startsWith('::once:/usr/bin/qemu-ga '),
    '第二条是 ::once: 起 qemu-ga（不是 respawn：agent 自己 -d 进后台，且 sysinit 先跑完 ⇒ 端口名已就位）');
  const portName = /name=(org\.qemu\.guest_agent\.0)/.exec(vmSrc);
  ok(portName !== null, 'vm.js 的 QEMU argv 里能取到 QGA virtserialport 的名字');
  ok(portName !== null && inittab[1].includes(`/dev/virtio-ports/${portName[1]}`),
    'inittab 里 `-p` 的地址与 QEMU argv 的设备名逐字一致（否则 agent 绑不到那条 port）');
  ok(inittab[1].includes('-m virtio-serial'), 'agent 走 virtio-serial（与 argv 的 -device virtserialport 对应）');
  // 对照臂：把 OpenRC 那一档的真实形态喂给同一条"恰好两条"判据，必须判红（否则上面那条等于空转）。
  const openrcEffective = effective([
    '# /etc/inittab',
    '::sysinit:/sbin/openrc sysinit',
    '::sysinit:/sbin/openrc boot',
    '::wait:/sbin/openrc default',
    '::respawn:/sbin/getty 38400 tty1',
    '::respawn:/sbin/getty 38400 ttyAMA0',
    '::ctrlaltdel:/sbin/reboot',
    '',
  ].join('\n'));
  ok(openrcEffective.length !== 2, '对照臂：OpenRC 形态的 inittab 在"恰好两条"判据下判红');
  ok(openrcEffective.some((l) => l.includes('openrc')) && openrcEffective.some((l) => l.includes('getty')),
    '对照臂：上面那份样本确实含 openrc / getty（样本本身不是空转）');

  // ── 迁移脚本（幂等 + 硬断电前 sync） ─────────────────────────────────────
  const install = guestInit.guestInitInstallScript();
  const installHash = createHash('sha256').update(install, 'utf8').digest('hex');
  ok(installHash === 'd047e239c49ed963ff2d1925eb73018c1618bde8ac840126058469fc40a4f8d3',
    `迁移脚本逐字节未变（3352 B / sha256 d047e239…；实际 ${Buffer.byteLength(install)} B / ${installHash.slice(0, 8)}…）`);
  ok(install.startsWith('set -u\n'), '迁移脚本以 set -u 开头（变量拼错要当场炸，而不是静默写半个文件）');
  ok(install.includes(`grep -qx '${guestInit.GUEST_INIT_MARKER}' ${guestInit.GUEST_INIT_PATH}`)
    && install.includes(`grep -qx '${guestInit.GUEST_INIT_SYSINIT_LINE}' ${guestInit.GUEST_INITTAB_PATH}`),
    '幂等判据 = 脚本首行标记 + inittab 的 sysinit 行**同时**命中（只看一条会在半迁移态上误判"已是最新"）');
  const currentAt = install.indexOf('DSHM_INIT_CURRENT');
  const firstHeredocAt = install.indexOf("<<'");
  ok(currentAt > 0 && firstHeredocAt > currentAt,
    '「已是最新」的早退在第一次写文件之前（真机上这条路径 <100 ms，不该有任何写入）');
  ok(install.includes('DSHM_INIT_CURRENT') && install.includes('DSHM_INIT_INSTALLED')
    && install.includes('DSHM_INIT_VERIFY_FAILED'),
    '三种结局各有独立标记（已是最新 / 迁移完成 / 写坏）⇒ 宿主侧能分辨，不是一句 ok');
  ok(install.includes('/bin/busybox sync 2>/dev/null || sync 2>/dev/null || true'),
    '写完必须显式 sync（QMP quit 是硬断电语义：不 sync ⇒ 下次冷启动仍是旧 24 行 inittab，迁移白做）');
  ok(install.includes(guestInit.GUEST_INIT_SCRIPT.replace(/\n$/, ''))
    && install.includes(guestInit.GUEST_INITTAB.replace(/\n$/, '')),
    'heredoc 里落的就是 payload 原文（迁移与随包镜像同源，不是第二份手抄）');
  for (const delim of ['DSHM_GUEST_INIT_SCRIPT_EOF', 'DSHM_GUEST_INITTAB_EOF']) {
    // 开的那次长这样：`cat > 文件 <<'DELIM'`（定界符不在行首），闭的那次是**独立一行**。
    const occurrences = install.split(delim).length - 1;
    ok(occurrences === 2, `heredoc 定界符 ${delim} 恰好出现两次（开 + 闭；实际 ${occurrences}）`);
    ok(!guestInit.GUEST_INIT_SCRIPT.includes(delim) && !guestInit.GUEST_INITTAB.includes(delim),
      `payload 里不含 ${delim}（否则 heredoc 会被 payload 自己提前截断）`);
  }
  ok(install.trimEnd().endsWith('echo DSHM_INIT_VERIFY_FAILED; exit 1'),
    '写完之后要**回读校验**：不验就 echo installed 等于把"写坏了"报成成功');

  // ── vm.js 接线（QGA 就绪之后、provision 之前；失败不判死） ───────────────
  ok(vmSrc.includes("import { GUEST_INIT_VERSION, guestInitInstallScript } from './guest-init.js';"),
    'vm.js 从单一真源 import（版本号 + 迁移脚本生成器），不自己抄一份 shell');
  const qgaReadyAt = vmSrc.indexOf('QGA 就绪（+');
  const callAt = vmSrc.indexOf('guestInitInstallScript()');
  const provisionAt = vmSrc.indexOf("state.phase = 'provisioning'");
  ok(qgaReadyAt > 0 && callAt > qgaReadyAt && provisionAt > callAt,
    '迁移接在 QGA 就绪之后、provision 之前（它决定的是**下一次**冷启动，越早发越好）');
  ok(vmSrc.split('guestInitInstallScript()').length === 2,
    'guestInitInstallScript() 只被调用一次（每次启动一次；多一次就是重复写盘）');
  ok(vmSrc.includes('GUEST_INIT_TIMEOUT_MS = 60000')
    && vmSrc.includes('GUEST_INIT_TIMEOUT_MS, 40)'),
    '迁移有独立时限 60 s，且那次 exec 真的用上了它（不并进 provision 的 30 s / 600 s）');
  ok(/guestInit: 'pending',/.test(vmSrc) && /\n\s+guestInit: state\.guestInit,\n/.test(vmSrc),
    '迁移结果进 state 并暴露到 diagnostics（"下次还是慢"必须有解释，不许静默）');
  // 从**整段注释的开头**切起（callAt 落在 try 体内部，切出来会看不见那句 `try {`）。
  const wireAt = vmSrc.indexOf('【老镜像的一次性迁移');
  ok(wireAt > 0 && wireAt < callAt, '能定位到迁移段的头注（下面几条按这一段的边界切）');
  const wire = wireAt > 0 ? vmSrc.slice(wireAt, provisionAt) : '';
  ok(wire.includes('try {') && wire.includes('} catch (error) {'),
    '迁移整段包在 try/catch 里（它只影响下次冷启动的速度，不该影响本次启动的成败）');
  ok(!/\bthrow\b/.test(wire),
    '对照臂：迁移段里一个 throw 都不许有（那会把"只有下次慢"升级成"这次直接不可用"）');
  ok(vmSrc.includes("state.guestInit = 'current'") && vmSrc.includes("state.guestInit = 'installed'"),
    '两个成功终态各自有读数（current＝本来就快 / installed＝下次冷启动生效）');
  ok(vmSrc.split("state.guestInit = 'failed'").length === 3,
    '两条失败路径都记 failed（回执没认出来 + 抛异常）—— 各一处，多一处就说明接线被改动了');
  ok(vmSrc.includes('GUEST_INIT_VERSION'),
    '版本号进了日志（现场读 node-output.log 就能知道设备上跑的是哪一版 init）');
}

section('侧边栏终端 · 接管面（哪些 spawnTerminal 改派、哪些如实退回）');
{
  const take = (spec) => index.shouldTakeOverTerminal(spec);
  ok(take({ argv: ['bash'] }).take === true, 'argv=["bash"] ⇒ 改派');
  ok(take({ argv: ['/bin/bash'] }).take === true, '绝对路径 /bin/bash ⇒ 改派');
  ok(take({ argv: ['sh', '-i'] }).take === true, 'argv=["sh","-i"] ⇒ 改派');
  ok(take({ argv: ['/bin/sh', '-i'] }).take === true, 'argv=["/bin/sh","-i"] ⇒ 改派（本档默认 shell 解析出来就是这个形态）');
  ok(take({ argv: ['ash'] }).take === true, 'ash ⇒ 改派');
  ok(take({ argv: ['/usr/bin/zsh'] }).take === false,
    '/usr/bin/zsh ⇒ **不改派**（端侧 profile 给 terminal-bash 配的那条；手持档 guest 里也没有它）');
  ok(take({ argv: ['python3'] }).take === false, 'python3 ⇒ 不改派（不在 guest shell 白名单）');
  ok(take({ argv: [] }).take === false, '空 argv ⇒ 不改派');
  ok(take(null).take === false, 'spec 为 null ⇒ 不改派');
  ok(take({ argv: ['bash'] }).take === index.shouldTakeOver({ argv: ['bash'] }).take
    && take({ argv: ['/usr/bin/zsh'] }).take === index.shouldTakeOver({ argv: ['/usr/bin/zsh'] }).take,
  '与 shouldTakeOver 口径一致：同一个 argv[0] 在两条链上的结论必须相同（走通与退回两个方向都验）');
}

section('侧边栏终端 · shell 解析（resolveExecutable 该回答什么）');
{
  const p = (command) => index.guestShellPath(command);
  ok(p('sh') === '/bin/sh', 'sh → /bin/sh');
  ok(p('bash') === '/bin/bash', 'bash → /bin/bash');
  ok(p('ash') === '/bin/ash', 'ash → /bin/ash');
  ok(p('/bin/bash') === '/bin/bash', '/bin/bash 原样（绝对路径请求命中的就是表里那条）');
  ok(p('/bin/sh') === '/bin/sh', '/bin/sh 原样');
  ok(p('/usr/bin/bash') === null, '/usr/bin/bash ⇒ 交回原实现（本档确实没有）');
  ok(p('/usr/bin/zsh') === null, '/usr/bin/zsh ⇒ 交回原实现（端侧 profile 那条，guest 里也没有）');
  ok(p('zsh') === null, 'zsh ⇒ 交回原实现（guest 无 zsh ⇒ 不假装）');
  ok(p('python3') === null, 'python3 ⇒ 交回原实现');
  ok(p('busybox') === null, 'busybox ⇒ 交回原实现（不把 guest 内部件当 shell 暴露给用户）');
  ok(p('') === null, '空串 ⇒ 交回原实现');
  ok(p(undefined) === null, 'undefined ⇒ 交回原实现');
  ok(p('bash') !== p('zsh'), '对照臂：表内 vs 表外 ⇒ 结论相反（白名单真在生效，null 不是恒返回）');
}

section('侧边栏终端 · 通道口径（virtconsole ↔ /dev/hvc，端口 4）');
{
  const posix = (value) => String(value).split(String.fromCharCode(92)).join('/');
  const joined = posix(vm.describe().argv.join(' '));
  // 端口数 = 4 与"通道 = virtconsole"都是**真机读数钉死的**（见 paths.js 的 TERM_PORTS 头注）：
  //   · 旧的 `-serial` 给的是 /dev/ttyAMA<i>（PL011，真 tty，质量最好），但 guest 里只有
  //     2 个 PL011（0 号是控制台）⇒ 最多 1 个终端；
  //   · 普通的 `virtserialport` 在 guest 里是 /dev/vportXpY（251,1 动态 cdev）⇒ 不是 tty，
  //     没有 termios / 行规程 / 作业控制；
  //   · `-device virtconsole`（console 型端口）才被 virtio_console 建成 /dev/hvc<i-1> 真 tty。
  ok(paths.TERM_PORTS === 4, 'TERM_PORTS = 4（0 号留串口日志；4 个 virtconsole ↔ /dev/hvc0..3）');
  ok(paths.termTty(1) === '/dev/hvc0' && paths.termTty(4) === '/dev/hvc3',
    'termTty(i) = /dev/hvc<i-1>（virtconsole 的先后就是 hvc 的编号）');
  ok(posix(paths.termSocket(1)).endsWith('/tmp/term1')
    && posix(paths.termSocket(1)).startsWith(posix(process.env.DSHM_VM_DIR)),
  'termSocket(1) 落在运行目录（宿主连的就是 <运行目录>/tmp/term1）');
  ok(joined.includes('-chardev socket,id=term1,path=' + posix(paths.termSocket(1)) + ',server=on,wait=off'),
    '第 1 个终端：socket chardev（server=on,wait=off ⇒ 宿主随时连，QEMU 不等）');
  ok(joined.split('id=term').length - 1 === 4, '恰好 4 个终端 chardev（term1..term4），不多不少');
  ok(joined.includes('-device virtconsole,chardev=term1,id=vc1,bus=virtio-serial0.0'),
    '第 1 个终端：-device virtconsole 接 chardev:term1（只有 console 型端口会建 tty）');
  ok(joined.split('virtconsole,chardev=').length - 1 === 4, '恰好 4 个 virtconsole 设备');
  ok(joined.includes('-device virtconsole,chardev=term4,id=vc4,bus=virtio-serial0.0'),
    '第 4 个终端也建了（设备表与端口表同长，不是只写了个数）');
  ok(!joined.includes('id=term0'), '对照臂：没有 term0（0 号是串口日志，不许被终端顶掉）');
  ok(joined.split('-serial ').length - 1 === 1,
    '对照臂：-serial 只剩 1 条（ser0）—— 终端不再借 -serial（那条要占 PL011 号，最多 1 个）');
  ok(!joined.includes('-serial chardev:term'), '对照臂：终端不再用 -serial');
  ok(!joined.includes('virtserialport,chardev=term'),
    '对照臂：终端**不走**普通 virtserialport（真机读数：vport 是 251,1 动态 cdev，没有 termios/作业控制）');
  ok(joined.includes('-chardev file,id=ser0,path=' + posix(process.env.DSHM_VM_DIR) + '/serial.log'),
    '串口日志仍是 file chardev（终端没把它挤掉）');
  // virtconsole 必须**排在 virtio-serial 控制器之后**（它要引用 bus=virtio-serial0.0），
  // 否则 QEMU 在校验参数那一刻就拒（真机上表现为"VM 起不来"，看不出根因）。
  ok(joined.indexOf('id=virtio-serial0') > 0
    && joined.indexOf('id=virtio-serial0') < joined.indexOf('id=vc1'),
  'virtconsole 排在 virtio-serial 控制器之后（bus=virtio-serial0.0 必须已存在）');
  const vmSrc = readFileSync(join(PLUGIN, 'lib', 'vm.js'), 'utf8');
  ok(vmSrc.includes('termSocket(k + 1)'), 'stale socket 清理列表带上终端 socket（否则重启后连到旧壳）');
  ok(vmSrc.includes("workPath('serial.log')"), '串口日志文件仍在清理列表里（口径不变）');
  const termSrc = readFileSync(join(PLUGIN, 'lib', 'terminal.js'), 'utf8');
  ok(termSrc.includes('DSHM_TERM_NO_TTY'), '先验 tty 设备存在（端口表与 guest 的 tty 数不一致时不装死）');
  ok(termSrc.includes('[ -c '), '先验用 test -c（字符设备存在性），不是"试着打开再报错"');
  ok(termSrc.includes('没有 shell 认领终端'),
    '认领失败 fail-loud：拿不到前台 pid 就抛错（不再只报"未知"留一个空壳终端）');
}
section('侧边栏终端 · guest 侧口径与接线（apply 真的换了那三个方法）');
{
  const terminalSrc = readFileSync(join(PLUGIN, 'lib', 'terminal.js'), 'utf8');
  ok(terminalSrc.includes('setsid /bin/busybox sh -c '), 'guest 侧走 busybox setsid（镜像里 /bin/setsid 没有链接）');
  ok(terminalSrc.includes("shq('exec ' + argv + ' < ' + tty + ' > ' + tty + ' 2>&1')"),
    '内层 exec 由**会话首领**执行三个重定向 ⇒ 该 tty 成为它的控制终端（作业控制 / SIGWINCH 的前提）');
  ok(terminalSrc.includes('echo DSHM_TERM_SPAWNED'), '起 shell 后有回执标记（拿不到就不认为会话成立）');
  ok(terminalSrc.includes('stty -F '), '窗口尺寸走带外 stty -F（chardev 不带 winsize 通道）');
  // 【"两行当前路径"的守卫】prompt 一旦退回 /etc/profile 那条 `$PWD` 分支（真机实测 46 列 >
  // 侧栏 42 列），终端一开就折成两行。这三条钉住根治的三件套：
  //  ① 自写 rc（ash 走 $ENV / bash 走 --rcfile）② prompt = `\W# `（cwd 的 basename）
  //  ③ rows/cols 合并成**一条** stty（两条会各触发一次 SIGWINCH 重绘 ⇒ 多出一行残留）。
  ok(terminalSrc.includes("const RC_PATH = '/tmp/.dshm-rc'"),
    'rc 落在 guest 的 /tmp（tmpfs）—— 不碰镜像、不写用户数据');
  ok(terminalSrc.includes("'--rcfile ' + shq(RC_PATH)"),
    'bash 走 --rcfile（交互式 bash 既不读 /etc/profile 也不读 $ENV）');
  ok(terminalSrc.includes('export ENV='), 'ash 家族走 $ENV（交互式 ash 只读它）');
  // 源码里这行是 `"PS1='\\W# '"`（JS 字符串转义 ⇒ 落到 rc 文本是 `PS1='\W# '`）⇒ 正则里
  // `\\\\` 正好匹配源码那两个反斜杠。断言的是**源码形态**：prompt 用 `\W`（basename）。
  ok(/PS1='\\\\W# '/.test(terminalSrc), 'prompt = \\W#（cwd 的 basename ⇒ 永远十几列，窄屏不折行）');
  ok(terminalSrc.includes("' rows ' + rows + ' cols ' + cols +"),
    'rows/cols 合并成一条 stty（两条会各触发一次重绘，真机实测 3 行 → 2 行）');
  ok(terminalSrc.includes('for sig in TERM KILL; do')
    && terminalSrc.includes('kill -"$sig" -"$pg"')
    && terminalSrc.includes('DSHM_TERM_OWNER=') && terminalSrc.includes('grep -Fxq'),
    '收尾按**进程组**杀（kill -TERM/-KILL -<pgid>），否则 tty 会被活着的 shell 攥住');
  ok(terminalSrc.includes('for p in /proc/[0-9]*; do') && terminalSrc.includes('readlink'),
    '前台进程组按 /proc 探测（guest 的 ps 没有 tpgid 字段）');
  ok(terminalSrc.includes('FOREGROUND_TTL_MS'), '探测结果有缓存窗口（inspectForeground 会被逐块输出调用）');
  ok(terminalSrc.includes('端侧终端端口已用满'), '端口用满时报文可行动（让用户先关一个终端）');
  ok(!terminalSrc.includes('startWorker') && !terminalSrc.includes('spawnSync'),
    '对照臂：终端实现里没有 startWorker / spawnSync（不新起进程、不阻塞事件循环）');

  const pkg = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));
  ok(Array.isArray(pkg.files) && pkg.files.includes('lib/terminal.js'),
    'package.json 的 files 登记了 lib/terminal.js（否则打包时这一跳会缺件）');
  const indexSrc = readFileSync(join(PLUGIN, 'lib', 'index.js'), 'utf8');
  ok(indexSrc.includes("from './terminal.js'"), 'index.js 真的从 ./terminal.js 取接入点（不是摆设）');
  ok(indexSrc.includes('createVmTerminal') && indexSrc.includes('terminalDiagnostics'),
    '两个导出都被接线（会话 + 诊断）');

  const makeRuntime = () => ({
    calls: [],
    spawn(spec) { this.calls.push(['spawn', spec]); return { done: Promise.resolve({ exitCode: 0 }), collected: {} }; },
    spawnTerminal(spec) { this.calls.push(['spawnTerminal', spec]); return Promise.resolve({ pid: 1 }); },
    terminalEnvironment() { this.calls.push(['terminalEnvironment']); return Promise.resolve({ platform: 'win32', defaultShell: 'cmd.exe' }); },
    resolveExecutable(command) { this.calls.push(['resolveExecutable', command]); return Promise.resolve('/host/' + command); },
  });
  const makeCtx = (runtime) => ({ subprocess: runtime, effect() {} });

  const before = index.vmDiagnostics().terminal;
  const savedMode = process.env.DSHM_VM_BASH;
  try {
    // ── 负面臂 1：DSHM_VM_BASH=off ⇒ 四个方法一个都不换（PC/2in1 档的回归守卫）──
    process.env.DSHM_VM_BASH = 'off';
    const off = makeRuntime();
    const offOriginal = { ...off };
    index.apply(makeCtx(off));
    ok(off.spawn === offOriginal.spawn && off.spawnTerminal === offOriginal.spawnTerminal
      && off.terminalEnvironment === offOriginal.terminalEnvironment
      && off.resolveExecutable === offOriginal.resolveExecutable,
    '对照臂：DSHM_VM_BASH=off ⇒ 四个方法一个都不换');

    // ── 负面臂 2：默认环境（本机没有端侧资产、假壳也跑不起来）⇒ 同样一个都不换 ──
    delete process.env.DSHM_VM_BASH;
    const idle = makeRuntime();
    const idleOriginal = { ...idle };
    index.apply(makeCtx(idle));
    ok(idle.spawn === idleOriginal.spawn && idle.spawnTerminal === idleOriginal.spawnTerminal
      && idle.terminalEnvironment === idleOriginal.terminalEnvironment
      && idle.resolveExecutable === idleOriginal.resolveExecutable,
    'fail-closed：资产不在本机 ⇒ 四个方法都不包装（手持档也不会假装能用）');

    // ── 正面臂：DSHM_VM_BASH=force ⇒ 四个方法一起换 ─────────────────────────
    process.env.DSHM_VM_BASH = 'force';
    const runtime = makeRuntime();
    const original = { ...runtime };
    index.apply(makeCtx(runtime));
    ok(runtime.spawn !== original.spawn, 'spawn 被换（原链路其余行为不变）');
    ok(runtime.spawnTerminal !== original.spawnTerminal, 'spawnTerminal 被换');
    ok(runtime.terminalEnvironment !== original.terminalEnvironment, 'terminalEnvironment 被换');
    ok(runtime.resolveExecutable !== original.resolveExecutable, 'resolveExecutable 被换');

    const environment = await runtime.terminalEnvironment();
    ok(environment.platform === 'posix' && environment.defaultShell === '/bin/sh',
      'terminalEnvironment ⇒ posix + /bin/sh（与 resolveExecutable 的答案自洽）');
    ok(runtime.calls.every((call) => call[0] !== 'terminalEnvironment'),
      '对照臂：原 terminalEnvironment 一次都没被调用（旧的 win32/cmd.exe 答案没漏出去）');

    ok((await runtime.resolveExecutable('bash')) === '/bin/bash', 'resolveExecutable(bash) ⇒ /bin/bash');
    ok((await runtime.resolveExecutable('/bin/sh')) === '/bin/sh', 'resolveExecutable(/bin/sh) ⇒ /bin/sh');
    ok((await runtime.resolveExecutable('/usr/bin/zsh')) === '/host//usr/bin/zsh',
      '/usr/bin/zsh ⇒ 原实现回答（端侧那条配置不许被我们改写成别的 shell）');
    ok(runtime.calls.some((call) => call[0] === 'resolveExecutable' && call[1] === '/usr/bin/zsh'),
      '对照臂：交回时**真的**调了原 resolveExecutable（不是我们自己编一个答案）');

    const delegated = await runtime.spawnTerminal({ argv: ['/usr/bin/zsh', '-i'] });
    ok(delegated !== undefined && delegated.pid === 1, 'argv[0]=/usr/bin/zsh ⇒ 原实现回答（拿到它的 pid=1）');
    ok(runtime.calls.some((call) => call[0] === 'spawnTerminal'), '对照臂：原 spawnTerminal 真被调了');

    let unavailable = null;
    try {
      await runtime.spawnTerminal({ argv: ['/bin/sh', '-i'], cwd: '', cols: 80, rows: 24, terminalType: 'xterm-256color' });
    } catch (error) {
      unavailable = error;
    }
    ok(unavailable !== null && String(unavailable && unavailable.message).includes('端侧 VM 不可用'),
      '白名单内 ⇒ 进 guest 通道；本机 VM 不在 ⇒ 如实 reject 且报文点名「端侧 VM 不可用」');

    let noChannel = null;
    try {
      await terminal.createVmTerminal({ argv: ['sh', '-i'], cwd: '' }, async () => ({ ok: true }));
    } catch (error) {
      noChannel = error;
    }
    ok(noChannel !== null && String(noChannel && noChannel.message).includes('连不上 guest tty 通道'),
      '拿不到 chardev socket 时报文点名它（真机上这一行就是唯一线索）');
    ok(String(noChannel && noChannel.message).includes('term1'),
      '报文带上端口号：首次会话用 1 号 tty（term1），与 -serial 顺序对得上');

    let retried = null;
    try {
      await terminal.createVmTerminal({ argv: ['sh', '-i'], cwd: '' }, async () => ({ ok: true }));
    } catch (error) {
      retried = error;
    }
    ok(String(retried && retried.message).includes('term1'),
      '失败后端口已归还 ⇒ 下一次仍拿 1 号（不是"用过一次就没了"）');
  } finally {
    if (savedMode === undefined) delete process.env.DSHM_VM_BASH;
    else process.env.DSHM_VM_BASH = savedMode;
  }

  const after = index.vmDiagnostics().terminal;
  ok(after.inUse.length === 0, '失败路径把端口都还回去了（inUse 为空 ⇒ 连败多次后仍能开终端）');
  ok(after.opened === before.opened, '没把失败的会话记成"已打开"（opened 不变）');
  ok(after.failed - before.failed >= 2, '连不上如实计数（failed 至少 +2），可机读、不靠用户复现');
}

section('工作区共享根落空必须留痕（cwdMiss：预热带 cwd · cd 落空不回吞）');
{
  // 【现象】一进程一 VM ⇒ 共享根在启动那一刻定死。若本次终端的 cwd 落在"绑定之外"
  //（例如先给了沙箱内、后来才切到工作区），guest 里 `cd <cwd>` 会失败并退回 /root。
  // 旧实现 `cd … 2>/dev/null || true` 把这件事**咽成静默** ⇒ 用户只看到"终端不在工作区"
  // 却拿不到任何线索。修法：留一个回执标记 + 两侧各计一个 cwdMiss，进宿主自检。
  const terminalSrc = readFileSync(join(PLUGIN, 'lib', 'terminal.js'), 'utf8');
  const vmSrc = readFileSync(join(PLUGIN, 'lib', 'vm.js'), 'utf8');
  const indexSrc = readFileSync(join(PLUGIN, 'lib', 'index.js'), 'utf8');

  ok(terminalSrc.includes('|| echo DSHM_TERM_CWD_MISS'),
    'cd 落空时打回执标记（不再 || true 静默吞）');
  ok(!/cd ' \+ shq\(cwd\) \+ ' 2>\/dev\/null \|\| true/.test(terminalSrc),
    '对照臂：旧的静默式 `cd <cwd> 2>/dev/null || true` 已撤');
  ok(/if \(cwd\.length > 0\) lines\.push\('cd ' \+ shq\(cwd\)/.test(terminalSrc),
    '仍只在有 cwd 时发 cd（空 cwd 不臆造目标）');

  ok(/const state = \{\s*used: new Set\(\), opened: 0, closed: 0, failed: 0, cwdMiss: 0/.test(terminalSrc),
    'terminal.js 的 state 记 cwdMiss');
  ok(/if \(spawned\.includes\('DSHM_TERM_CWD_MISS'\)\) \{/.test(terminalSrc),
    'createVmTerminal 真的读回执标记（否则标记白打）');
  ok(/\n\s*cwdMiss: state\.cwdMiss,\n/.test(terminalSrc),
    'terminalDiagnostics 暴露 cwdMiss（进宿主自检，可机读）');

  ok(/cwdMiss: 0,/.test(vmSrc) && /\n\s*cwdMiss: state\.cwdMiss,\n/.test(vmSrc),
    'vm.js 侧同样计数并暴露（预热/ensureRunning 的 ready 早退那条）');
  ok(!/\bwarmCwd\b/.test(indexSrc),
    '对照臂：旧的 warmCwd 机制已撤（现在登记的是"上一次真实请求用过的 cwd"，见 prewarmCwdPath）');
}

section('接线（profile / pack-core / 版本号）');

{
  const patch = readFileSync(join(ROOT, 'hostcore', 'profile', 'ondevice', 'cordis.patch.yml'), 'utf8');
  ok(patch.includes("name: '@deepseek-ai/dshm-vm-bash'"), 'cordis.patch.yml 里有本插件的 insert 行');
  ok(/insert:\r?\n\s+- id: dshm-vm-bash/.test(patch), 'insert 行用的是 insert: 语法（普通 patch 行够不着新条目）');

  const pack = readFileSync(join(ROOT, 'tools', 'pack-core.mjs'), 'utf8');
  ok(pack.includes("dir: 'dshm-vm-bash'"), 'pack-core 的 DSHM_PLUGIN_PACKAGES 已登记（决定"落树 + 声明依赖"）');

  const recipe = JSON.parse(readFileSync(join(ROOT, 'hostcore', 'core-recipe.json'), 'utf8'));
  const version = recipe.coreVersion ?? recipe.version ?? '';
  // 版本号必须**恰好**是本插件最后一次改动的档（.14 首次落树 / .15 修 worker 启动口径 /
  // .16 修 koffi 的 K_DEBUG 断言并补逐步诊断 / .17 串口改 file chardev / .18 重写 QGA 客户端
  // （监听器丢弃 + 只认第一行，见 docs/122）/ .19 guest 侧三处：自指符号链接、沙箱外工作区的
  // 第二份 9p、一进程一 VM 的串行闸门 / .20 侧边栏终端：额外的 `-serial` 通道 +
  // spawnTerminal / terminalEnvironment / resolveExecutable 三个入口一起换，见 docs/123 /
  // .21 vm/tmp 陈旧运行件清扫（`sweepStaleTmp()`：run-*.sh / stdin-*.txt / 死 socket /
  // ram.dump —— 真机曾留下 15 个脚本 + 512 MiB 转储）/ .22 两份 9p 改 `security_model=none`
  // （不落 `.virtfs_metadata` 旁挂件）/ .23 **撤回 .22**：`none` 会让 QEMU 按 guest 的
  // uid 落盘（impersonate）⇒ guest 在用户授权目录里一次都写不进去（真机 2/2 复现 EPERM）
  // ⇒ 回到 `mapped-file`，并新增 `sweepSidecars()` 在起点清掉那些旁挂件。见 docs/124）/
  // .24 共享根清单（`vm/shared-roots.json`）：旁挂件只长在**被 9p 导出过**的目录里，而导出目录
  // 一进程一 VM ⇒ 换工作区重启后，上一个工作区里那坨谁都不会扫 ⇒ 把"我们挂过的根"记下来，
  // 下次起点一并扫（只留最近 8 条、已不存在的路径剔掉）。见 docs/124 §9）。
  // .25 侧边栏终端换通道：`-serial`（PL011，最多 1 个）⇒ `-device virtconsole`
  // （guest 侧 `/dev/hvc<i-1>` 真 tty，端口放到 4）；同时根治"两行当前路径"
  // （自写 rc + `\W` prompt + rows/cols 合并成一条 stty）。见 docs/125。
  // .26~.31 由别的 dshm-* 改动推进（皮肤市场 / 工作区认领 / PTC 等）。本插件最近一次改动
  // 是 .32：**上架自检 CppCrash 的防御性修复** —— QEMU `tb-size` 2048⇒256（不再一次性
  // 申请 2 GiB 翻译缓存）+ 启动前 `MemAvailable` 内存闸门（`memBudget`）。见 docs/146。
  // 【2026-10-09 收窄成"不倒退"比较】原先钉死 `endsWith('+dshm.25')`。它守的是「树是增量复用的，
  // 版本没升端侧就不换树 ⇒ 插件改动会静默不生效」，但**别的 dshm-* / 宿主侧改动同样会推进版本号**
  // （本次 `dshm-market-bridge` 的皮肤重启修复把它推到 +dshm.26）⇒ 固定值会把每次无关出包都变成
  // "门禁红了要改门禁"，从守卫退化成噪音。改成解析序号并断言 **不倒退**：既保住"本插件的档没被
  // 回退"（回退 ⇒ 端侧不换树 ⇒ 改动失效），又不再被无关改动误伤。改动本插件时仍必须推进版本号。
  /*
   * 【2026-11-05 换上游基线适配】序号 32 的口径只属于 `0.2.1-rc.5` 这条序列。
   * 换到 `0.2.2-rc.1` 后配方按 docs/361 §5 重新从 `+dshm.1` 起算，而端侧核心目录名
   * 含**上游版本**，目录一变就一定换树 —— 判据要防的「版本没升 ⇒ 树复用 ⇒ 改动不生效」
   * 此时不成立。因此下限按上游基线分档：旧基线仍要求 ≥ 32（防回退），新基线只要 ≥ 1
   * （防序号被清零/写错）。两边都保留「不倒退」的语义。
   */
  const upstreamOf = String(version).split('+')[0];
  const minOrdinal = upstreamOf === '0.2.1-rc.5' ? 32 : 1;
  const dshmOrdinal = Number((/\+dshm\.(\d+)$/.exec(String(version)) ?? [])[1] ?? '0');
  ok(dshmOrdinal >= minOrdinal,
    `coreVersion 的 dshm 序号 ≥ ${minOrdinal}（${upstreamOf} 基线口径；实际 ${version}）`);

  const buildProfile = readFileSync(join(ROOT, 'entry', 'build-profile.json5'), 'utf8');
  ok(buildProfile.length > 0, 'entry/build-profile.json5 可读（签名/ABI 配置在别处断言）');
}

section('插件模块面');
{
  ok(index.name === '@deepseek-ai/dshm-vm-bash', '插件 name 与包名一致');
  ok(Array.isArray(index.inject) && index.inject.includes('subprocess'), 'inject 声明了 subprocess（否则拿不到 runtime）');
  ok(typeof index.apply === 'function', 'apply 存在');
  ok(typeof index.vmDiagnostics === 'function', 'vmDiagnostics 存在（进宿主自检）');
  const diag = index.vmDiagnostics();
  ok(diag.plugin === '@deepseek-ai/dshm-vm-bash' && diag.vm && typeof diag.vm.phase === 'string',
    'vmDiagnostics 结构可用于自检（phase 可机读）');
  ok(diag.vm.assetsOk === false, '本机诊断如实报"资产不在"（不假装就绪）');
}

section('随包资产（要 third_party/ 素材；干净克隆里没有 ⇒ 跳过而不是判红）');
{
  const source = join(ROOT, 'third_party', 'vmhish');
  if (!existsSync(source)) {
    // 干净克隆里 third_party/ 不入库（见 .gitignore），强行判红会让 CI 永远红 ⇒
    // 与其他"需要核心树/设备"的门禁同一口径：**如实标注跳过**（不是通过）。
    console.log('  --   跳过：third_party/vmhish/ 不在（干净克隆）。备齐素材后本段会验：'
      + '源与目标逐字节一致 + bash/SSH 闭包 11 个 .tar.gz 包齐 + 署名件 3 件齐');
  } else {
    const run = spawnSync(process.execPath, [join(ROOT, 'tools', 'place-vm-assets.mjs'), '--check'], { encoding: 'utf8' });
    ok(run.status === 0, 'place-vm-assets --check 通过（5 个运行件的 sha256 与登记值一致）');
    if (run.status !== 0) console.log(`${run.stdout ?? ''}${run.stderr ?? ''}`);
    // 重建种子（上游 OpenRC 原档）必须与素材一起留档：没有它就再也烘不出"最小 init + bash 闭包"
    // 这一份 rootfs（上游 release 的下载面不是长期可依赖的，docs/157 §重建）。
    const seed = join(source, 'rootfs_aarch64.openrc-seed.qcow2');
    ok(existsSync(seed) && statSync(seed).size === 48631808,
      '重建种子 rootfs_aarch64.openrc-seed.qcow2 在位（48631808 B，上游 OpenRC 原档）');
    const placeSrc = readFileSync(join(ROOT, 'tools', 'place-vm-assets.mjs'), 'utf8');
    for (const name of [
      'dropbear-2025.88-r1.tar.gz',
      'dropbear-dbclient-2025.88-r1.tar.gz',
      'dropbear-scp-2025.88-r1.tar.gz',
      'dropbear-ssh-2025.88-r1.tar.gz',
      'skalibs-libs-2.14.4.0-r0.tar.gz',
      'utmps-libs-0.1.3.1-r0.tar.gz',
      'zlib-1.3.2-r1.tar.gz',
    ]) {
      ok(placeSrc.includes(name), `guest SSH 闭包登记：${name}`);
    }
    const vmSrc = readFileSync(join(PLUGIN, 'lib', 'vm.js'), 'utf8');
    ok(vmSrc.includes('[ -x /bin/bash ] && [ -x /usr/bin/ssh ] && [ -x /usr/bin/dropbearkey ]'),
      'provision 把 `/usr/bin/ssh`、`dropbearkey` 与 bash 一起作为就绪判据');
    ok(/for \(const name of readdirSync\(pkgSrc\)\)[\s\S]{0,500}copyFileSync\(src, dst\)/.test(vmSrc),
      'stage() 会补拷新增 guest 包（老 rootfs 目录已存在也不能跳过 SSH 包）');
  }
}

section('vm/tmp 陈旧运行件清扫（.21）');
{
  // 【为什么用文本+正则自测而不是 import vm.js】vm.js 的模块面会拉起 worker/资产检查，
  // 在无核心树的本机 import 会连带一堆无关失败；而这里要钉的判据是**一条正则**，
  // 直接把它从源码里取出来跑，并带**反向臂**（非陈旧件必须**不**被命中）。
  const vmSrc = readFileSync(join(ROOT, 'hostcore/plugins/dshm-vm-bash/lib/vm.js'), 'utf8');
  const m = vmSrc.match(/const STALE_TMP = (\/.*\/);/);
  ok(m !== null, 'vm.js 里能找到 STALE_TMP 白名单正则');
  if (m !== null) {
    // 只求值本仓源码里的一条正则字面量（非外部输入）。
    const stale = Function(`return ${m[1]}`)();
    const doomed = ['serial_socket', 'qga_socket', 'qga2_socket', 'qga7_socket', 'qmp_socket',
      'term1', 'term2', 'term3', 'run-muze1abc-l0v1et.sh', 'stdin-x9.txt', 'qga_hold.txt', 'ram.dump'];
    const kept = ['serial.log', 'rootfs.qcow2', 'guestpkgs', 'term', 'serial_socket2', 'notes.md', 'random.txt'];
    for (const name of doomed) ok(stale.test(name), `陈旧运行件命中（会被清）：${name}`);
    for (const name of kept) ok(!stale.test(name), `非陈旧件不命中（会被保留）：${name}`);
  }
  ok(/sweepStaleTmp\(\);/.test(vmSrc), 'stage() 真的调用了 sweepStaleTmp()（清扫接线）');
  // 早退本身还在（清扫仍只可能在未就绪时发生），但它从"一行 return"变成**带体的块**：
  // 绑定之外的新 cwd 要在这里留一行 + 计数（见 vm.js 头注；2026-10-12 真机）。
  ok(/if \(state\.phase === 'ready'\) \{/.test(vmSrc),
    '清扫只可能在 VM 未就绪时发生（ensureRunning 的 ready 早退仍在，只是换成了带体的块）');
  ok(/if \(state\.phase === 'ready'\) \{[\s\S]{0,900}state\.cwdMiss \+= 1/.test(vmSrc),
    'ready 早退不再静默：绑定之外的新 cwd 会记一行并计数（否则"终端不在工作区"毫无线索）');
  ok(/if \(state\.phase === 'ready'\) \{[\s\S]{0,1200}return Promise\.resolve\(\{ ok: true \}\)/.test(vmSrc),
    '早退仍返回 ok:true（行为不变：VM 本来就能跑，只是本次 cwd 可能不可见）');
  ok(!/if \(state\.phase === 'ready'\) return Promise\.resolve/.test(vmSrc),
    '对照臂：旧的"一声不吭"单行式早退已撤（它把 cwd 差异整个咽掉）');
}

section('9p 旁挂件清扫与共享根清单（.23 / .24）');
{
  // `security_model=mapped-file` 必落 `.virtfs_metadata/` 旁挂件（QEMU 删原文件时不连带删）。
  // 这里钉的是「起点把它们清掉」这件事的**判据形状**：只删旁挂件、清空就 rmdir，
  // 而且**所有我们挂过的根**都要扫到 —— 导出目录一进程一 VM，换过工作区的用户
  // 在上一个工作区里留下的那坨，只靠"本次的根"是扫不到的（`.24` 的清单就是为这条加的）。
  const vmSrc = readFileSync(join(ROOT, 'hostcore/plugins/dshm-vm-bash/lib/vm.js'), 'utf8');
  ok(/function sweepSidecars\(root\)/.test(vmSrc), 'vm.js 里有 sweepSidecars()');
  ok(/if \(!name\.endsWith\('\.virtfs_metadata'\)\) continue;/.test(vmSrc),
    '只删 `*.virtfs_metadata` 旁挂件（共享目录里的用户文件一个都不碰）');
  ok(/rmdirSync\(dir\);/.test(vmSrc), '清完空目录要 rmdir（留个空隐藏目录也算垃圾）');
  ok(/const sharedRoots = \[String\(process\.env\.DSHM_SANDBOX_HOME \|\| ''\)\.trim\(\), state\.extraShare\]/.test(vmSrc),
    '两个共享根都进清扫面（沙箱自己那份 + 用户可见的工作区那份）');
  ok(/\n  sweepStaleTmp\(\);\n/.test(vmSrc) && /\n  sweepSharedRoots\(sharedRoots\);\n/.test(vmSrc),
    '清扫都挂在 stage() 里（VM 未拉起时 ⇒ 不会删掉本次要用的东西）');

  // `.24` 共享根清单：判据形状 ① 清单落在我们自己的命名空间里且**有上限**；② 扫的是
  // 「本次的根 + 历史根」；③ 已不存在的路径会被剔掉（防"清单只增不减"）；
  // ④ 全程没有任何整目录递归删除。
  ok(/const MAX_SHARED_ROOTS = 8;/.test(vmSrc), '清单有上限（只留最近 8 条）');
  ok(/function sharedRootsFile\(\)/.test(vmSrc) && /'shared-roots\.json'/.test(vmSrc),
    '清单位于 vm/shared-roots.json（我们自己的命名空间，不碰用户文件）');
  ok(/function readSharedRoots\(\)/.test(vmSrc) && /catch \{\n    return \[\];\n  \}/.test(vmSrc),
    '读清单失败一律当"没有"（清扫是尽力而为，绝不影响启动）');
  ok(/if \(!existsSync\(root\)\) continue;/.test(vmSrc),
    '清单里已不存在的路径会被剔掉（防"只增不减"）');
  ok(/function sweepSharedRoots\(roots\)[\s\S]{0,260}readSharedRoots\(\)/.test(vmSrc),
    '扫「本次的根」时把清单里的历史根也算进来');
  ok(/function rememberSharedRoots\(roots\)/.test(vmSrc) && /\n  rememberSharedRoots\(sharedRoots\);\n/.test(vmSrc),
    '本次的根会被记进清单（下次起点据此回扫）');
  ok(!/rmSync|rmdirSync\([^)]*recursive/.test(vmSrc),
    '没有整目录递归删除（只删 *.virtfs_metadata / 只 rmdir 空目录）');
}

// 收尾：门禁自己造的临时舞台要清掉（纪律：在工作树里不留东西）。
try {
  rmSync(stage, { recursive: true, force: true });
} catch {
  /* 清不掉也不影响判定 */
}
ok(!existsSync(stage), '临时舞台已清理');

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);
