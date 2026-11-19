/*
 * guest 侧「最小 init」—— OpenRC 的最小替代（docs/157）。
 *
 * 【为什么需要它】真机冷启动分解（2026-10-14，手机 `62T0225B18039433`）：
 *   · QEMU 拉起 → 内核 `Run /init`：3.99 s
 *   · OpenRC sysinit/boot：**76 s**（`[79.83]` 才看到 EXT4 re-mount）
 *   · networking(udhcpc) + QEMU Guest Agent：再 **25 s**
 *   ⇒ QGA 就绪 `+104876 ms`。根因不是某个服务慢，而是 TCI（解释执行）档里
 *   **每个外部命令的 fork+exec 都值钱**，OpenRC 却要按依赖顺序拉起几十个进程
 *   （mdev 全量扫 `/sys` 的 modalias、hwdrivers 在 `/lib/modules` 为空时纯空跑、
 *   根 fs 检查重挂、udhcpc 重试 …）。这条链路真正需要的只有下面 5 步。
 *   同机 JIT 对照：OpenRC 12.878 s → 最小 init **0.89 s**（QGA 就绪，含内核）。
 *
 * 【必需面】`/dev/hvc*`·`/dev/vport*`、`/dev/virtio-ports/<name>` 符号链接
 * （QGA 的 `-p` 地址就是它）、9p 共享、可写的 `/run`·`/tmp`·`/dev/shm`。
 * 串口日志由内核 console 直接输出，不经这里。网络按 QEMU user-net 的固定地址
 * 静态配置（10.0.2.0/24）：比 udhcpc 快一个数量级，也不取决于任何外部命令的成败。
 *
 * 【写脚本的纪律】这一段跑在冷启动路径上：
 *   · 只用 shell **内建**（read/echo/test/printf/if/for/case/param-expansion）；
 *   · 非内建命令（mount/mkdir/mknod/ln/ifconfig/route/hostname）一条都要值当；
 *   · 每条 mount 都带 `|| true`：已经挂上的就是 EBUSY，不能让它把后一条挡住
 *     （这里刻意**不用** `mountpoint -q X ||` 那种写法 —— 它要多一次 fork+exec，
 *     而这条路径上每个进程都要按 TCI 的价钱付账）。
 *
 * 【这份文本是单一真源】两个消费者都从这里取：
 *   ① 随包 rootfs（离线构建时写进 `/etc/inittab` + `/usr/local/sbin/dshm-init`）；
 *   ② 设备侧的**一次性迁移**（`guestInitInstallScript()` 生成幂等脚本，由
 *      `vm.js` 在 QGA 就绪后发一次 —— 老设备 el2 里那份 rootfs 副本不重拷，
 *      既不碰用户数据，也能在**下一次冷启动**吃到最小 init）。
 * 改这里的任何一个字节都要同时改 `GUEST_INIT_VERSION`，否则老镜像上的迁移
 * 会判定"已是最新"而跳过去。
 */

export const GUEST_INIT_VERSION = 'dshm-init.v1';

