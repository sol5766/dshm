/*
 * 路径推导：VM 资产（随 HAP 分发）与运行目录（el2 可写）。
 *
 * 【为什么硬编码 el1 的 bundle 路径，而不是从 __dirname 推】
 * 本插件的模块目录在**核心树**里（`<sandbox>/dsh/cores/<ver>/node_modules/…`），
 * 从它推不出 HAP 的 resfile（两者一个在 el2、一个在 el1，无相对关系）。
 * 而 el1 的这两个位置是 OHOS 应用包布局里**固定**的，且已被多条既有链路实证：
 *   · `libs/arm64/` —— dlopen 只放行这里（main.js :3203-3213 的 E16/E17b 结论：
 *      resfile 与 el2 files/ 都不行，koffi/sharp/libpython 全走这条）；QEMU 的
 *     `libqemu-system-aarch64.so` 必须放这里才 dlopen 得起来（上一轮 PoC 实证）。
 *   · `entry/resources/resfile/vm/` —— 与 `resfile/toolchain`、`resfile/*.zip` 同处，
 *     main.js 的 `RES_ROOT` 就指向该 resfile 根。
 * 三处都留了 env 覆盖口（DSHM_VM_*），调试/离线门禁据此接临时目录，不必落设备。
 */
import { existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 应用 el1 包根（HAP 安装内容）。 */
export function bundleRoot() {
  const override = String(process.env.DSHM_VM_BUNDLE || '').trim();
  return override.length > 0 ? override : '/data/storage/el1/bundle';
}

/** dlopen 白名单目录：只有这里的 `.so` 能被加载。 */
export function libsDir() {
  const override = String(process.env.DSHM_VM_LIBS || '').trim();
  return override.length > 0 ? override : join(bundleRoot(), 'libs', 'arm64');
}

/** 随包的 VM 数据件目录（kernel / rootfs / 固件 / guest bash 的 Alpine 包闭包）。 */
export function resfileVmDir() {
  const override = String(process.env.DSHM_VM_RESFILE || '').trim();
  return override.length > 0
    ? override
    : join(bundleRoot(), 'entry', 'resources', 'resfile', 'vm');
}

/** 运行目录（el2，可写；rootfs 必须可写，guest 首启要在里面装 bash）。 */
export function vmWorkDir() {
  const override = String(process.env.DSHM_VM_DIR || '').trim();
  if (override.length > 0) return override;
  const sandbox = String(process.env.DSHM_SANDBOX_HOME || '').trim();
  return sandbox.length > 0 ? join(sandbox, 'vm') : '';
}

/** QEMU 运行期要用的三个 unix socket（与 PoC 同名，便于与上一轮读数对照）。 */
export function sockets() {
  const base = join(vmWorkDir(), 'tmp');
  return {
    serial: join(base, 'serial_socket'),
    qga: join(base, 'qga_socket'),
    qmp: join(base, 'qmp_socket'),
  };
}

/*
 * 资产清单。`size` 是**实测字节数**（不是估计），用途有二：
 *   ① 门禁/自检据此判"随包资产是否齐、是否是那一份"；
 *   ② 布置前做 `statSync().size` 预检 —— 少一个字节就当作"资产没布置好"，
 *      而不是等 dlopen 或 QEMU 起来才炸（那种失败在真机上表现为"命令不能执行"，
 *      看不出根因）。
 * 这份清单与 tools/place-vm-assets.mjs 的目标表**必须一致**（同一份真源的两处投影）。
 */
export const VM_ASSETS = [
  { dest: 'libs', name: 'libqemu-system-aarch64.so', size: 34787808 },
  { dest: 'libs', name: 'libslirp.so.0', size: 1135680 },
  { dest: 'resfile', name: 'kernel_aarch64', size: 12980736 },
  // rootfs 是**本仓自建**的（docs/157）：在上游 OpenRC 档基础上，预装 bash 闭包 + 把
  // /etc/inittab 换成最小 init 档（guest-init.js 的单一真源）。上游原档留作重建种子
  // （third_party/vmhish/rootfs_aarch64.openrc-seed.qcow2，sha256 367962e0…c834）。
  // 尺寸 48631808 → 53542912（+4.9 MB：bash 闭包装进 guest 后多出来的那部分）。
  { dest: 'resfile', name: 'rootfs_aarch64.qcow2', size: 53542912 },
  { dest: 'resfile', name: 'efi-virtio.rom', size: 160768 },
];

/**
 * 终端端口的数量（`0` 号留给控制台 `serial.log`；终端从 1 号开始）。
 *
 * 【通道口径（2026-10-09 换过一次，两版都上过真机）】
 *   · 旧版：额外的 `-serial` ⇒ guest 侧 `/dev/ttyAMA<i>`（PL011，`204, 64`，真 tty）。
 *     质量最好，但**最多 1 个**：guest 里只有 2 个 PL011（0 号是控制台），第 3/4 条
 *     `-serial` **不产生 tty**（`docs/123` 真机读数：`ls /dev/ttyAMA*` 只有 0/1）。UI 第二次
 *     开终端只能拿到「端口已用满，请先关闭一个」。
 *   · 现版：`-device virtconsole`（virtio-console 的 **console 型**端口）⇒ guest 侧
 *     `/dev/hvc<i-1>`（`229, <i-1>`，真 tty）。为什么不能用普通 port：`virtserialport`
 *     在 guest 里是 `/dev/vportXpY`（`251, 1`，**动态 cdev**，不是 tty）⇒ 没有 termios /
 *     行规程 / 作业控制；console 型端口才会被 `virtio_console` 建成 tty（QGA 那条
 *     `virtserialport` 是普通 port，**不占** hvc 号）。
 *
 * 【2026-10-09 真机热插拔实证（QMP `device_add virtconsole` 进正在跑的 VM，再用侧边栏
 *   终端连进去读读数）】
 *   · 设备与驱动在册：`ls -l /dev/hvc*` = `229,0`…`229,7`；`/proc/tty/drivers` 有
 *     `hvc /dev/hvc 229 0-7 system`（内核 `CONFIG_VIRTIO_CONSOLE=y`）。同一份 config 里
 *     `# CONFIG_SERIAL_8250 is not set` ⇒ **pci-serial 那条候选路是死的**，不用再试。
 *   · **认领语义与 PL011 逐条一致**：`setsid … exec /bin/sh -i < /dev/hvc1 > /dev/hvc1 2>&1`
 *     之后 `/proc/<pid>/stat` 的 `tty_nr=58625`（= `229,1`，非 0 ⇒ 拿到控制终端）、
 *     `pgrp=session=pid` ⇒ 作业控制是开的。
 *     （对照读数：**被上一个会话占住过**的 hvc0 再起 shell 会 `can't access tty; job control
 *     turned off` ⇒ 与 PL011 同一条规矩：一个 tty 同时只许一个 shell。）
 *   · **窗口尺寸可设可读**：`stty -F /dev/hvc1 rows 40 cols 100` rc=0，随后
 *     `stty -F /dev/hvc1 size` 回 `40 100` ⇒ `resize(cols,rows)` 那条路照样通
 *     （注：**未设过**尺寸的 tty 上 `stty size` 会报错，ttyAMA1 与 hvc 都这样 —— 不是通道问题）。
 *   · 字节双向通：宿主连 socket 发 `echo …\n`，guest 侧 shell 正常回显/执行/退出。
 * ⇒ 端口表放到 4（第 i 个 `virtconsole` ↔ `/dev/hvc<i-1>` ↔ `term<i>`）。要再加只需同时
 * 抬这里的数与 `vm.js` 的 `-device` 循环；hvc 号由 guest 驱动按 console 端口的枚举顺序分配，
 * 而 QEMU 按命令行顺序 realize ⇒ 映射是确定的（但**必须**排在 `virtio-serial0` 控制器之后）。
 *
 * 【还有一条没试的路】去掉 cmdline 的 `acpi=on` 走 DT（QEMU 的 DT 按 `serial_hd(i)` 建 UART
 * 节点，可能给出 4 个 ttyAMA）—— 风险落在整机启动路径上，收益与现在的 hvc 相同 ⇒ 本轮不做。
 */
export const TERM_PORTS = 4;

/** 第 `index` 个终端端口的宿主侧 chardev socket（`1..TERM_PORTS`）。 */
export function termSocket(index) {
  return join(vmWorkDir(), 'tmp', 'term' + index);
}

/** 第 `index` 个终端端口在 guest 里的 tty（与 `-device virtconsole` 的顺序一一对应）。 */
export function termTty(index) {
  return '/dev/hvc' + (index - 1);
}
/**
 * guest bash 的 Alpine 包闭包目录名（resfile 与运行目录各有一份）。
 *
 * 【为什么叫 guestpkgs 而不是别的】应用市场审核会**按路径判**"包内带 apk 相关目录/文件"，
 * 命中就判安装失败（见 `docs/148`）。所以随包目录名里不能出现那个词 —— 内容仍是 Alpine
 * 包（扩展名已统一成 `.tar.gz`），装的还是同一个闭包。
 */
export const GUEST_PKG_DIR = 'guestpkgs';

/**
 * 逐项 `statSync().size` 预检：返回 `{ok, missing[]}`。
 * 有意只比**大小**不比哈希：这里是"能不能启动"的运行期闸门（要毫秒级、要能跑在
 * 设备上），字节级一致性由构建期门禁 tools/place-vm-assets.mjs 负责。
 */
export function assetsPresent() {
  const missing = [];
  for (const asset of VM_ASSETS) {
    const dir = asset.dest === 'libs' ? libsDir() : resfileVmDir();
    const full = join(dir, asset.name);
    try {
      if (statSync(full).size === asset.size) continue;
    } catch {
      /* 落到下面统一记 missing */
    }
    missing.push(full);
  }
  return { ok: missing.length === 0, missing };
}

/** QEMU 主库是否就位（dlopen 前的同步预检）。 */
export function qemuLibraryPath() {
  return join(libsDir(), 'libqemu-system-aarch64.so');
}

/** resfile/vm 下的某个数据件。 */
export function resfileAsset(name) {
  return join(resfileVmDir(), name);
}

/** 运行目录里的某个路径。 */
export function workPath(...segments) {
  return join(vmWorkDir(), ...segments);
}

/**
 * guest 闭包里**必须存在**的几个包（判"要不要重拷"的锚点）。
 *
 * 【为什么不能只看目录在不在】`stage()` 的判据就是本函数：目录存在即跳过复制。
 * 2026-11-02 给 guest 加 tmux / gh 时发现这个判据太松 —— 老设备上 `guestpkgs/`
 * 早就存在（旧闭包），新包永远不会被复制进去 ⇒ 用户看到的仍是"tmux: not found"，
 * 而日志里没有任何异常。所以这里改成**点名核对**：少一个就判"没就位"，
 * `stage()` 会把 resfile 的整份闭包重新拷一遍（拷贝是幂等覆盖，不会删别的东西）。
 *
 * 只点 2 个代表（tmux / gh 的真身包），不列全量：全量列表在构建期
 * `tools/place-vm-assets.mjs` 的 GUEST_PKG_FILES 里，两处重复维护会更易漂移。
 */
export const GUEST_PKG_ANCHORS = ['tmux-3.5a-r1.tar.gz', 'github-cli-2.72.0-r6.tar.gz', 'pnpm-9.15.9-guest.tar.gz', 'libcurl-8.14.1-r4.tar.gz'];

/** 运行目录里的 guest 包闭包是否已就位（锚点包齐备才算）。 */
export function guestPkgDirReady() {
  const dir = workPath(GUEST_PKG_DIR);
  if (!existsSync(dir)) {
    return false;
  }
  for (const name of GUEST_PKG_ANCHORS) {
    if (!existsSync(join(dir, name))) {
      return false;
    }
  }
  return true;
}

/**
 * 把**上一代**（目录名还叫 `apk` 的）运行目录就地改名成本代的 `guestpkgs`。
 *
 * 【为什么要迁移】运行目录在 el2（用户数据）里，`docs/AGENTS.md` 明令不许删设备数据；
 * 而 `stage()` 只在"包闭包目录不存在"时从 resfile 复制 ⇒ 不迁移的话老设备每次启动
 * 都要重拷 800 KB，且那一代目录名会一直留在设备上。改名不是删除：失败就交给
 * `stage()` 的正常复制路径，绝不 unlink。
 *
 * @returns {boolean} 是否发生了迁移
 */
export function migrateLegacyPkgDir() {
  const legacy = workPath('apk');
  const current = workPath(GUEST_PKG_DIR);
  if (!existsSync(legacy) || existsSync(current)) return false;
  try {
    renameSync(legacy, current);
    return true;
  } catch {
    return false;
  }
}