/** `/usr/local/sbin/dshm-init`（0755）。 */
export const GUEST_INIT_SCRIPT = [
  '#!/bin/sh',
  '# ' + GUEST_INIT_VERSION,
  '# DSHM guest init —— OpenRC 的最小替代（随包 rootfs 里那份与这里逐字节一致）。',
  'PATH=/sbin:/usr/sbin:/bin:/usr/bin',
  'export PATH',
  'echo "dshm-init: begin"',
  '',
  '# ① 伪文件系统（/dev 一般已由内核按 CONFIG_DEVTMPFS_MOUNT 挂好 ⇒ EBUSY，忽略）',
  'mount -t proc proc /proc 2>/dev/null || true',
  'mount -t sysfs sysfs /sys 2>/dev/null || true',
  'mount -t devtmpfs devtmpfs /dev 2>/dev/null || true',
  'mkdir -p /run /tmp /dev/shm /dev/pts /dev/virtio-ports /mnt/share',
  'mount -t tmpfs -o mode=0755,size=64M tmpfs /run 2>/dev/null || true',
  'mount -t tmpfs -o mode=1777,size=128M tmpfs /tmp 2>/dev/null || true',
  'mount -t tmpfs -o mode=1777,size=64M tmpfs /dev/shm 2>/dev/null || true',
  'mount -t devpts -o gid=5,mode=620 devpts /dev/pts 2>/dev/null || true',
  '',
  '# ② 设备节点兜底：devtmpfs 通常已经建好 hvc*/vport*，缺了按 /sys 里的 dev 号补',
  'for d in /sys/class/tty/hvc* /sys/class/virtio-ports/*; do',
  '  [ -f "$d/dev" ] || continue',
  '  n=${d##*/}',
  '  [ -e "/dev/$n" ] && continue',
  '  s=$(cat "$d/dev")',
  '  mknod "/dev/$n" c "${s%%:*}" "${s#*:}"',
  'done',
  '',
  '# ③ QGA 的端口名（devtmpfs 只给 /dev/vportXpY，名字在 sysfs 的 name 里）',
  'for d in /sys/class/virtio-ports/*; do',
  '  [ -f "$d/name" ] || continue',
  '  n=$(cat "$d/name")',
  '  [ -n "$n" ] || continue',
  '  ln -sfn "../${d##*/}" "/dev/virtio-ports/$n"',
  'done',
  '[ -e /dev/virtio-ports/org.qemu.guest_agent.0 ] || echo "dshm-init: 警告 QGA 端口名缺失"',
  '',
  '# ④ 9p 共享（宿主侧 = 应用沙箱根；provision 会幂等补挂，这里先挂上省一跳）',
  'mount -t 9p -o trans=virtio,version=9p2000.L hostshare /mnt/share 2>/dev/null || true',
  '',
  '# ⑤ 主机名 + QEMU user-net 固定地址',
  'hostname -F /etc/hostname 2>/dev/null || true',
  'ifconfig lo 127.0.0.1 netmask 255.0.0.0 2>/dev/null || true',
  'ifconfig eth0 10.0.2.15 netmask 255.255.255.0 2>/dev/null || true',
  'route add default gw 10.0.2.2 2>/dev/null || true',
  "printf 'nameserver 10.0.2.3\\n' > /etc/resolv.conf",
  'echo "dshm-init: done"',
  '',
].join('\n');

/**
 * `/etc/inittab`：**只有两条**。
 *
 * 【为什么不留 getty】`ttyAMA0` 是只写的 file chardev（宿主侧 `serial.log`），
 * getty 读不到东西会被 `respawn` 反复拉起，把日志越滚越大；而这条串口是留给
 * 内核日志取证用的。终端走的是 `virtconsole`（`/dev/hvc*`），不需要 getty。
 *
 * 【为什么 `::once:` 而不是 `::respawn:`】qemu-ga 自己 `-d` 进后台；`sysinit`
 * 跑完才轮到 `once` ⇒ 端口名已建好，不存在"agent 抢在符号链接之前启动"的竞态。
 */
export const GUEST_INITTAB = [
  '# /etc/inittab —— DSHM 最小档：OpenRC 已由 dshm-init 取代（' + GUEST_INIT_VERSION + '）。',
  '#',
  '# 【为什么只留两条】sysinit 那条做挂载/设备/QGA 端口名，once 那条起 qemu-ga。',
  '# 不再放 getty：ttyAMA0 是只写的 file chardev，getty 读不到东西会被 respawn 反复',
  '# 拉起，把 serial.log 越滚越大（而且这条串口是留给内核日志取证用的）。',
  '::sysinit:/usr/local/sbin/dshm-init',
  '::once:/usr/bin/qemu-ga -m virtio-serial -p /dev/virtio-ports/org.qemu.guest_agent.0 -l /var/log/qemu-ga.log -d',
  '',
].join('\n');

/** guest 里的落点（宿主侧生成迁移脚本、门禁断言都引用这两个常量）。 */
export const GUEST_INIT_PATH = '/usr/local/sbin/dshm-init';
export const GUEST_INITTAB_PATH = '/etc/inittab';

/** 迁移判据的两行锚（`--` 见 `guestInitInstallScript()` 的幂等检查）。 */
export const GUEST_INIT_MARKER = '# ' + GUEST_INIT_VERSION;
export const GUEST_INIT_SYSINIT_LINE = '::sysinit:' + GUEST_INIT_PATH;

/** 迁移脚本里 heredoc 的定界符（内容里不许出现同名整行 —— 门禁钉住这条）。 */
const SCRIPT_EOF = 'DSHM_GUEST_INIT_SCRIPT_EOF';
const INITTAB_EOF = 'DSHM_GUEST_INITTAB_EOF';

/**
 * 生成"把最小 init 写进 guest"的幂等 shell 片段（由 `vm.js` 在 QGA 就绪后发一次）。
 *
 * 【为什么是迁移而不是重拷 rootfs】设备 el2 里那份 `rootfs.qcow2` 是**可写副本**，
 * 里面可能有用户自己在终端里造的文件（`cd /` 之后写的）。重拷资产能立刻变快，
 * 代价是静默丢数据 ⇒ 不干。这里只在 rootfs **内部**把 init 那份文本换掉：
 * 幂等、可重复发、失败不影响本次启动（本次仍是老 init 起的 VM，只是慢）。
 *
 * 【判据】脚本首行标记 + `/etc/inittab` 的 sysinit 行**同时**命中才算"已是最新"，
 * 命中就早退（真机上这条路径 <100 ms）。
 *
 * 【为什么必须 sync】宿主侧停机走 QMP `quit`（硬断电语义，见 `vm.js` `quit()`），
 * guest 里刚写的页缓存**不会**自己落盘：实测"写完立刻 quit"再冷启动，`/etc/inittab`
 * 仍是旧的 24 行 OpenRC 档（就绪 12.3 s），等于这次迁移白做。所以两个文件写完
 * 必须显式 `sync` —— 这是本条链路上唯一一次"故意慢一点"的代价。
 */
export function guestInitInstallScript() {
  return [
    'set -u',
    `if [ -x ${GUEST_INIT_PATH} ] && grep -qx '${GUEST_INIT_MARKER}' ${GUEST_INIT_PATH}`
      + ` && grep -qx '${GUEST_INIT_SYSINIT_LINE}' ${GUEST_INITTAB_PATH} 2>/dev/null; then`,
    '  echo DSHM_INIT_CURRENT; exit 0;',
    'fi',
    'mkdir -p /usr/local/sbin',
    `cat > ${GUEST_INIT_PATH} <<'${SCRIPT_EOF}'`,
    GUEST_INIT_SCRIPT.replace(/\n$/, ''),
    SCRIPT_EOF,
    `chmod 0755 ${GUEST_INIT_PATH}`,
    `cat > ${GUEST_INITTAB_PATH} <<'${INITTAB_EOF}'`,
    GUEST_INITTAB.replace(/\n$/, ''),
    INITTAB_EOF,
    '# 硬断电语义：不 sync 的话这两次写入留在页缓存里，下次冷启动仍是旧 init',
    '/bin/busybox sync 2>/dev/null || sync 2>/dev/null || true',
    `if [ -x ${GUEST_INIT_PATH} ] && grep -qx '${GUEST_INIT_MARKER}' ${GUEST_INIT_PATH}`
      + ` && grep -qx '${GUEST_INIT_SYSINIT_LINE}' ${GUEST_INITTAB_PATH}; then`,
    '  echo DSHM_INIT_INSTALLED; exit 0;',
    'fi',
    'echo DSHM_INIT_VERIFY_FAILED; exit 1',
  ].join('\n');
}
